// node --test "integrations/dsh-seat/test/*.test.mjs"  (also run by the repo suite through test/integrations/dsh-seat.test.ts)
// A fake agent port covers the four results (completed / refusal / error / aborted), the withdraw rules
// and the guard; one test runs the real pipe client against a node:http server on a named pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  apply, makeSeatProvider, makePipePort, pluginManagerGuard, requesterId, promptText, configProblem, headUtf8,
  NO_START_CAPABILITIES, DIAG, inject, name,
} from '../index.js';

const RID = 'a1b2c3d4e5f60718293a';

/** A scripted port: `script` answers each call (method, path) in turn; every call is recorded. */
function fakePort(script) {
  const calls = [];
  return {
    calls,
    async call(method, pathname, body, opts = {}) {
      calls.push({ method, pathname, body });
      const step = script(method, pathname, body, calls.length, opts);
      return typeof step === 'function' ? step(opts) : step;
    },
  };
}
const ok = (json) => ({ status: 200, json });
const req = (over = {}) => ({
  prompt: [{ type: 'text', text: 'create hello.txt containing hi' }],
  parent: { id: 'sess-123' },
  cwd: 'C:\\work',
  label: 'hello file',
  signal: new AbortController().signal,
  ...over,
});
const withdraws = (port) => port.calls.filter((c) => c.pathname.endsWith('/withdraw')).length;
/** A long poll that waits until its signal aborts, then rejects as node:http does. */
const hang = (opts) => new Promise((_, reject) => {
  opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
});

test('plugin shape: name, inject, capabilities none, no parent context', () => {
  assert.equal(name, 'orchestra-seat');
  assert.deepEqual(inject, ['subagents', 'tools']);
  const p = makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: fakePort(() => ok({})) });
  assert.equal(p.name, 'orchestra-codex');
  assert.deepEqual(p.capabilities, NO_START_CAPABILITIES);
  assert.equal(p.inheritsParentContext, false);
  assert.equal(typeof p.start, 'function');
  assert.equal(p.prepareContinuable, undefined);
});

test('completed: pending -> dispatched -> done maps to completed with a provenance line; dispose after it withdraws nothing', async () => {
  const states = ['pending', 'dispatched', 'running', 'done'];
  let i = 0;
  const port = fakePort((method, p) => {
    if (method === 'POST' && p === '/agent/v1/requests') return ok({ requestId: RID, state: 'pending', expiresAt: 1 });
    if (method === 'GET') {
      const s = states[i++];
      return ok({ requestId: RID, state: s, ownedId: s === 'pending' ? null : 'own-9', output: s === 'done' ? 'Created hello.txt with hi' : null, truncated: false, why: null });
    }
    throw new Error(`unexpected ${method} ${p}`);
  });
  const p = makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port });
  const run = await p.start(req());
  assert.equal(run.id, `orchestra-${RID}`);
  const r = await run.result;
  assert.equal(r.stopReason, 'completed');
  assert.equal(r.output.length, 1);
  assert.match(r.output[0].text, /Created hello\.txt with hi/);
  assert.match(r.output[0].text, /own-9/);
  assert.match(r.output[0].text, /未复核/);
  assert.doesNotMatch(r.output[0].text, /完成[^判]/, 'T2: the result never says 完成 (only 不是完成判定)');
  await run.dispose();
  await run.dispose();
  assert.equal(withdraws(port), 0, 'a request already over is not withdrawn');
  const submit = port.calls[0];
  assert.deepEqual(submit.body, { harness: 'codex', text: 'create hello.txt containing hi', cwd: 'C:\\work', label: 'hello file', requester: { kind: 'dsh', sessionId: 'sess-123' } });
  assert.match(port.calls[1].pathname, /^\/agent\/v1\/requests\/a1b2c3d4e5f60718293a\?wait=\d+$/);
});

test('completed: a cut output is marked truncated', async () => {
  const port = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : ok({ state: 'done', ownedId: 'o', output: 'x'.repeat(10), truncated: true })));
  const run = await makeSeatProvider({ providerName: 'orchestra-claude', harness: 'claude', port }).start(req());
  const r = await run.result;
  assert.equal(r.stopReason, 'completed');
  assert.match(r.output[0].text, /已截断/);
  assert.match(r.output[0].text, /Claude Code/);
  assert.equal(port.calls[0].body.harness, 'claude');
});

for (const [state, diag] of [['rejected', DIAG.rejected], ['expired', DIAG.expired]]) {
  test(`refusal: ${state} maps to refusal with a diagnostic saying a person did not dispatch it`, async () => {
    const port = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : ok({ state, ownedId: null, output: null, truncated: false, why: state })));
    const run = await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req());
    const r = await run.result;
    assert.equal(r.stopReason, 'refusal');
    assert.deepEqual(r.output, []);
    assert.equal(r.diagnostic, diag);
    assert.match(r.diagnostic, /没有派出/);
    await run.dispose();
    assert.equal(withdraws(port), 0);
  });
}

test('refusal: the seat timeout withdraws the still-pending request once and refuses', async () => {
  let t = 0;
  const port = fakePort((m, p) => {
    if (m === 'POST' && p === '/agent/v1/requests') return ok({ requestId: RID, state: 'pending' });
    if (m === 'GET') {
      t += 30_000; // each long poll "takes" 30 s
      return ok({ state: 'pending', ownedId: null, output: null, truncated: false, why: null });
    }
    if (p.endsWith('/withdraw')) return ok({ state: 'withdrawn', why: 'requester-withdrew' });
    throw new Error('unexpected');
  });
  const run = await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port, requestTimeoutMs: 60_000, now: () => t }).start(req());
  const r = await run.result;
  assert.equal(r.stopReason, 'refusal');
  assert.match(r.diagnostic, /60 秒内没有人/);
  assert.equal(withdraws(port), 1);
  await run.dispose();
  assert.equal(withdraws(port), 1, 'withdraw only once');
  const waits = port.calls.filter((c) => c.method === 'GET').map((c) => Number(/wait=(\d+)/.exec(c.pathname)[1]));
  assert.ok(waits.every((w) => w >= 1 && w <= 25), `waits ${waits}`);
});

test('error: failed maps to error naming the orchestrad code', async () => {
  const port = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : ok({ state: 'failed', ownedId: 'o', output: null, truncated: false, why: 'session-host-exited' })));
  const r = await (await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req())).result;
  assert.equal(r.stopReason, 'error');
  assert.match(r.diagnostic, /session-host-exited/);
});

test('error: an unknown request (orchestrad restarted) and a 401 are errors; a failing port gives up after three tries', async () => {
  const unknown = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : { status: 404, json: { error: 'request-unknown' } }));
  assert.equal((await (await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: unknown }).start(req())).result).diagnostic, DIAG.unknown);
  const token = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : { status: 401, json: { error: 'not-authorized' } }));
  assert.equal((await (await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: token }).start(req())).result).stopReason, 'error');
  const down = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))));
  const r = await (await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: down, wait: async () => {} }).start(req())).result;
  assert.equal(r.stopReason, 'error');
  assert.match(r.diagnostic, /ENOENT/);
  assert.equal(down.calls.filter((c) => c.method === 'GET').length, 3);
});

test('error: a failing submit rejects start() (nothing published); diagnostics never carry a token', async () => {
  const refused = fakePort(() => ({ status: 429, json: { error: 'rate' } }));
  await assert.rejects(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: refused }).start(req()), /HTTP 429 rate/);
  const down = fakePort(() => () => Promise.reject(Object.assign(new Error('x'), { code: 'token-missing' })));
  await assert.rejects(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: down }).start(req()), /token-missing/);
  const empty = fakePort(() => ok({}));
  await assert.rejects(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: empty }).start(req({ prompt: [] })), /no task text/);
  await assert.rejects(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port: empty }).start(req({ prompt: [{ type: 'text', text: 'x'.repeat(2049) }] })), /2048/);
  assert.equal(empty.calls.length, 0, 'an oversize or empty task never reaches orchestrad');
});

test('aborted: the parent signal ends the long poll, withdraws once, settles aborted; dispose adds no second withdraw', async () => {
  const ac = new AbortController();
  const port = fakePort((m, p) => {
    if (m === 'POST' && p === '/agent/v1/requests') return ok({ requestId: RID, state: 'pending' });
    if (m === 'GET') return hang;
    if (p.endsWith('/withdraw')) return ok({ state: 'withdrawn', why: 'requester-withdrew' });
    throw new Error('unexpected');
  });
  const run = await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req({ signal: ac.signal }));
  await new Promise((r) => setImmediate(r));
  ac.abort({ kind: 'parent' });
  const r = await run.result;
  assert.equal(r.stopReason, 'aborted');
  assert.match(r.diagnostic, /撤回/);
  assert.match(r.diagnostic, /不是刹车/);
  await run.dispose();
  assert.equal(withdraws(port), 1);
});

test('aborted: an abort before start() rejects it without a request', async () => {
  const ac = new AbortController();
  ac.abort(new Error('early'));
  const port = fakePort(() => ok({ requestId: RID, state: 'pending' }));
  await assert.rejects(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req({ signal: ac.signal })), /early/);
  assert.equal(port.calls.length, 0);
});

test('dispose before any end withdraws exactly once, settles the result aborted, and never throws even when withdraw fails', async () => {
  const port = fakePort((m, p) => {
    if (m === 'POST' && p === '/agent/v1/requests') return ok({ requestId: RID, state: 'pending' });
    if (m === 'GET') return hang;
    return () => Promise.reject(new Error('pipe gone'));
  });
  const run = await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req());
  await new Promise((r) => setImmediate(r));
  await Promise.all([run.dispose(), run.dispose()]);
  await run.dispose();
  assert.equal(withdraws(port), 1);
  assert.equal((await run.result).stopReason, 'aborted');
});

test('withdrawn by someone else (not this run) is aborted with its own diagnostic', async () => {
  const port = fakePort((m) => (m === 'POST' ? ok({ requestId: RID, state: 'pending' }) : ok({ state: 'withdrawn', why: 'requester-withdrew' })));
  const r = await (await makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port }).start(req())).result;
  assert.equal(r.stopReason, 'aborted');
  assert.equal(r.diagnostic, DIAG.withdrawnElsewhere);
});

test('requesterId holds the card id to orchestrad shape; promptText joins text blocks only', () => {
  assert.equal(requesterId({ id: '0193-abc' }), '0193-abc');
  assert.equal(requesterId({ id: '  bad id/x' }), 'bad_id_x');
  assert.equal(requesterId({}), 'unknown');
  assert.equal(requesterId(undefined), 'unknown');
  assert.equal(promptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\n\nb');
  assert.equal(headUtf8('中文字', 4), '中');
});

test('configProblem: an agent pipe and an absolute token file are required', () => {
  assert.equal(configProblem({ pipe: '\\\\.\\pipe\\orchestra-agent-test-x', tokenFile: 'C:\\t\\agent-port.token' }), null);
  assert.match(configProblem({ pipe: '\\\\.\\pipe\\other', tokenFile: 'C:\\t' }), /pipe/);
  assert.match(configProblem({ pipe: '\\\\.\\pipe\\orchestra-agent-real' }), /tokenFile/);
  assert.match(configProblem({ pipe: '\\\\.\\pipe\\orchestra-agent-real', tokenFile: 'rel\\t' }), /tokenFile/);
  assert.match(configProblem({ pipe: '\\\\.\\pipe\\orchestra-agent-real', tokenFile: 'C:\\t', requestTimeoutMs: 10 }), /requestTimeoutMs/);
});

test('apply: guard first, then two providers; the guard refuses plugin_manager only; no approval listener', () => {
  const guards = [];
  const providers = [];
  const listened = [];
  const warns = [];
  const ctx = {
    logger: { warn: (m) => warns.push(m), info: () => {} },
    tools: { guard: (g) => guards.push(g) },
    subagents: { registerProvider: (p) => providers.push(p) },
    on: (ev) => listened.push(ev),
  };
  apply(ctx, { pipe: '\\\\.\\pipe\\orchestra-agent-test-x', tokenFile: 'C:\\t\\agent-port.token', requestTimeoutMs: 60_000 });
  assert.equal(guards.length, 1);
  assert.deepEqual(providers.map((p) => p.name), ['orchestra-codex', 'orchestra-claude']);
  assert.equal(typeof guards[0]({ name: 'plugin_manager' }), 'string');
  assert.equal(guards[0]({ name: 'subagent_codex_governed' }), undefined);
  assert.equal(guards[0]({ name: 'bash' }), undefined);
  assert.equal(pluginManagerGuard(undefined), undefined);
  assert.deepEqual(listened, [], 'the seat listens to nothing (no approval/request)');
  assert.deepEqual(warns, []);
});

test('apply: probes first; no registerProvider or a bad config registers no provider (the guard still stands); no guard registers nothing', () => {
  const run = (ctx, config) => {
    const warns = [];
    apply({ logger: { warn: (m) => warns.push(m), info: () => {} }, ...ctx }, config);
    return warns;
  };
  const g1 = [];
  assert.match(run({ tools: { guard: (g) => g1.push(g) }, subagents: {} }, {})[0], /registerProvider/);
  assert.equal(g1.length, 1);
  const g2 = [];
  const p2 = [];
  assert.match(run({ tools: { guard: (g) => g2.push(g) }, subagents: { registerProvider: (p) => p2.push(p) } }, { pipe: '\\\\.\\pipe\\orchestra-agent-real' })[0], /tokenFile/);
  assert.equal(p2.length, 0);
  const p3 = [];
  assert.match(run({ tools: {}, subagents: { registerProvider: (p) => p3.push(p) } }, {})[0], /guard/);
  assert.equal(p3.length, 0);
});

test('the pipe client: node:http over a named pipe, Bearer token read fresh for every request', async (t) => {
  if (process.platform !== 'win32') return t.skip('named pipes in this form are Windows only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-pipe-'));
  const tokenFile = path.join(dir, 'agent-port.token');
  const pipe = `\\\\.\\pipe\\orchestra-agent-seattest-${crypto.randomBytes(6).toString('hex')}`;
  const tok = () => crypto.randomBytes(32).toString('base64url');
  let current = tok();
  fs.writeFileSync(tokenFile, `${current}\n`);
  const seen = [];
  const web = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      seen.push({ method: rq.method, url: rq.url, auth: rq.headers.authorization, type: rq.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8') });
      const good = rq.headers.authorization === `Bearer ${current}`;
      rs.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(good ? { requestId: RID, state: 'pending' } : { error: 'not-authorized' }));
    });
  });
  const server = net.createServer((s) => web.emit('connection', s));
  await new Promise((r) => server.listen(pipe, r));
  try {
    const port = makePipePort({ pipe, tokenFile });
    const a = await port.call('POST', '/agent/v1/requests', { harness: 'codex' }, { timeoutMs: 5000 });
    assert.equal(a.status, 200);
    assert.equal(a.json.requestId, RID);
    assert.equal(seen[0].auth, `Bearer ${current}`);
    assert.match(seen[0].type, /^application\/json/);
    assert.deepEqual(JSON.parse(seen[0].body), { harness: 'codex' });
    // orchestrad restarted: a new token; the next request reads it.
    current = tok();
    fs.writeFileSync(tokenFile, `${current}\n`);
    const b = await port.call('POST', `/agent/v1/requests/${RID}/withdraw`, undefined, { timeoutMs: 5000 });
    assert.equal(b.status, 200);
    assert.equal(seen[1].auth, `Bearer ${current}`);
    assert.equal(seen[1].body, '');
    // No token file: a coded error, and the message names no token.
    fs.rmSync(tokenFile);
    await assert.rejects(port.call('GET', `/agent/v1/requests/${RID}?wait=1`), (e) => e.code === 'token-missing' && !e.message.includes(current));
    // Nobody on the pipe.
    const none = makePipePort({ pipe: `${pipe}-none`, tokenFile: path.join(dir, 't2') });
    fs.writeFileSync(path.join(dir, 't2'), tok());
    await assert.rejects(none.call('GET', `/agent/v1/requests/${RID}`, undefined, { timeoutMs: 2000 }), (e) => e.code === 'ENOENT');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
