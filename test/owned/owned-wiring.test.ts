import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { TestProfile } from '../../src/runtime/test-profile.ts';
import type { WorkingOutcome } from '../../src/runtime/working.ts';
import type { SpawnGateSpec } from '../../src/os/node-proc.ts';
import { makeReadGate, makeWriteFence } from '../../src/fs/node-io.ts';
import { CLAUDE_GATEWAY_TOKEN, CODEX_EXE_REL, PidLog, SpawnGate } from '../../src/os/spawn.ts';
import { resolveHostSite } from '../../src/owned/claude-site.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { captureConsole, minimalEnv, runWorkingInProcess } from '../helpers/start.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import type { FakeBehavior, FakeCall } from '../helpers/fake-spawn.ts';
import { PROCGUARD_SOURCE_SHA256 } from '../../src/os/procguard-pins.ts';
import { LIBUV_ADDED_ENV } from '../../src/os/spawn.ts';

type FakeBehave = (call: FakeCall) => FakeBehavior;
import { put, withTmp } from '../helpers/tmp.ts';

// The composition root's part (orchestra app plan §2): with --owned, working mode finds codex.exe at its
// pinned path below %APPDATA%, writes the private CODEX_HOME's config.toml through the fence, makes the
// work root and a spawn gate with the one rule codex-app-server; without codex.exe the feature is off
// with the reason on the console and in the outcome. A spy backend: nothing runs.

const CLOCK = makeRealClock();

type Working = { o: Extract<WorkingOutcome, { mode: 'working' }>; out: string[]; home: string; specs: SpawnGateSpec[] };

/** A test-profile working orchestrad; `body` runs while it works, and it is stopped before the temp dir goes. */
async function working(t: TestContext, env: Record<string, string>, owned: boolean, body: (w: Working) => void, opts: { readGate?: typeof makeReadGate; procguard?: true; behave?: FakeBehave } = {}): Promise<void> {
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const home = path.join(testDir, 'orchestra');
  const profile: TestProfile = { kind: 'test', testDir, orchestraHome: home, rootsDir: path.join(testDir, 'roots'), rootsDirGiven: false, rootPids: [] };
  const con = captureConsole();
  const specs: SpawnGateSpec[] = [];
  const spy = fakeSpawn(opts.behave ?? (() => ({ hang: true })));
  const o = await runWorkingInProcess({
    profile, home, userHome: path.join(base, 'user-home'), roots: [], notes: [], log: new Log({ clock: CLOCK.port(null) }), pidLog: new PidLog(), console: con.port,
    pid: process.pid, clock: CLOCK, tty: () => ({ stdin: false, stdout: false }), realpath: (p: string) => fs.realpathSync.native(p),
    makeReadGate: opts.readGate ?? makeReadGate, makeWriteFence, makeDbOpener, env: { ...minimalEnv(), ...env },
    makeSpawnGate: (spec: SpawnGateSpec) => {
      specs.push(spec);
      return new SpawnGate({ ...spec, backend: spy.backend });
    },
    ...(owned ? { owned: true as const } : {}),
    ...(opts.procguard === true ? { procguard: true as const } : {}),
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
    const codexSpecs = w.specs.filter((s) => s.rules.includes('codex-app-server'));
    assert.equal(codexSpecs.length, 1);
    const spec = codexSpecs[0]!;
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
    assert.equal(w.specs.filter((s) => s.rules.includes('codex-app-server')).length, 0);
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

// ---- owned Claude sessions (orchestra app step 4) ----------------------------------------------------

const site = resolveHostSite((p: string) => fs.realpathSync.native(p));

test('--owned with the host in place: the claude-host gate with node.exe, host.mjs and its pin check, the checked extras, the work root; else off with the reason', async (t) => {
  await working(t, {}, true, (w) => {
    const s = w.o.ownedClaude;
    if (!site.ok) {
      // A copy without the installed SDK (or without .tools\node24): off, and why.
      assert.equal(s.on, false);
      assert.ok(w.out.some((l) => l.startsWith('orchestrad: owned Claude sessions are off: claude-')), w.out.join('\n'));
      return;
    }
    assert.equal(s.on, true, JSON.stringify(s));
    if (!s.on) return;
    assert.deepEqual([s.node, s.entry, s.claudeExe, s.model, s.gateway], [site.node, site.entry, site.claudeExe, 'zcode/GLM-5.3', 'http://127.0.0.1:3425']);
    const specs = w.specs.filter((x) => x.rules.includes('claude-host'));
    assert.equal(specs.length, 1);
    const spec = specs[0]!;
    assert.deepEqual([...spec.rules], ['claude-host']);
    assert.deepEqual(spec.envExtra, {
      'claude-host': {
        CLAUDE_CONFIG_DIR: path.join(w.home, 'claude-home'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: CLAUDE_GATEWAY_TOKEN,
        ANTHROPIC_SMALL_FAST_MODEL: 'zcode/GLM-5-Turbo', NO_PROXY: '127.0.0.1,localhost',
      },
    });
    assert.equal(spec.claudeHost?.entry, site.entry);
    assert.equal(spec.claudeHost?.verify(), null, 'the pins match');
    assert.deepEqual(spec.cwd?.allowedRoots, [path.join(w.home, 'work')]);
    assert.ok(fs.statSync(path.join(w.home, 'claude')).isDirectory());
    assert.ok(w.out.some((l) => l.startsWith('orchestrad: owned Claude sessions on (model zcode/GLM-5.3 through http://127.0.0.1:3425;')), w.out.join('\n'));
  });
});

test('--owned with a host file that does not match its pin: off as host-tampered, no claude-host gate', async (t) => {
  if (!site.ok) return;
  const tampered: typeof makeReadGate = (spec) => {
    const real = makeReadGate(spec);
    if (spec.pinnedFiles === undefined) return real;
    return new Proxy(real, { get: (o, k) => (k === 'readFile' ? () => Buffer.from('tampered') : Reflect.get(o, k)) });
  };
  await working(t, {}, true, (w) => {
    assert.deepEqual(w.o.ownedClaude, { on: false, why: 'host-tampered', detail: 'hosts/claude/host.mjs: changed' });
    assert.ok(w.out.includes('orchestrad: owned Claude sessions are off: host-tampered (hosts/claude/host.mjs: changed)'), w.out.join('\n'));
    assert.equal(w.specs.filter((x) => x.rules.includes('claude-host')).length, 0);
  }, { readGate: tampered });
});

// ---- procguard (orchestra app: owned sessions in procguard Jobs; r4 D4) ------------------------------

/** csc as the spy plays it: writes `bytes` (or nothing) to its /out: and exits 0; procguard says ready and stays. */
const pgBehave = (bytes: string | null): FakeBehave => (call) => {
  if (/csc\.exe$/i.test(call.exe)) {
    const out = call.argv.find((a) => a.startsWith('/out:'))!.slice('/out:'.length);
    if (bytes !== null) fs.writeFileSync(out, bytes);
    return { exitCode: 0 };
  }
  if (/procguard\.exe$/i.test(call.exe) && call.argv.length === 0) return { stdout: '{"event":"ready","pid":1}\n', hang: true };
  return { hang: true };
};

test('procguard asked: csc builds it into runtime\\procguard\\<source sha256> at this startup, the resident says ready, and the codex gate allows only the wrapped rule, with its env allowlist written', async (t) => {
  const appData = path.join(fs.realpathSync.native(withTmp(t)), 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  await working(t, { APPDATA: appData }, true, (w) => {
    const pg = w.o.procguard;
    assert.equal(pg.on, true, JSON.stringify(pg));
    if (!pg.on) return;
    const dir = path.join(w.home, 'runtime', 'procguard', PROCGUARD_SOURCE_SHA256);
    assert.equal(pg.exe, path.join(dir, 'procguard.exe'));
    assert.equal(pg.built, true);
    assert.equal(fs.readFileSync(path.join(dir, 'procguard.exe'), 'utf8'), 'MZ fake');
    // Phase 4 review: its sha256 is held in memory only, never written next to it.
    assert.equal(fs.existsSync(path.join(dir, 'procguard.exe.sha256')), false);
    assert.equal(fs.existsSync(path.join(dir, 'procguard.new.exe')), false);
    assert.ok(w.out.some((l) => l.startsWith('orchestrad: procguard on (built ')), w.out.join('\n'));
    const s = w.o.ownedCodex;
    assert.ok(s.on && s.jobs, JSON.stringify(s));
    const spec = w.specs.find((x) => x.rules.includes('procguard-codex'))!;
    assert.deepEqual([...spec.rules], ['procguard-codex'], 'no codex.exe outside a Job');
    assert.equal(spec.procguardEnv?.['codex-app-server'], path.join(dir, 'env-codex-app-server.txt'));
    const text = fs.readFileSync(path.join(dir, 'env-codex-app-server.txt'), 'utf8');
    const names = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    assert.ok(names.includes('CODEX_HOME') && names.includes('APPDATA') && LIBUV_ADDED_ENV.every((n) => names.some((x) => x.toLowerCase() === n.toLowerCase())), names.join(','));
    assert.ok(!text.includes(appData), 'names only, no value on disk');
    const pgSpec = w.specs.find((x) => x.rules.includes('csc'))!;
    assert.deepEqual([...pgSpec.rules], ['csc', 'procguard']);
  }, { procguard: true, behave: pgBehave('MZ fake') });
});

test('procguard asked and not built: no owned session at all (r4 D4: none outside a Job), with procguard\'s reason on the console and in the outcome', async (t) => {
  const appData = path.join(fs.realpathSync.native(withTmp(t)), 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  await working(t, { APPDATA: appData }, true, (w) => {
    assert.deepEqual(w.o.procguard, { on: false, why: 'procguard-build-failed', detail: 'csc wrote no exe' });
    assert.ok(w.out.includes('orchestrad: procguard is off: procguard-build-failed (csc wrote no exe); owned sessions are off (r4 D4: no owned session outside a Job of its own)'), w.out.join('\n'));
    assert.deepEqual(w.o.ownedCodex, { on: false, why: 'procguard-build-failed', detail: 'csc wrote no exe' });
    assert.deepEqual(w.o.ownedClaude, { on: false, why: 'procguard-build-failed', detail: 'csc wrote no exe' });
    assert.equal(w.specs.filter((x) => x.rules.some((r) => r !== 'csc' && r !== 'procguard')).length, 0, 'no session gate at all: no codex.exe, no host outside a Job');
  }, { procguard: true, behave: pgBehave(null) });
});

test('a procguard.exe and sha256 file an earlier orchestrad left are never used: built again at this startup, the old record removed', async (t) => {
  const appData = path.join(fs.realpathSync.native(withTmp(t)), 'Roaming');
  put(path.join(appData, CODEX_EXE_REL), 'not really codex');
  await working(t, { APPDATA: appData }, true, (w) => {
    const pg = w.o.procguard;
    assert.equal(pg.on, true, JSON.stringify(pg));
    const dir = path.join(w.home, 'runtime', 'procguard', PROCGUARD_SOURCE_SHA256);
    assert.equal(fs.readFileSync(path.join(dir, 'procguard.exe'), 'utf8'), 'MZ fresh', 'the swapped exe was built over');
    assert.equal(fs.existsSync(path.join(dir, 'procguard.exe.sha256')), false);
    assert.ok(w.o.ownedCodex.on);
  }, {
    procguard: true,
    behave: pgBehave('MZ fresh'),
    // The site as an earlier build left it, then swapped together with its record: put in place before the working mode reads it.
    readGate: ((spec) => {
      const home = (spec as { orchestraHome?: string }).orchestraHome;
      if (home !== undefined) {
        const dir = path.join(home, 'runtime', 'procguard', PROCGUARD_SOURCE_SHA256);
        if (!fs.existsSync(dir)) {
          put(path.join(dir, 'procguard.exe'), 'MZ swapped');
          put(path.join(dir, 'procguard.exe.sha256'), `${crypto.createHash('sha256').update('MZ swapped').digest('hex')}\n`);
        }
      }
      return makeReadGate(spec);
    }) as typeof makeReadGate,
  });
});
