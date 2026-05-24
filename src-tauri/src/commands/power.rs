use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};

static DISPLAY_SLEEP_BLOCKERS: LazyLock<Mutex<HashMap<String, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cleanup_finished_children(map: &mut HashMap<String, Child>) {
    let mut finished = Vec::<String>::new();
    for (token, child) in map.iter_mut() {
        match child.try_wait() {
            Ok(Some(_)) => finished.push(token.clone()),
            Ok(None) => {}
            Err(_) => finished.push(token.clone()),
        }
    }
    for token in finished {
        map.remove(&token);
    }
}

#[tauri::command]
pub fn start_prevent_display_sleep(token: String) -> Result<bool, String> {
    let key = token.trim().to_string();
    if key.is_empty() {
        return Err("sleep blocker token is required".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut blockers = DISPLAY_SLEEP_BLOCKERS
            .lock()
            .map_err(|_| "failed to lock display sleep blockers".to_string())?;
        cleanup_finished_children(&mut blockers);
        if blockers.contains_key(&key) {
            return Ok(true);
        }

        let child = Command::new("/usr/bin/caffeinate")
            .args(["-d", "-i", "-m"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to start caffeinate: {e}"))?;

        blockers.insert(key, child);
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Ok(false)
    }
}

#[tauri::command]
pub fn stop_prevent_display_sleep(token: String) -> Result<bool, String> {
    let key = token.trim().to_string();
    if key.is_empty() {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        let mut blockers = DISPLAY_SLEEP_BLOCKERS
            .lock()
            .map_err(|_| "failed to lock display sleep blockers".to_string())?;
        cleanup_finished_children(&mut blockers);
        let Some(mut child) = blockers.remove(&key) else {
            return Ok(false);
        };

        let _ = child.kill();
        let _ = child.wait();
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Ok(false)
    }
}