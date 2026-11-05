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
   * you-ended: a person ended it; exited: the child went away by itself; start-failed, policy-mismatch:
   * it never started work; daemon-restart: an earlier orchestrad held it (state unknown); safety-stop: an
   * owned Claude session's host stopped it on a safety check (a model, a tool, a plugin it may not have);
   * interrupt-unsure: an interrupt left something queued that could still run, so Orchestra ended it;
   * protocol-error: the child said something Orchestra cannot read, so Orchestra stopped it;
   * daemon-stop: orchestrad ended it on its own way out (nobody pressed end); braked: you pressed the
   * brake, and Orchestra ended every process in its procguard Job (whether all of them stopped is the
   * feed's tree-* note and the brake's reply, never this reason: T1); requester-withdrew: the agent that asked
   * for the session (seat) withdrew its request, and Orchestra ended it by the same stop order as your end.
   */
  endReason: ['you-ended', 'exited', 'start-failed', 'policy-mismatch', 'daemon-restart', 'safety-stop', 'interrupt-unsure', 'protocol-error', 'daemon-stop', 'braked', 'requester-withdrew'],
  approvalKind: ['command', 'file-change', 'permissions', 'question', 'elicitation', 'tool'],
  risk: ['shell', 'write', 'net', 'protected', 'other'],
  feedKind: ['you', 'text', 'tool', 'tool-result', 'ask', 'answer', 'auto-denied', 'lifecycle', 'result', 'note'],
  /**
   * An agent request's state (seat, src/route/requests.ts): pending waits for you; dispatched, running and
   * done name the session you dispatched (done: its first turn ended and what it said went back to the
   * requester, never a verdict on the work: T2, D19); rejected, expired, withdrawn and failed say why it is over.
   */
  requestState: ['pending', 'dispatched', 'running', 'done', 'rejected', 'expired', 'withdrawn', 'failed'],
  requestSource: ['rule', 'model'],
  /** Where a pending card's suggestion stands (src/route/requests.ts SuggestState). */
  requestSuggesting: ['asking', 'no-desk', 'none', 'failed', 'ready'],
  /** Where a session works (orchestra app plan 项目根): a project root named at startup (or a folder in one), or its own ORCHESTRA_HOME\work\<id>. */
  cwdKind: ['project-root', 'work'],
  /**
   * Why an agent request's session would run in Orchestra's own work dir and not in its cwd (src/os/project-roots.ts
   * RunInWhy): no project root named, not a plain absolute path, a `..` in it, outside every root, a protected
   * place, a link on it, not there, not a directory, not known to be a directory (stat-refused: the read gate
   * would not look, or the lookup failed otherwise; T1, not "not there"), or hidden in part by the redactor.
   */
  /** Where an approval's turns came from (r4 §8.5 source chain): a seat request, or an owned session that sent this one out. */
  originKind: ['agent-request', 'worker-dispatch'],
  /** A session's dispatch permission (src/route/dispatch.ts): 派前问你 or 直接派出. 你不在也派 is none: r4 D20. */
  grantLevel: ['ask', 'free'],
  /** Whether you are here (src/route/presence.ts, r4 Q-P3); unknown: no page was heard. */
  presence: ['present', 'away', 'unknown'],
  /** Why a request of a session at 直接派出 waits for you all the same. */
  askWhy: ['tainted', 'away', 'presence-unknown'],
  runInWhy: ['no-roots', 'bad-path', 'dot-segments', 'outside-roots', 'protected', 'reparsed', 'not-found', 'not-a-directory', 'stat-refused', 'redacted'],
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
  /** An agent request's task text, label and cwd, in UTF-8 bytes (src/route/requests.ts REQUEST_LIMITS). */
  requestTextBytes: 2048,
  requestLabelBytes: 120,
  requestCwdBytes: 520,
  /** A session's cwd or a project root, in UTF-8 bytes (a Windows path of at most 260 UTF-16 units, each at most 3 bytes, is 780). */
  cwdBytes: 780,
  /** The project roots named at startup (src/runtime/test-profile.ts PROJECT_ROOTS_MAX). */
  roots: 16,
  /** The router model's reason for a model, in UTF-8 bytes (routes.ts SUGGEST_REPLY's 200 code points, at most 4 bytes each). */
  reasonBytes: 800,
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
  'end.safety-stop': '已结束：安全检查停了它（模型、工具或插件不在允许范围内）',
  'end.interrupt-unsure': '已结束：你按了中断，但它还有没处理的消息，为免停不住，Orchestra 结束了它',
  'end.protocol-error': '已结束：它发来了 Orchestra 读不懂的内容，Orchestra 停了它',
  'end.daemon-stop': '已结束：orchestrad 停机时结束了它',
  // T1: no word on whether everything stopped: the feed's tree-* note says (gone after a restart: unknown then).
  'end.braked': '已结束：你踩了刹车，Orchestra 结束了它 Job 里的进程（是否全停见对话记录）',
  'end.requester-withdrew': '已结束：请求它的 DSH 会话撤回了请求，Orchestra 按正常顺序结束了它（不是刹车）',
  'end.unknown': '已结束',
  // The newest thing the session said or did, for its activity line (src/sources/tower.ts ownedNode).
  'act.command': '命令：',
  'act.file-change': '改文件：',
  'act.you': '你说：',
  'act.auto-denied': '自动拒绝了：',
  'act.interrupted': '被中断前：',
  // Its sub-agents (src/sources/tower.ts memberNode). Nothing here says how the work went: a report is not a verdict (T2).
  'member.unnamed': '子代理（名字未知）',
  'member.asking': '在等你审批：',
  'member.unheard': '还没听到它的状态',
  'member.gone': '会话结束时它还没回报，现在怎样不知道',
  'member.end.failed': '已结束：它这一轮失败了，没有回报',
  'member.end.interrupted': '已结束：被打断了，没有回报',
  'member.end.shutdown': '已结束：被关掉了，没有回报',
  'member.failed': '其中 {n} 步失败',
  'member.ran-unasked': '其中 {n} 步没来问就跑了',
  'member.off-list': '用了名单外的型号：{m}',
  'members-over': '另有 {n} 个子代理超出上限，没列出',
});

export const OWNED_ID_RE = frozen(/^[0-9a-f]{20}$/);
/** A sub-agent's node id on a dispatch row (src/sources/tower.ts memberNodeId). */
export const MEMBER_REF_RE = frozen(/^n:[0-9a-f]{20}$/);
export const APPROVAL_ID_RE = frozen(/^[0-9a-f]{32}$/);
export const OWNED_DIGEST_RE = frozen(/^[0-9a-f]{64}$/);
export const OWNED_UUID_RE = frozen(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** A code (why the feature is off, a feed event's state): ASCII, never source text. */
export const OWNED_CODE_RE = frozen(/^[a-z][a-z0-9.-]{0,63}$/);
/** An agent request's id (src/route/requests.ts REQUEST_ID_RE). */
export const REQUEST_ID_RE = frozen(/^[0-9a-f]{20}$/);
/** Who asked, as the card names it: dsh:<its session id> (an id, never free text). */
/** A requester as the list names it: dsh:<its session id>, or dsh when it named none. */
export const REQUESTER_RE = frozen(/^(?:dsh(?::[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})?|owned:[0-9a-f]{20})$/);
/** The DSH session id a request named itself by, bare (src/route/requests.ts REQUESTER_ID_RE): an approval's origin.requester. */
export const REQUESTER_SESSION_RE = frozen(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
/** A model of the owned list (src/owned/models.ts OWNED_MODEL_RE). */
export const OWNED_MODEL_NAME_RE = frozen(/^(?:zcode|opencode-go|codex)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** A drive-letter absolute path (a cwd, a project root). */
const ABS_PATH_RE = /^[A-Za-z]:\\/;
// C0 and C1 controls but tab and newline, DEL, and the bidi embeddings, overrides and isolates.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
/** Whether a text holds what every shown text here refuses (src/os/project-roots.ts holds a project root to it). @param {string} s */
export function holdsControl(s) {
  return CONTROLS.test(s);
}

/**
 * @typedef {{
 *   v: 1, kind: 'owned-list', rev: number, enabled: boolean, disabledWhy: string | null, brakeWhy: string | null,
 *   harnesses: { codex: boolean, claude: boolean }, roots: string[],
 *   owned: OwnedEntry[], approvals: ApprovalEntry[], limits: { maxOwned: number, active: number }, requests: RequestEntry[],
 *   requestedGone: string[], sentGone: string[],
 * }} OwnedList
 *   roots: the project roots named at startup (--project-root, checked), in the order named; the dispatch
 *   dialog offers them and owned-new's root must be one of them. Empty: none, every session works in
 *   Orchestra's own work dir.
 *   requestedGone: ownedIds of sessions you dispatched for an agent request whose details orchestrad no longer
 *   holds (evicted from memory, or from before a restart, as the journal says); never one listed in requests.
 *   sentGone: the same of sessions a worker sent out on your permission: no click of yours, so never in requestedGone.
 *   rev: the approval queue's revision; the page sends it back with an allow (stale-view otherwise).
 *   enabled: whether any harness can start a session now; disabledWhy says why not (null when enabled).
 *   brakeWhy: why a new session's tree runs without a procguard Job of its own, so it has no brake, or why
 *   the brake cannot report what it did (procguard-resident-gone) (a code; null: every brake works). T1.
 *   brake (of an entry): its tree runs in a Job of its own and its child has not closed, so the brake can
 *   still end it; an ended or failed session still stopping (its child not closed yet) has one too.
 * @typedef {{
 *   ownedId: string, harness: 'codex' | 'claude', model: string, title: string, state: string, endReason: string | null,
 *   waiting: string | null, queued: number, tokens: Tokens | null, lastSeq: number, createdAt: number, brake: boolean, stoppable: boolean,
 *   cwd: { path: string, kind: 'project-root' | 'work' } | null,
 * }} OwnedEntry
 *   title: the first line of its first message, shown (possibly empty); waiting: an approvalId.
 *   stoppable: a sub-agent of it is live (running or idle), past the list's bound with no end heard, or over with a turn or command still open or its last stop unconfirmed, or a command of its own outlived its turn or its last stop, so the stop has something to reach even with no turn of its own running.
 *   cwd: where it works, a project root (or a folder in one) or its own work dir; null when not known (T1).
 * @typedef {{ input: number, cachedInput: number, output: number, total: number }} Tokens
 * @typedef {{
 *   requestId: string, harness: 'codex' | 'claude', label: string | null, text: string, cwd: string,
 *   runIn: string | null, runInWhy: string | null, requester: string, state: string,
 *   createdAt: number, expiresAt: number, ownedId: string | null, why: string | null, fetched: boolean,
 *   suggestion: { routeId: string | null, router: string, models: { model: string, source: string, rule: string | null, reason: string | null }[], pick: number | null } | null,
 *   suggesting: 'asking' | 'no-desk' | 'none' | 'failed' | 'ready',
 * }} RequestEntry
 *   An agent request (seat): text, label and cwd are the requester's words, redacted and shown; expiresAt the wall
 *   time a pending one is refused at by itself (D8); ownedId the session you dispatched for it. requester is
 *   dsh:<id> or dsh when it named none: its own word, never checked (the page says 自称, 未核实, and 未知
 *   for none). fetched: a done reply went to the agent port's pipe (whether the requester read it, unknown);
 *   only a done request is ever fetched. suggesting: where the suggestion stands (ready exactly when the
 *   suggestion is there, for a request still pending when it came). runIn: where a dispatch runs its session
 *   (its cwd, resolved, inside a project root); null: in Orchestra's own work dir, and runInWhy says why.
 * @typedef {{
 *   approvalId: string, ownedId: string, kind: string, title: string, preview: string, tooLong: boolean, redactions: number,
 *   digest: string, risk: string, high: boolean, tainted: boolean, origin: ApprovalOrigin | null, rev: number, canAccept: boolean, canText: boolean, deadline: number,
 * }} ApprovalEntry
 *   high: r4 §10.9's high risk (a shell, the network, a protected path or a write outside the work dir,
 *   a grant, a hidden secret): the page asks to hold or type before it sends an allow.
 *   tainted: r4 §8.5, the session runs a seat request (an unbound sender): the card has a red bar and says
 *   where the request came from, and a high-risk allow takes the typed word only (no hold).
 *   origin: r4 §8.5's source chain, which the card and the pin write at the top: the seat request the session
 *   runs, or the worker that dispatched it (null: a person's own sentence). Display only (outside the digest;
 *   nothing allows by it); a seat request's is only on a tainted entry, a worker's on either, as that worker is.
 *   deadline: the wall time (epoch ms) the queue declines it at (D8: a timeout is a refusal).
 * @typedef {{ kind: 'agent-request' | 'worker-dispatch', requestId: string, requester: string | null, label: string | null }} ApprovalOrigin
 *   requester: the DSH session id the request named itself by, its own word (the page says 自称, 未核实), or
 *   null when it named none (the page says 未知, T1); of a worker's dispatch, that session's ownedId, as orchestrad
 *   knows it. label: the request's label as its card showed it, or that worker's title (one line, a cut ends in
 *   '…'), or null.
 * @typedef {{
 *   v: 1, kind: 'owned-feed', ownedId: string, from: number, to: number, clipped: boolean, events: FeedEntry[],
 * }} OwnedFeed
 * @typedef {{
 *   seq: number, at: number, kind: string, ref: string | null, uuid: string | null, text: string | null, state: string | null,
 *   redactions: number, live: boolean, exitCode: number | null, tokens: Tokens | null, batch: number | null,
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
  const s = c.obj(x, '$', ['v', 'kind', 'rev', 'enabled', 'disabledWhy', 'brakeWhy', 'harnesses', 'roots', 'owned', 'approvals', 'limits', 'requests', 'requestedGone', 'sentGone', 'presence']);
  if (s === null) return { ok: false, errors: c.errors };
  if (s.v !== OWNED_V) c.bad('$.v', `${JSON.stringify(s.v)}, not ${OWNED_V}`);
  if (s.kind !== 'owned-list') c.bad('$.kind', `${JSON.stringify(s.kind)}, not owned-list`);
  c.int(s.rev, '$.rev');
  c.bool(s.enabled, '$.enabled');
  c.en(s.presence, '$.presence', OWNED_ENUMS.presence);
  if (s.disabledWhy !== null) c.re(s.disabledWhy, '$.disabledWhy', OWNED_CODE_RE, 'code');
  // T1: off says why; on has no why.
  if ((s.enabled === false) !== (s.disabledWhy !== null)) c.bad('$.disabledWhy', 'set exactly when enabled is false');
  if (s.brakeWhy !== null) c.re(s.brakeWhy, '$.brakeWhy', OWNED_CODE_RE, 'code');
  const h = c.obj(s.harnesses, '$.harnesses', OWNED_ENUMS.harness);
  if (h !== null) {
    for (const k of OWNED_ENUMS.harness) c.bool(h[k], `$.harnesses.${k}`);
    if (s.enabled === true && !OWNED_ENUMS.harness.some((k) => h[k] === true)) c.bad('$.enabled', 'true, but no harness can start a session');
    if (s.enabled === false && OWNED_ENUMS.harness.some((k) => h[k] === true)) c.bad('$.enabled', 'false, but a harness can start a session');
  }

  // The project roots (--project-root): absolute paths, each once; none unless named.
  const roots = c.arr(s.roots, '$.roots');
  if (roots.length > OWNED_BOUNDS.roots) c.bad('$.roots', `${roots.length}, at most ${OWNED_BOUNDS.roots}`);
  const rootKeys = new Set();
  roots.forEach((r, i) => {
    c.text(r, `$.roots[${i}]`, OWNED_BOUNDS.cwdBytes);
    if (typeof r === 'string' && !ABS_PATH_RE.test(r)) c.bad(`$.roots[${i}]`, 'not an absolute path');
    if (typeof r === 'string' && rootKeys.has(r.toLowerCase())) c.bad(`$.roots[${i}]`, 'listed twice');
    if (typeof r === 'string') rootKeys.add(r.toLowerCase());
  });

  /** @type {Map<unknown, Record<string, unknown>>} */
  const sessions = new Map();
  c.arr(s.owned, '$.owned').forEach((e, i) => {
    const at = `$.owned[${i}]`;
    const o = c.obj(e, at, ['ownedId', 'harness', 'model', 'title', 'state', 'endReason', 'waiting', 'queued', 'tokens', 'lastSeq', 'createdAt', 'brake', 'cwd', 'stoppable', 'dispatch']);
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
    c.bool(o.brake, `${at}.brake`);
    // Nothing of a session an earlier orchestrad left runs here: there is no tree to brake. An ended or
    // failed one may still be stopping (its child not closed yet), and the brake still reaches it.
    if (o.state === 'unknown' && o.brake === true) c.bad(`${at}.brake`, 'a session an earlier orchestrad left has no tree to brake');
    c.bool(o.stoppable, `${at}.stoppable`);
    // Nothing can reach a sub-agent of a session that is over.
    if (over && o.stoppable === true) c.bad(`${at}.stoppable`, 'a session that is over has nothing to stop');
    // Its dispatch permission: null when it has no dispatch tool (none here, or it is over).
    if (o.dispatch !== null) {
      const d = c.obj(o.dispatch, `${at}.dispatch`, ['level', 'grantAt', 'depth', 'tainted']);
      if (d !== null) {
        c.en(d.level, `${at}.dispatch.level`, OWNED_ENUMS.grantLevel);
        if (d.grantAt !== null) c.int(d.grantAt, `${at}.dispatch.grantAt`);
        c.int(d.depth, `${at}.dispatch.depth`);
        c.bool(d.tainted, `${at}.dispatch.tainted`);
        if (d.level === 'free' && d.grantAt === null) c.bad(`${at}.dispatch.grantAt`, 'only a person opens 直接派出, and that has a time');
      }
      if (over) c.bad(`${at}.dispatch`, 'a session that is over dispatches nothing');
    }
    // Where it works; null when not known (a session an earlier orchestrad left: the registry keeps no path).
    if (o.cwd !== null) {
      const w = c.obj(o.cwd, `${at}.cwd`, ['path', 'kind']);
      if (w !== null) {
        c.text(w.path, `${at}.cwd.path`, OWNED_BOUNDS.cwdBytes);
        if (typeof w.path === 'string' && !ABS_PATH_RE.test(w.path)) c.bad(`${at}.cwd.path`, 'not an absolute path');
        c.en(w.kind, `${at}.cwd.kind`, OWNED_ENUMS.cwdKind);
        if (w.kind === 'project-root' && roots.length === 0) c.bad(`${at}.cwd.kind`, 'project-root, but no project root is listed');
      }
    }
  });

  /** @type {Map<unknown, Record<string, unknown>[]>} */
  const byOwned = new Map();
  const ids = new Set();
  c.arr(s.approvals, '$.approvals').forEach((e, i) => {
    const at = `$.approvals[${i}]`;
    const a = c.obj(e, at, ['approvalId', 'ownedId', 'kind', 'title', 'preview', 'tooLong', 'redactions', 'digest', 'risk', 'high', 'tainted', 'origin', 'rev', 'canAccept', 'canText', 'deadline']);
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
    c.bool(a.tainted, `${at}.tainted`);
    checkOrigin(c, a.origin, `${at}.origin`);
    // A source chain from an agent request is an unbound sender's: its session is tainted (r4 §8.5). One from a clean owned session is not.
    if (/** @type {any} */ (a.origin)?.kind === 'agent-request' && a.tainted !== true) c.bad(`${at}.origin`, 'a source chain from an agent request on an entry that is not tainted');
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

  checkRequests(c, s.requests);
  const listed = new Set(c.arr(s.requests, '$.requests').map((r) => (r !== null && typeof r === 'object' ? /** @type {any} */ (r).ownedId : null)));
  for (const key of /** @type {const} */ (['requestedGone', 'sentGone'])) {
    c.arr(s[key], `$.${key}`).forEach((id, i) => {
      c.re(id, `$.${key}[${i}]`, OWNED_ID_RE, 'owned id');
      if (listed.has(id)) c.bad(`$.${key}[${i}]`, `${String(id)} is a listed request's session`);
    });
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
 * An approval's source chain (r4 §8.5): null, or the seat request its session runs, with the requester's own
 * id (an id, never free text) or null, and its label as shown (one line, no control or bidi character).
 * @param {Checker} c @param {unknown} v @param {string} at
 */
function checkOrigin(c, v, at) {
  if (v === null) return;
  const o = c.obj(v, at, ['kind', 'requestId', 'requester', 'label']);
  if (o === null) return;
  c.en(o.kind, `${at}.kind`, OWNED_ENUMS.originKind);
  c.re(o.requestId, `${at}.requestId`, REQUEST_ID_RE, 'request id');
  if (o.requester !== null) c.re(o.requester, `${at}.requester`, REQUESTER_SESSION_RE, 'requester session id');
  if (o.label !== null) {
    c.text(o.label, `${at}.label`, OWNED_BOUNDS.requestLabelBytes);
    if (typeof o.label === 'string' && LINE_BREAKS.test(o.label)) c.bad(`${at}.label`, 'more than one line');
    // The rest of what src/owned/text.ts escapeInvisible writes out (LRM, RLM, ALM, zero-width and the other format
    // characters) never reaches a label as itself: one that did is refused, not drawn (r4 §5.3 rendering rule 2).
    if (typeof o.label === 'string' && FORMAT.test(o.label)) c.bad(`${at}.label`, 'holds an invisible format character');
  }
}

// One line: no CR, LF, line separator or paragraph separator.
const LINE_BREAKS = /[\r\n\u2028\u2029]/;
// Format characters (Unicode Cf: the bidi marks LRM, RLM and ALM, zero-width joiners and spaces, the soft hyphen...).
const FORMAT = /\p{Cf}/u;

/**
 * The agent requests (seat): each names its harness, its text, label and cwd as shown, who asked, its
 * state and the wall time a pending one expires at (D8: then it is a refusal); a dispatched, running or
 * done one names its session, a pending, rejected or expired one none. The suggestion lists only models
 * of the request's harness, and its pick is one of them.
 * @param {Checker} c @param {unknown} v
 */
function checkRequests(c, v) {
  const ids = new Set();
  c.arr(v, '$.requests').forEach((e, i) => {
    const at = `$.requests[${i}]`;
    const r = c.obj(e, at, ['requestId', 'harness', 'label', 'text', 'cwd', 'runIn', 'runInWhy', 'requester', 'tainted', 'model', 'askWhy', 'auto', 'state', 'createdAt', 'expiresAt', 'ownedId', 'why', 'fetched', 'suggestion', 'suggesting']);
    if (r === null) return;
    c.re(r.requestId, `${at}.requestId`, REQUEST_ID_RE, 'request id');
    if (ids.has(r.requestId)) c.bad(`${at}.requestId`, `${String(r.requestId)} listed twice`);
    ids.add(r.requestId);
    c.en(r.harness, `${at}.harness`, OWNED_ENUMS.harness);
    if (r.label !== null) c.text(r.label, `${at}.label`, OWNED_BOUNDS.requestLabelBytes);
    c.text(r.text, `${at}.text`, OWNED_BOUNDS.requestTextBytes);
    c.text(r.cwd, `${at}.cwd`, OWNED_BOUNDS.requestCwdBytes);
    // Where its session runs: runIn (a path in a project root) or the work dir with why, exactly one of the two.
    if (r.runIn !== null) {
      c.text(r.runIn, `${at}.runIn`, OWNED_BOUNDS.cwdBytes);
      if (typeof r.runIn === 'string' && !ABS_PATH_RE.test(r.runIn)) c.bad(`${at}.runIn`, 'not an absolute path');
    }
    if (r.runInWhy !== null) c.en(r.runInWhy, `${at}.runInWhy`, OWNED_ENUMS.runInWhy);
    if ((r.runIn === null) === (r.runInWhy === null)) c.bad(`${at}.runInWhy`, 'set exactly when runIn is null');
    c.re(r.requester, `${at}.requester`, REQUESTER_RE, 'requester');
    c.bool(r.tainted, `${at}.tainted`);
    if (r.model !== null) c.re(r.model, `${at}.model`, OWNED_MODEL_NAME_RE, 'model of the owned list');
    if (r.askWhy !== null) c.en(r.askWhy, `${at}.askWhy`, OWNED_ENUMS.askWhy);
    c.bool(r.auto, `${at}.auto`);
    // Only a session's own call goes out on its permission: a DSH session's request never does, and a tainted one never does.
    if (r.auto === true && (typeof r.requester !== 'string' || !r.requester.startsWith('owned:') || r.tainted === true)) c.bad(`${at}.auto`, 'only a clean owned session dispatches on its permission');
    if (typeof r.requester === 'string' && r.requester.startsWith('dsh') && r.tainted !== true) c.bad(`${at}.tainted`, 'a DSH session is an unbound sender (r4 §8.5)');
    c.en(r.state, `${at}.state`, OWNED_ENUMS.requestState);
    c.int(r.createdAt, `${at}.createdAt`);
    c.int(r.expiresAt, `${at}.expiresAt`);
    if (r.ownedId !== null) c.re(r.ownedId, `${at}.ownedId`, OWNED_ID_RE, 'owned id');
    const bound = r.state === 'dispatched' || r.state === 'running' || r.state === 'done';
    const unbound = r.state === 'pending' || r.state === 'rejected' || r.state === 'expired';
    if (bound && r.ownedId === null) c.bad(`${at}.ownedId`, `a ${String(r.state)} request names its session`);
    if (unbound && r.ownedId !== null) c.bad(`${at}.ownedId`, `a ${String(r.state)} request names no session`);
    if (r.why !== null) c.re(r.why, `${at}.why`, OWNED_CODE_RE, 'code');
    c.bool(r.fetched, `${at}.fetched`);
    if (r.fetched === true && r.state !== 'done') c.bad(`${at}.fetched`, `a ${String(r.state)} request was never handed back`);
    c.en(r.suggesting, `${at}.suggesting`, OWNED_ENUMS.requestSuggesting);
    if (r.suggestion !== null && r.suggesting !== 'ready') c.bad(`${at}.suggesting`, `${String(r.suggesting)}, but a suggestion is there`);
    if (r.suggestion === null) return;
    const g = c.obj(r.suggestion, `${at}.suggestion`, ['routeId', 'router', 'models', 'pick']);
    if (g === null) return;
    if (g.routeId !== null) c.re(g.routeId, `${at}.suggestion.routeId`, REQUEST_ID_RE, 'route id');
    c.re(g.router, `${at}.suggestion.router`, OWNED_CODE_RE, 'code');
    const models = c.arr(g.models, `${at}.suggestion.models`);
    if (models.length > 3) c.bad(`${at}.suggestion.models`, `${models.length}, at most 3`);
    models.forEach((m, k) => {
      const mat = `${at}.suggestion.models[${k}]`;
      const o = c.obj(m, mat, ['model', 'source', 'rule', 'reason']);
      if (o === null) return;
      c.re(o.model, `${mat}.model`, OWNED_MODEL_NAME_RE, 'model of the owned list');
      c.en(o.source, `${mat}.source`, OWNED_ENUMS.requestSource);
      if (o.rule !== null) c.re(o.rule, `${mat}.rule`, OWNED_CODE_RE, 'code');
      if (o.reason !== null) c.text(o.reason, `${mat}.reason`, OWNED_BOUNDS.reasonBytes);
    });
    if (g.pick !== null) {
      c.int(g.pick, `${at}.suggestion.pick`);
      if (typeof g.pick === 'number' && g.pick >= models.length) c.bad(`${at}.suggestion.pick`, `${g.pick}, but ${models.length} models are listed`);
    }
  });
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
    const ev = c.obj(e, at, ['seq', 'at', 'kind', 'ref', 'uuid', 'text', 'state', 'redactions', 'live', 'exitCode', 'tokens', 'batch']);
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
    // A dispatch row carries its batch and names its sub-agent by node id: no thread id reaches the page.
    const dispatch = ev.kind === 'note' && ev.state === 'dispatch';
    if ((ev.batch !== null) !== dispatch) c.bad(`${at}.batch`, 'set exactly on a dispatch note');
    if (ev.batch !== null) c.int(ev.batch, `${at}.batch`, 1);
    if (dispatch) c.re(ev.ref, `${at}.ref`, MEMBER_REF_RE, 'node id');
    // What a session sent out through its dispatch tool: its row names that session's node.
    if (ev.kind === 'note' && (ev.state === 'worker-sent' || ev.state === 'worker-sent-grant')) c.re(ev.ref, `${at}.ref`, MEMBER_REF_RE, 'node id');
  });
  return { ok: c.errors.length === 0, errors: c.errors };
}
