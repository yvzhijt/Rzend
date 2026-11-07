import { ELEMENTS, createComponent, normalizeRot, uid, validPort } from './model.js';

function cleanAnchor(anchor, byId) {
  if (!anchor || typeof anchor !== 'object') return null;
  if (typeof anchor.port === 'string') {
    return validPort(byId, anchor.port) ? { port: anchor.port } : null;
  }
  if (Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.y))) {
    return { x: Number(anchor.x), y: Number(anchor.y) };
  }
  return null;
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildNets(list, components) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const nets = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const ports = [];
    (Array.isArray(item.ports) ? item.ports : []).forEach((key) => {
      if (validPort(byId, key) && !ports.includes(key)) ports.push(key);
    });
    const segs = [];
    (Array.isArray(item.segs) ? item.segs : []).forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      const a = cleanAnchor(segment.a, byId);
      const b = cleanAnchor(segment.b, byId);
      if (!a || !b) return;
      segs.push({
        id: segment.id || uid('w'),
        a,
        b,
        via: (Array.isArray(segment.via) ? segment.via : [])
          .map((point) => ({ x: finiteOrZero(point?.x), y: finiteOrZero(point?.y) })),
      });
    });
    const junctions = (Array.isArray(item.junctions) ? item.junctions : [])
      .map((point) => ({ x: finiteOrZero(point?.x), y: finiteOrZero(point?.y) }));
    if (ports.length || segs.length) {
      nets.push({ id: item.id || uid('n'), ports, segs, junctions });
    }
  });
  return nets;
}

export function serializeCircuit(model) {
  return {
    version: 4,
    duration: model.duration,
    dt: model.dt,
    components: (model.components || []).map((component) => ({
      id: component.id,
      type: component.type,
      x: component.x,
      y: component.y,
      rot: component.rot || 0,
      params: { ...component.params },
    })),
    nets: (model.nets || []).map((net) => ({
      id: net.id,
      ports: [...net.ports],
      segs: net.segs.map((segment) => ({
        id: segment.id,
        a: segment.a,
        b: segment.b,
        via: segment.via || [],
      })),
      junctions: (net.junctions || []).map(({ x, y }) => ({ x, y })),
    })),
  };
}

export function deserializeCircuit(data) {
  if (!data || typeof data !== 'object') throw new Error('文件格式不正确');
  const duration = Number(data.duration) || 0.01;
  const dt = Number(data.dt) || 1e-5;
  if (!Array.isArray(data.components)) return migrateV1(data, duration, dt);

  const components = [];
  const seen = new Set();
  data.components.forEach((item) => {
    if (!item || !ELEMENTS[item.type]) return;
    const component = createComponent(item.type, item.x, item.y, item.params);
    if (item.id && !seen.has(String(item.id))) component.id = String(item.id);
    if (seen.has(component.id)) return;
    component.rot = normalizeRot(item.rot);
    seen.add(component.id);
    components.push(component);
  });
  return {
    duration,
    dt,
    components,
    nets: buildNets(data.nets, components),
  };
}

function migrateV1(data, duration, dt) {
  const components = [];
  const byId = new Map();
  (Array.isArray(data.elements) ? data.elements : []).forEach((item) => {
    if (!item || !ELEMENTS[item.type] || byId.has(item.id)) return;
    const component = createComponent(item.type, item.x, item.y, item.params);
    if (item.id) component.id = String(item.id);
    component.rot = normalizeRot(item.rot);
    byId.set(component.id, component);
    components.push(component);
  });

  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== root) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  components.forEach((component) => {
    for (let index = 0; index < component.pins; index++) {
      const key = `${component.id}:${index}`;
      parent.set(key, key);
    }
  });

  const wires = (Array.isArray(data.wires) ? data.wires : [])
    .filter((wire) => wire && byId.has(wire.a?.[0]) && byId.has(wire.b?.[0]))
    .map((wire) => ({
      id: wire.id || uid('w'),
      a: `${wire.a[0]}:${wire.a[1]}`,
      b: `${wire.b[0]}:${wire.b[1]}`,
    }))
    .filter((wire) => parent.has(wire.a) && parent.has(wire.b));
  wires.forEach((wire) => union(wire.a, wire.b));

  const groups = new Map();
  [...parent.keys()].forEach((key) => {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(key);
  });

  const netFor = new Map();
  const nets = [];
  groups.forEach((ports) => {
    if (ports.length < 2) return;
    const net = { id: uid('n'), ports, segs: [], junctions: [] };
    nets.push(net);
    ports.forEach((port) => netFor.set(port, net));
  });
  wires.forEach((wire) => {
    const net = netFor.get(wire.a);
    if (net) net.segs.push({
      id: wire.id,
      a: { port: wire.a },
      b: { port: wire.b },
      via: [],
    });
  });

  return { duration, dt, components, nets };
}

export function defaultCircuit() {
  return { duration: 0.05, dt: 0.00001, components: [], nets: [] };
}
