mod auth;
use std::sync::Arc;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Keep single-instance first. On macOS, registered-scheme URLs arrive through the
        // deep-link RunEvent pipeline; second-instance argv is intentionally ignored and never logged.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let config = auth::SupabaseConfig::from_build()
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            let transport = auth::SupabaseAuthTransport::new(config.clone());
            let store = auth::KeychainStore::new(config.keychain_service());
            app.manage(auth::AuthService::new(
                config,
                Arc::new(store),
                Arc::new(transport),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::commands::auth_begin_github,
            auth::commands::auth_send_magic_link,
            auth::commands::auth_restore,
            auth::commands::auth_complete,
            auth::commands::auth_refresh,
            auth::commands::auth_expire,
            auth::commands::auth_sign_out
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Orchestrat");
}
