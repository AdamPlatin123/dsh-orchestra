import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findImports } from '../helpers/scan-rules.ts';
import { FakeElement, parseHtml, type FakeDocument, type FakeText } from '../helpers/fake-dom.ts';
import { busyStage } from '../helpers/tower-fixture.ts';
import { makePatcher } from '../../ui/dom.js';
import { MAX_DOTS, describeFold, toneOf } from '../../ui/fold.js';
import { openFull } from '../../ui/route.js';
import { describeErrs, describeIsland, describeLost, describeRail, describeSubs, describeWires, railList, rootOf, subCards, wireRows, workersOf } from '../../ui/wings.js';
import { describeChat, sentText } from '../../ui/owned.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { validateTower } from '../../shared/tower-contract.js';
import { towerFromStage, type OwnedMember, type OwnedSeat } from '../../src/sources/tower.ts';
import { UI_ASSETS } from '../../src/server/ui-assets.ts';
import { UI_FILES } from '../../scripts/embed-ui.ts';

// The home page (第三轮方案 22): ui/home.html with the descriptors of ui/wings.js and ui/fold.js, then ui/home.js
// booted in the fake DOM with the browser's powers stubbed. What it proves: a card's marks are its members, one
// each, and past 16 they turn into a bar; unknown is never drawn as running; a read-only session has no control;
// a capsule counts the list it opens; a source's string stays text; an allow keeps the old page's rules. Synthetic
// data only.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HTML = read('ui/home.html');
const CSS = read('ui/home.css');
const HOME = pathToFileURL(path.join(REPO, 'ui/home.js')).href;
const HAN = /[㐀-鿿豈-﫿　-〿＀-￯]/;
type Json = Record<string, any>;

let serial = 0;
const node = (over: Json = {}): Json => ({
  id: `n:${(++serial).toString(16).padStart(20, '0')}`, session: null, harness: 'codex', ownership: 'owned', layer: 'subagent', parent: 'n:'.padEnd(22, 'a'), depth: 1,
  title: `m${serial}`, activity: null, state: 'running', basis: 'owned', waiting: null, counts: { children: 0, errors: 0, waiting: 0 }, groups: [],
  ageMs: 0, durationMs: null, model: null, agentType: null, batch: null, mark: null, sent: null, ...over,
});
const WORKER = 'n:'.padEnd(22, 'a');
/** A snapshot of one owned worker and its members; only what the descriptors read. */
const snapOf = (members: Json[], worker: Json = {}): any => ({
  meta: { detects: { error: true }, sources: { claude: { state: 'ok' }, dsh: { state: 'ok' }, codex: { state: 'ok' } }, clipped: { projects: 0, nodes: 0, sessions: { claude: 0, dsh: 0, codex: 0 } }, profile: 'test' },
  router: { kind: 'human', dispatch: null, asks: [] }, waitingBar: [], tally: { waiting: 0 },
  projects: [{ id: 'f'.repeat(20), name: 'proj', basis: 'cwd', groups: [], nodes: [node({ id: WORKER, layer: 'agent', parent: null, depth: 0, title: 'worker', ...worker }), ...members] }],
});

function page() {
  const doc = parseHtml(HTML);
  const dom = makePatcher(doc as unknown as Document);
  dom.fillStatic();
  return { doc, dom };
}
const marks = (card: FakeElement, slot: 'dots' | 'bar') => card.querySelector(`[data-slot=${slot}]`)!.children;
const hidden = (el: FakeElement | null) => el!.getAttribute('data-hide') === '1';

function subs(members: Json[], open: string[] = [], worker: Json = {}) {
  const p = page();
  const s = snapOf(members, worker);
  p.dom.paintId('subs', describeSubs(s, WORKER, { open: new Set(open), fresh: new Set() }) as any);
  return { ...p, s, cards: p.doc.getElementById('subs')!.querySelectorAll('.cw') };
}

test('the card: one dot a member up to 16, then one bar of the same members; the height does not depend on the count', () => {
  for (const n of [1, 3, MAX_DOTS]) {
    const { cards } = subs(Array.from({ length: n }, () => node({ state: 'returned' })));
    assert.equal(cards.length, 1);
    assert.equal(marks(cards[0]!, 'dots').length, n, 'the dots are the members (T3)');
    assert.equal(hidden(cards[0]!.querySelector('[data-slot=dots]')), false);
    assert.equal(hidden(cards[0]!.querySelector('[data-slot=bar]')), true);
    assert.equal(marks(cards[0]!, 'bar').length, 0);
    assert.equal(cards[0]!.querySelector('[data-slot=n]')!.textContent, `${n} 个`);
  }
  const big = subs(Array.from({ length: MAX_DOTS + 1 }, (_, i) => node({ state: i < 5 ? 'running' : 'returned' })));
  const card = big.cards[0]!;
  assert.equal(marks(card, 'dots').length, 0);
  assert.equal(hidden(card.querySelector('[data-slot=dots]')), true);
  assert.equal(hidden(card.querySelector('[data-slot=bar]')), false);
  assert.equal(marks(card, 'bar').length, MAX_DOTS + 1, 'the bar holds the same members, so its parts are their shares');
  assert.equal(marks(card, 'bar').filter((m) => m.classList.contains('fd-run')).length, 5);
  assert.equal(card.querySelector('[data-slot=bar]')!.getAttribute('aria-label'), '在跑 5，已回报 12');
  // No width written anywhere: the page's CSP takes no style attribute.
  assert.equal(marks(card, 'bar').some((m) => m.hasAttribute('style')), false);
});

test('the card is folded unless clicked open, running or not; open, its list is as long as its marks and says state, time and model', () => {
  const ms = [node({ state: 'running', durationMs: 90_000, model: 'codex/gpt-6.1-sol' }), node({ state: 'unknown', basis: 'none' }), node({ state: 'returned', durationMs: 30_000 })];
  const shut = subs(ms);
  assert.equal(shut.cards[0]!.querySelector('.fold')!.getAttribute('aria-expanded'), 'false');
  assert.equal(shut.cards[0]!.querySelectorAll('.mem').length, 0);
  assert.equal(hidden(shut.cards[0]!.querySelector('[data-slot=body]')), true);
  const key = subCards(shut.s, WORKER)[0]!.key;
  const open = subs(ms, [key]);
  const card = open.cards[0]!;
  assert.equal(card.querySelector('.fold')!.getAttribute('aria-expanded'), 'true');
  const rows = card.querySelectorAll('.mem');
  assert.equal(rows.length, marks(card, 'dots').length);
  const line = (r: FakeElement) => ['st', 'took', 'model'].map((s) => r.querySelector(`[data-slot=${s}]`)!.textContent);
  assert.deepEqual(line(rows[0]!), ['在跑', '1 分', 'codex/gpt-6.1-sol']);
  assert.deepEqual(line(rows[1]!), ['状态未知', '耗时未知', '型号未知'], 'what is not known says so (T1)');
  // One member's time is not known: the card does not claim the longest of all.
  assert.equal(card.querySelector('[data-slot=took]')!.textContent, '已知最长 1 分');
  assert.equal(subs([node({ state: 'returned' })]).cards[0]!.querySelector('[data-slot=took]')!.textContent, '耗时未知');
});

test('T1: unknown is never drawn as running, and a guess is hollow; what waits or failed flags the folded card', () => {
  assert.equal(toneOf(node({ state: 'unknown', basis: 'none' }) as any), 'unk');
  assert.equal(toneOf(node({ state: 'running', basis: 'mtime' }) as any), 'guess');
  assert.equal(toneOf(node({ state: 'running', basis: 'log' }) as any), 'guess');
  assert.equal(toneOf(node({ state: 'waiting', basis: 'registry', waiting: { kind: 'approval', source: 'inferred', deadline: null } }) as any), 'guess');
  assert.equal(toneOf(node({ state: 'running', basis: 'registry' }) as any), 'run');
  const { cards } = subs([node({ state: 'unknown', basis: 'none' }), node({ state: 'running', basis: 'mtime' }), node({ state: 'error', basis: 'log' }), node({ state: 'waiting', basis: 'registry', waiting: { kind: 'approval', source: 'native', deadline: null } })]);
  const dots = marks(cards[0]!, 'dots');
  assert.equal(dots.filter((d) => d.classList.contains('fd-run')).length, 0, 'nothing here is known to run');
  assert.deepEqual(dots.map((d) => d.getAttribute('class')), ['fd fd-err', 'fd fd-wait', 'fd fd-guess', 'fd fd-unk']);
  assert.equal(cards[0]!.querySelector('[data-slot=fw]')!.textContent, '等你 1');
  assert.equal(cards[0]!.querySelector('[data-slot=fe]')!.textContent, '出错 1');
  // The corner of an avatar: an unknown worker has no green dot.
  const p = page();
  p.dom.paintId('rail', describeRail(snapOf([], { state: 'unknown', basis: 'none' }), { sel: null, roOpen: false }) as any);
  assert.equal(p.doc.getElementById('rail')!.querySelector('.bd')!.getAttribute('data-b'), 'unk');
});

test('a sub-agent\'s own sub-agents are members of the same card, and a card per agent type', () => {
  const a = node({ agentType: 'Explore' });
  const s = snapOf([a, node({ agentType: 'Explore' }), node({ parent: a.id, depth: 2 }), node({ agentType: 'Plan' })]);
  const cards = subCards(s, WORKER);
  assert.deepEqual(cards.map((c) => [c.label, c.members.length]), [['Explore', 3], ['Plan', 1]]);
  assert.deepEqual(cards[0]!.members.map((m) => m.depth), [0, 1, 0]);
  assert.equal(rootOf(s, cards[0]!.members[1]!.node.id), WORKER, 'a route to a member opens its session');
  assert.deepEqual(subCards(s, null), []);
});

test('why the right side is empty is said per worker, and no line is claimed', () => {
  const note = (members: Json[], worker: Json = {}) => subs(members, [], worker).doc.getElementById('subs')!.querySelector('[data-slot=note]')!.textContent;
  assert.equal(note([]), TOWER_TEXT['home.subsNone']);
  assert.equal(note([], { harness: 'claude' }), TOWER_TEXT['home.subsClaude']);
  assert.equal(note([], { ownership: 'observed' }), TOWER_TEXT['home.subsRo']);
  assert.equal(note([node()]), TOWER_TEXT['home.noWire']);
  assert.ok(note([node()], { ownership: 'observed' }).startsWith(TOWER_TEXT['home.subsRoNote']!));
});

test('the capsules count the lists they open; a build that reads no failures shows no error count', () => {
  const pins = { slots: { list: { kids: [{ key: 'a', tpl: 'tpl-pin', data: {}, slots: { path: { text: '你 › p › w' } } }, { key: 'b', tpl: 'tpl-req', data: { due: '5000' }, slots: { what: { text: 'x' } } }] } } } as any;
  const failed = node({ state: 'error', basis: 'log', ownership: 'observed', title: 'bad' });
  const s = snapOf([failed]);
  const errs = describeErrs(s);
  assert.equal(errs.length, 1);
  assert.equal((errs[0]!.slots as any).path.text, '你 › proj › worker › bad', 'the way there in full');
  assert.equal((errs[0]!.slots as any).acts.kids.length, 0, 'no action on what failed elsewhere');
  const isl = describeIsland(pins, errs, { open: false, nowWall: 2000, bar: [{ deadline: null }], detects: true }) as any;
  assert.equal(isl.slots.capWn.text, '等你 2');
  assert.equal(isl.slots.capWt.text, '最急 剩 0:03');
  assert.equal(isl.slots.capEn.text, '出错 1');
  assert.equal(isl.slots.capE.data.hide, '0');
  assert.equal(isl.slots.hint.text, '你 › p › w');
  assert.equal(isl.slots.errs.kids.length, 0, 'folded');
  assert.equal((describeIsland(pins, errs, { open: true, nowWall: 2000, bar: [], detects: true }) as any).slots.errs.kids.length, 1);
  assert.equal((describeIsland(pins, [], { open: false, nowWall: 0, bar: [], detects: false }) as any).slots.capE.data.hide, '1');
  s.meta.detects.error = false;
  assert.deepEqual(describeErrs(s), []);
});

test('the list: Orchestra\'s own first, the read-only ones folded under a count that is the list\'s length', () => {
  const s = towerFromStage(busyStage(), { seats: [{ ownedId: 'a'.repeat(20), harness: 'codex', title: 'mine', state: 'running', endReason: null, lastAt: null, waiting: null }], nowWall: 0 }) as any;
  const { owned, readonly } = workersOf(s);
  assert.equal(owned.length, 1);
  assert.ok(readonly.length > 3);
  assert.ok(readonly.every((w) => w.node.layer === 'agent' && w.node.ownership !== 'owned'));
  const p = page();
  const rail = p.doc.getElementById('rail')!;
  p.dom.paintId('rail', describeRail(s, { sel: null, roOpen: false }) as any);
  assert.equal(rail.querySelector('[data-slot=roH]')!.textContent, `只读 ${readonly.length}`);
  assert.equal(rail.querySelector('[data-slot=ro]')!.children.length, 0);
  p.dom.paintId('rail', describeRail(s, { sel: null, roOpen: true }) as any);
  assert.equal(rail.querySelector('[data-slot=ro]')!.children.length, readonly.length);
  assert.equal(rail.querySelector('[data-slot=own]')!.children.length, 1);
});

test('a sub-agent whose parent the lane does not hold leads its own tree: it has a row, it counts, its own sub-agents show', () => {
  const orphan = node({ ownership: 'observed', parent: null, depth: 0, state: 'running', basis: 'log', title: 'orphan', session: 'c'.repeat(20) });
  const kid = node({ ownership: 'observed', parent: orphan.id, basis: 'log' });
  const s = snapOf([]);
  s.projects.push({ id: 'e'.repeat(20), name: 'ro', basis: 'cwd', groups: [], nodes: [node({ ownership: 'observed', layer: 'agent', parent: null, depth: 0, state: 'idle', basis: 'log' }), orphan, kid] });
  assert.deepEqual(workersOf(s).readonly.map((w) => w.node.id).includes(orphan.id), true);
  assert.equal(workersOf(s).readonly.length, 2, 'its sub-agent is no worker');
  const p = page();
  const rail = p.doc.getElementById('rail')!;
  p.dom.paintId('rail', describeRail(s, { sel: orphan.id, roOpen: true }) as any);
  assert.equal(rail.querySelector('[data-slot=roH]')!.textContent, '只读 2');
  assert.equal(rail.querySelector('[data-slot=ro]')!.children.length, 2, 'the count is the list (T3)');
  assert.equal(rail.querySelectorAll('.wk').filter((r) => r.getAttribute('data-on') === '1').length, 1, 'selected, it is lit');
  assert.equal(rootOf(s, kid.id), orphan.id);
  assert.deepEqual(subCards(s, orphan.id).flatMap((c) => c.members.map((m) => m.node.id)), [kid.id]);
});

test('T1: a state guessed from a log or a write says so on its row, in the title too', () => {
  const line = (over: Json) => {
    const n = node({ ownership: 'observed', layer: 'agent', parent: null, depth: 0, ...over });
    const s = snapOf([]);
    s.projects.push({ id: 'e'.repeat(20), name: 'proj', basis: 'cwd', groups: [], nodes: [n] });
    const p = page();
    p.dom.paintId('rail', describeRail(s, { sel: null, roOpen: true }) as any);
    const row = p.doc.getElementById('rail')!.querySelector('[data-slot=ro]')!.querySelector('.rr')!;
    return { l2: row.querySelector('[data-slot=l2]')!.textContent, title: row.getAttribute('title')! };
  };
  assert.equal(line({ state: 'running', basis: 'mtime' }).l2, 'proj · ≈ 在跑（推测）');
  assert.equal(line({ state: 'idle', basis: 'log' }).l2, 'proj · ≈ 空闲（推测）');
  assert.ok(line({ state: 'idle', basis: 'log' }).title.endsWith('≈ 空闲（推测）'));
  assert.equal(line({ state: 'running', basis: 'registry' }).l2, 'proj · 在跑', 'what was reported is plain');
  assert.equal(line({ state: 'running', basis: 'log', activity: 'reads' }).l2, 'proj · reads', 'an activity claims no state');
});

test('T1: what was not read is said over both halves, at every width: a failed source, clipped sessions, projects and nodes', () => {
  const s = snapOf([]);
  assert.equal((describeLost(s) as any).data.hide, '1');
  s.meta.sources.claude = { state: 'error', error: 'EACCES', total: 0, shown: 0, registry: null };
  s.meta.clipped.sessions.codex = 3;
  s.meta.clipped.nodes = 24;
  const lost = describeLost(s) as any;
  assert.equal(lost.data.hide, '0');
  assert.equal(lost.text, 'Claude：读取出错（EACCES）；另有 3 个会话因上限没读入，见旧页面的「关于数据」；另有 0 个项目、24 个节点因上限没画出来');
  const p = page();
  p.dom.paintId('lost', lost);
  assert.equal(p.doc.getElementById('lost')!.textContent, lost.text);
  // Nothing in the page's narrow rules takes it, or the list's counts, away; a note the avatars have no room for stays for a reader.
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /\.lost[^{}]*\{[^}]*display: none/);
  assert.doesNotMatch(body, /\.rs[^{}]*\{[^}]*display: none/);
  assert.doesNotMatch(body, /\.rail-note[^{}]*\{[^}]*display: none/);
  assert.doesNotMatch(body, /\.ro-t[^{}]*\{[^}]*clip-path/, 'the group\'s count stays seen');
  assert.equal(p.doc.getElementById('rail')!.querySelector('[data-slot=src]'), null, 'the rail\'s foot was out of sight at 1200 and below');
});

test('the right side says what the limits left out, and no read-only session is told the owned one\'s reason', () => {
  const shown = (over: number, worker: Json = {}, members: Json[] = [node()]) => {
    const s = snapOf(members, worker);
    s.meta.clipped.nodes = over;
    const p = page();
    p.dom.paintId('subs', describeSubs(s, WORKER, { open: new Set(), fresh: new Set() }) as any);
    return p.doc.getElementById('subs')!.querySelector('[data-slot=note]')!.textContent;
  };
  assert.equal(shown(0), TOWER_TEXT['home.noWire']);
  assert.ok(shown(8).includes('这次有 8 个节点因上限没读入'));
  assert.ok(shown(8, { ownership: 'observed' }, []).includes('这次有 8 个节点因上限没读入'), 'an empty side may be short too');
  const ro = shown(0, { ownership: 'observed' });
  assert.ok(ro.includes(TOWER_TEXT['home.noWireRo']!));
  assert.equal(ro.includes(TOWER_TEXT['home.noWire']!), false, 'a read-only session\'s events may show the dispatch');
});

test('a card holds its title and its rows however its members\' ranks move; the left list holds under the pointer, newcomers last', () => {
  const a = node({ title: 'member-2', ageMs: 0 });
  const b = node({ title: 'member-10', ageMs: 5 });
  const c = node({ title: 'member-1', ageMs: 9 });
  const read = (members: Json[]) => {
    const cards = subCards(snapOf(members), WORKER);
    const p = page();
    p.dom.paintId('subs', describeSubs(snapOf(members), WORKER, { open: new Set([cards[0]!.key]), fresh: new Set() }) as any);
    const sub = p.doc.getElementById('subs')!;
    return { rows: sub.querySelectorAll('.mem').map((r) => r.querySelector('[data-slot=name]')!.textContent), title: sub.querySelector('[data-slot=title]')!.textContent };
  };
  const one = read([a, b, c]);
  assert.deepEqual(one, { rows: ['member-1', 'member-2', 'member-10'], title: 'member-1 等 3 个' });
  assert.deepEqual(read([c, b, a]), one);
  assert.deepEqual(read([b, c, a]), one);
  const w = (id: string) => node({ id, layer: 'agent', parent: null, depth: 0, ownership: 'observed' });
  const [x, y, z] = [`n:${'1'.repeat(20)}`, `n:${'2'.repeat(20)}`, `n:${'3'.repeat(20)}`];
  const s = snapOf([]);
  s.projects = [{ id: 'e'.repeat(20), name: 'p', basis: 'cwd', groups: [], nodes: [w(y), w(z), w(x)] }];
  assert.deepEqual(railList(s, []).readonly.map((v) => v.node.id), [y, z, x], 'free, the snapshot\'s order');
  assert.deepEqual(railList(s, [x, y]).readonly.map((v) => v.node.id), [x, y, z]);
  assert.deepEqual(railList(s, ['n:gone', z, y]).readonly.map((v) => v.node.id), [z, y, x], 'what is gone holds no place');
});

test('a sub-agent\'s card flags what its state cannot say: it runs while it asks, it ended when it failed', () => {
  const seats: OwnedSeat[] = [{ ownedId: 'a'.repeat(20), harness: 'codex', title: 'w', state: 'running', endReason: null, lastAt: 0, waiting: { kind: 'approval', deadline: 1000, title: 'req' }, members: [member(1, { asking: 'run npm test' }), member(2, { state: 'ended', why: 'failed' }), member(3, { state: 'ended', why: 'shutdown' }), member(4)] }];
  const s = towerFromStage(busyStage(), { seats, nowWall: 0 }) as any;
  assert.deepEqual(validateTower(s), { ok: true, errors: [] });
  const nodes = s.projects[0].nodes;
  assert.deepEqual(nodes.slice(1).map((n: Json) => [n.title, n.mark]).sort(), [['sub 1', 'asks'], ['sub 2', 'failed'], ['sub 3', null], ['sub 4', null]]);
  assert.equal(s.waitingBar.filter((e: Json) => e.source === 'orchestra').length, 1, 'one approval is one waiting node (T3): the mark counts nowhere else');
  assert.equal(toneOf(nodes.find((n: Json) => n.title === 'sub 1')), 'wait');
  assert.equal(toneOf(nodes.find((n: Json) => n.title === 'sub 2')), 'err');
  const card = describeFold({ key: 'k', title: 't', members: nodes.slice(1).map((node: any) => ({ node, depth: 0 })), open: false }) as any;
  assert.equal(card.slots.fw.text, '等你 1');
  assert.equal(card.slots.fw.data.hide, '0');
  assert.equal(card.slots.fe.text, '出错 1');
  assert.equal(card.slots.fe.data.hide, '0');
});

test('the full record\'s way back: opened from the old page, it says so; from the home page, nothing to say', () => {
  const g = globalThis as any;
  const saved = Object.getOwnPropertyDescriptor(g, 'location');
  try {
    const at = (pathname: string) => { const loc = { pathname, href: '' }; Object.defineProperty(g, 'location', { configurable: true, writable: true, value: loc }); openFull('a'.repeat(20)); return loc.href; };
    assert.equal(at('/'), `/session?id=${'a'.repeat(20)}`);
    assert.equal(at('/tower'), `/session?id=${'a'.repeat(20)}&from=tower`);
  } finally {
    if (saved === undefined) delete g.location;
    else Object.defineProperty(g, 'location', saved);
  }
});

const disp = (seq: number, batch: number, ref: string, text: string | null): Json => ({ seq, at: 1, kind: 'note', ref, uuid: null, text, state: 'dispatch', redactions: 0, live: false, exitCode: null, tokens: null, batch });

test('a card is one dispatch: its batch\'s members, count and time, in the order they went out; those no batch names stay as they were', () => {
  const a = node({ title: 'zed', batch: 2, durationMs: 4_000 });
  const b = node({ title: 'amy', batch: 2, durationMs: 9_000, state: 'returned' });
  const c = node({ title: 'bob', batch: 1, durationMs: null });
  const loose = node({ title: 'nobody announced it' });
  const s = snapOf([a, b, c, loose]);
  const cards = subCards(s, WORKER);
  assert.deepEqual(cards.map((k) => [k.batch, k.members.map((m) => m.node.title)]), [[1, ['bob']], [2, ['amy', 'zed']], [null, ['nobody announced it']]]);
  const p = page();
  p.dom.paintId('subs', describeSubs(s, WORKER, { open: new Set(), fresh: new Set() }) as any);
  const shown = p.doc.getElementById('subs')!.querySelectorAll('.cw').map((w) => ['title', 'kind', 'n', 'took'].map((k) => w.querySelector(`[data-slot=${k}]`)!.textContent));
  assert.deepEqual(shown, [
    ['bob', 'subagent', '1 个', '耗时未知'],
    ['amy 等 2 个', 'subagent', '2 个', '最长 9 秒'],
    ['nobody announced it', 'subagent', '1 个', '耗时未知'],
  ]);
  // A read-only session's nodes carry no batch: its cards go by agent type as before, and say why they have no wire.
  const ro = snapOf([node({ ownership: 'observed', basis: 'log', agentType: 'Explore' }), node({ ownership: 'observed', basis: 'log', agentType: 'Explore' })], { ownership: 'observed', basis: 'log' });
  assert.deepEqual(subCards(ro, WORKER).map((k) => [k.label, k.batch, k.members.length]), [['Explore', null, 2]]);
  const note = (describeSubs(ro, WORKER, { open: new Set(), fresh: new Set() }) as any).slots.note.text;
  assert.ok(note.includes(TOWER_TEXT['home.noWireRo']!), note);
});

test('the talk\'s dispatch: one row a batch, a name told again in its place; on the home page a button that opens the card and says what it holds (T3)', () => {
  const events = [disp(1, 1, 'n:a', null), disp(2, 1, 'n:b', 'bee'), disp(3, 2, 'n:c', 'cee'), disp(4, 1, 'n:a', 'ay')];
  const chat = describeChat({ clipped: false, events });
  assert.deepEqual(chat.kids.map((k: any) => [k.key, k.data.kind, k.data.batch, k.slots.tx.text]), [['d1', 'disp', '1', '派出 ay 等 2 个'], ['d2', 'disp', '2', '派出 cee']]);
  assert.equal(describeChat({ clipped: false, events: [disp(1, 1, 'n:a', null)] }).kids[0].slots.tx.text, '派出 名字未知', 'a name not known is said (T1)');
  assert.equal(sentText(['a']), TOWER_TEXT['fnote.dispatch']!.replace('{t}', 'a'));

  const s = snapOf([node({ title: 'x', batch: 1 }), node({ title: 'y', batch: 1 }), node({ title: 'w', batch: 1 })]);
  const cards = subCards(s, WORKER);
  const rows: any[] = wireRows(chat.kids, cards, new Set([cards[0]!.key]));
  assert.equal(rows[0].tpl, 'tpl-disp');
  assert.equal(rows[0].slots.tx.text, '派出 w 等 3 个', 'the card\'s count, not the feed\'s: the row opens that list');
  assert.deepEqual(rows[0].slots.b, { data: { fold: cards[0]!.key }, attr: { 'aria-expanded': 'true', disabled: null, title: null } });
  // Its card not in this snapshot: said, and nothing to click.
  assert.deepEqual(rows[1].slots.b, { data: { fold: '' }, attr: { 'aria-expanded': null, disabled: '', title: TOWER_TEXT['home.wireNoCard'] } });
  assert.equal(rows[1].slots.tx.text, '派出 cee');
  const other = { key: 'k', tpl: 'tpl-msg', data: { kind: 'note' } };
  assert.equal(wireRows([other], cards, new Set())[0], other);

  const p = page();
  p.dom.paint(p.doc.getElementById('detail')!.querySelector('[data-slot=chat]') as any, { kids: rows });
  const b = p.doc.getElementById('detail')!.querySelector('.dr')!;
  assert.equal(b.tagName, 'BUTTON');
  assert.equal(b.getAttribute('data-act'), 'fold');
});

test('the right side says why a card has no wire: the talk locked, not read yet, or no row for it; a card with a row needs no word', () => {
  const s = snapOf([node({ batch: 1 })]);
  const key = subCards(s, WORKER)[0]!.key;
  const note = (rows: Set<string>, read: boolean, locked = false) => (describeSubs(s, WORKER, { open: new Set(), fresh: new Set(), rows, read, locked }) as any).slots.note.text;
  assert.equal(note(new Set([key]), true), '');
  assert.equal(note(new Set(), true), TOWER_TEXT['home.noWire']);
  assert.equal(note(new Set(), false, true), TOWER_TEXT['home.noWireLocked']);
  // Unlocked and still not read (on its way, or the feed failed): it must not tell a person who unlocked to unlock (T1).
  assert.equal(note(new Set(), false), TOWER_TEXT['home.noWireUnread']);
});

test('a wire: only between a row and a card both in view; hot and new are data, its geometry attributes', () => {
  const r = (top: number, height: number, left = 0, right = 0) => ({ top, bottom: top + height, height, left, right }) as DOMRect;
  const box = { chat: r(100, 400), frame: r(0, 800), subs: r(60, 500), x: 700 };
  const end = (row: DOMRect, card: DOMRect, over: Json = {}) => ({ key: 'k', hot: false, grow: false, row, card, ...over });
  const one = (describeWires([end(r(200, 30, 10, 500), r(100, 100))], box).kids as any[])[0];
  assert.deepEqual(one.data, { hot: '0', grow: '0' });
  assert.equal(one.slots.p.attr.d, 'M504 215C611.8 215 611.8 130 700 130');
  assert.deepEqual(one.slots.c.attr, { cx: '700', cy: '130' });
  assert.deepEqual(((describeWires([end(r(200, 30), r(100, 40), { hot: true, grow: true })], box).kids as any[])[0]).data, { hot: '1', grow: '1' });
  // Either end scrolled out takes the wire in, hot or not; nothing laid out has none.
  for (const e of [end(r(40, 30), r(100, 40), { hot: true }), end(r(600, 30), r(100, 40)), end(r(200, 30), r(10, 40), { hot: true }), end(r(200, 30), r(600, 40))]) assert.deepEqual(describeWires([e], box).kids, []);
  assert.deepEqual(describeWires([end(r(0, 0), r(0, 0))], { chat: r(0, 0), frame: r(0, 0), subs: r(0, 0), x: 0 }).kids, []);
  // In a low window the talk keeps its least height and runs past its pane: a row in the talk's box, cut off by the pane, has no wire.
  const cut = { ...box, chat: r(215, 72), frame: r(0, 216) };
  assert.deepEqual(describeWires([end(r(240, 30), r(100, 40))], cut).kids, []);
  assert.equal(describeWires([end(r(200, 30), r(100, 40))], cut).kids!.length, 1, 'its centre at 215, still in the pane');
  // The geometry paints through the patcher's list, with no style attribute.
  const p = page();
  p.dom.paintId('wires', describeWires([end(r(200, 30, 10, 500), r(100, 100))], box) as any);
  const w = p.doc.getElementById('wires')!.querySelector('.wire')!;
  assert.equal(w.querySelector('path')!.getAttribute('d'), one.slots.p.attr.d);
  assert.equal(w.hasAttribute('style'), false);
});

test('home.html: nothing inline, one module script, one stylesheet, one plain link, no word of its own, every template', () => {
  assert.equal([...HTML.matchAll(/<script\b/g)].length, 1);
  assert.match(HTML, /<script type="module" src="\/assets\/ui\/home\.js"><\/script>/);
  assert.match(HTML, /<link rel="stylesheet" href="\/assets\/ui\/home\.css">/);
  assert.doesNotMatch(HTML, /<style\b/);
  assert.doesNotMatch(HTML, /\sstyle\s*=/);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(HTML, /<form\b/i);
  assert.doesNotMatch(HTML, /javascript:/i);
  assert.doesNotMatch(HTML, /docs\//, 'nothing from docs/');
  assert.doesNotMatch(HTML, /type="checkbox"/, 'no switch for a permission nobody can use');
  assert.deepEqual([...HTML.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/tower']);
  assert.doesNotMatch(HTML, HAN);
  const doc = parseHtml(HTML);
  const texts: string[] = [];
  const walk = (el: { childNodes: unknown[] }, inTitle: boolean) => {
    for (const c of el.childNodes as (FakeElement | FakeText)[]) {
      if ('data' in c) { if (!inTitle && c.data.trim() !== '') texts.push(c.data); } else {
        walk(c, inTitle || c.localName === 'title');
        if (c.content !== null) walk(c.content, false);
      }
    }
  };
  walk(doc, false);
  assert.deepEqual(texts, []);
  for (const m of HTML.matchAll(/data-t="([^"]+)"/g)) assert.ok(Object.hasOwn(TOWER_TEXT, m[1]!), m[1]);
  const js = ['ui/wings.js', 'ui/fold.js', 'ui/home.js'].map(read).join('\n');
  for (const f of ['ui/wings.js', 'ui/fold.js', 'ui/home.js', 'ui/drive.js']) assert.doesNotMatch(read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), HAN, f);
  for (const m of js.matchAll(/\bt\('([^'$`]+)'/g)) assert.ok(Object.hasOwn(TOWER_TEXT, m[1]!), m[1]);
  const named = [...new Set([...(js + read('ui/view.js') + read('ui/owned.js')).matchAll(/tpl: '(tpl-[a-z]+)'/g)].map((m) => m[1]!))];
  const old = ['tpl-arow', 'tpl-group', 'tpl-node', 'tpl-proj', 'tpl-rule', 'tpl-src'];
  for (const id of named.filter((x) => !old.includes(x))) assert.ok(doc.getElementById(id)?.content?.firstElementChild, `no <template id=${id}>`);
  for (const k of ['err', 'wait', 'run', 'guess', 'done', 'known', 'unk']) assert.ok(Object.hasOwn(TOWER_TEXT, `fold.${k}`), k);
  for (const v of Object.values(TOWER_TEXT).filter((_, i, a) => a.length > 0)) assert.equal(v.includes('完成'), false);
});

test('home.css: the kit\'s tokens in both themes, motion only without a reduced-motion preference, nothing wider than 1024 asks for', () => {
  for (const t of ['--bg', '--panel', '--sunk', '--ink', '--act', '--wait', '--err', '--run', '--unk', '--taint']) assert.equal([...CSS.matchAll(new RegExp(`${t}: #`, 'g'))].length, 3, t);
  assert.match(CSS, /:root:not\(\[data-theme=light\]\)/);
  assert.match(CSS, /:root\[data-theme=dark\]/);
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = body.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(i > 0);
  const head = body.slice(0, i);
  assert.doesNotMatch(head, /\banimation\b/);
  assert.doesNotMatch(head, /\btransition\b/);
  for (const m of body.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g)) {
    // stroke-dashoffset: a wire drawing itself, the one thing that is not a move of a whole element.
    for (const d of m[1]!.matchAll(/([\w-]+):/g)) assert.ok(['opacity', 'transform', 'stroke-dashoffset'].includes(d[1]!), d[1]);
  }
  for (const m of body.matchAll(/font-size: ([\d.]+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
  // The right half stays; at 1024 the left list goes down to the avatars and the talk keeps its 420px.
  assert.match(body, /\.wings \{[^}]*grid-template-columns: minmax\(0, 1\.1fr\) minmax\(0, 1fr\)/);
  assert.match(body, /@media \(max-width: 1200px\) \{\s*\.left \{ grid-template-columns: 58px minmax\(0, 1fr\); \}/);
  assert.ok(1024 * (1.1 / 2.1) - 58 >= 420);
  assert.match(body, /\[data-tainted="1"\]/, 'a tainted card keeps its bar');
  // A capsule stays where it was clicked: the lists grow up from it where the page ends at the composer, down where it scrolls.
  const phone = body.slice(body.indexOf('@media (max-width: 899px)'));
  assert.match(body, /\.isl \{[^}]*flex-direction: column-reverse/);
  assert.match(phone, /\.isl \{ flex-direction: column; \}/);
  // On a phone the page scrolls, so nothing in the right half may take its height from a flex that has none.
  assert.match(phone, /\.right \{ display: block; \}/);
  assert.match(phone, /\.subs \{ overflow: visible; \}/);
});

test('what the browser loads for / stays within its own budget, all of it embedded, nothing from the contracts', () => {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const r of findImports(read(rel))) if (r.form !== 'dynamic' && /^\.\.?\//.test(r.spec)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), r.spec)));
  };
  walk('ui/home.js');
  assert.deepEqual([...seen].filter((f) => f.startsWith('shared/')).sort(), ['shared/frozen.js', 'shared/strings.js']);
  assert.equal(seen.has('ui/app.js'), false);
  const all = [...seen, 'ui/home.html', 'ui/home.css'];
  for (const f of all) {
    assert.ok(Object.hasOwn(UI_ASSETS, f), `${f} is not embedded`);
    assert.ok(UI_FILES.includes(f), `${f} is not in embed-ui's UI_FILES`);
  }
  const own = ['ui/home.html', 'ui/home.css', 'ui/home.js', 'ui/wings.js', 'ui/fold.js'].reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
  const total = all.reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
  // The page's own files, and everything it loads with what it shares with the old page.
  assert.ok(own <= 96 * 1024, `the home page's own files are ${own} bytes`);
  assert.ok(total <= 264 * 1024, `the home page loads ${total} bytes`);
});

const OBSERVED = towerFromStage(busyStage()).meta.observedAt;
const MIN = 60_000;
const CSRF = 'A'.repeat(43);
const ID = { a: 'a'.repeat(20), b: 'b'.repeat(20), c: 'c'.repeat(20) };
const AP = { a: '1'.repeat(32), b: '2'.repeat(32) };
const EVIL = '<img src=x onerror=alert(1)>';
const member = (i: number, over: Partial<OwnedMember> = {}): OwnedMember => ({ threadId: `t${i}`, name: `sub ${i}`, model: null, agentType: null, state: 'running', why: null, startedAt: null, endedAt: null, lastAt: null, failed: 0, ranUnasked: 0, batch: null, asking: null, ...over });
const seat = (ownedId: string, title: string, over: Partial<OwnedSeat> = {}): OwnedSeat => ({ ownedId, harness: 'codex', title, state: 'running', endReason: null, lastAt: OBSERVED, waiting: null, ...over });
const approval = (id: string, ownedId: string, over: Json) => ({
  approvalId: id, ownedId, kind: 'command', title: 'req', preview: 'command: npm test', tooLong: false, redactions: 0, digest: id.slice(0, 1).repeat(64),
  risk: 'shell', high: true, tainted: false, canAccept: true, canText: false, deadline: OBSERVED + 20 * MIN, rev: 1, ...over,
});

test('the page boots: worker, talk and cards from the fetched data; only a person drives, by the old page\'s rules', async () => {
  const doc: FakeDocument = parseHtml(HTML);
  const frames: (() => void)[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const timeouts: { fn: () => void; ms: number; off: boolean }[] = [];
  const requests: { method: string; url: string }[] = [];
  const prompts: string[] = [];
  let promptAnswer: string | null = null;
  const store = new Map<string, string>([['orchestra.csrf', CSRF]]);
  let mono = 1000;
  let seats: OwnedSeat[] = [
    seat(ID.a, EVIL, { waiting: { kind: 'approval', deadline: OBSERVED + 10 * MIN, title: 'req' }, members: [member(1, { name: EVIL }), member(2, { state: 'returned' })] }),
    seat(ID.b, 'tainted one', { state: 'idle', waiting: { kind: 'approval', deadline: OBSERVED + 20 * MIN, title: 'req' } }),
    seat(ID.c, 'quiet one', { state: 'idle' }),
  ];
  const list: Json = {
    v: 1, kind: 'owned-list', rev: 3, enabled: true, disabledWhy: null, brakeWhy: null, harnesses: { codex: true, claude: false }, limits: { maxOwned: 4, active: 3 }, requests: [],
    owned: [
      { ownedId: ID.a, harness: 'codex', model: 'codex/gpt-6.1-sol', title: EVIL, state: 'running', endReason: null, waiting: AP.a, queued: 0, tokens: null, lastSeq: 1, createdAt: 1, brake: true },
      { ownedId: ID.b, harness: 'codex', model: 'codex/gpt-6.1-sol', title: 'tainted one', state: 'idle', endReason: null, waiting: AP.b, queued: 0, tokens: null, lastSeq: 1, createdAt: 2 },
      { ownedId: ID.c, harness: 'codex', model: 'codex/gpt-6.1-sol', title: 'quiet one', state: 'idle', endReason: null, waiting: null, queued: 0, tokens: null, lastSeq: 1, createdAt: 3 },
    ],
    approvals: [approval(AP.a, ID.a, { deadline: OBSERVED + 10 * MIN }), approval(AP.b, ID.b, { tainted: true })],
  };
  let sent: Json[] = [];
  const feed = (id: string) => ({
    v: 1, kind: 'owned-feed', ownedId: id, from: 0, to: 1 + sent.length, clipped: false,
    events: [{ seq: 1, at: 1, kind: 'text', ref: 'm1', uuid: null, text: `said ${EVIL}`, state: 'final', redactions: 0, live: false, exitCode: null, tokens: null, batch: null }, ...sent],
  });
  let barEmpty = false;
  const tower = () => { const s = towerFromStage(busyStage(), { seats, nowWall: OBSERVED }); return barEmpty ? { ...s, waitingBar: [] } : s; };
  const loc = { hash: '', href: '', pathname: '/', search: '', replace(u: string) { this.hash = u.slice(u.indexOf('#')); } };
  const win = {};
  const heard = new WeakMap<object, Map<string, ((e: any) => void)[]>>();
  const on = (target: object, type: string, fn: (e: any) => void) => {
    const m = heard.get(target) ?? new Map();
    heard.set(target, m);
    m.set(type, [...(m.get(type) ?? []), fn]);
  };
  const fire = (target: object, type: string, e: Json = {}) => {
    const ev = { preventDefault() { (ev as any).prevented = true; }, isComposing: false, ...e };
    for (const fn of heard.get(target)?.get(type) ?? []) fn(ev);
    return ev as any;
  };
  Object.assign(doc, { hidden: false, addEventListener: (t: string, fn: (e: any) => void) => on(doc, t, fn) });
  (FakeElement.prototype as any).addEventListener = function (this: object, t: string, fn: (e: any) => void) { on(this, t, fn); };
  const g = globalThis as any;
  const keys = ['document', 'location', 'window', 'fetch', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Element', 'Node', 'localStorage', 'sessionStorage', 'ResizeObserver'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  /** What the page watches for a new size, by element. */
  const resized = new Map<object, () => void>();
  define('ResizeObserver', class { fn: () => void; constructor(fn: () => void) { this.fn = fn; } observe(el: object) { resized.set(el, this.fn); } });
  define('document', doc);
  define('location', loc);
  define('window', { addEventListener: (t: string, fn: (e: any) => void) => on(win, t, fn), matchMedia: () => ({ matches: false }), prompt: (m: string) => { prompts.push(m); return promptAnswer; } });
  define('performance', { now: () => mono });
  define('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  define('setInterval', (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; });
  define('clearInterval', () => {});
  const realImmediate = setImmediate;
  define('setTimeout', (fn: () => void, ms: number) => { timeouts.push({ fn, ms, off: false }); return timeouts.length; });
  define('clearTimeout', (id: number) => { const t = timeouts[id - 1]; if (t !== undefined) t.off = true; });
  define('Element', FakeElement);
  define('Node', FakeElement);
  define('localStorage', { getItem: () => null, setItem: () => {} });
  define('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  const reply = (body: unknown) => ({ status: 200, ok: true, json: async () => structuredClone(body) });
  define('fetch', async (url: string, init: { method?: string } = {}) => {
    requests.push({ method: init.method ?? 'GET', url });
    if (url === '/api/tower') return reply(tower());
    if (url === '/api/owned') return reply(list);
    const m = /^\/api\/owned\/([0-9a-f]{20})\/feed/.exec(url);
    if (m !== null) return reply(url.endsWith('after=0') ? feed(m[1]!) : { ...feed(m[1]!), from: 1, events: sent.filter((e) => e.seq > Number(/after=(\d+)/.exec(url)?.[1])) });
    if (url.startsWith('/api/peek/session')) return reply({ session: { id: url.slice(-20) }, events: [{ at: null, type: 'assistant', text: EVIL }], unparsed: 0, note: null });
    return reply({ accepted: true });
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => realImmediate(r));
    while (frames.length > 0) frames.shift()!();
  };
  const click = async (el: FakeElement | null | undefined) => {
    assert.ok(el !== null && el !== undefined, 'nothing to click');
    fire(doc, 'click', { target: el });
    await flush();
  };
  const tick = async () => { intervals.find((i) => i.ms === 2000)!.fn(); await flush(); await flush(); };
  const byId = (id: string) => doc.getElementById(id)!;
  const posts = (part: string) => requests.filter((r) => r.method === 'POST' && r.url.includes(part));
  const row = (title: string) => byId('rail').querySelectorAll('.rr').find((b) => b.querySelector('[data-slot=name]')!.textContent === title);
  try {
    await import(HOME);
    await flush();
    await flush();

    // Today's shape, said in words, with no switch and no router drawn.
    assert.equal(byId('desk').querySelector('.desk-t')!.textContent, TOWER_TEXT['home.noRouter']);
    assert.equal(doc.querySelector('.rbar')!.textContent, TOWER_TEXT['home.grantsNone']);
    assert.ok(doc.querySelector('.team')!.textContent.includes(TOWER_TEXT['home.noTeamH']!));
    assert.equal(doc.querySelector('.legacy')!.textContent, TOWER_TEXT['home.legacy']);
    assert.equal(doc.documentElement!.getAttribute('data-ready'), '1');

    // Orchestra's own sessions first; the first is open with its real talk.
    assert.equal(byId('rail').querySelector('[data-slot=own]')!.children.length, 3);
    const first = byId('rail').querySelector('[data-slot=own]')!.children[0]!;
    assert.equal(first.getAttribute('data-on'), '1');
    await click(row(EVIL));
    await tick();
    assert.ok(requests.some((r) => r.url.startsWith(`/api/owned/${ID.a}/feed`)));
    const chat = byId('detail').querySelector('[data-slot=chat]')!;
    assert.equal(chat.textContent.includes(`said ${EVIL}`), true);

    // A source's strings stay text: no element came of them, in the row, the title, the chat or a member.
    assert.equal(byId('dt-title').textContent, EVIL);
    assert.equal(row(EVIL)!.querySelector('[data-slot=ch]')!.textContent, '<');
    await click(byId('subs').querySelector('.fold'));
    assert.equal(byId('subs').querySelectorAll('.mem').some((m) => m.textContent.includes(EVIL)), true);
    assert.equal(doc.querySelectorAll('img').length, 0);
    assert.equal([...doc.walk()].some((e) => e.hasAttribute('onerror')), false);

    // A dispatch row comes in the talk: a button that opens its card, with a wire between them that stands out once.
    const talk = byId('detail').querySelector('[data-slot=chat]')!;
    const rects = (ch: FakeElement, rowEl: FakeElement, cardEl: FakeElement) => {
      const r = (top: number, height: number, left = 0, right = 0) => ({ top, bottom: top + height, height, left, right });
      ch.rect = r(100, 400);
      byId('detail').rect = r(40, 600);
      byId('subs').rect = r(50, 500);
      byId('subs').querySelector('[data-slot=list]')!.rect = r(50, 500, 700, 1000);
      rowEl.querySelector('.dr')!.rect = r(200, 30, 200, 600);
      cardEl.querySelector('.fold')!.rect = r(120, 80, 700, 1000);
    };
    seats = [{ ...seats[0]!, members: [member(1, { name: EVIL, batch: 1 }), member(2, { state: 'returned', batch: 1 }), member(3, { name: 'later', batch: 2 })] }, ...seats.slice(1)];
    const nodeIds = towerFromStage(busyStage(), { seats, nowWall: OBSERVED }).projects[0]!.nodes.filter((n) => n.layer === 'subagent');
    const idOf = (name: string) => nodeIds.find((n) => n.title === name)!.id;
    sent = [disp(2, 1, idOf(EVIL), EVIL), disp(3, 1, idOf('sub 2'), 'sub 2')];
    await tick();
    const dr = () => talk.querySelector('.dr')!;
    assert.equal(dr().textContent, `派出 ${EVIL} 等 2 个`);
    assert.equal(talk.querySelectorAll('img').length, 0, 'a name in a row stays text');
    const cardsNow = () => byId('subs').querySelectorAll('.cw');
    assert.equal(cardsNow().length, 2, 'one card a batch');
    assert.equal(byId('subs').querySelector('[data-slot=note]')!.textContent, TOWER_TEXT['home.noWire'], 'the second card has no row yet, and says so');
    rects(talk, dr().parentNode as FakeElement, cardsNow()[0]!);
    fire(byId('subs'), 'scroll');
    await flush();
    const wires = () => byId('wires').querySelectorAll('.wire');
    assert.equal(wires().length, 1);
    assert.equal(wires()[0]!.getAttribute('data-hot'), '1', 'a new wire stands out');
    assert.equal(wires()[0]!.getAttribute('data-grow'), '1');
    assert.equal(dr().focused || cardsNow()[0]!.querySelector('.fold')!.focused, false, 'and takes no focus');
    mono += 3000;
    await tick();
    assert.equal(wires()[0]!.getAttribute('data-hot'), '0', 'then it goes back to faint');
    assert.equal(wires()[0]!.getAttribute('data-grow'), '0');
    // The pointer on the row or the card makes it stand out, and leaving takes that back.
    fire(talk, 'pointerover', { type: 'pointerover', target: dr() });
    await flush();
    assert.equal(wires()[0]!.getAttribute('data-hot'), '1');
    assert.equal(cardsNow()[0]!.getAttribute('data-hot'), '1');
    fire(talk, 'pointerleave', { type: 'pointerleave', target: talk });
    await flush();
    assert.equal(wires()[0]!.getAttribute('data-hot'), '0');
    // A click on the row opens the card, and an open card keeps its wire lit; a second click folds it.
    assert.equal(cardsNow()[0]!.querySelector('.fold')!.getAttribute('aria-expanded'), 'false');
    await click(dr());
    assert.equal(cardsNow()[0]!.querySelector('.fold')!.getAttribute('aria-expanded'), 'true');
    assert.equal(dr().getAttribute('aria-expanded'), 'true');
    assert.equal(wires()[0]!.getAttribute('data-hot'), '1');
    await click(dr());
    assert.equal(cardsNow()[0]!.querySelector('.fold')!.getAttribute('aria-expanded'), 'false');
    // Scrolled out, its wire is taken in; back, it is drawn again.
    talk.rect = { ...talk.rect, top: 300, bottom: 320, height: 20 };
    fire(talk, 'scroll');
    await flush();
    assert.equal(wires().length, 0);
    talk.rect = { ...talk.rect, top: 100, bottom: 500, height: 400 };
    fire(win, 'resize');
    await flush();
    // A command folding open moves the rows with no scroll and no new size: the wire follows on the next frame.
    assert.equal(wires().length, 1);
    const moved = dr().rect;
    dr().rect = { ...moved, top: 900, bottom: 930 };
    fire(talk, 'toggle');
    await flush();
    assert.equal(wires().length, 0);
    dr().rect = moved;
    fire(talk, 'toggle');
    await flush();
    // An open card whose row left the talk (pushed out of the last 200) keeps no lit border: it has no wire to stand out for.
    await click(dr());
    assert.equal(cardsNow()[0]!.getAttribute('data-hot'), '1');
    sent = [...sent, ...Array.from({ length: 201 }, (_, i) => ({ seq: 4 + i, at: 1, kind: 'text', ref: 'f' + i, uuid: null, text: 'x', state: 'final', redactions: 0, live: false, exitCode: null, tokens: null, batch: null }))];
    await tick();
    assert.equal(talk.querySelectorAll('.dr').length, 0);
    assert.equal(cardsNow()[0]!.querySelector('.fold')!.getAttribute('aria-expanded'), 'true');
    assert.equal(cardsNow()[0]!.getAttribute('data-hot'), '0');
    sent = [];
    seats = [{ ...seats[0]!, members: [member(1, { name: EVIL }), member(2, { state: 'returned' })] }, ...seats.slice(1)];
    await tick();

    // Folded unless clicked; a poll does not open or close it.
    const fold = () => byId('subs').querySelector('.fold')!;
    assert.equal(fold().getAttribute('aria-expanded'), 'true');
    assert.equal(byId('subs').querySelectorAll('.mem').length, 2);
    assert.equal(byId('subs').querySelector('[data-slot=dots]')!.children.length, 2);
    await click(fold());
    assert.equal(fold().getAttribute('aria-expanded'), 'false');
    await tick();
    assert.equal(fold().getAttribute('aria-expanded'), 'false');
    assert.equal(byId('subs').querySelectorAll('.mem').length, 0);

    // The list opens over the chat: a chat at its end stays there, though by then it is shorter and no longer looks it.
    const chatEl = byId('detail').querySelector('[data-slot=chat]')! as any;
    Object.defineProperty(chatEl, 'clientHeight', { configurable: true, get: () => (hidden(byId('pins')) ? 500 : 440) });
    Object.assign(chatEl, { scrollHeight: 1000, scrollTop: 500 });
    fire(chatEl, 'scroll');

    // The capsule's number is the length of the list it opens; the way there is whole.
    const n = () => Number(/\d+/.exec(byId('isl').querySelector('[data-slot=capWn]')!.textContent)![0]);
    assert.equal(hidden(byId('pins')), true);
    assert.ok(n() >= 2);
    await click(byId('cap-wait'));
    assert.equal(byId('cap-wait').getAttribute('aria-expanded'), 'true');
    assert.equal(chatEl.scrollTop, 1000, 'it follows');

    // The window grows shorter between two frames: a chat at its end stays there, or it would not follow again; one read further up stays put.
    const shrink = (h: number) => { Object.defineProperty(chatEl, 'clientHeight', { configurable: true, value: h }); resized.get(chatEl)!(); };
    Object.assign(chatEl, { scrollHeight: 1400, scrollTop: 960 });
    await tick();
    Object.assign(chatEl, { scrollTop: 960 }); // as far as a real one goes: this fake takes any number
    shrink(400);
    assert.equal(chatEl.scrollTop, 1400, 'the end stays in view');
    // The same, with the frame first (a frame's callbacks run before a new size is told): the render does not take the shorter chat for a reader who left.
    Object.assign(chatEl, { scrollTop: 1000 });
    Object.defineProperty(chatEl, 'clientHeight', { configurable: true, value: 350 });
    await tick();
    assert.equal(chatEl.scrollTop, 1400, 'it follows through a frame too');
    Object.assign(chatEl, { scrollTop: 200 });
    fire(chatEl, 'scroll');
    await tick();
    shrink(330);
    assert.equal(chatEl.scrollTop, 200, 'a reader further up is left there');
    Object.assign(chatEl, { scrollHeight: 1000, scrollTop: 560 });
    Object.defineProperty(chatEl, 'clientHeight', { configurable: true, get: () => (hidden(byId('pins')) ? 500 : 440) });
    fire(chatEl, 'scroll');
    await tick();
    const pins = () => byId('pins').querySelectorAll('.pin');
    assert.equal(pins().length, n());
    const pinOf = (id: string) => pins().find((p) => p.getAttribute('data-node') === `n:${id}`)!;
    assert.ok(pinOf(ID.b).querySelector('[data-slot=path]')!.textContent.startsWith(`${TOWER_TEXT['pin.you']} › `));

    // High risk: a click is no allow, and a tainted session's takes the typed word, as on the old page.
    mono += 2000; // past the 750 ms after the list moved
    await flush();
    const allowIn = (el: FakeElement) => el.querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'allow');
    const high = allowIn(pinOf(ID.a))!;
    assert.equal(high.getAttribute('data-high'), '1');
    await click(high);
    assert.equal(prompts.length, 1, 'a click on a held allow goes the typed way');
    assert.equal(posts('/allow').length, 0);
    const tainted = allowIn(pinOf(ID.b))!;
    assert.equal(tainted.getAttribute('data-high'), '2');
    fire(doc, 'pointerdown', { target: tainted });
    assert.equal(timeouts.filter((t) => t.ms === 1000 && !t.off).length, 0, 'no hold starts on a typed-only allow');
    promptAnswer = 'yes';
    await click(tainted);
    assert.equal(posts('/allow').length, 0, 'the wrong word allows nothing');
    promptAnswer = TOWER_TEXT['appr.typeWord']!;
    await click(tainted);
    assert.equal(posts(`/api/approvals/${AP.b}/allow`).length, 1, 'the typed word goes down the existing route');
    await click(pinOf(ID.a).querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'deny'));
    assert.equal(posts(`/api/approvals/${AP.a}/deny`).length, 1);

    // The list moved on the page under a pointer (opened, a composer of another height), no change of it to say so: a
    // click that lands on a button there is void, an allow and a no alike, for the 750 ms of r4 §10.9.
    list.approvals[0] = approval(AP.a, ID.a, { high: false, deadline: OBSERVED + 10 * MIN });
    await tick();
    const isl = byId('isl') as any;
    isl.offsetHeight = 480;
    await tick();
    const noteText = () => byId('note').textContent;
    const plain = allowIn(pinOf(ID.a))!;
    assert.equal(plain.getAttribute('data-high'), '0');
    assert.equal(plain.getAttribute('aria-disabled'), 'true');
    await click(plain);
    assert.equal(posts(`/api/approvals/${AP.a}/allow`).length, 0, 'the second click of a double click allows nothing');
    assert.equal(noteText(), TOWER_TEXT['appr.settling']);
    await click(pinOf(ID.a).querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'deny'));
    assert.equal(posts(`/api/approvals/${AP.a}/deny`).length, 1, 'nor does it deny');
    assert.equal(noteText(), TOWER_TEXT['home.moved']);
    mono += 800;
    await tick();
    await click(allowIn(pinOf(ID.a)));
    assert.equal(posts(`/api/approvals/${AP.a}/allow`).length, 1, 'settled, it counts');

    // A chat read further up is left there when the list closes.
    chatEl.scrollTop = 100;
    fire(chatEl, 'scroll');
    await click(byId('cap-wait'));
    assert.equal(chatEl.scrollTop, 100);

    // The last one answered, an open list folds: no open capsule over nothing, and the next one waits folded until clicked.
    await click(byId('cap-wait'));
    assert.equal(byId('cap-wait').getAttribute('aria-expanded'), 'true');
    barEmpty = true;
    await tick();
    assert.equal(n(), 0);
    assert.equal(byId('cap-wait').getAttribute('aria-expanded'), 'false');
    barEmpty = false;
    await tick();
    assert.ok(n() > 0);
    assert.equal(hidden(byId('pins')), true);
    assert.equal(byId('cap-wait').getAttribute('aria-expanded'), 'false');

    // The composer and the stops of an owned session.
    const btnActs = () => byId('dock').querySelectorAll('button').map((b) => b.getAttribute('data-act'));
    assert.deepEqual(btnActs(), ['send', 'interrupt', 'end', 'brake']);
    assert.equal(hidden(byId('dock-in')), false);

    // A read-only session: its events, and no way to approve, write or stop.
    const roB = byId('rail').querySelector('.ro-b')!;
    assert.equal(roB.getAttribute('aria-expanded'), 'false');
    await click(roB);
    const ro = byId('rail').querySelector('[data-slot=ro]')!;
    assert.equal(ro.children.length, Number(/\d+/.exec(byId('rail').querySelector('[data-slot=roH]')!.textContent)![0]));
    await click(ro.children[0]!.querySelector('.rr'));
    await flush();
    assert.deepEqual(btnActs(), []);
    assert.equal(hidden(byId('dock-in')), true);
    assert.equal(byId('dock').querySelector('[data-slot=note]')!.textContent, TOWER_TEXT['dock.readonlyOpen'], 'unlocked: it does not tell you to unlock');
    assert.equal(byId('detail').querySelectorAll('.btn').length, 0);
    assert.equal(hidden(byId('detail').querySelector('[data-slot=ownBox]')), true);
    assert.equal(byId('detail').querySelector('[data-slot=events]')!.textContent.includes(EVIL), true);
    assert.equal(doc.querySelectorAll('img').length, 0);

    // Folded by hand it stays folded, the session still selected: a poll is nobody asking to see its row.
    await click(roB);
    assert.equal(roB.getAttribute('aria-expanded'), 'false');
    await tick();
    await tick();
    assert.equal(roB.getAttribute('aria-expanded'), 'false');
    // A route that lands on it from elsewhere opens the group.
    const roHash = loc.hash;
    await click(row('quiet one'));
    loc.hash = roHash;
    fire(win, 'hashchange');
    await flush();
    assert.equal(roB.getAttribute('aria-expanded'), 'true');

    // A worker's first look plays nothing; a card that appears later comes out once.
    await click(row('quiet one'));
    assert.equal(byId('subs').querySelector('[data-slot=note]')!.textContent, TOWER_TEXT['home.subsNone']);
    seats = seats.map((s) => (s.ownedId === ID.c ? { ...s, members: [member(9)] } : s));
    await tick();
    const card = byId('subs').querySelector('.cw')!;
    assert.equal(card.getAttribute('data-fresh'), '1');
    assert.equal(fold().getAttribute('aria-expanded'), 'false', 'it comes out folded');
    assert.equal(loc.hash, `#/n/n:${ID.c}`, 'the reader stays on the worker');
    mono += 1000;
    await tick();
    assert.equal(card.getAttribute('data-fresh'), '0', 'once');

    // The left list holds under the pointer: the row aimed at is still there when the click lands.
    const order = () => byId('rail').querySelector('[data-slot=own]')!.children.map((li) => li.querySelector('.rr')!.getAttribute('data-node'));
    const before = order();
    fire(byId('rail'), 'pointerenter');
    seats = seats.map((s) => (s.ownedId === ID.a ? { ...s, lastAt: OBSERVED - MIN } : s));
    await tick();
    assert.deepEqual(order(), before, 'the snapshot swapped them, the list did not');
    fire(byId('rail'), 'pointerleave');
    await tick();
    assert.deepEqual(order(), before, 'it holds a while after, as the old tree');
    timeouts.find((t) => t.ms === 5000 && !t.off)!.fn();
    await flush();
    assert.notDeepEqual(order(), before);

    // A draft held its recipient and the recipient ended: the box that could free it is gone, the others stay reachable.
    await click(row('quiet one'));
    (byId('dock-in') as any).value = 'draft';
    fire(doc, 'input', { target: byId('dock-in') });
    await flush();
    assert.ok(byId('dock').querySelector('[data-slot=note]')!.textContent.includes(TOWER_TEXT['dock.lockedTo']!));
    seats = seats.map((s) => (s.ownedId === ID.c ? { ...s, state: 'ended' } : s));
    list.owned = list.owned.map((o: Json) => (o.ownedId === ID.c ? { ...o, state: 'ended' } : o));
    await tick();
    assert.equal(hidden(byId('dock-in')), true);
    assert.ok(byId('note').textContent.startsWith('quiet one '));
    await click(row('tainted one'));
    assert.equal(byId('dock').querySelector('[data-slot=to]')!.textContent, '发给 → tainted one');
    assert.equal(hidden(byId('dock-in')), false);
    assert.equal((byId('dock-in') as any).value, 'draft', 'the draft stays');
    assert.equal(btnActs()[0], 'send');
    (byId('dock-in') as any).value = '';

    // n opens the dispatch desk, but not from a field; the desk is the old one.
    fire(doc, 'keydown', { key: 'n', target: byId('dock-in') });
    assert.equal(byId('new-dlg').open, false);
    fire(doc, 'keydown', { key: 'n', target: byId('rail'), ctrlKey: true });
    assert.equal(byId('new-dlg').open, false);
    const ev = fire(doc, 'keydown', { key: 'n', target: doc.body });
    assert.equal(ev.prevented, true);
    assert.equal(byId('new-dlg').open, true);
    assert.equal(byId('nw-text').focused, true);
    byId('new-dlg').close();

    // Nothing on this page reaches past the routes the old page uses.
    const allowed = /^\/api\/(?:tower|owned(?:\/[0-9a-f]{20}\/feed\?after=\d+)?|peek\/session\?id=[0-9a-f]{20}|approvals\/[0-9a-f]{32}\/(?:allow|deny))$/;
    for (const r of requests) assert.match(r.url, allowed);
  } finally {
    for (const k of keys) {
      const d = saved[k];
      if (d === undefined) delete g[k];
      else Object.defineProperty(g, k, d);
    }
  }
});

test('describeFold takes only members: a card of none draws no marks', () => {
  const d = describeFold({ key: 'k', title: 't', members: [], open: false }) as any;
  assert.equal(d.slots.dots.kids.length + d.slots.bar.kids.length, 0);
  assert.equal(d.slots.n.text, '0 个');
});

test('home.css: a request\'s long head wraps instead of pushing its buttons out; the note and the dock\'s empty note move nothing under the pointer', () => {
  assert.match(CSS, /\.req-h \.pin-kind \{[^}]*white-space: normal/);
  assert.match(CSS, /\.note \{[^}]*position: absolute/);
  assert.match(CSS, /\.dock-note \{[^}]*min-height/);
  assert.doesNotMatch(CSS, /\.dock-note:empty/);
});
