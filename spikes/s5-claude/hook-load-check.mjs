// S5: zero-model-call check that hooks from a temp --settings file load and run under `claude -p`.
// SessionStart stamps; UserPromptSubmit stamps and exits 2, which blocks the prompt before any API call.
// Compares shell form (command string, runs via PowerShell when Claude Code finds no Git Bash)
// with exec form (command + args, spawned directly).
// usage: node hook-load-check.mjs --work <tmp dir> [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const work = path.resolve(opt('--work', '.'));
const outFile = opt('--out', null);
const claudeExe = opt('--claude', 'C:/Users/Calx/.local/bin/claude.exe');
const nodeExe = process.execPath.replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');
const dir = path.join(work, 'hook-load');
const cwd = path.join(dir, 'cwd');
fs.mkdirSync(cwd, { recursive: true });
const log = path.join(dir, 'hooks.jsonl');
const stamp = fwd(path.join(here, 'stamp.mjs'));
const settings = path.join(dir, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({
  hooks: {
    SessionStart: [{ matcher: '', hooks: [
      { type: 'command', command: `"${nodeExe}" "${stamp}" "${fwd(log)}" shell-form` },
      { type: 'command', command: nodeExe, args: [stamp, fwd(log), 'exec-form'] },
    ] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: nodeExe, args: [stamp, fwd(log), 'ups-block', '--exit2'], onFailure: 'block' }] }],
  },
}, null, 2));
// same env scrubbing as hang-run.mjs
const KEEP = /^CLAUDE_CODE_(ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES)$/;
const DROP = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_FORCE_HOST_LOOP|CLAUDE_PREVIEW_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_.*|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(DROP.test(k) && !KEEP.test(k))));
const t0 = Date.now();
const r = spawnSync(claudeExe, ['-p', 'Reply with: ok', '--settings', settings, '--setting-sources', 'project,local', '--strict-mcp-config',
  '--tools', '', '--max-turns', '1', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--include-hook-events'],
{ cwd, env, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 32 << 20 });
const t1 = Date.now();
const evs = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: '(unparsable)' }; } });
const res = evs.find((e) => e.type === 'result');
const out = {
  script: 'hook-load-check.mjs', scriptSha256, claudePid: r.pid,
  wallMs: t1 - t0, exit: r.status, stderrBytes: (r.stderr ?? '').length,
  streamTypes: evs.map((e) => [e.type, e.subtype, e.hook_event ?? e.hook_name, e.outcome ?? e.exit_code].filter((x) => x !== undefined).join('/')),
  assistantMessages: evs.filter((e) => e.type === 'assistant').length,
  result: res && { subtype: res.subtype, is_error: res.is_error, num_turns: res.num_turns, cost: res.total_cost_usd, in: res.usage?.input_tokens, out: res.usage?.output_tokens },
  hooks: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return { ...j, t: j.t - t0 }; }) : [],
};
const text = JSON.stringify(out, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
