import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Line, Rec, Tail } from '../../src/store/journal.ts';
import { canonicalDigest } from '../../src/store/canonical-json.ts';
import { chainHash, scanJournal } from '../../src/store/journal.ts';
import { ApplyError, appliedTail, applyBatch, dumpProjection, rebuildProjection } from '../../src/store/rebuild.ts';
import { R, clockCause, commitRec, humanCause, srcCause, uuidOf } from '../helpers/records.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3: the one apply function, record by record. A record the database cannot take is a
// typed refusal (never a half-applied batch); a duplicate that the checks before the append should
// have stopped is skipped and counted where the plan says so (human actions), refused elsewhere.

function rawBatch(after: Tail, recs: Rec[]): Line[] {
  let prev = after;
  return [...recs, commitRec(recs.length, uuidOf('apply-boot'), 3, 4)].map((r) => {
    const digest = canonicalDigest(r.body);
    const line = { jseq: prev.jseq + 1, bootId: uuidOf('apply-boot'), obsMono: 3, obsWall: 4, kind: r.kind, body: r.body, digest, prevHash: prev.hash, hash: chainHash(prev.hash, digest) };
    prev = { jseq: line.jseq, hash: line.hash };
    return line as Line;
  });
}

async function fresh(t: Parameters<typeof storeFixture>[0]) {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1'), R.event('p1', 1), R.item('i1', { partRef: 'p1' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1)), R.cursor('p1', 100, 1)]);
  const apply = (recs: Rec[]) => {
    try {
      applyBatch(s.db, rawBatch(appliedTail(s.db), recs));
      return 'applied';
    } catch (e) {
      return e instanceof ApplyError ? e.reason : String(e);
    }
  };
  const metric = (name: string) => Number(s.db.get('SELECT count(*) AS n FROM metric WHERE name = ?', name)!.n);
  return { f, s, apply, metric };
}

test('a cursor needs its part and never goes back (I02)', async (t) => {
  const { s, apply } = await fresh(t);
  assert.equal(apply([R.cursor('ghost', 10, 1)]), 'missing-row');
  assert.equal(apply([R.cursor('p1', 50, 0)]), 'cursor-backwards');
  assert.equal(apply([R.cursor('p1', 100, 1)]), 'applied', 'the same cursor again is no step back');
  assert.equal(apply([R.cursor('p1', 250, 2)]), 'applied');
  assert.deepEqual({ ...s.db.get('SELECT source_cursor, cursor_src_seq FROM part WHERE ref = ?', 'p1') }, { source_cursor: 250, cursor_src_seq: 2 });
});

test('a source event that is already there is skipped and counted (journal.dupEvent)', async (t) => {
  const { s, apply, metric } = await fresh(t);
  assert.equal(apply([R.event('p1', 7)]), 'applied');
  assert.equal(apply([R.event('p1', 7)]), 'applied');
  assert.equal(Number(s.db.get("SELECT count(*) AS n FROM event WHERE kind = 'event' AND part_ref = 'p1' AND src_seq = 7")!.n), 1);
  assert.equal(metric('journal.dupEvent'), 1);
});

test('a human action or result that got into the journal twice is skipped and counted (journal.dupAction, journal.dupResult); apply never fails on it', async (t) => {
  const { s, apply, metric } = await fresh(t);
  const a = uuidOf('dup-action');
  assert.equal(apply([R.human(a, 'seen', 'i1'), R.result(a, 'seen', 'i1')]), 'applied');
  assert.equal(apply([R.human(a, 'seen', 'i1'), R.result(a, 'seen', 'i1')]), 'applied');
  assert.equal(Number(s.db.get("SELECT count(*) AS n FROM event WHERE kind = 'human' AND action_id = ?", a)!.n), 1);
  assert.equal(Number(s.db.get("SELECT count(*) AS n FROM event WHERE kind = 'human.result' AND action_id = ?", a)!.n), 1);
  assert.deepEqual([metric('journal.dupAction'), metric('journal.dupResult')], [1, 1]);
});

test('the first notification sets notifiedAt; a later one changes nothing and is counted; one for an unknown item is refused', async (t) => {
  const { s, apply, metric } = await fresh(t);
  assert.equal(apply([R.notified('i1', 1, 'browser', 500, 9000)]), 'applied');
  assert.equal(apply([R.notified('i1', 2, 'toast', 800, 9900)]), 'applied');
  assert.deepEqual({ ...s.db.get('SELECT notified_mono, notified_wall, notified_via, notified_attempt FROM inbox_item WHERE id = ?', 'i1') }, { notified_mono: 500, notified_wall: 9000, notified_via: 'browser', notified_attempt: 1 });
  assert.equal(metric('journal.dupNotified'), 1);
  assert.equal(apply([R.notified('ghost', 1, 'browser', 1, 1)]), 'missing-row');
});

test('ids made once are never made twice: a second item, reminder, command or firing of a timer is refused; a snooze needs its item', async (t) => {
  const { apply } = await fresh(t);
  assert.equal(apply([R.item('i1')]), 'duplicate');
  assert.equal(apply([R.reminder('r1', 10)]), 'applied');
  assert.equal(apply([R.reminder('r1', 20)]), 'duplicate');
  const b = uuidOf('dup-brake');
  const b2 = uuidOf('dup-brake-2');
  const sub = { root: { pid: 5, createTime: '13' }, requestId: 'q1', killed: 1, residual: 0, status: 'ok' };
  assert.equal(apply([R.human(b, 'brake', '5:13'), R.human(b2, 'brake', '5:13')]), 'applied');
  assert.equal(apply([R.command('c1', b, [sub], 'ok'), R.result(b, 'brake', '5:13', 'applied', 'c1', [sub])]), 'applied');
  // Another action's Command under the same id (a replay of the same action is skipped: the dup test below).
  assert.equal(apply([R.command('c1', b2, [sub], 'ok'), R.result(b2, 'brake', '5:13', 'applied', 'c1', [sub])]), 'duplicate');
  assert.equal(apply([R.clock('silence:i1:0', 'mono', 20_000, 1, 2)]), 'applied');
  assert.equal(apply([R.clock('silence:i1:0', 'mono', 20_000, 1, 2)]), 'duplicate');
  assert.equal(apply([R.snooze('ghost', 99)]), 'missing-row');
  // A clock record of an earlier batch, of another class and entity, drives no reminder edge (R2-D).
  assert.equal(apply([R.tr('reminder', 'r1', 'none', 'pending', clockCause('silence:i1:0'))]), 'cause-mismatch');
});

test('a full rebuild empties every projection table first: stray rows the journal never wrote are gone afterwards', async (t) => {
  const { f, s } = await fresh(t);
  const live = dumpProjection(s.db);
  s.db.run("INSERT INTO project (id, cwd, hue, created_jseq, updated_jseq) VALUES ('stray', 'C:\\x', 1, 1, 1)");
  s.db.run("INSERT INTO part (ref, harness, created_jseq, updated_jseq) VALUES ('stray', 'dsh', 1, 1)");
  s.db.run("INSERT INTO event (jseq, kind, obs_mono, obs_wall, boot_id, line_digest, body) VALUES (999999, 'judgment', 0, 0, 'b', 'd', '{}')");
  s.db.run("INSERT INTO inbox_item (id, kind, sev, grp, conf, state, dedup_key, rev, created_jseq) VALUES ('stray', 'question', 'P1', 'fermatas', 'high', 'open', 'k', 1, 1)");
  s.db.run("INSERT INTO reminder (id, state, due_wall, rev, created_jseq) VALUES ('stray', 'pending', 1, 1, 1)");
  s.db.run("INSERT INTO command (id, action_id, verb, harness_pid, harness_create_time, status, subtrees, jseq) VALUES ('stray', 'a', 'kill-tree', 1, '1', 'ok', '[]', 1)");
  s.db.run("INSERT INTO protect_entry (pid, create_time, reason, added_jseq) VALUES (1, '1', 'tuning', 1)");
  const scan = scanJournal(fs.readFileSync(f.journal));
  assert.ok(scan.ok);
  let rebuilt = 'rebuilt';
  try {
    rebuildProjection(s.db, scan.batches);
  } catch (e) {
    rebuilt = (e as Error).message;
  }
  assert.equal(rebuilt, 'rebuilt', 'a stray row meets no record of the journal');
  assert.deepEqual(dumpProjection(s.db), live);
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('R2-J: a human.result answers its human (same verb, same target); every human but a brake\'s has its result in the batch; a Command and its result share one batch, action and subtrees', async (t) => {
  const { apply } = await fresh(t);
  const sub = { root: { pid: 101, createTime: '133000000000000001' }, requestId: 'req-1', killed: 3, residual: 0, status: 'ok' };
  const brake = uuidOf('j-brake');
  const target = '101:133000000000000001';
  assert.equal(apply([R.human(brake, 'brake', target)]), 'applied', 'a brake\'s human waits for its Command');
  // J1: the Command alone, its result later: refused, so a crash can never leave one without the other.
  assert.equal(apply([R.command('cmd1', brake, [sub], 'ok')]), 'no-result');
  assert.equal(apply([R.result(brake, 'brake', target, 'applied', 'no-such-cmd', [sub])]), 'result-mismatch', 'a result naming no Command');
  assert.equal(apply([R.command('cmd1', brake, [sub], 'ok'), R.result(brake, 'brake', target, 'applied', 'cmd1', [{ ...sub, killed: 4 }])]), 'result-mismatch', 'other subtrees');
  assert.equal(apply([R.command('cmd1', uuidOf('other'), [sub], 'ok'), R.result(brake, 'brake', target, 'applied', 'cmd1', [sub])]), 'result-mismatch', 'the Command of another action');
  assert.equal(apply([R.result(brake, 'brake', target, 'applied', 'cmd1', [sub]), R.command('cmd1', brake, [sub], 'ok')]), 'result-mismatch', 'the Command after its result');
  assert.equal(apply([R.command('cmd1', brake, [sub], 'ok'), R.result(brake, 'brake', target, 'applied', 'cmd1', [sub])]), 'applied');
  // J2: a non-brake human alone is refused (no orphan by construction); a result repeats its human's verb and target.
  const protect = uuidOf('j-protect');
  assert.equal(apply([R.human(protect, 'protect-add', '4242:133000000000000042')]), 'no-result');
  assert.equal(apply([R.human(protect, 'protect-add', '4242:133000000000000042'), R.result(protect, 'protect-remove', '4242:133000000000000042')]), 'result-mismatch');
  assert.equal(apply([R.human(protect, 'protect-add', '4242:133000000000000042'), R.result(protect, 'protect-add', '4242:133000000000000043')]), 'result-mismatch');
  assert.equal(apply([R.result(uuidOf('nobody'), 'seen', 'i1')]), 'no-human-record', 'a result that answers no human');
  assert.equal(apply([R.human(protect, 'protect-add', '4242:133000000000000042'), R.result(protect, 'protect-add', '4242:133000000000000042')]), 'applied');
});

test('R2-E: an action replayed from an old journal applies once: its transition, snooze time and Command are skipped and counted, not done again', async (t) => {
  const { s, apply, metric } = await fresh(t);
  const a = uuidOf('replayed-snooze');
  const snoozeBatch = (): Rec[] => [R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.snooze('i1', 99), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')];
  assert.equal(apply(snoozeBatch()), 'applied');
  assert.equal(apply([R.clock('snooze:i1:0', 'wall', 1, 1, 99), R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('snooze:i1:0'))]), 'applied');
  assert.equal(s.db.get("SELECT state FROM inbox_item WHERE id = 'i1'")!.state, 'open');
  assert.equal(apply(snoozeBatch()), 'applied', 'apply never fails on a duplicate');
  assert.equal(s.db.get("SELECT state FROM inbox_item WHERE id = 'i1'")!.state, 'open', 'the effect happened once');
  const rows = (kind: string) => Number(s.db.get('SELECT count(*) AS n FROM event WHERE kind = ? AND (action_id = ? OR ? = \'transition\')', kind, a, kind)!.n);
  assert.deepEqual([rows('human'), rows('human.result')], [1, 1]);
  assert.equal(Number(s.db.get("SELECT count(*) AS n FROM event WHERE kind = 'transition' AND action_id = ?", a)!.n), 1);
  assert.ok(metric('journal.dupAction') >= 2, 'the human and its effects are counted');
  // A brake's Command replayed with its result: skipped, not refused as a duplicate id.
  const b = uuidOf('replayed-brake');
  const sub = { root: { pid: 101, createTime: '133000000000000001' }, requestId: 'req-1', killed: 3, residual: 0, status: 'ok' };
  assert.equal(apply([R.human(b, 'brake', '101:133000000000000001')]), 'applied');
  const done = (): Rec[] => [R.command('cmdB', b, [sub], 'ok'), R.result(b, 'brake', '101:133000000000000001', 'applied', 'cmdB', [sub])];
  assert.equal(apply(done()), 'applied');
  assert.equal(apply(done()), 'applied');
  assert.equal(Number(s.db.get("SELECT count(*) AS n FROM command WHERE id = 'cmdB'")!.n), 1);
});

test('C11: a notified record changes ItemView.notify, so it moves rev to its batch; a later one changes nothing, rev included', async (t) => {
  const { s, apply } = await fresh(t);
  const rev = () => Number(s.db.get("SELECT rev FROM inbox_item WHERE id = 'i1'")!.rev);
  const before = rev();
  assert.equal(apply([R.notified('i1', 1, 'browser', 500, 9000)]), 'applied');
  assert.equal(rev(), appliedTail(s.db).jseq);
  assert.ok(rev() > before);
  const set = rev();
  assert.equal(apply([R.notified('i1', 2, 'toast', 800, 9900)]), 'applied');
  assert.equal(rev(), set, 'the duplicate moved nothing');
});
