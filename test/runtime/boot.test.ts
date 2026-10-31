import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { EXIT_FLUSH_MS, crashLine, exitCodeOf } from '../../src/boot.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { BOOT, isBoot, runOrchestrad, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { findImports, scan } from '../helpers/scan-rules.ts';
import { withModuleTmp, withTmp } from '../helpers/tmp.ts';

// boot.ts is only ever run here with --test-profile or with arguments it must refuse: the real
// profile would read the real harness roots and create ~/.orchestra.

test('boot.ts in the test profile reaches working, prints the banner and the pairing code, and records whoami', async (t) => {
  const dir = withTmp(t);
  const child = startOrchestrad(t, ['--test-profile', '--test-dir', dir]);
  await waitForLine(child, /^orchestrad: working \(test profile, pid \d+, data .+\)$/);
  const out = child.lines();
  assert.equal(out[0], 'TEST PROFILE');
  assert.equal(out.filter((l) => /^orchestrad: pairing code \d{8}$/.test(l)).length, 1);
  const home = path.join(fs.realpathSync.native(dir), 'orchestra');
  for (const sub of ['run', 'tmp', 'runtime']) assert.ok(fs.statSync(path.join(home, sub)).isDirectory(), sub);
  const pids = fs.readFileSync(path.join(home, 'run', 'pids.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { rule: string; pid: number });
  assert.deepEqual(pids.map((p) => p.rule), ['whoami']);
  assert.ok(Number.isSafeInteger(pids[0]!.pid) && pids[0]!.pid > 0);
  const daemon = JSON.parse(fs.readFileSync(path.join(home, 'run', 'daemon.json'), 'utf8')) as { pid: number; profile: string };
  assert.equal(daemon.pid, child.pid);
  assert.equal(daemon.profile, 'test');
  const log = fs.readFileSync(path.join(home, 'run', 'orchestrad.log'), 'utf8');
  const code = out.find((l) => l.startsWith('orchestrad: pairing code '))!.slice(-8);
  assert.ok(!log.includes(code), 'the pairing code reached the log');
  await child.stop();
});

test('the helpers never start boot.ts without arguments, however the script is spelled', (t) => {
  const dir = withTmp(t);
  assert.equal(isBoot(BOOT), true);
  assert.equal(isBoot(BOOT.toUpperCase()), true);
  assert.equal(isBoot(path.join(path.dirname(BOOT), 'runtime', '..', 'boot.ts')), true);
  assert.equal(isBoot(path.join(dir, 'boot.ts')), false);
  assert.equal(isBoot(path.join(path.dirname(BOOT), 'main.ts')), false);
  for (const script of [undefined, BOOT, BOOT.toUpperCase()]) {
    assert.throws(() => startOrchestrad(t, [], script === undefined ? {} : { script }), /orchestrad without arguments is the real profile/, String(script));
  }
  assert.throws(() => runOrchestrad([]), /orchestrad without arguments is the real profile/);
});

test('boot.ts refuses an unknown argument with the bad-arguments code before running anything', (t) => {
  const dir = withTmp(t);
  const r = runOrchestrad(['--port', '8080'], { cwd: dir });
  assert.equal(r.status, EXIT.badArgs, r.stderr);
  assert.match(r.stderr, /^orchestrad: refusing to start: unknown argument "--port"/m);
  assert.equal(r.stdout, '');
});

test('boot.ts refuses a --test-dir outside the temp directory', (t) => {
  const dir = withTmp(t);
  const r = runOrchestrad(['--test-profile', '--test-dir', path.join(path.parse(dir).root, 'orchestra-test-not-in-tmp')], { cwd: dir });
  assert.equal(r.status, EXIT.badArgs, r.stderr);
  assert.match(r.stderr, /--test-dir (does not exist|must be directly inside)/);
});

// The entry is swapped for a temp module through runEntry, the function boot.ts's own entry block
// calls; the real import fence is installed in the child exactly as in production.
test('a start() that throws, or a later uncaught error, exits with EXIT.crashed and one scrubbed line, never Node\'s own 1', (t) => {
  const dir = withModuleTmp(t);
  const runner = path.join(dir, 'runner.mjs');
  fs.writeFileSync(runner, `import { runEntry } from ${JSON.stringify(pathToFileURL(BOOT).href)};\nawait runEntry(new URL(process.argv[2]));\n`);
  const entry = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `export async function start(): Promise<unknown> {\n${body}\n}\n`);
    return pathToFileURL(file).href;
  };
  const run = (href: string) => spawnSync(process.execPath, [runner, href], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const crashLines = (stderr: string) => stderr.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: crashed'));

  const thrown = run(entry('throws.ts', "  throw Object.assign(new Error('boom \\u001b[31m token=abc123'), { code: 'E_TEST' });"));
  assert.equal(thrown.status, EXIT.crashed, thrown.stderr);
  assert.deepEqual(crashLines(thrown.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): E_TEST: boom ?[31m token=***`]);

  const late = run(entry('late.ts', "  setTimeout(() => { throw new Error('late boom'); }, 20);\n  return { mode: 'working' };"));
  assert.equal(late.status, EXIT.crashed, late.stderr);
  assert.deepEqual(crashLines(late.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): Error: late boom`]);

  const rejected = run(entry('rejects.ts', "  void Promise.reject(new Error('stray'));\n  return { mode: 'working' };"));
  assert.equal(rejected.status, EXIT.crashed, rejected.stderr);

  // Control: the elevated code comes only from a typed outcome, with no crash line.
  const elevated = run(entry('elevated.ts', `  return { mode: 'exit', code: ${EXIT.elevated} };`));
  assert.equal(elevated.status, EXIT.elevated, elevated.stderr);
  assert.deepEqual(crashLines(elevated.stderr), []);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'one code per meaning');
});

// nodejs.org/api/process.html#exit-codes: what Node exits with by itself (above 128: a signal).
const NODE_OWN_CODES = [1, 3, 4, 5, 6, 7, 9, 10, 12, 13, 14];

test('every typed exit code lies in 20-29, one per meaning, and none is a code Node exits with by itself', () => {
  const { ok, ...typed } = EXIT;
  assert.equal(ok, 0);
  assert.deepEqual(typed, { elevated: 20, missingFeatures: 21, uiOnly: 22, lockHeld: 23, badArgs: 24, startFailed: 25, crashed: 26 });
  for (const [name, code] of Object.entries(typed)) {
    assert.ok(code >= 20 && code <= 29, `${name} = ${code}`);
    assert.ok(!NODE_OWN_CODES.includes(code), `${name} = ${code} is one of Node's own`);
  }
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'one code per meaning');
});

// A typed non-working outcome (refused, ui-only, exit, ...) must commit its exit code before any
// timer the entry left running can change it: runEntry ends the process with the code (boot.ts
// makeEndProcess), not just set process.exitCode. Here the entry masks a ui-only refusal (code 22) by
// scheduling exitCode = 0 and keeps the loop alive; the fix exits 22 before that fires. Mutating the
// end back to a bare process.exitCode assignment lets the keep-alive timer run and the child hangs.
test('runEntry commits a typed exit code before a later timer can flip it', (t) => {
  const dir = withModuleTmp(t);
  const runner = path.join(dir, 'runner.mjs');
  fs.writeFileSync(runner, `import { runEntry } from ${JSON.stringify(pathToFileURL(BOOT).href)};\nawait runEntry(new URL(process.argv[2]));\n`);
  const entryFile = path.join(dir, 'uionly-mask.ts');
  fs.writeFileSync(entryFile, [
    'export async function start(): Promise<unknown> {',
    '  setTimeout(() => { process.exitCode = 0; }, 30);',
    '  setInterval(() => {}, 1000);',
    `  return { mode: 'ui-only', code: ${EXIT.uiOnly} };`,
    '}',
  ].join('\n'));
  const r = spawnSync(process.execPath, [runner, pathToFileURL(entryFile).href], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(r.status, EXIT.uiOnly, `${r.signal ?? ''} ${r.stderr}`);
});

// Finding F1: process.exit emits 'exit' and then ends with process.exitCode as the listeners left it,
// and the old finalize reached exit only from inside a stdout/stderr write callback. An entry that
// flips exitCode in an 'exit' listener, or makes process.stdout.write swallow its callback, must
// still exit with its typed code: boot ends through the reallyExit it took first, after a bounded flush.
test('runEntry commits a typed exit code that neither an exit listener nor a console write that never calls back can change or hold', (t) => {
  const dir = withModuleTmp(t);
  const runner = path.join(dir, 'runner.mjs');
  fs.writeFileSync(runner, `import { runEntry } from ${JSON.stringify(pathToFileURL(BOOT).href)};\nawait runEntry(new URL(process.argv[2]));\n`);
  const entry = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `export async function start(): Promise<unknown> {\n${body}\n  return { mode: 'ui-only', code: ${EXIT.uiOnly} };\n}\n`);
    return pathToFileURL(file).href;
  };
  const run = (href: string) => spawnSync(process.execPath, [runner, href], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const flip = run(entry('exit-flip.ts', '  process.on(\'exit\', () => { process.exitCode = 0; });'));
  assert.equal(flip.status, EXIT.uiOnly, `an exit listener set exitCode = 0: ${flip.signal ?? ''} ${flip.stderr}`);
  const swallow = run(entry('swallow.ts', [
    '  const out = process.stdout as unknown as { write: (...a: unknown[]) => boolean };',
    '  const err = process.stderr as unknown as { write: (...a: unknown[]) => boolean };',
    '  out.write = () => true;',
    '  err.write = () => true;',
    '  setTimeout(() => { process.exitCode = 0; }, 2500);',
    '  setInterval(() => {}, 1000);',
  ].join('\n')));
  assert.equal(swallow.status, EXIT.uiOnly, `stdout.write swallowed its callback: ${swallow.signal ?? ''} ${swallow.stderr}`);
});

// Finding N1: process.exit and process.reallyExit were pinned keep entries, callable by every module,
// so an entry that returned ui-only could still end the process with 0 from a later microtask, while
// boot's end waited for the console to drain; and boot reached its own reallyExit through
// Function.prototype.call, which a module could replace to swap the code. The fence now locks exit and
// mints reallyExit to boot.ts (which calls it as a plain function). The control runs the same entries
// with a fence that installs nothing: the first two then exit 0. A 60-step promise chain puts the call
// after boot's end has started.
test('PoC: an entry that returns ui-only and then calls process.exit(0) or process.reallyExit(0), or replaces Function.prototype.call, still exits 22', (t) => {
  const dir = withModuleTmp(t);
  const runner = (fenced: boolean) => {
    const file = path.join(dir, fenced ? 'runner.mjs' : 'runner-unfenced.mjs');
    fs.writeFileSync(file, [
      `import { runEntry } from ${JSON.stringify(pathToFileURL(BOOT).href)};`,
      `import { detectFeatures } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(BOOT), 'runtime', 'features.ts')).href)};`,
      fenced
        ? 'await runEntry(new URL(process.argv[2]));'
        : 'await runEntry(new URL(process.argv[2]), { detectFeatures, installImportFence: () => ({ resolveHook: true, locks: 0 }) });',
    ].join('\n'));
    return file;
  };
  const entry = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, [
      'export async function start(): Promise<unknown> {',
      '  let p: Promise<unknown> = Promise.resolve();',
      '  for (let i = 0; i < 60; i++) p = p.then(() => undefined);',
      `  void p.then(() => { process._rawDebug('exitCode before: ' + String(process.exitCode)); ${body} });`,
      `  return { mode: 'ui-only', code: ${EXIT.uiOnly} };`,
      '}',
    ].join('\n'));
    return pathToFileURL(file).href;
  };
  const run = (r: string, href: string) => spawnSync(process.execPath, [r, href], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const fenced = runner(true);
  const open = runner(false);
  const viaExit = entry('via-exit.ts', 'process.exit(0);');
  const viaReally = entry('via-really.ts', '(process as unknown as { reallyExit(c: number): void }).reallyExit(0);');
  for (const [what, href] of [['process.exit(0)', viaExit], ['process.reallyExit(0)', viaReally]] as const) {
    const r = run(fenced, href);
    assert.equal(r.status, EXIT.uiOnly, `${what}: ${r.signal ?? ''} ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^exitCode before: ${EXIT.uiOnly}$`, 'm'), `${what}: the call came after boot had committed 22`);
    const c = run(open, href);
    assert.equal(c.status, 0, `${what}, control without the fence: ${c.stderr}`);
  }
  // Function.prototype.call replaced so that a call of reallyExit gets 0: boot calls it as a plain function.
  const viaCall = entry('via-call.ts', [
    'const call = Function.prototype.call;',
    'Function.prototype.call = function (this: (...a: unknown[]) => unknown, self: unknown, ...a: unknown[]) {',
    "  if (this.name === 'reallyExit') return Reflect.apply(this, self, [0]);",
    '  return Reflect.apply(this, self, a);',
    '};',
    'void call;',
  ].join(' '));
  const r = run(fenced, viaCall);
  assert.equal(r.status, EXIT.uiOnly, `Function.prototype.call replaced: ${r.signal ?? ''} ${r.stderr}`);
});

// Finding N2 of step 3: makeEndProcess set `ending`, then took a Clock of the boot hub, read it and
// scheduled 'deadline:exit:0' on it, unguarded. A throw there left the end uncommitted, and every later
// end (the crash that throw became, a stop) returned at the top, so the process ended with whatever
// exitCode the 'exit' listeners left, or never ended. The deadline was a timerId on the hub every
// module's Clocks share (pre-armed, it made the hub refuse boot's schedule), and the hub read
// performance.now from the global on every call. Now a throw in the setup ends at once with the
// committed code, the deadline is a native timer only boot.ts holds (clock.ts takeExitTimer), and
// clock.ts reads the time sources it took while it evaluated. Each attack runs through runEntry with the
// real fence; its control runs the same entry through runEntry with step 3's end, on clock.ts's hub or
// on one that reads the globals on every call as step 3's real hub did, and the attack lands.
const BOOT_HREF = pathToFileURL(BOOT).href;
const CLOCK_HREF = new URL('./runtime/clock.ts', BOOT_HREF).href;
const FENCED_RUNNER = `import { runEntry } from ${JSON.stringify(BOOT_HREF)};\nawait runEntry(new URL(process.argv[2]));\n`;

/** runEntry with the real fence and step 3's makeEndProcess; argv[3] picks the hub: 'real' is clock.ts's, 'per-call' reads the globals on every call. */
const STEP3_RUNNER = [
  `import { runEntry } from ${JSON.stringify(BOOT_HREF)};`,
  `import { makeRealClock } from ${JSON.stringify(CLOCK_HREF)};`,
  'const reallyExit = process.reallyExit;',
  // Step 3's real hub in brief: one table of timerIds across its ports, performance.now and Date.now
  // read from the globals on every call, and a woken timer fired only when a fresh reading says it is due.
  'function perCallHub() {',
  '  const timers = new Map();',
  '  let native = null;',
  '  const mono = () => Math.floor(performance.now());',
  '  const rearm = () => {',
  '    if (native !== null) clearTimeout(native);',
  '    native = null;',
  '    let next = Infinity;',
  '    for (const e of timers.values()) next = Math.min(next, e.due - mono());',
  '    if (next !== Infinity) native = setTimeout(wake, Math.max(0, next));',
  '  };',
  '  const wake = () => {',
  '    native = null;',
  '    const now = mono();',
  '    for (const [id, e] of [...timers]) if (e.due <= now) { timers.delete(id); e.onFire(); }',
  '    rearm();',
  '  };',
  '  return { port: (onFire) => ({',
  '    nowMono: mono,',
  '    nowWall: () => Date.now(),',
  "    schedule: (s) => { if (timers.has(s.timerId)) throw new Error('duplicate-timer ' + s.timerId); timers.set(s.timerId, { due: s.due, onFire }); rearm(); },",
  '    cancel: (id) => { if (timers.delete(id)) rearm(); },',
  '  }) };',
  '}',
  // boot.ts's makeEndProcess as step 3 committed it.
  'function step3End(hub) {',
  '  let ending = false;',
  '  return (code, line) => {',
  '    if (ending) return;',
  '    ending = true;',
  '    process.exitCode = code;',
  '    const end = () => reallyExit(code);',
  '    const clock = hub.port(end);',
  `    clock.schedule({ timerId: 'deadline:exit:0', class: 'deadline', clock: 'mono', due: clock.nowMono() + ${EXIT_FLUSH_MS} });`,
  '    let left = 2;',
  '    const drained = () => { left--; if (left === 0) end(); };',
  "    try { process.stdout.write('', drained); } catch { drained(); }",
  "    try { process.stderr.write(line ?? '', drained); } catch { drained(); }",
  '  };',
  '}',
  "const hub = process.argv[3] === 'per-call' ? perCallHub() : makeRealClock();",
  'await runEntry(new URL(process.argv[2]), undefined, { hub, end: step3End(hub) });',
].join('\n');

/**
 * Step 3b's review controls: boot() with the real fence, and runEntry and makeEndProcess as they stood
 * before the review's fixes. The crash handler is a plain 'uncaughtException' listener and a crash once
 * the code is committed is a no-op (F1); the exit timer is a native timer made at end time (F3); each
 * write's callbacks are counted, stdout first (F4).
 */
const PRE_FIX_RUNNER = [
  `import { boot, crashLine, exitCodeOf } from ${JSON.stringify(BOOT_HREF)};`,
  `import { makeRealClock } from ${JSON.stringify(CLOCK_HREF)};`,
  'const reallyExit = process.reallyExit;',
  'function preFixEnd() {',
  '  let ending = false;',
  '  return (code, line) => {',
  '    if (ending) return;',
  '    ending = true;',
  '    const end = () => reallyExit(code);',
  '    try {',
  `      setTimeout(end, ${EXIT_FLUSH_MS});`,
  '      process.exitCode = code;',
  '      let left = 2;',
  '      const drained = () => { left--; if (left === 0) end(); };',
  "      try { process.stdout.write('', drained); } catch { drained(); }",
  "      try { process.stderr.write(line ?? '', drained); } catch { drained(); }",
  '    } catch { end(); }',
  '  };',
  '}',
  'const base = { hub: makeRealClock(), end: preFixEnd() };',
  `const crash = (e) => base.end(${EXIT.crashed}, crashLine(e) + '\\n');`,
  "process.on('uncaughtException', crash);",
  'try {',
  '  const o = await boot(new URL(process.argv[2]), undefined, base);',
  '  const code = o.started ? exitCodeOf(o.result) : o.code;',
  '  if (code !== null) base.end(code);',
  '} catch (e) { crash(e); }',
].join('\n');

type Ended = { status: number | null; signal: NodeJS.Signals | null; stderr: string; exitedAt: number };
type EndRun = 'fenced' | 'step3-real-hub' | 'step3-per-call-hub' | 'pre-fix';

/**
 * A module fixture with its runners. entry() writes a start() that runs `body` with the ports boot
 * hands it and returns ui-only (unless `body` returns first); run() starts a child without blocking, so
 * a fenced run and its control go side by side, and stops one still running after `timeoutMs` through
 * its own handle.
 */
function endFixture(t: TestContext): { entry(name: string, body: readonly string[], head?: readonly string[]): string; run(how: EndRun, href: string, timeoutMs?: number): Promise<Ended> } {
  const dir = withModuleTmp(t);
  fs.writeFileSync(path.join(dir, 'runner.mjs'), FENCED_RUNNER);
  fs.writeFileSync(path.join(dir, 'step3-runner.mjs'), STEP3_RUNNER);
  fs.writeFileSync(path.join(dir, 'pre-fix-runner.mjs'), PRE_FIX_RUNNER);
  const argsOf = (how: EndRun, href: string): string[] => {
    if (how === 'fenced') return [path.join(dir, 'runner.mjs'), href];
    if (how === 'pre-fix') return [path.join(dir, 'pre-fix-runner.mjs'), href];
    return [path.join(dir, 'step3-runner.mjs'), href, how === 'step3-real-hub' ? 'real' : 'per-call'];
  };
  return {
    entry(name, body, head = []) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, [
        ...head,
        'type Port = { nowMono(): number; schedule(s: unknown): void };',
        'export async function start(_f: unknown, _fence: unknown, ports: { clock: { port(onFire: () => void): Port } }): Promise<unknown> {',
        ...body.map((l) => `  ${l}`),
        `  return { mode: 'ui-only', code: ${EXIT.uiOnly} };`,
        '}',
      ].join('\n'));
      return pathToFileURL(file).href;
    },
    run(how, href, timeoutMs = 30_000) {
      const child = spawn(process.execPath, argsOf(how, href), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      let exitedAt = 0;
      child.stdout!.resume();
      child.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.once('exit', () => {
        exitedAt = Date.now();
      });
      const closed = new Promise<Ended>((resolve) => {
        child.once('close', (status, signal) => resolve({ status, signal, stderr, exitedAt }));
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      void closed.then(() => clearTimeout(timer));
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      });
      return closed;
    },
  };
}

const PRE_ARM = [
  'const c = ports.clock.port(() => {});',
  "c.schedule({ timerId: 'deadline:exit:0', class: 'deadline', clock: 'mono', due: c.nowMono() + 50 });",
  "process._rawDebug('pre-armed deadline:exit:0');",
];
const EXIT_LISTENER_ZERO = "process.on('exit', () => { process.exitCode = 0; });";

test('N2: an entry that pre-arms \'deadline:exit:0\' on the hub it was handed and sets exitCode = 0 in an exit listener still exits 22; the exit timer is boot.ts\'s, taken before any entry runs', async (t) => {
  const f = endFixture(t);
  const href = f.entry('pre-arm.ts', [
    ...PRE_ARM,
    "try { takeExitTimer(); process._rawDebug('exit timer: handed out'); } catch (e) { process._rawDebug('exit timer: ' + String((e as { reason?: unknown }).reason)); }",
    EXIT_LISTENER_ZERO,
  ], [`import { takeExitTimer } from ${JSON.stringify(CLOCK_HREF)};`]);
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('step3-real-hub', href)]);
  assert.equal(fenced.status, EXIT.uiOnly, `${fenced.signal ?? ''} ${fenced.stderr}`);
  assert.match(fenced.stderr, /^pre-armed deadline:exit:0$/m, 'the hub took the entry\'s timer');
  assert.match(fenced.stderr, /^exit timer: taken$/m, 'boot.ts took the exit timer while it evaluated');
  // Control: step 3's end schedules the same timerId on the same hub, is refused, and never commits.
  assert.match(control.stderr, /^pre-armed deadline:exit:0$/m);
  assert.equal(control.status, 0, `control, step 3's end: ${control.signal ?? ''} ${control.stderr}`);
});

test('N2: with \'deadline:exit:0\' pre-armed, a crash still exits 26 and its line reaches stderr: the flush deadline is not on the hub', async (t) => {
  const f = endFixture(t);
  const href = f.entry('pre-arm-crash.ts', [...PRE_ARM, EXIT_LISTENER_ZERO, "throw new Error('boom after the pre-arm');"]);
  const crashLines = (stderr: string) => stderr.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: crashed'));
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('step3-real-hub', href)]);
  assert.equal(fenced.status, EXIT.crashed, `${fenced.signal ?? ''} ${fenced.stderr}`);
  assert.deepEqual(crashLines(fenced.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): Error: boom after the pre-arm`]);
  assert.match(control.stderr, /^pre-armed deadline:exit:0$/m);
  assert.equal(control.status, 0, `control, step 3's end: ${control.signal ?? ''} ${control.stderr}`);
  assert.deepEqual(crashLines(control.stderr), [], 'control: the crash line was never written');
});

test('N2: an entry that replaces globalThis.performance with one whose now() throws and sets exitCode = 0 in an exit listener still exits 22', async (t) => {
  const f = endFixture(t);
  const href = f.entry('performance-throws.ts', [
    EXIT_LISTENER_ZERO,
    "Object.defineProperty(globalThis, 'performance', { value: { now(): number { throw new Error('performance.now replaced'); } }, configurable: true, writable: true });",
  ]);
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('step3-per-call-hub', href)]);
  assert.equal(fenced.status, EXIT.uiOnly, `${fenced.signal ?? ''} ${fenced.stderr}`);
  assert.equal(control.status, 0, `control, step 3's end on a hub that reads the globals: ${control.signal ?? ''} ${control.stderr}`);
});

test('N2: console writes that never call back and a frozen performance.now still exit 22, on the flush deadline: bounded, not a hang', async (t) => {
  const f = endFixture(t);
  const href = f.entry('frozen.ts', [
    'const out = process.stdout as unknown as { write: (...a: unknown[]) => boolean };',
    'const err = process.stderr as unknown as { write: (...a: unknown[]) => boolean };',
    'out.write = () => true;',
    'err.write = () => true;',
    'const frozenAt = performance.now();',
    "Object.defineProperty(performance, 'now', { value: () => frozenAt, configurable: true, writable: true });",
    "process._rawDebug('returning at ' + String(Date.now()));",
  ]);
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('step3-per-call-hub', href, EXIT_FLUSH_MS * 3)]);
  assert.equal(fenced.status, EXIT.uiOnly, `${fenced.signal ?? ''} ${fenced.stderr}`);
  const returned = /^returning at (\d+)$/m.exec(fenced.stderr);
  assert.ok(returned !== null, fenced.stderr);
  const waited = fenced.exitedAt - Number(returned[1]);
  // No write ever calls back, so only the deadline ends it: not before EXIT_FLUSH_MS, and not much after.
  assert.ok(waited >= EXIT_FLUSH_MS - 100 && waited <= EXIT_FLUSH_MS + 4000, `ended ${waited} ms after start() returned`);
  // Control: step 3's deadline is due at a reading that never comes, so the child had to be stopped.
  assert.equal(control.status, null, `control, step 3's end on a hub that reads the globals: ${control.stderr}`);
  assert.notEqual(control.signal, null);
});

test('N2: an entry that replaces the global process with one whose exitCode setter throws ends at once with 22, before any timer of its own', async (t) => {
  const f = endFixture(t);
  const href = f.entry('process-replaced.ts', [
    'const real = process;',
    "real.on('exit', () => { real.exitCode = 0; });",
    "setTimeout(() => { real._rawDebug('still running'); }, 200);",
    "const fake = { set exitCode(v: unknown) { throw new Error('exitCode replaced'); }, get exitCode(): unknown { return undefined; } };",
    "Object.defineProperty(globalThis, 'process', { value: fake, configurable: true, writable: true });",
  ]);
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('step3-real-hub', href)]);
  assert.equal(fenced.status, EXIT.uiOnly, `${fenced.signal ?? ''} ${fenced.stderr}`);
  assert.doesNotMatch(fenced.stderr, /still running/, 'the end ended the process the moment its setup threw, not on the flush deadline');
  // Control: step 3's end threw on the replaced process before it armed anything; the crash it became returned early.
  assert.match(control.stderr, /^still running$/m);
  assert.equal(control.status, 0, `control, step 3's end: ${control.signal ?? ''} ${control.stderr}`);
});

// Step 3b's review, finding F1: runEntry caught crashes with a plain 'uncaughtException' listener, and a
// crash once a code was committed was a no-op. Node decides a crash's code itself when that listener is
// gone (1, or what the 'exit' listeners leave) or when another listener or monitor throws (7), and with
// the writes held the drain lasts EXIT_FLUSH_MS, so a crash inside it replaced a committed 22. Now the
// crash handler is the capture callback boot.ts minted, its monitor listener comes first, and a crash
// after the commit ends the process at once with the committed code. Each entry swallows the console
// writes (so the drain lasts the whole deadline), returns ui-only, and crashes 300 ms later; each
// control runs the same entry through the pre-fix runner.
const SWALLOW_WRITES = [
  'const out = process.stdout as unknown as { write: (...a: unknown[]) => boolean };',
  'const err = process.stderr as unknown as { write: (...a: unknown[]) => boolean };',
  'out.write = () => true;',
  'err.write = () => true;',
];
const RETURNING = "process._rawDebug('returning at ' + String(Date.now()));";
/** Milliseconds from the entry's 'returning at' line to the child's exit. */
const waitedAfterReturn = (e: Ended): number => {
  const m = /^returning at (\d+)$/m.exec(e.stderr);
  assert.ok(m !== null, e.stderr);
  return e.exitedAt - Number(m[1]);
};

test('F1: a crash during the drain after removeAllListeners() ends at once with the committed 22, not Node\'s own 1', async (t) => {
  const f = endFixture(t);
  const href = f.entry('remove-all.ts', [
    ...SWALLOW_WRITES,
    "setTimeout(() => { process.removeAllListeners(); throw new Error('crash in the drain'); }, 300);",
    RETURNING,
  ]);
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('pre-fix', href)]);
  assert.equal(fenced.status, EXIT.uiOnly, `${fenced.signal ?? ''} ${fenced.stderr}`);
  // At once: not on the flush deadline, which is still EXIT_FLUSH_MS - 300 ms away when the crash comes.
  const waited = waitedAfterReturn(fenced);
  assert.ok(waited < EXIT_FLUSH_MS - 700, `ended ${waited} ms after start() returned`);
  assert.equal(control.status, 1, `control, the pre-fix runner: ${control.signal ?? ''} ${control.stderr}`);
});

test('F1: an exit listener setting exitCode = 0 and a crash or a rejection after removeAllListeners(\'uncaughtException\') still exit 22', async (t) => {
  const f = endFixture(t);
  const entries = [
    ['throw', "throw new Error('crash in the drain');"],
    ['reject', "void Promise.reject(new Error('rejection in the drain'));"],
  ] as const;
  const hrefs = entries.map(([name, crash]) => f.entry(`listeners-gone-${name}.ts`, [
    ...SWALLOW_WRITES,
    EXIT_LISTENER_ZERO,
    `setTimeout(() => { process.removeAllListeners('uncaughtException'); ${crash} }, 300);`,
  ]));
  const runs = await Promise.all(hrefs.flatMap((href) => [f.run('fenced', href), f.run('pre-fix', href)]));
  for (const [i, [name]] of entries.entries()) {
    const fenced = runs[2 * i]!;
    const control = runs[2 * i + 1]!;
    assert.equal(fenced.status, EXIT.uiOnly, `${name}: ${fenced.signal ?? ''} ${fenced.stderr}`);
    assert.equal(control.status, 0, `${name}, control, the pre-fix runner: ${control.signal ?? ''} ${control.stderr}`);
  }
});

test('F1: an \'uncaughtException\' listener or an \'uncaughtExceptionMonitor\' listener that throws during the drain cannot turn the committed 22 into Node\'s 7', async (t) => {
  const f = endFixture(t);
  const entries = [
    ['listener', "process.on('uncaughtException', () => { throw new Error('listener throws'); });"],
    ['monitor', "process.on('uncaughtExceptionMonitor', () => { throw new Error('monitor throws'); });"],
  ] as const;
  const hrefs = entries.map(([name, listen]) => f.entry(`throwing-${name}.ts`, [
    ...SWALLOW_WRITES,
    listen,
    "setTimeout(() => { throw new Error('crash in the drain'); }, 300);",
  ]));
  const runs = await Promise.all(hrefs.flatMap((href) => [f.run('fenced', href), f.run('pre-fix', href)]));
  for (const [i, [name]] of entries.entries()) {
    const fenced = runs[2 * i]!;
    const control = runs[2 * i + 1]!;
    assert.equal(fenced.status, EXIT.uiOnly, `${name}: ${fenced.signal ?? ''} ${fenced.stderr}`);
    assert.equal(control.status, 7, `${name}, control, the pre-fix runner: ${control.signal ?? ''} ${control.stderr}`);
  }
});

test('F1: with no typed end, a plain crash beside a second \'uncaughtException\' listener that throws exits 26 with its line, not 7', async (t) => {
  const f = endFixture(t);
  const href = f.entry('plain-crash.ts', [
    "process.on('uncaughtException', () => { throw new Error('listener throws'); });",
    "setTimeout(() => { throw new Error('plain crash'); }, 300);",
    'setInterval(() => {}, 1000);',
    "return { mode: 'working' };",
  ]);
  const crashLines = (stderr: string) => stderr.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: crashed'));
  const [fenced, control] = await Promise.all([f.run('fenced', href), f.run('pre-fix', href)]);
  assert.equal(fenced.status, EXIT.crashed, `${fenced.signal ?? ''} ${fenced.stderr}`);
  assert.deepEqual(crashLines(fenced.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): Error: plain crash`]);
  // Control: the line says 26, the status is Node's 7 for a crash handler that threw.
  assert.deepEqual(crashLines(control.stderr), [`orchestrad: crashed (exit ${EXIT.crashed}): Error: plain crash`]);
  assert.equal(control.status, 7, `control, the pre-fix runner: ${control.signal ?? ''} ${control.stderr}`);
});

// Step 3b's review, finding F3: the exit timer was a native Timeout made at end time, whose constructor
// assigns its delay and callback through Timeout.prototype, which any module reaches from a setTimeout()
// of its own. An accessor planted there held the deadline (a delay of 2^31 - 1 ms) or dropped it (no
// callback, so the loop drained and the 'exit' listeners chose the code). clock.ts now makes the Timeout
// while boot.ts evaluates, with its own fields and the methods that arm it taken then.
test('F3: an entry that plants accessors on Timeout.prototype cannot hold or drop the flush deadline', async (t) => {
  const f = endFixture(t);
  const proto = 'const P = Object.getPrototypeOf(setTimeout(() => {}, 1)) as object;';
  const hold = f.entry('timeout-hold.ts', [
    ...SWALLOW_WRITES,
    proto,
    "Object.defineProperty(P, '_idleTimeout', { get() { return 2 ** 31 - 1; }, set() {}, configurable: true });",
    RETURNING,
  ]);
  const drop = f.entry('timeout-drop.ts', [
    ...SWALLOW_WRITES,
    EXIT_LISTENER_ZERO,
    proto,
    "Object.defineProperty(P, '_onTimeout', { get() { return null; }, set() {}, configurable: true });",
  ]);
  const [held, heldControl, dropped, droppedControl] = await Promise.all([
    f.run('fenced', hold), f.run('pre-fix', hold, EXIT_FLUSH_MS * 3), f.run('fenced', drop), f.run('pre-fix', drop),
  ]);
  assert.equal(held.status, EXIT.uiOnly, `${held.signal ?? ''} ${held.stderr}`);
  const waited = waitedAfterReturn(held);
  assert.ok(waited >= EXIT_FLUSH_MS - 100 && waited <= EXIT_FLUSH_MS + 4000, `ended ${waited} ms after start() returned`);
  assert.equal(heldControl.status, null, `control, the pre-fix runner: the deadline was held, so the child had to be stopped: ${heldControl.stderr}`);
  assert.notEqual(heldControl.signal, null);
  assert.equal(dropped.status, EXIT.uiOnly, `${dropped.signal ?? ''} ${dropped.stderr}`);
  assert.equal(droppedControl.status, 0, `control, the pre-fix runner: the deadline was dropped and the exit listener chose the code: ${droppedControl.signal ?? ''} ${droppedControl.stderr}`);
});

// Step 3b's review, finding F4: the drain counted callbacks, not streams, and wrote stdout first, so a
// stdout whose write calls back twice ended the process before the crash line was issued; and the
// exitCode assignment came before the writes, so a global process whose exitCode setter throws dropped
// the line too. Each stream now counts once, the line goes out first, and exitCode is set last.
test('F4: a crash still writes its line when stdout calls back twice or the global process\'s exitCode setter throws, and stderr calling back twice does not end a drain stdout is still in', async (t) => {
  const f = endFixture(t);
  const twice = f.entry('stdout-twice.ts', [
    'const out = process.stdout as unknown as { write: (s: unknown, cb?: () => void) => boolean };',
    'out.write = (_s, cb) => { cb?.(); cb?.(); return true; };',
    "throw new Error('crash with a stdout that calls back twice');",
  ]);
  const setter = f.entry('exitcode-throws.ts', [
    'const real = process;',
    "const fake = { stdout: real.stdout, stderr: real.stderr, set exitCode(v: unknown) { throw new Error('exitCode replaced'); }, get exitCode(): unknown { return undefined; } };",
    "Object.defineProperty(globalThis, 'process', { value: fake, configurable: true, writable: true });",
    "throw new Error('crash with an exitCode setter that throws');",
  ]);
  // stderr calls back twice while stdout never does: one stream's callbacks must not end a drain the other is still in.
  const errTwice = f.entry('stderr-twice.ts', [
    'const out = process.stdout as unknown as { write: (...a: unknown[]) => boolean };',
    'const err = process.stderr as unknown as { write: (s: unknown, cb?: () => void) => boolean };',
    'const errWrite = err.write.bind(err);',
    'out.write = () => true;',
    'err.write = (s, cb) => { errWrite(s); cb?.(); cb?.(); return true; };',
    RETURNING,
    "throw new Error('crash with a stderr that calls back twice');",
  ]);
  const crashLines = (stderr: string) => stderr.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: crashed'));
  const runs = await Promise.all([f.run('fenced', twice), f.run('pre-fix', twice), f.run('fenced', setter), f.run('pre-fix', setter), f.run('fenced', errTwice), f.run('pre-fix', errTwice)]);
  for (const [i, what] of ['stdout calls back twice', 'exitCode setter throws'].entries()) {
    const fenced = runs[2 * i]!;
    const control = runs[2 * i + 1]!;
    assert.equal(fenced.status, EXIT.crashed, `${what}: ${fenced.signal ?? ''} ${fenced.stderr}`);
    assert.equal(crashLines(fenced.stderr).length, 1, `${what}: the line reached stderr: ${fenced.stderr}`);
    assert.equal(control.status, EXIT.crashed, `${what}, control, the pre-fix runner: ${control.stderr}`);
    assert.deepEqual(crashLines(control.stderr), [], `${what}, control: the line was never issued`);
  }
  const [held, heldControl] = [runs[4]!, runs[5]!];
  assert.equal(held.status, EXIT.crashed, `stderr calls back twice: ${held.signal ?? ''} ${held.stderr}`);
  assert.equal(crashLines(held.stderr).length, 1, held.stderr);
  const waited = waitedAfterReturn(held);
  assert.ok(waited >= EXIT_FLUSH_MS - 100, `stdout never drained, so only the deadline ends it: ended ${waited} ms after start() returned`);
  assert.equal(heldControl.status, EXIT.crashed, heldControl.stderr);
  const controlWaited = waitedAfterReturn(heldControl);
  assert.ok(controlWaited < EXIT_FLUSH_MS - 700, `control, the pre-fix runner: stderr's second callback ended the drain at once (${controlWaited} ms)`);
});

// runEntry makes its crash handler the capture callback before anything else; when it cannot (another
// capture callback already set, or the fence already in), boot does not own the crash path, so it
// refuses to start: EXIT.crashed and one line, and the entry is never imported.
test('runEntry that cannot take the crash path starts nothing and exits 26', (t) => {
  const dir = withModuleTmp(t);
  const runner = path.join(dir, 'runner.mjs');
  fs.writeFileSync(runner, [
    `import { runEntry } from ${JSON.stringify(BOOT_HREF)};`,
    'process.setUncaughtExceptionCaptureCallback(() => {});',
    'await runEntry(new URL(process.argv[2]));',
  ].join('\n'));
  const entryFile = path.join(dir, 'entry.ts');
  fs.writeFileSync(entryFile, `process._rawDebug('entry ran');\nexport async function start(): Promise<unknown> {\n  return { mode: 'ui-only', code: ${EXIT.uiOnly} };\n}\n`);
  const r = spawnSync(process.execPath, [runner, pathToFileURL(entryFile).href], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(r.status, EXIT.crashed, `${r.signal ?? ''} ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`^orchestrad: crashed \\(exit ${EXIT.crashed}\\): ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET: `, 'm'));
  assert.doesNotMatch(r.stderr, /entry ran/);
});

// Finding F4: the pin below follows import statements; a pre-fence module could also pull a module in
// by a top-level dynamic import, or an import list the text scan misreads. So the graph is measured
// too: a child registers a resolve hook, imports boot.ts as a module (its entry block does not run),
// and every URL resolved while it loads is the pre-fence graph, builtins included.
const PRE_FENCE_BUILTINS: readonly string[] = ['node:child_process', 'node:fs', 'node:module', 'node:path', 'node:timers', 'node:zlib'];

test('measured in a child: every module resolved while boot.ts loads, before its fence, is PRE_FENCE_GRAPH and PRE_FENCE_BUILTINS; node:sqlite is not among them', (t) => {
  const dir = withModuleTmp(t);
  const runner = path.join(dir, 'graph.mjs');
  fs.writeFileSync(runner, [
    "import { registerHooks } from 'node:module';",
    'const seen = [];',
    'registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.push(r.url); return r; } });',
    `await import(${JSON.stringify(pathToFileURL(BOOT).href)});`,
    'process.stdout.write(JSON.stringify(seen));',
  ].join('\n'));
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const urls = JSON.parse(r.stdout) as string[];
  const repo = pathToFileURL(fileURLToPath(new URL('../../', import.meta.url))).href;
  const inRepo = urls.filter((u) => u.toLowerCase().startsWith(repo.toLowerCase())).map((u) => decodeURIComponent(u.slice(repo.length)));
  assert.deepEqual([...new Set(inRepo)].sort(), [...PRE_FENCE_GRAPH].sort());
  const builtins = [...new Set(urls.filter((u) => u.startsWith('node:')))].sort();
  assert.deepEqual(builtins, [...PRE_FENCE_BUILTINS]);
  assert.deepEqual(urls.filter((u) => !u.startsWith('node:') && !u.toLowerCase().startsWith(repo.toLowerCase())), [], 'nothing from outside the repo');
});

// The modules boot.ts loads before installImportFence() runs are its transitive static (non-type)
// relative imports; the runtime fence is installed inside boot() and never judges them. This pins
// that set, so no new module silently joins the pre-fence graph (where an import-time side effect or
// a forbidden builtin would run unjudged), and shows the static scan is their standing guard.
const PRE_FENCE_GRAPH: readonly string[] = [
  'src/boot.ts', 'src/fs/node-io.ts', 'src/fs/paths.ts', 'src/fs/read-gate.ts', 'src/os/node-proc.ts',
  'src/os/spawn.ts', 'src/runtime/builtin-policy.ts', 'src/runtime/clock.ts', 'src/runtime/exit.ts', 'src/runtime/features.ts',
  'src/runtime/import-fence.ts', 'src/runtime/log.ts', 'src/runtime/own.ts', 'src/runtime/process-powers.ts',
  // Step 3: the node:sqlite mint. Its imports are type-only: db.ts and node:sqlite load with the first opener.
  'src/store/node-sqlite.ts',
  // Finding N3: the one deep freeze of every exported table (imports nothing, no side effect).
  'shared/frozen.js',
];

test('boot.ts\'s pre-fence module graph is a fixed set, and the static scan still guards it', () => {
  const repoDir = fileURLToPath(new URL('../../', import.meta.url));
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const text = fs.readFileSync(path.join(repoDir, key), 'utf8');
    for (const r of findImports(text)) {
      if (r.typeOnly || r.form === 'dynamic' || r.form === 'require') continue;
      // .js too: a shared/ module joining the graph would load before the fence like any other.
      if (!/^\.\.?\//.test(r.spec) || !/\.(?:ts|js)$/.test(r.spec)) continue;
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(key), r.spec)));
    }
  };
  visit('src/boot.ts');
  assert.deepEqual([...seen].sort(), [...PRE_FENCE_GRAPH].sort());
  // These load before the fence, so the static builtin scan — not the runtime fence — is the guard:
  // a forbidden builtin added to one is caught at build time.
  for (const m of ['src/fs/read-gate.ts', 'src/os/spawn.ts', 'src/fs/paths.ts']) {
    const hits = scan(m, "import * as vm from 'node:vm';\n").filter((h) => h.rule === 'builtin-policy');
    assert.equal(hits.length, 1, `${m}: the static scan flags a forbidden builtin`);
  }
});

test('crashLine never throws, whatever was thrown', () => {
  const hostile = { toString(): string { throw new Error('no'); } };
  assert.equal(crashLine(hostile), `orchestrad: crashed (exit ${EXIT.crashed}): <unprintable error>`);
  assert.equal(crashLine('plain'), `orchestrad: crashed (exit ${EXIT.crashed}): plain`);
});

test('exitCodeOf reads a numeric code and nothing else', () => {
  assert.equal(exitCodeOf({ code: 3 }), 3);
  assert.equal(exitCodeOf({ mode: 'working' }), null);
  assert.equal(exitCodeOf(undefined), null);
  assert.equal(exitCodeOf({ code: '3' }), null);
});

test('importing boot.ts as a module does not start anything', async () => {
  const mod = await import('../../src/boot.ts');
  assert.equal(typeof mod.boot, 'function');
});
