import * as fs from 'node:fs';
import * as path from 'node:path';

const win = path.win32;

export type PathRejectReason =
  | 'empty'
  | 'nul-byte'
  | 'invalid-char'
  | 'device-namespace'
  | 'unc'
  | 'not-absolute'
  | 'ads'
  | 'trailing-dot-or-space'
  | 'device-name';

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: PathRejectReason };

// CONIN$, CONOUT$ and CLOCK$ are devices too; superscript digits are legal COM/LPT suffixes.
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;

function isDeviceName(segment: string): boolean {
  const stem = segment.split('.')[0]!.replace(/ +$/, '');
  return DEVICE.test(stem);
}

/**
 * Lexical check and normalization of a Windows path. Only plain drive-letter paths pass:
 * no UNC, no \\?\ or \\.\ namespace, no alternate data stream, no device name, no segment that
 * Win32 would silently change (trailing dot or space). `..` is resolved lexically, as Win32 does.
 */
export function checkPath(input: string): PathCheck {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'empty' };
  if (input.includes('\0')) return { ok: false, reason: 'nul-byte' };
  if (/[\u0001-\u001f]/.test(input)) return { ok: false, reason: 'invalid-char' };
  const s = input.replace(/\//g, '\\');
  if (/^\\\\[?.]\\/.test(s) || s.startsWith('\\??\\')) return { ok: false, reason: 'device-namespace' };
  if (s.startsWith('\\\\')) return { ok: false, reason: 'unc' };
  if (!/^[A-Za-z]:\\/.test(s)) return { ok: false, reason: 'not-absolute' };
  if (s.indexOf(':', 2) !== -1) return { ok: false, reason: 'ads' };
  if (/[<>"|?*]/.test(s)) return { ok: false, reason: 'invalid-char' };
  const normalized = trimSep(win.normalize(s));
  const segments = normalized.slice(3).split('\\').filter((x) => x.length > 0);
  for (const seg of segments) {
    if (/[. ]$/.test(seg)) return { ok: false, reason: 'trailing-dot-or-space' };
    if (isDeviceName(seg)) return { ok: false, reason: 'device-name' };
  }
  return { ok: true, path: normalized };
}

function trimSep(p: string): string {
  return p.length > 3 ? p.replace(/\\+$/, '') : p;
}

/** Comparison key: Windows paths compare case-insensitively. */
export function pathKey(p: string): string {
  return p.toLowerCase();
}

/** True when `child` is `parent` or lies below it. Both must be normalized absolute paths. */
export function isWithin(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith('\\') ? p : p + '\\');
}

export type RealpathFn = (p: string) => string;

export const nativeRealpath: RealpathFn = (p) => fs.realpathSync.native(p);

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * realpath of `p` when it exists; otherwise realpath of the nearest existing ancestor joined with
 * the rest. Resolves junctions, links and 8.3 short names. Errors other than "missing" propagate,
 * so callers fail closed.
 */
export function canonicalize(p: string, realpath: RealpathFn = nativeRealpath): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = trimSep(realpath(cur));
      return rest.length === 0 ? real : win.join(real, ...rest.reverse());
    } catch (e) {
      const code = errCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
    const parent = win.dirname(cur);
    if (parent === cur) return p;
    rest.push(win.basename(cur));
    cur = parent;
  }
}

/** Repo-style relative path with forward slashes; '' for the root itself. */
export function relativeTo(root: string, child: string): string {
  if (pathKey(root) === pathKey(child)) return '';
  const r = win.relative(root, child);
  return r.split('\\').join('/');
}
