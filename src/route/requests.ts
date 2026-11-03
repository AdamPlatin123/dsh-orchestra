import * as crypto from 'node:crypto';
import { frozen } from '../../shared/frozen.js';
import type { After } from '../net/magpie.ts';
import type { FeedEvent } from '../owned/feed.ts';
import type { Redact } from '../owned/text.ts';
import { headUtf8, shown, utf8Length } from '../owned/text.ts';
import type { RouteHarness } from './rules.ts';
import type { SuggestReply } from './desk.ts';

// The agent requests (seat, orchestrad side; final.md §5.1; r4 A17: an agent may only ask for a new
// musician, and what it makes is one entry a person decides on). A DSH session asks over the agent
// port (src/server/agent-port.ts) for one Codex or Claude run; the request waits here as a card on the
// paired page until the person dispatches it (POST /api/owned/new with its requestId) or rejects it
// (POST /api/agent-requests/:id/reject). Nobody answering is a refusal: a pending request expires after
// `ttlMs` (default 10 minutes, the composition root may set another), D8's "timeout = deny".
//
// The state machine (one way only):
//   pending ──you dispatch──▶ dispatched ──its first turn starts──▶ running ──that turn ends──▶ done
//      │                         │                                    │
//      ├─you reject─▶ rejected   ├─the session ends or the turn fails─┴─▶ failed
//      ├─time is up─▶ expired    └─the requester withdraws (dispatched or running)─▶ withdrawn
//      └─the requester withdraws─▶ withdrawn
// `done` is the requester's word for "the run it asked for came back": the end of one turn, never a
// verdict on the work (D19: no agent declares done; the page never says 完成, T2). What goes back is
// A16's thin completion: the state, the last agent message of that turn (redacted, at most
// OUTPUT_MAX_BYTES, `truncated` when anything was cut, `cuts` saying where) and why, never the transcript.
// Whether the requester fetched it is `fetched`: set only when the port's GET handed a done reply to the
// pipe (T1: until then the page says nobody knows whether it was taken).
//
// A withdraw ends an owned session only through `endOwned`, the same normal stop order as the person's
// POST /api/owned/:id/end (decision A of final.md §6.3: never the brake, which this module is not handed
// at all). A withdraw of a request already over changes nothing (DSH calls dispose() after a normal end
// too; seat step 0 finding 4). Only the submitter can withdraw: create() hands it a withdraw key (16
// random bytes) that nobody else is ever shown, and withdraw() compares it in constant time.
//
// Who asked is the requester's own word (kind dsh and a session id it chose, or none): nothing here or
// at the port checks it (final.md §6.3 B: no pipe-client-pid in this first slice), so the page says
// "自称" and "未核实". Limits are per requester too (at most `perRequester` pending), so one loop cannot
// fill the whole list; a process that lies about its id is held by the global limits only.
//
// Text from the agent is redacted and its invisible characters written out the moment it arrives: what
// the card shows, what the router model is asked and what a dispatch sends as the session's first
// message is that one text. Never cut silently (A16): a text or cwd that would not fit once written out
// is refused (text-too-long, cwd-too-long); a label that would not fit ends in '…'. Nothing here is
// written to disk; a restart forgets every request (the journal's agent-request records still name the
// sessions dispatched for one: `seeded`, requestedOwnedIn).

export const REQUEST_STATES = frozen(['pending', 'dispatched', 'running', 'done', 'rejected', 'expired', 'withdrawn', 'failed'] as const);
export type RequestState = (typeof REQUEST_STATES)[number];
/** The states a request never leaves. */
export const OVER: readonly RequestState[] = frozen(['done', 'rejected', 'expired', 'withdrawn', 'failed'] as const);
/** The states that name an owned session. */
export const BOUND: readonly RequestState[] = frozen(['dispatched', 'running', 'done'] as const);

export const REQUEST_LIMITS = frozen({
  /** Requests kept at once, every state counted; an over one goes first when a new one needs room. */
  kept: 16,
  /** New requests per window (a goal loop asking again and again is held here, final.md §6.2 item 4). */
  perWindow: 6,
  windowMs: 60_000,
  /** The default time a pending request waits for you (final.md §5.1): then it expires, a refusal. */
  ttlMs: 10 * 60 * 1000,
  /** A11 / A16: the last agent message handed back, in UTF-8 bytes. */
  outputBytes: 8 * 1024,
  /** Pending requests of one requester (kind and session id, as it said) at once. */
  perRequester: 4,
  /** The task text, in UTF-8 bytes: the owned message cap (routes.ts OWNED_TEXT_MAX_BYTES). */
  textBytes: 2048,
  labelBytes: 120,
  cwdBytes: 520,
  /** How often a dispatched or running request looks at its session's feed. */
  watchMs: 1000,
  /** Sessions remembered as dispatched for a request after the request itself is gone (evicted, a restart). */
  rememberedOwned: 256,
});

/** A withdraw key as create() hands it to the submitter: 16 random bytes, base64url. */
export const WITHDRAW_KEY_RE = frozen(/^[A-Za-z0-9_-]{22}$/);
/** Where a returned message was cut: orchestrad's cap, the session's own cut of a part, or the feed had dropped events before. */
export type OutputCut = 'cap' | 'final-cut' | 'feed-clipped';
/** Where the card's suggestion stands: still asked, no desk at all, the desk had none, it failed, or there. */
export type SuggestState = 'asking' | 'no-desk' | 'none' | 'failed' | 'ready';

export const REQUEST_ID_RE = frozen(/^[0-9a-f]{20}$/);
/** A requester's session id as the card shows it: an id, never free text. */
export const REQUESTER_ID_RE = frozen(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/** Why a request is where it is (a code, never source text), or null while nothing needs saying. */
export type RequestWhy =
  | 'you-rejected' | 'expired' | 'requester-withdrew' | 'daemon-stop'
  | 'turn-interrupted' | 'turn-failed' | 'turn-max-turns' | 'turn-unknown'
  | `session-${string}`;

/** Who asked, as it said itself (never checked: final.md §6.3 B); sessionId null when it named none. */
export type Requester = { readonly kind: 'dsh'; readonly sessionId: string | null };
/** The requester as the card names it: dsh:<id>, or dsh when it named none (the page says 未知). */
export const requesterName = (r: Requester): string => (r.sessionId === null ? r.kind : `${r.kind}:${r.sessionId}`);

/** The router model's and the rules' suggestion for the request's harness (src/route/desk.ts), as the card shows it. */
export type RequestSuggestion = {
  readonly routeId: string | null;
  readonly router: string;
  readonly models: readonly { readonly model: string; readonly source: 'rule' | 'model'; readonly rule: string | null; readonly reason: string | null }[];
  /** The model of `models` the router model chose; null when it chose none for this harness. */
  readonly pick: number | null;
};

export type AgentRequest = {
  readonly requestId: string;
  readonly harness: RouteHarness;
  /** Redacted, invisible characters written out, at most textBytes: the session's first message on a dispatch. */
  readonly text: string;
  readonly label: string | null;
  /** Where the requester wants the work done, as it said (redacted): shown only, the session runs in ORCHESTRA_HOME\work\<id>. */
  readonly cwd: string;
  readonly requester: Requester;
  readonly state: RequestState;
  readonly createdWall: number;
  /** The wall time a pending request expires at (the card's countdown). */
  readonly expiresWall: number;
  readonly ownedId: string | null;
  /** The last agent message of the first turn; null when the turn left none, or (truncated, feed-clipped) when it is not known. */
  readonly output: string | null;
  readonly truncated: boolean;
  /** Why it is truncated (empty when it is not). */
  readonly cuts: readonly OutputCut[];
  /** Whether the port's GET handed a done reply to the pipe (not proof the requester read it). */
  readonly fetched: boolean;
  readonly why: RequestWhy | null;
  readonly suggestion: RequestSuggestion | null;
  readonly suggesting: SuggestState;
};

/** What a request's owned session looks like now (CodexSession / ClaudeSession, read only). */
export type Observed = {
  readonly state: 'starting' | 'idle' | 'running' | 'ended' | 'failed' | 'unknown';
  readonly endReason: string | null;
  readonly feed: { since(after: number): { clipped: boolean; events: readonly FeedEvent[] } };
};

export type NewRequest = { harness: RouteHarness; text: string; cwd: string; label: string | null; requester: Requester };

export type RequestRefusal = 'full' | 'rate' | 'stopped' | 'requester-full' | 'text-too-long' | 'cwd-too-long';
export type ClaimRefusal = 'request-gone' | 'request-mismatch';

export type RequestsDeps = {
  /** One-shot timers on the Clock (r4 invariant 21): the expiry, the watch, a long poll's wait. */
  after: After;
  nowMono(): number;
  nowWall(): number;
  redact: Redact;
  /** The owned session of a dispatched request, or null when no harness holds it any more. */
  observe(ownedId: string): Observed | null;
  /** The person's normal stop order for an owned session (POST /api/owned/:id/end); false when there was none to end. */
  endOwned(ownedId: string): boolean;
  /** The desk's suggestion for this text, the harness held to the request's; null when there is no desk. */
  suggest?(text: string, harness: RouteHarness): Promise<SuggestReply | null>;
  /** A pending request waits this long for you (default REQUEST_LIMITS.ttlMs). */
  ttlMs?: number;
  /** Hears every state a request moves to (the log); never throws into the store. */
  onMove?(r: AgentRequest, from: RequestState): void;
  /** Sessions the journal says were dispatched for an agent request (requestedOwnedIn), from before this start. */
  seeded?: Iterable<string>;
};

export type Requests = {
  /** A new pending request; its withdraw key goes to the submitter only. */
  create(req: NewRequest): { ok: true; request: AgentRequest; withdrawKey: string } | { ok: false; why: RequestRefusal };
  get(requestId: string): AgentRequest | null;
  list(): AgentRequest[];
  /** The request of the session `ownedId` was dispatched for, if any. */
  ofOwned(ownedId: string): AgentRequest | null;
  /** Sessions dispatched for a request whose details are gone (evicted, or from before this start). */
  requestedGone(): string[];
  /** The port handed a done reply of `requestId` to the pipe. */
  fetched(requestId: string): void;
  /** Settles on the next move of the request, or after `ms`, whichever comes first. */
  wait(requestId: string, ms: number): Promise<void>;
  /** Whether `text` and `harness` dispatch the pending request `requestId` (what the card showed): the request, or why not. */
  claim(requestId: string, text: string, harness: RouteHarness): { ok: true; request: AgentRequest } | { ok: false; why: ClaimRefusal };
  /** The person dispatched it: `ownedId` now runs it. */
  bind(requestId: string, ownedId: string): boolean;
  /** The person rejected it (pending only). */
  reject(requestId: string): boolean;
  /** The requester withdrew it (with its key); a dispatched or running one ends its session's normal way. */
  withdraw(requestId: string, withdrawKey: string): { ok: true; request: AgentRequest } | { ok: false; why: 'request-unknown' | 'not-requester' };
  /** orchestrad stops: every request still open is over, every wait settles. */
  close(): void;
};

type Mut = {
  -readonly [K in keyof AgentRequest]: AgentRequest[K];
} & { expiresMono: number; cancelExpiry: () => void; withdrawKey: Buffer };

const TURN_END = /^turn-(?!started$)/;

/** Agent text as a card shows it: redacted, invisible characters written out, at most `max` bytes, and whether it had to be cut. */
function clean(redact: Redact, raw: string, max: number): { text: string; cut: boolean } {
  const s = shown(redact, raw, max, 'head');
  return { text: s.text, cut: s.cut };
}

/** A label as a card shows it: one cut ends in '…' (never silently short). */
function cleanLabel(redact: Redact, raw: string, max: number): string {
  const s = clean(redact, raw, max);
  return s.cut ? `${headUtf8(s.text, max - 3).text}…` : s.text;
}

/**
 * The last agent message of the turn that ended at `endSeq`: every final part of the newest message
 * before it (one ref), joined, at most OUTPUT_MAX bytes. truncated, with `cuts` saying why: a part was
 * cut by the session already (final-cut), the join was cut here (cap), or the feed had dropped events
 * before (feed-clipped: some of the message may be gone). Null when the turn said nothing and the feed is
 * whole; when the feed had dropped events and no message is left, text is null and truncated (T1: not
 * known, never "nothing").
 */
export function lastMessage(page: { clipped: boolean; events: readonly FeedEvent[] }, endSeq: number, max: number = REQUEST_LIMITS.outputBytes): { text: string | null; truncated: boolean; cuts: OutputCut[] } | null {
  const before = page.events.filter((e) => e.seq < endSeq && e.kind === 'text' && !e.live && (e.state === 'final' || e.state === 'final-cut'));
  const last = before[before.length - 1];
  if (last === undefined) return page.clipped ? { text: null, truncated: true, cuts: ['feed-clipped'] } : null;
  const parts = before.filter((e) => e.ref === last.ref);
  const joined = parts.map((e) => e.text ?? '').join('');
  const cut = headUtf8(joined, max);
  const cuts: OutputCut[] = [];
  if (cut.cut) cuts.push('cap');
  if (parts.some((e) => e.state === 'final-cut')) cuts.push('final-cut');
  if (page.clipped) cuts.push('feed-clipped');
  return { text: cut.text, truncated: cuts.length > 0, cuts };
}

export function makeRequests(deps: RequestsDeps): Requests {
  const ttl = deps.ttlMs ?? REQUEST_LIMITS.ttlMs;
  const all = new Map<string, Mut>();
  const waiters = new Map<string, Set<() => void>>();
  const made: number[] = [];
  /** Sessions dispatched for a request, kept after the request goes (bounded; the journal's first). */
  const asked: string[] = [...(deps.seeded ?? [])].slice(-REQUEST_LIMITS.rememberedOwned);
  const remember = (ownedId: string) => {
    if (asked.includes(ownedId)) return;
    asked.push(ownedId);
    if (asked.length > REQUEST_LIMITS.rememberedOwned) asked.shift();
  };
  let watching: (() => void) | null = null;
  let closed = false;

  const view = (m: Mut): AgentRequest => {
    const { expiresMono: _e, cancelExpiry: _c, withdrawKey: _k, ...r } = m;
    return Object.freeze({ ...r, requester: Object.freeze({ ...r.requester }), cuts: Object.freeze([...r.cuts]) });
  };
  const wake = (id: string) => {
    const w = waiters.get(id);
    if (w === undefined) return;
    waiters.delete(id);
    for (const fn of w) fn();
  };
  const move = (m: Mut, to: RequestState, why: RequestWhy | null = m.why) => {
    if (m.state === to) return;
    const from = m.state;
    m.state = to;
    m.why = why;
    if (to !== 'pending') m.cancelExpiry();
    try {
      deps.onMove?.(view(m), from);
    } catch {
      // The log's trouble is not the request's.
    }
    wake(m.requestId);
    if (BOUND.includes(to) && !OVER.includes(to)) watch();
  };

  /** A dispatched or running request reads its session: the turn's start, its end, the session's end. */
  const look = (m: Mut) => {
    if (m.ownedId === null || (m.state !== 'dispatched' && m.state !== 'running')) return;
    const s = deps.observe(m.ownedId);
    if (s === null) return move(m, 'failed', 'session-gone');
    const page = s.feed.since(0);
    const end = page.events.find((e) => e.kind === 'lifecycle' && e.state !== null && TURN_END.test(e.state));
    if (end !== undefined) {
      if (end.state === 'turn-ended') {
        const msg = lastMessage(page, end.seq);
        m.output = msg?.text ?? null;
        m.truncated = msg?.truncated ?? false;
        m.cuts = msg?.cuts ?? [];
        return move(m, 'done', null);
      }
      return move(m, 'failed', (['turn-interrupted', 'turn-failed', 'turn-max-turns'].includes(end.state!) ? end.state : 'turn-unknown') as RequestWhy);
    }
    if (s.state === 'ended' || s.state === 'failed' || s.state === 'unknown') return move(m, 'failed', `session-${s.endReason ?? s.state}`);
    if (m.state === 'dispatched' && (s.state === 'running' || page.events.some((e) => e.kind === 'lifecycle' && e.state === 'turn-started'))) move(m, 'running');
  };
  const active = () => [...all.values()].filter((m) => m.state === 'dispatched' || m.state === 'running');
  function watch(): void {
    if (watching !== null || closed) return;
    watching = deps.after(REQUEST_LIMITS.watchMs, () => {
      watching = null;
      for (const m of active()) look(m);
      if (active().length > 0) watch();
    });
  }

  const room = (): boolean => {
    if (all.size < REQUEST_LIMITS.kept) return true;
    const over = [...all.values()].find((m) => OVER.includes(m.state));
    if (over === undefined) return false;
    all.delete(over.requestId);
    return true;
  };

  const suggestion = (reply: SuggestReply, harness: RouteHarness): RequestSuggestion => {
    const mine = reply.candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.harness === harness);
    const pick = reply.router.pick === null ? -1 : mine.findIndex(({ i }) => i === reply.router.pick);
    return Object.freeze({
      routeId: reply.routeId, router: reply.router.state,
      models: Object.freeze(mine.map(({ c }) => Object.freeze({ model: c.model, source: c.source, rule: c.rule, reason: c.reason }))),
      pick: pick < 0 ? null : pick,
    });
  };

  return Object.freeze({
    create(req: NewRequest) {
      if (closed) return { ok: false as const, why: 'stopped' as const };
      const now = deps.nowMono();
      while (made.length > 0 && now - made[0]! >= REQUEST_LIMITS.windowMs) made.shift();
      // Never cut silently (A16): what would not fit once redacted and written out is refused, not shortened.
      const text = clean(deps.redact, req.text, REQUEST_LIMITS.textBytes);
      if (text.cut) return { ok: false as const, why: 'text-too-long' as const };
      const cwd = clean(deps.redact, req.cwd, REQUEST_LIMITS.cwdBytes);
      if (cwd.cut) return { ok: false as const, why: 'cwd-too-long' as const };
      const who = requesterName(req.requester);
      if ([...all.values()].filter((x) => x.state === 'pending' && requesterName(x.requester) === who).length >= REQUEST_LIMITS.perRequester) {
        return { ok: false as const, why: 'requester-full' as const };
      }
      if (made.length >= REQUEST_LIMITS.perWindow) return { ok: false as const, why: 'rate' as const };
      if (!room()) return { ok: false as const, why: 'full' as const };
      made.push(now);
      const requestId = crypto.randomBytes(10).toString('hex');
      const key = crypto.randomBytes(16).toString('base64url');
      const label = req.label === null ? null : cleanLabel(deps.redact, req.label.split('\n', 1)[0] ?? '', REQUEST_LIMITS.labelBytes);
      const m: Mut = {
        requestId, harness: req.harness, text: text.text, label: label === '' ? null : label,
        cwd: cwd.text, requester: Object.freeze({ ...req.requester }), state: 'pending', createdWall: deps.nowWall(),
        expiresWall: deps.nowWall() + ttl, expiresMono: now + ttl, ownedId: null, output: null, truncated: false, cuts: [], fetched: false, why: null,
        suggestion: null, suggesting: deps.suggest === undefined ? 'no-desk' : 'asking',
        cancelExpiry: () => {}, withdrawKey: Buffer.from(key, 'ascii'),
      };
      m.cancelExpiry = deps.after(ttl, () => {
        if (m.state === 'pending') move(m, 'expired', 'expired');
      });
      all.set(requestId, m);
      // The card shows the suggestion when it comes; a request never waits on it.
      const ask = deps.suggest;
      if (ask !== undefined) {
        void ask(m.text, m.harness).then((reply) => {
          m.suggesting = reply === null ? 'none' : 'ready';
          if (reply !== null && m.state === 'pending') m.suggestion = suggestion(reply, m.harness);
          wake(requestId);
        }, () => {
          m.suggesting = 'failed';
          wake(requestId);
        });
      }
      try {
        deps.onMove?.(view(m), 'pending');
      } catch {
        // as in move()
      }
      return { ok: true as const, request: view(m), withdrawKey: key };
    },
    get(requestId: string) {
      const m = all.get(requestId);
      if (m === undefined) return null;
      look(m);
      return view(m);
    },
    list: () => [...all.values()].map(view),
    ofOwned(ownedId: string) {
      const m = [...all.values()].find((x) => x.ownedId === ownedId);
      return m === undefined ? null : view(m);
    },
    requestedGone(): string[] {
      const here = new Set([...all.values()].map((m) => m.ownedId));
      return asked.filter((id) => !here.has(id));
    },
    fetched(requestId: string): void {
      const m = all.get(requestId);
      if (m !== undefined && m.state === 'done') m.fetched = true;
    },
    wait(requestId: string, ms: number): Promise<void> {
      const m = all.get(requestId);
      if (m === undefined || OVER.includes(m.state) || closed || ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let cancel: () => void = () => {};
        const done = () => {
          cancel();
          waiters.get(requestId)?.delete(done);
          resolve();
        };
        const set = waiters.get(requestId) ?? new Set();
        set.add(done);
        waiters.set(requestId, set);
        cancel = deps.after(ms, done);
      });
    },
    claim(requestId: string, text: string, harness: RouteHarness) {
      const m = all.get(requestId);
      if (m === undefined || m.state !== 'pending' || deps.nowMono() >= m.expiresMono) return { ok: false as const, why: 'request-gone' as const };
      // The person dispatches what the card showed: that text, that harness.
      if (m.text !== text || m.harness !== harness) return { ok: false as const, why: 'request-mismatch' as const };
      return { ok: true as const, request: view(m) };
    },
    bind(requestId: string, ownedId: string): boolean {
      const m = all.get(requestId);
      if (m === undefined || m.state !== 'pending') return false;
      m.ownedId = ownedId;
      remember(ownedId);
      move(m, 'dispatched', null);
      return true;
    },
    reject(requestId: string): boolean {
      const m = all.get(requestId);
      if (m === undefined || m.state !== 'pending') return false;
      move(m, 'rejected', 'you-rejected');
      return true;
    },
    withdraw(requestId: string, withdrawKey: string) {
      const m = all.get(requestId);
      if (m === undefined) return { ok: false as const, why: 'request-unknown' as const };
      // Only the submitter holds the key; anyone else with a requestId (the log names it) cannot withdraw.
      const given = Buffer.from(String(withdrawKey), 'ascii');
      if (given.length !== m.withdrawKey.length || !crypto.timingSafeEqual(given, m.withdrawKey)) return { ok: false as const, why: 'not-requester' as const };
      if (m.state === 'pending') move(m, 'withdrawn', 'requester-withdrew');
      else if (m.state === 'dispatched' || m.state === 'running') {
        // The normal stop order (POST /api/owned/:id/end's), never the brake (final.md §6.3 A).
        move(m, 'withdrawn', 'requester-withdrew');
        deps.endOwned(m.ownedId!);
      }
      return { ok: true as const, request: view(m) };
    },
    close(): void {
      closed = true;
      watching?.();
      watching = null;
      for (const m of all.values()) if (!OVER.includes(m.state)) move(m, 'failed', 'daemon-stop');
      for (const id of [...waiters.keys()]) wake(id);
    },
  });
}

/**
 * The sessions the journal says were dispatched for an agent request (its `agent-request` records,
 * verdict dispatched), oldest first, at most REQUEST_LIMITS.rememberedOwned: a session page still says it
 * was asked for after a restart forgot the request itself.
 */
export function requestedOwnedIn(db: { all(sql: string): { body?: unknown }[] }): string[] {
  // SQL text is a literal (scan rule sql-text-literal-only): 512 is twice REQUEST_LIMITS.rememberedOwned (a rejection names no session).
  const rows = db.all("SELECT body FROM event WHERE kind = 'agent-request' ORDER BY jseq DESC LIMIT 512");
  const out: string[] = [];
  for (const r of rows) {
    try {
      const b = JSON.parse(String(r.body)) as { verdict?: unknown; ownedId?: unknown };
      if (b.verdict === 'dispatched' && typeof b.ownedId === 'string' && /^[0-9a-f]{20}$/.test(b.ownedId) && !out.includes(b.ownedId)) out.push(b.ownedId);
    } catch {
      // A body that does not parse names no session.
    }
  }
  return out.slice(0, REQUEST_LIMITS.rememberedOwned).reverse();
}

/** The UTF-8 length a request's text may have (the owned message cap), for the port's own check. */
export const requestTextFits = (text: string): boolean => utf8Length(text) <= REQUEST_LIMITS.textBytes;
