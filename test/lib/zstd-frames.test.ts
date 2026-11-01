import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { FrameError, decodeFrame, parseFrame, walkFrames } from '../../src/lib/zstd/frames.ts';

// Synthetic frames only: each batch is compressed on its own, the way DSH writes one frame per batch.
const withChecksum = (s: string) => zlib.zstdCompressSync(Buffer.from(s), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
const plain = (s: string) => zlib.zstdCompressSync(Buffer.from(s));
const skippable = (payload: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x184d2a53, 0);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
};

const BATCHES = ['{"type":"head"}\n', '{"type":"a","seq":1}\n{"type":"b","seq":2}\n', `${'x'.repeat(3000)}\n`];

test('a run of frames walks to its end and each frame decodes alone', () => {
  const parts = [withChecksum(BATCHES[0]!), skippable(Buffer.from('meta')), plain(BATCHES[1]!), withChecksum(BATCHES[2]!)];
  const b = Buffer.concat(parts);
  const { frames, next } = walkFrames(b);
  assert.equal(next, b.length);
  assert.deepEqual(frames.map((f) => f.skippable), [false, true, false, false]);
  const text = frames.filter((f) => !f.skippable).map((f) => decodeFrame(b, f).toString('utf8'));
  assert.deepEqual(text, BATCHES);
});

test('a frame cut anywhere is never handed out early, and the cursor stays on a frame boundary', () => {
  const parts = [withChecksum(BATCHES[0]!), plain(BATCHES[1]!), withChecksum(BATCHES[2]!)];
  const b = Buffer.concat(parts);
  const ends: number[] = [];
  let at = 0;
  for (const p of parts) ends.push((at += p.length));
  for (let cut = 0; cut <= b.length; cut++) {
    const { frames, next } = walkFrames(b.subarray(0, cut));
    const complete = ends.filter((e) => e <= cut);
    assert.equal(frames.length, complete.length, `cut ${cut}`);
    assert.equal(next, complete.length === 0 ? 0 : complete[complete.length - 1], `cut ${cut}`);
  }
});

test('bytes that are no frame are refused', () => {
  assert.throws(() => parseFrame(Buffer.from('not a zstd frame'), 0), FrameError);
});
