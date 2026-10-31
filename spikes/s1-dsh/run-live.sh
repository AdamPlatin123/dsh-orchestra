#!/usr/bin/env bash
# run-live.sh — S1-DSH: ONE real `dsh --profile headless --json` run in a fully isolated DSH_HOME
# (scratch dir; ~/.dsh is never touched), while live-tail.mjs (node24, read-only) follows the new
# session log. Costs one short model call on DSH's default model (deepseek-flash).
#   bash run-live.sh <scratchTmpDir> <evidenceDir>
set -u
TMP="$1"; EV="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE24="G:/_Projects/DSH-plugins/.tools/node24/node.exe"     # reader (read-only)
DSHNODE="C:/Users/Calx/AppData/Roaming/npm/node.exe"          # the Node the dsh shim uses (24.11)
DSHBIN="C:/Users/Calx/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js"
W="$(cygpath -w "$TMP")"
mkdir -p "$TMP/dsh-home" "$TMP/agents-home" "$TMP/user-home" "$TMP/os-tmp" "$TMP/cwd"
"$NODE24" "$HERE/live-tail.mjs" "$TMP/dsh-home" 560 15 > "$EV/live-tail.json" 2> "$TMP/live-tail-err.txt" &
TAILPID=$!
cd "$TMP/cwd"
echo "{\"dshStart\":$(date +%s%3N)}" > "$EV/live-run-times.json"
DSH_HOME="$W\\dsh-home" DSH_AGENTS_HOME="$W\\agents-home" USERPROFILE="$W\\user-home" HOME="$W\\user-home" \
TEMP="$W\\os-tmp" TMP="$W\\os-tmp" DSH_TELEMETRY_DISABLED=1 \
  timeout 540 "$DSHNODE" "$DSHBIN" --profile headless --json "Reply with one word: ok" 2> "$TMP/dsh-stderr.txt" \
  | node "$HERE/stream-ts.mjs" > "$EV/live-stream-ts.jsonl"
RC=${PIPESTATUS[0]}
echo "{\"dshEnd\":$(date +%s%3N),\"dshExit\":$RC,\"stderrBytes\":$(wc -c < "$TMP/dsh-stderr.txt")}" >> "$EV/live-run-times.json"
wait $TAILPID
echo "tail exit=$?"
