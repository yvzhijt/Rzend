use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

mod commands;
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
    pub terminal: commands::terminal::TerminalSlot,
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
            terminal: commands::terminal::new_slot(),
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
            commands::fs::scan_directory,
            commands::fs::read_file_content,
            commands::image::read_image_preview,
            commands::image::transform_image,
            commands::fs::write_file_content,
            commands::fs::create_file,
            commands::windows::open_folder_dialog,
            commands::windows::open_file_dialog,
            commands::windows::open_circuit_window,
            commands::windows::take_circuit_pending,
            commands::windows::close_circuit_window,
            commands::windows::open_signal_window,
            commands::windows::take_signal_pending,
            commands::windows::close_signal_window,
            commands::windows::save_file_dialog,
            commands::windows::get_initial_dir,
            commands::shell::shell_pwd,
            commands::shell::shell_cd,
            commands::shell::shell_ls,
            commands::shell::shell_mkdir,
            commands::shell::shell_rm,
            commands::shell::shell_spawn,
            commands::yt_cmds::save_workspace,
            commands::yt_cmds::yt_eval,
            commands::yt_cmds::yt_reset,
            commands::yt_cmds::get_workspace,
            commands::yt_cmds::run_yt_file,
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_sync_cwd,
            commands::terminal::pty_kill,
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
            commands::terminal::kill_existing(&state.terminal);
        }
    });
}
