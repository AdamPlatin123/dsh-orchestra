import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import type { WorkingOutcome } from '../../src/runtime/working.ts';
import type { SpawnGateSpec } from '../../src/os/node-proc.ts';
import { makeReadGate, makeWriteFence } from '../../src/fs/node-io.ts';
import { CODEX_EXE_REL, PidLog, SpawnGate } from '../../src/os/spawn.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { captureConsole, minimalEnv, runWorkingInProcess } from '../helpers/start.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// The composition root's part (orchestra app plan §2): with --owned, working mode finds codex.exe at its
// pinned path below %APPDATA%, writes the private CODEX_HOME's config.toml through the fence, makes the
// work root and a spawn gate with the one rule codex-app-server; without codex.exe the feature is off
// with the reason on the console and in the outcome. A spy backend: nothing runs.

const CLOCK = makeRealClock();

type Working = { o: Extract<WorkingOutcome, { mode: 'working' }>; out: string[]; home: string; specs: SpawnGateSpec[] };

/** A test-profile working orchestrad; `body` runs while it works, and it is stopped before the temp dir goes. */
async function working(t: TestContext, env: Record<string, string>, owned: boolean, body: (w: Working) => void): Promise<void> {
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const home = path.join(testDir, 'orchestra');
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const con = captureConsole();
  const specs: SpawnGateSpec[] = [];
  const spy = fakeSpawn(() => ({ hang: true }));
  const o = await runWorkingInProcess({
    profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log: new Log({ clock: CLOCK.port(null) }), pidLog: new PidLog(), console: con.port,
    pid: process.pid, clock: CLOCK, tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p),
    makeReadGate, makeWriteFence, makeDbOpener, env: { ...minimalEnv(), ...env },
    makeSpawnGate: (spec: SpawnGateSpec) => {
      specs.push(spec);
      return new SpawnGate({ ...spec, backend: spy.backend });
    },
    ...(owned ? { owned: true as const } : {}),
  });
  assert.equal(o.mode, 'working', JSON.stringify(o));
  if (o.mode !== 'working') return;
  // Stopped here, before withTmp's cleanup: the store holds orchestra.db open until then.
  try {
    body({ o, out: con.out, home, specs });
  } finally {
    await o.stop();
  }
}

test('--owned with codex.exe in place: the private CODEX_HOME, the work root, and a gate that allows only codex-app-server', async (t) => {
  const appData = path.join(fs.realpathSync.native(withTmp(t)), 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  await working(t, { APPDATA: appData }, true, (w) => {
    const s = w.o.ownedCodex;
    assert.equal(s.on, true, JSON.stringify(s));
    if (!s.on) return;
    assert.equal(s.exe, path.join(appData, CODEX_EXE_REL));
    assert.equal(s.codexHome, path.join(w.home, 'codex-home'));
    assert.equal(s.workRoot, path.join(w.home, 'work'));
    assert.equal(s.model, 'codex/gpt-6.1-sol');
    assert.equal(s.gateway, 'http://127.0.0.1:3425/v1');
    const toml = fs.readFileSync(path.join(w.home, 'codex-home', 'config.toml'), 'utf8');
    assert.ok(toml.startsWith('model = "codex/gpt-6.1-sol"\nmodel_provider = "magpie"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n'), toml);
    assert.ok(toml.includes('[model_providers.magpie]\nname = "magpie"\nbase_url = "http://127.0.0.1:3425/v1"\nwire_api = "responses"\n'), toml);
    assert.ok(toml.includes('[skills]\ninclude_instructions = false\n'), 'the user\'s ~/.agents/skills stay out of the prompt');
    assert.ok(fs.statSync(path.join(w.home, 'work')).isDirectory());
    assert.equal(w.specs.length, 1);
    const spec = w.specs[0]!;
    assert.deepEqual([...spec.rules], ['codex-app-server']);
    assert.deepEqual(spec.envExtra, { 'codex-app-server': { CODEX_HOME: path.join(w.home, 'codex-home') } });
    assert.deepEqual(spec.cwd?.allowedRoots, [path.join(w.home, 'work')]);
    assert.equal(spec.cwd?.ownedWorkRoot, path.join(w.home, 'work'));
    assert.ok(spec.cwd?.protectedDirs.includes(w.home));
    assert.equal(Object.hasOwn(spec, 'fakeCodexNode'), false);
    const line = 'orchestrad: owned Codex sessions on (model codex/gpt-6.1-sol through http://127.0.0.1:3425/v1; work dirs in ';
    assert.ok(w.out.some((l) => l.startsWith(line)), w.out.join('\n'));
  });
});

test('--owned without codex.exe: off, and the reason is on the console and in the outcome; no gate, no CODEX_HOME', async (t) => {
  const appData = path.join(fs.realpathSync.native(withTmp(t)), 'Roaming');
  await working(t, { APPDATA: appData }, true, (w) => {
    assert.deepEqual(w.o.ownedCodex, { on: false, why: 'codex-missing', detail: 'ENOENT' });
    assert.ok(w.out.includes('orchestrad: owned Codex sessions are off: codex-missing (ENOENT)'), w.out.join('\n'));
    assert.equal(w.specs.length, 0);
    assert.equal(fs.existsSync(path.join(w.home, 'codex-home')), false);
  });
});

test('without --owned: off as not-asked, nothing of src/owned/ is set up', async (t) => {
  await working(t, {}, false, (w) => {
    assert.deepEqual(w.o.ownedCodex, { on: false, why: 'not-asked', detail: null });
    assert.equal(w.specs.length, 0);
    assert.ok(!w.out.some((l) => l.includes('owned Codex')));
  });
});
