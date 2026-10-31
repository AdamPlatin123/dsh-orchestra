// polltest.mjs — S1-DSH: on-disk checks for FrameTail.poll() with synthetic DSH-shaped frames only (no user data).
//   <node that can write the dir> polltest.mjs <scratch dir>        (Node >= 23.8 for zstd; prints JSON, deletes its files)
// Cases:
//   torn-then-longer     torn tail seen, then (between two polls) truncate to the frame boundary + append a longer frame
//   torn-then-same-size  same, but the new bytes are exactly as long as the torn bytes were (size unchanged)
//   torn-then-shorter    same, but the file ends up shorter than before and still holds a partial frame
//   rollback-retry       DSH appendLines failure shape: partial append, rollbackAppend to the old size, full retry
//   replaced             path deleted and recreated as a different file, not shorter than the cursor -> reset, re-read from 0
//   rename-over-while-open  records whether a rename over the path succeeds while FrameTail holds it (Windows: EPERM)
//   shrank               file rewritten shorter than the cursor -> reset
//   garbage-at-cursor    in-place rewrite where the cursor lands mid-frame -> error kept for 3 polls, then reset
//   random-pieces        300 frames appended in random pieces (frames split across writes), poll after each write
import { writeFileSync, appendFileSync, truncateSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';
import { FrameTail } from './frame-tail.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: polltest.mjs <scratch dir>'); process.exit(2); }
mkdirSync(dir, { recursive: true });
const p = join(dir, 'poll.v4.jsonl.zstd');
let seed = 777; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const ck = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
let seq = 0;
const ev = (type, n = 40) => ({ type, seq: seq++, time: 1793316440795 + seq, data: { s: Array.from({ length: n }, () => Math.floor(rnd() * 1e9).toString(36)).join(' ') } });
const frame = (...evs) => zstdCompressSync(evs.map((e) => JSON.stringify(e)).join('\n') + '\n', ck);
const H = frame({ type: 'session', version: 4, id: 'synthetic' });
const seqs = (frames) => frames.flatMap((f) => f.lines.map((l) => JSON.parse(l).seq ?? 'h'));
const out = {};
const run = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = { pass: false, threw: String(e?.message ?? e).slice(0, 120) }; } };

run('torn-then-longer', () => {
  const B = frame(ev('torn', 200)), C = frame(ev('step/start', 400)), D = frame(ev('step/end'));
  writeFileSync(p, Buffer.concat([H, B.subarray(0, 20)]));
  const t = new FrameTail(p); const r1 = t.poll();
  truncateSync(p, H.length); appendFileSync(p, C); const r2 = t.poll();
  appendFileSync(p, D); const r3 = t.poll(); t.close();
  const pass = r1.length === 1 && r2.length === 1 && r3.length === 1 && t.cursor === H.length + C.length + D.length && !t.error && t.resets === 0;
  return { pass, frames: [r1.length, r2.length, r3.length], cursorOk: t.cursor === H.length + C.length + D.length, error: t.error, resets: t.resets };
});
run('torn-then-same-size', () => {
  const C = frame(ev('step/start', 400)), dEv = ev('step/end', 400), D = frame(dEv);
  const torn = Math.min(C.length, D.length) - 5;
  writeFileSync(p, Buffer.concat([H, C.subarray(0, torn)]));
  const t = new FrameTail(p); const r1 = t.poll();
  truncateSync(p, H.length); appendFileSync(p, D.subarray(0, torn)); const r2 = t.poll();   // size unchanged
  appendFileSync(p, D.subarray(torn)); const r3 = t.poll(); t.close();
  const pass = r1.length === 1 && r2.length === 0 && r3.length === 1 && t.cursor === H.length + D.length && !t.error && JSON.stringify(seqs(r3)) === JSON.stringify([dEv.seq]);
  return { pass, frames: [r1.length, r2.length, r3.length], cursorOk: t.cursor === H.length + D.length, error: t.error };
});
run('torn-then-shorter', () => {
  const C = frame(ev('assistant/message', 2000)), D = frame(ev('step/end', 300));
  writeFileSync(p, Buffer.concat([H, C.subarray(0, C.length - 3)]));
  const t = new FrameTail(p); const r1 = t.poll();
  truncateSync(p, H.length); appendFileSync(p, D.subarray(0, 30)); const r2 = t.poll();
  appendFileSync(p, D.subarray(30)); const r3 = t.poll(); t.close();
  const pass = r1.length === 1 && r2.length === 0 && r3.length === 1 && t.cursor === H.length + D.length && !t.error;
  return { pass, frames: [r1.length, r2.length, r3.length], shorterThanBefore: H.length + 30 < H.length + C.length - 3, error: t.error };
});
run('rollback-retry', () => {
  const A = frame(ev('turn/start')), B = frame(ev('assistant/message', 800), ev('step/end'));
  writeFileSync(p, Buffer.concat([H, A]));
  const t = new FrameTail(p); const r1 = t.poll();
  appendFileSync(p, B.subarray(0, B.length >> 1)); const r2 = t.poll();          // partial write visible
  truncateSync(p, H.length + A.length); const r3 = t.poll();                      // rollbackAppend
  appendFileSync(p, B); const r4 = t.poll(); t.close();                            // retry
  const pass = r1.length === 2 && r2.length === 0 && r3.length === 0 && r4.length === 1 && r4[0].lines.length === 2 && !t.error && t.resets === 0;
  return { pass, frames: [r1.length, r2.length, r3.length, r4.length], error: t.error, resets: t.resets };
});
run('replaced', () => {                                                          // delete + recreate at the same path
  const A = frame(ev('turn/start')), X = frame(ev('migrated', 3000));
  writeFileSync(p, Buffer.concat([H, A]));
  const t = new FrameTail(p); const r1 = t.poll(); const cursor1 = t.cursor;
  rmSync(p); writeFileSync(p, Buffer.concat([H, X]));                               // not shorter than the old cursor
  const r2 = t.poll(); const reset = t.reset, reason = t.resetReason; t.close();
  const pass = r1.length === 2 && reset && reason === 'replaced' && r2.length === 2 && t.cursor === H.length + X.length && H.length + X.length >= cursor1;
  return { pass, frames: [r1.length, r2.length], reset, reason, error: t.error };
});
run('rename-over-while-open', () => {                                             // a fact, not a FrameTail property
  writeFileSync(p, H); const t = new FrameTail(p); t.poll();
  const q = p + '.next'; writeFileSync(q, H); let code = 'ok';
  try { renameSync(q, p); } catch (e) { code = e.code; }
  t.close(); rmSync(q, { force: true });
  return { pass: true, renameOverOpenTarget: code, note: 'Windows: replacing a path by rename fails while a reader holds it open; unlink + recreate works' };
});
run('shrank', () => {
  const A = frame(ev('turn/start', 500)), B = frame(ev('step/start'));
  writeFileSync(p, Buffer.concat([H, A, B]));
  const t = new FrameTail(p); const r1 = t.poll();
  truncateSync(p, 0); appendFileSync(p, H); const r2 = t.poll(); const reset = t.reset, reason = t.resetReason; t.close();
  const pass = r1.length === 3 && reset && reason === 'shrank-below-cursor' && r2.length === 1 && t.cursor === H.length;
  return { pass, frames: [r1.length, r2.length], reset, reason };
});
run('garbage-at-cursor', () => {
  const A = frame(ev('turn/start', 30)), X = frame(ev('rewritten', 3000)), Y = frame(ev('step/start'));
  writeFileSync(p, Buffer.concat([H, A]));
  const t = new FrameTail(p); const r1 = t.poll(); const cursor1 = t.cursor;
  truncateSync(p, 0); appendFileSync(p, Buffer.concat([X, Y]));                    // same file id, cursor now inside X
  const polls = [];
  for (let k = 0; k < 4; k++) { const r = t.poll(); polls.push({ frames: r.length, error: !!t.error, reset: t.reset }); }
  t.close();
  const last = polls.at(-1);
  const pass = r1.length === 2 && cursor1 < X.length && polls.slice(0, 3).every((x) => x.frames === 0 && x.error && !x.reset) && last.reset && last.frames === 2 && !last.error;
  return { pass, polls, resetReason: t.resetReason };
});
run('random-pieces', () => {
  const frames = [H]; for (let i = 0; i < 300; i++) { const n = 1 + Math.floor(rnd() ** 2 * 4); frames.push(frame(...Array.from({ length: n }, () => ev('x', Math.floor(rnd() ** 4 * 3000) + 5)))); }
  const all = Buffer.concat(frames);
  writeFileSync(p, Buffer.alloc(0));
  const t = new FrameTail(p); let got = 0, lines = 0, writes = 0;
  for (let off = 0; off < all.length;) { const n = Math.max(1, Math.floor(rnd() ** 3 * 8192)); appendFileSync(p, all.subarray(off, off + n)); off += n; writes++; for (const f of t.poll()) { got++; lines += f.lines.length; } }
  t.close();
  const pass = got === frames.length && t.cursor === all.length && !t.error && t.resets === 0;
  return { pass, frames: got, expectedFrames: frames.length, writes, bytes: all.length, lines };
});
rmSync(p, { force: true }); rmSync(p + '.next', { force: true });
out.allPass = Object.values(out).every((x) => x.pass === true);
console.log(JSON.stringify({ node: process.version, pid: process.pid, ...out }, null, 1));
