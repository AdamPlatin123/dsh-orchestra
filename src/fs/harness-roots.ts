import * as path from 'node:path';
import type { HarnessRootKind, ResolvedEnv } from '../runtime/env.ts';
import type { PathRejectReason, RealpathFn } from './paths.ts';
import type { ReadGate, ReadGateConfig } from './read-gate.ts';
import { canonicalize, checkPath, pathKey } from './paths.ts';
import { ReadGateError } from './read-gate.ts';
import { ownFields } from '../runtime/own.ts';

const win = path.win32;

/** A known harness root: the configured path and its canonical form (they differ behind a junction). */
export type HarnessRoot = { kind: HarnessRootKind; path: string; real: string };

export type RootFs = {
  realpath: RealpathFn;
  /** Names of subdirectories (links included), sorted; [] when `dir` does not exist. */
  listDirs(dir: string): string[];
};

function segmentRegex(seg: string): RegExp {
  const body = seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\]*');
  return new RegExp(`^${body}$`, 'i');
}

function exists(p: string, rfs: RootFs): boolean {
  try {
    rfs.realpath(p);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

/** The directory a glob is listed from: every segment before the one holding its first `*`. */
export function globListRoot(pattern: string): string {
  const segs = win.normalize(pattern).split('\\');
  const star = segs.findIndex((s) => s.includes('*'));
  const dir = segs.slice(0, star < 0 ? segs.length : star).join('\\');
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

/** What launcherRootFs needs from the composition root: the read gate factory and the realpath port (src/fs/node-io.ts via BootPorts). */
export type LauncherFsPorts = {
  makeReadGate(spec: Omit<ReadGateConfig, 'io'>): ReadGate;
  realpath: RealpathFn;
};

/**
 * Listing for glob expansion goes through the read gate: a gate whose only roots are the
 * directories the launcher globs are listed from, made by the factory main.ts was handed. In test
 * mode it refuses everything outside the test dirs. Only "does not exist" becomes an empty list;
 * every other refusal propagates.
 */
export function launcherRootFs(env: ResolvedEnv, ports: LauncherFsPorts, opts: { testDirs?: readonly string[] } = {}): RootFs {
  const p = ownFields(ports, ['makeReadGate', 'realpath'] as const);
  if (typeof p.makeReadGate !== 'function' || typeof p.realpath !== 'function') throw new Error('launcherRootFs: makeReadGate and realpath are required');
  const roots: HarnessRoot[] = env.claudeRootCandidates.filter((c) => c.includes('*'))
    .map((pattern) => globListRoot(pattern))
    .map((dir) => ({ kind: 'claude-prefix' as const, path: dir, real: dir }));
  const gate = p.makeReadGate({ roots, ...opts });
  return {
    realpath: p.realpath,
    listDirs(dir) {
      try {
        return gate.subdirs(dir);
      } catch (e) {
        if (e instanceof ReadGateError && e.decision.reason === 'not-found') return [];
        throw e;
      }
    },
  };
}

/** Expands a launcher glob (only `*` inside a segment) to existing directories, sorted. */
export function expandGlob(pattern: string, rfs: RootFs): string[] {
  const norm = win.normalize(pattern);
  const root = norm.slice(0, 3);
  const segs = norm.slice(3).split('\\').filter((s) => s.length > 0);
  let current = [root];
  for (const seg of segs) {
    const next: string[] = [];
    if (!seg.includes('*')) {
      for (const dir of current) next.push(win.join(dir, seg));
    } else {
      const re = segmentRegex(seg);
      for (const dir of current) {
        for (const name of rfs.listDirs(dir)) if (re.test(name)) next.push(win.join(dir, name));
      }
    }
    current = next;
  }
  return current.filter((p) => exists(p, rfs)).sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : pathKey(a) > pathKey(b) ? 1 : 0));
}

/**
 * Every known harness root, deduplicated case-insensitively: the typed roots from env.ts plus the
 * expanded launcher globs. Errors other than "missing" propagate so a caller never runs with a
 * partial deny list. `rfs` is explicit: listing a directory is the read gate's call (launcherRootFs).
 */
export function computeHarnessRoots(env: ResolvedEnv, rfs: RootFs): HarnessRoot[] {
  const typed = [...env.typedHarnessRoots];
  for (const pattern of env.claudeRootCandidates.filter((c) => c.includes('*'))) {
    for (const match of expandGlob(pattern, rfs)) typed.push({ kind: 'claude', path: match });
  }
  const seen = new Set<string>();
  const out: HarnessRoot[] = [];
  for (const r of typed) {
    const checked = checkPath(r.path);
    if (!checked.ok) throw new Error(`harness root rejected (${checked.reason}): ${r.path}`);
    const key = pathKey(checked.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: r.kind, path: checked.path, real: canonicalize(checked.path, rfs.realpath) });
  }
  return out;
}

/** Both forms of every root, deduplicated: what the write fence denies. */
export function rootDenyList(roots: readonly HarnessRoot[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    for (const p of [r.path, r.real]) {
      const key = pathKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

export type VersionFiles =
  | { ok: true; files: string[] }
  | { ok: false; reason: 'appdata-unset' }
  | { ok: false; reason: 'appdata-rejected'; detail: PathRejectReason };

/**
 * The two global package.json files the version check may read; only their `version` field is used.
 * Injected env. Without a usable APPDATA the result says why, so Tuning can show it.
 */
export function defaultVersionFiles(env: Readonly<Record<string, string | undefined>>): VersionFiles {
  const appData = env.APPDATA;
  if (appData === undefined || appData.trim() === '') return { ok: false, reason: 'appdata-unset' };
  const checked = checkPath(appData);
  if (!checked.ok) return { ok: false, reason: 'appdata-rejected', detail: checked.reason };
  const modules = win.join(checked.path, 'npm', 'node_modules');
  return {
    ok: true,
    files: [
      win.join(modules, '@deepseek-ai', 'dsh', 'package.json'),
      win.join(modules, '@openai', 'codex', 'package.json'),
    ],
  };
}
