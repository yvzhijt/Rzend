/* 信号流图编辑器 + 梅森增益公式求解
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
 *   探针(PROBE)     一入无出，观测点
 *
 * 梅森公式：T = Σ(P_k · Δ_k) / Δ
 */

import { invoke } from '@tauri-apps/api/core';
import { uid, snapGrid, GRID, GRID_OFFSET, ELEMENTS } from './model.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs, text) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
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

function nodeOutput(node) {
  if (node.type === 'SUM' || node.type === 'SOURCE' || node.type === 'TF' || node.type === 'PICKOFF') {
    const c = nodeCenter(node);
    return { x: node.x + SG_W, y: c.y };
  }
  return null;
}

function nodeInput(node, index) {
  const c = nodeCenter(node);
  if (node.type === 'TF' || node.type === 'PROBE') {
    return { x: node.x, y: c.y };
  }
  if (node.type === 'SUM') {
    const n = node.signs ? node.signs.length : 2;
    const top = node.y + 8;
    const bot = node.y + SG_H - 8;
    if (n === 1) return { x: node.x, y: c.y };
    return { x: node.x, y: top + (bot - top) * index / (n - 1) };
  }
  if (node.type === 'PICKOFF') {
    return { x: node.x, y: c.y };
  }
  return null;
}

/* ---------------- 信号流图状态 ---------------- */

const SG = {
  model: null,        // { blocks: [...], wires: [...] }
  visible: false,
  sel: null,          // { kind: 'block'|'wire', id }
  drag: null,         // { id, dx, dy }
  pending: null,      // { fromBlock, fromPort, bends: [] }
  cursor: null,
  hover: null,
  statusEl: null,
  opts: {},
};

/* ---------------- 初始化 ---------------- */

export function initSignalGraph(opts = {}) {
  SG.opts = opts;
  SG.statusEl = $('#circ-status');
  buildSignalPalette();
  bindSignalCanvas();
  bindSignalKeys();
  bindSignalToolbar();
}

/* ---------------- 调色板 ---------------- */

const SIGNAL_PALETTE = [
  { type: 'SOURCE', cn: '信号源', en: 'Source', group: '输入', color: '#d95319' },
  { type: 'TF', cn: '传递函数', en: 'Transfer Fcn', group: '基本', color: '#0072bd' },
  { type: 'SUM', cn: '求和点', en: 'Summing Junction', group: '基本', color: '#77ac30' },
  { type: 'PICKOFF', cn: '引出点', en: 'Pick-off Point', group: '基本', color: '#7e2f8e' },
  { type: 'PROBE', cn: '探针', en: 'Probe', group: '测量', color: '#edb120' },
];

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

function addSignalBlock(type) {
  if (!SG.model) return;
  const x = snapGrid(120 + (signalBlockCounter % 3) * 180);
  const y = snapGrid(120 + Math.floor(signalBlockCounter / 3) * 140);
  signalBlockCounter++;
  const block = {
    id: uid('s'),
    type,
    x, y,
    params: type === 'TF' ? { num: '1', den: 's + 1' } : {},
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
  const g = el('g', {
    class: 'sg-block',
    'data-block': b.id,
    transform: `translate(${b.x},${b.y})`,
    cursor: 'pointer',
  });
  const color = blockColor(b.type);

  // 方块
  if (b.type === 'TF' || b.type === 'SOURCE') {
    g.appendChild(el('rect', {
      x: 0, y: 0, width: SG_W, height: SG_H, rx: 5,
      fill: sel ? 'rgba(0,114,189,0.08)' : '#fff',
      stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': sel ? 2 : 1.5,
    }));
    let label = b.type === 'SOURCE' ? '信号源' : 'G(s)';
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H / 2 + 4, 'text-anchor': 'middle',
      class: 'sg-label', fill: color, 'font-weight': '600',
    }, label));
    if (b.type === 'TF') {
      const gain = fmtGain(b.params.num, b.params.den);
      if (gain) {
        g.appendChild(el('text', {
          x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
          class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
        }, gain));
      }
    }
    if (b.type === 'SOURCE') {
      g.appendChild(el('text', {
        x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
        class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
      }, '输入信号'));
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
    // ± 符号标在输入侧
    const signs = b.signs || [1, 1];
    const n = signs.length;
    const top = 8, bot = SG_H - 8;
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? SG_H / 2 : top + (bot - top) * i / (n - 1);
      g.appendChild(el('text', {
        x: 4, y: y + 4, 'text-anchor': 'start',
        class: 'sg-sum-sign', fill: signs[i] >= 0 ? '#77ac30' : '#d95319',
        'font-size': '14px', 'font-weight': 'bold',
      }, signs[i] >= 0 ? '+' : '−'));
    }
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H + 10, 'text-anchor': 'middle',
      class: 'sg-params', fill: '#7b8b9c', 'font-size': '9px',
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
    }, '引出点'));
  }

  // 探针
  if (b.type === 'PROBE') {
    g.appendChild(el('circle', {
      cx: SG_W / 2, cy: SG_H / 2, r: PROBE_R,
      fill: sel ? 'rgba(237,177,32,0.15)' : '#fff',
      stroke: sel || hover ? '#0072bd' : color,
      'stroke-width': sel ? 2.5 : 1.5,
    }));
    g.appendChild(el('text', {
      x: SG_W / 2, y: SG_H / 2 + 4, 'text-anchor': 'middle',
      class: 'sg-label', fill: color, 'font-weight': '600',
    }, 'P'));
  }

  return g;
}

function renderWire(w) {
  const fromBlock = SG.model.blocks.find((b) => b.id === w.from.block);
  const toBlock = SG.model.blocks.find((b) => b.id === w.to.block);
  if (!fromBlock || !toBlock) return el('g');

  const sel = SG.sel?.kind === 'wire' && SG.sel.id === w.id;
  const fromPt = nodeOutput(fromBlock);
  const toPt = nodeInput(toBlock, w.to.port ? Number(w.to.port.slice(2)) : 0);
  if (!fromPt || !toPt) return el('g');

  // 用贝塞尔曲线画有向边
  const dx = toPt.x - fromPt.x;
  const ctrlX = Math.max(40, Math.abs(dx) * 0.5);
  const d = `M ${fromPt.x} ${fromPt.y} C ${fromPt.x + ctrlX} ${fromPt.y}, ${toPt.x - ctrlX} ${toPt.y}, ${toPt.x} ${toPt.y}`;

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
    if (!SG.visible || !SG.model) return;
    if (e.button === 2) return;

    // 点击 block
    const blockEl = e.target.closest('[data-block]');
    if (blockEl) {
      const b = SG.model.blocks.find((b) => b.id === blockEl.dataset.block);
      if (!b) return;
      SG.sel = { kind: 'block', id: b.id };
      const pt = toSvgSG(e);
      SG.drag = { id: b.id, dx: pt.x - b.x, dy: pt.y - b.y };
      renderSignalGraph();
      renderSignalProps();
      return;
    }

    // 点击 wire
    const wireEl = e.target.closest('[data-wire]');
    if (wireEl) {
      SG.sel = { kind: 'wire', id: wireEl.dataset.wire };
      SG.drag = null;
      renderSignalGraph();
      renderSignalProps();
      return;
    }

    // 空白处
    SG.sel = null;
    renderSignalGraph();
    renderSignalProps();
  });

  svg.addEventListener('contextmenu', (e) => {
    if (!SG.visible || !SG.model) return;
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
    if (!SG.visible || !SG.model) return;
    if (SG.drag) {
      const b = SG.model.blocks.find((b) => b.id === SG.drag.id);
      if (!b) return;
      const pt = toSvgSG(e);
      b.x = snapGrid(pt.x - SG.drag.dx);
      b.y = snapGrid(pt.y - SG.drag.dy);
      renderSignalGraph();
      return;
    }
    // hover 高亮
    const el = e.target.closest('[data-block]');
    const id = el ? el.dataset.block : null;
    if (id !== SG.hover) {
      SG.hover = id;
      renderSignalGraph();
    }
  });

  window.addEventListener('pointerup', () => {
    if (SG.drag) {
      SG.drag = null;
      renderSignalProps();
    }
  });
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
  if (block.type === 'SUM') {
    html += '<button type="button" role="menuitem" data-action="add-input">添加输入端</button>';
    html += '<button type="button" role="menuitem" data-action="remove-input">移除输入端</button>';
  }
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
      } else if (btn.dataset.action === 'add-input') {
        sel.signs.push(1);
        renderSignalGraph();
        renderSignalProps();
        statusSG('已添加输入端（+）');
      } else if (btn.dataset.action === 'remove-input') {
        if (sel.signs.length <= 1) {
          statusSG('求和点至少需要 1 个输入端', true);
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

  if (b.type === 'SUM') {
    rows.push('<div class="prop-row"><label>输入端符号（点击切换 ±）</label></div>');
    const signsHtml = (b.signs || [1, 1]).map((s, i) =>
      `<button class="sum-sign-btn" data-idx="${i}" style="color:${s >= 0 ? '#77ac30' : '#d95319'};font-weight:bold;font-size:16px;padding:4px 10px;margin:2px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;cursor:pointer">
        ${s >= 0 ? '+' : '−'} in${i}
      </button>`
    ).join('');
    rows.push(`<div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:8px">${signsHtml}</div>`);
    rows.push('<div class="prop-tip">右键点击求和点可增减输入端</div>');
  }

  if (b.type === 'PICKOFF') {
    rows.push('<div class="prop-tip">引出点将信号无衰减地分叉到多个输出</div>');
  }

  if (b.type === 'PROBE') {
    rows.push('<div class="prop-tip">探针标记输出观测点；梅森公式计算到此处</div>');
  }

  rows.push('<div class="prop-tip">右键节点打开菜单 · Delete 键删除 · 将连线从输出连到输入</div>');
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

  // 绑定 TF 参数编辑
  box.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.addEventListener('change', () => {
      b.params[inp.dataset.key] = inp.value.trim() || '1';
      renderSignalGraph();
    });
  });
}

/* ---------------- 连线 ---------------- */

function startSignalWire(blockId) {
  SG.pending = { fromBlock: blockId, fromPort: 'out', bends: [] };
  statusSG('连线中：点击目标节点的输入端完成（Esc 取消）');
}

function finishSignalWire(toBlockId, toPort) {
  if (!SG.pending) return;
  // 不能自己连自己
  if (SG.pending.fromBlock === toBlockId) {
    cancelSignalPending();
    statusSG('不能将节点连接到自己');
    return;
  }
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
    statusSG('该输入端已被占用，请选择其他端口');
    return;
  }
  SG.model.wires.push({
    id: uid('sw'),
    from: { block: SG.pending.fromBlock, port: SG.pending.fromPort },
    to: { block: toBlockId, port: toPort },
  });
  cancelSignalPending();
  renderSignalGraph();
  statusSG('已连线');
}

function cancelSignalPending() {
  SG.pending = null;
  SG.cursor = null;
}

/* ---------------- 工具栏 ---------------- */

function bindSignalToolbar() {
  // 标签页切换
  $('#circ-view-circuit')?.addEventListener('click', () => switchToCircuit());
  $('#circ-view-signal')?.addEventListener('click', () => switchToSignal());

  // 信号流图专用：梅森分析（捕获阶段拦截，阻止电路仿真触发）
  $('#circ-run')?.addEventListener('click', (e) => {
    if (SG.visible) {
      e.stopImmediatePropagation();
      e.preventDefault();
      runMasonAnalysis();
    }
  }, true);

  // 信号流图模式下拦截电路实时运行/调速按钮
  $('#circ-power')?.addEventListener('click', (e) => {
    if (SG.visible) { e.stopImmediatePropagation(); e.preventDefault(); statusSG('信号流图模式不支持实时运行，请点击瞬态分析'); }
  }, true);
  $('#circ-speed')?.addEventListener('click', (e) => {
    if (SG.visible) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  // 连线模式：双击 block 的输出侧开始连线
  const svg = $('#circ-canvas');
  svg?.addEventListener('dblclick', (e) => {
    if (!SG.visible || !SG.model) return;
    const blockEl = e.target.closest('[data-block]');
    if (!blockEl) return;
    const b = SG.model.blocks.find((b) => b.id === blockEl.dataset.block);
    if (!b) return;
    startSignalWire(b.id);
  });

  // 单击完成连线
  svg?.addEventListener('click', (e) => {
    if (!SG.visible || !SG.model || !SG.pending) return;
    const blockEl = e.target.closest('[data-block]');
    if (!blockEl) {
      cancelSignalPending();
      statusSG('已取消连线');
      return;
    }
    const b = SG.model.blocks.find((b) => b.id === blockEl.dataset.block);
    if (!b) {
      cancelSignalPending();
      return;
    }
    // 判断点击位置在 block 的哪个输入端
    const pt = toSvgSG(e);
    const relX = pt.x - b.x;
    const relY = pt.y - b.y;
    if (relX < 0 || relX > SG_W || relY < 0 || relY > SG_H) {
      cancelSignalPending();
      return;
    }
    let portIdx = 0;
    if (b.type === 'SUM') {
      const n = b.signs ? b.signs.length : 2;
      const top = 8, bot = SG_H - 8;
      portIdx = Math.round((n - 1) * (relY - top) / (bot - top));
      portIdx = Math.max(0, Math.min(n - 1, portIdx));
    }
    finishSignalWire(b.id, `in${portIdx}`);
  });
}

/* ---------------- 视图切换 ---------------- */

function showSignalLayers(show) {
  ['signal-elements-layer', 'signal-wires-layer', 'signal-temp-layer'].forEach((id) => {
    const layer = $(`#${id}`);
    if (layer) layer.classList.toggle('hidden', !show);
  });
  ['circ-wires-layer', 'circ-temp-layer', 'circ-elements-layer'].forEach((id) => {
    const layer = $(`#${id}`);
    if (layer) layer.classList.toggle('hidden', show);
  });
  // 切换网格
  const gridRect = document.querySelector('#circ-canvas > rect:first-of-type');
  if (gridRect) {
    gridRect.setAttribute('fill', show ? '#fafbfc' : 'url(#circ-grid-pattern)');
  }
}

export function switchToSignal() {
  SG.visible = true;
  showSignalLayers(true);
  $('#circ-view-circuit')?.classList.remove('active');
  $('#circ-view-signal')?.classList.add('active');
  $('#circ-palette-list').innerHTML = '';
  buildSignalPalette();
  renderSignalGraph();
  renderSignalProps();
  statusSG('信号流图模式 — 双击节点开始连线');
}

export function switchToCircuit() {
  SG.visible = false;
  showSignalLayers(false);
  cancelSignalPending();
  SG.drag = null;
  $('#circ-view-circuit')?.classList.add('active');
  $('#circ-view-signal')?.classList.remove('active');
}

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
    if (!SG.visible) return;
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

/* ================================================================
 * 梅森增益公式 — Mason's Gain Formula
 * ================================================================
 *
 * T = Σ(P_k · Δ_k) / Δ
 *
 * 其中：
 *   P_k  = 第 k 条前向路径的增益（路径上各支路增益之积）
 *   Δ    = 1 - ΣL_i + Σ(L_i·L_j for 不相触的环对) - Σ(L_i·L_j·L_k) + ...
 *   Δ_k  = 从 Δ 中删去与第 k 条前向路径相触的环后剩余的 Δ
 *
 * 算法：
 *   1. 构建邻接表
 *   2. DFS 找出所有前向路径（SOURCE → PROBE）
 *   3. DFS 找出所有回路
 *   4. 计算 Δ 和 Δ_k
 */

function masonAnalyze(model) {
  const { blocks, wires } = model;
  if (!blocks.length) return { error: '信号流图为空' };

  const sources = blocks.filter((b) => b.type === 'SOURCE');
  const probes = blocks.filter((b) => b.type === 'PROBE');
  if (!sources.length) return { error: '缺少信号源（SOURCE）' };
  if (!probes.length) return { error: '缺少探针（PROBE）' };
  if (probes.length > 1) return { error: '梅森公式每次只能处理一个输出探针，请保留一个' };

  const sourceId = sources[0].id;
  const probeId = probes[0].id;

  // 邻接：adj[fromBlockId] = [{ toBlockId, wireId }]
  const adj = new Map();
  blocks.forEach((b) => adj.set(b.id, []));
  wires.forEach((w) => {
    const list = adj.get(w.from.block);
    if (list) list.push({ to: w.to.block, wireId: w.id });
  });

  // 每个 TF block 的增益标签
  function blockGain(id) {
    const b = blocks.find((b) => b.id === id);
    if (!b) return '1';
    if (b.type === 'TF') {
      const n = String(b.params.num || '1').trim();
      const d = String(b.params.den || '1').trim();
      if (n === '1' && d === '1') return '1';
      if (d === '1') return n;
      return `(${n})/(${d})`;
    }
    if (b.type === 'PICKOFF' || b.type === 'SUM') return '1';
    if (b.type === 'SOURCE') return '1';
    return '1';
  }

  // 找所有前向路径 DFS
  const paths = [];
  function findPaths(current, visited, pathBlocks) {
    if (current === probeId) {
      paths.push([...pathBlocks]);
      return;
    }
    const neighbors = adj.get(current) || [];
    for (const { to } of neighbors) {
      if (visited.has(to)) continue;
      visited.add(to);
      pathBlocks.push(to);
      findPaths(to, visited, pathBlocks);
      pathBlocks.pop();
      visited.delete(to);
    }
  }
  const initVisited = new Set([sourceId]);
  findPaths(sourceId, initVisited, [sourceId]);

  if (!paths.length) {
    return { error: `没有从信号源到探针的路径` };
  }

  // 找所有回路 DFS
  const loops = [];
  function findLoops(start, current, visited, loopBlocks) {
    const neighbors = adj.get(current) || [];
    for (const { to } of neighbors) {
      if (to === start) {
        loops.push([...loopBlocks]);
        continue;
      }
      if (visited.has(to)) continue;
      visited.add(to);
      loopBlocks.push(to);
      findLoops(start, to, visited, loopBlocks);
      loopBlocks.pop();
      visited.delete(to);
    }
  }
  blocks.forEach((b) => {
    const visited = new Set([b.id]);
    findLoops(b.id, b.id, visited, [b.id]);
  });

  // 去重：回路不考虑起点，按节点集合去重
  const uniqueLoops = [];
  const seenSignatures = new Set();
  for (const loop of loops) {
    const sig = [...new Set(loop)].sort().join(',');
    if (!seenSignatures.has(sig)) {
      seenSignatures.add(sig);
      uniqueLoops.push(loop);
    }
  }

  // 两个环是否相触（共享至少一个节点）
  function touching(a, b) {
    const setA = new Set(a);
    return b.some((n) => setA.has(n));
  }

  // 路径是否与环相触
  function pathTouchesLoop(pathBlocks, loopBlocks) {
    const set = new Set(pathBlocks);
    return loopBlocks.some((n) => set.has(n));
  }

  // 增益标签
  function pathGainLabel(pathBlocks) {
    return pathBlocks.slice(1).map((id) => blockGain(id)).join(' · ');
  }
  function loopGainLabel(loopBlocks) {
    // 回路：每个块出现一次（除起点出现两次）
    return loopBlocks.map((id) => blockGain(id)).join(' · ');
  }

  // 计算 Δ = 1 - (Σ 单环增益) + (Σ 不相触环对增益之积) - ...
  function computeDelta(loopsSubset) {
    if (!loopsSubset.length) return { value: '1', label: '1' };
    let terms = ['1'];
    // 用容斥原理
    const n = loopsSubset.length;
    for (let k = 1; k <= n; k++) {
      // 生成所有 k-组合
      const combos = combinations(n, k);
      for (const combo of combos) {
        // 检查是否互相不触
        let nonTouching = true;
        for (let i = 0; i < combo.length && nonTouching; i++) {
          for (let j = i + 1; j < combo.length && nonTouching; j++) {
            if (touching(loopsSubset[combo[i]], loopsSubset[combo[j]])) {
              nonTouching = false;
            }
          }
        }
        if (nonTouching) {
          const product = combo.map((idx) => loopGainLabel(loopsSubset[idx])).join(' · ');
          terms.push(k % 2 === 1 ? `-(${product})` : `+(${product})`);
        }
      }
    }
    return { value: terms.join(' '), label: terms.join(' ') };
  }

  // 计算 Δ_k：删去与路径相触的环
  function computeCofactor(pathBlocks) {
    const remaining = uniqueLoops.filter((loop) => !pathTouchesLoop(pathBlocks, loop));
    return computeDelta(remaining);
  }

  const delta = computeDelta(uniqueLoops);
  const cofactors = paths.map((p) => computeCofactor(p));

  return {
    sourceId,
    probeId,
    paths: paths.map((p, i) => ({
      blocks: p,
      gain: pathGainLabel(p),
      cofactor: cofactors[i].label,
    })),
    loops: uniqueLoops.map((l) => ({
      blocks: l,
      gain: loopGainLabel(l),
    })),
    delta: delta.label,
    numerator: paths.map((p, i) => `(${pathGainLabel(p)}) · (${cofactors[i].label})`).join(' + '),
    denominator: delta.label,
  };
}

function combinations(n, k) {
  const result = [];
  const combo = [];
  function pick(start) {
    if (combo.length === k) { result.push([...combo]); return; }
    for (let i = start; i < n; i++) {
      combo.push(i);
      pick(i + 1);
      combo.pop();
    }
  }
  pick(0);
  return result;
}

function runMasonAnalysis() {
  if (!SG.model || !SG.model.blocks.length) {
    statusSG('信号流图为空，请先添加节点', true);
    return;
  }
  const result = masonAnalyze(SG.model);
  if (result.error) {
    statusSG(result.error, true);
    return;
  }

  // 在属性面板展示结果
  const box = $('#circ-props-body');
  if (!box) return;

  const pathLines = result.paths.map((p, i) =>
    `<div style="margin:3px 0;font-family:var(--mono);font-size:12px">
      <b>P${i + 1}</b> = ${p.gain}</div>`
  ).join('');
  const loopLines = result.loops.map((l, i) =>
    `<div style="margin:3px 0;font-family:var(--mono);font-size:12px">
      <b>L${i + 1}</b> = ${l.gain}</div>`
  ).join('');

  box.innerHTML = `
    <div class="prop-head" style="color:#0072bd">梅森增益公式<span class="prop-id">分析结果</span></div>
    <div class="prop-tip" style="margin-top:2px;margin-bottom:8px"><b>前向路径</b></div>
    ${pathLines || '<div class="prop-empty">无</div>'}
    <div class="prop-tip" style="margin-top:8px;margin-bottom:8px"><b>回路</b></div>
    ${loopLines || '<div class="prop-empty">无</div>'}
    <div class="prop-tip" style="margin-top:8px;margin-bottom:8px"><b>Δ</b> = ${result.delta}</div>
    <div class="prop-readout" style="margin-top:8px">
      <b>T(s)</b> = (${result.numerator}) / (${result.denominator})
    </div>
    <div class="prop-tip" style="margin-top:8px">双击节点开始连线，左键点击目标输入端完成连线</div>
  `;
  statusSG(`梅森分析完成：${result.paths.length} 条前向路径，${result.loops.length} 个回路`);
}

/* ---------------- 外部接口 ---------------- */

export function setSignalModel(signalGraph) {
  SG.model = signalGraph;
  // 确保有基本属性
  if (!SG.model.blocks) SG.model.blocks = [];
  if (!SG.model.wires) SG.model.wires = [];
  if (SG.visible) renderSignalGraph();
}

export function signalBlocks() {
  return SG.model;
}

export function isSignalVisible() {
  return SG.visible;
}