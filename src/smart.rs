use anyhow::Result;

use crate::config::Config;
use crate::inuse::InUse;
use crate::report::Finding;
use crate::{cli, ui};

/// One-click care: scan every enabled target, show the summary, then clean only
/// the safe, idle items (never personal data or active projects) after a single
/// confirmation. Removable items go to the Trash unless `--purge`.
pub fn run(cfg: &Config, yes: bool, purge: bool) -> Result<u32> {
    if !yes && !interactive() {
        anyhow::bail!("no terminal to confirm in — pass --yes to clean unattended, or --dry-run to see what would go");
    }
    let before = cli::Baseline::now();
    let reports = cli::collect(cfg, &[])?;
    ui::print_summary(&reports);

    let safe: Vec<&Finding> = reports
        .iter()
        .flat_map(|r| r.findings.iter().filter(|f| f.auto()))
        .collect();

    if safe.is_empty() {
        println!();
        println!("Nothing safe to clean.");
        return Ok(0);
    }

    let total: u64 = safe.iter().map(|f| f.size).sum();
    if !yes {
        println!();
        if !ui::confirm(&format!(
            "Clean {} safe item(s) ({})?",
            safe.len(),
            ui::human(total)
        ))? {
            return Ok(0);
        }
    }

    let mut outcome = cli::apply_findings(&safe, purge, &InUse::capture()?);
    outcome.report(&before);
    if !yes {
        outcome.failures += cli::offer_to_empty(&outcome.trash)?;
    }
    Ok(outcome.failures)
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}
