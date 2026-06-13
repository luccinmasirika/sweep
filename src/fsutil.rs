use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
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

/// Remove the contents of a directory while keeping the directory itself.
pub fn empty_dir(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        remove_path(&entry?.path())?;
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
