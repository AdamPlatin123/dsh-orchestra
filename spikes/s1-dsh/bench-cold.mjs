// bench-cold.mjs — S1-DSH: cold-start cost of tailing the N largest DSH logs from byte 0 (read-only).
//   node bench-cold.mjs [root=C:/Users/Calx/.dsh/sessions] [N=5]
// For each file: (a) FrameTail.poll() = walk + one zstdDecompressSync per frame + split lines,
// (b) one zstdDecompressSync over the whole multi-frame buffer, (c) walk only. Prints sizes/timings only.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { FrameTail, walkFrames } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:/Users/Calx/.dsh/sessions', N = Number(process.argv[3] ?? 5);
const files = [];
for (const p of readdirSync(root)) for (const s of readdirSync(join(root, p))) {
  const f = join(root, p, s, 'session.v4.jsonl.zstd');
  try { files.push({ f, size: statSync(f).size }); } catch {}
}
files.sort((a, b) => b.size - a.size);
const rows = [];
for (const [i, { f, size }] of files.slice(0, N).entries()) {
  let t = performance.now();
  const tail = new FrameTail(f); const frames = tail.poll(); tail.close();
  const perFrameMs = performance.now() - t;
  const lines = frames.reduce((n, fr) => n + fr.lines.length, 0);
  const buf = readFileSync(f);
  t = performance.now(); const w = walkFrames(buf); const walkMs = performance.now() - t;
  t = performance.now(); let wholeOk = true, plain = 0;
  try { plain = zstdDecompressSync(buf).length; } catch { wholeOk = false; }
  const wholeMs = performance.now() - t;
  rows.push({ rank: i + 1, bytes: size, frames: w.frames.length, lines, plainBytes: plain, frameTailPollMs: +perFrameMs.toFixed(1), walkOnlyMs: +walkMs.toFixed(2),
    oneShotWholeFileMs: +wholeMs.toFixed(1), oneShotHandlesAllFrames: wholeOk });
}
const ru = process.resourceUsage();
console.log(JSON.stringify({ node: process.version, pid: process.pid, maxRssMiB: +(ru.maxRSS / 1024).toFixed(1), rows }, null, 1));
