/* Parser for the granny-square pattern DSL (port of granny/dsl.py in granny-squares-dataset),
   plus the stitch tokenizer: a pattern unrolled into one token per stitch.

   A stitch token says what the stitch is and where the hook goes:
     "dc"         dc into the next stitch
     "dc@corner"  dc into the corner space (also @ring @sp @same @top @st @side, and @start: the
                  place the round's first stitch went into, to finish a group split over the join)
     "dc+"        dc into the same place as the stitch before it (the rest of a {…}@place group)
     "ch3=dc"     beginning chain that counts as a stitch
     "ch" "sk" "sl@top" "turn" "fo"   one chain / skip / slip stitch / …
     "C2"         change to yarn colour 2 (a separate layer: tokenize(rec, {colors: false}) leaves
                  these out, and what is left is the pattern's structure alone)
     "mr"         magic ring (the start line), "↵" end of round (the start line ends in one too)
   Repeats are unrolled ("[3dc 3ch]x3" becomes 18 tokens). A "[…]>corner" repeat goes as many
   times as the round below leaves room for: until what follows it reaches the corner (">sp": the
   next chain space, ">end": the end of the round below). Without a round below to count on, or
   for another landmark, it is written out once. */

const ALIASES = { ss: "sl", slst: "sl", skip: "sk", magicring: "mr" };
export const UK_TO_US = { dc: "sc", htr: "hdc", tr: "dc", dtr: "tr", ttr: "dtr", qtr: "trtr" };
export const EOR = "↵";
export const isColor = (t) => /^C\d+$/.test(t);

const TOKEN = /([\s,]+)|(\{)|(\})|(\[)|(\])|(x(\d+)\b)|(>([a-z][\w-]*))|(@([a-z][\w-]*))|(c(\d+)@)|((\d+)?([a-z]+)(?:=([a-z]+))?)/iy;
const LINE = /^\s*(?:R(?:ound|nd)?\s*(\d+(?:-\d+)?)|(start))\s*:\s*(.*)$/i;

function lex(text) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex, m = TOKEN.exec(text);
    if (!m) throw new Error(`unexpected ${JSON.stringify(text.slice(at, at + 10))} at column ${at + 1}`);
    if (m[1]) continue;
    const end = TOKEN.lastIndex;
    if (m[2]) out.push({ k: "{", end });
    else if (m[3]) out.push({ k: "}", end });
    else if (m[4]) out.push({ k: "[", end });
    else if (m[5]) out.push({ k: "]", end });
    else if (m[6]) out.push({ k: "times", n: +m[7], end });
    else if (m[8]) out.push({ k: "until", landmark: m[9].toLowerCase(), end });
    else if (m[10]) out.push({ k: "at", place: m[11].toLowerCase(), start: at, end });
    else if (m[12]) out.push({ k: "color", color: `C${+m[13]}`, end });
    else out.push({ k: "op", count: m[15] ? +m[15] : 1, st: m[16].toLowerCase(), as: m[17]?.toLowerCase() || null, end });
  }
  return out;
}

function parseItems(toks, i, closer, abbrevs) {
  const items = [];
  while (i < toks.length) {
    if (toks[i].k === closer) return [items, i + 1];
    let item;
    [item, i] = parseItem(toks, i, abbrevs);
    items.push(item);
  }
  if (closer) throw new Error(`missing closing ${closer}`);
  return [items, i];
}

function parseItem(toks, i, abbrevs, block = false) {
  const t = toks[i];
  if (t.k === "color") {
    if (!["op", "{", "["].includes(toks[i + 1]?.k)) throw new Error(`${t.color}@ must be followed by a stitch, {…} or […]`);
    const [item, j] = parseItem(toks, i + 1, abbrevs, true);
    return [{ type: "color", color: t.color, items: Array.isArray(item) ? item : [item] }, j];
  }
  if (t.k === "{") {
    let [inner, j] = parseItems(toks, i + 1, "}", abbrevs);
    if (toks[j]?.k === "at") return [{ type: "group", items: inner, place: toks[j].place }, j + 1];
    if (block) return [inner, j]; // C2@{…}: a colour block, not worked into one place
    return [{ type: "group", items: inner, place: null }, j];
  }
  if (t.k === "[") {
    const [inner, j] = parseItems(toks, i + 1, "]", abbrevs);
    const r = toks[j];
    if (!r || (r.k !== "times" && r.k !== "until")) throw new Error("[…] must be followed by xN or >landmark");
    return [{ type: "repeat", items: inner, times: r.k === "times" ? r.n : null, until: r.landmark || null }, j + 1];
  }
  if (t.k === "op") {
    const st = ALIASES[t.st] || t.st;
    const op = { type: "op", st, count: t.count, as: t.as, place: null, expand: abbrevs[st] || null };
    i += 1;
    if (toks[i]?.k === "at" && toks[i].start === t.end) op.place = toks[i++].place;
    return [op, i];
  }
  throw new Error(`unexpected ${t.k}`);
}

export function parseAbbreviations(defs) {
  const out = {};
  for (const d of defs || []) {
    const abbr = (d.abbr || "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(abbr) || !(d.dsl || "").trim()) continue;
    out[abbr] = parseItems(lex(d.dsl), 0, null, {})[0];
  }
  return out;
}

/** DSL text -> [{label, items}] (labels "start", "1", …). */
export function parse(text, abbrevs = {}) {
  const lines = [];
  text.split("\n").forEach((raw, n) => {
    const code = raw.split("#")[0];
    if (!code.trim()) return;
    const m = LINE.exec(code);
    if (!m) throw new Error(`line ${n + 1}: must start with 'R<n>:' or 'start:'`);
    try {
      lines.push({ label: m[2] ? "start" : m[1], items: parseItems(lex(m[3]), 0, null, abbrevs)[0] });
    } catch (e) {
      throw new Error(`line ${n + 1}: ${e.message}`);
    }
  });
  return lines;
}

// ---- stitch tokens ----------------------------------------------------------

// ---- "[…]>corner": how many times, from the round below ---------------------

/** The round below's places in working order ({sp: true, n} a chain space, {sp: true, gap: true}
    the space a skip leaves between two stitches, {same} a stitch top), and its corners: the four
    longest chain spaces, or else the four inside stitch groups ("{3dc 2ch 3dc}@sp"), as the chart
    finds them. Gaps only count as spaces when the round has no chain spaces besides its corners
    (then "@sp" can only mean them). */
function placesOf(tokens, gaps = true) {
  const ps = [];
  let prev = null, skipped = false;
  for (const t of tokens) {
    const p = parseToken(t);
    if (p.st === "sk") skipped = ps.length > 0;
    if (["eor", "color", "sk", "sl", "turn", "fo", "mr"].includes(p.st)) continue;
    if (p.st === "ch" && !p.as) {
      if (!ps.length) continue; // a chain that opens the round is the beginning chain
      if (prev.sp && !prev.gap) prev.n += 1; else ps.push(prev = { sp: true, n: 1 });
    } else {
      if (gaps && skipped && !p.same && !prev.sp) ps.push({ sp: true, gap: true, n: 0 });
      ps.push(prev = { same: p.same });
    }
    skipped = false;
  }
  const sps = ps.map((x, i) => (x.sp && !x.gap ? i : -1)).filter((i) => i >= 0);
  const longest = Math.max(0, ...sps.map((i) => ps[i].n));
  let corners = sps.filter((i) => ps[i].n === longest);
  if (corners.length !== 4) corners = sps.filter((i) => ps[i + 1]?.same);
  if (corners.length !== 4) corners = [];
  if (gaps && sps.length > corners.length) return placesOf(tokens, false);
  return { ps, corners: new Set(corners) };
}

/** Move the hook along the round below for one token: {from, at} (where the search for its place
    started, and the place), null if it uses no new place, false if the round below has run out. */
function step(cur, t) {
  const p = parseToken(t);
  if (["eor", "color", "turn", "fo", "mr"].includes(p.st) || (p.st === "ch" && !p.as) || p.same) return null;
  let test = (x) => !x.sp; // the next stitch
  if (p.st === "sk") test = (x) => !x.gap; // a skip passes gaps by
  else if (p.place === "same") { if (cur.last !== null) return null; test = () => true; }
  else if (p.place === "sp") test = (x) => x.sp;
  else if (p.place === "corner") test = cur.corners.size ? (x, i) => cur.corners.has(i) : (x) => x.sp;
  else if (p.place && p.place !== "st") return null; // ring, top, start, side
  else if (p.as && cur.moved) return null; // a beginning chain stands where the slip stitches went
  let at = cur.c;
  while (at < cur.ps.length && !test(cur.ps[at], at)) at += 1;
  if (at >= cur.ps.length) return false;
  const from = cur.c;
  Object.assign(cur, { c: at + 1, last: at, moved: cur.moved || p.st === "sl" });
  return { from, at };
}

/** Does the round still work out with the repeat n times? Neither the repeat nor what follows it
    (cont) may pass the landmark; the first place of the landmark kind that what follows reaches is
    it. mark(i): is place i a landmark (null for ">end": only, don't run out). */
function fits(cur0, once, n, cont, mark) {
  const cur = { ...cur0 };
  const hit = (r) => { for (let i = r.from; i <= r.at; i++) if (mark(i)) return i === r.at ? "lands" : "passes"; return null; };
  for (let k = 0; k < n; k++) {
    for (const t of once) {
      const r = step(cur, t);
      if (r === false || (r && mark && hit(r))) return false;
    }
  }
  for (const t of cont) {
    const r = step(cur, t);
    if (r === false) return false;
    const h = r && mark ? hit(r) : null;
    if (h) return h === "lands";
  }
  return true;
}

/** Does the round open with a corner group ("3ch=dc {dc 2ch 2dc}@same …", maybe after slip
    stitches into the corner)? How many slip stitches come first, or -1. */
function opensWithCorner(tokens) {
  const ts = tokens.filter((t) => !isColor(t));
  let i = 0;
  while (ts[i] && parseToken(ts[i]).st === "sl") i += 1;
  const first = ts[i] && parseToken(ts[i]);
  if (!first || first.same || (first.st === "ch" && !first.as)) return -1;
  let chain = false;
  for (const t of ts.slice(i + 1)) {
    const p = parseToken(t);
    if (p.st === "ch" && !p.as) chain = true;
    else if (!p.same && p.place !== "same") return -1;
    else if (chain) return i;
  }
  return -1;
}

/** How many times "[once]>landmark" goes, given the round below (below: placesOf) and the round so
    far (done: its tokens). Unknown landmarks, or no round below to count, give 1. */
function untilCount(landmark, once, cont, below, done) {
  if (!below?.ps.length) return 1;
  let cur = { ...below, c: 0, last: null, moved: false };
  const k = Math.min(...below.corners), skip = opensWithCorner(done);
  if (skip >= 0 && k <= 3) {
    // The round starts in the round below's first corner (its slip stitches went there), and the
    // places before that corner come last.
    const n = below.ps.length;
    below = { ps: [...below.ps.slice(k), ...below.ps.slice(0, k)], corners: new Set([...below.corners].map((i) => (i - k + n) % n)) };
    cur = { ...below, c: 1, last: 0, moved: true };
    done = done.filter((t) => !isColor(t)).slice(skip);
  }
  const mark = { corner: below.corners.size ? (i) => below.corners.has(i) : null, sp: (i) => below.ps[i].sp, end: null }[landmark];
  if (mark === undefined || (landmark === "corner" && !mark)) return 1;
  for (const t of done) step(cur, t);
  const probe = { ...cur };
  for (const t of once) step(probe, t);
  if (probe.c === cur.c || !fits(cur, once, 0, cont, mark)) return 1; // nothing to count with
  let n = 0;
  while (n < below.ps.length && fits(cur, once, n + 1, cont, mark)) n += 1;
  return n;
}

/** One round's items -> stitch tokens. state carries the yarn colour across rounds; below: the
    round below's placesOf, to count "[…]>corner" repeats (once each without it). */
function unroll(items, rename, state, out, below = null) {
  const emit = (tok, color) => {
    if (color && color !== state.color) {
      out.push(color);
      state.color = color;
    }
    out.push(tok);
  };
  // gp: the {…}@place group being worked, {place, used}. Its first stitch goes into the
  // place and the rest are "+"; stitches into a ring each say "@ring" (they don't share a base).
  const where = (gp) => {
    if (!gp) return "";
    if (gp.place === "ring") return "@ring";
    if (gp.used) return "+";
    gp.used = true;
    return `@${gp.place}`;
  };
  // A copy of some items' tokens, to try out ("[…]>corner" inside them written once).
  const tryOut = (items, color, gp) => {
    const saved = { color: state.color }, keep = out.length, b = below;
    below = null;
    walk(items, color, gp && { ...gp });
    below = b;
    state.color = saved.color;
    return out.splice(keep);
  };
  // after: the items that follow these ones, for what comes after a "[…]>corner" repeat.
  const walk = (items, color, gp, after = []) => {
    items.forEach((it, j) => {
      const rest = () => [...items.slice(j + 1), ...after];
      if (it.type === "op" && it.expand) {
        for (let k = 0; k < it.count; k++) walk(it.expand, color, it.place ? { place: it.place, used: false } : gp);
      } else if (it.type === "op") {
        const st = rename[it.st] || it.st;
        // "3dc@sp": three dc into one space, so the 2nd and 3rd are "+".
        const own = it.place ? { place: it.place, used: false } : gp;
        if (st === "ch" && it.as) emit(`ch${it.count}=${rename[it.as] || it.as}${where(own)}`, color);
        else if (st === "ch" || st === "sk") for (let k = 0; k < it.count; k++) emit(st, color);
        else if (st === "sl" || st === "join") emit(st === "join" ? "sl@top" : `sl${it.place ? `@${it.place}` : ""}`, color);
        else if (["turn", "fo", "mr"].includes(st)) emit(st, color);
        else for (let k = 0; k < it.count; k++) emit(st + where(own), color);
      } else if (it.type === "group") {
        // A group without @place is a transcription slip for @same (the chart fans it too).
        walk(it.items, color, { place: it.place || "same", used: false }, rest());
      } else if (it.type === "color") {
        walk(it.items, it.color, gp, rest());
      } else {
        const times = it.times || (below ? untilCount(it.until, tryOut(it.items, color, gp), tryOut(rest(), color, gp), below, out) : 1);
        for (let k = 0; k < times; k++) walk(it.items, color, gp, it.until || k === times - 1 ? rest() : [...it.items, ...rest()]);
      }
    });
  };
  walk(items, null, null);
}

/** A dataset record ({dsl, terms, abbreviations}) -> {rounds: [{label, tokens}], tokens: flat stream}.
    colors: false drops the yarn-colour tokens, leaving only the structure. */
export function tokenize(rec, { colors = true } = {}) {
  const rename = (rec.terms || "US").toUpperCase() === "UK" ? UK_TO_US : {};
  const lines = parse(rec.dsl, parseAbbreviations(rec.abbreviations));
  const state = { color: null };
  let below = null;
  const rounds = lines.map((l) => {
    const out = [];
    unroll(l.items, rename, state, out, below);
    below = placesOf(out);
    return { label: l.label, tokens: [...(colors ? out : out.filter((t) => !isColor(t))), EOR] };
  });
  return { rounds, tokens: rounds.flatMap((r) => r.tokens) };
}

/** Split a flat token stream into rounds, each ending in "↵" (except an unfinished last one). */
export function splitRounds(tokens) {
  const rounds = [[]];
  for (const t of tokens) {
    rounds[rounds.length - 1].push(t);
    if (t === EOR) rounds.push([]);
  }
  if (!rounds[rounds.length - 1].length) rounds.pop();
  return rounds;
}

/** "dc@corner" -> {st: "dc", place: "corner"}, "dc+" -> {st: "dc", same: true}, "ch3=dc" -> {st: "ch", n: 3, as: "dc"}. */
export function parseToken(t) {
  if (t === EOR) return { st: "eor" };
  if (isColor(t)) return { st: "color", color: t };
  const m = /^([a-z]+?)(\d+)?(?:=([a-z]+))?(\+|@([a-z]+))?$/.exec(t);
  if (!m) return { st: t };
  return { st: m[1], n: m[2] ? +m[2] : 1, as: m[3] || null, same: m[4] === "+", place: m[5] || null };
}

/** Human words for a token, for tooltips. */
const NAMES = { ch: "chain", sl: "slip stitch", sk: "skip a stitch", turn: "turn", fo: "fasten off", mr: "magic ring",
  sc: "single crochet", hdc: "half double crochet", dc: "double crochet", tr: "treble", dtr: "double treble", trtr: "triple treble" };
export function describe(t) {
  const p = parseToken(t);
  if (p.st === "eor") return "end of round";
  if (p.st === "color") return `change to yarn ${p.color}`;
  let s = p.as ? `${p.n} chains (count as ${NAMES[p.as] || p.as})` : NAMES[p.st] || p.st;
  if (p.same) s += ", into the same place as the last stitch";
  else if (p.place) s += { ring: " into the ring", sp: " into the next space", corner: " into the corner space", same: " into the same place",
    top: " into the top of the beginning chain", st: " into the next stitch", side: " into the side",
    start: " into the same place as the round's first stitch" }[p.place] || ` @${p.place}`;
  return s;
}
