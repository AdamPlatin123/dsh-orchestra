import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { RealpathFn } from '../fs/paths.ts';
import { pathKey } from '../fs/paths.ts';
import { MAIN_CHECKOUT, REPO_ROOT } from '../os/cwd.ts';
import { frozen } from '../../shared/frozen.js';
import { CLAUDE_HOST_PINS } from './claude-pins.ts';

const win = path.win32;

// Where the Claude host lives and what it is pinned to (alpha 0.2 design §1 route B, §2.1; orchestra app
// step 4). orchestrad resolves all of it once, at startup; a missing or changed piece keeps owned Claude
// sessions off with its reason (T1: off says why).
//
//  - node.exe: the repository's own .tools\node24\node.exe (the main checkout's when this copy runs from
//    a worktree, which has no .tools of its own), which must exist and be its own realpath. Not
//    process.execPath: no module reads that (src/runtime/process-powers.ts).
//  - host.mjs: hosts\claude\host.mjs of this copy, the one argument the spawn gate allows.
//  - claude.exe: the CLI binary the installed SDK brought (@anthropic-ai/claude-agent-sdk-win32-x64,
//    the SDK's own pinned CLI build), never the user's own claude.exe, which updates itself. Too large to
//    hash on every start (about 240 MB); it is checked to exist and to be its own realpath.
//  - the pins (src/owned/claude-pins.ts): host.mjs, host-core.mjs and the SDK's sdk.mjs, read through a
//    read gate whose only roots are these three files, and compared with sha256 at startup and again by
//    the spawn gate before every start (host-tampered).

export const CLAUDE_HOST_REL = frozen({
  node: '.tools/node24/node.exe',
  entry: 'hosts/claude/host.mjs',
  claudeExe: 'hosts/claude/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
});

const abs = (root: string, rel: string) => win.join(root, ...rel.split('/'));

/** The files the pins name, absolute, in this copy of the repository. */
export function pinnedFiles(repo: string = REPO_ROOT): string[] {
  return Object.keys(CLAUDE_HOST_PINS).map((rel) => abs(repo, rel));
}

export type HostSiteReason = 'node-missing' | 'host-missing' | 'claude-exe-missing' | 'reparsed';
export type HostSite =
  | { ok: true; node: string; entry: string; claudeExe: string }
  | { ok: false; reason: HostSiteReason; detail: string };

/** The real path of `p` when it is its own (no junction or link on it); else why not. */
function own(p: string, realpath: RealpathFn): { ok: true } | { ok: false; why: 'missing' | 'reparsed'; detail: string } {
  let real: string;
  try {
    real = realpath(p);
  } catch (e) {
    return { ok: false, why: 'missing', detail: `${p} (${typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e)})` };
  }
  return pathKey(real) === pathKey(p) ? { ok: true } : { ok: false, why: 'reparsed', detail: `${p} -> ${real}` };
}

/** node.exe, host.mjs and claude.exe as this copy of the repository has them, or the first that is not there. */
export function resolveHostSite(realpath: RealpathFn, repo: string = REPO_ROOT, main: string | null = MAIN_CHECKOUT): HostSite {
  const nodes = [abs(repo, CLAUDE_HOST_REL.node), ...(main === null ? [] : [abs(main, CLAUDE_HOST_REL.node)])];
  let node: string | null = null;
  let nodeWhy = '';
  for (const n of nodes) {
    const v = own(n, realpath);
    if (v.ok) {
      node = n;
      break;
    }
    if (v.why === 'reparsed') return { ok: false, reason: 'reparsed', detail: v.detail };
    nodeWhy = nodeWhy === '' ? v.detail : `${nodeWhy}; ${v.detail}`;
  }
  if (node === null) return { ok: false, reason: 'node-missing', detail: nodeWhy };
  const entry = abs(repo, CLAUDE_HOST_REL.entry);
  const e = own(entry, realpath);
  if (!e.ok) return { ok: false, reason: e.why === 'reparsed' ? 'reparsed' : 'host-missing', detail: e.detail };
  const claudeExe = abs(repo, CLAUDE_HOST_REL.claudeExe);
  const c = own(claudeExe, realpath);
  if (!c.ok) return { ok: false, reason: c.why === 'reparsed' ? 'reparsed' : 'claude-exe-missing', detail: c.detail };
  return { ok: true, node, entry, claudeExe };
}

/**
 * Each pinned file read whole (`read`: the pinned-file read gate) and hashed: null when every one
 * matches its pin, else what did not ("<rel>: changed", "<rel>: unreadable (<why>)").
 */
export function checkPins(read: (file: string) => Buffer, repo: string = REPO_ROOT, pins: Readonly<Record<string, string>> = CLAUDE_HOST_PINS): string | null {
  for (const [rel, want] of Object.entries(pins)) {
    let bytes: Buffer;
    try {
      bytes = read(abs(repo, rel));
    } catch (e) {
      const why = (e as { decision?: { reason?: unknown } }).decision?.reason ?? (e instanceof Error ? e.message : String(e));
      return `${rel}: unreadable (${String(why)})`;
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== want) return `${rel}: changed`;
  }
  return null;
}
