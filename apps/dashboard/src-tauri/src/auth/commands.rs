use super::{service::AccessGrant, AuthError, AuthService, CommandError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
#[tauri::command]
pub async fn auth_begin_github(
    app: tauri::AppHandle,
    service: tauri::State<'_, AuthService>,
) -> Result<(), CommandError> {
    let request = service
        .begin_github(now_ms())
        .await
        .map_err(CommandError::from)?;
    if app.opener().open_url(&request.url, None::<&str>).is_err() {
        let _ = service.rollback_pending_if_matches(&request.flow_id).await;
        return Err(AuthError::BrowserOpen.into());
    }
    Ok(())
}
#[tauri::command]
pub async fn auth_send_magic_link(
    email: String,
    service: tauri::State<'_, AuthService>,
) -> Result<(), CommandError> {
    service
        .send_magic_link(&email, now_ms())
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn auth_restore(
    service: tauri::State<'_, AuthService>,
) -> Result<Option<AccessGrant>, CommandError> {
    service.restore(now_ms()).await.map_err(Into::into)
}
#[tauri::command]
pub async fn auth_complete(
    callback_url: String,
    service: tauri::State<'_, AuthService>,
) -> Result<AccessGrant, CommandError> {
    service
        .complete(&callback_url, now_ms())
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn auth_refresh(
    service: tauri::State<'_, AuthService>,
) -> Result<AccessGrant, CommandError> {
    service.refresh(now_ms()).await.map_err(Into::into)
}
#[tauri::command]
pub async fn auth_expire(service: tauri::State<'_, AuthService>) -> Result<(), CommandError> {
    service.expire().await.map_err(Into::into)
}
#[tauri::command]
pub async fn auth_sign_out(service: tauri::State<'_, AuthService>) -> Result<(), CommandError> {
    service.sign_out().await.map_err(Into::into)
}
