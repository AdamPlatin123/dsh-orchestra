// Item 2: resident streaming tail for Codex rollouts.
// One long-lived zlib.createZstdDecompress per file; an fstat poll (<= 1 s) on the open fd finds growth,
// the new bytes are fed to the decoder, complete JSONL lines come out. Plain .jsonl is tailed too
// (no decoder). Read-only: every open is fs.openSync(p, 'r'); nothing is written anywhere.
// Prints JSONL events to stdout: start / appeared / open / grow / line / replaced / vanished / frame / end.
// A `line` event carries only: line number, top-level `type`, `payload.type`, the record `timestamp`,
// writeToReadMs = observed - timestamp, and (when the payload carries its own event time) eventToReadMs.
// Never the record text.
//   The top-level `timestamp` is stamped when Codex WRITES the line, so writeToReadMs cannot see Codex holding a
//   record back before writing it (review S1-CODEX-01). eventToReadMs uses the payload's own event time instead:
//   session_meta.payload.timestamp (thread creation), payload.completed_at_ms / started_at_ms (ms), or
//   payload.completed_at / started_at (whole seconds, so up to +999 ms of rounding). Older outputs call
//   writeToReadMs `lagMs`; summarize-tail.mjs reads both.
//
// Usage:
//   node24 stream-tail.mjs --file <rollout.jsonl[.zst]> [--poll 500] [--max-ms 60000] [--from-start]
//   node24 stream-tail.mjs --dir <~/.codex/sessions> [--poll 500] [--max-ms 120000]
//     --dir: wait for rollout files that did not exist at start, then tail each of them from byte 0.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { walkFile } from './zstd-frames.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const POLL = Math.min(1000, Number(opt('--poll', 500)));
const MAX_MS = Number(opt('--max-ms', 120000));
const FILE = opt('--file'), DIR = opt('--dir');
const FROM_START = argv.includes('--from-start') || !!DIR;
const t0 = Date.now();
const emit = (o) => process.stdout.write(JSON.stringify({ t: Date.now(), dt: Date.now() - t0, ...o }) + '\n');

const tails = new Map(); // path -> state

function openTail(p, fromStart) {
  const fd = fs.openSync(p, 'r');
  const st = fs.fstatSync(fd);
  const s = { p, name: path.basename(p), fd, ino: st.ino, cursor: fromStart ? 0 : st.size, zst: p.endsWith('.zst'),
    dec: null, carry: [], lines: 0, bytesOut: 0, vanished: false, grows: 0 };
  if (s.zst) {
    s.dec = zlib.createZstdDecompress();
    s.dec.on('data', (c) => { s.bytesOut += c.length; onBytes(s, c); });
    s.dec.on('error', (e) => emit({ ev: 'decode-error', name: s.name, code: e.code || e.message }));
    if (!fromStart) emit({ ev: 'warn', msg: 'zstd tail must start at byte 0 (one frame per file); forcing from-start' }), (s.cursor = 0);
  }
  tails.set(p, s);
  emit({ ev: 'open', name: s.name, size: st.size, cursor: s.cursor, zst: s.zst, birthtimeMs: Math.round(st.birthtimeMs), mtimeMs: Math.round(st.mtimeMs) });
  return s;
}

// The record's own event time, if its payload has one: [key name, epoch ms] or [null, null].
function eventTime(o) {
  const p = o.payload;
  if (!p || typeof p !== 'object') return [null, null];
  if (o.type === 'session_meta' && typeof p.timestamp === 'string') return ['payload.timestamp', Date.parse(p.timestamp)];
  for (const k of ['completed_at_ms', 'started_at_ms']) if (typeof p[k] === 'number') return [`payload.${k}`, p[k]];
  for (const k of ['completed_at', 'started_at']) if (typeof p[k] === 'number') return [`payload.${k}`, p[k] * 1000];
  return [null, null];
}

function onBytes(s, chunk) {
  let start = 0;
  for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
    s.carry.push(chunk.subarray(start, i));
    const line = Buffer.concat(s.carry); s.carry = []; start = i + 1;
    s.lines++;
    let type = null, ptype = null, ts = null, evMs = null, evKey = null;
    try {
      const o = JSON.parse(line.toString('utf8')); type = o.type ?? null; ptype = o.payload?.type ?? null; ts = o.timestamp ?? null;
      [evKey, evMs] = eventTime(o);
    } catch { type = '<unparsable>'; }
    const now = Date.now();
    emit({ ev: 'line', name: s.name, n: s.lines, bytes: line.length, type, ptype, ts,
      writeToReadMs: ts ? now - Date.parse(ts) : null, eventKey: evKey, eventToReadMs: evMs !== null ? now - evMs : null });
  }
  if (start < chunk.length) s.carry.push(chunk.subarray(start));
}

function pollTail(s) {
  let pst = null;
  try { pst = fs.statSync(s.p); } catch { if (!s.vanished) { s.vanished = true; emit({ ev: 'vanished', name: s.name, cursor: s.cursor }); } }
  if (pst && pst.ino !== s.ino) { // replaced by rename: restart from byte 0 on the new file
    emit({ ev: 'replaced', name: s.name, oldCursor: s.cursor, newSize: pst.size });
    try { s.dec?.destroy(); fs.closeSync(s.fd); } catch {}
    tails.delete(s.p); openTail(s.p, true); return;
  }
  const { size } = fs.fstatSync(s.fd);
  if (size < s.cursor) { // truncated/rewritten in place: a single-frame zstd file can only restart at byte 0
    emit({ ev: 'shrunk', name: s.name, size, cursor: s.cursor }); s.cursor = 0; s.carry = [];
    if (s.zst) { s.dec.destroy(); s.dec = zlib.createZstdDecompress(); s.dec.on('data', (c) => { s.bytesOut += c.length; onBytes(s, c); }); }
  }
  if (size > s.cursor) {
    const b = Buffer.allocUnsafe(size - s.cursor);
    const n = fs.readSync(s.fd, b, 0, b.length, s.cursor);
    s.grows++;
    emit({ ev: 'grow', name: s.name, from: s.cursor, to: s.cursor + n });
    s.cursor += n;
    if (s.zst) {
      s.dec.write(b.subarray(0, n));
      const w = walkFile(s.p); const f = w.frames[0] ?? w.partial; // partial = header of an unfinished frame
      emit({ ev: 'frame', name: s.name, size: w.size, complete: !w.incomplete && w.frames.length > 0, frames: w.frames.length,
        fcsPresent: f ? f.fcs !== null : null, checksum: f ? f.checksum : null, windowLog: f ? f.windowLog : null,
        blocks: f ? (f.nBlocks ?? f.blocksSeen) : null });
    } else onBytes(s, b.subarray(0, n));
  }
}

// --dir mode: remember what exists now, then look for new rollout files each poll.
function listRollouts(root) {
  const out = [];
  const walk = (d, depth) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile() && e.name.startsWith('rollout-')) out.push(p); } };
  walk(root, 0); return out;
}
const known = new Set(DIR ? listRollouts(DIR) : []);

emit({ ev: 'start', pid: process.pid, poll: POLL, mode: DIR ? 'dir' : 'file', known: known.size });
if (FILE) openTail(FILE, FROM_START);

const timer = setInterval(() => {
  if (DIR) for (const p of listRollouts(DIR)) if (!known.has(p)) {
    known.add(p);
    const st = fs.statSync(p);
    emit({ ev: 'appeared', name: path.basename(p), size: st.size });
    openTail(p, true);
  }
  for (const s of [...tails.values()]) pollTail(s);
  if (Date.now() - t0 > MAX_MS) {
    clearInterval(timer);
    for (const s of tails.values()) { emit({ ev: 'end', name: s.name, cursor: s.cursor, lines: s.lines, decodedBytes: s.bytesOut, grows: s.grows, carryBytes: s.carry.reduce((a, c) => a + c.length, 0) }); try { s.dec?.destroy(); fs.closeSync(s.fd); } catch {} }
    emit({ ev: 'exit', peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) });
    setTimeout(() => process.exit(0), 50);
  }
}, POLL);
