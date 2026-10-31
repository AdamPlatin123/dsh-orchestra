import { homedir } from 'node:os';
import type { BootPorts } from './boot.ts';
import type { HarnessRoot } from './fs/harness-roots.ts';
import type { RealpathFn } from './fs/paths.ts';
import type { SpawnBackend } from './os/spawn.ts';
import type { DataDirCheck } from './runtime/data-dir.ts';
import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import type { Integrity } from './runtime/integrity.ts';
import type { Timers } from './runtime/lock.ts';
import type { ConsolePort } from './runtime/log.ts';
import type { StartupPlan } from './runtime/startup.ts';
import type { Profile, ProfileRefusal } from './runtime/test-profile.ts';
import type { WorkingOutcome } from './runtime/working.ts';
import { computeHarnessRoots, launcherRootFs } from './fs/harness-roots.ts';
import { nativeRealpath } from './fs/paths.ts';
import { PidLog, SpawnGate, resolveSystemRoot } from './os/spawn.ts';
import { checkDataDir } from './runtime/data-dir.ts';
import { resolveEnv } from './runtime/env.ts';
import { describeIntegrity, probeIntegrity } from './runtime/integrity.ts';
import { Log } from './runtime/log.ts';
import { EXIT, describeNote, planExit, planMessage, planStartup } from './runtime/startup.ts';
import { describeRefusal, parseProfileArgs, testProfileRoots } from './runtime/test-profile.ts';

// start(): arguments -> integrity -> (elevated or missing features: exit before reading anything)
// -> data dir check -> planStartup -> (working only) lock, data dir, heartbeat. Everything this
// module imports statically only reads, or spawns whoami through the gate; the working wiring is
// imported once the plan says working (plan §6 invariant 10).

export type StartDeps = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home: the real profile's harness roots derive from it; both profiles keep ORCHESTRA_HOME from containing it. */
  home: string;
  pid: number;
  tty(): { stdin: boolean; stdout: boolean };
  console: ConsolePort;
  now(): number;
  /** Arranges for `stop` to run on Ctrl+C and friends; returns the undo. */
  onStopSignal(stop: () => void): () => void;
  realpath: RealpathFn;
  spawnBackend?: SpawnBackend;
  timers?: Timers;
  heartbeatMs?: number;
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

export function defaultStartDeps(): StartDeps {
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
    now: Date.now,
    onStopSignal: installStopSignals,
    realpath: nativeRealpath,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? `${(e as { code?: unknown }).code ?? e.name}: ${e.message}` : String(e);
}

async function measureIntegrity(d: StartDeps, pidLog: PidLog): Promise<Integrity> {
  const sys = resolveSystemRoot(d.env, d.realpath);
  if (!sys.ok) return { level: 'unknown', reason: 'system-root-unavailable', detail: sys.reason };
  // Before the plan exists the gate allows whoami and nothing else.
  const gate = new SpawnGate({ systemRoot: sys, rules: ['whoami'], backend: d.spawnBackend, record: (e) => pidLog.record(e), realpath: d.realpath, now: d.now });
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
      if (d.env.ORCHESTRA_HOME !== undefined) log.info('env-ignored', { name: 'ORCHESTRA_HOME', why: 'test profile' });
      roots = testProfileRoots(profile, d.realpath);
    } else {
      const env = resolveEnv({ home: d.home, env: d.env });
      home = env.orchestraHome;
      roots = computeHarnessRoots(env, launcherRootFs(env));
    }
  } catch (e) {
    const fallbackHome = profile.kind === 'test' ? profile.orchestraHome : '';
    return { home: fallbackHome, roots: [], dataDir: { ok: false, reason: 'roots-unavailable', detail: errText(e) } };
  }
  const testDir = profile.kind === 'test' ? { testDir: profile.testDir } : {};
  return { home, roots, dataDir: checkDataDir({ orchestraHome: home, userHome: d.home, roots, realpath: d.realpath, ...testDir }) };
}

export async function start(f: Features, fence: FenceStatus, _ports: BootPorts, overrides: Partial<StartDeps> = {}): Promise<StartOutcome> {
  const d: StartDeps = { ...defaultStartDeps(), ...overrides };
  const log = new Log({ now: d.now });

  const parsed = parseProfileArgs(d.argv, { env: d.env, realpath: d.realpath });
  if (!parsed.ok) {
    d.console.err(`orchestrad: refusing to start: ${describeRefusal(parsed.refusal)}`);
    return { mode: 'refused', code: EXIT.badArgs, refusal: parsed.refusal };
  }
  const profile = parsed.profile;
  if (profile.kind === 'test') d.console.out('TEST PROFILE');

  const pidLog = new PidLog();
  const integrity = await measureIntegrity(d, pidLog);
  log.info('integrity', { level: integrity.level, detail: describeIntegrity(integrity) });
  // Without the resolve hook nothing past this point may rely on the import fence.
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
    roots: located.roots,
    notes: plan.notes,
    log,
    pidLog,
    console: d.console,
    pid: d.pid,
    now: d.now,
    tty: d.tty,
    onStopSignal: d.onStopSignal,
    timers: d.timers,
    heartbeatMs: d.heartbeatMs,
  });
}
