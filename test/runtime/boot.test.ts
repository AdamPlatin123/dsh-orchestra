import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { crashLine, exitCodeOf } from '../../src/boot.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { BOOT, runOrchestrad, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
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

test('boot.ts refuses an unknown argument with exit 5 before running anything', (t) => {
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
test('a start() that throws, or a later uncaught error, exits with EXIT.crashed and one scrubbed line, never 1', (t) => {
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

  // Control: exit 1 comes only from a typed elevated outcome, with no crash line.
  const elevated = run(entry('elevated.ts', "  return { mode: 'exit', code: 1 };"));
  assert.equal(elevated.status, EXIT.elevated, elevated.stderr);
  assert.deepEqual(crashLines(elevated.stderr), []);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'one code per meaning');
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
