import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { VirtualClock, oneShot } from '../../src/runtime/clock.ts';
import { makeDesk } from '../../src/route/desk.ts';
import type { DispatchDeps, DispatchNote, DispatchStart } from '../../src/route/dispatch.ts';
import { DISPATCH_LIMITS, DISPATCH_TOOL, dispatchArgs, gateOf, makeDispatchLink, makeDispatcher } from '../../src/route/dispatch.ts';
import { dispatchOf } from '../../src/route/desk.ts';
import { OWNED_BOUNDS } from '../../shared/owned-contract.js';
import { PRESENCE_LIMITS, makePresence } from '../../src/route/presence.ts';
import type { Presence } from '../../src/route/presence.ts';
import { REQUEST_LIMITS, makeRequests } from '../../src/route/requests.ts';
import { checkBody } from '../../src/store/records.ts';
import type { Rec } from '../../src/store/journal.ts';
import { DISPATCH_SERVER, DISPATCH_TOOL as HOST_TOOL, DISPATCH_TOOL_ID } from '../../hosts/claude/host-core.mjs';

// A worker's dispatch (orchestra app plan 派活权限): the two levels, and what no level opens. The requests are the real
// ones on a virtual clock, the desk the real one with no router model; the sessions and the journal stand-ins that count.

const W = 'a'.repeat(20);
const CALL = { task: 'reply with pong', harness: 'codex', model: 'zcode/GLM-5.3' };
type S = { title: string; tainted: boolean; over: boolean };

function fixture(over: Partial<DispatchDeps> = {}) {
  const clock = new VirtualClock({ mono: 1000, wall: 1_800_000_000_000 });
  const port = clock.port(null);
  const requests = makeRequests({
    after: oneShot(clock, 'dispatch-test'), nowMono: () => port.nowMono(), nowWall: () => port.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => ({ state: 'starting', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }), endOwned: () => true,
  });
  const desk = makeDesk({ post: null, routerModel: 'zcode/GLM-5.3', on: () => ({ codex: true, claude: true }), redact: (s) => s, nowMono: () => port.nowMono(), nowWall: () => port.nowWall() });
  const sessions = new Map<string, S>([[W, { title: 'the worker', tainted: false, over: false }]]);
  const started: DispatchStart[] = [];
  const records: Rec[] = [];
  const ended: string[] = [];
  const state = { presence: 'present' as Presence, full: false };
  let n = 0;
  const deps: DispatchDeps = {
    requests, desk, log: { info: () => {}, warn: () => {} }, presence: () => state.presence,
    session: (id) => sessions.get(id) ?? null, on: () => true, full: () => state.full,
    start: (r) => {
      started.push(r);
      const ownedId = (++n).toString(16).padStart(20, 'b');
      sessions.set(ownedId, { title: `child ${n}`, tainted: false, over: false });
      return { ok: true, ownedId, model: r.model };
    },
    end: (id) => ended.push(id), judgeCwd: (cwd) => (cwd.startsWith('C:\\protected') ? 'protected' : null),
    placeCwd: (cwd) => (cwd.startsWith('D:\\proj') ? { runIn: cwd, why: null } : { runIn: null, why: 'outside-roots' }),
    cwdRecord: () => [], commit: (r) => records.push(...r), nowWall: () => port.nowWall(), ...over,
  };
  const d = makeDispatcher(deps);
  const notes: DispatchNote[] = [];
  const say = (x: DispatchNote) => notes.push(x);
  return { clock, requests, d, deps, sessions, started, records, ended, state, notes, say, grant: (id: string = W) => d.grant(id, 'free', crypto.randomUUID()) };
}
const pendingOf = (fx: ReturnType<typeof fixture>) => fx.requests.list().filter((r) => r.state === 'pending');
const kinds = (fx: ReturnType<typeof fixture>) => fx.records.map((r) => r.kind);

test('the gate: only a clean session at 直接派出 with you present goes out at once; what falls back says why', () => {
  assert.deepEqual(gateOf('free', false, 'present'), { go: true });
  assert.deepEqual(gateOf('ask', false, 'present'), { go: false, why: null });
  assert.deepEqual(gateOf('ask', true, 'away'), { go: false, why: null }, 'at 派前问你 there is nothing to fall back from');
  assert.deepEqual(gateOf('free', true, 'present'), { go: false, why: 'tainted' });
  assert.deepEqual(gateOf('free', false, 'away'), { go: false, why: 'away' });
  assert.deepEqual(gateOf('free', false, 'unknown'), { go: false, why: 'presence-unknown' });
});

test('the tool\'s arguments: task and harness, model and cwd if any, and nothing else', () => {
  assert.deepEqual(dispatchArgs(CALL), { task: CALL.task, harness: 'codex', model: 'zcode/GLM-5.3', cwd: null, why: null, returns: null });
  assert.deepEqual(dispatchArgs({ ...CALL, why: 'a', returns: 'b' }), { task: CALL.task, harness: 'codex', model: 'zcode/GLM-5.3', cwd: null, why: 'a', returns: 'b' });
  for (const bad of [null, [], 'x', {}, { task: 'x' }, { task: ' ', harness: 'codex' }, { task: '/model x', harness: 'codex' }, { task: 'x', harness: 'dsh' }, { ...CALL, level: 'free' }, { ...CALL, ownedId: W }, { ...CALL, model: 1 }, { ...CALL, cwd: '' }, { ...CALL, cwd: 'x'.repeat(261) }, { ...CALL, why: 1 }, { ...CALL, returns: [] }]) {
    assert.equal(dispatchArgs(bad), null, JSON.stringify(bad));
  }
});

test('派前问你: a card with the session as requester; nothing starts; your 派出 is the answer, and the feed says so', async () => {
  const fx = fixture();
  const c = fx.d.call(W, CALL, fx.say);
  const [r] = pendingOf(fx);
  assert.ok(r !== undefined);
  assert.deepEqual([r.requester, r.tainted, r.model, r.askWhy, r.auto], [{ kind: 'owned', sessionId: W }, false, 'zcode/GLM-5.3', null, false]);
  assert.deepEqual(fx.started, [], 'nothing without you');
  assert.deepEqual(fx.notes, [{ state: 'worker-asked', ref: r.requestId, text: null }]);
  // owned-new's part: the session it starts is bound, and adopted.
  fx.sessions.set('c'.repeat(20), { title: 'child', tainted: false, over: false });
  assert.ok(fx.requests.bind(r.requestId, 'c'.repeat(20)));
  fx.d.adopted(fx.requests.get(r.requestId)!, 'c'.repeat(20));
  const reply = await c.reply;
  assert.equal(reply.ok, true);
  assert.match(reply.text, /^Dispatched/);
  assert.deepEqual(fx.notes.at(-1), { state: 'worker-sent', ref: `n:${'c'.repeat(20)}`, text: 'child' });
  assert.deepEqual(fx.d.sentOf('c'.repeat(20)), { by: W, via: 'person', grantAt: null });
  assert.deepEqual(fx.records, [], 'a person\'s dispatch is written by owned-new, as `human`, never here');
});

test('派前问你, then 改派: the worker reads what really runs it, the harness and model you picked, and that you moved it', async () => {
  const fx = fixture();
  const c = fx.d.call(W, CALL, fx.say);
  const [r] = pendingOf(fx);
  assert.ok(r !== undefined);
  assert.equal(r.harness, 'codex');
  fx.sessions.set('c'.repeat(20), { title: 'child', tainted: false, over: false });
  assert.ok(fx.requests.bind(r.requestId, 'c'.repeat(20), { harness: 'claude', model: 'zcode/GLM-5.3-Flash' }));
  const reply = await c.reply;
  assert.equal(reply.ok, true);
  assert.equal(reply.text, `Dispatched: a new claude worker, session ${'c'.repeat(20)}, on zcode/GLM-5.3-Flash. The person sent it to claude instead of the codex you asked for. Its result does not come back to you; the person sees it.`);
});

test('派前问你: 拒绝 and time up are refusals the worker reads; a stop takes the card back; what went out stays', async () => {
  const fx = fixture();
  const no = fx.d.call(W, CALL, fx.say);
  fx.requests.reject(pendingOf(fx)[0]!.requestId);
  assert.deepEqual(await no.reply, { ok: false, text: 'The person refused this dispatch.' });
  assert.deepEqual({ ...fx.notes.at(-1)!, ref: null }, { state: 'worker-refused', ref: null, text: 'you-rejected' });
  assert.match(String(fx.notes.at(-1)!.ref), /^[0-9a-f]{20}$/, 'it names the request, so the talk can tell which order');

  const late = fx.d.call(W, CALL, fx.say);
  fx.clock.advanceBy(REQUEST_LIMITS.ttlMs);
  assert.equal((await late.reply).ok, false);
  assert.equal(fx.notes.at(-1)!.text, 'expired');

  const stopped = fx.d.call(W, CALL, fx.say);
  const id = pendingOf(fx)[0]!.requestId;
  stopped.cancel();
  assert.equal((await stopped.reply).ok, false);
  assert.equal(fx.requests.get(id)!.state, 'withdrawn');
  assert.deepEqual(pendingOf(fx), []);

  const sent = fx.d.call(W, CALL, fx.say);
  const r = pendingOf(fx)[0]!;
  fx.requests.bind(r.requestId, 'c'.repeat(20));
  sent.cancel();
  assert.equal(fx.requests.get(r.requestId)!.state, 'dispatched', 'a stop of the worker\'s turn does not end what you dispatched');
});

test('the front desk at 派前问你: the call is answered at once and the card stands; what comes of it goes to the talk, and a stop leaves it', async () => {
  const fx = fixture();
  fx.sessions.set(W, { title: '总台', tainted: false, over: false, frontDesk: true } as S);
  const c = fx.d.call(W, { ...CALL, why: 'it is short', returns: 'the word' }, fx.say);
  const r = await c.reply;
  assert.equal(r.ok, true);
  assert.match(r.text, /^Proposed/);
  const card = pendingOf(fx)[0]!;
  assert.ok(r.text.includes(card.requestId), 'status orders lists it by this id');
  assert.deepEqual([card.reason, card.returns, card.auto, fx.started.length], ['it is short', 'the word', false, 0]);
  assert.deepEqual([card.tainted, card.fromDesk, card.askWhy], [true, true, null], 'it read what others wrote; no level said otherwise');
  assert.deepEqual(fx.notes.at(-1), { state: 'worker-asked', ref: card.requestId, text: null });
  c.cancel();
  assert.equal(pendingOf(fx).length, 1, 'no turn holds it, so a stop takes nothing back');
  fx.requests.reject(card.requestId);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(fx.notes.at(-1), { state: 'worker-refused', ref: card.requestId, text: 'you-rejected' });

  const next = fx.d.call(W, CALL, fx.say);
  await next.reply;
  const r2 = pendingOf(fx)[0]!;
  fx.requests.bind(r2.requestId, 'c'.repeat(20));
  fx.d.adopted(fx.requests.get(r2.requestId)!, 'c'.repeat(20));
  await new Promise((res) => setImmediate(res));
  assert.equal(fx.notes.at(-1)!.state, 'worker-sent');
  assert.equal(fx.d.view('c'.repeat(20)).level, 'ask', 'nothing it sent inherits a level');
  assert.equal(fx.d.view('c'.repeat(20)).depth, 1);
  assert.equal(fx.d.view('c'.repeat(20)).byDesk, true);
});

test('the front desk at 直接派出: no card, and the order says why and what comes back; away it goes back to a card, answered at once too', async () => {
  const fx = fixture();
  fx.sessions.set(W, { title: '总台', tainted: false, over: false, frontDesk: true } as S);
  fx.d.grant(W, 'free', crypto.randomUUID());
  const r = await fx.d.call(W, { ...CALL, why: 'a', returns: 'b' }, fx.say).reply;
  assert.match(r.text, /^Dispatched/);
  const made = fx.requests.list().find((x) => x.auto)!;
  assert.deepEqual([made.reason, made.returns], ['a', 'b']);
  assert.deepEqual([made.tainted, made.fromDesk], [true, true]);
  assert.deepEqual(kinds(fx).filter((k) => k === 'auto'), ['auto']);
  assert.deepEqual([fx.started[0]!.tainted, fx.started[0]!.origin.kind], [true, 'desk-dispatch'], '直接派出 still goes out at once, and the worker is held tight');
  assert.equal(fx.d.view(made.ownedId!).byDesk, true);
  assert.equal(fx.d.view(W).tainted, false, 'the desk is no tainted session: its level goes on working');
  fx.state.presence = 'away';
  const away = await fx.d.call(W, CALL, fx.say).reply;
  assert.match(away.text, /^Proposed/);
  assert.equal(pendingOf(fx)[0]!.askWhy, 'away');
});

test('直接派出: no card, a session, an `auto` record and a route of mode auto, no human record; the receipt says the permission', async () => {
  const fx = fixture();
  fx.grant();
  const at = fx.d.view(W).grantAt;
  const reply = await fx.d.call(W, CALL, fx.say).reply;
  assert.equal(reply.ok, true);
  assert.deepEqual(pendingOf(fx), [], 'no card');
  assert.equal(fx.started.length, 1);
  const child = 'b'.repeat(19) + '1';
  const r = fx.requests.list()[0]!;
  assert.deepEqual([r.state, r.auto, r.ownedId, r.tainted], ['dispatched', true, child, false]);
  assert.deepEqual([fx.started[0]!.tainted, fx.started[0]!.origin.kind, r.fromDesk, fx.d.view(child).byDesk], [false, 'worker-dispatch', false, false], 'a clean worker\'s child is clean');
  assert.deepEqual(fx.started[0]!.origin, { kind: 'worker-dispatch', requestId: r.requestId, requester: W, label: 'the worker' });
  assert.deepEqual(kinds(fx), ['route', 'auto']);
  assert.ok(!kinds(fx).some((k) => k.startsWith('human')), 'a level is no person\'s click');
  const [route, auto] = fx.records as [Rec & { body: any }, Rec & { body: any }];
  assert.deepEqual([route.body.mode, route.body.reason, route.body.router, route.body.ownedId], ['auto', 'worker', 'not-asked', child]);
  assert.deepEqual([auto.body.by, auto.body.ownedId, auto.body.depth, auto.body.decisionId], [W, child, 1, route.body.decisionId]);
  for (const x of fx.records) assert.equal(checkBody(x.kind, x.body), null, x.kind);
  assert.deepEqual(fx.notes, [{ state: 'worker-sent-grant', ref: `n:${child}`, text: 'child 1' }]);
  assert.deepEqual(fx.d.sentOf(child), { by: W, via: 'grant', grantAt: at });
});

test('what a session sent out starts at 派前问你, whatever its sender holds, and the chain has an end', async () => {
  const fx = fixture();
  fx.grant();
  await fx.d.call(W, CALL, fx.say).reply;
  const c1 = 'b'.repeat(19) + '1';
  assert.deepEqual([fx.d.view(c1).level, fx.d.view(c1).grantAt, fx.d.view(c1).depth], ['ask', null, 1], 'not inherited');
  fx.d.call(c1, CALL, fx.say);
  assert.equal(pendingOf(fx).length, 1, 'its own call is a card, and A17 holds: nothing multiplies by itself');
  // A person opens it: then the chain goes one further, and stops.
  fx.grant(c1);
  await fx.d.call(c1, CALL, fx.say).reply;
  const c2 = 'b'.repeat(19) + '2';
  assert.equal(fx.d.view(c2).depth, DISPATCH_LIMITS.depth);
  fx.grant(c2);
  const n = fx.started.length;
  const r = await fx.d.call(c2, CALL, fx.say).reply;
  assert.equal(r.ok, false);
  assert.deepEqual(fx.notes.at(-1), { state: 'worker-refused', ref: null, text: 'depth' });
  assert.equal(fx.started.length, n);
  const asked = await fx.d.call(c2, { ...CALL }, fx.say).reply;
  assert.equal(asked.ok, false, 'at the depth limit there is no card either');
});

test('what a dispatched session\'s cards name its sender by is a label, not the title: cut to the contract\'s bound, and said to be cut; none for no title or no session', async () => {
  const fx = fixture();
  fx.sessions.get(W)!.title = '修'.repeat(80);
  fx.grant();
  await fx.d.call(W, CALL, fx.say).reply;
  const label = fx.started[0]!.origin.label!;
  assert.ok(label.endsWith('…') && Buffer.byteLength(label) <= OWNED_BOUNDS.requestLabelBytes, label);
  assert.equal(fx.d.labelOf(W), label);
  fx.sessions.get(W)!.title = '修'.repeat(40);
  assert.equal(fx.d.labelOf(W), '修'.repeat(40), 'one that fits is left whole');
  fx.sessions.get(W)!.title = '';
  assert.equal(fx.d.labelOf(W), null, 'the card then names the session by its id');
  assert.equal(fx.d.labelOf('f'.repeat(20)), null);
});

test('the desk knows a dispatch on a permission from one of yours, live and from its record', async () => {
  const fx = fixture();
  fx.grant();
  await fx.d.call(W, CALL, fx.say).reply;
  assert.equal(fx.deps.desk!.last()?.auto, true);
  assert.equal(dispatchOf(fx.records[0]!.body, 7)?.auto, true);
});

test('a tainted session goes back to a card at 直接派出, and says why; what it dispatches is tainted', async () => {
  const fx = fixture();
  fx.sessions.get(W)!.tainted = true;
  fx.grant();
  fx.d.call(W, CALL, fx.say);
  const r = pendingOf(fx)[0]!;
  assert.deepEqual([r.tainted, r.askWhy, r.auto], [true, 'tainted', false]);
  assert.deepEqual(fx.started, []);
  assert.deepEqual(fx.notes, [{ state: 'worker-asked', ref: r.requestId, text: 'tainted' }]);
});

test('while you are away, or nobody knows, 直接派出 goes back to a card (r4 D20)', () => {
  const fx = fixture();
  fx.grant();
  fx.state.presence = 'away';
  fx.d.call(W, CALL, fx.say);
  assert.deepEqual([pendingOf(fx)[0]!.askWhy, pendingOf(fx)[0]!.tainted], ['away', false]);
  fx.state.presence = 'unknown';
  fx.d.call(W, CALL, fx.say);
  assert.equal(pendingOf(fx)[1]!.askWhy, 'presence-unknown');
  assert.deepEqual(fx.started, []);
});

test('直接派出 goes through every other check: limit, rate, model, root, spawn; each refused and told, nothing queued', async () => {
  const refusedBy = async (fx: ReturnType<typeof fixture>, call: unknown, code: string) => {
    const n = fx.started.length;
    const r = await fx.d.call(W, call, fx.say).reply;
    assert.equal(r.ok, false, code);
    assert.deepEqual(fx.notes.at(-1), { state: 'worker-refused', ref: null, text: code });
    assert.equal(fx.started.length, n, code);
    assert.deepEqual(pendingOf(fx), [], `${code}: no card, and nothing waits`);
    assert.ok(!kinds(fx).includes('auto') || fx.records.filter((x) => x.kind === 'auto').length === n, code);
  };
  const fx = fixture();
  fx.grant();
  await refusedBy(fx, { ...CALL, harness: 'claude', model: 'codex/gpt-6.1-sol' }, 'model-refused');
  await refusedBy(fx, { ...CALL, model: 'openai/gpt' }, 'model-refused');
  await refusedBy(fx, { ...CALL, cwd: 'C:\\protected\\x' }, 'cwd-forbidden');
  await refusedBy(fx, { ...CALL, cwd: 'E:\\elsewhere' }, 'cwd-outside');
  await refusedBy(fx, { ...CALL, ownedId: 'x' }, 'bad-input');
  fx.state.full = true;
  await refusedBy(fx, CALL, 'owned-limit');
  fx.state.full = false;
  for (let i = 0; i < REQUEST_LIMITS.perWindow; i++) assert.equal((await fx.d.call(W, CALL, fx.say).reply).ok, true);
  await refusedBy(fx, CALL, 'rate');
  // In a project root: where the session runs is what it asked for.
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  await fx.d.call(W, { ...CALL, cwd: 'D:\\proj\\web' }, fx.say).reply;
  assert.equal(fx.started.at(-1)!.cwd, 'D:\\proj\\web');
});

test('a session the spawn gate refuses is no dispatch: the request fails and the worker is told; one that cannot be written down is ended', async () => {
  const fx = fixture({ start: () => ({ ok: false, reason: 'spawn-refused', detail: 'gate' }) });
  fx.grant();
  assert.equal((await fx.d.call(W, CALL, fx.say).reply).ok, false);
  assert.deepEqual(fx.notes.at(-1), { state: 'worker-refused', ref: null, text: 'start-failed' });
  assert.deepEqual([fx.requests.list()[0]!.state, fx.requests.list()[0]!.why], ['failed', 'start-failed']);
  assert.deepEqual(fx.records, []);

  const bad = fixture({ commit: () => { throw new Error('disk'); } });
  bad.grant();
  assert.equal((await bad.d.call(W, CALL, bad.say).reply).ok, false);
  assert.deepEqual(bad.ended, ['b'.repeat(19) + '1']);
  assert.deepEqual(bad.notes.at(-1), { state: 'worker-refused', ref: null, text: 'record-failed' });
});

test('a session over or unknown dispatches nothing', async () => {
  const fx = fixture();
  fx.sessions.get(W)!.over = true;
  fx.grant();
  assert.equal((await fx.d.call(W, CALL, fx.say).reply).ok, false);
  assert.equal((await fx.d.call('d'.repeat(20), CALL, fx.say).reply).ok, false);
  assert.deepEqual(fx.started, []);
});

test('a seat request never meets a level: with every level open it waits for a click, even naming a session that holds one', () => {
  const fx = fixture();
  fx.grant();
  const made = fx.requests.create({ harness: 'codex', text: 'do it', cwd: 'D:\\x', label: null, requester: { kind: 'dsh', sessionId: W } });
  assert.ok(made.ok);
  assert.deepEqual([made.request.state, made.request.auto, made.request.tainted, made.request.ownedId], ['pending', false, true, null]);
  assert.deepEqual(fx.started, []);
  assert.deepEqual(pendingOf(fx).length, 1);
});

test('what an agent\'s side holds has no way to set a level: the port is call and sentOf', () => {
  const link = makeDispatchLink();
  assert.deepEqual(Object.keys(link.port).sort(), ['call', 'sentOf']);
  const fx = fixture();
  link.bind(fx.d);
  assert.deepEqual(Object.keys(link.port).sort(), ['call', 'sentOf'], 'the same after binding: the grant stays the dispatcher\'s');
  assert.equal('grant' in link.port, false);
});

test('a link not yet bound refuses', async () => {
  const link = makeDispatchLink();
  assert.equal((await link.port.call(W, CALL, () => {}).reply).ok, false);
  assert.equal(link.port.sentOf(W), null);
});

test('the host restates the tool: the same description and schema, under the MCP name the CLI gives it', () => {
  assert.equal(HOST_TOOL.description, DISPATCH_TOOL.description);
  assert.deepEqual(HOST_TOOL.inputSchema, DISPATCH_TOOL.inputSchema);
  assert.equal(DISPATCH_TOOL_ID, `mcp__${DISPATCH_SERVER}__dispatch`);
});

test('presence: unknown until a page is heard; present with a heartbeat and an action; either gone is away', () => {
  let now = 1000;
  const p = makePresence({ nowMono: () => now });
  assert.equal(p.state(), 'unknown');
  p.beat();
  assert.equal(p.state(), 'away', 'a page that only reads is no action (r4 Q-P3)');
  p.acted();
  assert.equal(p.state(), 'present');
  now += PRESENCE_LIMITS.beatMs;
  assert.equal(p.state(), 'present');
  now += 1;
  assert.equal(p.state(), 'away', 'the page went');
  p.beat();
  assert.equal(p.state(), 'present');
  now += PRESENCE_LIMITS.actionMs;
  p.beat();
  assert.equal(p.state(), 'away', 'the heartbeat goes on, but nothing was done for 30 minutes');
});
