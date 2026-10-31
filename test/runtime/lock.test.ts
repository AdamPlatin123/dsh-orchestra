import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectFeatures } from '../../src/runtime/features.ts';
import { acquireLock, encodeDaemonInfo, heldMessage, lockPipeName, parseDaemonInfo } from '../../src/runtime/lock.ts';
import type { DaemonInfo } from '../../src/runtime/lock.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { whoamiEnglish, whoamiSpy } from '../helpers/fake-spawn.ts';
import { BOOT, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import type { Exit, Orchestrad } from '../helpers/orchestrad.ts';
import { FENCE_OK, captureConsole, minimalEnv, spyGate, startInProcess, testPorts } from '../helpers/start.ts';
import { treeDigest, withModuleTmp, withTmp } from '../helpers/tmp.ts';

const HOLDER = fileURLToPath(new URL('../helpers/lock-holder.ts', import.meta.url));
const WORKING = /^orchestrad: working \(test profile/;
const HINT = /another orchestrad holds the lock/;
/**
 * Far longer than any second start: the test stops the holder through its handle once the second
 * instance has exited, so the holder never thaws and no timing margin is involved.
 */
const FREEZE_MS = 60_000;

const homeOf = (dir: string) => path.join(fs.realpathSync.native(dir), 'orchestra');

test('a holder whose event loop is frozen (Atomics.wait) is never replaced; the one hint names its pid and start time', async (t) => {
  const dir = withTmp(t);
  const h = startOrchestrad(t, [dir, String(FREEZE_MS)], { script: HOLDER });
  await waitForLine(h, /^held$/);
  const home = homeOf(dir);
  const info = parseDaemonInfo(fs.readFileSync(path.join(home, 'run', 'daemon.json'), 'utf8'));
  assert.ok(info !== null && info.pid === h.pid, JSON.stringify(info));
  const before = treeDigest(home);
  const journal = fs.readFileSync(path.join(home, 'journal.jsonl'));

  const second = startOrchestrad(t, ['--test-profile', '--test-dir', dir]);
  const exit = await second.exited;
  assert.ok(!h.lines().some((l) => /^thawed/.test(l)), 'the second instance ran its whole start while the holder was frozen');

  assert.equal(exit.code, EXIT.lockHeld, `${second.lines().join('\n')}\n${second.errLines().join('\n')}`);
  const hints = [...second.lines(), ...second.errLines()].filter((l) => HINT.test(l));
  assert.equal(hints.length, 1, 'exactly one console hint');
  assert.ok(hints[0]!.includes(`(pid ${h.pid}, started ${info.startedAt})`), hints[0]);
  assert.match(hints[0]!, /will not take over/);
  assert.ok(!second.lines().some((l) => /orchestrad: working/.test(l)), 'the second instance never worked');
  assert.equal(treeDigest(home), before, 'no takeover: ORCHESTRA_HOME is byte-for-byte unchanged');
  assert.deepEqual(fs.readFileSync(path.join(home, 'journal.jsonl')), journal, 'the journal did not fork');
  assert.equal(h.child.exitCode, null, 'the holder still runs');
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

/** The exit of `o` if it comes within `ms`, else null (the child keeps running). */
function exitWithin(o: Orchestrad, ms: number): Promise<Exit | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void o.exited.then((e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

/**
 * A runner that boots orchestrad in the test profile through boot.ts's own path and, once it works,
 * loads a module through the import fence that emits SIGINT and keeps a timer alive (F1 of the step 2b
 * review). `entry` is src/main.ts, or a wrapper that gives start() the stopping of step 2b, which
 * released the lock and let the process live on.
 */
function signalRunner(t: TestContext, control: boolean): { runner: string; dir: string } {
  const files = withModuleTmp(t);
  const mainUrl = new URL('../../src/main.ts', import.meta.url).href;
  fs.writeFileSync(path.join(files, 'emit.ts'), "process.stdout.write('EMITTING\\n');\nprocess.emit('SIGINT' as never);\nsetInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(files, 'old-stop.ts'), [
    `import { start as realStart } from ${JSON.stringify(mainUrl)};`,
    'type Lock = { release(): Promise<void> };',
    'const onSignal = (stop: () => void) => { process.on(\'SIGINT\', stop); return () => { process.off(\'SIGINT\', stop); }; };',
    'export function start(f: never, fence: never, ports: never): Promise<unknown> {',
    '  return realStart(f, fence, ports, { stopping: { onSignal, end: (lock: Lock) => lock.release() } } as never);',
    '}',
  ].join('\n'));
  const entry = control ? pathToFileURL(path.join(files, 'old-stop.ts')).href : mainUrl;
  const runner = path.join(files, 'runner.mjs');
  fs.writeFileSync(runner, [
    `import { boot } from ${JSON.stringify(pathToFileURL(BOOT).href)};`,
    `const o = await boot(new URL(${JSON.stringify(entry)}));`,
    "if (o.started && o.result.mode === 'working') await import(new URL('./emit.ts', import.meta.url).href);",
  ].join('\n'));
  return { runner, dir: withTmp(t) };
}

test('a module that emits SIGINT and keeps a timer ends the holder with the lock; no process lives on without it (control: the step-2b stop let a second instance work beside it)', async (t) => {
  const fixed = signalRunner(t, false);
  const args = (dir: string) => ['--test-profile', '--test-dir', dir];
  const a = startOrchestrad(t, args(fixed.dir), { script: fixed.runner });
  await waitForLine(a, /^EMITTING$/);
  const ended = await exitWithin(a, 15_000);
  assert.deepEqual(ended, { code: EXIT.ok, signal: null }, `the holder kept running after its lock was asked to go; stdout: ${a.lines().join(' | ')}`);
  const log = fs.readFileSync(path.join(homeOf(fixed.dir), 'run', 'orchestrad.log'), 'utf8');
  assert.equal(log.split('\n').filter((l) => l.includes('"event":"stopped"')).length, 1, log);
  const c = startOrchestrad(t, args(fixed.dir));
  await waitForLine(c, WORKING);
  await c.stop();

  const old = signalRunner(t, true);
  const bad = startOrchestrad(t, args(old.dir), { script: old.runner });
  await waitForLine(bad, /^EMITTING$/);
  const second = startOrchestrad(t, args(old.dir));
  await waitForLine(second, WORKING);
  assert.equal(bad.child.exitCode, null, 'control: the first holder still runs, without its lock, while a second one works');
  await second.stop();
  await bad.stop();
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

test('daemon.json round-trips; anything malformed reads as unknown; the hint names pid and start time', () => {
  const info: DaemonInfo = { v: 1, pid: 77, profile: 'real', bootId: '0e0f3a52-7b1c-4d2e-9f00-1234567890ab', startedAt: '2026-10-31T08:00:00.000Z' };
  assert.deepEqual(parseDaemonInfo(encodeDaemonInfo(info)), info);
  const { bootId: _dropped, ...noBootId } = info;
  for (const bad of [
    '', 'null', '{"v":2}', JSON.stringify({ ...info, pid: -1 }), JSON.stringify({ ...info, startedAt: 'yesterday' }), JSON.stringify({ ...info, profile: 'x' }),
    JSON.stringify({ ...info, bootId: 'abc' }), JSON.stringify(noBootId),
  ]) {
    assert.equal(parseDaemonInfo(bad), null, bad);
  }
  assert.match(heldMessage('C:\\h', info), /\(pid 77, started 2026-10-31T08:00:00\.000Z\)/);
  assert.match(heldMessage('C:\\h', null), /holder unknown: daemon.json is missing or unreadable/);
});

/**
 * Wraps node:fs's rename and open for the rest of the test (syncBuiltinESMExports carries the
 * wrappers into every `import * as fs` namespace, write-fence.ts's among them) and records every
 * write that lands on a file named daemon.json: a rename onto it, or an open of it.
 */
function recordDaemonJsonWrites(t: { after(fn: () => void): void }): string[] {
  const writes: string[] = [];
  const realRename = nodeFs.renameSync;
  const realOpen = nodeFs.openSync;
  const isDaemonJson = (p: unknown) => path.basename(String(p)).toLowerCase() === 'daemon.json';
  nodeFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (isDaemonJson(to)) writes.push(`rename ${String(to)}`);
    return realRename(from, to);
  }) as typeof nodeFs.renameSync;
  nodeFs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (isDaemonJson(p)) writes.push(`open ${String(p)}`);
    return (realOpen as (p: fs.PathLike, ...r: unknown[]) => number)(p, ...rest);
  }) as typeof nodeFs.openSync;
  syncBuiltinESMExports();
  t.after(() => {
    nodeFs.renameSync = realRename;
    nodeFs.openSync = realOpen;
    syncBuiltinESMExports();
  });
  return writes;
}

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('one start writes daemon.json once, arms no timer, and nothing rewrites it while it works', async (t) => {
  const dir = withTmp(t);
  const writes = recordDaemonJsonWrites(t);
  const timersBefore = timeouts();
  const con = captureConsole();
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), {
    argv: ['--test-profile', '--test-dir', dir],
    home: path.join(dir, 'user-home'),
    env: minimalEnv(),
    console: con.port,
    makeSpawnGate: spyGate(whoamiSpy(whoamiEnglish('Medium Mandatory Level'))),
  });
  assert.equal(o.mode, 'working', con.all().join('\n'));
  if (o.mode !== 'working') return;
  t.after(() => o.stop());
  assert.equal(timeouts(), timersBefore, 'start() left a timer running');
  assert.equal(writes.length, 1, writes.join('\n'));
  assert.match(writes[0]!, /^rename .+\\run\\daemon\.json$/i);
  const info = parseDaemonInfo(fs.readFileSync(path.join(homeOf(dir), 'run', 'daemon.json'), 'utf8'));
  assert.ok(info !== null && info.pid === process.pid && info.profile === 'test', JSON.stringify(info));
  await o.stop();
  assert.equal(writes.length, 1, 'stopping wrote nothing either');
});
