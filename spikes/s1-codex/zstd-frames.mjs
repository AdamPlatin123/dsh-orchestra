// zstd frame walker (RFC 8878 §3.1). Read-only: opens files with fs.openSync(p, 'r').
// walkFrames(fd, size) walks every frame without decompressing and returns header facts,
// per-block types/sizes and the byte offset after the last complete frame (the cursor).
import fs from 'node:fs';

export const ZSTD_MAGIC = 0xfd2fb528;
const BT = ['raw', 'rle', 'compressed', 'reserved'];

function readAt(fd, pos, len) {
  const b = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : null; // null = not enough bytes yet (incomplete)
}

// Parse one frame starting at pos. Returns {frame, end} or {incomplete:true}.
export function parseFrame(fd, pos, size, { keepBlocks = false } = {}) {
  const m = readAt(fd, pos, 4);
  if (!m) return { incomplete: true };
  const magic = m.readUInt32LE(0);
  if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame
    const h = readAt(fd, pos + 4, 4);
    if (!h) return { incomplete: true };
    const len = h.readUInt32LE(0);
    if (pos + 8 + len > size) return { incomplete: true };
    return { frame: { kind: 'skippable', offset: pos, length: 8 + len }, end: pos + 8 + len };
  }
  if (magic !== ZSTD_MAGIC) return { error: `bad magic 0x${magic.toString(16)} at ${pos}` };
  const hd = readAt(fd, pos + 4, 14); // descriptor + up to 13 header bytes
  if (!hd && pos + 5 > size) return { incomplete: true };
  const fhd = hd ? hd[0] : readAt(fd, pos + 4, 1)[0];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  let p = pos + 5;
  let windowLog = null, windowSize = null;
  if (!single) {
    const wd = readAt(fd, p, 1); if (!wd) return { incomplete: true };
    const exp = wd[0] >> 3, mant = wd[0] & 7;
    windowLog = 10 + exp;
    windowSize = 2 ** windowLog + (2 ** windowLog / 8) * mant;
    p += 1;
  }
  const didLen = [0, 1, 2, 4][didFlag];
  let dictId = 0;
  if (didLen) { const d = readAt(fd, p, didLen); if (!d) return { incomplete: true }; dictId = d.readUIntLE(0, didLen); p += didLen; }
  const fcsLen = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  let fcs = null;
  if (fcsLen) {
    const f = readAt(fd, p, fcsLen); if (!f) return { incomplete: true };
    fcs = fcsLen === 8 ? Number(f.readBigUInt64LE(0)) : f.readUIntLE(0, fcsLen) + (fcsLen === 2 ? 256 : 0);
    p += fcsLen;
  }
  if (single) windowSize = fcs;
  const headerBytes = p - pos;
  const header = { offset: pos, single: !!single, checksum: !!checksum, dictId, windowLog, windowSize, fcs };
  const counts = { raw: 0, rle: 0, compressed: 0, reserved: 0 };
  const blocks = keepBlocks ? [] : null;
  let nBlocks = 0, maxBlockBytes = 0, rawOut = 0;
  for (;;) {
    const bh = readAt(fd, p, 3); if (!bh) return { incomplete: true, partial: { ...header, blocksSeen: nBlocks } };
    const v = bh.readUIntLE(0, 3);
    const last = v & 1, type = BT[(v >> 1) & 3], bsize = v >> 3;
    const contentLen = type === 'rle' ? 1 : bsize;
    if (p + 3 + contentLen > size) return { incomplete: true, partial: { ...header, blocksSeen: nBlocks } };
    counts[type]++; nBlocks++;
    if (contentLen > maxBlockBytes) maxBlockBytes = contentLen;
    if (type !== 'compressed') rawOut += bsize;
    if (blocks) blocks.push({ offset: p, end: p + 3 + contentLen, type, bsize, last: !!last });
    p += 3 + contentLen;
    if (last) break;
  }
  if (checksum) { if (p + 4 > size) return { incomplete: true, partial: { ...header, blocksSeen: nBlocks } }; p += 4; }
  return {
    frame: { kind: 'zstd', offset: pos, length: p - pos, headerBytes, fhd, single: !!single, checksum: !!checksum,
      dictId, windowLog, windowSize, fcs, nBlocks, blockTypes: counts, maxBlockBytes, rawOrRleOut: rawOut, blocks },
    end: p,
  };
}

// Walk from `start` to the end of the file. cursor = byte offset after last complete frame.
export function walkFrames(fd, size, start = 0, opts = {}) {
  const frames = [];
  let pos = start, incomplete = false, error = null, partial = null;
  while (pos < size) {
    const r = parseFrame(fd, pos, size, opts);
    if (r.error) { error = r.error; break; }
    if (r.incomplete) { incomplete = true; partial = r.partial ?? null; break; }
    frames.push(r.frame); pos = r.end;
  }
  return { frames, cursor: pos, trailingBytes: size - pos, incomplete, partial, error };
}

export function walkFile(path, opts = {}) {
  const fd = fs.openSync(path, 'r');
  try { const { size } = fs.fstatSync(fd); return { size, ...walkFrames(fd, size, 0, opts) }; }
  finally { fs.closeSync(fd); }
}
