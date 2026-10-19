"""Build a static, read-only copy of the site plus a JSON API into public/ (deployed by Vercel).

    python3 build_static.py           # -> public/

Public API (CORS open, see vercel.json); rejected patterns are left out:
    /api/index.json              summary of every pattern
    /api/patterns/<id>.json      one pattern, same record as export.py
    /api/dataset.json            all records as one JSON array
    /api/dataset.jsonl           all records, one per line
    /images/<id>/<file>          images

The viewer reads /ui/*.json, which holds the editor data plus precomputed checks.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from export import export_pattern
from granny import store
from granny.check import check

HERE = Path(__file__).resolve().parent
OUT = HERE / "public"
# Set by Vercel at build time; gives absolute image URLs to sites using the API.
HOST = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL")
BASE = f"https://{HOST}" if HOST else ""


def write(path: str, data, jsonl: bool = False):
    p = OUT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    if jsonl:
        p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in data))
    else:
        p.write_text(json.dumps(data, ensure_ascii=False))


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "static").mkdir(parents=True)
    shutil.copy(HERE / "web" / "style.css", OUT / "static")
    shutil.copy(HERE / "web" / "app.js", OUT / "static")
    html = (HERE / "web" / "index.html").read_text()
    (OUT / "index.html").write_text(html.replace('<html lang="en">', '<html lang="en" data-readonly>', 1))

    records, ui_list = [], []
    for pid in store.list_ids():
        p = store.load(pid)
        if p["meta"]["status"] == "rejected":
            continue
        r = check(p["human"], p["dsl"], p["meta"]["terms"], p["meta"]["abbreviations"])
        write(f"ui/{pid}.json", {**p, "check": r})
        ui_list.append({**p["meta"], "rounds": len(r["rounds"]), "ok": r["ok"],
                        "statuses": [x["status"] for x in r["rounds"]]})

        rec = export_pattern(pid)
        for img in rec["images"]:
            img["url"] = f"{BASE}/images/{pid}/{img['file']}"
        write(f"api/patterns/{pid}.json", rec)
        records.append(rec)
        if (store.ROOT / pid / "images").is_dir():
            shutil.copytree(store.ROOT / pid / "images", OUT / "images" / pid)

    write("ui/patterns.json", ui_list)
    write("api/dataset.json", records)
    write("api/dataset.jsonl", records, jsonl=True)
    write("api/index.json", {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(records),
        "patterns": [{"id": r["id"], "title": r["title"], "status": r["status"], "terms": r["terms"],
                      "rounds": len(r["rounds"]), "verified": r["verified"], "images": len(r["images"]),
                      "url": f"{BASE}/api/patterns/{r['id']}.json"} for r in records],
    })
    print(f"built {len(records)} patterns into {OUT.relative_to(HERE)}/")


if __name__ == "__main__":
    main()
