import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import type { LoopbackPost } from '../../src/net/magpie.ts';
import { lastDispatchIn, makeDesk } from '../../src/route/desk.ts';
import { Log } from '../../src/runtime/log.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import { ownedEnabled, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import { routeOf, shapeError } from '../../src/server/routes.ts';
import { towerFromStage } from '../../src/sources/tower.ts';
import type { Store } from '../../src/store/store.ts';
import { checkBody } from '../../src/store/records.ts';
import { validateTower } from '../../shared/tower-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';
import { busyStage } from '../helpers/tower-fixture.ts';

// The dispatch desk over HTTP (orchestra app plan §3): POST /api/route/suggest runs the owned check chain
// and answers the "Route to?" card without starting anything or writing anything; POST /api/owned/new
// with that card's routeId starts the session and writes its RouteDecision in the batch of its human
// records. The session manager is a stand-in that only counts what it was asked to start; the router
// model is a stand-in POST. Nothing here reaches a network or a child process; every text is synthetic.

const CODE = '12345678';
const uuid = () => crypto.randomUUID();

type Made = { text?: string; uuid?: string; model?: string; title?: string };
type Fx = { server: PeekServer; host: string; origin: string; store: Store; made: Made[]; asked: unknown[]; desk: ReturnType<typeof makeDesk> };

async function fixture(t: TestContext, answer: string | null): Promise<Fx> {
  const sf = await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const printed: string[] = [];
  const made: Made[] = [];
  const asked: unknown[] = [];
  let n = 0;
  // Enough of CodexOwned for POST /api/owned/new: create() answers a session with its model.
  const codex = {
    create(req: Made) {
      made.push(req);
      const ownedId = (n++).toString(16).padStart(20, 'a');
      return { ok: true as const, ownedId, session: { model: req.model ?? 'codex/gpt-6.1-sol' } };
    },
    get: () => null, list: () => [], meta: () => null, maxActive: 4, approvals: null,
  };
  const post: LoopbackPost = async (body) => {
    asked.push(body);
    return answer === null ? { ok: false, why: 'timeout' } : { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: answer } }] }) };
  };
  const desk = makeDesk({ post, routerModel: 'zcode/GLM-5.3', on: () => ({ codex: true, claude: false }), redact: (s) => s, nowMono: () => sf.clock.mono, nowWall: () => sf.clock.wall });
  const deps = { codex: codex as never, codexOff: 'on', claude: null, desk, log };
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: CODE, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: (c) => printed.push(c), enabled: ownedEnabled(deps), handlers: registerOwnedHandlers(deps) },
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  const fx = { server, host, origin: `http://${host}`, store, made, asked, desk };
  (fx as { printed?: string[] }).printed = printed;
  return fx;
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
  const code = (fx as { printed?: string[] }).printed!.at(-1)!;
  const u = await request(fx, 'POST', '/api/owned/unlock', { ...base, 'content-type': 'application/json' }, JSON.stringify({ code }));
  return { ...base, 'content-type': 'application/json', 'x-orchestra-csrf': String(u.json.csrf) };
}

const rows = (fx: Fx) => fx.store.db.all("SELECT jseq, kind, body FROM event WHERE kind IN ('human', 'human.result', 'route') ORDER BY jseq").map((r) => ({ jseq: Number(r.jseq), kind: String(r.kind), body: JSON.parse(String(r.body)) }));
const ANSWER = JSON.stringify({ harness: 'codex', model: 'codex/gpt-6.1-terra', title: '修登录测试', reason: '要跑测试改代码' });

test('POST /api/route/suggest: the unlocked chain, then the card; it starts nothing and writes nothing', async (t) => {
  const fx = await fixture(t, ANSWER);
  const h = await unlocked(fx);
  const { 'x-orchestra-csrf': _c, ...noToken } = h;
  assert.deepEqual([(await request(fx, 'POST', '/api/route/suggest', noToken, JSON.stringify({ text: 'x' }))).json?.error], ['not-unlocked']);
  const r = await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text: '用 codex 修一下登录的测试' }));
  assert.equal(r.status, 200, r.body);
  assert.equal(shapeError(routeOf('POST', '/api/route/suggest')!.reply!, r.json), null);
  assert.equal(r.json.router.state, 'answered');
  assert.equal(r.json.title, '修登录测试');
  assert.deepEqual(r.json.candidates.map((c: any) => `${c.harness} ${c.model} ${c.source}`), ['codex codex/gpt-6.1-sol rule', 'codex codex/gpt-6.1-terra model']);
  assert.deepEqual(r.json.off, ['claude']);
  assert.deepEqual(fx.made, [], 'a suggestion starts no session');
  assert.deepEqual(rows(fx), [], 'and writes no record');
  assert.deepEqual((fx.asked[0] as any).messages[1], { role: 'user', content: '用 codex 修一下登录的测试' });
  // No actionId on this route; the message checks of the chain hold.
  assert.equal((await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ actionId: uuid(), text: 'x' }))).status, 400);
  assert.deepEqual((await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text: '/model x' }))).json, { error: 'slash-command' });
  assert.deepEqual((await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text: '长'.repeat(700) }))).json, { error: 'text-too-long' });
  assert.equal((await request(fx, 'POST', '/api/route/suggest', { ...h, origin: 'http://orchestra.localhost:1' }, JSON.stringify({ text: 'x' }))).status, 403);
  assert.deepEqual(rows(fx), []);
});

test('the router model has no answer: the card says so (no-answer) and carries the rules alone', async (t) => {
  const fx = await fixture(t, null);
  const h = await unlocked(fx);
  const r = await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text: '解释一下这段代码' }));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json.router, { model: 'zcode/GLM-5.3', state: 'no-answer', why: 'timeout', pick: null });
  assert.ok(r.json.candidates.every((c: any) => c.source === 'rule'));
  // Claude is off here: the cheap model's rule offered nothing, the Codex default is all there is.
  assert.deepEqual(r.json.candidates.map((c: any) => `${c.harness} ${c.model}`), ['codex codex/gpt-6.1-sol']);
});

test('dispatch with the card\'s routeId: the session takes its title, and the RouteDecision joins the batch of the human records; a replay writes nothing more', async (t) => {
  const fx = await fixture(t, ANSWER);
  const h = await unlocked(fx);
  const text = '用 codex 修一下登录的测试';
  const card = (await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text }))).json;
  const actionId = uuid();
  const body = JSON.stringify({ actionId, text, harness: 'codex', model: 'codex/gpt-6.1-terra', routeId: card.routeId });
  const r = await request(fx, 'POST', '/api/owned/new', h, body);
  assert.equal(r.status, 200, r.body);
  assert.equal(fx.made.length, 1);
  assert.deepEqual(fx.made[0], { text, uuid: actionId, model: 'codex/gpt-6.1-terra', title: '修登录测试' });
  const got = rows(fx);
  assert.deepEqual(got.map((x) => x.kind), ['human', 'human.result', 'route']);
  assert.deepEqual(got.map((x) => x.jseq), [got[0]!.jseq, got[0]!.jseq + 1, got[0]!.jseq + 2], 'one batch');
  const rec = got[2]!.body;
  assert.equal(checkBody('route', rec, null), null);
  assert.deepEqual({ ...rec, decisionId: '-' }, {
    decisionId: '-', actionId, routeId: card.routeId, ownedId: r.json.ownedId, taskClass: 'named', rules: ['named-harness', 'code-or-command', 'fallback'],
    candidates: [{ harness: 'codex', model: 'codex/gpt-6.1-sol', source: 'rule', rule: 'named-harness' }, { harness: 'codex', model: 'codex/gpt-6.1-terra', source: 'model', rule: null }],
    chosen: { harness: 'codex', model: 'codex/gpt-6.1-terra' }, pick: 1, reason: 'router-model', router: 'answered', mode: 'manual',
  });
  assert.equal(fx.desk.last()?.ownedId, r.json.ownedId);
  assert.deepEqual(lastDispatchIn(fx.store.db), { ownedId: r.json.ownedId, harness: 'codex', model: 'codex/gpt-6.1-terra', at: lastDispatchIn(fx.store.db)!.at }, 'a restart finds it in the journal');
  // The same actionId again: replayed, nothing started, nothing written.
  const again = await request(fx, 'POST', '/api/owned/new', h, body);
  assert.equal(again.json.replayed, true);
  assert.equal(fx.made.length, 1);
  assert.equal(rows(fx).length, 3);
  // The card is used up: its routeId on another dispatch records nothing.
  await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text, harness: 'codex', routeId: card.routeId }));
  assert.deepEqual(rows(fx).map((x) => x.kind), ['human', 'human.result', 'route', 'human', 'human.result']);
});

test('a routeId for another sentence (edited after the card) or unknown: the session starts as asked, with no decision and its own title', async (t) => {
  const fx = await fixture(t, ANSWER);
  const h = await unlocked(fx);
  const card = (await request(fx, 'POST', '/api/route/suggest', h, JSON.stringify({ text: '修一下登录的测试' }))).json;
  const r = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: '修一下注册的测试', harness: 'codex', routeId: card.routeId }));
  assert.equal(r.status, 200, r.body);
  assert.equal(fx.made[0]!.title, undefined);
  assert.deepEqual(rows(fx).map((x) => x.kind), ['human', 'human.result']);
  assert.equal(fx.desk.last(), null);
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: 'x', harness: 'codex', routeId: 'not-hex' }))).status, 400);
});

test('the router row ("你"): the last dispatch\'s title and time, linked to its node only when the snapshot shows it', () => {
  const stage = busyStage();
  const d = { ownedId: 'abcdefabcdefabcdefab', harness: 'codex' as const, model: 'codex/gpt-6.1-sol', at: 1_761_868_800_000, title: '修登录测试' };
  const none = towerFromStage(stage, { seats: [], nowWall: 1_761_868_900_000, dispatch: d });
  assert.deepEqual(none.router, { kind: 'human', dispatch: { title: '修登录测试', at: 1_761_868_800_000, harness: 'codex', model: 'codex/gpt-6.1-sol', node: null } });
  assert.equal(validateTower(none).ok, true, validateTower(none).errors.join(' | '));
  const seat = { ownedId: d.ownedId, harness: 'codex' as const, title: '修登录测试', state: 'running' as const, endReason: null, waiting: null, lastAt: null };
  const linked = towerFromStage(stage, { seats: [seat], nowWall: 1_761_868_900_000, dispatch: d });
  assert.equal(linked.router.dispatch?.node, `n:${d.ownedId}`);
  assert.equal(validateTower(linked).ok, true, validateTower(linked).errors.join(' | '));
  assert.equal(towerFromStage(stage).router.dispatch, null, 'before any dispatch: null');
});
