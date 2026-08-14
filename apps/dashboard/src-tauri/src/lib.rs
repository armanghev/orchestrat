mod auth;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let config = auth::OAuthConfig::from_build()
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
            let transport = auth::ClerkOAuthTransport::new(config.clone());
            app.manage(auth::OAuthService::new(
                config,
                Arc::new(auth::KeychainStore),
                Arc::new(transport),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::commands::oauth_begin,
            auth::commands::oauth_restore,
            auth::commands::oauth_complete,
            auth::commands::oauth_refresh,
            auth::commands::oauth_sign_out,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Orchestrat");
}
