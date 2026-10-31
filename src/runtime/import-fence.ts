import * as nodeModule from 'node:module';
import { builtinId, decideBuiltin, isDefaultBuiltin, moduleKeyFromUrl } from './builtin-policy.ts';

const REPO_ROOT = new URL('../../', import.meta.url);
const INSTALLED = Symbol.for('orchestra.importFence');

/** Repo code lives here; a module in these dirs imports only modules in these dirs. */
const MODULE_DIRS: readonly string[] = ['src/', 'shared/'];
/** Their one dynamic import loads a caller-given module: the entry (boot) or a worker target (bootstrap). */
const LOADERS: readonly string[] = ['src/boot.ts', 'src/workers/bootstrap.ts'];
const CODE_EXTENSIONS: readonly string[] = ['.ts', '.js'];
const NETWORK_GLOBALS: readonly string[] = ['fetch', 'WebSocket', 'EventSource'];
/**
 * _debugProcess(pid) opens the inspector of another Node process of this user (node:inspector by
 * another name), _debugEnd closes it; _getActiveHandles and _getActiveRequests hand out the live
 * handles, the lock pipe's server among them, which anyone could close. getActiveResourcesInfo gives
 * type names only and stays as a diagnostic.
 */
const DEBUG_POWERS: readonly string[] = ['_debugProcess', '_debugEnd', '_getActiveHandles', '_getActiveRequests'];
/**
 * undici's global dispatcher slots. They are empty when the fence goes in and undici fills them on the
 * first fetch or import of node:http, and only when empty: a module could then send HTTP without fetch
 * (`.request()`), or put a Proxy there and see every request made without an own dispatcher. A frozen
 * stub takes both slots for good; later fetches of data: URLs and imports of node:http still work.
 * The slots alone do not protect ports.fetch: undici reads every RequestInit field, dispatcher
 * included, through the prototype chain of the dictionary it builds, so a module that defines
 * Object.prototype.dispatcher sees any request whose init lacks an own, defined dispatcher (a
 * null-prototype init is not enough; measured on 24.22). boot.ts's ports.fetch therefore builds a
 * fresh init per call with every RequestInit field set as an own value, the dispatcher bound, and
 * never passes the caller's init on. Step 15 needs real HTTP for the DSH connect: boot will run
 * `await fetch('data:,')` before the fence (undici loads, nothing goes on the network), take the
 * dispatcher from these slots, and bind it into that init in place of the dead one. Until then
 * ports.fetch serves data: URLs only.
 */
const UNDICI_DISPATCHERS: readonly symbol[] = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
/** undici resolves a relative URL against this slot; locked empty, so no module can pick the origin. */
const UNDICI_ORIGIN = Symbol.for('undici.globalOrigin.1');
const DISPATCHER_METHODS: readonly string[] = ['dispatch', 'request', 'stream', 'pipeline', 'connect', 'upgrade', 'close', 'destroy', 'compose'];
// Left alone on purpose, for the planned runtime/process-powers.ts table: process.emit and
// process.listeners reach the stop handler, but stopping now ends the process (working.ts), so they
// cannot drop the lock and leave the daemon running; exit, reallyExit and abort end it too.

export type FenceStatus = {
  /** False when module.registerHooks is missing; boot then refuses to load main.ts. */
  resolveHook: boolean;
  builtinGetter: true;
  nativeStubs: true;
  /** process.loadEnvFile and process.report: file reads and writes outside both fs gates. */
  ioStubs: true;
  networkGlobals: true;
  /** process.kill and process._kill: no module needs them, and they would bypass the identity-checked brake. */
  killStubs: true;
  /** process._debugProcess, _debugEnd, _getActiveHandles and _getActiveRequests (DEBUG_POWERS). */
  debugStubs: true;
  /** Both undici global dispatcher slots hold a frozen stub (UNDICI_DISPATCHERS). */
  dispatcherStubs: true;
  /** undici's global origin slot is locked empty (UNDICI_ORIGIN). */
  originLock: true;
};

export type ImportDenyReason =
  | 'forbidden-everywhere'
  | 'not-allowed-for-module'
  | 'getter'
  | 'disabled'
  | 'import-attributes'
  | 'not-file-url'
  | 'not-code-module'
  | 'outside-repo-module';

export class ImportFenceError extends Error {
  readonly code = 'ERR_ORCHESTRA_IMPORT_FENCE';
  readonly reason: ImportDenyReason;
  constructor(reason: ImportDenyReason, what: string, by: string) {
    super(`[ERR_ORCHESTRA_IMPORT_FENCE] ${what} denied (${reason}) for ${by}`);
    this.reason = reason;
  }
}

export type ImportDecision =
  | { allow: true; url: string; module: string | null }
  | { allow: false; url: string; module: string | null; reason: ImportDenyReason };

const inModuleDirs = (key: string | null) => key !== null && MODULE_DIRS.some((d) => key.startsWith(d));

/**
 * May the module at `parentURL` load the resolved `url`? Builtins follow builtin-policy.ts. Anything
 * else must be a .ts or .js file: URL loaded without import attributes, so the loader never reads
 * data (a JSON file, say) past the read gate. A module under src/ or shared/ loads only modules
 * there, except the one dynamic import of each loader.
 */
export function decideImport(
  parentURL: string | undefined,
  url: string,
  attributes: Readonly<Record<string, unknown>> | undefined,
  repoRoot: URL = REPO_ROOT,
): ImportDecision {
  const module = moduleKeyFromUrl(parentURL, repoRoot);
  const deny = (reason: ImportDenyReason): ImportDecision => ({ allow: false, url, module, reason });
  if (attributes !== undefined && Object.keys(attributes).length > 0) return deny('import-attributes');
  if (url.startsWith('node:')) {
    const d = decideBuiltin(module, url);
    return d.allow ? { allow: true, url, module } : deny(d.reason);
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return deny('not-file-url');
  }
  if (u.protocol !== 'file:') return deny('not-file-url');
  const pathname = u.pathname.toLowerCase();
  if (!CODE_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return deny('not-code-module');
  if (inModuleDirs(module) && !LOADERS.includes(module!) && !inModuleDirs(moduleKeyFromUrl(url, repoRoot))) {
    return deny('outside-repo-module');
  }
  return { allow: true, url, module };
}

type ResolveContext = { parentURL?: string; importAttributes?: Record<string, unknown> };
type ResolveResult = { url: string };
type HookModule = {
  registerHooks?: (hooks: {
    resolve(specifier: string, context: ResolveContext, next: (s: string, c?: ResolveContext) => ResolveResult): ResolveResult;
  }) => unknown;
};
type Fenced = Record<PropertyKey, unknown>;

function lock(target: Fenced, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
}

// A function expression, not an arrow: `new WebSocket(...)` must reach the typed error too.
function disabled(what: string): () => never {
  return function disabledByFence(): never {
    throw new ImportFenceError('disabled', what, '<any module>');
  };
}

/** A frozen undici dispatcher whose every method throws: the slot stub, and ports.fetch's bound dispatcher until step 15. */
export function deadDispatcher(): object {
  return Object.freeze(Object.fromEntries(DISPATCHER_METHODS.map((m) => [m, disabled(`undici dispatcher .${m}`)])));
}

/**
 * Installs the import fence on this thread. Must run before the module graph it guards is
 * resolved: boot.ts calls it before importing main.ts, workers/bootstrap.ts before the worker module.
 * Idempotent per process object (each worker has its own). `global` gets its network globals and
 * the undici dispatcher slots locked.
 */
export function installImportFence(
  proc: object = process,
  mod: HookModule = nodeModule as unknown as HookModule,
  repoRoot: URL = REPO_ROOT,
  global: object = globalThis,
): FenceStatus {
  const p = proc as Fenced;
  const prior = p[INSTALLED] as FenceStatus | undefined;
  if (prior !== undefined) return prior;

  let resolveHook = false;
  if (typeof mod.registerHooks === 'function') {
    mod.registerHooks({
      resolve(specifier, context, next) {
        const result = next(specifier, context);
        const d = decideImport(context.parentURL, result.url, context.importAttributes, repoRoot);
        if (!d.allow) {
          const what = result.url.startsWith('node:') ? builtinId(result.url) : result.url;
          throw new ImportFenceError(d.reason, what, d.module ?? context.parentURL ?? '<entry>');
        }
        return result;
      },
    });
    resolveHook = true;
  }

  // No module needs the getter, so it is not keyed by caller: only the default builtins come back.
  const original = p.getBuiltinModule as ((id: string) => unknown) | undefined;
  lock(p, 'getBuiltinModule', (id: string): unknown => {
    const builtin = builtinId(String(id));
    if (isDefaultBuiltin(builtin) && typeof original === 'function') return original.call(proc, builtin);
    throw new ImportFenceError('getter', builtin, '<process.getBuiltinModule>');
  });
  for (const name of ['binding', '_linkedBinding', 'dlopen']) lock(p, name, disabled(`process.${name}`));
  lock(p, 'loadEnvFile', disabled('process.loadEnvFile'));
  // Frozen in strict mode: setting directory, filename or a reportOn* flag throws instead of arming a write.
  lock(p, 'report', Object.freeze({ writeReport: disabled('process.report.writeReport'), getReport: disabled('process.report.getReport') }));
  // Children are stopped through their own ChildProcess handle (src/os/) and, from step 6, through
  // procguard's pid + createTime kill-tree. A raw signal by pid skips both checks (invariant 7).
  for (const name of ['kill', '_kill']) lock(p, name, disabled(`process.${name}`));
  for (const name of DEBUG_POWERS) lock(p, name, disabled(`process.${name}`));
  // boot.ts keeps the one network capability it hands on before this runs; nobody else gets one.
  for (const name of NETWORK_GLOBALS) lock(global as Fenced, name, disabled(name));
  // A slot undici already filled is writable but not configurable, so it is locked the same way.
  const dispatcher = deadDispatcher();
  for (const slot of UNDICI_DISPATCHERS) lock(global as Fenced, slot, dispatcher);
  lock(global as Fenced, UNDICI_ORIGIN, undefined);

  const status: FenceStatus = Object.freeze({
    resolveHook, builtinGetter: true, nativeStubs: true, ioStubs: true, networkGlobals: true, killStubs: true, debugStubs: true, dispatcherStubs: true, originLock: true,
  });
  lock(p, INSTALLED, status);
  return status;
}
