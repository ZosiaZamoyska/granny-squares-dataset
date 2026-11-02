/* Approximate crochet symbol chart for a granny square, laid out from stitch tokens.
   A port of granny/chart.py from granny-squares-dataset (see there for the reasoning), changed
   to read the token stream instead of the DSL tree, so it can draw any stream: a real
   pattern, a half-made round, or whatever the model predicts.

   The four corner chains (each round's longest chain spaces) go to the corners and the
   stitches between them spread along the sides; stitches worked into one place ("dc@corner
   dc+ dc+") fan out from a shared base. Rounds without four corner chains get a
   superellipse between circle and square.

   layout(rounds) -> {size, ring, rounds: [{prims, from, to}]}; each prim has i: the token indices it
   was drawn from, so the page can style or highlight it per token ([from, to) is the round's
   token range). Given the stitch graph (parentsOf), each round is turned, and mirrored when it was
   worked the other way, so its stitches sit over what they're worked into; without it every round
   starts at the same corner and runs counterclockwise. */

import { EOR, isColor, parseToken } from "./dsl.js";

const U = 10;   // stitch width and dc height, in chart units
const R0 = 6;   // magic ring radius
const HEIGHT = { sc: 0.5, hdc: 0.75, dc: 1, tr: 1.35, dtr: 1.7, trtr: 2 };
const SLOT = { ch: 0.55, dot: 0.45 };
const GAP = 2.8;
const SQUARE = 40;
// Sides in drawing order (counterclockwise on screen, y down): top, left, bottom, right.
const SIDES = [[[0, -1], [-1, 0]], [[-1, 0], [0, 1]], [[0, 1], [1, 0]], [[1, 0], [0, -1]]];

const add = (p, q, s = 1) => [p[0] + q[0] * s, p[1] + q[1] * s];
const height = (it) => (it.kind === "chcol" ? it.n / 3 : HEIGHT[it.kind] ?? 1);
const slot = (it) => (it.kind === "ch" ? SLOT.ch * it.n : SLOT[it.kind] ?? 1);

/** One round's tokens (offset: index of its first token in the stream) -> layout items.
    parentsOf (optional): with the stitch graph, neighbouring stitches worked into the same place
    form a group, whatever the DSL wrote ("3ch=dc 2dc@same": the chain column too). */
function items(tokens, offset, color, parentsOf = null, ring = null) {
  const out = [];
  let group = null, gid = 0, lastKey = null;
  tokens.forEach((t, j) => {
    if (t[0] === "<") return; // <s>, <unk>
    const i = offset + j, p = parseToken(t);
    if (p.st === "color") { color.c = p.color; return; }
    if (["eor", "sk", "turn", "fo", "mr"].includes(p.st)) return;
    const y = color.c;
    if (p.st === "ch" && !p.as) {
      const last = out[out.length - 1];
      if (last?.kind === "ch" && last.y === y) { last.n += 1; last.i.push(i); } else out.push({ kind: "ch", n: 1, i: [i], y, group: null });
      return;
    }
    if (p.st === "sl" || p.st === "join") {
      out.push({ kind: "dot", i: [i], y, group: null, top: p.place === "top" || p.st === "join" });
      return;
    }
    // A stitch: "+" joins the group of the stitch before it; a place other than the ring starts one.
    if (parentsOf) {
      const ps = parentsOf(i), key = ps.length && !ps.includes(ring) ? String(ps) : null; // the ring: no shared base
      if (key && key === lastKey) {
        if (!group) {
          group = `g${gid++}`;
          const prev = [...out].reverse().find((x) => x.kind !== "ch" && x.kind !== "dot");
          if (prev) prev.group = group;
        }
      } else group = null;
      lastKey = key;
    } else if (p.same) {
      if (!group) {
        group = `g${gid++}`;
        const prev = [...out].reverse().find((x) => x.kind !== "ch" && x.kind !== "dot");
        if (prev) prev.group = group;
      }
    } else group = p.place && p.place !== "ring" ? `g${gid++}` : null;
    out.push(p.as ? { kind: "chcol", n: p.n, i: [i], y, group } : { kind: p.st, i: [i], y, group });
  });
  return out;
}

function cornerChains(its) {
  // Corners are the longest chain spaces; a chain that opens the round is the beginning chain.
  const chains = its.map((it, i) => (it.kind === "ch" && i > 0 ? i : -1)).filter((i) => i >= 0);
  const longest = Math.max(0, ...chains.map((i) => its[i].n));
  return [chains.filter((i) => its[i].n === longest), longest];
}

function features(its) {
  // How much a round squares itself up (four clusters of its tallest stitches, or four
  // shells), and the item at its first corner.
  const sts = its.map((it, i) => (["ch", "dot", "chcol"].includes(it.kind) ? -1 : i)).filter((i) => i >= 0);
  const hs = sts.map((i) => height(its[i]));
  let boost = 0, anchor = null;
  if (hs.length && Math.max(...hs) > Math.min(...hs)) {
    const hmax = Math.max(...hs), clusters = [];
    let prev = null;
    sts.forEach((i, pos) => {
      if (hs[pos] !== hmax) return;
      if (prev !== null && pos === prev + 1) clusters[clusters.length - 1].push(i); else clusters.push([i]);
      prev = pos;
    });
    if (clusters.length > 4 && clusters[0][0] === sts[0] && clusters.at(-1).at(-1) === sts.at(-1)) {
      clusters[0] = [...clusters.pop(), ...clusters[0]];
    }
    if (clusters.length === 4) {
      const median = [...hs].sort((a, b) => a - b)[Math.floor(hs.length / 2)];
      boost = 8 * (hmax / median - 1);
      anchor = clusters[0][Math.floor(clusters[0].length / 2)];
    }
  }
  const groups = {};
  for (const i of sts) if (its[i].group) (groups[its[i].group] ||= []).push(i);
  const shells = Object.values(groups).filter((g) => g.length >= 3);
  if (shells.length === 4) {
    boost = Math.max(boost, 2);
    if (anchor === null) anchor = shells[0][Math.floor(shells[0].length / 2)];
  }
  return [boost, anchor];
}

class Curve {
  // Superellipse of half-size R and exponent p, from the top-right corner counterclockwise on screen.
  constructor(R, p, samples = 720) {
    this.pts = [];
    for (let j = 0; j < samples; j++) {
      const t = -Math.PI / 4 - (2 * Math.PI * j) / samples, c = Math.cos(t), s = Math.sin(t);
      this.pts.push([R * Math.sign(c) * Math.abs(c) ** (2 / p), R * Math.sign(s) * Math.abs(s) ** (2 / p)]);
    }
    this.cum = [0];
    for (let j = 0; j < samples; j++) {
      const a = this.pts[j], b = this.pts[(j + 1) % samples];
      this.cum.push(this.cum[j] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.length = this.cum[samples];
  }

  at(f) {
    const d = (((f % 1) + 1) % 1) * this.length;
    let lo = 0, hi = this.pts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const t = (d - this.cum[lo]) / (this.cum[lo + 1] - this.cum[lo] || 1);
    return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI];
  }
}

function fan(bases) {
  // Stitches worked into one place share the mean of their bases.
  for (const ms of Object.values(bases)) {
    const bx = ms.reduce((s, p) => s + p.b[0], 0) / ms.length, by = ms.reduce((s, p) => s + p.b[1], 0) / ms.length;
    for (const p of ms) p.b = [bx, by];
  }
}

function placeShaped(its, rIn, h, ring, pIn, pOut, anchor) {
  const inner = new Curve(rIn, pIn), outer = new Curve(rIn + h, pOut), chainLevel = new Curve(rIn + h * 0.92, pOut);
  const width = its.reduce((s, it) => s + slot(it), 0) || 1;
  const starts = [];
  let cum = 0;
  for (const it of its) { starts.push(cum); cum += slot(it); }
  const shift = anchor !== null ? (starts[anchor] + slot(its[anchor]) / 2) / width : 0;
  const prims = [], bases = {};
  its.forEach((it, k) => {
    const c0 = starts[k], f = (c0 + slot(it) / 2) / width - shift;
    if (it.kind === "ch") {
      for (let j = 0; j < it.n; j++) {
        const [pt, ang] = chainLevel.at((c0 + (j + 0.5) * SLOT.ch) / width - shift);
        prims.push({ k: "oval", c: pt, ang, i: [it.i[j]], y: it.y });
      }
      return;
    }
    const [topDir] = outer.at(f);
    let base;
    if (ring) {
      const ln = Math.hypot(...topDir) || 1;
      base = [(topDir[0] / ln) * R0, (topDir[1] / ln) * R0];
    } else [base] = inner.at(f);
    if (it.kind === "dot") { prims.push({ k: "dot", c: base, i: it.i, y: it.y, _top: it.top, _f: f }); return; }
    const p = { k: it.kind, b: base, i: it.i, y: it.y, n: it.n, _f: f, _h: height(it) * U, _order: k, _dir: topDir };
    if (it.group) (bases[it.group] ||= []).push(p);
    prims.push(p);
  });
  fan(bases);
  for (const p of prims) {
    if (!p._dir) continue;
    const [tx, ty] = p._dir, [bx, by] = p.b, ln = Math.hypot(tx - bx, ty - by) || 1;
    p.t = [bx + ((tx - bx) / ln) * p._h, by + ((ty - by) / ln) * p._h];
    delete p._dir;
  }
  const stitches = prims.filter((p) => p.t).sort((a, b) => a._order - b._order);
  const target = stitches.find((p) => p.k === "chcol") || stitches[0];
  for (const p of prims) {
    let f = p._f;
    if (p._top && target) {
      const level = new Curve(rIn + target._h, pOut), df = GAP / level.length, gap = ((f - target._f + 0.5) % 1 + 1) % 1 - 0.5;
      if (Math.abs(gap) < df) f = target._f + (gap < 0 ? -df : df);
      [p.c] = level.at(f);
    }
  }
  return prims;
}

function placeRound(its, rIn, h, ring, pIn = 2, pOut = 2, anchor = null) {
  const rOut = rIn + h;
  its.forEach((it, i) => (it.order = i));
  // A slip stitch that closes the round joins it, whatever its placement.
  if (its.length && its.at(-1).kind === "dot") its.at(-1).top = true;
  const [corners] = cornerChains(its);
  if (corners.length !== 4) return placeShaped(its, rIn, h, ring, pIn, pOut, anchor);

  const c0 = corners[0], seq = [...its.slice(c0), ...its.slice(0, c0)];
  const cut = corners.map((i) => (i >= c0 ? i - c0 : i - c0 + its.length));
  const sides = [0, 1, 2, 3].map((k) => [seq[cut[k]], seq.slice(cut[k] + 1, k < 3 ? cut[k + 1] : seq.length)]);
  const prims = [], bases = {};
  sides.forEach(([corner, run], k) => {
    const [n, d] = SIDES[k];
    // Corner chain: ovals on an arc around the inner corner.
    const pn = SIDES[(k + 3) % 4][0];
    let a0 = Math.atan2(pn[1], pn[0]), a1 = Math.atan2(n[1], n[0]);
    if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    if (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const centre = add(add([0, 0], n, rIn), d, -rIn);
    for (let j = 0; j < corner.n; j++) {
      const a = a0 + ((a1 - a0) * (j + 0.5)) / corner.n;
      prims.push({ k: "oval", c: add(centre, [Math.cos(a), Math.sin(a)], h * 0.95), ang: (a * 180) / Math.PI + 90, i: [corner.i[j]], y: corner.y });
    }
    const width = run.reduce((s, it) => s + slot(it), 0);
    if (!width) return;
    const u = Math.min(U, (2 * rOut - 1.2 * U) / width);
    let x = (-width * u) / 2;
    for (const it of run) {
      const w = slot(it) * u;
      if (it.kind === "ch") {
        for (let j = 0; j < it.n; j++) {
          const xj = x + (j + 0.5) * SLOT.ch * u;
          prims.push({ k: "oval", c: add(add([0, 0], n, rIn + h * 0.92), d, xj), ang: (Math.atan2(d[1], d[0]) * 180) / Math.PI, i: [it.i[j]], y: it.y });
        }
      } else {
        const xc = Math.max(-rIn, Math.min(rIn, x + w / 2));
        let base = add(add([0, 0], n, rIn), d, xc);
        if (ring) {
          // Round 1 grows out of the magic ring, not a square.
          const top = add(add([0, 0], n, it.kind !== "dot" ? rOut : rIn), d, x + w / 2), ln = Math.hypot(...top) || 1;
          base = [(top[0] / ln) * R0, (top[1] / ln) * R0];
        }
        if (it.kind === "dot") prims.push({ k: "dot", c: base, i: it.i, y: it.y, _top: it.top, _at: [n, d, xc] });
        else {
          const p = { k: it.kind, b: base, i: it.i, y: it.y, n: it.n, _side: [n, d, x + w / 2], _order: it.order };
          if (it.group) (bases[it.group] ||= []).push(p);
          prims.push(p);
        }
      }
      x += w;
    }
  });
  fan(bases);
  for (const p of prims) {
    if (!p._side) continue;
    const [n, d, xc] = p._side;
    p.t = add(add([0, 0], n, rIn + height({ kind: p.k, n: p.n }) * U), d, xc);
  }
  // sl@top / join: raised to the height of the beginning chain's top, beside it.
  const stitches = prims.filter((p) => p.t).sort((a, b) => a._order - b._order);
  const target = stitches.find((p) => p.k === "chcol") || stitches[0];
  for (const p of prims) {
    if (!p._top || !target) continue;
    let [n, d, xc] = p._at;
    const level = rIn + height({ kind: target.k, n: target.n }) * U, [tn, , tx] = target._side;
    if (tn === n && Math.abs(xc - tx) < GAP) xc = tx + ((xc - tx) < 0 ? -GAP : GAP);
    p.c = add(add([0, 0], n, level), d, xc);
  }
  return prims;
}

/** Turn (and mirror if that fits better) a round's prims so each stitch's base points the way its
    parents lie: where (token index -> point in the round below), parentsOf(i) -> token indices.
    quarter: square rounds only take quarter turns, so their corners stay in the corners. */
function orient(prims, parentsOf, where, quarter) {
  const pairs = [];
  for (const p of prims) {
    const base = p.b || p.c;
    if (p.k === "dot" || !base) continue;
    for (const i of p.i) {
      const ps = parentsOf(i).map((j) => where.get(j)).filter(Boolean);
      if (!ps.length) continue;
      const q = [ps.reduce((s, x) => s + x[0], 0) / ps.length, ps.reduce((s, x) => s + x[1], 0) / ps.length];
      if (Math.hypot(...q) > R0 + 1) pairs.push([Math.atan2(base[1], base[0]), Math.atan2(q[1], q[0])]); // the ring has no direction
    }
  }
  if (pairs.length < 2) return;
  let best = null;
  for (const m of [1, -1]) {
    let sx = 0, sy = 0;
    for (const [s, q] of pairs) { sx += Math.cos(q - m * s); sy += Math.sin(q - m * s); }
    let phi = Math.atan2(sy, sx);
    if (quarter) phi = Math.round(phi / (Math.PI / 2)) * (Math.PI / 2);
    const score = pairs.reduce((sum, [s, q]) => sum + Math.cos(q - m * s - phi), 0);
    if (!best || score > best.score + 1e-9) best = { m, phi, score };
  }
  const { m, phi } = best, c = Math.cos(phi), s = Math.sin(phi);
  if (m === 1 && Math.abs(phi) < 1e-9) return;
  const move = (pt) => { const y = m * pt[1]; return [pt[0] * c - y * s, pt[0] * s + y * c]; };
  for (const p of prims) {
    for (const k of ["b", "t", "c"]) if (p[k]) p[k] = move(p[k]);
    if (p.ang !== undefined) p.ang = m * p.ang + (phi * 180) / Math.PI;
  }
}

/** rounds: arrays of tokens (as from splitRounds), in stream order. parentsOf(i): the token
    indices token i is worked into or stands on (from graph.js), to line rounds up. */
export function layout(rounds, { parentsOf = null } = {}) {
  const out = { rounds: [], ring: null, size: R0 + U };
  let rIn = R0, first = true, p = 2, offset = 0;
  const color = { c: null }, where = new Map(); // token index -> where the next round works into it
  for (const toks of rounds) {
    const its = items(toks, offset, color, parentsOf, out.ring?.i[0]);
    const mr = toks.indexOf("mr");
    if (mr >= 0) { out.ring = { r: R0, i: [offset + mr], y: color.c }; where.set(offset + mr, [0, 0]); }
    const from = offset;
    offset += toks.length;
    if (!its.some((it) => it.kind !== "dot" && it.kind !== "ch")) continue;
    const h = Math.max(...its.filter((it) => it.kind !== "ch" && it.kind !== "dot").map(height), 0.6) * U;
    const [corners] = cornerChains(its);
    let pOut, anchor = null;
    if (corners.length === 4) pOut = SQUARE;
    else {
      const [boost, a] = features(its);
      anchor = a;
      pOut = Math.min(SQUARE, p + boost);
    }
    const prims = placeRound(its, rIn, h, first, p, pOut, anchor);
    for (const q of prims) for (const k of Object.keys(q)) if (k[0] === "_") delete q[k];
    if (parentsOf && !first) orient(prims, parentsOf, where, pOut >= 3);
    for (const q of prims) for (const i of q.i) where.set(i, q.t || q.c); // a stitch's top, a chain's middle
    out.rounds.push({ prims, from, to: offset });
    p = pOut;
    rIn += h;
    first = false;
  }
  out.size = rIn + 0.8 * U;
  return out;
}

// ---- drawing --------------------------------------------------------------------

export const ROUND_COLORS = ["#c2546b", "#3a7bd5", "#e8892b", "#3f8f5a", "#8a5cc2", "#1f9e9e", "#b5852a"];

/** Yarn "C2" -> its colour (patterns name yarns by number only, so these are stand-ins). */
export const yarnColor = (y) => ROUND_COLORS[(+y.slice(1) - 1 + ROUND_COLORS.length) % ROUND_COLORS.length];

const hasYarns = (chart) => chart.rounds.some((r) => r.prims.some((p) => p.y));
// Each yarn gets its own colour, or, in a one-yarn pattern, each round. In a coloured pattern,
// stitches without a colour are drawn neutral (as in the dataset editor).
const baseColor = (yarns, ri, y) => (!yarns ? ROUND_COLORS[ri % ROUND_COLORS.length] : y ? yarnColor(y) : "var(--muted)");

/** The colour draw() gives every token of the stream by default, so token chips can match the
    chart. Tokens without a symbol (sk, ↵, C2, …) take their round's or yarn's colour; tokens
    outside any drawn round (<s>, the start line's ↵) get null. */
export function tokenColors(chart, tokens) {
  const yarns = hasYarns(chart), out = new Array(tokens.length).fill(null);
  if (chart.ring) out[chart.ring.i[0]] = chart.ring.y ? yarnColor(chart.ring.y) : "var(--muted)";
  chart.rounds.forEach((r, ri) => {
    for (const p of r.prims) for (const i of p.i) out[i] = baseColor(yarns, ri, p.y);
    if (!yarns) for (let i = r.from; i < r.to; i++) out[i] ??= baseColor(yarns, ri, null);
  });
  if (yarns) {
    let y = null;
    tokens.forEach((t, i) => {
      if (isColor(t)) y = t;
      if (t[0] !== "<") out[i] ??= baseColor(yarns, 0, y);
    });
  }
  return out;
}

function symbol(p, color, sw) {
  const f = (n) => n.toFixed(2);
  const line = (a, b) => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
  const oval = (c, ang) => `<ellipse cx="${f(c[0])}" cy="${f(c[1])}" rx="2.1" ry="1.1" transform="rotate(${f(ang)} ${f(c[0])} ${f(c[1])})" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
  if (p.k === "oval") return oval(p.c, p.ang) + `<circle class="hitbox" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="2.4"/>`;
  if (p.k === "dot") return `<circle class="dot" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="1.1" fill="${color}"/><circle class="hitbox" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="2.4"/>`;
  const [b, t] = [p.b, p.t], dx = t[0] - b[0], dy = t[1] - b[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const at = (s, w = 0) => [b[0] + dx * s + nx * w, b[1] + dy * s + ny * w];
  const mid = at(0.5);
  const hit = `<circle class="hitbox" cx="${f(mid[0])}" cy="${f(mid[1])}" r="${f(Math.max(2.4, len / 2))}"/>`;
  if (p.k === "chcol") {
    const n = Math.max(1, Math.round(len / 3.2)), ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    return Array.from({ length: n }, (_, j) => oval(at((j + 0.5) / n), ang)).join("") + hit;
  }
  if (p.k === "sc") {
    const c = at(0.55), r = 1.6;
    return line([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]) + line([c[0] - r, c[1] + r], [c[0] + r, c[1] - r]) + hit;
  }
  const slashes = { dc: 1, tr: 2, dtr: 3, trtr: 4 }[p.k] ?? 0;
  let svg = line(b, t) + line(at(1, -1.8), at(1, 1.8));
  for (let j = 0; j < slashes; j++) {
    const s = 0.5 + (j - (slashes - 1) / 2) * 0.16;
    svg += line(at(s - 0.07, -1.3), at(s + 0.07, 1.3));
  }
  if (!["hdc", "dc", "tr", "dtr", "trtr"].includes(p.k)) {
    svg += `<ellipse cx="${f(at(0.6)[0])}" cy="${f(at(0.6)[1])}" rx="1.8" ry="1.8" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
  }
  return svg + hit;
}

/** SVG for a layout. style(tokenIndex, roundIndex, prim) -> {color?, cls?} lets the page grey out
    predictions or highlight a token; by default stitches get baseColor (see tokenColors). size: fixed
    viewBox half-size (to keep scale steady while a square grows). */
export function draw(chart, { style = () => ({}), size = null, empty = "No stitches yet" } = {}) {
  const S = Math.max(size || 0, chart.size);
  let svg = `<svg viewBox="${-S} ${-S} ${2 * S} ${2 * S}" xmlns="http://www.w3.org/2000/svg">`;
  if (!chart.rounds.length && !chart.ring) {
    return svg + `<text class="empty" x="0" y="0" text-anchor="middle">${empty}</text></svg>`;
  }
  if (chart.ring) {
    const st = style(chart.ring.i[0], -1, chart.ring);
    svg += `<g class="${st.cls || ""}" data-i="${chart.ring.i[0]}"><circle cx="0" cy="0" r="${chart.ring.r}" fill="none" stroke="${st.color || (chart.ring.y ? yarnColor(chart.ring.y) : "var(--muted)")}" stroke-width="0.6"/></g>`;
  }
  const yarns = hasYarns(chart);
  chart.rounds.forEach((r, ri) => {
    for (const p of r.prims) {
      const st = style(p.i[0], ri, p);
      const color = st.color || baseColor(yarns, ri, p.y);
      svg += `<g class="${st.cls || ""}" data-i="${p.i.join(" ")}">${symbol(p, color, st.width || 0.6)}</g>`;
    }
  });
  return svg + "</svg>";
}
