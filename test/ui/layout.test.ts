import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCORE, groupItems, groupPlayers, kb, layoutScore, phraseLen, tieWeight } from '../../ui/layout.js';

// ui/layout.js lays one group of one lane out as a full score (0.1 alpha design §6, frontend-design
// pass 2): one staff per player, principals first and each member after its parent; one column per
// work item handed out, in record order; a phrase on the executor's staff whose length follows the
// context it read, a slur only where a dispatch cue says so, a tie only where a report cue says so.
// Deterministic, and nothing drawn without a field behind it (T1).

const SAMPLE = fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url));
const GOLDEN = fileURLToPath(new URL('../fixtures/stage-snapshot.json', import.meta.url));
type Json = Record<string, any>;
const sample = (): Json => JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Json;
const golden = (): Json => JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Json;
const LEAD = 'p:fbeae7c18667b6987518';

test('layoutScore is deterministic; staves run principal first, each member after its parent, indented by depth', () => {
  const s = sample();
  const lane = s.lanes[0];
  const a = layoutScore(lane, 'claude', s.podium.fermatas);
  assert.deepEqual(layoutScore(sample().lanes[0], 'claude', s.podium.fermatas), a);
  const ids = a.staves.map((st) => st.id);
  assert.equal(ids[0], LEAD);
  assert.deepEqual(new Set(ids), new Set(lane.players.filter((p: Json) => p.harness === 'claude').map((p: Json) => p.id)));
  for (const st of a.staves) {
    const p = st.player!;
    if (p.parent !== null) assert.ok(ids.indexOf(p.parent) < ids.indexOf(p.id), `${p.label} sits below its parent`);
    assert.equal(st.x, SCORE.x + SCORE.indent * p.depth);
  }
  // Rows are evenly spaced, and the two SVGs share them: same height for heads and music.
  a.staves.forEach((st, i) => assert.equal(st.y, SCORE.top + SCORE.row * i + SCORE.row / 2));
  assert.equal(a.h, SCORE.top + SCORE.row * a.staves.length + 6);
});

test('one column per handed-out item in record order; todos stay off the score', () => {
  const s = sample();
  const lane = s.lanes[0];
  for (const h of ['claude', 'dsh']) {
    const L = layoutScore(lane, h, []);
    const items = groupItems(lane, h);
    assert.ok(items.every((w: Json) => w.source !== 'todo'));
    assert.deepEqual(L.phrases.map((p) => p.item.id), items.map((w: Json) => w.id));
    assert.deepEqual(L.phrases.map((p) => p.col), items.map((_: Json, i: number) => i));
    assert.deepEqual(L.cols.map((c) => c.n), items.map((_: Json, i: number) => i + 1));
    assert.equal(L.w, SCORE.lead + SCORE.col * Math.max(items.length, 1) + SCORE.tail);
    for (const p of L.phrases) assert.equal(p.staff, p.item.executor, 'a phrase sits on its executor’s staff');
  }
  // Both groups together cover every handed-out item of the lane once.
  const all = [...groupItems(lane, 'claude'), ...groupItems(lane, 'dsh')].map((w: Json) => w.id).sort();
  assert.deepEqual(all, lane.items.filter((w: Json) => w.source !== 'todo').map((w: Json) => w.id).sort());
});

test('phrase length follows flow.childBytes; no flow is a stub, working is open; slurs and ties follow the cues', () => {
  const s = sample();
  const lane = s.lanes[0];
  const L = layoutScore(lane, 'claude', []);
  const by = (id: string) => L.phrases.find((p) => p.item.id === id)!;
  const t1 = by('w:toolu_t1');
  assert.equal(t1.kind, 'flow');
  assert.equal(t1.x2 - t1.x1, phraseLen(48213));
  assert.ok(t1.slur !== null && t1.tie !== null, 'dispatched and reported: slur down, tie back');
  assert.equal(t1.tie!.w, tieWeight(1204));
  const t2 = by('w:toolu_t2');
  assert.deepEqual([t2.kind, t2.x2 - t2.x1, t2.tie], ['open', SCORE.stub, null], 'still working: no length claimed, no tie');
  assert.ok(t2.tail > t2.x2);
  const orphan = by('w:agent-a3');
  assert.equal(orphan.kind, 'stub');
  const cued = (id: string, kind: string) => lane.cues.some((c: Json) => c.item === id && c.kind === kind);
  // The backend cues a dispatch for every item with an executor, orphans too; no record names the
  // orphan's dispatcher, so the graph draws no 派活 arrow for it.
  assert.ok(cued('w:agent-a3', 'dispatch'));
  assert.equal(orphan.slur, null);
  const ownerY = (p: any) => L.staves.find((st) => st.id === p.item.owner)!.y;
  for (const p of L.phrases) {
    assert.equal(p.slur !== null, cued(p.item.id, 'dispatch') && p.item.state !== 'orphan', `${p.item.id}: slur iff a dispatch cue, never for an orphan`);
    assert.equal(p.tie !== null, cued(p.item.id, 'report'), `${p.item.id}: tie iff a report cue`);
    if (p.slur !== null) assert.equal(p.slur.y + p.slur.dy, p.y, 'the slur lands on the phrase’s staff');
    if (p.tie !== null) {
      assert.ok(p.tie.x + p.tie.dx >= p.x1 + 40, 'the report arrow rises clear of the state word');
      assert.equal(p.tie.y + p.tie.dy, p.y, 'the report arrow leaves from the bar’s row');
      assert.equal(p.tie.y - Math.sign(p.tie.dy) * 6, ownerY(p), 'it stops 6 short of the owner’s row, where its head sits');
    }
  }
  // The department's own dispatch leaves from its staff, not the principal's.
  const t5 = by('w:toolu_t5');
  const dept = L.staves.find((st) => st.id === 'p:2c3a4249d77070058649')!;
  assert.equal(t5.slur!.y, dept.y);
  assert.deepEqual(L.depts.map((d) => d.id), ['p:2c3a4249d77070058649']);
  const d = L.depts[0]!;
  const child = L.staves.find((st) => st.id === 'p:394e68839349a156b805')!;
  assert.ok(d.y0 < dept.y && d.y1 > child.y, 'the department bracket spans its member');
  assert.deepEqual([phraseLen(1), phraseLen(1e9)], [SCORE.min, SCORE.max]);
  assert.deepEqual([tieWeight(21), tieWeight(1204), tieWeight(1e6)], [1, 3, 4]);
});

test('fermatas sit on the waiting players’ staves only; unlinked items get a grey 未关联 staff', () => {
  const s = sample();
  const lane = s.lanes[0];
  const L = layoutScore(lane, 'claude', s.podium.fermatas);
  assert.deepEqual(L.ferms.map((f) => f.id), s.podium.fermatas);
  // A badge is wide and opaque: it sits after the last column, right of every mark.
  for (const f of L.ferms) assert.ok(L.phrases.every((p) => f.x > p.tail && f.x > p.x0 + SCORE.col - 10));
  // So does a waiting member with a bar of its own in the first column.
  const Lc = layoutScore(lane, 'claude', ['p:f55ff16f66f43360266b']);
  assert.equal(Lc.ferms.length, 1);
  assert.ok(Lc.phrases.every((p) => Lc.ferms[0]!.x > p.x0 + SCORE.col - 10));
  assert.deepEqual(layoutScore(lane, 'dsh', s.podium.fermatas).ferms, []);
  assert.ok(!L.staves.some((st) => st.player === null));
  const lost = sample().lanes[0];
  lost.items.find((w: Json) => w.id === 'w:toolu_t2').executor = null;
  const L2 = layoutScore(lost, 'claude', []);
  const u = L2.staves[L2.staves.length - 1]!;
  assert.deepEqual([u.id, u.player], ['u:claude', null]);
  assert.equal(L2.phrases.find((p) => p.item.id === 'w:toolu_t2')!.staff, 'u:claude');
});

test('a parent loop or a missing parent still gives every player one staff; the golden lays out too', () => {
  const s = sample();
  const lane = s.lanes[0];
  const a = lane.players.find((p: Json) => p.id === 'p:2c3a4249d77070058649');
  const b = lane.players.find((p: Json) => p.id === 'p:394e68839349a156b805');
  a.parent = b.id;
  lane.players.find((p: Json) => p.id === 'p:f55ff16f66f43360266b').parent = 'p:ffffffffffffffffffff';
  const ids = groupPlayers(lane, 'claude').map((p: Json) => p.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, lane.players.filter((p: Json) => p.harness === 'claude').length);
  const g = golden();
  for (const l of g.lanes) {
    for (const h of ['claude', 'dsh']) {
      const L = layoutScore(l, h, g.podium.fermatas);
      assert.equal(L.staves.filter((st) => st.player !== null).length, l.players.filter((p: Json) => p.harness === h).length);
      assert.equal(L.phrases.length, groupItems(l, h).length);
    }
  }
  assert.deepEqual([kb(940), kb(1204), kb(48213), kb(3_100_000)], ['940', '1.2k', '48k', '3.1M']);
});
