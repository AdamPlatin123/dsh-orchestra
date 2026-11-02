import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import { RpcError, makeRpcClient } from '../../src/owned/codex-rpc.ts';

// The stdio JSON-RPC client on its own, over an in-memory pipe: lines split anywhere, bounds, bad
// lines, id matching, and every waiting request rejected when the child goes.

function memPipe() {
  const out: ((c: Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const errors: ((code: string) => void)[] = [];
  const written: string[] = [];
  let stopped = 0;
  const pipe: ChildPipe = {
    pid: 1,
    write: (d) => {
      written.push(d);
    },
    onStdout: (cb) => {
      out.push(cb);
    },
    onStderr: () => {},
    onClose: (cb) => {
      closes.push(cb);
    },
    onError: (cb) => {
      errors.push(cb);
    },
    stop: () => {
      stopped++;
    },
  };
  return {
    pipe,
    written,
    stopped: () => stopped,
    feed: (s: string | Buffer) => out.forEach((cb) => cb(typeof s === 'string' ? Buffer.from(s, 'utf8') : s)),
    close: (code: number | null) => closes.forEach((cb) => cb(code, null)),
    fail: (code: string) => errors.forEach((cb) => cb(code)),
    sent: () => written.map((w) => JSON.parse(w) as Record<string, unknown>),
  };
}

test('requests are numbered and matched by id, in any order; one JSON object per line, no jsonrpc member', async () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe);
  const a = rpc.request('initialize', { clientInfo: { name: 'x' } });
  const b = rpc.request('thread/start', { cwd: 'C:\\w' });
  assert.deepEqual(m.sent(), [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } }, { id: 2, method: 'thread/start', params: { cwd: 'C:\\w' } }]);
  assert.ok(m.written.every((w) => w.endsWith('\n') && w.indexOf('\n') === w.length - 1));
  m.feed('{"id":2,"result":{"thread":{"id":"t"}}}\n{"id":1,"res');
  m.feed('ult":{"userAgent":"u"}}\r\n');
  assert.deepEqual(await b, { thread: { id: 't' } });
  assert.deepEqual(await a, { userAgent: 'u' });
  assert.equal(rpc.waiting(), 0);
  assert.equal(rpc.notify('initialized'), true);
  assert.deepEqual(m.sent().at(-1), { method: 'initialized' });
});

test('an error response rejects with RpcError remote and its code', async () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe);
  const p = rpc.request('turn/steer', {});
  m.feed('{"id":1,"error":{"code":-32600,"message":"no active turn"}}\n');
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.reason === 'remote' && e.rpcCode === -32600 && /no active turn/.test(e.message));
});

test('notifications and server requests reach their listeners; answers echo the server\'s id, a string id included', () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe);
  const notes: [string, unknown][] = [];
  const asks: [unknown, string, unknown][] = [];
  rpc.onNotification((method, params) => notes.push([method, params]));
  rpc.onRequest((id, method, params) => asks.push([id, method, params]));
  rpc.onNotification(() => {
    throw new Error('a listener that throws');
  });
  m.feed('{"method":"turn/started","params":{"turn":{"id":"t1"}}}\n{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{"command":"ls"}}\n{"id":7,"method":"x"}\n');
  assert.deepEqual(notes, [['turn/started', { turn: { id: 't1' } }]]);
  assert.deepEqual(asks, [['srv-1', 'item/commandExecution/requestApproval', { command: 'ls' }], [7, 'x', undefined]]);
  rpc.respond('srv-1', { decision: 'decline' });
  rpc.respondError(7, -32601, 'no');
  assert.deepEqual(m.sent(), [{ id: 'srv-1', result: { decision: 'decline' } }, { id: 7, error: { code: -32601, message: 'no' } }]);
});

test('bad lines are dropped and counted; a line past the bound is dropped whole, however it is split, and the next line is read', () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe, { lineMaxBytes: 64 });
  const notes: string[] = [];
  rpc.onNotification((method) => notes.push(method));
  m.feed('not json\n[1]\n"text"\nnull\n{"id":1}\n{"method":7}\n{"id":{"x":1},"result":1}\n\n   \n');
  m.feed(Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]));
  m.feed(`{"method":"long","params":"${'a'.repeat(40)}`);
  m.feed(`${'b'.repeat(40)}"}\n{"method":"after"}\n`);
  m.feed('{"id":99,"result":{}}\n');
  assert.deepEqual(rpc.stats(), { badLines: 8, longLines: 1, strayResponses: 1 });
  assert.deepEqual(notes, ['after']);
  assert.throws(() => makeRpcClient(m.pipe, { lineMaxBytes: 4 }), /at least 16/);
});

test('when the child exits every waiting request is rejected closed, later requests reject at once and nothing more is written', async () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe);
  const exits: unknown[] = [];
  rpc.onExit((e) => exits.push(e));
  const a = rpc.request('turn/start', {});
  const b = rpc.request('turn/interrupt', {});
  assert.equal(rpc.waiting(), 2);
  m.close(3);
  await assert.rejects(a, (e: unknown) => e instanceof RpcError && e.reason === 'closed' && /exit 3/.test(e.message));
  await assert.rejects(b, (e: unknown) => e instanceof RpcError && e.reason === 'closed');
  assert.equal(rpc.closed, true);
  assert.equal(rpc.waiting(), 0);
  assert.deepEqual(exits, [{ code: 3, signal: null, error: null }]);
  const before = m.written.length;
  await assert.rejects(rpc.request('x', {}), (e: unknown) => e instanceof RpcError && e.reason === 'closed');
  assert.equal(rpc.notify('y'), false);
  assert.equal(rpc.respond(1, {}), false);
  assert.equal(m.written.length, before);
  // A late listener hears the exit too; a second close changes nothing.
  m.close(0);
  const late: unknown[] = [];
  rpc.onExit((e) => late.push(e));
  assert.deepEqual(late, [{ code: 3, signal: null, error: null }]);
  rpc.stop();
  assert.equal(m.stopped(), 1);
});

test('a failed pipe (the exe vanished: ENOENT) counts as the exit', async () => {
  const m = memPipe();
  const rpc = makeRpcClient(m.pipe);
  const a = rpc.request('initialize', {});
  m.fail('ENOENT');
  await assert.rejects(a, (e: unknown) => e instanceof RpcError && e.reason === 'closed' && /ENOENT/.test(e.message));
});
