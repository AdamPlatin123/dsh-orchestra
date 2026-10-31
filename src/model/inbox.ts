import type { Db, Row } from '../store/db.ts';
import type { Line, Rec } from '../store/journal.ts';
import type { TimerClass } from '../runtime/clock.ts';
import type { HumanVerb, ItemKind, ItemVerb } from '../../shared/protocol.js';
import { parseTimerId } from '../runtime/clock.ts';
import { ownFields } from '../runtime/own.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import { CONFIDENCES, CREATE_TIME_RE, END_CLASSES, GROUPS, ID_RE, ITEM_KINDS, ITEM_STATES, ITEM_VERBS, SEVERITIES, TITLE_KEYS, UUID_RE } from '../../shared/protocol.js';
import { frozenClass } from '../../shared/frozen.js';

// The inbox model (plan step 3, moved from step 5; r4 §6.5, §11.2). One table says what each kind of
// item is (its group, its levels, its confidences, its verbs); one table says which edges an item may
// take and what may cause each; dedupKey says when two signals are the same thing. The daemon computes
// group, level, verbs and the title key from these (UI design 一 7); the page only shows them.
//
// Every change of an item's state is a `transition` record with a cause (I01): source(partRef,
// srcSeq), human(actionId) or clock(timerId), and only the cause kinds its edge lists. A human cause
// names a `human` record of the same batch whose verb fits the edge and whose target is this item; a
// clock cause names a `clock` record earlier in the same batch, of a class the edge lists, fired for
// this item's own entity. So no item is acted without an act, nor woken without the timer's record,
// and deleting a clock record from the journal makes the replay refuse instead of diverging silently.
//
// The decision functions below build the records; the apply functions (called by store/rebuild.ts's
// applyBatch, the one apply path) write inbox_item, rev and committedJseq included. Apply reads the
// batch and the database only: no clock, no randomness, no locale.

export type Group = (typeof GROUPS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export type KindRule = {
  readonly group: Group;
  /** The levels this kind may have, its default first (r4 §11.2; M0 has one each). */
  readonly sevs: readonly Severity[];
  readonly confs: readonly Confidence[];
  /** The verbs this kind offers in a state that offers them (verbsFor). */
  readonly verbs: readonly ItemVerb[];
};

const MARKS: readonly ItemVerb[] = ['open', 'peek', 'seen', 'snooze', 'remind', 'acted'];
const rule = (group: Group, sevs: Severity[], confs: Confidence[], verbs: readonly ItemVerb[] = MARKS): KindRule =>
  Object.freeze({ group, sevs: Object.freeze(sevs), confs: Object.freeze(confs), verbs: Object.freeze([...verbs]) });

/**
 * The kind table (r4 §11.2 groups and levels, M0 only observes). approval and question are P1
 * Fermatas and the only kinds that may be a guess (plan §2.2 item 5: an unknown waitingFor, the 20 s
 * silence); unknown-outcome is P1 Fermatas; runaway P0, failure, observed policy and flood P2, all
 * Wrong notes; ready-for-review P3; your own reminder P1. Only runaway and flood are about a process
 * tree, so only they offer the brake (K is M0's one irreversible verb; plan §2.2 item 2). A reminder
 * item offers no remind: snooze is how a reminder comes back.
 */
export const KIND_RULES: Readonly<Record<ItemKind, KindRule>> = Object.freeze({
  approval: rule('fermatas', ['P1'], ['high', 'low']),
  question: rule('fermatas', ['P1'], ['high', 'low']),
  failure: rule('wrong-notes', ['P2'], ['high']),
  runaway: rule('wrong-notes', ['P0'], ['high'], [...MARKS, 'brake']),
  policy: rule('wrong-notes', ['P2'], ['high']),
  'ready-for-review': rule('ready-for-review', ['P3'], ['high']),
  flood: rule('wrong-notes', ['P2'], ['high'], [...MARKS, 'brake']),
  reminder: rule('reminders', ['P1'], ['high'], ['open', 'peek', 'seen', 'snooze', 'acted']),
  'unknown-outcome': rule('fermatas', ['P1'], ['high']),
});

const isKind = (k: unknown): k is ItemKind => typeof k === 'string' && (ITEM_KINDS as readonly string[]).includes(k);

export function groupOf(kind: ItemKind): Group {
  return KIND_RULES[kind].group;
}

export function defaultSeverity(kind: ItemKind): Severity {
  return KIND_RULES[kind].sevs[0]!;
}

/** The live states, then the end states, which are the end classes themselves (one symbol, one meaning). */
export const LIVE_STATES = Object.freeze(['open', 'seen', 'snoozed'] as const);
/** The item machine's states: `none` (before the creating transition, never shown) and protocol.js's ITEM_STATES. */
export const MACHINE_STATES: readonly string[] = Object.freeze(['none', ...ITEM_STATES]);

export const isEnded = (state: string): boolean => (END_CLASSES as readonly string[]).includes(state);

/** What may cause an edge: a source event, a human verb from the list, a clock timer of a class from the list. */
export type CauseRule = { readonly source: boolean; readonly human: readonly HumanVerb[]; readonly clock: readonly TimerClass[] };
const may = (o: { source?: boolean; human?: HumanVerb[]; clock?: TimerClass[] }): CauseRule => {
  const f = ownFields(o, ['source', 'human', 'clock']);
  return Object.freeze({ source: f.source ?? false, human: Object.freeze(f.human ?? []), clock: Object.freeze(f.clock ?? []) });
};

/**
 * The edges of r4 §6.5 for M0, as `from>to`, with their causes. An item opens from a source event or a
 * clock (the 20 s silence of a part, a reminder's due time); you see it, snooze it and act on it; only
 * the snooze timer wakes it; only the source auto-clears it. No M0 timer expires an item: the expired
 * edges are r4's and stay without a cause until M1's approval expiry brings its class, so END_CLASSES'
 * `expired` is not reachable in M0.
 *
 * This plan's reading of §6.5, which draws open -> seen -> snoozed -> open and open|seen -> the ends:
 * an open item may be snoozed without being seen first (open>snoozed: `s` works on any open row), and a
 * snoozed item may still end (snoozed>acted, snoozed>auto-cleared, snoozed>expired: a source can
 * resolve what you snoozed, and you can act on it from its detail). The table is a frozen contract
 * (contract-freeze pins it): it may only grow, or an older journal would stop replaying.
 */
export const ITEM_EDGES: Readonly<Record<string, CauseRule>> = Object.freeze({
  'none>open': may({ source: true, clock: ['silence', 'reminder'] }),
  'open>seen': may({ human: ['seen'] }),
  'open>snoozed': may({ human: ['snooze'] }),
  'seen>snoozed': may({ human: ['snooze'] }),
  'snoozed>open': may({ clock: ['snooze'] }),
  ...Object.fromEntries(LIVE_STATES.flatMap((f) => [
    [`${f}>acted`, may({ human: ['acted'] })],
    [`${f}>auto-cleared`, may({ source: true })],
    [`${f}>expired`, may({})],
  ])),
});

const STATE_VERBS: Readonly<Record<string, readonly ItemVerb[]>> = Object.freeze({
  open: ITEM_VERBS,
  seen: ITEM_VERBS.filter((v) => v !== 'seen'),
  snoozed: ['open', 'peek', 'acted'],
});

/**
 * The verbs an item offers now (ItemView.verbs), in ITEM_VERBS order: its kind's verbs that its state
 * offers. An ended item, or one not yet open, offers none: the check order answers it with
 * noop:already-ended before the verb check (UI design 一 5).
 */
export function verbsFor(kind: ItemKind, state: string): ItemVerb[] {
  const byState = Object.hasOwn(STATE_VERBS, state) ? STATE_VERBS[state]! : [];
  return ITEM_VERBS.filter((v) => KIND_RULES[kind].verbs.includes(v) && byState.includes(v));
}

/** The title key of an item (its text is shared/strings.js's); a guess has a key of its own. */
export function titleKey(kind: ItemKind, conf: Confidence): string {
  const key = conf === 'low' ? `item.${kind}.guess` : `item.${kind}`;
  if (!TITLE_KEYS.includes(key)) throw new InboxError('bad-spec', `no title key for ${kind} at confidence ${conf}`);
  return key;
}

export type InboxErrorReason = 'bad-spec' | 'bad-cause';

export class InboxError extends Error {
  readonly code = 'ERR_ORCHESTRA_INBOX';
  readonly reason: InboxErrorReason;
  constructor(reason: InboxErrorReason, detail: string) {
    super(`[ERR_ORCHESTRA_INBOX] ${reason}: ${detail}`);
    this.reason = reason;
  }
}
frozenClass(InboxError);

// --- dedupKey -------------------------------------------------------------------------------------

/**
 * The segment of a Claude waiting item (plan step 10): the registry root, the process (pid and its
 * creation time) and the registry's statusUpdatedAt. statusUpdatedAt is the source's own clock, used
 * here only for equality (I11): a new waiting segment is a new item, the same one re-read is not.
 */
export type Segment = { root: string; pid: number; procStart: string; statusUpdatedAt: number };

/** What makes two signals the same thing: kind, part and sender, and a Claude waiting item's segment. */
export type DedupSpec = { kind: ItemKind; partRef: string | null; sender: string; segment: Segment | null };

const MAX_PID = 2 ** 32 - 1;
const SEGMENT_KINDS: readonly ItemKind[] = ['approval', 'question'];

function checkSegment(s: unknown): Segment {
  const f = ownFields(s as Segment, ['root', 'pid', 'procStart', 'statusUpdatedAt']);
  if (typeof s !== 'object' || s === null || Object.keys(s).length !== 4) throw new InboxError('bad-spec', 'a segment is { root, pid, procStart, statusUpdatedAt }');
  if (typeof f.root !== 'string' || !ID_RE.test(f.root)) throw new InboxError('bad-spec', 'segment root is an id');
  if (!Number.isSafeInteger(f.pid) || f.pid! < 1 || f.pid! > MAX_PID) throw new InboxError('bad-spec', 'segment pid');
  if (typeof f.procStart !== 'string' || !CREATE_TIME_RE.test(f.procStart)) throw new InboxError('bad-spec', 'segment procStart is a creation time');
  if (!Number.isSafeInteger(f.statusUpdatedAt) || f.statusUpdatedAt! < 0) throw new InboxError('bad-spec', 'segment statusUpdatedAt is a non-negative integer');
  return { root: f.root, pid: f.pid!, procStart: f.procStart, statusUpdatedAt: f.statusUpdatedAt! };
}

/**
 * dedupKey = sha256 of the canonical JSON of {kind, partRef, sender, segment}: one encoding per value
 * (canonical-json.ts), so no two specs share a key through a separator a source could put in an id.
 * Fields are read as own properties only. A reminder item is keyed by its reminder (sender = the
 * reminder id, no part); only the waiting kinds take a segment.
 */
export function dedupKey(spec: DedupSpec): string {
  const s = ownFields(spec, ['kind', 'partRef', 'sender', 'segment']);
  if (!isKind(s.kind)) throw new InboxError('bad-spec', 'unknown kind');
  if (s.partRef !== null && (typeof s.partRef !== 'string' || !ID_RE.test(s.partRef))) throw new InboxError('bad-spec', 'partRef is an id or null');
  if (typeof s.sender !== 'string' || !ID_RE.test(s.sender)) throw new InboxError('bad-spec', 'sender is an id');
  if (s.kind === 'reminder' && s.partRef !== null) throw new InboxError('bad-spec', 'a reminder item has no part');
  let segment: Segment | null = null;
  if (s.segment !== null) {
    if (!SEGMENT_KINDS.includes(s.kind)) throw new InboxError('bad-spec', `a ${s.kind} item takes no segment`);
    segment = checkSegment(s.segment);
  }
  return canonicalDigest({ dedup: 1, kind: s.kind, partRef: s.partRef, sender: s.sender, segment });
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The id of the n-th item (from 0) ever opened under a dedupKey: deterministic, so a scenario replayed
 * from a fixture names its items the same way every run (no randomness, P4). 3 + 40 + 1 + at most 15
 * characters: inside ID_RE.
 */
export function itemIdFor(key: string, occurrence: number): string {
  if (typeof key !== 'string' || !DIGEST_RE.test(key)) throw new InboxError('bad-spec', 'a dedupKey is a sha256 digest');
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new InboxError('bad-spec', 'occurrence is a non-negative integer');
  return `it-${key.slice(0, 40)}-${occurrence}`;
}

// --- reading --------------------------------------------------------------------------------------

export type ItemRow = {
  readonly id: string;
  readonly kind: ItemKind;
  readonly state: string;
  readonly partRef: string | null;
  readonly reminderId: string | null;
  readonly snoozeUntilWall: number | null;
};

const rowOf = (r: Row): ItemRow => Object.freeze({
  id: String(r.id),
  kind: String(r.kind) as ItemKind,
  state: String(r.state),
  partRef: r.part_ref === null ? null : String(r.part_ref),
  reminderId: r.reminder_id === null ? null : String(r.reminder_id),
  snoozeUntilWall: r.snooze_until_wall === null ? null : Number(r.snooze_until_wall),
});

export function readItem(db: Db, id: string): ItemRow | null {
  const r = db.get('SELECT id, kind, state, part_ref, reminder_id, snooze_until_wall FROM inbox_item WHERE id = ?', id);
  return r === undefined ? null : rowOf(r);
}

/** What openItem needs to know of the committed items: the live one of a key, and how many a key ever had. */
export type ItemIndex = { live(key: string): string | null; count(key: string): number };

export function itemIndex(db: Db): ItemIndex {
  return Object.freeze({
    live: (key: string) => {
      const r = db.get('SELECT id FROM inbox_item WHERE dedup_key = ? AND end_class IS NULL', key);
      return r === undefined ? null : String(r.id);
    },
    count: (key: string) => Number(db.get('SELECT count(*) AS n FROM inbox_item WHERE dedup_key = ?', key)!.n),
  });
}

// --- decisions: the records a change is made of ---------------------------------------------------

export type Cause = { kind: 'source'; partRef: string; srcSeq: number } | { kind: 'human'; actionId: string } | { kind: 'clock'; timerId: string };

/**
 * A copy of a source or clock cause, own fields only, or null: a source cause outside its grammar, or
 * any other kind. A human change is made by planMark, with its human records, never from a bare cause;
 * an unparsable timerId is refused by causeAllowed.
 */
function copyCause(cause: Cause): Cause | null {
  const kind = ownFields(cause, ['kind']).kind;
  if (kind === 'source') {
    const c = ownFields(cause as Extract<Cause, { kind: 'source' }>, ['partRef', 'srcSeq']);
    return typeof c.partRef === 'string' && ID_RE.test(c.partRef) && Number.isSafeInteger(c.srcSeq) && c.srcSeq! >= 0 ? { kind, partRef: c.partRef, srcSeq: c.srcSeq! } : null;
  }
  if (kind === 'clock') {
    const c = ownFields(cause as Extract<Cause, { kind: 'clock' }>, ['timerId']);
    return typeof c.timerId === 'string' ? { kind, timerId: c.timerId } : null;
  }
  return null;
}

/** The static half of the cause rule: does `from>to` exist, and may this kind of cause (verb, timer class) drive it? */
export function causeAllowed(from: string, to: string, cause: Cause, verb: string | null = null): boolean {
  const edge = `${from}>${to}`;
  if (!Object.hasOwn(ITEM_EDGES, edge)) return false;
  const r = ITEM_EDGES[edge]!;
  switch (cause.kind) {
    case 'source':
      return r.source;
    case 'human':
      return verb === null ? r.human.length > 0 : (r.human as readonly string[]).includes(verb);
    case 'clock': {
      const p = parseTimerId(cause.timerId);
      return p !== null && r.clock.includes(p.class);
    }
    default:
      return false;
  }
}

const transition = (id: string, from: string, to: string, cause: Cause): Rec => ({ kind: 'transition', body: { entity: 'inbox_item', id, from, to, cause } });

export type OpenSpec = DedupSpec & { conf: Confidence; projectId: string | null; reminderId: string | null; sev?: Severity };

export type OpenDecision =
  | { kind: 'dedup'; itemId: string; dedupKey: string }
  | { kind: 'open'; itemId: string; dedupKey: string; records: Rec[] };

/**
 * A new signal: the live item it duplicates, or the records that open a new one (its item record and
 * its none>open transition, in that order, for one batch). Level and group come from the kind table;
 * a level the kind does not have, a confidence it cannot be, or a reminder id on anything but a
 * reminder item is refused here as it is by the journal.
 */
export function openItem(index: ItemIndex, spec: OpenSpec, cause: Cause): OpenDecision {
  const s = ownFields(spec, ['kind', 'partRef', 'sender', 'segment', 'conf', 'projectId', 'reminderId', 'sev']);
  const key = dedupKey({ kind: s.kind!, partRef: s.partRef ?? null, sender: s.sender!, segment: s.segment ?? null });
  const kind = s.kind!;
  const r = KIND_RULES[kind];
  const sev = s.sev === undefined ? r.sevs[0]! : s.sev;
  if (!r.sevs.includes(sev)) throw new InboxError('bad-spec', `a ${kind} item is ${r.sevs.join(' or ')}`);
  if (!r.confs.includes(s.conf as Confidence)) throw new InboxError('bad-spec', `a ${kind} item cannot be of confidence ${String(s.conf)}`);
  if (s.projectId !== null && (typeof s.projectId !== 'string' || !ID_RE.test(s.projectId))) throw new InboxError('bad-spec', 'projectId is an id or null');
  if ((kind === 'reminder') !== (s.reminderId !== null)) throw new InboxError('bad-spec', 'a reminder item, and only one, names its reminder');
  if (s.reminderId !== null && (typeof s.reminderId !== 'string' || !ID_RE.test(s.reminderId))) throw new InboxError('bad-spec', 'reminderId is an id');
  const c = copyCause(cause);
  if (c === null || !causeAllowed('none', 'open', c)) throw new InboxError('bad-cause', 'only a source event or a silence or reminder timer opens an item');
  const live = index.live(key);
  if (live !== null) return { kind: 'dedup', itemId: live, dedupKey: key };
  const itemId = itemIdFor(key, index.count(key));
  return {
    kind: 'open',
    itemId,
    dedupKey: key,
    records: [
      {
        kind: 'item',
        body: {
          itemId, itemKind: kind, sev, group: r.group, conf: s.conf!, projectId: s.projectId ?? null, partRef: s.partRef ?? null, dedupKey: key, reminderId: s.reminderId ?? null,
        },
      },
      transition(itemId, 'none', 'open', c),
    ],
  };
}

/** A source or clock change of an item (auto-clear, a snooze waking): its transition record, after the static cause check. A human change goes through planMark. */
export function moveItem(item: ItemRow, to: string, cause: Cause): Rec[] {
  const c = copyCause(cause);
  if (c === null || !causeAllowed(item.state, to, c)) throw new InboxError('bad-cause', `this cause cannot move an item from ${item.state} to ${to}`);
  return [transition(item.id, item.state, to, c)];
}

export type MarkVerb = 'seen' | 'snooze' | 'acted';
export type MarkRequest = { verb: MarkVerb; actionId: string; requestDigest: string; untilWall?: number | null };
export type MarkPlan =
  | { kind: 'refuse'; code: 'item-unknown' | 'verb-not-allowed' }
  | { kind: 'noop'; records: Rec[] }
  | { kind: 'apply'; records: Rec[] };

const MARK_TO: Readonly<Record<MarkVerb, string>> = Object.freeze({ seen: 'seen', snooze: 'snoozed', acted: 'acted' });

/**
 * A mark verb (seen, snooze, acted) on an item, from the check order's item steps on (plan line 588):
 * no item is 404 item-unknown; an ended item is accepted and changes nothing (noop:already-ended,
 * before the verb check, since an ended item has no verbs); a verb the item does not offer is 422
 * verb-not-allowed; otherwise the transition (and a snooze's time), then `human` and `human.result`,
 * all for one batch: the marker after the effect, and no orphan `human` by construction (UI design 一 5).
 */
export function planMark(item: ItemRow | null, req: MarkRequest): MarkPlan {
  const q = ownFields(req, ['verb', 'actionId', 'requestDigest', 'untilWall']);
  if (q.verb !== 'seen' && q.verb !== 'snooze' && q.verb !== 'acted') throw new InboxError('bad-spec', 'a mark verb is seen, snooze or acted');
  if (typeof q.actionId !== 'string' || !UUID_RE.test(q.actionId)) throw new InboxError('bad-spec', 'actionId is a UUID');
  if (typeof q.requestDigest !== 'string' || !DIGEST_RE.test(q.requestDigest)) throw new InboxError('bad-spec', 'requestDigest is a sha256 digest');
  if (q.verb === 'snooze' ? !Number.isSafeInteger(q.untilWall) || q.untilWall! < 0 : q.untilWall !== undefined && q.untilWall !== null) {
    throw new InboxError('bad-spec', 'a snooze, and only a snooze, has an untilWall');
  }
  if (item === null) return { kind: 'refuse', code: 'item-unknown' };
  const human: Rec = { kind: 'human', body: { actionId: q.actionId, verb: q.verb, targetId: item.id, requestDigest: q.requestDigest } };
  const result = (outcome: string): Rec => ({ kind: 'human.result', body: { actionId: q.actionId, verb: q.verb, targetId: item.id, outcome, commandId: null, subtrees: null } });
  if (isEnded(item.state)) return { kind: 'noop', records: [human, result('noop:already-ended')] };
  if (!verbsFor(item.kind, item.state).includes(q.verb)) return { kind: 'refuse', code: 'verb-not-allowed' };
  const effect: Rec[] = [transition(item.id, item.state, MARK_TO[q.verb], { kind: 'human', actionId: q.actionId })];
  if (q.verb === 'snooze') effect.push({ kind: 'snooze', body: { itemId: item.id, untilWall: q.untilWall! } });
  return { kind: 'apply', records: [...effect, human, result('applied')] };
}

/**
 * Why an item body breaks the kind table, as the field at fault, or null (records.ts runs it at the
 * append, at the startup scan and at apply): the group is the kind's, the level one it may have, the
 * confidence one it may be, and a reminder id is there exactly when the kind is reminder.
 */
export function itemBodyError(b: Readonly<Record<string, unknown>>): string | null {
  if (!isKind(b.itemKind)) return '$.itemKind';
  const r = KIND_RULES[b.itemKind];
  if (b.group !== r.group) return '$.group';
  if (!(r.sevs as readonly unknown[]).includes(b.sev)) return '$.sev';
  if (!(r.confs as readonly unknown[]).includes(b.conf)) return '$.conf';
  if ((b.itemKind === 'reminder') !== (b.reminderId !== null)) return '$.reminderId';
  return null;
}

// --- apply: what store/rebuild.ts's applyBatch runs for inbox records -----------------------------

export type ItemApplyReason = 'missing-row' | 'bad-transition' | 'duplicate' | 'dedup-live' | 'cause-mismatch' | 'no-human-record' | 'no-clock-record' | 'no-source-event' | 'bad-snooze' | 'stranded';

/** A typed refusal; rebuild.ts turns it into its ApplyError. detail names ids and states, never source text. */
export type ItemRefusal = { readonly reason: ItemApplyReason; readonly detail: string };

/** A `human` record of the batch being applied, by actionId. */
export type BatchHuman = { readonly verb: string; readonly targetId: string | null };

export type ItemApplyCtx = {
  readonly db: Db;
  readonly line: Line;
  /** The batch's commit line: rev and committedJseq are its jseq. */
  readonly commit: Line;
  /** Every `human` record of the batch, whatever its position. */
  readonly humans: ReadonlyMap<string, BatchHuman>;
  /** The timerIds of the `clock` records of the batch applied so far. */
  readonly clocks: ReadonlySet<string>;
};

const refuse = (reason: ItemApplyReason, detail: string): ItemRefusal => Object.freeze({ reason, detail });
const str = (v: unknown): string => v as string;
const opt = (v: unknown): string | null => (v === null ? null : (v as string));

/** An `item` record: a new row in state none, unless the id exists or a live item has its dedupKey. */
export function applyItem(c: ItemApplyCtx): ItemRefusal | null {
  const b = c.line.body;
  if (c.db.get('SELECT id FROM inbox_item WHERE id = ?', str(b.itemId)) !== undefined) return refuse('duplicate', `item ${str(b.itemId)} exists`);
  const live = c.db.get('SELECT id FROM inbox_item WHERE dedup_key = ? AND end_class IS NULL', str(b.dedupKey));
  if (live !== undefined) return refuse('dedup-live', `item ${str(live.id)} is live under the same dedupKey`);
  c.db.run('INSERT INTO inbox_item (id, kind, sev, grp, conf, state, project_id, part_ref, dedup_key, reminder_id, rev, created_jseq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    str(b.itemId), str(b.itemKind), str(b.sev), str(b.group), str(b.conf), 'none', opt(b.projectId), opt(b.partRef), str(b.dedupKey), opt(b.reminderId), c.commit.jseq, c.commit.jseq);
  return null;
}

/**
 * The dynamic half of the cause rule: the human record of the batch, the clock record before it for
 * this item's own entity, or the source event the cause names, applied before it (in this batch or an
 * earlier one): a source cause is a link to its event, never a label.
 */
function causeRefusal(c: ItemApplyCtx, item: ItemRow, from: string, to: string, cause: Cause): ItemRefusal | null {
  const edge = `${from}>${to}`;
  if (!causeAllowed(from, to, cause)) return refuse('cause-mismatch', `${cause.kind} cannot drive ${edge}`);
  if (cause.kind === 'source') {
    if (c.db.get("SELECT jseq FROM event WHERE kind = 'event' AND part_ref = ? AND src_seq = ?", cause.partRef, cause.srcSeq) === undefined) {
      return refuse('no-source-event', `${edge} of item ${item.id} names a source event (${cause.partRef}, ${cause.srcSeq}) no batch applied before it`);
    }
  } else if (cause.kind === 'human') {
    const h = c.humans.get(cause.actionId);
    if (h === undefined) return refuse('no-human-record', `${edge} of item ${item.id} names an action its batch does not hold`);
    if (!causeAllowed(from, to, cause, h.verb)) return refuse('cause-mismatch', `${h.verb} cannot drive ${edge}`);
    if (h.targetId !== item.id) return refuse('cause-mismatch', `the action of ${edge} targets another entity than item ${item.id}`);
  } else if (cause.kind === 'clock') {
    if (!c.clocks.has(cause.timerId)) return refuse('no-clock-record', `${edge} of item ${item.id} names a timer whose clock record is not before it in its batch`);
    const p = parseTimerId(cause.timerId)!;
    const owner = p.class === 'snooze' ? item.id : p.class === 'reminder' ? item.reminderId : p.class === 'silence' ? item.partRef : null;
    if (owner !== p.entityId) return refuse('cause-mismatch', `a ${p.class} timer of another entity cannot drive ${edge} of item ${item.id}`);
  }
  return null;
}

/** An inbox_item `transition`: from must be the state, the cause must fit; rev moves to the batch's commit jseq. */
export function applyItemTransition(c: ItemApplyCtx, cause: Cause): ItemRefusal | null {
  const b = c.line.body;
  const id = str(b.id);
  const from = str(b.from);
  const to = str(b.to);
  const item = readItem(c.db, id);
  if (item === null) return refuse('missing-row', `inbox_item ${id} does not exist`);
  if (item.state !== from) return refuse('bad-transition', `inbox_item ${id} is ${item.state}, the record says ${from}`);
  const no = causeRefusal(c, item, from, to, cause);
  if (no !== null) return no;
  const rev = c.commit.jseq;
  const { line } = c;
  if (from === 'none') {
    c.db.run('UPDATE inbox_item SET state = ?, rev = ?, committed_jseq = ?, committed_mono = ?, committed_wall = ?, committed_boot_id = ? WHERE id = ?',
      to, rev, rev, line.obsMono, line.obsWall, line.bootId, id);
  } else if (isEnded(to)) {
    c.db.run('UPDATE inbox_item SET state = ?, rev = ?, end_class = ?, end_cause = ?, ended_jseq = ?, ended_wall = ?, ended_action_id = ? WHERE id = ?',
      to, rev, to, cause.kind, rev, line.obsWall, cause.kind === 'human' ? cause.actionId : null, id);
  } else if (from === 'snoozed') {
    c.db.run('UPDATE inbox_item SET state = ?, rev = ?, snooze_until_wall = NULL WHERE id = ?', to, rev, id);
  } else {
    c.db.run('UPDATE inbox_item SET state = ?, rev = ? WHERE id = ?', to, rev, id);
  }
  return null;
}

/** A `snooze` record: the time of the snooze its batch just made (the item is snoozed and has none yet). */
export function applySnooze(c: ItemApplyCtx): ItemRefusal | null {
  const b = c.line.body;
  const item = readItem(c.db, str(b.itemId));
  if (item === null) return refuse('missing-row', `item ${str(b.itemId)} does not exist`);
  if (item.state !== 'snoozed' || item.snoozeUntilWall !== null) return refuse('bad-snooze', `item ${item.id} is ${item.state}: a snooze time follows its open>snoozed or seen>snoozed in one batch`);
  c.db.run('UPDATE inbox_item SET snooze_until_wall = ? WHERE id = ?', b.untilWall as number, item.id);
  return null;
}

/**
 * A `notified` record: the first one sets notifiedAt ('set') and, since it changes ItemView.notify
 * (pending -> handed), moves rev to the batch's commit jseq: rev is the jseq of the item's last change
 * (UI design 一 2). A later one changes nothing ('dup', counted by the caller).
 */
export function applyNotified(c: ItemApplyCtx): ItemRefusal | 'set' | 'dup' {
  const b = c.line.body;
  if (c.db.get('SELECT id FROM inbox_item WHERE id = ?', str(b.itemId)) === undefined) return refuse('missing-row', `item ${str(b.itemId)} does not exist`);
  const set = c.db.run('UPDATE inbox_item SET notified_mono = ?, notified_wall = ?, notified_boot_id = ?, notified_via = ?, notified_attempt = ?, rev = ? WHERE id = ? AND notified_wall IS NULL',
    b.atMono as number, b.atWall as number, c.line.bootId, str(b.via), b.attempt as number, c.commit.jseq, str(b.itemId));
  return set.changes === 0 ? 'dup' : 'set';
}

/**
 * After a whole batch: no item may be left without an owner (P2). An item still in none never opened;
 * a snoozed item without a time has no timer to wake it.
 */
export function strandedItem(db: Db): ItemRefusal | null {
  const r = db.get("SELECT id, state FROM inbox_item WHERE state = 'none' OR (state = 'snoozed' AND snooze_until_wall IS NULL) ORDER BY id LIMIT 1");
  if (r === undefined) return null;
  return refuse('stranded', String(r.state) === 'none' ? `item ${String(r.id)} was made and never opened in its batch` : `item ${String(r.id)} is snoozed with no snooze time`);
}
