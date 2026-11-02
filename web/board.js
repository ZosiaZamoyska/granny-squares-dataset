/* Review board: every pattern drawn as its chart, sorted into clusters by drag and drop.

   Clusters (and their order) live in data/board.json; status, to-dos and duplicate_of live in each
   pattern's meta.json. Dropping a card on the middle of another marks it a duplicate of that one.
   "Suggest clusters" groups unsorted patterns whose first three rounds are the same stitches in the
   same cyclic order (wherever the round starts, either direction), the usual way one granny square
   gets published many times. Charts are drawn with the LLM app's code, as in the editor. */

import { EOR, isColor, parseToken, splitRounds, tokenize } from "./stitches/dsl.js";
import { draw, layout } from "./stitches/chart.js";
import { graph } from "./stitches/graph.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const READONLY = document.documentElement.hasAttribute("data-readonly");

const STATUSES = { review: "To review", promising: "Promising", wip: "WIP", done: "Finished", permission: "Ask permission",
  duplicate: "Duplicate", rejected: "Rejected", copyright: "Copyright issue" };
const TODOS = { dsl: "Add DSL", counts: "Fix counts", spaces: "Check stitch graph / spaces", text: "Review text",
  credit: "Check credit", photo: "Add photo" };
const LINE = /^\s*(?:R(?:ound|nd)?\s*(\d+(?:-\d+)?)|(start))\s*:/i; // as in stitches/dsl.js

let pats = new Map();      // id -> {meta, dsl, graph, statuses, svg?, sig?}
let groups = [];           // [{name, ids}]
let shown = new Set(Object.keys(STATUSES));
let open = null, dragId = null;

const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

async function api(path, opts = {}) {
  if (READONLY) {
    if (opts.method) throw new Error("read-only");
    path = "/ui/board.json";
  }
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json" },
    body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function say(text) { $("#msg").textContent = text; }

const saveBoard = () => api("/api/board", { method: "PUT", body: { groups } }).catch((e) => say(`Not saved: ${e.message}`));
const saveMeta = (p) => api(`/api/patterns/${p.meta.id}`, { method: "PUT", body: { meta: p.meta } })
  .catch((e) => say(`Not saved: ${e.message}`));

// ---- charts and signatures ----------------------------------------------------

/** Each round's DSL line and the line below it, by label (as graph-view.js and export.py read them). */
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

function chartSVG(p) {
  if (!p.dsl.trim()) return `<div class="nochart">no DSL</div>`;
  try {
    const t = tokenize({ dsl: p.dsl, terms: p.meta.terms, abbreviations: p.meta.abbreviations }, { colors: true });
    const stream = ["<s>", ...t.tokens], lines = dslLines(p.dsl), given = {};
    t.rounds.forEach((r, k) => {
      const L = lines.get(r.label) || {}, saved = p.graph?.rounds?.[r.label];
      if (saved && saved.line === L.line && saved.below === L.below) given[k] = saved.tokens.split(" ");
    });
    const g = graph(stream, { given });
    const parentsOf = (i) => { const nd = g.nodes[i]; return nd ? (nd.parents.length ? nd.parents : nd.on || []) : []; };
    return draw(layout(splitRounds(stream), { parentsOf }), { empty: "no stitches" });
  } catch (e) {
    return `<div class="nochart">can't read DSL</div>`;
  }
}

/** A round as its stitches in order, rotated and mirrored to the smallest reading, so the same
    round started at another corner (or worked the other way) reads the same. */
function canonical(seq) {
  if (!seq.length) return "";
  let best = null;
  for (const s of [seq, [...seq].reverse()]) {
    for (let k = 0; k < s.length; k++) {
      const r = [...s.slice(k), ...s.slice(0, k)].join(" ");
      if (best === null || r < best) best = r;
    }
  }
  return best;
}

const SKIP = new Set(["sl", "join", "fo", "turn", "sk", "mr"]);

/** The pattern's first three rounds, each canonical: equal signatures mean the same square. */
function signature(p) {
  if (p.sig !== undefined) return p.sig;
  p.sig = "";
  if (!p.dsl.trim()) return "";
  try {
    const t = tokenize({ dsl: p.dsl, terms: p.meta.terms, abbreviations: p.meta.abbreviations }, { colors: false });
    const rounds = t.rounds.filter((r) => r.label !== "start").slice(0, 3).map((r) => canonical(
      r.tokens.filter((x) => x !== EOR && x[0] !== "<" && !isColor(x))
        .map((x) => { const q = parseToken(x); return q.as || q.st; })
        .filter((s) => !SKIP.has(s))));
    if (rounds.length) p.sig = rounds.join(" | ");
  } catch { p.sig = ""; }
  return p.sig;
}

// ---- rendering ----------------------------------------------------------------

const groupOf = (id) => groups.find((g) => g.ids.includes(id));

function visible(p) {
  const q = $("#q").value.trim().toLowerCase(), todo = $("#todo-filter").value, m = p.meta;
  if (!shown.has(m.status)) return false;
  if (todo && !(m.todo || []).includes(todo)) return false;
  return !q || [m.id, m.title, m.author, m.source].some((s) => String(s || "").toLowerCase().includes(q));
}

function card(p) {
  const m = p.meta, todos = m.todo || [];
  const flags = [];
  if (!p.dsl.trim()) flags.push(`<span class="flag bad" title="no machine pattern">no DSL</span>`);
  else if (p.statuses.includes("mismatch")) flags.push(`<span class="flag bad" title="stated counts disagree with the DSL">counts</span>`);
  if (m.status === "duplicate" && m.duplicate_of) flags.push(`<span class="flag" title="duplicate of">= ${esc(m.duplicate_of)}</span>`);
  return `<div class="card ${m.status} ${open === m.id ? "open" : ""}" data-id="${m.id}" draggable="${!READONLY}">
    <div class="chart">${p.svg ?? ""}</div>
    <div class="cap"><span class="sdot ${m.status}" title="${STATUSES[m.status] || m.status}"></span>
      <b>${m.id}</b> <span class="t">${esc(m.title || "Untitled")}</span></div>
    <div class="badges">${flags.join("")}${todos.map((t) => `<span class="todo" title="${esc(TODOS[t] || t)}">${esc(t)}</span>`).join("")}</div>
  </div>`;
}

function section(name, ids, gi) {
  const cards = ids.map((id) => pats.get(id)).filter((p) => p && visible(p));
  const tools = gi === null || READONLY ? "" : `<span class="gtools">
      <button data-act="up" title="Move cluster up">↑</button><button data-act="down" title="Move cluster down">↓</button>
      <button data-act="del" title="Delete cluster (its cards go back to Unsorted)">✕</button></span>`;
  const title = gi === null ? `<h2>Unsorted</h2>`
    : `<h2 class="gname" contenteditable="${!READONLY}" spellcheck="false">${esc(name)}</h2>`;
  return `<section class="group" data-g="${gi ?? ""}">
    <div class="ghead">${title}<span class="muted">${cards.length}${cards.length !== ids.length ? ` of ${ids.length}` : ""}</span>${tools}</div>
    <div class="grid">${cards.map(card).join("") || `<div class="empty muted">Drop cards here</div>`}</div>
  </section>`;
}

function render() {
  const grouped = new Set(groups.flatMap((g) => g.ids));
  const unsorted = [...pats.keys()].filter((id) => !grouped.has(id)).sort();
  $("#sections").innerHTML = groups.map((g, i) => section(g.name, g.ids, i)).join("") + section("", unsorted, null);
  renderFilters();
  watchCharts();
}

function renderFilters() {
  const counts = {};
  for (const p of pats.values()) counts[p.meta.status] = (counts[p.meta.status] || 0) + 1;
  $("#status-filter").innerHTML = Object.entries(STATUSES).map(([k, v]) =>
    `<button class="chip ${k} ${shown.has(k) ? "on" : ""}" data-s="${k}">${v} <small>${counts[k] || 0}</small></button>`).join("");
}

// Charts are drawn as cards scroll into view, and kept.
let observer = null;
function watchCharts() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target, p = pats.get(el.dataset.id);
      p.svg ??= chartSVG(p);
      el.querySelector(".chart").innerHTML = p.svg;
      observer.unobserve(el);
    }
  }, { rootMargin: "400px" });
  for (const el of document.querySelectorAll(".card")) {
    if (pats.get(el.dataset.id).svg === undefined) observer.observe(el);
  }
}

// ---- detail panel ---------------------------------------------------------------

function showDetail(id) {
  open = id;
  const p = pats.get(id), m = p.meta, ro = READONLY ? "disabled" : "";
  const sig = signature(p);
  const same = sig ? [...pats.values()].filter((q) => q !== p && signature(q) === sig).map((q) => q.meta.id) : [];
  p.svg ??= chartSVG(p);
  $("#detail").innerHTML = `
    <div class="bigchart">${p.svg}</div>
    <h2>${m.id} · ${esc(m.title || "Untitled")}</h2>
    <p class="muted">${esc(m.author || "no author")} · ${m.terms} terms ·
      ${m.source ? `<a href="${esc(m.source)}" target="_blank" rel="noopener">source</a>` : "no source"} ·
      <a href="/#${m.id}">open in editor</a></p>
    <p class="rounds">${p.statuses.map((s, k) => `<span class="dot ${s}" title="round ${k + 1}: ${s}"></span>`).join("") || `<span class="muted">no rounds</span>`}</p>
    <label>Status <select id="d-status" ${ro}>${Object.entries(STATUSES).map(([k, v]) =>
      `<option value="${k}" ${k === m.status ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label ${m.status === "duplicate" ? "" : "hidden"} id="d-dup-wrap">Duplicate of <input id="d-dup" value="${esc(m.duplicate_of || "")}" placeholder="id, e.g. 0040" ${ro}></label>
    <fieldset><legend>To do</legend>${Object.entries(TODOS).map(([k, v]) =>
      `<label class="check"><input type="checkbox" data-todo="${k}" ${(m.todo || []).includes(k) ? "checked" : ""} ${ro}> ${v}</label>`).join("")}</fieldset>
    <label>Notes <textarea id="d-notes" rows="4" ${ro}>${esc(m.notes || "")}</textarea></label>
    ${same.length ? `<p class="muted">Same first rounds as: ${same.map((s) => `<a href="#" data-goto="${s}">${s}</a>`).join(", ")}</p>` : ""}`;
  $("#panel").hidden = false;
  for (const el of document.querySelectorAll(".card.open")) el.classList.remove("open");
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add("open");
}

function setMeta(id, change, { rerender = true } = {}) {
  const p = pats.get(id);
  Object.assign(p.meta, change);
  if (p.meta.status !== "duplicate") p.meta.duplicate_of = "";
  saveMeta(p);
  if (rerender) render();
}

$("#detail").addEventListener("change", (e) => {
  const t = e.target, p = pats.get(open);
  if (t.id === "d-status") {
    setMeta(open, { status: t.value });
    $("#d-dup-wrap").hidden = t.value !== "duplicate";
  } else if (t.id === "d-dup") setMeta(open, { duplicate_of: t.value.trim() });
  else if (t.dataset.todo) {
    const todo = new Set(p.meta.todo || []);
    t.checked ? todo.add(t.dataset.todo) : todo.delete(t.dataset.todo);
    setMeta(open, { todo: Object.keys(TODOS).filter((k) => todo.has(k)) });
  }
});
$("#detail").addEventListener("input", (e) => {
  if (e.target.id !== "d-notes") return;
  clearTimeout(e.target._t);
  e.target._t = setTimeout(() => setMeta(open, { notes: e.target.value }, { rerender: false }), 500);
});
$("#detail").addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (!go) return;
  e.preventDefault();
  showDetail(go.dataset.goto);
  document.querySelector(`.card[data-id="${go.dataset.goto}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
});
const closePanel = () => { open = null; $("#panel").hidden = true; document.querySelector(".card.open")?.classList.remove("open"); };
$("#close").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

// ---- drag and drop --------------------------------------------------------------
// A card dropped on the left or right part of another goes before or after it; on its middle,
// it becomes that card's duplicate (and joins its cluster). On empty cluster space: to the end.

function zone(e, el) {
  const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  return x < 0.3 ? "before" : x > 0.7 ? "after" : "dup";
}

function clearMarks() {
  for (const el of document.querySelectorAll(".before, .after, .dup, .over")) el.classList.remove("before", "after", "dup", "over");
}

/** Take id out of every cluster, then put it in cluster gi (null: Unsorted) at index at. */
function moveTo(id, gi, at = null) {
  for (const g of groups) g.ids = g.ids.filter((x) => x !== id);
  if (gi === null) return;
  const ids = groups[gi].ids;
  ids.splice(at ?? ids.length, 0, id);
}

const sections = $("#sections");
sections.addEventListener("dragstart", (e) => {
  const c = e.target.closest(".card");
  if (!c) return;
  dragId = c.dataset.id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
  c.classList.add("dragging");
});
sections.addEventListener("dragend", () => { dragId = null; clearMarks(); document.querySelector(".dragging")?.classList.remove("dragging"); });
sections.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const sec = e.target.closest(".group");
  if (!sec) return;
  e.preventDefault();
  clearMarks();
  const c = e.target.closest(".card");
  if (c && c.dataset.id !== dragId) c.classList.add(zone(e, c));
  else sec.classList.add("over");
});
sections.addEventListener("dragleave", (e) => { if (!sections.contains(e.relatedTarget)) clearMarks(); });
sections.addEventListener("drop", (e) => {
  const sec = e.target.closest(".group");
  if (!dragId || !sec) return;
  e.preventDefault();
  const id = dragId, c = e.target.closest(".card"), gi = sec.dataset.g === "" ? null : +sec.dataset.g;
  clearMarks();
  if (c && c.dataset.id !== id) {
    const target = c.dataset.id, z = zone(e, c);
    if (z === "dup") {
      const tg = groupOf(target);
      if (tg) moveTo(id, groups.indexOf(tg), tg.ids.filter((x) => x !== id).indexOf(target) + 1);
      setMeta(id, { status: "duplicate", duplicate_of: target }, { rerender: false });
      say(`${id} marked as a duplicate of ${target}.`);
    } else if (gi !== null) {
      moveTo(id, gi);
      const ids = groups[gi].ids;
      ids.splice(ids.indexOf(id), 1);
      ids.splice(ids.indexOf(target) + (z === "after" ? 1 : 0), 0, id);
    } else moveTo(id, null); // Unsorted is kept in id order
  } else if (!c) moveTo(id, gi);
  saveBoard();
  render();
  if (open) showDetail(open);
});

sections.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) {
    const gi = +b.closest(".group").dataset.g;
    if (b.dataset.act === "del") groups.splice(gi, 1);
    else {
      const j = gi + (b.dataset.act === "up" ? -1 : 1);
      if (j < 0 || j >= groups.length) return;
      [groups[gi], groups[j]] = [groups[j], groups[gi]];
    }
    saveBoard();
    render();
    return;
  }
  const c = e.target.closest(".card");
  if (c) showDetail(c.dataset.id);
});
sections.addEventListener("keydown", (e) => {
  if (e.target.classList.contains("gname") && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
});
sections.addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("gname")) return;
  const g = groups[+e.target.closest(".group").dataset.g], name = e.target.textContent.trim();
  if (g && name !== g.name) { g.name = name || "Untitled cluster"; saveBoard(); }
});

// ---- toolbar ---------------------------------------------------------------------

$("#todo-filter").innerHTML += Object.entries(TODOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
for (const id of ["#q", "#todo-filter"]) $(id).addEventListener("input", render);
$("#status-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-s]");
  if (!b) return;
  const s = b.dataset.s;
  // Alt-click: show only this status.
  if (e.altKey) shown = new Set([s]);
  else shown.has(s) ? shown.delete(s) : shown.add(s);
  pref("board.shown", [...shown].join(","));
  render();
});
$("#charts-only").addEventListener("change", (e) => {
  document.body.classList.toggle("charts-only", e.target.checked);
  pref("board.chartsOnly", e.target.checked ? "1" : "");
});
$("#size").addEventListener("input", (e) => {
  document.body.style.setProperty("--card", `${e.target.value}px`);
  pref("board.size", e.target.value);
});
$("#add-group").addEventListener("click", () => {
  groups.unshift({ name: "New cluster", ids: [] });
  saveBoard();
  render();
  const h = document.querySelector(".gname");
  h?.focus();
  document.getSelection().selectAllChildren(h);
});
$("#suggest").addEventListener("click", () => {
  const grouped = new Set(groups.flatMap((g) => g.ids)), bySig = new Map();
  for (const p of pats.values()) {
    const sig = signature(p);
    if (!sig || grouped.has(p.meta.id) || ["rejected", "copyright"].includes(p.meta.status)) continue;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(p.meta.id);
  }
  const found = [...bySig.values()].filter((ids) => ids.length > 1).sort((a, b) => b.length - a.length);
  for (const ids of found) groups.push({ name: `Like ${ids[0]}: ${pats.get(ids[0]).meta.title || "Untitled"}`, ids: ids.sort() });
  say(found.length ? `Made ${found.length} clusters of patterns with the same first rounds (${found.flat().length} patterns).`
    : "No unsorted patterns share their first rounds.");
  if (found.length) saveBoard();
  render();
});

// ---- start ----------------------------------------------------------------------

async function load() {
  const data = await api("/api/board");
  pats = new Map(data.patterns.map((p) => [p.meta.id, p]));
  groups = data.groups.map((g) => ({ name: g.name, ids: g.ids.filter((id) => pats.has(id)) }));
  const saved = pref("board.shown");
  if (saved !== null) shown = new Set(saved.split(",").filter((s) => s in STATUSES));
  const size = pref("board.size") || 170;
  $("#size").value = size;
  document.body.style.setProperty("--card", `${size}px`);
  $("#charts-only").checked = pref("board.chartsOnly") === "1";
  document.body.classList.toggle("charts-only", $("#charts-only").checked);
  if (READONLY) { document.body.classList.add("readonly"); for (const b of ["#suggest", "#add-group"]) $(b).hidden = true; }
  render();
}

load().catch((e) => say(`Couldn't load the board: ${e.message}`));
