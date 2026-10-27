/* Parser for the granny-square pattern DSL (port of granny/dsl.py in granny-squares-dataset),
   plus the stitch tokenizer: a pattern unrolled into one token per stitch.

   A stitch token says what the stitch is and where the hook goes:
     "dc"         dc into the next stitch
     "dc@corner"  dc into the corner space (also @ring @sp @same @top @st @side)
     "dc+"        dc into the same place as the stitch before it (the rest of a {…}@place group)
     "ch3=dc"     beginning chain that counts as a stitch
     "ch" "sk" "sl@top" "turn" "fo"   one chain / skip / slip stitch / …
     "C2"         change to yarn colour 2 (a separate layer: tokenize(rec, {colors: false}) leaves
                  these out, and what is left is the pattern's structure alone)
     "mr"         magic ring (the start line), "↵" end of round (the start line ends in one too)
   Repeats are unrolled ("[3dc 3ch]x3" becomes 18 tokens); a ">corner" repeat, whose length
   depends on the previous round, is written out once, the same as the chart does. */

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

/** One round's items -> stitch tokens. state carries the yarn colour across rounds. */
function unroll(items, rename, state, out) {
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
  const walk = (items, color, gp) => {
    for (const it of items) {
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
        walk(it.items, color, { place: it.place || "same", used: false });
      } else if (it.type === "color") {
        walk(it.items, it.color, gp);
      } else {
        for (let k = 0; k < (it.times || 1); k++) walk(it.items, color, gp);
      }
    }
  };
  walk(items, null, null);
}

/** A dataset record ({dsl, terms, abbreviations}) -> {rounds: [{label, tokens}], tokens: flat stream}.
    colors: false drops the yarn-colour tokens, leaving only the structure. */
export function tokenize(rec, { colors = true } = {}) {
  const rename = (rec.terms || "US").toUpperCase() === "UK" ? UK_TO_US : {};
  const lines = parse(rec.dsl, parseAbbreviations(rec.abbreviations));
  const state = { color: null };
  const rounds = lines.map((l) => {
    const out = [];
    unroll(l.items, rename, state, out);
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
    top: " into the top of the beginning chain", st: " into the next stitch", side: " into the side" }[p.place] || ` @${p.place}`;
  return s;
}
