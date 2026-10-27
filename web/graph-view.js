/* Stitch-graph panel: what each stitch is worked into, read exactly as granny-squares-llm reads
   the pattern (the code in stitches/ is copied from there by scripts/sync-stitches.sh), and a way
   to correct it.

   Each stitch's connection is shown as a graph token: "dc^0" goes into the place that is next in
   the round below, "dc^+2" two places on, "dc^-1" back into the place just used, a trailing "g"
   into the gap before that place. Rounds start as the LLM app's guess. Editing a round (or
   "Looks right") saves its graph tokens to graph.json, with the DSL line of the round and of the
   round below; if either line changes later, the round is out of date and guessed again. Only
   checked, up-to-date rounds are exported (export.py checked_graph). */

import { EOR, describe, isColor, splitRounds, tokenize } from "./stitches/dsl.js";
import { draw, layout, tokenColors } from "./stitches/chart.js";
import { graph, hasGap, linkText, placeOf, roundTokens, stepPlace, targets } from "./stitches/graph.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ed = window.editor;
const LINE = /^\s*(?:R(?:ound|nd)?\s*(\d+(?:-\d+)?)|(start))\s*:/i; // as in stitches/dsl.js

let view = null;  // {stream, g, rounds: [{label, k, line, below, saved, fresh}], colors}
let sel = null;   // token index of the selected stitch
let lastKey = null, message = "";

/** Each round's DSL line and the line of the round below it, by label (as export.py reads them). */
function dslLines(text) {
  const out = new Map();
  let below = "";
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.split("#")[0]);
    if (!m) continue;
    const label = m[2] ? "start" : m[1];
    if (out.has(label)) continue;
    out.set(label, { line: raw.trim(), below });
    below = raw.trim();
  }
  return out;
}

const roundOf = (i) => view.g.rounds.findIndex((r) => i >= r.from && i < r.to);
const parentsOf = (i) => { const nd = view.g.nodes[i]; return nd ? (nd.parents.length ? nd.parents : nd.on || []) : []; };
const placed = (i) => !!view.g.nodes[i]?.at;

function render(force = false) {
  const cur = ed.current;
  if (!cur) return;
  const key = JSON.stringify([cur.meta.id, cur.dsl, cur.meta.terms, cur.meta.abbreviations, cur.graph]);
  if (key === lastKey && !force) return;
  if (cur.meta.id !== JSON.parse(lastKey || "[null]")[0]) sel = null;
  lastKey = key;
  let t;
  try {
    t = tokenize({ dsl: cur.dsl, terms: cur.meta.terms, abbreviations: cur.meta.abbreviations });
  } catch (e) {
    view = null;
    $("#gchart").innerHTML = "";
    $("#graph-rounds").innerHTML = `<div class="warn">Can't read the machine pattern: ${esc(e.message)}</div>`;
    $("#graph-summary").textContent = "";
    return;
  }
  const stream = ["<s>", ...t.tokens], lines = dslLines(cur.dsl), given = {};
  const rounds = t.rounds.map((r, k) => {
    const L = lines.get(r.label) || {}, saved = cur.graph?.rounds?.[r.label];
    const fresh = !!saved && saved.line === L.line && saved.below === L.below;
    if (fresh) given[k] = saved.tokens.split(" ");
    return { label: r.label, k, line: L.line, below: L.below, saved, fresh };
  });
  view = { stream, rounds, g: graph(stream, { given }) };
  if (sel !== null && (sel >= stream.length || !placed(sel))) sel = null;
  drawChart();
  drawRounds();
  info();
}

function status(r) {
  const gr = view.g.rounds[r.k];
  if (gr.given) return ["checked", "checked"];
  if (r.saved) return ["stale", "out of date: guessed again"];
  return gr.cost >= 1 ? ["unclear", `guess · unclear (${gr.cost.toFixed(1)})`] : ["guess", "guess"];
}

function classes(i) {
  if (sel === null) return "";
  if (i === sel) return "sel";
  if (parentsOf(sel).includes(i)) return "par";
  const k = roundOf(sel);
  return roundOf(i) === k - 1 ? "below" : roundOf(i) === k ? "mine" : "";
}

function drawChart() {
  const { stream } = view, chart = layout(splitRounds(stream), { parentsOf });
  view.colors = tokenColors(chart, stream);
  $("#gchart").classList.toggle("selecting", sel !== null);
  $("#gchart").innerHTML = draw(chart, { style: (i) => ({ cls: classes(i) }) });
}

function drawRounds() {
  const { g, stream, rounds } = view, ro = ed.readonly;
  const rows = rounds.filter((r) => g.rounds[r.k].places).map((r) => {
    const [cls, label] = status(r), { tokens, src } = roundTokens(g, stream, r.k);
    const chips = tokens.map((t, n) => {
      const i = src[n];
      if (t === EOR) return "";
      const c = placed(i) ? classes(i) : "plain";
      return `<span class="gtok ${c}" data-i="${i}" style="--c:${view.colors[i] || "var(--muted)"}" title="${esc(linkText(g, stream, i) || describe(t))}">${esc(t)}</span>`;
    }).join("");
    const buttons = ro ? "" : `<span class="gbtns">${g.rounds[r.k].given ? "" : `<button data-act="ok" title="Save the guess as checked">Looks right</button>`}
      ${r.saved ? `<button data-act="reset" title="Forget the checked connections and use the guess">Use the guess</button>` : ""}</span>`;
    return `<div class="gr" data-k="${r.k}"><div class="ghead"><b>${r.label === "start" ? "start" : `R${esc(r.label)}`}</b>
      <span class="tag ${cls}">${esc(label)}</span>${ro || g.rounds[r.k].given ? "" : `<span class="muted">wrong? click a stitch to fix it</span>`}${buttons}</div><div class="gtoks">${chips}</div></div>`;
  });
  $("#graph-rounds").innerHTML = rows.join("") || `<div class="muted">No rounds to connect yet.</div>`;
  const all = rounds.filter((r) => g.rounds[r.k].places), done = all.filter((r) => g.rounds[r.k].given).length;
  const stale = all.filter((r) => r.saved && !g.rounds[r.k].given).length;
  $("#graph-summary").textContent = `${done}/${all.length} rounds checked${stale ? ` · ${stale} out of date` : ""}`;
}

function info(hover = null) {
  editBar();
  const i = hover ?? sel, el = $("#graph-info");
  if (!view || i === null) { el.innerHTML = message ? `<span class="flash">${esc(message)}</span>` : "Hover a stitch to see what it's worked into."; return; }
  const k = roundOf(i), r = view.rounds[k], t = view.stream[i], rt = placed(i) && roundTokens(view.g, view.stream, k);
  const tok = rt ? rt.tokens[rt.src.indexOf(i)] : t;
  el.innerHTML = `${hover !== null && hover !== sel ? "" : "<b>selected</b> "}R${esc(r?.label)} · <b>${esc(tok)}</b> · ${esc(describe(t))}`
    + `<br>${esc(linkText(view.g, view.stream, i) || "—")}${message ? `<br><span class="flash">${esc(message)}</span>` : ""}`;
}

/** What you can do now: pick a stitch, or move the selected one. */
function editBar() {
  const el = $("#graph-edit");
  if (!view || ed.readonly) { el.innerHTML = ""; return; }
  if (sel === null) { el.innerHTML = `<div class="prompt"><b>To fix a connection</b>, click a stitch in the chart or a token on the right.</div>`; return; }
  const k = roundOf(sel), below = view.rounds[k - 1];
  const name = (r) => (r?.label === "start" ? "the start" : `R${esc(r?.label)}`);
  el.innerHTML = `<div class="prompt"><b>Now click where this stitch goes</b> in ${name(below)}, the round left lit in the chart. Then the next stitch is selected.
    Hold <kbd>⇧</kbd> as you click to move the rest of ${name(view.rounds[k])} along with it, when the whole round is off.</div>
    <div class="row"><span>this stitch only</span><button data-mv="-1" data-alone="1">◀ one back</button><button data-mv="1" data-alone="1">one on ▶</button></div>
    <div class="row"><span>it and the rest of ${name(view.rounds[k])}</span><button data-mv="-1">◀ one back</button><button data-mv="1">one on ▶</button></div>
    <div class="row"><span>select</span><button data-step="-1">▲ previous stitch</button><button data-step="1">▼ next stitch</button><button data-done>done</button></div>`;
}

$("#graph-edit").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || sel === null) return;
  if (b.dataset.mv) nudge(+b.dataset.mv, !!b.dataset.alone);
  else if (b.dataset.step) stepSel(+b.dataset.step);
  else select(null);
});

function select(i) {
  sel = i;
  message = "";
  drawChart();
  drawRounds();
  info();
  document.querySelector(`.gtok[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}

/** Change where round k's stitches go (f edits targets(), see stitches/graph.js) and save it. */
function edit(k, f) {
  if (ed.readonly) return false;
  const tg = targets(view.g, k);
  f(tg);
  let tokens;
  try {
    tokens = roundTokens(view.g, view.stream, k, tg).tokens;
  } catch (e) {
    message = e.message;
    info();
    return false;
  }
  save(k, tokens);
  return true;
}

function save(k, tokens) {
  const r = view.rounds[k], rounds = { ...ed.current.graph.rounds };
  if (tokens) rounds[r.label] = { tokens: tokens.filter((t) => !isColor(t) && t !== EOR).join(" "), line: r.line, below: r.below };
  else delete rounds[r.label];
  ed.current.graph = { ...ed.current.graph, rounds };
  message = "";
  ed.graphChanged();
  render(true);
}

/** Move the selected stitch d places: alone (one spot along the round below, gaps included),
    or with the rest of the round after it (d counted places each). */
function nudge(d, alone) {
  const k = roundOf(sel);
  edit(k, (tg) => {
    const j = tg.findIndex((x) => x.i === sel);
    if (alone) { tg[j] = { ...tg[j], ...stepPlace(view.g, k, tg[j], d) }; return; }
    for (let m = j; m < tg.length; m++) {
      tg[m].place += d;
      tg[m].gap = tg[m].gap && hasGap(view.g, k, tg[m].place);
    }
  });
}

/** The next (d = 1) or previous (d = -1) stitch with a connection, across rounds. */
function stepSel(d) {
  for (let i = sel + d; i >= 0 && i < view.stream.length; i += d) if (placed(i)) return select(i);
}

$("#gchart").addEventListener("click", (e) => {
  const gEl = e.target.closest("g[data-i]");
  if (!gEl || !view) return;
  const i = +gEl.dataset.i.split(" ")[0];
  if (sel !== null && roundOf(i) === roundOf(sel) - 1 && !ed.readonly) {
    // A place in the round below: put the selected stitch there.
    const k = roundOf(sel), pl = placeOf(view.g, k, i, e.altKey);
    if (!pl) { message = e.altKey ? "There's no gap before that place." : "That isn't a place stitches go into."; info(); return; }
    const was = sel;
    const ok = edit(k, (tg) => {
      const j = tg.findIndex((x) => x.i === was), delta = pl.place - tg[j].place;
      tg[j] = { ...tg[j], ...pl };
      if (e.shiftKey) for (let m = j + 1; m < tg.length; m++) {
        tg[m].place += delta;
        tg[m].gap = tg[m].gap && hasGap(view.g, k, tg[m].place);
      }
    });
    if (ok && !e.shiftKey) stepSel(1); // on to the next stitch
    return;
  }
  if (placed(i)) select(i === sel ? null : i);
});
$("#gchart").addEventListener("mouseover", (e) => {
  const gEl = e.target.closest("g[data-i]");
  if (view) info(gEl ? +gEl.dataset.i.split(" ")[0] : null);
});
$("#gchart").addEventListener("mouseleave", () => view && info());

$("#graph-rounds").addEventListener("click", (e) => {
  const chip = e.target.closest(".gtok[data-i]"), btn = e.target.closest("button[data-act]");
  if (chip && placed(+chip.dataset.i)) return select(+chip.dataset.i === sel ? null : +chip.dataset.i);
  if (!btn) return;
  const k = +btn.closest(".gr").dataset.k;
  if (btn.dataset.act === "ok") save(k, roundTokens(view.g, view.stream, k).tokens);
  if (btn.dataset.act === "reset") save(k, null);
});

document.addEventListener("keydown", (e) => {
  if (sel === null || !view || ed.linking() || e.metaKey || e.ctrlKey) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const act = {
    ArrowLeft: () => nudge(-1, e.altKey), ArrowRight: () => nudge(1, e.altKey),
    ArrowUp: () => stepSel(-1), ArrowDown: () => stepSel(1), Escape: () => select(null),
  }[e.key];
  if (!act || (ed.readonly && ["ArrowLeft", "ArrowRight"].includes(e.key))) return;
  e.preventDefault();
  act();
});

window.graphView = { render };
render();
