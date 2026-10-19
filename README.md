# Granny squares dataset

Crochet granny-square patterns, each stored three ways:

- **images** (finished square, progress shots tagged with a round, charts)
- **human**: the pattern text as published
- **machine**: the same pattern in a small DSL that keeps stitch placement and repeat structure, and splits cleanly into tokens

## Use

```sh
python3 server.py          # editor at http://localhost:8765 (stdlib only, no installs)
python3 -m unittest        # every pattern must parse with no count mismatches
python3 export.py          # -> exports/dataset.jsonl   (--strict skips failing patterns, --done-only skips WIP)
```

The editor autosaves. Each pattern has a status next to its title (WIP, finished, rejected), also shown in the sidebar; rejected patterns are never exported.

The editor lines up each `Round N:` in the human text with `RN:` in the DSL.
It also compares the stitch counts it computes against the counts stated in the pattern, e.g. `(24 tr, 4 3-ch sps.)`.

Round status:
- `ok`: the counts match.
- `mismatch`: there's a transcription error somewhere.
- `unverified`: the round uses `>corner`-style repeats, whose length depends on the previous round.
- `no-counts`: the human text states no counts.
- `missing-*`: a round exists on only one side.

## Hosting and API

`python3 build_static.py` builds a static, read-only copy of the editor and a JSON API into `public/`.
Vercel runs it on every push (see `vercel.json`). Rejected patterns are left out; every record has a `status`,
so you can filter for `"done"` yourself. All of these allow cross-origin requests:

| URL | |
|---|---|
| `/api/index.json` | summary of every pattern, with links to each |
| `/api/patterns/<id>.json` | one pattern (same record as `export.py`) |
| `/api/dataset.json` | all records as a JSON array |
| `/api/dataset.jsonl` | all records, one per line |
| `/images/<id>/<file>` | images (each record's `images[].url`) |

```js
const { patterns } = await (await fetch("https://<your-site>.vercel.app/api/index.json")).json();
```

## Linking human ↔ machine

The editor shows three panes:
- **Original:** the pattern as published.
- **Machine:** the DSL.
- **Uniform:** human-style text generated from the DSL, one phrase per DSL piece, so its links are exact.

**Link mode** steps through every DSL piece. For each one, adjust the orange highlight in the original:
- <kbd>←</kbd>/<kbd>→</kbd> move its end; add <kbd>⇧</kbd> to move its start, or <kbd>⌥</kbd> to move one letter at a time.
- Or drag-select the text directly.
- <kbd>Enter</kbd> confirms, <kbd>⌫</kbd> marks "no counterpart in the original", <kbd>↑</kbd>/<kbd>↓</kbd> move between pieces, and <kbd>Esc</kbd> exits.

The starting highlight is a guess from `granny/align.py`; only what you confirm is saved, to `links.json`.
A link turns amber ("to review") when its DSL line changes after you confirmed it.

## Layout

```
data/patterns/0001/
  meta.json      title, status (wip|done|rejected), terms (UK|US), source, author, license, tags, images[{file, kind, round, caption}],
                 colors {"C1": "#hex"} (set from the chart's swatches), abbreviations [{abbr, name, dsl}]
  human.txt
  pattern.dsl
  links.json     confirmed DSL piece -> original text span, per round
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
| `C2@3tr`, `C2@{…}@corner`, `C2@[…]x3` | yarn colour C2 for one stitch, group or repeat |
| `C2@{…}` | colour block: everything inside in C2 (no `@place`, so not worked into one place) |
| `vs`, `vs@sp` | a pattern abbreviation, defined per pattern (e.g. `vs` = `tr 1ch tr`); `@place` puts all its stitches into that place |
| `[…]x3` | repeat 3 times total ("repeat from * twice more" = `x3`) |
| `[…]>corner`, `[…]>end` | repeat until a landmark |
| `sl` (`ss`), `join`, `turn`, `fo` | slip stitch, join round, turn, fasten off |
| `# …` | comment |

Abbreviations live in meta.json (edited in the editor):
`"abbreviations": [{"abbr": "vs", "name": "v-stitch", "dsl": "tr 1ch tr"}]`.
`vs` stays one token in the DSL and export (the export lists the definitions), while counts
and the chart expand it. The uniform text defines each one up front ("V-stitch is a set of
1 tr, 1 ch, 1 tr.") and then uses its full name ("2 v-stitches in next sp"). Stated counts like "(8 v-sts)" are checked against the `vs` tally.

Example (UK terms):

```
start: mr
R1: 3ch=tr {2tr 3ch [3tr 3ch]x3}@ring join turn
R2: sl@sp 3ch=tr {2tr 3ch 3tr}@same 1ch [{3tr 3ch 3tr}@corner 1ch]x3 join turn
```

Tokens split counts from stitch names to keep the vocabulary small:
`<r> 3 ch =dc { 2 dc 3 ch [ 3 dc 3 ch ] x3 } @ring join turn </r>`
