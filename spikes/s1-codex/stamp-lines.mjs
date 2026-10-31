// Independent clock for the next controlled `codex exec --json` run (review S1-CODEX-01): stamps each stdout line
// with its arrival time and keeps only the event kind, so it can be compared with the moment the matching rollout
// line becomes readable (stream-tail.mjs). Never prints message text.
// Usage: codex exec --json ... < /dev/null | node24 stamp-lines.mjs > stdout-timed.jsonl
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (l) => {
  const t = Date.now();
  let type = null, item = null;
  try { const o = JSON.parse(l); type = o.type ?? null; item = o.item?.type ?? o.item?.item_type ?? null; } catch { type = '<unparsable>'; }
  process.stdout.write(JSON.stringify({ t, iso: new Date(t).toISOString(), bytes: Buffer.byteLength(l), type, item }) + '\n');
});
