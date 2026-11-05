import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FeedEvent } from '../../src/owned/feed.ts';
import type { ClaudeSession } from '../../src/owned/claude-session.ts';
import { CLAUDE_HOST_FIXED_ENV, ENV_WHITELIST } from '../../src/os/spawn.ts';
import { HOST_STOP_MS, stopHostInOrder } from '../../src/os/owned-proc.ts';
import { CLAUDE_DEADLINES } from '../../src/owned/claude-session.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import { DISPATCH_SERVER, DISPATCH_TOOL_ID } from '../../hosts/claude/host-core.mjs';
import { initMessage } from '../fixtures/fake-sdk.ts';
import { HOST_ENTRY, claudeRig, until } from '../helpers/claude-host.ts';

// Owned Claude sessions (orchestra app step 4) end to end through the spawn gate's claude-host rule: the
// gate decides on the real node.exe, host.mjs, the pin check and the work dir, and its backend runs
// hosts/claude/host-core.mjs in-process with the fake SDK (test/helpers/claude-host.ts). No claude.exe,
// no model, no network; every path is in a temp dir.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const MODEL = DEFAULT_CLAUDE_MODEL;
const init = (over: Record<string, unknown> = {}) => initMessage({ model: MODEL, ...over });
const kinds = (s: ClaudeSession) => s.feed.since(0).events.map((e) => `${e.kind}:${e.state ?? ''}`);
const events = (s: ClaudeSession, kind: FeedEvent['kind']) => s.feed.since(0).events.filter((e) => e.kind === kind);

async function begun(r: ReturnType<typeof claudeRig>, text = 'write a.txt then read it back') {
  const made = r.owned.create({ text, uuid: U(1) });
  assert.ok(made.ok, JSON.stringify(made));
  const s = made.session;
  await until('the first message reaches the SDK', () => r.host.calls.length === 1 && r.host.calls[0]!.sdk.queries.length === 1 && r.q().received.length === 1);
  return { s, ownedId: made.ownedId };
}

test('the dispatch tool: the start frame offers it, a call goes to the port under the session\'s own id, the answer comes back; a stop gives up one still waiting', async (t) => {
  const calls: { ownedId: string; raw: unknown }[] = [];
  let cancelled = 0;
  let release: (v: { ok: boolean; text: string }) => void = () => {};
  const port = {
    call: (ownedId: string, raw: unknown, say: (n: { state: 'worker-sent-grant'; ref: string; text: string }) => void) => {
      calls.push({ ownedId, raw });
      say({ state: 'worker-sent-grant', ref: `n:${'c'.repeat(20)}`, text: 'the child' });
      return { reply: new Promise<{ ok: boolean; text: string }>((res) => { release = res; }), cancel: () => { cancelled++; release({ ok: false, text: 'withdrawn' }); } };
    },
    sentOf: () => null,
  };
  const r = claudeRig(t, { dispatch: port as never });
  const { s, ownedId } = await begun(r);
  r.q().emit(init({ tools: ['Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'Write', DISPATCH_TOOL_ID], mcp_servers: [{ name: DISPATCH_SERVER, status: 'connected' }] }));
  await until('init', () => s.state === 'running');
  const server = r.q().options.mcpServers[DISPATCH_SERVER];
  assert.equal(server.type, 'sdk');
  const sent: any[] = [];
  const wire: { onmessage?: (m: unknown) => void; send(m: unknown): void } = { send: (m) => sent.push(m) };
  await server.instance.connect(wire);
  wire.onmessage!({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(sent[0].result.tools.map((x: { name: string }) => x.name), ['dispatch']);
  wire.onmessage!({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch', arguments: { task: 'x', harness: 'codex' } } });
  await until('the call', () => calls.length === 1);
  assert.deepEqual(calls, [{ ownedId, raw: { task: 'x', harness: 'codex' } }]);
  assert.ok(s.feed.since(0).events.some((e) => e.kind === 'note' && e.state === 'worker-sent-grant'));
  release({ ok: true, text: 'Dispatched: a test.' });
  await until('the answer', () => sent.length === 2);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Dispatched: a test.' }] } });
  wire.onmessage!({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dispatch', arguments: { task: 'y', harness: 'claude' } } });
  await until('the second call', () => calls.length === 2);
  await s.interrupt();
  assert.equal(cancelled, 1);
  await until('its answer', () => sent.length === 3);
  assert.equal(sent[2].result.isError, true);
});

test('handshake: the gate starts node.exe with [host.mjs] in the work dir, with its whitelist, the extras and its fixed env; the start frame and the first message follow; init makes it run', async (t) => {
  const r = claudeRig(t);
  const { s, ownedId } = await begun(r);
  const call = r.host.calls[0]!;
  assert.equal(call.exe, process.execPath);
  assert.deepEqual(call.argv, [HOST_ENTRY]);
  assert.equal(call.opts.cwd, path.join(r.workRoot, ownedId));
  const keys = Object.keys(call.opts.env).sort();
  const allowed = new Set([...ENV_WHITELIST['claude-host'], 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_SMALL_FAST_MODEL', 'NO_PROXY', ...Object.keys(CLAUDE_HOST_FIXED_ENV)]);
  assert.deepEqual(keys.filter((k) => !allowed.has(k)), [], 'nothing past the whitelist, the extras and the fixed env');
  for (const k of ['NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY']) assert.ok(!keys.includes(k), k);
  assert.equal(call.opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3425');
  assert.equal(call.opts.env.DISABLE_AUTOUPDATER, '1');
  // The start frame, as the SDK options show it.
  const o = r.q().options;
  assert.equal(o.model, MODEL);
  assert.equal(o.cwd, path.join(r.workRoot, ownedId));
  assert.equal(o.env.CLAUDE_CONFIG_DIR, path.join(r.configRoot, ownedId), 'the session\'s own config dir, not the host\'s claude-home');
  assert.equal(o.env.ANTHROPIC_MODEL, MODEL);
  assert.equal(o.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3425');
  assert.equal(o.permissionMode, 'default');
  assert.deepEqual(r.q().received[0], { type: 'user', uuid: U(1), message: { role: 'user', content: 'write a.txt then read it back' }, parent_tool_use_id: null, origin: { kind: 'human' } });
  assert.equal(s.state, 'starting');
  r.q().emit(init());
  assert.equal(await s.ready, true);
  assert.equal(s.state, 'running', 'the first message\'s turn runs');
  assert.equal(s.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(kinds(s).slice(0, 3), ['you:', 'note:msg-written', 'lifecycle:started']);
  // The tower: harness claude, owned.
  const seat = r.owned.towerSeats()[0]!;
  assert.deepEqual([seat.harness, seat.ownedId, seat.state], ['claude', ownedId, 'running']);
});

test('message flow: the reply comes into the feed in chunks, the result ends the turn with its cost; a message during a turn waits and goes after it', async (t) => {
  const r = claudeRig(t);
  const { s } = await begun(r);
  r.q().emit(init());
  await s.ready;
  const queued = s.send('and then say done', U(2));
  assert.deepEqual(queued, { ok: true, via: 'queued' });
  assert.equal(s.queued, 1);
  r.q().emit({ type: 'assistant', uuid: U(7), message: { model: MODEL, content: [{ type: 'text', text: 'I wrote a.txt.' }, { type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} }] }, parent_tool_use_id: null });
  r.q().emit({ type: 'result', subtype: 'success', total_cost_usd: 0.0123, user_message_uuid: U(1) });
  await until('the queued message goes', () => r.q().received.length === 2);
  assert.equal(r.q().received[1]!.uuid, U(2));
  assert.equal(s.queued, 0);
  assert.equal(s.state, 'running');
  const text = events(s, 'text');
  assert.deepEqual(text.map((e) => [e.text, e.ref]), [['I wrote a.txt.', U(7)]]);
  assert.deepEqual(events(s, 'tool').map((e) => [e.text, e.state, e.ref]), [['Write', 'file-change', 'toolu_1']]);
  assert.ok(kinds(s).includes('lifecycle:turn-ended'));
  assert.equal(s.costUsd, 0.0123);
  r.q().emit({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.02, user_message_uuid: U(2) });
  await until('idle', () => s.state === 'idle');
  assert.ok(kinds(s).includes('lifecycle:turn-max-turns'));
  // An idle session takes the next message at once.
  assert.deepEqual(s.send('one more', U(3)), { ok: true, via: 'turn/start' });
  await until('sent', () => r.q().received.length === 3);
});

test('permissions: an ask goes into the shared queue as a card; allow and deny answer the host with the perm frame it checks, and the SDK gets allow with the very input or deny', async (t) => {
  const r = claudeRig(t);
  const { s, ownedId } = await begun(r);
  r.q().emit(init());
  await s.ready;
  const input = { file_path: 'a.txt', content: 'hello\n' };
  r.q().emit({ type: 'assistant', uuid: U(7), message: { model: MODEL, content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input }] }, parent_tool_use_id: null });
  await until('the tool row', () => events(s, 'tool').length === 1);
  const call = await r.q().callTool('Write', input, 'toolu_w');
  assert.equal(call.decision, 'ask');
  await until('the card', () => r.approvals.list().length === 1);
  const a = r.approvals.list()[0]!;
  assert.deepEqual([a.ownedId, a.kind, a.risk, a.canAccept, a.high], [ownedId, 'file-change', 'write', true, false]);
  assert.equal(a.title, 'Write · a.txt');
  assert.ok(a.preview.includes('content: hello') && a.preview.includes(`file_path: a.txt`), a.preview);
  // While the card is open the tool row waits below it (feed order: ask, answer, tool).
  assert.equal(events(s, 'tool').length, 0);
  assert.equal(r.approvals.allow(a.approvalId, { digest: a.digest, rev: r.approvals.rev }), 'ok');
  assert.deepEqual(await call.permission, { behavior: 'allow', updatedInput: input });
  const perm = r.host.calls[0]!.stdin.join('').split('\n').filter((l) => l.includes('"t":"perm"')).map((l) => JSON.parse(l));
  assert.equal(perm.length, 1);
  assert.deepEqual(Object.keys(perm[0]).sort(), ['allow', 'digest', 'reqId', 't']);
  assert.equal(perm[0].allow, true);
  assert.match(perm[0].digest, /^[0-9a-f]{64}$/);
  const order = kinds(s).filter((k) => /^(ask|answer|tool):/.test(k));
  assert.deepEqual(order, ['ask:file-change', 'answer:accept', 'tool:file-change']);

  const bash = await r.q().callTool('PowerShell', { command: 'Get-Content a.txt', description: 'read it back' }, 'toolu_p');
  await until('the second card', () => r.approvals.list().length === 1);
  const b = r.approvals.list()[0]!;
  assert.deepEqual([b.kind, b.risk, b.high, b.title], ['command', 'shell', true, 'PowerShell · Get-Content a.txt']);
  assert.equal(r.approvals.deny(b.approvalId), 'ok');
  assert.deepEqual(await bash.permission, { behavior: 'deny', message: 'The user did not allow this tool call.' });
  assert.ok(kinds(s).includes('answer:decline'));
  // A read outside the work dir is a card of risk protected; a protected path never makes one (the host refuses it).
  const out = await r.q().callTool('Read', { file_path: path.join(r.dir, 'elsewhere.txt') }, 'toolu_r');
  await until('the read card', () => r.approvals.list().length === 1);
  const c = r.approvals.list()[0]!;
  assert.deepEqual([c.kind, c.risk, c.high], ['tool', 'protected', true]);
  assert.ok(c.preview.includes('outside the work dir:'), c.preview);
  r.approvals.deny(c.approvalId);
  await out.permission;
  const prot = await r.q().callTool('Read', { file_path: path.join(r.home, 'owned', 'x.json') }, 'toolu_x');
  assert.equal(prot.decision, 'deny');
  await until('the auto refusal', () => events(s, 'auto-denied').some((e) => e.state === 'protected'));
  assert.equal(r.approvals.list().length, 0);
});

test('interrupt: open approvals are declined first, waiting messages withdrawn, then the host interrupts the SDK; a receipt that still holds something closes the session', async (t) => {
  const r = claudeRig(t);
  const { s } = await begun(r);
  r.q().emit(init());
  await s.ready;
  s.send('second', U(2));
  s.send('third', U(3));
  const call = await r.q().callTool('Write', { file_path: 'b.txt', content: 'x' }, 'toolu_b');
  await until('the card', () => r.approvals.list().length === 1);
  const got = await s.interrupt();
  assert.deepEqual(got, { withdrawn: 2, denied: 1 });
  assert.equal((await call.permission)!.behavior, 'deny');
  await until('the interrupt', () => r.q().interrupts === 1);
  await until('the receipt', () => kinds(s).includes('note:interrupted'));
  assert.equal(r.q().received.length, 1, 'no withdrawn message reached the SDK');
  assert.equal(s.state, 'running', 'the turn ends with its result');
  r.q().emit({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0, user_message_uuid: U(1) });
  await until('idle', () => s.state === 'idle');
  assert.ok(kinds(s).includes('lifecycle:turn-interrupted') && !kinds(s).includes('lifecycle:turn-failed'), 'the turn your stop cut off is no failure');

  // The CLI says it still holds a message: the session is ended (design §2.5).
  s.send('again', U(4));
  r.q().interruptReply = { still_queued: [{ uuid: U(4) }] };
  await s.interrupt();
  await until('ended', () => s.state === 'ended');
  assert.ok(kinds(s).includes('note:interrupt-unsure'));
  await until('the host closed', () => r.q().closed);
});

test('end: open approvals declined, the close frame stops the host (no kill); the session is ended by you', async (t) => {
  const r = claudeRig(t);
  const { s } = await begun(r);
  r.q().emit(init());
  await s.ready;
  const call = await r.q().callTool('Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, 'toolu_e');
  await until('the card', () => r.approvals.list().length === 1);
  assert.deepEqual(s.end(), { denied: 1 });
  assert.equal((await call.permission)!.behavior, 'deny');
  assert.deepEqual([s.state, s.endReason], ['ended', 'you-ended']);
  assert.equal((await r.host.calls[0]!.done).reason, 'closed');
  assert.equal(r.q().closed, true);
  assert.equal(r.host.kills, 0);
  assert.deepEqual(s.send('more', U(5)), { ok: false, reason: 'ended' });
});

test('crash: the SDK failing ends the host (exited, with its reason); a host that dies without an exit frame fails too; open cards go, nobody can answer them', async (t) => {
  const r = claudeRig(t);
  const { s } = await begun(r);
  r.q().emit(init());
  await s.ready;
  await r.q().callTool('Write', { file_path: 'c.txt', content: 'x' }, 'toolu_c');
  await until('the card', () => r.approvals.list().length === 1);
  r.q().fail(new Error('boom'));
  await until('failed', () => s.state === 'failed');
  assert.equal(s.endReason, 'exited');
  assert.equal(s.stats().exit?.reason, 'sdk-error');
  assert.equal(r.approvals.list().length, 0);

  const r2 = claudeRig(t);
  const b = await begun(r2);
  r2.host.crash();
  await until('failed', () => b.s.state === 'failed');
  assert.deepEqual([b.s.endReason, b.s.stats().failure], ['exited', 'exit code 1']);
  assert.equal(await b.s.ready, false);
});

test('safety stop: an init on another model ends the session as safety-stop; no init in time fails the start and stops the host', async (t) => {
  const r = claudeRig(t);
  const { s } = await begun(r);
  r.q().emit(init({ model: 'opencode-go/claude-haiku-5-5' }));
  await until('failed', () => s.state === 'failed');
  assert.deepEqual([s.endReason, s.stats().exit], ['safety-stop', { reason: 'safety-stop', detail: 'model' }]);

  const r2 = claudeRig(t);
  const b = await begun(r2);
  r2.clock.advanceBy(CLAUDE_DEADLINES.initMs);
  assert.deepEqual([b.s.state, b.s.endReason], ['failed', 'start-failed']);
  await until('the host closed', () => r2.q().closed);
});

test('pins: a host whose files changed since startup is refused by the gate (host-tampered), before any child', async (t) => {
  const r = claudeRig(t);
  r.tamper.why = 'hosts/claude/host-core.mjs: changed';
  const made = r.owned.create({ text: 'hi', uuid: U(1) });
  assert.deepEqual(made, { ok: false, reason: 'spawn-refused', detail: 'host-tampered: hosts/claude/host-core.mjs: changed' });
  assert.equal(r.host.calls.length, 0);
  assert.equal(r.owned.active(), 0);
});

test('models: codex/* and others are refused for Claude before anything is made; zcode/* and opencode-go/* start', (t) => {
  const r = claudeRig(t);
  for (const model of ['codex/gpt-6.1-sol', 'gpt-4o', 'zcode/']) {
    assert.deepEqual(r.owned.create({ model, text: 'hi', uuid: U(1) }), { ok: false, reason: 'model-refused', detail: model });
  }
  assert.equal(fs.readdirSync(r.workRoot).length, 0);
  const ok = r.owned.create({ model: 'opencode-go/glm-5.3', text: 'hi', uuid: U(1) });
  assert.ok(ok.ok);
  assert.equal(ok.session.model, 'opencode-go/glm-5.3');
});

test('the stop order: close frame, then stdin closed after 3 s, then a kill after 2 s more; each step only while the host still runs', () => {
  const steps: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let closed = false;
  const pipe = {
    pid: 1, write: (d: string) => steps.push(`write ${d.trim()}`), onStdout() {}, onStderr() {}, onClose() {}, onError() {},
    closeStdin: () => steps.push('eof'), kill: () => steps.push('kill'),
  };
  stopHostInOrder(pipe, { closeFrame: '{"t":"close"}\n', after: (ms, fn) => (timers.push({ ms, fn }), () => {}), closed: () => closed, killed: () => steps.push('killed') });
  assert.deepEqual(steps, ['write {"t":"close"}']);
  assert.equal(timers[0]!.ms, HOST_STOP_MS.afterClose);
  timers[0]!.fn();
  assert.deepEqual(steps.slice(1), ['eof']);
  assert.equal(timers[1]!.ms, HOST_STOP_MS.afterEof);
  timers[1]!.fn();
  assert.deepEqual(steps.slice(2), ['kill', 'killed']);
  // A host that left after the close frame is not touched again.
  const quiet: string[] = [];
  const later: (() => void)[] = [];
  stopHostInOrder({ ...pipe, write: () => quiet.push('write'), closeStdin: () => quiet.push('eof'), kill: () => quiet.push('kill') }, {
    closeFrame: 'x\n', after: (_ms, fn) => (later.push(fn), () => {}), closed: () => closed, killed: () => quiet.push('killed'),
  });
  closed = true;
  later[0]!();
  assert.deepEqual(quiet, ['write']);
});

test('a hung host: the end goes through the whole order on the Clock and the feed says claude.exe may remain', async (t) => {
  const r = claudeRig(t);
  r.host.hang = true;
  const made = r.owned.create({ text: 'hi', uuid: U(1) });
  assert.ok(made.ok);
  await until('spawned', () => r.host.calls.length === 1);
  made.session.end();
  r.clock.advanceBy(HOST_STOP_MS.afterClose);
  r.clock.advanceBy(HOST_STOP_MS.afterEof);
  assert.equal(r.host.kills, 1);
  assert.ok(kinds(made.session).includes('note:host-killed'));
});

test('GET /api/owned\'s list with Claude sessions: harness claude, its card in the shared queue, waiting and counts hold to the contract', async (t) => {
  const r = claudeRig(t);
  const { s, ownedId } = await begun(r);
  r.q().emit(init());
  await s.ready;
  await r.q().callTool('Write', { file_path: 'd.txt', content: 'x' }, 'toolu_d');
  await until('the card', () => r.approvals.list().length === 1);
  const list = ownedList({ codex: null, claude: r.owned, codexOff: 'codex-missing' });
  assert.ok(validateOwnedList(list).ok, validateOwnedList(list).errors.join('\n'));
  assert.deepEqual([list.enabled, list.disabledWhy, list.harnesses, list.limits], [true, null, { codex: false, claude: true }, { maxOwned: 3, active: 1 }]);
  assert.deepEqual([list.owned[0]!.harness, list.owned[0]!.model, list.owned[0]!.waiting, list.owned[0]!.tokens], ['claude', MODEL, list.approvals[0]!.approvalId, null]);
  assert.equal(list.approvals[0]!.ownedId, ownedId);
  const feed = s.feed.since(0);
  const page = { v: 1, kind: 'owned-feed', ownedId, from: feed.from, to: feed.to, clipped: feed.clipped, events: feed.events.map((e) => ({ ...e, exitCode: e.exitCode ?? null, tokens: e.tokens ?? null, batch: null })) };
  assert.ok(validateOwnedFeed(page).ok, validateOwnedFeed(page).errors.join('\n'));
});
