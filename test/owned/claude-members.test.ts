import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPipe } from '../../src/os/owned-proc.ts';
import type { ClaudeSession } from '../../src/owned/claude-session.ts';
import type { OwnedRecord } from '../../src/owned/registry.ts';
import { VirtualClock, oneShot } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { ClaudeOwned } from '../../src/owned/claude-owned.ts';
import { CLAUDE_DEADLINES, commandsOf, startClaudeSession } from '../../src/owned/claude-session.ts';
import { MEMBER_LIMITS } from '../../src/owned/members.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
import { REGISTRY_LIMITS, makeOwnedRegistry, parseOwnedRecord } from '../../src/owned/registry.ts';
import { makeRequests } from '../../src/route/requests.ts';
import { memberNodeId, ownedProject, towerFromStage } from '../../src/sources/tower.ts';
import { validateOwnedFeed } from '../../shared/owned-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { SUB_WORDS, TASK } from '../fixtures/claude-subagent-frames.ts';
import { busyStage } from '../helpers/tower-fixture.ts';

// The owned Claude session's sub-agents against a hand-made host pipe: the frames the host writes (they carry states
// only; hosts/claude/host-core.mjs is tested apart). No SDK, no process.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SID = '11111111-2222-4333-8444-555555555555';
const OWNED = 'c'.repeat(20);
const REQ = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);
const MODEL = DEFAULT_CLAUDE_MODEL;

type Frame = Record<string, unknown>;
const RESIDENTS = ['procguard.exe', 'node.exe', 'claude.exe', 'conhost.exe'];

function fakePipe(jobbed: boolean) {
  const written: string[] = [];
  let out: ((c: Buffer) => void) | null = null;
  let onClose: ((code: number | null, signal: string | null) => void) | null = null;
  /** What the Job holds, as its images; null: it cannot be read. */
  const job: { images: string[] | null } = { images: [...RESIDENTS] };
  const pipe = Object.freeze({
    pid: 4242,
    write: (d: string) => {
      written.push(d);
    },
    onStdout: (cb: (c: Buffer) => void) => { out = cb; },
    onStderr: () => {},
    onClose: (cb: (code: number | null, signal: string | null) => void) => { onClose = cb; },
    onError: () => {},
    closeStdin: () => {},
    kill: () => {},
    ...(jobbed ? { job: { endTree: async () => ({ ok: true, killed: 0, left: 0 }), procs: async () => job.images?.map((image, pid) => ({ pid, createTime: '1', image })) ?? null } } : {}),
  }) as unknown as HostPipe;
  return {
    pipe,
    job,
    frames: () => written.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Frame),
    say: (frame: Frame) => out?.(Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')),
    close: () => onClose?.(0, null),
  };
}

function rig(jobbed = true, over: { tainted?: boolean } = {}) {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const host = fakePipe(jobbed);
  const started = startClaudeSession({
    ownedId: OWNED, cwd: 'C:\\o\\work\\c', configDir: 'C:\\o\\claude\\c', model: MODEL, claudeExe: 'C:\\x\\claude.exe', protectedRoots: ['C:\\o'], askTimeoutMs: 60_000,
    launch: () => host.pipe, approvals, now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock, ...over,
  }, { text: 'hello', uuid: U(1) });
  assert.ok(started.ok);
  host.say({ t: 'init', sessionId: SID });
  return { clock, approvals, host, s: started.session };
}

const start = (over: Frame = {}): Frame => ({ t: 'sub-start', taskId: TASK, name: 'ping once', type: 'general-purpose', depth: 1, reply: 'msg_a', ...over });
const end = (status: string, taskId = TASK): Frame => ({ t: 'sub-end', taskId, status });
const ask = (over: Frame = {}): Frame => ({ t: 'ask', reqId: REQ, toolName: 'PowerShell', toolUseId: 's1', preview: 'command: ping', inputBytes: 10, digest: DIGEST, redactions: 0, tooLong: false, risk: 'shell', paths: [], unplaced: false, subject: 'ping', agentId: TASK, ...over });
/** The session's own Agent call, as the host says it: no tool row, no agent id. */
const rootAsk = (over: Frame = {}): Frame => ask({ agentId: undefined, toolName: 'Agent', toolUseId: 'r1', risk: 'other', subject: '', ...over });
const result = (uuid: string | null = null): Frame => ({ t: 'result', subtype: 'success', costUsd: 0, uuid });
/** The stop's read of what came back: its timer, then the read of the Job. */
const stopRead = async (clock: VirtualClock, ms: number = CLAUDE_DEADLINES.stopSettleMs) => {
  clock.advanceBy(ms);
  await new Promise((r) => setImmediate(r));
};
const events = (s: ClaudeSession) => s.feed.since(0).events;
const notes = (s: ClaudeSession) => events(s).filter((e) => e.kind === 'note' && e.state?.startsWith('members-')).map((e) => `${e.state}=${String(e.text)}`);
const feedOk = (s: ClaudeSession) => {
  const page = s.feed.since(0);
  const v = validateOwnedFeed({
    v: 1, kind: 'owned-feed', ownedId: s.ownedId, from: page.from, to: page.to, clipped: page.clipped,
    events: page.events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, uuid: e.uuid, text: e.text, state: e.state, redactions: e.redactions, live: e.live, exitCode: e.exitCode ?? null, tokens: e.tokens ?? null, batch: e.batch ?? null })),
  });
  assert.ok(v.ok, v.errors.join('\n'));
};
const seat = (s: ClaudeSession) => ({ ownedId: s.ownedId, harness: 'claude' as const, title: 't', state: s.state, endReason: s.endReason, waiting: null, lastAt: 1, members: s.members.map(({ asks: _a, ...m }) => ({ ...m, asking: null })), membersOver: s.membersOver });

test('sub-agents only where the tree is in a Job: the start frame says so', () => {
  assert.equal(rig(true).host.frames()[0]!.subagents, true);
  assert.equal(rig(false).host.frames()[0]!.subagents, false);
});

test('a member from its frames: name, type, model, state, times; the feed gets one dispatch row and no word of it', () => {
  const { s, host, clock } = rig();
  host.say(start());
  host.say({ t: 'sub-model', taskId: TASK, model: MODEL });
  const t0 = clock.wall;
  clock.advanceBy(4_000);
  host.say({ t: 'sub-progress', taskId: TASK });
  clock.advanceBy(1_000);
  host.say(end('completed'));
  const m = s.members[0]!;
  assert.deepEqual({ ...m, asks: [...m.asks] }, {
    threadId: TASK, name: 'ping once', model: MODEL, agentType: 'general-purpose', state: 'returned', why: null, startedAt: t0, endedAt: t0 + 5_000, failed: 0, ranUnasked: 0, batch: 1, lastAt: t0 + 5_000, asks: [],
  });
  const rows = events(s).filter((e) => e.state === 'dispatch');
  assert.deepEqual(rows.map((e) => [e.ref, e.text, e.batch]), [[memberNodeId(OWNED, TASK), 'ping once', 1]]);
  assert.ok(!JSON.stringify(events(s)).includes(SUB_WORDS));
  assert.equal(s.stoppable, false, 'a member that reported has nothing to stop');
  feedOk(s);
  // The tower draws it as it draws a Codex member, with its type and how long it took.
  const node = ownedProject([seat(s)], clock.wall)!.nodes.find((n) => n.layer === 'subagent')!;
  assert.deepEqual([node.harness, node.state, node.title, node.agentType, node.durationMs, node.batch, node.model], ['claude', 'returned', 'ping once', 'general-purpose', 5_000, 1, MODEL]);
});

test('many of one type fold as the contract asks, and the snapshot passes it', () => {
  const { s, host, clock } = rig();
  for (let i = 0; i < 6; i++) host.say(start({ taskId: `t${i}`, reply: 'msg_a' }));
  const tower = towerFromStage(busyStage(), { seats: [seat(s)], nowWall: clock.wall });
  assert.deepEqual(validateTower(tower).errors, []);
  const owned = tower.projects.find((p) => p.nodes.some((n) => n.harness === 'claude' && n.layer === 'subagent'))!;
  assert.equal(owned.nodes.filter((n) => n.layer === 'subagent').length, 6);
});

test('batches: one reply is one, another reply another; no reply stands alone; a nested start has no row and no batch', () => {
  const { s, host } = rig();
  host.say(start({ taskId: 'a1', reply: 'msg_a' }));
  host.say(start({ taskId: 'a2', reply: 'msg_a' }));
  host.say(start({ taskId: 'a3', reply: 'msg_b' }));
  host.say(start({ taskId: 'a4', reply: null }));
  host.say(start({ taskId: 'a5', reply: null }));
  host.say(start({ taskId: 'a6', depth: 2, reply: null }));
  assert.deepEqual(s.members.map((m) => m.batch), [1, 1, 2, 3, 4, null]);
  assert.equal(events(s).filter((e) => e.state === 'dispatch').length, 5);
});

test('a card names the sub-agent inside what the digest covers, and the feed row too; the answer goes back and clears it', () => {
  const { s, host, approvals } = rig();
  host.say(start());
  host.say(ask());
  const card = approvals.list()[0]!;
  assert.match(card.preview, new RegExp(`^from subagent: ping once \\(task …${TASK.slice(-8)}\\)\\ntool: PowerShell`));
  assert.deepEqual(s.members[0]!.asks, [card.approvalId]);
  assert.match(events(s).find((e) => e.kind === 'ask')!.text!, /^ping once \(task …/);
  assert.equal(approvals.allow(card.approvalId, { digest: card.digest, rev: approvals.rev }), 'ok');
  assert.deepEqual(s.members[0]!.asks, []);
  assert.deepEqual(host.frames().filter((f) => f.t === 'perm').map((f) => [f.reqId, f.allow, f.digest]), [[REQ, true, DIGEST]]);
  // An automatic refusal says whose too; one of the session's own says nothing more.
  host.say({ t: 'denied-auto', toolUseId: 's2', name: 'Read', why: 'protected', agentId: TASK });
  host.say({ t: 'denied-auto', toolUseId: 's3', name: 'Read', why: 'protected' });
  assert.deepEqual(events(s).filter((e) => e.kind === 'auto-denied').map((e) => e.text), [`ping once (task …${TASK.slice(-8)}): Read`, 'Read']);
  // The session's own ask has no such line.
  host.say(ask({ reqId: 'c'.repeat(32), agentId: undefined }));
  assert.equal(approvals.list()[0]!.preview.startsWith('tool: PowerShell'), true);
  feedOk(s);
});

test('a card from an agent id nobody announced still comes, without a name', () => {
  const { host, approvals } = rig();
  host.say(ask({ agentId: 'unannounced-task' }));
  assert.match(approvals.list()[0]!.preview, /^from subagent: name unknown \(task …ced-task\)/);
});

test('steps that failed are counted; what a stop cut short is not', () => {
  const { s, host } = rig();
  host.say(start());
  host.say({ t: 'sub-failed', taskId: TASK });
  host.say({ t: 'sub-failed', taskId: TASK });
  assert.equal(s.members[0]!.failed, 2);
  void s.interrupt();
  host.say({ t: 'sub-failed', taskId: TASK });
  assert.equal(s.members[0]!.failed, 2);
});

test('a failure and a stop are ended with their reason, never reported back; a late end does not change that', () => {
  const { s, host } = rig();
  host.say(start({ taskId: 'a1' }));
  host.say(start({ taskId: 'a2' }));
  host.say(end('failed', 'a1'));
  host.say(end('stopped', 'a2'));
  host.say(end('completed', 'a2'));
  assert.deepEqual(s.members.map((m) => [m.state, m.why]), [['ended', 'failed'], ['ended', 'interrupted']]);
});

test('a stop with the root idle: the interrupt frame goes, the feed says what came back, and the session stands', async () => {
  const { s, host, clock } = rig();
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  assert.equal(s.state, 'idle');
  host.say(start());
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: true });
  assert.equal(s.stoppable, true, 'the root is idle, the sub-agent is not');
  await s.interrupt();
  assert.equal(host.frames().filter((f) => f.t === 'interrupt').length, 1);
  assert.deepEqual(notes(s), ['members-stopping=1']);
  host.say({ t: 'interrupted', stillQueued: 0 });
  host.say(end('stopped'));
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: false });
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-stopped=1']);
  assert.deepEqual([s.state, s.stoppable, s.members[0]!.state], ['idle', false, 'ended']);
  feedOk(s);
});

test('a stop that does not see the end says so and stays on offer; a second press reaches it again', async () => {
  const { s, host, clock } = rig();
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  host.say(start());
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: true });
  await s.interrupt();
  host.say(end('stopped'));
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-not-stopped=1'], 'its command never ended');
  assert.equal(s.stoppable, true, 'ended, with a command open');
  await s.interrupt();
  assert.equal(host.frames().filter((f) => f.t === 'interrupt').length, 2);
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: false });
  await stopRead(clock);
  assert.equal(s.stoppable, false);
  assert.ok(notes(s).includes('members-stopped=1'));
});

test('the frames come before the processes: nothing is said of the commands until the Job holds none, and the stop stays on offer meanwhile', async () => {
  const { s, host, clock } = rig();
  host.say(result(U(1)));
  host.say(start());
  host.job.images = [...RESIDENTS, 'cmd.exe', 'powershell.exe'];
  await s.interrupt();
  host.say(end('stopped'));
  assert.equal(s.stoppable, true, 'not read yet');
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-stopping=1'], 'the outer shells are still going (measured: 3.4 to 3.7 s)');
  assert.equal(s.stoppable, true);
  host.job.images = [...RESIDENTS];
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-stopped=1']);
  assert.equal(s.stoppable, false);
  feedOk(s);
});

test('a process a command let go: no frame names it, the Job does; the feed says so, the stop stays on offer, and a later press reads the Job again', async () => {
  const { s, host, clock } = rig();
  host.say(result(U(1)));
  host.say(start());
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: true });
  host.say({ t: 'sub-cmd', taskId: TASK, id: 'b1', open: false });
  host.job.images = [...RESIDENTS, 'PING.EXE'];
  await s.interrupt();
  host.say(end('stopped'));
  for (let t = 0; t < CLAUDE_DEADLINES.stopJobMs; t += CLAUDE_DEADLINES.stopSettleMs) await stopRead(clock);
  assert.deepEqual(notes(s), ['members-job-left=1'], 'never "the commands are gone" (T1)');
  assert.equal(s.stoppable, true);
  feedOk(s);
  host.job.images = [...RESIDENTS];
  await s.interrupt();
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-job-left=1', 'members-stopped=1']);
  assert.equal(s.stoppable, false);
});

test('a Job that cannot be read: the members ended, and whether their commands did is unknown', async () => {
  const { s, host, clock } = rig();
  host.say(result(U(1)));
  host.say(start());
  host.job.images = null;
  await s.interrupt();
  host.say(end('stopped'));
  await stopRead(clock);
  assert.deepEqual(notes(s), ['members-job-unsure=1']);
  assert.equal(s.stoppable, true);
});

test('a Job\'s commands: all but the residents, and a node.exe past the host\'s', () => {
  const procs = (...images: (string | null)[]) => images.map((image, pid) => ({ pid, createTime: '1', image }));
  assert.equal(commandsOf(procs(...RESIDENTS)), 0);
  assert.equal(commandsOf(procs('CLAUDE.EXE', 'Node.exe')), 0);
  assert.equal(commandsOf(procs(...RESIDENTS, 'PING.EXE', 'cmd.exe')), 2);
  assert.equal(commandsOf(procs(...RESIDENTS, 'node.exe')), 1);
  assert.equal(commandsOf(procs(null)), 1, 'one procguard could not open is not known to be a resident');
});

test('no member and no turn: the stop sends nothing, as before', async () => {
  const { s, host } = rig();
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  await s.interrupt();
  assert.equal(host.frames().filter((f) => f.t === 'interrupt').length, 0);
});

test('a session that goes while a stop is on its way says the stop was not answered; a member still live is unknown', async () => {
  const { s, host } = rig();
  host.say(start({ taskId: 'a1' }));
  host.say(start({ taskId: 'a2' }));
  host.say(end('completed', 'a2'));
  await s.interrupt();
  s.end();
  assert.deepEqual(notes(s), ['members-stop-unanswered=1']);
  assert.deepEqual(s.members.map((m) => m.state), ['unknown', 'returned'], 'T1: never running');
  assert.equal(s.stoppable, false);
  feedOk(s);
});

test('the turn a sub-agent\'s end wakes: running, a message waits for it, its result lets the message go', () => {
  const { s, host } = rig();
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  assert.equal(s.state, 'idle');
  host.say({ t: 'text', uuid: U(5), chunk: 'it reported' });
  assert.equal(s.state, 'running', 'nobody\'s message opened this turn');
  assert.deepEqual(s.send('next', U(2)), { ok: true, via: 'queued' });
  assert.equal(host.frames().filter((f) => f.t === 'user').length, 1, 'the stop can still take it back');
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: null });
  assert.equal(host.frames().filter((f) => f.t === 'user').length, 2);
  assert.equal(s.state, 'running', 'the message opened a turn of its own');
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(2) });
  assert.equal(s.state, 'idle');
});

for (const [what, frame] of [
  ['an ask of its own (a reply that only dispatches the next one)', rootAsk()],
  ['a refusal of its own', { t: 'denied-auto', toolUseId: 'r1', name: 'Agent', why: 'agent-input' }],
] as const) {
  test(`a woken turn that opens with ${what}: running, so a message waits and a stop reaches it`, async () => {
    const run = (): ReturnType<typeof rig> => {
      const r = rig();
      r.host.say(start());
      r.host.say(result(U(1)));
      r.host.say(end('completed'));
      assert.equal(r.s.state, 'idle');
      r.host.say(frame);
      return r;
    };
    const a = run();
    assert.equal(a.s.state, 'running');
    assert.deepEqual(a.s.send('next', U(2)), { ok: true, via: 'queued' });
    assert.equal(a.host.frames().filter((f) => f.t === 'user').length, 1, 'no message reaches the CLI while a turn runs');
    a.host.say(result());
    assert.equal(a.host.frames().filter((f) => f.t === 'user').length, 2, 'its result lets the message go');
    const b = run();
    await b.s.interrupt();
    assert.equal(b.host.frames().filter((f) => f.t === 'interrupt').length, 1, 'the turn is stopped, not only the card');
  });
}

test('a sub-agent\'s own ask is no turn of the root: the session stays idle', () => {
  const { s, host, approvals } = rig();
  host.say(start());
  host.say(result(U(1)));
  host.say(ask());
  assert.equal(approvals.list().length, 1);
  assert.equal(s.state, 'idle');
  host.say(ask({ reqId: 'c'.repeat(32), agentId: 'never-announced' }));
  assert.equal(s.state, 'idle', 'an agent id nobody announced is a sub-agent all the same');
});

test('a stop reaches a woken turn', async () => {
  const { s, host } = rig();
  host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  host.say({ t: 'tool', toolUseId: 't1', name: 'Read' });
  await s.interrupt();
  assert.equal(host.frames().filter((f) => f.t === 'interrupt').length, 1);
});

test('past the bound a member is counted once and said, and its card still comes', () => {
  const { s, host, approvals } = rig();
  for (let i = 0; i < MEMBER_LIMITS.members; i++) host.say(start({ taskId: `t${i}`, reply: null }));
  host.say(start({ taskId: 'over', reply: null }));
  host.say(start({ taskId: 'over', reply: null }));
  assert.deepEqual([s.members.length, s.membersOver], [MEMBER_LIMITS.members, 1]);
  assert.equal(events(s).filter((e) => e.state === 'members-over').at(-1)!.text, '1');
  host.say(ask({ agentId: 'over' }));
  assert.match(approvals.list()[0]!.preview, /^from subagent: name unknown \(task …over\)/);
});

test('past the bound with the root idle: the stop is offered and reaches it, and what is not heard of is said', async () => {
  const past = () => {
    const r = rig();
    for (let i = 0; i < MEMBER_LIMITS.members; i++) {
      r.host.say(start({ taskId: `t${i}`, reply: null }));
      r.host.say(end('completed', `t${i}`));
    }
    r.host.say(start({ taskId: 'over', reply: null }));
    r.host.say(result(U(1)));
    assert.deepEqual([r.s.state, r.s.members.length, r.s.membersOver], ['idle', MEMBER_LIMITS.members, 1]);
    return r;
  };
  const a = past();
  assert.equal(a.s.stoppable, true);
  await a.s.interrupt();
  assert.equal(a.host.frames().filter((f) => f.t === 'interrupt').length, 1);
  await stopRead(a.clock);
  assert.deepEqual(notes(a.s).filter((n) => !n.startsWith('members-over')), ['members-not-stopped=1']);
  assert.equal(a.s.stoppable, true, 'no end heard');
  feedOk(a.s);
  const b = past();
  await b.s.interrupt();
  b.host.say(end('stopped', 'over'));
  await stopRead(b.clock);
  assert.deepEqual(notes(b.s).filter((n) => !n.startsWith('members-over')), ['members-stopped=1']);
  assert.deepEqual([b.s.stoppable, b.s.membersOver], [false, 1], 'still counted, nothing left to stop');
  const c = past();
  c.host.say(end('completed', 'over'));
  assert.equal(c.s.stoppable, false, 'one that ended by itself keeps no stop on offer');
  await c.s.interrupt();
  assert.equal(c.host.frames().filter((f) => f.t === 'interrupt').length, 0);
});

test('the run a request reads: out with a member running and with the turn its end is owed, whole after that turn, cut by a stop or the session\'s end', async () => {
  const a = rig();
  assert.equal(a.s.run, 'whole');
  a.host.say(start());
  a.host.say(result(U(1)));
  assert.equal(a.s.run, 'out', 'the root ended its turn, the sub-agent did not');
  a.host.say(end('completed'));
  assert.deepEqual([a.s.state, a.s.run], ['idle', 'out'], 'the CLI owes the model a turn about it');
  a.host.say({ t: 'text', uuid: U(5), chunk: 'it reported' });
  assert.equal(a.s.run, 'out');
  a.host.say(result());
  assert.equal(a.s.run, 'whole');
  // One that ended inside a turn: a turn of its own may follow; none does, and the wait ends.
  const b = rig();
  b.host.say(start());
  b.host.say(end('completed'));
  b.host.say(result(U(1)));
  assert.equal(b.s.run, 'out');
  b.clock.advanceBy(CLAUDE_DEADLINES.wakeWaitMs - 1);
  assert.equal(b.s.run, 'out');
  b.clock.advanceBy(1);
  assert.equal(b.s.run, 'whole');
  // One does: it runs as long as it takes.
  const c = rig();
  c.host.say(start());
  c.host.say(end('completed'));
  c.host.say(result(U(1)));
  c.host.say({ t: 'text', uuid: U(5), chunk: 'it reported' });
  c.clock.advanceBy(CLAUDE_DEADLINES.wakeWaitMs);
  assert.equal(c.s.run, 'out');
  const d = rig();
  d.host.say(start());
  d.host.say(result(U(1)));
  await d.s.interrupt();
  d.host.say(end('stopped'));
  assert.equal(d.s.run, 'cut', 'a stop wakes nothing and its report never comes');
  const e = rig();
  e.host.say(start());
  e.host.say(result(U(1)));
  e.s.end();
  assert.equal(e.s.run, 'cut');
  const f = rig();
  f.host.say(start());
  f.host.say(result(U(1)));
  f.host.say(end('completed'));
  f.s.end();
  assert.equal(f.s.run, 'cut', 'the turn it was owed never came');
});

test('a seat request waits for the turn the sub-agent\'s end wakes: that is its answer, and until then a withdraw still ends the session', () => {
  const seatRig = () => {
    const r = rig(true, { tainted: true });
    const ended: string[] = [];
    const requests = makeRequests({
      after: oneShot(r.clock, 'requests-test'), nowMono: () => r.clock.mono, nowWall: () => r.clock.wall, redact: (text) => ({ text, count: 0 }),
      observe: () => r.s, endOwned: (id) => {
        ended.push(id);
        r.s.end('requester-withdrew');
        return true;
      },
    });
    const made = requests.create({ harness: 'claude', text: 'hello', cwd: 'C:\\x', label: null, requester: { kind: 'dsh', sessionId: 'sess-1' } });
    assert.ok(made.ok);
    const id = made.request.requestId;
    assert.equal(requests.bind(id, OWNED), true);
    r.host.say(start());
    r.host.say({ t: 'text', uuid: U(4), chunk: 'Started a sub-agent, it will report back.' });
    r.host.say(result(U(1)));
    r.clock.advanceBy(2_000);
    return { ...r, requests, ended, id, key: made.withdrawKey };
  };
  const a = seatRig();
  assert.deepEqual([a.requests.get(a.id)!.state, a.requests.get(a.id)!.output, a.s.state], ['running', null, 'idle'], 'no answer yet (T1)');
  a.host.say(end('completed'));
  a.clock.advanceBy(2_000);
  assert.equal(a.requests.get(a.id)!.state, 'running', 'its turn is still to come');
  a.host.say({ t: 'text', uuid: U(5), chunk: 'THE REAL ANSWER' });
  a.host.say(result());
  a.clock.advanceBy(2_000);
  assert.deepEqual([a.requests.get(a.id)!.state, a.requests.get(a.id)!.output], ['done', 'THE REAL ANSWER']);
  const b = seatRig();
  const w = b.requests.withdraw(b.id, b.key);
  assert.deepEqual(w.ok ? w.request.state : w.why, 'withdrawn');
  assert.deepEqual(b.ended, [OWNED], 'the sub-agent does not run on for nobody');
  assert.equal(b.s.members[0]!.state, 'unknown');
  // A person stops it, or ends the session: no answer came, and it does not say one did.
  const c = seatRig();
  void c.s.interrupt();
  c.host.say(end('stopped'));
  assert.deepEqual([c.requests.get(c.id)!.state, c.requests.get(c.id)!.why, c.requests.get(c.id)!.output], ['failed', 'turn-interrupted', null]);
  const d = seatRig();
  d.s.end();
  assert.deepEqual([d.requests.get(d.id)!.state, d.requests.get(d.id)!.why], ['failed', 'session-you-ended']);
});

test('the record keeps its members, and a restart lists them: one that was live is unknown, its session too', async () => {
  const files = new Map<string, string>();
  const registry = makeOwnedRegistry({ dir: 'C:\\o\\owned', writeAtomic: (f, t) => void files.set(f, t), readdir: () => [...files.keys()].map((f) => f.slice(f.lastIndexOf('\\') + 1)), readFile: (f) => files.get(f)! });
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const host = fakePipe(true);
  const owned = new ClaudeOwned({
    approvals, makeWorkDir: () => 'C:\\o\\work\\x', makeConfigDir: () => 'C:\\o\\claude\\x', launch: () => host.pipe, claudeExe: 'C:\\x\\claude.exe', protectedRoots: [], hub: clock,
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), registry,
  });
  const made = owned.create({ text: 'go', uuid: U(1) });
  assert.ok(made.ok);
  host.say({ t: 'init', sessionId: SID });
  host.say(start({ taskId: 'a1' }));
  host.say(start({ taskId: 'a2' }));
  host.say(end('completed', 'a2'));
  host.say(ask({ agentId: 'a1' }));
  const seats = owned.towerSeats();
  assert.equal(seats[0]!.members!.find((m) => m.threadId === 'a1')!.asking, approvals.list()[0]!.title, 'the tower says which member waits');
  const record = parseOwnedRecord([...files.values()][0]!) as OwnedRecord;
  assert.deepEqual(record.members!.map((m) => [m.threadId, m.state, m.agentType]), [['a1', 'running', 'general-purpose'], ['a2', 'returned', 'general-purpose']]);

  const again = new ClaudeOwned({
    approvals: new Approvals({ hub: clock, settleMs: 0 }), makeWorkDir: () => '', makeConfigDir: () => '', launch: () => host.pipe, claudeExe: 'C:\\x\\claude.exe', protectedRoots: [], hub: clock,
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), registry,
  });
  const back = again.list()[0]!;
  assert.deepEqual([back.state, back.endReason, back.stoppable], ['unknown', 'daemon-restart', false]);
  assert.deepEqual(back.members.map((m) => m.state), ['unknown', 'returned']);
  assert.deepEqual(again.towerSeats()[0]!.members!.map((m) => m.state), ['unknown', 'returned']);
});

test('a record of an earlier build reads, and its type is checked', () => {
  const row = { threadId: 't', name: null, model: null, state: 'returned', why: null, startedAt: null, endedAt: null, failed: 0, ranUnasked: 0, batch: null };
  const base = { v: 1, ownedId: OWNED, harness: 'claude', model: MODEL, title: '', createdAt: 1, state: 'ended', endReason: 'you-ended', membersOver: 0 };
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [row] }))!.members![0]!.agentType, null);
  assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [{ ...row, agentType: 'Plan' }] }))!.members![0]!.agentType, 'Plan');
  for (const bad of ['', 7, 'x'.repeat(REGISTRY_LIMITS.memberNameBytes + 1)]) assert.equal(parseOwnedRecord(JSON.stringify({ ...base, members: [{ ...row, agentType: bad }] })), null, String(bad));
});
