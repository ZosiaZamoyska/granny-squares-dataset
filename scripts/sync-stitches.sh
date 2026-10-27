#!/bin/sh
# Copy the stitch tokenizer, stitch graph and chart from granny-squares-llm, which owns them, so
# the editor's stitch-graph panel reads patterns exactly as the LLM app does.
#   scripts/sync-stitches.sh [path/to/granny-squares-llm]      (default: ../granny-squares-llm)
set -e
cd "$(dirname "$0")/.."
src="${1:-../granny-squares-llm}/js"
for f in dsl.js graph.js chart.js; do cp "$src/$f" "web/stitches/$f"; done
echo "copied dsl.js graph.js chart.js from $src"
