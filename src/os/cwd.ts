import * as path from 'node:path';
import type { RealpathFn } from '../fs/paths.ts';
import { canonicalize, checkPath, isWithin, pathKey } from '../fs/paths.ts';
import { envGet, ownFields } from '../runtime/own.ts';
import { frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// Where a child the gate starts with a caller-chosen working directory may run (alpha 0.2 design §2.1,
// §5 "cwd"; r4 §5.3). Two layers, both fail closed:
//  1. a rejection table the gate builds itself: drive roots; the user profile itself and its AppData,
//     .ssh, .aws, .claude, .dsh; a redirected %APPDATA% / %LOCALAPPDATA%; %SystemRoot%; Program Files*;
//     this repository, its main checkout when this is a worktree, and spec.repoRoots; and the directories the
//     composition root names (r4 §5.3: the Orchestra data dir, every DSH_HOME, every CLAUDE_CONFIG_DIR).
//     A cwd is refused when it lies inside a table entry or contains one, so a parent of a protected
//     directory (C:\Users, the folder holding this repo) is refused too.
//  2. an allow list of roots, handed in at construction: the owned work root, and the project roots the
//     person named at startup (--project-root, orchestra app plan 项目根; none unless named). An empty list
//     allows nothing.
// The cwd must exist and be its own realpath: no junction or link anywhere on it.
//
// One exemption (orchestra app plan §2): the owned sessions' work root, ORCHESTRA_HOME\work, which
// orchestrad makes itself. A cwd inside it is not refused for lying inside AppData (the test profile's
// data dir sits in %TEMP%, below %LOCALAPPDATA%; a real ORCHESTRA_HOME may sit there too), nor for lying
// inside the protected dir that is the work root's own parent (the data dir). Every other row still
// applies to it, and nowhere else is either row relaxed. The policy itself holds the exemption to that
// one directory: the work root must be named `work` (src/owned/codex-home.ts OWNED_DIRS.work) and sit
// directly in one of protectedDirs (the data dir), else the constructor throws.
//
// Project roots (--project-root): each is an allowed root, and the constructor holds each to the table
// itself (rootHit): no row may hit it, or the policy is not made. In the test profile (spec.testDir) a
// project root must lie strictly inside the test dir, and inside one the AppData row does not apply (the
// test dir sits in %TEMP%, below %LOCALAPPDATA%, as the work root's exemption says); every other row still
// does. The real profile has no such exemption: a project root in AppData (%TEMP% included) is refused.
//
// place() reads a path an owned session's approval names (a file it changes, a root it asks to write
// under, a command's cwd) against the same table: what the gate would refuse as a cwd there, an owned
// session may not touch either (orchestra app plan §4; slice design §2.2's protected paths).

export const PROFILE_SUBDIRS: readonly string[] = Object.freeze(['AppData', '.ssh', '.aws', '.claude', '.dsh']);
const PROGRAM_FILES_VARS: readonly string[] = Object.freeze(['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']);
const PROGRAM_FILES_TOP = /^program files/i;

/** This repository's root (src/os/../..): a child never runs in Orchestra's own code. */
export const REPO_ROOT = win.join(import.meta.dirname, '..', '..');

/**
 * The main checkout when this copy runs from a worktree Claude Code made (`<main>\.claude\worktrees\<name>`):
 * its src\, shared\, hosts\, .tools\ and the sibling worktrees are Orchestra's code too, yet none lies
 * inside REPO_ROOT. Found lexically (no file is read); a worktree kept elsewhere is named through
 * spec.repoRoots instead.
 */
export const MAIN_CHECKOUT: string | null = /^(.+?)\\\.claude\\worktrees\\[^\\]+$/i.exec(REPO_ROOT)?.[1] ?? null;

/** %APPDATA% and %LOCALAPPDATA%: where a redirected AppData (and the browser profiles in it) really is. */
const APPDATA_VARS: readonly string[] = Object.freeze(['APPDATA', 'LOCALAPPDATA']);

/** The owned work root's own name (src/owned/codex-home.ts OWNED_DIRS.work; a test holds the two equal). */
export const OWNED_WORK_NAME = 'work';

export type CwdRejectReason = 'bad-path' | 'drive-root' | 'protected' | 'unresolved' | 'reparsed' | 'outside-allowed';
export type CwdVerdict = { ok: true; path: string } | { ok: false; reason: CwdRejectReason; detail?: string };

export type CwdPolicySpec = {
  /** The only roots a cwd may lie in (the root itself included). An open decision; empty allows nothing. */
  allowedRoots: readonly string[];
  /** r4 §5.3: the Orchestra data dir, every DSH_HOME, every CLAUDE_CONFIG_DIR the composition root knows. */
  protectedDirs: readonly string[];
  /** The user's home (main.ts's `home`); %USERPROFILE% from the env source is added when it differs. */
  userHome: string;
  /** Other checkouts of Orchestra's code (a main checkout or worktree MAIN_CHECKOUT cannot find); refused like REPO_ROOT. */
  repoRoots?: readonly string[];
  /** The owned sessions' work root (ORCHESTRA_HOME\work); one of allowedRoots. See the exemption above. */
  ownedWorkRoot?: string;
  /** Project roots the person named (--project-root): allowed roots too, each held to the table (rootHit) at construction. */
  projectRoots?: readonly string[];
  /** The test profile's test dir: a project root must lie strictly inside it, and the AppData row does not apply there. */
  testDir?: string;
};

/**
 * `tree`: refused when the cwd is inside the entry or contains it. `self`: refused when the cwd is the
 * entry or contains it (the profile: its other subfolders stay possible, its protected ones are trees).
 */
type Entry = { kind: 'tree' | 'self'; label: string; path: string };

function mustPath(p: unknown, what: string): string {
  const c = checkPath(p as string);
  if (!c.ok) throw new Error(`cwd policy: ${what} rejected (${c.reason}): ${String(p)}`);
  return c.path;
}

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

function trimSep(p: string): string {
  return p.length > 3 ? p.replace(/\\+$/, '') : p;
}

export type CwdPolicyInput = {
  spec: CwdPolicySpec;
  /** The gate's env source; USERPROFILE and the Program Files variables are read from it once. */
  env: Readonly<Record<string, string | undefined>>;
  /** The proven %SystemRoot%. */
  systemRoot: string;
  realpath: RealpathFn;
};

export class CwdPolicy {
  readonly #table: readonly Entry[];
  readonly #allowed: readonly string[];
  readonly #realpath: RealpathFn;
  /** The work root in both forms, and its parent (the data dir) keyed in both forms; empty without one. */
  readonly #work: readonly string[];
  readonly #workParents: readonly string[];
  /** The test dir in both forms (test profile), else empty; the project roots, canonical. */
  readonly #testDir: readonly string[];
  readonly #projects: readonly string[];

  constructor(input: CwdPolicyInput) {
    const { spec, env, systemRoot, realpath } = ownFields(input, ['spec', 'env', 'systemRoot', 'realpath'] as const);
    if (typeof realpath !== 'function') throw new Error('cwd policy: realpath is required, there is no default');
    const s = ownFields(spec, ['allowedRoots', 'protectedDirs', 'userHome', 'repoRoots', 'ownedWorkRoot', 'projectRoots', 'testDir'] as const);
    if (s.projectRoots !== undefined && !Array.isArray(s.projectRoots)) throw new Error('cwd policy: projectRoots must be a list');
    if (s.repoRoots !== undefined && !Array.isArray(s.repoRoots)) throw new Error('cwd policy: repoRoots must be a list');
    if (!Array.isArray(s.allowedRoots)) throw new Error('cwd policy: allowedRoots is required (an empty list allows nothing)');
    if (!Array.isArray(s.protectedDirs)) throw new Error('cwd policy: protectedDirs is required (r4 §5.3: data dir, DSH_HOME, CLAUDE_CONFIG_DIR)');
    const table: Entry[] = [];
    // Both the lexical form and, where it resolves, the real one: the cwd is compared as its own realpath.
    const add = (kind: Entry['kind'], label: string, p: string) => {
      table.push({ kind, label, path: p });
      let real: string;
      try {
        real = trimSep(canonicalize(p, realpath));
      } catch {
        return;
      }
      if (pathKey(real) !== pathKey(p)) table.push({ kind, label, path: real });
    };
    const profiles = [mustPath(s.userHome, 'userHome')];
    const fromEnv = envGet(env ?? {}, 'USERPROFILE');
    const envProfile = fromEnv === undefined ? null : checkPath(fromEnv);
    if (envProfile?.ok === true && !profiles.some((p) => pathKey(p) === pathKey(envProfile.path))) profiles.push(envProfile.path);
    for (const p of profiles) {
      add('self', 'user-profile', p);
      for (const sub of PROFILE_SUBDIRS) add('tree', `user-profile\\${sub}`, win.join(p, sub));
    }
    // A redirected AppData (folder redirection, a roaming profile, APPDATA pointed elsewhere) lies
    // outside every profile's AppData row; it gets a row of its own under the same label.
    for (const name of APPDATA_VARS) {
      const v = envGet(env ?? {}, name);
      const c = v === undefined ? null : checkPath(v);
      if (c?.ok !== true || c.path.length === 3) continue;
      if (profiles.some((p) => isWithin(c.path, win.join(p, 'AppData')))) continue;
      add('tree', 'user-profile\\AppData', trimSep(c.path));
    }
    add('tree', 'system-root', mustPath(systemRoot, 'systemRoot'));
    for (const name of PROGRAM_FILES_VARS) {
      const v = envGet(env ?? {}, name);
      const c = v === undefined ? null : checkPath(v);
      if (c?.ok === true) add('tree', 'program-files', c.path);
    }
    add('tree', 'repo', REPO_ROOT);
    if (MAIN_CHECKOUT !== null) add('tree', 'repo', MAIN_CHECKOUT);
    for (const r of s.repoRoots ?? []) add('tree', 'repo', mustPath(r, 'repo root'));
    for (const d of s.protectedDirs) add('tree', 'protected', mustPath(d, 'protected dir'));
    this.#table = Object.freeze(table.map((e) => Object.freeze(e)));
    this.#realpath = realpath;
    if (s.testDir !== undefined) {
      const lexical = trimSep(mustPath(s.testDir, 'test dir'));
      this.#testDir = Object.freeze([...new Set([lexical, trimSep(canonicalize(lexical, realpath))])]);
    } else {
      this.#testDir = Object.freeze([]);
    }
    // #hit reads #projects (and #work) below: set before any rootHit runs.
    this.#projects = Object.freeze([]);
    this.#work = Object.freeze([]);
    this.#workParents = Object.freeze([]);
    // A project root is its own realpath (no link on it) and no row hits it, or no policy is made.
    const projects = (s.projectRoots ?? []).map((r) => {
      const lexical = trimSep(mustPath(r, 'project root'));
      const real = trimSep(canonicalize(lexical, realpath));
      if (pathKey(real) !== pathKey(lexical)) throw new Error(`cwd policy: a project root is behind a link (${real}): ${lexical}`);
      const hit = this.rootHit(lexical);
      if (hit !== null) throw new Error(`cwd policy: a project root is refused (${hit}): ${lexical}`);
      return lexical;
    });
    this.#projects = Object.freeze(projects);
    this.#allowed = Object.freeze([...s.allowedRoots.map((r) => {
      const lexical = mustPath(r, 'allowed root');
      return trimSep(canonicalize(lexical, realpath));
    }), ...projects]);
    if (s.ownedWorkRoot !== undefined) {
      const lexical = trimSep(mustPath(s.ownedWorkRoot, 'owned work root'));
      if (lexical.length === 3) throw new Error(`cwd policy: the owned work root is a drive root: ${lexical}`);
      // Only the work dir orchestrad makes itself (ORCHESTRA_HOME\work) is exempt: not any allowed root a caller names.
      if (win.basename(lexical).toLowerCase() !== OWNED_WORK_NAME) throw new Error(`cwd policy: the owned work root must be named ${OWNED_WORK_NAME}: ${lexical}`);
      const parents = s.protectedDirs.map((d) => pathKey(trimSep(mustPath(d, 'protected dir'))));
      if (!parents.includes(pathKey(win.dirname(lexical)))) throw new Error(`cwd policy: the owned work root must sit directly in a protected dir (the data dir): ${lexical}`);
      const real = trimSep(canonicalize(lexical, realpath));
      if (!this.#allowed.some((r) => pathKey(r) === pathKey(real))) throw new Error(`cwd policy: the owned work root must be one of allowedRoots: ${lexical}`);
      this.#work = Object.freeze([...new Set([lexical, real])]);
      this.#workParents = Object.freeze([...new Set([win.dirname(lexical), win.dirname(real)].map(pathKey))]);
    } else {
      this.#work = Object.freeze([]);
      this.#workParents = Object.freeze([]);
    }
    Object.freeze(this);
  }

  /** The rejection table, label and path per entry (for tests and diagnostics). */
  table(): readonly { kind: 'tree' | 'self'; label: string; path: string }[] {
    return this.#table.map((e) => ({ ...e }));
  }

  /** The project roots this policy allows (canonical), in the order named. */
  projectRoots(): readonly string[] {
    return this.#projects;
  }

  /**
   * Why `p` may not be a project root, as the table says (the row's label), or null: a drive root, a row
   * that hits it or that it contains (the profile itself, AppData, the system dirs, the repository and
   * its parents, the data dir, a harness root), and in the test profile anything not strictly inside the
   * test dir (outside-test-dir). `p` must be a plain absolute path (bad-path otherwise); links are the
   * caller's to refuse (its realpath must be itself). Inside the test dir the AppData row does not apply.
   */
  rootHit(p: string): string | null {
    const c = checkPath(p);
    if (!c.ok) return `bad-path:${c.reason}`;
    const q = trimSep(c.path);
    if (q.length === 3) return 'drive-root';
    if (this.#testDir.length > 0 && !this.#testDir.some((d) => isWithin(q, d) && pathKey(q) !== pathKey(d))) return 'outside-test-dir';
    return this.#hit(q, this.#testDir.length > 0);
  }

  check(cwd: string): CwdVerdict {
    const c = checkPath(cwd);
    if (!c.ok) return { ok: false, reason: 'bad-path', detail: c.reason };
    const p = c.path;
    if (p.length === 3) return { ok: false, reason: 'drive-root', detail: p };
    const hit = this.#hit(p);
    if (hit !== null) return { ok: false, reason: 'protected', detail: hit };
    let real: string;
    try {
      real = trimSep(this.#realpath(p));
    } catch (e) {
      return { ok: false, reason: 'unresolved', detail: errCode(e) };
    }
    if (pathKey(real) !== pathKey(p)) return { ok: false, reason: 'reparsed', detail: real };
    if (!this.#allowed.some((root) => isWithin(p, root))) return { ok: false, reason: 'outside-allowed', detail: p };
    return { ok: true, path: p };
  }

  /**
   * Where a path an owned session names lies, against the same table: its realpath (the nearest existing
   * ancestor's, joined with the rest, so a junction is followed) and the label of the row its lexical or
   * its real form hits, or null. Fails closed: a path that is no plain absolute path hits bad-path, one
   * that cannot be resolved hits unresolved, a drive root hits drive-root.
   */
  place(p: string): { real: string | null; hit: string | null } {
    const c = checkPath(p);
    if (!c.ok) return { real: null, hit: `bad-path:${c.reason}` };
    let real: string;
    try {
      real = trimSep(canonicalize(c.path, this.#realpath));
    } catch (e) {
      return { real: null, hit: `unresolved:${errCode(e)}` };
    }
    if (c.path.length === 3 || real.length === 3) return { real, hit: 'drive-root' };
    return { real, hit: this.#hit(c.path) ?? this.#hit(real) };
  }

  /** The row `p` hits, or null. `inProject`: p is (inside) a test-profile project root, where the AppData row does not apply. */
  #hit(p: string, inProject: boolean = this.#testDir.length > 0 && this.#projects.some((r) => isWithin(p, r))): string | null {
    const top = p.slice(3).split('\\')[0]!;
    if (PROGRAM_FILES_TOP.test(top)) return 'program-files';
    const inWork = this.#work.some((w) => isWithin(p, w));
    for (const e of this.#table) {
      if (isWithin(e.path, p)) return e.label;
      if (e.kind === 'tree' && isWithin(p, e.path)) {
        if (inWork && this.#exempt(e)) continue;
        if (inProject && e.label === 'user-profile\\AppData') continue;
        return e.label;
      }
    }
    return null;
  }

  /** The rows a cwd inside the owned work root passes: AppData, and the protected dir the work root sits in directly. */
  #exempt(e: Entry): boolean {
    if (e.label === 'user-profile\\AppData') return true;
    return e.label === 'protected' && this.#workParents.includes(pathKey(trimSep(e.path)));
  }
}
frozenClass(CwdPolicy);
