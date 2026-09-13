use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use walkdir::WalkDir;

use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

/// A project type whose build output lives in a *generically named* directory
/// (`build`, `bin`, `vendor`…) that is only safe to remove when a marker file
/// proves the parent is that kind of project. Unambiguous dirs (`node_modules`,
/// `.dart_tool`, …) are matched by name instead and never need a marker.
pub struct ProjectKind {
    pub markers: &'static [&'static str],
    pub artifacts: &'static [&'static str],
}

/// Marker → generic-artifact rules. Each is distinctive enough that the artifact
/// is unmistakably regenerable build output, not a user's folder.
const MARKER_KINDS: &[ProjectKind] = &[
    ProjectKind {
        markers: &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
        artifacts: &["build"],
    },
    ProjectKind {
        markers: &["*.csproj", "*.fsproj", "*.sln"],
        artifacts: &["bin", "obj"],
    },
    ProjectKind {
        markers: &["composer.json"],
        artifacts: &["vendor"],
    },
    ProjectKind {
        markers: &["CMakeLists.txt"],
        artifacts: &["build", "cmake-build-debug", "cmake-build-release"],
    },
];

pub mod app_caches;
pub mod applications;
pub mod dev_tools;
pub mod heavy;
pub mod large_items;
pub mod leftovers;
pub mod privacy;
pub mod projects;
pub mod system_caches;
pub mod vm_images;
pub mod xcode;

pub trait Target {
    fn name(&self) -> &'static str;
    fn enabled(&self, cfg: &Config) -> bool;
    fn scan(&self, cfg: &Config) -> Result<Report>;
}

pub fn all() -> Vec<Box<dyn Target + Send + Sync>> {
    vec![
        Box::new(system_caches::SystemCaches),
        Box::new(app_caches::AppCaches),
        Box::new(dev_tools::DevTools),
        Box::new(xcode::Xcode),
        Box::new(privacy::Privacy),
        Box::new(projects::Projects),
        Box::new(large_items::LargeItems),
        Box::new(vm_images::VmImages),
        Box::new(applications::Applications),
        Box::new(heavy::Heavy),
        Box::new(leftovers::Leftovers),
    ]
}

/// Names common enough to be somebody's own folder. They count as build output
/// only next to the file that makes them so: `~/Documents/Marketing/target` is
/// a campaign, `app/target` beside a `Cargo.toml` is a Rust build.
const VOUCHED_BY: &[(&str, &[&str])] = &[
    ("target", &["Cargo.toml", "pom.xml", "build.sbt"]),
    ("Pods", &["Podfile"]),
    (".swiftpm", &["Package.swift"]),
    (
        ".gradle",
        &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            "gradlew",
        ],
    ),
    (".expo", &["package.json", "app.json"]),
    (".metro", &["package.json"]),
    (".pixi", &["pixi.toml", "pyproject.toml"]),
    (".terraform", &["*.tf"]),
];

/// Whether a directory named `name` is what its name says. A virtualenv proves
/// itself with its own `pyvenv.cfg`; the generic names above need their marker
/// next to them; everything else is distinctive enough on its own.
fn vouched(dir: &Path, name: &str) -> bool {
    if name == "venv" || name == ".venv" {
        return dir.join("pyvenv.cfg").is_file();
    }
    let Some((_, markers)) = VOUCHED_BY.iter().find(|(n, _)| *n == name) else {
        return true;
    };
    let Some(siblings) = dir.parent().and_then(|p| std::fs::read_dir(p).ok()) else {
        return false;
    };
    let siblings: HashSet<String> = siblings
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    markers.iter().any(|m| has_marker(&siblings, m))
}

/// Walk `roots` and collect removable directories: every directory whose name
/// matches one of `names`, plus, for each `kinds` rule, the generic artifact
/// dirs sitting next to a marker file. The walk never descends into a match,
/// into `.git`, into an unrelated `node_modules`, into a bundle, or into any
/// `prune` prefix. Each hit is flagged stale when its project looks idle.
///
/// A root's direct children are never matches — `~/.gradle` is Gradle's own
/// home, not a project's — and neither is anything git tracks: a committed
/// `vendor` or `Pods` is source, not something a rebuild brings back.
fn find_dirs(
    roots: &[PathBuf],
    names: &[&str],
    kinds: &[ProjectKind],
    stale: Duration,
    prune: &[PathBuf],
) -> Vec<Finding> {
    let mut found = Vec::new();
    let mut emitted: HashSet<PathBuf> = HashSet::new();
    let mut activity = Activity::new(names, kinds);

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // Stay on the root's volume: a network share mounted under it could
        // hang the walk, and its contents aren't this disk's to clean.
        let mut walker = WalkDir::new(root).same_file_system(true).into_iter();
        while let Some(entry) = walker.next() {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_dir() {
                continue;
            }
            let path = entry.path();
            if prune.iter().any(|p| path.starts_with(p)) || emitted.contains(path) {
                walker.skip_current_dir();
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            if is_bundle(&name) {
                // App/library bundles are opaque directories: an Electron `.app`
                // carries its own `node_modules`, a `.photoslibrary` its data.
                // Descending in would mangle them.
                walker.skip_current_dir();
                continue;
            }
            if name == "node_modules" && parent_named(path, "lib") {
                // A global toolchain install lives at `<prefix>/lib/node_modules`
                // (npm, npx, every `-g` package). Never a project's deps.
                walker.skip_current_dir();
                continue;
            }
            if names.iter().any(|n| *n == name) && entry.depth() > 1 && vouched(path, &name) {
                let p = path.to_path_buf();
                if !tracked_by_git(&p, root) {
                    found.push(finding_for(&p, stale, &mut activity, root));
                }
                emitted.insert(p);
                walker.skip_current_dir();
            } else if name == ".git" || (name == "node_modules" && !names.contains(&"node_modules"))
            {
                walker.skip_current_dir();
            } else if !kinds.is_empty() {
                // Maybe a project root: read its children once and emit any
                // generic artifact dirs vouched for by a marker file.
                emit_marker_artifacts(
                    path,
                    root,
                    kinds,
                    stale,
                    &mut activity,
                    &mut found,
                    &mut emitted,
                );
            }
        }
    }

    found.sort_by_key(|a| Reverse(a.size));
    found
}

fn finding_for(path: &Path, stale: Duration, activity: &mut Activity, root: &Path) -> Finding {
    let usage = fsutil::dir_usage(path);
    let ages = stale != Duration::MAX;
    let is_stale = !ages || activity.idle(path, stale, root);
    let mut finding = Finding::dir(path.to_path_buf(), usage.bytes, CleanAction::RemovePath)
        .stale(is_stale)
        .unreadable(usage.unreadable);
    if ages && is_stale {
        finding = finding.with_note(format!("idle > {}d", stale.as_secs() / 86_400));
    }
    finding
}

fn emit_marker_artifacts(
    dir: &Path,
    root: &Path,
    kinds: &[ProjectKind],
    stale: Duration,
    activity: &mut Activity,
    found: &mut Vec<Finding>,
    emitted: &mut HashSet<PathBuf>,
) {
    let children: HashSet<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return,
    };
    for kind in kinds {
        if !kind.markers.iter().any(|m| has_marker(&children, m)) {
            continue;
        }
        for art in kind.artifacts {
            if !children.contains(*art) {
                continue;
            }
            let p = dir.join(art);
            if p.is_dir() && emitted.insert(p.clone()) && !tracked_by_git(&p, root) {
                found.push(finding_for(&p, stale, activity, root));
            }
        }
    }
}

/// `*.ext` matches any child with that extension; otherwise an exact filename.
fn has_marker(children: &HashSet<String>, marker: &str) -> bool {
    match marker.strip_prefix('*') {
        Some(suffix) => children.iter().any(|c| c.ends_with(suffix)),
        None => children.contains(marker),
    }
}

/// macOS bundles look like a single document in Finder but are directories the
/// owning app must manage; a cleanup walk should treat them as opaque.
pub(crate) fn is_bundle(name: &str) -> bool {
    const EXTS: &[&str] = &[
        ".app",
        ".photoslibrary",
        ".framework",
        ".bundle",
        ".kext",
        ".plugin",
        ".xcodeproj",
        ".xcworkspace",
        ".playground",
        ".musiclibrary",
        ".tvlibrary",
        ".aplibrary",
        ".fcpbundle",
        ".imovielibrary",
        ".logicx",
        ".band",
        ".lrlibrary",
        ".sparsebundle",
        ".xcarchive",
        ".dSYM",
        ".mlpackage",
        ".pages",
        ".numbers",
        ".key",
        ".rtfd",
        ".docarchive",
    ];
    EXTS.iter().any(|ext| name.ends_with(ext))
}

fn parent_named(dir: &Path, name: &str) -> bool {
    dir.parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == name)
}

/// The repository `path` sits in, looking no higher than `root`.
fn git_root(path: &Path, root: &Path) -> Option<PathBuf> {
    path.ancestors()
        .skip(1)
        .take_while(|dir| dir.starts_with(root))
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

/// Whether git tracks anything inside `path`. Build output is ignored; a
/// folder with committed files in it is part of the project.
fn tracked_by_git(path: &Path, root: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    if git_root(path, root).is_none() {
        return false;
    }
    let args = [
        "git".into(),
        "-C".into(),
        parent.to_string_lossy().into_owned(),
        "ls-files".into(),
        "--".into(),
        name.to_string_lossy().into_owned(),
    ];
    crate::exec::capture(&args).is_ok_and(|out| !out.trim().is_empty())
}

/// How many entries of a project to look at before settling on its last
/// change. Enough for the sources of any project; a checkout the size of a
/// monorepo is still judged by its git activity.
const ACTIVITY_ENTRIES: usize = 20_000;

/// Works out when a project was last worked on. A folder's own mtime only moves
/// when entries are added or removed right inside it — editing `src/main.ts`
/// doesn't touch it, and the Finder dropping a `.DS_Store` does — so it's the
/// newest change among the project's own files, and its repository's last
/// commit, checkout or staging, that count.
struct Activity {
    /// Build output never counts as work: rebuilding it isn't editing.
    skip: HashSet<String>,
    repos: std::collections::HashMap<PathBuf, Option<SystemTime>>,
}

impl Activity {
    fn new(names: &[&str], kinds: &[ProjectKind]) -> Self {
        let mut skip: HashSet<String> = names.iter().map(|n| n.to_string()).collect();
        skip.extend(
            kinds
                .iter()
                .flat_map(|k| k.artifacts)
                .map(|a| a.to_string()),
        );
        skip.extend([".git", ".DS_Store"].map(String::from));
        Self {
            skip,
            repos: Default::default(),
        }
    }

    /// Whether nothing in the project around `artifact` changed within `age`.
    fn idle(&mut self, artifact: &Path, age: Duration, root: &Path) -> bool {
        let Some(project) = artifact.parent() else {
            return false;
        };
        let mut newest = newest_change(project, &self.skip);
        if let Some(repo) = git_root(artifact, root) {
            let last = *self
                .repos
                .entry(repo.clone())
                .or_insert_with(|| repo_activity(&repo));
            newest = newest.max(last);
        }
        newest.is_some_and(|t| {
            SystemTime::now()
                .duration_since(t)
                .is_ok_and(|elapsed| elapsed > age)
        })
    }
}

/// The latest modification among a project's files and folders, build output
/// and bundles left out.
fn newest_change(project: &Path, skip: &HashSet<String>) -> Option<SystemTime> {
    WalkDir::new(project)
        .max_depth(4)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(skip.contains(name.as_ref()) || is_bundle(&name))
        })
        .flatten()
        .take(ACTIVITY_ENTRIES)
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
}

/// When the repository last moved: a commit, checkout or reset (`logs/HEAD`),
/// a branch switch (`HEAD`), or staging (`index`).
fn repo_activity(repo: &Path) -> Option<SystemTime> {
    let git = repo.join(".git");
    ["index", "HEAD", "logs/HEAD"]
        .iter()
        .filter_map(|f| git.join(f).metadata().ok()?.modified().ok())
        .max()
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
        fs::write(proj.join("Cargo.toml"), b"").unwrap();

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &["target"],
            &[],
            Duration::from_secs(60 * 86_400),
            &[],
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("target"));
        assert!(found[0].size >= 2048);
    }

    #[test]
    fn skips_global_node_modules_under_lib() {
        let root = tempfile::tempdir().unwrap();
        // Global install layout: <prefix>/lib/node_modules
        fs::create_dir_all(root.path().join("v20/lib/node_modules/npm")).unwrap();
        // A real project dependency dir
        fs::create_dir_all(root.path().join("proj/node_modules/pkg")).unwrap();
        fs::write(
            root.path().join("proj/node_modules/pkg/index.js"),
            vec![0u8; 2048],
        )
        .unwrap();

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &["node_modules"],
            &[],
            Duration::from_secs(60 * 86_400),
            &[],
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(root.path().join("proj")));
    }

    #[test]
    fn skips_node_modules_inside_a_bundle() {
        let root = tempfile::tempdir().unwrap();
        // An Electron app carries its own node_modules; never touch it.
        fs::create_dir_all(
            root.path()
                .join("MyApp.app/Contents/Resources/node_modules"),
        )
        .unwrap();
        fs::create_dir_all(root.path().join("proj/node_modules")).unwrap();
        fs::write(root.path().join("proj/node_modules/blob"), vec![0u8; 4096]).unwrap();

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &["node_modules"],
            &[],
            Duration::from_secs(60 * 86_400),
            &[],
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(root.path().join("proj")));
    }

    #[test]
    fn fresh_project_is_not_stale_but_caches_always_are() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("proj/node_modules")).unwrap();
        fs::write(root.path().join("proj/node_modules/blob"), vec![0u8; 4096]).unwrap();

        // A just-created project reads as active.
        let aged = find_dirs(
            &[root.path().to_path_buf()],
            &["node_modules"],
            &[],
            Duration::from_secs(30 * 86_400),
            &[],
        );
        assert_eq!(aged.len(), 1);
        assert!(!aged[0].stale);

        // Caches (Duration::MAX) never age out — always eligible.
        let caches = find_dirs(
            &[root.path().to_path_buf()],
            &["node_modules"],
            &[],
            Duration::MAX,
            &[],
        );
        assert!(caches[0].stale);
    }

    #[test]
    fn marker_gates_generic_artifact_dirs() {
        let root = tempfile::tempdir().unwrap();
        // A Gradle project: `build` next to a marker → removable.
        let gradle = root.path().join("app");
        fs::create_dir_all(gradle.join("build")).unwrap();
        fs::write(gradle.join("build/out"), vec![0u8; 4096]).unwrap();
        fs::write(gradle.join("build.gradle"), b"").unwrap();
        // A plain folder that merely happens to contain `build` → left alone.
        fs::create_dir_all(root.path().join("notes/build")).unwrap();
        fs::write(root.path().join("notes/build/data"), vec![0u8; 4096]).unwrap();

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &[],
            MARKER_KINDS,
            Duration::from_secs(60 * 86_400),
            &[],
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(gradle.join("build")));
    }

    #[test]
    fn prune_prefix_skips_subtree() {
        let root = tempfile::tempdir().unwrap();
        for proj in ["Library/app", "code"] {
            fs::create_dir_all(root.path().join(proj).join("target")).unwrap();
            fs::write(root.path().join(proj).join("Cargo.toml"), b"").unwrap();
        }

        let found = find_dirs(
            &[root.path().to_path_buf()],
            &["target"],
            &[],
            Duration::from_secs(60 * 86_400),
            &[root.path().join("Library")],
        );

        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(root.path().join("code")));
    }

    fn age(path: &Path, days: u64) {
        let when = SystemTime::now() - Duration::from_secs(days * 86_400);
        for entry in WalkDir::new(path) {
            let entry = entry.unwrap();
            fs::File::open(entry.path())
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
    }

    fn find(root: &Path, names: &[&str]) -> Vec<Finding> {
        find_dirs(
            &[root.to_path_buf()],
            names,
            MARKER_KINDS,
            Duration::from_secs(30 * 86_400),
            &[],
        )
    }

    #[test]
    fn a_generic_name_needs_the_project_that_makes_it_build_output() {
        let root = tempfile::tempdir().unwrap();
        let campaign = root.path().join("Documents/Marketing/target");
        fs::create_dir_all(&campaign).unwrap();
        fs::write(campaign.join("audience-research.key"), vec![0u8; 4096]).unwrap();
        let notes = root.path().join("Documents/python/venv");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("ideas.txt"), vec![0u8; 4096]).unwrap();

        let rust = root.path().join("code/app");
        fs::create_dir_all(rust.join("target")).unwrap();
        fs::write(rust.join("Cargo.toml"), b"").unwrap();
        let venv = root.path().join("code/tool/.venv");
        fs::create_dir_all(&venv).unwrap();
        fs::write(venv.join("pyvenv.cfg"), b"home = /usr/bin").unwrap();

        let mut found: Vec<PathBuf> = find(root.path(), &["target", "venv", ".venv"])
            .into_iter()
            .map(|f| f.path)
            .collect();
        found.sort();

        assert_eq!(found, vec![rust.join("target"), venv]);
    }

    #[test]
    fn a_tool_home_right_under_the_root_is_not_a_project() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".expo")).unwrap();
        fs::write(root.path().join("package.json"), b"{}").unwrap();

        assert!(find(root.path(), &[".expo"]).is_empty());
    }

    #[test]
    fn what_git_tracks_is_source_not_build_output() {
        if !crate::exec::command_exists("git") {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("code/site");
        fs::create_dir_all(proj.join("vendor/lib")).unwrap();
        fs::write(proj.join("vendor/lib/patched.php"), b"<?php").unwrap();
        fs::write(proj.join("composer.json"), b"{}").unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&proj)
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&["add", "vendor", "composer.json"]);

        assert!(find(root.path(), &[]).is_empty());
    }

    #[test]
    fn editing_a_file_deep_inside_keeps_a_project_active() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("code/app");
        fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        fs::write(proj.join("node_modules/pkg/index.js"), vec![0u8; 4096]).unwrap();
        fs::create_dir_all(proj.join("src/routes")).unwrap();
        fs::write(proj.join("src/routes/home.ts"), b"export {}").unwrap();
        fs::write(proj.join("package.json"), b"{}").unwrap();
        age(root.path(), 90);

        let idle = find(root.path(), &["node_modules"]);
        assert!(idle[0].stale, "untouched for 90 days");

        // Saved today: the folders around it keep their old dates, the project
        // is still in use.
        fs::write(proj.join("src/routes/home.ts"), b"export const x = 1").unwrap();
        let active = find(root.path(), &["node_modules"]);
        assert!(!active[0].stale);
        assert!(!active[0].auto());
    }
}
