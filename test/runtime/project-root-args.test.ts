import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as seat from '../../integrations/dsh-seat/index.js';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import type { WorkingOutcome } from '../../src/runtime/working.ts';
import type { SpawnGateSpec } from '../../src/os/node-proc.ts';
import { makeReadGate, makeWriteFence, realpath } from '../../src/fs/node-io.ts';
import { CODEX_EXE_REL, PidLog, SpawnGate } from '../../src/os/spawn.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { EXIT } from '../../src/runtime/exit.ts';
import { Log } from '../../src/runtime/log.ts';
import { PROJECT_ROOTS_MAX, describeRefusal, parseProfileArgs } from '../../src/runtime/test-profile.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { captureConsole, minimalEnv, runWorkingInProcess } from '../helpers/start.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { put, rmTree, withTmp } from '../helpers/tmp.ts';

// --project-root (orchestra app plan 项目根): a flag of either profile, repeatable, only with --owned. Its
// value is checked in working mode before the lock (src/os/project-roots.ts): a root that is no place an
// owned session may work refuses the start (project-root-refused, the bad-arguments exit) and says which
// and why. Without the flag nothing changes: no root, the same cwd table, the same console.

const NO_RUNNER: Record<string, string | undefined> = {};
const parse = (argv: string[]) => parseProfileArgs(argv, { env: minimalEnv(), processEnv: NO_RUNNER, realpath });

test('parse: --project-root needs --owned and a value; it may repeat (up to the cap), never with the same spelling twice', () => {
  const ok = parse(['--owned', '--project-root', 'D:\\a', '--project-root', 'D:\\b']);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.projectRoots, ['D:\\a', 'D:\\b']);
  const none = parse(['--owned']);
  assert.equal(none.ok, true);
  if (none.ok) assert.equal(Object.hasOwn(none, 'projectRoots'), false, 'no flag, no field');
  const refused = (argv: string[]) => {
    const r = parse(argv);
    assert.equal(r.ok, false, JSON.stringify(r));
    return r.ok ? null : r.refusal;
  };
  assert.deepEqual(refused(['--project-root', 'D:\\a']), { reason: 'project-root-without-owned' });
  assert.deepEqual(refused(['--owned', '--project-root']), { reason: 'missing-value', flag: '--project-root' });
  assert.deepEqual(refused(['--owned', '--project-root', '--peek-port', '47100']), { reason: 'missing-value', flag: '--project-root' });
  assert.deepEqual(refused(['--owned', '--project-root', 'D:\\a', '--project-root', 'd:\\A']), { reason: 'duplicate-project-root', path: 'd:\\A' });
  const many = Array.from({ length: PROJECT_ROOTS_MAX + 1 }, (_, i) => ['--project-root', `D:\\p${i}`]).flat();
  assert.deepEqual(refused(['--owned', ...many]), { reason: 'too-many-project-roots', max: PROJECT_ROOTS_MAX });
  assert.match(describeRefusal({ reason: 'project-root-without-owned' }), /only works with --owned/);
});

const CLOCK = makeRealClock();

type Run = { o: WorkingOutcome; out: string[]; err: string[]; home: string; testDir: string; specs: SpawnGateSpec[] };

/** A test-profile orchestrad with --owned (codex.exe a stand-in, so the codex gate is made) and these project roots; stopped before the temp dir goes. */
async function run(t: TestContext, roots: ((testDir: string) => string[]) | null, body: (r: Run) => void): Promise<void> {
  const base = fs.realpathSync.native(withTmp(t));
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = path.join(base, 'orchestra-test-x');
  const home = path.join(testDir, 'orchestra');
  const appData = path.join(base, 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const con = captureConsole();
  const specs: SpawnGateSpec[] = [];
  const spy = fakeSpawn(() => ({ hang: true }));
  const projectRoots = roots === null ? null : roots(testDir);
  const o = await runWorkingInProcess({
    profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log: new Log({ clock: CLOCK.port(null) }), pidLog: new PidLog(), console: con.port,
    pid: process.pid, clock: CLOCK, tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p),
    makeReadGate, makeWriteFence, makeDbOpener,
    // %LOCALAPPDATA% is the temp base: the test dir lies in an AppData row, as %TEMP% does on a real machine.
    env: { ...minimalEnv(), APPDATA: appData, LOCALAPPDATA: base },
    makeSpawnGate: (spec: SpawnGateSpec) => {
      specs.push(spec);
      return new SpawnGate({ ...spec, backend: spy.backend });
    },
    owned: true,
    ...(projectRoots === null ? {} : { projectRoots }),
  });
  try {
    body({ o, out: con.out, err: con.err, home, testDir, specs });
  } finally {
    if (o.mode === 'working') await o.stop();
  }
}

test('working: a fit project root (inside the test dir) is allowed by the owned gates\' cwd table and said on the console', async (t) => {
  await run(t, (d) => {
    fs.mkdirSync(path.join(d, 'proj'));
    return [path.join(d, 'proj')];
  }, (r) => {
    assert.equal(r.o.mode, 'working', JSON.stringify(r.o));
    const proj = path.join(r.testDir, 'proj');
    assert.ok(r.out.some((l) => l.startsWith('orchestrad: project roots for owned sessions: ') && l.includes(proj)), r.out.join('\n'));
    const codex = r.specs.find((s) => (s.rules as string[]).includes('codex-app-server'));
    assert.ok(codex !== undefined, 'the codex gate');
    assert.deepEqual(codex!.cwd!.projectRoots, [proj]);
    assert.equal(codex!.cwd!.testDir, r.testDir);
    assert.deepEqual(codex!.cwd!.allowedRoots, [path.join(r.home, 'work')], 'the work root stays; the project root is added by the policy');
  });
});

test('working: an unfit project root refuses the start before the lock: which one, why, the bad-arguments exit, nothing made', async (t) => {
  const cases: [string, (d: string) => string[], string][] = [
    ['missing', (d) => [path.join(d, 'nope')], 'not-found'],
    ['a file', (d) => {
      fs.writeFileSync(path.join(d, 'f.txt'), 'x');
      return [path.join(d, 'f.txt')];
    }, 'not-a-directory'],
    ['outside the test dir', (d) => [path.dirname(d)], 'outside-test-dir'],
    ['the data dir', (d) => [path.join(d, 'orchestra')], 'protected'],
    ['a junction', (d) => {
      fs.mkdirSync(path.join(d, 'real'));
      fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction');
      return [path.join(d, 'link')];
    }, 'reparsed'],
    ['relative', () => ['proj'], 'bad-path'],
  ];
  for (const [what, roots, why] of cases) {
    await run(t, roots, (r) => {
      assert.equal(r.o.mode, 'project-root-refused', `${what}: ${JSON.stringify(r.o)}`);
      if (r.o.mode !== 'project-root-refused') return;
      assert.equal(r.o.code, EXIT.badArgs);
      assert.equal(r.o.why, why, what);
      assert.ok(r.err.some((l) => l.includes('refusing to start: --project-root') && l.includes(JSON.stringify(r.o.mode === 'project-root-refused' ? r.o.root : ''))), r.err.join('\n'));
      assert.equal(fs.existsSync(path.join(r.home, 'run')), false, `${what}: no data dir prepared, no lock`);
      assert.equal(r.specs.length, 0, `${what}: no gate made`);
    });
  }
});

test('the composition root (project-root review): an agent request through the real agent pipe is placed by the owned gates\' own table and the project-root read gate', async (t) => {
  if (process.platform !== 'win32') return t.skip('named pipes in this form are Windows only');
  // Low-entropy names on purpose: the card shows the cwd redacted, and a run in a root only for the very path
  // (src/route/requests.ts: runInWhy redacted), so a random temp name (orchestra-test-AbC123) would never run there.
  // The pid, as letters, keeps two runs apart (the dir, and the agent pipe named after the test dir).
  const tag = String(process.pid).replace(/[0-9]/g, (d) => 'klmnoprstu'[Number(d)]!);
  const base = path.join(fs.realpathSync.native(os.tmpdir()), `orchestra-test-review-${tag}`);
  rmTree(base);
  fs.mkdirSync(base);
  t.after(() => rmTree(base));
  const name = `roots-${tag}`;
  const testDir = path.join(base, `orchestra-test-${name}`);
  const home = path.join(testDir, 'orchestra');
  const proj = path.join(testDir, 'proj');
  for (const d of [path.join(proj, 'web'), path.join(proj, 'credentials-svc'), path.join(testDir, 'outside')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(testDir, 'outside'), path.join(proj, 'escape'), 'junction');
  const appData = path.join(base, 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const log = new Log({ clock: CLOCK.port(null) });
  const spy = fakeSpawn(() => ({ hang: true }));
  const o = await runWorkingInProcess({
    profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log, pidLog: new PidLog(), console: captureConsole().port,
    pid: process.pid, clock: CLOCK, tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p),
    makeReadGate, makeWriteFence, makeDbOpener, env: { ...minimalEnv(), APPDATA: appData, LOCALAPPDATA: base },
    makeSpawnGate: (spec: SpawnGateSpec) => new SpawnGate({ ...spec, backend: spy.backend }),
    owned: true, agentPort: true, peekPort: 0, projectRoots: [proj],
  });
  assert.equal(o.mode, 'working', JSON.stringify(o));
  if (o.mode !== 'working') return;
  try {
    assert.ok(o.agentPort.on, JSON.stringify(o.agentPort));
    if (!o.agentPort.on) return;
    const port = seat.makePipePort({ pipe: o.agentPort.pipe, tokenFile: o.agentPort.tokenFile });
    const ask = async (cwd: string, sessionId: string) => (await port.call('POST', '/agent/v1/requests', { harness: 'codex', text: '看看这个项目', cwd, requester: { kind: 'dsh', sessionId } })) as { status: number; json: any };
    const placed = (id: string) => log.entries().find((e) => e.event === 'agent-request-placed' && e.fields.requestId === id)?.fields;
    const inside = await ask(path.join(proj, 'web'), 's1');
    assert.equal(inside.status, 200, JSON.stringify(inside.json));
    assert.deepEqual(placed(inside.json.requestId), { requestId: inside.json.requestId, inRoot: true, why: null });
    const elsewhere = await ask(path.join(path.parse(base).root, `orchestra-no-such-dir-${name}`), 's2');
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
    assert.deepEqual(placed(elsewhere.json.requestId), { requestId: elsewhere.json.requestId, inRoot: false, why: 'outside-roots' });
    const cred = await ask(path.join(proj, 'credentials-svc'), 's3');
    assert.deepEqual(placed(cred.json.requestId), { requestId: cred.json.requestId, inRoot: false, why: 'stat-refused' }, 'the dirs read gate refuses the name: unknown, not missing');
    const dots = await ask(`${proj}\\web\\..\\..\\outside`, 's4');
    assert.equal(dots.status, 422, 'a .. that leads into the AppData row is refused before it is placed');
    const escape = await ask(path.join(proj, 'escape'), 's5');
    assert.deepEqual([escape.status, escape.json], [422, { error: 'cwd-forbidden' }], 'a junction out of the root is refused before it is placed (its realpath hits the table)');
  } finally {
    await o.stop();
  }
});

test('working without --project-root: the owned gates\' cwd table is the one before (work root only), and no word of project roots', async (t) => {
  await run(t, null, (r) => {
    assert.equal(r.o.mode, 'working', JSON.stringify(r.o));
    const codex = r.specs.find((s) => (s.rules as string[]).includes('codex-app-server'));
    assert.ok(codex !== undefined);
    assert.deepEqual(Object.keys(codex!.cwd!).sort(), ['allowedRoots', 'ownedWorkRoot', 'protectedDirs', 'userHome']);
    assert.deepEqual(codex!.cwd!.allowedRoots, [path.join(r.home, 'work')]);
    assert.equal(r.out.some((l) => l.includes('project root')), false);
  });
});
