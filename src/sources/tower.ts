import { createHash } from 'node:crypto';
import type { Harness, Lane, Player, StageSnapshot } from './stage.ts';
import { STAGE_LIMITS } from './stage.ts';
import { STATE_RANK, TOWER_BOUNDS } from '../../shared/tower-contract.js';
import { OWNED_TOWER_TEXT } from '../../shared/owned-contract.js';
import { frozen } from '../../shared/frozen.js';

// The tower snapshot (orchestra app plan §1, tower panel research §1): you -> agents -> subagents,
// grouped by project, with what waits on you pinned on top. Built from the stage snapshot, so it
// reads nothing of its own: the stage builder's reads through the read gate, its digests, memo,
// throttle and limits are the tower's too, and every string here is one the stage already passed
// through shown() (redacted, cleaned, clipped). shared/tower-contract.js checks the result.
//
// What the tower adds is the honest reading of each player's state for one tree:
// - a registry's word stays the registry's (basis registry); a state read off the session's own
//   events (a Task call without its result, a Codex turn) is basis log; one guessed from the file's
//   last write is basis mtime; anything else is unknown (basis none), never idle or 0 (T1);
// - a subagent the stage cannot place (no Task call names it) is running by mtime when its file was
//   written within the last minute, else unknown; a possible orphan (the stage's ghost) is unknown;
// - nothing is ever done: a subagent that sent its report back is returned (T2); a Codex turn that
//   was aborted sent nothing back, so it is unknown, never returned;
// - nothing is read as failed yet (meta.detects.error is false): the page shows no error count;
// - waits: the Claude registry's is native; a Codex wait read off an unanswered call is inferred.
//   None of them has a deadline: only Orchestra's own queue (owned sessions) runs that clock.
//
// Owned sessions (orchestra app plan section 2) come from the driver, not from the stage: one project
// of their own, first, basis 'owned' (one project, not one per cwd: each owned session works in its own
// ORCHESTRA_HOME\work\<ownedId>, so a project per cwd would be a project per session). Their state is
// what the driver knows of its own child (basis 'owned'): a turn running, idle between turns, waiting on
// an approval of Orchestra's queue (source orchestra, with the deadline the queue denies it at), or ended;
// an ended session is idle with its end reason as its activity, never done (T2), never error (this
// build shows no error state: meta.detects.error is false for the observed sources).
// Then the tree is ordered (waits on you, failed, runs, unknown, returned, idle), counted per
// subtree so a wait bubbles up through its ancestors, and folded by the research's rules.

export type TowerState = 'waiting' | 'error' | 'running' | 'unknown' | 'returned' | 'idle';
export type TowerBasis = 'registry' | 'log' | 'mtime' | 'none' | 'owned';
export type Waiting = { kind: 'approval' | 'question' | 'route'; source: 'orchestra' | 'native' | 'inferred'; deadline: number | null };
export type Group = { kind: 'same-type' | 'returned' | 'idle'; label: string | null; count: number; ids: string[] };
export type TowerNode = {
  id: string; session: string | null; harness: Harness;
  ownership: 'observed' | 'owned' | 'foreign'; layer: 'agent' | 'subagent';
  parent: string | null; depth: number;
  title: string; activity: string | null;
  state: TowerState; basis: TowerBasis;
  waiting: Waiting | null;
  counts: { children: number; errors: number; waiting: number };
  groups: Group[];
  ageMs: number | null; agentType: string | null;
};
export type TowerSrc = { state: 'ok' | 'empty' | 'error'; total: number; shown: number; registry: number | null; error: string | null };
export type Project = { id: string; name: string; basis: 'cwd' | 'slug' | 'owned'; nodes: TowerNode[]; groups: Group[] };

/**
 * An owned session as the driver knows it (src/owned/codex-owned.ts towerSeats): its title and the
 * approval it waits on are shown text already (redacted, invisible characters written out).
 */
export type OwnedSeat = {
  /** 20 lowercase hex digits (slice design 2.4); the node is n:<ownedId>. */
  ownedId: string;
  harness: Harness;
  title: string;
  state: 'starting' | 'idle' | 'running' | 'ended' | 'failed';
  endReason: string | null;
  /** The earliest open approval of the session, with the wall time the queue declines it at. */
  waiting: { kind: 'approval' | 'question'; deadline: number; title: string } | null;
  /** Wall ms of the session's last feed event; null before any. */
  lastAt: number | null;
};

/** The owned sessions' project: a fixed id, so the page keeps its fold state across snapshots. */
export const OWNED_PROJECT_ID = createHash('sha256').update('orchestra:owned-project').digest('hex').slice(0, 20);
const OWNED_ID_RE = /^[0-9a-f]{20}$/;
export type WaitingEntry = { node: string; kind: Waiting['kind']; source: Waiting['source']; deadline: number | null };
export type TowerSnapshot = {
  meta: {
    v: 1; rev: string; observedAt: number; profile: 'test' | 'real';
    /** What this build can tell at all: with no rule that reads a failure, error counts say nothing (T1). */
    detects: { error: boolean };
    sources: Record<Harness, TowerSrc>;
    clipped: { projects: number; nodes: number; sessions: Record<Harness, number> };
    rules: { id: string; hits: number; n: number; status: 'untested' | 'keys-mismatch' }[];
  };
  router: { kind: 'human'; dispatch: null };
  projects: Project[];
  waitingBar: WaitingEntry[];
  tally: Record<TowerState, number>;
};

export const TOWER_LIMITS = frozen({
  /** A subagent nobody can place reads as running only when its file was written this recently. */
  mtimeRunningMs: STAGE_LIMITS.solidAgeMs,
});

const nodeId = (playerId: string) => `n:${playerId.slice(2)}`;

/** Clips shown text to `max` code points, the clip mark after them; text already within the bound stays. */
export function clipCp(s: string, max: number): string {
  const cps = [...s];
  if (cps.length <= max || (cps.length === max + 1 && s.endsWith('…'))) return s;
  return `${cps.slice(0, max).join('')}…`;
}

/** A registry's waitingFor as a kind: a permission prompt is an approval; anything else a question. */
function registryKind(waitingFor: string | null): Waiting['kind'] {
  return waitingFor !== null && /permission|approv/i.test(waitingFor) ? 'approval' : 'question';
}

/** One player's state, basis and wait as the tower reads them (the rules above). */
export function readState(p: Player): { state: TowerState; basis: TowerBasis; waiting: Waiting | null } {
  const { state, basis, waitingFor, ageMs } = p.live;
  const recent = ageMs !== null && ageMs < TOWER_LIMITS.mtimeRunningMs;
  const unknown = { state: 'unknown' as const, basis: 'none' as const, waiting: null };
  if (basis === 'registry') {
    if (state === 'busy') return { state: 'running', basis, waiting: null };
    if (state === 'idle') return { state: 'idle', basis, waiting: null };
    if (state === 'waiting') return { state: 'waiting', basis, waiting: { kind: registryKind(waitingFor), source: 'native', deadline: null } };
    return unknown;
  }
  if (basis === 'unpaired-tool-use' || basis === 'turn') {
    if (state === 'waiting') return { state: 'waiting', basis: 'log', waiting: { kind: waitingFor === 'request_user_input' ? 'question' : 'approval', source: 'inferred', deadline: null } };
    // A Task without its result, old, under a parent that is not busy: the stage's possible orphan.
    if (p.look === 'ghost') return unknown;
    if (state === 'running') return { state: 'running', basis: 'log', waiting: null };
    if (state === 'returned') return { state: p.role === 'principal' ? 'idle' : 'returned', basis: 'log', waiting: null };
    if (state === 'idle') return { state: 'idle', basis: 'log', waiting: null };
    // An open turn with no write for a long while: stuck, or waiting on something the log does not say.
    return unknown;
  }
  if (basis === 'mtime') {
    if (state === 'running') return { state: 'running', basis, waiting: null };
    if (state === 'quiet') return { state: 'idle', basis, waiting: null };
    return unknown;
  }
  // Nothing reported it. A principal the registry does not list holds no live process that says so:
  // idle by its last write, or running when that write is recent. A subagent nobody placed is
  // running only on a recent write; otherwise unknown.
  if (p.look === 'ghost') return unknown;
  if (recent) return { state: 'running', basis: 'mtime', waiting: null };
  if (p.role === 'principal' && ageMs !== null) return { state: 'idle', basis: 'mtime', waiting: null };
  return unknown;
}

/**
 * One line of what the player is doing: what the registry says it waits for, else the step it marked
 * in progress, else what it was asked (its Task or spawn brief), else its stand's title; null when
 * none says more than its title. An inferred wait's tool is never named (research §1.5).
 */
export function activityOf(p: Player, lane: Lane): string | null {
  if (p.live.state === 'waiting' && p.live.basis === 'registry' && p.live.waitingFor !== null) return p.live.waitingFor;
  const doing = p.stand.items.find((i) => i.status === 'in_progress');
  if (doing !== undefined) return doing.text;
  const asked = lane.items.find((w) => w.executor === p.id && w.source !== 'todo');
  if (asked !== undefined && asked.brief !== '' && asked.brief !== p.label) return asked.brief;
  if (p.stand.title !== null && p.stand.title !== '' && p.stand.title !== p.label) return p.stand.title;
  return null;
}

const byRank = (a: TowerNode, b: TowerNode) =>
  STATE_RANK[a.state] - STATE_RANK[b.state]
  || (a.ageMs ?? Number.MAX_SAFE_INTEGER) - (b.ageMs ?? Number.MAX_SAFE_INTEGER)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const neverFolds = (n: TowerNode) => n.state === 'running' || n.state === 'waiting' || n.state === 'error' || n.counts.children > 0;

/**
 * The folded rows over one sibling list, in its order: a big batch of one agent type first, then the
 * returned leaves left, then the idle ones; a node that runs, waits, failed or has children never folds.
 */
export function foldSiblings(siblings: readonly TowerNode[]): Group[] {
  const foldable = siblings.filter((n) => !neverFolds(n));
  const groups: Group[] = [];
  const taken = new Set<string>();
  const types = new Map<string, TowerNode[]>();
  for (const n of foldable) if (n.agentType !== null) types.set(n.agentType, [...(types.get(n.agentType) ?? []), n]);
  for (const [label, members] of types) {
    if (members.length < TOWER_BOUNDS.sameTypeMin) continue;
    for (const m of members) taken.add(m.id);
    groups.push({ kind: 'same-type', label, count: members.length, ids: members.map((m) => m.id) });
  }
  const rest = foldable.filter((n) => !taken.has(n.id));
  const returned = rest.filter((n) => n.state === 'returned');
  if (returned.length >= TOWER_BOUNDS.returnedMin) groups.push({ kind: 'returned', label: null, count: returned.length, ids: returned.map((n) => n.id) });
  const idle = rest.filter((n) => n.state === 'idle');
  if (idle.length >= TOWER_BOUNDS.idleMin) groups.push({ kind: 'idle', label: null, count: idle.length, ids: idle.map((n) => n.id) });
  return groups;
}

/** One lane's players as a project: nodes in tree order, siblings by rank, counts per subtree, folded. */
export function projectOf(lane: Lane): Project {
  const nodes = new Map<string, TowerNode>();
  const kids = new Map<string | null, TowerNode[]>();
  for (const p of lane.players) {
    const { state, basis, waiting } = readState(p);
    const n: TowerNode = {
      id: nodeId(p.id), session: p.session, harness: p.harness,
      // M0 drives nothing: every session is only observed.
      ownership: 'observed', layer: p.role === 'principal' && p.parent === null ? 'agent' : 'subagent',
      parent: p.parent === null ? null : nodeId(p.parent), depth: p.depth,
      title: clipCp(p.label, TOWER_BOUNDS.titleCp),
      activity: ((a) => (a === null ? null : clipCp(a, TOWER_BOUNDS.activityCp)))(activityOf(p, lane)),
      state, basis, waiting,
      counts: { children: 0, errors: 0, waiting: 0 }, groups: [],
      ageMs: p.live.ageMs, agentType: p.agentType,
    };
    nodes.set(n.id, n);
  }
  for (const n of nodes.values()) {
    const at = n.parent !== null && nodes.has(n.parent) ? n.parent : null;
    if (at === null && n.parent !== null) {
      // A parent the lane does not hold: the node leads its own tree there.
      n.parent = null;
      n.depth = 0;
    }
    kids.set(at, [...(kids.get(at) ?? []), n]);
  }
  for (const list of kids.values()) list.sort(byRank);
  // Subtree counts, children first, so a wait or an error bubbles up through every ancestor.
  const count = (n: TowerNode): TowerNode['counts'] => {
    for (const k of kids.get(n.id) ?? []) {
      const sub = count(k);
      n.counts.children += 1 + sub.children;
      n.counts.errors += (k.state === 'error' ? 1 : 0) + sub.errors;
      n.counts.waiting += (k.state === 'waiting' ? 1 : 0) + sub.waiting;
    }
    return n.counts;
  };
  const roots = kids.get(null) ?? [];
  for (const r of roots) count(r);
  for (const n of nodes.values()) n.groups = foldSiblings(kids.get(n.id) ?? []);
  const ordered: TowerNode[] = [];
  const walk = (n: TowerNode) => {
    ordered.push(n);
    for (const k of kids.get(n.id) ?? []) walk(k);
  };
  for (const r of roots) walk(r);
  return { id: lane.id, name: lane.name, basis: lane.basis, nodes: ordered, groups: foldSiblings(roots) };
}

const text = (key: string, fallback: string): string => (Object.hasOwn(OWNED_TOWER_TEXT, key) ? (OWNED_TOWER_TEXT as Record<string, string>)[key]! : fallback);

/** One owned session as a node: the driver's word, basis owned. */
export function ownedNode(seat: OwnedSeat, nowWall: number): TowerNode {
  const waiting: Waiting | null = seat.waiting === null ? null : { kind: seat.waiting.kind, source: 'orchestra', deadline: seat.waiting.deadline };
  const state: TowerState = waiting !== null ? 'waiting' : seat.state === 'starting' || seat.state === 'running' ? 'running' : 'idle';
  let activity: string | null = null;
  if (seat.waiting !== null && seat.waiting.title !== '') activity = seat.waiting.title;
  else if (seat.state === 'starting') activity = text('starting', 'starting');
  else if (seat.state === 'ended' || seat.state === 'failed') activity = text(`end.${seat.endReason ?? 'unknown'}`, text('end.unknown', 'ended'));
  const title = seat.title === '' ? text('untitled', 'owned session') : seat.title;
  return {
    id: `n:${seat.ownedId}`, session: null, harness: seat.harness, ownership: 'owned', layer: 'agent', parent: null, depth: 0,
    title: clipCp(title, TOWER_BOUNDS.titleCp), activity: activity === null ? null : clipCp(activity, TOWER_BOUNDS.activityCp),
    state, basis: 'owned', waiting,
    counts: { children: 0, errors: 0, waiting: 0 }, groups: [],
    ageMs: seat.lastAt === null ? null : Math.max(0, nowWall - seat.lastAt), agentType: null,
  };
}

/** The owned sessions' project, or null when there is none. Seats with an id outside the grammar are left out. */
export function ownedProject(seats: readonly OwnedSeat[], nowWall: number): Project | null {
  const nodes = seats.filter((s) => OWNED_ID_RE.test(s.ownedId)).map((s) => ownedNode(s, nowWall)).sort(byRank);
  if (nodes.length === 0) return null;
  return { id: OWNED_PROJECT_ID, name: text('project', 'Orchestra'), basis: 'owned', nodes, groups: foldSiblings(nodes) };
}

/** 16 hex over the snapshot without its time fields: unchanged data, unchanged rev. */
function revOf(body: unknown): string {
  const timeless = JSON.stringify(body, (k, v) => (k === 'rev' || k === 'observedAt' || k === 'ageMs' ? undefined : v));
  return createHash('sha256').update(timeless).digest('hex').slice(0, 16);
}

/**
 * The tower of one stage snapshot, the owned sessions' project first when there are any. Pure: reads
 * `stage` and `owned`, shares no object with them.
 */
export function towerFromStage(stage: StageSnapshot, owned: { seats: readonly OwnedSeat[]; nowWall: number } | null = null): TowerSnapshot {
  const mine = owned === null ? null : ownedProject(owned.seats, owned.nowWall);
  const projects = [...(mine === null ? [] : [mine]), ...stage.lanes.map(projectOf)];
  const all = projects.flatMap((p) => p.nodes);
  // Deadlines first, soonest first; then the rest in tree order (native before inferred).
  const sourceRank = { orchestra: 0, native: 1, inferred: 2 } as const;
  const waitingBar: WaitingEntry[] = all
    .map((n, i) => ({ n, i }))
    .filter((x) => x.n.waiting !== null)
    .sort((a, b) => {
      const da = a.n.waiting!.deadline;
      const db = b.n.waiting!.deadline;
      if (da !== null || db !== null) return da === null ? 1 : db === null ? -1 : da - db || a.i - b.i;
      return sourceRank[a.n.waiting!.source] - sourceRank[b.n.waiting!.source] || a.i - b.i;
    })
    .map(({ n }) => ({ node: n.id, kind: n.waiting!.kind, source: n.waiting!.source, deadline: n.waiting!.deadline }));
  const tally: Record<TowerState, number> = { waiting: 0, error: 0, running: 0, unknown: 0, returned: 0, idle: 0 };
  for (const n of all) tally[n.state]++;
  const src = (h: Harness): TowerSrc => {
    const s = stage.sources[h];
    return { state: s.state, total: s.sessions, shown: s.shown, registry: s.registry, error: s.error };
  };
  const body = {
    meta: {
      v: 1 as const, rev: '', observedAt: stage.observedAt, profile: stage.profile,
      // No rule reads a failure yet (a Codex turn_aborted is unknown: interrupted or failed, the rollout
      // does not say), so no node is ever error and an error count of 0 would only mean "not looked".
      detects: { error: false },
      sources: { claude: src('claude'), dsh: src('dsh'), codex: src('codex') },
      clipped: { projects: stage.clipped.lanes, nodes: stage.clipped.players, sessions: { ...stage.clipped.sessions } },
      // The stage's rules as they are, for the page's about view (T4: untested however often they fired).
      rules: stage.rules.map((r) => ({ id: r.id, hits: r.hits, n: r.n, status: r.status })),
    },
    router: { kind: 'human' as const, dispatch: null },
    projects, waitingBar, tally,
  };
  body.meta.rev = revOf(body);
  return body;
}

/** Where the tower reads the owned sessions from: the driver's seats, and the wall clock their ages are taken against. */
export type OwnedSeats = { seats(): readonly OwnedSeat[]; nowWall(): number };

/**
 * The tower builder the peek server holds, over its stage builder: the stage's throttle and memo
 * decide when anything is read again, and the same stage snapshot gives the same tower object. With
 * owned sessions the tower is built again whenever any of them is there (they change between two stage
 * reads: a turn ends, an approval comes); with none it is the stage's memo alone.
 */
export function makeTowerBuilder(stage: { snapshot(): StageSnapshot }, owned: OwnedSeats | null = null): { snapshot(): TowerSnapshot } {
  let last: { from: StageSnapshot; tower: TowerSnapshot } | null = null;
  return {
    snapshot(): TowerSnapshot {
      const s = stage.snapshot();
      const seats = owned === null ? [] : owned.seats();
      if (seats.length > 0) return towerFromStage(s, { seats, nowWall: owned!.nowWall() });
      if (last === null || last.from !== s) last = { from: s, tower: towerFromStage(s) };
      return last.tower;
    },
  };
}
