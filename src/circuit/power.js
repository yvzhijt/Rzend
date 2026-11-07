// 电路仿真画布：实时仿真（通电）—— rAF 驱动步进引擎
import { C, RT, RT_SPEEDS, RT_MAX_STEPS, FLOW_DOT_COUNT, rtSpeed, el, fmtValue, status, callRender } from './ui.js';
import { initSimulation, netVoltage, pinPos, stepSimulation } from './model.js';
import { renderNets } from './render.js';

function voltageColor(v, scale) {
  const t = Math.max(-1, Math.min(1, v / Math.max(0.5, scale)));
  const a = Math.pow(Math.abs(t), 0.7);
  const from = [0x39, 0x48, 0x5a]; // 默认导线色 #39485a
  const to = t >= 0 ? [0xd9, 0x53, 0x19] : [0x1e, 0x6f, 0xd9]; // 正电位橙 / 负电位蓝
  const mix = (i) => Math.round(from[i] + (to[i] - from[i]) * a);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

export function updatePowerBtn() {
  const btn = document.querySelector('#circ-power');
  if (btn) {
    btn.classList.toggle('power-on', RT.on);
    btn.textContent = RT.on ? '⏸ 暂停实时' : '▶ 实时运行';
  }
  const spd = document.querySelector('#circ-speed');
  if (spd) spd.textContent = `×${rtSpeed()}`;
  const duration = document.querySelector('#circ-duration');
  if (duration) duration.disabled = RT.on;
  const dt = document.querySelector('#circ-dt');
  if (dt) dt.disabled = RT.on;
}

export function togglePower() {
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
  status(`电路实时运行中（×${rtSpeed()}）`);
  RT.raf = requestAnimationFrame(rtFrame);
}

export function pausePower(msg) {
  const wasOn = RT.on;
  RT.on = false;
  cancelAnimationFrame(RT.raf);
  RT.sim = null;
  RT.phase.clear();
  const flow = document.querySelector('#circ-flow-layer');
  if (flow) flow.remove();
  updatePowerBtn();
  if (wasOn || msg) renderNets(); // 恢复导线与接点的默认着色
  if (msg) status(msg);
}

export function cycleSpeed() {
  RT.speedIdx = (RT.speedIdx + 1) % RT_SPEEDS.length;
  RT.warned = false;
  updatePowerBtn();
  if (RT.on) status(`实时速度 ×${rtSpeed()}`);
}

export function showElementMenu(target, x, y) {
  const menu = document.querySelector('#circ-context-menu');
  if (!menu) return;
  C.contextTarget = target.id;
  C.sel = { kind: 'el', id: target.id };
  callRender();
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

export function hideElementMenu() {
  const menu = document.querySelector('#circ-context-menu');
  if (menu) menu.classList.add('hidden');
  C.contextTarget = null;
}

export function updateModelSettings() {
  if (!C.model) return;
  C.model.duration = Number(document.querySelector('#circ-duration')?.value) || 0.01;
  C.model.dt = Number(document.querySelector('#circ-dt')?.value) || 1e-5;
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
  const wiresLayer = document.querySelector('#circ-wires-layer');
  if (wiresLayer) wiresLayer.querySelectorAll('.circ-wire, .circ-junction').forEach(paint);
  // 2) 元件电流点：pin0 → pin1 移动
  paintFlowDots(sim, wall);
  // 3) 表读数
  document.querySelectorAll('#circ-elements-layer [data-reading]').forEach((node) => {
    const rd = sim.readings.get(node.dataset.reading);
    if (rd) node.textContent = fmtValue(rd.value, rd.unit);
  });
  const selectedReading = C.sel?.kind === 'el' ? sim.readings.get(C.sel.id) : null;
  const propertyReadout = document.querySelector('#circ-props-body [data-live-reading]');
  if (propertyReadout) {
    propertyReadout.textContent = selectedReading
      ? `读数 ${fmtValue(selectedReading.value, selectedReading.unit)}`
      : '读数 —';
  }
}

function paintFlowDots(sim, wall) {
  const svg = document.querySelector('#circ-canvas');
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