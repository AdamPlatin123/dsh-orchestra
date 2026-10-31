// stream-ts.mjs — S1-DSH: timestamp each line of `dsh --profile headless --json` stdout on arrival.
// Keeps only the arrival time, the event `type` and its top-level key names — never text, args or results.
//   dsh ... --json | node stream-ts.mjs > stream-ts.jsonl
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = Date.now();
  let type = '<unparsable>', keys = [];
  try { const v = JSON.parse(line); type = v.type ?? '<no-type>'; keys = Object.keys(v); } catch {}
  process.stdout.write(JSON.stringify({ t, type, keys, bytes: Buffer.byteLength(line) }) + '\n');
});
