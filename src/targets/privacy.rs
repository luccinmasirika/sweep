use std::cmp::Reverse;
use std::path::{Path, PathBuf};

use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct Privacy;

impl Target for Privacy {
    fn name(&self) -> &'static str {
        "privacy"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.privacy
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let home = &cfg.home;
        let mut report = Report::new(self.name());
        let f = &mut report.findings;

        // Browser caches: safe, regenerated on demand.
        for (rel, note) in [
            ("Library/Caches/com.apple.Safari", "safari cache"),
            ("Library/Caches/Google/Chrome", "chrome cache"),
            ("Library/Caches/Firefox", "firefox cache"),
            ("Library/Caches/com.microsoft.edgemac", "edge cache"),
        ] {
            push(f, home.join(rel), CleanAction::EmptyDir, false, note);
        }

        // Mail saves an attachment here when it is opened, and edits made to
        // it are saved in place: not a cache to clear without a look.
        push(
            f,
            home.join("Library/Containers/com.apple.mail/Data/Library/Mail Downloads"),
            CleanAction::EmptyDir,
            true,
            "attachments you opened in Mail — edits made to them are saved here",
        );

        // Cookies and history: risky — clearing them logs you out and erases
        // browsing history, so they start unticked and never go with `--yes`.
        push(
            f,
            home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies"),
            CleanAction::RemovePath,
            true,
            "safari cookies",
        );
        for prof in chrome_profiles(&home.join("Library/Application Support/Google/Chrome")) {
            push(
                f,
                prof.join("Cookies"),
                CleanAction::RemovePath,
                true,
                "chrome cookies",
            );
            push(
                f,
                prof.join("History"),
                CleanAction::RemovePath,
                true,
                "chrome history",
            );
            push(
                f,
                prof.join("Code Cache"),
                CleanAction::EmptyDir,
                false,
                "chrome code cache",
            );
        }
        for prof in child_dirs(&home.join("Library/Application Support/Firefox/Profiles")) {
            push(
                f,
                prof.join("cookies.sqlite"),
                CleanAction::RemovePath,
                true,
                "firefox cookies",
            );
            push(
                f,
                prof.join("places.sqlite"),
                CleanAction::RemovePath,
                true,
                "firefox history and bookmarks",
            );
        }

        f.retain(|x| x.size > 0 || x.unreadable);
        f.sort_by_key(|a| Reverse(a.size));
        Ok(report)
    }
}

fn push(findings: &mut Vec<Finding>, path: PathBuf, action: CleanAction, risky: bool, note: &str) {
    if !path.exists() {
        return;
    }
    let usage = fsutil::path_usage(&path);
    findings.push(
        Finding::dir(path, usage.bytes, action)
            .risky(risky)
            .unreadable(usage.unreadable)
            .with_note(note),
    );
}

/// Chrome stores each profile in `Default` and `Profile N` sub-folders.
fn chrome_profiles(root: &Path) -> Vec<PathBuf> {
    child_dirs(root)
        .into_iter()
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    n == "Default" || n.starts_with("Profile ")
                })
                .unwrap_or(false)
        })
        .collect()
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(root) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => Vec::new(),
    }
}
