import * as path from 'node:path';
import type { FileId, NamedFileDecision } from '../fs/write-fence.ts';
import { checkPath } from '../fs/paths.ts';
import { ownFields } from '../runtime/own.ts';
import { MIGRATIONS } from './migrations/0001-m0.ts';
import { frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// The one gate in front of SQLite (plan step 3, invariant 17). node:sqlite is a capability like
// node:fs: src/store/node-sqlite.ts holds it, boot.ts mints that module before the import fence, and
// a DbOpener reaches a real database only when node-sqlite.ts built it around its backend. A DbOpener
// built anywhere else, with any backend, opens nothing real.
//
// SQLite opens files by name and makes its -wal, -shm and -journal files itself, where the write
// fence never sees an open. So every open is judged by name before (the database and each side file:
// placed by the fence, no link at the entry or on the way from ORCHESTRA_HOME, no other hard link) and
// again after it, once SQLite holds the database, the -wal and the -shm open (a handle SQLite holds
// cannot be renamed or removed: measured EBUSY on 24.22), and the identity must not have changed. No
// statement of ours runs before the second judgment. What stays residual: a directory swapped for a
// junction inside the window between the two judgments sends SQLite's own creation elsewhere; the
// second judgment refuses and closes, leaving an empty database file (its 4096-byte header) where the
// junction pointed, and when the junction is swapped back before the second judgment, that file with
// an empty -wal and -shm (test/store/db.test.ts measures both). None of our rows ever goes there.
//
// Each connection has an authorizer from its open on. ATTACH and DETACH are refused everywhere, which
// refuses VACUUM and VACUUM INTO too (both attach a database: measured), and load_extension is a
// refused function besides allowExtension being off; backup and the rest of node:sqlite's surface
// never leave node-sqlite.ts. A writer may set its PRAGMAs only while it opens; afterwards it reads a
// fixed few. A snapshot connection allows SELECT, READ and FUNCTION, and the PRAGMAs quick_check,
// table_info, table_xinfo and query_only (never switched off), nothing else.
//
// A writer runs with secure_delete on, so a text cleared by a purge or an expiry is overwritten with
// zeros in its page instead of lingering in free space, and checkpoint() (PRAGMA wal_checkpoint
// (TRUNCATE), the one PRAGMA with an argument a sealed writer may run) copies the zeroed pages into the
// database and empties the -wal, where the old page images would otherwise stay readable while the
// store is open (src/store/snippets.ts; measured in test/store/snippets.test.ts).

/** The SQLite action codes and verdicts the authorizers use; node-sqlite.ts fills them from node:sqlite's constants. */
export type SqliteCodes = Readonly<{
  OK: number; DENY: number; SELECT: number; READ: number; FUNCTION: number; PRAGMA: number; ATTACH: number; DETACH: number; TRANSACTION: number; RECURSIVE: number;
}>;

export type Param = string | number | null | Uint8Array;
export type Row = Readonly<Record<string, unknown>>;
export type Authorizer = (code: number, a1: string | null, a2: string | null, db: string | null, trigger: string | null) => number;

/** A prepared statement as the backend hands it out: positional parameters only, rows without a prototype. */
export type RawStatement = {
  run(...params: Param[]): { changes: number };
  get(...params: Param[]): Row | undefined;
  all(...params: Param[]): Row[];
};

/** A connection as the backend hands it out; the raw DatabaseSync never leaves node-sqlite.ts. */
export type RawConnection = {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  setAuthorizer(fn: Authorizer): void;
  close(): void;
};

export type SqliteBackend = {
  codes: SqliteCodes;
  /** Opens `file` (a checked absolute path): 'rw' creates it when missing, 'ro' never writes or creates it. */
  open(file: string, mode: 'rw' | 'ro'): RawConnection;
};

/** The judgment a DbOpener needs from the write fence (WriteFence.checkByName). */
export type NameJudge = { checkByName(target: string): NamedFileDecision };

export type DbOpenerSpec = {
  /** The write fence of this orchestrad: it judges where every database and side file lies. */
  fence: NameJudge;
};
export type DbOpenerConfig = DbOpenerSpec & { backend: SqliteBackend };

export type DbErrorReason =
  | 'bad-path'
  | 'refused'
  | 'changed-during-open'
  | 'open-failed'
  | 'migration'
  | 'bad-param'
  | 'closed';

export class DbError extends Error {
  readonly code = 'ERR_ORCHESTRA_DB';
  readonly reason: DbErrorReason;
  readonly detail: string;
  constructor(reason: DbErrorReason, detail: string) {
    super(`[ERR_ORCHESTRA_DB] ${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}
frozenClass(DbError);

export type DbKind = 'writer' | 'read-only' | 'snapshot';

/** Side files SQLite may make next to a database. -journal is judged although WAL never keeps one. */
export const SIDE_SUFFIXES: readonly string[] = Object.freeze(['-wal', '-shm', '-journal']);

/** PRAGMAs a writer sets while it opens (r4 §5.3: WAL, synchronous NORMAL, one writer). */
const WRITER_SETUP: readonly string[] = [
  'PRAGMA synchronous = NORMAL',
  'PRAGMA secure_delete = ON',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA trusted_schema = OFF',
];
const SETUP_PRAGMAS: readonly string[] = ['journal_mode', 'synchronous', 'secure_delete', 'foreign_keys', 'temp_store', 'trusted_schema', 'user_version'];
/** PRAGMAs that take an argument and still only read. */
const READ_WITH_ARG: readonly string[] = ['quick_check', 'table_info', 'table_xinfo'];
/** PRAGMAs a sealed writer or a read-only connection may read (no argument). */
const READ_PRAGMAS: readonly string[] = [...READ_WITH_ARG, 'journal_mode', 'synchronous', 'secure_delete', 'foreign_keys', 'temp_store', 'trusted_schema', 'user_version', 'query_only'];
/** The checkpoint a sealed writer may run: TRUNCATE alone (copies every frame back and empties the -wal). */
const CHECKPOINT = 'PRAGMA wal_checkpoint(TRUNCATE)';

/** The PRAGMA reads Db.pragma() runs, each a fixed text. */
const PRAGMA_READS: Readonly<Record<string, string>> = Object.freeze({
  journal_mode: 'PRAGMA journal_mode',
  synchronous: 'PRAGMA synchronous',
  secure_delete: 'PRAGMA secure_delete',
  foreign_keys: 'PRAGMA foreign_keys',
  temp_store: 'PRAGMA temp_store',
  trusted_schema: 'PRAGMA trusted_schema',
  user_version: 'PRAGMA user_version',
  query_only: 'PRAGMA query_only',
  quick_check: 'PRAGMA quick_check',
});

type Phase = { setup: boolean };

/** The verdicts of one connection kind, as a pure function of the action (exported for the tests). */
export function decideAction(kind: DbKind, setup: boolean, codes: SqliteCodes, code: number, a1: string | null, a2: string | null): boolean {
  if (code === codes.ATTACH || code === codes.DETACH) return false;
  if (code === codes.FUNCTION) return a2 !== 'load_extension';
  if (code === codes.PRAGMA) {
    const name = String(a1).toLowerCase();
    if (setup && kind === 'writer' && SETUP_PRAGMAS.includes(name)) return true;
    if (READ_WITH_ARG.includes(name)) return true;
    // A writer never turns query_only on (it would stop writing); nothing ever turns it off.
    if (name === 'query_only') return a2 === null || (kind !== 'writer' && a2 === '1');
    if (name === 'wal_checkpoint') return kind === 'writer' && a2 !== null && a2.toUpperCase() === 'TRUNCATE';
    if (kind === 'snapshot') return false;
    return a2 === null && READ_PRAGMAS.includes(name);
  }
  if (code === codes.SELECT || code === codes.READ) return true;
  if (kind === 'snapshot') return false;
  if (kind === 'read-only') return code === codes.TRANSACTION || code === codes.RECURSIVE;
  return true;
}

function authorizerFor(kind: DbKind, phase: Phase, codes: SqliteCodes): Authorizer {
  return (code, a1, a2) => (decideAction(kind, phase.setup, codes, code, a1, a2) ? codes.OK : codes.DENY);
}

const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino;

/** A database path: a string that passes checkPath unchanged, so never a file: URI, a URL, a buffer or :memory:. */
function checkFile(file: unknown): string {
  if (typeof file !== 'string') throw new DbError('bad-path', 'a database path is a string');
  if (/^file:/i.test(file)) throw new DbError('bad-path', 'file: URIs are refused');
  const c = checkPath(file);
  if (!c.ok) throw new DbError('bad-path', `${c.reason}: ${file}`);
  if (c.path !== file) throw new DbError('bad-path', `not in normal form: ${file}`);
  return c.path;
}

const BACKEND_KEYS = ['codes', 'open'] as const;
const CODE_KEYS = ['OK', 'DENY', 'SELECT', 'READ', 'FUNCTION', 'PRAGMA', 'ATTACH', 'DETACH', 'TRANSACTION', 'RECURSIVE'] as const;

function ownBackend(b: SqliteBackend | undefined): SqliteBackend {
  const got = ownFields(b, BACKEND_KEYS);
  if (typeof got.open !== 'function') throw new DbError('open-failed', 'db opener: backend.open is required, there is no default');
  const codes = ownFields(got.codes, CODE_KEYS);
  for (const k of CODE_KEYS) if (!Number.isSafeInteger(codes[k])) throw new DbError('open-failed', `db opener: backend.codes.${k} is required`);
  return Object.freeze({ codes: Object.freeze(codes) as SqliteCodes, open: got.open });
}

/**
 * Opens orchestrad's databases. Required: the write fence that judges every name, and the backend,
 * which only node-sqlite.ts supplies (through the opener factory boot mints). Frozen, like the gates.
 */
export class DbOpener {
  readonly #fence: NameJudge;
  readonly #backend: SqliteBackend;

  constructor(config: DbOpenerConfig) {
    const cfg = ownFields(config, ['fence', 'backend'] as const);
    this.#backend = ownBackend(cfg.backend);
    const fence = cfg.fence;
    if (typeof fence !== 'object' || fence === null || typeof fence.checkByName !== 'function') {
      throw new DbError('open-failed', 'db opener: fence is required, there is no default');
    }
    this.#fence = fence;
    Object.freeze(this);
  }

  /** The writer: WAL, synchronous NORMAL, foreign keys, temp in memory, migrated to the latest schema. */
  open(file: string): Db {
    return this.#open(file, 'writer');
  }

  /** A read-only connection to an existing database (for workers); query_only, and an authorizer that refuses every write. */
  openReadOnly(file: string): Db {
    return this.#open(file, 'read-only');
  }

  /** A read-only connection to a snapshot copy (Codex's state_5 in tmp\, step 14): reads and four PRAGMAs, nothing else. */
  openSnapshot(file: string): Db {
    return this.#open(file, 'snapshot');
  }

  /** Judges `file` and its side files by name: each verdict, or a refusal. */
  #judge(file: string): Map<string, NamedFileDecision & { allow: true }> {
    const out = new Map<string, NamedFileDecision & { allow: true }>();
    for (const name of [file, ...SIDE_SUFFIXES.map((s) => `${file}${s}`)]) {
      const d = this.#fence.checkByName(name);
      if (!d.allow) throw new DbError('refused', `${d.reason}${'detail' in d ? ` (${String(d.detail)})` : ''}: ${name}`);
      out.set(name, d);
    }
    return out;
  }

  #open(given: string, kind: DbKind): Db {
    const file = checkFile(given);
    const before = this.#judge(file);
    const dbBefore = before.get(file)!;
    if (kind !== 'writer' && dbBefore.id === null) throw new DbError('open-failed', `no database at ${file}`);
    const phase: Phase = { setup: true };
    let raw: RawConnection;
    try {
      raw = this.#backend.open(file, kind === 'writer' ? 'rw' : 'ro');
    } catch (e) {
      throw new DbError('open-failed', `${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let ok = false;
    try {
      raw.setAuthorizer(authorizerFor(kind, phase, this.#backend.codes));
      if (kind === 'writer') raw.exec('PRAGMA journal_mode = WAL');
      // A read makes SQLite open (in WAL, create) the -wal and the -shm: from here on it holds all three.
      raw.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      this.#judgeAgain(file, before);
      if (kind === 'writer') {
        for (const s of WRITER_SETUP) raw.exec(s);
        migrate(raw);
      } else {
        raw.exec('PRAGMA query_only = 1');
      }
      phase.setup = false;
      ok = true;
      return new Db(raw, file, kind);
    } finally {
      if (!ok) closeQuietly(raw);
    }
  }

  /** After the open: every name still placed, no link, and the database the same file it was. */
  #judgeAgain(file: string, before: Map<string, NamedFileDecision & { allow: true }>): void {
    let after: Map<string, NamedFileDecision & { allow: true }>;
    try {
      after = this.#judge(file);
    } catch (e) {
      throw new DbError('changed-during-open', e instanceof DbError ? e.detail : String(e));
    }
    for (const [name, was] of before) {
      const now = after.get(name)!;
      if (was.id !== null && (now.id === null || !sameId(was.id, now.id))) throw new DbError('changed-during-open', `${name} is another file now`);
    }
    if (after.get(file)!.id === null) throw new DbError('changed-during-open', `${file} is not where SQLite opened it`);
  }
}
frozenClass(DbOpener);

function closeQuietly(raw: RawConnection): void {
  try {
    raw.close();
  } catch {
    // Already closed, or never fully opened.
  }
}

/** Runs every migration newer than the database's user_version, each in its own transaction. */
function migrate(raw: RawConnection): void {
  const row = raw.prepare('PRAGMA user_version').get();
  const at = Number(row?.user_version ?? 0);
  const latest = MIGRATIONS.length;
  if (!Number.isSafeInteger(at) || at < 0 || at > latest) throw new DbError('migration', `schema version ${String(row?.user_version)} is not one this orchestrad knows (latest ${latest})`);
  for (const m of MIGRATIONS.slice(at)) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const s of m.statements) raw.exec(s);
      raw.exec(m.setVersion);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw new DbError('migration', `${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function checkParams(params: readonly unknown[]): Param[] {
  return params.map((p, i) => {
    if (p === null || typeof p === 'string' || p instanceof Uint8Array) return p;
    if (typeof p === 'number' && Number.isSafeInteger(p)) return p;
    throw new DbError('bad-param', `parameter ${i + 1}: only strings, safe integers, null and bytes are bound`);
  });
}

/**
 * One open connection. SQL is fixed text with positional `?` parameters only (static scan
 * sql-text-literal-only); the parameters are strings, safe integers, null or bytes. Frozen.
 */
export class Db {
  readonly file: string;
  readonly kind: DbKind;
  readonly #raw: RawConnection;
  readonly #cache = new Map<string, RawStatement>();
  #open = true;
  #depth = 0;

  /** Only DbOpener makes one, around a connection it judged and sealed. */
  constructor(raw: RawConnection, file: string, kind: DbKind) {
    this.#raw = raw;
    this.file = file;
    this.kind = kind;
    Object.freeze(this);
  }

  #stmt(sql: string): RawStatement {
    if (!this.#open) throw new DbError('closed', this.file);
    if (typeof sql !== 'string') throw new DbError('bad-param', 'SQL is a string');
    let s = this.#cache.get(sql);
    if (s === undefined) {
      s = this.#raw.prepare(sql);
      this.#cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.#stmt(sql).run(...checkParams(params));
    return { changes: Number(r.changes) };
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    return this.#stmt(sql).get(...checkParams(params));
  }

  all(sql: string, ...params: Param[]): Row[] {
    return this.#stmt(sql).all(...checkParams(params));
  }

  /** The value of one PRAGMA read from a fixed list. */
  pragma(name: string): unknown {
    const sql = Object.hasOwn(PRAGMA_READS, name) ? PRAGMA_READS[name]! : null;
    if (sql === null) throw new DbError('bad-param', `no pragma read is named ${name}`);
    const row = this.#stmt(sql).get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  /**
   * PRAGMA wal_checkpoint(TRUNCATE): every frame of the -wal into the database, then the -wal emptied.
   * Writer only (the authorizer refuses it elsewhere), never inside a transaction. Returns whether a
   * reader kept it from finishing (busy), which leaves frames in the -wal until the next one.
   */
  checkpoint(): { busy: boolean } {
    if (this.#depth > 0) throw new DbError('bad-param', 'no checkpoint inside a transaction');
    const row = this.#stmt(CHECKPOINT).get();
    return { busy: row !== undefined && Number(row.busy) !== 0 };
  }

  /** Runs `fn` in one write transaction (BEGIN IMMEDIATE); a throw rolls it back. Not nestable. */
  transaction<T>(fn: () => T): T {
    if (!this.#open) throw new DbError('closed', this.file);
    if (this.#depth > 0) throw new DbError('bad-param', 'transactions do not nest');
    this.#depth++;
    this.#raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.#raw.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.#raw.exec('ROLLBACK');
      } catch {
        // SQLite rolled back on its own already.
      }
      throw e;
    } finally {
      this.#depth--;
    }
  }

  /** Several statements of fixed text in one call (no parameters). */
  exec(sql: string): void {
    if (!this.#open) throw new DbError('closed', this.file);
    this.#raw.exec(sql);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#cache.clear();
    this.#raw.close();
  }
}
frozenClass(Db);

/** Where orchestrad's database lives under ORCHESTRA_HOME. */
export function dbPath(home: string): string {
  return win.join(home, 'orchestra.db');
}
