/* 信号流图分析：在 s 域多项式分数上应用梅森公式，
 * 求信号源到每个示波器（PROBE）的闭环传递函数 T(s) = N(s)/D(s)。
 * 连线完毕后传递函数唯一确定，结果供时域仿真直接使用。 */

/* ---------------- s 域多项式（系数数组，下标 = 幂次） ---------------- */

function pt(p) {
  let i = p.length - 1;
  while (i > 0 && Math.abs(p[i]) < 1e-12) i--;
  return p.slice(0, i + 1);
}

function padd(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return pt(out);
}

function pneg(a) {
  return a.map((c) => -c);
}

function psub(a, b) {
  return padd(a, pneg(b));
}

function pmul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return pt(out);
}

function ppow(a, k) {
  let out = [1];
  for (let i = 0; i < k; i++) out = pmul(out, a);
  return out;
}

function fmtC(c) {
  const r = Math.round(c * 1e6) / 1e6;
  return String(r);
}

export function polyToString(p) {
  const q = pt(p);
  const terms = [];
  for (let k = q.length - 1; k >= 0; k--) {
    const c = q[k];
    if (Math.abs(c) < 1e-12) continue;
    const abs = Math.abs(c);
    const coef = abs === 1 && k > 0 ? '' : fmtC(abs);
    const varPart = k === 0 ? '' : k === 1 ? 's' : `s^${k}`;
    terms.push({ neg: c < 0, text: `${coef}${varPart}` });
  }
  if (!terms.length) return '0';
  let out = terms[0].neg ? `-${terms[0].text}` : terms[0].text;
  for (let i = 1; i < terms.length; i++) {
    out += terms[i].neg ? ` - ${terms[i].text}` : ` + ${terms[i].text}`;
  }
  return out;
}

/* 解析 s 域表达式（如 "s + 1"、"2*s^2 + 3"，支持隐式乘法 "2s(s+1)"） */
export function parsePoly(expr) {
  const tokens = tokenizePoly(String(expr ?? '0').trim() || '0');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? padd(v, r) : psub(v, r);
    }
    return v;
  }

  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*') {
      next();
      v = pmul(v, parseFactor());
    }
    return v;
  }

  function parseFactor() {
    if (peek() === '+') { next(); return parseFactor(); }
    if (peek() === '-') { next(); return pneg(parseFactor()); }
    let v;
    const t = next();
    if (t === '(') {
      v = parseExpr();
      if (next() !== ')') throw new Error('缺少右括号');
    } else if (t === 's') {
      v = [0, 1];
    } else if (/^[0-9.]+$/.test(t)) {
      v = [Number(t)];
      if (!Number.isFinite(v[0])) throw new Error(`非法数字 ${t}`);
    } else {
      throw new Error(`意外符号 ${t ?? '结束'}`);
    }
    if (peek() === '^') {
      next();
      const e = next();
      if (!/^[0-9]+$/.test(String(e))) throw new Error(`非法指数 ${e}`);
      if (Number(e) > 12) throw new Error(`指数过大 ${e}`);
      v = ppow(v, Number(e));
    }
    return v;
  }

  const result = pt(parseExpr());
  if (pos < tokens.length) throw new Error(`意外符号 ${tokens[pos]}`);
  return result;
}

function tokenizePoly(s) {
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
    if ('s+-*^()'.includes(c)) {
      const prev = tokens[tokens.length - 1];
      const implicit = prev && (isNumCh(prev) || prev === 's' || prev === ')')
        && (c === 's' || c === '(' || isNumCh(c));
      if (implicit) tokens.push('*');
      tokens.push(c);
      i++;
      continue;
    }
    throw new Error(`无法识别的字符 "${c}"`);
  }
  return tokens;
}

/* ---------------- 多项式分数 ---------------- */

const UNIT = () => ({ n: [1], d: [1] });

function fAdd(a, b) {
  return { n: padd(pmul(a.n, b.d), pmul(b.n, a.d)), d: pmul(a.d, b.d) };
}

function fSub(a, b) {
  return { n: psub(pmul(a.n, b.d), pmul(b.n, a.d)), d: pmul(a.d, b.d) };
}

function fMul(a, b) {
  return { n: pmul(a.n, b.n), d: pmul(a.d, b.d) };
}

function fDiv(a, b) {
  return { n: pmul(a.n, b.d), d: pmul(a.d, b.n) };
}

function fracToString(tf) {
  const n = polyToString(tf.n);
  const d = polyToString(tf.d);
  const ns = /[+\- ]/.test(n) ? `(${n})` : n;
  const ds = /[+\- ]/.test(d) ? `(${d})` : d;
  return `${ns} / ${ds}`;
}

/* ---------------- 图结构 ---------------- */

function transferFraction(block) {
  if (block.type !== 'TF') return UNIT();
  return {
    n: parsePoly(block.params?.num || '1'),
    d: parsePoly(block.params?.den || '1'),
  };
}

function edgeFraction(edge, byId) {
  const src = byId.get(edge.from.block);
  const tgt = byId.get(edge.to.block);
  const f = transferFraction(src);
  if (tgt?.type === 'SUM' && tgt.signs?.[Number(edge.to.port.slice(2))] === -1) {
    return { n: pneg(f.n), d: f.d };
  }
  return f;
}

function combinationsWithoutTouching(loops, onCombination) {
  function visit(index, chosen, nodes) {
    if (index === loops.length) return;
    visit(index + 1, chosen, nodes);
    const loop = loops[index];
    if (loop.nodes.some((node) => nodes.has(node))) return;
    const nextNodes = new Set([...nodes, ...loop.nodes]);
    const nextChosen = [...chosen, loop];
    onCombination(nextChosen);
    visit(index + 1, nextChosen, nextNodes);
  }
  visit(0, [], new Set());
}

/* Δ = 1 - Σ回路增益 + Σ不接触回路增益积 - ... */
function deltaFraction(loops) {
  let f = UNIT();
  combinationsWithoutTouching(loops, (combo) => {
    const product = combo.reduce((acc, l) => fMul(acc, l.frac), UNIT());
    f = combo.length % 2 ? fSub(f, product) : fAdd(f, product);
  });
  return f;
}

/* ---------------- 梅森公式求各示波器的传递函数 ---------------- */

export function analyzeSignalGraph(model) {
  const { blocks, wires } = model;
  if (!blocks.length) return { error: '信号流图为空' };

  const sources = blocks.filter((b) => b.type === 'SOURCE');
  const probes = blocks.filter((b) => b.type === 'PROBE');
  if (!sources.length) return { error: '缺少信号源，请添加一个信号源节点' };
  if (sources.length > 1) return { error: '目前只支持一个信号源，请删除多余的信号源' };
  if (!probes.length) return { error: '缺少示波器，请添加示波器节点观测输出' };

  const source = sources[0];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const adj = new Map(blocks.map((b) => [b.id, []]));
  wires.forEach((w) => adj.get(w.from.block)?.push(w));

  try {
    const edgeFrac = (edge) => edgeFraction(edge, byId);

    /* 枚举所有回路 */
    const loops = [];
    const seenLoops = new Set();
    function findLoops(start, current, visited, nodes, edges) {
      for (const edge of adj.get(current) || []) {
        const next = edge.to.block;
        if (next === start) {
          const cycle = [...edges, edge];
          const canonical = cycle.map((e) => e.id).sort().join('\u0000');
          if (!seenLoops.has(canonical)) {
            seenLoops.add(canonical);
            loops.push({
              nodes: [...nodes],
              edges: cycle,
              frac: cycle.reduce((acc, e) => fMul(acc, edgeFrac(e)), UNIT()),
            });
          }
          continue;
        }
        if (visited.has(next)) continue;
        visited.add(next);
        nodes.push(next);
        findLoops(start, next, visited, nodes, [...edges, edge]);
        nodes.pop();
        visited.delete(next);
      }
    }
    blocks.forEach((b) => findLoops(b.id, b.id, new Set([b.id]), [b.id], []));

    const delta = deltaFraction(loops);

    /* 每个示波器：T = Σ(Pk·Δk) / Δ */
    const probeResults = probes.map((probe) => {
      const paths = [];
      function findPaths(current, visited, edges) {
        if (current === probe.id) {
          paths.push([...edges]);
          return;
        }
        for (const edge of adj.get(current) || []) {
          const next = edge.to.block;
          if (visited.has(next)) continue;
          visited.add(next);
          edges.push(edge);
          findPaths(next, visited, edges);
          edges.pop();
          visited.delete(next);
        }
      }
      findPaths(source.id, new Set([source.id]), []);

      if (!paths.length) {
        return { block: probe, error: '信号源到该示波器没有前向路径' };
      }

      let num = null;
      for (const pathEdges of paths) {
        const pathNodes = new Set([source.id, ...pathEdges.map((e) => e.to.block)]);
        const p = pathEdges.reduce((acc, e) => fMul(acc, edgeFrac(e)), UNIT());
        const nonTouching = loops.filter((l) => !l.nodes.some((id) => pathNodes.has(id)));
        const dk = deltaFraction(nonTouching);
        num = num ? fAdd(num, fMul(p, dk)) : fMul(p, dk);
      }
      const tf = fDiv(num, delta);
      return { block: probe, tf: { n: tf.n, d: tf.d, text: fracToString(tf) } };
    });

    return { source, probes: probeResults };
  } catch (e) {
    return { error: `传递函数解析失败：${e.message}` };
  }
}
