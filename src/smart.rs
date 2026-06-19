use anyhow::Result;

use crate::config::Config;
use crate::report::Finding;
use crate::{cli, fsutil, ui};

/// One-click care: scan every enabled target, show the summary, then clean only
/// the safe, idle items (never personal data or active projects) after a single
/// confirmation. Removable items go to the Trash unless `--purge`.
pub fn run(cfg: &Config, yes: bool, purge: bool) -> Result<u32> {
    let before = fsutil::free_space_root();
    let reports = cli::collect(cfg, &[])?;
    ui::print_summary(&reports);

    let safe: Vec<&Finding> = reports
        .iter()
        .flat_map(|r| r.findings.iter().filter(|f| !f.risky && f.stale))
        .collect();

    if safe.is_empty() {
        println!();
        println!("Nothing safe to clean.");
        return Ok(0);
    }

    let total: u64 = safe.iter().map(|f| f.size).sum();
    if !yes && interactive() {
        println!();
        if !ui::confirm(&format!(
            "Clean {} safe item(s) ({})?",
            safe.len(),
            ui::human(total)
        ))? {
            return Ok(0);
        }
    }

    let (freed, trashed, failures) = cli::apply_findings(&safe, purge);
    ui::print_freed(freed, trashed, before, fsutil::free_space_root());
    Ok(failures)
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}
