mod commands;
mod events;
mod pi_config;
mod reader;
mod sidecar;
mod workspace;

use sidecar::SidecarManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SidecarManager::new());

    // Dev-only automation bridge for the Tauri MCP server (screenshots, clicks,
    // IPC inspection). Bound to localhost and gated to debug builds so it never
    // runs in release.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    builder
        .setup(|app| {
            // Spawn one sidecar on startup. MVP has a single session; the manager
            // is keyed by SessionId so adding more is a data change, not a rewrite.
            let manager = tauri::Manager::state::<SidecarManager>(app);
            match manager.spawn_session() {
                Ok(id) => eprintln!("[hoy-desktop] sidecar session ready: {id}"),
                Err(e) => eprintln!("[hoy-desktop] sidecar spawn failed: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::active_session_id,
            commands::list_models,
            commands::set_model,
            commands::save_provider_key,
            commands::remove_provider_key,
            commands::provider_statuses,
            commands::supported_providers,
            commands::create_session,
            commands::send_prompt,
            commands::get_session_stats,
            commands::abort,
            commands::respond_permission,
            commands::set_permission_mode,
            commands::close_session,
            commands::get_messages,
            commands::delete_session_file,
            commands::load_workspace,
            commands::save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
