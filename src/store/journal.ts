import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Clock } from '../runtime/clock.ts';
import type { Kind } from './records.ts';
import type { Redactor } from './redact.ts';
import { UUID_RE } from '../../shared/protocol.js';
import { canonicalDigest, canonicalJson, parseCanonical } from './canonical-json.ts';
import { checkBody, isKind, JOURNAL_KINDS, MAX_BATCH } from './records.ts';
import { frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// The journal, orchestrad's one authoritative log (plan step 3, 补1; r4 D3, §6.1 #2). One line per
// record, each the canonical JSON of
//
//   {jseq, bootId, obsMono, obsWall, kind, body, digest, prevHash, hash}
//
// with digest = sha256(canonical(body)) and hash = sha256(prevHash || digest), over the two digests as
// 64-digit lowercase hex: the chain covers the digests only (plan step 3, r4 D3). jseq counts from 1
// with no gap, so it is bound by its place in the chain; the first prevHash is GENESIS. obsMono
// compares only within one boot, so the line carries bootId.
//
// Records are appended in batches, and every batch ends with a `commit` record whose body is the
// number of records before it and the batch's stamps: the bootId, obsMono and obsWall read once
// before the append, which every line of the batch carries. A batch is committed when its commit line
// is on disk. The stamps sit in the commit body so that the chain, which covers only digests, binds
// them too: the scan holds every line of a batch to its commit's stamps, so rewriting a line's obsWall
// or bootId (which apply turns into committedAt, ended_wall, notifiedAt's boot) is a break, not a
// silently different rebuild. A line's kind is bound by its body (no two kinds share a key set).
//
// One write and one fsync per batch; the one db transaction that applies it and records applied_jseq
// commits after that fsync (store.ts opens it before the write, so a batch apply would refuse never
// reaches the file); then the external effects (I02, P5: the marker after the effect).
//
// Every record is snapshotted once before any check: its kind and body are read as own data
// properties, the body is encoded canonically and parsed back, and the schema, the redaction check,
// the digest and the line text are all taken from that fresh copy, which nobody else holds. A body
// that reads one way for the check and another for the write (a Proxy, a getter) never gets a source
// string the redactor would change into the file.
//
// The startup scan verifies every line. Whatever follows the last commit line (half a line, or whole
// lines of a batch whose commit never reached the disk) was never committed: the store cuts it off
// through the write fence and appends a `recovered` record with the bytes cut, so the file holds only
// committed batches and the verifier needs no rule to skip a line. A complete line before the last
// commit that fails any check is a break: the scan returns the typed result journal-chain. One shape
// of power loss is told apart: a bad line inside the final batch, whose commit line is the last bytes
// of the file, and whose bytes are garbled (not UTF-8 or not canonical JSON: a later sector of an
// unacknowledged write reached the disk, an earlier one did not). The scan reports it as tornFinal
// beside the break, and the store cuts it only when the database
// never applied that batch (store.ts). What stays residual there: bit rot inside a final batch that
// was acknowledged, followed by a power loss that also rolled the database back past it (synchronous
// NORMAL), is cut and recorded as recovered instead of stopping the start.

/** prevHash of the first line. */
export const GENESIS = '0'.repeat(64);

/** Where the journal lives under ORCHESTRA_HOME. */
export function journalPath(home: string): string {
  return win.join(home, 'journal.jsonl');
}

export type Line = {
  readonly jseq: number;
  readonly bootId: string;
  readonly obsMono: number;
  readonly obsWall: number;
  readonly kind: Kind;
  readonly body: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly prevHash: string;
  readonly hash: string;
};

/** A record before it is a line: what callers hand to prepare() (through Store.commit). */
export type Rec = { kind: Kind; body: Record<string, unknown> };

/** A batch built by prepare(), not yet written: its lines, their text, and the tails before and after. */
export type Prepared = { readonly after: Tail; readonly lines: readonly Line[]; readonly text: string; readonly tail: Tail };

const LINE_KEYS = ['body', 'bootId', 'digest', 'hash', 'jseq', 'kind', 'obsMono', 'obsWall', 'prevHash'];

export function chainHash(prevHash: string, digest: string): string {
  return crypto.createHash('sha256').update(`${prevHash}${digest}`, 'utf8').digest('hex');
}

export type ChainWhy =
  | 'not-utf8'
  | 'not-canonical'
  | 'shape'
  | 'jseq'
  | 'boot-id'
  | 'obs'
  | 'kind'
  | 'body'
  | 'digest'
  | 'prev-hash'
  | 'hash'
  | 'commit'
  | 'stamp'
  | 'recovered-misplaced'
  | 'cut-marker'
  | 'db-ahead'
  | 'db-mismatch';

/** A complete line that fails a check: `line` counts from 1, `why` is typed, `detail` names no source text. */
export type ChainBreak = { reason: 'journal-chain'; line: number; why: ChainWhy; detail: string };

export type Tail = { readonly jseq: number; readonly hash: string };

/** What a scan found good: the committed batches, in order (each ends with its commit line), and where they end. */
export type Committed = { batches: Line[][]; committedBytes: number; tail: Tail };

export type Scan =
  | (Committed & {
    ok: true;
    /** Bytes after the committed part; all of them are cut. */
    cutBytes: number;
  })
  | {
    ok: false;
    break: ChainBreak;
    /** Present when the bad line lies in the final batch, whose commit line ends the file: the part before that batch. */
    tornFinal?: Committed;
  };

const fatalUtf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Verifies `bytes` line by line. Pure: the same bytes give the same result. Checks every line up to
 * the last commit line; lines after it are the uncommitted tail, returned as cutBytes.
 */
export function scanJournal(bytes: Uint8Array): Scan {
  const brk = (line: number, why: ChainWhy, detail: string): Scan => ({ ok: false, break: { reason: 'journal-chain', line, why, detail } });
  const batches: Line[][] = [];
  let open: Line[] = [];
  let prev: Tail = { jseq: 0, hash: GENESIS };
  let committedBytes = 0;
  let start = 0;
  const complete = bytes.lastIndexOf(0x0a) + 1;
  for (let n = 1; start < complete; n++) {
    const nl = bytes.indexOf(0x0a, start);
    const end = nl + 1;
    let parsed: Parsed;
    try {
      parsed = parseLine(fatalUtf8().decode(bytes.subarray(start, nl)), prev);
    } catch {
      parsed = { ok: false, why: 'not-utf8', detail: 'the line is not UTF-8' };
    }
    if (!parsed.ok) {
      // A bad line with no commit line after it belongs to the uncommitted tail; before one, it is a break.
      const commitAt = laterCommit(bytes, end, complete);
      if (commitAt < 0) break;
      const b = brk(n, parsed.why, parsed.detail);
      // Only garbled bytes (what an unwritten sector holds) qualify: a line that parses but fails a check was written as it is.
      if ((parsed.why === 'not-utf8' || parsed.why === 'not-canonical') && finalBatchEndsAt(bytes, committedBytes, commitAt) && !b.ok) {
        const last = batches.at(-1)?.at(-1);
        b.tornFinal = { batches, committedBytes, tail: last === undefined ? { jseq: 0, hash: GENESIS } : { jseq: last.jseq, hash: last.hash } };
      }
      return b;
    }
    const line = parsed.line;
    if (line.kind === 'recovered' && open.length > 0) return brk(n, 'recovered-misplaced', 'recovered opens its own batch');
    if (line.kind === 'commit') {
      if (line.body.count !== open.length) return brk(n, 'commit', `commit counts ${String(line.body.count)}, the batch has ${open.length}`);
      const b = line.body;
      for (const l of [...open, line]) {
        if (l.bootId !== b.bootId || l.obsMono !== b.obsMono || l.obsWall !== b.obsWall) return brk(l.jseq, 'stamp', 'a line of the batch carries other stamps than its commit');
      }
      batches.push([...open, line]);
      open = [];
      committedBytes = end;
    } else {
      if (open.length >= MAX_BATCH) return brk(n, 'commit', `a batch longer than ${MAX_BATCH}`);
      open.push(line);
    }
    prev = { jseq: line.jseq, hash: line.hash };
    start = end;
  }
  const last = batches.at(-1)?.at(-1);
  return { ok: true, batches, committedBytes, cutBytes: bytes.length - committedBytes, tail: last === undefined ? { jseq: 0, hash: GENESIS } : { jseq: last.jseq, hash: last.hash } };
}

/**
 * Where a complete line from `from` up to `end` first carries the text of a commit record, or -1.
 * Over-inclusive on purpose (any line holding the text counts), so a doubtful bad line is a break,
 * never a quiet cut.
 */
function laterCommit(bytes: Uint8Array, from: number, end: number): number {
  const at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf('"kind":"commit"', from, 'utf8');
  return at >= 0 && at < end ? at : -1;
}

/**
 * Is the first commit text after a bad line (at `commitAt`) on the last line of the file, ending with
 * the file's last byte, with at most a batch's worth of lines since the last good commit? Then the bad
 * line lies in the final batch and nothing was written after it: the shape a power loss leaves when a
 * later sector of the batch reached the disk and an earlier one did not.
 */
function finalBatchEndsAt(bytes: Uint8Array, batchStart: number, commitAt: number): boolean {
  const nl = bytes.indexOf(0x0a, commitAt);
  if (nl < 0 || nl + 1 !== bytes.length) return false;
  let lines = 0;
  for (let i = batchStart; i < bytes.length; i++) if (bytes[i] === 0x0a) lines++;
  return lines <= MAX_BATCH;
}

type Parsed = { ok: true; line: Line } | { ok: false; why: ChainWhy; detail: string };

/** One line against the chain so far: canonical text, the nine keys, jseq, bootId, clocks, kind, body, digest, prevHash, hash. */
export function parseLine(text: string, prev: Tail): Parsed {
  let v: unknown;
  try {
    v = parseCanonical(text);
  } catch {
    return { ok: false, why: 'not-canonical', detail: 'the line is not canonical JSON' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, why: 'shape', detail: 'not an object' };
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== LINE_KEYS.length || keys.some((k, i) => k !== LINE_KEYS[i])) return { ok: false, why: 'shape', detail: 'not the nine keys of a line' };
  if (o.jseq !== prev.jseq + 1) return { ok: false, why: 'jseq', detail: `jseq ${String(o.jseq)} after ${prev.jseq}` };
  if (typeof o.bootId !== 'string' || !UUID_RE.test(o.bootId)) return { ok: false, why: 'boot-id', detail: 'bootId is no UUID' };
  for (const k of ['obsMono', 'obsWall'] as const) {
    if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 0) return { ok: false, why: 'obs', detail: `${k} is no non-negative integer` };
  }
  if (!isKind(o.kind)) return { ok: false, why: 'kind', detail: 'unknown kind' };
  const bodyErr = checkBody(o.kind, o.body, null);
  if (bodyErr !== null) return { ok: false, why: 'body', detail: `${o.kind} ${bodyErr.reason} at ${bodyErr.at}` };
  // A plan's monotonic reading is one of its own boot, taken before its batch was stamped.
  if (o.kind === 'brake.plan' && ((o.body as { createdMono: number }).createdMono > (o.obsMono as number))) return { ok: false, why: 'body', detail: 'brake.plan createdMono is after its line' };
  if (o.digest !== canonicalDigest(o.body)) return { ok: false, why: 'digest', detail: 'digest is not sha256 of the canonical body' };
  if (o.prevHash !== prev.hash) return { ok: false, why: 'prev-hash', detail: 'prevHash is not the hash of the line before' };
  if (o.hash !== chainHash(prev.hash, o.digest as string)) return { ok: false, why: 'hash', detail: 'hash is not sha256(prevHash || digest)' };
  return { ok: true, line: deepFreeze(o) as unknown as Line };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/** What the journal writes through: the write fence's append (with one fsync) and nothing else. */
export type JournalWriter = { append(target: string, data: string | Uint8Array, opts?: { fsync?: boolean }): void };

export type JournalConfig = {
  file: string;
  writer: JournalWriter;
  bootId: string;
  /** Read once per batch: the obsMono/obsWall every line of it carries. */
  clock: Pick<Clock, 'nowMono' | 'nowWall'>;
  /** Every source string of an appended body must come out of it unchanged. */
  redactor: Redactor;
  /** The last committed line, from the startup scan. */
  tail: Tail;
};

export type JournalErrorReason = 'bad-record' | 'journal-kind' | 'batch-size' | 'append-failed' | 'unusable';

/** A record read once: its kind and body as own data properties, the body a fresh canonical copy. */
type Snap = { readonly kind: Kind; readonly body: Readonly<Record<string, unknown>>; readonly text: string };

/** The value of an own data property of `o`, or undefined (an accessor or an inherited field counts as missing; its getter never runs). */
function dataValue(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

export class JournalError extends Error {
  readonly code = 'ERR_ORCHESTRA_JOURNAL';
  readonly reason: JournalErrorReason;
  readonly at: number;
  constructor(reason: JournalErrorReason, detail: string, at = -1) {
    super(`[ERR_ORCHESTRA_JOURNAL] ${reason}: ${detail}`);
    this.reason = reason;
    this.at = at;
  }
}
frozenClass(JournalError);

const CONFIG_KEYS = ['file', 'writer', 'bootId', 'clock', 'redactor', 'tail'] as const;

/**
 * Appends batches. Nothing has a default: the writer (the fence), the clock and the redactor are
 * handed in. A failed append leaves the file in a state only the next startup scan can judge, so the
 * journal refuses every later append (fail closed; the store stops working, the restart recovers).
 */
export class Journal {
  readonly file: string;
  readonly bootId: string;
  readonly #writer: JournalWriter;
  readonly #clock: Pick<Clock, 'nowMono' | 'nowWall'>;
  readonly #redactor: Redactor;
  #tail: Tail;
  #usable = true;

  constructor(config: JournalConfig) {
    const c = ownCopy(config);
    this.file = c.file;
    this.bootId = c.bootId;
    this.#writer = c.writer;
    this.#clock = c.clock;
    this.#redactor = c.redactor;
    this.#tail = c.tail;
    Object.freeze(this);
  }

  get tail(): Tail {
    return this.#tail;
  }

  get usable(): boolean {
    return this.#usable;
  }

  /** The record of a cut tail, as a batch of its own (the store writes it once, at startup). */
  prepareRecovered(bytesCut: number): Prepared {
    return this.#prepare([snapshot({ kind: 'recovered', body: { bytesCut } }, 0)]);
  }

  /**
   * Snapshots every record, checks each copy (its schema and, for source strings, the redactor) and
   * builds the batch's lines after the current tail, without writing anything. The kinds a caller may
   * hand in are every kind but commit and recovered, which only the journal writes. The store applies
   * the lines in an open transaction first, so a batch apply would refuse never reaches the journal;
   * then write() appends them. There is no append(): Store.commit is the one path to the file.
   */
  prepare(records: readonly Rec[]): Prepared {
    if (!Array.isArray(records) || records.length === 0 || records.length >= MAX_BATCH) throw new JournalError('batch-size', `a batch holds 1 to ${MAX_BATCH - 1} records`);
    const snaps = records.map((r, i) => snapshot(r, i));
    for (const s of snaps) if (JOURNAL_KINDS.includes(s.kind)) throw new JournalError('journal-kind', `${s.kind} is written by the journal itself`);
    return this.#prepare(snaps);
  }

  #prepare(records: readonly Snap[]): Prepared {
    const obsMono = this.#clock.nowMono();
    const obsWall = this.#clock.nowWall();
    const lines: Line[] = [];
    const texts: string[] = [];
    const after = this.#tail;
    let prev = after;
    const all: Snap[] = [...records, snapshot({ kind: 'commit', body: { count: records.length, bootId: this.bootId, obsMono, obsWall } }, records.length)];
    all.forEach((r, i) => {
      const err = checkBody(r.kind, r.body, this.#redactor);
      if (err !== null) throw new JournalError('bad-record', `${r.kind} ${err.reason} at ${err.at}`, i);
      const digest = crypto.createHash('sha256').update(r.text, 'utf8').digest('hex');
      const hash = chainHash(prev.hash, digest);
      const text = canonicalJson({ jseq: prev.jseq + 1, bootId: this.bootId, obsMono, obsWall, kind: r.kind, body: r.body, digest, prevHash: prev.hash, hash });
      // What apply sees is what the disk will hold: the line read back from its own text.
      const parsed = parseLine(text, prev);
      if (!parsed.ok) throw new JournalError('bad-record', `${r.kind}: ${parsed.why}`, i);
      lines.push(parsed.line);
      texts.push(`${text}\n`);
      prev = { jseq: parsed.line.jseq, hash: parsed.line.hash };
    });
    return Object.freeze({ after, lines: Object.freeze(lines) as Line[], text: texts.join(''), tail: prev });
  }

  /** Appends a prepared batch with one fsync. Refused unless it was prepared after the current tail. */
  write(p: Prepared): void {
    if (!this.#usable) throw new JournalError('unusable', 'an earlier append failed; restart to recover');
    if (p.after.jseq !== this.#tail.jseq || p.after.hash !== this.#tail.hash) throw new JournalError('bad-record', 'the batch was prepared after another tail');
    try {
      this.#writer.append(this.file, p.text, { fsync: true });
    } catch (e) {
      this.#usable = false;
      throw new JournalError('append-failed', e instanceof Error ? e.message : String(e));
    }
    this.#tail = p.tail;
  }
}
frozenClass(Journal);

/**
 * Reads a caller's record once: kind and body as own data properties, the body encoded canonically
 * (accessors, class instances and every other value without one encoding are refused there) and parsed
 * back into a fresh frozen copy. Every later step reads the copy only.
 */
function snapshot(r: unknown, i: number): Snap {
  if (typeof r !== 'object' || r === null) throw new JournalError('bad-record', 'a record is { kind, body }', i);
  const kind = dataValue(r, 'kind');
  if (!isKind(kind)) throw new JournalError('bad-record', 'unknown kind', i);
  let text: string;
  let body: unknown;
  try {
    text = canonicalJson(dataValue(r, 'body'));
    body = parseCanonical(text);
  } catch (e) {
    throw new JournalError('bad-record', `${kind} body has no canonical form (${e instanceof Error ? e.message : String(e)})`, i);
  }
  return Object.freeze({ kind, body: deepFreeze(body) as Readonly<Record<string, unknown>>, text });
}

function ownCopy(config: JournalConfig): JournalConfig {
  const out = Object.create(null) as Partial<JournalConfig>;
  if (typeof config !== 'object' || config === null) throw new JournalError('bad-record', 'journal: a config is required');
  for (const k of CONFIG_KEYS) if (Object.hasOwn(config, k)) (out as Record<string, unknown>)[k] = config[k];
  if (typeof out.file !== 'string') throw new JournalError('bad-record', 'journal: file is required');
  if (typeof out.writer?.append !== 'function') throw new JournalError('bad-record', 'journal: writer is required, there is no default');
  if (typeof out.clock?.nowMono !== 'function' || typeof out.clock?.nowWall !== 'function') throw new JournalError('bad-record', 'journal: clock is required, there is no default');
  if (typeof out.redactor?.redact !== 'function') throw new JournalError('bad-record', 'journal: redactor is required, there is no default');
  if (typeof out.bootId !== 'string' || !UUID_RE.test(out.bootId)) throw new JournalError('bad-record', 'journal: bootId is a UUID');
  const t = out.tail;
  if (typeof t !== 'object' || t === null || !Number.isSafeInteger(t.jseq) || t.jseq < 0 || typeof t.hash !== 'string') throw new JournalError('bad-record', 'journal: tail is required');
  out.tail = Object.freeze({ jseq: t.jseq, hash: t.hash });
  return out as JournalConfig;
}
