"""Approximate crochet symbol chart for a granny square, laid out from the DSL.

This is a granny-square layout, not a full simulation: each round's four corner chains
(its longest chain spaces) go to the square's corners, the stitches between them are
spread along the side, and stitches worked into the same place fan out from a shared
base. It doesn't track which stitch of the previous round each new stitch goes into.

Output (JSON for the browser), coordinates in chart units centred on (0, 0):
    {size, ring: {r, a} | None, rounds: [{label, prims: [...], note: str | None}]}
    prim: {k: "dc"|"sc"|..., b: [x, y], t: [x, y], a: [atom...]}   stitch from base b to top t
          {k: "oval", c: [x, y], ang: degrees, a: [...]}            one chain
          {k: "dot", c: [x, y], a: [...]}                          slip stitch / join
    a = indices into that round's Line.atoms (the stitch's own atom first, then the
    enclosing placement / repeat atoms).
"""

from __future__ import annotations

import math

from .dsl import UK_TO_US, Group, Line, Op

U = 10.0   # stitch width and dc height, in chart units
R0 = 6.0   # magic ring radius
HEIGHT = {"sc": 0.5, "hdc": 0.75, "dc": 1.0, "tr": 1.35, "dtr": 1.7, "trtr": 2.0}
SLOT = {"ch": 0.55, "dot": 0.45}  # width along the round; stitches are 1.0
GAP = 2.8  # min distance between a raised join dot and its chain (dot r 1.1 + oval half-width 1.1 + air)

# Sides in drawing order (counterclockwise on screen, y down): top, left, bottom, right.
# Side k runs from corner k to corner k+1. n = outward normal, d = direction along the side.
SIDES = [((0, -1), (-1, 0)), ((-1, 0), (0, 1)), ((0, 1), (1, 0)), ((1, 0), (0, -1))]


def _index(items, counter, ids):
    """Atom index of each node, in the same order the parser records Line.atoms."""
    for it in items:
        if isinstance(it, Op):
            ids[id(it)] = counter[0]
            counter[0] += 1
            if it.place:
                ids[(id(it), "place")] = counter[0]
                counter[0] += 1
        elif isinstance(it, Group):
            _index(it.items, counter, ids)
            if it.place:
                ids[(id(it), "place")] = counter[0]
                counter[0] += 1
        else:
            _index(it.items, counter, ids)
            ids[(id(it), "rep")] = counter[0]
            counter[0] += 1


def _expand(items, ids, rename, ctx, out, group):
    """Flatten a round into individual stitches/chains, repeats unrolled.
    >landmark repeats are drawn once (their real count depends on the previous round)."""
    for it in items:
        if isinstance(it, Op):
            atoms = [ids[id(it)], *ctx] + ([ids[(id(it), "place")]] if it.place else [])
            if it.st == "ch":
                kind = "chcol" if it.as_ else "ch"
                out.append({"kind": kind, "n": it.count, "atoms": atoms, "group": group if it.as_ else None})
            elif it.st in ("sl", "join"):
                # join = sl st into the top of the beginning chain, same as sl@top.
                top = it.st == "join" or it.place == "top"
                out.append({"kind": "dot", "atoms": atoms, "group": None, "top": top})
            elif it.st in ("sk", "turn", "fo", "mr"):
                continue
            else:
                # "3tr@sp": the three share a base even outside a {...} group.
                g = group or (f"op{id(it)}-{len(out)}" if it.place and it.place != "ring" and it.count > 1 else None)
                for _ in range(it.count):
                    out.append({"kind": rename.get(it.st, it.st), "atoms": atoms, "group": g})
        elif isinstance(it, Group):
            extra = [ids[(id(it), "place")]] if it.place else []
            g = None if it.place == "ring" else f"g{id(it)}-{len(out)}"
            _expand(it.items, ids, rename, ctx + extra, out, g)
        else:
            marker = ids[(id(it), "rep")]
            for _ in range(it.times or 1):
                _expand(it.items, ids, rename, ctx + [marker], out, group)


def _height(item) -> float:
    if item["kind"] == "chcol":
        return item["n"] / 3
    return HEIGHT.get(item["kind"], 1.0)


def _slot(item) -> float:
    if item["kind"] == "ch":
        return SLOT["ch"] * item["n"]
    return SLOT.get(item["kind"], 1.0)


def _add(p, q, s=1.0):
    return (p[0] + q[0] * s, p[1] + q[1] * s)


def _place_round(items, r_in, h, ring: bool) -> tuple[list[dict], str | None]:
    """Positions for one round between the inner square (half-size r_in) and r_in + h.
    Returns (prims, note); note explains a fallback layout."""
    r_out = r_in + h
    for i, it in enumerate(items):
        it["order"] = i  # written order, since sides start at a corner
    # A slip stitch that closes the round joins it, whatever its placement (@top, @sp, …);
    # one that opens the round ("sl@sp" to move into a space) stays at the base.
    if items and items[-1]["kind"] == "dot":
        items[-1]["top"] = True
    # Corners are the longest chain spaces. A chain that opens the round is the beginning
    # chain (even without "=tr"), never a corner.
    chains = [i for i, it in enumerate(items) if it["kind"] == "ch" and i > 0]
    longest = max((items[i]["n"] for i in chains), default=0)
    corners = [i for i in chains if items[i]["n"] == longest]
    note = None if len(corners) == 4 else (
        f"found {len(corners)} corner chain{'s' * (len(corners) != 1)}"
        + (f" ({longest}ch)" if corners else "") + ", expected 4, so stitches are spread evenly")

    # Split the round into 4 sides, each preceded by its corner chain (or none).
    if len(corners) == 4:
        c0 = corners[0]
        seq = items[c0:] + items[:c0]
        cut = [i - c0 if i >= c0 else i - c0 + len(items) for i in corners]
        sides = [(seq[cut[k]], seq[cut[k] + 1: cut[k + 1] if k < 3 else len(seq)]) for k in range(4)]
    else:
        # No clear corners: spread everything evenly around the square.
        total = sum(_slot(it) for it in items) or 1
        per, sides, cur, acc = total / 4, [(None, []) for _ in range(4)], 0, 0.0
        for it in items:
            if acc >= per * (cur + 1) and cur < 3:
                cur += 1
            sides[cur][1].append(it)
            acc += _slot(it)

    prims, bases = [], {}  # bases: group -> list of base points, for fanning
    for k, (corner, run) in enumerate(sides):
        n, d = SIDES[k]
        if corner is not None:
            # Corner chain: ovals on an arc around the inner corner.
            prev_n = SIDES[k - 1][0]
            a0, a1 = math.atan2(prev_n[1], prev_n[0]), math.atan2(n[1], n[0])
            if a1 - a0 > math.pi:
                a1 -= 2 * math.pi
            if a0 - a1 > math.pi:
                a1 += 2 * math.pi
            centre = _add(_add((0, 0), n, r_in), d, -r_in)
            for j in range(corner["n"]):
                a = a0 + (a1 - a0) * (j + 0.5) / corner["n"]
                c = _add(centre, (math.cos(a), math.sin(a)), h * 0.95)
                prims.append({"k": "oval", "c": c, "ang": math.degrees(a) + 90, "a": corner["atoms"]})

        width = sum(_slot(it) for it in run)
        if not width:
            continue
        u = min(U, (2 * r_out - 1.2 * U) / width)
        x = -width * u / 2
        for it in run:
            w = _slot(it) * u
            if it["kind"] == "ch":
                for j in range(it["n"]):
                    xj = x + (j + 0.5) * SLOT["ch"] * u
                    c = _add(_add((0, 0), n, r_in + h * 0.92), d, xj)
                    prims.append({"k": "oval", "c": c, "ang": math.degrees(math.atan2(d[1], d[0])), "a": it["atoms"]})
            else:
                xc = max(-r_in, min(r_in, x + w / 2))
                base = _add(_add((0, 0), n, r_in), d, xc)
                if ring:
                    # Round 1 grows out of the magic ring, not a square.
                    top = _add(_add((0, 0), n, r_out if it["kind"] != "dot" else r_in), d, x + w / 2)
                    ln = math.hypot(*top) or 1
                    base = (top[0] / ln * R0, top[1] / ln * R0)
                p = {"k": it["kind"], "b": base, "a": it["atoms"], "n": it.get("n"), "_side": (n, d, x + w / 2),
                     "_order": it["order"], "_n": it.get("n"), "_x": (n, x + w / 2)}
                if it["kind"] == "dot":
                    p = {"k": "dot", "c": base, "a": it["atoms"], "_top": it["top"], "_at": (n, d, xc)}
                elif it["group"]:
                    bases.setdefault(it["group"], []).append(p)
                prims.append(p)
            x += w

    # Fan: stitches worked into one place share the mean of their bases.
    for members in bases.values():
        bx = sum(p["b"][0] for p in members) / len(members)
        by = sum(p["b"][1] for p in members) / len(members)
        for p in members:
            p["b"] = (bx, by)

    # Tops: straight out from where the stitch sits on the side, at its own height.
    for p in prims:
        if "_side" in p:
            n, d, xc = p.pop("_side")
            p["t"] = _add(_add((0, 0), n, r_in + _height({"kind": p["k"], "n": p.pop("n")}) * U), d, xc)

    # sl@top / join: raised to the height of the beginning chain's top (else the round's
    # first stitch), but kept at its own place along the round so it sits beside the chain.
    stitches = sorted((p for p in prims if "t" in p), key=lambda p: p["_order"])
    target = next((p for p in stitches if p["k"] == "chcol"), stitches[0] if stitches else None)
    for p in prims:
        n, d, xc = p.pop("_at", (None, None, None))
        if p.pop("_top", False) and target:
            level = r_in + _height({"kind": target["k"], "n": target.get("_n")}) * U
            tn, tx = target["_x"]
            if tn == n and abs(xc - tx) < GAP:  # keep clear of the chain it's worked into
                xc = tx + math.copysign(GAP, (xc - tx) or -1)
            p["c"] = _add(_add((0, 0), n, level), d, xc)
        p.pop("_order", None)
    for p in prims:
        p.pop("_n", None)
        p.pop("_x", None)
    return prims, note


def layout(lines: list[Line], terms: str = "US") -> dict:
    rename = UK_TO_US if terms.upper() == "UK" else {}
    out = {"rounds": [], "ring": None, "size": R0 + U}
    r_in, first = R0, True
    for line in lines:
        ids = {}
        _index(line.items, [0], ids)
        if line.label == "start":
            mr = [ids[id(it)] for it in line.items if isinstance(it, Op) and it.st == "mr"]
            if mr:
                out["ring"] = {"r": R0, "a": mr}
            continue
        items = []
        _expand(line.items, ids, rename, [], items, None)
        if not any(it["kind"] not in ("dot",) for it in items):
            continue
        h = max([_height(it) for it in items if it["kind"] not in ("ch", "dot")] or [0.6]) * U
        prims, note = _place_round(items, r_in, h, ring=first)
        out["rounds"].append({"label": line.label, "prims": prims, "note": note})
        r_in += h
        first = False
    out["size"] = r_in + 0.8 * U
    return out
