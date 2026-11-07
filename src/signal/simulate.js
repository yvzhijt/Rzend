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
