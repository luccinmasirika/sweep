use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::fsutil;
use crate::report::{apply, Report};
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
    },
    /// Print the effective configuration
    Config,
}

fn collect(cfg: &Config, only: &[String]) -> Result<Vec<Report>> {
    let mut reports = Vec::new();
    for target in targets::all() {
        if !target.enabled(cfg) {
            continue;
        }
        if !only.is_empty() && !only.iter().any(|n| n == target.name()) {
            continue;
        }
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

pub fn run_clean(cfg: &Config, yes: bool, only: &[String]) -> Result<()> {
    let before = fsutil::free_space_root();
    let reports = collect(cfg, only)?;
    let mut freed: u64 = 0;

    for report in &reports {
        if report.is_empty() {
            continue;
        }
        ui::print_report(report);

        let removable: Vec<_> = report.findings.iter().filter(|f| f.removable()).collect();
        if removable.is_empty() {
            ui::note("read-only, nothing to delete here");
            continue;
        }
        if !yes && !ui::confirm(&format!("Clean {}?", report.target))? {
            continue;
        }
        for finding in removable {
            match apply(finding) {
                Ok(bytes) => freed += bytes,
                Err(e) => ui::warn(&format!("{}: {e}", finding.path.display())),
            }
        }
        ui::ok(&format!("{} cleaned", report.target));
    }

    ui::print_freed(freed, before, fsutil::free_space_root());
    Ok(())
}

pub fn run_config(cfg: &Config, json: bool) -> Result<()> {
    if json {
        ui::print_json(cfg)?;
    } else {
        println!("{}", toml::to_string_pretty(cfg)?);
    }
    Ok(())
}
