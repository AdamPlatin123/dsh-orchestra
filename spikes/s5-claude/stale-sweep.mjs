// S5: who removes a stale registry file <root>/sessions/<pid>.json after its claude process is gone?
// Replaces the one-line bash check of 2026-10-29 (evidence/stale-sweep.json: one sample, no control window).
// Windows: control-before (--control-s, no claude call) -> one `claude agents --json` call -> control-after
// (same length as the call). Stale = registry file whose pid is not a live claude.exe right now.
// Lists %CLAUDE_CONFIG_DIR%/sessions file NAMES only (pid comes from the name); opens no file there, never *.key.
// Prints counts and pids only.
// WARNING: the agents call writes into the config root (.claude.json, daemon/pipe.key) and may delete files:
// it breaks the zero-write boundary, so run the full mode only with the user's explicit go-ahead.
// --skip-agents makes it a pure read-only observer (control windows only).
// usage: node stale-sweep.mjs [--control-s 60] [--skip-agents] [--claude <claude.exe>] [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const controlS = Number(opt('--control-s', '60'));
const skipAgents = args.includes('--skip-agents');
const claudeExe = opt('--claude', 'C:/Users/Calx/.local/bin/claude.exe');
const outFile = opt('--out', null);
const sdir = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
const helperPids = [];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function liveClaudePids() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object -ExpandProperty ProcessId"], { encoding: 'utf8', windowsHide: true });
  helperPids.push(r.pid);
  return new Set((r.stdout ?? '').split(/\s+/).filter(Boolean).map(Number));
}
function state() {
  const live = liveClaudePids();
  const names = fs.readdirSync(sdir);
  const json = names.filter((n) => /^\d+\.json$/.test(n));
  const keyPids = new Set(names.filter((n) => n.endsWith('.key')).map((n) => Number(n.split('.')[0])));
  const stale = json.map((n) => Number(n.split('.')[0])).filter((pid) => !live.has(pid));
  const orphanKeys = [...keyPids].filter((pid) => !live.has(pid) && !json.includes(`${pid}.json`));
  return { t: new Date().toISOString(), registryFiles: json.length, stale: stale.sort((a, b) => a - b), orphanKeyPids: orphanKeys.sort((a, b) => a - b) };
}
const removed = (a, b) => a.stale.filter((p) => !b.stale.includes(p));

const out = { script: 'stale-sweep.mjs', scriptSha256, pid: process.pid, controlS, skipAgents };
const s0 = state(); sleep(controlS * 1000); const s1 = state();
out.controlBefore = { start: s0, end: s1, staleRemoved: removed(s0, s1) };
if (!skipAgents) {
  const t = Date.now();
  const a = spawnSync(claudeExe, ['agents', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 << 20 });
  const ms = Date.now() - t;
  const s2 = state();
  out.agentsCall = { pid: a.pid, ms, exit: a.status, start: s1, end: s2, staleRemoved: removed(s1, s2) };
  sleep(ms); const s3 = state();
  out.controlAfter = { lengthMs: ms, start: s2, end: s3, staleRemoved: removed(s2, s3) };
}
out.helperPids = helperPids;
const text = JSON.stringify(out, null, 1);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
