/* 信号系统仿真独立窗口入口 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { initSignalGraph, setSignalModel, switchToSignal } from './circuit/signal.js';

const $ = (s) => document.querySelector(s);

/* 将 signal 模块的 DOM 查询重定向到 sig-* 命名空间 */
function redirectSignalDOM() {
  const map = {
    '#circ-canvas': '#sig-canvas',
    '#circ-palette-list': '#sig-palette-list',
    '#circ-search': '#sig-search',
    '#circ-props-body': '#sig-props-body',
    '#circ-context-menu': '#sig-context-menu',
    '#circ-status': '#sig-status',
    '#circ-run': '#sig-mason',
    '#circ-duration': '#sig-duration',
    '#circ-dt': '#sig-dt',
    '#circ-empty': '#sig-empty',
    '#circ-view-circuit': '#sig-view-circuit',
    '#circ-view-signal': '#sig-view-signal',
  };

  const originals = {};
  Object.entries(map).forEach(([from, to]) => {
    originals[from] = window.$(from);
    Object.defineProperty(window, from, {
      get() { return document.querySelector(to); },
      configurable: true,
    });
  });

  return originals;
}

// 信号节点数据模型
const SIG = {
  model: null,  // { blocks: [], wires: [] }
  path: null,   // 文件路径
};

/* ---------------- 序列化 ---------------- */

function sigSerialize(model) {
  return {
    version: 1,
    blocks: (model.blocks || []).map((b) => ({
      id: b.id, type: b.type, x: b.x, y: b.y,
      params: { ...(b.params || {}) },
      signs: Array.isArray(b.signs) ? b.signs.slice(0, 8) : undefined,
    })),
    wires: (model.wires || []).map((w) => ({
      id: w.id,
      from: { block: w.from.block, port: w.from.port },
      to: { block: w.to.block, port: w.to.port },
    })),
  };
}

function sigDeserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('文件格式不正确');
  const blocks = (Array.isArray(data.blocks) ? data.blocks : [])
    .filter((b) => ['SOURCE', 'TF', 'SUM', 'PICKOFF', 'PROBE'].includes(b.type))
    .map((b) => ({
      id: b.id || 's' + Math.random().toString(36).slice(2, 8),
      type: b.type,
      x: Number.isFinite(b.x) ? b.x : 0,
      y: Number.isFinite(b.y) ? b.y : 0,
      params: { ...(b.params || {}) },
      signs: Array.isArray(b.signs) ? b.signs.slice(0, 8) : (b.type === 'SUM' ? [1, 1] : []),
    }));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const wires = (Array.isArray(data.wires) ? data.wires : [])
    .filter((w) => byId.has(w.from?.block) && byId.has(w.to?.block))
    .map((w) => ({
      id: w.id || 'sw' + Math.random().toString(36).slice(2, 8),
      from: { block: w.from.block, port: w.from.port || 'out' },
      to: { block: w.to.block, port: w.to.port || 'in0' },
    }));
  return { blocks, wires };
}

/* ---------------- 文件操作 ---------------- */

async function sigSave() {
  const model = SIG.model;
  if (!model) return;
  const content = JSON.stringify(sigSerialize(model), null, 2);
  if (SIG.path) {
    await invoke('write_file_content', { path: SIG.path, content });
    status('已保存');
  } else {
    await sigSaveAs();
  }
}

async function sigSaveAs() {
  const model = SIG.model;
  if (!model) return;
  const content = JSON.stringify(sigSerialize(model), null, 2);
  const path = await invoke('save_file_dialog', { defaultName: '无标题.sig', ext: 'sig' });
  if (!path) return;
  await invoke('write_file_content', { path, content });
  SIG.path = path;
  status(`已保存到 ${path}`);
}

async function sigOpen() {
  const path = await invoke('open_file_dialog', { title: '打开信号流图文件', filters: [{ name: '信号流图', extensions: ['sig'] }] });
  if (typeof path !== 'string' || !path) return;
  await sigOpenFile(path);
}

async function sigOpenFile(filePath) {
  try {
    const text = await invoke('read_file_content', { path: filePath });
    const data = JSON.parse(text);
    SIG.model = sigDeserialize(data);
    SIG.path = filePath;
    setSignalModel(SIG.model);
    switchToSignal();
    status(`已打开 ${filePath}`);
  } catch (e) {
    status(`打开文件失败: ${e}`, true);
  }
}

async function sigClear() {
  SIG.model = { blocks: [], wires: [] };
  SIG.path = null;
  setSignalModel(SIG.model);
  switchToSignal();
  status('已清空');
}

/* ---------------- 工具栏 ---------------- */

async function sigClose() {
  await invoke('close_signal_window');
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
  const el = $('#sig-status');
  if (!el) return;
  el.textContent = msg || '就绪';
  el.style.color = isError ? '#c0392b' : '';
  if (!isError) setTimeout(() => { el.style.color = ''; }, 3000);
}

/* ---------------- 入口 ---------------- */

async function init() {
  redirectSignalDOM();
  initSignalGraph();

  // 默认空白模型
  SIG.model = { blocks: [], wires: [] };
  setSignalModel(SIG.model);
  switchToSignal();
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