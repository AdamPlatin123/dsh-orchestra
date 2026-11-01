import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGateSpec, WriteFenceSpec } from '../fs/node-io.ts';
import type { RealpathFn } from '../fs/paths.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import type { WriteFence } from '../fs/write-fence.ts';
import type { PidLog } from '../os/spawn.ts';
import type { DbOpener, DbOpenerSpec } from '../store/db.ts';
import type { ChainBreak } from '../store/journal.ts';
import type { Store } from '../store/store.ts';
import type { ClockHub } from './clock.ts';
import type { DataDirInput } from './data-dir.ts';
import type { DaemonInfo, HeldLock } from './lock.ts';
import type { ConsolePort, Log } from './log.ts';
import type { StartupNote } from './startup.ts';
import type { PairingOutput, Profile } from './test-profile.ts';
import { rootDenyList } from '../fs/harness-roots.ts';
import { pathKey } from '../fs/paths.ts';
import { makeRedactor } from '../store/redact.ts';
import { openStore } from '../store/store.ts';
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

/** How a working orchestrad stops. */
export type StopPort = {
  /** Arranges for `stop` to run on Ctrl+C and friends; returns the undo. */
  onSignal(stop: () => void): () => void;
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
};

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

  // The thin slice's peek page, only when asked for: loaded here so that a start without --peek-port
  // resolves no HTTP module at all.
  let peek: { close(): Promise<void> } | null = null;
  if (ctx.peekPort !== undefined) {
    const redactor = makeRedactor({ env: ctx.env });
    try {
      const { startPeekServer } = await import('../server/http.ts');
      const server = await startPeekServer({
        port: ctx.peekPort, gate, roots: ctx.roots, redact: (text) => redactor.redact({ text }).text, clock: ctx.clock.port(null), log, pairingCode: code, profile: ctx.profile.kind,
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
    if (peek !== null) await peek.close();
    log.info('stopped', { pidSinkFailures: ctx.pidLog.failures() });
    // Nothing reaches ORCHESTRA_HOME from here on, then the process ends with the lock.
    log.detach();
    ctx.pidLog.detach();
    store.close();
    await ctx.stopping.end(lock);
    resolveStopped();
  })());
  uninstall = ctx.stopping.onSignal(() => {
    void stop();
  });

  log.info('working', { profile: ctx.profile.kind, pipe, bootId });
  // Last line of the startup: everything above is on disk and on the console before it.
  ctx.console.out(`orchestrad: working (${ctx.profile.kind} profile, pid ${ctx.pid}, data ${home})`);
  return { mode: 'working', profile: ctx.profile.kind, home, pipe, pairing, testRoots, store, stop, stopped };
}
