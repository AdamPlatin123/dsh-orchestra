import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { OwnedJob } from '../../src/os/procguard.ts';
import type { CodexMember, CodexSession, PathJudge } from '../../src/owned/codex-session.ts';
import type { OwnedMember, OwnedSeat, TowerNode } from '../../src/sources/tower.ts';
import type { Frame } from '../fixtures/codex-subagent-frames.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned, memberSeats, recentOf, restoredSession } from '../../src/owned/codex-owned.ts';
import { CODEX_SESSION_LIMITS, startCodexSession } from '../../src/owned/codex-session.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { REGISTRY_LIMITS, afterRestart, makeOwnedRegistry, parseOwnedRecord } from '../../src/owned/registry.ts';
import { restoredOwned } from '../../src/owned/restored.ts';
import { memberNodeId, ownedNode, ownedProject, towerFromStage } from '../../src/sources/tower.ts';
import { validateTower } from '../../shared/tower-contract.js';
import { ownedIdOf } from '../../ui/owned.js';
import { busyStage } from '../helpers/tower-fixture.ts';
import {
  CHILD, CHILD_TURN, CHILD_WORDS, ROOT, ROOT_TURN, SECS0, T0, V1_FROM_APPROVAL, V1_TO_APPROVAL, V2_FROM_APPROVAL, V2_TO_APPROVAL,
  activity, childApproval, childCommand, childTurn, collab, resolved, statusOf,
} from '../fixtures/codex-subagent-frames.ts';

// The sub-agents of an owned Codex session (orchestra app plan, "子代理"): the sequences measured on
// codex-cli 0.165.0 played through an in-memory pipe, then what is left when the order or the fields are
// not as measured. Only states, names and times are read: what another thread says never reaches the feed.

const OWNED = '0123456789abcdef0123';
const CWD = `C:\\Users\\u\\.orchestra\\work\\${OWNED}`;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function memPipe(job: OwnedJob | null) {
  const out: ((c: Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const written: string[] = [];
  const pipe: ChildPipe = {
    pid: 1, job,
    write: (d) => {
      written.push(d);
    },
    onStdout: (cb) => {
      out.push(cb);
    },
    onStderr: () => {},
    onClose: (cb) => {
      closes.push(cb);
    },
    onError: () => {},
    stop: () => {},
  };
  return {
    pipe,
    sent: () => written.map((w) => JSON.parse(w) as Record<string, any>),
    send: (msg: unknown) => out.forEach((cb) => cb(Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'))),
    close: (code: number | null) => closes.forEach((cb) => cb(code, null)),
  };
}

const redact = (text: string) => ({ text: text.replaceAll('ghp_SECRET', '[redacted]'), count: text.includes('ghp_SECRET') ? 1 : 0 });

const opening = (m: ReturnType<typeof memPipe>, policy = 'on-request') => async () => {
  await settle();
  m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  m.send({ id: 2, result: { thread: { id: ROOT }, approvalPolicy: policy, sandbox: { type: 'readOnly' } } });
};

async function session(job: OwnedJob | null = null, over: { judge?: PathJudge; tainted?: boolean } = {}) {
  const clock = new VirtualClock({ mono: 1_000, wall: T0 + 1_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const m = memPipe(job);
  const started = startCodexSession({ ownedId: OWNED, cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals, now: () => clock.wall, redact, hub: clock, ...over });
  assert.ok(started.ok);
  const s = started.session;
  await opening(m, over.tainted === true ? 'untrusted' : 'on-request')();
  assert.equal(await s.ready, true);
  m.send({ method: 'turn/started', params: { threadId: ROOT, turn: { id: 'turn-root' } } });
  const play = async (frames: readonly Frame[]) => {
    for (const f of frames) m.send(f);
    await settle();
  };
  return { m, s, approvals, clock, play };
}

const only = (s: CodexSession): CodexMember => {
  assert.equal(s.members.length, 1, JSON.stringify(s.members));
  return s.members[0]!;
};
const feedText = (s: CodexSession) => JSON.stringify(s.feed.since(0).events);
const noteStates = (s: CodexSession) => s.feed.since(0).events.filter((e) => e.kind === 'note').map((e) => `${e.state}${e.text === null ? '' : `=${e.text}`}`);
const seatOf = (s: CodexSession, over: Partial<OwnedSeat> = {}): OwnedSeat => ({
  ownedId: OWNED, harness: 'codex', title: 'a session', state: s.state, endReason: s.endReason, waiting: null, lastAt: s.feed.lastAt, ...memberSeats(s), ...over,
});
const member = (n: number, over: Partial<OwnedMember> = {}): OwnedMember => ({
  threadId: `thread-${n}`, name: `/root/m${n}`, model: null, state: 'returned', why: null, startedAt: 1_000, endedAt: 4_000, lastAt: 4_000, failed: 0, ranUnasked: 0, asking: null, ...over,
});
const towerOf = (seats: OwnedSeat[], nowWall = 10_000) => towerFromStage(busyStage(), { seats, nowWall });
const memberRows = (nodes: readonly TowerNode[]) => nodes.filter((n) => n.layer === 'subagent');
/** A file change on a thread and the request about it, in the shapes of the schema (FileChangeRequestApprovalParams has no changes: not measured live). */
const CHANGES = [{ path: 'a.txt', kind: { type: 'update' }, diff: '+x' }];
const fileChange = (phase: 'started' | 'completed', threadId: string, status = 'inProgress', itemId = 'fc1', changes: unknown = CHANGES): Frame => ({ method: `item/${phase}`, params: { threadId, turnId: 't', item: { type: 'fileChange', id: itemId, status, changes } } });
const fileAsk = (id: number, threadId: string, itemId = 'fc1') => ({ id, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 't', itemId } });
const ran = (threadId: string, itemId: string, status = 'completed', command = CHILD_WORDS): Frame[] => [
  { method: 'item/started', params: { threadId, turnId: 't', item: { type: 'commandExecution', id: itemId, command, status: 'inProgress' } } },
  { method: 'item/completed', params: { threadId, turnId: 't', item: { type: 'commandExecution', id: itemId, command, status, aggregatedOutput: CHILD_WORDS, exitCode: 0 } } },
];

test('v2, as measured: subAgentActivity builds the member, its command asks on a card that names it, and it ends as returned', async () => {
  const { m, s, approvals, clock, play } = await session();
  await play(V2_TO_APPROVAL);
  m.send(childApproval(0));
  await settle();
  assert.deepEqual(
    [only(s).threadId, only(s).name, only(s).state, only(s).startedAt, only(s).endedAt],
    [CHILD, '/root/ping_once', 'running', T0, null],
  );
  const card = approvals.list()[0]!;
  assert.equal(card.preview.split('\n')[0], `from subagent: /root/ping_once (thread …${CHILD.slice(-8)})`);
  assert.deepEqual(only(s).asks, [card.approvalId]);
  assert.equal(s.feed.since(0).events.find((e) => e.kind === 'ask')?.text, `/root/ping_once (thread …${CHILD.slice(-8)}): ping`);
  // The tower: the wait is the session's (one approval, one waiting node), the member says it is the one asking.
  const seat = seatOf(s, { waiting: { kind: 'approval', deadline: card.deadlineWall, title: card.title } });
  const asking = towerOf([{ ...seat, ...memberSeats(s, approvals.list()) }], clock.wall);
  assert.deepEqual(validateTower(asking).errors, []);
  assert.deepEqual(asking.waitingBar.filter((e) => e.source === 'orchestra').map((e) => e.node), [`n:${OWNED}`]);
  const row = asking.projects[0]!.nodes[1]!;
  assert.deepEqual([row.state, row.activity, row.waiting], ['running', '在等你审批：ping', null]);

  assert.equal(approvals.deny(card.approvalId), 'ok');
  assert.deepEqual(m.sent().at(-1), { id: 0, result: { decision: 'decline' } });
  assert.deepEqual(only(s).asks, []);
  await play([resolved(0), ...V2_FROM_APPROVAL]);
  assert.deepEqual([only(s).state, only(s).why, only(s).endedAt, only(s).failed], ['returned', null, T0 + 15_982, 0]);
  assert.equal(s.tokens, null, 'the sub-agent\'s token count is not the session\'s');
  assert.equal(feedText(s).includes(CHILD_WORDS), false);
  assert.equal(s.feed.since(0).events.some((e) => e.ref === 'exec-child' && e.kind !== 'ask'), false, 'its command is not this feed\'s');
  assert.equal(s.state, 'running', 'none of it moved the root');

  const done = towerOf([seatOf(s)], clock.wall);
  assert.deepEqual(validateTower(done).errors, []);
  const [root, kid] = done.projects[0]!.nodes;
  assert.deepEqual([root!.counts.children, kid!.id, kid!.parent, kid!.depth, kid!.layer], [1, memberNodeId(OWNED, CHILD), `n:${OWNED}`, 1, 'subagent']);
  assert.deepEqual([kid!.title, kid!.state, kid!.basis, kid!.ownership, kid!.session, kid!.durationMs], ['/root/ping_once', 'returned', 'owned', 'owned', null, 15_982]);
  assert.equal(JSON.stringify(done).includes(CHILD), false, 'no thread id reaches the page');
});

test('v1, as measured: the first status comes before the spawn names the thread, thread/read gives the name, wait and closeAgent leave it returned', async () => {
  const { m, s, play } = await session();
  await play(V1_TO_APPROVAL);
  assert.deepEqual([only(s).name, only(s).state, only(s).startedAt], [null, 'running', T0 + 55]);
  const read = m.sent().filter((x) => x.method === 'thread/read');
  assert.deepEqual(read.map((x) => x.params), [{ threadId: CHILD }]);
  m.send({ id: read[0]!.id, result: { thread: { id: CHILD, agentNickname: 'Archimedes ghp_SECRET', agentRole: null, preview: CHILD_WORDS } } });
  await settle();
  assert.equal(only(s).name, 'Archimedes [redacted]');
  await play(V1_FROM_APPROVAL);
  assert.deepEqual([only(s).state, only(s).endedAt], ['returned', (SECS0 + 17) * 1000]);
  assert.equal(feedText(s).includes(CHILD_WORDS), false);
  assert.equal(m.sent().filter((x) => x.method === 'thread/read').length, 1, 'its name is asked once');
});

test('a sub-agent that fails: a step that fails is counted and the report still stands; a failed turn ends it, in no case as error', async () => {
  const { m, s, play } = await session();
  // Measured (run 3): the command failed with exit code 1, and the child's turn and activity both completed.
  await play(V2_TO_APPROVAL);
  m.send(childApproval(0));
  await play([childCommand('completed', T0 + 6_500, 'failed', 1), activity('started', 'completed', T0 + 15_000), statusOf('idle'), childTurn('turn/completed')]);
  assert.deepEqual([only(s).state, only(s).why, only(s).failed], ['returned', null, 1]);
  const node = towerOf([seatOf(s)]).projects[0]!.nodes[1]!;
  assert.deepEqual([node.state, node.activity], ['returned', '其中 1 步失败']);

  // Not measured, from the types: a turn that failed, an agent that errored, an error that takes no retry.
  const b = await session();
  await b.play([activity('started', 'started', T0), childTurn('turn/started'), { method: 'error', params: { threadId: CHILD, willRetry: true, error: { message: CHILD_WORDS } } }]);
  assert.equal(only(b.s).failed, 0);
  await b.play([{ method: 'error', params: { threadId: CHILD, willRetry: false, error: { message: CHILD_WORDS } } }, childTurn('turn/completed', { status: 'failed', error: { message: CHILD_WORDS } }), activity('started', 'completed', T0 + 9_000)]);
  assert.deepEqual([only(b.s).state, only(b.s).why, only(b.s).failed], ['ended', 'failed', 1], 'the activity that follows does not turn a failed turn into a report');
  assert.equal(feedText(b.s).includes(CHILD_WORDS), false, 'another thread\'s error text stays out of this feed');
  const tower = towerOf([seatOf(b.s)]);
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual([tower.projects[0]!.nodes[1]!.state, tower.projects[0]!.nodes[1]!.activity], ['ended', '已结束：它这一轮失败了，没有回报；其中 1 步失败']);
  assert.equal(tower.meta.detects.error, false);

  const c = await session();
  await c.play([collab('completed', 'wait', T0, [CHILD], { [CHILD]: { status: 'errored', message: CHILD_WORDS } }), collab('completed', 'spawnAgent', T0, [], {}, 'failed')]);
  assert.deepEqual([only(c.s).state, only(c.s).why], ['ended', 'failed']);
  assert.deepEqual(noteStates(c.s), ['subagent-spawn-failed']);
  // A spawn that completed and named nobody did not fail: nothing says it did.
  const quiet = await session();
  await quiet.play([collab('completed', 'spawnAgent', T0, [], {})]);
  assert.deepEqual(noteStates(quiet.s), []);
  const d = await session();
  await d.play([statusOf('systemError')]);
  assert.deepEqual([only(d.s).state, only(d.s).why], ['ended', 'failed']);
});

test('a stop counts as running only what codex said runs: one idle, and one past the bound, are said apart', async () => {
  const { s, play } = await session();
  await play([activity('started', 'started', T0), childTurn('turn/started'), activity('started', 'started', T0, 'thread-two', '/root/two'), statusOf('idle', 'thread-two')]);
  await s.interrupt();
  assert.deepEqual(noteStates(s), ['members-running=1', 'members-not-stopped=1']);

  const b = await session();
  await b.play([statusOf('idle')]);
  await b.s.interrupt();
  assert.deepEqual(noteStates(b.s), ['members-not-stopped=1'], 'an idle one is not said to run');

  const c = await session();
  const L = CODEX_SESSION_LIMITS.members;
  const threads = Array.from({ length: L + 8 }, (_, i) => `thread-${i}`);
  await c.play(threads.map((t) => childTurn('turn/started', {}, t)));
  await c.s.interrupt();
  assert.deepEqual(noteStates(c.s), ['members-over=8', `members-running=${L}`, 'members-not-stopped=8']);
  // Nothing to say: every member reported.
  const d = await session();
  await d.play([activity('started', 'started', T0), childTurn('turn/started'), childTurn('turn/completed')]);
  await d.s.interrupt();
  assert.deepEqual(noteStates(d.s), []);
});

test('a sub-agent interrupted while it runs: ended with that reason; a new turn revives it; a stop says it reaches the root only', async () => {
  const { m, s, play } = await session();
  await play([activity('started', 'started', T0), childTurn('turn/started')]);
  await s.interrupt();
  await settle();
  assert.deepEqual(noteStates(s), ['members-running=1']);
  assert.deepEqual(m.sent().filter((x) => x.method === 'turn/interrupt').map((x) => x.params.threadId), [ROOT], 'nothing is sent to its thread');
  await play([childTurn('turn/completed', { status: 'interrupted', completedAt: SECS0 + 3 })]);
  assert.deepEqual([only(s).state, only(s).why, only(s).endedAt], ['ended', 'interrupted', (SECS0 + 3) * 1000]);
  assert.equal(towerOf([seatOf(s)]).projects[0]!.nodes[1]!.activity, '已结束：被打断了，没有回报');
  await play([childTurn('turn/started', { id: 'turn-child-2' })]);
  assert.deepEqual([only(s).state, only(s).why, only(s).endedAt, only(s).startedAt], ['running', null, null, T0]);
  // The kinds and states only the types name.
  await play([activity('started', 'interrupted', T0 + 100)]);
  assert.deepEqual([only(s).state, only(s).why], ['ended', 'interrupted']);
  const b = await session();
  await b.play([collab('completed', 'wait', T0, [CHILD], { [CHILD]: { status: 'running', message: null } }), collab('completed', 'closeAgent', T0 + 9, [CHILD], { [CHILD]: { status: 'shutdown', message: null } })]);
  assert.deepEqual([only(b.s).state, only(b.s).why, only(b.s).startedAt, only(b.s).endedAt], ['ended', 'shutdown', null, T0 + 9]);
});

test('the root idle is not the end of a sub-agent: its approval still comes, as measured, and a stop then sends no interrupt at all', async () => {
  const { m, s, approvals, play } = await session();
  await play(V2_TO_APPROVAL);
  await play([{ method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } }]);
  assert.equal(s.state, 'idle');
  assert.equal(only(s).state, 'running');
  m.send(childApproval(0));
  await settle();
  assert.equal(approvals.list().length, 1);
  const r = await s.interrupt();
  await settle();
  assert.equal(r.denied, 1);
  assert.deepEqual(m.sent().filter((x) => x.method === 'turn/interrupt'), []);
  assert.deepEqual(noteStates(s), ['members-running=1']);
  assert.deepEqual(only(s).asks, []);
  // Measured too: its completion comes on the root thread under the root turn that already ended.
  await play(V2_FROM_APPROVAL);
  assert.equal(only(s).state, 'returned');
});

test('fail() runs before the thread has an id, so no member can be lost there: what another thread sends first makes none', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: T0 });
  const m = memPipe(null);
  const started = startCodexSession({ ownedId: OWNED, cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals: new Approvals({ hub: clock, settleMs: 0 }), now: () => clock.wall, redact, hub: clock });
  assert.ok(started.ok);
  m.send(statusOf('active'));
  m.send(activity('started', 'started', T0));
  await opening(m, 'never')();
  assert.equal(await started.session.ready, false);
  assert.deepEqual([started.session.state, started.session.endReason, started.session.members], ['failed', 'policy-mismatch', []]);
});

test('the session goes while a member is live: unknown, never running, whichever way it went; one that reported stays returned', async () => {
  const cases: [string, (x: Awaited<ReturnType<typeof session>>) => void | Promise<unknown>][] = [
    ['end', (x) => {
      x.s.end();
    }],
    ['exit', (x) => {
      x.m.close(1);
    }],
    ['brake', (x) => x.s.brake()],
  ];
  for (const [how, go] of cases) {
    const x = await session({ name: `orchestra-job-${'d'.repeat(32)}`, endTree: async () => ({ ok: true, found: true, killed: 2, left: 0 }) });
    await x.play([activity('started', 'started', T0), childTurn('turn/started'), activity('started', 'started', T0, 'thread-two', '/root/two'), statusOf('idle', 'thread-two'), activity('started', 'completed', T0 + 5, 'thread-three', '/root/three')]);
    x.m.send(childApproval(0));
    await settle();
    await go(x);
    await settle();
    assert.deepEqual(x.s.members.map((m) => [m.name, m.state, m.endedAt, m.asks.length]), [['/root/ping_once', 'unknown', null, 0], ['/root/two', 'unknown', null, 0], ['/root/three', 'returned', T0 + 5, 0]], how);
    const tower = towerOf([seatOf(x.s)]);
    assert.deepEqual(validateTower(tower).errors, [], how);
    const kids = memberRows(tower.projects[0]!.nodes);
    assert.deepEqual(kids.map((n) => [n.state, n.basis, n.durationMs]), [['unknown', 'none', null], ['unknown', 'none', null], ['returned', 'owned', null]], how);
    assert.equal(kids[0]!.activity, '会话结束时它还没回报，现在怎样不知道');
    // Late frames change nothing: the session no longer listens.
    await x.play([childTurn('turn/started', { id: 'late' })]);
    assert.equal(x.s.members[0]!.state, 'unknown', how);
  }
});

test('out of order and with fields missing: unknown where nothing says, never a throw, and a report is not undone', async () => {
  // The turn's end read before anything else, then what should have come first.
  const a = await session();
  await a.play([childTurn('turn/completed'), childTurn('turn/started'), activity('started', 'started', T0), statusOf('active', CHILD, [])]);
  assert.deepEqual([only(a.s).state, only(a.s).startedAt, only(a.s).endedAt, only(a.s).name], ['returned', SECS0 * 1000, (SECS0 + 16) * 1000, '/root/ping_once']);

  // A thread nobody announced says nothing of itself: known to exist, state unknown, name and times too.
  const b = await session();
  await b.play([{ method: 'thread/tokenUsage/updated', params: { threadId: CHILD } }]);
  assert.deepEqual([only(b.s).state, only(b.s).name, only(b.s).startedAt, only(b.s).endedAt], ['unknown', null, null, null]);
  const tower = towerOf([seatOf(b.s)], T0 + 9_000);
  assert.deepEqual(validateTower(tower).errors, []);
  const n = tower.projects[0]!.nodes[1]!;
  assert.deepEqual([n.state, n.basis, n.title, n.activity, n.durationMs], ['unknown', 'none', '子代理（名字未知）', '还没听到它的状态', null]);

  // Junk where the fields should be: nothing throws, nothing moves the root, no member from what is no id.
  const c = await session();
  await c.play([
    { method: 'item/started', params: { threadId: ROOT, item: { type: 'subAgentActivity' } } },
    { method: 'item/started', params: { threadId: ROOT, item: { type: 'subAgentActivity', agentThreadId: 7, kind: 'started' } } },
    { method: 'item/started', params: { threadId: ROOT, item: { type: 'subAgentActivity', agentThreadId: ROOT, kind: 'completed' } } },
    { method: 'item/completed', params: { threadId: ROOT, item: { type: 'collabAgentToolCall', receiverThreadIds: 'x', agentsStates: [1] } } },
    { method: 'item/completed', params: { threadId: ROOT, item: { type: 'collabAgentToolCall', receiverThreadIds: [null, 'x'.repeat(CODEX_SESSION_LIMITS.idChars + 1)], agentsStates: null } } },
    { method: 'item/completed', params: { threadId: ROOT, item: null } },
    { method: 'turn/started', params: { threadId: 'x'.repeat(CODEX_SESSION_LIMITS.idChars + 1), turn: { id: 't' } } },
  ]);
  assert.deepEqual(c.s.members, []);
  assert.equal(c.s.state, 'running');

  const d = await session();
  await d.play([
    { method: 'item/started', params: { threadId: ROOT, item: { type: 'subAgentActivity', agentThreadId: CHILD, kind: 'somethingNew', agentPath: 5 } } },
    { method: 'thread/status/changed', params: { threadId: CHILD } },
    { method: 'thread/status/changed', params: { threadId: CHILD, status: { type: 'whatever' } } },
    { method: 'turn/completed', params: { threadId: CHILD } },
    { method: 'turn/started', params: { threadId: CHILD } },
    { method: 'turn/completed', params: { threadId: CHILD, turn: { status: 'somethingNew', startedAt: 'soon', completedAt: -1 } } },
  ]);
  assert.deepEqual([only(d.s).state, only(d.s).why, only(d.s).startedAt, only(d.s).endedAt], ['unknown', null, null, null]);
  assert.deepEqual(validateTower(towerOf([seatOf(d.s)])).errors, []);

  // A name that is only space, or redacted away into nothing, is no name; a redacted one is shown redacted.
  const e = await session();
  await e.play([activity('started', 'started', T0, CHILD, ' \t\n '), activity('completed', 'started', T0, CHILD, '/root/ghp_SECRET\u202e\nx')]);
  assert.equal(only(e.s).name, '/root/[redacted]\\u202E x');
});

test('a request from a thread that has no name yet, of any kind, still says it is a sub-agent\'s', async () => {
  const { m, s, approvals } = await session();
  m.send({ id: 5, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-abcdefgh', turnId: 't', itemId: 'fc', reason: 'x' } });
  await settle();
  assert.equal(approvals.list()[0]!.preview.split('\n')[0], 'from subagent: name unknown (thread …abcdefgh)');
  assert.deepEqual([only(s).state, only(s).asks.length], ['running', 1]);
  // Codex settles it itself: the member's open approval goes with the card.
  m.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-abcdefgh', requestId: 5 } });
  await settle();
  assert.deepEqual(only(s).asks, []);
  // The session's own request says nothing of the kind.
  m.send({ id: 6, method: 'item/commandExecution/requestApproval', params: { threadId: ROOT, turnId: 'turn-root', itemId: 'mine', command: 'ping', cwd: CWD } });
  await settle();
  assert.equal(approvals.list()[0]!.preview.startsWith('from subagent'), false);
});

test('past the bound a member is counted, once, and said: in the feed, on its session\'s row and in the snapshot; its card still comes', async () => {
  const { m, s, approvals, play } = await session();
  const L = CODEX_SESSION_LIMITS.members;
  const threads = Array.from({ length: L + 2 }, (_, i) => `thread-${i}`);
  await play(threads.map((t) => activity('started', 'started', T0, t, `/root/${t}`)));
  await play([childTurn('turn/started', {}, threads[L]!), statusOf('idle', threads[L]!)]);
  assert.deepEqual([s.members.length, s.membersOver], [L, 2]);
  assert.deepEqual(noteStates(s), ['members-over=2']);
  const node = ownedNode(seatOf(s), T0);
  assert.equal(node.counts.children, L, 'the count is the list\'s length (T3)');
  assert.equal(node.activity, '另有 2 个子代理超出上限，没列出');
  const tower = towerOf([seatOf(s)]);
  assert.deepEqual(validateTower(tower).errors, []);
  assert.equal(tower.meta.clipped.nodes, 2);
  assert.equal(memberRows(tower.projects[0]!.nodes).length, L);
  m.send({ ...childApproval(0), params: { ...childApproval(0).params, threadId: threads[L] } });
  await settle();
  assert.equal(approvals.list()[0]!.preview.split('\n')[0], `from subagent: name unknown (thread …${threads[L]!.slice(-8)})`);
  assert.equal(s.membersOver, 2);
});

test('the registry keeps the members: states and times only; after a restart what was live is unknown, and the session keeps its children', async () => {
  const files = new Map<string, string>();
  const registry = makeOwnedRegistry({ dir: 'C:\\o\\owned', writeAtomic: (f, t) => files.set(f, t), readdir: () => [...files.keys()].map((f) => f.split('\\').pop()!), readFile: (f) => files.get(f)! });
  const base = { v: 1 as const, ownedId: OWNED, harness: 'codex' as const, model: DEFAULT_CODEX_MODEL, title: 't', createdAt: 5, state: 'running' as const, endReason: null };
  const row = (over = {}) => ({ threadId: CHILD, name: '/root/a', model: DEFAULT_CODEX_MODEL, state: 'running' as const, why: null, startedAt: T0, endedAt: null, failed: 1, ranUnasked: 2, ...over });
  registry.save({ ...base, members: [row(), row({ threadId: 'b', state: 'idle' }), row({ threadId: 'c', state: 'returned', endedAt: T0 + 1 }), row({ threadId: 'd', state: 'ended', why: 'failed' })], membersOver: 3 });
  const [loaded] = registry.load();
  assert.deepEqual([loaded!.members![0]!.model, loaded!.members![0]!.ranUnasked], [DEFAULT_CODEX_MODEL, 2]);
  const after = afterRestart(loaded!);
  assert.deepEqual([after.state, after.endReason], ['unknown', 'daemon-restart']);
  assert.deepEqual(after.members!.map((m) => m.state), ['unknown', 'unknown', 'returned', 'ended']);
  const restored = restoredSession(after, () => 9);
  assert.deepEqual([restored.members.map((m) => m.lastAt), restored.members.map((m) => m.asks.length), restored.membersOver], [[null, null, null, null], [0, 0, 0, 0], 3]);
  const seat = { ...seatOf(restored), state: 'unknown' as const, lastAt: null };
  const tower = towerOf([seat]);
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual(memberRows(tower.projects[0]!.nodes).map((n) => [n.state, n.ageMs]), [['unknown', null], ['unknown', null], ['returned', null], ['ended', null]]);
  assert.equal(tower.projects[0]!.nodes[0]!.counts.children, 4);

  // An ended session whose file still says a member ran (its last write failed): unknown too, and it is saved again.
  const ended = afterRestart({ ...base, state: 'ended', endReason: 'you-ended', members: [row()], membersOver: 0 });
  assert.deepEqual([ended.state, ended.endReason, ended.members![0]!.state], ['ended', 'you-ended', 'unknown']);
  const settled = { ...base, state: 'ended' as const, endReason: 'you-ended', members: [row({ state: 'returned' })], membersOver: 0 };
  assert.equal(afterRestart(settled), settled, 'nothing to change: the same record, not written again');

  // The harness that is off lists them too.
  const off = restoredOwned('codex', registry, () => 9, restoredSession);
  assert.deepEqual(off.towerSeats()[0]!.members!.map((m) => m.state), ['unknown', 'unknown', 'returned', 'ended']);

  // A file of an earlier build, or of a session without members, reads as it did.
  assert.equal(parseOwnedRecord(JSON.stringify(base))?.members, undefined);
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [] })), null, 'one of the two keys is no file of this build');
  for (const bad of [{ ...row(), extra: 1 }, row({ state: 'gone' }), row({ state: 'ended' }), row({ why: 'failed' }), row({ name: '' }), row({ startedAt: -1 }), row({ failed: 'x' }), row({ model: '' }), row({ model: 7 }), row({ model: 'x'.repeat(REGISTRY_LIMITS.memberModelBytes + 1) }), row({ ranUnasked: -1 }), row({ ranUnasked: null }), 7]) {
    assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [bad], membersOver: 0 })), null, JSON.stringify(bad));
  }
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [row(), row()], membersOver: 0 })), null, 'a thread listed twice');
  // The worst this build can write fits its own bound.
  const fat = Array.from({ length: REGISTRY_LIMITS.members }, (_, i) => row({ threadId: `${i}`.padEnd(REGISTRY_LIMITS.memberIdChars, 'x'), name: '"'.repeat(REGISTRY_LIMITS.memberNameBytes), model: '"'.repeat(REGISTRY_LIMITS.memberModelBytes), state: 'ended', why: 'interrupted', endedAt: T0 }));
  registry.save({ ...base, members: fat, membersOver: 1 });
  assert.equal(registry.load()[0]!.members!.length, REGISTRY_LIMITS.members);
});

test('the tower: members fold and count like read-only subagents, ids are stable, the time fields stay out of rev, and a member never waits', () => {
  const seat: OwnedSeat = {
    ownedId: OWNED, harness: 'codex', title: 'a session', state: 'running', endReason: null, waiting: null, lastAt: 9_000,
    members: [
      member(1), member(2), member(3, { state: 'running', endedAt: null, lastAt: 8_000 }), member(4, { state: 'ended', why: 'shutdown' }),
      member(5, { state: 'idle', endedAt: null }), member(6, { state: 'unknown', startedAt: null, endedAt: null, name: null, lastAt: null }), member(7, { startedAt: 5_000, endedAt: 4_000 }),
    ],
    membersOver: 0,
  };
  const t = towerOf([seat]);
  assert.deepEqual(validateTower(t).errors, []);
  const p = t.projects[0]!;
  const root = p.nodes[0]!;
  assert.deepEqual([root.counts, root.groups.map((g) => [g.kind, g.count])], [{ children: 7, errors: 0, waiting: 0 }, [['returned', 3]]]);
  assert.deepEqual(p.nodes.slice(1).map((n) => n.state), ['running', 'unknown', 'returned', 'returned', 'returned', 'idle', 'ended']);
  const by = new Map(p.nodes.map((n) => [n.title, n]));
  assert.equal(by.get('/root/m3')!.durationMs, 9_000, 'running: so far');
  assert.equal(by.get('/root/m3')!.ageMs, 2_000);
  assert.equal(by.get('/root/m1')!.durationMs, 3_000);
  assert.equal(by.get('/root/m5')!.durationMs, null, 'idle with no end: cannot be told');
  assert.equal(by.get('/root/m7')!.durationMs, null, 'an end before its start: cannot be told');
  assert.equal(by.get('子代理（名字未知）')!.durationMs, null);
  assert.equal(by.get('/root/m4')!.activity, '已结束：被关掉了，没有回报');
  assert.equal(t.tally.returned >= 3 && t.tally.ended >= 1, true);
  assert.equal(new Set(p.nodes.map((n) => n.id)).size, p.nodes.length);
  assert.equal(towerOf([seat], 90_000).meta.rev, t.meta.rev, 'unchanged data, unchanged rev, while a member runs');
  assert.equal(ownedProject([{ ...seat, members: [] }], 10_000)!.nodes.length, 1);
  // A seat that says a member runs after its session went (nothing should, T1): the tower still says unknown.
  const late = towerOf([{ ...seat, state: 'ended', endReason: 'you-ended', members: [member(1, { state: 'running', endedAt: null })] }]);
  assert.deepEqual(validateTower(late).errors, []);
  assert.deepEqual([late.projects[0]!.nodes[1]!.state, late.projects[0]!.nodes[1]!.durationMs], ['unknown', null]);

  const waiting = structuredClone(towerOf([seat])) as any;
  const kid = waiting.projects[0].nodes[1];
  kid.state = 'waiting';
  kid.waiting = { kind: 'approval', source: 'orchestra', deadline: 5 };
  waiting.waitingBar.unshift({ node: kid.id, kind: 'approval', source: 'orchestra', deadline: 5 });
  waiting.tally.running--;
  waiting.tally.waiting++;
  assert.ok(validateTower(waiting).errors.some((e) => e.includes('the wait of an owned sub-agent is on its session')), validateTower(waiting).errors.join('\n'));
});

test('the page takes a member for no session of its own: no feed, no dock; the session node stays one', () => {
  const nodes = ownedProject([{ ownedId: OWNED, harness: 'codex', title: 't', state: 'idle', endReason: null, waiting: null, lastAt: 1, members: [member(1)], membersOver: 0 }], 2)!.nodes;
  assert.deepEqual(nodes.map((n) => ownedIdOf(n)), [OWNED, null]);
});

test('thread/read that fails, or says nothing: the member stays unnamed, and it is not asked again', async () => {
  const { m, s, play } = await session();
  await play([childTurn('turn/started')]);
  const id = m.sent().find((x) => x.method === 'thread/read')!.id;
  m.send({ id, error: { code: -32600, message: 'no such thread' } });
  await play([childTurn('turn/completed'), childTurn('turn/started', { id: `${CHILD_TURN}-2` })]);
  assert.equal(only(s).name, null);
  assert.equal(m.sent().filter((x) => x.method === 'thread/read').length, 1);
  assert.equal(feedText(s).includes('no such thread'), false);
});

test('a sub-agent\'s file change: announced on its thread, its card shows it and can be allowed, even after the root turn ended; nothing of it reaches the feed', async () => {
  const root = await session();
  await root.play([fileChange('started', ROOT)]);
  root.m.send(fileAsk(7, ROOT));
  await settle();
  const own = root.approvals.list()[0]!;
  assert.deepEqual([own.title, own.canAccept, own.preview], ['1 file change', true, '--- update a.txt\n+x']);

  const { m, s, approvals, play } = await session();
  await play([activity('started', 'started', T0), childTurn('turn/started'), fileChange('started', CHILD)]);
  // Measured: the root's turn can end first. Its items go; the member's change must not.
  await play([{ method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } }]);
  m.send(fileAsk(7, CHILD));
  await settle();
  const card = approvals.list()[0]!;
  assert.deepEqual([card.title, card.canAccept, card.risk], ['1 file change', true, 'write']);
  assert.equal(card.preview, `from subagent: /root/ping_once (thread …${CHILD.slice(-8)})\n--- update a.txt\n+x`);
  assert.equal(feedText(s).includes('a.txt'), false);
  assert.equal(s.feed.since(0).events.filter((e) => e.kind === 'ask').at(-1)!.text, `/root/ping_once (thread …${CHILD.slice(-8)}): 1 file change`);
  assert.equal(approvals.allow(card.approvalId, { digest: card.digest, rev: approvals.rev }), 'ok');
  assert.deepEqual(m.sent().at(-1), { id: 7, result: { decision: 'accept' } });
  await play([fileChange('completed', CHILD, 'completed')]);
  assert.equal(only(s).ranUnasked, 0, 'it was asked about');
});

test('a sub-agent\'s file change is judged like the session\'s: a protected row is refused without a card, a guarded path and one outside the work dir hold the card', async () => {
  const judge: PathJudge = (p) => ({ real: p, hit: p.includes('secretdir') ? 'data-dir' : null });
  const { m, s, approvals, play } = await session(null, { judge });
  await play([fileChange('started', CHILD, 'inProgress', 'a', [{ path: 'C:\\secretdir\\x', kind: { type: 'add' }, diff: '+' }])]);
  m.send(fileAsk(1, CHILD, 'a'));
  await settle();
  assert.equal(approvals.list().length, 0);
  assert.deepEqual(m.sent().at(-1), { id: 1, result: { decision: 'decline' } });
  await play([fileChange('started', CHILD, 'inProgress', 'b', [{ path: 'package.json', kind: { type: 'update' }, diff: '+' }]), fileChange('started', CHILD, 'inProgress', 'c', [{ path: 'C:\\elsewhere\\x', kind: { type: 'add' }, diff: '+' }])]);
  m.send(fileAsk(2, CHILD, 'b'));
  m.send(fileAsk(3, CHILD, 'c'));
  await settle();
  const [guarded, away] = approvals.list();
  assert.deepEqual([guarded!.risk, guarded!.preview.includes('protected path'), away!.risk, away!.preview.includes('(outside the work dir) C:\\elsewhere\\x')], ['protected', true, 'protected', true]);
  assert.equal(s.members.length, 1);
});

test('a sub-agent\'s file change Orchestra holds nothing of: only a refusal, and the card does not say codex never announced it', async () => {
  const { m, approvals, play } = await session();
  // An item of the root under the same id is not the member's, and its row is not touched.
  await play([fileChange('started', ROOT)]);
  m.send(fileAsk(1, CHILD));
  await settle();
  const none = approvals.list()[0]!;
  assert.deepEqual([none.title, none.canAccept], ['file change', false]);
  assert.equal(none.preview.split('\n')[1], 'Orchestra holds no announcement of these changes: only a refusal is offered');
  // Past the bound the oldest goes: its card says the same, the newest still shows.
  const b = await session();
  const n = CODEX_SESSION_LIMITS.memberChanges;
  await b.play(Array.from({ length: n + 1 }, (_, i) => fileChange('started', CHILD, 'inProgress', `f${i}`)));
  b.m.send(fileAsk(1, CHILD, 'f0'));
  b.m.send(fileAsk(2, CHILD, `f${n}`));
  await settle();
  assert.deepEqual(b.approvals.list().map((a) => a.canAccept), [false, true]);
  // A turn of its that ended takes its changes along; another thread's stay.
  const c = await session();
  await c.play([fileChange('started', CHILD), fileChange('started', 'thread-two'), childTurn('turn/completed')]);
  c.m.send(fileAsk(1, CHILD));
  c.m.send(fileAsk(2, 'thread-two'));
  await settle();
  assert.deepEqual(c.approvals.list().map((a) => a.canAccept), [false, true]);
  // An item that ended is no longer held either.
  const d = await session();
  await d.play([fileChange('started', CHILD), fileChange('completed', CHILD, 'declined')]);
  d.m.send(fileAsk(1, CHILD));
  await settle();
  assert.equal(d.approvals.list()[0]!.canAccept, false);
  // A thread past the bound has no member, and its card is as good as any.
  const e = await session();
  const L = CODEX_SESSION_LIMITS.members;
  await e.play([...Array.from({ length: L }, (_, i) => statusOf('active', `thread-${i}`)), fileChange('started', 'thread-past')]);
  e.m.send(fileAsk(1, 'thread-past'));
  await settle();
  assert.deepEqual([e.s.membersOver, e.approvals.list()[0]!.canAccept], [1, true]);
});

test('a same item id on two threads: a member\'s request neither hides the root\'s row nor marks the root\'s item asked', async () => {
  const { m, s, approvals, play } = await session();
  await play([{ method: 'item/started', params: { threadId: ROOT, turnId: 't', item: { type: 'commandExecution', id: 'e1', command: 'mine', status: 'inProgress' } } }]);
  m.send({ ...childApproval(0), params: { ...childApproval(0).params, itemId: 'e1' } });
  await settle();
  assert.equal(approvals.list().length, 1);
  assert.equal(s.feed.since(0).events.some((e) => e.kind === 'tool' && e.ref === 'e1'), true, 'the root\'s row stays');
  await play([{ method: 'item/completed', params: { threadId: ROOT, turnId: 't', item: { type: 'commandExecution', id: 'e1', command: 'mine', status: 'completed', aggregatedOutput: '', exitCode: 0 } } }]);
  assert.deepEqual(noteStates(s), ['ran-unasked=mine']);
});

test('an automatic refusal of a sub-agent\'s request says whose it was: in the feed, and in what the tower reads from it', async () => {
  const judge: PathJudge = (p) => ({ real: p, hit: p.includes('guarded') ? 'protected-row' : null });
  const { m, s, approvals, play } = await session(null, { judge });
  await play([activity('started', 'started', T0)]);
  m.send({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: CHILD, itemId: 'e1', command: 'del everything', cwd: 'C:/guarded/x' } });
  await settle();
  assert.equal(approvals.list().length, 0);
  assert.deepEqual(m.sent().at(-1), { id: 3, result: { decision: 'decline' } });
  const said = `/root/ping_once (thread …${CHILD.slice(-8)}): del everything (protected-row)`;
  assert.equal(s.feed.since(0).events.find((e) => e.kind === 'auto-denied')?.text, said);
  assert.deepEqual(recentOf(s.feed), { kind: 'auto-denied', text: said });
  assert.equal(towerOf([{ ...seatOf(s), recent: recentOf(s.feed) }], T0).projects[0]!.nodes[0]!.activity, `自动拒绝了：${said}`);
  // The session's own says nothing of the kind.
  m.send({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: ROOT, itemId: 'e2', command: 'mine', cwd: 'C:/guarded/x' } });
  await settle();
  assert.equal(s.feed.since(0).events.filter((e) => e.kind === 'auto-denied').at(-1)!.text, 'mine (protected-row)');
  // A refused step that codex then reports is one it asked about: not counted as unasked.
  await play([{ method: 'item/completed', params: { threadId: CHILD, turnId: 't', item: { type: 'commandExecution', id: 'e1', status: 'declined' } } }]);
  assert.equal(only(s).ranUnasked, 0);
});

test('a sub-agent\'s step that ran though codex never asked: counted on it and said in the feed, without a word of it', async () => {
  const { m, s, play } = await session();
  await play([activity('started', 'started', T0), childTurn('turn/started'), ...ran(CHILD, 'e9')]);
  assert.equal(only(s).ranUnasked, 1);
  assert.deepEqual(noteStates(s), ['members-ran-unasked=1']);
  assert.equal(feedText(s).includes(CHILD_WORDS), false);
  assert.equal(s.feed.since(0).events.some((e) => e.kind === 'tool' || e.kind === 'tool-result'), false, 'no row of it');
  assert.equal(towerOf([seatOf(s)]).projects[0]!.nodes[1]!.activity, '其中 1 步没来问就跑了');

  // A failed one ran too, and counts as both; a file change counts; one declined did not run.
  await play([...ran(CHILD, 'e10', 'failed'), fileChange('started', CHILD, 'inProgress', 'fc2'), fileChange('completed', CHILD, 'completed', 'fc2'), ...ran(CHILD, 'e11', 'declined')]);
  assert.deepEqual([only(s).ranUnasked, only(s).failed], [3, 1]);
  assert.deepEqual(noteStates(s), ['members-ran-unasked=3'], 'one line, its count the latest');
  assert.equal(towerOf([seatOf(s)]).projects[0]!.nodes[1]!.activity, '其中 3 步没来问就跑了；其中 1 步失败');

  // One codex asked about is not counted, however it was answered, even across the end of the root's turn.
  await play([childCommand('started', T0, 'inProgress')]);
  m.send(childApproval(0));
  await settle();
  await play([{ method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } }, childCommand('completed', T0, 'completed', 0)]);
  assert.equal(only(s).ranUnasked, 3);

  // A thread past the bound has no node to count it on: the feed still does.
  const b = await session();
  const L = CODEX_SESSION_LIMITS.members;
  await b.play([...Array.from({ length: L }, (_, i) => statusOf('active', `thread-${i}`)), ...ran('thread-past', 'e1')]);
  assert.equal(b.s.members.reduce((n, x) => n + x.ranUnasked, 0), 0);
  assert.deepEqual(noteStates(b.s), ['members-over=1', 'members-ran-unasked=1']);
});

test('a sub-agent\'s model: kept as codex said it, unknown when it did not; one outside the owned list is said, by the node and the feed, and is not stopped', async () => {
  const { s, play } = await session();
  await play(V2_TO_APPROVAL);
  assert.equal(only(s).model, DEFAULT_CODEX_MODEL);
  assert.deepEqual(noteStates(s), [], 'on the list: nothing to say');
  const on = towerOf([seatOf(s)]).projects[0]!.nodes[1]!;
  assert.deepEqual([on.model, on.activity], [DEFAULT_CODEX_MODEL, null]);

  const v1 = await session();
  await v1.play(V1_TO_APPROVAL);
  assert.equal(only(v1.s).model, null);
  assert.equal(towerOf([seatOf(v1.s)]).projects[0]!.nodes[1]!.model, null);
  assert.deepEqual(noteStates(v1.s), []);

  const off = (kind: string, model: unknown): Frame => ({ method: 'item/started', params: { threadId: ROOT, turnId: ROOT_TURN, startedAtMs: T0, item: { type: 'subAgentActivity', id: 'x', kind, agentThreadId: CHILD, agentPath: '/root/a', model } } });
  const b = await session();
  await b.play([off('started', 'gpt-6-astra'), off('completed', null), off('started', 'codex/gpt-6.1-sol')]);
  assert.equal(only(b.s).model, 'gpt-6-astra', 'the first it said stands');
  assert.deepEqual(noteStates(b.s), [`member-off-list=/root/a (thread …${CHILD.slice(-8)}): gpt-6-astra`]);
  assert.equal(b.s.state, 'running', 'nothing stops it');
  const tower = towerOf([seatOf(b.s)]);
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual([tower.projects[0]!.nodes[1]!.model, tower.projects[0]!.nodes[1]!.activity], ['gpt-6-astra', '用了名单外的型号：gpt-6-astra']);

  // A spawn call that names one (v1), redacted like every text; what is no string or nothing is no model.
  const c = await session();
  await c.play([{ method: 'item/completed', params: { threadId: ROOT, turnId: ROOT_TURN, completedAtMs: T0, item: { type: 'collabAgentToolCall', id: 'c', tool: 'spawnAgent', status: 'completed', receiverThreadIds: [CHILD], agentsStates: {}, model: 'ghp_SECRET\n$& x' } } }]);
  assert.equal(only(c.s).model, '[redacted] $& x');
  assert.equal(towerOf([seatOf(c.s)]).projects[0]!.nodes[1]!.activity, '用了名单外的型号：[redacted] $& x；还没听到它的状态', 'a model is no replacement pattern');
  const d = await session();
  await d.play([off('started', 7), off('started', ' \n ')]);
  assert.equal(only(d.s).model, null);
});

test('a tainted session says once that its sub-agents\' policy was not measured; a plain one says nothing of it', async () => {
  const { s, play } = await session(null, { tainted: true });
  await play([activity('started', 'started', T0), activity('started', 'started', T0, 'thread-two', '/root/two')]);
  assert.deepEqual(noteStates(s), ['members-untrusted']);
  const plain = await session();
  await plain.play([activity('started', 'started', T0)]);
  assert.deepEqual(noteStates(plain.s), []);
});

test('the production path: CodexOwned writes the members as they move, towerSeats hands them on with who asks, and a new CodexOwned lists them again', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: T0 + 1_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const files = new Map<string, string>();
  const registry = makeOwnedRegistry({ dir: 'C:\\o\\owned', writeAtomic: (f, t) => files.set(f, t), readdir: () => [...files.keys()].map((f) => f.split('\\').pop()!), readFile: (f) => files.get(f)! });
  const m = memPipe(null);
  const make = () => new CodexOwned({ approvals, makeWorkDir: () => CWD, launch: () => m.pipe, now: () => clock.wall, redact, hub: clock, registry });
  const owned = make();
  const made = owned.create();
  assert.ok(made.ok);
  await opening(m)();
  assert.equal(await made.session.ready, true);
  m.send({ method: 'turn/started', params: { threadId: ROOT, turn: { id: ROOT_TURN } } });
  await settle();
  assert.equal(registry.load()[0]!.members, undefined, 'none yet: the file stays as it was');

  for (const f of V2_TO_APPROVAL) m.send(f);
  m.send(childApproval(0));
  await settle();
  const seats = owned.towerSeats();
  assert.deepEqual(seats[0]!.members!.map((x) => [x.name, x.state, x.asking]), [['/root/ping_once', 'running', 'ping']]);
  const tower = towerFromStage(busyStage(), { seats, nowWall: clock.wall });
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual(memberRows(tower.projects[0]!.nodes).map((n) => [n.title, n.activity]), [['/root/ping_once', '在等你审批：ping']]);
  assert.deepEqual(registry.load()[0]!.members!.map((x) => [x.name, x.model, x.state]), [['/root/ping_once', DEFAULT_CODEX_MODEL, 'running']], 'on disk, though the session\'s own state did not move');

  // A member's move alone reaches the disk too, and the fields kept only in memory do not.
  m.send(activity('started', 'completed', T0 + 9_000));
  await settle();
  const kept = registry.load()[0]!.members![0]!;
  assert.deepEqual([made.session.state, kept.state, kept.endedAt], ['running', 'returned', T0 + 9_000]);
  assert.deepEqual(Object.keys(kept).filter((k) => k === 'asks' || k === 'lastAt' || k === 'asking'), []);
  m.send(activity('started', 'started', T0, 'thread-two', '/root/two'));
  await settle();

  // Nobody ended it: the next orchestrad finds it unknown, with its children, and what ran is unknown too.
  const next = make();
  assert.deepEqual(next.towerSeats()[0]!.members!.map((x) => [x.name, x.state, x.lastAt, x.asking]), [['/root/ping_once', 'returned', null, null], ['/root/two', 'unknown', null, null]]);
  assert.deepEqual(registry.load()[0]!.members!.map((x) => x.state), ['returned', 'unknown'], 'and it says so on disk');
  assert.equal(next.get(made.ownedId)!.state, 'unknown');
  owned.endAll();
});
