import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import { EXIT } from './runtime/exit.ts';
import { detectFeatures } from './runtime/features.ts';
import { installImportFence } from './runtime/import-fence.ts';
import { scrubString } from './runtime/log.ts';

/** Capabilities boot takes before the fence locks them, for main.ts to hand to the one module allowed each. */
export type BootPorts = { fetch: typeof globalThis.fetch };

type MainModule = { start(f: Features, fence: FenceStatus, ports: BootPorts): Promise<unknown> };

export type BootDeps = { detectFeatures(): Features; installImportFence(): FenceStatus };

/** `result` is what the entry's start() returned (main.ts: a StartOutcome). */
export type BootOutcome = { started: true; fence: FenceStatus; result: unknown };

const DEFAULT_DEPS: BootDeps = { detectFeatures, installImportFence: () => installImportFence() };

export async function boot(entry: URL, deps: BootDeps = DEFAULT_DEPS): Promise<BootOutcome> {
  const f = deps.detectFeatures();
  const ports: BootPorts = { fetch: globalThis.fetch };
  // Hooks only see modules resolved after registration, so the fence goes in before main.ts is
  // imported. Without the resolve hook main.ts still loads: planStartup() turns that into ui-only,
  // and main.ts's static graph only reads or spawns whoami through the gate; the working wiring is
  // imported later and only in working mode (test/runtime/startup-modes.test.ts measures both).
  const fence = deps.installImportFence();
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

function crash(e: unknown): void {
  process.exitCode = EXIT.crashed;
  // Exit once the line is out: whatever the crash left open (the lock, a timer) must not keep a
  // process in an unknown state alive.
  process.stderr.write(`${crashLine(e)}\n`, () => process.exit(EXIT.crashed));
}

/**
 * The process entry. Whatever is thrown on the way, or later by a timer or an unhandled rejection,
 * ends the process with EXIT.crashed and one scrubbed line: Node's own code for that is 1, which
 * would read as the elevated refusal (P1).
 */
export async function runEntry(entry: URL, deps: BootDeps = DEFAULT_DEPS): Promise<void> {
  process.on('uncaughtException', crash);
  try {
    const outcome = await boot(entry, deps);
    const code = exitCodeOf(outcome.result);
    if (code !== null) process.exitCode = code;
  } catch (e) {
    crash(e);
  }
}

if (import.meta.main) await runEntry(new URL('./main.ts', import.meta.url));
