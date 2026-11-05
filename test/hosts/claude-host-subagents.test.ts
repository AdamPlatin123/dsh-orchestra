import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { AGENT_TYPES, DISALLOWED_TOOLS, DISPATCH_SERVER, DISPATCH_TOOL_ID, SUBAGENT_TOOLS, agentInputOk, disallowedFor, initProblem, runHost, sdkOptions, parseStart } from '../../hosts/claude/host-core.mjs';
import { initMessage, makeFakeSdk } from '../fixtures/fake-sdk.ts';
import type { FakeQuery } from '../fixtures/fake-sdk.ts';
import {
  BASH_TASK, MODEL, REPLY, ROOT_CALL, SUB_CALL, SUB_WORDS, TASK, bashEnded, bashStarted, rootCall, subAssistant, subResult, subText, subToolUse, taskNotification, taskProgress, taskStarted, taskUpdated,
} from '../fixtures/claude-subagent-frames.ts';

// hosts/claude/host-core.mjs with sub-agents let through, driven through the fake SDK as it was measured (the fixture).
// The rule these tests hold: a session whose tree is not in a Job gets none, every sub-agent call comes to the same gate
// as the session's own, and nothing a sub-agent says leaves the host.

const HOME = 'C:\\Users\\u';
const CWD = 'C:\\t\\work';
const CONFIG = 'C:\\t\\claude\\0123456789abcdef0123';
const START = Object.freeze({
  t: 'start', ownedId: '0123456789abcdef0123', model: MODEL, cwd: CWD, configDir: CONFIG, tainted: false,
  claudeExe: 'C:\\x\\claude.exe', protectedRoots: ['C:\\repo\\src'], askTimeoutMs: 600_000, subagents: true,
});
const ASKED = { description: 'ping once', prompt: 'run a ping', subagent_type: 'general-purpose' };

type Frame = Record<string, any>;

function harness() {
  const sdk = makeFakeSdk();
  const items: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const input = {
    async *[Symbol.asyncIterator]() {
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
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  const done = runHost({
    query: sdk.query, input, output: (l: string) => {
      frames.push(JSON.parse(l));
      for (const w of waiters.splice(0)) w();
    },
    schedule: () => () => {}, randomBytes: (k: number) => crypto.randomBytes(k), sha256: (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex'),
    realpath: async (p: string) => {
      if (p === CWD || p.startsWith(`${CWD}\\`) || p === 'C:\\repo' || p === 'C:\\repo\\src' || p === HOME) return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    env: { USERPROFILE: HOME },
  });
  return {
    sdk, frames, done,
    send: (f: unknown) => {
      items.push(`${JSON.stringify(f)}\n`);
      wake?.();
    },
    get q(): FakeQuery {
      return sdk.queries[0]!;
    },
    async frame(pred: (f: Frame) => boolean): Promise<Frame> {
      for (;;) {
        const f = frames.find(pred);
        if (f !== undefined) return f;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    of: (t: string) => frames.filter((f) => f.t === t),
    end() {
      ended = true;
      wake?.();
    },
  };
}
type H = ReturnType<typeof harness>;

const tick = () => new Promise<void>((r) => setImmediate(r));

/** A session past its init check; a sub-agent's frames, once the host wrote everything it was handed. */
async function session(over: Record<string, unknown> = {}): Promise<H> {
  const h = harness();
  h.send({ ...START, ...over });
  for (let i = 0; i < 50 && h.sdk.queries.length === 0; i++) await tick();
  h.q.emit(initMessage({ tools: [...(over.subagents === false ? [] : ['Task']), 'Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'Write'], model: MODEL }));
  await h.frame((f) => f.t === 'init');
  return h;
}
async function closed(h: H) {
  h.send({ t: 'close' });
  await h.done;
  h.end();
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test('without a Job nothing changes: Task and Agent stay disallowed and refused; with one they alone come off the list', async () => {
  const off = parseStart({ ...START, subagents: undefined }, { USERPROFILE: HOME });
  assert.ok(off.ok);
  assert.equal(off.start.subagents, false, 'a start frame that says nothing has no sub-agents');
  assert.deepEqual(sdkOptions(off.start, {}, { preToolUse: () => ({}), canUseTool: () => ({}) }).disallowedTools, [...DISALLOWED_TOOLS]);
  const on = parseStart({ ...START }, { USERPROFILE: HOME });
  assert.ok(on.ok);
  const list = sdkOptions(on.start, {}, { preToolUse: () => ({}), canUseTool: () => ({}) }).disallowedTools;
  assert.deepEqual(DISALLOWED_TOOLS.filter((t: string) => !list.includes(t)).sort(), [...SUBAGENT_TOOLS].sort());
  for (const t of ['SendMessage', 'TaskStop', 'TaskOutput', 'WebFetch', 'Monitor', 'Workflow', 'ListAgents']) assert.ok(list.includes(t), t);
  assert.deepEqual(parseStart({ ...START, subagents: 'yes' }, { USERPROFILE: HOME }), { ok: false, field: 'subagents' });
  const m = { ...initMessage({ model: MODEL }), tools: ['Task', 'Read'] };
  assert.equal(initProblem(m, MODEL), 'tools', 'a session without sub-agents that is offered Task stops');
  assert.equal(initProblem(m, MODEL, true), null);
  assert.equal(initProblem({ ...m, tools: ['Task', 'WebFetch'] }, MODEL, true), 'tools', 'the rest of the list holds');
  assert.deepEqual(disallowedFor(false), DISALLOWED_TOOLS);

  const h = await session({ subagents: false });
  const call = await h.q.callTool('Agent', ASKED, 'c1');
  assert.equal(call.decision, 'deny');
  assert.deepEqual(await h.frame((f) => f.toolUseId === 'c1'), { t: 'denied-auto', toolUseId: 'c1', name: 'Agent', why: 'disallowed' });
  await closed(h);
});

test('starting a sub-agent is a card: its whole prompt is shown, in a tainted session too; nothing runs on a refusal', async () => {
  for (const tainted of [false, true]) {
    const h = await session({ tainted });
    const call = await h.q.callTool('Agent', ASKED, 'c1');
    assert.equal(call.decision, 'ask');
    const ask = await h.frame((f) => f.t === 'ask');
    assert.equal(ask.toolName, 'Agent');
    assert.equal(ask.risk, 'other');
    assert.match(ask.preview, /prompt: run a ping/);
    assert.equal(ask.agentId, undefined, 'the session asks, no sub-agent');
    h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
    assert.equal((await call.permission)!.behavior, 'deny');
    await closed(h);
  }
});

test('an Agent call outside what was measured is refused without a card: isolation, mode, name, another type, a model no variable pins', async () => {
  for (const bad of [
    { ...ASKED, isolation: 'remote' }, { ...ASKED, isolation: 'worktree' }, { ...ASKED, mode: 'bypassPermissions' }, { ...ASKED, name: 'x' }, { ...ASKED, team_name: 'x' },
    { ...ASKED, subagent_type: 'fork' }, { ...ASKED, subagent_type: 'statusline-setup' }, { ...ASKED, subagent_type: 7 }, { ...ASKED, model: 'fable' }, { ...ASKED, model: 'gpt' },
    { ...ASKED, run_in_background: 'yes' }, { prompt: 'x' }, { description: 'x' },
  ]) assert.equal(agentInputOk(bad), false, JSON.stringify(bad));
  for (const good of [ASKED, { description: 'd', prompt: 'p' }, { ...ASKED, run_in_background: false }, { ...ASKED, run_in_background: true }, { ...ASKED, model: 'sonnet' }, { ...ASKED, model: 'haiku' }, { ...ASKED, model: 'opus' }]) {
    assert.equal(agentInputOk(good), true, JSON.stringify(good));
  }
  for (const t of AGENT_TYPES) assert.equal(agentInputOk({ ...ASKED, subagent_type: t }), true, t);

  const h = await session();
  const call = await h.q.callTool('Agent', { ...ASKED, isolation: 'remote' }, 'c1');
  assert.equal(call.decision, 'deny');
  assert.equal(call.permission, null);
  assert.equal((await h.frame((f) => f.toolUseId === 'c1')).why, 'agent-input');
  const direct = await h.q.options.canUseTool('Task', { ...ASKED, mode: 'bypassPermissions' }, { signal: new AbortController().signal, toolUseID: 'c2' });
  assert.equal(direct.behavior, 'deny', 'canUseTool reached by any route judges the same');
  assert.equal(h.of('ask').length, 0);
  await closed(h);
});

test('a sub-agent\'s tool call meets the same gate as the session\'s own, and says whose it is', async () => {
  const h = await session();
  // A shell command is a card, with its agent id.
  const shell = await h.q.callTool('PowerShell', { command: 'ping -n 2 127.0.0.1' }, 's1', TASK);
  assert.equal(shell.decision, 'ask');
  const ask = await h.frame((f) => f.t === 'ask' && f.toolUseId === 's1');
  assert.equal(ask.agentId, TASK);
  h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
  assert.equal((await shell.permission)!.behavior, 'deny');
  // A background command, a protected path and a tool outside the set are refused here too, without a card.
  for (const [id, name, input, why] of [
    ['s2', 'PowerShell', { command: 'x', run_in_background: true }, 'background'], ['s3', 'Read', { file_path: `${HOME}\\.claude\\settings.json` }, 'protected'], ['s4', 'WebFetch', { url: 'http://x.test' }, 'disallowed'],
  ] as const) {
    const call = await h.q.callTool(name, input, id, TASK);
    assert.equal(call.decision, 'deny', id);
    assert.equal(call.permission, null);
    assert.deepEqual(await h.frame((f) => f.toolUseId === id), { t: 'denied-auto', toolUseId: id, name, why, agentId: TASK });
  }
  // A read inside cwd runs by the CLI's default, as the session's own does; one outside asks.
  assert.equal((await h.q.callTool('Read', { file_path: 'a.txt' }, 's5', TASK)).decision, 'default');
  assert.equal((await h.q.callTool('Read', { file_path: 'C:\\outside\\b.txt' }, 's6', TASK)).decision, 'ask');
  // A nested start is a card, with the id of the sub-agent that starts it.
  assert.equal((await h.q.callTool('Agent', ASKED, 's7', TASK)).decision, 'ask');
  assert.equal((await h.frame((f) => f.toolUseId === 's7')).agentId, TASK);
  await closed(h);
});

test('in a tainted session every call of a sub-agent asks, reads inside cwd too', async () => {
  const h = await session({ tainted: true });
  for (const [id, tool, input] of [['r1', 'Read', { file_path: 'a.txt' }], ['r2', 'Glob', { pattern: '*.txt' }], ['r3', 'Grep', { pattern: 'x' }]] as const) {
    assert.equal((await h.q.callTool(tool, input, id, TASK)).decision, 'ask', tool);
    assert.equal((await h.frame((f) => f.t === 'ask' && f.toolUseId === id)).agentId, TASK);
  }
  await closed(h);
});

test('a sub-agent\'s life goes on as states: no word of it, no tool row, its command and its end once', async () => {
  const h = await session();
  h.q.emit(rootCall());
  h.q.emit(taskStarted());
  h.q.emit(subText());
  await h.q.callTool('PowerShell', { command: 'x' }, SUB_CALL, TASK);
  h.q.emit(subToolUse());
  h.q.emit(taskProgress());
  h.q.emit(bashStarted());
  h.q.emit(bashEnded());
  h.q.emit(subResult());
  h.q.emit(taskUpdated('completed'));
  h.q.emit(taskNotification('completed'));
  await h.frame((f) => f.t === 'sub-end');
  await settle();
  assert.deepEqual(h.frames.filter((f) => f.t.startsWith('sub-')), [
    { t: 'sub-start', taskId: TASK, name: 'ping once', type: 'general-purpose', depth: 1, reply: REPLY },
    { t: 'sub-model', taskId: TASK, model: MODEL },
    { t: 'sub-progress', taskId: TASK },
    { t: 'sub-cmd', taskId: TASK, id: BASH_TASK, open: true },
    { t: 'sub-cmd', taskId: TASK, id: BASH_TASK, open: false },
    { t: 'sub-end', taskId: TASK, status: 'completed' },
  ]);
  assert.equal(h.of('text').length, 0, 'what it said stays here');
  assert.equal(h.of('tool').length, 0, 'neither its calls nor the root\'s Agent call are tool rows');
  assert.ok(!JSON.stringify(h.frames).includes(SUB_WORDS));
  await closed(h);
});

test('a stop reads as stopped, however the CLI says it; a task of another kind is not read', async () => {
  const h = await session();
  h.q.emit(taskStarted());
  h.q.emit(taskUpdated('killed'));
  h.q.emit(taskNotification('stopped'));
  h.q.emit(taskStarted({ task_id: 'a2', tool_use_id: 'c2' }));
  h.q.emit(taskUpdated('failed', 'a2'));
  h.q.emit(taskStarted({ task_id: 'w1', task_type: 'local_workflow' }));
  h.q.emit(taskNotification('completed', 'w1'));
  h.q.emit(bashStarted('not-a-sub-agents'));
  await h.frame((f) => f.t === 'sub-end' && f.taskId === 'a2');
  await settle();
  assert.deepEqual(h.of('sub-end'), [{ t: 'sub-end', taskId: TASK, status: 'stopped' }, { t: 'sub-end', taskId: 'a2', status: 'failed' }]);
  assert.equal(h.of('sub-start').length, 2);
  assert.equal(h.of('sub-cmd').length, 0, 'a command of the root\'s is no member\'s');
  await closed(h);
});

test('one reply is one dispatch: its Agent calls name one reply; a nested start names none and its depth says so', async () => {
  const h = await session();
  h.q.emit(rootCall('c1', 'msg_a'));
  h.q.emit(rootCall('c2', 'msg_a'));
  h.q.emit(rootCall('c3', 'msg_b'));
  h.q.emit(taskStarted({ task_id: 'a1', tool_use_id: 'c1' }));
  h.q.emit(taskStarted({ task_id: 'a2', tool_use_id: 'c2' }));
  h.q.emit(taskStarted({ task_id: 'a3', tool_use_id: 'c3' }));
  h.q.emit(taskStarted({ task_id: 'a4', tool_use_id: 'nested', spawn_depth: 2 }));
  await h.frame((f) => f.taskId === 'a4');
  assert.deepEqual(h.of('sub-start').map((f) => [f.taskId, f.reply, f.depth]), [['a1', 'msg_a', 1], ['a2', 'msg_a', 1], ['a3', 'msg_b', 1], ['a4', null, 2]]);
  await closed(h);
});

test('the model guard reads a sub-agent\'s messages too: another model stops the session', async () => {
  const h = await session();
  h.q.emit(taskStarted());
  h.q.emit(subAssistant({ type: 'text', text: SUB_WORDS }, ROOT_CALL, 'claude-fable-5'));
  assert.deepEqual(await h.frame((f) => f.t === 'exit'), { t: 'exit', reason: 'safety-stop', detail: 'model' });
  await h.done;
  h.end();
});

test('a step counts as failed only if it ran and failed: what a person or the gate refused does not', async () => {
  const h = await session();
  h.q.emit(taskStarted());
  const refusedCall = await h.q.callTool('PowerShell', { command: 'x' }, 'p1', TASK);
  const ask = await h.frame((f) => f.t === 'ask');
  h.send({ t: 'perm', reqId: ask.reqId, allow: false, digest: ask.digest });
  await refusedCall.permission;
  await h.q.callTool('Read', { file_path: `${HOME}\\.claude\\x` }, 'p2', TASK);
  await h.q.callTool('Read', { file_path: 'a.txt' }, 'p3', TASK);
  h.q.emit(subResult('p1', true));
  h.q.emit(subResult('p2', true));
  h.q.emit(subResult('p3', true));
  await h.frame((f) => f.t === 'sub-failed');
  await settle();
  assert.deepEqual(h.of('sub-failed'), [{ t: 'sub-failed', taskId: TASK }]);
  await closed(h);
});

test('the tripwire: a sub-agent\'s result the gate never saw stops the session; a call that never ran does not', async () => {
  const h = await session();
  h.q.emit(taskStarted());
  h.q.emit(subResult('never-judged', true));
  await h.frame((f) => f.t === 'sub-failed');
  assert.equal(h.of('exit').length, 0, 'an error result of a call that never reached the hook: bad input, nothing ran');
  h.q.emit(subResult('never-judged-2'));
  assert.deepEqual(await h.frame((f) => f.t === 'exit'), { t: 'exit', reason: 'safety-stop', detail: 'unjudged-tool' });
  await h.done;
  h.end();
});

// The dispatch tool (src/route/dispatch.ts): the start frame's dispatch turns it on; nothing else opens an MCP tool.

async function tillQuery(h: H): Promise<void> {
  for (let i = 0; i < 50 && h.sdk.queries.length === 0; i++) await new Promise((r) => setImmediate(r));
}

test('without dispatch in the start frame the session keeps no MCP server, and one offered stops it', () => {
  const off = parseStart({ ...START, subagents: false }, { USERPROFILE: HOME });
  assert.ok(off.ok);
  assert.deepEqual(sdkOptions(off.start, {}, { preToolUse: () => ({}), canUseTool: () => ({}) }).mcpServers, {});
  const m = initMessage({ model: MODEL, tools: ['Read', DISPATCH_TOOL_ID], mcp_servers: [{ name: DISPATCH_SERVER, status: 'connected' }] });
  assert.equal(initProblem(m, MODEL, false, false), 'tools');
  assert.equal(initProblem({ ...m, tools: ['Read'] }, MODEL, false, false), 'mcp-servers');
  assert.equal(initProblem(m, MODEL, false, true), null);
  assert.equal(initProblem({ ...m, tools: ['Read'] }, MODEL, false, true), 'tools', 'asked for and not offered');
  assert.equal(initProblem({ ...m, tools: ['Read', DISPATCH_TOOL_ID, 'mcp__orchestra__other'] }, MODEL, false, true), 'tools', 'no other MCP tool');
  assert.equal(initProblem({ ...m, mcp_servers: [{ name: 'other', status: 'connected' }] }, MODEL, false, true), 'mcp-servers');
  assert.equal(initProblem({ ...m, mcp_servers: [{ name: DISPATCH_SERVER, status: 'failed' }] }, MODEL, false, true), 'mcp-servers');
  assert.deepEqual(parseStart({ ...START, dispatch: 'yes' }, { USERPROFILE: HOME }), { ok: false, field: 'dispatch' });
});

test('the gate: the session\'s own call runs on orchestrad\'s word, untainted or tainted; a sub-agent\'s is refused; without the start frame\'s dispatch none', async () => {
  for (const tainted of [false, true]) {
    const h = harness();
    h.send({ ...START, dispatch: true, tainted });
    h.send({ t: 'user', uuid: '11111111-2222-4333-8444-555555555555', text: 'go' });
    await tillQuery(h);
    h.q.emit(initMessage({ model: MODEL, tools: ['Task', 'Read', DISPATCH_TOOL_ID], mcp_servers: [{ name: DISPATCH_SERVER, status: 'connected' }] }));
    await h.frame((f) => f.t === 'init');
    const own = await h.q.callTool(DISPATCH_TOOL_ID, { task: 'x', harness: 'codex' }, 'call-1');
    assert.equal(own.decision, 'allow', 'no card: dispatch.ts decides');
    assert.equal(own.permission, null);
    const sub = await h.q.callTool(DISPATCH_TOOL_ID, { task: 'x', harness: 'codex' }, 'call-2', 'agent-1');
    assert.equal(sub.decision, 'deny');
    assert.equal((await h.frame((f) => f.t === 'denied-auto')).why, 'dispatch-subagent');
    h.q.emit({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { id: 'm', model: MODEL, content: [{ type: 'tool_use', id: 'call-1', name: DISPATCH_TOOL_ID, input: {} }] } });
    h.send({ t: 'close' });
    await h.done;
    assert.deepEqual(h.of('tool'), [], 'no tool row: the feed\'s note is its row');
  }
  const h = harness();
  h.send({ ...START });
  h.send({ t: 'user', uuid: '11111111-2222-4333-8444-555555555555', text: 'go' });
  await tillQuery(h);
  h.q.emit(initMessage({ model: MODEL, tools: ['Task', 'Read'] }));
  await h.frame((f) => f.t === 'init');
  assert.equal((await h.q.callTool(DISPATCH_TOOL_ID, { task: 'x', harness: 'codex' }, 'call-1')).decision, 'deny');
  h.send({ t: 'close' });
  await h.done;
});

test('the MCP server: a cancel says dispatch-gone, an answer past it goes nowhere, the end answers what is open, and a bad reply frame ends the host', async () => {
  const h = harness();
  h.send({ ...START, dispatch: true });
  h.send({ t: 'user', uuid: '11111111-2222-4333-8444-555555555555', text: 'go' });
  await tillQuery(h);
  const sent: any[] = [];
  const wire: { onmessage?: (m: unknown) => void; send(m: unknown): void } = { send: (m) => sent.push(m) };
  await h.q.options.mcpServers[DISPATCH_SERVER].instance.connect(wire);
  wire.onmessage!({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: 'x' } });
  assert.deepEqual(sent[0].result.serverInfo.name, DISPATCH_SERVER);
  wire.onmessage!({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'other', arguments: {} } });
  assert.equal(sent[1].result.isError, true);
  wire.onmessage!({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'dispatch', arguments: { task: 'x', harness: 'codex' } } });
  const f = await h.frame((x) => x.t === 'dispatch');
  assert.deepEqual(f.input, { task: 'x', harness: 'codex' });
  assert.match(f.callId, /^[0-9a-f]{32}$/);
  wire.onmessage!({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
  assert.equal((await h.frame((x) => x.t === 'dispatch-gone')).callId, f.callId);
  h.send({ t: 'dispatch-reply', callId: f.callId, ok: true, text: 'late' });
  wire.onmessage!({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'dispatch', arguments: { task: 'y', harness: 'codex' } } });
  await h.frame((x) => x.t === 'dispatch' && x.callId !== f.callId);
  assert.equal(sent.length, 2, 'the late answer went nowhere');
  h.send({ t: 'dispatch-reply', callId: f.callId, ok: 'yes', text: 'x' });
  await h.done;
  assert.equal(h.of('exit')[0]!.reason, 'bad-frame');
  assert.equal(sent.at(-1).id, 10);
  assert.equal(sent.at(-1).result.isError, true, 'what was open is answered as the host goes');
});
