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
  links = null;
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
  const { meta, human, dsl } = current;
  try {
    await api(`/api/patterns/${meta.id}`, { method: "PUT", body: { meta, human, dsl } });
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

function renderImages() {
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

// ---- linked highlighting -------------------------------------------------
// Selecting in one pattern highlights the matching part of the other:
//   src    = the selected atoms (blue), strong = their counterparts, soft = surrounding clause / round.

let report = null; // last /api/check result
let links = null; // from /api/check: {rounds, dsl: [{s, e, r, link}], human: [{s, e, r, clause, link}]}

function renderBack(side, ranges) {
  const text = $("#" + side).value;
  // Per-character class, strongest wins; then emit runs.
  const rank = { soft: 1, strong: 2, src: 3, brace: 4, "brace-bad": 4 };
  const cls = new Array(text.length).fill("");
  for (const { s, e, c } of ranges) {
    for (let i = Math.max(0, s); i < Math.min(e, text.length); i++) {
      if (!cls[i] || rank[c] > rank[cls[i]]) cls[i] = c;
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
  $("#" + side + "-back").innerHTML = html + "\n ";
  syncScroll(side);
}

function clearMarks() {
  renderBack("human", []);
  renderBack("dsl", []);
  for (const tr of document.querySelectorAll("#rounds tr.active")) tr.classList.remove("active");
}

function syncScroll(side) {
  $("#" + side + "-back").scrollTop = $("#" + side).scrollTop;
}

function revealMark(side) {
  const ta = $("#" + side), m = $("#" + side + "-back").querySelector("mark.strong, mark.soft");
  if (!m) return;
  const top = m.offsetTop, view = ta.clientHeight;
  if (top < ta.scrollTop || top + m.offsetHeight > ta.scrollTop + view) {
    ta.scrollTop = Math.max(0, top - view / 3);
    syncScroll(side);
  }
}

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

function followSelection() {
  const side = document.activeElement?.id;
  if (!["human", "dsl"].includes(side)) return;
  const other = side === "dsl" ? "human" : "dsl";
  const ta = $("#" + side), a = ta.selectionStart, b = ta.selectionEnd;
  const braces = a === b ? braceRanges(ta.value, a) : [];
  if (!links) { renderBack(side, braces); return; } // mid-edit: brackets still work
  const atoms = links[side], otherAtoms = links[other];

  const hit = (x) => (a === b ? x.s <= a && a <= x.e : x.s < b && x.e > a);
  const sel = atoms.filter(hit);
  const targets = [...new Set(sel.flatMap((x) => x.link))].map((k) => otherAtoms[k]);

  const src = sel.map((x) => ({ s: x.s, e: x.e, c: "src" }));
  const out = targets.map((x) => ({ s: x.s, e: x.e, c: "strong" }));
  // Round under the caret, so there's always some context even with no direct match.
  const round = links.rounds.find((r) => r[side] && r[side][0] <= a && a <= r[side][1]);
  if (targets.length) {
    const spans = targets.map((x) => x.clause || [x.s, x.e]);
    out.push({ s: Math.min(...spans.map((x) => x[0])), e: Math.max(...spans.map((x) => x[1])), c: "soft" });
  } else if (round && round[other]) {
    out.push({ s: round[other][0], e: round[other][1], c: "soft" });
  }
  renderBack(side, [...src, ...braces]);
  renderBack(other, out);
  revealMark(other);

  for (const tr of document.querySelectorAll("#rounds tbody tr")) {
    tr.classList.toggle("active", !!round && tr.dataset.label === round.label);
  }
}

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
