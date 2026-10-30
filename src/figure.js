// 浮动图窗：示波器曲线与 plot() 结果共用
// 滚轮缩放、拖动平移、双击或「复位」回到初始视图

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
  series: [],
  title: '绘图',
  subtitle: '',
  view: null,
  drag: null,
  headDrag: null,
};

const $ = (s) => document.querySelector(s);

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

  const dpr = window.devicePixelRatio || 1;
  F.canvas.width = CW * dpr;
  F.canvas.height = CH * dpr;
  F.canvas.style.width = `${CW}px`;
  F.canvas.style.height = `${CH}px`;
  F.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  win.querySelector('#scope-close')?.addEventListener('click', closeFigure);
  win.querySelector('#scope-reset')?.addEventListener('click', () => {
    F.view = bounds();
    draw();
  });

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
  draw();
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
