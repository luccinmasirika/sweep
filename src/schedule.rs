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

/// The per-user launchd domain the agent lives in.
fn domain() -> String {
    // SAFETY: getuid has no preconditions and cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

fn install(interval: Interval) -> Result<u32> {
    let exe = std::env::current_exe().context("locating the sweep binary")?;
    let path = plist_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let log = dirs::home_dir()
        .context("no home directory")?
        .join("Library/Application Support/sweep/schedule.log");
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(
        &path,
        plist(
            &exe.to_string_lossy(),
            &user_path(),
            &log.to_string_lossy(),
            interval,
        ),
    )
    .with_context(|| format!("writing {}", path.display()))?;

    // Reload so a changed schedule takes effect.
    let _ = exec::run(&[
        "launchctl".into(),
        "bootout".into(),
        format!("{}/{LABEL}", domain()),
    ]);
    let p = path.to_string_lossy().into_owned();
    if let Err(e) = exec::run(&["launchctl".into(), "bootstrap".into(), domain(), p]) {
        ui::warn(&format!("launchctl bootstrap: {e}"));
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
        "bootout".into(),
        format!("{}/{LABEL}", domain()),
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
    let loaded = exec::capture(&[
        "launchctl".into(),
        "print".into(),
        format!("{}/{LABEL}", domain()),
    ])
    .is_ok_and(|out| out.contains(LABEL));
    println!(
        "Scheduled at {} ({}).",
        path.display(),
        if loaded { "loaded" } else { "not loaded" }
    );
    Ok(0)
}

/// The `PATH` of the terminal `schedule install` runs in. launchd starts agents
/// with only `/usr/bin:/bin:/usr/sbin:/sbin`, where brew, npm, docker and the
/// rest aren't found — nor are the toolchains a clean must never touch, so a
/// scheduled run would lose the very check that protects them.
fn user_path() -> String {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<String> = std::env::split_paths(&path)
        .filter(|d| d.is_absolute())
        .map(|d| d.to_string_lossy().into_owned())
        .collect();
    if dirs.is_empty() {
        "/usr/bin:/bin:/usr/sbin:/sbin".to_string()
    } else {
        dirs.join(":")
    }
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

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A background agent: low CPU and I/O priority so a clean that fires while
/// someone is working doesn't get in their way, and its errors kept in a log.
fn plist(exe: &str, path: &str, log: &str, interval: Interval) -> String {
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>{cal}</dict>
    <key>RunAtLoad</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
        exe = xml_escape(exe),
        path = xml_escape(path),
        log = xml_escape(log),
        cal = calendar(interval)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_runs_with_the_users_path_in_the_background() {
        let plist = plist(
            "/opt/homebrew/bin/sweep",
            "/Users/me/.nvm/versions/node/v20/bin:/opt/homebrew/bin:/usr/bin",
            "/Users/me/Library/Application Support/sweep/schedule.log",
            Interval::Weekly,
        );
        assert!(plist.contains(
            "<key>PATH</key>\n        <string>/Users/me/.nvm/versions/node/v20/bin:/opt/homebrew/bin:/usr/bin</string>"
        ));
        assert!(plist.contains("<string>Background</string>"));
        assert!(plist.contains("<key>LowPriorityIO</key>\n    <true/>"));
        assert!(plist.contains("<key>Weekday</key>"));
    }

    #[test]
    fn paths_are_escaped_for_the_plist() {
        assert_eq!(xml_escape("/Users/R&D/<bin>"), "/Users/R&amp;D/&lt;bin&gt;");
    }
}
