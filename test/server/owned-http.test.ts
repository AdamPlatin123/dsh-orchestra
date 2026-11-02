import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { Log } from '../../src/runtime/log.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import type { OwnedHandler, OwnedHandlers } from '../../src/server/owned.ts';
import { UNLOCK_TTL_MS, humanJournal, makeOwnedHandlers, makeUnlock } from '../../src/server/owned.ts';
import { CSRF_RE, OWNED_BODY_MAX_BYTES, OWNED_TEXT_MAX_BYTES, ROUTES } from '../../src/server/routes.ts';
import type { Route } from '../../src/server/routes.ts';
import type { Store } from '../../src/store/store.ts';
import { ERROR_STATUS } from '../../shared/protocol.js';
import { realIo } from '../helpers/read-io.ts';
import { startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';
import type { StoreFixture } from '../helpers/store.ts';
import { withTmp } from '../helpers/tmp.ts';

// The owned-session base (slice design §2.7, §6 「端点安全」; §7 step 5): the unlock code and the
// controller token, the check chain every owned route runs, the `human` records and the handler table.
// Here the tests register their own handlers where a route must get that far; the real handlers and
// their end to end runs against the fake app-server are in owned-flow.test.ts.

const CODE = '12345678';
const OID = 'own-1';
const STAGE = '0123456789abcdef0123';

type Fx = {
  server: PeekServer; host: string; origin: string; log: Log; store: Store; sf: StoreFixture; printed: string[]; handlers: OwnedHandlers;
};

async function fixture(t: TestContext, opts: { enabled?: boolean; print?: boolean; sf?: StoreFixture; handlers?: OwnedHandlers } = {}): Promise<Fx> {
  const sf = opts.sf ?? await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const printed: string[] = [];
  const handlers = opts.handlers ?? makeOwnedHandlers();
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: CODE, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: opts.print === false ? null : (c) => printed.push(c), enabled: opts.enabled ?? false, handlers },
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

async function paired(fx: Fx): Promise<string> {
  const r = await request(fx, 'POST', '/pair', { origin: fx.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${CODE}`);
  assert.equal(r.status, 303);
  return String(r.headers['set-cookie']).split(';')[0]!;
}

/** What the page sends: the cookie, its own origin, same-origin, JSON, and the token when it has one. */
const page = (fx: Fx, cookie: string, csrf?: string): Record<string, string> => ({
  cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(csrf === undefined ? {} : { 'x-orchestra-csrf': csrf }),
});

async function unlocked(fx: Fx): Promise<{ cookie: string; csrf: string }> {
  const cookie = await paired(fx);
  const asked = await request(fx, 'POST', '/api/owned/unlock-code', { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(asked.status, 204);
  const r = await request(fx, 'POST', '/api/owned/unlock', page(fx, cookie), JSON.stringify({ code: fx.printed.at(-1) }));
  assert.equal(r.status, 200, r.body);
  const csrf = (JSON.parse(r.body) as { csrf: string }).csrf;
  return { cookie, csrf };
}

const err = (r: Reply) => (r.headers['content-type']?.startsWith('application/json') ? (JSON.parse(r.body) as { error?: string }).error ?? null : null);
const humans = (fx: Fx) => fx.store.db.all("SELECT kind, body FROM event WHERE kind IN ('human', 'human.result') ORDER BY jseq").map((r) => ({ kind: String(r.kind), body: JSON.parse(String(r.body)) as Record<string, unknown> }));
const uuid = () => crypto.randomUUID();

/** A concrete path and a valid body for each owned route. */
function sample(r: Route): { path: string; body: Record<string, unknown> | null } {
  const path = r.path.replace(':id', r.target === 'stage' ? STAGE : OID);
  if (r.method === 'GET') return { path, body: null };
  const extra: Record<string, Record<string, unknown>> = {
    'owned-new': { text: 'hello', harness: 'codex' }, 'owned-message': { text: 'hello' }, 'approval-allow': { digest: 'a'.repeat(64), rev: 1 },
    'import-claude': { stageId: STAGE, mode: 'fork', cwdShown: 'G:\\work\\x' }, 'import-dsh': { stageId: STAGE },
  };
  // A POST that writes no human record carries no actionId (POST /api/route/suggest).
  if (r.human === null) return { path, body: { text: 'hello' } };
  return { path, body: { actionId: uuid(), ...(extra[r.human ?? ''] ?? {}) } };
}
const UNLOCKED = ROUTES.filter((r) => r.auth === 'unlocked');

// --- unlock ---------------------------------------------------------------------------------------

test('unlock-code prints a fresh code only to the console and answers 204 with no body; unlock trades it once for a token of CSRF_RE\'s form', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const asked = await request(fx, 'POST', '/api/owned/unlock-code', { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(asked.status, 204);
  assert.equal(asked.body, '');
  assert.equal(fx.printed.length, 1);
  const code = fx.printed[0]!;
  assert.match(code, /^[0-9]{8}$/);
  assert.equal(JSON.stringify(asked.headers).includes(code), false, 'never in a reply');
  const wrong = await request(fx, 'POST', '/api/owned/unlock', page(fx, cookie), JSON.stringify({ code: code === '00000000' ? '00000001' : '00000000' }));
  assert.deepEqual([wrong.status, err(wrong)], [403, 'not-unlocked']);
  const ok = await request(fx, 'POST', '/api/owned/unlock', page(fx, cookie), JSON.stringify({ code }));
  assert.equal(ok.status, 200);
  const reply = JSON.parse(ok.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reply), ['csrf']);
  assert.match(String(reply.csrf), CSRF_RE);
  assert.equal(ok.body.includes(code), false);
  const again = await request(fx, 'POST', '/api/owned/unlock', page(fx, cookie), JSON.stringify({ code }));
  assert.deepEqual([again.status, err(again)], [403, 'not-unlocked'], 'one time');
  // A second ask prints another code; the code and the token never reach the log.
  await request(fx, 'POST', '/api/owned/unlock-code', { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(fx.printed.length, 2);
  const logged = JSON.stringify(fx.log.entries());
  for (const s of [...fx.printed, String(reply.csrf)]) assert.equal(logged.includes(s), false);
});

test('the unlock pair needs the cookie, the exact Origin and Sec-Fetch-Site same-origin; unlock takes JSON only, unlock-code no body', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const base = { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' };
  const code = (h: Record<string, string>, body?: string) => request(fx, 'POST', '/api/owned/unlock-code', h, body);
  assert.equal((await code({ ...base, cookie: 'orchestra_sid=forged' })).status, 403);
  assert.equal((await code({ origin: fx.origin, 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await code({ ...base, origin: 'http://orchestra.localhost:1' })).status, 403, 'another port is another origin');
  const { 'sec-fetch-site': _s, ...noSite } = base;
  assert.equal((await code(noSite)).status, 403);
  assert.equal((await code({ ...base, 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await code({ ...base, 'content-type': 'application/json' }, '{}')).status, 400, 'no body');
  assert.equal(fx.printed.length, 0, 'no code for a refused ask');
  assert.equal((await request(fx, 'GET', '/api/owned/unlock-code', base)).status, 405);
  assert.equal((await code(base)).status, 204);
  const c = fx.printed[0]!;
  const unlock = (h: Record<string, string>, body: string) => request(fx, 'POST', '/api/owned/unlock', h, body);
  assert.equal((await unlock({ ...base, 'content-type': 'text/plain' }, JSON.stringify({ code: c }))).status, 400);
  assert.equal((await unlock({ ...base, 'content-type': 'application/x-www-form-urlencoded' }, `code=${c}`)).status, 400);
  assert.equal((await unlock({ ...base, 'content-type': 'application/json' }, JSON.stringify({ code: c, sid: 'x' }))).status, 400);
  const big = await unlock({ ...base, 'content-type': 'application/json' }, JSON.stringify({ code: c, pad: 'x'.repeat(2000) }));
  assert.deepEqual([big.status, err(big)], [413, 'body-too-big']);
  assert.equal((await unlock({ ...base, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ code: c }))).status, 200, 'refusals before the code is compared do not spend it');
});

test('unlock codes: per sid, the pairing code\'s throttle (10 minutes, 5 wrong in a row void the code, 20 wrong in all close unlocking), tokens bound to their sid', () => {
  const u = makeUnlock();
  const a = u.issue('sid-a', 0)!;
  const b = u.issue('sid-b', 0)!;
  assert.match(a, /^[0-9]{8}$/);
  const other = (c: string) => (c === '99999999' ? '99999998' : '99999999');
  // a's code is no good for b, and counts as a wrong try there
  assert.equal(u.attempt('sid-b', a === b ? other(b) : a, 1).outcome, 'wrong');
  assert.equal(u.attempt('sid-c', a, 1).outcome, 'no-code', 'a sid that asked for no code has none');
  const ta = u.attempt('sid-a', a, 2);
  assert.equal(ta.outcome, 'ok');
  assert.match(ta.csrf!, CSRF_RE);
  const tb = u.attempt('sid-b', b, 3);
  assert.equal(tb.outcome, 'ok');
  assert.equal(u.holds('sid-a', ta.csrf), true);
  assert.equal(u.holds('sid-b', ta.csrf), false, 'a token from one sid fails on another');
  assert.equal(u.holds('sid-a', tb.csrf), false);
  for (const bad of [undefined, '', 'x', ta.csrf!.slice(1), `${ta.csrf}=`, ['x']]) assert.equal(u.holds('sid-a', bad), false);
  // a new unlock replaces the token
  const ta2 = u.attempt('sid-a', u.issue('sid-a', 4)!, 5);
  assert.equal(u.holds('sid-a', ta.csrf), false);
  assert.equal(u.holds('sid-a', ta2.csrf), true);
  u.forget('sid-a');
  assert.equal(u.holds('sid-a', ta2.csrf), false);
  // expiry: 10 minutes after the ask
  const late = u.issue('sid-a', 1000)!;
  assert.equal(u.attempt('sid-a', late, 1000 + UNLOCK_TTL_MS + 1).outcome, 'expired');
  assert.equal(u.attempt('sid-a', late, 1000 + UNLOCK_TTL_MS + 2).outcome, 'no-code');
  const inTime = u.issue('sid-a', 2000)!;
  assert.equal(u.attempt('sid-a', inTime, 2000 + UNLOCK_TTL_MS).outcome, 'ok');
  // 5 wrong in a row void the code, the right one included
  const c = u.issue('sid-a', 0)!;
  const outcomes = [1, 2, 3, 4, 5].map(() => u.attempt('sid-a', other(c), 0).outcome);
  assert.deepEqual(outcomes, ['wrong', 'wrong', 'wrong', 'wrong', 'voided']);
  assert.equal(u.attempt('sid-a', c, 0).outcome, 'no-code');
  // 20 wrong in all (1 on sid-b and 5 on sid-a so far) close unlocking: no new code, no token
  let n = 6;
  while (n < 20) {
    const k = u.issue('sid-b', 0)!;
    for (let i = 0; i < 4 && n < 20; i++, n++) {
      const o = u.attempt('sid-b', other(k), 0).outcome;
      if (n < 19) assert.equal(o, 'wrong');
      else assert.equal(o, 'shut');
    }
  }
  assert.equal(u.open, false);
  assert.equal(u.issue('sid-a', 0), null);
  assert.equal(u.attempt('sid-a', '12345678', 0).outcome, 'shut');
  assert.equal(u.holds('sid-b', tb.csrf), true, 'a token already handed out stays good');
});

test('over HTTP the code expires after 10 minutes on the Clock; with no console for it, unlock-code is off', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  await request(fx, 'POST', '/api/owned/unlock-code', { cookie, origin: fx.origin, 'sec-fetch-site': 'same-origin' });
  fx.sf.clock.advanceBy(UNLOCK_TTL_MS + 1);
  const r = await request(fx, 'POST', '/api/owned/unlock', page(fx, cookie), JSON.stringify({ code: fx.printed[0] }));
  assert.deepEqual([r.status, err(r)], [403, 'not-unlocked']);
  assert.ok(fx.log.entries().some((e) => e.event === 'owned-unlock' && (e.fields as { outcome?: string }).outcome === 'expired'));

  const off = await fixture(t, { print: false });
  const c2 = await paired(off);
  const asked = await request(off, 'POST', '/api/owned/unlock-code', { cookie: c2, origin: off.origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(asked.status, 503);
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
  assert.throws(() => h.register('POST', '/api/owned/unlock', f), /not an owned route/);
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

test('end to end: a test-profile orchestrad prints the unlock code to stdout; the token opens the owned routes; without --owned the list says why they are off and new is refused', async (t) => {
  const dir = withTmp(t);
  const port = await freePort();
  const child = startOrchestrad(t, ['--test-profile', '--test-dir', dir, '--peek-port', String(port)]);
  await waitForLine(child, /^orchestrad: peek page at /);
  const pairCode = /^orchestrad: pairing code (\d{8})$/.exec(child.lines().find((l) => l.startsWith('orchestrad: pairing code')) ?? '')?.[1];
  assert.ok(pairCode !== undefined);
  const origin = `http://orchestra.localhost:${port}`;
  const fx = { server: { port }, host: `orchestra.localhost:${port}` } as unknown as Fx;
  const pr = await request(fx, 'POST', '/pair', { origin, 'content-type': 'application/x-www-form-urlencoded' }, `code=${pairCode}`);
  const cookie = String(pr.headers['set-cookie']).split(';')[0]!;
  const asked = await request(fx, 'POST', '/api/owned/unlock-code', { cookie, origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(asked.status, 204);
  const line = await waitForLine(child, /^orchestrad: unlock code \d{8}$/);
  const code = line.slice(-8);
  assert.equal(asked.body.includes(code), false);
  const h = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const u = await request(fx, 'POST', '/api/owned/unlock', h, JSON.stringify({ code }));
  assert.equal(u.status, 200);
  const csrf = (JSON.parse(u.body) as { csrf: string }).csrf;
  const hc = { ...h, 'x-orchestra-csrf': csrf };
  assert.equal((await request(fx, 'GET', '/api/owned', h)).status, 403);
  const list = await request(fx, 'GET', '/api/owned', hc);
  assert.equal(list.status, 200, list.body);
  const l = JSON.parse(list.body) as Record<string, unknown>;
  assert.deepEqual([l.enabled, l.disabledWhy, l.owned, l.approvals], [false, 'not-asked', [], []]);
  const n = await request(fx, 'POST', '/api/owned/new', hc, JSON.stringify({ actionId: uuid(), text: 'hi', harness: 'codex' }));
  assert.deepEqual([n.status, JSON.parse(n.body)], [409, { error: 'owned-disabled' }]);
  await child.stop();
  const log = child.lines().join('\n');
  assert.equal(log.split(code).length - 1, 1, 'the code is printed once, and nowhere else on stdout');
});
