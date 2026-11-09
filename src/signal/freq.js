/* 频域分析：多项式求根（Durand-Kerner）、Bode 频响数据、稳定性判据。
 * 仅用于连续 s 域闭环传递函数 T(s)=N(s)/D(s) 的分析。 */

function cAdd(u, v) { return { re: u.re + v.re, im: u.im + v.im }; }
function cSub(u, v) { return { re: u.re - v.re, im: u.im - v.im }; }
function cMul(u, v) { return { re: u.re * v.re - u.im * v.im, im: u.re * v.im + u.im * v.re }; }
function cDiv(u, v) {
  const d = v.re * v.re + v.im * v.im || 1e-30;
  return { re: (u.re * v.re + u.im * v.im) / d, im: (u.im * v.re - u.re * v.im) / d };
}

function trimArr(p) {
  let i = p.length - 1;
  while (i > 0 && Math.abs(p[i]) < 1e-15) i--;
  return p.slice(0, i + 1);
}

/* 在 s = z（复数）处求值多项式（系数数组，下标 = 幂次） */
function polyAt(coeffs, z) {
  const c = trimArr(coeffs);
  let re = c[c.length - 1], im = 0;
  for (let k = c.length - 2; k >= 0; k--) {
    const nr = re * z.re - im * z.im + (c[k] || 0);
    const ni = re * z.im + im * z.re;
    re = nr; im = ni;
  }
  return { re, im };
}

/* Durand-Kerner 同时迭代求全部根（返回复数 {re,im}）。
 * 对控制类低阶（≤12）多项式足够稳健；根按实部升序便于阅读。 */
export function polyRoots(coeffs) {
  const c = trimArr(coeffs);
  const n = c.length - 1;
  if (n < 1) return [];
  const a = c.map((v) => v / (c[n] || 1)); // 首项归一：a[n] = 1
  // 导数系数 d[k] = (k+1)·a[k+1]
  const d = new Array(n).fill(0);
  for (let k = 0; k < n; k++) d[k] = (k + 1) * (a[k + 1] || 0);

  let roots = [];
  for (let k = 0; k < n; k++) {
    const ang = (2 * Math.PI * k) / n;
    roots.push({ re: 0.4 * Math.cos(ang), im: 0.4 * Math.sin(ang) });
  }
  for (let iter = 0; iter < 300; iter++) {
    let maxd = 0;
    const next = roots.map((r, i) => {
      let denom = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        denom = cMul(denom, cSub(r, roots[j]));
      }
      const num = polyAt(a, r);
      const delta = cDiv(num, denom);
      const nr = cSub(r, delta);
      maxd = Math.max(maxd, Math.hypot(delta.re, delta.im));
      return nr;
    });
    roots = next;
    if (maxd < 1e-12) break;
  }
  // 合并数值上几乎重合的根（重根），避免浮点分裂
  const merged = [];
  for (const r of roots) {
    const hit = merged.find((m) => Math.hypot(m.re - r.re, m.im - r.im) < 1e-6);
    if (hit) hit.mult = (hit.mult || 1) + 1;
    else merged.push({ re: r.re, im: r.im, mult: 1 });
  }
  return merged.sort((u, v) => u.re - v.re || u.im - v.im);
}

/* 评估 N(jω)/D(jω)，返回 {re,im} */
function freqResp(num, den, w) {
  // (jw)^k = w^k · j^k，j^k 四周期
  const term = (coeffs) => {
    const c = trimArr(coeffs);
    let re = 0, im = 0;
    for (let k = 0; k < c.length; k++) {
      const ak = c[k];
      if (!ak) continue;
      const wk = Math.pow(w, k);
      const m = k % 4;
      const jre = m === 0 ? 1 : m === 2 ? -1 : 0;
      const jim = m === 1 ? 1 : m === 3 ? -1 : 0;
      re += ak * wk * jre;
      im += ak * wk * jim;
    }
    return { re, im };
  };
  return cDiv(term(num), term(den));
}

/* 计算 Bode 数据：在 [wMin,wMax] 按对数等距取 npts 点，
 * 返回 { w, magDb, phaseDeg }，相频已做展开(unwrap)。 */
export function bodeResponse(num, den, opts = {}) {
  const wMin = opts.wMin ?? 1e-2;
  const wMax = opts.wMax ?? 1e3;
  const npts = opts.npts ?? 240;
  if (!(wMax > wMin) || npts < 2) return null;
  const logMin = Math.log10(wMin);
  const logMax = Math.log10(wMax);
  const w = new Array(npts);
  const magDb = new Array(npts);
  const phaseDeg = new Array(npts);
  for (let i = 0; i < npts; i++) {
    const ww = 10 ** (logMin + (logMax - logMin) * (i / (npts - 1)));
    const r = freqResp(num, den, ww);
    const mag = Math.hypot(r.re, r.im);
    w[i] = ww;
    magDb[i] = 20 * Math.log10(mag + 1e-300);
    phaseDeg[i] = Math.atan2(r.im, r.re) * 180 / Math.PI;
  }
  for (let i = 1; i < npts; i++) {
    let dph = phaseDeg[i] - phaseDeg[i - 1];
    while (dph > 180) { phaseDeg[i] -= 360; dph -= 360; }
    while (dph < -180) { phaseDeg[i] += 360; dph += 360; }
  }
  return { w, magDb, phaseDeg };
}

/* 由特征多项式（分母）判定稳定性：所有极点实部 < 0 即稳定 */
export function stabilityFromDen(den) {
  const roots = polyRoots(den);
  const unstable = roots.filter((r) => r.re > 1e-9);
  return { roots, stable: unstable.length === 0, unstable };
}

export function formatComplex(r) {
  const re = Math.abs(r.re) < 1e-9 ? 0 : r.re;
  const im = Math.abs(r.im) < 1e-9 ? 0 : r.im;
  if (im === 0) return re.toFixed(3);
  const s = im < 0 ? '−' : '+';
  return `${re.toFixed(3)} ${s} ${Math.abs(im).toFixed(3)}j`;
}
