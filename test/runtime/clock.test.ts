import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock, ClockRecord, Fired, TimerSpec } from '../../src/runtime/clock.ts';
import {
  CLASS_RANK, ClockError, MAX_ARM_MS, TIMER_CLASSES, TIMER_ENTITY_RE, TRANSITION_CLASSES, VirtualClock, WALL_CHECK_MS, armDelay, clockRecord,
  compareTimers, makeRealClock, parseTimerId, timerId,
} from '../../src/runtime/clock.ts';
import { ID_RE } from '../../shared/protocol.js';

// Plan step 3, I01: one Clock port, deterministic timerIds, a fixed total order inside a tick, and a
// virtual clock that tests and replay drive. Every test here but the last two runs on the virtual
// clock: nothing waits on real time.

const T0 = Date.parse('2026-10-31T08:00:00Z');
const START = { mono: 0, wall: T0 };

const reason = (r: ClockError['reason']) => (e: unknown) => e instanceof ClockError && e.reason === r;

/** A seeded shuffle (Park–Miller), so a failing permutation can be replayed from its seed. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed % 2147483647 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Five timers due at the same instant, on both clocks: mono due 60 s, wall due T0 + 60 s.
const FIVE: readonly TimerSpec[] = [
  { timerId: 'unregistered:p-4100-133:0', class: 'unregistered', clock: 'mono', due: 60_000 },
  { timerId: 'reminder:r-2:0', class: 'reminder', clock: 'wall', due: T0 + 60_000 },
  { timerId: 'snooze:it-7:1', class: 'snooze', clock: 'mono', due: 60_000 },
  { timerId: 'silence:it-9:0', class: 'silence', clock: 'mono', due: 60_000 },
  { timerId: 'reminder:r-1:0', class: 'reminder', clock: 'mono', due: 60_000 },
];
const FIVE_ORDER = ['silence:it-9:0', 'reminder:r-1:0', 'reminder:r-2:0', 'snooze:it-7:1', 'unregistered:p-4100-133:0'];

/** Runs FIVE inserted in `order`; the reminder r-1 handler cancels the snooze of the same tick, so the result depends on the order. */
function runFive(order: readonly TimerSpec[]): { fired: string[]; records: ClockRecord[]; state: string } {
  const vc = new VirtualClock(START);
  const fired: string[] = [];
  const records: ClockRecord[] = [];
  let state = 'quiet';
  let clock: Clock | null = null;
  clock = vc.port((f) => {
    fired.push(f.timerId);
    if (TRANSITION_CLASSES.includes(f.class)) records.push(clockRecord(f));
    if (f.timerId === 'silence:it-9:0') state = 'item-open';
    if (f.timerId === 'reminder:r-1:0') {
      state += '+reminder';
      clock!.cancel('snooze:it-7:1');
    }
    if (f.timerId === 'snooze:it-7:1') state += '+snooze-woke';
  });
  for (const s of order) clock.schedule(s);
  vc.advanceTo(60_000);
  return { fired, records, state };
}

test('five timers in one tick: shuffled insertion 100 times gives the same processing order and the same result', () => {
  const first = runFive(FIVE);
  assert.deepEqual(first.fired, FIVE_ORDER.filter((id) => id !== 'snooze:it-7:1'), 'class rank, then timerId; the cancelled snooze never fires');
  assert.equal(first.state, 'item-open+reminder');
  for (let seed = 1; seed <= 100; seed++) {
    const r = runFive(shuffled(FIVE, seed * 7919));
    assert.deepEqual(r, first, `seed ${seed * 7919}`);
  }
  // Without the cancel, the order of all five is the plan's: interrupt, revisit, annotation last.
  const vc = new VirtualClock(START);
  const seen: string[] = [];
  const c = vc.port((f) => seen.push(f.timerId));
  for (const s of shuffled(FIVE, 3)) c.schedule(s);
  vc.advanceTo(60_000);
  assert.deepEqual(seen, FIVE_ORDER);
});

test('the same tick across Clocks of one hub: a timerId is pending once in the hub, so (class rank, timerId) alone orders the tick', () => {
  const vc = new VirtualClock(START);
  const seen: string[] = [];
  const a = vc.port((f) => seen.push(`a ${f.timerId}`));
  const b = vc.port((f) => seen.push(`b ${f.timerId}`));
  b.schedule({ timerId: 'deadline:x:0', class: 'deadline', clock: 'mono', due: 5 });
  // A second Clock of the hub cannot arm the same firing (0001's event_clock_timer: a timerId names one firing).
  assert.throws(() => a.schedule({ timerId: 'deadline:x:0', class: 'deadline', clock: 'mono', due: 5 }), reason('duplicate-timer'));
  a.schedule({ timerId: 'snooze:i1:0', class: 'snooze', clock: 'wall', due: T0 + 9 });
  assert.throws(() => b.schedule({ timerId: 'snooze:i1:0', class: 'snooze', clock: 'wall', due: T0 + 9 }), reason('duplicate-timer'));
  a.cancel('snooze:i1:0');
  b.schedule({ timerId: 'poll:src-1:0', class: 'poll', clock: 'mono', due: 5 });
  a.schedule({ timerId: 'silence:it-1:0', class: 'silence', clock: 'mono', due: 5 });
  a.schedule({ timerId: 'deadline:w:0', class: 'deadline', clock: 'mono', due: 5 });
  vc.advanceTo(5);
  assert.deepEqual(seen, ['a silence:it-1:0', 'a deadline:w:0', 'b deadline:x:0', 'b poll:src-1:0']);
  // Fired (or cancelled), the id is free again in the hub.
  a.schedule({ timerId: 'deadline:x:0', class: 'deadline', clock: 'mono', due: 6 });
  vc.advanceTo(6);
  assert.deepEqual(seen.at(-1), 'a deadline:x:0');
});

/** A scenario with entity ids given (as a fixture replay has them): a reminder, and a snooze re-armed twice. */
function scenario(): { fired: string[]; records: ClockRecord[] } {
  const vc = new VirtualClock(START);
  const fired: string[] = [];
  const records: ClockRecord[] = [];
  let snoozes = 0;
  const clock: Clock = vc.port((f) => {
    fired.push(f.timerId);
    if (TRANSITION_CLASSES.includes(f.class)) records.push(clockRecord(f));
    if (f.class === 'snooze' && snoozes < 2) {
      snoozes++;
      clock.schedule({ timerId: timerId('snooze', 'it-41', snoozes), class: 'snooze', clock: 'mono', due: f.firedMono + 15 * 60_000 });
    }
  });
  clock.schedule({ timerId: timerId('reminder', 'r-0007', 0), class: 'reminder', clock: 'wall', due: T0 + 3_600_000 });
  clock.schedule({ timerId: timerId('snooze', 'it-41', 0), class: 'snooze', clock: 'mono', due: 15 * 60_000 });
  clock.schedule({ timerId: timerId('poll', 'claude-registry', 0), class: 'poll', clock: 'mono', due: 1000 });
  vc.advanceBy(2 * 3_600_000);
  return { fired, records };
}

test('the same scenario run twice gives the same timerId sequence and the same clock records, with nothing random in them', () => {
  const one = scenario();
  const two = scenario();
  assert.deepEqual(two, one);
  assert.deepEqual(one.fired, ['poll:claude-registry:0', 'snooze:it-41:0', 'snooze:it-41:1', 'snooze:it-41:2', 'reminder:r-0007:0']);
  assert.deepEqual(one.records.map((r) => [r.timerId, r.clock, r.durationMs, r.firedMono, r.firedWall]), [
    ['snooze:it-41:0', 'mono', 900_000, 900_000, T0 + 900_000],
    ['snooze:it-41:1', 'mono', 900_000, 1_800_000, T0 + 1_800_000],
    ['snooze:it-41:2', 'mono', 900_000, 2_700_000, T0 + 2_700_000],
    ['reminder:r-0007:0', 'wall', 3_600_000, 3_600_000, T0 + 3_600_000],
  ]);
  for (const id of one.fired) assert.ok(parseTimerId(id) !== null, id);
});

test('the virtual clock jumps to any moment: one jump fires every due timer at its own instant, in time order; wall jumps move wall timers only', () => {
  const vc = new VirtualClock(START);
  const seen: Fired[] = [];
  const c = vc.port((f) => seen.push(f));
  const DAY = 86_400_000;
  c.schedule({ timerId: 'deadline:far:0', class: 'deadline', clock: 'mono', due: 20 * DAY });
  c.schedule({ timerId: 'reminder:r-1:0', class: 'reminder', clock: 'wall', due: T0 + 3_600_000 });
  c.schedule({ timerId: 'snooze:it-1:0', class: 'snooze', clock: 'mono', due: 10_000 });
  c.schedule({ timerId: 'poll:p:0', class: 'poll', clock: 'mono', due: 5_000 });
  assert.deepEqual(vc.pending(), ['reminder:r-1:0', 'snooze:it-1:0', 'deadline:far:0', 'poll:p:0'], 'pending, in processing order');
  vc.advanceTo(30 * DAY);
  assert.deepEqual(seen.map((f) => [f.timerId, f.firedMono, f.firedWall]), [
    ['poll:p:0', 5_000, T0 + 5_000],
    ['snooze:it-1:0', 10_000, T0 + 10_000],
    ['reminder:r-1:0', 3_600_000, T0 + 3_600_000],
    ['deadline:far:0', 20 * DAY, T0 + 20 * DAY],
  ]);
  assert.equal(vc.mono, 30 * DAY);
  assert.equal(vc.wall, T0 + 30 * DAY);
  seen.length = 0;

  // The wall clock steps back an hour: a wall timer half an hour ahead now waits 90 minutes; a mono timer is untouched.
  const now = vc.wall;
  c.schedule({ timerId: 'reminder:r-2:0', class: 'reminder', clock: 'wall', due: now + 1_800_000 });
  c.schedule({ timerId: 'deadline:plan-1:0', class: 'deadline', clock: 'mono', due: vc.mono + 60_000 });
  vc.setWall(now - 3_600_000);
  vc.advanceBy(60_000);
  assert.deepEqual(seen.map((f) => f.timerId), ['deadline:plan-1:0'], 'the plan expires on the monotonic clock regardless');
  vc.advanceBy(1_800_000);
  assert.deepEqual(seen.map((f) => f.timerId), ['deadline:plan-1:0'], 'the reminder still waits');
  // Forward two hours: the reminder is due at once, at the current monotonic reading.
  const monoBefore = vc.mono;
  vc.setWall(vc.wall + 2 * 3_600_000);
  assert.deepEqual(seen.map((f) => [f.timerId, f.firedMono]), [['deadline:plan-1:0', monoBefore - 1_800_000], ['reminder:r-2:0', monoBefore]]);
  assert.equal(vc.mono, monoBefore, 'setWall moves no monotonic time');

  assert.throws(() => vc.advanceTo(0), reason('mono-backwards'));
  assert.throws(() => vc.advanceBy(1.5), reason('bad-due'));
  assert.throws(() => vc.setWall(-1), reason('bad-due'));
});

test('inside one tick a handler that cancels a later timer stops it; a timer it schedules due now fires in the next tick, after this one', () => {
  const vc = new VirtualClock(START);
  const seen: string[] = [];
  const durations: number[] = [];
  let c: Clock;
  c = vc.port((f) => {
    seen.push(f.timerId);
    durations.push(f.durationMs);
    if (f.timerId === 'silence:a:0') {
      c.cancel('snooze:b:0');
      c.schedule({ timerId: 'silence:late:0', class: 'silence', clock: 'mono', due: 0 });
    }
  });
  c.schedule({ timerId: 'snooze:b:0', class: 'snooze', clock: 'mono', due: 100 });
  c.schedule({ timerId: 'silence:a:0', class: 'silence', clock: 'mono', due: 100 });
  c.schedule({ timerId: 'unregistered:c:0', class: 'unregistered', clock: 'mono', due: 100 });
  vc.advanceTo(100);
  assert.deepEqual(seen, ['silence:a:0', 'unregistered:c:0', 'silence:late:0'], 'the new silence timer, though of rank 2, waits for the next tick');
  assert.deepEqual(durations, [100, 100, 0], 'a timer scheduled already overdue was set for 0 ms, never a negative duration');
  assert.deepEqual(vc.pending(), []);
  // A handler that always re-arms itself due now is a runaway, not a hang.
  const loop = new VirtualClock(START);
  let calls = 0;
  const lc: Clock = loop.port((f) => {
    // Twice the guard's limit: past it, a missing guard shows up as this error instead of a hang.
    if (++calls > 200_000) throw new Error('no runaway guard');
    lc.schedule({ timerId: `poll:p:${(Number(f.timerId.split(':')[2]) + 1) % 1000}`, class: 'poll', clock: 'mono', due: loop.mono });
  });
  lc.schedule({ timerId: 'poll:p:0', class: 'poll', clock: 'mono', due: 1 });
  assert.throws(() => loop.advanceBy(10), reason('runaway'));
});

test('schedule() takes a timer and nothing else: typed refusals, own fields only, a read-only Clock refuses', () => {
  const vc = new VirtualClock(START);
  const cHeard: string[] = [];
  const c = vc.port((f) => cHeard.push(f.timerId));
  const ok: TimerSpec = { timerId: 'reminder:r-1:0', class: 'reminder', clock: 'wall', due: T0 + 3_600_000 };
  const cases: [unknown, ClockError['reason']][] = [
    [null, 'bad-spec'],
    ['reminder:r-1:0', 'bad-spec'],
    [{ ...ok, timerId: 'reminder:r-1' }, 'bad-timer-id'],
    [{ ...ok, timerId: 'reminder:r:1:0' }, 'bad-timer-id'],
    [{ ...ok, timerId: 'reminder:r-1:01' }, 'bad-timer-id'],
    [{ ...ok, timerId: 'reminder:r-1:-1' }, 'bad-timer-id'],
    [{ ...ok, timerId: 'reminder:r.1:0' }, 'bad-timer-id'],
    [{ ...ok, timerId: 'alarm:r-1:0', class: 'alarm' }, 'bad-timer-id'],
    [{ ...ok, class: 'alarm' }, 'bad-spec'],
    [{ ...ok, class: 'snooze' }, 'class-mismatch'],
    [{ ...ok, clock: 'cpu' }, 'bad-spec'],
    [{ ...ok, due: T0 + 0.5 }, 'bad-due'],
    [{ ...ok, due: -1 }, 'bad-due'],
    [{ ...ok, due: Number.MAX_SAFE_INTEGER + 2 }, 'bad-due'],
    [{ ...ok, due: '1700000000000' }, 'bad-due'],
    // Inherited fields are not the caller's: a spec whose fields sit on its prototype has none.
    [Object.create(ok) as TimerSpec, 'bad-timer-id'],
  ];
  for (const [spec, why] of cases) assert.throws(() => c.schedule(spec as TimerSpec), reason(why), JSON.stringify(spec));
  c.schedule(ok);
  assert.throws(() => c.schedule(ok), reason('duplicate-timer'));
  assert.deepEqual(vc.pending(), ['reminder:r-1:0']);
  // The spec is copied once: changing the caller's object afterwards changes nothing.
  const mutable = { timerId: 'snooze:s-1:0', class: 'snooze' as const, clock: 'mono' as const, due: 50 };
  c.schedule(mutable);
  mutable.due = 10_000_000;
  const heard: string[] = [];
  const reader = vc.port(null);
  assert.throws(() => reader.schedule({ timerId: 'poll:x:0', class: 'poll', clock: 'mono', due: 1 }), reason('read-only'));
  assert.equal(reader.nowWall(), T0);
  assert.equal(reader.nowMono(), 0);
  const c2 = vc.port((f) => heard.push(f.timerId));
  c2.schedule({ timerId: 'snooze:s-2:0', class: 'snooze', clock: 'mono', due: 50 });
  vc.advanceTo(50);
  assert.deepEqual(heard, ['snooze:s-2:0']);
  assert.deepEqual(cHeard, ['snooze:s-1:0'], 'the copied due fired at 50');
  assert.deepEqual(vc.pending(), ['reminder:r-1:0']);
  assert.throws(() => vc.port('handler' as never), reason('bad-spec'));
  assert.throws(() => new VirtualClock({ mono: -1, wall: 0 }), reason('bad-due'));
  assert.throws(() => new VirtualClock({ mono: 0, wall: 1.5 }), reason('bad-due'));
  assert.throws(() => new VirtualClock(Object.create({ mono: 0, wall: 0 }) as { mono: number; wall: number }), reason('bad-due'));
});

test('cancel() touches only the calling Clock\'s own pending timer; a timerId is pending on one Clock of a hub at most', () => {
  const vc = new VirtualClock(START);
  const seen: string[] = [];
  const a = vc.port((f) => seen.push(`a ${f.timerId}`));
  const b = vc.port((f) => seen.push(`b ${f.timerId}`));
  a.schedule({ timerId: 'deadline:spawn-1:0', class: 'deadline', clock: 'mono', due: 10 });
  assert.throws(() => b.schedule({ timerId: 'deadline:spawn-1:0', class: 'deadline', clock: 'mono', due: 10 }), reason('duplicate-timer'));
  b.cancel('deadline:spawn-1:0');
  a.cancel('deadline:unknown:0');
  b.cancel('deadline:spawn-1:0');
  vc.advanceTo(10);
  assert.deepEqual(seen, ['a deadline:spawn-1:0']);
});

test('timerId() makes the plan\'s format and refuses anything else; the entity grammar is shared/protocol.js\'s ID_RE', () => {
  assert.equal(timerId('reminder', 'r-7', 0), 'reminder:r-7:0');
  assert.deepEqual(parseTimerId('snooze:it-41:12'), { class: 'snooze', entityId: 'it-41', seq: 12 });
  const uuid = '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
  assert.equal(timerId('deadline', uuid, 3), `deadline:${uuid}:3`);
  assert.throws(() => timerId('alarm' as never, 'x', 0), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', 'a:b', 0), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', '', 0), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', 'x'.repeat(65), 0), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', 'x', -1), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', 'x', 1.5), reason('bad-timer-id'));
  assert.throws(() => timerId('poll', 'x', 1_000_000_000), reason('bad-timer-id'));
  for (const bad of ['poll:x', 'poll:x:0:1', ':x:0', 'poll::0', 'poll:x:00', 'Poll:x:0', 7, null]) assert.equal(parseTimerId(bad), null, String(bad));
  assert.equal(TIMER_ENTITY_RE.source, ID_RE.source);
  assert.equal(TIMER_ENTITY_RE.flags, ID_RE.flags);
});

test('class ranks are the plan\'s: interrupt, then revisit, annotation last of the recorded classes; deadlines and polls after them and never recorded', () => {
  const rank = (c: keyof typeof CLASS_RANK) => CLASS_RANK[c];
  assert.ok(rank('silence') < rank('reminder'));
  assert.equal(rank('reminder'), rank('snooze'));
  assert.ok(rank('snooze') < rank('unregistered'));
  for (const c of TIMER_CLASSES) {
    if (TRANSITION_CLASSES.includes(c)) assert.ok(rank(c) < rank('unregistered'), c);
    else if (c !== 'unregistered') assert.ok(rank(c) > rank('unregistered'), c);
  }
  // The 60 s annotation keeps its rank (last of the plan's classes) but records nothing until step 10 brings its entity (records.ts ENTITIES).
  assert.deepEqual([...TRANSITION_CLASSES].sort(), ['reminder', 'silence', 'snooze']);
  assert.ok(compareTimers({ class: 'snooze', timerId: 'snooze:a:0' }, { class: 'reminder', timerId: 'reminder:z:0' }) > 0, 'same rank: timerId decides');
  assert.ok(compareTimers({ class: 'reminder', timerId: 'reminder:B:0' }, { class: 'reminder', timerId: 'reminder:a:0' }) < 0, 'code units, not locale: B < a');
  const f = (cls: Fired['class']): Fired => ({ timerId: `${cls}:e:0`, class: cls, clock: 'mono', due: 5, durationMs: 5, firedMono: 5, firedWall: T0 + 5 });
  assert.deepEqual(clockRecord(f('silence')), { timerId: 'silence:e:0', clock: 'mono', durationMs: 5, firedMono: 5, firedWall: T0 + 5 });
  assert.deepEqual(Object.keys(clockRecord(f('reminder'))), ['timerId', 'clock', 'durationMs', 'firedMono', 'firedWall']);
  assert.throws(() => clockRecord(f('poll')), reason('not-recorded'));
  assert.throws(() => clockRecord(f('deadline')), reason('not-recorded'));
  assert.throws(() => clockRecord(f('unregistered')), reason('not-recorded'));
});

test('a Clock is a frozen object without a prototype holding exactly the four methods; a Fired is frozen', () => {
  for (const c of [new VirtualClock(START).port(null), makeRealClock().port(null)]) {
    assert.equal(Object.getPrototypeOf(c), null);
    assert.ok(Object.isFrozen(c));
    assert.deepEqual(Object.keys(c).sort(), ['cancel', 'nowMono', 'nowWall', 'schedule']);
  }
  const hub = makeRealClock();
  assert.equal(Object.getPrototypeOf(hub), null);
  assert.ok(Object.isFrozen(hub));
  assert.deepEqual(Object.keys(hub), ['port']);
  const vc = new VirtualClock(START);
  const box: { f: Fired | null } = { f: null };
  vc.port((x) => { box.f = x; }).schedule({ timerId: 'poll:p:0', class: 'poll', clock: 'mono', due: 1 });
  vc.advanceTo(1);
  assert.ok(box.f !== null && Object.isFrozen(box.f));
});

test('armDelay: past 2^31 - 1 ms the real clock sleeps in segments, a pending wall timer caps the sleep at 1 s, and an overdue timer is armed at 0', () => {
  assert.equal(armDelay({ mono: null, wall: null }), null);
  assert.equal(armDelay({ mono: 40 * 86_400_000, wall: null }), MAX_ARM_MS);
  assert.equal(armDelay({ mono: 250, wall: null }), 250);
  assert.equal(armDelay({ mono: 250, wall: 3_600_000 }), 250);
  assert.equal(armDelay({ mono: null, wall: 3_600_000 }), WALL_CHECK_MS);
  assert.equal(armDelay({ mono: 5000, wall: 300 }), 300);
  assert.equal(armDelay({ mono: -20, wall: null }), 0);
});

test('the real clock: whole-millisecond readings, mono never goes back, overdue timers of one tick fire in the fixed order, a cancelled one never fires', async () => {
  const hub = makeRealClock();
  const reader = hub.port(null);
  let last = reader.nowMono();
  for (let i = 0; i < 1000; i++) {
    const m = reader.nowMono();
    assert.ok(Number.isSafeInteger(m) && m >= last);
    last = m;
  }
  assert.ok(Number.isSafeInteger(reader.nowWall()) && Math.abs(reader.nowWall() - Date.now()) < 1000);
  const seen: string[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const c = hub.port((f) => {
    seen.push(f.timerId);
    if (f.timerId === 'poll:zend:0') done();
  });
  const now = c.nowMono();
  for (const s of shuffled([
    { timerId: 'poll:p:0', class: 'poll' as const, clock: 'mono' as const, due: now },
    { timerId: 'reminder:r:0', class: 'reminder' as const, clock: 'wall' as const, due: c.nowWall() - 5 },
    { timerId: 'silence:s:0', class: 'silence' as const, clock: 'mono' as const, due: Math.max(0, now - 10) },
    { timerId: 'deadline:gone:0', class: 'deadline' as const, clock: 'mono' as const, due: now + 5 },
  ], 11)) c.schedule(s);
  c.cancel('deadline:gone:0');
  // The end marker is a poll that sorts after poll:p:0, so it is last whether or not a busy machine
  // delays the first tick past its due time (a deadline would rank before poll:p:0 in a shared tick).
  c.schedule({ timerId: 'poll:zend:0', class: 'poll', clock: 'mono', due: now + 30 });
  // Gives up after 5 s, so a clock that never re-arms after its first tick fails the assertion below instead of hanging.
  const giveUp = setTimeout(() => done(), 5000);
  await finished;
  clearTimeout(giveUp);
  assert.deepEqual(seen, ['silence:s:0', 'reminder:r:0', 'poll:p:0', 'poll:zend:0']);
  // One native timer while anything is pending, none once nothing is: a cancelled far deadline leaves no timer behind.
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timeouts();
  c.schedule({ timerId: 'deadline:far:0', class: 'deadline', clock: 'mono', due: c.nowMono() + 3_600_000 });
  c.schedule({ timerId: 'reminder:far:0', class: 'reminder', clock: 'wall', due: c.nowWall() + 3_600_000 });
  assert.equal(timeouts(), before + 1, 'one native timer for the whole table');
  c.cancel('deadline:far:0');
  assert.equal(timeouts(), before + 1, 'the wall timer is still pending');
  c.cancel('reminder:far:0');
  assert.equal(timeouts(), before, 'nothing pending, nothing armed');
});
