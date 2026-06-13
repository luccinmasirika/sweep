use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use walkdir::WalkDir;

use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub mod build_artifacts;
pub mod caches;
pub mod dev_tools;
pub mod large_files;
pub mod node_modules;

pub trait Target {
    fn name(&self) -> &'static str;
    fn enabled(&self, cfg: &Config) -> bool;
    fn scan(&self, cfg: &Config) -> Result<Report>;
}

pub fn all() -> Vec<Box<dyn Target>> {
    vec![
        Box::new(caches::Caches),
        Box::new(dev_tools::DevTools),
        Box::new(large_files::LargeFiles),
        Box::new(node_modules::NodeModules),
        Box::new(build_artifacts::BuildArtifacts),
    ]
}

/// Walk `roots` and collect every directory whose name matches one of `names`,
/// without descending into a match (or into `.git` / unrelated `node_modules`).
/// Each hit becomes a removable finding, flagged stale when its project looks idle.
fn find_dirs(roots: &[PathBuf], names: &[&str], stale: Duration) -> Vec<Finding> {
    let days = stale.as_secs() / 86_400;
    let mut found = Vec::new();

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let mut walker = WalkDir::new(root).into_iter();
        while let Some(entry) = walker.next() {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            if names.iter().any(|n| *n == name) {
                let path = entry.path().to_path_buf();
                let size = fsutil::dir_size(&path);
                let note = parent_stale(&path, stale).then(|| format!("idle > {days}d"));
                found.push(Finding {
                    path,
                    size,
                    note,
                    action: CleanAction::RemovePath,
                });
                walker.skip_current_dir();
            } else if name == ".git" || (name == "node_modules" && !names.contains(&"node_modules"))
            {
                walker.skip_current_dir();
            }
        }
    }

    found.sort_by(|a, b| b.size.cmp(&a.size));
    found
}

fn parent_stale(dir: &Path, age: Duration) -> bool {
    let parent = match dir.parent() {
        Some(p) => p,
        None => return false,
    };
    let modified = match parent.metadata().and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|elapsed| elapsed > age)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_matching_dirs_and_prunes_descent() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("proj");
        fs::create_dir_all(proj.join("target/debug")).unwrap();
        fs::write(proj.join("target/debug/bin"), vec![0u8; 2048]).unwrap();
        fs::create_dir_all(proj.join("src")).unwrap();

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &["target"],
            Duration::from_secs(60 * 86_400),
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("target"));
        assert!(found[0].size >= 2048);
    }
}
