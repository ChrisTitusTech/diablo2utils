use tauri::Manager;

/// Toggle click-through mode on the overlay window.
/// When `ignore` is true, mouse events pass through to the game underneath.
/// When `ignore` is false, the overlay is interactive (for dragging/resizing).
#[tauri::command]
pub fn set_clickthrough(app: tauri::AppHandle, ignore: bool) -> Result<(), String> {
    let window = app.get_webview_window("overlay")
        .ok_or("overlay window not found")?;
    window.set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}
