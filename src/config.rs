use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Everything is derived from `home`, so the tool works with no config at all.
/// Each field is an optional override; missing ones fall back to the defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub system_caches: bool,
    pub app_caches: bool,
    pub dev_tools: bool,
    pub xcode: bool,
    pub projects: bool,
    pub large_items: bool,
    pub privacy: bool,
    /// Off by default: leftovers detection is heuristic, so it is opt-in.
    pub leftovers: bool,

    pub home: PathBuf,
    /// Extra path prefixes to skip during the deep home walk.
    pub exclude: Vec<PathBuf>,
    /// Regenerable build/dependency directory names the `projects` scan looks for.
    pub project_dir_names: Vec<String>,
    /// Extra folders to inspect for large items, on top of the standard ones.
    pub extra_large_roots: Vec<PathBuf>,

    pub large_min_bytes: u64,
    /// Build/cache dirs smaller than this are ignored, to keep the list signal-heavy.
    pub min_dir_bytes: u64,
    pub downloads_stale_days: u64,
    pub projects_stale_days: u64,

    /// Runtime-only flags set from CLI, never read from or written to TOML.
    #[serde(skip)]
    pub aggressive: bool,
    #[serde(skip)]
    pub prune_volumes: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            system_caches: true,
            app_caches: true,
            dev_tools: true,
            xcode: true,
            projects: true,
            large_items: true,
            privacy: true,
            leftovers: false,
            home: dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
            exclude: Vec::new(),
            project_dir_names: default_project_dir_names(),
            extra_large_roots: Vec::new(),
            large_min_bytes: 500 * 1_000_000,
            min_dir_bytes: 1_000_000,
            downloads_stale_days: 90,
            projects_stale_days: 30,
            aggressive: false,
            prune_volumes: false,
        }
    }
}

fn default_project_dir_names() -> Vec<String> {
    [
        // JS / web
        "node_modules",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".parcel-cache",
        ".angular",
        ".expo",
        ".metro",
        // Rust / Maven
        "target",
        // Python
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        "venv",
        ".venv",
        // JVM / mobile
        ".gradle",
        "Pods",
        ".dart_tool",
        // Misc toolchains
        ".terraform",
        "dist-newstyle",
        ".stack-work",
        "zig-cache",
        ".zig-cache",
        ".swiftpm",
        ".ipynb_checkpoints",
        ".pixi",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Version-manager and toolchain roots under `home` the projects walk must
/// never enter, so a global `node_modules`, `venv`, or build dir living inside
/// one is never mistaken for a project's regenerable junk.
fn default_prune_dirs() -> &'static [&'static str] {
    &[
        ".nvm",
        ".fnm",
        ".volta",
        ".n",
        ".asdf",
        ".rbenv",
        ".pyenv",
        ".rustup",
        ".cargo",
        ".bun",
        ".deno",
        ".gem",
        "go",
        ".local/share/fnm",
        ".local/share/mise",
    ]
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
                cfg.expanded().validated()
            }
            _ => Self::default().validated(),
        }
    }

    /// Guard against a `home` that would turn the deep walk into a whole-disk
    /// rampage — an empty value, the filesystem root, or a non-directory.
    fn validated(self) -> Result<Self> {
        let home = &self.home;
        if home.as_os_str().is_empty() || home == Path::new("/") {
            bail!("refusing to run with home = {:?}: too broad", home);
        }
        if !home.is_dir() {
            bail!("home {:?} is not an existing directory", home);
        }
        Ok(self)
    }

    /// Standard folders scanned for large items, plus any user-provided extras.
    pub fn large_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = ["Downloads", "Desktop", "Documents", "Movies"]
            .iter()
            .map(|d| self.home.join(d))
            .collect();
        roots.extend(self.extra_large_roots.iter().cloned());
        roots
    }

    /// Path prefixes never descended into during the deep home walk. Beyond
    /// `Library` and the trash, this covers version managers and language
    /// toolchains whose global installs sit under `home` — wiping a
    /// `node_modules` inside `~/.nvm/.../lib` would take npm down with it.
    pub fn prune_prefixes(&self) -> Vec<PathBuf> {
        let mut p = vec![self.home.join("Library"), self.home.join(".Trash")];
        p.extend(default_prune_dirs().iter().map(|d| self.home.join(d)));
        p.extend(self.exclude.iter().cloned());
        p
    }

    fn expanded(mut self) -> Self {
        self.home = expand(&self.home);
        self.exclude = self.exclude.iter().map(|p| expand(p)).collect();
        self.extra_large_roots = self.extra_large_roots.iter().map(|p| expand(p)).collect();
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
    fn defaults_enabled_zero_config() {
        let c = Config::default();
        assert!(c.system_caches && c.app_caches && c.dev_tools);
        assert!(c.projects && c.large_items && c.xcode);
        assert!(c.project_dir_names.contains(&"node_modules".to_string()));
        assert!(c.large_min_bytes > 0);
    }

    #[test]
    fn parses_partial_toml() {
        let c: Config = toml::from_str("projects = false\n").unwrap();
        assert!(!c.projects);
        assert!(c.system_caches);
    }

    #[test]
    fn validated_rejects_dangerous_homes() {
        let root = Config {
            home: PathBuf::from("/"),
            ..Default::default()
        };
        assert!(root.validated().is_err());

        let missing = Config {
            home: PathBuf::from("/nonexistent-sweep-home-xyz"),
            ..Default::default()
        };
        assert!(missing.validated().is_err());

        let dir = tempfile::tempdir().unwrap();
        let ok = Config {
            home: dir.path().to_path_buf(),
            ..Default::default()
        };
        assert!(ok.validated().is_ok());
    }

    #[test]
    fn roots_derive_from_home() {
        let c = Config {
            home: PathBuf::from("/tmp/fakehome"),
            ..Default::default()
        };
        assert!(c
            .large_roots()
            .contains(&PathBuf::from("/tmp/fakehome/Downloads")));
        assert!(c
            .prune_prefixes()
            .contains(&PathBuf::from("/tmp/fakehome/Library")));
        assert!(c
            .prune_prefixes()
            .contains(&PathBuf::from("/tmp/fakehome/.nvm")));
        assert!(c
            .prune_prefixes()
            .contains(&PathBuf::from("/tmp/fakehome/.cargo")));
    }
}
