"""Link parts of the DSL to the human text they came from.

Both sides are reduced to a sequence of atoms in written order:
  human "[2 tr, 3 ch, 3 tr] in same 3-ch sp"  -> tr(2) ch(3) tr(3) place(same)
  DSL   "{2tr 3ch 3tr}@same"                  -> tr(2) ch(3) tr(3) place(same)
and aligned with Needleman-Wunsch, so a few extra/missing atoms on either side
don't throw off the rest of the round.
"""

from __future__ import annotations

import re

from . import dsl

_ST_NAMES = r"ch(?:ain)?|sc|hdc|htr|dc|tr|dtr|ttr|trtr|ss|sl\s*st|slst|puff|pc|bob|cl|picot|fpdc|bpdc|fptr|bptr"
_SP = r"(?!\s*-?\s*(?:sps?|spaces?)\b)(?!-)"

_MENTION = re.compile(
    rf"""
    (?P<join>\bjoin\b[^,.;]*)
  | (?P<turn>\bturn\b)
  | (?P<fo>\bfasten\s+off\b)
  | (?P<mr>\b(?:magic|adjustable)\s+(?:ring|loop)\b)
  | (?P<skip>\b(?:skip|sk)\s+(?:the\s+)?(?:next\s+)?(?P<skn>\d+)?\s*(?:sts?\b|stitch(?:es)?\b)?)
  | (?P<rep>\brep(?:eat)?\s+from\s+\*+[^,.;]*
        | \]\s*(?:twice|three\s+times|four\s+times|\d+\s+times|to\s+[^,.;]*)
        | \b(?:to|until)\s+(?:the\s+)?(?:next\s+)?(?:corner|end)\b[^,.;]*)
  | (?P<place>\b(?:in|into)\s+(?:the\s+)?(?:same|next|each|first|last)?\s*(?:[\w-]+\s+){{0,2}}?
        (?:[\w-]*sp\b|spaces?\b|ring\b|sts?\b|stitch\b|corner\b|loop\b))
  | (?P<st>(?:\b(?P<n1>\d+)\s*)?(?<![-a-zA-Z])(?P<name>{_ST_NAMES})s?\b{_SP}(?:\s+(?P<n2>\d+)\b{_SP})?)
    """,
    re.VERBOSE | re.IGNORECASE,
)

_KINDS = ("join", "turn", "fo", "mr", "skip", "rep", "place", "st")
_HUMAN_NAMES = {"ss": "sl", "slst": "sl", "sl st": "sl", "chain": "ch"}


def _mask_parens(text: str) -> str:
    """Blank out (...) asides like "(counts as tr)" or "(12 tr, 4 3-ch sps.)",
    keeping offsets intact."""
    out, depth = [], 0
    for c in text:
        if c == "(":
            depth += 1
        out.append(" " if depth else c)
        if c == ")" and depth:
            depth -= 1
    return "".join(out)


def human_atoms(text: str, offset: int = 0) -> list[tuple]:
    """(kind, key, count, start, end) for each stitch/place/repeat mention."""
    atoms = []
    for m in _MENTION.finditer(_mask_parens(text)):
        kind = next(k for k in _KINDS if m.group(k) is not None)
        s, e = m.start() + offset, m.end() + offset
        if kind == "st":
            name = re.sub(r"\s+", " ", m.group("name").lower())
            name = _HUMAN_NAMES.get(name, name)
            atoms.append(("op", name, int(m.group("n1") or m.group("n2") or 1), s, e))
        elif kind == "skip":
            atoms.append(("op", "sk", int(m.group("skn") or 1), s, e))
        elif kind == "place":
            atoms.append(("place", m.group(0).lower(), 1, s, e))
        elif kind == "rep":
            atoms.append(("rep", m.group(0).lower(), 1, s, e))
        else:
            atoms.append(("op", kind, 1, s, e))
    return atoms


def clauses(text: str, offset: int = 0) -> list[tuple[int, int]]:
    """Top-level comma/period-separated spans, so "[3 tr, 3 ch, 3 tr] in next sp" stays whole."""
    out, depth, start = [], 0, 0
    masked = _mask_parens(text)
    for i, c in enumerate(masked):
        if c == "[":
            depth += 1
        elif c == "]":
            depth = max(0, depth - 1)
        elif c in ",;." and depth == 0:
            if masked[start:i].strip():
                out.append((start, i))
            start = i + 1
    if masked[start:].strip():
        out.append((start, len(text)))
    # Trim surrounding whitespace.
    res = []
    for s, e in out:
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        res.append((s + offset, e + offset))
    return res


def _place_key(text: str) -> str:
    for k in ("ring", "same", "corner"):
        if k in text:
            return k
    return "sp" if "sp" in text else "st"


def _score(d, h) -> float | None:
    """Match score for a DSL atom vs a human atom; None = can't pair."""
    if d[0] != h[0]:
        return None
    if d[0] == "op":
        if d[1] != h[1]:
            return None
        return 4 if d[2] == h[2] else 2
    if d[0] == "place":
        dk, hk = d[1], _place_key(h[1])
        return 3 if dk == hk or {dk, hk} <= {"sp", "corner"} else 1
    return 3  # rep


def align(d_atoms: list, h_atoms: list) -> list[tuple[int, int]]:
    """Needleman-Wunsch over two atom lists; returns (dsl_index, human_index) pairs."""
    n, m, gap = len(d_atoms), len(h_atoms), -1
    S = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        S[i][0] = i * gap
    for j in range(1, m + 1):
        S[0][j] = j * gap
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = max(S[i - 1][j] + gap, S[i][j - 1] + gap)
            sc = _score(d_atoms[i - 1], h_atoms[j - 1])
            if sc is not None:
                best = max(best, S[i - 1][j - 1] + sc)
            S[i][j] = best
    pairs, i, j = [], n, m
    while i > 0 and j > 0:
        sc = _score(d_atoms[i - 1], h_atoms[j - 1])
        if sc is not None and S[i][j] == S[i - 1][j - 1] + sc:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif S[i][j] == S[i - 1][j] + gap:
            i -= 1
        else:
            j -= 1
    pairs.reverse()

    # Second pass: placements often move ("into ring work 2 tr…" vs "{2tr…}@ring").
    # Pair leftover places with a compatible leftover human place in the same round.
    used_d, used_h = {p[0] for p in pairs}, {p[1] for p in pairs}
    for i, d in enumerate(d_atoms):
        if d[0] != "place" or i in used_d:
            continue
        for j, h in enumerate(h_atoms):
            if j not in used_h and h[0] == "place" and (_score(d, h) or 0) >= 3:
                pairs.append((i, j))
                used_h.add(j)
                break
    return sorted(pairs)
