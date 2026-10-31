// Items 3 (+ block-boundary test). Feeds byte prefixes / single blocks of a rollout to a
// long-lived zlib.createZstdDecompress and counts what comes out. Read-only (fs.openSync 'r').
// Usage:
//   node24 prefix-test.mjs prefix <file...>   -> per file: 10/50/90/100 % prefixes -> complete lines, decoded bytes
//   node24 prefix-test.mjs blocks <file...>   -> feed block by block: decoded bytes per block, does each block end on '\n'
// Output: one JSON object per file on stdout. Never prints decoded text.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { setImmediate as tick } from 'node:timers/promises';
import { walkFile } from './zstd-frames.mjs';

const [mode, ...files] = process.argv.slice(2);

function makeDecoder() {
  const dec = zlib.createZstdDecompress();
  const st = { out: 0, lines: 0, lastByte: -1, err: null, ended: false };
  dec.on('data', (c) => { st.out += c.length; for (let i = 0; i < c.length; i++) if (c[i] === 10) st.lines++; st.lastByte = c[c.length - 1]; });
  dec.on('error', (e) => { st.err = e.code || e.message; });
  dec.on('end', () => { st.ended = true; });
  const feed = (buf) => new Promise((res) => dec.write(buf, () => res())).then(() => tick());
  return { dec, st, feed };
}

function readRange(fd, start, end) {
  const b = Buffer.allocUnsafe(end - start);
  fs.readSync(fd, b, 0, b.length, start);
  return b;
}

async function prefixTest(file) {
  const fd = fs.openSync(file, 'r');
  const { size } = fs.fstatSync(fd);
  const res = { file: path.basename(file), size, prefixes: [] };
  for (const frac of [0.1, 0.5, 0.9, 1.0]) {
    const n = Math.floor(size * frac);
    const { dec, st, feed } = makeDecoder();
    let firstOutAt = null; const t0 = performance.now();
    for (let p = 0; p < n; p += 1 << 20) {
      await feed(readRange(fd, p, Math.min(n, p + (1 << 20))));
      if (firstOutAt === null && st.out > 0) firstOutAt = Math.min(n, p + (1 << 20));
    }
    const beforeEnd = { decodedBytes: st.out, completeLines: st.lines, endsOnNewline: st.lastByte === 10 };
    if (frac === 1.0) { dec.end(); await new Promise((r) => { dec.once('end', r); dec.once('error', r); }); } else dec.destroy();
    res.prefixes.push({ frac, bytesFed: n, ...beforeEnd, firstOutputByInputOffset: firstOutAt, ms: Math.round(performance.now() - t0), endedCleanly: frac === 1.0 ? st.ended && !st.err : null, err: st.err });
  }
  fs.closeSync(fd);
  return res;
}

async function blocksTest(file) {
  const w = walkFile(file, { keepBlocks: true });
  const f = w.frames[0];
  const fd = fs.openSync(file, 'r');
  const { dec, st, feed } = makeDecoder();
  await feed(readRange(fd, f.offset, f.blocks[0].offset)); // magic + frame header only
  const headerOnlyOut = st.out;
  const per = []; let atNl = 0, exact128k = 0, prev = 0;
  for (const b of f.blocks) {
    await feed(readRange(fd, b.offset, b.end));
    const d = st.out - prev; prev = st.out;
    per.push(d);
    if (st.lastByte === 10) atNl++;
    if (d === 131072) exact128k++;
  }
  if (f.checksum) await feed(readRange(fd, f.blocks.at(-1).end, f.offset + f.length));
  dec.end(); await new Promise((r) => { dec.once('end', r); dec.once('error', r); });
  fs.closeSync(fd);
  const s = [...per].sort((a, b) => a - b);
  const nonLast = per.slice(0, -1);
  return {
    file: path.basename(file), size: w.size, fcs: f.fcs, single: f.single, windowLog: f.windowLog, blocks: per.length,
    headerOnlyOutput: headerOnlyOut, decodedTotal: st.out, lines: st.lines, err: st.err,
    decodedPerBlock: { min: s[0], median: s[Math.floor((s.length - 1) / 2)], max: s.at(-1) },
    nonLastBlocksExactly128KiB: nonLast.filter((d) => d === 131072).length, nonLastBlocks: nonLast.length,
    nonLastBlocksMultipleOf8KiB: nonLast.filter((d) => d % 8192 === 0).length,
    blocksEndingOnNewline: atNl, everyBlockProducedOutput: per.every((d) => d > 0),
    meanLineBytes: st.lines ? Math.round(st.out / st.lines) : null,
  };
}

for (const file of files) {
  const r = mode === 'blocks' ? await blocksTest(file) : await prefixTest(file);
  process.stdout.write(JSON.stringify(r) + '\n');
}
console.error(JSON.stringify({ peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
