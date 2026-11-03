import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { PidEntry, ProvenSystemRoot, SpawnDecision, SpawnGateConfig } from '../../src/os/spawn.ts';
import {
  CODEX_APP_SERVER_ARGV, CODEX_EXE_REL, ENV_WHITELIST, LIBUV_ADDED_ENV, PROCGUARD_JOB_RE, SpawnGate, runInJobArgv, resolveSystemRoot,
} from '../../src/os/spawn.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { withTmp } from '../helpers/tmp.ts';

// The wrapped rules (orchestra app: owned sessions in procguard Jobs, r4 D4): procguard.exe run-in-job
// --name <job> --env-allowlist <file> -- <the inner rule's exe and argv>. The inner rule decides the exe,
// the argv, the cwd and the environment; the wrapped rule must be on; procguard's pin is checked before
// every start. A spy backend: nothing runs.

const ID = (p: string) => p;
const why = (d: SpawnDecision) => (d.allow ? `allow:${d.rule}` : d.reason);
const JOB = `orchestra-job-${'0'.repeat(32)}`;
const HASH = 'f'.repeat(64);

type Rig = { codex: string; pg: string; envFile: string; work: string; cwd: string; home: string; records: PidEntry[]; gate(extra?: Partial<SpawnGateConfig>): SpawnGate };

function rig(t: TestContext, spy = fakeSpawn(() => ({ hang: true }))): Rig {
  const dir = fs.realpathSync.native(withTmp(t));
  const appData = path.join(dir, 'AppData', 'Roaming');
  const codex = path.join(appData, CODEX_EXE_REL);
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, 'not really codex');
  const home = path.join(dir, 'orchestra');
  const site = path.join(home, 'runtime', 'procguard', HASH);
  fs.mkdirSync(site, { recursive: true });
  const pg = path.join(site, 'procguard.exe');
  fs.writeFileSync(pg, 'not really procguard');
  const envFile = path.join(site, 'env-codex-app-server.txt');
  const work = path.join(home, 'work');
  const cwd = path.join(work, 'a1b2');
  fs.mkdirSync(cwd, { recursive: true });
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const proven: ProvenSystemRoot = sys;
  const env = { SystemRoot: sys.path, windir: sys.path, APPDATA: appData, LOCALAPPDATA: path.join(dir, 'AppData', 'Local'), USERPROFILE: path.join(dir, 'profile'), PATH: 'C:\\evil', OPENAI_API_KEY: 'placeholder' };
  const records: PidEntry[] = [];
  return {
    codex, pg, envFile, work, cwd, home, records,
    gate: (extra = {}) => new SpawnGate({
      systemRoot: proven,
      rules: ['procguard-codex'],
      record: (e) => records.push(e),
      backend: spy.backend,
      realpath: ID,
      clock: makeRealClock(),
      env,
      envExtra: { 'codex-app-server': { CODEX_HOME: path.join(home, 'codex-home') } },
      cwd: { allowedRoots: [work], protectedDirs: [home], userHome: path.join(dir, 'profile'), ownedWorkRoot: work },
      procguard: [{ at: 'runtime', homeReal: home, sourceHash: HASH }],
      procguardPin: () => null,
      procguardEnv: { 'codex-app-server': envFile },
      ...extra,
    }),
  };
}

test('procguard-codex: exactly procguard run-in-job --name <job> --env-allowlist <its file> -- codex.exe app-server, in a cwd below the work root', (t) => {
  const r = rig(t);
  const g = r.gate();
  const argv = runInJobArgv(JOB, r.envFile, r.codex, CODEX_APP_SERVER_ARGV);
  assert.deepEqual([...argv], ['run-in-job', '--name', JOB, '--env-allowlist', r.envFile, '--', r.codex, 'app-server']);
  const ok = g.decide({ exe: r.pg, argv, cwd: r.cwd });
  assert.equal(why(ok), 'allow:procguard-codex');
  assert.ok(ok.allow && ok.job === JOB && ok.cwd === r.cwd && ok.exe === r.pg);
  const bad: [string, readonly string[], string][] = [
    ['job name', runInJobArgv('orchestra-job-1', r.envFile, r.codex, CODEX_APP_SERVER_ARGV), 'argv-mismatch'],
    ['env file', runInJobArgv(JOB, path.join(r.home, 'other.txt'), r.codex, CODEX_APP_SERVER_ARGV), 'argv-mismatch'],
    ['inner argv', runInJobArgv(JOB, r.envFile, r.codex, ['exec', 'rm -rf']), 'argv-mismatch'],
    ['inner extra arg', runInJobArgv(JOB, r.envFile, r.codex, ['app-server', '--x']), 'argv-mismatch'],
    ['inner exe', runInJobArgv(JOB, r.envFile, 'C:\\Windows\\System32\\cmd.exe', ['/c', 'x']), 'argv-mismatch'],
    ['inner exe relative', runInJobArgv(JOB, r.envFile, 'codex.exe', CODEX_APP_SERVER_ARGV), 'argv-mismatch'],
    ['no --', ['run-in-job', '--name', JOB, '--env-allowlist', r.envFile, r.codex, 'app-server'], 'argv-mismatch'],
    ['options swapped', ['run-in-job', '--env-allowlist', r.envFile, '--name', JOB, '--', r.codex, 'app-server'], 'argv-mismatch'],
    ['resident with arguments', ['run-in-job'], 'argv-mismatch'],
    ['procguard itself inside', runInJobArgv(JOB, r.envFile, r.pg, []), 'argv-mismatch'],
  ];
  for (const [what, a, want] of bad) assert.equal(why(g.decide({ exe: r.pg, argv: a, cwd: r.cwd })), want, what);
  // The cwd is the inner rule's: required, and below the work root.
  assert.equal(why(g.decide({ exe: r.pg, argv })), 'cwd-not-allowed');
  assert.equal(why(g.decide({ exe: r.pg, argv, cwd: r.home })), 'cwd-denied');
  // codex.exe started directly is another rule, off here: no codex.exe outside a Job.
  assert.equal(why(g.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd: r.cwd })), 'rule-not-enabled');
  // And the other way: with only codex-app-server on, the wrapped start is refused.
  const direct = r.gate({ rules: ['codex-app-server'], procguardEnv: undefined as never });
  assert.equal(why(direct.decide({ exe: r.pg, argv, cwd: r.cwd })), 'rule-not-enabled');
  assert.equal(why(direct.decide({ exe: r.codex, argv: CODEX_APP_SERVER_ARGV, cwd: r.cwd })), 'allow:codex-app-server');
});

test('procguard-codex: a procguard.exe that changed since it was built starts nothing (procguard-tampered); a link on either exe neither', (t) => {
  const r = rig(t);
  let pinWhy: string | null = null;
  const g = r.gate({ procguardPin: () => pinWhy });
  const argv = runInJobArgv(JOB, r.envFile, r.codex, CODEX_APP_SERVER_ARGV);
  assert.equal(why(g.decide({ exe: r.pg, argv, cwd: r.cwd })), 'allow:procguard-codex');
  pinWhy = 'procguard.exe is 00, built as ff';
  const d = g.decide({ exe: r.pg, argv, cwd: r.cwd });
  assert.equal(why(d), 'procguard-tampered');
  assert.ok(!d.allow && d.detail === pinWhy);
  const throwing = r.gate({ procguardPin: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.equal(why(throwing.decide({ exe: r.pg, argv, cwd: r.cwd })), 'procguard-tampered');
  const linked = r.gate({ realpath: (p) => (p === r.codex ? 'D:\\elsewhere\\codex.exe' : p) });
  assert.equal(why(linked.decide({ exe: r.pg, argv, cwd: r.cwd })), 'exe-reparsed');
  // The resident (rule procguard, no argv) is held to the same pin.
  const res = r.gate({ rules: ['procguard'], procguardPin: () => 'changed', procguardEnv: undefined as never });
  assert.equal(why(res.decide({ exe: r.pg, argv: [] })), 'procguard-tampered');
  assert.equal(why(r.gate({ rules: ['procguard'], procguardEnv: undefined as never }).decide({ exe: r.pg, argv: [] })), 'allow:procguard');
});

test('procguard-codex: procguard gets exactly the inner rule\'s environment (no PATH, no key), and the pid log names the Job', (t) => {
  const spy = fakeSpawn(() => ({ hang: true }));
  const r = rig(t, spy);
  const g = r.gate();
  const h = g.start({ exe: r.pg, argv: runInJobArgv(JOB, r.envFile, r.codex, CODEX_APP_SERVER_ARGV), cwd: r.cwd });
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0]!;
  assert.equal(call.exe, r.pg);
  assert.deepEqual(call.argv, ['run-in-job', '--name', JOB, '--env-allowlist', r.envFile, '--', r.codex, 'app-server']);
  assert.equal(call.opts.cwd, r.cwd);
  // The whitelist of codex-app-server as the rig's env source has it (no SystemDrive, TEMP or TMP there), plus CODEX_HOME.
  const inSource = ['SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  assert.deepEqual(Object.keys(call.opts.env).sort(), [...ENV_WHITELIST['codex-app-server'].filter((n) => inSource.includes(n)), 'CODEX_HOME'].sort());
  assert.equal(call.opts.env.CODEX_HOME, path.join(r.home, 'codex-home'));
  assert.ok(!('PATH' in call.opts.env) && !('OPENAI_API_KEY' in call.opts.env));
  assert.deepEqual(r.records.map((e) => [e.rule, e.exe, e.job]), [['procguard-codex', r.pg, JOB]]);
  h.kill();
});

test('envAllowlist: the names the gate hands the inner rule, then libuv\'s own list; names only, never a value', (t) => {
  const r = rig(t);
  const text = r.gate().envAllowlist('codex-app-server');
  const lines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  const given = ['SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME'];
  assert.deepEqual(lines.slice(0, given.length).sort(), [...given].sort());
  const libuv = LIBUV_ADDED_ENV.filter((n) => !given.some((g) => g.toLowerCase() === n.toLowerCase()));
  assert.deepEqual(lines.slice(given.length), libuv, 'libuv adds these to procguard\'s own environment, as it did to codex.exe');
  for (const l of lines) assert.match(l, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(!text.includes('codex-home') && !text.includes('placeholder') && !text.includes('evil'), 'no value is written');
});

test('the wrapped rules refuse a gate they cannot check: no pin, no env file, no site, an extra keyed on the wrapped rule', (t) => {
  const r = rig(t);
  assert.throws(() => r.gate({ procguardPin: undefined as never }), /without procguard's pin check/);
  assert.throws(() => r.gate({ procguardEnv: {} }), /needs procguardEnv\.codex-app-server/);
  assert.throws(() => r.gate({ procguard: [] }), /without a procguard site/);
  assert.throws(() => r.gate({ envExtra: { 'procguard-codex': { CODEX_HOME: 'C:\\x' } } as never }), /takes its inner rule's extras/);
  assert.throws(() => r.gate({ envExtra: {} }), /needs envExtra\.codex-app-server\.CODEX_HOME/);
  assert.ok(PROCGUARD_JOB_RE.test(JOB));
});
