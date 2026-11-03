import type { RealpathFn } from '../fs/paths.ts';
import { checkPath, isWithin, pathKey } from '../fs/paths.ts';
import { frozen } from '../../shared/frozen.js';

// Project roots (orchestra app plan 项目根; --project-root, only with --owned): directories the person
// names at startup, in which an owned session may be started (or in a folder inside one) instead of
// Orchestra's own ORCHESTRA_HOME\work\<id>. None unless named: without the flag nothing here runs and the
// owned sessions work only in the work root, as before.
//
// checkProjectRoots holds each named root, at startup and before the lock, to what a cwd must be: a plain
// absolute path (bad-path), no drive root, not refused by the spawn gate's own cwd table (src/os/cwd.ts
// rootHit: the user profile itself, AppData, the system dirs, Program Files, this repository and its
// parents, the data dir, a harness root; in the test profile anything not strictly inside the test dir),
// there (not-found), its own realpath (no junction, link or 8.3 name on it: reparsed), a directory
// (not-a-directory), and not named twice under another spelling (duplicate). The first root that fails
// refuses the start, with the root and why; nothing is made or started for it.
//
// placeRunIn says whether an owned session may run in the cwd an agent request names (seat): only inside
// a root (the root itself or below it), compared after normalization and case-insensitively, with no `..`
// segment in what the agent wrote, its realpath its own (no link escape), passed by the cwd table and a
// directory. Otherwise it says why, and the session runs in Orchestra's own work dir, as before.

/** Why a named project root refuses the start. */
export type ProjectRootWhy = 'bad-path' | 'drive-root' | 'outside-test-dir' | 'protected' | 'not-found' | 'reparsed' | 'not-a-directory' | 'stat-refused' | 'duplicate';
export type ProjectRootsVerdict = { ok: true; roots: readonly string[] } | { ok: false; root: string; why: ProjectRootWhy; detail: string | null };

export type ProjectRootsDeps = {
  realpath: RealpathFn;
  /** The cwd table's word on a candidate root (CwdPolicy.rootHit of a policy with no project roots): a row's label, or null. */
  rootHit(p: string): string | null;
  /** Whether `p` (already resolved, its own realpath) is a directory; throws when it cannot be told (the read gate's reason). */
  isDirectory(p: string): boolean;
};

function errCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const o = e as { code?: unknown; decision?: { reason?: unknown } };
    if (o.decision !== undefined && typeof o.decision.reason === 'string') return o.decision.reason;
    if (o.code !== undefined) return String(o.code);
  }
  return String(e);
}

/** The named roots in order, each checked; the first that fails refuses them all. */
export function checkProjectRoots(given: readonly string[], deps: ProjectRootsDeps): ProjectRootsVerdict {
  const out: string[] = [];
  for (const raw of given) {
    const no = (why: ProjectRootWhy, detail: string | null = null): ProjectRootsVerdict => ({ ok: false, root: raw, why, detail });
    const c = checkPath(raw);
    if (!c.ok) return no('bad-path', c.reason);
    const p = c.path;
    if (p.length === 3) return no('drive-root', p);
    // The table first, on the name as given: in the test profile a root outside the test dir is refused
    // before its realpath is ever taken (as the read gate drops such a root unseen).
    const hit = deps.rootHit(p);
    if (hit === 'outside-test-dir') return no('outside-test-dir', p);
    if (hit === 'drive-root') return no('drive-root', p);
    if (hit !== null && hit.startsWith('bad-path:')) return no('bad-path', hit.slice('bad-path:'.length));
    if (hit !== null) return no('protected', hit);
    let real: string;
    try {
      real = deps.realpath(p);
    } catch (e) {
      return no('not-found', errCode(e));
    }
    if (pathKey(real.length > 3 ? real.replace(/\\+$/, '') : real) !== pathKey(p)) return no('reparsed', real);
    let dir: boolean;
    try {
      dir = deps.isDirectory(p);
    } catch (e) {
      const code = errCode(e);
      return code === 'not-found' || code === 'ENOENT' ? no('not-found', code) : no('stat-refused', code);
    }
    if (!dir) return no('not-a-directory', p);
    if (out.some((r) => pathKey(r) === pathKey(p))) return no('duplicate', p);
    out.push(p);
  }
  return { ok: true, roots: Object.freeze(out) };
}

/** What a refused root's why says on the console. */
export const PROJECT_ROOT_WHY_TEXT: Readonly<Record<ProjectRootWhy, string>> = frozen({
  'bad-path': 'not a plain absolute path',
  'drive-root': 'a drive root',
  'outside-test-dir': 'not inside the test dir (the test profile only takes project roots there)',
  protected: 'a protected place (the cwd table refuses it)',
  'not-found': 'it does not exist',
  reparsed: 'not its own real path (a junction, a link or an 8.3 short name on it)',
  'not-a-directory': 'not a directory',
  'stat-refused': 'the read gate would not look at it',
  duplicate: 'named twice',
});

/** Why an agent request's cwd does not run in a project root (the card says it; the session runs in the work dir). */
export type RunInWhy = 'no-roots' | 'bad-path' | 'dot-segments' | 'outside-roots' | 'protected' | 'reparsed' | 'not-found' | 'not-a-directory' | 'redacted';
export type RunIn = { runIn: string; why: null } | { runIn: null; why: RunInWhy };

export type RunInDeps = {
  /** The roots checkProjectRoots let through (canonical). */
  roots: readonly string[];
  /** The spawn gate's cwd table on a cwd (CwdPolicy.check of the owned sessions' policy, whose allowed roots hold the project roots). */
  check(p: string): { ok: true; path: string } | { ok: false; reason: string };
  /** Whether `p` is a directory (the stat-only project-root read gate); throws when it cannot be told. */
  isDirectory(p: string): boolean;
};

/** Where an owned session for this cwd would run: in it, when it lies in a project root and passes; else null and why. */
export function placeRunIn(cwd: string, deps: RunInDeps): RunIn {
  const no = (why: RunInWhy): RunIn => ({ runIn: null, why });
  if (deps.roots.length === 0) return no('no-roots');
  if (typeof cwd !== 'string') return no('bad-path');
  // What the agent wrote, before normalization: a `..` segment never counts, wherever it leads.
  if (cwd.split(/[\\/]/).some((seg) => seg === '..')) return no('dot-segments');
  const c = checkPath(cwd);
  if (!c.ok) return no('bad-path');
  const p = c.path;
  if (!deps.roots.some((r) => isWithin(p, r))) return no('outside-roots');
  const v = deps.check(p);
  if (!v.ok) return no(v.reason === 'reparsed' ? 'reparsed' : v.reason === 'unresolved' ? 'not-found' : v.reason === 'outside-allowed' ? 'outside-roots' : v.reason === 'bad-path' ? 'bad-path' : 'protected');
  // The table compared the realpath with the name: equal, so the real path lies in the root too.
  let dir: boolean;
  try {
    dir = deps.isDirectory(v.path);
  } catch {
    return no('not-found');
  }
  return dir ? { runIn: v.path, why: null } : no('not-a-directory');
}
