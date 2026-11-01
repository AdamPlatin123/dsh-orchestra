// Spike: one Orchestra-owned Claude session through the Agent SDK (r4 §7.1 "自有传输" row).
// Not part of M0 src/. Records structure only: types, subtypes, keys, counts, timings, booleans.
// No assistant or user text is written anywhere; marker checks are reduced to booleans.
//
//   node probe.mjs --phase zero --out <dir>   # no model call: initialize, commands, settings, context usage
//   node probe.mjs --phase live --out <dir>   # haiku only, one query(), five turns plus an idle tail
//   node probe.mjs --phase init --out <dir>   # one turn per workflow setting, keeps system/init only
// Common: --proxy http://host:port (HTTPS_PROXY for the child), --config-dir <CLAUDE_CONFIG_DIR>,
//         --claude <claude.exe>, --budget <usd per query()>, --env inherit (default: allowlist).
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []));
const PHASE = args.phase ?? 'zero';
const OUT = args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-out-'));
const CLAUDE = args.claude ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const CONFIG_DIR = args['config-dir'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROXY = args.proxy ?? '';
const BUDGET_USD =Number(args.budget ?? (PHASE === 'live' ? 0.15 : 0.01));
const T0 = Date.now();
const t = () => Date.now() - T0;
fs.mkdirSync(OUT, { recursive: true });

// Allowlisted environment: the parent here is a Desktop-hosted Claude Code session, whose
// messaging socket, host session id and proxy must not leak into the probe's child.
const ENV_KEEP = ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
// --env inherit: the whole parent environment minus the Desktop host's messaging and session
// variables and the sandbox proxy, to check that the allowlist itself is not why auth fails.
const ENV_DROP = /^(CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_HOST_SESSION_ID$|CLAUDE_CODE_SESSION_ID$|CLAUDE_PID$|CLAUDECODE$|CLAUDE_CODE_CHILD_SESSION$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_AGENT_SDK_VERSION$|https?_proxy$|HTTPS?_PROXY$|npm_config_)/i;
function childEnv(extra) {
  const env = {};
  if (args.env === 'inherit') {
    for (const [k, v] of Object.entries(process.env)) if (!ENV_DROP.test(k)) env[k] = v;
  } else for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  // The CLI does not read the Windows system proxy (the Desktop app does); without it the API
  // answered 403 "Request not allowed" on this machine. Pass it explicitly: --proxy http://host:port
  if (PROXY) env.HTTPS_PROXY = PROXY;
  return { ...env, ...extra };
}

const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : []);
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));

function claudeVersion() {
  try {
    return execFileSync(CLAUDE, ['--version'], { env: childEnv({}), encoding: 'utf8', timeout: 60000 }).trim();
  } catch (e) {
    return `error: ${e.code ?? e.message}`;
  }
}

/** A pushable async iterable that stays open until end(). */
function inbox() {
  const items = [];
  let wake = null;
  let done = false;
  return {
    push(m) {
      items.push(m);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}
const userMsg = (text, priority) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });

function baseOptions(cwd, extraEnv, overrides = {}) {
  return {
    cwd,
    model: 'haiku',
    pathToClaudeCodeExecutable: CLAUDE,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    maxTurns: 3,
    maxBudgetUsd: BUDGET_USD,
    persistSession: true,
    env: childEnv(extraEnv),
    stderr: (d) => stderrLines.push({ t: t(), len: d.length, error: /error|fail|denied/i.test(d), head: d.slice(0, 160).replace(/\s+/g, ' ') }),
    ...overrides,
  };
}
const stderrLines = [];

/** Structure of a slash-command / agent / model list: names only. */
const names = (arr) => (Array.isArray(arr) ? arr.map((x) => x?.name ?? x?.value ?? '?') : null);

async function zeroModel(label, cwd, extraEnv, overrides) {
  const input = inbox();
  const q = query({ prompt: input, options: baseOptions(cwd, extraEnv, overrides) });
  const seen = [];
  const pump = (async () => {
    for await (const m of q) seen.push({ t: t(), type: m.type, subtype: m.subtype ?? null });
  })().catch((e) => seen.push({ t: t(), error: String(e?.message ?? e).slice(0, 200) }));
  const r = { label, startedAt: t() };
  try {
    const init = await q.initializationResult();
    r.initKeys = keys(init);
    r.capabilities = init.capabilities ?? null;
    r.sessionState = init.session_state ?? null;
    r.permissionMode = init.current_permission_mode ?? null;
    r.claudeCodeVersion = init.claude_code_version ?? null;
    r.commands = names(init.commands);
    r.agents = names(init.agents);
    r.models = (init.models ?? []).map((m) => m.value);
    r.accountKeys = keys(init.account);
    r.accountSource = { tokenSource: init.account?.tokenSource ?? null, apiKeySource: init.account?.apiKeySource ?? null, subscriptionType: init.account?.subscriptionType ?? null };
    r.initAt = t();
  } catch (e) {
    r.initError = String(e?.message ?? e).slice(0, 300);
  }
  try {
    const s = await q.getSettings();
    r.settingsKeys = keys(s);
    r.appliedKeys = keys(s?.applied);
    r.applied = { effort: s?.applied?.effort ?? null, model: s?.applied?.model ?? null };
    r.effectiveDisableWorkflows = s?.effective?.disableWorkflows ?? null;
    r.effectiveDisableAllHooks = s?.effective?.disableAllHooks ?? null;
  } catch (e) {
    r.settingsError = String(e?.message ?? e).slice(0, 300);
  }
  try {
    const u = await q.getContextUsage({ detail: 'full' });
    r.contextUsageKeys = keys(u);
    const toolArrays = Object.entries(u ?? {}).filter(([, v]) => Array.isArray(v));
    r.contextUsageArrays = Object.fromEntries(toolArrays.map(([k, v]) => [k, names(v)]));
  } catch (e) {
    r.contextUsageError = String(e?.message ?? e).slice(0, 300);
  }
  input.end();
  q.close();
  await pump;
  r.messages = seen;
  r.endedAt = t();
  return r;
}

// ---------- registry poller (1 s): only sessions/<pid>.json, never .key ----------
function startRegistryPoll(match) {
  const dir = path.join(CONFIG_DIR, 'sessions');
  const samples = [];
  let last = null;
  const tick = () => {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return;
    }
    let hit = null;
    for (const f of files) {
      let o;
      try {
        o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      if (match(o)) hit = { file: f, o };
    }
    const row = hit
      ? { status: hit.o.status ?? null, waitingFor: hit.o.waitingFor ?? null, entrypoint: hit.o.entrypoint ?? null, kind: hit.o.kind ?? null, version: hit.o.version ?? null, keys: keys(hit.o).join(','), pidIsFile: hit.file === `${hit.o.pid}.json` }
      : { status: 'absent' };
    const sig = JSON.stringify(row);
    if (sig !== last) {
      samples.push({ t: t(), ...row });
      last = sig;
    }
  };
  const h = setInterval(tick, 1000);
  tick();
  return { samples, stop: () => clearInterval(h) };
}

// ---------- transcript structure ----------
function findTranscript(sessionId) {
  const root = path.join(CONFIG_DIR, 'projects');
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return { dir: d, file: p };
  }
  return null;
}
function transcriptShape(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      return { bad: true };
    }
    const content = o?.message?.content;
    return {
      type: o.type ?? null,
      subtype: o.subtype ?? null,
      uuid: o.uuid ?? null,
      parentUuid: o.parentUuid ?? null,
      keys: keys(o).join(','),
      blocks: Array.isArray(content) ? content.map((b) => b?.type).join(',') : typeof content,
      isMeta: o.isMeta ?? null,
      priority: o.priority ?? null,
      origin: o.origin ? keys(o.origin).join(',') : null,
      timestamp: o.timestamp ?? null,
    };
  });
}

// ---------- live run ----------
const MARK = { pong: /\bPONG\b/, steer: /STEER-ACK/, queued: /QUEUED-ACK/ };
function textOf(m) {
  const c = m?.message?.content;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '';
}
function maxInt(s) {
  let best = 0;
  for (const x of s.match(/\d+/g) ?? []) best = Math.max(best, Number(x));
  return best;
}

async function live() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sdk-probe-'));
  const ev = { claude: CLAUDE, claudeVersion: claudeVersion(), sdkVersion: JSON.parse(fs.readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url))).version, configDir: CONFIG_DIR, cwd, budgetUsd: BUDGET_USD };
  const stream = [];
  const perm = [];
  const turns = [];
  let sessionId = null;
  let firstDeltaAt = null;
  const resultWaiters = [];
  const deltaWaiters = [];
  let haikuOk = null;

  const prompt = inbox();
  const later = inbox();
  const q = query({
    prompt,
    options: baseOptions(cwd, { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }, {
      effort: 'low',
      includePartialMessages: true,
      canUseTool: async (toolName, input, opts) => {
        const at = t();
        await new Promise((r) => setTimeout(r, 6000)); // hold long enough for a 1 s registry poll
        perm.push({ t: at, answeredAt: t(), toolName, inputKeys: keys(input), optsKeys: keys(opts), suggestions: Array.isArray(opts?.suggestions) ? opts.suggestions.length : null });
        return { behavior: 'deny', message: 'Denied by the Orchestra probe: no tool may run in this session.' };
      },
    }),
  });

  const reg = startRegistryPoll((o) => (sessionId && o.sessionId === sessionId) || (typeof o.cwd === 'string' && o.cwd.toLowerCase() === cwd.toLowerCase()));

  const pump = (async () => {
    for await (const m of q) {
      const row = { t: t(), type: m.type, subtype: m.subtype ?? null, uuid: m.uuid ?? null, keys: keys(m).join(',') };
      if (m.type === 'stream_event') {
        row.event = m.event?.type ?? null;
        if (m.event?.type === 'content_block_delta' && firstDeltaAt === null) {
          firstDeltaAt = t();
          deltaWaiters.splice(0).forEach((w) => w());
        }
      }
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        row.init = { model: m.model, permissionMode: m.permissionMode, capabilities: m.capabilities ?? null, effort: m.effort ?? null, tools: m.tools, mcpServers: (m.mcp_servers ?? []).map((s) => s.name), slashCommands: m.slash_commands, apiKeySource: m.apiKeySource ?? null, claudeCodeVersion: m.claude_code_version ?? null, outputStyle: m.output_style ?? null, agents: m.agents ?? null, skills: m.skills ?? null, plugins: (m.plugins ?? []).map((p) => p.name) };
        haikuOk = /haiku/i.test(m.model ?? '');
        if (!haikuOk) {
          // claude-haiku-only guard (r4 §7.2): stop before the model answers.
          await q.interrupt().catch(() => {});
          prompt.end();
          later.end();
        }
      }
      if (m.type === 'assistant') {
        const s = textOf(m);
        row.blocks = (m.message?.content ?? []).map((b) => b.type).join(',');
        row.textLen = s.length;
        row.marks = Object.fromEntries(Object.entries(MARK).map(([k, re]) => [k, re.test(s)]));
        row.maxInt = maxInt(s);
        row.model = m.message?.model ?? null;
      }
      if (m.type === 'user') {
        const c = m.message?.content;
        row.blocks = Array.isArray(c) ? c.map((b) => b.type).join(',') : typeof c;
        row.priority = m.priority ?? null;
        row.isSynthetic = m.isSynthetic ?? null;
      }
      if (m.type === 'result') {
        row.result = { subtype: m.subtype, isError: m.is_error, numTurns: m.num_turns, durationMs: m.duration_ms, costUsd: m.total_cost_usd, stopReason: m.stop_reason ?? null, permissionDenials: (m.permission_denials ?? []).map((d) => d.tool_name), modelUsage: Object.fromEntries(Object.entries(m.modelUsage ?? {}).map(([k, v]) => [k, { in: v.inputTokens, out: v.outputTokens, cacheRead: v.cacheReadInputTokens, cacheWrite: v.cacheCreationInputTokens, cost: v.costUSD }])), errors: m.errors ?? null };
        resultWaiters.splice(0).forEach((w) => w(m));
      }
      if (m.type !== 'stream_event' || row.event !== 'content_block_delta') stream.push(row);
      else {
        const lastRow = stream[stream.length - 1];
        if (lastRow?.type === 'stream_event' && lastRow.event === 'content_block_delta') lastRow.n = (lastRow.n ?? 1) + 1;
        else stream.push({ ...row, n: 1 });
      }
    }
  })().catch((e) => stream.push({ t: t(), error: String(e?.message ?? e).slice(0, 300) }));

  const nextResult = (ms = 120000) => new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    resultWaiters.push((m) => {
      clearTimeout(to);
      res(m);
    });
  });
  const nextDelta = (ms = 60000) => new Promise((res) => {
    firstDeltaAt = null;
    const to = setTimeout(() => res(false), ms);
    deltaWaiters.push(() => {
      clearTimeout(to);
      res(true);
    });
  });
  const mark = (name) => turns.push({ name, t: t() });
  const COUNT = (n) => `Write the integers from 1 to ${n} separated by single spaces. Output nothing else.`;

  try {
    // T1: plain round trip
    mark('t1-pong');
    let d = nextResult();
    prompt.push(userMsg('Reply with exactly the word PONG and nothing else.'));
    await d;
    if (haikuOk === false) throw new Error('model is not haiku; stopped');
    const streamDone = q.streamInput(later);

    // T2: a tool call that canUseTool denies
    mark('t2-denied-tool');
    d = nextResult();
    later.push(userMsg('Use the Write tool to create a file named probe.txt containing the single word hi in the current directory. Use no other tool. After the attempt, reply with one short sentence.'));
    await d;

    // T3: steer with priority next while a long reply streams
    mark('t3-steer-next');
    let delta = nextDelta();
    d = nextResult();
    later.push(userMsg(COUNT(400)));
    await delta;
    await new Promise((r) => setTimeout(r, 300));
    mark('t3-steer-sent');
    later.push(userMsg('Stop counting now. Reply with exactly STEER-ACK and nothing else.', 'next'));
    await d;
    mark('t3-first-result');
    const t3b = await nextResult(45000);
    mark(t3b ? 't3-second-result' : 't3-no-second-result');

    // T4: queue with priority later while a long reply streams
    mark('t4-queue-later');
    delta = nextDelta();
    d = nextResult();
    later.push(userMsg(COUNT(300)));
    await delta;
    mark('t4-queue-sent');
    later.push(userMsg('Reply with exactly QUEUED-ACK and nothing else.', 'later'));
    await d;
    mark('t4-first-result');
    const t4b = await nextResult(45000);
    mark(t4b ? 't4-second-result' : 't4-no-second-result');

    // T5: interrupt a long reply
    mark('t5-interrupt');
    delta = nextDelta();
    d = nextResult();
    later.push(userMsg(COUNT(800)));
    await delta;
    await new Promise((r) => setTimeout(r, 500));
    mark('t5-interrupt-sent');
    const ir = await q.interrupt().then((x) => ({ keys: keys(x), stillQueued: Array.isArray(x?.still_queued) ? x.still_queued.length : null }), (e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    turns.push({ name: 't5-interrupt-response', t: t(), ir });
    await d;
    mark('t5-result');

    // effort read-back after turns
    try {
      const s = await q.getSettings();
      ev.settingsAfter = { appliedKeys: keys(s?.applied), effort: s?.applied?.effort ?? null, model: s?.applied?.model ?? null };
    } catch (e) {
      ev.settingsAfter = { error: String(e?.message ?? e).slice(0, 200) };
    }

    // idle tail so the 1 s poll can see idle
    mark('idle-tail');
    await new Promise((r) => setTimeout(r, 45000));
    mark('closing');
    prompt.end();
    later.end();
    await Promise.race([streamDone, new Promise((r) => setTimeout(r, 5000))]);
  } catch (e) {
    ev.error = String(e?.message ?? e).slice(0, 300);
  } finally {
    q.close();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 15000))]);
    await new Promise((r) => setTimeout(r, 8000)); // watch the registry entry go away
    reg.stop();
  }

  ev.sessionId = sessionId;
  ev.turns = turns;
  ev.permissionRequests = perm;
  ev.registry = reg.samples;
  ev.stream = stream;
  ev.stderr = { lines: stderrLines.length, errorLines: stderrLines.filter((l) => l.error) };
  const tr = sessionId ? findTranscript(sessionId) : null;
  ev.transcript = tr ? { dir: tr.dir, lines: transcriptShape(tr.file) } : null;
  if (tr) {
    const diskU = new Set(ev.transcript.lines.map((l) => l.uuid).filter(Boolean));
    const streamU = new Set(stream.map((r) => r.uuid).filter(Boolean));
    const by = (rows, has) => {
      const out = {};
      for (const r of rows) if (r.uuid && !has.has(r.uuid)) out[`${r.type}/${r.subtype ?? ''}`] = (out[`${r.type}/${r.subtype ?? ''}`] ?? 0) + 1;
      return out;
    };
    ev.compare = {
      streamUuids: streamU.size,
      diskUuids: diskU.size,
      both: [...streamU].filter((u) => diskU.has(u)).length,
      streamOnly: by(stream, diskU),
      diskOnly: by(ev.transcript.lines, streamU),
      streamTypes: [...new Set(stream.map((r) => `${r.type}/${r.subtype ?? r.event ?? ''}`))].sort(),
      diskTypes: [...new Set(ev.transcript.lines.map((r) => `${r.type}/${r.subtype ?? ''}`))].sort(),
    };
  }
  save('live.json', ev);
  return ev;
}

async function zero() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sdk-zero-'));
  const ev = { claude: CLAUDE, claudeVersion: claudeVersion(), configDir: CONFIG_DIR, cwd, runs: [] };
  ev.runs.push(await zeroModel('workflows-off', cwd, { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }, {}));
  ev.runs.push(await zeroModel('workflows-default', cwd, {}, {}));
  ev.runs.push(await zeroModel('workflows-off+disableAllHooks', cwd, { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }, { settings: { disableAllHooks: true } }));
  ev.stderr = { lines: stderrLines.length, errorLines: stderrLines.filter((l) => l.error) };
  save('zero.json', ev);
  return ev;
}

// One turn per configuration, keeping only the system/init frame (tools, commands, skills, plugins).
// While the CLI cannot authenticate the turn ends in a synthetic error and costs nothing.
async function initOnly() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sdk-init-'));
  const ev = { claude: CLAUDE, claudeVersion: claudeVersion(), configDir: CONFIG_DIR, cwd, env: args.env ?? 'allowlist', runs: [] };
  for (const [label, extraEnv] of [['workflows-off', { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }], ['workflows-default', {}]]) {
    const input = inbox();
    const q = query({ prompt: input, options: baseOptions(cwd, extraEnv, { maxTurns: 1, maxBudgetUsd: 0.02, canUseTool: async () => ({ behavior: 'deny', message: 'probe' }) }) });
    const run = { label };
    input.push(userMsg('Reply with exactly the word PONG and nothing else.'));
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init' && !run.tools) Object.assign(run, { model: m.model, tools: m.tools, slashCommands: m.slash_commands, skills: m.skills ?? null, plugins: (m.plugins ?? []).map((p) => p.name), sessionId: m.session_id });
      if (m.type === 'assistant') Object.assign(run, { assistantModel: m.message?.model ?? null, apiError: m.error ?? null });
      if (m.type === 'result') {
        run.result = { subtype: m.subtype, isError: m.is_error, costUsd: m.total_cost_usd };
        break;
      }
    }
    input.end();
    q.close();
    ev.runs.push(run);
  }
  save(args.env === 'inherit' ? 'init-inherit.json' : 'init.json', ev);
  return ev;
}

const PHASES = { live, zero, init: initOnly };
const ev = await PHASES[PHASE]();
console.log(`wrote ${path.join(OUT, `${PHASE}.json`)} in ${t()} ms`);
if (ev.error) console.log(`error: ${ev.error}`);
