// selftest.mjs — S1-DSH: in-memory correctness checks for frame-tail.mjs (read-only on user logs).
//   node selftest.mjs [root=C:/Users/Calx/.dsh/sessions] [files=20]
// 1. Real logs fed in random chunks (1 B .. 64 KiB) through FrameTail.ingest(): same frame boundaries,
//    line count and type sequence as a whole-file decode.
// 2. Truncation probes on every frame of those logs: cut the bytes inside the frame header, after every block
//    header, after every block, inside the 4-byte checksum and at 2 random offsets; parseFrame must return null
//    for every cut short of the frame end and the exact end at the frame end. (Replaces the old "earlyEmits"
//    counter, which could never be non-zero.)
// 3. Synthetic frames: skippable frame (0x184D2A5?) between frames, RLE / raw blocks, single-segment frame with
//    content size, a frame without checksum, a torn tail that must stay pending, a bad checksum that must stop
//    ingest at that frame without losing the frames before it, and bad magic.
// On-disk poll() cases (truncate-then-regrow, replacement, shrink, garbage at cursor) are in polltest.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { FrameTail, walkFrames, parseFrame, typeOf } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:/Users/Calx/.dsh/sessions', nFiles = Number(process.argv[3] ?? 20);
const results = { realFiles: 0, realFrames: 0, realLines: 0, chunks: 0, mismatches: 0,
  truncationProbes: 0, prematureFrames: 0, wrongFrameEnds: 0, synthetic: {} };
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

// byte offsets strictly inside a frame at which a reader could see it cut off
function cutPoints(b, fr) {
  const cuts = new Set();
  const fhd = b[fr.start + 4], single = (fhd & 0x20) !== 0;
  let o = fr.start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single ? 1 : 0, 2, 4, 8][fhd >>> 6];
  for (let c = fr.start + 1; c <= o; c++) cuts.add(c);                       // inside magic + frame header
  for (;;) {
    const bh = b.readUIntLE(o, 3), ty = (bh >>> 1) & 3;
    cuts.add(o + 1); cuts.add(o + 3);                                         // inside / right after the block header
    o += 3 + (ty === 1 ? 1 : bh >>> 3); cuts.add(o - 1); cuts.add(o);         // last byte missing / block complete
    if (bh & 1) break;
  }
  for (let c = o; c < fr.end; c++) cuts.add(c);                               // inside the content checksum
  for (let k = 0; k < 2; k++) cuts.add(fr.start + 1 + Math.floor(rnd() * (fr.end - fr.start - 1)));
  return [...cuts].filter((c) => c > fr.start && c < fr.end);
}

const files = [];
for (const p of readdirSync(root)) for (const s of readdirSync(join(root, p))) {
  const f = join(root, p, s, 'session.v4.jsonl.zstd'); try { files.push({ f, size: statSync(f).size }); } catch {}
}
files.sort((a, b) => a.size - b.size);
const pick = []; for (let i = 0; i < nFiles; i++) pick.push(files[Math.floor((i + 0.5) * files.length / nFiles)]);   // spread over sizes
for (const { f } of pick) {
  const buf = readFileSync(f);
  const whole = walkFrames(buf);
  const expTypes = []; for (const fr of whole.frames) for (const l of zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8').split('\n')) if (l) expTypes.push(typeOf(l));
  const t = new FrameTail(null); const gotTypes = []; const ends = [];
  for (let off = 0; off < buf.length;) {
    const n = Math.max(1, Math.floor(rnd() ** 3 * 65536)); const chunk = buf.subarray(off, Math.min(buf.length, off + n)); off += chunk.length; results.chunks++;
    for (const fr of t.ingest(chunk)) { ends.push(fr.end); for (const l of fr.lines) gotTypes.push(typeOf(l)); }
  }
  const sameEnds = ends.length === whole.frames.length && ends.every((e, i) => e === whole.frames[i].end);
  const sameTypes = gotTypes.length === expTypes.length && gotTypes.every((x, i) => x === expTypes[i]);
  if (!sameEnds || !sameTypes || t.cursor !== buf.length || t.error) results.mismatches++;
  for (const fr of whole.frames) {
    if (fr.skippable) continue;
    for (const c of cutPoints(buf, fr)) { results.truncationProbes++; if (parseFrame(buf.subarray(0, c), fr.start) !== null) results.prematureFrames++; }
    if (parseFrame(buf.subarray(0, fr.end), fr.start)?.end !== fr.end) results.wrongFrameEnds++;
  }
  results.realFiles++; results.realFrames += ends.length; results.realLines += gotTypes.length;
}

// synthetic cases
const ck = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const line = (o) => JSON.stringify(o) + '\n';
const fA = zstdCompressSync(line({ type: 'session', version: 4 }), ck);
const fRle = zstdCompressSync(Buffer.concat([Buffer.from('{"type":"x","pad":"'), Buffer.alloc(300000, 0x61), Buffer.from('"}\n')]), ck);
const fRaw = zstdCompressSync(line({ type: 'raw', r: Array.from({ length: 2000 }, () => Math.floor(rnd() * 1e9).toString(36)).join('') }), { params: { [constants.ZSTD_c_compressionLevel]: -5 } });
const sBuf = Buffer.from(line({ type: 'single' }));
const fSingle = zstdCompressSync(sBuf, { pledgedSrcSize: sBuf.length, params: { [constants.ZSTD_c_contentSizeFlag]: 1 } });
const skip = Buffer.alloc(8 + 5); skip.writeUInt32LE(0x184D2A53, 0); skip.writeUInt32LE(5, 4);
const stream = Buffer.concat([fA, skip, fRle, fRaw, fSingle]);
const w = walkFrames(stream);
const blockTypes = (fr) => { const types = new Set(); let o = fr.start + 4; const fhd = stream[o]; o += 1 + ((fhd & 0x20) ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [(fhd & 0x20) ? 1 : 0, 2, 4, 8][fhd >>> 6];
  for (;;) { const bh = stream.readUIntLE(o, 3); const ty = (bh >>> 1) & 3; types.add(['raw', 'rle', 'compressed'][ty]); o += 3 + (ty === 1 ? 1 : bh >>> 3); if (bh & 1) break; } return [...types]; };
results.synthetic.frames = w.frames.map((fr) => ({ bytes: fr.end - fr.start, skippable: fr.skippable, ...(fr.skippable ? {} : { checksum: fr.checksum, single: fr.single, windowLog: fr.windowLog, blocks: fr.blocks, blockTypes: blockTypes(fr) }) }));
results.synthetic.allConsumed = w.next === stream.length;
const t2 = new FrameTail(null);
const torn = Buffer.concat([fA, fRle.subarray(0, fRle.length - 3)]);
const got1 = t2.ingest(torn); const cursorAfterFirst = t2.cursor, pendingAfterFirst = t2.pending.length;
const got2 = t2.ingest(fRle.subarray(fRle.length - 3));
results.synthetic.tornTail = { firstPollFrames: got1.length, cursorStaysAtFrameBoundary: cursorAfterFirst === fA.length, pendingBytes: pendingAfterFirst,
  secondPollFrames: got2.length, cursorAtEnd: t2.cursor === fA.length + fRle.length };
const fB = zstdCompressSync(line({ type: 'b', n: 1 }), ck), bad = Buffer.from(fB); bad[bad.length - 1] ^= 0xff;   // flip one checksum byte
const t3 = new FrameTail(null); const got3 = t3.ingest(Buffer.concat([fA, bad, fRaw]));
results.synthetic.badChecksum = { framesBeforeIt: got3.length, cursorStopsAtBadFrame: t3.cursor === fA.length, errorAt: t3.error?.at ?? null, errorAtBadFrame: t3.error?.at === fA.length };
let threw = false; try { walkFrames(Buffer.concat([fA, Buffer.from('garbage!')])); } catch { threw = true; }
results.synthetic.badMagicThrows = threw;
const s = results.synthetic;
results.allPass = results.mismatches === 0 && results.prematureFrames === 0 && results.wrongFrameEnds === 0 && s.allConsumed
  && s.tornTail.firstPollFrames === 1 && s.tornTail.cursorStaysAtFrameBoundary && s.tornTail.secondPollFrames === 1 && s.tornTail.cursorAtEnd
  && s.badChecksum.framesBeforeIt === 1 && s.badChecksum.cursorStopsAtBadFrame && s.badChecksum.errorAtBadFrame && s.badMagicThrows;
console.log(JSON.stringify(results, null, 1));
