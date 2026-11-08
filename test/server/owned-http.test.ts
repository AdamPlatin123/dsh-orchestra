import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { Log } from '../../src/runtime/log.ts';
import { PAIR_TTL_MS, PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import type { OwnedHandler, OwnedHandlers } from '../../src/server/owned.ts';
import { humanJournal, makeOwnedHandlers } from '../../src/server/owned.ts';
import { CSRF_RE, OWNED_BODY_MAX_BYTES, OWNED_TEXT_MAX_BYTES, ROUTES, shapeError } from '../../src/server/routes.ts';
import type { Route, Shape } from '../../src/server/routes.ts';
import type { Store } from '../../src/store/store.ts';
import { ERROR_STATUS } from '../../shared/protocol.js';
import { askPairCode, pairBrowser } from '../helpers/pair.ts';
import { realIo } from '../helpers/read-io.ts';
import { startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';
import type { StoreFixture } from '../helpers/store.ts';
import { withTmp } from '../helpers/tmp.ts';

// The owned-session base (slice design §2.7, §6 「端点安全」; §7 step 5): pairing (one console code, the
// cookie and the controller token in one reply; 2026-11-08) and the controller token, the check chain every owned route runs, the `human` records and the handler table.
// Here the tests register their own handlers where a route must get that far; the real handlers and
// their end to end runs against the fake app-server are in owned-flow.test.ts.

const CODE = '12345678';
const OID = 'own-1';
const STAGE = '0123456789abcdef0123';

type Fx = {
  server: PeekServer; host: string; origin: string; log: Log; store: Store; sf: StoreFixture; printed: string[]; handlers: OwnedHandlers;
};

async function fixture(t: TestContext, opts: { enabled?: boolean; print?: boolean; code?: string | null; sf?: StoreFixture; handlers?: OwnedHandlers } = {}): Promise<Fx> {
  const sf = opts.sf ?? await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const printed: string[] = [];
  const handlers = opts.handlers ?? makeOwnedHandlers();
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: opts.code === undefined ? CODE : opts.code, profile: 'test',
    printPairCode: opts.print === false ? null : (c) => printed.push(c),
    owned: { journal: humanJournal(store), enabled: opts.enabled ?? false, handlers },
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, log, store, sf, printed, handlers };
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(fx: Fx, method: string, pathname: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.server.port, method, path: pathname, headers: { host: fx.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** What the page sends: the cookie, its own origin, same-origin, JSON, and the token when it has one. */
const page = (fx: Fx, cookie: string, csrf?: string): Record<string, string> => ({
  cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(csrf === undefined ? {} : { 'x-orchestra-csrf': csrf }),
});

/** Paired with the start's code: the cookie and the token. */
const unlocked = (fx: Fx) => pairBrowser(fx.server, CODE);

const err = (r: Reply) => (r.headers['content-type']?.startsWith('application/json') ? (JSON.parse(r.body) as { error?: string }).error ?? null : null);
const humans = (fx: Fx) => fx.store.db.all("SELECT kind, body FROM event WHERE kind IN ('human', 'human.result') ORDER BY jseq").map((r) => ({ kind: String(r.kind), body: JSON.parse(String(r.body)) as Record<string, unknown> }));
const uuid = () => crypto.randomUUID();

/** A value of each grammar the owned routes' bodies need: a regex gives no sample of its own. */
const GRAMMAR: Record<string, () => string> = { uuid: () => uuid(), digest: () => 'a'.repeat(64), stageId: () => STAGE };
/** The smallest value of a body's shape (src/server/routes.ts): its required fields only, an enum's first, an int's least, an array's fewest, a text 'hello'. */
function minimal(s: Shape): unknown {
  switch (s.t) {
    case 'enum': return s.of[0];
    case 're': {
      const g = GRAMMAR[s.name];
      if (g === undefined) throw new Error(`no sample of the grammar ${s.name}: add one to GRAMMAR`);
      return g();
    }
    case 'int': return s.min;
    case 'bool': return false;
    case 'const': return s.value;
    case 'text': return 'hello';
    case 'null': return null;
    case 'obj': return Object.fromEntries(Object.entries(s.fields).filter(([k]) => !s.optional.includes(k)).map(([k, f]) => [k, minimal(f)]));
    case 'arr': return Array.from({ length: s.min }, () => minimal(s.of));
    default: throw new Error(`no sample of a ${s.t} shape`);
  }
}
/** A concrete path and a valid body for each owned route, made from the route's own body shape (a POST /api/route/suggest has no actionId: it writes no human record). */
function sample(r: Route): { path: string; body: Record<string, unknown> | null } {
  const path = r.path.replace(':id', r.target === 'stage' ? STAGE : OID);
  if (r.body === null) return { path, body: null };
  const body = minimal(r.body) as Record<string, unknown>;
  assert.equal(shapeError(r.body, body), null, `${r.path}: the sample fits its shape`);
  return { path, body };
}
/** The owned routes that reach a handler (forget, answered by the base itself, has its own tests). */
const UNLOCKED = ROUTES.filter((r) => r.auth === 'unlocked' && r.path !== '/api/pair/forget');

// --- pairing (2026-11-08: pair once) ------------------------------------------------------------------

const pairPost = (fx: Fx, path: string, h: Record<string, string>, body?: string) => request(fx, 'POST', path, h, body);
const site = (fx: Fx) => ({ origin: fx.origin, 'sec-fetch-site': 'same-origin' });

test('pair-code prints a fresh code only to the console and answers 204 with no body; pair trades it once for the cookie and a token of CSRF_RE\'s form', async (t) => {
  const fx = await fixture(t, { code: null });
  const asked = await pairPost(fx, '/api/pair-code', site(fx));
  assert.equal(asked.status, 204);
  assert.equal(asked.body, '');
  assert.equal(fx.printed.length, 1);
  const code = fx.printed[0]!;
  assert.match(code, /^[0-9]{8}$/);
  assert.equal(JSON.stringify(asked.headers).includes(code), false, 'never in a reply');
  const json = { ...site(fx), 'content-type': 'application/json' };
  const wrong = await pairPost(fx, '/api/pair', json, JSON.stringify({ code: code === '00000000' ? '00000001' : '00000000' }));
  assert.deepEqual([wrong.status, JSON.parse(wrong.body)], [403, { error: 'not-unlocked', why: 'wrong' }]);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const ok = await pairPost(fx, '/api/pair', json, JSON.stringify({ code }));
  assert.equal(ok.status, 200);
  const reply = JSON.parse(ok.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reply), ['csrf']);
  assert.match(String(reply.csrf), CSRF_RE);
  assert.equal(ok.body.includes(code), false);
  assert.match(String(ok.headers['set-cookie']), /^orchestra_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=7776000$/);
  const again = await pairPost(fx, '/api/pair', json, JSON.stringify({ code }));
  assert.deepEqual([again.status, JSON.parse(again.body)], [403, { error: 'not-unlocked', why: 'no-code' }], 'one time');
  // The token works with its own cookie at once.
  const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
  assert.equal((await request(fx, 'GET', '/api/owned', page(fx, cookie, String(reply.csrf)))).status, 501);
  // A second ask prints another code; no code, no token and no sid ever reach the log.
  await pairPost(fx, '/api/pair-code', site(fx));
  assert.equal(fx.printed.length, 2);
  const logged = JSON.stringify(fx.log.entries());
  for (const s of [...fx.printed, String(reply.csrf), cookie.slice('orchestra_sid='.length)]) assert.equal(logged.includes(s), false);
});

test('the pairing routes need no cookie, but the exact Origin and Sec-Fetch-Site same-origin; pair takes JSON only, pair-code no body', async (t) => {
  const fx = await fixture(t, { code: null });
  const base = site(fx);
  const ask = (h: Record<string, string>, body?: string) => pairPost(fx, '/api/pair-code', h, body);
  assert.equal((await ask({ ...base, origin: 'http://orchestra.localhost:1' })).status, 403, 'another port is another origin');
  assert.equal((await ask({ ...base, origin: 'null' })).status, 403);
  const { origin: _o, ...noOrigin } = base;
  assert.equal((await ask(noOrigin)).status, 403);
  const { 'sec-fetch-site': _s, ...noSite } = base;
  assert.equal((await ask(noSite)).status, 403);
  assert.equal((await ask({ ...base, 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await ask({ ...base, 'content-type': 'application/json' }, '{}')).status, 400, 'no body');
  assert.equal(fx.printed.length, 0, 'no code for a refused ask');
  assert.equal((await request(fx, 'GET', '/api/pair-code', base)).status, 405);
  assert.equal((await request(fx, 'GET', '/api/pair', base)).status, 405);
  assert.equal((await ask(base)).status, 204);
  const c = fx.printed[0]!;
  const pair = (h: Record<string, string>, body: string) => pairPost(fx, '/api/pair', h, body);
  const json = { ...base, 'content-type': 'application/json' };
  assert.equal((await pair({ ...json, origin: 'http://evil.example' }, JSON.stringify({ code: c }))).status, 403);
  assert.equal((await pair({ ...base, 'content-type': 'text/plain' }, JSON.stringify({ code: c }))).status, 400);
  assert.equal((await pair({ ...base, 'content-type': 'application/x-www-form-urlencoded' }, `code=${c}`)).status, 400, 'the old form is gone');
  assert.equal((await pair(json, JSON.stringify({ code: c, sid: 'x' }))).status, 400);
  assert.equal((await pair(json, '{')).status, 400);
  const big = await pair(json, JSON.stringify({ code: c, pad: 'x'.repeat(2000) }));
  assert.deepEqual([big.status, err(big)], [413, 'body-too-big']);
  assert.equal((await request(fx, 'POST', '/pair', base, `code=${c}`)).status, 405, 'no scriptless form route any more');
  const ok = await pair({ ...json, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ code: c }));
  assert.equal(ok.status, 200, 'refusals before the code is compared do not spend it');
});

test('over HTTP: a code expires after 10 minutes on the Clock, 5 wrong in a row void it, 20 wrong in all shut pairing until a restart (pair-code too); with no console pair-code is 503', async (t) => {
  const fx = await fixture(t, { code: null });
  const json = { ...site(fx), 'content-type': 'application/json' };
  const why = async (code: string) => (JSON.parse((await pairPost(fx, '/api/pair', json, JSON.stringify({ code }))).body) as { why: string }).why;
  await pairPost(fx, '/api/pair-code', site(fx));
  fx.sf.clock.advanceBy(PAIR_TTL_MS + 1);
  assert.equal(await why(fx.printed[0]!), 'expired');
  assert.ok(fx.log.entries().some((e) => e.event === 'peek-pair' && (e.fields as { outcome?: string }).outcome === 'expired'));
  const other = (c: string) => (c === '99999999' ? '99999998' : '99999999');
  // 5 wrong in a row void the code; a new code counts afresh in a row, not in all.
  await pairPost(fx, '/api/pair-code', site(fx));
  const c1 = fx.printed.at(-1)!;
  const five: string[] = [];
  for (let i = 0; i < 5; i++) five.push(await why(other(c1)));
  assert.deepEqual(five, ['wrong', 'wrong', 'wrong', 'wrong', 'voided']);
  assert.equal(await why(c1), 'no-code');
  let n = 5;
  while (n < 20) {
    await pairPost(fx, '/api/pair-code', site(fx));
    const k = fx.printed.at(-1)!;
    for (let i = 0; i < 4 && n < 20; i++, n++) assert.equal(await why(other(k)), n < 19 ? 'wrong' : 'shut');
  }
  const asked = await pairPost(fx, '/api/pair-code', site(fx));
  assert.deepEqual([asked.status, JSON.parse(asked.body)], [403, { error: 'not-unlocked', why: 'shut' }]);
  assert.equal(await why('12345678'), 'shut');

  const off = await fixture(t, { print: false });
  assert.equal((await pairPost(off, '/api/pair-code', site(off))).status, 503);
  // The code the start printed still pairs.
  assert.match((await pairBrowser(off.server, CODE)).csrf, CSRF_RE);
});

test('a browser that pairs again drops its old pairing; the cookie of one browser with the token of another is refused', async (t) => {
  const fx = await fixture(t, { code: null });
  const fresh = async () => {
    await pairPost(fx, '/api/pair-code', site(fx));
    return fx.printed.at(-1)!;
  };
  const a = await pairBrowser(fx.server, await fresh());
  const b = await pairBrowser(fx.server, await fresh());
  assert.equal((await request(fx, 'GET', '/api/owned', page(fx, a.cookie, a.csrf))).status, 501);
  assert.equal((await request(fx, 'GET', '/api/owned', page(fx, b.cookie, b.csrf))).status, 501);
  for (const [c, k] of [[a.cookie, b.csrf], [b.cookie, a.csrf]] as const) {
    const r = await request(fx, 'GET', '/api/owned', page(fx, c, k));
    assert.deepEqual([r.status, err(r)], [403, 'not-unlocked'], 'a token is bound to its own pairing');
  }
  // a pairs again, with its old cookie: the old pairing goes, the new one works.
  const again = await request(fx, 'POST', '/api/pair', { ...site(fx), cookie: a.cookie, 'content-type': 'application/json' }, JSON.stringify({ code: await fresh() }));
  assert.equal(again.status, 200);
  const a2 = { cookie: String(again.headers['set-cookie']).split(';')[0]!, csrf: (JSON.parse(again.body) as { csrf: string }).csrf };
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie: a.cookie })).status, 403, 'the old cookie is no pairing any more');
  assert.equal((await request(fx, 'GET', '/api/owned', page(fx, a2.cookie, a2.csrf))).status, 501);
});

test('forget: the whole chain first; then the pairing is gone, the cookie cleared, and its token dead on every owned route', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await pairBrowser(fx.server, CODE);
  const forget = (h: Record<string, string>, body?: string) => request(fx, 'POST', '/api/pair/forget', h, body);
  const h = page(fx, cookie, csrf);
  const { 'content-type': _t, ...noType } = h;
  assert.equal((await forget({ ...noType, cookie: '' })).status, 403);
  const { 'x-orchestra-csrf': _c, ...cookieOnly } = noType;
  assert.deepEqual([(await forget(cookieOnly)).status, err(await forget(cookieOnly))], [403, 'not-unlocked'], 'the cookie alone forgets nothing');
  assert.equal((await forget({ ...noType, origin: 'http://orchestra.localhost:1' })).status, 403);
  assert.equal((await forget(h, '{}')).status, 400, 'no body');
  assert.equal((await request(fx, 'GET', '/api/pair/forget', h)).status, 405);
  assert.equal((await request(fx, 'GET', '/api/owned', h)).status, 501, 'still paired after the refusals');
  const done = await forget(noType);
  assert.equal(done.status, 204);
  assert.equal(String(done.headers['set-cookie']), 'orchestra_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  for (const r of UNLOCKED) {
    const s = sample(r);
    const res = await request(fx, r.method, s.path, h, s.body === null ? undefined : JSON.stringify(s.body));
    assert.equal(res.status, 403, `${r.method} ${r.path}`);
  }
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie })).status, 403);
  assert.equal((await forget(noType)).status, 403, 'forgotten once');
  assert.deepEqual(humans(fx), [], 'no journal record');
});

test('the other port: a page elsewhere on orchestra.localhost gets the cookie, and with it the shell and the peek reads, never an owned route', async (t) => {
  const fx = await fixture(t);
  const { cookie } = await pairBrowser(fx.server, CODE);
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie })).status, 200);
  assert.equal((await request(fx, 'GET', '/', { cookie })).status, 200);
  // A replay by another program (curl): it can forge Origin and Sec-Fetch-Site, but it has no token.
  const forgetRoute = ROUTES.find((x) => x.path === '/api/pair/forget')!;
  for (const r of [...UNLOCKED, forgetRoute]) {
    const s = sample(r);
    const res = await request(fx, r.method, s.path, page(fx, cookie), r === forgetRoute || s.body === null ? undefined : JSON.stringify(s.body));
    assert.deepEqual([res.status, err(res)], [403, 'not-unlocked'], `${r.method} ${r.path}`);
    assert.equal(/[A-Za-z0-9_-]{43}/.test(res.body), false, 'no token in any reply to the cookie alone');
  }
  // Nor does the cookie buy a token: pairing again needs a code.
  const r = await request(fx, 'POST', '/api/pair', { ...site(fx), cookie, 'content-type': 'application/json' }, JSON.stringify({ code: '00000000' }));
  assert.deepEqual([r.status, err(r)], [403, 'not-unlocked']);
});

// --- the check chain ------------------------------------------------------------------------------

test('every owned route, a GET too: no cookie 403; cookie without the token 403 not-unlocked; wrong Origin 403; no Sec-Fetch-Site 403; a wrong token 403 not-unlocked', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await unlocked(fx);
  for (const r of UNLOCKED) {
    const s = sample(r);
    const body = s.body === null ? undefined : JSON.stringify(s.body);
    const go = (h: Record<string, string>) => request(fx, r.method, s.path, h, body);
    const name = `${r.method} ${r.path}`;
    const noCookie = await go({ ...page(fx, cookie, csrf), cookie: '' });
    assert.equal(noCookie.status, 403, name);
    assert.equal(err(noCookie), null, `${name}: not paired is no token matter`);
    assert.equal((await go({ ...page(fx, cookie, csrf), cookie: 'orchestra_sid=forged' })).status, 403, name);
    const noToken = await go(page(fx, cookie));
    assert.deepEqual([noToken.status, err(noToken)], [403, 'not-unlocked'], name);
    const wrongToken = await go(page(fx, cookie, `${csrf.slice(0, -1)}${csrf.endsWith('A') ? 'B' : 'A'}`));
    assert.deepEqual([wrongToken.status, err(wrongToken)], [403, 'not-unlocked'], name);
    assert.deepEqual([(await go(page(fx, cookie, 'short'))).status], [403], name);
    assert.equal((await go({ ...page(fx, cookie, csrf), origin: 'http://orchestra.localhost:1' })).status, 403, name);
    assert.equal((await go({ ...page(fx, cookie, csrf), origin: 'null' })).status, 403, name);
    const { 'sec-fetch-site': _s, ...noSite } = page(fx, cookie, csrf);
    assert.equal((await go(noSite)).status, 403, name);
    assert.equal((await go({ ...page(fx, cookie, csrf), 'sec-fetch-site': 'same-site' })).status, 403, name);
    assert.equal((await go({ ...page(fx, cookie, csrf), 'sec-fetch-site': 'none' })).status, 403, name);
    // Past the chain: 501 (no handler yet) or 409 owned-disabled.
    const through = await go(page(fx, cookie, csrf));
    assert.ok(through.status === 501 || (through.status === 409 && err(through) === 'owned-disabled'), `${name}: ${through.status} ${through.body}`);
    if (r.method === 'GET') {
      const { origin: _o, ...noOrigin } = page(fx, cookie, csrf);
      assert.equal((await go(noOrigin)).status, 501, `${name}: a same-origin GET carries no Origin`);
    } else {
      const { origin: _o, ...noOrigin } = page(fx, cookie, csrf);
      assert.equal((await go(noOrigin)).status, 403, `${name}: a POST must carry Origin`);
      assert.equal((await go({ ...page(fx, cookie, csrf), 'content-type': 'text/plain' })).status, 400, `${name}: JSON only`);
    }
  }
  assert.deepEqual(humans(fx), [], '4xx and 501 write nothing');
});

test('the chain runs in the design\'s order: cookie, Origin, Sec-Fetch-Site, JSON, token, body cap, message cap, slash, actionId, shape, path id, dedup, owned-disabled, handler', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await unlocked(fx);
  const big = JSON.stringify({ actionId: 'nope', text: 'x'.repeat(OWNED_BODY_MAX_BYTES) });
  const h = page(fx, cookie, csrf);
  const { 'sec-fetch-site': _s, 'x-orchestra-csrf': _c, ...bare } = h;
  const P = '/api/owned/own-1/message';
  // Each line fixes the failure of the one before it and fails at the next step: [headers, path, body, status, code or plain text].
  const steps: [Record<string, string>, string, string, number, string][] = [
    [{ ...bare, cookie: '', origin: 'http://evil.example', 'content-type': 'text/plain' }, P, big, 403, 'not paired'],
    [{ ...bare, origin: 'http://evil.example', 'content-type': 'text/plain' }, P, big, 403, 'wrong origin'],
    [{ ...bare, 'content-type': 'text/plain' }, P, big, 403, 'cross-site request'],
    [{ ...bare, 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, P, big, 400, 'bad request'],
    [{ ...bare, 'sec-fetch-site': 'same-origin' }, P, big, 403, 'not-unlocked'],
    [h, P, big, 413, 'body-too-big'],
    [h, P, JSON.stringify({ actionId: 'nope', text: `/${'é'.repeat(OWNED_TEXT_MAX_BYTES / 2)}`, extra: 1 }), 422, 'text-too-long'],
    [h, P, JSON.stringify({ actionId: 'nope', text: '/model sonnet', extra: 1 }), 422, 'slash-command'],
    [h, P, JSON.stringify({ actionId: 'nope', text: 'hi', extra: 1 }), 400, 'actionId-missing'],
    [h, P, JSON.stringify({ actionId: uuid(), text: 'hi', extra: 1 }), 400, 'bad request'],
    [h, '/api/owned/bad.id/message', JSON.stringify({ actionId: uuid(), text: 'hi' }), 404, 'item-unknown'],
    [h, P, JSON.stringify({ actionId: uuid(), text: 'hi' }), 501, 'not implemented yet'],
  ];
  for (const [i, [headers, path, body, status, why]] of steps.entries()) {
    const r = await request(fx, 'POST', path, headers, body);
    assert.deepEqual([r.status, err(r) ?? r.body.trim()], [status, why], `step ${i}`);
  }
  // A request that starts work stops at owned-disabled, after the dedup and before the handler.
  fx.handlers.register('POST', '/api/owned/new', () => assert.fail('the handler of a disabled route never runs'));
  const n = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: 'hi', harness: 'codex' }));
  assert.deepEqual([n.status, err(n)], [409, 'owned-disabled']);
  const bad = await request(fx, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: uuid(), text: 'hi', harness: 'codex', x: 1 }));
  assert.equal(bad.status, 400, 'the shape comes before owned-disabled');
  assert.deepEqual(humans(fx), []);
});

test('the body cap: over OWNED_BODY_MAX_BYTES is 413 body-too-big on every owned POST, whether Content-Length says so or a chunked body runs over', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await unlocked(fx);
  for (const r of UNLOCKED.filter((x) => x.method === 'POST')) {
    const s = sample(r);
    const pad = { ...s.body, pad: 'x'.repeat(OWNED_BODY_MAX_BYTES) };
    const declared = await request(fx, 'POST', s.path, page(fx, cookie, csrf), JSON.stringify(pad));
    assert.deepEqual([declared.status, err(declared)], [413, 'body-too-big'], r.path);
    const chunked = await request(fx, 'POST', s.path, { ...page(fx, cookie, csrf), 'transfer-encoding': 'chunked' }, Buffer.from(JSON.stringify(pad)));
    assert.deepEqual([chunked.status, err(chunked)], [413, 'body-too-big'], `${r.path} chunked`);
  }
  // At the cap exactly the body is read (and then refused by its shape).
  const s = sample(UNLOCKED.find((x) => x.human === 'owned-end')!);
  const head = JSON.stringify({ ...s.body, pad: '' });
  const exact = JSON.stringify({ ...s.body, pad: 'x'.repeat(OWNED_BODY_MAX_BYTES - Buffer.byteLength(head)) });
  assert.equal(Buffer.byteLength(exact), OWNED_BODY_MAX_BYTES);
  assert.equal((await request(fx, 'POST', s.path, page(fx, cookie, csrf), exact)).status, 400);
  assert.equal(ERROR_STATUS['body-too-big'], 413);
});

test('messages: at most 2048 bytes of UTF-8, else 422 text-too-long; one starting with / (after blanks) is 422 slash-command, on new and message alike', async (t) => {
  const fx = await fixture(t, { enabled: true });
  const { cookie, csrf } = await unlocked(fx);
  const ok: OwnedHandler = () => ({ ok: true, reply: { ownedId: OID }, targetId: OID });
  fx.handlers.register('POST', '/api/owned/new', ok);
  fx.handlers.register('POST', '/api/owned/:id/message', () => ({ ok: true, reply: { uuid: uuid(), queued: 0, via: 'turn/start' } }));
  for (const path of ['/api/owned/new', `/api/owned/${OID}/message`]) {
    const extra = path === '/api/owned/new' ? { harness: 'codex' } : {};
    const send = (text: string) => request(fx, 'POST', path, page(fx, cookie, csrf), JSON.stringify({ actionId: uuid(), text, ...extra }));
    assert.equal((await send('中'.repeat(682) + 'ab')).status, 200, '2048 bytes');
    const over = await send('中'.repeat(683));
    assert.deepEqual([over.status, err(over)], [422, 'text-too-long'], '2049 bytes, 683 code points');
    for (const s of ['/model sonnet', '/config', '  /permissions', '\n/x']) {
      const r = await send(s);
      assert.deepEqual([r.status, err(r)], [422, 'slash-command'], JSON.stringify(s));
    }
    assert.equal((await send('a /slash inside is fine')).status, 200);
  }
});

test('GET routes: an unknown or repeated query key is 400; feed takes a decimal after=; a path id outside its grammar is 404 item-unknown', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await unlocked(fx);
  const h = page(fx, cookie, csrf);
  assert.equal((await request(fx, 'GET', '/api/owned?x=1', h)).status, 400);
  assert.equal((await request(fx, 'GET', `/api/owned/${OID}/feed?after=12`, h)).status, 501);
  assert.equal((await request(fx, 'GET', `/api/owned/${OID}/feed?after=01`, h)).status, 400);
  assert.equal((await request(fx, 'GET', `/api/owned/${OID}/feed?after=1&after=2`, h)).status, 400);
  const badStage = await request(fx, 'GET', '/api/import/ABCDEF/check', h);
  assert.deepEqual([badStage.status, err(badStage)], [404, 'item-unknown']);
  assert.equal((await request(fx, 'GET', `/api/import/${STAGE}/check`, h)).status, 501);
  assert.equal((await request(fx, 'GET', '/api/owned/nope/nothing', h)).status, 404, 'no such route');
  // a handler's GET reply goes out when it fits the route's reply shape, else 500
  fx.handlers.register('GET', '/api/import/:id/check', (c) => (c.id === STAGE ? { ok: true, reply: { can: 'none', why: 'owned-disabled' } } : { ok: true, reply: { can: 'maybe' } }));
  const check = await request(fx, 'GET', `/api/import/${STAGE}/check`, h);
  assert.deepEqual([check.status, JSON.parse(check.body)], [200, { can: 'none', why: 'owned-disabled' }]);
  assert.equal((await request(fx, 'GET', `/api/import/${'1'.repeat(20)}/check`, h)).status, 500);
});

// --- dedup and the human records ------------------------------------------------------------------

test('a handled action writes human and human.result in one batch; the same request again is replayed, another one with its actionId is 422', async (t) => {
  const fx = await fixture(t, { enabled: true });
  const { cookie, csrf } = await unlocked(fx);
  let runs = 0;
  fx.handlers.register('POST', '/api/owned/new', () => {
    runs++;
    return { ok: true, reply: { ownedId: OID }, targetId: OID };
  });
  const actionId = uuid();
  const body = JSON.stringify({ actionId, text: 'hello', harness: 'codex' });
  const first = await request(fx, 'POST', '/api/owned/new', page(fx, cookie, csrf), body);
  assert.equal(first.status, 200, first.body);
  const reply = JSON.parse(first.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reply).sort(), ['accepted', 'actionId', 'jseq', 'ownedId']);
  assert.equal(reply.actionId, actionId);
  const rows = humans(fx);
  assert.deepEqual(rows.map((r) => r.kind), ['human', 'human.result']);
  assert.deepEqual(rows[0]!.body, { actionId, verb: 'owned-new', targetId: OID, requestDigest: rows[0]!.body.requestDigest });
  assert.match(String(rows[0]!.body.requestDigest), /^[0-9a-f]{64}$/);
  assert.deepEqual(rows[1]!.body, { actionId, verb: 'owned-new', targetId: OID, outcome: 'applied', commandId: null, subtrees: null });
  const jseqs = fx.store.db.all("SELECT jseq FROM event WHERE kind = 'human.result'").map((r) => Number(r.jseq));
  assert.deepEqual(jseqs, [reply.jseq]);

  const again = await request(fx, 'POST', '/api/owned/new', page(fx, cookie, csrf), body);
  assert.deepEqual(JSON.parse(again.body), { ...reply, replayed: true });
  assert.equal(runs, 1, 'the effect runs once');
  const other = await request(fx, 'POST', '/api/owned/new', page(fx, cookie, csrf), JSON.stringify({ actionId, text: 'hello!', harness: 'codex' }));
  assert.deepEqual([other.status, err(other)], [422, 'actionId-reused']);
  const elsewhere = await request(fx, 'POST', `/api/owned/${OID}/end`, page(fx, cookie, csrf), JSON.stringify({ actionId }));
  assert.deepEqual([elsewhere.status, err(elsewhere)], [422, 'actionId-reused'], 'the digest covers the route');
  assert.equal(humans(fx).length, 2);

  // After a restart the journal alone rebuilds the dedup: the same request is replayed (the verb's own fields are this boot's only).
  await fx.server.close();
  fx.store.close();
  const fx2 = await fixture(t, { enabled: true, sf: fx.sf });
  const { cookie: c2, csrf: t2 } = await unlocked(fx2);
  fx2.handlers.register('POST', '/api/owned/new', () => assert.fail('a replay runs no handler'));
  const replayed = await request(fx2, 'POST', '/api/owned/new', page(fx2, c2, t2), body);
  assert.deepEqual(JSON.parse(replayed.body), { actionId, accepted: true, jseq: reply.jseq, replayed: true });
  const reused = await request(fx2, 'POST', '/api/owned/new', page(fx2, c2, t2), JSON.stringify({ actionId, text: 'other', harness: 'codex' }));
  assert.deepEqual([reused.status, err(reused)], [422, 'actionId-reused']);
});

test('while the handler awaits: the same actionId is 409 in-flight, with another body 422 actionId-reused; refused or failed actions write nothing and free the actionId', async (t) => {
  const fx = await fixture(t);
  const { cookie, csrf } = await unlocked(fx);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const inHandler = new Promise<void>((r) => {
    entered = r;
  });
  let mode: 'wait' | 'refuse' | 'throw' | 'bad-error' | 'ok' = 'wait';
  fx.handlers.register('POST', '/api/owned/:id/message', async (c) => {
    assert.equal(c.id, OID);
    assert.equal(c.sid.length > 0, true);
    assert.deepEqual(Object.keys(c.body!).sort(), ['actionId', 'text']);
    if (mode === 'wait') {
      entered();
      await gate;
    }
    if (mode === 'refuse') return { ok: false, error: 'item-unknown' };
    if (mode === 'throw') throw new Error('boom');
    if (mode === 'bad-error') return { ok: false, error: 'plan-expired' };
    return { ok: true, reply: { uuid: '0e0f3a52-7b1c-4d2e-9f00-1234567890ab', queued: 2, via: 'queued' } };
  });
  const P = `/api/owned/${OID}/message`;
  const actionId = uuid();
  const body = JSON.stringify({ actionId, text: 'one' });
  const slow = request(fx, 'POST', P, page(fx, cookie, csrf), body);
  await inHandler;
  const same = await request(fx, 'POST', P, page(fx, cookie, csrf), body);
  assert.deepEqual([same.status, err(same)], [409, 'in-flight']);
  const otherBody = await request(fx, 'POST', P, page(fx, cookie, csrf), JSON.stringify({ actionId, text: 'two' }));
  assert.deepEqual([otherBody.status, err(otherBody)], [422, 'actionId-reused']);
  release();
  const done = await slow;
  assert.equal(done.status, 200, done.body);
  const doneReply = JSON.parse(done.body) as Record<string, unknown>;
  assert.deepEqual(doneReply, { actionId, accepted: true, jseq: doneReply.jseq, uuid: '0e0f3a52-7b1c-4d2e-9f00-1234567890ab', queued: 2, via: 'queued' });
  assert.deepEqual(humans(fx).map((r) => [r.kind, r.body.verb, r.body.targetId]), [['human', 'owned-message', OID], ['human.result', 'owned-message', OID]]);

  for (const [m, status] of [['refuse', 404], ['throw', 500], ['bad-error', 500]] as const) {
    mode = m;
    const id = uuid();
    const before = humans(fx).length;
    const r = await request(fx, 'POST', P, page(fx, cookie, csrf), JSON.stringify({ actionId: id, text: 'x' }));
    assert.equal(r.status, status, m);
    assert.equal(humans(fx).length, before, `${m}: nothing written`);
    mode = 'ok';
    const retry = await request(fx, 'POST', P, page(fx, cookie, csrf), JSON.stringify({ actionId: id, text: 'x' }));
    assert.equal(retry.status, 200, `${m}: the same actionId may try again`);
  }
  assert.ok(fx.log.entries().some((e) => e.event === 'owned-handler-failed'));
  assert.ok(fx.log.entries().some((e) => e.event === 'owned-handler-bad-error'), 'a code the route cannot answer is the handler\'s bug');
});

test('the profile switch: new, import and retry answer 409 owned-disabled unless the server was made with owned sessions on; then 501 until a handler is registered', async (t) => {
  const starts = UNLOCKED.filter((r) => r.own.includes('owned-disabled')).map((r) => r.human);
  assert.deepEqual(starts, ['owned-new', 'owned-retry', 'import-claude', 'import-dsh']);
  const off = await fixture(t);
  const on = await fixture(t, { enabled: true });
  for (const fx of [off, on]) {
    const { cookie, csrf } = await unlocked(fx);
    for (const r of UNLOCKED.filter((x) => x.method === 'POST')) {
      const s = sample(r);
      const res = await request(fx, 'POST', s.path, page(fx, cookie, csrf), JSON.stringify(s.body));
      const disabled = fx === off && r.own.includes('owned-disabled');
      assert.deepEqual([res.status, err(res)], disabled ? [409, 'owned-disabled'] : [501, null], `${fx === off ? 'off' : 'on'} ${r.path}`);
    }
    assert.deepEqual(humans(fx), []);
  }
});

test('the handler table takes each unlocked route once, and nothing else', () => {
  const h = makeOwnedHandlers();
  const f: OwnedHandler = () => ({ ok: false, error: 'item-unknown' });
  h.register('POST', '/api/approvals/:id/allow', f);
  assert.throws(() => h.register('POST', '/api/approvals/:id/allow', f), /already/);
  assert.throws(() => h.register('POST', '/api/pair/forget', f), /not an owned route/);
  assert.throws(() => h.register('POST', '/api/pair', f), /not an owned route/);
  assert.throws(() => h.register('POST', '/api/items/:id/seen', f), /not an owned route/);
  assert.throws(() => h.register('GET', '/api/owned/:id/message', f), /not an owned route/);
  assert.equal(h.get(ROUTES.find((r) => r.path === '/api/approvals/:id/allow')!), f);
  assert.equal(Object.isFrozen(h), true);
});

// --- end to end -------------------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

test('end to end: a test-profile orchestrad prints the pairing code to stdout; the token opens the owned routes; restarted, it remembers the browser and prints no code; without --owned the list says why they are off', async (t) => {
  const dir = withTmp(t);
  const port = await freePort();
  const args = ['--test-profile', '--test-dir', dir, '--peek-port', String(port)];
  const child = startOrchestrad(t, args);
  await waitForLine(child, /^orchestrad: peek page at /);
  const code = /^orchestrad: pairing code (\d{8})$/.exec(child.lines().find((l) => l.startsWith('orchestrad: pairing code')) ?? '')?.[1];
  assert.ok(code !== undefined);
  const origin = `http://orchestra.localhost:${port}`;
  const fx = { server: { port }, host: `orchestra.localhost:${port}` } as unknown as Fx;
  const { cookie, csrf } = await pairBrowser(fx.server, code);
  const h = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const hc = { ...h, 'x-orchestra-csrf': csrf };
  assert.equal((await request(fx, 'GET', '/api/owned', h)).status, 403);
  const list = await request(fx, 'GET', '/api/owned', hc);
  assert.equal(list.status, 200, list.body);
  const l = JSON.parse(list.body) as Record<string, unknown>;
  assert.deepEqual([l.enabled, l.disabledWhy, l.owned, l.approvals], [false, 'not-asked', [], []]);
  const n = await request(fx, 'POST', '/api/owned/new', hc, JSON.stringify({ actionId: uuid(), text: 'hi', harness: 'codex' }));
  assert.deepEqual([n.status, JSON.parse(n.body)], [409, { error: 'owned-disabled' }]);
  await child.stop();
  assert.equal(child.lines().join('\n').split(code).length - 1, 1, 'the code is printed once, and nowhere else on stdout');

  // Restarted on the same data dir: the browser is remembered, no code is printed, the cookie and the token still work.
  const again = startOrchestrad(t, args);
  await waitForLine(again, /^orchestrad: peek page at /);
  assert.ok(again.lines().includes('orchestrad: 1 browser remembered as paired; a new browser asks for a pairing code on the page'), again.lines().join('\n'));
  assert.equal(again.lines().some((x) => /pairing code \d{8}/.test(x)), false, 'no code at a start that remembers a browser');
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie })).status, 200);
  assert.equal((await request(fx, 'GET', '/api/owned', hc)).status, 200);
  // A new browser asks for a code on the page: it is printed where the start's code goes.
  assert.equal(await askPairCode(fx.server), 204);
  const asked = (await waitForLine(again, /^orchestrad: pairing code \d{8}$/)).slice(-8);
  const other = await pairBrowser(fx.server, asked);
  assert.equal((await request(fx, 'GET', '/api/owned', { ...h, cookie: other.cookie, 'x-orchestra-csrf': other.csrf })).status, 200);
  await again.stop();

  // On disk: digests only. Neither the codes, the tokens nor the sids are in the pairings file or the log.
  const home = path.join(fs.realpathSync.native(dir), 'orchestra');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'pairings.json'), 'utf8')) as { v: number; browsers: Record<string, unknown>[] };
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.browsers.map((b) => Object.keys(b).sort()), [['csrfSha256', 'pairedAt', 'sidSha256'], ['csrfSha256', 'pairedAt', 'sidSha256']]);
  const log = fs.readFileSync(path.join(home, 'run', 'orchestrad.log'), 'utf8');
  for (const s of [code, asked, csrf, other.csrf, cookie.split('=')[1]!, other.cookie.split('=')[1]!]) {
    assert.equal(log.includes(s), false, 'a secret in the log');
    assert.equal(JSON.stringify(saved).includes(s), false, 'a secret in the pairings file');
  }
});
