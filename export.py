"""Export the dataset to JSONL for training.

    python3 export.py                 # -> exports/dataset.jsonl
    python3 export.py --strict        # skip patterns with mismatches / parse errors

Each line is one pattern. DSL is normalised to US stitch names (dsl_us, tokens),
so UK and US patterns share one vocabulary; the original text is kept as-is.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from granny import dsl, store
from granny.check import check


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

    rounds = []
    for r in report["rounds"]:
        line = us.get(r["label"])
        rounds.append({
            "label": r["label"],
            "human": r["human"],
            "dsl_us": dsl.format_line(line) if line else None,
            "tokens": dsl.line_tokens(line) if line else None,
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
