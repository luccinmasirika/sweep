use std::time::Duration;

use anyhow::Result;
use dialoguer::theme::ColorfulTheme;
use humansize::{format_size, DECIMAL};
use indicatif::{ProgressBar, ProgressStyle};
use owo_colors::OwoColorize;
use serde::Serialize;

use crate::report::Report;

const GB: u64 = 1_000_000_000;
const HUNDRED_MB: u64 = 100_000_000;

pub fn human(bytes: u64) -> String {
    format_size(bytes, DECIMAL)
}

/// Right-aligned size of fixed width, coloured by magnitude. The plain string
/// is padded before colouring so the ANSI codes don't throw off the alignment.
fn size_cell(bytes: u64, width: usize) -> String {
    let cell = format!("{:>width$}", human(bytes), width = width);
    if bytes >= GB {
        cell.red().bold().to_string()
    } else if bytes >= HUNDRED_MB {
        cell.yellow().to_string()
    } else {
        cell.green().to_string()
    }
}

fn icon(target: &str) -> &'static str {
    match target {
        "caches" => "🧹",
        "dev-tools" => "📦",
        "large-files" => "📄",
        "node-modules" => "🗂 ",
        _ => "•",
    }
}

pub fn spinner(label: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    if let Ok(style) =
        ProgressStyle::with_template("{spinner:.cyan} scanning {msg} {elapsed:.dimmed}")
    {
        pb.set_style(style.tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ "));
    }
    pb.set_message(label.to_string());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

pub fn print_reports(reports: &[Report]) {
    for report in reports {
        print_report(report);
    }
}

pub fn print_report(report: &Report) {
    let count = report.findings.len();
    println!();
    println!(
        "{} {}  {}",
        icon(&report.target),
        report.target.to_uppercase().bold().blue(),
        format!("({count} found)").dimmed()
    );
    if report.is_empty() {
        println!("   {}", "nothing found".dimmed());
        return;
    }
    for f in &report.findings {
        match &f.note {
            Some(note) => println!(
                "  {}  {}  {}",
                size_cell(f.size, 10),
                f.path.display().dimmed(),
                format!("({note})").yellow()
            ),
            None => println!("  {}  {}", size_cell(f.size, 10), f.path.display().dimmed()),
        }
    }
    println!(
        "  {} {}",
        " ".repeat(10),
        format!("↳ reclaimable {}", human(report.reclaimable())).dimmed()
    );
}

pub fn print_summary(reports: &[Report]) {
    let total: u64 = reports.iter().map(|r| r.reclaimable()).sum();
    println!();
    println!("{}", "Summary".bold().underline());
    for r in reports {
        println!(
            "  {} {:<14} {}",
            icon(&r.target),
            r.target,
            size_cell(r.reclaimable(), 12)
        );
    }
    println!("  {}", "─".repeat(30).dimmed());
    println!("     {:<14} {}", "total", size_cell(total, 12).bold());
    println!();
    println!("{}", "Run `sweep clean` to free this space.".dimmed());
}

pub fn clean_progress(len: u64) -> ProgressBar {
    let pb = ProgressBar::new(len);
    if let Ok(style) =
        ProgressStyle::with_template("  {bar:24.green/dim} {pos}/{len}  {wide_msg:.dimmed}")
    {
        pb.set_style(style.progress_chars("█▉ "));
    }
    pb
}

pub fn print_freed(freed: u64, before: Option<u64>, after: Option<u64>) {
    println!();
    println!("{} {}", "✓".green().bold(), "Done".bold());
    println!("   freed       {}", human(freed).green().bold());
    if let (Some(b), Some(a)) = (before, after) {
        println!("   free on /   {} → {}", human(b).dimmed(), human(a).bold());
    }
}

/// Interactive multi-select over a report's findings. Everything starts
/// checked; returns the indices the user kept ticked.
pub fn select_findings(report: &Report) -> Result<Vec<usize>> {
    let items: Vec<String> = report
        .findings
        .iter()
        .map(|f| match &f.note {
            Some(note) => format!("{}  {}  ({note})", human(f.size), f.path.display()),
            None => format!("{}  {}", human(f.size), f.path.display()),
        })
        .collect();
    let defaults = vec![true; items.len()];
    let selection = dialoguer::MultiSelect::with_theme(&ColorfulTheme::default())
        .with_prompt(format!("Select what to clean in {}", report.target))
        .items(&items)
        .defaults(&defaults)
        .interact()?;
    Ok(selection)
}

pub fn note(msg: &str) {
    println!("   {}", msg.dimmed());
}

pub fn ok(msg: &str) {
    println!("  {} {msg}", "✓".green());
}

pub fn warn(msg: &str) {
    eprintln!("  {} {msg}", "!".yellow());
}

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
