// Tauri 命令（IPC 入口）按功能拆分：
//   fs       目录扫描、文件读写、创建文件
//   image    图片预览与编辑
//   windows  文件对话框与仿真窗口开关
//   shell    shell 命令（pwd/cd/ls/mkdir/rm/spawn）
//   yt_cmds  .yt 脚本求值相关命令

use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) mod fs;
pub(crate) mod image;
pub(crate) mod windows;
pub(crate) mod shell;
pub(crate) mod yt_cmds;
pub(crate) mod terminal;

/// 锁毒化恢复：panic 已被 catch_unwind 捕获时，锁内数据仍然可用
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 把阻塞任务放到线程池执行，统一处理任务失败（panic 等）
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))
}

/// 相对当前目录解析路径：绝对路径原样返回，相对路径与 cwd 拼接
pub(crate) fn resolve_path(cwd: &Path, p: &str) -> PathBuf {
    let p = p.trim().trim_matches('"');
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}
