import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Line, Rec, Tail } from '../../src/store/journal.ts';
import { canonicalDigest, canonicalJson } from '../../src/store/canonical-json.ts';
import { chainHash, JournalError } from '../../src/store/journal.ts';
import { ApplyError, appliedTail, applyBatch } from '../../src/store/rebuild.ts';
import { R, clockCause, commitRec, humanCause, srcCause, uuidOf } from '../helpers/records.ts';
import { deleteDb, mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, I01, invariant 21: every transition carries a cause, and only source(partRef, srcSeq),
// human(actionId) or clock(timerId). apply refuses one without, whatever wrote it; the journal refuses
// it before the append; the startup scan refuses it in the file.

/** Lines as the journal would write them, but without any check: what a corrupted or hand-made journal could hold. */
function rawBatch(after: Tail, recs: Rec[], bootId = uuidOf('raw-boot')): Line[] {
  let prev = after;
  return [...recs, commitRec(recs.length, bootId)].map((r) => {
    const digest = canonicalDigest(r.body);
    const line = { jseq: prev.jseq + 1, bootId, obsMono: 1, obsWall: 2, kind: r.kind, body: r.body, digest, prevHash: prev.hash, hash: chainHash(prev.hash, digest) };
    prev = { jseq: line.jseq, hash: line.hash };
    return line as Line;
  });
}

const reasonOf = (f: () => unknown): string => {
  try {
    f();
    return 'applied';
  } catch (e) {
    return e instanceof ApplyError ? e.reason : e instanceof JournalError ? `journal:${e.reason}` : String(e);
  }
};

test('apply refuses a transition without a cause, or with any cause but source, human or clock, and changes nothing', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  const tr = (cause: unknown, drop = false): Rec => {
    const body: Record<string, unknown> = { entity: 'inbox_item', id: 'i1', from: 'open', to: 'seen', cause };
    if (drop) delete body.cause;
    return { kind: 'transition', body };
  };
  const before = appliedTail(s.db);
  for (const [what, rec] of [
    ['no cause at all', tr(null, true)],
    ['a null cause', tr(null)],
    ['an empty cause', tr({})],
    ['a timer kind', tr({ kind: 'timer', timerId: 'reminder:r1:0' })],
    ['a source without srcSeq', tr({ kind: 'source', partRef: 'p1' })],
    ['a human without actionId', tr({ kind: 'human' })],
    ['a clock without timerId', tr({ kind: 'clock' })],
  ] as const) {
    assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(before, [rec]))), 'no-cause', what);
  }
  assert.deepEqual(appliedTail(s.db), before);
  assert.equal(s.db.get('SELECT state FROM inbox_item WHERE id = ?', 'i1')!.state, 'open');
  // A cause of a known kind with a bad field gets past the cause check and meets the schema.
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(before, [tr({ kind: 'human', actionId: 'not-a-uuid' })]))), 'bad-body');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(before, [tr({ kind: 'clock', timerId: 'poll:p1:0' })]))), 'bad-body', 'a poll timer causes no transition');
  // Control: the same transition with a cause applies (a human cause with its seen action in the batch, src/model/inbox.ts).
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(before, [tr({ kind: 'human', actionId: uuidOf('seen') }), R.human(uuidOf('seen'), 'seen', 'i1'), R.result(uuidOf('seen'), 'seen', 'i1')]))), 'applied');
});

test('a cause on Object.prototype is no cause: apply reads a transition\'s own fields only', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  const tail = appliedTail(s.db);
  Object.defineProperty(Object.prototype, 'cause', { value: { kind: 'clock', timerId: 'reminder:x:0' }, configurable: true, writable: true });
  try {
    assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [{ kind: 'transition', body: { entity: 'inbox_item', id: 'i1', from: 'open', to: 'seen' } }]))), 'no-cause');
  } finally {
    delete (Object.prototype as Record<string, unknown>).cause;
  }
});

test('the journal refuses a transition without a cause before the append, and the startup scan refuses one in the file', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  const size = fs.statSync(f.journal).size;
  assert.equal(reasonOf(() => s.commit([{ kind: 'transition', body: { entity: 'inbox_item', id: 'i1', from: 'open', to: 'seen' } }])), 'journal:bad-record');
  assert.equal(fs.statSync(f.journal).size, size);
  const tail = s.tail;
  s.close();
  const text = rawBatch(tail, [{ kind: 'transition', body: { entity: 'inbox_item', id: 'i1', from: 'open', to: 'seen' } }]).map((l) => canonicalJson(l)).join('\n') + '\n';
  fs.appendFileSync(f.journal, text);
  deleteDb(f);
  const o = f.open();
  assert.equal(o.ok, false);
  assert.deepEqual(o.ok ? null : { why: o.break.why, line: o.break.line }, { why: 'body', line: tail.jseq + 1 });
});

test('each cause kind applies along an edge of its state machine; a record whose from is not the state, or an edge the table lacks, is refused', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const acted = uuidOf('acted');
  s.commit([R.event('p1', 4), R.item('i1', { partRef: 'p1' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 4))]);
  s.commit([R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(uuidOf('snz'))), R.snooze('i1', 999), R.human(uuidOf('snz'), 'snooze', 'i1'), R.result(uuidOf('snz'), 'snooze', 'i1')]);
  s.commit([R.clock('snooze:i1:0', 'wall', 10, 5, 999), R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('snooze:i1:0'))]);
  s.commit([R.tr('inbox_item', 'i1', 'open', 'acted', humanCause(acted)), R.human(acted, 'acted', 'i1'), R.result(acted, 'acted', 'i1')]);
  const row = s.db.get('SELECT state, end_class, end_cause, ended_action_id, snooze_until_wall FROM inbox_item WHERE id = ?', 'i1')!;
  assert.deepEqual({ ...row }, { state: 'acted', end_class: 'acted', end_cause: 'human', ended_action_id: acted, snooze_until_wall: null });
  const tail = appliedTail(s.db);
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [R.tr('inbox_item', 'i1', 'open', 'seen', srcCause('p1', 5))]))), 'bad-transition', 'the item is acted, not open');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [R.tr('inbox_item', 'nope', 'open', 'seen', srcCause('p1', 5))]))), 'missing-row');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [R.tr('inbox_item', 'i1', 'acted', 'open', srcCause('p1', 5))]))), 'bad-body', 'an ended item never reopens');
  assert.equal(reasonOf(() => s.commit([R.tr('inbox_item', 'i1', 'acted', 'open', srcCause('p1', 5))])), 'journal:bad-record');
  assert.equal(reasonOf(() => s.commit([R.tr('reminder', 'i1', 'open', 'fired', srcCause('p1', 5))])), 'journal:bad-record', 'a state of the other machine');
});

test('a batch applies whole and only right after applied_jseq: twice, out of order or torn, it is refused', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const lines = s.commit([R.part('p1')]);
  assert.equal(reasonOf(() => applyBatch(s.db, lines)), 'sequence', 'the same batch again');
  const tail = appliedTail(s.db);
  const next = rawBatch(tail, [R.part('p2')]);
  const after = rawBatch({ jseq: next.at(-1)!.jseq, hash: next.at(-1)!.hash }, [R.part('p3')]);
  assert.equal(reasonOf(() => applyBatch(s.db, after)), 'sequence', 'a gap');
  assert.equal(reasonOf(() => applyBatch(s.db, next.slice(0, -1))), 'not-a-batch', 'no commit');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch({ jseq: tail.jseq, hash: 'f'.repeat(64) }, [R.part('p2')]))), 'sequence', 'a batch of another chain');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [R.part('p2'), { kind: 'commit', body: { count: 1 } }, R.part('p3')]))), 'not-a-batch', 'a commit inside the batch');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch({ jseq: tail.jseq + 5, hash: tail.hash }, [R.part('p2')]))), 'sequence', 'the right line before it, the wrong numbers');
  assert.equal(reasonOf(() => applyBatch(s.db, next)), 'applied');
  assert.equal(s.db.get('SELECT count(*) AS n FROM part')!.n, 2);
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('R2-D/C2: a reminder edge takes only its own cause, as a link: remind for none>pending, its own reminder timer (record earlier in the batch) for pending>fired, a remind on the reminder itself for pending>cancelled', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const make = uuidOf('make-rem1');
  const apply = (recs: Rec[]) => reasonOf(() => applyBatch(s.db, rawBatch(appliedTail(s.db), recs)));
  // none>pending
  assert.equal(apply([R.reminder('rem1', 5000), R.clock('silence:p9:0', 'mono', 20_000, 21_000, 5), R.tr('reminder', 'rem1', 'none', 'pending', clockCause('silence:p9:0'))]), 'cause-mismatch', 'a clock makes no reminder');
  assert.equal(apply([R.reminder('rem1', 5000), R.tr('reminder', 'rem1', 'none', 'pending', humanCause(make))]), 'no-human-record', 'a human cause with no human record');
  assert.equal(apply([R.reminder('rem1', 5000), R.tr('reminder', 'rem1', 'none', 'pending', humanCause(make)), R.human(make, 'seen', null), R.result(make, 'seen', null)]), 'cause-mismatch', 'seen makes no reminder');
  s.commit([R.reminder('rem1', 5000), R.tr('reminder', 'rem1', 'none', 'pending', humanCause(make)), R.human(make, 'remind', null), R.result(make, 'remind', null)]);
  // pending>fired
  s.commit([R.event('p1', 77)]);
  assert.equal(apply([R.tr('reminder', 'rem1', 'pending', 'fired', srcCause('p1', 77))]), 'cause-mismatch', 'a source fires no reminder');
  assert.equal(apply([R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem1:0'))]), 'no-clock-record', 'its timer without the clock record');
  assert.equal(apply([R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem1:0')), R.clock('reminder:rem1:0', 'wall', 1, 1, 1)]), 'no-clock-record', 'the record after the transition');
  assert.equal(apply([R.clock('reminder:rem9:0', 'wall', 1, 1, 1), R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem9:0'))]), 'cause-mismatch', 'another reminder\'s timer');
  assert.equal(apply([R.clock('snooze:rem1:0', 'wall', 1, 1, 1), R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('snooze:rem1:0'))]), 'cause-mismatch', 'a snooze timer');
  // pending>cancelled
  const cancel = uuidOf('cancel-rem1');
  assert.equal(apply([R.tr('reminder', 'rem1', 'pending', 'cancelled', humanCause(cancel))]), 'no-human-record', 'a cancel with no human record');
  assert.equal(apply([R.tr('reminder', 'rem1', 'pending', 'cancelled', humanCause(cancel)), R.human(cancel, 'remind', 'rem2'), R.result(cancel, 'remind', 'rem2')]), 'cause-mismatch', 'a remind that targets another reminder');
  assert.equal(s.db.get("SELECT state FROM reminder WHERE id = 'rem1'")!.state, 'pending');
  s.commit([R.clock('reminder:rem1:0', 'wall', 1, 1, 1), R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem1:0'))]);
  assert.equal(s.db.get("SELECT state FROM reminder WHERE id = 'rem1'")!.state, 'fired');
});

test('R2-D: a source cause names an event applied before it; srcCause(ghost, 99) with no event opens nothing', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const apply = (recs: Rec[]) => reasonOf(() => applyBatch(s.db, rawBatch(appliedTail(s.db), recs)));
  assert.equal(apply([R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('ghost', 99))]), 'no-source-event');
  assert.equal(apply([R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('ghost', 99)), R.event('ghost', 99)]), 'no-source-event', 'the event after the transition');
  assert.equal(s.db.get('SELECT count(*) AS n FROM inbox_item')!.n, 0);
  assert.equal(apply([R.event('ghost', 99), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('ghost', 99))]), 'applied');
});

test('R3-4: a reminder transition whose from is not the state is refused: a stale cancel after the fire, a second none>pending', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const make = uuidOf('make-rem5');
  s.commit([R.reminder('rem5', 5000), R.tr('reminder', 'rem5', 'none', 'pending', humanCause(make)), R.human(make, 'remind', null), R.result(make, 'remind', null)]);
  const again = uuidOf('make-rem5-again');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(appliedTail(s.db), [R.tr('reminder', 'rem5', 'none', 'pending', humanCause(again)), R.human(again, 'remind', null), R.result(again, 'remind', null)]))), 'bad-transition');
  s.commit([R.clock('reminder:rem5:0', 'wall', 1, 1, 1), R.tr('reminder', 'rem5', 'pending', 'fired', clockCause('reminder:rem5:0'))]);
  const ended = { ...s.db.get("SELECT state, ended_jseq, ended_wall FROM reminder WHERE id = 'rem5'")! };
  const cancel = uuidOf('late-cancel');
  assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(appliedTail(s.db), [R.tr('reminder', 'rem5', 'pending', 'cancelled', humanCause(cancel)), R.human(cancel, 'remind', 'rem5'), R.result(cancel, 'remind', 'rem5')]))), 'bad-transition');
  assert.deepEqual({ ...s.db.get("SELECT state, ended_jseq, ended_wall FROM reminder WHERE id = 'rem5'")! }, ended, 'the fired reminder kept its end');
});

test('R3-10: a cause kind on Object.prototype is no cause kind: a cause object without its own kind is no-cause', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  const tail = appliedTail(s.db);
  Object.defineProperty(Object.prototype, 'kind', { value: 'source', configurable: true, writable: true });
  try {
    assert.equal(reasonOf(() => applyBatch(s.db, rawBatch(tail, [{ kind: 'transition', body: { entity: 'inbox_item', id: 'i1', from: 'open', to: 'auto-cleared', cause: { partRef: 'p1', srcSeq: 1 } } }]))), 'no-cause');
  } finally {
    delete (Object.prototype as Record<string, unknown>).kind;
  }
});
