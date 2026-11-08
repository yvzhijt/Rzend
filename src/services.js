// 服务层：跨模块共享的副作用操作，集中在此以消除循环依赖。
// 所有模块只需 import services，不互相 import。
import { invoke } from '@tauri-apps/api/core';
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

export async function refreshTree() {
  try {
    state.entries = await invoke('shell_ls');
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
        state.expanded.delete(entry.path);
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
