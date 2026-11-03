import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { JobProc, Resident } from '../../src/os/procguard.ts';
import type { CodexSession } from '../../src/owned/codex-session.ts';
import { childPipe } from '../../src/os/child-pipe.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { CSC_FLAGS, CSC_REL, FAKE_CODEX_SCRIPT, PROCGUARD_SOURCE, resolveSystemRoot, runInJobArgv } from '../../src/os/spawn.ts';
import { ensureProcguard, envAllowlistFile, newJobName, ownedJob, procguardPin, residentOf } from '../../src/os/procguard.ts';
import { PROCGUARD_SOURCE_SHA256 } from '../../src/os/procguard-pins.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { makeRealClock, oneShot } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { startCodexSession } from '../../src/owned/codex-session.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { withTmp } from '../helpers/tmp.ts';

// procguard for real (r4 D4; orchestra app: owned sessions in procguard Jobs): built from
// native/procguard/ProcGuard.cs by the system csc.exe through the spawn gate's csc rule, its resident
// started through the gate, and an owned session's child, the fake app-server under node.exe, started
// through the wrapped rule procguard-codex-fake inside a Job of its own. The fake starts cmd.exe /c
// ping -t (the S4 baseline: libuv lets that ping break away from node's own Job, so it outlives node).
// The brake, and an ordinary end, must leave none of the Job's processes running: checked by pid and
// creation time, never by name. Skipped (with the reason) only where there is no csc.exe.

const SYS = resolveSystemRoot(process.env, realpath);
const CSC = SYS.ok ? path.join(SYS.path, CSC_REL) : null;
const skip = process.platform !== 'win32' ? 'Windows only' : CSC === null || !fs.existsSync(CSC) ? `no system csc.exe at ${CSC ?? '%SystemRoot%'}` : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => Promise<T | null> | T | null, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await get();
    if (v !== null) return v;
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Rig = { resident: Resident; start(): { s: CodexSession; job: string; wrapperPid: number | null }; built: boolean };

async function rig(t: TestContext): Promise<Rig> {
  assert.ok(SYS.ok);
  // Registered before withTmp's own cleanup, so the children (the resident above all, whose exe sits in
  // the temp dir) are gone before the dir is removed, and the test process is left with no child.
  let resident: Resident | null = null;
  const closes: Promise<void>[] = [];
  t.after(async () => {
    await Promise.race([Promise.all(closes), sleep(5000)]);
    resident?.stop();
    await sleep(300);
  });
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'orchestra');
  const work = path.join(home, 'work');
  const codexHome = path.join(home, 'codex-home');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const clock = makeRealClock();
  let pin: (() => string | null) | null = null;
  const site = [{ at: 'runtime' as const, homeReal: home, sourceHash: PROCGUARD_SOURCE_SHA256 }];
  const pgGate = makeSpawnGate({
    systemRoot: SYS, rules: ['csc', 'procguard'], csc: { outAllowed: () => true }, procguard: site,
    procguardPin: () => (pin === null ? 'not built' : pin()), record: () => {}, realpath, clock, env: process.env,
  });
  const dirOf = path.join(home, 'runtime', 'procguard', PROCGUARD_SOURCE_SHA256);
  const built = await ensureProcguard({
    dir: dirOf, sourceHash: PROCGUARD_SOURCE_SHA256,
    readSource: () => fs.readFileSync(PROCGUARD_SOURCE),
    readFile: (f) => fs.readFileSync(f),
    mkdirp: (d) => {
      fs.mkdirSync(d, { recursive: true });
    },
    writeAtomic: (f, data) => fs.writeFileSync(f, data),
    rm: (f) => fs.rmSync(f),
    runCsc: (out) => pgGate.run({ exe: CSC!, argv: [...CSC_FLAGS, `/out:${out}`, PROCGUARD_SOURCE] }, { timeoutMs: 120_000, maxBytes: 256 * 1024 }),
  });
  assert.ok(built.ok, JSON.stringify(built));
  if (!built.ok) throw new Error('unreachable');
  pin = procguardPin((f) => fs.readFileSync(f), built.exe, built.sha256);
  const res = residentOf(pgGate.start({ exe: built.exe, argv: [] }), oneShot(clock, 'procguard-real'));
  resident = res;
  assert.equal(await res.ready, true, 'the resident procguard says ready');
  const envFile = envAllowlistFile(dirOf, 'codex-app-server-fake');
  const gate = makeSpawnGate({
    systemRoot: SYS, rules: ['procguard-codex-fake'], record: () => {}, realpath, clock, env: process.env,
    envExtra: { 'codex-app-server-fake': { CODEX_HOME: codexHome } },
    cwd: { allowedRoots: [work], protectedDirs: [home], userHome: os.homedir(), ownedWorkRoot: work },
    fakeCodexNode: process.execPath, procguard: site, procguardPin: () => pin!(), procguardEnv: { 'codex-app-server-fake': envFile },
  });
  fs.writeFileSync(envFile, gate.envAllowlist('codex-app-server-fake'));
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  let n = 0;
  return {
    resident: res, built: built.built,
    start: () => {
      const ownedId = `${String(++n).padStart(2, '0')}${'0'.repeat(18)}`;
      const cwd = path.join(work, ownedId);
      fs.mkdirSync(cwd);
      const job = newJobName();
      let wrapperPid: number | null = null;
      const started = startCodexSession({
        ownedId, cwd, model: DEFAULT_CODEX_MODEL, approvals, now: () => Date.now(), redact: (text) => ({ text, count: 0 }), hub: clock,
        launch: () => {
          const pipe = childPipe(gate.start({ exe: built.exe, argv: runInJobArgv(job, envFile, process.execPath, [FAKE_CODEX_SCRIPT]), cwd }), ownedJob(job, res));
          wrapperPid = pipe.pid;
          closes.push(new Promise((r) => pipe.onClose(() => r())));
          return pipe;
        },
      });
      assert.ok(started.ok, JSON.stringify(started));
      if (!started.ok) throw new Error('unreachable');
      return { s: started.session, job, wrapperPid };
    },
  };
}

/** The fake starts its grandchild; the Job's members, once PING.EXE is among them, with their identities. */
async function treeOf(r: Rig, s: CodexSession, job: string): Promise<JobProc[]> {
  assert.equal(await s.ready, true);
  assert.equal(s.send('sleeper', '11111111-1111-4111-8111-111111111111').ok, true);
  await until('the fake to say its sleeper', () => (s.feed.since(0).events.some((e) => e.kind === 'text' && e.state === 'final' && /^sleeper \d+$/.test(e.text ?? '')) ? true : null));
  return until('PING.EXE in the Job', async () => {
    const info = await r.resident.jobInfo(job);
    if (!info.found) return null;
    return info.procs.some((p) => (p.image ?? '').toLowerCase() === 'ping.exe') ? [...info.procs] : null;
  });
}

const ids = (procs: readonly JobProc[]) => procs.filter((p) => p.createTime !== null).map((p) => ({ pid: p.pid, createTime: p.createTime! }));

test('procguard real: csc builds it, the session\'s whole tree (node, cmd, ping) runs in its Job, the brake ends it, and 0 of those processes survive', { skip }, async (t) => {
  const r = await rig(t);
  const { s, job, wrapperPid } = r.start();
  const procs = await treeOf(r, s, job);
  const images = procs.map((p) => (p.image ?? '?').toLowerCase()).sort();
  assert.ok(images.includes('node.exe') && images.includes('cmd.exe') && images.includes('ping.exe'), images.join(','));
  assert.ok(!procs.some((p) => p.pid === wrapperPid), 'procguard itself is outside the Job it made');
  assert.equal(procs.filter((p) => p.createTime === null).length, 0, 'every member could be opened, so every survivor check is by identity');
  const live = ids(procs);
  assert.deepEqual((await r.resident.alive(live)).length, live.length, 'all running before the brake');
  const braked = await s.brake();
  assert.equal(braked.ok, true);
  if (!braked.ok) return;
  assert.equal(braked.left, 0);
  assert.ok((braked.killed ?? 0) >= 3, `killed ${braked.killed}`);
  assert.deepEqual([s.state, s.endReason], ['ended', 'braked']);
  assert.deepEqual(await r.resident.alive(live), [], '0 survivors by pid + creation time');
  assert.deepEqual(await r.resident.jobInfo(job).then((i) => (i.found ? i.procs.length : 0)), 0);
  assert.ok(s.feed.since(0).events.some((e) => e.kind === 'note' && e.state === 'tree-stopped'));
});

test('procguard real: an ordinary end (stdin closed, then the wrapper killed) takes the grandchild ping with it; 0 survivors', { skip }, async (t) => {
  const r = await rig(t);
  const { s, job } = r.start();
  const live = ids(await treeOf(r, s, job));
  assert.ok(live.length >= 3);
  s.end();
  await until('the check after the close', () => (s.feed.since(0).events.some((e) => e.kind === 'note' && /^tree-/.test(e.state ?? '')) ? true : null));
  const note = s.feed.since(0).events.find((e) => e.kind === 'note' && /^tree-/.test(e.state ?? ''))!;
  assert.ok(note.state === 'tree-ended' || note.state === 'tree-stopped', `${note.state} ${note.text}`);
  assert.deepEqual(await until('no survivor', async () => ((await r.resident.alive(live)).length === 0 ? [] : null), 5_000), []);
  assert.ok(!s.feed.since(0).events.some((e) => e.state === 'children-may-remain'));
});
