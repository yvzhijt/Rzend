// 服务层：跨模块共享的副作用操作，集中在此以消除循环依赖。
// 所有模块只需 import services，不互相 import。
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { state, $, $$, print, esc } from './common.js';

/* ---------------- 终端同步回调（由 terminal.js 注入） ---------------- */

let onTerminalCwdFn = null;
let onTerminalNoticeFn = null;

export function setTerminalCallbacks({ onCwd, onNotice }) {
  onTerminalCwdFn = onCwd;
  onTerminalNoticeFn = onNotice;
}

/* ---------------- 状态栏 ---------------- */

export function updateStatus() {
  const name = (state.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const statusFolder = $('#status-folder');
  if (statusFolder) statusFolder.textContent = name || state.cwd;
  const statusIndicator = $('#status-indicator');
  if (statusIndicator) statusIndicator.textContent = state.activeFile
    ? `编辑: ${state.activeFile.split(/[/\\]/).pop()}`
    : '就绪';
}

/* ---------------- 文件树刷新 ---------------- */

// 目录内容指纹：名称 + 类型，用于自动刷新时判断是否真的发生了变化
function entriesSignature(entries) {
  return entries.map((e) => `${e.is_dir ? 'd' : 'f'}:${e.name}`).join('\n');
}

let treeSignature = '';

export async function refreshTree() {
  try {
    state.entries = await invoke('shell_ls');
    treeSignature = entriesSignature(state.entries);
    state.treeError = '';
    state.treeErrors.clear();
  } catch (e) {
    state.entries = [];
    state.treeError = String(e);
    print(`读取目录失败: ${e}\n`, 'cmd-err');
  }
  renderTree();
  const chip = $('#current-folder-path');
  if (chip) chip.textContent = state.cwd || '—';
  updateStatus();
}

export function renderTree() {
  syncTreeWatchers();
  const tree = $('#file-tree');
  if (!tree) return;
  tree.innerHTML = '';
  if (state.treeError) {
    tree.innerHTML = `<div class="placeholder-content">${esc(state.treeError)}</div>`;
    return;
  }
  if (!state.entries.length) {
    tree.innerHTML = '<div class="placeholder-content">空文件夹</div>';
    return;
  }
  state.entries.forEach((e) => renderNode(tree, e, 0));
}

function renderNode(container, entry, depth) {
  const row = document.createElement('div');
  row.className = 'tree-item';
  row.style.paddingLeft = `${depth * 14 + 8}px`;
  if (entry.path === state.activeFile) row.classList.add('selected');

  const arrow = document.createElement('span');
  arrow.className = 'tree-arrow';
  arrow.textContent = entry.is_dir ? (state.expanded.has(entry.path) ? '▾' : '▸') : '';
  row.appendChild(arrow);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = entry.is_dir ? (state.expanded.has(entry.path) ? '📂' : '📁') : fileIcon(entry.name);
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  row.appendChild(name);

  row.addEventListener('click', () => {
    if (entry.is_dir) {
      if (state.expanded.has(entry.path)) {
        // 收起时连同后代一起移出展开集合，避免继续监听已隐藏的子目录
        const prefix = `${entry.path}\\`;
        const prefixAlt = `${entry.path}/`;
        for (const path of state.expanded) {
          if (path === entry.path || path.startsWith(prefix) || path.startsWith(prefixAlt)) {
            state.expanded.delete(path);
          }
        }
      } else {
        state.treeErrors.delete(entry.path);
        state.expanded.add(entry.path);
      }
      renderTree();
    } else {
      openFile(entry.path);
    }
  });

  container.appendChild(row);

  if (entry.is_dir && state.expanded.has(entry.path)) {
    if (entry.children === null) {
      if (state.treeLoading.has(entry.path)) {
        renderTreeMessage(container, '正在读取…', depth + 1);
      } else if (state.treeErrors.has(entry.path)) {
        renderTreeMessage(container, '读取失败，收起后重新展开可重试', depth + 1);
      } else {
        queueMicrotask(() => loadTreeDirectory(entry));
      }
    } else if (!entry.children.length) {
      renderTreeMessage(container, '空文件夹', depth + 1);
    } else {
      entry.children.forEach((child) => renderNode(container, child, depth + 1));
    }
  }
}

function renderTreeMessage(container, text, depth) {
  const row = document.createElement('div');
  row.className = 'tree-message';
  row.style.paddingLeft = `${depth * 14 + 8}px`;
  row.textContent = text;
  container.appendChild(row);
}

async function loadTreeDirectory(entry) {
  if (state.treeLoading.has(entry.path) || !state.expanded.has(entry.path)) return;
  state.treeLoading.add(entry.path);
  renderTree();
  try {
    const children = await invoke('scan_directory', { path: entry.path });
    const currentEntry = findTreeEntry(state.entries, entry.path);
    if (currentEntry) {
      currentEntry.children = children;
      currentEntry.childrenSignature = entriesSignature(children);
      state.treeErrors.delete(entry.path);
    }
  } catch (e) {
    state.treeErrors.set(entry.path, String(e));
    print(`读取文件夹失败: ${e}\n`, 'cmd-err');
  } finally {
    state.treeLoading.delete(entry.path);
    renderTree();
  }
}

function findTreeEntry(entries, path) {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const found = entry.children && findTreeEntry(entry.children, path);
    if (found) return found;
  }
  return null;
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = { yt: '🔷', pyt: '🐍', py: '🐍', txt: '📄', md: '📝', json: '📋' };
  return map[ext] || '📄';
}

export function bindFileTree() {
  $('#btn-refresh')?.addEventListener('click', refreshTree);
  $('#btn-folder-up')?.addEventListener('click', () => doCd('..'));
}

/* ---------------- 文件树自动刷新 ---------------- */

// 优先使用后端原生文件监听（事件驱动，空闲时零开销）；
// 如果运行的是未重新编译的旧后端，则自动退回低频轮询。
let autoRefreshTimer = 0;
let autoRefreshBusy = false;
let autoRefreshBound = false;
let fsChangeTimer = 0;
let fsChangeUnlisten = null;
let watcherSupported = null; // null = 未知，true / false = 是否可用
let watcherPathsKey = '';
let watcherSyncBusy = false;
let watcherSyncPending = false;

function desiredWatchPaths() {
  return [state.cwd, ...state.expanded].filter(Boolean);
}

/** 把需要监听的目录列表同步给后端（cwd + 已展开的目录） */
async function syncTreeWatchers(force = false) {
  if (watcherSupported === false) return;
  const paths = desiredWatchPaths();
  const key = paths.join('\n');
  if (!force && key === watcherPathsKey) return;
  if (watcherSyncBusy) {
    watcherSyncPending = true;
    return;
  }

  watcherSyncBusy = true;
  try {
    await invoke('watch_tree', { paths });
    watcherSupported = true;
    watcherPathsKey = key;
  } catch {
    // 旧后端没有 watch_tree 命令：停止尝试，改用轮询兜底
    watcherSupported = false;
  } finally {
    watcherSyncBusy = false;
    if (watcherSyncPending) {
      watcherSyncPending = false;
      syncTreeWatchers(true);
    }
  }
}

// 只重新扫描已展开的子目录，内容有变化才重绘，避免无谓闪烁
async function refreshExpandedDirs() {
  let changed = false;
  for (const path of Array.from(state.expanded)) {
    const entry = findTreeEntry(state.entries, path);
    if (!entry) continue;
    try {
      const children = await invoke('scan_directory', { path });
      const sig = entriesSignature(children);
      if (!entry.children || entry.childrenSignature !== sig) {
        entry.children = children;
        entry.childrenSignature = sig;
        changed = true;
      }
      state.treeErrors.delete(path);
    } catch {
      // 子目录可能刚被删除，留给下一轮刷新处理
    }
  }
  return changed;
}

/** 静默检查目录变化，有变化时才重绘文件树 */
export async function autoRefreshTree() {
  if (autoRefreshBusy || document.hidden) return;
  autoRefreshBusy = true;
  try {
    const entries = await invoke('shell_ls');
    const sig = entriesSignature(entries);

    if (sig !== treeSignature) {
      state.entries = entries;
      treeSignature = sig;
      state.treeError = '';
      state.treeErrors.clear();
      renderTree();
      updateStatus();
      return;
    }

    // 上次读取失败但现在已经恢复：清掉错误提示
    if (state.treeError) {
      state.treeError = '';
      state.treeErrors.clear();
      renderTree();
    }

    if (await refreshExpandedDirs()) renderTree();
  } catch {
    // 自动刷新保持静默，避免失败时刷屏
  } finally {
    autoRefreshBusy = false;
  }
}

/** 原生监听回调的节流：一次批量文件操作只刷新一次 */
function scheduleTreeRefresh() {
  if (fsChangeTimer) return;
  fsChangeTimer = window.setTimeout(() => {
    fsChangeTimer = 0;
    autoRefreshTree();
  }, 90);
}

async function bindTreeFileEvents() {
  if (fsChangeUnlisten) return;
  try {
    fsChangeUnlisten = await listen('fs-change', scheduleTreeRefresh);
  } catch {
    // 旧后端没有该事件，轮询兜底即可
  }
}

/** 启动文件树自动刷新：原生监听 + 焦点刷新，监听不可用时退回轮询 */
export async function startTreeAutoRefresh() {
  stopTreeAutoRefresh();
  watcherSupported = null;
  watcherPathsKey = '';
  await syncTreeWatchers(true);

  // 原生监听可用时只保留 30 秒低频兜底（网络盘 / 漏事件）；
  // 不可用时才用 3 秒轮询。
  const fallbackMs = watcherSupported ? 30000 : 3000;
  autoRefreshTimer = window.setInterval(autoRefreshTree, fallbackMs);

  bindTreeFileEvents();

  if (autoRefreshBound) return;
  autoRefreshBound = true;
  window.addEventListener('focus', autoRefreshTree);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) autoRefreshTree();
  });
}

export function stopTreeAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = 0;
  }
  if (fsChangeTimer) {
    clearTimeout(fsChangeTimer);
    fsChangeTimer = 0;
  }
}

/* ---------------- 目录切换 ---------------- */

export async function doCd(path, force) {
  try {
    const silent = String(path).startsWith('!');
    if (silent) path = String(path).slice(1);
    if (!path) return;
    const target = await invoke('shell_cd', { path, force: !!force });
    state.cwd = target;
    state.expanded.clear();
    if (!silent) print(`→ ${target}\n`, 'cmd-info');
    syncTerminalCwd(target);
    setTerminalCwdChip(target);
    await refreshTree();
  } catch (e) {
    print(`${e}\n`, 'cmd-err');
  }
}

export async function openFolderDialog() {
  try {
    const picked = await invoke('open_folder_dialog');
    await doCd(picked, true);
  } catch (e) {
    if (e !== '未选择文件夹') print(`打开文件夹失败: ${e}\n`, 'cmd-err');
  }
}

/* ---------------- 终端 cwd 同步（延迟注入，避免导入环） ---------------- */

let _syncTerminalCwd = (path) => {};
let _setTerminalCwdChip = (path) => {};

export function bindTerminalSync(syncFn, chipFn) {
  _syncTerminalCwd = syncFn;
  _setTerminalCwdChip = chipFn;
}

function syncTerminalCwd(path) { _syncTerminalCwd(path); }
function setTerminalCwdChip(path) { _setTerminalCwdChip(path); }

/* ---------------- 编辑器操作（由 editor-core.js 注入） ---------------- */

let _openFile = async () => {};
let _closeEditor = async () => true;
let _saveFile = async () => false;
let _setEditorDocument = () => {};
let _hasUnsavedChanges = () => false;

export function bindEditorOps({
  openFile, closeEditor, saveFile, setEditorDocument, hasUnsavedChanges,
}) {
  _openFile = openFile;
  _closeEditor = closeEditor;
  _saveFile = saveFile;
  _setEditorDocument = setEditorDocument;
  if (hasUnsavedChanges) _hasUnsavedChanges = hasUnsavedChanges;
}

export async function openFile(path) { return _openFile(path); }
export function closeEditor(force = false) { return _closeEditor(force); }
export async function saveFile() { return _saveFile(); }
export function hasUnsavedChanges() { return _hasUnsavedChanges(); }

/* ---------------- 终端操作（由 terminal.js 注入） ---------------- */

let _toggleTerminal = async () => {};
let _injectLine = () => false;

export function bindTerminalOps({ toggleTerminal, injectLine }) {
  _toggleTerminal = toggleTerminal;
  _injectLine = injectLine;
}

export async function toggleTerminal(show, shell) { return _toggleTerminal(show, shell); }
export function injectLine(line) { return _injectLine(line); }

/* ---------------- 命令行聚焦（由 shell.js 注入） ---------------- */

let _focusInput = () => {};

export function bindFocusInput(fn) { _focusInput = fn; }
export function focusInput() { _focusInput(); }

/* ---------------- 工作区渲染（由 yt-runner.js 注入） ---------------- */

let _renderWorkspace = () => {};
let _showPlot = () => {};

export function bindWorkspaceOps({ renderWorkspace, showPlot }) {
  _renderWorkspace = renderWorkspace;
  _showPlot = showPlot;
}

export function renderWorkspace(vars) { _renderWorkspace(vars); }
export function showPlot(plot) { _showPlot(plot); }
