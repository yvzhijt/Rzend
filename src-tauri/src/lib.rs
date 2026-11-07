use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

mod commands;
mod terminal;
mod yt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<DirEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceVar {
    pub name: String,
    pub value: String,
    pub var_type: String,
    pub size: String,
}

pub struct AppState {
    pub cwd: Arc<Mutex<PathBuf>>,
    pub yt: Arc<Mutex<yt::Env>>,
    pub circuit_pending: Arc<Mutex<Option<String>>>,
    pub signal_pending: Arc<Mutex<Option<String>>>,
    pub terminal: terminal::TerminalSlot,
}

impl AppState {
    fn new() -> Self {
        AppState {
            cwd: Arc::new(Mutex::new(
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            )),
            yt: Arc::new(Mutex::new(yt::Env::new())),
            circuit_pending: Arc::new(Mutex::new(None)),
            signal_pending: Arc::new(Mutex::new(None)),
            terminal: terminal::new_slot(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::read_file_content,
            commands::read_image_preview,
            commands::transform_image,
            commands::write_file_content,
            commands::create_file,
            commands::open_folder_dialog,
            commands::open_file_dialog,
            commands::open_circuit_window,
            commands::take_circuit_pending,
            commands::close_circuit_window,
            commands::open_signal_window,
            commands::take_signal_pending,
            commands::close_signal_window,
            commands::save_file_dialog,
            commands::get_initial_dir,
            commands::shell_pwd,
            commands::shell_cd,
            commands::shell_ls,
            commands::shell_mkdir,
            commands::shell_rm,
            commands::shell_spawn,
            commands::save_workspace,
            commands::yt_eval,
            commands::yt_reset,
            commands::get_workspace,
            commands::run_yt_file,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_sync_cwd,
            terminal::pty_kill,
        ])
        .setup(|app| {
            // 窗口可能尚未就绪，取不到不算致命错误
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // 退出前杀掉内嵌 cmd.exe，避免残留孤儿进程
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<AppState>();
            terminal::kill_existing(&state.terminal);
        }
    });
}
