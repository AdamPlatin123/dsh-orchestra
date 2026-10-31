// Timeline of a PLAIN (live-written) Codex rollout, using only timestamps that the records carry.
// Answers review finding S1-CODEX-01: the top-level `timestamp` of a record is stamped when Codex writes the
// line, so "read time - timestamp" only measures write->read. To see whether Codex holds records back before
// writing them, compare the write stamp with event times inside the payload (thread creation, turn start,
// item completion).
//
// Read-only (fs.openSync(p, 'r')). Prints only: line number, byte offsets, sizes, `type`, `payload.type`,
// timestamps and the NAMES of the payload time keys. Never any record text.
//
// Usage: node24 live-timeline.mjs <rollout-*.jsonl> [tail-events.jsonl]
//   tail-events.jsonl (optional) = stream-tail.mjs output; adds the moment each line was read.
import fs from 'node:fs';

const [file, tailOut] = process.argv.slice(2);
const TIME_KEYS = /^(timestamp|started_at|started_at_ms|completed_at|completed_at_ms|created_at|ended_at|updated_at)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const toMs = (v) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : null);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

const fd = fs.openSync(file, 'r');
const st = fs.fstatSync(fd);
const buf = Buffer.allocUnsafe(st.size);
fs.readSync(fd, buf, 0, st.size, 0);
fs.closeSync(fd);

const readAt = new Map(); // line number -> ms the tail emitted it
if (tailOut) for (const l of fs.readFileSync(tailOut, 'utf8').split('\n')) {
  if (!l.trim()) continue; const e = JSON.parse(l); if (e.ev === 'line') readAt.set(e.n, e.t);
}

const lines = [];
let start = 0, n = 0;
for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
  n++;
  const o = JSON.parse(buf.subarray(start, i).toString('utf8'));
  const pt = {};
  if (o.payload && typeof o.payload === 'object') for (const [k, v] of Object.entries(o.payload)) {
    if (TIME_KEYS.test(k) && toMs(v) != null) pt[k] = iso(toMs(v));
  }
  const wrote = Date.parse(o.timestamp);
  lines.push({ n, from: start, to: i + 1, bytes: i - start, type: o.type ?? null, ptype: o.payload?.type ?? null,
    wrote: o.timestamp ?? null, payloadTimes: pt, readAt: iso(readAt.get(n) ?? null),
    writeToReadMs: readAt.has(n) ? readAt.get(n) - wrote : null });
  start = i + 1;
}

// Derived gaps (all ms). Thread creation = session_meta.payload.timestamp; turn start = task_started.started_at.
const meta = lines.find((l) => l.type === 'session_meta');
const turn = lines.find((l) => l.ptype === 'task_started');
const threadCreated = toMs(meta?.payloadTimes.timestamp);
const turnStarted = toMs(turn?.payloadTimes.started_at);
const firstWrite = Date.parse(lines[0]?.wrote);
const gaps = {
  threadCreatedToFileBirthMs: threadCreated != null ? Math.round(st.birthtimeMs - threadCreated) : null,
  threadCreatedToFirstWriteMs: threadCreated != null ? firstWrite - threadCreated : null,
  threadCreatedToFirstReadMs: threadCreated != null && readAt.has(1) ? readAt.get(1) - threadCreated : null,
  turnStartedResolution: turn ? (Number.isInteger(turnStarted / 1000) ? 'whole seconds (+0..999 ms)' : 'ms') : null,
  turnStartedToEachWriteMs: turnStarted != null ? lines.map((l) => ({ n: l.n, type: l.type, ptype: l.ptype, ms: Date.parse(l.wrote) - turnStarted })) : null,
  itemCompletedVsWriteMs: lines.filter((l) => l.payloadTimes.completed_at_ms || l.payloadTimes.completed_at)
    .map((l) => ({ n: l.n, ptype: l.ptype, ms: Date.parse(l.wrote) - toMs(l.payloadTimes.completed_at_ms ?? l.payloadTimes.completed_at) })),
};

console.log(JSON.stringify({
  file: file.split(/[\\/]/).pop(), size: st.size, birth: iso(st.birthtimeMs), mtime: iso(st.mtimeMs), lines: lines.length,
  endsOnNewline: start === st.size, threadCreated: iso(threadCreated), turnStarted: iso(turnStarted), gaps, perLine: lines,
}, null, 1));
