mod commands;
mod events;
mod reader;
mod sidecar;

use sidecar::SidecarManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarManager::new())
        .setup(|app| {
            // Spawn one sidecar on startup. MVP has a single session; the manager
            // is keyed by SessionId so adding more is a data change, not a rewrite.
            let manager = tauri::Manager::state::<SidecarManager>(app);
            match manager.spawn_session() {
                Ok(id) => eprintln!("[pi-desktop] sidecar session ready: {id}"),
                Err(e) => eprintln!("[pi-desktop] sidecar spawn failed: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::active_session_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
