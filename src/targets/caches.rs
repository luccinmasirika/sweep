use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct Caches;

impl Target for Caches {
    fn name(&self) -> &'static str {
        "caches"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.caches
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        for dir in &cfg.cache_dirs {
            if !dir.is_dir() {
                continue;
            }
            let size = fsutil::dir_size(dir);
            if size == 0 {
                continue;
            }
            report.findings.push(Finding {
                path: dir.clone(),
                size,
                note: None,
                action: CleanAction::EmptyDir,
            });
        }
        Ok(report)
    }
}
