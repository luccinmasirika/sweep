use std::time::Duration;

use anyhow::Result;

use super::{find_dirs, Target, MARKER_KINDS};
use crate::config::Config;
use crate::report::Report;

pub struct Projects;

impl Target for Projects {
    fn name(&self) -> &'static str {
        "projects"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.projects
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let stale = Duration::from_secs(cfg.projects_stale_days * 86_400);
        let names: Vec<&str> = cfg.project_dir_names.iter().map(String::as_str).collect();
        let prune = cfg.prune_prefixes();

        let mut report = Report::new(self.name());
        report.findings = find_dirs(
            std::slice::from_ref(&cfg.home),
            &names,
            MARKER_KINDS,
            stale,
            &prune,
        );
        report.findings.retain(|f| f.size >= cfg.min_dir_bytes);
        Ok(report)
    }
}
