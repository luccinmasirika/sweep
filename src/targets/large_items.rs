use std::cmp::Reverse;
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
        let mut report = Report::new(self.name());
        let mut findings = Vec::new();

        for root in cfg.large_roots() {
            let entries = match fs::read_dir(&root) {
                Ok(e) => e,
                // Desktop and Documents sit behind their own privacy prompt;
                // a refusal there hides everything the user cares about most.
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    report.unreadable.push(root);
                    continue;
                }
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
                let usage = if meta.is_dir() {
                    fsutil::dir_usage(&path)
                } else {
                    fsutil::Usage {
                        bytes: meta.len(),
                        unreadable: false,
                    }
                };
                if usage.bytes < cfg.large_min_bytes {
                    continue;
                }
                let mut finding = Finding::dir(path.clone(), usage.bytes, CleanAction::RemovePath)
                    .risky(true)
                    .unreadable(usage.unreadable);
                if older_than(&meta, stale) {
                    finding =
                        finding.with_note(format!("untouched > {}d", cfg.downloads_stale_days));
                }
                findings.push(finding);
            }
        }

        findings.sort_by_key(|a| Reverse(a.size));
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
