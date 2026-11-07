// 电路仿真画布：接线、画布交互、键盘快捷键
import { C, el, status, callCloseCircuit } from './ui.js';
import {
  GRID_OFFSET, snapGrid, snapPoint,
  normalizeRot, pinPos, uid,
} from './model.js';
import {
  componentById, pinAt, portPos, closestOnSeg,
  pendingPolyline, polylineD, netOfPort,
} from './geom.js';
import { pausePower, showElementMenu, hideElementMenu } from './power.js';
import {
  render, renderElements, renderNets, paintPorts,
} from './render.js';

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

export function onPortClick(key) {
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

export function cancelPending() {
  const was = !!C.pending;
  C.pending = null;
  C.cursor = null;
  C.snap = null;
  C.hoverPin = null;
  const layer = document.querySelector('#circ-temp-layer');
  if (layer) layer.innerHTML = '';
  if (was) paintPorts();
}

export function drawTemp() {
  const layer = document.querySelector('#circ-temp-layer');
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

export function removeComponentFromNets(id) {
  const pref = `${id}:`;
  C.model.nets.forEach((net) => {
    net.ports = net.ports.filter((p) => !p.startsWith(pref));
    net.segs = net.segs.filter((s) => !(s.a?.port?.startsWith(pref) || s.b?.port?.startsWith(pref)));
  });
  C.model.nets = C.model.nets.filter((n) => n.ports.length || n.segs.length);
}

/* ---------------- 画布交互 ---------------- */

function toSvg(e) {
  const svg = document.querySelector('#circ-canvas');
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function bindCanvas() {
  const svg = document.querySelector('#circ-canvas');
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

export function bindKeys() {
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
      const menu = document.querySelector('#circ-context-menu');
      if (menu && !menu.classList.contains('hidden')) {
        hideElementMenu();
      } else if (C.pending) {
        cancelPending();
        status('已取消连线');
      } else {
        callCloseCircuit();
      }
    }
  });
}