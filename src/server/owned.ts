import type { IncomingMessage } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { ErrorCode, HumanVerb } from '../../shared/protocol.js';
import { ERROR_STATUS, ID_RE, UUID_RE } from '../../shared/protocol.js';
import { frozen } from '../../shared/frozen.js';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import type { Clock } from '../runtime/clock.ts';
import type { Log } from '../runtime/log.ts';
import type { PresenceWatch } from '../route/presence.ts';
import type { Line, Rec } from '../store/journal.ts';
import type { Store } from '../store/store.ts';
import { StoreError } from '../store/store.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import type { Route, Shape } from './routes.ts';
import { CONTROL_HEADER, CSRF_RE, OWNED_BODY_MAX_BYTES, OWNED_TEXT_MAX_BYTES, PAIR_CODE_RE, ROUTES, STAGE_ID_RE, shapeError } from './routes.ts';

// The owned-session API's base (alpha 0.2, slice design §2.7; §7 step 5): the controller token, the
// check chain every owned route runs, the `human` records, and the table step 6c's handlers plug into.
// http.ts hands it every request after the Host check and the pairing cookie lookup; it answers the
// routes of routes.ts whose auth is `cookie` or `unlocked` and nothing else.
//
// The controller token. The pairing cookie is not bound to a port, so a page another local process
// serves on orchestra.localhost:<other port> holds it too. The cookie therefore buys only the shell and
// the read-only peek GETs; every owned route, a GET too, also needs X-Orchestra-CSRF, and its value
// comes only from an unlock code the daemon prints to its own console (POST /api/owned/unlock-code:
// 204, the code never in a reply), traded for a token bound to that sid (POST /api/owned/unlock). The
// page keeps the token in its tab's session storage, which is per origin, the port included. Codes follow the
// pairing code's rules: 8 digits from node:crypto, 10 minutes, compared in constant time, void after 5
// wrong tries in a row; after 20 wrong tries in all, unlocking is closed until the daemon restarts. A
// code is only good for the sid that asked for it; a new ask replaces it. Tokens and codes live in
// memory only.
//
// The check chain (slice design §2.7, in this order; owned.test pins it):
//   1. Host exact (http.ts, for every route);
//   2. the pairing cookie, else 403;
//   3. Origin exact; a GET may leave it out, since a browser sends none on a same-origin GET;
//   4. Sec-Fetch-Site present and same-origin;
//   5. a POST with a body sends Content-Type application/json, one without sends no body (else 400);
//   6. for `unlocked`: the token, compared in constant time; missing or wrong is 403 not-unlocked;
//   7. the body at most OWNED_BODY_MAX_BYTES (413 body-too-big); a message at most OWNED_TEXT_MAX_BYTES
//      of UTF-8 (422 text-too-long), and not starting with `/` (422 slash-command: the CLI would run it
//      as a slash command, and `/model` or `/config` change the session);
//   8. the shape (routes.ts shapeError): on a route that writes a human record (POST /api/route/suggest
//      writes none and carries no actionId) a missing or malformed actionId is 400 actionId-missing, any
//      other misfit 400 without a code; a path id outside its grammar is 404 item-unknown;
//   9. the actionId: in flight is 409 in-flight, the same actionId over another request is 422
//      actionId-reused, the same request again is answered as before with replayed:true;
//  10. owned-disabled (409) for a route that starts work unless the server was made with the owned
//      feature on; then the route's handler, or 501 while it has none.
// The design lists the message checks (7) before the shape (8); routes.ts CHECKS files them under the
// `own` step after dedup. Each refusal is a 4xx either way and writes nothing; the order here is the design's.
//
// Human records. A request that passes the chain and that its handler accepts writes `human` and
// `human.result` (outcome applied) in one batch, after the effect (UI design 一 5): requestDigest is
// sha256 over the canonical {route, id, body without actionId}, so a restart rebuilds the dedup from the
// journal alone. An in-flight table covers the time the handler awaits; it is cleared in the same
// synchronous turn the batch commits. A refusal (4xx), a 501 or a handler that throws writes nothing.

/** How long an unlock code holds (the pairing code's 10 minutes). */
export const UNLOCK_TTL_MS = 10 * 60 * 1000;
/** The largest body POST /api/owned/unlock takes: `{"code":"12345678"}` and some room. */
export const UNLOCK_BODY_MAX_BYTES = 1024;

const LIMITS = frozen({ wrongInRow: 5, wrongTotal: 20, replies: 256 });
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export type UnlockOutcome = 'ok' | 'wrong' | 'voided' | 'shut' | 'expired' | 'no-code';

export type Unlock = {
  /** False once 20 wrong codes in all were tried: no code is issued or taken until a restart. */
  readonly open: boolean;
  /** A fresh code for `sid`, replacing any it had; null when unlocking is closed. */
  issue(sid: string, nowMono: number): string | null;
  /** Tries `given` against the code of `sid`; on 'ok' the token, which replaces any token the sid had. */
  attempt(sid: string, given: string, nowMono: number): { outcome: UnlockOutcome; csrf: string | null };
  /** Is `header` the token of `sid`? Constant time over the token's bytes. */
  holds(sid: string, header: unknown): boolean;
  /** The sid's code and token go (its pairing session was dropped). */
  forget(sid: string): void;
};

/** The unlock codes and the controller tokens, by sid (slice design §2.7); memory only. */
export function makeUnlock(): Unlock {
  const codes = new Map<string, { code: string; issuedMono: number; wrongInRow: number }>();
  const tokens = new Map<string, string>();
  let wrongTotal = 0;
  const shut = () => wrongTotal >= LIMITS.wrongTotal;
  return Object.freeze({
    get open(): boolean {
      return !shut();
    },
    issue(sid: string, nowMono: number): string | null {
      if (shut()) return null;
      const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
      codes.set(sid, { code, issuedMono: nowMono, wrongInRow: 0 });
      return code;
    },
    attempt(sid: string, given: string, nowMono: number) {
      const none = (outcome: UnlockOutcome) => ({ outcome, csrf: null });
      if (shut()) return none('shut');
      const c = codes.get(sid);
      if (c === undefined) return none('no-code');
      if (nowMono - c.issuedMono > UNLOCK_TTL_MS) {
        codes.delete(sid);
        return none('expired');
      }
      const a = Buffer.from(c.code);
      const b = Buffer.from(given);
      if (PAIR_CODE_RE.test(given) && a.length === b.length && timingSafeEqual(a, b)) {
        codes.delete(sid);
        const csrf = randomBytes(32).toString('base64url');
        tokens.set(sid, csrf);
        return { outcome: 'ok' as const, csrf };
      }
      c.wrongInRow++;
      wrongTotal++;
      if (shut()) {
        codes.clear();
        return none('shut');
      }
      if (c.wrongInRow >= LIMITS.wrongInRow) {
        codes.delete(sid);
        return none('voided');
      }
      return none('wrong');
    },
    holds(sid: string, header: unknown): boolean {
      const t = tokens.get(sid);
      if (t === undefined || typeof header !== 'string' || !CSRF_RE.test(header)) return false;
      return timingSafeEqual(Buffer.from(t), Buffer.from(header));
    },
    forget(sid: string): void {
      codes.delete(sid);
      tokens.delete(sid);
    },
  });
}

// --- the journal side: the `human` records -----------------------------------------------------------

/** A human action the journal holds: its requestDigest, and the jseq of its result (null while it has none). */
export type HumanFound = { readonly requestDigest: string; readonly resultJseq: number | null };

/** What the owned API reads from and writes to the store: two fixed SELECTs and one commit path. */
export type HumanJournal = {
  find(actionId: string): HumanFound | null;
  /** Commits `human` and `human.result` (outcome applied), and the handler's own records after them, in one batch; returns the human.result line's jseq. */
  record(r: { actionId: string; verb: HumanVerb; targetId: string | null; requestDigest: string }, extra?: readonly Rec[]): number;
};

/** The HumanJournal over the store working.ts opened. */
export function humanJournal(store: Pick<Store, 'db' | 'commit'>): HumanJournal {
  return Object.freeze({
    find(actionId: string): HumanFound | null {
      const h = store.db.get("SELECT body FROM event WHERE kind = 'human' AND action_id = ?", actionId);
      if (h === undefined) return null;
      const r = store.db.get("SELECT jseq FROM event WHERE kind = 'human.result' AND action_id = ?", actionId);
      return { requestDigest: String((JSON.parse(String(h.body)) as { requestDigest: unknown }).requestDigest), resultJseq: r === undefined ? null : Number(r.jseq) };
    },
    record(r: { actionId: string; verb: HumanVerb; targetId: string | null; requestDigest: string }, extra: readonly Rec[] = []): number {
      const recs: Rec[] = [
        { kind: 'human', body: { actionId: r.actionId, verb: r.verb, targetId: r.targetId, requestDigest: r.requestDigest } },
        { kind: 'human.result', body: { actionId: r.actionId, verb: r.verb, targetId: r.targetId, outcome: 'applied', commandId: null, subtrees: null } },
        ...extra,
      ];
      const lines: readonly Line[] = store.commit(recs);
      return lines.find((l) => l.kind === 'human.result')!.jseq;
    },
  });
}

// --- the handlers (step 6c registers them) -----------------------------------------------------------

/** What a handler is handed: the request after the whole chain, shapes checked. */
export type OwnedCall = {
  readonly route: Route;
  /** The path's `:id` through its grammar (a stage id for target 'stage', else an id), or null. */
  readonly id: string | null;
  /** A GET's query, shape-checked; empty for a POST. */
  readonly query: Readonly<Record<string, string>>;
  /** A POST's body, shape-checked against route.body (actionId included for a human route); null for a GET. */
  readonly body: Readonly<Record<string, unknown>> | null;
  /** A human route's actionId; null for a GET and for a POST that writes no record (POST /api/route/suggest). */
  readonly actionId: string | null;
  /** The pairing session the request came with (it holds the token). */
  readonly sid: string;
};

/**
 * What a handler answers. ok: for a GET the 200 reply as it goes out (checked against route.reply when
 * the route has one); for a POST the verb's own reply fields (ownedId, uuid, queued...), which the base
 * joins to actionId, accepted and jseq, and the record's targetId (default: the path id or the body's
 * stageId). Refused: an error code of the route (item-unknown, route.own, route.failures); nothing is written.
 */
export type OwnedOutcome =
  | {
    readonly ok: true; readonly reply: Readonly<Record<string, unknown>>; readonly targetId?: string | null;
    /** A human route's own records, committed after its `human` and `human.result` in the same batch (owned-new's RouteDecision). */
    readonly records?: readonly Rec[];
    /** Runs once that batch is committed (never when the record failed). */
    readonly after?: () => void;
  }
  | { readonly ok: false; readonly error: ErrorCode };

export type OwnedHandler = (call: OwnedCall) => OwnedOutcome | Promise<OwnedOutcome>;

export type OwnedHandlers = {
  /** Attaches the handler of an `unlocked` route, named as routes.ts writes it ('POST', '/api/owned/:id/message'). Once per route. */
  register(method: Route['method'], path: string, handler: OwnedHandler): void;
  get(route: Route): OwnedHandler | undefined;
};

export function makeOwnedHandlers(): OwnedHandlers {
  const table = new Map<Route, OwnedHandler>();
  return Object.freeze({
    register(method: Route['method'], path: string, handler: OwnedHandler): void {
      const route = ROUTES.find((r) => r.method === method && r.path === path);
      if (route === undefined || route.auth !== 'unlocked') throw new TypeError(`[owned] ${method} ${path} is not an owned route that takes a handler`);
      if (table.has(route)) throw new TypeError(`[owned] ${method} ${path} has its handler already`);
      if (typeof handler !== 'function') throw new TypeError(`[owned] the handler of ${method} ${path} is not a function`);
      table.set(route, handler);
    },
    get: (route: Route) => table.get(route),
  });
}

// --- the API ---------------------------------------------------------------------------------------

/** What http.ts sends: JSON, a plain text line, or nothing (204). */
export type OwnedAnswer = { readonly status: number; readonly json?: unknown; readonly text?: string };

export type OwnedApiOptions = {
  journal: HumanJournal;
  /** Prints an unlock code where the pairing code goes (the test profile: stdout); null when that console is off. */
  printUnlockCode: ((code: string) => void) | null;
  /**
   * Owned sessions may start (new, import, retry): in either profile, once orchestrad was started with
   * --owned and found codex.exe (working.ts setUpOwnedCodex). Slice design §2.7 and its endpoint test
   * (owned-disabled under the real profile) are superseded here by orchestra app plan §2, which runs real
   * profile sessions in ORCHESTRA_HOME\work\<ownedId>; recorded in the plan's divergence notes.
   */
  enabled?: boolean;
  handlers?: OwnedHandlers;
  /** Hears the unlocked page's reads of GET /api/owned and every recorded human action: whether you are here (src/route/presence.ts). */
  presence?: Pick<PresenceWatch, 'beat' | 'acted'>;
};

export type OwnedApi = {
  /** The answer to a request on an owned route, or null when the path is none (http.ts carries on). `sid` is the paired session, or null. */
  handle(req: IncomingMessage, url: URL, sid: string | null): Promise<OwnedAnswer | null>;
  forget(sid: string): void;
};

const OWNED_ROUTES: readonly Route[] = Object.freeze(ROUTES.filter((r) => r.auth === 'cookie' || r.auth === 'unlocked'));
const SEGMENTS = new Map<Route, readonly string[]>(OWNED_ROUTES.map((r) => [r, r.path.split('/')]));
const NO_QUERY: Shape = Object.freeze({ t: 'obj', fields: Object.freeze({}), optional: Object.freeze([]) });

const text = (status: number, t: string): OwnedAnswer => ({ status, text: t });
const refuse = (code: ErrorCode): OwnedAnswer => ({ status: ERROR_STATUS[code], json: { error: code } });

/** The owned route of this path, with its `:id`; 'method' when only another method has one. */
function match(method: string | undefined, pathname: string): { route: Route; id: string | null } | 'method' | null {
  const parts = pathname.split('/');
  let other = false;
  for (const route of OWNED_ROUTES) {
    const want = SEGMENTS.get(route)!;
    if (want.length !== parts.length) continue;
    let id: string | null = null;
    let fits = true;
    for (let i = 0; i < want.length && fits; i++) {
      if (want[i] === ':id') id = parts[i]!;
      fits = want[i] === ':id' ? parts[i]!.length > 0 : want[i] === parts[i];
    }
    if (!fits) continue;
    if (route.method === method) return { route, id };
    other = true;
  }
  return other ? 'method' : null;
}

/** The message a route's body carries under `text`, when it has one (owned-new, owned-message). */
function messageOf(route: Route, body: unknown): string | null {
  const shape = route.body;
  if (shape === null || shape.t !== 'obj' || !Object.hasOwn(shape.fields, 'text')) return null;
  const f = shape.fields.text!;
  if (f.t !== 'text' || f.why !== 'message') return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const d = Object.getOwnPropertyDescriptor(body, 'text');
  return d !== undefined && typeof d.value === 'string' ? d.value : null;
}

const parse = (s: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

export function makeOwnedApi(opts: OwnedApiOptions & {
  clock: Pick<Clock, 'nowMono'>;
  log: Log;
  /** The server's origin, known once it listens. */
  origin: () => string;
  readBody(req: IncomingMessage, max: number): Promise<string | null>;
}): OwnedApi {
  const { journal, clock, log, readBody } = opts;
  const enabled = opts.enabled === true;
  const handlers = opts.handlers ?? makeOwnedHandlers();
  const unlock = makeUnlock();
  /** actionId -> requestDigest, from the dedup step until the batch commits or the request is refused. */
  const inFlight = new Map<string, string>();
  /** A verb's own reply fields by actionId, so a replay in this boot answers them again; bounded. */
  const replies = new Map<string, Readonly<Record<string, unknown>>>();

  const body = async (req: IncomingMessage, max: number): Promise<string | null> => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return null;
    return readBody(req, max);
  };

  const unlockRoutes = async (route: Route, req: IncomingMessage, sid: string): Promise<OwnedAnswer> => {
    if (route.path === '/api/owned/unlock-code') {
      if (opts.printUnlockCode === null) return text(503, 'unlock is off: the console is not interactive');
      const code = unlock.issue(sid, clock.nowMono());
      log.info('owned-unlock-code', { issued: code !== null });
      if (code === null) return text(403, 'unlocking is closed: restart orchestrad');
      // Straight to the console, never through the log or a reply.
      opts.printUnlockCode(code);
      return { status: 204 };
    }
    const raw = await body(req, UNLOCK_BODY_MAX_BYTES);
    if (raw === null) return refuse('body-too-big');
    const parsed = parse(raw);
    if (!parsed.ok || shapeError(route.body!, parsed.value) !== null) return text(400, 'bad request');
    const r = unlock.attempt(sid, (parsed.value as { code: string }).code, clock.nowMono());
    log.info('owned-unlock', { outcome: r.outcome });
    return r.csrf === null ? refuse('not-unlocked') : { status: 200, json: { csrf: r.csrf } };
  };

  const run = async (route: Route, call: OwnedCall, handler: OwnedHandler): Promise<OwnedOutcome | 'threw'> => {
    try {
      const out = await handler(call);
      if (out.ok) return out;
      const allowed: readonly ErrorCode[] = ['item-unknown', ...route.own, ...route.failures];
      if (!allowed.includes(out.error)) {
        log.warn('owned-handler-bad-error', { route: `${route.method} ${route.path}`, error: String(out.error) });
        return 'threw';
      }
      return out;
    } catch (e) {
      log.warn('owned-handler-failed', { route: `${route.method} ${route.path}`, error: e });
      return 'threw';
    }
  };

  const handle = async (req: IncomingMessage, url: URL, sid: string | null): Promise<OwnedAnswer | null> => {
    const m = match(req.method, url.pathname);
    if (m === null) return null;
    if (m === 'method') return text(405, 'method not allowed');
    const { route } = m;
    const post = route.method === 'POST';
    // 2-6: the cookie, Origin, Sec-Fetch-Site, the content type, the token.
    if (sid === null) return text(403, 'not paired');
    const origin = req.headers.origin;
    if (post ? origin !== opts.origin() : origin !== undefined && origin !== opts.origin()) return text(403, 'wrong origin');
    if (req.headers['sec-fetch-site'] !== 'same-origin') return text(403, 'cross-site request');
    if (post) {
      if (route.body !== null) {
        if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return text(400, 'bad request');
      } else if ((req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined) {
        return text(400, 'bad request');
      }
    }
    if (route.auth === 'cookie') return unlockRoutes(route, req, sid);
    if (!unlock.holds(sid, req.headers[CONTROL_HEADER])) return refuse('not-unlocked');
    if (route.method === 'GET' && route.path === '/api/owned') opts.presence?.beat();

    // 7-8: the body (a POST) or the query (a GET), its message, its shape, the path id.
    let parsed: Record<string, unknown> | null = null;
    const query: Record<string, string> = {};
    if (post) {
      const raw = await body(req, OWNED_BODY_MAX_BYTES);
      if (raw === null) return refuse('body-too-big');
      const p = parse(raw);
      if (!p.ok) return text(400, 'bad request');
      const message = messageOf(route, p.value);
      if (message !== null && Buffer.byteLength(message, 'utf8') > OWNED_TEXT_MAX_BYTES) return refuse('text-too-long');
      if (message !== null && message.trimStart().startsWith('/')) return refuse('slash-command');
      const v = p.value as Record<string, unknown>;
      // Only a route that writes a human record carries an actionId (POST /api/route/suggest does not).
      const a = typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.getOwnPropertyDescriptor(v, 'actionId') : undefined;
      if (route.human !== null && (a === undefined || typeof a.value !== 'string' || !UUID_RE.test(a.value))) return refuse('actionId-missing');
      if (shapeError(route.body!, v) !== null) return text(400, 'bad request');
      parsed = v;
    } else {
      const keys = [...url.searchParams.keys()];
      if (new Set(keys).size !== keys.length) return text(400, 'bad request');
      for (const [k, v] of url.searchParams) query[k] = v;
      if (shapeError(route.query ?? NO_QUERY, query) !== null) return text(400, 'bad request');
    }
    if (m.id !== null && !(route.target === 'stage' ? STAGE_ID_RE : ID_RE).test(m.id)) return refuse('item-unknown');
    const actionId = parsed === null || route.human === null ? null : (parsed.actionId as string);
    const call: OwnedCall = Object.freeze({ route, id: m.id, query: Object.freeze(query), body: parsed === null ? null : Object.freeze(parsed), actionId, sid });

    if (route.human === null || actionId === null) {
      // A GET, or a POST that writes no record (the dispatch desk's suggestion): no actionId, no record.
      const handler = handlers.get(route);
      if (handler === undefined) return text(501, 'not implemented yet');
      const out = await run(route, call, handler);
      if (out === 'threw') return text(500, 'failed');
      if (!out.ok) return refuse(out.error);
      if (route.reply !== null && shapeError(route.reply, out.reply) !== null) {
        log.warn('owned-reply-misshapen', { route: `${route.method} ${route.path}` });
        return text(500, 'failed');
      }
      // A reply a contract checks (shared/owned-contract.js) goes out only when it passes it.
      if (route.contract !== undefined) {
        const verdict = (route.contract === 'OwnedList' ? validateOwnedList : validateOwnedFeed)(out.reply);
        if (!verdict.ok) {
          log.warn('owned-reply-misshapen', { route: `${route.method} ${route.path}`, errors: verdict.errors.slice(0, 8) });
          return text(500, 'failed');
        }
      }
      return { status: 200, json: out.reply };
    }

    // 9: the actionId. The in-flight table first, then the journal.
    const { actionId: _drop, ...rest } = parsed!;
    const requestDigest = canonicalDigest({ route: `${route.method} ${route.path}`, id: m.id, body: rest });
    const flying = inFlight.get(actionId);
    if (flying !== undefined) return refuse(flying === requestDigest ? 'in-flight' : 'actionId-reused');
    const done = journal.find(actionId);
    if (done !== null) {
      if (done.requestDigest !== requestDigest) return refuse('actionId-reused');
      // Only a brake leaves a `human` without its result, and the startup closes it: in flight till then.
      if (done.resultJseq === null) return refuse('in-flight');
      return { status: 200, json: { ...(replies.get(actionId) ?? {}), actionId, accepted: true, jseq: done.resultJseq, replayed: true } };
    }

    // 10: the profile switch, the handler, the record.
    inFlight.set(actionId, requestDigest);
    try {
      if (!enabled && route.own.includes('owned-disabled')) return refuse('owned-disabled');
      const handler = handlers.get(route);
      if (handler === undefined) return text(501, 'not implemented yet');
      const out = await run(route, call, handler);
      if (out === 'threw') return text(500, 'failed');
      if (!out.ok) return refuse(out.error);
      const { actionId: _a, accepted: _b, jseq: _c, replayed: _d, ...extra } = out.reply;
      const stageId = parsed!.stageId;
      const targetId = out.targetId !== undefined ? out.targetId : m.id ?? (typeof stageId === 'string' ? stageId : null);
      if (shapeError(route.reply!, { ...extra, actionId, accepted: true, jseq: 0 }) !== null) {
        log.warn('owned-reply-misshapen', { route: `${route.method} ${route.path}` });
        return text(500, 'failed');
      }
      let jseq: number;
      try {
        jseq = journal.record({ actionId, verb: route.human, targetId, requestDigest }, out.records ?? []);
      } catch (e) {
        // The backstop: the journal holds this actionId already (the dedup above makes it unreachable).
        if (e instanceof StoreError && e.reason === 'duplicate-action') return refuse('actionId-reused');
        log.warn('owned-record-failed', { route: `${route.method} ${route.path}`, error: e });
        return text(500, 'failed');
      }
      opts.presence?.acted();
      if (out.after !== undefined) {
        try {
          out.after();
        } catch (e) {
          log.warn('owned-after-failed', { route: `${route.method} ${route.path}`, error: e });
        }
      }
      if (replies.size >= LIMITS.replies) replies.delete(replies.keys().next().value!);
      replies.set(actionId, Object.freeze(extra));
      return { status: 200, json: { ...extra, actionId, accepted: true, jseq } };
    } finally {
      // The same turn as the commit: no gap where neither table holds the actionId.
      inFlight.delete(actionId);
    }
  };

  return Object.freeze({ handle, forget: (sid: string) => unlock.forget(sid) });
}
