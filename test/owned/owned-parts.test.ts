import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Answer, AnswerCause, ApprovalInput } from '../../src/owned/approvals.ts';
import { APPROVAL_LIMITS, Approvals } from '../../src/owned/approvals.ts';
import { GATEWAY_RE, OWNED_DIRS, codexConfigToml, writeCodexHome } from '../../src/owned/codex-home.ts';
import { FEED_LIMITS, Feed } from '../../src/owned/feed.ts';
import { DEFAULT_CODEX_MODEL, isOwnedModel } from '../../src/owned/models.ts';
import { OWNED_TEXT_LIMITS, escapeInvisible, headUtf8, shown, splitUtf8, tailUtf8 } from '../../src/owned/text.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { parseProfileArgs } from '../../src/runtime/test-profile.ts';

// The owned sessions' parts on their own: the approval queue's rules (D8, §10.9's server half), the
// feed's bounds, the private CODEX_HOME's config, the text rules, and the --owned argument.

function queue(timeoutMs?: number) {
  const clock = new VirtualClock({ mono: 0, wall: 1_000_000 });
  const changes: number[] = [];
  const q = new Approvals({ hub: clock, settleMs: 0, ...(timeoutMs !== undefined ? { timeoutMs } : {}), onChange: () => changes.push(1) });
  const answered: [string, Answer, AnswerCause][] = [];
  const add = (over: Partial<ApprovalInput> = {}) => q.add({
    ownedId: 'o1', kind: 'command', title: 'ls', preview: 'command: ls', redactions: 0, risk: 'shell', canAccept: true, canText: false,
    answer: (a, cause) => answered.push([over.ownedId ?? 'o1', a, cause]), ...over,
  });
  return { clock, q, add, answered, changes };
}

test('approvals: the revision moves with every change; allow needs the shown digest and the current revision; deny is taken whatever the revision', () => {
  const { q, add, answered } = queue();
  const a = add();
  const b = add({ title: 'pwd', preview: 'command: pwd' });
  assert.equal(q.rev, 2);
  assert.match(a.approvalId, /^[0-9a-f]{32}$/);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(a.digest, b.digest);
  assert.equal(q.allow(a.approvalId, { digest: a.digest, rev: 1 }), 'stale-view');
  assert.deepEqual(answered, [], 'a stale view changes nothing');
  assert.equal(q.allow(a.approvalId, { digest: b.digest, rev: q.rev }), 'digest-mismatch');
  assert.deepEqual(answered.map(([, x, c]) => [x.decision, c]), [['decline', 'human']], 'a wrong digest is a refusal');
  assert.equal(q.deny(b.approvalId), 'ok');
  assert.equal(q.deny(b.approvalId), 'approval-gone');
  assert.equal(q.allow('f'.repeat(32), { digest: a.digest, rev: q.rev }), 'approval-gone');
  const c = add();
  assert.equal(q.allow(c.approvalId, { digest: c.digest, rev: q.rev }), 'ok');
  assert.deepEqual(answered.map(([, x]) => x.decision), ['decline', 'decline', 'accept']);
});

test('approvals: a preview past 16 KiB is cut and offers only the refusal; a hidden secret, a shell, the network or a grant is high risk', () => {
  const { q, add } = queue();
  const long = add({ preview: 'x'.repeat(OWNED_TEXT_LIMITS.previewBytes + 1) });
  assert.deepEqual([long.tooLong, long.canAccept, long.preview.length], [true, false, OWNED_TEXT_LIMITS.previewBytes]);
  assert.equal(q.allow(long.approvalId, { digest: long.digest, rev: q.rev }), 'digest-mismatch');
  assert.equal(add({ risk: 'write' }).high, false);
  assert.equal(add({ risk: 'write', redactions: 1 }).high, true);
  assert.equal(add({ risk: 'net' }).high, true);
  assert.equal(add({ kind: 'permissions', risk: 'write' }).high, true);
  const question = add({ kind: 'question', canAccept: false, canText: true });
  assert.equal(q.answerText(question.approvalId, 'blue', { digest: question.digest, rev: q.rev }), 'ok');
  const noText = add({ canText: false });
  assert.equal(q.answerText(noText.approvalId, 'x', { digest: noText.digest, rev: q.rev }), 'digest-mismatch');
});

test('approvals: the deadline (Q4: 30 minutes) declines with cause clock; a session\'s stop or end declines only its own; a gone child\'s are dropped unanswered', () => {
  const { clock, q, add, answered } = queue();
  assert.equal(APPROVAL_LIMITS.timeoutMs, 30 * 60 * 1000);
  const a = add();
  add({ ownedId: 'o2' });
  add({ ownedId: 'o2' });
  add({ ownedId: 'o3' });
  assert.equal(a.deadlineMono, APPROVAL_LIMITS.timeoutMs);
  clock.advanceBy(APPROVAL_LIMITS.timeoutMs - 1);
  assert.equal(q.list().length, 4);
  clock.advanceBy(1);
  // All four were due at the same instant (the Clock fires them in timerId order).
  assert.deepEqual(answered.map(([o, x, c]) => [o, x.decision, c]).sort(), [['o1', 'decline', 'clock'], ['o2', 'decline', 'clock'], ['o2', 'decline', 'clock'], ['o3', 'decline', 'clock']]);
  answered.length = 0;
  add({ ownedId: 'o2' });
  add({ ownedId: 'o2' });
  const keep = add({ ownedId: 'o3' });
  add({ ownedId: 'o4' });
  assert.equal(q.declineOwned('o2', 'interrupt'), 2);
  assert.deepEqual(answered.map(([o, , c]) => [o, c]), [['o2', 'interrupt'], ['o2', 'interrupt']]);
  assert.equal(q.forgetOwned('o4'), 1);
  assert.equal(answered.length, 2, 'a gone child is not answered');
  assert.deepEqual(q.list().map((v) => v.approvalId), [keep.approvalId]);
  assert.equal(q.forget(keep.approvalId), true);
  assert.equal(q.forget(keep.approvalId), false);
  clock.advanceBy(APPROVAL_LIMITS.timeoutMs);
  assert.equal(answered.length, 2, 'the cancelled deadlines never fire');
});

test('feed: a live event is replaced (new seq, not clipped); past 500 events the oldest go and a reader from before them is told clipped', () => {
  let now = 5;
  const f = new Feed(() => now);
  f.push({ kind: 'you', ref: null, uuid: 'u', text: 'hi', state: null });
  f.upsert('text:m1', { kind: 'text', ref: 'm1', text: 'he', state: 'partial' });
  now = 6;
  f.upsert('text:m1', { kind: 'text', ref: 'm1', text: 'hello', state: 'partial' });
  assert.deepEqual(f.since(0).events.map((e) => [e.seq, e.text, e.live, e.at]), [[1, 'hi', false, 5], [3, 'hello', true, 6]]);
  assert.equal(f.since(0).clipped, false);
  f.settle('text:m1');
  f.push({ kind: 'text', ref: 'm1', text: 'hello', state: 'final' });
  assert.deepEqual(f.since(1).events.map((e) => [e.seq, e.state]), [[4, 'final']]);
  for (let i = 0; i < FEED_LIMITS.events; i++) f.push({ kind: 'note', ref: null, text: null, state: 'x' });
  const page = f.since(0);
  assert.equal(page.events.length, FEED_LIMITS.events);
  assert.equal(page.clipped, true);
  assert.equal(page.to, f.lastSeq);
  assert.equal(f.since(page.events[0]!.seq - 1).clipped, false);
  // The byte bound: big texts push the oldest out too.
  const g = new Feed(() => 0);
  for (let i = 0; i < 200; i++) g.push({ kind: 'text', ref: null, text: 'y'.repeat(2048), state: 'final' });
  assert.ok(g.since(0).events.length < 200 && g.since(0).clipped);
});

test('codex-home: config.toml names the magpie provider on loopback, on-request and workspace-write; a model off the list or another gateway is refused', () => {
  const toml = codexConfigToml({ model: DEFAULT_CODEX_MODEL, gatewayBaseUrl: 'http://127.0.0.1:3425/v1' });
  assert.equal(toml, [
    'model = "codex/gpt-6.1-sol"', 'model_provider = "magpie"', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', '',
    '[model_providers.magpie]', 'name = "magpie"', 'base_url = "http://127.0.0.1:3425/v1"', 'wire_api = "responses"', '',
  ].join('\n'));
  assert.throws(() => codexConfigToml({ model: 'gpt-5', gatewayBaseUrl: 'http://127.0.0.1:3425/v1' }), /outside the owned list/);
  for (const url of ['http://example.com/v1', 'https://127.0.0.1:3425/v1', 'http://127.0.0.1:3425', 'http://localhost:3425/v1', 'http://127.0.0.1:3425/v1"\nx = "y']) {
    assert.ok(!GATEWAY_RE.test(url), url);
    assert.throws(() => codexConfigToml({ model: DEFAULT_CODEX_MODEL, gatewayBaseUrl: url }), /gateway/, url);
  }
  const calls: string[] = [];
  const dir = writeCodexHome({ mkdirp: (d: string) => (calls.push(`mkdir ${d}`), []), writeAtomic: (p: string, data: string | Uint8Array) => calls.push(`write ${p} ${String(data).length}`) }, 'C:\\h', { model: DEFAULT_CODEX_MODEL, gatewayBaseUrl: 'http://127.0.0.1:3425/v1' });
  assert.equal(dir, `C:\\h\\${OWNED_DIRS.codexHome}`);
  assert.deepEqual(calls, [`mkdir C:\\h\\codex-home`, `write C:\\h\\codex-home\\config.toml ${toml.length}`]);
  assert.equal(isOwnedModel('opencode-go/claude-haiku-5-5'), true);
  assert.equal(isOwnedModel(7), false);
});

test('text: invisible characters are written out, never removed; cuts keep whole code points; redaction comes before the cut', () => {
  assert.equal(escapeInvisible('a\u202Eb\u200Bc\td\r\ne\u0007'), 'a\\u202Eb\\u200Bc\td\r\ne\\u0007');
  assert.deepEqual(splitUtf8('aé😀b', 3), ['aé', '😀', 'b']);
  assert.equal(splitUtf8('aé😀b', 3).join(''), 'aé😀b');
  assert.deepEqual(headUtf8('aé😀b', 4), { text: 'aé', cut: true });
  assert.deepEqual(tailUtf8('aé😀b', 5), { text: '😀b', cut: true });
  assert.deepEqual(tailUtf8('ab', 5), { text: 'ab', cut: false });
  // The secret straddles the cut: redacted whole first, so no piece of it survives.
  const secret = 'SECRETVALUE123';
  const redact = (t: string) => ({ text: t.split(secret).join('[redacted:known]'), count: t.split(secret).length - 1 });
  const s = shown(redact, `${'x'.repeat(10)}${secret}`, 16, 'tail');
  assert.ok(!s.text.includes('VALUE123'), s.text);
  assert.equal(s.redactions, 1);
});

test('--owned: either profile, at most once, no value; absent means off', () => {
  const deps = { env: {}, processEnv: {}, realpath: (p: string) => p };
  assert.deepEqual(parseProfileArgs(['--owned'], deps), { ok: true, profile: { kind: 'real' }, owned: true });
  assert.deepEqual(parseProfileArgs(['--owned', '--peek-port', '7470'], deps), { ok: true, profile: { kind: 'real' }, peekPort: 7470, owned: true });
  assert.deepEqual(parseProfileArgs([], deps), { ok: true, profile: { kind: 'real' } });
  assert.deepEqual(parseProfileArgs(['--owned', '--owned'], deps), { ok: false, refusal: { reason: 'duplicate-flag', flag: '--owned' } });
  assert.deepEqual(parseProfileArgs(['--owned=1'], deps), { ok: false, refusal: { reason: 'unknown-argument', arg: '--owned=1' } });
});

test('approvals: within 750 ms of a change of the list an allow is stale-view (r4 §10.9), a deny is not; every entry that leaves says how and why', () => {
  const clock = new VirtualClock({ mono: 0, wall: 1_000_000 });
  const settled: [string, string, string][] = [];
  const q = new Approvals({ hub: clock, onSettled: (v, o) => settled.push([v.approvalId, o.decision, o.cause]) });
  assert.equal(APPROVAL_LIMITS.settleMs, 750);
  const answered: Answer[] = [];
  const add = (ownedId = 'o1') => q.add({ ownedId, kind: 'command', title: 'ls', preview: 'command: ls', redactions: 0, risk: 'shell', canAccept: true, canText: false, answer: (a) => answered.push(a) });
  const a = add();
  assert.equal(a.rev, 1, 'the revision it came in with');
  clock.advanceBy(749);
  assert.equal(q.allow(a.approvalId, { digest: a.digest, rev: q.rev }), 'stale-view');
  clock.advanceBy(1);
  const b = add('o2');
  assert.equal(b.rev, 2);
  assert.equal(q.allow(a.approvalId, { digest: a.digest, rev: q.rev }), 'stale-view', 'another session\'s card moved the list');
  clock.advanceBy(750);
  assert.equal(q.allow(a.approvalId, { digest: a.digest, rev: q.rev }), 'ok');
  assert.equal(q.deny(b.approvalId), 'ok', 'a refusal is taken at once');
  const c = add();
  q.forget(c.approvalId);
  const d = add();
  clock.advanceBy(APPROVAL_LIMITS.timeoutMs);
  assert.deepEqual(settled, [[a.approvalId, 'accept', 'human'], [b.approvalId, 'decline', 'human'], [c.approvalId, 'dropped', 'gone'], [d.approvalId, 'decline', 'clock']]);
  assert.deepEqual(answered.map((x) => x.decision), ['accept', 'decline', 'decline']);
  assert.throws(() => new Approvals({ hub: clock, settleMs: -1 }), /settleMs/);
});
