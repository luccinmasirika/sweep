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

/// Global, fixed-location developer caches (package managers, editors, mobile
/// SDKs). All regenerable; the only `risky` one is a slow multi-GB re-download.
pub fn dev_caches(home: &Path) -> Vec<Finding> {
    resolve(
        home,
        &[
            Entry {
                rel: "Library/Caches/go-build",
                action: Action::Empty,
                note: Some("go build cache"),
                risky: false,
            },
            Entry {
                rel: ".m2/repository",
                action: Action::Empty,
                note: Some("maven repository"),
                risky: false,
            },
            Entry {
                rel: ".gradle/caches",
                action: Action::Empty,
                note: Some("gradle caches"),
                risky: false,
            },
            Entry {
                rel: ".pub-cache",
                action: Action::Empty,
                note: Some("dart/flutter pub cache"),
                risky: false,
            },
            Entry {
                rel: ".nuget/packages",
                action: Action::Empty,
                note: Some("nuget packages"),
                risky: false,
            },
            Entry {
                rel: "Library/Caches/ms-playwright",
                action: Action::Empty,
                note: Some("playwright browsers"),
                risky: false,
            },
            Entry {
                rel: ".cache/puppeteer",
                action: Action::Empty,
                note: Some("puppeteer browsers"),
                risky: false,
            },
            Entry {
                rel: "Library/Caches/Cypress",
                action: Action::Empty,
                note: Some("cypress binaries"),
                risky: false,
            },
            Entry {
                rel: "Library/Caches/CocoaPods",
                action: Action::Empty,
                note: Some("cocoapods cache"),
                risky: false,
            },
            Entry {
                rel: "Library/Caches/JetBrains",
                action: Action::Empty,
                note: Some("jetbrains caches"),
                risky: false,
            },
            Entry {
                rel: "Library/Logs/JetBrains",
                action: Action::Empty,
                note: Some("jetbrains logs"),
                risky: false,
            },
            Entry {
                rel: "Library/Application Support/Code/Cache",
                action: Action::Empty,
                note: Some("vs code cache"),
                risky: false,
            },
            Entry {
                rel: "Library/Application Support/Code/CachedData",
                action: Action::Empty,
                note: Some("vs code cached data"),
                risky: false,
            },
            Entry {
                rel: "Library/Application Support/Code/Code Cache",
                action: Action::Empty,
                note: Some("vs code code cache"),
                risky: false,
            },
            Entry {
                rel: "Library/Application Support/Code/GPUCache",
                action: Action::Empty,
                note: Some("vs code gpu cache"),
                risky: false,
            },
            Entry {
                rel: "Library/Android/sdk/system-images",
                action: Action::Remove,
                note: Some("android system images — slow re-download"),
                risky: true,
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
