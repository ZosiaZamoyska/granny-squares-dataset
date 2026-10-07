"""Parser for the granny-square pattern DSL (see README.md for the spec).

One round per line:

    start: MR
    R1: 3ch=tr {2tr 3ch [3tr 3ch]x3}@ring join turn
    R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@corner 1ch]x3 join turn
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

# Stitch vocabulary. Unknown stitches parse fine but produce a warning.
STRUCTURAL = {"ch", "sl", "sk", "sksp", "join", "turn", "fo", "mr", "st"}
US_STITCHES = {"sc", "hdc", "dc", "tr", "dtr", "trtr"}
UK_STITCHES = {"dc", "htr", "tr", "dtr", "ttr", "qtr"}
SPECIAL = {"puff", "pc", "bob", "cl", "picot", "fpdc", "bpdc", "fptr", "bptr", "blo", "flo", "spike"}
ALIASES = {"ss": "sl", "slst": "sl", "skip": "sk", "magicring": "mr"}
KNOWN = STRUCTURAL | US_STITCHES | UK_STITCHES | SPECIAL

# UK -> US names, used when normalising for export.
UK_TO_US = {"dc": "sc", "htr": "hdc", "tr": "dc", "dtr": "tr", "ttr": "dtr", "qtr": "trtr"}

# Stitches that don't count toward stitch totals.
NON_STITCH = {"ch", "sl", "sk", "sksp", "join", "turn", "fo", "mr"}

PLACES = {"ring", "sp", "same", "st", "top", "next", "side"}
# Corners are just chain spaces: "@corner" is accepted and means "@sp".
PLACE_ALIASES = {"corner": "sp"}


class DSLError(ValueError):
    pass


@dataclass
class Op:
    st: str
    count: int = 1
    as_: str | None = None  # "3ch=tr": chain counts as a stitch
    place: str | None = None


@dataclass
class Group:
    """{...}@place: everything worked into the same place."""
    items: list
    place: str | None = None


@dataclass
class Repeat:
    """[...]x3 (fixed) or [...]>corner (until a landmark; count unknown)."""
    items: list
    times: int | None = None
    until: str | None = None


@dataclass
class Line:
    label: str  # "start", "1", "6-10"
    items: list
    warnings: list = field(default_factory=list)
    # Source positions in the raw line, in written order, for linking to the human text:
    # (kind, key, count, start, end); kind is "op" | "place" | "rep".
    atoms: list = field(default_factory=list)


_TOKEN = re.compile(
    r"""
    (?P<ws>[\s,]+)
  | (?P<lbrace>\{) | (?P<rbrace>\}) | (?P<lbrack>\[) | (?P<rbrack>\])
  | (?P<times>x(?P<n>\d+)\b)
  | (?P<until>>(?P<landmark>[a-z][\w-]*))
  | (?P<at>@(?P<place>[a-z][\w-]*))
  | (?P<op>(?P<count>\d+)?(?P<st>[a-z]+)(?:=(?P<as>[a-z]+))?)
    """,
    re.VERBOSE | re.IGNORECASE,
)
_KINDS = ("ws", "lbrace", "rbrace", "lbrack", "rbrack", "times", "until", "at", "op")

_LINE = re.compile(r"^\s*(?:R(?:ound|nd)?\s*(?P<num>\d+(?:-\d+)?)|(?P<start>start))\s*:\s*(?P<body>.*)$", re.I)


def _lex(text: str):
    pos = 0
    out = []
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise DSLError(f"unexpected {text[pos:pos + 10]!r} at column {pos + 1}")
        pos = m.end()
        # lastgroup can be an inner group (e.g. "st"), so look up the outer one.
        kind = next(k for k in _KINDS if m.group(k) is not None)
        if kind == "ws":
            continue
        out.append((kind, m))
    return out


def _place(m, warnings):
    place = m.group("place").lower()
    place = PLACE_ALIASES.get(place, place)
    if place not in PLACES:
        warnings.append(f"unknown place @{place}")
    return place


def _parse_items(toks, i, closer, warnings, atoms):
    items = []
    while i < len(toks):
        kind, m = toks[i]
        if kind == closer:
            return items, i + 1
        if kind in ("rbrace", "rbrack"):
            raise DSLError(f"unexpected {m.group(0)!r}")
        if kind == "lbrace":
            inner, i = _parse_items(toks, i + 1, "rbrace", warnings, atoms)
            g = Group(inner)
            if i < len(toks) and toks[i][0] == "at":
                g.place = _place(toks[i][1], warnings)
                atoms.append(("place", g.place, 1, *toks[i][1].span()))
                i += 1
            else:
                warnings.append("{...} group without @place")
            items.append(g)
        elif kind == "lbrack":
            inner, i = _parse_items(toks, i + 1, "rbrack", warnings, atoms)
            if i >= len(toks) or toks[i][0] not in ("times", "until"):
                raise DSLError("[...] must be followed by xN or >landmark")
            k, mm = toks[i]
            atoms.append(("rep", mm.group(0).lower(), 1, *mm.span()))
            items.append(Repeat(inner, times=int(mm.group("n"))) if k == "times"
                         else Repeat(inner, until=mm.group("landmark").lower()))
            i += 1
        elif kind == "op":
            st = m.group("st").lower()
            st = ALIASES.get(st, st)
            if st not in KNOWN:
                warnings.append(f"unknown stitch {st!r}")
            op = Op(st, int(m.group("count") or 1), (m.group("as") or "").lower() or None)
            atoms.append(("op", st, op.count, *m.span()))
            i += 1
            if i < len(toks) and toks[i][0] == "at" and toks[i][1].start() == m.end():
                op.place = _place(toks[i][1], warnings)
                atoms.append(("place", op.place, 1, *toks[i][1].span()))
                i += 1
            items.append(op)
        elif kind == "at":
            raise DSLError(f"{m.group(0)!r} must directly follow a stitch or }}")
        else:
            raise DSLError(f"{m.group(0)!r} must directly follow ]")
    if closer:
        raise DSLError(f"missing closing {'}' if closer == 'rbrace' else ']'}")
    return items, i


def parse_line(text: str) -> Line | None:
    """Parse one DSL line. Returns None for blank/comment lines."""
    code = text.split("#", 1)[0]
    if not code.strip():
        return None
    m = _LINE.match(code)
    if not m:
        raise DSLError("line must start with 'R<n>:' or 'start:'")
    label = "start" if m.group("start") else m.group("num")
    warnings, atoms = [], []
    items, _ = _parse_items(_lex(m.group("body")), 0, None, warnings, atoms)
    # Atom positions are relative to the body; shift them to the raw line.
    off = m.start("body")
    atoms = [(k, key, n, s + off, e + off) for k, key, n, s, e in atoms]
    return Line(label, items, warnings, atoms)


def parse(text: str) -> list[Line]:
    """Parse a whole DSL document; raises DSLError with the line number."""
    lines = []
    for n, raw in enumerate(text.splitlines(), 1):
        try:
            line = parse_line(raw)
        except DSLError as e:
            raise DSLError(f"line {n}: {e}") from None
        if line:
            lines.append(line)
    return lines


# ---- counting -------------------------------------------------------------

def _op_counts(op: Op) -> Counter:
    c = Counter()
    if op.st == "ch":
        if op.as_:
            c[op.as_] += 1
            c["st"] += 1
        else:
            c[f"{op.count}ch-sp"] += 1
    elif op.st in ("sk", "sksp"):
        pass
    elif op.st in ("join", "turn", "fo", "mr"):
        c[op.st] += 1
    else:
        c[op.st] += op.count
        if op.st not in NON_STITCH:
            c["st"] += op.count
    return c


def _walk(items, cur: Counter, state: dict, snap, ctx=()):
    """Accumulate counts into cur. Calls snap(ctx) after each atom, in the same
    order the parser records Line.atoms. state["exact"] turns False after a >landmark repeat."""
    for it in items:
        if isinstance(it, Op):
            cur.update(_op_counts(it))
            snap(ctx)
            if it.place:
                snap(ctx)
        elif isinstance(it, Group):
            _walk(it.items, cur, state, snap, ctx)
            if it.place:
                snap(ctx)
        else:
            before = Counter(cur)
            marker = f"x{it.times}" if it.times else f">{it.until}"
            _walk(it.items, cur, state, snap, (*ctx, marker))
            if it.times:
                for k, v in (cur - before).items():
                    cur[k] = before[k] + v * it.times
            else:
                state["exact"] = False  # counted once; real length depends on the previous round
            snap(ctx)


def count(items) -> tuple[Counter, bool]:
    """Stitch counts for a list of items.

    Returns (counter, exact). exact is False when a >landmark repeat makes the
    total depend on the previous round.
    Keys: stitch names ("tr"), chain spaces ("3ch-sp"), and "st" (all stitches).
    """
    cur, state = Counter(), {"exact": True}
    _walk(items, cur, state, lambda ctx: None)
    return cur, state["exact"]


def running_counts(line: Line) -> list[dict]:
    """Cumulative counts after each of line.atoms, for "how far am I" checks.

    Inside a repeat the counts are for the first pass ("in": ["x3"]); on the
    repeat marker itself they include every pass.
    """
    cur, state, out = Counter(), {"exact": True}, []
    _walk(line.items, cur, state,
          lambda ctx: out.append({"counts": dict(+cur), "exact": state["exact"], "in": list(ctx)}))
    return out


# ---- serialisation / tokens -----------------------------------------------

def _rename(items, mapping):
    out = []
    for it in items:
        if isinstance(it, Op):
            out.append(Op(mapping.get(it.st, it.st), it.count,
                          mapping.get(it.as_, it.as_) if it.as_ else None, it.place))
        elif isinstance(it, Group):
            out.append(Group(_rename(it.items, mapping), it.place))
        else:
            out.append(Repeat(_rename(it.items, mapping), it.times, it.until))
    return out


def to_us(lines: list[Line], terms: str) -> list[Line]:
    """Normalise stitch names to US terms."""
    if terms.upper() != "UK":
        return lines
    return [Line(l.label, _rename(l.items, UK_TO_US), l.warnings) for l in lines]


def _show_count(op: Op) -> bool:
    # Chains always carry a count so "1ch" (a space) never reads as a bare stitch.
    return op.count != 1 or op.st == "ch"


def format_items(items) -> str:
    parts = []
    for it in items:
        if isinstance(it, Op):
            s = (str(it.count) if _show_count(it) else "") + it.st
            s += f"={it.as_}" if it.as_ else ""
            s += f"@{it.place}" if it.place else ""
        elif isinstance(it, Group):
            s = "{" + format_items(it.items) + "}" + (f"@{it.place}" if it.place else "")
        else:
            s = "[" + format_items(it.items) + "]" + (f"x{it.times}" if it.times else f">{it.until}")
        parts.append(s)
    return " ".join(parts)


def format_line(line: Line) -> str:
    return ("start" if line.label == "start" else f"R{line.label}") + ": " + format_items(line.items)


def tokens(items) -> list[str]:
    """Flat token list. Counts are split from stitch names to keep the vocab small:
    3ch=tr@ring -> ["3", "ch", "=tr", "@ring"]."""
    out = []
    for it in items:
        if isinstance(it, Op):
            if _show_count(it):
                out.append(str(it.count))
            out.append(it.st)
            if it.as_:
                out.append(f"={it.as_}")
            if it.place:
                out.append(f"@{it.place}")
        elif isinstance(it, Group):
            out += ["{", *tokens(it.items), "}"]
            if it.place:
                out.append(f"@{it.place}")
        else:
            out += ["[", *tokens(it.items), "]", f"x{it.times}" if it.times else f">{it.until}"]
    return out


def line_tokens(line: Line) -> list[str]:
    tag = "start" if line.label == "start" else "r"
    return [f"<{tag}>", *tokens(line.items), f"</{tag}>"]
