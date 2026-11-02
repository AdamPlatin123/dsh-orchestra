import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnedRecord, OwnedRegistry } from '../../src/owned/registry.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { ClaudeOwned, restoredSession as restoredClaude } from '../../src/owned/claude-owned.ts';
import { CodexOwned, OWNED_POOL_MAX } from '../../src/owned/codex-owned.ts';
import { restoredOwned } from '../../src/owned/restored.ts';
import { ownedList, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import { routeOf } from '../../src/server/routes.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';

// Phase 3 review: the running-session limit is one total for both harnesses (slice design §2.4), and the
// sessions an earlier orchestrad left stay listed (read only, unknown) when their harness is off now.
// Synthetic records and managers whose launch is never reached.

const noLaunch = () => {
  throw new Error('not launched in this test');
};

test('one pool for both harnesses: a manager refuses owned-limit when the pool is full, whatever its own count; the list reports the pool\'s total', () => {
  const clock = new VirtualClock({ mono: 1, wall: 1 });
  const approvals = new Approvals({ hub: clock });
  let running = OWNED_POOL_MAX;
  const pool = { max: OWNED_POOL_MAX, active: () => running };
  const codex = new CodexOwned({ approvals, makeWorkDir: (id) => `C:\\w\\${id}`, now: () => 1, redact: (text) => ({ text, count: 0 }), launch: noLaunch, pool });
  const claude = new ClaudeOwned({
    approvals, makeWorkDir: (id) => `C:\\w\\${id}`, makeConfigDir: (id) => `C:\\c\\${id}`, launch: noLaunch, claudeExe: 'C:\\x\\claude.exe', protectedRoots: [], hub: clock,
    now: () => 1, redact: (text) => ({ text, count: 0 }), pool,
  });
  assert.equal(OWNED_POOL_MAX, 3);
  assert.deepEqual([codex.maxActive, claude.maxActive], [3, 3]);
  assert.deepEqual([codex.full(), claude.full()], [true, true]);
  assert.deepEqual(codex.create({ text: 'x', uuid: '' }), { ok: false, reason: 'owned-limit', detail: '3 running' });
  assert.equal(claude.create({ text: 'x', uuid: '' }).ok, false);
  running = 2;
  assert.deepEqual([codex.full(), claude.full()], [false, false]);
  const list = ownedList({ codex, claude, codexOff: 'on', maxOwned: pool.max });
  assert.equal(list.limits.maxOwned, 3, 'the total, not 3 + 3');
  assert.ok(validateOwnedList(list).ok);
});

function memRegistry(records: OwnedRecord[]): OwnedRegistry & { saved: OwnedRecord[] } {
  const saved: OwnedRecord[] = [];
  return { saved, load: () => records, save: (r: OwnedRecord) => { saved.push(r); } } as unknown as OwnedRegistry & { saved: OwnedRecord[] };
}

test('a harness that is off now still lists what an earlier orchestrad left: unknown (daemon-restart) when it had not ended, read only, on the list and the tower', async () => {
  const rec = (id: string, state: OwnedRecord['state'], endReason: string | null): OwnedRecord => ({ v: 1, ownedId: id, harness: 'claude', model: 'zcode/GLM-5.3', title: `t ${id.slice(0, 2)}`, createdAt: 5, state, endReason });
  const reg = memRegistry([
    rec('a'.repeat(20), 'running', null), rec('b'.repeat(20), 'ended', 'you-ended'),
    { ...rec('c'.repeat(20), 'idle', null), harness: 'codex', model: 'codex/gpt-6.1-sol' },
  ]);
  const off = restoredOwned('claude', reg, () => 9, restoredClaude);
  assert.equal(off.restored, 2, 'only its own harness');
  assert.deepEqual(off.list().map((s) => [s.ownedId.slice(0, 1), s.state, s.endReason]), [['a', 'unknown', 'daemon-restart'], ['b', 'ended', 'you-ended']]);
  assert.deepEqual(reg.saved.map((r) => [r.ownedId.slice(0, 1), r.state, r.endReason]), [['a', 'unknown', 'daemon-restart']], 'the file says unknown from now on');
  assert.deepEqual(off.towerSeats().map((s) => [s.harness, s.state, s.waiting]), [['claude', 'unknown', null], ['claude', 'ended', null]]);
  const list = ownedList({ codex: null, claude: null, codexOff: 'not-asked', restored: [off] });
  assert.deepEqual(list.owned.map((o) => [o.harness, o.state, o.title]), [['claude', 'unknown', `t aa`], ['claude', 'ended', 't bb']]);
  assert.deepEqual([list.enabled, list.harnesses.claude], [false, false], 'listed, but nothing can start');
  assert.ok(validateOwnedList(list).ok, validateOwnedList(list).errors.join('\n'));
  // The routes find it: its feed reads, a message to it is refused as ended.
  const h = registerOwnedHandlers({ codex: null, claude: null, codexOff: 'not-asked', restored: [off], log: { info: () => {}, warn: () => {}, error: () => {} } as never });
  const feed = await h.get(routeOf('GET', '/api/owned/:id/feed')!)!({ id: 'a'.repeat(20), query: {}, body: null, actionId: null } as never);
  assert.equal(feed.ok, true);
  const sent = await h.get(routeOf('POST', '/api/owned/:id/message')!)!({ id: 'a'.repeat(20), query: {}, body: { text: 'hi' }, actionId: '11111111-1111-4111-8111-111111111111' } as never);
  assert.deepEqual(sent, { ok: false, error: 'owned-ended' });
});
