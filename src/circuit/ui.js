// 电路仿真画布：全局状态与辅助函数
export const NS = 'http://www.w3.org/2000/svg';

export const C = {
  model: null,
  path: null,
  sel: null,        // { kind:'el'|'net', id }
  drag: null,
  selSet: [],       // 框选/整体移动时的多选集合（元件 id）
  dragging: null,   // 'marquee' 表示正在框选
  marquee: null,    // { x0, y0, x1, y1, wireId }
  pending: null,    // { port:'elId:pin', bends:[{x,y}] }
  cursor: null,
  snap: null,       // { port, x, y }
  hoverPin: null,   // 悬停中的端子 key
  contextTarget: null,
  visible: false,
  readings: new Map(),
  opts: {},
};

export const $ = (s) => document.querySelector(s);

/* 实时仿真（通电）状态：rAF 驱动步进引擎，墙钟时间 × 速度档位推进 */
export const RT_SPEEDS = [1, 0.1, 0.01];
export const RT_MAX_STEPS = 6000;      // 每帧最多推进步数，超出则丢弃积压（自动降速而不是卡死）
export const FLOW_DOT_COUNT = 3;
export const RT = {
  on: false, raf: 0, last: 0, statusAt: 0, speedIdx: 0, sim: null, phase: new Map(), warned: false,
};
export const rtSpeed = () => RT_SPEEDS[RT.speedIdx];

export function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  if (text != null) n.textContent = text;
  return n;
}

export function status(msg, isError = false) {
  const box = $('#circ-status');
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle('err', isError);
}

export function basename(p) {
  return String(p || '').split(/[/\\]/).pop();
}

export function fmtValue(v, unit) {
  const a = Math.abs(v);
  if (a >= 1) return `${v.toFixed(a >= 100 ? 1 : 3)} ${unit}`;
  if (a >= 1e-3) return `${(v * 1e3).toFixed(2)} m${unit}`;
  if (a >= 1e-6) return `${(v * 1e6).toFixed(2)} µ${unit}`;
  return `${(v * 1e9).toFixed(1)} n${unit}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/* ---------------- 回调注册：消除 circuit 模块内部循环依赖 ---------------- */
// editor.js / power.js 在初始化时注册回调，其他文件通过这些间接调用避免动态 import

const _cbs = {
  closeCircuit: () => {},
  openCircuitFile: async () => {},
  pausePower: () => {},
  render: () => {},
};

export function bindCircuitCallbacks({ closeCircuit, openCircuitFile, pausePower, render }) {
  if (closeCircuit) _cbs.closeCircuit = closeCircuit;
  if (openCircuitFile) _cbs.openCircuitFile = openCircuitFile;
  if (pausePower) _cbs.pausePower = pausePower;
  if (render) _cbs.render = render;
}

export function callCloseCircuit() { return _cbs.closeCircuit(); }
export function callOpenCircuitFile(path) { return _cbs.openCircuitFile(path); }
export function callPausePower() { return _cbs.pausePower(); }
export function callRender() { return _cbs.render(); }