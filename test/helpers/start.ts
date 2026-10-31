// Inputs for calling main.ts start() and working.ts runWorking() in-process, and the only way tests
// call them (static rule in-process-start-only-in-helper). Always with a fake home and a minimal
// environment: the real profile derives its harness roots from both, and must never see the real
// ones here. A test file run directly or with --test-isolation=none carries no NODE_TEST_CONTEXT, so
// the real profile's refusal under the test runner would not hold; the wrappers refuse on their own.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BootPorts } from '../../src/boot.ts';
import type { StartDeps, StartOutcome } from '../../src/main.ts';
import type { SpawnGateSpec } from '../../src/os/node-proc.ts';
import type { Features } from '../../src/runtime/features.ts';
import type { FenceStatus } from '../../src/runtime/import-fence.ts';
import type { ConsolePort } from '../../src/runtime/log.ts';
import type { StopPort, WorkingContext, WorkingOutcome } from '../../src/runtime/working.ts';
import type { FakeSpawn } from './fake-spawn.ts';
import { makeReadGate, makeWriteFence, realpath } from '../../src/fs/node-io.ts';
import { start } from '../../src/main.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { SpawnGate } from '../../src/os/spawn.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { BASE_LOCKS } from '../../src/runtime/process-powers.ts';
import { runWorking } from '../../src/runtime/working.ts';

/** What boot's fence reports on a thread without IPC, web storage or --permission. */
export const FENCE_OK: FenceStatus = { resolveHook: true, locks: BASE_LOCKS };
export const FENCE_NO_HOOK: FenceStatus = { ...FENCE_OK, resolveHook: false };

/**
 * The ports boot hands main.ts, built the same way from the minted modules (tests are not fenced and
 * import them directly). With a spy, the spawn gate factory builds gates around the spy's backend, so
 * nothing is executed.
 */
export function testPorts(spy?: FakeSpawn): BootPorts {
  return {
    fetch: globalThis.fetch,
    realpath,
    makeReadGate,
    makeWriteFence,
    makeSpawnGate: spy === undefined ? makeSpawnGate : spyGate(spy),
    makeDbOpener,
    clock: makeRealClock(),
    // In-process starts stop through IN_PROCESS_STOP; ending the process would end the test file.
    endProcess: () => {
      throw new Error('test ports: endProcess would end the test process');
    },
  };
}

/** A spawn gate factory around a spy backend: what makeSpawnGate does, minus the real backend. */
export function spyGate(spy: FakeSpawn): (spec: SpawnGateSpec) => SpawnGate {
  return (spec) => new SpawnGate({ ...spec, backend: spy.backend });
}

/** SystemRoot, windir and the temp dir only: no CLAUDE_CONFIG_DIR, DSH_HOME, CODEX_HOME, XDG or ORCHESTRA_HOME. */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: os.tmpdir(), TMP: os.tmpdir(), ...extra };
}

/**
 * The stopping every in-process start() and runWorking() gets unless the caller hands its own: no
 * signal handlers on the test process, and stop() releases the lock instead of ending the process
 * (main.ts's default would exit the test file).
 */
export const IN_PROCESS_STOP: StopPort = { onSignal: () => () => {}, end: (lock) => lock.release() };

/**
 * Throws unless `home` lies strictly inside an orchestra-test-* dir directly in `tmp`, judged on the
 * real path of its deepest existing part (so a junction out of the fixture does not count). `home`
 * itself need not exist.
 */
export function assertFakeHome(home: unknown, what: string, tmp: string = os.tmpdir()): void {
  if (typeof home !== 'string' || home.length === 0) throw new Error(`test helper: ${what} must be a fake home; none was given, and main.ts would take the real one`);
  let existing = path.resolve(home);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const up = path.dirname(existing);
    if (up === existing) break;
    rest.unshift(path.basename(existing));
    existing = up;
  }
  const real = path.join(fs.realpathSync.native(existing), ...rest);
  const rel = path.relative(fs.realpathSync.native(tmp), real);
  const parts = rel.split(path.sep);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || !parts[0]!.startsWith('orchestra-test-') || parts.length < 2) {
    throw new Error(`test helper: ${what} must lie inside an orchestra-test-* dir in the temp dir: ${home} (resolves to ${real})`);
  }
}

/**
 * A plain copy of `o`'s own string-keyed data fields, enumerable or not, each read once through its
 * descriptor. An accessor is refused (its getter could answer the check one way and start() another),
 * and so is a symbol key. What the checks below judge is this copy, and the copy is what start() gets.
 */
function ownDataCopy(o: object, what: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k !== 'string') throw new Error(`test helper: ${what} has a symbol key`);
    const d = Object.getOwnPropertyDescriptor(o, k)!;
    if (!('value' in d)) throw new Error(`test helper: ${what}.${k} is an accessor; hand a plain value`);
    out[k] = d.value;
  }
  return out;
}

/**
 * The overrides start() gets: a copy of the caller's own fields (every own field, enumerable or not,
 * read once; env copied the same way), and IN_PROCESS_STOP unless it hands a StopPort. A field the
 * spread of old dropped (a non-enumerable home or env) is kept, so the check and start() see one value.
 */
export function inProcessOverrides(overrides: Partial<StartDeps>): Partial<StartDeps> {
  const out = ownDataCopy(overrides, 'overrides');
  if (typeof out.env === 'object' && out.env !== null) out.env = ownDataCopy(out.env, 'env');
  if (out.stopping === undefined) out.stopping = IN_PROCESS_STOP;
  return out as Partial<StartDeps>;
}

/** The env variables main.ts turns into harness roots or the data dir; each must stay inside a fixture. */
const ENV_ROOT_VARS: readonly string[] = ['ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME'];

/**
 * Throws unless `overrides` carries its own `env`, and every root variable in it (case-insensitively,
 * as main.ts reads them) points inside an orchestra-test-* fixture. Without an own env main.ts falls
 * back to process.env, where CLAUDE_CONFIG_DIR (the real config dir on this machine) and a real
 * ORCHESTRA_HOME would become a harness root and the data dir — the half of the residual home alone
 * does not close (zen 7.7, F1/F5).
 */
export function assertFakeEnv(overrides: Partial<StartDeps>): void {
  if (!Object.hasOwn(overrides, 'env') || typeof overrides.env !== 'object' || overrides.env === null) {
    throw new Error('test helper: startInProcess needs its own env; without one main.ts reads process.env and the real config dir becomes a harness root');
  }
  const env = overrides.env as Record<string, string | undefined>;
  const rootVars = new Set(ENV_ROOT_VARS.map((n) => n.toLowerCase()));
  // Every own key, enumerable or not, as resolveEnv's own-field reads see them.
  for (const key of Object.getOwnPropertyNames(env)) {
    if (!rootVars.has(key.toLowerCase())) continue;
    const d = Object.getOwnPropertyDescriptor(env, key)!;
    if (!('value' in d)) throw new Error(`test helper: env.${key} is an accessor`);
    const v = d.value as unknown;
    if (typeof v === 'string' && v.trim() !== '') assertFakeHome(v, `env.${key}`);
  }
}

/**
 * main.ts start() in this process: refuses unless `overrides.home` and every env root var are fake
 * (assertFakeHome). The copy start() gets is made first and the checks judge that very copy.
 */
export async function startInProcess(f: Features, fence: FenceStatus, ports: BootPorts, overrides: Partial<StartDeps>): Promise<StartOutcome> {
  const given = inProcessOverrides(overrides);
  assertFakeHome(Object.hasOwn(given, 'home') ? given.home : undefined, 'home');
  assertFakeEnv(given);
  return start(f, fence, ports, given);
}

export type InProcessWorking = Omit<WorkingContext, 'stopping'> & { stopping?: StopPort };

/** working.ts runWorking() in this process: refuses unless both `home` and `userHome` are fake homes. */
export async function runWorkingInProcess(ctx: InProcessWorking): Promise<WorkingOutcome> {
  const given = ownDataCopy(ctx, 'ctx') as InProcessWorking;
  assertFakeHome(given.home, 'home');
  assertFakeHome(given.userHome, 'userHome');
  return runWorking({ ...given, stopping: given.stopping ?? IN_PROCESS_STOP });
}

export type Captured = { port: ConsolePort; out: string[]; err: string[]; all(): string[] };

export function captureConsole(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    port: { out: (l) => out.push(l), err: (l) => err.push(l) },
    out,
    err,
    all: () => [...out, ...err],
  };
}
