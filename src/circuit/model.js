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
  GND: { cn: '接地', en: 'Ground', group: '电源', pins: 1, color: '#44515c', params: [] },
  A: { cn: '电流表', en: 'Ammeter', group: '测量', pins: 2, color: '#7e2f8e', params: [], meter: 'A' },
  VM: { cn: '电压表', en: 'Voltmeter', group: '测量', pins: 2, color: '#7e2f8e', params: [], meter: 'V' },
  P: { cn: '示波器探针', en: 'Scope Probe', group: '测量', pins: 1, color: '#77ac30', params: [], probe: true },
};

export const W = 120;
export const H = 48;

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
    (def.params || []).forEach((p) => { this.params[p.key] = p.def; });
    if (params) {
      Object.keys(this.params).forEach((k) => {
        if (params[k] != null) this.params[k] = Number(params[k]);
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
}

class Resistor extends Component {
  constructor(x, y, params) { super('R', x, y, params); }
  describe() { return `${fmt(this.params.r)}Ω`; }
  stamp(ctx) {
    const g = 1 / Math.max(1e-9, Math.abs(num(this.params.r)) || 1e-9);
    ctx.stampG(ctx.node(0), ctx.node(1), g);
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
}

class DCSource extends Component {
  constructor(x, y, params) { super('V', x, y, params); }
  describe() { return `${fmt(this.params.v)}V`; }
  stamp(ctx) {
    // pin1 为正极，pin0 为负极
    ctx.stampV(ctx.node(1), ctx.node(0), num(this.params.v), ctx.row);
  }
}

class SineSource extends Component {
  constructor(x, y, params) { super('VS', x, y, params); }
  describe() { return `${fmt(this.params.amp)}V ${fmt(this.params.freq)}Hz`; }
  stamp(ctx) {
    const w = 2 * Math.PI * num(this.params.freq);
    const v = num(this.params.amp) * Math.sin(w * ctx.t + num(this.params.phase));
    ctx.stampV(ctx.node(1), ctx.node(0), v, ctx.row);
  }
}

class CurrentSource extends Component {
  constructor(x, y, params) { super('I', x, y, params); }
  describe() { return `${fmt(this.params.i)}A`; }
  stamp(ctx) { ctx.stampI(ctx.node(0), ctx.node(1), num(this.params.i)); }
}

class Ground extends Component {
  constructor(x, y, params) { super('GND', x, y, params); }
}

class Ammeter extends Component {
  constructor(x, y, params) { super('A', x, y, params); }
  // 理想电流表：0V 电压源，支路电流即读数
  stamp(ctx) { ctx.stampV(ctx.node(0), ctx.node(1), 0, ctx.row); }
  commit(ctx) { ctx.readings.set(this.id, { value: ctx.x[ctx.row], unit: 'A' }); }
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
  commit(ctx) {
    const d = ctx.probes.get(this.id);
    if (!d) return;
    d.xs.push(ctx.t);
    d.ys.push(ctx.vAt(ctx.node(0)));
  }
}

const COMPONENT_CLASSES = {
  R: Resistor,
  C: Capacitor,
  L: Inductor,
  V: DCSource,
  VS: SineSource,
  I: CurrentSource,
  GND: Ground,
  A: Ammeter,
  VM: Voltmeter,
  P: Probe,
};

export function createComponent(type, x, y, params) {
  const Cls = COMPONENT_CLASSES[type];
  if (!Cls) throw new Error(`未知元件类型 ${type}`);
  return new Cls(x, y, params);
}

const BRANCH_TYPES = new Set(['V', 'VS', 'A']);

/* ---------------- 网络 ---------------- */

export function newNet() {
  return { id: uid('n'), ports: [], segs: [], junctions: [] };
}

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

/* ---------------- 求值 ---------------- */

export function simulate(model) {
  const comps = (model.components || []).filter((c) => c instanceof Component && ELEMENTS[c.type]);
  if (!comps.length) throw new Error('画布是空的');
  if (!comps.some((c) => c.type === 'GND')) throw new Error('电路缺少接地（GND）');

  const dt = Math.max(1e-9, Number(model.dt) || 1e-5);
  const duration = Math.max(dt, Number(model.duration) || 0.01);
  const steps = Math.round(duration / dt);
  if (steps > 400000) throw new Error('步数过多，请增大步长或缩短时长');

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

  const state = new Map();
  const readings = new Map();
  const probeList = comps.filter((c) => c.type === 'P');
  const probes = new Map(probeList.map((c, i) => [c.id, {
    id: c.id, name: `探针${i + 1}`, xs: [], ys: [],
  }]));

  const G_MIN = 1e-12;

  for (let step = 0; step <= steps; step++) {
    const t = step * dt;
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

    // 每个节点到地加极小电导，避免悬空节点导致矩阵奇异
    for (let i = 1; i < nodeCount; i++) A[i - 1][i - 1] += G_MIN;

    for (let ci = 0; ci < comps.length; ci++) {
      const nodes = nodesOf[ci];
      comps[ci].stamp({
        dt, t, n, state, readings, probes,
        stampG, stampI, stampV,
        node: (i) => nodes[i],
        row: rowOf[ci],
      });
    }

    const x = solve(A, z);
    if (!x) throw new Error('矩阵奇异：检查是否有悬空节点或缺少接地');
    const vAt = (node) => (node === 0 ? 0 : x[node - 1]);

    for (let ci = 0; ci < comps.length; ci++) {
      const nodes = nodesOf[ci];
      comps[ci].commit({
        dt, t, n, x, vAt, state, readings, probes,
        node: (i) => nodes[i],
        row: rowOf[ci],
      });
    }
  }

  return {
    duration,
    dt,
    readings,
    probes: [...probes.values()].filter((p) => p.ys.length > 0),
  };
}

function zeros(size, vector = false) {
  if (vector) return new Array(size).fill(0);
  return Array.from({ length: size }, () => new Array(size).fill(0));
}

function solve(A, z) {
  const n = z.length;
  if (n === 0) return [];
  const M = A.map((row, i) => row.concat(z[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) [M[piv], M[col]] = [M[col], M[piv]];
    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

/* ---------------- 序列化 (.ckt v2) ---------------- */

export function serialize(model) {
  return {
    version: 2,
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
  };
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
    return { duration, dt, components, nets: buildNets(data.nets, components) };
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

  return { duration, dt, components, nets };
}

/* ---------------- 新电路：默认空白 ---------------- */

export function defaultCircuit() {
  return { duration: 0.05, dt: 0.00001, components: [], nets: [] };
}
