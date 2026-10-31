import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { Power } from '../../src/runtime/process-powers.ts';
import type { Features } from '../../src/runtime/features.ts';
import { EXIT } from '../../src/runtime/exit.ts';
import { BASE_LOCKS, GLOBAL_POWERS, PLAIN_GLOBALS, POWERS_NODE, PROCESS_POWERS, isFenced, keepsOwnValue, powerLabel } from '../../src/runtime/process-powers.ts';
import { describeNote, startupNotes } from '../../src/runtime/startup.ts';
import { put, withModuleTmp, withTmp } from '../helpers/tmp.ts';

// Step 2c, process-powers table (zen note 7.1 P8 and 7.3): every own key of process and globalThis
// is in the table, the fence applies it, and the key-set golden catches any key the table does not
// list. Every measure runs in a child through boot() (or runEntry) and the real fence; each control
// runs the same entry through runEntry with a fence that installs nothing, and the attack lands.

const SRC_URL = new URL('../../src/', import.meta.url).href;
const src = (rel: string) => `${SRC_URL}${rel}`;

type Child = { status: number | null; signal: string | null; stdout: string; stderr: string; dir: string };

type ChildOpts = { fenced?: boolean; recordPins?: boolean; arg?: unknown; execArgv?: (dir: string) => string[]; timeoutMs?: number };

/**
 * Writes `files` and a runner into a fresh orchestra-test-* dir and returns the arguments that run it
 * there, with `arg` (JSON) and the dir as its own two. With `recordPins` the runner keeps the values of
 * the slots the fence pins in a global (which the key-set golden would flag), then it calls runEntry (boot.ts's own entry path: crash handler, typed exit codes)
 * with the real fence, or with one that installs nothing (`fenced` false).
 */
function prepareChild(t: TestContext, files: Record<string, string>, opts: ChildOpts): { dir: string; args: string[] } {
  const dir = withModuleTmp(t);
  for (const [name, text] of Object.entries(files)) put(path.join(dir, name), text);
  const fenced = opts.fenced ?? true;
  fs.writeFileSync(path.join(dir, 'runner.mjs'), [
    `import { runEntry } from ${JSON.stringify(src('boot.ts'))};`,
    `import { detectFeatures } from ${JSON.stringify(src('runtime/features.ts'))};`,
    ...(opts.recordPins === true ? ['globalThis.orchestraBefore = { exit: process.exit, reallyExit: process.reallyExit, _fatalException: process._fatalException };'] : []),
    fenced
      ? "await runEntry(new URL('./entry.ts', import.meta.url));"
      : "await runEntry(new URL('./entry.ts', import.meta.url), { detectFeatures, installImportFence: () => ({ resolveHook: true, locks: 0 }) });",
  ].join('\n'));
  return { dir, args: [...(opts.execArgv?.(dir) ?? []), path.join(dir, 'runner.mjs'), JSON.stringify(opts.arg ?? {}), dir] };
}

/** Runs the child in its dir to the end; one that outlives `timeoutMs` is stopped through its own handle. */
function runChild(t: TestContext, files: Record<string, string>, opts: ChildOpts = {}): Child {
  const { dir, args } = prepareChild(t, files, opts);
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000, windowsHide: true });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, dir };
}

/** The same without blocking, so that several children run at once. */
function runChildAsync(t: TestContext, files: Record<string, string>, opts: ChildOpts = {}): Promise<Child> {
  const { dir, args } = prepareChild(t, files, opts);
  const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60_000);
  return new Promise((resolve) => {
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, dir });
    });
  });
}

function lastJson<T>(c: Child): T {
  assert.equal(c.status, 0, c.stderr);
  const line = c.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  return JSON.parse(line) as T;
}

// ---------------------------------------------------------------------------------------------
// The table itself.

test('the table lists each key once, every lock and mint entry has a stub, and only keep entries are pinned', () => {
  for (const [name, table, plain] of [['process', PROCESS_POWERS, []], ['global', GLOBAL_POWERS, PLAIN_GLOBALS]] as const) {
    const keys = [...table.map((e) => e.key), ...plain];
    assert.equal(new Set(keys).size, keys.length, `${name}: a key is listed twice`);
    for (const e of table) {
      assert.ok(e.why.length > 0, `${name} ${e.key}: no reason`);
      if (e.class !== 'keep') assert.ok(typeof e.stub === 'string', `${name} ${e.key}: no stub`);
    }
  }
  // Finding N1: exit and reallyExit were pinned keep entries. Nothing in orchestrad calls them since
  // boot.ts ends through the reallyExit it takes (makeEndProcess), so the fence now locks exit and
  // mints reallyExit to boot.ts; only _fatalException stays pinned (the crash path runs through it).
  const pinned = PROCESS_POWERS.filter((e) => e.class === 'keep' && e.pin === true).map((e) => e.key);
  assert.deepEqual(pinned, ['_fatalException']);
  // A worker pin is a lock or mint entry a worker's install pins instead: there it ends the thread only.
  assert.deepEqual([...PROCESS_POWERS, ...GLOBAL_POWERS].filter((e) => e.class !== 'keep' && e.worker === 'pin').map((e) => e.key), ['exit', 'reallyExit']);
  for (const e of [...PROCESS_POWERS, ...GLOBAL_POWERS]) {
    assert.equal(keepsOwnValue(e, 'main'), e.class === 'keep' && e.pin === true, `${e.key} on the main thread`);
    assert.equal(keepsOwnValue(e, 'worker'), e.class === 'keep' ? e.pin === true : e.worker === 'pin', `${e.key} on a worker`);
  }
  assert.equal(BASE_LOCKS, [...PROCESS_POWERS, ...GLOBAL_POWERS].filter((e) => isFenced(e) && e.optional === undefined).length);
  assert.equal(powerLabel(Symbol.for('undici.globalOrigin.1')), 'Symbol(undici.globalOrigin.1)');
  assert.equal(powerLabel('kill'), 'kill');
});

/** The lock list the brief requires at least, plus the locks the step-2c measurements added. */
const MUST_LOCK = [
  '_debugProcess', '_debugEnd', '_getActiveHandles', '_getActiveRequests', 'kill', '_kill', 'execve', 'abort', 'chdir',
  'binding', '_linkedBinding', 'dlopen', 'loadEnvFile', 'report', 'getBuiltinModule', 'umask',
];
/**
 * Step 3b, finding F1: setUncaughtExceptionCaptureCallback was a lock entry; boot.ts now mints it and
 * makes its crash handler the capture callback before the fence. Once the fence is in, its slot holds the
 * same dead stub a lock's does, so the child below judges it with the locks.
 */
const MINTED_DEAD = ['setUncaughtExceptionCaptureCallback'];

test('the table locks at least the required process keys and exit, mints reallyExit and the capture callback setter to boot.ts alone, pins _fatalException, and mints only fetch among the globals', () => {
  const cls = (key: string) => PROCESS_POWERS.find((e) => e.key === key)?.class;
  for (const key of MUST_LOCK) assert.equal(cls(key), 'lock', key);
  assert.equal(cls('exit'), 'lock');
  assert.equal(cls('_fatalException'), 'keep');
  assert.deepEqual(PROCESS_POWERS.filter((e) => e.class === 'mint').map((e) => (e.class === 'mint' ? [e.key, e.mintedBy, [...e.heldBy]] : [])), [
    ['setUncaughtExceptionCaptureCallback', 'src/boot.ts', []],
    ['reallyExit', 'src/boot.ts', []],
  ]);
  assert.deepEqual(GLOBAL_POWERS.filter((e) => e.class === 'mint').map((e) => e.key), ['fetch']);
  assert.deepEqual(GLOBAL_POWERS.filter((e) => e.class === 'lock' && e.optional === undefined).map((e) => e.key).sort(),
    ['EventSource', 'Symbol(undici.globalDispatcher.1)', 'Symbol(undici.globalDispatcher.2)', 'Symbol(undici.globalOrigin.1)', 'WebSocket']);
});

// ---------------------------------------------------------------------------------------------
// The key-set golden.

type Snapshot = { process: [string, string][]; global: [string, string][] };

/** Every way a snapshot and the table disagree: a key the table lacks, a non-optional key missing, a shape that changed. */
function reconcile(s: Snapshot): string[] {
  const problems: string[] = [];
  const check = (target: string, got: [string, string][], table: readonly Power[], plain: readonly string[]) => {
    const listed = new Map(table.map((e) => [e.key, e]));
    const seen = new Set<string>();
    for (const [key, shape] of got) {
      seen.add(key);
      const e = listed.get(key);
      if (e !== undefined) {
        if (e.shape !== shape) problems.push(`${target} ${key}: shape ${shape}, the table says ${e.shape}`);
      } else if (!plain.includes(key)) {
        problems.push(`${target} ${key}: not in the table`);
      }
    }
    for (const e of table) if (e.optional === undefined && !seen.has(e.key)) problems.push(`${target} ${e.key}: missing`);
    for (const key of plain) if (!seen.has(key)) problems.push(`${target} ${key}: missing`);
  };
  check('process', s.process, PROCESS_POWERS, []);
  check('global', s.global, GLOBAL_POWERS, PLAIN_GLOBALS);
  return problems.sort();
}

// The entry snapshots right after boot() put the fence in (main.ts not yet loaded), then starts main.ts
// in the test profile and snapshots again once the working graph (write fence, lock, crypto) is loaded.
const GOLDEN_ENTRY = `
const shape = (o: object, k: PropertyKey): string => {
  const d = Object.getOwnPropertyDescriptor(o, k)!;
  if (!('value' in d)) return 'accessor';
  return d.value === null ? 'null' : typeof d.value;
};
const label = (k: PropertyKey) => (typeof k === 'symbol' ? 'Symbol(' + (k.description ?? '') + ')' : String(k));
const snap = () => ({
  process: Reflect.ownKeys(process).map((k) => [label(k), shape(process, k)]),
  global: Reflect.ownKeys(globalThis).map((k) => [label(k), shape(globalThis, k)]),
});
export async function start(f: unknown, fence: unknown, ports: unknown): Promise<unknown> {
  const p = JSON.parse(process.argv[2]!) as { mutate: boolean };
  const dir = process.argv[3]!;
  if (p.mutate) {
    (globalThis as Record<string, unknown>).orchestraInjected = 1;
    (process as unknown as Record<string, unknown>).orchestraInjected = 1;
    delete (globalThis as Record<string, unknown>).escape;
    (process as unknown as Record<string, unknown>)._maxListeners = 'x';
  }
  const fenced = snap();
  const main = await import(${JSON.stringify(src('main.ts'))});
  const lines: string[] = [];
  const o = await main.start(f, fence, ports, {
    argv: ['--test-profile', '--test-dir', dir], home: dir + String.fromCharCode(92) + 'user-home',
    env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP },
    console: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
    stopping: { onSignal: () => () => {}, end: (lock: { release(): Promise<void> }) => lock.release() },
    tty: () => ({ stdin: false, stdout: false }),
  });
  const working = snap();
  if (o.mode === 'working') await o.stop();
  console.log(JSON.stringify({ fence, mode: o.mode, lines, fenced, working, version: process.versions.node }));
  return {};
}
`;

type Golden = { fence: unknown; mode: string; lines: string[]; fenced: Snapshot; working: Snapshot; version: string };

test('key-set golden: after the fence and after the working graph loaded, every own key of process and globalThis is the table\'s, with its shape', (t) => {
  const g = lastJson<Golden>(runChild(t, { 'entry.ts': GOLDEN_ENTRY }, { arg: { mutate: false } }));
  assert.equal(g.version, POWERS_NODE, `the golden was taken on ${POWERS_NODE}; classify the delta of this Node in process-powers.ts`);
  assert.deepEqual(g.fence, { resolveHook: true, locks: BASE_LOCKS });
  assert.equal(g.mode, 'working', g.lines.join('\n'));
  assert.deepEqual(reconcile(g.fenced), []);
  assert.deepEqual(reconcile(g.working), []);
  assert.ok(g.fenced.global.some(([k]) => k === 'Symbol(undici.globalDispatcher.1)'), 'the lazy undici slots are in the first snapshot already');
});

test('key-set golden, mutation run: an injected global and process key, a deleted global and a changed shape all turn it red', (t) => {
  const g = lastJson<Golden>(runChild(t, { 'entry.ts': GOLDEN_ENTRY }, { arg: { mutate: true } }));
  const want = [
    'global escape: missing',
    'global orchestraInjected: not in the table',
    'process _maxListeners: shape string, the table says undefined',
    'process orchestraInjected: not in the table',
  ];
  assert.deepEqual(reconcile(g.fenced), want);
  assert.deepEqual(reconcile(g.working), want);
});

// ---------------------------------------------------------------------------------------------
// The locks and pins, one child through boot.

const LOCKS_ENTRY = `
const MUST_LOCK = ${JSON.stringify([...MUST_LOCK, ...MINTED_DEAD])};
const GLOBALS = ['fetch', 'WebSocket', 'EventSource'];
const PINNED = ['_fatalException'];
const EXITS = ['exit', 'reallyExit'];
type Fn = (...a: unknown[]) => unknown;
const why = (e: unknown) => (e as { reason?: string }).reason ?? (e as { code?: string }).code ?? (e as Error).name;
// Calls that are safe even when a lock is missing (a mutation run); abort and _debugProcess are never called.
const CALLS: Record<string, unknown[]> = {
  binding: ['fs'], _linkedBinding: ['x'], dlopen: [{ exports: {} }, 'C:\\\\orchestra-nope.node'], loadEnvFile: ['C:\\\\orchestra-nope.env'],
  kill: [process.pid, 0], _kill: [process.pid, 0], execve: [process.execPath, [process.execPath, '-e', '0']], chdir: [process.argv[3]],
  umask: [0o022], setUncaughtExceptionCaptureCallback: [() => {}], _debugEnd: [], _getActiveHandles: [], _getActiveRequests: [], getBuiltinModule: ['node:fs'],
};
function judge(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const d = Object.getOwnPropertyDescriptor(target, key);
  const v = d?.value as unknown;
  const out: Record<string, unknown> = { ro: d !== undefined && d.writable === false && d.configurable === false };
  out.stub = typeof v === 'function' ? (v as Fn).name : typeof v === 'object' && v !== null ? (Object.isFrozen(v) ? 'frozen' : 'open') : typeof v;
  if (key in CALLS) {
    try { (v as Fn).apply(target, CALLS[key]!); out.call = 'reached'; } catch (e) { out.call = why(e); }
  }
  try { target[key] = () => 'mine'; out.assign = 'reached'; } catch (e) { out.assign = why(e); }
  return out;
}
export async function start(_f: unknown, fence: unknown): Promise<unknown> {
  const p = process as unknown as Record<string, unknown>;
  const before = (globalThis as unknown as { orchestraBefore: Record<string, unknown> }).orchestraBefore;
  const out: Record<string, unknown> = { fence };
  for (const k of MUST_LOCK) out[k] = judge(p, k);
  const report = p.report as Record<string, Fn>;
  try { report.writeReport!(); out.writeReport = 'reached'; } catch (e) { out.writeReport = why(e); }
  for (const k of GLOBALS) out[k] = judge(globalThis as unknown as Record<string, unknown>, k);
  for (const k of PINNED) {
    const d = Object.getOwnPropertyDescriptor(p, k)!;
    out[k] = { ro: d.writable === false && d.configurable === false, same: d.value === before[k] };
  }
  // Never called: in a mutation run without the lock the call would end this child.
  for (const k of EXITS) out[k] = { ...judge(p, k), same: p[k] === before[k] };
  console.log(JSON.stringify(out));
  return {};
}
`;

test('boot(): every required process key, exit and reallyExit are locked to their stubs and cannot be put back; _fatalException keeps Node\'s own function, frozen', (t) => {
  const r = lastJson<Record<string, unknown>>(runChild(t, { 'entry.ts': LOCKS_ENTRY }, { recordPins: true }));
  const dead = (call?: string) => ({ ro: true, stub: 'disabledByFence', ...(call !== undefined ? { call } : {}), assign: 'TypeError' });
  const want: Record<string, unknown> = { fence: { resolveHook: true, locks: BASE_LOCKS } };
  for (const k of [...MUST_LOCK, ...MINTED_DEAD]) want[k] = dead('disabled');
  want.abort = dead();
  want._debugProcess = dead();
  want.getBuiltinModule = { ro: true, stub: '', call: 'getter', assign: 'TypeError' };
  want.report = { ro: true, stub: 'frozen', assign: 'TypeError' };
  want.writeReport = 'disabled';
  for (const k of ['fetch', 'WebSocket', 'EventSource']) want[k] = dead();
  want._fatalException = { ro: true, same: true };
  for (const k of ['exit', 'reallyExit']) want[k] = { ...dead(), same: false };
  assert.deepEqual(r, want);
});

// ---------------------------------------------------------------------------------------------
// What the pins and the new locks stop: a module that keeps a crashed process alive, or makes the
// write fence's files read-only. The crash comes from a timer, after the module ran.

const CRASH_ENTRY = `
const why = (e: unknown) => (e as { reason?: string }).reason ?? (e as Error).name;
export async function start(): Promise<unknown> {
  const kind = (JSON.parse(process.argv[2]!) as { kind: string }).kind;
  const p = process as unknown as Record<string, unknown>;
  let attempt = 'none';
  try {
    if (kind === 'exit') p.exit = () => {};
    if (kind === 'reallyExit') p.reallyExit = () => {};
    if (kind === 'fatalException') p._fatalException = () => true;
    // runEntry set boot's capture callback before the fence, and Node takes one at a time: clear it first.
    if (kind === 'capture') { const set = p.setUncaughtExceptionCaptureCallback as (f: (() => void) | null) => void; set(null); set(() => {}); }
    attempt = 'reached';
  } catch (e) { attempt = why(e); }
  process.stdout.write('ATTEMPT ' + attempt + '\\n');
  setTimeout(() => { throw new Error('late boom'); }, 20);
  setInterval(() => {}, 1000);
  return { mode: 'working' };
}
`;

// The third field: does the control (no fence) stay alive? Since boot.ts ends the process through the
// reallyExit it took before any entry module ran (makeEndProcess, finding F1), a replaced process.exit
// or process.reallyExit no longer keeps even an unfenced crash alive; the fence locks both (finding N1).
// A replaced _fatalException or a capture callback still swallow the crash before it reaches boot.
const CRASH_KINDS = [['exit', 'TypeError', false], ['reallyExit', 'TypeError', false], ['fatalException', 'TypeError', true], ['capture', 'disabled', true]] as const;

test('PoC boot(): a module that replaces process.exit, reallyExit or _fatalException, or sets a capture callback, cannot keep a crashed process alive; without the fence the last two do, and boot\'s own end outlives the first two', async (t) => {
  const crashLines = (s: string) => s.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: crashed'));
  // A control still running 2.5 s after its 20 ms crash was kept alive; it is then stopped through its handle.
  const [fenced, control] = await Promise.all([
    Promise.all(CRASH_KINDS.map(([kind]) => runChildAsync(t, { 'entry.ts': CRASH_ENTRY }, { arg: { kind } }))),
    Promise.all(CRASH_KINDS.map(([kind]) => runChildAsync(t, { 'entry.ts': CRASH_ENTRY }, { arg: { kind }, fenced: false, timeoutMs: 2500 }))),
  ]);
  for (const [i, [kind, attempt, controlAlive]] of CRASH_KINDS.entries()) {
    const f = fenced[i]!;
    assert.match(f.stdout, new RegExp(`^ATTEMPT ${attempt}$`, 'm'), kind);
    assert.equal(f.status, EXIT.crashed, `${kind}: ${f.stderr}`);
    assert.deepEqual(crashLines(f.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): Error: late boom`], kind);
    const c = control[i]!;
    assert.match(c.stdout, /^ATTEMPT reached$/m, kind);
    if (controlAlive) assert.notEqual(c.status, EXIT.crashed, `${kind}: without the fence the crash never reaches its typed exit`);
    else assert.equal(c.status, EXIT.crashed, `${kind}: boot ends through the reallyExit it took first, fence or not: ${c.stderr}`);
  }
  t.diagnostic(`controls ended with: ${control.map((c, i) => `${CRASH_KINDS[i]![0]} ${c.status ?? c.signal}`).join(', ')}`);
});

test('PoC boot(): process.umask and process.chdir are dead; without the fence a 0o222 mask makes new files read-only and chdir moves the process', (t) => {
  const entry = `
import * as path from 'node:path';
const why = (e: unknown) => (e as { reason?: string }).reason ?? (e as Error).name;
export async function start(): Promise<unknown> {
  const dir = process.argv[3]!;
  const out: Record<string, unknown> = { cwdBefore: process.cwd() };
  try { (process.umask as (m: number) => number)(0o222); out.umask = 'reached'; } catch (e) { out.umask = why(e); }
  try { process.chdir(path.join(dir, 'elsewhere')); out.chdir = 'reached'; } catch (e) { out.chdir = why(e); }
  out.moved = process.cwd() !== out.cwdBefore;
  delete out.cwdBefore;
  console.log(JSON.stringify(out));
  return {};
}
`;
  const files = { 'entry.ts': entry, 'elsewhere/keep.txt': 'x' };
  assert.deepEqual(lastJson(runChild(t, files)), { umask: 'disabled', chdir: 'disabled', moved: false });
  assert.deepEqual(lastJson(runChild(t, files, { fenced: false })), { umask: 'reached', chdir: 'reached', moved: true });
  // What the mask does (measured once here, in this process, then put back): files created under it are read-only.
  const dir = withTmp(t);
  const old = process.umask(0o222);
  try {
    fs.writeFileSync(path.join(dir, 'masked.txt'), 'x');
  } finally {
    process.umask(old);
  }
  assert.equal(fs.statSync(path.join(dir, 'masked.txt')).mode & 0o222, 0, 'created read-only');
  fs.chmodSync(path.join(dir, 'masked.txt'), 0o666);
});

test('PoC boot(): with web storage switched on, localStorage and sessionStorage are locked and write no file; without the fence they write the --localstorage-file', (t) => {
  const entry = `
const why = (e: unknown) => (e as { reason?: string }).reason ?? (e as Error).name;
export async function start(_f: unknown, fence: unknown): Promise<unknown> {
  const g = globalThis as unknown as Record<string, { setItem(k: string, v: string): void }>;
  const out: Record<string, unknown> = { fence, storage: typeof g.Storage };
  for (const k of ['localStorage', 'sessionStorage']) {
    try { g[k]!.setItem('k', 'v'); out[k] = 'reached'; } catch (e) { out[k] = why(e); }
  }
  console.log(JSON.stringify(out));
  return {};
}
`;
  const run = (fenced: boolean) => {
    const c = runChild(t, { 'entry.ts': entry }, { fenced, execArgv: (dir) => ['--experimental-webstorage', `--localstorage-file=${path.join(dir, 'ls.db')}`] });
    return { out: lastJson<Record<string, unknown>>(c), db: fs.existsSync(path.join(c.dir, 'ls.db')) };
  };
  const fenced = run(true);
  assert.deepEqual(fenced, { out: { fence: { resolveHook: true, locks: BASE_LOCKS + 2 }, storage: 'function', localStorage: 'TypeError', sessionStorage: 'TypeError' }, db: false });
  const control = run(false);
  assert.deepEqual(control.out, { fence: { resolveHook: true, locks: 0 }, storage: 'function', localStorage: 'reached', sessionStorage: 'reached' });
  assert.equal(control.db, true, 'without the fence the storage file is written');
});

// ---------------------------------------------------------------------------------------------
// The version note.

const FULL: Features = { node: POWERS_NODE, nodeAtLeastMin: true, zstd: true, registerHooks: true, sqlite: true, typeStripping: true };

test('a Node other than the table\'s adds one note and changes nothing else; the pinned one adds none', () => {
  assert.deepEqual(startupNotes(FULL), []);
  const other = startupNotes({ ...FULL, node: '24.23.0' });
  assert.deepEqual(other, [{ id: 'node-not-pinned', effect: 'powers-unverified', node: '24.23.0', pinned: POWERS_NODE }]);
  assert.equal(describeNote(other[0]!), `node 24.23.0 is not ${POWERS_NODE}, the Node the process-powers table was taken on: its key set is unverified here`);
});
