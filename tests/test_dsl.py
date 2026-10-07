"""Run: python3 -m unittest"""

import unittest
from pathlib import Path

from granny import dsl
from granny.check import check, split_rounds, stated_counts

DATA = Path(__file__).resolve().parent.parent / "data" / "patterns"


class ParseTest(unittest.TestCase):
    def test_round_trip(self):
        src = "R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@sp 1ch]x3 2sksp join turn"
        self.assertEqual(dsl.format_line(dsl.parse_line(src)), src)
        # @corner is just another name for a space
        self.assertEqual(dsl.parse_line("R1: 3tr@corner").items[0].place, "sp")

    def test_aliases_and_commas(self):
        line = dsl.parse_line("R1: ss@sp, 3ch, skip")
        self.assertEqual([o.st for o in line.items], ["sl", "ch", "sk"])

    def test_tokens(self):
        line = dsl.parse_line("R1: 3ch=tr {2tr [3tr 3ch]x3}@ring join")
        self.assertEqual(dsl.line_tokens(line), [
            "<r>", "3", "ch", "=tr", "{", "2", "tr", "[", "3", "tr", "3", "ch", "]", "x3", "}",
            "@ring", "join", "</r>"])

    def test_errors(self):
        for bad in ["R1: [3tr", "R1: 3tr}", "R1: [3tr]", "3tr 2ch", "R1: @sp"]:
            with self.assertRaises(dsl.DSLError, msg=bad):
                dsl.parse_line(bad)

    def test_warnings(self):
        line = dsl.parse_line("R1: 3zz {2tr} 3tr@nowhere")
        self.assertEqual(len(line.warnings), 3)

    def test_uk_to_us(self):
        lines = dsl.to_us(dsl.parse("R1: 3ch=tr 2tr 1dc 1htr"), "UK")
        self.assertEqual(dsl.format_line(lines[0]), "R1: 3ch=dc 2dc sc hdc")

    def test_count(self):
        c, exact = dsl.count(dsl.parse_line("R1: 3ch=tr {2tr 3ch [3tr 3ch]x3}@ring join").items)
        self.assertTrue(exact)
        self.assertEqual((c["tr"], c["3ch-sp"], c["st"]), (12, 4, 12))
        _, exact = dsl.count(dsl.parse_line("R1: [3tr 1ch]>corner").items)
        self.assertFalse(exact)


class HumanTest(unittest.TestCase):
    def test_split(self):
        pre, rounds = split_rounds("Make a ring\nRound 1: foo\nRnd 2. bar\nRounds 3-5: baz")
        self.assertEqual(pre, "Make a ring")
        self.assertEqual(rounds, {"1": "foo", "2": "bar", "3-5": "baz"})

    def test_stated(self):
        self.assertEqual(stated_counts("… Turn. (24 tr, 4 3-ch sps, 4 1-ch sps.)"),
                         {"tr": 24, "3ch-sp": 4, "1ch-sp": 4})
        self.assertEqual(stated_counts("… (16 sts and 4 ch-2 spaces)"), {"st": 16, "2ch-sp": 4})
        self.assertEqual(stated_counts("no counts here"), {})


class LinkTest(unittest.TestCase):
    def test_links_round(self):
        from granny.check import links
        human = "Round 1: ss into next ch sp, 3 ch (counts as tr), [2 tr, 3 ch, 3 tr] in same sp, " \
                "*[3 tr, 3 ch, 3 tr] in next 3-ch sp, repeat from * twice more, join. (24 tr)"
        code = "R1: sl@sp 3ch=tr {2tr 3ch 3tr}@same [{3tr 3ch 3tr}@corner]x3 join"
        L = links(human, code)
        pairs = {code[d["s"]:d["e"]]: [human[L["human"][j]["s"]:L["human"][j]["e"]] for j in d["link"]]
                 for d in L["dsl"]}
        self.assertEqual(pairs["@same"], ["in same sp"])
        self.assertEqual(pairs["x3"], ["repeat from * twice more"])
        self.assertEqual(pairs["3ch=tr"], ["3 ch"])  # "(counts as tr)" and "(24 tr)" are ignored
        self.assertTrue(all(d["link"] for d in L["dsl"]))

    def test_human_atoms_skip_spaces(self):
        from granny.align import human_atoms
        names = [(k, key, n) for k, key, n, *_ in human_atoms("3 tr in 3-ch sp, ch 2, skip 3 sts, 1 ch-sp")]
        self.assertEqual(names, [("op", "tr", 3), ("place", "in 3-ch sp", 1), ("op", "ch", 2), ("op", "sk", 3)])


    def test_varied_wording(self):
        """Phrasings from real patterns (UK blog style, glued numbers, US-style groups)."""
        from granny.align import human_atoms
        text = ("ch5 (counts as tr plus 2 for corner). *Work 3 tr into centre of circle, ch2.* "
                "In corner space, make a corner (2tr, ch2, 2tr), [3 dc] x2, slip stitch into 3rd ch. (12 tr)")
        got = [(k, key if k == "op" else text[s:e], n) for k, key, n, s, e in human_atoms(text)]
        self.assertEqual(got, [
            ("op", "ch", 5), ("op", "tr", 3), ("place", "into centre of circle", 1), ("op", "ch", 2),
            ("place", "In corner space", 1), ("op", "tr", 2), ("op", "ch", 2), ("op", "tr", 2),
            ("op", "dc", 3), ("rep", "] x2", 1), ("op", "sl", 1), ("place", "into 3rd ch", 1)])

    def test_split_op_and_join_links(self):
        from granny.check import links
        human = "Round 1: ch5 (counts as tr plus 2 for corner), 3 tr into ring, slip stitch into 3rd ch."
        code = "R1: 3ch=tr 2ch 3tr@ring join"
        L = links(human, code)
        pairs = {code[d["s"]:d["e"]]: [human[L["human"][j]["s"]:L["human"][j]["e"]] for j in d["link"]]
                 for d in L["dsl"]}
        self.assertEqual(pairs["3ch=tr"], ["ch5"])
        self.assertEqual(pairs["2ch"], ["ch5"])
        self.assertEqual(pairs["join"], ["slip stitch"])


class DatasetTest(unittest.TestCase):
    """Every pattern in data/ must parse and must not have count mismatches."""

    def test_all_patterns(self):
        from granny import store
        for pid in store.list_ids():
            p = store.load(pid)
            r = check(p["human"], p["dsl"], p["meta"]["terms"])
            with self.subTest(pid=pid):
                self.assertEqual(r["errors"], [])
                bad = [x["label"] for x in r["rounds"] if x["status"] == "mismatch"]
                self.assertEqual(bad, [], f"count mismatch in rounds {bad}")


if __name__ == "__main__":
    unittest.main()
