import * as path from 'node:path';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { PathRejectReason, RealpathFn } from '../fs/paths.ts';
import type { WriteFence } from '../fs/write-fence.ts';
import { canonicalize, checkPath, isWithin, pathKey } from '../fs/paths.ts';
import { ownFields } from './own.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// ORCHESTRA_HOME and the harness roots never contain one another (plan §6 invariant 5, r4 §5.3
// r4:600). Checked once at startup and again whenever Tuning adds or confirms a root. The check
// only reads (realpath); creating the data dir happens later, under the lock, through the fence.

export type DataDirRefusal =
  | { reason: 'bad-path'; what: 'orchestra-home' | 'user-home' | 'test-dir'; path: string; detail: PathRejectReason }
  | { reason: 'canonicalize-failed'; what: 'orchestra-home' | 'user-home' | 'harness-root' | 'test-dir'; path: string; detail: string }
  | { reason: 'roots-unavailable'; detail: string }
  | { reason: 'test-dir-escape'; what: 'test-dir' | 'orchestra-home' | 'harness-root'; path: string; real: string; testDir: string }
  | { reason: 'drive-root'; home: string }
  | { reason: 'contains-user-home'; home: string; userHome: string }
  | { reason: 'inside-harness-root'; home: string; root: string }
  | { reason: 'contains-harness-root'; home: string; root: string };

export type DataDirCheck = { ok: true; home: string; homeReal: string } | ({ ok: false } & DataDirRefusal);

export type DataDirInput = {
  orchestraHome: string;
  userHome: string;
  /** Every known harness root (computeHarnessRoots, or the test profile's roots). */
  roots: readonly HarnessRoot[];
  /**
   * Test profile only: the canonical test dir. ORCHESTRA_HOME must lie strictly inside it, and it
   * and every root below it must be their own canonical form: nothing under the test dir may be a
   * junction that leads out of it (D8 r4:492, plan §6 invariant 18).
   */
  testDir?: string;
  /** Required: the realpath port main.ts got from boot (src/fs/node-io.ts), or a test's own. */
  realpath: RealpathFn;
};

const INPUT_KEYS = ['orchestraHome', 'userHome', 'roots', 'testDir', 'realpath'] as const;

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

const isDriveRoot = (p: string) => /^[A-Za-z]:\\?$/.test(p);

type Forms = { ok: true; forms: string[] } | { ok: false; detail: string };

function forms(p: string, realpath: RealpathFn): Forms {
  try {
    const real = canonicalize(p, realpath);
    return { ok: true, forms: pathKey(real) === pathKey(p) ? [p] : [p, real] };
  } catch (e) {
    return { ok: false, detail: errCode(e) };
  }
}

const anyWithin = (as: readonly string[], bs: readonly string[]) => as.some((a) => bs.some((b) => isWithin(a, b)));

/** The test profile's confinement (DataDirInput.testDir); null when it holds. */
function testDirEscape(testDir: string, home: string, homeForms: readonly string[], roots: readonly HarnessRoot[], realpath: RealpathFn): DataDirCheck | null {
  const t = checkPath(testDir);
  if (!t.ok) return { ok: false, reason: 'bad-path', what: 'test-dir', path: String(testDir), detail: t.reason };
  const tf = forms(t.path, realpath);
  if (!tf.ok) return { ok: false, reason: 'canonicalize-failed', what: 'test-dir', path: t.path, detail: tf.detail };
  const escape = (what: 'test-dir' | 'orchestra-home' | 'harness-root', p: string, real: string): DataDirCheck =>
    ({ ok: false, reason: 'test-dir-escape', what, path: p, real, testDir: t.path });
  if (tf.forms.length > 1) return escape('test-dir', t.path, tf.forms[1]!);
  const strictlyInside = isWithin(home, t.path) && pathKey(home) !== pathKey(t.path);
  if (homeForms.length > 1 || !strictlyInside) return escape('orchestra-home', home, homeForms[homeForms.length - 1]!);
  for (const r of roots) {
    if (!isWithin(r.path, t.path)) continue;
    const rf = forms(r.path, realpath);
    if (!rf.ok) return { ok: false, reason: 'canonicalize-failed', what: 'harness-root', path: r.path, detail: rf.detail };
    if (rf.forms.length > 1 || pathKey(r.real) !== pathKey(r.path)) return escape('harness-root', r.path, rf.forms.length > 1 ? rf.forms[1]! : r.real);
  }
  return null;
}

/**
 * The refusals, in this order: (test profile) something under the test dir leads out of it;
 * ORCHESTRA_HOME is a drive root; it is or contains the user's home; it lies inside a harness root;
 * it contains one. Each compares the path as written and its canonical form (junctions, 8.3
 * names), case-insensitively. The first one that holds is reported.
 */
export function checkDataDir(given: DataDirInput): DataDirCheck {
  // Own fields only: a testDir the caller left out reads undefined, never Object.prototype's.
  const input = ownFields(given, INPUT_KEYS);
  const realpath = input.realpath;
  if (typeof realpath !== 'function') throw new Error('data dir check: realpath is required');
  const roots = input.roots!;
  const h = checkPath(input.orchestraHome as string);
  if (!h.ok) return { ok: false, reason: 'bad-path', what: 'orchestra-home', path: String(input.orchestraHome), detail: h.reason };
  const home = h.path;
  const hf = forms(home, realpath);
  if (!hf.ok) return { ok: false, reason: 'canonicalize-failed', what: 'orchestra-home', path: home, detail: hf.detail };
  if (input.testDir !== undefined) {
    const escaped = testDirEscape(input.testDir, home, hf.forms, roots, realpath);
    if (escaped !== null) return escaped;
  }
  if (hf.forms.some(isDriveRoot)) return { ok: false, reason: 'drive-root', home };
  const u = checkPath(input.userHome as string);
  if (!u.ok) return { ok: false, reason: 'bad-path', what: 'user-home', path: String(input.userHome), detail: u.reason };
  const uf = forms(u.path, realpath);
  if (!uf.ok) return { ok: false, reason: 'canonicalize-failed', what: 'user-home', path: u.path, detail: uf.detail };
  if (anyWithin(uf.forms, hf.forms)) return { ok: false, reason: 'contains-user-home', home, userHome: u.path };
  const rootForms: { root: string; forms: string[] }[] = [];
  for (const r of roots) {
    const rf = forms(r.real, realpath);
    if (!rf.ok) return { ok: false, reason: 'canonicalize-failed', what: 'harness-root', path: r.path, detail: rf.detail };
    rootForms.push({ root: r.path, forms: [...new Set([r.path, ...rf.forms])] });
  }
  for (const r of rootForms) if (anyWithin(hf.forms, r.forms)) return { ok: false, reason: 'inside-harness-root', home, root: r.root };
  for (const r of rootForms) if (anyWithin(r.forms, hf.forms)) return { ok: false, reason: 'contains-harness-root', home, root: r.root };
  return { ok: true, home, homeReal: hf.forms[hf.forms.length - 1]! };
}

export type NewRootCheck =
  | { ok: true; root: string }
  | { ok: false; reason: 'bad-path'; root: string; detail: PathRejectReason }
  | { ok: false; reason: 'canonicalize-failed'; root: string; detail: string }
  | { ok: false; reason: 'root-inside-home' | 'home-inside-root'; root: string; home: string };

/** A root added while running (Tuning) is refused outright when it and ORCHESTRA_HOME overlap. */
export function checkNewRoot(dataDir: { home: string; homeReal: string }, root: string, realpath: RealpathFn): NewRootCheck {
  const c = checkPath(root);
  if (!c.ok) return { ok: false, reason: 'bad-path', root: String(root), detail: c.reason };
  const rf = forms(c.path, realpath);
  if (!rf.ok) return { ok: false, reason: 'canonicalize-failed', root: c.path, detail: rf.detail };
  const hf = [...new Set([dataDir.home, dataDir.homeReal])];
  if (anyWithin(rf.forms, hf)) return { ok: false, reason: 'root-inside-home', root: c.path, home: dataDir.home };
  if (anyWithin(hf, rf.forms)) return { ok: false, reason: 'home-inside-root', root: c.path, home: dataDir.home };
  return { ok: true, root: c.path };
}

export const DATA_SUBDIRS = frozen(['run', 'tmp', 'runtime'] as const);

export type PreparedDataDir = { home: string; run: string; tmp: string; runtime: string; created: string[]; tmpEntriesRemoved: number };

/**
 * Creates ORCHESTRA_HOME\{run,tmp,runtime} and empties tmp\ with the fence's safe rm (links are
 * removed as entries, never entered). Runs only while the single-writer lock is held, so it never
 * clears the tmp\ of a running instance.
 */
export function prepareDataDir(fence: WriteFence, home: string): PreparedDataDir {
  const created = fence.mkdirp(home);
  const dirs = Object.fromEntries(DATA_SUBDIRS.map((d) => [d, win.join(home, d)])) as Record<(typeof DATA_SUBDIRS)[number], string>;
  for (const d of DATA_SUBDIRS) created.push(...fence.mkdirp(dirs[d]));
  const removed = fence.rm(dirs.tmp, { recursive: true }).removed;
  fence.mkdirp(dirs.tmp);
  return { home, run: dirs.run, tmp: dirs.tmp, runtime: dirs.runtime, created, tmpEntriesRemoved: Math.max(0, removed - 1) };
}

export function describeDataDir(c: Extract<DataDirCheck, { ok: false }>): string {
  switch (c.reason) {
    case 'bad-path':
      return `${c.what} rejected (${c.detail}): ${c.path}`;
    case 'canonicalize-failed':
      return `cannot resolve ${c.what} (${c.detail}): ${c.path}`;
    case 'roots-unavailable':
      return `harness roots could not be listed (${c.detail})`;
    case 'test-dir-escape':
      return `${c.what} ${c.path} resolves to ${c.real}; in the test profile nothing below ${c.testDir} may lead elsewhere`;
    case 'drive-root':
      return `ORCHESTRA_HOME is a drive root: ${c.home}`;
    case 'contains-user-home':
      return `ORCHESTRA_HOME ${c.home} is or contains the user home ${c.userHome}`;
    case 'inside-harness-root':
      return `ORCHESTRA_HOME ${c.home} lies inside the harness root ${c.root}`;
    case 'contains-harness-root':
      return `ORCHESTRA_HOME ${c.home} contains the harness root ${c.root}`;
  }
}
