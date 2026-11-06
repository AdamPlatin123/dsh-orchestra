import type { Redactor } from './redact.ts';
import { checkPath } from '../fs/paths.ts';
import { parseTimerId, TRANSITION_CLASSES } from '../runtime/clock.ts';
import { ACTION_OUTCOMES, BRAKE_STATUSES, CONFIDENCES, CREATE_TIME_RE, GROUPS, HARNESSES, HUMAN_VERBS, ID_RE, ITEM_KINDS, SEVERITIES, TOOL_NAME_RE, UUID_RE, VERSION_RE } from '../../shared/protocol.js';
import { HUE_COUNT, JOURNAL_STRING_MAX, PLAN_TTL_MS } from '../../shared/constants.js';
import { frozen } from '../../shared/frozen.js';
import { FORMAT_RULES } from './redact.ts';
import type { CauseRule } from '../model/inbox.ts';
import { ITEM_EDGES, MACHINE_STATES, itemBodyError } from '../model/inbox.ts';
import { OWNED_MODEL_RE } from '../owned/models.ts';
import { MAX_CANDIDATES, ROUTE_HARNESSES, ROUTE_MODES, ROUTE_REASONS, ROUTE_RECORD_ROUTER, RULE_IDS, TASK_CLASSES } from '../route/rules.ts';
import { ROUTER_WHY } from '../route/router-model.ts';

// The journal's record kinds and the schema of each body (plan step 3), frozen with 0001 at the end
// of the step. A body holds only ids, enums, integers, digests and snippetRefs, plus four short
// source strings that a rebuild needs (cwd, version, tool name, error code), each checked against its
// grammar and, when it is appended, by redact.ts: a value the redactor would change is refused, never
// rewritten. There is no leaf type for any other string, so source free text has no way into a body;
// it goes to the snippet table, and the body keeps its digest and snippetRef.
//
// Every field is required; an absent value is null, so each kind has one shape (P1). The plan writes
// the optional fields of `human` and `human.result` as targetId?, commandId? and subtrees?: here that
// means nullable and always written, so a writer that leaves one out gets bad-record (missing), never
// a second shape. Objects are closed: a key the schema does not list is refused. No two kinds share a
// set of keys (records.test pins it), so a body's digest binds its kind as well.
//
// Two kinds of check, kept apart (P4: replay never re-runs a policy): the format checks are pure
// functions of the body and hold for every journal ever written, so the startup scan and apply run
// them; the policy checks depend on this orchestrad (the redactor's environment, today's list of
// redaction rules) and run only at the append, where `redactor` is given. A judgment's `value` names
// the rules that hit by id: at the append the id must be one of today's FORMAT_RULES, in a stored line
// only an id in its grammar, so a rule renamed or retired by a later redact version never breaks an
// older journal. The other tables a body is checked against (the item kind table, the item and
// reminder edges, the enums, the source-string grammars) are frozen contracts: they may only grow, and
// test/repo/contract-freeze.test.ts pins them.

/** The longest batch the journal takes. */
export const MAX_BATCH = 4096;

/** The harnesses (shared/protocol.js, the one source). */
export { HARNESSES };
/** What a source event is, after its source normalized it (steps 9-14 map their own types onto these). */
export const EVENT_KINDS = Object.freeze(['edge', 'status', 'tool', 'message', 'waiting', 'approval', 'error'] as const);
/**
 * The state machines whose transitions the journal records. M0's two; step 8's part state machine and
 * step 10's unregistered annotation add theirs (with their timer class back in TRANSITION_CLASSES) as a
 * deliberate change of this frozen list and of the contract-freeze golden.
 */
export const ENTITIES = Object.freeze(['inbox_item', 'reminder'] as const);
export type Entity = (typeof ENTITIES)[number];

/**
 * States per entity; `none` is before the creating transition. The item machine (r4 §6.5) and what
 * may cause each of its edges are src/model/inbox.ts's; the reminder machine is step 13's.
 */
export const STATES: Readonly<Record<Entity, readonly string[]>> = Object.freeze({
  inbox_item: MACHINE_STATES,
  reminder: Object.freeze(['none', 'pending', 'fired', 'cancelled']),
});

/**
 * The reminder machine's edges and what may cause each (I01), like ITEM_EDGES: you make a reminder
 * (the `remind` verb), its own timer fires it, and it is cancelled by a `remind` action that targets
 * the reminder itself. M0 has no cancel route (UI design 三: no reopen, no cancel), so nothing writes
 * that edge yet; the cause rule says what a later one must look like.
 */
export const REMINDER_EDGES: Readonly<Record<string, CauseRule>> = Object.freeze({
  'none>pending': Object.freeze({ source: false, human: Object.freeze(['remind'] as const), clock: Object.freeze([] as const) }),
  'pending>fired': Object.freeze({ source: false, human: Object.freeze([] as const), clock: Object.freeze(['reminder'] as const) }),
  'pending>cancelled': Object.freeze({ source: false, human: Object.freeze(['remind'] as const), clock: Object.freeze([] as const) }),
});

/** The edges each state machine allows, as `from>to`. */
export const EDGES: Readonly<Record<Entity, readonly string[]>> = Object.freeze({
  inbox_item: Object.freeze(Object.keys(ITEM_EDGES)),
  reminder: Object.freeze(Object.keys(REMINDER_EDGES)),
});

export const JUDGMENT_NAMES = Object.freeze(['redact'] as const);
export const PROTECT_REASONS = Object.freeze(['tuning', 'config'] as const);
export const NOTIFY_VIA = Object.freeze(['browser', 'toast'] as const);
/** What a person did with an agent request (seat): dispatched it, or rejected it. Expiry and withdrawal are no human decision and write no record. */
export const AGENT_VERDICTS = Object.freeze(['dispatched', 'rejected'] as const);
/** Who an agent request came from: a DSH session over the agent port (seat), or an owned session through its dispatch tool (src/route/dispatch.ts). */
export const REQUESTER_KINDS = Object.freeze(['dsh', 'owned'] as const);
/** What a person may set a session's dispatch permission to (src/route/dispatch.ts): 你不在也派 is not one, r4 D20 does not allow it. */
export const GRANT_LEVELS = Object.freeze(['ask', 'free'] as const);

/** A human action's target: an item, root or other id, or pid:createTime. */
export const TARGET_RE = frozen(/^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}|[1-9][0-9]{0,9}:[1-9][0-9]{0,19})$/);
export const DIGEST_RE = frozen(/^[0-9a-f]{64}$/);
/** An error code a source reports: an identifier. */
export const ERROR_CODE_RE = frozen(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const MAX_PID = 2 ** 32 - 1;
/** The most processes a brake plan lists (its node list, 节点清单: every node of the subtrees on offer). */
export const PLAN_NODES_MAX = 4096;
/** A redaction rule's id inside a stored judgment: the grammar of FORMAT_RULES ids, never the list itself. */
export const RULE_ID_RE = frozen(/^[a-z0-9][a-z0-9_.-]{0,31}$/);

export type SourceKind = 'cwd' | 'version' | 'tool' | 'errorCode';

type Leaf =
  | { t: 'id' } | { t: 'uuid' } | { t: 'digest' } | { t: 'createTime' } | { t: 'target' } | { t: 'timerId' } | { t: 'outcome' }
  /** A model name of the owned list (src/owned/models.ts OWNED_MODEL_RE): a grammar, not source text. */
  | { t: 'model' }
  | { t: 'int'; min: number; max: number }
  | { t: 'const'; value: number }
  | { t: 'enum'; of: readonly string[] }
  | { t: 'src'; src: SourceKind };
export type Schema =
  | Leaf
  | { t: 'null'; of: Schema }
  | { t: 'obj'; fields: Readonly<Record<string, Schema>> }
  | { t: 'arr'; of: Schema; min: number; max: number }
  | { t: 'tagged'; tag: string; cases: Readonly<Record<string, Readonly<Record<string, Schema>>>> }
  /** A record keyed by ids: at the append each key is one of `keys` (policy), in a stored line one in RULE_ID_RE's grammar (format). */
  | { t: 'record'; keys: readonly string[]; value: Schema };

const id: Schema = { t: 'id' };
const uuid: Schema = { t: 'uuid' };
const digest: Schema = { t: 'digest' };
const int = (min = 0, max = Number.MAX_SAFE_INTEGER): Schema => ({ t: 'int', min, max });
const en = (of: readonly string[]): Schema => ({ t: 'enum', of });
const src = (s: SourceKind): Schema => ({ t: 'src', src: s });
const nul = (of: Schema): Schema => ({ t: 'null', of });
const obj = (fields: Record<string, Schema>): Schema => ({ t: 'obj', fields });
const arr = (of: Schema, min: number, max: number): Schema => ({ t: 'arr', of, min, max });

const proc = obj({ pid: int(1, MAX_PID), createTime: { t: 'createTime' } });
const subtree = obj({ root: proc, requestId: id, killed: int(), residual: int(), status: en(BRAKE_STATUSES) });
const cause: Schema = {
  t: 'tagged',
  tag: 'kind',
  cases: {
    source: { partRef: id, srcSeq: int() },
    human: { actionId: uuid },
    clock: { timerId: { t: 'timerId' } },
  },
};
const redactVerdict = obj({
  ver: int(),
  dropped: nul(en(['env-dump'])),
  known: int(),
  format: { t: 'record', keys: FORMAT_RULES.map((r) => r.id), value: int() },
  entropy: int(),
});

/** The body schema of every kind; `commit` and `recovered` are written by the journal itself. */
export const BODY_SCHEMAS = frozen({
  // A batch's stamps (bootId, obsMono, obsWall) are in its commit body, so the chain, which covers the
  // digests only (plan step 3), covers them too: the scan holds every line of the batch to them.
  commit: obj({ count: int(1, MAX_BATCH), bootId: uuid, obsMono: int(), obsWall: int() }),
  recovered: obj({ bytesCut: int(1) }),
  project: obj({ projectId: id, cwd: src('cwd'), hue: int(0, HUE_COUNT - 1) }),
  part: obj({ partRef: id, harness: en(HARNESSES), projectId: nul(id), cwd: nul(src('cwd')), version: nul(src('version')) }),
  'part.cursor': obj({ partRef: id, cursor: int(), srcSeq: int() }),
  event: obj({
    partRef: id, srcSeq: int(), srcTime: nul(int()), srcTimePrecision: en(['ms', 's', 'none']), evKind: en(EVENT_KINDS),
    digest, snippetRef: nul(id), tool: nul(src('tool')), errorCode: nul(src('errorCode')),
  }),
  item: obj({
    itemId: id, itemKind: en(ITEM_KINDS), sev: en(SEVERITIES), group: en(GROUPS), conf: en(CONFIDENCES),
    projectId: nul(id), partRef: nul(id), dedupKey: digest, reminderId: nul(id),
  }),
  transition: obj({ entity: en(ENTITIES), id, from: en(STATES.inbox_item.concat(STATES.reminder)), to: en(STATES.inbox_item.concat(STATES.reminder)), cause }),
  snooze: obj({ itemId: id, untilWall: int() }),
  reminder: obj({ reminderId: id, dueWall: int(), snippetRef: nul(id), projectId: nul(id) }),
  notified: obj({ itemId: id, attempt: int(1), via: en(NOTIFY_VIA), atMono: int(), atWall: int() }),
  human: obj({ actionId: uuid, verb: en(HUMAN_VERBS), targetId: nul({ t: 'target' }), requestDigest: digest }),
  // verb and targetId repeat the `human` record's (apply holds them equal), so recentActions reads
  // human.result alone (plan line 589).
  'human.result': obj({
    actionId: uuid, verb: en(HUMAN_VERBS), targetId: nul({ t: 'target' }), outcome: { t: 'outcome' }, commandId: nul(id), subtrees: nul(arr(subtree, 1, 64)),
  }),
  judgment: obj({ name: en(JUDGMENT_NAMES), inputDigest: digest, ver: int(), value: redactVerdict }),
  clock: obj({ timerId: { t: 'timerId' }, clock: en(['mono', 'wall']), durationMs: int(), firedMono: int(), firedWall: int() }),
  command: obj({ commandId: id, actionId: uuid, verb: en(['kill-tree']), harness: proc, status: en(BRAKE_STATUSES), subtrees: arr(subtree, 1, 64) }),
  // Step 6 item 4: the harness, the subtree roots on offer, the node list, the protected nodes, and the
  // two clocks of its expiry. createdMono compares only within the boot of its line (the scan holds it
  // at or below the line's obsMono); expiresAt is createdWall + ttlMs. planExpired() decides.
  'brake.plan': obj({
    planId: id, harness: proc, roots: arr(proc, 1, 64), nodes: arr(proc, 1, PLAN_NODES_MAX), protected: arr(proc, 0, 512),
    createdMono: int(), createdWall: int(), ttlMs: { t: 'const', value: PLAN_TTL_MS }, expiresAt: int(),
  }),
  protect: obj({ op: en(['add', 'remove']), pid: int(1, MAX_PID), createTime: { t: 'createTime' }, reason: en(PROTECT_REASONS) }),
  // The orchestra app's dispatch desk (r4 §6.2 RouteDecision, §9.4): one per dispatch from a suggestion,
  // in the batch of its owned-new `human` records. decisionId is sha256 over the canonical body without
  // it; the sentence, the title and the router model's words stay out (no source free text in a body).
  // pick: the candidate the person took, null when the harness and model were set by hand; reason: the
  // reason chip (that candidate's rule, router-model, or manual); router: what the router model did, or
  // not-asked for a dispatch with no suggestion for its sentence (then routeId is null and there are no
  // candidates; r4 §9.5: every dispatch is a decision); routerModel: the model asked (null when it was not);
  // routerWhy: why its answer was not used (ROUTER_WHY: no answer, a refused answer, or not asked), else null.
  route: obj({
    decisionId: digest, actionId: uuid, routeId: nul(id), ownedId: id, taskClass: en(TASK_CLASSES), rules: arr(en(RULE_IDS), 1, RULE_IDS.length),
    candidates: arr(obj({ harness: en(ROUTE_HARNESSES), model: { t: 'model' }, source: en(['rule', 'model']), rule: nul(en(RULE_IDS)) }), 0, MAX_CANDIDATES),
    chosen: obj({ harness: en(ROUTE_HARNESSES), model: { t: 'model' } }), pick: nul(int(0, MAX_CANDIDATES - 1)), reason: en(ROUTE_REASONS),
    router: en(ROUTE_RECORD_ROUTER), routerModel: nul({ t: 'model' }), routerWhy: nul(en(ROUTER_WHY)), mode: en(ROUTE_MODES),
  }),
  // seat (final.md §5.1): a person's decision on an agent request (r4 A17), in the batch of its human
  // records: dispatched (owned-new with the requestId; decisionId names that dispatch's `route` record, so
  // the RouteDecision's source is the agent request) or rejected (request-reject; ownedId and decisionId
  // null). The `route` body stays as it was: every field of a kind is required, and a journal written before
  // this kind existed must still replay. The requester's session id is not source free text a body may
  // keep: only its sha256 (over "dsh:" and the id) is, enough to tie two decisions to one requester.
  'agent-request': obj({
    requestId: id, actionId: uuid, verdict: en(AGENT_VERDICTS), harness: en(ROUTE_HARNESSES), requesterKind: en(REQUESTER_KINDS), requesterDigest: digest,
    ownedId: nul(id), decisionId: nul(digest),
  }),
  // Project roots (orchestra app plan 项目根): where an owned session a person started works, when that is a
  // project root named at startup or a folder in one (a session in its own ORCHESTRA_HOME\work\<id> writes
  // none), in the batch of its owned-new `human` records. For an agent request (seat) this binds the
  // person's dispatch to the runIn its card showed, which the request body (and so requestDigest) does not
  // hold; requestId names the request, null for the dispatch dialog's own root. A path is not source free
  // text a body may keep: only the sha256 of the cwd and of the root it lies in. A new kind, not new fields
  // of `agent-request`: every field of a kind is required, and an older journal must still replay.
  'owned-cwd': obj({ actionId: uuid, ownedId: id, requestId: nul(id), cwdDigest: digest, rootDigest: digest }),
  // 改派 (orchestra app plan 请求卡改派): a person dispatched an agent request on another harness, or on another model
  // than the one its session named, than the card asked for; in the batch of owned-new's human records, beside its
  // `agent-request` (whose harness stays what was asked). from / fromModel: what the card asked for (fromModel null: no
  // model was named); to / toModel: what the session started on. A new kind, no new field of an old one: an older
  // journal still replays, and an older orchestrad meets an unknown kind and refuses to start (journal.ts parseLine).
  'request-reassign': obj({
    actionId: uuid, requestId: id, ownedId: id, from: en(ROUTE_HARNESSES), fromModel: nul({ t: 'model' }), to: en(ROUTE_HARNESSES), toModel: { t: 'model' },
  }),
  // A person set a session's dispatch permission (src/route/dispatch.ts): in the batch of its dispatch-grant `human`
  // records, which say who and when; this says what to. An open grant is what every `auto` record below names.
  'dispatch-grant': obj({ actionId: uuid, ownedId: id, level: en(GRANT_LEVELS) }),
  // A person opened the front desk (src/route/front-desk.ts): in the batch of its owned-new `human` records, which alone could
  // not tell it from a worker. No `route` line: nothing was dispatched.
  'front-desk': obj({ actionId: uuid, ownedId: id, model: { t: 'model' } }),
  // A worker dispatched a session on its permission, with no person's click: no `human` record exists for it, so
  // none of its fields can be read as a person's act. actionId is orchestrad's own, the same on its `route` line (mode
  // auto). by: the session that called the tool; grantActionId: the person's dispatch-grant it went on; textDigest: the
  // task, which is source free text. decisionId is null when no desk made a RouteDecision.
  auto: obj({
    actionId: uuid, requestId: id, by: id, ownedId: id, harness: en(ROUTE_HARNESSES), model: { t: 'model' }, grantActionId: uuid, depth: int(1, 64), textDigest: digest, decisionId: nul(digest),
  }),
} satisfies Record<string, Schema>);

export type Kind = keyof typeof BODY_SCHEMAS;
export const KINDS: readonly Kind[] = Object.freeze(Object.keys(BODY_SCHEMAS).sort() as Kind[]);
/** The kinds only the journal writes. */
export const JOURNAL_KINDS: readonly Kind[] = Object.freeze(['commit', 'recovered'] as Kind[]);

export const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.hasOwn(BODY_SCHEMAS, k);

export type BodyReason = 'shape' | 'missing' | 'extra-key' | 'not-plain' | 'type' | 'range' | 'grammar' | 'enum' | 'redacted' | 'too-long' | 'consistency';

export type BodyError = { reason: BodyReason; at: string };

/**
 * The status of a whole brake from its subtrees (UI design 一 2): unknown before refused before
 * residual before ok. A command's status must be this.
 */
export function brakeStatus(subtrees: readonly { status: string; residual: number }[]): (typeof BRAKE_STATUSES)[number] {
  if (subtrees.some((s) => s.status === 'unknown')) return 'unknown';
  if (subtrees.some((s) => s.status === 'refused')) return 'refused';
  if (subtrees.some((s) => s.status === 'partial' || s.residual > 0)) return 'partial';
  return 'ok';
}

/**
 * A source string as a journal body may keep it, or null: at most JOURNAL_STRING_MAX characters, its
 * grammar (the tool and version ones are shared/protocol.js's title-arg regexes; a cwd is an absolute
 * drive-letter path without control characters), and unchanged by `redactor` when one is given.
 */
export function sourceStringError(kind: SourceKind, value: unknown, redactor: Redactor | null): BodyReason | null {
  if (typeof value !== 'string' || value.length === 0) return 'type';
  if (value.length > JOURNAL_STRING_MAX) return 'too-long';
  let ok: boolean;
  switch (kind) {
    case 'cwd':
      // The full path follows the character rules of protocol.js's cwd tail grammar (CWD_TAIL_RE): no
      // control, format (bidi, zero-width), lone surrogate, line or paragraph separator. A zero-width
      // character would also split a known value past the redactor's first layer.
      ok = checkPath(value).ok && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
      break;
    case 'version':
      ok = VERSION_RE.test(value);
      break;
    case 'tool':
      ok = TOOL_NAME_RE.test(value);
      break;
    case 'errorCode':
      ok = ERROR_CODE_RE.test(value);
      break;
  }
  if (!ok) return 'grammar';
  if (redactor !== null && redactor.redact({ text: value }).text !== value) return 'redacted';
  return null;
}

/** The value a caller may put in a body for a source string, or null when it may not keep it. */
export function sourceString(kind: SourceKind, value: unknown, redactor: Redactor): string | null {
  return sourceStringError(kind, value, redactor) === null ? (value as string) : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** An own data property's value; an accessor counts as missing (its getter never runs). */
function own(o: Record<string, unknown>, k: string): { has: boolean; value: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && 'value' in d ? { has: true, value: d.value } : { has: false, value: undefined };
}

function checkFields(o: Record<string, unknown>, fields: Readonly<Record<string, Schema>>, at: string, redactor: Redactor | null): BodyError | null {
  const keys = Object.keys(fields);
  for (const k of Object.getOwnPropertyNames(o)) if (!keys.includes(k)) return { reason: 'extra-key', at };
  if (Object.getOwnPropertySymbols(o).length > 0) return { reason: 'extra-key', at };
  for (const k of keys) {
    const f = own(o, k);
    if (!f.has) return { reason: 'missing', at: `${at}.${k}` };
    const e = check(fields[k]!, f.value, `${at}.${k}`, redactor);
    if (e !== null) return e;
  }
  return null;
}

function check(s: Schema, v: unknown, at: string, redactor: Redactor | null): BodyError | null {
  const str = (re: RegExp): BodyError | null => (typeof v !== 'string' ? { reason: 'type', at } : re.test(v) ? null : { reason: 'grammar', at });
  switch (s.t) {
    case 'id':
      return str(ID_RE);
    case 'uuid':
      return str(UUID_RE);
    case 'digest':
      return str(DIGEST_RE);
    case 'createTime':
      return str(CREATE_TIME_RE);
    case 'target':
      return str(TARGET_RE);
    case 'timerId': {
      const p = parseTimerId(v);
      if (p === null) return { reason: 'grammar', at };
      return TRANSITION_CLASSES.includes(p.class) ? null : { reason: 'enum', at };
    }
    case 'outcome':
      return typeof v !== 'string' ? { reason: 'type', at } : ACTION_OUTCOMES.includes(v) ? null : { reason: 'enum', at };
    case 'model':
      return str(OWNED_MODEL_RE);
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { reason: 'type', at };
      return v < s.min || v > s.max ? { reason: 'range', at } : null;
    case 'const':
      return v === s.value ? null : { reason: 'range', at };
    case 'enum':
      return typeof v !== 'string' ? { reason: 'type', at } : s.of.includes(v) ? null : { reason: 'enum', at };
    case 'src': {
      const r = sourceStringError(s.src, v, redactor);
      return r === null ? null : { reason: r, at };
    }
    case 'null':
      return v === null ? null : check(s.of, v, at, redactor);
    case 'obj':
      if (!isPlainObject(v)) return { reason: 'not-plain', at };
      return checkFields(v, s.fields, at, redactor);
    case 'arr': {
      if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return { reason: 'type', at };
      if (v.length < s.min || v.length > s.max) return { reason: 'range', at };
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) return { reason: 'shape', at: `${at}[${i}]` };
        const e = check(s.of, v[i], `${at}[${i}]`, redactor);
        if (e !== null) return e;
      }
      return null;
    }
    case 'tagged': {
      if (!isPlainObject(v)) return { reason: 'not-plain', at };
      const tag = own(v, s.tag);
      if (!tag.has) return { reason: 'missing', at: `${at}.${s.tag}` };
      if (typeof tag.value !== 'string' || !Object.hasOwn(s.cases, tag.value)) return { reason: 'enum', at: `${at}.${s.tag}` };
      return checkFields(v, { [s.tag]: { t: 'enum', of: [tag.value] }, ...s.cases[tag.value]! }, at, redactor);
    }
    case 'record': {
      if (!isPlainObject(v)) return { reason: 'not-plain', at };
      if (Object.getOwnPropertySymbols(v).length > 0) return { reason: 'extra-key', at };
      const names = Object.getOwnPropertyNames(v);
      for (const k of names) {
        if (redactor !== null ? !s.keys.includes(k) : !RULE_ID_RE.test(k)) return { reason: 'enum', at };
        const f = own(v, k);
        if (!f.has) return { reason: 'shape', at };
        const e = check(s.value, f.value, `${at}[${names.indexOf(k)}]`, redactor);
        if (e !== null) return e;
      }
      return null;
    }
  }
}

/** Rules across fields that a schema alone cannot say. */
function consistency(kind: Kind, b: Record<string, unknown>): BodyError | null {
  const bad = (at: string): BodyError => ({ reason: 'consistency', at });
  switch (kind) {
    case 'event':
      return (b.srcTime === null) !== (b.srcTimePrecision === 'none') ? bad('$.srcTime') : null;
    case 'item': {
      // The kind table: group, level, confidence and a reminder's id follow from the kind.
      const at = itemBodyError(b);
      return at === null ? null : bad(at);
    }
    case 'transition': {
      const entity = b.entity as Entity;
      const states = STATES[entity];
      if (!states.includes(b.from as string)) return bad('$.from');
      return EDGES[entity].includes(`${String(b.from)}>${String(b.to)}`) ? null : bad('$.to');
    }
    case 'human.result':
      return (b.commandId === null) !== (b.subtrees === null) ? bad('$.commandId') : subtreesError(b.subtrees, '$.subtrees');
    case 'command': {
      const e = subtreesError(b.subtrees, '$.subtrees');
      if (e !== null) return e;
      return b.status === brakeStatus(b.subtrees as { status: string; residual: number }[]) ? null : bad('$.status');
    }
    case 'route': {
      // The pick names a candidate that is there, and that candidate is what was chosen; the reason follows from it.
      const cands = b.candidates as { harness: string; model: string; rule: string | null }[];
      const chosen = b.chosen as { harness: string; model: string };
      // No suggestion (routeId null) exactly when the router was not asked; then nothing was on offer.
      if ((b.routeId === null) !== (b.router === 'not-asked')) return bad('$.router');
      if (b.routeId === null && cands.length > 0) return bad('$.candidates');
      // A why exactly when the router model's answer was not used (no-answer).
      if ((b.router === 'no-answer') !== (b.routerWhy !== null)) return bad('$.routerWhy');
      // The model is named when it was asked: always when it answered, never when it was off, skipped or not asked.
      if (b.router === 'answered' && b.routerModel === null) return bad('$.routerModel');
      if (b.router !== 'answered' && b.router !== 'no-answer' && b.routerModel !== null) return bad('$.routerModel');
      if (b.pick === null) return b.reason === (b.mode === 'auto' ? 'worker' : 'manual') ? null : bad('$.reason');
      const c = cands[b.pick as number];
      if (c === undefined) return bad('$.pick');
      if (c.harness !== chosen.harness || c.model !== chosen.model) return bad('$.chosen');
      return b.reason === (c.rule ?? 'router-model') ? null : bad('$.reason');
    }
    case 'request-reassign':
      // Nothing moved is no 改派; on the same harness only a named model can have been changed.
      return b.from !== b.to ? null : b.fromModel === null || b.fromModel === b.toModel ? bad('$.to') : null;
    case 'agent-request':
      // A dispatch names its session (and its RouteDecision when a desk made one); a refusal names neither.
      return (b.verdict === 'dispatched') !== (b.ownedId !== null) ? bad('$.ownedId') : b.verdict === 'rejected' && b.decisionId !== null ? bad('$.decisionId') : null;
    case 'brake.plan': {
      if (b.expiresAt !== (b.createdWall as number) + PLAN_TTL_MS) return bad('$.expiresAt');
      const nodes = new Set((b.nodes as { pid: number; createTime: string }[]).map((n) => `${n.pid}:${n.createTime}`));
      const roots = b.roots as { pid: number; createTime: string }[];
      for (let i = 0; i < roots.length; i++) if (!nodes.has(`${roots[i]!.pid}:${roots[i]!.createTime}`)) return bad(`$.roots[${i}]`);
      return null;
    }
    default:
      return null;
  }
}

/** Each subtree's status says one thing: refused killed nothing, ok left nothing, partial left something. */
function subtreesError(list: unknown, at: string): BodyError | null {
  if (list === null) return null;
  const subs = list as { status: string; killed: number; residual: number }[];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i]!;
    if (s.status === 'refused' && (s.killed !== 0 || s.residual !== 0)) return { reason: 'consistency', at: `${at}[${i}]` };
    if (s.status === 'ok' && s.residual !== 0) return { reason: 'consistency', at: `${at}[${i}]` };
    if (s.status === 'partial' && s.residual === 0) return { reason: 'consistency', at: `${at}[${i}]` };
  }
  return null;
}

/** A brake plan as planExpired() reads it. */
export type PlanClocks = { readonly createdMono: number; readonly ttlMs: number; readonly expiresAt: number };

/**
 * Has a brake plan expired (plan line 541, P4)? Both clocks count and the first to reach its end
 * wins: the monotonic one at createdMono + ttlMs, the wall one at expiresAt. createdMono compares only
 * within the boot that made the plan, so a plan of another boot has expired. A wall clock set back
 * cannot stretch a plan; one set forward only ends it sooner. Pure: the caller hands both readings.
 */
export function planExpired(plan: PlanClocks, planBootId: string, now: { readonly bootId: string; readonly mono: number; readonly wall: number }): boolean {
  if (now.bootId !== planBootId) return true;
  return now.mono >= plan.createdMono + plan.ttlMs || now.wall >= plan.expiresAt;
}

/**
 * Why `body` is not a valid body of `kind`, or null. With a redactor (the append), every source string
 * must also come out of it unchanged; without one (the startup scan, apply) the check depends on the
 * body alone.
 */
export function checkBody(kind: Kind, body: unknown, redactor: Redactor | null): BodyError | null {
  const s = BODY_SCHEMAS[kind] as Schema;
  return check(s, body, '$', redactor) ?? consistency(kind, body as Record<string, unknown>);
}
