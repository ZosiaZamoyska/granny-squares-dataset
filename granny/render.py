"""Render DSL back into uniform, human-style pattern text.

Every DSL atom (stitch, placement, repeat marker) becomes exactly one phrase, and the
phrase spans are returned in Line.atoms order, so the link DSL <-> uniform text is exact.

    R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@corner 1ch]x3 join turn
 -> Round 2: sl st in next sp, 3 ch (counts as tr), (2 tr, 3 ch, 3 tr) in same sp, 1 ch,
    [(3 tr, 3 ch, 3 tr) in corner sp, 1 ch] 3 times, join with sl st, turn.

Conventions: (...) = worked into one place, [...] = repeated, {...} = worked in one colour.

A pattern's own abbreviations (vs = tr 1ch tr) are defined once up front ("V-stitch is a
set of 1 tr, 1 ch, 1 tr.") and then used by their full name ("1 v-stitch in same sp").
"""

from __future__ import annotations

from .dsl import Abbrev, Color, Group, Line, Op

PLACE_TEXT = {
    "ring": "into ring", "sp": "in next sp", "same": "in same sp", "corner": "in corner sp",
    "st": "in next st", "next": "in next st", "top": "in top of beginning ch", "side": "along side",
}
UNTIL_TEXT = {"corner": "to corner", "end": "to end"}


def _plural(name: str, n: int) -> str:
    if n == 1:
        return name
    return name + ("es" if name.endswith(("ch", "sh", "s", "x")) else "s")


def _op_text(op: Op, abbrevs: dict[str, Abbrev]) -> str:
    n = op.count
    if op.expand and op.st in abbrevs:
        return f"{n} {_plural(abbrevs[op.st].name, n)}"
    if op.st == "ch":
        return f"{n} ch" + (f" (counts as {op.as_})" if op.as_ else "")
    if op.st == "sl":
        return "sl st" if n == 1 else f"{n} sl st"
    if op.st == "sk":
        return f"skip {n} st" + ("s" if n > 1 else "")
    if op.st == "join":
        return "join with sl st"
    if op.st == "turn":
        return "turn"
    if op.st == "fo":
        return "fasten off"
    if op.st == "mr":
        return "make a magic ring"
    return f"{n} {op.st}"


def render_line(line: Line, abbrevs: dict[str, Abbrev] | None = None) -> tuple[str, list[tuple[int, int]]]:
    """Return (text, spans) with one (start, end) span per entry of line.atoms.
    abbrevs: from dsl.parse_abbreviations, for their full names."""
    abbrevs = abbrevs or {}
    parts: list[str] = []
    spans: list[tuple[int, int]] = []
    pos = 0

    def emit(s: str):
        nonlocal pos
        parts.append(s)
        pos += len(s)

    def atom(s: str):
        start = pos
        emit(s)
        spans.append((start, pos))

    def items(its):
        for k, it in enumerate(its):
            if k:
                emit(", ")
            if isinstance(it, Op):
                atom(_op_text(it, abbrevs))
                if it.place:
                    emit(" ")
                    atom(PLACE_TEXT.get(it.place, f"in {it.place}"))
            elif isinstance(it, Group):
                emit("(")
                items(it.items)
                emit(")")
                if it.place:
                    emit(" ")
                    atom(PLACE_TEXT.get(it.place, f"in {it.place}"))
            elif isinstance(it, Color):
                atom(f"with {it.color}")
                if len(it.items) == 1:
                    emit(": ")
                    items(it.items)
                else:
                    emit(" {")
                    items(it.items)
                    emit("}")
            else:
                emit("[")
                items(it.items)
                emit("] ")
                if it.times:
                    atom("once" if it.times == 1 else f"{it.times} times")
                else:
                    atom(UNTIL_TEXT.get(it.until, f"to {it.until}"))

    emit("Start: " if line.label == "start" else f"Round {line.label}: ")
    items(line.items)
    emit(".")
    text = "".join(parts)
    if text.startswith("Start: make"):  # "Start: make a magic ring." reads oddly lower-case
        text = "Start: Make" + text[len("Start: make"):]
    return text, spans


def definitions(abbrevs: dict[str, Abbrev] | None) -> list[str]:
    """One sentence per abbreviation: "V-stitch is a set of 1 tr, 1 ch, 1 tr." """
    out = []
    for a in (abbrevs or {}).values():
        body = render_line(Line("", a.items))[0].removeprefix("Round : ").removesuffix(".")
        out.append(f"{a.name[:1].upper()}{a.name[1:]} is a set of {body}.")
    return out


def render(lines: list[Line], abbrevs: dict[str, Abbrev] | None = None) -> str:
    return "\n".join(definitions(abbrevs) + [render_line(l, abbrevs)[0] for l in lines])
