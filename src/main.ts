import { homedir } from 'node:os';
import type { BootPorts } from './boot.ts';
import type { HarnessRoot } from './fs/harness-roots.ts';
import type { ReadGateSpec, WriteFenceSpec } from './fs/node-io.ts';
import type { RealpathFn } from './fs/paths.ts';
import type { ReadGate } from './fs/read-gate.ts';
import type { WriteFence } from './fs/write-fence.ts';
import type { SpawnGateSpec } from './os/node-proc.ts';
import type { SpawnGate } from './os/spawn.ts';
import type { DbOpener, DbOpenerSpec } from './store/db.ts';
import type { ClockHub } from './runtime/clock.ts';
import type { DataDirCheck } from './runtime/data-dir.ts';
import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import type { Integrity } from './runtime/integrity.ts';
import type { ConsolePort } from './runtime/log.ts';
import type { StartupPlan } from './runtime/startup.ts';
import type { InTestRealProfile, Profile, ProfileRefusal } from './runtime/test-profile.ts';
import type { StopPort, WorkingOutcome } from './runtime/working.ts';
import { computeHarnessRoots, launcherRootFs } from './fs/harness-roots.ts';
import { PidLog, resolveSystemRoot } from './os/spawn.ts';
import { checkDataDir } from './runtime/data-dir.ts';
import { resolveEnv } from './runtime/env.ts';
import { describeIntegrity, probeIntegrity } from './runtime/integrity.ts';
import { Log } from './runtime/log.ts';
import { envGet, ownFields } from './runtime/own.ts';
import { EXIT, describeNote, planExit, planMessage, planStartup } from './runtime/startup.ts';
import { describeRefusal, parseProfileArgs, testProfileRoots } from './runtime/test-profile.ts';

// start(): arguments (the real profile refuses under the test runner, read from this process's own
// environment as well as the injected one) -> integrity -> (elevated or
// missing features: exit before reading anything) -> data dir check -> planStartup -> (working only)
// lock, data dir, daemon.json. Everything this module imports statically only reads, or spawns
// whoami through the gate; the working wiring is imported once the plan says working (plan §6
// invariant 10). The file system and child processes reach this module only as the gate factories
// and the realpath port boot minted (BootPorts); main.ts and working.ts are their only holders.

export type StartDeps = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home: the real profile's harness roots derive from it; both profiles keep ORCHESTRA_HOME from containing it. */
  home: string;
  pid: number;
  tty(): { stdin: boolean; stdout: boolean };
  console: ConsolePort;
  /** The clock hub boot made (BootPorts); every time read and timer below start() goes through Clocks it mints. */
  clock: ClockHub;
  /** Signals and the end of the process; tests inject one that releases the lock instead of exiting. */
  stopping: StopPort;
  /** From BootPorts (src/fs/node-io.ts); tests may count or fake it. */
  realpath: RealpathFn;
  /** The gate factories boot minted (BootPorts); a test may hand its own, around a spy backend say. */
  makeReadGate(spec: ReadGateSpec): ReadGate;
  makeWriteFence(spec: WriteFenceSpec): Promise<WriteFence>;
  makeSpawnGate(spec: SpawnGateSpec): SpawnGate;
  /** The SQLite opener factory boot minted (BootPorts, src/store/node-sqlite.ts); only working.ts calls it. */
  makeDbOpener(spec: DbOpenerSpec): Promise<DbOpener>;
  /**
   * The only way a real profile runs under the test runner: in-process tests that pin `home` to a
   * fake home inside an orchestra-test-* dir in the temp dir (checked by parseProfileArgs).
   */
  inTestRealProfile?: InTestRealProfile;
};

export type StartOutcome =
  | { mode: 'refused'; code: typeof EXIT.badArgs; refusal: ProfileRefusal }
  | { mode: 'exit'; code: typeof EXIT.elevated | typeof EXIT.missingFeatures; plan: StartupPlan }
  | { mode: 'ui-only'; code: typeof EXIT.uiOnly; plan: StartupPlan; log: Log }
  | WorkingOutcome;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

function installStopSignals(stop: () => void): () => void {
  const handler = () => stop();
  for (const s of STOP_SIGNALS) process.on(s, handler);
  return () => {
    for (const s of STOP_SIGNALS) process.off(s, handler);
  };
}

/**
 * Stopping ends the process, whoever asked (a signal, or anything that emits one): the lock is never
 * released by hand, the kernel frees the pipe once the process is gone, so no code of this process
 * runs without it. It ends through boot's endProcess (BootPorts): the console is flushed first, while
 * the lock is still held, for a bounded time, and the code is the one handed over, whatever an 'exit'
 * listener or a stalled console write would make of it.
 */
function processStopping(endProcess: (code: number) => void): StopPort {
  return {
    onSignal: installStopSignals,
    end: () => new Promise<void>(() => {
      endProcess(EXIT.ok);
    }),
  };
}

// The ports main.ts uses; the network port waits for step 15, which hands it to src/net/dsh-connect.ts.
const FN_PORT_KEYS = ['realpath', 'makeReadGate', 'makeWriteFence', 'makeSpawnGate', 'makeDbOpener', 'endProcess'] as const;
const PORT_KEYS = [...FN_PORT_KEYS, 'clock'] as const;

/** BootPorts as own properties only, each one required: a port the caller left out is never looked up on Object.prototype. */
function ownPorts(given: BootPorts): Pick<BootPorts, (typeof PORT_KEYS)[number]> {
  const p = ownFields(given, PORT_KEYS);
  for (const k of FN_PORT_KEYS) if (typeof p[k] !== 'function') throw new Error(`start: BootPorts.${k} is missing`);
  if (typeof p.clock !== 'object' || p.clock === null || typeof p.clock.port !== 'function') throw new Error('start: BootPorts.clock is missing');
  return Object.freeze(p) as Pick<BootPorts, (typeof PORT_KEYS)[number]>;
}

export function defaultStartDeps(ports: Pick<BootPorts, (typeof PORT_KEYS)[number]>): StartDeps {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    home: homedir(),
    pid: process.pid,
    tty: () => ({ stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true }),
    console: {
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (line) => {
        process.stderr.write(`${line}\n`);
      },
    },
    clock: ports.clock,
    stopping: processStopping(ports.endProcess),
    realpath: ports.realpath,
    makeReadGate: ports.makeReadGate,
    makeWriteFence: ports.makeWriteFence,
    makeSpawnGate: ports.makeSpawnGate,
    makeDbOpener: ports.makeDbOpener,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? `${(e as { code?: unknown }).code ?? e.name}: ${e.message}` : String(e);
}

async function measureIntegrity(d: StartDeps, pidLog: PidLog): Promise<Integrity> {
  const sys = resolveSystemRoot(d.env, d.realpath);
  if (!sys.ok) return { level: 'unknown', reason: 'system-root-unavailable', detail: sys.reason };
  // Before the plan exists the gate allows whoami and nothing else.
  const gate = d.makeSpawnGate({ systemRoot: sys, rules: ['whoami'], record: (e) => pidLog.record(e), realpath: d.realpath, clock: d.clock });
  return probeIntegrity(gate, sys.path);
}

type Located = { home: string; roots: HarnessRoot[]; dataDir: DataDirCheck };

/** ORCHESTRA_HOME and the harness roots of the profile, and the data dir check over them. */
function locate(profile: Profile, d: StartDeps, log: Log): Located {
  let home: string;
  let roots: HarnessRoot[];
  try {
    if (profile.kind === 'test') {
      home = profile.orchestraHome;
      if (envGet(d.env, 'ORCHESTRA_HOME') !== undefined) log.info('env-ignored', { name: 'ORCHESTRA_HOME', why: 'test profile' });
      roots = testProfileRoots(profile, d.realpath);
    } else {
      const env = resolveEnv({ home: d.home, env: d.env });
      home = env.orchestraHome;
      roots = computeHarnessRoots(env, launcherRootFs(env, { makeReadGate: d.makeReadGate, realpath: d.realpath }));
    }
  } catch (e) {
    const fallbackHome = profile.kind === 'test' ? profile.orchestraHome : '';
    return { home: fallbackHome, roots: [], dataDir: { ok: false, reason: 'roots-unavailable', detail: errText(e) } };
  }
  const testDir = profile.kind === 'test' ? { testDir: profile.testDir } : {};
  return { home, roots, dataDir: checkDataDir({ orchestraHome: home, userHome: d.home, roots, realpath: d.realpath, ...testDir }) };
}

export async function start(f: Features, fence: FenceStatus, given: BootPorts, overrides: Partial<StartDeps> = {}): Promise<StartOutcome> {
  const defaults = defaultStartDeps(ownPorts(given));
  // No prototype: a dependency nobody set (inTestRealProfile, say) reads undefined, never
  // Object.prototype's. Object.assign copies the overrides' own fields only.
  const d = Object.assign(Object.create(null) as StartDeps, defaults, overrides);
  const log = new Log({ clock: d.clock.port(null) });

  // defaults.env is this process's own environment, which no override replaces.
  const inTest = d.inTestRealProfile !== undefined ? { inTestRealProfile: d.inTestRealProfile } : {};
  const parsed = parseProfileArgs(d.argv, { env: d.env, processEnv: defaults.env, home: d.home, realpath: d.realpath, ...inTest });
  if (!parsed.ok) {
    d.console.err(`orchestrad: refusing to start: ${describeRefusal(parsed.refusal)}`);
    return { mode: 'refused', code: EXIT.badArgs, refusal: parsed.refusal };
  }
  const profile = parsed.profile;
  if (profile.kind === 'test') d.console.out('TEST PROFILE');

  const pidLog = new PidLog();
  const integrity = await measureIntegrity(d, pidLog);
  log.info('integrity', { level: integrity.level, detail: describeIntegrity(integrity) });
  // boot refuses without the resolve hook; a direct caller without one gets the missing-features exit.
  const features: Features = { ...f, registerHooks: f.registerHooks && fence.resolveHook };
  const exit = planExit(features, integrity);
  if (exit !== null) {
    log.info('plan', { mode: exit.mode, notes: exit.notes.map((n) => n.id) });
    d.console.err(planMessage(exit)!);
    return { mode: 'exit', code: exit.code, plan: exit };
  }
  const located = locate(profile, d, log);
  const plan = planStartup(features, integrity, located.dataDir);
  log.info('plan', { mode: plan.mode, notes: plan.notes.map((n) => n.id) });

  if (plan.mode === 'exit') {
    d.console.err(planMessage(plan)!);
    return { mode: 'exit', code: plan.code, plan };
  }
  if (plan.mode === 'ui-only') {
    for (const n of plan.notes) d.console.err(`orchestrad: note: ${describeNote(n)}`);
    d.console.err(planMessage(plan)!);
    return { mode: 'ui-only', code: EXIT.uiOnly, plan, log };
  }
  const { runWorking } = await import('./runtime/working.ts');
  return runWorking({
    profile,
    home: located.home,
    userHome: d.home,
    realpath: d.realpath,
    makeReadGate: d.makeReadGate,
    makeWriteFence: d.makeWriteFence,
    makeDbOpener: d.makeDbOpener,
    env: d.env,
    roots: located.roots,
    notes: plan.notes,
    log,
    pidLog,
    console: d.console,
    pid: d.pid,
    clock: d.clock,
    tty: d.tty,
    stopping: d.stopping,
  });
}
