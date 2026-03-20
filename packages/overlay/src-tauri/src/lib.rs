use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::PageLoadEvent;

mod commands;

/// JS injected into the map-viewer page to make it overlay-friendly.
const OVERLAY_JS: &str = include_str!("../inject/overlay.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::set_clickthrough,
        ])
        .setup(|app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "overlay",
                tauri::WebviewUrl::External("http://localhost:8899".parse().unwrap()),
            )
            .title("D2R Map Overlay")
            .inner_size(800.0, 600.0)
            .position(50.0, 50.0)
            .resizable(true)
            .decorations(false)
            .transparent(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .on_page_load(|ww, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = ww.eval(OVERLAY_JS);
                }
            })
            .build()?;

            // Start in click-through mode so the overlay doesn't steal game input
            window.set_ignore_cursor_events(true)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
