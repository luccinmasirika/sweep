use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::ValueEnum;

use crate::{exec, ui};

const LABEL: &str = "io.sweep.cleanup";

#[derive(Clone, Copy, ValueEnum)]
pub enum Action {
    /// Install (or refresh) the recurring cleanup agent
    Install,
    /// Remove the agent
    Remove,
    /// Show whether the agent is installed
    Status,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Interval {
    Daily,
    Weekly,
    Monthly,
}

pub fn run(action: Action, interval: Interval) -> Result<u32> {
    match action {
        Action::Install => install(interval),
        Action::Remove => remove(),
        Action::Status => status(),
    }
}

fn plist_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

fn install(interval: Interval) -> Result<u32> {
    let exe = std::env::current_exe().context("locating the sweep binary")?;
    let path = plist_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&path, plist(&exe.to_string_lossy(), interval))
        .with_context(|| format!("writing {}", path.display()))?;

    // Reload so a changed schedule takes effect.
    let p = path.to_string_lossy().into_owned();
    let _ = exec::run(&["launchctl".into(), "unload".into(), p.clone()]);
    if let Err(e) = exec::run(&["launchctl".into(), "load".into(), "-w".into(), p]) {
        ui::warn(&format!("launchctl load: {e}"));
        return Ok(1);
    }
    ui::ok(&format!(
        "scheduled `sweep smart --yes` ({})",
        interval_label(interval)
    ));
    Ok(0)
}

fn remove() -> Result<u32> {
    let path = plist_path()?;
    if !path.exists() {
        println!("Not scheduled.");
        return Ok(0);
    }
    let _ = exec::run(&[
        "launchctl".into(),
        "unload".into(),
        path.to_string_lossy().into_owned(),
    ]);
    std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
    ui::ok("schedule removed");
    Ok(0)
}

fn status() -> Result<u32> {
    let path = plist_path()?;
    if !path.exists() {
        println!("Not scheduled.");
        return Ok(0);
    }
    let loaded = exec::capture(&["launchctl".into(), "list".into()])
        .map(|out| out.contains(LABEL))
        .unwrap_or(false);
    println!(
        "Scheduled at {} ({}).",
        path.display(),
        if loaded { "loaded" } else { "not loaded" }
    );
    Ok(0)
}

fn interval_label(interval: Interval) -> &'static str {
    match interval {
        Interval::Daily => "daily",
        Interval::Weekly => "weekly",
        Interval::Monthly => "monthly",
    }
}

/// `StartCalendarInterval` keys for the chosen cadence — all at 03:00.
fn calendar(interval: Interval) -> String {
    let mut keys =
        String::from("<key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer>");
    match interval {
        Interval::Daily => {}
        Interval::Weekly => keys.push_str("<key>Weekday</key><integer>0</integer>"),
        Interval::Monthly => keys.push_str("<key>Day</key><integer>1</integer>"),
    }
    keys
}

fn plist(exe: &str, interval: Interval) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
        <string>smart</string>
        <string>--yes</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>{cal}</dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
"#,
        cal = calendar(interval)
    )
}
