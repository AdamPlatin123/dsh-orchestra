import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { Feed } from '../../src/owned/feed.ts';
import { makeDesk } from '../../src/route/desk.ts';
import type { DispatchNote, Dispatcher } from '../../src/route/dispatch.ts';
import { makeDispatcher } from '../../src/route/dispatch.ts';
import { makePresence } from '../../src/route/presence.ts';
import { makeRequests } from '../../src/route/requests.ts';
import type { Requests } from '../../src/route/requests.ts';
import { Log } from '../../src/runtime/log.ts';
import { oneShot } from '../../src/runtime/clock.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import { ownedEnabled, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import type { Store } from '../../src/store/store.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// The dispatch permission on the paired page (orchestra app plan 派活权限; D8): POST /api/owned/:id/dispatch-grant runs the
// whole check chain of the owned routes and writes a person's records; a worker's request dispatched by a person is
// a clean one's or a tainted one's, as its session was. The session manager is a stand-in; no child process, no network.

const CODE = '12345678';
const W = 'a'.repeat(20);
const T = 'b'.repeat(20);
const uuid = () => crypto.randomUUID();
type Fx = { server: PeekServer; host: string; origin: string; store: Store; requests: Requests; dispatch: Dispatcher; made: Record<string, unknown>[]; printed: string[]; over: Set<string> };

async function fixture(t: TestContext): Promise<Fx> {
  const sf = await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const printed: string[] = [];
  const made: Record<string, unknown>[] = [];
  const over = new Set<string>();
  const session = (id: string, tainted: boolean) => ({
    ownedId: id, model: 'codex/gpt-6.1-sol', cwd: '', tainted, get state() { return over.has(id) ? 'ended' : 'idle'; }, get endReason() { return over.has(id) ? 'you-ended' : null; },
    tokens: null, queued: 0, jobbed: false, stoppable: false, feed: new Feed(() => clock.nowWall()),
  });
  const held = new Map([[W, session(W, false)], [T, session(T, true)]]);
  const titles = new Map<string, string>();
  const titleOf = (id: string) => titles.get(id) ?? `session ${id.slice(0, 4)}`;
  let n = 0;
  const codex = {
    create(req: Record<string, unknown>) {
      made.push(req);
      const ownedId = (++n).toString(16).padStart(20, 'c');
      held.set(ownedId, session(ownedId, req.tainted === true));
      return { ok: true as const, ownedId, session: { model: req.model ?? 'codex/gpt-6.1-sol' } };
    },
    get: (id: string) => held.get(id) ?? null, list: () => [...held.values()], meta: (id: string) => ({ ownedId: id, harness: 'codex', title: titleOf(id), createdAt: 0 }), maxActive: 3, approvals: null, full: () => false,
  };
  const desk = makeDesk({ post: null, routerModel: 'zcode/GLM-5.3', on: () => ({ codex: true, claude: false }), redact: (s) => s, nowMono: () => sf.clock.mono, nowWall: () => sf.clock.wall });
  const requests = makeRequests({
    after: oneShot(sf.clock, 'dispatch-grant-http'), nowMono: () => clock.nowMono(), nowWall: () => clock.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => ({ state: 'starting', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }), endOwned: () => false,
  });
  const presence = makePresence({ nowMono: () => clock.nowMono() });
  const dispatch = makeDispatcher({
    requests, desk, log, presence: () => presence.state(), session: (id) => { const s = held.get(id); return s === undefined ? null : { title: titleOf(id), tainted: s.tainted, over: over.has(id) }; },
    on: () => true, full: () => false, start: () => ({ ok: false, reason: 'spawn-refused', detail: 'not here' }), end: () => {}, judgeCwd: () => null, cwdRecord: () => [], commit: (r) => void store.commit(r), nowWall: () => clock.nowWall(),
  });
  const deps = { codex: codex as never, codexOff: 'on', claude: null, desk, log, requests, dispatch };
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: CODE, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: (c) => printed.push(c), enabled: ownedEnabled(deps), handlers: registerOwnedHandlers(deps), presence },
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, store, requests, dispatch, made, printed, over, titles };
}

type Reply = { status: number; body: string; json: any };
function request(fx: Fx, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.server.port, method, path: pathname, headers: { host: fx.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, body: text, json: (res.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function unlocked(fx: Fx): Promise<Record<string, string>> {
  const p = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.server.port, method: 'POST', path: '/pair', headers: { host: fx.host, origin: fx.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } }, (res) => { res.resume(); resolve(res); });
    req.on('error', reject);
    req.end(`code=${CODE}`);
  });
  const cookie = String(p.headers['set-cookie']).split(';')[0]!;
  const base = { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' };
  assert.equal((await request(fx, 'POST', '/api/owned/unlock-code', base)).status, 204);
  const u = await request(fx, 'POST', '/api/owned/unlock', { ...base, 'content-type': 'application/json' }, JSON.stringify({ code: fx.printed.at(-1)! }));
  return { ...base, 'content-type': 'application/json', 'x-orchestra-csrf': String(u.json.csrf) };
}

const rows = (fx: Fx) => fx.store.db.all("SELECT kind, body FROM event WHERE kind IN ('human', 'human.result', 'dispatch-grant', 'route', 'agent-request', 'auto') ORDER BY jseq").map((r) => ({ kind: String(r.kind), body: JSON.parse(String(r.body)) }));
const grant = (fx: Fx, h: Record<string, string>, id: string, level: string, actionId = uuid()) => request(fx, 'POST', `/api/owned/${id}/dispatch-grant`, h, JSON.stringify({ actionId, level }));
const say = (_n: DispatchNote) => {};

test('the permission only on a paired, unlocked page: no cookie, no token, a wrong Origin or a cross-site request change nothing', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const body = () => JSON.stringify({ actionId: uuid(), level: 'free' });
  const url = `/api/owned/${W}/dispatch-grant`;
  const { cookie: _c, ...noCookie } = h;
  assert.equal((await request(fx, 'POST', url, noCookie, body())).status, 403);
  const { 'x-orchestra-csrf': _k, ...noToken } = h;
  const r = await request(fx, 'POST', url, noToken, body());
  assert.deepEqual([r.status, r.json?.error], [403, 'not-unlocked']);
  assert.equal((await request(fx, 'POST', url, { ...h, origin: 'http://orchestra.localhost:1' }, body())).status, 403);
  assert.equal((await request(fx, 'POST', url, { ...h, 'sec-fetch-site': 'cross-site' }, body())).status, 403);
  assert.equal((await request(fx, 'POST', url, { ...h, 'x-orchestra-csrf': 'A'.repeat(43) }, body())).status, 403);
  assert.equal(fx.dispatch.view(W).level, 'ask');
  assert.deepEqual(rows(fx), []);
});

test('a person sets it: a human record, its result and a dispatch-grant record in one batch, and it holds; the same action is answered once', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const actionId = uuid();
  const r = await grant(fx, h, W, 'free', actionId);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([r.json.level, r.json.accepted], ['free', true]);
  assert.equal(fx.dispatch.view(W).level, 'free');
  assert.deepEqual(rows(fx).map((x) => x.kind), ['human', 'human.result', 'dispatch-grant']);
  assert.deepEqual(rows(fx)[0]!.body.verb, 'dispatch-grant');
  assert.deepEqual(rows(fx)[2]!.body, { actionId, ownedId: W, level: 'free' });
  const again = await grant(fx, h, W, 'free', actionId);
  assert.equal(again.json.replayed, true);
  assert.equal(rows(fx).length, 3);
  assert.equal((await grant(fx, h, W, 'ask')).status, 200);
  assert.equal(fx.dispatch.view(W).level, 'ask', 'and back');
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.equal(validateOwnedList(list.json).ok, true, validateOwnedList(list.json).errors.join(' | '));
  assert.deepEqual(list.json.owned.find((o: { ownedId: string }) => o.ownedId === W).dispatch.level, 'ask');
  assert.equal(list.json.presence, 'present', 'the list is a heartbeat and the grant an action (r4 Q-P3)');
});

test('你不在也派 is no level: r4 D20 does not allow it, the route refuses it and writes nothing; so with an unknown session or one over', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  for (const level of ['away', 'never', '']) assert.equal((await grant(fx, h, W, level)).status, 400, level);
  assert.equal(fx.dispatch.view(W).level, 'ask');
  const none = await grant(fx, h, 'd'.repeat(20), 'free');
  assert.deepEqual([none.status, none.json?.error], [404, 'item-unknown']);
  fx.over.add(W);
  const ended = await grant(fx, h, W, 'free');
  assert.deepEqual([ended.status, ended.json?.error], [409, 'owned-ended']);
  assert.deepEqual(rows(fx), []);
});

test('the page sees the level: a session over has none, and a page never heard is presence unknown', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  fx.over.add(T);
  const list = (await request(fx, 'GET', '/api/owned', h)).json;
  assert.equal(validateOwnedList(list).ok, true, validateOwnedList(list).errors.join(' | '));
  assert.deepEqual(list.owned.find((o: { ownedId: string }) => o.ownedId === W).dispatch, { level: 'ask', grantAt: null, depth: 0, tainted: false });
  assert.equal(list.owned.find((o: { ownedId: string }) => o.ownedId === T).dispatch, null);
  assert.equal(list.presence, 'away', 'heard, and no action yet');
});

test('a clean worker\'s request, dispatched by a person: not tainted, its cards name that worker, the record says owned; and its session starts at 派前问你', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const c = fx.dispatch.call(W, { task: 'reply pong', harness: 'codex', model: 'zcode/GLM-5.3' }, say);
  const r = fx.requests.list()[0]!;
  const go = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: r.text, harness: 'codex', requestId: r.requestId }));
  assert.equal(go.status, 200, go.body);
  assert.deepEqual(fx.made[0]!.origin, { kind: 'worker-dispatch', requestId: r.requestId, requester: W, label: 'session aaaa' });
  assert.equal(fx.made[0]!.tainted, undefined, 'r4 §8.5: a clean musician of the same project is clean, trust agent');
  assert.equal(fx.made[0]!.model, 'zcode/GLM-5.3', 'the model the worker named, when the page sent none');
  const kinds = rows(fx);
  assert.deepEqual(kinds.map((x) => x.kind), ['human', 'human.result', 'route', 'agent-request']);
  assert.deepEqual([kinds[2]!.body.mode, kinds[3]!.body.requesterKind, kinds[3]!.body.verdict], ['manual', 'owned', 'dispatched']);
  assert.equal((await c.reply).ok, true);
  const child = String(go.json.ownedId);
  assert.deepEqual(fx.dispatch.sentOf(child), { by: W, via: 'person', grantAt: null });
  assert.equal(fx.dispatch.view(child).level, 'ask');
});

test('a worker with a title too long for a label, dispatched by a person: its cards name it by the cut label', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  fx.titles.set(W, '修'.repeat(80));
  const c = fx.dispatch.call(W, { task: 'reply pong', harness: 'codex', model: 'zcode/GLM-5.3' }, say);
  const r = fx.requests.list()[0]!;
  const go = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: r.text, harness: 'codex', requestId: r.requestId }));
  assert.equal(go.status, 200, go.body);
  const label = String((fx.made[0]!.origin as { label: string }).label);
  assert.ok(label.endsWith('…') && Buffer.byteLength(label) <= 120, label);
  await c.reply;
});

test('a tainted session\'s request, dispatched by a person: tainted again, whatever level it holds', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  await grant(fx, h, T, 'free');
  await request(fx, 'GET', '/api/owned', h);
  fx.dispatch.call(T, { task: 'reply pong', harness: 'codex' }, say);
  const r = fx.requests.list()[0]!;
  assert.deepEqual([r.state, r.tainted, r.askWhy], ['pending', true, 'tainted']);
  const go = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: r.text, harness: 'codex', requestId: r.requestId }));
  assert.equal(go.status, 200, go.body);
  assert.equal(fx.made[0]!.tainted, true);
  assert.ok(!rows(fx).some((x) => x.kind === 'auto'));
});

test('a seat request stays tainted and waits with every level open, and its dispatch is the person\'s as before', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  await grant(fx, h, W, 'free');
  await request(fx, 'GET', '/api/owned', h);
  const made = fx.requests.create({ harness: 'codex', text: 'seat job', cwd: 'D:\\x', label: null, requester: { kind: 'dsh', sessionId: W } });
  assert.ok(made.ok);
  assert.deepEqual([fx.requests.list()[0]!.state, fx.made.length], ['pending', 0]);
  const go = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: 'seat job', harness: 'codex', requestId: made.request.requestId }));
  assert.equal(go.status, 200, go.body);
  assert.equal(fx.made[0]!.tainted, true);
  assert.equal((fx.made[0]!.origin as { kind: string }).kind, 'agent-request');
  assert.equal(rows(fx).at(-1)!.body.requesterKind, 'dsh');
  assert.equal(fx.dispatch.sentOf(String(go.json.ownedId)), null, 'no worker sent it');
});
