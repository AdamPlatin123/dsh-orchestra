import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import type { AllowRule, ReadIo } from '../../src/fs/read-gate.ts';
import type { WriteIo } from '../../src/fs/write-fence.ts';
import { launcherRootFs } from '../../src/fs/harness-roots.ts';
import { makeReadGate, makeWriteFence, realpath } from '../../src/fs/node-io.ts';
import { canonicalize } from '../../src/fs/paths.ts';
import { ALLOW_RULES, DENY_RULES, LISTABLE, ReadGate } from '../../src/fs/read-gate.ts';
import { WriteFence } from '../../src/fs/write-fence.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { CSC_FLAGS, HANDLE_KEYS, SpawnGate, TOAST_FLAGS, WHOAMI_ARGV, WHOAMI_REL, resolveSystemRoot } from '../../src/os/spawn.ts';
import type { BuiltinRow } from '../../src/runtime/builtin-policy.ts';
import { BUILTIN_ROWS, DEFAULT_BUILTINS, FORBIDDEN_BUILTINS, MINTED_MODULES, NO_BUILTIN_DIRS, builtinId, decideBuiltin } from '../../src/runtime/builtin-policy.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { checkDataDir } from '../../src/runtime/data-dir.ts';
import { resolveEnv } from '../../src/runtime/env.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { decideImport } from '../../src/runtime/import-fence.ts';
import { Log } from '../../src/runtime/log.ts';
import { ownEnv } from '../../src/runtime/own.ts';
import { checkInTestRealProfile, parseProfileArgs } from '../../src/runtime/test-profile.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { FORMAT_RULES, SYSTEM_VARIABLES, makeRedactor } from '../../src/store/redact.ts';
import { EXIT } from '../../src/runtime/exit.ts';
import { CSRF_RE } from '../../src/server/routes.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';
import { ID_RE, TOOL_NAME_RE } from '../../shared/protocol.js';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { realIo } from '../helpers/read-io.ts';
import { openPaths } from '../helpers/frozen-walk.ts';
import { findImports } from '../helpers/scan-rules.ts';
import { FENCE_OK, captureConsole, minimalEnv, startInProcess, testPorts } from '../helpers/start.ts';
import { put, treeDigest, withModuleTmp, withTmp } from '../helpers/tmp.ts';
import { realWriteIo } from '../helpers/write-io.ts';

// Step 2c: node:fs and node:child_process are minted. boot.ts imports src/fs/node-io.ts and
// src/os/node-proc.ts before the import fence goes in and hands their gate factories down in
// BootPorts; after that nobody can resolve them, and a gate built any other way reaches nothing real.
// Every measure here runs in a child through boot() with the real fence, and each has a control that
// shows the same attack does land when the defense is not there.

const REPO = new URL('../../', import.meta.url);
const REPO_DIR = fileURLToPath(REPO);
const SRC_URL = new URL('../../src/', import.meta.url).href;
const src = (rel: string) => `${SRC_URL}${rel}`;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const srcFiles = () => walk(path.join(REPO_DIR, 'src')).map((f) => ({ rel: path.relative(REPO_DIR, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

type Child = { status: number | null; stdout: string; stderr: string; dir: string };

/**
 * Writes `files` and `runner` into a fresh orchestra-test-* dir and runs the runner with `arg` (JSON)
 * as its one argument. BOOT_RUNNER goes through boot() and the real fence; BARE_RUNNER does not.
 */
function runChild(t: TestContext, files: Record<string, string>, runner: string, arg: unknown): Child {
  const dir = withModuleTmp(t);
  for (const [name, text] of Object.entries(files)) put(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, 'runner.mjs'), runner);
  const r = spawnSync(process.execPath, [path.join(dir, 'runner.mjs'), JSON.stringify(arg)], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, dir };
}

const BOOT_RUNNER = [
  `import { boot } from ${JSON.stringify(src('boot.ts'))};`,
  "const o = await boot(new URL('./entry.ts', import.meta.url));",
  'console.log(JSON.stringify(o.started ? o.result : { refused: o.reason }));',
].join('\n');
const BARE_RUNNER = [
  "const m = await import(new URL('./entry.ts', import.meta.url).href);",
  'console.log(JSON.stringify(await m.start()));',
].join('\n');

function lastJson<T>(c: Child): T {
  assert.equal(c.status, 0, c.stderr);
  const line = c.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  return JSON.parse(line) as T;
}

/** A fixture dir that is its own canonical form (the write fence's confine needs one). */
function canonicalTmp(t: TestContext): string {
  return fs.realpathSync.native(withTmp(t));
}

// ---------------------------------------------------------------------------------------------
// The table and the code agree.

test('exactly one src file imports node:fs, one node:child_process and one node:sqlite; all three are minted and only boot.ts imports them', () => {
  const files = srcFiles();
  const importers = (pred: (id: string) => boolean) => files
    .filter((f) => findImports(f.text).some((r) => !r.typeOnly && (r.spec.startsWith('node:') || ['fs', 'fs/promises', 'child_process'].includes(r.spec)) && pred(builtinId(r.spec))))
    .map((f) => f.rel);
  assert.deepEqual(importers((id) => id === 'node:fs' || id.startsWith('node:fs/')), ['src/fs/node-io.ts']);
  assert.deepEqual(importers((id) => id === 'node:child_process'), ['src/os/node-proc.ts']);
  assert.deepEqual(importers((id) => id === 'node:sqlite'), ['src/store/node-sqlite.ts']);
  assert.deepEqual([...MINTED_MODULES].sort(), ['src/fs/node-io.ts', 'src/os/node-proc.ts', 'src/store/node-sqlite.ts']);
  const mintedImporters = files.filter((f) => findImports(f.text).some((r) => !r.typeOnly && MINTED_MODULES.some((m) => path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), r.spec)).toLowerCase() === m)))
    .map((f) => f.rel);
  assert.deepEqual(mintedImporters, ['src/boot.ts']);
});

test('the minted modules export gate factories and the realpath port only; an io or backend in a spec is ignored', async (t) => {
  assert.deepEqual(Object.keys(await import('../../src/fs/node-io.ts')).sort(), ['makeReadGate', 'makeWriteFence', 'realpath']);
  assert.deepEqual(Object.keys(await import('../../src/os/node-proc.ts')).sort(), ['makeSpawnGate']);
  assert.deepEqual(Object.keys(await import('../../src/store/node-sqlite.ts')).sort(), ['makeDbOpener']);
  const dir = canonicalTmp(t);
  const root = path.join(dir, 'claude');
  put(path.join(root, 'sessions', '7.json'), 'REAL');
  const seen: string[] = [];
  const spyIo = Object.fromEntries(Object.entries(realIo).map(([k, f]) => [k, (...a: unknown[]) => { seen.push(k); return (f as (...x: unknown[]) => unknown)(...a); }])) as unknown as ReadIo;
  const gate = makeReadGate({ roots: [{ kind: 'claude', path: root, real: root }], io: spyIo } as Parameters<typeof makeReadGate>[0]);
  assert.equal(gate.readFile(path.join(root, 'sessions', '7.json')).toString(), 'REAL');
  const wseen: string[] = [];
  const wspy = Object.fromEntries(Object.entries(realWriteIo).map(([k, f]) => [k, (...a: unknown[]) => { wseen.push(k); return (f as (...x: unknown[]) => unknown)(...a); }])) as unknown as WriteIo;
  const fence = await makeWriteFence({ orchestraHome: path.join(dir, 'orch'), harnessRoots: [], io: wspy } as Parameters<typeof makeWriteFence>[0]);
  fence.mkdirp(path.join(dir, 'orch'));
  fence.writeAtomic(path.join(dir, 'orch', 'x.txt'), 'written');
  assert.equal(fs.readFileSync(path.join(dir, 'orch', 'x.txt'), 'utf8'), 'written');
  assert.deepEqual([seen, wseen], [[], []], 'the gates used node-io.ts\'s own io, not the one in the spec');
  const spy = fakeSpawn();
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const sg = makeSpawnGate({ systemRoot: sys, rules: ['whoami'], record: () => {}, realpath, clock: makeRealClock(), env: process.env, backend: spy.backend } as Parameters<typeof makeSpawnGate>[0]);
  const r = await sg.run({ exe: path.join(sys.path, WHOAMI_REL), argv: WHOAMI_ARGV }, { timeoutMs: 10_000, maxBytes: 256 * 1024 });
  assert.equal(spy.calls.length, 0, 'the spec\'s backend was not used');
  assert.ok(r.ok && /S-1-16-\d+/.test(r.stdout.toString('latin1')) || (!r.ok && r.reason !== 'refused'), JSON.stringify(r));
  // The opener factory ignores a backend in its spec: the database is real and the spy is never called.
  const dbSeen: string[] = [];
  const spyBackend = { codes: { OK: 0, DENY: 0, SELECT: 0, READ: 0, FUNCTION: 0, PRAGMA: 0, ATTACH: 0, DETACH: 0, TRANSACTION: 0, RECURSIVE: 0 }, open: (f: string) => { dbSeen.push(f); throw new Error('spy'); } };
  const opener = await makeDbOpener({ fence, backend: spyBackend } as Parameters<typeof makeDbOpener>[0]);
  let mode: unknown;
  try {
    const db = opener.open(path.join(dir, 'orch', 'x.db'));
    mode = db.pragma('journal_mode');
    db.close();
  } catch (e) {
    mode = `threw ${(e as Error).message}`;
  }
  assert.deepEqual(dbSeen, [], 'the opener used node-sqlite.ts\'s own backend, not the one in the spec');
  assert.equal(mode, 'wal');
});

test('decideImport: once the fence is in, a minted module resolves for nobody, however its URL is spelled', () => {
  const R = REPO.href;
  const why = (parent: string | undefined, url: string) => {
    const d = decideImport(parent, url, undefined, REPO);
    return d.allow ? 'allow' : d.reason;
  };
  const parents = [`${R}src/main.ts`, `${R}src/boot.ts`, `${R}src/runtime/working.ts`, `${R}src/workers/bootstrap.ts`, 'file:///C:/Temp/orchestra-test-x/entry.ts', undefined];
  for (const m of ['fs/node-io.ts', 'os/node-proc.ts', 'store/node-sqlite.ts']) {
    for (const url of [`${R}src/${m}`, `${R}src/${m}?v=2`, `${R}src/${m}#x`, `${R}SRC/${m.toUpperCase().replace('.TS', '.ts')}`, `${R}src/fs/../${m}`.replace('/fs/../', '/')]) {
      for (const p of parents) assert.equal(why(p, url), 'minted-before-fence', `${p} -> ${url}`);
    }
  }
  assert.equal(why(`${R}src/main.ts`, `${R}src/fs/read-gate.ts`), 'allow');
  assert.equal(why(`${R}src/main.ts`, `${R}src/os/spawn.ts`), 'allow');
});

test('realpath, io, backend and clock are required ports: nothing has a default any more', async (t) => {
  const dir = canonicalTmp(t);
  const without = <T extends object>(o: T, k: keyof T) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k)) as T;
  assert.throws(() => new ReadGate({ roots: [] } as never), /read gate: io\.realpath is required/);
  assert.throws(() => new ReadGate({ roots: [], io: without(realIo, 'readdirSync') }), /read gate: io\.readdirSync is required/);
  assert.throws(() => new WriteFence({ orchestraHome: path.join(dir, 'o'), harnessRoots: [] } as never), /write fence: io\.realpath is required/);
  assert.throws(() => new WriteFence({ orchestraHome: path.join(dir, 'o'), harnessRoots: [], io: without(realWriteIo, 'ftruncateSync') }), /write fence: io\.ftruncateSync is required/);
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const base = { systemRoot: sys, rules: ['whoami' as const], record: () => {}, backend: fakeSpawn().backend, realpath, clock: makeRealClock(), env: process.env };
  for (const k of ['backend', 'realpath', 'clock'] as const) assert.throws(() => new SpawnGate(without(base, k)), new RegExp(`spawn gate: ${k} is required`));
  // A clock that is no hub (a bare now function, as before step 3) is no clock either.
  assert.throws(() => new SpawnGate({ ...without(base, 'clock'), now: Date.now } as never), /spawn gate: clock is required/);
  assert.throws(() => canonicalize(dir, undefined as never), TypeError);
  assert.throws(() => checkDataDir({ orchestraHome: path.join(dir, 'o'), userHome: path.join(dir, 'h'), roots: [] } as never), /data dir check: realpath is required/);
  assert.throws(() => parseProfileArgs(['--test-profile', '--test-dir', dir], { env: {}, processEnv: {} } as never), /profile: realpath is required/);
  assert.deepEqual(checkInTestRealProfile({ fakeHome: dir }, { env: {}, processEnv: {}, home: dir } as never), { reason: 'in-test-real-profile-refused', detail: 'unresolvable', path: 'no realpath' });
  const env = resolveEnv({ home: path.join(dir, 'home'), env: {} });
  assert.throws(() => launcherRootFs(env, { makeReadGate } as never), /launcherRootFs: makeReadGate and realpath are required/);
  const ports = testPorts();
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, without(ports, 'makeSpawnGate'), {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port,
  }), /start: BootPorts\.makeSpawnGate is missing/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, without(ports, 'makeDbOpener'), {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port,
  }), /start: BootPorts\.makeDbOpener is missing/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, without(ports, 'clock'), {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port,
  }), /start: BootPorts\.clock is missing/);
  await assert.rejects(startInProcess(detectFeatures(), FENCE_OK, { ...without(ports, 'clock'), clock: { now: Date.now } } as never, {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port,
  }), /start: BootPorts\.clock is missing/);
  assert.throws(() => new Log({} as never), /log: clock is required/);
});

// ---------------------------------------------------------------------------------------------
// A1: a gate built by anyone but the factories reaches nothing real.

const DUMMY_IO = `
type Fn = (...a: unknown[]) => unknown;
const isFile = (p: unknown) => /\\.\\w+$/.test(String(p));
const missing = (p: unknown) => /\\\\new[^\\\\]*$|\\.tmp$/i.test(String(p));
const enoent = () => Object.assign(new Error('ENOENT (dummy)'), { code: 'ENOENT' });
const st = (p: unknown) => {
  if (missing(p)) throw enoent();
  return { dev: 1n, ino: 1n, nlink: 1n, size: 4n, mtimeMs: 0n, isFile: () => isFile(p), isDirectory: () => !isFile(p), isSymbolicLink: () => false };
};
const dummyIo = (): Record<string, Fn> => ({
  realpath: (p) => { if (missing(p)) throw enoent(); return p; },
  openSync: () => 3,
  readSync: (_fd, buf, off) => { (buf as Uint8Array).fill(0x5a, off as number); return 0; },
  fstatSync: () => st('x.file'),
  statSync: st,
  lstatSync: st,
  closeSync: () => {},
  readdirSync: () => [],
  writeSync: (_fd, _b, _o, len) => len,
  fsyncSync: () => {},
  ftruncateSync: () => {},
  renameSync: () => {},
  unlinkSync: () => {},
  rmdirSync: () => {},
  mkdirSync: () => {},
  mkdtempSync: (prefix) => String(prefix) + 'AAAAAA',
});
const recordingIo = (log: string[]): Record<string, Fn> => Object.fromEntries(Object.entries(dummyIo()).map(([k, f]) => [k, (...a: unknown[]) => { log.push(k + ' ' + String(a[0])); return f(...a); }]));
`;

const A1_ENTRY = `
import * as path from 'node:path';
import { ReadGate } from ${JSON.stringify(src('fs/read-gate.ts'))};
import { WriteFence } from ${JSON.stringify(src('fs/write-fence.ts'))};
${DUMMY_IO}
const win = path.win32;
type P = { testDir: string; home: string; sentinel: string; readRoot: string; outside: string };
type Gate = { readFile(p: string): Uint8Array; readdir(p: string): string[] };
type Fence = Record<string, (...a: unknown[]) => unknown>;
const why = (e: unknown) => (e as { code?: string }).code ?? (e as Error).name;

export async function start(_f?: unknown, _fence?: unknown, ports?: Record<string, (s: unknown) => unknown>): Promise<unknown> {
  const p = JSON.parse(process.argv[2]!) as P;
  const out: Record<string, unknown> = {};
  // A real io, if this module can get one: only when it runs without the fence (the control).
  let real: Record<string, Fn> | null = null;
  try {
    const fs = await import('node:fs');
    real = {
      realpath: (x) => fs.realpathSync.native(x as string), openSync: (x, fl) => fs.openSync(x as string, fl === 'append-existing' ? fs.constants.O_WRONLY | fs.constants.O_APPEND : fl as string),
      readSync: (fd, b, o, l, pos) => fs.readSync(fd as number, b as Uint8Array, o as number, l as number, pos as number), fstatSync: (fd) => fs.fstatSync(fd as number, { bigint: true }),
      statSync: (x) => fs.statSync(x as string, { bigint: true }), lstatSync: (x) => fs.lstatSync(x as string), closeSync: (fd) => fs.closeSync(fd as number),
      readdirSync: (x) => fs.readdirSync(x as string, { withFileTypes: true }), writeSync: (fd, b, o, l) => fs.writeSync(fd as number, b as Uint8Array, o as number, l as number),
      fsyncSync: (fd) => fs.fsyncSync(fd as number), ftruncateSync: (fd, l) => fs.ftruncateSync(fd as number, l as number), renameSync: (a, b) => fs.renameSync(a as string, b as string),
      unlinkSync: (x) => fs.unlinkSync(x as string), rmdirSync: (x) => fs.rmdirSync(x as string), mkdirSync: (x) => fs.mkdirSync(x as string), mkdtempSync: (x) => fs.mkdtempSync(x as string),
    };
  } catch (e) {
    out.realIo = (e as { reason?: string }).reason ?? why(e);
  }
  const handedRead = ports?.makeReadGate({ roots: [{ kind: 'claude', path: p.readRoot, real: p.readRoot }], testDirs: [p.testDir] }) as object | undefined;
  const handedFence = (ports === undefined ? undefined : await ports.makeWriteFence({ orchestraHome: p.home, harnessRoots: [], confine: p.testDir })) as Fence | undefined;
  const readCfg = (io: unknown) => ({ roots: [{ kind: 'claude', path: p.readRoot, real: p.readRoot }], io });
  const writeCfg = (io: unknown) => ({ orchestraHome: p.sentinel, harnessRoots: [], io });
  type Ctor = new (c: unknown) => unknown;
  const ways: Record<string, (C: Ctor, handed: object | undefined, cfg: unknown) => unknown> = {
    constructor: (C, handed, cfg) => new ((handed ?? { constructor: C }) as { constructor: Ctor }).constructor(cfg),
    reflect: (C, _h, cfg) => Reflect.construct(C, [cfg]),
    'import-new': (C, _h, cfg) => new C(cfg),
    extends: (C, _h, cfg) => { const Evil = class extends C {}; return new Evil(cfg); },
  };
  const secret = win.join(p.readRoot, 'sessions', '7.json');
  const keep = win.join(p.sentinel, 'keep.txt');
  const ops: Record<string, (g: unknown) => unknown> = {
    readFile: (g) => Buffer.from((g as Gate).readFile(secret)).toString('latin1'),
    readdir: (g) => (g as Gate).readdir(win.join(p.readRoot, 'sessions')).join(','),
    rm: (g) => (g as Fence).rm!(keep),
    writeAtomic: (g) => (g as Fence).writeAtomic!(keep, 'EVIL'),
    append: (g) => (g as Fence).append!(keep, 'EVIL'),
    mkdirp: (g) => (g as Fence).mkdirp!(win.join(p.sentinel, 'newdir')),
    mkdtemp: (g) => (g as Fence).mkdtemp!(p.sentinel, 'evil-'),
  };
  const ios: Record<string, (log: string[]) => Record<string, Fn>> = real === null
    ? { dummy: () => dummyIo(), recording: (log) => recordingIo(log) }
    : { real: () => real! };
  const attempts: unknown[] = [];
  for (const [way, build] of Object.entries(ways)) {
    for (const [ioName, mk] of Object.entries(ios)) {
      for (const [op, run] of Object.entries(ops)) {
        const log: string[] = [];
        const isRead = op === 'readFile' || op === 'readdir';
        let result: unknown;
        try {
          const g = isRead ? build(ReadGate as unknown as Ctor, handedRead, readCfg(mk(log))) : build(WriteFence as unknown as Ctor, handedFence, writeCfg(mk(log)));
          const v = run(g);
          result = typeof v === 'string' ? v : 'done';
        } catch (e) {
          result = 'threw ' + why(e);
        }
        const realBytes = typeof result === 'string' && (result.includes('SECRET-7') || result.split(',').includes('7.json'));
        attempts.push({ way, io: ioName, op, result: String(result).slice(0, 40), realBytes, ioCalls: log.length });
      }
    }
  }
  out.attempts = attempts;
  if (handedRead !== undefined && handedFence !== undefined) {
    // The handed gates still work: the port is the one way in (positive control).
    out.handedRead = Buffer.from((handedRead as Gate).readFile(secret)).toString('latin1');
    (handedFence.mkdirp as (d: string) => unknown)(p.home);
    (handedFence.writeAtomic as (f: string, d: string) => unknown)(win.join(p.home, 'handed.txt'), 'via the port');
    // Nobody can retune a handed gate: prototype, fields and prototype link are frozen.
    const tamper: Record<string, string> = {};
    const tryIt = (name: string, fn: () => unknown) => { try { fn(); tamper[name] = 'reached'; } catch (e) { tamper[name] = why(e); } };
    tryIt('patchPrototype', () => { (Object.getPrototypeOf(handedFence) as Record<string, unknown>).check = () => ({ allow: true }); });
    tryIt('patchReadPrototype', () => { (Object.getPrototypeOf(handedRead) as Record<string, unknown>).readFile = () => 'forged'; });
    tryIt('setHome', () => { (handedFence as Record<string, unknown>).home = 'C:\\\\'; });
    tryIt('setMilestone', () => { (handedRead as Record<string, unknown>).milestone = 'M6'; });
    tryIt('setPrototypeOf', () => Object.setPrototypeOf(handedFence, { writeAtomic() { return 'forged'; } }));
    tryIt('growDenyRoots', () => (handedFence.denyRoots as unknown as string[]).push('C:\\\\x'));
    tryIt('handedOutside', () => (handedFence.writeAtomic as (f: string, d: string) => unknown)(win.join(p.outside, 'x.txt'), 'EVIL'));
    out.tamper = tamper;
    // A subclass that overrides the public check() does not steer the fence's own decisions.
    const log: string[] = [];
    class Steered extends (WriteFence as unknown as Ctor) { check(target: string, op: string) { return { allow: true, op, path: target, real: target }; } }
    const steered = new Steered(writeCfg(recordingIo(log))) as Fence;
    let steer: string;
    try { (steered.writeAtomic as (f: string, d: string) => unknown)(win.join(p.outside, 'x.txt'), 'EVIL'); steer = 'reached'; } catch (e) { steer = why(e); }
    // Only acts count: resolving or looking at the outside path is how the check itself decides.
    const acts = /^(openSync|writeSync|fsyncSync|ftruncateSync|renameSync|unlinkSync|rmdirSync|mkdirSync|mkdtempSync) /;
    // mkdtemp judges what it made once more, privately: a dir that turned up outside is removed again.
    const tlog: string[] = [];
    const tio = { ...recordingIo(tlog), mkdtempSync: (prefix: unknown) => { tlog.push('mkdtempSync ' + String(prefix)); return win.join(p.outside, 'evil-AAAAAA'); } };
    const steeredTemp = new Steered(writeCfg(tio)) as Fence;
    let temp: string;
    try { temp = String((steeredTemp.mkdtemp as (d: string, x: string) => unknown)(p.sentinel, 'x-')); } catch (e) { temp = why(e); }
    out.steered = {
      result: steer, ioCallsOutside: log.filter((l) => acts.test(l) && l.toLowerCase().includes(p.outside.toLowerCase())).length,
      mkdtemp: temp, removedAgain: tlog.filter((l) => l.startsWith('rmdirSync ') && l.toLowerCase().includes(p.outside.toLowerCase())).length,
    };
  }
  return out;
}
`;

type Attempt = { way: string; io: string; op: string; result: string; realBytes: boolean; ioCalls: number };

function a1Fixture(t: TestContext) {
  const testDir = canonicalTmp(t);
  const p = {
    testDir,
    home: path.join(testDir, 'orch'),
    sentinel: path.join(testDir, 'sentinel'),
    readRoot: path.join(testDir, 'read-root'),
    outside: path.join(testDir, 'outside'),
  };
  put(path.join(p.sentinel, 'keep.txt'), 'KEEP');
  put(path.join(p.sentinel, 'sub', 'x.txt'), 'X');
  put(path.join(p.readRoot, 'sessions', '7.json'), 'SECRET-7');
  fs.mkdirSync(p.outside);
  return p;
}

test('A1 measured: through boot, gates rebuilt by .constructor, Reflect.construct, import + new or a subclass, with their own roots and io, change nothing and read no real byte; unfenced the same module with a real io does', (t) => {
  const p = a1Fixture(t);
  const before = { sentinel: treeDigest(p.sentinel), readRoot: treeDigest(p.readRoot), outside: treeDigest(p.outside) };
  const r = lastJson<{ realIo: string; attempts: Attempt[]; handedRead: string; tamper: Record<string, string>; steered: { result: string; ioCallsOutside: number } }>(
    runChild(t, { 'entry.ts': A1_ENTRY }, BOOT_RUNNER, p),
  );
  assert.equal(r.realIo, 'not-allowed-for-module', 'the module could not import node:fs');
  assert.equal(r.attempts.length, 4 * 2 * 7, 'N = 4 ways x 2 ios x 7 ops');
  t.diagnostic(`A1 N = ${r.attempts.length}; attempts that reached their own io: ${r.attempts.filter((a) => a.ioCalls > 0).length}`);
  assert.deepEqual(r.attempts.filter((a) => a.realBytes), [], 'no real byte or name was read back');
  assert.ok(r.attempts.filter((a) => a.io === 'recording').every((a) => a.ioCalls > 0), 'every recorded attempt acted, on its own io only');
  assert.deepEqual({ sentinel: treeDigest(p.sentinel), readRoot: treeDigest(p.readRoot), outside: treeDigest(p.outside) }, before, 'real side effects: 0');
  assert.equal(r.handedRead, 'SECRET-7', 'the handed gate reads (positive control)');
  assert.equal(fs.readFileSync(path.join(p.home, 'handed.txt'), 'utf8'), 'via the port');
  assert.deepEqual(r.tamper, {
    patchPrototype: 'TypeError', patchReadPrototype: 'TypeError', setHome: 'TypeError', setMilestone: 'TypeError', setPrototypeOf: 'TypeError', growDenyRoots: 'TypeError',
    handedOutside: 'ERR_ORCHESTRA_WRITE_FENCE',
  });
  assert.deepEqual(r.steered, { result: 'ERR_ORCHESTRA_WRITE_FENCE', ioCallsOutside: 0, mkdtemp: 'ERR_ORCHESTRA_WRITE_FENCE', removedAgain: 1 });

  // Control: the same module without the fence gets a real io, and the same attacks land.
  const c = a1Fixture(t);
  const cBefore = treeDigest(c.sentinel);
  const cr = lastJson<{ realIo?: string; attempts: Attempt[] }>(runChild(t, { 'entry.ts': A1_ENTRY }, BARE_RUNNER, c));
  assert.equal(cr.realIo, undefined);
  assert.equal(cr.attempts.length, 4 * 1 * 7);
  assert.ok(cr.attempts.filter((a) => a.op === 'readFile').every((a) => a.realBytes), JSON.stringify(cr.attempts));
  assert.notEqual(treeDigest(c.sentinel), cBefore, 'control: the sentinel changed');
});

// ---------------------------------------------------------------------------------------------
// The minted modules cannot be reached after the fence, by any spelling, from a worker either.

const IMPORT_ENTRY = `
import { startWorker } from ${JSON.stringify(src('runtime/workers.ts'))};
const base = ${JSON.stringify(SRC_URL)};
const why = async (f: () => Promise<unknown>) => { try { await f(); return 'loaded'; } catch (e) { return (e as { reason?: string }).reason ?? (e as Error).message; } };
const viaFunction = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
export async function start(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, rel] of [['io', 'fs/node-io.ts'], ['proc', 'os/node-proc.ts'], ['sqlite', 'store/node-sqlite.ts']]) {
    out[name] = {
      static: await why(() => import(new URL('./static-' + name + '.ts', import.meta.url).href)),
      concatenated: await why(() => import(base + rel)),
      query: await why(() => import(base + rel + '?v=2')),
      hash: await why(() => import(base + rel + '#x')),
      upper: await why(() => import(base.replace('/src/', '/SRC/') + rel)),
      viaFunction: await why(() => viaFunction(base + rel)),
    };
  }
  out.control = await why(() => import(base + 'fs/read-gate.ts'));
  out.sqliteBuiltin = await why(() => import(new URL('./static-builtin.ts', import.meta.url).href));
  out.worker = await new Promise((resolve) => {
    const w = startWorker(new URL('./worker-io.ts', import.meta.url));
    let error = '';
    w.on('error', (e) => { error = (e as Error).message; });
    w.on('message', (m) => { error = 'message ' + JSON.stringify(m); });
    w.on('exit', () => resolve(error));
  });
  return out;
}
`;

test('after the fence, node-io.ts, node-proc.ts and node-sqlite.ts fail with minted-before-fence: static, concatenated, ?query, #hash, other case, Function-made code, and in a worker; node:sqlite itself for any other module', (t) => {
  const files = {
    'entry.ts': IMPORT_ENTRY,
    'static-io.ts': `import { realpath } from ${JSON.stringify(src('fs/node-io.ts'))};\nexport const got = typeof realpath;\n`,
    'static-proc.ts': `import { makeSpawnGate } from ${JSON.stringify(src('os/node-proc.ts'))};\nexport const got = typeof makeSpawnGate;\n`,
    'static-sqlite.ts': `import { makeDbOpener } from ${JSON.stringify(src('store/node-sqlite.ts'))};\nexport const got = typeof makeDbOpener;\n`,
    'static-builtin.ts': "import { DatabaseSync } from 'node:sqlite';\nexport const got = typeof DatabaseSync;\n",
    'worker-io.ts': `import { makeReadGate } from ${JSON.stringify(src('fs/node-io.ts'))};\nexport function run(ctx: { post(m: unknown): void }): void { ctx.post(typeof makeReadGate); }\n`,
  };
  const r = lastJson<Record<string, Record<string, string> | string>>(runChild(t, files, BOOT_RUNNER, {}));
  const all = { static: 'minted-before-fence', concatenated: 'minted-before-fence', query: 'minted-before-fence', hash: 'minted-before-fence', upper: 'minted-before-fence', viaFunction: 'minted-before-fence' };
  assert.deepEqual(r.io, all);
  assert.deepEqual(r.proc, all);
  assert.deepEqual(r.sqlite, all);
  assert.equal(r.sqliteBuiltin, 'not-allowed-for-module');
  assert.equal(r.control, 'loaded');
  assert.match(String(r.worker), /ERR_ORCHESTRA_IMPORT_FENCE.*node-io\.ts denied \(minted-before-fence\)/);

  // Control: unfenced, every spelling loads (a worker still goes through bootstrap's own fence).
  const c = lastJson<Record<string, Record<string, string> | string>>(runChild(t, files, BARE_RUNNER, {}));
  assert.deepEqual(c.io, { static: 'loaded', concatenated: 'loaded', query: 'loaded', hash: 'loaded', upper: 'loaded', viaFunction: 'loaded' });
  assert.deepEqual(c.sqlite, { static: 'loaded', concatenated: 'loaded', query: 'loaded', hash: 'loaded', upper: 'loaded', viaFunction: 'loaded' });
  assert.equal(c.sqliteBuiltin, 'loaded');
});

// ---------------------------------------------------------------------------------------------
// A2: a SpawnGate built by anyone but makeSpawnGate starts no process.

const SPAWN_RUNNER = [
  "import cp from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'const spawns = [];',
  'const realSpawn = cp.spawn;',
  'cp.spawn = function (file, args, options) {',
  '  const envKeys = [];',
  '  for (const k in options.env) envKeys.push(k);',
  "  spawns.push({ file, argv: args, protoNull: Object.getPrototypeOf(options) === null, poisonInEnv: envKeys.includes('ORCHESTRA_POISON_ENV') });",
  '  return realSpawn.call(this, file, args, options);',
  '};',
  'syncBuiltinESMExports();',
  `const { boot } = await import(${JSON.stringify(src('boot.ts'))});`,
  "const o = await boot(new URL('./entry.ts', import.meta.url));",
  'console.log(JSON.stringify({ spawns, result: o.started ? o.result : { refused: o.reason } }));',
].join('\n');

const A2_ENTRY = `
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { CSC_FLAGS, PROCGUARD_SOURCE, SpawnGate, WHOAMI_ARGV, resolveSystemRoot } from ${JSON.stringify(src('os/spawn.ts'))};
const win = path.win32;
const why = (e: unknown) => (e as { code?: string }).code ?? (e as Error).name;
type Gate = { run(r: unknown, l: unknown): Promise<{ ok: boolean; reason?: string; stdout?: Uint8Array }>; start(r: unknown): { kill(): void } };
type Ctor = new (c: unknown) => Gate;
const fakeChild = () => {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  ee.pid = 4242; ee.stdin = null; ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter();
  ee.kill = () => true;
  setImmediate(() => ee.emit('close', 0, null));
  return ee;
};
const LIMITS = { timeoutMs: 5000, maxBytes: 4096 };
export async function start(_f: unknown, _fence: unknown, ports: { realpath(p: string): string; makeSpawnGate(s: unknown): Gate; clock: unknown }): Promise<unknown> {
  const p = JSON.parse(process.argv[2]!) as { dir: string };
  const id = (x: string) => x;
  const handed = ports.makeSpawnGate({ systemRoot: resolveSystemRoot(process.env, ports.realpath), rules: ['whoami'], record: () => {}, realpath: ports.realpath, clock: ports.clock, env: process.env });
  const hash = 'a'.repeat(64);
  const pgExe = win.join(p.dir, 'runtime', 'procguard', hash, 'procguard.exe');
  const configs: Record<string, Record<string, unknown>> = {
    'fake-root': { systemRoot: resolveSystemRoot({ SystemRoot: 'C:\\\\orchestra-fake-sys' }, id), rules: ['whoami'] },
    'real-root': { systemRoot: resolveSystemRoot(process.env, id), rules: ['whoami'] },
    'csc-procguard': {
      systemRoot: resolveSystemRoot(process.env, id), rules: ['whoami', 'csc', 'procguard'], csc: { outAllowed: () => true },
      procguard: [{ at: 'runtime', homeReal: p.dir, sourceHash: hash }],
    },
  };
  const ways: Record<string, (cfg: unknown) => Gate> = {
    constructor: (cfg) => new ((handed as unknown as { constructor: Ctor }).constructor)(cfg),
    reflect: (cfg) => Reflect.construct(SpawnGate as unknown as Ctor, [cfg]),
    'import-new': (cfg) => new (SpawnGate as unknown as Ctor)(cfg),
    extends: (cfg) => { const Evil = class extends (SpawnGate as unknown as Ctor) {}; return new Evil(cfg); },
  };
  const attempts: unknown[] = [];
  for (const [way, build] of Object.entries(ways)) {
    for (const [cname, c] of Object.entries(configs)) {
      for (const bname of ['dummy', 'recording']) {
        const calls: string[] = [];
        const backend = (exe: string) => { if (bname === 'recording') calls.push(exe); return fakeChild(); };
        const sys = c.systemRoot as { ok: boolean; path: string };
        const results: string[] = [];
        try {
          const g = build({ ...c, backend, record: () => {}, realpath: id, clock: ports.clock, env: {} });
          const whoami = await g.run({ exe: win.join(sys.path, 'System32', 'whoami.exe'), argv: WHOAMI_ARGV }, LIMITS);
          results.push('whoami:' + (whoami.ok ? 'ran' : whoami.reason));
          if (cname === 'csc-procguard') {
            const csc = await g.run({ exe: win.join(sys.path, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), argv: [...CSC_FLAGS, '/out:' + win.join(p.dir, 'runtime', 'procguard', hash, 'procguard.new.exe'), PROCGUARD_SOURCE] }, LIMITS);
            results.push('csc:' + (csc.ok ? 'ran' : csc.reason));
            g.start({ exe: pgExe, argv: [] }).kill();
            results.push('procguard:ran');
          }
        } catch (e) {
          results.push('threw ' + why(e));
        }
        attempts.push({ way, config: cname, backend: bname, results, backendCalls: calls.length });
      }
    }
  }
  // A subclass that overrides decide() does not steer run(): the gate decides privately.
  const steeredCalls: string[] = [];
  class Steered extends (SpawnGate as unknown as Ctor) { decide() { return { allow: true, rule: 'whoami', exe: 'C:\\\\orchestra-evil\\\\evil.exe', argv: [] }; } }
  const steered = new Steered({ ...configs['real-root'], backend: (exe: string) => { steeredCalls.push(exe); return fakeChild(); }, record: () => {}, realpath: id, clock: ports.clock, env: {} });
  const s = await steered.run({ exe: 'C:\\\\orchestra-evil\\\\evil.exe', argv: [] }, LIMITS);
  let started: string;
  try { steered.start({ exe: 'C:\\\\orchestra-evil\\\\evil.exe', argv: [] }); started = 'reached'; } catch (e) { started = why(e); }
  const tamper: Record<string, string> = {};
  try { (Object.getPrototypeOf(handed) as Record<string, unknown>).decide = () => ({ allow: true }); tamper.patchPrototype = 'reached'; } catch (e) { tamper.patchPrototype = why(e); }
  try { Object.setPrototypeOf(handed, {}); tamper.setPrototypeOf = 'reached'; } catch (e) { tamper.setPrototypeOf = why(e); }
  // Control: the handed gate (makeSpawnGate, as main.ts has it) runs the real whoami. An enumerable key
  // on Object.prototype must not reach its environment.
  Object.prototype['ORCHESTRA_POISON_ENV' as never] = 'from-prototype' as never;
  const sys = resolveSystemRoot(process.env, ports.realpath) as { path: string };
  const control = await handed.run({ exe: win.join(sys.path, 'System32', 'whoami.exe'), argv: WHOAMI_ARGV }, { timeoutMs: 10_000, maxBytes: 256 * 1024 });
  delete (Object.prototype as Record<string, unknown>).ORCHESTRA_POISON_ENV;
  return {
    attempts, steered: { result: s.ok ? 'ran' : s.reason, start: started, backendCalls: steeredCalls.length }, tamper,
    control: control.ok ? (/S-1-16-\\d+/.test(Buffer.from(control.stdout!).toString('latin1')) ? 'label' : 'no-label') : control.reason,
  };
}
`;

type SpawnAttempt = { way: string; config: string; backend: string; results: string[]; backendCalls: number };

test('A2 measured: through boot, SpawnGates rebuilt by .constructor, Reflect.construct, new or a subclass, with their own rules, backend and SystemRoot, start no process and create no file; the handed gate runs whoami', (t) => {
  const dir = canonicalTmp(t);
  fs.mkdirSync(path.join(dir, 'runtime', 'procguard', 'a'.repeat(64)), { recursive: true });
  const before = treeDigest(dir);
  const r = lastJson<{ spawns: { file: string; argv: string[]; protoNull: boolean; poisonInEnv: boolean }[]; result: { attempts: SpawnAttempt[]; steered: unknown; tamper: unknown; control: string } }>(
    runChild(t, { 'entry.ts': A2_ENTRY }, SPAWN_RUNNER, { dir }),
  );
  const a = r.result.attempts;
  assert.equal(a.length, 4 * 3 * 2, 'N = 4 ways x 3 configs x 2 backends');
  t.diagnostic(`A2 N = ${a.length}; recorded backend calls (all fake): ${a.reduce((n, x) => n + x.backendCalls, 0)}`);
  assert.ok(a.every((x) => !x.results.some((s) => s.startsWith('threw'))), JSON.stringify(a.filter((x) => x.results.some((s) => s.startsWith('threw')))));
  assert.ok(a.filter((x) => x.backend === 'recording').every((x) => x.backendCalls > 0), 'every recorded gate reached its own backend');
  assert.deepEqual(r.result.steered, { result: 'refused', start: 'ERR_ORCHESTRA_SPAWN', backendCalls: 0 });
  assert.deepEqual(r.result.tamper, { patchPrototype: 'TypeError', setPrototypeOf: 'TypeError' });
  assert.equal(treeDigest(dir), before, 'files created: 0');
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  // The one real process of the child is the control, through the handed gate.
  assert.equal(r.result.control, 'label');
  assert.deepEqual(r.spawns.map((s) => [s.file.toLowerCase(), s.argv]), [[path.join(sys.path, WHOAMI_REL).toLowerCase(), [...WHOAMI_ARGV]]]);
  assert.deepEqual(r.spawns.map((s) => [s.protoNull, s.poisonInEnv]), [[true, false]], 'options without a prototype, env from own entries');
});

test('ownEnv: an enumerable key on Object.prototype reaches a child through process.env, never through ownEnv (measured on a node child)', (t) => {
  const runner = [
    "import { spawnSync } from 'node:child_process';",
    `const { ownEnv } = await import(${JSON.stringify(src('runtime/own.ts'))});`,
    "Object.prototype.ORCHESTRA_POISON_ENV = 'from-prototype';",
    "const read = (env) => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.ORCHESTRA_POISON_ENV))'], { env, encoding: 'utf8', windowsHide: true }).stdout;",
    'const own = ownEnv(process.env);',
    'console.log(JSON.stringify({ plain: read(process.env), own: read(own), proto: Object.getPrototypeOf(own), frozen: Object.isFrozen(own), keeps: Object.keys(own).some((k) => k.toLowerCase() === \"systemroot\" && own[k] === process.env.SystemRoot) }));',
  ].join('\n');
  const r = lastJson<Record<string, unknown>>(runChild(t, {}, runner, {}));
  assert.deepEqual(r, { plain: 'from-prototype', own: 'undefined', proto: null, frozen: true, keeps: true });
  assert.deepEqual(Object.keys(ownEnv({ A: '1', B: undefined })), ['A']);
});

// ---------------------------------------------------------------------------------------------
// A3: option bags are read as own properties only.

const A3_ENTRY = `
import * as path from 'node:path';
import { start as mainStart } from ${JSON.stringify(src('main.ts'))};
import { ReadGate } from ${JSON.stringify(src('fs/read-gate.ts'))};
import { WriteFence } from ${JSON.stringify(src('fs/write-fence.ts'))};
import { SpawnGate, resolveSystemRoot } from ${JSON.stringify(src('os/spawn.ts'))};
import { checkDataDir } from ${JSON.stringify(src('runtime/data-dir.ts'))};
import { resolveEnv } from ${JSON.stringify(src('runtime/env.ts'))};
import { checkInTestRealProfile, parseProfileArgs } from ${JSON.stringify(src('runtime/test-profile.ts'))};
import { launcherRootFs } from ${JSON.stringify(src('fs/harness-roots.ts'))};
import { acquireLock } from ${JSON.stringify(src('runtime/lock.ts'))};
import { Log } from ${JSON.stringify(src('runtime/log.ts'))};
${DUMMY_IO}
const win = path.win32;
const why = (e: unknown) => (e as { code?: string }).code ?? (e as Error).message.slice(0, 60);
Error.stackTraceLimit = 64;
type P = { poison: boolean; srcUrl: string; testDir: string; userHome: string; realHome: string; realOrch: string; elsewhere: string; readRoot: string; env: Record<string, string> };

const hits: { key: string; fromSrc: boolean }[] = [];
const calls: string[] = [];
function poison(p: P, values: Record<string, unknown>): () => void {
  if (!p.poison) return () => {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(Object.prototype, key, {
      configurable: true, enumerable: false,
      get() { hits.push({ key, fromSrc: (new Error().stack ?? '').includes(p.srcUrl) }); return value; },
      set(v) { Object.defineProperty(this, key, { value: v, writable: true, configurable: true, enumerable: true }); },
    });
  }
  return () => { for (const key of Object.keys(values)) delete (Object.prototype as Record<string, unknown>)[key]; };
}
const rec = (name: string) => (..._a: unknown[]) => { calls.push(name); return undefined; };
const norm = (lines: string[]) => lines.map((l) => l.replace(/\\d{8}/g, 'N').replace(/pid \\d+/g, 'pid N'));

export async function start(f: unknown, fence: unknown, ports: Record<string, (s: unknown) => unknown> & { realpath(p: string): string; clock: { port(h: null): unknown } }): Promise<unknown> {
  const p = JSON.parse(process.argv[2]!) as P;
  const out: Record<string, unknown> = {};
  const recIo = Object.fromEntries(Object.keys(dummyIo()).map((k) => [k, rec('io.' + k)]));
  const unpoison = poison(p, {
    io: recIo, realpath: rec('realpath'), backend: rec('backend'), now: () => 0, clock: { port: rec('clock.port'), nowWall: () => 0 }, rules: ['whoami', 'csc', 'procguard'], record: rec('record'),
    testDir: p.elsewhere, testDirs: [p.elsewhere], versionFiles: [win.join(p.readRoot, 'sessions', '7.json')], milestone: 'M6', confine: p.elsewhere,
    csc: { outAllowed: () => true }, outAllowed: rec('outAllowed'), procguard: [{ at: 'build' }], at: 'build', homeReal: p.elsewhere, sourceHash: 'b'.repeat(64),
    inTestRealProfile: { fakeHome: p.realHome }, fakeHome: p.realHome, makeReadGate: rec('makeReadGate'), makeWriteFence: rec('makeWriteFence'), makeSpawnGate: rec('makeSpawnGate'),
    spawnBackend: rec('spawnBackend'), launcherGlobs: [win.join(p.elsewhere, '*')], extraHarnessRoots: [p.elsewhere], extraClaudeRoots: [p.elsewhere],
    env: { ORCHESTRA_HOME: p.elsewhere }, processEnv: {}, ORCHESTRA_HOME: p.elsewhere, CLAUDE_CONFIG_DIR: p.elsewhere, XDG_CONFIG_HOME: p.elsewhere, DSH_HOME: p.elsewhere,
    CODEX_HOME: p.elsewhere, NODE_TEST_CONTEXT: 'poisoned', port: 0, host: '127.0.0.1', sink: rec('sink'), capacity: 1, fsync: true, recursive: true,
    options: { cwd: win.join(p.elsewhere, 'poison') }, exe: win.join(p.elsewhere, 'evil.exe'), argv: ['/all'],
    // DatabaseSync reads each option it is not given through the prototype (step 3, node-sqlite.ts).
    open: false, readOnly: true, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true, allowExtension: true, timeout: 1,
    readBigInts: true, returnArrays: true, allowBareNamedParameters: true, allowUnknownNamedParameters: true, defensive: false,
    fence: { checkByName: rec('checkByName') }, openDb: rec('openDb'), writer: { append: rec('append'), shorten: rec('shorten') }, reader: { readFile: rec('readFile') },
    redactor: { redact: rec('redact') }, bootId: '00000000-0000-4000-8000-000000000000', tail: { jseq: 0, hash: 'x' }, file: win.join(p.elsewhere, 'j.jsonl'),
  });
  out.armed = (({}) as Record<string, unknown>).milestone ?? null;
  hits.length = 0;
  const con = () => { const lines: string[] = []; return { lines, port: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }; };
  const stopping = { onSignal: () => () => {}, end: (lock: { release(): Promise<void> }) => lock.release() };
  const tty = () => ({ stdin: false, stdout: false });

  // R1: main's real wiring, test profile, through the factories it was handed.
  const c1 = con();
  const o1 = await mainStart(f as never, fence as never, ports as never, { argv: ['--test-profile', '--test-dir', p.testDir], home: p.userHome, env: p.env, console: c1.port, stopping, tty } as never) as Record<string, unknown>;
  let held = 'n/a';
  if (o1.mode === 'working') {
    const second = await acquireLock(o1.pipe as string);
    held = second.ok ? 'acquired-twice' : second.reason;
    if (second.ok) await second.lock.release();
    await (o1.stop as () => Promise<void>)();
  }
  out.r1 = { mode: o1.mode, pipeIsPipe: String(o1.pipe).startsWith('\\\\\\\\.\\\\pipe\\\\'), held, lines: norm(c1.lines) };

  // R2: the real profile against a fake home (the typed in-test opt-in), ORCHESTRA_HOME inside the test dir.
  const c2 = con();
  const o2 = await mainStart(f as never, fence as never, ports as never, {
    argv: [], home: p.realHome, env: { ...p.env, ORCHESTRA_HOME: p.realOrch }, console: c2.port, stopping, tty, inTestRealProfile: { fakeHome: p.realHome },
  } as never) as Record<string, unknown>;
  if (o2.mode === 'working') await (o2.stop as () => Promise<void>)();
  out.r2 = { mode: o2.mode, lines: norm(c2.lines) };

  // R3: the real profile under the test runner without the opt-in is refused, whatever Object.prototype says.
  const c3 = con();
  const o3 = await mainStart(f as never, fence as never, ports as never, { argv: [], home: p.realHome, env: p.env, console: c3.port, stopping, tty } as never) as Record<string, unknown>;
  out.r3 = { mode: o3.mode, refusal: (o3.refusal as { reason?: string } | undefined)?.reason };

  // D: each gate, factory and input built straight from a plain object literal.
  const d: Record<string, unknown> = {};
  const attempt = (name: string, fn: () => unknown) => { try { d[name] = fn(); } catch (e) { d[name] = 'threw ' + why(e); } };
  const id = (x: string) => x;
  const root = { kind: 'claude', path: p.readRoot, real: p.readRoot };
  const sys = resolveSystemRoot(process.env, id);
  attempt('readGate', () => { const g = new ReadGate({ roots: [], io: dummyIo() } as never); const s = g.decide(win.join(p.readRoot, 'sessions', '7.json'), 'read'); return [g.milestone, g.testMode, s.allow]; });
  attempt('readGateFactory', () => { const g = ports.makeReadGate({ roots: [root] }) as ReadGate; return [g.milestone, g.testMode]; });
  attempt('writeFence', () => { const w = new WriteFence({ orchestraHome: win.join(p.testDir, 'd-orch'), harnessRoots: [], io: dummyIo() } as never); return w.home; });
  attempt('spawnNoBackend', () => new SpawnGate({ systemRoot: sys, rules: ['whoami'], record: () => {} } as never) && 'built');
  attempt('spawnSite', () => new SpawnGate({ systemRoot: sys, rules: ['procguard'], record: () => {}, backend: rec('b'), realpath: id, clock: ports.clock, procguard: [{}] } as never) && 'built');
  attempt('spawnCsc', () => new SpawnGate({ systemRoot: sys, rules: ['csc'], record: () => {}, backend: rec('b'), realpath: id, clock: ports.clock, procguard: [{ at: 'build' }], csc: {} } as never) && 'built');
  attempt('spawnFactory', () => ports.makeSpawnGate({ systemRoot: sys, rules: ['whoami'], record: () => {} }) && 'built');
  attempt('dataDir', () => { const c = checkDataDir({ orchestraHome: win.join(p.testDir, 'd-orch'), userHome: p.realHome, roots: [], realpath: ports.realpath } as never); return c.ok ? 'ok' : c.reason; });
  attempt('env', () => { const e = resolveEnv({ home: p.realHome, env: {} } as never); return [e.orchestraHome, e.claudeRootCandidates.length, e.typedHarnessRoots.length, e.dshHome, e.codexHome]; });
  attempt('profileNoOptIn', () => { const r = parseProfileArgs([], { env: {}, processEnv: { NODE_TEST_CONTEXT: 'x' }, realpath: ports.realpath, home: p.realHome } as never); return r.ok ? 'ok' : r.refusal.reason; });
  attempt('profileOptIn', () => { const r = parseProfileArgs([], { env: {}, processEnv: { ...p.env, NODE_TEST_CONTEXT: 'x' }, realpath: ports.realpath, home: p.realHome, inTestRealProfile: { fakeHome: p.realHome } } as never); return r.ok ? r.profile.kind : (r.refusal as { detail?: string }).detail ?? r.refusal.reason; });
  attempt('inTestNoRealpath', () => checkInTestRealProfile({ fakeHome: p.realHome }, { env: {}, processEnv: p.env, home: p.realHome } as never));
  attempt('inTestNoFakeHome', () => checkInTestRealProfile({} as never, { env: {}, processEnv: p.env, home: p.realHome, realpath: ports.realpath } as never));
  attempt('profileNoRunner', () => { const r = parseProfileArgs([], { env: {}, processEnv: {}, realpath: ports.realpath, home: p.realHome } as never); return r.ok ? r.profile.kind : r.refusal.reason; });
  attempt('log', () => { const l = new Log({ clock: ports.clock.port(null) } as never); l.info('one'); l.info('two'); return l.entries().length; });
  attempt('logNoClock', () => { const l = new Log({} as never); l.info('one'); return l.entries().length; });
  attempt('fenceOpts', () => {
    const log: string[] = [];
    const w = new WriteFence({ orchestraHome: win.join(p.testDir, 'd-orch'), harnessRoots: [], io: recordingIo(log) } as never);
    w.append(win.join(p.testDir, 'd-orch', 'a.log'), 'x');
    w.rm(win.join(p.testDir, 'd-orch', 'dir'));
    return log.filter((l) => /^(fsyncSync|readdirSync) /.test(l)).length;
  });
  attempt('launcher', () => launcherRootFs(resolveEnv({ home: p.realHome, env: {} } as never), { makeReadGate: ports.makeReadGate } as never) && 'built');
  // A port left out of BootPorts is missing, never one some module put on Object.prototype.
  const { makeSpawnGate: _left, ...without } = ports;
  try {
    await mainStart(f as never, fence as never, without as never, { argv: ['--test-profile', '--test-dir', p.testDir], home: p.userHome, env: p.env, console: con().port, stopping, tty } as never);
    d.portsMissing = 'started';
  } catch (e) {
    d.portsMissing = 'threw ' + why(e);
  }
  out.d = d;
  unpoison();
  out.srcHits = [...new Set(hits.filter((h) => h.fromSrc).map((h) => h.key))].sort();

  // S: node:fs reads a bag's missing fields through the prototype; node-io.ts's bags have every one.
  const s: Record<string, unknown> = {};
  const gate = ports.makeReadGate({ roots: [root] }) as ReadGate;
  const un1 = poison(p, { throwIfNoEntry: false });
  try { s.missing = gate.decide(win.join(p.readRoot, 'sessions', '8.json'), 'read'); } catch (e) { s.missing = 'threw ' + why(e); }
  un1();
  const un2 = poison(p, { recursive: true, encoding: 'buffer' });
  try { s.list = gate.readdir(win.join(p.readRoot, 'sessions')); s.dirs = gate.subdirs(win.join(p.readRoot, 'sessions')); } catch (e) { s.list = 'threw ' + why(e); }
  un2();
  out.s = s;
  out.calls = calls;
  return out;
}
`;

type A3 = {
  armed: unknown; srcHits: string[]; calls: string[];
  r1: { mode: string; pipeIsPipe: boolean; held: string; lines: string[] }; r2: { mode: string; lines: string[] }; r3: { mode: string; refusal: string };
  d: Record<string, unknown>; s: Record<string, unknown>;
};

function a3Run(t: TestContext, poisoned: boolean): { r: A3; testDir: string } {
  const testDir = canonicalTmp(t);
  const p = {
    poison: poisoned,
    srcUrl: SRC_URL,
    testDir,
    userHome: path.join(testDir, 'user-home'),
    realHome: path.join(testDir, 'home'),
    realOrch: path.join(testDir, 'real-orch'),
    elsewhere: path.join(testDir, 'elsewhere'),
    readRoot: path.join(testDir, 'read-root'),
    env: minimalEnv() as Record<string, string>,
  };
  fs.mkdirSync(p.realHome);
  fs.mkdirSync(p.elsewhere);
  put(path.join(p.readRoot, 'sessions', '7.json'), 'SECRET-7');
  put(path.join(p.readRoot, 'sessions', 'sub', '9.json'), 'nested');
  const c = runChild(t, { 'entry.ts': A3_ENTRY }, BOOT_RUNNER, p);
  // Each run has its own test dir: written as <T>, so the two runs compare.
  const r = lastJson<A3>({ ...c, stdout: c.stdout.split(JSON.stringify(testDir).slice(1, -1)).join('<T>') });
  return { r, testDir };
}

test('A3 measured: with every optional field name poisoned on Object.prototype, main\'s real wiring, each gate, factory and input behave exactly as without the poison, and src never reads one', (t) => {
  const clean = a3Run(t, false).r;
  const { r: poisoned, testDir } = a3Run(t, true);
  assert.equal(clean.armed, null);
  assert.equal(poisoned.armed, 'M6', 'control: the poison is live for an ordinary object');
  assert.deepEqual(poisoned.srcHits, [], 'no src module read a poisoned field');
  assert.deepEqual(poisoned.calls, [], 'no poisoned function was called');
  // What the wiring did, against what it does without the poison.
  assert.equal(clean.r1.mode, 'working', JSON.stringify(clean.r1));
  assert.equal(clean.r1.held, 'held');
  assert.equal(clean.r1.pipeIsPipe, true);
  assert.equal(clean.r2.mode, 'working', JSON.stringify(clean.r2));
  assert.deepEqual(clean.r3, { mode: 'refused', refusal: 'real-profile-under-test-runner' });
  for (const k of ['r1', 'r2', 'r3', 'd', 's'] as const) assert.deepEqual(poisoned[k], clean[k], k);
  // Messages are cut at 60 characters by the entry.
  assert.deepEqual(clean.d, {
    readGate: ['M0', false, false],
    readGateFactory: ['M0', false],
    writeFence: '<T>\\d-orch',
    spawnNoBackend: 'threw spawn gate: backend is required, there is no default',
    spawnSite: 'threw spawn gate: a procguard site is { at: "runtime", homeReal, s',
    spawnCsc: 'threw spawn gate: csc enabled without an /out: verdict and a procg',
    spawnFactory: 'threw spawn gate: realpath is required, there is no default',
    dataDir: 'ok',
    env: ['<T>\\home\\.orchestra', 3, 7, '<T>\\home\\.dsh', '<T>\\home\\.codex'],
    profileNoOptIn: 'real-profile-under-test-runner',
    profileOptIn: 'real',
    inTestNoRealpath: { reason: 'in-test-real-profile-refused', detail: 'unresolvable', path: 'no realpath' },
    inTestNoFakeHome: { reason: 'in-test-real-profile-refused', detail: 'unresolvable', path: 'undefined' },
    profileNoRunner: 'real',
    log: 2,
    logNoClock: 'threw log: clock is required, there is no default',
    fenceOpts: 0,
    launcher: 'threw launcherRootFs: makeReadGate and realpath are required',
    portsMissing: 'threw start: BootPorts.makeSpawnGate is missing',
  });
  assert.deepEqual(clean.s, { missing: { allow: false, op: 'read', path: '<T>\\read-root\\sessions\\8.json', reason: 'not-found' }, list: ['7.json', 'sub'], dirs: ['sub'] });
  assert.ok(!fs.existsSync(path.join(testDir, 'elsewhere', 'run')), 'nothing was made where the poison pointed');
});

// Finding R3-11: the builtin table's membership is a golden, next to MINTED_MODULES', so widening a
// row (node:timers to a second module, say) needs a deliberate edit here.
test('the builtin policy table is pinned: every row\'s modules, builtins, named-import limits and minting', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(BUILTIN_ROWS)), [
    { modules: ['src/fs/node-io.ts'], allow: ['node:fs'], minted: true },
    { modules: ['src/os/node-proc.ts'], allow: ['node:child_process'], minted: true },
    { modules: ['src/store/node-sqlite.ts'], allow: ['node:sqlite'], minted: true },
    { modules: ['src/runtime/lock.ts'], allow: ['node:net'], only: { 'node:net': ['createServer'] } },
    { modules: ['src/server/http.ts'], allow: ['node:http', 'node:net'], only: { 'node:http': ['createServer'], 'node:net': ['createServer'] } },
    { modules: ['src/runtime/workers.ts', 'src/workers/bootstrap.ts'], allow: ['node:worker_threads'] },
    { modules: ['src/runtime/import-fence.ts', 'src/runtime/features.ts'], allow: ['node:module'] },
    { modules: ['src/main.ts'], allow: ['node:os'], only: { 'node:os': ['homedir', 'totalmem'] } },
    { modules: ['src/runtime/clock.ts'], allow: ['node:timers', 'node:timers/promises'] },
    // The dispatch desk's one outbound POST to magpie (orchestra app plan §3).
    { modules: ['src/net/magpie.ts'], allow: ['node:http'], only: { 'node:http': ['request'] } },
    // seat's agent request port: node:net listens on one named pipe, node:http only parses (final.md §5.1).
    { modules: ['src/server/agent-port.ts'], allow: ['node:net', 'node:http'], only: { 'node:net': ['createServer'], 'node:http': ['createServer'] } },
  ]);
  assert.deepEqual([...DEFAULT_BUILTINS], ['node:path', 'node:url', 'node:events', 'node:util', 'node:crypto', 'node:zlib']);
  assert.deepEqual([...FORBIDDEN_BUILTINS], ['node:vm', 'node:wasi', 'node:inspector', 'node:repl', 'node:cluster']);
  assert.deepEqual([...NO_BUILTIN_DIRS], ['shared/']);
});

// Finding F2: the fence and the spawn gate decide from these tables on every call, so each is frozen
// through and through where it is defined; a module that imports one can change nothing it allows.
test('every policy table the fence and the spawn gate read is frozen at every level', () => {
  const unfrozen = (v: unknown, at: string): string[] => {
    if (typeof v !== 'object' || v === null) return [];
    const own = Object.isFrozen(v) ? [] : [at];
    return [...own, ...Object.getOwnPropertyNames(v).flatMap((k) => unfrozen((v as Record<string, unknown>)[k], `${at}.${k}`))];
  };
  const tables: Record<string, unknown> = { DEFAULT_BUILTINS, FORBIDDEN_BUILTINS, NO_BUILTIN_DIRS, BUILTIN_ROWS, MINTED_MODULES, WHOAMI_ARGV, CSC_FLAGS, TOAST_FLAGS, HANDLE_KEYS };
  for (const [name, table] of Object.entries(tables)) assert.deepEqual(unfrozen(table, name), [], name);
  assert.throws(() => { (BUILTIN_ROWS as BuiltinRow[]).push({ modules: ['src/model/x.ts'], allow: ['node:fs'] }); }, TypeError);
  assert.throws(() => { (BUILTIN_ROWS[8]!.modules as string[]).push('src/model/inbox.ts'); }, TypeError);
  assert.throws(() => { (DEFAULT_BUILTINS as string[]).push('node:child_process'); }, TypeError);
  assert.throws(() => { (WHOAMI_ARGV as string[])[0] = '/all'; }, TypeError);
  assert.equal(decideBuiltin('src/model/x.ts', 'node:fs').allow, false);
});

// ---------------------------------------------------------------------------------------------
// Finding N3: the F2 shape outside the two modules the walk above lists. Every export of src/ and
// shared/ is walked, so a new table cannot slip past a hand-kept list: an exported object, array or
// RegExp must be frozen at every level (a RegExp also with its own compile() stub, shared/frozen.js),
// an exported class must be frozen with its prototype, and no export may be an object whose contents
// live in internal slots (a URL, Map, Set or typed array), which Object.freeze cannot hold. The walk is
// test/helpers/frozen-walk.ts, run on each module in a child of its own.

function codeFiles(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) codeFiles(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

test('calibration: the export walk reports an open array, object, RegExp, class and a URL, and passes what shared/frozen.js froze', () => {
  class Open { m(): number { return 1; } }
  class Shut { m(): number { return 1; } }
  frozenClass(Shut);
  const bare = Object.freeze(/^a$/);
  const fake: Record<string, unknown> = {
    ARR: [1, 2], OBJ: Object.freeze({ inner: { x: 1 } }), RE: /^a$/, BARE: bare, URLV: new URL('file:///C:/x.ts'), Open, Shut, fn: () => 1,
    OK: frozen({ list: ['a'], re: /^b$/, deep: [{ re: /c/i }] }),
  };
  const found = Object.entries(fake).flatMap(([k, v]) => openPaths(v, k));
  assert.deepEqual(found, [
    'ARR', 'OBJ.inner', 'RE', 'RE (compile() not stubbed)', 'BARE (compile() not stubbed)',
    'URLV ([object URL]: contents Object.freeze cannot hold)', 'Open (class)', 'Open.prototype',
  ]);
  // What BARE shows: Object.freeze alone does not hold a RegExp. compile() throws on the frozen
  // lastIndex, but only after it has put the new pattern in place (measured on Node 24.22).
  assert.equal(bare.source, '^[\\s\\S]*$');
  assert.equal(bare.test('anything'), true);
  assert.throws(() => frozen(new Map()), TypeError);
  // The stub's descriptor has no prototype: with `get` on Object.prototype (a module's poison, read by
  // Object.defineProperty through the chain), frozen() still stubs compile.
  let poisoned: RegExp | undefined;
  Object.defineProperty(Object.prototype, 'get', { value: () => 1, configurable: true, writable: true });
  try {
    poisoned = frozen(/^p$/);
  } finally {
    delete (Object.prototype as Record<string, unknown>).get;
  }
  assert.deepEqual(openPaths(poisoned, 'poisoned'), []);
});

/**
 * Walks each module in a child of its own that loads only that module's graph: in one process a
 * module that deep-freezes another's export (routes.ts freezes the records.ts grammars its routes
 * use) would hide that the other module left it open whenever it is loaded without the first.
 */
async function walkEachModule(t: TestContext, files: readonly string[]): Promise<{ walked: string[]; open: string[]; failed: string[] }> {
  const dir = withModuleTmp(t);
  const walker = path.join(dir, 'walk.mjs');
  fs.writeFileSync(walker, [
    `import { walkModule } from ${JSON.stringify(pathToFileURL(path.join(REPO_DIR, 'test', 'helpers', 'frozen-walk.ts')).href)};`,
    'const [href, rel] = process.argv.slice(2);',
    'process.stdout.write(JSON.stringify(walkModule(await import(href), rel)));',
  ].join('\n'));
  const one = (f: string) => new Promise<{ rel: string; status: number | null; out: string; err: string }>((resolve) => {
    const rel = path.relative(REPO_DIR, f).split(path.sep).join('/');
    const child = spawn(process.execPath, [walker, pathToFileURL(f).href, rel], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ rel, status, out, err });
    });
  });
  const walked: string[] = [];
  const open: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < files.length; i += 8) {
    for (const r of await Promise.all(files.slice(i, i + 8).map(one))) {
      if (r.status !== 0) {
        failed.push(`${r.rel}: exit ${r.status} ${r.err.slice(0, 300)}`);
        continue;
      }
      const w = JSON.parse(r.out) as { walked: string[]; open: string[] };
      walked.push(...w.walked);
      open.push(...w.open);
    }
  }
  return { walked, open, failed };
}

test('every exported object, array, RegExp and class of src/ and shared/ is frozen at every level, its RegExps with a compile() stub; the list is generated from the files', async (t) => {
  const files = [...codeFiles(path.join(REPO_DIR, 'src'), '.ts'), ...codeFiles(path.join(REPO_DIR, 'shared'), '.js')];
  const { walked, open, failed } = await walkEachModule(t, files);
  assert.deepEqual(failed, []);
  assert.deepEqual(open, []);
  // Not vacuous: the tables the finding named are among the walked exports.
  for (const w of [
    'src/fs/read-gate.ts:DENY_RULES', 'src/fs/read-gate.ts:ALLOW_RULES', 'src/fs/read-gate.ts:LISTABLE', 'src/store/redact.ts:FORMAT_RULES',
    'src/store/redact.ts:SYSTEM_VARIABLES', 'src/runtime/exit.ts:EXIT', 'src/runtime/env.ts:DEFAULT_LAUNCHER_GLOBS', 'src/runtime/integrity.ts:WHOAMI_LIMITS',
    'src/runtime/clock.ts:TIMER_CLASSES', 'src/server/routes.ts:CSRF_RE', 'src/server/routes.ts:DSH_LINK_RE', 'src/store/records.ts:BODY_SCHEMAS',
    'shared/protocol.js:ID_RE', 'shared/protocol.js:TOOL_NAME_RE', 'src/runtime/process-powers.ts:PROCESS_POWERS', 'src/runtime/test-profile.ts:TestRoots',
  ]) assert.ok(walked.includes(w), `not walked: ${w}`);
  assert.ok(!walked.some((w) => w.startsWith('src/runtime/workers.ts:BOOTSTRAP')), 'workers.ts exports the bootstrap as a string only');
});

test('PoC: a module that imports the read gate\'s, the redactor\'s or the exit tables can no longer empty or widen them', async (t) => {
  const root = canonicalTmp(t);
  put(path.join(root, '.credentials.json'), '{"secret":"x"}');
  const gate = makeReadGate({ roots: [{ kind: 'claude', path: root, real: root }] });
  const credentials = path.join(root, '.credentials.json');
  const before = gate.decide(credentials, 'read');
  assert.equal(before.allow, false);
  assert.throws(() => { (DENY_RULES as { length: number }).length = 0; }, TypeError);
  assert.throws(() => { (ALLOW_RULES.claude as AllowRule[]).push({ id: 'x', re: /^.*$/, since: 'M0' }); }, TypeError);
  assert.throws(() => { (DENY_RULES[2]! as { re: RegExp }).re = /^$/; }, TypeError);
  assert.throws(() => { (LISTABLE as Record<string, string | null>).extra = 'M0'; }, TypeError);
  assert.deepEqual(gate.decide(credentials, 'read'), before);
  assert.throws(() => gate.readFile(credentials));

  const redactor = makeRedactor({ env: {} });
  const text = 'Authorization: hunter2pass and ghp_0123456789abcdefghijABCDEFGHIJ';
  const want = redactor.redact({ text }).text;
  assert.equal(want, 'Authorization: [redacted:authorization]');
  assert.throws(() => { (FORMAT_RULES as { length: number }).length = 0; }, TypeError);
  assert.throws(() => { (SYSTEM_VARIABLES as string[]).push('GITHUB_TOKEN'); }, TypeError);
  assert.throws(() => { (FORMAT_RULES[6]!.re as unknown as { lastIndex: number }).lastIndex = 5; }, TypeError);
  assert.equal(redactor.redact({ text }).text, want);

  assert.throws(() => { (EXIT as Record<string, number>).badArgs = 0; }, TypeError);
  const dir = withTmp(t);
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(fakeSpawn()), { argv: ['--verbose'], home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port });
  assert.deepEqual([o.mode, (o as { code?: number }).code], ['refused', EXIT.badArgs]);
  assert.equal(EXIT.badArgs, 24);

  // compile() on an exported grammar meets its own stub and changes nothing; RegExp.prototype's
  // compile by its full name is the static scan's to catch (ban:RegExp-compile).
  for (const [name, re, bad] of [['CSRF_RE', CSRF_RE, 'not-a-token'], ['ID_RE', ID_RE, 'free text, with spaces'], ['TOOL_NAME_RE', TOOL_NAME_RE, 'rm -rf /']] as const) {
    assert.equal(re.test(bad), false, name);
    assert.throws(() => (re as unknown as { compile(p: string): unknown }).compile('^.*$'), TypeError, name);
    assert.equal(re.test(bad), false, `${name} after compile()`);
  }
});
