// 目录扫描、文件读取/写入、创建文件

use std::fs;
use std::path::Path;

use crate::commands::{blocking, lock};
use crate::DirEntry;

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

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    blocking(move || fs::write(&path, &content).map_err(|e| format!("保存文件失败: {}", e))).await?
}

#[tauri::command]
pub async fn create_file(
    state: tauri::State<'_, crate::AppState>,
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
