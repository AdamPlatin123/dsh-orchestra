// outliers.mjs — S1-DSH: list the unusual frames in DSH v4 logs (read-only): frames > 64 KiB, single-segment
// frames, windowLog != 21, and first frames that are not exactly one header line. Also totals the plaintext.
//   node outliers.mjs [root=C:/Users/Calx/.dsh/sessions] > outliers.json
// Prints file ordinal, frame index, sizes, block counts, seq range, time spread, first `type` — no bodies, no paths.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { walkFrames } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:/Users/Calx/.dsh/sessions';
const files = [];
for (const p of readdirSync(root)) for (const s of readdirSync(join(root, p))) { const f = join(root, p, s, 'session.v4.jsonl.zstd'); try { statSync(f); files.push(f); } catch {} }
let fi = 0, plainTotal = 0; const rows = [];
for (const f of files) {
  fi++;
  const b = readFileSync(f); const { frames } = walkFrames(b);
  frames.forEach((fr, i) => {
    const size = fr.end - fr.start;
    const txt = zstdDecompressSync(b.subarray(fr.start, fr.end)).toString('utf8'); plainTotal += Buffer.byteLength(txt);
    const lines = txt.split('\n').filter(Boolean);
    if (!(size > 65536 || fr.single || (!fr.single && fr.windowLog !== 21) || (i === 0 && lines.length !== 1))) return;
    let tmin = Infinity, tmax = -Infinity, smin = Infinity, smax = -Infinity; const types = new Set();
    for (const l of lines) { const v = JSON.parse(l); types.add(v.type); if (typeof v.time === 'number') { tmin = Math.min(tmin, v.time); tmax = Math.max(tmax, v.time); } if (typeof v.seq === 'number') { smin = Math.min(smin, v.seq); smax = Math.max(smax, v.seq); } }
    rows.push({ file: fi, frameIdx: i, of: frames.length, bytes: size, plain: Buffer.byteLength(txt), blocks: fr.blocks, single: fr.single, windowLog: fr.windowLog,
      lines: lines.length, seq: [smin, smax], spreadMs: Number.isFinite(tmin) ? tmax - tmin : null, nTypes: types.size, firstType: JSON.parse(lines[0]).type });
  });
}
console.log(JSON.stringify({ files: files.length, plainTotalBytes: plainTotal, outliers: rows }, null, 1));
