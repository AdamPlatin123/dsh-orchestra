import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock, oneShot } from '../../src/runtime/clock.ts';
import { Feed } from '../../src/owned/feed.ts';
import type { FeedInput } from '../../src/owned/feed.ts';
import type { Observed, RequestsDeps } from '../../src/route/requests.ts';
import { REQUEST_LIMITS, lastMessage, makeRequests, requestedOwnedIn } from '../../src/route/requests.ts';
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
/** The same ask from requester `i` (each requester may have only REQUEST_LIMITS.perRequester pending). */
const from = (i: number) => ({ ...ask, requester: { kind: 'dsh' as const, sessionId: `sess-${i}` } });
const made = (r: ReturnType<ReturnType<typeof makeRequests>['create']>) => r as { ok: true; request: { requestId: string }; withdrawKey: string };
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
  const first = made(fx.requests.create(ask));
  const id = first.request.requestId;
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
  assert.deepEqual([Buffer.byteLength(cut.text!), cut.truncated, cut.cuts], [8192, true, ['cap']]);
  const pre = new Feed(() => 0);
  push(pre, { kind: 'text', ref: 'm', text: 'D', state: 'final-cut' });
  assert.deepEqual([lastMessage(pre.since(0), 99)!.truncated, lastMessage(pre.since(0), 99)!.cuts], [true, ['final-cut']]);
  assert.equal(lastMessage(new Feed(() => 0).since(0), 99), null, 'a turn that said nothing, on a whole feed, hands back nothing');
  // T1: a feed that dropped events and has no message left is "not known", never "nothing".
  assert.deepEqual(lastMessage({ clipped: true, events: [] }, 99), { text: null, truncated: true, cuts: ['feed-clipped'] });
  const clippedOne = lastMessage({ clipped: true, events: [{ seq: 5, at: 0, kind: 'text', ref: 'm', uuid: null, text: 'tail', state: 'final', redactions: 0, live: false } as never] }, 9)!;
  assert.deepEqual([clippedOne.text, clippedOne.truncated, clippedOne.cuts], ['tail', true, ['feed-clipped']]);
  // A withdrawal after it is over changes nothing (DSH calls dispose() after a normal end too).
  assert.equal(fx.requests.get(id)!.fetched, false, 'done is not fetched until the port hands it out');
  fx.requests.fetched(id);
  assert.equal(fx.requests.get(id)!.fetched, true);
  const after = fx.requests.withdraw(id, first.withdrawKey);
  assert.deepEqual(after.ok ? after.request.state : after.why, 'done');
  assert.deepEqual(fx.ended, []);
});

test('a turn that fails, or a session that ends first, is failed with why; never done', () => {
  const fx = fixture();
  const one = (fx.requests.create(ask) as { ok: true; request: { requestId: string } }).request.requestId;
  const two = (fx.requests.create(from(2)) as { ok: true; request: { requestId: string } }).request.requestId;
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

test('withdraw: only the submitter\'s key; a pending request goes; a dispatched or running one ends its session by the normal stop order (owned-end), never the brake', () => {
  // Every dep the store ever reads is recorded: it reads only its own, and none of them is a brake.
  const read = new Set<string>();
  const fx = fixture();
  const spy = (deps: RequestsDeps) => new Proxy(deps, { get: (o, k) => { read.add(String(k)); return Reflect.get(o, k); } });
  const state = (w: ReturnType<typeof fx.requests.withdraw>) => (w.ok ? w.request.state : w.why);
  const pm = made(fx.requests.create(ask));
  const p = pm.request.requestId;
  assert.match(pm.withdrawKey, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(state(fx.requests.withdraw(p, 'A'.repeat(22))), 'not-requester', 'a key that is not the submitter\'s withdraws nothing');
  assert.equal(state(fx.requests.withdraw(p, '')), 'not-requester');
  assert.equal(fx.requests.get(p)!.state, 'pending');
  assert.deepEqual([state(fx.requests.withdraw(p, pm.withdrawKey)), fx.requests.get(p)!.why], ['withdrawn', 'requester-withdrew']);
  assert.deepEqual(fx.ended, [], 'nothing to end: it never ran');
  const rm = made(fx.requests.create(ask));
  const r = rm.request.requestId;
  const s = fx.session(OID);
  fx.requests.bind(r, OID);
  s.state = 'running';
  assert.equal(state(fx.requests.withdraw(r, pm.withdrawKey)), 'not-requester', 'another request\'s key does not withdraw this one');
  assert.deepEqual(fx.ended, []);
  assert.equal(state(fx.requests.withdraw(r, rm.withdrawKey)), 'withdrawn');
  assert.deepEqual(fx.ended, [OID], 'endOwned once: the owned-end stop order');
  assert.equal(state(fx.requests.withdraw(r, rm.withdrawKey)), 'withdrawn', 'a second withdraw is a no-op');
  assert.deepEqual(fx.ended, [OID]);
  assert.equal(state(fx.requests.withdraw('f'.repeat(20), rm.withdrawKey)), 'request-unknown');
  // The store is never handed a brake: the deps it reads, through a whole life, are its own and nothing else.
  const ended: string[] = [];
  const clock = new VirtualClock({ mono: 1000, wall: 1_800_000_000_000 });
  const cp = clock.port(null);
  const sess = { state: 'running' as const, endReason: null, feed: new Feed(() => 0) };
  const store = makeRequests(spy({
    after: oneShot(clock, 'requests-spy'), nowMono: () => cp.nowMono(), nowWall: () => cp.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => sess, endOwned: (id) => { ended.push(id); return true; }, suggest: async () => null, onMove: () => {},
    brake: () => { throw new Error('the store must never brake'); },
  } as RequestsDeps & { brake(): never }));
  const a = made(store.create(ask));
  store.bind(a.request.requestId, OID);
  clock.advanceBy(REQUEST_LIMITS.watchMs);
  store.withdraw(a.request.requestId, a.withdrawKey);
  store.close();
  assert.deepEqual(ended, [OID]);
  assert.ok(!read.has('brake'), [...read].join());
  for (const k of read) assert.ok(['after', 'nowMono', 'nowWall', 'redact', 'observe', 'endOwned', 'suggest', 'ttlMs', 'onMove', 'seeded'].includes(k), k);
});

test('limits per requester: at most 4 pending from one requester (as it names itself); the others still ask', () => {
  const fx = fixture();
  for (let i = 0; i < REQUEST_LIMITS.perRequester; i++) assert.ok(fx.requests.create(ask).ok);
  assert.deepEqual(fx.requests.create(ask), { ok: false, why: 'requester-full' });
  assert.ok(fx.requests.create(from(2)).ok, 'another requester is not held');
  assert.ok(fx.requests.create({ ...ask, requester: { kind: 'dsh', sessionId: null } }).ok, 'nor one that names none');
  const first = fx.requests.list()[0]!;
  fx.requests.reject(first.requestId);
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  assert.ok(fx.requests.create(ask).ok, 'a pending one that is over frees its place');
});

test('at most 16 kept and 6 a minute: a full store makes room only from requests that are over', () => {
  const fx = fixture();
  const ids: string[] = [];
  let n = 0;
  for (let i = 0; i < 6; i++) ids.push(made(fx.requests.create(from(n++))).request.requestId);
  assert.deepEqual(fx.requests.create(from(n)), { ok: false, why: 'rate' });
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  for (let i = 0; i < 6; i++) ids.push(made(fx.requests.create(from(n++))).request.requestId);
  fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
  for (let i = 0; i < 4; i++) ids.push(made(fx.requests.create(from(n++))).request.requestId);
  assert.equal(fx.requests.list().length, 16);
  assert.deepEqual(fx.requests.create(from(n)), { ok: false, why: 'full' }, 'sixteen waiting: no room');
  fx.requests.reject(ids[3]!);
  const next = fx.requests.create(from(n));
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

test('never cut silently (A16): a text or cwd that only fits before its invisible characters are written out is refused; a cut label ends in …', () => {
  const fx = fixture();
  // 1500 + 150 x 3 bytes as sent (1950, under 2048); written out, each \u200b is 6 bytes (2400, over).
  const zw = `${'a'.repeat(1500)}${'\u200b'.repeat(150)}`;
  assert.ok(Buffer.byteLength(zw) <= REQUEST_LIMITS.textBytes);
  assert.deepEqual(fx.requests.create({ ...ask, text: zw }), { ok: false, why: 'text-too-long' });
  assert.deepEqual(fx.requests.create({ ...ask, cwd: `D:\\${'\u200b'.repeat(100)}` }), { ok: false, why: 'cwd-too-long' });
  const long = fx.requests.create({ ...ask, label: '标'.repeat(100) });
  assert.ok(long.ok);
  assert.ok(long.request.label!.endsWith('…') && Buffer.byteLength(long.request.label!) <= REQUEST_LIMITS.labelBytes, long.request.label!);
  assert.deepEqual(fx.requests.list().length, 1, 'the refused ones were never made');
});

test('the journal remembers which sessions were dispatched for a request: requestedGone names them once the request itself is gone', () => {
  const rows = [
    { body: JSON.stringify({ verdict: 'dispatched', ownedId: 'c'.repeat(20) }) },
    { body: JSON.stringify({ verdict: 'rejected', ownedId: null }) },
    { body: 'not json' },
    { body: JSON.stringify({ verdict: 'dispatched', ownedId: 'd'.repeat(20) }) },
  ];
  const seeded = requestedOwnedIn({ all: () => rows });
  assert.deepEqual(seeded, ['d'.repeat(20), 'c'.repeat(20)], 'oldest first (the rows came newest first)');
  const fx = fixture({ seeded });
  assert.deepEqual(fx.requests.requestedGone(), seeded);
  const m = made(fx.requests.create(ask));
  fx.session(OID);
  fx.requests.bind(m.request.requestId, OID);
  assert.deepEqual(fx.requests.requestedGone(), seeded, 'a request still held is not "gone"');
  // Evicted (16 kept, the over ones go first): its session is still named.
  fx.requests.reject(made(fx.requests.create(from(1))).request.requestId);
  fx.requests.withdraw(m.request.requestId, m.withdrawKey);
  let n = 2;
  for (let i = 0; i < 16; i++) {
    if (i % REQUEST_LIMITS.perWindow === 0) fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
    assert.ok(fx.requests.create(from(n++)).ok);
  }
  assert.equal(fx.requests.ofOwned(OID), null);
  assert.deepEqual(fx.requests.requestedGone(), [...seeded, OID]);
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
  assert.equal(fx.requests.get(id)!.suggesting, 'asking');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, { text: ask.text, harness: 'codex' });
  assert.equal(fx.requests.get(id)!.suggesting, 'ready');
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

test('where the suggestion stands is said, never one word for all: no desk, the desk had none, it failed (T1)', async () => {
  assert.equal(made(fixture().requests.create(ask)).request.suggesting === undefined, false);
  const none = fixture();
  assert.equal(none.requests.get(made(none.requests.create(ask)).request.requestId)!.suggesting, 'no-desk');
  const empty = fixture({ suggest: async () => null });
  const e = made(empty.requests.create(ask)).request.requestId;
  const failing = fixture({ suggest: async () => { throw new Error('router down'); } });
  const f = made(failing.requests.create(ask)).request.requestId;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([empty.requests.get(e)!.suggesting, empty.requests.get(e)!.suggestion], ['none', null]);
  assert.deepEqual([failing.requests.get(f)!.suggesting, failing.requests.get(f)!.suggestion], ['failed', null]);
});
