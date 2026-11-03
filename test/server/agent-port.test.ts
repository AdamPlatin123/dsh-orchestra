import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
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
import { AGENT_AUTH, AGENT_PORT_LIMITS, AGENT_ROUTES, AGENT_TOKEN_FILE, agentPipeName, agentReplyMac, agentRequestMac, matchAgentRoute, startAgentPort } from '../../src/server/agent-port.ts';
import type { AgentPort, AgentPortDeps } from '../../src/server/agent-port.ts';
import { ROUTES } from '../../src/server/routes.ts';
import { endOwnedFor } from '../../src/server/owned-handlers.ts';
import { captureConsole, minimalEnv, runWorkingInProcess } from '../helpers/start.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// seat's agent request port (final.md §5.1; D8: the agent side physically has no allow, deny, dispatch or
// brake; r4 §10.11 item 4: its own route table on a named pipe). The port runs on a real named pipe of
// its own per test, the requests and the port's deadlines on a virtual clock. Every text is synthetic.

type Fx = { port: AgentPort; token: string; tokenFile: string; requests: Requests; clock: VirtualClock; ended: string[]; judged: string[]; logged: string[] };

async function fixture(t: TestContext, over: Partial<RequestsDeps> = {}, portOver: Partial<AgentPortDeps> = {}): Promise<Fx> {
  const dir = withTmp(t);
  const clock = new VirtualClock({ mono: 1000, wall: 1_800_000_000_000 });
  const p = clock.port(null);
  const ended: string[] = [];
  const judged: string[] = [];
  const logged: string[] = [];
  const requests = makeRequests({
    after: oneShot(clock, 'agent-port-test'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => null, endOwned: (id) => { ended.push(id); return true; }, ...over,
  });
  const tokenFile = path.join(dir, AGENT_TOKEN_FILE);
  const started = await startAgentPort({
    after: oneShot(clock, 'agent-port-deadline'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(),
    pipe: agentPipeName('test', `ut-${crypto.randomBytes(6).toString('hex')}`), tokenFile,
    writeToken: (f, text) => fs.writeFileSync(f, text, { flag: 'wx' }), removeToken: (f) => fs.rmSync(f),
    requests, judgeCwd: (cwd) => { judged.push(cwd); return /\\\.ssh(?:\\|$)/i.test(cwd) ? 'profile-.ssh' : null; }, log: new Log({ clock: p, sink: (l) => logged.push(l) }),
    ...portOver,
  });
  assert.ok(started.ok, JSON.stringify(started));
  if (!started.ok) throw new Error('no port');
  t.after(() => started.port.close());
  return { port: started.port, token: fs.readFileSync(tokenFile, 'utf8').trim(), tokenFile, requests, clock, ended, judged, logged };
}

type Reply = { status: number; json: any; raw: string; proof: string | undefined };
function call(pipe: string, method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: pipe, method, path: url, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, agent: false }, (res) => {
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
        const proof = res.headers[AGENT_AUTH.proofHeader];
        resolve({ status: res.statusCode!, json, raw: text, proof: typeof proof === 'string' ? proof : undefined });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The seat's headers for one request: a fresh nonce, the wall time, the MAC under the token (the token itself never sent). */
function proofHeaders(token: string, wall: number, method: string, url: string, body = '', nonce = crypto.randomBytes(16).toString('base64url')): Record<string, string> {
  const time = String(wall);
  return { authorization: `${AGENT_AUTH.scheme} ${agentRequestMac(token, nonce, time, method, url, body)}`, [AGENT_AUTH.nonceHeader]: nonce, [AGENT_AUTH.timeHeader]: time };
}

/** A request as the seat sends it; the reply's proof is checked against the nonce. */
async function signed(pipe: string, token: string, wall: number, method: string, url: string, body?: string): Promise<Reply> {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const r = await call(pipe, method, url, proofHeaders(token, wall, method, url, body ?? '', nonce), body);
  if (r.status !== 401) assert.equal(r.proof, agentReplyMac(token, nonce, r.status, r.raw), `${method} ${url}: the reply proves the token`);
  return r;
}
const req = (fx: Fx, method: string, url: string, body?: string) => signed(fx.port.pipe, fx.token, fx.clock.wall, method, url, body);
const ASK = { harness: 'codex', text: '修一下登录页的样式', cwd: 'D:\\work\\shop', requester: { kind: 'dsh', sessionId: 'sess-1' } };
const submit = (fx: Fx, body: unknown = ASK) => req(fx, 'POST', '/agent/v1/requests', JSON.stringify(body));
const withdraw = (fx: Fx, id: string, key: string) => req(fx, 'POST', `/agent/v1/requests/${id}/withdraw`, JSON.stringify({ withdrawKey: key }));
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

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
    const body = method === 'POST' ? JSON.stringify({ actionId: crypto.randomUUID() }) : undefined;
    const r = await call(fx.port.pipe, method, url, proofHeaders(fx.token, fx.clock.wall, method, url, body ?? ''), body);
    assert.equal(r.status, 404, `${mp} answers ${r.status}`);
  }
  // Methods and shapes off the table are not found either: a GET of the submit path, a POST of a read, a query on a POST, a bad id.
  for (const [m, u] of [['GET', '/agent/v1/requests'], ['POST', '/agent/v1/requests/0123456789abcdef0123'], ['POST', '/agent/v1/requests?x=1'], ['GET', '/agent/v1/requests/XYZ'], ['DELETE', '/agent/v1/requests/0123456789abcdef0123']] as const) {
    assert.equal((await call(fx.port.pipe, m, u, proofHeaders(fx.token, fx.clock.wall, m, u))).status, 404, `${m} ${u}`);
  }
  assert.equal(matchAgentRoute('GET', '/agent/v1/requests/0123456789abcdef0123?wait=25')!.route.path, '/agent/v1/requests/:id');
  assert.equal(matchAgentRoute('GET', '/agent/v1/requests/0123456789abcdef0123#x'), null);
  assert.deepEqual(fx.requests.list(), [], 'nothing reached the store');
});

test('the token never crosses the pipe: a request proves it by HMAC (fresh nonce, time near orchestrad\'s, MAC over method, path and body); anything else is 401, and a replay too', async (t) => {
  const fx = await fixture(t);
  assert.match(fx.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(fx.token, 'base64url').length, 32);
  const other = crypto.randomBytes(32).toString('base64url');
  const id = '0123456789abcdef0123';
  const body = JSON.stringify(ASK);
  const w = fx.clock.wall;
  const bad: Record<string, string>[] = [
    {}, { authorization: `Bearer ${fx.token}` }, { authorization: fx.token },
    proofHeaders(other, w, 'POST', '/agent/v1/requests', body),
    proofHeaders(fx.token, w, 'POST', '/agent/v1/requests', `${body} `), // the MAC is over another body
    proofHeaders(fx.token, w, 'GET', '/agent/v1/requests', body), // another method
    proofHeaders(fx.token, w - AGENT_PORT_LIMITS.skewMs - 1, 'POST', '/agent/v1/requests', body), // too old
    proofHeaders(fx.token, w + AGENT_PORT_LIMITS.skewMs + 1, 'POST', '/agent/v1/requests', body), // from the future
    { ...proofHeaders(fx.token, w, 'POST', '/agent/v1/requests', body), [AGENT_AUTH.nonceHeader]: 'short' },
  ];
  for (const h of bad) {
    const r = await call(fx.port.pipe, 'POST', '/agent/v1/requests', h, body);
    assert.deepEqual([r.status, r.proof], [401, undefined], JSON.stringify(h));
  }
  for (const h of [{}, { authorization: `Bearer ${fx.token}` }]) {
    assert.equal((await call(fx.port.pipe, 'GET', `/agent/v1/requests/${id}`, h)).status, 401);
    assert.equal((await call(fx.port.pipe, 'POST', `/agent/v1/requests/${id}/withdraw`, h, '{}')).status, 401);
  }
  assert.deepEqual(fx.requests.list(), []);
  // The good one, once; the same headers again are a replay.
  const h = proofHeaders(fx.token, w, 'POST', '/agent/v1/requests', body);
  const ok = await call(fx.port.pipe, 'POST', '/agent/v1/requests', h, body);
  assert.equal(ok.status, 200);
  assert.ok(!Object.values(h).some((v) => v.includes(fx.token)), 'no header carries the token');
  assert.ok(!ok.raw.includes(fx.token), 'nor the reply');
  assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', h, body)).status, 401, 'a replayed nonce is refused');
  assert.equal(fx.requests.list().length, 1);
  // The refusals were logged once, counted, never one line each (an unauthorized flood cannot grow the log).
  const lines = fx.logged.filter((l) => l.includes('agent-port-refused'));
  assert.equal(lines.length, 1, lines.join(''));
  assert.ok(!fx.logged.some((l) => l.includes(fx.token)), 'the token is never logged');
});

test('every authenticated reply proves the token (x-orchestra-proof over the nonce, status and body): a process that only grabbed the pipe cannot forge one', async (t) => {
  const fx = await fixture(t);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const body = JSON.stringify(ASK);
  const r = await call(fx.port.pipe, 'POST', '/agent/v1/requests', proofHeaders(fx.token, fx.clock.wall, 'POST', '/agent/v1/requests', body, nonce), body);
  assert.equal(r.status, 200);
  assert.equal(r.proof, agentReplyMac(fx.token, nonce, 200, r.raw));
  assert.notEqual(r.proof, agentReplyMac(crypto.randomBytes(32).toString('base64url'), nonce, 200, r.raw), 'another token proves nothing');
  assert.notEqual(r.proof, agentReplyMac(fx.token, nonce, 200, r.raw.replace('pending', 'done')), 'nor another body');
  // A refusal of a request that proved the token is proven too (404 request-unknown, 400 bad-request).
  await req(fx, 'GET', '/agent/v1/requests/ffffffffffffffffffff');
  await req(fx, 'POST', '/agent/v1/requests', JSON.stringify({ ...ASK, extra: 1 }));
});

test('submit, read, withdraw: a request waits as pending (its expiry said), the body is checked like an owned message, a protected cwd is refused; only the submitter\'s key withdraws', async (t) => {
  const fx = await fixture(t);
  const r = await submit(fx, { ...ASK, label: '登录页' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ['requestId', 'state', 'expiresAt', 'withdrawKey']);
  assert.match(r.json.withdrawKey, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.json.state, 'pending');
  assert.equal(r.json.expiresAt, fx.clock.wall + REQUEST_LIMITS.ttlMs);
  assert.deepEqual(fx.judged, ['D:\\work\\shop'], 'the cwd went through the spawn gate\'s table');
  const g = await req(fx, 'GET', `/agent/v1/requests/${r.json.requestId}`);
  assert.deepEqual(g.json, { requestId: r.json.requestId, state: 'pending', ownedId: null, output: null, truncated: false, cuts: [], why: null, expiresAt: r.json.expiresAt });
  assert.equal(fx.requests.get(r.json.requestId)!.label, '登录页');
  assert.ok(!JSON.stringify(fx.requests.list()).includes(r.json.withdrawKey), 'the key is never listed');
  assert.ok(!fx.logged.some((l) => l.includes(r.json.withdrawKey)), 'nor logged');
  // The owned message's own checks, and the shape.
  assert.deepEqual([(await submit(fx, { ...ASK, text: '/model x' })).json], [{ error: 'slash-command' }]);
  assert.deepEqual([(await submit(fx, { ...ASK, text: '长'.repeat(700) })).status], [422]);
  assert.deepEqual([(await submit(fx, { ...ASK, text: '   ' })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, harness: 'dsh' })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, requester: { kind: 'dsh', sessionId: 'a b' } })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, extra: 1 })).status], [400]);
  assert.deepEqual([(await submit(fx, { ...ASK, ownedId: 'x' })).status], [400], 'no field names a session to start');
  assert.deepEqual((await submit(fx, { ...ASK, cwd: 'C:\\Users\\x\\.ssh' })).json, { error: 'cwd-forbidden' });
  // A text that fits as sent but not once its invisible characters are written out is refused, never cut (A16).
  const zw = `${'a'.repeat(1500)}${'\u200b'.repeat(150)}`;
  assert.ok(Buffer.byteLength(zw) <= REQUEST_LIMITS.textBytes);
  assert.deepEqual((await submit(fx, { ...ASK, text: zw })).json, { error: 'text-too-long' });
  const plain = JSON.stringify(ASK);
  assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', { ...proofHeaders(fx.token, fx.clock.wall, 'POST', '/agent/v1/requests', 'x'), 'content-type': 'text/plain' }, 'x')).status, 400);
  assert.equal((await call(fx.port.pipe, 'POST', '/agent/v1/requests', proofHeaders(fx.token, fx.clock.wall, 'POST', '/agent/v1/requests', plain), JSON.stringify({ ...ASK, text: 'x'.repeat(20_000) }))).status, 413);
  assert.equal((await req(fx, 'GET', '/agent/v1/requests/ffffffffffffffffffff')).status, 404);
  assert.equal((await req(fx, 'GET', `/agent/v1/requests/${r.json.requestId}?wait=26x`)).status, 400);
  // Withdraw: no key or a malformed one is 400, someone else's key 403 (the request stays), the submitter's 200.
  assert.equal((await req(fx, 'POST', `/agent/v1/requests/${r.json.requestId}/withdraw`)).status, 400);
  assert.equal((await req(fx, 'POST', `/agent/v1/requests/${r.json.requestId}/withdraw`, JSON.stringify({ withdrawKey: 'x' }))).status, 400);
  const theirs = await withdraw(fx, r.json.requestId, crypto.randomBytes(16).toString('base64url'));
  assert.deepEqual([theirs.status, theirs.json], [403, { error: 'not-requester' }]);
  assert.equal(fx.requests.get(r.json.requestId)!.state, 'pending');
  const w = await withdraw(fx, r.json.requestId, r.json.withdrawKey);
  assert.deepEqual([w.status, w.json.state, w.json.why, w.json.expiresAt], [200, 'withdrawn', 'requester-withdrew', null]);
  assert.equal((await withdraw(fx, r.json.requestId, r.json.withdrawKey)).json.state, 'withdrawn', 'a second withdraw is a no-op');
  assert.deepEqual(fx.ended, [], 'it never ran: nothing to end');
  // A requester that names no session is taken; the card says so (dsh, the page says 未知).
  const anon = await submit(fx, { ...ASK, requester: { kind: 'dsh', sessionId: null } });
  assert.equal(anon.status, 200);
  assert.deepEqual(fx.requests.get(anon.json.requestId)!.requester, { kind: 'dsh', sessionId: null });
});

test('expiry on the test clock: a pending request nobody answers is expired (D8: a timeout is a refusal); a long poll answers at the move', async (t) => {
  const fx = await fixture(t);
  const id = (await submit(fx)).json.requestId as string;
  // Close to its time a poll goes out (a poll lasts 25 s at most: the socket's own deadline is requestMs);
  // the clock moves past the request's time while it waits.
  fx.clock.advanceBy(REQUEST_LIMITS.ttlMs - 5_000);
  const polled = req(fx, 'GET', `/agent/v1/requests/${id}?wait=25`);
  await ticks();
  fx.clock.advanceBy(5_000);
  const p = await polled;
  assert.deepEqual([p.status, p.json.state, p.json.why, p.json.ownedId], [200, 'expired', 'expired', null]);
  // A rejection by the person wakes a poll too (the reject itself is only on the paired page).
  const id2 = (await submit(fx)).json.requestId as string;
  const polled2 = req(fx, 'GET', `/agent/v1/requests/${id2}?wait=25`);
  await ticks();
  fx.requests.reject(id2);
  assert.deepEqual([(await polled2).json.state, (await polled2).json.why], ['rejected', 'you-rejected']);
});

test('withdraw of a dispatched request calls the owned-end stop order (end, requester-withdrew), never the brake; a done reply that went out marks the request fetched', async (t) => {
  // A stand-in session that counts what was asked of it, behind the same endOwnedFor working.ts hands the store.
  const asked: string[] = [];
  const OID = 'a'.repeat(20);
  const sess = { ownedId: OID, state: 'running', endReason: null, end: (why: string) => { asked.push(`end:${why}`); sess.state = 'ended'; return { denied: 0 }; }, brake: async () => { asked.push('brake'); return { ok: true }; } };
  const codex = { get: (id: string) => (id === OID ? sess : null) };
  let events: any[] = [];
  const fx = await fixture(t, { endOwned: (id) => endOwnedFor({ codex: codex as never, claude: null }, id), observe: () => ({ state: 'running', endReason: null, feed: { since: () => ({ clipped: false, events }) } }) });
  const sub = (await submit(fx)).json;
  assert.equal(fx.requests.bind(sub.requestId, OID), true);
  const w = await withdraw(fx, sub.requestId, sub.withdrawKey);
  assert.deepEqual([w.json.state, w.json.ownedId, w.json.why], ['withdrawn', OID, 'requester-withdrew']);
  assert.deepEqual(asked, ['end:requester-withdrew'], 'the normal stop order, once; no brake');
  await withdraw(fx, sub.requestId, sub.withdrawKey);
  assert.deepEqual(asked, ['end:requester-withdrew'], 'a second withdraw ends nothing');
  assert.equal(endOwnedFor({ codex: codex as never, claude: null }, OID), false, 'an ended session is not ended again');
  // fetched: false at done, true once the port handed a done reply to the pipe.
  const two = (await submit(fx)).json;
  fx.requests.bind(two.requestId, 'b'.repeat(20));
  events = [
    { seq: 1, kind: 'lifecycle', state: 'turn-started' },
    { seq: 2, kind: 'text', ref: 'm1', text: '好了', state: 'final', live: false },
    { seq: 3, kind: 'lifecycle', state: 'turn-ended' },
  ];
  assert.deepEqual([fx.requests.get(two.requestId)!.state, fx.requests.get(two.requestId)!.fetched], ['done', false]);
  const got = await req(fx, 'GET', `/agent/v1/requests/${two.requestId}`);
  assert.deepEqual([got.json.state, got.json.output, got.json.cuts], ['done', '好了', []]);
  await ticks();
  assert.equal(fx.requests.get(two.requestId)!.fetched, true);
});

test('the stop order: the requests close, then the port lets each long poll hand "failed, daemon-stop" to the pipe before the sockets go', async (t) => {
  const fx = await fixture(t);
  const id = (await submit(fx)).json.requestId as string;
  const polled = req(fx, 'GET', `/agent/v1/requests/${id}?wait=25`);
  await ticks();
  // working.ts stop(): requests.close(); await agentPort.close(); with nothing between them.
  fx.requests.close();
  await fx.port.close();
  const p = await polled;
  assert.deepEqual([p.status, p.json.state, p.json.why], [200, 'failed', 'daemon-stop']);
  assert.equal(fs.existsSync(fx.tokenFile), false);
});

test('idle sockets cannot hold the port: a socket that sends no request head is dropped after headerMs, one that stalls a request after requestMs; the port holds a long poll for every kept request and still takes a withdraw', async (t) => {
  const fx = await fixture(t);
  assert.ok(AGENT_PORT_LIMITS.sockets >= REQUEST_LIMITS.kept + 2, 'every kept request may hold a long poll, and a submit and a withdraw still fit');
  const open = () => new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(fx.port.pipe, () => resolve(s));
    s.on('error', reject);
  });
  const closed = (s: net.Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once('close', () => r())));
  const idle = await Promise.all(Array.from({ length: AGENT_PORT_LIMITS.sockets }, open));
  await ticks();
  fx.clock.advanceBy(AGENT_PORT_LIMITS.headerMs);
  await Promise.all(idle.map(closed));
  // A head sent, the body never finished: dropped after requestMs.
  const stall = await open();
  stall.write(`POST /agent/v1/requests HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`);
  await ticks();
  fx.clock.advanceBy(AGENT_PORT_LIMITS.headerMs);
  await ticks();
  assert.equal(stall.destroyed, false, 'a request under way has requestMs, not headerMs');
  fx.clock.advanceBy(AGENT_PORT_LIMITS.requestMs);
  await closed(stall);
  // Long polls for many requests at once (the per-requester and per-minute limits are the store's; here each
  // asks under its own id, minutes apart), and a withdraw on top still lands.
  const subs: { requestId: string; withdrawKey: string }[] = [];
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % REQUEST_LIMITS.perWindow === 0) fx.clock.advanceBy(REQUEST_LIMITS.windowMs);
    const r = await submit(fx, { ...ASK, requester: { kind: 'dsh', sessionId: `s-${i}` } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    subs.push(r.json);
  }
  const polls = subs.map((s) => req(fx, 'GET', `/agent/v1/requests/${s.requestId}?wait=25`));
  await ticks(40);
  const w = await withdraw(fx, subs[0]!.requestId, subs[0]!.withdrawKey);
  assert.deepEqual([w.status, w.json.state], [200, 'withdrawn']);
  assert.equal((await polls[0])!.json.state, 'withdrawn');
  fx.requests.close();
  await Promise.all(polls);
});

test('the token file: written at start, gone at stop, a new token at each start; an old token is refused', async (t) => {
  const dir = withTmp(t);
  const tokenFile = path.join(dir, AGENT_TOKEN_FILE);
  const clock = makeRealClock();
  const p = clock.port(null);
  const pipe = agentPipeName('test', `ut-${crypto.randomBytes(6).toString('hex')}`);
  const base = { after: oneShot(clock, 'agent-port-rot-deadline'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), judgeCwd: () => null, log: new Log({ clock: p }) };
  const start = async () => {
    const requests = makeRequests({ after: oneShot(clock, 'agent-port-rot'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), redact: (text) => ({ text, count: 0 }), observe: () => null, endOwned: () => false });
    // The real clock's expiry timers would hold the process: each store is closed when the test ends.
    t.after(() => requests.close());
    const s = await startAgentPort({ ...base, pipe, tokenFile, writeToken: (f, text) => fs.writeFileSync(f, text, { flag: 'wx' }), removeToken: (f) => fs.rmSync(f), requests });
    assert.ok(s.ok, JSON.stringify(s));
    return (s as { ok: true; port: AgentPort }).port;
  };
  const one = await start();
  const t1 = fs.readFileSync(tokenFile, 'utf8').trim();
  // A second listener on the same pipe is refused, and writes no token.
  const idle = makeRequests({ after: oneShot(clock, 'agent-port-busy'), nowMono: () => 0, nowWall: () => 0, redact: (text) => ({ text, count: 0 }), observe: () => null, endOwned: () => false });
  t.after(() => idle.close());
  const busy = await startAgentPort({ ...base, pipe, tokenFile: path.join(dir, 'other.token'), writeToken: (f, text) => fs.writeFileSync(f, text), removeToken: () => {}, requests: idle });
  assert.deepEqual(busy.ok ? 'on' : busy.why, 'pipe-busy');
  assert.equal(fs.existsSync(path.join(dir, 'other.token')), false);
  await one.close();
  assert.equal(fs.existsSync(tokenFile), false, 'the token file goes when the port closes');
  const two = await start();
  t.after(() => two.close());
  const t2 = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.notEqual(t2, t1, 'a new token at each start');
  const body = JSON.stringify(ASK);
  assert.equal((await call(pipe, 'POST', '/agent/v1/requests', proofHeaders(t1, p.nowWall(), 'POST', '/agent/v1/requests', body), body)).status, 401, 'the old token is refused');
  assert.equal((await signed(pipe, t2, p.nowWall(), 'POST', '/agent/v1/requests', body)).status, 200);
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
    const r = await signed(a.o.agentPort.on ? a.o.agentPort.pipe : '', tok, clock.port(null).nowWall(), 'POST', '/agent/v1/requests', JSON.stringify({ ...ASK, cwd: home }));
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

test('project roots: the port asks where the session would run (placeCwd) and the request keeps it; without placeCwd it runs in the work dir (no-roots)', async (t) => {
  const placed: string[] = [];
  const fx = await fixture(t, {}, {
    placeCwd: (cwd) => {
      placed.push(cwd);
      return cwd === 'D:\\work\\shop' ? { runIn: 'D:\\work\\shop', why: null } : { runIn: null, why: 'outside-roots' };
    },
  });
  const a = await submit(fx, ASK);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual(Object.keys(a.json), ['requestId', 'state', 'expiresAt', 'withdrawKey'], 'the requester is told nothing more');
  const ra = fx.requests.get(a.json.requestId)!;
  assert.deepEqual([ra.runIn, ra.runInWhy], ['D:\\work\\shop', null]);
  const b = await submit(fx, { ...ASK, cwd: 'D:\\elsewhere' });
  const rb = fx.requests.get(b.json.requestId)!;
  assert.deepEqual([rb.runIn, rb.runInWhy], [null, 'outside-roots']);
  assert.deepEqual(placed, ['D:\\work\\shop', 'D:\\elsewhere']);
  // A protected cwd is refused before anyone asks where it would run.
  assert.deepEqual((await submit(fx, { ...ASK, cwd: 'C:\\Users\\x\\.ssh' })).json, { error: 'cwd-forbidden' });
  assert.equal(placed.length, 2);
  const plain = await fixture(t);
  const c = await submit(plain, ASK);
  const rc = plain.requests.get(c.json.requestId)!;
  assert.deepEqual([rc.runIn, rc.runInWhy], [null, 'no-roots']);
});
