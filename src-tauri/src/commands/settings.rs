use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app_data_dir: {e}"))?;
    Ok(dir.join("coopt-desktop-settings.json"))
}

fn read_settings_map(path: &PathBuf) -> Result<BTreeMap<String, String>, String> {
    let text = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                return Ok(BTreeMap::new());
            }
            return Err(format!("failed to read settings file: {err}"));
        }
    };

    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("failed to parse settings json: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "settings json must be an object".to_string())?;

    let mut out = BTreeMap::<String, String>::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            out.insert(k.clone(), s.to_string());
        }
    }
    Ok(out)
}

fn write_settings_map(path: &PathBuf, map: &BTreeMap<String, String>) -> Result<(), String> {
    let value = serde_json::to_string_pretty(map)
        .map_err(|e| format!("failed to serialize settings json: {e}"))?;
    fs::write(path, value).map_err(|e| format!("failed to write settings file: {e}"))
}

pub fn ensure_desktop_settings_file(app: &AppHandle) -> Result<String, String> {
    let path = settings_file_path(app)?;
    if !path.exists() {
        let map = BTreeMap::<String, String>::new();
        write_settings_map(&path, &map)?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_desktop_settings_path(app: AppHandle) -> Result<String, String> {
    ensure_desktop_settings_file(&app)
}

#[tauri::command]
pub fn read_desktop_setting(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let path = settings_file_path(&app)?;
    let map = read_settings_map(&path)?;
    Ok(map.get(key).cloned())
}

#[tauri::command]
pub fn write_desktop_setting(
    app: AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }

    let path = settings_file_path(&app)?;
    let mut map = read_settings_map(&path)?;
    match value {
        Some(v) => {
            let vv = v.trim().to_string();
            if vv.is_empty() {
                map.remove(&key);
            } else {
                map.insert(key, vv);
            }
        }
        None => {
            map.remove(&key);
        }
    }
    write_settings_map(&path, &map)
}
