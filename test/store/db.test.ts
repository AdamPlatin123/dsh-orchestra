import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FenceStat, WriteIo } from '../../src/fs/write-fence.ts';
import { WriteFence } from '../../src/fs/write-fence.ts';
import { DbError, DbOpener, decideAction } from '../../src/store/db.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { storeFixture } from '../helpers/store.ts';
import { junction, put } from '../helpers/tmp.ts';
import { realWriteIo } from '../helpers/write-io.ts';

// Plan step 3, invariant 17: SQLite only through db.ts's opener. Every database runs on the real
// node:sqlite through the minted factory (src/store/node-sqlite.ts), inside a fresh fixture.

const reason = (f: () => unknown): string => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return e instanceof DbError ? `${e.reason}` : (e as Error).message;
  }
};
const sqlRefused = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch (e) {
    // SQLite says "not authorized" for a refused statement, "authorization denied" for VACUUM's own ATTACH.
    return /not authorized|authorization denied/i.test((e as Error).message);
  }
};

test('the writer: WAL, synchronous NORMAL, foreign keys on, temp in memory, trusted_schema off, migrated to schema 1', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  assert.equal(db.pragma('journal_mode'), 'wal');
  assert.equal(db.pragma('synchronous'), 1);
  assert.equal(db.pragma('foreign_keys'), 1);
  assert.equal(db.pragma('temp_store'), 2);
  assert.equal(db.pragma('trusted_schema'), 0);
  assert.equal(db.pragma('user_version'), 1);
  assert.equal(db.pragma('quick_check'), 'ok');
  assert.ok(fs.existsSync(`${f.db}-wal`) && fs.existsSync(`${f.db}-shm`), 'SQLite holds the -wal and the -shm from the open on');
});

test('the writer refuses ATTACH, VACUUM INTO, VACUUM and load_extension, and changes no PRAGMA once open', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  const other = path.join(f.home, 'other.db');
  assert.ok(sqlRefused(() => db.exec(`ATTACH '${other}' AS x`)), 'ATTACH');
  assert.ok(sqlRefused(() => db.run('ATTACH ? AS x', other)), 'ATTACH with a bound name');
  assert.ok(sqlRefused(() => db.exec(`VACUUM INTO '${path.join(f.home, 'copy.db')}'`)), 'VACUUM INTO');
  assert.ok(sqlRefused(() => db.exec('VACUUM')), 'VACUUM attaches a temp database');
  assert.ok(sqlRefused(() => db.get("SELECT load_extension('x')")), 'load_extension');
  assert.ok(sqlRefused(() => db.exec('PRAGMA journal_mode = DELETE')), 'journal_mode once open');
  assert.ok(sqlRefused(() => db.exec('PRAGMA writable_schema = ON')), 'writable_schema');
  assert.ok(sqlRefused(() => db.exec('PRAGMA query_only = 1')), 'a writer never turns query_only on');
  assert.ok(sqlRefused(() => db.exec('PRAGMA user_version = 7')), 'user_version once open');
  assert.equal(fs.existsSync(other) || fs.existsSync(path.join(f.home, 'copy.db')), false, 'nothing was attached or copied');
  assert.equal(db.pragma('journal_mode'), 'wal');
  assert.equal(db.pragma('user_version'), 1);
  // Control: ordinary statements run.
  db.run("INSERT INTO metric (name, value) VALUES ('x', 1)");
  assert.equal(db.get("SELECT count(*) AS n FROM metric WHERE name = 'x'")!.n, 1);
});

test('a database path is a plain absolute string: file: URIs, URLs, buffers, :memory: and relative names are refused before SQLite sees them', async (t) => {
  const f = await storeFixture(t);
  const fwd = f.db.split(path.sep).join('/');
  const message = (p: unknown) => {
    try {
      f.opener.open(p as string);
      return 'opened';
    } catch (e) {
      return e instanceof DbError ? `${e.reason}: ${e.detail}` : String(e);
    }
  };
  for (const p of [`file:${fwd}`, `FILE:${fwd}?mode=rwc`, `file:///${fwd}`, 'file:x.db']) assert.equal(message(p), 'bad-path: file: URIs are refused', p);
  for (const p of [':memory:', 'x.db']) assert.equal(message(p), `bad-path: not-absolute: ${p}`, p);
  assert.equal(message(`${f.db}:ads`), `bad-path: ads: ${f.db}:ads`);
  assert.equal(message(`${f.home}\\.\\x.db`), `bad-path: not in normal form: ${f.home}\\.\\x.db`);
  for (const p of [new URL(`file:///${fwd}`), Buffer.from(f.db), 7]) assert.equal(message(p), 'bad-path: a database path is a string', String(p));
  // Control: node:sqlite itself takes every file: spelling as a URI (measured on 24.22), which is why the opener refuses them.
  const raw = new DatabaseSync(`file:${path.join(f.dir, 'uri.db').split(path.sep).join('/')}`);
  raw.close();
  assert.ok(fs.existsSync(path.join(f.dir, 'uri.db')));
  assert.deepEqual(fs.readdirSync(f.home), [], 'the opener created nothing');
});

test('the fence judges every name: outside ORCHESTRA_HOME, under a harness root, a junction on the way, a link or a hard link at a name are refused and create nothing', async (t) => {
  const f = await storeFixture(t);
  assert.equal(reason(() => f.opener.open(path.join(f.dir, 'elsewhere.db'))), 'refused');
  fs.mkdirSync(path.join(f.dir, 'claude'));
  assert.equal(reason(() => f.opener.open(path.join(f.dir, 'claude', 'x.db'))), 'refused');
  // A junction inside home pointing inside home: placed, but not where it is written.
  const real = path.join(f.home, 'real');
  fs.mkdirSync(real);
  junction(f.dir, path.join(f.home, 'via'), real);
  assert.match((() => { try { f.opener.open(path.join(f.home, 'via', 'x.db')); return ''; } catch (e) { return (e as Error).message; } })(), /refused: link \(path\)/);
  assert.deepEqual(fs.readdirSync(real), []);
  // A -wal that is a hard link to a file elsewhere.
  const outside = put(path.join(f.dir, 'outside.bin'), 'keep');
  fs.linkSync(outside, path.join(f.home, 'h.db-wal'));
  assert.match((() => { try { f.opener.open(path.join(f.home, 'h.db')); return ''; } catch (e) { return (e as Error).message; } })(), /refused: hardlink/);
  assert.equal(fs.existsSync(path.join(f.home, 'h.db')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  // A dangling directory link at the -shm name (the junction's target does not exist).
  junction(f.dir, path.join(f.home, 'd.db-shm'), path.join(f.dir, 'nowhere'));
  assert.match((() => { try { f.opener.open(path.join(f.home, 'd.db')); return ''; } catch (e) { return (e as Error).message; } })(), /refused: link \(entry\)/);
  assert.equal(fs.existsSync(path.join(f.home, 'd.db')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'nowhere')), false);
});

/** A real-fs WriteIo that swaps `dir` for a junction to `target` right after the opener's last pre-open judgment (the -journal name's final stat). */
function swappingIo(dir: string, target: string): { io: WriteIo; swapped: () => boolean } {
  let journalStats = 0;
  let done = false;
  const io: WriteIo = {
    ...realWriteIo,
    statSync: (p: string): FenceStat => {
      try {
        return realWriteIo.statSync(p);
      } finally {
        if (!done && p.toLowerCase().endsWith('x.db-journal') && ++journalStats === 2) {
          done = true;
          fs.renameSync(dir, `${dir}-aside`);
          fs.symlinkSync(target, dir, 'junction');
        }
      }
    },
  };
  return { io, swapped: () => done };
}

test('measured, staged junction swap: the directory becomes a junction between the pre-open judgment and the open; the post-open judgment refuses and closes, and what SQLite made at the target is one empty database, none of our tables', async (t) => {
  const f = await storeFixture(t);
  const dbDir = path.join(f.home, 'store');
  fs.mkdirSync(dbDir);
  const target = path.join(f.dir, 'target');
  fs.mkdirSync(target);
  const { io, swapped } = swappingIo(dbDir, target);
  const fence = new WriteFence({ orchestraHome: f.home, harnessRoots: [], io });
  const opener = await makeDbOpener({ fence });
  const r = reason(() => opener.open(path.join(dbDir, 'x.db')));
  assert.equal(swapped(), true, 'the swap happened inside the window');
  assert.equal(r, 'changed-during-open');
  assert.deepEqual(fs.readdirSync(`${dbDir}-aside`), [], 'nothing reached the real directory');
  // The residual, measured: SQLite made the database where the junction pointed before the second
  // judgment could refuse; it removed its -wal and -shm when the connection closed.
  const left = fs.readdirSync(target).sort();
  t.diagnostic(`residual at the junction target: ${left.map((n) => `${n}:${fs.statSync(path.join(target, n)).size}`).join(' ')}`);
  assert.deepEqual(left.filter((n) => n !== 'x.db'), [], 'only the database file itself');
  if (left.includes('x.db')) {
    const raw = new DatabaseSync(path.join(target, 'x.db'), { readOnly: true });
    try {
      assert.deepEqual(raw.prepare('SELECT name FROM sqlite_master').all(), [], 'no table of ours: migrations run only after the second judgment');
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0);
    } finally {
      raw.close();
    }
  }
  // Control: without the swap the same opener opens and migrates.
  fs.rmSync(dbDir);
  fs.renameSync(`${dbDir}-aside`, dbDir);
  const ok = await makeDbOpener({ fence: new WriteFence({ orchestraHome: f.home, harnessRoots: [], io: realWriteIo }) });
  const db = ok.open(path.join(dbDir, 'y.db'));
  assert.equal(db.pragma('user_version'), 1);
  db.close();
});

test('measured, swap and swap back: the junction is gone again by the post-open judgment, which finds no database where SQLite says it opened one and refuses; what SQLite made at the target holds none of our tables', async (t) => {
  const f = await storeFixture(t);
  const dbDir = path.join(f.home, 'store');
  fs.mkdirSync(dbDir);
  const target = path.join(f.dir, 'target');
  fs.mkdirSync(target);
  const { io: swapIo, swapped } = swappingIo(dbDir, target);
  let restored = false;
  const io: WriteIo = {
    ...swapIo,
    realpath: (p: string) => {
      // The first call after the swap is the post-open judgment's: put the real directory back first.
      if (swapped() && !restored) {
        restored = true;
        fs.rmdirSync(dbDir);
        fs.renameSync(`${dbDir}-aside`, dbDir);
      }
      return realWriteIo.realpath(p);
    },
  };
  const opener = await makeDbOpener({ fence: new WriteFence({ orchestraHome: f.home, harnessRoots: [], io }) });
  let detail = '';
  try {
    opener.open(path.join(dbDir, 'x.db'));
  } catch (e) {
    detail = e instanceof DbError ? `${e.reason}: ${e.detail}` : String(e);
  }
  assert.equal(restored, true);
  assert.match(detail, /^changed-during-open: .+x\.db is not where SQLite opened it$/);
  assert.deepEqual(fs.readdirSync(dbDir), [], 'nothing in the real directory');
  const left = fs.readdirSync(target).sort();
  t.diagnostic(`residual at the junction target: ${left.map((n) => `${n}:${fs.statSync(path.join(target, n)).size}`).join(' ')}`);
  assert.ok(left.every((n) => n.startsWith('x.db')));
  const raw = new DatabaseSync(path.join(target, 'x.db'), { readOnly: true });
  try {
    assert.deepEqual(raw.prepare('SELECT name FROM sqlite_master').all(), []);
  } finally {
    raw.close();
  }
});

test('a read-only or snapshot connection holds the -wal and the -shm from its open on, before any query of the caller', async (t) => {
  const f = await storeFixture(t);
  f.opener.open(f.db).close();
  assert.equal(fs.existsSync(`${f.db}-wal`), false, 'the last close removed them');
  const ro = f.track(f.opener.openReadOnly(f.db));
  assert.ok(fs.existsSync(`${f.db}-wal`) && fs.existsSync(`${f.db}-shm`));
  ro.close();
});

test('the opener re-judges after the open: a database that is another file afterwards is refused', async (t) => {
  const f = await storeFixture(t);
  const first = f.opener.open(f.db);
  first.close();
  let calls = 0;
  const io: WriteIo = {
    ...realWriteIo,
    statSync: (p: string): FenceStat => {
      const s = realWriteIo.statSync(p);
      // From the second judgment on, the database reports another identity.
      if (p.toLowerCase().endsWith('orchestra.db') && ++calls > 2) return { ...s, ino: s.ino + 1n };
      return s;
    },
  };
  const opener = await makeDbOpener({ fence: new WriteFence({ orchestraHome: f.home, harnessRoots: [], io }) });
  assert.equal(reason(() => opener.open(f.db)), 'changed-during-open');
});

test('a snapshot connection reads and runs quick_check, table_info, table_xinfo and query_only; writable_schema, writes, ATTACH, transactions and query_only = 0 are refused', async (t) => {
  const f = await storeFixture(t);
  const src = path.join(f.home, 'tmp-snap.db');
  const raw = new DatabaseSync(src);
  raw.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT, title TEXT); INSERT INTO threads VALUES ('a', 't');");
  raw.close();
  const snap = f.track(f.opener.openSnapshot(src));
  assert.equal(snap.kind, 'snapshot');
  assert.equal(snap.get('PRAGMA quick_check')!.quick_check, 'ok');
  assert.equal(snap.all('PRAGMA table_info(threads)').length, 2);
  assert.equal(snap.all('PRAGMA table_xinfo(threads)').length, 2);
  assert.equal(snap.pragma('query_only'), 1);
  assert.deepEqual(snap.all('SELECT id FROM threads').map((r) => r.id), ['a']);
  assert.equal(snap.get('SELECT count(*) AS n FROM threads WHERE id = ?', 'a')!.n, 1);
  assert.ok(sqlRefused(() => snap.exec('PRAGMA writable_schema')), 'writable_schema');
  assert.ok(sqlRefused(() => snap.exec('PRAGMA writable_schema = ON')), 'writable_schema = ON');
  assert.ok(sqlRefused(() => snap.exec('PRAGMA query_only = 0')), 'query_only = 0');
  assert.ok(sqlRefused(() => snap.exec('PRAGMA journal_mode')), 'journal_mode is not one of the four');
  assert.ok(sqlRefused(() => snap.run("INSERT INTO threads VALUES ('b', 'u')")), 'INSERT');
  assert.ok(sqlRefused(() => snap.exec('BEGIN')), 'BEGIN');
  assert.ok(sqlRefused(() => snap.exec(`ATTACH '${path.join(f.home, 'z.db')}' AS z`)), 'ATTACH');
  assert.ok(sqlRefused(() => snap.get("SELECT load_extension('x')")), 'load_extension');
  assert.ok(sqlRefused(() => snap.all('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n')), 'recursive');
  // A snapshot of nothing is no snapshot: the opener never creates one.
  assert.throws(() => f.opener.openSnapshot(path.join(f.home, 'missing.db')), (e: unknown) => e instanceof DbError && e.reason === 'open-failed' && /^no database at /.test(e.detail));
  assert.equal(fs.existsSync(path.join(f.home, 'missing.db')), false);
});

test('a read-only connection (for workers) reads and runs read transactions, and refuses every write', async (t) => {
  const f = await storeFixture(t);
  const w = f.track(f.opener.open(f.db));
  w.run("INSERT INTO metric (name, value) VALUES ('m', 3)");
  const ro = f.track(f.opener.openReadOnly(f.db));
  ro.exec('BEGIN');
  assert.equal(ro.get("SELECT value FROM metric WHERE name = 'm'")!.value, 3);
  ro.exec('COMMIT');
  assert.equal(ro.pragma('query_only'), 1);
  assert.ok(sqlRefused(() => ro.run("INSERT INTO metric (name, value) VALUES ('n', 1)")), 'INSERT');
  assert.ok(sqlRefused(() => ro.run('DELETE FROM metric')), 'DELETE');
  assert.ok(sqlRefused(() => ro.exec('CREATE TABLE t (a INTEGER)')), 'CREATE');
  assert.ok(sqlRefused(() => ro.exec('PRAGMA query_only = 0')), 'query_only = 0');
});

test('parameters are strings, safe integers, null or bytes; SQL is a string; a closed connection refuses', async (t) => {
  const f = await storeFixture(t);
  const db = f.opener.open(f.db);
  for (const bad of [1.5, NaN, 2 ** 53, 1n, {}, [], undefined, true]) {
    assert.equal(reason(() => db.run('INSERT INTO metric (name, value) VALUES (?, ?)', 'p', bad as never)), 'bad-param', String(bad));
  }
  assert.equal(reason(() => db.get(1 as never)), 'bad-param');
  assert.equal(reason(() => db.pragma('writable_schema')), 'bad-param');
  assert.equal(reason(() => db.transaction(() => db.transaction(() => 1))), 'bad-param', 'transactions do not nest');
  db.close();
  assert.equal(reason(() => db.get('SELECT 1')), 'closed');
  assert.ok(Object.isFrozen(db) && Object.isFrozen(Object.getPrototypeOf(db)));
});

test('a DbOpener needs a fence and a backend; one built with a backend of its own opens nothing real, and the factory ignores a backend in its spec', async (t) => {
  const f = await storeFixture(t);
  const refusal = (cfg: unknown) => {
    try {
      new DbOpener(cfg as never);
      return 'built';
    } catch (e) {
      return e instanceof DbError ? e.detail : String(e);
    }
  };
  const codes = { OK: 0, DENY: 1, SELECT: 21, READ: 20, FUNCTION: 31, PRAGMA: 19, ATTACH: 24, DETACH: 25, TRANSACTION: 22, RECURSIVE: 33 };
  assert.equal(refusal({ fence: f.fence }), 'db opener: backend.open is required, there is no default');
  assert.equal(refusal({ fence: f.fence, backend: { codes: { ...codes, PRAGMA: undefined }, open: () => null } }), 'db opener: backend.codes.PRAGMA is required');
  assert.equal(refusal({ backend: { codes, open: () => null } }), 'db opener: fence is required, there is no default');
  assert.equal(refusal({ fence: { checkByName: 1 }, backend: { codes, open: () => null } }), 'db opener: fence is required, there is no default');
  assert.equal(refusal(Object.assign(Object.create({ fence: f.fence }) as object, { backend: { codes, open: () => null } })), 'db opener: fence is required, there is no default', 'a fence on the prototype is not read');
  const opened: string[] = [];
  const fake = new DbOpener({
    fence: f.fence,
    backend: { codes: { OK: 0, DENY: 1, SELECT: 21, READ: 20, FUNCTION: 31, PRAGMA: 19, ATTACH: 24, DETACH: 25, TRANSACTION: 22, RECURSIVE: 33 }, open: (file) => { opened.push(file); throw new Error('fake'); } },
  });
  assert.equal(reason(() => fake.open(f.db)), 'open-failed');
  assert.deepEqual(opened, [f.db]);
  assert.equal(fs.existsSync(f.db), false, 'the fake backend is all such an opener reaches');
  assert.ok(Object.isFrozen(fake) && Object.isFrozen(DbOpener.prototype));
});

test('decideAction: the three connection kinds, as a table', () => {
  const C = { OK: 0, DENY: 1, SELECT: 21, READ: 20, FUNCTION: 31, PRAGMA: 19, ATTACH: 24, DETACH: 25, TRANSACTION: 22, RECURSIVE: 33 };
  const INSERT = 18;
  const d = (kind: 'writer' | 'read-only' | 'snapshot', setup: boolean, code: number, a1: string | null = null, a2: string | null = null) => decideAction(kind, setup, C, code, a1, a2);
  for (const k of ['writer', 'read-only', 'snapshot'] as const) {
    for (const setup of [true, false]) {
      assert.equal(d(k, setup, C.ATTACH, 'x'), false);
      assert.equal(d(k, setup, C.DETACH, 'x'), false);
      assert.equal(d(k, setup, C.FUNCTION, null, 'load_extension'), false);
      assert.equal(d(k, setup, C.PRAGMA, 'writable_schema'), false);
      assert.equal(d(k, setup, C.PRAGMA, 'quick_check'), true);
      assert.equal(d(k, setup, C.PRAGMA, 'query_only', '0'), false);
      assert.equal(d(k, setup, C.SELECT), true);
    }
  }
  assert.equal(d('writer', true, C.PRAGMA, 'journal_mode', 'WAL'), true);
  assert.equal(d('writer', false, C.PRAGMA, 'journal_mode', 'DELETE'), false);
  assert.equal(d('writer', false, C.PRAGMA, 'journal_mode', null), true);
  assert.equal(d('writer', false, INSERT, 'event'), true);
  assert.equal(d('read-only', false, INSERT, 'event'), false);
  assert.equal(d('read-only', false, C.TRANSACTION, 'BEGIN'), true);
  assert.equal(d('read-only', true, C.PRAGMA, 'query_only', '1'), true);
  assert.equal(d('snapshot', false, C.TRANSACTION, 'BEGIN'), false);
  assert.equal(d('snapshot', false, C.PRAGMA, 'journal_mode', null), false);
  assert.equal(d('snapshot', true, C.PRAGMA, 'journal_mode', 'WAL'), false, 'setup PRAGMAs are the writer\'s alone');
  assert.equal(d('snapshot', false, C.PRAGMA, 'table_xinfo', 't'), true);
  assert.equal(d('snapshot', false, C.RECURSIVE), false);
  assert.equal(d('snapshot', false, INSERT, 'x'), false);
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('S5: a sealed writer may run PRAGMA wal_checkpoint(TRUNCATE) and nothing else of the checkpoint; no other connection may; secure_delete is on from the open', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  assert.equal(db.pragma('secure_delete'), 1);
  assert.deepEqual(db.checkpoint(), { busy: false });
  assert.ok(sqlRefused(() => db.get('PRAGMA wal_checkpoint(FULL)')), 'FULL');
  assert.ok(sqlRefused(() => db.get('PRAGMA wal_checkpoint')), 'no argument');
  assert.ok(sqlRefused(() => db.exec('PRAGMA secure_delete = OFF')), 'secure_delete stays on');
  assert.throws(() => db.transaction(() => db.checkpoint()), (e: unknown) => e instanceof DbError && e.reason === 'bad-param');
  const ro = f.track(f.opener.openReadOnly(f.db));
  assert.ok(sqlRefused(() => ro.checkpoint()), 'a read-only connection');
  const C = { OK: 0, DENY: 1, SELECT: 21, READ: 20, FUNCTION: 31, PRAGMA: 19, ATTACH: 24, DETACH: 25, TRANSACTION: 22, RECURSIVE: 33 };
  assert.equal(decideAction('writer', false, C, C.PRAGMA, 'wal_checkpoint', 'TRUNCATE'), true);
  assert.equal(decideAction('writer', false, C, C.PRAGMA, 'wal_checkpoint', 'RESTART'), false);
  assert.equal(decideAction('snapshot', false, C, C.PRAGMA, 'wal_checkpoint', 'TRUNCATE'), false);
  assert.equal(decideAction('read-only', false, C, C.PRAGMA, 'wal_checkpoint', 'TRUNCATE'), false);
});

test('R3-9: the open options in force: a double-quoted string is no literal, and options poisoned on Object.prototype do not reach DatabaseSync (no defensive off, no BigInt reads)', async (t) => {
  const f = await storeFixture(t);
  const keys = ['defensive', 'readBigInts', 'enableDoubleQuotedStringLiterals', 'returnArrays'] as const;
  const values = { defensive: false, readBigInts: true, enableDoubleQuotedStringLiterals: true, returnArrays: true };
  for (const k of keys) Object.defineProperty(Object.prototype, k, { value: values[k], configurable: true, writable: true });
  let opener: DbOpener;
  try {
    opener = await makeDbOpener({ fence: f.fence });
  } finally {
    for (const k of keys) delete (Object.prototype as Record<string, unknown>)[k];
  }
  for (const k of keys) Object.defineProperty(Object.prototype, k, { value: values[k], configurable: true, writable: true });
  try {
    const db = f.track(opener!.open(f.db));
    assert.ok(/no such column/i.test(reason(() => db.get('SELECT "x" AS v'))), 'a double-quoted identifier, never a string literal');
    const row = db.get('SELECT 9007199254740991 AS v')!;
    assert.equal(typeof row.v, 'number', 'a safe integer comes back as a number');
    assert.ok(!Array.isArray(row), 'rows are objects');
    assert.ok(sqlRefused(() => db.exec('PRAGMA writable_schema = ON')) || /not authorized|defensive/i.test(reason(() => db.exec('PRAGMA writable_schema = ON'))));
  } finally {
    for (const k of keys) delete (Object.prototype as Record<string, unknown>)[k];
  }
});
