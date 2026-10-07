"""Render DSL back into uniform, human-style pattern text.

Every DSL atom (stitch, placement, repeat marker) becomes exactly one phrase, and the
phrase spans are returned in Line.atoms order, so the link DSL <-> uniform text is exact.

    R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@corner 1ch]x3 join turn
 -> Round 2: sl st in next sp, 3 ch (counts as tr), (2 tr, 3 ch, 3 tr) in same sp, 1 ch,
    [(3 tr, 3 ch, 3 tr) in corner sp, 1 ch] 3 times, join with sl st, turn.

Conventions: (...) = worked into one place, [...] = repeated.
"""

from __future__ import annotations

from .dsl import Group, Line, Op

PLACE_TEXT = {
    "ring": "into ring", "sp": "in next sp", "same": "in same sp", "corner": "in corner sp",
    "st": "in next st", "next": "in next st", "top": "in top of beginning ch", "side": "along side",
}
UNTIL_TEXT = {"corner": "to corner", "end": "to end"}


def _op_text(op: Op) -> str:
    n = op.count
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


def render_line(line: Line) -> tuple[str, list[tuple[int, int]]]:
    """Return (text, spans) with one (start, end) span per entry of line.atoms."""
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
                atom(_op_text(it))
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


def render(lines: list[Line]) -> str:
    return "\n".join(render_line(l)[0] for l in lines)
