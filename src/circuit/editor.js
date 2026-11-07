// 电路仿真画布：元件、网络(Net)接线、仪表读数、浮动示波器
import { invoke } from '@tauri-apps/api/core';
import {
  ELEMENTS, GRID_OFFSET, H, W, createComponent, defaultCircuit, deserialize,
  initSimulation, netVoltage, normalizeRot, pinLocal, pinPos, serialize, simulate,
  snapGrid, snapPoint, stepSimulation, uid,
} from './model.js';
import { closeFigure, fmtTime, showFigure } from '../figure.js';

const NS = 'http://www.w3.org/2000/svg';

const C = {
  model: null,
  path: null,
  sel: null,        // { kind:'el'|'net', id }
  drag: null,
  pending: null,    // { port:'elId:pin', bends:[{x,y}] }
  cursor: null,
  snap: null,       // { port, x, y }
  hoverPin: null,   // 悬停中的端子 key
  contextTarget: null,
  visible: false,
  readings: new Map(),
  opts: {},
};

const $ = (s) => document.querySelector(s);

/* 实时仿真（通电）状态：rAF 驱动步进引擎，墙钟时间 × 速度档位推进 */
const RT_SPEEDS = [1, 0.1, 0.01];
const RT_MAX_STEPS = 6000;      // 每帧最多推进步数，超出则丢弃积压（自动降速而不是卡死）
const FLOW_DOT_COUNT = 3;
const RT = {
  on: false, raf: 0, last: 0, statusAt: 0, speedIdx: 0, sim: null, phase: new Map(), warned: false,
};
const rtSpeed = () => RT_SPEEDS[RT.speedIdx];

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  if (text != null) n.textContent = text;
  return n;
}

function status(msg, isError = false) {
  const box = $('#circ-status');
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle('err', isError);
}

/* ---------------- 生命周期 ---------------- */

export function initCircuit(opts) {
  C.opts = opts || {};
  buildPalette();
  bindToolbar();
  bindCanvas();
  bindKeys();
  // 切走/隐藏窗口时自动断电，避免后台空转求解
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pausePower();
  });
}

export function getModel() { return C.model; }

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
      C.model = deserialize(JSON.parse(text));
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
  $('#circuit-view').classList.remove('hidden');
  C.visible = true;
  C.pending = null;
  C.cursor = null;
  C.snap = null;
  C.hoverPin = null;
  $('#circ-duration').value = C.model.duration;
  $('#circ-dt').value = C.model.dt;
  render();
}

function basename(p) {
  return String(p || '').split(/[/\\]/).pop();
}

/* ---------------- 网络与几何 ---------------- */

function componentById(id) {
  return C.model?.components.find((c) => c.id === id) || null;
}

function portPos(key) {
  const [id, idx] = String(key).split(':');
  const c = componentById(id);
  if (!c) return null;
  return pinPos(c, Number(idx));
}

function netOfPort(key) {
  return C.model.nets.find((n) => n.ports.includes(key)) || null;
}

function anchorPos(a) {
  if (!a) return null;
  if (typeof a.port === 'string') return portPos(a.port);
  if (Number.isFinite(a.x) && Number.isFinite(a.y)) return { x: a.x, y: a.y };
  return null;
}

function exitDir(anchor) {
  if (typeof anchor?.port !== 'string') return null;
  const [id, idx] = anchor.port.split(':');
  const c = componentById(id);
  if (!c) return null;
  if (c.type === 'GND') return { x: 0, y: 1 };
  if (ELEMENTS[c.type]?.group === '数字逻辑') {
    // 最后一个引脚是输出（向右），其余为输入（向左）
    const direction = Number(idx) === c.pins - 1 ? { x: 1, y: 0 } : { x: -1, y: 0 };
    switch (normalizeRot(c.rot)) {
      case 90: return { x: -direction.y, y: direction.x };
      case 180: return { x: -direction.x, y: -direction.y };
      case 270: return { x: direction.y, y: -direction.x };
      default: return direction;
    }
  }
  return Number(idx) === 0 ? { x: -1, y: 0 } : { x: 1, y: 0 };
}

// 正交路由：优先沿起点的出线方向、沿终点的入线方向（左右端子横走、GND 竖走），
// 方向冲突时退回中点折线。中点也吸附到格点，保证整条线严格横平竖直。
function orthoRoute(p, q, dp, dq) {
  if (Math.abs(p.y - q.y) < 0.5 || Math.abs(p.x - q.x) < 0.5) return [p, q];
  const pH = !!(dp && dp.x);
  const pV = !!(dp && dp.y);
  const qH = !!(dq && dq.x);
  const qV = !!(dq && dq.y);
  if (pH && qH) {
    const mx = snapGrid((p.x + q.x) / 2);
    return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
  }
  if (pV && qV) {
    const my = snapGrid((p.y + q.y) / 2);
    return [p, { x: p.x, y: my }, { x: q.x, y: my }, q];
  }
  // 先横走（起点横出 / 终点竖入）或先竖走（起点竖出 / 终点横入）
  if (pH || qV) return [p, { x: q.x, y: p.y }, q];
  if (pV || qH) return [p, { x: p.x, y: q.y }, q];
  const mx = snapGrid((p.x + q.x) / 2);
  return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
}

// 依次把一串锚点用正交折线连接起来，dirs 与 pts 等长
function routeChain(pts, dirs) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    orthoRoute(pts[i - 1], pts[i], dirs[i - 1], dirs[i])
      .slice(1)
      .forEach((p) => out.push(p));
  }
  return out;
}

function polylineD(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.abs(a.y - b.y) < 0.5) d += ` H ${b.x}`;
    else d += ` V ${b.y}`;
  }
  return d;
}

function segPolyline(seg) {
  const pts = [];
  const a = anchorPos(seg.a);
  if (a) pts.push({ x: a.x, y: a.y });
  (seg.via || []).forEach((p) => pts.push({ x: p.x, y: p.y }));
  const b = anchorPos(seg.b);
  if (b) pts.push({ x: b.x, y: b.y });
  if (pts.length < 2) return pts;

  const dirs = [exitDir(seg.a)];
  (seg.via || []).forEach(() => dirs.push(null));
  dirs.push(exitDir(seg.b));
  return routeChain(pts, dirs);
}

function segPathD(seg) {
  return polylineD(segPolyline(seg));
}

function closestOnSeg(seg, pt) {
  const pts = segPolyline(seg);
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const dist = Math.hypot(pt.x - x, pt.y - y);
    if (!best || dist < best.dist) best = { x, y, dist, horizontal: Math.abs(dy) < Math.abs(dx) };
  }
  return best;
}

// 预览折线：起点端子 → 已落的拐点 → 当前光标（或吸附端子）
function pendingPolyline(end) {
  if (!C.pending) return [];
  const start = portPos(C.pending.port);
  if (!start) return [];
  const bends = C.pending.bends || [];
  const pts = [start, ...bends.map((p) => ({ x: p.x, y: p.y }))];
  const dirs = [exitDir({ port: C.pending.port }), ...bends.map(() => null)];
  if (end) {
    pts.push({ x: end.x, y: end.y });
    dirs.push(C.snap ? exitDir({ port: C.snap.port }) : null);
  }
  return routeChain(pts, dirs);
}

/* ---------------- 渲染 ---------------- */

function render() {
  if (!C.model) return;
  renderElements();
  renderNets();
  renderProps();
  const empty = !C.model.components.length;
  $('#circ-empty')?.classList.toggle('hidden', !empty);
}

function renderElements() {
  const layer = $('#circ-elements-layer');
  layer.innerHTML = '';
  C.model.components.forEach((c) => layer.appendChild(elementNode(c)));
  rebuildPinIndex();
}

function elementNode(c) {
  const selected = C.sel?.kind === 'el' && C.sel.id === c.id;
  const g = el('g', { class: 'circ-el', 'data-element': c.id, transform: `translate(${c.x},${c.y})` });

  // 符号与端子一起旋转，文字标签保持水平
  const body = el('g', {
    class: 'circ-body',
    transform: c.rot ? `rotate(${c.rot} ${W / 2} ${H / 2})` : '',
  });
  body.appendChild(el('rect', {
    x: 0, y: 0, width: W, height: H,
    fill: selected ? 'rgba(0,114,189,0.08)' : 'transparent',
    stroke: selected ? '#0072bd' : 'transparent',
    'stroke-width': 1.5, rx: 4,
  }));
  symbolParts(c).forEach((n) => body.appendChild(n));

  // 端子（大一圈的透明命中区，方便点选）
  for (let i = 0; i < c.pins; i++) {
    const p = pinLocal(c.type, i);
    const key = `${c.id}:${i}`;
    const active = C.pending?.port === key;
    const snapped = C.snap?.port === key;
    const lit = active || snapped || C.hoverPin === key;
    body.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: 12,
      class: 'sim-port-hit', 'data-pin': key, 'data-element': c.id, 'data-index': i,
      fill: 'transparent',
    }));
    body.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: active || snapped ? 6.2 : lit ? 5.2 : 3.4,
      class: 'sim-port', 'data-pin': key, 'data-element': c.id, 'data-index': i,
      fill: lit ? '#0072bd' : '#7b8b9c',
      stroke: lit ? '#ffffff' : 'none',
      'stroke-width': 1.6,
    }));
  }
  g.appendChild(body);

  const labelY = c.rot % 180 === 0 ? H + 16 : H / 2 + W / 2 + 16;
  const reading = C.readings.get(c.id);
  g.appendChild(el('text', {
    x: W / 2, y: labelY, 'text-anchor': 'middle', class: 'circ-label',
  }, c.describe()));
  const hasLiveReading = c.type === 'A' || c.type === 'VM' || c.type === 'P' || c.type === 'TF'
    || ELEMENTS[c.type].group === '数字逻辑';
  if (hasLiveReading) {
    g.appendChild(el('text', {
      x: W / 2, y: labelY + 14, 'text-anchor': 'middle', class: 'circ-reading',
      'data-reading': c.id,
    }, reading ? fmtValue(reading.value, reading.unit) : '—'));
  }
  return g;
}

// 只刷新端子的高亮状态，避免整层重绘造成的闪烁
function paintPorts() {
  const layer = $('#circ-elements-layer');
  if (!layer) return;
  layer.querySelectorAll('.sim-port').forEach((node) => {
    const key = node.dataset.pin;
    const active = C.pending?.port === key;
    const snapped = C.snap?.port === key;
    const lit = active || snapped || C.hoverPin === key;
    node.setAttribute('r', active || snapped ? 6.2 : lit ? 5.2 : 3.4);
    node.setAttribute('fill', lit ? '#0072bd' : '#7b8b9c');
    node.setAttribute('stroke', lit ? '#ffffff' : 'none');
  });
}

// 数字逻辑门符号：D 形=与/与非，盾形=或/或非，盾形+输入弧=异或/同或，
// 三角=非，输出端小圆圈表示取反。
function gateSymbolParts(type, color, line, txt) {
  const y = H / 2;
  const parts = [];
  const stroke = { fill: '#fff', stroke: color, 'stroke-width': 2 };
  const bubble = (cx) => parts.push(el('circle', { cx, cy: y, r: 6, fill: '#fff', stroke: color, 'stroke-width': 2 }));
  const inverted = type === 'NAND' || type === 'NOR' || type === 'XNOR' || type === 'NOT';

  if (type === 'NOT') {
    parts.push(line(0, y, 38, y));
    parts.push(el('path', {
      d: 'M38 8 L38 40 L74 24 Z',
      ...stroke,
      fill: 'rgba(138,79,181,0.10)',
      'stroke-linejoin': 'round',
    }));
    bubble(81);
    parts.push(line(87, y, W, y));
    parts.push(el('text', { x: 25, y: 17, 'text-anchor': 'middle', class: 'circ-pin-label' }, 'A'));
    parts.push(el('text', { x: 102, y: 17, 'text-anchor': 'middle', class: 'circ-pin-label' }, 'Y'));
    return parts;
  }

  const rectGate = type === 'AND' || type === 'NAND';
  parts.push(line(0, 12, 38, 12), line(0, 36, 38, 36));

  if (rectGate) {
    parts.push(el('path', { d: 'M38 8 H55 A16 16 0 0 1 55 40 H38 Z', ...stroke }));
    txt(52, '&');
  } else {
    // 盾形门体；异或类再多一条输入弧
    parts.push(el('path', { d: 'M38 8 Q58 24 38 40 Q62 40 78 24 Q62 8 38 8 Z', ...stroke }));
    if (type === 'XOR' || type === 'XNOR') {
      parts.push(el('path', { d: 'M32 8 Q52 24 32 40', fill: 'none', stroke: color, 'stroke-width': 2 }));
    }
    txt(56, '≥1');
  }

  const outX = rectGate ? 71 : 78;
  if (inverted) bubble(outX);
  parts.push(line(inverted ? outX + 6 : outX, y, W, y));
  return parts;
}

function symbolParts(c) {
  const color = ELEMENTS[c.type].color || '#44515c';
  const y = H / 2;
  const parts = [];
  const line = (x1, y1, x2, y2) => el('line', {
    x1, y1, x2, y2, stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
  });
  const txt = (x, t, cls = 'circ-sym') => el('text', { x, y: y + 5, 'text-anchor': 'middle', class: cls }, t);

  if (ELEMENTS[c.type]?.group === '数字逻辑') {
    return gateSymbolParts(c.type, color, line, txt);
  }

  switch (c.type) {
    case 'R': {
      parts.push(line(0, y, 36, y));
      parts.push(el('polyline', {
        points: '36,24 42,12 50,36 58,12 66,36 74,12 80,24',
        fill: 'none', stroke: color, 'stroke-width': 2,
      }));
      parts.push(line(80, y, W, y));
      break;
    }
    case 'IMP':
    case 'STEP':
    case 'RAMP':
    case 'PARABOLA': {
      parts.push(line(0, y, 42, y), line(78, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 18, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      const path = c.type === 'IMP' ? 'M48 30 L57 30 L60 13 L63 30 L72 30'
        : c.type === 'STEP' ? 'M49 30 H58 V15 H72'
          : c.type === 'RAMP' ? 'M49 30 L72 15'
            : 'M49 30 Q59 29 72 15';
      parts.push(el('path', {
        d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
      break;
    }
    case 'TF': {
      parts.push(line(0, 12, 16, 12), line(0, 36, 16, 36));
      parts.push(line(104, 12, W, 12), line(104, 36, W, 36));
      parts.push(el('rect', {
        x: 16, y: 4, width: 88, height: 40, rx: 5,
        fill: 'rgba(47,125,104,0.08)', stroke: color, 'stroke-width': 2,
      }));
      parts.push(el('text', {
        x: 60, y: 28, 'text-anchor': 'middle', class: 'circ-sym',
      }, 'H(s)'));
      parts.push(el('text', {
        x: 23, y: 15, class: 'circ-pin-label',
      }, 'A'));
      parts.push(el('text', {
        x: 23, y: 39, class: 'circ-pin-label',
      }, 'B'));
      parts.push(el('text', {
        x: 97, y: 15, 'text-anchor': 'end', class: 'circ-pin-label',
      }, 'Y+'));
      parts.push(el('text', {
        x: 97, y: 39, 'text-anchor': 'end', class: 'circ-pin-label',
      }, 'Y−'));
      break;
    }
    case 'C': {
      parts.push(line(0, y, 52, y), line(68, y, W, y));
      parts.push(line(52, y - 14, 52, y + 14), line(68, y - 14, 68, y + 14));
      break;
    }
    case 'L': {
      parts.push(line(0, y, 36, y), line(84, y, W, y));
      parts.push(el('path', {
        d: 'M36 24 a 8 8 0 0 1 16 0 a 8 8 0 0 1 16 0 a 8 8 0 0 1 16 0',
        fill: 'none', stroke: color, 'stroke-width': 2,
      }));
      break;
    }
    case 'V': {
      parts.push(line(0, y, 45, y), line(75, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 15, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      parts.push(txt(52, '−'), txt(68, '+'));
      break;
    }
    case 'VS': {
      parts.push(line(0, y, 45, y), line(75, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 15, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      parts.push(el('path', {
        d: 'M48 24 q 6 -10 12 0 t 12 0', fill: 'none', stroke: color, 'stroke-width': 2,
      }));
      break;
    }
    case 'I': {
      parts.push(line(0, y, 45, y), line(75, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 15, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      parts.push(line(50, y, 68, y));
      parts.push(el('polyline', {
        points: '63,19 69,24 63,29', fill: 'none', stroke: color, 'stroke-width': 2,
      }));
      break;
    }
    case 'CLK': {
      parts.push(line(0, y, 45, y), line(75, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 15, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      // 方波符号
      parts.push(el('polyline', {
        points: '50,30 56,30 56,18 64,18 64,30 70,30',
        fill: 'none', stroke: color, 'stroke-width': 2,
      }));
      break;
    }
    case 'D': {
      parts.push(line(0, y, 42, y), line(76, y, W, y));
      parts.push(el('path', {
        d: 'M44 11 L68 24 L44 37 Z',
        fill: 'rgba(0,114,189,0.12)', stroke: color, 'stroke-width': 2,
        'stroke-linejoin': 'round',
      }));
      parts.push(line(70, 10, 70, 38));
      parts.push(el('text', {
        x: 43, y: 9, 'text-anchor': 'middle', class: 'circ-pin-label',
      }, 'A'));
      parts.push(el('text', {
        x: 70, y: 9, 'text-anchor': 'middle', class: 'circ-pin-label',
      }, 'K'));
      break;
    }
    case 'A':
    case 'VM': {
      parts.push(line(0, y, 45, y), line(75, y, W, y));
      parts.push(el('circle', { cx: 60, cy: y, r: 15, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      parts.push(txt(60, c.type === 'A' ? 'A' : 'V'));
      break;
    }
    case 'P': {
      parts.push(line(0, y, 32, y));
      parts.push(el('circle', { cx: 42, cy: y, r: 9, fill: '#fff', stroke: color, 'stroke-width': 2 }));
      parts.push(el('text', { x: 42, y: y + 4, 'text-anchor': 'middle', class: 'circ-sym' }, 'P'));
      break;
    }
    case 'GND': {
      parts.push(line(60, H, 60, 32));
      parts.push(line(46, 32, 74, 32), line(51, 27, 69, 27), line(56, 22, 64, 22));
      break;
    }
    default:
      break;
  }
  return parts;
}

function renderNets() {
  const layer = $('#circ-wires-layer');
  layer.innerHTML = '';
  C.model.nets.forEach((net) => {
    const selected = C.sel?.kind === 'net' && C.sel.id === net.id;
    net.segs.forEach((seg) => {
      const d = segPathD(seg);
      if (!d) return;
      layer.appendChild(el('path', {
        d, class: 'circ-wire-hit', 'data-net': net.id, fill: 'none',
        stroke: 'transparent', 'stroke-width': 14,
      }));
      layer.appendChild(el('path', {
        d, class: 'circ-wire', 'data-net': net.id, fill: 'none',
        stroke: selected ? '#0072bd' : '#39485a',
        'stroke-width': selected ? 3 : 2,
      }));
    });
    (net.junctions || []).forEach((p) => {
      layer.appendChild(el('circle', {
        cx: p.x, cy: p.y, r: 3.6, class: 'circ-junction', 'data-net': net.id,
        fill: selected ? '#0072bd' : '#39485a',
      }));
    });
  });
}

function renderProps() {
  const box = $('#circ-props-body');
  if (!C.sel) {
    box.innerHTML = '<div class="placeholder-content">选中一个元件</div>';
    return;
  }
  if (C.sel.kind === 'net') {
    const net = C.model.nets.find((n) => n.id === C.sel.id);
    if (!net) {
      box.innerHTML = '<div class="placeholder-content">选中一个元件</div>';
      return;
    }
    box.innerHTML = `<div class="prop-head">网络<span class="prop-id">${net.id}</span></div>
      <div class="prop-empty">${net.ports.length} 个端子 · ${net.segs.length} 段导线</div>
      <div class="prop-tip">Delete 删除整条网络（这些端子将断开）</div>`;
    return;
  }
  const c = componentById(C.sel.id);
  if (!c) {
    box.innerHTML = '<div class="placeholder-content">选中一个元件</div>';
    return;
  }
  const def = ELEMENTS[c.type];
  const rows = [`<div class="prop-head">${def.cn}<span class="prop-id">${c.id}</span></div>`];
  (def.params || []).forEach((p) => {
    const type = p.type === 'text' ? 'text' : 'number';
    const step = p.type === 'text' ? '' : 'step="any"';
    rows.push(`<div class="prop-row"><label>${p.label}</label>
      <input type="${type}" ${step} data-key="${p.key}" value="${escapeHtml(c.params[p.key] ?? p.def)}"></div>`);
  });
  if (def.group === '数字逻辑') {
    rows.push('<div class="prop-empty">输入按阈值判定；有限输入/输出电阻参与 KCL 求解</div>');
  } else if (c.type === 'D') {
    rows.push('<div class="prop-empty">Shockley 指数模型；参考压降对应 1mA 工作点</div>');
  } else if (c.type === 'TF') {
    rows.push('<div class="prop-empty">A/B 输入差分电压，Y+/Y− 输出；分子、分母支持 s 多项式（如 s^2+2*s+1），最高 8 阶</div>');
  } else if (def.group === '信号源') {
    rows.push('<div class="prop-empty">输出单位电压函数；单位脉冲按当前时间步归一化面积</div>');
  } else if (!(def.params || []).length) {
    rows.push('<div class="prop-empty">该元件无可调参数</div>');
  }
  const rd = C.readings.get(c.id);
  if (rd || ['A', 'VM', 'P', 'TF'].includes(c.type)
    || ELEMENTS[c.type].group === '数字逻辑') {
    rows.push(`<div class="prop-readout" data-live-reading="${c.id}">读数 ${rd ? fmtValue(rd.value, rd.unit) : '—'}</div>`);
  }
  rows.push('<div class="prop-tip">元件、拐点与引脚均自动吸附 12px 网格；左键点端子开始连线，点空白处落拐点，点目标端子完成；右键元件旋转 90°；拖动移动；Delete 删除</div>');
  box.innerHTML = rows.join('');

  box.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.addEventListener('change', () => {
      pausePower();
      const param = def.params.find((item) => item.key === inp.dataset.key);
      c.params[inp.dataset.key] = param?.type === 'text' ? inp.value.trim() : Number(inp.value);
      render();
    });
  });
}

/* ---------------- 实时仿真（通电） ----------------
 * 与瞬态批量仿真共用步进引擎（initSimulation / stepSimulation）：
 * 每帧把墙钟流逝时间 × 速度档位折算成仿真时间，推进步进直到追平为止。
 * 编辑电路会自动断电，防止改到一半把求解器状态搞乱。
 */

function voltageColor(v, scale) {
  const t = Math.max(-1, Math.min(1, v / Math.max(0.5, scale)));
  const a = Math.pow(Math.abs(t), 0.7);
  const from = [0x39, 0x48, 0x5a]; // 默认导线色 #39485a
  const to = t >= 0 ? [0xd9, 0x53, 0x19] : [0x1e, 0x6f, 0xd9]; // 正电位橙 / 负电位蓝
  const mix = (i) => Math.round(from[i] + (to[i] - from[i]) * a);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

function updatePowerBtn() {
  const btn = $('#circ-power');
  if (btn) {
    btn.classList.toggle('power-on', RT.on);
    btn.textContent = RT.on ? '⏸ 暂停实时' : '▶ 实时运行';
  }
  const spd = $('#circ-speed');
  if (spd) spd.textContent = `×${rtSpeed()}`;
  const duration = $('#circ-duration');
  if (duration) duration.disabled = RT.on;
  const dt = $('#circ-dt');
  if (dt) dt.disabled = RT.on;
}

function togglePower() {
  if (RT.on) {
    pausePower('已断电');
    return;
  }
  if (!C.model) return;
  updateModelSettings();
  let sim;
  try {
    sim = initSimulation(C.model, { record: false, skipStepCap: true });
  } catch (e) {
    status(String(e.message || e), true);
    return;
  }
  RT.sim = sim;
  RT.on = true;
  RT.warned = false;
  RT.phase.clear();
  RT.last = performance.now();
  RT.statusAt = 0;
  // 与 sim.readings 共享引用，commit 原地更新，画布表读数每帧可直接取
  C.readings = sim.readings;
  updatePowerBtn();
  status(`${sim.domain === 'signal' ? '信号流' : '电路'}实时运行中（×${rtSpeed()}）`);
  RT.raf = requestAnimationFrame(rtFrame);
}

function pausePower(msg) {
  const wasOn = RT.on;
  RT.on = false;
  cancelAnimationFrame(RT.raf);
  RT.sim = null;
  RT.phase.clear();
  $('#circ-flow-layer')?.remove();
  updatePowerBtn();
  if (wasOn || msg) renderNets(); // 恢复导线与接点的默认着色
  if (msg) status(msg);
}

function cycleSpeed() {
  RT.speedIdx = (RT.speedIdx + 1) % RT_SPEEDS.length;
  RT.warned = false;
  updatePowerBtn();
  if (RT.on) status(`实时速度 ×${rtSpeed()}`);
}

function showElementMenu(target, x, y) {
  const menu = $('#circ-context-menu');
  if (!menu) return;
  C.contextTarget = target.id;
  C.sel = { kind: 'el', id: target.id };
  render();
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

function hideElementMenu() {
  $('#circ-context-menu')?.classList.add('hidden');
  C.contextTarget = null;
}

function updateModelSettings() {
  if (!C.model) return;
  C.model.duration = Number($('#circ-duration').value) || 0.01;
  C.model.dt = Number($('#circ-dt').value) || 1e-5;
}

function rtFrame(ts) {
  if (!RT.on || !RT.sim) return;
  const wall = Math.min(0.1, Math.max(0, (ts - RT.last) / 1000));
  RT.last = ts;
  const sim = RT.sim;
  let budget = (sim.rtAcc || 0) + wall * rtSpeed();
  let ran = 0;
  try {
    while (budget >= sim.dt && ran < RT_MAX_STEPS) {
      budget -= sim.dt;
      stepSimulation(sim);
      ran++;
    }
  } catch (e) {
    pausePower();
    status(String(e.message || e), true);
    return;
  }
  sim.rtAcc = ran >= RT_MAX_STEPS ? 0 : budget;
  if (ran >= RT_MAX_STEPS && !RT.warned) {
    RT.warned = true;
    status('求解速度跟不上，已自动降速（可增大步长）', true);
  }
  if (!RT.warned && ts - RT.statusAt >= 250) {
    RT.statusAt = ts;
    status(`实时仿真 t=${sim.t.toPrecision(4)} s（×${rtSpeed()}）`);
  }
  paintLive(wall);
  RT.raf = requestAnimationFrame(rtFrame);
}

function paintLive(wall) {
  const sim = RT.sim;
  const nets = C.model?.nets || [];
  // 1) 导线与接点按电位着色（本帧最大电位做归一化，0.5V 兜底）
  let scale = 0.5;
  nets.forEach((net) => {
    const v = netVoltage(sim, net.id);
    if (v != null && Math.abs(v) > scale) scale = Math.abs(v);
  });
  const selNet = C.sel?.kind === 'net' ? C.sel.id : null;
  const paint = (node) => {
    const id = node.getAttribute('data-net');
    if (id === selNet) return; // 选中网络保持高亮
    const v = netVoltage(sim, id);
    if (v == null) return;
    const c = voltageColor(v, scale);
    if (node.classList.contains('circ-wire')) node.setAttribute('stroke', c);
    else node.setAttribute('fill', c);
  };
  $('#circ-wires-layer')?.querySelectorAll('.circ-wire, .circ-junction').forEach(paint);
  // 2) 元件电流点：pin0 → pin1 移动
  paintFlowDots(sim, wall);
  // 3) 表读数
  document.querySelectorAll('#circ-elements-layer [data-reading]').forEach((node) => {
    const rd = sim.readings.get(node.dataset.reading);
    if (rd) node.textContent = fmtValue(rd.value, rd.unit);
  });
  const selectedReading = C.sel?.kind === 'el' ? sim.readings.get(C.sel.id) : null;
  const propertyReadout = $('#circ-props-body [data-live-reading]');
  if (propertyReadout) {
    propertyReadout.textContent = selectedReading
      ? `读数 ${fmtValue(selectedReading.value, selectedReading.unit)}`
      : '读数 —';
  }
}

function paintFlowDots(sim, wall) {
  const svg = $('#circ-canvas');
  if (!svg) return;
  let layer = svg.querySelector('#circ-flow-layer');
  if (!layer) {
    layer = el('g', { id: 'circ-flow-layer' });
    svg.appendChild(layer);
  }
  layer.innerHTML = '';
  const advance = wall * rtSpeed();
  (C.model?.components || []).forEach((c) => {
    const i = sim.flows.get(c.id);
    if (i == null || !Number.isFinite(i) || Math.abs(i) < 1e-9) {
      RT.phase.delete(c.id);
      return;
    }
    const p0 = pinPos(c, 0);
    const p1 = pinPos(c, c.pins - 1);
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (len < 1) return;
    // 速度随电流增大而加快，方向由电流符号决定
    const dir = Math.sign(i);
    const strength = Math.max(0, Math.min(1, (Math.log10(Math.abs(i)) + 9) / 9));
    const speed = 16 + 114 * strength;
    let ph = RT.phase.get(c.id) || 0;
    ph += (dir * speed * advance) / len;
    ph -= Math.floor(ph);
    RT.phase.set(c.id, ph);
    for (let k = 0; k < FLOW_DOT_COUNT; k++) {
      let t = ph + k / FLOW_DOT_COUNT;
      t -= Math.floor(t);
      layer.appendChild(el('circle', {
        cx: (p0.x + (p1.x - p0.x) * t).toFixed(1),
        cy: (p0.y + (p1.y - p0.y) * t).toFixed(1),
        r: (2.8 + 1.4 * strength).toFixed(1),
        opacity: (0.45 + 0.5 * strength).toFixed(2),
        class: 'flow-dot',
      }));
    }
  });
}

/* ---------------- 工具栏 / 调色板 ---------------- */

function buildPalette() {
  const list = $('#circ-palette-list');
  const input = $('#circ-search');
  if (!list || !input) return;

  const collapsedGroups = new Set(
    Object.values(ELEMENTS).map((def) => def.group || '其他'),
  );
  const renderList = (query) => {
    const key = query.trim().toLowerCase();
    const items = Object.entries(ELEMENTS).filter(([type, def]) => {
      if (!key) return true;
      const hay = `${def.cn} ${def.en} ${def.group} ${type}`.toLowerCase();
      return hay.includes(key);
    });
    if (!items.length) {
      list.innerHTML = '<div class="comp-empty">没有匹配的元件</div>';
      return;
    }
    const groups = new Map();
    items.forEach(([type, def]) => {
      const g = def.group || '其他';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([type, def]);
    });
    list.innerHTML = [...groups].map(([group, rows]) => {
      const collapsed = !key && collapsedGroups.has(group);
      return `
        <section class="comp-group-section">
          <button class="comp-group" type="button" aria-expanded="${!collapsed}">
            <span class="comp-group-arrow">${collapsed ? '▸' : '▾'}</span>
            <span>${group}</span>
            <span class="comp-group-count">${rows.length}</span>
          </button>
          <div class="comp-group-items${collapsed ? ' hidden' : ''}">
            ${rows.map(([type, def]) => `
              <div class="comp-item" data-type="${type}">
                <span class="palette-bar" style="background:${def.color}"></span>
                <span class="comp-name">${def.cn}</span>
                <span class="comp-en">${def.en}</span>
              </div>`).join('')}
          </div>
        </section>`;
    }).join('');
    list.querySelectorAll('.comp-group').forEach((button) => {
      button.addEventListener('click', () => {
        const group = button.querySelector('span:nth-child(2)').textContent;
        if (collapsedGroups.has(group)) collapsedGroups.delete(group);
        else collapsedGroups.add(group);
        renderList(input.value);
      });
    });
    list.querySelectorAll('.comp-item').forEach((item) => {
      item.addEventListener('click', () => addElement(item.dataset.type));
    });
  };

  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const first = list.querySelector('.comp-item');
    if (first) addElement(first.dataset.type);
  });
  renderList('');
}

function addElement(type) {
  if (!C.model) return;
  pausePower();
  const n = C.model.components.length;
  // 新元件默认落在格点上：横向 144、纵向 132（都是 12 的倍数），引脚随之对齐网格
  const c = createComponent(
    type,
    snapGrid(66 + (n % 4) * 144),
    snapGrid(66 + Math.floor(n / 4) * 132),
  );
  C.model.components.push(c);
  C.sel = { kind: 'el', id: c.id };
  render();
  status(`已添加 ${ELEMENTS[type].cn}`);
}

function bindToolbar() {
  $('#circ-run')?.addEventListener('click', runCircuit);
  $('#circ-power')?.addEventListener('click', togglePower);
  $('#circ-speed')?.addEventListener('click', cycleSpeed);
  $('#circ-clear')?.addEventListener('click', () => {
    if (!C.model) return;
    pausePower();
    C.model.components = [];
    C.model.nets = [];
    C.sel = null;
    cancelPending();
    C.readings = new Map();
    render();
    status('已清空');
  });
  $('#circ-save')?.addEventListener('click', () => saveCircuit(false));
  $('#circ-save-as')?.addEventListener('click', () => saveCircuit(true));
  $('#circ-open')?.addEventListener('click', openCircuitDialog);
  $('#circ-close')?.addEventListener('click', closeCircuit);
  $('#scope-close')?.addEventListener('click', () => $('#scope-window').classList.add('hidden'));
  $('#circ-duration')?.addEventListener('change', updateModelSettings);
  $('#circ-dt')?.addEventListener('change', updateModelSettings);
  const contextMenu = $('#circ-context-menu');
  contextMenu?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const target = componentById(C.contextTarget);
    hideElementMenu();
    if (!target || !action) return;
    if (action === 'edit') {
      C.sel = { kind: 'el', id: target.id };
      render();
      $('#circ-props-body input')?.focus();
    } else if (action === 'rotate') {
      pausePower();
      target.rot = normalizeRot((target.rot || 0) + 90);
      C.sel = { kind: 'el', id: target.id };
      render();
      status(`${ELEMENTS[target.type].cn} 旋转至 ${target.rot}°`);
    } else if (action === 'delete') {
      pausePower();
      C.model.components = C.model.components.filter((c) => c.id !== target.id);
      removeComponentFromNets(target.id);
      C.readings.delete(target.id);
      C.sel = null;
      render();
      status(`已删除 ${ELEMENTS[target.type].cn}`);
    }
    C.contextTarget = null;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu?.contains(event.target)) hideElementMenu();
  });
}

function runCircuit() {
  if (!C.model) return;
  pausePower(); // 切回批量瞬态模式：先断电
  updateModelSettings();
  try {
    const t0 = performance.now();
    const res = simulate(C.model);
    const ms = Math.round(performance.now() - t0);
    C.readings = res.readings;
    render();
    if (res.probes.length) {
      showFigure({
        title: '示波器',
        subtitle: `0 – ${fmtTime(res.duration)} · ${res.dt} s/步`,
        series: res.probes,
      });
      status(`${res.domain === 'signal' ? '信号仿真' : '电路仿真'}完成 ${ms} ms，${res.probes.length} 路探针`);
    } else {
      status(`${res.domain === 'signal' ? '信号仿真' : '电路仿真'}完成 ${ms} ms（未放置示波器探针，仅更新表读数）`);
    }
  } catch (e) {
    status(String(e.message || e), true);
  }
}

/* ---------------- 保存 / 打开 ---------------- */

async function saveCircuit(asNew = false) {
  if (!C.model) return;
  try {
    let path = asNew ? '' : C.path;
    if (!path) {
      path = await pickCircuitPath();
      if (!path) {
        status('已取消保存');
        return;
      }
    }
    await invoke('write_file_content', {
      path, content: JSON.stringify(serialize(C.model), null, 2),
    });
    C.path = path;
    status(`已保存 ${basename(path)}`);
    C.opts.refresh?.();
  } catch (e) {
    status(`保存失败: ${e}`, true);
  }
}

// 另存为：系统保存对话框选路径与文件名，并统一补齐 .ckt 后缀
async function pickCircuitPath() {
  const cwd = String(C.opts.getCwd?.() || '.').replace(/\\/g, '/');
  const suggested = C.path ? basename(C.path) : 'circuit.ckt';
  const chosen = await invoke('save_file_dialog', { defaultName: suggested, ext: 'ckt' });
  let p = String(chosen || '').trim().replace(/\\/g, '/');
  if (!p) return '';
  if (!/\.ckt$/i.test(p)) {
    // 已有其他扩展名就替换掉，没有就补上，保证始终是 .ckt
    p = /\.[a-z0-9]{1,5}$/i.test(p) ? p.replace(/\.[^./]+$/, '.ckt') : `${p}.ckt`;
  }
  // 对话框只返回文件名时，落到当前工作目录
  if (!/[:/]/.test(p)) p = `${cwd}/${p}`;
  return p;
}

// 通过系统文件选择器打开任意路径的 .ckt（不依赖终端 cwd）
async function openCircuitDialog() {
  try {
    const path = await invoke('open_file_dialog', { ext: 'ckt' });
    if (!path) {
      status('已取消打开');
      return;
    }
    await openCircuitFile(path);
  } catch (e) {
    status(`打开失败: ${e}`, true);
  }
}

/* ---------------- 接线 ---------------- */

function netOfPortSafe(key) {
  return netOfPort(key);
}

function mergeNets(a, b) {
  if (!a && !b) {
    const net = { id: uid('n'), ports: [], segs: [], junctions: [] };
    C.model.nets.push(net);
    return net;
  }
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  b.ports.forEach((p) => { if (!a.ports.includes(p)) a.ports.push(p); });
  a.segs.push(...b.segs);
  a.junctions.push(...(b.junctions || []));
  C.model.nets = C.model.nets.filter((n) => n !== b);
  return a;
}

function connectPorts(p1, p2, bends = []) {
  if (p1 === p2) return;
  const n1 = netOfPortSafe(p1);
  const n2 = netOfPortSafe(p2);
  if (n1 && n1 === n2) {
    cancelPending();
    render();
    status('这两个端子已经在同一网络里了');
    return;
  }
  pausePower();
  const net = mergeNets(n1, n2);
  if (!net.ports.includes(p1)) net.ports.push(p1);
  if (!net.ports.includes(p2)) net.ports.push(p2);
  net.segs.push({
    id: uid('w'),
    a: { port: p1 },
    b: { port: p2 },
    via: bends.map((p) => ({ x: p.x, y: p.y })),
  });
  cancelPending();
  render();
  status('已连线');
}

function tapNet(netId, pt) {
  const net = C.model.nets.find((n) => n.id === netId);
  if (!net || !C.pending) return;
  let best = null;
  net.segs.forEach((seg) => {
    const hit = closestOnSeg(seg, pt);
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  });
  if (!best) {
    cancelPending();
    status('已取消连线');
    return;
  }
  const own = netOfPortSafe(C.pending.port);
  pausePower();
  const target = mergeNets(own, net);
  if (!target.ports.includes(C.pending.port)) target.ports.push(C.pending.port);
  // 接点沿导线方向吸附到格点：横线只动 x、竖线只动 y，保证留在导线上
  const jx = best.horizontal ? snapGrid(best.x) : best.x;
  const jy = best.horizontal ? best.y : snapGrid(best.y);
  target.junctions.push({ x: jx, y: jy });
  target.segs.push({
    id: uid('w'),
    a: { port: C.pending.port },
    b: { x: jx, y: jy },
    via: (C.pending.bends || []).map((p) => ({ x: p.x, y: p.y })),
  });
  cancelPending();
  render();
  status('已接入该网络');
}

function onPortClick(key) {
  if (!C.pending) {
    C.pending = { port: key, bends: [] };
    C.cursor = null;
    C.snap = null;
    paintPorts();
    drawTemp();
    status('连线中：点击空白处落拐点，点击目标端子完成（Esc 取消）');
    return;
  }
  if (C.pending.port === key) {
    cancelPending();
    status('已取消连线');
    return;
  }
  connectPorts(C.pending.port, key, C.pending.bends);
}

function nearestPort(pt, excludeKey, radius = 12) {
  let best = null;
  C.model.components.forEach((c) => {
    for (let i = 0; i < c.pins; i++) {
      const key = `${c.id}:${i}`;
      if (key === excludeKey) continue;
      const p = pinPos(c, i);
      const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (dist <= radius && (!best || dist < best.dist)) best = { port: key, x: p.x, y: p.y, dist };
    }
  });
  return best;
}

/* 引脚全部落在格点上，所以可以按整数格点坐标建索引，
 * 光标吸附到格点后一次 Map 命中即为精确引脚，无扫描、无偏移。 */
const pinIndex = new Map();
const gridKeyOf = (p) => `${Math.round(p.x)},${Math.round(p.y)}`;

function rebuildPinIndex() {
  pinIndex.clear();
  (C.model?.components || []).forEach((c) => {
    for (let i = 0; i < c.pins; i++) {
      const p = pinPos(c, i);
      const k = gridKeyOf(p);
      if (!pinIndex.has(k)) pinIndex.set(k, `${c.id}:${i}`);
    }
  });
}

// 命中引脚：先按格点精确匹配，再退回小半径距离扫描（兼容旧文件里的非格点坐标）
function pinAt(pt, excludeKey) {
  const s = snapPoint(pt);
  const key = pinIndex.get(gridKeyOf(s));
  if (key && key !== excludeKey) return { port: key, x: s.x, y: s.y };
  const near = nearestPort(pt, excludeKey, 10);
  return near ? { port: near.port, x: Math.round(near.x), y: Math.round(near.y) } : null;
}

function cancelPending() {
  const was = !!C.pending;
  C.pending = null;
  C.cursor = null;
  C.snap = null;
  C.hoverPin = null;
  const layer = $('#circ-temp-layer');
  if (layer) layer.innerHTML = '';
  if (was) paintPorts();
}

function drawTemp() {
  const layer = $('#circ-temp-layer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!C.pending) return;
  const end = C.snap ? { x: C.snap.x, y: C.snap.y } : C.cursor;
  const pts = pendingPolyline(end);

  // 已确定的拐点用小方块标出来
  (C.pending.bends || []).forEach((p) => {
    layer.appendChild(el('rect', {
      x: p.x - 3, y: p.y - 3, width: 6, height: 6, rx: 1,
      fill: '#0072bd', stroke: '#ffffff', 'stroke-width': 1,
    }));
  });

  if (pts.length >= 2) {
    layer.appendChild(el('path', {
      d: polylineD(pts), fill: 'none', stroke: '#0072bd',
      'stroke-width': 2, 'stroke-dasharray': '6 4',
    }));
  }

  // 起点
  const start = portPos(C.pending.port);
  if (start) {
    layer.appendChild(el('circle', {
      cx: start.x, cy: start.y, r: 6, fill: '#0072bd', stroke: '#fff', 'stroke-width': 1.6,
    }));
  }
  // 吸附到目标端子时的锚环
  if (C.snap) {
    layer.appendChild(el('circle', {
      cx: C.snap.x, cy: C.snap.y, r: 8, fill: 'none', stroke: '#0072bd', 'stroke-width': 2,
    }));
  }
  // 当前光标
  if (!C.snap && C.cursor) {
    layer.appendChild(el('circle', {
      cx: C.cursor.x, cy: C.cursor.y, r: 3, fill: '#0072bd',
    }));
  }
}

/* ---------------- 画布交互 ---------------- */

function toSvg(e) {
  const svg = $('#circ-canvas');
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function bindCanvas() {
  const svg = $('#circ-canvas');
  if (!svg) return;

  svg.addEventListener('pointerdown', (e) => {
    if (!C.model) return;
    if (e.button === 2) return;

    const pin = e.target.closest('[data-pin]');
    if (pin) {
      e.preventDefault();
      onPortClick(pin.dataset.pin);
      return;
    }

    const pt = toSvg(e);

    if (C.pending) {
      const near = pinAt(pt, C.pending.port);
      if (near) {
        onPortClick(near.port);
        return;
      }
      const wire = e.target.closest('[data-net]');
      if (wire) {
        tapNet(wire.dataset.net, pt);
        return;
      }
      // 空白处点击：按吸附后的格点精确落一个拐点，继续连线
      C.pending.bends.push(snapPoint(pt));
      C.cursor = snapPoint(pt);
      C.snap = null;
      drawTemp();
      paintPorts();
      status(`已落第 ${C.pending.bends.length} 个拐点，点击目标端子完成（Esc 取消）`);
      return;
    }

    const element = e.target.closest('[data-element]');
    if (element) {
      const target = componentById(element.dataset.element);
      if (!target) return;
      pausePower();
      C.sel = { kind: 'el', id: target.id };
      C.drag = { id: target.id, dx: pt.x - target.x, dy: pt.y - target.y };
      render();
      return;
    }

    const wire = e.target.closest('[data-net]');
    if (wire) {
      C.sel = { kind: 'net', id: wire.dataset.net };
      render();
      return;
    }

    C.sel = null;
    render();
  });

  // 右键：元件旋转 90°；空白处取消连线
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!C.model) return;
    const node = e.target.closest('[data-element]');
    if (node) {
      const target = componentById(node.dataset.element);
      if (!target) return;
      cancelPending();
      showElementMenu(target, e.clientX, e.clientY);
      return;
    }
    if (C.pending) {
      cancelPending();
      status('已取消连线');
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!C.model || !C.visible) return;
    if (C.drag) {
      const target = componentById(C.drag.id);
      if (!target) return;
      const p = toSvg(e);
      // 拖拽实时吸附格点：引脚随元件原点一起落在网格上
      const nx = Math.max(GRID_OFFSET, snapGrid(p.x - C.drag.dx));
      const ny = Math.max(GRID_OFFSET, snapGrid(p.y - C.drag.dy));
      if (nx !== target.x || ny !== target.y) {
        target.x = nx;
        target.y = ny;
        renderElements();
        renderNets();
      }
    } else if (C.pending) {
      const raw = toSvg(e);
      const near = pinAt(raw, C.pending.port);
      C.snap = near ? { port: near.port, x: near.x, y: near.y } : null;
      C.hoverPin = near ? near.port : null;
      C.cursor = near ? { x: near.x, y: near.y } : snapPoint(raw);
      drawTemp();
      paintPorts();
    } else {
      const near = pinAt(toSvg(e), null);
      const key = near ? near.port : null;
      if (key !== C.hoverPin) {
        C.hoverPin = key;
        paintPorts();
      }
    }
  });

  window.addEventListener('pointerup', () => {
    if (C.drag) C.drag = null;
  });
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (!C.visible) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!C.sel) return;
      e.preventDefault();
      pausePower();
      if (C.sel.kind === 'el') {
        const id = C.sel.id;
        C.model.components = C.model.components.filter((c) => c.id !== id);
        removeComponentFromNets(id);
        C.readings.delete(id);
      } else {
        C.model.nets = C.model.nets.filter((n) => n.id !== C.sel.id);
      }
      C.sel = null;
      render();
    } else if (e.key === 'Escape') {
      if (!$('#circ-context-menu')?.classList.contains('hidden')) {
        hideElementMenu();
      } else if (C.pending) {
        cancelPending();
        status('已取消连线');
      } else {
        closeCircuit();
      }
    }
  });
}

function removeComponentFromNets(id) {
  const pref = `${id}:`;
  C.model.nets.forEach((net) => {
    net.ports = net.ports.filter((p) => !p.startsWith(pref));
    net.segs = net.segs.filter((s) => !(s.a?.port?.startsWith(pref) || s.b?.port?.startsWith(pref)));
  });
  C.model.nets = C.model.nets.filter((n) => n.ports.length || n.segs.length);
}

function fmtValue(v, unit) {
  const a = Math.abs(v);
  if (a >= 1) return `${v.toFixed(a >= 100 ? 1 : 3)} ${unit}`;
  if (a >= 1e-3) return `${(v * 1e3).toFixed(2)} m${unit}`;
  if (a >= 1e-6) return `${(v * 1e6).toFixed(2)} µ${unit}`;
  return `${(v * 1e9).toFixed(1)} n${unit}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}