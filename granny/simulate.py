"""Round simulator: work out where every stitch goes and build the yarn graph.

Each round walks along the previous round's elements (stitches and chain spaces):
  - a stitch with no placement goes into the next stitch;
  - @sp (alias @corner) goes into the next chain space; @same into the last place used;
    @ring into the magic ring / starting chain ring;
  - sk / sksp skip stitches / spaces; a {...}@place group is worked into one place;
  - a chain that counts as a stitch (3ch=tr) rises from where the hook is;
  - join, sl@top, and any slip stitch that closes the round go into the top of the
    round's first stitch;
  - turn makes the next round walk the other way.
[...]>corner repeats until the next space it would use is a corner (the previous
round's longest chain space); [...]>end until it would pass the start of the round.

The result is a graph for a physics layout (as in CrochetPARADE, whose stitch lengths
we use): nodes are stitch tops, chains, slip stitches and ring points; edges join each
node to the previous one along the yarn, and each stitch to the node it's worked into.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from .chart import _index
from .dsl import UK_TO_US, Group, Line, Op

# Stitch lengths (bottom -> top), US terms, from CrochetPARADE's stitch dictionary.
HEIGHT = {"sl": 0.4, "sc": 1.0, "hdc": 1.5, "dc": 2.0, "tr": 2.5, "dtr": 3.0, "trtr": 3.5}
LINK = 1.0        # chain link, and the distance between neighbouring stitch tops
RING_LINK = 0.35  # spacing between stitches around a pulled-tight magic ring
MAX_REPEAT = 200


class _Wrap(Exception):
    """Walked past the start of the previous round."""


class _Round:
    def __init__(self, sim: "Simulator", line: Line, prev: list, direction: int):
        self.sim, self.line = sim, line
        self.prev, self.dir = prev, direction
        self.s = 0           # steps walked from the previous round's first element
        self.last = 0        # step of the last place worked into (for @same)
        self.elems = []      # this round's elements, in work order, for the next round
        self.first = None    # first stitch-like node of this round (join target)
        self.pending = []    # stitch / slip nodes whose target is resolved at the end
        self.chain_run = False
        self.watch = None    # landmark being watched during a >landmark trial
        self.hit = False
        self.ids = {}
        _index(line.items, [0], self.ids)
        self.closing = self._closing_op(line.items)
        self.corner_len = max((len(e[1]) for e in prev if e[0] == "sp"), default=0)

    # -- walking the previous round ------------------------------------------

    def _idx(self, s: int) -> int:
        return (self.dir * s) % len(self.prev)

    def _advance(self, kind: str):
        if not self.prev:
            raise self.sim.error(self.line, "nothing to work into: the previous round is empty")
        while True:
            self.s += 1
            if self.s >= len(self.prev):
                raise _Wrap()
            if self.prev[self._idx(self.s)][0] == kind:
                return

    def _resolve(self, place):
        if place == "ring":
            return ("ring",)
        if place == "same":
            return ("elem", self._idx(self.last))
        self._advance("sp" if place == "sp" else "st")
        self.last = self.s
        el = self.prev[self._idx(self.s)]
        if self.watch == "corner" and el[0] == "sp" and len(el[1]) == self.corner_len:
            self.hit = True
        return ("elem", self._idx(self.s))

    # -- building nodes -----------------------------------------------------

    def _node(self, k, st, atoms, target=None):
        node = self.sim.add_node(k, st, self.line.label, atoms)
        if target is not None:
            node["_target"] = target
            self.pending.append(node)
        return node

    @staticmethod
    def _closing_op(items):
        """The last op of the round that isn't turn / fasten off."""
        last = None
        for it in items:
            if isinstance(it, Op):
                if it.st not in ("turn", "fo"):
                    last = it
            else:
                last = _Round._closing_op(it.items) or last
        return last

    def walk(self, items, group_target=None, ctx=()):
        for it in items:
            if isinstance(it, Op):
                self.op(it, group_target, ctx)
            elif isinstance(it, Group):
                extra = (self.ids[(id(it), "place")],) if it.place else ()
                target = self._resolve(it.place) if it.place else group_target
                self.walk(it.items, target, ctx + extra)
            else:
                marker = self.ids[(id(it), "rep")]
                if it.times:
                    for _ in range(it.times):
                        self.walk(it.items, group_target, ctx + (marker,))
                else:
                    self.until(it, group_target, ctx + (marker,))

    def until(self, rep, group_target, ctx):
        """Run a >landmark repeat as many times as fits, by trial."""
        done = 0
        for _ in range(MAX_REPEAT):
            snap = self._snapshot()
            self.watch, self.hit = rep.until, False
            try:
                self.walk(rep.items, group_target, ctx)
                stop = self.hit
            except _Wrap:
                stop = True
            self.watch = None
            if stop:
                self._restore(snap)
                break
            done += 1
        self.sim.resolved[self.line.label].append(done)

    def _snapshot(self):
        return (self.s, self.last, len(self.elems), self.first, len(self.pending),
                len(self.sim.nodes), len(self.sim.edges), self.sim.last_node, self.chain_run,
                Counter(self.sim.counts[self.line.label]))

    def _restore(self, snap):
        (self.s, self.last, ne, self.first, np_, nn, nedge, self.sim.last_node, self.chain_run,
         counts) = snap
        del self.elems[ne:], self.pending[np_:], self.sim.nodes[nn:], self.sim.edges[nedge:]
        self.sim.counts[self.line.label] = counts

    def op(self, it: Op, group_target, ctx):
        atoms = [self.ids[id(it)], *ctx] + ([self.ids[(id(it), "place")]] if it.place else [])
        counts = self.sim.counts[self.line.label]
        st = it.st
        if st in ("turn", "fo", "mr"):
            return
        if st in ("sk", "sksp"):
            for _ in range(it.count):
                self._advance("sp" if st == "sksp" else "st")
            return

        if st == "ch":
            nodes = [self._node("ch", "ch", atoms) for _ in range(it.count)]
            if it.as_:
                # Beginning chain counting as a stitch: worked from where the hook is.
                self.last = self.s
                self.elems.append(("st", nodes[-1]["id"]))
                self.first = self.first or nodes[-1]
                nodes[-1]["as"] = it.as_
                counts[it.as_] += 1
                counts["st"] += 1
                self.chain_run = False
            elif self.chain_run:
                self.elems[-1][1].extend(n["id"] for n in nodes)
            else:
                self.elems.append(("sp", [n["id"] for n in nodes]))
                self.chain_run = True
            return

        self.chain_run = False
        if st in ("sl", "join"):
            closing = st == "join" or it is self.closing or it.place == "top"
            if closing:
                target = ("first",)
            else:
                target = group_target if group_target and not it.place else self._resolve(it.place)
            for _ in range(it.count):
                self._node("sl", "sl", atoms, target)
            return

        # A real stitch. "3tr@sp" = all three into one place; "3tr" or "3tr@top" = one per stitch.
        per_stitch = it.place in (None, "st", "next", "top", "side")
        target = None
        if group_target and not it.place:
            target = group_target
        elif not per_stitch:
            target = self._resolve(it.place)
        for _ in range(it.count):
            t = target or self._resolve(None)
            node = self._node("st", st, atoms, t)
            self.elems.append(("st", node["id"]))
            self.first = self.first or node
            counts[st] += 1
            counts["st"] += 1

    # -- end of round -------------------------------------------------------

    def finish(self):
        """Attach every pending stitch to an actual node of the previous round."""
        by_target = defaultdict(list)
        for node in self.pending:
            by_target[node.pop("_target")].append(node)
        for target, nodes in by_target.items():
            if target == ("first",):
                base = [self.first["id"]] if self.first else []
            elif target == ("ring",):
                base = self.sim.ring_nodes(len(nodes))
            else:
                kind, ref = self.prev[target[1]]
                base = [ref] if kind == "st" else list(ref if self.dir > 0 else reversed(ref))
            for j, node in enumerate(nodes):
                if not base:
                    continue
                # Several stitches into one chain space spread along its chains.
                b = base[min(len(base) - 1, int((j + 0.5) * len(base) / len(nodes)))]
                node["base"] = b
                self.sim.edges.append([node["id"], b, HEIGHT.get(self.sim.us(node["st"]), 2.0)])
        for kind, ref in self.elems:
            if kind == "sp":
                self.sim.counts[self.line.label][f"{len(ref)}ch-sp"] += 1


class Simulator:
    def __init__(self, terms: str = "US"):
        self.rename = UK_TO_US if terms.upper() == "UK" else {}
        self.nodes: list[dict] = []
        self.edges: list[list] = []
        self.last_node = None
        self.ring = None           # list of node ids, or "mr" until round 1 creates them
        self.errors: list[str] = []
        self.counts = defaultdict(Counter)
        self.resolved = defaultdict(list)  # round label -> iterations of each >landmark repeat
        self.round_index = 0

    def us(self, st: str) -> str:
        return "sl" if st == "sl" else self.rename.get(st, st)

    def error(self, line, msg):
        self.errors.append(f"R{line.label}: {msg}")
        return _Wrap()

    def add_node(self, k, st, label, atoms):
        node = {"id": len(self.nodes), "k": k, "st": st, "sym": self.us(st), "r": label,
                "ri": self.round_index, "a": atoms, "base": None, "prev": self.last_node}
        self.nodes.append(node)
        if self.last_node is not None:
            self.edges.append([self.last_node, node["id"], LINK])
        self.last_node = node["id"]
        return node

    def ring_nodes(self, n: int) -> list[int]:
        if self.ring == "mr":
            first = len(self.nodes)
            k = max(n, 4)
            for j in range(k):
                self.nodes.append({"id": first + j, "k": "ring", "st": "mr", "sym": "mr", "r": "start",
                                   "ri": 0, "a": self.mr_atoms, "base": None, "prev": None})
                self.edges.append([first + j, first + (j + 1) % k, RING_LINK])
            self.ring = list(range(first, first + k))
            # The yarn comes out of the ring into the first stitch of round 1.
            if self.first_node is not None:
                self.edges.append([self.ring[0], self.first_node, 0.5])
        return self.ring or []

    def run(self, lines: list[Line]) -> dict:
        prev, direction = [], 1
        self.first_node = None
        for line in lines:
            if line.label == "start":
                self.start(line)
                continue
            self.round_index += 1
            rnd = _Round(self, line, prev, direction)
            try:
                rnd.walk(line.items)
            except _Wrap:
                self.errors.append(f"R{line.label}: ran past the end of the previous round"
                                   " (too many stitches/skips, or a missing space)")
            if self.first_node is None and rnd.first is not None:
                self.first_node = min(n["id"] for n in self.nodes if n["r"] == line.label)
            rnd.finish()
            turned = any(isinstance(it, Op) and it.st == "turn" for it in line.items)
            prev, direction = rnd.elems, (-1 if turned else 1)
        return {
            "nodes": self.nodes, "edges": self.edges, "init": self.initial_positions(),
            "errors": self.errors, "counts": {k: dict(v) for k, v in self.counts.items()},
            "resolved": dict(self.resolved),
        }

    def start(self, line: Line):
        ids = {}
        _index(line.items, [0], ids)
        chains = []
        for it in line.items:
            if not isinstance(it, Op):
                continue
            if it.st == "mr":
                self.ring, self.mr_atoms = "mr", [ids[id(it)]]
            elif it.st == "ch":
                for _ in range(it.count):
                    chains.append(self.add_node("ch", "ch", "start", [ids[id(it)]])["id"])
            elif it.st in ("join", "sl") and chains:
                self.edges.append([chains[-1], chains[0], LINK])  # close the chain ring
        if chains:
            self.ring = chains
            self.first_node = chains[0]

    # -- starting positions for the physics -----------------------------------

    def initial_positions(self) -> list[float]:
        """Polar start: round k on a circle of radius ~k stitch heights, each stitch at the
        angle of what it's worked into. Gives the physics a sensible, unflipped start."""
        n = len(self.nodes)
        ang, rad = [None] * n, [0.0] * n
        ring = [i for i, nd in enumerate(self.nodes) if nd["k"] == "ring"] or \
               [i for i, nd in enumerate(self.nodes) if nd["r"] == "start"]
        r0 = max(0.5, len(ring) * RING_LINK / (2 * math.pi))
        for j, i in enumerate(ring):
            ang[i], rad[i] = 2 * math.pi * j / len(ring), r0
        round_r = {0: r0}
        for nd in self.nodes:
            ri = nd["ri"]
            if ri and ri not in round_r:
                hs = [HEIGHT.get(m["sym"], 2.0) for m in self.nodes if m["ri"] == ri and m["k"] == "st"]
                round_r[ri] = round_r[max(k for k in round_r if k < ri)] + (max(hs) if hs else 1.0)

        # Stitches and slips: angle of their base, spread a little within a shared base.
        seen = Counter()
        for nd in self.nodes:
            i, b = nd["id"], nd["base"]
            if nd["k"] in ("st", "sl") and b is not None and ang[b] is not None:
                seen[b] += 1
                ang[i] = ang[b] + 0.04 * (seen[b] - 1)
                rad[i] = round_r[nd["ri"]] if nd["k"] == "st" else rad[b] + 0.2
        # Everything else (chains): interpolate along the yarn between known neighbours.
        known = [i for i in range(n) if ang[i] is not None]
        for i in range(n):
            if ang[i] is not None:
                continue
            before = max((k for k in known if k < i), default=None)
            after = min((k for k in known if k > i), default=None)
            if before is None and after is None:
                ang[i], rad[i] = 0.0, round_r.get(self.nodes[i]["ri"], 1.0)
                continue
            if before is None or after is None:
                k = before if after is None else after
                ang[i] = ang[k] + 0.15 * (i - k)
            else:
                d = (ang[after] - ang[before] + math.pi) % (2 * math.pi) - math.pi
                ang[i] = ang[before] + d * (i - before) / (after - before)
            rad[i] = round_r.get(self.nodes[i]["ri"], 1.0)
        out = []
        for i in range(n):
            out += [round(rad[i] * math.cos(ang[i]), 4), round(rad[i] * math.sin(ang[i]), 4)]
        return out


def simulate(lines: list[Line], terms: str = "US") -> dict:
    return Simulator(terms).run(lines)
