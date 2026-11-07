// shell 命令：pwd / cd / ls / mkdir / rm / 子进程 spawn

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::AppState;
use crate::DirEntry;
use crate::commands::{blocking, lock, resolve_path};

#[tauri::command]
pub fn shell_pwd(state: State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}

#[tauri::command]
pub fn shell_cd(
    state: State<'_, AppState>,
    path: String,
    _force: Option<bool>,
) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    let target = {
        let cur = lock(&cwd);
        resolve_path(&cur, &path)
    };
    if !target.exists() {
        return Err(format!("路径不存在: {}", target.display()));
    }
    if !target.is_dir() {
        return Err(format!("不是文件夹: {}", target.display()));
    }
    let canonical = target.canonicalize().unwrap_or(target);
    // 入库前剥掉 Windows canonicalize 产生的 \\?\ 前缀，保证 pwd 与存储一致
    let s = canonical.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s);
    *lock(&cwd) = PathBuf::from(&s);
    Ok(s)
}

#[tauri::command]
pub async fn shell_ls(state: State<'_, AppState>) -> Result<Vec<DirEntry>, String> {
    let cur = lock(&state.inner().cwd).clone();
    blocking(move || {
        let read_dir = fs::read_dir(&cur)
            .map_err(|e| format!("读取文件夹失败 {}: {}", cur.display(), e))?;
        let mut entries = Vec::new();
        for entry in read_dir {
            let entry = entry
                .map_err(|e| format!("读取文件夹内容失败 {}: {}", cur.display(), e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let is_dir = entry
                .file_type()
                .map_err(|e| format!("读取文件类型失败 {}: {}", entry.path().display(), e))?
                .is_dir();
            entries.push(DirEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
                children: None,
            });
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
        Ok(entries)
    })
    .await?
}

#[tauri::command]
pub async fn shell_mkdir(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let target = {
            let cur = lock(&cwd);
            resolve_path(&cur, &name)
        };
        fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败: {}", e))?;
        Ok(format!("已创建: {}", target.display()))
    })
    .await?
}

#[tauri::command]
pub async fn shell_rm(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let target = {
            let cur = lock(&cwd);
            resolve_path(&cur, &name)
        };
        if !target.exists() {
            return Err(format!("路径不存在: {}", target.display()));
        }
        let canonical = target.canonicalize().unwrap_or(target.clone());
        // 拒绝删除磁盘根目录
        if canonical.parent().is_none() {
            return Err("不能删除磁盘根目录".to_string());
        }
        // 拒绝删除当前目录及其祖先目录（如 del .. / del ..\..）
        let cur = lock(&cwd).clone();
        let cwd_canon = cur.canonicalize().unwrap_or(cur);
        if cwd_canon.starts_with(&canonical) {
            return Err("不能删除当前所在目录或其上级目录".to_string());
        }
        if target.is_dir() {
            fs::remove_dir_all(&target).map_err(|e| format!("删除文件夹失败: {}", e))?;
            Ok(format!("已删除文件夹: {}", target.display()))
        } else {
            fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))?;
            Ok(format!("已删除: {}", target.display()))
        }
    })
    .await?
}

/// 启动一个子进程，通过 Tauri 事件 `shell-output` 推送 stdout/stderr。
/// payload: { key, text, line_break, cmd }，cmd 为 "stdout_start" / "stderr_start" / "stdout_data"。
/// 进程结束时发送 { key, text: null }。
#[tauri::command]
pub async fn shell_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    cwd: Option<String>,
) -> Result<String, String> {
    use std::process::Stdio;
    use tauri::Emitter;

    let working_dir = {
        if let Some(c) = cwd {
            PathBuf::from(c)
        } else {
            lock(&state.inner().cwd).clone()
        }
    };

    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.args(["/C", &command])
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let key = format!("shell_{}", std::process::id());

    let app_handle = app.clone();
    let key_clone = key.clone();

    blocking(move || {
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动命令失败: {}", e))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // stdout 线程
        if let Some(mut stdout) = stdout {
            let app = app_handle.clone();
            let key = key_clone.clone();
            let _ = app.emit("shell-output", serde_json::json!({
                "key": key, "text": "", "line_break": false, "cmd": "stdout_start"
            }));
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit("shell-output", serde_json::json!({
                                "key": key, "text": text, "line_break": true, "cmd": "stdout_data"
                            }));
                        }
                        Err(_) => break,
                    }
                }
                let _ = app.emit("shell-output", serde_json::json!({
                    "key": key, "text": null, "line_break": false, "cmd": "exit"
                }));
            });
        }

        // stderr 线程
        if let Some(mut stderr) = stderr {
            let app = app_handle.clone();
            let key = key_clone.clone();
            let _ = app.emit("shell-output", serde_json::json!({
                "key": key, "text": "", "line_break": false, "cmd": "stderr_start"
            }));
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit("shell-output", serde_json::json!({
                                "key": key, "text": text, "line_break": true, "cmd": "stderr_data"
                            }));
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let _ = child.wait();
        Ok(key_clone)
    })
    .await?
}
