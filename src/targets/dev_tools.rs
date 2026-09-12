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
            f.push(
                sized_finding(
                    "Homebrew cache",
                    brew_cleanup_size(),
                    &["brew", "cleanup", "-s"],
                )
                .with_note("old versions and downloads"),
            );
            let orphans = brew_orphans();
            f.push(
                sized_finding(
                    "Homebrew orphans",
                    orphans.iter().map(|p| fsutil::dir_size(p)).sum(),
                    &["brew", "autoremove"],
                )
                .with_note(format!("{} unneeded formulae", orphans.len())),
            );
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
            f.push(sized_finding(
                "uv cache",
                cache_size(&["uv", "cache", "dir"]),
                &["uv", "cache", "clean"],
            ));
        }

        if exec::command_exists("composer") {
            f.push(sized_finding(
                "composer cache",
                cache_size(&["composer", "config", "--global", "cache-dir"]),
                &["composer", "clear-cache"],
            ));
        }

        if exec::command_exists("conda") {
            let pkgs = store_path(&["conda", "info", "--base"]).map(|base| base.join("pkgs"));
            f.push(sized_finding(
                "conda packages",
                pkgs.as_deref().map(fsutil::dir_size).unwrap_or(0),
                &["conda", "clean", "-a", "-y"],
            ));
        }

        // The Command Line Tools ship `xcrun` without `simctl`; only a full
        // Xcode has simulators to delete.
        if let Some(devices) = unavailable_simulators(&cfg.home) {
            f.push(sized_finding(
                "unavailable simulators",
                devices.iter().map(|p| fsutil::dir_size(p)).sum(),
                &["xcrun", "simctl", "delete", "unavailable"],
            ));
        }

        if exec::command_exists("docker") {
            if let Some(usage) = docker_usage() {
                let label = if cfg.aggressive {
                    "Docker (all unused images & networks)"
                } else {
                    "Docker (unused images & networks)"
                };
                f.push(
                    Finding::dir(
                        PathBuf::from(label),
                        usage.reclaimable(cfg.aggressive, cfg.prune_volumes),
                        CleanAction::Command(docker_prune_cmd(cfg.aggressive, cfg.prune_volumes)),
                    )
                    .with_note("inside the VM disk — see vm-images for the disk itself"),
                );
            }
        }

        // A cleanup command with nothing to clean is noise, and one whose tool
        // can't reach its daemon would only fail.
        f.retain(|x| !matches!(x.action, CleanAction::Command(_)) || x.size > 0);

        f.extend(catalog::dev_caches(&cfg.home));

        Ok(report)
    }
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

/// What `brew cleanup -s` would free, from its own dry run.
fn brew_cleanup_size() -> u64 {
    exec::capture(&words(&["brew", "cleanup", "-s", "--dry-run"]))
        .ok()
        .and_then(|out| parse_brew_cleanup(&out))
        .unwrap_or(0)
}

/// `==> This operation would free approximately 1.3GB of disk space.`
fn parse_brew_cleanup(out: &str) -> Option<u64> {
    let line = out.lines().rev().find(|l| l.contains("approximately"))?;
    let size = line
        .split("approximately")
        .nth(1)?
        .split_whitespace()
        .next()?;
    parse_size(size)
}

/// Installed kegs `brew autoremove` would take away: the formulae nothing
/// depends on any more.
fn brew_orphans() -> Vec<PathBuf> {
    let Some(cellar) = store_path(&["brew", "--cellar"]) else {
        return Vec::new();
    };
    exec::capture(&words(&["brew", "autoremove", "--dry-run"]))
        .map(|out| parse_brew_orphans(&out))
        .unwrap_or_default()
        .into_iter()
        .map(|name| cellar.join(name))
        .filter(|keg| keg.is_dir())
        .collect()
}

/// The names listed under `==> Would autoremove N unneeded formulae:`, with
/// any tap prefix dropped to match the keg's folder in the Cellar.
fn parse_brew_orphans(out: &str) -> Vec<String> {
    out.lines()
        .skip_while(|l| !l.contains("Would autoremove"))
        .skip(1)
        .take_while(|l| !l.trim().is_empty() && !l.starts_with("==>"))
        .filter_map(|l| l.trim().rsplit('/').next().map(str::to_string))
        .collect()
}

/// Devices `simctl` lists as unavailable (their runtime is gone), as the
/// folders that hold their data. `None` without a full Xcode.
fn unavailable_simulators(home: &Path) -> Option<Vec<PathBuf>> {
    exec::capture(&words(&["xcrun", "--find", "simctl"]))
        .ok()
        .filter(|p| !p.trim().is_empty())?;
    let out = exec::capture(&words(&[
        "xcrun",
        "simctl",
        "list",
        "devices",
        "unavailable",
        "--json",
    ]))
    .ok()?;
    let devices = home.join("Library/Developer/CoreSimulator/Devices");
    Some(
        parse_simulator_ids(&out)
            .into_iter()
            .map(|udid| devices.join(udid))
            .filter(|dir| dir.is_dir())
            .collect(),
    )
}

fn parse_simulator_ids(json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    value["devices"]
        .as_object()
        .into_iter()
        .flat_map(|runtimes| runtimes.values())
        .filter_map(|list| list.as_array())
        .flatten()
        .filter_map(|device| device["udid"].as_str().map(str::to_string))
        .collect()
}

/// Reclaimable bytes per kind, as `docker system df` reports them.
#[derive(Debug, Default, PartialEq, Eq)]
struct DockerUsage {
    images: u64,
    containers: u64,
    volumes: u64,
    build_cache: u64,
}

impl DockerUsage {
    /// What `docker system prune` with these flags would remove. Without `-a`
    /// only dangling images go, and Docker doesn't report those apart, so
    /// images are left out: the figure is a floor, not a promise.
    fn reclaimable(&self, all_images: bool, volumes: bool) -> u64 {
        let mut bytes = self.containers + self.build_cache;
        if all_images {
            bytes += self.images;
        }
        if volumes {
            bytes += self.volumes;
        }
        bytes
    }
}

/// `None` when the daemon can't be reached — stopped, or its VM is — in which
/// case there's nothing a prune could do either.
fn docker_usage() -> Option<DockerUsage> {
    let out = exec::capture(&words(&[
        "docker",
        "system",
        "df",
        "--format",
        "{{.Type}}\t{{.Reclaimable}}",
    ]))
    .ok()?;
    parse_docker_usage(&out)
}

/// Lines of `Images\t1.2GB (45%)`.
fn parse_docker_usage(out: &str) -> Option<DockerUsage> {
    let mut usage = DockerUsage::default();
    let mut seen = false;
    for line in out.lines() {
        let Some((kind, reclaimable)) = line.split_once('\t') else {
            continue;
        };
        let bytes = reclaimable
            .split_whitespace()
            .next()
            .and_then(parse_size)
            .unwrap_or(0);
        match kind.trim() {
            "Images" => usage.images = bytes,
            "Containers" => usage.containers = bytes,
            "Local Volumes" => usage.volumes = bytes,
            "Build Cache" => usage.build_cache = bytes,
            _ => continue,
        }
        seen = true;
    }
    seen.then_some(usage)
}

/// Sizes as Homebrew and Docker print them: decimal units, `1.3GB`, `345kB`,
/// `0B`.
fn parse_size(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text.find(|c: char| c.is_ascii_alphabetic())?;
    let (number, unit) = text.split_at(split);
    let number: f64 = number.parse().ok()?;
    let scale = match unit.to_ascii_uppercase().as_str() {
        "B" => 1.0,
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => return None,
    };
    Some((number * scale) as u64)
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
    use super::*;

    #[test]
    fn parses_tool_sizes() {
        assert_eq!(parse_size("1.3GB"), Some(1_300_000_000));
        assert_eq!(parse_size("345kB"), Some(345_000));
        assert_eq!(parse_size("37MB"), Some(37_000_000));
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("lots"), None);
    }

    #[test]
    fn reads_what_brew_cleanup_would_free() {
        let out = "Removing: /opt/homebrew/Cellar/x265/4.1... (12 files, 9.8MB)\n\
                   ==> This operation would free approximately 1.3GB of disk space.\n";
        assert_eq!(parse_brew_cleanup(out), Some(1_300_000_000));
        assert_eq!(parse_brew_cleanup("Warning: Skipping uv\n"), None);
    }

    #[test]
    fn reads_brew_orphans() {
        let out = "==> Would autoremove 2 unneeded formulae:\n\
                   libyaml\n\
                   someone/tap/oniguruma\n";
        assert_eq!(parse_brew_orphans(out), ["libyaml", "oniguruma"]);
        assert!(parse_brew_orphans("").is_empty());
    }

    #[test]
    fn reads_unavailable_simulators() {
        let json = r#"{"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [
                {"udid": "A1", "name": "iPhone 14", "isAvailable": false}
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-17-0": []
        }}"#;
        assert_eq!(parse_simulator_ids(json), ["A1"]);
        assert!(parse_simulator_ids("not json").is_empty());
    }

    #[test]
    fn docker_reclaimable_follows_prune_flags() {
        let out = "Images\t4.5GB (80%)\nContainers\t120MB (100%)\n\
                   Local Volumes\t2GB (50%)\nBuild Cache\t1.1GB\n";
        let usage = parse_docker_usage(out).unwrap();
        assert_eq!(usage.reclaimable(false, false), 1_220_000_000);
        assert_eq!(usage.reclaimable(true, false), 5_720_000_000);
        assert_eq!(usage.reclaimable(true, true), 7_720_000_000);
        // An unreachable daemon prints nothing on stdout.
        assert_eq!(parse_docker_usage(""), None);
    }

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
