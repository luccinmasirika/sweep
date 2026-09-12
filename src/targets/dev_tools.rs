use std::path::{Path, PathBuf};

use anyhow::Result;

use super::Target;
use crate::catalog;
use crate::config::Config;
use crate::exec;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct DevTools;

impl Target for DevTools {
    fn name(&self) -> &'static str {
        "dev-tools"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.dev_tools
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        let f = &mut report.findings;

        if exec::command_exists("brew") {
            let mut finding = command_finding("Homebrew cache", &["brew", "cleanup", "-s"]);
            if let Some(note) = brew_reclaimable() {
                finding = finding.with_note(note);
            }
            f.push(finding);
            f.push(command_finding("Homebrew orphans", &["brew", "autoremove"]));
        }

        if exec::command_exists("npm") {
            let size = cache_size(&["npm", "config", "get", "cache"]);
            f.push(
                Finding::dir(
                    PathBuf::from("npm cache"),
                    size,
                    CleanAction::Command(words(&["npm", "cache", "clean", "--force"])),
                )
                .with_note("npm"),
            );
        }

        if exec::command_exists("pnpm") {
            let active = store_path(&["pnpm", "store", "path"]);
            let size = active.as_deref().map(fsutil::dir_size).unwrap_or(0);
            f.push(
                sized_finding("pnpm store", size, &["pnpm", "store", "prune"]).with_note("pnpm"),
            );
            // `pnpm store prune` only knows about the store the current pnpm
            // uses; a major upgrade leaves the previous `store/vN` behind,
            // whole, forever, and nothing ever looks at it again.
            f.extend(abandoned_stores(active.as_deref()));
        }

        if exec::command_exists("yarn") {
            f.push(
                sized_finding(
                    "yarn cache",
                    cache_size(&["yarn", "cache", "dir"]),
                    &["yarn", "cache", "clean"],
                )
                .with_note("yarn"),
            );
        }

        let cargo_cache = cfg.home.join(".cargo/registry/cache");
        if cargo_cache.is_dir() {
            f.push(
                Finding::dir(
                    cargo_cache.clone(),
                    fsutil::dir_size(&cargo_cache),
                    CleanAction::EmptyDir,
                )
                .with_note("cargo registry cache"),
            );
        }

        let pip_cache = cfg.home.join("Library/Caches/pip");
        if pip_cache.is_dir() {
            f.push(
                Finding::dir(
                    pip_cache.clone(),
                    fsutil::dir_size(&pip_cache),
                    CleanAction::EmptyDir,
                )
                .with_note("pip cache"),
            );
        }

        if cfg.aggressive && exec::command_exists("go") {
            let modcache = cfg.home.join("go/pkg/mod");
            let size = if modcache.is_dir() {
                fsutil::dir_size(&modcache)
            } else {
                0
            };
            f.push(
                Finding::dir(
                    PathBuf::from("go module cache"),
                    size,
                    CleanAction::Command(words(&["go", "clean", "-modcache"])),
                )
                .with_note("re-downloaded on next build"),
            );
        }

        if exec::command_exists("bun") {
            f.push(
                sized_finding(
                    "bun cache",
                    fsutil::dir_size(&cfg.home.join(".bun/install/cache")),
                    &["bun", "pm", "cache", "rm"],
                )
                .with_note("bun"),
            );
        }

        if exec::command_exists("deno") {
            f.push(
                sized_finding(
                    "deno cache",
                    fsutil::dir_size(&cfg.home.join("Library/Caches/deno")),
                    &["deno", "clean"],
                )
                .with_note("deno"),
            );
        }

        if exec::command_exists("uv") {
            f.push(command_finding("uv cache", &["uv", "cache", "clean"]));
        }

        if exec::command_exists("composer") {
            f.push(command_finding(
                "composer cache",
                &["composer", "clear-cache"],
            ));
        }

        if exec::command_exists("conda") {
            f.push(command_finding(
                "conda packages",
                &["conda", "clean", "-a", "-y"],
            ));
        }

        if exec::command_exists("xcrun") {
            f.push(command_finding(
                "unavailable simulators",
                &["xcrun", "simctl", "delete", "unavailable"],
            ));
        }

        if exec::command_exists("docker") {
            let label = if cfg.aggressive {
                "Docker (all unused images & networks)"
            } else {
                "Docker (unused images & networks)"
            };
            let mut finding = Finding::dir(
                PathBuf::from(label),
                0,
                CleanAction::Command(docker_prune_cmd(cfg.aggressive, cfg.prune_volumes)),
            );
            if let Some(note) = docker_reclaimable() {
                finding = finding.with_note(note);
            }
            f.push(finding);
        }

        f.extend(catalog::dev_caches(&cfg.home));

        Ok(report)
    }
}

fn command_finding(label: &str, cmd: &[&str]) -> Finding {
    Finding::dir(PathBuf::from(label), 0, CleanAction::Command(words(cmd)))
}

/// A cleanup run through a tool's own CLI, but weighed first. Without the size
/// these land at the bottom of a list sorted by bytes, so a 5 GB package store
/// reads as nothing to clean.
fn sized_finding(label: &str, size: u64, cmd: &[&str]) -> Finding {
    Finding::dir(PathBuf::from(label), size, CleanAction::Command(words(cmd)))
}

/// Size of the directory a tool reports as its cache (`pnpm store path`,
/// `yarn cache dir`, …). Missing tool or missing directory reads as zero.
fn cache_size(query: &[&str]) -> u64 {
    store_path(query)
        .as_deref()
        .map(fsutil::dir_size)
        .unwrap_or(0)
}

/// The directory a tool prints as its cache location, if it exists.
fn store_path(query: &[&str]) -> Option<PathBuf> {
    exec::capture(&words(query))
        .ok()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| p.is_dir())
}

/// Sibling store versions next to the one in use. Each is a complete package
/// store an older pnpm left behind, and no pnpm command will ever touch it.
fn abandoned_stores(active: Option<&Path>) -> Vec<Finding> {
    let Some(active) = active else {
        return Vec::new();
    };
    let Some(parent) = active.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == active || !path.is_dir() {
            continue;
        }
        let size = fsutil::dir_size(&path);
        if size == 0 {
            continue;
        }
        out.push(
            Finding::dir(path, size, CleanAction::RemovePath)
                .with_note("store left behind by an older pnpm"),
        );
    }
    out
}

fn brew_reclaimable() -> Option<String> {
    exec::capture(&words(&["brew", "cleanup", "--dry-run"]))
        .ok()
        .and_then(|out| {
            out.lines()
                .rev()
                .find(|l| l.contains("approximately"))
                .map(|l| l.trim().to_string())
        })
}

fn docker_reclaimable() -> Option<String> {
    exec::capture(&words(&["docker", "system", "df"]))
        .ok()
        .filter(|out| !out.trim().is_empty())
        .map(|_| "see `docker system df` for reclaimable size".to_string())
}

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

fn docker_prune_cmd(aggressive: bool, volumes: bool) -> Vec<String> {
    let mut cmd = words(&["docker", "system", "prune", "-f"]);
    if aggressive {
        cmd.push("-a".to_string());
    }
    if volumes {
        cmd.push("--volumes".to_string());
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::docker_prune_cmd;

    #[test]
    fn docker_cmd_scales_with_flags() {
        assert_eq!(
            docker_prune_cmd(false, false),
            ["docker", "system", "prune", "-f"]
        );
        assert_eq!(
            docker_prune_cmd(true, false),
            ["docker", "system", "prune", "-f", "-a"]
        );
        assert_eq!(
            docker_prune_cmd(true, true),
            ["docker", "system", "prune", "-f", "-a", "--volumes"]
        );
    }
}
