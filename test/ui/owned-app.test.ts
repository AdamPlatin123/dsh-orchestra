import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeElement, parseHtml, type FakeDocument } from '../helpers/fake-dom.ts';
import { TOWER_TEXT } from '../../shared/strings.js';
import { towerFromStage, type OwnedSeat } from '../../src/sources/tower.ts';
import { busyStage } from '../helpers/tower-fixture.ts';
import { approvalOf, seatOf } from '../helpers/owned-fixture.ts';
import {
  allowHow, apprActs, atBottom, describeCard, chatNews, describeAskPins, describeChat, describeOwned, describeOwnedDock, describeRequestPins, errText, mergeFeed, msgError, notifyText, pinExtra, queuedN, requestModel, requestOf, whyText, withQueued, withRequests, type Approval, type Guard,
} from '../../ui/owned.js';
import { describeNew } from '../../ui/dlg-new.js';

// Orchestra's own sessions on the page (orchestra app plan §2-§5): ui/home.js booted against the
// real ui/home.html in the fake DOM, with the network, the clock, the timers, local storage and
// notifications stubbed (ported from the old tower page's boot, 2026-11-08: ui/drive.js holds these rules).
// It proves the pairing flow, the dispatch dialog's request, the chat, the question card's answer, and the
// approval guards of r4 §10.9 under D8: an allow carries the digest and the queue revision, is void for
// 750 ms after the list moved, is held for a high-risk request, never shows for a request the waiting bar
// cannot show whole or for a native or inferred wait, and no notification or title says allow.
// Synthetic data only.

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/home.html', import.meta.url)), 'utf8');
const HOME = pathToFileURL(fileURLToPath(new URL('../../ui/home.js', import.meta.url))).href;
const ALLOW = TOWER_TEXT['appr.allow']!;
const CSRF = 'A'.repeat(43);
const ID = { a: 'a'.repeat(20), b: 'b'.repeat(20), c: 'c'.repeat(20), n: 'd'.repeat(20) };
const AP = { a: '1'.repeat(32), b: '2'.repeat(32), c: '3'.repeat(32), d: '4'.repeat(32) };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Listener = (e: any) => void;
const listeners = new WeakMap<object, Map<string, Listener[]>>();
const on = (target: object, type: string, fn: Listener) => {
  let m = listeners.get(target);
  if (m === undefined) listeners.set(target, (m = new Map()));
  m.set(type, [...(m.get(type) ?? []), fn]);
};
const fire = (target: object, type: string, e: Record<string, unknown> = {}) => {
  const ev = { preventDefault() { (ev as any).prevented = true; }, isComposing: false, ...e };
  for (const fn of listeners.get(target)?.get(type) ?? []) fn(ev);
  return ev as any;
};

const OBSERVED = towerFromStage(busyStage()).meta.observedAt;
const MIN = 60_000;
const seat = (ownedId: string, title: string, state: OwnedSeat['state'], deadline: number | null): OwnedSeat =>
  seatOf({ ownedId, title, state, lastAt: OBSERVED, waiting: deadline === null ? null : { kind: 'approval', deadline, title: 'req' } });
const approval = (id: string, ownedId: string, over: Partial<Approval> & { rev: number }) =>
  approvalOf({ approvalId: id, ownedId, preview: 'command: npm test\ncwd: work', digest: id.slice(0, 1).repeat(64), risk: 'write', high: false, deadline: OBSERVED + 20 * MIN, ...over });
const LONG = Array.from({ length: 12 }, (_, i) => `+ line ${i} of a long diff that will not fit on the waiting bar`).join('\n');

test('owned sessions: pairing, the guarded approvals, the chat, the composer, dispatch, notifications', async () => {
  const doc: FakeDocument = parseHtml(HTML);
  const frames: (() => void)[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const timeouts: { fn: () => void; ms: number; off: boolean }[] = [];
  const requests: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const notes: { title: string; body: string }[] = [];
  const prompts: string[] = [];
  let promptAnswer: string | null = null;
  const store = new Map<string, string>();
  let mono = 1000;
  let seats: OwnedSeat[] = [seat(ID.a, 'fix the css', 'running', OBSERVED + 20 * MIN), seat(ID.b, 'run tests', 'idle', OBSERVED + 10 * MIN), seat(ID.c, 'refactor', 'idle', OBSERVED + 25 * MIN)];
  let list: Record<string, any> = {
    v: 1, kind: 'owned-list', rev: 3, enabled: true, disabledWhy: null, brakeWhy: null, harnesses: { codex: true, claude: false },
    owned: [
      { ownedId: ID.a, harness: 'codex', model: 'codex/gpt-6.1-sol', title: 'fix the css', state: 'running', endReason: null, waiting: AP.a, queued: 0, tokens: { input: 1, cachedInput: 0, output: 1, total: 2 }, lastSeq: 7, createdAt: 1, brake: true, stoppable: false, stoppable: false },
      { ownedId: ID.b, harness: 'codex', model: 'codex/gpt-6.1-sol', title: 'run tests', state: 'idle', endReason: null, waiting: AP.b, queued: 0, tokens: null, lastSeq: 1, createdAt: 2 },
      { ownedId: ID.c, harness: 'codex', model: 'zcode/GLM-5.3', title: 'refactor', state: 'idle', endReason: null, waiting: AP.c, queued: 0, tokens: null, lastSeq: 1, createdAt: 3 },
    ],
    approvals: [
      approval(AP.a, ID.a, { kind: 'file-change', preview: '--- update src/a.css\n-a\n+b', rev: 1 }),
      approval(AP.b, ID.b, { risk: 'shell', high: true, deadline: OBSERVED + 10 * MIN, rev: 2 }),
      approval(AP.c, ID.c, { kind: 'file-change', preview: LONG, deadline: OBSERVED + 25 * MIN, rev: 3 }),
    ],
    limits: { maxOwned: 4, active: 3 },
  };
  const feed = {
    v: 1, kind: 'owned-feed', ownedId: ID.a, from: 0, to: 7, clipped: false,
    events: [
      { seq: 1, at: 1, kind: 'you', ref: null, uuid: '00000000-0000-4000-8000-000000000000', text: 'please fix the css', state: null, redactions: 0, live: false, exitCode: null, tokens: null },
      { seq: 2, at: 2, kind: 'lifecycle', ref: 't1', uuid: null, text: null, state: 'turn-started', redactions: 0, live: false, exitCode: null, tokens: null },
      { seq: 3, at: 3, kind: 'text', ref: 'm1', uuid: null, text: 'Looking at the css', state: 'final', redactions: 0, live: false, exitCode: null, tokens: null },
      { seq: 4, at: 4, kind: 'tool', ref: 'i1', uuid: null, text: 'command: rg color\ncwd: work', state: 'command', redactions: 0, live: false, exitCode: null, tokens: null },
      { seq: 5, at: 5, kind: 'tool-result', ref: 'i1', uuid: null, text: 'a.css:1 color: red', state: 'ran', redactions: 0, live: false, exitCode: 0, tokens: null },
      { seq: 6, at: 6, kind: 'ask', ref: AP.a, uuid: null, text: 'edit 1 file', state: 'file-change', redactions: 0, live: false, exitCode: null, tokens: null },
      { seq: 7, at: 7, kind: 'note', ref: null, uuid: null, text: null, state: 'tokens', redactions: 0, live: true, exitCode: null, tokens: { input: 1, cachedInput: 0, output: 1, total: 2 } },
    ],
  };
  // seat: the pending agent requests every page sees before the pairing (harness and deadline only).
  let asks: { harness: 'codex' | 'claude'; deadline: number }[] = [{ harness: 'codex', deadline: OBSERVED + 7 * MIN }];
  const tower = () => towerFromStage(busyStage(), { seats, nowWall: OBSERVED, asks });
  const SUGGESTION = {
    routeId: 'e'.repeat(20), title: '写发布说明', titleSource: 'model', taskClass: 'general', rules: ['fallback'],
    router: { model: 'zcode/GLM-5.3', state: 'answered', why: null, pick: 0 },
    candidates: [
      { harness: 'codex', model: 'zcode/GLM-5.3', source: 'model', rule: null, reason: '纯文字活' },
      { harness: 'codex', model: 'codex/gpt-6.1-sol', source: 'rule', rule: 'fallback', reason: null },
    ],
    off: ['claude'],
    full: false,
  };
  let suggestion: Record<string, any> = SUGGESTION;
  /** While set, a brake is answered with it (status, body). */
  let brakeAnswer: { status: number; body: unknown } | null = null;
  /** While set, a suggestion's reply waits for it (the router model takes its time). */
  let suggestHold: Promise<void> | null = null;
  /** While set, the daemon takes no token (a browser forgotten elsewhere), and prints no code (its console is off). */
  let tokenDead = false;
  let codeOff = false;
  const loc = { hash: '', href: '', pathname: '/', search: '', replace(u: string) { this.hash = u.slice(u.indexOf('#')); } };
  const win = {};
  Object.assign(doc, { hidden: false, addEventListener: (t: string, fn: Listener) => on(doc, t, fn) });
  (FakeElement.prototype as any).addEventListener = function (this: object, t: string, fn: Listener) { on(this, t, fn); };
  const g = globalThis as any;
  const keys = ['document', 'location', 'window', 'fetch', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Element', 'Node', 'localStorage', 'Notification'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  define('document', doc);
  define('location', loc);
  define('window', {
    addEventListener: (t: string, fn: Listener) => on(win, t, fn), matchMedia: () => ({ matches: false }),
    prompt: (m: string) => { prompts.push(m); return promptAnswer; },
  });
  define('performance', { now: () => mono });
  define('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  define('setInterval', (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; });
  define('clearInterval', () => {});
  define('setTimeout', (fn: () => void, ms: number) => { timeouts.push({ fn, ms, off: false }); return timeouts.length; });
  define('clearTimeout', (id: number) => { const t = timeouts[id - 1]; if (t !== undefined) t.off = true; });
  define('Element', FakeElement);
  define('Node', FakeElement);
  define('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  define('Notification', class { static permission = 'granted'; constructor(title: string, o: { body: string }) { notes.push({ title, body: o.body }); } });
  const reply = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new SyntaxError('no body'); return structuredClone(body); } });
  define('fetch', async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method, url, headers, body });
    const token = headers['x-orchestra-csrf'] === CSRF;
    if (url === '/api/tower') return reply(200, tower());
    if (url === '/api/pair-code') return codeOff ? reply(503) : reply(204);
    if (url === '/api/pair') return body.code === '12345678' ? reply(200, { csrf: CSRF }) : reply(403, { error: 'not-unlocked', why: 'wrong' });
    if (!token || tokenDead) return reply(403, { error: 'not-unlocked' });
    if (url === '/api/owned') return reply(200, list);
    if (url.startsWith(`/api/owned/${ID.a}/feed`)) return reply(200, url.endsWith('after=0') ? feed : { ...feed, from: 7, events: [] });
    if (url === '/api/owned/new') return reply(200, { ownedId: ID.n, actionId: body.actionId, accepted: true, jseq: 9 });
    if (url.endsWith('/brake') && brakeAnswer !== null) return reply(brakeAnswer.status, brakeAnswer.body);
    if (url === '/api/route/suggest') {
      if (suggestHold !== null) await suggestHold;
      return reply(200, suggestion);
    }
    return reply(200, { actionId: body?.actionId, accepted: true, jseq: 10 });
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    while (frames.length > 0) frames.shift()!();
  };
  const click = async (el: FakeElement | null) => {
    assert.ok(el !== null, 'nothing to click');
    fire(doc, 'click', { target: el });
    await flush();
  };
  const tick = async () => { intervals.find((i) => i.ms === 1000)!.fn(); await flush(); };
  const posts = (part: string) => requests.filter((r) => r.method === 'POST' && r.url.includes(part));
  const pins = () => doc.getElementById('pins')!.querySelectorAll('.pin');
  const pinOf = (id: string) => pins().find((p) => p.getAttribute('data-node') === `n:${id}`)!;
  const btns = (el: FakeElement) => el.querySelectorAll('button').filter((b) => b.classList.contains('btn'));
  const act = (el: FakeElement, a: string) => btns(el).find((b) => b.getAttribute('data-act') === a) ?? null;
  try {
    await import(HOME);
    await flush();

    // Not paired: the top bar offers to pair; each Orchestra entry of the waiting bar offers only that; a
    // native or inferred wait has no button at all. No owned route is read without the token.
    const bar = doc.getElementById('top')!;
    const desk = doc.getElementById('desk')!;
    assert.equal(bar.querySelector('[data-act=pair]')!.textContent, TOWER_TEXT['bar.pair']);
    // seat: a pending agent request shows before the pairing too (the tower's router.asks): its harness, the
    // time left before it is refused (D8), the pairing button; its text and who asked only once paired.
    // It is sorted in by its deadline (7 min, before the approvals' 10, 20 and 25).
    assert.equal(pins().length, 6);
    const ask = pins()[0]!;
    assert.ok(ask.classList.contains('req'));
    assert.equal(ask.querySelector('[data-slot=kind]')!.textContent, '有请求要派 Codex：');
    assert.equal(ask.querySelector('[data-slot=what]')!.textContent, TOWER_TEXT['req.lockedWhat']);
    assert.equal(ask.querySelector('[data-slot=clock]')!.textContent, '剩 7:00 自动拒');
    assert.deepEqual(btns(ask).map((b) => b.textContent), [TOWER_TEXT['op.lock']]);
    assert.equal(doc.getElementById('pins')!.querySelector('[data-slot=n]')!.textContent, '6 件', 'T3: the count is the list');
    assert.equal(doc.title, TOWER_TEXT['home.titleWait']!.replace('{n}', '6'), 'the tab counts the pending request with the waiting nodes');
    asks = [];
    for (const id of [ID.a, ID.b, ID.c]) assert.deepEqual(btns(pinOf(id)).map((b) => b.textContent), [TOWER_TEXT['op.lock']]);
    const foreign = pins().filter((p) => p.getAttribute('data-src') !== 'orchestra' && !p.classList.contains('req'));
    assert.deepEqual(foreign.map((p) => p.getAttribute('data-src')).sort(), ['inferred', 'native']);
    for (const p of foreign) assert.equal(btns(p).length, 0);
    assert.ok(!requests.some((r) => r.url.startsWith('/api/owned') || r.url.startsWith('/api/approvals')));
    // The dispatch entry says it dispatches (派活), locked or not.
    assert.equal(desk.querySelector('[data-act=new]')!.textContent, TOWER_TEXT['bar.newLocked']);
    assert.equal(desk.querySelector('[data-act=new]')!.getAttribute('title'), TOWER_TEXT['bar.newHint']);

    // Pairing: with no token the dialog opened by itself and asked for no code (the one printed at the start may
    // be good); the button asks the daemon to print one (no body); a wrong code says so.
    const dlg = doc.getElementById('pair-dlg')!;
    assert.equal(dlg.open, true);
    assert.equal(posts('/api/pair-code').length, 0, 'opening asks for no code');
    await click(bar.querySelector('[data-act=pair]'));
    assert.equal(posts('/api/pair-code').length, 0);
    await click(dlg.querySelector('[data-act=pairCode]'));
    assert.deepEqual(posts('/api/pair-code').map((r) => r.body), [undefined]);
    assert.equal(dlg.querySelector('[data-slot=msg]')!.textContent, TOWER_TEXT['pair.asked']);
    // Each code replaces the last: more clicks (a held Enter) while the printed one is good ask for no new one.
    for (let i = 0; i < 3; i++) await click(dlg.querySelector('[data-act=pairCode]'));
    assert.equal(posts('/api/pair-code').length, 1, 'one click, at most one code: the printed code stays the one to type');
    (doc.getElementById('pr-code') as any).value = '00000000';
    await click(dlg.querySelector('[data-act=pairGo]'));
    assert.equal(dlg.querySelector('[data-slot=msg]')!.textContent, TOWER_TEXT['pair.wrong']);
    assert.equal(posts('/api/pair-code').length, 1, 'a wrong try leaves the code good: still no new one');
    assert.equal(store.size, 0);
    (doc.getElementById('pr-code') as any).value = '12345678';
    fire(doc, 'keydown', { target: doc.getElementById('pr-code'), key: 'Enter' });
    await flush();
    assert.equal(dlg.open, false);
    assert.deepEqual([...store.values()], [CSRF], 'the token is kept in this browser\'s local storage');
    const read = requests.find((r) => r.url === '/api/owned')!;
    assert.equal(read.headers['x-orchestra-csrf'], CSRF);
    assert.equal(bar.querySelector('[data-act=pair]')!.textContent, TOWER_TEXT['bar.paired']);
    assert.ok(posts('/api/pair').every((r) => !('x-orchestra-csrf' in r.headers)), 'pairing carries no token');
    assert.equal(desk.querySelector('[data-act=new]')!.textContent, TOWER_TEXT['bar.new']);

    // The waiting bar: the allow shows only where the whole request shows; a long one offers 去看.
    assert.deepEqual(btns(pinOf(ID.a)).map((b) => b.getAttribute('data-act')), ['deny', 'allow']);
    assert.equal(pinOf(ID.a).querySelector('[data-slot=pv]')!.textContent, list.approvals[0].preview);
    assert.deepEqual(btns(pinOf(ID.c)).map((b) => b.getAttribute('data-act')), ['deny', 'see']);
    assert.equal(pinOf(ID.c).querySelector('[data-slot=pv]')!.textContent, '');
    assert.equal(act(pinOf(ID.b), 'allow')!.textContent, TOWER_TEXT['appr.hold']);
    for (const p of foreign) assert.ok(!p.textContent.includes(ALLOW), 'a native or inferred wait never offers an allow');

    // Within 750 ms of the list's change an allow is void and shows it; afterwards it carries the
    // digest of what is shown and the queue revision it was drawn from.
    const allowA = act(pinOf(ID.a), 'allow')!;
    assert.equal(allowA.getAttribute('aria-disabled'), 'true');
    assert.match(allowA.getAttribute('data-settle')!, /^[ab]$/);
    mono += 100;
    await click(allowA);
    assert.equal(posts('/allow').length, 0, 'an allow within 750 ms of a change is not sent');
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['appr.settling']);
    mono += 700;
    await tick();
    assert.equal(allowA.getAttribute('aria-disabled'), null);
    assert.equal(allowA.getAttribute('data-settle'), '');
    await click(allowA);
    const sent = posts(`/api/approvals/${AP.a}/allow`);
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]!.body).sort(), ['actionId', 'digest', 'rev']);
    assert.equal(sent[0]!.body.digest, list.approvals[0].digest);
    assert.equal(sent[0]!.body.rev, list.rev);
    assert.match(sent[0]!.body.actionId, UUID_RE);
    assert.equal(sent[0]!.headers['x-orchestra-csrf'], CSRF);
    assert.equal(sent[0]!.headers['content-type'], 'application/json');

    // A high-risk allow: a click asks for the typed word (r4 §10.9's typed way); cancelled or wrong, nothing
    // goes; let go early and nothing goes; held 1 s (pointer or Enter) it goes.
    const allowB = act(pinOf(ID.b), 'allow')!;
    assert.equal(allowB.getAttribute('aria-label'), `${TOWER_TEXT['appr.holdLabel']!.replace('{t}', 'req')}`, 'the button names its request');
    assert.equal(act(pinOf(ID.b), 'deny')!.getAttribute('aria-label'), '拒绝：req');
    await click(allowB);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes('req') && prompts[0]!.includes(TOWER_TEXT['appr.typeWord']!), prompts[0]);
    assert.equal(posts(`/api/approvals/${AP.b}/allow`).length, 0, 'cancelled: nothing is sent');
    promptAnswer = '好';
    await click(allowB);
    assert.equal(posts(`/api/approvals/${AP.b}/allow`).length, 0, 'a wrong word: nothing is sent');
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['appr.typeWrong']);
    fire(doc, 'pointerdown', { target: allowB });
    await flush();
    assert.equal(allowB.getAttribute('data-hold'), '1');
    fire(doc, 'pointerup', { target: allowB });
    await flush();
    for (const t of timeouts.filter((x) => x.ms === 1000)) if (!t.off) t.fn();
    await flush();
    assert.equal(posts(`/api/approvals/${AP.b}/allow`).length, 0, 'let go before 1 s: nothing is sent');
    fire(doc, 'keydown', { target: allowB, key: 'Enter' });
    const hold = timeouts.at(-1)!;
    assert.equal(hold.ms, 1000);
    hold.fn();
    await flush();
    const held = posts(`/api/approvals/${AP.b}/allow`);
    assert.equal(held.length, 1);
    assert.deepEqual([held[0]!.body.digest, held[0]!.body.rev], [list.approvals[1].digest, list.rev]);
    fire(doc, 'keyup', { target: allowB, key: 'Enter' });
    // The click that ends a hold is the hold's own (no second allow, no prompt); the next click asks again.
    const asked = prompts.length;
    await click(allowB);
    assert.equal(prompts.length, asked);
    promptAnswer = ` ${TOWER_TEXT['appr.typeWord']} `;
    await click(allowB);
    assert.equal(prompts.length, asked + 1);
    const typedAllow = posts(`/api/approvals/${AP.b}/allow`);
    assert.equal(typedAllow.length, 2, 'the typed word lets it go');
    assert.deepEqual([typedAllow[1]!.body.digest, typedAllow[1]!.body.rev], [list.approvals[1].digest, list.rev]);

    // A deny is one request about one approval: no batch.
    await click(act(pinOf(ID.c), 'deny'));
    assert.deepEqual(posts('/deny').map((r) => [r.url, Object.keys(r.body)]), [[`/api/approvals/${AP.c}/deny`, ['actionId']]]);

    // An owned session opened from the left list: the card in full with its buttons, the chat with each command
    // folded under one line.
    const row = doc.getElementById('rail')!.querySelectorAll('.rr').find((r) => r.getAttribute('data-node') === `n:${ID.a}`)!;
    fire(doc, 'click', { target: row.querySelector('[data-slot=name]') });
    assert.equal(loc.hash, `#/n/n:${ID.a}`);
    fire(win, 'hashchange');
    await flush();
    await flush(); // the feed is read once the page shows the session
    const detail = doc.getElementById('detail')!;
    assert.equal(detail.querySelector('[data-slot=ownBox]')!.getAttribute('data-hide'), '0');
    assert.equal(detail.querySelector('[data-slot=evBox]')!.getAttribute('data-hide'), '1');
    const cards = detail.querySelectorAll('.card');
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.querySelector('[data-slot=pv]')!.textContent, list.approvals[0].preview);
    assert.match(cards[0]!.querySelector('[data-slot=left]')!.textContent, /^剩 \d+:\d\d 自动拒$/);
    assert.deepEqual(btns(cards[0]!).map((b) => b.getAttribute('data-act')), ['deny', 'allow']);
    for (const b of btns(cards[0]!)) assert.ok(b.parentNode !== null && (b.parentNode as FakeElement).classList.contains('acts'), 'card buttons sit in .acts (44px)');
    assert.ok(requests.some((r) => r.url === `/api/owned/${ID.a}/feed?after=0`));
    const chat = detail.querySelector('[data-slot=chat]')!;
    const items = chat.children;
    assert.equal(items.length, 5, 'you, turn started, its text, one folded command, the ask (the token count is not a message)');
    const tool = items.find((li) => li.querySelector('details') !== null)!;
    assert.match(tool.querySelector('summary')!.textContent, /rg color · 已返回 · 退出码 0$/);
    assert.match(tool.querySelector('[data-slot=body]')!.textContent, /a\.css:1 color: red/);
    assert.equal(doc.textContent.includes('完成'), false, 'T2');
    assert.equal(detail.querySelector('[data-slot=chatSay]')!.textContent, '', 'opening a session reads none of its past aloud');

    // The composer: to this session; a running turn takes the message as a steer.
    const dock = doc.getElementById('dock')!;
    assert.equal(dock.getAttribute('aria-disabled'), 'false');
    assert.equal(act(dock, 'send')!.textContent, TOWER_TEXT['dock.sendSteer']);
    (doc.getElementById('dock-in') as any).value = '/model x';
    await click(act(dock, 'send'));
    assert.equal(posts('/message').length, 0, 'a slash command never leaves the page');
    (doc.getElementById('dock-in') as any).value = 'use the theme colour';
    fire(doc, 'input', { target: doc.getElementById('dock-in') });
    await click(act(dock, 'send'));
    assert.deepEqual(posts('/message').map((r) => [r.url, r.body.text, Object.keys(r.body).sort()]), [[`/api/owned/${ID.a}/message`, 'use the theme colour', ['actionId', 'text']]]);
    // Ending takes a second click; interrupting does not.
    await click(act(dock, 'end'));
    assert.equal(posts('/end').length, 0);
    assert.equal(act(dock, 'end')!.textContent, TOWER_TEXT['dock.endSure']);
    await click(act(dock, 'end'));
    assert.equal(posts(`/api/owned/${ID.a}/end`).length, 1);
    await click(act(dock, 'interrupt'));
    assert.equal(posts(`/api/owned/${ID.a}/interrupt`).length, 1);
    // The brake (a session in a Job of its own): the third stop, two clicks like end, its whole tree.
    assert.equal(act(dock, 'brake')!.textContent, TOWER_TEXT['dock.brake']);
    await click(act(dock, 'brake'));
    assert.equal(posts('/brake').length, 0, 'one click arms it only');
    assert.equal(act(dock, 'brake')!.textContent, TOWER_TEXT['dock.brakeSure']);
    assert.equal(act(dock, 'brake')!.getAttribute('data-armed'), '1');
    await click(act(dock, 'brake'));
    assert.deepEqual(posts('/brake').map((r) => [r.url, Object.keys(r.body)]), [[`/api/owned/${ID.a}/brake`, ['actionId']]]);
    // A brake the server refuses as unavailable says this session's reason (the list's brakeWhy), not the
    // shared code's text about the M0 protection list (phase 4 review).
    brakeAnswer = { status: 503, body: { error: 'brake-unavailable' } };
    await click(act(dock, 'brake'));
    await click(act(dock, 'brake'));
    const said = doc.getElementById('note')!.textContent;
    assert.equal(said, TOWER_TEXT['dock.noBrake']!.replace('{why}', TOWER_TEXT['bwhy.no-job']!), said);
    assert.ok(!said.includes('保护名单'), said);
    brakeAnswer = null;

    // Dispatch: Claude greyed with why; nothing goes until 派出; the request names harness and model.
    await click(desk.querySelector('[data-act=new]'));
    const nd = doc.getElementById('new-dlg')!;
    assert.equal(nd.open, true);
    assert.equal(nd.querySelector('[data-slot=hClaude]')!.getAttribute('disabled'), '', 'Claude greyed');
    assert.equal(nd.querySelector('[data-slot=hCodex]')!.getAttribute('disabled'), null);
    assert.ok(nd.querySelector('[data-slot=why]')!.textContent.includes(TOWER_TEXT['new.claudeOff']!));
    assert.deepEqual(doc.getElementById('nw-model')!.querySelectorAll('option').map((o) => o.getAttribute('value')), ['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'codex/gpt-6.1-terra', 'zcode/GLM-5.3', 'opencode-go/glm-5.3']);
    assert.equal(nd.querySelector('[data-slot=note]')!.textContent, TOWER_TEXT['new.sandbox']);
    assert.equal(posts('/api/owned/new').length, 0);
    (doc.getElementById('nw-text') as any).value = 'write the release notes';
    (doc.getElementById('nw-model') as any).value = 'zcode/GLM-5.3';
    await click(nd.querySelector('[data-act=dispatch]'));
    const made = posts('/api/owned/new');
    assert.equal(made.length, 1);
    assert.deepEqual(Object.keys(made[0]!.body).sort(), ['actionId', 'harness', 'model', 'text']);
    assert.deepEqual([made[0]!.body.text, made[0]!.body.harness, made[0]!.body.model], ['write the release notes', 'codex', 'zcode/GLM-5.3']);
    assert.equal(nd.open, false);
    assert.equal(loc.hash, `#/n/n:${ID.n}`, 'the new session opens');

    // The dispatch desk: 给建议 sends the sentence alone (no actionId: it starts nothing), the card lists
    // first and alternatives with harness, model, reason and source; the first is picked into the selects;
    // another pick moves them; 派出 carries the card's routeId. An edited sentence makes the card stale.
    await click(desk.querySelector('[data-act=new]'));
    assert.equal(nd.open, true);
    const card = nd.querySelector('[data-slot=card]')!;
    assert.equal(card.getAttribute('data-hide'), '1', 'no card before 给建议');
    assert.equal(nd.querySelector('[data-act=suggest]')!.textContent, TOWER_TEXT['new.ask']);
    (doc.getElementById('nw-text') as any).value = '写一下这次的发布说明';
    await click(nd.querySelector('[data-act=suggest]'));
    const suggested = posts('/api/route/suggest');
    assert.equal(suggested.length, 1);
    assert.deepEqual(suggested[0]!.body, { text: '写一下这次的发布说明' });
    assert.equal(suggested[0]!.headers['x-orchestra-csrf'], CSRF);
    assert.equal(posts('/api/owned/new').length, 1, 'a suggestion dispatches nothing');
    assert.equal(card.getAttribute('data-hide'), '0');
    // The model's title says it is the model's (the sentence is the person's own).
    assert.equal(nd.querySelector('[data-slot=rtTitle]')!.textContent, TOWER_TEXT['route.taskTitleModel']!.replace('{t}', '写发布说明'));
    const cands = () => nd.querySelector('[data-slot=cands]')!.querySelectorAll('.cand');
    assert.deepEqual(cands().map((c) => [c.querySelector('[data-slot=rank]')!.textContent, c.querySelector('[data-slot=hm]')!.textContent, c.querySelector('[data-slot=src]')!.textContent, c.querySelector('[data-slot=why]')!.textContent]), [
      [TOWER_TEXT['route.first'], 'Codex · zcode/GLM-5.3', TOWER_TEXT['route.src.model'], '纯文字活'],
      [TOWER_TEXT['route.alt'], 'Codex · codex/gpt-6.1-sol', TOWER_TEXT['route.src.rule'], TOWER_TEXT['route.why.fallback']],
    ]);
    const pressed = () => cands().map((c) => c.querySelector('button')!.getAttribute('aria-pressed'));
    assert.deepEqual(pressed(), ['true', 'false'], 'the first is picked');
    // A reader hears rank, harness and model, source and reason apart; the dialog's own line says what was picked.
    assert.equal(cands()[0]!.querySelector('button')!.getAttribute('aria-label'), `${TOWER_TEXT['route.first']}：Codex · zcode/GLM-5.3；来源：${TOWER_TEXT['route.src.model']}；理由：纯文字活`);
    assert.ok(nd.querySelector('[data-slot=msg]')!.textContent.startsWith(TOWER_TEXT['route.picked']!.replace('{h}', 'Codex').replace('{m}', 'zcode/GLM-5.3')), nd.querySelector('[data-slot=msg]')!.textContent);
    assert.equal((doc.getElementById('nw-model') as any).value, 'zcode/GLM-5.3');
    await click(cands()[1]!.querySelector('button'));
    assert.deepEqual(pressed(), ['false', 'true']);
    assert.equal((doc.getElementById('nw-model') as any).value, 'codex/gpt-6.1-sol');
    assert.ok(nd.querySelector('[data-slot=rtNote]')!.textContent.includes('zcode/GLM-5.3'));
    await click(nd.querySelector('[data-act=dispatch]'));
    const routed = posts('/api/owned/new').at(-1)!;
    assert.deepEqual(Object.keys(routed.body).sort(), ['actionId', 'harness', 'model', 'routeId', 'text']);
    assert.deepEqual([routed.body.harness, routed.body.model, routed.body.routeId], ['codex', 'codex/gpt-6.1-sol', 'e'.repeat(20)]);
    assert.equal(nd.open, false);

    // No answer from the router model: the card says the rules alone; set by hand; an edited sentence: stale, no routeId.
    suggestion = { ...SUGGESTION, routeId: 'f'.repeat(20), router: { model: 'zcode/GLM-5.3', state: 'no-answer', why: 'timeout', pick: null }, candidates: [SUGGESTION.candidates[1]] };
    await click(desk.querySelector('[data-act=new]'));
    (doc.getElementById('nw-text') as any).value = '再写一份';
    await click(nd.querySelector('[data-act=suggest]'));
    assert.ok(nd.querySelector('[data-slot=rtNote]')!.textContent.startsWith(`没用上路由模型（${TOWER_TEXT['route.no.timeout']}）`), nd.querySelector('[data-slot=rtNote]')!.textContent);
    assert.equal(nd.querySelector('[data-slot=rtTitle]')!.textContent, TOWER_TEXT['route.taskTitleModel']!.replace('{t}', '写发布说明'));
    (doc.getElementById('nw-model') as any).value = 'codex/gpt-6-astra';
    fire(doc, 'change', { target: doc.getElementById('nw-model') });
    await flush();
    assert.equal(nd.querySelector('[data-slot=rtPick]')!.textContent, TOWER_TEXT['route.manual']);
    (doc.getElementById('nw-text') as any).value = '再写一份，短一点';
    fire(doc, 'input', { target: doc.getElementById('nw-text') });
    await flush();
    assert.equal(card.getAttribute('data-stale'), '1');
    await click(nd.querySelector('[data-act=dispatch]'));
    assert.equal(Object.hasOwn(posts('/api/owned/new').at(-1)!.body, 'routeId'), false, 'a stale card goes without its routeId');

    // A reply that comes after the person chose by hand changes nothing they chose; one that comes after
    // the dialog closed is dropped.
    suggestion = { ...SUGGESTION, routeId: 'a'.repeat(20) };
    let letGo!: () => void;
    suggestHold = new Promise<void>((r) => { letGo = r; });
    await click(desk.querySelector('[data-act=new]'));
    (doc.getElementById('nw-text') as any).value = '第三份';
    await click(nd.querySelector('[data-act=suggest]'));
    (doc.getElementById('nw-model') as any).value = 'codex/gpt-6.1-terra';
    fire(doc, 'change', { target: doc.getElementById('nw-model') });
    letGo();
    await flush();
    assert.equal((doc.getElementById('nw-model') as any).value, 'codex/gpt-6.1-terra', 'the hand-made choice stays');
    assert.equal(nd.querySelector('[data-slot=card]')!.getAttribute('data-hide'), '0', 'the card still shows');
    suggestion = { ...SUGGESTION, routeId: 'b'.repeat(20) };
    suggestHold = new Promise<void>((r) => { letGo = r; });
    await click(nd.querySelector('[data-act=suggest]'));
    nd.close();
    letGo();
    await flush();
    suggestHold = null;
    assert.equal((doc.getElementById('nw-model') as any).value, 'codex/gpt-6.1-terra', 'a closed dialog is not filled');

    // The waiting bar holds its order while the pointer is in it; the move shows once it leaves.
    loc.hash = '#/';
    fire(win, 'hashchange');
    const pinsEl = doc.getElementById('pins')!;
    const order = () => pins().filter((p) => p.getAttribute('data-src') === 'orchestra').map((p) => p.getAttribute('data-node'));
    assert.deepEqual(order(), [`n:${ID.b}`, `n:${ID.a}`, `n:${ID.c}`]);
    fire(pinsEl, 'pointerenter');
    seats = [seat(ID.a, 'fix the css', 'running', OBSERVED + 5 * MIN), ...seats.slice(1)];
    intervals.find((i) => i.ms === 2000)!.fn();
    await flush();
    assert.deepEqual(order(), [`n:${ID.b}`, `n:${ID.a}`, `n:${ID.c}`]);
    fire(pinsEl, 'pointerleave');
    await flush();
    assert.deepEqual(order(), [`n:${ID.a}`, `n:${ID.b}`, `n:${ID.c}`]);

    // seat: an agent request waits in 「等你」 as a card (the one expiring first on top): who asked, what,
    // where it wanted to work, the model 派出 would take, the time left; 派出 and 拒绝 only here (D8).
    const REQ = { a: '5'.repeat(20), b: '6'.repeat(20) };
    const req = (requestId: string, over: Record<string, unknown> = {}) => ({
      requestId, harness: 'codex', label: null, text: '修一下登录页的样式\n第二行', cwd: 'D:\\work\\shop', requester: 'dsh:sess-1', state: 'pending', createdAt: OBSERVED,
      expiresAt: OBSERVED + 9 * MIN, ownedId: null, why: null, fetched: false,
      suggestion: { routeId: 'f'.repeat(20), router: 'answered', models: [{ model: 'codex/gpt-6.1-terra', source: 'model', rule: null, reason: '改样式' }], pick: 0 }, suggesting: 'ready', ...over,
    });
    list = { ...list, requests: [req(REQ.a), req(REQ.b, { suggestion: null, suggesting: 'asking', label: '跑测试', expiresAt: OBSERVED + 2 * MIN }), req('7'.repeat(20), { state: 'rejected', why: 'you-rejected' })] };
    intervals.find((i) => i.ms === 2000)!.fn();
    await flush();
    const reqs = () => pins().filter((p) => p.classList.contains('req'));
    assert.deepEqual(reqs().map((p) => p.getAttribute('data-req')), [REQ.b, REQ.a], 'pending only, the one expiring first on top');
    const cardA = reqs()[1]!;
    assert.equal(cardA.querySelector('[data-slot=kind]')!.textContent, '以 DSH 名义请求派 Codex：');
    assert.equal(cardA.querySelector('[data-slot=what]')!.textContent, '修一下登录页的样式');
    assert.equal(cardA.querySelector('[data-slot=clock]')!.textContent, '剩 9:00 自动拒');
    assert.ok(cardA.querySelector('[data-slot=meta]')!.textContent.includes('自称来自 DSH 会话 sess-1（未核实）'), 'who asked is its own word, never a checked identity');
    assert.ok(cardA.querySelector('[data-slot=meta]')!.textContent.includes('模型 codex/gpt-6.1-terra（路由模型建议）'));
    assert.equal(reqs()[0]!.querySelector('[data-slot=what]')!.textContent, '跑测试', 'a label names it');
    assert.ok(reqs()[0]!.querySelector('[data-slot=meta]')!.textContent.includes('模型 codex/gpt-6.1-sol（默认；路由建议还在问）'));
    // The request cards sort in by deadline with the approvals (2 min and 9 min; the approvals now 5, 10, 25 min).
    const order2 = pins().map((p) => p.getAttribute('data-req') || p.getAttribute('data-node'));
    assert.deepEqual(order2.slice(0, 4), [REQ.b, `n:${ID.a}`, REQ.a, `n:${ID.b}`], order2.join());
    assert.deepEqual(btns(cardA).map((b) => b.textContent), [TOWER_TEXT['req.no'], TOWER_TEXT['req.go'], TOWER_TEXT['req.re']]);
    assert.equal(doc.getElementById('pins')!.querySelector('[data-slot=n]')!.textContent, `${pins().length} 件`, 'T3: the count is the list, requests included');
    // 派出 is void for 750 ms after the bar moved (as an allow); then it is owned-new with the requestId and the card's words.
    assert.equal(act(cardA, 'req-go')!.getAttribute('aria-disabled'), 'true');
    await click(act(cardA, 'req-go'));
    assert.equal(posts('/api/owned/new').filter((r) => r.body.requestId !== undefined).length, 0, 'nothing leaves while the bar settles');
    mono += 800;
    await tick();
    await click(act(reqs()[1]!, 'req-go'));
    const go = posts('/api/owned/new').filter((r) => r.body.requestId !== undefined);
    assert.equal(go.length, 1);
    assert.deepEqual({ ...go[0]!.body, actionId: 'x' }, { actionId: 'x', text: '修一下登录页的样式\n第二行', harness: 'codex', model: 'codex/gpt-6.1-terra', requestId: REQ.a, routeId: 'f'.repeat(20) });
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['req.sent']);
    await click(act(reqs()[0]!, 'req-no'));
    assert.deepEqual(posts(`/api/agent-requests/${REQ.b}/reject`).map((r) => Object.keys(r.body)), [['actionId']]);
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['req.rejected']);
    // 改派: the card's 改派… opens a dialog on the card's harness and model; another harness redraws the models and
    // the where-line; 派出 is owned-new with the requestId and the card's words, on the harness and model picked.
    list = { ...list, harnesses: { codex: true, claude: true } };
    intervals.find((i) => i.ms === 2000)!.fn();
    await flush();
    mono += 800;
    await tick();
    const rd = doc.getElementById('re-dlg')!;
    await click(act(reqs()[1]!, 'req-re'));
    assert.equal(rd.open, true);
    assert.equal((doc.getElementById('re-harness') as any).value, 'codex');
    assert.equal((doc.getElementById('re-model') as any).value, 'codex/gpt-6.1-terra', 'the model 派出 would take');
    assert.equal(rd.querySelector('[data-slot=reWhat]')!.textContent, '修一下登录页的样式\n第二行');
    assert.equal(rd.querySelector('[data-slot=reAsked]')!.textContent, '它请求的是 Codex');
    assert.ok(rd.querySelector('[data-slot=reWhere]')!.textContent.includes('Codex 用 untrusted 审批策略'), 'tainted as the card says');
    (doc.getElementById('re-harness') as any).value = 'claude';
    fire(doc, 'change', { target: doc.getElementById('re-harness') });
    await flush();
    const reModels = doc.getElementById('re-model')!.querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.ok(reModels.length > 0 && reModels.every((m) => !String(m).startsWith('codex/')), reModels.join());
    assert.ok(rd.querySelector('[data-slot=reWhere]')!.textContent.includes('每次都先来问你'), 'the where-line for Claude, tainted all the same');
    // Back on the card's harness: the card's model again, not the list's first.
    (doc.getElementById('re-harness') as any).value = 'codex';
    fire(doc, 'change', { target: doc.getElementById('re-harness') });
    await flush();
    assert.equal((doc.getElementById('re-model') as any).value, 'codex/gpt-6.1-terra');
    (doc.getElementById('re-harness') as any).value = 'claude';
    fire(doc, 'change', { target: doc.getElementById('re-harness') });
    await flush();
    (doc.getElementById('re-model') as any).value = reModels[0];
    const sentBefore = posts('/api/owned/new').length;
    await click(rd.querySelector('[data-act=re-go]'));
    const moved = posts('/api/owned/new').slice(sentBefore);
    assert.equal(moved.length, 1);
    assert.deepEqual({ ...moved[0]!.body, actionId: 'x' }, { actionId: 'x', text: '修一下登录页的样式\n第二行', harness: 'claude', model: reModels[0], requestId: REQ.a, routeId: 'f'.repeat(20) });
    assert.equal(rd.open, false);
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['re.sent']);
    list = { ...list, requests: [] };

    // 回答: a question card behind session c's first request has its own pin with 回答…, never 允许. The dialog draws
    // each question, nothing picked; 提交 waits for a pick a question; an option pressed and a line typed go as
    // {option} and {text}, under the card's digest and the list's rev; then the dialog closes and the note says so.
    const QA = '5'.repeat(32);
    const QUESTIONS = [
      { header: 'Issues', question: 'File the bugs?', options: [{ label: 'All', description: '' }, { label: 'None', description: '' }], other: false },
      { header: 'Bots', question: 'Migrate them?', options: [{ label: 'No', description: 'they follow the new rule' }], other: true },
    ];
    const beforeQa = list;
    list = { ...list, rev: 4, approvals: [...list.approvals, approval(QA, ID.c, { kind: 'question', risk: 'other', title: 'File the bugs?', preview: 'Issues\nFile the bugs?', canAccept: false, canText: true, questions: QUESTIONS, rev: 4 })] };
    intervals.find((i) => i.ms === 2000)!.fn();
    await flush();
    mono += 800;
    await tick();
    const qaPin = pins().find((p) => act(p, 'qa') !== null)!;
    assert.ok(qaPin !== undefined, 'the question has its pin');
    assert.equal(act(qaPin, 'allow'), null, 'a question is never allowed, only answered or refused');
    const qd = doc.getElementById('qa-dlg')!;
    await click(act(qaPin, 'qa'));
    assert.equal(qd.open, true);
    const qs = () => qd.querySelectorAll('.qa');
    assert.deepEqual(qs().map((q) => q.querySelector('[data-slot=q]')!.textContent), ['File the bugs?', 'Migrate them?']);
    const opts = (i: number) => qs()[i]!.querySelectorAll('.qa-opt');
    assert.deepEqual(opts(0).map((o) => o.getAttribute('aria-pressed')), ['false', 'false'], 'nothing is picked for you');
    assert.equal(qs()[0]!.querySelector('.qa-opts')!.classList.contains('qa-seg'), true, 'two short options side by side');
    assert.equal(qs()[0]!.querySelector('.qa-in')!.getAttribute('data-hide'), '1', 'no line of your own where the question takes none');
    assert.equal(qs()[1]!.querySelector('.qa-in')!.getAttribute('data-hide'), '0');
    const goBtn = () => qd.querySelector('[data-act=qa-go]')!;
    assert.equal(goBtn().getAttribute('disabled'), '');
    fire(doc, 'click', { target: opts(0)[1]! });
    await flush();
    assert.deepEqual(opts(0).map((o) => o.getAttribute('aria-pressed')), ['false', 'true']);
    assert.equal(goBtn().getAttribute('disabled'), '', 'one question still has no pick');
    const line = qs()[1]!.querySelector('.qa-in')! as any;
    line.value = 'ask me first';
    fire(doc, 'input', { target: line });
    await flush();
    assert.equal(goBtn().getAttribute('disabled'), null);
    await click(goBtn());
    const answered = posts(`/api/approvals/${QA}/answer`);
    assert.equal(answered.length, 1);
    assert.deepEqual({ ...answered[0]!.body, actionId: 'x' }, { actionId: 'x', digest: '5'.repeat(64), rev: 4, answers: [{ option: 1 }, { text: 'ask me first' }] });
    assert.equal(qd.open, false);
    assert.equal(doc.getElementById('note')!.textContent, TOWER_TEXT['appr.answered']);
    list = { ...beforeQa, rev: 5 };

    // Hidden: a new approval is notified with who and what; no notification and no title says allow.
    // While hidden the tower and the queue are read every 10 s.
    list = { ...list, rev: 6, approvals: [...list.approvals, approval(AP.d, ID.b, { rev: 6 })] };
    doc.hidden = true;
    fire(doc, 'visibilitychange');
    await flush();
    assert.equal(intervals.at(-1)!.ms, 10_000);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.title, TOWER_TEXT['notify.title']);
    assert.ok(notes[0]!.body.startsWith('run tests'));
    // A new agent request while hidden is notified too (its time is short, D8), never with a dispatch in it.
    list = { ...list, requests: [req('8'.repeat(20), { expiresAt: OBSERVED + 10 * MIN })] };
    intervals.at(-1)!.fn();
    await flush();
    assert.equal(notes.length, 2);
    assert.equal(notes[1]!.title, TOWER_TEXT['notify.reqTitle']);
    assert.ok(notes[1]!.body.includes('Codex') && notes[1]!.body.includes('自动拒'), notes[1]!.body);
    intervals.at(-1)!.fn();
    await flush();
    assert.equal(notes.length, 2, 'once per request');
    for (const n of notes) assert.ok(!n.body.includes(TOWER_TEXT['req.go']) && !n.title.includes(TOWER_TEXT['req.go']));
    for (const n of notes) assert.ok(!n.title.includes(ALLOW) && !n.body.includes(ALLOW));
    assert.ok(!doc.title.includes(ALLOW));
    // Hidden, no frame draws: the tab's count still moves, from the tower read every 10 s (and back down).
    const count = () => Number(/^\((\d+)\)/.exec(doc.title)?.[1] ?? 0);
    const before = count();
    const towerReads = requests.filter((r) => r.url === '/api/tower').length;
    asks = [{ harness: 'codex', deadline: OBSERVED + 7 * MIN }, { harness: 'claude', deadline: OBSERVED + 8 * MIN }];
    intervals.at(-1)!.fn();
    await flush();
    assert.ok(requests.filter((r) => r.url === '/api/tower').length > towerReads, 'the tower is read while hidden');
    assert.equal(count(), before + 2, doc.title);
    asks = [];
    intervals.at(-1)!.fn();
    await flush();
    assert.equal(count(), before, doc.title);

    // Forget this browser: the top button says it is paired and asks first; cancelled, nothing goes; confirmed, the daemon
    // forgets it, the token goes, nothing owned is read again, and the pairing dialog does not open by itself.
    Object.assign(doc, { hidden: false });
    fire(doc, 'visibilitychange');
    await flush();
    const fg = doc.getElementById('forget-dlg')!;
    const pd = doc.getElementById('pair-dlg')!;
    await click(bar.querySelector('[data-act=pair]'));
    assert.equal(fg.open, true);
    assert.equal(pd.open, false);
    await click(fg.querySelector('[data-act=close]'));
    assert.equal(fg.open, false);
    assert.equal(posts('/api/pair/forget').length, 0, 'asked first');
    await click(bar.querySelector('[data-act=pair]'));
    await click(fg.querySelector('[data-act=forgetGo]'));
    const forgot = posts('/api/pair/forget');
    assert.deepEqual(forgot.map((r) => [r.headers['x-orchestra-csrf'], r.body]), [[CSRF, undefined]]);
    assert.equal(fg.open, false);
    assert.equal(store.has('orchestra.csrf'), false, 'the token is gone from storage');
    assert.equal(pd.open, false, 'a browser you forgot is asked nothing');
    assert.equal(bar.querySelector('[data-act=pair]')!.textContent, TOWER_TEXT['bar.pair']);
    const ownedReads = () => requests.filter((r) => r.url === '/api/owned').length;
    const was = ownedReads();
    for (const i of intervals) i.fn();
    await flush();
    assert.equal(ownedReads(), was, 'no owned read without the token');

    // Paired again, then the daemon stops taking the token: it is cleared at once and the dialog opens by itself.
    await click(bar.querySelector('[data-act=pair]'));
    assert.equal(pd.open, true);
    (doc.getElementById('pr-code') as any).value = '12345678';
    await click(pd.querySelector('[data-act=pairGo]'));
    assert.equal(pd.open, false);
    assert.equal(store.get('orchestra.csrf'), CSRF);
    tokenDead = true;
    for (const i of intervals) i.fn();
    await flush();
    assert.equal(store.has('orchestra.csrf'), false);
    assert.equal(pd.open, true, 'not paired any more: the dialog offers pairing');
    // With its console off the daemon prints no code: the dialog says so, in words.
    codeOff = true;
    const codesAsked = posts('/api/pair-code').length;
    await click(pd.querySelector('[data-act=pairCode]'));
    assert.equal(posts('/api/pair-code').length, codesAsked + 1);
    assert.equal(pd.querySelector('[data-slot=msg]')!.textContent, TOWER_TEXT['pair.off']);
  } finally {
    await flush();
    for (const [k, d] of Object.entries(saved)) {
      if (d === undefined) delete g[k];
      else Object.defineProperty(g, k, d);
    }
    delete (FakeElement.prototype as any).addEventListener;
  }
});

test('two sub-agents asking at once are two pins: 等你 counts the answers it takes, each with its own buttons (found on the page 2026-11-05)', () => {
  const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
  const first = approval(AP.a, ID.a, { rev: 1, deadline: 60_000 }) as Approval;
  const next = approval(AP.b, ID.a, { rev: 1, deadline: 120_000 }) as Approval;
  const other = approval('c'.repeat(32), ID.b, { rev: 1, deadline: 90_000 }) as Approval;
  const list = { owned: [{ ownedId: ID.a, waiting: first.approvalId }, { ownedId: ID.b, waiting: other.approvalId }], approvals: [first, next, other] } as any;
  const pin = (node: string, approvalId: string) => ({ key: node, data: { node, src: 'orchestra', sel: '0' }, slots: { path: { text: node }, clock: { text: 'first' }, acts: { kids: [{ data: { appr: approvalId } }] } } });
  const pins = { data: { hide: '0' }, slots: { n: { text: '2 件' }, note: { text: '' }, list: { kids: [pin(`n:${ID.a}`, first.approvalId), pin(`n:${ID.b}`, other.approvalId)] } } };
  const drawn = withQueued(pins, list, g) as any;
  const kids = drawn.slots.list.kids;
  assert.deepEqual(kids.map((k: any) => k.key), [`n:${ID.a}`, `n:${ID.a}:${next.approvalId}`, `n:${ID.b}`], 'after its first, in the place of its session');
  assert.equal(drawn.slots.n.text, '3 件', 'T3: the count is the list');
  assert.equal(queuedN(list), 1, 'what the one-a-session count of the tower leaves out');
  assert.equal(kids[1].data.node, `n:${ID.a}`, 'it opens the same worker');
  assert.equal(kids[1].slots.clock.text, '剩 2:00 自动拒', 'its own deadline');
  assert.deepEqual(kids[1].slots.acts.kids.map((d: any) => d.data.appr), [next.approvalId, next.approvalId], 'its buttons answer this request, not the first');
  assert.equal(withQueued(pins, { owned: [{ ownedId: ID.a, waiting: first.approvalId }], approvals: [first] }, g), pins, 'one each: nothing changes');
  assert.equal(withQueued(pins, null, g), pins, 'locked, the list cannot be read');
  assert.equal(queuedN(null), 0);
});

test('owned descriptors: no allow for a cut request or a native wait, words for refusals, the feed merge', () => {
  const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
  const a = approval(AP.a, ID.a, { rev: 1 }) as Approval;
  const acts = (x: Approval, where: 'pin' | 'card') => apprActs(x, g, where).map((d) => d.data!.act);
  assert.deepEqual(acts(a, 'pin'), ['deny', 'allow']);
  assert.deepEqual(acts({ ...a, preview: LONG }, 'pin'), ['deny', 'see']);
  assert.deepEqual(acts({ ...a, preview: LONG }, 'card'), ['deny', 'allow'], 'the card shows the request in full');
  assert.deepEqual(acts({ ...a, tooLong: true }, 'card'), ['deny'], 'cut short: only the refusal');
  assert.deepEqual(acts({ ...a, canAccept: false }, 'pin'), ['deny', 'see']);
  assert.deepEqual(apprActs(a, { ...g, unlocked: false }, 'pin').map((d) => d.text), [TOWER_TEXT['op.lock']]);
  const settling = apprActs(a, { ...g, settle: 'b' }, 'pin')[1]!;
  assert.deepEqual([settling.attr!['aria-disabled'], settling.data!.settle], ['true', 'b']);
  for (const source of ['native', 'inferred']) assert.deepEqual(pinExtra({ node: `n:${ID.a}`, source }, null, g), { acts: { kids: [] }, pv: { text: '' } });
  // Every text a notification can carry: no allow (r4 §10.9).
  for (const [k, v] of Object.entries(TOWER_TEXT)) if (k.startsWith('notify.') || k.startsWith('home.title')) assert.ok(!v.includes(ALLOW), k);
  for (const kind of ['command', 'file-change', 'permissions', 'question', 'elicitation', 'unknown-kind']) assert.ok(!notifyText({ ...a, kind }, 'x').includes(ALLOW), kind);
  assert.equal(msgError(''), TOWER_TEXT['msg.empty']);
  assert.equal(msgError(' /config'), TOWER_TEXT['msg.slash']);
  assert.equal(msgError('字'.repeat(683)), '太长：最多 2048 字节，现在 2049');
  assert.equal(msgError('ok'), null);
  // A live event is replaced by the next of its kind and ref; the chat folds a result into its command.
  const ev = (seq: number, kind: string, ref: string | null, state: string | null, live: boolean, text: string | null = 'x') => ({ seq, kind, ref, text, state, live, exitCode: null });
  let f = mergeFeed(undefined, { to: 2, clipped: false, events: [ev(1, 'text', 'm', 'partial', true, 'he'), ev(2, 'tool-result', 'i', 'running', true)] });
  f = mergeFeed(f, { to: 4, clipped: true, events: [ev(3, 'text', 'm', 'final', false, 'hello'), ev(4, 'tool-result', 'i', 'ran', false)] });
  assert.deepEqual(f.events.map((e) => e.seq), [3, 4]);
  assert.equal(f.clipped, true);
  const c = describeChat(f);
  assert.equal(c.kids.length, 2);
  assert.ok(c.note.includes(TOWER_TEXT['chat.clipped']!), 'T1: what the daemon no longer holds is said');
  // A question's answer says what was answered; an answer without its words (an older feed) says only that you answered.
  const said = describeChat({ to: 2, clipped: false, events: [ev(1, 'answer', 'q', 'answered', false, 'Issue: 先建前两个\nBot: 先问我再迁移'), ev(2, 'answer', 'r', 'answered', false, null)] });
  assert.deepEqual(said.kids.map((k: any) => k.slots.tx.text), ['你回答了：\nIssue: 先建前两个\nBot: 先问我再迁移', TOWER_TEXT['chat.answered']]);
  // A question waits to be answered, not allowed: its line says so.
  const asks = describeChat({ to: 2, clipped: false, events: [ev(1, 'ask', 'q', 'question', false, 'Issue / Bot'), ev(2, 'ask', 'c', 'command', false, 'npm test')] });
  assert.deepEqual(asks.kids.map((k: any) => k.slots.tx.text), ['等你回答：Issue / Bot', '等你审批：npm test']);
});

test("owned descriptors (r4 §8.5 review fix): a tainted session's card has the red bar and its source; its high risk is typed only, no hold", () => {
  const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
  const plainHigh = approval(AP.a, ID.a, { rev: 1, risk: 'shell', high: true }) as Approval;
  const taintedHigh = { ...plainHigh, tainted: true } as Approval;
  const taintedLow = approval(AP.a, ID.a, { rev: 1, tainted: true }) as Approval;
  assert.deepEqual([allowHow(approval(AP.a, ID.a, { rev: 1 })), allowHow(plainHigh), allowHow(taintedHigh), allowHow(taintedLow)], ['0', '1', '2', '0']);
  const allowOf = (x: Approval) => apprActs(x, g, 'card').find((d) => d.data!.act === 'allow')!;
  assert.deepEqual([allowOf(plainHigh).data!.high, allowOf(plainHigh).text], ['1', TOWER_TEXT['appr.hold']]);
  // data-high 2: the page's hold handlers take only data-high 1 (drive.js holdBtn), so no hold starts on it.
  assert.deepEqual([allowOf(taintedHigh).data!.high, allowOf(taintedHigh).text], ['2', TOWER_TEXT['appr.typeOnly']]);
  assert.equal(allowOf(taintedHigh).attr!['aria-label'], TOWER_TEXT['appr.typeOnlyLabel']!.replace('{t}', 'req'));
  assert.equal(allowOf(taintedLow).data!.high, '0', 'r4 §8.5 names shell, the network, writes outside cwd: a low-risk card keeps its click');
  const card = describeCard(taintedHigh, g) as any;
  assert.deepEqual(card.data, { high: '1', tainted: '1' });
  assert.ok(card.slots.kind.text.startsWith(TOWER_TEXT['appr.tainted']!), card.slots.kind.text);
  // These cards carry no origin: the note says the card has no source chain (source chain review fix), not where it stops.
  assert.ok(card.slots.note.text.includes(TOWER_TEXT['appr.taintedHighBare']!), card.slots.note.text);
  assert.ok(describeCard(taintedLow, g).slots.note.text.includes(TOWER_TEXT['appr.taintedNoteBare']!));
  const plain = describeCard(plainHigh, g) as any;
  assert.equal(plain.data.tainted, '0');
  assert.ok(!plain.slots.kind.text.includes(TOWER_TEXT['appr.tainted']!));
  // The waiting bar's pin too (found on the page 2026-11-03: it was yellow with no source line): red bar, source in the hint.
  const listWith = (x: Approval) => ({ owned: [{ ownedId: ID.a, waiting: x.approvalId }], approvals: [x] }) as any;
  const pin = pinExtra({ node: `n:${ID.a}`, source: 'orchestra' }, listWith(taintedHigh), g) as any;
  assert.deepEqual([pin.data, pin.hint.text, pin.acts.kids.find((d: any) => d.data.act === 'allow').data.high], [{ tainted: '1' }, TOWER_TEXT['appr.tainted'], '2']);
  const plainPin = pinExtra({ node: `n:${ID.a}`, source: 'orchestra' }, listWith(plainHigh), g) as any;
  assert.deepEqual([plainPin.data, plainPin.hint], [undefined, undefined], 'an untainted pin keeps the plain wait colour');
});

test("the dispatch entry is called 派活 everywhere: its button, its locked form, the dialog's title", () => {
  // The first real run (2026-11-03): with --owned on and nothing dispatched yet the old page said the desk was
  // off ("不带 --owned 启动时..."), and the top bar's entry was called 新会话: the person saw no way to dispatch.
  assert.equal(TOWER_TEXT['bar.new'], '派活');
  assert.ok(TOWER_TEXT['bar.newLocked']!.startsWith('派活'));
  assert.ok(TOWER_TEXT['new.title']!.startsWith('派活'));
  // Off, the why says so in words, --owned included.
  assert.ok(whyText('not-asked').includes('--owned'), whyText('not-asked'));
});

test('owned descriptors (review fixes): words for notes and fates, unknown outcomes, why off, busy keeps the focus, unique ids', () => {
  const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
  const ev = (seq: number, kind: string, ref: string | null, state: string | null, text: string | null = null, uuid: string | null = null) => ({ seq, kind, ref, uuid, text, state, live: false, exitCode: null });
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const chat = describeChat({ clipped: false, events: [
    ev(1, 'you', null, null, 'first', U1), ev(2, 'you', null, null, 'second', U2),
    ev(3, 'note', U1, 'msg-sent'), ev(4, 'note', U2, 'msg-not-sent', 'no active turn'),
    ev(5, 'note', null, 'not-sent', 'gateway down'), ev(6, 'note', null, 'mystery-code', 'raw words'),
    ev(7, 'auto-denied', null, 'protected', 'edit (protected)'), ev(8, 'auto-denied', 'a', 'mismatch'), ev(9, 'note', null, 'children-may-remain'),
  ] });
  const lines = chat.kids.map((k: any) => `${k.slots.who.text}|${k.slots.tx.text}`);
  assert.deepEqual(lines, [
    `你 · ${TOWER_TEXT['msgst.msg-sent']}|first`,
    `你 · 没发出去：no active turn|second`,
    '|这条消息没有发给它：gateway down',
    '|提示 mystery-code：raw words',
    '|碰到受保护的位置，Orchestra 直接拒绝了：edit (protected)',
    `|${TOWER_TEXT['chat.mismatch']}`,
    `|${TOWER_TEXT['fnote.children-may-remain']}`,
  ], 'each message says its fate; no note is a bare code; the fallback keeps the words');
  // A 5xx may come after the effect: the outcome is unknown, never "not done" (T1); a 501 is a refusal.
  assert.equal(errText('http-500'), TOWER_TEXT['op.unknown']);
  assert.equal(errText('network'), TOWER_TEXT['op.unknown']);
  assert.equal(errText('timeout'), TOWER_TEXT['op.unknown']);
  assert.equal(errText('http-501'), '没办成：http-501');
  // Why a session cannot start, in words; an unknown code says so.
  const off = { kind: 'owned-list', rev: 0, enabled: false, disabledWhy: 'not-asked', harnesses: { codex: false, claude: false }, owned: [], approvals: [] };
  assert.ok(describeNew(off, 'codex', false).why.text.includes(TOWER_TEXT['why.not-asked']!));
  assert.ok(describeNew({ ...off, disabledWhy: 'brand-new' }, 'codex', false).why.text.includes('原因未知：brand-new'));
  // Busy buttons are aria-disabled (a disabled one drops the focus); a queue ahead is said; an unknown session takes nothing.
  const o = { ownedId: 'a'.repeat(20), model: 'codex/gpt-6.1-sol', title: 't', state: 'running', endReason: null, waiting: null, queued: 1, tokens: null };
  const list = { ...off, enabled: true, disabledWhy: null, owned: [o] };
  const dock = describeOwnedDock({ id: o.ownedId }, list, { ...g, busy: true }, false, false) as any;
  assert.deepEqual(dock.btns.kids.map((b: any) => [b.data.act, b.attr.disabled, b.attr['aria-disabled']]), [['send', undefined, 'true'], ['interrupt', undefined, 'true'], ['end', undefined, 'true']]);
  assert.ok(dock.st.text.startsWith(TOWER_TEXT['dock.afterQueue']!));
  // The stop: with the root idle and nothing waiting it has nothing to reach, unless a sub-agent is live.
  const stopBtn = (x: Record<string, unknown>) => (describeOwnedDock({ id: o.ownedId }, { ...list, owned: [{ ...o, state: 'idle', queued: 0, ...x }] }, g, false, false) as any).btns.kids.find((b: any) => b.data.act === 'interrupt').attr['aria-disabled'];
  assert.equal(stopBtn({ stoppable: false }), 'true');
  assert.notEqual(stopBtn({ stoppable: true }), 'true');
  const deny = apprActs(approval(AP.a, ID.a, { rev: 1 }) as Approval, { ...g, busy: true }, 'card')[0]!;
  assert.deepEqual([deny.attr!.disabled, deny.attr!['aria-disabled']], [undefined, 'true']);
  // No brake without a Job of its own: the note says why, in words (procguard's state, from the list).
  assert.ok(dock.note.text.includes(TOWER_TEXT['dock.noBrake']!.replace('{why}。结束会话只停 codex 或 host 本身', '')), dock.note.text);
  assert.ok(dock.note.text.includes(TOWER_TEXT['bwhy.no-job']!));
  const noPg = describeOwnedDock({ id: o.ownedId }, { ...list, brakeWhy: 'procguard-build-failed' }, g, false, false) as any;
  assert.ok(noPg.note.text.includes(TOWER_TEXT['bwhy.procguard-build-failed']!), noPg.note.text);
  const braking = describeOwnedDock({ id: o.ownedId }, { ...list, brakeWhy: null, owned: [{ ...o, brake: true }] }, g, false, false, true) as any;
  assert.deepEqual(braking.btns.kids.map((b: any) => [b.data.act, b.data.armed ?? null, b.text]), [
    ['send', null, TOWER_TEXT['dock.send']], ['interrupt', null, TOWER_TEXT['dock.interrupt']], ['end', '0', TOWER_TEXT['dock.end']], ['brake', '1', TOWER_TEXT['dock.brakeSure']],
  ]);
  assert.ok(!braking.note.text.includes(TOWER_TEXT['dock.noBrake']!.slice(0, 5)), 'with a brake, no note says there is none');
  // A resident procguard that went away: the brake is still there, and the note says it cannot report what it did.
  const blind = describeOwnedDock({ id: o.ownedId }, { ...list, brakeWhy: 'procguard-resident-gone', owned: [{ ...o, brake: true }] }, g, false, false) as any;
  assert.ok(blind.btns.kids.some((b: any) => b.data.act === 'brake'));
  assert.ok(blind.note.text.includes(TOWER_TEXT['dock.brakeUnsure']!.replace('{why}', TOWER_TEXT['bwhy.procguard-resident-gone']!)), blind.note.text);
  // An ended session still stopping (its child not closed): nothing to send, but the brake alone stays.
  const stopping = describeOwnedDock({ id: o.ownedId }, { ...list, brakeWhy: null, owned: [{ ...o, state: 'ended', endReason: 'you-ended', queued: 0, brake: true }] }, g, false, false, true) as any;
  assert.deepEqual(stopping.btns.kids.map((b: any) => [b.data.act, b.data.armed ?? null]), [['brake', '1']]);
  assert.equal(stopping.note.text, TOWER_TEXT['dock.stopping']);
  const closed = describeOwnedDock({ id: o.ownedId }, { ...list, owned: [{ ...o, state: 'ended', endReason: 'you-ended', queued: 0, brake: false }] }, g, false, false) as any;
  assert.equal(closed.note.text, TOWER_TEXT['dock.ended']);
  assert.ok(!closed.btns.kids.some((b: any) => b.data?.act === 'brake'));
  const gone = describeOwnedDock({ id: o.ownedId }, { ...list, owned: [{ ...o, state: 'unknown', endReason: 'daemon-restart' }] }, g, false, false) as any;
  assert.equal(gone.note.text, TOWER_TEXT['dock.unknown']);
  assert.ok((describeOwned(o.ownedId, { ...list, owned: [{ ...o, state: 'unknown', endReason: 'daemon-restart' }] }, undefined, g) as any).ownSt.text.includes(TOWER_TEXT['life.daemon-restart']!));
  // A Codex session's usage line says it is the root thread's alone; a Claude session's has no such thing to say.
  const usage = (harness: string) => (describeOwned(o.ownedId, { ...list, owned: [{ ...o, harness, tokens: { input: 1, cachedInput: 0, output: 1, total: 2 } }] }, undefined, g) as any).ownSt.text as string;
  assert.ok(usage('codex').includes(TOWER_TEXT['own.tokensRoot']!.replace('{n}', '2')), usage('codex'));
  assert.ok(usage('claude').includes(TOWER_TEXT['own.tokens']!.replace('{n}', '2')), usage('claude'));
  // Every id in the page is one element's: a label names the control it is for.
  const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], 'no id twice');
  for (const m of HTML.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) assert.match(HTML, new RegExp(`<(?:select|input|textarea)[^>]*\\bid="${m[1]}"`), `label for ${m[1]} names a control`);
});

test('the chat (live run fixes): a command told again moves below its approval; a message keeps one node; the reader hears only new words; it follows the bottom', () => {
  const ev = (seq: number, kind: string, ref: string | null, state: string | null, text: string | null = 'x', live = false) => ({ seq, kind, ref, uuid: null, text, state, live, exitCode: null });
  // A page that read the command before the daemon moved it below the approval (src/owned/codex-session.ts).
  const chat = describeChat({ clipped: false, events: [
    ev(1, 'tool', 'i1', 'command', 'Set-Content hello.txt'), ev(2, 'ask', AP.a, 'command', 'Set-Content hello.txt'),
    ev(3, 'answer', AP.a, 'decline', null), ev(4, 'tool', 'i1', 'command', 'Set-Content hello.txt'), ev(5, 'tool-result', 'i1', 'declined', null),
  ] });
  assert.deepEqual(chat.kids.map((k: any) => k.tpl === 'tpl-tool' ? `tool:${k.slots.sum.text}` : `${k.data.kind}`), ['ask', 'answer', `tool:${TOWER_TEXT['tool.command']} · Set-Content hello.txt · ${TOWER_TEXT['res.declined']}`]);
  assert.equal(new Set(chat.kids.map((k) => k.key)).size, chat.kids.length, 'one row per key');
  // A streaming message and its final words share a node: the reader is not handed every delta as a new line.
  const partial = describeChat({ clipped: false, events: [ev(7, 'text', 'm1', 'partial', 'Writ', true)] }).kids[0]!.key;
  const final = describeChat({ clipped: false, events: [ev(9, 'text', 'm1', 'final', 'Wrote hello.txt'), ev(10, 'text', 'm1', 'final', 'part two')] }).kids.map((k) => k.key);
  assert.equal(final[0], partial);
  // A long reply's chunks (one ref, final, adjacent) are one message under the first chunk's key; another ref is another message.
  const chunks = describeChat({ clipped: false, events: [ev(9, 'text', 'm1', 'final', 'first half, '), ev(10, 'text', 'm1', 'final', 'second half'), ev(11, 'text', 'm3', 'final', 'next')] });
  assert.deepEqual(chunks.kids.map((k: any) => k.slots.tx.text), ['first half, second half', 'next']);
  assert.equal(chunks.kids[0]!.key, partial);
  assert.equal(chatNews({ clipped: false, events: [ev(9, 'text', 'm1', 'final', 'first half, '), ev(10, 'text', 'm1', 'final', 'second half')] }, 0).split(TOWER_TEXT['sep.notes']!).length, 1, 'heard as one');
  // An automatic refusal this page has no words for says its code, never "timed out" (T1).
  // The line a restart leaves: not known unless the list knows the session ended (T1 both ways).
  const restart = [ev(11, 'lifecycle', null, 'daemon-restart', null)];
  assert.equal(describeChat({ clipped: false, events: restart }).kids[0]!.slots.tx.text, TOWER_TEXT['life.daemon-restart']);
  assert.equal(describeChat({ clipped: false, events: restart }, true).kids[0]!.slots.tx.text, TOWER_TEXT['life.daemon-restart-over']);
  const odd = describeChat({ clipped: false, events: [ev(12, 'auto-denied', 'toolu_9', 'host', 'Write'), ev(13, 'auto-denied', 'toolu_8', 'ending', 'Write')] }).kids.map((k: any) => k.slots.tx.text);
  assert.ok(!odd[0].includes(TOWER_TEXT['chat.clock']!) && odd[0].includes('host'), odd[0]);
  assert.equal(odd[1], TOWER_TEXT['chat.ending']!.replace('{t}', 'Write'));
  // Only what is new, not your own words, not a live one; at most the last three.
  const feed = { clipped: false, events: [ev(1, 'text', 'm0', 'final', 'old words'), ev(2, 'you', null, null, 'mine'), ev(3, 'text', 'm1', 'final', 'Wrote hello.txt'), ev(4, 'text', 'm2', 'partial', 'stre', true)] };
  const heard = chatNews(feed, 1);
  assert.ok(heard.includes('Wrote hello.txt') && !heard.includes('old words') && !heard.includes('mine') && !heard.includes('stre'), heard);
  assert.equal(chatNews(feed, 4), '');
  // Follows the bottom; scrolled up by the reader, it stays.
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 590, clientHeight: 400 }), true, 'within 24 px');
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 400 }), false);
  // The page: a polite live region of its own next to the chat; the chat scrolls and takes the keyboard.
  assert.match(HTML, /<ol class="chat" data-slot="chat" tabindex="0" aria-labelledby="chat-h"><\/ol><p class="sr" aria-live="polite" data-slot="chatSay"><\/p>/);
  assert.ok(HTML.includes('<p class="dlg-p" data-slot="note"></p>'));
  // The model list and the note follow the harness: Claude takes only zcode/ and opencode-go/, its default first.
  const both = { v: 1, kind: 'owned-list', rev: 0, enabled: true, disabledWhy: null, harnesses: { codex: true, claude: true }, owned: [], approvals: [], limits: { maxOwned: 6, active: 0 } };
  const cl = describeNew(both, 'claude', false);
  assert.deepEqual(cl.model.kids.map((k) => k.attr.value), ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash', 'zcode/GLM-5.2', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3', 'opencode-go/claude-haiku-5-5']);
  assert.ok(cl.model.kids.every((k) => !k.attr.value.startsWith('codex/')));
  assert.equal(cl.note.text, TOWER_TEXT['new.claudeNote']);
  assert.equal(cl.why.text, '');
  assert.equal(describeNew(both, 'codex', false).model.kids[0]!.attr.value, 'codex/gpt-6.1-sol');
  assert.notEqual(cl.model.kids[0]!.key, describeNew(both, 'codex', false).model.kids[3]!.key, 'keyed by harness: a switch replaces the options');
});

test('seat: request cards say who asked as its own word, why there is no suggestion, and a session page names the request it came from, never as done (T2)', () => {
  const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
  const r = {
    requestId: '5'.repeat(20), harness: 'claude', label: null, text: 'x', cwd: 'D:\w', requester: 'dsh:s1', state: 'pending', createdAt: 0, expiresAt: -1, ownedId: null, why: null,
    fetched: false, suggestion: null, suggesting: 'no-desk',
  };
  const list = { requests: [r] };
  const [card] = describeRequestPins(list, g) as any[];
  assert.equal(card.slots.clock.text, TOWER_TEXT['req.overdue'], 'past its time it says the refusal is coming, never a negative count');
  // Why the default: never one word for asking, no desk, none given and failed (T1).
  for (const [st, words] of [['no-desk', '默认；没有路由台'], ['asking', '默认；路由建议还在问'], ['none', '默认；路由台没给建议'], ['failed', '默认；路由建议没拿到（原因未知）']] as const) {
    const [c] = describeRequestPins({ requests: [{ ...r, suggesting: st }] }, g) as any[];
    assert.ok(c.slots.meta.text.includes(`模型 zcode/GLM-5.3（${words}）`), `${st}: ${c.slots.meta.text}`);
  }
  // A requester that named none is 未知 on the card, never an English placeholder.
  const [anon] = describeRequestPins({ requests: [{ ...r, requester: 'dsh' }] }, g) as any[];
  assert.ok(anon.slots.meta.text.startsWith('自称来自 DSH 会话 未知（未核实）'), anon.slots.meta.text);
  // Locked (the app shows these from the tower's router.asks, before the list can be read): the pairing only.
  const locked = describeAskPins([{ harness: 'codex', deadline: 90_000 }], { ...g, unlocked: false, nowWall: 30_000 }) as any[];
  assert.deepEqual(locked.map((c) => [c.slots.clock.text, c.slots.what.text, c.slots.acts.kids.map((b: any) => b.text)]), [['剩 1:00 自动拒', TOWER_TEXT['req.lockedWhat'], [TOWER_TEXT['op.lock']]]]);
  // A suggestion that arrives changes the model 派出 would send (drive.js puts it in the settle signature).
  const sug = { ...r, suggesting: 'ready', suggestion: { routeId: 'f'.repeat(20), router: 'answered', models: [{ model: 'zcode/GLM-5.2', source: 'model', rule: null, reason: null }], pick: 0 } };
  assert.notEqual(requestModel(sug).model, requestModel(r).model);
  // withRequests: deadlines first, soonest first, the bar's entries by the bar's deadlines; T3 count.
  const pins = { data: { hide: '0' }, slots: { n: { text: '' }, note: { text: '' }, list: { kids: [{ key: 'n:a' }, { key: 'n:b' }, { key: 'n:c' }] } } };
  const merged = withRequests(pins, [{ key: 'req:x', data: { due: '150' } }, { key: 'req:y', data: { due: '50' } }], [{ node: 'n:a', deadline: 100 }, { node: 'n:b', deadline: null }, { node: 'n:c', deadline: 200 }]) as any;
  assert.deepEqual(merged.slots.list.kids.map((k: any) => k.key), ['req:y', 'n:a', 'req:x', 'n:c', 'n:b']);
  assert.equal(merged.slots.n.text, '5 件');
  const own = {
    requests: [{ ...r, state: 'done', ownedId: 'a'.repeat(20) }, { ...r, requestId: '6'.repeat(20), state: 'failed', ownedId: 'b'.repeat(20), why: 'turn-failed' }, { ...r, requestId: '7'.repeat(20), state: 'done', fetched: true, ownedId: 'd'.repeat(20) }],
    requestedGone: ['e'.repeat(20)],
  };
  assert.equal(requestOf(own, 'a'.repeat(20)), `你应 DSH 请求派出的会话（请求方自称 s1，未核实）· 请求现在${TOWER_TEXT['reqst.done']}`);
  assert.ok(TOWER_TEXT['reqst.done'].includes('未知'), 'done says nobody knows whether the requester took it (T1)');
  assert.equal(requestOf(own, 'd'.repeat(20)), `你应 DSH 请求派出的会话（请求方自称 s1，未核实）· 请求现在${TOWER_TEXT['reqst.fetched']}`);
  assert.equal(requestOf(own, 'b'.repeat(20)), `你应 DSH 请求派出的会话（请求方自称 s1，未核实）· 请求现在没有返回结果（${TOWER_TEXT['life.turn-failed']}）`);
  assert.ok(requestOf({ ...own, requests: [{ ...r, state: 'failed', ownedId: 'b'.repeat(20), why: 'session-braked' }] }, 'b'.repeat(20)).includes(TOWER_TEXT['life.braked']), 'the end of the session in the words of the talk');
  assert.ok(requestOf({ ...own, requests: [{ ...r, state: 'failed', ownedId: 'b'.repeat(20), why: 'session-new-reason' }] }, 'b'.repeat(20)).endsWith('（new-reason）'), 'one it has no words for stays a code (T1)');
  assert.equal(requestOf(own, 'e'.repeat(20)), TOWER_TEXT['req.ofGone'], 'a request evicted or from before a restart is still named');
  assert.equal(requestOf(own, 'c'.repeat(20)), '', 'a session you started yourself names none');
  for (const [k, v] of Object.entries(TOWER_TEXT)) if (k.startsWith('req') ) assert.ok(!v.includes('完成'), k);
});
