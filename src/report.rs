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
    /// Reported for inspection only, never deleted.
    ReadOnly,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub path: PathBuf,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub action: CleanAction,
}

impl Finding {
    pub fn removable(&self) -> bool {
        !matches!(self.action, CleanAction::ReadOnly)
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

    pub fn reclaimable(&self) -> u64 {
        self.findings
            .iter()
            .filter(|f| f.removable())
            .map(|f| f.size)
            .sum()
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
        CleanAction::ReadOnly => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_split_read_only() {
        let mut r = Report::new("t");
        r.findings.push(Finding {
            path: PathBuf::from("a"),
            size: 10,
            note: None,
            action: CleanAction::RemovePath,
        });
        r.findings.push(Finding {
            path: PathBuf::from("b"),
            size: 5,
            note: None,
            action: CleanAction::ReadOnly,
        });
        assert_eq!(r.findings.len(), 2);
        assert_eq!(r.reclaimable(), 10);
    }
}
