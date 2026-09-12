use std::path::PathBuf;

use serde::Serialize;

use crate::inuse::InUse;
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
    /// How to weigh a command's target again once it has run.
    #[serde(skip)]
    pub remeasure: Option<Remeasure>,
}

/// A way to measure what a cleanup command left behind, so the result reports
/// what actually went rather than the estimate made at scan time.
#[derive(Debug, Clone)]
pub enum Remeasure {
    /// The folders the estimate was taken from.
    Dirs(Vec<PathBuf>),
    /// A tool's own dry run, asked again.
    Probe(fn() -> u64),
}

impl Remeasure {
    fn measure(&self) -> u64 {
        match self {
            Remeasure::Dirs(dirs) => dirs.iter().map(|d| fsutil::path_size(d)).sum(),
            Remeasure::Probe(probe) => probe(),
        }
    }
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
            remeasure: None,
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

    pub fn remeasure(mut self, remeasure: Remeasure) -> Self {
        self.remeasure = Some(remeasure);
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

/// What running one finding did, measured after the fact.
#[derive(Debug, Default)]
pub struct Applied {
    /// Bytes that are really gone: re-measured from what's left, not taken
    /// from the scan.
    pub bytes: u64,
    pub trashed: Option<fsutil::TrashId>,
    /// Left alone because something is using it.
    pub skipped: Vec<fsutil::Skipped>,
    /// Entries of an emptied folder that refused to delete.
    pub failed: Vec<fsutil::Skipped>,
    /// Why the whole action failed, if it did.
    pub error: Option<String>,
}

/// What applying a finding would do, worked out without touching anything.
#[derive(Debug)]
pub struct Plan {
    /// `trash`, `delete`, `empty`, `run` or `skip`.
    pub verb: &'static str,
    /// Bytes the action would take away.
    pub bytes: u64,
    /// What it would leave in place because something is using it.
    pub keeps: Vec<fsutil::Skipped>,
}

/// The dry run of `apply`: the same in-use checks, so a planned clean and a
/// real one leave exactly the same things behind.
pub fn plan(finding: &Finding, purge: bool, in_use: &InUse) -> Plan {
    match &finding.action {
        CleanAction::RemovePath => match in_use.why(&finding.path) {
            Some(reason) => Plan {
                verb: "skip",
                bytes: 0,
                keeps: vec![fsutil::Skipped {
                    path: finding.path.clone(),
                    size: finding.size,
                    reason,
                }],
            },
            None => Plan {
                verb: if purge { "delete" } else { "trash" },
                bytes: finding.size,
                keeps: Vec::new(),
            },
        },
        CleanAction::EmptyDir => {
            let keeps: Vec<fsutil::Skipped> = std::fs::read_dir(&finding.path)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    let reason = in_use.why(&path)?;
                    Some(fsutil::Skipped {
                        size: fsutil::path_size(&path),
                        path,
                        reason,
                    })
                })
                .collect();
            let kept: u64 = keeps.iter().map(|k| k.size).sum();
            Plan {
                verb: "empty",
                bytes: finding.size.saturating_sub(kept),
                keeps,
            }
        }
        CleanAction::Command(_) => Plan {
            verb: "run",
            bytes: finding.size,
            keeps: Vec::new(),
        },
    }
}

/// Runs a finding's action and measures what it achieved. Nothing in use is
/// touched: a path something is using is skipped whole, and emptying a folder
/// leaves its busy entries behind. `purge` forces a real delete for
/// `RemovePath` instead of a move to Trash.
pub fn apply(finding: &Finding, purge: bool, in_use: &InUse) -> Applied {
    match &finding.action {
        CleanAction::RemovePath => {
            if let Some(reason) = in_use.why(&finding.path) {
                return Applied {
                    skipped: vec![fsutil::Skipped {
                        path: finding.path.clone(),
                        size: finding.size,
                        reason,
                    }],
                    ..Applied::default()
                };
            }
            let result = fsutil::remove_path(&finding.path, purge);
            // A delete that fails halfway still removed something.
            let left = fsutil::path_size(&finding.path);
            let bytes = finding.size.saturating_sub(left);
            match result {
                Ok(trashed) => Applied {
                    bytes,
                    trashed,
                    ..Applied::default()
                },
                Err(e) => Applied {
                    bytes,
                    error: Some(format!("{e:#}")),
                    ..Applied::default()
                },
            }
        }
        CleanAction::EmptyDir => match fsutil::empty_dir(&finding.path, in_use) {
            Ok(emptied) => Applied {
                bytes: finding
                    .size
                    .saturating_sub(fsutil::path_size(&finding.path)),
                skipped: emptied.skipped,
                failed: emptied.failed,
                ..Applied::default()
            },
            Err(e) => Applied {
                error: Some(format!("{e:#}")),
                ..Applied::default()
            },
        },
        CleanAction::Command(cmd) => {
            if let Err(e) = exec::run(cmd) {
                return Applied {
                    error: Some(format!("{e:#}")),
                    ..Applied::default()
                };
            }
            let bytes = match &finding.remeasure {
                Some(r) => finding.size.saturating_sub(r.measure()),
                None => finding.size,
            };
            Applied {
                bytes,
                ..Applied::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn a_command_is_credited_with_what_it_removed_not_the_estimate() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(cache.join("keep")).unwrap();
        std::fs::create_dir_all(cache.join("drop")).unwrap();
        std::fs::write(cache.join("keep/a"), vec![0u8; 400_000]).unwrap();
        std::fs::write(cache.join("drop/b"), vec![0u8; 400_000]).unwrap();
        let before = fsutil::path_size(&cache);

        let in_use = InUse::default();
        // Does nothing: nothing was freed, whatever the scan estimated.
        let idle = Finding::dir(
            PathBuf::from("idle"),
            before,
            CleanAction::Command(words(&["true"])),
        )
        .remeasure(Remeasure::Dirs(vec![cache.clone()]));
        assert_eq!(apply(&idle, false, &in_use).bytes, 0);

        // Clears half of it: half is what counts.
        let half = Finding::dir(
            PathBuf::from("half"),
            before,
            CleanAction::Command(words(&["rm", "-rf", cache.join("drop").to_str().unwrap()])),
        )
        .remeasure(Remeasure::Dirs(vec![cache.clone()]));
        let freed = apply(&half, false, &in_use).bytes;
        assert!(freed >= 400_000 && freed < before, "{freed} of {before}");
    }

    #[test]
    fn a_plan_leaves_the_same_things_as_a_real_run_and_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("Caches");
        std::fs::create_dir_all(cache.join("busy")).unwrap();
        std::fs::create_dir_all(cache.join("idle")).unwrap();
        std::fs::write(cache.join("busy/db"), vec![0u8; 300_000]).unwrap();
        std::fs::write(cache.join("idle/db"), vec![0u8; 300_000]).unwrap();
        let size = fsutil::path_size(&cache);
        let busy = cache.join("busy/db");
        let in_use = InUse::with(&[(busy.to_str().unwrap(), "ShipIt")], &[], dir.path());

        let finding = Finding::dir(cache.clone(), size, CleanAction::EmptyDir);
        let planned = plan(&finding, false, &in_use);

        assert_eq!(planned.verb, "empty");
        assert_eq!(planned.keeps.len(), 1);
        assert_eq!(planned.keeps[0].path, cache.join("busy"));
        assert!(planned.bytes < size);
        assert!(cache.join("idle/db").exists(), "a plan must not delete");

        let applied = apply(&finding, false, &in_use);
        assert_eq!(applied.skipped.len(), 1);
        assert_eq!(applied.skipped[0].path, planned.keeps[0].path);
    }

    #[test]
    fn a_failed_command_frees_nothing_and_says_why() {
        let finding = Finding::dir(
            PathBuf::from("broken"),
            1_000_000,
            CleanAction::Command(words(&["false"])),
        );
        let applied = apply(&finding, false, &InUse::default());
        assert_eq!(applied.bytes, 0);
        assert!(applied.error.is_some());
    }

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
