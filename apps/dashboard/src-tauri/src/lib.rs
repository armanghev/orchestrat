mod auth;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg(target_os = "macos")]
#[derive(Default)]
struct ZoomState(Mutex<Option<[f64; 4]>>);

#[cfg(target_os = "macos")]
#[tauri::command]
fn zoom_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ZoomState>,
) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
    let current = ns_window.frame();
    let start = [
        current.origin.x,
        current.origin.y,
        current.size.width,
        current.size.height,
    ];
    let target = {
        let mut saved = state.0.lock().map_err(|error| error.to_string())?;
        if let Some(frame) = saved.take() {
            frame
        } else {
            *saved = Some(start);
            let frame = ns_window
                .screen()
                .ok_or_else(|| "Window is not attached to a screen".to_string())?
                .visibleFrame();
            [
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
            ]
        }
    };
    std::thread::spawn(move || {
        const FRAME_COUNT: u32 = 18;
        for step in 1..=FRAME_COUNT {
            let progress = step as f64 / FRAME_COUNT as f64;
            let eased = if progress < 0.5 {
                4.0 * progress * progress * progress
            } else {
                1.0 - (-2.0 * progress + 2.0).powi(3) / 2.0
            };
            let frame = [
                start[0] + (target[0] - start[0]) * eased,
                start[1] + (target[1] - start[1]) * eased,
                start[2] + (target[2] - start[2]) * eased,
                start[3] + (target[3] - start[3]) * eased,
            ];
            let native_window = window.clone();
            if window
                .run_on_main_thread(move || {
                    if let Ok(pointer) = native_window.ns_window() {
                        let native_window = unsafe { &*pointer.cast::<NSWindow>() };
                        native_window.setFrame_display_animate(
                            CGRect::new(
                                CGPoint::new(frame[0], frame[1]),
                                CGSize::new(frame[2], frame[3]),
                            ),
                            true,
                            false,
                        );
                    }
                })
                .is_err()
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
    });
    Ok(())
}

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
        .manage(ZoomState::default())
        .setup(|app| {
            let window = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "main window is missing")
            })?;
            window.as_ref().set_auto_resize(true)?;
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
            auth::commands::auth_sign_out,
            zoom_window
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Orchestrat");
}
