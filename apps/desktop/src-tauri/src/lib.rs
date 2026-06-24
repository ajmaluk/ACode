mod git;
mod system;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_sql::Builder::default().build())
    .invoke_handler(tauri::generate_handler![
        // Git commands
        git::git_status,
        git::git_commit,
        git::git_log,
        git::git_branches,
        git::git_checkout,
        git::git_create_branch,
        git::git_diff_file,
        // System commands
        system::clipboard_read_text,
        system::clipboard_write_text,
        system::clipboard_has_image,
        system::notify,
        system::system_get_info,
        system::get_working_dir,
        system::open_with_system_handler,
        system::launch_app,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
