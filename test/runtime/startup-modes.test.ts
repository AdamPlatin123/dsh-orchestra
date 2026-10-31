import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { DataDirCheck } from '../../src/runtime/data-dir.ts';
import type { Features } from '../../src/runtime/features.ts';
import type { Integrity } from '../../src/runtime/integrity.ts';
import type { StartDeps, StartOutcome } from '../../src/main.ts';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import { start } from '../../src/main.ts';
import { PidLog } from '../../src/os/spawn.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { Log } from '../../src/runtime/log.ts';
import { EXIT, planMessage, planStartup } from '../../src/runtime/startup.ts';
import { fakeSpawn, whoamiChinese, whoamiEnglish, whoamiSpy } from '../helpers/fake-spawn.ts';
import type { FakeSpawn } from '../helpers/fake-spawn.ts';
import { findImports } from '../helpers/scan-rules.ts';
import { FENCE_NO_HOOK, FENCE_OK, captureConsole, minimalEnv } from '../helpers/start.ts';
import { junction, put, treeDigest, withTmp } from '../helpers/tmp.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SRC_URL = new URL('../../src/', import.meta.url).href;

const FULL: Features = { node: '24.22.0', nodeAtLeastMin: true, zstd: true, registerHooks: true, sqlite: true, typeStripping: true };
const MEDIUM: Integrity = { level: 'medium', rid: 8192, sid: 'S-1-16-8192' };
const HIGH: Integrity = { level: 'high-or-above', rid: 12288, sid: 'S-1-16-12288' };
const LOW: Integrity = { level: 'low', rid: 4096, sid: 'S-1-16-4096' };
const UNKNOWN: Integrity = { level: 'unknown', reason: 'exit-nonzero', detail: '0xC0000142' };
const DIR_OK: DataDirCheck = { ok: true, home: 'C:\\t\\o', homeReal: 'C:\\t\\o' };
const DIR_BAD: DataDirCheck = { ok: false, reason: 'contains-user-home', home: 'C:\\Users\\x', userHome: 'C:\\Users\\x' };

const modeOf = (f: Features, i: Integrity, d: DataDirCheck) => {
  const p = planStartup(f, i, d);
  return p.mode === 'exit' ? `exit ${p.code}` : p.mode === 'ui-only' ? `ui-only ${p.reasons.map((r) => r.id).join(',')}` : 'working';
};

test('planStartup decides in the plan\'s order', () => {
  assert.equal(modeOf(FULL, MEDIUM, DIR_OK), 'working');
  assert.equal(modeOf(FULL, HIGH, DIR_OK), 'exit 1');
  assert.equal(modeOf({ ...FULL, sqlite: false }, HIGH, DIR_BAD), 'exit 1', 'elevated beats everything');
  assert.equal(modeOf({ ...FULL, sqlite: false }, MEDIUM, DIR_OK), 'exit 2');
  assert.equal(modeOf({ ...FULL, typeStripping: false }, LOW, DIR_BAD), 'exit 2', 'a missing core feature beats ui-only');
  assert.equal(modeOf(FULL, LOW, DIR_OK), 'ui-only integrity-low');
  assert.equal(modeOf(FULL, UNKNOWN, DIR_OK), 'ui-only integrity-unknown');
  assert.equal(modeOf({ ...FULL, registerHooks: false }, MEDIUM, DIR_OK), 'ui-only no-resolve-hook');
  assert.equal(modeOf(FULL, MEDIUM, DIR_BAD), 'ui-only data-dir');
  assert.equal(modeOf({ ...FULL, registerHooks: false }, UNKNOWN, DIR_BAD), 'ui-only integrity-unknown,no-resolve-hook,data-dir');
});

test('planStartup: no zstd works with the DSH source off; an old Node only warns; both notes ride along in every mode', () => {
  const p = planStartup({ ...FULL, zstd: false, nodeAtLeastMin: false, node: '24.1.0' }, MEDIUM, DIR_OK);
  assert.equal(p.mode, 'working');
  assert.deepEqual(p.notes, [{ id: 'zstd-missing', effect: 'dsh-source-off' }, { id: 'node-below-min', effect: 'tuning-warning', node: '24.1.0', min: '24.22.0' }]);
  assert.equal(planStartup({ ...FULL, zstd: false }, LOW, DIR_OK).notes.length, 1);
  const missing = planStartup({ ...FULL, sqlite: false, zstd: false }, MEDIUM, DIR_OK);
  assert.ok(missing.mode === 'exit' && missing.reason === 'missing-features');
  assert.deepEqual(missing.mode === 'exit' && missing.reason === 'missing-features' ? missing.missing : null, ['node:sqlite']);
  assert.match(planMessage(planStartup(FULL, HIGH, DIR_OK))!, /refusing to run elevated \(high-or-above \(S-1-16-12288\)\)/);
  assert.equal(planMessage(planStartup(FULL, MEDIUM, DIR_OK)), null);
});

type Run = { o: StartOutcome; spy: FakeSpawn; con: ReturnType<typeof captureConsole>; dir: string; home: string };

/** start() in the test profile on a fresh temp dir, with a whoami spy unless `spy` is given. */
async function startTest(t: TestContext, opts: { features?: Partial<Features>; fence?: typeof FENCE_OK; spy?: FakeSpawn; deps?: Partial<StartDeps> } = {}): Promise<Run> {
  const dir = withTmp(t);
  const spy = opts.spy ?? whoamiSpy(whoamiEnglish('Medium Mandatory Level'));
  const con = captureConsole();
  const o = await start({ ...detectFeatures(), ...opts.features }, opts.fence ?? FENCE_OK, { fetch: globalThis.fetch }, {
    argv: ['--test-profile', '--test-dir', dir],
    home: path.join(dir, 'user-home'),
    env: minimalEnv(),
    console: con.port,
    spawnBackend: spy.backend,
    onStopSignal: () => () => {},
    ...opts.deps,
  });
  if (o.mode === 'working') t.after(() => o.stop());
  return { o, spy, con, dir, home: path.join(fs.realpathSync.native(dir), 'orchestra') };
}

const onlyWhoami = (spy: FakeSpawn) => {
  assert.equal(spy.calls.length, 1, `spawns: ${spy.calls.map((c) => c.exe).join(', ')}`);
  assert.match(spy.calls[0]!.exe, /\\System32\\whoami\.exe$/i);
};

for (const [name, out, code] of [
  ['Low', whoamiChinese('Low Mandatory Level'), 0],
  ['Untrusted', whoamiEnglish('Untrusted Mandatory Level'), 0],
  ['unknown (whoami 0xC0000142)', whoamiEnglish('Medium Mandatory Level'), 3221225794],
  ['unknown (no label)', whoamiEnglish(null), 0],
  ['unknown (empty output)', Buffer.alloc(0), 0],
] as const) {
  test(`${name} -> ui-only: whoami is the only spawn and the data dir is never created`, async (t) => {
    const r = await startTest(t, { spy: whoamiSpy(out, code) });
    assert.equal(r.o.mode, 'ui-only');
    assert.equal((r.o as { code: number }).code, EXIT.uiOnly);
    onlyWhoami(r.spy);
    assert.equal(fs.existsSync(r.home), false, 'storage stayed closed');
    assert.equal(r.con.err.filter((l) => l.startsWith('orchestrad: ui-only: ')).length, 1);
    assert.deepEqual(r.con.out, ['TEST PROFILE']);
  });
}

test('running High while whoami fails gives ui-only, never working', async (t) => {
  const r = await startTest(t, { spy: fakeSpawn(() => ({ error: 'EPERM' })) });
  assert.equal(r.o.mode, 'ui-only');
  assert.equal(fs.existsSync(r.home), false);
  const r2 = await startTest(t, { spy: whoamiSpy(whoamiEnglish('High Mandatory Level'), 3221225794) });
  assert.equal(r2.o.mode, 'ui-only');
});

test('High -> exit 1 before anything is created', async (t) => {
  const r = await startTest(t, { spy: whoamiSpy(whoamiEnglish('High Mandatory Level')) });
  assert.equal(r.o.mode, 'exit');
  assert.equal((r.o as { code: number }).code, EXIT.elevated);
  assert.equal(fs.existsSync(r.home), false);
  assert.match(r.con.err.join('\n'), /refusing to run elevated/);
});

test('High -> exit 1 before ORCHESTRA_HOME or any harness root is even resolved; Medium does resolve them (control)', async (t) => {
  const below = (calls: readonly string[], dir: string) => {
    const d = fs.realpathSync.native(dir).toLowerCase();
    return calls.filter((p) => p.toLowerCase().startsWith(`${d}\\`));
  };
  const counting = (): { calls: string[]; realpath(p: string): string } => {
    const calls: string[] = [];
    return { calls, realpath: (p) => { calls.push(p); return fs.realpathSync.native(p); } };
  };
  const high = counting();
  const r = await startTest(t, { spy: whoamiSpy(whoamiEnglish('High Mandatory Level')), deps: { realpath: high.realpath } });
  assert.equal(r.o.mode, 'exit');
  assert.ok(high.calls.length > 0, 'the counter saw the argument and System32 checks');
  assert.deepEqual(below(high.calls, r.dir), [], 'nothing below the test dir was looked at');
  const medium = counting();
  const r2 = await startTest(t, { deps: { realpath: medium.realpath } });
  assert.equal(r2.o.mode, 'working');
  assert.ok(below(medium.calls, r2.dir).some((p) => /\\roots\\claude$/i.test(p)), medium.calls.join(', '));
  if (r2.o.mode === 'working') await r2.o.stop();
});

/** start() in the test profile on <base>\temp\orchestra-test-x, with a private TEMP so junctions stay inside base. */
async function startJunctioned(t: TestContext, link: 'orchestra' | 'roots'): Promise<{ o: StartOutcome; sibling: string; before: string; con: ReturnType<typeof captureConsole> }> {
  const base = withTmp(t);
  const temp = path.join(base, 'temp');
  const dir = path.join(temp, 'orchestra-test-x');
  fs.mkdirSync(dir, { recursive: true });
  const sibling = path.join(base, 'sibling');
  put(path.join(sibling, 'tmp', 'keep.txt'), 'keep');
  put(path.join(sibling, 'claude', 'projects', 'p', 'a.jsonl'), '{}\n');
  junction(base, path.join(dir, link), sibling);
  const before = treeDigest(sibling);
  const con = captureConsole();
  const o = await start(detectFeatures(), FENCE_OK, { fetch: globalThis.fetch }, {
    argv: ['--test-profile', '--test-dir', dir],
    home: path.join(base, 'user-home'),
    env: minimalEnv({ TEMP: temp, TMP: temp }),
    console: con.port,
    spawnBackend: whoamiSpy(whoamiEnglish('Medium Mandatory Level')).backend,
    onStopSignal: () => () => {},
  });
  if (o.mode === 'working') t.after(() => o.stop());
  return { o, sibling, before, con };
}

for (const link of ['orchestra', 'roots'] as const) {
  test(`test profile: <testDir>\\${link} as a junction to a sibling dir gives ui-only and leaves the sibling untouched`, async (t) => {
    const r = await startJunctioned(t, link);
    assert.equal(r.o.mode, 'ui-only', r.con.all().join('\n'));
    if (r.o.mode !== 'ui-only') return;
    const dataDir = r.o.plan.reasons.find((x) => x.id === 'data-dir');
    assert.ok(dataDir !== undefined && dataDir.id === 'data-dir' && dataDir.check.reason === 'test-dir-escape', JSON.stringify(r.o.plan.reasons));
    assert.equal(dataDir.check.what, link === 'orchestra' ? 'orchestra-home' : 'harness-root');
    assert.equal(treeDigest(r.sibling), r.before, 'no run\\, no tmp\\ emptied, no daemon.json at the junction target');
    assert.match(r.con.err.join('\n'), /nothing below .+ may lead elsewhere/);
  });
}

test('runWorking checks the data dir itself: a junctioned home or the user home handed in directly is refused before any gate or lock', async (t) => {
  const { runWorking } = await import('../../src/runtime/working.ts');
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const sibling = path.join(base, 'sibling');
  put(path.join(sibling, 'tmp', 'keep.txt'), 'keep');
  const before = treeDigest(sibling);
  const home = path.join(testDir, 'orchestra');
  junction(base, home, sibling);
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const con = captureConsole();
  const common = {
    roots: [], notes: [], log: new Log(), pidLog: new PidLog(), console: con.port, pid: process.pid, now: Date.now,
    tty: () => ({ stdin: false, stdout: false }), onStopSignal: () => () => {}, realpath: (p: string) => fs.realpathSync.native(p),
  };
  const o = await runWorking({ ...common, profile, home, userHome: path.join(base, 'user-home') });
  if (o.mode === 'working') await o.stop();
  assert.equal(o.mode, 'start-failed');
  assert.equal(o.mode === 'start-failed' && o.stage, 'data-dir');
  assert.match(o.mode === 'start-failed' ? o.detail : '', /orchestra-home .+ resolves to .+sibling/i);
  assert.equal(treeDigest(sibling), before);
  // The real profile with no roots at all and the user home as ORCHESTRA_HOME: the PoC of an unchecked factory.
  const userHome = path.join(base, 'user-home-2');
  put(path.join(userHome, '.claude', 'projects', 'x.jsonl'), '{}\n');
  const homeBefore = treeDigest(userHome);
  const o2 = await runWorking({ ...common, profile: { kind: 'real' }, home: userHome, userHome });
  if (o2.mode === 'working') await o2.stop();
  assert.equal(o2.mode === 'start-failed' && o2.stage, 'data-dir');
  assert.equal(treeDigest(userHome), homeBefore, 'no run\\, tmp\\ or runtime\\ in the user home');
});

test('runWorking checks again once the data dir exists: a home that resolves elsewhere afterwards fails, and the lock is released', async (t) => {
  const { runWorking } = await import('../../src/runtime/working.ts');
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const home = path.join(testDir, 'orchestra');
  // Stands in for a junction swapped in at the end of preparation: once run\, tmp\ and runtime\ all
  // exist (after the fence's last check), home "resolves" to a sibling. Earlier, the fence's own
  // re-checks would catch it instead (test/fs/write-fence.test.ts).
  const prepared = () => ['run', 'tmp', 'runtime'].every((d) => fs.existsSync(path.join(home, d)));
  const moved = (p: string) => (p.toLowerCase() === home.toLowerCase() && prepared() ? path.join(base, 'sibling') : fs.realpathSync.native(p));
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const con = captureConsole();
  const ctx = {
    profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log: new Log(), pidLog: new PidLog(), console: con.port, pid: process.pid,
    now: Date.now, tty: () => ({ stdin: false, stdout: false }), onStopSignal: () => () => {},
  };
  const o = await runWorking({ ...ctx, realpath: moved });
  if (o.mode === 'working') await o.stop();
  assert.equal(o.mode === 'start-failed' && o.stage, 'data-dir', JSON.stringify(o));
  assert.match(o.mode === 'start-failed' ? o.detail : '', /changed while it was prepared: orchestra-home/);
  assert.equal(fs.existsSync(path.join(home, 'run', 'daemon.json')), false, 'no heartbeat was written');
  const again = await runWorking({ ...ctx, log: new Log(), pidLog: new PidLog(), realpath: (p: string) => fs.realpathSync.native(p) });
  assert.equal(again.mode, 'working', 'the failed attempt released the lock pipe');
  if (again.mode === 'working') await again.stop();
});

test('no resolve hook -> ui-only', async (t) => {
  const r = await startTest(t, { fence: FENCE_NO_HOOK });
  assert.equal(r.o.mode, 'ui-only');
  assert.match(r.con.err.join('\n'), /import fence has no resolve hook/);
  assert.equal(fs.existsSync(r.home), false);
  const r2 = await startTest(t, { features: { registerHooks: false } });
  assert.equal(r2.o.mode, 'ui-only');
});

test('no node:sqlite -> exit 2; no %SystemRoot% -> unknown integrity, ui-only, nothing spawned', async (t) => {
  const r = await startTest(t, { features: { sqlite: false } });
  assert.equal(r.o.mode, 'exit');
  assert.equal((r.o as { code: number }).code, EXIT.missingFeatures);
  const spy = whoamiSpy('');
  const r2 = await startTest(t, { spy, deps: { env: { TEMP: minimalEnv().TEMP, TMP: minimalEnv().TMP } } });
  assert.equal(r2.o.mode, 'ui-only');
  assert.equal(spy.calls.length, 0);
  assert.match(r2.con.err.join('\n'), /system-root-unavailable: unset/);
});

test('no zstd -> working, the DSH source off and a Tuning note', async (t) => {
  const r = await startTest(t, { features: { zstd: false } });
  assert.equal(r.o.mode, 'working', r.con.all().join('\n'));
  assert.ok(r.con.out.includes('orchestrad: note: zlib zstd missing: the DSH source stays off'));
  assert.ok(fs.statSync(path.join(r.home, 'run')).isDirectory());
  if (r.o.mode === 'working') await r.o.stop();
});

test('arguments are judged before anything runs: a refusal spawns nothing', async (t) => {
  const spy = whoamiSpy(whoamiEnglish('Medium Mandatory Level'));
  const r = await startTest(t, { spy, deps: { argv: ['--verbose'] } });
  assert.equal(r.o.mode, 'refused');
  assert.equal(spy.calls.length, 0);
});

// The static half: what main.ts pulls in at load time. Type-only imports load nothing.
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const r of findImports(text)) {
      if (r.typeOnly || r.form === 'dynamic' || !r.spec.startsWith('.')) continue;
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), r.spec)));
    }
  };
  walk(entry);
  return seen;
}

const NEVER_IN_UI_ONLY = ['src/runtime/working.ts', 'src/runtime/lock.ts', 'src/fs/write-fence.ts'];

test('main.ts loads nothing that writes, locks or opens storage; its one dynamic import is the working wiring', () => {
  const closure = staticClosure('src/main.ts');
  for (const m of NEVER_IN_UI_ONLY) assert.ok(!closure.has(m), `${m} is in main.ts's static graph`);
  assert.ok(![...closure].some((m) => /^src\/(store|sources|server|brakes|detectors)\//.test(m)), [...closure].join(', '));
  assert.ok(closure.has('src/os/spawn.ts'), 'whoami goes through the gate');
  const dyn = findImports(fs.readFileSync(path.join(REPO, 'src/main.ts'), 'utf8')).filter((r) => r.form === 'dynamic').map((r) => r.spec);
  assert.deepEqual(dyn, ['./runtime/working.ts']);
});

// The measured half: a child records every module it resolves while start() runs.
const RECORDER = `import { registerHooks } from 'node:module';
const seen = new Set();
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.add(r.url); return r; } });
const [src, paramsJson] = process.argv.slice(2);
const params = JSON.parse(paramsJson);
const fetchPort = globalThis.fetch;
const { installImportFence } = await import(src + 'runtime/import-fence.ts');
const { detectFeatures } = await import(src + 'runtime/features.ts');
const fence = installImportFence();
const main = await import(src + 'main.ts');
const lines = [];
const o = await main.start(detectFeatures(), fence, { fetch: fetchPort }, {
  argv: params.argv, home: params.home, env: params.env,
  console: { out: (l) => lines.push(l), err: (l) => lines.push(l) },
  onStopSignal: () => () => {}, tty: () => ({ stdin: false, stdout: false }),
});
if (o.mode === 'working') await o.stop();
console.log(JSON.stringify({ mode: o.mode, lines, seen: [...seen] }));
`;

function record(t: TestContext, params: { argv: string[]; home: string; env: Record<string, string | undefined> }): { mode: string; lines: string[]; seen: string[] } {
  const dir = withTmp(t);
  const runner = path.join(dir, 'recorder.mjs');
  fs.writeFileSync(runner, RECORDER);
  const r = spawnSync(process.execPath, [runner, SRC_URL, JSON.stringify(params)], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const last = r.stdout.trim().split(/\r?\n/).at(-1)!;
  const res = JSON.parse(last) as { mode: string; lines: string[]; seen: string[] };
  res.seen = res.seen.map((u) => (u.startsWith(SRC_URL) ? `src/${u.slice(SRC_URL.length)}` : u));
  return res;
}

test('measured: a ui-only start (real profile, fake home as ORCHESTRA_HOME, real whoami) never resolves the writers, the lock, net or sqlite', (t) => {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const res = record(t, { argv: [], home, env: minimalEnv({ ORCHESTRA_HOME: home }) });
  assert.equal(res.mode, 'ui-only', res.lines.join('\n'));
  for (const m of [...NEVER_IN_UI_ONLY, 'node:net', 'node:sqlite', 'node:worker_threads']) assert.ok(!res.seen.includes(m), `${m} was loaded in ui-only`);
  assert.ok(!res.seen.some((m) => /^src\/(store|sources|server|brakes|detectors)\//.test(m)));
  assert.ok(res.seen.includes('src/main.ts') && res.seen.includes('node:child_process'), 'the recorder saw the graph');
  assert.equal(fs.readdirSync(home).length, 0, 'nothing was created in the fake home');
});

test('measured, positive control: a working start resolves exactly those modules', (t) => {
  const dir = withTmp(t);
  const res = record(t, { argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv() });
  assert.equal(res.mode, 'working', res.lines.join('\n'));
  for (const m of [...NEVER_IN_UI_ONLY, 'node:net']) assert.ok(res.seen.includes(m), `${m} not seen in working mode`);
});
