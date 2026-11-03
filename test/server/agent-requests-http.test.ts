import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import type { LoopbackPost } from '../../src/net/magpie.ts';
import { makeDesk } from '../../src/route/desk.ts';
import { makeRequests, requestedOwnedIn } from '../../src/route/requests.ts';
import type { Requests } from '../../src/route/requests.ts';
import { Log } from '../../src/runtime/log.ts';
import { oneShot } from '../../src/runtime/clock.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import { ownedEnabled, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import type { Store } from '../../src/store/store.ts';
import { checkBody } from '../../src/store/records.ts';
import { canonicalDigest } from '../../src/store/canonical-json.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// seat on the paired page (final.md §5.1; r4 A17, D8): an agent request is a card in GET /api/owned; the
// person dispatches it (POST /api/owned/new with its requestId: the card's text and harness, its RouteDecision
// and an `agent-request` record in the batch of the human records) or rejects it (POST
// /api/agent-requests/:id/reject). The session manager is a stand-in that counts what it was asked to start,
// the router model a stand-in POST. Nothing here reaches a network, a pipe or a child process.

const CODE = '12345678';
const uuid = () => crypto.randomUUID();
type Made = { text?: string; uuid?: string; model?: string; title?: string };
type Fx = { server: PeekServer; host: string; origin: string; store: Store; made: Made[]; requests: Requests; printed: string[] };
const ANSWER = JSON.stringify({ harness: 'codex', model: 'codex/gpt-6.1-terra', title: '登录页样式', reason: '改样式要改代码' });

async function fixture(t: TestContext, withRequests = true): Promise<Fx> {
  const sf = await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const printed: string[] = [];
  const made: Made[] = [];
  let n = 0;
  const codex = {
    create(req: Made) {
      made.push(req);
      const ownedId = (n++).toString(16).padStart(20, 'a');
      return { ok: true as const, ownedId, session: { model: req.model ?? 'codex/gpt-6.1-sol' } };
    },
    get: () => null, list: () => [], meta: () => null, maxActive: 4, approvals: null,
  };
  const post: LoopbackPost = async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: ANSWER } }] }) });
  const desk = makeDesk({ post, routerModel: 'zcode/GLM-5.3', on: () => ({ codex: true, claude: true }), redact: (s) => s, nowMono: () => sf.clock.mono, nowWall: () => sf.clock.wall });
  const requests = makeRequests({
    after: oneShot(sf.clock, 'agent-requests-http'), nowMono: () => clock.nowMono(), nowWall: () => clock.nowWall(), redact: (text) => ({ text, count: 0 }),
    // The stand-in sessions never start a turn: a dispatched request stays dispatched here.
    observe: () => ({ state: 'starting', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }), endOwned: () => false,
    suggest: (text, harness) => desk.suggest(text, harness),
  });
  const deps = { codex: codex as never, codexOff: 'on', claude: null, desk, log, requests: withRequests ? requests : null };
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: CODE, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: (c) => printed.push(c), enabled: ownedEnabled(deps), handlers: registerOwnedHandlers(deps) },
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, store, made, requests, printed };
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; json: any };
function request(fx: Fx, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.server.port, method, path: pathname, headers: { host: fx.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, headers: res.headers, body: text, json: (res.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function unlocked(fx: Fx): Promise<Record<string, string>> {
  const p = await request(fx, 'POST', '/pair', { origin: fx.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${CODE}`);
  const cookie = String(p.headers['set-cookie']).split(';')[0]!;
  const base = { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' };
  assert.equal((await request(fx, 'POST', '/api/owned/unlock-code', base)).status, 204);
  const u = await request(fx, 'POST', '/api/owned/unlock', { ...base, 'content-type': 'application/json' }, JSON.stringify({ code: fx.printed.at(-1)! }));
  return { ...base, 'content-type': 'application/json', 'x-orchestra-csrf': String(u.json.csrf) };
}

const rows = (fx: Fx) => fx.store.db.all("SELECT jseq, kind, body FROM event WHERE kind IN ('human', 'human.result', 'route', 'agent-request') ORDER BY jseq")
  .map((r) => ({ jseq: Number(r.jseq), kind: String(r.kind), body: JSON.parse(String(r.body)) }));
const ASK = { harness: 'codex' as const, text: '修一下登录页的样式', cwd: 'D:\\work\\shop', label: null, requester: { kind: 'dsh' as const, sessionId: 'sess-1' } };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('a pending request is a card in GET /api/owned, with the desk\'s suggestion for its harness; the list passes the owned contract', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const made = fx.requests.create(ASK);
  assert.ok(made.ok);
  await settle();
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.equal(list.status, 200, list.body);
  assert.equal(validateOwnedList(list.json).ok, true, validateOwnedList(list.json).errors.join(' | '));
  assert.equal(list.json.requests.length, 1);
  const r = list.json.requests[0];
  assert.deepEqual({ ...r, createdAt: 0, expiresAt: 0, suggestion: null }, {
    requestId: made.request.requestId, harness: 'codex', label: null, text: ASK.text, cwd: ASK.cwd, runIn: null, runInWhy: 'no-roots', requester: 'dsh:sess-1', state: 'pending',
    createdAt: 0, expiresAt: 0, ownedId: null, why: null, fetched: false, suggestion: null, suggesting: 'ready',
  });
  // No --project-root: no root listed, and the request runs in the work dir (the card says why).
  assert.deepEqual(list.json.roots, []);
  assert.deepEqual(list.json.requestedGone, []);
  // The contract holds the new fields to what they mean.
  const bad = (f: (l: any) => void, why: string) => {
    const l = structuredClone(list.json);
    f(l);
    const v = validateOwnedList(l);
    assert.ok(!v.ok && v.errors.some((e) => e.includes(why)), `${why}: ${v.errors.join(' | ')}`);
  };
  bad((l) => { l.requests[0].fetched = true; }, 'never handed back');
  bad((l) => { l.requests[0].runInWhy = null; }, 'set exactly when runIn is null');
  bad((l) => { l.requests[0].runIn = 'D:\\work\\shop'; }, 'set exactly when runIn is null');
  bad((l) => { l.requests[0].runInWhy = 'maybe'; }, 'runInWhy');
  bad((l) => { l.roots = ['relative\\dir']; }, 'not an absolute path');
  bad((l) => { l.roots = ['D:\\a', 'd:\\A']; }, 'listed twice');
  bad((l) => { l.requests[0].suggesting = 'asking'; }, 'but a suggestion is there');
  bad((l) => { l.requests[0].suggesting = 'maybe'; }, 'suggesting');
  bad((l) => { l.requestedGone = ['x']; }, 'requestedGone[0]');
  bad((l) => { l.requests[0].requester = 'dsh:'; }, 'requester');
  const anon = structuredClone(list.json);
  anon.requests[0].requester = 'dsh';
  assert.equal(validateOwnedList(anon).ok, true, 'a requester that named none is dsh');
  assert.equal(r.suggestion.router, 'answered');
  assert.ok(r.suggestion.models.every((m: any) => /^(?:codex|zcode|opencode-go)\//.test(m.model)));
  assert.equal(r.suggestion.models[r.suggestion.pick].model, 'codex/gpt-6.1-terra', 'the router model\'s pick, for this harness');
  assert.deepEqual(fx.made, [], 'a card starts nothing');
  assert.deepEqual(rows(fx), [], 'and writes nothing');
});

test('派出: owned-new with the requestId takes the card\'s words, binds the session, and writes the RouteDecision and an agent-request record naming it in one batch', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const made = fx.requests.create(ASK);
  assert.ok(made.ok);
  await settle();
  const id = made.request.requestId;
  const card = fx.requests.get(id)!;
  // Another text, or another harness, than the card's: nothing starts (request-mismatch).
  const mismatch = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: `${ASK.text}，顺便删库`, harness: 'codex', requestId: id }));
  assert.deepEqual([mismatch.status, mismatch.json], [409, { error: 'request-mismatch' }]);
  // Claude is off in this fixture: a dispatch to it is owned-disabled before the request is looked at (the harness mismatch is requests.test's).
  assert.deepEqual((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'claude', requestId: id }))).json, { error: 'owned-disabled' });
  assert.equal(fx.requests.get(id)!.state, 'pending', 'a refused dispatch leaves the card waiting');
  assert.deepEqual(fx.made, []);
  const actionId = uuid();
  const r = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId, text: ASK.text, harness: 'codex', model: 'codex/gpt-6.1-terra', requestId: id, routeId: card.suggestion!.routeId }));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(fx.made, [{ text: ASK.text, uuid: actionId, model: 'codex/gpt-6.1-terra', title: '登录页样式' }]);
  assert.deepEqual([fx.requests.get(id)!.state, fx.requests.get(id)!.ownedId], ['dispatched', r.json.ownedId]);
  const got = rows(fx);
  assert.deepEqual(got.map((x) => x.kind), ['human', 'human.result', 'route', 'agent-request']);
  assert.deepEqual(got.map((x) => x.jseq), [0, 1, 2, 3].map((k) => got[0]!.jseq + k), 'one batch');
  const [route, rec] = [got[2]!.body, got[3]!.body];
  assert.equal(checkBody('agent-request', rec, null), null);
  assert.deepEqual(rec, {
    requestId: id, actionId, verdict: 'dispatched', harness: 'codex', requesterKind: 'dsh', requesterDigest: canonicalDigest('dsh:sess-1'),
    ownedId: r.json.ownedId, decisionId: route.decisionId,
  }, 'the RouteDecision\'s source is the agent request');
  assert.ok(!JSON.stringify(rec).includes('sess-1'), 'the requester\'s id stays out of the journal; only its digest');
  assert.equal(route.pick !== null && route.reason === 'router-model', true);
  // A second dispatch of the same request: request-gone, nothing more starts or is written.
  const again = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'codex', requestId: id }));
  assert.deepEqual([again.status, again.json], [409, { error: 'request-gone' }]);
  assert.equal(fx.made.length, 1);
  assert.equal(rows(fx).length, 4);
  // After a restart the journal still says this session was dispatched for an agent request.
  assert.deepEqual(requestedOwnedIn(fx.store.db), [r.json.ownedId]);
  // The list says which session the request is running as.
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.equal(validateOwnedList(list.json).ok, true, validateOwnedList(list.json).errors.join(' | '));
  assert.deepEqual([list.json.requests[0].state, list.json.requests[0].ownedId], ['dispatched', r.json.ownedId]);
});

test('拒绝: request-reject writes its human records and an agent-request record (rejected); a request that no longer waits is request-gone', async (t) => {
  const fx = await fixture(t);
  const h = await unlocked(fx);
  const made = fx.requests.create(ASK);
  assert.ok(made.ok);
  const id = made.request.requestId;
  const { 'x-orchestra-csrf': _c, ...noToken } = h;
  assert.deepEqual((await request(fx, 'POST', `/api/agent-requests/${id}/reject`, noToken, JSON.stringify({ actionId: uuid() }))).json, { error: 'not-unlocked' }, 'only the unlocked page');
  const actionId = uuid();
  const r = await request(fx, 'POST', `/api/agent-requests/${id}/reject`, h, JSON.stringify({ actionId }));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([fx.requests.get(id)!.state, fx.requests.get(id)!.why], ['rejected', 'you-rejected']);
  const got = rows(fx);
  assert.deepEqual(got.map((x) => x.kind), ['human', 'human.result', 'agent-request']);
  assert.deepEqual([got[0]!.body.verb, got[0]!.body.targetId], ['request-reject', id]);
  assert.deepEqual({ ...got[2]!.body, requesterDigest: '-' }, { requestId: id, actionId, verdict: 'rejected', harness: 'codex', requesterKind: 'dsh', requesterDigest: '-', ownedId: null, decisionId: null });
  assert.deepEqual((await request(fx, 'POST', `/api/agent-requests/${id}/reject`, h, JSON.stringify({ actionId: uuid() }))).json, { error: 'request-gone' });
  assert.deepEqual((await request(fx, 'POST', '/api/agent-requests/ffffffffffffffffffff/reject', h, JSON.stringify({ actionId: uuid() }))).json, { error: 'request-gone' });
  assert.deepEqual((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'codex', requestId: id }))).json, { error: 'request-gone' }, 'a rejected request is not dispatched');
  assert.equal(rows(fx).length, 3);
});

test('without the agent port (no request store), a requestId is request-gone and the reject route refuses: no session starts', async (t) => {
  const fx = await fixture(t, false);
  const h = await unlocked(fx);
  assert.deepEqual((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: 'x', harness: 'codex', requestId: '0123456789abcdef0123' }))).json, { error: 'request-gone' });
  assert.deepEqual((await request(fx, 'POST', '/api/agent-requests/0123456789abcdef0123/reject', h, JSON.stringify({ actionId: uuid() }))).json, { error: 'request-gone' });
  assert.deepEqual(fx.made, []);
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.deepEqual(list.json.requests, []);
});
