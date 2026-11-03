import * as path from 'node:path';
import type { HarnessRootKind } from '../runtime/env.ts';
import type { HarnessRoot } from './harness-roots.ts';
import type { PathRejectReason, RealpathFn } from './paths.ts';
import { canonicalize, checkPath, isWithin, pathKey, relativeTo } from './paths.ts';
import { ownFields } from '../runtime/own.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

const win = path.win32;

export type Milestone = 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6';
export type GateRootKind = HarnessRootKind | 'orchestra-home' | 'version-file' | 'pinned-file' | 'project-root';
export type ReadOp = 'read' | 'tail' | 'stat' | 'readdir';

export type AllowRule = {
  id: string;
  /** Matched against the path relative to the root, forward slashes, case-insensitive. */
  re: RegExp;
  since: Milestone;
  /** From which milestone a long-lived tail handle may be held on the file; absent = never. */
  tail?: Milestone;
};

/**
 * Matched against the file name, both as requested and after canonicalization. Names only, as in
 * r4: a project directory whose slug contains "credentials" is not a credential file.
 */
export type DenyRule = { id: string; re: RegExp };

// r4 §10.11 plus the spike additions (S1-Codex: thread_history_1/logs_2; DS-Bot reference: .credentials.yaml*).
// The first match is reported, so the narrower ids come before the broader ones. Every table here is
// frozen through and through where it is defined (shared/frozen.js), its RegExps included: decide()
// reads them on every call, so a module that imports one must not be able to empty or widen it.
export const DENY_RULES: readonly DenyRule[] = frozen([
  { id: '*.key', re: /\.key$/i },
  { id: '.credentials.yaml*', re: /^\.credentials\.yaml/i },
  { id: '*credentials*', re: /credentials/i },
  { id: 'auth.json', re: /^auth\.json$/i },
  { id: '.claude.json*', re: /^\.claude\.json/i },
  { id: '*.bak*', re: /\.bak/i },
  { id: 'watchdog*.log', re: /^watchdog.*\.log/i },
  { id: '.env*', re: /^\.env/i },
  { id: 'thread_history_1.sqlite*', re: /^thread_history_1\.sqlite/i },
  { id: 'logs_2.sqlite*', re: /^logs_2\.sqlite/i },
  { id: 'cookies.json', re: /^cookies\.json$/i },
  { id: '*storageState*.json', re: /storagestate.*\.json$/i },
]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ANY_DIRS = '(?:[^/]+/)*';

export const ALLOW_RULES: Readonly<Record<GateRootKind, readonly AllowRule[]>> = frozen({
  claude: [
    { id: 'projects/**/*.jsonl', re: new RegExp(`^projects/${ANY_DIRS}[^/]+\\.jsonl$`, 'i'), since: 'M0' },
    { id: 'sessions/<digits>.json', re: /^sessions\/\d+\.json$/i, since: 'M0' },
    { id: '**/subagents/**', re: new RegExp(`^${ANY_DIRS}subagents/${ANY_DIRS}[^/]+$`, 'i'), since: 'M0' },
  ],
  'claude-prefix': [],
  dsh: [
    {
      id: 'sessions/--<cwd>--/{<uuid>|session-<uuid>}/session.v4.jsonl.zstd',
      re: new RegExp(`^sessions/--[^/]*--/(?:session-)?${UUID}/session\\.v4\\.jsonl\\.zstd$`, 'i'),
      since: 'M0',
      tail: 'M0',
    },
    { id: 'storages/session_projcache', re: new RegExp(`^storages/session_projcache(?:/${ANY_DIRS}[^/]+)?$`, 'i'), since: 'M0' },
    { id: 'bot/state.json', re: /^bot\/state\.json$/i, since: 'M2' },
    { id: 'bot/inflight.json', re: /^bot\/inflight\.json$/i, since: 'M2' },
    { id: 'bot/usage.sqlite', re: /^bot\/usage\.sqlite$/i, since: 'M2' },
  ],
  codex: [
    { id: 'state_5.sqlite', re: /^state_5\.sqlite$/i, since: 'M0' },
    { id: 'state_5.sqlite-wal', re: /^state_5\.sqlite-wal$/i, since: 'M0' },
    { id: 'sessions/**/rollout-*.jsonl', re: new RegExp(`^sessions/${ANY_DIRS}rollout-[^/]*\\.jsonl$`, 'i'), since: 'M0', tail: 'M2' },
    { id: 'sessions/**/rollout-*.jsonl.zst', re: new RegExp(`^sessions/${ANY_DIRS}rollout-[^/]*\\.jsonl\\.zst$`, 'i'), since: 'M0' },
    // Codex moves a finished session here under the same file name, compressed or not.
    { id: 'archived_sessions/rollout-*.jsonl', re: /^archived_sessions\/rollout-[^/]*\.jsonl$/i, since: 'M0' },
    { id: 'archived_sessions/rollout-*.jsonl.zst', re: /^archived_sessions\/rollout-[^/]*\.jsonl\.zst$/i, since: 'M0' },
  ],
  'dsh-tui': [
    { id: 'session-mounts.json', re: /^session-mounts\.json$/i, since: 'M2' },
    { id: 'inject/servers.json', re: /^inject\/servers\.json$/i, since: 'M2' },
  ],
  'ds-bot': [
    { id: 'state.json', re: /^state\.json$/i, since: 'M2' },
    { id: 'inflight.json', re: /^inflight\.json$/i, since: 'M2' },
    { id: 'usage.sqlite', re: /^usage\.sqlite$/i, since: 'M2' },
  ],
  // Registered by hand (the DS-Bot desktop data dir); its layout is unverified, so nothing is read.
  extra: [],
  'orchestra-home': [{ id: 'orchestra-home/**', re: /^.+$/, since: 'M0' }],
  // A version file is its own root, so its relative path is ''. Only `version` is used by the caller.
  'version-file': [{ id: 'package.json', re: /^$/, since: 'M0' }],
  // A file orchestrad holds to a pinned sha256 (the Claude host's files and its SDK entry,
  // src/owned/claude-pins.ts): its own root, read whole, never listed.
  'pinned-file': [{ id: 'pinned file', re: /^$/, since: 'M0' }],
  // A project root the person named (--project-root, orchestra app plan 项目根): nothing in it is ever
  // read or listed. Only stat is allowed (STAT_ONLY below): whether a path in it is a directory.
  'project-root': [],
});

/**
 * Root kinds whose paths may be stat'ed and nothing else (no read, no tail, no readdir): orchestrad only
 * learns whether a path there is a directory (a project root, or a cwd an agent request names inside one).
 */
export const STAT_ONLY: readonly GateRootKind[] = frozen(['project-root'] as GateRootKind[]);

/** From which milestone stat/readdir are allowed inside a root of this kind; null = never. */
export const LISTABLE: Readonly<Record<GateRootKind, Milestone | null>> = frozen({
  claude: 'M0',
  'claude-prefix': 'M0',
  dsh: 'M0',
  codex: 'M0',
  'dsh-tui': 'M2',
  'ds-bot': 'M2',
  extra: null,
  'orchestra-home': 'M0',
  'version-file': 'M0',
  'pinned-file': null,
  'project-root': null,
});

const ORDER: readonly Milestone[] = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
const reached = (m: Milestone, now: Milestone) => ORDER.indexOf(m) <= ORDER.indexOf(now);

export type ReadDecision =
  | { allow: true; op: ReadOp; path: string; real: string; kind: GateRootKind; root: string; rule: string }
  | { allow: false; op: ReadOp; path: string; reason: 'bad-path'; detail: PathRejectReason }
  | { allow: false; op: ReadOp; path: string; reason: 'test-mode-outside' }
  | { allow: false; op: ReadOp; path: string; reason: 'canonicalize-failed'; detail: string }
  | { allow: false; op: ReadOp; path: string; reason: 'outside-roots' }
  | { allow: false; op: ReadOp; path: string; reason: 'denied-name'; rule: string }
  | { allow: false; op: ReadOp; path: string; reason: 'not-listable'; kind: GateRootKind }
  | { allow: false; op: ReadOp; path: string; reason: 'not-whitelisted'; kind: GateRootKind }
  | { allow: false; op: ReadOp; path: string; reason: 'rule-not-active'; rule: string; since: Milestone }
  | { allow: false; op: ReadOp; path: string; reason: 'tail-not-allowed'; rule: string }
  | { allow: false; op: ReadOp; path: string; reason: 'not-found' }
  | { allow: false; op: ReadOp; path: string; reason: 'stat-failed'; detail: string }
  | { allow: false; op: ReadOp; path: string; reason: 'not-a-file' }
  | { allow: false; op: ReadOp; path: string; reason: 'not-a-directory' }
  | { allow: false; op: ReadOp; path: string; reason: 'hardlink'; links: number }
  | { allow: false; op: ReadOp; path: string; reason: 'changed-during-open' };

export type ReadDeny = Extract<ReadDecision, { allow: false }>;
export type ReadDenyReason = ReadDeny['reason'];

export class ReadGateError extends Error {
  readonly code = 'ERR_ORCHESTRA_READ_GATE';
  readonly decision: ReadDeny;
  constructor(decision: ReadDeny) {
    super(`[ERR_ORCHESTRA_READ_GATE] ${decision.op} denied (${decision.reason}): ${decision.path}`);
    this.decision = decision;
  }
}
frozenClass(ReadGateError);

export type FileStat = {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeMs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
};

/** A directory entry as listed, without following it. */
export type DirEntry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };

/**
 * Every fs call the gate makes. Required, with no default: the real one is minted in
 * src/fs/node-io.ts and reaches a gate only through node-io.ts's read-gate factory, so a gate built anywhere else,
 * however it got the class, reads nothing but what its own io makes up. Tests pass their own io to
 * count or fault calls.
 */
export type ReadIo = {
  realpath: RealpathFn;
  openSync(p: string, flags: 'r'): number;
  readSync(fd: number, buf: Uint8Array, offset: number, length: number, position: number): number;
  fstatSync(fd: number): FileStat;
  statSync(p: string): FileStat;
  closeSync(fd: number): void;
  readdirSync(p: string): DirEntry[];
};

const READ_IO_KEYS = ['realpath', 'openSync', 'readSync', 'fstatSync', 'statSync', 'closeSync', 'readdirSync'] as const;

/** A frozen copy of the io's own functions; a missing one refuses the gate. */
function ownIo(io: ReadIo | undefined): ReadIo {
  const got = ownFields(io, READ_IO_KEYS);
  for (const k of READ_IO_KEYS) if (typeof got[k] !== 'function') throw new Error(`read gate: io.${k} is required`);
  return Object.freeze(got) as ReadIo;
}

export type ReadGateConfig = {
  roots: readonly HarnessRoot[];
  /** Exact files (the global package.json of each harness), see defaultVersionFiles. */
  versionFiles?: readonly string[];
  /** Exact files held to a pinned hash (src/owned/claude-pins.ts); each is its own root, readable whole and never listed. */
  pinnedFiles?: readonly string[];
  /** orchestrad's own data dir; global deny rules still apply inside it, and harness roots win over it. */
  orchestraHome?: string;
  milestone?: Milestone;
  /** Test mode: everything outside these directories is denied before any fs call. */
  testDirs?: readonly string[];
  /** Project roots the person named (--project-root): each its own root, stat only (STAT_ONLY). */
  projectRoots?: readonly string[];
  io: ReadIo;
};

const CONFIG_KEYS = ['roots', 'versionFiles', 'pinnedFiles', 'orchestraHome', 'milestone', 'testDirs', 'projectRoots', 'io'] as const;

type GateRoot = { kind: GateRootKind; forms: string[] };

export type TailHandle = {
  readonly path: string;
  readonly real: string;
  size(): number;
  identity(): { dev: bigint; ino: bigint };
  read(position: number, length: number): Buffer;
  close(): void;
};

/** A short-lived checked 'r' handle (openRead): reads and stats go to the opened file only. */
export type ReadHandle = {
  readonly path: string;
  readonly real: string;
  stat(): FileStat;
  read(position: number, length: number): Buffer;
  close(): void;
};

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

function firstDeny(name: string): DenyRule | undefined {
  return DENY_RULES.find((rule) => rule.re.test(name));
}

/** The root form that contains `real` most narrowly, or undefined. */
function narrowest(roots: readonly GateRoot[], real: string): { kind: GateRootKind; form: string } | undefined {
  let best: { kind: GateRootKind; form: string } | undefined;
  for (const r of roots) {
    for (const form of r.forms) {
      if (isWithin(real, form) && (best === undefined || form.length > best.form.length)) best = { kind: r.kind, form };
    }
  }
  return best;
}

/**
 * The only place orchestrad reads from. Default deny: a path must canonicalize into a known root,
 * pass every deny rule, and match an allow rule of that root's kind. Files open with 'r' only and
 * close as soon as the read is done; only tail handles stay open, and every open handle is counted.
 */
export class ReadGate {
  readonly milestone: Milestone;
  readonly #roots: GateRoot[];
  /** ORCHESTRA_HOME and the version files: they decide only paths that lie under no harness root. */
  readonly #own: GateRoot[];
  readonly #test: { lexical: string[]; real: string[] } | null;
  readonly #io: ReadIo;
  #open = 0;

  constructor(config: ReadGateConfig) {
    // Own fields only: an optional field the caller left out reads undefined, never Object.prototype's.
    const cfg = ownFields(config, CONFIG_KEYS);
    this.#io = ownIo(cfg.io);
    this.milestone = cfg.milestone ?? 'M0';
    const canon = (p: string, what: string): string[] => {
      const c = checkPath(p);
      if (!c.ok) throw new Error(`read gate: ${what} rejected (${c.reason}): ${p}`);
      const real = canonicalize(c.path, this.#io.realpath);
      return pathKey(real) === pathKey(c.path) ? [c.path] : [c.path, real];
    };
    if (cfg.testDirs !== undefined) {
      if (cfg.testDirs.length === 0) throw new Error('read gate: test mode needs at least one test dir');
      const lexical: string[] = [];
      const real: string[] = [];
      for (const d of cfg.testDirs) {
        const forms = canon(d, 'test dir');
        lexical.push(...forms);
        real.push(forms[forms.length - 1]!);
      }
      this.#test = { lexical, real };
    } else {
      this.#test = null;
    }
    // In test mode a root outside the test dirs is dropped unseen: not even its realpath is taken.
    const inTest = (p: string) => {
      const c = checkPath(p);
      return this.#test === null || (c.ok && this.#test.lexical.some((d) => isWithin(c.path, d)));
    };
    this.#roots = cfg.roots!.filter((r) => inTest(r.path) && inTest(r.real))
      .map((r) => ({ kind: r.kind, forms: [...new Set([...canon(r.path, 'root'), ...canon(r.real, 'root')])] }));
    this.#own = [
      ...(cfg.versionFiles ?? []).filter(inTest).map((f) => ({ kind: 'version-file' as const, forms: canon(f, 'version file') })),
      ...(cfg.pinnedFiles ?? []).filter(inTest).map((f) => ({ kind: 'pinned-file' as const, forms: canon(f, 'pinned file') })),
      ...(cfg.projectRoots ?? []).filter(inTest).map((f) => ({ kind: 'project-root' as const, forms: canon(f, 'project root') })),
      ...(cfg.orchestraHome !== undefined && inTest(cfg.orchestraHome)
        ? [{ kind: 'orchestra-home' as const, forms: canon(cfg.orchestraHome, 'ORCHESTRA_HOME') }]
        : []),
    ];
    Object.freeze(this);
  }

  get testMode(): boolean {
    return this.#test !== null;
  }

  /** Number of file handles this gate holds right now. */
  openHandles(): number {
    return this.#open;
  }

  decide(target: string, op: ReadOp): ReadDecision {
    return this.#decide(target, op).decision;
  }

  #decide(target: string, op: ReadOp): { decision: ReadDecision; stat?: FileStat } {
    const deny = (d: ReadDeny) => ({ decision: d });
    const c = checkPath(target);
    if (!c.ok) return deny({ allow: false, op, path: String(target), reason: 'bad-path', detail: c.reason });
    const p = c.path;
    if (this.#test !== null && !this.#test.lexical.some((d) => isWithin(p, d))) {
      return deny({ allow: false, op, path: p, reason: 'test-mode-outside' });
    }
    const named = firstDeny(win.basename(p));
    if (named !== undefined) return deny({ allow: false, op, path: p, reason: 'denied-name', rule: named.id });
    let real: string;
    try {
      real = canonicalize(p, this.#io.realpath);
    } catch (e) {
      return deny({ allow: false, op, path: p, reason: 'canonicalize-failed', detail: errCode(e) });
    }
    if (this.#test !== null && !this.#test.real.some((d) => isWithin(real, d))) {
      return deny({ allow: false, op, path: p, reason: 'test-mode-outside' });
    }
    // Deny first: a harness root decides every path below it, even where ORCHESTRA_HOME lies inside it.
    const best = narrowest(this.#roots, real) ?? narrowest(this.#own, real);
    if (best === undefined) return deny({ allow: false, op, path: p, reason: 'outside-roots' });
    const rel = relativeTo(best.form, real);
    const realDeny = rel === '' ? undefined : firstDeny(rel.slice(rel.lastIndexOf('/') + 1));
    if (realDeny !== undefined) return deny({ allow: false, op, path: p, reason: 'denied-name', rule: realDeny.id });

    let ruleId: string;
    if (STAT_ONLY.includes(best.kind)) {
      if (op !== 'stat') return deny({ allow: false, op, path: p, reason: op === 'readdir' ? 'not-listable' : 'not-whitelisted', kind: best.kind });
      ruleId = `stat:${best.kind}`;
    } else if (op === 'stat' || op === 'readdir') {
      const since = LISTABLE[best.kind];
      if (since === null || !reached(since, this.milestone)) return deny({ allow: false, op, path: p, reason: 'not-listable', kind: best.kind });
      ruleId = `list:${best.kind}`;
    } else {
      const rule = ALLOW_RULES[best.kind].find((r) => r.re.test(rel));
      if (rule === undefined) return deny({ allow: false, op, path: p, reason: 'not-whitelisted', kind: best.kind });
      if (!reached(rule.since, this.milestone)) return deny({ allow: false, op, path: p, reason: 'rule-not-active', rule: rule.id, since: rule.since });
      if (op === 'tail' && (rule.tail === undefined || !reached(rule.tail, this.milestone))) {
        return deny({ allow: false, op, path: p, reason: 'tail-not-allowed', rule: rule.id });
      }
      ruleId = rule.id;
    }

    let stat: FileStat;
    try {
      stat = this.#io.statSync(real);
    } catch (e) {
      const code = errCode(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') return deny({ allow: false, op, path: p, reason: 'not-found' });
      return deny({ allow: false, op, path: p, reason: 'stat-failed', detail: code });
    }
    if ((op === 'read' || op === 'tail') && !stat.isFile()) return deny({ allow: false, op, path: p, reason: 'not-a-file' });
    // A hard link has no reparse point, so realpath keeps the alias's own name: a credential file
    // linked in under an allowed name would pass every name rule. Content behind other links is refused.
    if ((op === 'read' || op === 'tail') && stat.nlink > 1n) return deny({ allow: false, op, path: p, reason: 'hardlink', links: Number(stat.nlink) });
    if (op === 'readdir' && !stat.isDirectory()) return deny({ allow: false, op, path: p, reason: 'not-a-directory' });
    return { decision: { allow: true, op, path: p, real, kind: best.kind, root: best.form, rule: ruleId }, stat };
  }

  #require(target: string, op: ReadOp): { decision: Extract<ReadDecision, { allow: true }>; stat: FileStat } {
    const { decision, stat } = this.#decide(target, op);
    if (!decision.allow) throw new ReadGateError(decision);
    return { decision, stat: stat! };
  }

  /** Opens the checked file and confirms it is still the file that was checked. */
  #openChecked(decision: Extract<ReadDecision, { allow: true }>, stat: FileStat): number {
    const fd = this.#io.openSync(decision.real, 'r');
    this.#open++;
    let ok = false;
    try {
      const now = this.#io.fstatSync(fd);
      if (now.ino !== stat.ino || now.dev !== stat.dev) {
        throw new ReadGateError({ allow: false, op: decision.op, path: decision.path, reason: 'changed-during-open' });
      }
      if (now.nlink > 1n) {
        throw new ReadGateError({ allow: false, op: decision.op, path: decision.path, reason: 'hardlink', links: Number(now.nlink) });
      }
      ok = true;
      return fd;
    } finally {
      if (!ok) this.#close(fd);
    }
  }

  #close(fd: number): void {
    try {
      this.#io.closeSync(fd);
    } finally {
      this.#open--;
    }
  }

  #readAt(fd: number, position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = this.#io.readSync(fd, buf, got, length - got, position + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  }

  /** The whole file as it was when opened. */
  readFile(target: string): Buffer {
    const { decision, stat } = this.#require(target, 'read');
    const fd = this.#openChecked(decision, stat);
    try {
      return this.#readAt(fd, 0, Number(this.#io.fstatSync(fd).size));
    } finally {
      this.#close(fd);
    }
  }

  /** Up to `length` bytes from `position`; shorter at end of file. */
  readRange(target: string, position: number, length: number): Buffer {
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError('read gate: position and length must be non-negative integers');
    }
    const { decision, stat } = this.#require(target, 'read');
    const fd = this.#openChecked(decision, stat);
    try {
      return this.#readAt(fd, position, length);
    } finally {
      this.#close(fd);
    }
  }

  /**
   * One checked 'r' handle for a run of reads (the import copy): every range comes from the file
   * that was opened and checked, never from a path resolved again between chunks. The caller compares
   * `real` and `stat()` with what it planned, and closes the handle when done.
   */
  openRead(target: string): ReadHandle {
    const { decision, stat } = this.#require(target, 'read');
    const fd = this.#openChecked(decision, stat);
    let closed = false;
    const live = () => {
      if (closed) throw new Error(`read gate: read handle closed: ${decision.path}`);
    };
    return {
      path: decision.path,
      real: decision.real,
      stat: () => {
        live();
        return this.#io.fstatSync(fd);
      },
      read: (position, length) => {
        live();
        if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
          throw new RangeError('read gate: position and length must be non-negative integers');
        }
        return this.#readAt(fd, position, length);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#close(fd);
      },
    };
  }

  /** A long-lived 'r' handle, only for files whose rule allows tailing in this milestone. */
  openTail(target: string): TailHandle {
    const { decision, stat } = this.#require(target, 'tail');
    const fd = this.#openChecked(decision, stat);
    let closed = false;
    const live = () => {
      if (closed) throw new Error(`read gate: tail handle closed: ${decision.path}`);
    };
    return {
      path: decision.path,
      real: decision.real,
      size: () => {
        live();
        return Number(this.#io.fstatSync(fd).size);
      },
      identity: () => {
        live();
        const s = this.#io.fstatSync(fd);
        return { dev: s.dev, ino: s.ino };
      },
      read: (position, length) => {
        live();
        return this.#readAt(fd, position, length);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#close(fd);
      },
    };
  }

  stat(target: string): FileStat {
    return this.#require(target, 'stat').stat;
  }

  readdir(target: string): string[] {
    const { decision } = this.#require(target, 'readdir');
    return this.#io.readdirSync(decision.real).map((e) => e.name);
  }

  /**
   * Every entry of `target`, sorted by name, with its kind as listed and never followed: `link` for
   * a symbolic link, a junction or any other reparse point, `dir` for a plain directory, `other` for
   * the rest (a file, judged on its own when it is read). The import copy walks a tree with it.
   */
  entries(target: string): Array<{ name: string; kind: 'link' | 'dir' | 'other' }> {
    const { decision } = this.#require(target, 'readdir');
    return this.#io.readdirSync(decision.real)
      .map((e) => ({ name: e.name, kind: e.isSymbolicLink() ? 'link' as const : e.isDirectory() ? 'dir' as const : 'other' as const }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Names of the subdirectories and links in `target`, sorted; links are listed, never followed. */
  subdirs(target: string): string[] {
    const { decision } = this.#require(target, 'readdir');
    return this.#io.readdirSync(decision.real).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
  }
}

// The prototype and every instance are frozen: a module holding a ReadGate (or the class) can neither
// replace a method every holder calls nor change an instance's fields or prototype, and the gate's
// own paths call only its private members, so a subclass cannot steer them either.
frozenClass(ReadGate);
