// watch-vs-fstat.mjs — S1-DSH: how fast does each observer notice that a file grew, while another
// process appends to it? Checks the spec line "Windows 上被占用文件的目录项更新可能滞后" (r4 §13.2).
//   writer: <node>   watch-vs-fstat.mjs --writer <file> <mode> [seconds=30] [delayMs=3000]
//           mode = held        open once, append, never close until the end (no fsync)
//                  held-fsync  same, fsync after every append
//                  reopen      open 'a' -> write -> close per append (DSH's pattern, minus fsync)
//   reader: <node24> watch-vs-fstat.mjs --reader <file> [seconds=30]   -> JSON summary
// Each appended line is {"i":n,"t":<Date.now() just before the write>} padded to ~200 B. Synthetic data only.
// Observers in the reader: fstat on a held read-only fd (50 ms), stat(path) (50 ms), fs.watchFile (50 ms),
// fs.watch(file), fs.watch(dir), and a PowerShell child that reads the size from the *directory entry*
// (DirectoryInfo.GetFiles -> FindFirstFile data) every ~100 ms.
import { openSync, fstatSync, statSync, readSync, closeSync, existsSync, watch, watchFile, unwatchFile, writeSync, fsyncSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const [role, file, a3, a4, a5] = process.argv.slice(2);
if (role === '--writer') {
  const mode = a3, seconds = Number(a4 ?? 30), delay = Number(a5 ?? 3000);
  mkdirSync(dirname(file), { recursive: true });
  await new Promise((r) => setTimeout(r, delay));
  let fd = mode.startsWith('held') ? openSync(file, 'a') : null;
  if (!fd) closeSync(openSync(file, 'a'));
  const end = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < end) {
    const line = JSON.stringify({ i: i++, t: Date.now(), pad: 'x'.repeat(170) }) + '\n';
    if (mode === 'reopen') { const h = openSync(file, 'a'); writeSync(h, line); closeSync(h); }
    else { writeSync(fd, line); if (mode === 'held-fsync') fsyncSync(fd); }
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 500));
  }
  if (fd) closeSync(fd);
  console.error(JSON.stringify({ writerPid: process.pid, mode, lines: i }));
} else if (role === '--reader') {
  const seconds = Number(a3 ?? 30);
  const dir = dirname(file), name = basename(file);
  // PowerShell sampler: directory-entry size, independent of any open handle (read-only).
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$d=[IO.DirectoryInfo]::new('${dir.replace(/'/g, "''")}'); while($true){ $f=$d.GetFiles('${name}'); $s= if($f.Count){$f[0].Length}else{-1}; [Console]::Out.WriteLine("$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) $s"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100 }`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const enumSamples = [];
  let psBuf = '';
  ps.stdout.on('data', (c) => { psBuf += c; let k; while ((k = psBuf.indexOf('\n')) >= 0) { const [t, s] = psBuf.slice(0, k).trim().split(' ').map(Number); psBuf = psBuf.slice(k + 1); if (Number.isFinite(t)) enumSamples.push([t, s]); } });
  const deadline = Date.now() + (seconds + 30) * 1000;
  while (!existsSync(file)) { if (Date.now() > deadline) { console.error('no writer'); ps.kill(); process.exit(1); } await new Promise((r) => setTimeout(r, 5)); }
  const fd = openSync(file, 'r');
  // line index: end offset -> write time, learned by reading through our own fd
  let known = 0, carry = '';
  const ends = [], times = [];
  const learn = (size) => {
    if (size <= known) return;
    const b = Buffer.alloc(size - known); const n = readSync(fd, b, 0, b.length, known);
    let s = carry + b.subarray(0, n).toString('utf8'), base = known - Buffer.byteLength(carry);
    known += n;
    let k;
    while ((k = s.indexOf('\n')) >= 0) { const line = s.slice(0, k + 1); base += Buffer.byteLength(line); ends.push(base); times.push(JSON.parse(line).t); s = s.slice(k + 1); }
    carry = s;
  };
  const seen = {};                                                    // observer -> Map(lineIdx -> detectTime)
  const observe = (who, size, t = Date.now()) => {
    learn(size);
    const m = (seen[who] ??= new Map());
    for (let j = 0; j < ends.length && ends[j] <= size; j++) if (!m.has(j)) m.set(j, t);
  };
  const timers = [
    setInterval(() => observe('fstat(held fd) 50ms', fstatSync(fd).size), 50),
    setInterval(() => { try { observe('stat(path) 50ms', statSync(file).size); } catch {} }, 50),
  ];
  watchFile(file, { interval: 50 }, (cur) => observe('fs.watchFile 50ms', cur.size));
  const counts = { 'fs.watch(file)': 0, 'fs.watch(dir)': 0 };
  const w1 = watch(file, () => { counts['fs.watch(file)']++; observe('fs.watch(file)', fstatSync(fd).size); });
  const w2 = watch(dir, (ev, fn) => { if (fn === name) { counts['fs.watch(dir)']++; observe('fs.watch(dir)', fstatSync(fd).size); } });
  await new Promise((r) => setTimeout(r, (seconds + 6) * 1000));
  const finalSize = fstatSync(fd).size; learn(finalSize);
  timers.forEach(clearInterval); unwatchFile(file); w1.close(); w2.close();
  ps.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const [t, s] of enumSamples) if (s >= 0) observe('dir-entry size (FindFirstFile) ~100ms', s, t);
  const pct = (a, p) => a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
  const out = { node: process.version, readerPid: process.pid, powershellPid: ps.pid, lines: ends.length, finalSize, enumSamples: enumSamples.length, watchCallbacks: counts, observers: {} };
  for (const [who, m] of Object.entries(seen)) {
    const lat = []; let missed = 0;
    for (let j = 0; j < ends.length; j++) { if (m.has(j)) lat.push(m.get(j) - times[j]); else missed++; }
    lat.sort((x, y) => x - y);
    out.observers[who] = { detected: lat.length, neverSeen: missed, p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: lat.at(-1), over1000: lat.filter((x) => x > 1000).length };
  }
  for (const who of ['fs.watch(file)', 'fs.watch(dir)']) if (!seen[who]) out.observers[who] = { detected: 0, neverSeen: ends.length };
  closeSync(fd);
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
