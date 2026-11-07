/* 信号系统仿真独立窗口入口 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { $ } from './common.js';
import { createSignalGraph, deserializeSignalGraph, serializeSignalGraph } from './signal/model.js';
import { initSignalGraph, setSignalModel } from './signal/editor.js';

// 信号节点数据模型
const SIG = {
  model: null,  // { blocks: [], wires: [] }
  path: null,   // 文件路径
};

/* ---------------- 文件操作 ---------------- */

async function sigSave() {
  const model = SIG.model;
  if (!model) return;
  if (!SIG.path) {
    await sigSaveAs();
    return;
  }
  try {
    const content = JSON.stringify(serializeSignalGraph(model), null, 2);
    await invoke('write_file_content', { path: SIG.path, content });
    status('已保存');
  } catch (e) {
    status(`保存失败: ${e}`, true);
  }
}

async function sigSaveAs() {
  const model = SIG.model;
  if (!model) return;
  try {
    const content = JSON.stringify(serializeSignalGraph(model), null, 2);
    const path = await invoke('save_file_dialog', { defaultName: '无标题.sig', ext: 'sig' });
    if (!path) return;
    await invoke('write_file_content', { path, content });
    SIG.path = path;
    status(`已保存到 ${path}`);
  } catch (e) {
    status(`另存为失败: ${e}`, true);
  }
}

async function sigOpen() {
  try {
    const path = await invoke('open_file_dialog', { ext: 'sig' });
    if (typeof path !== 'string' || !path) return;
    await sigOpenFile(path);
  } catch (e) {
    status(`打开文件对话框失败: ${e}`, true);
  }
}

async function sigOpenFile(filePath) {
  try {
    const text = await invoke('read_file_content', { path: filePath });
    const data = JSON.parse(text);
    SIG.model = deserializeSignalGraph(data);
    SIG.path = filePath;
    setSignalModel(SIG.model);
    status(`已打开 ${filePath}`);
  } catch (e) {
    status(`打开文件失败: ${e}`, true);
  }
}

async function sigClear() {
  SIG.model = createSignalGraph();
  SIG.path = null;
  setSignalModel(SIG.model);
  status('已清空');
}

/* ---------------- 工具栏 ---------------- */

async function sigClose() {
  try {
    await invoke('close_signal_window');
  } catch (e) {
    status(`关闭窗口失败: ${e}`, true);
  }
}

function bindSigToolbar() {
  $('#sig-save')?.addEventListener('click', sigSave);
  $('#sig-save-as')?.addEventListener('click', sigSaveAs);
  $('#sig-open')?.addEventListener('click', sigOpen);
  $('#sig-clear')?.addEventListener('click', sigClear);
  $('#sig-close')?.addEventListener('click', sigClose);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      sigSave();
    }
  });
}

/* ---------------- 状态栏 ---------------- */

function status(msg, isError) {
  const el = $('#circ-status');
  if (!el) return;
  el.textContent = msg || '就绪';
  el.style.color = isError ? '#c0392b' : '';
  if (!isError) setTimeout(() => { el.style.color = ''; }, 3000);
}

/* ---------------- 入口 ---------------- */

async function init() {
  initSignalGraph();

  // 默认空白模型
  SIG.model = createSignalGraph();
  setSignalModel(SIG.model);
  bindSigToolbar();

  // 窗口可能是通过文件双击打开
  let pending = null;
  try {
    pending = await invoke('take_signal_pending');
  } catch (e) {
    console.error('take_signal_pending failed', e);
  }
  if (pending) {
    await sigOpenFile(pending);
  }

  await listen('rzend:open-sig', (e) => {
    if (typeof e.payload === 'string' && e.payload) {
      sigOpenFile(e.payload);
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => console.error(e));
});