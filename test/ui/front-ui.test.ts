import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFront, describeFrontChat } from '../../ui/front.js';
import { chatNews, deskOf } from '../../ui/owned.js';
import { describeFrontHead, describeFrontTile, describeGrant, describeSubs, grantsLine, subCards } from '../../ui/wings.js';
import { TOWER_TEXT } from '../../shared/strings.js';

// The front desk on the home page (orchestra app plan 总台; 第二轮简报 F1, F2): its tile and its talk, which holds four things and
// no tool. Pure descriptors, synthetic data.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const HTML = fs.readFileSync(path.join(REPO, 'ui/home.html'), 'utf8');
const D = 'd'.repeat(20);
const C = 'c'.repeat(20);
const R = 'e'.repeat(20);
type Json = Record<string, any>;
const fmt = (ms: number) => `t${ms}`;
const fill = (k: string, a: Record<string, string | number>) => Object.entries(a).reduce((s, [x, v]) => s.replaceAll(`{${x}}`, String(v)), TOWER_TEXT[k]!);
const g = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 1000 };

const desk = (over: Json = {}) => ({ ownedId: D, harness: 'claude', model: 'zcode/GLM-5.3-Flash', title: '总台', state: 'idle', endReason: null, frontDesk: true, queued: 0, waiting: null, stoppable: false, cwd: { path: 'C:\\w\\d', kind: 'work' }, dispatch: { level: 'ask', grantAt: null, depth: 0, tainted: false }, ...over });
const worker = (over: Json = {}) => ({ ownedId: C, harness: 'claude', model: 'zcode/GLM-5.3', title: '翻译', state: 'running', endReason: null, frontDesk: false, queued: 0, waiting: null, stoppable: false, dispatch: { level: 'ask', grantAt: null, depth: 1, tainted: false }, ...over });
const request = (over: Json = {}) => ({ requestId: R, harness: 'claude', label: null, text: '翻译 README', cwd: '', runIn: null, runInWhy: 'no-roots', requester: `owned:${D}`, tainted: false, model: 'zcode/GLM-5.3', askWhy: null, auto: false, reason: '要英文版', returns: '译文', report: null, state: 'pending', createdAt: 0, expiresAt: 61_000, ownedId: null, why: null, fetched: false, suggestion: null, suggesting: 'no-desk', ...over });
const listOf = (over: Json = {}) => ({ owned: [desk()], approvals: [], requests: [] as Json[], requestedGone: [], sentGone: [], limits: { maxOwned: 3, active: 0 }, presence: 'present', frontDesk: { on: true, ownedId: D, model: 'zcode/GLM-5.3-Flash', tools: ['mcp__orchestra__dispatch', 'mcp__orchestra__status'] }, ...over });
let seq = 0;
const ev = (kind: string, state: string | null, text: string | null, ref: string | null = null, over: Json = {}) => ({ seq: ++seq, at: seq, kind, ref, uuid: null, text, state, redactions: 0, live: false, exitCode: null, tokens: null, batch: null, ...over });
const feedOf = (...events: Json[]) => ({ to: seq, clipped: false, events });
const chat = (list: Json, ...events: Json[]) => describeFrontChat(feedOf(...events), list, g, fmt) as { kids: Json[]; note: string };

test('the page has the tile over the workers, and the templates of the talk; the old page has neither', () => {
  for (const s of ['data-act="front"', 'data-act="front-open"', 'id="front-model"', 'id="tpl-order"', 'id="tpl-fa"']) assert.ok(HTML.includes(s), s);
  assert.ok(HTML.indexOf('id="desk"') < HTML.indexOf('id="rail"'), 'the tile comes first');
  for (const k of ['who', 'what', 'why', 'back', 'now']) assert.ok(HTML.includes(`data-t="front.order.${k}"`), k);
  assert.equal(fs.readFileSync(path.join(REPO, 'ui/tower.html'), 'utf8').includes('tpl-order'), false);
});

test('tile: locked it does not know (T1); off says so; not open it says what it is and offers the model; open it says how it stands and not one count of workers', () => {
  const locked = describeFrontTile(null, { unlocked: false, on: false, busy: false }) as Json;
  assert.equal(locked.l2.text, TOWER_TEXT['front.locked']);
  assert.equal(locked.note.text, TOWER_TEXT['front.noteLocked']);
  assert.equal(locked.openBox.data.hide, '1');
  const off = describeFrontTile({ ...listOf({ owned: [] }), frontDesk: { on: false, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } }, { unlocked: true, on: false, busy: false }) as Json;
  assert.equal(off.l2.text, TOWER_TEXT['front.off']);
  assert.equal(off.note.text, TOWER_TEXT['home.noRouter'], 'today\'s words stay');
  const closed = describeFrontTile(listOf({ owned: [], frontDesk: { on: true, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } }), { unlocked: true, on: false, busy: false }) as Json;
  assert.equal(closed.l2.text, TOWER_TEXT['front.closed']);
  assert.ok(closed.note.text.startsWith(TOWER_TEXT['home.noRouter']!));
  assert.ok(closed.note.text.includes(fill('front.what', { n: 3 })), 'it says it takes no place');
  assert.equal(closed.openBox.data.hide, '0');
  assert.equal(closed.model.kids[0].key, 'zcode/GLM-5.3-Flash', 'the default first');
  const open = describeFrontTile(listOf(), { unlocked: true, on: true, busy: false }) as Json;
  assert.ok(open.l2.text.startsWith('zcode/GLM-5.3-Flash'));
  assert.equal(open.openBox.data.hide, '1');
  assert.equal(open.tile.data.on, '1');
  assert.equal(open.note.text, fill('front.noteOpen', { n: 3, l: TOWER_TEXT['grant.level.ask']! }));
});

test('tile: a desk the safety check stopped says so, and may open again; one you ended says nothing more', () => {
  const stopped = listOf({ owned: [desk({ state: 'failed', endReason: 'safety-stop', dispatch: null })], frontDesk: { on: true, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } });
  const t = describeFrontTile(stopped, { unlocked: true, on: false, busy: false }) as Json;
  assert.equal(t.l2.text, fill('front.lastOver', { why: TOWER_TEXT['life.safety-stop']! }));
  assert.equal(t.openBox.data.hide, '0');
  assert.equal(deskOf(stopped)?.state, 'failed', 'its talk can still be read');
  const ended = listOf({ owned: [desk({ state: 'ended', endReason: 'you-ended', dispatch: null })], frontDesk: { on: true, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } });
  assert.equal((describeFrontTile(ended, { unlocked: true, on: false, busy: false }) as Json).l2.text, TOWER_TEXT['front.closed']);
});

test('the talk holds four things: your words, answers, orders, and a report on its order; no tool, no read, no note, no lifecycle line', () => {
  const list = listOf({ requests: [request()] });
  const c = chat(list,
    ev('lifecycle', 'started', 'zcode/GLM-5.3-Flash'),
    ev('you', null, '派活', null, { uuid: 'u1' }),
    ev('note', 'msg-written', null, 'u1'), ev('note', 'msg-sent', null, 'u1'),
    ev('note', 'desk-read', 'overview'),
    ev('note', 'worker-asked', null, R),
    ev('text', 'final', '等你点派出', 'm1'),
    ev('lifecycle', 'turn-ended', null), ev('note', 'cost', '$0.01', null),
  );
  assert.deepEqual(c.kids.map((k) => k.tpl), ['tpl-msg', 'tpl-order', 'tpl-fa']);
  assert.equal(c.kids[0]!.data.kind, 'you');
  assert.equal(c.note, '');
});

test('an answer lists what orchestrad saw read in its turn, not what the model says; none read is said; a new question starts over', () => {
  const list = listOf({ owned: [desk(), worker()] });
  const c = chat(list,
    ev('you', null, 'q1'), ev('note', 'desk-read', 'overview', null, { at: 5 }), ev('note', 'desk-read', 'overview', null, { at: 6 }), ev('note', 'desk-read', 'session', `n:${C}`, { at: 7 }), ev('text', 'final', 'part one ', 'm1'), ev('text', 'final', 'part two', 'm1'),
    ev('you', null, 'q2'), ev('text', 'final', 'hello', 'm2'),
  );
  const answers = c.kids.filter((k) => k.tpl === 'tpl-fa');
  assert.equal(answers.length, 2);
  assert.equal(answers[0]!.slots.tx.text, 'part one part two', 'chunks of one message are one answer');
  const says = [fill('front.src.overview', { at: 't5' }), fill('front.src.session', { t: '翻译', at: 't7' })].join(TOWER_TEXT['sep.parts']);
  assert.equal(answers[0]!.slots.src.text, fill('front.src', { t: says }));
  assert.equal(answers[1]!.slots.src.text, TOWER_TEXT['front.srcNone']);
});

test('an order: five things, 未知 for what nobody said (T1); waiting it has the same buttons as its card, and says it is refused at the end of its time', () => {
  const r = request({ reason: null, returns: null, askWhy: 'away' });
  const o = chat(listOf({ requests: [r] }), ev('note', 'worker-asked', 'away', R)).kids[0]!;
  assert.equal(o.tpl, 'tpl-order');
  assert.deepEqual([o.slots.what.text, o.slots.why.text, o.slots.back.text], ['翻译 README', TOWER_TEXT['front.unknown'], TOWER_TEXT['front.unknown']]);
  assert.ok(o.slots.who.text.includes('zcode/GLM-5.3'));
  assert.ok(o.slots.now.text.includes(fill('front.now.pending', { t: '1分00秒' }).slice(0, 5)));
  assert.ok(o.slots.now.text.includes(TOWER_TEXT['askwhy.away']!));
  assert.deepEqual(o.slots.acts.kids.map((b: Json) => [b.data.act, b.data.req]), [['req-no', R], ['req-go', R]]);
  assert.equal(o.slots.how.text, '');
});

test('an order after your click: one row from asked to sent, what it does now, how it went out; the report is the worker\'s word, never done (T2)', () => {
  const list = (over: Json) => listOf({ owned: [desk(), worker()], requests: [request({ ownedId: C, ...over })] });
  const events = [ev('note', 'worker-asked', null, R), ev('note', 'worker-sent', '翻译', `n:${C}`)];
  const running = chat(list({ state: 'running' }), ...events).kids;
  assert.equal(running.length, 1);
  assert.equal(running[0]!.slots.now.text, TOWER_TEXT['front.now.running']);
  assert.equal(running[0]!.slots.how.text, TOWER_TEXT['front.via.person']);
  assert.deepEqual(running[0]!.slots.acts.kids.map((b: Json) => b.data.act), ['worker', 'stop-worker']);
  const done = chat(listOf({ owned: [desk(), worker({ state: 'idle' })], requests: [request({ ownedId: C, state: 'done', report: '译好了' })] }), ...events).kids[0]!;
  assert.equal(done.slots.now.text, fill('front.now.report', { t: '译好了' }));
  assert.deepEqual(done.slots.acts.kids.map((b: Json) => b.data.act), ['worker'], 'nothing left to stop');
  assert.doesNotMatch(JSON.stringify(done), /完成|Done/);
  const none = chat(list({ state: 'done', report: null }), ...events).kids[0]!;
  assert.equal(none.slots.now.text, TOWER_TEXT['front.now.noReport']);
});

test('an order on the permission says so; a call refused before any order says why, the rest 未知; one orchestrad forgot says it does not know', () => {
  const grant = chat(listOf({ owned: [desk(), worker()], requests: [request({ ownedId: C, auto: true, state: 'dispatched' })] }), ev('note', 'worker-sent-grant', '翻译', `n:${C}`)).kids[0]!;
  assert.equal(grant.slots.how.text, TOWER_TEXT['front.via.grant']);
  const refused = chat(listOf(), ev('note', 'worker-refused', 'owned-limit')).kids[0]!;
  assert.equal(refused.slots.now.text, fill('front.now.refused', { t: TOWER_TEXT['dispwhy.owned-limit']! }));
  assert.equal(refused.slots.what.text, TOWER_TEXT['front.unknown']);
  const gone = chat(listOf(), ev('note', 'worker-asked', null, R)).kids[0]!;
  assert.equal(gone.slots.now.text, TOWER_TEXT['front.now.unknown']);
  for (const [st, key] of [['rejected', 'front.now.rejected'], ['expired', 'front.now.expired'], ['withdrawn', 'front.now.withdrawn']] as const) {
    assert.equal(chat(listOf({ requests: [request({ state: st })] }), ev('note', 'worker-asked', null, R), ev('note', 'worker-refused', 'you-rejected', R)).kids.length, 1, 'a refusal of an order is that order');
    assert.equal(chat(listOf({ requests: [request({ state: st })] }), ev('note', 'worker-asked', null, R)).kids[0]!.slots.now.text, TOWER_TEXT[key]);
  }
});

test('a turn that went wrong is said over the talk (T1); an interrupted one too', () => {
  const c = chat(listOf(), ev('you', null, 'q'), ev('lifecycle', 'turn-failed', null));
  assert.equal(c.note, TOWER_TEXT['life.turn-failed']);
  assert.equal(chat(listOf(), ev('you', null, 'q'), ev('lifecycle', 'turn-failed', null), ev('you', null, 'q2'), ev('lifecycle', 'turn-ended', null)).note, '');
});

test('what a screen reader hears leaves the reads out, and the page has the desk\'s standing, no card, its head names the tools the check let through', () => {
  const feed = feedOf(ev('note', 'desk-read', 'overview'));
  assert.equal(chatNews(feed, 0), '');
  const f = describeFront(D, listOf(), feed, g, fmt) as Json;
  assert.ok(f.ownSt.text.includes('zcode/GLM-5.3-Flash'));
  assert.deepEqual(f.cards.kids, []);
  const h = describeFrontHead(desk(), listOf()) as Json;
  assert.equal(h.data.mode, 'front');
  assert.ok(h.slots.facts.kids[0].slots.v.text.includes('mcp__orchestra__status'));
  assert.equal((describeFrontHead(null, null) as Json).slots.empty.text, TOWER_TEXT['front.pick']);
});

test('资料: the permission panel of the desk says the risk at both levels, the free level\'s note points at it; 派活权限 counts workers only (T3)', () => {
  const panel = (d: Json) => describeGrant(D, listOf({ owned: [d] }), { unlocked: true, fmt, maxDepth: 2 }) as Json;
  assert.ok(panel(desk()).slots.st.text.includes(TOWER_TEXT['grant.frontAsk']!));
  const free = panel(desk({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: false } }));
  assert.ok(free.slots.st.text.includes(TOWER_TEXT['grant.frontFree']!));
  assert.equal(free.slots.lv.kids[1].slots.note.text, TOWER_TEXT['grant.note.freeFront']);
  assert.match(TOWER_TEXT['grant.frontFree']!, /不可信/);
  assert.match(TOWER_TEXT['grant.frontFree']!, /提示词注入/);
  assert.equal(grantsLine(listOf({ owned: [desk({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: false } })] }), true), TOWER_TEXT['home.grantsNone']);
  assert.equal(grantsLine(listOf({ owned: [desk(), worker()] }), true), fill('home.grants', { free: 0, ask: 1 }));
});

test('the right side: what the desk sent out are its cards, though no node stands for the desk', () => {
  const sent = { id: `n:${C}`, session: null, harness: 'claude', ownership: 'owned', layer: 'agent', parent: null, depth: 0, title: '翻译', activity: null, state: 'running', basis: 'owned', waiting: null, counts: { children: 0, errors: 0, waiting: 0 }, groups: [], ageMs: 1, durationMs: null, model: null, agentType: null, batch: null, mark: null, sent: { by: `n:${D}`, via: 'person', grantAt: null } };
  const snap = { projects: [{ name: 'p', nodes: [sent] }], meta: { clipped: { nodes: 0 } } } as never;
  assert.deepEqual(subCards(snap, `n:${D}`).map((c) => c.worker), [`n:${C}`]);
  assert.deepEqual(subCards(snap, `n:${'f'.repeat(20)}`), []);
  const p = describeSubs(snap, `n:${D}`, { open: new Set(), fresh: new Set(), front: true }) as Json;
  assert.equal(p.slots.head.text, fill('home.subsH', { who: TOWER_TEXT['front.name']! }));
  assert.equal(p.slots.note.text, '');
  const empty = describeSubs({ projects: [], meta: { clipped: { nodes: 0 } } } as never, `n:${D}`, { open: new Set(), fresh: new Set(), front: true }) as Json;
  assert.equal(empty.slots.note.text, TOWER_TEXT['front.subsNone']);
});
