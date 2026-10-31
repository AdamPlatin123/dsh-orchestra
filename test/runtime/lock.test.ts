import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { acquireLock, encodeDaemonInfo, heldMessage, lockPipeName, parseDaemonInfo, startHeartbeat } from '../../src/runtime/lock.ts';
import type { DaemonInfo } from '../../src/runtime/lock.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { runOrchestrad, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import type { Orchestrad } from '../helpers/orchestrad.ts';
import { treeDigest, withTmp } from '../helpers/tmp.ts';

const HOLDER = fileURLToPath(new URL('../helpers/lock-holder.ts', import.meta.url));
const WORKING = /^orchestrad: working \(test profile/;
const HINT = /another orchestrad holds the lock/;

const homeOf = (dir: string) => path.join(fs.realpathSync.native(dir), 'orchestra');
const holder = (t: TestContext, dir: string, mode: 'stale' | 'freeze', ms?: number) =>
  startOrchestrad(t, [dir, mode, ...(ms === undefined ? [] : [String(ms)])], { script: HOLDER });

function hintAge(line: string, pid: number): number {
  const m = new RegExp(`pid ${pid}, heartbeat (\\d+) s ago`).exec(line);
  assert.ok(m, line);
  return Number(m[1]);
}

/** A second orchestrad against a held lock: exit 4, exactly one hint, nothing under ORCHESTRA_HOME changed. */
function secondInstanceBouncesOff(dir: string, h: Orchestrad, minAge: number): void {
  const home = homeOf(dir);
  const before = treeDigest(home);
  const journal = fs.readFileSync(path.join(home, 'journal.jsonl'));
  const r = runOrchestrad(['--test-profile', '--test-dir', dir]);
  assert.equal(r.status, EXIT.lockHeld, `${r.stdout}\n${r.stderr}`);
  const hints = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter((l) => HINT.test(l));
  assert.equal(hints.length, 1, 'exactly one console hint');
  assert.ok(hintAge(hints[0]!, h.pid) >= minAge, hints[0]);
  assert.match(hints[0]!, /will not take over/);
  assert.ok(!/orchestrad: working/.test(r.stdout), 'the second instance never worked');
  assert.equal(treeDigest(home), before, 'no takeover: ORCHESTRA_HOME is byte-for-byte unchanged');
  assert.deepEqual(fs.readFileSync(path.join(home, 'journal.jsonl')), journal, 'the journal did not fork');
  assert.equal(h.child.exitCode, null, 'the holder still runs');
}

test('a live holder whose heartbeat is 120 s old is never replaced (fast variant)', async (t) => {
  const dir = withTmp(t);
  const h = holder(t, dir, 'stale');
  await waitForLine(h, /^held$/);
  secondInstanceBouncesOff(dir, h, 120);
  await h.stop();
});

test('a holder frozen for 120 s (Atomics.wait) is never replaced (real freeze)', {
  skip: process.env.ORCHESTRA_LOCK_FREEZE_TEST === '1' ? false : 'takes over two minutes; run once by hand with ORCHESTRA_LOCK_FREEZE_TEST=1',
  timeout: 240_000,
}, async (t) => {
  const dir = withTmp(t);
  const h = holder(t, dir, 'freeze', 150_000);
  await waitForLine(h, /^held$/);
  await sleep(120_000);
  secondInstanceBouncesOff(dir, h, 120);
  await h.stop();
});

test('two instances started together: exactly one works, the other exits with the lock-held code', async (t) => {
  const dir = withTmp(t);
  const args = ['--test-profile', '--test-dir', dir];
  const a = startOrchestrad(t, args);
  const b = startOrchestrad(t, args);
  const fate = (o: Orchestrad) => new Promise<string>((resolve) => {
    waitForLine(o, WORKING, 60_000).then(() => resolve('working'), () => {});
    void o.exited.then((e) => resolve(`exit ${e.code}`));
  });
  const fates = await Promise.all([fate(a), fate(b)]);
  assert.deepEqual([...fates].sort(), [`exit ${EXIT.lockHeld}`, 'working']);
  const loser = fates[0] === 'working' ? b : a;
  assert.equal(loser.errLines().filter((l) => HINT.test(l)).length, 1);
  await a.stop();
  await b.stop();
});

test('after the holder is killed the lock is free again within 1 s', async (t) => {
  const dir = withTmp(t);
  const args = ['--test-profile', '--test-dir', dir];
  const a = startOrchestrad(t, args);
  await waitForLine(a, WORKING);
  const pipe = lockPipeName(homeOf(dir));
  const log = fs.readFileSync(path.join(homeOf(dir), 'run', 'orchestrad.log'), 'utf8');
  assert.ok(log.includes(JSON.stringify(pipe).slice(1, -1)), 'orchestrad holds the pipe this test computes');
  await a.stop();
  const t0 = performance.now();
  let got = await acquireLock(pipe);
  while (!got.ok && performance.now() - t0 < 1000) {
    await sleep(10);
    got = await acquireLock(pipe);
  }
  const elapsed = performance.now() - t0;
  t.diagnostic(`lock free after ${elapsed.toFixed(1)} ms`);
  assert.ok(got.ok, `still held after ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 1000);
  await got.lock.release();
  const b = startOrchestrad(t, args);
  await waitForLine(b, WORKING);
  await b.stop();
});

test('in-process: a second listen is "held", a release frees it, and a client is closed at once', async () => {
  const pipe = lockPipeName(`C:\\orchestra-lock-test-${process.pid}-${Date.now()}`);
  const first = await acquireLock(pipe);
  assert.ok(first.ok);
  assert.deepEqual(await acquireLock(pipe), { ok: false, reason: 'held', pipe });
  const closed = await new Promise<boolean>((resolve) => {
    const c = net.connect(pipe);
    c.on('close', () => resolve(true));
    c.on('error', () => resolve(true));
  });
  assert.ok(closed);
  await first.lock.release();
  await first.lock.release();
  const again = await acquireLock(pipe);
  assert.ok(again.ok);
  await again.lock.release();
});

test('the pipe name is a function of realpath(ORCHESTRA_HOME), case-insensitive', () => {
  assert.equal(lockPipeName('C:\\Users\\X\\.orchestra'), lockPipeName('c:\\users\\x\\.ORCHESTRA'));
  assert.notEqual(lockPipeName('C:\\a\\orchestra'), lockPipeName('C:\\b\\orchestra'));
  assert.match(lockPipeName('C:\\a'), /^\\\\\.\\pipe\\orchestra-[0-9a-f]{16}-lock$/);
});

test('daemon.json round-trips; anything malformed reads as unknown; the hint says so', () => {
  const info: DaemonInfo = { v: 1, pid: 77, createTime: null, profile: 'real', startedAt: '2026-10-31T08:00:00.000Z', heartbeatAt: '2026-10-31T08:00:10.000Z' };
  assert.deepEqual(parseDaemonInfo(encodeDaemonInfo(info)), info);
  for (const bad of ['', 'null', '{"v":2}', JSON.stringify({ ...info, pid: -1 }), JSON.stringify({ ...info, heartbeatAt: 'yesterday' }), JSON.stringify({ ...info, profile: 'x' })]) {
    assert.equal(parseDaemonInfo(bad), null, bad);
  }
  const now = Date.parse('2026-10-31T08:02:10.000Z');
  assert.match(heldMessage('C:\\h', info, now), /\(pid 77, heartbeat 120 s ago\)/);
  assert.match(heldMessage('C:\\h', null, now), /holder unknown: daemon.json is missing or unreadable/);
});

test('the heartbeat writes at once and every interval, survives a failing write, and stops', () => {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  const writes: string[] = [];
  let fail = false;
  const errors: unknown[] = [];
  let now = Date.parse('2026-10-31T08:00:00.000Z');
  const hb = startHeartbeat({
    info: { v: 1, pid: 5, createTime: null, profile: 'test', startedAt: '2026-10-31T08:00:00.000Z' },
    write: (text) => {
      if (fail) throw new Error('fence said no');
      writes.push(text);
    },
    now: () => now,
    timers: { setInterval: (fn) => ticks.push(fn), clearInterval: () => cleared++ },
    onError: (e) => errors.push(e),
  });
  assert.equal(writes.length, 1);
  now += 10_000;
  ticks[0]!();
  assert.equal(parseDaemonInfo(writes[1]!)!.heartbeatAt, '2026-10-31T08:00:10.000Z');
  fail = true;
  ticks[0]!();
  assert.equal(errors.length, 1);
  hb.stop();
  hb.stop();
  assert.equal(cleared, 1);
});
