import * as crypto from 'node:crypto';
import type { Clock } from '../runtime/clock.ts';
import type { Db } from './db.ts';
import type { Rec } from './journal.ts';
import type { RedactInput, Redactor } from './redact.ts';
import { ID_RE } from '../../shared/protocol.js';
import { SNIPPET_MAX_BYTES, SNIPPET_TTL_MS } from '../../shared/constants.js';
import { REDACT_VERSION } from './redact.ts';
import { frozenClass } from '../../shared/frozen.js';

// The snippet table (plan step 3, r4 §6.1 #2): source text, redacted, at most SNIPPET_MAX_BYTES each,
// kept SNIPPET_TTL_MS. A side table: the journal holds only a snippet's digest and its snippetRef, so
// purging a text never breaks the chain, and a rebuild from the journal does not bring texts back (a
// reminder then shows its text as lost and still fires on time, test/store/rebuild.test.ts).
//
// Expiry and "purge secrets" write tombstones: the row stays with its digest and loses its text.
// A reminder's text is pinned while the reminder is pending (not yet fired or cancelled): neither the
// TTL nor a purge touches it. The pin is not stored, it is read from the reminder table, so it ends
// with the reminder's own transition, in the same transaction, with nothing to forget.
//
// The TTL holds on every read: get() never hands out an unpinned text past its expiry, it tombstones
// it there and then, whether or not a sweep (expire(), run at every start) came first. A cleared text
// leaves no copy on disk: the writer runs with secure_delete (db.ts), and every purge or expiry that
// cleared something ends with a checkpoint that copies the zeroed pages back and empties the -wal.
//
// Content digests are HMAC-SHA256 under the install's key (0001's install_key, a side table, made on
// the first put): the judgment's inputDigest and a tombstone's digest outlive the text (the journal is
// never purged), and an unkeyed digest of a short or guessable text would let anyone holding the
// journal confirm a guess offline. Losing the database loses the key; nothing ever recomputes an old
// digest, so that loses nothing.
//
// TTL is a calendar span that outlives a boot, so it runs on the wall clock (invariant 20 keeps
// durations on obsMono within one boot; a 14-day lifetime across restarts cannot be one).

export type TextState = 'present' | 'expired' | 'purged' | 'lost';

export type SnippetText = { textState: TextState; text: string | null };

export type PutResult = {
  ref: string;
  /** The judgment record of the redaction (plan step 3, 补2): which layers hit and how often, never the text. */
  judgment: Rec;
};

export class SnippetError extends Error {
  readonly code = 'ERR_ORCHESTRA_SNIPPET';
}
frozenClass(SnippetError);

/** The first `max` UTF-8 bytes of `text`, never splitting a code point. */
export function fitBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = max;
  // Back off over continuation bytes (10xxxxxx) to the start of the code point that does not fit.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export type SnippetsConfig = { db: Db; redactor: Redactor; clock: Pick<Clock, 'nowWall'> };

// The pin, in each statement below as fixed text: a reminder that has not fired or been cancelled
// holds its text (ref NOT IN the snippet_refs of reminders in none or pending).

export class Snippets {
  readonly #db: Db;
  readonly #redactor: Redactor;
  readonly #clock: Pick<Clock, 'nowWall'>;
  #rev = 0;

  constructor(config: SnippetsConfig) {
    const has = (k: keyof SnippetsConfig) => typeof config === 'object' && config !== null && Object.hasOwn(config, k);
    if (!has('db') || !has('redactor') || !has('clock')) throw new SnippetError('snippets: db, redactor and clock are required, there is no default');
    this.#db = config.db;
    this.#redactor = config.redactor;
    this.#clock = config.clock;
    if (typeof this.#clock.nowWall !== 'function' || typeof this.#redactor.redact !== 'function') throw new SnippetError('snippets: db, redactor and clock are required, there is no default');
    Object.freeze(this);
  }

  /** Counts purges and expiries that removed a text (status `snippetRev`; they make no jseq). */
  get rev(): number {
    return this.#rev;
  }

  /** HMAC-SHA256 of `text` under the install's key, made (32 random bytes) the first time one is needed. */
  digest(text: string): string {
    let row = this.#db.get('SELECT key FROM install_key WHERE id = 1');
    if (row === undefined) {
      this.#db.run('INSERT INTO install_key (id, key) VALUES (1, ?)', new Uint8Array(crypto.randomBytes(32)));
      row = this.#db.get('SELECT key FROM install_key WHERE id = 1')!;
    }
    return crypto.createHmac('sha256', row.key as Uint8Array).update(text, 'utf8').digest('hex');
  }

  /**
   * Redacts `input.text`, keeps at most SNIPPET_MAX_BYTES of it under `ref`, and returns the judgment
   * record for the caller's batch. Written before the batch that references it, so the journal never
   * points at a text that was never stored; an orphan text (the batch never committed) expires.
   */
  put(ref: string, input: RedactInput): PutResult {
    if (typeof ref !== 'string' || !ID_RE.test(ref)) throw new SnippetError('snippets: a ref is an id');
    const raw = typeof input === 'object' && input !== null && Object.hasOwn(input, 'text') ? input.text : undefined;
    if (typeof raw !== 'string') throw new SnippetError('snippets: text must be a string');
    const command = Object.hasOwn(input, 'command') ? input.command : undefined;
    // The redactor reads the copy, so the text it judged is the text the digest covers.
    const r = this.#redactor.redact(typeof command === 'string' ? { text: raw, command } : { text: raw });
    const text = fitBytes(r.text, SNIPPET_MAX_BYTES);
    const now = this.#clock.nowWall();
    this.#db.run('INSERT INTO snippet (ref, state, text, bytes, digest, created_wall, expires_wall) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ref, 'present', text, Buffer.byteLength(text, 'utf8'), this.digest(text), now, now + SNIPPET_TTL_MS);
    return {
      ref,
      judgment: { kind: 'judgment', body: { name: 'redact', inputDigest: this.digest(raw), ver: REDACT_VERSION, value: { ...r.verdict, format: { ...r.verdict.format } } } },
    };
  }

  /**
   * The text under `ref` and what became of it; `lost` when the table has no row (a rebuilt database).
   * An unpinned text past its TTL is tombstoned here and reads `expired`, sweep or no sweep.
   */
  get(ref: string): SnippetText {
    const key = String(ref);
    const row = this.#db.get('SELECT state, text, expires_wall FROM snippet WHERE ref = ?', key);
    if (row === undefined) return { textState: 'lost', text: null };
    const state = String(row.state) as TextState;
    if (state === 'present' && Number(row.expires_wall) <= this.#clock.nowWall()) {
      const now = this.#clock.nowWall();
      if (this.#db.run("UPDATE snippet SET state = 'expired', text = NULL, cleared_wall = ? WHERE ref = ? AND state = 'present' AND ref NOT IN (SELECT snippet_ref FROM reminder WHERE state IN ('none', 'pending') AND snippet_ref IS NOT NULL)", now, key).changes > 0) {
        this.#cleared();
        return { textState: 'expired', text: null };
      }
    }
    return { textState: state, text: state === 'present' ? String(row.text) : null };
  }

  /** Tombstones every unpinned text past its TTL; returns how many. */
  expire(): number {
    const now = this.#clock.nowWall();
    const n = this.#db.run("UPDATE snippet SET state = 'expired', text = NULL, cleared_wall = ? WHERE state = 'present' AND expires_wall <= ? AND ref NOT IN (SELECT snippet_ref FROM reminder WHERE state IN ('none', 'pending') AND snippet_ref IS NOT NULL)", now, now).changes;
    if (n > 0) this.#cleared();
    return n;
  }

  /** "Purge secrets": tombstones every unpinned text; returns how many. */
  purge(): number {
    const n = this.#db.run("UPDATE snippet SET state = 'purged', text = NULL, cleared_wall = ? WHERE state = 'present' AND ref NOT IN (SELECT snippet_ref FROM reminder WHERE state IN ('none', 'pending') AND snippet_ref IS NOT NULL)", this.#clock.nowWall()).changes;
    if (n > 0) this.#cleared();
    return n;
  }

  /** A text was cleared: count it, and checkpoint so the -wal keeps no image of the page that held it. */
  #cleared(): void {
    this.#rev++;
    this.#db.checkpoint();
  }
}
frozenClass(Snippets);
