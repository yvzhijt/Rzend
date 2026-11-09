//! 文件树监听：使用操作系统原生文件事件（Windows 下为 ReadDirectoryChangesW）。
//!
//! 这是事件驱动的，和 VS Code / Sublime 等编辑器一致：空闲时没有任何轮询线程，
//! 只有目录里真的发生了创建 / 删除 / 重命名时才通知前端刷新文件树。
//!
//! 前端把当前 cwd 和已展开的目录列表传给 watch_tree，后端按差量维护非递归监听。
//! 文件内容修改（保存、编译输出）不会触发文件树刷新，避免无意义的 IPC。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

pub struct TreeWatch {
    watcher: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
}

pub type TreeWatchSlot = std::sync::Arc<std::sync::Mutex<TreeWatch>>;

pub fn new_slot() -> TreeWatchSlot {
    std::sync::Arc::new(std::sync::Mutex::new(TreeWatch {
        watcher: None,
        watched: HashSet::new(),
    }))
}

fn lock_slot(slot: &TreeWatchSlot) -> std::sync::MutexGuard<'_, TreeWatch> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// 隐藏项以及体积大、变化频繁的构建目录不需要出现在文件树里
fn is_ignored(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name,
        None => return true,
    };
    name.starts_with('.')
        || name.starts_with('~')
        || matches!(name, "node_modules" | "target" | "dist" | "build")
}

/// 文件树只关心目录结构变化；内容修改、访问、属性变化都忽略
fn is_relevant(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any
    ) || matches!(kind, EventKind::Modify(ModifyKind::Name(_)))
}

/// 设置需要监听的目录集合（cwd + 已展开的子目录）
#[tauri::command]
pub fn watch_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let desired: HashSet<PathBuf> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect();

    let mut slot = lock_slot(&state.tree_watch);

    if slot.watcher.is_none() {
        let app_handle = app.clone();
        let watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else { return };
                if !is_relevant(&event.kind) {
                    return;
                }
                if event.paths.iter().any(|path| !is_ignored(path)) {
                    let _ = app_handle.emit("fs-change", ());
                }
            },
        )
        .map_err(|e| format!("启动文件监听失败: {e}"))?;
        slot.watcher = Some(watcher);
    }

    let TreeWatch { watcher, watched } = &mut *slot;
    let watcher = watcher.as_mut().expect("watcher 已在上面创建");

    // 已折叠 / 已切换走的目录：取消监听
    let stale: Vec<PathBuf> = watched.difference(&desired).cloned().collect();
    for path in stale {
        let _ = watcher.unwatch(&path);
        watched.remove(&path);
    }

    // 新展开的目录：增加监听。单个目录失败（权限、网络盘）不影响其他目录
    for path in desired {
        if watched.contains(&path) {
            continue;
        }
        if watcher.watch(&path, RecursiveMode::NonRecursive).is_ok() {
            watched.insert(path);
        }
    }

    Ok(())
}
