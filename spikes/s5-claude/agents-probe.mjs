// S5 step 3: time `claude agents --json` N times, list element keys / enum values,
// and check whether the call itself writes into the config root (stat-only diff).
// Prints counts, key names and enum values only (no cwd, no names).
// Each call is spawned directly (no shell) and its PID is recorded in the evidence file.
// NOTE: `claude agents --json` itself writes into the config root (.claude.json, daemon/pipe.key) and may delete
// stale sessions/<pid>.json files; running this probe breaks the zero-write boundary. Not re-run after 2026-10-29.
// usage: node agents-probe.mjs [--runs 5] [--cwd <empty dir>] [--claude <claude.exe>] [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt('--runs', '5'));
const cwd = opt('--cwd', process.cwd());
const outFile = opt('--out', null);
const claudeExe = opt('--claude', 'C:/Users/Calx/.local/bin/claude.exe');
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const root = process.env.CLAUDE_CONFIG_DIR;
const SKIP = new Set(['projects', 'file-history', 'plugins']); // big trees with other sessions' churn

// stat-only snapshot of the root (never opens files)
function snap() {
  const m = new Map();
  const walk = (dir, rel, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!(depth === 0 && SKIP.has(e.name)) && depth < 4) walk(path.join(dir, e.name), r, depth + 1); continue; }
      try { const s = fs.statSync(path.join(dir, e.name)); m.set(r, `${s.size}:${s.mtimeMs}`); } catch { /* raced */ }
    }
  };
  walk(root, '', 0);
  return m;
}
const diff = (a, b) => {
  const changed = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push((a.has(k) ? 'M ' : 'A ') + k.replace(/^sessions\/\d+\.json$/, 'sessions/<pid>.json'));
  for (const k of a.keys()) if (!b.has(k)) changed.push('D ' + k.replace(/^sessions\/\d+\.json$/, 'sessions/<pid>.json'));
  const agg = {}; for (const c of changed) agg[c] = (agg[c] ?? 0) + 1;
  return agg;
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function runOnce() {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(claudeExe, ['agents', '--json'], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20, timeout: 60000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let arr = null; try { arr = JSON.parse(r.stdout); } catch { /* not json */ }
  const keys = {}; const status = {}; const kind = {}; let waitingFor = 0;
  for (const el of arr ?? []) {
    for (const k of Object.keys(el)) keys[k] = (keys[k] ?? 0) + 1;
    status[String(el.status)] = (status[String(el.status)] ?? 0) + 1;
    kind[String(el.kind)] = (kind[String(el.kind)] ?? 0) + 1;
    if (el.waitingFor !== undefined) waitingFor++;
  }
  return { pid: r.pid, ms: Math.round(ms), exit: r.status, stdoutBytes: (r.stdout ?? '').length, stderrBytes: (r.stderr ?? '').length, isArray: Array.isArray(arr), n: arr?.length ?? null, keys, status, kind, waitingFor };
}

// baseline window (no claude call) vs. call window, same length
const result = { script: 'agents-probe.mjs', scriptSha256, measuredAt: new Date().toISOString(), runs: [] };
const bA = snap(); const tb = Date.now();
const samples = [];
for (let i = 0; i < runs; i++) { const r = runOnce(); result.runs.push(r); samples.push(r.ms); }
const callWindowMs = Date.now() - tb;
const bB = snap();
result.callWindowMs = callWindowMs;
result.rootChangesDuringCalls = diff(bA, bB);
const qA = snap(); sleep(callWindowMs); const qB = snap();
result.rootChangesDuringEqualQuietWindow = diff(qA, qB);
const s = [...samples].sort((a, b) => a - b);
result.msSummary = { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
const text = JSON.stringify(result, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
