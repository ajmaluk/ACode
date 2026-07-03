use serde::{Deserialize, Serialize};
use std::sync::{Mutex, LazyLock};

/// Thread-safe process-local environment variable store.
/// `std::env::set_var` is not thread-safe and causes UB when called
/// concurrently from Tauri's async runtime. This map provides a safe alternative.
static LOCAL_ENV: LazyLock<Mutex<std::collections::HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

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
/// Only allows http:/https: URLs and files within the home directory.
#[tauri::command]
pub async fn open_with_system_handler(path_or_url: String) -> Result<(), String> {
    let lower = path_or_url.to_lowercase();
    // Allow only http/https URLs
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return opener::open(&path_or_url).map_err(|e| format!("Failed to open URL '{path_or_url}': {e}"));
    }
    // For file paths, ensure they're within the home directory
    if lower.starts_with('/') || lower.starts_with("file://") {
        let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        let expanded = if lower.starts_with("file://") {
            path_or_url.trim_start_matches("file://").to_string()
        } else {
            path_or_url.clone()
        };
        let p = std::path::Path::new(&expanded);
        let canonical = std::fs::canonicalize(p)
            .map_err(|_| format!("Cannot access path: '{}'", path_or_url))?;
        if !canonical.starts_with(&home) {
            return Err(format!("Cannot open file outside home directory: '{}'", path_or_url));
        }
        return opener::open(&canonical).map_err(|e| format!("Failed to open '{path_or_url}': {e}"));
    }
    Err(format!("Cannot open '{}': only http/https URLs and local files are allowed", path_or_url))
}

/// Launch an application by name (e.g. "code", "firefox", "terminal").
/// On macOS, uses `open -a` for proper .app bundle launching.
/// On Windows, uses `cmd /c start` for non-blocking GUI launch.
/// On Linux, uses direct `Command::new()`.
#[tauri::command]
pub async fn launch_app(
    _app_handle: tauri::AppHandle,
    app_name: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    // Validate app_name: allow alphanumeric, dot, dash, underscore, slash (for absolute paths)
    if !app_name.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '/') {
        return Err(format!("Invalid app name: {}", app_name));
    }
    // If it contains a slash, it must be an absolute path
    if app_name.contains('/') && !app_name.starts_with('/') {
        return Err(format!("Invalid app name: {} (must be absolute path if containing /)", app_name));
    }
    // Reject dangerous characters in arguments
    if let Some(ref cmd_args) = args {
        for arg in cmd_args {
            if arg.contains(';') || arg.contains('|') || arg.contains('&')
                || arg.contains('$') || arg.contains('`') || arg.contains('\n')
                || arg.contains('\r') || arg.contains('\0')
                || arg.contains('{') || arg.contains('}') || arg.contains('~')
                || arg.contains('*') || arg.contains('?') || arg.contains('[')
                || arg.contains(']')
            {
                return Err(format!("Invalid argument: {}", arg));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, use `open -a` for .app bundles — this is the proper way to launch GUI apps.
        // `open -a` handles app activation, window focusing, and PATH resolution.
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-a").arg(&app_name);
        if let Some(ref cmd_args) = args {
            cmd.arg("--args");
            cmd.args(cmd_args);
        }
        if let Some(ref workdir) = cwd {
            cmd.current_dir(workdir);
        }
        let output = cmd.output().map_err(|e| format!("Failed to launch '{app_name}': {e}"))?;
        if !output.status.success() {
        let _stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Fall back to direct command spawn if `open -a` fails (e.g., CLI tools like vim)
            let mut fallback = std::process::Command::new(&app_name);
            if let Some(ref cmd_args) = args {
                fallback.args(cmd_args);
            }
            if let Some(ref workdir) = cwd {
                fallback.current_dir(workdir);
            }
            let child = fallback.spawn().map_err(|_| {
                format!("Failed to launch '{}': app not found and not in PATH", app_name)
            })?;
            return Ok(format!("Launched '{}' (pid {})", app_name, child.id()));
        }
        Ok(format!("Launched '{}'", app_name))
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, use `cmd /c start ""` for non-blocking GUI launch
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &app_name]);
        if let Some(ref cmd_args) = args {
            cmd.args(cmd_args);
        }
        if let Some(ref workdir) = cwd {
            cmd.current_dir(workdir);
        }
        let child = cmd.spawn().map_err(|e| format!("Failed to launch '{app_name}': {e}"))?;
        Ok(format!("Launched '{}' (pid {})", app_name, child.id()))
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, direct command spawn works well for most tools
        let mut cmd = std::process::Command::new(&app_name);
        if let Some(ref cmd_args) = args {
            cmd.args(cmd_args);
        }
        if let Some(ref workdir) = cwd {
            cmd.current_dir(workdir);
        }
        let child = cmd.spawn().map_err(|e| format!("Failed to launch '{app_name}': {e}"))?;
        Ok(format!("Launched '{}' (pid {})", app_name, child.id()))
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
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    let target = if p.is_file() {
        p.parent().unwrap_or(p)
    } else {
        p
    };
    opener::open(target).map_err(|e| format!("Failed to reveal in Finder: {e}"))
}

// ---------------------------------------------------------------------------
// Environment variable access
// ---------------------------------------------------------------------------

/// Get an environment variable value.
/// Checks the thread-safe local store first, then falls back to process env.
#[tauri::command]
pub async fn get_env(key: String) -> Result<String, String> {
    let blocked = ["AWS_SECRET_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_ACCESS_KEY_ID",
                   "GITHUB_TOKEN", "GITHUB_TOKEN_SECRET", "DATABASE_URL", "DATABASE_PASSWORD",
                   "REDIS_URL", "REDIS_PASSWORD", "MONGO_URL", "MONGO_PASSWORD",
                   "STRIPE_SECRET_KEY", "STRIPE_SECRET", "PAYPAL_CLIENT_SECRET",
                   "JWT_SECRET", "SECRET_KEY", "PRIVATE_KEY", "API_SECRET",
                   "ENCRYPTION_KEY", "SIGNING_KEY", "TOKEN_SECRET",
                   "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COHERE_API_KEY",
                   "HF_TOKEN", "SSH_AUTH_SOCK", "GPG_PASSPHRASE", "GPG_AGENT_INFO",
                   "KUBECONFIG", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
                   "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS"];
    let upper = key.to_uppercase();
    if blocked.iter().any(|b| upper == *b) {
        return Err(format!("Access to sensitive environment variable '{}' is restricted", key));
    }
    // Check thread-safe local store first
    if let Ok(map) = LOCAL_ENV.lock() {
        if let Some(val) = map.get(&key) {
            return Ok(val.clone());
        }
    }
    std::env::var(&key).map_err(|e| format!("Environment variable '{}' not set: {}", key, e))
}

/// Set an environment variable (stored in a thread-safe local map).
#[tauri::command]
pub async fn set_env(key: String, value: String) -> Result<(), String> {
    let blocked = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
                   "DYLD_LIBRARY_PATH", "HOME", "USER", "SHELL", "PYTHONPATH",
                   "NODE_OPTIONS", "BASH_ENV", "ENV", "CDPATH", "GLOBIGNORE",
                   "HISTFILE", "HISTSIZE", "HISTFILESIZE", "PROMPT_COMMAND",
                   "PS1", "PS2", "PS3", "PS4", "RUSTFLAGS", "CARGO_MAKEFLAGS",
                   "MAKEFLAGS", "CXXFLAGS", "PERL5OPT", "TMPDIR", "TMP", "TEMP",
                   "SSL_CERT_DIR", "SSL_CERT_FILE", "HTTP_PROXY", "HTTPS_PROXY",
                   "NO_PROXY", "EDITOR", "VISUAL", "GIT_EXEC_PATH",
                   "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
    if blocked.contains(&key.as_str()) {
        return Err(format!("Cannot set restricted environment variable: {}", key));
    }
    let mut map = LOCAL_ENV.lock().map_err(|e| format!("Env lock poisoned: {e}"))?;
    map.insert(key, value);
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
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("Failed to list processes: {e}"))?;

    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("ps")
        .args(["-eo", "pid,pcpu,rss,comm", "-m", "-r"])
        .output()
        .map_err(|e| format!("Failed to list processes: {e}"))?;

    #[cfg(target_os = "linux")]
    let output = std::process::Command::new("ps")
        .args(["-eo", "pid,pcpu,rss,comm", "--sort=-rss"])
        .output()
        .map_err(|e| format!("Failed to list processes: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut processes = Vec::new();

    #[cfg(target_os = "windows")]
    {
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
    }

    #[cfg(not(target_os = "windows"))]
    {
        for line in stdout.lines().skip(1).take(50) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let pid: u32 = parts[0].parse().unwrap_or(0);
                let cpu_usage: f32 = parts[1].parse().unwrap_or(0.0);
                let memory_kb: u64 = parts[2].parse().unwrap_or(0);
                let name = parts[3..].join(" ");
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

/// Kill a process by PID. Refuses to kill PID 0, PID 1, or the app's own PID.
#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    if pid == 0 || pid == 1 || pid == std::process::id() {
        return Err(format!("Refusing to kill critical process with PID {pid}"));
    }
    #[cfg(unix)]
    {
        let output = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill process {pid}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("Failed to kill process {}: {}", pid, stderr));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| format!("Failed to kill process {pid}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("Failed to kill process {}: {}", pid, stderr));
        }
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
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell Get-CimInstance (wmic is deprecated in Windows 10+)
        let drive_letter = path.chars().next().unwrap_or('C');
        let ps_script = format!(
            "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='{}:'\" | Select-Object Size,FreeSpace | ConvertTo-Json",
            drive_letter
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output()
            .map_err(|e| format!("Failed to get disk space: {e}"))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Parse JSON output: {"Size":123456,"FreeSpace":789012}
            if let Some(size_start) = stdout.find("\"Size\":") {
                let size_str = &stdout[size_start + 7..];
                if let Some(size_end) = size_str.find(',') {
                    let total: u64 = size_str[..size_end].trim().parse().unwrap_or(0);
                    if let Some(free_start) = stdout.find("\"FreeSpace\":") {
                        let free_str = &stdout[free_start + 12..];
                        if let Some(free_end) = free_str.find('}') {
                            let available: u64 = free_str[..free_end].trim().parse().unwrap_or(0);
                            return Ok(DiskSpace {
                                total_bytes: total,
                                available_bytes: available,
                                used_bytes: total.saturating_sub(available),
                            });
                        }
                    }
                }
            }
        }

        // Fallback to wmic if PowerShell fails
        let output = std::process::Command::new("wmic")
            .args(["logicaldisk", "where", &format!("DeviceID='{}:'", drive_letter)])
            .args(["get", "Size,FreeSpace", "/format:csv"])
            .output()
            .map_err(|e| format!("Failed to get disk space: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
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

        return Err("Failed to parse disk space output".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Canonicalize path to prevent df argument injection (e.g., path = "-a")
        let canon_path = std::fs::canonicalize(std::path::Path::new(&path))
            .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
        let output = std::process::Command::new("df")
            .arg("-k")
            .arg(&canon_path)
            .output()
            .map_err(|e| format!("Failed to get disk space: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
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

        return Err("Failed to parse disk space output".to_string());
    }
}

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------

/// Information about an available shell on the system.
#[derive(Serialize, Deserialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
}

/// Detect available shells on the system.
/// Returns a list of shells that are actually installed and accessible.
#[tauri::command]
pub async fn detect_available_shells() -> Result<Vec<ShellInfo>, String> {
    let mut shells = Vec::new();

    if cfg!(target_os = "windows") {
        // Windows: check for PowerShell, PowerShell Core, cmd, bash (Git Bash)
        let candidates = [
            ("powershell", "powershell", "PowerShell"),
            ("pwsh", "pwsh", "PowerShell Core"),
            ("cmd", "cmd", "Command Prompt"),
            ("bash", "bash", "Bash (Git)"),
        ];
        for (name, cmd, _label) in &candidates {
            if let Ok(output) = std::process::Command::new("where").arg(cmd).output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !path.is_empty() {
                        shells.push(ShellInfo {
                            name: name.to_string(),
                            path,
                        });
                    }
                }
            }
        }
    } else {
        // Unix: check /etc/shells and common paths
        let candidates = [
            ("bash", "/bin/bash"),
            ("zsh", "/bin/zsh"),
            ("fish", "/usr/bin/fish"),
            ("sh", "/bin/sh"),
        ];

        for (name, default_path) in &candidates {
            // First check if the binary exists at the default path
            if std::path::Path::new(default_path).exists() {
                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: default_path.to_string(),
                });
            } else {
                // Try to find it via `which`
                if let Ok(output) = std::process::Command::new("which").arg(name).output() {
                    if output.status.success() {
                        let path = String::from_utf8_lossy(&output.stdout)
                            .trim()
                            .to_string();
                        if !path.is_empty() && std::path::Path::new(&path).exists() {
                            shells.push(ShellInfo {
                                name: name.to_string(),
                                path,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(shells)
}

// ---------------------------------------------------------------------------
// Installed IDE detection
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct InstalledIde {
    pub name: String,
    pub command: String,
    pub kind: String,
}

/// Detect installed IDEs/editors on the system.
#[tauri::command]
pub async fn detect_installed_ides() -> Result<Vec<InstalledIde>, String> {
    let mut ides = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let apps_dir = std::path::PathBuf::from("/Applications");
        let home = dirs::home_dir().unwrap_or_default();
        let home_apps = home.join("Applications");

        // Check common .app bundles in /Applications and ~/Applications
        let ide_checks: Vec<(&str, &str, &str)> = vec![
            ("Visual Studio Code.app", "code", "VS Code"),
            ("Cursor.app", "cursor", "Cursor"),
            ("Zed.app", "zed", "Zed"),
            ("Sublime Text.app", "subl", "Sublime Text"),
            ("IntelliJ IDEA.app", "idea", "IntelliJ IDEA"),
            ("IntelliJ IDEA Ultimate.app", "idea", "IntelliJ IDEA Ultimate"),
            ("WebStorm.app", "webstorm", "WebStorm"),
            ("PyCharm.app", "pycharm", "PyCharm"),
            ("PyCharm Professional.app", "pycharm", "PyCharm Pro"),
            ("GoLand.app", "goland", "GoLand"),
            ("RustRover.app", "rustrover", "RustRover"),
            ("Android Studio.app", "studio", "Android Studio"),
            ("Nova.app", "nova", "Nova"),
            ("Xcode.app", "xcode", "Xcode"),
            ("Aqua.app", "aqua", "Aqua"),
            ("Fleet.app", "fleet", "Fleet"),
            ("DataGrip.app", "datagrip", "DataGrip"),
            ("DataSpell.app", "dataspell", "DataSpell"),
            ("CLion.app", "clion", "CLion"),
            ("RubyMine.app", "rubymine", "RubyMine"),
            ("PhpStorm.app", "phpstorm", "PhpStorm"),
        ];

        for (app_bundle, cmd, display_name) in &ide_checks {
            let path = apps_dir.join(app_bundle);
            let path2 = home_apps.join(app_bundle);
            if path.exists() || path2.exists() {
                // Try to get the actual binary path from the .app bundle
                let actual_cmd = if let Some(c) = resolve_macos_app_cmd(&apps_dir.join(app_bundle)) {
                    c
                } else if let Some(c) = resolve_macos_app_cmd(&path2) {
                    c
                } else {
                    cmd.to_string()
                };
                ides.push(InstalledIde {
                    name: display_name.to_string(),
                    command: actual_cmd,
                    kind: "ide".to_string(),
                });
            }
        }

        // Also check via `which` for command-line tools
        let which_ides: Vec<(&str, &str, &str)> = vec![
            ("code", "VS Code (CLI)", "cli"),
            ("cursor", "Cursor (CLI)", "cli"),
            ("zed", "Zed (CLI)", "cli"),
            ("subl", "Sublime Text (CLI)", "cli"),
            ("nano", "Nano", "terminal"),
            ("vim", "Vim", "terminal"),
            ("nvim", "Neovim", "terminal"),
            ("emacs", "Emacs", "terminal"),
            ("helix", "Helix", "terminal"),
        ];

        // Deduplicate by command
        let existing_cmds: std::collections::HashSet<String> = ides.iter().map(|i| i.command.clone()).collect();

        for (cmd, display_name, kind) in &which_ides {
            if !existing_cmds.contains(*cmd) {
                if let Ok(output) = std::process::Command::new("which").arg(cmd).output() {
                    if output.status.success() {
                        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        if !path.is_empty() && std::path::Path::new(&path).exists() {
                            ides.push(InstalledIde {
                                name: display_name.to_string(),
                                command: cmd.to_string(),
                                kind: kind.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let program_files = std::env::var("ProgramFiles").unwrap_or_default();
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

        let ide_checks: Vec<(&str, &str, &str)> = vec![
            ("Microsoft VS Code", "code", "VS Code"),
            ("Cursor", "cursor", "Cursor"),
            ("Sublime Text", "subl", "Sublime Text"),
            ("JetBrains", "idea", "IntelliJ IDEA"),
            ("Android Studio", "studio", "Android Studio"),
        ];

        for (dir_name, cmd, display_name) in &ide_checks {
            let p1 = std::path::PathBuf::from(&program_files).join(dir_name);
            let p2 = std::path::PathBuf::from(&program_files_x86).join(dir_name);
            let p3 = std::path::PathBuf::from(&local_app_data).join(dir_name);
            if p1.exists() || p2.exists() || p3.exists() {
                ides.push(InstalledIde {
                    name: display_name.to_string(),
                    command: cmd.to_string(),
                    kind: "ide".to_string(),
                });
            }
        }

        // Also try `where` for CLI tools
        let which_ides: Vec<(&str, &str, &str)> = vec![
            ("code", "VS Code (CLI)", "cli"),
            ("cursor", "Cursor (CLI)", "cli"),
            ("subl", "Sublime Text (CLI)", "cli"),
            ("notepad", "Notepad", "terminal"),
        ];

        let existing_cmds: std::collections::HashSet<String> = ides.iter().map(|i| i.command.clone()).collect();

        for (cmd, display_name, kind) in &which_ides {
            if !existing_cmds.contains(*cmd) {
                if let Ok(output) = std::process::Command::new("where").arg(cmd).output() {
                    if output.status.success() {
                        let path = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
                        if !path.is_empty() && std::path::Path::new(&path).exists() {
                            ides.push(InstalledIde {
                                name: display_name.to_string(),
                                command: cmd.to_string(),
                                kind: kind.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let which_ides: Vec<(&str, &str, &str)> = vec![
            ("code", "VS Code", "ide"),
            ("cursor", "Cursor", "ide"),
            ("zed", "Zed", "ide"),
            ("subl", "Sublime Text", "ide"),
            ("idea", "IntelliJ IDEA", "ide"),
            ("webstorm", "WebStorm", "ide"),
            ("pycharm", "PyCharm", "ide"),
            ("goland", "GoLand", "ide"),
            ("studio", "Android Studio", "ide"),
            ("nano", "Nano", "terminal"),
            ("vim", "Vim", "terminal"),
            ("nvim", "Neovim", "terminal"),
            ("emacs", "Emacs", "terminal"),
            ("helix", "Helix", "terminal"),
        ];

        for (cmd, display_name, kind) in &which_ides {
            if let Ok(output) = std::process::Command::new("which").arg(cmd).output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        ides.push(InstalledIde {
                            name: display_name.to_string(),
                            command: cmd.to_string(),
                            kind: kind.to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(ides)
}

#[cfg(target_os = "macos")]
fn resolve_macos_app_cmd(app_path: &std::path::Path) -> Option<String> {
    let macos_dir = app_path.join("Contents/MacOS");
    if let Ok(entries) = std::fs::read_dir(&macos_dir) {
        let files: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                !name.starts_with('.')
            })
            .collect();

        // Get the bundle name (e.g., "Visual Studio Code" from "Visual Studio Code.app")
        let bundle_name = app_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // Prefer the executable that matches the bundle name (case-insensitive)
        for entry in &files {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case(&bundle_name) {
                return Some(name);
            }
        }

        // Fallback: return the first non-hidden executable
        if let Some(entry) = files.first() {
            return Some(entry.file_name().to_string_lossy().to_string());
        }
    }
    None
}
