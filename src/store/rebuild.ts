import type { Db, Row } from './db.ts';
import type { Line } from './journal.ts';
import type { Entity } from './records.ts';
import type { BatchHuman, Cause, ItemApplyReason, ItemRefusal } from '../model/inbox.ts';
import { canonicalJson, parseCanonical } from './canonical-json.ts';
import { PROJECTION_TABLES } from './migrations/0001-m0.ts';
import { GENESIS } from './journal.ts';
import { REMINDER_EDGES, checkBody } from './records.ts';
import { parseTimerId } from '../runtime/clock.ts';
import { applyItem, applyItemTransition, applyNotified, applySnooze, strandedItem } from '../model/inbox.ts';
import { frozenClass } from '../../shared/frozen.js';

// The one apply function (plan step 3, 补1): the commit of a new batch, the startup reconciliation and
// a full rebuild all apply records through applyBatch() and nothing else. It applies what a record
// says and never re-runs a judgment: a judgment record's value is stored as written. It reads nothing
// but the batch and the database (no clock, no randomness, no locale, no environment), so the same
// journal gives the same projection tables row by row, committedAt and notifiedAt included.
//
// A batch applies whole, in one transaction that also moves applied_jseq to its commit line, and only
// right after the batch before it: a batch applied twice, or out of order, is refused (sequence).
//
// Inbox records (item, an inbox_item transition, snooze, notified) are applied by src/model/inbox.ts,
// which also checks each transition's cause against the batch: the `human` records of the whole batch
// and the `clock` records before the transition. A reminder transition is held to REMINDER_EDGES the
// same way here. Every source cause names an event: its (partRef, srcSeq) must be an `event` record
// applied before it (in this batch or an earlier one), so a cause is a link, never a label (I01, I02).
// After the whole batch no item may be stranded (still none, or snoozed with no time).
//
// Human actions (plan line 540, UI design 一 5): a human.result names a `human` of the same actionId
// (in its batch, or an earlier one for the brake) with the same verb and target; every `human` but the
// brake's has its human.result in the same batch, so no orphan exists by construction; a Command and
// the human.result that names it are in one batch, with the same actionId and the same subtrees, so a
// crash never separates them. An action the database already holds (an old journal's duplicate; the
// store refuses one before the append) is applied once: its human rows are skipped by INSERT OR IGNORE
// and counted, and so is every effect of its batch (the transitions it caused, their snooze times and
// reminders, its Command), each counted under journal.dupAction.

export type ApplyReason =
  | 'sequence'
  | 'not-a-batch'
  | 'bad-body'
  | 'no-cause'
  | 'missing-row'
  | 'bad-transition'
  | 'duplicate'
  | 'cursor-backwards'
  | 'no-result'
  | 'result-mismatch'
  | ItemApplyReason;

export class ApplyError extends Error {
  readonly code = 'ERR_ORCHESTRA_APPLY';
  readonly reason: ApplyReason;
  readonly jseq: number;
  constructor(reason: ApplyReason, jseq: number, detail: string) {
    super(`[ERR_ORCHESTRA_APPLY] ${reason} at jseq ${jseq}: ${detail}`);
    this.reason = reason;
    this.jseq = jseq;
  }
}
frozenClass(ApplyError);

/** applied_jseq: the commit line of the last batch the database holds, and its hash. */
export function appliedTail(db: Db): { jseq: number; hash: string } {
  const r = db.get('SELECT jseq, hash FROM applied_jseq WHERE id = 1');
  if (r === undefined) throw new ApplyError('missing-row', 0, 'applied_jseq has no row');
  return { jseq: Number(r.jseq), hash: String(r.hash) };
}

type Ctx = { db: Db; line: Line; commit: Line; humans: ReadonlyMap<string, BatchHuman>; clocks: ReadonlySet<string>; batch: readonly Line[] };

const str = (v: unknown): string => v as string;
const num = (v: unknown): number => v as number;
const opt = (v: unknown): string | number | null => (v === null ? null : (v as string | number));

/** The cause of a transition, or null: the three kinds of I01 and nothing else. */
function causeOf(body: Readonly<Record<string, unknown>>): { kind: 'source' | 'human' | 'clock'; actionId: string | null } | null {
  if (!Object.hasOwn(body, 'cause')) return null;
  const c = body.cause as Record<string, unknown> | null;
  if (typeof c !== 'object' || c === null || !Object.hasOwn(c, 'kind')) return null;
  if (c.kind === 'source') return Object.hasOwn(c, 'partRef') && Object.hasOwn(c, 'srcSeq') ? { kind: 'source', actionId: null } : null;
  if (c.kind === 'human') return Object.hasOwn(c, 'actionId') ? { kind: 'human', actionId: str(c.actionId) } : null;
  if (c.kind === 'clock') return Object.hasOwn(c, 'timerId') ? { kind: 'clock', actionId: null } : null;
  return null;
}

/** The full cause of a transition whose body passed its schema (causeOf said it has one). */
function fullCause(body: Readonly<Record<string, unknown>>): Cause {
  const c = body.cause as Record<string, unknown>;
  if (c.kind === 'source') return { kind: 'source', partRef: str(c.partRef), srcSeq: num(c.srcSeq) };
  if (c.kind === 'human') return { kind: 'human', actionId: str(c.actionId) };
  return { kind: 'clock', timerId: str(c.timerId) };
}

function refused(r: ItemRefusal | null, jseq: number): void {
  if (r !== null) throw new ApplyError(r.reason, jseq, r.detail);
}

function metric(db: Db, name: string, line: Line): void {
  db.run('INSERT INTO metric (name, jseq, value, obs_mono, boot_id) VALUES (?, ?, 1, ?, ?)', name, line.jseq, line.obsMono, line.bootId);
}

/** The event row every record of these kinds also gets (§2.2 item 3: one table, no other). */
function eventRow(c: Ctx, extra: { evKind?: string | null; partRef?: string | null; srcSeq?: number | null; srcTime?: number | null; precision?: string | null; content?: string | null; snippet?: string | null; actionId?: string | null; timerId?: string | null }, ignore: boolean): number {
  const sql = ignore
    ? 'INSERT OR IGNORE INTO event (jseq, kind, ev_kind, part_ref, src_seq, src_time, src_time_precision, obs_mono, obs_wall, boot_id, line_digest, content_digest, snippet_ref, action_id, timer_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    : 'INSERT INTO event (jseq, kind, ev_kind, part_ref, src_seq, src_time, src_time_precision, obs_mono, obs_wall, boot_id, line_digest, content_digest, snippet_ref, action_id, timer_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const { line } = c;
  return c.db.run(sql, line.jseq, line.kind, extra.evKind ?? null, extra.partRef ?? null, extra.srcSeq ?? null, extra.srcTime ?? null, extra.precision ?? null,
    line.obsMono, line.obsWall, line.bootId, line.digest, extra.content ?? null, extra.snippet ?? null, extra.actionId ?? null, extra.timerId ?? null,
    canonicalJson(line.body)).changes;
}

function reminderState(db: Db, id: string): string | null {
  const r = db.get('SELECT state FROM reminder WHERE id = ?', id);
  return r === undefined ? null : String(r.state);
}

/** The reminder half of the cause rule, like inbox.ts's causeRefusal: the edge's cause kinds, the human record of the batch, the clock record before it. */
function reminderCauseRefusal(c: Ctx, id: string, from: string, to: string, cause: Cause): ItemRefusal | null {
  const edge = `${from}>${to}`;
  const no = (reason: 'cause-mismatch' | 'no-human-record' | 'no-clock-record', detail: string): ItemRefusal => ({ reason, detail });
  const rule = Object.hasOwn(REMINDER_EDGES, edge) ? REMINDER_EDGES[edge]! : null;
  if (rule === null) return no('cause-mismatch', `${edge} is no reminder edge`);
  if (cause.kind === 'source') return rule.source ? null : no('cause-mismatch', `a source cannot drive ${edge}`);
  if (cause.kind === 'human') {
    const h = c.humans.get(cause.actionId);
    if (h === undefined) return no('no-human-record', `${edge} of reminder ${id} names an action its batch does not hold`);
    if (!(rule.human as readonly string[]).includes(h.verb)) return no('cause-mismatch', `${h.verb} cannot drive ${edge}`);
    // A made reminder has no id before its batch; every later change targets the reminder itself.
    if (from !== 'none' && h.targetId !== id) return no('cause-mismatch', `the action of ${edge} targets another entity than reminder ${id}`);
    return null;
  }
  const p = parseTimerId(cause.timerId);
  if (p === null || !(rule.clock as readonly string[]).includes(p.class)) return no('cause-mismatch', `this timer cannot drive ${edge}`);
  if (!c.clocks.has(cause.timerId)) return no('no-clock-record', `${edge} of reminder ${id} names a timer whose clock record is not before it in its batch`);
  if (p.entityId !== id) return no('cause-mismatch', `a timer of another entity cannot drive ${edge} of reminder ${id}`);
  return null;
}

function applyTransition(c: Ctx): void {
  const b = c.line.body;
  // applyBatchIn refused a transition without a cause before the schema check (I01).
  const cause = causeOf(b)!;
  const full = fullCause(b);
  const entity = b.entity as Entity;
  if (entity === 'inbox_item') {
    refused(applyItemTransition(c, full), c.line.jseq);
    eventRow(c, { actionId: cause.actionId }, false);
    return;
  }
  const id = str(b.id);
  const from = str(b.from);
  const to = str(b.to);
  const now = reminderState(c.db, id);
  if (now === null) throw new ApplyError('missing-row', c.line.jseq, `${entity} ${id} does not exist`);
  if (now !== from) throw new ApplyError('bad-transition', c.line.jseq, `${entity} ${id} is ${now}, the record says ${from}`);
  refused(reminderCauseRefusal(c, id, from, to, full), c.line.jseq);
  const rev = c.commit.jseq;
  if (to === 'fired' || to === 'cancelled') {
    c.db.run('UPDATE reminder SET state = ?, rev = ?, ended_jseq = ?, ended_wall = ? WHERE id = ?', to, rev, rev, c.line.obsWall, id);
  } else {
    c.db.run('UPDATE reminder SET state = ?, rev = ? WHERE id = ?', to, rev, id);
  }
  eventRow(c, { actionId: cause.actionId }, false);
}

function applyRecord(c: Ctx): void {
  const { db, line } = c;
  const b = line.body;
  const jseq = line.jseq;
  switch (line.kind) {
    case 'commit':
    case 'recovered':
      return;
    case 'project':
      db.run('INSERT INTO project (id, cwd, hue, created_jseq, updated_jseq) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET cwd = excluded.cwd, hue = excluded.hue, updated_jseq = excluded.updated_jseq',
        str(b.projectId), str(b.cwd), num(b.hue), jseq, jseq);
      return;
    case 'part':
      db.run('INSERT INTO part (ref, harness, project_id, cwd, version, created_jseq, updated_jseq) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO UPDATE SET harness = excluded.harness, project_id = excluded.project_id, cwd = excluded.cwd, version = excluded.version, updated_jseq = excluded.updated_jseq',
        str(b.partRef), str(b.harness), opt(b.projectId), opt(b.cwd), opt(b.version), jseq, jseq);
      return;
    case 'part.cursor': {
      const r = db.get('SELECT source_cursor FROM part WHERE ref = ?', str(b.partRef));
      if (r === undefined) throw new ApplyError('missing-row', jseq, `part ${str(b.partRef)} does not exist`);
      if (r.source_cursor !== null && Number(r.source_cursor) > num(b.cursor)) throw new ApplyError('cursor-backwards', jseq, `part ${str(b.partRef)}`);
      db.run('UPDATE part SET source_cursor = ?, cursor_src_seq = ?, cursor_jseq = ?, updated_jseq = ? WHERE ref = ?', num(b.cursor), num(b.srcSeq), jseq, jseq, str(b.partRef));
      return;
    }
    case 'event':
      // A part re-read from its committed cursor meets its own events: the second copy is skipped.
      if (eventRow(c, {
        evKind: str(b.evKind), partRef: str(b.partRef), srcSeq: num(b.srcSeq), srcTime: b.srcTime as number | null,
        precision: str(b.srcTimePrecision), content: str(b.digest), snippet: b.snippetRef as string | null,
      }, true) === 0) metric(db, 'journal.dupEvent', line);
      return;
    case 'item':
      refused(applyItem(c), jseq);
      return;
    case 'transition':
      applyTransition(c);
      return;
    case 'snooze':
      refused(applySnooze(c), jseq);
      return;
    case 'reminder':
      if (db.get('SELECT id FROM reminder WHERE id = ?', str(b.reminderId)) !== undefined) throw new ApplyError('duplicate', jseq, `reminder ${str(b.reminderId)} exists`);
      db.run('INSERT INTO reminder (id, state, due_wall, snippet_ref, project_id, rev, created_jseq) VALUES (?, ?, ?, ?, ?, ?, ?)',
        str(b.reminderId), 'none', num(b.dueWall), opt(b.snippetRef), opt(b.projectId), c.commit.jseq, c.commit.jseq);
      return;
    case 'notified': {
      // The first notification sets notifiedAt; a later one changes nothing and is counted.
      const r = applyNotified(c);
      if (r === 'dup') metric(db, 'journal.dupNotified', line);
      else if (r !== 'set') refused(r, jseq);
      return;
    }
    case 'human':
      if (eventRow(c, { actionId: str(b.actionId) }, true) === 0) metric(db, 'journal.dupAction', line);
      return;
    case 'human.result':
      resultRefusal(c);
      if (eventRow(c, { actionId: str(b.actionId) }, true) === 0) metric(db, 'journal.dupResult', line);
      return;
    case 'judgment':
      eventRow(c, {}, false);
      return;
    case 'clock':
      if (eventRow(c, { timerId: str(b.timerId) }, true) === 0) throw new ApplyError('duplicate', jseq, `timer ${str(b.timerId)} fired twice`);
      return;
    case 'brake.plan':
      eventRow(c, {}, false);
      return;
    case 'route':
      // A dispatch desk decision: kept as an event row (the tower's router row reads the last one).
      eventRow(c, { actionId: str(b.actionId) }, false);
      return;
    case 'agent-request':
      // A person's decision on an agent request (seat): an event row beside its human records.
      eventRow(c, { actionId: str(b.actionId) }, false);
      return;
    case 'owned-cwd':
      // Where a session a person started works, when in a project root: an event row beside its human records.
      eventRow(c, { actionId: str(b.actionId) }, false);
      return;
    case 'command': {
      const h = b.harness as Record<string, unknown>;
      if (db.get('SELECT id FROM command WHERE id = ?', str(b.commandId)) !== undefined) throw new ApplyError('duplicate', jseq, `command ${str(b.commandId)} exists`);
      db.run('INSERT INTO command (id, action_id, verb, harness_pid, harness_create_time, status, subtrees, jseq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        str(b.commandId), str(b.actionId), str(b.verb), num(h.pid), str(h.createTime), str(b.status), canonicalJson(b.subtrees), jseq);
      return;
    }
    case 'protect':
      if (b.op === 'add') {
        db.run('INSERT INTO protect_entry (pid, create_time, reason, added_jseq) VALUES (?, ?, ?, ?) ON CONFLICT (pid, create_time) DO UPDATE SET reason = excluded.reason, added_jseq = excluded.added_jseq',
          num(b.pid), str(b.createTime), str(b.reason), jseq);
      } else {
        db.run('DELETE FROM protect_entry WHERE pid = ? AND create_time = ?', num(b.pid), str(b.createTime));
      }
      return;
  }
}

/** The human record a human.result answers: in its batch, else an earlier one (a brake's); its verb and target. */
function humanOf(c: Ctx, actionId: string): BatchHuman | null {
  const h = c.humans.get(actionId);
  if (h !== undefined) return h;
  const r = c.db.get("SELECT body FROM event WHERE kind = 'human' AND action_id = ?", actionId);
  if (r === undefined) return null;
  const body = parseCanonical(String(r.body)) as { verb: string; targetId: string | null };
  return { verb: body.verb, targetId: body.targetId };
}

/** A human.result: its human exists with the same verb and target; a commandId names the Command of the same action in its batch, with the same subtrees. */
function resultRefusal(c: Ctx): void {
  const b = c.line.body;
  const jseq = c.line.jseq;
  const h = humanOf(c, str(b.actionId));
  if (h === null) throw new ApplyError('no-human-record', jseq, 'a human.result answers no human record');
  if (h.verb !== b.verb || h.targetId !== b.targetId) throw new ApplyError('result-mismatch', jseq, 'a human.result repeats another verb or target than its human record');
  if (b.commandId === null) return;
  const cmd = c.batch.find((l) => l.kind === 'command' && l.body.commandId === b.commandId && l.jseq < jseq);
  if (cmd === undefined) throw new ApplyError('result-mismatch', jseq, `a human.result names a command its batch does not hold before it`);
  if (cmd.body.actionId !== b.actionId || canonicalJson(cmd.body.subtrees) !== canonicalJson(b.subtrees)) {
    throw new ApplyError('result-mismatch', jseq, 'a human.result names a command of another action, or other subtrees');
  }
}

/** After the whole batch: every human but a brake's has its result in the batch, and every Command its human.result. */
function batchActionsRefusal(batch: readonly Line[]): void {
  const results = batch.filter((l) => l.kind === 'human.result');
  for (const l of batch) {
    if (l.kind === 'human' && l.body.verb !== 'brake' && !results.some((r) => r.body.actionId === l.body.actionId)) {
      throw new ApplyError('no-result', l.jseq, `a ${str(l.body.verb)} human record has no human.result in its batch`);
    }
    if (l.kind === 'command' && !results.some((r) => r.body.commandId === l.body.commandId)) {
      throw new ApplyError('no-result', l.jseq, 'a command has no human.result in its batch');
    }
  }
}

/**
 * The lines of a batch that belong to an action the database already holds (an old journal's
 * duplicate): transitions it caused, the snooze times and reminders of those, and a Command whose
 * result is already there. Read before the batch applies anything.
 */
function duplicateEffects(db: Db, batch: readonly Line[]): ReadonlySet<Line> {
  const held = (kind: string, a: unknown) => db.get('SELECT jseq FROM event WHERE kind = ? AND action_id = ?', kind, str(a)) !== undefined;
  const dupHumans = new Set(batch.filter((l) => l.kind === 'human' && held('human', l.body.actionId)).map((l) => str(l.body.actionId)));
  const dupResults = new Set(batch.filter((l) => l.kind === 'human.result' && held('human.result', l.body.actionId)).map((l) => str(l.body.actionId)));
  const skip = new Set<Line>();
  const items = new Set<string>();
  const reminders = new Set<string>();
  for (const l of batch) {
    if (l.kind !== 'transition') continue;
    const c = causeOf(l.body);
    if (c === null || c.kind !== 'human' || !dupHumans.has(c.actionId!)) continue;
    skip.add(l);
    (l.body.entity === 'reminder' ? reminders : items).add(str(l.body.id));
  }
  for (const l of batch) {
    if ((l.kind === 'snooze' && items.has(str(l.body.itemId))) || (l.kind === 'reminder' && reminders.has(str(l.body.reminderId))) || (l.kind === 'command' && dupResults.has(str(l.body.actionId)))) skip.add(l);
  }
  return skip;
}

/**
 * Applies one committed batch (its records, then its commit line) in one transaction and moves
 * applied_jseq to the commit line. Refused unless the batch comes right after applied_jseq.
 */
export function applyBatch(db: Db, batch: readonly Line[]): void {
  db.transaction(() => applyBatchIn(db, batch));
}

/**
 * applyBatch inside a transaction the caller holds: the store's commit applies a batch first, then
 * writes it to the journal, and commits the transaction once the journal's fsync returned.
 */
export function applyBatchIn(db: Db, batch: readonly Line[]): void {
  const commit = batch.at(-1);
  if (commit === undefined || commit.kind !== 'commit' || commit.body.count !== batch.length - 1) {
    throw new ApplyError('not-a-batch', commit?.jseq ?? 0, 'a batch ends with a commit line counting the records before it');
  }
  for (let i = 0; i < batch.length; i++) {
    const l = batch[i]!;
    if (l.jseq !== batch[0]!.jseq + i || (i < batch.length - 1 && l.kind === 'commit')) throw new ApplyError('not-a-batch', l.jseq, 'records of a batch are consecutive and only the last one commits');
  }
  const applied = appliedTail(db);
  if (batch[0]!.jseq !== applied.jseq + 1) throw new ApplyError('sequence', batch[0]!.jseq, `the database holds up to jseq ${applied.jseq}`);
  if (batch[0]!.prevHash !== applied.hash) throw new ApplyError('sequence', batch[0]!.jseq, 'the batch does not follow the line the database holds');
  for (const line of batch) {
    if (line.kind === 'transition' && causeOf(line.body) === null) throw new ApplyError('no-cause', line.jseq, 'a transition needs a source, human or clock cause');
    const err = checkBody(line.kind, line.body, null);
    if (err !== null) throw new ApplyError('bad-body', line.jseq, `${line.kind} ${err.reason} at ${err.at}`);
  }
  // Every human record of the batch, wherever it stands: a mark verb's transition comes before its human record.
  const humans = new Map<string, BatchHuman>();
  for (const line of batch) {
    const a = line.kind === 'human' ? str(line.body.actionId) : null;
    if (a !== null && !humans.has(a)) humans.set(a, { verb: str(line.body.verb), targetId: line.body.targetId as string | null });
  }
  batchActionsRefusal(batch);
  const skip = duplicateEffects(db, batch);
  const clocks = new Set<string>();
  for (const line of batch) {
    if (skip.has(line)) {
      metric(db, 'journal.dupAction', line);
      continue;
    }
    applyRecord({ db, line, commit, humans, clocks, batch });
    if (line.kind === 'clock') clocks.add(str(line.body.timerId));
  }
  refused(strandedItem(db), commit.jseq);
  db.run('UPDATE applied_jseq SET jseq = ?, hash = ? WHERE id = 1', commit.jseq, commit.hash);
}

/**
 * A full rebuild: empties every projection table (snippet and metric, the side tables, stay) and
 * applies every batch from the first. The database must be migrated (DbOpener.open does that).
 */
export function rebuildProjection(db: Db, batches: readonly (readonly Line[])[]): void {
  db.transaction(() => {
    // Fixed statements, one per projection table (PROJECTION_TABLES lists the same names).
    db.run('DELETE FROM project');
    db.run('DELETE FROM part');
    db.run('DELETE FROM event');
    db.run('DELETE FROM inbox_item');
    db.run('DELETE FROM reminder');
    db.run('DELETE FROM command');
    db.run('DELETE FROM protect_entry');
    db.run('UPDATE applied_jseq SET jseq = 0, hash = ? WHERE id = 1', GENESIS);
  });
  for (const b of batches) applyBatch(db, b);
}

/** Every row of every projection table, in primary-key order, for comparing two databases. */
export function dumpProjection(db: Db): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  const q: Readonly<Record<string, string>> = {
    applied_jseq: 'SELECT * FROM applied_jseq ORDER BY id',
    project: 'SELECT * FROM project ORDER BY id',
    part: 'SELECT * FROM part ORDER BY ref',
    event: 'SELECT * FROM event ORDER BY jseq',
    inbox_item: 'SELECT * FROM inbox_item ORDER BY id',
    reminder: 'SELECT * FROM reminder ORDER BY id',
    command: 'SELECT * FROM command ORDER BY id',
    protect_entry: 'SELECT * FROM protect_entry ORDER BY pid, create_time',
  };
  for (const t of PROJECTION_TABLES) out[t] = db.all(q[t]!).map((r) => ({ ...r }));
  return out;
}
