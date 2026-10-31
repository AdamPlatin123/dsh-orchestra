// corpus-stats.mjs — S1-DSH: frame statistics over every DSH log under <root> (read-only).
//   node corpus-stats.mjs [root=C:\Users\Calx\.dsh\sessions] > corpus-stats.json
// Prints counts / sizes / key names / `type` values only — never event bodies or paths.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { walkFrames } from './frame-tail.mjs';

const root = process.argv[2] ?? 'C:\\Users\\Calx\\.dsh\\sessions';
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null);
const dist = (a) => { a.sort((x, y) => x - y); return { n: a.length, min: a[0] ?? null, p50: pct(a, 50), p90: pct(a, 90), p99: pct(a, 99), max: a.at(-1) ?? null }; };
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

// enumerate <root>/--<cwd>--/{<uuid>|session-<uuid>}/<name>
const logs = [];
for (const proj of readdirSync(root, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  for (const sess of readdirSync(join(root, proj.name), { withFileTypes: true })) {
    if (!sess.isDirectory()) continue;
    for (const f of readdirSync(join(root, proj.name, sess.name))) {
      if (!f.endsWith('.jsonl.zstd')) continue;                         // *.bak* and others never opened
      logs.push({ path: join(root, proj.name, sess.name, f), name: f, form: sess.name.startsWith('session-') ? 'session-<uuid>' : '<uuid>' });
    }
  }
}

const out = { root: '<DSH_HOME>/sessions', node: process.version, filesByName: {}, v4: null, legacy: {} };
for (const l of logs) bump(out.filesByName, l.name);

function analyse(list, deep) {
  const a = { files: list.length, byDirForm: {}, bytes: 0, frames: 0, skippable: 0, checksumFrames: 0, singleSegmentFrames: 0,
    windowLog: {}, blocksPerFrame: {}, framesPerFile: [], frameBytes: [], frameBytesNonHeader: [], linesPerFrameHist: {},
    headerFrameIsOneLine: 0, firstLineType: {}, types: {}, eventKeys: {}, intraFrameSpreadMs: [], interFrameGapMs: [],
    multiEventFrames: 0, framesOver64KiB: 0, maxFrameBlocks: 0, tailPendingBytes: 0, errors: 0, timing: {} };
  let walkMs = 0, decodeMs = 0, parseMs = 0;
  for (const l of list) {
    bump(a.byDirForm, l.form);
    let buf;
    try { buf = readFileSync(l.path); } catch { a.errors++; continue; }       // readFileSync opens read-only
    a.bytes += buf.length;
    let t0 = performance.now();
    let w;
    try { w = walkFrames(buf, 0); } catch { a.errors++; continue; }
    walkMs += performance.now() - t0;
    a.tailPendingBytes += buf.length - w.next;
    a.framesPerFile.push(w.frames.length);
    let prevLast = null;
    w.frames.forEach((f, i) => {
      a.frames++;
      if (f.skippable) { a.skippable++; return; }
      const size = f.end - f.start;
      a.frameBytes.push(size); if (i > 0) a.frameBytesNonHeader.push(size);
      if (size > 65536) a.framesOver64KiB++;
      if (f.checksum) a.checksumFrames++;
      if (f.single) a.singleSegmentFrames++; else bump(a.windowLog, f.windowLog);
      bump(a.blocksPerFrame, f.blocks > 9 ? '10+' : f.blocks); a.maxFrameBlocks = Math.max(a.maxFrameBlocks, f.blocks);
      if (!deep) return;
      t0 = performance.now();
      const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');          // verifies checksum
      decodeMs += performance.now() - t0;
      t0 = performance.now();
      const lines = text.split('\n').filter((x) => x.length);
      const n = lines.length;
      bump(a.linesPerFrameHist, n <= 5 ? String(n) : n <= 10 ? '6-10' : n <= 50 ? '11-50' : n <= 500 ? '51-500' : '>500');
      if (n > 1) a.multiEventFrames++;
      const times = [];
      lines.forEach((ln, j) => {
        let v; try { v = JSON.parse(ln); } catch { bump(a.types, '<unparsable>'); return; }
        const ty = typeof v.type === 'string' ? v.type : '<no-type>';
        if (i === 0 && j === 0) bump(a.firstLineType, ty);
        if (i === 0) return;                                                   // header frame keys counted separately
        bump(a.types, ty);
        for (const k of Object.keys(v)) bump(a.eventKeys, k);
        if (typeof v.time === 'number') times.push(v.time);
      });
      if (i === 0 && n === 1) a.headerFrameIsOneLine++;
      if (times.length) {
        const lo = Math.min(...times), hi = Math.max(...times);
        if (times.length > 1) a.intraFrameSpreadMs.push(hi - lo);
        if (prevLast !== null) a.interFrameGapMs.push(lo - prevLast);
        prevLast = hi;
      }
      parseMs += performance.now() - t0;
    });
  }
  a.framesPerFile = dist(a.framesPerFile); a.frameBytes = dist(a.frameBytes); a.frameBytesNonHeader = dist(a.frameBytesNonHeader);
  if (deep) {
    const big = a.intraFrameSpreadMs.filter((x) => x > 250).length;
    a.intraFrameSpreadMs = { ...dist(a.intraFrameSpreadMs), over250ms: big };
    const neg = a.interFrameGapMs.filter((x) => x < 0).length;
    a.interFrameGapMs = { ...dist(a.interFrameGapMs), negative: neg };
  } else { for (const k of ['intraFrameSpreadMs', 'interFrameGapMs', 'types', 'eventKeys', 'linesPerFrameHist', 'firstLineType', 'headerFrameIsOneLine', 'multiEventFrames']) delete a[k]; }   // not decoded in structure-only mode
  a.timing = { walkMs: +walkMs.toFixed(1), decodeMs: +decodeMs.toFixed(1), splitParseMs: +parseMs.toFixed(1) };
  return a;
}

const T0 = performance.now();
out.v4 = analyse(logs.filter((l) => l.name === 'session.v4.jsonl.zstd'), true);
out.v4.timing.totalWallMs = +(performance.now() - T0).toFixed(1);
for (const name of Object.keys(out.filesByName).filter((n) => n !== 'session.v4.jsonl.zstd')) out.legacy[name] = analyse(logs.filter((l) => l.name === name), false);
const ru = process.resourceUsage(), mu = process.memoryUsage();
out.process = { maxRssMiB: +(ru.maxRSS / 1024).toFixed(1), rssNowMiB: +(mu.rss / 2 ** 20).toFixed(1), heapUsedMiB: +(mu.heapUsed / 2 ** 20).toFixed(1), totalWallMs: +(performance.now() - T0).toFixed(1) };
console.log(JSON.stringify(out, null, 1));
