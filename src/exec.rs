use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

/// How long a read-only probe (`docker system df`, `brew cleanup --dry-run`…)
/// may take. Pointed at a stopped VM or an unreachable host, some of these wait
/// forever, and a scan must not hang on a size estimate.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Run a probe and return its stdout, killing it if it outlives
/// `PROBE_TIMEOUT`. Cleanup commands themselves go through `run`, which waits
/// as long as they need.
pub fn capture(args: &[String]) -> Result<String> {
    capture_within(args, PROBE_TIMEOUT)
}

fn capture_within(args: &[String], timeout: Duration) -> Result<String> {
    let (cmd, rest) = args.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let mut child = Command::new(cmd)
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    // Drain stdout on its own thread so a chatty command can't fill the pipe
    // and block before we get to check the clock.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });

    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "`{}` timed out after {}s",
                args.join(" "),
                timeout.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = reader.join().unwrap_or_default();
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn captures_output() {
        assert_eq!(capture(&words(&["echo", "hello"])).unwrap(), "hello\n");
    }

    #[test]
    fn a_probe_that_hangs_is_killed() {
        let started = Instant::now();
        let result = capture_within(&words(&["sleep", "30"]), Duration::from_millis(200));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
