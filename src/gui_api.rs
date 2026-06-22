//! The single programmatic surface the GUI talks to. Every function here is a
//! thin, serde-serializable wrapper over the same internals the CLI drives, so
//! the safety guarantees (move-to-Trash by default, protected toolchains,
//! staleness) hold identically. A fresh `Config::load(None)` is read wherever a
//! configuration is needed.

use std::path::{Path, PathBuf};

use anyhow::Result;
use clap::ValueEnum;
use serde::Serialize;

use crate::apps::{self, App};
use crate::config::Config;
use crate::fsutil::{self, Diagnosis};
use crate::report::{Finding, Report};
use crate::{cli, dupes, explore, maintenance, schedule, targets, uninstall};

/// Scan the enabled (and, if `only` is non-empty, named) targets concurrently.
/// Each target's walk is heavy and independent, so running them on their own
/// threads cuts wall-clock to the slowest one instead of their sum.
fn scan_parallel(cfg: &Config, only: &[String]) -> Result<Vec<Report>> {
    let chosen: Vec<_> = targets::all()
        .into_iter()
        .filter(|t| t.enabled(cfg))
        .filter(|t| only.is_empty() || only.iter().any(|n| n == t.name()))
        .collect();

    std::thread::scope(|s| {
        let handles: Vec<_> = chosen.iter().map(|t| s.spawn(|| t.scan(cfg))).collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("target scan thread panicked"))
            .collect()
    })
}

#[derive(Serialize)]
pub struct AppInfo {
    pub path: String,
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

#[derive(Serialize)]
pub struct Item {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct Footprint {
    pub name: String,
    pub id: String,
    pub items: Vec<Item>,
}

#[derive(Serialize)]
pub struct DupeSet {
    pub size: u64,
    pub reclaimable: u64,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
pub struct Child {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct ExploreNode {
    pub path: String,
    pub size: u64,
    pub children: Vec<Child>,
}

#[derive(Serialize)]
pub struct CleanResult {
    pub freed: u64,
    pub trashed: u64,
    pub failures: u32,
}

#[derive(Serialize)]
pub struct ActionResult {
    pub failures: u32,
}

/// Scan disk usage without touching anything. An empty `only` scans every
/// enabled target; otherwise it restricts to the named ones.
pub fn scan(only: Vec<String>) -> Result<Vec<Report>> {
    let cfg = Config::load(None)?;
    scan_parallel(&cfg, &only)
}

/// Re-scan every enabled target, keep the findings whose path string is in
/// `paths`, and apply each. Removable items go to the Trash unless `purge`.
pub fn clean(paths: Vec<String>, purge: bool) -> Result<CleanResult> {
    let cfg = Config::load(None)?;
    let reports = scan_parallel(&cfg, &[])?;
    let chosen: Vec<&Finding> = reports
        .iter()
        .flat_map(|r| r.findings.iter())
        .filter(|f| paths.iter().any(|p| Path::new(p) == f.path))
        .collect();
    let (freed, trashed, failures) = cli::apply_findings(&chosen, purge);
    Ok(CleanResult {
        freed,
        trashed,
        failures,
    })
}

/// Scan everything and clean only the safe, idle items — never personal data or
/// active projects — exactly as `sweep smart --yes`.
pub fn smart_clean(purge: bool) -> Result<CleanResult> {
    let cfg = Config::load(None)?;
    let reports = scan_parallel(&cfg, &[])?;
    let safe: Vec<&Finding> = reports
        .iter()
        .flat_map(|r| r.findings.iter().filter(|f| !f.risky && f.stale))
        .collect();
    let (freed, trashed, failures) = cli::apply_findings(&safe, purge);
    Ok(CleanResult {
        freed,
        trashed,
        failures,
    })
}

/// Every installed application bundle and its identity.
pub fn apps() -> Vec<AppInfo> {
    apps::installed_apps()
        .into_iter()
        .map(|a| AppInfo {
            icon: apps::icon_data_uri(&a.path),
            path: a.path.display().to_string(),
            id: a.id,
            name: a.name,
        })
        .collect()
}

/// The full footprint of the app matching `query` (name, bundle id, or `.app`
/// path): the bundle plus every per-id support file and launch agent, sized.
pub fn footprint(query: String) -> Result<Footprint> {
    let installed = apps::installed_apps();
    let app = uninstall::resolve(&query, &installed)?;
    let paths = uninstall::footprint(&app);
    Ok(to_footprint(&app, &paths))
}

/// Remove the app matching `query` and its whole footprint. Items go to the
/// Trash unless `purge`.
pub fn uninstall(query: String, purge: bool) -> Result<CleanResult> {
    let installed = apps::installed_apps();
    let app = uninstall::resolve(&query, &installed)?;
    let paths = uninstall::footprint(&app);
    let mut freed = 0;
    let mut trashed = 0;
    let mut failures = 0;
    for p in &paths {
        let size = fsutil::path_size(p);
        match fsutil::remove_path(p, purge) {
            Ok(()) => {
                if purge {
                    freed += size;
                } else {
                    trashed += size;
                }
            }
            Err(_) => failures += 1,
        }
    }
    Ok(CleanResult {
        freed,
        trashed,
        failures,
    })
}

/// Privacy findings: browser caches, cookies, history, mail. Risky items
/// (cookies/history) carry the `risky` flag so the UI can leave them unticked.
pub fn privacy() -> Result<Vec<Finding>> {
    let cfg = Config::load(None)?;
    let reports = scan_parallel(&cfg, &["privacy".to_string()])?;
    Ok(reports.into_iter().flat_map(|r| r.findings).collect())
}

/// Byte-identical duplicate sets under `path`, largest waste first.
pub fn dupes(path: String) -> Vec<DupeSet> {
    let root = PathBuf::from(path);
    dupes::find_duplicates(&root)
        .into_iter()
        .map(|s| DupeSet {
            size: s.size,
            reclaimable: s.wasted(),
            paths: s.paths.iter().map(|p| p.display().to_string()).collect(),
        })
        .collect()
}

/// Immediate children of `path`, each sized on disk, largest first — one level
/// of the space-lens drill-down.
pub fn explore(path: String) -> ExploreNode {
    let dir = PathBuf::from(&path);
    let items = explore::children(&dir);
    ExploreNode {
        path: dir.display().to_string(),
        size: items.iter().map(|i| i.size).sum(),
        children: items
            .iter()
            .map(|i| Child {
                path: i.path.display().to_string(),
                size: i.size,
                is_dir: i.is_dir,
            })
            .collect(),
    }
}

/// Read-only snapshot of where disk space is going.
pub fn diagnose() -> Diagnosis {
    fsutil::diagnose()
}

/// Reclaim non-interactively: delete every APFS local snapshot, then empty all
/// Trash locations. Mirrors `sweep doctor --fix`.
pub fn doctor_fix() -> ActionResult {
    let report = fsutil::diagnose();
    let mut failures = 0;

    for snap in &report.local_snapshots {
        let Some(date) = fsutil::snapshot_date(snap) else {
            continue;
        };
        let cmd = vec!["tmutil".into(), "deletelocalsnapshots".into(), date];
        if crate::exec::run(&cmd).is_err() {
            failures += 1;
        }
    }

    for trash in fsutil::all_trashes() {
        if fsutil::empty_dir(&trash).is_err() {
            failures += 1;
        }
    }

    ActionResult { failures }
}

/// Run the named macOS housekeeping tasks (matched by their human label).
pub fn maintenance(tasks: Vec<String>) -> ActionResult {
    let failures = maintenance::run_named(&tasks);
    ActionResult { failures }
}

/// Manage the recurring cleanup agent. `action` is install/remove/status and
/// `interval` is daily/weekly/monthly.
pub fn schedule(action: String, interval: String) -> Result<ActionResult> {
    let action = schedule::Action::from_str(&action, true)
        .map_err(|e| anyhow::anyhow!("invalid schedule action: {e}"))?;
    let interval = schedule::Interval::from_str(&interval, true)
        .map_err(|e| anyhow::anyhow!("invalid schedule interval: {e}"))?;
    let failures = schedule::run(action, interval)?;
    Ok(ActionResult { failures })
}

/// The effective configuration.
pub fn get_config() -> Result<Config> {
    Config::load(None)
}

fn to_footprint(app: &App, paths: &[PathBuf]) -> Footprint {
    Footprint {
        name: app.name.clone(),
        id: app.id.clone(),
        items: paths
            .iter()
            .map(|p| Item {
                path: p.display().to_string(),
                size: fsutil::path_size(p),
            })
            .collect(),
    }
}
