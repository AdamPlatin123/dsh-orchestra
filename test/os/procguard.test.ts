import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProcHandle, RunResult } from '../../src/os/spawn.ts';
import type { ProcguardBuildDeps, Resident } from '../../src/os/procguard.ts';
import { PROCGUARD_SOURCE, PROCGUARD_JOB_RE } from '../../src/os/spawn.ts';
import { PROCGUARD_FILES, PROCGUARD_LIMITS, ProcguardError, ensureProcguard, jobTracker, newJobName, ownedJob, procguardPin, residentOf } from '../../src/os/procguard.ts';
import { PROCGUARD_SOURCE_SHA256 } from '../../src/os/procguard-pins.ts';
import { render } from '../../scripts/pin-procguard.ts';

// procguard for the owned sessions (r4 D4; src/os/procguard.ts) with fakes: the build and its pins, the
// resident's line protocol and a session's Job. Nothing runs here; test/os/procguard-real.test.ts builds
// it with the system csc and runs a real tree in a real Job.

const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex');
const DIR = 'C:\\o\\runtime\\procguard\\' + 'a'.repeat(64);
const EXE = path.win32.join(DIR, PROCGUARD_FILES.exe);
const PIN = path.win32.join(DIR, PROCGUARD_FILES.pin);
const OUT = path.win32.join(DIR, PROCGUARD_FILES.build);
const SOURCE = Buffer.from('class X {}\n');

type Disk = Map<string, Uint8Array>;
const enoent = (f: string) => Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });

function deps(disk: Disk, csc: (out: string) => RunResult = (out) => {
  disk.set(out, Buffer.from('MZ built'));
  return { ok: true, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}) {
  const calls: string[] = [];
  const d: ProcguardBuildDeps = {
    dir: DIR, sourceHash: sha(SOURCE),
    readSource: () => SOURCE,
    readFile: (f) => {
      const b = disk.get(f);
      if (b === undefined) throw enoent(f);
      return b;
    },
    mkdirp: (x) => {
      calls.push(`mkdirp ${x}`);
    },
    writeAtomic: (f, data) => {
      calls.push(`write ${path.win32.basename(f)}`);
      disk.set(f, typeof data === 'string' ? Buffer.from(data) : data);
    },
    rm: (f) => {
      calls.push(`rm ${path.win32.basename(f)}`);
      disk.delete(f);
    },
    runCsc: async (out) => {
      calls.push(`csc ${path.win32.basename(out)}`);
      return csc(out);
    },
  };
  return { d, calls };
}

test('the source pin: PROCGUARD_SOURCE_SHA256 is the sha256 of native/procguard/ProcGuard.cs, and the generated file is what pin-procguard.ts writes', () => {
  assert.equal(sha(fs.readFileSync(PROCGUARD_SOURCE)), PROCGUARD_SOURCE_SHA256, 'run node scripts/pin-procguard.ts after a reviewed change to ProcGuard.cs');
  assert.equal(fs.readFileSync(path.join(path.dirname(PROCGUARD_SOURCE), '..', '..', 'src', 'os', 'procguard-pins.ts'), 'utf8'), render(PROCGUARD_SOURCE_SHA256));
  // The source keeps the parts the owned sessions rely on.
  const cs = fs.readFileSync(PROCGUARD_SOURCE, 'utf8');
  for (const must of ['KILL_ON_JOB_CLOSE', 'CREATE_SUSPENDED', '0x20002', 'ERROR_ALREADY_EXISTS', 'TerminateJobObject', 'BuildEnv']) assert.ok(cs.includes(must), must);
  // Phase 4 review: the child is made inside its Job (the job list) and checked there before it runs;
  // the brake's kill comes before anything that grows with the Job; answers asked before EOF still go out.
  for (const must of ['0x2000D', 'IsProcessInJob', 'ERROR_MORE_DATA', 'DrainMs']) assert.ok(cs.includes(must), must);
  const kill = cs.slice(cs.indexOf('static Dictionary<string, object> KillJob'), cs.indexOf('static Dictionary<string, object> Alive'));
  assert.ok(kill.indexOf('TerminateJobObject') < kill.indexOf('Members('), 'kill-job terminates before it lists members');
  assert.ok(!/BREAKAWAY_OK\s*[|=]/.test(cs.replace(/\/\/.*$/gm, '')), 'no breakaway flag is set');
});

test('newJobName: 128 random bits in the form procguard takes, never the same twice', () => {
  const a = newJobName();
  const b = newJobName();
  assert.match(a, PROCGUARD_JOB_RE);
  assert.notEqual(a, b);
  assert.ok(!PROCGUARD_JOB_RE.test('orchestra-job-ABC'), 'uppercase or short names are not Job names');
});

test('ensureProcguard: a source that does not match its pin is never compiled', async () => {
  const disk: Disk = new Map();
  const { d, calls } = deps(disk);
  const r = await ensureProcguard({ ...d, sourceHash: 'b'.repeat(64) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.why, 'procguard-source-unpinned');
  assert.deepEqual(calls, []);
});

test('ensureProcguard: every startup builds: a stale build file goes, csc writes procguard.new.exe, its sha256 stays in memory, the exe is moved into place', async () => {
  const disk: Disk = new Map([[OUT, Buffer.from('stale')]]);
  const { d, calls } = deps(disk);
  const r = await ensureProcguard(d);
  assert.deepEqual(r, { ok: true, dir: DIR, exe: EXE, sha256: sha('MZ built'), built: true });
  assert.deepEqual(calls, [`mkdirp ${DIR}`, 'rm procguard.new.exe', 'csc procguard.new.exe', 'write procguard.exe', 'rm procguard.new.exe']);
  // Phase 4 review: no sha256 file next to the exe (it would vouch for itself).
  assert.equal(disk.has(PIN), false);
  assert.equal(disk.has(OUT), false);
});

test('ensureProcguard: an exe an earlier orchestrad left is never trusted, even with a matching sha256 file: built again over it, and that file goes', async () => {
  const exe = Buffer.from('MZ swapped by someone');
  // Exe and record replaced together: the old check let this through on the next start.
  const disk: Disk = new Map([[EXE, exe], [PIN, Buffer.from(`${sha(exe)}\n`)]]);
  const { d, calls } = deps(disk);
  const r = await ensureProcguard(d);
  assert.deepEqual(r, { ok: true, dir: DIR, exe: EXE, sha256: sha('MZ built'), built: true });
  assert.ok(calls.includes('csc procguard.new.exe'), calls.join(' '));
  assert.ok(calls.includes('rm procguard.exe.sha256'));
  assert.equal(Buffer.from(disk.get(EXE)!).toString(), 'MZ built');
  assert.equal(disk.has(PIN), false);
  // One that cannot be replaced (an old procguard.exe still runs): a setup failure that says so.
  const busy = deps(new Map([[EXE, exe]]));
  const locked = { ...busy.d, writeAtomic: (file: string) => {
    if (file === EXE) throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' });
  } };
  const b = await ensureProcguard(locked);
  assert.equal(b.ok, false);
  if (!b.ok) {
    assert.equal(b.why, 'procguard-setup-failed');
    assert.match(b.detail, /cannot replace .*procguard\.exe \(EPERM\): does a procguard\.exe an earlier orchestrad started still run\?/);
  }
});

test('ensureProcguard: a failed csc run is build-failed with csc\'s own words; an exe nobody wrote too', async () => {
  const disk: Disk = new Map();
  const failed = deps(disk, () => ({ ok: true, exitCode: 1, stdout: Buffer.from('ProcGuard.cs(3,1): error CS1002: ; expected'), stderr: Buffer.alloc(0) }));
  const r = await ensureProcguard(failed.d);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.why, 'procguard-build-failed');
    assert.match(r.detail, /exit code 1: .*CS1002/);
  }
  const silent = deps(new Map(), () => ({ ok: true, exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  const s = await ensureProcguard(silent.d);
  assert.equal(s.ok, false);
  if (!s.ok) assert.deepEqual([s.why, s.detail], ['procguard-build-failed', 'csc wrote no exe']);
  const timedOut = deps(new Map(), () => ({ ok: false, reason: 'timeout', timeoutMs: 1 }));
  const tr = await ensureProcguard(timedOut.d);
  assert.equal(tr.ok ? 'ok' : tr.why, 'procguard-build-failed');
});

test('procguardPin: null while procguard.exe is what was built; a change or an unreadable file says why', () => {
  const disk: Disk = new Map([[EXE, Buffer.from('MZ one')]]);
  const read = (f: string) => {
    const b = disk.get(f);
    if (b === undefined) throw enoent(f);
    return b;
  };
  const pin = procguardPin(read, EXE, sha('MZ one'));
  assert.equal(pin(), null);
  disk.set(EXE, Buffer.from('MZ two'));
  assert.match(pin()!, /procguard\.exe is [0-9a-f]{64}, built as/);
  disk.delete(EXE);
  assert.match(pin()!, /unreadable: ENOENT/);
});

// --- the resident ---------------------------------------------------------------------------------------

type FakeResident = { h: ProcHandle; sent: Record<string, unknown>[]; say(o: unknown): void; close(code?: number | null): void; ended: number; fire(): void };

function fakeResident(): FakeResident {
  const outs: ((c: Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const f: FakeResident = {
    sent: [], ended: 0,
    h: Object.freeze({
      pid: 7,
      write: (d: Uint8Array | string) => {
        for (const l of String(d).split('\n').filter((x) => x !== '')) f.sent.push(JSON.parse(l) as Record<string, unknown>);
      },
      end: () => {
        f.ended++;
      },
      onStdout: (cb: (c: Buffer) => void) => {
        outs.push(cb);
      },
      onStderr: () => {},
      onClose: (cb: (code: number | null, signal: string | null) => void) => {
        closes.push(cb);
      },
      onError: () => {},
      kill: () => {},
    }) as ProcHandle,
    say: (o) => outs.forEach((cb) => cb(Buffer.from(`${JSON.stringify(o)}\n`))),
    close: (code: number | null = 0) => closes.forEach((cb) => cb(code, null)),
    fire: () => {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
  } as FakeResident;
  (f as { after?: unknown }).after = (_ms: number, fn: () => void) => {
    const id = ++seq;
    timers.set(id, fn);
    return () => {
      timers.delete(id);
    };
  };
  return f;
}
const afterOf = (f: FakeResident) => (f as unknown as { after: (ms: number, fn: () => void) => () => void }).after;
const tick = () => new Promise((r) => setImmediate(r));
const JOB = `orchestra-job-${'c'.repeat(32)}`;

test('resident: ready once it says so; job-info and kill-job go out as one JSON line each and their answers come back typed', async () => {
  const f = fakeResident();
  const r: Resident = residentOf(f.h, afterOf(f));
  assert.equal(r.up, false);
  f.say({ event: 'ready', pid: 7 });
  assert.equal(await r.ready, true);
  assert.equal(r.up, true);
  const info = r.jobInfo(JOB);
  await tick();
  assert.deepEqual(f.sent.at(-1), { id: 1, cmd: 'job-info', name: JOB });
  f.say({ ok: true, found: true, activeProcesses: 2, totalProcesses: 3, procs: [{ pid: 10, createTime: '134381357336572767', image: 'node.exe' }, { pid: 11, createTime: null, image: null }], id: 1 });
  assert.deepEqual(await info, { found: true, active: 2, total: 3, procs: [{ pid: 10, createTime: '134381357336572767', image: 'node.exe' }, { pid: 11, createTime: null, image: null }] });
  const kill = r.killJob(JOB);
  await tick();
  assert.deepEqual(f.sent.at(-1), { id: 2, cmd: 'kill-job', name: JOB, waitMs: PROCGUARD_LIMITS.killWaitMs });
  f.say({ ok: true, found: true, before: 2, after: 0, procs: [], id: 2 });
  assert.deepEqual(await kill, { found: true, before: 2, after: 0, procs: [] });
  const gone = r.killJob(JOB);
  await tick();
  f.say({ ok: true, found: false, id: 3 });
  assert.deepEqual(await gone, { found: false });
  const alive = r.alive([{ pid: 10, createTime: '1' }]);
  await tick();
  assert.deepEqual(f.sent.at(-1), { id: 4, cmd: 'alive', procs: [{ pid: 10, createTime: '1' }] });
  f.say({ ok: true, alive: ['10:1'], id: 4 });
  assert.deepEqual(await alive, ['10:1']);
  r.stop();
  assert.equal(f.ended, 1, 'stop closes its stdin: it exits on EOF');
});

test('resident: a refusal, a deadline and a close each reject with their reason; a bad Job name never goes out', async () => {
  const f = fakeResident();
  const r = residentOf(f.h, afterOf(f));
  f.say({ event: 'ready' });
  await r.ready;
  const refused = r.killJob(JOB);
  await tick();
  f.say({ ok: false, error: 'exception', message: 'Fail: OpenJobObject failed, win32=5', id: 1 });
  await assert.rejects(refused, (e: unknown) => e instanceof ProcguardError && e.reason === 'refused' && /win32=5/.test(e.message));
  const late = r.jobInfo(JOB);
  await tick();
  f.fire();
  await assert.rejects(late, (e: unknown) => e instanceof ProcguardError && e.reason === 'timeout');
  await assert.rejects(r.jobInfo('not-a-job'), (e: unknown) => e instanceof ProcguardError && e.reason === 'refused');
  assert.equal(f.sent.length, 2, 'the bad name was not sent');
  const pending = r.jobInfo(JOB);
  await tick();
  f.close();
  await assert.rejects(pending, (e: unknown) => e instanceof ProcguardError && e.reason === 'gone');
  assert.equal(r.up, false);
  await assert.rejects(r.jobInfo(JOB), (e: unknown) => e instanceof ProcguardError && e.reason === 'gone');
});

test('resident: one that never says ready is not up (its deadline settles ready false)', async () => {
  const f = fakeResident();
  const r = residentOf(f.h, afterOf(f));
  f.fire();
  assert.equal(await r.ready, false);
  assert.equal(r.up, false);
});

test('ownedJob: what the brake and the check after an end hear: counts, no Job left, or unknown with why (T1)', async () => {
  const answer = (o: unknown): Resident => ({
    ready: Promise.resolve(true), up: true,
    jobInfo: async () => ({ found: false }),
    killJob: async () => {
      if (o instanceof Error) throw o;
      return o as never;
    },
    alive: async () => [],
    stop: () => {},
  });
  assert.deepEqual(await ownedJob(JOB, answer({ found: true, before: 3, after: 0, procs: [] })).endTree(), { ok: true, found: true, killed: 3, left: 0 });
  assert.deepEqual(await ownedJob(JOB, answer({ found: false })).endTree(), { ok: true, found: false, killed: 0, left: 0 });
  assert.deepEqual(await ownedJob(JOB, answer(new ProcguardError('timeout', 'x'))).endTree(), { ok: false, why: 'procguard-timeout' });
  assert.deepEqual(await ownedJob(JOB, null).endTree(), { ok: false, why: 'procguard-not-running' });
  assert.deepEqual(await ownedJob(JOB, { ...answer({ found: false }), up: false }).endTree(), { ok: false, why: 'procguard-not-running' });
  assert.throws(() => ownedJob('x', null), /not a job name/);
});

test('resident: one that goes away after ready and unasked is heard (onGone, with how it ended); one asked to stop is not', async () => {
  const f = fakeResident();
  const gone: string[] = [];
  const r = residentOf(f.h, afterOf(f), { onGone: (d) => gone.push(d) });
  f.say({ event: 'ready' });
  await r.ready;
  f.close(3);
  assert.deepEqual(gone, ['exit code 3']);
  assert.equal(r.up, false);
  f.close(3);
  assert.equal(gone.length, 1, 'heard once');
  // Asked to stop (orchestrad's own stop): its exit is not news.
  const g = fakeResident();
  const heard: string[] = [];
  const s2 = residentOf(g.h, afterOf(g), { onGone: (d) => heard.push(d) });
  g.say({ event: 'ready' });
  await s2.ready;
  s2.stop();
  g.close(0);
  assert.deepEqual(heard, []);
  // Never ready: setUpProcguard says why itself, onGone stays quiet.
  const h = fakeResident();
  const never: string[] = [];
  residentOf(h.h, afterOf(h), { onGone: (d) => never.push(d) });
  h.close(1);
  assert.deepEqual(never, []);
});

test('jobTracker: every end of a Job is heard and held; quiet() waits for the wrapped children to close and for the checks their closes started', async () => {
  let release!: () => void;
  const killed: string[] = [];
  const resident: Resident = {
    ready: Promise.resolve(true), up: true,
    jobInfo: async () => ({ found: false }),
    killJob: (name: string) => {
      killed.push(name);
      return new Promise((r) => {
        release = () => r({ found: true, before: 2, after: 0, procs: [] });
      });
    },
    alive: async () => [],
    stop: () => {},
  };
  const heard: string[] = [];
  const t = jobTracker(resident, (job, o) => heard.push(`${job}:${o.ok ? `${o.killed}/${o.left}` : o.why}`));
  const closes: (() => void)[] = [];
  const pipe = { onClose: (cb: () => void) => closes.push(cb) };
  t.opened(pipe);
  const j = t.job(JOB);
  assert.equal(j.name, JOB);
  // The session's own close listener comes after the tracker's and starts the check (codex-session.ts).
  pipe.onClose(() => {
    void j.endTree();
  });
  let quiet = false;
  void t.quiet().then(() => {
    quiet = true;
  });
  await tick();
  assert.equal(quiet, false, 'a child still open');
  closes.forEach((cb) => cb());
  await tick();
  assert.deepEqual(killed, [JOB]);
  assert.equal(quiet, false, 'the check its close started has not answered');
  release();
  await tick();
  await tick();
  assert.equal(quiet, true);
  assert.deepEqual(heard, [`${JOB}:2/0`]);
  // Nothing open and nothing asked: quiet at once.
  await jobTracker(null, () => {}).quiet();
  // Without a resident the end is unknown, and still heard (T1).
  const lone: string[] = [];
  const none = jobTracker(null, (_j, o) => lone.push(o.ok ? 'ok' : o.why));
  assert.deepEqual(await none.job(JOB).endTree(), { ok: false, why: 'procguard-not-running' });
  assert.deepEqual(lone, ['procguard-not-running']);
});
