import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { PAIR_TTL_MS, PEEK_HOST, escapeHtml, makePairing, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import { realIo } from '../helpers/read-io.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// The peek server over a synthetic Claude root, on a free loopback port. Requests go to 127.0.0.1
// with the Host header a browser would send for orchestra.localhost.

const U1 = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';
const CODE = '12345678';
const SECRET = 'peek-http-secret-value-0123456789';
const CANARY = '<script>alert(1)</script><img src=x onerror=alert(2)>';

type Fx = { server: PeekServer; host: string; origin: string; log: Log; hub: VirtualClock };

async function fixture(t: TestContext, code: string | null = CODE): Promise<Fx> {
  const base = fs.realpathSync.native(withTmp(t));
  const claude = path.join(base, 'roots', 'claude');
  put(path.join(claude, 'projects', 'G--proj', `${U1}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: `${CANARY} ${SECRET}` } })}\n`);
  const roots: HarnessRoot[] = [{ kind: 'claude', path: claude, real: claude }];
  const hub = new VirtualClock({ mono: 1000, wall: Date.parse('2026-11-01T00:00:00Z') });
  const clock = hub.port(null);
  const log = new Log({ clock });
  const redactor = makeRedactor({ env: { ORCHESTRA_PEEK_TEST_TOKEN: SECRET } });
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots, io: realIo, testDirs: [base] }), roots, redact: (text) => redactor.redact({ text }).text, clock, log, pairingCode: code, profile: 'test',
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, log, hub };
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(fx: Fx, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
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

const pair = (fx: Fx, code: string, origin = fx.origin) => request(fx, 'POST', '/pair', { origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${code}`);

async function paired(fx: Fx): Promise<string> {
  const r = await pair(fx, CODE);
  assert.equal(r.status, 303);
  const cookie = String(r.headers['set-cookie']);
  return cookie.split(';')[0]!;
}

test('every reply carries the strict CSP and no CORS header; a wrong Host or a cross-site request is refused', async (t) => {
  const fx = await fixture(t);
  const r = await request(fx, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-security-policy']), /^default-src 'none';/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.body.includes('<script'), false);
  assert.equal((await request(fx, 'GET', '/', { host: `127.0.0.1:${fx.server.port}` })).status, 403);
  assert.equal((await request(fx, 'GET', '/', { host: `evil.example:${fx.server.port}` })).status, 403);
  assert.equal((await request(fx, 'GET', '/', { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('unpaired: the list is a pairing form and a session page is 403; pairing needs the exact Origin and the code once', async (t) => {
  const fx = await fixture(t);
  const home = await request(fx, 'GET', '/');
  assert.match(home.body, /<form method="post" action="\/pair">/);
  assert.equal(home.body.includes('G--proj'), false);
  assert.equal((await request(fx, 'GET', '/session?id=0')).status, 403);
  assert.equal((await pair(fx, CODE, 'http://evil.example')).status, 403);
  assert.equal((await pair(fx, CODE, `http://127.0.0.1:${fx.server.port}`)).status, 403);
  assert.equal((await pair(fx, '87654321')).status, 403);
  const ok = await pair(fx, CODE);
  assert.equal(ok.status, 303);
  assert.match(String(ok.headers['set-cookie']), /^orchestra_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  const again = await pair(fx, CODE);
  assert.equal(again.status, 403);
  assert.match(again.body, /配对已关闭|没有可用的配对码/);
  // The code never reaches the log.
  assert.equal(JSON.stringify(fx.log.entries()).includes(CODE), false);
});

test('paired: the list names the session and its page shows the text escaped and redacted', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const list = await request(fx, 'GET', '/', { cookie });
  assert.equal(list.status, 200);
  const id = /href="\/session\?id=([0-9a-f]{20})"/.exec(list.body)?.[1];
  assert.ok(id !== undefined, 'the list links the session');
  const s = await request(fx, 'GET', `/session?id=${id}`, { cookie });
  assert.equal(s.status, 200);
  assert.equal(s.body.includes('<script>alert'), false);
  assert.equal(s.body.includes('<img src=x'), false);
  assert.ok(s.body.includes(escapeHtml(CANARY)));
  assert.equal(s.body.includes(SECRET), false);
  assert.equal((await request(fx, 'GET', `/session?id=${'0'.repeat(20)}`, { cookie })).status, 404);
  assert.equal((await request(fx, 'GET', '/', { cookie: 'orchestra_sid=forged' })).body.includes('G--proj'), false);
  assert.equal((await request(fx, 'POST', '/', { cookie })).status, 405);
});

test('with pairing off there is no code to pair with', async (t) => {
  const fx = await fixture(t, null);
  assert.match((await request(fx, 'GET', '/')).body, /配对已关闭/);
  assert.equal((await pair(fx, CODE)).status, 403);
});

test('pairing rules: void after 5 wrong in a row, expired after 10 minutes, none without a code', () => {
  const p = makePairing(CODE, 0);
  for (let i = 0; i < 4; i++) assert.equal(p.attempt('00000000', 0), 'wrong');
  assert.equal(p.attempt('00000000', 0), 'voided');
  assert.equal(p.attempt(CODE, 0), 'no-code');

  const q = makePairing(CODE, 0);
  assert.equal(q.attempt(CODE, PAIR_TTL_MS + 1), 'expired');
  assert.equal(q.attempt(CODE, PAIR_TTL_MS + 1), 'no-code');

  const r = makePairing(null, 0);
  assert.equal(r.open, false);
  assert.equal(r.attempt(CODE, 0), 'no-code');
});

test('a port someone else holds on ::1 refuses the start', async (t) => {
  const squatter = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    squatter.once('error', () => resolve(false));
    squatter.listen({ port: 0, host: '::1', exclusive: true }, () => resolve(true));
  });
  if (!ok) {
    t.skip('no IPv6 loopback on this machine');
    return;
  }
  t.after(() => new Promise<void>((r) => squatter.close(() => r())));
  const port = (squatter.address() as net.AddressInfo).port;
  const hub = new VirtualClock({ mono: 0, wall: 0 });
  const base = fs.realpathSync.native(withTmp(t));
  await assert.rejects(startPeekServer({
    port, gate: new ReadGate({ roots: [], io: realIo, testDirs: [base] }), roots: [], redact: (s) => s, clock: hub.port(null), log: new Log({ clock: hub.port(null) }), pairingCode: CODE, profile: 'test',
  }), { code: 'EADDRINUSE' });
  // And 127.0.0.1 was given back.
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve());
  });
  await new Promise<void>((r) => probe.close(() => r()));
});
