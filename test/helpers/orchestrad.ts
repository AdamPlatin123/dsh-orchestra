// Runs src/boot.ts as a child process. Never with zero arguments: that is the real profile, which
// would read the real harness roots and create ~/.orchestra. The one exception,
// runRealProfileUnderTestRunner, exists to watch that refusal and pins the child's home to a fake one.
// Children are stopped only through their own ChildProcess handle.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const BOOT = fileURLToPath(new URL('../../src/boot.ts', import.meta.url));

function guard(args: readonly string[]): void {
  if (args.length === 0) throw new Error('test helper: orchestrad without arguments is the real profile; tests never start it');
}

/** Whether `script` is src/boot.ts, however it is spelled. */
export function isBoot(script: string): boolean {
  let a = path.resolve(script);
  let b = BOOT;
  try {
    a = fs.realpathSync.native(a);
    b = fs.realpathSync.native(b);
  } catch {
    // A script that does not exist is not boot.ts; compare as written.
  }
  return a.toLowerCase() === b.toLowerCase();
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type Orchestrad = {
  readonly pid: number;
  readonly child: ChildProcess;
  lines(): string[];
  errLines(): string[];
  readonly exited: Promise<Exit>;
  /** Ends the child through its handle and waits for it; a child that already exited is left alone. */
  stop(): Promise<Exit>;
  onLine(fn: (line: string) => void): void;
};

export function startOrchestrad(t: TestContext, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; script?: string } = {}): Orchestrad {
  if (opts.script === undefined || isBoot(opts.script)) guard(args);
  const child = spawn(process.execPath, [opts.script ?? BOOT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env ?? process.env, windowsHide: true });
  if (typeof child.pid !== 'number') throw new Error('test helper: spawn gave no pid');
  const out: string[] = [];
  const err: string[] = [];
  const listeners: ((line: string) => void)[] = [];
  const split = (into: string[], notify: boolean) => {
    let rest = '';
    return (chunk: Buffer) => {
      rest += chunk.toString('utf8');
      const parts = rest.split(/\r?\n/);
      rest = parts.pop()!;
      for (const p of parts) {
        into.push(p);
        if (notify) for (const fn of listeners) fn(p);
      }
    };
  };
  child.stdout!.on('data', split(out, true));
  child.stderr!.on('data', split(err, false));
  let done: Exit | null = null;
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      done = { code, signal };
      resolve(done);
    });
  });
  const stop = async (): Promise<Exit> => {
    if (done !== null) return done;
    child.kill();
    return exited;
  };
  t.after(async () => {
    await stop();
  });
  return {
    pid: child.pid,
    child,
    lines: () => [...out],
    errLines: () => [...err],
    exited,
    stop,
    onLine: (fn) => listeners.push(fn),
  };
}

/** Resolves with the first stdout line matching `re` (already printed or later); rejects on exit or timeout. */
export function waitForLine(o: Orchestrad, re: RegExp, timeoutMs = 30_000): Promise<string> {
  const seen = o.lines().find((l) => re.test(l));
  if (seen !== undefined) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no line matching ${re} within ${timeoutMs} ms; stdout: ${o.lines().join(' | ')}; stderr: ${o.errLines().join(' | ')}`)), timeoutMs);
    o.onLine((l) => {
      if (re.test(l)) {
        clearTimeout(timer);
        resolve(l);
      }
    });
    void o.exited.then((e) => {
      clearTimeout(timer);
      reject(new Error(`orchestrad exited (${e.code ?? e.signal}) before a line matching ${re}; stdout: ${o.lines().join(' | ')}; stderr: ${o.errLines().join(' | ')}`));
    });
  });
}

export type Ran = { status: number | null; stdout: string; stderr: string };

export function runOrchestrad(args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Ran {
  guard(args);
  const r = spawnSync(process.execPath, [BOOT, ...args], { encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000, cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export type RealProfileRun = Ran & { stoppedByTest: boolean };

/**
 * Starts orchestrad with no arguments to watch the real profile refuse under the test runner. The
 * child gets a minimal environment: `fakeHome` (a dir inside an orchestra-test-* dir directly in
 * os.tmpdir()) as its home, which a probe child confirms through os.homedir() first, no harness-root
 * or ORCHESTRA_HOME variables, and this process's NODE_TEST_CONTEXT. Were the refusal ever missing,
 * the child would work against the fake home; it is then stopped through its handle as soon as it
 * says it works, or after `timeoutMs`.
 */
export async function runRealProfileUnderTestRunner(fakeHome: string, timeoutMs = 30_000): Promise<RealProfileRun> {
  const marker = process.env.NODE_TEST_CONTEXT;
  if (marker === undefined) throw new Error('test helper: NODE_TEST_CONTEXT is unset; run this under node --test');
  const home = fs.realpathSync.native(fakeHome);
  const rel = path.relative(fs.realpathSync.native(os.tmpdir()), home);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.split(path.sep)[0]!.startsWith('orchestra-test-') || !rel.includes(path.sep)) {
    throw new Error(`test helper: the fake home must lie inside an orchestra-test-* dir in the temp dir: ${home}`);
  }
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), NODE_TEST_CONTEXT: marker,
  };
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
  if (probe.status !== 0 || probe.stdout.toLowerCase() !== home.toLowerCase()) {
    throw new Error(`test helper: the child's home would be ${JSON.stringify(probe.stdout)}, not the fake home ${home}; orchestrad not started`);
  }
  const child = spawn(process.execPath, [BOOT], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  let stoppedByTest = false;
  const stopOnce = () => {
    if (stoppedByTest || child.exitCode !== null || child.signalCode !== null) return;
    stoppedByTest = true;
    child.kill();
  };
  child.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
    if (/^orchestrad: working /m.test(stdout)) stopOnce();
  });
  child.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  const timer = setTimeout(stopOnce, timeoutMs);
  const status = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  clearTimeout(timer);
  return { status, stdout, stderr, stoppedByTest };
}
