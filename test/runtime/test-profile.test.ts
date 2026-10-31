import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { resolveEnv } from '../../src/runtime/env.ts';
import {
  FAKE_AGENT_MARKER, TestRoots, checkBrakeRoot, decidePairingOutput, isFakeAgent, parseProfileArgs, testProfileRoots, testReadDirs, windowsTmpdir,
} from '../../src/runtime/test-profile.ts';
import { start } from '../../src/main.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { put, shortNameOf, tmpDir, rmTree, withTmp } from '../helpers/tmp.ts';
import { whoamiSpy, whoamiEnglish } from '../helpers/fake-spawn.ts';
import { FENCE_OK, captureConsole, minimalEnv } from '../helpers/start.ts';

const env = process.env;
const parse = (argv: string[], e: NodeJS.ProcessEnv | Record<string, string | undefined> = env) => parseProfileArgs(argv, { env: e });
const reason = (argv: string[], e?: Record<string, string | undefined>) => {
  const r = parse(argv, e);
  return r.ok ? `ok:${r.profile.kind}` : r.refusal.reason;
};

test('windowsTmpdir() mirrors os.tmpdir()', () => {
  assert.equal(windowsTmpdir(process.env), os.tmpdir());
  assert.equal(windowsTmpdir({ TEMP: 'C:\\t\\' }), 'C:\\t');
  assert.equal(windowsTmpdir({ TMP: 'D:\\' }), 'D:\\');
  assert.equal(windowsTmpdir({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\temp');
});

test('the real profile takes no arguments; stray, repeated or misplaced flags refuse the start', (t) => {
  const dir = withTmp(t);
  assert.equal(reason([]), 'ok:real');
  assert.equal(reason(['--port', '1']), 'unknown-argument');
  assert.equal(reason(['--test-dir', dir]), 'test-flag-without-test-profile');
  assert.equal(reason(['--test-root-pid', '12']), 'test-flag-without-test-profile');
  assert.equal(reason(['--test-profile']), 'test-dir-required');
  assert.equal(reason(['--test-profile', '--test-profile', '--test-dir', dir]), 'duplicate-flag');
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--test-dir', dir]), 'duplicate-flag');
  assert.equal(reason(['--test-profile', '--test-dir']), 'missing-value');
  assert.equal(reason(['--test-profile', '--test-dir', '--test-root-pid', '1']), 'missing-value');
  for (const bad of ['0', '-1', '12a', '012', '99999999999', '4294967296']) {
    assert.equal(reason(['--test-profile', '--test-dir', dir, '--test-root-pid', bad]), 'bad-root-pid', bad);
  }
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--test-root-pid', '7', '--test-root-pid', '7']), 'duplicate-root-pid');
});

test('--test-dir must exist, sit directly in the temp dir and be named orchestra-test-*', (t) => {
  const dir = withTmp(t);
  const ok = parse(['--test-root-pid', '33', '--test-profile', '--test-dir', dir, '--test-root-pid', '44']);
  assert.ok(ok.ok && ok.profile.kind === 'test');
  const p = ok.profile as TestProfile;
  assert.equal(p.testDir, fs.realpathSync.native(dir));
  assert.equal(p.orchestraHome, path.join(p.testDir, 'orchestra'));
  assert.equal(p.rootsDir, path.join(p.testDir, 'roots'));
  assert.deepEqual(p.rootPids, [33, 44]);

  const nested = path.join(dir, 'orchestra-test-nested');
  fs.mkdirSync(nested);
  assert.equal(reason(['--test-profile', '--test-dir', nested]), 'test-dir-outside-tmp');
  // A private temp dir (injected TEMP) keeps the wrongly named dir inside this test's own fixture.
  const privateTemp = path.join(withTmp(t), 'temp');
  const wrongName = path.join(privateTemp, 'orchestra-tst-x');
  fs.mkdirSync(wrongName, { recursive: true });
  assert.equal(reason(['--test-profile', '--test-dir', wrongName], { TEMP: privateTemp }), 'test-dir-name');
  assert.equal(reason(['--test-profile', '--test-dir', path.join(os.tmpdir(), 'orchestra-test-does-not-exist-x9')]), 'test-dir-not-found');
  assert.equal(reason(['--test-profile', '--test-dir', 'orchestra-test-rel']), 'test-dir-bad-path');
  assert.equal(reason(['--test-profile', '--test-dir', dir], { TEMP: path.join(dir, 'other-temp') }), 'tmpdir-unavailable');
  // A temp dir that is not os.tmpdir(): the same directory is now outside it.
  const otherTmp = tmpDir();
  t.after(() => rmTree(otherTmp));
  assert.equal(reason(['--test-profile', '--test-dir', dir], { TEMP: otherTmp }), 'test-dir-outside-tmp');
});

test('--test-dir given by its 8.3 short name resolves to the long canonical form', (t) => {
  // %TEMP% itself holds many orchestra-test-* dirs, whose short names are hashed; a private temp
  // dir (injected TEMP) holds just one, so its short name is predictable.
  const base = withTmp(t);
  const temp = path.join(base, 'temp');
  const long = path.join(temp, 'orchestra-test-long-name');
  fs.mkdirSync(long, { recursive: true });
  const short = shortNameOf(temp, 'orchestra-test-long-name');
  if (short === null) {
    t.skip('the temp volume generates no 8.3 short names');
    return;
  }
  const r = parse(['--test-profile', '--test-dir', path.join(temp, short)], { TEMP: temp });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((r.profile as TestProfile).testDir, fs.realpathSync.native(long));
  assert.equal((r.profile as TestProfile).orchestraHome, path.join(fs.realpathSync.native(long), 'orchestra'));
});

test('--roots-dir only below %LOCALAPPDATA%\\orchestra-frozen\\ (a fake LOCALAPPDATA here)', (t) => {
  const dir = withTmp(t);
  const local = path.join(dir, 'fake-local');
  const frozen = path.join(local, 'orchestra-frozen');
  const e = { ...env, LOCALAPPDATA: local };
  const ok = parse(['--test-profile', '--test-dir', dir, '--roots-dir', path.join(frozen, 'snap-1')], e);
  assert.ok(ok.ok);
  const p = ok.profile as TestProfile;
  assert.equal(p.rootsDir, path.join(frozen, 'snap-1'));
  assert.deepEqual(testReadDirs(p), [p.testDir, path.join(frozen, 'snap-1')]);
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--roots-dir', frozen], e), 'roots-dir-outside-frozen');
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--roots-dir', path.join(local, 'orchestra-frozen-x', 'a')], e), 'roots-dir-outside-frozen');
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--roots-dir', path.join(frozen, '..', 'x')], e), 'roots-dir-outside-frozen');
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--roots-dir', 'snap'], e), 'roots-dir-bad-path');
  const noLocal: Record<string, string | undefined> = { ...env };
  for (const k of Object.keys(noLocal)) if (k.toLowerCase() === 'localappdata') delete noLocal[k];
  assert.equal(reason(['--test-profile', '--test-dir', dir, '--roots-dir', path.join(frozen, 'snap-1')], noLocal), 'localappdata-unset');
});

test('in the test profile the read gate refuses every real-profile root and reads only the synthetic ones', (t) => {
  const dir = withTmp(t);
  const elsewhere = withTmp(t);
  const r = parse(['--test-profile', '--test-dir', dir]);
  assert.ok(r.ok);
  const p = r.profile as TestProfile;
  const synthetic = put(path.join(p.rootsDir, 'claude', 'projects', 'x', 'a.jsonl'), '{}\n');
  // What the real profile would watch, derived from a stand-in home outside the test dir.
  const realLike = resolveEnv({ home: path.join(elsewhere, 'home'), env: {} });
  const realRoots: HarnessRoot[] = realLike.typedHarnessRoots.map((x) => ({ kind: x.kind, path: x.path, real: x.path }));
  const gate = new ReadGate({ roots: [...realRoots, ...testProfileRoots(p)], orchestraHome: p.orchestraHome, testDirs: testReadDirs(p) });
  for (const root of realRoots) {
    const d = gate.decide(path.join(root.path, 'projects', 'x', 'a.jsonl'), 'read');
    assert.equal(!d.allow && d.reason, 'test-mode-outside', root.path);
  }
  assert.equal(gate.decide(synthetic, 'read').allow, true);
  assert.deepEqual(testProfileRoots(p).map((x) => [x.kind, x.path]), [
    ['claude', path.join(p.rootsDir, 'claude')], ['dsh', path.join(p.rootsDir, 'dsh')], ['codex', path.join(p.rootsDir, 'codex')],
  ]);
});

test('brakes in the test profile: an unregistered root is not-test-root; registered roots need fake-agent node and the same createTime', () => {
  const testP: TestProfile = { kind: 'test', testDir: 'C:\\t\\orchestra-test-x', orchestraHome: 'C:\\t\\orchestra-test-x\\orchestra', rootsDir: 'C:\\t\\orchestra-test-x\\roots', rootsDirGiven: false, rootPids: [100, 200, 300] };
  const roots = new TestRoots(testP.rootPids);
  assert.deepEqual(checkBrakeRoot(testP, roots, 999, 1), { ok: false, reason: 'not-test-root' });
  assert.deepEqual(checkBrakeRoot(testP, null, 100, 1), { ok: false, reason: 'not-test-root' });
  assert.deepEqual(checkBrakeRoot(testP, roots, 100, 1), { ok: false, reason: 'unresolved' });
  roots.resolve(100, { createTime: 555, image: 'C:\\x\\node.exe', commandLine: `node.exe C:\\t\\fake-agent.ts ${FAKE_AGENT_MARKER}` });
  roots.resolve(200, { createTime: 556, image: 'C:\\x\\claude.exe', commandLine: `claude.exe ${FAKE_AGENT_MARKER}` });
  roots.resolve(300, null);
  assert.deepEqual(checkBrakeRoot(testP, roots, 100, 555), { ok: true, scope: 'test-root' });
  assert.deepEqual(checkBrakeRoot(testP, roots, 100, 554), { ok: false, reason: 'create-time-mismatch' });
  assert.deepEqual(checkBrakeRoot(testP, roots, 200, 556), { ok: false, reason: 'rejected' });
  assert.deepEqual(checkBrakeRoot(testP, roots, 300, 1), { ok: false, reason: 'rejected' });
  assert.deepEqual(roots.resolve(100, { createTime: 1, image: 'node.exe', commandLine: FAKE_AGENT_MARKER }), { pid: 100, state: 'registered', createTime: 555 }, 'resolved once');
  assert.deepEqual(checkBrakeRoot({ kind: 'real' }, null, 999, 1), { ok: true, scope: 'real-profile' });
  assert.equal(isFakeAgent('C:\\n\\NODE.EXE', `x ${FAKE_AGENT_MARKER} y`), true);
  assert.equal(isFakeAgent('C:\\n\\node.exe', `x ${FAKE_AGENT_MARKER}-not y`), false);
  assert.equal(isFakeAgent('C:\\n\\node.exe', 'node app.js'), false);
});

test('pairing output: stdout in the test profile; the real profile only with stdin and stdout both TTYs', () => {
  assert.deepEqual(decidePairingOutput({ kind: 'real' }, { stdin: true, stdout: true }), { print: 'console', reason: 'interactive' });
  assert.deepEqual(decidePairingOutput({ kind: 'real' }, { stdin: false, stdout: true }), { print: 'none', reason: 'not-interactive' });
  assert.deepEqual(decidePairingOutput({ kind: 'real' }, { stdin: true, stdout: false }), { print: 'none', reason: 'not-interactive' });
  const testP: TestProfile = { kind: 'test', testDir: 'C:\\t\\orchestra-test-x', orchestraHome: 'C:\\t\\orchestra-test-x\\orchestra', rootsDir: 'C:\\t\\orchestra-test-x\\roots', rootsDirGiven: false, rootPids: [] };
  assert.deepEqual(decidePairingOutput(testP, { stdin: false, stdout: false }), { print: 'stdout', reason: 'test-profile' });
});

// Deferred plan step-2 checks, shown as untested until their step lands (P7: N = 0 is "untested").
test.todo('a non-TTY real profile: the pairing route answers 403 (needs the HTTP server, step 4)');
test.todo('--test-root-pid resolves to pid:createTime through procguard and rejects a node.exe without the fake-agent marker (step 6)');

test('a non-TTY real profile (fake home) prints no pairing code and logs why pairing is off', async (t) => {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const con = captureConsole();
  const o = await start(detectFeatures(), FENCE_OK, { fetch: globalThis.fetch }, {
    argv: [], home, env: minimalEnv(), console: con.port, spawnBackend: whoamiSpy(whoamiEnglish('Medium Mandatory Level')).backend,
    tty: () => ({ stdin: false, stdout: false }), onStopSignal: () => () => {},
  });
  assert.equal(o.mode, 'working', JSON.stringify(con.all()));
  if (o.mode !== 'working') return;
  t.after(() => o.stop());
  assert.deepEqual(o.pairing, { print: 'none', reason: 'not-interactive' });
  assert.ok(!con.all().some((l) => /pairing code/.test(l)), con.all().join('\n'));
  assert.ok(con.out.includes('orchestrad: pairing is off: stdin and stdout are not both an interactive console'));
  const log = fs.readFileSync(path.join(home, '.orchestra', 'run', 'orchestrad.log'), 'utf8');
  assert.match(log, /"event":"pairing-disabled","fields":\{"why":"not-interactive"\}/);
  await o.stop();
});
