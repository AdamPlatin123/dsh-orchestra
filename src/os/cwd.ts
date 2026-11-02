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
//  2. an allow list of roots, handed in at construction. Which roots is an open decision (the design's
//     "0.2 only <test dir>\work\" versus a wider real-profile scope), so the policy only takes the list;
//     an empty list allows nothing.
// The cwd must exist and be its own realpath: no junction or link anywhere on it.

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

  constructor(input: CwdPolicyInput) {
    const { spec, env, systemRoot, realpath } = ownFields(input, ['spec', 'env', 'systemRoot', 'realpath'] as const);
    if (typeof realpath !== 'function') throw new Error('cwd policy: realpath is required, there is no default');
    const s = ownFields(spec, ['allowedRoots', 'protectedDirs', 'userHome', 'repoRoots'] as const);
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
    this.#allowed = Object.freeze(s.allowedRoots.map((r) => {
      const lexical = mustPath(r, 'allowed root');
      return trimSep(canonicalize(lexical, realpath));
    }));
    this.#realpath = realpath;
    Object.freeze(this);
  }

  /** The rejection table, label and path per entry (for tests and diagnostics). */
  table(): readonly { kind: 'tree' | 'self'; label: string; path: string }[] {
    return this.#table.map((e) => ({ ...e }));
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

  #hit(p: string): string | null {
    const top = p.slice(3).split('\\')[0]!;
    if (PROGRAM_FILES_TOP.test(top)) return 'program-files';
    for (const e of this.#table) {
      if (isWithin(e.path, p)) return e.label;
      if (e.kind === 'tree' && isWithin(p, e.path)) return e.label;
    }
    return null;
  }
}
frozenClass(CwdPolicy);
