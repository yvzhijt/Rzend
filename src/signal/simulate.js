/* SISO 传递函数时域仿真：可控标准型状态空间 + RK4 定步长积分
 *
 *   D(s) = s^n + a(n-1)s^(n-1) + ... + a0
 *   N(s) = b(n)s^n + ... + b0
 *
 * 状态空间（可控标准型）：
 *   x1' = x2, ..., x(n-1)' = xn, xn' = -a0·x1 - ... - a(n-1)·xn + u
 *   y = Σ(bi - bn·ai)·xi + bn·u
 *
 * 脉冲响应：u=0、x(0)=B 的自由响应（严格真分时精确）。
 */

function trim(p) {
  let i = p.length - 1;
  while (i > 0 && Math.abs(p[i]) < 1e-12) i--;
  return p.slice(0, i + 1);
}

function uAt(kind, t) {
  if (kind === 'step') return 1;
  if (kind === 'ramp') return t;
  if (kind === 'para') return (t * t) / 2;
  return 0;
}

/* 返回 { xs, ys } 或 null（无法仿真） */
export function simulateResponse(num, den, kind, T, samples = 1200) {
  const b = trim(Array.isArray(num) ? num : [1]);
  const d = trim(Array.isArray(den) ? den : [1]);
  const n = d.length - 1;
  if (!(T > 0) || samples < 2) return null;

  /* 纯增益（分母为常数） */
  if (n === 0) {
    if (kind === 'impulse') return null;
    const xs = [];
    const ys = [];
    for (let i = 0; i <= samples; i++) {
      const t = (T * i) / samples;
      xs.push(t);
      ys.push((b[0] / d[0]) * uAt(kind, t));
    }
    return { xs, ys };
  }

  if (b.length - 1 > n) return null; // 分子阶次高于分母，非正则系统

  const a = d.map((c) => c / d[n]);
  const bb = Array.from({ length: n + 1 }, (_, i) => (b[i] || 0) / d[n]);
  const d0 = bb[n];
  const C = [];
  for (let i = 0; i < n; i++) C.push(bb[i] - d0 * a[i]);

  const deriv = (x, u) => {
    const dx = new Array(n);
    for (let i = 0; i < n - 1; i++) dx[i] = x[i + 1];
    let s = u;
    for (let i = 0; i < n; i++) s -= a[i] * x[i];
    dx[n - 1] = s;
    return dx;
  };
  const output = (x, u) => {
    let y = d0 * u;
    for (let i = 0; i < n; i++) y += C[i] * x[i];
    return y;
  };

  const impulse = kind === 'impulse';
  let x = new Array(n).fill(0);
  if (impulse) x[n - 1] = 1; // x(0) = B

  const h = T / samples;
  const xs = [0];
  const ys = [output(x, impulse ? 0 : uAt(kind, 0))];
  let t = 0;

  for (let i = 0; i < samples; i++) {
    const u0 = impulse ? 0 : uAt(kind, t);
    const u1 = impulse ? 0 : uAt(kind, t + h / 2);
    const u2 = impulse ? 0 : uAt(kind, t + h);
    const k1 = deriv(x, u0);
    const x2 = x.map((v, j) => v + (h / 2) * k1[j]);
    const k2 = deriv(x2, u1);
    const x3 = x.map((v, j) => v + (h / 2) * k2[j]);
    const k3 = deriv(x3, u1);
    const x4 = x.map((v, j) => v + h * k3[j]);
    const k4 = deriv(x4, u2);
    x = x.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
    xs.push(t);
    ys.push(output(x, impulse ? 0 : uAt(kind, t)));
  }
  return { xs, ys };
}

/* ---------------- 通用多项式（支持 s/z 变量与负幂 z^-1） ---------------- */

function tokenizeZ(s) {
  const tokens = [];
  let i = 0;
  const isNumCh = (c) => /[0-9.]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (isNumCh(c)) {
      let j = i;
      while (j < s.length && isNumCh(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    if ('sz+-*^()'.includes(c)) {
      const prev = tokens[tokens.length - 1];
      const implicit = prev && (isNumCh(prev) || prev === 's' || prev === 'z' || prev === ')')
        && (c === 's' || c === 'z' || c === '(' || isNumCh(c));
      if (implicit) tokens.push('*');
      tokens.push(c);
      i++;
      continue;
    }
    throw new Error(`无法识别的字符 "${c}"`);
  }
  return tokens;
}

function monoZ(coef, power) { const m = new Map(); if (coef) m.set(power, coef); return m; }
function mapAddZ(a, b) { const m = new Map(a); b.forEach((v, k) => m.set(k, (m.get(k) || 0) + v)); return m; }
function mapSubZ(a, b) { const m = new Map(a); b.forEach((v, k) => m.set(k, (m.get(k) || 0) - v)); return m; }
function mapNegZ(a) { const m = new Map(); a.forEach((v, k) => m.set(k, -v)); return m; }
function mapMulZ(a, b) {
  const m = new Map();
  a.forEach((va, ka) => b.forEach((vb, kb) => m.set(ka + kb, (m.get(ka + kb) || 0) + va * vb)));
  return m;
}
function mapInvZ(a) { const m = new Map(); a.forEach((v, k) => m.set(-k, v)); return m; }
function mapPowZ(a, k) {
  if (k < 0) return mapPowZ(mapInvZ(a), -k);
  let m = monoZ(1, 0);
  for (let i = 0; i < k; i++) m = mapMulZ(m, a);
  return m;
}

/* 解析分子/分母：支持 s 或 z、隐式乘法与负幂（z^-1）。
   分子分母用全局最小幂统一平移到 0（保留相对次数、清除 z^-1）。解析失败返回 null。 */
export function parseZPair(numExpr, denExpr) {
  const parseMap = (expr) => {
    const tokens = tokenizeZ(String(expr ?? '0').trim() || '0');
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    function parseExpr() {
      let m = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = next();
        const r = parseTerm();
        m = op === '+' ? mapAddZ(m, r) : mapSubZ(m, r);
      }
      return m;
    }
    function parseTerm() {
      let m = parseFactor();
      while (peek() === '*') { next(); const r = parseFactor(); m = mapMulZ(m, r); }
      return m;
    }
    function parseFactor() {
      if (peek() === '+') { next(); return parseFactor(); }
      if (peek() === '-') { next(); return mapNegZ(parseFactor()); }
      const t = next();
      let m;
      if (t === '(') { m = parseExpr(); if (next() !== ')') throw new Error('缺少右括号'); }
      else if (t === 's' || t === 'z') { m = monoZ(1, 1); }
      else if (/^[0-9.]+$/.test(t)) {
        const v = Number(t);
        if (!Number.isFinite(v)) throw new Error(`非法数字 ${t}`);
        m = monoZ(v, 0);
      } else throw new Error(`意外符号 ${t ?? '结束'}`);
      if (peek() === '^') {
        next();
        let sign = 1;
        if (peek() === '-') { next(); sign = -1; }
        const e = next();
        if (!/^[0-9]+$/.test(String(e))) throw new Error('非法指数');
        const exp = sign * Number(e);
        if (Math.abs(exp) > 12) throw new Error('指数过大');
        m = mapPowZ(m, exp);
      }
      return m;
    }
    return parseExpr();
  };
  try {
    const numMap = parseMap(numExpr);
    const denMap = parseMap(denExpr);
    let globalMin = Infinity;
    const scan = (m) => m.forEach((v, k) => { if (Math.abs(v) >= 1e-15) globalMin = Math.min(globalMin, k); });
    scan(numMap); scan(denMap);
    if (globalMin === Infinity) return { num: [0], den: [0] };
    const build = (m) => {
      let maxP = -Infinity;
      m.forEach((v, k) => { if (Math.abs(v) >= 1e-15) maxP = Math.max(maxP, k); });
      const len = maxP - globalMin + 1;
      const arr = new Array(Math.max(1, len)).fill(0);
      m.forEach((v, k) => { if (Math.abs(v) >= 1e-15) arr[k - globalMin] = v; });
      return arr;
    };
    const num = build(numMap);
    const den = build(denMap);
    return { num, den };
  } catch (e) {
    return null;
  }
}

function trimArrZ(p) {
  let i = p.length - 1;
  while (i > 0 && Math.abs(p[i]) < 1e-12) i--;
  return p.slice(0, i + 1);
}

/* 连续 TF → 可控标准型状态空间；step(u,h) 用 RK4 推进一步（u 在该细步内视为常值） */
export function makeContinuousSS(num, den) {
  const b = trimArrZ(num);
  const d = trimArrZ(den);
  const n = d.length - 1;
  if (n < 1) {
    const g = d[0] ? b[0] / d[0] : 0;
    return { step: (u) => g * u, reset() {} };
  }
  if (b.length - 1 > n) return null;
  const a = d.map((c) => c / d[n]);
  const bb = Array.from({ length: n + 1 }, (_, i) => (b[i] || 0) / d[n]);
  const d0 = bb[n];
  const C = [];
  for (let i = 0; i < n; i++) C.push(bb[i] - d0 * a[i]);
  let x = new Array(n).fill(0);
  const deriv = (xx, uu) => {
    const dx = new Array(n);
    for (let i = 0; i < n - 1; i++) dx[i] = xx[i + 1];
    let s = uu;
    for (let i = 0; i < n; i++) s -= a[i] * xx[i];
    dx[n - 1] = s;
    return dx;
  };
  const out = (xx, uu) => { let y = d0 * uu; for (let i = 0; i < n; i++) y += C[i] * xx[i]; return y; };
  return {
    step(u, h) {
      const k1 = deriv(x, u);
      const x2 = x.map((v, j) => v + (h / 2) * k1[j]);
      const k2 = deriv(x2, u);
      const x3 = x.map((v, j) => v + (h / 2) * k2[j]);
      const k3 = deriv(x3, u);
      const x4 = x.map((v, j) => v + h * k3[j]);
      const k4 = deriv(x4, u);
      x = x.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
      return out(x, u);
    },
    reset() { x = new Array(n).fill(0); },
  };
}

/* 离散 TF → 差分方程。支持 z^-1 带来的延迟与直接馈通。
   约定：uReg[i] = u[k-(i+1)]，yReg[i] = y[k-(i+1)]（i 从 0 起）。
   y[k] = B0·u[k] + Σ_{j≥1} B[j]·u[k-j] - Σ_{j≥1} A[j]·y[k-j]。
   output(u) 用“当前输入 u”算输出但不推进状态；advance(u,y) 才推进一拍，
   以便混合仿真在采样瞬间对反馈环做定点迭代。 */
export function makeDiscreteSS(num, den) {
  let dn = trimArrZ(den);
  while (dn.length > 1 && Math.abs(dn[dn.length - 1]) < 1e-12) dn.pop();
  const n = dn.length - 1;
  if (n < 0) return null;
  let bn = trimArrZ(num);
  while (bn.length > 1 && Math.abs(bn[bn.length - 1]) < 1e-12) bn.pop();
  if (bn.length - 1 > n) return null; // 分子阶次高于分母：非因果/不可实现
  const denLead = dn[n];
  // 以 z^-1 为变量：A[j]、B[j] 分别为分母/分子 z^-j 项系数（A[0]=1）
  const A = [];
  const B = [];
  for (let j = 0; j <= n; j++) {
    const idx = n - j; // 相对索引，idx=0 对应 z^0（最高次）
    A[j] = (idx >= 0 && idx < dn.length ? dn[idx] : 0) / denLead;
    B[j] = (idx >= 0 && idx < bn.length ? bn[idx] : 0) / denLead;
  }
  const uReg = new Array(n).fill(0); // u[k-1], u[k-2], ..., u[k-n]
  const yReg = new Array(n).fill(0); // y[k-1], y[k-2], ..., y[k-n]
  const output = (u) => {
    let y = B[0] * u; // 直接馈通：用当前输入
    for (let j = 1; j <= n; j++) y += B[j] * uReg[j - 1] - A[j] * yReg[j - 1];
    return y;
  };
  const advance = (u, yv) => {
    for (let i = n - 1; i >= 1; i--) uReg[i] = uReg[i - 1];
    uReg[0] = u;
    for (let i = n - 1; i >= 1; i--) yReg[i] = yReg[i - 1];
    yReg[0] = yv;
  };
  return {
    output,
    advance,
    step(u) { const y = output(u); advance(u, y); return y; },
    reset() { uReg.fill(0); yReg.fill(0); },
  };
}

function blockDomainZ(b) {
  if (b.type !== 'TF') return null;
  return /[zZ]/.test(`${b.params?.num || ''}${b.params?.den || ''}`) ? 'z' : 's';
}

function sourceValueZ(b, t) {
  const key = ['impulse', 'step', 'ramp', 'para'].includes(b.params?.sig) ? b.params.sig : 'step';
  if (key === 'impulse') return t === 0 ? 1 : 0;
  if (key === 'step') return 1;
  if (key === 'ramp') return t;
  if (key === 'para') return (t * t) / 2;
  return 0;
}

/* 采样数据（连续 + 离散混合）仿真。
   连续块按 RK4 积分，离散块按差分方程递推；采样器 / 零阶保持器在采样周期 Ts 处锁存、保持。
   返回 { series } 或 { error }。 */
export function simulateHybrid(model, opts) {
  const { T = 10, Ts = 1 } = opts || {};
  const blocks = model.blocks || [];
  const wires = model.wires || [];
  if (!blocks.length) return { error: '信号流图为空' };
  if (!(Ts > 0)) return { error: '采样周期 Ts 必须大于 0' };
  if (!(T > 0)) return { error: '仿真时间必须大于 0' };

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const incoming = new Map();
  wires.forEach((w) => {
    const tgt = byId.get(w.to.block);
    if (!tgt) return;
    let gain = 1;
    if (tgt.type === 'SUM') {
      const m = /^in([0-7])$/.exec(w.to.port || '');
      const idx = m ? Number(m[1]) : 0;
      gain = (tgt.signs && tgt.signs[idx] === -1) ? -1 : 1;
    }
    if (!incoming.has(w.to.block)) incoming.set(w.to.block, []);
    incoming.get(w.to.block).push({ from: w.from.block, gain });
  });

  const hasContinuous = blocks.some((b) => b.type === 'TF' && blockDomainZ(b) === 's');
  const hasDiscrete = blocks.some((b) => b.type === 'TF' && blockDomainZ(b) === 'z');
  const hasBoundary = blocks.some((b) => b.type === 'SAMPLER' || b.type === 'ZOH');
  if (hasContinuous && hasDiscrete && !hasBoundary) {
    return { error: 's 域与 z 域模块需通过“采样器 / 零阶保持器”连接，不能直接相连' };
  }

  const state = new Map();
  for (const b of blocks) {
    if (b.type === 'TF') {
      const pair = parseZPair(b.params?.num, b.params?.den);
      if (!pair) { state.set(b.id, { err: true }); continue; }
      const dom = blockDomainZ(b);
      const ss = dom === 'z' ? makeDiscreteSS(pair.num, pair.den) : makeContinuousSS(pair.num, pair.den);
      if (!ss) { state.set(b.id, { err: true }); continue; }
      state.set(b.id, { kind: dom === 'z' ? 'z' : 'cont', ss });
    } else if (b.type === 'SAMPLER' || b.type === 'ZOH') {
      state.set(b.id, { kind: 'hold', held: 0 });
    }
  }
  if ([...state.values()].some((s) => s && s.err)) {
    return { error: '存在无法解析或不可仿真的传递函数，请检查分子/分母' };
  }

  const M = hasContinuous ? 20 : 1;
  const h = Ts / M;
  const totalSamples = Math.max(1, Math.round(T / Ts));

  const y = new Map();
  blocks.forEach((b) => y.set(b.id, 0));

  // 读取全局实时值（用于连续相位内的连续链）
  const inputOf = (b) => {
    const inc = incoming.get(b.id) || [];
    let s = 0;
    for (const e of inc) s += e.gain * (y.get(e.from) || 0);
    return s;
  };
  // 读取迭代快照 m（用于采样瞬间反馈环的定点迭代）
  const inputOfCur = (b, m) => {
    const inc = incoming.get(b.id) || [];
    let s = 0;
    for (const e of inc) s += e.gain * (m.get(e.from) || 0);
    return s;
  };

  const probeBlocks = blocks.filter((b) => b.type === 'PROBE');
  const series = probeBlocks.map((p) => ({ name: p.params?.name || '示波器', xs: [], ys: [] }));

  // 主循环：在采样瞬间 k·Ts 做离散/代数更新（结果存于该时刻），随后在 [kTs,(k+1)Ts) 内积分连续块
  for (let k = 0; k <= totalSamples; k++) {
    const tNow = k * Ts;

    // 相位 A（采样瞬间）：对离散 TF 与代数块做定点迭代，使反馈采用“当前拍”收敛值。
    // 连续块保持上一积分段在 tNow 的输出不变（它们不含代数环的直接馈通）。
    const cur = new Map(y);
    let prev = null;
    for (let it = 0; it < 60; it++) {
      prev = new Map(cur);
      for (const b of blocks) {
        const st = state.get(b.id);
        let v;
        if (b.type === 'SOURCE') v = sourceValueZ(b, tNow);
        else if (b.type === 'SUM' || b.type === 'PICKOFF' || b.type === 'PROBE') v = inputOfCur(b, cur);
        else if (b.type === 'SAMPLER' || b.type === 'ZOH') v = inputOfCur(b, cur);
        else if (b.type === 'TF' && st) v = (st.kind === 'cont') ? (y.get(b.id) || 0) : st.ss.output(inputOfCur(b, cur));
        else v = 0;
        cur.set(b.id, v);
      }
      let md = 0;
      cur.forEach((v, kk) => { md = Math.max(md, Math.abs(v - (prev.get(kk) || 0))); });
      if (md < 1e-9) break;
    }
    // 提交离散 TF 状态（推进一拍）与采样器/保持器锁存值
    for (const b of blocks) {
      const st = state.get(b.id);
      if (b.type === 'TF' && st && st.kind === 'z') st.ss.advance(inputOfCur(b, cur), cur.get(b.id));
      else if ((b.type === 'SAMPLER' || b.type === 'ZOH') && st) st.held = cur.get(b.id);
    }
    y.clear();
    cur.forEach((v, kk) => y.set(kk, v));
    probeBlocks.forEach((p, i) => { series[i].xs.push(tNow); series[i].ys.push(y.get(p.id) || 0); });

    // 相位 B（连续积分）：在 [tNow, tNow+Ts) 内以 RK4 推进连续块，输入由 ZOH 保持为常值
    if (k < totalSamples) {
      for (let s = 0; s < M; s++) {
        const tcur = tNow + (s + 1) * h;
        for (const b of blocks) {
          const st = state.get(b.id);
          if (b.type === 'SOURCE') y.set(b.id, sourceValueZ(b, tcur));
          else if (b.type === 'SUM' || b.type === 'PICKOFF' || b.type === 'PROBE') y.set(b.id, inputOf(b));
          else if (b.type === 'SAMPLER' || b.type === 'ZOH') y.set(b.id, st ? st.held : 0);
          else if (b.type === 'TF' && st && st.kind === 'cont') y.set(b.id, st.ss.step(inputOf(b), h));
        }
      }
    }
  }

  return { series };
}
