import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { HostPipe } from '../../src/os/owned-proc.ts';
import type { JobOutcome, OwnedJob } from '../../src/os/procguard.ts';
import type { CodexSession } from '../../src/owned/codex-session.ts';
import type { ClaudeSession } from '../../src/owned/claude-session.ts';
import { HOST_STOP_MS } from '../../src/os/owned-proc.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { startCodexSession, treeNote } from '../../src/owned/codex-session.ts';
import { startClaudeSession } from '../../src/owned/claude-session.ts';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import { OWNED_TOWER_TEXT } from '../../shared/owned-contract.js';
import { TOWER_TEXT } from '../../shared/strings.js';
import { ownedNode } from '../../src/sources/tower.ts';

// The owned sessions' Jobs and brake (orchestra app: owned sessions in procguard Jobs; r4 D4, D8), over
// in-memory pipes, a fake Job and a virtual clock: no child, no procguard. The brake ends the Job first,
// declines the open approvals (D8: nothing is allowed on the way out), ends the session as braked and
// says what the Job held; an end of any kind checks the Job once the child closed. Synthetic data only.

const CWD = 'C:\\Users\\u\\.orchestra\\work\\0123456789abcdef0123';
const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

type FakeJob = { job: OwnedJob; calls: number; answer: JobOutcome };
function fakeJob(answer: JobOutcome = { ok: true, found: true, killed: 3, left: 0 }): FakeJob {
  const f: FakeJob = {
    calls: 0, answer,
    job: Object.freeze({
      name: `orchestra-job-${'d'.repeat(32)}`,
      endTree: async () => {
        f.calls++;
        return f.answer;
      },
      procs: async () => [],
    }),
  };
  return f;
}

function memPipe(job: OwnedJob | null) {
  const out: ((c: Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const written: string[] = [];
  let stopped = 0;
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
    stop: () => {
      stopped++;
    },
  };
  return {
    pipe,
    stopped: () => stopped,
    sent: () => written.map((w) => JSON.parse(w) as Record<string, any>),
    send: (msg: unknown) => out.forEach((cb) => cb(Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'))),
    close: (code: number | null) => closes.forEach((cb) => cb(code, null)),
  };
}

async function codex(job: OwnedJob | null) {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const m = memPipe(job);
  const started = startCodexSession({
    ownedId: '0123456789abcdef0123', cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals, now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  });
  assert.ok(started.ok);
  const s = started.session;
  await settle();
  m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } } });
  assert.equal(await s.ready, true);
  return { m, s, approvals, clock };
}

const notes = (s: CodexSession | ClaudeSession) => s.feed.since(0).events.filter((e) => e.kind === 'note' || e.kind === 'lifecycle' || e.kind === 'auto-denied').map((e) => `${e.kind}:${e.state}${e.text === null ? '' : `=${e.text}`}`);
const feedOk = (s: CodexSession | ClaudeSession) => {
  const page = s.feed.since(0);
  const v = validateOwnedFeed({
    v: 1, kind: 'owned-feed', ownedId: s.ownedId, from: page.from, to: page.to, clipped: page.clipped,
    events: page.events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, uuid: e.uuid, text: e.text, state: e.state, redactions: e.redactions, live: e.live, exitCode: e.exitCode ?? null, tokens: e.tokens === undefined ? null : { ...e.tokens }, batch: e.batch ?? null })),
  });
  assert.ok(v.ok, v.errors.join('\n'));
};

test('treeNote: the Job\'s end as the feed says it, never "none left" when procguard could not say (T1)', () => {
  assert.deepEqual(treeNote({ ok: true, found: true, killed: 4, left: 0 }), { state: 'tree-stopped', text: '4' });
  assert.deepEqual(treeNote({ ok: true, found: true, killed: 0, left: 0 }), { state: 'tree-ended', text: null });
  assert.deepEqual(treeNote({ ok: true, found: false, killed: 0, left: 0 }), { state: 'tree-ended', text: null });
  assert.deepEqual(treeNote({ ok: true, found: true, killed: 4, left: 1 }), { state: 'tree-left', text: '1' });
  assert.deepEqual(treeNote({ ok: false, why: 'procguard-timeout' }), { state: 'tree-unsure', text: 'procguard-timeout' });
});

test('codex brake: the Job is ended first, the open approval declined (cause brake), the session ends as braked, the child\'s handle goes; the feed counts what the Job held', async () => {
  const fj = fakeJob();
  const { m, s, approvals } = await codex(fj.job);
  assert.equal(s.jobbed, true);
  m.send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', turnId: 't1', itemId: 'cmd_1', command: 'ping -t 127.0.0.1', cwd: CWD } });
  await settle();
  assert.equal(approvals.list().length, 1);
  const r = await s.brake();
  assert.deepEqual(r, { ok: true, killed: 3, left: 0 });
  assert.equal(fj.calls, 1);
  assert.deepEqual([s.state, s.endReason, s.jobbed], ['ended', 'braked', false]);
  assert.equal(approvals.list().length, 0);
  assert.deepEqual(m.sent().find((x) => x.id === 'srv-1')?.result, { decision: 'decline' }, 'the brake declines, never allows');
  assert.ok(m.stopped() >= 1, 'the wrapper is stopped too');
  const ns = notes(s);
  assert.ok(ns.includes('auto-denied:brake'), ns.join(' '));
  assert.ok(ns.includes('lifecycle:braked'));
  assert.ok(ns.includes('note:tree-stopped=3'));
  assert.ok(!ns.includes('note:children-may-remain'));
  // The close that follows is the brake's: the Job is not checked a second time.
  m.close(1);
  await settle();
  assert.equal(fj.calls, 1);
  assert.deepEqual(await s.brake(), { ok: false, reason: 'ended' });
  assert.equal(s.send('more', U(2)).ok, false);
  feedOk(s);
});

test('codex brake without a Job is refused (no-job) and changes nothing; procguard that cannot say leaves the counts unknown', async () => {
  const none = await codex(null);
  assert.equal(none.s.jobbed, false);
  assert.deepEqual(await none.s.brake(), { ok: false, reason: 'no-job' });
  assert.equal(none.s.state, 'idle');
  // Ending it without a Job says what a kill of codex.exe alone leaves, as before.
  none.s.end();
  assert.ok(notes(none.s).includes('note:children-may-remain'));
  const unsure = await codex(fakeJob({ ok: false, why: 'procguard-timeout' }).job);
  assert.deepEqual(await unsure.s.brake(), { ok: true, killed: null, left: null });
  assert.equal(unsure.s.endReason, 'braked');
  assert.ok(notes(unsure.s).includes('note:tree-unsure=procguard-timeout'));
  feedOk(unsure.s);
});

test('codex end, failure or exit with a Job: once the child closed its Job is checked, and the feed says what was found (no children-may-remain)', async () => {
  const ended = fakeJob({ ok: true, found: false, killed: 0, left: 0 });
  const a = await codex(ended.job);
  a.s.end();
  assert.equal(ended.calls, 0, 'not before the child closed');
  a.m.close(1);
  await settle();
  assert.equal(ended.calls, 1);
  assert.deepEqual(notes(a.s).filter((n) => n.startsWith('note:')), ['note:tree-ended']);
  // A child that exits by itself: its Job is checked the same way; what was left in it is counted.
  const left = fakeJob({ ok: true, found: true, killed: 2, left: 0 });
  const b = await codex(left.job);
  b.m.close(3);
  await settle();
  assert.deepEqual([b.s.state, b.s.endReason], ['failed', 'exited']);
  assert.ok(notes(b.s).includes('note:tree-stopped=2'));
  assert.ok(!notes(b.s).includes('note:children-may-remain'));
  feedOk(b.s);
});

test('daemon-stop with Jobs: every session\'s child is stopped and each Job is checked once its child closed', async () => {
  const clock = new VirtualClock({ mono: 1, wall: 1 });
  const pipes: ReturnType<typeof memPipe>[] = [];
  const jobs: FakeJob[] = [];
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock }), makeWorkDir: (id) => `C:\\w\\${id}`, now: () => 1, redact: (text) => ({ text, count: 0 }), hub: clock,
    launch: () => {
      const j = fakeJob({ ok: true, found: false, killed: 0, left: 0 });
      jobs.push(j);
      const p = memPipe(j.job);
      pipes.push(p);
      return p.pipe;
    },
  });
  assert.ok(owned.create().ok);
  assert.ok(owned.create().ok);
  assert.equal(owned.endAll(), 2);
  assert.ok(pipes.every((p) => p.stopped() >= 1));
  for (const p of pipes) p.close(null);
  await settle();
  assert.deepEqual(jobs.map((j) => j.calls), [1, 1]);
  assert.ok(owned.list().every((s) => s.endReason === 'daemon-stop' && !s.jobbed));
});

// --- the Claude host ---------------------------------------------------------------------------------------

function hostFake(job: OwnedJob | null) {
  const written: string[] = [];
  let onClose: ((code: number | null, signal: string | null) => void) | null = null;
  let out: ((c: Buffer) => void) | null = null;
  const f = {
    kills: 0, stdinClosed: false,
    pipe: Object.freeze({
      pid: 4242, job,
      write: (d: string) => {
        if (!f.stdinClosed) written.push(d);
      },
      onStdout: (cb: (c: Buffer) => void) => { out = cb; },
      onStderr: () => {},
      onClose: (cb: (code: number | null, signal: string | null) => void) => { onClose = cb; },
      onError: () => {},
      closeStdin: () => { f.stdinClosed = true; },
      kill: () => { f.kills++; },
    }) as HostPipe,
    frames: () => written.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>),
    say: (frame: Record<string, unknown>) => out?.(Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')),
    close: (code: number | null = 0) => onClose?.(code, null),
  };
  return f;
}

function claude(job: OwnedJob | null) {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const host = hostFake(job);
  const started = startClaudeSession({
    ownedId: 'c'.repeat(20), cwd: 'C:\\o\\work\\cccccccccccccccccccc', configDir: 'C:\\o\\claude\\cccccccccccccccccccc', model: DEFAULT_CLAUDE_MODEL,
    claudeExe: 'C:\\x\\claude.exe', protectedRoots: ['C:\\o'], askTimeoutMs: 60_000, launch: () => host.pipe, approvals,
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  }, { text: 'hello', uuid: U(1) });
  assert.ok(started.ok);
  return { clock, approvals, host, s: started.session };
}

test('claude brake: the Job first, the open ask declined with a perm frame, braked, the host\'s handle at once (no stop order)', async () => {
  const fj = fakeJob({ ok: true, found: true, killed: 5, left: 0 });
  const { host, s, approvals } = claude(fj.job);
  host.say({ t: 'init', sessionId: '11111111-2222-4333-8444-555555555555', model: DEFAULT_CLAUDE_MODEL, cliVersion: '2.1.287' });
  host.say({ t: 'ask', reqId: 'a'.repeat(32), toolName: 'Write', toolUseId: 'toolu_1', preview: 'file_path: a.txt', inputBytes: 10, digest: 'b'.repeat(64), redactions: 0, tooLong: false, risk: 'write', paths: [] });
  await settle();
  assert.equal(approvals.list().length, 1);
  assert.equal(s.jobbed, true);
  assert.deepEqual(await s.brake(), { ok: true, killed: 5, left: 0 });
  assert.deepEqual([s.state, s.endReason], ['ended', 'braked']);
  assert.deepEqual(host.frames().filter((f) => f.t === 'perm').map((f) => f.allow), [false]);
  assert.equal(host.kills, 1, 'the handle goes at once');
  assert.equal(host.stdinClosed, true);
  assert.ok(notes(s).includes('note:tree-stopped=5'));
  host.close(1);
  await settle();
  assert.equal(fj.calls, 1, 'the close after the brake checks nothing again');
  feedOk(s);
});

test('claude end with a Job: the stop order\'s kill says no host-killed (the Job took claude.exe too); the check after the close does', async () => {
  const fj = fakeJob({ ok: true, found: false, killed: 0, left: 0 });
  const { host, s, clock } = claude(fj.job);
  s.end();
  clock.advanceBy(HOST_STOP_MS.afterClose);
  await settle();
  clock.advanceBy(HOST_STOP_MS.afterEof);
  await settle();
  assert.equal(host.kills, 1);
  assert.ok(!notes(s).includes('note:host-killed'));
  host.close(null);
  await settle();
  assert.ok(notes(s).includes('note:tree-ended'));
  // Without a Job the old note stays.
  const old = claude(null);
  old.s.end();
  old.clock.advanceBy(HOST_STOP_MS.afterClose);
  await settle();
  old.clock.advanceBy(HOST_STOP_MS.afterEof);
  await settle();
  assert.ok(notes(old.s).includes('note:host-killed'));
  assert.deepEqual(await old.s.brake(), { ok: false, reason: 'no-job' });
  old.host.close(null);
  await settle();
  assert.deepEqual(await old.s.brake(), { ok: false, reason: 'ended' });
});

test('GET /api/owned: each entry says whether it has a brake, the list says why new sessions have none; an ended session whose child closed has no brake', async () => {
  const fj = fakeJob();
  const { s } = await codex(fj.job);
  const clock = new VirtualClock({ mono: 1, wall: 1 });
  const approvals = new Approvals({ hub: clock });
  const fake = { list: () => [s], meta: () => ({ title: 't', createdAt: 1 }), get: () => s, approvals, maxActive: 3, full: () => false, active: () => 1 } as unknown as CodexOwned;
  const on = ownedList({ codex: fake, claude: null, codexOff: 'on', brakeWhy: null });
  assert.equal(on.brakeWhy, null);
  assert.equal(on.owned[0]!.brake, true);
  assert.ok(validateOwnedList(on).ok);
  const off = ownedList({ codex: fake, claude: null, codexOff: 'on', brakeWhy: 'procguard-build-failed' });
  assert.equal(off.brakeWhy, 'procguard-build-failed');
  assert.equal(ownedList({ codex: fake, claude: null, codexOff: 'on' }).brakeWhy, 'not-asked', 'T1: no procguard says so');
  // Read at each list when it is a function (working.ts: a resident procguard that went away says so).
  let why: string | null = null;
  const live = { codex: fake, claude: null, codexOff: 'on', brakeWhy: () => why };
  assert.equal(ownedList(live).brakeWhy, null);
  why = 'procguard-resident-gone';
  assert.equal(ownedList(live).brakeWhy, 'procguard-resident-gone');
  assert.ok(validateOwnedList(ownedList(live)).ok);
  await s.brake();
  const after = ownedList({ codex: fake, claude: null, codexOff: 'on', brakeWhy: null });
  assert.deepEqual([after.owned[0]!.state, after.owned[0]!.endReason, after.owned[0]!.brake], ['ended', 'braked', false]);
  assert.ok(validateOwnedList(after).ok);
  // An ended session still stopping may carry a brake; one an earlier orchestrad left never does.
  assert.ok(validateOwnedList({ ...after, owned: [{ ...after.owned[0]!, brake: true }] }).ok);
  const lying = { ...after, owned: [{ ...after.owned[0]!, state: 'unknown', endReason: 'daemon-restart', brake: true }] };
  assert.ok(!validateOwnedList(lying).ok, 'a session an earlier orchestrad left with a brake is refused by the contract');
  assert.ok(!validateOwnedList({ ...after, brakeWhy: 'Not A Code' }).ok);
});

// --- phase 4 review ----------------------------------------------------------------------------------------

test('claude brake while the stop order runs (an end, a failure): the Job is ended, the rest of the order gives way, the host goes at once; the end reason stays', async () => {
  const fj = fakeJob({ ok: true, found: true, killed: 4, left: 0 });
  const { host, s, clock } = claude(fj.job);
  s.end();
  assert.deepEqual([s.state, s.endReason], ['ended', 'you-ended']);
  assert.equal(s.jobbed, true, 'the host has not closed: the brake still reaches it');
  // Within the order's first 3 s, before stdin is closed: the person brakes.
  clock.advanceBy(1_000);
  await settle();
  assert.equal(host.kills, 0);
  assert.deepEqual(await s.brake(), { ok: true, killed: 4, left: 0 });
  assert.equal(fj.calls, 1);
  assert.equal(host.kills, 1, 'the host goes now, not after 5 s');
  assert.deepEqual([s.state, s.endReason, s.jobbed], ['ended', 'you-ended', false]);
  const ns = notes(s);
  assert.ok(ns.includes('lifecycle:braked') && ns.includes('note:tree-stopped=4'), ns.join(' '));
  // The order's remaining steps were cancelled: no second kill when their time comes.
  clock.advanceBy(HOST_STOP_MS.afterClose + HOST_STOP_MS.afterEof);
  await settle();
  assert.equal(host.kills, 1);
  host.close(null);
  await settle();
  assert.equal(fj.calls, 1, 'the close after the brake checks nothing again');
  assert.deepEqual(await s.brake(), { ok: false, reason: 'ended' });
  feedOk(s);
});

test('codex brake after an end, before its child closed: the Job is ended and counted, the end reason stays; once closed, owned-ended', async () => {
  const fj = fakeJob({ ok: true, found: true, killed: 2, left: 0 });
  const { m, s } = await codex(fj.job);
  s.end();
  assert.equal(s.jobbed, true);
  assert.deepEqual(await s.brake(), { ok: true, killed: 2, left: 0 });
  assert.deepEqual([s.endReason, s.jobbed], ['you-ended', false]);
  m.close(null);
  await settle();
  assert.equal(fj.calls, 1);
  const b = await codex(fakeJob().job);
  b.s.end();
  b.m.close(null);
  await settle();
  assert.equal(b.s.jobbed, false);
  assert.deepEqual(await b.s.brake(), { ok: false, reason: 'ended' });
});

test('the tower row of a braked session never says the tree stopped (T1: the brake may have left some, or procguard could not say)', () => {
  const seat = { ownedId: '0123456789abcdef0123', harness: 'codex' as const, title: 't', state: 'ended' as const, endReason: 'braked', waiting: null, lastAt: 1, recent: null };
  const node = ownedNode(seat as never, 2);
  assert.equal(node.activity, OWNED_TOWER_TEXT['end.braked']);
  for (const text of [OWNED_TOWER_TEXT['end.braked'], TOWER_TEXT['op.braked'], TOWER_TEXT['fnote.tree-ended'], TOWER_TEXT['fnote.tree-stopped'], TOWER_TEXT['dock.brake']]) {
    assert.ok(!/整棵进程树已停|已停$/.test(text), text);
  }
  // What a Job cannot hold is said as unknown wherever "all stopped" is said.
  for (const k of ['op.braked', 'fnote.tree-ended', 'fnote.tree-stopped']) assert.match(TOWER_TEXT[k], /不在 Job 里，是否还在未知/, k);
});
