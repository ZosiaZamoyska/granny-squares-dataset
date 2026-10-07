"""Align a human-written pattern with its DSL and check stitch counts per round."""

from __future__ import annotations

import re

from . import align, dsl, render

_ROUND = re.compile(
    r"^\s*(?:Rounds?|Rnds?|Rds?|Rows?|R)\s*(\d+(?:\s*[-–]\s*\d+)?)\s*[:.)]\s*",
    re.I | re.M,
)
# Trailing "(12 tr, 4 3-ch sps.)" at the end of a round.
_STATED = re.compile(r"\(([^()]*\d[^()]*)\)\s*\.?\s*$")
_SP = re.compile(r"^(?:(\d+)\s*-?\s*ch|ch\s*-?\s*(\d+))[\s-]*(?:sp|space)s?$")

# Plural / long-form stitch names in stated counts -> DSL names.
_NAMES = {
    "sts": "st", "stitches": "st", "stitch": "st",
    "trebles": "tr", "treble": "tr", "trs": "tr",
    "doubles": "dc", "dcs": "dc", "scs": "sc", "hdcs": "hdc", "htrs": "htr",
    "chs": "ch", "chains": "ch", "ch sps": "1ch-sp", "ch-sps": "1ch-sp",
}


def round_spans(text: str) -> list[tuple[str, int, int]]:
    """[(label, start, end)] of each round's body; label "start" for the preamble."""
    matches = list(_ROUND.finditer(text))
    first = matches[0].start() if matches else len(text)
    out = [("start", 0, first)]
    for m, nxt in zip(matches, matches[1:] + [None]):
        label = re.sub(r"\s*[-–]\s*", "-", m.group(1))
        out.append((label, m.end(), nxt.start() if nxt else len(text)))
    return out


def split_rounds(text: str) -> tuple[str, dict[str, str]]:
    """Return (preamble, {"1": "...", "2": "..."}) from human pattern text."""
    spans = round_spans(text)
    return text[spans[0][1]:spans[0][2]].strip(), {l: text[s:e].strip() for l, s, e in spans[1:]}


def _utf16(text: str):
    """Map Python string offsets to JS (UTF-16) offsets; differs only past emoji etc."""
    if all(ord(c) < 0x10000 for c in text):
        return lambda i: i
    acc, pre = 0, []
    for c in text:
        pre.append(acc)
        acc += 2 if ord(c) >= 0x10000 else 1
    pre.append(acc)
    return lambda i: pre[i]


def links(human: str, dsl_text: str) -> dict:
    """Character-level links between DSL atoms and human-text mentions, per round.

    Offsets are absolute within each document (UTF-16, for the browser):
      rounds: [{label, human: [s, e] | None, dsl: [s, e] | None}]
      dsl:    [{s, e, r, i, g: [s, e], run, link: [human atom index...]}]
              i = index within its round, g = span in the uniform text,
              link = automatic suggestion only
      human:  [{s, e, r, clause: [s, e], link: [dsl atom index...]}]
      gen:    uniform human-style text rendered from the DSL
    """
    h16, d16 = _utf16(human), _utf16(dsl_text)
    h_rounds = {l: (s, e) for l, s, e in round_spans(human)}
    d_lines, pos = {}, 0
    for raw in dsl_text.split("\n"):
        try:
            line = dsl.parse_line(raw)
        except dsl.DSLError:
            line = None
        if line and line.label not in d_lines:
            d_lines[line.label] = (line, pos, pos + len(raw))
        pos += len(raw) + 1

    # Uniform text, one line per DSL round, in DSL order.
    gen_lines, gen_spans, gpos = [], {}, 0
    for label, (line, _, _) in d_lines.items():
        text, spans = render.render_line(line)
        gen_spans[label] = [(s + gpos, e + gpos) for s, e in spans]
        gen_lines.append(text)
        gpos += len(text) + 1
    gen = "\n".join(gen_lines)
    g16 = _utf16(gen)

    out = {"rounds": [], "dsl": [], "human": [], "gen": gen}
    for label in list(h_rounds) + [l for l in d_lines if l not in h_rounds]:
        hs = h_rounds.get(label)
        dl = d_lines.get(label)
        if hs and hs[0] == hs[1] and not dl:
            continue  # empty preamble
        out["rounds"].append({"label": label,
                              "human": [h16(hs[0]), h16(hs[1])] if hs else None,
                              "dsl": [d16(dl[1]), d16(dl[2])] if dl else None})
        h_atoms = align.human_atoms(human[hs[0]:hs[1]], hs[0]) if hs else []
        d_atoms = [(k, key, n, s + dl[1], e + dl[1]) for k, key, n, s, e in dl[0].atoms] if dl else []
        h_clauses = align.clauses(human[hs[0]:hs[1]], hs[0]) if hs else []
        d0, h0 = len(out["dsl"]), len(out["human"])
        running = dsl.running_counts(dl[0]) if dl else []
        for i, (a, run) in enumerate(zip(d_atoms, running)):
            gs, ge = gen_spans[label][i]
            out["dsl"].append({"s": d16(a[3]), "e": d16(a[4]), "r": label, "i": i,
                               "g": [g16(gs), g16(ge)], "link": [], "run": run})
        for a in h_atoms:
            clause = next(([s, e] for s, e in h_clauses if s <= a[3] < e), [a[3], a[4]])
            out["human"].append({"s": h16(a[3]), "e": h16(a[4]), "r": label,
                                 "clause": [h16(clause[0]), h16(clause[1])], "link": []})
        for i, j in align.align(d_atoms, h_atoms):
            out["dsl"][d0 + i]["link"].append(h0 + j)
            out["human"][h0 + j]["link"].append(d0 + i)
    return out


def stated_counts(round_text: str) -> dict[str, int]:
    """Parse "(12 tr, 4 3-ch sps.)" -> {"tr": 12, "3ch-sp": 4}."""
    m = _STATED.search(round_text)
    if not m:
        return {}
    out = {}
    for part in re.split(r",|;|\band\b", m.group(1)):
        pm = re.match(r"\s*(\d+)\s+(.+?)\s*\.?\s*$", part)
        if not pm:
            continue
        n, name = int(pm.group(1)), pm.group(2).lower()
        sp = _SP.match(name)
        if sp:
            key = f"{sp.group(1) or sp.group(2)}ch-sp"
        else:
            key = _NAMES.get(name, name)
            key = dsl.ALIASES.get(key, key)
        out[key] = out.get(key, 0) + n
    return out


def check(human: str, dsl_text: str, terms: str = "US") -> dict:
    """Round-by-round alignment report, JSON-serialisable for the web UI."""
    preamble, human_rounds = split_rounds(human)
    report = {"preamble": preamble, "rounds": [], "errors": [], "ok": True}

    dsl_lines: dict[str, dict] = {}
    for n, raw in enumerate(dsl_text.splitlines(), 1):
        try:
            line = dsl.parse_line(raw)
        except dsl.DSLError as e:
            report["errors"].append(f"DSL line {n}: {e}")
            continue
        if line is None:
            continue
        if line.label in dsl_lines:
            report["errors"].append(f"DSL line {n}: duplicate R{line.label}")
        dsl_lines[line.label] = {"line": line, "src": raw.strip()}

    if "start" in dsl_lines:
        report["start"] = dsl_lines["start"]["src"]

    labels = list(human_rounds)
    labels += [l for l in dsl_lines if l not in human_rounds and l != "start"]
    for label in labels:
        h = human_rounds.get(label)
        d = dsl_lines.get(label)
        row = {"label": label, "human": h, "dsl": d["src"] if d else None,
               "stated": stated_counts(h) if h else {}, "computed": {},
               "exact": True, "warnings": [], "status": ""}
        if d:
            counts, exact = dsl.count(d["line"].items)
            row["computed"] = dict(counts)
            row["exact"] = exact
            row["warnings"] = d["line"].warnings
            row["tokens"] = dsl.line_tokens(d["line"])

        if h is None:
            row["status"] = "missing-human"
        elif d is None:
            row["status"] = "missing-dsl"
        elif not row["stated"]:
            row["status"] = "no-counts"
        else:
            diffs = {k: (v, row["computed"].get(k, 0)) for k, v in row["stated"].items()
                     if row["computed"].get(k, 0) != v}
            row["diffs"] = diffs
            if not diffs:
                row["status"] = "ok"
            elif not exact:
                row["status"] = "unverified"  # >landmark repeat; can't count statically
            else:
                row["status"] = "mismatch"
        if row["status"] in ("mismatch", "missing-dsl", "missing-human"):
            report["ok"] = False
        report["rounds"].append(row)

    if report["errors"]:
        report["ok"] = False
    report["links"] = links(human, dsl_text)
    return report
