// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::scan,
            commands::clean,
            commands::smart_clean,
            commands::apps,
            commands::footprint,
            commands::uninstall,
            commands::privacy,
            commands::dupes,
            commands::explore,
            commands::diagnose,
            commands::doctor_fix,
            commands::maintenance,
            commands::schedule,
            commands::get_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sweep application");
}
