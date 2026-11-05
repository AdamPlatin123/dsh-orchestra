// @ts-check
// The contract the daemon and the page share (plan step 3, UI design section 一): the one source of
// the human verbs, the error codes, the end classes, the ActionOutcome enum, the id grammar, the
// title-arg grammars, the frame and payload shapes (plan §3: 「SSE 帧与载荷形状」) and the row order.
// Step 3 freezes the enums and the regexes; the frame and payload shapes and the row order are frozen
// with step 4. Every exported table and grammar is frozen through and through (shared/frozen.js): a
// RegExp too, with its own compile() that throws. Plain ESM that imports only shared/constants.js and
// shared/frozen.js: the page loads this file as it is
// (/assets/shared/protocol.js), so it uses no Node builtin (builtin-policy.ts, NO_BUILTIN_DIRS) and
// nothing outside shared/ (static rule shared-imports-shared-only).

import { ENDED_MAX, HUE_COUNT, ITEMS_MAX, RECENT_ACTIONS_MAX, REMINDER_TEXT_MAX, TICK_MS } from './constants.js';
import { frozen } from './frozen.js';

/** Every frame carries v = 1 (UI design 一 1). */
export const PROTOCOL_V = 1;

/**
 * The human verbs: each one writes a `human` and a `human.result` journal record, and is what
 * ActionOutcome.verb names (UI design 一 5). The routes that take them are HUMAN_VERB_ROUTES. From
 * `owned-new` on: the owned-session verbs of alpha 0.2 (slice design §2.7); `request-reject`: seat's refusal of an agent request.
 */
export const HUMAN_VERBS = Object.freeze(/** @type {const} */ ([
  'seen', 'snooze', 'acted', 'remind', 'brake', 'roots-add', 'roots-confirm', 'protect-add', 'protect-remove', 'dsh-connect', 'self-rating',
  'owned-new', 'owned-message', 'owned-interrupt', 'owned-end', 'owned-brake', 'owned-retry', 'approval-allow', 'approval-deny', 'import-claude', 'import-dsh',
  'request-reject', 'dispatch-grant',
]));
/** @typedef {typeof HUMAN_VERBS[number]} HumanVerb */

/** The POST route of each human verb (step 4's route table); `:id` is an item, owned-session or approval id. */
export const HUMAN_VERB_ROUTES = Object.freeze(/** @type {const} */ ({
  seen: '/api/items/:id/seen',
  snooze: '/api/items/:id/snooze',
  acted: '/api/items/:id/acted',
  remind: '/api/reminders',
  brake: '/api/brake/execute',
  'roots-add': '/api/roots/add',
  'roots-confirm': '/api/roots/confirm',
  'protect-add': '/api/protect/add',
  'protect-remove': '/api/protect/remove',
  'dsh-connect': '/api/dsh-connect',
  'self-rating': '/api/self-rating',
  'owned-new': '/api/owned/new',
  'owned-message': '/api/owned/:id/message',
  'owned-interrupt': '/api/owned/:id/interrupt',
  'owned-end': '/api/owned/:id/end',
  // The owned session's brake (orchestra app, r4 D4/D8): its whole process tree, by its procguard Job.
  'owned-brake': '/api/owned/:id/brake',
  'owned-retry': '/api/owned/:id/retry',
  'approval-allow': '/api/approvals/:id/allow',
  'approval-deny': '/api/approvals/:id/deny',
  'import-claude': '/api/import/claude',
  'import-dsh': '/api/import/dsh',
  // seat: a person rejects an agent request (r4 A17; D8: only on this page). Its dispatch is owned-new with the requestId.
  'request-reject': '/api/agent-requests/:id/reject',
  // A person sets a session's dispatch permission (src/route/dispatch.ts; D8: only on this page, never on the agent port).
  'dispatch-grant': '/api/owned/:id/dispatch-grant',
}));

/**
 * The verbs an ItemView may offer (`item.verbs`, computed by the daemon from kind and state). The row
 * hint is the command table ∩ these; open and peek only read (GET .../detail) and write nothing.
 */
export const ITEM_VERBS = Object.freeze(/** @type {const} */ (['open', 'peek', 'seen', 'snooze', 'remind', 'acted', 'brake']));
/** @typedef {typeof ITEM_VERBS[number]} ItemVerb */

/**
 * Every error code an HTTP reply may carry, with its status, in the order of UI design 一 5's table.
 * 4xx and 503 replies write nothing to the journal. `ui-only` is reserved: under D-17's default a
 * ui-only orchestrad serves no HTTP at all, so nothing sends it in M0.
 */
export const ERROR_STATUS = Object.freeze(/** @type {const} */ ({
  'in-flight': 409,
  'actionId-reused': 422,
  'actionId-missing': 400,
  'verb-not-allowed': 422,
  'ui-only': 503,
  'item-unknown': 404,
  'text-too-long': 422,
  'brake-unavailable': 503,
  'not-test-root': 422,
  'procguard-timeout': 503,
  'plan-expired': 409,
  // alpha 0.2's owned sessions and imports (slice design §2.7)
  'not-unlocked': 403,
  'owned-disabled': 409,
  'owned-limit': 409,
  'desk-open': 409,
  'slash-command': 422,
  'digest-mismatch': 409,
  'approval-gone': 409,
  'stale-view': 409,
  'still-running': 409,
  'source-live': 409,
  'cwd-gone': 409,
  'cwd-forbidden': 409,
  'unfinished-frame': 409,
  'source-changed': 409,
  'newer-format': 409,
  'reparse-point': 409,
  'import-too-big': 413,
  'gateway-real-data': 409,
  'rename-busy': 503,
  'host-tampered': 503,
  // alpha 0.2 step 5: an owned-session body over OWNED_BODY_MAX_BYTES (src/server/routes.ts), refused before it is read as JSON
  'body-too-big': 413,
  // orchestra app: owned session ended, its queue full, its child not started
  'owned-ended': 409,
  'queue-full': 409,
  'spawn-failed': 503,
  // seat: the agent request a dispatch or a refusal names is gone (decided, expired, withdrawn, forgotten), or is not what the card showed
  'request-gone': 409,
  'request-mismatch': 409,
}));
/** @typedef {keyof typeof ERROR_STATUS} ErrorCode */
/** @type {readonly ErrorCode[]} */
export const ERROR_CODES = Object.freeze(/** @type {ErrorCode[]} */ (Object.keys(ERROR_STATUS)));
/** @type {readonly ErrorCode[]} */
export const RESERVED_ERROR_CODES = Object.freeze(/** @type {ErrorCode[]} */ (['ui-only']));

/**
 * How an item ended (EndView.end; r4 §6.5 for M0): you acted, the source resolved it, or it expired.
 * Each needs a different reading, so each renders differently (P1).
 */
export const END_CLASSES = Object.freeze(/** @type {const} */ (['acted', 'auto-cleared', 'expired']));
/** @typedef {typeof END_CLASSES[number]} EndClass */

/**
 * What caused a transition, and so an end (EndView.cause; I01): a source event, a human action or a
 * clock timer. A transition record without one of these is refused when applied.
 */
export const CAUSE_KINDS = Object.freeze(/** @type {const} */ (['source', 'human', 'clock']));

/**
 * The reasons an accepted human action changed nothing. Only `already-ended` exists in M0 (UI design
 * 一 5): an ended item has no verbs, so the check order answers before the verb check.
 */
export const NOOP_REASONS = Object.freeze(/** @type {const} */ (['already-ended']));

/**
 * ActionOutcome.outcome: `applied`, `noop:<reason>` or `unknown` (an orphan `human` record closed by
 * the startup reconciliation, or a dsh-connect request that timed out). Read from `human.result` only.
 * @type {readonly string[]}
 */
export const ACTION_OUTCOMES = Object.freeze(['applied', ...NOOP_REASONS.map((r) => `noop:${r}`), 'unknown']);

/** @param {unknown} x @returns {boolean} */
export function isActionOutcome(x) {
  return typeof x === 'string' && ACTION_OUTCOMES.includes(x);
}

/**
 * A brake subtree's status in ActionOutcome.brake (UI design 一 2): killed with no residue, killed with
 * residue, not touched because the pre-kill check failed, or no verdict from procguard.
 */
export const BRAKE_STATUSES = Object.freeze(/** @type {const} */ (['ok', 'partial', 'refused', 'unknown']));

/**
 * Ids the daemon makes (items, projects, parts, reminders, commands, plans) and the entity part of a
 * timerId: ASCII letters, digits, '_' and '-', 1 to 64, starting with a letter or a digit. No ':' and
 * no '.', so an id composes into `${class}:${entityId}:${seq}` and `<bootId>.<jseq>` without ambiguity.
 */
export const ID_RE = frozen(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/** Ids made by crypto.randomUUID() (actionId and tabId on the page, bootId in the daemon): lowercase, version 4. */
export const UUID_RE = frozen(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** A tool name as a title arg (and as a journal source string). */
export const TOOL_NAME_RE = frozen(/^[A-Za-z0-9_.:-]{1,64}$/);

/** A semver-like version as a title arg (and as a journal source string). */
export const VERSION_RE = frozen(/^\d{1,5}(?:\.\d{1,5}){1,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/);

/** At most this many code points in a cwd tail title arg. */
export const CWD_TAIL_MAX = 32;

/**
 * A cwd tail as a title arg: 1 to 32 code points with no control (Cc), format (Cf: the zero-width and
 * bidi controls U+200B–200F, U+202A–202E, U+2066–2069 among them), lone surrogate (Cs), line or
 * paragraph separator, and no path separator. An agent can cd into a crafted directory name, and a
 * system notification cannot be taken back (UI design 一 2).
 */
export const CWD_TAIL_RE = frozen(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\/]{1,32}$/u);

/** At most this many code points in a project name you set in Tuning. */
export const PROJECT_NAME_MAX = 64;

/**
 * A project's display name you renamed in Tuning (UI design 一 2: exempt from the cwd-tail check): 1
 * to 64 code points with no control, format, lone surrogate, line or paragraph separator, path
 * separators allowed. Every cwd tail passes it too, so a title's `project` arg and a frame's
 * project.name are held to this grammar, and the daemon picks which name (cwdTailArg or yours).
 */
export const PROJECT_NAME_RE = frozen(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]{1,64}$/u);

/** @param {unknown} s @returns {string | null} the tool name, or null when it may not be shown */
export function toolNameArg(s) {
  return typeof s === 'string' && TOOL_NAME_RE.test(s) ? s : null;
}

/** @param {unknown} s @returns {string | null} the version, or null when it may not be shown */
export function versionArg(s) {
  return typeof s === 'string' && VERSION_RE.test(s) ? s : null;
}

/**
 * The last segment of a cwd (Windows or POSIX separators, trailing ones ignored) when it may be shown
 * as a title arg; null otherwise, and the caller shows the project's short id instead.
 * @param {unknown} cwd
 * @returns {string | null}
 */
export function cwdTailArg(cwd) {
  if (typeof cwd !== 'string') return null;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  const tail = parts.at(-1);
  return tail !== undefined && CWD_TAIL_RE.test(tail) ? tail : null;
}

/** The inbox groups, top to bottom (r4 §11.2). */
export const GROUPS = Object.freeze(/** @type {const} */ (['fermatas', 'wrong-notes', 'ready-for-review', 'reminders']));
/** Severity levels, most urgent first (r4 §11.2). */
export const SEVERITIES = Object.freeze(/** @type {const} */ (['P0', 'P1', 'P2', 'P3']));

/**
 * The InboxItem kinds M0 can open (r4 §6.1, §11.2; plan §2.2 items 5, 6, 12). Their group, levels,
 * confidences and verbs are src/model/inbox.ts's kind table, which reads this list.
 */
export const ITEM_KINDS = Object.freeze(/** @type {const} */ (['approval', 'question', 'failure', 'runaway', 'policy', 'ready-for-review', 'flood', 'reminder', 'unknown-outcome']));
/** @typedef {typeof ITEM_KINDS[number]} ItemKind */

/** How sure the daemon is that an item is what its kind says; `low` is the guess class (「推测」, plan §2.2 item 5). */
export const CONFIDENCES = Object.freeze(/** @type {const} */ (['high', 'low']));

/**
 * The states an item shows (ItemView.state, r4 §6.5 for M0): three live ones, then the end classes.
 * The daemon's own `none`, before the creating transition, never leaves it.
 */
export const ITEM_STATES = Object.freeze(/** @type {const} */ (['open', 'seen', 'snoozed', 'acted', 'auto-cleared', 'expired']));

/** A Windows process creation time as procguard writes it: a decimal string, never 0 (identity unknown). */
export const CREATE_TIME_RE = frozen(/^[1-9][0-9]{0,19}$/);

/** A process image's base name as the brake dialog shows it (rg.exe); anything else shows ARG_UNKNOWN. */
export const IMAGE_NAME_RE = frozen(/^[A-Za-z0-9_.+-]{1,64}$/);

/**
 * Title keys (UI design 一 2): a title is `{key, args}`, never text, and shared/strings.js holds the
 * text of every key. One key per kind; the two guess classes have keys of their own, whose text starts
 * with 推测 (strings.test).
 * @type {readonly string[]}
 */
export const TITLE_KEYS = Object.freeze([
  'item.approval', 'item.approval.guess', 'item.question', 'item.question.guess', 'item.failure', 'item.runaway',
  'item.policy', 'item.flood', 'item.ready-for-review', 'item.reminder', 'item.unknown-outcome',
]);

/** The args a title may carry: the project's display name and the two checked journal fields. */
export const TITLE_ARG_NAMES = Object.freeze(/** @type {const} */ (['project', 'tool', 'version']));

/** @param {unknown} v */
const plainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** @param {object} o @param {string} k @returns {{ has: boolean, value: unknown }} an own data property; an accessor counts as missing */
const ownData = (o, k) => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && 'value' in d ? { has: true, value: d.value } : { has: false, value: undefined };
};

/**
 * Why `title` may not go into a frame, or null. A title is a plain `{key, args}`: the key from
 * TITLE_KEYS, the args own data fields from TITLE_ARG_NAMES, each through its grammar (project as a
 * project name: a cwd tail, a project's short id or a name you set all pass it; tool and version as
 * the title-arg grammars). So no frame carries a string a source chose that did not pass a grammar.
 * @param {unknown} title
 * @returns {'shape' | 'key' | 'args' | 'arg-name' | 'project' | 'tool' | 'version' | null}
 */
export function titleError(title) {
  if (!plainObject(title)) return 'shape';
  const t = /** @type {object} */ (title);
  const names = Object.getOwnPropertyNames(t);
  if (Object.getOwnPropertySymbols(t).length > 0 || names.length !== 2 || !names.includes('key') || !names.includes('args')) return 'shape';
  const key = ownData(t, 'key');
  if (!key.has || typeof key.value !== 'string' || !TITLE_KEYS.includes(key.value)) return 'key';
  const args = ownData(t, 'args');
  if (!args.has || !plainObject(args.value)) return 'args';
  const a = /** @type {object} */ (args.value);
  if (Object.getOwnPropertySymbols(a).length > 0) return 'arg-name';
  for (const n of Object.getOwnPropertyNames(a)) {
    if (!(/** @type {readonly string[]} */ (TITLE_ARG_NAMES)).includes(n)) return 'arg-name';
    const v = ownData(a, n);
    if (!v.has || typeof v.value !== 'string') return /** @type {'project' | 'tool' | 'version'} */ (n);
    const re = n === 'project' ? PROJECT_NAME_RE : n === 'tool' ? TOOL_NAME_RE : VERSION_RE;
    if (!re.test(v.value)) return /** @type {'project' | 'tool' | 'version'} */ (n);
  }
  return null;
}

/**
 * The payload enums of UI design 一 (frames, client-state, notify-ack, detail). The frame and payload
 * shapes around them (SHAPES, FRAMES below) are frozen with step 4.
 */
/** The five frames (UI design 一 1); `delta` keeps its shape in FRAMES and is not sent in M0. */
export const FRAME_KINDS = Object.freeze(/** @type {const} */ (['snapshot', 'status', 'tick', 'notify', 'bye']));
/** Why a stream ends (bye.reason). */
export const BYE_REASONS = Object.freeze(/** @type {const} */ (['shutdown', 'superseded', 'replaced', 'backpressure']));
/** Why the page opens a stream (GET /api/events `why`). */
export const WHY_REASONS = Object.freeze(/** @type {const} */ (['open', 'reload', 'gap', 'stale', 'probe', 'backpressure']));
/** The page's notification permission (`perm`, client-state `permission`). */
export const PERMISSIONS = Object.freeze(/** @type {const} */ (['granted', 'denied', 'default']));
export const VISIBILITIES = Object.freeze(/** @type {const} */ (['visible', 'hidden']));
/** A notify ack's phase (D-15): handed to the system, shown by it, or an error event. */
export const ACK_PHASES = Object.freeze(/** @type {const} */ (['dispatched', 'shown', 'error']));
export const MODES = Object.freeze(/** @type {const} */ (['working', 'ui-only']));
/** Why orchestrad is ui-only (snapshot `modeReasons`; src/runtime/startup.ts and the journal check). Reserved with `ui-only`: under D-17's default no page is served then. */
export const MODE_REASONS = Object.freeze(/** @type {const} */ (['integrity-low', 'integrity-unknown', 'data-dir', 'journal-chain']));
export const PROFILES = Object.freeze(/** @type {const} */ (['real', 'test']));
/** ItemView.notify: no notification due, one due and not yet acked, handed to the system or shown by the toast. */
export const NOTIFY_STATES = Object.freeze(/** @type {const} */ (['none', 'pending', 'handed']));
/** What a piece of purgeable text is now (peek, a reminder's text): there, past its TTL, cleared by you, or gone with a lost database. */
export const TEXT_STATES = Object.freeze(/** @type {const} */ (['present', 'expired', 'purged', 'lost']));
/** How `o` opens an item (plan §2.2 item 9). */
export const OPEN_KINDS = Object.freeze(/** @type {const} */ (['resume', 'native', 'dsh-link', 'none']));
/** The snooze choices (UI design 三 1): the daemon turns a preset into UTC milliseconds; custom carries them. */
export const SNOOZE_PRESETS = Object.freeze(/** @type {const} */ (['15m', '1h', 'tonight', 'tomorrow', 'custom']));
/** The UI latency samples client-state's optional `perf` carries (plan step 19). */
export const PERF_METRICS = Object.freeze(/** @type {const} */ (['frame-to-paint-ms', 'key-event-ms', 'long-frames', 'notify-handle-ms', 'no-result-yet', 'brake-unknown']));

/** The harnesses M0 observes (a part's harness, a source's name). */
export const HARNESSES = Object.freeze(/** @type {const} */ (['claude', 'dsh', 'codex']));

/** A part's short form on a row. */
export const PART_SHORT_RE = frozen(/^[A-Za-z0-9_-]{1,12}$/);
/** The origin of the /connect URL you pasted: loopback http only, no token, no path (r4 §10.11). */
export const DSH_ORIGIN_RE = frozen(/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[1-9][0-9]{0,4}$/);

// --- frame and payload shapes (UI design 一 1, 2) --------------------------------------------------
// Data, so a test can walk them and the server can check every frame (src/server/routes.ts
// shapeError): no frame has a leaf for source free text. A string in a frame is an enum, an id, or a
// value through one of the grammars above (a title is {key, args}, titleError); the one text a frame
// may carry is your own reminder's (ItemView.reminder, with its textState).

/** @typedef {'reminder' | 'peek' | 'cmdline' | 'window-title' | 'path' | 'dsh-url' | 'root-path' | 'message' | 'cwd' | 'route-title' | 'route-reason'} TextWhy */
/**
 * @typedef {{ readonly t: 'enum', readonly of: readonly string[] }
 *   | { readonly t: 're', readonly re: RegExp, readonly name: string }
 *   | { readonly t: 'int', readonly min: number, readonly max: number }
 *   | { readonly t: 'bool' }
 *   | { readonly t: 'const', readonly value: string | number | boolean }
 *   | { readonly t: 'title' }
 *   | { readonly t: 'text', readonly maxCp: number, readonly why: TextWhy }
 *   | { readonly t: 'null', readonly of: Shape }
 *   | { readonly t: 'obj', readonly fields: Readonly<Record<string, Shape>>, readonly optional: readonly string[] }
 *   | { readonly t: 'arr', readonly of: Shape, readonly max: number, readonly min: number }
 *   | { readonly t: 'tagged', readonly tag: string, readonly cases: Readonly<Record<string, Readonly<Record<string, Shape>>>> }} Shape
 */

/** The shape builders, for this file and for src/server/routes.ts's route shapes. */
export const S = frozen({
  /** @param {readonly string[]} of @returns {Shape} */
  en: (of) => ({ t: 'enum', of }),
  /** @param {RegExp} r @param {string} name @returns {Shape} */
  re: (r, name) => ({ t: 're', re: r, name }),
  /** @param {number} [min] @param {number} [max] @returns {Shape} */
  int: (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ t: 'int', min, max }),
  /** @type {Shape} */
  bool: { t: 'bool' },
  /** @param {string | number | boolean} value @returns {Shape} */
  konst: (value) => ({ t: 'const', value }),
  /** @type {Shape} */
  title: { t: 'title' },
  /** @param {number} maxCp @param {TextWhy} why @returns {Shape} */
  text: (maxCp, why) => ({ t: 'text', maxCp, why }),
  /** @param {Shape} of @returns {Shape} */
  nul: (of) => ({ t: 'null', of }),
  /** @param {Record<string, Shape>} fields @param {string[]} [optional] @returns {Shape} */
  obj: (fields, optional = []) => ({ t: 'obj', fields, optional }),
  /** @param {Shape} of @param {number} max @param {number} [min] @returns {Shape} */
  arr: (of, max, min = 0) => ({ t: 'arr', of, max, min }),
});

const shapeId = S.re(ID_RE, 'id');
const shapeUuid = S.re(UUID_RE, 'uuid');
const shapeProc = S.obj({ pid: S.int(1, 2 ** 32 - 1), createTime: S.re(CREATE_TIME_RE, 'createTime') });
const shapeMs = S.int();
const shapeCount = S.int();
/** A project as frames carry it: its id, its display name (a cwd tail, its short id or a name you set) and its hue. */
const shapeProject = S.obj({ id: shapeId, name: S.re(PROJECT_NAME_RE, 'project'), hue: S.int(0, HUE_COUNT - 1) });
const ended = { end: S.en(END_CLASSES), cause: S.en(CAUSE_KINDS), endedWall: shapeMs, endedJseq: shapeCount, actionId: shapeUuid };

/** The fields of an ItemView (UI design 一 2), shared with GET /api/items/:id/detail's item. */
export const ITEM_FIELDS = Object.freeze({
  id: shapeId, rev: shapeCount, kind: S.en(ITEM_KINDS), group: S.en(GROUPS), sev: S.en(SEVERITIES), state: S.en(ITEM_STATES), conf: S.en(CONFIDENCES), project: S.nul(shapeProject),
  harness: S.nul(S.en(HARNESSES)), own: S.konst('observed'), part: S.nul(S.obj({ ref: shapeId, short: S.re(PART_SHORT_RE, 'partShort') })), committedWall: shapeMs,
  committedJseq: shapeCount, notify: S.en(NOTIFY_STATES), title: S.title, verbs: S.arr(S.en(ITEM_VERBS), ITEM_VERBS.length), open: S.obj({ kind: S.en(OPEN_KINDS) }),
  reminder: S.obj({ text: S.text(REMINDER_TEXT_MAX, 'reminder'), textState: S.en(TEXT_STATES) }),
});
/** The fields of an ended item (EndView, and the detail's `ended`). */
export const ENDED_FIELDS = Object.freeze(ended);

/** A brake's result, by subtree: what the page's brake outcomes are read from (UI design 一 2). */
const brakeOutcome = S.obj({ commandId: shapeId, subtrees: S.arr(S.obj({ root: shapeProc, requestId: shapeId, killed: shapeCount, residual: shapeCount, status: S.en(BRAKE_STATUSES) }), 64, 1) });

/** The payloads (UI design 一 2). */
export const SHAPES = {
  /** An open or seen item as a snapshot lists it (snoozed ones are counted in `later`, ended ones are EndViews); only a reminder item has `reminder`. */
  ItemView: S.obj({ ...ITEM_FIELDS, state: S.en(['open', 'seen']) }, ['reminder']),
  EndView: S.obj({ id: shapeId, kind: S.en(ITEM_KINDS), project: S.nul(shapeProject), ...ended }, ['actionId']),
  BrakeOutcome: brakeOutcome,
  ActionOutcome: S.obj({ actionId: shapeUuid, verb: S.en(HUMAN_VERBS), itemId: shapeId, outcome: S.en(ACTION_OUTCOMES), jseq: shapeCount, bootId: shapeUuid, brake: brakeOutcome }, ['itemId', 'brake']),
  Status: S.obj({
    sources: S.arr(S.obj({ source: S.en(HARNESSES), state: S.en(['ok', 'stalled', 'error', 'off']), sinceWall: S.nul(shapeMs), version: S.nul(S.re(VERSION_RE, 'version')) }), HARNESSES.length),
    brake: S.en(['available', 'unavailable']),
    notifyRoute: S.en(['browser', 'toast', 'none']),
    toastWorker: S.en(['off', 'starting', 'ready', 'failed']),
    liveStreams: S.int(0, 2),
    tuningRev: shapeCount,
    snippetRev: shapeCount,
    dshOrigin: S.nul(S.re(DSH_ORIGIN_RE, 'dshOrigin')),
  }),
};

/** The frames (UI design 一 1). delta keeps its shape (the r4:2099 observer form) and is not sent in M0. */
export const FRAMES = {
  snapshot: S.obj({
    v: S.konst(PROTOCOL_V), bootId: shapeUuid, jseq: shapeCount, srev: shapeCount, serverWall: shapeMs, tickMs: S.konst(TICK_MS), profile: S.en(PROFILES), mode: S.en(MODES),
    modeReasons: S.arr(S.en(MODE_REASONS), MODE_REASONS.length), status: SHAPES.Status, items: S.arr(SHAPES.ItemView, ITEMS_MAX), clipped: shapeCount,
    later: S.obj({ snoozed: shapeCount, nextWall: S.nul(shapeMs) }), reminders: S.obj({ pending: shapeCount, nextWall: S.nul(shapeMs) }),
    ended: S.arr(SHAPES.EndView, ENDED_MAX), recentActions: S.arr(SHAPES.ActionOutcome, RECENT_ACTIONS_MAX),
  }),
  status: S.obj({ bootId: shapeUuid, srev: shapeCount, status: SHAPES.Status }),
  tick: S.obj({ bootId: shapeUuid, jseq: shapeCount, srev: shapeCount, serverWall: shapeMs }),
  notify: S.obj({ itemId: shapeId, attempt: S.int(1), sev: S.en(SEVERITIES), title: S.title, project: S.nul(shapeProject) }),
  bye: S.obj({ reason: S.en(BYE_REASONS) }),
  delta: S.obj({ jseq: shapeCount, prev: shapeCount, upserted: S.arr(SHAPES.ItemView, ITEMS_MAX), removed: S.arr(shapeId, ITEMS_MAX) }),
};
// Frozen through and through, RegExps included, so no module can widen a frame at run time.
frozen([SHAPES, FRAMES, ITEM_FIELDS, ENDED_FIELDS]);

/**
 * @typedef {{ group: string, sev: string, committedJseq: number, id: string }} RowKey
 */

/** @param {readonly string[]} list @param {unknown} v */
const rankIn = (list, v) => {
  const i = typeof v === 'string' ? list.indexOf(v) : -1;
  return i < 0 ? list.length : i;
};

/** @param {unknown} n */
const jseqKey = (n) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER);

/**
 * The row order both sides use (UI design 一 7): group, then severity, then committedJseq (the older
 * first), then id by UTF-16 code units, never by locale. A total order: an unknown group or severity,
 * or a jseq that is not a non-negative integer, sorts after every known one.
 * @param {RowKey} a
 * @param {RowKey} b
 * @returns {number}
 */
export function compareRows(a, b) {
  const g = rankIn(GROUPS, a.group) - rankIn(GROUPS, b.group);
  if (g !== 0) return g;
  const s = rankIn(SEVERITIES, a.sev) - rankIn(SEVERITIES, b.sev);
  if (s !== 0) return s;
  const j = jseqKey(a.committedJseq) - jseqKey(b.committedJseq);
  if (j !== 0) return j;
  const ia = String(a.id);
  const ib = String(b.id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
