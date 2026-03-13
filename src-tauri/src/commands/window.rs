use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open (or focus) the render window from the Rust backend.
/// Accepts the full URL from the JS caller, so it works in both dev and production.
#[tauri::command]
pub async fn open_render_window(app: AppHandle, url: String) -> Result<(), String> {
    // If the window already exists, show and focus it.
    if let Some(window) = app.get_webview_window("render-window") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let parsed_url = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL: {e}"))?;

    WebviewWindowBuilder::new(&app, "render-window", WebviewUrl::External(parsed_url))
        .title("Render Optical System")
        .inner_size(1100.0, 760.0)
        .resizable(true)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Push accepted optimizer rows directly to the render window and request redraw.
/// This bypasses fragile cross-webview storage/event timing issues.
#[tauri::command]
pub async fn sync_render_rows(app: AppHandle, rows: Value) -> Result<(), String> {
        let Some(window) = app.get_webview_window("render-window") else {
                return Ok(());
        };

        let rows_json = serde_json::to_string(&rows).map_err(|e| format!("rows serialize failed: {e}"))?;
        let script = format!(
                r#"
                try {{
                    const rows = {rows_json};
                    if (!Array.isArray(rows) || rows.length === 0) {{
                        // still poke draw path in case table was updated by other sync route
                        if (typeof window.__cooptRenderWindowRedraw === 'function') {{
                            window.__cooptRenderWindowRedraw(rows);
                        }} else if (typeof window.drawOpticalSystem === 'function') {{
                            window.drawOpticalSystem();
                        }}
                    }} else {{
                        window.__cooptOpticalSystemRowsOverride = rows;
                        const prev = !!window.__cooptOptimizerIsRunning;
                        window.__cooptOptimizerIsRunning = true;
                        if (typeof window.__cooptRenderWindowRedraw === 'function') {{
                            window.__cooptRenderWindowRedraw(rows);
                        }} else if (typeof window.drawOpticalSystem === 'function') {{
                            window.drawOpticalSystem();
                        }}
                        setTimeout(() => {{
                            try {{
                                window.__cooptOptimizerIsRunning = prev;
                                window.__cooptOpticalSystemRowsOverride = null;
                            }} catch (_e) {{}}
                        }}, 450);
                    }}
                }} catch (_e) {{}}
                "#
        );

        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
}
