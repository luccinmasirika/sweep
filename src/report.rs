use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;

use crate::{exec, fsutil};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "command", rename_all = "snake_case")]
pub enum CleanAction {
    RemovePath,
    /// Wipe the directory's contents but keep the directory itself.
    EmptyDir,
    Command(Vec<String>),
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub path: PathBuf,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub action: CleanAction,
    /// Personal data like a large file. Left unchecked in the menu and never
    /// removed by `--yes`; deleting it takes a deliberate tick.
    #[serde(default)]
    pub risky: bool,
    /// Old enough to clean without a second thought. Caches are always stale;
    /// a project still in active use is not, so it is left unticked by default
    /// and skipped under `--yes`. True for findings that don't age.
    pub stale: bool,
    /// macOS refused to list part of it, so `size` is a floor. A finding like
    /// this stays in the report even at zero bytes: a Trash that only looks
    /// empty because it couldn't be read is not an empty Trash.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}

impl Finding {
    pub fn dir(path: PathBuf, size: u64, action: CleanAction) -> Self {
        Self {
            path,
            size,
            note: None,
            action,
            risky: false,
            stale: true,
            unreadable: false,
        }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    pub fn risky(mut self, risky: bool) -> Self {
        self.risky = risky;
        self
    }

    pub fn stale(mut self, stale: bool) -> Self {
        self.stale = stale;
        self
    }

    pub fn unreadable(mut self, unreadable: bool) -> Self {
        self.unreadable = unreadable;
        self
    }

    /// Picked without asking: safe, idle, and actually readable. Something we
    /// couldn't see into at all has nothing to clean that we can vouch for.
    pub fn auto(&self) -> bool {
        !self.risky && self.stale && !(self.unreadable && self.size == 0)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub target: String,
    pub findings: Vec<Finding>,
    /// Folders the scan wanted to look inside and macOS refused. Nothing in
    /// them is counted anywhere, so they are listed rather than dropped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<PathBuf>,
}

impl Report {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            findings: Vec::new(),
            unreadable: Vec::new(),
        }
    }

    /// Space the safe (non-personal) findings would free. Risky personal items
    /// are excluded so the headline number isn't inflated by files you keep.
    pub fn reclaimable(&self) -> u64 {
        self.findings
            .iter()
            .filter(|f| !f.risky)
            .map(|f| f.size)
            .sum()
    }

    pub fn total_size(&self) -> u64 {
        self.findings.iter().map(|f| f.size).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.findings.is_empty()
    }
}

/// Runs a finding's action and returns the bytes it accounts for, plus what it
/// moved to the Trash if it did. For commands the figure is the estimate we
/// computed at scan time, not a measured value. `purge` forces a real delete
/// for `RemovePath` instead of a move to Trash.
pub fn apply(finding: &Finding, purge: bool) -> Result<(u64, Option<fsutil::TrashId>)> {
    match &finding.action {
        CleanAction::RemovePath => {
            let trashed = fsutil::remove_path(&finding.path, purge)?;
            Ok((finding.size, trashed))
        }
        CleanAction::EmptyDir => {
            fsutil::empty_dir(&finding.path)?;
            Ok((finding.size, None))
        }
        CleanAction::Command(cmd) => {
            exec::run(cmd)?;
            Ok((finding.size, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclaimable_excludes_risky() {
        let mut r = Report::new("t");
        r.findings.push(Finding::dir(
            PathBuf::from("a"),
            10,
            CleanAction::RemovePath,
        ));
        r.findings
            .push(Finding::dir(PathBuf::from("b"), 5, CleanAction::RemovePath).risky(true));
        assert_eq!(r.findings.len(), 2);
        assert_eq!(r.reclaimable(), 10);
    }
}
