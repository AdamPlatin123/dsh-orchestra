import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { StopPort } from '../../src/runtime/working.ts';
import { makeReadGate, makeWriteFence } from '../../src/fs/node-io.ts';
import { PidLog } from '../../src/os/spawn.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { whoamiEnglish, whoamiSpy } from '../helpers/fake-spawn.ts';
import { FENCE_OK, IN_PROCESS_STOP, assertFakeHome, captureConsole, inProcessOverrides, minimalEnv, runWorkingInProcess, spyGate, startInProcess, testPorts } from '../helpers/start.ts';
import { junction, withTmp } from '../helpers/tmp.ts';

const CLOCK = makeRealClock();

// Step 2c (zen note 7.7, first residual): a test file run directly, or with --test-isolation=none,
// carries no NODE_TEST_CONTEXT, so an in-process start() without a pinned home would run the real
// profile against the real home. test/helpers/start.ts is the only way tests call start() or
// runWorking() (static rule in-process-start-only-in-helper), and it refuses unless home is a fake
// home in an orchestra-test-* fixture. None of these refusals ever names the real home: the paths
// that must be refused lie in the temp dir, outside any fixture.

/** A path in the temp dir that is not inside any orchestra-test-* dir, and does not exist. */
const outsideFixture = () => path.join(os.tmpdir(), `orchestra-not-a-fixture-${crypto.randomUUID()}`, 'home');

test('assertFakeHome: only a path strictly inside an orchestra-test-* dir of the temp dir passes, judged on its real path', (t) => {
  const fixture = withTmp(t);
  const ok = (home: unknown, tmp?: string) => {
    try {
      assertFakeHome(home, 'home', tmp);
      return 'ok';
    } catch (e) {
      return (e as Error).message.includes('none was given') ? 'none' : 'outside';
    }
  };
  assert.equal(ok(path.join(fixture, 'home')), 'ok', 'need not exist');
  assert.equal(ok(path.join(fixture, 'home', 'deeper')), 'ok');
  fs.mkdirSync(path.join(fixture, 'made'));
  assert.equal(ok(path.join(fixture, 'made')), 'ok');
  assert.equal(ok(undefined), 'none');
  assert.equal(ok(''), 'none');
  assert.equal(ok(42), 'none');
  assert.equal(ok(fixture), 'outside', 'the fixture dir itself is no home inside it');
  assert.equal(ok(os.tmpdir()), 'outside');
  assert.equal(ok(outsideFixture()), 'outside');
  assert.equal(ok(path.join(fixture, '..', 'orchestra-elsewhere', 'home')), 'outside');
  assert.equal(ok(path.join(fixture, 'home', '..', '..', 'x')), 'outside');

  // A fixture that is a junction to a dir outside the temp root does not count. The temp root here is
  // a private one inside the fixture, so the junction stays inside the fixture (helpers/tmp.ts).
  const temp = path.join(fixture, 'temp');
  fs.mkdirSync(path.join(temp, 'orchestra-test-real'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'elsewhere'));
  junction(fixture, path.join(temp, 'orchestra-test-link'), path.join(fixture, 'elsewhere'));
  assert.equal(ok(path.join(temp, 'orchestra-test-real', 'home'), temp), 'ok', 'control: a real fixture dir in the private temp root');
  assert.equal(ok(path.join(temp, 'orchestra-test-link', 'home'), temp), 'outside');
});

test('inProcessOverrides: IN_PROCESS_STOP unless the caller hands its own StopPort; every other field is the caller\'s', () => {
  assert.equal(inProcessOverrides({}).stopping, IN_PROCESS_STOP);
  assert.equal(inProcessOverrides({ stopping: undefined }).stopping, IN_PROCESS_STOP);
  const mine: StopPort = { onSignal: () => () => {}, end: async () => {} };
  assert.equal(inProcessOverrides({ stopping: mine }).stopping, mine);
  const o = inProcessOverrides({ home: 'C:\\x', argv: ['--a'] });
  assert.deepEqual([o.home, o.argv], ['C:\\x', ['--a']]);
  // A stopping on the overrides' prototype is not the caller's own.
  const proto = Object.create({ stopping: mine }) as Record<string, unknown>;
  assert.equal(inProcessOverrides(proto).stopping, IN_PROCESS_STOP);
});

test('startInProcess refuses before anything runs unless home is a fake home', async (t) => {
  const spy = whoamiSpy(whoamiEnglish('Medium Mandatory Level'));
  const con = captureConsole();
  // An argument main.ts would refuse at once: were the guard missing (a mutation run), start() would
  // return 'refused' instead of rejecting, and still touch no home.
  const common = { argv: ['--orchestra-guard-probe'], env: minimalEnv(), console: con.port, makeSpawnGate: spyGate(spy) };
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, testPorts(), common), /home must be a fake home; none was given/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...common, home: outsideFixture() }), /home must lie inside an orchestra-test-\* dir/);
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(con.all(), [], 'start() never ran');
  const dir = withTmp(t);
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...common, home: path.join(dir, 'user-home') });
  assert.equal(o.mode, 'refused', 'control: with a fake home the call reaches start()');
});

test('startInProcess refuses an omitted env or a root variable pointing outside the fixture', async (t) => {
  const dir = withTmp(t);
  // The real profile (argv []) is the case the guard closes: without its own env main.ts reads
  // process.env, where CLAUDE_CONFIG_DIR is the real config dir on this machine and a real
  // ORCHESTRA_HOME the data dir — the half of the zen 7.7 residual a fake home alone does not close.
  const base = { argv: [] as string[], home: path.join(dir, 'user-home'), console: captureConsole().port };
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base }), /startInProcess needs its own env/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, env: minimalEnv({ CLAUDE_CONFIG_DIR: outsideFixture() }) }), /env\.CLAUDE_CONFIG_DIR must lie inside/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, env: minimalEnv({ ORCHESTRA_HOME: outsideFixture() }) }), /env\.ORCHESTRA_HOME must lie inside/);
  // Control: with its own env whose root variables all lie inside the fixture, the call reaches
  // start(); the real profile then refuses under the test runner (NODE_TEST_CONTEXT is set), before
  // locate() reads any root, which is itself the proof the guard let it past without touching home.
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, env: minimalEnv({ ORCHESTRA_HOME: path.join(dir, 'orch'), CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') }) });
  assert.equal(o.mode, 'refused', o.mode);
  assert.equal(o.mode === 'refused' ? o.refusal.reason : '', 'real-profile-under-test-runner');
});

test('runWorkingInProcess refuses unless both home and userHome are fake homes', async (t) => {
  const base = withTmp(t);
  const ctx = {
    profile: { kind: 'real' as const }, roots: [], notes: [], log: new Log({ clock: CLOCK.port(null) }), pidLog: new PidLog(), console: captureConsole().port, pid: process.pid, clock: CLOCK,
    tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p), makeReadGate, makeWriteFence, makeDbOpener, env: minimalEnv(),
  };
  // Were the guard missing (a mutation run), the first call would work inside the fixture and is
  // stopped at once, and the second, whose home is its user home, fails the data dir check first.
  const outcome = (p: ReturnType<typeof runWorkingInProcess>) => p.then(
    async (o) => {
      if (o.mode === 'working') await o.stop();
      return `ran: ${o.mode}`;
    },
    (e: Error) => e.message,
  );
  assert.match(await outcome(runWorkingInProcess({ ...ctx, home: path.join(base, 'orchestra'), userHome: outsideFixture() })), /^test helper: userHome must lie inside/);
  const elsewhere = outsideFixture();
  assert.match(await outcome(runWorkingInProcess({ ...ctx, home: elsewhere, userHome: elsewhere })), /^test helper: home must lie inside/);
  assert.equal(fs.readdirSync(base).length, 0, 'nothing was created');
});

// Finding F3: the checks must judge the very object start() gets. Object.keys skips a non-enumerable
// env key that resolveEnv's own-field reads see; a spread drops a non-enumerable home or env, so start()
// would fall back to os.homedir() and process.env; a getter can answer the check and start() apart.
// Every refusal here comes before start() runs: none of these paths is ever read.
test('startInProcess judges the copy start() gets: a non-enumerable env root, a non-enumerable home or env, and a getter are refused or carried as checked', async (t) => {
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'user-home');
  const ports = testPorts();
  const refused = async (overrides: Record<string, unknown>) => {
    try {
      const o = await startInProcess(detectFeatures(), FENCE_OK, ports, overrides as never);
      // Never left running (its lock pipe would keep the file alive): a start that got through is stopped.
      if (o.mode === 'working' || o.mode === 'journal-chain') await o.stop();
      return 'started';
    } catch (e) {
      return (e as Error).message;
    }
  };
  // (a) a non-enumerable CLAUDE_CONFIG_DIR outside any fixture.
  const env = minimalEnv();
  Object.defineProperty(env, 'CLAUDE_CONFIG_DIR', { value: outsideFixture(), enumerable: false });
  assert.match(await refused({ argv: ['--test-profile', '--test-dir', dir], home, env }), /env\.CLAUDE_CONFIG_DIR must lie inside an orchestra-test-\* dir/);
  // (b) a non-enumerable home (and env): kept by the copy, so judged, never dropped to os.homedir().
  const o1: Record<string, unknown> = { argv: ['--test-profile', '--test-dir', dir], env: minimalEnv() };
  Object.defineProperty(o1, 'home', { value: outsideFixture(), enumerable: false });
  assert.match(await refused(o1), /home must lie inside an orchestra-test-\* dir/);
  const copied = inProcessOverrides(Object.defineProperty({ argv: [] }, 'home', { value: home, enumerable: false }) as never);
  assert.equal(copied.home, home, 'a non-enumerable home reaches start()');
  const o2: Record<string, unknown> = { argv: ['--test-profile', '--test-dir', dir], home };
  Object.defineProperty(o2, 'env', { value: minimalEnv({ ORCHESTRA_HOME: outsideFixture() }), enumerable: false });
  assert.match(await refused(o2), /env\.ORCHESTRA_HOME must lie inside/);
  // (c) a getter: refused outright, its value never read twice.
  let reads = 0;
  const o3 = { argv: ['--test-profile', '--test-dir', dir], env: minimalEnv(), get home() { reads++; return reads === 1 ? home : outsideFixture(); } };
  assert.match(await refused(o3), /overrides\.home is an accessor/);
  const env4 = minimalEnv();
  Object.defineProperty(env4, 'CODEX_HOME', { get: () => outsideFixture(), enumerable: true });
  assert.match(await refused({ argv: ['--test-profile', '--test-dir', dir], home, env: env4 }), /env\.CODEX_HOME is an accessor/);
});
