use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::fsutil;
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
    },
    /// Diagnose where disk space is going (read-only)
    Doctor,
    /// Print the effective configuration
    Config,
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn collect(cfg: &Config, only: &[String]) -> Result<Vec<Report>> {
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
) -> Result<()> {
    let mut cfg = cfg.clone();
    cfg.aggressive = aggressive || volumes;
    cfg.prune_volumes = volumes;

    // Without a terminal there's no one to drive the menus, so behave like --yes.
    let guided = !yes && interactive();

    let before = fsutil::free_space_root();
    let reports = collect(&cfg, only)?;
    let mut freed: u64 = 0;

    for report in &reports {
        if report.is_empty() {
            continue;
        }
        ui::print_report(report);

        let chosen: Vec<&Finding> = if guided {
            let all_risky = report.findings.iter().all(|f| f.risky);
            match ui::choose_action(
                &report.target,
                report.findings.len(),
                report.total_size(),
                all_risky,
            )? {
                ui::Action::Skip => continue,
                ui::Action::All => report.findings.iter().collect(),
                ui::Action::Choose => ui::select_findings(report)?
                    .iter()
                    .filter_map(|&i| report.findings.get(i))
                    .collect(),
            }
        } else {
            report.findings.iter().filter(|f| !f.risky).collect()
        };

        if chosen.is_empty() {
            continue;
        }

        let pb = ui::clean_progress(chosen.len() as u64);
        for finding in chosen {
            pb.set_message(finding.path.display().to_string());
            match apply(finding) {
                Ok(bytes) => freed += bytes,
                Err(e) => ui::warn(&format!("{}: {e}", finding.path.display())),
            }
            pb.inc(1);
        }
        pb.finish_and_clear();
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

pub fn run_doctor(json: bool) -> Result<()> {
    let report = fsutil::diagnose();
    if json {
        ui::print_json(&report)?;
    } else {
        ui::print_doctor(&report);
    }
    Ok(())
}
