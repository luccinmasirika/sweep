use std::path::PathBuf;

use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::exec;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct DevTools;

impl Target for DevTools {
    fn name(&self) -> &'static str {
        "dev-tools"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.dev_tools
    }

    fn scan(&self, _cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());

        if exec::command_exists("brew") {
            let note = exec::capture(&words(&["brew", "cleanup", "--dry-run"]))
                .ok()
                .and_then(|out| {
                    out.lines()
                        .rev()
                        .find(|l| l.contains("approximately"))
                        .map(|l| l.trim().to_string())
                });
            report.findings.push(Finding {
                path: PathBuf::from("Homebrew cache"),
                size: 0,
                note,
                action: CleanAction::Command(words(&["brew", "cleanup", "-s"])),
            });
        }

        if exec::command_exists("npm") {
            let size = exec::capture(&words(&["npm", "config", "get", "cache"]))
                .ok()
                .map(|p| PathBuf::from(p.trim()))
                .filter(|p| p.is_dir())
                .map(|p| fsutil::dir_size(&p))
                .unwrap_or(0);
            report.findings.push(Finding {
                path: PathBuf::from("npm cache"),
                size,
                note: None,
                action: CleanAction::Command(words(&["npm", "cache", "clean", "--force"])),
            });
        }

        if exec::command_exists("pnpm") {
            report.findings.push(Finding {
                path: PathBuf::from("pnpm store"),
                size: 0,
                note: None,
                action: CleanAction::Command(words(&["pnpm", "store", "prune"])),
            });
        }

        if exec::command_exists("yarn") {
            report.findings.push(Finding {
                path: PathBuf::from("yarn cache"),
                size: 0,
                note: None,
                action: CleanAction::Command(words(&["yarn", "cache", "clean"])),
            });
        }

        if exec::command_exists("docker") {
            let note = exec::capture(&words(&["docker", "system", "df"]))
                .ok()
                .filter(|out| !out.trim().is_empty())
                .map(|_| "see `docker system df` for reclaimable size".to_string());
            report.findings.push(Finding {
                path: PathBuf::from("Docker (unused images & networks)"),
                size: 0,
                note,
                action: CleanAction::Command(words(&["docker", "system", "prune", "-f"])),
            });
        }

        Ok(report)
    }
}

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}
