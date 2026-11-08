import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeElement, parseHtml, type FakeDocument } from '../helpers/fake-dom.ts';
import { busyStage } from '../helpers/tower-fixture.ts';
import { makePatcher } from '../../ui/dom.js';
import { MAX_DOTS } from '../../ui/fold.js';
import { getRightOpen, setRightOpen } from '../../ui/prefs.js';
import { clipsOf, describeRunCap, describeRunList, describeRunPage, runCards, runSince } from '../../ui/wings.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { towerFromStage, type OwnedMember, type OwnedSeat } from '../../src/sources/tower.ts';

// The home page's running panel (第三轮 mock 21's roster panel, 2026-11-05): the capsule beside 「等你」, the right side
// shut until it is clicked, a card a worker going on, and a worker's page pushed over the cards. What it proves: only
// what was reported counts as going on, never a guess or unknown (T1); the capsule's names and number, the cards and a
// page's rows are one snapshot's (T3); the page takes no action (D8); opening or shutting the side voids an allow a
// while, as a moved list does; Esc and the way back put the focus where it was. Synthetic data only.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HTML = read('ui/home.html');
const CSS = read('ui/home.css');
const HOME = pathToFileURL(path.join(REPO, 'ui/home.js')).href;
type Json = Record<string, any>;

let serial = 0;
const hex = () => (++serial).toString(16).padStart(20, '0');
const node = (over: Json = {}): Json => ({
  id: `n:${hex()}`, session: null, harness: 'codex', ownership: 'owned', layer: 'subagent', parent: null, depth: 1,
  title: `m${serial}`, activity: null, state: 'running', basis: 'owned', waiting: null, counts: { children: 0, errors: 0, waiting: 0 }, groups: [],
  ageMs: 0, durationMs: null, model: null, agentType: null, batch: null, mark: null, sent: null, ...over,
});
/** A worker: a root, owned unless said otherwise. */
const root = (over: Json = {}) => node({ layer: 'agent', parent: null, depth: 0, ...over });
const ro = (over: Json = {}) => root({ ownership: 'observed', harness: 'claude', basis: 'registry', ...over });
const kid = (parent: Json, over: Json = {}) => node({ parent: parent.id, depth: parent.depth + 1, ownership: parent.ownership, harness: parent.harness, basis: parent.basis, ...over });
const snapOf = (...projects: Json[][]): any => ({
  meta: { detects: { error: true }, sources: { claude: { state: 'ok' }, dsh: { state: 'ok' }, codex: { state: 'ok' } }, clipped: { projects: 0, nodes: 0, sessions: { claude: 0, dsh: 0, codex: 0 } }, profile: 'test' },
  router: { kind: 'human', dispatch: null, asks: [] }, waitingBar: [], tally: { waiting: 0 },
  projects: projects.map((nodes, i) => ({ id: String(i).repeat(20), name: `p${i}`, basis: 'cwd', groups: [], nodes })),
});

function page() {
  const doc = parseHtml(HTML);
  const dom = makePatcher(doc as unknown as Document);
  dom.fillStatic();
  return { doc, dom };
}
const hidden = (el: FakeElement | null) => el!.getAttribute('data-hide') === '1';
const text = (el: FakeElement, slot: string) => el.querySelector(`[data-slot=${slot}]`)!.textContent;
/** What D8 keeps to a worker's talk and 「等你」: none of it may stand on the right side. */
const ACTIONS = ['allow', 'deny', 'req-go', 'req-no', 'brake', 'stop-worker', 'interrupt', 'end', 'send', 'grant'];

/** The capsule, the list and a page of one run, painted into the real page. */
function paintRun(snap: any, o: { page?: string | null; list?: any; nowWall?: number; open?: boolean } = {}) {
  const p = page();
  const run = runCards(snap, []);
  p.dom.paintId('isl', { slots: describeRunCap(run, { open: o.open ?? false, clipped: clipsOf(snap).total }) } as any);
  p.dom.paintId('run', describeRunList(run, { list: o.list ?? null, nowWall: o.nowWall ?? 0, clipped: clipsOf(snap) }) as any);
  p.dom.paintId('run-page', describeRunPage(run, { page: o.page ?? null, title: 'last seen', list: o.list ?? null, nowWall: o.nowWall ?? 0 }) as any);
  const byId = (id: string) => p.doc.getElementById(id)!;
  return { ...p, run, byId, cards: byId('run').querySelectorAll('.cw'), cap: byId('cap-run') };
}

test('T1: a worker is going on only when a member runs or waits on you as reported; a guess is counted apart, unknown and the rest not at all', () => {
  const going = root({ title: 'owned runs' });
  const idleParent = root({ title: 'idle, its sub-agent runs', state: 'idle' });
  const sub = kid(idleParent, { state: 'running' });
  const asks = root({ title: 'idle, a sub-agent asks', state: 'idle' });
  const asking = kid(asks, { mark: 'asks' });
  const waitsRo = ro({ title: 'ro waits', state: 'waiting', waiting: { kind: 'approval', source: 'native', deadline: null } });
  const byLog = ro({ title: 'by log', state: 'running', basis: 'log' });
  const byWrite = ro({ title: 'by write', state: 'running', basis: 'mtime' });
  const inferred = ro({ title: 'inferred wait', state: 'waiting', waiting: { kind: 'approval', source: 'inferred', deadline: null } });
  const idleGuess = ro({ title: 'idle by write', state: 'idle', basis: 'mtime' });
  const unknown = ro({ title: 'unknown', state: 'unknown', basis: 'none' });
  const failed = root({ title: 'failed', state: 'error' });
  const failedSub = root({ title: 'a sub-agent failed', state: 'idle' });
  const failedKid = kid(failedSub, { state: 'ended', mark: 'failed' });
  const back = root({ title: 'returned', state: 'idle' });
  const backKid = kid(back, { state: 'returned' });
  const s = snapOf(
    [going, idleParent, sub, asks, asking, failed, failedSub, failedKid, back, backKid],
    [waitsRo, byLog, byWrite, inferred, idleGuess, unknown],
  );
  const run = runCards(s, []);
  assert.deepEqual(run.cards.map((c) => c.node.title).sort(), ['idle, a sub-agent asks', 'idle, its sub-agent runs', 'owned runs', 'ro waits'].sort());
  assert.equal(run.guessed, 3, 'by log, by write and the inferred wait; an idle guessed from a write is no guess that it runs');
  assert.equal(run.all.size, 12, 'every worker for its page, going or not; a sub-agent is none');
  assert.ok(run.all.has(unknown.id));
  // Painted: a guessed member is never a solid running mark (T1).
  const ownGuess = root({ title: 'owned, a guessed member', state: 'running' });
  const g = paintRun(snapOf([ownGuess, kid(ownGuess, { state: 'running', basis: 'log', ownership: 'observed' })]), { page: ownGuess.id });
  const dots = g.cards[0]!.querySelector('[data-slot=dots]')!.children.map((d) => d.getAttribute('class'));
  assert.deepEqual(dots, ['fd fd-run', 'fd fd-guess']);
  assert.deepEqual(g.byId('run-page').querySelectorAll('.mem').map((m) => m.querySelector('[data-slot=dot]')!.getAttribute('class')), ['fd fd-run', 'fd fd-guess']);
});

test('the cards\' order: free, those that wait on you first, then Orchestra\'s own, by name; held, as drawn, newcomers last', () => {
  const b = root({ title: 'b-own' });
  const a = root({ title: 'a-own' });
  const w = ro({ title: 'z-ro waits', state: 'waiting', waiting: { kind: 'question', source: 'native', deadline: null } });
  const r = ro({ title: 'c-ro runs', state: 'running' });
  const s = snapOf([b, a], [r, w]);
  assert.deepEqual(runCards(s, []).cards.map((c) => c.node.title), ['z-ro waits', 'a-own', 'b-own', 'c-ro runs']);
  assert.deepEqual(runCards(s, [r.id, b.id, 'n:gone']).cards.map((c) => c.node.title), ['c-ro runs', 'b-own', 'a-own', 'z-ro waits'], 'held: as drawn, the rest in the snapshot\'s order');
  // A card's members go by name, whatever the snapshot's rank: the same rows poll to poll.
  const k1 = kid(a, { title: 'sub-10' });
  const k2 = kid(a, { title: 'sub-2' });
  const names = (nodes: Json[]) => runCards(snapOf(nodes), []).all.get(a.id)!.members.map((m) => m.node.title);
  assert.deepEqual(names([a, k1, k2]), ['a-own', 'sub-2', 'sub-10']);
  assert.deepEqual(names([k2, a, k1]), names([a, k1, k2]));
});

test('the capsule: its names and +N are the cards it opens (T3); none, a guess, unknown each say so; what failed under them is their flags\' sum', () => {
  const cap = (s: any | null, open = false) => {
    const c = describeRunCap(s === null ? null : runCards(s, []), { open }) as any;
    return { w: c.capRw.text, n: c.capRn.text, zero: c.capR.data.zero, exp: c.capR.attr['aria-expanded'], title: c.capR.attr.title, e: c.capRe };
  };
  assert.deepEqual(cap(null), { w: '', n: TOWER_TEXT['run.capUnknown'], zero: '1', exp: 'false', title: TOWER_TEXT['run.capUnknown'], e: { text: '成员出错 0', data: { hide: '1' } } });
  assert.equal(cap(snapOf([root({ state: 'idle' })])).n, TOWER_TEXT['run.capNone']);
  assert.equal(cap(snapOf([ro({ state: 'running', basis: 'log' })])).n, TOWER_TEXT['run.capNoneGuess'], 'a guess is no card, and is not hidden either');
  assert.equal(cap(snapOf([root({ title: 'one' })])).w, 'one');
  const two = cap(snapOf([root({ title: 'one' }), root({ title: 'two' })]), true);
  assert.deepEqual([two.w, two.n, two.zero, two.exp, two.title], ['one、two', '正在做', '0', 'true', '正在做：one、two']);
  const many = [root({ title: 'w1' }), root({ title: 'w2' }), root({ title: 'w3' }), root({ title: 'w4' })];
  const failedA = kid(many[0]!, { state: 'ended', mark: 'failed' });
  const failedB = kid(many[2]!, { state: 'error' });
  const s = snapOf([...many, failedA, failedB]);
  const c = cap(s);
  assert.deepEqual([c.w, c.n], ['w1、w2', '正在做 · +2']);
  assert.deepEqual(c.e, { text: '成员出错 2', data: { hide: '0' } });
  // Its words are its own: 「出错」 beside it counts the builds' failures, another list (T3).
  assert.notEqual(TOWER_TEXT['run.capErr']!.replace('{n}', '2'), TOWER_TEXT['home.capErr']!.replace('{n}', '2'));
  // Painted: as many names as shown plus N is the list's length, and the flags on the cards add up to the capsule's.
  const p = paintRun(s);
  const shown = text(p.cap, 'capRw').split('、').length + Number(/\+(\d+)/.exec(text(p.cap, 'capRn'))![1]);
  assert.equal(shown, p.cards.length);
  const flags = p.cards.map((cw) => cw.querySelector('[data-slot=fe]')!).filter((f) => !hidden(f)).reduce((k, f) => k + Number(/\d+/.exec(f.textContent)![0]), 0);
  assert.equal(flags, 2);
  assert.equal(p.cap.getAttribute('data-zero'), '0');
  assert.equal(p.byId('run').querySelector('[data-slot=n]')!.textContent, '4 个');
});

test('a card: name, kind, members and how long open; a dot a member, past 16 a bar of as many; flags; a push, not an open', () => {
  const own = root({ title: 'airi-components', harness: 'codex' });
  const subs = Array.from({ length: 3 }, (_, i) => kid(own, { title: `s${i}`, state: i === 0 ? 'running' : 'returned' }));
  const asksKid = kid(own, { mark: 'asks', title: 's9' });
  const big = ro({ title: 'big', state: 'running' });
  const many = Array.from({ length: MAX_DOTS }, (_, i) => kid(big, { title: `b${i}`, state: 'running' }));
  const s = snapOf([own, ...subs, asksKid], [big, ...many]);
  const list = { owned: [{ ownedId: own.id.slice(2), createdAt: 10_000 }] };
  const p = paintRun(s, { list, nowWall: 10_000 + 26 * 60_000 + 7_000 });
  const [a, b] = [p.cards.find((c) => text(c, 'title') === 'airi-components')!, p.cards.find((c) => text(c, 'title') === 'big')!];
  assert.deepEqual(['kind', 'n', 'took'].map((k) => text(a, k)), ['Codex', '5 个成员', '开了 26 分']);
  assert.equal(a.querySelector('[data-slot=dots]')!.children.length, 5, 'the worker and its four');
  assert.equal(text(a, 'fw'), '等你 1');
  assert.equal(hidden(a.querySelector('[data-slot=fw]')), false);
  assert.equal(hidden(a.querySelector('[data-slot=fe]')), true);
  const btn = a.querySelector('[data-slot=b]')!;
  assert.equal(btn.getAttribute('data-act'), 'run-card');
  assert.equal(btn.getAttribute('data-run'), own.id);
  assert.equal(btn.hasAttribute('aria-expanded'), false, 'it opens nothing in place');
  assert.deepEqual(['kind', 'n', 'took'].map((k) => text(b, k)), ['Claude · 只读', `${MAX_DOTS + 1} 个成员`, TOWER_TEXT['run.noSince']]);
  assert.equal(hidden(b.querySelector('[data-slot=dots]')), true);
  assert.equal(b.querySelector('[data-slot=bar]')!.children.length, MAX_DOTS + 1);
  // How long open is not known without the list (locked), or with no time in it.
  const e = runCards(s, []).all.get(own.id)!;
  assert.equal(runSince(e, null, 99), TOWER_TEXT['run.noSince']);
  assert.equal(runSince(e, { owned: [{ ownedId: own.id.slice(2), createdAt: 0 }] }, 99), TOWER_TEXT['run.noSince']);
  assert.equal(runSince(e, list, 10_000 + 5_000), '开了 5 秒');
  // Nothing on the cards acts.
  assert.equal(p.byId('run').querySelectorAll('[data-act]').filter((x) => ACTIONS.includes(x.getAttribute('data-act')!)).length, 0);
});

test('with none going on the list says so, and promises nothing it cannot keep; guesses are said', () => {
  const s = snapOf([root({ state: 'idle' })], [ro({ state: 'running', basis: 'mtime' })]);
  const p = paintRun(s);
  assert.equal(p.cards.length, 0);
  assert.equal(p.byId('run').querySelector('[data-slot=n]')!.textContent, '');
  assert.equal(p.cap.getAttribute('data-zero'), '1');
  const note = p.byId('run').querySelector('[data-slot=note]')!.textContent;
  assert.equal(note, [TOWER_TEXT['run.none'], TOWER_TEXT['run.guessed']!.replace('{n}', '1')].join('；'));
  assert.doesNotMatch(TOWER_TEXT['run.none']!, /收起|出错/, 'shutting the side is not said to keep what it holds');
});

test('T1: what the limits left out, sessions, projects or nodes, makes none a none read, in the capsule and the list', () => {
  for (const [what, set] of [['sessions', (s: any) => { s.meta.clipped.sessions.claude = 12; }], ['projects', (s: any) => { s.meta.clipped.projects = 2; }], ['nodes', (s: any) => { s.meta.clipped.nodes = 5; }]] as const) {
    const s = snapOf([root({ state: 'idle' })]);
    set(s);
    const total = clipsOf(s).total;
    const p = paintRun(s);
    assert.equal(p.cards.length, 0, what);
    assert.equal(text(p.cap, 'capRn'), TOWER_TEXT['run.capNoneClipped']!.replace('{n}', String(total)), what);
    assert.notEqual(text(p.cap, 'capRn'), TOWER_TEXT['run.capNone']);
    const c = clipsOf(s);
    assert.equal(p.byId('run').querySelector('[data-slot=note]')!.textContent, [TOWER_TEXT['run.noneClipped'], TOWER_TEXT['run.clipped']!.replace('{s}', String(c.sessions)).replace('{p}', String(c.projects)).replace('{n}', String(c.nodes))].join('；'), what);
  }
  // Nothing left out: none is none.
  assert.equal(text(paintRun(snapOf([root({ state: 'idle' })])).cap, 'capRn'), TOWER_TEXT['run.capNone']);
});

test('T3: a card\'s 等你 and its page\'s count the same marks; a guessed wait is neither a solid flag nor first in line (T1)', () => {
  for (const over of [{ state: 'waiting', basis: 'log' }, { state: 'waiting', basis: 'mtime' }, { state: 'waiting', waiting: { kind: 'approval', source: 'inferred', deadline: null } }, { mark: 'asks', basis: 'log' }]) {
    const own = root({ title: 'a-runs' });
    const guess = kid(own, { title: 'guessed wait', ...over });
    const other = root({ title: '0-runs' });
    const s = snapOf([own, guess, other]);
    const p = paintRun(s, { page: own.id });
    const card = p.cards.find((c) => text(c, 'title') === 'a-runs')!;
    const sub = text(p.byId('run-page'), 'sub');
    assert.equal(hidden(card.querySelector('[data-slot=fw]')), true, JSON.stringify(over));
    assert.equal(sub.includes('等你'), false, JSON.stringify(over));
    assert.equal(runCards(s, []).all.get(own.id)!.waits, false);
    assert.equal(text(p.cards[0]!, 'title'), '0-runs', 'a guessed wait is not put first');
    // A reported wait: both say it, the same number.
    const asks = kid(own, { title: 'asks', mark: 'asks' });
    const q = paintRun(snapOf([own, guess, asks, other]), { page: own.id });
    const qc = q.cards.find((c) => text(c, 'title') === 'a-runs')!;
    assert.equal(text(qc, 'fw'), '等你 1');
    assert.ok(text(q.byId('run-page'), 'sub').includes('等你 1'));
    assert.equal(text(q.cards[0]!, 'title'), 'a-runs', 'what waits on you goes first');
  }
  // An owned session waits for its members' approvals (they never wait themselves, they ask): its own wait is theirs, not
  // one more, so two asking is 等你 2, as the capsule counts their two approvals; alone, its wait is one.
  const own = root({ title: 'w', state: 'waiting', waiting: { kind: 'approval', source: 'orchestra', deadline: 1 } });
  const two = paintRun(snapOf([own, kid(own, { mark: 'asks' }), kid(own, { mark: 'asks' }), kid(own)]), { page: own.id });
  assert.equal(text(two.cards[0]!, 'fw'), '等你 2');
  assert.ok(text(two.byId('run-page'), 'sub').includes('等你 2'));
  const lone = paintRun(snapOf([own, kid(own)]), { page: own.id });
  assert.equal(text(lone.cards[0]!, 'fw'), '等你 1');
});

test('a sub-agent that failed under a worker going on no more: a card apart, counted on the capsule, which no shut side hides', () => {
  const idle = root({ title: 'idle owned', state: 'idle' });
  const failedKid = kid(idle, { state: 'ended', mark: 'failed' });
  const ended = root({ title: 'ended, all fine', state: 'ended' });
  const s = snapOf([idle, failedKid, ended, kid(ended, { state: 'returned' })]);
  const run = runCards(s, []);
  assert.deepEqual([run.cards.length, run.failed.map((e) => e.node.title)], [0, ['idle owned']]);
  const p = paintRun(s);
  // The capsule stands outside the right side, so it says 出错 with the side shut.
  assert.equal(p.byId('right').contains(p.cap), false);
  assert.deepEqual([text(p.cap, 'capRe'), hidden(p.cap.querySelector('[data-slot=capRe]'))], [TOWER_TEXT['run.capErr']!.replace('{n}', '1'), false]);
  // The list it opens: the cards going on (none) and, apart, this one with its flag; the count is that list's (T3).
  const run2 = p.byId('run');
  assert.equal(hidden(run2.querySelector('[data-slot=fh]')), false);
  const apart = run2.querySelector('[data-slot=flist]')!.querySelectorAll('.cw');
  assert.equal(apart.length, 1);
  assert.equal(text(apart[0]!, 'fe'), '出错 1');
  assert.equal(text(p.cap, 'capRn'), TOWER_TEXT['run.capNone'], 'it is named as going on nowhere');
  // Its page says it is going on no more.
  assert.ok(text(paintRun(s, { page: idle.id }).byId('run-page'), 'note').startsWith(TOWER_TEXT['run.pageNotNow']!));
  // None failed: nothing apart.
  assert.equal(hidden(paintRun(snapOf([root({ state: 'idle' })])).byId('run').querySelector('[data-slot=fh]')), true);
});

test('a worker\'s page: a row a mark of its card (T3), only its own row leads to its talk, no action (D8); one that stopped or left says so', () => {
  const own = root({ title: 'w' });
  const k1 = kid(own, { title: 'k1', state: 'running' });
  const k2 = kid(k1, { title: 'k2', state: 'returned' });
  const quiet = ro({ title: 'quiet ro', state: 'idle' });
  const s = snapOf([own, k1, k2], [quiet]);
  const p = paintRun(s, { page: own.id });
  const pg = p.byId('run-page');
  assert.equal(hidden(pg), false);
  const rows = pg.querySelectorAll('.mem');
  assert.equal(rows.length, p.cards[0]!.querySelector('[data-slot=dots]')!.children.length);
  assert.deepEqual(rows.map((r) => r.getAttribute('data-depth')), ['0', '1', '2']);
  const go = rows.map((r) => r.querySelector('[data-slot=go]')!);
  assert.deepEqual(go.map(hidden), [false, true, true]);
  assert.equal(go[0]!.getAttribute('data-act'), 'worker');
  assert.equal(go[0]!.getAttribute('data-node'), own.id);
  assert.equal(text(pg, 'title'), 'w');
  assert.equal(text(pg, 'sub'), 'Codex · 3 个成员 · 开了多久未知');
  assert.equal(text(pg, 'note'), TOWER_TEXT['run.pageActs']);
  for (const id of ['run', 'run-page']) assert.equal(p.byId(id).querySelectorAll('[data-act]').filter((x) => ACTIONS.includes(x.getAttribute('data-act')!)).length, 0, id);
  // Not going on now: its rows all the same, and a word why it has no card.
  const q = paintRun(s, { page: quiet.id }).byId('run-page');
  assert.ok(text(q, 'note').startsWith(TOWER_TEXT['run.pageNotNow']!));
  assert.equal(q.querySelectorAll('.mem').length, 1);
  assert.equal(hidden(q.querySelector('[data-slot=go]')), false, 'a read-only session has a talk on the left too');
  // Gone from the snapshot: its last title, and said.
  const gone = paintRun(s, { page: 'n:'.padEnd(22, 'f') }).byId('run-page');
  assert.deepEqual([text(gone, 'title'), text(gone, 'note'), gone.querySelectorAll('.mem').length], ['last seen', TOWER_TEXT['run.pageGone'], 0]);
  assert.equal(hidden(paintRun(s).byId('run-page')), true);
});

test('home.html and home.css: a capsule that controls the right side, shut by default, a drawer on a phone, a card that pushes', () => {
  const doc = parseHtml(HTML);
  const cap = doc.getElementById('cap-run')!;
  assert.deepEqual([cap.localName, cap.getAttribute('aria-controls'), cap.getAttribute('aria-expanded'), cap.getAttribute('data-act')], ['button', 'right', 'false', 'run']);
  assert.equal(cap.parentNode, doc.getElementById('cap-wait')!.parentNode, 'beside 「等你」');
  assert.equal(doc.getElementById('right')!.getAttribute('data-open'), '0');
  assert.equal(doc.getElementById('run-h')!.getAttribute('tabindex'), '-1');
  assert.equal(doc.getElementById('rpg-h')!.getAttribute('tabindex'), '-1');
  const tpl = doc.getElementById('tpl-run')!.content!.firstElementChild!;
  assert.equal(tpl.querySelector('button')!.hasAttribute('aria-expanded'), false);
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(body, /\.right\[data-open="0"\] \{ display: none; \}/);
  assert.match(body, /\.wings:has\(> \.right\[data-open="0"\]\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(body, /\.right\[data-page="card"\] > \.run, \.right\[data-page="card"\] > \.team, \.right\[data-page="card"\] > \.subs \{ display: none; \}/);
  assert.match(body, /\.cap-run \{[^}]*min-width: 0/);
  const phone = body.slice(body.indexOf('@media (max-width: 899px)'), body.indexOf('@media (prefers-reduced-motion'));
  assert.match(phone, /\.right \{ position: fixed;[^}]*z-index: 6;[^}]*width: min\(100vw, 420px\)/);
  // What the drawer covers leaves the Tab order and the reader's tree: the left column (its allows) and the top bar.
  assert.match(phone, /body:has\(\.right\[data-open="1"\]\) > \.top, \.wings:has\(> \.right\[data-open="1"\]\) > \.left \{ visibility: hidden; \}/);
  const up = (id: string) => doc.getElementById(id)!.parentNode as FakeElement;
  assert.deepEqual([up('right').localName, up('right').getAttribute('class')], ['main', 'wings'], 'the rule\'s > holds: the side is the wings\' own');
  assert.equal(doc.getElementById('pins')!.closest('.left') !== null && doc.getElementById('dock-in')!.closest('.left') !== null, true, 'the allows and the composer are the left column\'s');
  assert.equal(up('top').localName, 'body');
  assert.match(phone, /\.cap-run \{ max-width: 100%; \}/);
  // The colours are the kit's tokens, so both themes follow.
  for (const m of body.matchAll(/\.(?:cap-r\w|run[\w-]*|rpg-[\w-]+)[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(m[1]!, /#[0-9a-f]{3,6}\b|rgba?\(/i, m[0]);
});

test('prefs: the right side\'s choice is kept, and blocked storage is a shut side, never a throw', () => {
  const g = globalThis as any;
  const saved = Object.getOwnPropertyDescriptor(g, 'localStorage');
  const store = new Map<string, string>();
  try {
    Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
    assert.equal(getRightOpen(), false);
    setRightOpen(true);
    assert.equal(store.get('orchestra.home.right'), '1');
    assert.equal(getRightOpen(), true);
    Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    assert.equal(getRightOpen(), false);
    setRightOpen(true);
  } finally {
    if (saved === undefined) delete g.localStorage;
    else Object.defineProperty(g, 'localStorage', saved);
  }
});

// == the page booted in the fake DOM, as test/ui/home-page.test.ts does, once per window kind (a fresh module each)

const OBSERVED = towerFromStage(busyStage()).meta.observedAt;
const MIN = 60_000;
const CSRF = 'A'.repeat(43);
const ID = { a: 'a'.repeat(20), b: 'b'.repeat(20), c: 'c'.repeat(20) };
const AP = '2'.repeat(32);
const member = (i: number, over: Partial<OwnedMember> = {}): OwnedMember => ({ threadId: `t${i}`, name: `sub ${i}`, model: null, agentType: null, state: 'running', why: null, startedAt: null, endedAt: null, lastAt: null, failed: 0, ranUnasked: 0, batch: null, asking: null, ...over });
const seat = (ownedId: string, title: string, over: Partial<OwnedSeat> = {}): OwnedSeat => ({ ownedId, harness: 'codex', title, state: 'running', endReason: null, lastAt: OBSERVED, waiting: null, ...over });

async function boot(o: { tag: string; narrow?: boolean; stored?: string | null; blocked?: boolean }, body: (h: any) => Promise<void>) {
  const doc: FakeDocument = parseHtml(HTML);
  const frames: (() => void)[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const requests: { method: string; url: string }[] = [];
  const writes: [string, string][] = [];
  const clock = { mono: 1000 };
  const seats: OwnedSeat[] = [
    seat(ID.a, 'alpha', { members: [member(1), member(2, { state: 'ended', why: 'failed' })] }),
    seat(ID.b, 'bravo', { state: 'idle', waiting: { kind: 'approval', deadline: OBSERVED + 20 * MIN, title: 'req' } }),
    seat(ID.c, 'charlie', { state: 'idle' }),
  ];
  const owned = (id: string, title: string, over: Json = {}) => ({ ownedId: id, harness: 'codex', model: 'codex/gpt-6.1-sol', title, state: 'running', endReason: null, waiting: null, queued: 0, tokens: null, lastSeq: 1, createdAt: OBSERVED - 26 * MIN, ...over });
  const list: Json = {
    v: 1, kind: 'owned-list', rev: 3, enabled: true, disabledWhy: null, brakeWhy: null, harnesses: { codex: true, claude: false }, limits: { maxOwned: 4, active: 3 }, requests: [],
    owned: [owned(ID.a, 'alpha'), owned(ID.b, 'bravo', { state: 'idle', waiting: AP }), owned(ID.c, 'charlie', { state: 'idle' })],
    approvals: [{ approvalId: AP, ownedId: ID.b, kind: 'command', title: 'req', preview: 'command: npm test', tooLong: false, redactions: 0, digest: '2'.repeat(64), risk: 'shell', high: false, tainted: false, canAccept: true, canText: false, questions: null, deadline: OBSERVED + 20 * MIN, rev: 1 }],
  };
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
  const keys = ['document', 'location', 'window', 'fetch', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Element', 'Node', 'localStorage', 'ResizeObserver'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  const realImmediate = setImmediate;
  define('ResizeObserver', class { observe() {} });
  define('document', doc);
  define('location', loc);
  // The window's width can change under the page: the one query it listens to is told so.
  const media = { narrow: o.narrow === true };
  const mq = {};
  define('window', {
    addEventListener: (t: string, fn: (e: any) => void) => on(win, t, fn), prompt: () => null,
    matchMedia: (q: string) => q === '(max-width: 899px)' ? { get matches() { return media.narrow; }, addEventListener: (t: string, fn: (e: any) => void) => on(mq, t, fn) } : { matches: false },
  });
  // Where the focus is, as document.activeElement says it.
  let active: FakeElement | null = null;
  const realFocus = FakeElement.prototype.focus;
  FakeElement.prototype.focus = function (this: FakeElement) { realFocus.call(this); active = this; };
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => active });
  define('performance', { now: () => clock.mono });
  define('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  define('setInterval', (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; });
  define('clearInterval', () => {});
  define('setTimeout', () => 0);
  define('clearTimeout', () => {});
  define('Element', FakeElement);
  define('Node', FakeElement);
  define('localStorage', o.blocked === true
    ? { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }
    : {
      getItem: (k: string) => (k === 'orchestra.home.right' ? writes.findLast((w) => w[0] === k)?.[1] ?? o.stored ?? null : k === 'orchestra.csrf' ? CSRF : null),
      setItem: (k: string, v: string) => { writes.push([k, v]); }, removeItem: () => {},
    });
  const reply = (b: unknown) => ({ status: 200, ok: true, json: async () => structuredClone(b) });
  define('fetch', async (url: string, init: { method?: string } = {}) => {
    requests.push({ method: init.method ?? 'GET', url });
    if (url === '/api/tower') return reply(towerFromStage(busyStage(), { seats, nowWall: OBSERVED }));
    if (url === '/api/owned') return reply(list);
    const m = /^\/api\/owned\/([0-9a-f]{20})\/feed/.exec(url);
    if (m !== null) return reply({ v: 1, kind: 'owned-feed', ownedId: m[1], from: 0, to: 1, clipped: false, events: [] });
    if (url.startsWith('/api/peek/session')) return reply({ session: { id: url.slice(-20) }, events: [], unparsed: 0, note: null });
    return reply({ accepted: true });
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => realImmediate(r));
    while (frames.length > 0) frames.shift()!();
  };
  const byId = (id: string) => doc.getElementById(id)!;
  const h = {
    doc, byId, clock, writes, loc, seats,
    active: () => active,
    fire: async (target: object, type: string, e: Json = {}) => { const ev = fire(target, type, e); await flush(); return ev; },
    narrowTo: async () => { media.narrow = true; fire(mq, 'change', { matches: true }); await flush(); },
    wideTo: async () => { media.narrow = false; fire(mq, 'change', { matches: false }); await flush(); },
    posts: (part: string) => requests.filter((r) => r.method === 'POST' && r.url.includes(part)),
    click: async (el: FakeElement | null | undefined, e: Json = {}) => {
      assert.ok(el !== null && el !== undefined, 'nothing to click');
      fire(doc, 'click', { target: el, ...e });
      await flush();
    },
    key: async (key: string, target: unknown) => {
      const ev = fire(doc, 'keydown', { key, target });
      await flush();
      return ev;
    },
    tick: async () => { intervals.find((i) => i.ms === 2000)!.fn(); await flush(); await flush(); },
    card: (title: string) => byId('run').querySelectorAll('.run-b').find((b) => b.querySelector('[data-slot=title]')!.textContent === title),
  };
  try {
    await import(`${HOME}?${o.tag}`);
    await flush();
    await flush();
    await body(h);
  } finally {
    FakeElement.prototype.focus = realFocus;
    for (const k of keys) {
      const d = saved[k];
      if (d === undefined) delete g[k];
      else Object.defineProperty(g, k, d);
    }
  }
}

test('booted wide: shut until the capsule is clicked, kept; a double click is one; an allow is void after it moved the page', async () => {
  await boot({ tag: 'wide' }, async (h) => {
    const { byId, click } = h;
    const right = byId('right');
    const cap = byId('cap-run');
    assert.equal(h.doc.documentElement!.getAttribute('data-ready'), '1');
    assert.equal(right.getAttribute('data-open'), '0', 'shut by default');
    assert.equal(cap.getAttribute('aria-expanded'), 'false');
    // Waits first: bravo (its approval) and the fixture's read-only lead, then alpha; charlie is idle. No guess is named.
    assert.deepEqual([text(cap, 'capRw'), text(cap, 'capRn')], ['bravo、lead', '正在做 · +1']);
    assert.deepEqual(byId('run').querySelectorAll('.run-b').map((b) => b.querySelector('[data-slot=title]')!.textContent), ['bravo', 'lead', 'alpha']);
    assert.equal(text(cap, 'capRe'), '成员出错 1', 'alpha\'s failed sub-agent: shut, the side would hide it');
    assert.equal(hidden(cap.querySelector('[data-slot=capRe]')), false);
    assert.equal(text(h.card('alpha')!, 'took'), '开了 26 分');

    // 「等你」 open and settled: its allow counts...
    await click(byId('cap-wait'));
    h.clock.mono += 2000;
    await h.tick();
    const allow = () => byId('pins').querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'allow')!;
    assert.equal(allow().getAttribute('data-high'), '0');
    // ...until the side opens and the left half's width with it: the allow under the pointer is void a while.
    await click(cap, { detail: 1 });
    assert.equal(right.getAttribute('data-open'), '1');
    assert.equal(cap.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(h.writes.at(-1), ['orchestra.home.right', '1'], 'a wide window keeps the choice');
    await click(cap, { detail: 2 });
    assert.equal(right.getAttribute('data-open'), '1', 'a double click\'s second half does not shut it again');
    await click(allow());
    assert.equal(h.posts('/allow').length, 0);
    assert.equal(byId('note').textContent, TOWER_TEXT['appr.settling']);
    h.clock.mono += 800;
    await h.tick();
    await click(allow());
    assert.equal(h.posts(`/api/approvals/${AP}/allow`).length, 1, 'settled, it counts');

    // A card pushes its worker's page; a poll keeps it and its rows.
    const card = h.card('alpha')!;
    await click(card, { detail: 1 });
    const pg = byId('run-page');
    assert.equal(hidden(pg), false);
    assert.equal(right.getAttribute('data-page'), 'card');
    assert.equal(byId('rpg-h').focused, true);
    assert.equal(byId('rpg-h').textContent, 'alpha');
    const rows = pg.querySelectorAll('.mem');
    assert.equal(rows.length, card.querySelector('[data-slot=dots]')!.children.length, 'a row a mark (T3)');
    assert.equal(byId('wires').querySelectorAll('.wire').length, 0, 'no wire to cards under a page');
    await h.tick();
    assert.equal(hidden(pg), false, 'a poll never turns a page');
    assert.deepEqual(pg.querySelectorAll('.mem'), rows, 'the same rows: the focus and the place stay');
    assert.equal(h.card('alpha'), card, 'the card under it is the same one');
    // Esc from the composer does not shut a wide side; from the page it goes back, the focus to the card.
    assert.equal((await h.key('Escape', byId('dock-in'))).prevented, undefined);
    assert.equal(hidden(pg), false);
    await h.key('Escape', byId('rpg-h'));
    assert.equal(hidden(pg), true);
    assert.equal(right.getAttribute('data-page'), 'list');
    assert.equal(card.focused, true);
    // Esc again shuts it, the focus back to the capsule; the choice kept.
    await h.key('Escape', card);
    assert.equal(right.getAttribute('data-open'), '0');
    assert.equal(cap.focused, true);
    assert.deepEqual(h.writes.at(-1), ['orchestra.home.right', '0']);
    // The page's back and its own shut button do the same.
    await click(cap);
    await click(h.card('bravo'));
    await click(pg.querySelector('[data-act=run-back]'));
    assert.equal(h.card('bravo')!.focused, true);
    await click(h.card('bravo'));
    await click(pg.querySelectorAll('[data-act=run]')[0]);
    assert.equal(right.getAttribute('data-open'), '0');
    assert.equal(hidden(pg), true, 'shut, it opens on the list next time');
  });
});

test('booted narrow: a drawer that never opens by itself, takes the focus, and shuts when it leads to a talk', async () => {
  await boot({ tag: 'narrow', narrow: true, stored: '1' }, async (h) => {
    const { byId, click } = h;
    const right = byId('right');
    assert.equal(right.getAttribute('data-open'), '0', 'kept open on a wide window, a phone still opens shut');
    await click(byId('cap-run'));
    assert.equal(right.getAttribute('data-open'), '1');
    assert.equal(byId('run-h').focused, true);
    assert.deepEqual(h.writes, [], 'a phone keeps no choice');
    await click(h.card('alpha'));
    const go = byId('run-page').querySelectorAll('.mem-go').find((b) => !hidden(b))!;
    await click(go);
    assert.equal(right.getAttribute('data-open'), '0', 'the drawer shuts over the talk it opened');
    assert.equal(byId('dt-title').focused, true);
    assert.equal(byId('dt-title').textContent, 'alpha');
    assert.equal(h.loc.hash, `#/n/n:${ID.a}`);
    // Esc from anywhere: the drawer is over everything.
    await click(byId('cap-run'));
    await h.key('Escape', h.doc.body);
    assert.equal(right.getAttribute('data-open'), '0');
    assert.equal(byId('cap-run').focused, true);
  });
});

test('booted with storage blocked: the page starts, the side opens and shuts', async () => {
  await boot({ tag: 'blocked', blocked: true }, async (h) => {
    assert.equal(h.doc.documentElement!.getAttribute('data-ready'), '1');
    assert.equal(h.byId('right').getAttribute('data-open'), '0');
    await h.click(h.byId('cap-run'));
    assert.equal(h.byId('right').getAttribute('data-open'), '1');
    await h.click(h.byId('cap-run'), { detail: 1 });
    assert.equal(h.byId('right').getAttribute('data-open'), '0');
  });
});

test('booted wide, gone narrow: the side shuts, and a focus that was in it goes back to the capsule, not the page\'s top', async () => {
  await boot({ tag: 'to-narrow' }, async (h) => {
    const { byId, click } = h;
    await click(byId('cap-run'));
    assert.equal(byId('right').getAttribute('data-open'), '1');
    await click(h.card('alpha'));
    assert.equal(h.active()?.getAttribute('id'), 'rpg-h', 'the focus in the side, on a worker\'s page');
    await h.narrowTo();
    assert.equal(byId('right').getAttribute('data-open'), '0');
    assert.equal(h.active()?.getAttribute('id'), 'cap-run');
    assert.deepEqual(h.writes.at(-1), ['orchestra.home.right', '1'], 'the wide window\'s choice kept');
    // A drawer opened and shut on the phone is no choice for the desk: gone wide, the side is open as it was.
    h.clock.mono += 2000;
    await click(byId('cap-run'));
    assert.equal(byId('right').getAttribute('data-open'), '1', 'the drawer opened');
    await h.key('Escape', byId('run-h'));
    assert.equal(byId('right').getAttribute('data-open'), '0', 'the drawer shut');
    await h.wideTo();
    assert.equal(byId('right').getAttribute('data-open'), '1');
  });
  // A focus elsewhere stays where it was.
  await boot({ tag: 'to-narrow-out' }, async (h) => {
    await h.click(h.byId('cap-run'));
    h.byId('dock-in').focus();
    await h.narrowTo();
    assert.equal(h.byId('right').getAttribute('data-open'), '0');
    assert.equal(h.active()?.getAttribute('id'), 'dock-in');
  });
});

test('booted narrow: a focus that gets out of the drawer, onto what it covers, goes back to its head', async () => {
  await boot({ tag: 'trap', narrow: true }, async (h) => {
    const { byId, click } = h;
    await click(byId('cap-run'));
    assert.equal(h.active()?.getAttribute('id'), 'run-h');
    // Shift+Tab from the drawer's first button lands on the composer, under the drawer: it goes back in.
    byId('dock-in').focus();
    await h.fire(h.doc, 'focusin', { target: byId('dock-in') });
    assert.equal(h.active()?.getAttribute('id'), 'run-h');
    // On a worker's page, to the page's head; inside the drawer the focus goes where it was sent.
    await click(h.card('alpha'));
    const back = byId('run-page').querySelector('[data-act=run-back]')!;
    back.focus();
    await h.fire(h.doc, 'focusin', { target: back });
    assert.equal(h.active() === back, true, 'inside the drawer it stays');
    const allow = byId('pins').querySelectorAll('button').find((b) => b.getAttribute('data-act') === 'allow');
    const out = allow ?? byId('cap-wait');
    out.focus();
    await h.fire(h.doc, 'focusin', { target: out });
    assert.equal(h.active()?.getAttribute('id'), 'rpg-h');
    // Shut, the page is the page again.
    await h.key('Escape', byId('rpg-h'));
    await h.key('Escape', byId('run-h'));
    assert.equal(byId('right').getAttribute('data-open'), '0');
    byId('dock-in').focus();
    await h.fire(h.doc, 'focusin', { target: byId('dock-in') });
    assert.equal(h.active()?.getAttribute('id'), 'dock-in');
  });
});

test('booted wide: a card that left the held list moved those under it, so a click on a card goes nowhere till it settles', async () => {
  await boot({ tag: 'shrink' }, async (h) => {
    const { byId, click } = h;
    await click(byId('cap-run'));
    const titles = () => byId('run').querySelectorAll('.run-b').map((b) => b.querySelector('[data-slot=title]')!.textContent);
    assert.deepEqual(titles(), ['bravo', 'lead', 'alpha']);
    // The pointer on the list; bravo's request is answered elsewhere and it goes idle: its card leaves, the rest move up.
    await h.fire(byId('run'), 'pointerenter');
    h.seats[1]!.waiting = null;
    h.clock.mono += 2000;
    await h.tick();
    assert.deepEqual(titles(), ['lead', 'alpha']);
    await click(h.card('alpha'), { detail: 1 });
    assert.equal(hidden(byId('run-page')), true, 'a click on what came up under the pointer pushes nothing');
    assert.equal(byId('note').textContent, TOWER_TEXT['home.moved']);
    h.clock.mono += 800;
    await click(h.card('alpha'), { detail: 1 });
    assert.equal(hidden(byId('run-page')), false, 'settled, it counts');
    assert.equal(byId('rpg-h').textContent, 'alpha');
  });
  // Held, a list that only grew or stayed moves nothing: the click counts at once.
  await boot({ tag: 'shrink-none' }, async (h) => {
    await h.click(h.byId('cap-run'));
    await h.fire(h.byId('run'), 'pointerenter');
    h.clock.mono += 2000;
    await h.tick();
    await h.click(h.card('alpha'), { detail: 1 });
    assert.equal(hidden(h.byId('run-page')), false);
  });
});
