import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGateSpec, WriteFenceSpec } from '../fs/node-io.ts';
import type { RealpathFn } from '../fs/paths.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import type { WriteFence } from '../fs/write-fence.ts';
import type { SpawnGateSpec } from '../os/node-proc.ts';
import type { PidLog, SpawnGate } from '../os/spawn.ts';
import type { JobOutcome, JobTracker, ProcguardOffWhy, Resident } from '../os/procguard.ts';
import type { Approvals } from '../owned/approvals.ts';
import type { ClaudeOwned } from '../owned/claude-owned.ts';
import type { CodexOwned, OwnedPool } from '../owned/codex-owned.ts';
import type { RestoredOwned } from '../owned/restored.ts';
import type { OwnedSeat } from '../sources/tower.ts';
import type { OwnedRegistry } from '../owned/registry.ts';
import type { Redact } from '../owned/text.ts';
import type { PathJudge } from '../owned/codex-session.ts';
import type { Desk } from '../route/desk.ts';
import type { CwdPolicySpec } from '../os/cwd.ts';
import type { ProvenSystemRoot } from '../os/spawn.ts';
import type { DbOpener, DbOpenerSpec } from '../store/db.ts';
import type { ChainBreak } from '../store/journal.ts';
import type { Store } from '../store/store.ts';
import type { ClockHub } from './clock.ts';
import type { DataDirInput } from './data-dir.ts';
import type { DaemonInfo, HeldLock } from './lock.ts';
import type { ConsolePort, Log } from './log.ts';
import type { StartupNote } from './startup.ts';
import type { StdinEndWhy, StdinKind } from './stdin-end.ts';
import type { PairingOutput, Profile } from './test-profile.ts';
import { rootDenyList } from '../fs/harness-roots.ts';
import { pathKey } from '../fs/paths.ts';
import { makeRedactor } from '../store/redact.ts';
import { openStore } from '../store/store.ts';
import { oneShot } from './clock.ts';
import { checkDataDir, describeDataDir, prepareDataDir } from './data-dir.ts';
import { acquireLock, encodeDaemonInfo, heldMessage, lockPipeName, parseDaemonInfo } from './lock.ts';
import { EXIT, describeNote } from './startup.ts';
import { TestRoots, decidePairingOutput, testReadDirs } from './test-profile.ts';

const win = path.win32;

// Working-mode wiring, the composition root for the gates: it makes them with the factories boot
// minted (src/fs/node-io.ts, src/store/node-sqlite.ts, handed down through main.ts), so they reach the
// real file system and SQLite; a gate made any other way reaches nothing. Only main.ts imports this
// module (static scan), and only after planStartup() says working, so a ui-only process never loads
// the write fence, the lock, node:sqlite or anything that opens storage.
//
// The store opens after the lock and the data dir: database, journal, reconciliation (step 3). A
// broken journal chain is found only here, with the lock held, so it is no ui-only plan: the outcome
// journal-chain carries the ui-only exit code (22), main.ts prints why and the process ends with the
// lock, never released by hand while the process lives on (step 2b; D-17 either way).

/** What asked a working orchestrad to stop: a signal (Ctrl+C and friends), or its stdin pipe ending (src/runtime/stdin-end.ts). */
export type StopWhy = 'signal' | StdinEndWhy;

/** How a working orchestrad stops. */
export type StopPort = {
  /**
   * Arranges for `stop` to run on Ctrl+C and friends, and, when stdin is a pipe, on its end (the program
   * that started orchestrad is gone or closed it); returns the undo. Each way runs the same stop.
   */
  onSignal(stop: (why?: StopWhy, detail?: string | null) => void): () => void;
  /** What stdin is (main.ts: process.stdin); absent: not known, said as nothing. Only 'pipe' ends orchestrad when it ends. */
  stdin?(): StdinKind;
  /**
   * Ends this orchestrad: the only way its lock is given up, so no process keeps running without
   * it while a second instance takes over. stop() calls it last, after the log and pid sinks are
   * detached. main.ts exits the process and leaves the pipe to the kernel, so no code of the
   * process runs once the lock is gone; an in-process caller (a test) releases the lock instead.
   */
  end(lock: HeldLock): Promise<void>;
};

export type WorkingContext = {
  profile: Profile;
  /** ORCHESTRA_HOME as checkDataDir accepted it; checked once more here before anything is built. */
  home: string;
  userHome: string;
  realpath: RealpathFn;
  /** The factories boot minted (BootPorts, via main.ts). */
  makeReadGate(spec: ReadGateSpec): ReadGate;
  makeWriteFence(spec: WriteFenceSpec): Promise<WriteFence>;
  makeDbOpener(spec: DbOpenerSpec): Promise<DbOpener>;
  /** The spawn gate factory (BootPorts, via main.ts): only the owned Codex sessions use it here. */
  makeSpawnGate?(spec: SpawnGateSpec): SpawnGate;
  /** This orchestrad's own environment (main.ts's StartDeps.env): the redactor replaces its values in every source string (r4 §6.1 #1). */
  env: Readonly<Record<string, string | undefined>>;
  roots: readonly HarnessRoot[];
  notes: readonly StartupNote[];
  log: Log;
  pidLog: PidLog;
  console: ConsolePort;
  pid: number;
  /** The clock hub boot made (BootPorts, via main.ts). */
  clock: ClockHub;
  tty(): { stdin: boolean; stdout: boolean };
  stopping: StopPort;
  /** --peek-port: serve the thin slice's peek page (src/server/http.ts) on this port. Absent: no HTTP at all. */
  peekPort?: number;
  /** --owned: owned Codex sessions over codex app-server and owned Claude sessions over the 0.2 host (orchestra app plan §2). Absent: off. */
  owned?: true;
  /**
   * With --owned: build procguard and start every owned session's child in a Job of its own (r4 D4), with
   * the brake; procguard off for any reason keeps the owned sessions off. main.ts always asks; absent (the
   * in-process tests), the sessions run without Jobs and the page says the brake was not asked for.
   */
  procguard?: true;
};

/**
 * The gateway the owned Claude sessions' host talks to (ANTHROPIC_BASE_URL): the same local magpie as
 * the Codex sessions, without the /v1 the Messages API path adds itself. With --owned it is on by default,
 * as for Codex; the 0.2 design's --claude-gateway flag is not taken (orchestra app step 4: one gateway,
 * the one the plan measured).
 */
export const CLAUDE_GATEWAY_URL = 'http://127.0.0.1:3425';

/** The local magpie gateway every owned session's model calls go to (orchestra app plan, measured 2026-11-02). */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';

/**
 * The dispatch desk's router model (orchestra app plan §3): magpie's chat completions, the one address
 * the daemon ever POSTs to (src/net/magpie.ts takes nothing but http://127.0.0.1). No key; only the
 * person's sentence and a fixed system prompt go out. Past ROUTER_TIMEOUT_MS the card shows the rules alone.
 */
export const MAGPIE_CHAT_URL = 'http://127.0.0.1:3425/v1/chat/completions';
export const ROUTER_TIMEOUT_MS = 20_000;
/** How long a stopping orchestrad waits for its owned Claude hosts to close: the stop order's 3 s + 2 s (src/os/owned-proc.ts HOST_STOP_MS) and a margin. */
export const OWNED_STOP_WAIT_MS = 6_000;
/**
 * Then, before the resident procguard is let go, how long a stopping orchestrad waits for the owned
 * children still closing (a Codex wrapper killed a moment ago) and for the Job checks their closes
 * started, so each lands in the log (owned-tree): a kill-job waits 3 s at most, and a margin.
 */
export const OWNED_TREE_WAIT_MS = 5_000;
/** The most of a reply read from the router model (JSON with its reasoning text). */
export const ROUTER_REPLY_MAX_BYTES = 256 * 1024;

/**
 * Whether owned Codex sessions run, and if not why (T1: a reason, never a bare "no"): not asked for
 * (no --owned), codex.exe not found or not resolvable (CodexExe's reasons), no spawn gate factory, or
 * the private CODEX_HOME, the work root or the gate could not be set up.
 */
export type OwnedCodexStatus =
  | { on: true; exe: string; codexHome: string; workRoot: string; model: string; gateway: string; restored: number; jobs: boolean }
  | {
    on: false;
    why: 'not-asked' | 'codex-appdata-unset' | 'codex-appdata-bad-path' | 'codex-missing' | 'codex-reparsed' | 'no-spawn-gate' | 'setup-failed' | ProcguardDownWhy;
    detail: string | null;
  };

/**
 * Whether owned Claude sessions run, and if not why (T1): not asked for, the host's node.exe, host.mjs or
 * the SDK's claude.exe not found or behind a link (claude-site.ts), the pins not matching (host-tampered:
 * a host file or the SDK changed since they were pinned), no spawn gate factory, or the setup failed.
 */
export type OwnedClaudeStatus =
  | { on: true; node: string; entry: string; claudeExe: string; configRoot: string; model: string; gateway: string; restored: number; jobs: boolean }
  | {
    on: false;
    why: 'not-asked' | 'claude-node-missing' | 'claude-host-missing' | 'claude-exe-missing' | 'claude-reparsed' | 'host-tampered' | 'no-spawn-gate' | 'setup-failed' | ProcguardDownWhy;
    detail: string | null;
  };

/** procguard asked for and off: the owned sessions are off with procguard's own reason (r4 D4). */
export type ProcguardDownWhy = Exclude<ProcguardOffWhy, 'not-asked'>;

/**
 * procguard for the owned sessions (r4 D4; src/os/procguard.ts): on, with the exe it built at this
 * startup and pinned in memory, so every owned session's child starts in a Job of its own and has a
 * brake; or off and why (T1): not asked, a source that does not match its pin, a build that failed, a
 * resident that did not start, a setup that failed. Asked for and off for any reason, the owned sessions
 * are off too (phase 4 review: before, they ran without Jobs, which r4 D4 does not allow).
 */
export type ProcguardStatus =
  | { on: true; exe: string; dir: string; sha256: string; built: boolean }
  | { on: false; why: ProcguardOffWhy; detail: string | null };

export type WorkingOutcome =
  | { mode: 'lock-held'; code: typeof EXIT.lockHeld; pipe: string; holder: DaemonInfo | null }
  | { mode: 'start-failed'; code: typeof EXIT.startFailed; stage: 'gates' | 'lock' | 'data-dir' | 'store'; detail: string }
  | {
    mode: 'journal-chain';
    code: typeof EXIT.uiOnly;
    break: ChainBreak;
    /** Ends this orchestrad through ctx.stopping.end; main.ts never calls it, the process exits with the code. */
    stop(): Promise<void>;
  }
  | {
    mode: 'working';
    profile: Profile['kind'];
    home: string;
    pipe: string;
    pairing: PairingOutput;
    testRoots: TestRoots | null;
    /** The store this orchestrad opened and reconciled; stop() closes it. */
    store: Store;
    /** Owned Codex sessions: on, or why not (also in the log and on the console). */
    ownedCodex: OwnedCodexStatus;
    /** Owned Claude sessions: on, or why not (also in the log and on the console). */
    ownedClaude: OwnedClaudeStatus;
    /** procguard: on (the owned sessions in Jobs, with a brake), or why not (also in the log and on the console). */
    procguard: ProcguardStatus;
    /** Ends this orchestrad through ctx.stopping.end (in main.ts: the process exits). */
    stop(): Promise<void>;
    /** Settles once stop() has given up the lock, whoever called it (in main.ts: never, the process is gone). */
    stopped: Promise<void>;
  };

function describe(e: unknown): string {
  if (e instanceof Error) return `${(e as { code?: unknown }).code ?? e.name}: ${e.message}`;
  return String(e);
}

/** An 8-digit one-time pairing code; it lives in memory only (r4 §10.11 #1). */
function pairingCode(): string {
  return crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
}

export async function runWorking(ctx: WorkingContext): Promise<WorkingOutcome> {
  const { log } = ctx;
  const testDir = ctx.profile.kind === 'test' ? ctx.profile.testDir : undefined;
  const dirInput: DataDirInput = {
    orchestraHome: ctx.home, userHome: ctx.userHome, roots: ctx.roots, realpath: ctx.realpath, ...(testDir !== undefined ? { testDir } : {}),
  };
  // Fail closed whoever called: the caller's check may be stale, or never have run.
  const checked = checkDataDir(dirInput);
  if (!checked.ok) {
    const detail = describeDataDir(checked);
    log.error('data-dir-refused', { reason: checked.reason });
    ctx.console.err(`orchestrad: refusing the data dir: ${detail}`);
    return { mode: 'start-failed', code: EXIT.startFailed, stage: 'data-dir', detail };
  }
  const home = checked.home;
  let fence: WriteFence;
  let gate: ReadGate;
  try {
    fence = await ctx.makeWriteFence({
      orchestraHome: home, harnessRoots: rootDenyList(ctx.roots), ...(testDir !== undefined ? { confine: testDir } : {}),
    });
    gate = ctx.makeReadGate({
      roots: ctx.roots,
      orchestraHome: home,
      ...(ctx.profile.kind === 'test' ? { testDirs: testReadDirs(ctx.profile) } : {}),
    });
  } catch (e) {
    log.error('gates-failed', { error: e });
    ctx.console.err(`orchestrad: cannot set up the write fence and read gate: ${describe(e)}`);
    return { mode: 'start-failed', code: EXIT.startFailed, stage: 'gates', detail: describe(e) };
  }
  const run = win.join(home, 'run');
  const daemonJson = win.join(run, 'daemon.json');

  const pipe = lockPipeName(fence.homeReal);
  const got = await acquireLock(pipe);
  if (!got.ok) {
    if (got.reason === 'listen-failed') {
      log.error('lock-failed', { pipe, detail: got.detail });
      ctx.console.err(`orchestrad: cannot open the lock pipe ${pipe} (${got.detail})`);
      return { mode: 'start-failed', code: EXIT.startFailed, stage: 'lock', detail: got.detail };
    }
    let holder: DaemonInfo | null = null;
    try {
      holder = parseDaemonInfo(gate.readFile(daemonJson).toString('utf8'));
    } catch {
      // No readable daemon.json: the hint says so.
    }
    log.warn('lock-held', { pipe, holderPid: holder?.pid ?? null });
    ctx.console.err(heldMessage(home, holder));
    return { mode: 'lock-held', code: EXIT.lockHeld, pipe, holder };
  }
  const lock = got.lock;

  try {
    const prepared = prepareDataDir(fence, home);
    // Now that the dirs exist, the same check must still hold and still name the same place.
    const again = checkDataDir(dirInput);
    if (!again.ok) throw new Error(`data dir changed while it was prepared: ${describeDataDir(again)}`);
    if (pathKey(again.homeReal) !== pathKey(fence.homeReal)) throw new Error(`data dir moved while it was prepared: ${fence.homeReal} -> ${again.homeReal}`);
    log.info('data-dir', { home, created: prepared.created.length, tmpEntriesRemoved: prepared.tmpEntriesRemoved });
  } catch (e) {
    await lock.release();
    log.error('data-dir-failed', { error: e });
    ctx.console.err(`orchestrad: cannot prepare the data dir ${home}: ${describe(e)}`);
    return { mode: 'start-failed', code: EXIT.startFailed, stage: 'data-dir', detail: describe(e) };
  }
  log.attach((line) => fence.append(win.join(run, 'orchestrad.log'), line));
  ctx.pidLog.attach((line) => fence.append(win.join(run, 'pids.jsonl'), line), (failures, error) => {
    // The line stays in memory (PidLog keeps it); one warning, then the count says the rest.
    if (failures === 1) log.warn('pid-sink-failed', { error });
  });

  // Written once, now that the lock is held; nothing rewrites it while this process runs.
  const bootId = crypto.randomUUID();
  const startedAt = new Date(ctx.clock.port(null).nowWall()).toISOString();
  try {
    fence.writeAtomic(daemonJson, encodeDaemonInfo({ v: 1, pid: ctx.pid, profile: ctx.profile.kind, bootId, startedAt }));
  } catch (e) {
    // Only a second instance's hint reads it: a failed write costs that hint, not the start.
    log.error('daemon-json-failed', { error: e });
  }

  let store: Store;
  try {
    const opener = await ctx.makeDbOpener({ fence });
    const opened = openStore({
      openDb: (file) => opener.open(file), writer: fence, reader: gate, home, bootId, clock: ctx.clock.port(null), redactor: makeRedactor({ env: ctx.env }),
    });
    if (!opened.ok) {
      const b = opened.break;
      log.error('journal-chain', { line: b.line, why: b.why });
      ctx.console.err(`orchestrad: the journal is broken at line ${b.line} (${b.why}: ${b.detail}); not working, exiting with the ui-only code ${EXIT.uiOnly}`);
      let ended: Promise<void> | null = null;
      const stopChain = (): Promise<void> => (ended ??= (async () => {
        log.detach();
        ctx.pidLog.detach();
        await ctx.stopping.end(lock);
      })());
      return { mode: 'journal-chain', code: EXIT.uiOnly, break: b, stop: stopChain };
    }
    store = opened.store;
    log.info('store', { jseq: store.tail.jseq, cutBytes: opened.report.cutBytes, appliedBatches: opened.report.appliedBatches, orphansClosed: opened.report.orphansClosed });
  } catch (e) {
    await lock.release();
    log.error('store-failed', { error: e });
    ctx.console.err(`orchestrad: cannot open the store in ${home}: ${describe(e)}`);
    return { mode: 'start-failed', code: EXIT.startFailed, stage: 'store', detail: describe(e) };
  }

  const testRoots = ctx.profile.kind === 'test' ? new TestRoots(ctx.profile.rootPids) : null;
  if (testRoots !== null && ctx.profile.kind === 'test' && ctx.profile.rootPids.length > 0) {
    // Resolving pid -> createTime needs procguard (step 6); until then no brake can use these.
    log.info('test-roots-unresolved', { pids: ctx.profile.rootPids });
  }
  for (const n of ctx.notes) {
    log.warn('startup-note', { note: n.id, effect: n.effect });
    ctx.console.out(`orchestrad: note: ${describeNote(n)}`);
  }

  // The test profile never looks at the console: its harness reads stdout, which is a pipe.
  const pairing = decidePairingOutput(ctx.profile, ctx.profile.kind === 'test' ? { stdin: false, stdout: false } : ctx.tty());
  let code: string | null = null;
  if (pairing.print === 'none') {
    log.warn('pairing-disabled', { why: pairing.reason });
    ctx.console.out('orchestrad: pairing is off: stdin and stdout are not both an interactive console');
  } else {
    code = pairingCode();
    // Straight to the console, never through the log.
    ctx.console.out(`orchestrad: pairing code ${code}`);
    log.info('pairing-code-printed', { to: pairing.print });
  }

  // Owned Codex sessions, only when asked for (--owned): loaded here so that a start without it
  // resolves none of src/owned/.
  let codexOwned: CodexOwned | null = null;
  let claudeOwned: ClaudeOwned | null = null;
  let ownedCodex: OwnedCodexStatus = { on: false, why: 'not-asked', detail: null };
  let ownedClaude: OwnedClaudeStatus = { on: false, why: 'not-asked', detail: null };
  let procguard: ProcguardStatus = { on: false, why: 'not-asked', detail: null };
  /** The resident procguard (one per orchestrad): it ends a session's Job for the brake and checks it after an end. */
  let resident: Resident | null = null;
  /** procguard's part of the owned wiring, when it is on: the stop waits on its children and checks. */
  let jobsIn: Jobs | null = null;
  /** The running-session limit both harnesses share (slice design §2.4: 3 in all). */
  let pool: OwnedPool | null = null;
  /** Sessions an earlier orchestrad left for a harness that is off now: listed read only (src/owned/restored.ts). */
  const restoredOff: RestoredOwned[] = [];
  if (ctx.owned === true) {
    const { OWNED_POOL_MAX } = await import('../owned/codex-owned.ts');
    pool = Object.freeze({ max: OWNED_POOL_MAX, active: () => (codexOwned?.active() ?? 0) + (claudeOwned?.active() ?? 0) });
    const shared = await setUpOwnedShared(ctx, fence, gate, home, pool);
    const pg = shared.ok && ctx.procguard === true ? await setUpProcguard(ctx, fence, gate, shared.base, {
      // T1: a resident that went away is said at once, and the page says the brake can no longer report what it did.
      onGone: (detail) => {
        log.warn('procguard-resident-gone', { detail });
        ctx.console.out(`orchestrad: the resident procguard exited (${detail}): a brake still closes a session's Job through its wrapper, but what it stopped is unknown`);
      },
      onTree: (job, o) => log.info('owned-tree', o.ok ? { job, found: o.found, killed: o.killed, left: o.left } : { job, unknown: o.why }),
    }) : null;
    if (pg !== null) {
      procguard = pg.status;
      resident = pg.jobs?.resident ?? null;
      jobsIn = pg.jobs;
    }
    const jobs = pg?.jobs ?? null;
    // r4 D4: every owned child in a Job of its own, started through procguard. Asked for and off, for any
    // reason, procguard keeps every owned session off (T1, its reason said; phase 4 review).
    const pgDown = ctx.procguard === true && procguard.on === false && procguard.why !== 'not-asked' ? { on: false as const, why: procguard.why, detail: procguard.detail } : null;
    const set = !shared.ok ? { status: { on: false as const, why: shared.why, detail: shared.detail }, owned: null }
      : pgDown !== null ? { status: pgDown, owned: null } : await setUpOwnedCodex(ctx, fence, home, shared.base, jobs);
    ownedCodex = set.status;
    codexOwned = set.owned;
    const cl = !shared.ok ? { status: { on: false as const, why: shared.why, detail: shared.detail }, owned: null }
      : pgDown !== null ? { status: pgDown, owned: null } : await setUpOwnedClaude(ctx, fence, home, shared.base, jobs);
    ownedClaude = cl.status;
    claudeOwned = cl.owned;
    if (shared.ok && (codexOwned === null || claudeOwned === null)) {
      const { restoredOwned } = await import('../owned/restored.ts');
      if (codexOwned === null) {
        const { restoredSession } = await import('../owned/codex-owned.ts');
        restoredOff.push(restoredOwned('codex', shared.base.registry, shared.base.now, restoredSession));
      }
      if (claudeOwned === null) {
        const { restoredSession } = await import('../owned/claude-owned.ts');
        restoredOff.push(restoredOwned('claude', shared.base.registry, shared.base.now, restoredSession));
      }
      for (const r of restoredOff) {
        if (r.restored > 0) ctx.console.out(`orchestrad: ${r.restored} owned ${r.harness} session(s) from before the restart are listed read only (${r.harness} is off now; those that had not ended show as unknown)`);
      }
    }
    if (procguard.on) {
      // The sha256 too: the live scripts' own probe holds the exe to it before they start it.
      log.info('procguard', { on: true, exe: procguard.exe, built: procguard.built, sha256: procguard.sha256 });
      ctx.console.out(`orchestrad: procguard on (built ${procguard.exe}): each owned session runs in a Job of its own; the brake ends every process in that Job`);
    } else if (ctx.procguard === true) {
      log.warn('procguard', { on: false, why: procguard.why, detail: procguard.detail });
      ctx.console.out(`orchestrad: procguard is off: ${procguard.why}${procguard.detail === null ? '' : ` (${procguard.detail})`}; owned sessions are off (r4 D4: no owned session outside a Job of its own)`);
    }
    if (ownedClaude.on) {
      log.info('owned-claude', { on: true, node: ownedClaude.node, claudeExe: ownedClaude.claudeExe, model: ownedClaude.model });
      ctx.console.out(`orchestrad: owned Claude sessions on (model ${ownedClaude.model} through ${ownedClaude.gateway}; host ${ownedClaude.entry} under ${ownedClaude.node})`);
      if (ownedClaude.restored > 0) ctx.console.out(`orchestrad: ${ownedClaude.restored} owned Claude session(s) from before the restart are listed again (not resumed; those that had not ended show as unknown)`);
    } else {
      log.warn('owned-claude', { on: false, why: ownedClaude.why, detail: ownedClaude.detail });
      ctx.console.out(`orchestrad: owned Claude sessions are off: ${ownedClaude.why}${ownedClaude.detail === null ? '' : ` (${ownedClaude.detail})`}`);
    }
    if (ownedCodex.on) {
      log.info('owned-codex', { on: true, exe: ownedCodex.exe, model: ownedCodex.model });
      ctx.console.out(`orchestrad: owned Codex sessions on (model ${ownedCodex.model} through ${ownedCodex.gateway}; work dirs in ${ownedCodex.workRoot})`);
      if (ownedCodex.restored > 0) ctx.console.out(`orchestrad: ${ownedCodex.restored} owned session(s) from before the restart are listed again (not resumed; those that had not ended show as unknown)`);
    } else {
      log.warn('owned-codex', { on: false, why: ownedCodex.why, detail: ownedCodex.detail });
      ctx.console.out(`orchestrad: owned Codex sessions are off: ${ownedCodex.why}${ownedCodex.detail === null ? '' : ` (${ownedCodex.detail})`}`);
    }
  }

  // The thin slice's peek page, only when asked for: loaded here so that a start without --peek-port
  // resolves no HTTP module at all.
  let peek: { close(): Promise<void> } | null = null;
  if (ctx.peekPort !== undefined) {
    const redactor = makeRedactor({ env: ctx.env });
    try {
      const { startPeekServer } = await import('../server/http.ts');
      const { humanJournal } = await import('../server/owned.ts');
      const { ownedEnabled, registerOwnedHandlers } = await import('../server/owned-handlers.ts');
      const wall = ctx.clock.port(null);
      // The dispatch desk (orchestra app plan §3), with --owned only: the rules, then the router model on magpie.
      let desk: Desk | null = null;
      if (ctx.owned === true) {
        const { makeLoopbackPost } = await import('../net/magpie.ts');
        const { lastDispatchIn, makeAfter, makeDesk } = await import('../route/desk.ts');
        const { DEFAULT_ROUTER_MODEL } = await import('../route/router-model.ts');
        desk = makeDesk({
          post: makeLoopbackPost({ url: MAGPIE_CHAT_URL, after: makeAfter(ctx.clock), timeoutMs: ROUTER_TIMEOUT_MS, maxBytes: ROUTER_REPLY_MAX_BYTES }),
          routerModel: DEFAULT_ROUTER_MODEL,
          // A harness that is on but at the shared limit cannot start a session now either (owned-limit).
          on: () => ({ codex: codexOwned !== null && !codexOwned.full(), claude: claudeOwned !== null && !claudeOwned.full() }),
          full: () => pool !== null && pool.active() >= pool.max,
          redact: (text) => redactor.redact({ text }).text,
          nowMono: () => wall.nowMono(),
          nowWall: () => wall.nowWall(),
          restored: lastDispatchIn(store.db),
        });
      }
      const deps = {
        codex: codexOwned, codexOff: ownedCodex.on ? 'on' : ownedCodex.why, claude: claudeOwned, desk, log, restored: restoredOff,
        // Why a new session has no brake (null: each runs in a Job of its own), read at each list: a
        // resident procguard that went away since says so (the brake then cannot report what it did).
        brakeWhy: () => (!procguard.on ? procguard.why : resident !== null && !resident.up ? 'procguard-resident-gone' : null),
        ...(pool === null ? {} : { maxOwned: pool.max }),
      };
      const owners: { towerSeats(): OwnedSeat[] }[] = [...[codexOwned, claudeOwned].filter((x): x is CodexOwned | ClaudeOwned => x !== null), ...restoredOff];
      const lastDispatch = () => {
        const d = desk?.last() ?? null;
        if (d === null) return null;
        const meta = (d.harness === 'codex' ? codexOwned : claudeOwned)?.meta(d.ownedId) ?? restoredOff.find((r) => r.harness === d.harness)?.meta(d.ownedId) ?? null;
        return { ...d, title: meta?.title ?? '' };
      };
      const server = await startPeekServer({
        port: ctx.peekPort, gate, roots: ctx.roots, redact: (text) => redactor.redact({ text }).text, clock: ctx.clock.port(null), log, pairingCode: code, profile: ctx.profile.kind,
        // alpha 0.2's owned-session base (slice design §2.7): unlock codes go where the pairing code
        // goes. Owned sessions start only when --owned set them up (owned Codex sessions; the Claude
        // host is not wired yet); otherwise new answers 409 owned-disabled and GET /api/owned says why.
        owned: {
          journal: humanJournal(store),
          printUnlockCode: pairing.print === 'none' ? null : (c) => {
            ctx.console.out(`orchestrad: unlock code ${c}`);
            log.info('unlock-code-printed', { to: pairing.print });
          },
          enabled: ownedEnabled(deps),
          handlers: registerOwnedHandlers(deps),
        },
        ...(owners.length === 0 ? {} : { ownedSeats: { seats: () => owners.flatMap((o) => o.towerSeats()), nowWall: () => wall.nowWall(), dispatch: lastDispatch } }),
      });
      peek = server;
      ctx.console.out(`orchestrad: peek page at ${server.url} (read-only; pair with the code above)`);
    } catch (e) {
      log.error('peek-failed', { error: e });
      ctx.console.err(`orchestrad: the peek page did not start on port ${ctx.peekPort}: ${describe(e)}`);
    }
  }
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => {
    resolveStopped = r;
  });
  let uninstall: () => void = () => {};
  let ending: Promise<void> | null = null;
  const stop = (): Promise<void> => (ending ??= (async () => {
    uninstall();
    // The owned sessions first: their open approvals are declined while the children can still read it.
    if (codexOwned !== null) log.info('owned-codex-ended', { sessions: codexOwned.endAll() });
    if (claudeOwned !== null) {
      // Each host is stopped in the design's order, whose last two steps run on the Clock: the process
      // waits for every host to close, at most OWNED_STOP_WAIT_MS (the order's 5 s and a margin), so the
      // stdin close and the kill do run (alpha 0.2 design §2.1 "停止顺序").
      const { ended, exited } = claudeOwned.endAll();
      if (ended > 0) {
        const after = oneShot(ctx.clock, 'daemon-stop');
        let cancel: () => void = () => {};
        await Promise.race([exited, new Promise<void>((r) => { cancel = after(OWNED_STOP_WAIT_MS, r); })]);
        cancel();
      }
      // T1: a host that did not close in time is said, never taken for gone.
      log.info('owned-claude-ended', { sessions: ended, stillOpen: claudeOwned.open() });
    }
    if (jobsIn !== null) {
      // The children still closing (a Codex wrapper killed a moment ago) and the Job check each close
      // started (owned-tree in the log) go first: only then is the resident let go (phase 4 review).
      const after = oneShot(ctx.clock, 'daemon-stop-trees');
      let cancel: () => void = () => {};
      const quiet = await Promise.race([jobsIn.quiet().then(() => true), new Promise<boolean>((r) => { cancel = after(OWNED_TREE_WAIT_MS, () => r(false)); })]);
      cancel();
      if (!quiet) log.warn('owned-trees-unsettled', { waitedMs: OWNED_TREE_WAIT_MS });
    }
    // Last of the owned part: the resident procguard reads EOF, answers what it was still asked, and exits.
    resident?.stop();
    if (peek !== null) await peek.close();
    log.info('stopped', { pidSinkFailures: ctx.pidLog.failures() });
    // Nothing reaches ORCHESTRA_HOME from here on, then the process ends with the lock.
    log.detach();
    ctx.pidLog.detach();
    store.close();
    await ctx.stopping.end(lock);
    resolveStopped();
  })());
  uninstall = ctx.stopping.onSignal((why = 'signal', detail = null) => {
    log.info('stop-asked', { why, detail });
    if (why !== 'signal') ctx.console.out(`orchestrad: stdin ${why === 'stdin-eof' ? 'closed' : `failed (${detail ?? 'unknown'})`}: the program that started orchestrad is gone or let go of it; stopping as on Ctrl+C`);
    void stop();
  });
  if (ctx.stopping.stdin?.() === 'pipe') {
    log.info('stdin-watch', { kind: 'pipe' });
    ctx.console.out('orchestrad: stdin is a pipe: when it closes, orchestrad stops as on Ctrl+C (owned sessions end, then the process exits)');
  }

  log.info('working', { profile: ctx.profile.kind, pipe, bootId });
  // Last line of the startup: everything above is on disk and on the console before it.
  ctx.console.out(`orchestrad: working (${ctx.profile.kind} profile, pid ${ctx.pid}, data ${home})`);
  return { mode: 'working', profile: ctx.profile.kind, home, pipe, pairing, testRoots, store, ownedCodex, ownedClaude, procguard, stop, stopped };
}


/** What both harnesses' owned sessions share: the one approval queue, the registry, the work root and its cwd table. */
type OwnedBase = {
  /** The running-session limit both managers count against. */
  pool: OwnedPool;
  sys: ProvenSystemRoot;
  approvals: Approvals;
  registry: OwnedRegistry;
  workRoot: string;
  cwdSpec: CwdPolicySpec;
  judge: PathJudge;
  redact: Redact;
  now(): number;
};

/**
 * The owned sessions' common part (orchestra app plan §2-§4): the work root ORCHESTRA_HOME\work and the
 * registry dir made through the fence, SystemRoot resolved for the spawn gates, the one approval queue
 * (D8: what leaves it without a person is logged), the cwd table the gates and the approvals' paths are
 * judged by (r4 §5.3's protected dirs: the data dir and every harness root).
 */
async function setUpOwnedShared(ctx: WorkingContext, fence: WriteFence, gate: ReadGate, home: string, pool: OwnedPool): Promise<{ ok: true; base: OwnedBase } | { ok: false; why: 'no-spawn-gate' | 'setup-failed'; detail: string | null }> {
  if (ctx.makeSpawnGate === undefined) return { ok: false, why: 'no-spawn-gate', detail: null };
  try {
    const { resolveSystemRoot } = await import('../os/spawn.ts');
    const { OWNED_DIRS } = await import('../owned/codex-home.ts');
    const { Approvals: Queue } = await import('../owned/approvals.ts');
    const { REGISTRY_DIR, makeOwnedRegistry } = await import('../owned/registry.ts');
    const { CwdPolicy } = await import('../os/cwd.ts');
    const sys = resolveSystemRoot(ctx.env, ctx.realpath);
    if (!sys.ok) return { ok: false, why: 'setup-failed', detail: `SystemRoot ${sys.reason}` };
    const workRoot = win.join(home, OWNED_DIRS.work);
    fence.mkdirp(workRoot);
    const registryDir = win.join(home, REGISTRY_DIR);
    fence.mkdirp(registryDir);
    const cwdSpec: CwdPolicySpec = { allowedRoots: [workRoot], protectedDirs: [home, ...ctx.roots.map((r) => r.path)], userHome: ctx.userHome, ownedWorkRoot: workRoot };
    // The same table the gates check a cwd against judges the paths an approval names (orchestra app plan §4).
    const places = new CwdPolicy({ spec: cwdSpec, env: ctx.env, systemRoot: sys.path, realpath: ctx.realpath });
    const redactor = makeRedactor({ env: ctx.env });
    const wall = ctx.clock.port(null);
    const approvals = new Queue({
      hub: ctx.clock,
      onSettled: (v, o) => {
        if (o.cause !== 'human') ctx.log.info('approval-settled', { approvalId: v.approvalId, ownedId: v.ownedId, kind: v.kind, decision: o.decision, cause: o.cause });
      },
    });
    const registry = makeOwnedRegistry({
      dir: registryDir,
      writeAtomic: (file, text) => fence.writeAtomic(file, text),
      readdir: (dir) => gate.readdir(dir),
      readFile: (file) => gate.readFile(file).toString('utf8'),
    });
    return {
      ok: true,
      base: {
        pool, sys, approvals, registry, workRoot, cwdSpec, judge: (p) => places.place(p), now: () => wall.nowWall(),
        redact: (text) => {
          const r = redactor.redact({ text });
          const v = r.verdict;
          return { text: r.text, count: v.known + v.entropy + Object.values(v.format).reduce((a, b) => a + b, 0) + (v.dropped === null ? 0 : 1) };
        },
      },
    };
  } catch (e) {
    return { ok: false, why: 'setup-failed', detail: describe(e) };
  }
}

/** What a harness's wiring needs to start its children in Jobs: the procguard site and the resident. */
type Jobs = {
  /** procguard.exe, its site dir and the sha256 it was built as. */
  exe: string;
  dir: string;
  homeReal: string;
  sourceHash: string;
  /** The spawn gate's pin check: procguard.exe still the one built. */
  pin(): string | null;
  resident: Resident;
} & JobTracker;

/** What procguard's holder hears: the resident went away; a Job was ended (the brake, or the check after an end). */
type ProcguardHooks = { onGone(detail: string): void; onTree(job: string, o: JobOutcome): void };

/** How long csc may take (S4: 1.1-1.6 s; a loaded machine is slower). */
const CSC_LIMITS = Object.freeze({ timeoutMs: 120_000, maxBytes: 256 * 1024 });

/**
 * procguard for the owned sessions (r4 D4; src/os/procguard.ts): the source read through a read gate
 * pinned on it and held to PROCGUARD_SOURCE_SHA256, the site ORCHESTRA_HOME\runtime\procguard\<that
 * hash>\ made through the fence, the exe found there (held to the sha256 recorded when it was built) or
 * built by the system csc.exe (a spawn gate with the rules csc and procguard only), then the resident
 * procguard started through the same gate (it must say ready). Off with the reason otherwise.
 */
async function setUpProcguard(ctx: WorkingContext, fence: WriteFence, gate: ReadGate, base: OwnedBase, hooks: ProcguardHooks): Promise<{ status: ProcguardStatus; jobs: Jobs | null }> {
  const off = (why: ProcguardOffWhy, detail: string | null = null) => ({ status: { on: false as const, why, detail }, jobs: null });
  if (ctx.makeSpawnGate === undefined) return off('procguard-setup-failed', 'no spawn gate');
  try {
    const { CSC_FLAGS, CSC_REL, PROCGUARD_SOURCE } = await import('../os/spawn.ts');
    const { ensureProcguard, jobTracker, procguardPin, residentOf } = await import('../os/procguard.ts');
    const { PROCGUARD_SOURCE_SHA256 } = await import('../os/procguard-pins.ts');
    const homeReal = fence.homeReal;
    const dir = win.join(homeReal, 'runtime', 'procguard', PROCGUARD_SOURCE_SHA256);
    let pin: (() => string | null) | null = null;
    const pgGate = ctx.makeSpawnGate({
      systemRoot: base.sys,
      rules: ['csc', 'procguard'],
      csc: { outAllowed: (out) => fence.check(out, 'write').allow },
      procguard: [{ at: 'runtime', homeReal, sourceHash: PROCGUARD_SOURCE_SHA256 }],
      // Before the build there is nothing to start: the resident waits for the pin the build gives.
      procguardPin: () => (pin === null ? 'procguard.exe not built yet' : pin()),
      record: (e) => ctx.pidLog.record(e),
      realpath: ctx.realpath,
      clock: ctx.clock,
      env: ctx.env,
    });
    const source = ctx.makeReadGate({ roots: [], pinnedFiles: [PROCGUARD_SOURCE] });
    const site = await ensureProcguard({
      dir, sourceHash: PROCGUARD_SOURCE_SHA256,
      readSource: () => source.readFile(PROCGUARD_SOURCE),
      readFile: (file) => gate.readFile(file),
      mkdirp: (d) => {
        fence.mkdirp(d);
      },
      writeAtomic: (file, data) => fence.writeAtomic(file, data),
      rm: (file) => {
        fence.rm(file);
      },
      runCsc: (out) => pgGate.run({ exe: win.join(base.sys.path, CSC_REL), argv: [...CSC_FLAGS, `/out:${out}`, PROCGUARD_SOURCE] }, CSC_LIMITS),
    });
    if (!site.ok) return off(site.why, site.detail);
    pin = procguardPin((file) => gate.readFile(file), site.exe, site.sha256);
    let h: ReturnType<SpawnGate['start']>;
    try {
      h = pgGate.start({ exe: site.exe, argv: [] });
    } catch (e) {
      return off('procguard-start-failed', describe(e));
    }
    const resident = residentOf(h, oneShot(ctx.clock, 'procguard'), { onGone: hooks.onGone });
    if (!(await resident.ready)) {
      resident.stop();
      return off('procguard-start-failed', 'the resident procguard did not say ready');
    }
    const thePin = pin;
    const { job, opened, quiet } = jobTracker(resident, hooks.onTree);
    return {
      status: { on: true, exe: site.exe, dir, sha256: site.sha256, built: site.built },
      jobs: { exe: site.exe, dir, homeReal, sourceHash: PROCGUARD_SOURCE_SHA256, pin: () => thePin(), resident, job, opened, quiet },
    };
  } catch (e) {
    return off('procguard-setup-failed', describe(e));
  }
}

/**
 * The owned Codex sessions' wiring (orchestra app plan §2), in both profiles: codex.exe at its pinned
 * path below %APPDATA% (not found: off, with the reason), the private CODEX_HOME's config.toml written
 * through the fence, and a spawn gate that allows only codex-app-server, with CODEX_HOME as its one
 * extra and the shared cwd table, whose only allowed root is the work root.
 */
async function setUpOwnedCodex(ctx: WorkingContext, fence: WriteFence, home: string, base: OwnedBase, jobs: Jobs | null): Promise<{ status: OwnedCodexStatus; owned: CodexOwned | null }> {
  const off = (why: Extract<OwnedCodexStatus, { on: false }>['why'], detail: string | null = null) => ({ status: { on: false as const, why, detail }, owned: null });
  const { CODEX_APP_SERVER_ARGV, resolveCodexExe, runInJobArgv } = await import('../os/spawn.ts');
  const exe = resolveCodexExe(ctx.env, ctx.realpath);
  if (!exe.ok) return off(`codex-${exe.reason}`, exe.detail ?? null);
  if (ctx.makeSpawnGate === undefined) return off('no-spawn-gate');
  try {
    const { childPipe } = await import('../os/child-pipe.ts');
    const { writeCodexHome } = await import('../owned/codex-home.ts');
    const { DEFAULT_CODEX_MODEL } = await import('../owned/models.ts');
    const { CodexOwned: Owned } = await import('../owned/codex-owned.ts');
    const { envAllowlistFile, newJobName } = await import('../os/procguard.ts');
    const codexHome = writeCodexHome(fence, home, { model: DEFAULT_CODEX_MODEL, gatewayBaseUrl: MAGPIE_BASE_URL });
    const envFile = jobs === null ? null : envAllowlistFile(jobs.dir, 'codex-app-server');
    // With procguard: only the wrapped rule, so no codex.exe starts outside a Job; without: as before.
    const spawnGate = ctx.makeSpawnGate({
      systemRoot: base.sys,
      rules: [jobs === null ? 'codex-app-server' : 'procguard-codex'],
      record: (e) => ctx.pidLog.record(e),
      realpath: ctx.realpath,
      clock: ctx.clock,
      env: ctx.env,
      envExtra: { 'codex-app-server': { CODEX_HOME: codexHome } },
      cwd: base.cwdSpec,
      ...(jobs === null || envFile === null ? {} : {
        procguard: [{ at: 'runtime' as const, homeReal: jobs.homeReal, sourceHash: jobs.sourceHash }], procguardPin: jobs.pin, procguardEnv: { 'codex-app-server': envFile },
      }),
    });
    if (envFile !== null) fence.writeAtomic(envFile, spawnGate.envAllowlist('codex-app-server'));
    const launch = (cwd: string) => {
      if (jobs === null || envFile === null) return childPipe(spawnGate.start({ exe: exe.path, argv: CODEX_APP_SERVER_ARGV, cwd }));
      const job = newJobName();
      const pipe = childPipe(spawnGate.start({ exe: jobs.exe, argv: runInJobArgv(job, envFile, exe.path, CODEX_APP_SERVER_ARGV), cwd }), jobs.job(job));
      jobs.opened(pipe);
      return pipe;
    };
    const owned = new Owned({
      approvals: base.approvals,
      makeWorkDir: (ownedId) => {
        const dir = win.join(base.workRoot, ownedId);
        fence.mkdirp(dir);
        return dir;
      },
      launch,
      hub: ctx.clock,
      judge: base.judge,
      registry: base.registry,
      pool: base.pool,
      now: base.now,
      redact: base.redact,
    });
    return { status: { on: true, exe: exe.path, codexHome, workRoot: base.workRoot, model: DEFAULT_CODEX_MODEL, gateway: MAGPIE_BASE_URL, restored: owned.restored, jobs: jobs !== null }, owned };
  } catch (e) {
    return off('setup-failed', describe(e));
  }
}

/**
 * The owned Claude sessions' wiring (orchestra app step 4; alpha 0.2 design §2.1, §2.4), in both
 * profiles: the host's node.exe, host.mjs and the SDK's claude.exe resolved (claude-site.ts), the three
 * pinned files checked through a read gate whose only roots are those files (a mismatch: off,
 * host-tampered), ORCHESTRA_HOME\claude-home (the host's own CLAUDE_CONFIG_DIR, a backstop: each session
 * runs with its own ORCHESTRA_HOME\claude\<ownedId>) and ORCHESTRA_HOME\claude made, and a spawn gate
 * that allows only claude-host, with the gateway, the placeholder token, the small fast model and
 * NO_PROXY as its extras, the pin check again before every start, and the shared cwd table.
 */
async function setUpOwnedClaude(ctx: WorkingContext, fence: WriteFence, home: string, base: OwnedBase, jobs: Jobs | null): Promise<{ status: OwnedClaudeStatus; owned: ClaudeOwned | null }> {
  const off = (why: Extract<OwnedClaudeStatus, { on: false }>['why'], detail: string | null = null) => ({ status: { on: false as const, why, detail }, owned: null });
  if (ctx.makeSpawnGate === undefined) return off('no-spawn-gate');
  try {
    const { CLAUDE_GATEWAY_TOKEN, runInJobArgv } = await import('../os/spawn.ts');
    const { envAllowlistFile, newJobName } = await import('../os/procguard.ts');
    const { hostPipe } = await import('../os/owned-proc.ts');
    const { MAIN_CHECKOUT, REPO_ROOT } = await import('../os/cwd.ts');
    const { checkExe, checkPins, exeMark, pinnedFiles, resolveHostSite } = await import('../owned/claude-site.ts');
    const { CLAUDE_SMALL_FAST_MODEL, DEFAULT_CLAUDE_MODEL } = await import('../owned/models.ts');
    const { ClaudeOwned: Owned } = await import('../owned/claude-owned.ts');
    const site = resolveHostSite(ctx.realpath);
    if (!site.ok) return off(`claude-${site.reason}`, site.detail);
    // The three pinned files are hashed; claude.exe (too large for that) is held to its size, mtime and file id at startup.
    const pins = ctx.makeReadGate({ roots: [], pinnedFiles: [...pinnedFiles(), site.claudeExe] });
    const open = (file: string) => pins.openRead(file);
    const changed = checkPins((file) => pins.readFile(file));
    if (changed !== null) return off('host-tampered', changed);
    const mark = exeMark(open, site.claudeExe);
    if (!mark.ok) return off('host-tampered', mark.detail);
    const verify = () => checkPins((file) => pins.readFile(file)) ?? checkExe(open, site.claudeExe, mark.mark);
    const tampered = verify();
    if (tampered !== null) return off('host-tampered', tampered);
    const configHome = win.join(home, 'claude-home');
    fence.mkdirp(configHome);
    const configRoot = win.join(home, 'claude');
    fence.mkdirp(configRoot);
    const envFile = jobs === null ? null : envAllowlistFile(jobs.dir, 'claude-host');
    const spawnGate = ctx.makeSpawnGate({
      systemRoot: base.sys,
      rules: [jobs === null ? 'claude-host' : 'procguard-claude'],
      record: (e) => ctx.pidLog.record(e),
      realpath: ctx.realpath,
      clock: ctx.clock,
      env: ctx.env,
      envExtra: {
        'claude-host': {
          CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_BASE_URL: CLAUDE_GATEWAY_URL, ANTHROPIC_AUTH_TOKEN: CLAUDE_GATEWAY_TOKEN,
          ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_SMALL_FAST_MODEL, NO_PROXY: '127.0.0.1,localhost',
        },
      },
      cwd: base.cwdSpec,
      claudeHost: { node: site.node, entry: site.entry, verify },
      ...(jobs === null || envFile === null ? {} : {
        procguard: [{ at: 'runtime' as const, homeReal: jobs.homeReal, sourceHash: jobs.sourceHash }], procguardPin: jobs.pin, procguardEnv: { 'claude-host': envFile },
      }),
    });
    if (envFile !== null) fence.writeAtomic(envFile, spawnGate.envAllowlist('claude-host'));
    const launch = (cwd: string) => {
      if (jobs === null || envFile === null) return hostPipe(spawnGate.start({ exe: site.node, argv: [site.entry], cwd }));
      const job = newJobName();
      const pipe = hostPipe(spawnGate.start({ exe: jobs.exe, argv: runInJobArgv(job, envFile, site.node, [site.entry]), cwd }), jobs.job(job));
      jobs.opened(pipe);
      return pipe;
    };
    const owned = new Owned({
      approvals: base.approvals,
      makeWorkDir: (ownedId) => {
        const dir = win.join(base.workRoot, ownedId);
        fence.mkdirp(dir);
        return dir;
      },
      makeConfigDir: (ownedId) => {
        const dir = win.join(configRoot, ownedId);
        fence.mkdirp(dir);
        return dir;
      },
      launch,
      claudeExe: site.claudeExe,
      // The host denies every tool call into these (and into ~/.claude, ~/.dsh, ~/.orchestra and the
      // session's own config dir, which it adds itself); a session's own work dir stays open through
      // the work root exemption (hosts/claude/host-core.mjs workRootOf).
      protectedRoots: [home, REPO_ROOT, ...(MAIN_CHECKOUT === null ? [] : [MAIN_CHECKOUT]), ...ctx.roots.map((r) => r.path)],
      hub: ctx.clock,
      judge: base.judge,
      registry: base.registry,
      pool: base.pool,
      now: base.now,
      redact: base.redact,
    });
    return {
      status: { on: true, node: site.node, entry: site.entry, claudeExe: site.claudeExe, configRoot, model: DEFAULT_CLAUDE_MODEL, gateway: CLAUDE_GATEWAY_URL, restored: owned.restored, jobs: jobs !== null },
      owned,
    };
  } catch (e) {
    return off('setup-failed', describe(e));
  }
}
