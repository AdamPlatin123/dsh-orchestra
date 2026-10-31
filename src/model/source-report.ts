import { checkPath } from '../fs/paths.ts';
import { ownFields } from '../runtime/own.ts';
import { ERROR_CODE_RE, HARNESSES } from '../store/records.ts';
import { VERSION_RE } from '../../shared/protocol.js';
import { frozenClass } from '../../shared/frozen.js';

// What each source tells Tuning about itself (plan step 3): the root it polls, the harness version it
// saw, its counters and its typed errors, and three times. lastPollMono is the Clock port's monotonic
// reading at its last poll, and the only one anything is judged on: step 4's status frame calls a
// source stalled when nowMono - lastPollMono > max(3 x its poll interval, 15 s) (invariant 20; a 15 s
// floor is three ticks, so a 1 s event-loop stall never flags a 250 ms poller). lastPollWall and
// lastEventWall are display only ("since hh:mm", step 15's Tuning): a wall-clock jump changes no verdict.
//
// A report holds no source free text: the version passes the version grammar or is null, an error is
// a code of the error-code grammar with a count, and the root is a path of our own configuration.

export type SourceName = (typeof HARNESSES)[number];

/** The counters a source keeps (all start at 0). missedTransitions bounds the misses of a registry source (plan §2.2 item 13). */
export const COUNT_NAMES = Object.freeze(['sessions', 'events', 'items', 'parseErrors', 'skippedLines', 'missedTransitions'] as const);
export type CountName = (typeof COUNT_NAMES)[number];

/** At most this many distinct error codes a report carries; the rest are counted under `othersCount`. */
export const MAX_ERROR_CODES = 16;

export type SourceError = { readonly code: string; readonly count: number; readonly lastWall: number };

export type SourceReport = {
  readonly source: SourceName;
  /** The root directory the source polls: an absolute drive-letter path. */
  readonly root: string;
  /** The harness version the source saw (plan §2.2 item 11), or null when it saw none that passes the grammar. */
  readonly version: string | null;
  readonly counts: Readonly<Record<CountName, number>>;
  readonly errors: readonly SourceError[];
  /** Errors whose code did not fit in `errors`. */
  readonly othersCount: number;
  /** The poll interval the source runs at, in ms. */
  readonly pollIntervalMs: number;
  /** nowMono() when the source was set up: a source that never polled stalls from here. */
  readonly registeredMono: number;
  /** nowMono() at the last poll; null before the first. The only reading `stalled` uses. */
  readonly lastPollMono: number | null;
  /** nowWall() at the last poll: display only. */
  readonly lastPollWall: number | null;
  /** nowWall() when the last event was read: display only. */
  readonly lastEventWall: number | null;
};

export class SourceReportError extends Error {
  readonly code = 'ERR_ORCHESTRA_SOURCE_REPORT';
  readonly field: string;
  constructor(field: string) {
    super(`[ERR_ORCHESTRA_SOURCE_REPORT] bad field ${field}`);
    this.field = field;
  }
}
frozenClass(SourceReportError);

const FIELDS = ['source', 'root', 'version', 'counts', 'errors', 'othersCount', 'pollIntervalMs', 'registeredMono', 'lastPollMono', 'lastPollWall', 'lastEventWall'] as const;

const nonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const intOrNull = (v: unknown): v is number | null => v === null || nonNegInt(v);

/**
 * A frozen copy of a report, own fields only, every one checked: a source hands its report to Tuning
 * through this, so a field it left out, or put on a prototype, is refused instead of read.
 */
export function sourceReport(given: SourceReport): SourceReport {
  const r = ownFields(given, FIELDS);
  for (const k of Object.keys(given ?? {})) if (!(FIELDS as readonly string[]).includes(k)) throw new SourceReportError(k);
  if (!(HARNESSES as readonly unknown[]).includes(r.source)) throw new SourceReportError('source');
  if (typeof r.root !== 'string' || !checkPath(r.root).ok) throw new SourceReportError('root');
  if (r.version !== null && (typeof r.version !== 'string' || !VERSION_RE.test(r.version))) throw new SourceReportError('version');
  const counts = ownFields(r.counts as Record<CountName, number>, COUNT_NAMES);
  if (typeof r.counts !== 'object' || r.counts === null || Object.keys(r.counts).some((k) => !(COUNT_NAMES as readonly string[]).includes(k))) throw new SourceReportError('counts');
  for (const n of COUNT_NAMES) if (!nonNegInt(counts[n])) throw new SourceReportError(`counts.${n}`);
  if (!Array.isArray(r.errors) || r.errors.length > MAX_ERROR_CODES) throw new SourceReportError('errors');
  const errors = r.errors.map((e, i) => {
    const x = ownFields(e, ['code', 'count', 'lastWall']);
    if (typeof x.code !== 'string' || !ERROR_CODE_RE.test(x.code) || !nonNegInt(x.count) || x.count === 0 || !nonNegInt(x.lastWall)) throw new SourceReportError(`errors[${i}]`);
    return Object.freeze({ code: x.code, count: x.count, lastWall: x.lastWall });
  });
  if (new Set(errors.map((e) => e.code)).size !== errors.length) throw new SourceReportError('errors');
  if (!nonNegInt(r.othersCount)) throw new SourceReportError('othersCount');
  if (!nonNegInt(r.pollIntervalMs) || r.pollIntervalMs === 0) throw new SourceReportError('pollIntervalMs');
  if (!nonNegInt(r.registeredMono)) throw new SourceReportError('registeredMono');
  for (const k of ['lastPollMono', 'lastPollWall', 'lastEventWall'] as const) if (!intOrNull(r[k])) throw new SourceReportError(k);
  if (r.lastPollMono !== null && r.lastPollMono! < r.registeredMono!) throw new SourceReportError('lastPollMono');
  if ((r.lastPollMono === null) !== (r.lastPollWall === null)) throw new SourceReportError('lastPollWall');
  return Object.freeze({
    source: r.source!, root: r.root, version: r.version ?? null,
    counts: Object.freeze(Object.fromEntries(COUNT_NAMES.map((n) => [n, counts[n]!])) as Record<CountName, number>),
    errors: Object.freeze(errors), othersCount: r.othersCount, pollIntervalMs: r.pollIntervalMs, registeredMono: r.registeredMono,
    lastPollMono: r.lastPollMono!, lastPollWall: r.lastPollWall!, lastEventWall: r.lastEventWall!,
  });
}

/** Three poll intervals with a floor of three 5 s ticks. */
export const STALL_FACTOR = 3;
export const STALL_FLOOR_MS = 15_000;

export function stallAfterMs(pollIntervalMs: number): number {
  return Math.max(STALL_FACTOR * pollIntervalMs, STALL_FLOOR_MS);
}

/**
 * Has the source stalled at `nowMono`? Only the monotonic clock counts: nowMono minus its last poll
 * (or its setup, before the first poll) over stallAfterMs. The wall readings are never read here.
 */
export function stalled(r: Pick<SourceReport, 'pollIntervalMs' | 'registeredMono' | 'lastPollMono'>, nowMono: number): boolean {
  const o = ownFields(r, ['pollIntervalMs', 'registeredMono', 'lastPollMono']);
  const since = o.lastPollMono ?? o.registeredMono;
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(o.pollIntervalMs) || !Number.isSafeInteger(nowMono)) throw new SourceReportError('stalled');
  return nowMono - since! > stallAfterMs(o.pollIntervalMs!);
}
