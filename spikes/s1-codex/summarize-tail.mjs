// Summarize a stream-tail.mjs output file: growth events, decoded lines, latencies.
//   writeToReadMs = read time - record `timestamp` (stamped when Codex writes the line; older outputs call it lagMs)
//   eventToReadMs = read time - the payload's own event time, for records that carry one (see stream-tail.mjs)
// Usage: node24 summarize-tail.mjs <tail.out>   (prints JSON; contains only counts, ms and type values)
import fs from 'node:fs';

const ev = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lines = ev.filter((e) => e.ev === 'line');
const stats = (arr) => { const a = arr.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
  const q = (x) => (a.length ? a[Math.floor((a.length - 1) * x)] : null);
  return { n: a.length, min: q(0), median: q(0.5), p90: q(0.9), max: q(1) }; };
const count = (a) => a.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
console.log(JSON.stringify({
  files: [...new Set(ev.filter((e) => e.name).map((e) => e.name))],
  appeared: ev.filter((e) => e.ev === 'appeared').map((e) => ({ name: e.name, dt: e.dt, size: e.size })),
  opens: ev.filter((e) => e.ev === 'open').map((e) => ({ name: e.name, zst: e.zst, size: e.size, dt: e.dt })),
  grows: ev.filter((e) => e.ev === 'grow').length,
  growSizes: ev.filter((e) => e.ev === 'grow').map((e) => e.to - e.from),
  lines: lines.length,
  writeToReadMs: stats(lines.map((e) => e.writeToReadMs ?? e.lagMs)),
  eventToReadMs: stats(lines.map((e) => e.eventToReadMs)),
  eventToReadByKey: lines.filter((e) => e.eventKey).map((e) => ({ n: e.n, type: e.type, ptype: e.ptype, key: e.eventKey, ms: e.eventToReadMs })),
  types: count(lines.map((e) => `${e.type}/${e.ptype}`)),
  lastFrame: ev.filter((e) => e.ev === 'frame').at(-1) ?? null,
  replaced: ev.filter((e) => e.ev === 'replaced').length, vanished: ev.filter((e) => e.ev === 'vanished').map((e) => e.name),
  decodeErrors: ev.filter((e) => e.ev === 'decode-error').length,
  end: ev.filter((e) => e.ev === 'end'), exit: ev.find((e) => e.ev === 'exit') ?? null,
}, null, 1));
