use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicUsize, Ordering};

const MAX_TITLE_CHARACTERS: usize = 80;
const MAX_BODY_CHARACTERS: usize = 240;
const NOTIFICATION_ACTION_EVENT: &str = "notification-action";
#[cfg(target_os = "macos")]
const OPEN_ACTION: &str = "open";
#[cfg(target_os = "macos")]
const MAX_PENDING_RESPONSES: usize = 32;
#[cfg(target_os = "macos")]
static PENDING_RESPONSES: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "macos")]
struct NotificationWaitPermit;

#[cfg(target_os = "macos")]
impl NotificationWaitPermit {
    fn acquire() -> Option<Self> {
        // ponytail: the legacy macOS backend blocks one thread per response; keep that bounded.
        PENDING_RESPONSES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending < MAX_PENDING_RESPONSES).then_some(pending + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

#[cfg(target_os = "macos")]
impl Drop for NotificationWaitPermit {
    fn drop(&mut self) {
        PENDING_RESPONSES.fetch_sub(1, Ordering::Release);
    }
}

// `branchId` opens the branch the event happened on; without it the dashboard
// shows the default branch.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotificationDestination {
    Task {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "branchId", default, skip_serializing_if = "Option::is_none")]
        branch_id: Option<String>,
        #[serde(rename = "taskId")]
        task_id: String,
    },
    Activity {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "branchId", default, skip_serializing_if = "Option::is_none")]
        branch_id: Option<String>,
    },
    Chat {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "branchId", default, skip_serializing_if = "Option::is_none")]
        branch_id: Option<String>,
        #[serde(rename = "chatId")]
        chat_id: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct NativeNotification {
    title: String,
    body: String,
    destination: NotificationDestination,
}

fn validate_text(label: &str, value: &str, maximum: usize) -> Result<(), String> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(format!("Notification {label} is invalid."));
    }
    Ok(())
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().copied().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

fn validate_notification(notification: &NativeNotification) -> Result<(), String> {
    validate_text("title", &notification.title, MAX_TITLE_CHARACTERS)?;
    validate_text("body", &notification.body, MAX_BODY_CHARACTERS)?;
    let (project_id, branch_id, resource_id) = match &notification.destination {
        NotificationDestination::Task {
            project_id,
            branch_id,
            task_id,
        } => (project_id, branch_id, Some(task_id)),
        NotificationDestination::Activity {
            project_id,
            branch_id,
        } => (project_id, branch_id, None),
        NotificationDestination::Chat {
            project_id,
            branch_id,
            chat_id,
        } => (project_id, branch_id, Some(chat_id)),
    };
    if !is_uuid(project_id)
        || branch_id.as_ref().is_some_and(|value| !is_uuid(value))
        || resource_id.is_some_and(|value| !is_uuid(value))
    {
        return Err("Notification destination is invalid.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn opens_destination(response: &notify_rust::NotificationResponse) -> bool {
    response.is_default_action()
        || matches!(
            response,
            notify_rust::NotificationResponse::Action(action) if action == OPEN_ACTION
        )
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn show_native_notification(
    app: tauri::AppHandle,
    notification: NativeNotification,
) -> Result<(), String> {
    use notify_rust::Notification;

    validate_notification(&notification)?;
    let permit = NotificationWaitPermit::acquire()
        .ok_or_else(|| "Too many notification responses are pending.".to_string())?;
    let identifier = app.config().identifier.clone();
    let _ = notify_rust::set_application(if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        &identifier
    });
    let handle = Notification::new()
        .summary(&notification.title)
        .body(&notification.body)
        .action(OPEN_ACTION, "Open")
        .show()
        .map_err(|error| error.to_string())?;
    let destination = notification.destination;
    std::thread::Builder::new()
        .name("notification-response".to_string())
        .spawn(move || {
            let _permit = permit;
            let action_app = app.clone();
            let _ =
                handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                    if !opens_destination(response) {
                        return;
                    }
                    let dispatch_app = action_app.clone();
                    let main_thread = action_app.clone();
                    let _ = main_thread.run_on_main_thread(move || {
                        use tauri::{Emitter, Manager};

                        let _ = dispatch_app.show();
                        if let Some(window) = dispatch_app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = dispatch_app.emit(NOTIFICATION_ACTION_EVENT, destination);
                    });
                });
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn show_native_notification(
    _app: tauri::AppHandle,
    notification: NativeNotification,
) -> Result<(), String> {
    validate_notification(&notification)?;
    Err("Native notification actions are only available on macOS.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification(destination: NotificationDestination) -> NativeNotification {
        NativeNotification {
            title: "Task completed".to_string(),
            body: "Ship the release".to_string(),
            destination,
        }
    }

    #[test]
    fn accepts_only_bounded_text_and_uuid_destinations() {
        let valid = notification(NotificationDestination::Task {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: None,
            task_id: "22222222-2222-4222-8222-222222222222".to_string(),
        });
        assert!(validate_notification(&valid).is_ok());

        let on_branch = notification(NotificationDestination::Chat {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: Some("44444444-4444-4444-8444-444444444444".to_string()),
            chat_id: "33333333-3333-4333-8333-333333333333".to_string(),
        });
        assert!(validate_notification(&on_branch).is_ok());

        let bad_branch = notification(NotificationDestination::Activity {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: Some("feat/x".to_string()),
        });
        assert!(validate_notification(&bad_branch).is_err());

        let mut too_long = notification(NotificationDestination::Activity {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: None,
        });
        too_long.title = "x".repeat(MAX_TITLE_CHARACTERS + 1);
        assert!(validate_notification(&too_long).is_err());

        let invalid = notification(NotificationDestination::Task {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: None,
            task_id: "../../settings".to_string(),
        });
        assert!(validate_notification(&invalid).is_err());
    }

    #[test]
    fn serializes_only_typed_internal_destinations() {
        let destination = NotificationDestination::Task {
            project_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: None,
            task_id: "22222222-2222-4222-8222-222222222222".to_string(),
        };
        assert_eq!(
            serde_json::to_value(destination).unwrap(),
            serde_json::json!({
                "kind": "task",
                "projectId": "11111111-1111-4111-8111-111111111111",
                "taskId": "22222222-2222-4222-8222-222222222222"
            })
        );
        assert_eq!(
            serde_json::to_value(NotificationDestination::Chat {
                project_id: "11111111-1111-4111-8111-111111111111".to_string(),
                branch_id: Some("44444444-4444-4444-8444-444444444444".to_string()),
                chat_id: "33333333-3333-4333-8333-333333333333".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "kind": "chat",
                "projectId": "11111111-1111-4111-8111-111111111111",
                "branchId": "44444444-4444-4444-8444-444444444444",
                "chatId": "33333333-3333-4333-8333-333333333333"
            })
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opens_for_body_or_explicit_open_action_only() {
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(opens_destination(&NotificationResponse::Default));
        assert!(opens_destination(&NotificationResponse::Action(
            OPEN_ACTION.to_string()
        )));
        assert!(!opens_destination(&NotificationResponse::Action(
            "other".to_string()
        )));
        assert!(!opens_destination(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bounds_pending_native_response_waiters() {
        let permits = (0..MAX_PENDING_RESPONSES)
            .map(|_| NotificationWaitPermit::acquire().unwrap())
            .collect::<Vec<_>>();
        assert!(NotificationWaitPermit::acquire().is_none());
        drop(permits);
        assert!(NotificationWaitPermit::acquire().is_some());
    }
}
