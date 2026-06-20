// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Real macOS Liquid Glass: a frosted NSVisualEffectView behind the
            // window. The body/sidebar are transparent so it shows through the
            // menu (Apple Music style); the content column stays opaque.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(win) = app.get_webview_window("main") {
                    // Radius MUST match #app's border-radius (24px) so the native
                    // NSVisualEffectView is rounded too — otherwise its square
                    // corners poke out behind the rounded content.
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        Some(24.0),
                    );
                }
            }
            Ok(())
        })
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
