import type { RealpathFn } from './fs/paths.ts';
import type { ReadGateSpec, WriteFenceSpec } from './fs/node-io.ts';
import type { ReadGate } from './fs/read-gate.ts';
import type { WriteFence } from './fs/write-fence.ts';
import type { SpawnGateSpec } from './os/node-proc.ts';
import type { SpawnGate } from './os/spawn.ts';
import type { DbOpener, DbOpenerSpec } from './store/db.ts';
import type { ClockHub, ExitTimer } from './runtime/clock.ts';
import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
// Minted before the fence: the static imports below are evaluated before this module's body, so
// node:fs and node:child_process are loaded while nothing guards them, and only here. Once
// installImportFence() has run, none of the minted modules can be resolved again (minted-before-fence).
// src/store/node-sqlite.ts is minted the same way, but loads node:sqlite only when working.ts makes
// the first opener, so a ui-only process never loads it (the import its builtin-policy row allows
// stays its own: no other module may import node:sqlite, and nobody can import node-sqlite.ts). The clock
// hub is made here too (runtime/clock.ts, the one module that reads the time or arms a timer): it
// reaches main.ts and working.ts only as BootPorts.clock, never as a default. clock.ts's exit timer is
// taken here too, and kept: it reaches no other module (makeEndProcess).
import { makeReadGate, makeWriteFence, realpath } from './fs/node-io.ts';
import { makeSpawnGate } from './os/node-proc.ts';
import { makeDbOpener } from './store/node-sqlite.ts';
import { makeRealClock, takeExitTimer } from './runtime/clock.ts';
import { EXIT } from './runtime/exit.ts';
import { detectFeatures } from './runtime/features.ts';
import { deadDispatcher, installImportFence } from './runtime/import-fence.ts';
import { scrubString } from './runtime/log.ts';

/** What a caller of ports.fetch may set; every other RequestInit field is fixed by the port. */
export type PortFetchInit = { method?: string; headers?: Readonly<Record<string, string>>; body?: string | null; signal?: AbortSignal | null };

/**
 * Capabilities boot takes before the fence locks them, for main.ts to hand to the one module allowed
 * each. fetch serves data: URLs only until step 15 binds the dispatcher (see import-fence.ts). The
 * file system and child processes arrive as gate factories (src/fs/node-io.ts, src/os/node-proc.ts):
 * whoever holds a port can make a gate, whose rules are its module's constants, never reach the raw
 * builtin. main.ts reads these as own properties only.
 */
export type BootPorts = {
  fetch(url: string | URL, init?: PortFetchInit): Promise<Response>;
  realpath: RealpathFn;
  makeReadGate(spec: ReadGateSpec): ReadGate;
  makeWriteFence(spec: WriteFenceSpec): Promise<WriteFence>;
  makeSpawnGate(spec: SpawnGateSpec): SpawnGate;
  /** The SQLite opener factory (src/store/node-sqlite.ts); working.ts makes the store's opener with it. */
  makeDbOpener(spec: DbOpenerSpec): Promise<DbOpener>;
  /** The one real clock hub (src/runtime/clock.ts); main.ts and working.ts mint every Clock from it. */
  clock: ClockHub;
  /** Ends the process with exactly this code (endProcess below); main.ts's stopping ends through it. */
  endProcess(code: number): void;
};

/**
 * The one live fetch. Each call gets a fresh init without a prototype in which every RequestInit
 * field is an own, defined value and the dispatcher is bound: undici reads any field the init lacks
 * through Object.prototype, where a module could have put a dispatcher that sees every request (or a
 * method, headers, keepalive). Only the caller's own method, headers, body and signal are copied;
 * its init object is never passed on.
 */
function portFetch(raw: typeof globalThis.fetch, dispatcher: object): BootPorts['fetch'] {
  return (url, given) => {
    const has = (k: keyof PortFetchInit) => given !== undefined && given !== null && Object.hasOwn(given, k);
    const headers = Object.create(null) as Record<string, string>;
    if (has('headers') && given!.headers !== undefined) for (const [k, v] of Object.entries(given!.headers)) headers[k] = String(v);
    const init = Object.create(null) as Record<string, unknown>;
    Object.assign(init, {
      method: has('method') && given!.method !== undefined ? String(given!.method) : 'GET',
      headers,
      body: has('body') && given!.body !== undefined ? given!.body : null,
      signal: has('signal') && given!.signal !== undefined ? given!.signal : null,
      referrer: 'about:client', referrerPolicy: '', mode: 'cors', credentials: 'same-origin', cache: 'default', redirect: 'follow',
      integrity: '', keepalive: false, window: null, duplex: 'half', priority: 'auto', dispatcher,
    });
    return raw(String(url), init as RequestInit);
  };
}

type MainModule = { start(f: Features, fence: FenceStatus, ports: BootPorts): Promise<unknown> };

/**
 * process.reallyExit, taken while this module evaluates, before the fence: a mint entry boot.ts
 * keeps for itself (process-powers.ts), so after the fence the slot holds a stub and this is the one
 * live copy. Called as a plain function, never through .call or .apply, which a module could
 * replace on Function.prototype: Node's binding reads no `this` (measured on 24.22: a bare call and
 * a call with `this` undefined both end the process with the code given).
 */
const reallyExit: (code: number) => void = process.reallyExit;

/**
 * process.setUncaughtExceptionCaptureCallback, taken the same way: a mint boot.ts keeps (process-powers.ts),
 * through which runEntry makes its crash handler the capture callback. Node then hands every uncaught
 * error and unhandled rejection to that callback instead of emitting 'uncaughtException', so no listener
 * a module adds, removes or throws from decides a crash's code (measured on 24.22: with a plain listener,
 * removeAllListeners() before a throw ended with 1, and a second listener that throws with 7). The slot
 * holds a stub for everyone else once the fence is in, so nobody can clear or replace the callback. It
 * is set before the fence: Node's setter writes a field of the process report object, whose fence stub
 * is frozen (measured: the call then throws). Called as a plain function: Node's reads no `this`.
 */
const setCrashCapture: (fn: ((e: unknown) => void) | null) => void = process.setUncaughtExceptionCaptureCallback;

/**
 * The flush deadline's timer, taken the same way: clock.ts hands it out once, and boot.ts takes it while
 * it evaluates, before any entry module runs. A native one-shot timer outside the hub every module's
 * Clocks share, so no module can pre-arm its timerId, cancel it or postpone it through a Clock; it reads
 * no clock, so a time source some module replaced or froze cannot hold it either; and its Timeout is made
 * now, with its own fields and methods taken now, so writing Timeout.prototype later does not reach it
 * (clock.ts takeExitTimer, which names what stays a residual).
 */
const exitTimer: ExitTimer = takeExitTimer();

/** How long the console may take to drain before the process ends anyway. */
export const EXIT_FLUSH_MS = 2000;

/**
 * Where a call of EndProcess comes from: a typed outcome or a stop ('end'), runEntry's crash handler, the
 * capture callback Node hands every uncaught error to ('crash'), or runEntry's 'uncaughtExceptionMonitor'
 * listener, which Node runs before that callback and before any monitor a module adds later ('monitor').
 */
export type EndCause = 'end' | 'crash' | 'monitor';

/**
 * Ends the process: `line` (if any) to stderr, the console flushed, then exactly `code`. The first 'end'
 * or 'crash' call commits its code, and nothing changes it after. Once it is committed, a later 'end' is
 * a no-op, and a 'crash' or 'monitor' call ends the process at once with the committed code; before
 * that, a 'monitor' call does nothing (the crash handler that follows commits the crash).
 */
export type EndProcess = (code: number, line?: string, cause?: EndCause) => void;

/**
 * The one way orchestrad ends (a typed outcome, a crash, a stop). It writes `line`, waits for stdout
 * and stderr to drain, but at most EXIT_FLUSH_MS on boot's own exit timer, so a write whose callback
 * never comes (a replaced process.stdout.write, say) cannot keep the process alive; then it hands
 * `code` to the reallyExit it took. Node's exit() would emit 'exit' first and end with
 * process.exitCode as its listeners left it (measured: a listener setting exitCode = 0 turned a typed
 * refusal into 0); reallyExit takes the code it is given and runs no listener. The fence locks exit()
 * and reallyExit on process for everyone else (process-powers.ts), so no module can end the process
 * with a code of its own while the console drains.
 *
 * A crash during the drain ends the process at once with the committed code: a crashed process is in a
 * state nobody knows, and Node's crash path may run more code after boot's own (a monitor a module added
 * that throws ends the process with 7, Node's code for a crash handler that threw), so boot ends before
 * any of it runs. The first call fixes its code and arms the exit timer before anything else; a write
 * that throws counts as drained (the global process replaced by a module without a console ends the
 * process at once), and any other throw ends the process at once with that code: a half-done end would
 * leave the code committed with nothing to end it. Each stream counts once, however often its write
 * calls back, and the line is issued first, so a stdout that calls back twice cannot end the process
 * before the line is out; process.exitCode is set last, so a setter that throws cannot drop it either.
 */
export function makeEndProcess(): EndProcess {
  let committed: number | null = null;
  return (code, line, cause = 'end') => {
    if (committed !== null) {
      if (cause !== 'end') reallyExit(committed);
      return;
    }
    if (cause === 'monitor') return;
    committed = code;
    const end = () => reallyExit(code);
    try {
      exitTimer(EXIT_FLUSH_MS, end);
      let left = 2;
      const drainedOnce = () => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          left--;
          if (left === 0) end();
        };
      };
      const errDrained = drainedOnce();
      const outDrained = drainedOnce();
      try {
        process.stderr.write(line ?? '', errDrained);
      } catch {
        errDrained();
      }
      try {
        process.stdout.write('', outDrained);
      } catch {
        outDrained();
      }
      try {
        // For whoever reads it during the drain; reallyExit takes `code` itself, so a setter that throws
        // (a replaced global process) changes nothing and the drain goes on.
        process.exitCode = code;
      } catch {
        // The code is committed above.
      }
    } catch {
      end();
    }
  };
}

/** The boot hub and the end; runEntry makes one pair for the whole process. */
export type BootBase = { hub: ClockHub; end: EndProcess };

function bootBase(): BootBase {
  return { hub: makeRealClock(), end: makeEndProcess() };
}

export type BootDeps = { detectFeatures(): Features; installImportFence(): FenceStatus };

/** `result` is what the entry's start() returned (main.ts: a StartOutcome). */
export type BootOutcome =
  | { started: true; fence: FenceStatus; result: unknown }
  | { started: false; reason: 'no-resolve-hook'; code: typeof EXIT.missingFeatures; fence: FenceStatus };

const DEFAULT_DEPS: BootDeps = { detectFeatures, installImportFence: () => installImportFence() };

export async function boot(entry: URL, deps: BootDeps = DEFAULT_DEPS, base: BootBase = bootBase()): Promise<BootOutcome> {
  const f = deps.detectFeatures();
  const ports: BootPorts = {
    fetch: portFetch(globalThis.fetch, deadDispatcher()), realpath, makeReadGate, makeWriteFence, makeSpawnGate, makeDbOpener, clock: base.hub, endProcess: (code: number) => base.end(code),
  };
  // Hooks only see modules resolved after registration, so the fence goes in before main.ts is
  // imported. Without the resolve hook nothing would stop main.ts's graph from importing any
  // builtin, so boot refuses and never imports the entry (fail closed). Every Node that runs .ts
  // files by itself has module.registerHooks.
  const fence = deps.installImportFence();
  if (!fence.resolveHook) {
    process.stderr.write(`orchestrad: cannot start, missing: module.registerHooks (the import fence has no resolve hook): ${JSON.stringify(fence)}\n`);
    return { started: false, reason: 'no-resolve-hook', code: EXIT.missingFeatures, fence };
  }
  const main = (await import(entry.href)) as MainModule;
  const result = await main.start(f, fence, ports);
  return { started: true, fence, result };
}

/** The exit code an outcome asks for; null while it keeps running (working) or says nothing. */
export function exitCodeOf(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const code = (result as { code?: unknown }).code;
  return Number.isSafeInteger(code) ? (code as number) : null;
}

/** The one console line for a crash: the error's code or name and its message, scrubbed. */
export function crashLine(e: unknown): string {
  let what: string;
  try {
    what = e instanceof Error ? `${String((e as { code?: unknown }).code ?? e.name)}: ${e.message}` : String(e);
  } catch {
    what = '<unprintable error>';
  }
  return `orchestrad: crashed (exit ${EXIT.crashed}): ${scrubString(what)}`;
}

/**
 * The process entry. Whatever is thrown on the way, or later by a timer or an unhandled rejection,
 * ends the process with EXIT.crashed and one scrubbed line: Node's own code for that is 1, outside
 * the 20-29 that orchestrad's typed outcomes use (exit.ts). A typed outcome's code (refused, ui-only,
 * exit, lock-held, start-failed; a working outcome returns null and keeps running) is committed the
 * same way: through makeEndProcess, so neither a timer that flips process.exitCode, nor an 'exit'
 * listener that does, nor a console write that never calls back can change or hold it. `base` is a
 * parameter for the tests' controls, as in boot().
 *
 * Crashes reach boot through the capture callback (setCrashCapture above), not a listener: Node then
 * never emits 'uncaughtException', so no listener added, removed or thrown from decides the code. Node
 * still emits 'uncaughtExceptionMonitor' first; boot's monitor listener is the first one, added before
 * any entry module runs, and once a code is committed it ends the process right there, before a later
 * monitor can throw. Residuals of the threat model (zen note 7.1), all banned in our code by the static
 * scan (process-exit-only-in-boot): a module that removes boot's monitor or puts its own in front of it,
 * and then adds one that throws, ends a crash with 7; one that replaces process.emit decides what the
 * monitors see.
 */
export async function runEntry(entry: URL, deps: BootDeps = DEFAULT_DEPS, base: BootBase = bootBase()): Promise<void> {
  // Exit once the line is out: whatever the crash left open (the lock, a timer) must not keep a
  // process in an unknown state alive.
  const crash = (e: unknown) => base.end(EXIT.crashed, `${crashLine(e)}\n`, 'crash');
  process.on('uncaughtExceptionMonitor', () => base.end(EXIT.crashed, undefined, 'monitor'));
  try {
    setCrashCapture(crash);
  } catch (e) {
    // Another capture callback, or the fence already in (its frozen report stub): boot does not own
    // the crash path, so nothing starts (fail closed).
    crash(e);
    return;
  }
  try {
    const outcome = await boot(entry, deps, base);
    const code = outcome.started ? exitCodeOf(outcome.result) : outcome.code;
    if (code !== null) base.end(code);
  } catch (e) {
    crash(e);
  }
}

if (import.meta.main) await runEntry(new URL('./main.ts', import.meta.url));
