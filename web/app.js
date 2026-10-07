const $ = (s) => document.querySelector(s);
const META_FIELDS = ["title", "terms", "source", "author", "license", "notes"];
const IMAGE_KINDS = ["finished", "in-progress", "chart", "diagram", "other"];

let current = null; // {meta, human, dsl}
let saveTimer = null, checkTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---- list ---------------------------------------------------------------

async function loadList() {
  const items = await api("/api/patterns");
  $("#list").innerHTML = items.map((p) => `
    <li data-id="${p.id}" class="${current?.meta.id === p.id ? "active" : ""}">
      <div>${esc(p.title || "Untitled")}</div>
      <div class="sub">${p.id} · ${p.terms} · ${p.rounds} rnds · ${p.images.length} img
        ${p.statuses.map((s) => `<span class="dot ${s}" title="${s}"></span>`).join("")}</div>
    </li>`).join("");
}

$("#list").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) openPattern(li.dataset.id);
});

$("#new").addEventListener("click", async () => {
  const { id } = await api("/api/patterns", { method: "POST", body: { title: "" } });
  await openPattern(id);
  $("#title").focus();
});

// ---- editor -------------------------------------------------------------

async function openPattern(id) {
  await flushSave();
  current = await api(`/api/patterns/${id}`);
  location.hash = id;
  $("#empty").hidden = true;
  $("#editor").hidden = false;
  for (const f of META_FIELDS) $("#" + f).value = current.meta[f] ?? "";
  $("#human").value = current.human;
  $("#dsl").value = current.dsl;
  if (linking) stopLinking();
  links = null;
  $("#gen").textContent = "";
  clearMarks();
  $("#save-state").textContent = "";
  renderImages();
  runCheck();
  loadList();
}

for (const f of META_FIELDS) {
  $("#" + f).addEventListener("input", () => { current.meta[f] = $("#" + f).value; changed(); });
}
for (const f of ["human", "dsl"]) {
  $("#" + f).addEventListener("input", () => { current[f] = $("#" + f).value; links = null; clearMarks(); changed(); });
}

function changed() {
  $("#save-state").textContent = "Unsaved…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 250);
}

async function save() {
  saveTimer = null;
  if (!current) return;
  const { meta, human, dsl, links } = current;
  try {
    await api(`/api/patterns/${meta.id}`, { method: "PUT", body: { meta, human, dsl, links } });
    $("#save-state").textContent = "Saved";
    loadList();
  } catch (e) {
    $("#save-state").textContent = "Save failed: " + e.message;
  }
}

async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); flushSave(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); setFolded(!document.body.classList.contains("folded")); }
});

function setFolded(folded) {
  document.body.classList.toggle("folded", folded);
  $("#fold").textContent = folded ? "»" : "«";
  $("#fold").title = (folded ? "Unfold" : "Fold") + " sidebar (⌘B)";
  try { localStorage.setItem("sidebarFolded", folded ? "1" : ""); } catch {}
}
$("#fold").addEventListener("click", () => setFolded(!document.body.classList.contains("folded")));
try { setFolded(!!localStorage.getItem("sidebarFolded")); } catch {}
window.addEventListener("beforeunload", (e) => { if (saveTimer) { save(); e.preventDefault(); } });

$("#toggle-help").addEventListener("click", (e) => { e.preventDefault(); $("#help").hidden = !$("#help").hidden; });

// ---- images -------------------------------------------------------------

function renderPhoto() {
  const imgs = current.meta.images;
  const img = imgs.find((i) => i.kind === "finished") || imgs[0];
  $("#chart-photo").innerHTML = img
    ? `<img src="/images/${current.meta.id}/${encodeURIComponent(img.file)}" alt="${esc(img.caption || "photo")}">` : "";
}

function renderImages() {
  renderPhoto();
  const id = current.meta.id;
  $("#images").innerHTML = current.meta.images.map((img, i) => `
    <div class="img" data-i="${i}">
      <img src="/images/${id}/${encodeURIComponent(img.file)}" alt="${esc(img.caption)}">
      <div class="fields">
        <select data-k="kind">${IMAGE_KINDS.map((k) => `<option ${k === img.kind ? "selected" : ""}>${k}</option>`).join("")}</select>
        <input data-k="round" type="number" min="0" placeholder="rnd" title="Shows the square after this round" value="${img.round ?? ""}">
        <input data-k="caption" class="cap" placeholder="caption" value="${esc(img.caption)}">
        <button class="del">remove</button>
      </div>
    </div>`).join("");
}

$("#images").addEventListener("input", (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  const img = current.meta.images[e.target.closest(".img").dataset.i];
  img[k] = k === "round" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value;
  changed();
});

$("#images").addEventListener("click", async (e) => {
  const card = e.target.closest(".img");
  if (!card) return;
  const img = current.meta.images[card.dataset.i];
  if (e.target.classList.contains("del")) {
    if (!confirm(`Remove ${img.file}?`)) return;
    await flushSave();
    const p = await api(`/api/patterns/${current.meta.id}/images/${encodeURIComponent(img.file)}`, { method: "DELETE" });
    current.meta.images = p.meta.images;
    renderImages(); loadList();
  } else if (e.target.tagName === "IMG") {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = `<img src="${e.target.src}">`;
    box.onclick = () => box.remove();
    document.body.append(box);
  }
});

async function upload(files) {
  await flushSave();
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const data = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.readAsDataURL(file);
    });
    const ext = file.type.split("/")[1].replace("jpeg", "jpg");
    const filename = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.${ext}`;
    const p = await api(`/api/patterns/${current.meta.id}/images`, { method: "POST", body: { filename, data } });
    current.meta.images = p.meta.images;
  }
  renderImages(); loadList();
}

const drop = $("#images");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); upload(e.dataTransfer.files); });
$("#file").addEventListener("change", (e) => { upload(e.target.files); e.target.value = ""; });
document.addEventListener("paste", (e) => {
  if (!current) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); upload(files); }
});

// ---- alignment ----------------------------------------------------------

const fmtCounts = (c, diffs = {}) => Object.entries(c)
  .map(([k, v]) => diffs[k] ? `<span class="diff">${v} ${k}</span>` : `${v} ${k}`).join("<br>");

async function runCheck() {
  if (!current) return;
  const { human, dsl } = current;
  const r = await api("/api/check", { method: "POST", body: { human, dsl, terms: current.meta.terms } });
  if (current.human !== human || current.dsl !== dsl) return; // stale; a newer check is queued
  links = r.links;
  report = r;
  renderGen([]);
  renderProgress();
  drawChart(r.chart);
  $("#errors").innerHTML = r.errors.map((e) => `<div>${esc(e)}</div>`).join("");
  const n = r.rounds.length, ok = r.rounds.filter((x) => x.status === "ok").length;
  $("#summary").textContent = n ? `${ok}/${n} rounds verified` : "";

  let rows = "";
  if (r.preamble || r.start) {
    rows += `<tr data-label="start"><td class="muted">start</td><td>${esc(r.preamble)}</td><td class="code">${esc(r.start)}</td><td></td><td></td><td></td></tr>`;
  }
  rows += r.rounds.map((x) => {
    // Show only the computed keys that matter: the stated ones, or stitches/spaces if none stated.
    const keys = Object.keys(x.stated).length ? Object.keys(x.stated)
      : Object.keys(x.computed).filter((k) => !["join", "turn", "fo", "mr", "sl"].includes(k));
    const computed = Object.fromEntries(keys.map((k) => [k, x.computed[k] ?? 0]));
    const warn = [...x.warnings, ...(x.exact ? [] : ["contains >landmark repeat: counts are a lower bound"])];
    return `<tr data-label="${esc(x.label)}">
      <td>${esc(x.label)}</td>
      <td>${esc(x.human ?? "—")}</td>
      <td class="code">${esc(x.dsl ?? "—")}${warn.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}</td>
      <td class="counts">${fmtCounts(x.stated)}</td>
      <td class="counts">${x.dsl ? fmtCounts(computed, x.diffs) : ""}</td>
      <td><span class="tag ${x.status}">${x.status}</span></td>
    </tr>`;
  }).join("");
  $("#rounds tbody").innerHTML = rows;
  if (["human", "dsl"].includes(document.activeElement?.id)) followSelection();
}

// ---- highlighting --------------------------------------------------------
// Three panes: original (#human), machine (#dsl), uniform (#gen, generated from the DSL).
// Links machine <-> uniform are exact; machine <-> original are the ones you confirm in link mode.

let report = null; // last /api/check result
let links = null; // report.links: {rounds, dsl: [{s, e, r, i, g, run, link}], human: [...], gen}

const RANK = { done: 0.5, none: 0.5, stale: 0.7, soft: 1, strong: 2, src: 3, cur: 3, cand: 3, brace: 4, "brace-bad": 4 };

function marksHTML(text, ranges) {
  // Per-character class, strongest wins; then emit runs.
  const cls = new Array(text.length).fill("");
  for (const { s, e, c } of ranges) {
    for (let i = Math.max(0, s); i < Math.min(e, text.length); i++) {
      if (!cls[i] || RANK[c] > RANK[cls[i]]) cls[i] = c;
    }
  }
  let html = "", i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && cls[j] === cls[i]) j++;
    const chunk = esc(text.slice(i, j));
    html += cls[i] ? `<mark class="${cls[i]}">${chunk}</mark>` : chunk;
    i = j;
  }
  return html;
}

function renderBack(side, ranges) {
  $("#" + side + "-back").innerHTML = marksHTML($("#" + side).value, ranges) + "\n ";
  syncScroll(side);
}

function renderGen(ranges) {
  $("#gen").innerHTML = links ? marksHTML(links.gen, ranges) : $("#gen").innerHTML;
}

function clearMarks() {
  renderBack("human", []);
  renderBack("dsl", []);
  renderGen([]);
  highlightChart([]);
  for (const tr of document.querySelectorAll("#rounds tr.active")) tr.classList.remove("active");
}

function syncScroll(side) {
  $("#" + side + "-back").scrollTop = $("#" + side).scrollTop;
}

/** Scroll a pane so its first mark of the given classes is visible. */
function reveal(side, classes) {
  const box = side === "gen" ? $("#gen") : $("#" + side + "-back");
  const scroller = side === "gen" ? $("#gen") : $("#" + side);
  const m = box.querySelector(classes.map((c) => "mark." + c).join(","));
  if (!m) return;
  const top = m.offsetTop - (side === "gen" ? box.offsetTop : 0), view = scroller.clientHeight;
  if (top < scroller.scrollTop || top + m.offsetHeight > scroller.scrollTop + view) {
    scroller.scrollTop = Math.max(0, top - view / 3);
    if (side !== "gen") syncScroll(side);
  }
}

function markRound(label) {
  for (const tr of document.querySelectorAll("#rounds tbody tr")) tr.classList.toggle("active", tr.dataset.label === label);
}

// ---- manual links ----------------------------------------------------------
// current.links = {rounds: {"2": {atoms: {"3": {s, e, text, line} | {none: true, line}}}}}
// "line" is the DSL line when the link was confirmed; if it changes, the link needs review.
// s/e are offsets into the original; if the original moves, the link follows its text.

const roundOf = (label) => links.rounds.find((r) => r.label === label);
const dslLine = (label) => { const r = roundOf(label); return r?.dsl ? $("#dsl").value.slice(...r.dsl) : null; };

function nearest(text, needle, near) {
  let best = -1;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** The confirmed link for a DSL atom: null | {none, stale} | {s, e, stale} | {lost}. */
function manual(atom) {
  const v = current.links.rounds[atom.r]?.atoms?.[atom.i];
  if (!v) return null;
  const stale = v.line !== dslLine(atom.r);
  if (v.none) return { none: true, stale };
  const H = $("#human").value;
  const s = H.slice(v.s, v.s + v.text.length) === v.text ? v.s : nearest(H, v.text, v.s);
  return s < 0 ? { lost: true, stale: true } : { s, e: s + v.text.length, stale };
}

function atomClass(m) {
  if (!m) return null;
  if (m.lost || m.stale) return "stale";
  return m.none ? "none" : "done";
}

function renderProgress() {
  if (!links || !links.dsl.length) { $("#link-progress").textContent = ""; return; }
  const ms = links.dsl.map(manual);
  const ok = ms.filter((m) => m && !m.stale && !m.lost).length;
  const review = ms.filter((m) => m && (m.stale || m.lost)).length;
  $("#link-progress").textContent = `${ok}/${ms.length} pieces linked` + (review ? ` · ${review} to review` : "");
}

// ---- normal mode: selection follows links ---------------------------------

function followSelection() {
  if (linking) return;
  const side = document.activeElement?.id;
  if (!["human", "dsl"].includes(side)) return;
  const ta = $("#" + side), a = ta.selectionStart, b = ta.selectionEnd;
  const braces = a === b ? braceRanges(ta.value, a) : [];
  if (!links) { renderBack(side, braces); return; } // mid-edit: brackets still work

  const hit = (s, e) => (a === b ? s <= a && a <= e : s < b && e > a);
  const resolved = links.dsl.map(manual);
  const sel = links.dsl.map((_, k) => k).filter((k) => side === "dsl"
    ? hit(links.dsl[k].s, links.dsl[k].e)
    : resolved[k]?.e != null && hit(resolved[k].s, resolved[k].e));
  const round = links.rounds.find((r) => r[side] && r[side][0] <= a && a <= r[side][1]);
  showLinked(sel, side, braces, round, resolved);
}

function showLinked(sel, side, extra, round, resolved) {
  const dslR = [], humR = [], genR = [];
  for (const k of sel) {
    const d = links.dsl[k], m = resolved[k];
    dslR.push({ s: d.s, e: d.e, c: side === "dsl" ? "src" : "strong" });
    genR.push({ s: d.g[0], e: d.g[1], c: side === "gen" ? "src" : "strong" });
    if (m?.e != null) humR.push({ s: m.s, e: m.e, c: side === "human" ? "src" : "strong" });
  }
  // Round context, so there's always something to look at even without a confirmed link.
  if (round?.human && side !== "human" && !humR.length) humR.push({ s: round.human[0], e: round.human[1], c: "soft" });
  if (round?.dsl && side === "human" && !sel.length) dslR.push({ s: round.dsl[0], e: round.dsl[1], c: "soft" });

  renderBack("dsl", side === "dsl" ? [...dslR, ...extra] : dslR);
  renderBack("human", side === "human" ? [...humR, ...extra] : humR);
  renderGen(genR);
  highlightChart(sel);
  for (const p of ["dsl", "human", "gen"]) if (p !== side) reveal(p, ["strong", "soft"]);
  markRound(round?.label);
}

/** Offset of a click inside the uniform pane. */
function genOffset() {
  const sel = getSelection();
  if (!sel.rangeCount || !$("#gen").contains(sel.anchorNode)) return -1;
  const r = document.createRange();
  r.setStart($("#gen"), 0);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}

$("#gen").addEventListener("mouseup", () => {
  if (!links) return;
  const o = genOffset();
  const k = links.dsl.findIndex((d) => d.g[0] <= o && o < d.g[1]);
  if (k < 0) return;
  if (linking) return goTo(k);
  showLinked([k], "gen", [], roundOf(links.dsl[k].r), links.dsl.map(manual));
});

// ---- bracket matching ----------------------------------------------------

const PAIRS = { "[": "]", "{": "}", "(": ")" };
const CLOSERS = { "]": "[", "}": "{", ")": "(" };
// What a closing bracket applies to: "]x3", "]>corner", "}@same", "] twice", "] to corner".
const AFTER_CLOSE = /^(?:x\d+|>[\w-]+|@[\w-]+|\s*(?:twice|three times|four times|\d+ times|to (?:the )?(?:next )?(?:corner|end)\b))/i;

/** Ranges highlighting the bracket next to the caret and its partner (searched within the line). */
function braceRanges(text, caret) {
  const at = [caret - 1, caret].find((i) => PAIRS[text[i]] || CLOSERS[text[i]]);
  if (at === undefined) return [];
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  let lineEnd = text.indexOf("\n", at);
  if (lineEnd < 0) lineEnd = text.length;

  const ch = text[at], open = PAIRS[ch] ? ch : CLOSERS[ch], close = PAIRS[open];
  const dir = PAIRS[ch] ? 1 : -1;
  let depth = 0, match = -1;
  for (let i = at; i >= lineStart && i < lineEnd; i += dir) {
    if (text[i] === open) depth += dir;
    else if (text[i] === close) depth -= dir;
    if (depth === 0) { match = i; break; }
  }
  if (match < 0) return [{ s: at, e: at + 1, c: "brace-bad" }];

  const closeAt = Math.max(at, match);
  const tail = AFTER_CLOSE.exec(text.slice(closeAt + 1, lineEnd));
  return [
    { s: Math.min(at, match), e: Math.min(at, match) + 1, c: "brace" },
    { s: closeAt, e: closeAt + 1 + (tail ? tail[0].length : 0), c: "brace" },
  ];
}

// ---- link mode -------------------------------------------------------------
// Step through DSL atoms; for each, adjust a highlight (cand) in the original and confirm.

let linking = false, cur = -1, cand = null;
let tokCache = { text: null, toks: [] };

/** Words and bracket-like marks of the original, for word-wise edge moves.
 *  Separators (, . ; :) are skipped so a step never just grabs a comma. */
function tokens() {
  const H = $("#human").value;
  if (tokCache.text !== H) {
    tokCache = { text: H, toks: [...H.matchAll(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\sA-Za-z0-9,.;:]/g)]
      .map((m) => ({ s: m.index, e: m.index + m[0].length, word: /\w/.test(m[0]) })) };
  }
  return tokCache.toks;
}

/** Starting highlight for atom k: its confirmed link, else the matcher's guess,
 *  else the word after the previous linked piece in the round. */
function guess(k) {
  const atom = links.dsl[k];
  const m = manual(atom);
  if (m?.e != null) return { s: m.s, e: m.e };
  const sug = links.human[atom.link[0]];
  if (sug) return { s: sug.s, e: sug.e };
  let from = roundOf(atom.r)?.human?.[0];
  for (let p = k - 1; p >= 0 && links.dsl[p].r === atom.r; p--) {
    const pm = manual(links.dsl[p]);
    if (pm?.e != null) { from = pm.e; break; }
  }
  if (from == null) return null;
  const t = tokens().find((t) => t.s >= from && t.word);
  return t ? { s: t.s, e: t.e } : null;
}

function startLinking() {
  if (!links?.dsl.length) return;
  linking = true;
  document.body.classList.add("linking");
  $("#human").readOnly = $("#dsl").readOnly = true;
  $("#link-controls").hidden = $("#link-help").hidden = false;
  tip.hidden = true;
  // Start at the piece under the DSL caret, else the first one not yet linked.
  const caret = $("#dsl").selectionStart;
  let k = document.activeElement === $("#dsl") ? links.dsl.findIndex((d) => d.s <= caret && caret <= d.e) : -1;
  if (k < 0) k = links.dsl.findIndex((d) => { const m = manual(d); return !m || m.stale || m.lost; });
  goTo(Math.max(0, k));
}

function stopLinking() {
  linking = false;
  document.body.classList.remove("linking");
  $("#human").readOnly = $("#dsl").readOnly = false;
  $("#link-controls").hidden = $("#link-help").hidden = true;
  clearMarks();
  renderProgress();
}

function goTo(k) {
  cur = Math.max(0, Math.min(k, links.dsl.length - 1));
  cand = guess(cur);
  renderLinking();
}

function renderLinking() {
  const atom = links.dsl[cur];
  const dslR = [], humR = [], genR = [];
  links.dsl.forEach((d, k) => {
    const m = manual(d), c = atomClass(m);
    if (c) dslR.push({ s: d.s, e: d.e, c });
    if (c === "done") { humR.push({ s: m.s, e: m.e, c }); genR.push({ s: d.g[0], e: d.g[1], c }); }
  });
  dslR.push({ s: atom.s, e: atom.e, c: "cur" });
  genR.push({ s: atom.g[0], e: atom.g[1], c: "cur" });
  if (cand) humR.push({ ...cand, c: "cand" });
  renderBack("dsl", dslR);
  renderBack("human", humR);
  renderGen(genR);
  highlightChart([cur]);
  reveal("dsl", ["cur"]); reveal("gen", ["cur"]); reveal("human", ["cand"]);
  markRound(atom.r);

  const inRound = links.dsl.filter((d) => d.r === atom.r).length;
  const m = manual(atom);
  const state = !m ? "" : m.lost ? " · <b>text moved, re-link</b>" : m.stale ? " · <b>machine line changed, review</b>"
    : m.none ? " · no match" : " · linked";
  const H = $("#human").value;
  $("#link-current").innerHTML = `R${esc(atom.r)} · ${atom.i + 1}/${inRound} · <code>${esc($("#dsl").value.slice(atom.s, atom.e))}</code>`
    + ` → ${cand ? `“${esc(H.slice(cand.s, cand.e))}”` : "<span class=muted>select in the original</span>"}${state}`;
  renderProgress();
}

function linkSaved() {
  $("#save-state").textContent = "Unsaved…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}

function setLink(value) {
  const atom = links.dsl[cur];
  const r = (current.links.rounds[atom.r] ??= { atoms: {} });
  if (value === undefined) delete r.atoms[atom.i];
  else r.atoms[atom.i] = { ...value, line: dslLine(atom.r) };
  linkSaved();
}

function confirmLink() {
  if (!cand) return;
  const H = $("#human").value;
  setLink({ s: cand.s, e: cand.e, text: H.slice(cand.s, cand.e) });
  next();
}

function next() {
  if (cur < links.dsl.length - 1) goTo(cur + 1);
  else { renderLinking(); $("#link-current").innerHTML += " · <b>last piece done</b>"; }
}

/** Move one edge of the highlight by a word (or a letter with alt). */
function moveEdge(edge, dir, letter) {
  const H = $("#human").value, toks = tokens();
  if (!cand) {
    const t = toks.find((t) => t.s >= $("#human").selectionStart && t.word);
    if (t) cand = { s: t.s, e: t.e };
    return renderLinking();
  }
  if (letter) {
    if (edge === "s") cand.s = Math.max(0, Math.min(cand.s + dir, cand.e - 1));
    else cand.e = Math.min(H.length, Math.max(cand.e + dir, cand.s + 1));
  } else if (edge === "e") {
    const t = dir > 0 ? toks.find((t) => t.e > cand.e) : toks.findLast((t) => t.e < cand.e && t.e > cand.s);
    if (t) cand.e = t.e;
  } else {
    const t = dir < 0 ? toks.findLast((t) => t.s < cand.s) : toks.find((t) => t.s > cand.s && t.s < cand.e);
    if (t) cand.s = t.s;
  }
  renderLinking();
}

document.addEventListener("keydown", (e) => {
  if (!linking || ["INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
  const act = {
    ArrowLeft: () => moveEdge(e.shiftKey ? "s" : "e", -1, e.altKey),
    ArrowRight: () => moveEdge(e.shiftKey ? "s" : "e", 1, e.altKey),
    ArrowUp: () => goTo(cur - 1),
    ArrowDown: () => goTo(cur + 1),
    Enter: confirmLink,
    Backspace: () => { setLink({ none: true }); next(); },
    Delete: () => { setLink({ none: true }); next(); },
    Escape: stopLinking,
  }[e.key];
  if (act) { e.preventDefault(); e.stopPropagation(); act(); }
}, true);

// Mouse: drag-select in the original sets the highlight; clicking a machine piece jumps to it.
$("#human").addEventListener("mouseup", () => {
  if (!linking) return;
  const ta = $("#human"), H = ta.value;
  let a = ta.selectionStart, b = ta.selectionEnd;
  if (a === b) {
    const t = tokens().find((t) => t.s <= a && a <= t.e);
    if (!t) return;
    [a, b] = [t.s, t.e];
  }
  while (a < b && /\s/.test(H[a])) a++;
  while (b > a && /\s/.test(H[b - 1])) b--;
  if (a < b) { cand = { s: a, e: b }; renderLinking(); }
});
$("#dsl").addEventListener("mouseup", () => {
  if (!linking) return;
  const c = $("#dsl").selectionStart;
  const k = links.dsl.findIndex((d) => d.s <= c && c <= d.e);
  if (k >= 0) goTo(k);
});

$("#link-start").addEventListener("click", startLinking);
$("#link-exit").addEventListener("click", stopLinking);
$("#link-prev").addEventListener("click", () => goTo(cur - 1));
$("#link-next").addEventListener("click", () => goTo(cur + 1));
$("#link-ok").addEventListener("click", confirmLink);
$("#link-none").addEventListener("click", () => { setLink({ none: true }); next(); });
$("#link-clear").addEventListener("click", () => { setLink(undefined); cand = guess(cur); renderLinking(); });

let followPending = false;
const scheduleFollow = () => {
  if (followPending) return;
  followPending = true;
  requestAnimationFrame(() => { followPending = false; followSelection(); });
};
document.addEventListener("selectionchange", scheduleFollow);
for (const side of ["human", "dsl"]) {
  const ta = $("#" + side);
  for (const ev of ["select", "keyup", "mouseup", "focus"]) ta.addEventListener(ev, scheduleFollow);
  ta.addEventListener("scroll", () => syncScroll(side));
}

// ---- chart ---------------------------------------------------------------
// Standard crochet symbols from the server's layout (granny/chart.py), one colour per round.

const ROUND_COLORS = ["#c2546b", "#3a7bd5", "#e8892b", "#3f8f5a", "#8a5cc2", "#1f9e9e", "#b5852a"];

function chartAtoms(label, atoms) {
  // Chart atoms are per-round indices; map them to links.dsl indices.
  return atoms.map((i) => links.dsl.findIndex((d) => d.r === label && d.i === i)).filter((k) => k >= 0);
}

function symbol(p, color) {
  const f = (n) => n.toFixed(2);
  const line = (a, b) => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${color}" stroke-width="0.6" stroke-linecap="round"/>`;
  const oval = (c, ang) => `<ellipse cx="${f(c[0])}" cy="${f(c[1])}" rx="2.1" ry="1.1" transform="rotate(${f(ang)} ${f(c[0])} ${f(c[1])})" fill="none" stroke="${color}" stroke-width="0.6"/>`;
  if (p.k === "oval") return oval(p.c, p.ang) + `<circle class="hitbox" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="2.4"/>`;
  if (p.k === "dot") return `<circle class="dot" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="1.1" fill="${color}"/>`
    + `<circle class="hitbox" cx="${f(p.c[0])}" cy="${f(p.c[1])}" r="2.4"/>`;

  const [b, t] = [p.b, p.t];
  const dx = t[0] - b[0], dy = t[1] - b[1], len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux; // along / across the stem
  const at = (s, w = 0) => [b[0] + dx * s + nx * w, b[1] + dy * s + ny * w];
  const mid = at(0.5);
  const hit = `<circle class="hitbox" cx="${f(mid[0])}" cy="${f(mid[1])}" r="${f(Math.max(2.4, len / 2))}"/>`;

  if (p.k === "chcol") { // chain that counts as a stitch: stacked ovals
    const n = Math.max(1, Math.round(len / 3.2)), ang = Math.atan2(dy, dx) * 180 / Math.PI;
    return Array.from({ length: n }, (_, j) => oval(at((j + 0.5) / n), ang)).join("") + hit;
  }
  if (p.k === "sc") { // ×
    const c = at(0.55), r = 1.6;
    return line([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]) + line([c[0] - r, c[1] + r], [c[0] + r, c[1] - r]) + hit;
  }
  const slashes = { dc: 1, tr: 2, dtr: 3, trtr: 4 }[p.k] ?? 0;
  let svg = line(b, t) + line(at(1, -1.8), at(1, 1.8)); // stem + top bar
  for (let j = 0; j < slashes; j++) {
    const s = 0.5 + (j - (slashes - 1) / 2) * 0.16;
    svg += line(at(s - 0.07, -1.3), at(s + 0.07, 1.3));
  }
  if (!["hdc", "dc", "tr", "dtr", "trtr"].includes(p.k)) { // puff, pc, …: stem + bobble
    svg += `<ellipse cx="${f(at(0.6)[0])}" cy="${f(at(0.6)[1])}" rx="1.8" ry="1.8" fill="none" stroke="${color}" stroke-width="0.6"/>`;
  }
  return svg + hit;
}

function drawChart(chart) {
  $("#chart-notes").innerHTML = (chart?.rounds || []).filter((r) => r.note)
    .map((r) => `<div>R${esc(r.label)}: ${esc(r.note)}</div>`).join("");
  if (!chart || !chart.rounds.length) {
    $("#chart").innerHTML = `<svg viewBox="-50 -50 100 100"><text class="empty" x="0" y="0" text-anchor="middle">No rounds to draw yet</text></svg>`;
    return;
  }
  const S = chart.size;
  let svg = `<svg viewBox="${-S} ${-S} ${2 * S} ${2 * S}" xmlns="http://www.w3.org/2000/svg">`;
  if (chart.ring) {
    const a = chartAtoms("start", chart.ring.a);
    svg += `<g data-a="${a.join(" ")}" data-own="${a[0] ?? ""}"><circle cx="0" cy="0" r="${chart.ring.r}" fill="none" stroke="var(--muted)" stroke-width="0.6"/></g>`;
  }
  chart.rounds.forEach((r, ri) => {
    const color = ROUND_COLORS[ri % ROUND_COLORS.length];
    for (const p of r.prims) {
      const a = chartAtoms(r.label, p.a);
      svg += `<g data-a="${a.join(" ")}" data-own="${a[0] ?? ""}">${symbol(p, color)}</g>`;
    }
  });
  $("#chart").innerHTML = svg + "</svg>";
}

function highlightChart(sel) {
  const set = new Set(sel);
  for (const g of $("#chart").querySelectorAll("g[data-a]")) {
    g.classList.toggle("hit", !!g.dataset.a && g.dataset.a.split(" ").some((x) => set.has(+x)));
  }
}

// Hover a stitch: show where it is in the text. In link mode, click to jump to it.
$("#chart").addEventListener("mouseover", (e) => {
  const g = e.target.closest("g[data-own]");
  if (!g || g.dataset.own === "" || !links || linking) return;
  const k = +g.dataset.own;
  showLinked([k], "chart", [], roundOf(links.dsl[k].r), links.dsl.map(manual));
});
$("#chart").addEventListener("click", (e) => {
  const g = e.target.closest("g[data-own]");
  if (g && g.dataset.own !== "" && linking) goTo(+g.dataset.own);
});

// ---- boot ---------------------------------------------------------------

loadList().then(() => { if (location.hash.length > 1) openPattern(location.hash.slice(1)); });

// ---- running counts on hover ---------------------------------------------
// Hovering a stitch in the machine pattern shows the counts up to that point in the round.

const META_KEYS = ["join", "turn", "fo", "mr", "sl"];
const tip = Object.assign(document.createElement("div"), { className: "tip", hidden: true });
document.body.append(tip);

/** Range covering character k of the highlight layer's text. */
function charRange(root, k) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode()); k -= n.length) {
    if (k < n.length) {
      const r = document.createRange();
      r.setStart(n, k); r.setEnd(n, k + 1);
      return r;
    }
  }
  return null;
}

/** Index of the character under (x, y) in a textarea, or -1. Hit-tests the identical
 *  highlight layer underneath, since textareas don't expose character positions. */
function charAt(side, x, y) {
  const ta = $("#" + side), back = $("#" + side + "-back");
  let node = null, offset = 0;
  ta.style.pointerEvents = "none"; back.style.pointerEvents = "auto";
  try {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) ({ offsetNode: node, offset } = p);
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) ({ startContainer: node, startOffset: offset } = r);
    }
  } finally {
    ta.style.pointerEvents = ""; back.style.pointerEvents = "";
  }
  if (!node || !back.contains(node)) return -1;
  const pre = document.createRange();
  pre.setStart(back, 0); pre.setEnd(node, offset);
  const i = pre.toString().length;
  // The caret lands between characters; pick the one actually under the pointer.
  for (const k of [i - 1, i]) {
    const rect = k >= 0 && charRange(back, k)?.getBoundingClientRect();
    if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return k;
  }
  return -1;
}

const countKeys = (c) => Object.keys(c).filter((k) => !META_KEYS.includes(k) && c[k])
  .sort((a, b) => (a === "st") - (b === "st") || a.includes("sp") - b.includes("sp"));

function showTip(e) {
  const k = links ? charAt("dsl", e.clientX, e.clientY) : -1;
  const atom = k >= 0 && links.dsl.find((d) => d.s <= k && k < d.e);
  if (!atom?.run) { tip.hidden = true; return; }

  // Round total: what the human pattern states, else what the DSL adds up to.
  const row = report?.rounds.find((x) => x.label === atom.r);
  const total = Object.keys(row?.stated || {}).length ? row.stated : row?.computed || {};
  const { counts, exact } = atom.run;
  const keys = countKeys(total);
  tip.innerHTML = keys.map((key) =>
    `<div>${exact ? "" : "≥"}${counts[key] || 0}<span class="muted"> / ${total[key]}</span> ${esc(key)}</div>`).join("");
  tip.hidden = !keys.length;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(e.clientX + pad, innerWidth - w - 8) + "px";
  tip.style.top = (e.clientY + pad + h > innerHeight ? e.clientY - h - pad : e.clientY + pad) + "px";
}

let hoverEvent = null;
$("#dsl").addEventListener("mousemove", (e) => {
  if (!hoverEvent) requestAnimationFrame(() => { showTip(hoverEvent); hoverEvent = null; });
  hoverEvent = e;
});
for (const ev of ["mouseleave", "keydown", "scroll"]) $("#dsl").addEventListener(ev, () => { tip.hidden = true; });
