// fsync-bench.mjs — S1-DSH: cost of DSH's per-batch append (open 'a' -> stat -> writeFile -> sync -> close)
// on a given directory. Writes only <dir>/fsync-bench.bin. Needs a Node that may write there.
//   node fsync-bench.mjs <dir> [iterations=60] [bytes=600]
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const [dir, itArg, bytesArg] = process.argv.slice(2);
const it = Number(itArg ?? 60), bytes = Number(bytesArg ?? 600);
const p = join(dir, 'fsync-bench.bin');
const writeMs = [], syncMs = [], totalMs = [];
for (let i = 0; i < it; i++) {
  const buf = randomBytes(bytes);
  const t0 = performance.now();
  const h = await open(p, 'a');
  await h.stat(); await h.writeFile(buf);
  const t1 = performance.now();
  await h.sync();
  const t2 = performance.now();
  await h.close();
  writeMs.push(t1 - t0); syncMs.push(t2 - t1); totalMs.push(performance.now() - t0);
  await new Promise((r) => setTimeout(r, 50));
}
await rm(p, { force: true });
const d = (a) => { a.sort((x, y) => x - y); const q = (pp) => +a[Math.min(a.length - 1, Math.ceil(pp / 100 * a.length) - 1)].toFixed(1); return { n: a.length, min: q(0.0001), p50: q(50), p90: q(90), p99: q(99), max: +a.at(-1).toFixed(1) }; };
console.log(JSON.stringify({ node: process.version, pid: process.pid, bytes, openStatWrite_ms: d(writeMs), fsync_ms: d(syncMs), total_ms: d(totalMs) }));
