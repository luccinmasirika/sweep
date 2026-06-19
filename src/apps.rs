use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::exec;

/// `~/Library` sub-folders where apps stash per-bundle-id data.
pub const SUPPORT_DIRS: &[&str] = &[
    "Library/Application Support",
    "Library/Caches",
    "Library/Preferences",
    "Library/Containers",
    "Library/Group Containers",
    "Library/Saved Application State",
    "Library/HTTPStorages",
    "Library/Logs",
];

/// An installed application bundle and its identity.
pub struct App {
    pub path: PathBuf,
    pub id: String,
    pub name: String,
}

/// Every `.app` under the standard application folders, with its bundle id.
pub fn installed_apps() -> Vec<App> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut apps = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        collect_apps(&root, &mut apps, &mut seen, 0);
    }
    apps
}

/// Just the bundle ids of installed apps — what `leftovers` needs.
pub fn installed_ids() -> HashSet<String> {
    installed_apps().into_iter().map(|a| a.id).collect()
}

fn collect_apps(dir: &Path, apps: &mut Vec<App>, seen: &mut HashSet<PathBuf>, depth: u32) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".app") {
            if let Some(id) = bundle_id(&path) {
                if seen.insert(path.clone()) {
                    apps.push(App {
                        name: name.trim_end_matches(".app").to_string(),
                        id,
                        path,
                    });
                }
            }
        } else if path.is_dir() {
            collect_apps(&path, apps, seen, depth + 1);
        }
    }
}

/// Read `CFBundleIdentifier` (lowercased). `defaults read` handles binary plists.
pub fn bundle_id(app: &Path) -> Option<String> {
    let info = app.join("Contents/Info");
    let out = exec::capture(&[
        "defaults".into(),
        "read".into(),
        info.to_string_lossy().into_owned(),
        "CFBundleIdentifier".into(),
    ])
    .ok()?;
    let id = out.trim().to_ascii_lowercase();
    (!id.is_empty()).then_some(id)
}

/// Pull a reverse-DNS bundle id out of a support-folder entry name, dropping the
/// suffixes Apple appends (`com.foo.bar.plist`, `com.foo.bar.savedState`) and any
/// 10-char team-id prefix on group containers. Only entries that really look like
/// a bundle id (≥ 2 dots) qualify, so generic folders are never mistaken for one.
pub fn candidate_id(name: &str) -> Option<String> {
    let base = name
        .trim_end_matches(".plist")
        .trim_end_matches(".savedState")
        .trim_end_matches(".binarycookies");
    let base = strip_team_prefix(base);
    let base = base.strip_prefix("group.").unwrap_or(base);
    let dotted = base.matches('.').count() >= 2;
    let clean = base
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    (dotted && clean).then(|| base.to_ascii_lowercase())
}

fn strip_team_prefix(id: &str) -> &str {
    match id.split_once('.') {
        Some((team, rest))
            if team.len() == 10
                && team
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) =>
        {
            rest
        }
        _ => id,
    }
}

/// Whether `id` is the same bundle as `other`, or a helper/parent of it (helpers
/// share a reverse-DNS prefix, e.g. `com.app` ↔ `com.app.helper`).
pub fn ids_related(id: &str, other: &str) -> bool {
    id == other || id.starts_with(&format!("{other}.")) || other.starts_with(&format!("{id}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_reverse_dns_ids() {
        assert_eq!(
            candidate_id("com.foo.Bar.plist").as_deref(),
            Some("com.foo.bar")
        );
        assert_eq!(
            candidate_id("com.foo.Bar.savedState").as_deref(),
            Some("com.foo.bar")
        );
        assert_eq!(candidate_id("MyNotes"), None);
        assert_eq!(candidate_id("com.foo"), None);
        assert_eq!(
            candidate_id("6N38VWS5BX.ru.keepcoder.Telegram").as_deref(),
            Some("ru.keepcoder.telegram")
        );
    }

    #[test]
    fn relates_app_and_helper() {
        assert!(ids_related("com.acme.editor", "com.acme.editor"));
        assert!(ids_related("com.acme.editor.helper", "com.acme.editor"));
        assert!(ids_related("com.acme.editor", "com.acme.editor.helper"));
        assert!(!ids_related("com.gone.app", "com.acme.editor"));
    }
}
