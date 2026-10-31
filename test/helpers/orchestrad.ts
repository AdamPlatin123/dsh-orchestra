// Runs src/boot.ts as a child process. Never with zero arguments: that is the real profile, which
// would read the real harness roots and create ~/.orchestra. Children are stopped only through
// their own ChildProcess handle.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const BOOT = fileURLToPath(new URL('../../src/boot.ts', import.meta.url));

function guard(args: readonly string[]): void {
  if (args.length === 0) throw new Error('test helper: orchestrad without arguments is the real profile; tests never start it');
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
  if (opts.script === undefined) guard(args);
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
