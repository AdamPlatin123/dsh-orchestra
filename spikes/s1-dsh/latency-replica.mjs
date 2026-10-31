// latency-replica.mjs — S1-DSH: event -> decodable-frame latency against a faithful replica of the
// DSH 0.2.1-rc.2 write path (dsh-session-persistence-jsonl/lib/index.js):
//   enqueueLive(): buffer event, arm setTimeout(200) if idle                     (lines 187-194)
//   drainBuffered(): splice whole buffer -> one batch                             (lines 205-221)
//   encodeEventBatch(): lines + "\n" -> zstdCompress({checksumFlag:1})           (lines 1296, 1374-1376, 3279-3282)
//   appendLines(): open(path,'a') -> stat -> writeFile -> sync -> close           (lines 3299-3326)
// Synthetic events only (random text) in a scratch file. Writer and reader are separate processes:
//   writer:  <node>  latency-replica.mjs --writer <log> <seconds>      (needs write access; any Node >= 23.8)
//   reader:  <node24> latency-replica.mjs --reader <log> <seconds>     (read-only; prints JSON summary)
// The writer also appends one line per batch to <log>.batches.jsonl so the reader can split the latency
// into "DSH side" (first event time -> fsync done) and "tail side" (fsync done -> decoded).
import { open } from 'node:fs/promises';
import { writeFileSync, watch, existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress, constants, zstdCompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const [role, logPath, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 60);
const batchLog = `${logPath}.batches.jsonl`;
if (!['--writer', '--reader'].includes(role) || !logPath) { console.error('usage: latency-replica.mjs --writer|--reader <log> [seconds]'); process.exit(2); }

if (role === '--writer') {
  const compress = promisify(zstdCompress);
  const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  let seq = 0, buffered = [], timer, chain = Promise.resolve();
  const appendLines = async (events) => {
    const ph = { start: Date.now() };                                            // phase timestamps (ms epoch)
    const content = await compress(events.map((e) => JSON.stringify(e)).join('\n') + '\n', CHECKSUM);
    ph.compressed = Date.now();
    const h = await open(logPath, 'a');
    ph.opened = Date.now();
    try { await h.stat(); await h.writeFile(content); ph.written = Date.now(); await h.sync(); ph.synced = Date.now(); } finally { await h.close(); }
    const durableAt = Date.now();
    appendFileSync(batchLog, JSON.stringify({ n: events.length, firstSeq: events[0].seq, firstTime: events[0].time, durableAt, bytes: content.length,
      phases: { waitToStart: ph.start - events[0].time, compress: ph.compressed - ph.start, open: ph.opened - ph.compressed, statWrite: ph.written - ph.opened, fsync: ph.synced - ph.written, close: durableAt - ph.synced } }) + '\n');
  };
  const drain = () => { if (timer) { clearTimeout(timer); timer = undefined; }
    chain = chain.then(async () => { while (buffered.length) await appendLines(buffered.splice(0)); }); return chain; };
  const enqueueLive = (ev) => { buffered.push(ev); if (timer !== undefined) return; timer = setTimeout(() => { timer = undefined; drain(); }, 200); };
  const text = (n) => { let s = ''; while (s.length < n) s += 'lorem ipsum dolor sit amet ' + randomBytes(8).toString('hex') + ' '; return s.slice(0, n); };
  const types = ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'job/registered'];
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(batchLog, '');
  writeFileSync(logPath, zstdCompressSync(JSON.stringify({ type: 'session', version: 4, id: 'replica', createdAt: Date.now() }) + '\n', CHECKSUM));
  const end = Date.now() + seconds * 1000;
  const emit = () => {
    if (Date.now() > end) { drain().then(() => { appendFileSync(batchLog, JSON.stringify({ done: true, pid: process.pid }) + '\n'); process.exit(0); }); return; }
    const burst = Math.random() < 0.4 ? 1 + Math.floor(Math.random() * 3) : 1;   // 1-3 events in one tick
    for (let i = 0; i < burst; i++) {
      const big = Math.random() < 0.05;                                          // ~5% large assistant/tool payloads
      enqueueLive({ type: types[seq % types.length], seq: seq++, time: Date.now(), data: { text: text(big ? 60000 : 100 + Math.floor(Math.random() * 3000)) } });
    }
    setTimeout(emit, Math.min(5000, -Math.log(1 - Math.random()) * 700));      // exponential gaps, mean 700 ms
  };
  emit();
} else {
  const { FrameTail } = await import('./frame-tail.mjs');
  const deadline = Date.now() + (seconds + 30) * 1000;
  while (!existsSync(logPath) || !existsSync(batchLog)) { if (Date.now() > deadline) { console.error('writer never started'); process.exit(1); } await new Promise((r) => setTimeout(r, 5)); }
  const intervals = [100, 250, 500, 1000];
  const readers = intervals.map((ms) => ({ name: `fstat-poll-${ms}ms`, ms, tail: new FrameTail(logPath), lat: [], tailSide: [], frames: 0 }));
  const watchReader = { name: 'fs.watch-only', tail: new FrameTail(logPath), lat: [], tailSide: [], frames: 0, watchEvents: 0 };
  const durable = new Map();                                                     // firstSeq -> durableAt (read lazily)
  const consume = (r) => {
    const now = Date.now();
    for (const f of r.tail.poll()) {
      r.frames++;
      let first = null;
      for (const l of f.lines) { const v = JSON.parse(l); if (v.type === 'session') continue; r.lat.push(now - v.time); first ??= v.seq; }
      if (first !== null) r.pendingTail = [...(r.pendingTail ?? []), [first, now]];
    }
  };
  const timers = readers.map((r) => setInterval(() => consume(r), r.ms));
  const w = watch(logPath, () => { watchReader.watchEvents++; consume(watchReader); });
  const doneWriting = () => { try { return readFileSync(batchLog, 'utf8').includes('"done":true'); } catch { return false; } };
  while (!doneWriting() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1200));                                 // let 1000 ms poller catch the tail
  for (const r of readers) consume(r);
  const watchMissedAtEnd = (() => { const before = watchReader.lat.length; consume(watchReader); return watchReader.lat.length - before; })();
  timers.forEach(clearInterval); w.close();
  const lines = readFileSync(batchLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const batches = lines.filter((b) => !b.done), writerPid = lines.find((b) => b.done)?.pid;
  for (const b of batches) durable.set(b.firstSeq, b.durableAt);
  const pct = (a, p) => a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
  const d = (a) => { a = [...a].sort((x, y) => x - y); return { n: a.length, min: a[0], p50: pct(a, 50), p90: pct(a, 90), p99: pct(a, 99), max: a.at(-1), over2000: a.filter((x) => x > 2000).length }; };
  const out = { node: process.version, seconds, readerPid: process.pid, writerPid,
    dshSide_firstEventToFsyncDone_ms: d(batches.map((b) => b.durableAt - b.firstTime)),
    dshSidePhases_ms: Object.fromEntries(['waitToStart', 'compress', 'open', 'statWrite', 'fsync', 'close'].map((k) => [k, d(batches.map((b) => b.phases[k]))])),
    batches: batches.length, eventsPerBatch: d(batches.map((b) => b.n)), frameBytes: d(batches.map((b) => b.bytes)), readers: {} };
  for (const r of [...readers, watchReader]) {
    const tailSide = (r.pendingTail ?? []).map(([s, t]) => t - durable.get(s)).filter((x) => Number.isFinite(x));
    out.readers[r.name] = { frames: r.frames, eventToDecoded_ms: d(r.lat), fsyncDoneToDecoded_ms: d(tailSide), ...(r.watchEvents !== undefined ? { watchEvents: r.watchEvents, eventsOnlySeenByFinalSweep: watchMissedAtEnd } : {}) };
    r.tail.close();
  }
  console.log(JSON.stringify(out, null, 1));
}
