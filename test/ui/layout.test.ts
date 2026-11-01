import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAGE_GEOM, kb, layoutStage, seatBox } from '../../ui/layout.js';

// ui/layout.js seats one lane on the 1200×920 stage (0.1 alpha design §6): deterministic, no two seats
// overlap up to 12 clones in a section, the 13th clone becomes a `+n` badge, and every seat stays
// inside its section and the viewBox.

const SAMPLE = fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url));
type Json = Record<string, any>;
const sample = (): Json => JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Json;
const hex = (n: number) => n.toString(16).padStart(20, '0');

/** A lane of one principal per harness plus `n` clones each, the clones' depths cycling through `depths`. */
function crowd(n: number, depths: number[] = [1]): Json {
  const players: Json[] = [];
  const base = sample().lanes[0].players[1];
  for (const harness of ['claude', 'dsh']) {
    const lead = { ...base, id: `p:${hex(players.length + 1)}`, harness, role: 'principal', parent: null, depth: 0 };
    players.push(lead);
    for (let i = 0; i < n; i++) players.push({ ...base, id: `p:${hex(players.length + 1)}`, harness, role: 'clone', parent: lead.id, depth: depths[i % depths.length] });
  }
  return { id: hex(999), name: 'crowd', basis: 'cwd', players, items: [], cues: [] };
}

function assertNoOverlap(lane: Json) {
  const L = layoutStage(lane as any);
  const lead = new Set(lane.players.filter((p: Json) => p.role === 'principal').map((p: Json) => p.id));
  const boxes = L.seats.map((s) => ({ s, b: seatBox(s, lead.has(s.id)) }));
  for (const { s, b } of boxes) {
    const sec = STAGE_GEOM.sections[s.section];
    assert.ok(b.x0 >= sec.x0 - 0.01 && b.x1 <= sec.x1 + 0.01, `${s.id} leaves the ${s.section} section: ${b.x0}..${b.x1}`);
    assert.ok(b.y0 >= 0 && b.y1 <= STAGE_GEOM.h, `${s.id} leaves the stage`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!.b;
      const c = boxes[j]!.b;
      const overlap = a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
      assert.ok(!overlap, `${boxes[i]!.s.id} overlaps ${boxes[j]!.s.id}`);
    }
  }
  return L;
}

test('layoutStage is deterministic and seats the sample with principals in front', () => {
  const lane = sample().lanes[0];
  const a = layoutStage(lane);
  assert.deepEqual(layoutStage(sample().lanes[0]), a);
  assert.equal(a.seats.length, lane.players.length);
  const lead = a.seats.find((s) => s.id === 'p:fbeae7c18667b6987518')!;
  assert.deepEqual([lead.row, lead.s, lead.section], [0, STAGE_GEOM.maxScale.principal, 'claude'], 'a lone principal takes the largest seat');
  const dept = a.seats.find((s) => s.id === 'p:394e68839349a156b805')!;
  const front = a.seats.find((s) => s.id === 'p:f55ff16f66f43360266b')!;
  assert.equal(front.row, 1);
  assert.ok(dept.row === 2 && dept.s <= front.s && dept.y < front.y, 'the depth-2 clone sits on the second riser, behind and no larger');
  assert.ok(a.seats.filter((s) => s.row > 0).every((s) => s.s < lead.s), 'clones are smaller than their principal');
  assert.deepEqual(a.risers.map((r) => [r.section, r.row]), [['claude', 1], ['claude', 2], ['dsh', 1]], 'only the risers in use are built');
  assert.deepEqual(a.overflow, []);
  assertNoOverlap(lane);
});

test('no seat overlaps for 0 to 12 clones per section, at any depth mix', () => {
  for (let n = 0; n <= 12; n++) {
    for (const depths of [[1], [2], [3], [1, 2], [1, 2, 3, 4], [4]]) {
      const L = assertNoOverlap(crowd(n, depths));
      assert.equal(L.seats.length, 2 + 2 * n, `n=${n} depths=${depths}`);
      assert.deepEqual(L.overflow, []);
    }
  }
});

test('the 13th clone of a section becomes a +n badge, and so does a third principal', () => {
  const L = assertNoOverlap(crowd(13));
  assert.equal(L.seats.length, 2 + 24);
  assert.deepEqual(L.overflow.map((o) => [o.section, o.n]), [['claude', 1], ['dsh', 1]]);
  const lane = crowd(20, [1, 2]);
  assert.deepEqual(layoutStage(lane as any).overflow.map((o) => o.n), [8, 8]);
  const leads = crowd(0);
  const extra = { ...leads.players[0], id: `p:${hex(500)}` };
  const third = { ...leads.players[0], id: `p:${hex(501)}` };
  leads.players.push(extra, third);
  const L2 = assertNoOverlap(leads);
  assert.deepEqual(L2.overflow.map((o) => [o.section, o.n]), [['claude', 1]]);
});

test('cue lines join seated players only; the report line carries the compression label', () => {
  const lane = sample().lanes[0];
  const L = layoutStage(lane);
  assert.equal(L.cues.length, lane.cues.length);
  const report = L.cues.find((c) => c.kind === 'report')!;
  assert.equal(report.label, '48k→1.2k');
  assert.ok(L.cues.filter((c) => c.kind === 'dispatch').every((c) => c.label === ''));
  lane.cues.push({ from: lane.players[0].id, to: 'p:ffffffffffffffffffff', item: 'w:toolu_t1', kind: 'dispatch' });
  assert.equal(layoutStage(lane).cues.length, L.cues.length, 'a cue to an unseated player is not drawn');
  assert.deepEqual([kb(940), kb(1204), kb(48213), kb(3_100_000)], ['940', '1.2k', '48k', '3.1M']);
});
