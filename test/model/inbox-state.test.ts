import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Line, Rec } from '../../src/store/journal.ts';
import type { Cause, ItemRow } from '../../src/model/inbox.ts';
import { END_CLASSES, ITEM_STATES } from '../../shared/protocol.js';
import {
  ITEM_EDGES, InboxError, LIVE_STATES, MACHINE_STATES, causeAllowed, itemIndex, moveItem, openItem, planMark, readItem, verbsFor,
} from '../../src/model/inbox.ts';
import { EDGES, STATES } from '../../src/store/records.ts';
import { canonicalJson } from '../../src/store/canonical-json.ts';
import { scanJournal } from '../../src/store/journal.ts';
import { ApplyError, appliedTail, applyBatch, rebuildProjection } from '../../src/store/rebuild.ts';
import { R, clockCause, digestOf, humanCause, rawBatch, srcCause, uuidOf } from '../helpers/records.ts';
import { T0, deleteDb, mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, r4 §6.5, I01: the item state machine. Every change of state is a transition record
// with a cause, and only a cause its edge lists: a human cause needs its human record (verb and
// target) in the batch, a clock cause its clock record earlier in the batch, fired for the item's own
// entity. apply writes rev and committedJseq; a stranded item (never opened, snoozed with no time)
// ends the batch with a refusal; deleting a clock record from the journal makes the replay refuse.

const reasonOf = (f: () => unknown): string => {
  try {
    f();
    return 'applied';
  } catch (e) {
    return e instanceof ApplyError ? e.reason : e instanceof InboxError ? `inbox:${e.reason}` : String(e);
  }
};

test('the machine: none, then protocol.js\'s states; the live states and the end classes; records.ts takes its edges from the model', () => {
  assert.deepEqual([...MACHINE_STATES], ['none', ...ITEM_STATES]);
  assert.deepEqual([...ITEM_STATES], [...LIVE_STATES, ...END_CLASSES], 'an end state is its end class');
  assert.deepEqual([...STATES.inbox_item], [...MACHINE_STATES]);
  assert.deepEqual([...EDGES.inbox_item], Object.keys(ITEM_EDGES));
  for (const e of Object.keys(ITEM_EDGES)) {
    const [from, to] = e.split('>') as [string, string];
    assert.ok(MACHINE_STATES.includes(from) && MACHINE_STATES.includes(to), e);
    assert.ok(!(END_CLASSES as readonly string[]).includes(from), `${e}: an ended item never moves again`);
    assert.notEqual(to, 'none');
  }
  for (const f of LIVE_STATES) for (const end of END_CLASSES) assert.ok(Object.hasOwn(ITEM_EDGES, `${f}>${end}`), `${f}>${end}`);
});

test('the cause table of every edge (r4 §6.5): sources open and auto-clear, you see, snooze and act, timers open and wake; nothing expires an item in M0', () => {
  const describe = (e: string) => {
    const r = ITEM_EDGES[e]!;
    return [r.source ? 'source' : '', r.human.length > 0 ? `human(${r.human.join(',')})` : '', r.clock.length > 0 ? `clock(${r.clock.join(',')})` : ''].filter((s) => s !== '').join(' ') || '-';
  };
  assert.deepEqual(Object.fromEntries(Object.keys(ITEM_EDGES).map((e) => [e, describe(e)])), {
    'none>open': 'source clock(silence,reminder)',
    'open>seen': 'human(seen)',
    'open>snoozed': 'human(snooze)',
    'seen>snoozed': 'human(snooze)',
    'snoozed>open': 'clock(snooze)',
    'open>acted': 'human(acted)',
    'open>auto-cleared': 'source',
    'open>expired': '-',
    'seen>acted': 'human(acted)',
    'seen>auto-cleared': 'source',
    'seen>expired': '-',
    'snoozed>acted': 'human(acted)',
    'snoozed>auto-cleared': 'source',
    'snoozed>expired': '-',
  });
  const human = humanCause(uuidOf('x')) as Cause;
  assert.equal(causeAllowed('open', 'seen', human, 'seen'), true);
  assert.equal(causeAllowed('open', 'seen', human, 'acted'), false);
  assert.equal(causeAllowed('open', 'seen', srcCause('p1', 1) as Cause), false);
  assert.equal(causeAllowed('snoozed', 'open', clockCause('snooze:i1:0') as Cause), true);
  assert.equal(causeAllowed('snoozed', 'open', clockCause('reminder:i1:0') as Cause), false);
  assert.equal(causeAllowed('acted', 'open', human, 'acted'), false, 'no edge');
});

test('verbs by state: an open item offers its kind\'s verbs, a seen one all but seen, a snoozed one open, peek and acted, an ended or unopened one none', () => {
  assert.deepEqual(verbsFor('question', 'open'), ['open', 'peek', 'seen', 'snooze', 'remind', 'acted']);
  assert.deepEqual(verbsFor('question', 'seen'), ['open', 'peek', 'snooze', 'remind', 'acted']);
  assert.deepEqual(verbsFor('runaway', 'seen'), ['open', 'peek', 'snooze', 'remind', 'acted', 'brake']);
  assert.deepEqual(verbsFor('runaway', 'snoozed'), ['open', 'peek', 'acted']);
  for (const s of ['none', ...END_CLASSES, 'mystery']) assert.deepEqual(verbsFor('runaway', s), [], s);
});

/** A store with one open question i1 of part p1 (and its part), as a source would have made it. */
async function withItem(t: Parameters<typeof storeFixture>[0]) {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1'), R.event('p1', 1), R.item('i1', { partRef: 'p1' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1)), R.cursor('p1', 100, 1)]);
  const apply = (recs: Rec[]) => reasonOf(() => applyBatch(s.db, rawBatch(appliedTail(s.db), recs)));
  const state = (id = 'i1') => readItem(s.db, id)?.state ?? null;
  return { f, s, apply, state };
}

test('a human cause needs its human record in the batch, with a verb that fits the edge and this item as its target', async (t) => {
  const { apply, state } = await withItem(t);
  const a = uuidOf('h1');
  const seen = R.tr('inbox_item', 'i1', 'open', 'seen', humanCause(a));
  assert.equal(apply([seen]), 'no-human-record');
  assert.equal(apply([seen, R.human(a, 'acted', 'i1'), R.result(a, 'acted', 'i1')]), 'cause-mismatch', 'an acted action cannot see an item');
  assert.equal(apply([seen, R.human(a, 'seen', 'i2'), R.result(a, 'seen', 'i2')]), 'cause-mismatch', 'an action on another item');
  assert.equal(apply([seen, R.human(a, 'seen', null), R.result(a, 'seen', null)]), 'cause-mismatch', 'an action on no item');
  assert.equal(apply([seen, R.human(uuidOf('other'), 'seen', 'i1'), R.result(uuidOf('other'), 'seen', 'i1')]), 'no-human-record', 'another action');
  assert.equal(state(), 'open', 'nothing of a refused batch stays');
  assert.equal(apply([seen, R.human(a, 'seen', 'i1'), R.result(a, 'seen', 'i1')]), 'applied', 'the human record may follow the transition');
  assert.equal(state(), 'seen');
});

test('a cause kind the edge does not list is refused: a source cannot see, a human cannot wake, a clock cannot act, and nothing expires an item', async (t) => {
  const { apply, state } = await withItem(t);
  const a = uuidOf('h2');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'seen', srcCause('p1', 2))]), 'cause-mismatch');
  assert.equal(apply([R.clock('silence:p1:0', 'mono', 20_000, 5, 6), R.tr('inbox_item', 'i1', 'open', 'acted', clockCause('silence:p1:0'))]), 'cause-mismatch');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'auto-cleared', humanCause(a)), R.human(a, 'acted', 'i1'), R.result(a, 'acted', 'i1')]), 'cause-mismatch');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'expired', srcCause('p1', 2))]), 'cause-mismatch');
  assert.equal(apply([R.clock('silence:p1:0', 'mono', 20_000, 5, 6), R.tr('inbox_item', 'i1', 'open', 'expired', clockCause('silence:p1:0'))]), 'cause-mismatch');
  assert.equal(state(), 'open');
  assert.equal(apply([R.event('p1', 2), R.tr('inbox_item', 'i1', 'open', 'auto-cleared', srcCause('p1', 2))]), 'applied');
  assert.equal(state(), 'auto-cleared');
});

test('a clock cause needs its clock record earlier in the same batch, and a timer of the item\'s own entity', async (t) => {
  const { s, apply, state } = await withItem(t);
  const snz = uuidOf('snz');
  s.commit(planMark(readItem(s.db, 'i1'), { verb: 'snooze', actionId: snz, requestDigest: digestOf('snz'), untilWall: 900 }).records as Rec[]);
  assert.equal(state(), 'snoozed');
  const wake = R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('snooze:i1:0'));
  const clock = R.clock('snooze:i1:0', 'wall', 10, 5, 900);
  assert.equal(apply([wake]), 'no-clock-record');
  assert.equal(apply([wake, clock]), 'no-clock-record', 'the record after the transition does not count');
  assert.equal(apply([R.clock('snooze:i2:0', 'wall', 10, 5, 900), R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('snooze:i2:0'))]), 'cause-mismatch', 'another item\'s snooze timer');
  assert.equal(apply([R.clock('reminder:i1:0', 'wall', 10, 5, 900), R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('reminder:i1:0'))]), 'cause-mismatch', 'a reminder timer wakes no snooze');
  assert.equal(state(), 'snoozed');
  assert.equal(apply([clock, wake]), 'applied');
  assert.deepEqual({ state: state(), until: readItem(s.db, 'i1')!.snoozeUntilWall }, { state: 'open', until: null });
  // A clock record of an earlier batch is not this batch's: the same timer fires once.
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'seen', clockCause('snooze:i1:0'))]), 'cause-mismatch');
});

test('a timer opens only its own entity\'s item: a silence timer an item of its part, a reminder timer the item of its reminder', async (t) => {
  const { apply, state } = await withItem(t);
  const silence = R.clock('silence:p1:0', 'mono', 20_000, 30, 40);
  const guess = (id: string, partRef: string) => R.item(id, { partRef, conf: 'low', dedup: id });
  assert.equal(apply([silence, guess('g1', 'p2'), R.tr('inbox_item', 'g1', 'none', 'open', clockCause('silence:p1:0'))]), 'cause-mismatch');
  assert.equal(apply([silence, guess('g1', 'p1'), R.tr('inbox_item', 'g1', 'none', 'open', clockCause('silence:p1:0'))]), 'applied');
  assert.equal(state('g1'), 'open');
  const remItem = (id: string, reminderId: string) => R.item(id, { itemKind: 'reminder', group: 'reminders', sev: 'P1', reminderId, dedup: id });
  const fire = R.clock('reminder:rem1:0', 'wall', 5, 50, 60);
  assert.equal(apply([fire, remItem('r1', 'rem2'), R.tr('inbox_item', 'r1', 'none', 'open', clockCause('reminder:rem1:0'))]), 'cause-mismatch');
  // The 60 s annotation opens no item; in M0 it is no transition class at all, so its clock record is refused by the schema (clock.ts TRANSITION_CLASSES).
  assert.equal(apply([R.clock('unregistered:p1:0', 'mono', 60_000, 50, 60), guess('g2', 'p1'), R.tr('inbox_item', 'g2', 'none', 'open', clockCause('unregistered:p1:0'))]), 'bad-body', 'the 60 s annotation opens no item');
  assert.equal(apply([fire, remItem('r1', 'rem1'), R.tr('inbox_item', 'r1', 'none', 'open', clockCause('reminder:rem1:0'))]), 'applied');
});

test('no item is stranded after a batch: one made and never opened, or snoozed with no time, is refused; a snooze time belongs to its snooze', async (t) => {
  const { apply, state } = await withItem(t);
  assert.equal(apply([R.item('i9', { dedup: 'i9' })]), 'stranded');
  const a = uuidOf('snz-2');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')]), 'stranded', 'snoozed with nothing to wake it');
  assert.equal(apply([R.snooze('i1', 500)]), 'bad-snooze', 'a time for an item that is not snoozed');
  assert.equal(apply([R.snooze('i1', 500), R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')]), 'bad-snooze', 'the time comes after its transition');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.snooze('i1', 500), R.snooze('i1', 600), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')]), 'bad-snooze', 'one time per snooze');
  assert.equal(state(), 'open');
  assert.equal(apply([R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.snooze('i1', 500), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')]), 'applied');
});

test('apply writes rev and committedJseq: both the opening batch\'s commit jseq, then rev moves with every change and committedJseq stays; an end records its class, cause and action', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const d = openItem(itemIndex(s.db), { kind: 'approval', partRef: 'p1', sender: 'p1', segment: null, conf: 'high', projectId: null, reminderId: null }, srcCause('p1', 3));
  assert.equal(d.kind, 'open');
  if (d.kind !== 'open') return;
  f.clock.advanceBy(321);
  const opened = s.commit([R.event('p1', 3), ...d.records]).at(-1)!;
  const row = () => ({ ...s.db.get('SELECT state, rev, committed_jseq, end_class, end_cause, ended_action_id, ended_jseq FROM inbox_item WHERE id = ?', d.itemId) });
  assert.deepEqual(row(), { state: 'open', rev: opened.jseq, committed_jseq: opened.jseq, end_class: null, end_cause: null, ended_action_id: null, ended_jseq: null });
  // R3-2: committedAt is the stamp of the opening batch (read once before the append), not just any value.
  assert.deepEqual({ ...s.db.get('SELECT committed_mono, committed_wall, committed_boot_id FROM inbox_item WHERE id = ?', d.itemId) },
    { committed_mono: 1321, committed_wall: T0 + 321, committed_boot_id: opened.bootId });
  assert.deepEqual([opened.obsMono, opened.obsWall], [1321, T0 + 321]);
  f.clock.advanceBy(50);
  const seen = uuidOf('seen-a');
  const p1 = planMark(readItem(s.db, d.itemId), { verb: 'seen', actionId: seen, requestDigest: digestOf('s') });
  const c1 = s.commit((p1 as { records: Rec[] }).records).at(-1)!;
  assert.deepEqual(row(), { state: 'seen', rev: c1.jseq, committed_jseq: opened.jseq, end_class: null, end_cause: null, ended_action_id: null, ended_jseq: null });
  const acted = uuidOf('acted-a');
  const c2 = s.commit((planMark(readItem(s.db, d.itemId), { verb: 'acted', actionId: acted, requestDigest: digestOf('a') }) as { records: Rec[] }).records).at(-1)!;
  assert.deepEqual(row(), { state: 'acted', rev: c2.jseq, committed_jseq: opened.jseq, end_class: 'acted', end_cause: 'human', ended_action_id: acted, ended_jseq: c2.jseq });
});

test('planMark follows the check order from the item on: unknown 404, ended noop (before the verb check), a verb not offered 422, else the effect with human and human.result', async (t) => {
  const { s } = await withItem(t);
  const req = (verb: 'seen' | 'snooze' | 'acted', name: string, untilWall?: number) => ({ verb, actionId: uuidOf(name), requestDigest: digestOf(name), untilWall });
  assert.deepEqual(planMark(null, req('seen', 'm0')), { kind: 'refuse', code: 'item-unknown' });
  const seen = planMark(readItem(s.db, 'i1'), req('seen', 'm1'));
  assert.equal(seen.kind, 'apply');
  assert.deepEqual((seen as { records: Rec[] }).records.map((r) => r.kind), ['transition', 'human', 'human.result']);
  s.commit((seen as { records: Rec[] }).records);
  assert.deepEqual(planMark(readItem(s.db, 'i1'), req('seen', 'm2')), { kind: 'refuse', code: 'verb-not-allowed' }, 'seen twice: a seen item offers no seen');
  const snooze = planMark(readItem(s.db, 'i1'), req('snooze', 'm3', 1234));
  assert.deepEqual((snooze as { records: Rec[] }).records.map((r) => r.kind), ['transition', 'snooze', 'human', 'human.result']);
  s.commit((snooze as { records: Rec[] }).records);
  assert.deepEqual(planMark(readItem(s.db, 'i1'), req('snooze', 'm4', 99)), { kind: 'refuse', code: 'verb-not-allowed' }, 'a snoozed item offers no snooze');
  s.commit((planMark(readItem(s.db, 'i1'), req('acted', 'm5')) as { records: Rec[] }).records);
  const late = planMark(readItem(s.db, 'i1'), req('seen', 'm6'));
  assert.equal(late.kind, 'noop', 'an ended item: accepted, changes nothing, even for a verb it would not offer');
  assert.deepEqual((late as { records: Rec[] }).records.map((r) => [r.kind, r.body.outcome ?? r.body.verb]), [['human', 'seen'], ['human.result', 'noop:already-ended']]);
  s.commit((late as { records: Rec[] }).records);
  assert.equal(readItem(s.db, 'i1')!.state, 'acted');
  // Bad requests are a bug of the caller, not a reply: thrown, typed.
  for (const bad of [
    { verb: 'brake', actionId: uuidOf('b'), requestDigest: digestOf('b') },
    { verb: 'seen', actionId: 'not-a-uuid', requestDigest: digestOf('b') },
    { verb: 'seen', actionId: uuidOf('b'), requestDigest: 'abc' },
    { verb: 'snooze', actionId: uuidOf('b'), requestDigest: digestOf('b') },
    { verb: 'seen', actionId: uuidOf('b'), requestDigest: digestOf('b'), untilWall: 5 },
  ]) assert.throws(() => planMark(readItem(s.db, 'i1'), bad as never), (e: unknown) => e instanceof InboxError && e.reason === 'bad-spec', JSON.stringify(bad));
});

test('planMark reads its request\'s own fields only: an untilWall on Object.prototype makes no seen a snooze', async (t) => {
  const { s } = await withItem(t);
  Object.defineProperty(Object.prototype, 'untilWall', { value: 77, configurable: true, writable: true });
  try {
    // R3-12: the read of the inherited untilWall would throw bad-spec here; an assertion, not an uncaught error, says so.
    let p: ReturnType<typeof planMark> | null = null;
    assert.doesNotThrow(() => { p = planMark(readItem(s.db, 'i1'), { verb: 'seen', actionId: uuidOf('proto'), requestDigest: digestOf('p') }); });
    assert.deepEqual((p as unknown as { records: Rec[] }).records.map((r) => r.kind), ['transition', 'human', 'human.result']);
    assert.throws(() => planMark(readItem(s.db, 'i1'), { verb: 'snooze', actionId: uuidOf('proto2'), requestDigest: digestOf('p') }), InboxError);
  } finally {
    delete (Object.prototype as Record<string, unknown>).untilWall;
  }
});

test('moveItem: a source auto-clears, the snooze timer wakes; a human change, or an edge its cause may not drive, is refused before any record', () => {
  const item = (state: string): ItemRow => ({ id: 'i1', kind: 'question', state, partRef: 'p1', reminderId: null, snoozeUntilWall: null });
  assert.deepEqual(moveItem(item('seen'), 'auto-cleared', srcCause('p1', 9) as Cause).map((r) => r.body), [{ entity: 'inbox_item', id: 'i1', from: 'seen', to: 'auto-cleared', cause: { kind: 'source', partRef: 'p1', srcSeq: 9 } }]);
  assert.equal(moveItem(item('snoozed'), 'open', clockCause('snooze:i1:3') as Cause).length, 1);
  assert.throws(() => moveItem(item('open'), 'acted', humanCause(uuidOf('x')) as Cause), (e: unknown) => e instanceof InboxError && e.reason === 'bad-cause');
  assert.throws(() => moveItem(item('open'), 'expired', srcCause('p1', 9) as Cause), InboxError);
  assert.throws(() => moveItem(item('acted'), 'open', srcCause('p1', 9) as Cause), InboxError);
  assert.throws(() => moveItem(item('open'), 'auto-cleared', { kind: 'source', partRef: 'a:b', srcSeq: 1 }), InboxError, 'a cause outside its grammar');
  assert.throws(() => moveItem(item('open'), 'auto-cleared', { kind: 'timer', timerId: 'x' } as never), InboxError);
});

/** Lines rebuilt without one of them: the chain recomputed, so only apply can tell. */
function without(lines: Line[], drop: (l: Line) => boolean): Line[][] {
  const kept: Line[][] = [];
  let tail = { jseq: 0, hash: '0'.repeat(64) };
  let batch: Rec[] = [];
  for (const l of lines) {
    if (l.kind === 'commit') {
      const b = rawBatch(tail, batch);
      kept.push(b);
      tail = { jseq: b.at(-1)!.jseq, hash: b.at(-1)!.hash };
      batch = [];
    } else if (!drop(l)) {
      batch.push({ kind: l.kind, body: l.body as Record<string, unknown> });
    }
  }
  return kept;
}

test('P4 measured: a journal with the clock record of a snooze wake deleted (and its chain recomputed) is refused by the replay, not replayed into another state', async (t) => {
  const { f, s } = await withItem(t);
  s.commit(planMark(readItem(s.db, 'i1'), { verb: 'snooze', actionId: uuidOf('z'), requestDigest: digestOf('z'), untilWall: 900 }).records as Rec[]);
  s.commit([R.clock('snooze:i1:0', 'wall', 10, 5, 900), R.tr('inbox_item', 'i1', 'snoozed', 'open', clockCause('snooze:i1:0'))]);
  s.close();
  const scan = scanJournal(fs.readFileSync(f.journal));
  assert.ok(scan.ok);
  const lines = scan.batches.flat();
  const control = without(lines, () => false);
  const tampered = without(lines, (l) => l.kind === 'clock');
  assert.equal(tampered.flat().filter((l) => l.kind === 'clock').length, 0);
  deleteDb(f);
  const db = f.track(f.opener.open(f.db));
  assert.equal(reasonOf(() => rebuildProjection(db, control)), 'applied', 'the untouched journal, its chain recomputed the same way, replays');
  assert.equal(reasonOf(() => rebuildProjection(db, tampered)), 'no-clock-record');
  // And the journal file itself, so tampered, would hold a chain the startup scan accepts: the refusal is apply's.
  const text = tampered.flat().map((l) => canonicalJson(l)).join('\n') + '\n';
  assert.ok(scanJournal(new TextEncoder().encode(text)).ok);
});
