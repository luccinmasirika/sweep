use std::path::{Path, PathBuf};

use anyhow::Result;

use super::Target;
use crate::catalog;
use crate::config::Config;
use crate::exec;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Remeasure, Report};

pub struct DevTools;

impl Target for DevTools {
    fn name(&self) -> &'static str {
        "dev-tools"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.dev_tools
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        // Each probe asks a different tool, and some take seconds (`brew
        // cleanup --dry-run`, a Docker daemon waking up), so they all run at
        // once; findings keep this order.
        const PROBES: &[fn(&Config) -> Vec<Finding>] = &[
            homebrew, npm, pnpm, yarn, cargo, pip, go, bun, deno, uv, composer, conda, simulators,
            docker,
        ];
        let mut report = Report::new(self.name());
        let (probed, catalogued) = std::thread::scope(|s| {
            let probes: Vec<_> = PROBES
                .iter()
                .map(|probe| s.spawn(move || probe(cfg)))
                .collect();
            let catalogued = catalog::dev_caches(&cfg.home);
            let probed: Vec<Finding> = probes
                .into_iter()
                .flat_map(|h| h.join().expect("a probe panicked"))
                .collect();
            (probed, catalogued)
        });
        // A cleanup command with nothing to clean is noise, and one whose tool
        // can't reach its daemon would only fail.
        report.findings = probed
            .into_iter()
            .filter(|x| !matches!(x.action, CleanAction::Command(_)) || x.size > 0)
            .chain(catalogued)
            .collect();
        Ok(report)
    }
}

fn homebrew(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("brew") {
        return Vec::new();
    }
    let cache = probe_finding(
        "Homebrew cache",
        brew_cleanup_size,
        &["brew", "cleanup", "-s"],
    )
    .with_note("old versions and downloads");
    let orphans = brew_orphans();
    let count = orphans.len();
    // "Unneeded" means nothing depends on them, not that nobody uses them: a
    // formula installed as a dependency is often run directly.
    let orphans = dirs_finding("Homebrew orphans", orphans, &["brew", "autoremove"])
        .risky(true)
        .with_note(format!(
            "{count} formulae nothing depends on — check you don't use them"
        ));
    vec![cache, orphans]
}

fn npm(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("npm") {
        return Vec::new();
    }
    // `npm cache clean` clears the package cache, `_cacache`; the `_npx`
    // installs next to it stay, and `projects` reports those.
    vec![dirs_finding(
        "npm cache",
        store_path(&["npm", "config", "get", "cache"])
            .map(|cache| cache.join("_cacache"))
            .into_iter()
            .collect(),
        &["npm", "cache", "clean", "--force"],
    )
    .with_note("npm")]
}

fn pnpm(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("pnpm") {
        return Vec::new();
    }
    let active = store_path(&["pnpm", "store", "path"]);
    let mut found = vec![dirs_finding(
        "pnpm store",
        active.iter().cloned().collect(),
        &["pnpm", "store", "prune"],
    )
    .with_note("pnpm")];
    // `pnpm store prune` only knows about the store the current pnpm uses; a
    // major upgrade leaves the previous `store/vN` behind, whole, forever, and
    // nothing ever looks at it again.
    found.extend(abandoned_stores(active.as_deref()));
    found
}

fn yarn(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("yarn") {
        return Vec::new();
    }
    vec![dirs_finding(
        "yarn cache",
        store_path(&["yarn", "cache", "dir"]).into_iter().collect(),
        &["yarn", "cache", "clean"],
    )
    .with_note("yarn")]
}

fn cargo(cfg: &Config) -> Vec<Finding> {
    cache_dir(
        cfg.home.join(".cargo/registry/cache"),
        "cargo registry cache",
    )
}

fn pip(cfg: &Config) -> Vec<Finding> {
    cache_dir(cfg.home.join("Library/Caches/pip"), "pip cache")
}

fn cache_dir(dir: PathBuf, note: &str) -> Vec<Finding> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let size = fsutil::dir_size(&dir);
    vec![Finding::dir(dir, size, CleanAction::EmptyDir).with_note(note)]
}

fn go(cfg: &Config) -> Vec<Finding> {
    if !cfg.aggressive || !exec::command_exists("go") {
        return Vec::new();
    }
    vec![dirs_finding(
        "go module cache",
        vec![cfg.home.join("go/pkg/mod")],
        &["go", "clean", "-modcache"],
    )
    .with_note("re-downloaded on next build")]
}

fn bun(cfg: &Config) -> Vec<Finding> {
    if !exec::command_exists("bun") {
        return Vec::new();
    }
    vec![dirs_finding(
        "bun cache",
        vec![cfg.home.join(".bun/install/cache")],
        &["bun", "pm", "cache", "rm"],
    )
    .with_note("bun")]
}

fn deno(cfg: &Config) -> Vec<Finding> {
    if !exec::command_exists("deno") {
        return Vec::new();
    }
    vec![dirs_finding(
        "deno cache",
        vec![cfg.home.join("Library/Caches/deno")],
        &["deno", "clean"],
    )
    .with_note("deno")]
}

fn uv(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("uv") {
        return Vec::new();
    }
    vec![dirs_finding(
        "uv cache",
        store_path(&["uv", "cache", "dir"]).into_iter().collect(),
        &["uv", "cache", "clean"],
    )]
}

fn composer(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("composer") {
        return Vec::new();
    }
    vec![dirs_finding(
        "composer cache",
        store_path(&["composer", "config", "--global", "cache-dir"])
            .into_iter()
            .collect(),
        &["composer", "clear-cache"],
    )]
}

fn conda(_: &Config) -> Vec<Finding> {
    if !exec::command_exists("conda") {
        return Vec::new();
    }
    let pkgs = store_path(&["conda", "info", "--base"]).map(|base| base.join("pkgs"));
    // Environments created with hard links or softlinks point into `pkgs`;
    // `clean -a` can leave them broken.
    vec![dirs_finding(
        "conda packages",
        pkgs.into_iter().collect(),
        &["conda", "clean", "-a", "-y"],
    )
    .risky(true)
    .with_note("can break environments linked to the package cache")]
}

fn simulators(cfg: &Config) -> Vec<Finding> {
    // The Command Line Tools ship `xcrun` without `simctl`; only a full Xcode
    // has simulators to delete.
    let Some(devices) = unavailable_simulators(&cfg.home) else {
        return Vec::new();
    };
    vec![dirs_finding(
        "unavailable simulators",
        devices,
        &["xcrun", "simctl", "delete", "unavailable"],
    )
    .risky(true)
    .with_note("their apps and data go with them")]
}

fn docker(cfg: &Config) -> Vec<Finding> {
    if !exec::command_exists("docker") {
        return Vec::new();
    }
    docker_usage()
        .map(|usage| docker_findings(&usage, cfg.aggressive, cfg.prune_volumes))
        .unwrap_or_default()
}

/// A cleanup run through a tool's own CLI, weighed by the folders it clears —
/// before, so it sorts where it belongs, and again after, so the result is
/// what really went. Missing folders weigh nothing.
fn dirs_finding(label: &str, dirs: Vec<PathBuf>, cmd: &[&str]) -> Finding {
    let size = dirs.iter().map(|d| fsutil::path_size(d)).sum();
    Finding::dir(PathBuf::from(label), size, CleanAction::Command(words(cmd)))
        .remeasure(Remeasure::Dirs(dirs))
}

/// The same, for a tool that can only report its own reclaimable size.
fn probe_finding(label: &str, probe: fn() -> u64, cmd: &[&str]) -> Finding {
    Finding::dir(
        PathBuf::from(label),
        probe(),
        CleanAction::Command(words(cmd)),
    )
    .remeasure(Remeasure::Probe(probe))
}

/// Docker's reclaimable space, one prune per kind so each can be judged on its
/// own. The build cache is pure cache. A stopped container still holds
/// whatever it wrote outside a volume — a database, a half-configured dev box
/// — so it takes a tick. Unused images come with `--aggressive`, volumes with
/// `--volumes`, and a volume is data, so even then it takes a tick.
fn docker_findings(usage: &DockerUsage, aggressive: bool, volumes: bool) -> Vec<Finding> {
    let note = "inside the VM disk — see vm-images for the disk itself";
    let mut out = vec![
        Finding::dir(
            PathBuf::from("Docker build cache"),
            usage.build_cache,
            CleanAction::Command(words(&["docker", "builder", "prune", "-f"])),
        )
        .remeasure(Remeasure::Probe(|| {
            docker_usage().map_or(0, |u| u.build_cache)
        }))
        .with_note(note),
        Finding::dir(
            PathBuf::from("Docker stopped containers"),
            usage.containers,
            CleanAction::Command(words(&["docker", "container", "prune", "-f"])),
        )
        .risky(true)
        .remeasure(Remeasure::Probe(|| {
            docker_usage().map_or(0, |u| u.containers)
        }))
        .with_note("anything they wrote outside a volume goes with them"),
    ];
    if aggressive {
        out.push(
            Finding::dir(
                PathBuf::from("Docker unused images"),
                usage.images,
                CleanAction::Command(words(&["docker", "image", "prune", "-a", "-f"])),
            )
            .remeasure(Remeasure::Probe(|| docker_usage().map_or(0, |u| u.images)))
            .with_note("pulled again when next needed"),
        );
    }
    if volumes {
        out.push(
            Finding::dir(
                PathBuf::from("Docker unused volumes"),
                usage.volumes,
                CleanAction::Command(words(&["docker", "volume", "prune", "-f"])),
            )
            .risky(true)
            .remeasure(Remeasure::Probe(|| docker_usage().map_or(0, |u| u.volumes)))
            .with_note("volume data can't be recovered"),
        );
    }
    out
}

/// The directory a tool prints as its cache location, if it exists.
fn store_path(query: &[&str]) -> Option<PathBuf> {
    exec::capture(&words(query))
        .ok()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| p.is_dir())
}

/// Older store versions next to the one in use. Each is a complete package
/// store an older pnpm left behind, and no pnpm command will ever touch it.
/// Only `vN` folders below the active version count — a newer one belongs to a
/// newer pnpm installed elsewhere — and each takes a tick, since a project
/// pinned to that older pnpm through corepack may still use it.
fn abandoned_stores(active: Option<&Path>) -> Vec<Finding> {
    let Some(active) = active else {
        return Vec::new();
    };
    let (Some(parent), Some(current)) = (active.parent(), store_version(active)) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !store_version(&path).is_some_and(|v| v < current) || !path.is_dir() {
            continue;
        }
        let size = fsutil::dir_size(&path);
        if size == 0 {
            continue;
        }
        out.push(
            Finding::dir(path, size, CleanAction::RemovePath)
                .risky(true)
                .with_note("store left behind by an older pnpm"),
        );
    }
    out
}

/// `3` for a store folder named `v3`.
fn store_version(path: &Path) -> Option<u32> {
    path.file_name()?.to_str()?.strip_prefix('v')?.parse().ok()
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
    fn reads_docker_usage() {
        let out = "Images\t4.5GB (80%)\nContainers\t120MB (100%)\n\
                   Local Volumes\t2GB (50%)\nBuild Cache\t1.1GB\n";
        let usage = parse_docker_usage(out).unwrap();
        assert_eq!(
            usage,
            DockerUsage {
                images: 4_500_000_000,
                containers: 120_000_000,
                volumes: 2_000_000_000,
                build_cache: 1_100_000_000,
            }
        );
        // An unreachable daemon prints nothing on stdout.
        assert_eq!(parse_docker_usage(""), None);
    }

    #[test]
    fn only_the_build_cache_goes_without_asking() {
        let usage = DockerUsage {
            images: 4,
            containers: 3,
            volumes: 2,
            build_cache: 1,
        };
        let plain = docker_findings(&usage, false, false);
        let auto: Vec<_> = plain.iter().filter(|f| f.auto()).collect();
        assert_eq!(auto.len(), 1);
        assert_eq!(auto[0].size, 1);
        assert!(
            plain.iter().any(|f| f.risky && f.size == 3),
            "stopped containers need a tick"
        );

        let all = docker_findings(&usage, true, true);
        assert_eq!(all.len(), 4);
        let volumes = all.iter().find(|f| f.size == 2).unwrap();
        assert!(
            volumes.risky,
            "volume data needs a tick even with --volumes"
        );
    }

    #[test]
    fn only_older_pnpm_stores_are_left_behind() {
        let root = tempfile::tempdir().unwrap();
        for v in ["v3", "v10", "v11", "tmp"] {
            let store = root.path().join(v);
            std::fs::create_dir_all(&store).unwrap();
            std::fs::write(store.join("blob"), vec![0u8; 4096]).unwrap();
        }

        let found = abandoned_stores(Some(&root.path().join("v10")));

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("v3"));
        assert!(found[0].risky);
    }
}
