"""Export the dataset to JSONL for training.

    python3 export.py                 # -> exports/dataset.jsonl
    python3 export.py --strict        # skip patterns with mismatches / parse errors

Each line is one pattern. DSL is normalised to US stitch names (dsl_us, tokens),
so UK and US patterns share one vocabulary; the original text is kept as-is.
"uniform" is human-style text generated from the DSL. rounds[].alignment holds the
manually confirmed links: DSL atom i <-> a span of the original human text
(None = the atom has no counterpart there). Links whose DSL line changed are skipped.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from granny import dsl, render, store
from granny.check import check


def _locate(text: str, needle: str, near: int) -> int | None:
    """Position of needle in text closest to near (stored offsets are browser UTF-16)."""
    best, i = None, text.find(needle)
    while i != -1:
        if best is None or abs(i - near) < abs(best - near):
            best = i
        i = text.find(needle, i + 1)
    return best


def alignment(p: dict) -> dict[str, list]:
    """Confirmed manual links per round, skipping stale ones."""
    raw_lines = {}
    for raw in p["dsl"].split("\n"):
        try:
            line = dsl.parse_line(raw)
        except dsl.DSLError:
            continue
        if line and line.label not in raw_lines:
            raw_lines[line.label] = (raw, line)

    out = {}
    for label, r in p["links"]["rounds"].items():
        if label not in raw_lines:
            continue
        raw, line = raw_lines[label]
        gen, gen_spans = render.render_line(line)
        items = []
        for key, v in r.get("atoms", {}).items():
            i = int(key)
            if v.get("line") != raw or i >= len(line.atoms):
                continue  # DSL line edited since this link was confirmed
            _, _, _, s, e = line.atoms[i]
            gs, ge = gen_spans[i]
            entry = {"i": i, "token": raw[s:e], "uniform": gen[gs:ge], "human": None, "human_text": None}
            if not v.get("none"):
                pos = _locate(p["human"], v["text"], v["s"])
                if pos is None:
                    continue  # human text edited; span no longer exists
                entry["human"] = [pos, pos + len(v["text"])]
                entry["human_text"] = v["text"]
            items.append(entry)
        out[label] = sorted(items, key=lambda x: x["i"])
    return out


def export_pattern(pid: str) -> dict:
    p = store.load(pid)
    meta, terms = p["meta"], p["meta"]["terms"]
    report = check(p["human"], p["dsl"], terms)

    lines = []
    for raw in p["dsl"].splitlines():
        try:
            line = dsl.parse_line(raw)
        except dsl.DSLError:
            continue  # already reported in report["errors"]
        if line:
            lines.append(line)
    us = {l.label: l for l in dsl.to_us(lines, terms)}
    own = {l.label: l for l in lines}
    links = alignment(p)

    rounds = []
    for r in report["rounds"]:
        line = us.get(r["label"])
        rounds.append({
            "label": r["label"],
            "human": r["human"],
            "dsl_us": dsl.format_line(line) if line else None,
            "tokens": dsl.line_tokens(line) if line else None,
            "uniform": render.render_line(own[r["label"]])[0] if r["label"] in own else None,
            "uniform_us": render.render_line(line)[0] if line else None,
            "alignment": links.get(r["label"], []),
            "atoms": len(line.atoms) if line else 0,
            "stated_counts": r["stated"],
            "status": r["status"],
        })

    return {
        "id": pid,
        "title": meta["title"],
        "terms": terms,
        "source": meta["source"],
        "author": meta["author"],
        "license": meta["license"],
        "tags": meta["tags"],
        "images": [{**img, "path": f"data/patterns/{pid}/images/{img['file']}"} for img in meta["images"]],
        "human": p["human"],
        "human_preamble": report["preamble"],
        "dsl": p["dsl"],
        "dsl_us": "\n".join(dsl.format_line(l) for l in us.values()),
        "tokens": [t for l in us.values() for t in dsl.line_tokens(l)],
        "uniform": render.render(lines),
        "uniform_us": render.render(list(us.values())),
        "rounds": rounds,
        "verified": report["ok"],
        "errors": report["errors"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="exports/dataset.jsonl")
    ap.add_argument("--strict", action="store_true", help="skip patterns that fail checks")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    vocab, kept, skipped = Counter(), 0, []
    with out.open("w") as f:
        for pid in store.list_ids():
            rec = export_pattern(pid)
            if args.strict and not rec["verified"]:
                skipped.append(pid)
                continue
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            vocab.update(rec["tokens"])
            kept += 1

    print(f"wrote {kept} patterns to {out}")
    if skipped:
        print(f"skipped (failed checks): {', '.join(skipped)}")
    print(f"vocab: {len(vocab)} tokens, {sum(vocab.values())} total")
    print("top:", " ".join(f"{t}:{n}" for t, n in vocab.most_common(20)))


if __name__ == "__main__":
    main()
