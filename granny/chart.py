"""Approximate crochet symbol chart for a granny square, laid out from the DSL.

This is a granny-square layout, not a full simulation: each round's four corner chains
(its longest chain spaces) go to the square's corners, the stitches between them are
spread along the side, and stitches worked into the same place fan out from a shared
base. It doesn't track which stitch of the previous round each new stitch goes into.

Rounds without four corner chains get a shape between circle and square (a superellipse,
|x|^p + |y|^p = R^p): p = 2 is a circle, large p a square. A round's squareness only
grows: four corner features (clusters of taller stitches, e.g. dtr among tr, or four
shells) add to the previous round's p. Stitches are spread evenly around the shape, with
the first corner feature at the top-right corner, where the square layout puts its
first corner.

Output (JSON for the browser), coordinates in chart units centred on (0, 0):
    {size, ring: {r, a, y} | None, rounds: [{label, prims: [...], note: str | None}], colors: [str]}
    prim: {k: "dc"|"sc"|..., b: [x, y], t: [x, y], a: [atom...]}   stitch from base b to top t
          {k: "oval", c: [x, y], ang: degrees, a: [...]}            one chain
          {k: "dot", c: [x, y], a: [...]}                          slip stitch / join
    a = indices into that round's Line.atoms (the stitch's own atom first, then the
    enclosing placement / repeat atoms).
    Every prim also has y: its yarn colour ("C2", from C2@…) or None. colors lists the
    colours used, in order of first use.
"""

from __future__ import annotations

import math

from .dsl import UK_TO_US, Color, Group, Line, Op

U = 10.0   # stitch width and dc height, in chart units
R0 = 6.0   # magic ring radius
HEIGHT = {"sc": 0.5, "hdc": 0.75, "dc": 1.0, "tr": 1.35, "dtr": 1.7, "trtr": 2.0}
SLOT = {"ch": 0.55, "dot": 0.45}  # width along the round; stitches are 1.0
GAP = 2.8  # min distance between a raised join dot and its chain (dot r 1.1 + oval half-width 1.1 + air)
SQUARE = 40.0  # superellipse exponent treated as a square


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
        elif isinstance(it, Color):
            ids[id(it)] = counter[0]
            counter[0] += 1
            _index(it.items, counter, ids)
        else:
            _index(it.items, counter, ids)
            ids[(id(it), "rep")] = counter[0]
            counter[0] += 1


def _expand(items, ids, rename, ctx, out, group, colors, color=None, fixed=None):
    """Flatten a round into individual stitches/chains, repeats unrolled.
    >landmark repeats are drawn once (their real count depends on the previous round).
    colors collects each stitch atom's yarn colour. fixed: inside an abbreviation's
    definition, which has no atoms of its own, every stitch gets the abbreviation's atoms."""
    for it in items:
        if isinstance(it, Op) and it.expand and fixed is None:
            # "vs@sp" is drawn like "{tr 1ch tr}@sp"; a bare "vs" just inlines its stitches.
            colors[ids[id(it)]] = color
            atoms = [ids[id(it)], *ctx] + ([ids[(id(it), "place")]] if it.place else [])
            for _ in range(it.count):
                g = None if it.place == "ring" else f"a{id(it)}-{len(out)}" if it.place else group
                _expand(it.expand, ids, rename, ctx, out, g, colors, color, fixed=atoms)
        elif isinstance(it, Op):
            if fixed is None:
                colors[ids[id(it)]] = color
                atoms = [ids[id(it)], *ctx] + ([ids[(id(it), "place")]] if it.place else [])
            else:
                atoms = fixed
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
            extra = [ids[(id(it), "place")]] if it.place and fixed is None else []
            g = None if it.place == "ring" else f"g{id(it)}-{len(out)}"
            _expand(it.items, ids, rename, ctx + extra, out, g, colors, color, fixed)
        elif isinstance(it, Color):
            extra = [ids[id(it)]] if fixed is None else []
            _expand(it.items, ids, rename, ctx + extra, out, group, colors, it.color, fixed)
        else:
            extra = [ids[(id(it), "rep")]] if fixed is None else []
            for _ in range(it.times or 1):
                _expand(it.items, ids, rename, ctx + extra, out, group, colors, color, fixed)


def _ring(items, ids, ctx=()):
    """Atoms of the setup line's magic ring (its own atom first, then enclosing colours)."""
    for it in items:
        if isinstance(it, Op) and it.st == "mr":
            return [ids[id(it)], *ctx]
        if isinstance(it, Color):
            found = _ring(it.items, ids, (*ctx, ids[id(it)]))
            if found:
                return found
    return None


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


def _corner_chains(items) -> tuple[list[int], int]:
    """Corners are the longest chain spaces. A chain that opens the round is the beginning
    chain (even without "=tr"), never a corner."""
    chains = [i for i, it in enumerate(items) if it["kind"] == "ch" and i > 0]
    longest = max((items[i]["n"] for i in chains), default=0)
    return [i for i in chains if items[i]["n"] == longest], longest


def _features(items) -> tuple[float, int | None]:
    """How much a round squares itself up, and the item at its first corner.

    Four clusters of the round's tallest stitches (when not all stitches are equally
    tall), or four shells (3+ stitches worked into one place), act as corners.
    Returns (added squareness, index of the first feature's middle item or None)."""
    sts = [i for i, it in enumerate(items) if it["kind"] not in ("ch", "dot", "chcol")]
    heights = [_height(items[i]) for i in sts]
    boost, anchor = 0.0, None
    if heights and max(heights) > min(heights):
        hmax = max(heights)
        clusters, prev = [], None
        for pos, i in enumerate(sts):
            if heights[pos] == hmax:
                if prev is not None and pos == prev + 1:
                    clusters[-1].append(i)
                else:
                    clusters.append([i])
                prev = pos
        if len(clusters) > 4 and sts and clusters[0][0] == sts[0] and clusters[-1][-1] == sts[-1]:
            clusters[0] = clusters.pop() + clusters[0]  # a cluster wrapping the start
        if len(clusters) == 4:
            median = sorted(heights)[len(heights) // 2]
            boost = 8 * (hmax / median - 1)
            anchor = clusters[0][len(clusters[0]) // 2]
    groups = {}
    for i in sts:
        if items[i]["group"]:
            groups.setdefault(items[i]["group"], []).append(i)
    shells = [g for g in groups.values() if len(g) >= 3]
    if len(shells) == 4:
        boost = max(boost, 2.0)
        if anchor is None:
            anchor = shells[0][len(shells[0]) // 2]
    return boost, anchor


class _Curve:
    """Superellipse of half-size R and exponent p, walked from the top-right corner
    counterclockwise on screen (the same way round as the square layout's sides)."""

    def __init__(self, R: float, p: float, samples: int = 720):
        self.pts = []
        for j in range(samples):
            t = -math.pi / 4 - 2 * math.pi * j / samples
            c, s = math.cos(t), math.sin(t)
            self.pts.append((R * math.copysign(abs(c) ** (2 / p), c), R * math.copysign(abs(s) ** (2 / p), s)))
        self.cum = [0.0]
        for j in range(samples):
            a, b = self.pts[j], self.pts[(j + 1) % samples]
            self.cum.append(self.cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.length = self.cum[-1]

    def at(self, f: float):
        """(point, tangent angle in degrees) at fraction f of the way round."""
        d = (f % 1.0) * self.length
        lo, hi = 0, len(self.pts)
        while hi - lo > 1:
            mid = (lo + hi) // 2
            lo, hi = (mid, hi) if self.cum[mid] <= d else (lo, mid)
        a, b = self.pts[lo], self.pts[(lo + 1) % len(self.pts)]
        seg = (self.cum[lo + 1] - self.cum[lo]) or 1.0
        t = (d - self.cum[lo]) / seg
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


def _place_shaped(items, r_in, h, ring: bool, p_in: float, p_out: float, anchor) -> list[dict]:
    """Stitches spread evenly around a superellipse round (see the module docstring)."""
    inner, outer = _Curve(r_in, p_in), _Curve(r_in + h, p_out)
    chain_level = _Curve(r_in + h * 0.92, p_out)
    width = sum(_slot(it) for it in items) or 1.0
    cum, starts = 0.0, []
    for it in items:
        starts.append(cum)
        cum += _slot(it)
    shift = (starts[anchor] + _slot(items[anchor]) / 2) / width if anchor is not None else 0.0

    prims, bases = [], {}
    for it, c0 in zip(items, starts):
        f = (c0 + _slot(it) / 2) / width - shift
        if it["kind"] == "ch":
            for j in range(it["n"]):
                pt, ang = chain_level.at((c0 + (j + 0.5) * SLOT["ch"]) / width - shift)
                prims.append({"k": "oval", "c": pt, "ang": ang, "a": it["atoms"]})
            continue
        top_dir, _ = outer.at(f)
        if ring:
            ln = math.hypot(*top_dir) or 1  # round 1 grows out of the magic ring
            base = (top_dir[0] / ln * R0, top_dir[1] / ln * R0)
        else:
            base, _ = inner.at(f)
        if it["kind"] == "dot":
            prims.append({"k": "dot", "c": base, "a": it["atoms"], "_top": it["top"], "_f": f})
            continue
        p = {"k": it["kind"], "b": base, "a": it["atoms"], "_f": f, "_h": _height(it) * U,
             "_order": it["order"], "_dir": top_dir}
        if it["group"]:
            bases.setdefault(it["group"], []).append(p)
        prims.append(p)

    # Fan: stitches worked into one place share the mean of their bases.
    for members in bases.values():
        bx = sum(p["b"][0] for p in members) / len(members)
        by = sum(p["b"][1] for p in members) / len(members)
        for p in members:
            p["b"] = (bx, by)
    # Tops: from the base towards the round's outline, at the stitch's own height.
    for p in prims:
        if "_dir" in p:
            tx, ty = p.pop("_dir")
            bx, by = p["b"]
            ln = math.hypot(tx - bx, ty - by) or 1
            p["t"] = (bx + (tx - bx) / ln * p["_h"], by + (ty - by) / ln * p["_h"])

    # Closing slip stitch: beside the top of the beginning chain (else the first stitch).
    stitches = sorted((p for p in prims if "t" in p), key=lambda p: p["_order"])
    target = next((p for p in stitches if p["k"] == "chcol"), stitches[0] if stitches else None)
    tf, th = (target["_f"], target["_h"]) if target else (None, None)
    for p in prims:
        f = p.pop("_f", None)
        if p.pop("_top", False) and target:
            level = _Curve(r_in + th, p_out)
            df, gap = GAP / level.length, (f - tf + 0.5) % 1.0 - 0.5
            if abs(gap) < df:  # keep clear of the chain it's worked into
                f = tf + math.copysign(df, gap or -1)
            p["c"], _ = level.at(f)
    for p in prims:
        for k in ("_h", "_order"):
            p.pop(k, None)
    return prims


def _place_round(items, r_in, h, ring: bool, p_in: float = 2.0, p_out: float = 2.0,
                 anchor=None) -> tuple[list[dict], str | None]:
    """Positions for one round between the inner square (half-size r_in) and r_in + h.
    Returns (prims, note); note points out a likely mistake."""
    r_out = r_in + h
    for i, it in enumerate(items):
        it["order"] = i  # written order, since sides start at a corner
    # A slip stitch that closes the round joins it, whatever its placement (@top, @sp, …);
    # one that opens the round ("sl@sp" to move into a space) stays at the base.
    if items and items[-1]["kind"] == "dot":
        items[-1]["top"] = True
    corners, longest = _corner_chains(items)
    if len(corners) != 4:
        # 1–3 corner chains is most likely a repeat count off by one.
        note = (f"found {len(corners)} corner chain{'s' * (len(corners) != 1)} ({longest}ch), expected 4,"
                " so this round is drawn as a rounded shape") if 1 <= len(corners) <= 3 else None
        return _place_shaped(items, r_in, h, ring, p_in, p_out, anchor), note
    note = None

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
    out = {"rounds": [], "ring": None, "size": R0 + U, "colors": []}
    r_in, first, p = R0, True, 2.0  # p: squareness of the round below (the ring is a circle)
    for line in lines:
        ids = {}
        _index(line.items, [0], ids)
        items, colors = [], {}
        _expand(line.items, ids, rename, [], items, None, colors)
        for c in colors.values():
            if c and c not in out["colors"]:
                out["colors"].append(c)
        if line.label == "start":
            mr = _ring(line.items, ids)
            if mr:
                out["ring"] = {"r": R0, "a": mr, "y": colors[mr[0]]}
            continue
        if not any(it["kind"] not in ("dot",) for it in items):
            continue
        h = max([_height(it) for it in items if it["kind"] not in ("ch", "dot")] or [0.6]) * U
        corners, _ = _corner_chains(items)
        if len(corners) == 4:
            p_out, anchor = SQUARE, None
        else:
            boost, anchor = _features(items)
            p_out = min(SQUARE, p + boost)
        prims, note = _place_round(items, r_in, h, ring=first, p_in=p, p_out=p_out, anchor=anchor)
        for prim in prims:
            prim["y"] = colors[prim["a"][0]]
        out["rounds"].append({"label": line.label, "prims": prims, "note": note})
        p = p_out
        r_in += h
        first = False
    out["size"] = r_in + 0.8 * U
    return out
