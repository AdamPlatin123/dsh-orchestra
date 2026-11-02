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
import { PEEK_HOST, STAGE_CSP, startPeekServer } from '../../src/server/http.ts';
import type { PeekServer } from '../../src/server/http.ts';
import type { UiAsset } from '../../src/server/ui-assets.ts';
import { validateSession, validateStage } from '../../shared/stage-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { withTmp } from '../helpers/tmp.ts';

// The stage routes of the peek server over the stage fixture, in process, on a free loopback port,
// and GET /api/tower (orchestra app plan §1) beside them, behind the same cookie and CSP.

const CODE = '12345678';
const BASE = 1_793_560_000_000;

const asset = (type: string, body: string): UiAsset => ({ type, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`, hex: Buffer.from(body).toString('hex') });
const PAGE: Record<string, UiAsset> = {
  'ui/stage.html': asset('text/html; charset=utf-8', '<!doctype html><title>stage</title><script type="module" src="/assets/ui/app.js"></script>'),
  'ui/app.js': asset('text/javascript; charset=utf-8', 'export const app = 1;\n'),
  'shared/frozen.js': asset('text/javascript; charset=utf-8', 'export const f = 1;\n'),
};

type Fx = { server: PeekServer; host: string; origin: string; dir: string };

async function fixture(t: TestContext, assets: Record<string, UiAsset> = PAGE): Promise<Fx> {
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
    clock, log: new Log({ clock }), pairingCode: CODE, profile: 'test', assets,
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
  return String(r.headers['set-cookie']).split(';')[0]!;
}

test('unpaired: the stage page and its JSON are 403; the embedded modules need no cookie', async (t) => {
  const fx = await fixture(t);
  for (const p of ['/stage', '/api/peek/stage', `/api/peek/session?id=${'0'.repeat(20)}`]) assert.equal((await request(fx, 'GET', p)).status, 403, p);
  const js = await request(fx, 'GET', '/assets/ui/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.body, 'export const app = 1;\n');
  assert.equal((await request(fx, 'POST', '/assets/ui/app.js')).status, 405);
});

test('paired: the snapshot is JSON under the stage CSP, never cached, valid against the contract', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/api/peek/stage', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], STAGE_CSP);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.ok(Buffer.byteLength(r.body) <= 256 * 1024);
  const snap: unknown = JSON.parse(r.body);
  assert.deepEqual(validateStage(snap).errors, []);
  assert.equal(r.body.includes(STAGE_CANARY), false);
  assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
  // The old pages keep their scriptless CSP and link the stage.
  const home = await request(fx, 'GET', '/', { cookie });
  assert.match(String(home.headers['content-security-policy']), /^default-src 'none'; style-src 'self'; img-src 'none';/);
  assert.equal(home.body.includes('<script'), false);
  assert.match(home.body, /href="\/stage"/);
});

test('session detail: 400 on a malformed id, 404 on an unknown one, else the contract shape without a path', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  for (const id of ['', 'x', '0'.repeat(19), `${'0'.repeat(20)}0`, '..%5C..%5Cx', 'A'.repeat(20)]) {
    const r = await request(fx, 'GET', `/api/peek/session?id=${id}`, { cookie });
    assert.equal(r.status, 400, id);
    assert.equal(r.headers['content-security-policy'], STAGE_CSP);
  }
  assert.equal((await request(fx, 'GET', `/api/peek/session?id=${'0'.repeat(20)}`, { cookie })).status, 404);
  const snap = JSON.parse((await request(fx, 'GET', '/api/peek/stage', { cookie })).body) as { lanes: { players: { session: string }[] }[] };
  for (const p of snap.lanes[0]!.players) {
    const r = await request(fx, 'GET', `/api/peek/session?id=${p.session}`, { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(validateSession(JSON.parse(r.body)).errors, []);
    assert.equal(r.body.includes(STAGE_CANARY), false);
    assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
  }
});

test('the stage page and its assets: stage CSP, ETag with no-cache, 304 on a match, 404 off the whitelist', async (t) => {
  const fx = await fixture(t);
  const cookie = await paired(fx);
  const page = await request(fx, 'GET', '/stage', { cookie });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], STAGE_CSP);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  const js = await request(fx, 'GET', '/assets/ui/app.js');
  assert.equal(js.headers['content-security-policy'], STAGE_CSP);
  assert.equal(js.headers['cache-control'], 'no-cache');
  assert.equal(js.headers.etag, PAGE['ui/app.js']!.etag);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  const again = await request(fx, 'GET', '/assets/ui/app.js', { 'if-none-match': PAGE['ui/app.js']!.etag });
  assert.deepEqual([again.status, again.body], [304, '']);
  assert.equal((await request(fx, 'GET', '/assets/shared/frozen.js')).status, 200);
  // Only .js and .css by exact name: the page itself is /stage, behind the cookie.
  for (const p of ['/assets/ui/stage.html', '/assets/ui/missing.js', '/assets/ui/APP.js', '/assets/ui/..%2Fui/app.js', '/assets/ui%2Fapp.js', '/assets/src/server/http.ts', '/assets/', '/assets/ui/app.js/x']) {
    const r = await request(fx, 'GET', p, { cookie });
    assert.equal(r.status, 404, p);
  }
});

test('without an embedded page /stage answers 503 ui-not-embedded', async (t) => {
  const fx = await fixture(t, {});
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/stage', { cookie });
  assert.deepEqual([r.status, r.body], [503, 'ui-not-embedded\n']);
  assert.equal(r.headers['content-security-policy'], STAGE_CSP);
});

test('GET /api/tower: 403 unpaired (and with a cookie the server never issued), 200 paired, valid, three harnesses', async (t) => {
  const fx = await fixture(t);
  assert.equal((await request(fx, 'GET', '/api/tower')).status, 403);
  assert.equal((await request(fx, 'GET', '/api/tower', { cookie: 'orchestra_sid=forged' })).status, 403);
  const cookie = await paired(fx);
  const r = await request(fx, 'GET', '/api/tower', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['content-security-policy'], STAGE_CSP);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  const tower = JSON.parse(r.body) as { projects: { nodes: { harness: string }[] }[] };
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual([...new Set(tower.projects.flatMap((p) => p.nodes.map((n) => n.harness)))].sort(), ['claude', 'codex', 'dsh']);
  assert.equal(r.body.includes(STAGE_CANARY), false);
  assert.equal(r.body.includes(JSON.stringify(fx.dir).slice(1, -1)), false);
  // The tower is GET only, and the stage route stays beside it for now.
  assert.equal((await request(fx, 'POST', '/api/tower', { cookie, origin: fx.origin })).status, 405);
  assert.equal((await request(fx, 'GET', '/api/peek/stage', { cookie })).status, 200);
});
