import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Clock, Fired } from '../../src/runtime/clock.ts';
import type { Rec } from '../../src/store/journal.ts';
import type { Store, StoreWriter } from '../../src/store/store.ts';
import type { StoreFixture } from '../helpers/store.ts';
import { clockRecord } from '../../src/runtime/clock.ts';
import { scanJournal } from '../../src/store/journal.ts';
import { dumpProjection, rebuildProjection } from '../../src/store/rebuild.ts';
import { itemIndex, moveItem, openItem, planMark, readItem } from '../../src/model/inbox.ts';
import { R, clockCause, digestOf, humanCause, srcCause, uuidOf } from '../helpers/records.ts';
import { T0, deleteDb, mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, 补1 and I02: a synthetic scenario (two sources whose waiting signals open items through
// the real inbox model, a re-read of each signal deduplicated, a reminder, your seen, acted and snooze,
// the snooze timer, the notifications) with a crash injected at each of the commit's three points:
// half a journal line, the fsync done but the db not committed, the db committed but nothing notified.
// After every restart: no event lost, none doubled (counted as inbox_item rows), no reminder lost,
// and every item notified exactly once. Then the database is deleted and rebuilt from the journal
// alone: the projection tables equal the live ones row by row, committedAt and notifiedAt included.
//
// The items, their dedup and every change of their state come from src/model/inbox.ts (openItem,
// planMark, moveItem); the scheduler and the notifier below are the minimum this needs (steps 5 and
// 13 own them). They use the store only through commit() and reads, and an effect outside the
// process (a notification) happens only after commit() returned.

class Crash extends Error {}

const MIN = 60_000;

/** Each part sends perPart events: an odd one is a new waiting segment, the even one after it re-reads the same segment. */
type World = { parts: readonly string[]; perPart: number };
/** What the outside world saw: notifications per item, across every lifetime. */
type Outside = { notified: Map<string, number> };

/** One lifetime of orchestrad: from a reconciled open to a crash (or the end of the test). */
class Daemon {
  readonly store: Store;
  readonly #out: Outside;
  readonly #clock: Clock;
  readonly #timers: string[] = [];
  #dead = false;

  constructor(f: StoreFixture, out: Outside, writer?: StoreWriter) {
    this.#out = out;
    this.store = mustOpen(f, writer === undefined ? {} : { writer }).store;
    this.#clock = f.clock.port((fired) => this.#fire(fired));
  }

  get dead(): boolean {
    return this.#dead;
  }

  /** The process ends: its timers with it, its database handle closed by the OS. */
  crash(): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const id of this.#timers) this.#clock.cancel(id);
    this.store.close();
  }

  commit(recs: Rec[]): void {
    if (this.#dead) throw new Crash('dead');
    try {
      this.store.commit(recs);
    } catch (e) {
      this.crash();
      throw new Crash(String(e));
    }
  }

  /** Reads each part from its committed cursor on: the event, what the model makes of it, and the cursor in one batch (I02). */
  ingest(w: World, limit = Infinity): number {
    let n = 0;
    for (const [p, ref] of w.parts.entries()) {
      if (n >= limit) break;
      let row = this.store.db.get('SELECT cursor_src_seq FROM part WHERE ref = ?', ref);
      if (row === undefined) {
        this.commit([R.part(ref)]);
        n++;
        row = { cursor_src_seq: null };
      }
      let seq = row.cursor_src_seq === null ? 0 : Number(row.cursor_src_seq);
      while (seq < w.perPart && n < limit) {
        seq++;
        const segment = { root: 'root1', pid: 4000 + p, procStart: '133000000000000100', statusUpdatedAt: seq % 2 === 1 ? seq : seq - 1 };
        const d = openItem(itemIndex(this.store.db), { kind: 'question', partRef: ref, sender: ref, segment, conf: 'high', projectId: null, reminderId: null }, srcCause(ref, seq));
        this.commit([R.event(ref, seq), ...(d.kind === 'open' ? d.records : []), R.cursor(ref, seq * 100, seq)]);
        n++;
      }
    }
    return n;
  }

  /** At least once: every open item not yet notified is notified, then its ack is written. */
  notify(): void {
    for (const r of this.store.db.all("SELECT id FROM inbox_item WHERE state = 'open' AND notified_wall IS NULL ORDER BY id")) {
      const id = String(r.id);
      this.#out.notified.set(id, (this.#out.notified.get(id) ?? 0) + 1);
      this.commit([R.notified(id, 1, 'browser', this.#clock.nowMono(), this.#clock.nowWall())]);
    }
  }

  /** A mark verb, as step 4's route will run it after the dedup step: the model's plan, committed whole. */
  mark(itemId: string, verb: 'seen' | 'snooze' | 'acted', untilWall?: number): void {
    const actionId = uuidOf(`${verb}-${itemId}`);
    const plan = planMark(readItem(this.store.db, itemId), { verb, actionId, requestDigest: digestOf(`${verb}:${itemId}`), untilWall });
    assert.equal(plan.kind, 'apply', `${verb} on ${itemId}`);
    if (plan.kind !== 'apply') return;
    this.commit(plan.records);
    if (verb === 'snooze') this.#arm(`snooze:${itemId}:${this.store.nextTimerSeq('snooze', itemId)}`, 'snooze', untilWall!);
  }

  remind(id: string, dueWall: number, text: string): void {
    const action = uuidOf(`remind-${id}`);
    const ref = `rt-${id}`;
    this.store.snippets.put(ref, { text });
    this.commit([R.reminder(id, dueWall, ref), R.tr('reminder', id, 'none', 'pending', humanCause(action)), R.human(action, 'remind'), R.result(action, 'remind', null)]);
  }

  /** The scheduler's start: a wall timer for every pending reminder and every snoozed item in the database. */
  arm(): void {
    // seq from the journal (Store.nextTimerSeq): a restart arms the very timerId the lost process had armed.
    for (const r of this.store.db.all("SELECT id, due_wall FROM reminder WHERE state = 'pending' ORDER BY id")) {
      this.#arm(`reminder:${String(r.id)}:${this.store.nextTimerSeq('reminder', String(r.id))}`, 'reminder', Number(r.due_wall));
    }
    for (const r of this.store.db.all("SELECT id, snooze_until_wall FROM inbox_item WHERE state = 'snoozed' ORDER BY id")) {
      this.#arm(`snooze:${String(r.id)}:${this.store.nextTimerSeq('snooze', String(r.id))}`, 'snooze', Number(r.snooze_until_wall));
    }
  }

  #arm(timerId: string, cls: 'reminder' | 'snooze', due: number): void {
    this.#clock.schedule({ timerId, class: cls, clock: 'wall', due });
    this.#timers.push(timerId);
  }

  #fire(f: Fired): void {
    if (this.#dead) return;
    const c = clockRecord(f);
    const clock = R.clock(c.timerId, c.clock, c.durationMs, c.firedMono, c.firedWall);
    const entity = f.timerId.split(':')[1]!;
    if (f.class === 'snooze') {
      this.commit([clock, ...moveItem(readItem(this.store.db, entity)!, 'open', clockCause(f.timerId))]);
    } else {
      const d = openItem(itemIndex(this.store.db), { kind: 'reminder', partRef: null, sender: entity, segment: null, conf: 'high', projectId: null, reminderId: entity }, clockCause(f.timerId));
      assert.equal(d.kind, 'open');
      this.commit([clock, R.tr('reminder', entity, 'pending', 'fired', clockCause(f.timerId)), ...(d.kind === 'open' ? d.records : [])]);
    }
    this.notify();
  }
}

/** A writer whose `at`-th append crashes: after half the batch's first line, or after the whole batch and its fsync. */
function crashOn(f: StoreFixture, at: number, mode: 'half-line' | 'after-fsync'): StoreWriter {
  let n = 0;
  return {
    append: (target, data, opts) => {
      if (++n !== at) return f.fence.append(target, data, opts);
      const text = String(data);
      if (mode === 'half-line') {
        f.fence.append(target, text.slice(0, Math.floor(text.indexOf('\n') / 2)), opts);
        throw new Error('crash: half a line');
      }
      f.fence.append(target, text, opts);
      throw new Error('crash: fsync done, db not committed');
    },
    shorten: (target, length) => f.fence.shorten(target, length),
    writeAtomic: (target, data) => f.fence.writeAtomic(target, data),
    rm: (target) => f.fence.rm(target),
  };
}

const WORLD: World = { parts: ['pa', 'pb'], perPart: 6 };
const TOTAL_EVENTS = WORLD.parts.length * WORLD.perPart;
/** Half the events open an item; the other half re-read a live segment and are deduplicated. */
const TOTAL_ITEMS = TOTAL_EVENTS / 2;

/** The id of the item a part's odd event opened: the model's own, read back by its part and its event's jseq order. */
function itemsOf(s: Store, ref: string): string[] {
  return s.db.all('SELECT id FROM inbox_item WHERE part_ref = ? ORDER BY committed_jseq', ref).map((r) => String(r.id));
}

function tally(s: Store) {
  const q = (sql: string) => Number(s.db.get(sql)!.n);
  return {
    events: q("SELECT count(*) AS n FROM event WHERE kind = 'event'"),
    sourceItems: q("SELECT count(*) AS n FROM inbox_item WHERE kind = 'question'"),
    distinctDedup: q("SELECT count(DISTINCT dedup_key) AS n FROM inbox_item WHERE kind = 'question'"),
    remindersFired: q("SELECT count(*) AS n FROM reminder WHERE state = 'fired'"),
    reminderItems: q("SELECT count(*) AS n FROM inbox_item WHERE kind = 'reminder'"),
    unnotified: q('SELECT count(*) AS n FROM inbox_item WHERE notified_wall IS NULL'),
  };
}

for (const point of ['half-line', 'after-fsync', 'after-commit'] as const) {
  test(`crash at "${point}": after the restart no event is lost or doubled, no reminder is lost, every item is notified exactly once; the rebuilt projection equals the live one row by row`, async (t) => {
    const f = await storeFixture(t);
    const out: Outside = { notified: new Map() };
    const due = T0 + 10 * MIN;
    // Lifetime 1: a reminder, events of part pa notified, then the crash.
    // Appends 1-7: the reminder, part pa, pa:1 (opens), pa:2 (deduplicated), pa:3 (opens) and two acks; the 8th is pa:4's batch.
    const writer = point === 'after-commit' ? undefined : crashOn(f, 8, point);
    const d1 = new Daemon(f, out, writer);
    d1.remind('rem1', due, 'call Bob back');
    d1.arm();
    d1.ingest(WORLD, 4);
    d1.notify();
    f.clock.advanceBy(MIN);
    if (point === 'after-commit') {
      // Committed and applied, never notified: pa:5 opens an item and the process ends between the commit and the effect.
      d1.ingest(WORLD, 2);
      d1.crash();
    } else {
      assert.throws(() => d1.ingest(WORLD), Crash);
    }
    assert.ok(d1.dead);
    const notifiedInLife1 = [...out.notified.keys()].sort();
    assert.ok(notifiedInLife1.length >= 2, `life 1 notified ${notifiedInLife1.join(', ')}`);

    // Lifetime 2: reconcile, resume every source from its committed cursor, notify; you see one item,
    // act on another and snooze a third; the reminder fires and the snooze wakes.
    f.clock.advanceBy(MIN);
    const d2 = new Daemon(f, out);
    d2.arm();
    d2.ingest(WORLD);
    d2.notify();
    const [pa1] = itemsOf(d2.store, 'pa');
    const [pb1, , pb5] = itemsOf(d2.store, 'pb');
    d2.mark(pa1!, 'seen');
    d2.mark(pb1!, 'acted');
    d2.mark(pb5!, 'snooze', T0 + 5 * MIN);
    assert.equal(readItem(d2.store.db, pb5!)!.state, 'snoozed');
    f.clock.advanceTo(1000 + 10 * MIN);
    const n = tally(d2.store);
    assert.deepEqual(n, { events: TOTAL_EVENTS, sourceItems: TOTAL_ITEMS, distinctDedup: TOTAL_ITEMS, remindersFired: 1, reminderItems: 1, unnotified: 0 });
    assert.deepEqual([...out.notified.values()].filter((c) => c !== 1), [], 'every item was notified exactly once, across the crash');
    assert.equal(out.notified.size, TOTAL_ITEMS + 1);
    assert.deepEqual([pa1, pb1, pb5].map((id) => readItem(d2.store.db, id!)!.state), ['seen', 'acted', 'open'], 'seen, acted, and woken by its snooze timer');
    const rem = d2.store.db.get("SELECT ended_wall FROM reminder WHERE id = 'rem1'")!;
    assert.equal(rem.ended_wall, due, 'the reminder fired at its due time');
    const scan = scanJournal(fs.readFileSync(f.journal));
    assert.ok(scan.ok);
    assert.equal(scan.batches.flat().filter((l) => l.kind === 'recovered').length, point === 'half-line' ? 1 : 0);

    // The database lost: rebuilt from the journal alone, row by row the same.
    const live = dumpProjection(d2.store.db);
    // R3-1: the oracle itself: every table dumped whole (row counts against count(*)), the time columns in the rows.
    for (const table of ['project', 'part', 'event', 'inbox_item', 'reminder', 'command', 'protect_entry']) {
      assert.equal(live[table]!.length, Number(d2.store.db.get(`SELECT count(*) AS n FROM ${table}`)!.n), table);
    }
    assert.equal(live.inbox_item!.length, TOTAL_ITEMS + 1);
    assert.equal(live.reminder!.length, 1);
    assert.ok(live.event!.length >= TOTAL_EVENTS);
    for (const r of live.inbox_item!) for (const c of ['committed_jseq', 'committed_mono', 'committed_wall', 'committed_boot_id', 'notified_mono', 'notified_wall', 'rev']) assert.ok(Object.hasOwn(r, c) && r[c] !== null, c);
    d2.crash();
    deleteDb(f);
    const d3 = new Daemon(f, out);
    assert.deepEqual(dumpProjection(d3.store.db), live);
    const items = d3.store.db.all('SELECT committed_jseq, committed_mono, committed_wall, notified_mono, notified_wall FROM inbox_item');
    assert.ok(items.every((r) => r.committed_wall !== null && r.notified_wall !== null && r.committed_jseq !== null), 'committedAt and notifiedAt came back from the journal');
    d3.notify();
    assert.equal([...out.notified.values()].reduce((a, b) => a + b, 0), TOTAL_ITEMS + 1, 'a rebuilt database notifies nobody twice');
    d3.crash();
  });
}

test('R2-H: a timerId names one firing: an item snoozed twice fires snooze:<id>:0, then :1, seq read from the journal, across a restart too', async (t) => {
  const f = await storeFixture(t);
  const out: Outside = { notified: new Map() };
  const d1 = new Daemon(f, out);
  d1.ingest({ parts: ['pa'], perPart: 1 });
  const [pa1] = itemsOf(d1.store, 'pa');
  assert.equal(d1.store.nextTimerSeq('snooze', pa1!), 0);
  d1.mark(pa1!, 'snooze', T0 + MIN);
  f.clock.advanceBy(2 * MIN);
  assert.equal(readItem(d1.store.db, pa1!)!.state, 'open', 'the first snooze woke it');
  assert.equal(d1.store.nextTimerSeq('snooze', pa1!), 1);
  // The second snooze, then the process is lost before it fires: the restart arms seq 1 again, and it fires once.
  const second = uuidOf(`snooze2-${pa1!}`);
  const plan = planMark(readItem(d1.store.db, pa1!), { verb: 'snooze', actionId: second, requestDigest: digestOf('snooze2'), untilWall: T0 + 5 * MIN });
  assert.equal(plan.kind, 'apply');
  if (plan.kind === 'apply') d1.commit(plan.records);
  d1.crash();
  const d2 = new Daemon(f, out);
  d2.arm();
  f.clock.advanceBy(5 * MIN);
  assert.equal(readItem(d2.store.db, pa1!)!.state, 'open', 'the second snooze woke it after the restart');
  const timers = d2.store.db.all("SELECT timer_id FROM event WHERE kind = 'clock' ORDER BY jseq").map((r) => String(r.timer_id));
  assert.deepEqual(timers, [`snooze:${pa1!}:0`, `snooze:${pa1!}:1`]);
  assert.equal(d2.store.nextTimerSeq('snooze', pa1!), 2);
  assert.throws(() => d2.store.nextTimerSeq('snooze', 'a:b'), /bad-timer-id/);
  d2.crash();
});

test('a reminder not yet fired still fires on time after a full rebuild, its text shown as lost', async (t) => {
  const f = await storeFixture(t);
  const out: Outside = { notified: new Map() };
  const due = T0 + 60 * MIN;
  const d1 = new Daemon(f, out);
  d1.remind('rem2', due, 'stretch your legs');
  d1.arm();
  f.clock.advanceBy(20 * MIN);
  assert.equal(d1.store.snippets.get('rt-rem2').text, 'stretch your legs');
  const before = dumpProjection(d1.store.db);
  d1.crash();
  deleteDb(f);
  const d2 = new Daemon(f, out);
  assert.deepEqual(dumpProjection(d2.store.db), before, 'the pending reminder is back');
  assert.deepEqual(d2.store.snippets.get('rt-rem2'), { textState: 'lost', text: null });
  d2.arm();
  f.clock.advanceBy(40 * MIN - 1);
  assert.equal(d2.store.db.get("SELECT state FROM reminder WHERE id = 'rem2'")!.state, 'pending');
  f.clock.advanceBy(1);
  const r = d2.store.db.get("SELECT state, ended_wall FROM reminder WHERE id = 'rem2'")!;
  assert.deepEqual({ ...r }, { state: 'fired', ended_wall: due });
  const clock = d2.store.db.get("SELECT body FROM event WHERE kind = 'clock'")!;
  assert.deepEqual(JSON.parse(String(clock.body)), { timerId: 'reminder:rem2:0', clock: 'wall', durationMs: 40 * MIN, firedMono: 1000 + 60 * MIN, firedWall: due });
  const item = d2.store.db.get("SELECT id, kind, grp, sev FROM inbox_item WHERE reminder_id = 'rem2'")!;
  assert.deepEqual({ kind: item.kind, grp: item.grp, sev: item.sev }, { kind: 'reminder', grp: 'reminders', sev: 'P1' }, 'the kind table made the reminder item');
  assert.equal(out.notified.get(String(item.id)), 1);
  d2.crash();
});

test('rebuildProjection on a live database gives back the same rows; side tables (snippet, metric) stay as they were', async (t) => {
  const f = await storeFixture(t);
  const out: Outside = { notified: new Map() };
  const d = new Daemon(f, out);
  d.remind('rem3', T0 + MIN, 'tea');
  d.ingest(WORLD);
  d.notify();
  d.arm();
  const [pa1, pa3] = itemsOf(d.store, 'pa');
  d.mark(pa1!, 'snooze', T0 + 30_000);
  d.mark(pa3!, 'acted');
  f.clock.advanceBy(2 * MIN);
  const live = dumpProjection(d.store.db);
  const metrics = Number(d.store.db.get('SELECT count(*) AS n FROM metric')!.n);
  const scan = scanJournal(fs.readFileSync(f.journal));
  assert.ok(scan.ok);
  rebuildProjection(d.store.db, scan.batches);
  assert.deepEqual(dumpProjection(d.store.db), live);
  assert.equal(d.store.snippets.get('rt-rem3').text, 'tea');
  assert.equal(Number(d.store.db.get('SELECT count(*) AS n FROM metric')!.n), metrics);
  d.crash();
});
