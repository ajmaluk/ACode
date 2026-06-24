mod git;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
        git::git_status,
        git::git_commit,
        git::git_log,
        git::git_branches,
        git::git_checkout,
        git::git_create_branch,
        git::git_diff_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
