import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASK_BACKSTOP_EXTRA_MS, CORE_TOOLS, DEFAULT_ASK_TIMEOUT_MS, DISALLOWED_TOOLS, ENTROPY_BITS as HOST_ENTROPY_BITS, ENTROPY_MIN_LENGTH as HOST_ENTROPY_MIN,
  LINE_MAX_BYTES, PINNED_PLUGINS, PINNED_SKILLS, PREVIEW_MAX_BYTES, REDACT_RULES, TEXT_CHUNK_BYTES, canonicalJson as hostCanonical, isInside,
  redactSecrets, runHost, winAbsolute,
} from '../../hosts/claude/host-core.mjs';
import { initMessage, makeFakeSdk } from '../fixtures/fake-sdk.ts';
import type { FakeQuery, Msg } from '../fixtures/fake-sdk.ts';
import { CanonicalJsonError, canonicalJson as srcCanonical } from '../../src/store/canonical-json.ts';
import { ENTROPY_BITS, ENTROPY_MIN_LENGTH, FORMAT_RULES, makeRedactor } from '../../src/store/redact.ts';

// Alpha 0.2 design §2.2, §2.3 and §6 ("host 逻辑"): hosts/claude/host-core.mjs driven through a fake
// SDK. No claude.exe, no network, no real paths: the file system is a table and every path below is
// made up.

const repo = fileURLToPath(new URL('../../', import.meta.url));
const MODEL = 'opencode-go/claude-haiku-5-5';
const HOME = 'C:\\Users\\u';
const CWD = 'C:\\t\\work';
const CONFIG = 'C:\\t\\claude\\0123456789abcdef0123';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const START = Object.freeze({
  t: 'start', ownedId: '0123456789abcdef0123', model: MODEL, cwd: CWD, configDir: CONFIG, tainted: false,
  claudeExe: 'C:\\Users\\u\\.local\\bin\\claude.exe', protectedRoots: ['C:\\repo\\src'], askTimeoutMs: 600_000,
});

// The fake disk: these names exist; the two junctions in cwd lead to .claude and to a dir outside cwd.
const EXISTING: string[] = [
  'C:\\', 'C:\\t', CWD, `${CWD}\\a.txt`, `${CWD}\\sub`, 'C:\\t\\claude', CONFIG, 'C:\\Users', HOME, `${HOME}\\.claude`,
  `${HOME}\\.claude\\settings.json`, 'C:\\repo', 'C:\\repo\\src', 'C:\\outside', 'C:\\outside\\b.txt',
];
const LINKS: readonly [string, string][] = [[`${CWD}\\link`, `${HOME}\\.claude`], [`${CWD}\\out`, 'C:\\outside']];

async function fakeRealpath(p: string): Promise<string> {
  let at = winAbsolute(p);
  if (at === null) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
  for (const [from, to] of LINKS) if (isInside(at, from)) at = to + at.slice(from.length);
  const hit = EXISTING.find((e) => e.toLowerCase() === at!.toLowerCase());
  if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return hit;
}

type Frame = Record<string, any>;

function channel() {
  const items: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(s: string) {
      items.push(s);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (;;) {
        while (items.length > 0) yield items.shift()!;
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function harness(opts: { env?: Record<string, string> } = {}) {
  const sdk = makeFakeSdk();
  const input = channel();
  const lines: string[] = [];
  const frames: Frame[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  let waiters: (() => void)[] = [];
  let n = 0;
  const done = runHost({
    query: sdk.query,
    input,
    output: (line: string) => {
      lines.push(line);
      frames.push(JSON.parse(line));
      for (const w of waiters.splice(0)) w();
    },
    schedule: (ms: number, fn: () => void) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    randomBytes: (k: number) => {
      n++;
      return Uint8Array.from({ length: k }, (_, i) => (n * 31 + i) & 0xff);
    },
    sha256: sha,
    realpath: fakeRealpath,
    env: opts.env ?? { USERPROFILE: HOME, PATH: 'C:\\Windows' },
  });
  const h = {
    sdk, input, lines, frames, timers, done,
    send: (f: unknown) => input.push(`${JSON.stringify(f)}\n`),
    get q(): FakeQuery {
      return sdk.queries[0]!;
    },
    /** The first frame (from the start) matching `pred`, once it is written. */
    async frame(pred: (f: Frame) => boolean): Promise<Frame> {
      for (;;) {
        const f = frames.find(pred);
        if (f !== undefined) return f;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    of: (t: string) => frames.filter((f) => f.t === t),
    async exit(): Promise<Frame> {
      return h.frame((f) => f.t === 'exit');
    },
  };
  return h;
}

type H = ReturnType<typeof harness>;

/** A harness whose start frame (START with `over`) went through and made the one query. */
async function started(over: Record<string, unknown> = {}, opts: { env?: Record<string, string> } = {}): Promise<H> {
  const h = harness(opts);
  h.send({ ...START, ...over });
  for (let i = 0; i < 50 && h.sdk.queries.length === 0 && h.of('exit').length === 0; i++) await tick();
  assert.equal(h.sdk.queries.length, 1, `no query: ${JSON.stringify(h.frames)}`);
  return h;
}

/** Ends a harness by a close frame. */
async function closed(h: H): Promise<void> {
  h.send({ t: 'close' });
  await h.done;
  h.input.end();
}

/** A started harness whose session already passed its init check. */
async function initialized(over: Record<string, unknown> = {}): Promise<H> {
  const h = await started(over);
  h.q.emit(initMessage());
  await h.frame((f) => f.t === 'init');
  return h;
}

let toolSeq = 0;
const toolId = () => `toolu_${String(++toolSeq).padStart(4, '0')}`;
const isDecision = (r: unknown) => r !== null && typeof r === 'object' && ['allow', 'deny'].includes((r as { behavior: string }).behavior);

// ---- start frame and SDK options --------------------------------------------------------------------

test('start: the SDK options are the fixed ones of design §2.2 with the probe changes', async () => {
  const h = await started({}, { env: { USERPROFILE: HOME, PATH: 'C:\\Windows', claude_config_dir: 'C:\\elsewhere', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus' } });
  const o = h.q.options;
  assert.equal(o.cwd, CWD);
  assert.equal(o.model, MODEL);
  assert.equal(o.pathToClaudeCodeExecutable, START.claudeExe);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.permissionMode, 'default');
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.extraArgs, { 'no-chrome': null });
  assert.equal(o.maxTurns, 50);
  assert.equal(o.persistSession, true);
  // Every non-core tool of the owned CLI 2.1.310 (probe §10 item 1), and no core tool.
  for (const t of ['Task', 'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
    'ListAgents', 'NotebookEdit', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch']) {
    assert.ok(o.disallowedTools.includes(t), t);
  }
  assert.deepEqual(o.disallowedTools.filter((t: string) => CORE_TOOLS.includes(t)), []);
  assert.deepEqual(Object.keys(o.env).sort(), ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CONFIG_DIR', 'PATH', 'USERPROFILE']);
  assert.equal(o.env.CLAUDE_CONFIG_DIR, CONFIG);
  for (const k of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(o.env[k], MODEL, k);
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal(o.hooks.PreToolUse.length, 1);
  assert.equal(typeof o.hooks.PreToolUse[0].hooks[0], 'function');
  assert.equal(o.hooks.PreToolUse[0].matcher, undefined, 'the hook sees every tool');
  // Never a bypass, an edit-accepting mode, a prompt tool, a fallback model or a budget; no system prompt or resume unasked.
  for (const k of ['allowDangerouslySkipPermissions', 'permissionPromptToolName', 'permissionPrompts', 'fallbackModel', 'maxBudgetUsd', 'systemPrompt', 'resume', 'forkSession', 'resumeSessionAt', 'allowedTools']) {
    assert.ok(!(k in o), k);
  }
  assert.ok(!JSON.stringify(o).includes('bypassPermissions') && !JSON.stringify(o).includes('acceptEdits'));
  await closed(h);
});

test('start: appendSystem, resume, fork and resumeAt become the system prompt append and the fork options', async () => {
  const h = await started({ appendSystem: 'handoff note', resume: U1, fork: true, resumeAt: U2 });
  const o = h.q.options;
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'handoff note', snapshot: false });
  assert.equal(o.resume, U1);
  assert.equal(o.forkSession, true);
  assert.equal(o.resumeSessionAt, U2);
  await closed(h);
  const fresh = await started({ appendSystem: 'note' });
  assert.deepEqual(fresh.q.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'note' });
  await closed(fresh);
  const resumed = await started({ resume: U1 });
  assert.equal(resumed.q.options.resume, U1);
  assert.ok(!('forkSession' in resumed.q.options) && !('systemPrompt' in resumed.q.options));
  await closed(resumed);
});

test('start: every field is checked; a bad one ends the host with bad-start and no query', async () => {
  const cases: [Record<string, unknown>, string, Record<string, string>?][] = [
    [{ ownedId: 'XYZ' }, 'ownedId'],
    [{ ownedId: '0123456789ABCDEF0123' }, 'ownedId'],
    [{ model: 'claude-sonnet-4-5' }, 'model'],
    [{ model: `${MODEL} ` }, 'model'],
    [{ cwd: 'work' }, 'cwd'],
    [{ cwd: '\\\\server\\share\\work' }, 'cwd'],
    [{ cwd: 'C:\\' }, 'cwd'],
    [{ cwd: 'C:\\t\\nope' }, 'cwd'],
    [{ configDir: 'C:\\t\\other\\0123456789abcdef0123' }, 'configDir'],
    [{ configDir: 'C:\\t\\claude\\abc' }, 'configDir'],
    [{ resume: 'not-a-uuid' }, 'resume'],
    [{ fork: true }, 'fork'],
    [{ resume: U1, resumeAt: U2 }, 'resumeAt'],
    [{ resume: U1, fork: true, resumeAt: 'x' }, 'resumeAt'],
    [{ appendSystem: '' }, 'appendSystem'],
    [{ tainted: 'no' }, 'tainted'],
    [{ tainted: undefined }, 'tainted'],
    [{ claudeExe: 'C:\\x\\node.exe' }, 'claudeExe'],
    [{ claudeExe: 'claude.exe' }, 'claudeExe'],
    [{ protectedRoots: ['src'] }, 'protectedRoots'],
    [{ protectedRoots: 'C:\\repo' }, 'protectedRoots'],
    [{ askTimeoutMs: 5 }, 'askTimeoutMs'],
    [{ askTimeoutMs: 1.5e6 + 0.5 }, 'askTimeoutMs'],
    [{ extra: 1 }, 'keys'],
    [{}, 'USERPROFILE', { PATH: 'C:\\Windows' }],
    [{ protectedRoots: ['C:\\t'] }, 'cwd-protected'],
  ];
  for (const [over, detail, env] of cases) {
    const h = harness(env === undefined ? {} : { env });
    h.send({ ...START, ...over });
    const exit = await h.exit();
    assert.deepEqual(exit, { t: 'exit', reason: 'bad-start', detail }, JSON.stringify(over));
    assert.equal(h.sdk.queries.length, 0);
    assert.deepEqual((await h.done).reason, 'bad-start');
    h.input.end();
  }
});

test('frames: a second start, a user frame before start, bad JSON, an unknown type and an over-long line each end the host', async () => {
  const early = harness();
  early.send({ t: 'user', uuid: U1, text: 'hi' });
  assert.deepEqual(await early.exit(), { t: 'exit', reason: 'bad-frame', detail: 'user-before-start' });
  early.input.end();

  const twice = await started();
  twice.send(START);
  assert.deepEqual(await twice.exit(), { t: 'exit', reason: 'bad-frame', detail: 'second-start' });
  assert.equal(twice.q.closed, true);
  twice.input.end();

  const json = harness();
  json.input.push('{not json\n');
  assert.equal((await json.exit()).detail, 'json');
  json.input.end();

  const unknown = harness();
  unknown.send({ t: 'allow-everything' });
  assert.equal((await unknown.exit()).detail, 'type');
  unknown.input.end();

  const long = await started();
  long.input.push(`{"t":"user","uuid":"${U1}","text":"${'x'.repeat(LINE_MAX_BYTES)}"}\n`);
  assert.deepEqual(await long.exit(), { t: 'exit', reason: 'line-too-long' });
  assert.equal(long.q.closed, true);
  assert.equal(long.q.received.length, 0, 'nothing of the long line reached the SDK');
  long.input.end();
});

// ---- user messages, lifecycle, interrupt, close -----------------------------------------------------

test('user frames go to the SDK as human messages with their uuid; a slash command or a reused uuid is refused', async () => {
  const h = await started();
  h.send({ t: 'user', uuid: U1, text: 'hello' });
  const [m] = await h.q.users(1);
  assert.deepEqual(m, { type: 'user', uuid: U1, message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, origin: { kind: 'human' } });
  h.send({ t: 'user', uuid: U2, text: '  /plugin install x' });
  assert.deepEqual(await h.frame((f) => f.uuid === U2), { t: 'lifecycle', uuid: U2, state: 'refused' });
  h.send({ t: 'user', uuid: U1, text: 'again' });
  await h.frame((f) => f.uuid === U1 && f.state === 'refused');
  h.send({ t: 'user', uuid: U3, text: 'next' });
  await h.q.users(2);
  assert.deepEqual(h.q.received.map((x) => x.uuid), [U1, U3]);
  await closed(h);
});

test('lifecycle frames come from command_lifecycle; unknown states are dropped', async () => {
  const h = await started();
  h.q.emit({ type: 'command_lifecycle', command_uuid: U1, state: 'queued' });
  h.q.emit({ type: 'command_lifecycle', command_uuid: U1, state: 'teleported' });
  h.q.emit({ type: 'command_lifecycle', command_uuid: U1, state: 'cancelled' });
  await h.frame((f) => f.state === 'cancelled');
  assert.deepEqual(h.of('lifecycle'), [{ t: 'lifecycle', uuid: U1, state: 'queued' }, { t: 'lifecycle', uuid: U1, state: 'cancelled' }]);
  await closed(h);
});

test('interrupt: the receipt\'s still_queued count is reported; a failed interrupt reports null', async () => {
  const h = await started();
  h.send({ t: 'interrupt' });
  assert.deepEqual(await h.frame((f) => f.t === 'interrupted'), { t: 'interrupted', stillQueued: 0 });
  h.q.interruptReply = { still_queued: ['a', 'b'] };
  h.send({ t: 'interrupt' });
  await h.frame((f) => f.t === 'interrupted' && f.stillQueued === 2);
  h.q.interruptReply = new Error('no');
  h.send({ t: 'interrupt' });
  await h.frame((f) => f.t === 'interrupted' && f.stillQueued === null);
  assert.equal(h.q.interrupts, 3);
  assert.equal(h.of('exit').length, 0, 'an interrupt does not end the host');
  await closed(h);
});

test('a close frame closes the query and exits; stdin EOF does the same', async () => {
  const h = await started();
  h.send({ t: 'close' });
  assert.deepEqual(await h.done, { reason: 'closed', detail: null });
  assert.equal(h.q.closed, true);
  assert.deepEqual(h.frames.at(-1), { t: 'exit', reason: 'closed' });
  h.input.end();

  const eof = await started();
  eof.input.end();
  assert.equal((await eof.done).reason, 'stdin-eof');
  assert.equal(eof.q.closed, true);
  assert.deepEqual(eof.frames.at(-1), { t: 'exit', reason: 'stdin-eof' });
});

test('the SDK stream ending or throwing ends the host', async () => {
  const ended = await started();
  ended.q.end();
  assert.equal((await ended.done).reason, 'sdk-ended');
  ended.input.end();
  const failed = await started();
  failed.q.fail(new Error('boom'));
  assert.equal((await failed.done).reason, 'sdk-error');
  failed.input.end();
});

// ---- the PreToolUse hook ----------------------------------------------------------------------------

test('protected paths are denied by the hook with no card, through ~, a junction, case, trailing dots and missing names', async () => {
  const h = await started();
  const calls: [string, Record<string, unknown>][] = [
    ['Read', { file_path: `${HOME}\\.claude\\settings.json` }],
    ['Read', { file_path: '~/.claude/settings.json' }],
    ['Read', { file_path: `${CWD}\\link\\settings.json` }],
    ['Read', { file_path: 'link/settings.json' }],
    ['Read', { file_path: 'c:\\USERS\\U\\.CLAUDE\\settings.json' }],
    ['Read', { file_path: `${HOME}\\.claude.\\settings.json` }],
    ['Write', { file_path: `${HOME}\\.claude\\new\\deeper\\x.txt`, content: 'x' }],
    ['Write', { file_path: 'C:\\repo\\src\\a.ts', content: 'x' }],
    ['Edit', { file_path: `${CONFIG}\\projects\\p\\s.jsonl`, old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: `${HOME}\\.dsh\\x` }],
    ['Read', { file_path: `${HOME}\\.orchestra\\x` }],
    ['Glob', { pattern: '**/*', path: 'C:\\' }],
    ['Glob', { pattern: 'C:/Users/u/.claude/**' }],
    ['Glob', { pattern: 'C:/**/*.json' }],
    ['Grep', { pattern: 'token', path: 'C:\\Users' }],
    ['Grep', { pattern: 'token', path: CWD, glob: 'C:/repo/src/**' }],
    // C:\t holds this session's config dir.
    ['Glob', { pattern: '../**' }],
  ];
  for (const [name, input] of calls) {
    const id = toolId();
    const call = await h.q.callTool(name, input, id);
    assert.equal(call.decision, 'deny', `${name} ${JSON.stringify(input)}`);
    assert.equal(call.permission, null);
    assert.deepEqual(await h.frame((f) => f.toolUseId === id), { t: 'denied-auto', toolUseId: id, name, why: 'protected' });
  }
  assert.equal(h.of('ask').length, 0, 'no card for a protected path');
  await closed(h);
});

test('Read, Glob and Grep inside cwd run by the CLI default; outside cwd or through a junction out they ask', async () => {
  const h = await started();
  for (const [name, input] of [['Read', { file_path: `${CWD}\\a.txt` }], ['Read', { file_path: 'a.txt' }], ['Read', { file_path: 'sub\\new.txt' }], ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { pattern: 'sub/*.ts', path: CWD }], ['Grep', { pattern: 'x' }], ['Grep', { pattern: 'x', path: 'sub', glob: '*.md' }]] as const) {
    const call = await h.q.callTool(name, input, toolId());
    assert.equal(call.decision, 'default', `${name} ${JSON.stringify(input)}`);
    assert.equal(call.permission, null);
  }
  assert.equal(h.frames.length, 0, 'nothing to ask or report');
  for (const [name, input] of [['Read', { file_path: 'C:\\outside\\b.txt' }], ['Read', { file_path: `${CWD}\\out\\b.txt` }], ['Read', { file_path: '..\\x.txt' }],
    ['Glob', { pattern: '../outside/*.txt', path: 'C:\\outside' }], ['Grep', { pattern: 'x', path: 'C:\\outside' }], ['Read', { file_path: '\\\\server\\share\\x' }], ['Read', {}]] as const) {
    const id = toolId();
    const call = await h.q.callTool(name, input, id);
    assert.equal(call.decision, 'ask', `${name} ${JSON.stringify(input)}`);
    const ask = await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
    assert.equal(ask.risk, 'read');
    assert.equal(ask.toolName, name);
  }
  await closed(h);
});

test('a tainted session asks even for Read inside cwd', async () => {
  const h = await started({ tainted: true });
  const id = toolId();
  const call = await h.q.callTool('Read', { file_path: `${CWD}\\a.txt` }, id);
  assert.equal(call.decision, 'ask');
  await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
  await closed(h);
});

test('background shell commands are denied; PowerShell is a shell exactly like Bash and asks with its full command', async () => {
  const h = await started();
  for (const name of ['Bash', 'PowerShell']) {
    for (const bg of [true, 'true', 1]) {
      const id = toolId();
      const call = await h.q.callTool(name, { command: 'Start-Sleep 100', run_in_background: bg }, id);
      assert.equal(call.decision, 'deny');
      assert.deepEqual(await h.frame((f) => f.toolUseId === id), { t: 'denied-auto', toolUseId: id, name, why: 'background' });
    }
    const id = toolId();
    const call = await h.q.callTool(name, { command: 'Get-ChildItem C:\\outside | Remove-Item', run_in_background: false, timeout: 5000, description: 'clean' }, id);
    assert.equal(call.decision, 'ask');
    const ask = await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
    assert.equal(ask.risk, 'shell');
    assert.equal(ask.preview, 'command: Get-ChildItem C:\\outside | Remove-Item\ndescription: clean\nrun_in_background: false\ntimeout: 5000');
  }
  await closed(h);
});

test('every tool outside the core set is denied as disallowed', async () => {
  const h = await started();
  for (const name of ['WebFetch', 'WebSearch', 'Skill', 'Task', 'Agent', 'AskUserQuestion', 'NotebookEdit', 'CronCreate', 'mcp__claude-in-chrome__navigate', 'mcp__computer-use__click', 'SomeFutureTool']) {
    const id = toolId();
    const call = await h.q.callTool(name, { url: 'https://example.test' }, id);
    assert.equal(call.decision, 'deny', name);
    assert.equal(call.permission, null);
    assert.deepEqual(await h.frame((f) => f.toolUseId === id), { t: 'denied-auto', toolUseId: id, name, why: 'disallowed' });
  }
  // canUseTool reached by any other route judges the same.
  const id = toolId();
  const r = await h.q.options.canUseTool('WebFetch', { url: 'https://example.test' }, { signal: new AbortController().signal, toolUseID: id });
  assert.deepEqual(r, { behavior: 'deny', message: 'This tool is not available in this session.' });
  await closed(h);
});

// ---- canUseTool and perm frames ---------------------------------------------------------------------

async function askWrite(h: H, input: Record<string, unknown> = { file_path: `${CWD}\\new.txt`, content: 'hi\n' }) {
  const id = toolId();
  const call = await h.q.callTool('Write', input, id);
  assert.equal(call.decision, 'ask');
  const ask = await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
  return { id, call, ask, input };
}

test('allow with the right digest: updatedInput is the very input, with no permission suggestions', async () => {
  const h = await started();
  const { id, call, ask, input } = await askWrite(h);
  assert.match(ask.reqId, /^[0-9a-f]{32}$/);
  assert.equal(ask.digest, sha(srcCanonical({ toolName: 'Write', toolUseId: id, input })), 'digest = sha256(canonicalJSON({toolName, toolUseId, input}))');
  assert.equal(ask.inputBytes, Buffer.byteLength(srcCanonical(input)));
  assert.equal(ask.risk, 'write');
  assert.equal(ask.tooLong, false);
  assert.equal(ask.redactions, 0);
  h.send({ t: 'perm', reqId: ask.reqId, allow: true, digest: ask.digest });
  const r = (await call.permission!) as { behavior: string; updatedInput: unknown };
  assert.deepEqual(Object.keys(r).sort(), ['behavior', 'updatedInput']);
  assert.equal(r.behavior, 'allow');
  assert.equal(r.updatedInput, input, 'the same object the CLI asked about');
  await closed(h);
});

test('deny: the call is denied and the session goes on', async () => {
  const h = await initialized();
  const { call, ask } = await askWrite(h);
  h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
  assert.deepEqual(await call.permission!, { behavior: 'deny', message: 'The user did not allow this tool call.' });
  h.q.emit({ type: 'assistant', uuid: U2, message: { model: MODEL, content: [{ type: 'text', text: 'ok, not writing' }] }, parent_tool_use_id: null });
  h.q.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.001, modelUsage: { [MODEL]: {} }, user_message_uuid: U1 });
  assert.deepEqual(await h.frame((f) => f.t === 'result'), { t: 'result', subtype: 'success', costUsd: 0.001, uuid: U1 });
  assert.deepEqual(h.of('text'), [{ t: 'text', uuid: U2, chunk: 'ok, not writing' }]);
  h.send({ t: 'user', uuid: U3, text: 'next' });
  await h.q.users(1);
  assert.equal(h.of('exit').length, 0);
  await closed(h);
});

test('a digest that does not match is a deny, even with allow: true', async () => {
  const h = await started();
  const { call, ask } = await askWrite(h);
  h.send({ t: 'perm', reqId: ask.reqId, allow: true, digest: 'f'.repeat(64) });
  assert.deepEqual(await call.permission!, { behavior: 'deny', message: 'The approval did not match this tool call, so it was not allowed.' });
  await closed(h);
});

test('a perm frame for an unknown reqId is dropped; the open ask stays answerable', async () => {
  const h = await started();
  const { call, ask } = await askWrite(h);
  h.send({ t: 'perm', reqId: 'a'.repeat(32), allow: true, digest: ask.digest });
  await tick();
  assert.equal(h.of('exit').length, 0);
  h.send({ t: 'perm', reqId: ask.reqId, allow: true, digest: ask.digest });
  assert.equal(((await call.permission!) as { behavior: string }).behavior, 'allow');
  // A second answer to the same reqId is unknown by then and dropped too.
  h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
  await tick();
  assert.equal(h.of('exit').length, 0);
  // A malformed perm frame is a broken orchestrad: it ends the host.
  h.send({ t: 'perm', reqId: ask.reqId, allow: 'yes', digest: ask.digest });
  assert.deepEqual(await h.exit(), { t: 'exit', reason: 'bad-frame', detail: 'perm' });
  h.input.end();
});

test('the backstop timeout is orchestrad\'s timeout plus 60 s and denies; the default is 30 minutes plus 60 s', async () => {
  const h = await started();
  const { call, ask } = await askWrite(h);
  const live = h.timers.filter((t) => !t.cancelled);
  assert.deepEqual(live.map((t) => t.ms), [START.askTimeoutMs + ASK_BACKSTOP_EXTRA_MS]);
  live[0]!.fn();
  assert.deepEqual(await call.permission!, { behavior: 'deny', message: 'The user did not answer in time, so this tool call was not allowed.' });
  assert.deepEqual(await h.frame((f) => f.t === 'ask-gone'), { t: 'ask-gone', reqId: ask.reqId });
  // A late allow meets an unknown reqId.
  h.send({ t: 'perm', reqId: ask.reqId, allow: true, digest: ask.digest });
  await tick();
  assert.equal(h.of('exit').length, 0);
  await closed(h);

  const d = await started({ askTimeoutMs: undefined });
  await askWrite(d);
  assert.deepEqual(d.timers.map((t) => t.ms), [DEFAULT_ASK_TIMEOUT_MS + ASK_BACKSTOP_EXTRA_MS]);
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 30 * 60 * 1000);
  await closed(d);
});

test('an answered ask cancels its backstop timer', async () => {
  const h = await started();
  const { call, ask } = await askWrite(h);
  h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
  await call.permission;
  assert.deepEqual(h.timers.map((t) => t.cancelled), [true]);
  await closed(h);
});

test('an aborted signal sends ask-gone and denies', async () => {
  const h = await started();
  const { call, ask } = await askWrite(h);
  call.abort();
  assert.deepEqual(await call.permission!, { behavior: 'deny', message: 'This tool call was cancelled.' });
  assert.deepEqual(await h.frame((f) => f.t === 'ask-gone'), { t: 'ask-gone', reqId: ask.reqId });
  await closed(h);
});

test('canUseTool never answers null: open asks are denied when the host ends, and every answer is allow or deny', async () => {
  const h = await started();
  const a = await askWrite(h);
  const b = await askWrite(h, { file_path: `${CWD}\\b.txt`, content: 'b' });
  h.input.end();
  const results = await Promise.all([a.call.permission!, b.call.permission!]);
  for (const r of results) assert.deepEqual(r, { behavior: 'deny', message: 'The session is ending, so this tool call was not allowed.' });
  assert.equal((await h.done).reason, 'stdin-eof');
  // Once the host has ended, a late call is denied at once.
  const late = await h.q.options.canUseTool('Write', { file_path: `${CWD}\\c.txt`, content: 'c' }, { signal: new AbortController().signal, toolUseID: toolId() });
  assert.ok(isDecision(late));
  assert.equal(late.behavior, 'deny');
});

test('an input with no canonical form is denied without a card', async () => {
  const h = await started();
  const id = toolId();
  const call = await h.q.callTool('Write', { file_path: `${CWD}\\x.txt`, content: 'x', ratio: 0.5 }, id);
  assert.equal(call.decision, 'ask');
  assert.deepEqual(await call.permission!, { behavior: 'deny', message: 'This tool call could not be shown to the user, so it was not allowed.' });
  assert.deepEqual(await h.frame((f) => f.toolUseId === id), { t: 'denied-auto', toolUseId: id, name: 'Write', why: 'bad-input' });
  assert.equal(h.of('ask').length, 0);
  await closed(h);
});

// ---- previews ---------------------------------------------------------------------------------------

test('preview: every field, invisible characters escaped not removed, secrets redacted and counted', async () => {
  const h = await started();
  const input = { command: 'echo "a\u202Eb\u200Bc\u0007" password=hunter2\r\nnext\tline', timeout: 1000, description: 'd\u2066' };
  const id = toolId();
  await h.q.callTool('PowerShell', input, id);
  const ask = await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
  assert.equal(ask.preview, 'command: echo "a\\u202Eb\\u200Bc\\u0007" password=[redacted:secret-param]\r\nnext\tline\ndescription: d\\u2066\ntimeout: 1000');
  assert.equal(ask.redactions, 1);
  assert.equal(ask.tooLong, false);
  await closed(h);
});

test('a large Write: the ask frame stays under 64 KiB, the preview under 16 KiB, tooLong is set', async () => {
  const h = await started();
  const content = '\\"'.repeat(40_000);
  const { ask } = await askWrite(h, { file_path: `${CWD}\\big.txt`, content });
  assert.equal(ask.tooLong, true);
  assert.ok(Buffer.byteLength(ask.preview) <= PREVIEW_MAX_BYTES);
  assert.ok(ask.preview.startsWith('content: \\"\\"'));
  assert.ok(ask.inputBytes > 160_000);
  const line = h.lines.find((l) => l.includes(ask.reqId) && l.includes('"t":"ask"'))!;
  assert.ok(Buffer.byteLength(line) - 1 <= LINE_MAX_BYTES, `${Buffer.byteLength(line)} bytes`);
  const small = await askWrite(h, { file_path: `${CWD}\\s.txt`, content: 'é'.repeat(8000) });
  assert.equal(small.ask.tooLong, false);
  await closed(h);
});

// ---- the startup checks and the model guard ---------------------------------------------------------

test('init: pinned skills and plugins pass and the init frame goes out once per session id', async () => {
  const h = await started();
  h.q.emit(initMessage({ skills: [...PINNED_SKILLS], plugins: PINNED_PLUGINS.map((name: string) => ({ name, path: `p/${name}` })) }));
  h.q.emit(initMessage({ skills: [...PINNED_SKILLS] }));
  const init = await h.frame((f) => f.t === 'init');
  assert.deepEqual(init, {
    t: 'init', sessionId: '11111111-2222-4333-8444-555555555555', model: MODEL, permissionMode: 'default', tools: ['Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'Write'],
    mcpServers: [], plugins: [...PINNED_PLUGINS], skills: [...PINNED_SKILLS],
  });
  await tick();
  assert.equal(h.of('init').length, 1);
  assert.equal(h.of('exit').length, 0);
  await closed(h);
});

test('init: a wrong model or permission mode, a browser or disallowed tool, an MCP server, an extra skill or plugin each stop the session', async () => {
  const cases: [Msg, string][] = [
    [{ model: 'claude-sonnet-4-5' }, 'model'],
    [{ model: 'opencode-go/claude-haiku-5-5-preview' }, 'model'],
    [{ permissionMode: 'auto' }, 'permission-mode'],
    [{ permissionMode: 'acceptEdits' }, 'permission-mode'],
    [{ session_id: 'x' }, 'session-id'],
    [{ tools: ['Read', 'mcp__claude-in-chrome__navigate'] }, 'tools'],
    [{ tools: ['Read', 'mcp__Claude_Browser__navigate'] }, 'tools'],
    [{ tools: ['Read', 'mcp__computer-use__screenshot'] }, 'tools'],
    [{ tools: ['Read', 'mcp__remote-devices__computer_click'] }, 'tools'],
    [{ tools: ['Read', 'WebFetch'] }, 'tools'],
    [{ tools: ['Read', 'Skill'] }, 'tools'],
    [{ mcp_servers: [{ name: 'x', status: 'connected' }] }, 'mcp-servers'],
    [{ skills: ['dataviz', 'schedule'] }, 'skills'],
    [{ skills: undefined }, 'skills'],
    [{ plugins: [{ name: 'cc-plugin-agents-md', path: 'a' }, { name: 'my-plugin', path: 'b' }] }, 'plugins'],
  ];
  for (const [over, check] of cases) {
    const h = await started();
    h.q.emit(initMessage(over));
    assert.deepEqual(await h.exit(), { t: 'exit', reason: 'safety-stop', detail: check }, JSON.stringify(over));
    assert.equal(h.q.interrupts, 1, 'interrupt');
    assert.equal(h.q.closed, true, 'close');
    assert.equal(h.of('init').length, 0);
    h.input.end();
  }
});

test('the running model guard: an assistant message or a modelUsage key on another model stops the session', async () => {
  const swap = await initialized();
  swap.q.emit({ type: 'assistant', uuid: U1, message: { model: 'claude-opus-4-1', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null });
  assert.deepEqual(await swap.exit(), { t: 'exit', reason: 'safety-stop', detail: 'model' });
  assert.equal(swap.of('text').length, 0, 'nothing of the other model went out');
  swap.input.end();

  const usage = await initialized();
  usage.q.emit({ type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: { [MODEL]: {}, 'claude-sonnet-4-5': {} } });
  assert.deepEqual(await usage.exit(), { t: 'exit', reason: 'safety-stop', detail: 'model' });
  usage.input.end();

  // The CLI's own synthetic message (an API error) names no model that ran.
  const synthetic = await initialized();
  synthetic.q.emit({ type: 'assistant', uuid: U1, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] }, parent_tool_use_id: null });
  await synthetic.frame((f) => f.t === 'text');
  assert.equal(synthetic.of('exit').length, 0);
  await closed(synthetic);

  const early = await started();
  early.q.emit({ type: 'assistant', uuid: U1, message: { model: MODEL, content: [] }, parent_tool_use_id: null });
  assert.deepEqual(await early.exit(), { t: 'exit', reason: 'safety-stop', detail: 'no-init' });
  early.input.end();
});

test('a turn that hits maxTurns ends with its result; the session goes on', async () => {
  const h = await initialized();
  h.send({ t: 'user', uuid: U1, text: 'a long job' });
  await h.q.users(1);
  h.q.emit({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.01, user_message_uuid: U1 });
  assert.deepEqual(await h.frame((f) => f.t === 'result'), { t: 'result', subtype: 'error_max_turns', costUsd: 0.01, uuid: U1 });
  h.send({ t: 'user', uuid: U2, text: 'go on' });
  await h.q.users(2);
  assert.equal(h.of('exit').length, 0);
  await closed(h);
});

// ---- text, tool frames ------------------------------------------------------------------------------

test('long text is split into chunks of at most 2 KB on code point boundaries, never cut', async () => {
  const h = await initialized();
  const text = `${'a'.repeat(3000)}${'汉'.repeat(1000)}${'😀'.repeat(600)}é`;
  h.q.emit({ type: 'assistant', uuid: U1, message: { model: MODEL, content: [{ type: 'text', text }, { type: 'tool_use', id: 'toolu_x', name: 'Write', input: {} }] }, parent_tool_use_id: null });
  await h.frame((f) => f.t === 'tool');
  const chunks = h.of('text');
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.equal(c.uuid, U1);
    assert.ok(Buffer.byteLength(c.chunk) <= TEXT_CHUNK_BYTES, `${Buffer.byteLength(c.chunk)}`);
    assert.ok(c.chunk.isWellFormed());
  }
  assert.equal(chunks.map((c) => c.chunk).join(''), text);
  assert.deepEqual(h.of('tool'), [{ t: 'tool', toolUseId: 'toolu_x', name: 'Write' }]);
  await closed(h);
});

// ---- shared vectors: canonical JSON and redaction ---------------------------------------------------

const reasonOf = (fn: () => unknown): string => {
  try {
    return `ok:${String(fn())}`;
  } catch (e) {
    return `refuse:${e instanceof CanonicalJsonError ? e.reason : (e as { reason?: string }).reason}`;
  }
};

test('canonical JSON: the host and src/store/canonical-json.ts agree on every shared vector', () => {
  const v = JSON.parse(fs.readFileSync(`${repo}test/fixtures/canonical-json-vectors.json`, 'utf8')) as { ok: { in: string; out: string }[]; refuse: { in: string; reason: string }[] };
  assert.ok(v.ok.length >= 10 && v.refuse.length >= 8);
  for (const c of v.ok) {
    assert.equal(srcCanonical(JSON.parse(c.in)), c.out, `src ${c.in}`);
    assert.equal(hostCanonical(JSON.parse(c.in)), c.out, `host ${c.in}`);
  }
  for (const c of v.refuse) {
    assert.equal(reasonOf(() => srcCanonical(JSON.parse(c.in))), `refuse:${c.reason}`, `src ${c.in}`);
    assert.equal(reasonOf(() => hostCanonical(JSON.parse(c.in))), `refuse:${c.reason}`, `host ${c.in}`);
  }
});

test('canonical JSON: the host and src agree on values JSON text cannot carry', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: unknown = 1;
  for (let i = 0; i < 64; i++) deep = [deep];
  let deeper: unknown = deep;
  deeper = [deeper];
  const values: unknown[] = [
    undefined, () => 1, Symbol('s'), 10n, new Date(0), new Map(), [1, , 2], Object.assign([1], { x: 1 }), cyclic,
    Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }), { [Symbol('k')]: 1 }, deep, deeper,
    Object.create(null), Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }), { a: undefined }, -0, Number.NaN,
  ];
  values.forEach((value, i) => assert.equal(reasonOf(() => hostCanonical(value)), reasonOf(() => srcCanonical(value)), `value ${i}`));
});

test('redaction: the preview redaction and src/store/redact.ts agree on every shared vector, and their patterns are the same', () => {
  const v = JSON.parse(fs.readFileSync(`${repo}test/fixtures/redact-vectors.json`, 'utf8')) as { vectors: { text: string; out: string; count: number }[] };
  const src = makeRedactor({ env: {} });
  for (const c of v.vectors) {
    const s = src.redact({ text: c.text });
    assert.equal(s.text, c.out, `src ${c.text}`);
    assert.equal(s.verdict.known + s.verdict.entropy + Object.values(s.verdict.format).reduce((a, b) => a + b, 0), c.count, `src count ${c.text}`);
    assert.deepEqual(redactSecrets(c.text), { text: c.out, count: c.count }, `host ${c.text}`);
  }
  const shape = (rules: readonly { id: string; re: RegExp; keep?: number }[]) => rules.map((r) => [r.id, r.re.source, r.re.flags, r.keep ?? null]);
  assert.deepEqual(shape(REDACT_RULES), shape(FORMAT_RULES));
  assert.equal(HOST_ENTROPY_BITS, ENTROPY_BITS);
  assert.equal(HOST_ENTROPY_MIN, ENTROPY_MIN_LENGTH);
});

// ---- the entry ----------------------------------------------------------------------------------------

test('host.mjs: without the SDK it says sdk-missing; with it, stdin EOF before a start ends it with stdin-eof', async () => {
  const sdkThere = fs.existsSync(`${repo}hosts/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
  const child = spawn(process.execPath, [`${repo}hosts/claude/host.mjs`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '' } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    out += d;
  });
  child.stdin.end();
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.deepEqual(out.trim().split('\n').map((l) => JSON.parse(l)), [{ t: 'exit', reason: sdkThere ? 'stdin-eof' : 'sdk-missing' }]);
  assert.equal(code, sdkThere ? 0 : 2);
  assert.ok(DISALLOWED_TOOLS.length >= 20);
});

// ---- orchestra app: magpie models and the owned work root (2026-11-02) ------------------------------

test('models: zcode/* and opencode-go/* start, codex/* and others do not; the small fast model of the env passes the running guard', async () => {
  for (const model of ['zcode/GLM-5.3', 'opencode-go/glm-5.3']) {
    const h = await started({ model });
    assert.equal(h.q.options.model, model);
    assert.equal(h.q.options.env.ANTHROPIC_MODEL, model);
    await closed(h);
  }
  for (const model of ['codex/gpt-6.1-sol', 'anthropic/claude', 'zcode/', 'zcode/a b']) {
    const h = harness();
    h.send({ ...START, model });
    assert.deepEqual(await h.exit(), { t: 'exit', reason: 'bad-start', detail: 'model' }, model);
    h.input.end();
  }
  const env = { USERPROFILE: HOME, PATH: 'C:\\Windows', ANTHROPIC_SMALL_FAST_MODEL: 'zcode/GLM-5-Turbo' };
  const h = await started({}, { env });
  h.q.emit(initMessage());
  await h.frame((f) => f.t === 'init');
  h.q.emit({ type: 'assistant', uuid: U1, message: { model: 'zcode/GLM-5-Turbo', content: [{ type: 'text', text: 'side call' }] }, parent_tool_use_id: null });
  h.q.emit({ type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: { [MODEL]: {}, 'zcode/GLM-5-Turbo': {} } });
  await h.frame((f) => f.t === 'result');
  assert.equal(h.of('exit').length, 0);
  h.q.emit({ type: 'assistant', uuid: U2, message: { model: 'zcode/GLM-5.3', content: [] }, parent_tool_use_id: null });
  assert.deepEqual(await h.exit(), { t: 'exit', reason: 'safety-stop', detail: 'model' });
  h.input.end();
});

test('an ask frame names the places the call reaches and a one-line subject, besides its preview', async () => {
  const h = await started();
  const w = await askWrite(h, { file_path: 'sub\\new.txt', content: 'x' });
  assert.deepEqual([w.ask.paths, w.ask.unplaced, w.ask.subject], [[`${CWD}\\sub\\new.txt`], false, `${CWD}\\sub\\new.txt`]);
  const id = toolId();
  await h.q.callTool('PowerShell', { command: 'Set-Content a.txt hi\nGet-Content a.txt' }, id);
  const sh = await h.frame((f) => f.t === 'ask' && f.toolUseId === id);
  assert.deepEqual([sh.paths, sh.subject], [[], 'Set-Content a.txt hi']);
  await closed(h);
});

test('the owned work root: a cwd in <protected root>\\work\\<id> starts; only its own subtree is open, the rest of the root stays protected', async () => {
  // C:\t holds this session's config dir; it is protected here as orchestrad protects its data dir.
  const added = ['C:\\t\\work\\s1', 'C:\\t\\work\\s2', `${HOME}\\.claude\\work`, `${HOME}\\.claude\\work\\x`];
  EXISTING.push(...added);
  try {
    const h = await started({ cwd: 'C:\\t\\work\\s1', protectedRoots: ['C:\\t'] });
    const inside = await h.q.callTool('Write', { file_path: 'C:\\t\\work\\s1\\a.txt', content: 'x' }, toolId());
    assert.equal(inside.decision, 'ask');
    const read = await h.q.callTool('Read', { file_path: 'a.txt' }, toolId());
    assert.equal(read.decision, 'default');
    for (const p of ['C:\\t\\work\\s2\\x.txt', 'C:\\t\\work\\x.txt', 'C:\\t\\owned\\x.json', '..\\s2\\x.txt']) {
      const id = toolId();
      const call = await h.q.callTool('Read', { file_path: p }, id);
      assert.equal(call.decision, 'deny', p);
      assert.equal((await h.frame((f) => f.toolUseId === id)).why, 'protected');
    }
    await closed(h);
    // The hard roots never open: a cwd in .claude\work\x is refused whatever else is passed.
    const hard = harness();
    hard.send({ ...START, cwd: `${HOME}\\.claude\\work\\x` });
    assert.equal((await hard.exit()).detail, 'cwd-protected');
    hard.input.end();
  } finally {
    EXISTING.splice(EXISTING.length - added.length, added.length);
  }
});
