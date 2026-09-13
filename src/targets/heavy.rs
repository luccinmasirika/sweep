use std::cmp::Reverse;
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;

use super::{app_caches::CACHE_NAMES, is_bundle, Target};
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct Heavy;

/// How far down to descend before sizing a directory in one parallel pass.
/// Deep enough to land on the folder that actually holds the bytes
/// (`~/Developer/<org>/<repo>/<artifact>`), shallow enough to stay quick.
const MAX_DEPTH: usize = 8;

/// A folder shallower than this is too broad to stand for what's inside it:
/// `~/Developer` explains nothing, `~/Developer/org/repo/.migration-staging`
/// explains everything. Weight climbs the tree only down to here.
const MIN_DEPTH: usize = 4;

impl Target for Heavy {
    fn name(&self) -> &'static str {
        "heavy"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.heavy
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut scan = Scan::new(cfg);
        scan.walk(&cfg.home, 0, &cfg.home);

        let mut report = Report::new(self.name());
        report.findings = scan.found;
        report.unreadable = scan.unreadable;
        report.findings.sort_by_key(|a| Reverse(a.size));
        Ok(report)
    }
}

/// Finds the heaviest things on disk without knowing what they are. Every other
/// target recognises a name it was taught; this one just follows the bytes, so a
/// one-off migration staging folder or a tool's recording cache shows up the
/// same as a familiar build dir.
struct Scan<'a> {
    min: u64,
    /// The volume `home` lives on. Anything mounted inside it belongs to
    /// another disk, and a network share there could hang the walk.
    dev: Option<u64>,
    stale_after: Duration,
    /// Names owned by another target: counted towards a parent's weight, never
    /// reported here, so the same gigabytes aren't listed twice.
    covered: HashSet<&'a str>,
    covered_roots: Vec<PathBuf>,
    /// Where the `projects` walk never looks, so a build dir name there is
    /// just a folder name.
    unwalked: Vec<PathBuf>,
    exclude: Vec<PathBuf>,
    home: PathBuf,
    /// Files with more than one link, so each is weighed once.
    linked: HashSet<(u64, u64)>,
    found: Vec<Finding>,
    unreadable: Vec<PathBuf>,
}

/// What one directory contributes to its parent: its weight on disk, how much
/// of that another target already reports, and the one item still looking for
/// the right folder to be named under.
#[derive(Default)]
struct Subtree {
    size: u64,
    owned: u64,
    weight: Option<Weight>,
    /// Something inside was already reported, so an ancestor must not claim
    /// this weight a second time under its own name.
    reported: bool,
}

impl Subtree {
    fn weighed(size: u64, owned: u64, reported: bool, weight: Weight) -> Self {
        Self {
            size,
            owned,
            weight: Some(weight),
            reported,
        }
    }
}

/// A heavy item waiting to be reported, held back until we know whether an
/// ancestor describes it better.
struct Weight {
    /// What to report. Moves up the tree while each parent adds nothing.
    path: PathBuf,
    size: u64,
    /// Where the bytes actually sit, kept so the report can point at it.
    inner: PathBuf,
    stale: bool,
}

/// Above this share of a folder's weight, a single child *is* the folder: there
/// is nothing to learn by naming the child instead, and the parent reads better.
fn dominates(child: u64, total: u64) -> bool {
    child.saturating_mul(10) >= total.saturating_mul(9)
}

/// Folders that hold many unrelated things. They are never one item to delete,
/// so their weight is always attributed to what's inside them.
fn is_bucket(path: &Path, home: &Path) -> bool {
    const BUCKETS: &[&str] = &[
        "Library",
        "Library/Containers",
        "Library/Group Containers",
        "Library/Application Support",
        "Library/Saved Application State",
        "Documents",
        "Desktop",
        "Downloads",
        "Movies",
        "Music",
        "Pictures",
        "Applications",
        ".cache",
        ".config",
        ".local/share",
    ];
    BUCKETS.iter().any(|b| path == home.join(b))
}

impl<'a> Scan<'a> {
    fn new(cfg: &'a Config) -> Self {
        let mut covered: HashSet<&str> = cfg.project_dir_names.iter().map(String::as_str).collect();
        covered.extend(CACHE_NAMES);
        Self {
            min: cfg.heavy_min_bytes,
            dev: fs::symlink_metadata(&cfg.home).map(|m| m.dev()).ok(),
            stale_after: Duration::from_secs(cfg.downloads_stale_days * 86_400),
            covered,
            covered_roots: crate::catalog::covered_roots(&cfg.home),
            unwalked: cfg.prune_prefixes(),
            exclude: cfg.exclude.clone(),
            home: cfg.home.clone(),
            linked: HashSet::new(),
            found: Vec::new(),
            unreadable: Vec::new(),
        }
    }

    /// Size of everything under `dir`, reporting the folder that best describes
    /// each heavy item: deep enough to be specific, but not so deep that a lone
    /// chain of single-child folders buries the name that means something.
    fn walk(&mut self, dir: &Path, depth: usize, home: &Path) -> Subtree {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    self.unreadable.push(dir.to_path_buf());
                }
                return Subtree::default();
            }
        };
        let mut total = 0;
        let mut owned_elsewhere = 0;
        let mut reported = false;
        let mut heavy: Vec<Weight> = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            // lstat: never follow a symlink out of the tree, and never touch an
            // evicted iCloud file just to size it.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() || fsutil::is_dataless(&meta) {
                continue;
            }

            if meta.is_file() {
                if meta.nlink() > 1 && !self.linked.insert((meta.dev(), meta.ino())) {
                    continue;
                }
                let size = meta.blocks() * 512;
                total += size;
                if size >= self.min {
                    heavy.push(self.weigh(path, size, &meta));
                }
                continue;
            }
            if !meta.is_dir() || self.dev.is_some_and(|dev| dev != meta.dev()) {
                continue;
            }

            let name = entry.file_name().to_string_lossy().into_owned();
            // What another target lists weighs on its parents without being
            // named here.
            if self.is_covered(&path, &name, depth) {
                let size = fsutil::dir_size(&path);
                total += size;
                owned_elsewhere += size;
                continue;
            }
            // So does what nobody should be offered to delete.
            if fsutil::app_managed(&path, &self.home).is_some() || self.is_synced(&path) {
                let usage = fsutil::dir_usage(&path);
                if usage.unreadable {
                    self.unreadable.push(path.clone());
                }
                total += usage.bytes;
                owned_elsewhere += usage.bytes;
                continue;
            }

            // A bundle is one item to the user even though it is a directory,
            // and so is anything past the depth cap: size it in one pass.
            let size = if is_bundle(&name) || depth + 1 >= MAX_DEPTH {
                let usage = fsutil::dir_usage(&path);
                if usage.unreadable {
                    self.unreadable.push(path.clone());
                }
                let size = usage.bytes;
                if size >= self.min {
                    heavy.push(self.weigh(path, size, &meta));
                }
                size
            } else {
                let sub = self.walk(&path, depth + 1, home);
                if let Some(w) = sub.weight {
                    heavy.push(w);
                }
                owned_elsewhere += sub.owned;
                reported |= sub.reported;
                sub.size
            };
            total += size;
        }

        // A folder right under home — `~/Developer`, `~/Projects` — is where a
        // person keeps many things, never one thing to throw away.
        if depth > 1 && !is_bucket(dir, home) {
            // Nothing heavy inside, but the folder itself is heavy: it is the
            // item, as long as the weight isn't really a build dir we skipped.
            if !reported && heavy.is_empty() && total.saturating_sub(owned_elsewhere) >= self.min {
                let w = self.weigh_dir(dir, total);
                return Subtree::weighed(total, owned_elsewhere, reported, w);
            }
            // One child carries essentially all of it, so naming the child adds
            // nothing: report this folder instead — `…/.migration-staging`
            // rather than `…/.migration-staging/org/bol/models/production`.
            if depth >= MIN_DEPTH && heavy.len() == 1 && dominates(heavy[0].size, total) {
                let inner = heavy.pop().expect("one heavy child").inner;
                let mut w = self.weigh_dir(dir, total);
                w.inner = inner;
                return Subtree::weighed(total, owned_elsewhere, reported, w);
            }
        }

        reported |= !heavy.is_empty();
        for w in heavy {
            self.push(w);
        }
        Subtree {
            size: total,
            owned: owned_elsewhere,
            weight: None,
            reported,
        }
    }

    /// Whether another target already reports `path`: one of its exact paths,
    /// or a build or cache folder where that target would find it. A folder
    /// named `target` it wouldn't take is only a folder, and stays visible.
    fn is_covered(&self, path: &Path, name: &str, depth: usize) -> bool {
        if self.covered_roots.iter().any(|r| path == r)
            || self.exclude.iter().any(|e| path.starts_with(e))
        {
            return true;
        }
        if !self.covered.contains(name) || depth == 0 {
            return false;
        }
        if CACHE_NAMES.contains(&name) {
            let lib = self.home.join("Library");
            return [lib.join("Application Support"), lib.join("Containers")]
                .iter()
                .any(|root| path.starts_with(root) && path.parent() != Some(root.as_path()));
        }
        !self.unwalked.iter().any(|p| path.starts_with(p)) && super::vouched(path, name)
    }

    /// Anything under iCloud Drive or a cloud provider: deleting it there
    /// deletes it everywhere, which is not reclaiming space.
    fn is_synced(&self, path: &Path) -> bool {
        ["Library/Mobile Documents", "Library/CloudStorage"]
            .iter()
            .any(|r| path.starts_with(self.home.join(r)))
    }

    fn weigh(&self, path: PathBuf, size: u64, meta: &fs::Metadata) -> Weight {
        Weight {
            inner: path.clone(),
            path,
            size,
            stale: older_than(meta, self.stale_after),
        }
    }

    fn weigh_dir(&self, dir: &Path, size: u64) -> Weight {
        let stale = fs::symlink_metadata(dir).is_ok_and(|m| older_than(&m, self.stale_after));
        Weight {
            path: dir.to_path_buf(),
            size,
            inner: dir.to_path_buf(),
            stale,
        }
    }

    fn push(&mut self, w: Weight) {
        let mut notes = Vec::new();
        if let Some(inner) = describe_inner(&w) {
            notes.push(format!("mostly {inner}"));
        }
        if w.stale {
            notes.push(format!(
                "untouched > {}d",
                self.stale_after.as_secs() / 86_400
            ));
        }
        // Nothing here is recognised, so nothing here is safe to delete blind:
        // these start unticked and `--yes` never touches them.
        let mut finding = Finding::dir(w.path, w.size, CleanAction::RemovePath).risky(true);
        if !notes.is_empty() {
            finding = finding.with_note(notes.join(", "));
        }
        self.found.push(finding);
    }
}

/// Where inside a reported folder the weight sits, as the first couple of path
/// components below it. `None` when the folder is the item itself.
fn describe_inner(w: &Weight) -> Option<String> {
    let rest = w.inner.strip_prefix(&w.path).ok()?;
    let mut parts = rest.iter().map(|p| p.to_string_lossy());
    let head = parts.next()?.into_owned();
    let second = parts.next();
    Some(match (second, parts.next()) {
        (Some(s), Some(_)) => format!("{head}/{s}/…"),
        (Some(s), None) => format!("{head}/{s}"),
        _ => head,
    })
}

fn older_than(meta: &fs::Metadata, age: Duration) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|elapsed| elapsed > age)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_for(home: &Path, min: u64) -> Config {
        Config {
            home: home.to_path_buf(),
            heavy_min_bytes: min,
            ..Default::default()
        }
    }

    fn scan(home: &Path, min: u64) -> Vec<Finding> {
        Heavy.scan(&cfg_for(home, min)).unwrap().findings
    }

    #[test]
    fn reports_the_folder_that_holds_the_bytes() {
        let home = tempfile::tempdir().unwrap();
        // The shape that started this: an unrecognised staging folder buried a
        // few levels down, with nothing individually large inside it.
        let staging = home.path().join("Developer/org/repo/.migration-staging");
        fs::create_dir_all(&staging).unwrap();
        for i in 0..4 {
            fs::write(staging.join(format!("part-{i}")), vec![0u8; 40_000]).unwrap();
        }

        let found = scan(home.path(), 100_000);

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with(".migration-staging"));
        assert!(found[0].risky);
        // Never the parents that merely contain it.
        assert!(!found.iter().any(|f| f.path.ends_with("repo")));
    }

    #[test]
    fn a_single_big_file_is_named_not_its_folder() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("Library/Application Support/Editor");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.db"), vec![0u8; 200_000]).unwrap();

        let found = scan(home.path(), 100_000);

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("state.db"));
    }

    #[test]
    fn skips_what_another_target_already_owns() {
        let home = tempfile::tempdir().unwrap();
        let deps = home.path().join("code/app/node_modules");
        fs::create_dir_all(&deps).unwrap();
        fs::write(deps.join("blob"), vec![0u8; 200_000]).unwrap();

        // The deps dir belongs to `projects`, and `app` is only heavy because
        // of it — neither should show up here.
        assert!(scan(home.path(), 100_000).is_empty());
    }

    #[test]
    fn a_bundle_is_one_item() {
        let home = tempfile::tempdir().unwrap();
        let resources = home.path().join("Tools/Renderer.app/Contents/Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(resources.join("model.bin"), vec![0u8; 200_000]).unwrap();

        let found = scan(home.path(), 100_000);

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("Renderer.app"));
    }

    #[test]
    fn irreplaceable_data_is_never_offered() {
        let home = tempfile::tempdir().unwrap();
        for dir in [
            "Pictures/Photos Library.photoslibrary/originals",
            "Library/Messages/Attachments",
            "Library/Mobile Documents/com~apple~CloudDocs/Film",
        ] {
            let dir = home.path().join(dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("data"), vec![0u8; 200_000]).unwrap();
        }
        // Many small repos: heavy together, but nothing to delete as one.
        for repo in ["a", "b", "c"] {
            let src = home.path().join("Developer").join(repo);
            fs::create_dir_all(&src).unwrap();
            fs::write(src.join("main.rs"), vec![0u8; 40_000]).unwrap();
        }

        assert!(scan(home.path(), 100_000).is_empty());
    }

    #[test]
    fn hard_links_weigh_once() {
        let home = tempfile::tempdir().unwrap();
        let store = home.path().join("Library/Application Support/Chat/media");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("a"), vec![0u8; 60_000]).unwrap();
        fs::hard_link(store.join("a"), store.join("b")).unwrap();

        // 60 KB once, not 120 KB twice.
        assert!(scan(home.path(), 100_000).is_empty());
    }

    #[test]
    fn a_folder_named_like_build_output_is_still_weighed() {
        let home = tempfile::tempdir().unwrap();
        // No Cargo.toml: `projects` won't take it, so it mustn't vanish here.
        let target = home.path().join("Documents/Marketing/target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("campaign.mov"), vec![0u8; 200_000]).unwrap();

        let found = scan(home.path(), 100_000);

        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(&target));
    }

    #[test]
    fn climbs_out_of_a_single_child_chain() {
        let home = tempfile::tempdir().unwrap();
        // All the weight sits six levels down a chain nobody would recognise;
        // the staging folder at the top of it is the name worth reporting.
        let deep = home
            .path()
            .join("Developer/org/repo/.migration-staging/svc/bucket/models/live");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("blob"), vec![0u8; 200_000]).unwrap();

        let found = scan(home.path(), 100_000);

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with(".migration-staging"));
        // …while still saying where inside the bytes are.
        assert_eq!(found[0].note.as_deref(), Some("mostly svc/bucket/…"));
    }

    #[test]
    fn a_shared_folder_is_split_not_claimed_whole() {
        let home = tempfile::tempdir().unwrap();
        for app in ["Recorder", "Player"] {
            let dir = home.path().join("Library/Group Containers").join(app);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("data"), vec![0u8; 200_000]).unwrap();
        }

        let found = scan(home.path(), 100_000);

        // Two apps reported separately; never the shared folder above them.
        assert_eq!(found.len(), 2);
        assert!(!found.iter().any(|f| f.path.ends_with("Group Containers")));
    }

    #[test]
    fn a_refused_folder_is_listed_not_ignored() {
        let home = tempfile::tempdir().unwrap();
        let mail = home.path().join("Library/Mail");
        fs::create_dir_all(&mail).unwrap();
        fs::write(mail.join("inbox.mbox"), vec![0u8; 200_000]).unwrap();
        let Some(_lock) = crate::fsutil::tests::Locked::new(&mail) else {
            return;
        };

        let report = Heavy.scan(&cfg_for(home.path(), 100_000)).unwrap();

        assert!(report.findings.is_empty());
        assert_eq!(report.unreadable, vec![mail.clone()]);
    }

    #[test]
    fn small_stuff_stays_out() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("Documents")).unwrap();
        fs::write(home.path().join("Documents/notes.txt"), vec![0u8; 1024]).unwrap();

        assert!(scan(home.path(), 100_000).is_empty());
    }
}
