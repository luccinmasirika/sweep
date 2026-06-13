use std::path::Path;

use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding};

/// A well-known space consumer that exists on a typical Mac. Paths are relative
/// to the home directory, so the same catalog works for any user.
struct Entry {
    rel: &'static str,
    action: Action,
    note: Option<&'static str>,
    risky: bool,
}

enum Action {
    Empty,
    Remove,
}

fn resolve(home: &Path, entries: &[Entry]) -> Vec<Finding> {
    let mut out = Vec::new();
    for e in entries {
        let path = home.join(e.rel);
        if !path.is_dir() {
            continue;
        }
        let size = fsutil::dir_size(&path);
        if size == 0 {
            continue;
        }
        let action = match e.action {
            Action::Empty => CleanAction::EmptyDir,
            Action::Remove => CleanAction::RemovePath,
        };
        let mut finding = Finding::dir(path, size, action).risky(e.risky);
        if let Some(note) = e.note {
            finding = finding.with_note(note);
        }
        out.push(finding);
    }
    out.sort_by(|a, b| b.size.cmp(&a.size));
    out
}

pub fn system_caches(cfg: &Config) -> Vec<Finding> {
    resolve(
        &cfg.home,
        &[
            Entry {
                rel: "Library/Caches",
                action: Action::Empty,
                note: None,
                risky: false,
            },
            Entry {
                rel: "Library/Logs",
                action: Action::Empty,
                note: Some("logs"),
                risky: false,
            },
            Entry {
                rel: ".Trash",
                action: Action::Empty,
                note: Some("trash"),
                risky: false,
            },
        ],
    )
}

pub fn xcode(cfg: &Config) -> Vec<Finding> {
    resolve(
        &cfg.home,
        &[
            Entry {
                rel: "Library/Developer/Xcode/DerivedData",
                action: Action::Empty,
                note: Some("build cache"),
                risky: false,
            },
            Entry {
                rel: "Library/Developer/Xcode/iOS DeviceSupport",
                action: Action::Empty,
                note: Some("device support"),
                risky: false,
            },
            Entry {
                rel: "Library/Developer/CoreSimulator/Caches",
                action: Action::Empty,
                note: Some("simulator caches"),
                risky: false,
            },
            Entry {
                rel: "Library/Developer/Xcode/Archives",
                action: Action::Remove,
                note: Some("signed build archives"),
                risky: true,
            },
            Entry {
                rel: "Library/Application Support/MobileSync/Backup",
                action: Action::Remove,
                note: Some("iOS device backups"),
                risky: true,
            },
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn missing_paths_are_skipped() {
        let cfg = Config {
            home: PathBuf::from("/nonexistent-sweep-home"),
            ..Default::default()
        };
        assert!(system_caches(&cfg).is_empty());
        assert!(xcode(&cfg).is_empty());
    }
}
