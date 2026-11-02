import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { ProvenSystemRoot, SpawnDecision, SpawnGateConfig } from '../../src/os/spawn.ts';
import { CSC_FLAGS, ENV_NEVER, ENV_WHITELIST, PROCGUARD_SOURCE, SpawnGate, WHOAMI_ARGV, resolveSystemRoot } from '../../src/os/spawn.ts';
import type { CwdPolicySpec } from '../../src/os/cwd.ts';
import { CwdPolicy, MAIN_CHECKOUT, PROFILE_SUBDIRS, REPO_ROOT } from '../../src/os/cwd.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { junction, withTmp } from '../helpers/tmp.ts';

// alpha 0.2 step 1 (design §2.1, §5): a child gets its rule's env whitelist plus fixed extras, never
// this process's whole env; a caller-chosen cwd passes a rejection table and an allow list. The gate's
// System32 is the real %SystemRoot%, the realpath the identity, the backend a spy: nothing runs.

const HASH = 'a'.repeat(64);

/** A synthetic env source: the system variables, plus names no whitelist may let through. */
const SOURCE_ENV: Readonly<Record<string, string>> = Object.freeze({
  SystemRoot: 'C:\\Windows', SYSTEMDRIVE: 'C:', windir: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', PATH: 'C:\\evil;C:\\Windows\\System32',
  NODE_OPTIONS: '--require C:\\evil.js', node_path: 'C:\\evil', COR_PROFILER: '{00000000-0000-0000-0000-000000000000}', COMPlus_EnableDiagnostics: '1',
  LIB: 'C:\\evil', HTTPS_PROXY: 'http://proxy.example:8080', ANTHROPIC_API_KEY: 'placeholder-not-a-key', USERPROFILE: 'C:\\Users\\someone',
});

type Rig = { dir: string; whoami: string; csc: string; pg: string; out: string; gate(extra?: Partial<SpawnGateConfig>): SpawnGate };

function rig(t: TestContext): Rig {
  const dir = withTmp(t);
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok, JSON.stringify(sys));
  const proven: ProvenSystemRoot = sys;
  const home = path.join(dir, 'orchestra');
  const pgDir = path.join(home, 'runtime', 'procguard', HASH);
  const out = path.join(pgDir, 'procguard.new.exe');
  return {
    dir, out,
    whoami: path.join(sys.path, 'System32', 'whoami.exe'),
    csc: path.join(sys.path, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    pg: path.join(pgDir, 'procguard.exe'),
    gate: (extra = {}) => new SpawnGate({
      systemRoot: proven,
      rules: ['whoami', 'csc', 'procguard'],
      csc: { outAllowed: (p) => p.toLowerCase() === out.toLowerCase() },
      procguard: [{ at: 'runtime', homeReal: home, sourceHash: HASH }],
      record: () => {},
      backend: () => { throw new Error('rig: this gate must not spawn'); },
      realpath: (p: string) => p,
      clock: makeRealClock(),
      env: SOURCE_ENV,
      ...extra,
    }),
  };
}

const why = (d: SpawnDecision) => (d.allow ? `allow:${d.rule}` : d.reason);
const plain = (env: Readonly<Record<string, string>>) => ({ ...env });
const LIMITS = { timeoutMs: 5000, maxBytes: 1024 };

test('env: each rule\'s child gets exactly its whitelist from the source, in the whitelist\'s spelling; NODE_OPTIONS, NODE_PATH, COR_PROFILER, PATH, proxies and keys stay behind', async (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ exitCode: 0, pid: 77 }));
  const g = r.gate({ backend: spy.backend });
  assert.ok((await g.run({ exe: r.whoami, argv: WHOAMI_ARGV }, LIMITS)).ok);
  assert.ok((await g.run({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${r.out}`, PROCGUARD_SOURCE] }, LIMITS)).ok);
  g.start({ exe: r.pg, argv: [] }).kill();
  const [whoami, csc, pg] = spy.calls.map((c) => c.opts.env);
  const sys = { SystemRoot: 'C:\\Windows', SystemDrive: 'C:', windir: 'C:\\Windows' };
  assert.deepEqual(plain(whoami!), sys);
  assert.deepEqual(plain(csc!), { ...sys, TEMP: 'C:\\t', TMP: 'C:\\t' });
  assert.deepEqual(plain(pg!), sys);
  for (const env of [whoami!, csc!, pg!]) {
    assert.equal(Object.getPrototypeOf(env), null);
    assert.ok(Object.isFrozen(env));
    const lower = Object.keys(env).map((k) => k.toLowerCase());
    for (const banned of ['node_options', 'node_path', 'cor_profiler', 'complus_enablediagnostics', 'lib', 'path', 'https_proxy', 'anthropic_api_key', 'userprofile']) {
      assert.ok(!lower.includes(banned), banned);
    }
  }
});

test('env: NODE_OPTIONS and NODE_PATH are on no whitelist and can never be added as an extra, in any spelling', (t) => {
  const r = rig(t);
  assert.deepEqual([...ENV_NEVER], ['NODE_OPTIONS', 'NODE_PATH']);
  for (const names of Object.values(ENV_WHITELIST)) {
    for (const n of names) assert.ok(!/^node_(options|path)$/i.test(n), n);
  }
  assert.ok(Object.isFrozen(ENV_WHITELIST) && Object.values(ENV_WHITELIST).every((l) => Object.isFrozen(l)), 'no module can widen a whitelist');
  for (const key of ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'Node_Path']) {
    assert.throws(() => r.gate({ envExtra: { whoami: { [key]: '--require x' } } }), /is never handed to a child/, key);
  }
});

test('env: read once at construction (a later change to the source reaches no child) and own entries only (nothing from Object.prototype)', async (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ exitCode: 0 }));
  const source: Record<string, string> = { SystemRoot: 'C:\\Windows' };
  const g = r.gate({ backend: spy.backend, env: source });
  source.SystemRoot = 'C:\\evil';
  source.windir = 'C:\\evil';
  const proto = Object.prototype as Record<string, unknown>;
  proto.SystemDrive = 'Z:';
  try {
    assert.ok((await g.run({ exe: r.whoami, argv: WHOAMI_ARGV }, LIMITS)).ok);
    const late = r.gate({ backend: spy.backend, env: { SystemRoot: 'C:\\Windows' } });
    assert.ok((await late.run({ exe: r.whoami, argv: WHOAMI_ARGV }, LIMITS)).ok);
  } finally {
    delete proto.SystemDrive;
  }
  assert.deepEqual(plain(spy.calls[0]!.opts.env), { SystemRoot: 'C:\\Windows' });
  assert.deepEqual(plain(spy.calls[1]!.opts.env), { SystemRoot: 'C:\\Windows' });
});

test('env: fixed extras reach only their own rule; a bad name, a non-string, a whitelist clash, an unknown rule or a proxy with user:pass@ refuses the gate', async (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ exitCode: 0 }));
  const g = r.gate({ backend: spy.backend, envExtra: { procguard: { NO_PROXY: '127.0.0.1,localhost', HTTPS_PROXY: 'http://proxy.example:8080' } } });
  assert.ok((await g.run({ exe: r.whoami, argv: WHOAMI_ARGV }, LIMITS)).ok);
  g.start({ exe: r.pg, argv: [] }).kill();
  assert.equal(spy.calls[0]!.opts.env.NO_PROXY, undefined, 'whoami has no extras');
  assert.equal(spy.calls[1]!.opts.env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(spy.calls[1]!.opts.env.HTTPS_PROXY, 'http://proxy.example:8080');
  const bad: [unknown, RegExp][] = [
    [{ whoami: { 'A=B': 'x' } }, /bad variable name/],
    [{ whoami: { '': 'x' } }, /bad variable name/],
    [{ whoami: { X: 7 } }, /must be a string without NUL/],
    [{ whoami: { X: 'a\0b' } }, /must be a string without NUL/],
    [{ whoami: { systemroot: 'C:\\evil' } }, /already on the rule's whitelist/],
    [{ whoami: 'X=1' }, /must be a record of strings/],
    [{ curl: { X: '1' } }, /unknown rule curl/],
    [{ procguard: { HTTPS_PROXY: 'http://user:secret@proxy.example:8080' } }, /user:pass@/],
    [{ procguard: { all_proxy: 'socks5://u@proxy.example:1080' } }, /user:pass@/],
    // No scheme: the URL parser sees scheme `user:` and no userinfo; curl and npm read credentials.
    [{ procguard: { HTTPS_PROXY: 'user:secret@proxy.example:8080' } }, /user:pass@/],
    [{ procguard: { https_proxy: 'u@h:1' } }, /user:pass@/],
    [{ procguard: { FTP_PROXY: 'http://u:p@proxy.example:21' } }, /user:pass@/],
    [{ procguard: { socks_proxy: 'u:p@proxy.example:1080' } }, /user:pass@/],
    [{ procguard: { npm_config_https_proxy: 'http://u:p@proxy.example:8080' } }, /user:pass@/],
    [{ procguard: { GLOBAL_AGENT_HTTP_PROXY: 'u:p@proxy.example' } }, /user:pass@/],
    [{ whoami: { Foo: '1', FOO: '2' } }, /given twice/],
    [{ procguard: { NO_PROXY: 'a', no_proxy: 'b' } }, /given twice/],
    ['NO_PROXY=x', /envExtra must be a record per rule/],
  ];
  for (const [envExtra, re] of bad) assert.throws(() => r.gate({ envExtra: envExtra as never }), re, JSON.stringify(envExtra));
});

test('env: the gate is not built without an env source (no default, never process.env behind the caller\'s back)', (t) => {
  const r = rig(t);
  for (const env of [undefined, null, 'SystemRoot=C:\\Windows']) {
    assert.throws(() => r.gate({ env: env as never }), /env is required, there is no default/, String(env));
  }
});

test('cwd: the existing rules run in their exe\'s directory and are refused a caller cwd; a non-string cwd is a bad request', (t) => {
  const r = rig(t);
  const g = r.gate({ cwd: { allowedRoots: [r.dir], protectedDirs: [], userHome: 'C:\\Users\\nobody-here' } });
  assert.equal(why(g.decide({ exe: r.whoami, argv: WHOAMI_ARGV, cwd: r.dir })), 'cwd-not-allowed');
  assert.equal(why(g.decide({ exe: r.pg, argv: [], cwd: r.dir })), 'cwd-not-allowed');
  assert.equal(why(g.decide({ exe: r.whoami, argv: WHOAMI_ARGV, cwd: 7 as unknown as string })), 'bad-request');
  const d = g.decide({ exe: r.whoami, argv: WHOAMI_ARGV });
  assert.ok(d.allow && d.cwd === path.dirname(r.whoami), JSON.stringify(d));
  // cwd stays out of the option bag: only `shell` is an option.
  assert.equal(why(g.decide({ exe: r.whoami, argv: WHOAMI_ARGV, options: { cwd: r.dir } })), 'option-not-allowed');
  // A policy spec the gate cannot check refuses the gate.
  assert.throws(() => r.gate({ cwd: { allowedRoots: ['relative'], protectedDirs: [], userHome: 'C:\\Users\\x' } }), /allowed root rejected/);
});

const ID = (p: string) => p;
const SPEC: CwdPolicySpec = { allowedRoots: ['D:\\orch-test\\work'], protectedDirs: ['D:\\orch-test\\home', 'E:\\dsh-home', 'E:\\claude-cfg'], userHome: 'C:\\Users\\alice' };
const CWD_ENV = { USERPROFILE: 'C:\\Users\\alice', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
const policy = (over: { spec?: Partial<CwdPolicySpec>; env?: Record<string, string>; realpath?: (p: string) => string } = {}) =>
  new CwdPolicy({ spec: { ...SPEC, ...over.spec }, env: over.env ?? CWD_ENV, systemRoot: 'C:\\Windows', realpath: over.realpath ?? ID });
const verdict = (v: ReturnType<CwdPolicy['check']>) => (v.ok ? 'ok' : v.detail === undefined ? v.reason : `${v.reason}:${v.detail}`);

test('cwd policy: the rejection table (drive roots, the profile and its AppData/.ssh/.aws/.claude/.dsh, SystemRoot, Program Files*, this repo, r4 §5.3 dirs) and the allow list', () => {
  assert.deepEqual([...PROFILE_SUBDIRS], ['AppData', '.ssh', '.aws', '.claude', '.dsh']);
  const p = policy();
  const cases: [string, string][] = [
    ['D:\\orch-test\\work', 'ok'],
    ['D:\\orch-test\\work\\s1', 'ok'],
    ['d:\\ORCH-TEST\\work\\s1\\', 'ok'],
    ['C:\\', 'drive-root:C:\\'],
    ['D:\\', 'drive-root:D:\\'],
    ['C:\\Users\\alice', 'protected:user-profile'],
    ['c:\\users\\ALICE', 'protected:user-profile'],
    ['C:\\Users', 'protected:user-profile'],
    ['C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data', 'protected:user-profile\\AppData'],
    ['C:\\Users\\alice\\.ssh', 'protected:user-profile\\.ssh'],
    ['C:\\Users\\alice\\.aws\\x', 'protected:user-profile\\.aws'],
    ['C:\\Users\\alice\\.claude', 'protected:user-profile\\.claude'],
    ['C:\\Users\\alice\\.dsh\\sessions', 'protected:user-profile\\.dsh'],
    ['C:\\Users\\alice\\Documents\\proj', 'outside-allowed:C:\\Users\\alice\\Documents\\proj'],
    ['C:\\Windows', 'protected:system-root'],
    ['C:\\Windows\\System32', 'protected:system-root'],
    ['C:\\Program Files\\Git', 'protected:program-files'],
    ['C:\\Program Files (x86)', 'protected:program-files'],
    ['F:\\Program Files Custom\\x', 'protected:program-files'],
    [REPO_ROOT, 'protected:repo'],
    [path.join(REPO_ROOT, 'src'), 'protected:repo'],
    [path.dirname(REPO_ROOT), 'protected:repo'],
    ['D:\\orch-test\\home\\claude\\0123456789abcdef0123', 'protected:protected'],
    ['D:\\orch-test', 'protected:protected'],
    ['E:\\dsh-home', 'protected:protected'],
    ['E:\\claude-cfg\\projects', 'protected:protected'],
    ['relative\\x', 'bad-path:not-absolute'],
    ['\\\\server\\share\\x', 'bad-path:unc'],
    ['D:\\orch-test\\work\\a:b', 'bad-path:ads'],
  ];
  for (const [cwd, want] of cases) assert.equal(verdict(p.check(cwd)), want, cwd);
  // An empty allow list allows nothing; the table still names what it refuses first.
  const none = policy({ spec: { allowedRoots: [] } });
  assert.equal(verdict(none.check('D:\\orch-test\\work\\s1')), 'outside-allowed:D:\\orch-test\\work\\s1');
  assert.equal(verdict(none.check('C:\\Windows')), 'protected:system-root');
  // %USERPROFILE% from the env counts as well as the userHome handed in.
  const other = policy({ env: { USERPROFILE: 'C:\\Users\\bob' } });
  assert.equal(verdict(other.check('C:\\Users\\bob\\.ssh')), 'protected:user-profile\\.ssh');
});

test('cwd policy: a junctioned cwd, a missing one, and a protected dir reached through its real path are refused', () => {
  const links: Record<string, string> = { 'd:\\orch-test\\work\\link': 'D:\\elsewhere', 'e:\\claude-cfg': 'E:\\real-cfg' };
  const rp = (p: string) => {
    if (p.toLowerCase().includes('missing')) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return links[p.toLowerCase()] ?? p;
  };
  const p = policy({ realpath: rp });
  assert.equal(verdict(p.check('D:\\orch-test\\work\\link')), 'reparsed:D:\\elsewhere');
  assert.equal(verdict(p.check('D:\\orch-test\\work\\missing')), 'unresolved:ENOENT');
  assert.ok(p.table().some((e) => e.label === 'protected' && e.path === 'E:\\real-cfg'), 'the real form of a junctioned protected dir is in the table');
  const wide = policy({ realpath: rp, spec: { allowedRoots: ['E:\\'] } });
  assert.equal(verdict(wide.check('E:\\real-cfg\\x')), 'protected:protected');
});

test('cwd policy: on the real file system a junction under the allowed root is refused, a plain subdirectory allowed', (t) => {
  const dir = withTmp(t);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 's1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  junction(dir, path.join(work, 'j'), path.join(dir, 'elsewhere'));
  // userHome names no real folder and the env source is empty, so the profile rows do not cover this
  // temp dir (the next test shows what they do to a temp dir under the real profile).
  const p = new CwdPolicy({ spec: { allowedRoots: [work], protectedDirs: [], userHome: 'C:\\Users\\nobody-here' }, env: {}, systemRoot: 'C:\\Windows', realpath });
  assert.equal(verdict(p.check(path.join(work, 's1'))), 'ok');
  const j = p.check(path.join(work, 'j'));
  assert.ok(!j.ok && j.reason === 'reparsed', JSON.stringify(j));
  const missing = p.check(path.join(work, 'nope'));
  assert.ok(!missing.ok && missing.reason === 'unresolved', JSON.stringify(missing));
});

test('cwd policy: a redirected AppData and the main checkout of a worktree are refused too', () => {
  const p = policy({
    env: { ...CWD_ENV, APPDATA: 'D:\\Redirected\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    spec: { allowedRoots: ['D:\\'], repoRoots: ['D:\\other-checkout'] },
  });
  assert.equal(verdict(p.check('D:\\Redirected\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles')), 'protected:user-profile\\AppData');
  assert.equal(verdict(p.check('D:\\Redirected')), 'protected:user-profile\\AppData');
  assert.equal(verdict(p.check('D:\\Redirected-not\\x')), 'ok');
  // LOCALAPPDATA inside the profile's AppData adds no second row.
  assert.equal(p.table().filter((e) => e.label === 'user-profile\\AppData').length, 2);
  assert.equal(verdict(p.check('D:\\other-checkout\\.tools')), 'protected:repo');
  if (MAIN_CHECKOUT !== null) {
    // This copy runs from <main>\.claude\worktrees\<name>: the main checkout's code and the sibling worktrees are refused.
    assert.equal(verdict(p.check(path.join(MAIN_CHECKOUT, 'src'))), 'protected:repo');
    assert.equal(verdict(p.check(path.join(MAIN_CHECKOUT, '.claude', 'worktrees', 'sibling'))), 'protected:repo');
  }
  assert.throws(() => policy({ spec: { repoRoots: 'D:\\x' as never } }), /repoRoots must be a list/);
});

test('cwd policy: a work dir under %USERPROFILE%\\AppData\\Local\\Temp (where the test profile\'s dir lives by default) is refused by the AppData row; an open conflict, pinned here', () => {
  const p = policy({ spec: { allowedRoots: ['C:\\Users\\alice\\AppData\\Local\\Temp\\orchestra-test-x\\work'] } });
  assert.equal(verdict(p.check('C:\\Users\\alice\\AppData\\Local\\Temp\\orchestra-test-x\\work\\s1')), 'protected:user-profile\\AppData');
});

test('cwd policy: a spec it cannot check refuses the policy; a field left out is never read from Object.prototype', () => {
  const build = (spec: unknown, rp: unknown = ID) => () => new CwdPolicy({ spec: spec as never, env: {}, systemRoot: 'C:\\Windows', realpath: rp as never });
  assert.throws(build({ protectedDirs: [], userHome: 'C:\\Users\\a' }), /allowedRoots is required/);
  assert.throws(build({ allowedRoots: [], userHome: 'C:\\Users\\a' }), /protectedDirs is required/);
  assert.throws(build({ allowedRoots: [], protectedDirs: [] }), /userHome rejected/);
  assert.throws(build({ allowedRoots: ['\\\\srv\\x'], protectedDirs: [], userHome: 'C:\\Users\\a' }), /allowed root rejected/);
  assert.throws(build({ allowedRoots: [], protectedDirs: ['x'], userHome: 'C:\\Users\\a' }), /protected dir rejected/);
  assert.throws(build({ allowedRoots: [], protectedDirs: [], userHome: 'C:\\Users\\a' }, null), /realpath is required/);
  const proto = Object.prototype as Record<string, unknown>;
  proto.allowedRoots = ['C:\\'];
  try {
    assert.throws(build({ protectedDirs: [], userHome: 'C:\\Users\\a' }), /allowedRoots is required/);
  } finally {
    delete proto.allowedRoots;
  }
});
