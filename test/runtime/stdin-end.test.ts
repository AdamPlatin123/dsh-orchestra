import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import type { StopPort, StopWhy } from '../../src/runtime/working.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { EXIT } from '../../src/runtime/startup.ts';
import { stdinKind, watchStdinEnd } from '../../src/runtime/stdin-end.ts';
import { BOOT, startOrchestrad, waitForLine } from '../helpers/orchestrad.ts';
import { FENCE_OK, captureConsole, minimalEnv, startInProcess, testPorts } from '../helpers/start.ts';
import { withTmp } from '../helpers/tmp.ts';

// orchestrad stops in order when its stdin pipe ends (orchestra app: stdin-EOF shutdown): the same stop as
// Ctrl+C. A console, NUL (stdio 'ignore', a detached start) or a file never ends it that way.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKING = /^orchestrad: working \(test profile, pid \d+, data .+\)$/;
const PIPE_LINE = /^orchestrad: stdin is a pipe: when it closes, orchestrad stops as on Ctrl\+C/;

function logEvents(dir: string): { event: string; fields: Record<string, unknown> }[] {
  const file = path.join(fs.realpathSync.native(dir), 'orchestra', 'run', 'orchestrad.log');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; fields: Record<string, unknown> });
}

test('stdinKind: a console is tty, a net.Socket is a pipe, a file or NUL stream and a plain Readable are other', () => {
  assert.equal(stdinKind({ isTTY: true, setNoDelay: () => {} }), 'tty');
  const sock = new net.Socket();
  assert.equal(stdinKind(sock), 'pipe');
  sock.destroy();
  assert.equal(stdinKind(new PassThrough()), 'other');
  assert.equal(stdinKind(Readable.from([])), 'other');
  const file = fs.createReadStream(BOOT);
  assert.equal(stdinKind(file), 'other');
  file.destroy();
  assert.equal(stdinKind(null), 'other');
  assert.equal(stdinKind(undefined), 'other');
  assert.equal(stdinKind({ isTTY: 'yes', setNoDelay: 1 }), 'other');
});

test('watchStdinEnd: what is read is dropped, the end fires once (EOF or close), a read error fires stdin-error, the undo fires nothing', async () => {
  const a = new PassThrough();
  const got: string[] = [];
  watchStdinEnd(a, (why, detail) => got.push(`${why}:${detail}`));
  a.write('ignored\n');
  await sleep(10);
  assert.deepEqual(got, []);
  a.end();
  await sleep(10);
  a.destroy();
  await sleep(10);
  assert.deepEqual(got, ['stdin-eof:null'], 'once, though end and close both came');

  const b = new PassThrough();
  const gotB: string[] = [];
  watchStdinEnd(b, (why, detail) => gotB.push(`${why}:${detail}`));
  b.destroy(Object.assign(new Error('pipe gone'), { code: 'EPIPE' }));
  await sleep(10);
  assert.deepEqual(gotB, ['stdin-error:EPIPE']);

  const c = new PassThrough();
  const gotC: string[] = [];
  const undo = watchStdinEnd(c, (why) => gotC.push(why));
  undo();
  c.end();
  c.resume();
  await sleep(10);
  c.destroy(new Error('late'));
  await sleep(10);
  assert.deepEqual(gotC, [], 'after the undo nothing fires, and a late error does not throw');
});

test('in-process: a stop asked by the stdin watch is logged with its reason, said on the console, and runs the one stop', async (t) => {
  const live: (() => Promise<void>)[] = [];
  t.after(async () => { for (const stop of live) await stop(); });
  const dir = fs.realpathSync.native(withTmp(t));
  let ask: ((why?: StopWhy, detail?: string | null) => void) | null = null;
  let undone = 0;
  const released: string[] = [];
  const stopping: StopPort = {
    stdin: () => 'pipe',
    onSignal: (stop) => {
      ask = stop;
      return () => { undone++; };
    },
    end: async (lock) => {
      released.push('end');
      await lock.release();
    },
  };
  const con = captureConsole();
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv(), console: con.port, stopping,
  });
  if (o.mode === 'working') live.push(o.stop);
  assert.equal(o.mode, 'working', con.all().join('\n'));
  if (o.mode !== 'working') return;
  assert.ok(con.out.some((l) => PIPE_LINE.test(l)), 'the watch is said at startup');
  // The pipe line comes before the working line, which stays the last line of the startup.
  assert.match(con.out.at(-1)!, WORKING);
  assert.ok(ask !== null);
  ask!('stdin-eof', null);
  await o.stopped;
  assert.deepEqual(released, ['end']);
  assert.equal(undone, 1, 'the watch and the signals are undone first');
  assert.ok(con.out.some((l) => /^orchestrad: stdin closed: the program that started orchestrad is gone or let go of it; stopping as on Ctrl\+C$/.test(l)), con.out.join('\n'));
  const events = logEvents(dir);
  const asked = events.find((e) => e.event === 'stop-asked');
  assert.deepEqual(asked?.fields, { why: 'stdin-eof', detail: null });
  assert.ok(events.some((e) => e.event === 'stopped'));
  assert.ok(events.findIndex((e) => e.event === 'stop-asked') < events.findIndex((e) => e.event === 'stopped'));
});

test('measured in a child: orchestrad with a pipe for stdin stops by itself, in order, with code 0 when the pipe is closed', async (t) => {
  const dir = withTmp(t);
  const child = spawn(process.execPath, [BOOT, '--test-profile', '--test-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const out: string[] = [];
  let rest = '';
  child.stdout.on('data', (c: Buffer) => {
    rest += c.toString('utf8');
    const parts = rest.split(/\r?\n/);
    rest = parts.pop()!;
    out.push(...parts);
  });
  child.stderr.resume();
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  for (let waited = 0; !out.some((l) => WORKING.test(l)); waited += 50) {
    if (waited > 30_000) assert.fail(`no working line: ${out.join(' | ')}`);
    if (child.exitCode !== null) assert.fail(`exited early (${child.exitCode}): ${out.join(' | ')}`);
    await sleep(50);
  }
  assert.ok(out.some((l) => PIPE_LINE.test(l)), out.join('\n'));
  // Something written to stdin is dropped; it does not stop orchestrad.
  child.stdin.write('hello\n');
  await sleep(300);
  assert.equal(child.exitCode, null);
  child.stdin.end();
  const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout' as const)]);
  assert.equal(code, EXIT.ok, `exit: ${String(code)}; stdout: ${out.join(' | ')}`);
  const events = logEvents(dir);
  assert.deepEqual(events.find((e) => e.event === 'stop-asked')?.fields, { why: 'stdin-eof', detail: null });
  assert.ok(events.some((e) => e.event === 'stopped'), 'its own stop ran (a kill writes no stopped entry)');
});

test('measured in a child: stdin ignored (NUL, as in a detached start) never stops orchestrad and says no pipe watch', async (t) => {
  const dir = withTmp(t);
  const child = startOrchestrad(t, ['--test-profile', '--test-dir', dir]);
  await waitForLine(child, WORKING);
  assert.equal(child.lines().some((l) => PIPE_LINE.test(l)), false);
  await sleep(1500);
  assert.equal(child.child.exitCode, null, 'still working after its NUL stdin read EOF');
  assert.equal(logEvents(dir).some((e) => e.event === 'stop-asked' || e.event === 'stdin-watch'), false);
  await child.stop();
});

test('measured in a child: a detached orchestrad whose parent is killed reads EOF on stdin and runs its own stop', async (t) => {
  // A Node parent puts a child it does not detach into its libuv Job, which kills the child with it (S4
  // case a), so the parent here detaches orchestrad: then only the pipe tells it the parent is gone.
  const dir = withTmp(t);
  const parentJs = path.join(fs.realpathSync.native(dir), 'parent.cjs');
  fs.writeFileSync(parentJs, [
    "const { spawn } = require('node:child_process');",
    "const c = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });",
    "process.stdout.write('child-pid ' + c.pid + '\\n');",
    "c.stdout.on('data', (d) => process.stdout.write(d));",
    "c.stderr.resume();",
  ].join('\n'));
  const parent = spawn(process.execPath, [parentJs, BOOT, '--test-profile', '--test-dir', dir], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let text = '';
  parent.stdout.on('data', (c: Buffer) => {
    text += c.toString('utf8');
  });
  let pid: number | null = null;
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill();
    // Only if the test failed half way: the orchestrad this test started, by the pid its parent printed.
    if (pid !== null && alive(pid)) process.kill(pid);
  });
  for (let waited = 0; !/orchestrad: working/.test(text); waited += 50) {
    if (waited > 30_000) assert.fail(`no working line: ${text}`);
    await sleep(50);
  }
  pid = Number(/child-pid (\d+)/.exec(text)![1]);
  parent.kill();
  for (let waited = 0; alive(pid); waited += 100) {
    if (waited > 20_000) assert.fail('orchestrad still runs 20 s after its parent was killed');
    await sleep(100);
  }
  const events = logEvents(dir);
  assert.deepEqual(events.find((e) => e.event === 'stop-asked')?.fields, { why: 'stdin-eof', detail: null });
  assert.ok(events.some((e) => e.event === 'stopped'), 'its own stop ran');
});
