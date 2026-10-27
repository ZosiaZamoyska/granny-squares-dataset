/* Stitch graph: which stitch(es) of the round below each stitch is worked into.

   Stitches are made one after another (that order is the token stream); this adds where each
   one connects. Every node is a token (index in the stream):
     stitch  parents: the stitch top it is worked into (via "st"), or all the chains of the
             chain space it is worked around (via "sp"), or the magic ring (via "ring")
     slip    the same, or for a join (sl@top) the first stitch of its own round (via "join")
     chain   no parents: a chain grows sideways from the stitch before it, or straight up as a
             beginning chain ("ch3=dc", which also counts as a stitch, so the next round can work
             into its top; `on` says what it stands on)
     ring    the magic ring
   Front/back loop and post stitches would add a field to the edge (all edges are "whole stitch" now).

   The DSL says where a stitch goes only loosely: "dc" is the next stitch, "@sp" the next chain
   space, "@corner" the next corner space, and "@same" either the place just used or the next one,
   both as one place. Patterns also leave out the slip stitches that move to a round's start. So
   each round is aligned to the places of the round below (its stitch tops and chain spaces, in
   working order, reversed after a turn) by dynamic programming: every stitch or {…}@place group
   goes into one place, in order, at the lowest cost of breaking crochet habits (an unworked chain
   space, a skipped stitch without "sk", "@sp" into a stitch, …). The round may start a few places
   either side of where the round below was joined (a corner split over the join, or the far side
   of the beginning group after a turn), or next to any chain space (new yarn joined elsewhere).
   Places are stitch tops, chain spaces (a 1-chain space also takes a plain "dc", as in "dc in each
   st and ch") and the gaps between two neighbouring groups worked into different spaces (the
   "sp between clusters" of a granny round with no chains there). A round's cost is 0 when it
   reads cleanly; a high cost marks a transcription to check. */

import { EOR, isColor, parseToken, splitRounds } from "./dsl.js";

// Cost of landing a unit of each kind on a stitch top (st), a chain space (sp) or a gap between groups.
const LAND = {
  next: { st: 0, sp: 1.5, gap: 3 }, st: { st: 0, sp: 2, gap: 3 }, sp: { st: 3, sp: 0, gap: 0 },
  corner: { st: 3, sp: 0, gap: 3 }, same: { st: 0, sp: 0, gap: 0 }, col: { st: 0, sp: 0, gap: 0 },
  slide: { st: 0, sp: 0, gap: 0 }, endsl: { st: 0, sp: 1.5, gap: 3 },
};
const ONE_CHAIN = new Set(["next", "st", "endsl"]); // land on a 1-chain space as on a stitch
const NOT_CORNER = 0.5;   // "@corner" into a chain space that isn't one of the four longest
const SKIP_ST = 1;        // per stitch top passed over without "sk"
const SKIP_SP = 2;        // per chain space left unworked
const WRAP = 1;           // working back into the round's first place at its end
const CROWD = 3;          // a stitch into the place just used, without saying so
const SHELL = 1;          // a group with chains in it ({3dc 2ch 3dc}) on a stitch or in a gap, when there are chain spaces
const MAX_JUMP = 30;      // places one unit may pass over
const SHIFT = 4, SHIFT_COST = 0.25; // how far from the join a round may start, and the cost per place
const ELSEWHERE = 1;      // starting next to a chain space further away

/** A round's tokens -> its nodes (into `nodes`), units to place, and the places it makes. */
function readRound(toks, offset, nodes) {
  const units = [], anchors = [], joins = [];
  let sk = 0, turned = false, ring = null, run = null, first = null, started = false, chained = false;
  const real = toks.map((t, j) => [t, offset + j]).filter(([t]) => t[0] !== "<" && t !== EOR && !isColor(t));
  const lastNode = real.findLastIndex(([t]) => !["sk", "turn", "fo"].includes(t));
  real.forEach(([t, i], k) => {
    const p = parseToken(t);
    if (t === "turn") { turned = true; return; }
    if (t === "fo") return;
    if (t === "sk") { sk++; return; }
    if (t === "mr") {
      nodes[i] = { i, t, kind: "ring", parents: [] };
      ring = i;
      anchors.push({ kind: "ring", nodes: [i] });
      return;
    }
    if (p.st === "ch" && !p.as) {
      nodes[i] = { i, t, kind: "chain", parents: [] };
      chained = true;
      if (!run) anchors.push(run = { kind: "sp", nodes: [], lead: !started });
      run.nodes.push(i);
      return;
    }
    run = null;
    const unit = (kind, node) => { units.push({ kind, sk, tokens: [node] }); sk = 0; chained = false; };
    if (p.st === "sl" || p.st === "join") {
      const node = nodes[i] = { i, t, kind: "slip", parents: [] };
      if (p.place === "top" || p.st === "join") { joins.push(node); return; }
      const end = k === lastNode && started;
      // "… sl" at the end: a join, or into the next stitch; before the first stitch: moving to the start.
      unit(p.place || (end ? "endsl" : started ? "next" : "slide"), node);
      if (started && !end) anchors.push({ kind: "st", nodes: [i] }); // only slips mid-round are places
      return;
    }
    const node = nodes[i] = { i, t, kind: p.as ? "col" : "stitch", parents: [] };
    first ??= node;
    started = true;
    anchors.push({ kind: "st", nodes: [i] });
    if (p.same && units.length) {
      units.at(-1).tokens.push(node);
      if (chained) units.at(-1).shell = true; // chains between stitches of one group
      chained = false;
    }
    else unit(p.as ? p.place || "col" : p.place || "next", node);
  });
  // A short chain before the first stitch is a turning chain (it goes up), not a space.
  const places = anchors.filter((a) => !(a.lead && a.nodes.length <= 2));
  const sps = places.filter((a) => a.kind === "sp"), longest = Math.max(0, ...sps.map((a) => a.nodes.length));
  const corners = sps.filter((a) => a.nodes.length === longest);
  if (corners.length === 4) for (const a of corners) a.corner = true;
  return { units, joins, anchors: places, turned, ring, first, trailingSk: sk, corners: corners.length === 4,
    from: offset, to: offset + toks.length, nodes };
}

/** Place a round's units on the places L of the round below (L[0]: where it was joined), trying
    each start near the join. Returns the cost; fills parents. */
function align(R, L, cornersKnown) {
  if (!R.units.length) return 0;
  if (L.length === 1 && L[0].kind === "ring") {
    for (const u of R.units) place(u, L[0]);
    return 0;
  }
  const n = L.length, near = new Map(), far = new Map();
  for (let s = -Math.min(SHIFT, n - 1); s <= Math.min(SHIFT, n - 1); s++) near.set((s + n) % n, Math.abs(s) * SHIFT_COST);
  L.forEach((a, j) => {
    if (a.kind !== "sp") return;
    for (const k of [j, (j + 1) % n]) if (!near.has(k)) far.set(k, ELSEWHERE);
  });
  let best = null;
  const tryStarts = (starts) => {
    for (const [s, extra] of [...starts].sort((x, y) => x[1] - y[1])) {
      if (best && extra >= best.cost) return; // can't beat it
      const a = alignFrom(R, [...L.slice(s), ...L.slice(0, s)], cornersKnown);
      a.cost += extra;
      if (!best || a.cost < best.cost) best = a;
    }
  };
  tryStarts(near);
  if (best.cost > ELSEWHERE) tryStarts(far); // a far start costs ELSEWHERE already
  for (const [u, a] of best.placed) place(u, a);
  R.joins.push(...best.joins);
  return best.cost;
}

/** One alignment of R's units to L, all starting at L[0]: {cost, placed: [[unit, place]], joins}. */
function alignFrom(R, L, cornersKnown) {
  const n = L.length, m = R.units.length;
  const st = [0], sp = [0], shellCost = L.some((a) => a.kind === "sp") ? SHELL : 0;
  const best = Array.from({ length: m }, () => new Float64Array(n + 1).fill(Infinity));
  const from = Array.from({ length: m }, () => new Int32Array(n + 1).fill(-2));
  for (const a of L) { st.push(st.at(-1) + (a.kind === "st")); sp.push(sp.at(-1) + (a.kind === "sp")); }
  // Cost of unit k going to position p (0..n, n = back to L[0]) after the unit before it at q (-1: none yet).
  const cost = (k, q, p) => {
    const u = R.units[k], afterCol = k > 0 && R.units[k - 1].kind === "col";
    if (p === q) {
      if (q < 0) return Infinity;
      const skipped = u.sk * SKIP_ST + (u.shell && L[q % n].kind !== "sp" ? shellCost : 0); // "2sk" written, but nothing skipped
      if (u.kind === "same") return skipped + (k > 1 && from[k - 1][q] === q ? CROWD : 0); // a third group in one place
      if (u.kind === "col") return skipped;
      if (u.kind === "endsl") return skipped + 0.3; // the join
      return skipped + CROWD;
    }
    const a = L[p % n], kind = LAND[u.kind] ? u.kind : "same";
    let c = a.kind === "sp" && a.nodes.length === 1 && ONE_CHAIN.has(kind) ? 0 : LAND[kind][a.kind];
    if (u.kind === "corner" && cornersKnown && !a.corner) c += NOT_CORNER;
    if (u.shell && a.kind !== "sp") c += shellCost;
    if (u.kind === "same" && afterCol) c += 0.3; // "3ch=dc 2dc@same": the same place as the chain
    if (u.kind === "col") c += 0.3;
    if (p === n) c += WRAP;
    const nst = st[p] - st[q + 1], nsp = sp[p] - sp[q + 1];
    const free = a.kind !== "st" && ["same", "corner", "sp", "slide", "col"].includes(u.kind); // "next space" passes stitches
    return c + nsp * SKIP_SP + (u.sk ? Math.abs(nst - u.sk) : free ? 0 : nst) * SKIP_ST;
  };
  for (let p = 0; p <= Math.min(n, MAX_JUMP); p++) { best[0][p] = cost(0, -1, p); from[0][p] = -1; }
  for (let k = 1; k < m; k++) {
    for (let q = 0; q <= n; q++) {
      if (best[k - 1][q] === Infinity) continue;
      for (let p = q; p <= Math.min(n, q + MAX_JUMP); p++) {
        const c = best[k - 1][q] + cost(k, q, p);
        if (c < best[k][p]) { best[k][p] = c; from[k][p] = q; }
      }
    }
  }
  // Places after the last unit are left unworked (minus a trailing "sk").
  let end = -1, total = Infinity;
  for (let p = 0; p <= n; p++) {
    if (best[m - 1][p] === Infinity) continue;
    const c = best[m - 1][p] + (p >= n - 1 ? 0 : (sp[n] - sp[p + 1]) * SKIP_SP + Math.max(0, st[n] - st[p + 1] - R.trailingSk) * SKIP_ST);
    if (c < total) { total = c; end = p; }
  }
  const placed = [], joins = [];
  for (let k = m - 1, p = end; k >= 0; p = from[k][p], k--) {
    const u = R.units[k];
    if (u.kind === "endsl" && k > 0 && from[k][p] === p) joins.push(u.tokens[0]);
    else placed.push([u, L[p % n]]);
  }
  return { cost: total, placed, joins };
}

function place(u, a) {
  for (const node of u.tokens) put(node, a);
}

/** Node goes into place a (a beginning chain stands on it instead: chains have no parents). */
function put(node, a) {
  node.at = a;
  if (node.kind === "col") node.on = a.nodes;
  else { node.parents = a.nodes; node.via = a.kind; }
}

/** The places of round R in the order the next round meets them: L[0] is where R was joined
    (its first place), and after a turn the rest come backwards. */
function workingOrder(R) {
  const [a0, ...rest] = R.anchors;
  return R.turned ? [a0, ...rest.reverse()] : R.anchors;
}

/** Places plus a gap between neighbouring stitches worked into different chain spaces or gaps. */
function withGaps(anchors, nodes) {
  const out = [];
  anchors.forEach((a, j) => {
    const b = anchors[(j + 1) % anchors.length]; // the last one's neighbour is across the join
    out.push(a);
    if (a.kind !== "st" || b.kind !== "st" || a === b) return;
    const x = nodes[a.nodes[0]], y = nodes[b.nodes[0]];
    const into = (nd) => nd.via === "sp" || nd.via === "gap" || nd.kind === "col";
    const where = (nd) => String(nd.parents.length ? nd.parents : nd.on);
    if (into(x) && into(y) && where(x) !== where(y)) out.push({ kind: "gap", nodes: [x.i, y.i] });
  });
  return out;
}

/** Token stream -> {nodes: per token, a node or null; rounds: [{from, to, cost, places, given, stale}]}
    (places: the round below's, in working order). given: {roundIndex: graph tokens} for rounds
    whose connections were set by hand (see graphTokens); those are used as they are (given: true)
    unless they no longer fit the round's stitches (stale: true, and the round is worked out). */
export function graph(tokens, { given = {} } = {}) {
  return build(tokens, (R, L, below, k) => {
    if (given[k]) {
      if (applyTokens(R, L, given[k])) { R.given = true; return 0; }
      R.stale = true;
    }
    return align(R, L, below.corners);
  });
}

/** Read the rounds one by one; placeRound(R, L, below, k) connects round k to the places L below. */
function build(tokens, placeRound) {
  const nodes = tokens.map(() => null), rounds = [];
  let offset = 0, below = null;
  splitRounds(tokens).forEach((toks, k) => {
    const R = readRound(toks, offset, nodes), L = below ? workingOrder(below) : null;
    R.toks = toks;
    const cost = L ? placeRound(R, L, below, k) : 0;
    for (const j of R.joins) if (R.first) { j.parents = [R.first.i]; j.via = "join"; }
    R.anchors = withGaps(R.anchors, nodes);
    rounds.push({ from: offset, to: offset + toks.length, cost, places: L, given: !!R.given, stale: !!R.stale });
    offset += toks.length;
    if (R.anchors.length) below = R;
  });
  return { nodes, rounds };
}

// ---- graph tokens ------------------------------------------------------------------
//
// One token per stitch that says what it is and exactly where it goes: "dc^0" into the place that
// is next in the round below, "dc^+2" two places further on, "dc^-1" back into the place just used
// (so five dc into one place are ^0 ^-1 ^-1 ^-1 ^-1), and a trailing "g" for the gap just before
// that place. Places are the stitch tops and chain spaces of the round below in working order;
// gaps between groups don't count as places. A round starts with the place where the round below
// was joined as next. Beginning chains ("ch3=dc^0") say where they stand, chains ("ch") nothing,
// joins are "sl@top", and "sk" disappears into the moves. graphTokens and readGraphTokens are
// inverses: the graph read back is the graph written.

const MOVE = /^(.+)\^([+-]?\d+)(g?)$/;
const mod = (a, n) => ((a % n) + n) % n;
// What a stitch token is called in graph tokens: its stitch, without where it goes.
const bare = (t) => { const p = parseToken(t); return p.as ? `ch${p.n}=${p.as}` : p.st; };

/** Counting places in working order: place index of each place (a gap: the place after it). */
function counting(L) {
  const real = L.filter((a) => a.kind !== "gap"), index = new Map(real.map((a, j) => [a, j]));
  L.forEach((a, j) => {
    if (a.kind !== "gap") return;
    let k = j;
    while (L[k].kind === "gap") k = (k + 1) % L.length;
    index.set(a, index.get(L[k]));
  });
  return { real, index };
}

/** The place at counting index `place` of L, or the gap just before it (null if there's none). */
function placeAt(L, real, place, gap) {
  const a = real[mod(place, real.length)];
  if (!gap) return a;
  const b = L[mod(L.indexOf(a) - 1, L.length)];
  return b.kind === "gap" ? b : null;
}

/** Connect round R as its graph tokens say. Tokens must match the round's stitches one to one
    (yarn colours, "sk" and "↵" aside); returns false, changing nothing, if they don't. */
function applyTokens(R, L, list) {
  const want = list.filter((t) => !isColor(t) && t !== EOR);
  const have = R.toks.map((t, j) => [t, R.from + j]).filter(([t]) => t[0] !== "<" && t !== "sk" && t !== EOR && !isColor(t));
  if (want.length !== have.length) return false;
  const { real } = counting(L), plan = [], joins = [];
  let next = 0;
  for (let j = 0; j < want.length; j++) {
    const [t, i] = have[j], w = want[j], m = MOVE.exec(w), nd = R.nodes[i];
    if (!m) {
      if (w === "sl@top" && nd?.kind === "slip") joins.push(nd);
      else if (w !== t) return false;
      continue;
    }
    if (!nd || nd.kind === "chain" || bare(t) !== m[1]) return false;
    const to = mod(next + +m[2], real.length), a = placeAt(L, real, to, !!m[3]);
    if (!a) return false;
    plan.push([nd, a]);
    next = m[3] ? to : (to + 1) % real.length;
  }
  for (const [nd, a] of plan) put(nd, a);
  for (const nd of joins) if (!R.joins.includes(nd)) R.joins.push(nd);
  return true;
}

/** Where round k's stitches go, for editing: [{i: token index, place: counting index, gap}]. */
export function targets(g, k) {
  const r = g.rounds[k], out = [];
  if (!r.places) return out;
  const { index } = counting(r.places);
  for (let i = r.from; i < r.to; i++) {
    const nd = g.nodes[i];
    if (nd?.at) out.push({ i, place: index.get(nd.at), gap: nd.at.kind === "gap" });
  }
  return out;
}

/** The place in round k's places below that token j of the round below is (a stitch top, or the
    chain space a chain belongs to), as {place, gap: false}; gap: the gap just before it instead. */
export function placeOf(g, k, j, gap = false) {
  const L = g.rounds[k].places, { real, index } = counting(L);
  const a = L.find((x) => x.kind !== "gap" && x.nodes.includes(j));
  if (!a) return null;
  const place = index.get(a);
  return gap && !placeAt(L, real, place, true) ? null : { place, gap };
}

/** Whether round k's places below have a gap just before counting place `place`. */
export function hasGap(g, k, place) {
  const L = g.rounds[k].places;
  return !!placeAt(L, counting(L).real, place, true);
}

/** Target x (as in targets()) moved d spots along round k's places below, gaps included. */
export function stepPlace(g, k, x, d) {
  const L = g.rounds[k].places, { real, index } = counting(L);
  const a = placeAt(L, real, x.place, x.gap) || real[mod(x.place, real.length)];
  const b = L[mod(L.indexOf(a) + d, L.length)];
  return { place: index.get(b), gap: b.kind === "gap" };
}

/** Round k's graph tokens, with its stitches going where `tg` says (as targets() returns, maybe
    edited) -> {tokens, src: index of each in the stream}. Throws if a gap isn't there. */
export function roundTokens(g, tokens, k, tg = targets(g, k)) {
  const r = g.rounds[k], out = [], src = [], to = new Map(tg.map((x) => [x.i, x]));
  const { real } = r.places ? counting(r.places) : { real: [] }, n = real.length;
  let next = 0, placed = 0;
  for (let i = r.from; i < r.to; i++) {
    const t = tokens[i], nd = g.nodes[i], x = to.get(i), emit = (s) => { out.push(s); src.push(i); };
    if (t === "sk") continue;
    if (!x) { emit(nd?.via === "join" ? "sl@top" : t); continue; }
    const place = mod(x.place, n);
    if (x.gap && !placeAt(r.places, real, place, true)) throw new Error(`no gap before place ${place} below ${t}`);
    let move = mod(place - next, n);
    if (move > n / 2) move -= n;
    if (n === 1 && placed) move = -1; // the ring: one place
    emit(`${bare(t)}^${move > 0 ? "+" : ""}${move}${x.gap ? "g" : ""}`);
    next = x.gap ? place : (place + 1) % n;
    placed++;
  }
  return { tokens: out, src };
}

/** Token stream -> {tokens: graph tokens, src: index of each in the original stream}. */
export function graphTokens(tokens, g = graph(tokens)) {
  const out = { tokens: [], src: [] };
  g.rounds.forEach((r, k) => {
    const { tokens: t, src } = roundTokens(g, tokens, k);
    out.tokens.push(...t);
    out.src.push(...src);
  });
  return out;
}

/** Graph tokens -> the graph they describe (as graph() returns, without costs). */
export function readGraphTokens(tokens) {
  const plain = tokens.map((t) => MOVE.exec(t)?.[1] ?? t), given = {};
  splitRounds(tokens).forEach((r, k) => { given[k] = r; });
  const g = graph(plain, { given });
  const bad = g.rounds.findIndex((r, k) => r.places && !r.given && targets(g, k).length);
  if (bad >= 0) throw new Error(`round ${bad}: the graph tokens don't fit its stitches`);
  return g;
}

/** Words for what token i is worked into, e.g. "into the 3-chain space of round 2" (or ""). */
export function linkText(g, tokens, i) {
  const nd = g.nodes[i];
  if (!nd) return "";
  const round = (j) => g.rounds.findIndex((r) => j >= r.from && j < r.to);
  const ps = nd.parents.length ? nd.parents : nd.on || [];
  if (!ps.length) return nd.kind === "chain" ? "a chain: no parent" : "";
  const where = `round ${round(ps[0])}`;
  if (nd.kind === "col") return `stands on ${ps.length > 1 ? `the ${ps.length}-chain space` : `the ${tokens[ps[0]]}`} of ${where} (no parent: a chain)`;
  if (nd.via === "join") return `joins to the ${tokens[ps[0]]} at this round's start`;
  if (nd.via === "ring") return "into the magic ring";
  if (nd.via === "sp") return `into the ${ps.length}-chain space of ${where}`;
  if (nd.via === "gap") return `into the gap between two groups of ${where}`;
  return `into the ${tokens[ps[0]]} of ${where}`;
}
