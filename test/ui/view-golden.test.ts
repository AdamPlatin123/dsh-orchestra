import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStage } from '../../shared/stage-contract.js';
import { CHIPS, describeDrawer, describeHeader, describePlan, describeRules, describeScore, groupSummary, view } from '../../ui/view.js';

// ui/view.js's descriptors over the daemon's golden snapshot (test/fixtures/stage-snapshot.json, what
// src/sources/stage.ts builds from the stage fixture), beside view-stage.test.ts's hand-written sample:
// the page and the builder must agree on real builder output, not only on the shared contract. Checked
// here: every count is the length of its rows (T3), every staff head's look and instrument come from its
// player's fields (T1), the word for "done" never appears (T2), every verdict reads 无复核者（这一版没有）
// (D19: only a non-author reviewer or you can call work done), every rule at N=0 reads 未测 (T4), and
// the canary shows only as its redaction marker (T5).

const GOLDEN = fileURLToPath(new URL('../fixtures/stage-snapshot.json', import.meta.url));
type Json = Record<string, any>;
const golden = (): Json => JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Json;
const fmt = { time: (ms: number) => String(ms), iso: (s: string) => s.slice(11, 19) };
const DONE = '完成';

/** Every text in a descriptor tree. */
function texts(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) texts(v, out);
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'text' && typeof v === 'string') out.push(v);
      else texts(v, out);
    }
  }
  return out;
}

/** Every templated descriptor under `x`. */
function descs(x: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(x)) for (const v of x) descs(v, out);
  else if (x !== null && typeof x === 'object') {
    if (typeof (x as Json).key === 'string' && typeof (x as Json).tpl === 'string') out.push(x as Json);
    for (const v of Object.values(x)) descs(v, out);
  }
  return out;
}

test('the golden snapshot passes the contract and has something to draw', () => {
  const s = golden();
  assert.deepEqual(validateStage(s), { ok: true, errors: [] });
  assert.ok(s.lanes.length > 0 && s.lanes.some((l: Json) => l.items.length > 0 && l.players.length > 1));
});

test('golden: header, chip, plan, desk and score counts are the lengths of their rows (T3)', () => {
  const s = golden();
  for (const lane of s.lanes) {
    const playing = lane.players.filter((p: Json) => ['busy', 'running', 'waiting'].includes(p.live.state));
    const h = describeHeader(s as any, lane.id, { stale: false, at: '' });
    assert.deepEqual(h.counts, { a: playing.length, b: lane.players.length, c: view(lane, 'reported').rows.length, d: view(lane, 'sent').rows.length });
    for (const chip of CHIPS) {
      const p = describePlan(s as any, lane.id, chip, null, fmt);
      const n = view(lane, chip).rows.length;
      assert.match(descs(p.slots.chips).find((d) => d.key === chip)!.text, new RegExp(` ${n}$`));
      const rows = descs(p.slots.list).filter((d) => d.tpl === 'tpl-row');
      assert.equal(rows.length, n, `${lane.name} ${chip}`);
      assert.equal(p.rows, n);
    }
    // Unfiltered: each work item handed out is one row, and each clone with no item is one stray row.
    const all = describePlan(s as any, lane.id, null, null, fmt);
    const rows = descs(all.slots.list).filter((d) => d.tpl === 'tpl-row');
    const sent = lane.items.filter((w: Json) => w.source !== 'todo').map((w: Json) => w.id).sort();
    assert.deepEqual(rows.filter((r) => r.key.startsWith('w:')).map((r) => r.key).sort(), sent);
    const executing = new Set(lane.items.map((w: Json) => w.executor));
    const strays = lane.players.filter((p: Json) => p.role !== 'principal' && !executing.has(p.id)).map((p: Json) => `x:${p.id}`).sort();
    assert.deepEqual(rows.filter((r) => r.key.startsWith('x:')).map((r) => r.key).sort(), strays);
    assert.equal(all.rows, sent.length);
    // One desk per principal; its todo list is its stand, and its head says only what the agent self-reported.
    const principals = lane.players.filter((p: Json) => p.role === 'principal');
    const desks = descs(all.slots.desk).filter((d) => d.tpl === 'tpl-desk');
    assert.deepEqual(desks.map((d) => d.key), principals.map((p: Json) => p.id));
    for (const p of principals) {
      const desk = desks.find((d) => d.key === p.id)!;
      if (p.stand.source !== 'todo') continue;
      assert.equal(desk.slots.todo.kids.length, p.stand.items.length);
      assert.ok(desk.slots.todoHead.text.includes(`自报 ${p.stand.selfReported.checked}/${p.stand.selfReported.total}`), desk.slots.todoHead.text);
    }
    // The score gives every player one staff head and every handed-out item one phrase, across its
    // systems; each head is its player's fields, and each system's sentence counts its own lists.
    const sc = describeScore(s as any, lane.id, null);
    const systems = sc.systems!.kids!;
    const heads = systems.flatMap((d) => d.slots!.heads!.kids!).filter((d) => d.tpl === 'tpl-shead');
    assert.deepEqual(heads.map((d) => d.key).sort(), lane.players.map((p: Json) => p.id).sort());
    const phrases = systems.flatMap((d) => d.slots!.phrases!.kids!);
    assert.deepEqual(phrases.map((d) => d.key).sort(), sent);
    assert.equal(sc.waits!.kids!.length, s.podium.fermatas.length);
    assert.equal(sc.podium!.data!.n, String(s.podium.fermatas.length));
    for (const d of heads) {
      const p = lane.players.find((x: Json) => x.id === d.key)!;
      assert.deepEqual([d.data!.look, d.data!.instr, d.data!.role, d.data!.lineage], [p.look, p.instrument.class, p.role, p.harness], 'T1: the head is its fields');
    }
    for (const sys of systems) {
      const g = groupSummary(lane, sys.key, s.podium.fermatas);
      assert.equal(sys.slots!.sysLine!.text, g.text);
      assert.equal(sys.slots!.phrases!.kids!.length, g.lists.sent.length);
      assert.equal(sys.slots!.ferms!.kids!.length, g.lists.waiting.length);
      assert.match(g.text, new RegExp(`派活 ${g.lists.sent.length}`));
    }
  }
});

test('golden: every verdict reads 无复核者（这一版没有）, every rule 没测过（0 个样本）, and no text says done', () => {
  const s = golden();
  const rules = describeRules(s.rules);
  assert.equal(rules.length, s.rules.length);
  for (const r of rules) assert.deepEqual([r.cls, r.slots!.n!.text], ['untested', '没测过（0 个样本）']);
  const all: string[] = [];
  for (const lane of s.lanes) {
    all.push(...texts(describeHeader(s as any, lane.id, { stale: false, at: '' })));
    all.push(...texts(describeScore(s as any, lane.id, null)));
    for (const chip of [null, ...CHIPS]) {
      const p = describePlan(s as any, lane.id, chip, null, fmt);
      all.push(...texts(p));
      for (const r of descs(p.slots.list).filter((d) => d.tpl === 'tpl-row')) assert.equal(r.slots.verdict.text, '无复核者（这一版没有）');
    }
    for (const node of [...lane.players.map((p: Json) => p.id), ...lane.items.map((w: Json) => w.id)]) {
      const d = describeDrawer(s as any, lane.id, node, null, fmt, 0);
      assert.ok(d !== null, `no drawer for ${node}`);
      all.push(...texts(d));
    }
  }
  assert.ok(all.length > 100);
  for (const t of all) {
    assert.ok(!t.includes(DONE), t);
    assert.ok(!/\{\w+\}/.test(t), `unfilled placeholder in ${t}`);
    assert.ok(!t.includes('sk-ant-api03-'), 'the canary reaches the page only as its marker');
  }
  assert.ok(all.some((t) => t.includes('[redacted:')), 'the redaction marker is what the page shows');
});
