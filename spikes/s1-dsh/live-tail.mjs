// live-tail.mjs — S1-DSH: follow the first new DSH session log that appears under <dshHome>/sessions and
// measure "event.time (DSH Date.now() at commit) -> frame complete and decoded here" per event.
// Read-only (node24). Prints counts, sizes, `type` values and timings only — never event bodies.
//   node live-tail.mjs <dshHome> [maxSeconds=180] [idleExitSeconds=8]
import { readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { FrameTail } from './frame-tail.mjs';

const [home, maxArg, idleArg] = process.argv.slice(2);
const maxMs = Number(maxArg ?? 180) * 1000, idleMs = Number(idleArg ?? 8) * 1000;
const root = join(home, 'sessions');
const t0 = Date.now();
const find = () => {
  const hits = [];
  const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile()) hits.push(p); } };
  walk(root, 0);
  return hits;
};
const tmpSeen = new Set();
let logPath = null, foundAt = null;
while (!logPath && Date.now() - t0 < maxMs) {
  for (const p of find()) { if (p.endsWith('session.v4.jsonl.zstd')) { logPath = p; foundAt = Date.now(); } else tmpSeen.add(p.replace(/.*[\\/]/, '').replace(/[0-9a-f]{8,}/g, '<hex>')); }
  if (!logPath) await new Promise((r) => setTimeout(r, 20));
}
if (!logPath) { console.log(JSON.stringify({ error: 'no session log appeared', waitedMs: Date.now() - t0 })); process.exit(1); }
const dirForm = /[\\/]session-[0-9a-f-]+[\\/]session\.v4\.jsonl\.zstd$/.test(logPath) ? 'session-<uuid>' : '<uuid>';

const intervals = [100, 250, 500, 1000];
const readers = intervals.map((ms) => ({ name: `fstat-poll-${ms}ms`, ms, tail: new FrameTail(logPath), lat: [], frames: [] }));
const watcher = { name: 'fs.watch-only', tail: new FrameTail(logPath), lat: [], frames: [], cb: 0 };
let lastGrowth = Date.now(), lastSize = 0, header = null;
const consume = (r) => {
  const now = Date.now();
  for (const f of r.tail.poll()) {
    const types = [];
    for (const l of f.lines) {
      const v = JSON.parse(l);
      types.push(v.type);
      if (v.type === 'session' && v.version !== undefined) { header ??= { createdAt: v.createdAt, version: v.version, keys: Object.keys(v) }; continue; }
      r.lat.push({ seq: v.seq, type: v.type, ms: now - v.time });
    }
    r.frames.push({ offset: f.start, bytes: f.end - f.start, lines: f.lines.length, detectedAt: now, types });
  }
};
const timers = readers.map((r) => setInterval(() => consume(r), r.ms));
const w = watch(logPath, () => { watcher.cb++; consume(watcher); });
consume(watcher);   // read once right after attaching: frames written before the watch existed fire no callback.
                    // (Added by the fixer after the live run; the evidence in live-tail.json predates this line,
                    //  which is why its fs.watch-only reader shows 6 events > 2 s.)
const sizeTimer = setInterval(() => { const s = readers[0].tail.size(); if (s !== lastSize) { lastSize = s; lastGrowth = Date.now(); } }, 50);
while (Date.now() - lastGrowth < idleMs && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100));
for (const r of readers) consume(r);
const watchFinalSweep = (() => { const n = watcher.lat.length; consume(watcher); return watcher.lat.length - n; })();
timers.forEach(clearInterval); clearInterval(sizeTimer); w.close();

const pct = (a, p) => a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
const d = (a) => { a = [...a].sort((x, y) => x - y); return { n: a.length, min: a[0], p50: pct(a, 50), p90: pct(a, 90), p99: pct(a, 99), max: a.at(-1), over2000: a.filter((x) => x > 2000).length }; };
const out = { node: process.version, pid: process.pid, dirForm, fileBytes: statSync(logPath).size, stagingNamesSeen: [...tmpSeen],
  header, fileFoundAfterCreatedAt_ms: header ? foundAt - header.createdAt : null, readers: {} };
const ref = readers[0];
out.frames = ref.frames.map((f) => ({ offset: f.offset, bytes: f.bytes, lines: f.lines, types: f.types }));
out.events = ref.lat.map((e) => ({ seq: e.seq, type: e.type, ms100: e.ms }));
for (const r of [...readers, watcher]) {
  out.readers[r.name] = { frames: r.frames.length, eventToDecoded_ms: d(r.lat.map((e) => e.ms)), ...(r.cb !== undefined ? { watchCallbacks: r.cb, eventsOnlySeenByFinalSweep: watchFinalSweep } : {}) };
  r.tail.close();
}
console.log(JSON.stringify(out, null, 1));
