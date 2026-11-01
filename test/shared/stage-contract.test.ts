import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HEX20_RE, ITEM_ID_RE, PLAYER_ID_RE, STAGE_BOUNDS, STAGE_ENUMS, STAGE_RULE_IDS, validateSession, validateStage,
} from '../../shared/stage-contract.js';

// shared/stage-contract.js is the stage preview's contract (0.1 alpha design §3). The page's
// hand-written sample passes it, and each targeted mutation below breaks exactly the check it names:
// a bad id, a dangling reference, a claimed verdict or done criteria, a rule with a checked sample, an
// enum value the design does not list. The daemon's golden file is checked against the same validator.

const SAMPLE = fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url));
type Json = Record<string, any>;
const sample = (): Json => JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Json;

/** Mutates a fresh sample and returns the validator's errors, which must name `want`. */
function broken(mutate: (s: Json) => void, want: string): string[] {
  const s = sample();
  mutate(s);
  const r = validateStage(s);
  assert.equal(r.ok, false, `still valid after the mutation for ${want}`);
  assert.ok(r.errors.some((e) => e.includes(want)), `no error names ${want}: ${r.errors.join(' | ')}`);
  return r.errors;
}

const lane0 = (s: Json) => s.lanes[0];
const player = (s: Json, label: string) => lane0(s).players.find((p: Json) => p.label.startsWith(label));
const item = (s: Json, id: string) => lane0(s).items.find((w: Json) => w.id === id);

test('the hand-written UI sample passes validateStage and holds the demo scenario of design §9', () => {
  const s = sample();
  assert.deepEqual(validateStage(s), { ok: true, errors: [] });
  assert.equal(s.profile, 'test');
  assert.equal(s.lanes.length, 2, 'the lane picker has two entries');
  assert.deepEqual(s.lanes.map((l: Json) => l.basis), ['cwd', 'slug']);
  const lead = player(s, 'shop · 重构');
  assert.deepEqual([lead.live.state, lead.live.waitingFor], ['waiting', 'permission prompt']);
  assert.deepEqual(s.podium.fermatas, [lead.id]);
  assert.deepEqual(lead.stand.selfReported, { checked: 1, total: 3 });
  assert.deepEqual([player(s, 'Explore').look, item(s, 'w:toolu_t1').flow], ['translucent', { childBytes: 48213, reportBytes: 1204 }]);
  const a2 = player(s, 'Review diff');
  assert.deepEqual([a2.look, a2.instrument.class], ['solid', 'brass']);
  assert.ok(lane0(s).players.some((p: Json) => p.parent === a2.id && p.depth === 2), 'a2 leads a department at depth 2');
  assert.equal(player(s, 'Scan legacy').look, 'ghost');
  assert.equal(item(s, 'w:agent-a3').state, 'orphan');
  assert.equal(player(s, 'impl').instrument.class, 'strings');
  assert.equal(player(s, 'shop · DSH').stand.source, 'goal');
  assert.deepEqual(s.sources.codex, { state: 'not-connected' });
  const text = JSON.stringify(s);
  assert.ok(text.includes('[redacted:'), 'the canary shows as its redaction marker');
  assert.ok(!/sk-ant-api03-/.test(text) && !/[A-Za-z]:\\\\/.test(text), 'no key and no absolute path');
  assert.ok(!text.includes('完成'));
});

test('the exported tables are the enums and rule ids of §3, frozen', () => {
  assert.equal(STAGE_RULE_IDS.length, 13);
  assert.ok(Object.isFrozen(STAGE_RULE_IDS) && Object.isFrozen(STAGE_ENUMS) && Object.isFrozen(STAGE_ENUMS.look) && Object.isFrozen(STAGE_BOUNDS));
  assert.deepEqual([...STAGE_ENUMS.instrument], ['woodwind', 'strings', 'percussion', 'brass', 'unknown']);
  assert.deepEqual([...STAGE_ENUMS.itemState], ['working', 'reported', 'orphan', 'unknown', 'self'], 'reported is the furthest a work item gets');
  assert.ok(HEX20_RE.test('0123456789abcdef0123') && !HEX20_RE.test('0123456789ABCDEF0123') && !HEX20_RE.test('0123456789abcdef012'));
  assert.ok(PLAYER_ID_RE.test('p:0123456789abcdef0123') && !PLAYER_ID_RE.test('0123456789abcdef0123'));
  assert.ok(ITEM_ID_RE.test('w:toolu_t1') && !ITEM_ID_RE.test('w:has space') && !ITEM_ID_RE.test('toolu_t1'));
});

test('a bad id fails: player, lane, session, item and rev each keep their grammar', () => {
  broken((s) => { lane0(s).players[1].id = 'p:F55FF16F66F43360266B'; }, 'lanes[0].players[1].id');
  broken((s) => { lane0(s).id = 'shop'; }, 'lanes[0].id');
  broken((s) => { lane0(s).players[0].session = 'not-a-digest'; }, 'lanes[0].players[0].session');
  broken((s) => { lane0(s).items[0].id = 'toolu_t1'; }, 'lanes[0].items[0].id');
  broken((s) => { s.rev = 'abc'; }, '$.rev');
  broken((s) => { lane0(s).players[2].id = lane0(s).players[1].id; }, 'used twice');
});

test('a dangling reference fails: parents, owners, executors, cues and fermatas stay inside their lane', () => {
  broken((s) => { lane0(s).players[1].parent = 'p:00000000000000000000'; }, 'lanes[0].players[1].parent');
  // A player of the other lane is no parent here.
  broken((s) => { lane0(s).players[1].parent = s.lanes[1].players[0].id; }, 'is no player of this lane');
  broken((s) => { lane0(s).items[0].owner = s.lanes[1].players[0].id; }, 'lanes[0].items[0].owner');
  broken((s) => { lane0(s).items[0].executor = 'p:00000000000000000000'; }, 'lanes[0].items[0].executor');
  broken((s) => { item(s, 'w:toolu_t5').parent = 'w:nowhere'; }, 'is no item of this lane');
  broken((s) => { lane0(s).cues[0].to = 'p:00000000000000000000'; }, 'lanes[0].cues[0].to');
  broken((s) => { s.podium.fermatas = ['p:00000000000000000000']; }, 'no player of this snapshot');
  broken((s) => { s.podium.fermatas = [s.lanes[1].players[0].id]; }, 'is not waiting');
  broken((s) => { player(s, 'Run checkout').depth = 1; }, 'its parent\'s is 1');
});

test('no verdict and no done criteria are claimed (D19, T2)', () => {
  broken((s) => { lane0(s).items[0].verdict = 'accepted'; }, 'M0 has no reviewer');
  broken((s) => { lane0(s).items[1].criteria = { state: 'declared' }; }, 'criteria are always undeclared');
  broken((s) => { lane0(s).items[1].criteria = { state: 'undeclared', text: 'tests pass' }; }, 'unknown key text');
  broken((s) => { lane0(s).items[1].state = 'done'; }, 'lanes[0].items[1].state');
  broken((s) => { item(s, 'w:toolu_t1').report = null; }, 'present exactly when the state is reported');
  broken((s) => { item(s, 'w:toolu_t1').flow.reportBytes = 999; }, 'not the report\'s bytes');
});

test('every rule has n 0 in the alpha, each rule id exactly once (T4)', () => {
  broken((s) => { s.rules[0].n = 1; }, '$.rules[0].n');
  broken((s) => { s.rules[3].status = 'pass'; }, '$.rules[3].status');
  broken((s) => { s.rules.pop(); }, 'missing fermata.registry-waiting');
  broken((s) => { s.rules[1].id = s.rules[0].id; }, 'listed twice');
  // Hits are what fired on this snapshot, never a sample: any number of them keeps n at 0.
  const s = sample();
  s.rules[0].hits = 5;
  assert.equal(validateStage(s).ok, true);
});

test('an enum value the design does not list fails, and so does a missing or unknown key', () => {
  broken((s) => { lane0(s).players[0].look = 'glowing'; }, 'lanes[0].players[0].look');
  broken((s) => { lane0(s).players[0].instrument.class = 'piano'; }, 'instrument.class');
  broken((s) => { lane0(s).players[0].live.basis = 'guess'; }, 'live.basis');
  broken((s) => { lane0(s).basis = 'path'; }, 'lanes[0].basis');
  broken((s) => { s.sources.codex.state = 'ok'; }, 'Codex is not read in M0');
  broken((s) => { s.profile = 'prod'; }, '$.profile');
  broken((s) => { s.v = 2; }, '$.v');
  broken((s) => { s.kind = 'snapshot'; }, '$.kind');
  broken((s) => { delete lane0(s).players[0].bytes; }, 'missing bytes');
  broken((s) => { lane0(s).players[0].secret = 'x'; }, 'unknown key secret');
});

test('source text keeps shown()\'s bounds: 120 code points (one more for the clip mark), no control or bidi character', () => {
  const at120 = '字'.repeat(STAGE_BOUNDS.textCp);
  const s = sample();
  lane0(s).items[0].brief = at120;
  lane0(s).items[1].brief = `${at120}…`;
  lane0(s).players[0].label = '😀'.repeat(STAGE_BOUNDS.textCp);
  assert.deepEqual(validateStage(s).errors, []);
  broken((x) => { lane0(x).items[0].brief = `${at120}字`; }, '121 code points');
  broken((x) => { lane0(x).players[0].label = 'evil\u202ename'; }, 'control or bidi');
  broken((x) => { lane0(x).players[0].stand.items = Array.from({ length: 13 }, () => ({ text: 'x', status: 'pending' })); }, 'at most 12');
});

test('validateStage never throws: anything that is not a snapshot is an error list', () => {
  for (const x of [null, undefined, 1, 'stage', [], { v: 1 }, Object.create({ v: 1 })]) {
    const r = validateStage(x);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
  const s = sample();
  s.lanes[0].players = 'none';
  s.lanes[0].items = [null, 3];
  assert.equal(validateStage(s).ok, false);
});

test('validateSession: a session detail with at most 50 events and peek\'s harness and note values', () => {
  const ok = {
    session: { id: '78bd7dde24d685f253bd', harness: 'claude', label: 'G--fx-shop', size: 48213, mtimeMs: 1793559790000 },
    events: [
      { at: '2026-11-01T10:00:03.000Z', type: 'assistant', text: 'Read cart.ts' },
      { at: null, type: 'user', text: 'token [redacted:sk-ant]' },
    ],
    unparsed: 0,
    note: null,
    brief: 'Explore cart — Find cart code. Done when files listed.',
  };
  assert.deepEqual(validateSession(ok), { ok: true, errors: [] });
  const bad = (mutate: (d: Json) => void, want: string) => {
    const d = structuredClone(ok) as Json;
    mutate(d);
    const r = validateSession(d);
    assert.equal(r.ok, false, want);
    assert.ok(r.errors.some((e) => e.includes(want)), `${want}: ${r.errors.join(' | ')}`);
  };
  bad((d) => { d.session.id = 'x'; }, '$.session.id');
  bad((d) => { d.session.file = 'C:\\x.jsonl'; }, 'unknown key file');
  bad((d) => { d.session.harness = 'codex'; }, '$.session.harness');
  bad((d) => { d.events = Array.from({ length: 51 }, () => ok.events[1]); }, 'at most 50');
  bad((d) => { d.events[0].at = 'yesterday'; }, '$.events[0].at');
  bad((d) => { d.note = 'gone'; }, '$.note');
  assert.equal(validateSession(null).ok, false);
});
