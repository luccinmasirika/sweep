use anyhow::Result;

use crate::exec;
use crate::ui;

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

pub(crate) struct Task {
    pub label: &'static str,
    cmds: &'static [&'static [&'static str]],
}

/// macOS housekeeping that frees nothing but keeps the system healthy. Several
/// steps need root, so failures are reported with a hint rather than aborting.
const TASKS: &[Task] = &[
    Task {
        label: "Flush the DNS cache",
        cmds: &[
            &["dscacheutil", "-flushcache"],
            &["killall", "-HUP", "mDNSResponder"],
        ],
    },
    Task {
        label: "Rebuild the Spotlight index",
        cmds: &[&["mdutil", "-E", "/"]],
    },
    Task {
        label: "Reset Launch Services (fix duplicate \"Open With\" entries)",
        cmds: &[&[
            LSREGISTER, "-kill", "-r", "-domain", "local", "-domain", "system", "-domain", "user",
        ]],
    },
    Task {
        label: "Run the periodic maintenance scripts",
        cmds: &[&["periodic", "daily", "weekly", "monthly"]],
    },
];

pub fn run(fix: bool) -> Result<u32> {
    let chosen: Vec<&Task> = if fix || !interactive() {
        TASKS.iter().collect()
    } else {
        let labels: Vec<&str> = TASKS.iter().map(|t| t.label).collect();
        let defaults = vec![true; TASKS.len()];
        println!("  space to tick · enter to run");
        let picks = dialoguer::MultiSelect::with_theme(&ui::menu_theme())
            .with_prompt("Maintenance tasks")
            .items(&labels)
            .defaults(&defaults)
            .interact()?;
        picks.iter().filter_map(|&i| TASKS.get(i)).collect()
    };

    let failures = run_tasks(&chosen);
    list_login_items();
    Ok(failures)
}

/// Run the named maintenance tasks non-interactively, returning the failure
/// count. Unknown labels are ignored. Used by the GUI API.
pub(crate) fn run_named(labels: &[String]) -> u32 {
    let chosen: Vec<&Task> = TASKS
        .iter()
        .filter(|t| labels.iter().any(|l| l == t.label))
        .collect();
    run_tasks(&chosen)
}

fn run_tasks(chosen: &[&Task]) -> u32 {
    let mut failures = 0;
    for task in chosen {
        let mut ok = true;
        for cmd in task.cmds {
            let argv: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();
            if let Err(e) = exec::run(&argv) {
                ok = false;
                failures += 1;
                ui::warn(&format!("{}: {e} (try with sudo)", task.label));
            }
        }
        if ok {
            ui::ok(task.label);
        }
    }
    failures
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Read-only insight: what launches at login. Removal is left to System Settings
/// so we never disable something the user relies on.
fn list_login_items() {
    let out = exec::capture(&[
        "osascript".into(),
        "-e".into(),
        "tell application \"System Events\" to get the name of every login item".into(),
    ]);
    if let Ok(items) = out {
        let items = items.trim();
        if !items.is_empty() {
            println!();
            println!("Login items: {items}");
            println!("  (remove unwanted ones in System Settings › General › Login Items)");
        }
    }
}
