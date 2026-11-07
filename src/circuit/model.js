// 电路仿真内核：Component / Net 模型 + 节点法(MNA) + 后向欧拉瞬态
//
// 三层结构：
//   Port  端子（key = `${元件id}:${端子序号}`）
//   Net   网络（等电位节点），ports 里装端子，segs 里装导线的几何形状
//   Component 元件类，自带端子几何、仿真 stamp() 与状态更新 commit()
// 连线 = 把两个端子并入同一个 Net；导线只负责画图，不影响电学连接。

let seq = (Date.now() % 100000) * 10;

export function uid(prefix = 'e') {
  seq += 1;
  return `${prefix}${seq.toString(36)}`;
}

export const ELEMENTS = {
  R: {
    cn: '电阻', en: 'Resistor', group: '无源元件', pins: 2, color: '#0072bd',
    params: [{ key: 'r', label: '阻值 (Ω)', def: 100 }],
  },
  C: {
    cn: '电容', en: 'Capacitor', group: '无源元件', pins: 2, color: '#0072bd',
    params: [{ key: 'c', label: '电容 (F)', def: 0.0001 }],
  },
  L: {
    cn: '电感', en: 'Inductor', group: '无源元件', pins: 2, color: '#0072bd',
    params: [{ key: 'l', label: '电感 (H)', def: 0.1 }],
  },
  V: {
    cn: '直流电压源', en: 'DC Voltage Source', group: '电源', pins: 2, color: '#d95319',
    params: [{ key: 'v', label: '电压 (V)', def: 5 }],
  },
  VS: {
    cn: '正弦电压源', en: 'Sine Voltage Source', group: '电源', pins: 2, color: '#d95319',
    params: [
      { key: 'amp', label: '幅值 (V)', def: 5 },
      { key: 'freq', label: '频率 (Hz)', def: 50 },
      { key: 'phase', label: '相位 (rad)', def: 0 },
    ],
  },
  I: {
    cn: '直流电流源', en: 'DC Current Source', group: '电源', pins: 2, color: '#d95319',
    params: [{ key: 'i', label: '电流 (A)', def: 0.001 }],
  },
  CLK: {
    cn: '时钟源', en: 'Clock Source', group: '电源', pins: 2, color: '#d95319',
    params: [
      { key: 'freq', label: '频率 (Hz)', def: 1000 },
      { key: 'duty', label: '占空比 (0-1)', def: 0.5 },
      { key: 'high', label: '高电平 (V)', def: 5 },
      { key: 'low', label: '低电平 (V)', def: 0 },
      { key: 'phase', label: '相位 (0-1)', def: 0 },
    ],
  },
  IMP: {
    cn: '单位脉冲', en: 'Unit Impulse', group: '信号源', pins: 2, color: '#d95319', params: [],
  },
  STEP: {
    cn: '单位阶跃', en: 'Unit Step', group: '信号源', pins: 2, color: '#d95319', params: [],
  },
  RAMP: {
    cn: '单位斜坡（速度）', en: 'Unit Ramp', group: '信号源', pins: 2, color: '#d95319', params: [],
  },
  PARABOLA: {
    cn: '单位抛物线（加速度）', en: 'Unit Parabolic', group: '信号源', pins: 2, color: '#d95319', params: [],
  },
  D: {
    cn: '二极管', en: 'Diode', group: '无源元件', pins: 2, color: '#0072bd',
    params: [
      { key: 'vf', label: '参考正向压降 (V, 1mA)', def: 0.7 },
      { key: 'n', label: '理想因子 n', def: 1.8 },
    ],
  },
  GND: { cn: '接地', en: 'Ground', group: '电源', pins: 1, color: '#44515c', params: [] },
  A: { cn: '电流表', en: 'Ammeter', group: '测量', pins: 2, color: '#7e2f8e', params: [], meter: 'A' },
  VM: { cn: '电压表', en: 'Voltmeter', group: '测量', pins: 2, color: '#7e2f8e', params: [], meter: 'V' },
  P: { cn: '示波器探针', en: 'Scope Probe', group: '测量', pins: 1, color: '#77ac30', params: [], probe: true },
  NOT: { cn: '非门', en: 'NOT Gate', group: '数字逻辑', pins: 2, color: '#8a4fb5', params: logicParams() },
  AND: { cn: '与门', en: 'AND Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  NAND: { cn: '与非门', en: 'NAND Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  OR: { cn: '或门', en: 'OR Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  NOR: { cn: '或非门', en: 'NOR Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  XOR: { cn: '异或门', en: 'XOR Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  XNOR: { cn: '同或门', en: 'XNOR Gate', group: '数字逻辑', pins: 3, color: '#8a4fb5', params: logicParams() },
  TF: {
    cn: '传递函数', en: 'Transfer Function', group: '控制系统', pins: 4, color: '#2f7d68',
    params: [
      { key: 'num', label: '分子 N(s)', def: 's', type: 'text' },
      { key: 'den', label: '分母 D(s)', def: 's + 1', type: 'text' },
      { key: 'rin', label: '输入电阻 (Ω)', def: 1000000000 },
      { key: 'rout', label: '输出电阻 (Ω)', def: 50 },
    ],
  },
};

function logicParams() {
  return [
    { key: 'high', label: '高电平 (V)', def: 5 },
    { key: 'low', label: '低电平 (V)', def: 0 },
    { key: 'threshold', label: '输入阈值 (V)', def: 2.5 },
    { key: 'rin', label: '输入电阻 (Ω)', def: 1000000 },
    { key: 'rout', label: '输出电阻 (Ω)', def: 50 },
  ];
}

export const W = 120;
export const H = 48;

// 数字逻辑门类型集合：共用引脚几何与输入判定机制
const LOGIC_TYPES = new Set(['NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR']);

/* ---------------- 网格 ----------------
 * 12px 栅格、原点偏移 6px。元件原点放在格点上时，任意 90° 旋转后
 * 所有引脚偏移（0/24/36/48/60/84/120）都是 12 的整数倍，因此引脚
 * 永远落在格点上，可以用整数坐标做精确、无偏移的命中判定。
 */
export const GRID = 12;
export const GRID_OFFSET = 6;

export function snapGrid(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return GRID_OFFSET;
  return GRID_OFFSET + Math.round((n - GRID_OFFSET) / GRID) * GRID;
}

export function snapPoint(p) {
  return { x: snapGrid(p?.x), y: snapGrid(p?.y) };
}

export function onGrid(v) {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n - snapGrid(n)) < 1e-6;
}

/* ---------------- 几何 ---------------- */

// 端子在本元件局部坐标（未旋转）中的位置
export function pinLocal(type, index) {
  const def = ELEMENTS[type];
  if (type === 'TF') {
    return index < 2
      ? { x: 0, y: index === 0 ? H / 4 : H * 3 / 4 }
      : { x: W, y: index === 2 ? H / 4 : H * 3 / 4 };
  }
  if (LOGIC_TYPES.has(type)) {
    if (def.pins === 2) return index === 0 ? { x: 0, y: H / 2 } : { x: W, y: H / 2 };
    if (index === 0) return { x: 0, y: H / 4 };
    if (index === 1) return { x: 0, y: H * 3 / 4 };
    return { x: W, y: H / 2 };
  }
  if (def.pins === 1) {
    return type === 'GND' ? { x: W / 2, y: H } : { x: 0, y: H / 2 };
  }
  return index === 0
    ? { x: 0, y: H / 2 }
    : { x: W, y: H / 2 };
}

export function normalizeRot(v) {
  const d = Math.round((Number(v) || 0) / 90) * 90;
  return ((d % 360) + 360) % 360;
}

// 绕元件中心顺时针旋转（屏幕坐标 y 向下，与 SVG rotate() 一致）
// 只用整数加减，避免三角函数误差导致引脚坐标出现 89.99999 这样的浮点偏移
export function rotateLocal(p, deg) {
  const d = normalizeRot(deg);
  const cx = W / 2;
  const cy = H / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  switch (d) {
    case 90: return { x: cx - dy, y: cy + dx };
    case 180: return { x: cx - dx, y: cy - dy };
    case 270: return { x: cx + dy, y: cy - dx };
    default: return { x: p.x, y: p.y };
  }
}

export function pinPos(comp, index) {
  const p = rotateLocal(pinLocal(comp.type, index), comp.rot);
  return { x: comp.x + p.x, y: comp.y + p.y };
}

export function fmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 10000)) return n.toExponential(2);
  return String(Math.round(n * 1000) / 1000);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function voltageSourceValue(component, t, dt) {
  if (component.type === 'V') return num(component.params.v);
  if (component.type === 'VS') {
    return num(component.params.amp)
      * Math.sin(2 * Math.PI * num(component.params.freq) * t + num(component.params.phase));
  }
  if (component.type === 'CLK') {
    const freq = Math.max(1e-9, Math.abs(num(component.params.freq)));
    const duty = Math.min(1, Math.max(0, num(component.params.duty)));
    const phase = num(component.params.phase) - Math.floor(num(component.params.phase));
    const fraction = ((t * freq + phase) % 1 + 1) % 1;
    return fraction < duty ? num(component.params.high) : num(component.params.low);
  }
  if (component.type === 'IMP') return t < dt ? 1 / dt : 0;
  if (component.type === 'STEP') return t >= 0 ? 1 : 0;
  if (component.type === 'RAMP') return Math.max(0, t);
  if (component.type === 'PARABOLA') return 0.5 * Math.max(0, t) ** 2;
  throw new Error(`${component.type} 不是电压信号源`);
}

/* ---------------- 元件类 ---------------- */

export class Component {
  constructor(type, x, y, params) {
    this.id = uid('e');
    this.type = type;
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.rot = 0;
    this.params = {};
    const def = ELEMENTS[type];
    (def.params || []).forEach((p) => {
      this.params[p.key] = p.type === 'text' ? String(p.def) : p.def;
    });
    if (params) {
      Object.keys(this.params).forEach((k) => {
        if (params[k] != null) {
          const param = def.params.find((p) => p.key === k);
          this.params[k] = param?.type === 'text' ? String(params[k]) : Number(params[k]);
        }
      });
    }
  }

  get def() { return ELEMENTS[this.type]; }
  get pins() { return this.def.pins; }

  pinPos(i) { return pinPos(this, i); }

  describe() { return ''; }

  // ctx: { dt, t, n, row, node(i), state, stampG, stampI, stampV, x, vAt, readings, probes }
  stamp() {}

  commit() {}

  // 支路电流（pin0 → pin1 方向），用于实时模式下的电流动画。
  // 返回 null 表示该元件不适合/不需要显示电流。
  // 必须在 commit() 之前调用（commit 会覆盖电容电压、电感电流与二极管状态）。
  flow() { return null; }
}

class Resistor extends Component {
  constructor(x, y, params) { super('R', x, y, params); }
  describe() { return `${fmt(this.params.r)}Ω`; }
  stamp(ctx) {
    const g = 1 / Math.max(1e-9, Math.abs(num(this.params.r)) || 1e-9);
    ctx.stampG(ctx.node(0), ctx.node(1), g);
  }
  flow(ctx) {
    const g = 1 / Math.max(1e-9, Math.abs(num(this.params.r)) || 1e-9);
    return g * (ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1)));
  }
}

class Capacitor extends Component {
  constructor(x, y, params) { super('C', x, y, params); }
  describe() { return `${fmt(this.params.c)}F`; }
  stamp(ctx) {
    const g = Math.max(1e-15, num(this.params.c)) / ctx.dt;
    const prev = ctx.state.get(this.id);
    ctx.stampG(ctx.node(0), ctx.node(1), g);
    ctx.stampI(ctx.node(0), ctx.node(1), -g * (prev ? prev.v : 0));
  }
  commit(ctx) {
    ctx.state.set(this.id, { v: ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1)) });
  }
  flow(ctx) {
    const g = Math.max(1e-15, num(this.params.c)) / ctx.dt;
    const prev = ctx.state.get(this.id);
    return g * ((ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1))) - (prev ? prev.v : 0));
  }
}

class Inductor extends Component {
  constructor(x, y, params) { super('L', x, y, params); }
  describe() { return `${fmt(this.params.l)}H`; }
  stamp(ctx) {
    const g = ctx.dt / Math.max(1e-12, num(this.params.l));
    const prev = ctx.state.get(this.id);
    ctx.stampG(ctx.node(0), ctx.node(1), g);
    ctx.stampI(ctx.node(0), ctx.node(1), prev ? prev.i : 0);
  }
  commit(ctx) {
    const g = ctx.dt / Math.max(1e-12, num(this.params.l));
    const prev = ctx.state.get(this.id);
    ctx.state.set(this.id, {
      i: g * (ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1))) + (prev ? prev.i : 0),
    });
  }
  flow(ctx) {
    const g = ctx.dt / Math.max(1e-12, num(this.params.l));
    const prev = ctx.state.get(this.id);
    return g * (ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1))) + (prev ? prev.i : 0);
  }
}

class DCSource extends Component {
  constructor(x, y, params) { super('V', x, y, params); }
  describe() { return `${fmt(this.params.v)}V`; }
  stamp(ctx) {
    // pin1 为正极，pin0 为负极
    ctx.stampV(ctx.node(1), ctx.node(0), voltageSourceValue(this, ctx.t, ctx.dt), ctx.row);
  }
  flow(ctx) { return -ctx.x[ctx.row]; }
}

class SineSource extends Component {
  constructor(x, y, params) { super('VS', x, y, params); }
  describe() { return `${fmt(this.params.amp)}V ${fmt(this.params.freq)}Hz`; }
  stamp(ctx) {
    ctx.stampV(ctx.node(1), ctx.node(0), voltageSourceValue(this, ctx.t, ctx.dt), ctx.row);
  }
  flow(ctx) { return -ctx.x[ctx.row]; }
}

class CurrentSource extends Component {
  constructor(x, y, params) { super('I', x, y, params); }
  describe() { return `${fmt(this.params.i)}A`; }
  stamp(ctx) { ctx.stampI(ctx.node(0), ctx.node(1), num(this.params.i)); }
  flow(ctx) { return num(this.params.i); }
}

class SignalSource extends Component {
  constructor(type, x, y, params) { super(type, x, y, params); }
  describe() {
    if (this.type === 'IMP') return 'δ(t)';
    if (this.type === 'STEP') return 'u(t)';
    if (this.type === 'RAMP') return 't·u(t)';
    return '½t²·u(t)';
  }
  stamp(ctx) {
    ctx.stampV(ctx.node(1), ctx.node(0), voltageSourceValue(this, ctx.t, ctx.dt), ctx.row);
  }
  flow(ctx) { return -ctx.x[ctx.row]; }
}

// 时钟源：理想方波电压源（pin1 为正极，pin0 为负极）
// t 落在周期的低电平段还是高电平段由占空比决定，相位按周期比例平移。
class ClockSource extends Component {
  constructor(x, y, params) { super('CLK', x, y, params); }
  describe() {
    return `${fmt(this.params.freq)}Hz ${Math.round(num(this.params.duty) * 100)}%`;
  }
  stamp(ctx) {
    ctx.stampV(ctx.node(1), ctx.node(0), voltageSourceValue(this, ctx.t, ctx.dt), ctx.row);
  }
  flow(ctx) { return -ctx.x[ctx.row]; }
}

// 二极管采用 Shockley 指数 I-V 曲线；vf 定义为 1mA 时的参考正向压降。
// stamp() 对当前工作点做 Newton 线性化，stepSimulation 迭代至 KCL/KVL 收敛。
class Diode extends Component {
  constructor(x, y, params) { super('D', x, y, params); }
  describe() { return `${fmt(this.params.vf)}V n=${fmt(this.params.n)}`; }
  stamp(ctx) {
    const vf = Math.max(0.05, num(this.params.vf));
    const nVt = Math.max(0.5, num(this.params.n) || 1) * 0.02585;
    const is = 1e-3 / Math.expm1(Math.min(40, vf / nVt));
    const vd = ctx.state.get(this.id)?.vd ?? 0;
    const exp = Math.exp(Math.max(-40, Math.min(40, vd / nVt)));
    const current = is * (exp - 1);
    const conductance = Math.max(1e-12, is * exp / nVt);
    ctx.stampG(ctx.node(0), ctx.node(1), conductance);
    ctx.stampI(ctx.node(0), ctx.node(1), current - conductance * vd);
  }
  commit(ctx) {
    const vd = ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1));
    ctx.state.set(this.id, { vd });
  }
  flow(ctx) {
    const vf = Math.max(0.05, num(this.params.vf));
    const nVt = Math.max(0.5, num(this.params.n) || 1) * 0.02585;
    const is = 1e-3 / Math.expm1(Math.min(40, vf / nVt));
    const vd = ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1));
    return is * (Math.exp(Math.max(-40, Math.min(40, vd / nVt))) - 1);
  }
}

// 数字门采用有限输入/输出阻抗的 Thevenin 模型，避免理想电压源造成过约束。
const GATE_OPS = {
  NOT: (a) => !a,
  AND: (a, b) => a && b,
  NAND: (a, b) => !(a && b),
  OR: (a, b) => a || b,
  NOR: (a, b) => !(a || b),
  XOR: (a, b) => a !== b,
  XNOR: (a, b) => a === b,
};

class LogicGate extends Component {
  constructor(type, x, y, params) { super(type, x, y, params); }
  describe() { return `${fmt(this.params.low)} / ${fmt(this.params.high)} V`; }
  stamp(ctx) {
    const inputCount = this.pins - 1;
    const rin = Math.max(1, Math.abs(num(this.params.rin)) || 1e6);
    const rout = Math.max(1, Math.abs(num(this.params.rout)) || 50);
    for (let i = 0; i < inputCount; i++) {
      ctx.stampG(ctx.node(i), 0, 1 / rin);
    }
    const output = ctx.state.get(this.id)?.output ?? num(this.params.low);
    const g = 1 / rout;
    ctx.stampG(ctx.node(inputCount), 0, g);
    ctx.stampI(0, ctx.node(inputCount), output * g);
  }
  nextOutput(vAt, nodes) {
    const threshold = num(this.params.threshold);
    const level = (node) => vAt(node) >= threshold;
    const high = num(this.params.high);
    const low = num(this.params.low);
    if (this.type === 'NOT') return GATE_OPS.NOT(level(nodes[0])) ? high : low;
    return GATE_OPS[this.type](level(nodes[0]), level(nodes[1])) ? high : low;
  }
  commit(ctx) {
    ctx.readings.set(this.id, {
      value: ctx.vAt(ctx.node(this.pins - 1)), unit: 'V',
    });
  }
}

function parsePolynomial(expression, label) {
  const source = String(expression || '').trim();
  const tokens = [];
  const tokenPattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?|([sS])|([()+\-*/^]))/gy;
  let position = 0;
  while (position < source.length) {
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(source);
    if (!match) throw new Error(`${label} 含有不支持的字符或语法`);
    position = tokenPattern.lastIndex;
    if (match[1]) tokens.push({ type: 'number', value: Number(`${match[1]}${match[2] || ''}`) });
    else if (match[3]) tokens.push({ type: 's' });
    else tokens.push({ type: match[4] });
  }
  tokens.push({ type: 'end' });
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = (type) => {
    if (peek().type !== type) throw new Error(`${label} 表达式格式不正确`);
    return tokens[cursor++];
  };
  const clean = (poly) => {
    while (poly.length > 1 && Math.abs(poly[poly.length - 1]) < 1e-14) poly.pop();
    if (poly.some((coefficient) => !Number.isFinite(coefficient))) {
      throw new Error(`${label} 系数必须是有限数`);
    }
    if (poly.length > 9) throw new Error(`${label} 阶数不能超过 8`);
    return poly;
  };
  const add = (a, b, sign = 1) => clean(Array.from(
    { length: Math.max(a.length, b.length) },
    (_, i) => (a[i] || 0) + sign * (b[i] || 0),
  ));
  const multiply = (a, b) => {
    if (a.length + b.length > 10) throw new Error(`${label} 阶数不能超过 8`);
    const result = Array(a.length + b.length - 1).fill(0);
    a.forEach((av, i) => b.forEach((bv, j) => { result[i + j] += av * bv; }));
    return clean(result);
  };
  const primary = () => {
    if (peek().type === 'number') return [take('number').value];
    if (peek().type === 's') { take('s'); return [0, 1]; }
    if (peek().type === '(') {
      take('(');
      const value = expressionValue();
      take(')');
      return value;
    }
    throw new Error(`${label} 表达式格式不正确`);
  };
  const power = () => {
    let base = primary();
    while (peek().type === '^') {
      take('^');
      const exponent = take('number').value;
      if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
        throw new Error(`${label} 的幂次必须是 0 到 8 的整数`);
      }
      let result = [1];
      for (let i = 0; i < exponent; i++) result = multiply(result, base);
      base = result;
    }
    return base;
  };
  const unary = () => {
    if (peek().type === '+') { take('+'); return unary(); }
    if (peek().type === '-') { take('-'); return unary().map((value) => -value); }
    return power();
  };
  const product = () => {
    let value = unary();
    while (peek().type === '*' || peek().type === '/') {
      const operator = tokens[cursor++].type;
      const right = unary();
      if (operator === '*') value = multiply(value, right);
      else {
        if (right.length !== 1 || right[0] === 0) {
          throw new Error(`${label} 只支持除以非零常数；请把传递函数分子、分母分开填写`);
        }
        value = clean(value.map((coefficient) => coefficient / right[0]));
      }
    }
    return value;
  };
  const expressionValue = () => {
    let value = product();
    while (peek().type === '+' || peek().type === '-') {
      const operator = tokens[cursor++].type;
      value = add(value, product(), operator === '+' ? 1 : -1);
    }
    return value;
  };
  const result = expressionValue();
  if (peek().type !== 'end') throw new Error(`${label} 表达式格式不正确`);
  return clean(result);
}

function invertMatrix(matrix) {
  const size = matrix.length;
  const inverse = Array.from({ length: size }, () => Array(size).fill(0));
  for (let col = 0; col < size; col++) {
    const copy = matrix.map((row) => row.slice());
    const vector = Array(size).fill(0);
    vector[col] = 1;
    const result = solve(copy, vector);
    if (!result) throw new Error('传递函数离散化失败');
    result.forEach((value, row) => { inverse[row][col] = value; });
  }
  return inverse;
}

function transferConfig(component, dt) {
  let numerator = parsePolynomial(component.params.num, '分子 N(s)');
  const denominator = parsePolynomial(component.params.den, '分母 D(s)');
  if (denominator.every((coefficient) => Math.abs(coefficient) < 1e-14)) {
    throw new Error('分母 D(s) 不能为零');
  }
  const leading = denominator[denominator.length - 1];
  numerator = numerator.map((value) => value / leading);
  const den = denominator.map((value) => value / leading);
  const quotient = Array(Math.max(1, numerator.length - den.length + 1)).fill(0);
  const remainder = numerator.slice();
  for (let degree = remainder.length - den.length; degree >= 0; degree--) {
    const factor = remainder[degree + den.length - 1];
    quotient[degree] = factor;
    for (let i = 0; i < den.length; i++) remainder[degree + i] -= factor * den[i];
  }
  while (remainder.length > 1 && Math.abs(remainder[remainder.length - 1]) < 1e-10) remainder.pop();
  const order = den.length - 1;
  let stateFromPrev = [];
  let stateFromInput = [];
  if (order > 0) {
    const matrix = Array.from({ length: order }, (_, row) => {
      const values = Array(order).fill(0);
      if (row < order - 1) {
        values[row] = 1;
        values[row + 1] = -dt;
      } else {
        for (let col = 0; col < order; col++) values[col] = dt * den[col];
        values[order - 1] += 1;
      }
      return values;
    });
    stateFromPrev = invertMatrix(matrix);
    stateFromInput = stateFromPrev.map((row) => row[order - 1] * dt);
  }
  return { dt, denominator: den, quotient, remainder, order, stateFromPrev, stateFromInput };
}

function advanceTransfer(config, previous, input) {
  const oldState = previous.x || [];
  const nextState = config.stateFromPrev.map((row, i) => (
    row.reduce((sum, value, j) => sum + value * (oldState[j] || 0), 0)
    + config.stateFromInput[i] * input
  ));
  return { x: nextState, inputs: [input, ...(previous.inputs || []).slice(0, 8)] };
}

function transferAffine(config, previous) {
  const oldState = previous.x || [];
  const baseState = config.stateFromPrev.map((row) => (
    row.reduce((sum, value, j) => sum + value * (oldState[j] || 0), 0)
  ));
  let gain = config.quotient[0] || 0;
  let offset = 0;
  for (let degree = 1; degree < config.quotient.length; degree++) {
    let coefficient = 0;
    for (let j = 1; j <= degree; j++) {
      coefficient += (j % 2 ? -1 : 1) * binomial(degree, j)
        * (previous.inputs?.[j - 1] || 0);
    }
    const scale = config.quotient[degree] / config.dt ** degree;
    gain += scale;
    offset += coefficient * scale;
  }
  for (let i = 0; i < config.order; i++) {
    const outputCoefficient = config.remainder[i] || 0;
    offset += outputCoefficient * baseState[i];
    gain += outputCoefficient * config.stateFromInput[i];
  }
  return { gain, offset };
}

function binomial(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return result;
}

class TransferFunction extends Component {
  constructor(x, y, params) { super('TF', x, y, params); }
  describe() { return 'H(s)'; }
  stamp(ctx) {
    const config = ctx.transferConfigs.get(this.id);
    const previous = ctx.state.get(this.id) || { x: [], inputs: [] };
    const { gain, offset } = transferAffine(config, previous);
    const rin = Math.max(1, Math.abs(num(this.params.rin)) || 1e9);
    const rout = Math.max(1, Math.abs(num(this.params.rout)) || 50);
    ctx.stampG(ctx.node(0), ctx.node(1), 1 / rin);
    const g = 1 / rout;
    ctx.stampG(ctx.node(2), ctx.node(3), g);
    ctx.stampVCCS(ctx.node(2), ctx.node(3), ctx.node(0), ctx.node(1), -g * gain);
    ctx.stampI(ctx.node(3), ctx.node(2), g * offset);
  }
  commit(ctx) {
    const config = ctx.transferConfigs.get(this.id);
    const input = ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1));
    const previous = ctx.state.get(this.id) || { x: [], inputs: [] };
    ctx.state.set(this.id, advanceTransfer(config, previous, input));
    ctx.readings.set(this.id, {
      value: ctx.vAt(ctx.node(2)) - ctx.vAt(ctx.node(3)), unit: 'V',
    });
  }
}

class Ground extends Component {
  constructor(x, y, params) { super('GND', x, y, params); }
}

class Ammeter extends Component {
  constructor(x, y, params) { super('A', x, y, params); }
  // 理想电流表：0V 电压源，支路电流即读数
  stamp(ctx) { ctx.stampV(ctx.node(0), ctx.node(1), 0, ctx.row); }
  commit(ctx) { ctx.readings.set(this.id, { value: ctx.x[ctx.row], unit: 'A' }); }
  flow(ctx) { return ctx.x[ctx.row]; }
}

class Voltmeter extends Component {
  constructor(x, y, params) { super('VM', x, y, params); }
  // 电压表：1GΩ 高阻
  stamp(ctx) { ctx.stampG(ctx.node(0), ctx.node(1), 1e-9); }
  commit(ctx) {
    ctx.readings.set(this.id, {
      value: ctx.vAt(ctx.node(0)) - ctx.vAt(ctx.node(1)), unit: 'V',
    });
  }
}

class Probe extends Component {
  constructor(x, y, params) { super('P', x, y, params); }
  describe() { return '探针'; }
  commit(ctx) {
    const value = ctx.vAt(ctx.node(0));
    ctx.readings.set(this.id, { value, unit: 'V' });
    const d = ctx.probes.get(this.id);
    if (!d) return;
    d.xs.push(ctx.t);
    d.ys.push(value);
  }
}

const COMPONENT_CLASSES = {
  R: Resistor,
  C: Capacitor,
  L: Inductor,
  V: DCSource,
  VS: SineSource,
  I: CurrentSource,
  CLK: ClockSource,
  IMP: SignalSource,
  STEP: SignalSource,
  RAMP: SignalSource,
  PARABOLA: SignalSource,
  D: Diode,
  NOT: LogicGate,
  AND: LogicGate,
  NAND: LogicGate,
  OR: LogicGate,
  NOR: LogicGate,
  XOR: LogicGate,
  XNOR: LogicGate,
  TF: TransferFunction,
  GND: Ground,
  A: Ammeter,
  VM: Voltmeter,
  P: Probe,
};

export function createComponent(type, x, y, params) {
  const Cls = COMPONENT_CLASSES[type];
  if (!Cls) throw new Error(`未知元件类型 ${type}`);
  // 逻辑门共用一个类，需要把具体类型透传给构造函数
  if (Cls === LogicGate) return new LogicGate(type, x, y, params);
  if (Cls === SignalSource) return new SignalSource(type, x, y, params);
  return new Cls(x, y, params);
}

const BRANCH_TYPES = new Set(['V', 'VS', 'CLK', 'IMP', 'STEP', 'RAMP', 'PARABOLA', 'A']);

/* ---------------- 网络 ---------------- */

export function newNet() {
  return { id: uid('n'), ports: [], segs: [], junctions: [] };
}

const SIGNAL_SOURCE_TYPES = new Set(['V', 'VS', 'CLK', 'IMP', 'STEP', 'RAMP', 'PARABOLA']);
const SIGNAL_DOMAIN_TYPES = new Set([...SIGNAL_SOURCE_TYPES, 'TF', 'P', 'GND']);

function validPort(byId, key) {
  const [id, i] = String(key).split(':');
  const c = byId.get(id);
  return !!c && Number(i) >= 0 && Number(i) < c.pins;
}

function cleanAnchor(a, byId) {
  if (!a || typeof a !== 'object') return null;
  if (typeof a.port === 'string') return validPort(byId, a.port) ? { port: a.port } : null;
  if (Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))) {
    return { x: Number(a.x), y: Number(a.y) };
  }
  return null;
}

function buildNets(list, components) {
  const byId = new Map(components.map((c) => [c.id, c]));
  const nets = [];
  (Array.isArray(list) ? list : []).forEach((d) => {
    const ports = [];
    (Array.isArray(d.ports) ? d.ports : []).forEach((k) => {
      if (validPort(byId, k) && !ports.includes(k)) ports.push(k);
    });
    const segs = [];
    (Array.isArray(d.segs) ? d.segs : []).forEach((s) => {
      const a = cleanAnchor(s.a, byId);
      const b = cleanAnchor(s.b, byId);
      if (!a || !b) return;
      segs.push({
        id: s.id || uid('w'),
        a,
        b,
        via: (Array.isArray(s.via) ? s.via : []).map((p) => ({ x: num(p.x), y: num(p.y) })),
      });
    });
    const junctions = (Array.isArray(d.junctions) ? d.junctions : [])
      .map((p) => ({ x: num(p.x), y: num(p.y) }));
    if (!ports.length && !segs.length) return;
    nets.push({ id: d.id || uid('n'), ports, segs, junctions });
  });
  return nets;
}

function initSignalSimulation(model, comps, dt, duration, steps, record) {
  const unsupported = comps.filter((component) => !SIGNAL_DOMAIN_TYPES.has(component.type));
  if (unsupported.length) {
    const names = [...new Set(unsupported.map((component) => ELEMENTS[component.type].cn))];
    throw new Error(`检测到传递函数，已切换到信号域；请移除电路元件：${names.join('、')}`);
  }
  const byId = new Map(comps.map((component) => [component.id, component]));
  const nets = (model.nets || []).map((net) => ({
    ...net,
    ports: (net.ports || []).filter((key) => validPort(byId, key)),
  }));
  const netOfPort = new Map();
  nets.forEach((net) => net.ports.forEach((key) => {
    if (!netOfPort.has(key)) netOfPort.set(key, net);
  }));

  let groundNet = null;
  for (const component of comps) {
    if (component.type !== 'GND') continue;
    const net = netOfPort.get(`${component.id}:0`);
    if (!net) throw new Error('信号域接地符号需要连接');
    if (groundNet && groundNet !== net) throw new Error('信号域中的所有 GND 必须连接在一起');
    groundNet = net;
  }
  if (!groundNet) throw new Error('信号域需要一个 GND 作为信号参考');

  const nodeIndex = new Map([[groundNet, 0]]);
  let nodeCount = 1;
  nets.forEach((net) => {
    if (!net.ports.length || nodeIndex.has(net)) return;
    nodeIndex.set(net, nodeCount++);
  });
  const nodesOf = comps.map((component) => {
    const nodes = [];
    for (let pin = 0; pin < component.pins; pin++) {
      const net = netOfPort.get(`${component.id}:${pin}`);
      if (!net || net.ports.length < 2) {
        throw new Error(`${ELEMENTS[component.type].cn} 的所有端子都需要连接`);
      }
      nodes.push(nodeIndex.get(net));
    }
    return nodes;
  });
  const netNode = new Map();
  nets.forEach((net) => {
    const index = nodeIndex.get(net);
    if (index !== undefined) netNode.set(net.id, index);
  });
  const transferConfigs = new Map(
    comps.filter((component) => component.type === 'TF')
      .map((component) => [component.id, transferConfig(component, dt)]),
  );
  const transfers = comps.map((component, index) => ({ component, index }))
    .filter(({ component }) => component.type === 'TF');
  const sources = comps.map((component, index) => ({ component, index }))
    .filter(({ component }) => SIGNAL_SOURCE_TYPES.has(component.type));
  sources.forEach(({ component, index }) => {
    if (nodesOf[index][0] !== 0) {
      throw new Error(`${ELEMENTS[component.type].cn} 的负端需要接 GND`);
    }
  });
  transfers.forEach(({ component, index }) => {
    if (nodesOf[index][1] !== 0 || nodesOf[index][3] !== 0) {
      throw new Error('信号域传递函数的输入 B 和输出 Y− 需要接 GND');
    }
  });

  const probes = new Map((record ? comps.filter((component) => component.type === 'P') : [])
    .map((component, index) => [component.id, {
      id: component.id, name: `探针${index + 1}`, xs: [], ys: [],
    }]));
  return {
    domain: 'signal',
    dt, duration, steps, nodeCount, n: nodeCount - 1,
    comps, byId, netNode, transferConfigs, nodesOf, transfers, sources,
    state: new Map(), readings: new Map(), probes, record,
    flows: new Map(), t: 0, stepIndex: 0, x: null,
  };
}

/* ---------------- 求值（initSimulation / stepSimulation 步进引擎） ----------------
 * 瞬态批量仿真（simulate）和实时模式（rAF 驱动）共用同一套步进引擎：
 *   initSimulation：校验、节点编号、矩阵/状态分配，返回 sim；
 *   stepSimulation：推进一个 dt，写入 sim.x / sim.flows / sim.readings / sim.probes。
 */

export function initSimulation(model, opts = {}) {
  const record = opts.record !== false; // 实时模式关闭探针记录，避免数组无限增长
  const skipStepCap = opts.skipStepCap === true; // 实时模式不受 400000 步上限约束
  const comps = (model.components || []).filter((c) => c instanceof Component && ELEMENTS[c.type]);
  if (!comps.length) throw new Error('画布是空的');
  if (!comps.some((c) => c.type === 'GND')) throw new Error('电路缺少接地（GND）');

  const dt = Math.max(1e-9, Number(model.dt) || 1e-5);
  const duration = Math.max(dt, Number(model.duration) || 0.01);
  const steps = Math.round(duration / dt);
  if (!skipStepCap && steps > 400000) throw new Error('步数过多，请增大步长或缩短时长');
  if (comps.some((component) => component.type === 'TF')) {
    return initSignalSimulation(model, comps, dt, duration, steps, record);
  }
  const transferConfigs = new Map(
    comps.filter((component) => component.type === 'TF')
      .map((component) => [component.id, transferConfig(component, dt)]),
  );

  const byId = new Map(comps.map((c) => [c.id, c]));
  // 只保留指向现有元件的端子
  const nets = (model.nets || []).map((net) => ({
    ...net,
    ports: (net.ports || []).filter((k) => validPort(byId, k)),
  }));

  const netOfPort = new Map();
  nets.forEach((net) => net.ports.forEach((k) => {
    if (!netOfPort.has(k)) netOfPort.set(k, net);
  }));

  // 接地网络
  let groundNet = null;
  for (const c of comps) {
    if (c.type !== 'GND') continue;
    const net = netOfPort.get(`${c.id}:0`);
    if (!net) throw new Error('接地符号需要连线');
    if (!groundNet) groundNet = net;
    else if (groundNet !== net) throw new Error('多个接地符号没有连在一起');
  }

  // 节点编号：接地网络为 0
  const nodeIndex = new Map([[groundNet, 0]]);
  let nodeCount = 1;
  nets.forEach((net) => {
    if (!net.ports.length || nodeIndex.has(net)) return;
    nodeIndex.set(net, nodeCount++);
  });

  // 每个元件各端子的节点号，同时校验未接线的端子。
  // 引脚坐标全部落在整数格点上，连通关系只由网络(Net)决定，
  // 因此这里用与 comps 等长的数组代替 Map，省掉每步的字符串键查找。
  const nodesOf = [];
  comps.forEach((c) => {
    const def = ELEMENTS[c.type];
    const arr = [];
    for (let i = 0; i < def.pins; i++) {
      const net = netOfPort.get(`${c.id}:${i}`);
      if (!net || net.ports.length < 2) {
        throw new Error(def.pins === 2 ? `${def.cn} 的两个端子都需要连线` : `${def.cn} 的端子需要连线`);
      }
      arr.push(nodeIndex.get(net) ?? 0);
    }
    nodesOf.push(arr);
  });

  const branchEls = comps.filter((c) => BRANCH_TYPES.has(c.type));
  const branchRow = new Map(branchEls.map((c, i) => [c.id, i]));
  const n = nodeCount - 1;
  const m = branchEls.length;
  const size = n + m;
  // 每个元件的支路行号预先算好，时间循环里不再查 Map
  const rowOf = comps.map((c) => (branchRow.has(c.id) ? n + branchRow.get(c.id) : -1));
  const logicGates = comps
    .map((component, index) => ({ component, index }))
    .filter(({ component }) => component instanceof LogicGate);

  const state = new Map();
  const readings = new Map();
  const probeList = comps.filter((c) => c.type === 'P');
  // 实时模式（record=false）传空 Map，Probe.commit 找不到目标即跳过，避免内存无限增长
  const probes = new Map((record ? probeList : []).map((c, i) => [c.id, {
    id: c.id, name: `探针${i + 1}`, xs: [], ys: [],
  }]));

  // Net id → 节点号，实时模式给导线按电位着色用
  const netNode = new Map();
  nets.forEach((net) => {
    const idx = nodeIndex.get(net);
    if (idx !== undefined) netNode.set(net.id, idx);
  });

  const G_MIN = 1e-12;

  // 矩阵、右端项与 stamp 闭包都在循环外创建，循环内只做复位，
  // 避免几十万步 × n² 规模的重复分配触发 GC 卡顿
  const A = zeros(size);
  const z = zeros(size, true);
  const stampG = (i, j, g) => {
    if (i > 0) A[i - 1][i - 1] += g;
    if (j > 0) A[j - 1][j - 1] += g;
    if (i > 0 && j > 0) {
      A[i - 1][j - 1] -= g;
      A[j - 1][i - 1] -= g;
    }
  };
  const stampI = (i, j, cur) => {
    if (i > 0) z[i - 1] -= cur;
    if (j > 0) z[j - 1] += cur;
  };
  const stampVCCS = (p, q, cp, cq, gain) => {
    if (p > 0 && cp > 0) A[p - 1][cp - 1] += gain;
    if (p > 0 && cq > 0) A[p - 1][cq - 1] -= gain;
    if (q > 0 && cp > 0) A[q - 1][cp - 1] -= gain;
    if (q > 0 && cq > 0) A[q - 1][cq - 1] += gain;
  };
  const stampV = (p, q, value, row) => {
    if (p > 0) {
      A[row][p - 1] += 1;
      A[p - 1][row] += 1;
    }
    if (q > 0) {
      A[row][q - 1] -= 1;
      A[q - 1][row] -= 1;
    }
    z[row] += value;
  };
  const resetLinear = () => {
    for (let i = 0; i < size; i++) {
      const r = A[i];
      for (let j = 0; j < size; j++) r[j] = 0;
      z[i] = 0;
    }
  };

  const sim = {
    dt, duration, steps, nodeCount, n,
    comps, byId, netNode, transferConfigs,
    nodesOf, rowOf, logicGates,
    state, readings, probes, record,
    A, z, G_MIN,
    stampG, stampI, stampV, stampVCCS, resetLinear,
    t: 0,
    stepIndex: 0,
    x: null,
    flows: new Map(), // 元件 id → pin0→pin1 支路电流（实时动画用）
  };
  return sim;
}

// 推进一个 dt。矩阵/右端项会被 solve() 原地消元，因此每步重新 stamp。
// 用 MNA 联立节点 KCL 与支路 KVL；二极管工作点和逻辑输出迭代至收敛后再提交状态。
export function stepSimulation(sim) {
  if (sim.domain === 'signal') return stepSignalSimulation(sim);
  const step = sim.stepIndex;
  const {
    dt, nodeCount, n, comps, nodesOf, rowOf, logicGates, state, readings, probes,
    transferConfigs,
    A, resetLinear, G_MIN, stampG, stampI, stampV, stampVCCS,
  } = sim;
  const t = step * dt;
  let x = null;
  let settled = false;
  const maxIterations = Math.max(64, logicGates.length + 1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    resetLinear();

    // 每个节点到地加极小电导，避免悬空节点导致矩阵奇异
    for (let i = 1; i < nodeCount; i++) A[i - 1][i - 1] += G_MIN;

    for (let ci = 0; ci < comps.length; ci++) {
      const nodes = nodesOf[ci];
      comps[ci].stamp({
        dt, t, n, state, readings, probes, transferConfigs,
        stampG, stampI, stampV, stampVCCS,
        node: (i) => nodes[i],
        row: rowOf[ci],
      });
    }

    x = solve(A, sim.z);
    if (!x) throw new Error('矩阵奇异：检查是否有悬空节点或缺少接地');
    const vAt = (node) => (node === 0 ? 0 : x[node - 1]);
    let changed = false;
    for (const { component, index } of logicGates) {
      const output = component.nextOutput(vAt, nodesOf[index]);
      if (state.get(component.id)?.output !== output) {
        state.set(component.id, { output });
        changed = true;
      }
    }
    for (let ci = 0; ci < comps.length; ci++) {
      const component = comps[ci];
      if (!(component instanceof Diode)) continue;
      const nodes = nodesOf[ci];
      const voltage = vAt(nodes[0]) - vAt(nodes[1]);
      const estimate = state.get(component.id)?.vd ?? 0;
      const error = voltage - estimate;
      if (Math.abs(error) <= 1e-6) continue;
      const limit = Math.max(0.2, Math.abs(estimate) * 0.25);
      state.set(component.id, {
        vd: estimate + Math.max(-limit, Math.min(limit, error)),
      });
      changed = true;
    }
    if (!changed) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    throw new Error('非线性电路未收敛：检查二极管偏置或数字逻辑反馈');
  }
  const vAt = (node) => (node === 0 ? 0 : x[node - 1]);

  // flow 必须在 commit 之前算：电容/电感/二极管的 commit 会覆盖其内部历史状态
  sim.flows.clear();
  for (let ci = 0; ci < comps.length; ci++) {
    const nodes = nodesOf[ci];
    const ctx = {
      dt, t, n, x, vAt, state, readings, probes, transferConfigs,
      node: (i) => nodes[i],
      row: rowOf[ci],
    };
    const f = comps[ci].flow(ctx);
    if (Number.isFinite(f) && f !== null) sim.flows.set(comps[ci].id, f);
    comps[ci].commit(ctx);
  }

  sim.t = t;
  sim.x = x;
  sim.stepIndex = step + 1;
  return { t, x, domain: 'circuit' };
}

function stepSignalSimulation(sim) {
  const t = sim.stepIndex * sim.dt;
  const values = Array(sim.nodeCount).fill(Number.NaN);
  values[0] = 0;
  const setNode = (node, value, name) => {
    if (!Number.isFinite(value)) throw new Error(`${name} 产生了无效信号`);
    if (Number.isFinite(values[node]) && Math.abs(values[node] - value) > 1e-8) {
      throw new Error(`信号节点存在多个不同输出，检查 ${name} 的连线`);
    }
    values[node] = value;
  };
  sim.sources.forEach(({ component, index }) => {
    const nodes = sim.nodesOf[index];
    setNode(nodes[1], voltageSourceValue(component, t, sim.dt), ELEMENTS[component.type].cn);
  });

  const pending = new Set(sim.transfers);
  const nextStates = new Map();
  let progressed = true;
  while (pending.size && progressed) {
    progressed = false;
    for (const entry of pending) {
      const { component, index } = entry;
      const nodes = sim.nodesOf[index];
      if (!Number.isFinite(values[nodes[0]])) continue;
      const input = values[nodes[0]] - values[nodes[1]];
      const previous = sim.state.get(component.id) || { x: [], inputs: [] };
      const config = sim.transferConfigs.get(component.id);
      const affine = transferAffine(config, previous);
      setNode(nodes[2], affine.gain * input + affine.offset, ELEMENTS.TF.cn);
      nextStates.set(component.id, advanceTransfer(config, previous, input));
      pending.delete(entry);
      progressed = true;
    }
  }
  if (pending.size) {
    throw new Error('信号流存在反馈环或无驱动输入；当前传递函数模式仅支持前向信号链');
  }

  sim.state = nextStates;
  sim.readings.clear();
  for (let ci = 0; ci < sim.comps.length; ci++) {
    const component = sim.comps[ci];
    if (component.type !== 'P' && component.type !== 'TF') continue;
    const nodes = sim.nodesOf[ci];
    const value = component.type === 'P'
      ? values[nodes[0]]
      : values[nodes[2]] - values[nodes[3]];
    if (!Number.isFinite(value)) {
      throw new Error('探针或传递函数输出没有连接到有效信号');
    }
    sim.readings.set(component.id, { value, unit: 'V' });
    const probe = sim.probes.get(component.id);
    if (probe) {
      probe.xs.push(t);
      probe.ys.push(value);
    }
  }
  sim.t = t;
  sim.x = values.slice(1);
  sim.stepIndex++;
  return { t, x: sim.x, domain: 'signal' };
}

// 取某个 Net 的电位（接地网为 0）；sim 未求解或 Net 无节点时返回 null
export function netVoltage(sim, netId) {
  const idx = sim?.netNode?.get(netId);
  if (idx == null || !sim?.x) return null;
  return idx === 0 ? 0 : sim.x[idx - 1];
}

export function simulate(model) {
  const sim = initSimulation(model);
  while (sim.stepIndex <= sim.steps) stepSimulation(sim);
  return {
    domain: sim.domain || 'circuit',
    duration: sim.duration,
    dt: sim.dt,
    readings: sim.readings,
    probes: [...sim.probes.values()].filter((p) => p.ys.length > 0),
  };
}

function zeros(size, vector = false) {
  if (vector) return new Array(size).fill(0);
  return Array.from({ length: size }, () => new Array(size).fill(0));
}

// 原地高斯消元（部分主元）：直接消解 A 与 z，不做矩阵拷贝。
// A/z 在每次 stamp 前都会被 resetLinear 复位，因此破坏式求解是安全的。
function solve(A, z) {
  const n = z.length;
  if (n === 0) return [];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    if (piv !== col) {
      const tmpRow = A[piv]; A[piv] = A[col]; A[col] = tmpRow;
      const tmpZ = z[piv]; z[piv] = z[col]; z[col] = tmpZ;
    }
    const pv = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      z[r] -= f * z[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

/* ---------------- 序列化 (.ckt v2) ---------------- */

export function serialize(model) {
  return {
    version: 3,
    duration: model.duration,
    dt: model.dt,
    components: (model.components || []).map((c) => ({
      id: c.id, type: c.type, x: c.x, y: c.y, rot: c.rot || 0, params: { ...c.params },
    })),
    nets: (model.nets || []).map((net) => ({
      id: net.id,
      ports: [...net.ports],
      segs: net.segs.map((s) => ({ id: s.id, a: s.a, b: s.b, via: s.via || [] })),
      junctions: (net.junctions || []).map((p) => ({ x: p.x, y: p.y })),
    })),
    signalGraph: {
      blocks: (model.signalGraph?.blocks || []).map((block) => ({
        id: block.id,
        type: block.type,
        x: block.x,
        y: block.y,
        params: { ...(block.params || {}) },
        signs: Array.isArray(block.signs) ? block.signs.slice(0, 8) : undefined,
      })),
      wires: (model.signalGraph?.wires || []).map((wire) => ({
        id: wire.id,
        from: { block: wire.from.block, port: wire.from.port },
        to: { block: wire.to.block, port: wire.to.port },
      })),
    },
  };
}

const SIGNAL_BLOCK_TYPES = new Set(['IMP', 'STEP', 'RAMP', 'PARABOLA', 'TF', 'SUM', 'P', 'SOURCE', 'PICKOFF', 'PROBE']);

function signalInputCount(block) {
  if (block.type === 'TF' || block.type === 'P' || block.type === 'PROBE' || block.type === 'PICKOFF') return 1;
  if (block.type === 'SUM') return Math.max(2, Math.min(8, block.signs?.length || 2));
  if (block.type === 'SOURCE' || block.type === 'IMP' || block.type === 'STEP' || block.type === 'RAMP' || block.type === 'PARABOLA') return 0;
  return 0;
}

function buildSignalGraph(data) {
  const blocks = [];
  const seen = new Set();
  (Array.isArray(data?.blocks) ? data.blocks : []).forEach((item) => {
    if (!item || !SIGNAL_BLOCK_TYPES.has(item.type)) return;
    const id = item.id ? String(item.id) : uid('s');
    if (seen.has(id)) return;
    seen.add(id);
    const params = {};
    const definitions = ELEMENTS[item.type]?.params || [];
    definitions.forEach((definition) => {
      const value = item.params?.[definition.key];
      params[definition.key] = definition.type === 'text'
        ? String(value ?? definition.def)
        : (Number.isFinite(Number(value)) ? Number(value) : definition.def);
    });
    const signs = item.type === 'SUM'
      ? Array.from({ length: Math.max(2, Math.min(8, item.signs?.length || 2)) }, (_, i) => (
        item.signs?.[i] === -1 ? -1 : 1
      ))
      : [];
    blocks.push({
      id,
      type: item.type,
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
      params,
      signs,
    });
  });
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const wires = [];
  const usedInputs = new Set();
  (Array.isArray(data?.wires) ? data.wires : []).forEach((item) => {
    const source = byId.get(String(item?.from?.block || ''));
    const target = byId.get(String(item?.to?.block || ''));
    const fromPort = item?.from?.port;
    const toPort = item?.to?.port;
    if (!source || !target || fromPort !== 'out'
      || !/^in[0-7]$/.test(String(toPort))
      || Number(String(toPort).slice(2)) >= signalInputCount(target)) return;
    const inputKey = `${target.id}:${toPort}`;
    if (usedInputs.has(inputKey)) return;
    usedInputs.add(inputKey);
    wires.push({
      id: item.id ? String(item.id) : uid('sw'),
      from: { block: source.id, port: 'out' },
      to: { block: target.id, port: toPort },
    });
  });
  return { blocks, wires };
}

export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('文件格式不正确');
  const duration = Number(data.duration) || 0.01;
  const dt = Number(data.dt) || 1e-5;

  if (Array.isArray(data.components)) {
    const components = [];
    const seen = new Set();
    data.components.forEach((d) => {
      if (!ELEMENTS[d.type]) return;
      const c = createComponent(d.type, d.x, d.y, d.params);
      if (d.id && !seen.has(String(d.id))) c.id = String(d.id);
      if (seen.has(c.id)) return;
      c.rot = normalizeRot(d.rot);
      seen.add(c.id);
      components.push(c);
    });
    return {
      duration,
      dt,
      components,
      nets: buildNets(data.nets, components),
      signalGraph: buildSignalGraph(data.signalGraph),
    };
  }

  return migrateV1(data, duration, dt);
}

// 旧版（elements + wires）只读迁移：用并查集把端子分组成网络
function migrateV1(data, duration, dt) {
  const components = [];
  const byId = new Map();
  (Array.isArray(data.elements) ? data.elements : []).forEach((d) => {
    if (!ELEMENTS[d.type] || byId.has(d.id)) return;
    const c = createComponent(d.type, d.x, d.y, d.params);
    if (d.id) c.id = String(d.id);
    c.rot = normalizeRot(d.rot);
    byId.set(c.id, c);
    components.push(c);
  });

  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) { const nx = parent.get(k); parent.set(k, r); k = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  components.forEach((c) => {
    for (let i = 0; i < c.pins; i++) parent.set(`${c.id}:${i}`, `${c.id}:${i}`);
  });

  const wires = (Array.isArray(data.wires) ? data.wires : [])
    .filter((w) => byId.has(w.a?.[0]) && byId.has(w.b?.[0]))
    .map((w) => ({ id: w.id || uid('w'), a: `${w.a[0]}:${w.a[1]}`, b: `${w.b[0]}:${w.b[1]}` }))
    .filter((w) => parent.has(w.a) && parent.has(w.b));

  wires.forEach((w) => union(w.a, w.b));

  const groups = new Map();
  [...parent.keys()].forEach((k) => {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  });

  const netFor = new Map();
  const nets = [];
  groups.forEach((ports) => {
    if (ports.length < 2) return;
    const net = { id: uid('n'), ports, segs: [], junctions: [] };
    nets.push(net);
    ports.forEach((p) => netFor.set(p, net));
  });
  wires.forEach((w) => {
    const net = netFor.get(w.a);
    if (!net) return;
    net.segs.push({ id: w.id, a: { port: w.a }, b: { port: w.b }, via: [] });
  });

  return { duration, dt, components, nets, signalGraph: buildSignalGraph(data.signalGraph) };
}

/* ---------------- 新电路：默认空白 ---------------- */

export function defaultCircuit() {
  return {
    duration: 0.05, dt: 0.00001, components: [], nets: [],
    signalGraph: { blocks: [], wires: [] },
  };
}