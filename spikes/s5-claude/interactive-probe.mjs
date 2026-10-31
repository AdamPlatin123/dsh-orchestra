// S5: zero-model-call probe of an interactive (TUI) claude started in a new console window WITHOUT a prompt.
// Answers: is the PID from Start-Process really claude.exe, and does a new untrusted cwd block start-up
// (workspace trust dialog) before the registry file <root>/sessions/<pid>.json is written?
// No prompt is passed, so nothing is ever sent to the model. Kills only its own PID tree.
// usage: node interactive-probe.mjs --work <tmp dir> [--seconds 75] [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const work = path.resolve(opt('--work', '.'));
const seconds = Number(opt('--seconds', '75'));
const outFile = opt('--out', null);
const claudeExe = opt('--claude', 'C:/Users/Calx/.local/bin/claude.exe');
const root = process.env.CLAUDE_CONFIG_DIR;
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const helperPids = []; // every short-lived powershell this probe starts
const cwd = path.join(work, 'probe-E', 'cwd');
fs.mkdirSync(cwd, { recursive: true });
const KEEP = /^CLAUDE_CODE_(ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES)$/;
const DROP = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_FORCE_HOST_LOOP|CLAUDE_PREVIEW_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_.*|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/;
const dropped = Object.keys(process.env).filter((k) => DROP.test(k) && !KEEP.test(k));
const ps = [
  "$ErrorActionPreference='Stop'",
  ...dropped.map((n) => `Remove-Item -Path 'Env:${n}' -ErrorAction SilentlyContinue`),
  `$p = Start-Process -FilePath '${claudeExe}' -ArgumentList '--setting-sources project,local --strict-mcp-config' -WorkingDirectory '${cwd}' -WindowStyle Minimized -PassThru`,
  'Write-Output $p.Id',
].join('; ');
const t0 = Date.now();
const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
helperPids.push(r.pid);
const pid = Number((r.stdout ?? '').trim().split(/\s+/).pop());
const procInfo = (p) => {
  const q = `Get-CimInstance Win32_Process -Filter "ProcessId=${p}" | Select-Object Name,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  try { const x = spawnSync('powershell.exe', ['-NoProfile', '-Command', q], { encoding: 'utf8', windowsHide: true }); helperPids.push(x.pid); const j = JSON.parse(x.stdout || 'null'); return j && { name: j.Name, exe: (j.ExecutablePath ?? '').replace(process.env.USERPROFILE, '~'), parentName: null, ppid: j.ParentProcessId }; } catch { return null; }
};
const children = (p) => {
  const q = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${p}" | Select-Object Name | ConvertTo-Json -Compress`;
  try { const x = spawnSync('powershell.exe', ['-NoProfile', '-Command', q], { encoding: 'utf8', windowsHide: true }); helperPids.push(x.pid); const j = JSON.parse(x.stdout || '[]'); return (Array.isArray(j) ? j : [j]).map((x) => x.Name); } catch { return []; }
};
const out = { script: 'interactive-probe.mjs', scriptSha256, pid, startMs: Date.now() - t0, proc: procInfo(pid), samples: [] };
const regPath = path.join(root, 'sessions', `${pid}.json`);
let last = '';
while (Date.now() - t0 < seconds * 1000) {
  let reg = null; try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch { /* absent */ }
  const s = reg ? { status: reg.status ?? null, waitingFor: reg.waitingFor ?? null, kind: reg.kind, entrypoint: reg.entrypoint, statusUpdatedAt: reg.statusUpdatedAt ? reg.statusUpdatedAt - t0 : null } : null;
  const k = JSON.stringify(s);
  if (k !== last) { out.samples.push({ t: Date.now() - t0, reg: s }); last = k; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
out.childImagesAtEnd = children(pid);
out.aliveAtEnd = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
const k = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' });
out.taskkillExit = k.status;
out.helperPids = helperPids; out.taskkillPid = k.pid;
const tk = Date.now(); let gone = null;
while (Date.now() - tk < 10000) { if (!fs.existsSync(regPath)) { gone = Date.now() - tk; break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
out.registryGoneAfterKillMs = gone;
out.projectDirCreated = fs.readdirSync(path.join(root, 'projects')).some((d) => d.endsWith('probe-E-cwd'));
const text = JSON.stringify(out, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
