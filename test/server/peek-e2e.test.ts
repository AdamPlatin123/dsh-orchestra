import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EXIT } from '../../src/runtime/startup.ts';
import { pairBrowser } from '../helpers/pair.ts';
import { runOrchestrad, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { put, withTmp } from '../helpers/tmp.ts';
import { validateStage } from '../../shared/stage-contract.js';
import { validateTower } from '../../shared/tower-contract.js';

// The thin slice end to end: a test-profile orchestrad with --peek-port over synthetic roots, paired
// with the code it prints, serves the page, the tower and a session's full record. This is the path the real profile
// takes on your machine, minus the real roots.

const U1 = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(port: number, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `orchestra.localhost:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a test-profile orchestrad with --peek-port serves both harnesses after pairing', async (t) => {
  const dir = withTmp(t);
  put(path.join(dir, 'roots', 'claude', 'projects', 'G--synthetic-claude', `${U1}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic claude line' }] } })}\n`);
  put(path.join(dir, 'roots', 'dsh', 'sessions', '--G--synthetic-dsh--', U2, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'assistant/message', seq: 1, time: 0, data: { text: 'synthetic dsh line' } })}\n`)));
  const port = await freePort();
  const child = startOrchestrad(t, ['--test-profile', '--test-dir', dir, '--peek-port', String(port)]);
  await waitForLine(child, /^orchestrad: working \(test profile/);
  const at = await waitForLine(child, /^orchestrad: peek page at /);
  assert.equal(at, `orchestrad: peek page at http://orchestra.localhost:${port}/ (read-only; pair with the code above)`);
  const code = /^orchestrad: pairing code (\d{8})$/.exec(child.lines().find((l) => l.startsWith('orchestrad: pairing code')) ?? '')?.[1];
  assert.ok(code !== undefined);

  const { cookie } = await pairBrowser({ port }, code);
  const home = await request(port, 'GET', '/', { cookie });
  assert.equal(home.status, 200);
  assert.match(home.body, /assets\/ui\/home\.js/);
  const old = await request(port, 'GET', '/tower', { cookie });
  assert.deepEqual([old.status, old.headers.location], [301, '/'], 'the old tower page is gone: its bookmark lands on the page');
  const tower = JSON.parse((await request(port, 'GET', '/api/tower', { cookie })).body) as { meta: { profile: string }; projects: { name: string; nodes: { harness: string; session: string | null }[] }[] };
  assert.deepEqual(validateTower(tower).errors, []);
  assert.equal(tower.meta.profile, 'test');
  const roots = tower.projects.flatMap((p) => p.nodes.map((n) => n.harness)).sort();
  assert.deepEqual(roots, ['claude', 'dsh']);
  const ids = tower.projects.flatMap((p) => p.nodes.map((n) => n.session)).filter((s): s is string => s !== null);
  assert.equal(ids.length, 2);
  const pages = await Promise.all(ids.map((id) => request(port, 'GET', `/session?id=${id}`, { cookie })));
  const text = pages.map((p) => p.body).join('\n');
  assert.match(text, /synthetic claude line/);
  assert.match(text, /synthetic dsh line/);

  await child.stop();
});

test('the tower end to end over the stage fixture (the demo data): pair, then the page, /api/tower and /api/peek/stage', async (t) => {
  const dir = withTmp(t);
  writeStageFixture(dir, Date.now());
  const port = await freePort();
  const child = startOrchestrad(t, ['--test-profile', '--test-dir', dir, '--peek-port', String(port)]);
  await waitForLine(child, /^orchestrad: peek page at /);
  const code = /^orchestrad: pairing code (\d{8})$/.exec(child.lines().find((l) => l.startsWith('orchestrad: pairing code')) ?? '')?.[1];
  assert.ok(code !== undefined);
  const { cookie } = await pairBrowser({ port }, code);
  const r = await request(port, 'GET', '/api/peek/stage', { cookie });
  assert.equal(r.status, 200);
  const snap = JSON.parse(r.body) as { profile: string; lanes: { name: string; players: unknown[] }[]; podium: { fermatas: unknown[] } };
  assert.deepEqual(validateStage(snap).errors, []);
  assert.equal(snap.profile, 'test');
  assert.deepEqual(snap.lanes.map((l) => [l.name, l.players.length]), [['shop', 11]], '5 Claude, 3 DSH, 3 Codex');
  assert.equal(snap.podium.fermatas.length, 1);
  assert.equal(r.body.includes(STAGE_CANARY), false);
  const page = await request(port, 'GET', '/', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.body, /assets\/ui\/home\.js/);
  const tw = await request(port, 'GET', '/api/tower', { cookie });
  const tower = JSON.parse(tw.body) as { tally: { waiting: number }; waitingBar: unknown[]; projects: { nodes: unknown[] }[] };
  assert.deepEqual(validateTower(tower).errors, []);
  assert.equal(tower.projects[0]!.nodes.length, 11);
  assert.equal(tower.waitingBar.length, tower.tally.waiting);
  assert.equal(tw.body.includes(STAGE_CANARY), false);
  await child.stop();
});

test('--peek-port is refused with the bad-arguments code when it is no port, or given twice', (t) => {
  const dir = withTmp(t);
  for (const extra of [['--peek-port', '80'], ['--peek-port', 'x'], ['--peek-port', '70000'], ['--peek-port', '7470', '--peek-port', '7471'], ['--peek-port']]) {
    const r = runOrchestrad(['--test-profile', '--test-dir', dir, ...extra], { cwd: dir });
    assert.equal(r.status, EXIT.badArgs, `${extra.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /--peek-port/);
  }
});
