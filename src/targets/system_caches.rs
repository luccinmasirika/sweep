use anyhow::Result;

use super::Target;
use crate::catalog;
use crate::config::Config;
use crate::report::Report;

pub struct SystemCaches;

impl Target for SystemCaches {
    fn name(&self) -> &'static str {
        "system-caches"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.system_caches
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        report.findings = catalog::system_caches(cfg);
        Ok(report)
    }
}
