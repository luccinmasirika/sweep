//! Thin #[tauri::command] wrappers over sweep::gui_api. Every command is async
//! and runs the blocking sweep work on a worker thread (spawn_blocking) so a
//! multi-second scan or clean never blocks the UI thread and the window stays
//! responsive. Fallible API functions surface their error to the frontend as a
//! plain string.

use serde_json::Value;
use sweep::gui_api;
use sweep::report::{Finding, Report};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Run a blocking closure off the UI thread, flattening the join error.
async fn offload<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn scan(only: Vec<String>) -> CmdResult<Vec<Report>> {
    offload(move || gui_api::scan(only).map_err(err)).await
}

#[tauri::command]
pub async fn clean(paths: Vec<String>, purge: bool) -> CmdResult<gui_api::CleanResult> {
    offload(move || gui_api::clean(paths, purge).map_err(err)).await
}

#[tauri::command]
pub async fn smart_clean(purge: bool) -> CmdResult<gui_api::CleanResult> {
    offload(move || gui_api::smart_clean(purge).map_err(err)).await
}

#[tauri::command]
pub async fn apps() -> CmdResult<Vec<gui_api::AppInfo>> {
    offload(|| Ok(gui_api::apps())).await
}

#[tauri::command]
pub async fn footprint(query: String) -> CmdResult<gui_api::Footprint> {
    offload(move || gui_api::footprint(query).map_err(err)).await
}

#[tauri::command]
pub async fn uninstall(query: String, purge: bool) -> CmdResult<gui_api::CleanResult> {
    offload(move || gui_api::uninstall(query, purge).map_err(err)).await
}

#[tauri::command]
pub async fn privacy() -> CmdResult<Vec<Finding>> {
    offload(|| gui_api::privacy().map_err(err)).await
}

#[tauri::command]
pub async fn dupes(path: String) -> CmdResult<Vec<gui_api::DupeSet>> {
    offload(move || Ok(gui_api::dupes(path))).await
}

#[tauri::command]
pub async fn explore(path: String) -> CmdResult<gui_api::ExploreNode> {
    offload(move || Ok(gui_api::explore(path))).await
}

#[tauri::command]
pub async fn diagnose() -> CmdResult<sweep::fsutil::Diagnosis> {
    offload(|| Ok(gui_api::diagnose())).await
}

#[tauri::command]
pub async fn doctor_fix() -> CmdResult<gui_api::ActionResult> {
    offload(|| Ok(gui_api::doctor_fix())).await
}

#[tauri::command]
pub async fn maintenance(tasks: Vec<String>) -> CmdResult<gui_api::ActionResult> {
    offload(move || Ok(gui_api::maintenance(tasks))).await
}

#[tauri::command]
pub async fn schedule(action: String, interval: String) -> CmdResult<gui_api::ActionResult> {
    offload(move || gui_api::schedule(action, interval).map_err(err)).await
}

#[tauri::command]
pub async fn get_config() -> CmdResult<Value> {
    offload(|| {
        let cfg = gui_api::get_config().map_err(err)?;
        serde_json::to_value(cfg).map_err(err)
    })
    .await
}
