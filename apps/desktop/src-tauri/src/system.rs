use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Clipboard commands
// ---------------------------------------------------------------------------

/// Read text from the system clipboard.
#[tauri::command]
pub async fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| format!("Failed to read clipboard: {e}"))
}

/// Write text to the system clipboard.
#[tauri::command]
pub async fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("Failed to write clipboard: {e}"))
}

// ---------------------------------------------------------------------------
// Notification commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Send a desktop notification.
#[tauri::command]
pub async fn notify(app: tauri::AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app
        .notification()
        .builder()
        .title(&payload.title)
        .body(&payload.body);
    if let Some(ref icon) = payload.icon {
        builder = builder.icon(icon);
    }
    builder
        .show()
        .map_err(|e| format!("Failed to show notification: {e}"))
}

// ---------------------------------------------------------------------------
// System info commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub home_dir: String,
    pub shell: String,
    pub locale: Option<String>,
}

/// Get system information.
#[tauri::command]
pub async fn system_get_info(_app: tauri::AppHandle) -> Result<SystemInfo, String> {
    use std::env;
    let os = env::consts::OS.to_string();
    let arch = env::consts::ARCH.to_string();

    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let home_dir = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let shell = if cfg!(windows) {
        env::var("COMSPEC").unwrap_or_else(|_| "powershell".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };

    let locale = env::var("LANG")
        .or_else(|_| env::var("LC_ALL"))
        .ok();

    Ok(SystemInfo {
        os,
        arch,
        hostname,
        home_dir,
        shell,
        locale,
    })
}

/// Get the current working directory for a new terminal.
#[tauri::command]
pub async fn get_working_dir(_app: tauri::AppHandle) -> Result<String, String> {
    use std::env;
    env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get working directory: {e}"))
}

// ---------------------------------------------------------------------------
// App launching commands
// ---------------------------------------------------------------------------

/// Open a URL or file with the system default handler.
#[tauri::command]
pub async fn open_with_system_handler(path_or_url: String) -> Result<(), String> {
    opener::open(&path_or_url).map_err(|e| format!("Failed to open '{path_or_url}': {e}"))
}

/// Launch an application by name (e.g. "code", "firefox", "terminal").
/// Uses `opener::open` for URL-like targets, and `std::process::Command`
/// for local executables with optional arguments.
#[tauri::command]
pub async fn launch_app(
    _app_handle: tauri::AppHandle,
    app_name: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&app_name);
    if let Some(ref cmd_args) = args {
        cmd.args(cmd_args);
    }
    if let Some(ref workdir) = cwd {
        cmd.current_dir(workdir);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute '{app_name}': {e}"))?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.is_empty() {
            Ok(stdout)
        } else {
            Ok(format!("{stdout}\n{stderr}"))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("'{app_name}' exited with error: {stderr}"))
    }
}

// ---------------------------------------------------------------------------
// Clipboard file operations
// ---------------------------------------------------------------------------

/// Check if there's an image in the clipboard.
/// TODO: Full image support when Tauri clipboard manager adds image reads.
#[tauri::command]
pub async fn clipboard_has_image(_app: tauri::AppHandle) -> Result<bool, String> {
    Ok(false)
}
