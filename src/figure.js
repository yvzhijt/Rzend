// 浮动图窗：示波器曲线与 plot() 结果共用
// 滚轮缩放、拖动平移、双击或「复位」回到初始视图

import { $ } from './common.js';

const COLORS = ['#0072bd', '#d95319', '#77ac30', '#7e2f8e', '#edb120', '#4dbeee'];
const PAD = { l: 60, r: 24, t: 18, b: 40 };
const CW = 560;
const CH = 300;

const F = {
  win: null,
  canvas: null,
  ctx: null,
  legend: null,
  titleEl: null,
  subEl: null,
  readoutEl: null,
  series: [],
  title: '绘图',
  subtitle: '',
  view: null,
  drag: null,
  headDrag: null,
  mode: 'time',     // 'time' | 'bode'
  bode: null,       // { systems, xmin, xmax, magMin, magMax, phMin, phMax }
  mouse: null,      // 画布内鼠标坐标（用于游标读数）
};

export function initFigure() {
  if (F.win) return;
  const win = $('#scope-window');
  if (!win) return;
  F.win = win;
  F.canvas = win.querySelector('#scope-canvas');
  F.ctx = F.canvas?.getContext('2d');
  F.legend = win.querySelector('#scope-legend');
  F.titleEl = win.querySelector('#scope-title');
  F.subEl = win.querySelector('#scope-sub');
  F.readoutEl = win.querySelector('#scope-readout');

  const dpr = window.devicePixelRatio || 1;
  F.canvas.width = CW * dpr;
  F.canvas.height = CH * dpr;
  F.canvas.style.width = `${CW}px`;
  F.canvas.style.height = `${CH}px`;
  F.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  win.querySelector('#scope-close')?.addEventListener('click', closeFigure);
  win.querySelector('#scope-reset')?.addEventListener('click', () => {
    if (F.mode === 'bode') { draw(); return; }
    F.view = bounds();
    draw();
  });
  win.querySelector('#scope-export')?.addEventListener('click', exportFigure);
  win.querySelector('#scope-data')?.addEventListener('click', exportData);
  win.querySelector('#scope-identify')?.addEventListener('click', identifyKT);

  // 游标：鼠标在画布内移动时记录坐标并刷新读数
  F.canvas.addEventListener('pointermove', (e) => {
    const rect = F.canvas.getBoundingClientRect();
    F.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!F.drag) draw();
  });
  F.canvas.addEventListener('pointerleave', () => { F.mouse = null; draw(); });

  const head = win.querySelector('#scope-head');
  head?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    F.headDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  });
  window.addEventListener('pointermove', (e) => {
    if (!F.headDrag) return;
    win.style.left = `${Math.max(0, e.clientX - F.headDrag.dx)}px`;
    win.style.top = `${Math.max(0, e.clientY - F.headDrag.dy)}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  });
  window.addEventListener('pointerup', () => { F.headDrag = null; });

  F.canvas.addEventListener('wheel', onWheel, { passive: false });
  F.canvas.addEventListener('pointerdown', (e) => {
    if (!F.view) return;
    F.drag = { x: e.clientX, y: e.clientY, view: { ...F.view } };
    F.canvas.setPointerCapture(e.pointerId);
    F.canvas.classList.add('dragging');
  });
  F.canvas.addEventListener('pointermove', (e) => {
    if (!F.drag) return;
    const pw = plotW();
    const ph = plotH();
    const dx = ((e.clientX - F.drag.x) / pw) * (F.drag.view.xmax - F.drag.view.xmin);
    const dy = ((e.clientY - F.drag.y) / ph) * (F.drag.view.ymax - F.drag.view.ymin);
    F.view = {
      xmin: F.drag.view.xmin - dx,
      xmax: F.drag.view.xmax - dx,
      ymin: F.drag.view.ymin + dy,
      ymax: F.drag.view.ymax + dy,
    };
    draw();
  });
  F.canvas.addEventListener('pointerup', () => {
    F.drag = null;
    F.canvas.classList.remove('dragging');
  });
  F.canvas.addEventListener('dblclick', () => {
    F.view = bounds();
    draw();
  });
}

export function showFigure({ title, subtitle, series }) {
  initFigure();
  if (!F.win) return;
  F.mode = 'time';
  F.bode = null;
  F.title = title || '绘图';
  F.subtitle = subtitle || '';
  F.series = (series || [])
    .map((s) => ({ name: s.name || '', xs: s.xs || [], ys: s.ys || [] }))
    .filter((s) => s.ys.length);
  F.view = bounds();
  F.win.classList.remove('hidden');
  if (!F.win.style.left) {
    F.win.style.left = `${Math.max(12, window.innerWidth - CW - 40)}px`;
    F.win.style.top = '80px';
  }
  if (F.titleEl) F.titleEl.textContent = F.title;
  if (F.subEl) F.subEl.textContent = F.subtitle;
  if (F.readoutEl) F.readoutEl.textContent = '';
  draw();
}

/* Bode 双联图：上幅频(dB)、下相频(°)，横轴 log₁₀ω */
export function showBode({ title, subtitle, systems }) {
  initFigure();
  if (!F.win || !systems || !systems.length) return;
  F.mode = 'bode';
  F.series = [];
  F.view = null;
  F.title = title || 'Bode 图';
  F.subtitle = subtitle || '';
  // 计算坐标范围
  let magMin = Infinity, magMax = -Infinity, phMin = Infinity, phMax = -Infinity;
  let xmin = Infinity, xmax = -Infinity;
  const n = systems[0].w.length;
  for (const s of systems) {
    for (let i = 0; i < n; i++) {
      xmin = Math.min(xmin, Math.log10(s.w[i]));
      xmax = Math.max(xmax, Math.log10(s.w[i]));
      magMin = Math.min(magMin, s.magDb[i]); magMax = Math.max(magMax, s.magDb[i]);
      phMin = Math.min(phMin, s.phaseDeg[i]); phMax = Math.max(phMax, s.phaseDeg[i]);
    }
  }
  const magSpan = (magMax - magMin) || 1;
  magMin -= magSpan * 0.08; magMax += magSpan * 0.08;
  // 相频按 45° 取整齐刻度，至少覆盖 ±90
  let pLo = Math.floor(phMin / 45) * 45;
  let pHi = Math.ceil(phMax / 45) * 45;
  if (pHi - pLo < 90) { const mid = Math.round((phMin + phMax) / 2 / 45) * 45; pLo = mid - 90; pHi = mid + 90; }
  F.bode = { systems, xmin, xmax, magMin, magMax, phMin: pLo, phMax: pHi };
  F.win.classList.remove('hidden');
  if (!F.win.style.left) {
    F.win.style.left = `${Math.max(12, window.innerWidth - CW - 40)}px`;
    F.win.style.top = '80px';
  }
  if (F.titleEl) F.titleEl.textContent = F.title;
  if (F.subEl) F.subEl.textContent = F.subtitle;
  if (F.readoutEl) F.readoutEl.textContent = '';
  draw();
}

function exportFigure() {
  if (!F.canvas) return;
  const url = F.canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${F.mode === 'bode' ? 'rzend_bode' : 'rzend_scope'}.png`;
  a.click();
}

/* 导出数值数据为 CSV（时域：t 与各专业曲线；Bode：ω、幅频、相频） */
function exportData() {
  let csv = '';
  if (F.mode === 'time' && F.series.length) {
    const n = F.series[0].xs.length;
    const headers = ['t'].concat(F.series.map((s) => s.name || 'y'));
    csv += headers.join(',') + '\n';
    for (let i = 0; i < n; i++) {
      const row = [F.series[0].xs[i]];
      for (const s of F.series) row.push(s.ys[i] ?? '');
      csv += row.join(',') + '\n';
    }
  } else if (F.mode === 'bode' && F.bode) {
    const B = F.bode;
    const n = B.systems[0].w.length;
    csv += 'w,mag_dB,phase_deg\n';
    for (let i = 0; i < n; i++) {
      csv += `${B.systems[0].w[i]},${B.systems[0].magDb[i]},${B.systems[0].phaseDeg[i]}\n`;
    }
  } else {
    return;
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${F.mode === 'bode' ? 'rzend_bode' : 'rzend_scope'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* 自动辨识一阶系统：K≈末值（稳态），T≈0.632K 穿越时间（线性插值） */
function identifyKT() {
  if (F.mode !== 'time' || !F.series.length) return;
  const s0 = F.series[0];
  const n = s0.xs.length;
  if (n < 2) return;
  const K = s0.ys[n - 1];
  let T = null;
  for (let i = 1; i < n; i++) {
    const prev = s0.ys[i - 1];
    const cur = s0.ys[i];
    if (cur === prev) continue;
    if ((prev - 0.632 * K) * (cur - 0.632 * K) <= 0) {
      const frac = (0.632 * K - prev) / (cur - prev);
      T = s0.xs[i - 1] + frac * (s0.xs[i] - s0.xs[i - 1]);
      break;
    }
  }
  const tv = (x) => (x >= 1 ? `${x.toFixed(3)} s` : `${(x * 1e3).toFixed(2)} ms`);
  const kv = (x) => (Math.abs(x) >= 1 ? x.toFixed(3) : `${(x * 1e3).toFixed(2)} m`);
  const msg = `辨识：K ≈ ${kv(K)}　T ≈ ${T != null ? tv(T) : '—'}`;
  if (F.subEl) F.subEl.textContent = msg;
  if (F.readoutEl) F.readoutEl.textContent = msg;
}

export function closeFigure() {
  F.win?.classList.add('hidden');
}

/* ---------------- 绘制 ---------------- */

function plotW() {
  return Math.max(10, CW - PAD.l - PAD.r);
}

function plotH() {
  return Math.max(10, CH - PAD.t - PAD.b);
}

function bounds() {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  F.series.forEach((s) => {
    const n = Math.min(s.xs?.length || 0, s.ys?.length || 0);
    for (let i = 0; i < n; i++) {
      const x = s.xs[i];
      const y = s.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  });
  if (!Number.isFinite(xmin) || !Number.isFinite(ymin)) return null;
  if (xmin === xmax) { xmin -= 1; xmax += 1; }
  const span = ymax - ymin || 1;
  return { xmin, xmax, ymin: ymin - span * 0.08, ymax: ymax + span * 0.08 };
}

function niceStep(span, target) {
  const raw = Math.max(1e-12, span / Math.max(1, target));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mag * mult;
}

function makeTicks(min, max, target) {
  const step = niceStep(max - min, target);
  const first = Math.ceil(min / step - 1e-9) * step;
  const out = [];
  const count = Math.floor((max - first) / step + 1e-9);
  for (let i = 0; i <= count; i++) out.push({ v: first + step * i, step });
  return out;
}

const SI = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

function fmtNum(v, step) {
  if (Math.abs(v) < 1e-15) return '0';
  let scale = 1e-15;
  let suffix = 'f';
  for (const [s, u] of SI) {
    if (Math.abs(v) >= s) { scale = s; suffix = u; break; }
  }
  const digits = Math.max(0, Math.min(4, -Math.floor(Math.log10(step / scale) + 1e-9)));
  const text = (v / scale).toFixed(digits);
  return `${text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}${suffix}`;
}

function draw() {
  const ctx = F.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, CW, CH);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, CW, CH);

  if (F.mode === 'bode') { drawBode(); return; }

  if (F.legend) {
    const named = F.series.map((s, i) => ({ s, i })).filter(({ s }) => s.name);
    F.legend.innerHTML = named.map(({ s, i }) => `<span class="scope-item">
      <span class="scope-dot" style="background:${COLORS[i % COLORS.length]}"></span>${s.name}</span>`).join('');
  }

  if (!F.view) {
    ctx.fillStyle = '#8a9199';
    ctx.font = '13px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('没有可绘制的数据', CW / 2, CH / 2);
    return;
  }

  const pw = plotW();
  const ph = plotH();
  const sx = (x) => PAD.l + ((x - F.view.xmin) / (F.view.xmax - F.view.xmin)) * pw;
  const sy = (y) => PAD.t + ph - ((y - F.view.ymin) / (F.view.ymax - F.view.ymin)) * ph;

  const xt = makeTicks(F.view.xmin, F.view.xmax, Math.max(3, Math.round(pw / 90)));
  const yt = makeTicks(F.view.ymin, F.view.ymax, Math.max(3, Math.round(ph / 52)));

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#eef1f4';
  xt.forEach(({ v }) => {
    const x = Math.round(sx(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, PAD.t + ph);
    ctx.stroke();
  });
  yt.forEach(({ v }) => {
    const y = Math.round(sy(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(PAD.l + pw, y);
    ctx.stroke();
  });

  if (F.view.ymin < 0 && F.view.ymax > 0) {
    ctx.strokeStyle = '#d6dade';
    const y = Math.round(sy(0)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(PAD.l + pw, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#b9c0c7';
  ctx.beginPath();
  ctx.moveTo(PAD.l + 0.5, PAD.t);
  ctx.lineTo(PAD.l + 0.5, PAD.t + ph + 0.5);
  ctx.lineTo(PAD.l + pw, PAD.t + ph + 0.5);
  ctx.stroke();

  ctx.fillStyle = '#5a6268';
  ctx.font = '11px Consolas, "Courier New", monospace';
  ctx.textAlign = 'right';
  yt.forEach(({ v, step }) => {
    ctx.fillText(fmtNum(v, step), PAD.l - 10, sy(v) + 4);
  });
  ctx.textAlign = 'center';
  xt.forEach(({ v, step }) => {
    ctx.fillText(fmtNum(v, step), sx(v), PAD.t + ph + 20);
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.l, PAD.t, pw, ph);
  ctx.clip();
  F.series.forEach((s, si) => {
    const n = Math.min(s.xs?.length || 0, s.ys?.length || 0);
    if (!n) return;
    ctx.strokeStyle = COLORS[si % COLORS.length];
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    const stride = Math.max(1, Math.floor(n / (pw * 2)));
    for (let i = 0; i < n; i += stride) {
      const x = s.xs[i];
      const y = s.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { started = false; continue; }
      const px = sx(x);
      const py = sy(y);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  });
  ctx.restore();

  // 游标读数：鼠标在绘图区内时画十字虚线并提示 (t, 值)
  if (F.mouse) {
    const px = F.mouse.x, py = F.mouse.y;
    const inside = px >= PAD.l && px <= PAD.l + pw && py >= PAD.t && py <= PAD.t + ph;
    if (inside && F.view && F.series.length) {
      const t = F.view.xmin + ((px - PAD.l) / pw) * (F.view.xmax - F.view.xmin);
      const v = F.view.ymin + ((PAD.t + ph - py) / ph) * (F.view.ymax - F.view.ymin);
      // 第一个系列在 t 处的最近采样值
      let readY = null;
      const s0 = F.series[0];
      const m = Math.min(s0.xs.length, s0.ys.length);
      let best = -1, bd = Infinity;
      for (let i = 0; i < m; i++) {
        const d = Math.abs(s0.xs[i] - t);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) readY = s0.ys[best];
      ctx.save();
      ctx.strokeStyle = 'rgba(0,114,189,0.55)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, PAD.t); ctx.lineTo(px + 0.5, PAD.t + ph);
      ctx.moveTo(PAD.l, py + 0.5); ctx.lineTo(PAD.l + pw, py + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#0072bd';
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (F.readoutEl) {
        const tv = t >= 1 ? `${t.toFixed(2)} s` : `${(t * 1e3).toFixed(1)} ms`;
        F.readoutEl.textContent = readY == null
          ? `t = ${tv}`
          : `t = ${tv}  y = ${readY.toFixed(4)}`;
      }
    } else if (F.readoutEl) {
      F.readoutEl.textContent = '';
    }
  }
}

function drawBode() {
  const ctx = F.ctx;
  if (!ctx || !F.bode) return;
  const B = F.bode;

  if (F.legend) {
    F.legend.innerHTML = B.systems.map((s, i) => `<span class="scope-item">
      <span class="scope-dot" style="background:${COLORS[i % COLORS.length]}"></span>${s.name}</span>`).join('');
  }

  const padL = 54, padR = 16, padT = 16, padB = 32, gap = 30;
  const totalH = CH - padT - padB - gap;
  const hMag = totalH * 0.62, hPh = totalH * 0.38;
  const magTop = padT, magBot = padT + hMag;
  const phTop = magBot + gap, phBot = phTop + hPh;
  const pw = CW - padL - padR;
  const xAt = (logw) => padL + ((logw - B.xmin) / (B.xmax - B.xmin)) * pw;
  const yMag = (db) => magBot - ((db - B.magMin) / (B.magMax - B.magMin)) * hMag;
  const yPh = (deg) => phBot - ((deg - B.phMin) / (B.phMax - B.phMin)) * hPh;

  ctx.font = '10px Consolas, "Courier New", monospace';
  ctx.fillStyle = '#5a6268';

  // 竖向十倍频网格
  ctx.strokeStyle = '#eef1f4'; ctx.lineWidth = 1;
  for (let e = Math.ceil(B.xmin); e <= Math.floor(B.xmax); e++) {
    const x = Math.round(xAt(e)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, phBot); ctx.stroke();
  }
  // 幅频水平网格
  makeTicks(B.magMin, B.magMax, 5).forEach(({ v }) => {
    const y = Math.round(yMag(v)) + 0.5;
    ctx.strokeStyle = '#eef1f4';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
  });
  // 相频 0° / ±180° 参考线
  ctx.strokeStyle = '#d6dade';
  [0, 180, -180].forEach((deg) => {
    if (deg < B.phMin || deg > B.phMax) return;
    const y = Math.round(yPh(deg)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
  });

  // 相频 45° 刻度
  ctx.fillStyle = '#5a6268'; ctx.textAlign = 'right';
  for (let deg = Math.ceil(B.phMin / 45) * 45; deg <= B.phMax; deg += 45) {
    ctx.fillText(`${deg}°`, padL - 6, yPh(deg) + 3);
  }
  // 幅频刻度
  makeTicks(B.magMin, B.magMax, 5).forEach(({ v, step }) => {
    ctx.fillText(fmtNum(v, step), padL - 6, yMag(v) + 3);
  });
  // 十倍频横坐标
  ctx.textAlign = 'center';
  for (let e = Math.ceil(B.xmin); e <= Math.floor(B.xmax); e++) {
    ctx.fillText(`10${sup(e)}`, xAt(e), phBot + 16);
  }
  // 面板标题
  ctx.textAlign = 'left';
  ctx.fillStyle = '#0072bd';
  ctx.fillText('幅频 (dB)', padL + 4, magTop + 12);
  ctx.fillText('相频 (°)', padL + 4, phTop + 12);

  // 曲线
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, pw, phBot - padT); ctx.clip();
  B.systems.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineJoin = 'round';
    ctx.beginPath(); let started = false;
    for (let i = 0; i < s.w.length; i++) {
      const x = xAt(Math.log10(s.w[i]));
      const y = yMag(s.magDb[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); started = false;
    for (let i = 0; i < s.w.length; i++) {
      const x = xAt(Math.log10(s.w[i]));
      const y = yPh(s.phaseDeg[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  });
  ctx.restore();

  // 轴框
  ctx.strokeStyle = '#b9c0c7'; ctx.lineWidth = 1;
  [[magTop, magBot], [phTop, phBot]].forEach(([t, b]) => {
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, t); ctx.lineTo(padL + 0.5, b + 0.5);
    ctx.lineTo(padL + pw, b + 0.5); ctx.stroke();
  });

  // 游标读数（取第一条曲线）
  if (F.mouse) {
    const px = F.mouse.x, py = F.mouse.y;
    const inside = px >= padL && px <= padL + pw && py >= padT && py <= phBot;
    if (inside) {
      const logw = B.xmin + ((px - padL) / pw) * (B.xmax - B.xmin);
      const w = 10 ** logw;
      const s0 = B.systems[0];
      let best = 0, bd = Infinity;
      for (let i = 0; i < s0.w.length; i++) {
        const d = Math.abs(Math.log10(s0.w[i]) - logw);
        if (d < bd) { bd = d; best = i; }
      }
      const db = s0.magDb[best], ph = s0.phaseDeg[best];
      ctx.save();
      ctx.strokeStyle = 'rgba(0,114,189,0.5)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 0.5, padT); ctx.lineTo(px + 0.5, phBot); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
      if (F.readoutEl) {
        const wv = w >= 1 ? `${w.toFixed(2)} rad/s` : `${(w * 1e3).toFixed(2)} mrad/s`;
        F.readoutEl.textContent = `ω = ${wv}  |G| = ${db.toFixed(2)} dB  ∠ = ${ph.toFixed(1)}°`;
      }
    } else if (F.readoutEl) {
      F.readoutEl.textContent = '';
    }
  }
}

function sup(n) {
  const map = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  return String(n).split('').map((c) => map[c] || c).join('');
}

function onWheel(e) {
  if (!F.view) return;
  e.preventDefault();
  const rect = F.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const pw = plotW();
  const ph = plotH();
  const fx = Math.min(1, Math.max(0, (mx - PAD.l) / pw));
  const fy = Math.min(1, Math.max(0, (my - PAD.t) / ph));
  const cx = F.view.xmin + fx * (F.view.xmax - F.view.xmin);
  const cy = F.view.ymax - fy * (F.view.ymax - F.view.ymin);
  const k = Math.exp(e.deltaY * 0.0012);
  if (!e.altKey) {
    F.view.xmin = cx + (F.view.xmin - cx) * k;
    F.view.xmax = cx + (F.view.xmax - cx) * k;
  }
  if (!e.shiftKey) {
    F.view.ymin = cy + (F.view.ymin - cy) * k;
    F.view.ymax = cy + (F.view.ymax - cy) * k;
  }
  draw();
}

/* ---------------- 格式化 ---------------- */

export function fmtTime(t) {
  if (Math.abs(t) < 1e-12) return '0';
  if (t >= 1) return `${t.toFixed(2)} s`;
  if (t >= 1e-3) return `${(t * 1e3).toFixed(2)} ms`;
  return `${(t * 1e6).toFixed(1)} µs`;
}
