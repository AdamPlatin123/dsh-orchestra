// @ts-check
// The owned sessions' JSON contract (alpha 0.2 slice design §2.8, orchestra app plan §2): what
// GET /api/owned (OwnedList) and GET /api/owned/:id/feed (OwnedFeed) answer. The server checks every
// reply against it before it goes out (src/server/owned.ts) and answers 500 when one does not fit.
//
// The truthfulness rules a payload can carry by itself:
// - T1: a session's state is what its driver knows (starting, idle, running) or that it ended or failed,
//   as long as this orchestrad holds the child. A session an earlier orchestrad started (its registry
//   entry outlived a restart, src/owned/registry.ts) is unknown with endReason daemon-restart: whether
//   its child still runs nobody here knows. A token count nobody reported is null, never 0. Why the
//   feature is off is said (disabledWhy), never a bare false.
// - T2: no state is done: a turn's end is a feed event (turn-ended), a session's end is ended or failed.
// - T3: every count equals the list it stands for: limits.active is the number of sessions still
//   running a child; a session's `waiting` names one of its open approvals (the one with the earliest
//   deadline) exactly when it has any; every approval belongs to a listed session.
// - D8: an approval carries the digest the page sends back and the wall time the queue declines it at
//   by itself; nothing in a payload allows anything.
// - Shown text carries no control or bidi character (a newline, a tab and the CR of a CRLF aside):
//   the driver writes invisible characters out before they get here.
// Plain ESM that imports only shared/frozen.js.

import { frozen } from './frozen.js';

export const OWNED_V = 1;

/** The enums, each in its documented order. */
export const OWNED_ENUMS = frozen({
  harness: ['codex', 'claude'],
  state: ['starting', 'idle', 'running', 'ended', 'failed', 'unknown'],
  /**
   * you-ended: a person ended it; exited: the child went away; start-failed, policy-mismatch: it never
   * started work; daemon-restart: an earlier orchestrad held it (state unknown).
   */
  endReason: ['you-ended', 'exited', 'start-failed', 'policy-mismatch', 'daemon-restart'],
  approvalKind: ['command', 'file-change', 'permissions', 'question', 'elicitation'],
  risk: ['shell', 'write', 'net', 'protected', 'other'],
  feedKind: ['you', 'text', 'tool', 'tool-result', 'ask', 'answer', 'auto-denied', 'lifecycle', 'result', 'note'],
});

export const OWNED_BOUNDS = frozen({
  /** A session title, in UTF-8 bytes (src/owned/codex-owned.ts titleBytes). */
  titleBytes: 240,
  /** An approval title, in UTF-8 bytes. */
  approvalTitleBytes: 200,
  /** An approval preview, in UTF-8 bytes (slice design §2.6). */
  previewBytes: 16 * 1024,
  /** One feed event's text, in UTF-8 bytes (slice design §2.8). */
  feedBytes: 2048,
  /** A feed event's ref (a codex item, turn or approval id). */
  refChars: 200,
});

/**
 * The texts the tower shows of owned sessions (src/sources/tower.ts): its project's name and why a session
 * ended, as data of the snapshot. Here and not in shared/strings.js, which the page loads: the page never
 * builds them itself. No text says done (T2): an ended session ended, it did not finish anything.
 */
export const OWNED_TOWER_TEXT = frozen({
  project: 'Orchestra 自有',
  untitled: '自有会话',
  starting: '正在启动',
  'end.you-ended': '已结束：你结束的',
  'end.exited': '已结束：进程退出了',
  'end.start-failed': '已结束：没能启动',
  'end.policy-mismatch': '已结束：审批或沙箱设置和要求不符，Orchestra 停了它',
  'end.daemon-restart': 'orchestrad 重启过：之前开的这个会话现在怎样不知道',
  'end.unknown': '已结束',
});

export const OWNED_ID_RE = frozen(/^[0-9a-f]{20}$/);
export const APPROVAL_ID_RE = frozen(/^[0-9a-f]{32}$/);
export const OWNED_DIGEST_RE = frozen(/^[0-9a-f]{64}$/);
export const OWNED_UUID_RE = frozen(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** A code (why the feature is off, a feed event's state): ASCII, never source text. */
export const OWNED_CODE_RE = frozen(/^[a-z][a-z0-9.-]{0,63}$/);
/** A model of the owned list (src/owned/models.ts OWNED_MODEL_RE). */
export const OWNED_MODEL_NAME_RE = frozen(/^(?:zcode|opencode-go|codex)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
// C0 and C1 controls but tab and newline, DEL, and the bidi embeddings, overrides and isolates.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * @typedef {{
 *   v: 1, kind: 'owned-list', rev: number, enabled: boolean, disabledWhy: string | null,
 *   harnesses: { codex: boolean, claude: boolean },
 *   owned: OwnedEntry[], approvals: ApprovalEntry[], limits: { maxOwned: number, active: number },
 * }} OwnedList
 *   rev: the approval queue's revision; the page sends it back with an allow (stale-view otherwise).
 *   enabled: whether any harness can start a session now; disabledWhy says why not (null when enabled).
 * @typedef {{
 *   ownedId: string, harness: 'codex' | 'claude', model: string, title: string, state: string, endReason: string | null,
 *   waiting: string | null, queued: number, tokens: Tokens | null, lastSeq: number, createdAt: number,
 * }} OwnedEntry
 *   title: the first line of its first message, shown (possibly empty); waiting: an approvalId.
 * @typedef {{ input: number, cachedInput: number, output: number, total: number }} Tokens
 * @typedef {{
 *   approvalId: string, ownedId: string, kind: string, title: string, preview: string, tooLong: boolean, redactions: number,
 *   digest: string, risk: string, high: boolean, rev: number, canAccept: boolean, canText: boolean, deadline: number,
 * }} ApprovalEntry
 *   high: r4 §10.9's high risk (a shell, the network, a protected path or a write outside the work dir,
 *   a grant, a hidden secret): the page asks to hold or type before it sends an allow.
 *   deadline: the wall time (epoch ms) the queue declines it at (D8: a timeout is a refusal).
 * @typedef {{
 *   v: 1, kind: 'owned-feed', ownedId: string, from: number, to: number, clipped: boolean, events: FeedEntry[],
 * }} OwnedFeed
 * @typedef {{
 *   seq: number, at: number, kind: string, ref: string | null, uuid: string | null, text: string | null, state: string | null,
 *   redactions: number, live: boolean, exitCode: number | null, tokens: Tokens | null,
 * }} FeedEntry
 *   uuid: only on `you`, the actionId of the human record the message came with.
 * @typedef {{ ok: boolean, errors: string[] }} Verdict
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** UTF-8 length without a TextEncoder (the page may load this file too). @param {string} s */
const utf8Bytes = (s) => {
  let n = 0;
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp > 0xffff ? 4 : 3;
  }
  return n;
};

function checker() {
  /** @type {string[]} */
  const errors = [];
  /** @param {string} at @param {string} why */
  const bad = (at, why) => { errors.push(`${at}: ${why}`); };
  return {
    errors,
    bad,
    /** @param {unknown} v @param {string} at @param {readonly string[]} keys @returns {Record<string, unknown> | null} */
    obj(v, at, keys) {
      if (!isRecord(v)) { bad(at, 'not a plain object'); return null; }
      if (Object.getOwnPropertySymbols(v).length > 0) bad(at, 'symbol keys');
      const own = Object.getOwnPropertyNames(v);
      for (const k of keys) if (!own.includes(k)) bad(at, `missing ${k}`);
      for (const k of own) {
        if (!keys.includes(k)) bad(at, `unknown key ${k}`);
        else if (!Object.hasOwn(/** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(v, k)), 'value')) bad(`${at}.${k}`, 'not a data field');
      }
      return v;
    },
    /** @param {unknown} v @param {string} at @returns {unknown[]} */
    arr(v, at) {
      if (!Array.isArray(v)) { bad(at, 'not an array'); return []; }
      return v;
    },
    /** @param {unknown} v @param {string} at @param {readonly string[]} of */
    en(v, at, of) {
      if (typeof v !== 'string' || !of.includes(v)) bad(at, `${JSON.stringify(v)} is not one of ${of.join('|')}`);
    },
    /** @param {unknown} v @param {string} at @param {number} [min] */
    int(v, at, min = 0) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) bad(at, `${JSON.stringify(v)} is not an integer from ${min}`);
    },
    /** @param {unknown} v @param {string} at */
    bool(v, at) {
      if (typeof v !== 'boolean') bad(at, `${JSON.stringify(v)} is not a boolean`);
    },
    /** @param {unknown} v @param {string} at @param {RegExp} re @param {string} name */
    re(v, at, re, name) {
      if (typeof v !== 'string' || !re.test(v)) bad(at, `${JSON.stringify(v)} is not a ${name}`);
    },
    /** Shown text: at most `max` UTF-8 bytes, no control or bidi character. @param {unknown} v @param {string} at @param {number} max */
    text(v, at, max) {
      if (typeof v !== 'string') { bad(at, 'not a string'); return; }
      if (!v.isWellFormed()) bad(at, 'not well-formed');
      if (utf8Bytes(v) > max) bad(at, `${utf8Bytes(v)} bytes, at most ${max}`);
      if (CONTROLS.test(v.replaceAll('\r\n', '\n'))) bad(at, 'holds a control or bidi character');
    },
  };
}

/** @typedef {ReturnType<typeof checker>} Checker */

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkTokens(c, v, at) {
  if (v === null) return;
  const t = c.obj(v, at, ['input', 'cachedInput', 'output', 'total']);
  if (t !== null) for (const k of ['input', 'cachedInput', 'output', 'total']) c.int(t[k], `${at}.${k}`);
}

/**
 * Checks GET /api/owned's reply. Pure: reads `x`, never throws on a JSON value.
 * @param {unknown} x @returns {Verdict}
 */
export function validateOwnedList(x) {
  const c = checker();
  const s = c.obj(x, '$', ['v', 'kind', 'rev', 'enabled', 'disabledWhy', 'harnesses', 'owned', 'approvals', 'limits']);
  if (s === null) return { ok: false, errors: c.errors };
  if (s.v !== OWNED_V) c.bad('$.v', `${JSON.stringify(s.v)}, not ${OWNED_V}`);
  if (s.kind !== 'owned-list') c.bad('$.kind', `${JSON.stringify(s.kind)}, not owned-list`);
  c.int(s.rev, '$.rev');
  c.bool(s.enabled, '$.enabled');
  if (s.disabledWhy !== null) c.re(s.disabledWhy, '$.disabledWhy', OWNED_CODE_RE, 'code');
  // T1: off says why; on has no why.
  if ((s.enabled === false) !== (s.disabledWhy !== null)) c.bad('$.disabledWhy', 'set exactly when enabled is false');
  const h = c.obj(s.harnesses, '$.harnesses', OWNED_ENUMS.harness);
  if (h !== null) {
    for (const k of OWNED_ENUMS.harness) c.bool(h[k], `$.harnesses.${k}`);
    if (s.enabled === true && !OWNED_ENUMS.harness.some((k) => h[k] === true)) c.bad('$.enabled', 'true, but no harness can start a session');
    if (s.enabled === false && OWNED_ENUMS.harness.some((k) => h[k] === true)) c.bad('$.enabled', 'false, but a harness can start a session');
  }

  /** @type {Map<unknown, Record<string, unknown>>} */
  const sessions = new Map();
  c.arr(s.owned, '$.owned').forEach((e, i) => {
    const at = `$.owned[${i}]`;
    const o = c.obj(e, at, ['ownedId', 'harness', 'model', 'title', 'state', 'endReason', 'waiting', 'queued', 'tokens', 'lastSeq', 'createdAt']);
    if (o === null) return;
    c.re(o.ownedId, `${at}.ownedId`, OWNED_ID_RE, 'owned id');
    if (sessions.has(o.ownedId)) c.bad(`${at}.ownedId`, `${String(o.ownedId)} listed twice`);
    sessions.set(o.ownedId, o);
    c.en(o.harness, `${at}.harness`, OWNED_ENUMS.harness);
    c.re(o.model, `${at}.model`, OWNED_MODEL_NAME_RE, 'model of the owned list');
    c.text(o.title, `${at}.title`, OWNED_BOUNDS.titleBytes);
    c.en(o.state, `${at}.state`, OWNED_ENUMS.state);
    const over = o.state === 'ended' || o.state === 'failed' || o.state === 'unknown';
    if (o.endReason !== null) c.en(o.endReason, `${at}.endReason`, OWNED_ENUMS.endReason);
    if (over !== (o.endReason !== null)) c.bad(`${at}.endReason`, 'set exactly when the session ended, failed or is unknown');
    // T1: daemon-restart is exactly the unknown state's reason.
    if ((o.state === 'unknown') !== (o.endReason === 'daemon-restart')) c.bad(`${at}.endReason`, 'daemon-restart exactly when the state is unknown');
    if (o.waiting !== null) c.re(o.waiting, `${at}.waiting`, APPROVAL_ID_RE, 'approval id');
    c.int(o.queued, `${at}.queued`);
    if (over && o.queued !== 0) c.bad(`${at}.queued`, 'an ended session holds no waiting message');
    checkTokens(c, o.tokens, `${at}.tokens`);
    c.int(o.lastSeq, `${at}.lastSeq`);
    c.int(o.createdAt, `${at}.createdAt`);
  });

  /** @type {Map<unknown, Record<string, unknown>[]>} */
  const byOwned = new Map();
  const ids = new Set();
  c.arr(s.approvals, '$.approvals').forEach((e, i) => {
    const at = `$.approvals[${i}]`;
    const a = c.obj(e, at, ['approvalId', 'ownedId', 'kind', 'title', 'preview', 'tooLong', 'redactions', 'digest', 'risk', 'high', 'rev', 'canAccept', 'canText', 'deadline']);
    if (a === null) return;
    c.re(a.approvalId, `${at}.approvalId`, APPROVAL_ID_RE, 'approval id');
    if (ids.has(a.approvalId)) c.bad(`${at}.approvalId`, `${String(a.approvalId)} listed twice`);
    ids.add(a.approvalId);
    c.re(a.ownedId, `${at}.ownedId`, OWNED_ID_RE, 'owned id');
    const owner = sessions.get(a.ownedId);
    if (owner === undefined) c.bad(`${at}.ownedId`, `${String(a.ownedId)} is no listed session`);
    else if (owner.state === 'ended' || owner.state === 'failed' || owner.state === 'unknown') c.bad(`${at}.ownedId`, 'an approval open on a session that ended (or that this orchestrad does not hold)');
    byOwned.set(a.ownedId, [...(byOwned.get(a.ownedId) ?? []), a]);
    c.en(a.kind, `${at}.kind`, OWNED_ENUMS.approvalKind);
    c.text(a.title, `${at}.title`, OWNED_BOUNDS.approvalTitleBytes);
    c.text(a.preview, `${at}.preview`, OWNED_BOUNDS.previewBytes);
    c.bool(a.tooLong, `${at}.tooLong`);
    c.int(a.redactions, `${at}.redactions`);
    c.re(a.digest, `${at}.digest`, OWNED_DIGEST_RE, 'digest');
    c.en(a.risk, `${at}.risk`, OWNED_ENUMS.risk);
    c.bool(a.high, `${at}.high`);
    c.int(a.rev, `${at}.rev`, 1);
    if (typeof a.rev === 'number' && typeof s.rev === 'number' && a.rev > s.rev) c.bad(`${at}.rev`, `${a.rev}, after the list's own ${s.rev}`);
    c.bool(a.canAccept, `${at}.canAccept`);
    c.bool(a.canText, `${at}.canText`);
    // What the page cannot show whole is never allowed (slice design §2.6).
    if (a.tooLong === true && (a.canAccept === true || a.canText === true)) c.bad(`${at}.canAccept`, 'a preview cut short offers only the refusal');
    // r4 §10.9: a shell, the network and a protected path are high risk whatever else holds.
    if ((a.risk === 'shell' || a.risk === 'net' || a.risk === 'protected') && a.high !== true) c.bad(`${at}.high`, `${String(a.risk)} is high risk`);
    if (typeof a.redactions === 'number' && a.redactions > 0 && a.high !== true) c.bad(`${at}.high`, 'a hidden secret is high risk');
    c.int(a.deadline, `${at}.deadline`);
  });
  // T3: a session waits exactly when it has an open approval, and names the one due first.
  for (const [id, o] of sessions) {
    const mine = byOwned.get(id) ?? [];
    if (mine.length === 0) {
      if (o.waiting !== null) c.bad(`$.owned: ${String(id)}.waiting`, `${String(o.waiting)}, but no approval of it is open`);
      continue;
    }
    const first = [...mine].sort((p, q) => Number(p.deadline) - Number(q.deadline))[0];
    if (o.waiting !== first?.approvalId) c.bad(`$.owned: ${String(id)}.waiting`, `${JSON.stringify(o.waiting)}, its first open approval is ${String(first?.approvalId)}`);
  }

  const limits = c.obj(s.limits, '$.limits', ['maxOwned', 'active']);
  if (limits !== null) {
    c.int(limits.maxOwned, '$.limits.maxOwned');
    c.int(limits.active, '$.limits.active');
    let k = 0;
    for (const o of sessions.values()) if (o.state !== 'ended' && o.state !== 'failed' && o.state !== 'unknown') k++;
    if (limits.active !== k) c.bad('$.limits.active', `${String(limits.active)}, but ${k} listed sessions still run`);
  }
  return { ok: c.errors.length === 0, errors: c.errors };
}

/**
 * Checks GET /api/owned/:id/feed's reply. Pure: reads `x`, never throws on a JSON value.
 * @param {unknown} x @returns {Verdict}
 */
export function validateOwnedFeed(x) {
  const c = checker();
  const s = c.obj(x, '$', ['v', 'kind', 'ownedId', 'from', 'to', 'clipped', 'events']);
  if (s === null) return { ok: false, errors: c.errors };
  if (s.v !== OWNED_V) c.bad('$.v', `${JSON.stringify(s.v)}, not ${OWNED_V}`);
  if (s.kind !== 'owned-feed') c.bad('$.kind', `${JSON.stringify(s.kind)}, not owned-feed`);
  c.re(s.ownedId, '$.ownedId', OWNED_ID_RE, 'owned id');
  c.int(s.from, '$.from');
  c.int(s.to, '$.to');
  c.bool(s.clipped, '$.clipped');
  let prev = typeof s.from === 'number' ? s.from : 0;
  c.arr(s.events, '$.events').forEach((e, i) => {
    const at = `$.events[${i}]`;
    const ev = c.obj(e, at, ['seq', 'at', 'kind', 'ref', 'uuid', 'text', 'state', 'redactions', 'live', 'exitCode', 'tokens']);
    if (ev === null) return;
    c.int(ev.seq, `${at}.seq`, 1);
    if (typeof ev.seq === 'number') {
      if (ev.seq <= prev) c.bad(`${at}.seq`, `${ev.seq}, not after ${prev}`);
      if (typeof s.to === 'number' && ev.seq > s.to) c.bad(`${at}.seq`, `${ev.seq}, past to (${s.to})`);
      prev = ev.seq;
    }
    c.int(ev.at, `${at}.at`);
    c.en(ev.kind, `${at}.kind`, OWNED_ENUMS.feedKind);
    if (ev.ref !== null) {
      if (typeof ev.ref !== 'string' || ev.ref.length === 0 || ev.ref.length > OWNED_BOUNDS.refChars || CONTROLS.test(ev.ref)) c.bad(`${at}.ref`, 'not a ref');
    }
    // A message of yours carries the uuid of the human record it came with; nothing else does (A4).
    if (ev.kind === 'you') c.re(ev.uuid, `${at}.uuid`, OWNED_UUID_RE, 'uuid');
    else if (ev.uuid !== null) c.bad(`${at}.uuid`, 'only a message of yours carries a uuid');
    if (ev.text !== null) c.text(ev.text, `${at}.text`, OWNED_BOUNDS.feedBytes);
    if (ev.state !== null) c.re(ev.state, `${at}.state`, OWNED_CODE_RE, 'state code');
    c.int(ev.redactions, `${at}.redactions`);
    c.bool(ev.live, `${at}.live`);
    if (ev.exitCode !== null && (typeof ev.exitCode !== 'number' || !Number.isSafeInteger(ev.exitCode))) c.bad(`${at}.exitCode`, 'not an integer');
    checkTokens(c, ev.tokens, `${at}.tokens`);
  });
  return { ok: c.errors.length === 0, errors: c.errors };
}
