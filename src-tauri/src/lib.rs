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
    pub py: Arc<Mutex<PyState>>,
}

#[derive(Default)]
pub struct PyState {
    pub lines: Vec<String>,
    pub pending: Vec<String>,
    pub last_output: String,
    pub gen: u64, // 会话代数：py_start/py_stop 递增，用于丢弃过期结果
}

#[derive(serde::Serialize)]
pub struct PyReply {
    pub output: String,
    pub pending: bool,
}

impl AppState {
    fn new() -> Self {
        AppState {
            cwd: Arc::new(Mutex::new(
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            )),
            yt: Arc::new(Mutex::new(yt::Env::new())),
            py: Arc::new(Mutex::new(PyState::default())),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::read_file_content,
            commands::write_file_content,
            commands::open_folder_dialog,
            commands::save_file_dialog,
            commands::get_initial_dir,
            commands::shell_pwd,
            commands::shell_cd,
            commands::shell_ls,
            commands::shell_mkdir,
            commands::shell_rm,
            commands::yt_eval,
            commands::yt_reset,
            commands::get_workspace,
            commands::run_yt_file,
            commands::run_pyt_file,
            commands::py_start,
            commands::py_send,
            commands::py_stop,
        ])
        .setup(|app| {
            // 窗口可能尚未就绪，取不到不算致命错误
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
