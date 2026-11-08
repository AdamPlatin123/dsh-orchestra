import type { ErrorCode, HumanVerb, Shape, TextWhy } from '../../shared/protocol.js';
import {
  ACK_PHASES, CREATE_TIME_RE, ENDED_FIELDS, ERROR_CODES, ERROR_STATUS, FRAMES, HARNESSES, HUMAN_VERB_ROUTES, ID_RE, IMAGE_NAME_RE, ITEM_FIELDS, MODES, PERF_METRICS,
  PERMISSIONS, PROFILES, S, SHAPES, SNOOZE_PRESETS, TEXT_STATES, TOOL_NAME_RE, UUID_RE, VERSION_RE, VISIBILITIES, WHY_REASONS, titleError,
} from '../../shared/protocol.js';
import { PLAN_TTL_MS, SNIPPET_MAX_BYTES } from '../../shared/constants.js';
import { frozen } from '../../shared/frozen.js';
import { ACK_REPLIES } from '../notify/channel.ts';
import { ownFields } from '../runtime/own.ts';
import { COUNT_NAMES } from '../model/source-report.ts';
import { DIGEST_RE, ERROR_CODE_RE, EVENT_KINDS, GRANT_LEVELS } from '../store/records.ts';
import { OWNED_MODEL_RE } from '../owned/models.ts';
import { QUESTION_LIMITS } from '../owned/approvals.ts';
import { MAX_CANDIDATES, ROUTE_HARNESSES, ROUTER_STATES, RULE_IDS, TASK_CLASSES } from '../route/rules.ts';
import { ROUTER_WHY } from '../route/router-model.ts';

// The route table and every JSON shape the HTTP server and the SSE stream speak (plan step 3; UI
// design 一). No server here: step 4 builds it on these, checks each request against its route's
// shapes and runs the fixed check order below. Shapes are data, checked by shapeError(), so a test can
// walk them: no frame has a leaf for source free text. A string in a frame is an enum, an id, or a
// value through one of shared/protocol.js's grammars (a title is {key, args}, titleError); the one
// text a frame may carry is your own reminder's (ItemView.reminder, with its textState). Replies that
// are not frames (detail's peek, the brake plan's command lines, a native window's title) carry
// redacted text of at most one snippet, each as a text leaf naming why.
//
// Every POST that writes a human record carries an actionId (UI design 一 5); pair, notify-ack,
// client-state (idempotent by their natural keys), brake/plan (only plans, causes no transition) and
// the two unlock routes (they hand out the controller token, and act on no session) do not. 4xx and
// 503 replies write nothing to the journal.
//
// alpha 0.2 (slice design §2.7) adds the owned-session routes: the protocol only, frozen before any
// handler exists. Every one of them but the unlock pair needs the controller token as well as the
// pairing cookie, a GET too (auth 'unlocked'); the token comes only from an unlock code the daemon
// prints to its own console, so a page on another port that holds the cookie still cannot act.

export type { Shape, TextWhy };
/** The frame and payload shapes live in shared/protocol.js (plan §3); re-exported for the server's own modules. */
export { FRAMES, SHAPES };

const { en, re, int, bool, konst, text, nul, obj, arr } = S;

/** The CSRF token GET /api/session hands out: 32 random bytes, base64url. */
export const CSRF_RE = frozen(/^[A-Za-z0-9_-]{43}$/);
/** The pairing code: 8 digits (step 4). The unlock code (slice design §2.7) has the same form and the same throttle. */
export const PAIR_CODE_RE = frozen(/^[0-9]{8}$/);
/** A stage session id as the import routes name it: 20 lowercase hex digits (slice design §2.7). */
export const STAGE_ID_RE = frozen(/^[0-9a-f]{20}$/);
/** A feed position in GET /api/owned/:id/feed?after=: a query value is a string, so a decimal of at most 16 digits. */
export const SEQ_RE = frozen(/^(?:0|[1-9][0-9]{0,15})$/);
/** The header that carries the controller token; its value has CSRF_RE's form and is bound to the sid. */
export const CONTROL_HEADER = 'x-orchestra-csrf';
/**
 * The largest body an owned-session POST may send (slice design §2.7 check 7). Over it the request is
 * refused before its shape is read: 413 body-too-big (the design gave it no code; step 5 added one).
 */
export const OWNED_BODY_MAX_BYTES = 64 * 1024;
/**
 * The longest message, in UTF-8 bytes (r4 §10.11's single-field cap): over it the route's own 422
 * text-too-long, never cut short. The shape lets a longer text through to that check.
 */
export const OWNED_TEXT_MAX_BYTES = 2048;
/** A DSH session page on that origin: a path, never a query or a fragment, so never a token. */
export const DSH_LINK_RE = frozen(/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[1-9][0-9]{0,4}\/[A-Za-z0-9._~/-]{0,256}$/);

const id = re(ID_RE, 'id');
const uuid = re(UUID_RE, 'uuid');
const createTime = re(CREATE_TIME_RE, 'createTime');
const pid = int(1, 2 ** 32 - 1);
const ms = int();
const jseq = int();
const count = int();
const proc = obj({ pid, createTime });
const image = nul(re(IMAGE_NAME_RE, 'image'));
const itemFields = ITEM_FIELDS;
const ended = ENDED_FIELDS;

// --- the check order (plan line 588) -------------------------------------------------------------

export type CheckStep = 'auth' | 'ui-only' | 'actionId' | 'shape' | 'dedup' | 'item' | 'ended' | 'verb' | 'own' | 'execute';

export type Check = {
  readonly step: CheckStep;
  /** The HTTP status a refusal at this step gets (null: the step answers 200, or does not refuse). */
  readonly status: number | null;
  /** The error codes this step answers with. */
  readonly codes: readonly ErrorCode[];
  /** The ActionOutcome an accepted request that stops here gets. */
  readonly outcome?: string;
  /** Present only while a decision keeps the step out of the order. */
  readonly reservedBy?: 'D-17';
};

/**
 * Every step any route runs, in order. A human route runs exactly the order of plan line 588 (UI design
 * 一 5): auth, (ui-only), actionId, dedup, item, ended, verb, own, execute. There a body the route
 * cannot take is the actionId step's 400: actionId-missing when the actionId is absent or malformed,
 * the same status without a code for a body otherwise out of shape (the page never sends one; the
 * dedup after it needs the canonical body). The plan gives that second case no code of its own, and
 * none for the SSE tombstone's 409 or the 64 KiB / JSON-only refusals: an open question for step 4.
 * `shape` is the step of the routes that carry no actionId (pair, session, events, detail, brake/plan,
 * notify-ack, client-state, tuning): 400, no code. `ui-only` is D-17's slot: under its recommended
 * default a ui-only orchestrad serves no HTTP at all, so the slot is not in the order and the code is
 * reserved. `ended` answers 200 with noop:already-ended before `verb`: an ended item has no verbs. The
 * verb's own checks are text-too-long for a reminder and the brake's three codes.
 *
 * The owned-session routes (alpha 0.2) keep this order. Their `auth` step is slice design §2.7's checks
 * 1 to 6 (Host, cookie, Origin, Sec-Fetch-Site same-origin, JSON content type, and for 'unlocked' the
 * controller token: 403 not-unlocked); the body cap (check 7) comes before the shape, in the actionId
 * step: a body over OWNED_BODY_MAX_BYTES is 413 body-too-big (step 5's code). A message over
 * OWNED_TEXT_MAX_BYTES is 422 text-too-long and one starting with `/` is 422 slash-command, codes of the
 * `own` step; src/server/owned.ts runs both before the shape, in the design's order (its status is the
 * same either way, and a 4xx writes nothing). The
 * `item` step looks up the owned session or the stage session the route names (404 item-unknown); an
 * approval that is unknown or gone is the `own` step's approval-gone.
 */
export const CHECKS: readonly Check[] = Object.freeze([
  { step: 'auth', status: 403, codes: ['not-unlocked'] },
  { step: 'ui-only', status: 503, codes: ['ui-only'], reservedBy: 'D-17' },
  { step: 'actionId', status: 400, codes: ['actionId-missing', 'body-too-big'] },
  { step: 'shape', status: 400, codes: [] },
  { step: 'dedup', status: null, codes: ['in-flight', 'actionId-reused'] },
  { step: 'item', status: 404, codes: ['item-unknown'] },
  { step: 'ended', status: null, codes: [], outcome: 'noop:already-ended' },
  { step: 'verb', status: 422, codes: ['verb-not-allowed'] },
  {
    step: 'own', status: null, codes: [
      'text-too-long', 'brake-unavailable', 'not-test-root', 'plan-expired',
      'owned-disabled', 'owned-limit', 'desk-open', 'slash-command', 'digest-mismatch', 'approval-gone', 'stale-view', 'still-running', 'source-live', 'cwd-gone',
      'cwd-forbidden', 'unfinished-frame', 'source-changed', 'newer-format', 'import-too-big', 'gateway-real-data', 'owned-ended', 'queue-full',
      'request-gone', 'request-mismatch',
    ],
  },
  { step: 'execute', status: null, codes: [] },
].map((c) => Object.freeze({ ...c, codes: Object.freeze(c.codes as ErrorCode[]) })) as Check[]);

/** D-17 (open): does a ui-only orchestrad serve the page? The recommended default, which the code follows, is no. */
export const D17_SERVES_UI_ONLY = false;

/** The check order in force: CHECKS without a step whose decision keeps it out. */
export function checkOrder(servesUiOnly: boolean = D17_SERVES_UI_ONLY): readonly CheckStep[] {
  return CHECKS.filter((c) => c.reservedBy === undefined || servesUiOnly).map((c) => c.step);
}

// --- routes ----------------------------------------------------------------------------------------

export type Route = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /**
   * none: assets and the page; pair: POST /api/pair's own rules; session: the cookie (and for a POST,
   * Origin and the CSRF header); cookie: the cookie, and for a POST Origin, Sec-Fetch-Site same-origin
   * and a JSON body, with no token (the unlock pair); unlocked: all of cookie's checks plus the
   * controller token in CONTROL_HEADER, for a GET as well (slice design §2.7).
   */
  readonly auth: 'none' | 'pair' | 'session' | 'cookie' | 'unlocked';
  /** The human verb whose `human` and `human.result` records this route writes; such a body carries an actionId. */
  readonly human: HumanVerb | null;
  /** Where the item comes from, when the route acts on one. */
  readonly item: 'path' | 'body' | 'body-or-none' | null;
  /** What an owned-session route acts on: `:id` or the body's stageId names it (null: nothing, or an inbox item); request: an agent request (seat). */
  readonly target: 'owned' | 'approval' | 'stage' | 'request' | null;
  /** The steps of checkOrder() this route runs, in that order. */
  readonly checks: readonly CheckStep[];
  /** The verb's own checks (the `own` step) and the codes its execution may fail with. */
  readonly own: readonly ErrorCode[];
  readonly failures: readonly ErrorCode[];
  readonly query: Shape | null;
  readonly body: Shape | null;
  /** The 200 reply; null for an asset, a stream (GET /api/events), a reply without a body, or one a contract checks. */
  readonly reply: Shape | null;
  /** The reply shared/owned-contract.js checks (validateOwnedList, validateOwnedFeed: slice design §2.8, a later step), in place of a shape here. */
  readonly contract?: 'OwnedList' | 'OwnedFeed';
  /** A route that answers this status once its checks pass (POST /api/owned/unlock-code: 204, no body). */
  readonly status?: number;
};

const ACCEPTED: Shape = obj({ actionId: uuid, accepted: konst(true), jseq, replayed: konst(true) }, ['replayed']);
// A human route checks its body's shape inside the actionId step (see CHECKS): its order is plan line 588's.
const HUMAN_CHECKS: readonly CheckStep[] = ['auth', 'ui-only', 'actionId', 'dedup', 'execute'];
const ITEM_CHECKS: readonly CheckStep[] = ['auth', 'ui-only', 'actionId', 'dedup', 'item', 'ended', 'verb', 'own', 'execute'];

const DETAIL_REPLY = obj({
  asOfJseq: jseq,
  item: obj({ ...itemFields, ended: obj(ended, ['actionId']) }, ['reminder', 'ended']),
  peek: obj({
    events: arr(obj({ jseq, evKind: en(EVENT_KINDS), tool: nul(re(TOOL_NAME_RE, 'tool')), srcSeq: count, obsWall: ms }), 50),
    text: nul(text(SNIPPET_MAX_BYTES, 'peek')),
    textState: en(TEXT_STATES),
  }),
  open: {
    t: 'tagged',
    tag: 'kind',
    cases: {
      resume: { sessionId: uuid },
      native: { pid, host: image, windowTitle: nul(text(256, 'window-title')) },
      'dsh-link': { url: re(DSH_LINK_RE, 'dshLink') },
      none: {},
    },
  },
});

const PLAN_REPLY = obj({
  planId: id,
  itemId: id,
  harness: obj({ pid, createTime, image, multiSession: bool, selectable: bool }),
  /** Why no subtree may be braked (the harness's own creation time unreadable: the dialog is refused whole); null when the plan stands. */
  refused: nul(en(['identity-unknown'])),
  ttlMs: konst(PLAN_TTL_MS),
  /** The daemon's wall clock at the plan's making plus 60 s: the wall side of the expiry, and the page's countdown. */
  expiresAt: ms,
  subtrees: arr(obj({
    root: proc, image, nodes: count, rssBytes: count, protected: arr(proc, 512),
    /** Typing the PID is required: a protected node in the subtree, or the harness itself. */
    confirm: bool,
    /** Ticked by default: the subtree with the largest RSS. */
    selected: bool,
    /** The command line of the root, redacted and cut to one snippet, only for a selected subtree. */
    cmdline: nul(obj({ text: text(SNIPPET_MAX_BYTES, 'cmdline'), textState: en(TEXT_STATES) })),
  }), 64),
});

const TUNING_REPLY = obj({
  sources: arr(obj({
    source: en(HARNESSES), root: text(260, 'root-path'), version: nul(re(VERSION_RE, 'version')),
    counts: obj(Object.fromEntries(COUNT_NAMES.map((n) => [n, count]))),
    errors: arr(obj({ code: re(ERROR_CODE_RE, 'errorCode'), count, lastWall: ms }), 16),
    othersCount: count, pollIntervalMs: int(1), stalled: bool, lastPollWall: nul(ms), lastEventWall: nul(ms),
  }), HARNESSES.length),
});

const human = (verb: HumanVerb, item: Route['item'], body: Record<string, Shape>, own: ErrorCode[] = [], failures: ErrorCode[] = []): Route => ({
  method: 'POST', path: HUMAN_VERB_ROUTES[verb], auth: 'session', human: verb, item, target: null, checks: item === null ? HUMAN_CHECKS : ITEM_CHECKS,
  own, failures, query: null, body: obj({ actionId: uuid, ...body }), reply: ACCEPTED,
});
type PlainSpec = {
  query?: Shape; body?: Shape; reply: Shape | null; item?: Route['item']; target?: Route['target']; checks?: CheckStep[]; own?: ErrorCode[]; failures?: ErrorCode[];
  status?: number; contract?: Route['contract'];
};
const plain = (method: Route['method'], path: string, auth: Route['auth'], spec: PlainSpec): Route => {
  // Own fields only: a field left out of the literal reads undefined, never Object.prototype's.
  const o = ownFields(spec, ['query', 'body', 'reply', 'item', 'target', 'checks', 'own', 'failures', 'status', 'contract']);
  return {
    method, path, auth, human: null, item: o.item ?? null, target: o.target ?? null, checks: o.checks ?? ['auth', 'shape', 'execute'], own: o.own ?? [],
    failures: o.failures ?? [], query: o.query ?? null, body: o.body ?? null, reply: o.reply ?? null,
    ...(o.status === undefined ? {} : { status: o.status }), ...(o.contract === undefined ? {} : { contract: o.contract }),
  };
};

// --- the owned-session routes (alpha 0.2, slice design §2.7) ----------------------------------------

const stageId = re(STAGE_ID_RE, 'stageId');
/** Your message as a body carries it: up to the body cap as a shape; OWNED_TEXT_MAX_BYTES is the own check's. */
const message = text(OWNED_BODY_MAX_BYTES, 'message');
/** Accepted, as every human route answers (ACCEPTED's fields), plus what this verb hands back. */
const accepted = (extra: Record<string, Shape> = {}): Shape => obj({ actionId: uuid, accepted: konst(true), jseq, replayed: konst(true), ...extra }, ['replayed']);
const OWNED_CHECKS: readonly CheckStep[] = ['auth', 'ui-only', 'actionId', 'dedup', 'own', 'execute'];
const OWNED_TARGET_CHECKS: readonly CheckStep[] = ['auth', 'ui-only', 'actionId', 'dedup', 'item', 'own', 'execute'];
/** The body fields a route may leave out: a retry's confirmGone, a new session's model, the suggestion it came from, the agent request it answers, the project root it runs in, and whether it is the front desk. */
const OPTIONAL_BODY = ['confirmGone', 'model', 'routeId', 'requestId', 'root', 'frontDesk'];
/** An owned-session human route: the cookie and the controller token, a uuid actionId, the human record; never an inbox item. */
const owned = (verb: HumanVerb, target: Route['target'], body: Record<string, Shape>, reply: Shape, own: ErrorCode[] = [], failures: ErrorCode[] = []): Route => ({
  method: 'POST', path: HUMAN_VERB_ROUTES[verb], auth: 'unlocked', human: verb, item: null, target,
  checks: target === 'owned' || target === 'stage' ? OWNED_TARGET_CHECKS : OWNED_CHECKS,
  own, failures, query: null, body: obj({ actionId: uuid, ...body }, OPTIONAL_BODY.filter((k) => Object.hasOwn(body, k))), reply,
});
/** The harnesses a new owned session may run on (orchestra app plan section 2): Codex over app-server, Claude over its host. */
export const OWNED_HARNESSES: readonly ['codex', 'claude'] = frozen(['codex', 'claude'] as const);
/** What became of a message at once (POST /api/owned/:id/message's via): handed to codex, or waiting in orchestrad. */
export const MESSAGE_VIA: readonly ['turn/start', 'turn/steer', 'queued'] = frozen(['turn/start', 'turn/steer', 'queued'] as const);
/** What GET /api/import/:id/check finds the stage session can be: resumed, forked, copied as a DSH snapshot, or nothing. */
export const IMPORT_CAN: readonly ['resume', 'fork', 'dsh-snapshot', 'none'] = frozen(['resume', 'fork', 'dsh-snapshot', 'none'] as const);
/** How POST /api/import/claude takes a Claude session: resumed (it has ended) or forked (it may still be live). */
export const IMPORT_MODES: readonly ['resume', 'fork'] = frozen(['resume', 'fork'] as const);
const CLAUDE_IMPORT_OWN: ErrorCode[] = ['owned-disabled', 'gateway-real-data', 'owned-limit', 'source-live', 'unfinished-frame', 'source-changed', 'cwd-gone', 'cwd-forbidden', 'import-too-big'];
const DSH_IMPORT_OWN: ErrorCode[] = ['owned-disabled', 'gateway-real-data', 'newer-format', 'unfinished-frame', 'import-too-big'];
/** The codes GET /api/import/:id/check may give as `why`: the import routes' own checks, which the POST runs again on the spot. */
export const IMPORT_WHY: readonly ErrorCode[] = frozen([...new Set([...CLAUDE_IMPORT_OWN, ...DSH_IMPORT_OWN])]);
const IMPORT_CHECK_REPLY = obj({
  can: en(IMPORT_CAN),
  /** Why it cannot be imported (or, with can 'fork', why not resumed): the code the POST would answer; null when nothing stands in the way. */
  why: nul(en(IMPORT_WHY)),
  /** The cwd the confirmation shows you (POST /api/import/claude sends it back as cwdShown). */
  cwd: text(260, 'cwd'),
  /** How many files a copy would take. */
  files: count,
}, ['cwd', 'files']);
const SPAWN_FAILS: ErrorCode[] = ['host-tampered'];
/** A new session's child could not start: the gate refused it or its work dir could not be made. */
const NEW_FAILS: ErrorCode[] = [...SPAWN_FAILS, 'spawn-failed'];
const COPY_FAILS: ErrorCode[] = ['reparse-point', 'source-changed', 'rename-busy'];

// --- the dispatch desk (orchestra app plan §3) -------------------------------------------------------

/** A suggestion's id (src/route/desk.ts): 20 lowercase hex, like an owned session's. */
export const ROUTE_ID_RE = frozen(/^[0-9a-f]{20}$/);
/** An agent request's id (src/route/requests.ts, seat): 20 lowercase hex. */
export const AGENT_REQUEST_ID_RE = frozen(/^[0-9a-f]{20}$/);
const routeModel = re(OWNED_MODEL_RE, 'model');
/**
 * POST /api/route/suggest's reply: the "Route to?" card (r4 §9.2 step 10). Every candidate names its
 * harness, model and where it came from (a rule, by id, or the router model, with its redacted words);
 * the title is the router model's (redacted) or the sentence's first line, and titleSource says which;
 * full: the running owned sessions are at their limit (why every harness is off). It starts nothing.
 */
const SUGGEST_REPLY = obj({
  routeId: re(ROUTE_ID_RE, 'routeId'),
  title: text(60, 'route-title'),
  titleSource: en(['rule', 'model']),
  taskClass: en(TASK_CLASSES),
  rules: arr(en(RULE_IDS), RULE_IDS.length, 1),
  // pick: the candidate the router model chose, its own or a rule's it agreed with; null when it chose none.
  router: obj({ model: routeModel, state: en(ROUTER_STATES), why: nul(en(ROUTER_WHY)), pick: nul(int(0, MAX_CANDIDATES - 1)) }),
  candidates: arr(obj({
    harness: en(ROUTE_HARNESSES), model: routeModel, source: en(['rule', 'model']), rule: nul(en(RULE_IDS)), reason: nul(text(200, 'route-reason')),
  }), MAX_CANDIDATES),
  off: arr(en(ROUTE_HARNESSES), ROUTE_HARNESSES.length),
  full: bool,
});

/** Step 4's routes (plan step 4), with their shapes. GET /api/items/:id/detail replaces GET /api/items. */
export const ROUTES: readonly Route[] = Object.freeze([
  plain('GET', '/', 'none', { reply: null, checks: ['execute'] }),
  plain('GET', '/assets/*', 'none', { reply: null, checks: ['execute'] }),
  plain('POST', '/api/pair', 'pair', { body: obj({ code: re(PAIR_CODE_RE, 'pairCode') }), reply: obj({ paired: konst(true) }) }),
  plain('GET', '/api/session', 'session', {
    query: obj({ tab: uuid }),
    reply: obj({ csrf: re(CSRF_RE, 'csrf'), bootId: uuid, mode: en(MODES), profile: en(PROFILES), liveStreams: int(0, 2), superseded: bool }),
  }),
  plain('GET', '/api/events', 'session', { query: obj({ tab: uuid, perm: en(PERMISSIONS), why: en(WHY_REASONS) }), reply: null }),
  plain('GET', '/api/items/:id/detail', 'session', { reply: DETAIL_REPLY, item: 'path', checks: ['auth', 'shape', 'item', 'execute'] }),
  human('seen', 'path', {}),
  human('snooze', 'path', { preset: en(SNOOZE_PRESETS), untilWall: nul(ms) }),
  human('acted', 'path', {}),
  // The reminder text is at most a snippet as a shape; over REMINDER_TEXT_MAX code points it is the verb's own 422 text-too-long, never cut short.
  human('remind', 'body-or-none', { itemId: nul(id), dueWall: ms, text: text(SNIPPET_MAX_BYTES, 'reminder') }, ['text-too-long']),
  plain('POST', '/api/brake/plan', 'session', {
    body: obj({ itemId: id }), reply: PLAN_REPLY, item: 'body', checks: ['auth', 'ui-only', 'shape', 'item', 'verb', 'own', 'execute'], own: ['brake-unavailable', 'not-test-root'],
  }),
  human('brake', 'body', { itemId: id, planId: id, roots: arr(proc, 64, 1), confirm: arr(pid, 64) }, ['brake-unavailable', 'not-test-root', 'plan-expired']),
  human('roots-add', null, { path: text(260, 'path') }),
  human('roots-confirm', null, { rootId: id }),
  human('protect-add', null, { pid, createTime }, [], ['procguard-timeout']),
  human('protect-remove', null, { pid, createTime }, [], ['procguard-timeout']),
  plain('POST', '/api/notify-ack', 'session', { body: obj({ itemId: id, attempt: int(1), tabId: uuid, phase: en(ACK_PHASES) }), reply: obj({ ack: en(ACK_REPLIES) }) }),
  plain('POST', '/api/client-state', 'session', {
    body: obj({ tabId: uuid, visibility: en(VISIBILITIES), frozen: bool, permission: en(PERMISSIONS), perf: obj({ samples: arr(obj({ metric: en(PERF_METRICS), value: count }), 256) }) }, ['perf']),
    reply: obj({ ok: konst(true) }),
  }),
  human('dsh-connect', null, { url: text(2048, 'dsh-url') }),
  human('self-rating', null, { score: int(1, 5) }),
  plain('GET', '/api/tuning', 'session', { reply: TUNING_REPLY }),
  // alpha 0.2: owned sessions and imports (slice design §2.7). The approvals were reserved here (501) until now.
  plain('POST', '/api/owned/unlock-code', 'cookie', { reply: null, status: 204, checks: ['auth', 'execute'] }),
  plain('POST', '/api/owned/unlock', 'cookie', { body: obj({ code: re(PAIR_CODE_RE, 'unlockCode') }), reply: obj({ csrf: re(CSRF_RE, 'csrf') }), failures: ['not-unlocked'] }),
  plain('GET', '/api/owned', 'unlocked', { reply: null, contract: 'OwnedList' }),
  plain('GET', '/api/owned/:id/feed', 'unlocked', { query: obj({ after: re(SEQ_RE, 'seq') }, ['after']), reply: null, contract: 'OwnedFeed', target: 'owned', checks: ['auth', 'shape', 'item', 'execute'] }),
  plain('GET', '/api/import/:id/check', 'unlocked', { reply: IMPORT_CHECK_REPLY, target: 'stage', checks: ['auth', 'shape', 'item', 'execute'] }),
  // orchestra app: a new session names its harness and may name a model of the owned list (src/owned/models.ts).
  // The dispatch desk: a suggestion for one sentence (the rules, then the router model); it starts nothing and writes nothing.
  plain('POST', '/api/route/suggest', 'unlocked', {
    body: obj({ text: message }), reply: SUGGEST_REPLY, checks: ['auth', 'ui-only', 'shape', 'own', 'execute'], own: ['text-too-long', 'slash-command'],
  }),
  // routeId: the suggestion the person dispatched from (its RouteDecision goes into the same batch).
  // requestId (seat): the agent request this dispatch answers; its text and harness must be the card's
  // (request-mismatch), and it must still wait (request-gone). Its `agent-request` record joins the batch.
  // root (orchestra app plan 项目根): one of the project roots GET /api/owned lists (--project-root); the
  // session runs there. Any other path, or a root with a requestId (a request runs where its card said), is
  // cwd-forbidden: the page offers the list, never a free path.
  // frontDesk (src/route/front-desk.ts): you open the front desk, the same way you dispatch anything, on Claude, in its own work
  // dir; a second while one runs is desk-open.
  owned(
    'owned-new', null, {
      text: message, harness: en(OWNED_HARNESSES), model: re(OWNED_MODEL_RE, 'model'), routeId: re(ROUTE_ID_RE, 'routeId'), requestId: re(AGENT_REQUEST_ID_RE, 'requestId'),
      root: text(260, 'root-path'), frontDesk: konst(true),
    }, accepted({ ownedId: id }),
    ['owned-disabled', 'owned-limit', 'desk-open', 'text-too-long', 'slash-command', 'request-gone', 'request-mismatch', 'cwd-forbidden'], NEW_FAILS,
  ),
  // via: what became of it at once: handed to codex (turn/start, turn/steer) or waiting here (queued).
  owned('owned-message', 'owned', { text: message }, accepted({ uuid, queued: count, via: en(MESSAGE_VIA) }), ['text-too-long', 'slash-command', 'owned-ended', 'queue-full']),
  owned('owned-interrupt', 'owned', {}, accepted({ withdrawn: count, denied: count })),
  owned('owned-end', 'owned', {}, accepted()),
  // The brake (r4 D4, D8): the session's whole Job ended now. killed: the processes it held; left: those
  // still counted after the wait (0: the whole tree stopped); each null when procguard could not say (T1).
  // A session that runs without a Job (procguard off) is brake-unavailable; one that ended, owned-ended.
  owned('owned-brake', 'owned', {}, accepted({ killed: nul(count), left: nul(count) }), ['owned-ended', 'brake-unavailable']),
  owned('owned-retry', 'owned', { confirmGone: konst(true) }, accepted(), ['owned-disabled', 'owned-limit', 'still-running', 'cwd-gone', 'cwd-forbidden'], SPAWN_FAILS),
  owned('approval-allow', 'approval', { digest: re(DIGEST_RE, 'digest'), rev: count }, accepted(), ['approval-gone', 'digest-mismatch', 'stale-view']),
  owned('approval-deny', 'approval', {}, accepted(), ['approval-gone']),
  owned(
    'import-claude', 'stage', { stageId, mode: en(IMPORT_MODES), cwdShown: text(260, 'cwd') }, accepted({ importId: id, ownedId: id }),
    CLAUDE_IMPORT_OWN, [...COPY_FAILS, ...SPAWN_FAILS],
  ),
  owned('import-dsh', 'stage', { stageId }, accepted({ importId: id }), DSH_IMPORT_OWN, COPY_FAILS),
  // seat: you reject an agent request (r4 A17, D8: a person, this page). One that no longer waits is request-gone.
  owned('request-reject', 'request', {}, accepted(), ['request-gone']),
  // You set a session's dispatch permission (src/route/dispatch.ts; D8: a person, this page). 你不在也派 is no level here:
  // r4 D20 does not allow it, so the shape refuses it. A session that ended is owned-ended.
  owned('dispatch-grant', 'owned', { level: en(GRANT_LEVELS) }, accepted({ level: en(GRANT_LEVELS) }), ['owned-ended']),
  // A question card's answer: one pick a question, in their order: an option by its place in the list, or a text. Picks that
  // do not fit the questions the card drew are declined as a wrong digest is (digest-mismatch), the same checks as an allow.
  owned('approval-answer', 'approval', {
    digest: re(DIGEST_RE, 'digest'), rev: count,
    answers: arr(obj({ option: int(0, QUESTION_LIMITS.options - 1), text: text(QUESTION_LIMITS.textCp, 'message') }, ['option', 'text']), QUESTION_LIMITS.questions, 1),
  }, accepted(), ['approval-gone', 'digest-mismatch', 'stale-view']),
].map((r) => Object.freeze(r)));

/** The route of `method path` (a pattern as the table writes it), or undefined. */
export function routeOf(method: string, path: string): Route | undefined {
  return ROUTES.find((r) => r.method === method && r.path === path);
}

/** The error table (shared/protocol.js ERROR_STATUS), restated here as the server answers it: code, status, and whether the code is reserved. */
export const ERROR_TABLE: readonly { readonly code: ErrorCode; readonly status: number; readonly reserved: boolean }[] = Object.freeze(
  ERROR_CODES.map((code) => Object.freeze({ code, status: ERROR_STATUS[code], reserved: CHECKS.some((c) => c.reservedBy !== undefined && c.codes.includes(code)) })),
);

// --- the shape check -------------------------------------------------------------------------------

export type ShapeWhy = 'type' | 'missing' | 'extra-key' | 'not-plain' | 'grammar' | 'enum' | 'range' | 'too-long' | 'const' | `title:${string}`;
export type ShapeError = { readonly at: string; readonly why: ShapeWhy };

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** An own data property; an accessor counts as missing (its getter never runs). */
function own(o: object, k: string): { has: boolean; value: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && 'value' in d ? { has: true, value: d.value } : { has: false, value: undefined };
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function fieldsError(v: unknown, fields: Readonly<Record<string, Shape>>, optional: readonly string[], at: string): ShapeError | null {
  if (!isPlain(v)) return { at, why: 'not-plain' };
  if (Object.getOwnPropertySymbols(v).length > 0) return { at, why: 'extra-key' };
  const keys = Object.keys(fields);
  for (const k of Object.getOwnPropertyNames(v)) if (!keys.includes(k)) return { at, why: 'extra-key' };
  for (const k of keys) {
    const f = own(v, k);
    if (!f.has) {
      if (optional.includes(k) && !Object.hasOwn(v, k)) continue;
      return { at: `${at}.${k}`, why: 'missing' };
    }
    const e = shapeError(fields[k]!, f.value, `${at}.${k}`);
    if (e !== null) return e;
  }
  return null;
}

/**
 * Why `v` is not of `shape`, or null. Own data properties only, plain objects and arrays only, every
 * listed field present unless the shape names it optional, no other key; a string through its grammar
 * or enum, a text well-formed and within its code points, an integer safe and within its range.
 */
export function shapeError(shape: Shape, v: unknown, at = '$'): ShapeError | null {
  switch (shape.t) {
    case 'enum':
      return typeof v !== 'string' ? { at, why: 'type' } : shape.of.includes(v) ? null : { at, why: 'enum' };
    case 're':
      return typeof v !== 'string' ? { at, why: 'type' } : shape.re.test(v) ? null : { at, why: 'grammar' };
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { at, why: 'type' };
      return v < shape.min || v > shape.max ? { at, why: 'range' } : null;
    case 'bool':
      return typeof v === 'boolean' ? null : { at, why: 'type' };
    case 'const':
      return v === shape.value ? null : { at, why: 'const' };
    case 'title': {
      const e = titleError(v);
      return e === null ? null : { at, why: `title:${e}` };
    }
    case 'text':
      if (typeof v !== 'string' || !v.isWellFormed()) return { at, why: 'type' };
      return codePoints(v) > shape.maxCp ? { at, why: 'too-long' } : null;
    case 'null':
      return v === null ? null : shapeError(shape.of, v, at);
    case 'obj':
      return fieldsError(v, shape.fields, shape.optional, at);
    case 'arr': {
      if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return { at, why: 'type' };
      if (Object.getOwnPropertySymbols(v).length > 0) return { at, why: 'extra-key' };
      for (const k of Object.getOwnPropertyNames(v)) if (k !== 'length' && !(String(Number(k)) === k && Number(k) < v.length)) return { at, why: 'extra-key' };
      if (v.length < shape.min || v.length > shape.max) return { at, why: 'range' };
      for (let i = 0; i < v.length; i++) {
        const f = own(v, String(i));
        if (!f.has) return { at: `${at}[${i}]`, why: 'missing' };
        const e = shapeError(shape.of, f.value, `${at}[${i}]`);
        if (e !== null) return e;
      }
      return null;
    }
    case 'tagged': {
      if (!isPlain(v)) return { at, why: 'not-plain' };
      const tag = own(v, shape.tag);
      if (!tag.has) return { at: `${at}.${shape.tag}`, why: 'missing' };
      if (typeof tag.value !== 'string' || !Object.hasOwn(shape.cases, tag.value)) return { at: `${at}.${shape.tag}`, why: 'enum' };
      return fieldsError(v, { [shape.tag]: konst(tag.value), ...shape.cases[tag.value]! }, [], at);
    }
  }
}

/** Every text leaf of a shape, by why: a frame may hold only `reminder` (routes.test walks FRAMES with it). */
export function textLeaves(shape: Shape): TextWhy[] {
  switch (shape.t) {
    case 'text':
      return [shape.why];
    case 'null':
      return textLeaves(shape.of);
    case 'arr':
      return textLeaves(shape.of);
    case 'obj':
      return Object.values(shape.fields).flatMap(textLeaves);
    case 'tagged':
      return Object.values(shape.cases).flatMap((c) => Object.values(c).flatMap(textLeaves));
    default:
      return [];
  }
}

// This module's tables through and through, their RegExps included (shared/frozen.js), so no module
// can widen a route at run time. SHAPES and FRAMES are shared/protocol.js's, which freezes them itself.
frozen([CHECKS, ROUTES, ERROR_TABLE]);
