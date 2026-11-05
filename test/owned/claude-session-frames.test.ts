import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPipe } from '../../src/os/owned-proc.ts';
import type { ClaudeSession } from '../../src/owned/claude-session.ts';
import { HOST_STOP_MS } from '../../src/os/owned-proc.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { startClaudeSession } from '../../src/owned/claude-session.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
import { validateOwnedFeed } from '../../shared/owned-contract.js';

// The owned Claude session's driver against a hand-made host pipe: the frames a real host may send in
// the moments around an end (alpha 0.2 design §2.3), written exactly when a test wants them. Synthetic
// frames only; no host-core, no SDK, no process.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SID = '11111111-2222-4333-8444-555555555555';
const REQ = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);

type Fake = {
  pipe: HostPipe;
  frames(): Record<string, unknown>[];
  say(frame: Record<string, unknown> | string): void;
  close(code?: number | null): void;
  kills: number;
  stdinClosed: boolean;
};

function fakePipe(): Fake {
  const written: string[] = [];
  let out: ((c: Buffer) => void) | null = null;
  let onClose: ((code: number | null, signal: string | null) => void) | null = null;
  const f: Fake = {
    kills: 0,
    stdinClosed: false,
    pipe: Object.freeze({
      pid: 4242,
      write: (d: string) => {
        if (!f.stdinClosed) written.push(d);
      },
      onStdout: (cb: (c: Buffer) => void) => { out = cb; },
      onStderr: () => {},
      onClose: (cb: (code: number | null, signal: string | null) => void) => { onClose = cb; },
      onError: () => {},
      closeStdin: () => { f.stdinClosed = true; },
      kill: () => { f.kills++; },
    }),
    frames: () => written.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>),
    say: (frame) => out?.(Buffer.from(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`, 'utf8')),
    close: (code = 0) => onClose?.(code, null),
  };
  return f;
}

function rig() {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const host = fakePipe();
  const started = startClaudeSession({
    ownedId: 'c'.repeat(20), cwd: 'C:\\o\\work\\cccccccccccccccccccc', configDir: 'C:\\o\\claude\\cccccccccccccccccccc', model: DEFAULT_CLAUDE_MODEL,
    claudeExe: 'C:\\x\\claude.exe', protectedRoots: ['C:\\o'], askTimeoutMs: 60_000, launch: () => host.pipe, approvals,
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  }, { text: 'hello', uuid: U(1) });
  assert.ok(started.ok);
  return { clock, approvals, host, s: started.session };
}

const ask = (over: Record<string, unknown> = {}) => ({ t: 'ask', reqId: REQ, toolName: 'Write', toolUseId: 'toolu_1', preview: 'file_path: a.txt', inputBytes: 10, digest: DIGEST, redactions: 0, tooLong: false, risk: 'write', paths: [], ...over });
const perms = (h: Fake) => h.frames().filter((f) => f.t === 'perm');
const states = (s: ClaudeSession) => s.feed.since(0).events.map((e) => `${e.kind}:${e.state ?? ''}`);
const feedOk = (s: ClaudeSession) => {
  const page = s.feed.since(0);
  const v = validateOwnedFeed({
    v: 1, kind: 'owned-feed', ownedId: s.ownedId, from: page.from, to: page.to, clipped: page.clipped,
    events: page.events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, uuid: e.uuid, text: e.text, state: e.state, redactions: e.redactions, live: e.live, exitCode: e.exitCode ?? null, tokens: e.tokens === undefined ? null : { ...e.tokens }, batch: e.batch ?? null })),
  });
  assert.ok(v.ok, v.errors.join('\n'));
};

test('an ask that arrives after the end gets the refusal and no card; the host closing forgets whatever was left (no card waits on a gone host)', async () => {
  const { approvals, host, s } = rig();
  host.say({ t: 'init', sessionId: SID });
  assert.equal(await s.ready, true);
  assert.deepEqual(s.end(), { denied: 0 });
  assert.equal(s.endReason, 'you-ended');
  host.say(ask());
  assert.equal(approvals.list().length, 0, 'no card for an ended session');
  assert.deepEqual(perms(host).map((p) => [p.reqId, p.allow, p.digest]), [[REQ, false, DIGEST]]);
  assert.ok(states(s).includes('auto-denied:ending'));
  // Text and results after the end are not this session's any more; the exit frame still is.
  host.say({ t: 'text', uuid: U(7), chunk: 'late words' });
  host.say({ t: 'exit', reason: 'closed' });
  assert.ok(!s.feed.since(0).events.some((e) => e.kind === 'text'));
  assert.deepEqual(s.stats().exit, { reason: 'closed', detail: null });
  host.close();
  await s.exited;
  assert.equal(s.stats().closed, true);
  feedOk(s);
});

test('a host that failed (a line that is not JSON) is a protocol error, not "exited"; an ask after it makes no card; a card opened before is forgotten when the host closes', async () => {
  const { approvals, host, s } = rig();
  host.say({ t: 'init', sessionId: SID });
  await s.ready;
  host.say(ask());
  assert.equal(approvals.list().length, 1);
  host.say('this is not json');
  assert.equal(s.state, 'failed');
  assert.equal(s.endReason, 'protocol-error');
  assert.equal(approvals.list().length, 0, 'the failure declined the open card');
  host.say(ask({ reqId: 'c'.repeat(32), toolUseId: 'toolu_2' }));
  assert.equal(approvals.list().length, 0, 'an ask after the failure makes no card');
  assert.deepEqual(perms(host).map((p) => [p.reqId, p.allow]), [[REQ, false], ['c'.repeat(32), false]]);
  host.close(2);
  assert.equal(approvals.list().length, 0);
  feedOk(s);
});

test('a line past 64 KiB is a protocol error; what follows its newline is read again (an exit frame still counts)', () => {
  const { host, s } = rig();
  host.say({ t: 'init', sessionId: SID });
  host.say(`{"t":"text","chunk":"${'x'.repeat(70 * 1024)}`);
  assert.equal(s.endReason, 'protocol-error');
  host.say('"}');
  host.say({ t: 'exit', reason: 'closed' });
  assert.deepEqual(s.stats().exit, { reason: 'closed', detail: null });
});

test('an interrupt receipt that still holds something ends the session as interrupt-unsure, not "you ended it"', async () => {
  const { host, s } = rig();
  host.say({ t: 'init', sessionId: SID });
  await s.ready;
  await s.interrupt();
  host.say({ t: 'interrupted', stillQueued: 1 });
  assert.equal(s.state, 'ended');
  assert.equal(s.endReason, 'interrupt-unsure');
  assert.equal(host.frames().filter((f) => f.t === 'close').length, 1, 'the host is stopped');
});

test('a message written to the host is msg-written until the host confirms it (a lifecycle frame or the result): msg-sent; a host gone first leaves it msg-unsure', async () => {
  const a = rig();
  assert.ok(states(a.s).includes('note:msg-written'));
  assert.ok(!states(a.s).includes('note:msg-sent'), 'not "sent" before the host said anything');
  a.host.say({ t: 'init', sessionId: SID });
  a.host.say({ t: 'lifecycle', uuid: U(1), state: 'queued' });
  assert.ok(states(a.s).includes('note:msg-sent'));
  assert.ok(!a.s.feed.since(0).events.some((e) => e.state === 'msg-written'), 'the live note went');
  // A second message confirmed only by the turn's result.
  a.host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(1) });
  a.s.send('again', U(2));
  a.host.say({ t: 'result', subtype: 'success', costUsd: 0, uuid: U(2) });
  assert.equal(a.s.feed.since(0).events.filter((e) => e.kind === 'note' && e.state === 'msg-sent').length, 2);
  feedOk(a.s);

  const b = rig();
  b.host.close(1);
  const fate = b.s.feed.since(0).events.filter((e) => e.kind === 'note' && e.ref === U(1)).map((e) => e.state);
  assert.deepEqual(fate, ['msg-unsure']);
  feedOk(b.s);
});

test('end(daemon-stop) says orchestrad ended it; exited settles once the host closes, and the stop order runs on the Clock until then', async () => {
  const { clock, host, s } = rig();
  host.say({ t: 'init', sessionId: SID });
  await s.ready;
  s.end('daemon-stop');
  assert.equal(s.endReason, 'daemon-stop');
  let gone = false;
  void s.exited.then(() => { gone = true; });
  clock.advanceBy(HOST_STOP_MS.afterClose);
  assert.equal(host.stdinClosed, true);
  clock.advanceBy(HOST_STOP_MS.afterEof);
  assert.equal(host.kills, 1);
  host.close(null);
  await s.exited;
  assert.equal(gone, true);
});
