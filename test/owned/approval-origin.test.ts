import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals, type ApprovalOrigin } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
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
    owned: [{ ownedId: 'a'.repeat(20), harness: 'codex', model: 'codex/gpt-6.1-sol', title: 't', state: 'running', endReason: null, waiting: 'b'.repeat(32), queued: 0, tokens: null, lastSeq: 1, createdAt: 1, brake: false, cwd: null }],
    approvals: [{
      approvalId: 'b'.repeat(32), ownedId: 'a'.repeat(20), kind: 'command', title: 'npm test', preview: 'command: npm test', tooLong: false, redactions: 0,
      digest: 'c'.repeat(64), risk: 'shell', high: true, tainted, origin, rev: 1, canAccept: true, canText: false, deadline: 5,
    }],
    limits: { maxOwned: 4, active: 1 }, requests: [], requestedGone: [],
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
  const line = '来源不可信：DSH 会话 sess-1（自称，未核实）→ 请求「修登录页」→ 这个会话';
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
  assert.equal(none, '来源不可信：DSH 会话 未知（请求没报自己的 id）→ 请求「修登录页」→ 这个会话');
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
  const s = originLine(approval({ ...ORIGIN, requester: 'a\u202eb', label: 'x\u0007\ny' }));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(s), JSON.stringify(s));
  assert.ok(s.includes('a\\u{202e}b') && s.includes('x\\u{7}\\u{a}y'), s);
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
