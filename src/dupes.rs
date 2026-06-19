use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use jwalk::WalkDir;
use serde::Serialize;

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

    let reclaimable: u64 = sets.iter().map(|s| s.wasted()).sum();
    println!(
        "{} duplicate set(s) · {} reclaimable",
        sets.len(),
        ui::human(reclaimable)
    );
    let trashing = interactive();
    for set in &sets {
        println!();
        println!(
            "  {} × {}  (keep 1, free {})",
            ui::human(set.size),
            set.paths.len(),
            ui::human(set.wasted())
        );
        for p in &set.paths {
            println!("    {}", ui::pretty_path(p));
        }
        if trashing && ui::confirm("Move all but the first to Trash?")? {
            for p in &set.paths[1..] {
                match fsutil::remove_path(p, false) {
                    Ok(()) => ui::ok(&format!("trashed {}", ui::pretty_path(p))),
                    Err(e) => ui::warn(&format!("{}: {e}", ui::pretty_path(p))),
                }
            }
        }
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
}

impl DupeSet {
    /// Space freed by keeping a single copy.
    pub(crate) fn wasted(&self) -> u64 {
        self.size * (self.paths.len() as u64 - 1)
    }
}

pub(crate) fn find_duplicates(root: &Path) -> Vec<DupeSet> {
    // Group by size first: only same-size files can be identical, and hashing is
    // the expensive part, so we only hash within a contested size.
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.is_file() && meta.len() >= MIN_DUPE_BYTES {
                by_size.entry(meta.len()).or_default().push(path);
            }
        }
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
            if group.len() >= 2 {
                group.sort();
                sets.push(DupeSet { size, paths: group });
            }
        }
    }
    sets.sort_by_key(|s| std::cmp::Reverse(s.wasted()));
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
            reclaimable: s.wasted(),
            paths: s.paths.iter().map(|p| p.display().to_string()).collect(),
        })
        .collect()
}
