import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml, type FakeDocument, type FakeElement } from '../helpers/fake-dom.ts';
import { makePatcher } from '../../ui/dom.js';
import { buildRows, freeze, groupKey, matched, navigate, pathOf, projectKey, type Row } from '../../ui/tree.js';
import { EVENTS_SHOWN, describeAbout, describeBar, describeDetail, describeDock, describePins, describeTower, clippedSessions, detectsError, fmtAge, fmtLeft, groupText, srcText, t } from '../../ui/view.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { ownedProject, towerFromStage } from '../../src/sources/tower.ts';
import { busyStage, nid } from '../helpers/tower-fixture.ts';

// ui/dom.js patches the real ui/tower.html (its templates, parsed by test/helpers/fake-dom.ts) with the
// descriptors of ui/view.js over the rows of ui/tree.js, the way ui/app.js renders (orchestra app plan
// §5). Two samples: the golden tower (the stage fixture: the demo data) and the busy synthetic tower
// with every kind of folded group. Rendering at all proves every slot a descriptor names is in its
// template. A second identical render writes nothing, a poll patches by node id, and every count in the
// top bar is the number of rows its filter shows (T3).

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/tower.html', import.meta.url)), 'utf8');
const GOLDEN = fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url));
type Json = Record<string, any>;
const golden = (): Json => JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Json;
const busy = (): Json => JSON.parse(JSON.stringify(towerFromStage(busyStage()))) as Json;
const nodes = (s: Json): Json[] => s.projects.flatMap((p: Json) => p.nodes);
const byTitle = (s: Json, title: string): Json => nodes(s).find((n) => n.title === title)!;

type Ui = {
  filter: 'waiting' | 'error' | 'running' | null; collapsed: Set<string>; open: Set<string>; peek: Set<string>;
  sel: string | null; flash: Map<string, string>; held: Row[] | null; frozen: boolean; detail: any; view: string;
};

function page() {
  const doc = parseHtml(HTML);
  const dom = makePatcher(doc as unknown as Document);
  dom.fillStatic();
  const ui: Ui = { filter: null, collapsed: new Set(), open: new Set(), peek: new Set(), sel: null, flash: new Map(), held: null, frozen: false, detail: null, view: 'tower' };
  let pending = 0;
  const render = (s: Json): Row[] => {
    const snap = s as any;
    dom.paintId('bar', describeBar(snap, { filter: ui.filter, ageMs: 2000, stale: false, theme: 'auto', view: ui.view }));
    const fresh = buildRows(snap, ui);
    let rows = fresh;
    pending = 0;
    if (ui.frozen && ui.held !== null) ({ rows, pending } = freeze(fresh, ui.held));
    ui.held = ui.frozen ? rows : null;
    const wall = snap.meta.observedAt;
    dom.paintId('pins', describePins(snap, { sel: ui.sel, nowWall: wall }));
    dom.paintId('tower', describeTower(rows, { filter: ui.filter, pending, sel: ui.sel, peek: ui.peek, flash: ui.flash, detectsError: detectsError(snap), clipped: clippedSessions(snap) }));
    dom.paintId('detail', describeDetail(snap, ui.sel, rows, ui.detail, { nowWall: wall, fmtIso: (x: string) => x.slice(11, 19) }));
    dom.paintId('dock', describeDock(snap, ui.sel));
    dom.paintId('about', describeAbout(snap));
    return rows;
  };
  const items = () => (doc.getElementById('tree') as FakeElement).children;
  const item = (key: string) => items().find((e) => e.getAttribute('data-key') === key);
  return { doc, dom, ui, render, items, item, pending: () => pending };
}

const slotText = (el: FakeElement, name: string) => el.querySelector(`[data-slot=${name}]`)!.textContent;

test('the golden tower renders through the real templates as an ARIA tree, and an identical render writes nothing', () => {
  const { doc, render, items } = page();
  const s = golden();
  render(s);
  const rows = items();
  assert.equal(rows.length, 1 + 11, 'the project and its 11 nodes: no group folds in the golden tower');
  for (const r of rows) {
    assert.equal(r.getAttribute('role'), 'treeitem');
    assert.match(r.getAttribute('aria-level')!, /^[1-6]$/);
    assert.match(r.getAttribute('aria-setsize')!, /^\d+$/);
    assert.match(r.getAttribute('aria-posinset')!, /^\d+$/);
    assert.ok(['true', 'false'].includes(r.getAttribute('aria-selected')!));
  }
  assert.equal(rows.filter((r) => r.getAttribute('tabindex') === '0').length, 1, 'one roving tab stop');
  // Exactly the rows with children say whether they are open.
  const withKids = new Set(nodes(s).filter((n) => n.counts.children > 0).map((n) => n.id));
  for (const r of rows.slice(1)) assert.equal(r.hasAttribute('aria-expanded'), withKids.has(r.getAttribute('data-key')), r.getAttribute('data-key')!);
  // Depth shows as the level: project 1, agents 2, their subagents 3 and down.
  for (const n of nodes(s)) assert.equal(rows.find((r) => r.getAttribute('data-key') === n.id)!.getAttribute('aria-level'), String(n.depth + 2));
  // The harness colours the bar of each node row; Claude, DSH and Codex are all there.
  assert.deepEqual([...new Set(rows.slice(1).map((r) => r.getAttribute('data-harness')))].sort(), ['claude', 'codex', 'dsh']);
  doc.resetOps();
  render(s);
  assert.deepEqual(doc.ops, []);
});

test('a row says state, ≈ for a guess, activity, the subtree box, age and ownership in one format', () => {
  const { render, item } = page();
  const s = golden();
  render(s);
  const lead = byTitle(s, 'shop');
  const claude = nodes(s).find((n) => n.harness === 'claude' && n.layer === 'agent')!;
  const row = item(claude.id)!;
  assert.equal(slotText(row, 'ico'), TOWER_TEXT['icon.approval']);
  assert.equal(slotText(row, 'approx'), '', 'a registry state is no guess');
  assert.equal(slotText(row, 'act'), `${TOWER_TEXT['wait.approval']} · permission prompt`);
  assert.equal(slotText(row, 'kc'), String(claude.counts.children));
  assert.equal(slotText(row, 'own'), TOWER_TEXT['own.observed']);
  assert.equal(slotText(row, 'age'), t('age.s', { n: 0 }));
  // A Codex wait read off an unanswered call is a guess: ≈, and no tool name in the line.
  const codex = nodes(s).find((n) => n.harness === 'codex' && n.layer === 'agent')!;
  assert.equal(codex.waiting.source, 'inferred');
  const crow = item(codex.id)!;
  assert.equal(slotText(crow, 'approx'), TOWER_TEXT['mark.inferred']);
  assert.equal(slotText(crow, 'act'), TOWER_TEXT['wait.inferred']);
  assert.equal(slotText(crow, 'srState'), `${TOWER_TEXT['state.waiting']}${TOWER_TEXT['mark.inferredSr']}`);
  // Unknown is said as unknown, never as idle or running (T1).
  const unk = nodes(s).find((n) => n.state === 'unknown')!;
  assert.equal(slotText(item(unk.id)!, 'act'), TOWER_TEXT['state.unknown']);
  assert.equal(slotText(item(unk.id)!, 'ico'), TOWER_TEXT['icon.unknown']);
  assert.ok(lead !== undefined);
  // The subtree box read aloud: no error count while nothing reads failures (meta.detects.error false).
  assert.equal(slotText(row, 'kidsSr'), t('kids.srNoErr', { c: claude.counts.children, w: claude.counts.waiting }));
  // A project row says aloud what its box shows: how many of its nodes wait on you.
  const proj = item(`p:${s.projects[0].id}`)!;
  const waiting = s.projects[0].nodes.filter((n: Json) => n.state === 'waiting').length;
  assert.ok(waiting > 0);
  assert.equal(slotText(proj, 'kw'), t('kids.wait', { n: waiting }));
  assert.equal(slotText(proj, 'kidsSr'), t('project.sr', { parts: t('kids.srWait', { n: waiting }) }));
});

test('the tree says how many sessions the limits left out; the dock says why a project or a group cannot be a recipient', () => {
  const { doc, ui, render } = page();
  const g = golden();
  let rows = render(g);
  assert.equal(doc.querySelector('[data-slot=clipNote]')!.getAttribute('data-hide'), '1');
  const s = busy();
  rows = render(s);
  const note = doc.querySelector('[data-slot=clipNote]')!;
  assert.equal(note.getAttribute('data-hide'), '0');
  assert.equal(note.textContent, t('tree.clipped', { n: 7 }));
  ui.sel = rows.find((r) => r.kind === 'project')!.key;
  render(s);
  assert.equal(doc.querySelector('.dock-to')!.textContent, TOWER_TEXT['dock.notNode']);
  ui.sel = rows.find((r) => r.kind === 'group')!.key;
  render(s);
  assert.equal(doc.querySelector('.dock-to')!.textContent, TOWER_TEXT['dock.notNode']);
  // A project's detail counts no failures while nothing reads them.
  ui.sel = rows.find((r) => r.kind === 'project')!.key;
  render(s);
  assert.equal(slotText(doc.getElementById('detail')!, 'empty'), t('detail.countsNoErr', { r: 2, w: 1 }));
});

test('under a filter every signpost stays open and says so: no fold offered, left climbs to the parent', () => {
  const s = busy() as any;
  const rows = buildRows(s, { filter: 'waiting', collapsed: new Set(), open: new Set() });
  const lead = rows.findIndex((r) => r.key === nid('cx'));
  assert.ok(lead >= 0);
  assert.deepEqual([rows[lead]!.expandable, rows[lead]!.expanded], [false, true]);
  assert.ok(rows.every((r) => !r.expandable), 'nothing folds under a filter');
  assert.deepEqual(navigate(rows, lead, 'ArrowLeft'), { select: rows.findIndex((r) => r.kind === 'project' && r.project.id === rows[lead]!.project.id) });
  assert.deepEqual(navigate(rows, lead, 'ArrowRight'), { select: lead + 1 });
  const { doc, ui, render } = page();
  ui.filter = 'waiting';
  render(s);
  for (const li of (doc.getElementById('tree') as FakeElement).children) {
    assert.equal(li.getAttribute('aria-expanded'), null, li.getAttribute('data-key')!);
    assert.equal(li.getAttribute('data-open'), '');
  }
});

test('a poll patches rows by node id: changed text writes only that row, a reorder moves nodes, nothing is rebuilt', () => {
  const { doc, render, items, item } = page();
  const s = golden();
  render(s);
  const before = new Map(items().map((e) => [e.getAttribute('data-key'), e]));
  const n = nodes(s).find((x) => x.state === 'running')!;
  n.activity = 'synthetic new activity';
  n.ageMs = 125_000;
  doc.resetOps();
  render(s);
  assert.deepEqual(doc.ops.map((o) => o.kind).sort(), ['textContent', 'textContent', 'textContent'], 'the line, the age and the peek line');
  assert.equal(slotText(item(n.id)!, 'act'), 'synthetic new activity');
  assert.equal(slotText(item(n.id)!, 'age'), t('age.m', { n: 2 }));
  // Roots in another order: the same elements, moved; none created or removed.
  const p = s.projects[0];
  const roots = p.nodes.filter((x: Json) => x.parent === null);
  const subtree = (r: Json) => p.nodes.filter((x: Json) => x === r || x.parent === r.id || p.nodes.some((y: Json) => y.parent === r.id && x.parent === y.id));
  p.nodes = roots.reverse().flatMap(subtree);
  doc.resetOps();
  render(s);
  for (const e of items()) assert.equal(before.get(e.getAttribute('data-key')), e);
  assert.ok(!doc.ops.some((o) => o.kind === 'remove'), 'nothing removed');
  assert.ok(doc.ops.filter((o) => o.kind === 'insertBefore').length > 0, 'moved');
});

test('folding: groups stand where their first member would and open in place; collapsing keeps every other row', () => {
  const { doc, ui, render, items, item } = page();
  const s = busy();
  let rows = render(s);
  const shop = s.projects.find((p: Json) => p.name === 'shop');
  const lead = nid('lead');
  const groups = rows.filter((r) => r.kind === 'group');
  assert.deepEqual(groups.map((g) => `${g.group!.kind}:${g.group!.count}`).sort(), ['idle:3', 'returned:3', 'same-type:6']);
  // Folded members are not rows until their group opens.
  for (const id of ['ex1', 'gp1', 'idle1'].map(nid)) assert.equal(item(id), undefined);
  const explore = groups.find((g) => g.group!.kind === 'same-type')!;
  assert.equal(explore.key, groupKey(lead, explore.group!));
  // A same-type fold says how its members stand: six Explore subagents nobody placed are six unknown (T1).
  assert.equal(slotText(item(explore.key)!, 'name'), [t('group.same', { label: 'Explore', n: 6 }), t('group.part', { n: 6, s: TOWER_TEXT['state.unknown'] })].join(TOWER_TEXT['sep.parts']));
  const mixed = busy();
  const mixedLead = nodes(mixed).find((n) => n.id === lead)!;
  for (const id of mixedLead.groups[0].ids.slice(0, 2)) { const n = nodes(mixed).find((x) => x.id === id)!; n.state = 'returned'; n.basis = 'log'; }
  assert.equal(groupText(mixedLead.groups[0], nodes(mixed) as any), [t('group.same', { label: 'Explore', n: 6 }), t('group.part', { n: 4, s: TOWER_TEXT['state.unknown'] }), t('group.part', { n: 2, s: TOWER_TEXT['state.returned'] })].join(TOWER_TEXT['sep.parts']));
  assert.equal(item(explore.key)!.getAttribute('aria-expanded'), 'false');
  const kept = new Map(items().map((e) => [e.getAttribute('data-key'), e]));
  ui.open.add(explore.key);
  doc.resetOps();
  rows = render(s);
  const at = rows.findIndex((r) => r.key === explore.key);
  assert.deepEqual(rows.slice(at + 1, at + 7).map((r) => r.key), [1, 2, 3, 4, 5, 6].map((i) => nid(`ex${i}`)), 'the six open right below their group');
  assert.ok(rows.slice(at + 1, at + 7).every((r) => r.level === rows[at]!.level + 1 && r.parentKey === explore.key));
  assert.equal(item(explore.key)!.getAttribute('aria-expanded'), 'true');
  for (const [k, e] of kept) assert.equal(item(k!), e, `${k} kept its element`);
  // Collapsing the lead takes its whole subtree out and leaves every other row as it was.
  const kept2 = new Map(items().map((e) => [e.getAttribute('data-key'), e]));
  ui.collapsed.add(lead);
  rows = render(s);
  const under = new Set(shop.nodes.filter((n: Json) => n.parent !== null).map((n: Json) => n.id));
  assert.ok(rows.every((r) => !under.has(r.key) && !r.key.startsWith(`g:${lead}`)));
  assert.equal(item(lead)!.getAttribute('aria-expanded'), 'false');
  for (const e of items()) assert.equal(kept2.get(e.getAttribute('data-key')), e);
  // And a project folds too.
  ui.collapsed.add(projectKey(shop.id));
  rows = render(s);
  assert.equal(rows.filter((r) => r.project.id === shop.id).length, 1);
});

test('counts are filters: each top-bar count equals the rows its filter marks, ancestors only signpost (T3)', () => {
  for (const make of [golden, busy]) {
    const s = make();
    const { ui, render, doc } = page();
    for (const f of ['waiting', 'error', 'running'] as const) {
      ui.filter = f;
      const rows = render(s);
      const n = s.tally[f];
      assert.equal(matched(rows), n, f);
      assert.equal(doc.querySelectorAll('[data-match=1]').length, n, f);
      const btn = doc.querySelector(`[data-filter=${f}]`)!;
      assert.equal(btn.textContent, t(`count.${f}`, { n }));
      assert.equal(btn.getAttribute('aria-pressed'), 'true');
      // Every row shown either counts or leads to one that does.
      for (const r of rows.filter((x) => x.kind === 'node' && !x.match)) assert.ok(rows.some((m) => m.match && m.level > r.level), r.key);
      assert.equal(rows.filter((r) => r.kind === 'group').length, 0, 'what the filter shows never folds');
      const empty = doc.querySelector('[data-slot=empty]')!;
      assert.equal(empty.getAttribute('data-hide'), n === 0 ? '0' : '1');
    }
  }
});

test('the waiting bar: one entry per waiting node with its path from 你, the source said, and no button', () => {
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
  const css = fs.readFileSync(fileURLToPath(new URL('../../ui/tower.css', import.meta.url)), 'utf8');
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

test('an owned session\'s sub-agents: rows under it, folded like any subagent; a member is no session of its own, and says how long it took or that nobody knows', () => {
  const { doc, ui, render } = page();
  const s = golden();
  const ownedId = 'a'.repeat(20);
  const m = (n: number, over: Record<string, unknown> = {}) => ({ threadId: `t${n}`, name: `/root/m${n}`, model: null, agentType: null, state: 'returned' as const, why: null, startedAt: 1_000, endedAt: 66_000, lastAt: 66_000, failed: 0, ranUnasked: 0, asking: null, ...over });
  const mine = ownedProject([{ ownedId, harness: 'codex', title: 'a session', state: 'idle', endReason: null, waiting: null, lastAt: 1, members: [m(1), m(2), m(3, { state: 'running', endedAt: null, startedAt: null })], membersOver: 0 }], 100_000)!;
  s.projects.unshift(structuredClone(mine) as any);
  ui.sel = mine.nodes[1]!.id;
  render(s);
  const rows = doc.querySelectorAll('[data-kind=node]').map((r) => r.getAttribute('data-key'));
  assert.equal(rows.includes(`n:${ownedId}`), true);
  assert.equal(rows.includes(mine.nodes[1]!.id), true, 'the running one stands as a row');
  assert.equal(rows.includes(mine.nodes[2]!.id), false, 'the returned ones are folded');
  assert.equal(doc.querySelectorAll('[data-kind=group]').some((g) => g.textContent!.includes(TOWER_TEXT['group.returned'].replace('{n}', '2'))), true);
  const facts = (d: FakeElement | null) => Object.fromEntries(d!.querySelectorAll('.kv').map((kv) => [kv.querySelector('dt')!.textContent, kv.querySelector('dd')!.textContent]));
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
  // The peek too: a member's says it has only a state here, never that its conversation is below; its session's says that.
  ui.peek = new Set([`n:${ownedId}`, mine.nodes[1]!.id]);
  render(s);
  const peek = (id: string) => slotText(doc.querySelectorAll('[data-kind=node]').find((r) => r.getAttribute('data-key') === id)!, 'pkSession');
  assert.equal(peek(mine.nodes[1]!.id), TOWER_TEXT['detail.ownedMember']);
  assert.equal(peek(`n:${ownedId}`), TOWER_TEXT['detail.ownedSession']);
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
  const facts = Object.fromEntries(d.querySelectorAll('.kv').map((kv) => [kv.querySelector('dt')!.textContent, kv.querySelector('dd')!.textContent]));
  assert.equal(facts[TOWER_TEXT['detail.state']], TOWER_TEXT['state.unknown']);
  assert.equal(facts[TOWER_TEXT['detail.basis']], TOWER_TEXT['basis.none']);
  assert.equal(facts[TOWER_TEXT['detail.type']], 'Explore');
  assert.equal(facts[TOWER_TEXT['detail.session']], unk.session);
  assert.equal(slotText(d, 'evNote'), TOWER_TEXT['detail.loading']);
  // The selected row and the dock name the same node.
  assert.equal(doc.querySelector('[aria-selected=true]')!.getAttribute('data-key'), unk.id);
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
  // Once the page stops reading again on its own (ui/app.js, DETAIL_RETRIES), the body carries how many
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
  // Nothing selected: the hint, and the dock says to pick a row first.
  ui.sel = null;
  render(s);
  assert.equal(d.getAttribute('data-mode'), 'empty');
  assert.equal(slotText(d, 'empty'), TOWER_TEXT['detail.empty']);
  assert.equal(doc.querySelector('.dock-to')!.textContent, TOWER_TEXT['dock.none']);
});

test('freezing: the order holds, fresh data reaches the rows that stay, and what would appear, go or move is counted', () => {
  const { doc, ui, render, items, item, pending } = page();
  const s = golden();
  ui.frozen = true;
  render(s);
  const order = items().map((e) => e.getAttribute('data-key'));
  // Next poll: the roots in another order, one subagent gone, one activity changed.
  const next = golden();
  const p = next.projects[0];
  const gone = p.nodes.find((n: Json) => n.state === 'returned' && n.harness === 'claude');
  p.nodes = p.nodes.filter((n: Json) => n !== gone);
  const roots = p.nodes.filter((n: Json) => n.parent === null);
  const subtree = (r: Json) => p.nodes.filter((x: Json) => x === r || x.parent === r.id || p.nodes.some((y: Json) => y.parent === r.id && x.parent === y.id));
  p.nodes = roots.reverse().flatMap(subtree);
  const run = p.nodes.find((n: Json) => n.state === 'running');
  run.activity = 'fresh activity while frozen';
  render(next);
  assert.deepEqual(items().map((e) => e.getAttribute('data-key')), order, 'the order held');
  assert.equal(item(gone.id)!.getAttribute('data-gone'), '1');
  assert.equal(slotText(item(run.id)!, 'act'), 'fresh activity while frozen');
  assert.ok(pending() > 0);
  const btn = doc.querySelector('[data-act=apply]')!;
  assert.equal(btn.getAttribute('data-hide'), '0');
  assert.equal(btn.textContent, t('tree.changes', { n: pending() }));
  // Released (the click on ↻, or 5 s after the pointer and focus left): the fresh order shows.
  ui.frozen = false;
  render(next);
  assert.notDeepEqual(items().map((e) => e.getAttribute('data-key')), order);
  assert.equal(item(gone.id), undefined);
  assert.equal(btn.getAttribute('data-hide'), '1');
  const r = freeze([], []);
  assert.deepEqual(r, { rows: [], pending: 0 });
});

test('keyboard: up and down move, right opens then enters, left closes then climbs (tree view pattern)', () => {
  const s = busy() as any;
  const ui = { filter: null, collapsed: new Set<string>(), open: new Set<string>() };
  const rows = buildRows(s, ui);
  const lead = rows.findIndex((r) => r.key === nid('lead'));
  assert.deepEqual(navigate(rows, lead, 'ArrowDown'), { select: lead + 1 });
  assert.deepEqual(navigate(rows, lead, 'ArrowUp'), { select: lead - 1 });
  assert.deepEqual(navigate(rows, lead, 'ArrowLeft'), { toggle: nid('lead'), open: false });
  assert.deepEqual(navigate(rows, lead, 'ArrowRight'), { select: lead + 1 }, 'open: right enters the first child');
  assert.deepEqual(navigate(rows, lead + 1, 'ArrowLeft'), { select: lead }, 'a leaf climbs to its parent');
  const g = rows.findIndex((r) => r.kind === 'group');
  assert.deepEqual(navigate(rows, g, 'ArrowRight'), { toggle: rows[g]!.key, open: true });
  assert.deepEqual(navigate(rows, 0, 'Home'), { select: 0 });
  assert.deepEqual(navigate(rows, 0, 'End'), { select: rows.length - 1 });
  assert.deepEqual(navigate(rows, rows.length - 1, 'ArrowDown'), { select: rows.length - 1 });
  assert.equal(navigate(rows, 0, 'x'), null);
  assert.deepEqual(navigate(rows, 0, 'ArrowLeft'), { toggle: rows[0]!.key, open: false }, 'a project closes');
});

test('the top bar: a source only when it failed, no error count while nothing reads failures, freshness, the test badge', () => {
  const { doc, render } = page();
  const s = busy();
  render(s);
  // Health takes no room (research §1.2): sources that read fine are not in the bar.
  assert.deepEqual(doc.querySelectorAll('.src'), []);
  assert.equal(doc.querySelector('[data-slot=srcBox]')!.getAttribute('data-hide'), '1');
  // busy: DSH holds 7 sessions none of which shows: clipped, never empty (T1), said under the tree.
  assert.equal(srcText(s as any, 'dsh'), t('src.clipped', { h: 'DSH', total: 7, unit: TOWER_TEXT['unit.dsh'], shown: 0 }));
  const failed = busy();
  failed.meta.sources.codex = { ...failed.meta.sources.codex, state: 'error', error: 'read-denied' };
  render(failed);
  const srcs = doc.querySelectorAll('.src');
  assert.deepEqual(srcs.map((e) => e.getAttribute('data-harness')), ['codex']);
  assert.equal(srcs[0]!.querySelector('.sr')!.textContent, t('src.error', { h: 'Codex', code: 'read-denied' }));
  assert.equal(doc.querySelector('[data-slot=srcBox]')!.getAttribute('data-hide'), '0');
  render(s);
  // No rule reads a failure yet (meta.detects.error false): no 出错 0, which would read as none (T1).
  assert.equal(s.meta.detects.error, false);
  assert.equal(doc.querySelector('[data-filter=error]')!.getAttribute('data-hide'), '1');
  render({ ...s, meta: { ...s.meta, detects: { error: true } } });
  assert.equal(doc.querySelector('[data-filter=error]')!.getAttribute('data-hide'), '0');
  assert.equal(doc.querySelector('[data-slot=freshT]')!.textContent, t('fresh.live', { age: t('ago.s', { n: 2 }) }));
  assert.equal(doc.querySelector('[data-slot=test]')!.getAttribute('data-hide'), '0');
  assert.equal(fmtAge(null), TOWER_TEXT.dash);
  assert.equal(fmtAge(-1), TOWER_TEXT.dash);
  assert.equal(fmtAge(3 * 86_400_000), t('age.d', { n: 3 }));
});

test('the about view: every source, what the limits clipped, each rule untested with its sample count (T4)', () => {
  const { doc, render } = page();
  const s = golden();
  render(s);
  const about = doc.getElementById('about')!;
  const trs = about.querySelectorAll('tr').filter((r) => r.getAttribute('data-harness') !== null);
  assert.deepEqual(trs.map((r) => r.getAttribute('data-harness')), ['claude', 'dsh', 'codex']);
  assert.equal(trs[2]!.querySelector('[data-slot=reg]')!.textContent, TOWER_TEXT['about.noRegistry']);
  assert.equal(slotText(about, 'clipped'), TOWER_TEXT['about.noClip']);
  const rules = about.querySelectorAll('.rule');
  assert.equal(rules.length, s.meta.rules.length);
  assert.ok(rules.length >= 20);
  for (const r of rules) {
    assert.equal(r.querySelector('[data-slot=st]')!.textContent, t('rule.untested', { n: 0 }));
    assert.notEqual(r.querySelector('[data-slot=d]')!.textContent, TOWER_TEXT['rule.unknown'], r.querySelector('[data-slot=id]')!.textContent);
  }
});

test('nothing on the rendered page says done (T2), whatever the sample, view or selection', () => {
  for (const make of [golden, busy]) {
    const s = make();
    const { doc, ui, render } = page();
    for (const n of [null, ...nodes(s).map((x) => x.id)]) {
      ui.sel = n;
      ui.peek = new Set(nodes(s).map((x) => x.id));
      render(s);
      const all = (doc as FakeDocument).textContent + doc.title;
      assert.equal(all.includes('完成'), false);
    }
  }
});
