use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::yt::{EvalOutput, EvalResult};
use crate::{AppState, DirEntry, WorkspaceVar};
use base64::Engine;
use image::GenericImageView;

/// 锁毒化恢复：panic 已被 catch_unwind 捕获时，锁内数据仍然可用
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 把阻塞任务放到线程池执行，统一处理任务失败（panic 等）
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))
}

// ---------------- 路径工具 ----------------

pub fn resolve_path(cwd: &Path, p: &str) -> PathBuf {
    let p = p.trim().trim_matches('"');
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

// ---------------- 文件浏览 ----------------

fn scan_directory_sync(path: &Path) -> Result<Vec<DirEntry>, String> {
    let read_dir =
        fs::read_dir(path).map_err(|e| format!("读取文件夹失败 {}: {}", path.display(), e))?;
    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("读取文件夹内容失败 {}: {}", path.display(), e))?;
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
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || scan_directory_sync(Path::new(&path))).await?
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    blocking(move || fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))).await?
}

#[derive(serde::Serialize)]
pub struct ImagePreview {
    data_url: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn read_image_preview(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<ImagePreview, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let full = resolve_path(&lock(&cwd), &path);
        let metadata = fs::metadata(&full)
            .map_err(|error| format!("读取图片失败 {}: {}", full.display(), error))?;
        if !metadata.is_file() {
            return Err(format!("不是文件: {}", full.display()));
        }
        if metadata.len() > 32 * 1024 * 1024 {
            return Err("图片文件超过 32 MiB，无法预览".to_string());
        }

        let mut reader = image::ImageReader::open(&full)
            .map_err(|error| format!("无法打开图片 {}: {}", full.display(), error))?
            .with_guessed_format()
            .map_err(|error| format!("无法识别图片格式 {}: {}", full.display(), error))?;
        let format = reader
            .format()
            .ok_or_else(|| format!("无法识别图片格式: {}", full.display()))?;
        let mime = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Bmp => "image/bmp",
            image::ImageFormat::Ico => "image/x-icon",
            _ => return Err(format!("不支持预览此图片格式: {}", full.display())),
        };
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|error| format!("无法解码图片 {}: {}", full.display(), error))?;
        let (width, height) = (decoded.width(), decoded.height());
        let bytes = fs::read(&full)
            .map_err(|error| format!("读取图片失败 {}: {}", full.display(), error))?;
        Ok(ImagePreview {
            data_url: format!(
                "data:{};base64,{}",
                mime,
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            width,
            height,
        })
    })
    .await?
}

#[derive(Clone, serde::Deserialize)]
pub struct ImageOperation {
    kind: String,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
}

fn transform_image_sync(
    source: &Path,
    operations: Vec<ImageOperation>,
    output: Option<PathBuf>,
) -> Result<ImagePreview, String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("读取图片失败 {}: {}", source.display(), error))?;
    if !metadata.is_file() {
        return Err(format!("不是文件: {}", source.display()));
    }
    if metadata.len() > 32 * 1024 * 1024 {
        return Err("图片文件超过 32 MiB，无法编辑".to_string());
    }
    let mut reader = image::ImageReader::open(source)
        .map_err(|error| format!("无法打开图片 {}: {}", source.display(), error))?
        .with_guessed_format()
        .map_err(|error| format!("无法识别图片格式 {}: {}", source.display(), error))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader
        .decode()
        .map_err(|error| format!("无法解码图片 {}: {}", source.display(), error))?;
    if u64::from(image.width()) * u64::from(image.height()) > 8_388_608 {
        return Err("图片像素数量过大，最多支持 8388608 个像素".to_string());
    }

    for operation in operations {
        match operation.kind.as_str() {
            "crop" => {
                let x = operation.x.ok_or_else(|| "裁剪位置无效".to_string())?;
                let y = operation.y.ok_or_else(|| "裁剪位置无效".to_string())?;
                let width = operation.width.ok_or_else(|| "裁剪宽度无效".to_string())?;
                let height = operation.height.ok_or_else(|| "裁剪高度无效".to_string())?;
                if width == 0
                    || height == 0
                    || x.checked_add(width)
                        .map_or(true, |right| right > image.width())
                    || y.checked_add(height)
                        .map_or(true, |bottom| bottom > image.height())
                {
                    return Err("裁剪区域超出图片范围".to_string());
                }
                image = image.crop_imm(x, y, width, height);
            }
            "resize" => {
                let width = operation.width.ok_or_else(|| "缩放宽度无效".to_string())?;
                let height = operation.height.ok_or_else(|| "缩放高度无效".to_string())?;
                if width == 0
                    || height == 0
                    || width > 16_384
                    || height > 16_384
                    || u64::from(width) * u64::from(height) > 8_388_608
                {
                    return Err(
                        "缩放尺寸无效：最多支持 16384×16384 且不超过 8388608 个像素".to_string()
                    );
                }
                image = image.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
            }
            "rotate_left" => image = image.rotate270(),
            "rotate_right" => image = image.rotate90(),
            "grayscale" => image = image.grayscale(),
            "blur" => image = image.blur(2.0),
            "sharpen" => image = image.unsharpen(1.0, 1),
            "brighten" => image = image.brighten(30),
            "darken" => image = image.brighten(-30),
            "contrast" => image = image.adjust_contrast(25.0),
            "invert" => image.invert(),
            kind => return Err(format!("不支持的图片操作: {}", kind)),
        }
    }

    let saving = output.is_some();
    if let Some(output) = output {
        let source_canonical = source
            .canonicalize()
            .map_err(|error| format!("无法解析源图片路径: {}", error))?;
        let output_canonical = if output.exists() {
            output.canonicalize()
        } else {
            output
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .canonicalize()
                .map(|parent| parent.join(output.file_name().unwrap_or_default()))
        }
        .map_err(|error| format!("无法解析保存路径: {}", error))?;
        if source_canonical == output_canonical {
            return Err("另存为路径不能覆盖原图片".to_string());
        }
        let format = image::ImageFormat::from_path(&output)
            .map_err(|error| format!("无法识别保存图片格式: {}", error))?;
        image
            .save_with_format(&output, format)
            .map_err(|error| format!("保存图片失败 {}: {}", output.display(), error))?;
    }

    let (width, height) = image.dimensions();
    if saving {
        return Ok(ImagePreview {
            data_url: String::new(),
            width,
            height,
        });
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("生成图片预览失败: {}", error))?;
    Ok(ImagePreview {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        ),
        width,
        height,
    })
}

#[tauri::command]
pub async fn transform_image(
    state: tauri::State<'_, AppState>,
    path: String,
    operations: Vec<ImageOperation>,
    output_path: Option<String>,
) -> Result<ImagePreview, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let current_dir = lock(&cwd);
        let source = resolve_path(&current_dir, &path);
        let output = output_path.map(|path| resolve_path(&current_dir, &path));
        drop(current_dir);
        transform_image_sync(&source, operations, output)
    })
    .await?
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    blocking(move || fs::write(&path, &content).map_err(|e| format!("保存文件失败: {}", e))).await?
}

#[tauri::command]
pub async fn create_file(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let name = name.trim();
        let relative = Path::new(name);
        if name.is_empty()
            || relative.components().count() != 1
            || relative.file_name().and_then(|n| n.to_str()) != Some(name)
        {
            return Err("文件名必须是当前目录下的单个文件名".to_string());
        }

        let path = lock(&cwd).join(relative);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("文件已存在: {}", name)
                } else {
                    format!("创建文件失败: {}", e)
                }
            })?;
        Ok(path.to_string_lossy().to_string())
    })
    .await?
}

#[tauri::command]
pub async fn open_folder_dialog(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    match path {
        Some(p) => Ok(p.to_string()),
        None => Err("未选择文件夹".to_string()),
    }
}

/// 打开文件对话框：返回用户选择的完整路径，取消时返回空字符串
#[tauri::command]
pub async fn open_file_dialog(
    app: tauri::AppHandle,
    ext: Option<String>,
) -> Result<String, String> {
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
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
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
pub fn take_circuit_pending(state: tauri::State<'_, AppState>) -> Option<String> {
    lock(&state.inner().circuit_pending).take()
}

/// 关闭电路仿真窗口
#[tauri::command]
pub fn close_circuit_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    match app.get_webview_window("circuit") {
        Some(window) => window.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 打开（或聚焦）信号系统窗口；path 非空时让窗口载入该 .sig
#[tauri::command]
pub async fn open_signal_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
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
pub fn take_signal_pending(state: tauri::State<'_, AppState>) -> Option<String> {
    lock(&state.inner().signal_pending).take()
}

/// 关闭信号系统窗口
#[tauri::command]
pub fn close_signal_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    match app.get_webview_window("signal") {
        Some(window) => window.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 另存为对话框：返回用户选择的完整路径，取消时返回空字符串
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
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
pub fn get_initial_dir(state: tauri::State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}

// ---------------- shell 命令 ----------------

#[tauri::command]
pub fn shell_pwd(state: tauri::State<'_, AppState>) -> String {
    lock(&state.inner().cwd).to_string_lossy().to_string()
}

#[tauri::command]
pub fn shell_cd(
    state: tauri::State<'_, AppState>,
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
pub async fn shell_ls(state: tauri::State<'_, AppState>) -> Result<Vec<DirEntry>, String> {
    let cur = lock(&state.inner().cwd).clone();
    blocking(move || scan_directory_sync(&cur)).await?
}

#[tauri::command]
pub async fn shell_mkdir(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<String, String> {
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
pub async fn shell_rm(state: tauri::State<'_, AppState>, name: String) -> Result<String, String> {
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

// ---------------- shell 进程运行器 ----------------

/// 启动一个子进程，通过 Tauri 事件 `shell-output` 推送 stdout/stderr。
/// payload: { key, text, line_break, cmd }，cmd 为 "stdout_start" / "stderr_start" / "stdout_data"。
/// 进程结束时发送 { key, text: null }。
#[tauri::command]
pub async fn shell_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
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

// ---------------- 工作区保存 ----------------

/// 将工作区变量导出为 JSON 文件
#[tauri::command]
pub async fn save_workspace(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let yt = state.inner().yt.clone();
    blocking(move || {
        let vars = lock(&yt).workspace_vars();
        let json = serde_json::to_string_pretty(&vars)
            .map_err(|e| format!("序列化工作区失败: {}", e))?;
        fs::write(&path, json)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        Ok(format!("工作区已保存到: {}", path))
    })
    .await?
}

// ---------------- .yt 求值 ----------------

/// 捕获解释器 panic（索引越界等），统一转为错误输出而不是让进程崩溃
fn eval_block_guarded(
    env: &mut crate::yt::Env,
    code: &str,
) -> (Vec<EvalOutput>, Option<crate::yt::PlotData>) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| env.eval_block(code))) {
        Ok(r) => r,
        Err(_) => (
            vec![EvalOutput {
                text: "解释器内部错误，本次求值已终止".to_string(),
                is_error: true,
            }],
            None,
        ),
    }
}

#[tauri::command]
pub async fn yt_eval(
    state: tauri::State<'_, AppState>,
    code: String,
) -> Result<EvalResult, String> {
    let yt = state.inner().yt.clone();
    let cwd = state.inner().cwd.clone();
    blocking(move || {
        let working_dir = lock(&cwd).clone();
        let mut env = lock(&yt);
        env.set_working_dir(working_dir);
        let (outputs, plot) = eval_block_guarded(&mut env, &code);
        EvalResult {
            outputs,
            plot,
            vars: env.workspace_vars(),
        }
    })
    .await
}

#[tauri::command]
pub fn yt_reset(state: tauri::State<'_, AppState>) -> Vec<WorkspaceVar> {
    let cwd = lock(&state.inner().cwd).clone();
    let mut env = lock(&state.inner().yt);
    env.reset();
    env.set_working_dir(cwd);
    env.workspace_vars()
}

#[tauri::command]
pub fn get_workspace(state: tauri::State<'_, AppState>) -> Vec<WorkspaceVar> {
    lock(&state.inner().yt).workspace_vars()
}

#[tauri::command]
pub async fn run_yt_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<EvalResult, String> {
    let cwd = state.inner().cwd.clone();
    let yt = state.inner().yt.clone();
    blocking(move || {
        let working_dir = lock(&cwd).clone();
        let full = resolve_path(&working_dir, &path);
        let mut env = lock(&yt);
        env.set_working_dir(working_dir);
        match fs::read_to_string(&full) {
            Ok(code) => {
                let (outputs, plot) = eval_block_guarded(&mut env, &code);
                EvalResult {
                    outputs,
                    plot,
                    vars: env.workspace_vars(),
                }
            }
            Err(e) => EvalResult {
                outputs: vec![EvalOutput {
                    text: format!("无法读取文件 {}: {}", full.display(), e),
                    is_error: true,
                }],
                plot: None,
                vars: env.workspace_vars(),
            },
        }
    })
    .await
}

#[cfg(test)]
mod image_edit_tests {
    use super::{transform_image_sync, ImageOperation};
    use image::GenericImageView;
    use image::Rgba;
    use std::sync::atomic::{AtomicU64, Ordering};

    // 临时文件序号，避免并发运行时互相覆盖
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn image_operations_preview_and_save_transformed_png() {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let base =
            std::env::temp_dir().join(format!("rzend_image_edit_{}_{}", std::process::id(), seq));
        let source = base.with_extension("source.png");
        let output = base.with_extension("edited.png");
        let image = image::RgbaImage::from_fn(4, 2, |x, y| {
            if (x + y) % 2 == 0 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 255])
            }
        });
        image.save(&source).unwrap();

        let operations = vec![
            ImageOperation {
                kind: "crop".into(),
                x: Some(1),
                y: Some(0),
                width: Some(2),
                height: Some(1),
            },
            ImageOperation {
                kind: "rotate_right".into(),
                x: None,
                y: None,
                width: None,
                height: None,
            },
            ImageOperation {
                kind: "resize".into(),
                x: None,
                y: None,
                width: Some(2),
                height: Some(4),
            },
            ImageOperation {
                kind: "grayscale".into(),
                x: None,
                y: None,
                width: None,
                height: None,
            },
        ];
        let preview = transform_image_sync(&source, operations.clone(), None).unwrap();
        let saved_preview =
            transform_image_sync(&source, operations, Some(output.clone())).unwrap();

        assert_eq!((preview.width, preview.height), (2, 4));
        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((saved_preview.width, saved_preview.height), (2, 4));
        assert!(saved_preview.data_url.is_empty());
        let saved = image::ImageReader::open(&output).unwrap().decode().unwrap();
        assert_eq!(saved.dimensions(), (2, 4));
        let pixel = saved.to_rgba8().get_pixel(0, 0).0;
        assert_eq!(pixel[0], pixel[1]);
        assert_eq!(pixel[1], pixel[2]);

        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(output);
    }
}