use std::path::PathBuf;

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
            f.push(command_finding("pnpm store", &["pnpm", "store", "prune"]));
        }

        if exec::command_exists("yarn") {
            f.push(command_finding("yarn cache", &["yarn", "cache", "clean"]));
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
            f.push(command_finding("bun cache", &["bun", "pm", "cache", "rm"]));
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

fn cache_size(query: &[&str]) -> u64 {
    exec::capture(&words(query))
        .ok()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| p.is_dir())
        .map(|p| fsutil::dir_size(&p))
        .unwrap_or(0)
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
