// S5 step 1+2: enumerate CLAUDE_CONFIG_DIR roots and summarise the session registry.
// Read-only: readdir/stat everywhere; opens ONLY %CLAUDE_CONFIG_DIR%/sessions/<pid>.json (the brief's read
// whitelist; never *.key). Other roots: <pid>.json names are counted, and the pid in the file name is enough for
// the completeness check; their contents are opened only with --open-all-roots.
// Completeness: a live Claude Code process with no registry file is reported as "unregistered" only after
// --grace-s seconds (default 60): a TUI waiting at the workspace-trust dialog had no registry file for 75-150 s,
// and spike sessions took 28-46 s to register under load. It is not called "unknown root" automatically.
// Prints counts, key names and enum values only (no cwd, no names, no conversation text).
// usage: node roots.mjs [--out <file.json>] [--extra-root <dir>]... [--open-all-roots] [--grace-s 60]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const extraRoots = args.flatMap((a, i) => (a === '--extra-root' ? [args[i + 1]] : []));
const openAll = args.includes('--open-all-roots');
const graceS = Number(args.includes('--grace-s') ? args[args.indexOf('--grace-s') + 1] : 60);
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
let primaryReal = null; try { primaryReal = fs.realpathSync.native(process.env.CLAUDE_CONFIG_DIR).toLowerCase(); } catch { /* unset */ }
const home = os.homedir();
const now = Date.now();

// ---- 1. candidate roots -------------------------------------------------
const candidates = []; // {path, source}
const addCand = (p, source) => p && candidates.push({ path: path.resolve(p), source });
addCand(process.env.CLAUDE_CONFIG_DIR, 'env CLAUDE_CONFIG_DIR');
addCand(path.join(home, '.claude'), 'default ~/.claude');
addCand(path.join(home, '.config', 'claude'), 'xdg ~/.config/claude');
const accDir = path.join(home, '.rec', 'claude', 'accounts');
if (fs.existsSync(accDir)) {
  for (const a of fs.readdirSync(accDir, { withFileTypes: true })) {
    if (a.isDirectory()) addCand(path.join(accDir, a.name, 'config'), 'glob ~/.rec/claude/accounts/*/config');
  }
}
for (const r of extraRoots) addCand(r, 'cli --extra-root');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const roots = new Map(); // realpath -> info
for (const c of candidates) {
  let real = null;
  try { real = fs.realpathSync.native(c.path); } catch { /* missing */ }
  const key = (real ?? c.path).toLowerCase();
  if (!roots.has(key)) roots.set(key, { path: real ?? c.path, exists: !!real, sources: [] });
  roots.get(key).sources.push(c.source);
}

const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
// ---- live processes (image name + pid + ppid; exe path only for claude.exe; no command lines) ----
let procs = [];
try {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n="Exe";e={if ($_.Name -eq "claude.exe") { $_.ExecutablePath } else { $null }}},@{n="AgeS";e={if ($_.Name -eq "claude.exe" -and $_.CreationDate) { [int]((Get-Date) - $_.CreationDate).TotalSeconds } else { $null }}} | ConvertTo-Json -Compress';
  procs = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 }));
} catch (e) { procs = []; }
const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
// claude.exe is also the image name of the Claude desktop app (Electron, many helper processes).
// An Electron build has resources/app.asar next to the exe; a Claude Code binary does not.
const electronCache = new Map();
const isElectron = (exe) => {
  if (!exe) return false;
  if (!electronCache.has(exe)) electronCache.set(exe, fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar')));
  return electronCache.get(exe);
};
const tilde = (p) => (p ? p.replace(home, '~') : '(unknown)');
const claudeExe = procs.filter((p) => /^claude\.exe$/i.test(p.Name));
const claudePids = claudeExe.filter((p) => !isElectron(p.Exe)).map((p) => p.ProcessId);
const exeGroups = {};
for (const p of claudeExe) inc(exeGroups, `${isElectron(p.Exe) ? 'desktop-electron' : 'claude-code'} ${tilde(p.Exe)}`);

// ---- 2. per-root counts + registry stats --------------------------------
const pctl = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
const allRegistryPids = new Set();
const out = { script: 'roots.mjs', scriptSha256, measuredAt: new Date(now).toISOString(), openAllRoots: openAll, graceS, roots: [], liveClaudeExe: {} };

for (const r of roots.values()) {
  const info = { path: r.path, sources: r.sources, exists: r.exists };
  if (r.exists) {
    const sdir = path.join(r.path, 'sessions');
    const pdir = path.join(r.path, 'projects');
    info.hasSessionsDir = isDir(sdir);
    info.hasProjectsDir = isDir(pdir);
    info.isRoot = info.hasSessionsDir || info.hasProjectsDir;
    const names = info.hasSessionsDir ? fs.readdirSync(sdir) : [];
    const jsonNames = names.filter((n) => n.endsWith('.json'));
    info.contentsOpened = openAll || r.path.toLowerCase() === primaryReal;
    for (const n of jsonNames) { const m = /^(\d+)\.json$/.exec(n); if (m) allRegistryPids.add(Number(m[1])); }
    info.sessionsJson = jsonNames.length;
    info.sessionsKeyFilesCountedNotRead = names.filter((n) => n.endsWith('.key')).length;
    info.sessionsOther = names.length - jsonNames.length - info.sessionsKeyFilesCountedNotRead;
    info.projectsSubdirs = info.hasProjectsDir ? fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory()).length : 0;
    // registry
    const reg = { keyFreq: {}, status: {}, kind: {}, entrypoint: {}, version: {}, waitingForPresent: 0, statusLagMs: [], updatedAgeS: [], live: 0, dead: 0, parseErrors: 0 };
    for (const n of info.contentsOpened ? jsonNames : []) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(sdir, n), 'utf8')); } catch { reg.parseErrors++; continue; }
      for (const k of Object.keys(j)) inc(reg.keyFreq, k);
      inc(reg.status, String(j.status));
      inc(reg.kind, String(j.kind));
      inc(reg.entrypoint, String(j.entrypoint));
      inc(reg.version, String(j.version));
      if (j.waitingFor !== undefined) reg.waitingForPresent++;
      if (typeof j.updatedAt === 'number' && typeof j.statusUpdatedAt === 'number') reg.statusLagMs.push(j.updatedAt - j.statusUpdatedAt);
      if (typeof j.updatedAt === 'number') reg.updatedAgeS.push(Math.round((now - j.updatedAt) / 1000));
      const pid = Number(j.pid);
      allRegistryPids.add(pid);
      const p = byPid.get(pid);
      if (p && /^claude\.exe$/i.test(p.Name)) reg.live++; else reg.dead++;
    }
    reg.statusLagMsSummary = { n: reg.statusLagMs.length, min: pctl(reg.statusLagMs, 0), p50: pctl(reg.statusLagMs, 0.5), max: pctl(reg.statusLagMs, 1) };
    reg.updatedAgeSSummary = { n: reg.updatedAgeS.length, min: pctl(reg.updatedAgeS, 0), p50: pctl(reg.updatedAgeS, 0.5), max: pctl(reg.updatedAgeS, 1) };
    delete reg.statusLagMs; delete reg.updatedAgeS;
    info.registry = reg;
  }
  out.roots.push(info);
}

// ---- completeness check: every live claude.exe should be in some root's registry ----
const unmatchedAll = claudePids.filter((pid) => !allRegistryPids.has(pid));
const young = unmatchedAll.filter((pid) => (byPid.get(pid)?.AgeS ?? Infinity) < graceS);
const unmatched = unmatchedAll.filter((pid) => !young.includes(pid));
const parentNames = {};
for (const pid of unmatched) inc(parentNames, byPid.get(byPid.get(pid)?.ParentProcessId)?.Name ?? '(gone)');
const matchedParents = {};
for (const pid of claudePids.filter((p) => allRegistryPids.has(p))) inc(matchedParents, byPid.get(byPid.get(pid)?.ParentProcessId)?.Name ?? '(gone)');
const exeOfUnmatched = {}; for (const pid of unmatched) inc(exeOfUnmatched, tilde(byPid.get(pid)?.Exe));
out.liveClaudeExe = { imageClaudeExeByExe: exeGroups, claudeCodeProcesses: claudePids.length, inSomeRegistry: claudePids.length - unmatchedAll.length,
  unregisteredWithinGrace: young.length, notInAnyRegistry: unmatched.length,
  notInAnyRegistryMeaning: 'unregistered after the grace period: maybe a TUI at the trust dialog, maybe an unknown root; needs a human look',
  parentImageOfUnmatched: parentNames, exeOfUnmatched, parentImageOfMatched: matchedParents };

const text = JSON.stringify(out, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
