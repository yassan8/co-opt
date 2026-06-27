use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
struct PowerBlocker {
    caffeinate_child: Child,
    app_activity: Option<usize>,
}

#[cfg(not(target_os = "macos"))]
type PowerBlocker = Child;

static DISPLAY_SLEEP_BLOCKERS: LazyLock<Mutex<HashMap<String, PowerBlocker>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(target_os = "macos")]
const NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED: u64 = 1 << 20;
#[cfg(target_os = "macos")]
const NS_ACTIVITY_SUDDEN_TERMINATION_DISABLED: u64 = 1 << 14;
#[cfg(target_os = "macos")]
const NS_ACTIVITY_AUTOMATIC_TERMINATION_DISABLED: u64 = 1 << 15;
#[cfg(target_os = "macos")]
const NS_ACTIVITY_USER_INITIATED: u64 = 0x00FF_FFFF | NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED;

#[cfg(target_os = "macos")]
fn begin_optimizer_activity(reason: &str) -> Option<usize> {
    unsafe {
        let process_info: id = msg_send![class!(NSProcessInfo), processInfo];
        if process_info == nil {
            return None;
        }
        let reason_ns = NSString::alloc(nil).init_str(reason);
        let options = NS_ACTIVITY_USER_INITIATED
            | NS_ACTIVITY_SUDDEN_TERMINATION_DISABLED
            | NS_ACTIVITY_AUTOMATIC_TERMINATION_DISABLED;
        let activity: id = msg_send![process_info, beginActivityWithOptions: options reason: reason_ns];
        if activity == nil {
            None
        } else {
            Some(activity as usize)
        }
    }
}

#[cfg(target_os = "macos")]
fn end_optimizer_activity(activity: usize) {
    unsafe {
        let process_info: id = msg_send![class!(NSProcessInfo), processInfo];
        if process_info == nil {
            return;
        }
        let activity_id = activity as id;
        if activity_id != nil {
            let _: () = msg_send![process_info, endActivity: activity_id];
        }
    }
}

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

#[cfg(target_os = "macos")]
fn cleanup_finished_blockers(map: &mut HashMap<String, PowerBlocker>) {
    let mut finished = Vec::<String>::new();
    for (token, blocker) in map.iter_mut() {
        match blocker.caffeinate_child.try_wait() {
            Ok(Some(_)) => finished.push(token.clone()),
            Ok(None) => {}
            Err(_) => finished.push(token.clone()),
        }
    }
    for token in finished {
        if let Some(mut blocker) = map.remove(&token) {
            if let Some(activity) = blocker.app_activity.take() {
                end_optimizer_activity(activity);
            }
            let _ = blocker.caffeinate_child.kill();
            let _ = blocker.caffeinate_child.wait();
        }
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
        cleanup_finished_blockers(&mut blockers);
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

        let app_activity = begin_optimizer_activity("co-opt optimization in progress");

        blockers.insert(
            key,
            PowerBlocker {
                caffeinate_child: child,
                app_activity,
            },
        );
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
        cleanup_finished_blockers(&mut blockers);
        let Some(mut blocker) = blockers.remove(&key) else {
            return Ok(false);
        };

        if let Some(activity) = blocker.app_activity.take() {
            end_optimizer_activity(activity);
        }
        let _ = blocker.caffeinate_child.kill();
        let _ = blocker.caffeinate_child.wait();
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Ok(false)
    }
}