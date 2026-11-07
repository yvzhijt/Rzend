// 电路仿真画布：几何计算、正交路由、引脚索引
import { C } from './ui.js';
import {
  ELEMENTS, GRID_OFFSET, H, W,
  normalizeRot, pinPos, snapGrid, snapPoint,
} from './model.js';

export function componentById(id) {
  return C.model?.components.find((c) => c.id === id) || null;
}

export function portPos(key) {
  const [id, idx] = String(key).split(':');
  const c = componentById(id);
  if (!c) return null;
  return pinPos(c, Number(idx));
}

export function netOfPort(key) {
  return C.model.nets.find((n) => n.ports.includes(key)) || null;
}

export function anchorPos(a) {
  if (!a) return null;
  if (typeof a.port === 'string') return portPos(a.port);
  if (Number.isFinite(a.x) && Number.isFinite(a.y)) return { x: a.x, y: a.y };
  return null;
}

export function exitDir(anchor) {
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
export function orthoRoute(p, q, dp, dq) {
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
export function routeChain(pts, dirs) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    orthoRoute(pts[i - 1], pts[i], dirs[i - 1], dirs[i])
      .slice(1)
      .forEach((p) => out.push(p));
  }
  return out;
}

export function polylineD(pts) {
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

export function segPolyline(seg) {
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

export function segPathD(seg) {
  return polylineD(segPolyline(seg));
}

export function closestOnSeg(seg, pt) {
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
export function pendingPolyline(end) {
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

/* 引脚全部落在格点上，所以可以按整数格点坐标建索引，
 * 光标吸附到格点后一次 Map 命中即为精确引脚，无扫描、无偏移。 */
export const pinIndex = new Map();
const gridKeyOf = (p) => `${Math.round(p.x)},${Math.round(p.y)}`;

export function rebuildPinIndex() {
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
export function pinAt(pt, excludeKey) {
  const s = snapPoint(pt);
  const key = pinIndex.get(gridKeyOf(s));
  if (key && key !== excludeKey) return { port: key, x: s.x, y: s.y };
  const near = nearestPort(pt, excludeKey, 10);
  return near ? { port: near.port, x: Math.round(near.x), y: Math.round(near.y) } : null;
}

export function nearestPort(pt, excludeKey, radius = 12) {
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