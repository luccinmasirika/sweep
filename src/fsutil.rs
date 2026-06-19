use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use jwalk::WalkDirGeneric;
use serde::Serialize;

/// On-disk size of a single path: the whole subtree for a directory, the file's
/// own blocks otherwise. Symlinks are measured as the link, never followed.
pub fn path_size(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => dir_size(path),
        Ok(m) => m.blocks() * 512,
        Err(_) => 0,
    }
}

/// Bytes actually occupied on disk by every regular file under `path`, walked
/// in parallel and not following symlinks. Counts real `st_blocks` (so sparse
/// files and APFS clones aren't over-reported) and dedups hardlinks by
/// `(device, inode)` so a file linked twice in the tree is counted once.
pub fn dir_size(path: &Path) -> u64 {
    // Per-file state stashed during the parallel walk: (on-disk bytes, dev, ino).
    let walk = WalkDirGeneric::<((), Option<(u64, u64, u64)>)>::new(path)
        .follow_links(false)
        .process_read_dir(|_depth, _path, _state, children| {
            for child in children.iter_mut().flatten() {
                if child.file_type().is_file() {
                    if let Ok(m) = fs::symlink_metadata(child.path()) {
                        child.client_state = Some((m.blocks() * 512, m.dev(), m.ino()));
                    }
                }
            }
        });

    let mut seen = HashSet::new();
    let mut total = 0;
    for entry in walk {
        let Ok(entry) = entry else { continue };
        if let Some((bytes, dev, ino)) = entry.client_state {
            if seen.insert((dev, ino)) {
                total += bytes;
            }
        }
    }
    total
}

/// Install prefixes of language toolchains found on `PATH` (e.g. the Node
/// version nvm has active). Computed once and cached.
fn protected_roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let tools = [
            "node", "npm", "npx", "corepack", "cargo", "rustc", "go", "python3", "ruby", "bun",
            "deno", "pnpm", "yarn",
        ];
        let mut roots = Vec::new();
        for tool in tools {
            // <prefix>/bin/<tool> → canonicalise <prefix>, not the binary, so a
            // symlinked `npm` doesn't resolve us into lib/node_modules.
            if let Some(prefix) = crate::exec::which(tool)
                .and_then(|p| p.parent()?.parent().map(Path::to_path_buf))
                .and_then(|p| p.canonicalize().ok())
            {
                if !roots.contains(&prefix) {
                    roots.push(prefix);
                }
            }
        }
        roots
    })
}

/// True when removing `path` would damage a live toolchain: it is the install
/// prefix or an ancestor of one, or it falls inside a prefix's `bin`/`lib`
/// (the binaries and the global `node_modules`). Regenerable caches deeper in a
/// prefix, like `~/.cargo/registry/cache`, stay removable.
fn is_protected(path: &Path, roots: &[PathBuf]) -> bool {
    let target = path.canonicalize();
    let path = target.as_deref().unwrap_or(path);
    roots.iter().any(|r| {
        r.starts_with(path) || path.starts_with(r.join("bin")) || path.starts_with(r.join("lib"))
    })
}

/// Remove a path. By default it moves to the Trash so a mistake is recoverable
/// with Finder's "Put Back"; `purge` deletes it outright to reclaim space now.
pub fn remove_path(path: &Path, purge: bool) -> Result<()> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if is_protected(path, protected_roots()) {
        bail!(
            "refusing to remove protected toolchain path {}",
            path.display()
        );
    }
    if purge {
        hard_remove(path, &meta)
    } else {
        trash::delete(path).with_context(|| format!("moving {} to Trash", path.display()))
    }
}

/// Unlink a path for real. A symlink is removed as the link itself, never
/// followed into its target.
fn hard_remove(path: &Path, meta: &fs::Metadata) -> Result<()> {
    if meta.is_dir() {
        fs::remove_dir_all(path).with_context(|| format!("removing {}", path.display()))
    } else {
        fs::remove_file(path).with_context(|| format!("removing {}", path.display()))
    }
}

/// Empty a directory, keeping the directory itself. Caches are pure regenerable
/// junk, so entries are hard-deleted rather than sent to the Trash. Best-effort:
/// locked or in-use entries like the `com.apple.Music` cache are skipped, and
/// protected toolchain paths are left untouched, instead of aborting.
pub fn empty_dir(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    let roots = protected_roots();
    for entry in fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if is_protected(&p, roots) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(&p) {
            let _ = hard_remove(&p, &meta);
        }
    }
    Ok(())
}

/// Every Trash this user can empty: the home Trash plus the per-user trash on
/// each mounted volume (`/Volumes/<v>/.Trashes/<uid>`).
pub fn all_trashes() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".Trash"));
    }
    if let Ok(uid) = crate::exec::capture(&["id".into(), "-u".into()]) {
        let uid = uid.trim().to_string();
        if !uid.is_empty() {
            if let Ok(vols) = fs::read_dir("/Volumes") {
                for vol in vols.flatten() {
                    out.push(vol.path().join(".Trashes").join(&uid));
                }
            }
        }
    }
    out.retain(|p| p.is_dir());
    out
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

/// Pull the `YYYY-MM-DD-HHMMSS` token out of a `tmutil listlocalsnapshots`
/// line (e.g. `com.apple.TimeMachine.2024-06-19-120000.local`) so it can be
/// passed to `tmutil deletelocalsnapshots`.
pub fn snapshot_date(line: &str) -> Option<String> {
    line.split('.')
        .find(|tok| {
            tok.starts_with("20")
                && tok.len() == 17
                && tok.chars().all(|c| c.is_ascii_digit() || c == '-')
        })
        .map(str::to_string)
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
        fs::write(dir.path().join("a.bin"), vec![0u8; 200_000]).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.bin"), vec![0u8; 200_000]).unwrap();

        // On-disk size: at least the bytes written, rounded up to whole blocks.
        assert!(dir_size(dir.path()) >= 400_000);

        empty_dir(dir.path()).unwrap();
        assert_eq!(dir_size(dir.path()), 0);
        assert!(dir.path().is_dir());
    }

    #[test]
    fn hardlinks_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.bin");
        fs::write(&original, vec![0u8; 200_000]).unwrap();
        let single = dir_size(dir.path());

        // A second hardlink to the same inode must not double the total.
        fs::hard_link(&original, dir.path().join("clone.bin")).unwrap();
        assert_eq!(dir_size(dir.path()), single);
    }

    #[test]
    fn parses_snapshot_date() {
        assert_eq!(
            snapshot_date("com.apple.TimeMachine.2024-06-19-120000.local").as_deref(),
            Some("2024-06-19-120000")
        );
        assert_eq!(snapshot_date("garbage line").as_deref(), None);
    }

    #[test]
    fn protects_toolchain_and_descendants() {
        let roots = vec![PathBuf::from("/Users/x/.nvm/versions/node/v20")];

        // The exact global node_modules that caused the incident.
        assert!(is_protected(
            Path::new("/Users/x/.nvm/versions/node/v20/lib/node_modules"),
            &roots
        ));
        // An ancestor whose removal would take the toolchain with it.
        assert!(is_protected(Path::new("/Users/x/.nvm"), &roots));
        // Unrelated project deps stay removable.
        assert!(!is_protected(
            Path::new("/Users/x/code/app/node_modules"),
            &roots
        ));

        // A regenerable cache deep in a prefix is still removable.
        let cargo = vec![PathBuf::from("/Users/x/.cargo")];
        assert!(!is_protected(
            Path::new("/Users/x/.cargo/registry/cache/pkg"),
            &cargo
        ));
        assert!(is_protected(Path::new("/Users/x/.cargo/bin"), &cargo));
    }
}
