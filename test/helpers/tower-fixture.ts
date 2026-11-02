// Synthetic stage snapshots for the tower's tests (orchestra app plan §1). Every value is made up: the
// players are built straight in the stage contract's shape, so the tower's reading of states, its
// folding and its counts can be checked without any session file.
import { createHash } from 'node:crypto';
import type { Harness, Lane, Player, StageSnapshot, WorkItem } from '../../src/sources/stage.ts';

const hex = (s: string, n = 20) => createHash('sha256').update(s).digest('hex').slice(0, n);

export const pid = (name: string) => `p:${hex(`player:${name}`)}`;
export const nid = (name: string) => `n:${hex(`player:${name}`)}`;

export type PlayerSpec = {
  name: string;
  harness?: Harness;
  role?: Player['role'];
  parent?: string | null;
  depth?: number;
  label?: string;
  agentType?: string | null;
  state?: Player['live']['state'];
  basis?: Player['live']['basis'];
  waitingFor?: string | null;
  ageMs?: number | null;
  look?: Player['look'];
  inProgress?: string;
};

export function player(s: PlayerSpec): Player {
  const parent = s.parent ?? null;
  return {
    id: pid(s.name), session: hex(`session:${s.name}`), harness: s.harness ?? 'claude',
    role: s.role ?? (parent === null ? 'principal' : 'clone'), parent: parent === null ? null : pid(parent),
    depth: s.depth ?? (parent === null ? 0 : 1), shade: 0, label: s.label ?? s.name, agentType: s.agentType ?? null,
    model: null, startedAt: null,
    live: { state: s.state ?? 'unknown', basis: s.basis ?? 'none', waitingFor: s.waitingFor ?? null, ageMs: s.ageMs === undefined ? 600_000 : s.ageMs },
    look: s.look ?? 'translucent', lookRule: 'look.translucent.unknown',
    instrument: { class: 'unknown', window: 0, read: 0, write: 0, shell: 0, role: null },
    stand: s.inProgress === undefined
      ? { source: 'none', keys: 'none', title: null, items: [], selfReported: { checked: 0, total: 0 } }
      : { source: 'todo', keys: 'ok', title: null, items: [{ text: s.inProgress, status: 'in_progress' }], selfReported: { checked: 0, total: 1 } },
    bytes: 100, note: null,
  };
}

export function lane(name: string, players: Player[], items: WorkItem[] = []): Lane {
  return { id: hex(`lane:${name}`), name, basis: 'cwd', players, items, cues: [] };
}

/** A stage snapshot over `lanes`; every source's total is what its principals name, plus `extra`. */
export function stageOf(lanes: Lane[], extra: Partial<Record<Harness, number>> = {}): StageSnapshot {
  const sources = {} as StageSnapshot['sources'];
  for (const h of ['claude', 'dsh', 'codex'] as const) {
    const shown = new Set(lanes.flatMap((l) => l.players.filter((p) => p.harness === h).map((p) => p.session))).size;
    const sessions = shown + (extra[h] ?? 0);
    sources[h] = { state: sessions > 0 ? 'ok' : 'empty', sessions, shown, registry: h === 'claude' ? 0 : null, error: null };
  }
  return {
    v: 1, kind: 'stage-preview', rev: '0'.repeat(16), observedAt: 1_793_560_030_000, computedMs: 0, profile: 'test',
    sources, rules: [], podium: { fermatas: [], inbox: null }, lanes,
    clipped: { lanes: 0, players: 0, items: 0, standItems: 0, sessions: { claude: extra.claude ?? 0, dsh: extra.dsh ?? 0, codex: extra.codex ?? 0 } },
  };
}

/**
 * The busy project: a lead waiting on you (registry) with 6 Explore subagents nobody placed (old,
 * unknown), 3 returned general ones, one running, a returned one with a waiting Codex-free child of
 * its own, and three idle leads beside it; a Codex lead whose grandchild waits (inferred).
 */
export function busyStage(): StageSnapshot {
  const claude: Player[] = [
    player({ name: 'lead', state: 'waiting', basis: 'registry', waitingFor: 'permission prompt', ageMs: 5_000, look: 'solid' }),
    ...[1, 2, 3, 4, 5, 6].map((i) => player({ name: `ex${i}`, parent: 'lead', agentType: 'Explore', ageMs: 900_000 + i })),
    ...[1, 2, 3].map((i) => player({ name: `gp${i}`, parent: 'lead', agentType: 'general-purpose', state: 'returned', basis: 'unpaired-tool-use', ageMs: 300_000 + i })),
    player({ name: 'runner', parent: 'lead', agentType: 'code-reviewer', state: 'running', basis: 'unpaired-tool-use', ageMs: 2_000, look: 'solid' }),
    player({ name: 'mid', parent: 'lead', agentType: 'general-purpose', state: 'returned', basis: 'unpaired-tool-use', ageMs: 100_000 }),
    player({ name: 'leaf', parent: 'mid', depth: 2, agentType: 'general-purpose', state: 'unknown', basis: 'none', ageMs: 10_000 }),
    ...[1, 2, 3].map((i) => player({ name: `idle${i}`, ageMs: 3_600_000 + i })),
  ];
  const codex: Player[] = [
    player({ name: 'cx', harness: 'codex', state: 'running', basis: 'turn', ageMs: 1_000, inProgress: 'Wire the payments' }),
    player({ name: 'cx1', harness: 'codex', parent: 'cx', state: 'running', basis: 'turn', ageMs: 1_000 }),
    player({ name: 'cx2', harness: 'codex', parent: 'cx1', depth: 2, state: 'waiting', basis: 'unpaired-tool-use', waitingFor: 'request_user_input', ageMs: 1_000 }),
  ];
  return stageOf([lane('shop', claude), lane('blog', codex)], { dsh: 7 });
}
