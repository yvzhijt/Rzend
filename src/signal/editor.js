/* 信号流图前端编辑器
 *
 * 信号流图(SFG)用有向图表示线性系统的因果关系：
 *   节点(node) = 变量/信号点
 *   支路(edge) = 变量间的传递函数（增益）
 *
 * 支持四种节点：
 *   信号源(SOURCE)  输入，无入边，一个出边
 *   求和点(SUM)     多入一出，每个输入带 ± 符号
 *   传递函数(TF)    一入一出，s 域传递函数
 *   引出点(PICKOFF) 一入多出，信号分叉
 *   示波器(PROBE)   一入无出，观测输出时域响应
 *
 * 梅森公式：T = Σ(P_k · Δ_k) / Δ
 */

import { analyzeSignalGraph } from './analysis.js';
import { simulateResponse } from './simulate.js';
import { showFigure } from '../figure.js';
import { uid, snapGrid, snapPoint } from './model.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs, text) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
  if (text != null) n.textContent = text;
  return n;
};

/* ---------------- 节点几何 ---------------- */

const SG_W = 96;
const SG_H = 40;
const SUM_R = 16;
const PICK_R = 6;
const PROBE_R = 10;

function nodeCenter(node) {
  return { x: node.x + SG_W / 2, y: node.y + SG_H / 2 };
}

function nodeRot(b) {
  return ((b.rot || 0) % 360 + 360) % 360;
}

/* 局部坐标点绕节点中心旋转 rot 度后的绝对坐标（与 SVG rotate 约定一致） */
function localToAbs(b, px, py) {
  const rot = nodeRot(b);
  const cx = SG_W / 2, cy = SG_H / 2;
  let dx = px - cx, dy = py - cy;
  if (rot === 90) { [dx, dy] = [-dy, dx]; }
  else if (rot === 180) { dx = -dx; dy = -dy; }
  else if (rot === 270) { [dx, dy] = [dy, -dx]; }
  return { x: b.x + cx + dx, y: b.y + cy + dy };
}

/* 节点旋转后的可视包围盒 */
function blockBBox(b) {
  const rot = nodeRot(b);
  if (rot === 90 || rot === 270) {
    return {
      x: b.x + (SG_W - SG_H) / 2, y: b.y + (SG_H - SG_W) / 2,
      w: SG_H, h: SG_W,
    };
  }
  return { x: b.x, y: b.y, w: SG_W, h: SG_H };
}

function nodeOutput(node) {
  if (node.type === 'SUM') return localToAbs(node, SG_W / 2 + SUM_R, SG_H / 2);
  if (node.type === 'PICKOFF') return localToAbs(node, SG_W / 2 + PICK_R, SG_H / 2);
  if (node.type === 'SOURCE' || node.type === 'TF') return localToAbs(node, SG_W, SG_H / 2);
  return null;
}

/* 求和点输入端口在左侧圆弧上的角度（从 120° 到 240° 分布） */
function sumInputAngle(i, n) {
  if (n <= 1) return Math.PI;
  const spread = (Math.PI * 2) / 3;
  return Math.PI - spread / 2 + (spread * i) / (n - 1);
}

function nodeInput(node, index) {
  if (node.type === 'TF') return localToAbs(node, 0, SG_H / 2);
  if (node.type === 'PROBE') return localToAbs(node, SG_W / 2 - PROBE_R, SG_H / 2);
  if (node.type === 'PICKOFF') return localToAbs(node, SG_W / 2 - PICK_R, SG_H / 2);
  if (node.type === 'SUM') {
    const n = node.signs ? node.signs.length : 2;
    const a = sumInputAngle(index, n);
    return localToAbs(node, SG_W / 2 + SUM_R * Math.cos(a), SG_H / 2 - SUM_R * Math.sin(a));
  }
  return null;
}

function signalInputCount(node) {
  if (node.type === 'SUM') return Math.max(2, Math.min(8, node.signs?.length || 2));
  if (node.type === 'TF' || node.type === 'PROBE' || node.type === 'PICKOFF') return 1;
  return 0;
}

/* ---------------- 正交路由（移植自电路模块） ---------------- */

// 出线方向一律向右，入线方向一律向左
const OUT_DIR = { x: 1, y: 0 };
const IN_DIR = { x: -1, y: 0 };

/* 正交路由：两端都横走时中点竖折，中点吸附格点，保证整条线严格横平竖直 */
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
  if (pH || qV) return [p, { x: q.x, y: p.y }, q];
  if (pV || qH) return [p, { x: p.x, y: q.y }, q];
  const mx = snapGrid((p.x + q.x) / 2);
  return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
}

/* 依次把一串锚点用正交折线连接起来 */
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

/* 连线折线：起点引脚 → 拐点(via) → 终点引脚，全部正交 */
function wirePolyline(w, fromBlock, toBlock) {
  const p0 = nodeOutput(fromBlock);
  const portIdx = Number(/^in(\d+)$/.exec(w.to.port || 'in0')?.[1] ?? 0);
  const p1 = nodeInput(toBlock, portIdx);
  if (!p0 || !p1) return [];
  const via = (w.via || []).map((p) => ({ x: p.x, y: p.y }));
  const pts = [p0, ...via, p1];
  const dirs = [OUT_DIR, ...via.map(() => null), IN_DIR];
  return routeChain(pts, dirs);
}

/* ---------------- 信号流图状态 ---------------- */

const SG = {
  model: null,        // { blocks: [...], wires: [...] }
  sel: null,          // { kind: 'block'|'wire', id }
  drag: null,         // { id, dx, dy }
  pending: null,      // { fromBlock, fromPort, bends: [] }
  cursor: null,
  snap: null,         // 连线中吸附到的目标端口 { block, portIdx, x, y }
  hover: null,
  hoverPort: null,    // 悬停命中的引脚 { blockId, kind, portIdx }
  hoverPortKey: null,
  statusEl: null,
};

/* ---------------- 初始化 ---------------- */

export function initSignalGraph() {
  SG.statusEl = $('#circ-status');
  buildSignalPalette();
  bindSignalCanvas();
  bindSignalKeys();
  bindSignalToolbar();

  // 右键菜单：点击菜单外任意位置或窗口失焦时自动关闭
  window.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#circ-context-menu')) hideSignalMenu();
  });
  window.addEventListener('blur', () => hideSignalMenu());
}

/* ---------------- 调色板 ---------------- */

const SIGNAL_PALETTE = [
  { type: 'SOURCE', cn: '信号源', en: 'Source', group: '输入', color: '#d95319' },
  { type: 'TF', cn: '传递函数', en: 'Transfer Fcn', group: '基本', color: '#0072bd' },
  { type: 'SUM', cn: '求和点', en: 'Summing Junction', group: '基本', color: '#77ac30' },
  { type: 'PICKOFF', cn: '引出点', en: 'Pick-off Point', group: '基本', color: '#7e2f8e' },
  { type: 'PROBE', cn: '示波器', en: 'Scope', group: '测量', color: '#edb120' },
];

/* 信号源可选的典型输入信号 */
const SOURCE_SIGNALS = [
  { key: 'impulse', cn: '单位脉冲', formula: 'δ(t)' },
  { key: 'step', cn: '单位阶跃', formula: '1(t)' },
  { key: 'ramp', cn: '单位速度', formula: 't' },
  { key: 'para', cn: '单位加速度', formula: 't²/2' },
];

function sourceSignal(b) {
  return SOURCE_SIGNALS.find((s) => s.key === (b.params?.sig || 'step')) || SOURCE_SIGNALS[1];
}

function buildSignalPalette() {
  const list = $('#circ-palette-list');
  const input = $('#circ-search');
  if (!list || !input) return;

  const collapsedGroups = new Set(SIGNAL_PALETTE.map((p) => p.group));

  const renderList = (query) => {
    const key = query.trim().toLowerCase();
    const items = SIGNAL_PALETTE.filter((p) => {
      if (!key) return true;
      return `${p.cn} ${p.en} ${p.group}`.toLowerCase().includes(key);
    });
    if (!items.length) {
      list.innerHTML = '<div class="comp-empty">没有匹配的节点</div>';
      return;
    }
    list.innerHTML = items.map((p) => `
      <div class="palette-item" data-type="${p.type}">
        <span class="palette-bar" style="background:${p.color}"></span>
        <span>${p.cn}</span>
      </div>`).join('');
    list.querySelectorAll('.palette-item').forEach((item) => {
      item.addEventListener('click', () => addSignalBlock(item.dataset.type));
    });
  };

  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = list.querySelector('.palette-item');
      if (first) addSignalBlock(first.dataset.type);
    }
  });
  renderList('');
}

let signalBlockCounter = 0;

/* 新建示波器时分配递增编号：示波器1、示波器2…（取现有最大编号 + 1，删除后不重复） */
function nextProbeName() {
  let max = 0;
  (SG.model?.blocks || []).forEach((b) => {
    if (b.type !== 'PROBE') return;
    const m = /^示波器(\d+)$/.exec(b.params?.name || '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `示波器${max + 1}`;
}

function addSignalBlock(type) {
  if (!SG.model) return;
  const x = snapGrid(120 + (signalBlockCounter % 3) * 180);
  const y = snapGrid(120 + Math.floor(signalBlockCounter / 3) * 140);
  signalBlockCounter++;
  const block = {
    id: uid('s'),
    type,
    x, y,
    params: type === 'TF' ? { num: '1', den: 's + 1' }
      : type === 'SOURCE' ? { sig: 'step' }
      : type === 'PROBE' ? { name: nextProbeName() } : {},
    signs: type === 'SUM' ? [1, 1] : [],
  };
  SG.model.blocks.push(block);
  SG.sel = { kind: 'block', id: block.id };
  renderSignalGraph();
  statusSG(`已添加 ${SIGNAL_PALETTE.find((p) => p.type === type)?.cn || type}`);
}

/* ---------------- 渲染 ---------------- */

function renderSignalGraph() {
  const elLayer = $('#signal-elements-layer');
  const wireLayer = $('#signal-wires-layer');
  if (!elLayer || !wireLayer) return;
  elLayer.innerHTML = '';
  wireLayer.innerHTML = '';
  if (!SG.model) return;

  SG.model.blocks.forEach((b) => elLayer.appendChild(renderBlock(b)));
  SG.model.wires.forEach((w) => wireLayer.appendChild(renderWire(w)));
  const empty = !SG.model.blocks.length;
  $('#circ-empty')?.classList.toggle('hidden', !empty);
}

function blockColor(type) {
  return SIGNAL_PALETTE.find((p) => p.type === type)?.color || '#555';
}

function fmtGain(num, den) {
  const n = String(num || '1').trim();
  const d = String(den || '1').trim();
  if (n === '1' && d === '1') return '';
  if (d === '1') return n;
  return `${n.length > 6 ? '…' : n}/${d.length > 6 ? '…' : d}`;
}

function renderBlock(b) {
  const sel = SG.sel?.kind === 'block' && SG.sel.id === b.id;
  const hover = SG.hover === b.id;
  const rot = nodeRot(b);
  const g = el('g', {
    class: 'sg-block',
    'data-block': b.id,
    transform: `translate(${b.x},${b.y})${rot ? ` rotate(${rot} ${SG_W / 2} ${SG_H / 2})` : ''}`,
    cursor: 'pointer',
  });
  const color = blockColor(b.type);
  // 文字反向旋转，保持水平可读
  const tRot = (x, y) => (rot ? `rotate(${-rot} ${x} ${y})` : null);

  // 方块
  if (b.type === 'TF' || b.type === 'SOURCE') {
    g.appendChild(el('rect', {
      x: 0, y: 0, width: SG_W, height: SG_H, rx: 5,
      fill: sel ? 'rgba(0,114,189,0.08)' : '#fff',
      stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': sel ? 2 : 1.5,
    }));
    let label = b.type === 'SOURCE' ? sourceSignal(b).cn : 'G(s)';
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H / 2 + 4, 'text-anchor': 'middle',
      class: 'sg-label', fill: color, 'font-weight': '600',
      transform: tRot(SG_W / 2, SG_H / 2 + 4),
    }, label));
    if (b.type === 'TF') {
      const gain = fmtGain(b.params.num, b.params.den);
      if (gain) {
        g.appendChild(el('text', {
          x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
          class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
          transform: tRot(SG_W / 2, SG_H + 10),
        }, gain));
      }
    }
    if (b.type === 'SOURCE') {
      g.appendChild(el('text', {
        x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
        class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
        transform: tRot(SG_W / 2, SG_H + 10),
      }, `r(t) = ${sourceSignal(b).formula}`));
    }
  }

  // 求和点（圆圈）
  if (b.type === 'SUM') {
    g.appendChild(el('circle', {
      cx: SG_W / 2, cy: SG_H / 2, r: SUM_R,
      fill: sel ? 'rgba(119,172,48,0.12)' : '#fff',
      stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': sel ? 2.5 : 1.5,
    }));
    // ± 符号标在各输入端口旁
    const signs = b.signs || [1, 1];
    const n = signs.length;
    for (let i = 0; i < n; i++) {
      const a = sumInputAngle(i, n);
      const lx = SG_W / 2 + (SUM_R + 13) * Math.cos(a);
      const ly = SG_H / 2 - (SUM_R + 13) * Math.sin(a);
      g.appendChild(el('text', {
        x: lx, y: ly + 5, 'text-anchor': 'middle',
        class: 'sg-sum-sign', fill: signs[i] >= 0 ? '#77ac30' : '#d95319',
        'font-size': '14px', 'font-weight': 'bold',
        transform: tRot(lx, ly + 5),
      }, signs[i] >= 0 ? '+' : '−'));
    }
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
      class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
      transform: tRot(SG_W / 2, SG_H + 10),
    }, `${n} 路输入`));
  }

  // 引出点（实心圆点）
  if (b.type === 'PICKOFF') {
    g.appendChild(el('circle', {
      cx: SG_W / 2, cy: SG_H / 2, r: PICK_R,
      fill: '#7e2f8e', stroke: sel ? '#0072bd' : '#7e2f8e',
      'stroke-width': sel ? 2.5 : 1.5,
    }));
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
      class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
      transform: tRot(SG_W / 2, SG_H + 10),
    }, '引出点'));
  }

  // 示波器
  if (b.type === 'PROBE') {
    g.appendChild(el('circle', {
      cx: SG_W / 2, cy: SG_H / 2, r: PROBE_R,
      fill: sel ? 'rgba(237,177,32,0.15)' : '#fff',
      stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': sel ? 2.5 : 1.5,
    }));
    // 方波波形图标
    const cx = SG_W / 2, cy = SG_H / 2;
    g.appendChild(el('path', {
      d: `M ${cx - 5.5} ${cy + 3} L ${cx - 2.5} ${cy + 3} L ${cx - 2.5} ${cy - 3}`
        + ` L ${cx + 0.5} ${cy - 3} L ${cx + 0.5} ${cy + 1} L ${cx + 5.5} ${cy + 1}`,
      fill: 'none', stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      transform: tRot(cx, cy),
    }));
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
      class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
      transform: tRot(SG_W / 2, SG_H + 10),
    }, b.params?.name || '示波器'));
  }

  // 输入/输出引脚（连线中或悬停时放大高亮）
  const pendingMode = !!SG.pending;
  const hp = SG.hoverPort;
  const out = nodeOutput(b);
  if (out) {
    const isSrc = pendingMode && SG.pending.fromBlock === b.id;
    const isHover = hp && hp.blockId === b.id && hp.kind === 'out';
    g.appendChild(el('circle', {
      cx: out.x - b.x, cy: out.y - b.y, r: isSrc || isHover ? 5 : 3.5,
      fill: isSrc ? '#0072bd' : '#fff',
      stroke: isSrc || isHover ? '#0072bd' : color,
      'stroke-width': 1.5,
      class: 'sg-port',
    }));
  }
  for (let i = 0; i < signalInputCount(b); i++) {
    const p = nodeInput(b, i);
    if (!p) continue;
    const occupied = SG.model.wires.some((w) =>
      w.to.block === b.id && w.to.port === `in${i}`);
    const isHover = hp && hp.blockId === b.id && hp.kind === 'in' && hp.portIdx === i;
    g.appendChild(el('circle', {
      cx: p.x - b.x, cy: p.y - b.y, r: (pendingMode && !occupied) || isHover ? 5 : 3.5,
      fill: occupied ? '#c3cdd6' : '#fff',
      stroke: (pendingMode && !occupied) || isHover ? '#0072bd' : color,
      'stroke-width': 1.5,
      class: 'sg-port',
    }));
  }

  return g;
}

function renderWire(w) {
  const fromBlock = SG.model.blocks.find((b) => b.id === w.from.block);
  const toBlock = SG.model.blocks.find((b) => b.id === w.to.block);
  if (!fromBlock || !toBlock) return el('g');

  const sel = SG.sel?.kind === 'wire' && SG.sel.id === w.id;
  const pts = wirePolyline(w, fromBlock, toBlock);
  if (pts.length < 2) return el('g');
  const d = polylineD(pts);

  const g = el('g', { class: 'sg-wire', 'data-wire': w.id });
  // 透明宽命中区
  g.appendChild(el('path', {
    d, fill: 'none', stroke: 'transparent', 'stroke-width': 16,
    class: 'sg-wire-hit', 'data-wire': w.id,
  }));
  g.appendChild(el('path', {
    d, fill: 'none',
    stroke: sel ? '#0072bd' : '#7b8b9c',
    'stroke-width': sel ? 2.5 : 1.8,
    'marker-end': 'url(#signal-arrow)',
  }));
  return g;
}

/* ---------------- 画布交互 ---------------- */

function toSvgSG(e) {
  const svg = $('#circ-canvas');
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function bindSignalCanvas() {
  const svg = $('#circ-canvas');
  if (!svg) return;

  svg.addEventListener('pointerdown', (e) => {
    if (!SG.model) return;
    if (e.button === 2) return;

    // 连线中（参照电路交互）：点击目标节点完成，点击信号线取消，点击空白落拐点
    if (SG.pending) {
      const pt = toSvgSG(e);
      const target = portAt(pt);
      if (target) {
        finishSignalWire(target.block.id);
        return;
      }
      if (e.target.closest('[data-wire]')) {
        cancelSignalPending();
        statusSG('已取消连线');
        return;
      }
      if (!e.target.closest('[data-block]')) {
        // 空白处：按吸附格点落一个拐点，继续连线
        const sp = snapPoint(pt);
        SG.pending.bends.push(sp);
        SG.cursor = sp;
        SG.snap = null;
        renderSignalGraph();
        updateSignalPreview();
        statusSG(`已落第 ${SG.pending.bends.length} 个拐点，点击目标节点完成（Esc 取消）`);
      }
      return;
    }

    // Proteus 式连线：单击输出引脚立即开始（也可按住拖到目标引脚松手完成）
    const downPt = toSvgSG(e);
    const pinHit = portHitAt(downPt);
    if (pinHit && pinHit.kind === 'out') {
      e.preventDefault();
      startSignalWire(pinHit.block.id);
      return;
    }

    // 点击 block
    const blockEl = e.target.closest('[data-block]');
    if (blockEl) {
      const b = SG.model.blocks.find((b) => b.id === blockEl.dataset.block);
      if (!b) return;
      SG.sel = { kind: 'block', id: b.id };
      const pt = toSvgSG(e);
      SG.drag = {
        id: b.id,
        dx: pt.x - b.x,
        dy: pt.y - b.y,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      updateSignalSelection();
      renderSignalProps();
      return;
    }

    // 点击 wire
    const wireEl = e.target.closest('[data-wire]');
    if (wireEl) {
      SG.sel = { kind: 'wire', id: wireEl.dataset.wire };
      SG.drag = null;
      updateSignalSelection();
      renderSignalProps();
      return;
    }

    // 空白处
    SG.sel = null;
    SG.drag = null;
    updateSignalSelection();
    renderSignalProps();
  });

  svg.addEventListener('contextmenu', (e) => {
    if (!SG.model) return;
    e.preventDefault();
    const blockEl = e.target.closest('[data-block]');
    if (blockEl) {
      const b = SG.model.blocks.find((b) => b.id === blockEl.dataset.block);
      if (!b) return;
      SG.sel = { kind: 'block', id: b.id };
      renderSignalGraph();
      showSignalMenu(b, e.clientX, e.clientY);
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!SG.model) return;
    if (SG.drag) {
      if (!SG.drag.moved) {
        const dx = e.clientX - SG.drag.startX;
        const dy = e.clientY - SG.drag.startY;
        if (dx * dx + dy * dy < 9) return;
        SG.drag.moved = true;
      }
      const b = SG.model.blocks.find((b) => b.id === SG.drag.id);
      if (!b) return;
      const pt = toSvgSG(e);
      b.x = snapGrid(pt.x - SG.drag.dx);
      b.y = snapGrid(pt.y - SG.drag.dy);
      renderSignalGraph();
      return;
    }
    // 连线中：端口吸附 + 正交预览线
    if (SG.pending) {
      svg.style.cursor = 'crosshair';
      const raw = toSvgSG(e);
      SG.snap = portAt(raw);
      SG.cursor = SG.snap ? { x: SG.snap.x, y: SG.snap.y } : snapPoint(raw);
      updateSignalPreview();
      return;
    }
    // hover 高亮：引脚悬停高亮 + 十字光标（Proteus 式）
    const pinHover = portHitAt(toSvgSG(e));
    const pinKey = pinHover ? `${pinHover.block.id}:${pinHover.kind}:${pinHover.portIdx}` : null;
    if (pinKey !== SG.hoverPortKey) {
      SG.hoverPortKey = pinKey;
      SG.hoverPort = pinHover
        ? { blockId: pinHover.block.id, kind: pinHover.kind, portIdx: pinHover.portIdx }
        : null;
      renderSignalGraph();
    }
    svg.style.cursor = pinHover && pinHover.kind === 'out' ? 'crosshair' : '';
    // hover 高亮
    const el = e.target.closest('[data-block]');
    const id = el ? el.dataset.block : null;
    if (id !== SG.hover) {
      SG.hover = id;
      renderSignalGraph();
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (SG.drag) {
      const moved = SG.drag.moved;
      SG.drag = null;
      if (moved) renderSignalGraph();
      renderSignalProps();
      return;
    }
    // 拖线松手：落在其他节点的引脚上即完成连线（Proteus 式拖拽连线）
    if (SG.pending) {
      const hit = portHitAt(toSvgSG(e));
      if (hit && hit.block.id !== SG.pending.fromBlock) {
        finishSignalWire(hit.block.id);
      }
    }
  });
}

function updateSignalSelection() {
  const svg = $('#circ-canvas');
  if (!svg) return;
  svg.querySelectorAll('.sg-block.selected, .sg-wire.selected')
    .forEach((node) => node.classList.remove('selected'));
  if (!SG.sel) return;
  const attribute = SG.sel.kind === 'block' ? 'data-block' : 'data-wire';
  [...svg.querySelectorAll(`[${attribute}]`)]
    .find((node) => node.getAttribute(attribute) === SG.sel.id)
    ?.classList.add('selected');
}

/* ---------------- 右键菜单 ---------------- */

function showSignalMenu(block, cx, cy) {
  const menu = $('#circ-context-menu');
  if (!menu) return;

  // 动态构建菜单项
  let html = '';
  if (block.type === 'TF') {
    html += '<button type="button" role="menuitem" data-action="edit-tf">编辑传递函数</button>';
  }
  if (block.type === 'SOURCE') {
    const cur = sourceSignal(block).key;
    SOURCE_SIGNALS.forEach((s) => {
      const mark = s.key === cur ? '✓ ' : '　';
      html += `<button type="button" role="menuitem" data-action="set-sig" data-sig="${s.key}">${mark}${s.cn}　${s.formula}</button>`;
    });
  }
  if (block.type === 'SUM') {
    html += '<button type="button" role="menuitem" data-action="add-input">添加输入端</button>';
    html += '<button type="button" role="menuitem" data-action="remove-input">移除输入端</button>';
  }
  html += '<button type="button" role="menuitem" data-action="rotate-sg">旋转 90°</button>';
  html += '<button type="button" role="menuitem" data-action="delete-sg">删除节点</button>';
  menu.innerHTML = html;
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(cx, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(cy, window.innerHeight - rect.height - 4))}px`;

  // 绑定事件
  const sel = SG.model.blocks.find((b) => b.id === block.id);
  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = () => {
      hideSignalMenu();
      if (!sel) return;
      if (btn.dataset.action === 'delete-sg') {
        deleteSignalBlock(sel.id);
      } else if (btn.dataset.action === 'edit-tf') {
        editTransferFunction(sel);
      } else if (btn.dataset.action === 'set-sig') {
        sel.params = sel.params || {};
        sel.params.sig = btn.dataset.sig;
        renderSignalGraph();
        renderSignalProps();
        statusSG(`输入信号已设为${sourceSignal(sel).cn} ${sourceSignal(sel).formula}`);
      } else if (btn.dataset.action === 'rotate-sg') {
        sel.rot = ((sel.rot || 0) + 90) % 360;
        renderSignalGraph();
        renderSignalProps();
        statusSG(`已旋转到 ${sel.rot}°`);
      } else if (btn.dataset.action === 'add-input') {
        if (sel.signs.length >= 8) {
          statusSG('求和点最多支持 8 个输入端', true);
          return;
        }
        sel.signs.push(1);
        renderSignalGraph();
        renderSignalProps();
        statusSG('已添加输入端（+）');
      } else if (btn.dataset.action === 'remove-input') {
        if (sel.signs.length <= 2) {
          statusSG('求和点至少需要 2 个输入端', true);
          return;
        }
        sel.signs.pop();
        // 移除连接到该端口的 wires
        SG.model.wires = SG.model.wires.filter((w) => {
          if (w.to.block !== sel.id) return true;
          const portIdx = Number(w.to.port?.slice(2) || 0);
          return portIdx < sel.signs.length;
        });
        renderSignalGraph();
        renderSignalProps();
        statusSG('已移除输入端');
      }
    };
  });
}

function hideSignalMenu() {
  const menu = $('#circ-context-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = `
      <button type="button" role="menuitem" data-action="edit">编辑属性</button>
      <button type="button" role="menuitem" data-action="rotate">旋转 90°</button>
      <button type="button" role="menuitem" data-action="delete">删除元件</button>`;
  }
}

function deleteSignalBlock(id) {
  SG.model.blocks = SG.model.blocks.filter((b) => b.id !== id);
  SG.model.wires = SG.model.wires.filter((w) => w.from.block !== id && w.to.block !== id);
  SG.sel = null;
  renderSignalGraph();
  renderSignalProps();
  statusSG('已删除节点');
}

function editTransferFunction(block) {
  const num = prompt('分子 N(s)，例如 2*s 或 s^2+1', block.params.num || '1');
  const den = prompt('分母 D(s)，例如 s+1 或 s^2+2*s+1', block.params.den || '1');
  if (num == null || den == null) {
    statusSG('已取消编辑');
    return;
  }
  block.params.num = num.trim() || '1';
  block.params.den = den.trim() || '1';
  renderSignalGraph();
  renderSignalProps();
  statusSG(`传递函数已更新：${block.params.num} / ${block.params.den}`);
}

/* ---------------- 属性面板 ---------------- */

function renderSignalProps() {
  const box = $('#circ-props-body');
  if (!box) return;
  if (!SG.sel || SG.sel.kind !== 'block') {
    box.innerHTML = '<div class="placeholder-content">在右侧选择节点后编辑属性</div>';
    return;
  }
  const b = SG.model.blocks.find((b) => b.id === SG.sel.id);
  if (!b) {
    box.innerHTML = '<div class="placeholder-content">选择信号流图中的一个节点</div>';
    return;
  }

  const cn = SIGNAL_PALETTE.find((p) => p.type === b.type)?.cn || b.type;
  let rows = [`<div class="prop-head">${cn}<span class="prop-id">${b.id}</span></div>`];

  if (b.type === 'TF') {
    rows.push(`<div class="prop-row"><label>分子 N(s)</label>
      <input type="text" data-key="num" value="${esc(b.params.num || '1')}"></div>`);
    rows.push(`<div class="prop-row"><label>分母 D(s)</label>
      <input type="text" data-key="den" value="${esc(b.params.den || '1')}"></div>`);
  }

  if (b.type === 'SOURCE') {
    const cur = sourceSignal(b).key;
    rows.push(`<div class="prop-row"><label>输入信号类型</label>
      <select data-key="sig">
        ${SOURCE_SIGNALS.map((s) =>
          `<option value="${s.key}"${s.key === cur ? ' selected' : ''}>${s.cn}　${s.formula}</option>`).join('')}
      </select></div>`);
  }

  if (b.type === 'SUM') {
    rows.push('<div class="prop-row"><label>输入端符号（点击切换 ±）</label></div>');
    const signsHtml = (b.signs || [1, 1]).map((s, i) =>
      `<button class="sum-sign-btn" data-idx="${i}" style="color:${s >= 0 ? '#77ac30' : '#d95319'};font-weight:bold;font-size:16px;padding:4px 10px;margin:2px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;cursor:pointer">
        ${s >= 0 ? '+' : '−'} in${i}
      </button>`
    ).join('');
    rows.push(`<div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:8px">${signsHtml}</div>`);
    rows.push('<div class="prop-tip">右键点击求和点可增减输入端；连线时自动分配空闲输入端，点击 ± 可切换正负</div>');
  }

  if (b.type === 'PICKOFF') {
    rows.push('<div class="prop-tip">引出点将信号无衰减地分叉到多个输出；也可直接双击信号线自动生成引出点分支</div>');
  }

  if (b.type === 'PROBE') {
    rows.push('<div class="prop-tip">示波器：观测该点时域响应。设置输入信号与仿真时间后点击「▶ 仿真」（或双击本节点）</div>');
  }

  rows.push('<div class="prop-tip">右键节点打开菜单 · Delete 键删除 · 单击输出引脚开始连线（可拖到目标引脚松手），点击空白落拐点，自动吸附网格</div>');
  box.innerHTML = rows.join('');

  // 绑定 SUM 符号切换
  box.querySelectorAll('.sum-sign-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      b.signs[idx] = -b.signs[idx];
      renderSignalGraph();
      renderSignalProps();
    });
  });

  // 绑定 TF 参数编辑与信号源类型选择
  box.querySelectorAll('input[data-key], select[data-key]').forEach((inp) => {
    inp.addEventListener('change', () => {
      b.params[inp.dataset.key] = inp.value.trim() || '1';
      renderSignalGraph();
      renderSignalProps();
    });
  });
}

/* ---------------- 连线 ---------------- */

function findFreeSumInput(b) {
  const n = signalInputCount(b);
  for (let i = 0; i < n; i++) {
    const occupied = SG.model.wires.some((w) =>
      w.to.block === b.id && w.to.port === `in${i}`);
    if (!occupied) return i;
  }
  return -1;
}

/* 双击信号线：在点击处自动插入引出点，把原线一分为二，
   并以新引出点为起点开始一条分支连线 */
function startWireBranchFromWire(wireId, pt) {
  const wire = SG.model.wires.find((w) => w.id === wireId);
  if (!wire) return;
  const dest = { block: wire.to.block, port: wire.to.port };
  const pick = {
    id: uid('s'),
    type: 'PICKOFF',
    x: snapGrid(pt.x - SG_W / 2),
    y: snapGrid(pt.y - SG_H / 2),
    params: {},
    signs: [],
  };
  SG.model.blocks.push(pick);
  // 原线改为 源 → 引出点
  wire.to = { block: pick.id, port: 'in0' };
  // 引出点 → 原目的地
  SG.model.wires.push({
    id: uid('sw'),
    from: { block: pick.id, port: 'out' },
    to: dest,
    via: [],
  });
  // 以引出点为起点开始新分支
  SG.sel = { kind: 'block', id: pick.id };
  SG.pending = { fromBlock: pick.id, fromPort: 'out', bends: [] };
  SG.cursor = null;
  SG.snap = null;
  renderSignalGraph();
  updateSignalSelection();
  renderSignalProps();
  statusSG('已自动创建引出点：点击空白可落拐点，点击目标节点完成分支（Esc 取消）');
}

/* 命中引脚：光标靠近引脚圆点时精确命中（Proteus 式），返回最近的一个 */
function portHitAt(pt) {
  if (!SG.model) return null;
  const R = 9;
  let best = null;
  for (const b of SG.model.blocks) {
    const out = nodeOutput(b);
    if (out) {
      const d = Math.hypot(pt.x - out.x, pt.y - out.y);
      if (d <= R && (!best || d < best.dist)) {
        best = { block: b, kind: 'out', portIdx: -1, x: out.x, y: out.y, dist: d };
      }
    }
    for (let i = 0; i < signalInputCount(b); i++) {
      const p = nodeInput(b, i);
      if (!p) continue;
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d <= R && (!best || d < best.dist)) {
        best = { block: b, kind: 'in', portIdx: i, x: p.x, y: p.y, dist: d };
      }
    }
  }
  return best;
}

/* 命中节点输入端口：光标落在节点可视范围内即视为指向其输入端
   （求和点优先吸附空闲端；全满时仍返回节点，由 finishSignalWire 自动新增端口） */
function portAt(pt) {
  if (!SG.model) return null;
  for (const b of SG.model.blocks) {
    const bb = blockBBox(b);
    if (pt.x >= bb.x && pt.x <= bb.x + bb.w && pt.y >= bb.y && pt.y <= bb.y + bb.h) {
      let portIdx = 0;
      if (b.type === 'SUM') {
        const free = findFreeSumInput(b);
        if (free !== -1) portIdx = free;
      }
      const p = nodeInput(b, portIdx);
      if (p) return { block: b, portIdx, x: p.x, y: p.y };
    }
  }
  return null;
}

/* 连线预览：起点引脚 → 已落拐点 → 光标（吸附格点或目标端口）的正交虚线 */
function updateSignalPreview() {
  const layer = $('#signal-temp-layer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!SG.pending || !SG.model) return;
  const from = SG.model.blocks.find((b) => b.id === SG.pending.fromBlock);
  if (!from) return;
  const p0 = nodeOutput(from);
  if (!p0) return;
  const end = SG.snap || (SG.cursor ? { x: SG.cursor.x, y: SG.cursor.y } : null);
  const bends = (SG.pending.bends || []).map((p) => ({ x: p.x, y: p.y }));
  // 已落拐点标成小方块
  bends.forEach((p) => {
    layer.appendChild(el('rect', {
      x: p.x - 3, y: p.y - 3, width: 6, height: 6, rx: 1,
      fill: '#0072bd', stroke: '#ffffff', 'stroke-width': 1,
    }));
  });
  if (end) {
    const pts = [p0, ...bends, { x: end.x, y: end.y }];
    const dirs = [OUT_DIR, ...bends.map(() => null),
      SG.snap ? IN_DIR : null];
    const poly = routeChain(pts, dirs);
    if (poly.length >= 2) {
      layer.appendChild(el('path', {
        d: polylineD(poly), fill: 'none', stroke: '#0072bd',
        'stroke-width': 2, 'stroke-dasharray': '6 4',
      }));
    }
  }
  // 起点
  layer.appendChild(el('circle', {
    cx: p0.x, cy: p0.y, r: 5, fill: '#0072bd', stroke: '#fff', 'stroke-width': 1.5,
  }));
  // 吸附到目标端口时的锚环
  if (SG.snap) {
    layer.appendChild(el('circle', {
      cx: SG.snap.x, cy: SG.snap.y, r: 8,
      fill: 'none', stroke: '#0072bd', 'stroke-width': 2,
    }));
  } else if (end) {
    layer.appendChild(el('circle', {
      cx: end.x, cy: end.y, r: 3, fill: '#0072bd',
    }));
  }
}

function startSignalWire(blockId) {
  const block = SG.model?.blocks.find((b) => b.id === blockId);
  if (!block || !nodeOutput(block)) {
    statusSG('示波器没有输出端，不能从此处开始连线', true);
    return;
  }
  SG.pending = { fromBlock: blockId, fromPort: 'out', bends: [] };
  SG.cursor = null;
  SG.snap = null;
  renderSignalGraph();
  statusSG('连线中：拖到目标引脚松手，或点击空白落拐点后点击目标节点（Esc 取消）');
}

function finishSignalWire(toBlockId) {
  if (!SG.pending) return;
  const fromBlock = SG.model.blocks.find((b) => b.id === SG.pending.fromBlock);
  const toBlock = SG.model.blocks.find((b) => b.id === toBlockId);
  if (!fromBlock || !nodeOutput(fromBlock) || !toBlock) {
    cancelSignalPending();
    statusSG('请选择有效的输出端和输入端', true);
    return;
  }
  // 不能自己连自己
  if (SG.pending.fromBlock === toBlockId) {
    cancelSignalPending();
    statusSG('不能将节点连接到自己');
    return;
  }
  // 目标输入端口：求和点自动分配空闲端，满了自动新增；其余类型只有一个输入端
  let portIdx = 0;
  if (toBlock.type === 'SUM') {
    portIdx = findFreeSumInput(toBlock);
    if (portIdx === -1) {
      if (signalInputCount(toBlock) >= 8) {
        cancelSignalPending();
        statusSG('求和点最多支持 8 个输入端', true);
        return;
      }
      toBlock.signs.push(1);
      portIdx = toBlock.signs.length - 1;
      statusSG('求和点输入端已满，已自动新增输入端（+）');
    }
  }
  const toPort = `in${portIdx}`;
  // 检查是否重复
  const dup = SG.model.wires.some((w) =>
    w.from.block === SG.pending.fromBlock && w.to.block === toBlockId && w.to.port === toPort);
  if (dup) {
    cancelSignalPending();
    statusSG('这两个端口已经连过了');
    return;
  }
  // 检查目标输入端是否已被占用
  const dupInput = SG.model.wires.some((w) =>
    w.to.block === toBlockId && w.to.port === toPort);
  if (dupInput) {
    cancelSignalPending();
    statusSG('该输入端已被占用，请选择其他端口', true);
    return;
  }
  SG.model.wires.push({
    id: uid('sw'),
    from: { block: SG.pending.fromBlock, port: SG.pending.fromPort },
    to: { block: toBlockId, port: toPort },
    via: (SG.pending.bends || []).map((p) => ({ x: p.x, y: p.y })),
  });
  cancelSignalPending();
  renderSignalGraph();
  statusSG('已连线');
}

function cancelSignalPending() {
  SG.pending = null;
  SG.cursor = null;
  SG.snap = null;
  updateSignalPreview();
  renderSignalGraph();
}

/* ---------------- 工具栏 ---------------- */

function bindSignalToolbar() {
  $('#circ-run')?.addEventListener('click', runSimulation);

  const svg = $('#circ-canvas');
  svg?.addEventListener('click', (e) => {
    if (!SG.model) return;
    // 连线中的点击已在 pointerdown 处理（完成/落拐点/取消）
    if (SG.pending) return;
    const blockEl = e.target.closest('[data-block]');
    // 双击示波器直接仿真
    if (e.detail >= 2 && blockEl) {
      const b = SG.model.blocks.find((x) => x.id === blockEl.dataset.block);
      if (b?.type === 'PROBE') runSimulation();
      return;
    }
    // 双击信号线自动创建引出点分支（连线为悬停引脚单击发起）
    const wireEl = e.target.closest('[data-wire]');
    if (e.detail >= 2 && wireEl) startWireBranchFromWire(wireEl.dataset.wire, toSvgSG(e));
  });
}

/* ---------------- 视图切换 ---------------- */

function statusSG(msg, isError) {
  const el = SG.statusEl;
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? '#c0392b' : '';
    if (!isError) setTimeout(() => { if (el.textContent === msg) el.style.color = ''; }, 2000);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------------- 键盘 ---------------- */

function bindSignalKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!SG.sel) return;
      e.preventDefault();
      if (SG.sel.kind === 'block') {
        deleteSignalBlock(SG.sel.id);
      } else if (SG.sel.kind === 'wire') {
        SG.model.wires = SG.model.wires.filter((w) => w.id !== SG.sel.id);
        SG.sel = null;
        renderSignalGraph();
        renderSignalProps();
        statusSG('已删除连线');
      }
    } else if (e.key === 'Escape') {
      if (SG.pending) {
        cancelSignalPending();
        statusSG('已取消连线');
      } else {
        hideSignalMenu();
      }
    }
  });
}

function runSimulation() {
  if (!SG.model || !SG.model.blocks.length) {
    statusSG('信号流图为空，请先添加节点', true);
    return;
  }
  const result = analyzeSignalGraph(SG.model);
  if (result.error) {
    statusSG(result.error, true);
    return;
  }
  const T = Number($('#sig-sim-time')?.value) || 10;
  if (!(T > 0)) {
    statusSG('仿真时间必须大于 0', true);
    return;
  }
  const sig = sourceSignal(result.source);

  /* 每个示波器的时域响应 */
  const series = [];
  const tfLines = [];
  result.probes.forEach((p, i) => {
    const name = p.block.params?.name || `示波器${i + 1}`;
    if (!p.tf) {
      tfLines.push(`<div style="margin:3px 0;font-family:var(--mono);font-size:12px">
        <b>${esc(name)}</b>　${esc(p.error || '无法计算')}</div>`);
      return;
    }
    tfLines.push(`<div style="margin:3px 0;font-family:var(--mono);font-size:12px">
      <b>${esc(name)}</b>　T(s) = ${esc(p.tf.text)}</div>`);
    const r = simulateResponse(p.tf.n, p.tf.d, sig.key, T);
    if (!r) return;
    series.push({ name, xs: r.xs, ys: r.ys });
  });

  /* 传递函数写入属性面板（连接完毕即唯一确定） */
  const box = $('#circ-props-body');
  if (box) {
    box.innerHTML = `
      <div class="prop-head" style="color:#0072bd">系统传递函数<span class="prop-id">唯一确定</span></div>
      <div class="prop-tip" style="margin:4px 0">输入：${esc(sig.cn)} ${esc(sig.formula)} · 仿真时间 0 ~ ${T} s</div>
      ${tfLines.join('') || '<div class="prop-empty">无</div>'}
      <div class="prop-tip" style="margin-top:8px">响应曲线见示波器图窗：滚轮缩放 · 拖动平移 · 双击复位 · 单位阶跃输入下可读超调量与调节时间</div>
    `;
  }

  if (!series.length) {
    statusSG('没有可仿真的示波器输出', true);
    return;
  }
  showFigure({
    title: '示波器',
    subtitle: `${sig.cn} ${sig.formula} · 0 ~ ${T}s`,
    series,
  });
  statusSG(`仿真完成：${series.length} 路输出曲线`);
}

/* ---------------- 外部接口 ---------------- */

export function setSignalModel(signalGraph) {
  SG.model = signalGraph;
  // 确保有基本属性
  if (!SG.model.blocks) SG.model.blocks = [];
  if (!SG.model.wires) SG.model.wires = [];
  renderSignalGraph();
}
