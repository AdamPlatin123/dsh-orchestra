// @ts-check
// The stage preview's JSON contract (0.1 alpha design §3): what GET /api/peek/stage and GET
// /api/peek/session answer, and what the page reads. The daemon's golden file
// (test/fixtures/stage-snapshot.json) and the page's hand-written sample (test/fixtures/stage-ui-sample.json)
// both pass validateStage, so neither side can drift from the other without a red test. A labelled M2
// preview (r4:2051): step 4 or 5 merges or deletes it, together with the routes that serve it.
//
// Beside the shapes, the checks hold the truthfulness rules a payload can carry by itself: no work item
// claims a verdict (D19: only a non-author reviewer or you can call work done, and M0 has neither), no
// done criteria are invented (always `undeclared`), and no rule claims a checked sample (every n is 0 in
// the alpha, so the page can only show 未测（N=0）). Every reference stays inside its lane.
// Plain ESM that imports only shared/frozen.js: the page loads it as it is, like shared/protocol.js.

import { frozen } from './frozen.js';

/** Every stage payload carries v = 1. */
export const STAGE_V = 1;
/** The snapshot's kind: a preview, never a frame of the step 4 stream. */
export const STAGE_KIND = 'stage-preview';

/** 20 lowercase hex: a lane, a session (the peek digest of its file) or the tail of a player id. */
export const HEX20_RE = frozen(/^[0-9a-f]{20}$/);
/** A player: 'p:' + Hex20. */
export const PLAYER_ID_RE = frozen(/^p:[0-9a-f]{20}$/);
/** A work item: 'w:' + its key (a tool_use id, a team task id, a todo slot), ASCII without spaces. */
export const ITEM_ID_RE = frozen(/^w:[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/);
/** The snapshot's revision: 16 hex of a sha256 over the body without its time fields. */
export const REV_RE = frozen(/^[0-9a-f]{16}$/);
/** A derivation's name (lookRule, stateRule) or a source's error code: ASCII, never source text. */
export const RULE_NAME_RE = frozen(/^[a-z][A-Za-z0-9.:-]{0,63}$/);
/** An event time as the peek reader writes it (toISOString), extended years included. */
export const ISO_RE = frozen(/^(?:[+-]\d{6}|\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
// C0 and C1 controls but tab and newline, DEL, and the bidi embeddings, overrides and isolates: what
// src/sources/peek.ts's shown() removes, so a source string that still holds one skipped it.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** The enums of §3, each in the design's order. */
export const STAGE_ENUMS = frozen({
  profile: ['test', 'real'],
  srcState: ['ok', 'empty', 'error'],
  ruleStatus: ['untested', 'keys-mismatch'],
  laneBasis: ['cwd', 'slug'],
  harness: ['claude', 'dsh', 'codex'],
  role: ['principal', 'clone', 'teammate'],
  liveState: ['busy', 'idle', 'waiting', 'running', 'returned', 'quiet', 'unknown'],
  liveBasis: ['registry', 'unpaired-tool-use', 'turn', 'mtime', 'none'],
  look: ['solid', 'translucent', 'ghost'],
  instrument: ['woodwind', 'strings', 'percussion', 'brass', 'unknown'],
  standSource: ['todo', 'task-brief', 'goal', 'team-task', 'none', 'tail-miss'],
  standKeys: ['ok', 'mismatch', 'none'],
  todoStatus: ['pending', 'in_progress', 'completed', 'other'],
  note: ['tail-only', 'too-large', 'bad-frame', 'unfinished-frame'],
  itemSource: ['task', 'todo', 'team-task', 'subagent-catalog'],
  itemState: ['working', 'reported', 'orphan', 'unknown', 'self'],
  join: ['agentId', 'description', 'agentPath', 'parentSession', 'team-owner'],
  cueKind: ['dispatch', 'report'],
});

/**
 * The rules a snapshot reports, each exactly once (§3 RULES). n counts samples checked against real
 * data: 0 for all of them in the alpha, so none can read as a pass (T4).
 */
export const STAGE_RULE_IDS = frozen([
  'claude.live.registry', 'claude.join.agentId', 'claude.join.description', 'claude.clone.running', 'claude.clone.orphan',
  'claude.stand.todo-keys', 'dsh.stand.todo-keys', 'dsh.stand.goal-keys', 'dsh.team-task-keys', 'dsh.child.parentSession',
  'dsh.live.mtime', 'instrument.tool-map', 'fermata.registry-waiting',
  'codex.meta.keys', 'codex.live.turn', 'codex.waiting.unpaired', 'codex.child.parentThread', 'codex.join.spawn', 'codex.join.activity',
  'codex.stand.plan-keys',
]);

/** The bounds of §3's limits that a payload shows by itself; the body's 256 KiB is the server's to check. */
export const STAGE_BOUNDS = frozen({
  /** Principals in one snapshot, over all lanes. */
  principals: 24,
  /** Clones under one parent. */
  clonesPerParent: 16,
  /** Items on one stand. */
  standItems: 12,
  /** A source string (a label, a title, a stand item, a brief), in code points. */
  textCp: 120,
  /** A session event's text, in code points (peek's field limit). */
  eventTextCp: 2048,
  /** A session event's type, in code points. */
  eventTypeCp: 64,
  /** Events in one session detail: the last ones. */
  events: 50,
  /** Tool calls the instrument looks at: the last ones. */
  instrumentWindow: 20,
});

/**
 * @typedef {string} Hex20
 * @typedef {string} PlayerId 'p:' + Hex20
 * @typedef {string} ItemId 'w:' + key
 * @typedef {{
 *   v: 1, kind: 'stage-preview',
 *   rev: string, observedAt: number, computedMs: number,
 *   profile: 'test' | 'real',
 *   sources: { claude: Src, dsh: Src, codex: Src },
 *   rules: Rule[],
 *   podium: { fermatas: PlayerId[], inbox: null },
 *   lanes: Lane[],
 *   clipped: { lanes: number, players: number, items: number, standItems: number, sessions: { claude: number, dsh: number, codex: number } },
 * }} StageSnapshot
 * @typedef {{ state: 'ok' | 'empty' | 'error', sessions: number, shown: number, registry: number | null, error: string | null }} Src
 *   sessions: every session file the source holds, before any cut; shown: how many of them play in this
 *   snapshot. empty only when sessions is 0 (T1: a source the limits pushed out is clipped, not empty).
 * @typedef {{ id: string, hits: number, n: number, status: 'untested' | 'keys-mismatch' }} Rule
 * @typedef {{ id: Hex20, name: string, basis: 'cwd' | 'slug', players: Player[], items: WorkItem[], cues: Cue[] }} Lane
 * @typedef {{
 *   id: PlayerId, session: Hex20 | null, harness: 'claude' | 'dsh' | 'codex', role: 'principal' | 'clone' | 'teammate',
 *   parent: PlayerId | null, depth: 0 | 1 | 2 | 3 | 4, shade: 0 | 1 | 2, label: string, agentType: string | null,
 *   model: string | null, startedAt: number | null,
 *   live: { state: 'busy' | 'idle' | 'waiting' | 'running' | 'returned' | 'quiet' | 'unknown',
 *           basis: 'registry' | 'unpaired-tool-use' | 'turn' | 'mtime' | 'none', waitingFor: string | null, ageMs: number | null },
 *   look: 'solid' | 'translucent' | 'ghost', lookRule: string,
 *   instrument: { class: 'woodwind' | 'strings' | 'percussion' | 'brass' | 'unknown', window: number,
 *                 read: number, write: number, shell: number, role: string | null },
 *   stand: { source: 'todo' | 'task-brief' | 'goal' | 'team-task' | 'none' | 'tail-miss', keys: 'ok' | 'mismatch' | 'none',
 *            title: string | null, items: { text: string, status: 'pending' | 'in_progress' | 'completed' | 'other' }[],
 *            selfReported: { checked: number, total: number } },
 *   bytes: number, note: 'tail-only' | 'too-large' | 'bad-frame' | 'unfinished-frame' | null,
 * }} Player
 * @typedef {{
 *   id: ItemId, owner: PlayerId, executor: PlayerId | null, parent: ItemId | null,
 *   source: 'task' | 'todo' | 'team-task' | 'subagent-catalog',
 *   brief: string, criteria: { state: 'undeclared' },
 *   state: 'working' | 'reported' | 'orphan' | 'unknown' | 'self', stateRule: string,
 *   todoStatus: 'pending' | 'in_progress' | 'completed' | 'other' | null,
 *   join: 'agentId' | 'description' | 'agentPath' | 'parentSession' | 'team-owner' | null,
 *   report: { at: number | null, bytes: number } | null,
 *   flow: { childBytes: number, reportBytes: number } | null,
 *   verdict: 'no-reviewer',
 * }} WorkItem
 * @typedef {{ from: PlayerId, to: PlayerId, item: ItemId, kind: 'dispatch' | 'report' }} Cue
 * @typedef {{
 *   session: { id: Hex20, harness: string, label: string, size: number, mtimeMs: number },
 *   events: { at: string | null, type: string, text: string }[],
 *   unparsed: number, note: string | null, brief: string | null,
 * }} SessionDetail
 * @typedef {{ ok: boolean, errors: string[] }} Verdict
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** A payload checker that collects every problem with its path, so one run names them all. */
function checker() {
  /** @type {string[]} */
  const errors = [];
  /** @param {string} at @param {string} why */
  const bad = (at, why) => { errors.push(`${at}: ${why}`); };
  return {
    errors,
    bad,
    /**
     * An object with exactly these keys, own data fields only; null (with the problem noted) otherwise.
     * @param {unknown} v @param {string} at @param {readonly string[]} keys
     * @returns {Record<string, unknown> | null}
     */
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
    /** @param {unknown} v @param {string} at @param {number} [max] @returns {unknown[]} */
    arr(v, at, max = Number.MAX_SAFE_INTEGER) {
      if (!Array.isArray(v)) { bad(at, 'not an array'); return []; }
      if (v.length > max) bad(at, `${v.length} entries, at most ${max}`);
      return v;
    },
    /** @param {unknown} v @param {string} at @param {readonly string[]} of */
    en(v, at, of) {
      if (typeof v !== 'string' || !of.includes(v)) bad(at, `${JSON.stringify(v)} is not one of ${of.join('|')}`);
    },
    /** @param {unknown} v @param {string} at @param {number} [min] @param {number} [max] */
    int(v, at, min = 0, max = Number.MAX_SAFE_INTEGER) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad(at, `${JSON.stringify(v)} is not an integer in [${min}, ${max}]`);
    },
    /** @param {unknown} v @param {string} at @param {RegExp} re @param {string} name */
    re(v, at, re, name) {
      if (typeof v !== 'string' || !re.test(v)) bad(at, `${JSON.stringify(v)} is not a ${name}`);
    },
    /**
     * Source text as shown() leaves it: at most `max` code points, one more when the last is the clip
     * mark (peek.ts clip() appends … after cutting at `max` UTF-16 units), no control or bidi character.
     * @param {unknown} v @param {string} at @param {number} max
     */
    text(v, at, max) {
      if (typeof v !== 'string') { bad(at, 'not a string'); return; }
      const cp = [...v].length;
      if (cp > max + 1 || (cp === max + 1 && !v.endsWith('…'))) bad(at, `${cp} code points, at most ${max}`);
      if (CONTROLS.test(v)) bad(at, 'holds a control or bidi character');
    },
  };
}

/** @typedef {ReturnType<typeof checker>} Checker */

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkSrc(c, v, at) {
  const s = c.obj(v, at, ['state', 'sessions', 'shown', 'registry', 'error']);
  if (s === null) return;
  c.en(s.state, `${at}.state`, STAGE_ENUMS.srcState);
  c.int(s.sessions, `${at}.sessions`);
  c.int(s.shown, `${at}.shown`);
  if (typeof s.sessions === 'number' && typeof s.shown === 'number' && s.shown > s.sessions) c.bad(`${at}.shown`, 'more shown than the source holds');
  // T1: a source whose sessions the limits pushed out holds them still; empty means none at all.
  if (s.state === 'empty' && s.sessions !== 0) c.bad(`${at}.state`, `empty, but it holds ${String(s.sessions)} sessions`);
  if (s.state === 'ok' && s.sessions === 0) c.bad(`${at}.state`, 'ok, but it holds no session');
  if (s.registry !== null) c.int(s.registry, `${at}.registry`);
  if (s.error !== null) c.re(s.error, `${at}.error`, RULE_NAME_RE, 'error code');
  if ((s.state === 'error') !== (s.error !== null)) c.bad(`${at}.error`, 'set exactly when state is error');
}

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkPlayer(c, v, at) {
  const p = c.obj(v, at, ['id', 'session', 'harness', 'role', 'parent', 'depth', 'shade', 'label', 'agentType', 'model', 'startedAt', 'live', 'look', 'lookRule', 'instrument', 'stand', 'bytes', 'note']);
  if (p === null) return;
  c.re(p.id, `${at}.id`, PLAYER_ID_RE, 'player id');
  if (p.session !== null) c.re(p.session, `${at}.session`, HEX20_RE, 'Hex20');
  c.en(p.harness, `${at}.harness`, STAGE_ENUMS.harness);
  c.en(p.role, `${at}.role`, STAGE_ENUMS.role);
  if (p.parent !== null) c.re(p.parent, `${at}.parent`, PLAYER_ID_RE, 'player id');
  c.int(p.depth, `${at}.depth`, 0, 4);
  c.int(p.shade, `${at}.shade`, 0, 2);
  c.text(p.label, `${at}.label`, STAGE_BOUNDS.textCp);
  if (p.agentType !== null) c.text(p.agentType, `${at}.agentType`, STAGE_BOUNDS.textCp);
  if (p.model !== null) c.text(p.model, `${at}.model`, STAGE_BOUNDS.textCp);
  if (p.startedAt !== null) c.int(p.startedAt, `${at}.startedAt`);
  if (p.role === 'principal' && (p.parent !== null || p.depth !== 0)) c.bad(at, 'a principal has no parent and depth 0');
  const live = c.obj(p.live, `${at}.live`, ['state', 'basis', 'waitingFor', 'ageMs']);
  if (live !== null) {
    c.en(live.state, `${at}.live.state`, STAGE_ENUMS.liveState);
    c.en(live.basis, `${at}.live.basis`, STAGE_ENUMS.liveBasis);
    if (live.waitingFor !== null) c.text(live.waitingFor, `${at}.live.waitingFor`, STAGE_BOUNDS.textCp);
    if (live.ageMs !== null) c.int(live.ageMs, `${at}.live.ageMs`);
    if (live.waitingFor !== null && live.state !== 'waiting') c.bad(`${at}.live.waitingFor`, 'set while the state is not waiting');
  }
  c.en(p.look, `${at}.look`, STAGE_ENUMS.look);
  c.re(p.lookRule, `${at}.lookRule`, RULE_NAME_RE, 'rule name');
  const ins = c.obj(p.instrument, `${at}.instrument`, ['class', 'window', 'read', 'write', 'shell', 'role']);
  if (ins !== null) {
    c.en(ins.class, `${at}.instrument.class`, STAGE_ENUMS.instrument);
    c.int(ins.window, `${at}.instrument.window`, 0, STAGE_BOUNDS.instrumentWindow);
    for (const k of ['read', 'write', 'shell']) c.int(ins[k], `${at}.instrument.${k}`);
    if (ins.role !== null) c.text(ins.role, `${at}.instrument.role`, STAGE_BOUNDS.textCp);
    const [w, r, wr, sh] = [ins.window, ins.read, ins.write, ins.shell].map((n) => (typeof n === 'number' ? n : 0));
    if (r + wr + sh > w) c.bad(`${at}.instrument`, 'read + write + shell exceed the window');
    // The precedence of §3 (brass, percussion, strings, woodwind, unknown), as far as the counts show it.
    if (ins.class === 'percussion' && sh === 0) c.bad(`${at}.instrument`, 'percussion without a shell call');
    if (ins.class === 'strings' && (wr === 0 || sh > 0)) c.bad(`${at}.instrument`, 'strings needs a write and no shell call');
    if (ins.class === 'woodwind' && (wr > 0 || sh > 0 || w === 0)) c.bad(`${at}.instrument`, 'woodwind needs calls and no write or shell call');
    if (ins.class === 'unknown' && w > 0) c.bad(`${at}.instrument`, 'unknown with tool calls in the window');
  }
  const st = c.obj(p.stand, `${at}.stand`, ['source', 'keys', 'title', 'items', 'selfReported']);
  if (st !== null) {
    c.en(st.source, `${at}.stand.source`, STAGE_ENUMS.standSource);
    c.en(st.keys, `${at}.stand.keys`, STAGE_ENUMS.standKeys);
    if (st.title !== null) c.text(st.title, `${at}.stand.title`, STAGE_BOUNDS.textCp);
    const items = c.arr(st.items, `${at}.stand.items`, STAGE_BOUNDS.standItems);
    items.forEach((it, i) => {
      const o = c.obj(it, `${at}.stand.items[${i}]`, ['text', 'status']);
      if (o === null) return;
      c.text(o.text, `${at}.stand.items[${i}].text`, STAGE_BOUNDS.textCp);
      c.en(o.status, `${at}.stand.items[${i}].status`, STAGE_ENUMS.todoStatus);
    });
    const sr = c.obj(st.selfReported, `${at}.stand.selfReported`, ['checked', 'total']);
    if (sr !== null) {
      c.int(sr.checked, `${at}.stand.selfReported.checked`);
      c.int(sr.total, `${at}.stand.selfReported.total`);
      if (typeof sr.checked === 'number' && typeof sr.total === 'number') {
        if (sr.checked > sr.total) c.bad(`${at}.stand.selfReported`, 'more checked than total');
        // Clipped stand items are still counted in total; shown ones never outnumber it.
        if (items.length > sr.total) c.bad(`${at}.stand.selfReported`, 'fewer in total than the items shown');
      }
    }
  }
  c.int(p.bytes, `${at}.bytes`);
  if (p.note !== null) c.en(p.note, `${at}.note`, STAGE_ENUMS.note);
}

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkItem(c, v, at) {
  const w = c.obj(v, at, ['id', 'owner', 'executor', 'parent', 'source', 'brief', 'criteria', 'state', 'stateRule', 'todoStatus', 'join', 'report', 'flow', 'verdict']);
  if (w === null) return;
  c.re(w.id, `${at}.id`, ITEM_ID_RE, 'item id');
  c.re(w.owner, `${at}.owner`, PLAYER_ID_RE, 'player id');
  if (w.executor !== null) c.re(w.executor, `${at}.executor`, PLAYER_ID_RE, 'player id');
  if (w.parent !== null) c.re(w.parent, `${at}.parent`, ITEM_ID_RE, 'item id');
  c.en(w.source, `${at}.source`, STAGE_ENUMS.itemSource);
  c.text(w.brief, `${at}.brief`, STAGE_BOUNDS.textCp);
  // The brief is what was asked, never what counts as done: no source declares done criteria (T2).
  const cr = c.obj(w.criteria, `${at}.criteria`, ['state']);
  if (cr !== null && cr.state !== 'undeclared') c.bad(`${at}.criteria.state`, `${JSON.stringify(cr.state)}: criteria are always undeclared`);
  c.en(w.state, `${at}.state`, STAGE_ENUMS.itemState);
  c.re(w.stateRule, `${at}.stateRule`, RULE_NAME_RE, 'rule name');
  if (w.todoStatus !== null) c.en(w.todoStatus, `${at}.todoStatus`, STAGE_ENUMS.todoStatus);
  if (w.source === 'todo' && w.todoStatus === null) c.bad(`${at}.todoStatus`, 'a todo item carries its status');
  if (w.join !== null) c.en(w.join, `${at}.join`, STAGE_ENUMS.join);
  /** @type {Record<string, unknown> | null} */
  let report = null;
  if (w.report !== null) {
    report = c.obj(w.report, `${at}.report`, ['at', 'bytes']);
    if (report !== null) {
      if (report.at !== null) c.int(report.at, `${at}.report.at`);
      c.int(report.bytes, `${at}.report.bytes`);
    }
  }
  // Reported is the furthest a work item gets, and only a paired result reaches it.
  if ((w.state === 'reported') !== (w.report !== null)) c.bad(`${at}.report`, 'present exactly when the state is reported');
  if (w.flow !== null) {
    const f = c.obj(w.flow, `${at}.flow`, ['childBytes', 'reportBytes']);
    if (f !== null) {
      c.int(f.childBytes, `${at}.flow.childBytes`);
      c.int(f.reportBytes, `${at}.flow.reportBytes`);
      if (report === null || f.reportBytes !== report.bytes) c.bad(`${at}.flow.reportBytes`, 'not the report\'s bytes');
    }
  }
  if (w.verdict !== 'no-reviewer') c.bad(`${at}.verdict`, `${JSON.stringify(w.verdict)}: M0 has no reviewer (D19)`);
}

/**
 * The references of one lane: every parent, owner, executor and cue end is a player of this lane,
 * every item parent and cue item an item of it; a player's depth is its parent's plus one.
 * @param {Checker} c @param {Record<string, unknown>} lane @param {string} at
 */
function checkLaneRefs(c, lane, at) {
  const players = Array.isArray(lane.players) ? lane.players : [];
  const items = Array.isArray(lane.items) ? lane.items : [];
  const byId = new Map(players.filter(isRecord).map((p) => [p.id, p]));
  const itemIds = new Set(items.filter(isRecord).map((w) => w.id));
  /** @type {Map<unknown, number>} */
  const clones = new Map();
  players.forEach((p, i) => {
    if (!isRecord(p) || p.parent === null || p.parent === undefined) return;
    const parent = byId.get(p.parent);
    if (parent === undefined) { c.bad(`${at}.players[${i}].parent`, `${String(p.parent)} is no player of this lane`); return; }
    if (parent === p) c.bad(`${at}.players[${i}].parent`, 'its own parent');
    else if (typeof parent.depth === 'number' && p.depth !== parent.depth + 1) c.bad(`${at}.players[${i}].depth`, `${String(p.depth)}, its parent's is ${parent.depth}`);
    if (p.role === 'clone') clones.set(p.parent, (clones.get(p.parent) ?? 0) + 1);
  });
  for (const [parent, n] of clones) if (n > STAGE_BOUNDS.clonesPerParent) c.bad(`${at}.players`, `${n} clones under ${String(parent)}, at most ${STAGE_BOUNDS.clonesPerParent}`);
  items.forEach((w, i) => {
    if (!isRecord(w)) return;
    if (!byId.has(w.owner)) c.bad(`${at}.items[${i}].owner`, `${String(w.owner)} is no player of this lane`);
    if (w.executor !== null && w.executor !== undefined && !byId.has(w.executor)) c.bad(`${at}.items[${i}].executor`, `${String(w.executor)} is no player of this lane`);
    if (w.parent !== null && w.parent !== undefined) {
      if (!itemIds.has(w.parent)) c.bad(`${at}.items[${i}].parent`, `${String(w.parent)} is no item of this lane`);
      else if (w.parent === w.id) c.bad(`${at}.items[${i}].parent`, 'its own parent');
    }
  });
  (Array.isArray(lane.cues) ? lane.cues : []).forEach((q, i) => {
    if (!isRecord(q)) return;
    for (const k of ['from', 'to']) if (!byId.has(q[k])) c.bad(`${at}.cues[${i}].${k}`, `${String(q[k])} is no player of this lane`);
    if (!itemIds.has(q.item)) c.bad(`${at}.cues[${i}].item`, `${String(q.item)} is no item of this lane`);
  });
}

/**
 * Checks a stage snapshot against §3: every shape, enum and id grammar, and the invariants above.
 * Pure: reads `x`, changes nothing, never throws on a JSON value.
 * @param {unknown} x
 * @returns {Verdict}
 */
export function validateStage(x) {
  const c = checker();
  const s = c.obj(x, '$', ['v', 'kind', 'rev', 'observedAt', 'computedMs', 'profile', 'sources', 'rules', 'podium', 'lanes', 'clipped']);
  if (s === null) return { ok: false, errors: c.errors };
  if (s.v !== STAGE_V) c.bad('$.v', `${JSON.stringify(s.v)}, not ${STAGE_V}`);
  if (s.kind !== STAGE_KIND) c.bad('$.kind', `${JSON.stringify(s.kind)}, not ${STAGE_KIND}`);
  c.re(s.rev, '$.rev', REV_RE, 'rev (16 hex)');
  c.int(s.observedAt, '$.observedAt');
  c.int(s.computedMs, '$.computedMs');
  c.en(s.profile, '$.profile', STAGE_ENUMS.profile);

  const src = c.obj(s.sources, '$.sources', ['claude', 'dsh', 'codex']);
  if (src !== null) {
    checkSrc(c, src.claude, '$.sources.claude');
    checkSrc(c, src.dsh, '$.sources.dsh');
    checkSrc(c, src.codex, '$.sources.codex');
    // Codex keeps no registry the stage reads: its live states come from its own rollouts.
    const cx = isRecord(src.codex) ? src.codex : null;
    if (cx !== null && cx.registry !== null) c.bad('$.sources.codex.registry', 'null: Codex has no registry');
  }

  const seenRules = new Set();
  c.arr(s.rules, '$.rules').forEach((r, i) => {
    const at = `$.rules[${i}]`;
    const o = c.obj(r, at, ['id', 'hits', 'n', 'status']);
    if (o === null) return;
    c.en(o.id, `${at}.id`, STAGE_RULE_IDS);
    if (seenRules.has(o.id)) c.bad(`${at}.id`, `${String(o.id)} listed twice`);
    seenRules.add(o.id);
    c.int(o.hits, `${at}.hits`);
    // Seeing a rule fire is not validating it: no sample has been checked against real data yet (T4).
    if (o.n !== 0) c.bad(`${at}.n`, `${JSON.stringify(o.n)}: every rule has n 0 in the alpha`);
    c.en(o.status, `${at}.status`, STAGE_ENUMS.ruleStatus);
  });
  for (const id of STAGE_RULE_IDS) if (!seenRules.has(id)) c.bad('$.rules', `missing ${id}`);

  /** @type {Map<unknown, Record<string, unknown>>} */
  const allPlayers = new Map();
  const laneIds = new Set();
  const itemIds = new Set();
  let principals = 0;
  c.arr(s.lanes, '$.lanes').forEach((l, li) => {
    const at = `$.lanes[${li}]`;
    const lane = c.obj(l, at, ['id', 'name', 'basis', 'players', 'items', 'cues']);
    if (lane === null) return;
    c.re(lane.id, `${at}.id`, HEX20_RE, 'Hex20');
    if (laneIds.has(lane.id)) c.bad(`${at}.id`, `${String(lane.id)} used twice`);
    laneIds.add(lane.id);
    c.text(lane.name, `${at}.name`, STAGE_BOUNDS.textCp);
    c.en(lane.basis, `${at}.basis`, STAGE_ENUMS.laneBasis);
    c.arr(lane.players, `${at}.players`).forEach((p, i) => {
      checkPlayer(c, p, `${at}.players[${i}]`);
      if (!isRecord(p)) return;
      if (allPlayers.has(p.id)) c.bad(`${at}.players[${i}].id`, `${String(p.id)} used twice`);
      allPlayers.set(p.id, p);
      if (p.role === 'principal') principals++;
    });
    c.arr(lane.items, `${at}.items`).forEach((w, i) => {
      checkItem(c, w, `${at}.items[${i}]`);
      if (!isRecord(w)) return;
      if (itemIds.has(w.id)) c.bad(`${at}.items[${i}].id`, `${String(w.id)} used twice`);
      itemIds.add(w.id);
    });
    c.arr(lane.cues, `${at}.cues`).forEach((q, i) => {
      const o = c.obj(q, `${at}.cues[${i}]`, ['from', 'to', 'item', 'kind']);
      if (o === null) return;
      c.re(o.from, `${at}.cues[${i}].from`, PLAYER_ID_RE, 'player id');
      c.re(o.to, `${at}.cues[${i}].to`, PLAYER_ID_RE, 'player id');
      c.re(o.item, `${at}.cues[${i}].item`, ITEM_ID_RE, 'item id');
      c.en(o.kind, `${at}.cues[${i}].kind`, STAGE_ENUMS.cueKind);
    });
    checkLaneRefs(c, lane, at);
  });
  if (principals > STAGE_BOUNDS.principals) c.bad('$.lanes', `${principals} principals, at most ${STAGE_BOUNDS.principals}`);

  // The podium names who waits on you: players of the snapshot whose registry state is waiting.
  const podium = c.obj(s.podium, '$.podium', ['fermatas', 'inbox']);
  if (podium !== null) {
    const seen = new Set();
    c.arr(podium.fermatas, '$.podium.fermatas').forEach((id, i) => {
      const at = `$.podium.fermatas[${i}]`;
      c.re(id, at, PLAYER_ID_RE, 'player id');
      if (seen.has(id)) c.bad(at, `${String(id)} listed twice`);
      seen.add(id);
      const p = allPlayers.get(id);
      if (p === undefined) c.bad(at, `${String(id)} is no player of this snapshot`);
      else if (!isRecord(p.live) || p.live.state !== 'waiting') c.bad(at, `${String(id)} is not waiting`);
      // An inferred wait (a Codex question or escalation read from its rollout) is no fermata: only a registry's word is.
      else if (p.live.basis !== 'registry') c.bad(at, `${String(id)} waits by ${String(p.live.basis)}, not by a registry`);
    });
    if (podium.inbox !== null) c.bad('$.podium.inbox', 'null in the alpha: the inbox is not connected');
  }

  const clipped = c.obj(s.clipped, '$.clipped', ['lanes', 'players', 'items', 'standItems', 'sessions']);
  if (clipped !== null) {
    for (const k of ['lanes', 'players', 'items', 'standItems']) c.int(clipped[k], `$.clipped.${k}`);
    const cs = c.obj(clipped.sessions, '$.clipped.sessions', ['claude', 'dsh', 'codex']);
    for (const h of /** @type {const} */ (['claude', 'dsh', 'codex'])) {
      if (cs === null) break;
      const at = `$.clipped.sessions.${h}`;
      c.int(cs[h], at);
      // T3: what a source holds is what plays plus what was clipped, per source.
      const one = src !== null && isRecord(src[h]) ? src[h] : null;
      if (one !== null && typeof one.sessions === 'number' && typeof one.shown === 'number' && cs[h] !== one.sessions - one.shown) {
        c.bad(at, `${String(cs[h])}, not sources.${h}.sessions - shown (${one.sessions - one.shown})`);
      }
    }
  }
  // A source shows at least the sessions its principals play, at most every session its players read.
  if (src !== null) {
    for (const h of /** @type {const} */ (['claude', 'dsh', 'codex'])) {
      const one = isRecord(src[h]) ? src[h] : null;
      if (one === null || typeof one.shown !== 'number') continue;
      const roots = new Set();
      const any = new Set();
      for (const p of allPlayers.values()) {
        if (p.harness !== h || p.session === null) continue;
        any.add(p.session);
        if (p.parent === null) roots.add(p.session);
      }
      if (one.shown < roots.size) c.bad(`$.sources.${h}.shown`, `${one.shown}, but ${roots.size} of its sessions lead a tree`);
      if (one.shown > any.size) c.bad(`$.sources.${h}.shown`, `${one.shown}, but its players name ${any.size} sessions`);
    }
  }
  return { ok: c.errors.length === 0, errors: c.errors };
}

/**
 * Checks a session detail (GET /api/peek/session) against §3. The harness and note take the values
 * src/sources/peek.ts's PeekSession and PeekView give them.
 * @param {unknown} x
 * @returns {Verdict}
 */
export function validateSession(x) {
  const c = checker();
  const d = c.obj(x, '$', ['session', 'events', 'unparsed', 'note', 'brief']);
  if (d === null) return { ok: false, errors: c.errors };
  const s = c.obj(d.session, '$.session', ['id', 'harness', 'label', 'size', 'mtimeMs']);
  if (s !== null) {
    c.re(s.id, '$.session.id', HEX20_RE, 'Hex20');
    c.en(s.harness, '$.session.harness', STAGE_ENUMS.harness);
    c.text(s.label, '$.session.label', STAGE_BOUNDS.textCp);
    c.int(s.size, '$.session.size');
    c.int(s.mtimeMs, '$.session.mtimeMs');
  }
  c.arr(d.events, '$.events', STAGE_BOUNDS.events).forEach((e, i) => {
    const at = `$.events[${i}]`;
    const o = c.obj(e, at, ['at', 'type', 'text']);
    if (o === null) return;
    if (o.at !== null) c.re(o.at, `${at}.at`, ISO_RE, 'ISO time');
    c.text(o.type, `${at}.type`, STAGE_BOUNDS.eventTypeCp);
    c.text(o.text, `${at}.text`, STAGE_BOUNDS.eventTextCp);
  });
  c.int(d.unparsed, '$.unparsed');
  if (d.note !== null) c.en(d.note, '$.note', STAGE_ENUMS.note);
  if (d.brief !== null) c.text(d.brief, '$.brief', STAGE_BOUNDS.textCp);
  return { ok: c.errors.length === 0, errors: c.errors };
}
