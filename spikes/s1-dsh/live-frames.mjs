// live-frames.mjs — S1-DSH: per-frame timeline of the ONE spike-owned live DSH session log (the run made by
// run-live.sh in a scratch DSH_HOME), joined with live-tail.json. Read-only. Prints offsets, sizes, line counts,
// `type` values, times relative to the header's createdAt, key names, and the model id string — never text.
//   node live-frames.mjs <session.v4.jsonl.zstd> <live-tail.json>
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { walkFrames } from './frame-tail.mjs';

const [logPath, tailJson] = process.argv.slice(2);
const buf = readFileSync(logPath);
const tail = JSON.parse(readFileSync(tailJson, 'utf8'));
const ms100 = new Map(tail.events.map((e) => [e.seq, e.ms100]));          // seq -> (decoded by 100 ms poller) - event.time
const { frames, next } = walkFrames(buf);
let created = null, model = new Set(), keyNames = {};
const out = [];
for (const f of frames) {
  const lines = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const evs = [];
  for (const v of lines) {
    if (v.type === 'session' && v.version !== undefined) { created = v.createdAt; continue; }
    evs.push(v);
    if (v.data && typeof v.data === 'object') {
      keyNames[v.type] ??= Object.keys(v.data);
      for (const m of [v.data.model, v.data.modelId, v.data.selectedModel]) if (typeof m === 'string' && /^[\w.\-/:]{1,64}$/.test(m)) model.add(m);
    }
  }
  const rel = (t) => (created === null ? null : t - created);
  const times = evs.map((v) => v.time);
  const detected = evs.map((v) => (ms100.has(v.seq) ? v.time + ms100.get(v.seq) : null)).filter((x) => x !== null);
  out.push({ offset: f.start, bytes: f.end - f.start, windowLog: f.windowLog, checksum: f.checksum, events: evs.length,
    types: evs.map((v) => v.type),
    firstEventRelMs: times.length ? rel(Math.min(...times)) : null, lastEventRelMs: times.length ? rel(Math.max(...times)) : null,
    spreadMs: times.length ? Math.max(...times) - Math.min(...times) : null,
    detectedRelMs: detected.length ? rel(detected[0]) : null,
    detectedConsistent: detected.every((d) => d === detected[0]),
    firstEventToDetected100Ms: detected.length ? detected[0] - Math.min(...times) : null,
    writtenBeforeTailStarted: times.length ? rel(Math.max(...times)) < tail.fileFoundAfterCreatedAt_ms : null });
}
console.log(JSON.stringify({ fileBytes: buf.length, frames: frames.length, tailPendingBytes: buf.length - next,
  tailStartedRelMs: tail.fileFoundAfterCreatedAt_ms, modelIds: [...model], dataKeyNamesByType: keyNames, frameTimeline: out }, null, 1));
