// dsh-hold.mjs — S1-DSH: how long DSH itself holds events before they reach disk, from the existing v4 logs.
// Read-only. Prints counts, quantiles, frame indices, file ordinals, dates and `type` values only (no bodies, no paths).
//   node24 dsh-hold.mjs [root=C:/Users/Calx/.dsh/sessions] > dsh-hold.json
// Per frame: spread = latest - earliest event `time` in the frame (frames with >= 2 timed events, header excluded),
// bucketed by line count (<= 10, 11-50, > 50 = migration rewrites).
// Per event (frames <= 50 lines): hold lower bound = latest event `time` in its frame - its own `time`. The frame is
// written after its latest event, so every event waited at least this long inside DSH, before any reader polls.
// Based on the reviewer's review/spread2.mjs + review/holdlb.mjs (S1-DSH-01), merged and extended.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { walkFrames } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:/Users/Calx/.dsh/sessions';
const files = [];
for (const p of readdirSync(root)) { let ss; try { ss = readdirSync(join(root, p)); } catch { continue; }
  for (const s of ss) { const f = join(root, p, s, 'session.v4.jsonl.zstd'); try { statSync(f); files.push(f); } catch {} } }
const bucket = (n) => (n <= 10 ? '<=10' : n <= 50 ? '11-50' : '>50');
const spread = {}, holds = [], over1000ByType = {}, over2000ByType = {}, over1000ByFrameIdx = { '1-2': 0, '>2': 0 }, over2000ByFrameIdx = { '1-2': 0, '>2': 0 };
const over2000Frames = [];
let fi = 0;
for (const f of files) {
  fi++;
  const b = readFileSync(f); const { frames } = walkFrames(b);
  let createdAt = null;
  frames.forEach((fr, i) => {
    if (fr.skippable) return;
    const evs = zstdDecompressSync(b.subarray(fr.start, fr.end)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const n = evs.length;
    if (i === 0 && evs[0]?.type === 'session') createdAt = evs[0].createdAt ?? null;
    const timed = evs.filter((v) => v.type !== 'session' && typeof v.time === 'number');
    if (timed.length >= 2) {
      const k = `${bucket(n)}${i === 0 ? ' frame0' : ''}`;
      const s = Math.max(...timed.map((v) => v.time)) - Math.min(...timed.map((v) => v.time));
      spread[k] ??= { frames: 0, over250: 0, over500: 0, over1000: 0, over2000: 0 };
      spread[k].frames++; for (const t of [250, 500, 1000, 2000]) if (s > t) spread[k][`over${t}`]++;
    }
    if (n > 50 || !timed.length) return;
    const hi = Math.max(...timed.map((v) => v.time));
    let frameOver2000 = 0;
    for (const v of timed) {
      const h = hi - v.time; holds.push(h);
      const idx = i <= 2 ? '1-2' : '>2';
      if (h > 1000) { over1000ByType[v.type] = (over1000ByType[v.type] ?? 0) + 1; over1000ByFrameIdx[idx]++; }
      if (h > 2000) { over2000ByType[v.type] = (over2000ByType[v.type] ?? 0) + 1; over2000ByFrameIdx[idx]++; frameOver2000++; }
    }
    if (frameOver2000) over2000Frames.push({ file: fi, frameIdx: i, of: frames.length, lines: n, events: frameOver2000, maxHoldMs: hi - Math.min(...timed.map((v) => v.time)),
      sessionCreated: createdAt ? new Date(createdAt).toISOString().slice(0, 10) : null, firstType: timed[0].type, lastType: timed.at(-1).type });
  });
}
holds.sort((x, y) => x - y);
const q = (p) => holds[Math.min(holds.length - 1, Math.ceil(p * holds.length) - 1)];
console.log(JSON.stringify({ files: files.length, spreadByLines: spread,
  holdLowerBound_ms: { events: holds.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), p999: q(0.999), p9999: q(0.9999), max: holds.at(-1),
    over500: holds.filter((h) => h > 500).length, over1000: holds.filter((h) => h > 1000).length, over2000: holds.filter((h) => h > 2000).length },
  over1000ByType, over1000ByFrameIdx, over2000ByType, over2000ByFrameIdx, over2000Frames }, null, 1));
