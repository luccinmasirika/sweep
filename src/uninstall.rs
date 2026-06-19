use std::path::PathBuf;

use anyhow::{bail, Result};
use serde::Serialize;

use crate::apps::{self, App};
use crate::fsutil;
use crate::ui;

/// `uninstall` removes an app and its whole footprint — the `.app` bundle plus
/// every support file, cache, preference, container and launch agent that shares
/// its bundle id. Everything goes to the Trash unless `--purge` is set.
pub fn run(queries: Vec<String>, json: bool, purge: bool) -> Result<u32> {
    let installed = apps::installed_apps();
    let targets = if queries.is_empty() {
        if !interactive() {
            bail!("name an app to uninstall, e.g. `sweep uninstall Foo`");
        }
        vec![pick_app(&installed)?]
    } else {
        let mut picked = Vec::new();
        for q in &queries {
            picked.push(resolve(q, &installed)?);
        }
        picked
    };

    let mut failures = 0;
    for app in targets {
        let footprint = footprint(&app);
        if json {
            ui::print_json(&to_json(&app, &footprint))?;
            continue;
        }
        failures += uninstall_one(&app, footprint, purge)?;
    }
    Ok(failures)
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub(crate) fn resolve(query: &str, installed: &[App]) -> Result<App> {
    let q = query.to_ascii_lowercase();
    let q = q.trim_end_matches(".app");
    // A direct .app path the user passed.
    let path = PathBuf::from(query);
    if path.extension().is_some_and(|e| e == "app") && path.is_dir() {
        if let Some(id) = apps::bundle_id(&path) {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| query.to_string());
            return Ok(App { path, id, name });
        }
    }
    installed
        .iter()
        .find(|a| a.name.to_ascii_lowercase() == q || a.id == q)
        .map(clone_app)
        .ok_or_else(|| anyhow::anyhow!("no installed app matches {query:?}"))
}

fn clone_app(a: &App) -> App {
    App {
        path: a.path.clone(),
        id: a.id.clone(),
        name: a.name.clone(),
    }
}

fn pick_app(installed: &[App]) -> Result<App> {
    let mut apps: Vec<&App> = installed.iter().collect();
    apps.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    let labels: Vec<String> = apps.iter().map(|a| a.name.clone()).collect();
    let sel = dialoguer::Select::with_theme(&ui::menu_theme())
        .with_prompt("Which app to uninstall?")
        .items(&labels)
        .default(0)
        .interact()?;
    Ok(clone_app(apps[sel]))
}

/// The app bundle plus every per-id support file and launch agent.
pub(crate) fn footprint(app: &App) -> Vec<PathBuf> {
    let mut paths = vec![app.path.clone()];
    let Some(home) = dirs::home_dir() else {
        return paths;
    };

    for sub in apps::SUPPORT_DIRS {
        let Ok(rd) = std::fs::read_dir(home.join(sub)) else {
            continue;
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if apps::candidate_id(&name).is_some_and(|id| apps::ids_related(&id, &app.id)) {
                paths.push(entry.path());
            }
        }
    }

    // Launch agents/daemons named after the bundle id.
    for sub in ["Library/LaunchAgents", "Library/LaunchDaemons"] {
        let Ok(rd) = std::fs::read_dir(home.join(sub)) else {
            continue;
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if apps::candidate_id(&name).is_some_and(|id| apps::ids_related(&id, &app.id)) {
                paths.push(entry.path());
            }
        }
    }

    paths
}

fn uninstall_one(app: &App, footprint: Vec<PathBuf>, purge: bool) -> Result<u32> {
    println!();
    println!("{}  ({})", app.name, app.id);
    let mut total = 0;
    for p in &footprint {
        let size = fsutil::path_size(p);
        total += size;
        println!("  {:>10}  {}", ui::human(size), ui::pretty_path(p));
    }
    println!("  {}", format_args!("↳ {} total", ui::human(total)));

    let verb = if purge { "delete" } else { "move to Trash" };
    if !ui::confirm(&format!(
        "{verb} {} item(s) for {}?",
        footprint.len(),
        app.name
    ))? {
        return Ok(0);
    }

    let mut failures = 0;
    for p in &footprint {
        if let Err(e) = fsutil::remove_path(p, purge) {
            failures += 1;
            ui::warn(&format!("{}: {e}", ui::pretty_path(p)));
        }
    }
    if failures == 0 {
        ui::ok(&format!("{} uninstalled", app.name));
    }
    Ok(failures)
}

#[derive(Serialize)]
struct Json {
    name: String,
    id: String,
    footprint: Vec<JsonItem>,
}

#[derive(Serialize)]
struct JsonItem {
    path: String,
    size: u64,
}

fn to_json(app: &App, footprint: &[PathBuf]) -> Json {
    Json {
        name: app.name.clone(),
        id: app.id.clone(),
        footprint: footprint
            .iter()
            .map(|p| JsonItem {
                path: p.display().to_string(),
                size: fsutil::path_size(p),
            })
            .collect(),
    }
}
