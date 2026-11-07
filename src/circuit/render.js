// 电路仿真画布：SVG 渲染
import { C, $, el, fmtValue, escapeHtml, callPausePower } from './ui.js';
import { ELEMENTS, H, W, pinLocal, normalizeRot } from './model.js';
import { componentById, rebuildPinIndex, segPathD } from './geom.js';

/* ---------------- 渲染 ---------------- */

export function render() {
  if (!C.model) return;
  renderElements();
  renderNets();
  renderProps();
  const empty = !C.model.components.length;
  $('#circ-empty')?.classList.toggle('hidden', !empty);
}

export function renderElements() {
  const layer = $('#circ-elements-layer');
  layer.innerHTML = '';
  C.model.components.forEach((c) => layer.appendChild(elementNode(c)));
  rebuildPinIndex();
}

export function elementNode(c) {
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
  const hasLiveReading = c.type === 'A' || c.type === 'VM' || c.type === 'P'
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
export function paintPorts() {
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
export function gateSymbolParts(type, color, line, txt) {
  const y = H / 2;
  const parts = [];
  const stroke = { fill: '#fff', stroke: color, 'stroke-width': 2 };
  const bubble = (cx) => parts.push(el('circle', { cx, cy: y, r: 6, fill: '#fff', stroke: color, 'stroke-width': 2 }));

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

function inverted(type) {
  return type === 'NAND' || type === 'NOR' || type === 'XNOR' || type === 'NOT';
}

export function symbolParts(c) {
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

export function renderNets() {
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

export function renderProps() {
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
  } else if (def.group === '信号源') {
    rows.push('<div class="prop-empty">输出单位电压函数；单位脉冲按当前时间步归一化面积</div>');
  } else if (!(def.params || []).length) {
    rows.push('<div class="prop-empty">该元件无可调参数</div>');
  }
  const rd = C.readings.get(c.id);
  if (rd || ['A', 'VM', 'P'].includes(c.type)
    || ELEMENTS[c.type].group === '数字逻辑') {
    rows.push(`<div class="prop-readout" data-live-reading="${c.id}">读数 ${rd ? fmtValue(rd.value, rd.unit) : '—'}</div>`);
  }
  rows.push('<div class="prop-tip">元件、拐点与引脚均自动吸附 12px 网格；左键点端子开始连线，点空白处落拐点，点目标端子完成；右键元件旋转 90°；拖动移动；Delete 删除</div>');
  box.innerHTML = rows.join('');

  box.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.addEventListener('change', () => {
      callPausePower();
      const param = def.params.find((item) => item.key === inp.dataset.key);
      c.params[inp.dataset.key] = param?.type === 'text' ? inp.value.trim() : Number(inp.value);
      render();
    });
  });
}