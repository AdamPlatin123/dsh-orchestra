// projcache-lag.mjs — S1-DSH: mtime of each session_projcache row minus mtime of its v4 log (metadata only;
// neither file is opened). Shows whether the projection cache trails the log.
//   node projcache-lag.mjs [dshHome=C:/Users/Calx/.dsh]
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[2] ?? 'C:/Users/Calx/.dsh';
const root = join(home, 'sessions'), pc = join(home, 'storages', 'session_projcache', 'sessions');
const logM = new Map();
for (const p of readdirSync(root)) for (const s of readdirSync(join(root, p))) { try { logM.set(s, statSync(join(root, p, s, 'session.v4.jsonl.zstd')).mtimeMs); } catch {} }
const lags = []; let noLog = 0;
const rows = readdirSync(pc);
for (const f of rows) { const id = f.replace(/\.json$/, ''); const m = statSync(join(pc, f)).mtimeMs; if (logM.has(id)) lags.push(m - logM.get(id)); else noLog++; }
lags.sort((a, b) => a - b);
const q = (p) => Math.round(lags[Math.min(lags.length - 1, Math.ceil(p / 100 * lags.length) - 1)]);
console.log(JSON.stringify({ projcacheFiles: rows.length, matchedV4: lags.length, noV4Log: noLog,
  lagMs: { min: Math.round(lags[0]), p10: q(10), p50: q(50), p90: q(90), max: Math.round(lags.at(-1)) }, projcacheOlderThanLog: lags.filter((x) => x < 0).length }));
