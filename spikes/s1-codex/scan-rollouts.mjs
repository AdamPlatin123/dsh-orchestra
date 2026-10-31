// Item 1: verify "one zstd frame per rollout", checksum, windowLog, max size, files per year-month.
// Usage: node24 scan-rollouts.mjs <sessionsRoot> - > scan-rollouts.json   (summary on stderr)
// Read-only. Prints only counts/sizes/offsets/version strings, never conversation text.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { walkFile } from './zstd-frames.mjs';

const [root = path.join(process.env.USERPROFILE, '.codex', 'sessions'), out] = process.argv.slice(2);

function listFiles(dir) {
  const res = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...listFiles(p)); else res.push(p);
  }
  return res;
}

// Decode only until the first '\n' and return the first record's type + version metadata.
function firstRecordMeta(p) {
  return new Promise((resolve) => {
    const fd = fs.openSync(p, 'r');
    const dec = zlib.createZstdDecompress();
    const parts = []; let len = 0, done = false, pos = 0;
    const finish = (v) => { if (done) return; done = true; fs.closeSync(fd); dec.destroy(); resolve(v); };
    dec.on('data', (c) => {
      const i = c.indexOf(0x0a);
      if (i < 0) { parts.push(c); len += c.length; if (len > 64 << 20) finish({ err: 'first line > 64MiB' }); return; }
      parts.push(c.subarray(0, i));
      try {
        const o = JSON.parse(Buffer.concat(parts).toString('utf8'));
        finish({ type: o.type, cli_version: o.payload?.cli_version ?? null, originator: o.payload?.originator ?? null, firstLineBytes: len + i });
      } catch (e) { finish({ err: 'parse' }); }
    });
    dec.on('error', () => finish({ err: 'decode' }));
    const pump = () => {
      if (done) return;
      const b = Buffer.allocUnsafe(256 * 1024);
      const n = fs.readSync(fd, b, 0, b.length, pos);
      if (n === 0) { dec.end(); return; }
      pos += n; dec.write(b.subarray(0, n), pump);
    };
    pump();
  });
}

const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], median: s[Math.floor((s.length - 1) / 2)], p90: s[Math.floor((s.length - 1) * 0.9)], max: s[s.length - 1] }; };
const count = (a) => a.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});

// Plain (uncompressed) rollouts: codex-cli 0.165.0 writes live sessions as rollout-*.jsonl (found 2026-10-29).
// Read only the first line, report only type / cli_version / originator / sizes.
function plainFirstMeta(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const parts = []; let pos = 0;
    for (;;) {
      const b = Buffer.allocUnsafe(256 * 1024); const n = fs.readSync(fd, b, 0, b.length, pos);
      if (n === 0) return { err: 'no newline' };
      const i = b.subarray(0, n).indexOf(0x0a);
      if (i >= 0) { parts.push(b.subarray(0, i)); break; }
      parts.push(b.subarray(0, n)); pos += n; if (pos > 64 << 20) return { err: 'first line > 64MiB' };
    }
    const line = Buffer.concat(parts); const o = JSON.parse(line.toString('utf8'));
    return { type: o.type, cli_version: o.payload?.cli_version ?? null, originator: o.payload?.originator ?? null, firstLineBytes: line.length };
  } catch { return { err: 'parse' }; } finally { fs.closeSync(fd); }
}

const t0 = performance.now();
const allFiles = listFiles(root).sort();
const ext = (p) => (p.endsWith('.jsonl.zst') ? 'jsonl.zst' : p.endsWith('.jsonl') ? 'jsonl' : path.extname(p) || '<none>');
const byExtension = count(allFiles.map(ext));
const plainRollouts = allFiles.filter((p) => ext(p) === 'jsonl').map((p) => {
  const st = fs.statSync(p);
  return { rel: path.relative(root, p).replaceAll('\\', '/'), size: st.size, mtime: st.mtime.toISOString(), birthtime: st.birthtime.toISOString(), ...plainFirstMeta(p) };
});
const files = allFiles.filter((p) => p.endsWith('.zst'));
const rows = [];
for (const p of files) {
  const rel = path.relative(root, p).replaceAll('\\', '/');
  const w = walkFile(p);
  const z = w.frames.filter((f) => f.kind === 'zstd');
  const meta = await firstRecordMeta(p);
  rows.push({
    rel, ym: rel.slice(0, 7), size: w.size, frames: w.frames.length, zstdFrames: z.length,
    skippable: w.frames.length - z.length, trailingBytes: w.trailingBytes, incomplete: w.incomplete, error: w.error,
    checksum: z.map((f) => f.checksum), windowLog: z.map((f) => f.windowLog), single: z.map((f) => f.single),
    fcsPresent: z.map((f) => f.fcs !== null), fcs: z.map((f) => f.fcs), dictId: z.map((f) => f.dictId),
    nBlocks: z.reduce((s, f) => s + f.nBlocks, 0), blockTypes: z[0]?.blockTypes, maxBlockBytes: Math.max(0, ...z.map((f) => f.maxBlockBytes)),
    firstType: meta.type ?? null, cli_version: meta.cli_version ?? null, originator: meta.originator ?? null, metaErr: meta.err ?? null,
  });
}
const ms = performance.now() - t0;
const summary = {
  root, byExtension, plainRollouts, files: rows.length, totalBytes: rows.reduce((s, r) => s + r.size, 0), scanMs: Math.round(ms),
  byYearMonth: count(rows.map((r) => r.ym)),
  framesPerFile: count(rows.map((r) => r.frames)),
  filesWithSkippable: rows.filter((r) => r.skippable).length,
  filesIncompleteOrTrailing: rows.filter((r) => r.incomplete || r.trailingBytes || r.error).map((r) => r.rel),
  checksumAll: rows.every((r) => r.checksum.every(Boolean)), checksumCount: count(rows.flatMap((r) => r.checksum.map(String))),
  windowLog: count(rows.flatMap((r) => r.windowLog.map(String))),
  singleSegment: count(rows.flatMap((r) => r.single.map(String))),
  fcsPresent: count(rows.flatMap((r) => r.fcsPresent.map(String))),
  dictId: count(rows.flatMap((r) => r.dictId.map(String))),
  size: stats(rows.map((r) => r.size)),
  largest: rows.reduce((a, r) => (r.size > a.size ? r : a)),
  blocksPerFile: stats(rows.map((r) => r.nBlocks)),
  maxBlockBytes: stats(rows.map((r) => r.maxBlockBytes)),
  firstType: count(rows.map((r) => String(r.firstType))),
  cliVersions: count(rows.map((r) => String(r.cli_version))),
  originators: count(rows.map((r) => String(r.originator))),
  metaErrors: rows.filter((r) => r.metaErr).length,
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
};
const { largest, ...printable } = summary;
// Summary -> stderr; full per-file JSON -> stdout (redirect it; this sandbox forbids node from creating files).
console.error(JSON.stringify({ ...printable, largest: { rel: largest.rel, size: largest.size, fcs: largest.fcs, nBlocks: largest.nBlocks, windowLog: largest.windowLog, cli_version: largest.cli_version } }, null, 1));
if (out === '-') process.stdout.write(JSON.stringify({ summary, rows }, null, 1) + '\n');
