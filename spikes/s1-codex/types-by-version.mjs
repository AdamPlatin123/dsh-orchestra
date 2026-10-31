// Which record kinds (`type` / `payload.type`) appear in rollouts of which cli_version?
// Answers review finding S1-CODEX-04 ("are the 0.165.0 record kinds really new?") and feeds the golden-fixture list.
// Read-only. Prints only version strings, type values and counts; never record text.
//
// Usage: node24 types-by-version.mjs <sessionsRoot> [--versions <regex>]   (default regex: .  = all files)
//   Handles .jsonl.zst (streaming zstd decode) and plain .jsonl. A file whose session_meta version does not match
//   the regex is abandoned after its first line.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const root = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--versions') ?? path.join(process.env.USERPROFILE, '.codex', 'sessions');
const vi = argv.indexOf('--versions');
const want = new RegExp(vi >= 0 ? argv[vi + 1] : '.');

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) files.push(p); } };
walk(root);

const byVer = {};
function scanFile(p) {
  return new Promise((resolve) => {
    const fd = fs.openSync(p, 'r');
    const zst = p.endsWith('.zst');
    const dec = zst ? zlib.createZstdDecompress() : null;
    let carry = [], ver, stop = false, pos = 0, lines = 0;
    const kinds = {};
    const done = () => { if (stop === 'done') return; stop = 'done'; fs.closeSync(fd); dec?.destroy();
      if (ver !== undefined && want.test(ver)) { const v = (byVer[ver] ??= { files: 0, lines: 0, kinds: {} }); v.files++; v.lines += lines;
        for (const [k, c] of Object.entries(kinds)) v.kinds[k] = (v.kinds[k] || 0) + c; }
      resolve(); };
    const onBytes = (c) => {
      let s = 0;
      for (let i = c.indexOf(10); i !== -1 && !stop; i = c.indexOf(10, s)) {
        carry.push(c.subarray(s, i)); s = i + 1;
        let o; try { o = JSON.parse(Buffer.concat(carry).toString('utf8')); } catch { o = { type: '<unparsable>' }; }
        carry = []; lines++;
        if (ver === undefined) { ver = o.type === 'session_meta' ? String(o.payload?.cli_version ?? '<none>') : '<no-meta>'; if (!want.test(ver)) { stop = true; return; } }
        const k = `${o.type ?? null}/${o.payload?.type ?? null}`; kinds[k] = (kinds[k] || 0) + 1;
      }
      if (s < c.length) carry.push(c.subarray(s));
    };
    if (dec) { dec.on('data', (c) => { if (!stop) onBytes(c); }); dec.on('error', () => done()); dec.on('end', done); }
    const pump = () => {
      if (stop) return done();
      const b = Buffer.allocUnsafe(1 << 20);
      const n = fs.readSync(fd, b, 0, b.length, pos); pos += n;
      if (n === 0) return dec ? dec.end() : done();
      if (dec) { if (dec.write(b.subarray(0, n))) setImmediate(pump); else dec.once('drain', pump); }
      else { onBytes(b.subarray(0, n)); setImmediate(pump); }
    };
    pump();
  });
}

const t0 = Date.now();
for (const p of files) await scanFile(p);
// For every kind: the versions it appears in (sorted as strings, good enough to read).
const kindVers = {};
for (const [v, d] of Object.entries(byVer)) for (const k of Object.keys(d.kinds)) (kindVers[k] ??= []).push(v);
console.log(JSON.stringify({ root, versionRegex: want.source, filesSeen: files.length, ms: Date.now() - t0,
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  versions: Object.fromEntries(Object.entries(byVer).sort()), kindVersions: Object.fromEntries(Object.entries(kindVers).sort().map(([k, v]) => [k, v.sort()])) }, null, 1));
