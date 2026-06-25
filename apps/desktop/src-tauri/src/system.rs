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

// ---------------------------------------------------------------------------
// Reveal in Finder / Explorer
// ---------------------------------------------------------------------------

/// Reveal a file or directory in the native file manager.
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_file() {
        std::path::Path::new(&path)
            .parent()
            .unwrap_or(p)
    } else {
        p
    };
    opener::open(target).map_err(|e| format!("Failed to reveal in Finder: {e}"))
}

// ---------------------------------------------------------------------------
// Environment variable access
// ---------------------------------------------------------------------------

/// Get an environment variable value.
#[tauri::command]
pub async fn get_env(key: String) -> Result<String, String> {
    std::env::var(&key).map_err(|e| format!("Environment variable '{key}' not found: {e}"))
}

/// Set an environment variable (for the current process and child processes).
#[tauri::command]
pub async fn set_env(key: String, value: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        // SAFETY: Used only for passing env to child processes spawned by the agent.
        // Each Tauri command runs sequentially within its execution context.
        std::env::set_var(&key, &value);
    }
    #[cfg(windows)]
    {
        // Set environment variable for the current process.
        // This affects child processes spawned from this process.
        // For persistence across restarts, use setx command instead.
        std::env::set_var(&key, &value);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Screen / display information
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ScreenInfo {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

/// Get primary screen dimensions.
#[tauri::command]
pub async fn get_screen_info(app: tauri::AppHandle) -> Result<ScreenInfo, String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get screen info: {e}"))?
        .ok_or_else(|| "No primary monitor found".to_string())?;
    let size = monitor.size();
    Ok(ScreenInfo {
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
    })
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory_kb: u64,
}

/// List running processes (top 50 by memory).
#[tauri::command]
pub async fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map_err(|e| format!("Failed to list processes: {e}"))?
    } else {
        std::process::Command::new("ps")
            .args(["aux", "--sort=-rss"])
            .output()
            .map_err(|e| format!("Failed to list processes: {e}"))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut processes = Vec::new();

    if cfg!(target_os = "windows") {
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 5 {
                let name = parts[0].trim_matches('"').to_string();
                let pid: u32 = parts[1].trim_matches('"').parse().unwrap_or(0);
                let mem_str = parts[4].trim_matches('"').replace(',', "").replace(" K", "");
                let memory_kb: u64 = mem_str.parse().unwrap_or(0);
                processes.push(ProcessInfo {
                    pid,
                    name,
                    cpu_usage: 0.0,
                    memory_kb,
                });
            }
        }
    } else {
        for line in stdout.lines().skip(1).take(50) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 11 {
                let cpu_usage: f32 = parts[2].parse().unwrap_or(0.0);
                let memory_kb: u64 = parts[5].parse().unwrap_or(0);
                let pid: u32 = parts[1].parse().unwrap_or(0);
                let name = parts[10..].join(" ");
                processes.push(ProcessInfo {
                    pid,
                    name,
                    cpu_usage,
                    memory_kb,
                });
            }
        }
    }

    Ok(processes)
}

/// Kill a process by PID.
#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill process {pid}: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| format!("Failed to kill process {pid}: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Err("Process management not supported on this platform".to_string())
    }
}

// ---------------------------------------------------------------------------
// Disk space information
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

/// Get disk space for a given path.
#[tauri::command]
pub async fn get_disk_space(path: String) -> Result<DiskSpace, String> {
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("wmic")
            .args(["logicaldisk", "where", &format!("DeviceID='{}:'", path.chars().next().unwrap_or('C'))])
            .args(["get", "Size,FreeSpace", "/format:csv"])
            .output()
            .map_err(|e| format!("Failed to get disk space: {e}"))?
    } else {
        std::process::Command::new("df")
            .arg("-k")
            .arg(&path)
            .output()
            .map_err(|e| format!("Failed to get disk space: {e}"))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if cfg!(target_os = "windows") {
        let lines: Vec<&str> = stdout.lines().filter(|l| !l.is_empty() && !l.starts_with("Node")).collect();
        if let Some(line) = lines.last() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 3 {
                let available: u64 = parts[1].trim().parse().unwrap_or(0);
                let total: u64 = parts[2].trim().parse().unwrap_or(0);
                return Ok(DiskSpace {
                    total_bytes: total,
                    available_bytes: available,
                    used_bytes: total.saturating_sub(available),
                });
            }
        }
    } else {
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let total_kb: u64 = parts[1].parse().unwrap_or(0);
                let available_kb: u64 = parts[3].parse().unwrap_or(0);
                return Ok(DiskSpace {
                    total_bytes: total_kb * 1024,
                    available_bytes: available_kb * 1024,
                    used_bytes: (total_kb.saturating_sub(available_kb)) * 1024,
                });
            }
        }
    }

    Err("Failed to parse disk space output".to_string())
}
