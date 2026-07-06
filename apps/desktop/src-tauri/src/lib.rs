mod git;
mod system;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(if cfg!(debug_assertions) {
          log::LevelFilter::Debug
        } else {
          log::LevelFilter::Warn
        })
        .build(),
    )
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_deep_link::init())
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
        system::clipboard_read_image,
        system::notify,
        system::system_get_info,
        system::get_working_dir,
        system::open_with_system_handler,
        system::launch_app,
        system::reveal_in_finder,
        system::get_env,
        system::set_env,
        system::get_screen_info,
        system::list_processes,
        system::kill_process,
        system::get_disk_space,
        system::detect_available_shells,
        system::detect_installed_ides,
    ])
    .run(tauri::generate_context!())
    .unwrap_or_else(|e| {
        eprintln!("Error running Dalam: {}", e);
        std::process::exit(1);
    });
}
