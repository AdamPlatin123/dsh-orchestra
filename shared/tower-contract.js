// @ts-check
// The tower's JSON contract (orchestra app plan §1, tower panel research §1): what GET /api/tower
// answers and what the tower page reads. Three layers: you (the router, layer 0) -> agents (one root
// session each) -> subagents, grouped by project. The daemon's golden file (test/fixtures/tower-snapshot.json)
// passes validateTower, and so does every snapshot src/sources/tower.ts builds.
//
// Beside the shapes, the checks hold the truthfulness rules a payload can carry by itself:
// - T1: what is not known says unknown. A state nobody reported is `unknown` with basis `none`; a
//   state read off a log or guessed from a file's last write carries that basis (log, mtime), so an
//   inferred state never reads like one a registry reported. A source without a registry (DSH, Codex)
//   has no node with basis registry or a native wait. With meta.detects.error false, no node is error:
//   an error count of 0 then means "not looked", and the page does not show one.
// - T2: no node is ever done: the furthest a subagent gets is `returned` (it sent its report back).
// - T3: every count equals the length of the list it links to: tally against the nodes, a group's
//   count against its ids, a node's subtree counts against its descendants, the waiting bar against
//   the nodes that wait, clipped sessions against total - shown per source.
// - The folding rules: a node that runs, waits on you, failed or has children never folds; returned
//   leaves fold into one group (2 or more), idle leaves only from 3, and a big batch of the same agent
//   type (5 or more) into one group of its own; each group is as large as the rules make it.
// Plain ESM that imports only shared/frozen.js, so the page can load it as it is.

import { frozen } from './frozen.js';

/** Every tower payload carries v = 1. */
export const TOWER_V = 1;

/** 20 lowercase hex: a project, or a session (the peek digest of its file). */
export const TOWER_HEX20_RE = frozen(/^[0-9a-f]{20}$/);
/** A node: 'n:' + Hex20 (the same tail as the stage player it comes from). */
export const NODE_ID_RE = frozen(/^n:[0-9a-f]{20}$/);
/** The snapshot's revision: 16 hex of a sha256 over the body without its time fields. */
export const TOWER_REV_RE = frozen(/^[0-9a-f]{16}$/);
/** A source's error code: ASCII, never source text. */
export const TOWER_CODE_RE = frozen(/^[a-z][A-Za-z0-9.:-]{0,63}$/);
// C0 and C1 controls but tab and newline, DEL, and the bidi embeddings, overrides and isolates.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** The enums, each in its documented order. */
export const TOWER_ENUMS = frozen({
  profile: ['test', 'real'],
  srcState: ['ok', 'empty', 'error'],
  projectBasis: ['cwd', 'slug'],
  harness: ['claude', 'dsh', 'codex'],
  ownership: ['observed', 'owned', 'foreign'],
  layer: ['agent', 'subagent'],
  /** In sibling order: waits on you, failed, runs, unknown, returned, idle. */
  state: ['waiting', 'error', 'running', 'unknown', 'returned', 'idle'],
  /** registry: the harness reported it; log: read off the session's own events; mtime: guessed from the last write; none: unknown. */
  basis: ['registry', 'log', 'mtime', 'none'],
  waitingKind: ['approval', 'question', 'route'],
  /** orchestra: Orchestra's own queue (owned sessions, with a deadline); native: the harness says so; inferred: a guess. */
  waitingSource: ['orchestra', 'native', 'inferred'],
  groupKind: ['same-type', 'returned', 'idle'],
  routerKind: ['human'],
  /** untested: no sample checked against real data (T4); keys-mismatch: the records were not shaped as the rule expects. */
  ruleStatus: ['untested', 'keys-mismatch'],
});

/** A state's place among siblings: lower comes first. */
export const STATE_RANK = frozen(Object.fromEntries(TOWER_ENUMS.state.map((s, i) => [s, i])));

/** The bounds a payload shows by itself. */
export const TOWER_BOUNDS = frozen({
  /** A node title, in code points (one more when the last is the clip mark). */
  titleCp: 60,
  /** A node's activity line, in code points. */
  activityCp: 120,
  /** Any other source string (a project name, an agent type, a group label). */
  textCp: 120,
  /** Deepest node: an agent is 0. */
  depth: 4,
  /** Returned leaves fold from this many. */
  returnedMin: 2,
  /** Idle leaves fold from this many. */
  idleMin: 3,
  /** Leaves of one agent type fold into their own group from this many. */
  sameTypeMin: 5,
});

/**
 * @typedef {string} Hex20
 * @typedef {string} NodeId 'n:' + Hex20
 * @typedef {'claude' | 'dsh' | 'codex'} Harness
 * @typedef {'waiting' | 'error' | 'running' | 'unknown' | 'returned' | 'idle'} NodeState
 * @typedef {{
 *   meta: Meta,
 *   router: Router,
 *   projects: Project[],
 *   waitingBar: WaitingEntry[],
 *   tally: Record<NodeState, number>,
 * }} TowerSnapshot
 *   tally: nodes per state over the whole snapshot (the top bar's counts; tally.waiting is the
 *   waiting bar's length).
 * @typedef {{
 *   v: 1, rev: string, observedAt: number, profile: 'test' | 'real',
 *   detects: { error: boolean },
 *   sources: { claude: Src, dsh: Src, codex: Src },
 *   clipped: { projects: number, nodes: number, sessions: { claude: number, dsh: number, codex: number } },
 *   rules: Rule[],
 * }} Meta
 *   detects.error: whether any rule of this build reads a failure; false means no node is error and
 *   the error count is not shown (T1: not looked is not none).
 *   clipped.sessions: per source, total - shown (a breakdown, never added to clipped.nodes).
 *   rules: the derivation rules the states and links were read with, for the page's about view.
 * @typedef {{ id: string, hits: number, n: number, status: 'untested' | 'keys-mismatch' }} Rule
 *   hits: how often this snapshot used it; n: samples checked against real data. Seeing a rule fire
 *   is not validating it, so a rule says untested however many hits it has (T4).
 * @typedef {{ state: 'ok' | 'empty' | 'error', total: number, shown: number, registry: number | null, error: string | null }} Src
 *   total: every session file the source holds, before any cut; shown: how many of them are in this
 *   snapshot. empty only when total is 0 (T1: a source the limits pushed out is clipped, not empty).
 * @typedef {{ kind: 'human', dispatch: null }} Router
 *   Layer 0. In M0 it is you and nothing more; dispatch is reserved for the dispatch desk.
 * @typedef {{ id: Hex20, name: string, basis: 'cwd' | 'slug', nodes: Node[], groups: Group[] }} Project
 *   nodes: every node of the project, in tree order (a parent before its subtree, siblings by
 *   STATE_RANK); groups: the folded rows among its root nodes.
 * @typedef {{
 *   id: NodeId, session: Hex20 | null, harness: Harness,
 *   ownership: 'observed' | 'owned' | 'foreign', layer: 'agent' | 'subagent',
 *   parent: NodeId | null, depth: number,
 *   title: string, activity: string | null,
 *   state: NodeState, basis: 'registry' | 'log' | 'mtime' | 'none',
 *   waiting: Waiting | null,
 *   counts: { children: number, errors: number, waiting: number },
 *   groups: Group[],
 *   ageMs: number | null, agentType: string | null,
 * }} Node
 *   counts: over the node's whole subtree below it (not itself): descendants, those in error, those
 *   that wait on you. groups: the folded rows among its children.
 * @typedef {{ kind: 'approval' | 'question' | 'route', source: 'orchestra' | 'native' | 'inferred', deadline: number | null }} Waiting
 *   deadline: epoch ms when Orchestra's queue denies it by itself; null for a native or inferred wait
 *   (no timer of ours runs on it).
 * @typedef {{ kind: 'same-type' | 'returned' | 'idle', label: string | null, count: number, ids: NodeId[] }} Group
 *   label: the agent type of a same-type group, null otherwise.
 * @typedef {{ node: NodeId, kind: 'approval' | 'question' | 'route', source: 'orchestra' | 'native' | 'inferred', deadline: number | null }} WaitingEntry
 *   One per waiting node, deadlines first and soonest first, the rest after them.
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
    /** @param {unknown} v @param {string} at @returns {unknown[]} */
    arr(v, at) {
      if (!Array.isArray(v)) { bad(at, 'not an array'); return []; }
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
     * Shown source text: non-empty, at most `max` code points (one more when the last is the clip
     * mark), no control or bidi character.
     * @param {unknown} v @param {string} at @param {number} max
     */
    text(v, at, max) {
      if (typeof v !== 'string') { bad(at, 'not a string'); return; }
      const cp = [...v].length;
      if (cp === 0) bad(at, 'empty');
      if (cp > max + 1 || (cp === max + 1 && !v.endsWith('…'))) bad(at, `${cp} code points, at most ${max}`);
      if (CONTROLS.test(v)) bad(at, 'holds a control or bidi character');
    },
  };
}

/** @typedef {ReturnType<typeof checker>} Checker */

const HARNESSES = /** @type {const} */ (['claude', 'dsh', 'codex']);

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkSrc(c, v, at) {
  const s = c.obj(v, at, ['state', 'total', 'shown', 'registry', 'error']);
  if (s === null) return;
  c.en(s.state, `${at}.state`, TOWER_ENUMS.srcState);
  c.int(s.total, `${at}.total`);
  c.int(s.shown, `${at}.shown`);
  if (typeof s.total === 'number' && typeof s.shown === 'number' && s.shown > s.total) c.bad(`${at}.shown`, 'more shown than the source holds');
  // T1: a source whose sessions the limits pushed out holds them still; empty means none at all.
  if (s.state === 'empty' && s.total !== 0) c.bad(`${at}.state`, `empty, but it holds ${String(s.total)} sessions`);
  if (s.state === 'ok' && s.total === 0) c.bad(`${at}.state`, 'ok, but it holds no session');
  if (s.registry !== null) c.int(s.registry, `${at}.registry`);
  if (s.error !== null) c.re(s.error, `${at}.error`, TOWER_CODE_RE, 'error code');
  if ((s.state === 'error') !== (s.error !== null)) c.bad(`${at}.error`, 'set exactly when state is error');
}

/** @param {Checker} c @param {unknown} v @param {string} at @returns {Record<string, unknown> | null} */
function checkWaiting(c, v, at) {
  const w = c.obj(v, at, ['kind', 'source', 'deadline']);
  if (w === null) return null;
  c.en(w.kind, `${at}.kind`, TOWER_ENUMS.waitingKind);
  c.en(w.source, `${at}.source`, TOWER_ENUMS.waitingSource);
  if (w.deadline !== null) c.int(w.deadline, `${at}.deadline`);
  // Only Orchestra's own queue runs a clock that denies by itself (D8); a native or inferred wait has none.
  if ((w.source === 'orchestra') !== (w.deadline !== null)) c.bad(`${at}.deadline`, 'set exactly when the source is orchestra');
  return w;
}

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkGroupShape(c, v, at) {
  const g = c.obj(v, at, ['kind', 'label', 'count', 'ids']);
  if (g === null) return null;
  c.en(g.kind, `${at}.kind`, TOWER_ENUMS.groupKind);
  if (g.label !== null) c.text(g.label, `${at}.label`, TOWER_BOUNDS.textCp);
  if ((g.kind === 'same-type') !== (g.label !== null)) c.bad(`${at}.label`, 'set exactly for a same-type group');
  c.int(g.count, `${at}.count`);
  const ids = c.arr(g.ids, `${at}.ids`);
  ids.forEach((id, i) => c.re(id, `${at}.ids[${i}]`, NODE_ID_RE, 'node id'));
  // T3: the count is the length of the list it opens.
  if (g.count !== ids.length) c.bad(`${at}.count`, `${String(g.count)}, but it lists ${ids.length} ids`);
  return g;
}

/** @param {Checker} c @param {unknown} v @param {string} at */
function checkNode(c, v, at) {
  const n = c.obj(v, at, ['id', 'session', 'harness', 'ownership', 'layer', 'parent', 'depth', 'title', 'activity', 'state', 'basis', 'waiting', 'counts', 'groups', 'ageMs', 'agentType']);
  if (n === null) return null;
  c.re(n.id, `${at}.id`, NODE_ID_RE, 'node id');
  if (n.session !== null) c.re(n.session, `${at}.session`, TOWER_HEX20_RE, 'Hex20');
  c.en(n.harness, `${at}.harness`, TOWER_ENUMS.harness);
  c.en(n.ownership, `${at}.ownership`, TOWER_ENUMS.ownership);
  c.en(n.layer, `${at}.layer`, TOWER_ENUMS.layer);
  if (n.parent !== null) c.re(n.parent, `${at}.parent`, NODE_ID_RE, 'node id');
  c.int(n.depth, `${at}.depth`, 0, TOWER_BOUNDS.depth);
  if (n.parent === null && n.depth !== 0) c.bad(`${at}.depth`, 'a node without a parent has depth 0');
  if (n.layer === 'agent' && n.parent !== null) c.bad(`${at}.layer`, 'an agent has no parent');
  c.text(n.title, `${at}.title`, TOWER_BOUNDS.titleCp);
  if (n.activity !== null) c.text(n.activity, `${at}.activity`, TOWER_BOUNDS.activityCp);
  c.en(n.state, `${at}.state`, TOWER_ENUMS.state);
  c.en(n.basis, `${at}.basis`, TOWER_ENUMS.basis);
  // T1: unknown is said as unknown, and only unknown goes without a basis.
  if ((n.state === 'unknown') !== (n.basis === 'none')) c.bad(`${at}.basis`, `${String(n.basis)} with state ${String(n.state)}: basis none exactly when the state is unknown`);
  // T2: returned is a subagent's word; an agent is never reported back to anyone.
  if (n.state === 'returned' && n.layer !== 'subagent') c.bad(`${at}.state`, 'only a subagent returns');
  if (n.waiting !== null) {
    const w = checkWaiting(c, n.waiting, `${at}.waiting`);
    if (w !== null) {
      if (w.source === 'orchestra' && n.ownership !== 'owned') c.bad(`${at}.waiting.source`, 'orchestra waits only on an owned session');
      if (w.source === 'inferred' && n.basis === 'registry') c.bad(`${at}.waiting.source`, 'inferred, but the state has a registry basis');
      if (w.source === 'native' && n.basis !== 'registry' && n.basis !== 'log') c.bad(`${at}.waiting.source`, `native, but the state is guessed (${String(n.basis)})`);
    }
  }
  if ((n.state === 'waiting') !== (n.waiting !== null)) c.bad(`${at}.waiting`, 'set exactly when the state is waiting');
  const counts = c.obj(n.counts, `${at}.counts`, ['children', 'errors', 'waiting']);
  if (counts !== null) for (const k of ['children', 'errors', 'waiting']) c.int(counts[k], `${at}.counts.${k}`);
  const groups = c.arr(n.groups, `${at}.groups`).map((g, i) => checkGroupShape(c, g, `${at}.groups[${i}]`));
  if (n.ageMs !== null) c.int(n.ageMs, `${at}.ageMs`);
  if (n.agentType !== null) c.text(n.agentType, `${at}.agentType`, TOWER_BOUNDS.textCp);
  return { n, groups };
}

/**
 * The folding rules over one sibling list (a node's children, or a project's roots): every group
 * member is a foldable leaf of this list and in one group only; each kind holds what it says; and
 * nothing the rules would fold is left out.
 * @param {Checker} c @param {Record<string, unknown>[]} siblings @param {(Record<string, unknown> | null)[]} groups
 * @param {Map<unknown, Record<string, unknown>>} byId @param {string} at
 */
function checkFolding(c, siblings, groups, byId, at) {
  const sib = new Set(siblings.map((s) => s.id));
  /** @param {Record<string, unknown>} n */
  const foldable = (n) => !['running', 'waiting', 'error'].includes(/** @type {string} */ (n.state)) && (!isRecord(n.counts) || n.counts.children === 0);
  /** @type {Set<unknown>} */
  const grouped = new Set();
  /** @type {Set<unknown>} */
  const typed = new Set();
  const kinds = new Set();
  const labels = new Set();
  groups.forEach((g, gi) => {
    if (g === null) return;
    const gat = `${at}[${gi}]`;
    if (g.kind !== 'same-type') {
      if (kinds.has(g.kind)) c.bad(`${gat}.kind`, `a second ${String(g.kind)} group`);
      kinds.add(g.kind);
    } else {
      if (labels.has(g.label)) c.bad(`${gat}.label`, `a second same-type group of ${String(g.label)}`);
      labels.add(g.label);
    }
    const ids = Array.isArray(g.ids) ? g.ids : [];
    const min = g.kind === 'returned' ? TOWER_BOUNDS.returnedMin : g.kind === 'idle' ? TOWER_BOUNDS.idleMin : TOWER_BOUNDS.sameTypeMin;
    if (ids.length < min) c.bad(`${gat}.ids`, `${ids.length} in a ${String(g.kind)} group, at least ${min}`);
    ids.forEach((id, i) => {
      if (grouped.has(id)) c.bad(`${gat}.ids[${i}]`, `${String(id)} in two groups`);
      grouped.add(id);
      const n = byId.get(id);
      if (n === undefined || !sib.has(id)) { c.bad(`${gat}.ids[${i}]`, `${String(id)} is not among these siblings`); return; }
      if (!foldable(n)) c.bad(`${gat}.ids[${i}]`, `${String(id)} (${String(n.state)}, or with children) never folds`);
      if (g.kind === 'returned' && n.state !== 'returned') c.bad(`${gat}.ids[${i}]`, `${String(id)} is ${String(n.state)}, not returned`);
      if (g.kind === 'idle' && n.state !== 'idle') c.bad(`${gat}.ids[${i}]`, `${String(id)} is ${String(n.state)}, not idle`);
      if (g.kind === 'same-type') {
        if (n.agentType !== g.label) c.bad(`${gat}.ids[${i}]`, `${String(id)} is of type ${String(n.agentType)}, not ${String(g.label)}`);
        typed.add(id);
      }
    });
  });
  // As large as the rules make it: what is left out stays under each threshold.
  const loose = siblings.filter((n) => foldable(n) && !grouped.has(n.id));
  if (loose.filter((n) => n.state === 'returned').length >= TOWER_BOUNDS.returnedMin) c.bad(at, 'returned leaves left unfolded');
  if (loose.filter((n) => n.state === 'idle').length >= TOWER_BOUNDS.idleMin) c.bad(at, 'idle leaves left unfolded');
  /** @type {Map<unknown, number>} */
  const perType = new Map();
  for (const n of siblings) if (foldable(n) && n.agentType !== null && !typed.has(n.id)) perType.set(n.agentType, (perType.get(n.agentType) ?? 0) + 1);
  for (const [t, k] of perType) if (k >= TOWER_BOUNDS.sameTypeMin) c.bad(at, `${k} leaves of type ${String(t)} left out of a same-type group`);
}

/**
 * One project's tree: references stay inside the project, the list is in tree order with siblings by
 * STATE_RANK, a child's depth is its parent's plus one and its harness its parent's, the subtree
 * counts are recomputed, and every sibling list folds by the rules.
 * @param {Checker} c @param {Record<string, unknown>} project @param {{ n: Record<string, unknown>, groups: (Record<string, unknown> | null)[] }[]} checked @param {string} at
 */
function checkTree(c, project, checked, at) {
  const nodes = checked.map((x) => x.n);
  /** @type {Map<unknown, Record<string, unknown>>} */
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** @type {Map<unknown, Record<string, unknown>[]>} */
  const kids = new Map();
  /** @type {Record<string, unknown>[]} */
  const roots = [];
  /** @type {Record<string, unknown>[]} */
  const stack = [];
  nodes.forEach((n, i) => {
    const nat = `${at}.nodes[${i}]`;
    if (n.parent === null) {
      roots.push(n);
      stack.length = 0;
    } else {
      const parent = byId.get(n.parent);
      if (parent === undefined) { c.bad(`${nat}.parent`, `${String(n.parent)} is no node of this project`); return; }
      if (parent === n) { c.bad(`${nat}.parent`, 'its own parent'); return; }
      if (n.layer !== 'subagent') c.bad(`${nat}.layer`, 'a node with a parent is a subagent');
      if (typeof parent.depth === 'number' && n.depth !== parent.depth + 1) c.bad(`${nat}.depth`, `${String(n.depth)}, its parent's is ${parent.depth}`);
      if (n.harness !== parent.harness) c.bad(`${nat}.harness`, `${String(n.harness)} under a ${String(parent.harness)} parent`);
      while (stack.length > 0 && stack[stack.length - 1] !== parent) stack.pop();
      // A parent off the path above (later in the list, or in a loop of parents): reported and not
      // linked, so every link goes from an earlier node to a later one and the walk below ends.
      if (stack.length === 0) { c.bad(nat, 'not in tree order: its parent is not on the path above it'); return; }
      const list = kids.get(n.parent) ?? [];
      list.push(n);
      kids.set(n.parent, list);
    }
    stack.push(n);
  });
  /** @param {Record<string, unknown>[]} list @param {string} where */
  const ordered = (list, where) => {
    for (let i = 1; i < list.length; i++) {
      const a = STATE_RANK[/** @type {string} */ (list[i - 1]?.state)] ?? 0;
      const b = STATE_RANK[/** @type {string} */ (list[i]?.state)] ?? 0;
      if (b < a) c.bad(where, `${String(list[i]?.id)} (${String(list[i]?.state)}) after ${String(list[i - 1]?.id)} (${String(list[i - 1]?.state)})`);
    }
  };
  ordered(roots, `${at}.nodes (roots)`);
  for (const [p, list] of kids) ordered(list, `${at}.nodes (children of ${String(p)})`);
  // T3 for the subtree counts: recomputed from the descendants, so the waiting count bubbles up.
  // Children before parents (the reverse of the list, whose links all point forward), each node once.
  /** @type {Map<unknown, { children: number, errors: number, waiting: number }>} */
  const sums = new Map();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = /** @type {Record<string, unknown>} */ (nodes[i]);
    const out = { children: 0, errors: 0, waiting: 0 };
    for (const k of kids.get(n.id) ?? []) {
      const sub = sums.get(k.id) ?? { children: 0, errors: 0, waiting: 0 };
      out.children += 1 + sub.children;
      out.errors += (k.state === 'error' ? 1 : 0) + sub.errors;
      out.waiting += (k.state === 'waiting' ? 1 : 0) + sub.waiting;
    }
    if (!sums.has(n.id)) sums.set(n.id, out);
  }
  /** @param {Record<string, unknown>} n */
  const below = (n) => sums.get(n.id) ?? { children: 0, errors: 0, waiting: 0 };
  checked.forEach(({ n, groups }, i) => {
    const want = below(n);
    if (isRecord(n.counts)) {
      for (const k of /** @type {const} */ (['children', 'errors', 'waiting'])) {
        if (n.counts[k] !== want[k]) c.bad(`${at}.nodes[${i}].counts.${k}`, `${String(n.counts[k])}, but its subtree holds ${want[k]}`);
      }
    }
    checkFolding(c, kids.get(n.id) ?? [], groups, byId, `${at}.nodes[${i}].groups`);
  });
  const pgroups = c.arr(project.groups, `${at}.groups`).map((g, i) => checkGroupShape(c, g, `${at}.groups[${i}]`));
  checkFolding(c, roots, pgroups, byId, `${at}.groups`);
}

/**
 * Checks a tower snapshot: every shape, enum and id grammar, and the invariants above.
 * Pure: reads `x`, changes nothing, never throws on a JSON value.
 * @param {unknown} x
 * @returns {Verdict}
 */
export function validateTower(x) {
  const c = checker();
  const s = c.obj(x, '$', ['meta', 'router', 'projects', 'waitingBar', 'tally']);
  if (s === null) return { ok: false, errors: c.errors };

  const meta = c.obj(s.meta, '$.meta', ['v', 'rev', 'observedAt', 'profile', 'detects', 'sources', 'clipped', 'rules']);
  /** @type {Record<string, unknown> | null} */
  let src = null;
  /** Whether this build reads failures at all; true when the payload does not say (each node is then held to nothing more). */
  let detectsError = true;
  if (meta !== null) {
    if (meta.v !== TOWER_V) c.bad('$.meta.v', `${JSON.stringify(meta.v)}, not ${TOWER_V}`);
    c.re(meta.rev, '$.meta.rev', TOWER_REV_RE, 'rev (16 hex)');
    c.int(meta.observedAt, '$.meta.observedAt');
    c.en(meta.profile, '$.meta.profile', TOWER_ENUMS.profile);
    const detects = c.obj(meta.detects, '$.meta.detects', ['error']);
    if (detects !== null) {
      if (typeof detects.error !== 'boolean') c.bad('$.meta.detects.error', `${JSON.stringify(detects.error)} is not a boolean`);
      else detectsError = detects.error;
    }
    src = c.obj(meta.sources, '$.meta.sources', HARNESSES);
    if (src !== null) {
      for (const h of HARNESSES) checkSrc(c, src[h], `$.meta.sources.${h}`);
      // Neither DSH nor Codex keeps a registry Orchestra reads: what their nodes say is read off a log or guessed.
      for (const h of /** @type {const} */ (['dsh', 'codex'])) {
        const one = isRecord(src[h]) ? src[h] : null;
        if (one !== null && one.registry !== null) c.bad(`$.meta.sources.${h}.registry`, `null: ${h === 'dsh' ? 'DSH' : 'Codex'} has no registry`);
      }
    }
    const clipped = c.obj(meta.clipped, '$.meta.clipped', ['projects', 'nodes', 'sessions']);
    if (clipped !== null) {
      c.int(clipped.projects, '$.meta.clipped.projects');
      c.int(clipped.nodes, '$.meta.clipped.nodes');
      const cs = c.obj(clipped.sessions, '$.meta.clipped.sessions', HARNESSES);
      for (const h of HARNESSES) {
        if (cs === null) break;
        const at = `$.meta.clipped.sessions.${h}`;
        c.int(cs[h], at);
        // T3: what a source holds is what is shown plus what was clipped, per source.
        const one = src !== null && isRecord(src[h]) ? src[h] : null;
        if (one !== null && typeof one.total === 'number' && typeof one.shown === 'number' && cs[h] !== one.total - one.shown) {
          c.bad(at, `${String(cs[h])}, not sources.${h}.total - shown (${one.total - one.shown})`);
        }
      }
    }
    const seenRules = new Set();
    c.arr(meta.rules, '$.meta.rules').forEach((r, i) => {
      const at = `$.meta.rules[${i}]`;
      const o = c.obj(r, at, ['id', 'hits', 'n', 'status']);
      if (o === null) return;
      c.re(o.id, `${at}.id`, TOWER_CODE_RE, 'rule name');
      if (seenRules.has(o.id)) c.bad(`${at}.id`, `${String(o.id)} listed twice`);
      seenRules.add(o.id);
      c.int(o.hits, `${at}.hits`);
      c.int(o.n, `${at}.n`);
      c.en(o.status, `${at}.status`, TOWER_ENUMS.ruleStatus);
    });
  }

  const router = c.obj(s.router, '$.router', ['kind', 'dispatch']);
  if (router !== null) {
    c.en(router.kind, '$.router.kind', TOWER_ENUMS.routerKind);
    // No routing brain is drawn before there is one: the dispatch desk fills this later.
    if (router.dispatch !== null) c.bad('$.router.dispatch', 'null until the dispatch desk exists');
  }

  /** @type {Map<unknown, Record<string, unknown>>} */
  const all = new Map();
  const projectIds = new Set();
  c.arr(s.projects, '$.projects').forEach((p, pi) => {
    const at = `$.projects[${pi}]`;
    const project = c.obj(p, at, ['id', 'name', 'basis', 'nodes', 'groups']);
    if (project === null) return;
    c.re(project.id, `${at}.id`, TOWER_HEX20_RE, 'Hex20');
    if (projectIds.has(project.id)) c.bad(`${at}.id`, `${String(project.id)} used twice`);
    projectIds.add(project.id);
    c.text(project.name, `${at}.name`, TOWER_BOUNDS.textCp);
    c.en(project.basis, `${at}.basis`, TOWER_ENUMS.projectBasis);
    /** @type {{ n: Record<string, unknown>, groups: (Record<string, unknown> | null)[] }[]} */
    const checked = [];
    c.arr(project.nodes, `${at}.nodes`).forEach((n, i) => {
      const got = checkNode(c, n, `${at}.nodes[${i}]`);
      if (got === null) return;
      if (all.has(got.n.id)) c.bad(`${at}.nodes[${i}].id`, `${String(got.n.id)} used twice`);
      all.set(got.n.id, got.n);
      checked.push(got);
    });
    checkTree(c, project, checked, at);
  });

  // The waiting bar: one entry per waiting node, mirroring its wait, deadlines first and soonest first.
  const listed = new Set();
  /** @type {number | null | undefined} */
  let prev;
  c.arr(s.waitingBar, '$.waitingBar').forEach((e, i) => {
    const at = `$.waitingBar[${i}]`;
    const o = c.obj(e, at, ['node', 'kind', 'source', 'deadline']);
    if (o === null) return;
    c.re(o.node, `${at}.node`, NODE_ID_RE, 'node id');
    if (listed.has(o.node)) c.bad(`${at}.node`, `${String(o.node)} listed twice`);
    listed.add(o.node);
    const n = all.get(o.node);
    if (n === undefined) c.bad(`${at}.node`, `${String(o.node)} is no node of this snapshot`);
    else if (!isRecord(n.waiting)) c.bad(`${at}.node`, `${String(o.node)} does not wait`);
    else for (const k of ['kind', 'source', 'deadline']) if (o[k] !== n.waiting[k]) c.bad(`${at}.${k}`, `${JSON.stringify(o[k])}, the node says ${JSON.stringify(n.waiting[k])}`);
    const d = typeof o.deadline === 'number' ? o.deadline : null;
    if (prev !== undefined && ((prev === null && d !== null) || (prev !== null && d !== null && d < prev))) c.bad(`${at}.deadline`, 'out of order: deadlines first, soonest first');
    prev = d;
  });
  for (const [id, n] of all) if (n.waiting !== null && !listed.has(id)) c.bad('$.waitingBar', `${String(id)} waits but is not listed`);

  // T1: a state from a source with no registry never reads as one a registry reported, and nothing is
  // error in a build that reads no failure.
  for (const [id, n] of all) {
    const one = src !== null && typeof n.harness === 'string' && isRecord(src[n.harness]) ? /** @type {Record<string, unknown>} */ (src[n.harness]) : null;
    if (one !== null && one.registry === null) {
      if (n.basis === 'registry') c.bad(`$.projects: ${String(id)}.basis`, `registry, but ${String(n.harness)} has no registry`);
      if (isRecord(n.waiting) && n.waiting.source === 'native') c.bad(`$.projects: ${String(id)}.waiting.source`, `native, but ${String(n.harness)} has no registry`);
    }
    if (!detectsError && n.state === 'error') c.bad(`$.projects: ${String(id)}.state`, 'error, but meta.detects.error is false');
  }

  // T3 for the top bar: each count is the number of nodes in that state.
  const tally = c.obj(s.tally, '$.tally', TOWER_ENUMS.state);
  if (tally !== null) {
    for (const st of TOWER_ENUMS.state) {
      c.int(tally[st], `$.tally.${st}`);
      let k = 0;
      for (const n of all.values()) if (n.state === st) k++;
      if (tally[st] !== k) c.bad(`$.tally.${st}`, `${String(tally[st])}, but ${k} nodes are ${st}`);
    }
  }

  // A source shows at least the sessions that lead a tree, at most every session its nodes name.
  if (src !== null) {
    for (const h of HARNESSES) {
      const one = isRecord(src[h]) ? src[h] : null;
      if (one === null || typeof one.shown !== 'number') continue;
      const roots = new Set();
      const any = new Set();
      for (const n of all.values()) {
        if (n.harness !== h || n.session === null) continue;
        any.add(n.session);
        if (n.parent === null) roots.add(n.session);
      }
      if (one.shown < roots.size) c.bad(`$.meta.sources.${h}.shown`, `${one.shown}, but ${roots.size} of its sessions lead a tree`);
      if (one.shown > any.size) c.bad(`$.meta.sources.${h}.shown`, `${one.shown}, but its nodes name ${any.size} sessions`);
    }
  }
  return { ok: c.errors.length === 0, errors: c.errors };
}
