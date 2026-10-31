import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PathRejectReason, RealpathFn } from './paths.ts';
import { canonicalize, checkPath, isWithin, nativeRealpath, pathKey } from './paths.ts';

const win = path.win32;

export type WriteOp = 'write' | 'append' | 'mkdir' | 'rm';

type Placement =
  | { allow: true; op: WriteOp; path: string; real: string }
  | { allow: false; op: WriteOp; path: string; reason: 'harness-root'; root: string }
  | { allow: false; op: WriteOp; path: string; reason: 'contains-harness-root'; root: string }
  | { allow: false; op: WriteOp; path: string; reason: 'home-root' }
  | { allow: false; op: WriteOp; path: string; reason: 'outside-home' };

/**
 * Why a target that passed check() was refused once it had been opened or created; `link`: a level
 * mkdirp was about to create turned up as a junction or other link.
 */
export type ChangedDetail = Extract<Placement, { allow: false }>['reason'] | 'canonicalize-failed' | 'identity' | 'link';

export type WriteDecision =
  | Placement
  | { allow: false; op: WriteOp; path: string; reason: 'bad-path'; detail: PathRejectReason }
  | { allow: false; op: WriteOp; path: string; reason: 'canonicalize-failed'; detail: string }
  | { allow: false; op: WriteOp; path: string; reason: 'hardlink'; links: number }
  | { allow: false; op: WriteOp; path: string; reason: 'stat-failed'; detail: string }
  | { allow: false; op: WriteOp; path: string; reason: 'changed-during-open'; detail: ChangedDetail };

export type WriteDenyReason = Extract<WriteDecision, { allow: false }>['reason'];

export class WriteFenceError extends Error {
  readonly code = 'ERR_ORCHESTRA_WRITE_FENCE';
  readonly decision: Extract<WriteDecision, { allow: false }>;
  constructor(decision: Extract<WriteDecision, { allow: false }>) {
    super(`[ERR_ORCHESTRA_WRITE_FENCE] ${decision.op} denied (${decision.reason}): ${decision.path}`);
    this.decision = decision;
  }
}

/**
 * The calls that open, create, close or rename a target; injectable so tests can stage a swap between
 * check and act, and between the close of a temp file and its rename.
 */
export type WriteIo = {
  openSync(p: string, flags: 'wx' | 'ax' | number): number;
  mkdirSync(p: string): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
};

const NODE_IO: WriteIo = {
  openSync: (p, flags) => fs.openSync(p, flags),
  mkdirSync: (p) => {
    fs.mkdirSync(p);
  },
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
};

// Opens an existing file for appending and never creates one; a new file is made with 'ax' instead.
const APPEND_EXISTING = fs.constants.O_WRONLY | fs.constants.O_APPEND;

export type WriteFenceConfig = {
  orchestraHome: string;
  /** Every harness root in both forms (see rootDenyList); each is canonicalized once more here. */
  harnessRoots: readonly string[];
  /**
   * Test profile: the canonical test dir. ORCHESTRA_HOME must lie strictly inside it both as written
   * and canonically, or the fence is not built; every target must already lie in both forms of home.
   */
  confine?: string;
  realpath?: RealpathFn;
  io?: WriteIo;
};

export type RmResult = { removed: number };

type FileId = { dev: bigint; ino: bigint };

function code(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function mustCheck(p: string, what: string): string {
  const c = checkPath(p);
  if (!c.ok) throw new Error(`write fence: ${what} rejected (${c.reason}): ${p}`);
  return c.path;
}

/**
 * The only place orchestrad writes from. Deny first: a target under any known harness root is
 * refused even when it is also under ORCHESTRA_HOME; only then must it lie under ORCHESTRA_HOME,
 * both as written and after canonicalization.
 *
 * Every file opened or directory created is judged again afterwards, so a directory swapped for a
 * junction between check() and the act is caught before any byte is written. What is left is the
 * window between that re-check and a rename or removal by path, which Node cannot make relative to
 * a handle; ORCHESTRA_HOME must therefore be writable by the user only.
 */
export class WriteFence {
  readonly home: string;
  readonly homeReal: string;
  readonly denyRoots: readonly string[];
  readonly #realpath: RealpathFn;
  readonly #io: WriteIo;

  constructor(cfg: WriteFenceConfig) {
    this.#realpath = cfg.realpath ?? nativeRealpath;
    this.#io = cfg.io ?? NODE_IO;
    this.home = mustCheck(cfg.orchestraHome, 'ORCHESTRA_HOME');
    this.homeReal = canonicalize(this.home, this.#realpath);
    if (cfg.confine !== undefined) {
      const dir = mustCheck(cfg.confine, 'test dir');
      const strictly = (p: string) => isWithin(p, dir) && pathKey(p) !== pathKey(dir);
      if (pathKey(canonicalize(dir, this.#realpath)) !== pathKey(dir) || !strictly(this.home) || !strictly(this.homeReal)) {
        throw new Error(`write fence: ORCHESTRA_HOME ${this.home} (canonical ${this.homeReal}) leaves the test dir ${dir}`);
      }
    }
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const r of cfg.harnessRoots) {
      const lexical = mustCheck(r, 'harness root');
      for (const form of [lexical, canonicalize(lexical, this.#realpath)]) {
        if (seen.has(pathKey(form))) continue;
        seen.add(pathKey(form));
        roots.push(form);
      }
    }
    this.denyRoots = roots;
  }

  /**
   * Decision only; looks at the target (lstat, realpath) but never changes anything. `rm` judges a
   * link as the entry, not its target. Appending to a file with other hard links would change
   * those too, so it is refused.
   */
  check(target: string, op: WriteOp): WriteDecision {
    const c = checkPath(target);
    if (!c.ok) return { allow: false, op, path: String(target), reason: 'bad-path', detail: c.reason };
    const p = c.path;
    let real: string;
    try {
      real = op === 'rm' && this.#isLink(p) ? this.#entryCanonical(p) : canonicalize(p, this.#realpath);
    } catch (e) {
      return { allow: false, op, path: p, reason: 'canonicalize-failed', detail: code(e) ?? String(e) };
    }
    const placed = this.#place(op, p, real);
    if (!placed.allow || op !== 'append') return placed;
    let links: number;
    try {
      links = linkCount(real);
    } catch (e) {
      return { allow: false, op, path: p, reason: 'stat-failed', detail: code(e) ?? String(e) };
    }
    if (links > 1) return { allow: false, op, path: p, reason: 'hardlink', links };
    return placed;
  }

  /** Where `p` (with canonical form `real`) lies: under a harness root, at or outside ORCHESTRA_HOME, or fine. */
  #place(op: WriteOp, p: string, real: string): Placement {
    for (const root of this.denyRoots) {
      if (isWithin(p, root) || isWithin(real, root)) return { allow: false, op, path: p, reason: 'harness-root', root };
    }
    if (op === 'rm') {
      for (const root of this.denyRoots) {
        if (isWithin(root, p) || isWithin(root, real)) return { allow: false, op, path: p, reason: 'contains-harness-root', root };
      }
    }
    const isHome = pathKey(p) === pathKey(this.home) || pathKey(real) === pathKey(this.homeReal);
    if (isHome && op !== 'mkdir') return { allow: false, op, path: p, reason: 'home-root' };
    if (!isWithin(p, this.home) || !isWithin(real, this.homeReal)) return { allow: false, op, path: p, reason: 'outside-home' };
    return { allow: true, op, path: p, real };
  }

  #require(target: string, op: WriteOp): string {
    const d = this.check(target, op);
    if (!d.allow) throw new WriteFenceError(d);
    return d.path;
  }

  /** Canonicalizes the now existing `p` again: its canonical form, or why it is no longer fine. */
  #placeAgain(op: WriteOp, p: string): { ok: true; real: string } | { ok: false; detail: Exclude<ChangedDetail, 'identity' | 'link'> } {
    let real: string;
    try {
      real = canonicalize(p, this.#realpath);
    } catch {
      return { ok: false, detail: 'canonicalize-failed' };
    }
    const placed = this.#place(op, p, real);
    return placed.allow ? { ok: true, real } : { ok: false, detail: placed.reason };
  }

  /** `p` must still be placed inside ORCHESTRA_HOME and still lead to the file `id`. */
  #verifyPath(op: WriteOp, p: string, id: FileId): void {
    const again = this.#placeAgain(op, p);
    let detail: ChangedDetail | null = again.ok ? null : again.detail;
    if (again.ok) {
      try {
        const now = fs.statSync(again.real, { bigint: true });
        if (now.dev !== id.dev || now.ino !== id.ino) detail = 'identity';
      } catch {
        detail = 'identity';
      }
    }
    if (detail !== null) throw new WriteFenceError({ allow: false, op, path: p, reason: 'changed-during-open', detail });
  }

  /** Judges an opened handle: other hard links (from the handle itself), then where its path leads. */
  #verifyOpened(op: 'write' | 'append', fd: number, p: string): FileId {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (op === 'append' && opened.nlink > 1n) {
      throw new WriteFenceError({ allow: false, op, path: p, reason: 'hardlink', links: Number(opened.nlink) });
    }
    const id = { dev: opened.dev, ino: opened.ino };
    this.#verifyPath(op, p, id);
    return id;
  }

  #isLink(p: string): boolean {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch (e) {
      if (code(e) === 'ENOENT') return false;
      throw e;
    }
  }

  #entryCanonical(p: string): string {
    const parent = win.dirname(p);
    return parent === p ? canonicalize(p, this.#realpath) : win.join(canonicalize(parent, this.#realpath), win.basename(p));
  }

  /**
   * Same-directory temp file, fsync, rename over the target. The temp file is judged again once
   * open and once more, with the target, right before the rename. On failure only the temp file
   * this call created (its name is unique) is removed.
   */
  writeAtomic(target: string, data: string | Uint8Array): void {
    const p = this.#require(target, 'write');
    const tmp = win.join(win.dirname(p), `.${win.basename(p)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    this.#require(tmp, 'write');
    const fd = this.#io.openSync(tmp, 'wx');
    let renamed = false;
    try {
      let id: FileId;
      try {
        id = this.#verifyOpened('write', fd, tmp);
        writeAll(fd, data);
        fs.fsyncSync(fd);
      } finally {
        this.#io.closeSync(fd);
      }
      this.#verifyPath('write', tmp, id);
      this.#require(p, 'write');
      this.#io.renameSync(tmp, p);
      renamed = true;
    } finally {
      if (!renamed) removeQuietly(tmp);
    }
  }

  /**
   * Appends to an existing file, or creates it exclusively. The handle is judged before the first
   * byte: its own hard-link count, and where its path now leads. A file this call created is
   * removed again when that fails; an existing one is left as it was.
   */
  append(target: string, data: string | Uint8Array, opts: { fsync?: boolean } = {}): void {
    const p = this.#require(target, 'append');
    let fd: number;
    let created = false;
    try {
      fd = this.#io.openSync(p, APPEND_EXISTING);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
      fd = this.#io.openSync(p, 'ax');
      created = true;
    }
    let done = false;
    try {
      this.#verifyOpened('append', fd, p);
      writeAll(fd, data);
      if (opts.fsync === true) fs.fsyncSync(fd);
      done = true;
    } finally {
      this.#io.closeSync(fd);
      if (!done && created) removeQuietly(p);
    }
  }

  /**
   * Creates each missing level separately, so no directory outside ORCHESTRA_HOME is ever made.
   * Each new level is judged again once it exists and removed if it landed anywhere else. A level
   * that appeared meanwhile (EEXIST) is judged the same way and must be a plain directory; it is
   * never removed, since this call did not make it.
   */
  mkdirp(dir: string): string[] {
    const p = this.#require(dir, 'mkdir');
    const missing: string[] = [];
    let cur = p;
    while (!existsEntry(cur)) {
      missing.push(cur);
      const parent = win.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const created: string[] = [];
    for (const level of missing.reverse()) {
      this.#require(level, 'mkdir');
      try {
        this.#io.mkdirSync(level);
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
        this.#judgeExisting(level, e);
        continue;
      }
      const again = this.#placeAgain('mkdir', level);
      if (!again.ok) {
        removeDirQuietly(level);
        throw new WriteFenceError({ allow: false, op: 'mkdir', path: level, reason: 'changed-during-open', detail: again.detail });
      }
      created.push(level);
    }
    return created;
  }

  /** A level mkdirp found already there: still placed inside ORCHESTRA_HOME, not a link, a directory. */
  #judgeExisting(level: string, eexist: unknown): void {
    const again = this.#placeAgain('mkdir', level);
    const changed = (detail: ChangedDetail) => new WriteFenceError({ allow: false, op: 'mkdir', path: level, reason: 'changed-during-open', detail });
    if (!again.ok) throw changed(again.detail);
    const st = fs.lstatSync(level);
    if (st.isSymbolicLink()) throw changed('link');
    if (!st.isDirectory()) throw eexist;
  }

  /** A fresh directory `<parent>\<prefix>XXXXXX`, checked before and after creation. */
  mkdtemp(parent: string, prefix: string): string {
    this.#require(win.join(parent, `${prefix}XXXXXX`), 'mkdir');
    const made = fs.mkdtempSync(win.join(mustCheck(parent, 'mkdtemp parent'), prefix));
    const d = this.check(made, 'mkdir');
    if (!d.allow) {
      fs.rmdirSync(made);
      throw new WriteFenceError(d);
    }
    return made;
  }

  /**
   * Removes `target`. Every entry is checked on its own before it is removed. A junction or other
   * link is removed as an entry (unlink, else a non-recursive rmdir) and never entered.
   * A missing target is not an error.
   */
  rm(target: string, opts: { recursive?: boolean } = {}): RmResult {
    return { removed: this.#rmEntry(target, opts.recursive === true) };
  }

  #rmEntry(p: string, recursive: boolean): number {
    const checked = this.#require(p, 'rm');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(checked);
    } catch (e) {
      if (code(e) === 'ENOENT') return 0;
      throw e;
    }
    if (st.isSymbolicLink()) {
      removeLinkEntry(checked);
      return 1;
    }
    if (!st.isDirectory()) {
      fs.unlinkSync(checked);
      return 1;
    }
    let n = 0;
    if (recursive) {
      for (const name of fs.readdirSync(checked)) n += this.#rmEntry(win.join(checked, name), true);
    }
    fs.rmdirSync(checked);
    return n + 1;
  }
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/** Hard-link count of an existing file; 0 when it does not exist yet. */
function linkCount(p: string): number {
  try {
    return fs.statSync(p).nlink;
  } catch (e) {
    if (code(e) === 'ENOENT') return 0;
    throw e;
  }
}

function existsEntry(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
}

function removeLinkEntry(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

function removeQuietly(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // The temp file may never have been created.
  }
}

function removeDirQuietly(p: string): void {
  try {
    fs.rmdirSync(p);
  } catch {
    // Not empty any more: something else wrote into it, and it is not ours to clear.
  }
}
