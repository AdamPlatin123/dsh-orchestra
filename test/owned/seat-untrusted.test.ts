import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { CodexSession } from '../../src/owned/codex-session.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { codexApprovalPolicy, startCodexSession } from '../../src/owned/codex-session.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';

// r4 §8.5 (来源追踪) for Codex: a session a seat request started (a DSH session asked; the person only
// dispatched it) is tainted, so its thread starts with the untrusted approval policy, and a thread/start
// reply that echoes another ends it as policy-mismatch. A session a person opened keeps on-request, and
// an echo of untrusted there is a mismatch too. Measured on codex-cli 0.165.0 (2026-11-03, one run each):
// thread/start {approvalPolicy:'untrusted'} echoes "untrusted" with sandbox readOnly (asked read-only or
// workspace-write), and Get-Content, Get-ChildItem and Set-Content each asked first. In-memory pipes, a
// virtual clock: no child, no model.

const CWD = 'D:\\work\\owned\\0123456789abcdef0123';
const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const UA = 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)';

function memPipe() {
  const out: ((c: Buffer) => void)[] = [];
  const written: string[] = [];
  const pipe: ChildPipe = {
    pid: 1, write: (d) => {
      written.push(d);
    }, onStdout: (cb) => {
      out.push(cb);
    }, onStderr: () => {}, onClose: () => {}, onError: () => {}, stop: () => {},
  };
  const sent = (): any[] => written.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  return { pipe, sent, send: (msg: unknown) => out.forEach((cb) => cb(Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'))) };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
type Mem = ReturnType<typeof memPipe>;

/** Answers initialize, then thread/start with `echo` (approvalPolicy) and `sandbox`. */
async function handshake(m: Mem, echo: unknown, sandbox: string): Promise<void> {
  await settle();
  m.send({ id: 1, result: { userAgent: UA } });
  await settle();
  m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: echo, approvalsReviewer: 'user', sandbox: { type: sandbox } } });
  await settle();
}

async function session(opts: { tainted?: boolean; projectRoot?: boolean; echo: unknown; sandbox: string }): Promise<{ s: CodexSession; m: Mem }> {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const m = memPipe();
  const started = startCodexSession({
    ownedId: '0123456789abcdef0123', cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals: new Approvals({ hub: clock, settleMs: 0 }),
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
    ...(opts.tainted === undefined ? {} : { tainted: opts.tainted }), ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
  });
  assert.ok(started.ok);
  await handshake(m, opts.echo, opts.sandbox);
  return { s: started.session, m };
}

const threadStart = (m: Mem) => m.sent().find((x) => x.method === 'thread/start');

test('codexApprovalPolicy: untrusted for a tainted session, on-request otherwise', () => {
  assert.equal(codexApprovalPolicy(true), 'untrusted');
  assert.equal(codexApprovalPolicy(false), 'on-request');
});

test('a tainted (seat) Codex session asks thread/start for untrusted and runs when the reply echoes it; its turn/start names no other policy', async () => {
  for (const sandbox of ['readOnly', 'workspaceWrite']) {
    const { s, m } = await session({ tainted: true, echo: 'untrusted', sandbox });
    assert.equal(await s.ready, true, sandbox);
    assert.deepEqual(threadStart(m).params, { cwd: CWD, model: DEFAULT_CODEX_MODEL, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    assert.ok(s.send('look around', U(1)).ok);
    await settle();
    const turn = m.sent().find((x) => x.method === 'turn/start');
    assert.ok(turn !== undefined);
    assert.ok(!Object.hasOwn(turn.params, 'approvalPolicy'), 'the thread keeps untrusted: turn/start overrides it only when it names one');
  }
});

test('a tainted session whose thread/start reply echoes another policy ends as policy-mismatch before any turn', async () => {
  for (const echo of ['on-request', 'never', undefined, { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } }]) {
    const { s, m } = await session({ tainted: true, echo, sandbox: 'readOnly' });
    assert.equal(await s.ready, false, JSON.stringify(echo));
    assert.deepEqual([s.state, s.endReason], ['failed', 'policy-mismatch'], JSON.stringify(echo));
    assert.equal(m.sent().filter((x) => x.method === 'turn/start').length, 0);
  }
});

test('a session a person opened keeps on-request: it asks for on-request, and an untrusted echo is a mismatch there too', async () => {
  const plain = await session({ echo: 'on-request', sandbox: 'workspaceWrite' });
  assert.equal(await plain.s.ready, true);
  assert.equal(threadStart(plain.m).params.approvalPolicy, 'on-request');
  const off = await session({ tainted: false, echo: 'on-request', sandbox: 'readOnly' });
  assert.equal(await off.s.ready, true);
  assert.equal(threadStart(off.m).params.approvalPolicy, 'on-request');
  const other = await session({ echo: 'untrusted', sandbox: 'readOnly' });
  assert.equal(await other.s.ready, false);
  assert.equal(other.s.endReason, 'policy-mismatch');
});

test('tainted in a project root: untrusted and the read-only sandbox both hold; workspaceWrite there still ends it', async () => {
  const ro = await session({ tainted: true, projectRoot: true, echo: 'untrusted', sandbox: 'readOnly' });
  assert.equal(await ro.s.ready, true);
  const ww = await session({ tainted: true, projectRoot: true, echo: 'untrusted', sandbox: 'workspaceWrite' });
  assert.equal(await ww.s.ready, false);
  assert.equal(ww.s.endReason, 'policy-mismatch');
});

test('CodexOwned.create hands tainted down: a tainted create asks for untrusted, a plain one for on-request', async () => {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const pipes: Mem[] = [];
  const owned = new CodexOwned({
    approvals: new Approvals({ hub: clock, settleMs: 0 }), makeWorkDir: (id) => `D:\\work\\owned\\${id}`,
    launch: () => {
      const m = memPipe();
      pipes.push(m);
      return m.pipe;
    },
    now: () => clock.wall, redact: (text) => ({ text, count: 0 }), hub: clock,
  });
  const a = owned.create({ text: 'from a seat request', uuid: U(1), tainted: true });
  const b = owned.create({ text: 'from you', uuid: U(2) });
  assert.ok(a.ok && b.ok);
  await handshake(pipes[0]!, 'untrusted', 'readOnly');
  await handshake(pipes[1]!, 'on-request', 'readOnly');
  assert.deepEqual(pipes.map((m) => threadStart(m).params.approvalPolicy), ['untrusted', 'on-request']);
  assert.equal(await a.session.ready, true);
  assert.equal(await b.session.ready, true);
  owned.endAll();
});
