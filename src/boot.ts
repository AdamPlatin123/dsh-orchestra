import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import { EXIT } from './runtime/exit.ts';
import { detectFeatures } from './runtime/features.ts';
import { deadDispatcher, installImportFence } from './runtime/import-fence.ts';
import { scrubString } from './runtime/log.ts';

/** What a caller of ports.fetch may set; every other RequestInit field is fixed by the port. */
export type PortFetchInit = { method?: string; headers?: Readonly<Record<string, string>>; body?: string | null; signal?: AbortSignal | null };

/**
 * Capabilities boot takes before the fence locks them, for main.ts to hand to the one module allowed
 * each. fetch serves data: URLs only until step 15 binds the dispatcher (see import-fence.ts).
 */
export type BootPorts = { fetch(url: string | URL, init?: PortFetchInit): Promise<Response> };

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

export type BootDeps = { detectFeatures(): Features; installImportFence(): FenceStatus };

/** `result` is what the entry's start() returned (main.ts: a StartOutcome). */
export type BootOutcome =
  | { started: true; fence: FenceStatus; result: unknown }
  | { started: false; reason: 'no-resolve-hook'; code: typeof EXIT.missingFeatures; fence: FenceStatus };

const DEFAULT_DEPS: BootDeps = { detectFeatures, installImportFence: () => installImportFence() };

export async function boot(entry: URL, deps: BootDeps = DEFAULT_DEPS): Promise<BootOutcome> {
  const f = deps.detectFeatures();
  const ports: BootPorts = { fetch: portFetch(globalThis.fetch, deadDispatcher()) };
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

function crash(e: unknown): void {
  process.exitCode = EXIT.crashed;
  // Exit once the line is out: whatever the crash left open (the lock, a timer) must not keep a
  // process in an unknown state alive.
  process.stderr.write(`${crashLine(e)}\n`, () => process.exit(EXIT.crashed));
}

/**
 * The process entry. Whatever is thrown on the way, or later by a timer or an unhandled rejection,
 * ends the process with EXIT.crashed and one scrubbed line: Node's own code for that is 1, outside
 * the 20-29 that orchestrad's typed outcomes use (exit.ts).
 */
export async function runEntry(entry: URL, deps: BootDeps = DEFAULT_DEPS): Promise<void> {
  process.on('uncaughtException', crash);
  try {
    const outcome = await boot(entry, deps);
    const code = outcome.started ? exitCodeOf(outcome.result) : outcome.code;
    if (code !== null) process.exitCode = code;
  } catch (e) {
    crash(e);
  }
}

if (import.meta.main) await runEntry(new URL('./main.ts', import.meta.url));
