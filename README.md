# Granny squares dataset

Crochet granny-square patterns, each stored three ways:

- **images** (finished square, progress shots tagged with a round, charts)
- **human**: the pattern text as published
- **machine**: the same pattern in a small DSL that keeps stitch placement and repeat structure, and splits cleanly into tokens

## Use

```sh
python3 server.py          # editor at http://localhost:8765 (stdlib only, no installs)
python3 -m unittest        # every pattern must parse with no count mismatches
python3 export.py          # -> exports/dataset.jsonl   (--strict skips failing patterns)
```

The editor autosaves. It lines up each `Round N:` in the human text with `RN:` in the DSL.
It also compares the stitch counts it computes against the counts stated in the pattern, e.g. `(24 tr, 4 3-ch sps.)`.

Round status:
- `ok`: the counts match.
- `mismatch`: there's a transcription error somewhere.
- `unverified`: the round uses `>corner`-style repeats, whose length depends on the previous round.
- `no-counts`: the human text states no counts.
- `missing-*`: a round exists on only one side.

## Layout

```
data/patterns/0001/
  meta.json      title, terms (UK|US), source, author, license, tags, images[{file, kind, round, caption}]
  human.txt
  pattern.dsl
  images/
```

## DSL

One round per line. Write stitches in the pattern's own terms and set `terms` in meta.
The export converts everything to US names, so UK and US patterns share one vocabulary.

| Syntax | Meaning |
|---|---|
| `start: mr` | setup (magic ring, `4ch join`, …) |
| `R3: …` | round 3 (`R6-8:` for a range) |
| `3tr`, `sc`, `2ch` | count + stitch (count defaults to 1) |
| `3ch=tr` | chain that counts as a stitch |
| `3sk` | skip 3 stitches |
| `3tr@sp` | placement: `@ring @sp @corner @same @st @top @side` |
| `{3tr 3ch 3tr}@corner` | group worked into one place |
| `[…]x3` | repeat 3 times total ("repeat from * twice more" = `x3`) |
| `[…]>corner`, `[…]>end` | repeat until a landmark |
| `sl` (`ss`), `join`, `turn`, `fo` | slip stitch, join round, turn, fasten off |
| `# …` | comment |

Example (UK terms):

```
start: mr
R1: 3ch=tr {2tr 3ch [3tr 3ch]x3}@ring join turn
R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@corner 1ch]x3 join turn
```

Tokens split counts from stitch names to keep the vocabulary small:
`<r> 3 ch =dc { 2 dc 3 ch [ 3 dc 3 ch ] x3 } @ring join turn </r>`
