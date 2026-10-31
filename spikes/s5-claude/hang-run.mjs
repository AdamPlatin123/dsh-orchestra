// S5 step 4: hang a permission request in `claude -p` and watch every candidate waiting signal.
// Signals sampled every 0.5 s: registry <root>/sessions/<pid>.json (status/statusUpdatedAt/waitingFor),
// this session's own transcript (size + last record `type`), hook timestamp file, MCP log,
// and `claude agents --json` (back-to-back, each call takes seconds).
// Output: counts, timestamps, key names and enum values only; never message text.
// usage: node hang-run.mjs --label A --work <tmp dir> --mode mcp|none|stdio [--sample-s 90] [--agents-max 6] [--inherit-env]
//          [--max-turns 3] [--hooks all|permission|none]
//   --agents-max 0 : no `claude agents --json` probe during the run. Each probe call is a full claude start-up
//           (8-35 s under load) and it overlapped the tool_use -> permission window in runs A/A2/B/C, so use 0
//           when the tool_use -> permission timing or hook latency is what you want to measure.
//   --hooks permission : only PermissionRequest + Notification hooks (no PreToolUse hook in front of the
//           permission check); none : no hooks at all. Default all (what runs A2/C used).
//   --max-turns 1 : for control runs (run B used 3 and made a second API request after the auto-deny).
//   The child always gets CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 (stdout session_state_changed events only;
//   static analysis shows the registry write does not depend on it). It is recorded in the evidence file.
//   mcp   : --permission-prompt-tool mcp__hang__approval_prompt (MCP tool never answers)
//   none  : no prompt tool (control: does -p auto-deny or hang?)
//   stdio : --permission-prompt-tool stdio + --input-format stream-json, i.e. the Agent SDK host path;
//           the can_use_tool control_request is never answered
//   interactive : the TUI in a new minimised console window (Start-Process), prompt as positional arg;
//           tool_use time comes from the transcript / PreToolUse hook instead of stdout
//   By default the child env is scrubbed of the parent Claude session's host variables
//   (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_MESSAGING_*, ...) so it looks like a terminal launch.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = opt('--label', 'A');
const work = path.resolve(opt('--work', '.'));
const mode = opt('--mode', 'mcp');
const usePromptTool = mode === 'mcp';
const inheritEnv = args.includes('--inherit-env');
const sampleS = Number(opt('--sample-s', '90'));
const agentsMax = Number(opt('--agents-max', '6'));
const maxTurns = opt('--max-turns', '3');
const hooksMode = opt('--hooks', 'all');
const claudeExe = opt('--claude', 'C:/Users/Calx/.local/bin/claude.exe');
const nodeExe = opt('--node', process.execPath).replace(/\\/g, '/');
const prompt = opt('--prompt', 'Run this shell command: echo spike > s5.txt');
const outFile = opt('--out', null);
const root = process.env.CLAUDE_CONFIG_DIR;
const fwd = (p) => p.replace(/\\/g, '/');

// ---- run directory with temp configs (never the user's settings) ----
const runDir = path.join(work, `run-${label}`);
const cwd = path.join(runDir, 'cwd');
fs.mkdirSync(cwd, { recursive: true });
const hooksLog = path.join(runDir, 'hooks.jsonl');
const mcpLog = path.join(runDir, 'mcp.jsonl');
const mcpJson = path.join(runDir, 'mcp.json');
const settingsJson = path.join(runDir, 'settings.json');
fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { hang: { type: 'stdio', command: nodeExe, args: [fwd(path.join(here, 'hang-mcp.mjs')), fwd(mcpLog)] } } }, null, 2));
// exec form (command + args): the shell form fails on this machine, because Claude Code finds no Git Bash
// and runs hook strings through PowerShell (see hook-load-check.mjs)
const hookCmd = (tag) => ({ type: 'command', command: nodeExe, args: [fwd(path.join(here, 'stamp.mjs')), fwd(hooksLog), tag] });
const hookSet = {
  Notification: [
    { matcher: 'permission_prompt', hooks: [hookCmd('notif-permission_prompt')] },
    { matcher: '', hooks: [hookCmd('notif-any')] },
  ],
  PreToolUse: [{ matcher: '', hooks: [hookCmd('pretooluse')] }],
  PermissionRequest: [{ matcher: '', hooks: [hookCmd('permissionrequest')] }],
};
if (hooksMode !== 'all') delete hookSet.PreToolUse;
fs.writeFileSync(settingsJson, JSON.stringify(hooksMode === 'none' ? {} : { hooks: hookSet }, null, 2));

const interactiveArgs = [prompt, '--permission-mode', 'default', '--mcp-config', mcpJson, '--strict-mcp-config',
  '--settings', settingsJson, '--setting-sources', 'project,local', '--model', 'sonnet'];
const printArgs = ['-p', ...(mode === 'stdio' ? [] : [prompt]), '--permission-mode', 'default',
  ...(usePromptTool ? ['--permission-prompt-tool', 'mcp__hang__approval_prompt'] : []),
  ...(mode === 'stdio' ? ['--permission-prompt-tool', 'stdio', '--input-format', 'stream-json'] : []),
  '--mcp-config', mcpJson, '--strict-mcp-config', '--settings', settingsJson, '--setting-sources', 'project,local',
  '--model', 'sonnet', '--max-turns', maxTurns, '--max-budget-usd', '1', '--output-format', 'stream-json', '--verbose', '--include-hook-events'];
const claudeArgs = mode === 'interactive' ? interactiveArgs : printArgs;
const hardS = Number(opt('--hard-s', String(sampleS + 60)));

// ---- state ----
// env: drop the parent session's host wiring, keep auth/proxy/CA and the config root
const KEEP = /^CLAUDE_CODE_(ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES)$/;
const DROP = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_FORCE_HOST_LOOP|CLAUDE_PREVIEW_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_.*|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/;
const childEnv = {};
const dropped = [];
for (const [k, v] of Object.entries(process.env)) { if (!inheritEnv && DROP.test(k) && !KEEP.test(k)) dropped.push(k); else childEnv[k] = v; }
childEnv.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
const R = { script: 'hang-run.mjs', scriptSha256, label, mode, inheritEnv, hooksMode, agentsMax, injectedEnv: ['CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1'], droppedEnvNames: dropped.sort(), argsShape: claudeArgs.map((a) => (a === prompt ? '<prompt>' : a.startsWith(runDir) ? '<run>/' + path.basename(a) : a)), promptChars: prompt.length };
const t0 = Date.now();
R.t0 = t0;
const rel = (t) => (t == null ? null : t - t0);
const events = []; const regSamples = []; const trSamples = []; const agentsCalls = [];
let sessionId = null; let toolUseT = null; let exitInfo = null; let stopped = false; let transcript = null;
let lastReg = ''; let lastTr = '';

let controlReqT = null;
let child;
let pid;
if (mode === 'interactive') {
  // new console window; the PowerShell process scrubs its own env first, so claude.exe inherits the scrubbed env
  const q = (a) => '"' + a.replace(/"/g, '\\"') + '"';
  const ps = [
    "$ErrorActionPreference='Stop'",
    ...dropped.map((n) => `Remove-Item -Path 'Env:${n}' -ErrorAction SilentlyContinue`),
    `$p = Start-Process -FilePath '${claudeExe}' -ArgumentList '${claudeArgs.map(q).join(' ').replace(/'/g, "''")}' -WorkingDirectory '${cwd}' -WindowStyle Minimized -PassThru`,
    'Write-Output $p.Id',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  R.launcherPid = r.pid;
  pid = Number((r.stdout ?? '').trim().split(/\s+/).pop());
  if (!pid) { console.error('Start-Process failed', r.stderr); process.exit(3); }
  const alive = setInterval(() => { try { process.kill(pid, 0); } catch { exitInfo = { t: rel(Date.now()), code: null, sig: 'gone' }; clearInterval(alive); } }, 500);
} else {
  child = spawn(claudeExe, claudeArgs, { cwd, env: childEnv, stdio: [mode === 'stdio' ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  pid = child.pid;
}
if (mode === 'stdio') {
  // what the Agent SDK sends: initialize, then the user message; stdin stays open
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's5-init', request: { subtype: 'initialize' } }) + '\n');
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: '' }) + '\n');
}
R.pid = pid;
console.error(`[${label}] claude pid=${pid}`);
let stderrBytes = 0; let stderrHead = '';
if (child) child.stderr.on('data', (d) => { stderrBytes += d.length; if (stderrHead.length < 600) stderrHead += d.toString('utf8').slice(0, 600 - stderrHead.length); });
if (child) child.on('exit', (code, sig) => { exitInfo = { t: rel(Date.now()), code, sig }; });

let obuf = '';
if (child) child.stdout.setEncoding('utf8');
if (child) child.stdout.on('data', (d) => {
  obuf += d;
  for (let i; (i = obuf.indexOf('\n')) >= 0;) {
    const line = obuf.slice(0, i); obuf = obuf.slice(i + 1);
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { events.push({ t: rel(Date.now()), type: '(unparsable)', bytes: line.length }); continue; }
    const s = { t: rel(Date.now()), type: e.type, subtype: e.subtype };
    if (e.type === 'system' && e.subtype === 'init') {
      sessionId = e.session_id;
      s.mcp = (e.mcp_servers ?? []).map((m) => `${m.name}:${m.status}`);
      s.permissionMode = e.permissionMode; s.model = e.model; s.keys = Object.keys(e).sort().join(',');
      s.shellTools = (e.tools ?? []).filter((n) => /^(Bash|PowerShell)$/.test(n)); s.toolCount = (e.tools ?? []).length;
    }
    if (e.type === 'system' && e.subtype === 'session_state_changed') s.state = e.state;
    if (e.type === 'control_request') { s.subtype = e.request?.subtype; s.tool = e.request?.tool_name; if (s.subtype === 'can_use_tool' && controlReqT == null) controlReqT = Date.now(); }
    if (e.type === 'control_response') s.subtype = e.response?.subtype;
    if (e.type === 'system' && (e.subtype === 'hook_response' || e.subtype === 'hook_started')) { s.hook = e.hook_event ?? e.hook_name; s.outcome = e.outcome; }
    const content = e.message?.content;
    if (Array.isArray(content)) {
      s.blocks = content.map((c) => c.type + (c.type === 'tool_use' ? `:${c.name}` : '') + (c.type === 'tool_result' ? `:err=${!!c.is_error}` : ''));
      if (e.type === 'assistant' && content.some((c) => c.type === 'tool_use') && toolUseT == null) toolUseT = Date.now();
    }
    if (e.type === 'result') {
      Object.assign(s, { is_error: e.is_error, num_turns: e.num_turns, duration_ms: e.duration_ms, cost: e.total_cost_usd, in: e.usage?.input_tokens, out: e.usage?.output_tokens, cacheR: e.usage?.cache_read_input_tokens, cacheW: e.usage?.cache_creation_input_tokens, denials: e.permission_denials?.length });
    }
    events.push(s);
  }
});

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function findTranscript() {
  const pdir = path.join(root, 'projects');
  for (const d of fs.readdirSync(pdir)) { const f = path.join(pdir, d, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
function lastType(f) {
  const fd = fs.openSync(f, 'r');
  try {
    const size = fs.fstatSync(fd).size; const n = Math.min(size, 256 * 1024);
    const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n);
    const lines = b.toString('utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]); const c = j.message?.content;
        return { size, last: j.type + (j.subtype ? '/' + j.subtype : ''), blocks: Array.isArray(c) ? c.map((x) => x.type).join(',') : undefined };
      } catch { /* partial */ }
    }
    return { size, last: null };
  } finally { fs.closeSync(fd); }
}

function sample() {
  const now = Date.now();
  const reg = readJson(path.join(root, 'sessions', `${pid}.json`));
  const rs = reg ? { status: reg.status, statusUpdatedAt: reg.statusUpdatedAt, updatedAt: reg.updatedAt, waitingFor: reg.waitingFor, kind: reg.kind, entrypoint: reg.entrypoint, keys: Object.keys(reg).sort().join(',') } : null;
  const k = JSON.stringify(rs);
  if (k !== lastReg) { regSamples.push({ t: rel(now), reg: rs && { ...rs, statusUpdatedAt: rel(rs.statusUpdatedAt), updatedAt: rel(rs.updatedAt) } }); lastReg = k; }
  if (mode === 'interactive' && !sessionId && reg?.sessionId) sessionId = reg.sessionId;
  if (sessionId && !transcript) transcript = findTranscript();
  if (transcript) {
    const ts = lastType(transcript); const k2 = JSON.stringify(ts);
    if (k2 !== lastTr) { trSamples.push({ t: rel(now), ...ts }); lastTr = k2; }
    if (mode === 'interactive' && toolUseT == null && ts.last === 'assistant' && ts.blocks?.includes('tool_use')) { toolUseT = now; R.toolUseSource = 'transcript poll'; }
  }
}

async function agentsLoop() {
  // start only once the tool call is out, so the probe does not slow the session's start-up
  while (!stopped && toolUseT == null) await new Promise((r) => setTimeout(r, 250));
  while (!stopped && agentsCalls.length < agentsMax) {
    const tS = Date.now();
    const out = await new Promise((res) => {
      const a = spawn(claudeExe, ['agents', '--json'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      R.agentsPids = [...(R.agentsPids ?? []), a.pid];
      let s = ''; a.stdout.on('data', (d) => { s += d; }); a.on('close', () => res(s));
    });
    const tE = Date.now();
    let arr = null; try { arr = JSON.parse(out); } catch { /* ignore */ }
    const el = Array.isArray(arr) ? arr.find((x) => x.pid === pid || (sessionId && x.sessionId === sessionId)) : undefined;
    agentsCalls.push({ tStart: rel(tS), tEnd: rel(tE), ms: tE - tS, n: arr?.length ?? null, present: !!el, status: el?.status, waitingFor: el?.waitingFor, kind: el?.kind, keys: el ? Object.keys(el).sort().join(',') : null });
  }
}

const iv = setInterval(sample, 500);
sample();
let agentsDoneFlag = false;
const agentsDone = agentsLoop().then(() => { agentsDoneFlag = true; });
await new Promise((res) => {
  const chk = setInterval(() => {
    const now = Date.now();
    const limit = toolUseT != null ? toolUseT + sampleS * 1000 : t0 + hardS * 1000;
    if (exitInfo || now >= limit) { clearInterval(chk); res(); }
  }, 250);
});
sample();
R.stopReason = exitInfo ? 'claude exited' : 'sample window over';
stopped = true;
clearInterval(iv);

// ---- kill only our claude pid tree, then watch the registry file ----
const regPath = path.join(root, 'sessions', `${pid}.json`);
const existedAtKill = fs.existsSync(regPath); // checked before taskkill
const probeRunningAtKill = !agentsDoneFlag;
if (!exitInfo) {
  const k = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' });
  R.taskkill = { t: rel(Date.now()), exit: k.status };
}
const tk = Date.now(); let goneAt = null;
// (the 2026-10-29 evidence files hard-coded existedAtKill: true; run D never had a registry file, so its
// goneAfterMs 0 means nothing. Also note: a `claude agents --json` probe still running here can be what
// deletes the file - run C - so registryAfterKill only says "the file went away", not who removed it.)
while (existedAtKill && Date.now() - tk < 15000) { if (!fs.existsSync(regPath)) { goneAt = Date.now(); break; } await new Promise((r) => setTimeout(r, 250)); }
R.registryAfterKill = { existedAtKill, probeRunningAtKill, goneAfterMs: goneAt ? goneAt - tk : null, stillPresentAfter15s: existedAtKill && goneAt == null };
await agentsDone;

// ---- derived timings (ms, relative to the first assistant tool_use on stdout) ----
const hooks = readLines(hooksLog).map((h) => ({ ...h, t: rel(h.t) }));
const mcp = readLines(mcpLog).map((m) => ({ ...m, t: rel(m.t) }));
const firstReg = (pred) => regSamples.find((s) => s.reg && pred(s.reg));
const tu = rel(toolUseT);
const w = firstReg((r) => r.status === 'waiting');
const d = (x) => (x == null || tu == null ? null : x - tu);
R.timeline = {
  toolUseOnStdout: tu,
  hookPreToolUse: hooks.find((h) => h.tag === 'pretooluse')?.t ?? null,
  hookPermissionRequest: hooks.find((h) => h.tag === 'permissionrequest')?.t ?? null,
  hookNotificationPermissionPrompt: hooks.find((h) => h.tag === 'notif-permission_prompt')?.t ?? null,
  hookNotificationAny: hooks.find((h) => h.tag === 'notif-any')?.t ?? null,
  mcpToolsCall: mcp.find((m) => m.method === 'tools/call')?.t ?? null,
  controlRequestCanUseTool: rel(controlReqT),
  streamRequiresAction: events.find((e) => e.state === 'requires_action')?.t ?? null,
  registryWaitingSeen: w?.t ?? null,
  registryWaitingStatusUpdatedAt: w?.reg.statusUpdatedAt ?? null,
  registryWaitingFor: w?.reg.waitingFor ?? null,
  agentsFirstWaiting: agentsCalls.find((a) => a.status === 'waiting')?.tEnd ?? null,
};
R.deltaFromToolUseMs = Object.fromEntries(Object.entries(R.timeline).filter(([k, v]) => typeof v === 'number' && k !== 'toolUseOnStdout').map(([k, v]) => [k, d(v)]));
Object.assign(R, { sessionIdKnown: !!sessionId, transcriptFound: !!transcript, exitInfo, stderrBytes, stderrHead, events, regSamples, trSamples, hooks, mcp, agentsCalls });
const text = JSON.stringify(R, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
