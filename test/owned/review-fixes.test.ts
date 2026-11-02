import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { CodexSession, PathJudge } from '../../src/owned/codex-session.ts';
import type { OwnedRecord } from '../../src/owned/registry.ts';
import { CwdPolicy } from '../../src/os/cwd.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { CODEX_DEADLINES, startCodexSession } from '../../src/owned/codex-session.ts';
import { OWNED_DIRS } from '../../src/owned/codex-home.ts';
import { OWNED_WORK_NAME } from '../../src/os/cwd.ts';
import { afterRestart, makeOwnedRegistry, parseOwnedRecord } from '../../src/owned/registry.ts';
import { liveTail } from '../../src/owned/text.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { ownedList } from '../../src/server/owned-handlers.ts';
import { towerFromStage } from '../../src/sources/tower.ts';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { busyStage } from '../helpers/tower-fixture.ts';

// Phase 2 review fixes of the owned Codex sessions, over an in-memory pipe and a virtual clock: no child,
// no codex.exe, no file. Synthetic data only.

const WORK = 'C:\\Users\\u\\.orchestra\\work';
const CWD = `${WORK}\\0123456789abcdef0123`;
const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function memPipe() {
  const out: ((c: Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const errors: ((code: string) => void)[] = [];
  const written: string[] = [];
  let stopped = 0;
  const pipe: ChildPipe = {
    pid: 1,
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
    onError: (cb) => {
      errors.push(cb);
    },
    stop: () => {
      stopped++;
    },
  };
  return {
    pipe,
    stopped: () => stopped,
    sent: () => written.map((w) => JSON.parse(w) as Record<string, any>),
    send: (msg: unknown) => out.forEach((cb) => cb(Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'))),
    fail: (code: string) => errors.forEach((cb) => cb(code)),
    close: (code: number | null) => closes.forEach((cb) => cb(code, null)),
  };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

type Rig = { m: ReturnType<typeof memPipe>; s: CodexSession; clock: VirtualClock; approvals: Approvals };

function rig(opts: { judge?: PathJudge; redact?: (t: string) => { text: string; count: number } } = {}): Rig {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const m = memPipe();
  const started = startCodexSession({
    ownedId: '0123456789abcdef0123', cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals, now: () => clock.wall,
    redact: opts.redact ?? ((text) => ({ text, count: 0 })), hub: clock, ...(opts.judge !== undefined ? { judge: opts.judge } : {}),
  });
  assert.ok(started.ok);
  return { m, s: started.session, clock, approvals };
}

/** Answers initialize and thread/start as codex does. */
async function ready(r: Rig): Promise<void> {
  await settle();
  r.m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  r.m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } });
  assert.equal(await r.s.ready, true);
}

const events = (s: CodexSession) => s.feed.since(0).events;

test('a pipe that fails while the child may still run: the child is stopped, the session failed, and it frees its seat', async () => {
  const r = rig();
  await ready(r);
  r.m.fail('EPIPE');
  await settle();
  assert.equal(r.s.state, 'failed');
  assert.ok(r.m.stopped() >= 1, 'codex.exe is stopped, not left running unseen');
  assert.ok(events(r.s).some((e) => e.kind === 'note' && e.state === 'children-may-remain'), 'the feed says what a kill of codex.exe alone leaves');
  // The same through CodexOwned: a failed session does not count against the limit, and its child was stopped.
  const clock = new VirtualClock({ mono: 1, wall: 1 });
  const pipes: ReturnType<typeof memPipe>[] = [];
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock }), makeWorkDir: (id) => `${WORK}\\${id}`, now: () => 1, redact: (text) => ({ text, count: 0 }), maxActive: 1,
    launch: () => {
      const p = memPipe();
      pipes.push(p);
      return p.pipe;
    },
  });
  assert.ok(owned.create({}).ok);
  assert.deepEqual(owned.create({}), { ok: false, reason: 'owned-limit', detail: '1 running' });
  pipes[0]!.fail('EPIPE');
  await settle();
  assert.ok(pipes[0]!.stopped() >= 1, 'stopped (childPipe.stop is idempotent)');
  assert.ok(owned.create({}).ok, 'the seat is free once its child was stopped');
});

test('approval paths: resolved against the work dir first; outside it is held; a protected place (by realpath, a junction too) is declined with no card', async () => {
  // Without a judge: a relative path climbing out is outside the work dir (it read as inside before).
  const r = rig();
  await ready(r);
  r.m.send({ method: 'item/started', params: { threadId: 'thr', item: { type: 'fileChange', id: 'fc1', changes: [{ path: 'sub\\..\\..\\..\\x.txt', kind: { type: 'add' }, diff: '+x' }] } } });
  r.m.send({ id: 'srv-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thr', itemId: 'fc1', reason: 'r' } });
  await settle();
  const [card] = r.approvals.list();
  assert.ok(card !== undefined);
  assert.equal(card.risk, 'protected');
  assert.equal(card.high, true, 'outside the work dir: held or typed');
  assert.ok(card.preview.includes('(outside the work dir) C:\\Users\\u\\.orchestra\\x.txt'), card.preview);

  // With the spawn gate's table: the data dir, a harness root and a junction out of the work dir are refused at once.
  const links: Record<string, string> = { [`${CWD}\\link`.toLowerCase()]: 'C:\\Users\\u\\.claude' };
  const realpath = (p: string) => {
    const k = p.toLowerCase();
    for (const [from, to] of Object.entries(links)) if (k === from || k.startsWith(`${from}\\`)) return to + p.slice(from.length);
    if (k.startsWith('c:\\users\\u') || k === 'c:\\' || k === 'c:\\windows') return p;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const policy = new CwdPolicy({
    spec: { allowedRoots: [WORK], protectedDirs: ['C:\\Users\\u\\.orchestra'], userHome: 'C:\\Users\\u', ownedWorkRoot: WORK },
    env: {}, systemRoot: 'C:\\Windows', realpath,
  });
  assert.deepEqual(policy.place(`${CWD}\\notes.txt`), { real: `${CWD}\\notes.txt`, hit: null });
  assert.equal(policy.place('C:\\Users\\u\\.orchestra\\journal\\x').hit, 'protected');
  assert.equal(policy.place(`${CWD}\\link\\settings.json`).hit, 'user-profile\\.claude');
  assert.equal(policy.place('relative\\x').hit, 'bad-path:not-absolute');
  const p = rig({ judge: (x) => policy.place(x) });
  await ready(p);
  const ask = (n: number, path: string) => {
    p.m.send({ method: 'item/started', params: { threadId: 'thr', item: { type: 'fileChange', id: `fc${n}`, changes: [{ path, kind: { type: 'update' }, diff: '+x' }] } } });
    p.m.send({ id: `srv-${n}`, method: 'item/fileChange/requestApproval', params: { threadId: 'thr', itemId: `fc${n}` } });
  };
  ask(1, 'C:\\Users\\u\\.orchestra\\codex-home\\config.toml');
  ask(2, 'link\\settings.json');
  ask(3, 'notes.txt');
  p.m.send({ id: 'srv-4', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', itemId: 'c4', command: 'dir', cwd: 'C:\\Users\\u\\.orchestra' } });
  await settle();
  const answers = p.m.sent().filter((x) => typeof x.id === 'string');
  assert.deepEqual(answers.map((x) => [x.id, x.result.decision]), [['srv-1', 'decline'], ['srv-2', 'decline'], ['srv-4', 'decline']], 'declined at once, no card');
  assert.deepEqual(p.approvals.list().map((a) => [a.kind, a.risk]), [['file-change', 'write']], 'only the change inside the work dir waits for a person');
  const auto = events(p.s).filter((e) => e.kind === 'auto-denied');
  assert.deepEqual(auto.map((e) => e.state), ['protected', 'protected', 'protected']);
  assert.ok(auto[1]!.text!.includes('user-profile\\.claude'), auto[1]!.text!);
});

test('request deadlines: a silent start fails the session; a silent turn/start leaves the message unsure; an interrupt never hangs', async () => {
  const quiet = rig();
  await settle();
  quiet.clock.advanceBy(CODEX_DEADLINES.startMs);
  await settle();
  assert.deepEqual([quiet.s.state, quiet.s.endReason], ['failed', 'start-failed']);
  assert.equal(await quiet.s.ready, false);

  const r = rig();
  await ready(r);
  assert.deepEqual(r.s.send('hello', U(1)), { ok: true, via: 'turn/start' });
  await settle();
  r.clock.advanceBy(CODEX_DEADLINES.turnMs);
  await settle();
  const fate = events(r.s).filter((e) => e.ref === U(1)).at(-1)!;
  assert.equal(fate.state, 'msg-unsure', 'sent, but whether codex took it nobody knows (T1)');
  assert.equal(r.s.state, 'idle');
  // A turn that started, then an interrupt codex never answers: interrupt() returns at once, the feed says it later.
  r.m.send({ method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn-1' } } });
  await settle();
  const res = await r.s.interrupt();
  assert.deepEqual(res, { withdrawn: 0, denied: 0 });
  r.clock.advanceBy(CODEX_DEADLINES.interruptMs);
  await settle();
  assert.ok(events(r.s).some((e) => e.kind === 'note' && e.state === 'interrupt-failed'));
});

test('message fates: queued, then handed over; a stop withdraws what waits, each by its uuid', async () => {
  const r = rig();
  assert.deepEqual(r.s.send('early', U(1)), { ok: true, via: 'queued' });
  assert.equal(events(r.s).filter((e) => e.ref === U(1)).at(-1)!.state, 'msg-queued');
  await ready(r);
  const start = r.m.sent().find((x) => x.method === 'turn/start')!;
  r.m.send({ id: start.id, result: { turn: { id: 'turn-1' } } });
  await settle();
  assert.equal(events(r.s).filter((e) => e.ref === U(1)).at(-1)!.state, 'msg-sent');
  // While a turn/start is in flight the next ones wait; an interrupt takes them back.
  r.m.send({ method: 'turn/completed', params: { threadId: 'thr', turn: { id: 'turn-1', status: 'completed' } } });
  await settle();
  assert.equal(r.s.send('one', U(2)).ok, true);
  assert.deepEqual(r.s.send('two', U(3)), { ok: true, via: 'queued' });
  await r.s.interrupt();
  const states = (u: string) => events(r.s).filter((e) => e.ref === u).map((e) => e.state);
  assert.deepEqual(states(U(3)), ['msg-withdrawn'], 'the live queued note was replaced by its fate');
  const feed = { v: 1, kind: 'owned-feed', ownedId: r.s.ownedId, from: 0, to: r.s.feed.lastSeq, clipped: false, events: events(r.s).map((e) => ({ ...e, exitCode: e.exitCode ?? null, tokens: e.tokens ?? null })) };
  assert.deepEqual(validateOwnedFeed(feed).errors, []);
});

test('token usage: a report without all four counts leaves the count unknown (null), never 0', async () => {
  const r = rig();
  await ready(r);
  r.m.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr', tokenUsage: { total: { totalTokens: 9 } } } });
  await settle();
  assert.equal(r.s.tokens, null);
  r.m.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } } } });
  r.m.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr', tokenUsage: { total: { totalTokens: 'x', inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 } } } });
  await settle();
  assert.deepEqual(r.s.tokens, { input: 20, cachedInput: 5, output: 10, total: 30 }, 'the last whole report stands');
});

test('an allow that does not match what the queue holds is declined as a mismatch, not as the person\'s refusal', async () => {
  const r = rig();
  await ready(r);
  r.m.send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr', itemId: 'c1', command: 'echo', cwd: CWD } });
  await settle();
  const [a] = r.approvals.list();
  assert.equal(r.approvals.allow(a!.approvalId, { digest: '0'.repeat(64), rev: r.approvals.rev }), 'digest-mismatch');
  const ev = events(r.s).filter((e) => e.ref === a!.approvalId).at(-1)!;
  assert.deepEqual([ev.kind, ev.state], ['auto-denied', 'mismatch']);
});

test('the live window: a secret the window cut in half is not shown (the window starts after a line break past the cut)', () => {
  // A synthetic redactor: SECRET<letters> and a BLOB...BLOB block become short marks.
  const redact = (text: string) => {
    let count = 0;
    const out = text.replace(/SECRET[A-Z]+|BLOB[\s\S]*?BLOB/g, () => {
      count++;
      return '[x]';
    });
    return { text: out, count };
  };
  const tail = 'TAILOFTOKENWITHOUTITSPREFIX';
  const text = `${'a'.repeat(100)}SECRET${'Q'.repeat(60)}${tail}\nBLOB${'b'.repeat(4000)}BLOB\nend`;
  const window = 4000 + tail.length + 30;
  assert.ok(text.slice(-window).startsWith('Q') || text.slice(-window).includes(tail), 'the window starts inside the secret');
  const shown = liveTail(redact, text, window, 2048);
  assert.equal(shown.text.includes(tail), false, shown.text);
  assert.ok(shown.text.endsWith('[x]\nend'));
  assert.equal(liveTail(redact, 'short SECRETABC', 100, 2048).text, 'short [x]');
});

test('the registry: a session that had not ended comes back unknown (daemon-restart), never resumed; GET /api/owned and the tower say so', async () => {
  const files = new Map<string, string>();
  const reg = makeOwnedRegistry({
    dir: 'C:\\o\\owned', writeAtomic: (f, t) => files.set(f, t), readdir: () => [...files.keys()].map((f) => f.split('\\').at(-1)!), readFile: (f) => files.get(f)!,
  });
  const base = { v: 1, harness: 'codex', model: DEFAULT_CODEX_MODEL, title: 'synthetic', endReason: null } as const;
  reg.save({ ...base, ownedId: 'a'.repeat(20), createdAt: 1, state: 'running' });
  reg.save({ ...base, ownedId: 'b'.repeat(20), createdAt: 2, state: 'ended', endReason: 'you-ended' });
  files.set('C:\\o\\owned\\notes.txt', 'x');
  files.set(`C:\\o\\owned\\${'c'.repeat(20)}.json`, '{"v":1}');
  assert.equal(parseOwnedRecord('{"v":1}'), null);
  const loaded = reg.load();
  assert.deepEqual(loaded.map((x) => [x.ownedId[0], x.state]), [['a', 'running'], ['b', 'ended']]);
  assert.deepEqual([afterRestart(loaded[0]!).state, afterRestart(loaded[0]!).endReason], ['unknown', 'daemon-restart']);
  const clock = new VirtualClock({ mono: 1, wall: 50 });
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock }), makeWorkDir: (id) => `${WORK}\\${id}`, launch: () => memPipe().pipe, now: () => 50, redact: (text) => ({ text, count: 0 }), registry: reg,
  });
  assert.equal(owned.restored, 2);
  assert.equal(owned.active(), 0, 'a session left by an earlier orchestrad holds no seat');
  const rec = parseOwnedRecord(files.get(`C:\\o\\owned\\${'a'.repeat(20)}.json`)!) as OwnedRecord;
  assert.deepEqual([rec.state, rec.endReason], ['unknown', 'daemon-restart'], 'the registry says unknown from now on');
  const restored = owned.get('a'.repeat(20))!;
  assert.deepEqual(restored.send('hi', U(1)), { ok: false, reason: 'ended' });
  const list = ownedList({ codex: owned, claude: null, codexOff: 'on' });
  assert.deepEqual(validateOwnedList(list).errors, []);
  assert.deepEqual(list.owned.map((o) => [o.ownedId[0], o.state, o.endReason]), [['a', 'unknown', 'daemon-restart'], ['b', 'ended', 'you-ended']]);
  assert.equal(list.limits.active, 0);
  const tower = towerFromStage(busyStage(), { seats: owned.towerSeats(), nowWall: 50 });
  assert.deepEqual(validateTower(tower).errors, []);
  assert.deepEqual(tower.projects[0]!.nodes.map((n) => [n.state, n.basis]), [['unknown', 'none'], ['ended', 'owned']]);
  // A new session is kept in the registry as its state moves.
  const made = owned.create({});
  assert.ok(made.ok);
  const mine = parseOwnedRecord(files.get(`C:\\o\\owned\\${made.ownedId}.json`)!)!;
  assert.deepEqual([mine.state, mine.createdAt], ['starting', 50]);
  made.session.end();
  assert.equal(parseOwnedRecord(files.get(`C:\\o\\owned\\${made.ownedId}.json`)!)!.state, 'ended');
  // The contract: unknown goes with daemon-restart and nothing else.
  const bad = structuredClone(list);
  bad.owned[0]!.endReason = 'exited';
  assert.ok(validateOwnedList(bad).errors.some((e) => e.includes('daemon-restart exactly when the state is unknown')));
});

test('the owned work root is the one name codex-home.ts makes', () => {
  assert.equal(OWNED_WORK_NAME, OWNED_DIRS.work);
});
