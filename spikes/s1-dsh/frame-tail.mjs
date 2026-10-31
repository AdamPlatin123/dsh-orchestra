// frame-tail.mjs — S1-DSH spike: zstd frame walker + read-only tail for DSH
// `session.v4.jsonl.zstd` logs. Node 24 only (needs zlib.zstdDecompressSync).
//
//   node frame-tail.mjs scan   <file>                  one pass, prints frame stats (no content)
//   node frame-tail.mjs follow <file> [--interval ms]   fstat-poll tail (default 250 ms), prints offsets/sizes/line counts/type values
//
// Output never contains event bodies: only offsets, sizes, counts, timestamps, key names and `type` values.
import { openSync, fstatSync, statSync, readSync, closeSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

// ---- frame walker (RFC 8878 §3.1) -------------------------------------------------------------
// Returns null when the bytes at `s` do not yet hold one complete frame (cursor stays at `s`).
export function parseFrame(b, s) {
  if (b.length - s < 8) return null;                                   // magic+min header / skippable header
  const magic = b.readUInt32LE(s);
  if ((magic & 0xFFFFFFF0) >>> 0 === 0x184D2A50) {                      // skippable frame 0x184D2A5?
    const end = s + 8 + b.readUInt32LE(s + 4);
    return end <= b.length ? { start: s, end, skippable: true } : null;
  }
  if (magic !== 0xFD2FB528) throw new Error(`bad zstd magic 0x${magic.toString(16)} at byte ${s}`);
  const fhd = b[s + 4], fcsFlag = fhd >>> 6, single = (fhd & 0x20) !== 0, checksum = (fhd & 0x04) !== 0;
  if (fhd & 0x08) throw new Error(`reserved frame-header bit at byte ${s + 4}`);
  const dictBytes = [0, 1, 2, 4][fhd & 3], fcsBytes = [single ? 1 : 0, 2, 4, 8][fcsFlag];
  let o = s + 5, windowLog = null;
  if (!single) { windowLog = 10 + (b[o] >>> 3); o += 1; }               // mantissa ignored: log of base
  o += dictBytes + fcsBytes;
  let blocks = 0;
  for (;;) {
    if (b.length - o < 3) return null;
    const bh = b.readUIntLE(o, 3), last = bh & 1, type = (bh >>> 1) & 3, size = bh >>> 3;
    if (type === 3) throw new Error(`reserved block type at byte ${o}`);
    o += 3 + (type === 1 ? 1 : size); blocks++;                         // RLE block carries 1 byte
    if (o > b.length) return null;
    if (last) break;
  }
  if (checksum) o += 4;
  if (o > b.length) return null;
  return { start: s, end: o, skippable: false, checksum, single, windowLog, blocks };
}

export function walkFrames(b, start = 0) {
  const frames = [];
  let off = start, f;
  while ((f = parseFrame(b, off)) !== null) { frames.push(f); off = f.end; }
  return { frames, next: off };                                         // next = byte offset of the next (incomplete) frame
}
// ---- end of walker -------------------------------------------------------------------------------

// Read-only tail. Cursor = byte offset just after the last complete frame handed out.
// Every poll() re-reads [cursor, size) from the open handle instead of keeping bytes from earlier polls.
// Past the cursor there is at most one incomplete frame, so the re-read is cheap, and a truncate-then-regrow
// between two polls (DSH torn-tail repair before the next append, rollbackAppend + retry) can never splice
// stale tail bytes onto new ones.
// After a poll, `reset` is true when that poll restarted from byte 0 (same path now names another file,
// file shrank below the cursor, or the cursor stopped landing on a frame for `maxErrorPolls` polls):
// the consumer must de-duplicate by event `seq`. `error` = {at, message} when a poll stopped at a bad frame;
// frames before it are still returned and the bad frame is re-read on the next poll.
// Open mode 'r' (libuv shares read/write/delete), so DSH can keep appending, truncating and deleting. On Windows a
// rename OVER this path fails with EPERM while the handle is open (polltest.mjs); DSH never does that — it publishes
// logs with MoveFileExW only to paths that do not exist yet (dsh-session-persistence-jsonl lib/index.js:539-549).
export class FrameTail {
  constructor(path, { maxErrorPolls = 3 } = {}) {
    this.path = path; this.fd = path ? openSync(path, 'r') : null; this.cursor = 0; this.pending = Buffer.alloc(0);
    this.reset = false; this.resets = 0; this.resetReason = null; this.error = null; this.errorPolls = 0; this.maxErrorPolls = maxErrorPolls; this.restartNext = null;
  }
  size() { return fstatSync(this.fd).size; }
  restart(reason) { this.cursor = 0; this.pending = Buffer.alloc(0); this.reset = true; this.resets++; this.resetReason = reason; this.errorPolls = 0; this.restartNext = null; }
  // Returns [{start,end,lines:[string], skippable}] for every newly completed frame.
  poll() {
    this.reset = false;
    if (this.restartNext) this.restart(this.restartNext);
    let fst = fstatSync(this.fd, { bigint: true }), st = null;
    try { st = statSync(this.path, { bigint: true }); } catch {}         // path gone: keep reading the open file
    if (st && (st.ino !== fst.ino || st.dev !== fst.dev)) {               // same path, different file
      closeSync(this.fd); this.fd = openSync(this.path, 'r'); fst = fstatSync(this.fd, { bigint: true }); this.restart('replaced');
    }
    const size = Number(fst.size);
    if (size < this.cursor) this.restart('shrank-below-cursor');
    const chunk = Buffer.allocUnsafe(size - this.cursor);
    let got = 0;
    while (got < chunk.length) { const n = readSync(this.fd, chunk, got, chunk.length - got, this.cursor + got); if (n === 0) break; got += n; }
    this.pending = Buffer.alloc(0);                                       // never reuse bytes read by an earlier poll
    const out = this.ingest(chunk.subarray(0, got));
    if (!this.error) this.errorPolls = 0;
    else if (++this.errorPolls >= this.maxErrorPolls && this.cursor > 0) this.restartNext = 'no-frame-at-cursor';
    return out;
  }
  // Append bytes that follow cursor+pending and return the frames they complete (selftest.mjs feeds chunks here).
  // Stops at the first frame that fails to walk or decode; frames before it are returned and the cursor stays on it.
  ingest(chunk) {
    if (chunk.length) this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out = [];
    let off = 0;
    this.error = null;
    try {
      for (let f; (f = parseFrame(this.pending, off)) !== null; off = f.end) {
        const rec = { start: this.cursor + f.start, end: this.cursor + f.end, skippable: f.skippable, lines: [] };
        if (!f.skippable) rec.lines = zstdDecompressSync(this.pending.subarray(f.start, f.end)).toString('utf8').split('\n').filter((l) => l.length > 0);  // verifies checksum
        out.push(rec);
      }
    } catch (e) { this.error = { at: this.cursor + off, message: String(e?.message ?? e).slice(0, 120) }; }
    this.pending = this.pending.subarray(off);
    this.cursor += off;
    return out;
  }
  close() { if (this.fd !== null) closeSync(this.fd); }
}

export function typeOf(line) {
  try { const v = JSON.parse(line); return typeof v?.type === 'string' ? v.type : (v && typeof v === 'object' && 'version' in v ? '<header>' : '<no-type>'); }
  catch { return '<unparsable>'; }
}

// ---- CLI ---------------------------------------------------------------------------------------
if (import.meta.main) {
  const [mode, file, ...rest] = process.argv.slice(2);
  if (!file || !['scan', 'follow'].includes(mode)) { console.error('usage: node frame-tail.mjs scan|follow <file> [--interval ms]'); process.exit(2); }
  if (mode === 'scan') {
    const t = new FrameTail(file);
    const t0 = performance.now();
    const frames = t.poll();
    const ms = performance.now() - t0;
    const sizes = frames.map((f) => f.end - f.start).sort((a, b) => a - b);
    const types = {};
    let lines = 0;
    for (const f of frames) for (const l of f.lines) { lines++; const k = typeOf(l); types[k] = (types[k] ?? 0) + 1; }
    console.log(JSON.stringify({ bytes: t.size(), frames: frames.length, cursor: t.cursor, tailPendingBytes: t.size() - t.cursor,
      frameBytes: { min: sizes[0], median: sizes[sizes.length >> 1], max: sizes.at(-1) }, lines, types, ms: +ms.toFixed(2) }));
    t.close();
  } else {
    const i = rest.indexOf('--interval');
    const interval = i >= 0 ? Number(rest[i + 1]) : 250;
    const t = new FrameTail(file);
    const tick = () => {
      const frames = t.poll();
      if (t.reset) console.log(JSON.stringify({ t: Date.now(), reset: t.resetReason }));
      if (t.error) console.log(JSON.stringify({ t: Date.now(), error: t.error, errorPolls: t.errorPolls }));
      for (const f of frames) {
        const types = {};
        for (const l of f.lines) { const k = typeOf(l); types[k] = (types[k] ?? 0) + 1; }
        console.log(JSON.stringify({ t: Date.now(), offset: f.start, bytes: f.end - f.start, lines: f.lines.length, types }));
      }
    };
    tick();
    setInterval(tick, interval);
  }
}
