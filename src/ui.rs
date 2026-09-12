use std::time::Duration;

use anyhow::Result;
use dialoguer::theme::ColorfulTheme;
use humansize::{format_size, DECIMAL};
use indicatif::{ProgressBar, ProgressStyle};
use owo_colors::OwoColorize;
use serde::Serialize;

use crate::report::{Finding, Report};

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
        "vm-images" => "💽",
        "applications" => "🧩",
        "heavy" => "🗻",
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
        print_unreadable(&report.unreadable);
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
        if f.unreadable {
            tail.push_str(&format!("{} ", lock_label(f.size).yellow()));
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
    // Personal items are excluded from "reclaimable" on purpose, but a target
    // made only of them must not read as an empty result — the bytes are real,
    // they just need a deliberate tick.
    let reclaimable = report.reclaimable();
    let found = report.total_size();
    let tail = if found > reclaimable {
        format!(
            "↳ reclaimable {} · {} found, yours to pick from",
            human(reclaimable),
            human(found)
        )
    } else {
        format!("↳ reclaimable {}", human(reclaimable))
    };
    println!("  {} {}", " ".repeat(10), tail.dimmed());
    print_unreadable(&report.unreadable);
}

/// Folders macOS refused to list, shortest first. Only the outermost of a
/// nested pair is kept: a denied `~/Library/Mail` says all there is to say
/// about what's inside it.
fn unreadable_roots<'a>(
    paths: impl Iterator<Item = &'a std::path::Path>,
) -> Vec<&'a std::path::Path> {
    let mut sorted: Vec<&std::path::Path> = paths.collect();
    sorted.sort_by_key(|p| p.components().count());
    let mut roots: Vec<&std::path::Path> = Vec::new();
    for p in sorted {
        if !roots.iter().any(|r| p.starts_with(r)) {
            roots.push(p);
        }
    }
    roots
}

fn lock_label(size: u64) -> &'static str {
    if size == 0 {
        "🔒 unreadable"
    } else {
        "🔒 partly unreadable"
    }
}

fn print_unreadable(paths: &[std::path::PathBuf]) {
    let roots = unreadable_roots(paths.iter().map(|p| p.as_path()));
    if roots.is_empty() {
        return;
    }
    const SHOWN: usize = 3;
    let mut list: Vec<String> = roots.iter().take(SHOWN).map(|p| pretty_path(p)).collect();
    if roots.len() > SHOWN {
        list.push(format!("+{} more", roots.len() - SHOWN));
    }
    println!(
        "  {} {}",
        " ".repeat(10),
        format!("🔒 couldn't read {}", list.join(", ")).yellow()
    );
}

pub fn print_summary(reports: &[Report]) {
    let total: u64 = reports.iter().map(|r| r.reclaimable()).sum();
    let found: u64 = reports.iter().map(|r| r.total_size()).sum();
    println!();
    println!("{}", "Summary".bold().underline());
    println!(
        "  {:<17}{:>12}{:>14}",
        "".dimmed(),
        "reclaimable".dimmed(),
        "found".dimmed()
    );
    for r in reports {
        println!(
            "  {} {:<14} {}  {}",
            icon(&r.target),
            r.target,
            size_cell(r.reclaimable(), 12),
            size_cell(r.total_size(), 12)
        );
    }
    println!("  {}", "─".repeat(44).dimmed());
    println!(
        "     {:<14} {}  {}",
        "total",
        size_cell(total, 12).bold(),
        size_cell(found, 12).bold()
    );
    println!();
    println!(
        "{}",
        "Run `sweep clean` to free the reclaimable part; the rest is yours to tick.".dimmed()
    );

    let denied = unreadable_roots(reports.iter().flat_map(|r| {
        r.unreadable.iter().map(|p| p.as_path()).chain(
            r.findings
                .iter()
                .filter(|f| f.unreadable)
                .map(|f| f.path.as_path()),
        )
    }));
    if !denied.is_empty() {
        println!();
        println!(
            "{} {}",
            "🔒".yellow(),
            format!(
                "{} folder(s) couldn't be read, so these totals are a floor.",
                denied.len()
            )
            .yellow()
            .bold()
        );
        println!(
            "   {}",
            "Give your terminal Full Disk Access: System Settings → Privacy & Security → Full Disk Access"
                .dimmed()
        );
    }
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
            "(still recoverable from the Trash)".dimmed()
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
    Safe,
    Choose,
    Skip,
}

/// Action menu shown for one target. Arrow keys move, Enter runs the
/// highlighted line, so there's no toggle-then-confirm to puzzle over.
pub fn choose_action(report: &Report) -> Result<Action> {
    let safe: Vec<&Finding> = report.findings.iter().filter(|f| f.auto()).collect();
    let safe_bytes: u64 = safe.iter().map(|f| f.size).sum();

    // The one-keystroke option only ever covers what `--yes` would take.
    // Personal files, active projects and your Trash need "Choose items…",
    // so a stray Enter can't reach them.
    let mut items = Vec::new();
    if !safe.is_empty() {
        items.push(format!(
            "Clean the {} safe item(s) ({})",
            safe.len(),
            human(safe_bytes)
        ));
    }
    items.push("Choose items…".to_string());
    items.push("Skip".to_string());

    println!(
        "  {}",
        format!(
            "{} items · {} · ↑/↓ then enter",
            report.findings.len(),
            human(report.total_size())
        )
        .dimmed()
    );
    let default = if safe.is_empty() { items.len() - 1 } else { 0 };
    let choice = dialoguer::Select::with_theme(&menu_theme())
        .with_prompt(format!(
            "{} {}",
            icon(&report.target),
            report.target.to_uppercase()
        ))
        .items(&items)
        .default(default)
        .interact()?;
    let offset = usize::from(safe.is_empty());
    Ok(match choice + offset {
        0 => Action::Safe,
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
    let defaults: Vec<bool> = report.findings.iter().map(Finding::auto).collect();
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

    if let Some(c) = &d.container {
        println!("  {}", "APFS container".dimmed());
        println!("  capacity      {}", human(c.capacity).bold());
        println!("  in use        {}", size_cell(c.used, 0));
        println!("  free          {}", human(c.free).bold());
        for vol in &c.volumes {
            println!(
                "    {}  {}",
                size_cell(vol.consumed, 10),
                format!("{} ({})", vol.name, vol.role).dimmed()
            );
        }
    } else if let Some(free) = d.free_space {
        println!("  free on /     {}", human(free).bold());
    }

    if let (Some(finder), Some(purgeable)) = (d.finder_free, d.purgeable) {
        println!(
            "  Finder free   {}  {}",
            human(finder).bold(),
            format!("includes {} macOS purges on demand", human(purgeable)).dimmed()
        );
    }

    if let Some(u) = &d.stalled_update {
        println!();
        println!("{} {}", "Stalled macOS update".bold(), "⚠".yellow());
        if u.seal_broken {
            println!(
                "  {}",
                "the system volume seal is broken: an update was staged and never finished"
                    .yellow()
            );
        }
        for (label, bytes) in [
            ("Preboot holding the staged system", u.preboot_bytes),
            ("downloaded installer in /Library/Updates", u.updates_bytes),
        ] {
            if bytes > 0 {
                println!("  {}  {}", size_cell(bytes, 10), label.dimmed());
            }
        }
        if !u.update_snapshots.is_empty() {
            println!(
                "  {}  {}",
                format!("{:>10}", u.update_snapshots.len()).dimmed(),
                "update snapshot(s) pinning blocks".dimmed()
            );
        }
        println!(
            "  {}  {}",
            size_cell(u.total(), 10),
            "measurable total — the snapshots hold more".bold()
        );
        println!(
            "  {}",
            "fix: finish the update in System Settings, or run `sweep doctor --fix` to drop it"
                .dimmed()
        );
    }

    println!();
    println!("{}", "APFS local snapshots".bold());
    if d.local_snapshots.is_empty() {
        println!("  {}", "none".dimmed());
    } else {
        for snap in &d.local_snapshots {
            let tag = if crate::fsutil::is_update_snapshot(snap) {
                " (staged update)".yellow().to_string()
            } else {
                String::new()
            };
            println!("  {snap}{tag}");
        }
    }

    if let Some(v) = &d.data_volume {
        print_data_volume(v);
    }

    println!();
    println!("{}", "Heaviest ~/Library folders".bold());
    if d.library_dirs.is_empty() {
        println!("  {}", "nothing found".dimmed());
    } else {
        for dir in &d.library_dirs {
            let lock = if dir.unreadable {
                format!("  {}", lock_label(dir.size).yellow())
            } else {
                String::new()
            };
            println!("  {}  {}{lock}", size_cell(dir.size, 10), dir.path.dimmed());
        }
        if d.library_dirs.iter().any(|dir| dir.unreadable) {
            println!(
                "  {}",
                "sizes marked 🔒 are a floor — give your terminal Full Disk Access to see the rest"
                    .dimmed()
            );
        }
    }

    println!();
    println!(
        "{}",
        "Run `sweep scan` to see the heaviest items by name, or `sweep clean` to free caches."
            .dimmed()
    );
}

fn print_data_volume(v: &crate::fsutil::DataVolume) {
    println!();
    println!(
        "{}  {}",
        "Data volume".bold(),
        format!("{} in use", human(v.used)).dimmed()
    );
    for f in &v.folders {
        print_usage_row(f);
    }
    if v.unattributed > 0 {
        println!(
            "  {}  {}",
            size_cell(v.unattributed, 10),
            "not in any folder: APFS metadata, snapshots, unreadable folders".dimmed()
        );
    }

    if !v.system.is_empty() {
        println!();
        println!("{}", "Owned by macOS".bold());
        for f in &v.system {
            print_usage_row(f);
        }
    }
}

fn print_usage_row(f: &crate::fsutil::DirUsage) {
    let mut tail = String::new();
    if f.unreadable {
        tail.push_str(&format!("  {}", lock_label(f.size).yellow()));
    }
    if let Some(note) = f.note {
        tail.push_str(&format!("  {}", note.dimmed()));
    }
    println!("  {}  {}{tail}", size_cell(f.size, 10), f.path.bold());
}

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
