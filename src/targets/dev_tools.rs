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

    fn scan(&self, cfg: &Config) -> Result<Report> {
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

        if let Some(cache) = dirs::home_dir().map(|h| h.join(".cargo/registry/cache")) {
            if cache.is_dir() {
                report.findings.push(Finding {
                    path: cache.clone(),
                    size: fsutil::dir_size(&cache),
                    note: Some("cargo registry cache".to_string()),
                    action: CleanAction::EmptyDir,
                });
            }
        }

        if let Some(cache) = dirs::home_dir().map(|h| h.join("Library/Caches/pip")) {
            if cache.is_dir() {
                report.findings.push(Finding {
                    path: cache.clone(),
                    size: fsutil::dir_size(&cache),
                    note: Some("pip cache".to_string()),
                    action: CleanAction::EmptyDir,
                });
            }
        }

        if cfg.aggressive && exec::command_exists("go") {
            let size = dirs::home_dir()
                .map(|h| h.join("go/pkg/mod"))
                .filter(|p| p.is_dir())
                .map(|p| fsutil::dir_size(&p))
                .unwrap_or(0);
            report.findings.push(Finding {
                path: PathBuf::from("go module cache"),
                size,
                note: Some("re-downloaded on next build".to_string()),
                action: CleanAction::Command(words(&["go", "clean", "-modcache"])),
            });
        }

        if exec::command_exists("docker") {
            let note = exec::capture(&words(&["docker", "system", "df"]))
                .ok()
                .filter(|out| !out.trim().is_empty())
                .map(|_| "see `docker system df` for reclaimable size".to_string());
            let cmd = docker_prune_cmd(cfg.aggressive, cfg.prune_volumes);
            let label = if cfg.aggressive {
                "Docker (all unused images & networks)"
            } else {
                "Docker (unused images & networks)"
            };
            report.findings.push(Finding {
                path: PathBuf::from(label),
                size: 0,
                note,
                action: CleanAction::Command(cmd),
            });
        }

        Ok(report)
    }
}

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

fn docker_prune_cmd(aggressive: bool, volumes: bool) -> Vec<String> {
    let mut cmd = words(&["docker", "system", "prune", "-f"]);
    if aggressive {
        cmd.push("-a".to_string());
    }
    if volumes {
        cmd.push("--volumes".to_string());
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::docker_prune_cmd;

    #[test]
    fn docker_cmd_scales_with_flags() {
        assert_eq!(
            docker_prune_cmd(false, false),
            ["docker", "system", "prune", "-f"]
        );
        assert_eq!(
            docker_prune_cmd(true, false),
            ["docker", "system", "prune", "-f", "-a"]
        );
        assert_eq!(
            docker_prune_cmd(true, true),
            ["docker", "system", "prune", "-f", "-a", "--volumes"]
        );
    }
}
