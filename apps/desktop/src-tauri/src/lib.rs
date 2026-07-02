mod commands;
mod events;
mod oauth;
mod pi_config;
mod reader;
mod sidecar;
mod workspace;

use sidecar::SidecarManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // mut is only consumed by the debug-gated MCP bridge block below.
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // Auto-updater (HOY-187), desktop-only. The frontend drives the check via
    // the About panel; updates are pulled from GitHub releases.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

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
            // Debug builds run in the hoyd namespace (HOY-206): retitle the OS
            // window so taskbar/alt-tab tells the dev instance from production.
            #[cfg(debug_assertions)]
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let _ = window.set_title("Hoyd Desktop");
            }

            // Construct the manager here, not at .manage time: new_with_resolver
            // needs an AppHandle to locate the bundled pi-payload in $RESOURCE.
            tauri::Manager::manage(
                app,
                SidecarManager::new_with_resolver(tauri::Manager::path(app)),
            );
            tauri::Manager::manage(app, oauth::OAuthLogin::default());

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
            commands::get_commands,
            commands::set_model,
            commands::set_thinking_level,
            commands::compact,
            commands::set_auto_compaction,
            commands::save_provider_key,
            commands::remove_provider_key,
            commands::provider_statuses,
            commands::supported_providers,
            oauth::oauth_login_start,
            oauth::oauth_login_submit,
            oauth::oauth_login_cancel,
            commands::create_session,
            commands::send_prompt,
            commands::enqueue_prompt,
            commands::get_session_stats,
            commands::abort,
            commands::respond_permission,
            commands::set_permission_mode,
            commands::close_session,
            commands::get_messages,
            commands::get_entries,
            commands::get_tree,
            commands::delete_session_file,
            commands::list_project_paths,
            commands::read_context_file,
            commands::load_workspace,
            commands::save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
