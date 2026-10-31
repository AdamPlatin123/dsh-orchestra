import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { PidEntry, ProvenSystemRoot, SpawnDecision, SpawnGateConfig, SpawnRequest } from '../../src/os/spawn.ts';
import {
  CSC_FLAGS, HANDLE_KEYS, PROCGUARD_BUILD_EXE, PROCGUARD_SOURCE, PidLog, SpawnGate, SpawnRefusedError, TOAST_FLAGS, WHOAMI_ARGV, resolveSystemRoot,
} from '../../src/os/spawn.ts';
import { makeWriteFence, realpath } from '../../src/fs/node-io.ts';
import type { Clock, FireHandler } from '../../src/runtime/clock.ts';
import { VirtualClock, makeRealClock } from '../../src/runtime/clock.ts';
import type { FakeBehavior } from '../helpers/fake-spawn.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { junction, put, withTmp } from '../helpers/tmp.ts';

// The gate's System32 is the real %SystemRoot% (resolveSystemRoot is the only way to name one), but
// the rig's realpath is the identity and the backend a spy, or one that fails the test when called:
// no exe is looked at or run. The procguard sites live in a temp data dir.

/** backend, realpath and clock are required; a gate that should never spawn gets this backend. */
const NO_SPAWN = { backend: () => { throw new Error('rig: this gate must not spawn'); }, realpath: (p: string) => p, clock: makeRealClock() };

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const SCRIPT = Buffer.from('Write-Output shown', 'utf16le').toString('base64');

type Rig = {
  dir: string; home: string; sys: ProvenSystemRoot; whoami: string; ps: string; csc: string; pg: string; out: string; pids: PidEntry[];
  gate(extra?: Partial<SpawnGateConfig>): SpawnGate;
};

function proven(): ProvenSystemRoot {
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok, JSON.stringify(sys));
  return sys;
}

function rig(t: TestContext): Rig {
  const dir = withTmp(t);
  const sys = proven();
  const home = path.join(dir, 'orchestra');
  const pgDir = path.join(home, 'runtime', 'procguard', HASH);
  const out = path.join(pgDir, 'procguard.new.exe');
  const pids: PidEntry[] = [];
  return {
    dir, home, sys, pids, out,
    whoami: path.join(sys.path, 'System32', 'whoami.exe'),
    ps: path.join(sys.path, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    csc: path.join(sys.path, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    pg: path.join(pgDir, 'procguard.exe'),
    gate: (extra = {}) => new SpawnGate({
      systemRoot: sys,
      rules: ['whoami', 'csc', 'procguard'],
      csc: { outAllowed: (p) => p.toLowerCase() === out.toLowerCase() },
      procguard: [{ at: 'runtime', homeReal: home, sourceHash: HASH }, { at: 'build' }],
      record: (e) => pids.push(e),
      ...NO_SPAWN,
      ...extra,
    }),
  };
}

const why = (d: SpawnDecision) => (d.allow ? `allow:${d.rule}` : d.reason);

test('whoami: only the exact argv', (t) => {
  const r = rig(t);
  const g = r.gate();
  assert.equal(why(g.decide({ exe: r.whoami, argv: WHOAMI_ARGV })), 'allow:whoami');
  assert.equal(why(g.decide({ exe: r.whoami.toUpperCase(), argv: WHOAMI_ARGV })), 'allow:whoami');
  for (const argv of [[], ['/groups'], ['/GROUPS', '/fo', 'csv', '/nh'], ['/groups', '/fo', 'csv', '/nh', '/all'], ['/all']]) {
    assert.equal(why(g.decide({ exe: r.whoami, argv })), 'argv-mismatch', argv.join(' '));
  }
});

test('PowerShell: the toast rule cannot be enabled before os/toast-script.ts exists (step 17), so every PowerShell argv is refused', (t) => {
  const r = rig(t);
  assert.throws(() => r.gate({ rules: ['powershell-toast'] }), /powershell-toast needs the constant script of os\/toast-script\.ts/);
  assert.throws(() => r.gate({ rules: ['whoami', 'powershell-toast'] }), /step 17/);
  const g = r.gate();
  const other = Buffer.from('Remove-Item C:\\x', 'utf16le').toString('base64');
  const variants: string[][] = [
    [...TOAST_FLAGS, SCRIPT],
    [...TOAST_FLAGS, other],
    [...TOAST_FLAGS],
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden', '-Command', 'Get-Date'],
    ['-File', 'C:\\x.ps1'],
    [],
  ];
  for (const argv of variants) assert.equal(why(g.decide({ exe: r.ps, argv })), 'rule-not-enabled', argv.join(' '));
});

test('procguard: only from the data dir\'s runtime\\procguard\\<hash>\\ or the repo\'s build\\, with no arguments or only --protect', (t) => {
  const r = rig(t);
  const g = r.gate();
  assert.equal(why(g.decide({ exe: r.pg, argv: [] })), 'allow:procguard');
  assert.equal(why(g.decide({ exe: PROCGUARD_BUILD_EXE, argv: [] })), 'allow:procguard');
  assert.equal(why(g.decide({ exe: r.pg, argv: ['--protect', '1234:133000000000000000'] })), 'allow:procguard');
  assert.equal(why(g.decide({ exe: r.pg, argv: ['--protect', '1:2,3:4'] })), 'allow:procguard');
  for (const argv of [['--protect'], ['--protect', ''], ['--protect', 'x'], ['--protect', '1:2,'], ['--protect', '0:2'], ['--protect', '1:2', '--run'], ['run-in-job', 'cmd.exe'], ['--kill-tree', '1']]) {
    assert.equal(why(g.decide({ exe: r.pg, argv })), 'argv-mismatch', argv.join(' '));
  }
  for (const elsewhere of [
    path.join(r.dir, 'build', 'procguard.exe'),
    path.join(r.home, 'runtime', 'procguard', OTHER_HASH, 'procguard.exe'),
    path.join(r.home, 'runtime', 'procguard.exe'),
    path.join(r.dir, 'evil', 'procguard.exe'),
  ]) {
    assert.equal(why(g.decide({ exe: elsewhere, argv: [] })), 'unknown-exe', elsewhere);
  }
});

test('csc: the fixed vector, only native/procguard/ProcGuard.cs, and an /out: in a procguard site that the write fence allows', (t) => {
  const r = rig(t);
  const g = r.gate();
  const run = (out: string, source = PROCGUARD_SOURCE) => why(g.decide({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${out}`, source] }));
  assert.equal(run(r.out), 'allow:csc');
  assert.equal(run(path.join(r.dir, 'elsewhere.exe')), 'out-path-denied');
  assert.equal(run(r.out.replace(/\.exe$/, '.dll')), 'out-path-denied');
  assert.equal(run(path.join(path.dirname(r.out), 'not-allowed-by-fence.exe')), 'out-path-denied', 'the fence verdict still applies');
  const otherSite = path.join(r.home, 'runtime', 'procguard', OTHER_HASH, 'procguard.exe');
  const permissive = r.gate({ csc: { outAllowed: () => true } });
  assert.equal(why(permissive.decide({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${otherSite}`, PROCGUARD_SOURCE] })), 'out-path-denied', 'a site the gate does not know');
  assert.equal(why(permissive.decide({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${path.join(r.dir, 'x.exe')}`, PROCGUARD_SOURCE] })), 'out-path-denied');
  const throwing = r.gate({ csc: { outAllowed: () => { throw new Error('fence broke'); } } });
  assert.equal(why(throwing.decide({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${r.out}`, PROCGUARD_SOURCE] })), 'out-path-denied');
  assert.equal(run(r.out, put(path.join(r.dir, 'native', 'procguard', 'ProcGuard.cs'), '')), 'argv-mismatch', 'a look-alike source elsewhere');
  assert.equal(run(r.out, path.join(r.dir, 'other.cs')), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.csc, argv: [...CSC_FLAGS, '/define:M1', `/out:${r.out}`, PROCGUARD_SOURCE] })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.csc, argv: [...CSC_FLAGS.slice(1), `/out:${r.out}`, PROCGUARD_SOURCE] })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: r.csc, argv: [...CSC_FLAGS, PROCGUARD_SOURCE, `/out:${r.out}`] })), 'argv-mismatch');
});

test('.cmd, .bat, relative paths, shells, other options and unknown exes are refused with a reason', (t) => {
  const r = rig(t);
  const g = r.gate();
  const shim = path.join(r.dir, 'npm', 'claude.cmd');
  const bat = path.join(r.dir, 'npm', 'dsh.bat');
  const cases: [SpawnRequest, string][] = [
    [{ exe: shim, argv: [] }, 'script-shim'],
    [{ exe: shim.toUpperCase(), argv: [] }, 'script-shim'],
    [{ exe: bat, argv: [] }, 'script-shim'],
    [{ exe: 'whoami.exe', argv: WHOAMI_ARGV }, 'not-absolute'],
    [{ exe: 'System32\\whoami.exe', argv: WHOAMI_ARGV }, 'not-absolute'],
    [{ exe: '\\\\server\\share\\whoami.exe', argv: WHOAMI_ARGV }, 'bad-exe-path'],
    [{ exe: `${r.whoami}:stream`, argv: WHOAMI_ARGV }, 'bad-exe-path'],
    [{ exe: r.whoami, argv: WHOAMI_ARGV, options: { shell: true } }, 'shell'],
    [{ exe: r.whoami, argv: WHOAMI_ARGV, options: { shell: 'cmd.exe' } }, 'shell'],
    [{ exe: r.whoami, argv: WHOAMI_ARGV, options: { cwd: r.dir } }, 'option-not-allowed'],
    [{ exe: r.whoami, argv: WHOAMI_ARGV, options: { env: {} } }, 'option-not-allowed'],
    [{ exe: path.join(r.sys.path, 'System32', 'cmd.exe'), argv: ['/c', 'echo'] }, 'unknown-exe'],
    [{ exe: path.join(r.sys.path, 'System32', 'whoami.ps1'), argv: [] }, 'not-exe'],
    [{ exe: r.whoami, argv: 'groups' as unknown as string[] }, 'bad-request'],
    [{ exe: r.whoami, argv: [1 as unknown as string] }, 'bad-request'],
    [null as unknown as SpawnRequest, 'bad-request'],
    [{ exe: 7, argv: [] } as unknown as SpawnRequest, 'bad-request'],
  ];
  for (const [req, reason] of cases) assert.equal(why(g.decide(req)), reason, JSON.stringify(req));
  assert.equal(why(g.decide({ exe: r.whoami, argv: WHOAMI_ARGV, options: { shell: false } })), 'allow:whoami');
});

test('a rule outside the gate\'s phase is refused; an exe that is missing or a link is refused', (t) => {
  const r = rig(t);
  const narrow = r.gate({ rules: ['whoami'] });
  assert.equal(why(narrow.decide({ exe: r.csc, argv: [] })), 'rule-not-enabled');
  assert.equal(why(narrow.decide({ exe: r.pg, argv: [] })), 'rule-not-enabled');
  const missing = r.gate({ rules: ['whoami'], realpath: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.equal(why(missing.decide({ exe: r.whoami, argv: WHOAMI_ARGV })), 'exe-unresolved');
  const linked = r.gate({ rules: ['whoami'], realpath: (p) => (p.toLowerCase().endsWith('whoami.exe') ? 'C:\\elsewhere\\whoami.exe' : p) });
  assert.equal(why(linked.decide({ exe: r.whoami, argv: WHOAMI_ARGV })), 'exe-reparsed');
  // With the minted native realpath the real whoami.exe resolves to itself; it is looked at, not run.
  assert.equal(why(r.gate({ rules: ['whoami'], realpath }).decide({ exe: r.whoami, argv: WHOAMI_ARGV })), 'allow:whoami');
  // There is no default realpath any more: a gate without one is not built.
  assert.throws(() => r.gate({ rules: ['whoami'], realpath: undefined }), /realpath is required/);
});

test('the gate takes only a SystemRoot that resolveSystemRoot proved: no string, no look-alike, no junctioned System32', (t) => {
  const r = rig(t);
  const record = () => {};
  const build = (systemRoot: unknown) => () => new SpawnGate({ systemRoot: systemRoot as ProvenSystemRoot, rules: ['whoami'], record, ...NO_SPAWN });
  for (const fake of [r.sys.path, { ok: true, path: r.sys.path }, { ...r.sys }, { ok: true, path: path.join(r.dir, 'Windows') }, null, undefined]) {
    assert.throws(build(fake), /systemRoot must be the ok result of resolveSystemRoot\(\)/, JSON.stringify(fake));
  }
  assert.ok(Object.isFrozen(r.sys), 'a proven root cannot be pointed elsewhere afterwards');
  assert.throws(() => {
    (r.sys as { path: string }).path = path.join(r.dir, 'Windows');
  }, TypeError);
  // A System32 reached through a junction never becomes a proven root in the first place.
  const fake = path.join(r.dir, 'Fake');
  put(path.join(r.dir, 'RealSys', 'System32', 'whoami.exe'), '');
  junction(r.dir, path.join(fake, 'System32'), path.join(r.dir, 'RealSys', 'System32'));
  const viaJunction = resolveSystemRoot({ SystemRoot: fake }, realpath);
  assert.equal(viaJunction.ok, false);
  assert.throws(build(viaJunction), /resolveSystemRoot/);
  assert.equal(new SpawnGate({ systemRoot: proven(), rules: ['whoami'], record, ...NO_SPAWN }).decide({ exe: r.whoami, argv: [] }).allow, false);
});

test('the gate refuses to be built with a rule it cannot check, a missing recorder or a bad procguard site', (t) => {
  const r = rig(t);
  const base = { systemRoot: r.sys, record: () => {}, ...NO_SPAWN };
  assert.throws(() => new SpawnGate({ ...base, rules: ['csc'] }), /csc enabled without an \/out: verdict and a procguard site/);
  assert.throws(() => new SpawnGate({ ...base, rules: ['csc'], csc: { outAllowed: () => true } }), /procguard site/);
  const site = { procguard: [{ at: 'build' as const }] };
  assert.throws(() => new SpawnGate({ ...base, ...site, rules: ['csc'], csc: { outAllowed: 'yes' } as unknown as { outAllowed(o: string): boolean } }), /csc enabled without an \/out: verdict/);
  assert.throws(() => new SpawnGate({ ...base, rules: ['procguard'] }), /procguard enabled without a site/);
  assert.throws(() => new SpawnGate({ ...base, rules: ['curl' as 'whoami'] }), /unknown rule curl/);
  assert.throws(() => new SpawnGate({ systemRoot: r.sys, rules: ['whoami'] } as unknown as SpawnGateConfig), /record is required/);
  assert.throws(() => new SpawnGate({ ...base, rules: [], procguard: [{ at: 'runtime', homeReal: r.home, sourceHash: 'A'.repeat(64) }] }), /64 lowercase hex/);
  assert.throws(() => new SpawnGate({ ...base, rules: [], procguard: [{ at: 'runtime', homeReal: r.home, sourceHash: '..\\..\\x' }] }), /64 lowercase hex/);
  assert.throws(() => new SpawnGate({ ...base, rules: [], procguard: [{ at: 'runtime', homeReal: 'relative', sourceHash: HASH }] }), /procguard data dir rejected/);
  assert.throws(() => new SpawnGate({ ...base, rules: [], procguard: [{ at: 'anywhere', exe: 'C:\\x\\procguard.exe' } as unknown as { at: 'build' }] }), /a procguard site is/);
});

test('decide() reads the request once: a getter or Proxy cannot pass one argv to the checks and spawn another', async (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ exitCode: 0 }));
  const g = r.gate({ backend: spy.backend });
  const limits = { timeoutMs: 5000, maxBytes: 1024 };
  // The PoC: the old decide() read argv four times (isArray, every, the argv check, the copy it
  // spawned); a getter that turns on the fourth read slipped '/all' past the exact-argv rule.
  let argvReads = 0;
  const flipArgv = { exe: r.whoami, get argv() { argvReads++; return argvReads <= 3 ? WHOAMI_ARGV : ['/all']; } };
  const res1 = await g.run(flipArgv, limits);
  assert.ok(res1.ok, JSON.stringify(res1));
  assert.deepEqual(spy.calls.at(-1)!.argv, WHOAMI_ARGV, 'what ran is what was checked');
  assert.equal(argvReads, 1);
  const d1 = g.decide({ exe: r.whoami, argv: [...WHOAMI_ARGV] });
  assert.ok(d1.allow && Object.isFrozen(d1.argv), 'the checked vector cannot be changed after the check');

  // The same through a Proxy: honest for the first two passes over the indices, evil afterwards.
  let indexReads = 0;
  const proxied = new Proxy([...WHOAMI_ARGV], {
    get(target, key, recv) {
      if (typeof key === 'string' && /^\d+$/.test(key)) return indexReads++ < 2 * WHOAMI_ARGV.length ? Reflect.get(target, key, recv) : 'C:\\evil.ps1';
      return Reflect.get(target, key, recv);
    },
  });
  const res2 = await g.run({ exe: r.whoami, argv: proxied }, limits);
  assert.ok(res2.ok, JSON.stringify(res2));
  assert.deepEqual(spy.calls.at(-1)!.argv, WHOAMI_ARGV, 'what ran is what was checked');
  assert.equal(indexReads, WHOAMI_ARGV.length, 'each index read once');

  let exeReads = 0;
  const flipExe = { get exe() { exeReads++; return exeReads === 1 ? r.whoami : path.join(r.sys.path, 'System32', 'cmd.exe'); }, argv: WHOAMI_ARGV };
  const d2 = g.decide(flipExe);
  assert.ok(d2.allow && d2.exe.toLowerCase() === r.whoami.toLowerCase());
  assert.equal(exeReads, 1);

  let optionReads = 0;
  const flipOptions = { exe: r.whoami, argv: WHOAMI_ARGV, get options() { optionReads++; return optionReads === 1 ? undefined : { shell: true }; } };
  assert.equal(why(g.decide(flipOptions)), 'allow:whoami');
  assert.equal(optionReads, 1);

  const hostile = { exe: r.whoami, get argv(): string[] { throw new Error('boom'); } };
  assert.equal(why(g.decide(hostile)), 'bad-request');
  const callsBefore = spy.calls.length;
  const child = g.start({ exe: r.pg, argv: new Proxy(['--protect', '1:2'], {}) });
  assert.deepEqual(spy.calls.length, callsBefore + 1);
  assert.deepEqual(spy.calls.at(-1)!.argv, ['--protect', '1:2']);
  child.kill();
});

test('start(): refused requests throw a typed error; allowed ones reach the backend with shell off and are recorded', (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ hang: true, pid: 4242 }));
  const pids = new PidLog();
  const g = r.gate({ backend: spy.backend, record: (e) => pids.record(e), clock: new VirtualClock({ mono: 0, wall: Date.parse('2026-10-31T00:00:00Z') }) });
  assert.throws(() => g.start({ exe: r.ps, argv: ['-Command', 'x'] }), (e: unknown) => e instanceof SpawnRefusedError && e.decision.reason === 'rule-not-enabled');
  assert.throws(() => g.start({ exe: r.pg, argv: ['--run', 'x'] }), (e: unknown) => e instanceof SpawnRefusedError && e.decision.reason === 'argv-mismatch');
  assert.equal(spy.calls.length, 0);
  const child = g.start({ exe: r.pg, argv: ['--protect', '1:2'] });
  assert.equal(child.pid, 4242);
  assert.deepEqual(spy.calls[0]!.opts, { cwd: path.dirname(r.pg), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(pids.entries(), [{ at: '2026-10-31T00:00:00.000Z', rule: 'procguard', exe: r.pg, pid: 4242 }]);
  child.kill();
});

test('start() refuses a run-only rule and hands long-lived children back as a frozen, null-prototype handle with no path to the ChildProcess or its sockets', async (t) => {
  const r = rig(t);
  // whoami and csc are run-only: start() refuses them, so a module handed such a gate (integrity.ts
  // gets a whoami gate) cannot reach a live ChildProcess — whose piped stdio are net.Socket objects —
  // through start(). P8: authority is handed, not reachable.
  const runOnly = fakeSpawn(() => ({ exitCode: 0 }));
  const g0 = r.gate({ backend: runOnly.backend });
  assert.throws(() => g0.start({ exe: r.whoami, argv: WHOAMI_ARGV }), (e: unknown) => e instanceof SpawnRefusedError && e.decision.reason === 'not-startable');
  assert.throws(() => g0.start({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${r.out}`, PROCGUARD_SOURCE] }), (e: unknown) => e instanceof SpawnRefusedError && e.decision.reason === 'not-startable');
  assert.equal(runOnly.calls.length, 0, 'a run-only rule reached no backend through start()');

  const spy = fakeSpawn(() => ({ stdout: 'hi', stderr: 'warn', exitCode: 7, pid: 4242 }));
  const g = r.gate({ backend: spy.backend });
  const h = g.start({ exe: r.pg, argv: ['--protect', '1:2'] });
  assert.equal(Object.getPrototypeOf(h), null, 'no prototype chain to walk to a class');
  assert.ok(Object.isFrozen(h));
  assert.deepEqual(Object.keys(h).sort(), [...HANDLE_KEYS].sort());
  assert.equal(h.pid, 4242);
  // Nothing on the handle reaches the ChildProcess, its streams (net.Socket) or its class.
  for (const k of ['stdout', 'stderr', 'stdin', 'on', 'once', 'connect', 'constructor']) {
    assert.equal((h as unknown as Record<string, unknown>)[k], undefined, k);
  }
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  h.onStdout((c) => {
    assert.ok(Buffer.isBuffer(c));
    out.push(c);
  });
  h.onStderr((c) => err.push(c));
  const closed = await new Promise<[number | null, string | null]>((res) => h.onClose((code, signal) => res([code, signal])));
  assert.deepEqual(closed, [7, null]);
  assert.equal(Buffer.concat(out).toString(), 'hi');
  assert.equal(Buffer.concat(err).toString(), 'warn');
});

test('every spawn lands in run/pids.jsonl through the write fence, including the ones made before the sink existed', async (t) => {
  const r = rig(t);
  const fence = await makeWriteFence({ orchestraHome: r.home, harnessRoots: [] });
  fence.mkdirp(path.join(r.home, 'run'));
  const spy = fakeSpawn((c) => (c.exe.endsWith('whoami.exe') ? { stdout: 'x', pid: 11 } : { error: 'ENOENT' }));
  const pids = new PidLog();
  const g = r.gate({ backend: spy.backend, record: (e) => pids.record(e) });
  await g.run({ exe: r.whoami, argv: WHOAMI_ARGV }, { timeoutMs: 5000, maxBytes: 1024 });
  assert.equal(pids.unwritten(), 1);
  const file = path.join(r.home, 'run', 'pids.jsonl');
  pids.attach((line) => fence.append(file, line));
  const failed = await g.run({ exe: r.csc, argv: [...CSC_FLAGS, `/out:${r.out}`, PROCGUARD_SOURCE] }, { timeoutMs: 5000, maxBytes: 1024 });
  assert.deepEqual(failed, { ok: false, reason: 'spawn-failed', detail: 'ENOENT' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { rule: string; pid: number | null });
  assert.deepEqual(lines.map((l) => [l.rule, l.pid]), [['whoami', 11], ['csc', null]]);
  assert.equal(pids.unwritten(), 0);
});

test('a failing pid sink keeps the line in memory, counts the failure and tells the reporter each time', () => {
  const pids = new PidLog();
  const heard: number[] = [];
  pids.attach(() => {
    throw new Error('disk gone');
  }, (n) => heard.push(n));
  pids.record({ at: 'x', rule: 'whoami', exe: 'C:\\w.exe', pid: 1 });
  pids.record({ at: 'y', rule: 'whoami', exe: 'C:\\w.exe', pid: 2 });
  assert.equal(pids.unwritten(), 2);
  assert.equal(pids.failures(), 2);
  assert.deepEqual(heard, [1, 2]);
  assert.equal(pids.entries().length, 2);
  const quiet = new PidLog();
  quiet.attach(() => {
    throw new Error('disk gone');
  }, () => {
    throw new Error('reporter gone too');
  });
  quiet.record({ at: 'z', rule: 'whoami', exe: 'C:\\w.exe', pid: 3 });
  assert.equal(quiet.failures(), 1, 'a throwing reporter changes nothing');
});

test('run(): exit code and output, a signal, oversize output and a timeout are each typed; the child is killed through its handle', async (t) => {
  const r = rig(t);
  const behave: { current: FakeBehavior } = { current: {} };
  const spy = fakeSpawn(() => behave.current);
  const g = r.gate({ backend: spy.backend });
  const req = { exe: r.whoami, argv: WHOAMI_ARGV };
  behave.current = { stdout: 'hello', stderr: 'warn', exitCode: 7 };
  const ok = await g.run(req, { timeoutMs: 5000, maxBytes: 1024 });
  assert.ok(ok.ok);
  assert.equal(ok.exitCode, 7);
  assert.equal(ok.stdout.toString(), 'hello');
  assert.equal(ok.stderr.toString(), 'warn');
  behave.current = { signal: 'SIGKILL' };
  assert.deepEqual(await g.run(req, { timeoutMs: 5000, maxBytes: 1024 }), { ok: false, reason: 'signal', signal: 'SIGKILL' });
  behave.current = { stdout: 'x'.repeat(100), hang: true };
  assert.deepEqual(await g.run(req, { timeoutMs: 5000, maxBytes: 10 }), { ok: false, reason: 'output-too-large', maxBytes: 10 });
  behave.current = { hang: true };
  assert.deepEqual(await g.run(req, { timeoutMs: 15, maxBytes: 10 }), { ok: false, reason: 'timeout', timeoutMs: 15 });
  assert.equal(spy.kills, 2);
  assert.deepEqual(await g.run({ exe: r.whoami, argv: [] }, { timeoutMs: 15, maxBytes: 10 }), {
    ok: false, reason: 'refused', decision: { allow: false, reason: 'argv-mismatch', exe: r.whoami, rule: 'whoami' },
  });
});

test('resolveSystemRoot: a top-level directory, equal to windir, resolving to itself; anything else is typed', () => {
  const real = resolveSystemRoot(process.env, realpath);
  assert.ok(real.ok, JSON.stringify(real));
  const root = real.path;
  const id = (p: string) => p;
  assert.deepEqual(resolveSystemRoot({}, id), { ok: false, reason: 'unset' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: '  ' }, id), { ok: false, reason: 'unset' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'Windows' }, id), { ok: false, reason: 'bad-path', detail: 'not-absolute' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'C:\\Users\\x\\Windows' }, id), { ok: false, reason: 'not-top-level-dir', detail: 'C:\\Users\\x\\Windows' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'C:\\' }, id), { ok: false, reason: 'not-top-level-dir', detail: 'C:\\' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'C:\\Windows', windir: 'D:\\Windows' }, id), { ok: false, reason: 'windir-mismatch', detail: 'D:\\Windows' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'C:\\Windows' }, () => 'D:\\Elsewhere'), { ok: false, reason: 'reparsed', detail: 'D:\\Elsewhere' });
  assert.deepEqual(resolveSystemRoot({ SystemRoot: 'C:\\Windows' }, () => {
    throw Object.assign(new Error('x'), { code: 'ENOENT' });
  }), { ok: false, reason: 'unresolved', detail: 'ENOENT' });
  assert.deepEqual(resolveSystemRoot({ systemroot: 'c:\\windows', WINDIR: 'C:\\WINDOWS' }, id), { ok: true, path: 'c:\\windows' });
  assert.ok(/^[A-Za-z]:\\[^\\]+$/.test(root));
});

test('run(): the time limit is a deadline timer of the gate\'s own Clock, so a virtual clock drives it; it is disarmed once the child closes', async (t) => {
  const r = rig(t);
  const vc = new VirtualClock({ mono: 0, wall: Date.parse('2026-10-31T00:00:00Z') });
  const behave: { current: FakeBehavior } = { current: { hang: true } };
  const spy = fakeSpawn(() => behave.current);
  const g = r.gate({ backend: spy.backend, clock: vc });
  const req = { exe: r.whoami, argv: WHOAMI_ARGV };
  const hung = g.run(req, { timeoutMs: 10_000, maxBytes: 1024 });
  assert.deepEqual(vc.pending(), ['deadline:spawn-1:0'], 'one deadline, named by the run count of the gate\'s timer table');
  let settled = false;
  void hung.then(() => { settled = true; });
  vc.advanceBy(9_999);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(settled, false, 'not before the limit');
  assert.equal(spy.kills, 0);
  vc.advanceBy(1);
  assert.equal(spy.kills, 1, 'killed through its handle the moment the virtual deadline passed');
  assert.deepEqual(await hung, { ok: false, reason: 'timeout', timeoutMs: 10_000 });
  behave.current = { stdout: 'x', exitCode: 0 };
  const ok = await g.run(req, { timeoutMs: 10_000, maxBytes: 1024 });
  assert.ok(ok.ok);
  assert.deepEqual(vc.pending(), [], 'the second run\'s deadline was disarmed when the child closed');
  vc.advanceBy(60_000);
  assert.equal(spy.kills, 1, 'a disarmed deadline kills nothing later');
  // Limits are checked before anything starts: a deadline is whole milliseconds.
  for (const limits of [{ timeoutMs: 1.5, maxBytes: 1 }, { timeoutMs: 0, maxBytes: 1 }, { timeoutMs: 2 ** 31, maxBytes: 1 }, { timeoutMs: 10, maxBytes: -1 }, Object.create({ timeoutMs: 10, maxBytes: 1 })]) {
    assert.throws(() => g.run(req, limits), /spawn gate: run limits need/, JSON.stringify(limits));
  }
  assert.equal(spy.calls.length, 2, 'refused limits started no child');
});

// Found re-verifying step 3: run() named its deadline `deadline:spawn-<n>:0` with n counting that gate's
// runs, and a timerId is pending once per hub, so two gates on one hub (main.ts's integrity gate and
// working.ts's, both on boot's hub) armed the same id when their runs overlapped: the second schedule
// was refused and that run() rejected with its child left running. n now counts the runs on the hub's
// timer table.
test('run(): two gates on one hub number their deadlines on the hub, so overlapping runs both complete and a timeout on one leaves the other alone', async (t) => {
  const r = rig(t);
  const vc = new VirtualClock({ mono: 0, wall: Date.parse('2026-10-31T00:00:00Z') });
  const behaveA: { current: FakeBehavior } = { current: { hang: true } };
  const behaveB: { current: FakeBehavior } = { current: { stdout: 'b', exitCode: 0 } };
  const spyA = fakeSpawn(() => behaveA.current);
  const spyB = fakeSpawn(() => behaveB.current);
  const a = r.gate({ backend: spyA.backend, clock: vc });
  const b = r.gate({ backend: spyB.backend, clock: vc });
  const req = { exe: r.whoami, argv: WHOAMI_ARGV };

  // A hangs and times out while B is still running; B then finishes on its own.
  const hungA = a.run(req, { timeoutMs: 100, maxBytes: 1024 });
  const doneB = b.run(req, { timeoutMs: 100_000, maxBytes: 1024 });
  assert.deepEqual(vc.pending(), ['deadline:spawn-1:0', 'deadline:spawn-2:0'], 'one deadline per run, numbered on the hub');
  vc.advanceBy(100);
  assert.deepEqual([spyA.kills, spyB.kills], [1, 0], 'A\'s deadline killed A\'s child only');
  assert.deepEqual(await hungA, { ok: false, reason: 'timeout', timeoutMs: 100 });
  const okB = await doneB;
  assert.ok(okB.ok, JSON.stringify(okB));
  assert.equal(okB.stdout.toString(), 'b');
  assert.deepEqual(vc.pending(), [], 'B\'s deadline was disarmed when its child closed');

  // The other way round, and the numbering goes on: B hangs and times out while A finishes.
  behaveA.current = { stdout: 'a', exitCode: 0 };
  behaveB.current = { hang: true };
  const hungB = b.run(req, { timeoutMs: 50, maxBytes: 1024 });
  const doneA = a.run(req, { timeoutMs: 100_000, maxBytes: 1024 });
  assert.deepEqual(vc.pending(), ['deadline:spawn-3:0', 'deadline:spawn-4:0']);
  vc.advanceBy(50);
  assert.deepEqual([spyA.kills, spyB.kills], [1, 1], 'B\'s deadline killed B\'s child only');
  assert.deepEqual(await hungB, { ok: false, reason: 'timeout', timeoutMs: 50 });
  const okA = await doneA;
  assert.ok(okA.ok, JSON.stringify(okA));
  assert.equal(okA.stdout.toString(), 'a');
  assert.deepEqual(vc.pending(), []);
  vc.advanceBy(200_000);
  assert.deepEqual([spyA.kills, spyB.kills], [1, 1], 'a disarmed deadline kills nothing later');
});

// Step 3b's review, finding F2: the run number was keyed on the hub object each gate was handed, so a
// wrapper (or a Proxy) over one hub made a second count over the same timer table: both gates armed
// `deadline:spawn-1:0`, the second schedule was refused after its child had started, and that child ran
// on with no deadline. The number is now the table's (clock.ts tableSeq), and the deadline is armed
// before the child starts, so a schedule the Clock refuses starts nothing.
test('run(): a gate handed a wrapper over another gate\'s hub numbers on the same table; a refused deadline, or a Clock clock.ts did not make, starts no child', async (t) => {
  const r = rig(t);
  const vc = new VirtualClock({ mono: 0, wall: Date.parse('2026-10-31T00:00:00Z') });
  const spyA = fakeSpawn(() => ({ hang: true }));
  const spyB = fakeSpawn(() => ({ hang: true }));
  const a = r.gate({ backend: spyA.backend, clock: vc });
  const b = r.gate({ backend: spyB.backend, clock: Object.freeze({ port: (f: FireHandler | null) => vc.port(f) }) });
  const req = { exe: r.whoami, argv: WHOAMI_ARGV };
  const hungA = a.run(req, { timeoutMs: 100, maxBytes: 1024 });
  const hungB = b.run(req, { timeoutMs: 200, maxBytes: 1024 });
  assert.equal(spyB.calls.length, 1);
  assert.deepEqual(vc.pending(), ['deadline:spawn-1:0', 'deadline:spawn-2:0'], 'one table, one count');
  vc.advanceBy(100);
  assert.deepEqual([spyA.kills, spyB.kills], [1, 0], 'A\'s deadline killed A\'s child only');
  assert.deepEqual(await hungA, { ok: false, reason: 'timeout', timeoutMs: 100 });
  vc.advanceBy(100);
  assert.deepEqual([spyA.kills, spyB.kills], [1, 1], 'B\'s child had a deadline of its own');
  assert.deepEqual(await hungB, { ok: false, reason: 'timeout', timeoutMs: 200 });
  assert.deepEqual(vc.pending(), []);

  // Some other code on the same table already holds the next run's timerId: run() refuses before it spawns.
  vc.port(() => {}).schedule({ timerId: 'deadline:spawn-3:0', class: 'deadline', clock: 'mono', due: vc.mono + 10 });
  assert.deepEqual(await a.run(req, { timeoutMs: 100, maxBytes: 1024 }), { ok: false, reason: 'spawn-failed', detail: 'ERR_ORCHESTRA_CLOCK' });
  assert.equal(spyA.calls.length, 1, 'no child started without its deadline');
  assert.deepEqual(vc.pending(), ['deadline:spawn-3:0'], 'the other code\'s timer is left alone');
  vc.advanceBy(10);
  assert.equal(spyA.kills, 1);

  // A backend that throws once the deadline is armed: the run is spawn-failed and its deadline cancelled.
  const throwing = r.gate({ backend: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); }, clock: vc });
  assert.deepEqual(await throwing.run(req, { timeoutMs: 100, maxBytes: 1024 }), { ok: false, reason: 'spawn-failed', detail: 'EACCES' });
  assert.deepEqual(vc.pending(), [], 'the deadline of a run that started nothing is not left pending');

  // A hub whose port() hands out a Clock that clock.ts did not make has no table to number on.
  const foreign = r.gate({ backend: spyB.backend, clock: { port: (): Clock => Object.freeze({ nowMono: () => 0, nowWall: () => 0, schedule: () => {}, cancel: () => {} }) } });
  assert.deepEqual(await foreign.run(req, { timeoutMs: 100, maxBytes: 1024 }), { ok: false, reason: 'spawn-failed', detail: 'ERR_ORCHESTRA_CLOCK' });
  assert.equal(spyB.calls.length, 1, 'no child started without a deadline it could number');
});

// Finding F5: Node reports a spawn failure of a long-lived child (its exe gone or blocked after the
// check) as an asynchronous 'error', and EPIPE on the stdin of a dead child the same way. With no
// listener either ends orchestrad as an uncaught exception; the handle listens from the start, hands
// the code to onError and the gate records the failure in the pid log.
test('start(): a child that fails after start() (ENOENT) reaches onError and the pid log, never the uncaught-exception handler', async (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ error: 'ENOENT' }));
  const pids = new PidLog();
  const g = r.gate({ backend: spy.backend, record: (e) => pids.record(e), clock: new VirtualClock({ mono: 0, wall: Date.parse('2026-10-31T00:00:00Z') }) });
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.prependListener('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const h = g.start({ exe: r.pg, argv: ['--protect', '1:2'] });
  const codes: string[] = [];
  h.onError((c) => codes.push(c));
  await new Promise<void>((done) => h.onClose(() => done()));
  assert.deepEqual(codes, ['ENOENT']);
  assert.deepEqual(uncaught, []);
  assert.deepEqual(pids.entries().map((e) => [e.rule, e.pid, e.error ?? null]), [['procguard', null, null], ['procguard', null, 'ENOENT']]);
  // A listener added after the failure hears it too.
  const late: string[] = [];
  h.onError((c) => late.push(c));
  assert.deepEqual(late, ['ENOENT']);
});

test('start(): an error on a pipe of the child (EPIPE on stdin) reaches onError the same way', async (t) => {
  const r = rig(t);
  const { EventEmitter } = await import('node:events');
  const stdin = new EventEmitter() as EventEmitter & { write: () => boolean; end: () => void };
  stdin.write = () => true;
  stdin.end = () => {};
  const child = Object.assign(new EventEmitter(), { pid: 4343, stdin, stdout: null, stderr: null, kill: () => true });
  const g = r.gate({ backend: () => child as never, record: () => {}, clock: new VirtualClock({ mono: 0, wall: 0 }) });
  const h = g.start({ exe: r.pg, argv: ['--protect', '1:2'] });
  const codes: string[] = [];
  h.onError((c) => codes.push(c));
  assert.doesNotThrow(() => stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  assert.deepEqual(codes, ['EPIPE']);
});
