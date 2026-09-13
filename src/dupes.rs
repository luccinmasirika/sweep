use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use jwalk::WalkDir;
use serde::Serialize;

use crate::inuse::InUse;
use crate::journal;
use crate::targets::is_bundle;
use crate::{fsutil, ui};

/// Files smaller than this are ignored — deduping kilobyte files isn't worth the
/// hashing or the user's attention.
const MIN_DUPE_BYTES: u64 = 1_000_000;

/// `dupes` finds byte-identical files under a path: it groups by size, then
/// confirms matches with a BLAKE3 content hash so different files of equal size
/// are never conflated.
pub fn run(start: Option<PathBuf>, json: bool) -> Result<()> {
    let root = start.unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }

    let spinner = ui::spinner(&ui::pretty_path(&root));
    let sets = find_duplicates(&root);
    spinner.finish_and_clear();

    if json {
        return ui::print_json(&to_json(&sets));
    }
    if sets.is_empty() {
        println!("No duplicates found.");
        return Ok(());
    }

    let reclaimable: u64 = sets.iter().map(|s| s.wasted).sum();
    println!(
        "{} duplicate set(s) · {} reclaimable",
        sets.len(),
        ui::human(reclaimable)
    );
    let trashing = interactive();
    let mut trash = fsutil::TrashLog::default();
    let mut in_use: Option<InUse> = None;
    for set in &sets {
        println!();
        println!(
            "  {} × {}  (keep 1, free {})",
            ui::human(set.size),
            set.paths.len(),
            ui::human(set.wasted)
        );
        for p in &set.paths {
            println!("    {}", ui::pretty_path(p));
        }
        if trashing && ui::confirm("Move all but the first to Trash?")? {
            if in_use.is_none() {
                in_use = Some(InUse::capture()?);
            }
            let in_use = in_use.as_ref().expect("captured above");
            let keeper = &set.paths[0];
            let kept = hash_file(keeper).ok();
            for p in &set.paths[1..] {
                if let Some(reason) = in_use.why(p) {
                    ui::warn(&format!("left {} ({reason})", ui::pretty_path(p)));
                    continue;
                }
                // Either file may have changed since the scan; only an extra
                // that still matches the copy being kept goes.
                if kept.is_none() || hash_file(p).ok() != kept {
                    ui::warn(&format!(
                        "left {} (it no longer matches the copy kept)",
                        ui::pretty_path(p)
                    ));
                    continue;
                }
                match fsutil::remove_path(p, false) {
                    Ok(id) => {
                        if let Some(id) = id {
                            trash.record(id, set.size);
                        }
                        journal::record("trashed", p, set.size, Some("duplicate"));
                        ui::ok(&format!("trashed {}", ui::pretty_path(p)));
                    }
                    Err(e) => ui::warn(&format!("{}: {e}", ui::pretty_path(p))),
                }
            }
        }
    }
    if trashing {
        crate::cli::offer_to_empty(&trash)?;
    }
    Ok(())
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub(crate) struct DupeSet {
    pub size: u64,
    pub paths: Vec<PathBuf>,
    /// What keeping a single copy frees on disk. Copies that are already APFS
    /// clones of each other share their blocks, so trashing one frees little.
    pub wasted: u64,
}

pub(crate) fn find_duplicates(root: &Path) -> Vec<DupeSet> {
    let root_dev = std::fs::symlink_metadata(root).map(|m| m.dev()).ok();
    let skip_library = dirs::home_dir()
        .map(|h| h.join("Library"))
        .filter(|lib| !root.starts_with(lib));
    // Group by size first: only same-size files can be identical, and hashing is
    // the expensive part, so we only hash within a contested size. A file with
    // several links is one file, listed once.
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut seen_inodes = std::collections::HashSet::new();
    let walk = WalkDir::new(root)
        .follow_links(false)
        .skip_hidden(false)
        .process_read_dir(move |_, _, _, children| {
            for child in children.iter_mut().flatten() {
                if !child.file_type().is_dir() {
                    continue;
                }
                let name = child.file_name().to_string_lossy();
                // A library or an app keeps its files in an order only it
                // understands, `.git` its objects, and ~/Library belongs to
                // apps. Another volume isn't this folder's to dedupe.
                let path = child.path();
                let other_volume = root_dev.is_some_and(|dev| {
                    std::fs::symlink_metadata(&path).is_ok_and(|m| m.dev() != dev)
                });
                if is_bundle(&name)
                    || name == ".git"
                    || skip_library.as_deref() == Some(path.as_path())
                    || other_volume
                {
                    child.read_children_path = None;
                }
            }
        });
    for entry in walk {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        // Hashing an evicted iCloud file would download it.
        if !meta.is_file() || meta.len() < MIN_DUPE_BYTES || fsutil::is_dataless(&meta) {
            continue;
        }
        if meta.nlink() > 1 && !seen_inodes.insert((meta.dev(), meta.ino())) {
            continue;
        }
        by_size.entry(meta.len()).or_default().push(path);
    }

    let mut sets = Vec::new();
    for (size, paths) in by_size {
        if paths.len() < 2 {
            continue;
        }
        let mut by_hash: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();
        for path in paths {
            if let Ok(hash) = hash_file(&path) {
                by_hash.entry(hash).or_default().push(path);
            }
        }
        for (_, mut group) in by_hash {
            if group.len() < 2 {
                continue;
            }
            group.sort();
            let wasted =
                fsutil::files_bytes(&group).saturating_sub(fsutil::files_bytes(&group[..1]));
            if wasted >= MIN_DUPE_BYTES {
                sets.push(DupeSet {
                    size,
                    paths: group,
                    wasted,
                });
            }
        }
    }
    sets.sort_by_key(|s| std::cmp::Reverse(s.wasted));
    sets
}

fn hash_file(path: &Path) -> Result<[u8; 32]> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(File::open(path)?)?;
    Ok(*hasher.finalize().as_bytes())
}

#[derive(Serialize)]
struct JsonSet {
    size: u64,
    reclaimable: u64,
    paths: Vec<String>,
}

fn to_json(sets: &[DupeSet]) -> Vec<JsonSet> {
    sets.iter()
        .map(|s| JsonSet {
            size: s.size,
            reclaimable: s.wasted,
            paths: s.paths.iter().map(|p| p.display().to_string()).collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn real_copies_are_found() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.mov"), vec![7u8; 2_000_000]).unwrap();
        fs::write(root.path().join("b.mov"), vec![7u8; 2_000_000]).unwrap();

        let sets = find_duplicates(root.path());

        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].paths.len(), 2);
        assert!(sets[0].wasted >= 2_000_000);
    }

    #[test]
    fn links_clones_and_libraries_are_not_waste() {
        let root = tempfile::tempdir().unwrap();
        // One file under two names frees nothing when a name goes.
        fs::write(root.path().join("a.mov"), vec![7u8; 2_000_000]).unwrap();
        fs::hard_link(root.path().join("a.mov"), root.path().join("a-link.mov")).unwrap();
        // A clone shares every block with its source.
        let cloned = std::process::Command::new("cp")
            .arg("-c")
            .arg(root.path().join("a.mov"))
            .arg(root.path().join("a-clone.mov"))
            .status()
            .is_ok_and(|s| s.success());
        // Inside a library, the app decides what's a copy.
        let lib = root.path().join("Photos Library.photoslibrary/originals");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("x.heic"), vec![9u8; 2_000_000]).unwrap();
        fs::write(lib.join("y.heic"), vec![9u8; 2_000_000]).unwrap();

        let sets = find_duplicates(root.path());

        if cloned {
            assert!(
                sets.is_empty(),
                "{:?}",
                sets.iter().map(|s| &s.paths).collect::<Vec<_>>()
            );
        } else {
            assert!(sets
                .iter()
                .all(|s| !s.paths.iter().any(|p| p.starts_with(&lib))));
        }
    }
}
