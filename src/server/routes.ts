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
import { ERROR_CODE_RE, EVENT_KINDS } from '../store/records.ts';

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
// client-state (idempotent by their natural keys) and brake/plan (only plans, causes no transition)
// do not. 4xx and 503 replies write nothing to the journal.

export type { Shape, TextWhy };
/** The frame and payload shapes live in shared/protocol.js (plan §3); re-exported for the server's own modules. */
export { FRAMES, SHAPES };

const { en, re, int, bool, konst, text, nul, obj, arr } = S;

/** The CSRF token GET /api/session hands out: 32 random bytes, base64url. */
export const CSRF_RE = frozen(/^[A-Za-z0-9_-]{43}$/);
/** The pairing code: 8 digits (step 4). */
export const PAIR_CODE_RE = frozen(/^[0-9]{8}$/);
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
 */
export const CHECKS: readonly Check[] = Object.freeze([
  { step: 'auth', status: 403, codes: [] },
  { step: 'ui-only', status: 503, codes: ['ui-only'], reservedBy: 'D-17' },
  { step: 'actionId', status: 400, codes: ['actionId-missing'] },
  { step: 'shape', status: 400, codes: [] },
  { step: 'dedup', status: null, codes: ['in-flight', 'actionId-reused'] },
  { step: 'item', status: 404, codes: ['item-unknown'] },
  { step: 'ended', status: null, codes: [], outcome: 'noop:already-ended' },
  { step: 'verb', status: 422, codes: ['verb-not-allowed'] },
  { step: 'own', status: null, codes: ['text-too-long', 'brake-unavailable', 'not-test-root', 'plan-expired'] },
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
  /** none: assets and the page; pair: POST /api/pair's own rules; session: the cookie (and for a POST, Origin and the CSRF header). */
  readonly auth: 'none' | 'pair' | 'session';
  /** The human verb whose `human` and `human.result` records this route writes; such a body carries an actionId. */
  readonly human: HumanVerb | null;
  /** Where the item comes from, when the route acts on one. */
  readonly item: 'path' | 'body' | 'body-or-none' | null;
  /** The steps of checkOrder() this route runs, in that order. */
  readonly checks: readonly CheckStep[];
  /** The verb's own checks (the `own` step) and the codes its execution may fail with. */
  readonly own: readonly ErrorCode[];
  readonly failures: readonly ErrorCode[];
  readonly query: Shape | null;
  readonly body: Shape | null;
  /** The 200 reply; null for an asset, a stream (GET /api/events) or a reserved route. */
  readonly reply: Shape | null;
  /** A route that answers this status once authenticated (the reserved approvals: 501). */
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
  method: 'POST', path: HUMAN_VERB_ROUTES[verb], auth: 'session', human: verb, item, checks: item === null ? HUMAN_CHECKS : ITEM_CHECKS,
  own, failures, query: null, body: obj({ actionId: uuid, ...body }), reply: ACCEPTED,
});
type PlainSpec = { query?: Shape; body?: Shape; reply: Shape | null; item?: Route['item']; checks?: CheckStep[]; own?: ErrorCode[]; status?: number };
const plain = (method: Route['method'], path: string, auth: Route['auth'], spec: PlainSpec): Route => {
  // Own fields only: a field left out of the literal reads undefined, never Object.prototype's.
  const o = ownFields(spec, ['query', 'body', 'reply', 'item', 'checks', 'own', 'status']);
  return {
    method, path, auth, human: null, item: o.item ?? null, checks: o.checks ?? ['auth', 'shape', 'execute'], own: o.own ?? [], failures: [],
    query: o.query ?? null, body: o.body ?? null, reply: o.reply ?? null, ...(o.status === undefined ? {} : { status: o.status }),
  };
};

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
  plain('POST', '/api/approvals/:id/allow', 'session', { reply: null, status: 501, checks: ['auth', 'execute'] }),
  plain('POST', '/api/approvals/:id/deny', 'session', { reply: null, status: 501, checks: ['auth', 'execute'] }),
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
