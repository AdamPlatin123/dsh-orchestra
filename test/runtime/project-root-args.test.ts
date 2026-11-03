import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
import { put, withTmp } from '../helpers/tmp.ts';

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
