import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { ProvenSystemRoot, SpawnDecision, SpawnGateConfig } from '../../src/os/spawn.ts';
import {
  CODEX_APP_SERVER_ARGV, CODEX_EXE_REL, ENV_WHITELIST, FAKE_CODEX_SCRIPT, LIBUV_ADDED_ENV, SpawnGate, TEST_RUNNER_MARKER as GATE_MARKER, resolveCodexExe,
  resolveSystemRoot,
} from '../../src/os/spawn.ts';
import { CwdPolicy } from '../../src/os/cwd.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { TEST_RUNNER_MARKER } from '../../src/runtime/test-profile.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { withTmp } from '../helpers/tmp.ts';

// The owned Codex step's spawn rules (orchestra app plan §2): codex-app-server runs exactly
// <APPDATA>\npm\...\codex.exe with argv ['app-server'], in a cwd below the owned work root, with its
// whitelist plus CODEX_HOME; codex-app-server-fake runs the fake app-server under node.exe and opens only
// under the test runner. The backend is a spy unless a test says otherwise: nothing runs.

const ID = (p: string) => p;
const why = (d: SpawnDecision) => (d.allow ? `allow:${d.rule}` : d.reason);

type Rig = { dir: string; appData: string; codex: string; home: string; work: string; gate(extra?: Partial<SpawnGateConfig>): SpawnGate };

function rig(t: TestContext): Rig {
  const dir = fs.realpathSync.native(withTmp(t));
  const appData = path.join(dir, 'AppData', 'Roaming');
  const codex = path.join(appData, CODEX_EXE_REL);
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, 'not really codex');
  const home = path.join(dir, 'orchestra');
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'a1b2'), { recursive: true });
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const proven: ProvenSystemRoot = sys;
  const env = { SystemRoot: sys.path, windir: sys.path, APPDATA: appData, LOCALAPPDATA: path.join(dir, 'AppData', 'Local'), USERPROFILE: path.join(dir, 'profile'), PATH: 'C:\\evil', OPENAI_API_KEY: 'placeholder' };
  return {
    dir, appData, codex, home, work,
    gate: (extra = {}) => new SpawnGate({
      systemRoot: proven,
      rules: ['codex-app-server'],
      record: () => {},
      backend: () => { throw new Error('rig: this gate must not spawn'); },
      realpath: ID,
      clock: makeRealClock(),
      env,
      envExtra: { 'codex-app-server': { CODEX_HOME: path.join(home, 'codex-home') } },
      cwd: { allowedRoots: [work], protectedDirs: [home], userHome: path.join(dir, 'profile'), ownedWorkRoot: work },
      ...extra,
    }),
  };
}

test('codex-app-server: exactly codex.exe below %APPDATA% with argv [app-server], in a cwd below the work root; anything else is refused with a reason', (t) => {
  const r = rig(t);
  const g = r.gate();
  const cwd = path.join(r.work, 'a1b2');
  const ok = g.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd });
  assert.deepEqual(ok, { allow: true, rule: 'codex-app-server', exe: r.codex, argv: ['app-server'], cwd });
  assert.equal(why(g.decide({ exe: r.codex, argv: ['app-server', '--listen', 'ws://0.0.0.0:1'], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.codex, argv: ['exec', 'rm -rf /'], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.codex, argv: [], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV })), 'cwd-not-allowed', 'the cwd is required');
  assert.equal(why(g.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd: r.home })), 'cwd-denied');
  assert.equal(why(g.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd: r.dir })), 'cwd-denied');
  // The npm shim and a codex.exe anywhere else are not the pinned exe.
  assert.equal(why(g.decide({ exe: path.join(r.appData, 'npm', 'codex.cmd'), argv: CODEX_APP_SERVER_ARGV, cwd })), 'script-shim');
  assert.equal(why(g.decide({ exe: path.join(r.dir, 'codex.exe'), argv: CODEX_APP_SERVER_ARGV, cwd })), 'unknown-exe');
  // Off unless the gate allows it.
  assert.equal(why(r.gate({ rules: ['whoami'] }).decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd })), 'rule-not-enabled');
});

test('codex-app-server: the child gets its whitelist and CODEX_HOME, nothing else the gate hands over (no PATH, no key)', (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ hang: true }));
  const g = r.gate({ backend: spy.backend });
  const h = g.start({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd: path.join(r.work, 'a1b2') });
  h.kill();
  const env = { ...spy.calls[0]!.opts.env };
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'CODEX_HOME', 'LOCALAPPDATA', 'SystemRoot', 'USERPROFILE', 'windir']);
  assert.equal(env.CODEX_HOME, path.join(r.home, 'codex-home'));
  assert.deepEqual([...ENV_WHITELIST['codex-app-server']], ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
  assert.equal(spy.calls[0]!.opts.cwd, path.join(r.work, 'a1b2'));
});

test('codex-app-server: refused at construction without CODEX_HOME (codex would use the user\'s own ~/.codex) or without %APPDATA%', (t) => {
  const r = rig(t);
  assert.throws(() => r.gate({ envExtra: {} }), /needs envExtra\.codex-app-server\.CODEX_HOME/);
  assert.throws(() => r.gate({ envExtra: { 'codex-app-server': { CODEX_HOME: 'relative' } } }), /CODEX_HOME, an absolute path/);
  assert.throws(() => r.gate({ env: { SystemRoot: 'C:\\Windows' } }), /codex-app-server enabled without codex\.exe below %APPDATA% \(appdata-unset\)/);
  // Without the rule, no APPDATA is needed.
  assert.doesNotThrow(() => r.gate({ rules: ['whoami'], env: { SystemRoot: 'C:\\Windows' }, envExtra: {} }));
});

test('resolveCodexExe: the pinned path when it exists and is its own realpath; else why not (the composition root turns the feature off)', (t) => {
  const r = rig(t);
  assert.deepEqual(resolveCodexExe({ APPDATA: r.appData }, realpath), { ok: true, path: r.codex });
  assert.deepEqual(resolveCodexExe({}, realpath), { ok: false, reason: 'appdata-unset' });
  assert.deepEqual(resolveCodexExe({ APPDATA: 'relative\\dir' }, realpath), { ok: false, reason: 'appdata-bad-path', detail: 'not-absolute' });
  assert.deepEqual(resolveCodexExe({ APPDATA: path.join(r.dir, 'nowhere') }, realpath), { ok: false, reason: 'missing', detail: 'ENOENT' });
  const moved = (p: string) => p.replace(r.dir, path.join(r.dir, 'elsewhere'));
  assert.equal(resolveCodexExe({ APPDATA: r.appData }, moved).ok, false);
  assert.equal((resolveCodexExe({ APPDATA: r.appData }, moved) as { reason: string }).reason, 'reparsed');
});

test('codex-app-server-fake: only under the test runner, only node.exe, only the fixture script', (t) => {
  const r = rig(t);
  const env = { SystemRoot: 'C:\\Windows', [TEST_RUNNER_MARKER]: 'child' };
  const fake = (extra: Partial<SpawnGateConfig> = {}) => r.gate({
    rules: ['codex-app-server-fake'], env, envExtra: { 'codex-app-server-fake': { CODEX_HOME: path.join(r.home, 'codex-home') } }, fakeCodexNode: process.execPath, ...extra,
  });
  assert.equal(GATE_MARKER, TEST_RUNNER_MARKER, 'spawn.ts restates the test runner marker of test-profile.ts');
  const g = fake();
  const cwd = path.join(r.work, 'a1b2');
  assert.equal(why(g.decide({ exe: process.execPath, argv: [FAKE_CODEX_SCRIPT], cwd })), 'allow:codex-app-server-fake');
  assert.equal(why(g.decide({ exe: process.execPath, argv: ['-e', 'evil()'], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: process.execPath, argv: [FAKE_CODEX_SCRIPT, '--x'], cwd })), 'argv-mismatch');
  assert.throws(() => fake({ env: { SystemRoot: 'C:\\Windows' } }), /only under the test runner/);
  assert.throws(() => fake({ fakeCodexNode: 'C:\\Windows\\System32\\cmd.exe' }), /runs under node\.exe/);
  assert.throws(() => fake({ fakeCodexNode: undefined as never }), /codex-app-server-fake enabled without fakeCodexNode/);
  // The fake rule's node.exe is no other rule's exe: without the rule enabled it reads rule-not-enabled.
  assert.equal(why(fake({ rules: [] }).decide({ exe: process.execPath, argv: [FAKE_CODEX_SCRIPT], cwd })), 'rule-not-enabled');
  assert.ok(fs.existsSync(FAKE_CODEX_SCRIPT), 'the fixture the rule names exists');
});

test('libuv adds its fixed list to a real child\'s env on Windows (PATH among them); LIBUV_ADDED_ENV is that list', () => {
  const env = Object.assign(Object.create(null) as Record<string, string>, { SystemRoot: process.env.SystemRoot!, ORCHESTRA_PROBE: '1' });
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).join(","))'], { env, windowsHide: true });
  const got = String(r.stdout).split(',').map((k) => k.toUpperCase()).sort();
  const want = [...new Set(['ORCHESTRA_PROBE', 'SYSTEMROOT', ...LIBUV_ADDED_ENV.filter((k) => process.env[k] !== undefined)])].sort();
  assert.deepEqual(got, want);
});

test('cwd: the owned work root is exempt from the AppData row and from the data dir it sits in, and from nothing else; nowhere else is either relaxed', () => {
  const user = 'C:\\Users\\u';
  const inAppData = `${user}\\AppData\\Local\\orch`;
  const policy = (home: string, extra: { ownedWorkRoot?: string; allowedRoots?: string[]; protectedDirs?: string[] } = {}) => new CwdPolicy({
    spec: { allowedRoots: extra.allowedRoots ?? [`${home}\\work`], protectedDirs: extra.protectedDirs ?? [home], userHome: user, ...(extra.ownedWorkRoot !== undefined ? { ownedWorkRoot: extra.ownedWorkRoot } : {}) },
    env: {}, systemRoot: 'C:\\Windows', realpath: ID,
  });
  const verdict = (p: CwdPolicy, cwd: string) => {
    const v = p.check(cwd);
    return v.ok ? 'ok' : `${v.reason}:${v.detail}`;
  };
  // A data dir in AppData (the test profile's sits in %TEMP%).
  const a = policy(inAppData, { ownedWorkRoot: `${inAppData}\\work` });
  assert.equal(verdict(a, `${inAppData}\\work\\0123456789abcdef0123`), 'ok');
  assert.equal(verdict(a, `${inAppData}\\work`), 'ok');
  assert.equal(verdict(a, `${inAppData}\\run`), 'protected:user-profile\\AppData', 'a sibling of the work root is not exempt');
  assert.equal(verdict(a, `${user}\\AppData\\Local\\Other`), 'protected:user-profile\\AppData');
  assert.equal(verdict(policy(inAppData), `${inAppData}\\work\\x`), 'protected:user-profile\\AppData', 'without the work root nothing is exempt');
  // A data dir in the profile (~\.orchestra): the protected data dir is exempt for its work root only.
  const dot = `${user}\\.orchestra`;
  const b = policy(dot, { ownedWorkRoot: `${dot}\\work` });
  assert.equal(verdict(b, `${dot}\\work\\x`), 'ok');
  assert.equal(verdict(policy(dot), `${dot}\\work\\x`), `protected:protected`);
  // Another protected dir inside the work root, or any other row, still holds.
  const c = policy(dot, { ownedWorkRoot: `${dot}\\work`, protectedDirs: [dot, `${dot}\\work\\keep`] });
  assert.equal(verdict(c, `${dot}\\work\\keep\\x`), 'protected:protected');
  assert.equal(verdict(c, `${dot}\\work\\other`), 'ok');
  const d = policy(dot, { ownedWorkRoot: `${dot}\\work`, protectedDirs: [dot, `${user}\\.ssh`] });
  assert.equal(verdict(d, `${user}\\.ssh\\x`), 'protected:user-profile\\.ssh');
  // An exempt root that is not one of the allowed roots refuses the policy.
  assert.throws(() => policy(dot, { ownedWorkRoot: `${dot}\\work`, allowedRoots: [`${dot}\\other`] }), /must be one of allowedRoots/);
  // Only orchestrad's own work dir is exempt: named work, directly in a protected dir (the data dir).
  assert.throws(() => policy(dot, { ownedWorkRoot: `${dot}\\elsewhere`, allowedRoots: [`${dot}\\elsewhere`] }), /must be named work/);
  const roaming = `${user}\\AppData\\Roaming\\work`;
  assert.throws(() => policy(dot, { ownedWorkRoot: roaming, allowedRoots: [roaming] }), /sit directly in a protected dir/);
  assert.throws(() => policy(dot, { ownedWorkRoot: 'C:\\', allowedRoots: ['C:\\'] }), /drive root/);
});
