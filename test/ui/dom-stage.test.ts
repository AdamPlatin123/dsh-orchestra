import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml, type FakeDocument, type FakeElement } from '../helpers/fake-dom.ts';
import { ATTRS, makePatcher } from '../../ui/dom.js';
import { describeDrawer, describeHeader, describePlan, describeStage } from '../../ui/view.js';
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
    dom.paintId('stage', { slots: describeStage(s as any, SHOP, sel) });
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
  const players = doc.querySelectorAll('.player');
  assert.equal(players.length, 8);
  assert.equal(doc.querySelectorAll('.row').length, 6);
  assert.equal(doc.querySelectorAll('.desk').length, 2);
  assert.equal(doc.querySelectorAll('.rule').length, 13);
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
    // The whole page adds only the two chips whose numbers moved (在跑, 已回报), the header count and the lane total.
    doc.resetOps();
    render(s);
    assert.ok(doc.ops.length <= 8 * u + 2 + 4, `u=${u}: ${doc.ops.length} page writes ${JSON.stringify(doc.ops)}`);
  }
});

test('keyed lists keep each node: a reorder moves, a removal removes, nothing is rebuilt', () => {
  const { doc, render } = page();
  const s = sample();
  render(s);
  const before = new Map(doc.querySelectorAll('.player').map((e) => [e.getAttribute('data-node'), e]));
  s.lanes[0].players.reverse();
  doc.resetOps();
  render(s);
  for (const e of doc.querySelectorAll('.player')) assert.equal(before.get(e.getAttribute('data-node')), e);
  s.lanes[0].players = s.lanes[0].players.filter((p: Json) => p.label !== 'reviewer');
  s.lanes[0].items = s.lanes[0].items.filter((w: Json) => w.executor !== 'p:d1e75aca758154ee2147');
  doc.resetOps();
  render(s);
  assert.equal(doc.querySelectorAll('.player').length, 7);
  assert.deepEqual(doc.ops.filter((o) => o.kind === 'insertBefore'), []);
});

test('static text and template text come from STAGE_TEXT, and the seats carry their geometry as attributes', () => {
  const { doc, render } = page();
  render(sample());
  const codex = doc.querySelector('.sec-codex')!;
  assert.equal(codex.textContent, STAGE_TEXT['sec.codex']);
  const crit = doc.querySelector('.row')!.querySelector('.chip-crit')!;
  assert.equal(crit.textContent, '验收标准：未声明');
  const lead = doc.querySelectorAll('.player').find((e) => e.getAttribute('data-node') === 'p:fbeae7c18667b6987518')!;
  assert.match(lead.getAttribute('transform')!, /^translate\(\d+(?:\.\d+)? \d+(?:\.\d+)?\)$/);
  assert.match(lead.querySelector('.body')!.getAttribute('transform')!, /^scale\(\d(?:\.\d+)?\)$/, 'the figure scales; its nameplate keeps its size');
  assert.equal(lead.querySelector('.tag')!.textContent, 'Claude 主奏');
  assert.ok(!lead.querySelector('.name')!.textContent.startsWith('shop'), 'the nameplate names the player, not the project');
  assert.equal(lead.querySelector('.fig')!.children.length, doc.querySelector('.desk')!.querySelector('.fig')!.children.length, 'every figure is a copy of the seat figure');
  assert.equal(lead.getAttribute('data-fermata'), '1');
  assert.equal(lead.getAttribute('tabindex'), '0', 'every seat is focusable');
  assert.match(lead.querySelector('title')!.textContent, /^shop · 重构结账流程/);
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
  assert.deepEqual([...ATTRS], ['transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'aria-pressed']);
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
