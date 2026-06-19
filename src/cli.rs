use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::exec;
use crate::fsutil;
use crate::report::{apply, CleanAction, Finding, Report};
use crate::targets;
use crate::ui;

#[derive(Parser)]
#[command(
    name = "sweep",
    version,
    about = "Safe, interactive disk cleanup for macOS"
)]
pub struct Cli {
    /// Path to a sweep.toml config file
    #[arg(long, global = true)]
    pub config: Option<PathBuf>,
    /// Emit machine-readable JSON instead of formatted output
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Analyse disk usage without deleting anything
    Scan {
        /// Restrict to these targets (comma separated)
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
    },
    /// Free space, confirming before each target
    Clean {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
        /// Restrict to these targets (comma separated)
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
        /// Prune all unused Docker images and clear heavier dev caches
        #[arg(long)]
        aggressive: bool,
        /// Also prune Docker volumes (destructive, implies --aggressive)
        #[arg(long)]
        volumes: bool,
        /// Delete outright instead of moving removable items to the Trash
        #[arg(long)]
        purge: bool,
    },
    /// Browse what's using space and delete interactively
    Explore {
        /// Directory to explore (defaults to your home directory)
        path: Option<PathBuf>,
    },
    /// Find byte-identical duplicate files and trash the extras
    Dupes {
        /// Directory to search (defaults to your home directory)
        path: Option<PathBuf>,
    },
    /// Remove an app and its whole footprint (caches, prefs, containers…)
    Uninstall {
        /// App name, bundle id, or .app path (omit to pick interactively)
        apps: Vec<String>,
        /// Delete outright instead of moving to the Trash
        #[arg(long)]
        purge: bool,
    },
    /// Diagnose where disk space is going, and optionally reclaim it
    Doctor {
        /// Reclaim non-interactively: delete APFS local snapshots, empty the Trash
        #[arg(long)]
        fix: bool,
    },
    /// Run macOS housekeeping (flush DNS, rebuild Spotlight, reset Launch Services…)
    Maintenance {
        /// Run every task without prompting
        #[arg(long)]
        fix: bool,
    },
    /// Scan everything and clean what's safe, in one step
    Smart {
        /// Skip the confirmation prompt
        #[arg(short, long)]
        yes: bool,
        /// Delete outright instead of moving removable items to the Trash
        #[arg(long)]
        purge: bool,
    },
    /// Manage a recurring cleanup agent (launchd)
    Schedule {
        /// install, remove, or status
        action: crate::schedule::Action,
        /// How often `install` should run
        #[arg(long, default_value = "weekly")]
        interval: crate::schedule::Interval,
    },
    /// Print the effective configuration
    Config,
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub(crate) fn collect(cfg: &Config, only: &[String]) -> Result<Vec<Report>> {
    let chosen = targets::all()
        .into_iter()
        .filter(|t| t.enabled(cfg))
        .filter(|t| only.is_empty() || only.iter().any(|n| n == t.name()));

    let mut reports = Vec::new();
    for target in chosen {
        let spinner = ui::spinner(target.name());
        let report = target.scan(cfg)?;
        spinner.finish_and_clear();
        reports.push(report);
    }
    Ok(reports)
}

pub fn run_scan(cfg: &Config, json: bool, only: &[String]) -> Result<()> {
    let reports = collect(cfg, only)?;
    if json {
        ui::print_json(&reports)?;
    } else {
        ui::print_reports(&reports);
        ui::print_summary(&reports);
    }
    Ok(())
}

pub fn run_clean(
    cfg: &Config,
    yes: bool,
    only: &[String],
    aggressive: bool,
    volumes: bool,
    purge: bool,
) -> Result<u32> {
    let mut cfg = cfg.clone();
    cfg.aggressive = aggressive || volumes;
    cfg.prune_volumes = volumes;

    // Without a terminal there's no one to drive the menus, so behave like --yes.
    let guided = !yes && interactive();

    let before = fsutil::free_space_root();
    let reports = collect(&cfg, only)?;
    let mut freed: u64 = 0;
    let mut trashed: u64 = 0;
    let mut failures: u32 = 0;

    for report in &reports {
        if report.is_empty() {
            continue;
        }
        ui::print_report(report);

        let chosen: Vec<&Finding> = if guided {
            let all_default_off = report.findings.iter().all(|f| f.risky || !f.stale);
            match ui::choose_action(
                &report.target,
                report.findings.len(),
                report.total_size(),
                all_default_off,
            )? {
                ui::Action::Skip => continue,
                ui::Action::All => report.findings.iter().collect(),
                ui::Action::Choose => ui::select_findings(report)?
                    .iter()
                    .filter_map(|&i| report.findings.get(i))
                    .collect(),
            }
        } else {
            // Unattended: only safe, idle items — never personal data or
            // projects that still look active.
            report
                .findings
                .iter()
                .filter(|f| !f.risky && f.stale)
                .collect()
        };

        if chosen.is_empty() {
            continue;
        }

        let (fr, tr, fa) = apply_findings(&chosen, purge);
        freed += fr;
        trashed += tr;
        failures += fa;
        ui::ok(&format!("{} cleaned", report.target));
    }

    ui::print_freed(freed, trashed, before, fsutil::free_space_root());
    Ok(failures)
}

/// Apply a batch of findings with a progress bar, returning
/// `(freed, trashed, failures)`. Trashed bytes are tracked apart from freed
/// because they only reclaim space once the Trash is emptied.
pub(crate) fn apply_findings(chosen: &[&Finding], purge: bool) -> (u64, u64, u32) {
    let mut freed = 0;
    let mut trashed = 0;
    let mut failures = 0;
    let pb = ui::clean_progress(chosen.len() as u64);
    for finding in chosen {
        pb.set_message(ui::pretty_path(&finding.path));
        match apply(finding, purge) {
            Ok(bytes) => {
                if !purge && matches!(finding.action, CleanAction::RemovePath) {
                    trashed += bytes;
                } else {
                    freed += bytes;
                }
            }
            Err(e) => {
                failures += 1;
                ui::warn(&format!("{}: {e}", ui::pretty_path(&finding.path)));
            }
        }
        pb.inc(1);
    }
    pb.finish_and_clear();
    (freed, trashed, failures)
}

pub fn run_config(cfg: &Config, json: bool) -> Result<()> {
    if json {
        ui::print_json(cfg)?;
    } else {
        println!("{}", toml::to_string_pretty(cfg)?);
    }
    Ok(())
}

pub fn run_doctor(json: bool, fix: bool) -> Result<u32> {
    let report = fsutil::diagnose();
    if json {
        ui::print_json(&report)?;
        return Ok(0);
    }
    ui::print_doctor(&report);

    // Offer the destructive reclaims the read-only report can only point at.
    let act = fix || interactive();
    if !act {
        return Ok(0);
    }
    let mut failures = 0;

    if !report.local_snapshots.is_empty() {
        let go = fix
            || ui::confirm(&format!(
                "Delete {} APFS local snapshot(s)?",
                report.local_snapshots.len()
            ))?;
        if go {
            for snap in &report.local_snapshots {
                let Some(date) = fsutil::snapshot_date(snap) else {
                    continue;
                };
                let cmd = vec!["tmutil".into(), "deletelocalsnapshots".into(), date];
                if let Err(e) = exec::run(&cmd) {
                    failures += 1;
                    ui::warn(&format!("{snap}: {e} (try with sudo)"));
                }
            }
            ui::ok("local snapshots cleared");
        }
    }

    let trashes: Vec<_> = fsutil::all_trashes()
        .into_iter()
        .filter(|t| fsutil::dir_size(t) > 0)
        .collect();
    if !trashes.is_empty() {
        let go = fix || ui::confirm(&format!("Empty {} Trash location(s) now?", trashes.len()))?;
        if go {
            for trash in &trashes {
                if let Err(e) = fsutil::empty_dir(trash) {
                    failures += 1;
                    ui::warn(&format!("{}: {e}", ui::pretty_path(trash)));
                }
            }
            ui::ok("Trash emptied");
        }
    }

    Ok(failures)
}
