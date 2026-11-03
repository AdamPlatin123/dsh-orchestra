import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { makeRequests } from '../../src/route/requests.ts';
import type { Requests } from '../../src/route/requests.ts';
import { Log } from '../../src/runtime/log.ts';
import { oneShot } from '../../src/runtime/clock.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import { canonicalDigest } from '../../src/store/canonical-json.ts';
import { cwdEntry, ownedEnabled, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// Project roots on the paired page (orchestra app plan 项目根, --project-root): GET /api/owned lists the roots
// named at startup; owned-new may name one of them as root (exactly one of that list: cwd-forbidden
// otherwise, no free path) and the session is created there; an agent request runs where its card said
// (runIn, inside a root) and takes no root from the page. Without roots nothing changes: no cwd is handed
// to the manager. The manager is a stand-in that records what it was asked to start.

const CODE = '12345678';
const uuid = () => crypto.randomUUID();
const ROOT = 'D:\\work\\proj';
type Made = { text?: string; uuid?: string; model?: string; title?: string; cwd?: string; tainted?: boolean; harness?: string };
type Fx = { server: PeekServer; host: string; origin: string; made: Made[]; requests: Requests; printed: string[]; journal: string };

async function fixture(t: TestContext, projectRoots: string[] | undefined): Promise<Fx> {
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
      return { ok: true as const, ownedId: (n++).toString(16).padStart(20, 'b'), session: { model: req.model ?? 'codex/gpt-6.1-sol' } };
    },
    get: () => null, list: () => [], meta: () => null, maxActive: 3, approvals: null,
  };
  const claude = {
    create(req: Made) {
      made.push({ ...req, harness: 'claude' });
      return { ok: true as const, ownedId: (n++).toString(16).padStart(20, 'c'), session: { model: req.model ?? 'zcode/glm-5.1' } };
    },
    get: () => null, list: () => [], meta: () => null, maxActive: 3, approvals: null,
  };
  const requests = makeRequests({
    after: oneShot(sf.clock, 'project-roots-http'), nowMono: () => clock.nowMono(), nowWall: () => clock.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => ({ state: 'starting', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }), endOwned: () => false,
  });
  const deps = { codex: codex as never, codexOff: 'on', claude: claude as never, log, requests, ...(projectRoots === undefined ? {} : { projectRoots }) };
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: CODE, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: (c) => printed.push(c), enabled: ownedEnabled(deps), handlers: registerOwnedHandlers(deps) },
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, made, requests, printed, journal: sf.journal };
}

type Reply = { status: number; body: string; json: any };
function request(fx: Fx, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply & { headers: http.IncomingHttpHeaders }> {
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

const ASK = { harness: 'codex' as const, text: '把登录页改好看点', cwd: `${ROOT}\\web`, label: null, requester: { kind: 'dsh' as const, sessionId: 'sess-9' } };
const newBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ actionId: uuid(), text: '写个 README', harness: 'codex', ...extra });

test('with a project root: the list names it, and owned-new with that root (any case) starts the session there', async (t) => {
  const fx = await fixture(t, [ROOT]);
  const h = await unlocked(fx);
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.equal(list.status, 200, list.body);
  assert.deepEqual(list.json.roots, [ROOT]);
  assert.equal(validateOwnedList(list.json).ok, true, validateOwnedList(list.json).errors.join(' | '));
  const r = await request(fx, 'POST', '/api/owned/new', h, newBody({ root: ROOT.toLowerCase() }));
  assert.equal(r.status, 200, r.body);
  assert.equal(fx.made[0]!.cwd, ROOT, 'the root as the list names it');
  // Without root: the manager makes its own work dir (no cwd handed over).
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, newBody())).status, 200);
  assert.equal(Object.hasOwn(fx.made[1]!, 'cwd'), false);
});

test('owned-new takes no free path: a root not on the list, a folder inside one, or a root with a requestId is cwd-forbidden and starts nothing', async (t) => {
  const fx = await fixture(t, [ROOT]);
  const h = await unlocked(fx);
  for (const root of ['D:\\work\\other', `${ROOT}\\web`, 'C:\\', 'D:\\work']) {
    const r = await request(fx, 'POST', '/api/owned/new', h, newBody({ root }));
    assert.deepEqual([r.status, r.json], [409, { error: 'cwd-forbidden' }], root);
  }
  const made = fx.requests.create({ ...ASK, runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(made.ok);
  const r = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'codex', requestId: made.request.requestId, root: ROOT }));
  assert.deepEqual([r.status, r.json], [409, { error: 'cwd-forbidden' }], 'a request runs where its card said');
  assert.equal(fx.requests.get(made.request.requestId)!.state, 'pending');
  assert.deepEqual(fx.made, []);
});

test('seat: a request whose cwd lies in a root runs there when dispatched; one outside runs in the work dir; the list says which', async (t) => {
  const fx = await fixture(t, [ROOT]);
  const h = await unlocked(fx);
  const inside = fx.requests.create({ ...ASK, runIn: `${ROOT}\\web`, runInWhy: null });
  const outside = fx.requests.create({ ...ASK, requester: { kind: 'dsh', sessionId: 'sess-8' }, cwd: 'D:\\elsewhere', runIn: null, runInWhy: 'outside-roots' });
  assert.ok(inside.ok && outside.ok);
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.equal(validateOwnedList(list.json).ok, true, validateOwnedList(list.json).errors.join(' | '));
  const byId = new Map(list.json.requests.map((r: any) => [r.requestId, r]));
  assert.deepEqual([(byId.get(inside.request.requestId) as any).runIn, (byId.get(inside.request.requestId) as any).runInWhy], [`${ROOT}\\web`, null]);
  assert.deepEqual([(byId.get(outside.request.requestId) as any).runIn, (byId.get(outside.request.requestId) as any).runInWhy], [null, 'outside-roots']);
  const a = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'codex', requestId: inside.request.requestId }));
  assert.equal(a.status, 200, a.body);
  assert.equal(fx.made[0]!.cwd, `${ROOT}\\web`);
  const b = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, harness: 'codex', requestId: outside.request.requestId }));
  assert.equal(b.status, 200, b.body);
  assert.equal(Object.hasOwn(fx.made[1]!, 'cwd'), false, 'outside every root: the work dir, as before');
});

test('without project roots: the list names none, any root is cwd-forbidden, and nothing hands the manager a cwd', async (t) => {
  const fx = await fixture(t, undefined);
  const h = await unlocked(fx);
  const list = await request(fx, 'GET', '/api/owned', h);
  assert.deepEqual(list.json.roots, []);
  assert.deepEqual((await request(fx, 'POST', '/api/owned/new', h, newBody({ root: ROOT }))).json, { error: 'cwd-forbidden' });
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, newBody())).status, 200);
  assert.deepEqual(fx.made.map((m) => Object.hasOwn(m, 'cwd')), [false]);
});

test('cwdEntry: a session in a root (or below it) is project-root, one elsewhere is work, one with no known cwd is null', () => {
  assert.deepEqual(cwdEntry(`${ROOT}\\web`, [ROOT]), { path: `${ROOT}\\web`, kind: 'project-root' });
  assert.deepEqual(cwdEntry(ROOT.toUpperCase(), [ROOT]), { path: ROOT.toUpperCase(), kind: 'project-root' });
  assert.deepEqual(cwdEntry('C:\\Users\\x\\.orchestra\\work\\0123456789abcdef0123', [ROOT]), { path: 'C:\\Users\\x\\.orchestra\\work\\0123456789abcdef0123', kind: 'work' });
  assert.deepEqual(cwdEntry('D:\\work\\projector', [ROOT]), { path: 'D:\\work\\projector', kind: 'work' }, 'a sibling with the root\'s name as its prefix is not inside it');
  assert.equal(cwdEntry('', [ROOT]), null);
});

// --- project-root review ------------------------------------------------------------------------------

/** The journal's records of one kind, bodies only. */
const recordsOf = (fx: Fx, kind: string): any[] => fs.readFileSync(fx.journal, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).filter((l) => l.kind === kind).map((l) => l.body);

test('seat: every session a request starts is tainted (r4 §8.5: an unbound sender), Claude or Codex, in a project root or the work dir; the dispatch dialog\'s own sessions are not', async (t) => {
  const fx = await fixture(t, [ROOT]);
  const h = await unlocked(fx);
  const ask = (sessionId: string, harness: 'codex' | 'claude', runIn: string | null) => {
    const made = fx.requests.create({ ...ASK, harness, requester: { kind: 'dsh', sessionId }, ...(runIn === null ? { cwd: 'D:\\elsewhere', runIn: null, runInWhy: 'outside-roots' as const } : { runIn, runInWhy: null }) });
    assert.ok(made.ok);
    return made.request.requestId;
  };
  const go = (body: Record<string, unknown>) => request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: ASK.text, ...body }));
  assert.equal((await go({ harness: 'claude', requestId: ask('s1', 'claude', `${ROOT}\\web`) })).status, 200);
  assert.equal((await go({ harness: 'claude', requestId: ask('s2', 'claude', null) })).status, 200);
  assert.equal((await go({ harness: 'codex', requestId: ask('s3', 'codex', `${ROOT}\\web`) })).status, 200);
  assert.equal((await go({ harness: 'codex', requestId: ask('s4', 'codex', null) })).status, 200);
  assert.equal((await go({ harness: 'claude', root: ROOT })).status, 200);
  assert.equal((await go({ harness: 'codex', root: ROOT })).status, 200);
  assert.equal((await go({ harness: 'codex' })).status, 200);
  assert.deepEqual(fx.made.map((m) => [m.harness ?? 'codex', m.cwd ?? null, m.tainted ?? false]), [
    ['claude', `${ROOT}\\web`, true], ['claude', null, true], ['codex', `${ROOT}\\web`, true], ['codex', null, true],
    ['claude', ROOT, false], ['codex', ROOT, false], ['codex', null, false],
  ]);
});

test('the journal binds a session in a project root to where it works: an owned-cwd record (sha256 of the cwd and its root, the requestId) in the dispatch\'s batch; none for the work dir', async (t) => {
  const fx = await fixture(t, [ROOT]);
  const h = await unlocked(fx);
  const made = fx.requests.create({ ...ASK, runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(made.ok);
  const a = uuid();
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: a, text: ASK.text, harness: 'codex', requestId: made.request.requestId }))).status, 200);
  const b = uuid();
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: b, text: '写个 README', harness: 'codex', root: ROOT }))).status, 200);
  assert.equal((await request(fx, 'POST', '/api/owned/new', h, newBody())).status, 200);
  const recs = recordsOf(fx, 'owned-cwd');
  assert.deepEqual(recs.map((r) => [r.actionId, r.requestId, r.cwdDigest, r.rootDigest]), [
    [a, made.request.requestId, canonicalDigest(`${ROOT}\\web`), canonicalDigest(ROOT)],
    [b, null, canonicalDigest(ROOT), canonicalDigest(ROOT)],
  ]);
  assert.deepEqual(recs.map((r) => r.ownedId), fx.made.slice(0, 2).map((_, i) => i.toString(16).padStart(20, 'b')));
  assert.equal(recordsOf(fx, 'agent-request').length, 1);
});
