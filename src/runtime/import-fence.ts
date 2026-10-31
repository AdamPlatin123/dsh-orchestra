import * as nodeModule from 'node:module';
import type { Power } from './process-powers.ts';
import { builtinId, decideBuiltin, isDefaultBuiltin, isMinted, moduleKeyFromUrl } from './builtin-policy.ts';
import { GLOBAL_POWERS, PROCESS_POWERS, isFenced, slotOf } from './process-powers.ts';

const REPO_ROOT = new URL('../../', import.meta.url);
const INSTALLED = Symbol.for('orchestra.importFence');

/** Repo code lives here; a module in these dirs imports only modules in these dirs. */
const MODULE_DIRS: readonly string[] = ['src/', 'shared/'];
/** Their one dynamic import loads a caller-given module: the entry (boot) or a worker target (bootstrap). */
const LOADERS: readonly string[] = ['src/boot.ts', 'src/workers/bootstrap.ts'];
const CODE_EXTENSIONS: readonly string[] = ['.ts', '.js'];
const DISPATCHER_METHODS: readonly string[] = ['dispatch', 'request', 'stream', 'pipeline', 'connect', 'upgrade', 'close', 'destroy', 'compose'];

export type FenceStatus = {
  /** False when module.registerHooks is missing; boot then refuses to load main.ts. */
  resolveHook: boolean;
  /**
   * Slots this install made read-only from the process-powers table: every lock and mint entry and
   * every pinned keep entry that is not optional, plus the optional ones present on this thread
   * (BASE_LOCKS without IPC, web storage or --permission).
   */
  locks: number;
};

export type ImportDenyReason =
  | 'forbidden-everywhere'
  | 'not-allowed-for-module'
  | 'getter'
  | 'disabled'
  | 'import-attributes'
  | 'not-file-url'
  | 'not-code-module'
  | 'outside-repo-module'
  | 'minted-before-fence';

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
 * there, except the one dynamic import of each loader. A minted module (builtin-policy.ts) is loaded
 * by boot.ts before the fence and by nobody after it, whoever asks and however the URL is spelled
 * (query and hash do not change the module key).
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
  if (isMinted(moduleKeyFromUrl(url, repoRoot))) return deny('minted-before-fence');
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

/** Freezes a slot with the value it holds; its enumerability stays as Node made it. */
function pin(target: Fenced, name: PropertyKey): void {
  Object.defineProperty(target, name, { value: target[name], writable: false, configurable: false });
}

// A function expression, not an arrow: `new` on a locked class must reach the typed error too.
function disabled(what: string): () => never {
  return function disabledByFence(): never {
    throw new ImportFenceError('disabled', what, '<any module>');
  };
}

/** A frozen undici dispatcher whose every method throws: the slot stub, and the dispatcher boot binds into its network port until step 15. */
export function deadDispatcher(): object {
  return Object.freeze(Object.fromEntries(DISPATCHER_METHODS.map((m) => [m, disabled(`undici dispatcher .${m}`)])));
}

/** What the slot of a lock or mint entry on `target` gets (process-powers.ts, Stub). */
function stubOf(e: Power, target: Fenced, proc: object, dispatcher: object): unknown {
  if (e.class === 'keep') throw new Error(`import fence: ${e.key} is a keep entry`);
  const what = target === proc ? `process.${e.key}` : e.key;
  switch (e.stub) {
    case 'throws':
      return disabled(what);
    case 'builtin-getter': {
      // No module needs the getter, so it is not keyed by caller: only the default builtins come back.
      const original = target[slotOf(e)] as ((id: string) => unknown) | undefined;
      return (id: string): unknown => {
        const builtin = builtinId(String(id));
        if (isDefaultBuiltin(builtin) && typeof original === 'function') return original.call(proc, builtin);
        throw new ImportFenceError('getter', builtin, '<the builtin getter>');
      };
    }
    case 'report':
      // Frozen in strict mode: setting directory, filename or a reportOn* flag throws instead of arming a write.
      return Object.freeze({ writeReport: disabled(`${what}.writeReport`), getReport: disabled(`${what}.getReport`) });
    case 'dead-dispatcher':
      return dispatcher;
    case 'empty':
      return undefined;
  }
}

/**
 * Makes the slot of every fenced entry (process-powers.ts, isFenced) on `target` read-only: a lock or
 * mint entry gets its stub, a pinned keep entry keeps its value. An optional entry is fenced only
 * where it exists. A slot undici already filled is writable but not configurable and is locked the
 * same way; one Node made neither writable nor configurable throws, and the install with it (fail
 * closed). Returns how many slots it fenced.
 */
function applyPowers(target: Fenced, entries: readonly Power[], proc: object, dispatcher: object): number {
  let fenced = 0;
  for (const e of entries) {
    if (!isFenced(e)) continue;
    const slot = slotOf(e);
    if (e.optional !== undefined && !Object.hasOwn(target, slot)) continue;
    if (e.class === 'keep') pin(target, slot);
    else lock(target, slot, stubOf(e, target, proc, dispatcher));
    fenced++;
  }
  return fenced;
}

/**
 * Installs the import fence on this thread. Must run before the module graph it guards is
 * resolved: boot.ts calls it before importing main.ts, workers/bootstrap.ts before the worker module.
 * Idempotent per process object (each worker has its own). `proc` and `global` get the slots the
 * process-powers table fences; boot.ts takes the originals of the mint entries before this runs.
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

  // Builtins whose first load assigns a slot the table fences load now, while the slot still takes it.
  const loadBuiltin = p.getBuiltinModule;
  if (typeof loadBuiltin === 'function') {
    for (const e of [...PROCESS_POWERS, ...GLOBAL_POWERS]) if (isFenced(e) && e.primedBy !== undefined) loadBuiltin.call(proc, e.primedBy);
  }
  // One dead dispatcher serves every dispatcher slot of an install.
  const dispatcher = deadDispatcher();
  const locks = applyPowers(p, PROCESS_POWERS, proc, dispatcher) + applyPowers(global as Fenced, GLOBAL_POWERS, proc, dispatcher);
  const status: FenceStatus = Object.freeze({ resolveHook, locks });
  lock(p, INSTALLED, status);
  return status;
}
