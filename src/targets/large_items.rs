use std::fs;
use std::time::{Duration, SystemTime};

use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct LargeItems;

impl Target for LargeItems {
    fn name(&self) -> &'static str {
        "large-items"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.large_items
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let stale = Duration::from_secs(cfg.downloads_stale_days * 86_400);
        let mut findings = Vec::new();

        for root in cfg.large_roots() {
            let entries = match fs::read_dir(&root) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                // lstat, not stat: never follow a symlink into its target and
                // never materialise an evicted iCloud file just by sizing it.
                let Ok(meta) = entry.metadata() else { continue };
                if fsutil::is_dataless(&meta) {
                    continue;
                }
                let size = if meta.is_dir() {
                    fsutil::dir_size(&path)
                } else {
                    meta.len()
                };
                if size < cfg.large_min_bytes {
                    continue;
                }
                let mut finding =
                    Finding::dir(path.clone(), size, CleanAction::RemovePath).risky(true);
                if older_than(&meta, stale) {
                    finding =
                        finding.with_note(format!("untouched > {}d", cfg.downloads_stale_days));
                }
                findings.push(finding);
            }
        }

        findings.sort_by(|a, b| b.size.cmp(&a.size));
        let mut report = Report::new(self.name());
        report.findings = findings;
        Ok(report)
    }
}

fn older_than(meta: &fs::Metadata, age: Duration) -> bool {
    let modified = match meta.modified() {
        Ok(t) => t,
        Err(_) => return false,
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|elapsed| elapsed > age)
        .unwrap_or(false)
}
