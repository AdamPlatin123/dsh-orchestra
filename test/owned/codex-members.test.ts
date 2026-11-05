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
import { CODEX_DEADLINES, CODEX_SESSION_LIMITS, startCodexSession } from '../../src/owned/codex-session.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { REGISTRY_LIMITS, afterRestart, makeOwnedRegistry, parseOwnedRecord } from '../../src/owned/registry.ts';
import { restoredOwned } from '../../src/owned/restored.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { memberNodeId, ownedNode, ownedProject, towerFromStage } from '../../src/sources/tower.ts';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { describeChat, mergeFeed, ownedIdOf } from '../../ui/owned.js';
import { busyStage } from '../helpers/tower-fixture.ts';
import {
  CHILD, CHILD_TURN, CHILD_WORDS, ROOT, ROOT_STOP_CLEANED, ROOT_STOP_INTERRUPTED, ROOT_TURN, SECS0, STOP_CLEANED, STOP_INTERRUPTED, T0, V1_FROM_APPROVAL, V1_TO_APPROVAL, V2_FROM_APPROVAL, V2_TO_APPROVAL,
  activity, childApproval, childCommand, childTurn, collab, resolved, rootCommand, rootItem, spawnV2, statusOf,
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
const noteStates = (s: CodexSession) => s.feed.since(0).events.filter((e) => e.kind === 'note' && e.state !== 'dispatch').map((e) => `${e.state}${e.text === null ? '' : `=${e.text}`}`);
const seatOf = (s: CodexSession, over: Partial<OwnedSeat> = {}): OwnedSeat => ({
  ownedId: OWNED, harness: 'codex', title: 'a session', state: s.state, endReason: s.endReason, waiting: null, lastAt: s.feed.lastAt, ...memberSeats(s), ...over,
});
const member = (n: number, over: Partial<OwnedMember> = {}): OwnedMember => ({
  threadId: `thread-${n}`, name: `/root/m${n}`, model: null, state: 'returned', why: null, startedAt: 1_000, endedAt: 4_000, lastAt: 4_000, failed: 0, ranUnasked: 0, batch: null, asking: null, ...over,
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

/** What a stop sends, in order, as [method, threadId, turnId]; the root's terminals are rootSent's. */
const allSent = (m: ReturnType<typeof memPipe>) => m.sent().filter((x) => /^(turn\/interrupt|thread\/backgroundTerminals\/)/.test(x.method ?? '')).map((x) => [x.method, x.params.threadId, x.params.turnId]);
const stopSent = (m: ReturnType<typeof memPipe>) => allSent(m).filter((r) => r[1] !== ROOT || r[0] === 'turn/interrupt');
const rootSent = (m: ReturnType<typeof memPipe>) => allSent(m).filter((r) => r[1] === ROOT);
const CLEAN = 'thread/backgroundTerminals/clean';
const LIST = 'thread/backgroundTerminals/list';

/** The stop requests already answered, per session: a stop of two rounds is played twice. */
const answered = new WeakMap<object, Set<unknown>>();

/**
 * Plays codex's side of a stop already pressed: each request answered as measured, or refused when its method is
 * in `refuse` and it is a member's; `interrupted` comes after the interrupts, `cleaned` after the cleans; `terminals`
 * says how many a thread's list holds, each under `terminal` on the root. No member's list may go out before the pause is
 * over; the root's is read once before its clean too.
 */
async function codexStops(x: Awaited<ReturnType<typeof session>>, o: { interrupted?: readonly Frame[]; cleaned?: readonly Frame[]; terminals?: (threadId: string) => number; terminal?: string; refuse?: readonly string[] } = {}) {
  const done = answered.get(x) ?? new Set<unknown>();
  answered.set(x, done);
  const lists = () => stopSent(x.m).filter((r) => r[0] === LIST).length;
  const listed = lists();
  const answer = async () => {
    await settle();
    for (const r of x.m.sent()) {
      if (done.has(r.id) || !/^(turn\/interrupt|thread\/backgroundTerminals\/)/.test(r.method ?? '')) continue;
      done.add(r.id);
      if (o.refuse?.includes(r.method) && r.params.threadId !== ROOT) x.m.send({ id: r.id, error: { code: -32600, message: 'refused' } });
      else x.m.send({ id: r.id, result: r.method === LIST ? { data: Array.from({ length: o.terminals?.(r.params.threadId) ?? 0 }, () => ({ itemId: r.params.threadId === ROOT ? o.terminal ?? 'exec-root' : 'exec-child', processId: '1', osPid: null })), nextCursor: null } : {} });
    }
    await settle();
  };
  await answer();
  await x.play(o.interrupted ?? []);
  await answer();
  await answer();
  await x.play(o.cleaned ?? []);
  x.clock.advanceBy(CODEX_DEADLINES.stopSettleMs - 1);
  await answer();
  assert.equal(lists(), listed, 'the list is read once the pause is over, not before');
  x.clock.advanceBy(1);
  await answer();
}

/** Whether the list offers the stop for this session, read as the page reads it. */
const stoppable = (x: Awaited<ReturnType<typeof session>>) => {
  const list = ownedList({ codex: { list: () => [x.s], meta: () => null, approvals: x.approvals, maxActive: 3 } as unknown as CodexOwned, claude: null, codexOff: 'on' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  return list.owned[0]!.stoppable;
};
/** A list of one on the member's thread, and none on the root's. */
const childOnly = (threadId: string) => (threadId === ROOT ? 0 : 1);
const ROOT_IDLE: Frame = { method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } };

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

test('a stop, as measured: the member gets its interrupt, then the clean; sent is not stopped, and the state moves only on what comes back', async () => {
  const x = await session();
  const { m, s, approvals, play } = x;
  await play(V2_TO_APPROVAL);
  m.send(childApproval(0));
  await settle();
  assert.equal(approvals.deny(approvals.list()[0]!.approvalId), 'ok');
  await play([resolved(0), statusOf('active', CHILD, [])]);
  await s.interrupt();
  await settle();
  // Nothing has come back: it runs, and the feed says only that the stop went out.
  assert.equal(only(s).state, 'running');
  assert.deepEqual(noteStates(s), ['members-stopping=1']);
  assert.deepEqual(stopSent(m), [['turn/interrupt', ROOT, ROOT_TURN], ['turn/interrupt', CHILD, CHILD_TURN]]);

  await codexStops(x, { interrupted: STOP_INTERRUPTED, cleaned: STOP_CLEANED });
  assert.deepEqual(stopSent(m), [['turn/interrupt', ROOT, ROOT_TURN], ['turn/interrupt', CHILD, CHILD_TURN], [CLEAN, CHILD, undefined], [LIST, CHILD, undefined]]);
  assert.deepEqual([only(s).state, only(s).why, only(s).endedAt], ['ended', 'interrupted', (SECS0 + 10) * 1000]);
  // Its command's end comes after the turn's: not a failed step of its, and it was asked about.
  assert.deepEqual([only(s).failed, only(s).ranUnasked], [0, 0]);
  assert.deepEqual(noteStates(s), ['members-stopped=1'], 'the live note went, and nothing says it ran unasked');
  assert.equal(s.state, 'running', 'what the root\'s turn does is its own');
  assert.equal(feedText(s).includes(CHILD_WORDS), false);
  assert.equal(towerOf([seatOf(s)]).projects[0]!.nodes[1]!.activity, '已结束：被打断了，没有回报');
});

test('a command nobody asked about that a stop ended still counts as run unasked; only its failure is the stop\'s', async () => {
  const x = await session();
  await x.play([activity('started', 'started', T0), childTurn('turn/started'), childCommand('started', T0 + 1, 'inProgress')]);
  await x.s.interrupt();
  await codexStops(x, { interrupted: STOP_INTERRUPTED, cleaned: STOP_CLEANED });
  assert.deepEqual([only(x.s).failed, only(x.s).ranUnasked], [0, 1]);
  assert.deepEqual(noteStates(x.s), ['members-ran-unasked=1', 'members-stopped=1']);
});

test('with the root idle a stop still reaches the member, and no interrupt goes to the root', async () => {
  const x = await session();
  const { m, s, approvals, play } = x;
  await play(V2_TO_APPROVAL);
  await play([{ method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } }]);
  assert.equal(s.state, 'idle');
  assert.equal(only(s).state, 'running');
  m.send(childApproval(0));
  await settle();
  assert.equal(approvals.list().length, 1);
  const r = await s.interrupt();
  assert.equal(r.denied, 1);
  assert.deepEqual(only(s).asks, []);
  await codexStops(x, { interrupted: STOP_INTERRUPTED });
  assert.deepEqual(stopSent(m), [['turn/interrupt', CHILD, CHILD_TURN], [CLEAN, CHILD, undefined], [LIST, CHILD, undefined]]);
  assert.deepEqual([only(s).state, only(s).why, s.state], ['ended', 'interrupted', 'idle']);
  assert.deepEqual(noteStates(s), ['members-stopped=1']);
});

test('the list says a stop has something to reach while a member is live, with the root idle too, and never once the session is over', async () => {
  const x = await session();
  assert.equal(stoppable(x), false);
  await x.play([activity('started', 'started', T0), childTurn('turn/started'), ROOT_IDLE]);
  assert.equal(x.s.state, 'idle');
  assert.equal(stoppable(x), true);
  await x.play(STOP_INTERRUPTED);
  assert.equal(stoppable(x), false);
  await x.play([childTurn('turn/started', { id: 'turn-child-2' })]);
  assert.equal(stoppable(x), true);
  // Ended with a command open: the end of the session is then the only thing that says no.
  await x.play([childCommand('started', T0 + 1, 'inProgress'), childTurn('turn/completed', { id: 'turn-child-2', status: 'interrupted' })]);
  assert.equal(only(x.s).state, 'ended');
  assert.equal(stoppable(x), true);
  x.s.end();
  assert.equal(stoppable(x), false);
});

test('the contract refuses a stop offered on a session that is over', async () => {
  const x = await session();
  const list = ownedList({ codex: { list: () => [x.s], meta: () => null, approvals: x.approvals, maxActive: 3 } as unknown as CodexOwned, claude: null, codexOff: 'on' });
  const over = (stop: boolean) => validateOwnedList({ ...list, limits: { ...list.limits, active: 0 }, owned: [{ ...list.owned[0]!, state: 'ended', endReason: 'you-ended', queued: 0, stoppable: stop }] }).errors;
  assert.deepEqual(over(false), []);
  assert.ok(over(true).some((e: string) => e.includes('stoppable')));
});

test('what did not stop is said and counted: a refused interrupt, a terminal left, an answer that never says none', async () => {
  // Refused: its turn runs on, and it stays running.
  const a = await session();
  await a.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await a.s.interrupt();
  await codexStops(a, { refuse: ['turn/interrupt'] });
  assert.equal(only(a.s).state, 'running');
  assert.deepEqual(noteStates(a.s), ['members-not-stopped=1']);

  // Its turn ended, its command did not: the turn's end alone is not a stop.
  const b = await session();
  await b.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await b.s.interrupt();
  await codexStops(b, { interrupted: STOP_INTERRUPTED, terminals: childOnly });
  assert.deepEqual([only(b.s).state, only(b.s).why], ['ended', 'interrupted']);
  assert.deepEqual(noteStates(b.s), ['members-not-stopped=1']);

  // The list refused: nothing says none is left (T1).
  const c = await session();
  await c.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await c.s.interrupt();
  await codexStops(c, { interrupted: STOP_INTERRUPTED, refuse: [LIST] });
  assert.deepEqual(noteStates(c.s), ['members-not-stopped=1']);

  // One of two: each count is its own.
  const d = await session();
  await d.play([activity('started', 'started', T0), childTurn('turn/started'), activity('started', 'started', T0, 'thread-two', '/root/two'), childTurn('turn/started', { id: 'turn-two' }, 'thread-two')]);
  await d.s.interrupt();
  await codexStops(d, { interrupted: [...STOP_INTERRUPTED, childTurn('turn/completed', { id: 'turn-two', status: 'interrupted' }, 'thread-two')], terminals: (t) => (t === 'thread-two' ? 1 : 0) });
  assert.deepEqual(noteStates(d.s), ['members-stopped=1', 'members-not-stopped=1']);
});

test('a stop counts what it cannot reach: past the bound, of unknown state; one idle has no turn to interrupt and is cleaned, without a word', async () => {
  const c = await session();
  const L = CODEX_SESSION_LIMITS.members;
  const threads = Array.from({ length: L + 8 }, (_, i) => `thread-${i}`);
  await c.play(threads.map((t) => childTurn('turn/started', {}, t)));
  await c.s.interrupt();
  await codexStops(c, { interrupted: threads.map((t) => childTurn('turn/completed', { status: 'interrupted' }, t)) });
  assert.deepEqual(noteStates(c.s), ['members-over=8', `members-stopped=${L}`, 'members-not-stopped=8']);
  assert.equal(stopSent(c.m).filter((r) => r[0] === 'turn/interrupt').length, L + 1, 'the root, and each listed one: of one past the bound no turn is kept');

  const b = await session();
  await b.play([statusOf('idle')]);
  await b.s.interrupt();
  await codexStops(b);
  assert.deepEqual(stopSent(b.m), [['turn/interrupt', ROOT, ROOT_TURN], [CLEAN, CHILD, undefined], [LIST, CHILD, undefined]]);
  assert.deepEqual(noteStates(b.s), [], 'it was not running, so it is not said to have stopped');
  const left = await session();
  await left.play([statusOf('idle')]);
  await left.s.interrupt();
  await codexStops(left, { terminals: childOnly });
  assert.deepEqual(noteStates(left.s), ['members-not-stopped=1'], 'what it left is');

  const u = await session();
  await u.play([{ method: 'thread/tokenUsage/updated', params: { threadId: CHILD } }]);
  await u.s.interrupt();
  await codexStops(u);
  assert.deepEqual(noteStates(u.s), ['members-not-stopped=1'], 'unknown is not stopped');
  assert.deepEqual(stopSent(u.m), [['turn/interrupt', ROOT, ROOT_TURN]]);

  // Nothing to say and nothing to send: every member reported.
  const d = await session();
  await d.play([activity('started', 'started', T0), childTurn('turn/started'), childTurn('turn/completed')]);
  await d.s.interrupt();
  await settle();
  assert.deepEqual(noteStates(d.s), []);
  assert.deepEqual(stopSent(d.m), [['turn/interrupt', ROOT, ROOT_TURN]]);
});

test('a second press while a stop is on its way adds nothing; a press after it starts over', async () => {
  const x = await session();
  await x.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await x.s.interrupt();
  await x.s.interrupt();
  await settle();
  assert.equal(stopSent(x.m).filter((r) => r[1] === CHILD).length, 1);
  await codexStops(x, { refuse: ['turn/interrupt'] });
  assert.deepEqual(noteStates(x.s), ['members-not-stopped=1']);
  await x.s.interrupt();
  await settle();
  assert.equal(stopSent(x.m).filter((r) => r[0] === 'turn/interrupt' && r[1] === CHILD).length, 2, 'it still runs: the next stop goes to it again');
});

test('the session goes while a stop is on its way: its end says the stop went unanswered, and the stop adds nothing, past every deadline of its own', async () => {
  const x = await session();
  await x.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await x.s.interrupt();
  await settle();
  x.s.end();
  await settle();
  // Its interrupt, then its clean, each unanswered to the deadline, then the pause.
  for (const ms of [CODEX_DEADLINES.interruptMs, CODEX_DEADLINES.interruptMs, CODEX_DEADLINES.stopSettleMs]) {
    x.clock.advanceBy(ms);
    await settle();
  }
  assert.ok(stopSent(x.m).some((r) => r[0] === CLEAN), 'it got as far as its clean');
  assert.equal(stopSent(x.m).some((r) => r[0] === LIST), false, 'nobody reads a list of a session that went');
  assert.deepEqual(noteStates(x.s), ['members-stop-unanswered=1', 'children-may-remain']);
  assert.equal(only(x.s).state, 'unknown');

  // Gone while the list is out: its answer says nothing any more.
  const z = await session();
  await z.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await z.s.interrupt();
  await settle();
  const answerAll = async (method: string) => {
    for (const r of z.m.sent().filter((q) => q.method === method)) z.m.send({ id: r.id, result: method === LIST ? { data: [], nextCursor: null } : {} });
    await settle();
  };
  await answerAll('turn/interrupt');
  await answerAll(CLEAN);
  z.clock.advanceBy(CODEX_DEADLINES.stopSettleMs);
  await settle();
  assert.equal(stopSent(z.m).filter((r) => r[0] === LIST).length, 1);
  z.s.end();
  await answerAll(LIST);
  assert.deepEqual(noteStates(z.s), ['members-stop-unanswered=1', 'children-may-remain']);
});

test('a page that polled between the press and the result ends up with what a page that opens later reads', async () => {
  /** What the chat shows of the stop: its words, and whether they stand as live. */
  const said = (f: ReturnType<typeof mergeFeed>) => describeChat(f).kids.filter((k: any) => k.data?.kind === 'note').map((k: any) => [k.slots.tx.text, k.data.live]);
  const press = async () => {
    const x = await session();
    await x.play([activity('started', 'started', T0), childTurn('turn/started')]);
    await x.s.interrupt();
    const f = mergeFeed(undefined, x.s.feed.since(0));
    assert.deepEqual(said(f), [['已对 1 个子代理发出停止，还没确认', '1']]);
    return { x, f };
  };

  const a = await press();
  await codexStops(a.x, { interrupted: STOP_INTERRUPTED, cleaned: STOP_CLEANED });
  const stopped = mergeFeed(a.f, a.x.s.feed.since(a.f.to));
  assert.deepEqual(said(stopped).filter(([tx]) => !tx.includes('没来问')), [['1 个子代理停下了：回合结束，后台命令清掉了', '0']]);
  assert.deepEqual(said(stopped), said(mergeFeed(undefined, a.x.s.feed.since(0))));

  const b = await press();
  await codexStops(b.x, { interrupted: STOP_INTERRUPTED, terminals: childOnly });
  const left = mergeFeed(b.f, b.x.s.feed.since(b.f.to));
  assert.equal(said(left).length, 1);
  assert.deepEqual(said(left), said(mergeFeed(undefined, b.x.s.feed.since(0))));

  // The session goes in the middle of it, by its end or by the child's.
  for (const go of [(x: typeof a.x) => x.s.end(), (x: typeof a.x) => x.m.close(1)]) {
    const c = await press();
    go(c.x);
    await settle();
    const gone = mergeFeed(c.f, c.x.s.feed.since(c.f.to));
    assert.equal(said(gone).some(([tx]) => tx.includes('还没确认')), false);
    assert.deepEqual(said(gone), said(mergeFeed(undefined, c.x.s.feed.since(0))));
  }
});

test('a stop that did not finish can be pressed again: what the clean or the list left stays offered, and the press says how it went', async () => {
  // The clean refused: its turn ended, its command runs on, and the root is idle.
  const x = await session();
  await x.play([activity('started', 'started', T0), childTurn('turn/started'), ROOT_IDLE]);
  await x.s.interrupt();
  await codexStops(x, { interrupted: STOP_INTERRUPTED, refuse: [CLEAN], terminals: () => 1 });
  assert.deepEqual(noteStates(x.s), ['members-not-stopped=1']);
  assert.deepEqual([only(x.s).state, only(x.s).why], ['ended', 'interrupted']);
  assert.equal(stoppable(x), true);

  const sent = stopSent(x.m).length;
  await x.s.interrupt();
  await codexStops(x, { refuse: [CLEAN], terminals: () => 1 });
  assert.deepEqual(stopSent(x.m).slice(sent), [[CLEAN, CHILD, undefined], [LIST, CHILD, undefined]], 'no turn of its is open: only the clean goes again');
  assert.deepEqual(noteStates(x.s), ['members-not-stopped=1', 'members-not-stopped=1']);
  assert.equal(stoppable(x), true);

  await x.s.interrupt();
  await codexStops(x);
  assert.deepEqual(noteStates(x.s), ['members-not-stopped=1', 'members-not-stopped=1', 'members-stopped=1']);
  assert.equal(stoppable(x), false, 'its list said none is left: nothing more to offer');
  const quiet = stopSent(x.m).length;
  await x.s.interrupt();
  await settle();
  assert.equal(stopSent(x.m).length, quiet);

  // A list that was refused leaves the same.
  const y = await session();
  await y.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await y.s.interrupt();
  await codexStops(y, { interrupted: STOP_INTERRUPTED, refuse: [LIST] });
  assert.equal(stoppable(y), true);
});

test('a member over with a command still open stays in the stop\'s reach, however it got there', async () => {
  const open = [activity('started', 'started', T0), childTurn('turn/started'), childCommand('started', T0 + 1, 'inProgress'), ROOT_IDLE];
  // Interrupted by something other than this stop: the root's own interrupt_agent would come this way (not measured).
  const a = await session();
  await a.play([...open, ...STOP_INTERRUPTED]);
  assert.deepEqual([only(a.s).state, a.s.state], ['ended', 'idle']);
  assert.equal(stoppable(a), true, 'the button is not grey over a command that runs');
  await a.s.interrupt();
  assert.deepEqual(noteStates(a.s), ['members-stopping=1']);
  await codexStops(a, { cleaned: STOP_CLEANED });
  assert.deepEqual(stopSent(a.m), [[CLEAN, CHILD, undefined], [LIST, CHILD, undefined]]);
  assert.deepEqual(noteStates(a.s), ['members-ran-unasked=1', 'members-stopped=1']);
  assert.equal(stoppable(a), false);

  // Its list says none is left though no end of the command ever came: the list is what counts.
  const g = await session();
  await g.play([...open, ...STOP_INTERRUPTED]);
  await g.s.interrupt();
  await codexStops(g);
  assert.deepEqual(noteStates(g.s), ['members-stopped=1']);
  assert.equal(stoppable(g), false);

  // It reported, its command open.
  const b = await session();
  await b.play([...open, childTurn('turn/completed')]);
  assert.equal(only(b.s).state, 'returned');
  assert.equal(stoppable(b), true);
  await b.s.interrupt();
  await codexStops(b, { terminals: () => 1 });
  assert.deepEqual(noteStates(b.s), ['members-not-stopped=1']);

  // Its command came to an end, however it ended: nothing left to reach.
  for (const status of ['completed', 'failed', 'declined']) {
    const c = await session();
    await c.play([...open, childCommand('completed', T0 + 2, status, 0), childTurn('turn/completed')]);
    assert.equal(stoppable(c), false, status);
  }

  // However many it leaves open, what is kept of them stands still, and none of it reaches the record.
  const f = await session();
  await f.play([...open, ...Array.from({ length: CODEX_SESSION_LIMITS.memberChanges + 8 }, (_, i) => ran(CHILD, `i${i}`)[0]!), childTurn('turn/completed')]);
  assert.deepEqual(Object.keys(only(f.s)).sort(), ['asks', 'batch', 'endedAt', 'failed', 'lastAt', 'model', 'name', 'ranUnasked', 'startedAt', 'state', 'threadId', 'why']);
  assert.equal(stoppable(f), true);
});

test('a member that came up while a stop was on its way gets the stop too, and is in the count', async () => {
  const x = await session();
  await x.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await x.s.interrupt();
  await x.play([activity('started', 'started', T0, 'thread-two', '/root/two'), childTurn('turn/started', { id: 'turn-two' }, 'thread-two')]);
  await x.s.interrupt();
  await codexStops(x, { interrupted: STOP_INTERRUPTED });
  // The first round was read, the next went out: nothing final yet, and the live note says both.
  assert.deepEqual(noteStates(x.s), ['members-stopping=2']);
  assert.deepEqual(stopSent(x.m).filter((r) => r[1] === 'thread-two').map((r) => r[0]), ['turn/interrupt']);
  await codexStops(x, { interrupted: [childTurn('turn/completed', { id: 'turn-two', status: 'interrupted' }, 'thread-two')] });
  assert.deepEqual(stopSent(x.m).filter((r) => r[1] === 'thread-two').map((r) => r[0]), ['turn/interrupt', CLEAN, LIST]);
  assert.equal(stopSent(x.m).filter((r) => r[1] === CHILD).length, 3, 'the first is not stopped twice');
  assert.deepEqual(noteStates(x.s), ['members-stopped=2']);

  // One it cannot reach is in the count too: none goes unsaid (T1).
  const y = await session();
  await y.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await y.s.interrupt();
  await y.play([{ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-two' } }]);
  await codexStops(y, { interrupted: STOP_INTERRUPTED });
  assert.deepEqual(noteStates(y.s), ['members-stopped=1', 'members-not-stopped=1']);
  assert.equal(stopSent(y.m).some((r) => r[1] === 'thread-two'), false);

  // One that went unknown during the stop is not called stopped, and counts once.
  const z = await session();
  await z.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await z.s.interrupt();
  await codexStops(z, { interrupted: [statusOf('notLoaded')] });
  assert.equal(only(z.s).state, 'unknown');
  assert.deepEqual(noteStates(z.s), ['members-not-stopped=1']);
  // The same with no turn left open: only its state says it.
  const w = await session();
  await w.play([activity('started', 'started', T0), childTurn('turn/started')]);
  await w.s.interrupt();
  await codexStops(w, { interrupted: [childTurn('turn/completed', { status: 'brand-new' })] });
  assert.equal(only(w.s).state, 'unknown');
  assert.deepEqual(noteStates(w.s), ['members-not-stopped=1']);

  // Unknown from the start of a stop, a turn of its still on record: nothing goes to it, and nothing offers it (T1).
  const u = await session();
  await u.play([activity('started', 'started', T0), childTurn('turn/started'), statusOf('notLoaded'), ROOT_IDLE]);
  assert.equal(only(u.s).state, 'unknown');
  assert.equal(stoppable(u), false);
  await u.s.interrupt();
  await codexStops(u);
  assert.deepEqual(stopSent(u.m), []);
  assert.deepEqual(noteStates(u.s), ['members-not-stopped=1']);
});

test('what says a member did not stop, each on its own: no turn id yet, a turn still open; an old turn\'s end takes no new turn\'s id', async () => {
  // Heard to run, no turn/started yet: nothing to interrupt, so an empty list does not make it stopped.
  const a = await session();
  await a.play([activity('started', 'started', T0), statusOf('active', CHILD, [])]);
  assert.equal(only(a.s).state, 'running');
  await a.s.interrupt();
  await codexStops(a);
  assert.deepEqual(stopSent(a.m).filter((r) => r[1] === CHILD), [[CLEAN, CHILD, undefined], [LIST, CHILD, undefined]]);
  assert.deepEqual(noteStates(a.s), ['members-not-stopped=1']);

  // Idle by its status, its turn never ended, the interrupt refused: the open turn is what says no.
  const b = await session();
  await b.play([activity('started', 'started', T0), childTurn('turn/started'), statusOf('idle')]);
  assert.equal(only(b.s).state, 'idle');
  await b.s.interrupt();
  assert.deepEqual(noteStates(b.s), ['members-stopping=1'], 'a turn still open is a turn to stop');
  await codexStops(b, { refuse: ['turn/interrupt'] });
  assert.deepEqual(noteStates(b.s), ['members-not-stopped=1']);

  // The same one, stopped this time: it is counted, though its status said idle.
  const c = await session();
  await c.play([activity('started', 'started', T0), childTurn('turn/started'), statusOf('idle')]);
  await c.s.interrupt();
  await codexStops(c, { interrupted: [childTurn('turn/completed', { status: 'interrupted' })] });
  assert.deepEqual(noteStates(c.s), ['members-stopped=1']);

  // An older turn's end read after the next turn started: the next stop still has the new turn.
  const d = await session();
  await d.play([activity('started', 'started', T0), childTurn('turn/started'), childTurn('turn/started', { id: 'turn-child-2' }), childTurn('turn/completed')]);
  await d.s.interrupt();
  await settle();
  assert.deepEqual(stopSent(d.m).find((r) => r[1] === CHILD), ['turn/interrupt', CHILD, 'turn-child-2']);
});

test('a sub-agent interrupted while it runs: ended with that reason; a new turn revives it', async () => {
  const { s, play } = await session();
  await play([activity('started', 'started', T0), childTurn('turn/started')]);
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

test('the root idle is not the end of a sub-agent: its approval still comes, as measured, and its completion comes under the root turn that already ended', async () => {
  const { m, s, approvals, play } = await session();
  await play(V2_TO_APPROVAL);
  await play([{ method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'turn-root', status: 'completed' } } }]);
  assert.equal(s.state, 'idle');
  assert.equal(only(s).state, 'running');
  m.send(childApproval(0));
  await settle();
  assert.equal(approvals.list().length, 1);
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

/** The dispatch rows of a session, as [ref, name, batch]. */
const dispatches = (s: CodexSession) => s.feed.since(0).events.filter((e) => e.state === 'dispatch').map((e) => [e.ref, e.text, e.batch]);
const nodeOf = (threadId: string) => memberNodeId(OWNED, threadId);
/** Holds a session's feed to the contract, as GET /api/owned/:id/feed does. */
const feedHolds = (s: CodexSession) => {
  const p = s.feed.since(0);
  assert.deepEqual(validateOwnedFeed({ v: 1, kind: 'owned-feed', ownedId: OWNED, from: 0, to: p.to, clipped: false, events: p.events.map((e) => ({ ...e, exitCode: e.exitCode ?? null, tokens: e.tokens ?? null, batch: e.batch ?? null })) }).errors, []);
};

test('v2: the root sending a member out is one dispatch row, by node id, and the only thing of it in the feed', async () => {
  const { s, play } = await session();
  await play(V2_TO_APPROVAL);
  await play(V2_FROM_APPROVAL);
  assert.deepEqual(dispatches(s), [[nodeOf(CHILD), '/root/ping_once', 1]], 'item/started and item/completed of the spawn are one row');
  assert.equal(only(s).batch, 1);
  assert.equal(feedText(s).includes(CHILD), false, 'no thread id reaches the page');
  assert.equal(feedText(s).includes(CHILD_WORDS), false);
  feedHolds(s);
  const kid = memberRows(towerOf([seatOf(s)]).projects[0]!.nodes)[0]!;
  assert.deepEqual([kid.id, kid.batch], [nodeOf(CHILD), 1]);
  assert.deepEqual(validateTower(towerOf([seatOf(s)])).errors, []);
});

test('v1: the spawn that names the thread is the row, with no name until thread/read gives one; then it is told again, once, and the row stays where it stood', async () => {
  const { m, s, play } = await session();
  await play(V1_TO_APPROVAL);
  assert.deepEqual(dispatches(s), [[nodeOf(CHILD), null, 1]], 'a name not known is not made up (T1)');
  const read = m.sent().find((x) => x.method === 'thread/read')!;
  m.send({ id: read.id, result: { thread: { id: CHILD, agentNickname: 'Archimedes ghp_SECRET' } } });
  await settle();
  assert.deepEqual(dispatches(s), [[nodeOf(CHILD), null, 1], [nodeOf(CHILD), 'Archimedes [redacted]', 1]]);
  // Both tellings stay: a page takes them by ref, one row, the name in it.
  await play(V1_FROM_APPROVAL);
  assert.equal(dispatches(s).length, 2);
  feedHolds(s);
  // A spawn that failed names nobody: no row, the note as before.
  const f = await session();
  await f.play([collab('completed', 'spawnAgent', T0, [], {}, 'failed')]);
  assert.deepEqual([dispatches(f.s), noteStates(f.s)], [[], ['subagent-spawn-failed']]);
});

test('v1: a page opened later reads the dispatch rows where one open all along has them, in the order they went out', async () => {
  const x = await session();
  const [a, b] = ['thread-a', 'thread-b'];
  const v1 = (tid: string): Frame => collab('completed', 'spawnAgent', T0, [tid], { [tid]: { status: 'pendingInit', message: null } });
  const say = (id: string, text: string): Frame => ({ method: 'item/completed', params: { threadId: ROOT, turnId: ROOT_TURN, item: { type: 'agentMessage', id, text } } });
  await x.play([v1(a), say('m1', 'between'), rootItem('reasoning'), childTurn('turn/started', {}, a), childTurn('turn/started', {}, b), v1(b), say('m2', 'after')]);
  const open = mergeFeed(undefined, x.s.feed.since(0));
  const reads = x.m.sent().filter((q) => q.method === 'thread/read');
  // The second batch's name comes first: the order the names came in moves nothing.
  const read = (tid: string, name: string) => x.m.send({ id: reads.find((q) => q.params.threadId === tid)!.id, result: { thread: { id: tid, agentNickname: name } } });
  read(b, 'second');
  await settle();
  read(a, 'first');
  await settle();
  const rows = (feed: ReturnType<typeof mergeFeed>) => (describeChat(feed).kids as any[]).filter((k) => k.data.kind === 'disp' || k.data.kind === 'agent').map((k) => k.slots.tx.text);
  const expected = ['派出 first', 'between', '派出 second', 'after'];
  assert.deepEqual(rows(mergeFeed(open, x.s.feed.since(open.to))), expected, 'a page open all along');
  assert.deepEqual(rows(mergeFeed(undefined, x.s.feed.since(0))), expected, 'a page opened after');
  feedHolds(x.s);
});

test('a batch is what the root thread shows: one turn, no other root item between; a doubt is a batch of its own', async () => {
  const batches = async (frames: readonly Frame[]) => {
    const x = await session();
    await x.play(frames);
    feedHolds(x.s);
    return x.s.members.map((m) => m.batch);
  };
  const [a, b, c] = ['thread-a', 'thread-b', 'thread-c'];
  assert.deepEqual(await batches([spawnV2(a, 'a'), spawnV2(b, 'b'), spawnV2(c, 'c')]), [1, 1, 1], 'side by side');
  // A child's own frames between two spawns are not the root's.
  assert.deepEqual(await batches([spawnV2(a, 'a'), statusOf('idle', a), childTurn('turn/started', {}, a), spawnV2(b, 'b')]), [1, 1]);
  assert.deepEqual(await batches([spawnV2(a, 'a'), rootItem('reasoning'), spawnV2(b, 'b')]), [1, 2], 'a step between, shown or not');
  assert.deepEqual(await batches([spawnV2(a, 'a'), rootItem('collabAgentToolCall', { tool: 'wait' }), spawnV2(b, 'b')]), [1, 2]);
  assert.deepEqual(await batches([spawnV2(a, 'a'), rootItem('agentMessage'), spawnV2(b, 'b'), spawnV2(c, 'c')]), [1, 2, 2]);
  assert.deepEqual(await batches([spawnV2(a, 'a'), spawnV2(b, 'b', 'another-turn')]), [1, 2], 'another turn');
  assert.deepEqual(await batches([spawnV2(a, 'a', null), spawnV2(b, 'b', null)]), [1, 2], 'no turn named: one each');
  assert.deepEqual(await batches([spawnV2(a, 'a'), spawnV2(b, 'b', null), spawnV2(c, 'c')]), [1, 2, 3], 'and it leaves no batch open');
  // v1: both spawns start before either names its thread.
  const v1 = (tid: string, phase: 'started' | 'completed') => collab(phase, 'spawnAgent', T0, phase === 'started' ? [] : [tid], phase === 'started' ? {} : { [tid]: { status: 'pendingInit', message: null } });
  assert.deepEqual(await batches([v1(a, 'started'), v1(b, 'started'), v1(a, 'completed'), v1(b, 'completed')]), [1, 1]);
  assert.deepEqual(await batches([v1(a, 'started'), v1(a, 'completed'), rootItem('reasoning'), v1(b, 'started'), v1(b, 'completed')]), [1, 2]);
});

test('a spawn the root did not make has no row and no batch: a member\'s own, or a thread nothing announced', async () => {
  const x = await session();
  await x.play([spawnV2(CHILD, '/root/one'), spawnV2('thread-n', '/root/one/two', 'turn-of-child', CHILD), statusOf('active', 'thread-q', [])]);
  assert.deepEqual(x.s.members.map((m) => [m.threadId, m.batch]), [[CHILD, 1], ['thread-n', null], ['thread-q', null]]);
  assert.deepEqual(dispatches(x.s).map((d) => d[0]), [nodeOf(CHILD)]);
  assert.deepEqual(memberRows(towerOf([seatOf(x.s)]).projects[0]!.nodes).map((n) => n.batch).sort(), [1, null, null]);
  // Past the bound there is no member to name: the count says it, as before.
  const y = await session();
  await y.play(Array.from({ length: CODEX_SESSION_LIMITS.members + 1 }, (_, i) => spawnV2(`t${i}`, `m${i}`)));
  assert.equal(dispatches(y.s).length, CODEX_SESSION_LIMITS.members);
  assert.equal(y.s.membersOver, 1);
});

test('the registry keeps a member\'s batch; a file of an earlier build reads as no batch; the contracts hold batch to sub-agents and dispatch rows', () => {
  const base = { v: 1, ownedId: OWNED, harness: 'codex', model: DEFAULT_CODEX_MODEL, title: 't', createdAt: 1, state: 'idle', endReason: null, membersOver: 0 };
  const row = { threadId: 't1', name: 'a', model: null, state: 'returned', why: null, startedAt: null, endedAt: null, failed: 0, ranUnasked: 0 };
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [row] }))!.members![0]!.batch, null);
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [{ ...row, batch: 3 }] }))!.members![0]!.batch, 3);
  for (const bad of [0, -1, 1.5, '1']) assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [{ ...row, batch: bad }] })), null, String(bad));

  const event = { seq: 1, at: 1, kind: 'note', ref: nodeOf(CHILD), uuid: null, text: 'a', state: 'dispatch', redactions: 0, live: false, exitCode: null, tokens: null, batch: 1 };
  const page = (over: Record<string, unknown>) => validateOwnedFeed({ v: 1, kind: 'owned-feed', ownedId: OWNED, from: 0, to: 1, clipped: false, events: [{ ...event, ...over }] }).errors;
  assert.deepEqual(page({}), []);
  assert.ok(page({ ref: CHILD }).some((e) => e.includes('.ref')), 'a thread id on a dispatch row');
  assert.ok(page({ batch: null }).some((e) => e.includes('.batch')));
  assert.ok(page({ state: 'tree-ended' }).some((e) => e.includes('.batch')));
  assert.ok(page({ batch: 0 }).some((e) => e.includes('.batch')));
});

/** A root turn running one command that was asked about and allowed. */
async function rootRunning() {
  const x = await session();
  await x.play([rootCommand('started', 'inProgress')]);
  x.m.send({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: ROOT, turnId: ROOT_TURN, itemId: 'exec-root', command: 'ping', cwd: CWD } });
  await settle();
  const card = x.approvals.list()[0]!;
  assert.equal(x.approvals.allow(card.approvalId, { digest: card.digest, rev: x.approvals.rev }), 'ok');
  await settle();
  return x;
}
const results = (s: CodexSession) => s.feed.since(0).events.filter((e) => e.kind === 'tool-result').map((e) => [e.state, e.exitCode]);

test('a stop reaches the root\'s own command: turn/interrupt, then the clean; sent is not stopped, and the late failed is the stop\'s', async () => {
  const x = await rootRunning();
  const { m, s } = x;
  await s.interrupt();
  await settle();
  assert.deepEqual(allSent(m), [['turn/interrupt', ROOT, ROOT_TURN]], 'the clean waits for the interrupt\'s answer');
  assert.deepEqual(noteStates(s), ['commands-stopping=1']);
  assert.equal(s.feed.since(0).events.find((e) => e.state === 'commands-stopping')?.live, true);

  await codexStops(x, { interrupted: ROOT_STOP_INTERRUPTED, cleaned: ROOT_STOP_CLEANED });
  assert.deepEqual(rootSent(m), [['turn/interrupt', ROOT, ROOT_TURN], [LIST, ROOT, undefined], [CLEAN, ROOT, undefined], [LIST, ROOT, undefined]]);
  assert.deepEqual(noteStates(s), ['commands-stopped=1'], 'the live note went, and nothing says it ran unasked');
  assert.deepEqual(results(s), [['stopped', -1]], 'not a failure: what codex said is its exit code');
  assert.deepEqual([s.state, s.turnId, s.stoppable], ['idle', null, false], 'the session stands, and takes the next message');
  assert.deepEqual(s.send('next', '00000000-0000-4000-8000-000000000001'), { ok: true, via: 'turn/start' });
  feedHolds(s);
  // The chat says it in words, and a page that polled between ends where a later one starts.
  const chat = describeChat(mergeFeed(undefined, s.feed.since(0))).kids as any[];
  assert.equal(chat.find((k) => k.data.kind === 'tool').slots.sum.text, '命令 · ping · 被停止了 · 退出码 -1');
  assert.equal(chat.some((k) => k.slots.tx?.text === '1 条命令停下了：回合结束，后台命令清掉了'), true);
});

test('what a stop of the root does not change: a failed command with no stop is failed, one that ran unasked is said, one still on its card never ran', async () => {
  const f = await session();
  await f.play([rootCommand('started', 'inProgress'), rootCommand('completed', 'failed', 1)]);
  assert.deepEqual(results(f.s), [['failed', 1]]);
  assert.deepEqual(noteStates(f.s), ['ran-unasked=ping']);

  // Nobody asked, and a stop ended it: both are true, and both are said.
  const u = await session();
  await u.play([rootCommand('started', 'inProgress')]);
  await u.s.interrupt();
  await codexStops(u, { interrupted: ROOT_STOP_INTERRUPTED, cleaned: ROOT_STOP_CLEANED });
  assert.deepEqual(results(u.s), [['stopped', -1]]);
  assert.deepEqual(noteStates(u.s), ['ran-unasked=ping', 'commands-stopped=1']);

  // A turn nobody stopped drops what was asked about it, as it did.
  const a = await session();
  await a.play([rootCommand('started', 'inProgress')]);
  a.m.send({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: ROOT, turnId: ROOT_TURN, itemId: 'exec-root', command: 'ping', cwd: CWD } });
  await settle();
  await a.s.interrupt();
  await settle();
  assert.deepEqual(noteStates(a.s), [], 'its card was open: nothing of it ran');
  await codexStops(a, { interrupted: ROOT_STOP_INTERRUPTED, cleaned: [rootCommand('completed', 'declined')] });
  assert.deepEqual([results(a.s), noteStates(a.s), a.s.stoppable], [[['declined', null]], [], false]);

  // Nothing open, nothing on the list: the clean goes out and nothing is said.
  const n = await session();
  await n.s.interrupt();
  await codexStops(n, { interrupted: ROOT_STOP_INTERRUPTED });
  assert.deepEqual(rootSent(n.m), [['turn/interrupt', ROOT, 'turn-root'], [LIST, ROOT, undefined], [CLEAN, ROOT, undefined], [LIST, ROOT, undefined]]);
  assert.deepEqual(noteStates(n.s), []);
});

test('what did not stop of the root is said, stays on offer, and the next press cleans again without a turn to interrupt', async () => {
  // The list holds it: nothing says it stopped, and the stop stays offered.
  const x = await rootRunning();
  await x.s.interrupt();
  await codexStops(x, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => 1 });
  assert.deepEqual(noteStates(x.s), ['commands-not-stopped=1']);
  assert.deepEqual([x.s.state, x.s.stoppable], ['idle', true]);
  await x.s.interrupt();
  assert.deepEqual(noteStates(x.s), ['commands-not-stopped=1', 'commands-stopping=1']);
  await codexStops(x, { cleaned: ROOT_STOP_CLEANED });
  assert.deepEqual(rootSent(x.m).filter((r) => r[0] === 'turn/interrupt').length, 1, 'no turn is open: only the clean goes');
  assert.deepEqual(noteStates(x.s), ['commands-not-stopped=1', 'commands-stopped=1']);
  assert.deepEqual([results(x.s), x.s.stoppable], [[['stopped', -1]], false]);

  // The list unanswered: not known, so not stopped (T1).
  const r = await rootRunning();
  await r.s.interrupt();
  await settle();
  r.m.send({ id: r.m.sent().find((q) => q.method === 'turn/interrupt')!.id, result: {} });
  await settle();
  r.m.send({ id: r.m.sent().find((q) => q.method === LIST)!.id, error: { code: -32600, message: 'refused' } });
  await settle();
  r.m.send({ id: r.m.sent().find((q) => q.method === CLEAN)!.id, result: {} });
  await settle();
  r.clock.advanceBy(CODEX_DEADLINES.stopSettleMs);
  await settle();
  r.m.send({ id: r.m.sent().findLast((q) => q.method === LIST)!.id, error: { code: -32600, message: 'refused' } });
  await settle();
  assert.deepEqual(noteStates(r.s), ['commands-not-stopped=1']);

  // A turn that never ended: not stopped, whatever the list says.
  const o = await rootRunning();
  await o.s.interrupt();
  await codexStops(o);
  assert.deepEqual([noteStates(o.s), o.s.stoppable], [['commands-not-stopped=1'], true]);
});

const turnStart = (id: string): Frame => ({ method: 'turn/started', params: { threadId: ROOT, turn: { id } } });
const turnEnd = (id: string, status: string): Frame => ({ method: 'turn/completed', params: { threadId: ROOT, turn: { id, status } } });

test('a count of the root\'s commands is of commands: a press more adds none, and one that came back is off it', async () => {
  // The turn stays open and the command with it: one command, however many presses.
  const o = await rootRunning();
  for (let i = 0; i < 3; i++) {
    await o.s.interrupt();
    await settle();
    assert.equal(noteStates(o.s).at(-1), 'commands-stopping=1');
    await codexStops(o);
  }
  assert.deepEqual(noteStates(o.s), ['commands-not-stopped=1', 'commands-not-stopped=1', 'commands-not-stopped=1']);

  // On the list too it is that one, by id.
  const l = await rootRunning();
  await l.s.interrupt();
  await codexStops(l, { terminals: () => 1 });
  assert.deepEqual(noteStates(l.s), ['commands-not-stopped=1']);

  // The press after, in a new turn with a new command: the old one came back, so only the new one counts.
  const n = await rootRunning();
  await n.s.interrupt();
  await codexStops(n);
  await n.play([...ROOT_STOP_INTERRUPTED, ...ROOT_STOP_CLEANED, turnStart('turn-2'), rootCommand('started', 'inProgress', undefined, 'exec-next')]);
  await n.s.interrupt();
  await settle();
  assert.equal(noteStates(n.s).at(-1), 'commands-stopping=1');

  // Two of them, and one back before the press: what is left is the other.
  const t = await rootRunning();
  await t.play([rootCommand('started', 'inProgress', undefined, 'exec-two')]);
  await t.s.interrupt();
  await codexStops(t);
  assert.deepEqual(noteStates(t.s).at(-1), 'commands-not-stopped=2');
  await t.play(ROOT_STOP_CLEANED);
  assert.equal(t.s.stoppable, true, 'one is still not confirmed');
  await t.s.interrupt();
  await settle();
  assert.equal(noteStates(t.s).at(-1), 'commands-stopping=1');
});

test('a command the last stop did not confirm that comes back settles it: the stop leaves the offer, the talk says so, and a press finds nothing', async () => {
  const o = await rootRunning();
  await o.s.interrupt();
  await codexStops(o);
  assert.deepEqual([noteStates(o.s), o.s.stoppable], [['commands-not-stopped=1'], true]);
  await o.play(ROOT_STOP_INTERRUPTED);
  assert.equal(o.s.stoppable, true, 'its turn is over, the command is not back');
  await o.play(ROOT_STOP_CLEANED);
  assert.deepEqual([results(o.s), noteStates(o.s), o.s.stoppable, o.s.state], [[['stopped', -1]], ['commands-not-stopped=1', 'commands-back=1'], false, 'idle']);
  const sent = rootSent(o.m).length;
  await o.s.interrupt();
  await settle();
  assert.equal(rootSent(o.m).length, sent, 'nothing is out: nothing goes');
  assert.deepEqual(noteStates(o.s), ['commands-not-stopped=1', 'commands-back=1'], 'no stop is claimed that reached nothing');
  feedHolds(o.s);
  const chat = describeChat(mergeFeed(undefined, o.s.feed.since(0))).kids as any[];
  assert.equal(chat.some((k) => k.slots.tx?.text === '1 条命令已经结束：codex 报回了它们的结果'), true);

  // Back while the stop is on its way, the turn still open: back is what is known of it, and a stop adds no doubt.
  const w = await rootRunning();
  await w.s.interrupt();
  await codexStops(w, { cleaned: ROOT_STOP_CLEANED });
  assert.deepEqual([noteStates(w.s), w.s.stoppable], [['commands-back=1'], false]);
  assert.equal(w.s.feed.since(0).events.some((e) => e.live && e.state === 'commands-stopping'), false, 'the live note always gets its final word');

  // What only the list named never comes back: it stays on offer until a press confirms it.
  const b = await rootRunning();
  await b.s.interrupt();
  await codexStops(b, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => 1, terminal: 'exec-behind' });
  assert.equal(noteStates(b.s).at(-1), 'commands-not-stopped=2');
  await b.play(ROOT_STOP_CLEANED);
  assert.deepEqual([noteStates(b.s), b.s.stoppable], [['commands-not-stopped=2'], true]);
  await b.s.interrupt();
  await codexStops(b);
  assert.deepEqual([noteStates(b.s).at(-1), b.s.stoppable], ['commands-stopped=1', false]);
});

test('what was asked about a root command lasts until it comes back, past a turn that ended well', async () => {
  const o = await rootRunning();
  await o.s.interrupt();
  await codexStops(o, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => 1 });
  await o.play([turnStart('turn-2'), turnEnd('turn-2', 'completed'), turnStart('turn-3'), turnEnd('turn-3', 'completed')]);
  await o.play(ROOT_STOP_CLEANED);
  assert.deepEqual(noteStates(o.s), ['commands-not-stopped=1', 'commands-back=1'], 'a person allowed it: nothing says it ran unasked');
  assert.deepEqual(results(o.s), [['stopped', -1]]);

  // One codex never asked about stays said, and a turn's end still drops what it held of the rest.
  const u = await session();
  await u.play([rootCommand('started', 'inProgress')]);
  await u.s.interrupt();
  await codexStops(u, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => 1 });
  await u.play([turnStart('turn-2'), turnEnd('turn-2', 'completed'), ...ROOT_STOP_CLEANED]);
  assert.deepEqual(noteStates(u.s), ['commands-not-stopped=1', 'ran-unasked=ping', 'commands-back=1']);
  const d = await rootRunning();
  await d.play([...ROOT_STOP_CLEANED, turnEnd(ROOT_TURN, 'completed'), turnStart('turn-2'), rootCommand('started', 'inProgress'), rootCommand('completed', 'completed', 0)]);
  assert.deepEqual(noteStates(d.s), ['ran-unasked=ping'], 'an id used again is a new command');
});

test('a root command that outlives its turn: the stop stays on offer and reaches it, and what the clean ends is said', async () => {
  // Open past a turn that ended well, root idle: the clean and the list go, and it reads as the stop's.
  const o = await rootRunning();
  await o.play([turnEnd(ROOT_TURN, 'completed')]);
  assert.deepEqual([o.s.state, o.s.stoppable, stoppable(o)], ['idle', true, true]);
  await o.s.interrupt();
  await settle();
  assert.deepEqual(noteStates(o.s), ['commands-stopping=1']);
  await codexStops(o, { cleaned: ROOT_STOP_CLEANED });
  assert.deepEqual(rootSent(o.m), [[LIST, ROOT, undefined], [CLEAN, ROOT, undefined], [LIST, ROOT, undefined]]);
  assert.deepEqual([results(o.s), noteStates(o.s), o.s.stoppable], [[['stopped', -1]], ['commands-stopped=1'], false]);

  // The same in the next turn: the list is read before the clean, and it is one command, by id.
  const t = await rootRunning();
  await t.play([turnEnd(ROOT_TURN, 'completed'), turnStart('turn-2')]);
  await t.s.interrupt();
  let reads = 0;
  await codexStops(t, { interrupted: [turnEnd('turn-2', 'interrupted')], cleaned: ROOT_STOP_CLEANED, terminals: () => (reads++ === 0 ? 1 : 0) });
  assert.deepEqual(rootSent(t.m), [['turn/interrupt', ROOT, 'turn-2'], [LIST, ROOT, undefined], [CLEAN, ROOT, undefined], [LIST, ROOT, undefined]]);
  assert.deepEqual([results(t.s), noteStates(t.s)], [[['stopped', -1]], ['commands-stopped=1']]);

  // Its item over long ago, no command seen open: only the list knows of it, and the clean ending it is said.
  const b = await session();
  let seen = 0;
  await b.s.interrupt();
  await codexStops(b, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => (seen++ === 0 ? 1 : 0), terminal: 'exec-behind' });
  assert.deepEqual(noteStates(b.s), ['commands-stopped=1']);

  // Nothing known behind an idle root: the stop is not offered and sends nothing (the plan's residual).
  const i = await session();
  await i.play([turnEnd('turn-root', 'completed')]);
  await i.s.interrupt();
  await settle();
  assert.deepEqual([i.s.stoppable, rootSent(i.m), noteStates(i.s)], [false, [], []]);

  // Refused and not yet back when the turn ended: it never ran, so nothing is out.
  const a = await session();
  await a.play([rootCommand('started', 'inProgress')]);
  a.m.send({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: ROOT, turnId: ROOT_TURN, itemId: 'exec-root', command: 'ping', cwd: CWD } });
  await settle();
  const card = a.approvals.list()[0]!;
  assert.equal(a.approvals.deny(card.approvalId), 'ok');
  await a.play([turnEnd(ROOT_TURN, 'completed')]);
  assert.equal(a.s.stoppable, false);
});

test('a stop of the root and the session going, a new turn, a second press', async () => {
  // The session goes on the way: its end says the stop went unanswered, and the stop adds nothing.
  for (const go of [(x: Awaited<ReturnType<typeof session>>) => x.s.end(), (x: Awaited<ReturnType<typeof session>>) => x.m.close(1)]) {
    const x = await rootRunning();
    await x.s.interrupt();
    await settle();
    go(x);
    await settle();
    x.clock.advanceBy(CODEX_DEADLINES.interruptMs + CODEX_DEADLINES.stopSettleMs);
    await settle();
    assert.deepEqual(noteStates(x.s).filter((n) => n.startsWith('commands-')), ['commands-stop-unanswered=1']);
    assert.equal(x.s.feed.since(0).events.some((e) => e.live && e.state === 'commands-stopping'), false, 'a page never keeps the live note');
  }

  // A message right after the stop opens a turn: what that runs is no part of this stop, so the list is not read.
  const t = await rootRunning();
  await t.s.interrupt();
  await settle();
  await t.play(ROOT_STOP_INTERRUPTED);
  t.m.send({ method: 'turn/started', params: { threadId: ROOT, turn: { id: 'turn-next' } } });
  await settle();
  await codexStops(t, { cleaned: ROOT_STOP_CLEANED });
  assert.equal(rootSent(t.m).filter((r) => r[0] === LIST).length, 0);
  assert.deepEqual([noteStates(t.s), t.s.turnId], [['commands-stopped=1'], 'turn-next']);

  // A press while a turn/start is out, and the last stop left something: the clean now, the turn once it has an id.
  const w = await rootRunning();
  await w.s.interrupt();
  await codexStops(w, { interrupted: ROOT_STOP_INTERRUPTED, terminals: () => 1 });
  w.s.send('next', '00000000-0000-4000-8000-000000000002');
  await settle();
  await w.s.interrupt();
  await settle();
  w.m.send({ id: w.m.sent().find((q) => q.method === 'turn/start')!.id, result: { turn: { id: 'turn-next' } } });
  await settle();
  assert.deepEqual(rootSent(w.m).filter((r) => r[0] === 'turn/interrupt').at(-1), ['turn/interrupt', ROOT, 'turn-next']);

  // A second press while it is on its way: the turn again, as before, and no second round of notes.
  const d = await rootRunning();
  await d.s.interrupt();
  await d.s.interrupt();
  await codexStops(d, { interrupted: ROOT_STOP_INTERRUPTED, cleaned: ROOT_STOP_CLEANED });
  assert.equal(rootSent(d.m).filter((r) => r[0] === CLEAN).length, 1);
  assert.deepEqual(noteStates(d.s), ['commands-stopped=1']);
});
