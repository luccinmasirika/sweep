use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::{apps, exec};

/// Caches that belong to a system service rather than to anything the user
/// runs. They are small, macOS rebuilds them on its own schedule, and wiping
/// one mid-flight can force an iCloud re-sync or sign the user out — never
/// worth the few megabytes.
const SYSTEM_SERVICES: &[(&str, &str)] = &[
    ("com.apple.bird", "iCloud Drive"),
    ("CloudKit", "iCloud"),
    ("com.apple.cloudd", "iCloud"),
    ("com.apple.akd", "Apple Account sign-in"),
    (
        "com.apple.AuthenticationServicesCore.AuthenticationServicesAgent",
        "Apple Account sign-in",
    ),
    ("com.apple.nsurlsessiond", "background downloads"),
    ("com.apple.containermanagerd", "app containers"),
    ("com.apple.cache_delete", "macOS storage management"),
    ("FamilyCircle", "Family Sharing"),
    ("familycircled", "Family Sharing"),
    ("com.apple.HomeKit", "Home"),
    ("com.apple.homed", "Home"),
];

/// A snapshot of what is in use, taken once just before cleaning: files some
/// process has open, apps that are running, and system services' caches.
/// Removing any of those can crash the app, corrupt its cache, or break an
/// update halfway — and an open file's space doesn't come back until the
/// process lets go of it anyway.
#[derive(Debug, Default)]
pub struct InUse {
    /// Open file paths with the command holding each, sorted by path so a
    /// folder's contents can be found with one binary search.
    open: Vec<(PathBuf, String)>,
    apps: Vec<RunningApp>,
    library: Option<PathBuf>,
}

#[derive(Debug)]
struct RunningApp {
    name: String,
    id: Option<String>,
}

impl InUse {
    pub fn capture() -> Self {
        let mut open = open_files();
        open.sort();
        Self {
            open,
            apps: running_apps(),
            library: dirs::home_dir().map(|h| h.join("Library")),
        }
    }

    /// Why `path` must be left alone right now, or `None` if nothing is using
    /// it.
    pub fn why(&self, path: &Path) -> Option<String> {
        if let Some(reason) = self.used_by_service_or_app(path) {
            return Some(reason);
        }
        // The first open path at or after `path` is inside it if anything is.
        let at = self.open.partition_point(|(p, _)| p.as_path() < path);
        let (open, command) = self.open.get(at)?;
        open.starts_with(path).then(|| format!("open in {command}"))
    }

    /// App and service matching looks at `~/Library` only: that's where an
    /// app's name or bundle id names its own folders. Anywhere else a folder
    /// called `Notes` is just a folder.
    fn used_by_service_or_app(&self, path: &Path) -> Option<String> {
        let rest = path.strip_prefix(self.library.as_ref()?).ok()?;
        let parts: Vec<String> = rest
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        for part in &parts {
            if let Some((_, service)) = SYSTEM_SERVICES.iter().find(|(name, _)| name == part) {
                return Some(format!("used by {service}"));
            }
            let id = apps::candidate_id(part).unwrap_or_else(|| part.to_ascii_lowercase());
            if let Some(app) = self
                .apps
                .iter()
                .find(|a| &a.name == part || a.id.as_deref() == Some(id.as_str()))
            {
                return Some(format!("{} is running", app.name));
            }
        }
        // Chromium-family apps nest their data by vendor: "Google Chrome"
        // lives in `Google/Chrome`, "Microsoft Edge" in `Microsoft Edge`.
        self.apps
            .iter()
            .find(|a| {
                let words: Vec<&str> = a.name.split(' ').collect();
                words.len() > 1 && parts.windows(words.len()).any(|w| w == words.as_slice())
            })
            .map(|app| format!("{} is running", app.name))
    }

    #[cfg(test)]
    fn with(open: &[(&str, &str)], apps: &[(&str, &str)], library: &Path) -> Self {
        let mut open: Vec<_> = open
            .iter()
            .map(|(p, c)| (PathBuf::from(p), c.to_string()))
            .collect();
        open.sort();
        Self {
            open,
            apps: apps
                .iter()
                .map(|(name, id)| RunningApp {
                    name: name.to_string(),
                    id: Some(id.to_string()),
                })
                .collect(),
            library: Some(library.to_path_buf()),
        }
    }
}

/// Every file open by a process we're allowed to inspect. `-n -P` skips host
/// and port lookups, which otherwise stretch a sub-second call to a minute.
fn open_files() -> Vec<(PathBuf, String)> {
    let Ok(out) = exec::capture(&["lsof", "-w", "-n", "-P", "-Fcn"].map(String::from)) else {
        return Vec::new();
    };
    parse_lsof(&out)
}

/// `lsof -F` prints one field per line: `c` the command of the process that
/// follows, `n` each name it has open.
fn parse_lsof(out: &str) -> Vec<(PathBuf, String)> {
    let mut command = String::new();
    let mut seen = HashSet::new();
    let mut open = Vec::new();
    for line in out.lines() {
        if let Some(c) = line.strip_prefix('c') {
            command = c.to_string();
        } else if let Some(name) = line.strip_prefix('n') {
            if name.starts_with('/') && seen.insert((name.to_string(), command.clone())) {
                open.push((PathBuf::from(name), command.clone()));
            }
        }
    }
    open
}

/// Apps with a process running, from the `.app` bundle each executable lives in.
fn running_apps() -> Vec<RunningApp> {
    let Ok(out) = exec::capture(&["ps", "-Ao", "comm="].map(String::from)) else {
        return Vec::new();
    };
    let bundles: HashSet<PathBuf> = out
        .lines()
        .filter_map(|exe| exe.find(".app/").map(|end| PathBuf::from(&exe[..end + 4])))
        .collect();
    bundles
        .into_iter()
        .filter_map(|bundle| {
            let name = bundle.file_stem()?.to_string_lossy().into_owned();
            Some(RunningApp {
                id: apps::bundle_id(&bundle),
                name,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_with_an_open_file_inside_is_in_use() {
        let lib = Path::new("/Users/me/Library");
        let in_use = InUse::with(
            &[(
                "/Users/me/Library/Caches/com.todesktop.ShipIt/update.zip",
                "ShipIt",
            )],
            &[],
            lib,
        );

        assert_eq!(
            in_use.why(Path::new("/Users/me/Library/Caches/com.todesktop.ShipIt")),
            Some("open in ShipIt".into())
        );
        // A sibling that merely sorts next to it is not.
        assert_eq!(
            in_use.why(Path::new("/Users/me/Library/Caches/com.todesk")),
            None
        );
        assert_eq!(
            in_use.why(Path::new("/Users/me/Library/Caches/Homebrew")),
            None
        );
    }

    #[test]
    fn a_running_apps_folders_are_in_use() {
        let lib = Path::new("/Users/me/Library");
        let in_use = InUse::with(&[], &[("Dia", "company.thebrowser.dia")], lib);

        for p in [
            "/Users/me/Library/Application Support/Dia/Cache",
            "/Users/me/Library/Caches/company.thebrowser.dia",
        ] {
            assert_eq!(
                in_use.why(Path::new(p)),
                Some("Dia is running".into()),
                "{p}"
            );
        }
        let chrome = InUse::with(&[], &[("Google Chrome", "com.google.chrome")], lib);
        assert_eq!(
            chrome.why(Path::new(
                "/Users/me/Library/Application Support/Google/Chrome/Default/Code Cache"
            )),
            Some("Google Chrome is running".into())
        );
        assert_eq!(
            chrome.why(Path::new(
                "/Users/me/Library/Application Support/Google/DriveFS"
            )),
            None
        );

        // Outside Library an app's name is just a folder name.
        assert_eq!(
            in_use.why(Path::new("/Users/me/Developer/Dia/node_modules")),
            None
        );
    }

    #[test]
    fn system_service_caches_are_always_left_alone() {
        let lib = Path::new("/Users/me/Library");
        let in_use = InUse::with(&[], &[], lib);

        assert_eq!(
            in_use.why(Path::new("/Users/me/Library/Caches/com.apple.bird")),
            Some("used by iCloud Drive".into())
        );
        assert_eq!(in_use.why(Path::new("/Users/me/Library/Caches/Yarn")), None);
    }

    #[test]
    fn reads_lsof_field_output() {
        let out = "p398\ncloginwindow\nfcwd\nn/\nftxt\nn/Users/me/Library/Caches/x/db\np512\ncShipIt\nn/tmp/a\nnlocalhost:443\n";
        assert_eq!(
            parse_lsof(out),
            vec![
                (PathBuf::from("/"), "loginwindow".to_string()),
                (
                    PathBuf::from("/Users/me/Library/Caches/x/db"),
                    "loginwindow".to_string()
                ),
                (PathBuf::from("/tmp/a"), "ShipIt".to_string()),
            ]
        );
    }
}
