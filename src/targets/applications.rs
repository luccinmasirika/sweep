use std::cmp::Reverse;
use std::path::{Path, PathBuf};

use anyhow::Result;

use super::Target;
use crate::apps;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct Applications;

impl Target for Applications {
    fn name(&self) -> &'static str {
        "applications"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.applications
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let roots = [
            PathBuf::from("/Applications"),
            cfg.home.join("Applications"),
        ];
        let mut report = Report::new(self.name());
        report.findings = big_apps(&roots, cfg.large_min_bytes);
        Ok(report)
    }
}

/// Apps heavy enough to matter. Every one is something the user installed on
/// purpose, so nothing here is ticked by default; the note points at
/// `sweep uninstall`, which also takes the app's support files with it.
fn big_apps(roots: &[PathBuf], min: u64) -> Vec<Finding> {
    let mut found: Vec<Finding> = apps::apps_in(roots)
        .into_iter()
        .filter(|app| !is_symlink(&app.path))
        .filter_map(|app| {
            let usage = fsutil::dir_usage(&app.path);
            if usage.bytes < min {
                return None;
            }
            let note = if app.name.starts_with("Install macOS") {
                "macOS installer — re-downloadable from the App Store".to_string()
            } else {
                format!(
                    "`sweep uninstall \"{}\"` also clears its support files",
                    app.name
                )
            };
            Some(
                Finding::dir(app.path, usage.bytes, CleanAction::RemovePath)
                    .risky(true)
                    .unreadable(usage.unreadable)
                    .with_note(note),
            )
        })
        .collect();
    found.sort_by_key(|a| Reverse(a.size));
    found
}

/// Safari and friends appear in `/Applications` as links into the sealed
/// system; they can't be removed and aren't really there to weigh.
fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_app(root: &Path, name: &str, id: &str, bytes: usize) {
        let contents = root.join(format!("{name}.app/Contents"));
        fs::create_dir_all(contents.join("MacOS")).unwrap();
        fs::write(
            contents.join("Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                 <plist version=\"1.0\"><dict>\
                 <key>CFBundleIdentifier</key><string>{id}</string>\
                 </dict></plist>"
            ),
        )
        .unwrap();
        fs::write(contents.join("MacOS/bin"), vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn lists_big_apps_heaviest_first_and_spots_installers() {
        let root = tempfile::tempdir().unwrap();
        fake_app(root.path(), "Editor", "com.example.editor", 300_000);
        fake_app(
            root.path(),
            "Install macOS Tahoe",
            "com.apple.InstallAssistant.macOSTahoe",
            600_000,
        );
        fake_app(root.path(), "Tiny", "com.example.tiny", 1_000);

        let found = big_apps(&[root.path().to_path_buf()], 200_000);

        assert_eq!(found.len(), 2);
        assert!(found[0].path.ends_with("Install macOS Tahoe.app"));
        assert!(found[0].note.as_deref().unwrap().contains("installer"));
        assert!(found[1]
            .note
            .as_deref()
            .unwrap()
            .contains("sweep uninstall \"Editor\""));
        assert!(found.iter().all(|f| f.risky));
    }
}
