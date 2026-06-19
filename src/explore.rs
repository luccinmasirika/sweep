use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::Serialize;

use crate::{fsutil, ui};

/// At most this many rows in the non-interactive tree.
const TREE_ROWS: usize = 40;

struct Item {
    path: PathBuf,
    size: u64,
    is_dir: bool,
}

/// `explore` answers "what is taking up space here?" — a size-sorted walk you
/// can drill into and trash from. Defaults to the home directory.
pub fn run(start: Option<PathBuf>, json: bool) -> Result<()> {
    let root = start.unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }
    if json {
        return print_json(&root);
    }
    if interactive() {
        browse(root)
    } else {
        print_tree(&root);
        Ok(())
    }
}

fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Immediate children of `dir`, each sized on disk, largest first.
fn children(dir: &Path) -> Vec<Item> {
    let spinner = ui::spinner(&ui::pretty_path(dir));
    let mut items: Vec<Item> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| {
                let path = e.path();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                Item {
                    size: fsutil::path_size(&path),
                    is_dir,
                    path,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    spinner.finish_and_clear();
    items.sort_by(|a, b| b.size.cmp(&a.size));
    items
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn browse(mut cwd: PathBuf) -> Result<()> {
    loop {
        let items = children(&cwd);
        let total: u64 = items.iter().map(|i| i.size).sum();

        let mut labels = vec!["⬆  ..".to_string()];
        for it in &items {
            let slash = if it.is_dir { "/" } else { "" };
            labels.push(format!(
                "{:>10}  {}{}",
                ui::human(it.size),
                name_of(&it.path),
                slash
            ));
        }
        labels.push("✓  done".to_string());

        println!();
        println!("{}  ({})", ui::pretty_path(&cwd), ui::human(total));
        let sel = dialoguer::Select::with_theme(&ui::menu_theme())
            .items(&labels)
            .default(0)
            .interact()?;

        if sel == 0 {
            if let Some(parent) = cwd.parent() {
                cwd = parent.to_path_buf();
            }
            continue;
        }
        if sel == labels.len() - 1 {
            break;
        }

        let item = &items[sel - 1];
        let mut actions: Vec<&str> = Vec::new();
        if item.is_dir {
            actions.push("Open");
        }
        actions.push("Move to Trash");
        actions.push("Back");
        let a = dialoguer::Select::with_theme(&ui::menu_theme())
            .with_prompt(ui::pretty_path(&item.path))
            .items(&actions)
            .default(0)
            .interact()?;

        match actions[a] {
            "Open" => cwd = item.path.clone(),
            "Move to Trash" => {
                if ui::confirm(&format!("Move {} to Trash?", ui::pretty_path(&item.path)))? {
                    match fsutil::remove_path(&item.path, false) {
                        Ok(()) => ui::ok("moved to Trash"),
                        Err(e) => ui::warn(&format!("{e}")),
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn print_tree(dir: &Path) {
    let items = children(dir);
    let total: u64 = items.iter().map(|i| i.size).sum();
    println!("{}  ({})", ui::pretty_path(dir), ui::human(total));
    for it in items.iter().take(TREE_ROWS) {
        let slash = if it.is_dir { "/" } else { "" };
        println!(
            "  {:>10}  {}{}",
            ui::human(it.size),
            name_of(&it.path),
            slash
        );
    }
    if items.len() > TREE_ROWS {
        println!("  … and {} more", items.len() - TREE_ROWS);
    }
}

#[derive(Serialize)]
struct Node {
    path: String,
    size: u64,
    children: Vec<Child>,
}

#[derive(Serialize)]
struct Child {
    path: String,
    size: u64,
    is_dir: bool,
}

fn print_json(dir: &Path) -> Result<()> {
    let items = children(dir);
    let node = Node {
        path: dir.display().to_string(),
        size: items.iter().map(|i| i.size).sum(),
        children: items
            .iter()
            .map(|i| Child {
                path: i.path.display().to_string(),
                size: i.size,
                is_dir: i.is_dir,
            })
            .collect(),
    };
    ui::print_json(&node)
}
