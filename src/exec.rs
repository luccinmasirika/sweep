use std::path::PathBuf;
use std::process::Command;

use anyhow::{anyhow, bail, Result};

pub fn command_exists(name: &str) -> bool {
    which(name).is_some()
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

pub fn run(args: &[String]) -> Result<()> {
    let (cmd, rest) = args.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let status = Command::new(cmd).args(rest).status()?;
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
