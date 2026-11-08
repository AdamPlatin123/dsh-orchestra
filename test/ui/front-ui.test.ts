import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFront, describeFrontChat } from '../../ui/front.js';
import { chatNews, deskOf, describeOwned } from '../../ui/owned.js';
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

const desk = (over: Json = {}) => ({ ownedId: D, harness: 'claude', model: 'zcode/GLM-5.3-Flash', title: '总台', state: 'idle', endReason: null, frontDesk: true, queued: 0, waiting: null, stoppable: false, cwd: { path: 'C:\\w\\d', kind: 'work' }, dispatch: { level: 'ask', grantAt: null, depth: 0, tainted: false, byDesk: false }, ...over });
const worker = (over: Json = {}) => ({ ownedId: C, harness: 'claude', model: 'zcode/GLM-5.3', title: '翻译', state: 'running', endReason: null, frontDesk: false, queued: 0, waiting: null, stoppable: false, dispatch: { level: 'ask', grantAt: null, depth: 1, tainted: true, byDesk: true }, ...over });
const request = (over: Json = {}) => ({ requestId: R, harness: 'claude', label: null, text: '翻译 README', cwd: '', runIn: null, runInWhy: 'no-roots', requester: `owned:${D}`, tainted: true, fromDesk: true, model: 'zcode/GLM-5.3', askWhy: null, auto: false, reason: '要英文版', returns: '译文', report: null, state: 'pending', createdAt: 0, expiresAt: 61_000, ownedId: null, why: null, fetched: false, suggestion: null, suggesting: 'no-desk', ...over });
const listOf = (over: Json = {}) => ({ owned: [desk()], approvals: [], requests: [] as Json[], requestedGone: [], sentGone: [], limits: { maxOwned: 3, active: 0 }, presence: 'present', frontDesk: { on: true, ownedId: D, model: 'zcode/GLM-5.3-Flash', tools: ['mcp__orchestra__dispatch', 'mcp__orchestra__status'] }, ...over });
let seq = 0;
const ev = (kind: string, state: string | null, text: string | null, ref: string | null = null, over: Json = {}) => ({ seq: ++seq, at: seq, kind, ref, uuid: null, text, state, redactions: 0, live: false, exitCode: null, tokens: null, batch: null, ...over });
const feedOf = (...events: Json[]) => ({ to: seq, clipped: false, events });
const chat = (list: Json, ...events: Json[]) => describeFrontChat(feedOf(...events), list, g, fmt) as { kids: Json[]; note: string };

test('the page has the tile over the workers, and the templates of the talk', () => {
  for (const s of ['data-act="front"', 'data-act="front-open"', 'id="front-model"', 'id="tpl-order"', 'id="tpl-fa"']) assert.ok(HTML.includes(s), s);
  assert.ok(HTML.indexOf('id="desk"') < HTML.indexOf('id="rail"'), 'the tile comes first');
  for (const k of ['who', 'where', 'what', 'why', 'back', 'now']) assert.ok(HTML.includes(`data-t="front.order.${k}"`), k);
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
  assert.ok(closed.note.text.includes(TOWER_TEXT['front.sends']!), 'beside the button: what goes to the model\'s provider');
  assert.match(TOWER_TEXT['front.sends']!, /magpie/);
  assert.match(TOWER_TEXT['front.sends']!, /标题/);
  assert.match(TOWER_TEXT['front.sends']!, /模型提供方/);
  assert.ok(closed.note.text.includes('跑一次模型'), 'opening itself runs the model once');
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

test('an answer lists what orchestrad saw read in its turn, not what the model says; none read is said; a new turn starts over', () => {
  const list = listOf({ owned: [desk(), worker()] });
  const c = chat(list,
    ev('you', null, 'q1'), ev('note', 'desk-read', 'overview', null, { at: 5 }), ev('note', 'desk-read', 'overview', null, { at: 6 }), ev('note', 'desk-read', 'session', `n:${C}`, { at: 7 }), ev('text', 'final', 'part one ', 'm1'), ev('text', 'final', 'part two', 'm1'), ev('lifecycle', 'turn-ended', null),
    ev('you', null, 'q2'), ev('text', 'final', 'hello', 'm2'),
  );
  const answers = c.kids.filter((k) => k.tpl === 'tpl-fa');
  assert.equal(answers.length, 2);
  assert.equal(answers[0]!.slots.tx.text, 'part one part two', 'chunks of one message are one answer');
  const says = [fill('front.src.overview', { at: 't5' }), fill('front.src.session', { t: '翻译', at: 't7' })].join(TOWER_TEXT['sep.parts']);
  assert.equal(answers[0]!.slots.src.text, fill('front.src', { t: says }));
  assert.equal(answers[1]!.slots.src.text, TOWER_TEXT['front.srcNone']);
});

test('a question you put while a turn runs queues behind it: that turn\'s answer keeps its reads, the next one has only its own, and a turn that failed ends its reads too', () => {
  const list = listOf({ owned: [desk(), worker()] });
  const src = (kids: Json[]) => kids.filter((k) => k.tpl === 'tpl-fa').map((k) => k.slots.src.text);
  const queued = chat(list,
    ev('you', null, 'q1'), ev('note', 'desk-read', 'overview', null, { at: 5 }), ev('you', null, 'q2'), ev('text', 'final', 'answer one', 'm1'), ev('lifecycle', 'turn-ended', null),
    ev('text', 'final', 'answer two', 'm2'), ev('lifecycle', 'turn-ended', null),
  );
  assert.deepEqual(src(queued.kids), [fill('front.src', { t: fill('front.src.overview', { at: 't5' }) }), TOWER_TEXT['front.srcNone']]);
  const own = chat(list,
    ev('you', null, 'q1'), ev('you', null, 'q2'), ev('text', 'final', 'answer one', 'm1'), ev('lifecycle', 'turn-ended', null),
    ev('note', 'desk-read', 'waiting', null, { at: 9 }), ev('text', 'final', 'answer two', 'm2'),
  );
  assert.deepEqual(src(own.kids), [TOWER_TEXT['front.srcNone'], fill('front.src', { t: fill('front.src.waiting', { at: 't9' }) })]);
  const failed = chat(list, ev('you', null, 'q1'), ev('note', 'desk-read', 'overview', null, { at: 5 }), ev('lifecycle', 'turn-failed', null), ev('you', null, 'q2'), ev('text', 'final', 'hello', 'm2'));
  assert.deepEqual(src(failed.kids), [TOWER_TEXT['front.srcNone']]);
  assert.deepEqual(src(chat(list, ev('you', null, 'q'), ev('note', 'desk-read', 'orders', null, { at: 3 }), ev('text', 'final', 'a', 'm')).kids), [fill('front.src', { t: fill('front.src.orders', { at: 't3' }) })]);
});

test('the sentence the page sent for 开启 is no word of yours: it is said as what happened, and it says the model ran; your own words stay yours', () => {
  const c = chat(listOf(), { ...ev('you', null, TOWER_TEXT['front.opening']!), uuid: 'u1' }, ev('note', 'msg-sent', null, 'u1'), ev('text', 'final', '我是总台', 'm1'), ev('lifecycle', 'turn-ended', null), ev('you', null, TOWER_TEXT['front.opening']!));
  assert.deepEqual(c.kids.map((k) => k.data.kind), ['life', 'agent', 'you']);
  assert.equal(c.kids[0]!.slots.who.text, '');
  assert.equal(c.kids[0]!.slots.tx.text, TOWER_TEXT['front.openedNote']);
  assert.match(TOWER_TEXT['front.openedNote']!, /跑了模型/);
  assert.equal(c.kids[2]!.slots.who.text, TOWER_TEXT['chat.you'], 'only the first one is the button\'s');
});

test('开启\'s sentence says the model ran only once it was handed over: not sent, withdrawn, unsure or still on its way, the line says that instead (T1)', () => {
  const opening = { ...ev('you', null, TOWER_TEXT['front.opening']!), uuid: 'u1' };
  const line = (...es: Json[]) => chat(listOf(), opening, ...es).kids[0]!.slots.tx.text as string;
  const says = (state: string, text = '') => fill('front.openedNoteNot', { t: fill(`msgst.${state}`, { t: text }) });
  assert.equal(line(ev('note', 'msg-not-sent', 'refused by the host', 'u1')), says('msg-not-sent', 'refused by the host'));
  assert.equal(line(ev('note', 'msg-withdrawn', null, 'u1')), says('msg-withdrawn'));
  assert.equal(line(ev('note', 'msg-unsure', 'gone', 'u1')), says('msg-unsure'));
  assert.equal(line(ev('note', 'msg-queued', null, 'u1')), says('msg-queued'));
  assert.equal(line(), says('other'), 'no fate yet is unknown, not run');
  for (const s of [line(), line(ev('note', 'msg-withdrawn', null, 'u1'))]) assert.doesNotMatch(s, /跑了模型/);
  assert.doesNotMatch(TOWER_TEXT['msgst.msg-withdrawn']!, /你/, 'a safety stop takes it back too: nobody here pressed anything');
});

test('what the desk sent out: its first message is the order it wrote, what you add is yours; past a clip nothing says which came first (T1)', () => {
  const uuid = 'u1';
  const feed = (clipped: boolean) => ({ clipped, events: [{ ...ev('you', null, '翻译 README'), uuid }, { ...ev('you', null, '再短一点'), uuid: 'u2' }] });
  const who = (o: Json, clipped = false) => (describeOwned(C, listOf({ owned: [desk(), { tokens: null, ...o }] }), feed(clipped) as Json, { unlocked: true, nowWall: 0, settle: '', busy: false } as Json) as Json).chat.kids.map((k: Json) => k.slots.who.text);
  assert.deepEqual(who(worker()), [TOWER_TEXT['chat.order'], TOWER_TEXT['chat.you']]);
  assert.deepEqual(who(worker(), true), [TOWER_TEXT['chat.you'], TOWER_TEXT['chat.you']]);
  assert.deepEqual(who(worker({ dispatch: { level: 'ask', grantAt: null, depth: 0, tainted: false, byDesk: false } })), [TOWER_TEXT['chat.you'], TOWER_TEXT['chat.you']], 'a session you started');
});

test('an order: six things, 未知 for what nobody said (T1); waiting it has the same buttons as its card, and says it is refused at the end of its time', () => {
  const r = request({ reason: null, returns: null, askWhy: 'away' });
  const o = chat(listOf({ requests: [r] }), ev('note', 'worker-asked', 'away', R)).kids[0]!;
  assert.equal(o.tpl, 'tpl-order');
  assert.deepEqual([o.slots.what.text, o.slots.why.text, o.slots.back.text], ['翻译 README', TOWER_TEXT['front.unknown'], TOWER_TEXT['front.unknown']]);
  assert.ok(o.slots.who.text.includes('zcode/GLM-5.3'));
  assert.ok(o.slots.now.text.includes(fill('front.now.pending', { t: '1分00秒' }).slice(0, 5)));
  assert.ok(o.slots.now.text.includes(TOWER_TEXT['askwhy.away']!));
  assert.deepEqual(o.slots.acts.kids.map((b: Json) => [b.data.act, b.data.req]), [['req-no', R], ['req-go', R], ['req-re', R]]);
  assert.equal(o.slots.how.text, '');
});

test('an order says where it would work, as its card does, and that the desk\'s worker is held tight; 未知 once orchestrad forgot it', () => {
  const own = chat(listOf({ requests: [request()] }), ev('note', 'worker-asked', null, R)).kids[0]!;
  assert.ok(own.slots.where.text.includes(TOWER_TEXT['req.workerWork']!));
  assert.ok(own.slots.where.text.includes(TOWER_TEXT['req.deskTaintedClaude']!));
  const codex = chat(listOf({ requests: [request({ harness: 'codex' })] }), ev('note', 'worker-asked', null, R)).kids[0]!;
  assert.ok(codex.slots.where.text.includes(TOWER_TEXT['req.deskTaintedCodex']!), 'a Codex order says what was measured');
  assert.doesNotMatch(codex.slots.where.text, /工具都要你批/);
  const root = chat(listOf({ requests: [request({ cwd: 'D:\\p', runIn: 'D:\\p', runInWhy: null })] }), ev('note', 'worker-asked', null, R)).kids[0]!;
  assert.ok(root.slots.where.text.includes(fill('req.workerRoot', { cwd: 'D:\\p', run: 'D:\\p' })));
  assert.equal(chat(listOf(), ev('note', 'worker-asked', null, R)).kids[0]!.slots.where.text, TOWER_TEXT['front.unknown']);
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

test('an order orchestrad forgot stays one row: 派出 of it folds into its asked row, a refusal says why, an unknown fate stays 未知 (T1); a grant\'s dispatch is a row of its own', () => {
  const sent = chat(listOf(), ev('note', 'worker-asked', null, R), ev('note', 'worker-sent', '翻译', `n:${C}`)).kids;
  assert.equal(sent.length, 1, 'one order, one row');
  assert.equal(sent[0]!.slots.now.text, TOWER_TEXT['front.now.unknown']);
  const rejected = chat(listOf(), ev('note', 'worker-asked', null, R), ev('note', 'worker-refused', 'you-rejected', R)).kids;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.slots.now.text, fill('front.now.refused', { t: TOWER_TEXT['dispwhy.you-rejected']! }));
  assert.equal(chat(listOf(), ev('note', 'worker-asked', null, R), ev('note', 'worker-refused', 'gone', R)).kids[0]!.slots.now.text, TOWER_TEXT['front.now.unknown']);
  const R2 = 'f'.repeat(20);
  const two = chat(listOf(), ev('note', 'worker-asked', null, R), ev('note', 'worker-refused', 'expired', R), ev('note', 'worker-asked', null, R2), ev('note', 'worker-sent', '翻译', `n:${C}`), ev('note', 'worker-sent-grant', '另一个', `n:${'b'.repeat(20)}`)).kids;
  assert.deepEqual(two.map((k) => k.key), [`o${R}`, `o${R2}`, `on:${'b'.repeat(20)}`]);
  const clipped = chat(listOf(), ev('note', 'worker-refused', 'expired', R)).kids;
  assert.deepEqual([clipped.length, clipped[0]!.slots.now.text], [1, fill('front.now.refused', { t: TOWER_TEXT['dispwhy.expired']! })], 'its asked note fell out of the feed');
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
  assert.equal(h.slots.facts.kids.at(-1).slots.v.text, TOWER_TEXT['front.sends'], '资料: what goes to the model\'s provider');
  assert.match(TOWER_TEXT['front.factPlaceV']!, /跑一次模型/);
});

test('its standing: you ended it says no code; anything else that ended it says why', () => {
  const standing = (over: Json) => (describeFront(D, listOf({ owned: [desk({ tokens: null, dispatch: null, state: 'ended', ...over })] }), { clipped: false, events: [] } as Json, { unlocked: true, nowWall: 0, settle: '', busy: false } as Json, fmt) as Json).ownSt.text as string;
  assert.doesNotMatch(standing({ endReason: 'you-ended' }), /you-ended/);
  assert.ok(standing({ endReason: 'safety-stop' }).includes(TOWER_TEXT['life.safety-stop']!));
});

test('the desk\'s head never points at a way that is not there and never says a check is coming for a desk that ended', () => {
  const empty = (l: Json | null) => (describeFrontHead(null, l) as Json).slots.empty.text;
  assert.equal(empty(listOf({ owned: [], frontDesk: { on: true, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } })), TOWER_TEXT['front.pick']);
  assert.equal(empty(listOf({ owned: [], frontDesk: { on: false, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } })), TOWER_TEXT['front.off']);
  assert.equal(empty(null), TOWER_TEXT['front.unread']);
  const ended = describeFrontHead(desk({ state: 'ended', endReason: 'you-ended', dispatch: null }), listOf({ frontDesk: { on: true, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null } })) as Json;
  assert.equal(ended.slots.facts.kids[0].slots.v.text, TOWER_TEXT['front.factToolsOver']);
  const starting = describeFrontHead(desk(), listOf({ frontDesk: { on: true, ownedId: D, model: 'zcode/GLM-5.3-Flash', tools: null } })) as Json;
  assert.equal(starting.slots.facts.kids[0].slots.v.text, TOWER_TEXT['front.factToolsNone']);
});

test('资料: the permission panel of the desk says the risk at both levels, the free level\'s note points at it; 派活权限 counts workers only (T3)', () => {
  const panel = (d: Json) => describeGrant(D, listOf({ owned: [d] }), { unlocked: true, fmt, maxDepth: 2 }) as Json;
  assert.ok(panel(desk()).slots.st.text.includes(TOWER_TEXT['grant.frontAsk']!));
  const free = panel(desk({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: false, byDesk: false } }));
  assert.ok(free.slots.st.text.includes(TOWER_TEXT['grant.frontFree']!));
  assert.equal(free.slots.lv.kids[1].slots.note.text, TOWER_TEXT['grant.note.freeFront']);
  assert.match(TOWER_TEXT['grant.frontFree']!, /不可信/);
  assert.match(TOWER_TEXT['grant.frontFree']!, /提示词注入/);
  for (const k of ['grant.frontAsk', 'grant.frontFree']) for (const re of [/标题/, /任务/, /回报/, /Claude 的工具都要你批/, /Codex 用 untrusted/, /子代理没测/]) assert.match(TOWER_TEXT[k]!, re, k);
  const sent = describeGrant(C, listOf({ owned: [desk(), worker()] }), { unlocked: true, fmt, maxDepth: 2 }) as Json;
  assert.ok(sent.slots.st.text.includes(TOWER_TEXT['grant.taintedDeskClaude']!), 'the worker\'s panel says who sent it and why it is held so');
  const sentCodex = describeGrant(C, listOf({ owned: [desk(), worker({ harness: 'codex' })] }), { unlocked: true, fmt, maxDepth: 2 }) as Json;
  assert.ok(sentCodex.slots.st.text.includes(TOWER_TEXT['grant.taintedDeskCodex']!), 'a Codex worker: what was measured, not that every tool asks');
  assert.doesNotMatch(sentCodex.slots.st.text, /工具都要你批/);
  assert.ok(!sent.slots.st.text.includes(TOWER_TEXT['grant.tainted']!));
  const seat = describeGrant(C, listOf({ owned: [desk(), worker({ dispatch: { level: 'ask', grantAt: null, depth: 0, tainted: true, byDesk: false } })] }), { unlocked: true, fmt, maxDepth: 2 }) as Json;
  assert.ok(seat.slots.st.text.includes(TOWER_TEXT['grant.tainted']!));
  assert.equal(grantsLine(listOf({ owned: [desk({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: false, byDesk: false } })] }), true), TOWER_TEXT['home.grantsNone']);
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
