use std::time::Duration;

use anyhow::Result;

use super::{find_dirs, Target};
use crate::config::Config;
use crate::report::Report;

pub struct AppCaches;

/// Directory names apps use for throwaway caches, matched wherever they sit so
/// the scan works for any app without hard-coding a list of apps.
const CACHE_NAMES: &[&str] = &["Cache", "Caches", "GPUCache", "Code Cache", "CachedData"];

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
        report.findings = find_dirs(&roots, CACHE_NAMES, Duration::MAX, &[]);
        report.findings.retain(|f| f.size >= cfg.min_dir_bytes);
        Ok(report)
    }
}
