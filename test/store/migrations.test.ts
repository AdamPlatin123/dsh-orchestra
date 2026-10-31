import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DbError } from '../../src/store/db.ts';
import { MIGRATIONS, PROJECTION_TABLES, SIDE_TABLES } from '../../src/store/migrations/0001-m0.ts';
import { storeFixture } from '../helpers/store.ts';

// Plan step 3, migration 0001-m0: the tables of §2.2 item 3, the time fields of I04, the human
// backstop index, inbox_item's rev and committedJseq, applied_jseq.

const tablesOf = (rows: readonly Record<string, unknown>[]) => rows.map((r) => String(r.name)).sort();

test('0001 makes exactly the tables of plan §2.2 item 3 plus applied_jseq, every one STRICT, and sets user_version 1', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  assert.equal(MIGRATIONS.length, 1);
  assert.equal(db.pragma('user_version'), 1);
  const tables = tablesOf(db.all("SELECT name FROM sqlite_master WHERE type = 'table'"));
  assert.deepEqual(tables, ['applied_jseq', 'command', 'event', 'inbox_item', 'install_key', 'metric', 'part', 'project', 'protect_entry', 'reminder', 'snippet']);
  assert.deepEqual([...PROJECTION_TABLES, ...SIDE_TABLES].sort(), tables);
  for (const r of db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table'")) assert.match(String(r.sql), /\)\s*STRICT$/, String(r.name));
  assert.deepEqual({ ...db.get('SELECT jseq, hash FROM applied_jseq WHERE id = 1') }, { jseq: 0, hash: '0'.repeat(64) });
});

test('0001 keeps the time fields apart (I04): srcSeq, srcTime with its precision, obsMono, obsWall, bootId and jseq on events; committed_* and notified_* on items', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  const cols = (table: string) => db.all('SELECT name FROM pragma_table_info(?)', table).map((r) => String(r.name));
  for (const c of ['jseq', 'kind', 'ev_kind', 'part_ref', 'src_seq', 'src_time', 'src_time_precision', 'obs_mono', 'obs_wall', 'boot_id', 'line_digest', 'content_digest', 'snippet_ref', 'action_id', 'body']) {
    assert.ok(cols('event').includes(c), `event.${c}`);
  }
  for (const c of ['rev', 'committed_jseq', 'committed_mono', 'committed_wall', 'committed_boot_id', 'notified_mono', 'notified_wall', 'notified_via', 'snooze_until_wall', 'end_class', 'end_cause']) {
    assert.ok(cols('inbox_item').includes(c), `inbox_item.${c}`);
  }
  for (const c of ['pid', 'create_time', 'reason']) assert.ok(cols('protect_entry').includes(c), `protect_entry.${c}`);
  for (const c of ['source_cursor', 'cursor_src_seq']) assert.ok(cols('part').includes(c), `part.${c}`);
  // STRICT: a column takes its type or the statement fails.
  assert.throws(() => db.run("INSERT INTO metric (name, value) VALUES ('x', 'not a number')"), /cannot store TEXT value in INTEGER column/);
});

test('0001\'s partial unique indexes: one human and one human.result per actionId, one source event per (partRef, srcSeq), one firing per timerId; other kinds are free', async (t) => {
  const f = await storeFixture(t);
  const db = f.track(f.opener.open(f.db));
  const idx = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").map((r) => [String(r.name), String(r.sql)]);
  assert.deepEqual(Object.fromEntries(idx.filter(([n]) => n.startsWith('event_'))), {
    event_clock_timer: "CREATE UNIQUE INDEX event_clock_timer ON event (timer_id) WHERE kind = 'clock'",
    event_human_action: "CREATE UNIQUE INDEX event_human_action ON event (action_id) WHERE kind = 'human'",
    event_result_action: "CREATE UNIQUE INDEX event_result_action ON event (action_id) WHERE kind = 'human.result'",
    event_source_seq: "CREATE UNIQUE INDEX event_source_seq ON event (part_ref, src_seq) WHERE kind = 'event'",
  });
  const ins = (jseq: number, kind: string, action: string | null, part: string | null = null, seq: number | null = null) => db.run(
    'INSERT INTO event (jseq, kind, part_ref, src_seq, obs_mono, obs_wall, boot_id, line_digest, action_id, body) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
    jseq, kind, part, seq, 'b', 'd', action, '{}',
  );
  ins(1, 'human', 'a1');
  assert.throws(() => ins(2, 'human', 'a1'), /UNIQUE constraint failed/);
  assert.equal(db.run('INSERT OR IGNORE INTO event (jseq, kind, obs_mono, obs_wall, boot_id, line_digest, action_id, body) VALUES (3, ?, 0, 0, ?, ?, ?, ?)', 'human', 'b', 'd', 'a1', '{}').changes, 0, 'INSERT OR IGNORE skips the duplicate');
  ins(4, 'human.result', 'a1');
  ins(5, 'transition', 'a1');
  ins(6, 'transition', 'a1');
  ins(7, 'event', null, 'p1', 9);
  assert.throws(() => ins(8, 'event', null, 'p1', 9), /UNIQUE constraint failed/);
  ins(9, 'event', null, 'p2', 9);
});

test('a reopen runs no migration again and keeps the rows; a database from a newer orchestrad is refused', async (t) => {
  const f = await storeFixture(t);
  const db = f.opener.open(f.db);
  db.run("INSERT INTO metric (name, value) VALUES ('kept', 1)");
  db.close();
  const again = f.track(f.opener.open(f.db));
  assert.equal(again.get("SELECT count(*) AS n FROM metric WHERE name = 'kept'")!.n, 1);
  again.close();
  const raw = new DatabaseSync(f.db);
  raw.exec('PRAGMA user_version = 9');
  raw.close();
  assert.throws(() => f.opener.open(f.db), (e: unknown) => e instanceof DbError && e.reason === 'migration' && /schema version 9/.test(e.message));
});

test('a migration that fails rolls back whole: nothing of it stays, and user_version stays 0', async (t) => {
  const f = await storeFixture(t);
  const raw = new DatabaseSync(f.db);
  raw.exec('CREATE TABLE inbox_item (x INTEGER)');
  raw.close();
  assert.throws(() => f.opener.open(f.db), (e: unknown) => e instanceof DbError && e.reason === 'migration');
  const check = new DatabaseSync(f.db, { readOnly: true });
  try {
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name), ['inbox_item']);
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 0);
  } finally {
    check.close();
  }
});
