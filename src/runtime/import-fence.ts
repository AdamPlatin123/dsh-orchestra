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

export type FenceStatus = {
  /** False when module.registerHooks is missing; boot then refuses to load main.ts. */
  resolveHook: boolean;
  builtinGetter: true;
  nativeStubs: true;
  /** process.loadEnvFile and process.report: file reads and writes outside both fs gates. */
  ioStubs: true;
  networkGlobals: true;
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

/**
 * Installs the import fence on this thread. Must run before the module graph it guards is
 * resolved: boot.ts calls it before importing main.ts, workers/bootstrap.ts before the worker module.
 * Idempotent per process object (each worker has its own). `global` gets its network globals locked.
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
  // boot.ts keeps the one network capability it hands on before this runs; nobody else gets one.
  for (const name of NETWORK_GLOBALS) lock(global as Fenced, name, disabled(name));

  const status: FenceStatus = Object.freeze({ resolveHook, builtinGetter: true, nativeStubs: true, ioStubs: true, networkGlobals: true });
  lock(p, INSTALLED, status);
  return status;
}
