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
    /// Paths inside this one that another, more specific finding reports.
    /// They're left out of `size` and left in place when this is emptied.
    #[serde(skip)]
    pub keep: Vec<PathBuf>,
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
            keep: Vec::new(),
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

    /// Where this finding's bytes are on disk: its path, or for a command the
    /// folders it clears. A label like "npm cache" is not a place.
    fn places(&self) -> Vec<PathBuf> {
        if self.path.is_absolute() {
            return vec![self.path.clone()];
        }
        match &self.remeasure {
            Some(Remeasure::Dirs(dirs)) => dirs.clone(),
            _ => Vec::new(),
        }
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

/// Make every byte count once across all reports. Targets overlap by design —
/// `~/Library/Caches` holds the Chrome cache `privacy` names, a heavy folder can
/// hold an app cache — so each nested path belongs to the finding that names it
/// most precisely. The finding around it loses those bytes from its size and,
/// when emptied, leaves the path in place, so unticking the specific item
/// really keeps it. A path reported twice keeps its first finding, carrying
/// over the more careful flags of the other: personal if either says so, idle
/// only if both agree.
pub fn dedupe(reports: &mut [Report]) {
    let places: Vec<(usize, usize, Vec<PathBuf>, u64)> = reports
        .iter()
        .enumerate()
        .flat_map(|(r, report)| {
            report
                .findings
                .iter()
                .enumerate()
                .map(move |(f, finding)| (r, f, finding.places(), finding.size))
        })
        .collect();

    /// A finding, by report and position, and the nested paths it gives up.
    type Owned = (usize, usize, Vec<(PathBuf, u64)>);
    let mut duplicates = Vec::new();
    let mut owned: Vec<Owned> = Vec::new();
    for (i, (r, f, outer, _)) in places.iter().enumerate() {
        let mut inside: Vec<(PathBuf, u64)> = Vec::new();
        for (j, (_, _, inner, size)) in places.iter().enumerate() {
            if i == j {
                continue;
            }
            for path in inner {
                if outer.contains(path) {
                    if j > i && inner.len() == 1 && outer.len() == 1 {
                        duplicates.push(((places[j].0, places[j].1), (*r, *f)));
                    }
                } else if outer.iter().any(|o| path.starts_with(o))
                    && !inside.iter().any(|(p, _)| p == path)
                {
                    inside.push((path.clone(), *size));
                }
            }
        }
        // Only the outermost of nested inner paths: a folder already left out
        // takes everything under it along.
        let tops: Vec<(PathBuf, u64)> = inside
            .iter()
            .filter(|(p, _)| !inside.iter().any(|(q, _)| p != q && p.starts_with(q)))
            .cloned()
            .collect();
        if !tops.is_empty() {
            owned.push((*r, *f, tops));
        }
    }

    for (r, f, tops) in owned {
        let finding = &mut reports[r].findings[f];
        let bytes: u64 = tops.iter().map(|(_, size)| size).sum();
        finding.size = finding.size.saturating_sub(bytes);
        if matches!(finding.action, CleanAction::EmptyDir) {
            finding.keep.extend(tops.into_iter().map(|(p, _)| p));
        }
    }

    duplicates.sort_unstable();
    duplicates.dedup_by_key(|(dup, _)| *dup);
    for &((r, f), (kr, kf)) in &duplicates {
        let (risky, stale) = {
            let dup = &reports[r].findings[f];
            (dup.risky, dup.stale)
        };
        let kept = &mut reports[kr].findings[kf];
        kept.risky |= risky;
        kept.stale &= stale;
    }
    for ((r, f), _) in duplicates.into_iter().rev() {
        reports[r].findings.remove(f);
    }
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
                    if finding.keep.iter().any(|k| k.starts_with(&path)) {
                        return None;
                    }
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
            // Gone since the scan — another run, or the user: nothing was freed here.
            if std::fs::symlink_metadata(&finding.path).is_err() {
                return Applied::default();
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
        CleanAction::EmptyDir => match fsutil::empty_dir(&finding.path, in_use, &finding.keep) {
            Ok(emptied) => Applied {
                bytes: finding
                    .size
                    .saturating_sub(fsutil::size_except(&finding.path, &finding.keep)),
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
    fn something_already_gone_is_not_counted_as_freed() {
        let dir = tempfile::tempdir().unwrap();
        let finding = Finding::dir(
            dir.path().join("vanished/node_modules"),
            3_000_000,
            CleanAction::RemovePath,
        );
        let applied = apply(&finding, true, &InUse::default());
        assert_eq!(applied.bytes, 0);
        assert!(applied.trashed.is_none() && applied.error.is_none());
    }

    #[test]
    fn nested_findings_count_once_and_belong_to_the_precise_one() {
        let caches = PathBuf::from("/Users/me/Library/Caches");
        let google = caches.join("Google");
        let chrome = google.join("Chrome");
        let mut reports = vec![
            Report {
                target: "system-caches".into(),
                findings: vec![Finding::dir(caches.clone(), 1_000, CleanAction::EmptyDir)],
                unreadable: Vec::new(),
            },
            Report {
                target: "privacy".into(),
                findings: vec![
                    Finding::dir(chrome.clone(), 300, CleanAction::EmptyDir),
                    // Inside Chrome's own finding: must not be taken off twice.
                    Finding::dir(chrome.join("Code Cache"), 100, CleanAction::EmptyDir),
                ],
                unreadable: Vec::new(),
            },
            Report {
                target: "app-caches".into(),
                // The very same folder again.
                findings: vec![Finding::dir(
                    chrome.join("Code Cache"),
                    100,
                    CleanAction::RemovePath,
                )],
                unreadable: Vec::new(),
            },
        ];

        dedupe(&mut reports);

        let caches_finding = &reports[0].findings[0];
        assert_eq!(caches_finding.size, 700);
        assert_eq!(caches_finding.keep, vec![chrome.clone()]);
        assert_eq!(reports[1].findings[0].size, 200);
        assert_eq!(reports[1].findings[0].keep, vec![chrome.join("Code Cache")]);
        assert!(reports[2].findings.is_empty(), "the duplicate goes");
        let total: u64 = reports.iter().map(|r| r.total_size()).sum();
        assert_eq!(total, 1_000, "every byte once");
    }

    #[test]
    fn a_path_reported_twice_stays_personal_if_either_says_so() {
        let folder = PathBuf::from("/Users/me/Documents/target");
        let mut reports = vec![
            Report {
                target: "projects".into(),
                findings: vec![Finding::dir(folder.clone(), 900, CleanAction::RemovePath)],
                unreadable: Vec::new(),
            },
            Report {
                target: "large-items".into(),
                findings: vec![Finding::dir(folder.clone(), 900, CleanAction::RemovePath)
                    .risky(true)
                    .stale(false)],
                unreadable: Vec::new(),
            },
        ];

        dedupe(&mut reports);

        let kept = &reports[0].findings[0];
        assert!(kept.risky && !kept.stale);
        assert!(!kept.auto(), "`--yes` must not take a personal folder");
        assert!(reports[1].findings.is_empty());
    }

    #[test]
    fn a_command_overlaps_through_the_folders_it_clears() {
        let npm = PathBuf::from("/Users/me/.npm");
        let mut reports = vec![Report {
            target: "t".into(),
            findings: vec![
                Finding::dir(
                    PathBuf::from("npm cache"),
                    900,
                    CleanAction::Command(words(&["npm", "cache", "clean"])),
                )
                .remeasure(Remeasure::Dirs(vec![npm.clone()])),
                Finding::dir(
                    npm.join("_npx/abc/node_modules"),
                    400,
                    CleanAction::RemovePath,
                ),
            ],
            unreadable: Vec::new(),
        }];

        dedupe(&mut reports);

        assert_eq!(reports[0].findings[0].size, 500);
        assert_eq!(reports[0].findings[1].size, 400);
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
