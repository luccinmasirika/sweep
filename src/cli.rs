use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::exec;
use crate::fsutil;
use crate::inuse::InUse;
use crate::report::{apply, Finding, Report};
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
    let mut outcome = Outcome::default();
    // Taken when the first item is about to go, not before the menus: an app
    // opened while you were choosing still counts.
    let mut in_use: Option<InUse> = None;

    for report in &reports {
        if report.is_empty() {
            continue;
        }
        ui::print_report(report);

        let chosen: Vec<&Finding> = if guided {
            match ui::choose_action(report)? {
                ui::Action::Skip => continue,
                ui::Action::Safe => report.findings.iter().filter(|f| f.auto()).collect(),
                ui::Action::Choose => ui::select_findings(report)?
                    .iter()
                    .filter_map(|&i| report.findings.get(i))
                    .collect(),
            }
        } else {
            // Unattended: only safe, idle items — never personal data or
            // projects that still look active.
            report.findings.iter().filter(|f| f.auto()).collect()
        };

        if chosen.is_empty() {
            continue;
        }

        let in_use = in_use.get_or_insert_with(InUse::capture);
        outcome.absorb(apply_findings(&chosen, purge, in_use));
        ui::ok(&format!("{} cleaned", report.target));
    }

    ui::print_freed(
        outcome.freed,
        outcome.trash.bytes(),
        before,
        fsutil::free_space_root(),
    );
    ui::print_skipped(&outcome.skipped);
    if guided {
        outcome.failures += offer_to_empty(&outcome.trash)?;
    }
    Ok(outcome.failures)
}

/// What applying a batch of findings did. Trashed items are kept apart from
/// freed bytes: they only reclaim space once they leave the Trash.
#[derive(Default)]
pub(crate) struct Outcome {
    pub freed: u64,
    pub failures: u32,
    pub trash: fsutil::TrashLog,
    pub skipped: Vec<fsutil::Skipped>,
}

impl Outcome {
    fn absorb(&mut self, other: Outcome) {
        self.freed += other.freed;
        self.failures += other.failures;
        self.trash.extend(other.trash);
        self.skipped.extend(other.skipped);
    }
}

/// Offer to empty what this run moved to the Trash — those items and nothing
/// else. Whatever the user put in the Trash themselves stays until they empty
/// it. Only ever called when someone is there to answer.
pub(crate) fn offer_to_empty(trash: &fsutil::TrashLog) -> Result<u32> {
    if trash.is_empty() {
        return Ok(0);
    }
    let found = trash.locate();
    if found.is_empty() {
        return Ok(0);
    }
    let bytes: u64 = found.iter().map(|(_, size)| size).sum();
    println!();
    if !ui::confirm(&format!(
        "Empty the {} item(s) this run moved to the Trash, to free {} now? This can't be undone",
        found.len(),
        ui::human(bytes)
    ))? {
        println!("  left in the Trash — the rest of your Trash was not touched");
        return Ok(0);
    }

    let before = fsutil::free_space_root();
    let mut freed = 0;
    let mut failures = 0;
    for (path, size) in &found {
        match fsutil::delete_from_trash(path) {
            Ok(()) => freed += size,
            Err(e) => {
                failures += 1;
                ui::warn(&format!("{}: {e}", ui::pretty_path(path)));
            }
        }
    }
    ui::print_freed(freed, 0, before, fsutil::free_space_root());
    Ok(failures)
}

/// Apply a batch of findings with a progress bar.
pub(crate) fn apply_findings(chosen: &[&Finding], purge: bool, in_use: &InUse) -> Outcome {
    let mut outcome = Outcome::default();
    let pb = ui::clean_progress(chosen.len() as u64);
    for finding in chosen {
        pb.set_message(ui::pretty_path(&finding.path));
        match apply(finding, purge, in_use) {
            Ok(applied) => {
                match applied.trashed {
                    Some(id) => outcome.trash.record(id, applied.bytes),
                    None => outcome.freed += applied.bytes,
                }
                outcome.skipped.extend(applied.skipped);
            }
            Err(e) => {
                outcome.failures += 1;
                ui::warn(&format!("{}: {e}", ui::pretty_path(&finding.path)));
            }
        }
        pb.inc(1);
    }
    pb.finish_and_clear();
    outcome
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
        let staged = report
            .local_snapshots
            .iter()
            .filter(|s| fsutil::is_update_snapshot(s))
            .count();
        if staged > 0 {
            ui::warn(&format!(
                "{staged} of these hold a staged macOS update — deleting them abandons it"
            ));
        }
        let go = fix
            || ui::confirm(&format!(
                "Delete {} APFS local snapshot(s)?",
                report.local_snapshots.len()
            ))?;
        if go {
            for snap in &report.local_snapshots {
                let Some(id) = fsutil::snapshot_id(snap) else {
                    continue;
                };
                let cmd = vec!["tmutil".into(), "deletelocalsnapshots".into(), id];
                if let Err(e) = exec::run(&cmd) {
                    failures += 1;
                    ui::warn(&format!("{snap}: {e} (try with sudo)"));
                }
            }
            ui::ok("local snapshots cleared");
        }
    }

    let mut trashes = Vec::new();
    for trash in fsutil::all_trashes() {
        let usage = fsutil::dir_usage(&trash);
        if usage.unreadable && usage.bytes == 0 {
            // Skipping it quietly would read as "nothing to empty".
            ui::warn(&format!(
                "can't look inside {} — give your terminal Full Disk Access",
                ui::pretty_path(&trash)
            ));
        } else if usage.bytes > 0 {
            trashes.push(trash);
        }
    }
    if !trashes.is_empty() {
        let go = fix || ui::confirm(&format!("Empty {} Trash location(s) now?", trashes.len()))?;
        if go {
            // Nothing runs out of a Trash folder, so there's nothing in use to
            // look for.
            for trash in &trashes {
                if let Err(e) = fsutil::empty_dir(trash, &InUse::default()) {
                    failures += 1;
                    ui::warn(&format!("{}: {e}", ui::pretty_path(trash)));
                }
            }
            ui::ok("Trash emptied");
        }
    }

    Ok(failures)
}
