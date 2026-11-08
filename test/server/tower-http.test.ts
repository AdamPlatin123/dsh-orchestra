import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { PEEK_HOST, UI_CSP, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import type { UiAsset } from '../../src/server/ui-assets.ts';
import type { OwnedSeats } from '../../src/sources/tower.ts';
import { UI_ASSETS } from '../../src/server/ui-assets.ts';
import { validateSession, validateStage } from '../../shared/stage-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { withTmp } from '../helpers/tmp.ts';

// The page's routes of the peek server over the stage fixture, in process, on a free loopback
// port (orchestra app plan §5): once paired, / serves the page, /api/tower and /api/peek/session its
// JSON, /assets/* its files; /stage and /tower (the old pages) redirect to /. /api/peek/stage stays for tools.

const CODE = '12345678';
const BASE = 1_793_560_000_000;

const asset = (type: string, body: string): UiAsset => ({ type, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`, hex: Buffer.from(body).toString('hex') });
const PAGE: Record<string, UiAsset> = {
  'ui/home.html': asset('text/html; charset=utf-8', '<!doctype html><title>home</title><script type="module" src="/assets/ui/home.js"></script>'),
  'ui/home.js': asset('text/javascript; charset=utf-8', 'export const home = 1;\n'),
  'shared/frozen.js': asset('text/javascript; charset=utf-8', 'export const f = 1;\n'),
};

type Fx = { server: PeekServer; host: string; origin: string; dir: string };

async function fixture(t: TestContext, assets: Record<string, UiAsset> = PAGE, ownedSeats?: OwnedSeats): Promise<Fx> {
  const dir = fs.realpathSync.native(withTmp(t));
  writeStageFixture(dir, BASE);
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    return { kind, path: p, real: p };
  });
  const clock = new VirtualClock({ mono: 1000, wall: BASE + 30_000 }).port(null);
  const redactor = makeRedactor({ env: {} });
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots, io: realIo, testDirs: [dir] }), roots, redact: (text) => redactor.redact({ text }).text,
    clock, log: new Log({ clock }), pairingCode: CODE, profile: 'test', assets, ...(ownedSeats === undefined ? {} : { ownedSeats }),
  });
  t.after(() => server.close());
  const host = `${PEEK_HOST}:${server.port}`;
  return { server, host, origin: `http://${host}`, dir };
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

async function paired(fx: Fx): Promise<string> {
  const r = await request(fx, 'POST', '/pair', { origin: fx.origin, 'content-type': 'application/x-www-form-urlencoded' }, `code=${CODE}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  return String(r.headers['set-cookie']).split(';')[0]!;
}

const SCRIPTLESS = /^default-src 'none'; style-src 'self'; img-src 'none';/;

test('unpaired: / is the pairing form, the JSON and the full record are 403; the embedded modules need no cookie', async (t) => {
  const fx = await fixture(t);
  const r = await request(fx, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<form method="post" action="\/pair">/);
  assert.equal(r.body.includes('<script'), false);
  assert.match(String(r.headers['content-security-policy']), SCRIPTLESS);
  for (const p of ['/api/tower', '/api/peek/stage', `/api/peek/session?id=${'0'.repeat(20)}`, `/session?id=${'0'.repeat(20)}`]) assert.equal((await request(fx, 'GET', p)).status, 403, p);
  const js = await request(fx, 'GET', '/assets/ui/home.js');
  assert.equal(js.status, 200);
  assert.equal(js.body, 'export const home = 1;\n');
  assert.equal((await request(fx, 'POST', '/assets/ui/home.js')).status, 405);
});

test('paired: the stage snapshot the tower is built from is JSON under the UI CSP, never cached, valid', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/api/peek/stage', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], UI_CSP);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.ok(Buffer.byteLength(r.body) <= 256 * 1024);
  const snap: unknown = JSON.parse(r.body);
  assert.deepEqual(validateStage(snap).errors, []);
  assert.equal(r.body.includes(STAGE_CANARY), false);
  assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
});

test('session detail: 400 on a malformed id, 404 on an unknown one, else the contract shape without a path', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  for (const id of ['', 'x', '0'.repeat(19), `${'0'.repeat(20)}0`, '..%5C..%5Cx', 'A'.repeat(20)]) {
    const r = await request(fx, 'GET', `/api/peek/session?id=${id}`, { cookie });
    assert.equal(r.status, 400, id);
    assert.equal(r.headers['content-security-policy'], UI_CSP);
  }
  assert.equal((await request(fx, 'GET', `/api/peek/session?id=${'0'.repeat(20)}`, { cookie })).status, 404);
  const tower = JSON.parse((await request(fx, 'GET', '/api/tower', { cookie })).body) as { projects: { nodes: { session: string | null }[] }[] };
  const ids = tower.projects.flatMap((p) => p.nodes.map((n) => n.session)).filter((s): s is string => s !== null);
  assert.ok(ids.length >= 8);
  for (const id of ids) {
    const r = await request(fx, 'GET', `/api/peek/session?id=${id}`, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(validateSession(JSON.parse(r.body)).errors, []);
    assert.equal(r.body.includes(STAGE_CANARY), false);
    assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
  }
});

test('the page and its assets: UI CSP, ETag with no-cache, 304 on a match, 404 off the whitelist', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const page = await request(fx, 'GET', '/', { cookie });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], UI_CSP);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.body, Buffer.from(PAGE['ui/home.html']!.hex, 'hex').toString('utf8'));
  const js = await request(fx, 'GET', '/assets/ui/home.js');
  assert.equal(js.headers['content-security-policy'], UI_CSP);
  assert.equal(js.headers['cache-control'], 'no-cache');
  assert.equal(js.headers.etag, PAGE['ui/home.js']!.etag);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  const again = await request(fx, 'GET', '/assets/ui/home.js', { 'if-none-match': PAGE['ui/home.js']!.etag });
  assert.deepEqual([again.status, again.body], [304, '']);
  assert.equal((await request(fx, 'GET', '/assets/shared/frozen.js')).status, 200);
  // Only .js and .css by exact name: the page itself is /, behind the cookie; the old page's files are gone.
  for (const p of ['/assets/ui/tower.html', '/assets/ui/home.html', '/assets/ui/app.js', '/assets/ui/missing.js', '/assets/ui/HOME.js', '/assets/ui/..%2Fui/home.js', '/assets/ui%2Fhome.js', '/assets/src/server/http.ts', '/assets/', '/assets/ui/home.js/x']) {
    const r = await request(fx, 'GET', p, { cookie });
    assert.equal(r.status, 404, p);
  }
});

test('the real embedded page: / serves ui/home.html, every file it loads is there under the UI CSP, the old page\'s are not', async (t) => {
  const fx = await fixture(t, UI_ASSETS);
  const cookie = await paired(fx);
  const home = await request(fx, 'GET', '/', { cookie });
  assert.equal(home.status, 200);
  assert.match(home.body, /<script type="module" src="\/assets\/ui\/home\.js"><\/script>/);
  assert.equal(home.body.includes('/tower'), false, 'no link to the old page');
  for (const name of ['ui/tower.html', 'ui/tower.css', 'ui/app.js']) assert.equal(Object.hasOwn(UI_ASSETS, name), false, name);
  assert.equal((await request(fx, 'GET', '/assets/ui/app.js')).status, 404);
  assert.deepEqual([(await request(fx, 'GET', '/tower', { cookie })).status], [301]);
  for (const name of Object.keys(UI_ASSETS).filter((n) => !n.endsWith('.html'))) {
    const r = await request(fx, 'GET', `/assets/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-security-policy'], UI_CSP, name);
  }
});

test('without an embedded page / answers 503 ui-not-embedded', async (t) => {
  const fx = await fixture(t, {});
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/', { cookie });
  assert.deepEqual([r.status, r.body], [503, 'ui-not-embedded\n']);
  assert.equal(r.headers['content-security-policy'], UI_CSP);
});

test('the old stage and tower pages are gone (the tower 2026-11-08): /stage and /tower redirect to /, paired or not, and only for GET', async (t) => {
  const fx = await fixture(t);
  for (const cookie of [null, await paired(fx)]) {
    for (const p of ['/stage', '/tower']) {
      const r = await request(fx, 'GET', p, cookie === null ? {} : { cookie });
      assert.equal(r.status, 301, p);
      assert.equal(r.headers.location, '/', p);
      assert.equal(r.body.includes('<script'), false, p);
    }
  }
  // A query does not make it a page again.
  assert.equal((await request(fx, 'GET', '/tower?x=1')).status, 301);
  for (const p of ['/stage', '/tower']) assert.equal((await request(fx, 'POST', p, { origin: fx.origin })).status, 405, p);
});

test('the full record of a session (/session) keeps the scriptless CSP and leads back to the page', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const tower = JSON.parse((await request(fx, 'GET', '/api/tower', { cookie })).body) as { projects: { nodes: { session: string | null }[] }[] };
  const id = tower.projects[0]!.nodes.find((n) => n.session !== null)!.session!;
  const r = await request(fx, 'GET', `/session?id=${id}`, { cookie });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-security-policy']), SCRIPTLESS);
  assert.equal(r.body.includes('<script'), false);
  assert.match(r.body, /<a href="\/">/);
  assert.equal(r.body.includes(STAGE_CANARY), false);
});

test('GET /api/tower: 403 unpaired (and with a cookie the server never issued), 200 paired, valid, three harnesses', async (t) => {
  const fx = await fixture(t);
  assert.equal((await request(fx, 'GET', '/api/tower')).status, 403);
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie: 'orchestra_sid=forged' })).status, 403);
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/api/tower', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], UI_CSP);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  const tower = JSON.parse(r.body) as { projects: { nodes: { harness: string }[] }[] };
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual([...new Set(tower.projects.flatMap((p) => p.nodes.map((n) => n.harness)))].sort(), ['claude', 'codex', 'dsh']);
  assert.equal(r.body.includes(STAGE_CANARY), false);
  assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
  // The tower is GET only; the stage snapshot it is built from still answers, for tools.
  assert.equal((await request(fx, 'POST', '/api/tower', { cookie, origin: fx.origin })).status, 405);
  assert.equal((await request(fx, 'GET', '/api/peek/stage', { cookie })).status, 200);
});

test('GET /api/tower holds each snapshot to the contract: one that breaks it is 500, never sent to the page', async (t) => {
  // An owned seat whose deadline is no integer makes a wait the contract refuses (the page no longer
  // loads the validator: the daemon is where the contract is held, as for the owned routes' replies).
  const seat = { ownedId: 'a'.repeat(20), harness: 'codex' as const, title: 'x', state: 'idle' as const, endReason: null, lastAt: null, waiting: { kind: 'approval' as const, deadline: 1.5, title: 'x' } };
  let seats = [seat];
  const fx = await fixture(t, PAGE, { seats: () => seats, nowWall: () => BASE });
  const cookie = await paired(fx);
  const bad = await request(fx, 'GET', '/api/tower', { cookie });
  assert.equal(bad.status, 500);
  assert.equal(bad.body.includes('"projects"'), false);
  seats = [{ ...seat, waiting: { ...seat.waiting, deadline: BASE + 60_000 } }];
  const good = await request(fx, 'GET', '/api/tower', { cookie });
  assert.equal(good.status, 200);
  assert.deepEqual(validateTower(JSON.parse(good.body)).errors, []);
});
