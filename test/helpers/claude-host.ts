// The Claude host behind the real spawn gate, in-process (alpha 0.2 design §6 "驱动和端点"): a spawn
// backend that, for the gate's claude-host decision, runs hosts/claude/host-core.mjs's runHost over
// PassThrough stdio with the fake SDK (test/fixtures/fake-sdk.ts) and the env the gate built. No node.exe
// child, no claude.exe, no model, no network; the production code has no test-only branch for it.
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import type { BackendOptions, ChildLike, SpawnBackend } from '../../src/os/spawn.ts';
import type { HostPipe } from '../../src/os/owned-proc.ts';
import type { DispatchPort } from '../../src/route/dispatch.ts';
import type { StatusPort } from '../../src/route/front-desk.ts';
import { runHost } from '../../hosts/claude/host-core.mjs';
import { realpath } from '../../src/fs/node-io.ts';
import { hostPipe } from '../../src/os/owned-proc.ts';
import { CLAUDE_GATEWAY_TOKEN, SpawnGate, resolveSystemRoot } from '../../src/os/spawn.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { ClaudeOwned } from '../../src/owned/claude-owned.ts';
import { makeFakeSdk } from '../fixtures/fake-sdk.ts';
import { withTmp } from './tmp.ts';

export const HOST_ENTRY = fileFromRepo('hosts', 'claude', 'host.mjs');

function fileFromRepo(...parts: string[]): string {
  return path.join(path.dirname(path.dirname(import.meta.dirname)), ...parts);
}

export type HostCall = { exe: string; argv: string[]; opts: BackendOptions; sdk: ReturnType<typeof makeFakeSdk>; stdin: string[]; done: Promise<{ reason: string }> };

export type HostBackend = {
  backend: SpawnBackend;
  calls: HostCall[];
  kills: number;
  /** When set, the next host ignores every frame (a hung host): only a kill ends it. */
  hang: boolean;
  /** Ends the latest host's child as a crash would: a close with code 1 and no exit frame. */
  crash(): void;
};

export function hostBackend(): HostBackend {
  const state: HostBackend = { backend: () => { throw new Error('unset'); }, calls: [], kills: 0, hang: false, crash: () => {} };
  state.backend = (exe, argv, opts) => {
    const sdk = makeFakeSdk();
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: string[] = [];
    stdin.on('data', (c: Buffer) => seen.push(c.toString('utf8')));
    let closed = false;
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      setImmediate(() => ee.emit('close', code, signal));
    };
    const hang = state.hang;
    state.hang = false;
    const input = hang ? (async function* () {
      await new Promise<void>(() => {});
    })() : stdin;
    const done = runHost({
      query: sdk.query,
      input,
      output: (line: string) => {
        if (!closed) stdout.write(line);
      },
      schedule: (ms: number, fn: () => void) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      randomBytes: (n: number) => crypto.randomBytes(n),
      sha256: (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      realpath: (p: string) => fs.promises.realpath(p),
      env: { ...opts.env },
    }) as Promise<{ reason: string }>;
    void done.then((r) => close(r.reason === 'closed' || r.reason === 'stdin-eof' ? 0 : 2, null));
    const child = Object.assign(ee, {
      pid: 50_000 + state.calls.length,
      stdin,
      stdout,
      stderr,
      kill: () => {
        state.kills++;
        close(null, 'SIGTERM');
        return true;
      },
    }) as unknown as ChildLike;
    state.crash = () => close(1, null);
    state.calls.push({ exe, argv: [...argv], opts, sdk, stdin: seen, done });
    return child;
  };
  return state;
}

export const CLAUDE_EXTRA = Object.freeze({
  CLAUDE_CONFIG_DIR: 'C:\\placeholder\\claude-home', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: CLAUDE_GATEWAY_TOKEN,
  ANTHROPIC_SMALL_FAST_MODEL: 'zcode/GLM-5-Turbo', NO_PROXY: '127.0.0.1,localhost',
});

export type ClaudeRig = {
  dir: string;
  home: string;
  workRoot: string;
  configRoot: string;
  clock: VirtualClock;
  approvals: Approvals;
  host: HostBackend;
  gate: SpawnGate;
  owned: ClaudeOwned;
  /** What verify() answers (null: the pins match). */
  tamper: { why: string | null };
  /** The fake SDK query of the latest host. */
  q(): ReturnType<typeof makeFakeSdk>['queries'][number];
};

/** Owned Claude sessions over the real gate (rule claude-host) and the in-process host; settleMs 0 unless given. */
export function claudeRig(t: TestContext, opts: { settleMs?: number; dispatch?: DispatchPort; frontDesk?: { system: string; port: StatusPort } } = {}): ClaudeRig {
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'orchestra');
  const workRoot = path.join(home, 'work');
  const configRoot = path.join(home, 'claude');
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  const sys = resolveSystemRoot(process.env, realpath);
  if (!sys.ok) throw new Error(JSON.stringify(sys));
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const host = hostBackend();
  const tamper = { why: null as string | null };
  const gate = new SpawnGate({
    systemRoot: sys, rules: ['claude-host'], record: () => {}, backend: host.backend, realpath, clock, env: process.env,
    envExtra: { 'claude-host': { ...CLAUDE_EXTRA, CLAUDE_CONFIG_DIR: path.join(home, 'claude-home') } },
    cwd: { allowedRoots: [workRoot], protectedDirs: [home], userHome: os.homedir(), ownedWorkRoot: workRoot },
    claudeHost: { node: process.execPath, entry: HOST_ENTRY, verify: () => tamper.why },
  });
  const approvals = new Approvals({ hub: clock, settleMs: opts.settleMs ?? 0 });
  const owned = new ClaudeOwned({
    approvals,
    makeWorkDir: (id) => {
      const d = path.join(workRoot, id);
      fs.mkdirSync(d);
      return d;
    },
    makeConfigDir: (id) => {
      const d = path.join(configRoot, id);
      fs.mkdirSync(d);
      return d;
    },
    launch: (cwd): HostPipe => hostPipe(gate.start({ exe: process.execPath, argv: [HOST_ENTRY], cwd })),
    claudeExe: path.join(dir, 'claude.exe'),
    protectedRoots: [home],
    hub: clock,
    now: () => clock.wall,
    redact: (text) => ({ text, count: 0 }),
    ...(opts.dispatch === undefined ? {} : { dispatch: opts.dispatch }),
    ...(opts.frontDesk === undefined ? {} : { frontDesk: opts.frontDesk }),
  });
  t.after(() => {
    owned.endAll();
  });
  return {
    dir, home, workRoot, configRoot, clock, approvals, host, gate, owned, tamper,
    q: () => {
      const c = host.calls.at(-1);
      if (c === undefined || c.sdk.queries.length === 0) throw new Error('no query yet');
      return c.sdk.queries[0]!;
    },
  };
}

/** Waits (real time, in small steps) until `ok()` holds; fails after about 3 s. */
export async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
