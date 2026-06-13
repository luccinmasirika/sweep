use std::time::Duration;

use anyhow::Result;
use humansize::{format_size, DECIMAL};
use indicatif::{ProgressBar, ProgressStyle};
use owo_colors::OwoColorize;
use serde::Serialize;

use crate::report::Report;

pub fn human(bytes: u64) -> String {
    format_size(bytes, DECIMAL)
}

pub fn spinner(label: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    if let Ok(style) = ProgressStyle::with_template("{spinner} scanning {msg}…") {
        pb.set_style(style);
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
    println!();
    println!("{}", report.target.to_uppercase().bold().blue());
    if report.is_empty() {
        println!("  {}", "nothing found".dimmed());
        return;
    }
    for f in &report.findings {
        let size = human(f.size);
        match &f.note {
            Some(note) => println!(
                "  {:>10}  {}  {}",
                size,
                f.path.display(),
                format!("({note})").dimmed()
            ),
            None => println!("  {:>10}  {}", size, f.path.display()),
        }
    }
    println!(
        "  {} {}",
        "→ reclaimable:".dimmed(),
        human(report.reclaimable()).bold()
    );
}

pub fn print_summary(reports: &[Report]) {
    let total: u64 = reports.iter().map(|r| r.reclaimable()).sum();
    println!();
    println!(
        "{} {}",
        "Total reclaimable:".bold(),
        human(total).green().bold()
    );
    println!("{}", "Run `sweep clean` to free this space.".dimmed());
}

pub fn print_freed(freed: u64, before: Option<u64>, after: Option<u64>) {
    println!();
    println!("{} {}", "Freed:".bold(), human(freed).green().bold());
    if let (Some(b), Some(a)) = (before, after) {
        println!("Free space on /: {} → {}", human(b), human(a).bold());
    }
}

pub fn confirm(prompt: &str) -> Result<bool> {
    Ok(dialoguer::Confirm::new()
        .with_prompt(prompt)
        .default(false)
        .interact()?)
}

pub fn note(msg: &str) {
    println!("  {}", msg.dimmed());
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
