import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, getTower } from '../../ui/api.js';

// ui/api.js names why a request got no answer (T1): past its deadline is 'timeout', a refused or broken
// connection is 'network'. The page once said "读取失败：network" for a read that only took too long.

test('a fetch past its deadline is timeout; a refused connection is network; an answer is read as before', async (t) => {
  const g = globalThis as { fetch?: unknown };
  const saved = Object.getOwnPropertyDescriptor(g, 'fetch');
  t.after(() => {
    if (saved === undefined) delete g.fetch;
    else Object.defineProperty(g, 'fetch', saved);
  });
  const answer = (fn: () => Promise<unknown>) => Object.defineProperty(g, 'fetch', { configurable: true, writable: true, value: fn });
  answer(async () => {
    throw new DOMException('signal timed out', 'TimeoutError');
  });
  assert.deepEqual(await getSession('0'.repeat(20)), { ok: false, code: 'timeout' });
  assert.deepEqual(await getTower(), { ok: false, code: 'timeout' });
  answer(async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await getSession('0'.repeat(20)), { ok: false, code: 'network' });
  answer(async () => ({ status: 404, ok: false, json: async () => ({ error: 'not-found' }) }));
  assert.deepEqual(await getSession('0'.repeat(20)), { ok: false, code: 'not-found' });
  // What the page's deadline (AbortSignal.timeout) aborts with: a DOMException named TimeoutError.
  const s = AbortSignal.timeout(1);
  await new Promise((r) => s.addEventListener('abort', r));
  assert.equal((s.reason as DOMException).name, 'TimeoutError');
});
