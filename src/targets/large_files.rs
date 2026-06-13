use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct LargeFiles;

impl Target for LargeFiles {
    fn name(&self) -> &'static str {
        "large-files"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.large_files
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        let stale = Duration::from_secs(cfg.downloads_stale_days * 86_400);

        for dir in &cfg.large_files_dirs {
            if !dir.is_dir() {
                continue;
            }

            let mut entries: Vec<(PathBuf, u64)> = fs::read_dir(dir)?
                .filter_map(|e| e.ok())
                .map(|e| {
                    let path = e.path();
                    let size = if path.is_dir() {
                        fsutil::dir_size(&path)
                    } else {
                        path.metadata().map(|m| m.len()).unwrap_or(0)
                    };
                    (path, size)
                })
                .collect();
            entries.sort_by(|a, b| b.1.cmp(&a.1));

            for (path, size) in entries.into_iter().take(cfg.large_files_top) {
                if size == 0 {
                    continue;
                }
                let note = older_than(&path, stale)
                    .then(|| format!("untouched > {}d", cfg.downloads_stale_days));
                report.findings.push(Finding {
                    path,
                    size,
                    note,
                    action: CleanAction::ReadOnly,
                });
            }
        }
        Ok(report)
    }
}

fn older_than(path: &Path, age: Duration) -> bool {
    let modified = match path.metadata().and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|elapsed| elapsed > age)
        .unwrap_or(false)
}
