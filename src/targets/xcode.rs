use anyhow::Result;

use super::Target;
use crate::catalog;
use crate::config::Config;
use crate::report::Report;

pub struct Xcode;

impl Target for Xcode {
    fn name(&self) -> &'static str {
        "xcode"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.xcode
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        report.findings = catalog::xcode(cfg);
        Ok(report)
    }
}
