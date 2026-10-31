// Metadata-only evidence for "when were the .zst rollouts written?" (no file is opened, only stat/readdir).
//  1. day-folder mtimes (YYYY/MM/DD): a folder's mtime changes when an entry is created/renamed/deleted in it,
//     so many folders sharing one minute = a batch rewrite of the files inside.
//  2. file mtime minus the time in the file name, assuming the name is local time at offset --name-offset (hours).
// Usage: node24 meta-times.mjs [sessionsRoot] [--name-offset 8]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const root = argv.find((a) => !a.startsWith('--') && isNaN(Number(a))) ?? path.join(process.env.USERPROFILE, '.codex', 'sessions');
const oi = argv.indexOf('--name-offset');
const nameOffsetH = oi >= 0 ? Number(argv[oi + 1]) : 8;

const minute = (ms) => new Date(ms).toISOString().slice(0, 16);
const q = (a, x) => a[Math.floor((a.length - 1) * x)];
const dayDirs = [];
for (const y of fs.readdirSync(root)) for (const m of fs.readdirSync(path.join(root, y))) for (const d of fs.readdirSync(path.join(root, y, m))) {
  const p = path.join(root, y, m, d);
  if (fs.statSync(p).isDirectory()) dayDirs.push(p);
}
const clusters = {};
const diffsH = [];
for (const d of dayDirs) {
  const dm = minute(fs.statSync(d).mtimeMs);
  const c = (clusters[dm] ??= { dirs: 0, files: 0, fileMtimeMin: null, fileMtimeMax: null, ext: {} });
  c.dirs++;
  for (const f of fs.readdirSync(d)) {
    const st = fs.statSync(path.join(d, f));
    c.files++;
    const e = f.endsWith('.jsonl.zst') ? 'jsonl.zst' : f.endsWith('.jsonl') ? 'jsonl' : path.extname(f);
    c.ext[e] = (c.ext[e] || 0) + 1;
    const fm = st.mtime.toISOString().slice(0, 16);
    if (!c.fileMtimeMin || fm < c.fileMtimeMin) c.fileMtimeMin = fm;
    if (!c.fileMtimeMax || fm > c.fileMtimeMax) c.fileMtimeMax = fm;
    const mt = f.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (mt && e === 'jsonl.zst') {
      const nameUtc = Date.UTC(+mt[1], +mt[2] - 1, +mt[3], +mt[4], +mt[5], +mt[6]) - nameOffsetH * 3600e3;
      diffsH.push((st.mtimeMs - nameUtc) / 3600e3);
    }
  }
}
diffsH.sort((a, b) => a - b);
const r1 = (x) => Math.round(x * 100) / 100;
console.log(JSON.stringify({
  root, dayDirs: dayDirs.length,
  dayDirMtimeClusters: Object.fromEntries(Object.entries(clusters).sort((a, b) => b[1].dirs - a[1].dirs)),
  zstMtimeMinusNameHours: { assumedNameOffsetH: nameOffsetH, n: diffsH.length, min: r1(diffsH[0]), p10: r1(q(diffsH, 0.1)), median: r1(q(diffsH, 0.5)), p90: r1(q(diffsH, 0.9)), max: r1(diffsH.at(-1)),
    negative: diffsH.filter((x) => x < 0).length, within0to6h: diffsH.filter((x) => x >= 0 && x <= 6).length, over24h: diffsH.filter((x) => x > 24).length },
}, null, 1));
