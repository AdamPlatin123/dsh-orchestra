// bench-decode.mjs — S1-DSH: cold-start decode cost with the file already in memory (read-only).
// Separates disk read from CPU: for every v4 log (or the N largest) it times
//   walk      — frame walker only (frame-tail.mjs walkFrames)
//   perFrame  — one zstdDecompressSync per complete frame (what FrameTail.poll does after the read)
//   oneShot   — one zstdDecompressSync over buf[0, cursor) (zstd decodes concatenated frames in one call)
// Each measured 3 times; the median is kept. Prints sizes/timings only — no bodies, no paths.
//   node bench-decode.mjs [root=C:/Users/Calx/.dsh/sessions] [N=all]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { walkFrames } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:/Users/Calx/.dsh/sessions';
const files = [];
for (const p of readdirSync(root)) for (const s of readdirSync(join(root, p))) {
  const f = join(root, p, s, 'session.v4.jsonl.zstd');
  try { files.push({ f, size: statSync(f).size }); } catch {}
}
files.sort((a, b) => b.size - a.size);
const N = process.argv[3] ? Number(process.argv[3]) : files.length;
const med3 = (fn) => { const t = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[1]; };
const tot = { files: 0, bytes: 0, frames: 0, plainBytes: 0, readMs: 0, walkMs: 0, perFrameMs: 0, oneShotMs: 0 };
const top = [];
for (const [i, { f }] of files.slice(0, N).entries()) {
  let t0 = performance.now(); const buf = readFileSync(f); const readMs = performance.now() - t0;
  const { frames, next } = walkFrames(buf);
  let plain = 0;
  const walkMs = med3(() => walkFrames(buf));
  const perFrameMs = med3(() => { plain = 0; for (const fr of frames) plain += zstdDecompressSync(buf.subarray(fr.start, fr.end)).length; });
  const oneShotMs = med3(() => zstdDecompressSync(buf.subarray(0, next)));
  Object.assign(tot, { files: tot.files + 1, bytes: tot.bytes + buf.length, frames: tot.frames + frames.length, plainBytes: tot.plainBytes + plain,
    readMs: tot.readMs + readMs, walkMs: tot.walkMs + walkMs, perFrameMs: tot.perFrameMs + perFrameMs, oneShotMs: tot.oneShotMs + oneShotMs });
  if (i < 5) top.push({ rank: i + 1, bytes: buf.length, frames: frames.length, plainBytes: plain, readMs: +readMs.toFixed(1), walkMs: +walkMs.toFixed(2),
    perFrameMs: +perFrameMs.toFixed(1), oneShotMs: +oneShotMs.toFixed(1), perFrameUsPerFrame: +((perFrameMs * 1000) / frames.length).toFixed(1) });
}
for (const k of ['readMs', 'walkMs', 'perFrameMs', 'oneShotMs']) tot[k] = +tot[k].toFixed(1);
tot.perFrameUsPerFrame = +((tot.perFrameMs * 1000) / tot.frames).toFixed(1);
tot.perFrameOverOneShot = +(tot.perFrameMs / tot.oneShotMs).toFixed(2);
const ru = process.resourceUsage();
console.log(JSON.stringify({ node: process.version, pid: process.pid, maxRssMiB: +(ru.maxRSS / 1024).toFixed(1), total: tot, top5: top }, null, 1));
