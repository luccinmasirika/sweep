//! Thin #[tauri::command] wrappers over sweep::gui_api. Fallible API functions
//! surface their anyhow error to the frontend as a plain string.

use serde_json::Value;
use sweep::gui_api;
use sweep::report::{Finding, Report};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn scan(only: Vec<String>) -> CmdResult<Vec<Report>> {
    gui_api::scan(only).map_err(err)
}

#[tauri::command]
pub fn clean(paths: Vec<String>, purge: bool) -> CmdResult<gui_api::CleanResult> {
    gui_api::clean(paths, purge).map_err(err)
}

#[tauri::command]
pub fn smart_clean(purge: bool) -> CmdResult<gui_api::CleanResult> {
    gui_api::smart_clean(purge).map_err(err)
}

#[tauri::command]
pub fn apps() -> Vec<gui_api::AppInfo> {
    gui_api::apps()
}

#[tauri::command]
pub fn footprint(query: String) -> CmdResult<gui_api::Footprint> {
    gui_api::footprint(query).map_err(err)
}

#[tauri::command]
pub fn uninstall(query: String, purge: bool) -> CmdResult<gui_api::CleanResult> {
    gui_api::uninstall(query, purge).map_err(err)
}

#[tauri::command]
pub fn privacy() -> CmdResult<Vec<Finding>> {
    gui_api::privacy().map_err(err)
}

#[tauri::command]
pub fn dupes(path: String) -> Vec<gui_api::DupeSet> {
    gui_api::dupes(path)
}

#[tauri::command]
pub fn explore(path: String) -> gui_api::ExploreNode {
    gui_api::explore(path)
}

#[tauri::command]
pub fn diagnose() -> sweep::fsutil::Diagnosis {
    gui_api::diagnose()
}

#[tauri::command]
pub fn doctor_fix() -> gui_api::ActionResult {
    gui_api::doctor_fix()
}

#[tauri::command]
pub fn maintenance(tasks: Vec<String>) -> gui_api::ActionResult {
    gui_api::maintenance(tasks)
}

#[tauri::command]
pub fn schedule(action: String, interval: String) -> CmdResult<gui_api::ActionResult> {
    gui_api::schedule(action, interval).map_err(err)
}

#[tauri::command]
pub fn get_config() -> CmdResult<Value> {
    let cfg = gui_api::get_config().map_err(err)?;
    serde_json::to_value(cfg).map_err(|e| e.to_string())
}
