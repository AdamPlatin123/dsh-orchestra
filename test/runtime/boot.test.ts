import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crashLine, exitCodeOf } from '../../src/boot.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { BOOT, isBoot, runOrchestrad, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { findImports, scan } from '../helpers/scan-rules.ts';
import { withTmp } from '../helpers/tmp.ts';

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
  const dir = withTmp(t);
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
  const dir = withTmp(t);
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
  const dir = withTmp(t);
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
  const dir = withTmp(t);
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

// Finding F4: the pin below follows import statements; a pre-fence module could also pull a module in
// by a top-level dynamic import, or an import list the text scan misreads. So the graph is measured
// too: a child registers a resolve hook, imports boot.ts as a module (its entry block does not run),
// and every URL resolved while it loads is the pre-fence graph, builtins included.
const PRE_FENCE_BUILTINS: readonly string[] = ['node:child_process', 'node:fs', 'node:module', 'node:path', 'node:timers', 'node:zlib'];

test('measured in a child: every module resolved while boot.ts loads, before its fence, is PRE_FENCE_GRAPH and PRE_FENCE_BUILTINS; node:sqlite is not among them', (t) => {
  const dir = withTmp(t);
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
