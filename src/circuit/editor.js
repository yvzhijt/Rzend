// 电路仿真画布：生命周期入口
import { invoke } from '@tauri-apps/api/core';
import { C, status, basename, bindCircuitCallbacks } from './ui.js';
import { defaultCircuit, deserializeCircuit, serializeCircuit } from './format.js';
import { closeFigure } from '../figure.js';
import { pausePower, updatePowerBtn } from './power.js';
import { render } from './render.js';
import { cancelPending } from './interact.js';
import { buildPalette, bindToolbar } from './controls.js';
import { bindCanvas, bindKeys } from './interact.js';

/* ---------------- 生命周期 ---------------- */

export function initCircuit(opts) {
  C.opts = opts || {};
  // 注册回调，消除 controls.js / interact.js / render.js / power.js 对 editor 的循环依赖
  bindCircuitCallbacks({ closeCircuit, openCircuitFile, pausePower, render });
  buildPalette();
  bindToolbar();
  bindCanvas();
  bindKeys();
  // 切走/隐藏窗口时自动断电，避免后台空转求解
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pausePower();
  });
}

export function openCircuit() {
  pausePower();
  if (!C.model) C.model = defaultCircuit();
  C.path = null;
  C.sel = null;
  C.readings = new Map();
  show();
  status('就绪');
}

export function openCircuitFile(path) {
  pausePower();
  return invoke('read_file_content', { path })
    .then((text) => {
      C.model = deserializeCircuit(JSON.parse(text));
      C.path = path;
      C.sel = null;
      C.readings = new Map();
      show();
      status(`已打开 ${basename(path)}`);
    })
    .catch((e) => {
      openCircuit();
      status(`打开失败: ${e}`, true);
    });
}

export function closeCircuit() {
  pausePower();
  closeFigure();
  C.visible = false;
  // 独立窗口：直接关闭电路仿真窗口
  invoke('close_circuit_window').catch(() => {});
}

function show() {
  const view = document.querySelector('#circuit-view');
  if (view) view.classList.remove('hidden');
  C.visible = true;
  C.pending = null;
  C.cursor = null;
  C.snap = null;
  C.hoverPin = null;
  const duration = document.querySelector('#circ-duration');
  if (duration) duration.value = C.model.duration;
  const dt = document.querySelector('#circ-dt');
  if (dt) dt.value = C.model.dt;
  render();
}