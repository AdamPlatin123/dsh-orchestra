import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DESK_MODEL, isClaudeModel } from '../../src/owned/models.ts';
import { parseOwnedRecord } from '../../src/owned/registry.ts';
import type { OwnedRecord, OwnedRegistry } from '../../src/owned/registry.ts';
import { ClaudeOwned } from '../../src/owned/claude-owned.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { Approvals } from '../../src/owned/approvals.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { restoredSession } from '../../src/owned/claude-owned.ts';
import { restoredOwned } from '../../src/owned/restored.ts';
import { DISALLOWED_TOOLS, DISPATCH_SERVER, DISPATCH_TOOL_ID, FRONT_DESK_MAX_TURNS, FRONT_DESK_TOOLS, STATUS_TOOL_ID, initProblem, parseStart, sdkOptions } from '../../hosts/claude/host-core.mjs';
import { initMessage } from '../fixtures/fake-sdk.ts';
import { claudeRig, until } from '../helpers/claude-host.ts';

// The front desk as a session (orchestra app plan 总台): what its host lets it hold, end to end through the spawn gate's rule
// and the in-process host with the fake SDK, and what its manager counts. No claude.exe, no model, no network.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SYSTEM = 'You are the front desk.';
const ok = (ref: string | null = null) => ({ ok: true, text: '{"source":"overview"}', source: 'overview' as const, ref });
const noDispatch = { call: () => ({ reply: Promise.resolve({ ok: false, text: 'no' }), cancel: () => {} }), sentOf: () => null };
const INIT = { model: DEFAULT_DESK_MODEL, tools: [...FRONT_DESK_TOOLS], mcp_servers: [{ name: DISPATCH_SERVER, status: 'connected' }] };

function rig(t: Parameters<typeof claudeRig>[0], status = ok as () => ReturnType<typeof ok>) {
  return claudeRig(t, { dispatch: noDispatch as never, frontDesk: { system: SYSTEM, port: { status: status as never } } });
}
async function opened(r: ReturnType<typeof rig>) {
  const made = r.owned.create({ text: 'open', uuid: U(1), title: '总台', frontDesk: true });
  assert.ok(made.ok, JSON.stringify(made));
  await until('the query', () => r.host.calls.length === 1 && r.host.calls[0]!.sdk.queries.length === 1);
  return made;
}

test('the model: one of Claude\'s, the cheap one the desk\'s rules name', () => {
  assert.equal(isClaudeModel(DEFAULT_DESK_MODEL), true);
});

test('start frame: the prompt alone, no built-in tool, a short turn cap, no sub-agent, the two tools named nowhere else', () => {
  const start = { t: 'start', ownedId: '0123456789abcdef0123', model: DEFAULT_DESK_MODEL, cwd: 'C:\\t\\work', configDir: 'C:\\t\\claude\\0123456789abcdef0123', tainted: false, claudeExe: 'C:\\x\\claude.exe', protectedRoots: [], askTimeoutMs: 600_000, dispatch: true, frontDesk: SYSTEM };
  const env = { USERPROFILE: 'C:\\Users\\u' };
  const p = parseStart(start, env);
  assert.ok(p.ok);
  const o = sdkOptions(p.start, env, { preToolUse: () => {}, canUseTool: () => {}, dispatchServer: {} });
  assert.deepEqual(o.tools, [], 'every built-in away');
  assert.equal(o.systemPrompt, SYSTEM);
  assert.equal(o.maxTurns, FRONT_DESK_MAX_TURNS);
  assert.deepEqual(o.disallowedTools, [...DISALLOWED_TOOLS], 'Task and Agent with them');
  for (const bad of [{ frontDesk: '' }, { frontDesk: 1 }, { dispatch: false }, { subagents: true }, { resume: '11111111-2222-4333-8444-555555555555' }, { appendSystem: 'x' }]) {
    assert.deepEqual(parseStart({ ...start, ...bad }, env), { ok: false, field: 'frontDesk' }, JSON.stringify(bad));
  }
  const plain = parseStart({ ...start, frontDesk: undefined }, env);
  assert.ok(plain.ok);
  assert.equal(sdkOptions(plain.start, env, { preToolUse: () => {}, canUseTool: () => {}, dispatchServer: {} }).tools, undefined, 'a worker keeps its tools');
});

test('init: exactly the two tools pass; anything more, anything less, is the session\'s stop', () => {
  const m = initMessage(INIT);
  assert.equal(initProblem(m, DEFAULT_DESK_MODEL, false, true, true), null);
  for (const tools of [[...FRONT_DESK_TOOLS, 'Read'], [...FRONT_DESK_TOOLS, 'Bash'], [...FRONT_DESK_TOOLS, 'SomeNewBuiltin'], [DISPATCH_TOOL_ID], [STATUS_TOOL_ID], [], [...FRONT_DESK_TOOLS, 'mcp__orchestra__other']]) {
    assert.equal(initProblem({ ...m, tools }, DEFAULT_DESK_MODEL, false, true, true), 'tools', JSON.stringify(tools));
  }
  assert.equal(initProblem({ ...m, tools: [DISPATCH_TOOL_ID, STATUS_TOOL_ID] }, DEFAULT_DESK_MODEL, false, true, false), 'tools', 'a worker has no status tool');
});

test('a host offered one tool too many stops the desk at its start (safety-stop), and the list says none runs', async (t) => {
  const r = rig(t);
  const { session: s } = await opened(r);
  r.q().emit(initMessage({ ...INIT, tools: [...FRONT_DESK_TOOLS, 'Read'] }));
  await until('the stop', () => s.state === 'failed');
  assert.equal(s.endReason, 'safety-stop');
  assert.equal(r.owned.frontDesk(), null);
  const list = ownedList({ codex: null, claude: r.owned, codexOff: 'codex-missing' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual(list.frontDesk, { on: true, ownedId: null, model: DEFAULT_DESK_MODEL, tools: null });
});

test('reads: the start frame offers both tools, a read goes to the port and back, the feed keeps which read and never its text; no tool row', async (t) => {
  const r = rig(t, () => ok(`n:${'a'.repeat(20)}`));
  const { session: s } = await opened(r);
  r.q().emit(initMessage(INIT));
  await until('init', () => s.state === 'running');
  assert.deepEqual([...(s.tools ?? [])], [...FRONT_DESK_TOOLS]);
  assert.deepEqual(r.q().options.tools, []);
  const sent: any[] = [];
  const wire: { onmessage?: (m: unknown) => void; send(m: unknown): void } = { send: (m) => sent.push(m) };
  await r.q().options.mcpServers[DISPATCH_SERVER].instance.connect(wire);
  wire.onmessage!({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(sent[0].result.tools.map((x: { name: string }) => x.name), ['dispatch', 'status']);
  const hook = await r.q().callTool(STATUS_TOOL_ID, { what: 'overview' }, 'call-1');
  assert.deepEqual([hook.decision, hook.permission], ['allow', null], 'a read asks nobody');
  wire.onmessage!({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: { what: 'overview' } } });
  await until('the answer', () => sent.length === 2);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"source":"overview"}' }] } });
  r.q().emit({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { id: 'm', model: DEFAULT_DESK_MODEL, content: [{ type: 'tool_use', id: 'call-1', name: STATUS_TOOL_ID, input: {} }] } });
  r.q().emit({ type: 'assistant', uuid: 'v', parent_tool_use_id: null, message: { id: 'n', model: DEFAULT_DESK_MODEL, content: [{ type: 'text', text: 'two workers' }] } });
  await until('the text', () => s.feed.since(0).events.some((e) => e.kind === 'text'));
  const es = s.feed.since(0).events;
  assert.deepEqual(es.filter((e) => e.kind === 'note' && e.state === 'desk-read').map((e) => [e.text, e.ref]), [['overview', `n:${'a'.repeat(20)}`]]);
  assert.equal(es.some((e) => e.kind === 'tool'), false);
  assert.equal(JSON.stringify(es).includes('"source"'), false, 'what it read stays out of the feed');
});

test('the gate: every other tool is refused whatever the CLI offers, a call from a sub-agent too; a worker has no read', async (t) => {
  const r = rig(t);
  const { session: s } = await opened(r);
  r.q().emit(initMessage(INIT));
  await until('init', () => s.state === 'running');
  for (const [i, tool] of ['Read', 'Bash', 'Write', 'WebFetch', 'Task', 'mcp__other__x'].entries()) {
    assert.equal((await r.q().callTool(tool, { file_path: 'a.txt', command: 'dir' }, `toolu_${i}`)).decision, 'deny', tool);
  }
  assert.equal((await r.q().callTool(STATUS_TOOL_ID, { what: 'overview' }, 'toolu_s', 'agent-1')).decision, 'deny');
  assert.equal(r.approvals.list().length, 0, 'nothing of it ever reaches you as a card');

  const w = claudeRig(t, { dispatch: noDispatch as never });
  const made = w.owned.create({ text: 'hi', uuid: U(2) });
  assert.ok(made.ok);
  await until('the query', () => w.host.calls.length === 1 && w.host.calls[0]!.sdk.queries.length === 1);
  w.q().emit(initMessage({ model: 'zcode/GLM-5.3', tools: ['Read', DISPATCH_TOOL_ID], mcp_servers: [{ name: DISPATCH_SERVER, status: 'connected' }] }));
  await until('init', () => made.session.state === 'running');
  assert.equal((await w.q().callTool(STATUS_TOOL_ID, { what: 'overview' }, 'toolu_w')).decision, 'deny');
});

test('at most one, and no worker: a second is desk-open, it takes no place, no seat on the tower; once over a new one opens', async (t) => {
  const r = rig(t);
  const { session: s, ownedId } = await opened(r);
  assert.deepEqual(r.owned.create({ text: 'open', uuid: U(2), frontDesk: true }), { ok: false, reason: 'desk-open', detail: 'one runs' });
  assert.equal(r.owned.active(), 0);
  assert.equal(r.owned.full(), false);
  assert.deepEqual(r.owned.towerSeats(), []);
  assert.equal(r.owned.frontDesk()?.ownedId, ownedId);
  const list = ownedList({ codex: null, claude: r.owned, codexOff: 'codex-missing' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual([list.limits.active, list.owned[0]!.frontDesk, list.frontDesk.ownedId, list.frontDesk.model], [0, true, ownedId, DEFAULT_DESK_MODEL]);
  // Workers fill the limit with the desk open, and it stays out of their count.
  for (let i = 0; i < 3; i++) assert.ok(r.owned.create({ text: 'w', uuid: U(3 + i) }).ok);
  assert.equal(r.owned.active(), 3);
  assert.equal(r.owned.create({ text: 'w', uuid: U(6) }).ok, false);
  assert.equal(r.owned.towerSeats().length, 3);
  s.end();
  await until('its end', () => s.state === 'ended');
  assert.equal(r.owned.create({ text: 'open', uuid: U(7), frontDesk: true }).ok, true, 'the limit does not hold a desk back either');
});

test('no dispatch tool here, no desk; a model off Claude\'s list neither', (t) => {
  const none = claudeRig(t);
  assert.equal(none.owned.deskOn, false);
  assert.deepEqual(none.owned.create({ text: 'x', uuid: U(1), frontDesk: true }), { ok: false, reason: 'desk-off', detail: 'no dispatch tool here' });
  const r = rig(t);
  assert.equal(r.owned.deskOn, true);
  assert.equal(r.owned.create({ text: 'x', uuid: U(1), frontDesk: true, model: 'codex/gpt-6.1-sol' }).ok, false);
});

test('its record says what it was: read back it is no worker after a restart, on a harness that is on or off, and a new one may open', () => {
  const rec: OwnedRecord = { v: 1, ownedId: 'd'.repeat(20), harness: 'claude', model: DEFAULT_DESK_MODEL, title: '总台', createdAt: 1, state: 'idle', endReason: null, frontDesk: true };
  assert.deepEqual(parseOwnedRecord(JSON.stringify(rec)), rec);
  assert.equal(parseOwnedRecord(JSON.stringify({ ...rec, frontDesk: false })), null, 'the mark is there or it is not');
  const { frontDesk: _d, ...worker } = rec;
  assert.equal(parseOwnedRecord(JSON.stringify(worker))?.frontDesk, undefined);

  const registry = { load: () => [rec], save: () => {} } as unknown as OwnedRegistry;
  const clock = new VirtualClock({ mono: 1, wall: 1 });
  const launch = () => { throw new Error('not launched'); };
  const owned = new ClaudeOwned({
    approvals: new Approvals({ hub: clock }), makeWorkDir: (id) => `C:\\w\\${id}`, makeConfigDir: (id) => `C:\\c\\${id}`, launch, claudeExe: 'C:\\x\\claude.exe', protectedRoots: [], hub: clock,
    now: () => 1, redact: (text) => ({ text, count: 0 }), registry,
  });
  assert.deepEqual(owned.towerSeats(), []);
  assert.equal(owned.frontDesk(), null, 'unknown: it stands in nobody\'s way');
  const list = ownedList({ codex: null, claude: owned, codexOff: 'codex-missing' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual([list.owned[0]!.state, list.owned[0]!.frontDesk, list.limits.active], ['unknown', true, 0]);

  const off = restoredOwned('claude', registry, () => 1, restoredSession);
  assert.deepEqual(off.towerSeats(), []);
  assert.equal(off.meta(rec.ownedId)?.frontDesk, true);
});
