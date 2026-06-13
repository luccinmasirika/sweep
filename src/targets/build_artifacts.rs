use std::time::Duration;

use anyhow::Result;

use super::{find_dirs, Target};
use crate::config::Config;
use crate::report::Report;

pub struct BuildArtifacts;

impl Target for BuildArtifacts {
    fn name(&self) -> &'static str {
        "build-artifacts"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.build_artifacts
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let stale = Duration::from_secs(cfg.build_artifacts_stale_days * 86_400);
        let names: Vec<&str> = cfg.build_dir_names.iter().map(String::as_str).collect();
        let mut report = Report::new(self.name());
        report.findings = find_dirs(&cfg.scan_roots, &names, stale);
        Ok(report)
    }
}
