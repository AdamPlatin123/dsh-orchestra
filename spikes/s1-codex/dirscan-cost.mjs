// Cost of finding new rollout files by scanning the sessions tree (the body of one stream-tail.mjs --dir poll),
// versus scanning only today's and yesterday's day folders. Metadata only (readdir); no file is opened.
// Usage: node24 dirscan-cost.mjs [sessionsRoot] [--runs 20]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const root = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--runs') ?? path.join(process.env.USERPROFILE, '.codex', 'sessions');
const ri = argv.indexOf('--runs');
const RUNS = ri >= 0 ? Number(argv[ri + 1]) : 20;

function fullTree() { // same walk as stream-tail.mjs listRollouts
  const out = [];
  const walk = (d, depth) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile() && e.name.startsWith('rollout-')) out.push(p); } };
  walk(root, 0); return out;
}
function recentDays() { // local-date folders for today and yesterday (Codex names folders by the writer's local date)
  const out = [];
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 864e5);
    const p = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let es; try { es = fs.readdirSync(p); } catch { continue; }
    for (const n of es) if (n.startsWith('rollout-')) out.push(path.join(p, n));
  }
  return out;
}
const time = (fn) => { const ms = []; let n = 0; for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); n = fn().length; ms.push(Number(process.hrtime.bigint() - t) / 1e6); }
  ms.sort((a, b) => a - b); const r = (x) => Math.round(x * 10) / 10; return { files: n, runs: RUNS, msMin: r(ms[0]), msMedian: r(ms[Math.floor((RUNS - 1) / 2)]), msMax: r(ms.at(-1)) }; };
let dayDirs = 0; for (const y of fs.readdirSync(root)) for (const m of fs.readdirSync(path.join(root, y))) dayDirs += fs.readdirSync(path.join(root, y, m)).length;
console.log(JSON.stringify({ root, dayDirs, fullTree: time(fullTree), todayAndYesterday: time(recentDays) }));
