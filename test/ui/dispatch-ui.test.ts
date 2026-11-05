import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { post } from '../../ui/api.js';
import { describeGrant, describeSubs, grantsLine, subCards, wireRows } from '../../ui/wings.js';
import { describeChat, describeRequestPins, notifyRequestText, originLine, pinExtra, requestModel, requestOf } from '../../ui/owned.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { fmtLeft } from '../../ui/view.js';
import { DISPATCH_LIMITS } from '../../src/route/dispatch.ts';
import { OWNED_ENUMS, validateOwnedFeed } from '../../shared/owned-contract.js';

// The home page's side of a worker's dispatch (orchestra app plan 派活权限): the permission in 资料, the receipt in the talk
// and its card, the request card with the worker as its source, each with the unknown said. Pure descriptors; synthetic data.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const HTML = fs.readFileSync(path.join(REPO, 'ui/home.html'), 'utf8');
const W = 'a'.repeat(20);
const C = 'c'.repeat(20);
type Json = Record<string, any>;
const fmt = (ms: number) => `t${ms}`;
const fill = (k: string, a: Record<string, string | number>) => Object.entries(a).reduce((s, [x, v]) => s.replaceAll(`{${x}}`, String(v)), TOWER_TEXT[k]!);

const entry = (over: Json = {}) => ({ ownedId: W, title: '修登录页', state: 'idle', dispatch: { level: 'ask', grantAt: null, depth: 0, tainted: false }, ...over });
const listOf = (...owned: Json[]) => ({ owned, presence: 'present', requests: [] as Json[] });
const panel = (e: Json, unlocked = true, list = listOf(e)) => describeGrant(W, list, { unlocked, fmt, maxDepth: 2 }) as any;

test('the panel: the two levels you may set and the one r4 D20 does not allow, each saying what it does; it says who set it and when', () => {
  const p = panel(entry());
  assert.deepEqual(p.slots.lv.kids.map((k: Json) => k.key), ['ask', 'free', 'away']);
  assert.deepEqual(p.slots.lv.kids.map((k: Json) => k.slots.b.attr['aria-pressed']), ['true', 'false', 'false']);
  assert.deepEqual(p.slots.lv.kids.map((k: Json) => k.slots.b.attr.disabled), [null, null, ''], '你不在也派 has no way in');
  assert.ok(p.slots.lv.kids[2].slots.note.text.includes('D20'));
  assert.ok(p.slots.st.text.includes(TOWER_TEXT['grant.default']!));
  const set = panel(entry({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: false } }));
  assert.equal(set.slots.lv.kids[1].slots.b.attr['aria-pressed'], 'true');
  assert.ok(set.slots.st.text.includes(fill('grant.since', { at: 't5' })));
});

test('the panel: locked it cannot be set; a tainted session, the end of the chain and your absence are said; a read-only session has none', () => {
  const locked = panel(entry(), false);
  assert.deepEqual(locked.slots.lv.kids.map((k: Json) => k.slots.b.attr.disabled), ['', '', '']);
  assert.equal(locked.slots.st.text, TOWER_TEXT['grant.locked']);
  assert.ok(panel(entry({ dispatch: { level: 'free', grantAt: 5, depth: 0, tainted: true } })).slots.st.text.includes(TOWER_TEXT['grant.tainted']!));
  assert.ok(panel(entry({ dispatch: { level: 'ask', grantAt: null, depth: 2, tainted: false } })).slots.st.text.includes(fill('grant.depth', { d: 2 })));
  const e = entry();
  assert.ok(panel(e, true, { ...listOf(e), presence: 'away' }).slots.st.text.includes(TOWER_TEXT['grant.here.away']!));
  assert.ok(panel(e, true, { ...listOf(e), presence: 'unknown' }).slots.st.text.includes(TOWER_TEXT['grant.here.unknown']!));
  assert.equal(panel(entry({ dispatch: null })).slots.st.text, TOWER_TEXT['grant.none']);
  assert.deepEqual(panel(entry({ dispatch: null })).slots.lv.kids.map((k: Json) => k.slots.b.attr.disabled), ['', '', '']);
  assert.deepEqual(describeGrant(null, listOf(entry()), { unlocked: true, fmt, maxDepth: 2 }), { data: { hide: '1' } });
});

test('the page may post the permission: its one path list has the route (a page that could not would say bad-id, found in a real browser)', async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    seen.push(url);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const a = await post('x'.repeat(43), `owned/${W}/dispatch-grant`, { actionId: 'x', level: 'free' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(seen, [`/api/owned/${W}/dispatch-grant`]);
  assert.deepEqual(await post('x'.repeat(43), 'owned/x/dispatch-grant', {}), { ok: false, code: 'bad-id' });
});

test('the panel with no level to show says why, and never makes one reason of three (T1)', () => {
  const st = (id: string, list: Json | null) => (describeGrant(id, list, { unlocked: true, fmt, maxDepth: 2 }) as any).slots.st.text;
  assert.equal(st(W, null), TOWER_TEXT['grant.unknown'], 'the list not read yet');
  assert.equal(st(W, listOf()), TOWER_TEXT['grant.unknown'], 'a list that does not hold it');
  assert.equal(st(W, listOf(entry({ state: 'unknown', dispatch: null }))), TOWER_TEXT['grant.unknown']);
  assert.equal(st(W, listOf(entry({ state: 'ended', dispatch: null }))), TOWER_TEXT['grant.over']);
  assert.equal(st(W, listOf(entry({ state: 'failed', dispatch: null }))), TOWER_TEXT['grant.over']);
  assert.equal(st(W, listOf(entry({ dispatch: null }))), TOWER_TEXT['grant.none'], 'running, and no tool');
});

test('the page knows the end of the chain as dispatch.ts does', () => {
  assert.ok(fs.readFileSync(path.join(REPO, 'ui/home.js'), 'utf8').includes(`const MAX_DEPTH = ${DISPATCH_LIMITS.depth};`));
});

test('the five things no level opens stand in 资料, and the old sentence that no bot can dispatch is gone', () => {
  for (let i = 1; i <= 5; i++) assert.ok(HTML.includes(`data-t="grant.keep.${i}"`), String(i));
  assert.ok(HTML.indexOf('home.facts') < HTML.indexOf('grant.title') && HTML.indexOf('grant.title') < HTML.indexOf('detail.activity'), 'inside 资料');
  assert.ok(!Object.values(TOWER_TEXT).some((s) => String(s).includes('没有 bot 能派活')));
  assert.ok(!Object.values(TOWER_TEXT).some((s) => String(s).includes('完成')), 'T2');
});

test('the bar: its counts are the running workers on each level; before the unlock it does not know', () => {
  assert.equal(grantsLine(null), TOWER_TEXT['home.grantsLocked']);
  assert.equal(grantsLine(null, true), TOWER_TEXT['home.grantsUnread'], 'unlocked and not read: unknown, and not for want of the unlock (T1)');
  assert.equal(grantsLine(listOf(entry({ dispatch: null }))), TOWER_TEXT['home.grantsNone']);
  assert.equal(grantsLine(listOf(entry(), entry({ ownedId: C, dispatch: { level: 'free', grantAt: 1, depth: 0, tainted: false } }), entry({ ownedId: 'd'.repeat(20), dispatch: null }))), fill('home.grants', { free: 1, ask: 1 }));
});

const node = (over: Json): Json => ({
  id: `n:${W}`, session: null, harness: 'codex', ownership: 'owned', layer: 'agent', parent: null, depth: 0, title: 'worker', activity: null, state: 'idle', basis: 'owned', waiting: null,
  counts: { children: 0, errors: 0, waiting: 0 }, groups: [], ageMs: 0, durationMs: null, model: null, agentType: null, batch: null, mark: null, sent: null, ...over,
});
const snapOf = (...nodes: Json[]): any => ({ meta: { clipped: { projects: 0, nodes: 0, sessions: { claude: 0, dsh: 0, codex: 0 } } }, projects: [{ id: 'f'.repeat(20), name: 'p', basis: 'owned', groups: [], nodes }] });
const child = (over: Json = {}) => node({ id: `n:${C}`, title: '查日志', state: 'running', sent: { by: `n:${W}`, via: 'grant', grantAt: 7 }, ...over });

test('what a worker sent out is a card of its own on the right, of kind worker, one member and a way to its talk; the worker it stays on the left', () => {
  const snap = snapOf(node({}), child());
  const cards = subCards(snap, `n:${W}`);
  assert.deepEqual(cards.map((c) => [c.worker, c.members.length]), [[`n:${C}`, 1]]);
  assert.deepEqual(subCards(snap, `n:${C}`), [], 'its own right half is empty until it sends something');
  const p = describeSubs(snap, `n:${W}`, { open: new Set([cards[0]!.key]), fresh: new Set() }) as any;
  const card = p.slots.list.kids[0];
  assert.deepEqual([card.slots.title.text, card.slots.kind.text], ['查日志', 'worker']);
  assert.equal(card.slots.body.kids[0].slots.go.data.hide, '0');
  assert.equal(card.slots.body.kids[0].slots.go.data.node, `n:${C}`);
  assert.equal(p.slots.head.text, fill('home.subsH', { who: 'worker' }));
});

test('the receipt: the talk\'s row says it went on your permission and when, opens its card, and has a stop while the worker has something to stop', () => {
  const feed = { clipped: false, events: [{ seq: 1, at: 0, kind: 'note', ref: `n:${C}`, uuid: null, text: '查日志', state: 'worker-sent-grant', redactions: 0, live: false, exitCode: null, tokens: null, batch: null }] };
  const { kids } = describeChat(feed as never);
  assert.deepEqual([kids[0]!.data!.kind, kids[0]!.data!.worker, kids[0]!.data!.via], ['disp', `n:${C}`, 'grant']);
  const snap = snapOf(node({}), child());
  const cards = subCards(snap, `n:${W}`);
  const [row] = wireRows(kids, cards, new Set(), fmt) as any[];
  assert.equal(row.tpl, 'tpl-disp');
  assert.ok(row.slots.tx.text.includes('查日志') && row.slots.tx.text.includes(fill('home.sentGrant', { at: 't7' })), row.slots.tx.text);
  assert.equal(row.slots.b.data.fold, cards[0]!.key);
  assert.deepEqual([row.slots.stop.data.hide, row.slots.stop.data.owned, row.slots.stop.text], ['0', C, TOWER_TEXT['home.stopWorker']]);
  const idle = wireRows(kids, subCards(snapOf(node({}), child({ state: 'idle' })), `n:${W}`), new Set(), fmt) as any[];
  assert.equal(idle[0].slots.stop.data.hide, '1', 'nothing to stop');
  const person = wireRows(kids, subCards(snapOf(node({}), child({ sent: { by: `n:${W}`, via: 'person', grantAt: null } })), `n:${W}`), new Set(), fmt) as any[];
  assert.ok(person[0].slots.tx.text.includes(TOWER_TEXT['home.sentPerson']!));
  // A row whose card this snapshot does not hold says what the feed said, and opens nothing.
  const lost = wireRows(kids, [], new Set(), fmt) as any[];
  assert.equal(lost[0].slots.tx.text, fill('fnote.worker-sent-grant', { t: '查日志' }));
  assert.equal(lost[0].slots.stop.data.hide, '1');
});

test('the stop on a worker\'s row stands while anything of it runs: a background sub-agent outlives its root\'s turn', () => {
  const feed = { clipped: false, events: [{ seq: 1, at: 0, kind: 'note', ref: `n:${C}`, uuid: null, text: '查日志', state: 'worker-sent-grant', redactions: 0, live: false, exitCode: null, tokens: null, batch: null }] };
  const { kids } = describeChat(feed as never);
  const sub = (state: string) => node({ id: `a:${C}:1`, title: 'sub', layer: 'subagent', parent: `n:${C}`, state, ownership: 'owned', batch: 1 });
  const stopOf = (state: string) => (wireRows(kids, subCards(snapOf(node({}), child({ state: 'idle' }), sub(state)), `n:${W}`), new Set(), fmt) as any[])[0].slots.stop;
  assert.deepEqual([stopOf('running').data.hide, stopOf('running').data.owned], ['0', C]);
  assert.equal(stopOf('waiting').data.hide, '0');
  assert.equal(stopOf('returned').data.hide, '1', 'nothing left to stop');
});

test('a batch of sub-agents has no stop: it is no session a stop could name, and a button that does nothing says nothing', () => {
  const { kids } = describeChat({ clipped: false, events: [{ seq: 1, at: 0, kind: 'note', ref: null, uuid: null, text: 'sub', state: 'dispatch', redactions: 0, live: false, exitCode: null, tokens: null, batch: 1 }] } as never);
  assert.equal(kids[0]!.data!.kind, 'disp');
  const sub = node({ id: `a:${W}:1`, title: 'sub', layer: 'subagent', parent: `n:${W}`, state: 'running', ownership: 'owned', batch: 1 });
  const [row] = wireRows(kids, subCards(snapOf(node({}), sub), `n:${W}`), new Set(), fmt) as any[];
  assert.notEqual(row.slots.b.data.fold, '', 'its card is there');
  assert.equal(row.slots.stop.data.hide, '1');
});

test('the talk says a card waits and why, a refusal in words, and a code it has no words for as a code (T1)', () => {
  const ev = (seq: number, state: string, text: string | null) => ({ seq, at: 0, kind: 'note', ref: null, uuid: null, text, state, redactions: 0, live: false, exitCode: null, tokens: null, batch: null });
  const tx = (e: Json) => describeChat({ clipped: false, events: [e] } as never).kids[0]!.slots!.tx!.text;
  assert.equal(tx(ev(1, 'worker-asked', null)), TOWER_TEXT['fnote.worker-asked']);
  assert.ok(tx(ev(1, 'worker-asked', 'away')).includes(TOWER_TEXT['askwhy.away']!));
  assert.equal(tx(ev(1, 'worker-refused', 'owned-limit')), fill('fnote.worker-refused', { t: TOWER_TEXT['dispwhy.owned-limit']! }));
  assert.ok(tx(ev(1, 'worker-refused', 'new-code')).includes('new-code'));
  assert.equal(tx(ev(1, 'dispatch-grant', 'free')), fill('fnote.dispatch-grant', { t: TOWER_TEXT['grant.level.free']! }));
});

const g = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
const req = (over: Json = {}) => ({
  requestId: '5'.repeat(20), harness: 'claude', label: null, text: 'x', cwd: '', runIn: null, runInWhy: 'no-roots', requester: `owned:${W}`, tainted: false, model: null, askWhy: null, auto: false, state: 'pending',
  createdAt: 0, expiresAt: 60_000, ownedId: null, why: null, fetched: false, suggestion: null, suggesting: 'no-desk', ...over,
});

test('a worker\'s request card: the source is that session, as orchestrad knows it, never 自称; it says why it came back and what a dispatch would be', () => {
  const card = (r: Json) => (describeRequestPins({ ...listOf(entry()), requests: [r] }, g) as any[])[0];
  const c = card(req());
  assert.equal(c.slots.kind.text, fill('req.kindWorker', { who: '修登录页', h: 'Claude' }));
  assert.ok(c.slots.meta.text.includes(fill('req.whoWorker', { who: '修登录页' })));
  assert.ok(!c.slots.meta.text.includes('自称'));
  const long = (describeRequestPins({ ...listOf(entry({ title: '长'.repeat(300) })), requests: [req()] }, g) as any[])[0];
  assert.equal(long.slots.kind.text, fill('req.kindWorker', { who: `${'长'.repeat(59)}…`, h: 'Claude' }), 'a title is its whole first message: the card names it cut, as the tower does');
  assert.ok(c.slots.meta.text.includes(TOWER_TEXT['req.workerWork']!) && c.slots.meta.text.includes(TOWER_TEXT['req.workerClean']!));
  assert.ok(card(req({ askWhy: 'tainted', tainted: true })).slots.meta.text.includes(TOWER_TEXT['askwhy.tainted']!));
  assert.ok(card(req({ tainted: true })).slots.meta.text.includes(TOWER_TEXT['req.workerTainted']!));
  assert.ok(card(req({ cwd: 'D:\\p\\w', runIn: 'D:\\p\\w', runInWhy: null })).slots.meta.text.includes(fill('req.workerRoot', { cwd: 'D:\\p\\w', run: 'D:\\p\\w' })));
  assert.deepEqual(requestModel(req({ model: 'zcode/GLM-5.3' })), { model: 'zcode/GLM-5.3', src: 'req.src.worker' });
  assert.equal(card(req({ model: 'zcode/GLM-5.3' })).slots.acts.kids[1].data.model, 'zcode/GLM-5.3');
});

test('a session page says who sent it and how; its cards name the worker, with no red bar on a clean one', () => {
  const list = { ...listOf(entry()), requests: [req({ ownedId: C, state: 'running', auto: true }), req({ requestId: '6'.repeat(20), ownedId: 'd'.repeat(20), state: 'running' })] };
  assert.ok(requestOf(list, C).startsWith(fill('req.ofAuto', { who: '修登录页', st: '' }).split(' · ')[0]!), requestOf(list, C));
  assert.ok(requestOf(list, 'd'.repeat(20)).startsWith(fill('req.ofWorker', { who: '修登录页', st: '' }).split(' · ')[0]!));
  const a = { origin: { kind: 'worker-dispatch', requestId: '5'.repeat(20), requester: W, label: '修登录页' }, tainted: false };
  assert.equal(originLine(a), fill('appr.originWorker', { who: '修登录页' }));
  assert.ok(originLine(a, 2).includes(TOWER_TEXT['appr.originCut']!));
  const pin = pinExtra({ source: 'orchestra', node: `n:${W}` }, { approvals: [] }, { ...g, unlocked: false }, a) as any;
  assert.equal(pin.data.tainted, '0');
  assert.equal(originLine({ origin: { ...a.origin, label: null }, tainted: false }), fill('appr.originWorker', { who: W }));
});

test('a worker\'s session page: nobody fetches its result, and once the request is gone it is still not one you dispatched', () => {
  const done = { ...listOf(entry()), requests: [req({ ownedId: C, state: 'done', auto: true })] };
  assert.ok(requestOf(done, C).endsWith(TOWER_TEXT['reqst.doneWorker']!), requestOf(done, C));
  assert.ok(!requestOf(done, C).includes('请求方'), requestOf(done, C));
  const gone = { ...listOf(entry()), requestedGone: ['d'.repeat(20)], sentGone: [C] };
  assert.equal(requestOf(gone, C), TOWER_TEXT['req.ofAutoGone']);
  assert.equal(requestOf(gone, 'd'.repeat(20)), TOWER_TEXT['req.ofGone']);
  assert.equal(requestOf(gone, 'e'.repeat(20)), '', 'a session you started yourself names none');
});

test('the notification says who asks as the card does: a worker is no DSH session', () => {
  const list = listOf(entry());
  const text = notifyRequestText(req({ expiresAt: 60_000 }), 0, list);
  assert.equal(text, fill('notify.reqBodyWorker', { who: '修登录页', h: 'Claude', t: fmtLeft(60_000) }));
  assert.ok(!text.includes('DSH'));
  assert.ok(notifyRequestText(req({ requester: 'dsh:s1', expiresAt: 60_000 }), 0, list).includes('DSH'));
  assert.ok(notifyRequestText(req({ expiresAt: 60_000 }), 0).includes(W), 'with no list, its id');
});

test('the contracts: a sent node names who and how, a receipt names its node, and a level has its two values', () => {
  assert.deepEqual([...OWNED_ENUMS.grantLevel], ['ask', 'free']);
  const feed = (ref: string | null) => ({ v: 1, kind: 'owned-feed', ownedId: W, from: 0, to: 1, clipped: false, events: [{ seq: 1, at: 0, kind: 'note', ref, uuid: null, text: 'x', state: 'worker-sent-grant', redactions: 0, live: false, exitCode: null, tokens: null, batch: null }] });
  assert.equal(validateOwnedFeed(feed(`n:${C}`)).ok, true);
  assert.equal(validateOwnedFeed(feed(null)).ok, false);
});

test('a command the session ended on: no result came and none will, so it no longer reads 在跑', () => {
  const events = [
    { seq: 1, at: 0, kind: 'tool', ref: 'c1', uuid: null, text: 'command: ping', state: 'command', exitCode: null, live: false },
    { seq: 2, at: 0, kind: 'tool-result', ref: 'c1', uuid: null, text: '', state: 'running', exitCode: null, live: false },
  ];
  const sum = (over: boolean) => describeChat({ clipped: false, events } as never, over).kids[0]!.slots!.sum!.text;
  assert.ok(sum(false).endsWith(TOWER_TEXT['res.running']!));
  assert.ok(sum(true).endsWith(TOWER_TEXT['res.over']!));
});
