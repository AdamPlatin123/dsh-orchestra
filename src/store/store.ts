import * as path from 'node:path';
import type { Clock, TimerClass } from '../runtime/clock.ts';
import type { Db } from './db.ts';
import type { ChainBreak, Committed, JournalWriter, Line, Rec, Tail } from './journal.ts';
import type { Redactor } from './redact.ts';
import { timerId } from '../runtime/clock.ts';
import { canonicalJson, parseCanonical } from './canonical-json.ts';
import { dbPath } from './db.ts';
import { Journal, journalPath, scanJournal } from './journal.ts';
import { MAX_BATCH } from './records.ts';
import { appliedTail, applyBatch, applyBatchIn } from './rebuild.ts';
import { Snippets } from './snippets.ts';
import { frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// The store as working.ts opens it (plan step 3): the database (migrated), the journal, the startup
// reconciliation, and the one commit path. The Journal stays inside: Store.commit is the only way a
// record reaches the file, always applied in an open transaction first, so a record apply would refuse
// never reaches the authoritative log (where it would stop every later start).
//
// Commit order (I02, P5): the batch is applied inside an open transaction first; then it is appended
// with one fsync; then the transaction commits (and applied_jseq with it); external effects come after
// commit() returns. A crash before the fsync returns leaves an uncommitted tail the next start cuts; a
// crash after it leaves a committed batch the database lacks, which the next start applies. If the
// transaction fails after the fsync returned (COMMIT itself failing, say SQLITE_FULL), the batch is in
// the log and not in the database: commit() throws the typed StoreError committed-not-applied (the
// action happened, P1) and the store takes nothing more (unusable: db-behind-journal); the restart
// applies the batch. commitDoneMono, a side-table metric, is best effort: its failure is counted,
// never turned into a failed commit.
//
// A human action reaches the journal once: commit() refuses a batch whose `human` or `human.result`
// names an actionId the database already holds (duplicate-action, before the append; step 4 checks
// before that, so this is the backstop). apply's INSERT OR IGNORE then only ever meets an old journal.
//
// Startup reconciliation: open (and migrate) the database; scan the journal line by line; a break is
// the typed result journal-chain (main exits with the ui-only code, 22, and the lock goes with the
// process), except a bad line in the final batch that the database never applied (journal.ts:
// tornFinal), which is cut like a torn tail; the database may not hold more than the journal, and the
// line it says it holds must be the journal's (else journal-chain too); a tail after the last commit is
// cut through the write fence and a `recovered` batch records the bytes; every batch after
// applied_jseq is applied; every `human` without a `human.result` (only a brake can leave one, by
// construction) gets outcome `unknown`; snippet texts past their TTL are tombstoned.
//
// The cut and its record cannot be one atomic step, so the cut is announced first: journal.cut, written
// atomically through the fence, says {committedBytes, cutBytes, tail} before the file is shortened and
// is removed once the recovered batch is committed. A start that finds it finishes the record with the
// original count (a crash after the cut, or a torn recovered batch), or only removes it (a crash after
// the recovered batch committed); a marker that fits neither is journal-chain (cut-marker).

/** What the store writes and reads through: the write fence (append with fsync, shorten, writeAtomic, rm) and the read gate. */
export type StoreWriter = JournalWriter & {
  shorten(target: string, length: number): void;
  writeAtomic(target: string, data: string): void;
  rm(target: string): unknown;
};
export type StoreReader = { readFile(target: string): Uint8Array };

export type StoreDeps = {
  /** DbOpener.open, from the opener the composition root made with the minted factory. */
  openDb(file: string): Db;
  writer: StoreWriter;
  reader: StoreReader;
  home: string;
  bootId: string;
  clock: Pick<Clock, 'nowMono' | 'nowWall'>;
  redactor: Redactor;
};

export type StoreReport = { cutBytes: number; appliedBatches: number; orphansClosed: number };

export type StoreOpen =
  | { ok: true; store: Store; report: StoreReport }
  | { ok: false; reason: 'journal-chain'; break: ChainBreak };

export type StoreErrorReason = 'committed-not-applied' | 'unusable' | 'duplicate-action';

export class StoreError extends Error {
  readonly code = 'ERR_ORCHESTRA_STORE';
  readonly reason: StoreErrorReason;
  /** The commit jseq of the batch, for committed-not-applied; -1 otherwise. */
  readonly jseq: number;
  constructor(reason: StoreErrorReason, detail: string, jseq = -1) {
    super(`[ERR_ORCHESTRA_STORE] ${reason}: ${detail}`);
    this.reason = reason;
    this.jseq = jseq;
  }
}
frozenClass(StoreError);

/** Where the pending-cut marker lives under ORCHESTRA_HOME. */
export function cutMarkerPath(home: string): string {
  return win.join(home, 'journal.cut');
}

/** A read through the gate; only a refusal for a missing file (decision.reason not-found) is "none", anything else throws. */
function readOrNull(reader: StoreReader, file: string): Uint8Array | null {
  try {
    return reader.readFile(file);
  } catch (e) {
    const reason = (e as { decision?: { reason?: unknown } }).decision?.reason;
    if (reason === 'not-found') return null;
    throw e;
  }
}

export class Store {
  readonly db: Db;
  readonly snippets: Snippets;
  readonly #journal: Journal;
  readonly #clock: Pick<Clock, 'nowMono' | 'nowWall'>;
  #broken: string | null = null;
  #metricFailures = 0;

  constructor(db: Db, journal: Journal, snippets: Snippets, clock: Pick<Clock, 'nowMono' | 'nowWall'>) {
    this.db = db;
    this.#journal = journal;
    this.snippets = snippets;
    this.#clock = clock;
    Object.freeze(this);
  }

  /** The last committed line. */
  get tail(): Tail {
    return this.#journal.tail;
  }

  /** False once an append failed or a committed batch could not be applied: restart to recover. */
  get usable(): boolean {
    return this.#broken === null && this.#journal.usable;
  }

  /** How many commitDoneMono rows could not be written (side table, best effort). */
  get metricFailures(): number {
    return this.#metricFailures;
  }

  /** Commits one batch: applied in a transaction, appended with one fsync, then the transaction commits. Returns its lines. */
  commit(records: readonly Rec[]): readonly Line[] {
    return this.#commit(this.#journal.prepare(records), true);
  }

  /** The batch that records a cut tail; once, at startup. */
  commitRecovered(bytesCut: number): readonly Line[] {
    return this.#commit(this.#journal.prepareRecovered(bytesCut), false);
  }

  #commit(p: ReturnType<Journal['prepare']>, checkDup: boolean): readonly Line[] {
    if (this.#broken !== null) throw new StoreError('unusable', `${this.#broken}; restart to recover`);
    let written = false;
    try {
      this.db.transaction(() => {
        if (checkDup) this.#refuseDuplicateActions(p.lines);
        applyBatchIn(this.db, p.lines);
        this.#journal.write(p);
        written = true;
      });
    } catch (e) {
      if (!written) throw e;
      const last = p.lines.at(-1)!;
      this.#broken = 'db-behind-journal';
      throw new StoreError('committed-not-applied', `batch up to jseq ${last.jseq} is in the journal, the database did not take it (${e instanceof Error ? e.message : String(e)})`, last.jseq);
    }
    this.#commitDone(p.lines);
    return p.lines;
  }

  /** A `human` or `human.result` whose actionId the database already holds of that kind: the action is in the journal already. */
  #refuseDuplicateActions(lines: readonly Line[]): void {
    for (const l of lines) {
      if (l.kind !== 'human' && l.kind !== 'human.result') continue;
      if (this.db.get('SELECT jseq FROM event WHERE kind = ? AND action_id = ?', l.kind, String(l.body.actionId)) !== undefined) {
        throw new StoreError('duplicate-action', `a ${l.kind} of this actionId is in the journal already`);
      }
    }
  }

  /** commitDoneMono by jseq, for the latency report's "our commit" stretch only (step 18A); a side table, best effort. */
  #commitDone(lines: readonly Line[]): void {
    const last = lines.at(-1)!;
    try {
      this.db.run('INSERT INTO metric (name, jseq, value, obs_mono, boot_id) VALUES (?, ?, ?, ?, ?)', 'commitDoneMono', last.jseq, this.#clock.nowMono(), last.obsMono, last.bootId);
    } catch {
      this.#metricFailures++;
    }
  }

  /**
   * The seq of the next timer of `cls` for `entityId`: how many clock records of that class and entity
   * the journal holds (so a timerId names one firing, and a restart arms the same seq it would have).
   * A timer cancelled or replaced before it fired wrote no record, so its seq is armed again.
   */
  nextTimerSeq(cls: TimerClass, entityId: string): number {
    const prefix = timerId(cls, entityId, 0).slice(0, -1);
    return Number(this.db.get("SELECT count(*) AS n FROM event WHERE kind = 'clock' AND substr(timer_id, 1, ?) = ?", prefix.length, prefix)!.n);
  }

  /** Every `human` without a `human.result`, oldest first. */
  orphanActions(): string[] {
    return this.#orphans().map((o) => o.actionId);
  }

  #orphans(): { actionId: string; verb: string; targetId: string | null }[] {
    return this.db.all("SELECT h.action_id AS a, h.body AS body FROM event h WHERE h.kind = 'human' AND NOT EXISTS (SELECT 1 FROM event r WHERE r.kind = 'human.result' AND r.action_id = h.action_id) ORDER BY h.jseq")
      .map((r) => {
        const b = parseCanonical(String(r.body)) as { verb: string; targetId: string | null };
        return { actionId: String(r.a), verb: b.verb, targetId: b.targetId };
      });
  }

  /** Closes every orphan `human` with outcome unknown (UI design 一 5), its verb and target repeated; returns how many. */
  closeOrphans(): number {
    const orphans = this.#orphans();
    for (let i = 0; i < orphans.length; i += MAX_BATCH - 1) {
      this.commit(orphans.slice(i, i + MAX_BATCH - 1).map((o) => ({
        kind: 'human.result', body: { actionId: o.actionId, verb: o.verb, targetId: o.targetId, outcome: 'unknown', commandId: null, subtrees: null },
      })));
    }
    return orphans.length;
  }

  close(): void {
    this.db.close();
  }
}
frozenClass(Store);

/** Is the database's applied_jseq a commit line the journal holds, with the same hash? */
function dbFollows(scan: Committed, applied: { jseq: number; hash: string }): ChainBreak | null {
  if (applied.jseq === 0) return null;
  if (applied.jseq > scan.tail.jseq) {
    return { reason: 'journal-chain', line: scan.tail.jseq + 1, why: 'db-ahead', detail: `the database holds up to jseq ${applied.jseq}, the journal's committed part ends at ${scan.tail.jseq}` };
  }
  for (const b of scan.batches) {
    const c = b.at(-1)!;
    if (c.jseq === applied.jseq) return c.hash === applied.hash ? null : { reason: 'journal-chain', line: c.jseq, why: 'db-mismatch', detail: 'the line the database holds has another hash in the journal' };
    if (c.jseq > applied.jseq) break;
  }
  return { reason: 'journal-chain', line: applied.jseq, why: 'db-mismatch', detail: 'the database holds a jseq that ends no batch of the journal' };
}

type CutMarker = { committedBytes: number; cutBytes: number; tail: Tail };

/** The pending-cut marker, null when there is none, or 'bad' when it is not one this store wrote. */
function readCutMarker(reader: StoreReader, file: string): CutMarker | null | 'bad' {
  const bytes = readOrNull(reader, file);
  if (bytes === null) return null;
  try {
    const v = parseCanonical(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(',');
    if (keys !== 'committedBytes,cutBytes,tailHash,tailJseq,v' || v.v !== 1) return 'bad';
    const n = (x: unknown, min: number) => Number.isSafeInteger(x) && (x as number) >= min;
    if (!n(v.committedBytes, 0) || !n(v.cutBytes, 1) || !n(v.tailJseq, 0) || typeof v.tailHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tailHash)) return 'bad';
    return { committedBytes: v.committedBytes as number, cutBytes: v.cutBytes as number, tail: { jseq: v.tailJseq as number, hash: v.tailHash } };
  } catch {
    return 'bad';
  }
}

/** Did the recovered batch of `m` commit right after its tail? Then only the marker's removal was lost. */
function recoveredAfter(scan: Committed, m: CutMarker): boolean {
  const b = scan.batches.find((x) => x[0]!.jseq === m.tail.jseq + 1);
  return b !== undefined && b[0]!.kind === 'recovered' && b[0]!.prevHash === m.tail.hash && b[0]!.body.bytesCut === m.cutBytes;
}

/** Opens and reconciles the store. Throws a typed error for anything but a chain break (a refused path, a failed migration, a failed apply). */
export function openStore(deps: StoreDeps): StoreOpen {
  const file = journalPath(deps.home);
  const markerFile = cutMarkerPath(deps.home);
  const db = deps.openDb(dbPath(deps.home));
  let ok = false;
  try {
    const bytes = readOrNull(deps.reader, file) ?? new Uint8Array(0);
    const scanned = scanJournal(bytes);
    const applied = appliedTail(db);
    let scan: Committed & { cutBytes: number };
    if (scanned.ok) {
      scan = scanned;
    } else if (scanned.tornFinal !== undefined && applied.jseq <= scanned.tornFinal.tail.jseq) {
      // A bad line in the final batch, which the database never applied: an unacknowledged write.
      scan = { ...scanned.tornFinal, cutBytes: bytes.length - scanned.tornFinal.committedBytes };
    } else {
      return { ok: false, reason: 'journal-chain', break: scanned.break };
    }
    const behind = dbFollows(scan, applied);
    if (behind !== null) return { ok: false, reason: 'journal-chain', break: behind };
    const marker = readCutMarker(deps.reader, markerFile);
    let pendingCut: number | null = null;
    let removeMarker = false;
    if (marker !== null) {
      if (marker !== 'bad' && scan.committedBytes === marker.committedBytes && scan.tail.jseq === marker.tail.jseq && scan.tail.hash === marker.tail.hash) {
        pendingCut = marker.cutBytes;
      } else if (marker !== 'bad' && recoveredAfter(scan, marker)) {
        removeMarker = true;
      } else {
        return { ok: false, reason: 'journal-chain', break: { reason: 'journal-chain', line: scan.tail.jseq + 1, why: 'cut-marker', detail: 'journal.cut names a cut this journal does not show' } };
      }
    }
    if (pendingCut === null && scan.cutBytes > 0) {
      pendingCut = scan.cutBytes;
      deps.writer.writeAtomic(markerFile, canonicalJson({ v: 1, committedBytes: scan.committedBytes, cutBytes: scan.cutBytes, tailJseq: scan.tail.jseq, tailHash: scan.tail.hash }));
    }
    // The uncommitted tail goes first: nothing may be appended after half a line.
    if (scan.cutBytes > 0) deps.writer.shorten(file, scan.committedBytes);
    const journal = new Journal({ file, writer: deps.writer, bootId: deps.bootId, clock: deps.clock, redactor: deps.redactor, tail: scan.tail });
    const store = new Store(db, journal, new Snippets({ db, redactor: deps.redactor, clock: deps.clock }), deps.clock);
    let appliedBatches = 0;
    for (const b of scan.batches) {
      if (b.at(-1)!.jseq <= applied.jseq) continue;
      applyBatch(db, b);
      appliedBatches++;
    }
    if (pendingCut !== null) {
      store.commitRecovered(pendingCut);
      removeMarker = true;
    }
    if (removeMarker) deps.writer.rm(markerFile);
    const orphansClosed = store.closeOrphans();
    store.snippets.expire();
    ok = true;
    return { ok: true, store, report: { cutBytes: pendingCut ?? 0, appliedBatches, orphansClosed } };
  } finally {
    if (!ok) db.close();
  }
}
