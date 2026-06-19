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
pub mod dev_tools;
pub mod large_items;
pub mod leftovers;
pub mod privacy;
pub mod projects;
pub mod system_caches;
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
        Box::new(leftovers::Leftovers),
    ]
}

/// Walk `roots` and collect removable directories: every directory whose name
/// matches one of `names`, plus, for each `kinds` rule, the generic artifact
/// dirs sitting next to a marker file. The walk never descends into a match,
/// into `.git`, into an unrelated `node_modules`, into a bundle, or into any
/// `prune` prefix. Each hit is flagged stale when its project looks idle.
fn find_dirs(
    roots: &[PathBuf],
    names: &[&str],
    kinds: &[ProjectKind],
    stale: Duration,
    prune: &[PathBuf],
) -> Vec<Finding> {
    let mut found = Vec::new();
    let mut emitted: HashSet<PathBuf> = HashSet::new();

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
            if names.iter().any(|n| *n == name) {
                let p = path.to_path_buf();
                found.push(finding_for(&p, stale));
                emitted.insert(p);
                walker.skip_current_dir();
            } else if name == ".git" || (name == "node_modules" && !names.contains(&"node_modules"))
            {
                walker.skip_current_dir();
            } else if !kinds.is_empty() {
                // Maybe a project root: read its children once and emit any
                // generic artifact dirs vouched for by a marker file.
                emit_marker_artifacts(path, kinds, stale, &mut found, &mut emitted);
            }
        }
    }

    found.sort_by(|a, b| b.size.cmp(&a.size));
    found
}

fn finding_for(path: &Path, stale: Duration) -> Finding {
    let size = fsutil::dir_size(path);
    let ages = stale != Duration::MAX;
    let is_stale = !ages || parent_stale(path, stale);
    let mut finding =
        Finding::dir(path.to_path_buf(), size, CleanAction::RemovePath).stale(is_stale);
    if ages && is_stale {
        finding = finding.with_note(format!("idle > {}d", stale.as_secs() / 86_400));
    }
    finding
}

fn emit_marker_artifacts(
    dir: &Path,
    kinds: &[ProjectKind],
    stale: Duration,
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
            if p.is_dir() && emitted.insert(p.clone()) {
                found.push(finding_for(&p, stale));
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
fn is_bundle(name: &str) -> bool {
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
    ];
    EXTS.iter().any(|ext| name.ends_with(ext))
}

fn parent_named(dir: &Path, name: &str) -> bool {
    dir.parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == name)
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
        fs::create_dir_all(root.path().join("Library/app/target")).unwrap();
        fs::create_dir_all(root.path().join("code/target")).unwrap();

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
}
