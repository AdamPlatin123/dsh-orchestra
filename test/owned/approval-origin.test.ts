import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import { VirtualClock, oneShot } from '../../src/runtime/clock.ts';
import { Approvals, taintedOrigin, type ApprovalOrigin } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
import { makeDispatcher } from '../../src/route/dispatch.ts';
import { makeDesk } from '../../src/route/desk.ts';
import { makeRequests } from '../../src/route/requests.ts';
import { canonicalDigest } from '../../src/store/canonical-json.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { validateOwnedList } from '../../shared/owned-contract.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { initMessage } from '../fixtures/fake-sdk.ts';
import { claudeRig, until } from '../helpers/claude-host.ts';
import { PIN_ORIGIN_CHARS, describeCard, originLine, pinExtra } from '../../ui/owned.js';

// r4 §8.5 (来源追踪): "任何由 agent 消息触发的回合，审批卡片顶部都显示触发它的来源链". A session a seat
// request started carries its source chain (origin: the requestId, the DSH session id the request named
// itself by, its own word and never checked, or null, and its label) from the dispatch down to every
// approval it raises; GET /api/owned lists it, the contract holds it to ids and one shown line, and the
// page writes it at the top of the card and in the waiting bar's pin. Display only: the digest, the
// allow and the deny are what they were. In-memory pipes, a virtual clock: no child, no model.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const REQ = '0123456789abcdef0123';
const ORIGIN: ApprovalOrigin = { kind: 'agent-request', requestId: REQ, requester: 'sess-1', label: '修登录页' };

function memPipe() {
  const out: ((c: Buffer) => void)[] = [];
  const pipe: ChildPipe = {
    pid: 1, write: () => {}, onStdout: (cb) => {
      out.push(cb);
    }, onStderr: () => {}, onClose: () => {}, onError: () => {}, stop: () => {},
  };
  return { pipe, send: (msg: unknown) => out.forEach((cb) => cb(Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'))) };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const add = (approvals: Approvals, over: { tainted?: boolean; origin?: ApprovalOrigin | null } = {}) => approvals.add({
  ownedId: 'a'.repeat(20), kind: 'command', title: 'npm test', preview: 'command: npm test', redactions: 0, risk: 'shell', canAccept: true, canText: false,
  answer: () => {}, ...over,
});

test('Approvals: the view carries the origin it was given, frozen, and null without one; the digest and the allow do not look at it', () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const plain = add(approvals);
  assert.equal(plain.origin, null);
  const given = { ...ORIGIN };
  const v = add(approvals, { tainted: true, origin: given });
  assert.deepEqual(v.origin, ORIGIN);
  assert.ok(Object.isFrozen(v.origin), 'frozen like the view');
  given.requester = 'someone-else';
  assert.equal(v.origin!.requester, 'sess-1', 'a copy: a later change of the input does not reach the view');
  // The digest is what it always was: approvalId, kind, title, preview (the page's allow is checked against it).
  assert.equal(v.digest, canonicalDigest({ approvalId: v.approvalId, kind: 'command', title: 'npm test', preview: 'command: npm test' }));
  // Nothing about it allows: a wrong digest is still a mismatch, a right one an allow, deny is deny.
  assert.equal(approvals.allow(v.approvalId, { digest: plain.digest, rev: approvals.rev }), 'digest-mismatch');
  const w = add(approvals, { tainted: true, origin: ORIGIN });
  assert.equal(approvals.allow(w.approvalId, { digest: w.digest, rev: approvals.rev }), 'ok');
  const x = add(approvals, { tainted: true, origin: ORIGIN });
  assert.equal(approvals.deny(x.approvalId), 'ok');
});

test('CodexOwned.create hands the origin down: the approval its session raises lists it in GET /api/owned, which the contract takes; a plain session lists null', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const pipes: ReturnType<typeof memPipe>[] = [];
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock, settleMs: 0 }), makeWorkDir: (id) => `D:\\work\\owned\\${id}`,
    launch: () => {
      const m = memPipe();
      pipes.push(m);
      return m.pipe;
    },
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  });
  const asked = owned.create({ text: 'from a seat request', uuid: U(1), tainted: true, origin: { ...ORIGIN, requester: null } });
  const mine = owned.create({ text: 'from you', uuid: U(2) });
  assert.ok(asked.ok && mine.ok);
  for (const [i, policy] of [[0, 'untrusted'], [1, 'on-request']] as const) {
    const m = pipes[i]!;
    await settle();
    m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
    await settle();
    m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: policy, approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } });
    await settle();
    m.send({ id: `srv-${i}`, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', turnId: 't1', itemId: 'cmd_1', command: 'Get-Content notes.txt', cwd: `D:\\work\\owned\\x` } });
    await settle();
  }
  const list = ownedList({ codex: owned, claude: null, codexOff: 'on' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  const byOwned = new Map(list.approvals.map((a) => [a.ownedId, a]));
  assert.deepEqual(byOwned.get(asked.ownedId)!.origin, { kind: 'agent-request', requestId: REQ, requester: null, label: '修登录页' });
  assert.equal(byOwned.get(asked.ownedId)!.tainted, true);
  assert.equal(byOwned.get(mine.ownedId)!.origin, null, 'a person\'s own sentence has no source chain');
  owned.endAll();
});

/** A list with one tainted session and its approval, as GET /api/owned answers it; `origin` replaces the approval's. */
function listWith(origin: unknown, tainted = true) {
  return {
    v: 1, kind: 'owned-list', rev: 1, enabled: true, disabledWhy: null, brakeWhy: null, harnesses: { codex: true, claude: false }, roots: [],
    owned: [{ dispatch: null, frontDesk: false, ownedId: 'a'.repeat(20), harness: 'codex', model: 'codex/gpt-6.1-sol', title: 't', state: 'running', endReason: null, waiting: 'b'.repeat(32), queued: 0, tokens: null, lastSeq: 1, createdAt: 1, brake: false, stoppable: false, cwd: null }],
    approvals: [{
      approvalId: 'b'.repeat(32), ownedId: 'a'.repeat(20), kind: 'command', title: 'npm test', preview: 'command: npm test', tooLong: false, redactions: 0,
      digest: 'c'.repeat(64), risk: 'shell', high: true, tainted, origin, rev: 1, canAccept: true, canText: false, questions: null, deadline: 5,
    }],
    limits: { maxOwned: 4, active: 1 }, requests: [], requestedGone: [], sentGone: [], presence: 'unknown', frontDesk: { on: false, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null },
  };
}

test('the contract: an origin is null or a request id, the requester\'s bare id or null, and one shown line of label; only on a tainted entry', () => {
  const ok = (o: unknown, tainted = true) => validateOwnedList(listWith(o, tainted)).errors;
  assert.deepEqual(ok(ORIGIN), []);
  assert.deepEqual(ok(null), []);
  assert.deepEqual(ok(null, false), []);
  assert.deepEqual(ok({ ...ORIGIN, requester: null, label: null }), [], 'T1: a request that named no id, and none that named no label');
  const bad = (o: unknown, why: string, tainted = true) => {
    const errors = validateOwnedList(listWith(o, tainted)).errors;
    assert.ok(errors.some((e) => e.includes(why)), `${JSON.stringify(o)}: ${errors.join('; ')}`);
  };
  bad(ORIGIN, 'not tainted', false);
  bad({ ...ORIGIN, kind: 'peer' }, 'is not one of agent-request');
  bad({ ...ORIGIN, requestId: 'x' }, 'is not a request id');
  bad({ ...ORIGIN, requester: 'sess 1' }, 'is not a requester session id');
  bad({ ...ORIGIN, requester: '-lead' }, 'is not a requester session id');
  bad({ ...ORIGIN, requester: 'sess\u202e1' }, 'is not a requester session id');
  bad({ ...ORIGIN, requester: 'a'.repeat(129) }, 'is not a requester session id');
  bad({ ...ORIGIN, label: 'ok\u0007' }, 'holds a control or bidi character');
  bad({ ...ORIGIN, label: '\u2067rtl' }, 'holds a control or bidi character');
  bad({ ...ORIGIN, label: 'two\nlines' }, 'more than one line');
  // Review fix: the line and paragraph separators break a line too, and the bidi marks the bidi class above
  // leaves out (LRM, RLM, ALM) and the other format characters are refused in a label like the rest.
  bad({ ...ORIGIN, label: 'two\u2028lines' }, 'more than one line');
  bad({ ...ORIGIN, label: 'two\u2029lines' }, 'more than one line');
  for (const ch of ['\u200e', '\u200f', '\u061c', '\u200b', '\u200d', '\ufeff']) bad({ ...ORIGIN, label: `a${ch}b` }, 'holds an invisible format character');
  bad({ ...ORIGIN, label: '字'.repeat(41) }, 'at most 120');
  bad({ kind: 'agent-request', requestId: REQ, requester: null }, 'missing label');
  bad({ ...ORIGIN, extra: 1 }, 'unknown key extra');
  const noKey = listWith(null) as any;
  delete noKey.approvals[0].origin;
  assert.ok(validateOwnedList(noKey).errors.some((e) => e.includes('missing origin')));
});

const G = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
const approval = (origin: unknown, tainted = true) => listWith(origin, tainted).approvals[0] as any;
const pinOf = (a: any) => pinExtra({ node: `n:${'a'.repeat(20)}`, source: 'orchestra' }, { owned: [{ ownedId: 'a'.repeat(20), waiting: a.approvalId }], approvals: [a] } as any, G) as any;

test('the page: the card and the pin write the source chain first, the requester as 自称 and 未核实, the label, then this session', () => {
  const line = '来源不可信：DSH 会话 sess-1（自称，未核实）→ 请求「修登录页」（标签是对方写的，未核实）→ 这个会话';
  assert.equal(originLine(approval(ORIGIN)), line);
  const card = describeCard(approval(ORIGIN), G) as any;
  assert.deepEqual(card.data, { high: '1', tainted: '1' });
  assert.ok(card.slots.kind.text.startsWith(line), card.slots.kind.text);
  assert.ok(card.slots.note.text.includes(TOWER_TEXT['appr.taintedHigh']!));
  const pin = pinOf(approval(ORIGIN));
  assert.deepEqual([pin.data, pin.hint.text], [{ tainted: '1' }, line], 'short enough: the pin shows it whole');
});

test('the page: a requester that named no id is 未知 (T1); a request with no label names its id', () => {
  const none = originLine(approval({ ...ORIGIN, requester: null }));
  assert.equal(none, '来源不可信：DSH 会话 未知（请求没报自己的 id）→ 请求「修登录页」（标签是对方写的，未核实）→ 这个会话');
  assert.ok(!none.includes('自称'), 'nothing claimed, nothing to call claimed');
  assert.equal(originLine(approval({ ...ORIGIN, label: null })), `来源不可信：DSH 会话 sess-1（自称，未核实）→ 请求 ${REQ}（没写标签）→ 这个会话`);
  assert.equal(pinOf(approval({ ...ORIGIN, requester: null })).hint.text, none);
});

test('the page: the pin cuts a long id and label with … and says so; the card keeps them whole', () => {
  const longId = `s${'x'.repeat(60)}`;
  const longLabel = '很长的标签'.repeat(8);
  const a = approval({ ...ORIGIN, requester: longId, label: longLabel });
  const card = describeCard(a, G) as any;
  assert.ok(card.slots.kind.text.includes(longId) && card.slots.kind.text.includes(longLabel), 'the card: whole');
  assert.ok(!card.slots.kind.text.includes(TOWER_TEXT['appr.originCut']!));
  const hint = pinOf(a).hint.text as string;
  assert.ok(hint.includes(`${[...longId].slice(0, PIN_ORIGIN_CHARS - 1).join('')}…`), hint);
  assert.ok(hint.includes(`「${[...longLabel].slice(0, PIN_ORIGIN_CHARS - 1).join('')}…」`), hint);
  assert.ok(hint.endsWith(TOWER_TEXT['appr.originCut']!), 'A16: the cut is said, never silently short');
  assert.ok(!hint.includes(longId) && !hint.includes(longLabel));
});

test('the page: a control or bidi character that got past the contract is written out, never drawn', () => {
  // Review fix: the bidi marks LRM, RLM and ALM, the zero-width ones and the line and paragraph separators too.
  const BS = String.fromCharCode(92);
  const more = originLine(approval({ ...ORIGIN, label: 'a\u200fb\u061cc\u200ed\u2028e\u2029f\u200bg' }));
  assert.ok(!/[\u200b-\u200f\u061c\u2028\u2029]/.test(more), JSON.stringify(more));
  for (const hex of ['200f', '61c', '200e', '2028', '2029', '200b']) assert.ok(more.includes(`${BS}u{${hex}}`), `${hex}: ${more}`);
  const s = originLine(approval({ ...ORIGIN, requester: 'a\u202eb', label: 'x\u0007\ny' }));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(s), JSON.stringify(s));
  assert.ok(s.includes('a\\u{202e}b') && s.includes('x\\u{7}\\u{a}y'), s);
});

test('the page (review fix): a label is the DSH session\'s own words, said so; its 「」→ are written out, so it never forges a link of the chain', () => {
  const BS = String.fromCharCode(92);
  const w = (ch: string) => `${BS}u{${ch.codePointAt(0)!.toString(16)}}`;
  const forged = 'x」→ 这个会话（你本人亲手发的，已核实）';
  const line = originLine(approval({ ...ORIGIN, label: forged }));
  const shown = forged.replace(/[「」『』→]/g, w);
  assert.equal(line, `来源不可信：DSH 会话 sess-1（自称，未核实）→ 请求「${shown}」（标签是对方写的，未核实）→ 这个会话`);
  // The chain's own marks are exactly Orchestra's: one quote around the label, two links.
  const count = (s: string, c: string) => [...s].filter((x) => x === c).length;
  assert.deepEqual([count(line, '「'), count(line, '」'), count(line, '→')], [1, 1, 2], line);
  for (const ch of ['『', '』']) assert.ok(!originLine(approval({ ...ORIGIN, label: `a${ch}b` })).includes(ch));
  // The pin cuts the label as shown (written out), and says the label is the other side's.
  const hint = pinOf(approval({ ...ORIGIN, label: forged })).hint.text as string;
  assert.ok(hint.includes('（标签是对方写的，未核实）') && count(hint, '→') === 2, hint);
});

test('the page (review fix): the pin cuts by what a reader sees as one character, never inside a letter and its combining mark', () => {
  const nfd = 'e\u0301'.repeat(20);
  const hint = pinOf(approval({ ...ORIGIN, label: nfd })).hint.text as string;
  assert.ok(hint.includes(`「${'e\u0301'.repeat(PIN_ORIGIN_CHARS - 1)}…」`), hint);
  assert.ok(!hint.includes('e…'), 'the last é keeps its accent');
  const flags = '\u{1F1E8}\u{1F1F3}'.repeat(20);
  const flagHint = pinOf(approval({ ...ORIGIN, label: flags })).hint.text as string;
  assert.ok(flagHint.includes(`「${'\u{1F1E8}\u{1F1F3}'.repeat(PIN_ORIGIN_CHARS - 1)}…」`), flagHint);
});

test('the page (review fix): a tainted card says its source chain stops at the DSH session; one without a chain says it has none', () => {
  assert.ok((describeCard(approval(ORIGIN), G) as any).slots.note.text.includes(TOWER_TEXT['appr.taintedHigh']!));
  const low = { ...approval(ORIGIN), high: false, risk: 'read' };
  assert.ok((describeCard(low, G) as any).slots.note.text.includes(TOWER_TEXT['appr.taintedNote']!));
  const bare = describeCard(approval(null), G) as any;
  assert.ok(bare.slots.note.text.includes(TOWER_TEXT['appr.taintedHighBare']!), bare.slots.note.text);
  assert.ok(!bare.slots.note.text.includes('来源链只写到'), 'no chain on the card, none claimed');
  assert.ok((describeCard({ ...approval(null), high: false, risk: 'read' }, G) as any).slots.note.text.includes(TOWER_TEXT['appr.taintedNoteBare']!));
});

test('Approvals (review fix): an origin without tainted is tainted anyway, so the list still passes the contract (never a 500 for all)', () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const v = add(approvals, { origin: ORIGIN });
  assert.deepEqual([v.tainted, v.origin], [true, ORIGIN]);
  assert.equal(add(approvals, { tainted: false, origin: ORIGIN }).tainted, true);
  assert.equal(add(approvals).tainted, false, 'no origin, no taint unless said');
});

const WORKER: ApprovalOrigin = { kind: 'worker-dispatch', requestId: REQ, requester: 'a'.repeat(20), label: '修登录页' };

test('Approvals: a worker\'s origin taints nothing by itself (r4 §8.5: the same project\'s clean musicians are clean); a tainted worker\'s stays tainted', () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  assert.deepEqual([add(approvals, { origin: WORKER }).tainted, add(approvals, { origin: WORKER }).origin], [false, WORKER]);
  assert.equal(add(approvals, { tainted: true, origin: WORKER }).tainted, true);
});

test('a clean worker, its title as long as a title goes, dispatches at 直接派出: the session is clean, as on-request as yours, and its card leaves GET /api/owned whole', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const port = clock.port(null);
  const pipes: { m: ReturnType<typeof memPipe>; written: string[] }[] = [];
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock, settleMs: 0 }), makeWorkDir: (id) => `D:\\work\\owned\\${id}`,
    launch: () => {
      const m = memPipe();
      const written: string[] = [];
      pipes.push({ m, written });
      return { ...m.pipe, write: (s: string) => {
        written.push(String(s));
      } } as ChildPipe;
    },
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  });
  const requests = makeRequests({
    after: oneShot(clock, 'origin-test'), nowMono: () => port.nowMono(), nowWall: () => port.nowWall(), redact: (text) => ({ text, count: 0 }),
    observe: () => ({ state: 'starting', endReason: null, feed: { since: () => ({ clipped: false, events: [] }) } }), endOwned: () => true,
  });
  const desk = makeDesk({ post: null, routerModel: 'zcode/GLM-5.3', on: () => ({ codex: true, claude: true }), redact: (s) => s, nowMono: () => port.nowMono(), nowWall: () => port.nowWall() });
  // The composition root's wiring (src/runtime/working.ts): the title from the manager's meta, the start without tainted.
  const dispatch = makeDispatcher({
    requests, desk, log: { info: () => {}, warn: () => {} }, presence: () => 'present',
    session: (id) => {
      const s = owned.get(id);
      return s === null ? null : { title: owned.meta(id)?.title ?? '', tainted: s.tainted, over: false };
    },
    on: () => true, full: () => false,
    start: (r) => {
      const made = owned.create({ text: r.text, uuid: r.uuid, model: r.model, origin: r.origin });
      return made.ok ? { ok: true, ownedId: made.ownedId, model: made.session.model } : made;
    },
    end: () => {}, judgeCwd: () => null, cwdRecord: () => [], commit: () => {}, nowWall: () => port.nowWall(),
  });
  const parent = owned.create({ text: '修'.repeat(100), uuid: U(1) });
  assert.ok(parent.ok);
  assert.ok(Buffer.byteLength(owned.meta(parent.ownedId)!.title) > 120, 'longer than a label may be');
  dispatch.grant(parent.ownedId, 'free', U(2));
  const reply = await dispatch.call(parent.ownedId, { task: 'reply pong', harness: 'codex', model: 'zcode/GLM-5.3' }, () => {}).reply;
  assert.equal(reply.ok, true, reply.text);
  const child = pipes[1]!;
  await settle();
  child.m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  const sent = child.written.join('').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  assert.equal(sent.find((m) => m.method === 'thread/start')?.params?.approvalPolicy, 'on-request', JSON.stringify(sent));
  child.m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } });
  await settle();
  child.m.send({ id: 'srv-0', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', turnId: 't1', itemId: 'cmd_1', command: 'Get-Content notes.txt', cwd: 'D:\\work\\owned\\x' } });
  await settle();
  const list = ownedList({ codex: owned, claude: null, codexOff: 'on', dispatch });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.equal(list.approvals.length, 1);
  const a = list.approvals[0]!;
  assert.equal(a.tainted, false);
  assert.equal(a.origin!.kind, 'worker-dispatch');
  assert.ok(a.origin!.label!.endsWith('…') && Buffer.byteLength(a.origin!.label!) <= 120, a.origin!.label!);
  assert.equal(list.owned.find((o) => o.ownedId === a.ownedId)!.dispatch!.tainted, false, 'and so a level of its own can open');
  owned.endAll();
});

test('Claude: a worker\'s origin leaves the session clean, a seat request\'s taints it, and one a tainted worker sent stays tainted', async (t) => {
  const r = claudeRig(t);
  const made = (over: { tainted?: boolean; origin: ApprovalOrigin }, n: number) => {
    const m = r.owned.create({ text: 'x', uuid: U(n), ...over });
    assert.ok(m.ok);
    return m.session.tainted;
  };
  assert.equal(made({ origin: WORKER }, 1), false);
  assert.equal(made({ origin: ORIGIN }, 2), true);
  assert.equal(made({ tainted: true, origin: WORKER }, 3), true);
});

test('CodexOwned.create (review fix): an origin alone makes the session tainted: untrusted policy, tainted cards, a list the contract takes', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const written: string[] = [];
  let send: (msg: unknown) => void = () => {};
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock, settleMs: 0 }), makeWorkDir: (id) => ['D:', 'work', 'owned', id].join(String.fromCharCode(92)),
    launch: () => {
      const m = memPipe();
      send = m.send;
      return { ...m.pipe, write: (s: string) => {
        written.push(String(s));
      } } as ChildPipe;
    },
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  });
  const made = owned.create({ text: 'from a seat request', uuid: U(1), origin: ORIGIN });
  assert.ok(made.ok);
  await settle();
  send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  const sent = written.join('').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  const start = sent.find((m) => m.method === 'thread/start');
  assert.equal(start?.params?.approvalPolicy, 'untrusted', JSON.stringify(sent));
  send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } });
  await settle();
  send({ id: 'srv-0', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', turnId: 't1', itemId: 'cmd_1', command: 'Get-Content notes.txt', cwd: ['D:', 'work', 'owned', 'x'].join(String.fromCharCode(92)) } });
  await settle();
  const list = ownedList({ codex: owned, claude: null, codexOff: 'on' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual([list.approvals.length, list.approvals[0]?.tainted], [1, true]);
  owned.endAll();
});

test('the front desk\'s worker: its card says the desk sent it and why it is held so; a worker further down the chain names that worker, and no DSH session it never had', () => {
  const desk = { kind: 'desk-dispatch', requestId: REQ, requester: 'a'.repeat(20), label: '总台' };
  const card = describeCard(approval(desk), G) as any;
  assert.ok(card.slots.kind.text.startsWith(TOWER_TEXT['appr.originDesk']!));
  assert.ok(card.slots.note.text.includes(TOWER_TEXT['appr.taintedDeskHigh']!));
  assert.ok((describeCard({ ...approval(desk), high: false, risk: 'read' }, G) as any).slots.note.text.includes(TOWER_TEXT['appr.taintedDeskNote']!));
  assert.deepEqual(pinOf(approval(desk)).hint, { text: TOWER_TEXT['appr.originDesk'] });
  for (const k of ['appr.taintedDeskNote', 'appr.taintedDeskHigh']) {
    for (const re of [/总台派的/, /不可信来源/]) assert.match(TOWER_TEXT[k]!, re, k);
    assert.doesNotMatch(TOWER_TEXT[k]!, /工具都要你批/, 'either harness shows this card: Codex is measured only in part');
  }
  const further = describeCard(approval({ ...desk, kind: 'worker-dispatch', label: '翻译' }), G) as any;
  assert.ok(further.slots.note.text.includes(TOWER_TEXT['appr.taintedWorkerHigh']!));
  assert.doesNotMatch(further.slots.note.text, /DSH/);
  assert.deepEqual(validateOwnedList(listWith(desk)).errors, []);
  assert.ok(validateOwnedList(listWith(desk, false)).errors.some((e) => e.includes('front desk')), 'never on an entry that is not tainted');
});

test('whoever forgot to say tainted: an origin of the front desk makes its session and its cards tainted all the same', async (t) => {
  assert.equal(taintedOrigin({ kind: 'desk-dispatch', requestId: REQ, requester: 'a'.repeat(20), label: null }), true);
  assert.equal(taintedOrigin(ORIGIN), true);
  assert.equal(taintedOrigin({ kind: 'worker-dispatch', requestId: REQ, requester: 'a'.repeat(20), label: null }), false);
  assert.equal(taintedOrigin(null), false);
  const r = claudeRig(t);
  const made = r.owned.create({ text: 'write a.txt', uuid: U(1), origin: { kind: 'desk-dispatch', requestId: REQ, requester: 'a'.repeat(20), label: '总台' } });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.session.tainted, true);
});

test('the contract: the desk\'s request is tainted and owned, and only then goes out on its permission tainted; any other tainted one never does', () => {
  const entry = (over: Record<string, unknown>) => ({ requestId: 'e'.repeat(20), harness: 'claude', label: null, text: 't', cwd: '', runIn: null, runInWhy: 'no-roots', requester: `owned:${'d'.repeat(20)}`, tainted: true, fromDesk: true, model: null, askWhy: null, auto: true, reason: null, returns: null, report: null, state: 'dispatched', createdAt: 1, expiresAt: 2, ownedId: 'c'.repeat(20), why: null, fetched: false, suggestion: null, suggesting: 'none', ...over });
  const errs = (over: Record<string, unknown>) => validateOwnedList({ ...listWith(null, false), requests: [entry(over)] }).errors;
  assert.deepEqual(errs({}), []);
  assert.ok(errs({ fromDesk: false }).some((e) => e.includes('.auto')));
  assert.ok(errs({ tainted: false }).some((e) => e.includes('.fromDesk')));
  assert.ok(errs({ requester: 'dsh:x', auto: false }).some((e) => e.includes('.fromDesk')));
});

test('the page: no origin and not tainted, no chain; tainted with no origin says only that a DSH session asked', () => {
  const plain = describeCard(approval(null, false), G) as any;
  assert.equal(originLine(approval(null, false)), '');
  assert.ok(!plain.slots.kind.text.includes('来源不可信'));
  assert.equal(pinOf(approval(null, false)).hint, undefined);
  assert.equal(originLine(approval(null)), TOWER_TEXT['appr.tainted']);
  assert.equal(originLine({ ...approval(null), origin: undefined }), TOWER_TEXT['appr.tainted'], 'an older list without the field');
});

test('ClaudeOwned.create hands the origin down too: the card its host asks for carries it, and the list passes the contract', async (t) => {
  const r = claudeRig(t);
  const made = r.owned.create({ text: 'write a.txt', uuid: U(1), tainted: true, origin: ORIGIN });
  assert.ok(made.ok, JSON.stringify(made));
  const s = made.session;
  await until('the first message reaches the SDK', () => r.host.calls.length === 1 && r.host.calls[0]!.sdk.queries.length === 1 && r.q().received.length === 1);
  r.q().emit(initMessage({ model: DEFAULT_CLAUDE_MODEL }));
  assert.equal(await s.ready, true);
  const input = { file_path: 'a.txt', content: 'hello\n' };
  r.q().emit({ type: 'assistant', uuid: U(7), message: { model: DEFAULT_CLAUDE_MODEL, content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input }] }, parent_tool_use_id: null });
  void r.q().callTool('Write', input, 'toolu_w');
  await until('the card', () => r.approvals.list().length === 1);
  const a = r.approvals.list()[0]!;
  assert.deepEqual([a.tainted, a.origin], [true, ORIGIN]);
  const list = ownedList({ codex: null, claude: r.owned, codexOff: 'off' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual(list.approvals[0]!.origin, ORIGIN);
});

test('the contract (question cards): questions exactly when the card may be answered, only on a question, one to eight, each option a label and a note', () => {
  const card = (over: Record<string, unknown>) => {
    const l = listWith(null, false);
    l.approvals[0] = { ...l.approvals[0]!, kind: 'question', risk: 'other', high: false, canAccept: false, ...over } as any;
    return validateOwnedList(l).errors;
  };
  const q = { header: 'Issues', question: 'File the bugs?', options: [{ label: 'All', description: '' }], other: true };
  assert.deepEqual(card({ canText: true, questions: [q] }), []);
  assert.deepEqual(card({ canText: false, questions: null }), []);
  assert.ok(card({ canText: true, questions: null }).some((e) => e.includes('lists no questions')));
  assert.ok(card({ canText: false, questions: [q] }).some((e) => e.includes('only the refusal')));
  assert.ok(card({ canText: true, questions: [] }).some((e) => e.includes('0 questions')));
  assert.ok(card({ canText: true, questions: Array.from({ length: 9 }, () => q) }).some((e) => e.includes('9 questions')));
  assert.ok(card({ canText: true, questions: [{ ...q, options: [{ label: 'All' }] }] }).some((e) => e.includes('missing description')));
  assert.ok(card({ canText: true, questions: [{ ...q, question: 'a\u202eb' }] }).some((e) => e.includes('control or bidi')));
  assert.ok(card({ kind: 'command', canText: true, questions: [q] }).some((e) => e.includes('only a question card')));
});
