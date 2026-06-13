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
    /// Personal data (e.g. a large file). Left unchecked in the menu and never
    /// removed by `--yes`; it takes a deliberate tick to delete.
    #[serde(default)]
    pub risky: bool,
}

impl Finding {
    pub fn dir(path: PathBuf, size: u64, action: CleanAction) -> Self {
        Self {
            path,
            size,
            note: None,
            action,
            risky: false,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub target: String,
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            findings: Vec::new(),
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

/// Runs a finding's action and returns the bytes freed. For commands the
/// figure is the estimate we computed at scan time, not a measured value.
pub fn apply(finding: &Finding) -> Result<u64> {
    match &finding.action {
        CleanAction::RemovePath => {
            fsutil::remove_path(&finding.path)?;
            Ok(finding.size)
        }
        CleanAction::EmptyDir => {
            fsutil::empty_dir(&finding.path)?;
            Ok(finding.size)
        }
        CleanAction::Command(cmd) => {
            exec::run(cmd)?;
            Ok(finding.size)
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
