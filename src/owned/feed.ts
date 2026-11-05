import { frozen, frozenClass } from '../../shared/frozen.js';

// An owned session's feed (alpha 0.2 slice design §2.4, §2.8): the recent events in memory, each with a
// rising seq, for GET /api/owned/:id/feed?after=<seq>. At most 500 events or 256 KiB; past either, the
// oldest go and a reader that asks from before them is told `clipped`.
//
// A live event (a message still streaming, a command's output so far, the token count) is replaced, not
// added: an update takes out the earlier live event of the same key and appends itself with a new seq,
// so a reader polling after=<seq> sees the newest and replaces its copy by `ref`. Replaced events are
// not "clipped": they were superseded, not lost.
//
// No state here says "done" (D19: done is a verdict, no agent declares it): a turn's end is turn-ended.

export const FEED_LIMITS = frozen({ events: 500, bytes: 256 * 1024 });

export const FEED_KINDS = frozen(['you', 'text', 'tool', 'tool-result', 'ask', 'answer', 'auto-denied', 'lifecycle', 'result', 'note'] as const);
export type FeedKind = (typeof FEED_KINDS)[number];

export type FeedTokens = { input: number; cachedInput: number; output: number; total: number };

export type FeedEvent = {
  readonly seq: number;
  /** The wall clock when the event was made (Clock.nowWall). */
  readonly at: number;
  readonly kind: FeedKind;
  /** The codex item, turn or approval the event belongs to; null when none. */
  readonly ref: string | null;
  /** For `you`: the uuid the human action was recorded under. */
  readonly uuid: string | null;
  /** Redacted, invisible characters escaped, at most 2 KB of UTF-8. */
  readonly text: string | null;
  readonly state: string | null;
  /** Suspected secrets replaced in `text`. */
  readonly redactions: number;
  /** A live event a later one of the same key replaces. */
  readonly live: boolean;
  readonly exitCode?: number | null;
  readonly tokens?: FeedTokens;
  /** On a dispatch note: the batch of the sub-agent its ref names, the same on the spawns of one dispatch. */
  readonly batch?: number;
};

export type FeedInput = Omit<FeedEvent, 'seq' | 'at' | 'live' | 'uuid' | 'redactions'> & { uuid?: string | null; redactions?: number };

export type FeedPage = { from: number; to: number; clipped: boolean; events: readonly FeedEvent[] };

const sizeOf = (e: FeedEvent) => 96 + (e.text === null ? 0 : Buffer.byteLength(e.text, 'utf8'));

export class Feed {
  readonly #events: FeedEvent[] = [];
  /** live key -> seq of its event in #events. */
  readonly #live = new Map<string, number>();
  readonly #now: () => number;
  #seq = 0;
  #bytes = 0;
  /** The highest seq dropped for room (not for being replaced). */
  #lostThrough = 0;
  #lastAt: number | null = null;

  constructor(now: () => number) {
    this.#now = now;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /** The wall time of the newest event made, live ones included; null before any. */
  get lastAt(): number | null {
    return this.#lastAt;
  }

  /** Appends an event. */
  push(input: FeedInput): FeedEvent {
    return this.#append(input, false);
  }

  /** Replaces the live event of `key` (if any) with this one. */
  upsert(key: string, input: FeedInput): FeedEvent {
    this.settle(key);
    const e = this.#append(input, true);
    this.#live.set(key, e.seq);
    return e;
  }

  /** Takes out the live event of `key`, if it is still there. */
  settle(key: string): void {
    const seq = this.#live.get(key);
    if (seq === undefined) return;
    this.#live.delete(key);
    const i = this.#events.findIndex((e) => e.seq === seq);
    if (i < 0) return;
    this.#bytes -= sizeOf(this.#events[i]!);
    this.#events.splice(i, 1);
  }

  /**
   * Takes out the event of `seq` so the same thing can be told again later with a new seq (a command
   * whose approval comes after its start moves below the approval). Not clipped: it was moved, not lost.
   * A reader that already holds it gets the later copy under the same kind and ref.
   */
  withdraw(seq: number): boolean {
    const i = this.#events.findIndex((e) => e.seq === seq);
    if (i < 0) return false;
    const e = this.#events[i]!;
    for (const [k, s] of this.#live) if (s === seq) this.#live.delete(k);
    this.#bytes -= sizeOf(e);
    this.#events.splice(i, 1);
    return true;
  }

  /** The newest event that `pred` takes, live ones included; null when none. */
  last(pred: (e: FeedEvent) => boolean): FeedEvent | null {
    for (let i = this.#events.length - 1; i >= 0; i--) if (pred(this.#events[i]!)) return this.#events[i]!;
    return null;
  }

  /** The events after `after`, oldest first. */
  since(after: number): FeedPage {
    const events = this.#events.filter((e) => e.seq > after);
    return { from: after, to: this.#seq, clipped: after < this.#lostThrough, events };
  }

  #append(input: FeedInput, live: boolean): FeedEvent {
    const e: FeedEvent = Object.freeze({
      ...input,
      seq: ++this.#seq,
      at: this.#now(),
      uuid: input.uuid ?? null,
      redactions: input.redactions ?? 0,
      live,
    });
    this.#events.push(e);
    this.#lastAt = e.at;
    this.#bytes += sizeOf(e);
    while (this.#events.length > FEED_LIMITS.events || (this.#bytes > FEED_LIMITS.bytes && this.#events.length > 1)) {
      const old = this.#events.shift()!;
      this.#bytes -= sizeOf(old);
      this.#lostThrough = Math.max(this.#lostThrough, old.seq);
      for (const [k, s] of this.#live) if (s === old.seq) this.#live.delete(k);
    }
    return e;
  }
}
frozenClass(Feed);
