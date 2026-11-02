import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ReadDecision, ReadGate } from '../fs/read-gate.ts';
import type { RenameDirResult, WriteFence } from '../fs/write-fence.ts';
import { WriteFenceError } from '../fs/write-fence.ts';
import { checkPath, isWithin, pathKey } from '../fs/paths.ts';
import { ownFields } from '../runtime/own.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The import copy (alpha 0.2 design §3.0). Its structure follows DS-Bot's first-run import,
// app/src/import.mjs (importTeam, copyThroughStage; Apache-2.0): put everything together in a
// staging folder beside the target, remove the leftovers of a copy that was killed, check for an
// abort between entries, never replace what is there, write the receipt into the stage and move it
// in with one final rename. What differs: every read goes through the read gate and every write
// through the write fence; the stage lives in ORCHESTRA_HOME\tmp (design §3.0), not beside the
// target, unless a caller asks; a link, junction or other reparse point anywhere in the copied tree voids
// the whole import instead of being made again; there are size and count caps; no key is copied.
//
// Everything here is synchronous, like the gate and the fence: an abort is seen between entries.

const win = path.win32;
const MIB = 1024 * 1024;

/** The stage's name: this prefix and 12 random hex digits (DS-Bot's `.import-<n>`). */
export const STAGE_PREFIX = '.import-';
const STAGE_NAME = /^\.import-[0-9a-f]{12}$/;
/** Names tried before begin() gives up making a fresh stage. */
const STAGE_TRIES = 8;

export type ImportLimits = {
  /** Bytes copied in one import, all files together. */
  maxBytes: number;
  /** Files copied plus files skipped in one import. */
  maxFiles: number;
  /** Bytes per read through the gate and per write through the fence. */
  chunkBytes: number;
};

/** Design §3.0: 256 MiB for each import, a suggested value, 1 MiB chunks; the file count cap is this module's own. */
export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = frozen({ maxBytes: 256 * MIB, maxFiles: 4096, chunkBytes: MIB });

export type ImportCopyReason =
  /** A link, junction or other reparse point in the copied tree or on the way to a copied file. */
  | 'reparse-point'
  /** Over maxBytes, or over the free space the caller gave. */
  | 'import-too-big'
  | 'too-many-files'
  /** A source file changed between the identity taken when it was added and the one after its copy. */
  | 'source-changed'
  | 'aborted'
  /** A destination name that is not a plain relative path inside the stage, or a receipt name that is not one plain name. */
  | 'bad-name'
  | 'duplicate-entry'
  /** The target exists: an import never replaces anything. */
  | 'target-exists'
  /** A source the caller named could not be listed or judged. */
  | 'source-unreadable'
  /** The commit rename moved the stage but the fence's checks after it failed: the target may hold the copy. */
  | 'commit-unverified'
  /** A call out of order: add after copy, commit before the receipt, anything after commit or discard. */
  | 'wrong-state';

export class ImportCopyError extends Error {
  readonly code = 'ERR_ORCHESTRA_IMPORT_COPY';
  readonly reason: ImportCopyReason;
  readonly detail: string;
  constructor(reason: ImportCopyReason, detail: string) {
    super(`[ERR_ORCHESTRA_IMPORT_COPY] ${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}
frozenClass(ImportCopyError);

/** A source file as stat reported it; dev and ino as decimal strings, so a receipt can carry them. */
export type SourceIdentity = { size: number; mtimeMs: number; dev: string; ino: string };

export type SkippedEntry = { source: string; rel: string; reason: string };

export type CopiedFile = {
  source: string;
  /** Path inside the stage, forward slashes. */
  rel: string;
  bytes: number;
  sha256: string;
  before: SourceIdentity;
  after: SourceIdentity;
  /** before and after differ; only ever true when the copy ran with requireUnchanged: false. */
  changed: boolean;
};

export type CopyReport = { files: CopiedFile[]; skipped: SkippedEntry[]; bytes: number };

export type CommitResult = { ok: true; path: string } | { ok: false; reason: 'busy'; code: 'EPERM' | 'EBUSY' };

/** What the copy uses of a read gate. */
export type CopyGate = Pick<ReadGate, 'decide' | 'stat' | 'openRead' | 'readdir' | 'entries'>;
/** What the copy uses of a write fence. */
export type CopyFence = Pick<WriteFence, 'check' | 'mkdirp' | 'writeAtomic' | 'append' | 'rm' | 'renameDir'>;

export type ImportStagerConfig = {
  gate: CopyGate;
  fence: CopyFence;
  /**
   * Required: where stages are made unless begin() names another place. The composition root passes
   * ORCHESTRA_HOME\tmp (design §3.0), which data-dir.ts empties at every start, so a stage left by a
   * killed orchestrad (a partial copy of a transcript) is swept at the next start and no lister of
   * imports\ ever meets a `.import-*` entry.
   */
  stagingParent: string;
  limits?: Partial<ImportLimits>;
};

export type BeginOptions = {
  /**
   * Where this stage is made instead of the stager's stagingParent, for a caller that asks for it
   * explicitly (DS-Bot's `.import-<n>` beside the data, say). It must be on the target's drive.
   * Leftover stages found here that this stager did not make are removed first.
   */
  stagingParent?: string;
  signal?: AbortSignal;
};

export type AddFileOptions = {
  /** Copy only [0, cut) of the file (design §3.1 step 5); the whole file when absent. */
  cut?: number;
};

export type AddTreeOptions = {
  /** Called with each entry's path relative to the tree (forward slashes); false leaves it out unlisted. */
  filter?: (rel: string, kind: 'dir' | 'file') => boolean;
};

export type CopyOptions = {
  /**
   * true (the default): a source file whose identity changed during its copy voids the import
   * (`source-changed`). false: the change is reported per file and the caller decides, as a fork at
   * a fixed cut may (design §3.1). A file that shrank below what was to be copied always voids it.
   */
  requireUnchanged?: boolean;
  /**
   * Free bytes on the stage's drive, when the caller knows them (the fence's io has no statfs yet):
   * a copy larger than this is refused up front as `import-too-big`.
   */
  freeBytes?: number;
};

/** `real`: the canonical path checked link-free at plan time; the copy opens exactly that file. */
type Planned = { source: string; real: string; rel: string; length: number; before: SourceIdentity };
/** `unverified`: the commit rename happened but its after-checks failed; the stage is gone, the target may hold the copy. */
type State = 'open' | 'copied' | 'receipt' | 'committed' | 'discarded' | 'unverified';

function errText(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

function identity(s: { size: bigint; mtimeMs: bigint; dev: bigint; ino: bigint }): SourceIdentity {
  return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: s.dev.toString(), ino: s.ino.toString() };
}

const sameIdentity = (a: SourceIdentity, b: SourceIdentity) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;

function positiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new RangeError(`import copy: ${what} must be a positive integer`);
  return v;
}

const drive = (p: string) => p.slice(0, 2).toLowerCase();

/**
 * One per orchestrad. It knows the stages it has open, so a leftover sweep never removes the stage
 * of an import still running in this process; the single-writer lock keeps every other process out.
 */
export class ImportStager {
  readonly limits: Readonly<ImportLimits>;
  readonly #gate: CopyGate;
  readonly #fence: CopyFence;
  readonly #live = new Set<string>();
  readonly #stagingParent: string;

  constructor(config: ImportStagerConfig) {
    const cfg = ownFields(config, ['gate', 'fence', 'stagingParent', 'limits'] as const);
    if (cfg.gate === undefined || cfg.fence === undefined) throw new Error('import copy: gate and fence are required');
    if (typeof cfg.stagingParent !== 'string') throw new Error('import copy: stagingParent is required (ORCHESTRA_HOME\\tmp), there is no default');
    const sp = checkPath(cfg.stagingParent);
    if (!sp.ok) throw new Error(`import copy: stagingParent ${cfg.stagingParent} (${sp.reason})`);
    this.#stagingParent = sp.path;
    this.#gate = cfg.gate;
    this.#fence = cfg.fence;
    const given = ownFields(cfg.limits ?? {}, ['maxBytes', 'maxFiles', 'chunkBytes'] as const);
    this.limits = Object.freeze({
      maxBytes: positiveInt(given.maxBytes ?? DEFAULT_IMPORT_LIMITS.maxBytes, 'maxBytes'),
      maxFiles: positiveInt(given.maxFiles ?? DEFAULT_IMPORT_LIMITS.maxFiles, 'maxFiles'),
      chunkBytes: positiveInt(given.chunkBytes ?? DEFAULT_IMPORT_LIMITS.chunkBytes, 'chunkBytes'),
    });
    Object.freeze(this);
  }

  /** Stages open right now (their paths). */
  openStages(): string[] {
    return [...this.#live];
  }

  /**
   * Opens a stage for an import into `target`, which must not exist. Removes the leftover stages in
   * the staging parent first (a copy that was killed leaves its stage; one that stopped or failed
   * removes its own) and reports how many it removed.
   */
  begin(target: string, opts: BeginOptions = {}): Stage {
    const o = ownFields(opts, ['stagingParent', 'signal'] as const);
    const c = checkPath(target);
    if (!c.ok) throw new ImportCopyError('bad-name', `target ${String(target)} (${c.reason})`);
    const to = c.path;
    const allowed = this.#fence.check(to, 'write');
    if (!allowed.allow) throw new ImportCopyError('bad-name', `target ${to} refused by the write fence (${allowed.reason})`);
    if (this.#exists(to)) throw new ImportCopyError('target-exists', to);
    const pc = checkPath(o.stagingParent ?? this.#stagingParent);
    if (!pc.ok) throw new ImportCopyError('bad-name', `staging parent ${String(o.stagingParent)} (${pc.reason})`);
    const parent = pc.path;
    if (drive(parent) !== drive(to)) throw new ImportCopyError('bad-name', `staging parent ${parent} is not on the target's drive`);
    if (isWithin(parent, to)) throw new ImportCopyError('bad-name', `staging parent ${parent} lies inside the target`);
    abortPoint(o.signal);
    this.#fence.mkdirp(parent);
    let swept = 0;
    for (const name of this.#gate.readdir(parent)) {
      const p = win.join(parent, name);
      if (!STAGE_NAME.test(name) || this.#live.has(pathKey(p))) continue;
      this.#fence.rm(p, { recursive: true });
      swept++;
    }
    const dir = this.#freshStage(parent);
    this.#live.add(pathKey(dir));
    return new Stage({
      dir,
      target: to,
      swept,
      signal: o.signal,
      gate: this.#gate,
      fence: this.#fence,
      limits: this.limits,
      release: () => this.#live.delete(pathKey(dir)),
    });
  }

  /**
   * A new, empty stage folder in `parent`, made by this call: mkdirp lists what it created, so a
   * name that is there already (left behind, or made by a racer) is never taken over.
   */
  #freshStage(parent: string): string {
    for (let i = 0; i < STAGE_TRIES; i++) {
      const dir = win.join(parent, `${STAGE_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
      const made = this.#fence.mkdirp(dir);
      if (made.length === 1 && pathKey(made[0]!) === pathKey(dir)) return dir;
    }
    throw new Error(`import copy: no fresh stage name in ${parent} after ${STAGE_TRIES} tries`);
  }

  /** True when the gate finds `p`; a target the gate cannot judge is left to the final rename, which never replaces. */
  #exists(p: string): boolean {
    const d = this.#gate.decide(p, 'stat');
    return d.allow;
  }
}
frozenClass(ImportStager);

function abortPoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ImportCopyError('aborted', String(signal.reason ?? 'aborted'));
}

type StageInit = {
  dir: string;
  target: string;
  swept: number;
  signal: AbortSignal | undefined;
  gate: CopyGate;
  fence: CopyFence;
  limits: Readonly<ImportLimits>;
  release: () => void;
};

/**
 * One import's staging folder: add the files (planned, nothing copied yet), copy them, write the
 * receipt, commit. Any failure from copy() on removes the stage before it is thrown; so does an
 * abort. After a `busy` commit the stage stays: commit again, or discard.
 */
export class Stage {
  /** The staging folder. */
  readonly dir: string;
  /** Where commit() moves it. */
  readonly target: string;
  /** Leftover stages begin() removed. */
  readonly swept: number;
  readonly #signal: AbortSignal | undefined;
  readonly #gate: CopyGate;
  readonly #fence: CopyFence;
  readonly #limits: Readonly<ImportLimits>;
  readonly #release: () => void;
  readonly #planned: Planned[] = [];
  readonly #skipped: SkippedEntry[] = [];
  readonly #names = new Set<string>();
  #bytes = 0;
  #state: State = 'open';

  constructor(init: StageInit) {
    this.dir = init.dir;
    this.target = init.target;
    this.swept = init.swept;
    this.#signal = init.signal;
    this.#gate = init.gate;
    this.#fence = init.fence;
    this.#limits = init.limits;
    this.#release = init.release;
    Object.freeze(this);
  }

  get state(): State {
    return this.#state;
  }

  #expect(...states: State[]): void {
    if (!states.includes(this.#state)) throw new ImportCopyError('wrong-state', `stage is ${this.#state}`);
  }

  /** Runs `fn`; a failure removes the stage before it is thrown. */
  #guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      try {
        this.discard();
      } catch {
        // The first failure is the one to report; a stage left behind goes with the next sweep.
      }
      throw e;
    }
  }

  /**
   * Plans the copy of one file to `rel` inside the stage. The file must be reached without a link
   * (the gate's canonical form of it is its parent's canonical form plus its own name); a file the
   * gate refuses is not copied and is listed as skipped.
   */
  addFile(source: string, rel: string, opts: AddFileOptions = {}): void {
    this.#expect('open');
    this.#guard(() => {
      abortPoint(this.#signal);
      const cut = ownFields(opts, ['cut'] as const).cut;
      if (cut !== undefined && (!Number.isSafeInteger(cut) || cut < 0)) throw new RangeError('import copy: cut must be a non-negative integer');
      const c = checkPath(source);
      if (!c.ok) throw new ImportCopyError('source-unreadable', `${String(source)} (${c.reason})`);
      const dir = win.dirname(c.path);
      const parent = this.#gate.decide(dir, 'stat');
      if (!parent.allow) throw new ImportCopyError('source-unreadable', `${dir} (${parent.reason})`);
      this.#linkFree(dir, parent.real);
      this.#planFile(c.path, win.join(parent.real, win.basename(c.path)), this.#destName(rel), cut);
    });
  }

  /**
   * Plans the copy of the tree `sourceDir` to `rel` inside the stage ('' for the stage itself). A
   * link, junction or other reparse point anywhere in it, the tree itself included, voids the import;
   * a file the gate refuses, or a directory it will not list, is skipped and listed. Empty
   * directories are not made.
   */
  addTree(sourceDir: string, rel: string, opts: AddTreeOptions = {}): void {
    this.#expect('open');
    this.#guard(() => {
      abortPoint(this.#signal);
      const filter = ownFields(opts, ['filter'] as const).filter;
      const c = checkPath(sourceDir);
      if (!c.ok) throw new ImportCopyError('source-unreadable', `${String(sourceDir)} (${c.reason})`);
      const self = this.#gate.decide(c.path, 'readdir');
      if (!self.allow) throw new ImportCopyError('source-unreadable', `${c.path} (${self.reason})`);
      this.#linkFree(c.path, self.real);
      const base = rel === '' ? '' : this.#destName(rel);
      this.#walk(c.path, self.real, base, '', filter);
    });
  }

  /**
   * `p` (canonical form `real`) is reached without a link below its gate root: at every level up to
   * the root, the canonical form is the parent's canonical form plus the level's own name. The root
   * itself, and whatever lies above it, may be a link (a user home moved with a junction).
   */
  #linkFree(p: string, real: string): void {
    let cur = p;
    let curReal = real;
    for (;;) {
      const parent = win.dirname(cur);
      if (parent === cur) return;
      const d = this.#gate.decide(parent, 'stat');
      if (!d.allow) {
        if (d.reason === 'outside-roots') return;
        throw new ImportCopyError('source-unreadable', `${parent} (${d.reason})`);
      }
      if (pathKey(curReal) !== pathKey(win.join(d.real, win.basename(cur)))) throw new ImportCopyError('reparse-point', `${cur} leads to ${curReal}`);
      cur = parent;
      curReal = d.real;
    }
  }

  #walk(dir: string, real: string, base: string, inner: string, filter: AddTreeOptions['filter']): void {
    for (const e of this.#gate.entries(dir)) {
      abortPoint(this.#signal);
      const source = win.join(dir, e.name);
      const innerRel = inner === '' ? e.name : `${inner}/${e.name}`;
      if (e.kind === 'link') throw new ImportCopyError('reparse-point', source);
      const kind = e.kind === 'dir' ? 'dir' : 'file';
      if (filter !== undefined && filter(innerRel, kind) !== true) continue;
      const rel = this.#destName(base === '' ? innerRel : `${base}/${innerRel}`);
      if (kind === 'dir') {
        const d = this.#gate.decide(source, 'readdir');
        if (!d.allow) {
          this.#skip(source, rel, d.reason);
          continue;
        }
        if (pathKey(d.real) !== pathKey(win.join(real, e.name))) throw new ImportCopyError('reparse-point', `${source} leads to ${d.real}`);
        this.#walk(source, d.real, base, innerRel, filter);
      } else {
        this.#planFile(source, win.join(real, e.name), rel, undefined);
      }
    }
  }

  #skip(source: string, rel: string, reason: string): void {
    this.#skipped.push({ source, rel, reason });
    this.#countCheck();
  }

  #countCheck(): void {
    const n = this.#planned.length + this.#skipped.length;
    if (n > this.#limits.maxFiles) throw new ImportCopyError('too-many-files', `more than ${this.#limits.maxFiles} entries`);
  }

  #planFile(source: string, expectedReal: string, rel: string, cut: number | undefined): void {
    const d: ReadDecision = this.#gate.decide(source, 'read');
    if (!d.allow) {
      this.#skip(source, rel, d.reason);
      return;
    }
    if (pathKey(d.real) !== pathKey(expectedReal)) throw new ImportCopyError('reparse-point', `${source} leads to ${d.real}`);
    let before: SourceIdentity;
    try {
      before = identity(this.#gate.stat(source));
    } catch (e) {
      throw new ImportCopyError('source-unreadable', `${source} (${errText(e)})`);
    }
    if (cut !== undefined && cut > before.size) throw new RangeError(`import copy: cut ${cut} lies past the end of ${source} (${before.size} bytes)`);
    const length = cut ?? before.size;
    const key = pathKey(rel);
    if (this.#names.has(key)) throw new ImportCopyError('duplicate-entry', rel);
    this.#names.add(key);
    this.#planned.push({ source, real: d.real, rel, length, before });
    this.#countCheck();
    this.#bytes += length;
    if (this.#bytes > this.#limits.maxBytes) throw new ImportCopyError('import-too-big', `${this.#bytes} bytes planned, at most ${this.#limits.maxBytes}`);
  }

  /** A destination path: plain segments, no `.` or `..`, a valid Windows name inside the stage. */
  #destName(rel: string): string {
    if (typeof rel !== 'string' || rel === '' || rel.includes('\\')) throw new ImportCopyError('bad-name', String(rel));
    const segs = rel.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new ImportCopyError('bad-name', rel);
    const c = checkPath(win.join(this.dir, ...segs));
    if (!c.ok) throw new ImportCopyError('bad-name', `${rel} (${c.reason})`);
    if (pathKey(c.path) === pathKey(this.dir) || !isWithin(c.path, this.dir)) throw new ImportCopyError('bad-name', rel);
    return segs.join('/');
  }

  /** Files planned so far and bytes they will take. */
  planned(): { files: number; skipped: number; bytes: number } {
    return { files: this.#planned.length, skipped: this.#skipped.length, bytes: this.#bytes };
  }

  /**
   * Copies every planned file into the stage, in chunks: read through the gate, the first chunk
   * written with writeAtomic and the rest appended, through the fence. Checks for an abort between
   * files and takes each source's identity again after its copy.
   */
  copy(opts: CopyOptions = {}): CopyReport {
    this.#expect('open');
    return this.#guard(() => {
      const o = ownFields(opts, ['requireUnchanged', 'freeBytes'] as const);
      const strict = o.requireUnchanged !== false;
      if (o.freeBytes !== undefined && this.#bytes > o.freeBytes) {
        throw new ImportCopyError('import-too-big', `${this.#bytes} bytes planned, ${o.freeBytes} free`);
      }
      const files: CopiedFile[] = [];
      for (const p of this.#planned) {
        abortPoint(this.#signal);
        files.push(this.#copyOne(p, strict));
      }
      abortPoint(this.#signal);
      this.#state = 'copied';
      return { files, skipped: this.#skipped.map((s) => ({ ...s })), bytes: this.#bytes };
    });
  }

  #copyOne(p: Planned, strict: boolean): CopiedFile {
    const dest = win.join(this.dir, ...p.rel.split('/'));
    this.#fence.mkdirp(win.dirname(dest));
    const hash = crypto.createHash('sha256');
    // One checked handle for every chunk: the path is resolved once, here, and must still be the
    // file planned (same canonical path, same dev/ino). A junction swapped in between chunks, or
    // between add and copy, cannot splice in another file's bytes.
    let h: ReturnType<CopyGate['openRead']>;
    try {
      h = this.#gate.openRead(p.source);
    } catch (e) {
      throw new ImportCopyError('source-changed', `${p.source} (${errText(e)})`);
    }
    let after: SourceIdentity;
    try {
      if (pathKey(h.real) !== pathKey(p.real)) throw new ImportCopyError('reparse-point', `${p.source} now leads to ${h.real}`);
      const at = identity(h.stat());
      // Another file under the same name voids the import even when the caller allows changes:
      // only the planned file's size and mtime may move (design §3.1's fork at a cut).
      if (at.dev !== p.before.dev || at.ino !== p.before.ino) throw new ImportCopyError('source-changed', `${p.source} is another file now`);
      let done = 0;
      let first = true;
      while (first || done < p.length) {
        const want = Math.min(this.#limits.chunkBytes, p.length - done);
        const chunk = want === 0 ? Buffer.alloc(0) : h.read(done, want);
        if (chunk.length < want) throw new ImportCopyError('source-changed', `${p.source} shrank below ${p.length} bytes`);
        hash.update(chunk);
        if (first) this.#fence.writeAtomic(dest, chunk);
        else this.#fence.append(dest, chunk, { fsync: done + chunk.length === p.length });
        done += chunk.length;
        first = false;
      }
      after = identity(h.stat());
    } finally {
      h.close();
    }
    const changed = !sameIdentity(p.before, after);
    if (changed && strict) throw new ImportCopyError('source-changed', p.source);
    return { source: p.source, rel: p.rel, bytes: p.length, sha256: hash.digest('hex'), before: p.before, after, changed };
  }

  /** Writes the receipt `name` (one plain name, not a copied file's) into the stage as JSON. */
  writeReceipt(name: string, value: unknown): void {
    this.#expect('copied', 'receipt');
    this.#guard(() => {
      abortPoint(this.#signal);
      if (typeof name !== 'string' || name.includes('/')) throw new ImportCopyError('bad-name', String(name));
      const rel = this.#destName(name);
      if (this.#names.has(pathKey(rel))) throw new ImportCopyError('duplicate-entry', rel);
      const text = JSON.stringify(value, null, 2);
      if (typeof text !== 'string') throw new TypeError('import copy: the receipt must be JSON');
      this.#fence.writeAtomic(win.join(this.dir, rel), `${text}\n`);
      this.#state = 'receipt';
    });
  }

  /**
   * The commit point: moves the stage to the target in one rename (the fence's renameDir). The
   * target's parent is made first. A target that appeared meanwhile is never replaced: the stage is
   * removed and `target-exists` thrown. `busy` leaves the stage as it is.
   */
  commit(): CommitResult {
    this.#expect('receipt');
    this.#guard(() => {
      abortPoint(this.#signal);
      this.#fence.mkdirp(win.dirname(this.target));
    });
    let r: RenameDirResult;
    try {
      r = this.#fence.renameDir(this.dir, this.target);
    } catch (e) {
      // renameDir throws changed-during-open only from its checks after the rename: the stage has
      // moved, so there is nothing to discard, and the whole copy, receipt included, may now sit at
      // the target. Say so instead of removing a stage that is gone and losing track of the copy.
      if (e instanceof WriteFenceError && e.decision.reason === 'changed-during-open') {
        this.#state = 'unverified';
        this.#release();
        throw new ImportCopyError('commit-unverified', `${this.target}: moved, but the check after the rename failed (${e.decision.detail}); a copy may be left at this path`);
      }
      try {
        this.discard();
      } catch {
        // As in #guard: the first failure is the one to report.
      }
      throw e;
    }
    if (r.ok) {
      this.#state = 'committed';
      this.#release();
      return { ok: true, path: r.to };
    }
    if (r.reason === 'exists') {
      this.discard();
      throw new ImportCopyError('target-exists', this.target);
    }
    return { ok: false, reason: 'busy', code: r.code };
  }

  /** Removes the stage. Harmless after a discard; refused after a commit. */
  discard(): void {
    if (this.#state === 'discarded') return;
    if (this.#state === 'committed' || this.#state === 'unverified') throw new ImportCopyError('wrong-state', `stage is ${this.#state}`);
    this.#state = 'discarded';
    try {
      this.#fence.rm(this.dir, { recursive: true });
    } finally {
      this.#release();
    }
  }
}
frozenClass(Stage);
