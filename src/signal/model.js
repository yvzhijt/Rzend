let sequence = Date.now() % 100000;

export function uid(prefix = 's') {
  sequence += 1;
  return `${prefix}${sequence.toString(36)}`;
}

const GRID = 12;
const GRID_OFFSET = 6;
const BLOCK_TYPES = new Set(['SOURCE', 'TF', 'SUM', 'PICKOFF', 'PROBE', 'SAMPLER', 'ZOH']);

export function snapGrid(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return GRID_OFFSET;
  return GRID_OFFSET + Math.round((number - GRID_OFFSET) / GRID) * GRID;
}

export function snapPoint(p) {
  return { x: snapGrid(p?.x), y: snapGrid(p?.y) };
}

export function createSignalGraph() {
  return { blocks: [], wires: [] };
}

export function serializeSignalGraph(model) {
  return {
    version: 1,
    blocks: (model.blocks || []).map((block) => ({
      id: block.id,
      type: block.type,
      x: block.x,
      y: block.y,
      rot: block.rot || 0,
      params: { ...(block.params || {}) },
      signs: block.type === 'SUM' && Array.isArray(block.signs) ? block.signs.slice(0, 8) : undefined,
    })),
    wires: (model.wires || []).map((wire) => ({
      id: wire.id,
      from: { block: wire.from.block, port: wire.from.port },
      to: { block: wire.to.block, port: wire.to.port },
      via: Array.isArray(wire.via) ? wire.via.map((p) => ({ x: p.x, y: p.y })) : [],
    })),
  };
}

function inputCount(block) {
  if (block.type === 'SUM') return block.signs.length;
  if (['TF', 'PICKOFF', 'PROBE', 'SAMPLER', 'ZOH'].includes(block.type)) return 1;
  return 0;
}

export function deserializeSignalGraph(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('信号流图文件格式不正确');
  }
  const blocks = [];
  const seenIds = new Set();
  (Array.isArray(data.blocks) ? data.blocks : []).forEach((item) => {
    if (!item || !BLOCK_TYPES.has(item.type)) return;
    let id = item.id ? String(item.id) : uid();
    while (seenIds.has(id)) id = uid();
    seenIds.add(id);
    const rawSigns = Array.isArray(item.signs) ? item.signs : [];
    const signs = item.type === 'SUM'
      ? Array.from({ length: Math.max(2, Math.min(8, rawSigns.length || 2)) }, (_, index) => (
        rawSigns[index] === -1 ? -1 : 1
      ))
      : [];
    const params = item.params && typeof item.params === 'object' && !Array.isArray(item.params)
      ? { ...item.params }
      : {};
    if (item.type === 'TF') {
      params.num = String(params.num ?? '1');
      params.den = String(params.den ?? 's + 1');
    }
    if (item.type === 'SOURCE') {
      if (!['impulse', 'step', 'ramp', 'para'].includes(params.sig)) params.sig = 'step';
    }
    blocks.push({
      id,
      type: item.type,
      x: Number.isFinite(item.x) ? item.x : 0,
      y: Number.isFinite(item.y) ? item.y : 0,
      rot: [0, 90, 180, 270].includes(item.rot) ? item.rot : 0,
      params,
      signs,
    });
  });

  /* 旧文件中的示波器没有编号名称，按现有编号顺延补齐 */
  const probeNames = new Set(
    blocks.filter((b) => b.type === 'PROBE')
      .map((b) => b.params?.name)
      .filter((name) => /^示波器\d+$/.test(name || '')),
  );
  let probeSeq = 1;
  blocks.forEach((b) => {
    if (b.type !== 'PROBE') return;
    if (/^示波器\d+$/.test(b.params?.name || '')) return;
    b.params = b.params || {};
    let name;
    do {
      name = `示波器${probeSeq++}`;
    } while (probeNames.has(name));
    probeNames.add(name);
    b.params.name = name;
  });

  const byId = new Map(blocks.map((block) => [block.id, block]));
  const wires = [];
  const usedInputs = new Set();
  const wireIds = new Set();
  (Array.isArray(data.wires) ? data.wires : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const source = byId.get(String(item.from?.block ?? ''));
    const target = byId.get(String(item.to?.block ?? ''));
    const fromPort = item.from?.port || 'out';
    const toPort = item.to?.port || 'in0';
    const match = /^in([0-7])$/.exec(toPort);
    if (!source || source.type === 'PROBE' || !target || fromPort !== 'out'
      || !match || Number(match[1]) >= inputCount(target)) return;
    const inputKey = `${target.id}:${toPort}`;
    if (usedInputs.has(inputKey)) return;
    usedInputs.add(inputKey);
    let id = item.id ? String(item.id) : uid('sw');
    while (wireIds.has(id)) id = uid('sw');
    wireIds.add(id);
    const via = Array.isArray(item.via)
      ? item.via.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: p.x, y: p.y }))
      : [];
    wires.push({
      id,
      from: { block: source.id, port: 'out' },
      to: { block: target.id, port: toPort },
      via,
    });
  });
  return { blocks, wires };
}
