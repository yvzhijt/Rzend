// 文件对话框与仿真窗口（电路 / 信号）的打开、聚焦、关闭

use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;
use crate::commands::lock;

#[tauri::command]
pub async fn open_folder_dialog(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    match path {
        Some(p) => Ok(p.to_string()),
        None => Err("未选择文件夹".to_string()),
    }
}

/// 打开文件对话框：返回用户选择的完整路径，取消时返回空字符串
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle, ext: Option<String>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = ext.unwrap_or_else(|| "ckt".to_string());
    let label = if ext.eq_ignore_ascii_case("sig") {
        "信号流图文件"
    } else if ext.eq_ignore_ascii_case("yt") {
        "YT 脚本文件"
    } else {
        "电路仿真文件"
    };
    Ok(app
        .dialog()
        .file()
        .add_filter(label, &[ext.as_str()])
        .blocking_pick_file()
        .map(|p| p.to_string())
        .unwrap_or_default())
}

/// 打开（或聚焦）电路仿真窗口；path 非空时让窗口载入该 .ckt
#[tauri::command]
pub async fn open_circuit_window(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    {
        let mut pending = lock(&state.inner().circuit_pending);
        *pending = path.clone();
    }
    if let Some(existing) = app.get_webview_window("circuit") {
        existing.set_focus().map_err(|e| e.to_string())?;
        if let Some(p) = path {
            app.emit("rzend:open-ckt", p).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "circuit", tauri::WebviewUrl::App("ckt.html".into()))
        .title("Rzend仿真")
        .inner_size(1180.0, 760.0)
        .min_inner_size(880.0, 560.0)
        .build()
        .map_err(|e| format!("无法创建电路仿真窗口: {}", e))?;
    Ok(())
}

/// 取出并清空挂起的 .ckt 路径（电路窗口启动时调用）
#[tauri::command]
pub fn take_circuit_pending(state: State<'_, AppState>) -> Option<String> {
    lock(&state.inner().circuit_pending).take()
}

/// 关闭电路仿真窗口
#[tauri::command]
pub fn close_circuit_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("circuit") {
        Some(window) => window.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 打开（或聚焦）信号系统窗口；path 非空时让窗口载入该 .sig
#[tauri::command]
pub async fn open_signal_window(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    {
        let mut pending = lock(&state.inner().signal_pending);
        *pending = path.clone();
    }
    if let Some(existing) = app.get_webview_window("signal") {
        existing.set_focus().map_err(|e| e.to_string())?;
        if let Some(p) = path {
            app.emit("rzend:open-sig", p).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "signal", tauri::WebviewUrl::App("sig.html".into()))
        .title("Rzend 信号系统仿真")
        .inner_size(1180.0, 760.0)
        .min_inner_size(880.0, 560.0)
        .build()
        .map_err(|e| format!("无法创建信号系统窗口: {}", e))?;
    Ok(())
}

/// 取出并清空挂起的 .sig 路径（信号窗口启动时调用）
#[tauri::command]
pub fn take_signal_pending(state: State<'_, AppState>) -> Option<String> {
    lock(&state.inner().signal_pending).take()
}

/// 关闭信号系统窗口
#[tauri::command]
pub fn close_signal_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("signal") {
        Some(window) => window.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 另存为对话框：返回用户选择的完整路径，取消时返回空字符串
#[tauri::command]
pub async fn save_file_dialog(
    app: AppHandle,
    default_name: Option<String>,
    ext: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = ext.unwrap_or_else(|| "ckt".to_string());
    let label = if ext.eq_ignore_ascii_case("png") {
        "PNG 图片"
    } else if ext.eq_ignore_ascii_case("sig") {
        "信号流图文件"
    } else {
        "电路仿真文件"
    };
    let mut builder = app.dialog().file().add_filter(label, &[ext.as_str()]);
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    Ok(builder
        .blocking_save_file()
        .map(|p| p.to_string())
        .unwrap_or_default())
}

#[tauri::command]
pub fn get_initial_dir(state: State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}
