use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub caches: bool,
    pub dev_tools: bool,
    pub large_files: bool,
    pub node_modules: bool,

    pub cache_dirs: Vec<PathBuf>,
    pub scan_roots: Vec<PathBuf>,
    pub large_files_dirs: Vec<PathBuf>,

    pub large_files_top: usize,
    pub downloads_stale_days: u64,
    pub node_modules_stale_days: u64,
}

impl Default for Config {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            caches: true,
            dev_tools: true,
            large_files: true,
            node_modules: true,
            cache_dirs: vec![
                home.join("Library/Caches"),
                home.join("Library/Logs"),
                home.join(".Trash"),
            ],
            scan_roots: vec![home.join("Developer"), home.join("Documents")],
            large_files_dirs: vec![home.join("Documents"), home.join("Downloads")],
            large_files_top: 20,
            downloads_stale_days: 90,
            node_modules_stale_days: 60,
        }
    }
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let path = match path {
            Some(p) => Some(p.to_path_buf()),
            None => default_config_path(),
        };
        match path {
            Some(p) if p.exists() => {
                let raw = std::fs::read_to_string(&p)
                    .with_context(|| format!("reading {}", p.display()))?;
                let cfg: Config =
                    toml::from_str(&raw).with_context(|| format!("parsing {}", p.display()))?;
                Ok(cfg.expanded())
            }
            _ => Ok(Self::default()),
        }
    }

    fn expanded(mut self) -> Self {
        self.cache_dirs = self.cache_dirs.iter().map(|p| expand(p)).collect();
        self.scan_roots = self.scan_roots.iter().map(|p| expand(p)).collect();
        self.large_files_dirs = self.large_files_dirs.iter().map(|p| expand(p)).collect();
        self
    }
}

fn default_config_path() -> Option<PathBuf> {
    let local = PathBuf::from("sweep.toml");
    if local.exists() {
        return Some(local);
    }
    dirs::config_dir().map(|d| d.join("sweep/config.toml"))
}

fn expand(path: &Path) -> PathBuf {
    if let Ok(rest) = path.strip_prefix("~") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enabled() {
        let c = Config::default();
        assert!(c.caches && c.dev_tools && c.large_files && c.node_modules);
        assert!(c.large_files_top > 0);
    }

    #[test]
    fn parses_partial_toml() {
        let c: Config = toml::from_str("caches = false\n").unwrap();
        assert!(!c.caches);
        assert!(c.dev_tools);
    }

    #[test]
    fn expands_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand(Path::new("~/Library")), home.join("Library"));
    }
}
