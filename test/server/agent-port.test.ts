import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { HUMAN_VERB_ROUTES } from '../../shared/protocol.js';
import { VirtualClock, makeRealClock, oneShot } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeReadGate, makeWriteFence } from '../../src/fs/node-io.ts';
import type { SpawnGateSpec } from '../../src/os/node-proc.ts';
import { CODEX_EXE_REL, PidLog, SpawnGate } from '../../src/os/spawn.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import type { Requests, RequestsDeps } from '../../src/route/requests.ts';
import { REQUEST_LIMITS, makeRequests } from '../../src/route/requests.ts';
import { AGENT_ROUTES, AGENT_TOKEN_FILE, agentPipeName, matchAgentRoute, startAgentPort } from '../../src/server/agent-port.ts';
import type { AgentPort } from '../../src/server/agent-port.ts';
import { ROUTES } from '../../src/server/routes.ts';
import { endOwnedFor } from '../../src/server/owned-handlers.ts';
import { captureConsole, minimalEnv, runWorkingInProcess } from '../helpers/start.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// seat's agent request port (final.md §5.1; D8: the agent side physically has no allow, deny, dispatch or
// brake; r4 §10.11 item 4: its own route table on a named pipe). The port runs on a real named pipe of
// its own per test, the requests on a virtual clock. Every text is synthetic.

type Fx = { port: AgentPort; token: string; tokenFile: string; requests: Requests; clock: VirtualClock; ended: string[]; judged: string[] };

async function fixture(t: TestContext, over: Partial<RequestsDeps> = {}): Promise<Fx> {
  const dir = withTmp(t);
  const clock = new VirtualClock({ mono: 1000, wall: 1_800_000_000_000 });
  const p = clock.port(null);
  const ended: string[] = [];
  const judged: string[] = [];
  const requests = makeRequests({
    after: oneShot(clock, 'agent-port-test'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => null, endOwned: (id) => { ended.push(id); return true; }, ...over,
  });
  const tokenFile = path.join(dir, AGENT_TOKEN_FILE);
  const started = await startAgentPort({
    pipe: agentPipeName('test', `ut-${crypto.randomBytes(6).toString('hex')}`), tokenFile,
    writeToken: (f, text) => fs.writeFileSync(f, text, { flag: 'wx' }), removeToken: (f) => fs.rmSync(f),
    requests, judgeCwd: (cwd) => { judged.push(cwd); return /\\\.ssh(?:\\|$)/i.test(cwd) ? 'profile-.ssh' : null; }, log: new Log({ clock: p }),
  });
  assert.ok(started.ok, JSON.stringify(started));
  if (!started.ok) throw new Error('no port');
  t.after(() => started.port.close());
  return { port: started.port, token: fs.readFileSync(tokenFile, 'utf8').trim(), tokenFile, requests, clock, ended, judged };
}

type Reply = { status: number; json: any };
function call(pipe: string, method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: pipe, method, path: url, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const auth = (fx: Fx) => ({ authorization: `Bearer ${fx.token}` });
const ASK = { harness: 'codex', text: '修一下登录页的样式', cwd: 'D:\\work\\shop', requester: { kind: 'dsh', sessionId: 'sess-1' } };
const submit = (fx: Fx, body: unknown = ASK) => call(fx.port.pipe, 'POST', '/agent/v1/requests', auth(fx), JSON.stringify(body));

test('the reverse assertion: the agent port has exactly three routes, none of them a human verb, and every UI route answers 404 here even with the token', async (t) => {
  // The table itself: submit, read, withdraw. No allow, deny, brake, dispatch (owned-new) or route.
  assert.deepEqual(AGENT_ROUTES.map((r) => `${r.method} ${r.path}`), ['POST /agent/v1/requests', 'GET /agent/v1/requests/:id', 'POST /agent/v1/requests/:id/withdraw']);
  for (const r of AGENT_ROUTES) assert.ok(!/allow|deny|brake|owned|route|approv|reject|dispatch|unlock/.test(r.path), r.path);
  const fx = await fixture(t);
  // Every route of the page, with and without its :id filled, by its own method: not found on this listener.
  const paths = new Set<string>([...ROUTES.map((r) => `${r.method} ${r.path}`), ...Object.values(HUMAN_VERB_ROUTES).map((p) => `POST ${p}`)]);
  for (const mp of [...paths, 'POST /api/owned/new', 'POST /api/route/suggest', 'POST /api/brake/execute', 'POST /agent/v1/requests/0123456789abcdef0123/allow', 'POST /agent/v1/requests/0123456789abcdef0123/dispatch']) {
    const [method, p] = mp.split(' ') as [string, string];
    const url = p.replace(':id', '0123456789abcdef0123').replace('/*', '/x');
    const r = await call(fx.port.pipe, method, url, auth(fx), method === 'POST' ? JSON.stringify({ actionId: crypto.randomUUID() }) : undefined);
    assert.equal(r.status, 404, `${mp} answers ${r.status}`);
  }
  // Methods and shapes off the table are not found either: a GET of the submit path, a POST of a read, a query on a POST, a bad id.
  for (const [m, u] of [['GET', '/agent/v1/requests'], ['POST', '/agent/v1/requests/0123456789abcdef0123'], ['POST', '/agent/v1/requests?x=1'], ['GET', '/agent/v1/requests/XYZ'], ['DELETE', '/agent/v1/requests/0123456789abcdef0123']] as const) {
    assert.equal((await call(fx.port.pipe, m, u, auth(fx))).status, 404, `${m} ${u}`);
  }
  assert.equal(matchAgentRoute('GET', '/agent/v1/requests/0123456789abcdef0123?wait=25')!.route.path, '/agent/v1/requests/:id');
  assert.equal(matchAgentRoute('GET', '/agent/v1/requests/0123456789abcdef0123#x'), null);
  assert.deepEqual(fx.requests.list(), [], 'nothing reached the store');
});

test('a missing, malformed or wrong token is 401 on each of the three routes; the token is 32 random bytes and never in a reply', async (t) => {
  const fx = await fixture(t);
  assert.match(fx.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(fx.token, 'base64url').length, 32);
  const other = crypto.randomBytes(32).toString('base64url');
  const id = '0123456789abcdef0123';
  for (const h of [{}, { authorization: fx.token }, { authorization: `Bearer ${other}` }, { authorization: `Basic ${fx.token}` }, { authorization: `Bearer ${fx.token}x` }]) {
    assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', h, JSON.stringify(ASK))).status, 401, JSON.stringify(h));
    assert.equal((await call(fx.port.pipe, 'GET', `/agent/v1/requests/${id}`, h)).status, 401);
    assert.equal((await call(fx.port.pipe, 'POST', `/agent/v1/requests/${id}/withdraw`, h)).status, 401);
  }
  assert.deepEqual(fx.requests.list(), []);
  const ok = await submit(fx);
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.json).includes(fx.token));
});

test('submit, read, withdraw: a request waits as pending (its expiry said), the body is checked like an owned message, a protected cwd is refused', async (t) => {
  const fx = await fixture(t);
  const r = await submit(fx, { ...ASK, label: '登录页' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['requestId', 'state', 'expiresAt']);
  assert.equal(r.json.state, 'pending');
  assert.equal(r.json.expiresAt, fx.clock.wall + REQUEST_LIMITS.ttlMs);
  assert.deepEqual(fx.judged, ['D:\\work\\shop'], 'the cwd went through the spawn gate\'s table');
  const g = await call(fx.port.pipe, 'GET', `/agent/v1/requests/${r.json.requestId}`, auth(fx));
  assert.deepEqual(g.json, { requestId: r.json.requestId, state: 'pending', ownedId: null, output: null, truncated: false, why: null, expiresAt: r.json.expiresAt });
  assert.equal(fx.requests.get(r.json.requestId)!.label, '登录页');
  // The owned message's own checks, and the shape.
  assert.deepEqual([(await submit(fx, { ...ASK, text: '/model x' })).json], [{ error: 'slash-command' }]);
  assert.deepEqual([(await submit(fx, { ...ASK, text: '长'.repeat(700) })).status], [422]);
  assert.deepEqual([(await submit(fx, { ...ASK, text: '   ' })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, harness: 'dsh' })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, requester: { kind: 'dsh', sessionId: 'a b' } })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, extra: 1 })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, ownedId: 'x' })).status], [400], 'no field names a session to start');
  assert.deepEqual((await submit(fx, { ...ASK, cwd: 'C:\\Users\\x\\.ssh' })).json, { error: 'cwd-forbidden' });
  assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', { ...auth(fx), 'content-type': 'text/plain' }, 'x')).status, 400);
  assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', auth(fx), JSON.stringify({ ...ASK, text: 'x'.repeat(20_000) }))).status, 413);
  assert.equal((await call(fx.port.pipe, 'GET', '/agent/v1/requests/ffffffffffffffffffff', auth(fx))).status, 404);
  assert.equal((await call(fx.port.pipe, 'GET', `/agent/v1/requests/${r.json.requestId}?wait=26x`, auth(fx))).status, 400);
  // Withdraw: gone from the cards; a second withdraw answers the same, a no-op.
  const w = await call(fx.port.pipe, 'POST', `/agent/v1/requests/${r.json.requestId}/withdraw`, auth(fx));
  assert.deepEqual([w.status, w.json.state, w.json.why, w.json.expiresAt], [200, 'withdrawn', 'requester-withdrew', null]);
  assert.equal((await call(fx.port.pipe, 'POST', `/agent/v1/requests/${r.json.requestId}/withdraw`, auth(fx))).json.state, 'withdrawn');
  assert.deepEqual(fx.ended, [], 'it never ran: nothing to end');
});

test('expiry on the test clock: a pending request nobody answers is expired (D8: a timeout is a refusal); a long poll answers at the move', async (t) => {
  const fx = await fixture(t);
  const id = (await submit(fx)).json.requestId as string;
  const polled = call(fx.port.pipe, 'GET', `/agent/v1/requests/${id}?wait=25`, auth(fx));
  // The poll is out; the clock moves past the request's time while it waits.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  fx.clock.advanceBy(REQUEST_LIMITS.ttlMs);
  const p = await polled;
  assert.deepEqual([p.status, p.json.state, p.json.why, p.json.ownedId], [200, 'expired', 'expired', null]);
  // A rejection by the person wakes a poll too (the reject itself is only on the paired page).
  const id2 = (await submit(fx)).json.requestId as string;
  const polled2 = call(fx.port.pipe, 'GET', `/agent/v1/requests/${id2}?wait=25`, auth(fx));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  fx.requests.reject(id2);
  assert.deepEqual([(await polled2).json.state, (await polled2).json.why], ['rejected', 'you-rejected']);
});

test('withdraw of a dispatched request calls the owned-end stop order (end, requester-withdrew), never the brake', async (t) => {
  // A stand-in session that counts what was asked of it, behind the same endOwnedFor working.ts hands the store.
  const asked: string[] = [];
  const OID = 'a'.repeat(20);
  const sess = { ownedId: OID, state: 'running', endReason: null, end: (why: string) => { asked.push(`end:${why}`); sess.state = 'ended'; return { denied: 0 }; }, brake: async () => { asked.push('brake'); return { ok: true }; } };
  const codex = { get: (id: string) => (id === OID ? sess : null) };
  const fx = await fixture(t, { endOwned: (id) => endOwnedFor({ codex: codex as never, claude: null }, id), observe: () => ({ state: 'running', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }) });
  const id = (await submit(fx)).json.requestId as string;
  assert.equal(fx.requests.bind(id, OID), true);
  const w = await call(fx.port.pipe, 'POST', `/agent/v1/requests/${id}/withdraw`, auth(fx));
  assert.deepEqual([w.json.state, w.json.ownedId, w.json.why], ['withdrawn', OID, 'requester-withdrew']);
  assert.deepEqual(asked, ['end:requester-withdrew'], 'the normal stop order, once; no brake');
  await call(fx.port.pipe, 'POST', `/agent/v1/requests/${id}/withdraw`, auth(fx));
  assert.deepEqual(asked, ['end:requester-withdrew'], 'a second withdraw ends nothing');
  assert.equal(endOwnedFor({ codex: codex as never, claude: null }, OID), false, 'an ended session is not ended again');
});

test('the token file: written at start, gone at stop, a new token at each start; an old token is refused', async (t) => {
  const dir = withTmp(t);
  const tokenFile = path.join(dir, AGENT_TOKEN_FILE);
  const clock = makeRealClock();
  const p = clock.port(null);
  const pipe = agentPipeName('test', `ut-${crypto.randomBytes(6).toString('hex')}`);
  const start = async () => {
    const requests = makeRequests({ after: oneShot(clock, 'agent-port-rot'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), redact: (text) => ({ text, count: 0 }), observe: () => null, endOwned: () => false });
    // The real clock's expiry timers would hold the process: each store is closed when the test ends.
    t.after(() => requests.close());
    const s = await startAgentPort({ pipe, tokenFile, writeToken: (f, text) => fs.writeFileSync(f, text, { flag: 'wx' }), removeToken: (f) => fs.rmSync(f), requests, judgeCwd: () => null, log: new Log({ clock: p }) });
    assert.ok(s.ok, JSON.stringify(s));
    return (s as { ok: true; port: AgentPort }).port;
  };
  const one = await start();
  const t1 = fs.readFileSync(tokenFile, 'utf8').trim();
  // A second listener on the same pipe is refused, and writes no token.
  const idle = makeRequests({ after: oneShot(clock, 'agent-port-busy'), nowMono: () => 0, nowWall: () => 0, redact: (text) => ({ text, count: 0 }), observe: () => null, endOwned: () => false });
  t.after(() => idle.close());
  const busy = await startAgentPort({ pipe, tokenFile: path.join(dir, 'other.token'), writeToken: (f, text) => fs.writeFileSync(f, text), removeToken: () => {}, requests: idle, judgeCwd: () => null, log: new Log({ clock: p }) });
  assert.deepEqual(busy.ok ? 'on' : busy.why, 'pipe-busy');
  assert.equal(fs.existsSync(path.join(dir, 'other.token')), false);
  await one.close();
  assert.equal(fs.existsSync(tokenFile), false, 'the token file goes when the port closes');
  const two = await start();
  t.after(() => two.close());
  const t2 = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.notEqual(t2, t1, 'a new token at each start');
  assert.equal((await call(pipe, 'POST', '/agent/v1/requests', { authorization: `Bearer ${t1}` }, JSON.stringify(ASK))).status, 401, 'the old token is refused');
  assert.equal((await call(pipe, 'POST', '/agent/v1/requests', { authorization: `Bearer ${t2}` }, JSON.stringify(ASK))).status, 200);
  assert.equal(agentPipeName('real'), '\\\\.\\pipe\\orchestra-agent-real');
  assert.match(agentPipeName('test', 'Seat Lab!'), /^\\\\\.\\pipe\\orchestra-agent-test-[0-9a-f]{16}$/, 'a name outside the grammar is hashed');
});

test('the composition root: --owned --agent-port with the page opens the pipe and the token file in ORCHESTRA_HOME; the stop removes it; without the page it stays off and says why', async (t) => {
  const base = withTmp(t);
  const appData = path.join(fs.realpathSync.native(base), 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  const name = `seat-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.join(base, `orchestra-test-${name}`));
  const testDir = fs.realpathSync.native(path.join(base, `orchestra-test-${name}`));
  const home = path.join(testDir, 'orchestra');
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const clock = makeRealClock();
  const run = async (peek: boolean) => {
    const con = captureConsole();
    const spy = fakeSpawn(() => ({ hang: true }));
    const o = await runWorkingInProcess({
      profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log: new Log({ clock: clock.port(null) }), pidLog: new PidLog(), console: con.port,
      pid: process.pid, clock, tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p),
      makeReadGate, makeWriteFence, makeDbOpener, env: { ...minimalEnv(), APPDATA: appData },
      makeSpawnGate: (spec: SpawnGateSpec) => new SpawnGate({ ...spec, backend: spy.backend }),
      owned: true, agentPort: true, ...(peek ? { peekPort: 0 } : {}),
    });
    assert.equal(o.mode, 'working', JSON.stringify(o));
    return { o: o as Extract<typeof o, { mode: 'working' }>, out: con.out };
  };
  const a = await run(true);
  const tokenFile = path.join(home, AGENT_TOKEN_FILE);
  try {
    assert.deepEqual(a.o.agentPort, { on: true, pipe: `\\\\.\\pipe\\orchestra-agent-test-${name}`, tokenFile });
    assert.match(fs.readFileSync(tokenFile, 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
    assert.ok(a.out.some((l) => l.startsWith(`orchestrad: agent request port on \\\\.\\pipe\\orchestra-agent-test-${name}`)), a.out.join('\n'));
    assert.ok(!a.out.some((l) => l.includes(fs.readFileSync(tokenFile, 'utf8').trim())), 'the token is never on the console');
    const tok = fs.readFileSync(tokenFile, 'utf8').trim();
    const r = await call(a.o.agentPort.on ? a.o.agentPort.pipe : '', 'POST', '/agent/v1/requests', { authorization: `Bearer ${tok}` }, JSON.stringify({ ...ASK, cwd: home }));
    assert.deepEqual(r.json, { error: 'cwd-forbidden' }, 'the data dir is in the spawn gate\'s table');
  } finally {
    await a.o.stop();
  }
  assert.equal(fs.existsSync(tokenFile), false, 'the stop removed the token file');
  const b = await run(false);
  try {
    assert.deepEqual(b.o.agentPort, { on: false, why: 'no-page', detail: null });
    assert.ok(b.out.some((l) => l.includes('the agent request port is off: no-page')));
    assert.equal(fs.existsSync(tokenFile), false);
  } finally {
    await b.o.stop();
  }
});
