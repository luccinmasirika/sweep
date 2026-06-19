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

/// At most this many rows per target; the rest roll up into a summary line.
const MAX_ROWS: usize = 12;

/// Home-relative, middle-elided path that stays readable on one line.
pub fn pretty_path(path: &std::path::Path) -> String {
    let shown = match dirs::home_dir().and_then(|h| path.strip_prefix(&h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    };
    if shown.chars().count() <= 52 {
        return shown;
    }
    let parts: Vec<&str> = shown.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 4 {
        format!("{}/…/{}", parts[0], parts[parts.len() - 3..].join("/"))
    } else {
        shown
    }
}

fn icon(target: &str) -> &'static str {
    match target {
        "system-caches" => "🧹",
        "app-caches" => "📱",
        "dev-tools" => "📦",
        "xcode" => "🔨",
        "projects" => "🏗 ",
        "large-items" => "📄",
        "leftovers" => "👻",
        "privacy" => "🕵 ",
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
    let shown = count.min(MAX_ROWS);
    for f in &report.findings[..shown] {
        let mut tail = String::new();
        if f.risky {
            tail.push_str(&format!("{} ", "⚠ personal".red()));
        }
        if !f.stale {
            tail.push_str(&format!("{} ", "active".cyan()));
        }
        if let Some(note) = &f.note {
            tail.push_str(&format!("({note})").yellow().to_string());
        }
        if tail.is_empty() {
            println!(
                "  {}  {}",
                size_cell(f.size, 10),
                pretty_path(&f.path).dimmed()
            );
        } else {
            println!(
                "  {}  {}  {}",
                size_cell(f.size, 10),
                pretty_path(&f.path).dimmed(),
                tail
            );
        }
    }
    if count > shown {
        let rest: u64 = report.findings[shown..].iter().map(|f| f.size).sum();
        println!(
            "  {}",
            format!("… and {} more ({})", count - shown, human(rest)).dimmed()
        );
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

pub fn print_freed(freed: u64, trashed: u64, before: Option<u64>, after: Option<u64>) {
    println!();
    println!("{} {}", "✓".green().bold(), "Done".bold());
    if freed > 0 || trashed == 0 {
        println!("   freed       {}", human(freed).green().bold());
    }
    if trashed > 0 {
        println!(
            "   to Trash    {}  {}",
            human(trashed).yellow().bold(),
            "(empty the Trash to reclaim it)".dimmed()
        );
    }
    if let (Some(b), Some(a)) = (before, after) {
        println!("   free on /   {} → {}", human(b).dimmed(), human(a).bold());
    }
}

/// Shared menu theme: filled green circle when ticked, hollow grey one when
/// not, and a solid cyan bar on the focused row so the cursor is unmistakable.
pub fn menu_theme() -> ColorfulTheme {
    use dialoguer::console::{style, Style};
    ColorfulTheme {
        checked_item_prefix: style("◉".to_string()).for_stderr().green(),
        unchecked_item_prefix: style("○".to_string()).for_stderr().dim(),
        active_item_style: Style::new().for_stderr().black().on_cyan().bold(),
        ..ColorfulTheme::default()
    }
}

pub enum Action {
    All,
    Choose,
    Skip,
}

/// Action menu shown for one target. Arrow keys move, Enter runs the
/// highlighted line, so there's no toggle-then-confirm to puzzle over.
pub fn choose_action(
    target: &str,
    count: usize,
    total: u64,
    all_default_off: bool,
) -> Result<Action> {
    let items = [
        format!("Clean all ({})", human(total)),
        "Choose items…".to_string(),
        "Skip".to_string(),
    ];
    // Default to Skip when nothing here is a safe default (all personal or
    // still-active), otherwise to Clean all.
    let default = if all_default_off { 2 } else { 0 };
    println!(
        "  {}",
        format!("{count} items · {} · ↑/↓ then enter", human(total)).dimmed()
    );
    let choice = dialoguer::Select::with_theme(&menu_theme())
        .with_prompt(format!("{} {}", icon(target), target.to_uppercase()))
        .items(&items)
        .default(default)
        .interact()?;
    Ok(match choice {
        0 => Action::All,
        1 => Action::Choose,
        _ => Action::Skip,
    })
}

/// Granular multi-select, reached only via "Choose items…". Safe items start
/// ticked, personal ones unticked.
pub fn select_findings(report: &Report) -> Result<Vec<usize>> {
    let items: Vec<String> = report
        .findings
        .iter()
        .map(|f| match &f.note {
            Some(note) => format!("{}  {}  ({note})", human(f.size), pretty_path(&f.path)),
            None => format!("{}  {}", human(f.size), pretty_path(&f.path)),
        })
        .collect();
    let defaults: Vec<bool> = report
        .findings
        .iter()
        .map(|f| !f.risky && f.stale)
        .collect();
    println!("  {}", "↑/↓ move · space to tick · enter to apply".dimmed());
    let selection = dialoguer::MultiSelect::with_theme(&menu_theme())
        .with_prompt("Tick what to clean")
        .items(&items)
        .defaults(&defaults)
        .interact()?;
    Ok(selection)
}

/// Yes/no prompt, defaulting to no so a stray Enter never deletes anything.
pub fn confirm(prompt: &str) -> Result<bool> {
    Ok(dialoguer::Confirm::with_theme(&menu_theme())
        .with_prompt(prompt)
        .default(false)
        .interact()?)
}

pub fn ok(msg: &str) {
    println!("  {} {msg}", "✓".green());
}

pub fn warn(msg: &str) {
    eprintln!("  {} {msg}", "!".yellow());
}

pub fn print_doctor(d: &crate::fsutil::Diagnosis) {
    println!();
    println!("{}", "Disk doctor".bold().underline());

    if let Some(free) = d.free_space {
        println!("  free on /     {}", human(free).bold());
    }

    println!();
    println!("{}", "APFS local snapshots".bold());
    if d.local_snapshots.is_empty() {
        println!("  {}", "none".dimmed());
    } else {
        for snap in &d.local_snapshots {
            println!("  {snap}");
        }
        println!(
            "  {}",
            "tip: `tmutil deletelocalsnapshots <date>` to remove".dimmed()
        );
    }

    println!();
    println!("{}", "Heaviest ~/Library folders".bold());
    if d.library_dirs.is_empty() {
        println!("  {}", "nothing found".dimmed());
    } else {
        for dir in &d.library_dirs {
            println!("  {}  {}", size_cell(dir.size, 10), dir.path.dimmed());
        }
    }

    println!();
    println!(
        "{}",
        "Run `sweep clean` for caches & dev junk, or `sweep clean --aggressive` to go further."
            .dimmed()
    );
}

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
