import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml, type FakeDocument, type FakeElement } from '../helpers/fake-dom.ts';
import { makePatcher } from '../../ui/dom.js';
import { pathOf } from '../../ui/tree.js';
import { EVENTS_SHOWN, describeDetail, describeDock, describePins, fmtAge, fmtLeft, srcText, t } from '../../ui/view.js';
import { describeRail } from '../../ui/wings.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { ownedProject, towerFromStage } from '../../src/sources/tower.ts';
import { busyStage } from '../helpers/tower-fixture.ts';

// ui/dom.js patches the real ui/home.html (its templates, parsed by test/helpers/fake-dom.ts) with the shared
// descriptors of ui/view.js and the left list of ui/wings.js, the way ui/home.js renders (orchestra app plan §5).
// Moved here from the old tower page's test (2026-11-08) with what the page still draws: 「等你」, a worker's
// detail, the composer's recipient. Two samples: the golden tower (the stage fixture: the demo data) and the
// busy synthetic tower. Rendering at all proves every slot a descriptor names is in its template; a second
// identical render writes nothing, and a poll patches by node id.

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/home.html', import.meta.url)), 'utf8');
const GOLDEN = fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url));
type Json = Record<string, any>;
const golden = (): Json => JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Json;
const busy = (): Json => JSON.parse(JSON.stringify(towerFromStage(busyStage()))) as Json;
const nodes = (s: Json): Json[] => s.projects.flatMap((p: Json) => p.nodes);

function page() {
  const doc = parseHtml(HTML);
  const dom = makePatcher(doc as unknown as Document);
  dom.fillStatic();
  const ui = { sel: null as string | null, detail: null as any };
  const render = (s: Json) => {
    const snap = s as any;
    const wall = snap.meta.observedAt;
    dom.paintId('pins', describePins(snap, { sel: ui.sel, nowWall: wall }));
    dom.paintId('rail', describeRail(snap, { sel: ui.sel, roOpen: true }));
    dom.paintId('detail', describeDetail(snap, ui.sel, ui.detail, { nowWall: wall, fmtIso: (x: string) => x.slice(11, 19) }));
    dom.paintId('dock', describeDock(snap, ui.sel));
  };
  const rows = () => (doc.getElementById('rail')!.querySelector('[data-slot=ro]') as FakeElement).children;
  return { doc, dom, ui, render, rows };
}

const slotText = (el: FakeElement, name: string) => el.querySelector(`[data-slot=${name}]`)!.textContent;
const facts = (d: FakeElement | null) => Object.fromEntries(d!.querySelectorAll('.kv').map((kv) => [kv.querySelector('dt')!.textContent, kv.querySelector('dd')!.textContent]));

test('the golden tower renders through the real templates, and an identical render writes nothing', () => {
  const { doc, ui, render, rows } = page();
  const s = golden();
  ui.sel = nodes(s).find((n) => n.state === 'unknown')!.id;
  render(s);
  assert.equal(rows().length, 3, 'the three agents of the golden tower, one row each');
  assert.equal(doc.getElementById('pins')!.querySelectorAll('.pin').length, 2);
  assert.equal(doc.getElementById('detail')!.getAttribute('data-mode'), 'node');
  doc.resetOps();
  render(s);
  assert.deepEqual(doc.ops, []);
});

test('a poll patches rows by node id: changed text writes only that row, a reorder moves nodes, nothing is rebuilt', () => {
  const { doc, render, rows } = page();
  const s = golden();
  render(s);
  const keyOf = (e: FakeElement) => e.querySelector('.rr')!.getAttribute('data-node');
  const before = new Map(rows().map((e) => [keyOf(e), e]));
  const n = nodes(s).find((x) => x.parent === null && x.state === 'running')!;
  n.activity = 'synthetic new activity';
  doc.resetOps();
  render(s);
  assert.ok(doc.ops.length > 0);
  assert.ok(doc.ops.every((o) => o.kind === 'textContent' || o.kind === 'setAttribute'), doc.ops.map((o) => o.kind).join());
  const row = rows().find((e) => keyOf(e) === n.id)!;
  assert.equal(slotText(row, 'l2'), 'shop · synthetic new activity');
  // Roots in another order: the same elements, moved; none created or removed.
  const p = s.projects[0];
  const roots = p.nodes.filter((x: Json) => x.parent === null);
  const subtree = (r: Json) => p.nodes.filter((x: Json) => x === r || x.parent === r.id || p.nodes.some((y: Json) => y.parent === r.id && x.parent === y.id));
  p.nodes = roots.reverse().flatMap(subtree);
  doc.resetOps();
  render(s);
  for (const e of rows()) assert.equal(before.get(keyOf(e)), e);
  assert.ok(!doc.ops.some((o) => o.kind === 'remove'), 'nothing removed');
  assert.ok(doc.ops.filter((o) => o.kind === 'insertBefore').length > 0, 'moved');
});

test('the waiting bar: one entry per waiting node with its path from 你, the source said, and no button but the way to it', () => {
  const { doc, render } = page();
  const s = golden();
  render(s);
  const pins = doc.getElementById('pins')!;
  assert.equal(pins.getAttribute('data-hide'), '0');
  const list = pins.querySelectorAll('.pin');
  assert.equal(list.length, s.waitingBar.length);
  assert.equal(list.length, s.tally.waiting);
  // Read only: nothing to approve, deny or answer here; each entry is one button that opens its node.
  const buttons = pins.querySelectorAll('button');
  assert.equal(buttons.length, list.length);
  assert.ok(buttons.every((b) => b.getAttribute('class') === 'pin-go' && b.getAttribute('type') === 'button'));
  assert.ok(list.every((li) => li.getAttribute('tabindex') === null), 'the button takes the focus, not the item');
  const [native, inferred] = list;
  assert.equal(native!.getAttribute('data-src'), 'native');
  assert.equal(slotText(native!, 'kind'), TOWER_TEXT['wait.approval']);
  assert.equal(slotText(native!, 'clock'), t('wait.native', { h: 'Claude' }));
  assert.equal(slotText(native!, 'hint'), t('wait.goNative', { h: 'Claude' }));
  assert.equal(slotText(native!, 'path'), [TOWER_TEXT['pin.you'], ...pathOf(s as any, native!.getAttribute('data-node')!)].join(TOWER_TEXT['sep.path']));
  assert.ok(slotText(native!, 'path').startsWith(`${TOWER_TEXT['pin.you']}${TOWER_TEXT['sep.path']}shop${TOWER_TEXT['sep.path']}`));
  assert.equal(inferred!.getAttribute('data-src'), 'inferred');
  assert.equal(slotText(inferred!, 'kind'), TOWER_TEXT['wait.inferred']);
  assert.equal(slotText(inferred!, 'clock'), '', 'a guess has no clock of ours');
  assert.equal(slotText(inferred!, 'hint'), t('wait.goNativeGuess', { h: 'Codex' }));
  // Nothing waits: the bar is not drawn.
  const quiet = busy();
  for (const n of nodes(quiet)) if (n.waiting !== null) { n.waiting = null; n.state = 'running'; }
  quiet.waitingBar = [];
  render(quiet);
  assert.equal(pins.getAttribute('data-hide'), '1');
});

test("the waiting bar: ctx.extra's data lands on the pin (a tainted session's red bar, r4 §8.5), its slots fill the template", () => {
  const { doc, dom } = page();
  const s = golden();
  const first = s.waitingBar[0].node;
  const extra = (e: Json) => (e.node === first ? { data: { tainted: '1' }, hint: { text: TOWER_TEXT['appr.tainted'] } } : {});
  dom.paintId('pins', describePins(s as any, { sel: null, nowWall: s.meta.observedAt, extra }));
  const [one, two] = doc.getElementById('pins')!.querySelectorAll('.pin');
  assert.deepEqual([one!.getAttribute('data-tainted'), one!.getAttribute('data-node')], ['1', first], 'the pin keeps its own data next to the extra');
  assert.equal(slotText(one!, 'hint'), TOWER_TEXT['appr.tainted']);
  assert.equal(two!.getAttribute('data-tainted'), null);
  const css = fs.readFileSync(fileURLToPath(new URL('../../ui/home.css', import.meta.url)), 'utf8');
  assert.match(css, /\.pin\[data-tainted="1"\] \{ border-left-color: var\(--taint\); \}/);
});

test('an Orchestra wait counts down against the daemon time: 剩 m:ss 自动拒', () => {
  const { doc, render } = page();
  const s = golden();
  const claude = nodes(s).find((n) => n.harness === 'claude' && n.layer === 'agent')!;
  claude.ownership = 'owned';
  claude.waiting = { kind: 'approval', source: 'orchestra', deadline: s.meta.observedAt + 27 * 60_000 + 40_000 };
  s.waitingBar = [{ node: claude.id, ...claude.waiting }, ...s.waitingBar.filter((e: Json) => e.node !== claude.id)];
  render(s);
  const pin = doc.querySelectorAll('.pin')[0]!;
  assert.equal(slotText(pin, 'clock'), t('wait.left', { t: '27:40' }));
  assert.equal(slotText(pin, 'hint'), '');
  assert.equal(fmtLeft(-5), '0:00');
  assert.equal(fmtLeft(3_725_000), '1:02:05');
});

test('an owned session\'s sub-agent in the detail: no session of its own, how long it took or that nobody knows, its model', () => {
  const { doc, ui, render } = page();
  const s = golden();
  const ownedId = 'a'.repeat(20);
  const m = (n: number, over: Record<string, unknown> = {}) => ({ threadId: `t${n}`, name: `/root/m${n}`, model: null, agentType: null, state: 'returned' as const, why: null, startedAt: 1_000, endedAt: 66_000, lastAt: 66_000, failed: 0, ranUnasked: 0, asking: null, ...over });
  const mine = ownedProject([{ ownedId, harness: 'codex', title: 'a session', state: 'idle', endReason: null, waiting: null, lastAt: 1, members: [m(1), m(2), m(3, { state: 'running', endedAt: null, startedAt: null })], membersOver: 0 }], 100_000)!;
  s.projects.unshift(structuredClone(mine) as any);
  ui.sel = mine.nodes[1]!.id;
  render(s);
  const running = facts(doc.getElementById('detail'));
  assert.equal(running[TOWER_TEXT['detail.took']], TOWER_TEXT['detail.noTook']);
  assert.equal(running[TOWER_TEXT['detail.session']], TOWER_TEXT['detail.ownedMember']);
  assert.equal(running[TOWER_TEXT['detail.owner']], TOWER_TEXT['own.ownedMemberLong']);
  assert.equal(running[TOWER_TEXT['detail.model']], TOWER_TEXT['detail.noModel'], 'not said: unknown (T1)');
  ui.sel = mine.nodes[2]!.id;
  render(s);
  assert.equal(facts(doc.getElementById('detail'))[TOWER_TEXT['detail.took']], TOWER_TEXT['age.m'].replace('{n}', '1'));
  s.projects[0]!.nodes[2]!.model = 'codex/gpt-6.1-sol';
  render(s);
  assert.equal(facts(doc.getElementById('detail'))[TOWER_TEXT['detail.model']], 'codex/gpt-6.1-sol');
  // The session itself has no file of its own either, and says so.
  ui.sel = `n:${ownedId}`;
  render(s);
  assert.equal(facts(doc.getElementById('detail'))[TOWER_TEXT['detail.session']], TOWER_TEXT['detail.ownedSession']);
  // Only a member has the row: a read-only subagent says nothing of a model.
  ui.sel = nodes(s).find((n) => n.ownership === 'observed' && n.layer === 'subagent')!.id;
  render(s);
  assert.equal(TOWER_TEXT['detail.model'] in facts(doc.getElementById('detail')), false);
});

test('detail: a node shows its fields and basis, unknown said as unknown, its last events newest first', () => {
  const { doc, ui, render } = page();
  const s = golden();
  const unk = nodes(s).find((n) => n.state === 'unknown')!;
  ui.sel = unk.id;
  render(s);
  const d = doc.getElementById('detail')!;
  assert.equal(d.getAttribute('data-mode'), 'node');
  assert.equal(slotText(d, 'title'), unk.title);
  const f = facts(d);
  assert.equal(f[TOWER_TEXT['detail.state']], TOWER_TEXT['state.unknown']);
  assert.equal(f[TOWER_TEXT['detail.basis']], TOWER_TEXT['basis.none']);
  assert.equal(f[TOWER_TEXT['detail.type']], 'Explore');
  assert.equal(f[TOWER_TEXT['detail.session']], unk.session);
  assert.equal(slotText(d, 'evNote'), TOWER_TEXT['detail.loading']);
  // The dock names the same node.
  assert.equal(doc.querySelector('.dock-to')!.textContent, t('dock.to', { who: unk.title }));
  // The session's events arrive: the last EVENTS_SHOWN, newest first, with the note.
  const events = Array.from({ length: 15 }, (_, i) => ({ at: `2026-11-02T10:00:${String(i).padStart(2, '0')}.000Z`, type: 'assistant', text: `synthetic line ${i}` }));
  ui.detail = { id: unk.session, body: { session: { id: unk.session }, events, unparsed: 2, note: 'tail-only' } };
  render(s);
  const ev = d.querySelectorAll('.ev');
  assert.equal(ev.length, EVENTS_SHOWN);
  assert.equal(ev[0]!.querySelector('[data-slot=tx]')!.textContent, 'synthetic line 14');
  assert.equal(ev[0]!.querySelector('[data-slot=at]')!.textContent, '10:00:14');
  assert.equal(slotText(d, 'evNote'), [t('detail.lastN', { n: EVENTS_SHOWN }), TOWER_TEXT['note.tail-only'], t('detail.unparsed', { n: 2 })].join(TOWER_TEXT['sep.notes']));
  // A read that failed says why in words where the code is known (T1): no answer within the page's 4 s
  // is not "can't connect", and neither is "no such file"; another code shows as it came.
  for (const [code, text] of [
    ['not-found', TOWER_TEXT['detail.err.not-found']],
    ['timeout', t('detail.err.timeout', { s: 4 })],
    ['network', TOWER_TEXT['detail.err.network']],
    ['http-500', t('detail.err', { code: 'http-500' })],
  ]) {
    ui.detail = { id: unk.session, body: { error: code } };
    render(s);
    assert.equal(slotText(d, 'evNote'), text, code);
    assert.equal(d.querySelectorAll('.ev').length, 0);
  }
  assert.notEqual(TOWER_TEXT['detail.err.timeout'], TOWER_TEXT['detail.err.network']);
  assert.match(t('detail.err.timeout', { s: 4 }), /4 秒内没有回复/);
  // Once the page stops reading again on its own (ui/drive.js, DETAIL_RETRIES), the body carries how many
  // reads in a row got no answer, and the note says it waits for new data instead of "in a few seconds".
  for (const [code, text] of [
    ['timeout', t('detail.err.timeout.last', { s: 4, n: 4 })],
    ['network', t('detail.err.network.last', { n: 4 })],
  ]) {
    ui.detail = { id: unk.session, body: { error: code, reads: 4 } };
    render(s);
    assert.equal(slotText(d, 'evNote'), text, code);
    assert.match(text, /连续 4 次没读到，不再定时重读/);
  }
  // Nothing selected: the hint, and the dock says to pick one first.
  ui.sel = null;
  render(s);
  assert.equal(d.getAttribute('data-mode'), 'empty');
  assert.equal(slotText(d, 'empty'), TOWER_TEXT['detail.empty']);
  assert.equal(doc.querySelector('.dock-to')!.textContent, TOWER_TEXT['dock.none']);
});

test('a source\'s sentence: clipped is never empty (T1); a duration not known is the dash, never 0', () => {
  const s = busy();
  // busy: DSH holds 7 sessions none of which shows: clipped, never empty.
  assert.equal(srcText(s as any, 'dsh'), t('src.clipped', { h: 'DSH', total: 7, unit: TOWER_TEXT['unit.dsh'], shown: 0 }));
  s.meta.sources.codex = { ...s.meta.sources.codex, state: 'error', error: 'read-denied' };
  assert.equal(srcText(s as any, 'codex'), t('src.error', { h: 'Codex', code: 'read-denied' }));
  assert.equal(fmtAge(null), TOWER_TEXT.dash);
  assert.equal(fmtAge(-1), TOWER_TEXT.dash);
  assert.equal(fmtAge(3 * 86_400_000), t('age.d', { n: 3 }));
});

test('nothing on the rendered page says done (T2), whatever the sample or selection', () => {
  for (const make of [golden, busy]) {
    const s = make();
    const { doc, ui, render } = page();
    for (const n of [null, ...nodes(s).map((x) => x.id)]) {
      ui.sel = n;
      render(s);
      const all = (doc as FakeDocument).textContent + doc.title;
      assert.equal(all.includes('完成'), false);
    }
  }
});
