"""Filesystem storage. One folder per pattern:

    data/patterns/<id>/
        meta.json      title, terms (UK/US), source, license, images[...]
        human.txt      the pattern as published
        pattern.dsl    the machine-readable version
        images/        photos, charts
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "data" / "patterns"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"}

DEFAULT_META = {"title": "", "terms": "US", "source": "", "author": "", "license": "",
                "notes": "", "tags": [], "images": []}


def _dir(pid: str) -> Path:
    if not re.fullmatch(r"[\w-]+", pid):
        raise ValueError(f"bad pattern id {pid!r}")
    return ROOT / pid


def list_ids() -> list[str]:
    ROOT.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in ROOT.iterdir() if (p / "meta.json").exists())


def load(pid: str) -> dict:
    d = _dir(pid)
    meta = {**DEFAULT_META, **json.loads((d / "meta.json").read_text())}
    meta["id"] = pid
    read = lambda name: (d / name).read_text() if (d / name).exists() else ""
    return {"meta": meta, "human": read("human.txt"), "dsl": read("pattern.dsl")}


def save(pid: str, meta: dict | None = None, human: str | None = None, dsl: str | None = None):
    d = _dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    if meta is not None:
        meta = {**DEFAULT_META, **meta, "id": pid}
        (d / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    if human is not None:
        (d / "human.txt").write_text(human)
    if dsl is not None:
        (d / "pattern.dsl").write_text(dsl)


def create(title: str) -> str:
    nums = [int(i) for i in list_ids() if i.isdigit()]
    pid = f"{max(nums, default=0) + 1:04d}"
    save(pid, meta={"title": title}, human="", dsl="")
    return pid


def add_image(pid: str, filename: str, data: bytes) -> str:
    d = _dir(pid) / "images"
    d.mkdir(parents=True, exist_ok=True)
    stem, ext = Path(filename).stem, Path(filename).suffix.lower()
    if ext not in IMAGE_EXTS:
        raise ValueError(f"unsupported image type {ext!r}")
    stem = re.sub(r"[^\w-]+", "-", stem).strip("-") or "image"
    name, n = f"{stem}{ext}", 1
    while (d / name).exists():
        n += 1
        name = f"{stem}-{n}{ext}"
    (d / name).write_bytes(data)

    p = load(pid)
    p["meta"]["images"].append({"file": name, "kind": "finished", "round": None, "caption": ""})
    save(pid, meta=p["meta"])
    return name


def remove_image(pid: str, name: str):
    path = _dir(pid) / "images" / Path(name).name
    if path.exists():
        path.unlink()
    p = load(pid)
    p["meta"]["images"] = [i for i in p["meta"]["images"] if i["file"] != name]
    save(pid, meta=p["meta"])


def image_path(pid: str, name: str) -> Path:
    return _dir(pid) / "images" / Path(name).name
