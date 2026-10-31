// The one table of which module may use which Node builtin. The static scan
// (test/repo/static-scan.test.ts) and the runtime import fence (import-fence.ts) both read it.
// Adding a row needs a reason in the commit message.

export type BuiltinRow = {
  /** Repo-relative module paths; a trailing `/*` means every file directly in that directory. */
  modules: readonly string[];
  allow: readonly string[];
  /** Named imports a module may take from a builtin it is allowed (checked by the static scan). */
  only?: Readonly<Record<string, readonly string[]>>;
};

export const DEFAULT_BUILTINS: readonly string[] = [
  'node:path', 'node:url', 'node:events', 'node:util', 'node:crypto', 'node:zlib', 'node:timers',
];

export const FORBIDDEN_BUILTINS: readonly string[] = [
  'node:vm', 'node:wasi', 'node:inspector', 'node:repl', 'node:cluster',
];

export const BUILTIN_ROWS: readonly BuiltinRow[] = [
  { modules: ['src/fs/*'], allow: ['node:fs', 'node:fs/promises'] },
  { modules: ['src/fs/write-fence.ts'], allow: ['node:os'], only: { 'node:os': ['tmpdir'] } },
  { modules: ['src/os/spawn.ts'], allow: ['node:child_process'] },
  { modules: ['src/store/db.ts'], allow: ['node:sqlite'] },
  { modules: ['src/runtime/lock.ts'], allow: ['node:net'], only: { 'node:net': ['createServer'] } },
  { modules: ['src/server/http.ts'], allow: ['node:http', 'node:net'], only: { 'node:http': ['createServer'], 'node:net': ['createServer'] } },
  { modules: ['src/runtime/workers.ts', 'src/workers/bootstrap.ts'], allow: ['node:worker_threads'] },
  { modules: ['src/runtime/import-fence.ts', 'src/runtime/features.ts'], allow: ['node:module'] },
  { modules: ['src/main.ts'], allow: ['node:os'], only: { 'node:os': ['homedir', 'totalmem'] } },
];

export type BuiltinDecision =
  | { allow: true; builtin: string; module: string | null }
  | { allow: false; builtin: string; module: string | null; reason: 'forbidden-everywhere' | 'not-allowed-for-module' };

/** `fs` and `node:fs` are the same builtin; ids are kept with the `node:` prefix. */
export function builtinId(specifier: string): string {
  return specifier.startsWith('node:') ? specifier : `node:${specifier}`;
}

function rowMatches(pattern: string, module: string): boolean {
  if (pattern.endsWith('/*')) {
    const dir = pattern.slice(0, -1);
    return module.startsWith(dir) && !module.slice(dir.length).includes('/');
  }
  return pattern === module;
}

export function rowsFor(module: string | null): BuiltinRow[] {
  if (module === null) return [];
  const key = module.toLowerCase();
  return BUILTIN_ROWS.filter((r) => r.modules.some((m) => rowMatches(m, key)));
}

export function isForbidden(id: string): boolean {
  return FORBIDDEN_BUILTINS.some((f) => id === f || id.startsWith(`${f}/`));
}

export function isDefaultBuiltin(id: string): boolean {
  return DEFAULT_BUILTINS.includes(id);
}

/**
 * May `module` (repo-relative, forward slashes; null for anything outside the repo) use `specifier`?
 * Exact ids only: `node:fs` does not imply `node:fs/promises`. The forbidden list wins over every row.
 */
export function decideBuiltin(module: string | null, specifier: string): BuiltinDecision {
  const id = builtinId(specifier);
  if (isForbidden(id)) return { allow: false, builtin: id, module, reason: 'forbidden-everywhere' };
  if (isDefaultBuiltin(id)) return { allow: true, builtin: id, module };
  if (rowsFor(module).some((r) => r.allow.includes(id))) return { allow: true, builtin: id, module };
  return { allow: false, builtin: id, module, reason: 'not-allowed-for-module' };
}

/** Named-import restriction for (module, builtin), if any. */
export function onlyNames(module: string, id: string): readonly string[] | undefined {
  for (const r of rowsFor(module)) {
    const names = r.only?.[id];
    if (names !== undefined) return names;
  }
  return undefined;
}

/**
 * Repo-relative module key for a module URL, or null when the URL is not a file inside `repoRoot`.
 * Query and hash are ignored: the policy follows the file, not the URL it was loaded under.
 */
export function moduleKeyFromUrl(url: string | undefined, repoRoot: URL): string | null {
  if (url === undefined) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'file:') return null;
  const base = repoRoot.pathname.toLowerCase();
  const pathname = u.pathname.toLowerCase();
  if (!pathname.startsWith(base)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(base.length));
  } catch {
    return null;
  }
  if (rel.length === 0 || rel.split('/').some((s) => s === '..' || s === '.')) return null;
  return rel;
}
