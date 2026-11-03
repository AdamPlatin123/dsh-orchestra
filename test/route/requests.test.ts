import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock, oneShot } from '../../src/runtime/clock.ts';
import { Feed } from '../../src/owned/feed.ts';
import type { FeedInput } from '../../src/owned/feed.ts';
import type { Observed, RequestsDeps } from '../../src/route/requests.ts';
import { REQUEST_LIMITS, lastMessage, makeRequests } from '../../src/route/requests.ts';
import type { SuggestReply } from '../../src/route/desk.ts';

// seat's agent requests (final.md §5.1; r4 A17: an agent may only ask, and a person decides): the state
// machine on a virtual clock, the expiry as a refusal (D8), the thin completion handed back (A16), and a
// withdrawal that ends the session the normal way and never by the brake. Synthetic text only.

const MIN = 60_000;
type Fake = { state: Observed['state']; endReason: string | null; feed: Feed };

function fixture(over: Partial<RequestsDeps> = {}) {
  const clock = new VirtualClock({ mono: 1000, wall: 1_800_000_000_000 });
  const port = clock.port(null);
  const sessions = new Map<string, Fake>();
  const ended: string[] = [];
  const moves: string[] = [];
  const deps: RequestsDeps = {
    after: oneShot(clock, 'requests-test'),
    nowMono: () => port.nowMono(),
    nowWall: () => port.nowWall(),
    redact: (text) => ({ text: text.replaceAll('sk-SECRET', '[redacted]'), count: text.includes('sk-SECRET') ? 1 : 0 }),
    observe: (id) => sessions.get(id) ?? null,
    endOwned: (id) => {
      ended.push(id);
      const s = sessions.get(id);
      if (s !== undefined) s.state = 'ended';
      return s !== undefined;
    },
    onMove: (r, from) => moves.push(`${r.requestId.slice(0, 4)} ${from}>${r.state}`),
    ...over,
  };
  const requests = makeRequests(deps);
  const session = (id: string) => {
    const s: Fake = { state: 'starting', endReason: null, feed: new Feed(() => port.nowWall()) };
    sessions.set(id, s);
    return s;
  };
  return { clock, requests, session, ended, moves };
}

const ask = { harness: 'codex' as const, text: '修一下登录页的样式', cwd: 'D:\\work\\shop', label: null, requester: { kind: 'dsh' as const, sessionId: 'sess-1' } };
const OID = 'a'.repeat(20);
const push = (f: Feed, e: Partial<FeedInput> & { kind: FeedInput['kind'] }) => f.push({ ref: null, text: null, state: null, ...e } as FeedInput);

test('a pending request expires after its time: a refusal by the clock (D8), its waits answered at once', async () => {
  const fx = fixture({ ttlMs: 10 * MIN });
  const made = fx.requests.create(ask);
  assert.ok(made.ok);
  const id = made.request.requestId;
  assert.match(id, /^[0-9a-f]{20}$/);
  assert.equal(made.request.state, 'pending');
  assert.equal(made.request.expiresWall, made.request.createdWall + 10 * MIN);
  let woke = false;
  const w = fx.requests.wait(id, 11 * MIN).then(() => { woke = true; });
  fx.clock.advanceBy(10 * MIN - 1);
  await Promise.resolve();
  assert.equal(woke, false);
  assert.equal(fx.requests.get(id)!.state, 'pending', 'not a moment early');
  fx.clock.advanceBy(1);
  await w;
  assert.equal(woke, true);
  const r = fx.requests.get(id)!;
  assert.deepEqual([r.state, r.why, r.ownedId], ['expired', 'expired', null]);
  // An expired request is no longer dispatchable, nor rejectable.
  assert.deepEqual(fx.requests.claim(id, ask.text, 'codex'), { ok: false, why: 'request-gone' });
  assert.equal(fx.requests.reject(id), false);
});

test('a long poll answers at the request\'s next move, or when its wait is over', async () => {
  const fx = fixture();
  const id = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  let done = false;
  const w = fx.requests.wait(id, 25_000).then(() => { done = true; });
  fx.clock.advanceBy(24_999);
  await Promise.resolve();
  assert.equal(done, false);
  fx.clock.advanceBy(1);
  await w;
  assert.equal(done, true, 'the wait is over: answered with the state as it is');
  const w2 = fx.requests.wait(id, 25_000);
  assert.equal(fx.requests.reject(id), true);
  await w2;
  assert.deepEqual([fx.requests.get(id)!.state, fx.requests.get(id)!.why], ['rejected', 'you-rejected']);
});

test('dispatched, running, done: the last agent message of the first turn, at most 8 KiB, marked when cut (A16)', () => {
  const fx = fixture();
  const id = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  // The card's own words and harness, or nothing (request-mismatch).
  assert.deepEqual(fx.requests.claim(id, `${ask.text}!`, 'codex'), { ok: false, why: 'request-mismatch' });
  assert.deepEqual(fx.requests.claim(id, ask.text, 'claude'), { ok: false, why: 'request-mismatch' });
  assert.equal(fx.requests.claim(id, ask.text, 'codex').ok, true);
  const s = fx.session(OID);
  assert.equal(fx.requests.bind(id, OID), true);
  assert.equal(fx.requests.bind(id, OID), false, 'bound once');
  assert.deepEqual([fx.requests.get(id)!.state, fx.requests.get(id)!.ownedId], ['dispatched', OID]);
  assert.deepEqual(fx.requests.claim(id, ask.text, 'codex'), { ok: false, why: 'request-gone' }, 'no second dispatch');
  s.state = 'running';
  push(s.feed, { kind: 'you', text: ask.text, uuid: '00000000-0000-4000-8000-000000000000' });
  push(s.feed, { kind: 'lifecycle', ref: 't1', state: 'turn-started' });
  fx.clock.advanceBy(REQUEST_LIMITS.watchMs);
  assert.equal(fx.requests.get(id)!.state, 'running');
  push(s.feed, { kind: 'text', ref: 'm1', text: 'first thoughts', state: 'final' });
  push(s.feed, { kind: 'text', ref: 'm2', text: 'live', state: 'partial' });
  push(s.feed, { kind: 'text', ref: 'm2', text: 'A'.repeat(2048), state: 'final' });
  push(s.feed, { kind: 'text', ref: 'm2', text: 'B'.repeat(2048), state: 'final' });
  push(s.feed, { kind: 'lifecycle', ref: 't1', state: 'turn-ended' });
  push(s.feed, { kind: 'text', ref: 'm3', text: 'a later turn says this', state: 'final' });
  s.state = 'idle';
  fx.clock.advanceBy(REQUEST_LIMITS.watchMs);
  const r = fx.requests.get(id)!;
  assert.equal(r.state, 'done');
  assert.equal(r.output, 'A'.repeat(2048) + 'B'.repeat(2048), 'the newest message before the turn ended, its parts joined');
  assert.equal(r.truncated, false);
  assert.equal(fx.ended.length, 0, 'the session stays: done is no verdict, nothing ends it (D19)');
  // Over 8 KiB, or a part the session cut already, is marked.
  const big = new Feed(() => 0);
  for (let i = 0; i < 5; i++) push(big, { kind: 'text', ref: 'm', text: 'C'.repeat(2048), state: 'final' });
  const end = push(big, { kind: 'lifecycle', state: 'turn-ended' });
  const cut = lastMessage(big.since(0), end.seq)!;
  assert.deepEqual([Buffer.byteLength(cut.text), cut.truncated], [8192, true]);
  const pre = new Feed(() => 0);
  push(pre, { kind: 'text', ref: 'm', text: 'D', state: 'final-cut' });
  assert.equal(lastMessage(pre.since(0), 99)!.truncated, true);
  assert.equal(lastMessage(new Feed(() => 0).since(0), 99), null, 'a turn that said nothing hands back nothing');
  // A withdrawal after it is over changes nothing (DSH calls dispose() after a normal end too).
  assert.equal(fx.requests.withdraw(id)!.state, 'done');
  assert.deepEqual(fx.ended, []);
});

test('a turn that fails, or a session that ends first, is failed with why; never done', () => {
  const fx = fixture();
  const one = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  const two = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  const s1 = fx.session(OID);
  const s2 = fx.session('b'.repeat(20));
  fx.requests.bind(one, OID);
  fx.requests.bind(two, 'b'.repeat(20));
  push(s1.feed, { kind: 'lifecycle', state: 'turn-interrupted' });
  s2.state = 'ended';
  s2.endReason = 'braked';
  fx.clock.advanceBy(REQUEST_LIMITS.watchMs);
  assert.deepEqual([fx.requests.get(one)!.state, fx.requests.get(one)!.why], ['failed', 'turn-interrupted']);
  assert.deepEqual([fx.requests.get(two)!.state, fx.requests.get(two)!.why], ['failed', 'session-braked']);
});

test('withdraw: a pending request goes; a dispatched or running one ends its session by the normal stop order (owned-end), never the brake', () => {
  const fx = fixture();
  const p = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  assert.deepEqual([fx.requests.withdraw(p)!.state, fx.requests.get(p)!.why], ['withdrawn', 'requester-withdrew']);
  assert.deepEqual(fx.ended, [], 'nothing to end: it never ran');
  const r = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  const s = fx.session(OID);
  fx.requests.bind(r, OID);
  s.state = 'running';
  assert.equal(fx.requests.withdraw(r)!.state, 'withdrawn');
  assert.deepEqual(fx.ended, [OID], 'endOwned once: the owned-end stop order');
  assert.equal(fx.requests.withdraw(r)!.state, 'withdrawn', 'a second withdraw is a no-op');
  assert.deepEqual(fx.ended, [OID]);
  assert.equal(fx.requests.withdraw('f'.repeat(20)), null);
  // The store is never handed a brake: its deps name only endOwned.
  assert.ok(!Object.keys(fixture()).includes('brake'));
});

test('at most 16 kept and 6 a minute: a full store makes room only from requests that are over', () => {
  const fx = fixture();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId);
  assert.deepEqual(fx.requests.create(ask), { ok: false, why: 'rate' });
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  for (let i = 0; i < 6; i++) ids.push((fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId);
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  for (let i = 0; i < 4; i++) ids.push((fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId);
  assert.equal(fx.requests.list().length, 16);
  assert.deepEqual(fx.requests.create(ask), { ok: false, why: 'full' }, 'sixteen waiting: no room');
  fx.requests.reject(ids[3]!);
  const next = fx.requests.create(ask);
  assert.ok(next.ok, 'a rejected one made room');
  assert.equal(fx.requests.get(ids[3]!), null, 'the over one went');
  assert.equal(fx.requests.list().length, 16);
});

test('the requester\'s words are redacted and their invisible characters written out before anything shows or runs them', () => {
  const fx = fixture();
  const made = fx.requests.create({ ...ask, text: 'use sk-SECRET then\u202Edo it', label: 'a\nb', cwd: 'D:\\sk-SECRET' });
  assert.ok(made.ok);
  assert.equal(made.request.text, 'use [redacted] then\\u202Edo it');
  assert.equal(made.request.label, 'a', 'one line');
  assert.equal(made.request.cwd, 'D:\\[redacted]');
  assert.equal(fx.requests.claim(made.request.requestId, made.request.text, 'codex').ok, true, 'the card\'s text is what a dispatch sends');
});

test('the desk\'s suggestion for the request\'s harness reaches the card; close() ends every open request and wakes every wait', async () => {
  let asked: { text: string; harness: string } | null = null;
  const reply = {
    routeId: 'e'.repeat(20), router: { model: 'zcode/GLM-5.3', state: 'answered', why: null, pick: 1 },
    candidates: [
      { harness: 'claude', model: 'zcode/GLM-5.3', source: 'rule', rule: 'fallback', reason: null },
      { harness: 'codex', model: 'codex/gpt-6.1-terra', source: 'model', rule: null, reason: '改代码' },
    ],
  } as unknown as SuggestReply;
  const fx = fixture({ suggest: async (text, harness) => { asked = { text, harness }; return reply; } });
  const id = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, { text: ask.text, harness: 'codex' });
  assert.deepEqual(fx.requests.get(id)!.suggestion, {
    routeId: 'e'.repeat(20), router: 'answered', models: [{ model: 'codex/gpt-6.1-terra', source: 'model', rule: null, reason: '改代码' }], pick: 0,
  }, 'only its harness, the pick re-indexed');
  const w = fx.requests.wait(id, 25_000);
  fx.requests.close();
  await w;
  assert.deepEqual([fx.requests.get(id)!.state, fx.requests.get(id)!.why], ['failed', 'daemon-stop']);
  assert.deepEqual(fx.requests.create(ask), { ok: false, why: 'stopped' });
  assert.ok(fx.moves.some((m) => m.endsWith('pending>failed')));
});
