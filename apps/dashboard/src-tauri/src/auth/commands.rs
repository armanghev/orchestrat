use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_opener::OpenerExt;

use super::{service::AccessGrant, AuthError, CommandError, OAuthService};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[tauri::command]
pub fn oauth_begin(
    app: tauri::AppHandle,
    service: tauri::State<'_, OAuthService>,
) -> Result<(), CommandError> {
    let authorization_request = service.begin(now_ms()).map_err(CommandError::from)?;
    if app
        .opener()
        .open_url(authorization_request.url, None::<&str>)
        .is_err()
    {
        let _ = service.cancel_pending_if_matches(&authorization_request.state);
        return Err(AuthError::BrowserOpen.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn oauth_restore(
    service: tauri::State<'_, OAuthService>,
) -> Result<Option<AccessGrant>, CommandError> {
    service.restore(now_ms()).await.map_err(CommandError::from)
}

#[tauri::command]
pub async fn oauth_complete(
    callback_url: String,
    service: tauri::State<'_, OAuthService>,
) -> Result<AccessGrant, CommandError> {
    service
        .complete(&callback_url, now_ms())
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn oauth_refresh(
    service: tauri::State<'_, OAuthService>,
) -> Result<AccessGrant, CommandError> {
    service.refresh(now_ms()).await.map_err(CommandError::from)
}

#[tauri::command]
pub async fn oauth_sign_out(service: tauri::State<'_, OAuthService>) -> Result<(), CommandError> {
    service.sign_out().await.map_err(CommandError::from)
}
