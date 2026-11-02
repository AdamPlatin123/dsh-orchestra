import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE_ID_RE, STATE_RANK, TOWER_BOUNDS, TOWER_ENUMS, validateTower } from '../../shared/tower-contract.js';
import { towerFromStage } from '../../src/sources/tower.ts';
import { busyStage, nid } from '../helpers/tower-fixture.ts';

// shared/tower-contract.js is the tower's contract (orchestra app plan §1). Two good samples pass it:
// the golden file (the stage fixture's tower) and the busy synthetic tower with every kind of group.
// Each targeted mutation below breaks exactly the check it names.

const GOLDEN = fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url));
type Json = Record<string, any>;
const golden = (): Json => JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Json;
const busy = (): Json => JSON.parse(JSON.stringify(towerFromStage(busyStage()))) as Json;

/** Mutates a fresh sample and returns the validator's errors, which must name `want`. */
function broken(make: () => Json, mutate: (s: Json) => void, want: string): void {
  const s = make();
  mutate(s);
  const r = validateTower(s);
  assert.equal(r.ok, false, `still valid after the mutation for ${want}`);
  assert.ok(r.errors.some((e) => e.includes(want)), `no error names ${want}: ${r.errors.join(' | ')}`);
}

const nodes = (s: Json): Json[] => s.projects.flatMap((p: Json) => p.nodes);
const byName = (s: Json, name: string): Json => nodes(s).find((n) => n.id === nid(name))!;
const shop = (s: Json): Json => s.projects.find((p: Json) => p.name === 'shop');

test('the golden file and the busy synthetic tower pass; the tables are frozen', () => {
  assert.deepEqual(validateTower(golden()), { ok: true, errors: [] });
  assert.deepEqual(validateTower(busy()), { ok: true, errors: [] });
  assert.ok(Object.isFrozen(TOWER_ENUMS) && Object.isFrozen(TOWER_ENUMS.state) && Object.isFrozen(TOWER_BOUNDS) && Object.isFrozen(STATE_RANK));
  assert.deepEqual([...TOWER_ENUMS.state], ['waiting', 'error', 'running', 'unknown', 'returned', 'idle'], 'returned is the furthest a node gets');
  assert.ok(NODE_ID_RE.test('n:0123456789abcdef0123') && !NODE_ID_RE.test('p:0123456789abcdef0123'));
  assert.equal(validateTower(null).ok, false);
});

test('shapes and grammars: ids, enums, missing and unknown keys, text bounds', () => {
  broken(golden, (s) => { s.projects[0].nodes[1].id = 'n:ZZ'; }, 'nodes[1].id');
  broken(golden, (s) => { s.projects[0].nodes[2].id = s.projects[0].nodes[1].id; }, 'used twice');
  broken(golden, (s) => { s.meta.rev = 'abc'; }, '$.meta.rev');
  broken(golden, (s) => { s.projects[0].nodes[0].state = 'done'; }, 'nodes[0].state');
  broken(golden, (s) => { s.projects[0].nodes[0].state = 'completed'; }, 'nodes[0].state');
  broken(golden, (s) => { s.projects[0].nodes[0].ownership = 'mine'; }, 'nodes[0].ownership');
  broken(golden, (s) => { s.projects[0].nodes[0].basis = 'guess'; }, 'nodes[0].basis');
  broken(golden, (s) => { delete s.projects[0].nodes[0].agentType; }, 'missing agentType');
  broken(golden, (s) => { s.projects[0].nodes[0].extra = 1; }, 'unknown key extra');
  broken(golden, (s) => { s.projects[0].nodes[0].title = 'x'.repeat(61); }, 'at most 60');
  broken(golden, (s) => { s.projects[0].nodes[0].activity = 'a‮b'; }, 'control or bidi');
  broken(golden, (s) => { s.meta.sources.codex.registry = 2; }, 'Codex has no registry');
  broken(golden, (s) => { delete s.meta.sources.dsh; }, 'missing dsh');
  // The rules the about view lists: a name, two counts, and no status that would read as a pass (T4).
  broken(golden, (s) => { delete s.meta.rules; }, 'missing rules');
  broken(golden, (s) => { s.meta.rules[0].status = 'passed'; }, 'meta.rules[0].status');
  broken(golden, (s) => { s.meta.rules[1].id = s.meta.rules[0].id; }, 'listed twice');
  broken(golden, (s) => { s.meta.rules[0].id = 'Has Space'; }, 'rule name');
  broken(golden, (s) => { s.meta.rules[0].n = -1; }, 'meta.rules[0].n');
  broken(golden, (s) => { s.meta.rules[0].hits = 1.5; }, 'meta.rules[0].hits');
});

test('T1: unknown is said as unknown, only unknown has no basis, and a pushed-out source is not empty', () => {
  broken(golden, (s) => { const n = nodes(s).find((x) => x.state === 'unknown')!; n.basis = 'mtime'; }, 'basis none exactly when the state is unknown');
  broken(golden, (s) => { const n = nodes(s).find((x) => x.state === 'running')!; n.basis = 'none'; }, 'basis none exactly when the state is unknown');
  broken(busy, (s) => { s.meta.sources.dsh.state = 'empty'; }, 'empty, but it holds 7 sessions');
  broken(busy, (s) => { s.meta.clipped.sessions.dsh = 0; }, 'not sources.dsh.total - shown (7)');
  broken(golden, (s) => { s.meta.sources.claude.shown = 0; }, 'of its sessions lead a tree');
  // A source with no registry has no node that reads as registry-reported, nor a native wait.
  broken(golden, (s) => { s.meta.sources.dsh.registry = 0; }, 'DSH has no registry');
  broken(golden, (s) => { const n = nodes(s).find((x) => x.harness === 'codex' && x.state === 'running')!; n.basis = 'registry'; }, 'registry, but codex has no registry');
  broken(golden, (s) => { const n = nodes(s).find((x) => x.harness === 'dsh' && x.state === 'running')!; n.basis = 'registry'; }, 'registry, but dsh has no registry');
  broken(golden, (s) => {
    const n = nodes(s).find((x) => x.harness === 'codex' && x.waiting !== null)!;
    n.waiting.source = 'native';
    s.waitingBar.find((w: Json) => w.node === n.id).source = 'native';
  }, 'native, but codex has no registry');
  // Not looked is not none: a build that reads no failure has no node in error, and says which it is.
  broken(golden, (s) => {
    const n = nodes(s).find((x) => x.harness === 'dsh' && x.state === 'running')!;
    n.state = 'error';
    s.tally.running -= 1;
    s.tally.error += 1;
  }, 'error, but meta.detects.error is false');
  broken(golden, (s) => { delete s.meta.detects; }, 'missing detects');
  broken(golden, (s) => { s.meta.detects.error = 'no'; }, 'meta.detects.error');
});

test('a loop of parents is reported, never followed: the checker returns, it does not throw', () => {
  for (const make of [golden, busy]) {
    const s = make();
    const ns = s.projects[0].nodes as Json[];
    const [a, b] = ns.filter((n) => n.parent !== null).slice(0, 2);
    a!.parent = b!.id;
    b!.parent = a!.id;
    let r: ReturnType<typeof validateTower> | undefined;
    assert.doesNotThrow(() => { r = validateTower(s); });
    assert.equal(r!.ok, false);
    assert.ok(r!.errors.some((e) => e.includes('not in tree order')), r!.errors.join(' | '));
  }
  // A long chain is checked without recursion.
  const s = golden();
  const p = s.projects[0];
  const leaf = p.nodes[0];
  const chain = Array.from({ length: 20_000 }, (_, i) => ({ ...leaf, id: `n:${String(i).padStart(20, '0')}`, parent: i === 0 ? null : `n:${String(i - 1).padStart(20, '0')}`, depth: 0, layer: i === 0 ? 'agent' : 'subagent', waiting: null, state: 'idle', basis: 'mtime', groups: [] }));
  p.nodes = chain;
  assert.doesNotThrow(() => validateTower(s));
});

test('T2: nothing is done, and only a subagent returns', () => {
  broken(golden, (s) => { s.projects[0].nodes[0].state = 'returned'; s.projects[0].nodes[0].waiting = null; }, 'only a subagent returns');
});

test('T3: tally, group counts, subtree counts and the waiting bar each equal the list they link to', () => {
  broken(golden, (s) => { s.tally.running += 1; }, '$.tally.running');
  broken(golden, (s) => { s.tally.unknown = 0; }, '$.tally.unknown');
  broken(busy, (s) => { byName(s, 'lead').groups[0].count = 5; }, 'but it lists 6 ids');
  broken(busy, (s) => { byName(s, 'lead').counts.children = 11; }, 'but its subtree holds 12');
  broken(busy, (s) => { byName(s, 'cx').counts.waiting = 0; }, 'counts.waiting');
  broken(golden, (s) => { s.waitingBar.pop(); }, 'waits but is not listed');
  broken(golden, (s) => { s.waitingBar.push({ ...s.waitingBar[0] }); }, 'listed twice');
  broken(golden, (s) => { s.waitingBar[0].kind = 'route'; }, 'the node says');
  broken(golden, (s) => { s.waitingBar[0].node = nodes(s).find((n) => n.waiting === null)!.id; }, 'does not wait');
});

test('waits: set exactly when waiting; only Orchestra\'s queue has a deadline, and only on an owned session', () => {
  broken(golden, (s) => { s.projects[0].nodes[0].waiting = null; }, 'set exactly when the state is waiting');
  broken(golden, (s) => { s.projects[0].nodes[0].waiting.deadline = 1; s.waitingBar.find((w: Json) => w.node === s.projects[0].nodes[0].id).deadline = 1; }, 'set exactly when the source is orchestra');
  broken(golden, (s) => {
    const n = s.projects[0].nodes[0];
    n.waiting = { kind: 'approval', source: 'orchestra', deadline: 5 };
    Object.assign(s.waitingBar.find((w: Json) => w.node === n.id), n.waiting);
  }, 'orchestra waits only on an owned session');
  broken(golden, (s) => {
    const n = nodes(s).find((x) => x.basis === 'registry' && x.waiting !== null)!;
    n.waiting.source = 'inferred';
    s.waitingBar.find((w: Json) => w.node === n.id).source = 'inferred';
  }, 'inferred, but the state has a registry basis');
  // Two owned waits with deadlines: soonest first.
  broken(golden, (s) => {
    s.waitingBar.forEach((w: Json, i: number) => {
      const n = nodes(s).find((x) => x.id === w.node)!;
      n.ownership = 'owned';
      n.waiting = { kind: 'approval', source: 'orchestra', deadline: 2000 - i * 1000 };
      Object.assign(w, n.waiting);
    });
  }, 'out of order');
});

test('tree: references stay in the project, depth and harness follow the parent, tree order holds', () => {
  broken(golden, (s) => { s.projects[0].nodes[1].parent = 'n:00000000000000000000'; }, 'is no node of this project');
  broken(golden, (s) => { s.projects[0].nodes[1].depth = 2; }, 'its parent\'s is 0');
  broken(golden, (s) => { s.projects[0].nodes[1].harness = 'dsh'; }, 'under a codex parent');
  broken(golden, (s) => { s.projects[0].nodes[1].layer = 'agent'; }, 'an agent has no parent');
  broken(golden, (s) => { const ns = s.projects[0].nodes; ns.push(ns.splice(1, 1)[0]); }, 'not in tree order');
  broken(busy, (s) => {
    const ns = shop(s).nodes;
    const a = ns.findIndex((n: Json) => n.id === nid('runner'));
    const b = ns.findIndex((n: Json) => n.id === nid('gp1'));
    [ns[a], ns[b]] = [ns[b], ns[a]];
  }, 'after');
  broken(golden, (s) => { s.router.dispatch = { open: true }; }, 'null until the dispatch desk exists');
  broken(golden, (s) => { s.router.kind = 'maestro'; }, '$.router.kind');
});

test('folding: never-fold rows stay out, each group holds what it says, and nothing foldable is left loose', () => {
  broken(busy, (s) => { const g = byName(s, 'lead').groups[1]; g.ids.push(nid('runner')); g.count++; }, 'never folds');
  broken(busy, (s) => { const g = byName(s, 'lead').groups[1]; g.ids.push(nid('mid')); g.count++; }, 'never folds');
  broken(busy, (s) => { byName(s, 'lead').groups.pop(); }, 'returned leaves left unfolded');
  broken(busy, (s) => { shop(s).groups = []; }, 'idle leaves left unfolded');
  broken(busy, (s) => { byName(s, 'lead').groups.shift(); }, 'left out of a same-type group');
  broken(busy, (s) => { const g = byName(s, 'lead').groups[0]; g.ids.splice(-2); g.count -= 2; }, 'at least 5');
  broken(busy, (s) => { const g = byName(s, 'lead').groups[0]; g.label = 'Plan'; }, 'not Plan');
  broken(busy, (s) => { const g = byName(s, 'lead').groups[1]; g.ids.push(g.ids[0]); g.count++; }, 'in two groups');
  broken(busy, (s) => { const g = shop(s).groups[0]; g.ids[0] = nid('ex1'); }, 'is not among these siblings');
  broken(busy, (s) => { byName(s, 'lead').groups[1].label = 'x'; }, 'set exactly for a same-type group');
});
