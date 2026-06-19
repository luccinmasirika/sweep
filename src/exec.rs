use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Result};

pub fn command_exists(name: &str) -> bool {
    which(name).is_some()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Run a cleanup command quietly: its own chatter (deleted Docker IDs, npm
/// logs, …) is dropped so only sweep's progress shows.
pub fn run(args: &[String]) -> Result<()> {
    let (cmd, rest) = args.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let status = Command::new(cmd)
        .args(rest)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("`{}` exited with {status}", args.join(" "));
    }
    Ok(())
}

pub fn capture(args: &[String]) -> Result<String> {
    let (cmd, rest) = args.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let output = Command::new(cmd).args(rest).output()?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
