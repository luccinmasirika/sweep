use std::collections::HashSet;

use anyhow::Result;

use super::Target;
use crate::apps;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct Leftovers;

impl Target for Leftovers {
    fn name(&self) -> &'static str {
        "leftovers"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.leftovers
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let installed = apps::installed_ids();
        let mut report = Report::new(self.name());

        for sub in apps::SUPPORT_DIRS {
            let Ok(rd) = std::fs::read_dir(cfg.home.join(sub)) else {
                continue;
            };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = apps::candidate_id(&name) else {
                    continue;
                };
                if is_system(&id) || matches_installed(&id, &installed) {
                    continue;
                }
                let path = entry.path();
                let size = fsutil::path_size(&path);
                if size < cfg.min_dir_bytes {
                    continue;
                }
                report.findings.push(
                    Finding::dir(path, size, CleanAction::RemovePath)
                        .risky(true)
                        .with_note(format!("no installed app for {id}")),
                );
            }
        }

        report.findings.sort_by(|a, b| b.size.cmp(&a.size));
        Ok(report)
    }
}

fn is_system(id: &str) -> bool {
    const SYSTEM: &[&str] = &[
        "com.apple.",
        "apple.",
        "group.com.apple.",
        "systemgroup.",
        "com.google.keystone.",
    ];
    SYSTEM.iter().any(|p| id.starts_with(p))
}

fn matches_installed(id: &str, installed: &HashSet<String>) -> bool {
    installed.iter().any(|inst| apps::ids_related(id, inst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_ids_and_installed_helpers_are_kept() {
        let mut installed = HashSet::new();
        installed.insert("com.acme.editor".to_string());
        assert!(is_system("com.apple.finder"));
        assert!(matches_installed("com.acme.editor.helper", &installed));
        assert!(!matches_installed("com.gone.app", &installed));
    }
}
