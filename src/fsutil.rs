use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use walkdir::WalkDir;

/// Total size of every regular file under `path`, not following symlinks.
pub fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

pub fn remove_path(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).with_context(|| format!("removing {}", path.display()))?;
    } else {
        fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
    }
    Ok(())
}

/// Empty a directory, keeping the directory itself. Best-effort: locked or
/// in-use entries like the `com.apple.Music` cache are skipped instead of
/// aborting the whole operation.
pub fn empty_dir(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        let _ = remove_path(&entry.path());
    }
    Ok(())
}

/// Available bytes on the root volume, parsed from `df -k /`.
pub fn free_space_root() -> Option<u64> {
    let out = crate::exec::capture(&["df".into(), "-k".into(), "/".into()]).ok()?;
    let avail_kb: u64 = out
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()?;
    Some(avail_kb * 1024)
}

#[derive(Debug, Serialize)]
pub struct DirUsage {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Diagnosis {
    pub free_space: Option<u64>,
    pub local_snapshots: Vec<String>,
    pub library_dirs: Vec<DirUsage>,
}

/// Read-only snapshot of where space is going: free space, APFS local
/// snapshots, and the heaviest sub-directories of `~/Library`.
pub fn diagnose() -> Diagnosis {
    let local_snapshots =
        crate::exec::capture(&["tmutil".into(), "listlocalsnapshots".into(), "/".into()])
            .map(|out| {
                out.lines()
                    .filter(|l| l.contains("com.apple"))
                    .map(|l| l.trim().to_string())
                    .collect()
            })
            .unwrap_or_default();

    let mut library_dirs = Vec::new();
    if let Some(lib) = dirs::home_dir().map(|h| h.join("Library")) {
        for sub in [
            "Caches",
            "Containers",
            "Application Support",
            "Group Containers",
            "Developer",
            "Logs",
        ] {
            let dir = lib.join(sub);
            if dir.is_dir() {
                let size = dir_size(&dir);
                if size > 0 {
                    library_dirs.push(DirUsage {
                        path: format!("~/Library/{sub}"),
                        size,
                    });
                }
            }
        }
        library_dirs.sort_by(|a, b| b.size.cmp(&a.size));
    }

    Diagnosis {
        free_space: free_space_root(),
        local_snapshots,
        library_dirs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn size_then_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.txt"), b"world!!").unwrap();

        assert_eq!(dir_size(dir.path()), 5 + 7);

        empty_dir(dir.path()).unwrap();
        assert_eq!(dir_size(dir.path()), 0);
        assert!(dir.path().is_dir());
    }
}
