import { constants, zstdDecompressSync } from 'node:zlib';
import { frozenClass } from '../../../shared/frozen.js';

// A zstd frame walker (RFC 8878 §3.1), ported from the S1-DSH spike (spikes/s1-dsh/frame-tail.mjs).
// A DSH v4 log is a run of independent, checksummed frames, one per write batch: walking frame
// boundaries lets a reader decode each complete frame alone and stop before a frame DSH has not
// finished writing. No window size is assumed (the spike saw windowLog 21 and 23, and single-segment
// frames).

export type Frame = { start: number; end: number; skippable: boolean };

export class FrameError extends Error {
  readonly code = 'ERR_ORCHESTRA_ZSTD_FRAME';
}
frozenClass(FrameError);

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

/** The frame starting at `s`, or null while `b` does not yet hold all of it. Throws on bytes that are no frame. */
export function parseFrame(b: Uint8Array, s: number): Frame | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length - s < 8) return null;
  const magic = v.getUint32(s, true);
  if (((magic & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC) {
    const end = s + 8 + v.getUint32(s + 4, true);
    return end <= b.length ? { start: s, end, skippable: true } : null;
  }
  if (magic !== ZSTD_MAGIC) throw new FrameError(`bad zstd magic 0x${magic.toString(16)} at byte ${s}`);
  const fhd = b[s + 4]!;
  if ((fhd & 0x08) !== 0) throw new FrameError(`reserved frame-header bit at byte ${s + 4}`);
  const single = (fhd & 0x20) !== 0;
  const checksum = (fhd & 0x04) !== 0;
  const dictBytes = [0, 1, 2, 4][fhd & 3]!;
  const fcsBytes = [single ? 1 : 0, 2, 4, 8][fhd >>> 6]!;
  let o = s + 5 + (single ? 0 : 1) + dictBytes + fcsBytes;
  for (;;) {
    if (b.length - o < 3) return null;
    const bh = b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
    const last = bh & 1;
    const type = (bh >>> 1) & 3;
    const size = bh >>> 3;
    if (type === 3) throw new FrameError(`reserved block type at byte ${o}`);
    // An RLE block carries one byte, whatever size it decodes to.
    o += 3 + (type === 1 ? 1 : size);
    if (o > b.length) return null;
    if (last === 1) break;
  }
  if (checksum) o += 4;
  return o <= b.length ? { start: s, end: o, skippable: false } : null;
}

/** Every complete frame from `start`, and the offset of the first byte after them (an unfinished frame, or the end). */
export function walkFrames(b: Uint8Array, start = 0): { frames: Frame[]; next: number } {
  const frames: Frame[] = [];
  let off = start;
  for (let f = parseFrame(b, off); f !== null; f = parseFrame(b, off)) {
    frames.push(f);
    off = f.end;
  }
  return { frames, next: off };
}

/**
 * One complete, non-skippable frame decoded on its own. With `maxOutputLength`, a frame that decodes to
 * more bytes throws a RangeError (code ERR_BUFFER_TOO_LARGE) instead of growing past it.
 */
export function decodeFrame(b: Uint8Array, f: Frame, maxOutputLength?: number): Buffer {
  const frame = b.subarray(f.start, f.end);
  return maxOutputLength === undefined ? zstdDecompressSync(frame) : zstdDecompressSync(frame, { maxOutputLength });
}

/**
 * What the first bytes of a zstd stream decode to, when the rest of it is not read: the input may end
 * anywhere (mid-block, mid-frame), and only what those bytes already produce comes out. A Codex
 * archived rollout is one frame of the whole session; its first line (session_meta) is in its first
 * bytes. A prefix that decodes to more than `maxOutputLength` throws a RangeError (code
 * ERR_BUFFER_TOO_LARGE); bytes that are no zstd throw as zlib does.
 */
export function decodePrefix(b: Uint8Array, maxOutputLength: number): Buffer {
  return zstdDecompressSync(b, { finishFlush: constants.ZSTD_e_flush, maxOutputLength });
}
