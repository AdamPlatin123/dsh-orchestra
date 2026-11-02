import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { makeStageBuilder } from '../../src/sources/stage.ts';
import type { StageSnapshot } from '../../src/sources/stage.ts';
import { OWNED_PROJECT_ID, clipCp, foldSiblings, makeTowerBuilder, readState, towerFromStage } from '../../src/sources/tower.ts';
import type { OwnedSeat, TowerNode, TowerSnapshot } from '../../src/sources/tower.ts';
import { validateTower } from '../../shared/tower-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { STAGE_CANARY, normalizeSnapshot, writeStageFixture } from '../helpers/stage-fixture.ts';
import { busyStage, lane, nid, player, stageOf } from '../helpers/tower-fixture.ts';
import { withTmp } from '../helpers/tmp.ts';

// The tower snapshot (orchestra app plan §1): built from the stage snapshot, checked by
// shared/tower-contract.js. The golden file is the stage fixture's tower, normalized like the stage's.

const GOLDEN = fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url));
const BASE = 1_793_560_000_000;

function fixtureTower(t: Parameters<typeof withTmp>[0]): { tower: TowerSnapshot; dir: string } {
  const dir = fs.realpathSync.native(withTmp(t));
  writeStageFixture(dir, BASE);
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    return { kind, path: p, real: p };
  });
  const redactor = makeRedactor({ env: {} });
  const stage = makeStageBuilder({
    gate: new ReadGate({ roots, io: realIo, testDirs: [dir] }), roots, redact: (text) => redactor.redact({ text }).text,
    clock: new VirtualClock({ mono: 1000, wall: BASE + 30_000 }).port(null), profile: 'test',
  });
  return { tower: makeTowerBuilder(stage).snapshot(), dir };
}

const nodes = (t: TowerSnapshot) => t.projects.flatMap((p) => p.nodes);
const node = (t: TowerSnapshot, name: string): TowerNode => nodes(t).find((n) => n.id === nid(name))!;

test('the golden file passes the contract, and the stage fixture at baseMs + 30 s gives it', (t) => {
  const golden: unknown = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(validateTower(golden).errors, []);
  const { tower, dir } = fixtureTower(t);
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual(normalizeSnapshot(tower), golden);
  const text = JSON.stringify(tower);
  assert.equal(text.includes(STAGE_CANARY), false);
  assert.equal(text.includes(JSON.stringify(dir).slice(1, -1)), false);
  assert.equal(text.includes('完成'), false);
});

test('all three harnesses are in the fixture tower, as agents with their subagents beneath', (t) => {
  const { tower } = fixtureTower(t);
  const all = nodes(tower);
  for (const h of ['claude', 'dsh', 'codex'] as const) {
    assert.ok(all.some((n) => n.harness === h && n.layer === 'agent'), `${h} agent`);
    assert.ok(all.some((n) => n.harness === h && n.layer === 'subagent' && n.parent !== null), `${h} subagent`);
    assert.equal(tower.meta.sources[h].state, 'ok');
  }
  assert.deepEqual(tower.router, { kind: 'human', dispatch: null });
  assert.ok(all.every((n) => n.ownership === 'observed'), 'M0 observes only');
  // The Claude lead waits on a permission prompt (registry: native); the Codex lead's escalated
  // command is a guess off its rollout (inferred), and its tool is not named in the activity line.
  const waits = tower.waitingBar.map((w) => [all.find((n) => n.id === w.node)!.harness, w.kind, w.source]);
  assert.deepEqual(waits, [['claude', 'approval', 'native'], ['codex', 'approval', 'inferred']]);
  const cx = all.find((n) => n.harness === 'codex' && n.layer === 'agent')!;
  assert.equal(cx.basis, 'log');
  assert.doesNotMatch(cx.activity ?? '', /shell|git push/);
});

test('basis tells a reported state from a read and a guessed one, and unknown stays unknown', () => {
  const at = (spec: Parameters<typeof player>[0]) => readState(player(spec));
  assert.deepEqual(at({ name: 'a', state: 'busy', basis: 'registry' }), { state: 'running', basis: 'registry', waiting: null });
  assert.deepEqual(at({ name: 'a', state: 'idle', basis: 'registry' }), { state: 'idle', basis: 'registry', waiting: null });
  assert.deepEqual(at({ name: 'a', state: 'waiting', basis: 'registry', waitingFor: 'permission prompt' }).waiting, { kind: 'approval', source: 'native', deadline: null });
  assert.deepEqual(at({ name: 'a', state: 'waiting', basis: 'registry', waitingFor: 'input' }).waiting, { kind: 'question', source: 'native', deadline: null });
  // A registry entry with a status it does not know is unknown, not idle.
  assert.deepEqual(at({ name: 'a', state: 'unknown', basis: 'registry' }), { state: 'unknown', basis: 'none', waiting: null });
  // Read off the log: a Task call without its result, a Codex turn.
  assert.deepEqual(at({ name: 's', parent: 'a', state: 'running', basis: 'unpaired-tool-use' }), { state: 'running', basis: 'log', waiting: null });
  assert.deepEqual(at({ name: 's', parent: 'a', state: 'returned', basis: 'turn' }), { state: 'returned', basis: 'log', waiting: null });
  assert.deepEqual(at({ name: 'a', state: 'waiting', basis: 'unpaired-tool-use', waitingFor: 'request_user_input' }).waiting, { kind: 'question', source: 'inferred', deadline: null });
  assert.deepEqual(at({ name: 'a', state: 'quiet', basis: 'turn' }), { state: 'unknown', basis: 'none', waiting: null }, 'an open turn gone quiet');
  // The stage's possible orphan is no running subagent.
  assert.deepEqual(at({ name: 's', parent: 'a', state: 'running', basis: 'unpaired-tool-use', look: 'ghost' }).state, 'unknown');
  // Guessed from the last write: DSH, and a subagent nobody placed.
  assert.deepEqual(at({ name: 'd', harness: 'dsh', state: 'quiet', basis: 'mtime' }), { state: 'idle', basis: 'mtime', waiting: null });
  assert.deepEqual(at({ name: 's', parent: 'a', ageMs: 10_000 }), { state: 'running', basis: 'mtime', waiting: null });
  assert.deepEqual(at({ name: 's', parent: 'a', ageMs: 600_000 }), { state: 'unknown', basis: 'none', waiting: null });
  assert.deepEqual(at({ name: 's', parent: 'a', ageMs: null }), { state: 'unknown', basis: 'none', waiting: null });
  assert.deepEqual(at({ name: 'a', ageMs: 600_000 }), { state: 'idle', basis: 'mtime', waiting: null }, 'a lead no registry lists');
});

test('folding: busy branches never fold; returned leaves, idle ones from 3, and a big batch of one type do', () => {
  const tower = towerFromStage(busyStage());
  assert.deepEqual(validateTower(tower).errors, []);
  const lead = node(tower, 'lead');
  const ex = [1, 2, 3, 4, 5, 6].map((i) => nid(`ex${i}`));
  const gp = [1, 2, 3].map((i) => nid(`gp${i}`));
  assert.deepEqual(lead.groups.map((g) => [g.kind, g.label, g.count]), [['same-type', 'Explore', 6], ['returned', null, 3]]);
  assert.deepEqual(new Set(lead.groups[0]!.ids), new Set(ex));
  assert.deepEqual(new Set(lead.groups[1]!.ids), new Set(gp));
  const folded = new Set(lead.groups.flatMap((g) => g.ids));
  for (const name of ['runner', 'mid']) assert.equal(folded.has(nid(name)), false, `${name} stays a row`);
  // Three idle leads fold at the project's level; the waiting one does not.
  const shop = tower.projects.find((p) => p.name === 'shop')!;
  assert.deepEqual(shop.groups.map((g) => [g.kind, g.count]), [['idle', 3]]);
  // Two idle leaves stay two rows; one returned leaf stays a row.
  const two = towerFromStage(stageOf([lane('x', [player({ name: 'i1', ageMs: 600_000 }), player({ name: 'i2', ageMs: 600_001 })])]));
  assert.deepEqual(two.projects[0]!.groups, []);
  const leaves = (states: string[]) => states.map((s, i) => ({ ...towerFromStage(stageOf([lane('y', [player({ name: `r${i}` })])])).projects[0]!.nodes[0]!, id: `n:${String(i).padStart(20, '0')}`, state: s as TowerNode['state'], agentType: 'Explore' }));
  assert.deepEqual(foldSiblings(leaves(['returned', 'idle', 'idle'])), []);
  assert.deepEqual(foldSiblings(leaves(['running', 'running', 'running', 'running', 'running'])), [], 'running never folds, whatever its type');
  assert.deepEqual(foldSiblings(leaves(['unknown', 'unknown', 'returned', 'idle', 'unknown'])).map((g) => [g.kind, g.count]), [['same-type', 5]]);
});

test('counts are per subtree, a wait bubbles up through every ancestor, and every count is its list\'s length', () => {
  const tower = towerFromStage(busyStage());
  const cx = node(tower, 'cx');
  assert.deepEqual(cx.counts, { children: 2, errors: 0, waiting: 1 });
  assert.deepEqual(node(tower, 'cx1').counts, { children: 1, errors: 0, waiting: 1 });
  assert.deepEqual(node(tower, 'cx2').counts, { children: 0, errors: 0, waiting: 0 });
  assert.deepEqual(node(tower, 'lead').counts, { children: 12, errors: 0, waiting: 0 });
  assert.deepEqual(node(tower, 'mid').counts, { children: 1, errors: 0, waiting: 0 });
  // T3: tally against the nodes, the waiting bar against the waiting nodes.
  const all = nodes(tower);
  for (const [st, k] of Object.entries(tower.tally)) assert.equal(k, all.filter((n) => n.state === st).length, st);
  assert.equal(tower.waitingBar.length, tower.tally.waiting);
  assert.deepEqual(tower.waitingBar.map((w) => w.node), [nid('lead'), nid('cx2')], 'native before inferred, neither with a deadline');
  // A source the limits pushed out is clipped, not empty (T1).
  assert.deepEqual(tower.meta.sources.dsh, { state: 'ok', total: 7, shown: 0, registry: null, error: null });
  assert.equal(tower.meta.clipped.sessions.dsh, 7);
});

test('tree order: a parent before its subtree, siblings waiting, failed, running, unknown, returned, idle', () => {
  const tower = towerFromStage(busyStage());
  const shop = tower.projects.find((p) => p.name === 'shop')!.nodes;
  assert.equal(shop[0]!.id, nid('lead'));
  const kids = shop.filter((n) => n.parent === nid('lead')).map((n) => n.state);
  assert.deepEqual(kids, ['running', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'returned', 'returned', 'returned', 'returned']);
  const mid = shop.findIndex((n) => n.id === nid('mid'));
  assert.equal(shop[mid + 1]!.id, nid('leaf'), 'the subtree follows its parent');
  assert.deepEqual([node(tower, 'leaf').state, node(tower, 'leaf').basis], ['running', 'mtime']);
});

test('titles are short and clipped with a mark; activity names the step in progress', () => {
  const long = 'x'.repeat(90);
  const tower = towerFromStage(stageOf([lane('z', [player({ name: 'a', label: long, state: 'busy', basis: 'registry', inProgress: 'Wire the payments' })])]));
  assert.deepEqual(validateTower(tower).errors, []);
  const n = tower.projects[0]!.nodes[0]!;
  assert.equal(n.title, `${'x'.repeat(60)}…`);
  assert.equal(n.activity, 'Wire the payments');
  assert.equal(clipCp('ab', 60), 'ab');
  assert.equal(clipCp(`${'y'.repeat(60)}…`, 60), `${'y'.repeat(60)}…`);
  assert.equal(clipCp('😀'.repeat(61), 60), `${'😀'.repeat(60)}…`);
});

test('the builder hands back the same tower while the stage hands back the same snapshot', () => {
  let s: StageSnapshot = busyStage();
  const b = makeTowerBuilder({ snapshot: () => s });
  const one = b.snapshot();
  assert.equal(b.snapshot(), one);
  s = busyStage();
  const two = b.snapshot();
  assert.notEqual(two, one);
  assert.equal(two.meta.rev, one.meta.rev, 'unchanged data, unchanged rev');
  s = { ...busyStage(), observedAt: s.observedAt + 5000 };
  assert.equal(b.snapshot().meta.rev, one.meta.rev, 'time alone does not change the rev');
});

// --- owned sessions (orchestra app plan section 2) -------------------------------------------------------

const seat = (n: number, over: Partial<OwnedSeat> = {}): OwnedSeat => ({
  ownedId: String(n).repeat(20).slice(0, 20), harness: 'codex', title: `synthetic ${n}`, state: 'idle', endReason: null, waiting: null, lastAt: 1_000, ...over,
});

test('owned sessions: one project of their own, first; the driver state with basis owned; a wait on the Orchestra queue carries its deadline and leads the waiting bar', () => {
  const now = 61_000;
  const seats = [
    seat(1, { state: 'running' }),
    seat(2, { state: 'running', waiting: { kind: 'approval', deadline: 2_000_000, title: 'rm synthetic' } }),
    seat(3, { state: 'ended', endReason: 'you-ended' }),
    seat(4, { state: 'starting', lastAt: null }),
  ];
  const tower = towerFromStage(busyStage(), { seats, nowWall: now });
  const v = validateTower(tower);
  assert.ok(v.ok, v.errors.join('\n'));
  const p = tower.projects[0]!;
  assert.deepEqual([p.id, p.basis, p.name], [OWNED_PROJECT_ID, 'owned', 'Orchestra 自有']);
  assert.deepEqual(p.nodes.map((n) => [n.id.slice(2, 3), n.state, n.basis, n.ownership, n.session]), [
    ['2', 'waiting', 'owned', 'owned', null], ['1', 'running', 'owned', 'owned', null], ['4', 'running', 'owned', 'owned', null], ['3', 'idle', 'owned', 'owned', null],
  ]);
  assert.deepEqual(p.nodes[0]!.waiting, { kind: 'approval', source: 'orchestra', deadline: 2_000_000 });
  assert.equal(p.nodes[0]!.activity, 'rm synthetic');
  assert.equal(p.nodes[3]!.activity, '已结束：你结束的', 'ended, never done');
  assert.equal(p.nodes[2]!.activity, '正在启动');
  assert.deepEqual([p.nodes[1]!.ageMs, p.nodes[2]!.ageMs], [60_000, null]);
  assert.deepEqual(tower.waitingBar[0], { node: p.nodes[0]!.id, kind: 'approval', source: 'orchestra', deadline: 2_000_000 });
  assert.equal(tower.projects.length, busyStage().lanes.length + 1);
  // No seat, no project; a seat with an id outside the grammar is left out.
  assert.equal(towerFromStage(busyStage(), { seats: [seat(5, { ownedId: 'x' })], nowWall: now }).projects.length, busyStage().lanes.length);
  // The builder rebuilds while there are seats (they change between two stage reads).
  let live: OwnedSeat[] = [seat(6)];
  const s = busyStage();
  const b = makeTowerBuilder({ snapshot: () => s }, { seats: () => live, nowWall: () => now });
  assert.equal(b.snapshot().projects[0]!.nodes[0]!.state, 'idle');
  live = [seat(6, { state: 'running' })];
  assert.equal(b.snapshot().projects[0]!.nodes[0]!.state, 'running');
});

test('owned sessions: the validator holds basis owned to owned nodes, owned nodes to owned or none, and the owned project to owned nodes and to one', () => {
  const now = 61_000;
  const base = towerFromStage(busyStage(), { seats: [seat(1, { waiting: { kind: 'question', deadline: 5_000, title: 'which?' } })], nowWall: now });
  assert.ok(validateTower(base).ok);
  const copy = () => JSON.parse(JSON.stringify(base)) as TowerSnapshot;
  const observed = copy();
  observed.projects[1]!.nodes[0]!.basis = 'owned';
  assert.ok(validateTower(observed).errors.some((e) => e.includes('owned on a node not owned')), validateTower(observed).errors.join('\n'));
  const logged = copy();
  logged.projects[0]!.nodes[0]!.basis = 'log';
  assert.ok(validateTower(logged).errors.some((e) => e.includes('log on an owned node')));
  const mixed = copy();
  mixed.projects[0]!.nodes.push({ ...mixed.projects[1]!.nodes.at(-1)!, id: 'n:ffffffffffffffffffff', parent: null, depth: 0, layer: 'agent' });
  assert.ok(validateTower(mixed).errors.some((e) => e.includes('not owned, in the owned project')));
  const two = copy();
  two.projects.push({ ...two.projects[0]!, id: 'f'.repeat(20), nodes: [], groups: [] });
  assert.ok(validateTower(two).errors.some((e) => e.includes('a second owned project')));
  const noDeadline = copy();
  noDeadline.projects[0]!.nodes[0]!.waiting!.deadline = null;
  assert.equal(validateTower(noDeadline).ok, false, 'the Orchestra queue always carries its deadline');
});
