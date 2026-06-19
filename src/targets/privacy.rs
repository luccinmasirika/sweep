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

        // Browser caches and saved Mail attachments: safe, regenerated or
        // re-downloaded on demand.
        for (rel, note) in [
            ("Library/Caches/com.apple.Safari", "safari cache"),
            ("Library/Caches/Google/Chrome", "chrome cache"),
            ("Library/Caches/Firefox", "firefox cache"),
            ("Library/Caches/com.microsoft.edgemac", "edge cache"),
            (
                "Library/Containers/com.apple.mail/Data/Library/Mail Downloads",
                "mail downloads",
            ),
        ] {
            push(f, home.join(rel), CleanAction::EmptyDir, false, note);
        }

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
                "firefox history",
            );
        }

        f.retain(|x| x.size > 0);
        f.sort_by(|a, b| b.size.cmp(&a.size));
        Ok(report)
    }
}

fn push(findings: &mut Vec<Finding>, path: PathBuf, action: CleanAction, risky: bool, note: &str) {
    if !path.exists() {
        return;
    }
    let size = fsutil::path_size(&path);
    findings.push(
        Finding::dir(path, size, action)
            .risky(risky)
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
