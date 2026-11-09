/* 连续 → 离散 (ZOH) 精确离散化，以及 z 平面稳定性判据。
 * c2d 基于可控标准型状态空间的零阶保持精确解：
 *   Ad = e^{A·Ts},  Bd = ∫₀^Ts e^{Aτ} dτ · B
 * 再用马尔可夫参数 + 牛顿恒等式还原为 z⁻¹ 有理式，结果与 MATLAB c2d(·,'zoh') 一致。 */
import { polyRoots } from './freq.js';

/* ---------------- 小型矩阵工具（n×n） ---------------- */
function matMul(A, B) {
  const n = A.length, m = B[0].length, p = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    const Ai = A[i];
    for (let k = 0; k < p; k++) {
      const a = Ai[k];
      if (!a) continue;
      const Bk = B[k];
      for (let j = 0; j < m; j++) C[i][j] += a * Bk[j];
    }
  }
  return C;
}
function matAdd(A, B, s = 1) {
  const n = A.length, m = A[0].length;
  const C = Array.from({ length: n }, () => new Array(m));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) C[i][j] = A[i][j] + s * B[i][j];
  return C;
}
function matVec(A, x) {
  const n = A.length, m = A[0].length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < m; j++) s += A[i][j] * x[j]; y[i] = s; }
  return y;
}
function matTrace(A) { let t = 0; for (let i = 0; i < A.length; i++) t += A[i][i]; return t; }
function identity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/* 矩阵指数：缩放-平方 + 泰勒级数（对参数 A 为方阵，||A/2^s||≤0.5 后截断到 40 阶） */
function expm(A) {
  const n = A.length;
  if (n === 0) return A;
  let norm = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += Math.abs(A[i][j]); norm = Math.max(norm, s); }
  let s = 0;
  while (norm / (2 ** s) > 0.5) s++;
  const As = A.map((r) => r.map((v) => v / (2 ** s)));
  let E = identity(n);
  let term = identity(n);
  for (let k = 1; k <= 40; k++) {
    term = matMul(term, As);
    let f = 1; for (let i = 2; i <= k; i++) f *= i;
    E = matAdd(E, term, 1 / f);
  }
  for (let i = 0; i < s; i++) E = matMul(E, E);
  return E;
}

function fmtCoef(c) {
  if (Math.abs(c) < 1e-12) return '0';
  return (Math.round(c * 1e6) / 1e6).toString();
}

/* 系数数组（下标 = z⁻ᵏ，k≥0）格式化为 z⁻¹ 多项式字符串 */
function polyZm1(arr) {
  const terms = [];
  for (let k = 0; k < arr.length; k++) {
    const c = arr[k];
    if (Math.abs(c) < 1e-12) continue;
    let t;
    if (k === 0) t = fmtCoef(c);
    else if (k === 1) t = `${fmtCoef(c)}*z^-1`;
    else t = `${fmtCoef(c)}*z^-${k}`;
    terms.push({ c, t });
  }
  if (!terms.length) return '0';
let s = '';
  terms.forEach((tm, idx) => {
    if (idx === 0) s += (tm.c < 0 ? '-' : '') + tm.t;
    else s += tm.c < 0 ? ` - ${tm.t.replace(/^-/, '')}` : ` + ${tm.t}`;
  });
  return s;
}

/* 连续传递函数（系数数组，下标 = s 的幂；由 parseZPair 得到）经 ZOH 离散化为 z⁻¹ 有理式。
 * 返回 { num, den } 字符串，或 null（阶次不足 / 非真分式）。 */
export function c2d(num, den, Ts) {
  if (!(Ts > 0)) return null;
  let d = (den || []).map(Number);
  let N = (num || []).map(Number);
  if (!d.length || !N.length) return null;
  let i = d.length - 1;
  while (i > 0 && Math.abs(d[i]) < 1e-15) i--;
  if (i < 1) return null; // 至少一阶
  const n = i;
  const dd = d[n] || 1;
  d = d.map((v) => v / dd);
  N = N.map((v) => v / dd);

  // 直接项（分子阶次 = 分母阶次 → 有直通项）
  let Dss = 0;
  if (N.length - 1 >= n) { Dss = N[n] || 0; N = N.slice(0, n); }

  // 可控标准型：A[n-1][k] = -d[k]，B[n-1] = 1，C = N[0..n-1]
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n - 1; k++) A[k][k + 1] = 1;
  for (let k = 0; k < n; k++) A[n - 1][k] = -d[k];
  const B = new Array(n).fill(0); B[n - 1] = 1;
  const C = Array.from({ length: n }, (_, j) => N[j] || 0);

  const Ad = expm(A.map((r) => r.map((v) => v * Ts)));
  // Bd = Σ (Ts^{k+1}/(k+1)!) A^k B
  let Apow = identity(n);
  const Bd = new Array(n).fill(0);
  for (let k = 0; k <= 40; k++) {
    let f = 1; for (let ii = 2; ii <= k + 1; ii++) f *= ii;
    const AkB = matVec(Apow, B);
    for (let j = 0; j < n; j++) Bd[j] += (Ts ** (k + 1) / f) * AkB[j];
    Apow = matMul(Apow, A);
  }

  // 马尔可夫参数 h_k = C·Ad^k·Bd（k=0..n-1）
  const h = [];
  let Ak = identity(n);
  for (let k = 0; k < n; k++) {
    h[k] = 0;
    const AkB = matVec(Ak, Bd);
    for (let j = 0; j < n; j++) h[k] += C[j] * AkB[j];
    Ak = matMul(Ak, Ad);
  }
  // 幂和 p_m = tr(Ad^m)
  const p = [0];
  let Apow2 = identity(n);
  for (let m = 1; m <= n; m++) { Apow2 = matMul(Apow2, Ad); p[m] = matTrace(Apow2); }
  // 牛顿恒等式求初等对称多项式 e_m（特征值 λ 的）
  const e = [1];
  for (let m = 1; m <= n; m++) {
    let sum = 0;
    for (let ii = 1; ii <= m; ii++) sum += ((-1) ** (ii - 1)) * p[ii] * (ii === m ? 1 : e[m - ii]);
    e[m] = sum / m;
  }
  // 分母（z⁻¹）：1 - e1 z⁻¹ + e2 z⁻² - … + (-1)^n en z⁻ⁿ
  const denArr = [1];
  for (let k = 1; k <= n; k++) denArr[k] = ((-1) ** k) * e[k];
  // 分子：n_j = Σ_{i=0}^{j} c_i·h_{j-i}，c_0=1
  const numArr = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let v = 0;
    for (let ii = 0; ii <= j; ii++) v += denArr[ii] * (h[j - ii] || 0);
    numArr[j] = v;
  }
  numArr[0] += Dss; // 直通项加入常数项

  // 状态空间 ZOH 得到的是“无额外延迟”的 G_ss(z)，而标准的零阶保持脉冲传函
  // 为 z⁻¹·G_ss(z)（保持器引入一个采样周期的延迟）。首部补 0 即乘 z⁻¹，与
  // MATLAB c2d('zoh') 及教材约定一致。
  numArr.unshift(0);

  return { num: polyZm1(numArr), den: polyZm1(denArr) };
}

/* z 平面稳定性：denArr 为 z 的幂系数数组（parseZPair 返回，下标 = z 的幂）。
 * 返回 { roots, stable, marginal, unstable }，稳定要求全部极点严格在单位圆内。 */
export function zStability(denArr) {
  const roots = polyRoots(denArr);
  const unstable = roots.filter((r) => Math.hypot(r.re, r.im) > 1 + 1e-9);
  const marginal = roots.filter((r) => {
    const m = Math.hypot(r.re, r.im);
    return m >= 1 - 1e-9 && m <= 1 + 1e-9 && unstable.indexOf(r) < 0;
  });
  return { roots, stable: unstable.length === 0 && marginal.length === 0, marginal, unstable };
}
