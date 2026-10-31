// What the contract-freeze test pins (plan step 3: frozen at the end of the step), as plain data: the
// exported names and values of shared/protocol.js, the notify channel's interface lists, the Clock
// port and its timer grammar, and the journal's line keys, record kinds and the field tree of every
// body schema, plus a digest of migration 0001. A later change shows up as a difference against the
// golden in test/repo/contract-freeze.test.ts, which must then be updated on purpose.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { Fired } from '../../src/runtime/clock.ts';
import type { Schema } from '../../src/store/records.ts';
import * as protocol from '../../shared/protocol.js';
import * as channel from '../../src/notify/channel.ts';
import { CLASS_RANK, TIMER_CLASSES, TRANSITION_CLASSES, VirtualClock, clockRecord, makeRealClock, timerId } from '../../src/runtime/clock.ts';
import { BODY_SCHEMAS, ENTITIES, JOURNAL_KINDS, KINDS, REMINDER_EDGES, STATES } from '../../src/store/records.ts';
import { MIGRATIONS } from '../../src/store/migrations/0001-m0.ts';
import { ITEM_EDGES, KIND_RULES } from '../../src/model/inbox.ts';

/** A JSON-able picture of an export: its kind and its value as far as data goes. */
export function describeValue(v: unknown): unknown {
  if (typeof v === 'function') return `function/${v.length}`;
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
  if (Array.isArray(v)) return v.map(describeValue);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describeValue(x)]));
  return v;
}

/** The frame and payload shapes are frozen with step 4 (protocol.js's header): their names are pinned here, their trees then. */
const STEP4_SHAPES: readonly string[] = ['ENDED_FIELDS', 'FRAMES', 'ITEM_FIELDS', 'S', 'SHAPES'];

export function describeProtocol(): Record<string, unknown> {
  return Object.fromEntries(Object.keys(protocol).sort().map((k) => [k, STEP4_SHAPES.includes(k) ? 'step-4' : describeValue((protocol as Record<string, unknown>)[k])]));
}

export function describeChannel(): Record<string, unknown> {
  return Object.fromEntries(Object.keys(channel).sort().map((k) => [k, describeValue((channel as Record<string, unknown>)[k])]));
}

/**
 * The channel's TypeScript declarations as text (type stripping erases them, and `satisfies` with
 * them): a sha256 of everything from the first exported type to the lists, and each interface's
 * method names as written, so a method added to an interface without its list turns the freeze red.
 */
export function describeChannelText(): { sha256: string; interfaces: Record<string, string[]> } {
  const text = fs.readFileSync(new URL('../../src/notify/channel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('export type Visibility');
  const end = text.indexOf('// The interface as data');
  if (start < 0 || end < start) throw new Error('channel.ts: the declarations moved');
  const decl = text.slice(start, end);
  const interfaces: Record<string, string[]> = {};
  for (const m of decl.matchAll(/^export interface (\w+) \{\n([\s\S]*?)^\}/gm)) {
    interfaces[m[1]!] = [...m[2]!.matchAll(/^ {2}(\w+)\(/gm)].map((x) => x[1]!);
  }
  return { sha256: crypto.createHash('sha256').update(decl, 'utf8').digest('hex'), interfaces };
}

/** The policy tables a stored body is checked against at replay: frozen contracts that may only grow (records.ts). */
export function describePolicy(): Record<string, unknown> {
  const rule = (r: { source: boolean; human: readonly string[]; clock: readonly string[] }) => ({ source: r.source, human: [...r.human], clock: [...r.clock] });
  return {
    entities: [...ENTITIES],
    states: Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, [...v]])),
    itemEdges: Object.fromEntries(Object.entries(ITEM_EDGES).map(([k, r]) => [k, rule(r)])),
    reminderEdges: Object.fromEntries(Object.entries(REMINDER_EDGES).map(([k, r]) => [k, rule(r)])),
    kindRules: Object.fromEntries(Object.entries(KIND_RULES).map(([k, r]) => [k, { group: r.group, sevs: [...r.sevs], confs: [...r.confs], verbs: [...r.verbs] }])),
  };
}

/** The four methods of a Clock as one of the hub's ports has them, the timer classes and their ranks, the timerId form and the clock record's fields. */
export function describeClock(): Record<string, unknown> {
  const hub = new VirtualClock({ mono: 0, wall: 0 });
  const port = hub.port(() => {});
  let fired: unknown = null;
  let firedKeys: unknown = null;
  const recorder = hub.port((f: Fired) => {
    fired = Object.keys(clockRecord(f));
    firedKeys = Object.keys(f);
  });
  recorder.schedule({ timerId: 'snooze:it-1:0', class: 'snooze', clock: 'mono', due: 5 });
  hub.advanceBy(5);
  const real = makeRealClock();
  return {
    methods: Object.getOwnPropertyNames(port).sort(),
    prototype: Object.getPrototypeOf(port),
    frozen: Object.isFrozen(port),
    // The surface beyond the four methods (announced to lane C): the hub's port(onFire | null) and what a handler gets.
    hub: { real: Object.getOwnPropertyNames(real).sort(), realPort: describeValue(real.port), virtualPort: describeValue(hub.port) },
    firedKeys,
    classes: [...TIMER_CLASSES],
    ranks: { ...CLASS_RANK },
    recorded: [...TRANSITION_CLASSES],
    timerId: timerId('reminder', 'rem-1', 0),
    recordFields: fired,
  };
}

function describeSchema(s: Schema): unknown {
  switch (s.t) {
    case 'int':
      return `int[${s.min},${s.max === Number.MAX_SAFE_INTEGER ? 'max' : s.max}]`;
    case 'const':
      return `const:${s.value}`;
    case 'enum':
      return `enum:${s.of.join('|')}`;
    case 'src':
      return `src:${s.src}`;
    case 'null':
      return { nullable: describeSchema(s.of) };
    case 'obj':
      return Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, describeSchema(f)]));
    case 'arr':
      return { array: describeSchema(s.of), min: s.min, max: s.max };
    case 'tagged':
      return { tag: s.tag, cases: Object.fromEntries(Object.entries(s.cases).map(([c, fs]) => [c, Object.fromEntries(Object.entries(fs).map(([k, f]) => [k, describeSchema(f)]))])) };
    case 'record':
      return { record: s.keys, value: describeSchema(s.value) };
    default:
      return s.t;
  }
}

export function describeJournal(lineKeys: readonly string[]): Record<string, unknown> {
  return {
    lineKeys,
    kinds: [...KINDS],
    journalKinds: [...JOURNAL_KINDS],
    bodies: Object.fromEntries(KINDS.map((k) => [k, describeSchema(BODY_SCHEMAS[k] as Schema)])),
    migrations: MIGRATIONS.map((m) => ({ name: m.name, setVersion: m.setVersion, sha256: crypto.createHash('sha256').update(m.statements.join('\n;\n'), 'utf8').digest('hex') })),
  };
}
