import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckStep, Shape } from '../../src/server/routes.ts';
import { ERROR_CODES, ERROR_STATUS, HUMAN_VERBS, HUMAN_VERB_ROUTES, ITEM_VERBS, TITLE_KEYS } from '../../shared/protocol.js';
import { PLAN_TTL_MS, REMINDER_TEXT_MAX, TICK_MS } from '../../shared/constants.js';
import { CHECKS, D17_SERVES_UI_ONLY, ERROR_TABLE, FRAMES, ROUTES, SHAPES, checkOrder, routeOf, shapeError, textLeaves } from '../../src/server/routes.ts';

// Plan step 3: the route table and the JSON shapes (UI design 一), the fixed check order of plan line
// 588 as data, and the full error table. Frames carry no source free text: their only text leaf is
// your reminder's; a title is {key, args} through shared/protocol.js's grammars.

const BOOT = '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const TAB = '1c9c3d7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const ACT = '2d9c3d7e-1f2a-4b3c-ad4e-5f6a7b8c9d0e';
const why = (s: Shape, v: unknown) => {
  const e = shapeError(s, v);
  return e === null ? 'ok' : `${e.why} ${e.at}`;
};

const item = (patch: Record<string, unknown> = {}) => ({
  id: 'it-1', rev: 12, kind: 'approval', group: 'fermatas', sev: 'P1', state: 'open', conf: 'high', project: { id: 'prj1', name: 'shop-web', hue: 3 },
  harness: 'claude', own: 'observed', part: { ref: 'p1', short: 'p1' }, committedWall: 1_761_868_800_000, committedJseq: 10, notify: 'pending',
  title: { key: 'item.approval', args: { project: 'shop-web' } }, verbs: ['open', 'peek', 'seen', 'snooze', 'remind', 'acted'], open: { kind: 'native' }, ...patch,
});
const status = () => ({
  sources: [{ source: 'claude', state: 'ok', sinceWall: null, version: '2.1.17' }], brake: 'unavailable', notifyRoute: 'browser', toastWorker: 'off',
  liveStreams: 1, tuningRev: 0, snippetRev: 0, dshOrigin: null,
});
const snapshot = (patch: Record<string, unknown> = {}) => ({
  v: 1, bootId: BOOT, jseq: 12, srev: 3, serverWall: 1_761_868_801_000, tickMs: TICK_MS, profile: 'test', mode: 'working', modeReasons: [], status: status(),
  items: [item()], clipped: 0, later: { snoozed: 0, nextWall: null }, reminders: { pending: 1, nextWall: 1_761_870_000_000 },
  ended: [{ id: 'it-0', kind: 'question', project: null, end: 'acted', cause: 'human', endedWall: 1_761_868_700_000, endedJseq: 9, actionId: ACT }],
  recentActions: [{ actionId: ACT, verb: 'acted', itemId: 'it-0', outcome: 'applied', jseq: 9, bootId: BOOT }], ...patch,
});

test('the five frames take their payloads; the delta keeps its shape', () => {
  assert.equal(why(FRAMES.snapshot, snapshot()), 'ok');
  assert.equal(why(FRAMES.status, { bootId: BOOT, srev: 4, status: status() }), 'ok');
  assert.equal(why(FRAMES.tick, { bootId: BOOT, jseq: 12, srev: 4, serverWall: 5 }), 'ok');
  assert.equal(why(FRAMES.notify, { itemId: 'it-1', attempt: 1, sev: 'P1', title: { key: 'item.approval', args: { project: 'shop-web' } }, project: null }), 'ok');
  for (const reason of ['shutdown', 'superseded', 'replaced', 'backpressure']) assert.equal(why(FRAMES.bye, { reason }), 'ok');
  assert.equal(why(FRAMES.bye, { reason: 'bored' }), 'enum $.reason');
  assert.equal(why(FRAMES.delta, { jseq: 13, prev: 12, upserted: [item()], removed: ['it-0'] }), 'ok');
  assert.equal(why(FRAMES.snapshot, snapshot({ tickMs: 1000 })), 'const $.tickMs');
  assert.equal(why(FRAMES.snapshot, snapshot({ v: 2 })), 'const $.v');
  assert.equal(why(FRAMES.snapshot, snapshot({ truncated: 0 })), 'extra-key $', 'the count is clipped, never another name');
  assert.equal(why(FRAMES.snapshot, snapshot({ modeReasons: ['integrity-low'], mode: 'ui-only' })), 'ok');
  assert.equal(why(FRAMES.snapshot, snapshot({ items: [item({ state: 'snoozed' })] })), 'enum $.items[0].state', 'a snapshot lists open and seen items only');
  assert.equal(why(FRAMES.snapshot, snapshot({ items: [item({ state: 'acted', verbs: [] })] })), 'enum $.items[0].state');
});

test('frames carry no source free text: the only text leaf in any frame is your reminder\'s, on a reminder item, with its textState', () => {
  for (const [name, f] of Object.entries(FRAMES)) {
    assert.ok(textLeaves(f).every((w) => w === 'reminder'), `${name}: ${textLeaves(f).join(',')}`);
  }
  assert.deepEqual(textLeaves(SHAPES.ItemView), ['reminder']);
  const rem = item({ kind: 'reminder', group: 'reminders', title: { key: 'item.reminder', args: {} }, reminder: { text: 'call Bob back', textState: 'present' } });
  assert.equal(why(SHAPES.ItemView, rem), 'ok');
  assert.equal(why(SHAPES.ItemView, { ...rem, reminder: { text: 'x'.repeat(REMINDER_TEXT_MAX + 1), textState: 'present' } }), 'too-long $.reminder.text');
  assert.equal(why(SHAPES.ItemView, { ...rem, reminder: { text: '😀'.repeat(REMINDER_TEXT_MAX), textState: 'present' } }), 'ok', 'code points, not UTF-16 units');
  assert.equal(why(SHAPES.ItemView, { ...rem, reminder: { text: null, textState: 'purged' } }), 'type $.reminder.text', 'a purged reminder text is the empty string with its state');
  for (const s of ['present', 'expired', 'purged', 'lost']) assert.equal(why(SHAPES.ItemView, { ...rem, reminder: { text: '', textState: s } }), 'ok', s);
  assert.equal(why(SHAPES.ItemView, { ...rem, reminder: { text: '', textState: 'deleted' } }), 'enum $.reminder.textState');
  assert.equal(why(SHAPES.ItemView, item({ peek: 'Bash: rm -rf' })), 'extra-key $', 'no other field for source text');
});

test('a title is {key, args}: every key of TITLE_KEYS, args through their grammars; a crafted cwd tail, tool or version never reaches a frame', () => {
  const t = (title: unknown) => why(FRAMES.notify, { itemId: 'it-1', attempt: 2, sev: 'P1', title, project: null });
  for (const key of TITLE_KEYS) assert.equal(t({ key, args: { project: 'shop-web' } }), 'ok', key);
  assert.equal(t({ key: 'item.approval', args: { project: 'canary-7Q‮' } }), 'title:project $.title');
  // Finding C10: a name you set in Tuning skips the cwd-tail check (up to 64 code points, separators
  // allowed, never a control, format or separator character); a cwd tail is cut to 32 by cwdTailArg
  // before it is ever a title arg (titles.test), so the frame holds every name to PROJECT_NAME_RE.
  assert.equal(t({ key: 'item.approval', args: { project: 'a'.repeat(33) } }), 'ok', 'a renamed project of 33 code points');
  assert.equal(t({ key: 'item.approval', args: { project: 'my renamed / project' } }), 'ok', 'a renamed project with a separator');
  assert.equal(t({ key: 'item.approval', args: { project: 'a'.repeat(65) } }), 'title:project $.title');
  assert.equal(t({ key: 'item.approval', args: { project: 'renamed​name' } }), 'title:project $.title', 'no zero-width character, renamed or not');
  assert.equal(why(SHAPES.EndView, { id: 'it-1', kind: 'question', project: { id: 'prj1', name: 'my renamed / project', hue: 3 }, end: 'acted', cause: 'human', endedWall: 1, endedJseq: 2 }), 'ok');
  assert.equal(t({ key: 'item.approval', args: { project: 'shop', tool: 'rm -rf' } }), 'title:tool $.title');
  assert.equal(t({ key: 'item.approval', args: { project: 'shop', version: '1.2.3​' } }), 'title:version $.title');
  assert.equal(t({ key: 'item.approval', args: { project: 'shop', text: 'Bash: rm -rf' } }), 'title:arg-name $.title');
  assert.equal(t({ key: '{project} 在等你', args: {} }), 'title:key $.title');
  assert.equal(t('shop-web 在等你批准'), 'title:shape $.title', 'a title is never text');
  assert.equal(t({ key: 'item.approval', args: { project: 'shop' }, text: 'x' }), 'title:shape $.title');
  assert.equal(t({ key: 'item.approval', args: Object.defineProperty({}, 'project', { get: () => 'shop', enumerable: true }) }), 'title:project $.title', 'an accessor arg is no arg');
});

test('the steps of every route, in one order; a human route runs exactly plan line 588\'s: auth, actionId, dedup, item, ended (noop), verb, own, execute; the ui-only slot is D-17\'s and not in force', () => {
  assert.deepEqual(CHECKS.map((c) => c.step), ['auth', 'ui-only', 'actionId', 'shape', 'dedup', 'item', 'ended', 'verb', 'own', 'execute']);
  assert.equal(D17_SERVES_UI_ONLY, false);
  assert.deepEqual(checkOrder(), ['auth', 'actionId', 'shape', 'dedup', 'item', 'ended', 'verb', 'own', 'execute']);
  assert.deepEqual(checkOrder(true), ['auth', 'ui-only', 'actionId', 'shape', 'dedup', 'item', 'ended', 'verb', 'own', 'execute']);
  // Plan line 588 and UI design 一 5 have no shape step: a human route folds its body check into the actionId step (finding C8).
  const inForce = (steps: readonly CheckStep[]) => steps.filter((s) => checkOrder().includes(s));
  for (const r of ROUTES.filter((x) => x.human !== null && x.item !== null)) assert.deepEqual(inForce(r.checks), ['auth', 'actionId', 'dedup', 'item', 'ended', 'verb', 'own', 'execute'], r.path);
  for (const r of ROUTES.filter((x) => x.human !== null && x.item === null)) assert.deepEqual(inForce(r.checks), ['auth', 'actionId', 'dedup', 'execute'], r.path);
  const step = (s: CheckStep) => CHECKS.find((c) => c.step === s)!;
  assert.deepEqual([step('auth').status, step('ui-only').status, step('actionId').status, step('item').status, step('verb').status], [403, 503, 400, 404, 422]);
  assert.deepEqual([...step('actionId').codes], ['actionId-missing']);
  assert.deepEqual([...step('dedup').codes], ['in-flight', 'actionId-reused']);
  assert.equal(step('ended').outcome, 'noop:already-ended');
  assert.ok(CHECKS.findIndex((c) => c.step === 'ended') < CHECKS.findIndex((c) => c.step === 'verb'), 'an ended item has no verbs: ended answers first');
  assert.deepEqual([...step('own').codes], ['text-too-long', 'brake-unavailable', 'not-test-root', 'plan-expired']);
});

test('the error table is shared/protocol.js\'s, in full: every code answered by a step or a route, ui-only reserved', () => {
  assert.deepEqual(ERROR_TABLE.map((e) => e.code), [...ERROR_CODES]);
  for (const e of ERROR_TABLE) assert.equal(e.status, ERROR_STATUS[e.code], e.code);
  assert.deepEqual(ERROR_TABLE.filter((e) => e.reserved).map((e) => e.code), ['ui-only']);
  const answered = new Set([...CHECKS.flatMap((c) => c.codes), ...ROUTES.flatMap((r) => [...r.own, ...r.failures])]);
  assert.deepEqual(ERROR_CODES.filter((c) => !answered.has(c)), []);
  for (const r of ROUTES) for (const c of r.own) assert.ok(CHECKS.find((x) => x.step === 'own')!.codes.includes(c), `${r.path}: ${c} is an own check`);
  assert.deepEqual(ROUTES.flatMap((r) => r.failures), ['procguard-timeout', 'procguard-timeout'], 'only protect fails in execution, and writes nothing');
});

test('every POST that writes a human record carries an actionId and runs actionId and dedup; the others carry none', () => {
  const humanRoutes = ROUTES.filter((r) => r.human !== null);
  assert.deepEqual(humanRoutes.map((r) => r.human), [...HUMAN_VERBS]);
  for (const r of humanRoutes) {
    assert.equal(r.method, 'POST');
    assert.equal(r.path, HUMAN_VERB_ROUTES[r.human!]);
    const body = r.body as { t: 'obj'; fields: Record<string, Shape>; optional: string[] };
    assert.ok(Object.hasOwn(body.fields, 'actionId') && !body.optional.includes('actionId'), r.path);
    assert.equal(why(body.fields.actionId!, ACT), 'ok');
    assert.ok(r.checks.includes('actionId') && r.checks.includes('dedup'), r.path);
  }
  for (const r of ROUTES.filter((x) => x.human === null)) {
    assert.ok(r.body === null || !Object.hasOwn((r.body as { fields: object }).fields, 'actionId'), r.path);
    assert.ok(!r.checks.includes('actionId') && !r.checks.includes('dedup') && !r.checks.includes('ended'), r.path);
  }
  const seen = routeOf('POST', '/api/items/:id/seen')!;
  assert.equal(why(seen.body!, {}), 'missing $.actionId');
  assert.equal(why(seen.body!, { actionId: ACT }), 'ok');
});

test('each route runs its steps in the order of CHECKS; item routes run item, ended and verb; the route table has one entry per method and path', () => {
  const rank = (s: CheckStep) => CHECKS.findIndex((c) => c.step === s);
  for (const r of ROUTES) {
    const ranks = r.checks.map(rank);
    assert.ok(ranks.every((x) => x >= 0) && ranks.every((x, i) => i === 0 || x > ranks[i - 1]!), `${r.method} ${r.path}: ${r.checks.join(',')}`);
    assert.equal(r.checks.at(-1), 'execute');
    if (r.human !== null && r.item !== null) assert.ok(['item', 'ended', 'verb'].every((s) => r.checks.includes(s as CheckStep)), r.path);
  }
  assert.equal(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size, ROUTES.length);
  assert.equal(routeOf('GET', '/api/items'), undefined, 'GET /api/items/:id/detail replaces it');
  assert.ok(routeOf('GET', '/api/items/:id/detail'));
  for (const v of ['allow', 'deny']) assert.equal(routeOf('POST', `/api/approvals/:id/${v}`)!.status, 501);
  for (const v of ITEM_VERBS.filter((x) => x !== 'open' && x !== 'peek')) assert.ok(ROUTES.some((r) => r.human === v), `item verb ${v} has its route`);
});

test('session, events and client-state: the plan\'s shapes', () => {
  const session = routeOf('GET', '/api/session')!;
  assert.equal(why(session.query!, { tab: TAB }), 'ok');
  assert.equal(why(session.reply!, { csrf: 'A'.repeat(43), bootId: BOOT, mode: 'working', profile: 'real', liveStreams: 2, superseded: false }), 'ok');
  assert.equal(why(session.reply!, { csrf: 'A'.repeat(43), bootId: BOOT, mode: 'working', profile: 'real', liveStreams: 3, superseded: false }), 'range $.liveStreams');
  const events = routeOf('GET', '/api/events')!;
  for (const w of ['open', 'reload', 'gap', 'stale', 'probe', 'backpressure']) assert.equal(why(events.query!, { tab: TAB, perm: 'granted', why: w }), 'ok', w);
  assert.equal(why(events.query!, { tab: TAB, perm: 'granted', why: 'retry' }), 'enum $.why');
  assert.equal(why(events.query!, { tab: 'not-a-uuid', perm: 'granted', why: 'open' }), 'grammar $.tab');
  assert.equal(why(events.query!, { tab: TAB, perm: 'granted', why: 'open', lastEventId: '1' }), 'extra-key $', 'Last-Event-ID is not honored');
  const cs = routeOf('POST', '/api/client-state')!.body!;
  assert.equal(why(cs, { tabId: TAB, visibility: 'hidden', frozen: true, permission: 'default' }), 'ok');
  assert.equal(why(cs, { tabId: TAB, visibility: 'hidden', frozen: false, permission: 'granted', perf: { samples: [{ metric: 'key-event-ms', value: 14 }] } }), 'ok');
  assert.equal(why(cs, { tabId: TAB, visibility: 'hidden', frozen: false, permission: 'granted', perf: { samples: [{ metric: 'key-event-ms', value: 1.5 }] } }), 'type $.perf.samples[0].value');
  assert.equal(why(cs, { tabId: TAB, visibility: 'prerender', frozen: false, permission: 'granted' }), 'enum $.visibility');
  const ack = routeOf('POST', '/api/notify-ack')!.body!;
  for (const phase of ['dispatched', 'shown', 'error']) assert.equal(why(ack, { itemId: 'it-1', attempt: 1, tabId: TAB, phase }), 'ok', phase);
  assert.equal(why(ack, { itemId: 'it-1', attempt: 0, tabId: TAB, phase: 'dispatched' }), 'range $.attempt');
});

test('the brake: a plan reply with ttlMs 60000 and expiresAt, an execute body with actionId, and the outcome by subtree', () => {
  const plan = routeOf('POST', '/api/brake/plan')!;
  assert.equal(plan.human, null, 'a plan only plans: no actionId, no human record');
  const reply = {
    planId: 'plan-1', itemId: 'it-1', harness: { pid: 100, createTime: '133000000000000000', image: 'claude.exe', multiSession: false, selectable: true }, refused: null,
    ttlMs: PLAN_TTL_MS, expiresAt: 1_761_868_860_000,
    subtrees: [{ root: { pid: 101, createTime: '133000000000000001' }, image: 'rg.exe', nodes: 3, rssBytes: 3_100_000_000, protected: [], confirm: false, selected: true, cmdline: { text: 'rg --files [redacted:sk-ant]', textState: 'present' } }],
  };
  assert.equal(why(plan.reply!, reply), 'ok');
  assert.equal(why(plan.reply!, { ...reply, ttlMs: 120_000 }), 'const $.ttlMs');
  assert.equal(why(plan.reply!, { ...reply, harness: { ...reply.harness, image: 'r‮g.exe' } }), 'grammar $.harness.image');
  assert.equal(why(plan.reply!, { ...reply, harness: { ...reply.harness, createTime: '0' } }), 'grammar $.harness.createTime');
  const exec = routeOf('POST', '/api/brake/execute')!;
  assert.equal(exec.human, 'brake');
  assert.deepEqual([...exec.own], ['brake-unavailable', 'not-test-root', 'plan-expired']);
  assert.equal(why(exec.body!, { actionId: ACT, itemId: 'it-1', planId: 'plan-1', roots: [{ pid: 101, createTime: '133000000000000001' }], confirm: [] }), 'ok');
  assert.equal(why(exec.body!, { actionId: ACT, itemId: 'it-1', planId: 'plan-1', roots: [], confirm: [] }), 'range $.roots');
  assert.equal(why(exec.reply!, { actionId: ACT, accepted: true, jseq: 40 }), 'ok');
  assert.equal(why(exec.reply!, { actionId: ACT, accepted: true, jseq: 40, replayed: true }), 'ok');
  const sub = (status: string, killed = 3, residual = 0) => ({ root: { pid: 101, createTime: '133000000000000001' }, requestId: 'req-1', killed, residual, status });
  const outcome = { actionId: ACT, verb: 'brake', itemId: 'it-1', outcome: 'applied', jseq: 41, bootId: BOOT, brake: { commandId: 'cmd-1', subtrees: [sub('ok'), sub('refused', 0)] } };
  assert.equal(why(SHAPES.ActionOutcome, outcome), 'ok');
  assert.equal(why(SHAPES.ActionOutcome, { ...outcome, outcome: 'noop:bored' }), 'enum $.outcome');
  assert.equal(why(SHAPES.ActionOutcome, { ...outcome, brake: { commandId: 'cmd-1', subtrees: [] } }), 'range $.brake.subtrees');
});

test('detail: asOfJseq, the item (with its end class once ended), peek with textState present|expired|purged|lost, and how it opens', () => {
  const detail = routeOf('GET', '/api/items/:id/detail')!;
  const d = (patch: Record<string, unknown>) => ({
    asOfJseq: 12, item: item(), peek: { events: [{ jseq: 11, evKind: 'tool', tool: 'Bash', srcSeq: 40, obsWall: 5 }], text: 'last assistant text', textState: 'present' }, open: { kind: 'none' }, ...patch,
  });
  assert.equal(why(detail.reply!, d({})), 'ok');
  for (const s of ['present', 'expired', 'purged', 'lost']) assert.equal(why(detail.reply!, d({ peek: { events: [], text: s === 'present' ? 'x' : null, textState: s } })), 'ok', s);
  assert.equal(why(detail.reply!, d({ item: item({ state: 'acted', verbs: [], ended: { end: 'acted', cause: 'human', endedWall: 9, endedJseq: 13, actionId: ACT } }) })), 'ok');
  assert.equal(why(detail.reply!, d({ item: item({ state: 'auto-cleared', verbs: [], ended: { end: 'auto-cleared', cause: 'source', endedWall: 9, endedJseq: 13 } }) })), 'ok');
  assert.equal(why(detail.reply!, d({ open: { kind: 'resume', sessionId: TAB } })), 'ok');
  assert.equal(why(detail.reply!, d({ open: { kind: 'native', pid: 4242, host: 'WindowsTerminal.exe', windowTitle: 'claude' } })), 'ok');
  assert.equal(why(detail.reply!, d({ open: { kind: 'dsh-link', url: 'http://127.0.0.1:7777/session/abc' } })), 'ok');
  assert.equal(why(detail.reply!, d({ open: { kind: 'dsh-link', url: 'http://127.0.0.1:7777/session/abc?token=s3cret' } })), 'grammar $.open.url', 'a link never carries a token');
  assert.equal(why(detail.reply!, d({ open: { kind: 'dsh-link', url: 'https://evil.example/' } })), 'grammar $.open.url');
  assert.equal(why(detail.reply!, d({ open: { kind: 'shell' } })), 'enum $.open.kind');
  assert.deepEqual([...new Set(textLeaves(detail.reply!))].sort(), ['peek', 'reminder', 'window-title'], 'replies that are not frames: redacted snippet text, each leaf named');
  assert.deepEqual(textLeaves(routeOf('POST', '/api/brake/plan')!.reply!), ['cmdline']);
});

test('the shape check reads own data fields of plain objects only: prototypes, accessors, symbols, holes, extra array keys and floats are refused', () => {
  const s = SHAPES.EndView;
  const end = { id: 'it-0', kind: 'question', project: null, end: 'expired', cause: 'clock', endedWall: 1, endedJseq: 2 };
  assert.equal(why(s, end), 'ok');
  const missing: Record<string, unknown> = { ...end };
  delete missing.cause;
  Object.defineProperty(Object.prototype, 'cause', { value: 'human', configurable: true, writable: true });
  try {
    assert.equal(why(s, missing), 'missing $.cause');
  } finally {
    delete (Object.prototype as Record<string, unknown>).cause;
  }
  assert.equal(why(s, Object.defineProperty({ ...missing }, 'cause', { get: () => 'human', enumerable: true })), 'missing $.cause');
  assert.equal(why(s, { ...end, [Symbol('x')]: 1 }), 'extra-key $');
  assert.equal(why(s, Object.assign(Object.create({}) as object, end)), 'not-plain $');
  assert.equal(why(s, { ...end, endedJseq: 2.5 }), 'type $.endedJseq');
  assert.equal(why(s, { ...end, endedJseq: Number.NaN }), 'type $.endedJseq');
  assert.equal(why(s, { ...end, actionId: undefined }), 'type $.actionId', 'an optional field present is checked');
  const verbs = ['open', 'peek'];
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(why(SHAPES.ItemView, item({ verbs: ['open', , 'peek'] })), 'missing $.verbs[1]');
  assert.equal(why(SHAPES.ItemView, item({ verbs: Object.assign([...verbs], { extra: 1 }) })), 'extra-key $.verbs');
  assert.equal(why(SHAPES.ItemView, item({ title: { key: 'item.approval', args: { project: 'x' } }, verbs: ['open', 'reopen'] })), 'enum $.verbs[1]');
  assert.equal(why(routeOf('POST', '/api/reminders')!.body!, { actionId: ACT, itemId: null, dueWall: 1, text: 'tea\ud800' }), 'type $.text', 'a lone surrogate is no text');
  assert.equal(why(routeOf('POST', '/api/client-state')!.body!, { tabId: TAB, visibility: 'hidden', frozen: 'yes', permission: 'granted' }), 'type $.frozen');
  assert.equal(why(SHAPES.ItemView, item({ verbs: 'open' })), 'type $.verbs');
  assert.equal(why(SHAPES.ItemView, item({ verbs: { 0: 'open', length: 1 } })), 'type $.verbs', 'an array-like object is no array');
  assert.equal(why(s, Object.defineProperty({ ...end }, 'actionId', { get: () => ACT, enumerable: true })), 'missing $.actionId', 'an optional field present as an accessor is no field');
  assert.equal(why(SHAPES.ItemView, item({ verbs: Object.assign([...verbs], { [Symbol('x')]: 1 }) })), 'extra-key $.verbs');
  const detail = routeOf('GET', '/api/items/:id/detail')!.reply! as { fields: Record<string, Shape> };
  assert.equal(why(detail.fields.open!, []), 'not-plain $');
  assert.equal(why(detail.fields.open!, {}), 'missing $.kind');
  assert.equal(why(detail.fields.open!, { kind: 'resume' }), 'missing $.sessionId');
});

test('the tables are frozen through: no module can widen a frame or a route at run time', () => {
  const fields = (SHAPES.ItemView as { fields: Record<string, unknown> }).fields;
  assert.throws(() => { fields.peek = { t: 'text', maxCp: 99, why: 'peek' }; }, TypeError);
  assert.throws(() => { ((FRAMES.notify as { fields: Record<string, unknown> }).fields).body = { t: 'text', maxCp: 9, why: 'peek' }; }, TypeError);
  assert.throws(() => { (ROUTES[0] as { auth: string }).auth = 'session'; }, TypeError);
  assert.throws(() => { ((CHECKS[0]!.codes) as string[]).push('ui-only'); }, TypeError);
  assert.throws(() => { (routeOf('POST', '/api/items/:id/seen')!.checks as CheckStep[]).splice(0, 1); }, TypeError);
});

test('the route table reads its specs\' own fields only: built under a poisoned Object.prototype it is the same table', async () => {
  const describe = (routes: typeof ROUTES) => JSON.stringify(routes.map((r) => [r.method, r.path, r.item, r.checks, r.own, r.status ?? null, r.body === null, r.query === null, r.reply === null]));
  const poison = { status: 418, own: ['plan-expired'], checks: ['execute'], item: 'body', body: { t: 'bool' }, query: { t: 'bool' } };
  for (const [k, v] of Object.entries(poison)) Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true });
  let fresh: typeof ROUTES;
  try {
    fresh = ((await import(`../../src/server/routes.ts?poisoned=${Date.now()}`)) as { ROUTES: typeof ROUTES }).ROUTES;
  } finally {
    for (const k of Object.keys(poison)) delete (Object.prototype as Record<string, unknown>)[k];
  }
  assert.equal(describe(fresh), describe(ROUTES));
});
