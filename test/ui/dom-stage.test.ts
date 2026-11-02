import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml, type FakeDocument, type FakeElement } from '../helpers/fake-dom.ts';
import { ATTRS, makePatcher } from '../../ui/dom.js';
import { NOTES, describeDrawer, describeHeader, describePlan, describeScore, noteOf } from '../../ui/view.js';
import { STAGE_TEXT } from '../../shared/strings.js';

// ui/dom.js patches the real ui/stage.html (its templates, parsed by test/helpers/fake-dom.ts) with the
// descriptors of ui/view.js over the page's sample. Rendering at all proves every slot a descriptor
// names exists in its template. The budget of UID:248 holds: a second identical render writes nothing,
// and changing u rows costs at most 8u + 2 writes, whatever the number of rows. No markup is parsed and
// setAttribute writes only the frozen geometry list.

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.html', import.meta.url)), 'utf8');
const SAMPLE = fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url));
type Json = Record<string, any>;
const sample = (): Json => JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Json;
const fmt = { time: (ms: number) => new Date(ms).toISOString().slice(11, 19), iso: (s: string) => s.slice(11, 19) };
const SHOP = '2261f9a05a5aea69ded3';

function page() {
  const doc = parseHtml(HTML);
  const dom = makePatcher(doc as unknown as Document);
  dom.fillStatic();
  const render = (s: Json, chip: any = null, sel: string | null = null, peek = false) => {
    dom.paintId('bar', { slots: describeHeader(s as any, SHOP, { stale: false, at: '10:00:30' }).slots });
    dom.paintId('stage', { slots: describeScore(s as any, SHOP, sel) });
    dom.paintId('plan', { slots: describePlan(s as any, SHOP, chip, sel, fmt).slots });
    const d = peek && sel !== null ? describeDrawer(s as any, SHOP, sel, null, fmt, 0) : null;
    if (d !== null) dom.paintId('drawer', { slots: d.slots });
    dom.drawer(doc.getElementById('drawer') as unknown as HTMLDialogElement, d !== null);
  };
  return { doc, dom, render };
}

const writes = (doc: FakeDocument) => doc.ops.length;

test('the page renders the sample through the real templates, and a second identical render writes nothing', () => {
  const { doc, render } = page();
  render(sample(), null, 'w:toolu_t1', true);
  assert.ok(writes(doc) > 100, 'the first render builds the page');
  assert.equal(doc.querySelectorAll('.system').length, 2, 'Claude and DSH from the data; the sample has no Codex player');
  assert.equal(doc.querySelectorAll('.shead').length, 8);
  assert.equal(doc.querySelectorAll('.phrase').length, 6);
  assert.equal(doc.querySelectorAll('.wait').length, 1);
  assert.equal(doc.querySelectorAll('.row').length, 6);
  assert.equal(doc.querySelectorAll('.desk').length, 2);
  assert.equal(doc.querySelectorAll('.rule').length, 20);
  assert.equal((doc.getElementById('drawer') as FakeElement).open, true);
  doc.resetOps();
  render(sample(), null, 'w:toolu_t1', true);
  assert.deepEqual(doc.ops, []);
});

test('changing u rows costs at most 8u + 2 writes, independent of the total', () => {
  for (const u of [1, 2, 3]) {
    const { doc, dom, render } = page();
    const s = sample();
    render(s);
    const working = s.lanes[0].items.filter((w: Json) => w.state === 'working').slice(0, u);
    assert.equal(working.length, u);
    for (const w of working) {
      w.state = 'reported';
      w.report = { at: 1793560025000, bytes: 900 };
      w.flow = { childBytes: 9000, reportBytes: 900 };
      w.stateRule = 'claude.join.agentId';
    }
    doc.resetOps();
    dom.paint(doc.querySelector('.rows') as unknown as Element, { kids: describePlan(s as any, SHOP, null, null, fmt).slots.list.kids! });
    assert.ok(doc.ops.length <= 8 * u + 2, `u=${u}: ${doc.ops.length} row writes ${JSON.stringify(doc.ops)}`);
    assert.ok(!doc.ops.some((o) => o.kind === 'insertBefore' || o.kind === 'remove'), 'no node is created, moved or removed');
    // The whole page adds the two chips whose numbers moved (在跑, 已回报), the header count and the lane
    // total, plus on the score each changed phrase (at most 8 writes: its state, shape, caption, tie,
    // title and boxes) and each group's sentence: still bounded by u, not by the number of items.
    doc.resetOps();
    render(s);
    assert.ok(doc.ops.length <= 8 * u + 2 + 4 + 8 * u + 2, `u=${u}: ${doc.ops.length} page writes ${JSON.stringify(doc.ops)}`);
  }
});

test('keyed lists keep each node: a reorder moves, a removal removes, nothing is rebuilt', () => {
  const { doc, render } = page();
  const s = sample();
  render(s);
  const before = new Map(doc.querySelectorAll('.shead').map((e) => [e.getAttribute('data-node'), e]));
  s.lanes[0].players.reverse();
  doc.resetOps();
  render(s);
  for (const e of doc.querySelectorAll('.shead')) assert.equal(before.get(e.getAttribute('data-node')), e);
  s.lanes[0].players = s.lanes[0].players.filter((p: Json) => p.label !== 'reviewer');
  s.lanes[0].items = s.lanes[0].items.filter((w: Json) => w.executor !== 'p:d1e75aca758154ee2147');
  doc.resetOps();
  render(s);
  assert.equal(doc.querySelectorAll('.shead').length, 7);
  assert.deepEqual(doc.ops.filter((o) => o.kind === 'insertBefore'), []);
});

// The two running Claude clones of the sample, as if the registry confirmed them.
const VERIFIED = ['p:2c3a4249d77070058649', 'p:394e68839349a156b805'];
const verified = (s: Json) => {
  for (const p of s.lanes[0].players) if (VERIFIED.includes(p.id)) p.live.basis = 'registry';
  return s;
};

test('notes float only off registry-verified running bars, fixed per item, and a poll keeps their node', () => {
  const { doc, render } = page();
  const s = verified(sample());
  render(s);
  const ph = (id: string) => doc.querySelectorAll('.phrase').find((e) => e.getAttribute('data-node') === id)!;
  for (const id of ['w:toolu_t2', 'w:toolu_t5']) {
    const e = ph(id);
    assert.equal(e.getAttribute('data-breathe'), '1');
    assert.equal(e.getAttribute('data-notes'), noteOf(id));
    assert.match(e.getAttribute('data-notes')!, /^[1-4]$/);
    const n = e.querySelector('.notes')!;
    assert.match(n.getAttribute('transform')!, /^translate\(\d+ -?\d+\)$/);
    // Decorative: hidden from assistive tech, no text of its own; the state word stays.
    assert.equal(n.getAttribute('aria-hidden'), 'true');
    assert.equal(n.textContent, '');
    assert.equal(e.querySelector('.ph-st')!.textContent, '在跑');
  }
  // Inferred running (team task on an mtime basis), reported and stub bars get none.
  for (const id of ['w:team:t1', 'w:toolu_t1', 'w:agent-a3']) assert.equal(ph(id).getAttribute('data-notes'), '0', id);
  // No chance in it: a fresh page draws the same drifts.
  const again = page();
  again.render(verified(sample()));
  const drift = (d: FakeDocument) => d.querySelectorAll('.phrase').map((e) => `${e.getAttribute('data-node')}=${e.getAttribute('data-notes')}`);
  assert.deepEqual(drift(again.doc), drift(doc));
  // A poll that changes another bar reuses the running bars' nodes, so their animation runs on.
  const keep = ['w:toolu_t2', 'w:toolu_t5'].map((id) => [ph(id), ph(id).querySelector('.notes')!]);
  const next = verified(sample());
  next.lanes[0].items.find((w: Json) => w.id === 'w:toolu_t1').report.bytes = 2048;
  doc.resetOps();
  render(next);
  assert.ok(doc.ops.length > 0, 'the poll changed something');
  assert.ok(!doc.ops.some((o) => o.kind === 'insertBefore' || o.kind === 'remove'), 'no node is created, moved or removed');
  for (const [i, id] of ['w:toolu_t2', 'w:toolu_t5'].entries()) {
    assert.equal(ph(id), keep[i]![0]);
    assert.equal(ph(id).querySelector('.notes'), keep[i]![1]);
  }
});

test(`notes float on at most NOTES (${NOTES}) bars a page, the first ones drawn`, () => {
  const s = verified(sample());
  const t2 = s.lanes[0].items.find((w: Json) => w.id === 'w:toolu_t2');
  for (let i = 0; i < 8; i++) s.lanes[0].items.push({ ...structuredClone(t2), id: `w:toolu_x${i}` });
  const kids = describeScore(s as any, SHOP, null).systems!.kids!.flatMap((sys) => sys.slots!.phrases!.kids!);
  const live = kids.filter((d) => d.data!.breathe === '1');
  assert.equal(live.length, 10);
  assert.deepEqual(live.map((d) => d.data!.notes !== '0'), live.map((_, i) => i < NOTES));
  for (const d of live.slice(NOTES)) assert.deepEqual(d.slots!.notes, {});
});

test('static text and template text come from STAGE_TEXT, and the score carries its geometry as attributes', () => {
  const { doc, render } = page();
  render(sample());
  assert.equal(doc.querySelector('.sys-codex'), null, 'Codex draws a system of its own only when a lane has Codex players');
  const crit = doc.querySelector('.row')!.querySelector('.chip-crit')!;
  assert.equal(crit.textContent, '验收标准：未声明');
  const lead = doc.querySelectorAll('.shead').find((e) => e.getAttribute('data-node') === 'p:fbeae7c18667b6987518')!;
  assert.match(lead.querySelector('.hit')!.getAttribute('transform')!, /^translate\(0 \d+\) scale\(\d+ \d+\)$/);
  assert.match(lead.querySelector('.h-name')!.getAttribute('x')!, /^\d+$/);
  assert.equal(lead.querySelector('.h-tag')!.textContent, 'Claude 主会话，在等你');
  assert.ok(!lead.querySelector('.h-name')!.textContent.startsWith('shop'), 'the head names the player, not the project');
  // Every instrument slot holds the same five glyphs; CSS shows the one its data-instr names.
  const glyphs = (e: FakeElement) => e.querySelector('.ins')!.children.map((c) => c.getAttribute('class'));
  assert.deepEqual(glyphs(lead), ['g-woodwind', 'g-strings', 'g-percussion', 'g-brass', 'g-unknown']);
  assert.deepEqual(glyphs(doc.querySelector('.desk')!), glyphs(lead));
  assert.equal(lead.getAttribute('data-instr'), 'percussion');
  assert.equal(lead.getAttribute('tabindex'), '0', 'every staff head is focusable');
  assert.match(lead.querySelector('title')!.textContent, /^shop · 重构结账流程/);
  assert.deepEqual(doc.querySelectorAll('.ferm').map((e) => e.getAttribute('data-node')), ['p:fbeae7c18667b6987518']);
  const badge = doc.querySelector('.ferm')!;
  assert.equal(badge.getAttribute('tabindex'), '0', 'the 等你 badge is focusable');
  assert.equal(badge.querySelector('.badge-t')!.textContent, '等你：批准一个操作');
  assert.match(badge.querySelector('.badge-bg')!.getAttribute('width')!, /^\d+$/);
  assert.deepEqual(doc.querySelector('.ord')!.textContent, '第 1 次派活');
  const music = doc.querySelector('.system')!.querySelector('.music')!;
  assert.match(music.getAttribute('viewBox')!, /^0 0 \d+ \d+$/);
  const t1 = doc.querySelectorAll('.phrase').find((e) => e.getAttribute('data-node') === 'w:toolu_t1')!;
  assert.equal(t1.getAttribute('tabindex'), '0', 'every phrase is focusable');
  assert.equal(t1.querySelector('.ph-cap')!.textContent, '读 48k → 回报 1.2k');
  assert.match(t1.querySelector('.slur')!.getAttribute('transform')!, /^translate\(\d+ \d+\) scale\(\d+ -?\d+\)$/);
  const pressed = doc.querySelectorAll('.chip').map((c) => c.getAttribute('aria-pressed'));
  assert.deepEqual(pressed, ['false', 'false', 'false', 'false']);
});

test('markup parsing throws in the fake DOM, and the patcher refuses any attribute off its list', () => {
  const { doc, dom } = page();
  const el = doc.createElement('p');
  assert.throws(() => { (el as any).innerHTML = '<b>x</b>'; }, /innerHTML/);
  assert.throws(() => (el as any).outerHTML, /outerHTML/);
  assert.throws(() => el.insertAdjacentHTML(), /insertAdjacentHTML/);
  for (const bad of ['href', 'style', 'onclick', 'src', 'xlink:href']) {
    assert.throws(() => dom.paint(el as unknown as Element, { attr: { [bad]: 'x' } }), /not on the patcher's list/, bad);
  }
  assert.deepEqual([...ATTRS], ['transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'viewBox', 'aria-pressed', 'aria-current']);
  assert.ok(Object.isFrozen(ATTRS));
  assert.throws(() => dom.paint(el as unknown as Element, { slots: { nope: { text: 'x' } } }), /no slot nope/);
});

test('the drawer opens modal for a node and closes when the route drops it', () => {
  const { doc, render } = page();
  const s = sample();
  render(s, null, 'p:fbeae7c18667b6987518', true);
  const dlg = doc.getElementById('drawer')!;
  assert.equal(dlg.open, true);
  assert.equal(doc.getElementById('dr-title')!.textContent, 'shop · 重构结账流程 (checkout refactor)');
  render(s, null, 'p:fbeae7c18667b6987518', false);
  assert.equal(dlg.open, false);
});

test('the selection reaches assistive tech: aria-current on the selected row, desk, phrase or staff head, and nowhere else', () => {
  const { doc, render } = page();
  const s = sample();
  const current = (sel: string) => doc.querySelectorAll(sel).filter((e) => e.getAttribute('aria-current') === 'true');
  const desks = () => doc.querySelectorAll('.desk').map((d) => d.querySelector('.open')!).filter((e) => e.getAttribute('aria-current') === 'true');
  render(s, null, 'w:toolu_t1');
  const ex = s.lanes[0].items.find((w: Json) => w.id === 'w:toolu_t1').executor;
  const rows = doc.querySelectorAll('.row').filter((r) => r.getAttribute('data-sel') === '1');
  assert.ok(rows.length > 0);
  for (const r of doc.querySelectorAll('.row')) {
    assert.equal(r.querySelector('.open')!.getAttribute('aria-current'), r.getAttribute('data-sel') === '1' ? 'true' : 'false', 'the row button says what the gold rule shows');
  }
  assert.ok(ex !== null);
  assert.deepEqual(current('.phrase').map((e) => e.getAttribute('data-node')), ['w:toolu_t1'], 'the score marks the same item');
  assert.deepEqual(current('.shead'), [], 'an item selected is not its executor selected');
  assert.equal(doc.querySelectorAll('.desk').length, 2);
  assert.deepEqual(desks(), []);
  const lead = 'p:fbeae7c18667b6987518';
  render(s, null, lead);
  assert.deepEqual(desks().map((e) => e.textContent), [s.lanes[0].players.find((p: Json) => p.id === lead).label]);
  assert.deepEqual(current('.shead').map((e) => e.getAttribute('data-node')), [lead]);
  assert.deepEqual(current('.phrase'), []);
  render(s, null, null);
  assert.deepEqual([...current('.open'), ...current('.shead'), ...current('.phrase')], [], 'clearing the selection clears every aria-current');
});
