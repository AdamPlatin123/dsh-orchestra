import { clearTimeout, setTimeout } from 'node:timers';
import { ownFields } from './own.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The one Clock port (plan step 3, I01, invariant 21). Every read of the time and every timer in
// orchestrad goes through a Clock, but for boot.ts's flush deadline (takeExitTimer below: it ends the
// process and feeds nothing to the journal); the static scan keeps Date.now, performance.now,
// setTimeout and the other environment clocks in this file (clock-only-in-clock-ts). Time is an input:
// a timer that causes a transition is written to the journal as a clock record, so replay reads the
// record and never the clock.
//
// A Clock has exactly four methods, nowMono(), nowWall(), schedule({timerId, class, clock, due}) and
// cancel(timerId); later steps code against that signature. Where a fired timer goes is fixed when
// the Clock is made: a ClockHub, which only the composition roots hold (boot.ts makes the real one and
// hands it down in BootPorts), mints Clocks bound to a handler, and every Clock of one hub shares one
// timer table and one total order. A timerId is unique across the hub (a second pending one is
// refused on any Clock of it), so timers due in the same tick are handled one at a time in the total
// order (class rank, timerId): a handler that cancels a later timer of the same tick stops it.
//
// The contract beyond the four methods, announced to lane C with step 3 and pinned by
// test/repo/contract-freeze.test.ts: ClockHub.port(onFire | null), the Fired keys {timerId, class,
// clock, due, durationMs, firedMono, firedWall}, and the class names. A request deadline (procguard's
// 10 s, step 6) is class 'deadline' with timerId `deadline:<requestId>:<seq>`, on a Clock its
// composition root minted from the hub.
//
// Times are integer milliseconds: nowMono counts from this process's start and compares only within
// one boot (the journal carries bootId beside it); nowWall is Unix epoch milliseconds, for calendar
// values only (a reminder's due time), never for durations (invariant 20).

// The time sources and the native timer, taken while this module evaluates. boot.ts loads it before its
// fence and before any entry module, so these are Node's own: globalThis.performance, performance.now
// and Date.now are plain writable slots (process-powers.ts keeps them), and a module that replaces or
// freezes one later changes what it reads itself, never what a Clock reads or when a timer fires.
// performance.now checks its receiver, so it is bound here, once; every call after is a plain call.
// The node:timers bindings are live (syncBuiltinESMExports() rewrites them), so they are copied too.
const monoNow: () => number = performance.now.bind(performance);
const wallNow: () => number = Date.now;
const armNative = setTimeout;
const disarmNative = clearTimeout;
// Reflect.apply is a plain writable global too; the exit timer calls the Timeout methods it took through
// this copy (takeExitTimer).
const applyNative = Reflect.apply;

/** Timer classes. A timerId starts with its class: `${class}:${entityId}:${seq}`. */
export const TIMER_CLASSES = frozen(['silence', 'reminder', 'snooze', 'unregistered', 'deadline', 'poll'] as const);
export type TimerClass = (typeof TIMER_CLASSES)[number];

/**
 * Same-tick order (plan step 3): 1 closes toward safety (none in M0; M1's approval expiry and hold
 * expiry), 2 interrupts you at P1 (the 20 s silence item), 3 revisits and reminders (reminder and
 * snooze expiry), 4 digest (none in M0), 5 annotations that open no item (60 s unregistered), last of
 * the timers the plan orders. Request deadlines and polls are not in the plan's list: they write no
 * clock record and cause no transition, so they come after all of them, and what a tick records never
 * depends on what a poll or a deadline of the same tick read or ended.
 */
export const CLASS_RANK: Readonly<Record<TimerClass, number>> = Object.freeze({
  silence: 2, reminder: 3, snooze: 3, unregistered: 5, deadline: 6, poll: 7,
});

/**
 * The classes whose firing may cause a transition, and so the only ones that get a clock record. The
 * 60 s unregistered annotation (plan line 517) causes one in step 10, on an entity the journal does not
 * have yet (records.ts ENTITIES): until then no state machine takes its cause, so it is left out here
 * and comes back with that entity, as one deliberate change of both frozen lists.
 */
export const TRANSITION_CLASSES: readonly TimerClass[] = Object.freeze(['silence', 'reminder', 'snooze'] as const);

export type ClockKind = 'mono' | 'wall';

/** `due` is a reading of the clock `clock` names. */
export type TimerSpec = { timerId: string; class: TimerClass; clock: ClockKind; due: number };

export interface Clock {
  nowMono(): number;
  nowWall(): number;
  schedule(spec: TimerSpec): void;
  /** This Clock's pending timer of that id will not fire; any other id (fired, unknown, another Clock's) is left alone. */
  cancel(timerId: string): void;
}

/** What a handler gets: the spec, how long the timer was set for, and both clock readings of the tick it fired in. */
export type Fired = {
  readonly timerId: string;
  readonly class: TimerClass;
  readonly clock: ClockKind;
  readonly due: number;
  /** `due` minus the reading of the same clock when the timer was scheduled (0 when already due). */
  readonly durationMs: number;
  readonly firedMono: number;
  readonly firedWall: number;
};

/** The journal's clock record (plan step 3), written with the transition the firing caused. */
export type ClockRecord = { timerId: string; clock: ClockKind; durationMs: number; firedMono: number; firedWall: number };

export type FireHandler = (fired: Fired) => void;

export interface ClockHub {
  /** A Clock whose timers fire into `onFire`; with null, a Clock that only reads and refuses schedule(). */
  port(onFire: FireHandler | null): Clock;
}

export type ClockErrorReason = 'bad-spec' | 'bad-timer-id' | 'class-mismatch' | 'bad-due' | 'duplicate-timer' | 'read-only' | 'not-recorded' | 'mono-backwards' | 'runaway' | 'taken';

export class ClockError extends Error {
  readonly code = 'ERR_ORCHESTRA_CLOCK';
  readonly reason: ClockErrorReason;
  constructor(reason: ClockErrorReason, detail: string) {
    super(`[ERR_ORCHESTRA_CLOCK] ${reason}: ${detail}`);
    this.reason = reason;
  }
}
frozenClass(ClockError);

/**
 * An entity id inside a timerId: the id grammar of shared/protocol.js (ID_RE). clock.ts is in boot.ts's
 * pre-fence graph, which stays as small as it is (boot.test pins it), so it restates the regex instead
 * of importing protocol.js; clock.test.ts holds the two equal. Frozen like every exported grammar
 * (shared/frozen.js): parseTimerId reads it on every journal record.
 */
export const TIMER_ENTITY_RE = frozen(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const SEQ_RE = /^(?:0|[1-9][0-9]{0,8})$/;
const MAX_SEQ = 999_999_999;

const isClass = (c: unknown): c is TimerClass => typeof c === 'string' && (TIMER_CLASSES as readonly string[]).includes(c);

/**
 * The deterministic timerId: no randomness, the entity id comes from the journal (or the scenario).
 * seq counts the firings of this class for this entity the journal already holds (Store.nextTimerSeq),
 * so it survives a restart and names one firing; a timer cancelled before it fired wrote nothing, and
 * its seq is armed again.
 */
export function timerId(cls: TimerClass, entityId: string, seq: number): string {
  if (!isClass(cls)) throw new ClockError('bad-timer-id', `unknown class ${String(cls)}`);
  if (typeof entityId !== 'string' || !TIMER_ENTITY_RE.test(entityId)) throw new ClockError('bad-timer-id', 'entity id outside the id grammar');
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQ) throw new ClockError('bad-timer-id', `seq ${String(seq)}`);
  return `${cls}:${entityId}:${seq}`;
}

export function parseTimerId(id: unknown): { class: TimerClass; entityId: string; seq: number } | null {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const [cls, entityId, seq] = parts as [string, string, string];
  if (!isClass(cls) || !TIMER_ENTITY_RE.test(entityId) || !SEQ_RE.test(seq)) return null;
  return { class: cls, entityId, seq: Number(seq) };
}

/** Same-tick order: class rank, then timerId by UTF-16 code units (never a locale). */
export function compareTimers(a: { class: TimerClass; timerId: string }, b: { class: TimerClass; timerId: string }): number {
  const r = CLASS_RANK[a.class] - CLASS_RANK[b.class];
  if (r !== 0) return r;
  return a.timerId < b.timerId ? -1 : a.timerId > b.timerId ? 1 : 0;
}

/** The clock record of a firing that caused a transition; a poll tick or a request deadline never gets one. */
export function clockRecord(f: Fired): ClockRecord {
  if (!TRANSITION_CLASSES.includes(f.class)) throw new ClockError('not-recorded', `${f.class} timers cause no transition and get no clock record`);
  return { timerId: f.timerId, clock: f.clock, durationMs: f.durationMs, firedMono: f.firedMono, firedWall: f.firedWall };
}

const SPEC_KEYS = ['timerId', 'class', 'clock', 'due'] as const;

/** Reads each field of a caller-owned spec once, own fields only, and checks it; the copy is all the table keeps. */
function copySpec(given: unknown): Readonly<TimerSpec> {
  if (typeof given !== 'object' || given === null) throw new ClockError('bad-spec', 'a spec is { timerId, class, clock, due }');
  const s = ownFields(given as TimerSpec, SPEC_KEYS);
  const parsed = parseTimerId(s.timerId);
  if (parsed === null) throw new ClockError('bad-timer-id', 'a timerId is `${class}:${entityId}:${seq}`');
  if (!isClass(s.class)) throw new ClockError('bad-spec', `unknown class ${String(s.class)}`);
  if (parsed.class !== s.class) throw new ClockError('class-mismatch', `${s.timerId as string} is not a ${s.class} timer`);
  if (s.clock !== 'mono' && s.clock !== 'wall') throw new ClockError('bad-spec', 'clock is mono or wall');
  if (!Number.isSafeInteger(s.due) || (s.due as number) < 0) throw new ClockError('bad-due', 'due is a non-negative integer of milliseconds');
  return Object.freeze({ timerId: s.timerId as string, class: s.class, clock: s.clock, due: s.due as number });
}

type PortState = { readonly onFire: FireHandler | null; readonly timers: Map<string, Entry> };
type Entry = { readonly port: PortState; readonly spec: Readonly<TimerSpec>; readonly durationMs: number };
type Reading = { mono: number; wall: number };

const isDue = (e: Entry, now: Reading) => e.spec.due <= (e.spec.clock === 'mono' ? now.mono : now.wall);

/** (class rank, timerId): a total order, since a timerId is pending at most once in a hub. */
function processingOrder(a: Entry, b: Entry): number {
  return compareTimers(a.spec, b.spec);
}

/** The timer table every Clock of a hub shares; a timerId is pending on at most one of them. */
class Table {
  readonly #ports: PortState[] = [];
  readonly #seqs = new Map<string, number>();

  /** The next number of the sequence `name` on this table: 1, 2, 3... (tableSeq). */
  next(name: string): number {
    const n = (this.#seqs.get(name) ?? 0) + 1;
    this.#seqs.set(name, n);
    return n;
  }

  addPort(onFire: FireHandler | null): PortState {
    const port: PortState = { onFire, timers: new Map() };
    this.#ports.push(port);
    return port;
  }

  add(port: PortState, spec: Readonly<TimerSpec>, now: Reading): void {
    // A timerId names one firing (0001's event_clock_timer): two Clocks of a hub arming the same one
    // would fire it twice and the second clock record would be refused, losing the wake it carried.
    if (this.#ports.some((p) => p.timers.has(spec.timerId))) throw new ClockError('duplicate-timer', `${spec.timerId} is already pending on this hub`);
    const at = spec.clock === 'mono' ? now.mono : now.wall;
    port.timers.set(spec.timerId, { port, spec, durationMs: Math.max(0, spec.due - at) });
  }

  /** Every due entry, in processing order. */
  due(now: Reading): Entry[] {
    const out: Entry[] = [];
    for (const p of this.#ports) for (const e of p.timers.values()) if (isDue(e, now)) out.push(e);
    return out.sort(processingOrder);
  }

  /** Milliseconds until the earliest mono and the earliest wall timer are due (0 or less: due now), or null for none. */
  earliest(now: Reading): { mono: number | null; wall: number | null } {
    let mono: number | null = null;
    let wall: number | null = null;
    for (const p of this.#ports) {
      for (const e of p.timers.values()) {
        if (e.spec.clock === 'mono') mono = Math.min(mono ?? Infinity, e.spec.due - now.mono);
        else wall = Math.min(wall ?? Infinity, e.spec.due - now.wall);
      }
    }
    return { mono, wall };
  }

  pending(): Entry[] {
    const out: Entry[] = [];
    for (const p of this.#ports) for (const e of p.timers.values()) out.push(e);
    return out;
  }
}

/**
 * One tick: the entries due at `now`, handled in processing order. An entry an earlier handler of the
 * same tick cancelled (or replaced) is skipped; one a handler scheduled is not in this tick.
 */
function fireTick(table: Table, now: Reading): void {
  for (const e of table.due(now)) {
    if (e.port.timers.get(e.spec.timerId) !== e) continue;
    e.port.timers.delete(e.spec.timerId);
    const fired: Fired = Object.freeze({
      timerId: e.spec.timerId, class: e.spec.class, clock: e.spec.clock, due: e.spec.due, durationMs: e.durationMs, firedMono: now.mono, firedWall: now.wall,
    });
    e.port.onFire!(fired);
  }
}

/** The table of every Clock this module made; a Clock carries nothing beyond its four methods, so tableSeq looks it up here. */
const TABLE_OF = new WeakMap<Clock, Table>();

/**
 * The next number of the sequence `name` on the timer table `clock` shares with every Clock of its hub:
 * 1, 2, 3... A caller that names its timers by a count (SpawnGate's run deadlines) numbers them here, so
 * two callers on one hub never arm the same timerId, whatever object handed each of them the hub (a
 * wrapper or a Proxy whose port() mints from one table counts that table once). The same calls on a
 * fresh VirtualClock give the same numbers. A Clock this module did not make has no table and is refused.
 */
export function tableSeq(clock: Clock, name: string): number {
  const table = typeof clock === 'object' && clock !== null ? TABLE_OF.get(clock) : undefined;
  if (table === undefined) throw new ClockError('bad-spec', 'a sequence is numbered on the table of a Clock that runtime/clock.ts made');
  if (typeof name !== 'string' || name.length === 0) throw new ClockError('bad-spec', 'a sequence has a name');
  return table.next(name);
}

/** A frozen Clock without a prototype over `table` and the time source `read`: the four methods and nothing else. */
function makePort(table: Table, read: () => Reading, onFire: FireHandler | null, changed: () => void): Clock {
  if (onFire !== null && typeof onFire !== 'function') throw new ClockError('bad-spec', 'onFire is a function or null');
  const state = table.addPort(onFire);
  const clock = Object.assign(Object.create(null) as Clock, {
    nowMono: () => read().mono,
    nowWall: () => read().wall,
    schedule: (given: TimerSpec) => {
      if (state.onFire === null) throw new ClockError('read-only', 'this clock was made without a handler and only reads');
      table.add(state, copySpec(given), read());
      changed();
    },
    cancel: (id: string) => {
      if (state.timers.delete(id)) changed();
    },
  });
  Object.freeze(clock);
  TABLE_OF.set(clock, table);
  return clock;
}

/** setTimeout's largest delay; a later timer is armed in segments of at most this. */
export const MAX_ARM_MS = 2 ** 31 - 1;
/** While a wall timer is pending, the wall clock is read at least this often, so a jump or a sleep is seen within it. */
export const WALL_CHECK_MS = 1000;

/** How long the real clock sleeps before it looks again, given what earliest() returned. */
export function armDelay(next: { mono: number | null; wall: number | null }): number | null {
  if (next.mono === null && next.wall === null) return null;
  let delay = Math.min(next.mono ?? Infinity, next.wall ?? Infinity);
  if (next.wall !== null) delay = Math.min(delay, WALL_CHECK_MS);
  return Math.max(0, Math.min(delay, MAX_ARM_MS));
}

/**
 * The real hub: performance.now() and Date.now() in whole milliseconds (the ones this module took while
 * it evaluated), and one native timer for the earliest timer of the table, armed only while a timer is
 * pending and cleared when none is (so a started orchestrad holds no timer until a later step schedules
 * one). It stays ref'd: a pending deadline must fire even when nothing else keeps the loop alive. Only
 * boot.ts makes it (static scan, clock-factories-only-in-roots).
 */
export function makeRealClock(): ClockHub {
  const table = new Table();
  const read = (): Reading => ({ mono: Math.floor(monoNow()), wall: wallNow() });
  let native: ReturnType<typeof setTimeout> | null = null;
  const rearm = () => {
    if (native !== null) {
      disarmNative(native);
      native = null;
    }
    const delay = armDelay(table.earliest(read()));
    if (delay === null) return;
    native = armNative(wake, delay);
  };
  function wake(): void {
    native = null;
    try {
      fireTick(table, read());
    } finally {
      rearm();
    }
  }
  const hub = Object.assign(Object.create(null) as ClockHub, { port: (onFire: FireHandler | null) => makePort(table, read, onFire, rearm) });
  return Object.freeze(hub);
}

/**
 * One-shot deadlines on the hub (r4 invariant 21: time only through the Clock port): `after(ms, fn)`
 * runs `fn` once, `ms` from now on the monotonic clock, and returns a function that cancels it. Timer ids
 * are deadline:<name>:<seq>; `name` must fit TIMER_ENTITY_RE.
 */
export function oneShot(hub: ClockHub, name: string): (ms: number, fn: () => void) => () => void {
  const fns = new Map<string, () => void>();
  let seq = 0;
  const clock = hub.port((f: Fired) => {
    const fn = fns.get(f.timerId);
    fns.delete(f.timerId);
    fn?.();
  });
  return (ms, fn) => {
    const id = `deadline:${name}:${seq++}`;
    fns.set(id, fn);
    clock.schedule({ timerId: id, class: 'deadline', clock: 'mono', due: clock.nowMono() + ms });
    return () => {
      if (fns.delete(id)) clock.cancel(id);
    };
  };
}

/** Runs `fire` once, `ms` milliseconds from now; it runs once, and nothing can cancel or move it. */
export type ExitTimer = (ms: number, fire: () => void) => void;

let exitTimerTaken = false;

/** The Timeout members the exit timer uses: the fields Node's constructor gives it, and the methods that arm it. */
type NativeTimeout = { _idleTimeout: number; ref(): unknown; unref(): unknown; refresh(): unknown };

/**
 * The timer of boot.ts's flush deadline (makeEndProcess), outside every hub. A deadline on the hub boot
 * hands down could be pre-armed by any module holding one of its Clocks (a timerId is pending once per
 * hub, so boot's own schedule would be refused), and its due time is a reading of the hub's clock; this
 * timer has no timerId and reads no clock. Handed out once: boot.ts takes it while it evaluates, before
 * any entry module runs, and every later call is refused (the static scan names it in boot.ts alone,
 * clock-factories-only-in-roots).
 *
 * The Timeout is made here, at that moment, unref'd and waiting 2^31 - 1 ms (and as long again each time
 * that passes unarmed), and it never leaves this module. Node's constructor gives it its own fields
 * then, and its ref and refresh are taken from Timeout.prototype then; arming sets its own delay and
 * calls those copies. A Timeout made at end time would take its fields through Timeout.prototype, which
 * any module reaches from a setTimeout() of its own (a plain global): an accessor planted there would
 * catch the delay or the callback and hold or drop the deadline (measured on 24.22). So a module that
 * writes Timeout.prototype after boot.ts evaluated reaches neither the fields nor the methods of this
 * one. What stays a residual (zen note 7.1, like net.Socket through process.stdout): Node internals a
 * module can write some other way, which the threat model leaves to the code review.
 */
export function takeExitTimer(): ExitTimer {
  if (exitTimerTaken) throw new ClockError('taken', 'the exit timer is handed out once, to boot.ts');
  exitTimerTaken = true;
  let fire: (() => void) | null = null;
  const timeout = armNative(() => {
    if (fire !== null) fire();
    else applyNative(refresh, timeout, []);
  }, MAX_ARM_MS) as unknown as NativeTimeout;
  const proto = Object.getPrototypeOf(timeout) as NativeTimeout;
  const ref = proto.ref;
  const refresh = proto.refresh;
  applyNative(proto.unref, timeout, []);
  return Object.freeze((ms: number, given: () => void) => {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_ARM_MS) throw new ClockError('bad-due', 'an exit timer runs a whole number of milliseconds up to 2^31 - 1');
    if (typeof given !== 'function') throw new ClockError('bad-spec', 'an exit timer fires a function');
    if (fire !== null) throw new ClockError('taken', 'the exit timer is armed once');
    fire = given;
    // setTimeout's own floor: a delay under 1 ms is 1.
    timeout._idleTimeout = Math.max(1, ms);
    applyNative(refresh, timeout, []);
    applyNative(ref, timeout, []);
  });
}

const MAX_TICKS_PER_MOVE = 100_000;

/**
 * The virtual hub for tests and replay: both clocks move only when told. advanceBy() lets time flow
 * (both clocks move together) and fires each due instant as its own tick, in time order, so jumping
 * an hour at once fires the same timers in the same order as stepping through it. setWall() moves the
 * wall clock alone, as an NTP correction or a sleep would, and fires the wall timers then due.
 */
export class VirtualClock implements ClockHub {
  readonly #table = new Table();
  #mono: number;
  #wall: number;

  constructor(start: { mono: number; wall: number }) {
    const s = ownFields(start, ['mono', 'wall'] as const);
    if (!Number.isSafeInteger(s.mono) || !Number.isSafeInteger(s.wall) || (s.mono as number) < 0 || (s.wall as number) < 0) {
      throw new ClockError('bad-due', 'a virtual clock starts at non-negative integer mono and wall readings');
    }
    this.#mono = s.mono as number;
    this.#wall = s.wall as number;
  }

  get mono(): number {
    return this.#mono;
  }

  get wall(): number {
    return this.#wall;
  }

  port(onFire: FireHandler | null): Clock {
    return makePort(this.#table, () => ({ mono: this.#mono, wall: this.#wall }), onFire, () => {});
  }

  /** Pending timerIds in the order they would fire if all were due now. */
  pending(): string[] {
    return this.#table.pending().sort(processingOrder).map((e) => e.spec.timerId);
  }

  advanceBy(ms: number): void {
    if (!Number.isSafeInteger(ms)) throw new ClockError('bad-due', 'advance by an integer of milliseconds');
    if (ms < 0) throw new ClockError('mono-backwards', 'the monotonic clock never goes back');
    const target = this.#mono + ms;
    for (let ticks = 0; ; ticks++) {
      if (ticks > MAX_TICKS_PER_MOVE) throw new ClockError('runaway', `more than ${MAX_TICKS_PER_MOVE} ticks in one move`);
      const next = this.#table.earliest({ mono: this.#mono, wall: this.#wall });
      const step = Math.max(0, Math.min(next.mono ?? Infinity, next.wall ?? Infinity));
      if (this.#mono + step > target) break;
      this.#mono += step;
      this.#wall += step;
      fireTick(this.#table, { mono: this.#mono, wall: this.#wall });
    }
    this.#wall += target - this.#mono;
    this.#mono = target;
  }

  advanceTo(mono: number): void {
    this.advanceBy(mono - this.#mono);
  }

  setWall(wall: number): void {
    if (!Number.isSafeInteger(wall) || wall < 0) throw new ClockError('bad-due', 'the wall clock reads a non-negative integer');
    this.#wall = wall;
    this.advanceBy(0);
  }
}
frozenClass(VirtualClock);
