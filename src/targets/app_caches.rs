use std::path::Path;
use std::time::Duration;

use anyhow::Result;

use super::{find_dirs, Target};
use crate::config::Config;
use crate::report::{CleanAction, Report};

pub struct AppCaches;

/// Directory names apps use for throwaway caches, matched wherever they sit so
/// the scan works for any app without hard-coding a list of apps.
pub(crate) const CACHE_NAMES: &[&str] =
    &["Cache", "Caches", "GPUCache", "Code Cache", "CachedData"];

impl Target for AppCaches {
    fn name(&self) -> &'static str {
        "app-caches"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.app_caches
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let roots = [
            cfg.home.join("Library/Application Support"),
            cfg.home.join("Library/Containers"),
        ];
        let mut report = Report::new(self.name());
        report.findings = find_dirs(&roots, CACHE_NAMES, &[], Duration::MAX, &[])
            .into_iter()
            .filter(|f| f.size >= cfg.min_dir_bytes)
            .filter(|f| !apple_container(&f.path, &roots[1]))
            // A cache is emptied in place, like ~/Library/Caches: deleted
            // outright rather than parked in the Trash where it frees nothing,
            // and the folder an app — sandboxed ones especially — expects stays.
            .map(|mut f| {
                f.action = CleanAction::EmptyDir;
                f
            })
            .collect();
        Ok(report)
    }
}

/// macOS's own daemons keep containers too. Their caches are rebuilt on the
/// system's schedule and at its CPU cost — media analysis, Photos, Spotlight —
/// so they're not the user's to clear.
fn apple_container(path: &Path, containers: &Path) -> bool {
    path.strip_prefix(containers)
        .ok()
        .and_then(|rest| rest.iter().next())
        .is_some_and(|c| c.to_string_lossy().starts_with("com.apple."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn app_caches_are_emptied_in_place_and_apples_are_left_alone() {
        let home = tempfile::tempdir().unwrap();
        for dir in [
            "Library/Containers/com.tinyapp.Notes/Data/Library/Caches",
            "Library/Containers/com.apple.mediaanalysisd/Data/Library/Caches",
        ] {
            let dir = home.path().join(dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("blob"), vec![0u8; 2_000_000]).unwrap();
        }
        let cfg = Config {
            home: home.path().to_path_buf(),
            ..Default::default()
        };

        let found = AppCaches.scan(&cfg).unwrap().findings;

        assert_eq!(found.len(), 1);
        assert!(found[0]
            .path
            .to_string_lossy()
            .contains("com.tinyapp.Notes"));
        assert!(matches!(found[0].action, CleanAction::EmptyDir));
    }
}
