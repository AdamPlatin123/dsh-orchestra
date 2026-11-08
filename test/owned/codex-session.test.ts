import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { CodexSession } from '../../src/owned/codex-session.ts';
import type { FeedEvent } from '../../src/owned/feed.ts';
import type { DispatchCall, DispatchNote, DispatchPort } from '../../src/route/dispatch.ts';
import { DISPATCH_TOOL } from '../../src/route/dispatch.ts';
import { childPipe } from '../../src/os/child-pipe.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { ENV_WHITELIST, FAKE_CODEX_SCRIPT, LIBUV_ADDED_ENV, resolveSystemRoot } from '../../src/os/spawn.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { APPROVAL_LIMITS, Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { CODEX_VERSIONS, UNANSWERED_REQUEST_CODE, codexVersionOf, startCodexSession } from '../../src/owned/codex-session.ts';
import { DEFAULT_CODEX_MODEL } from '../../src/owned/models.ts';
import { withTmp } from '../helpers/tmp.ts';

// Owned Codex sessions over the app-server protocol (orchestra app plan §2), end to end through the
// spawn gate: the test-only rule codex-app-server-fake runs test/fixtures/fake-codex-app-server.ts under
// this node.exe, in a work dir below ORCHESTRA_HOME\work that the gate's cwd policy checks (the AppData
// and data-dir exemption included: the test dir lies in %TEMP%). No codex.exe, no model, no network.

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

type Rig = {
  owned: CodexOwned;
  approvals: Approvals;
  clock: VirtualClock;
  log: string;
  workRoot: string;
  spawned: number;
  /** Every line the fake read, parsed (its env report included). */
  received(): Record<string, any>[];
  /** What Orchestra answered to the fake's server requests: [id, result or {error}]. */
  answers(): [string, unknown][];
};

async function withRig(t: TestContext, body: (r: Rig) => Promise<void>, opts: { rpcLineMaxBytes?: number; ua?: string; dispatch?: DispatchPort } = {}): Promise<void> {
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'orchestra');
  const workRoot = path.join(home, 'work');
  const codexHome = path.join(home, 'codex-home');
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const log = path.join(dir, 'fake.log');
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok, JSON.stringify(sys));
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const gate = makeSpawnGate({
    systemRoot: sys,
    rules: ['codex-app-server-fake'],
    record: () => {},
    realpath,
    clock,
    env: process.env,
    envExtra: { 'codex-app-server-fake': { CODEX_HOME: codexHome, FAKE_CODEX_LOG: log, ...(opts.ua === undefined ? {} : { FAKE_CODEX_UA: opts.ua }) } },
    cwd: { allowedRoots: [workRoot], protectedDirs: [home], userHome: os.homedir(), ownedWorkRoot: workRoot },
    fakeCodexNode: process.execPath,
  });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const redactor = makeRedactor({ env: {} });
  const closes: Promise<void>[] = [];
  const rig: Rig = {
    approvals, clock, log, workRoot, spawned: 0,
    owned: new CodexOwned({
      approvals,
      makeWorkDir: (id) => {
        const d = path.join(workRoot, id);
        fs.mkdirSync(d);
        return d;
      },
      launch: (cwd) => {
        rig.spawned++;
        const pipe: ChildPipe = childPipe(gate.start({ exe: process.execPath, argv: [FAKE_CODEX_SCRIPT], cwd }));
        closes.push(new Promise((r) => pipe.onClose(() => r())));
        return pipe;
      },
      now: () => clock.wall,
      redact: (text) => {
        const r = redactor.redact({ text });
        return { text: r.text, count: r.verdict.known + r.verdict.entropy + Object.values(r.verdict.format).reduce((a, b) => a + b, 0) };
      },
      ...(opts.rpcLineMaxBytes !== undefined ? { rpcLineMaxBytes: opts.rpcLineMaxBytes } : {}),
      ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
    }),
    received: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    }) : []),
    answers: () => rig.received().filter((m) => m.method === undefined && typeof m.id === 'string').map((m) => [m.id, m.error !== undefined ? { error: m.error } : m.result]),
  };
  try {
    await body(rig);
  } finally {
    rig.owned.endAll();
    await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(r, 5000))]);
  }
}

async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const events = (s: CodexSession): readonly FeedEvent[] => s.feed.since(0).events;
const has = (s: CodexSession, kind: string, state?: string) => events(s).some((e) => e.kind === kind && (state === undefined || e.state === state));

async function newSession(r: Rig, model?: string): Promise<CodexSession> {
  const made = r.owned.create(model === undefined ? {} : { model });
  assert.ok(made.ok, JSON.stringify(made));
  return made.session;
}

/** Sends a scripted turn and waits until that turn ends. */
async function turn(s: CodexSession, text: string, n: number, endState = 'turn-ended'): Promise<void> {
  const before = events(s).filter((e) => e.kind === 'lifecycle' && e.state === endState).length;
  const sent = s.send(text, U(n));
  assert.ok(sent.ok, JSON.stringify(sent));
  await until(`${text} to end`, () => events(s).filter((e) => e.kind === 'lifecycle' && e.state === endState).length > before);
}

/** Every answer Orchestra wrote must be one of these shapes; nothing for a session, no amendment. */
function assertOnlyPlainAnswers(r: Rig): void {
  const text = fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8') : '';
  for (const word of ['acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment', '"session"', '"cancel"']) {
    assert.ok(!text.includes(word), `Orchestra sent ${word}`);
  }
}

test('handshake: initialize, then initialized, then thread/start with the cwd, the model, on-request and workspace-write; the child gets only the whitelist and CODEX_HOME', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    assert.equal(await s.ready, true);
    assert.equal(s.state, 'idle');
    assert.equal(s.threadId, 'thr_fake');
    const got = r.received();
    const env = got.find((m) => Array.isArray(m.env))!.env as string[];
    const protocol = got.filter((m) => !Array.isArray(m.env));
    assert.deepEqual(protocol.map((m) => m.method), ['initialize', 'initialized', 'thread/start']);
    assert.equal(protocol[0]!.id, 1);
    assert.equal(protocol[0]!.jsonrpc, undefined, 'codex app-server lines carry no jsonrpc member');
    assert.deepEqual(protocol[0]!.params.clientInfo, { name: 'orchestra', title: 'Orchestra', version: '0.2.0' });
    assert.deepEqual(protocol[0]!.params.capabilities, { experimentalApi: true, requestAttestation: false }, 'thread/backgroundTerminals/* need it');
    assert.ok(!Object.hasOwn(protocol[1]!, 'id'), 'initialized is a notification');
    assert.deepEqual(protocol[2]!.params, { cwd: s.cwd, model: DEFAULT_CODEX_MODEL, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    assert.equal(path.dirname(s.cwd), r.workRoot);
    assert.match(path.basename(s.cwd), /^[0-9a-f]{20}$/);
    const lower = env.map((k) => k.toLowerCase());
    assert.ok(lower.includes('codex_home') && lower.includes('systemroot'), env.join(','));
    for (const banned of ['node_options', 'node_test_context', 'node_path']) assert.ok(!lower.includes(banned), `${banned} reached the child`);
    // The whitelist, the two extras, and what libuv adds by itself on Windows (PATH among them: measured, not chosen).
    const allowed = [...ENV_WHITELIST['codex-app-server-fake'], 'CODEX_HOME', 'FAKE_CODEX_LOG', ...LIBUV_ADDED_ENV].map((k) => k.toLowerCase());
    for (const k of lower) assert.ok(allowed.includes(k), `unexpected ${k}`);
    assert.ok(lower.includes('path'), 'libuv adds PATH: if this fails, the gate keeps PATH out and spawn.ts LIBUV_ADDED_ENV is stale');
    assert.ok(has(s, 'lifecycle', 'started'));
  });
});

test('a codex-cli version Orchestra was not measured on (or none in the userAgent) ends the session as policy-mismatch before thread/start', async (t) => {
  assert.equal(codexVersionOf('orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)'), '0.165.0');
  assert.equal(codexVersionOf('codex_cli_rs/0.166.0-alpha.1 (Linux)'), '0.166.0-alpha.1');
  for (const bad of [undefined, 42, '', 'orchestra', 'orchestra/latest (x)', 'a/b/0.165.0']) assert.equal(codexVersionOf(bad), null, String(bad));
  assert.deepEqual([...CODEX_VERSIONS], ['0.165.0']);
  for (const ua of ['orchestra/0.166.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)', 'fake-codex']) {
    await withRig(t, async (r) => {
      const s = await newSession(r);
      assert.equal(await s.ready, false);
      assert.equal(s.state, 'failed');
      assert.equal(s.endReason, 'policy-mismatch');
      const life = events(s).find((e) => e.kind === 'lifecycle' && e.state === 'policy-mismatch');
      assert.match(life?.text ?? '', /measured on 0.165.0/);
      assert.ok(!r.received().some((m) => m.method === 'thread/start'), 'no thread was started');
    }, { ua });
  }
});

test('a command codex ran without asking is said in the feed (ran-unasked); one it asked about is not', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run-unasked', U(1));
    await until('the card', () => r.approvals.list().length === 1);
    r.approvals.allow(r.approvals.list()[0]!.approvalId, { digest: r.approvals.list()[0]!.digest, rev: r.approvals.rev });
    await until('the turn ends', () => has(s, 'lifecycle', 'turn-ended'));
    const notes = events(s).filter((e) => e.kind === 'note' && e.state === 'ran-unasked');
    assert.deepEqual(notes.map((e) => e.text), ['Get-ChildItem']);
  });
});

test('messages: turn/start when idle; deltas make one live event, replaced by the final message; token usage; the turn ends as turn-ended, never "done"', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    await turn(s, 'say hello big world', 1);
    const ev = events(s);
    const you = ev.find((e) => e.kind === 'you')!;
    assert.deepEqual([you.uuid, you.text], [U(1), 'say hello big world']);
    const texts = ev.filter((e) => e.kind === 'text');
    assert.deepEqual(texts.map((e) => [e.state, e.text, e.live]), [['final', 'hello big world', false]], 'the partial was replaced by the final message');
    const tokens = ev.find((e) => e.state === 'tokens')!;
    assert.deepEqual(tokens.tokens, { input: 20, cachedInput: 5, output: 10, total: 30 });
    assert.deepEqual(s.tokens, { input: 20, cachedInput: 5, output: 10, total: 30 });
    assert.ok(has(s, 'lifecycle', 'turn-started') && has(s, 'lifecycle', 'turn-ended'));
    assert.ok(!ev.some((e) => /done|complete/i.test(String(e.state))), 'no state says done (D19, T2)');
    assert.equal(s.state, 'idle');
    assert.equal(s.turnId, null);
    const start = r.received().find((m) => m.method === 'turn/start')!;
    assert.deepEqual(start.params, { threadId: 'thr_fake', input: [{ type: 'text', text: 'say hello big world' }] });
    // Seq rises; a reader after the last seq gets nothing new.
    const seqs = ev.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.deepEqual(s.feed.since(s.feed.lastSeq).events, []);
  });
});

test('messages: before the thread is ready they wait here; during a turn a message is a turn/steer naming the running turn', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    const early = s.send('hold', U(1));
    assert.deepEqual(early, { ok: true, via: 'queued' });
    await until('the held turn', () => s.turnId !== null);
    const steer = s.send('and also this', U(2));
    assert.deepEqual(steer, { ok: true, via: 'turn/steer' });
    await until('the steer', () => r.received().some((m) => m.method === 'turn/steer'));
    const st = r.received().find((m) => m.method === 'turn/steer')!;
    assert.deepEqual(st.params, { threadId: 'thr_fake', expectedTurnId: 'turn_1', input: [{ type: 'text', text: 'and also this' }] });
    const out = await s.interrupt();
    assert.deepEqual(out, { withdrawn: 0, denied: 0 });
    await until('the interrupted turn', () => has(s, 'lifecycle', 'turn-interrupted'));
    assert.deepEqual(r.received().find((m) => m.method === 'turn/interrupt')!.params, { threadId: 'thr_fake', turnId: 'turn_1' });
    assert.equal(s.state, 'idle');
  });
});

test('approvals: a command enters the queue; allow answers {decision:accept} and the output follows; deny answers {decision:decline}', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run echo hi', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    const a = r.approvals.list()[0]!;
    assert.equal(a.kind, 'command');
    assert.equal(a.risk, 'shell');
    assert.equal(a.high, true);
    assert.equal(a.canAccept, true);
    assert.equal(a.ownedId, s.ownedId);
    assert.match(a.preview, /^command: echo hi\ncwd: \.\nreason: the script asks$/);
    assert.ok(!a.preview.includes('acceptForSession') && !a.preview.includes('execpolicy'), 'the offered amendments are not shown as choices');
    assert.ok(has(s, 'ask', 'command'));
    // A stale revision changes nothing; a wrong digest is a refusal.
    assert.equal(r.approvals.allow(a.approvalId, { digest: a.digest, rev: r.approvals.rev - 1 }), 'stale-view');
    assert.equal(r.approvals.list().length, 1);
    assert.equal(r.approvals.allow(a.approvalId, { digest: a.digest, rev: r.approvals.rev }), 'ok');
    await until('the command to run', () => has(s, 'tool-result', 'ran'));
    const result = events(s).find((e) => e.kind === 'tool-result' && e.state === 'ran')!;
    assert.equal(result.text, 'line one\nline two\n');
    assert.equal(result.exitCode, 0);
    assert.ok(!events(s).some((e) => e.live && e.kind === 'tool-result'), 'the live output was settled');
    await until('turn 1 to end', () => has(s, 'lifecycle', 'turn-ended'));
    assert.equal(r.approvals.allow(a.approvalId, { digest: a.digest, rev: r.approvals.rev }), 'approval-gone', 'answered once');

    s.send('run rm notes.txt', U(2));
    await until('the second approval', () => r.approvals.list().length === 1);
    const b = r.approvals.list()[0]!;
    assert.equal(r.approvals.deny(b.approvalId), 'ok');
    await until('the decline', () => has(s, 'tool-result', 'declined'));
    assert.deepEqual(r.answers(), [['srv-1', { decision: 'accept' }], ['srv-2', { decision: 'decline' }]]);
    assert.deepEqual(events(s).filter((e) => e.kind === 'answer').map((e) => e.state), ['accept', 'decline']);
    assertOnlyPlainAnswers(r);
  });
});

test('order: codex announces a command before it asks about it; the feed reads ask, answer, then the command and its result', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    const story = () => events(s).filter((e) => ['ask', 'answer', 'tool', 'tool-result'].includes(e.kind)).map((e) => `${e.kind}:${e.state}`);
    s.send('run echo hi', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    assert.deepEqual(story(), ['ask:command'], 'while the card is open the command does not sit above it');
    assert.equal(r.approvals.deny(r.approvals.list()[0]!.approvalId), 'ok');
    await until('the decline', () => has(s, 'tool-result', 'declined'));
    assert.deepEqual(story(), ['ask:command', 'answer:decline', 'tool:command', 'tool-result:declined']);
    await until('turn 1 to end', () => has(s, 'lifecycle', 'turn-ended'));
    const seqs = events(s).map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seqs still rise in feed order');
    assert.equal(new Set(events(s).filter((e) => e.kind === 'tool').map((e) => e.ref)).size, events(s).filter((e) => e.kind === 'tool').length, 'told once in the feed');

    s.send('run echo again', U(2));
    await until('the second approval', () => r.approvals.list().length === 1);
    const b = r.approvals.list()[0]!;
    assert.equal(r.approvals.allow(b.approvalId, { digest: b.digest, rev: r.approvals.rev }), 'ok');
    await until('the run', () => has(s, 'tool-result', 'ran'));
    assert.deepEqual(story().slice(4), ['ask:command', 'answer:accept', 'tool:command', 'tool-result:ran']);
  });
});

test('approvals: a file the command reads outside the work dir is named on the card (commandActions)', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('read-outside', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    const a = r.approvals.list()[0]!;
    const away = a.preview.split('\n').filter((l) => l.startsWith('outside the work dir: '));
    assert.equal(away.length, 1, a.preview);
    assert.match(away[0]!, /^outside the work dir: read \(outside the work dir\) .*elsewhere\\SKILL\.md$/);
    assert.ok(!a.preview.includes('a.txt'), 'a read inside the work dir is not named');
    assert.equal(a.high, true);
    r.approvals.deny(a.approvalId);
    await until('the decline', () => has(s, 'tool-result', 'declined'));
  });
});

test('approvals: file changes, permissions, a question and an MCP elicitation; only accept/decline, a turn-scoped grant, one answer a question or a refusal ever go back', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    const next = async () => {
      await until('an approval', () => r.approvals.list().length === 1);
      return r.approvals.list()[0]!;
    };
    s.send('edit', U(1));
    const edit = await next();
    assert.deepEqual([edit.kind, edit.risk, edit.canAccept], ['file-change', 'write', true]);
    assert.match(edit.preview, /--- add notes\.txt\n\+hello/);
    assert.equal(r.approvals.allow(edit.approvalId, { digest: edit.digest, rev: r.approvals.rev }), 'ok');
    await until('the edit turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 1);

    s.send('grant', U(2));
    const grant = await next();
    assert.equal(grant.canAccept, false, 'a write grant for the rest of the session is never offered');
    assert.equal(r.approvals.allow(grant.approvalId, { digest: grant.digest, rev: r.approvals.rev }), 'digest-mismatch');
    await until('the grant turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 2);

    s.send('perm', U(3));
    const perm = await next();
    assert.deepEqual([perm.kind, perm.risk, perm.high], ['permissions', 'net', true]);
    assert.equal(r.approvals.allow(perm.approvalId, { digest: perm.digest, rev: r.approvals.rev }), 'ok');
    await until('the perm turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 3);
    s.send('perm', U(4));
    const perm2 = await next();
    assert.equal(r.approvals.deny(perm2.approvalId), 'ok');
    await until('the second perm turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 4);

    s.send('ask', U(5));
    const q = await next();
    assert.deepEqual([q.kind, q.canAccept, q.canText], ['question', false, true]);
    assert.deepEqual(q.questions, [{ header: 'Colour', question: 'Which colour?', options: [], other: false }]);
    assert.equal(r.approvals.answer(q.approvalId, [{ text: 'blue' }], { digest: q.digest, rev: r.approvals.rev }), 'ok');
    await until('the answer said back', () => events(s).some((e) => e.kind === 'text' && e.text === 'you said blue'));

    s.send('elicit', U(6));
    const el = await next();
    assert.deepEqual([el.kind, el.canAccept, el.canText], ['elicitation', false, false]);
    assert.equal(r.approvals.allow(el.approvalId, { digest: el.digest, rev: r.approvals.rev }), 'digest-mismatch');
    await until('the elicit turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 6);

    assert.deepEqual(r.answers(), [
      ['srv-1', { decision: 'accept' }],
      ['srv-2', { decision: 'decline' }],
      ['srv-3', { permissions: { network: { enabled: true } }, scope: 'turn' }],
      ['srv-4', { permissions: {}, scope: 'turn' }],
      ['srv-5', { answers: { q1: { answers: ['blue'] } } }],
      ['srv-6', { action: 'decline', content: null }],
    ]);
    assertOnlyPlainAnswers(r);
  });
});

test('approvals: a question card of several questions goes back one answer an id, an option as codex wrote its label (a redacted one too), a text where it takes one; a secret question offers only the refusal', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    const next = async () => {
      await until('an approval', () => r.approvals.list().length === 1);
      return r.approvals.list()[0]!;
    };
    s.send('choose', U(1));
    const q = await next();
    assert.deepEqual([q.kind, q.canAccept, q.canText, q.questions?.length], ['question', false, true, 2]);
    const [issues, bots] = q.questions!;
    assert.deepEqual(issues!.options.map((o) => o.label).slice(0, 2), ['All', 'None']);
    assert.ok(!issues!.options[2]!.label.includes('ghp_0123456789'), 'the card shows a secret in a label redacted');
    assert.ok(q.redactions > 0 && q.high, 'a hidden secret makes the card high risk');
    assert.deepEqual([bots!.other, bots!.options.length], [true, 1]);
    assert.equal(r.approvals.answer(q.approvalId, [{ option: 2 }, { text: 'ask me first' }], { digest: q.digest, rev: r.approvals.rev }), 'ok');
    await until('the answers said back', () => events(s).some((e) => e.kind === 'text' && e.text?.startsWith('you chose ')));
    const [, reply] = r.answers().at(-1)!;
    assert.deepEqual(reply, { answers: { issues: { answers: ['Key ghp_0123456789abcdefghijABCDEFGHIJ'] }, bots: { answers: ['ask me first'] } } });
    const said = events(s).find((e) => e.kind === 'answer')!;
    assert.equal(said.state, 'answered');
    assert.ok(said.text?.includes('Bots: ask me first') && !said.text.includes('ghp_0123456789'), said.text ?? '');

    s.send('ask-secret', U(2));
    const secret = await next();
    assert.deepEqual([secret.canText, secret.questions], [false, null]);
    assert.equal(r.approvals.answer(secret.approvalId, [{ text: 'hunter2' }], { digest: secret.digest, rev: r.approvals.rev }), 'digest-mismatch');
    await until('the secret turn', () => events(s).filter((e) => e.state === 'turn-ended').length === 2);
    assert.deepEqual(r.answers().at(-1)![1], { answers: {} });
    assertOnlyPlainAnswers(r);
  });
});

test('approvals: an open approval is declined when its deadline passes on the Clock (D8: timeout is a refusal)', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run echo late', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    r.clock.advanceBy(APPROVAL_LIMITS.timeoutMs - 1);
    assert.equal(r.approvals.list().length, 1);
    r.clock.advanceBy(1);
    assert.equal(r.approvals.list().length, 0);
    await until('the decline', () => has(s, 'tool-result', 'declined'));
    assert.deepEqual(r.answers(), [['srv-1', { decision: 'decline' }]]);
    assert.deepEqual(events(s).filter((e) => e.kind === 'auto-denied').map((e) => e.state), ['clock']);
  });
});

test('interrupt: open approvals are declined first, then turn/interrupt; nothing waits after it', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run-then-hold', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    const out = await s.interrupt();
    assert.deepEqual(out, { withdrawn: 0, denied: 1 });
    assert.equal(r.approvals.list().length, 0);
    await until('the interrupted turn', () => has(s, 'lifecycle', 'turn-interrupted'));
    const order = r.received().filter((m) => m.method === 'turn/interrupt' || (m.method === undefined && typeof m.id === 'string')).map((m) => m.method ?? `answer ${m.result?.decision}`);
    assert.deepEqual(order, ['answer decline', 'turn/interrupt']);
    assert.deepEqual(events(s).filter((e) => e.kind === 'auto-denied').map((e) => e.state), ['interrupt']);
  });
});

test('a child that crashes: its approvals go (an allow is approval-gone), the session failed with exited, and a later message is refused', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run-crash', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    const a = r.approvals.list()[0]!;
    await until('the crash', () => s.state === 'failed');
    assert.equal(s.endReason, 'exited');
    assert.match(s.stats().failure!, /exit code 3/);
    assert.equal(r.approvals.list().length, 0);
    assert.equal(r.approvals.allow(a.approvalId, { digest: a.digest, rev: r.approvals.rev }), 'approval-gone');
    assert.ok(has(s, 'lifecycle', 'exited'));
    assert.deepEqual(s.send('anything', U(2)), { ok: false, reason: 'ended' });
    assert.deepEqual(r.answers(), [], 'nothing was answered to a dead child');
  });
});

test('a child that dies before the thread starts: ready settles false and the session failed', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r, 'codex/fake-die');
    assert.equal(await s.ready, false);
    assert.equal(s.state, 'failed');
    assert.equal(s.endReason, 'exited');
  });
});

test('a thread/start reply without on-request ends the session as policy-mismatch before any turn', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r, 'codex/fake-loose');
    assert.equal(await s.ready, false);
    assert.equal(s.state, 'failed');
    assert.equal(s.endReason, 'policy-mismatch');
    assert.ok(!r.received().some((m) => m.method === 'turn/start'));
  });
});

test('bad lines are dropped and counted (not JSON, not an object, not UTF-8, no shape, too long, a stray response) and the stream goes on', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    await turn(s, 'garbage', 1);
    assert.deepEqual(s.stats().rpc, { badLines: 4, longLines: 1, strayResponses: 1 });
    assert.ok(events(s).some((e) => e.kind === 'text' && e.text === 'ok'));
    assert.equal(s.state, 'idle');
  }, { rpcLineMaxBytes: 1024 });
});

test('a server request Orchestra does not answer gets a JSON-RPC error, and the turn goes on', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    await turn(s, 'tool-call', 1);
    assert.deepEqual(r.answers(), [['srv-1', { error: { code: UNANSWERED_REQUEST_CODE, message: 'Orchestra does not answer item/tool/call' } }]]);
    assert.ok(has(s, 'note', 'request-refused'));
  });
});

/** A dispatch port that answers each call with `text`, and says what it was handed. */
function fakePort(text = 'Dispatched: a test.', hold = false) {
  const calls: { ownedId: string; raw: unknown }[] = [];
  let cancelled = 0;
  const port: DispatchPort = {
    call(ownedId, raw, say: (n: DispatchNote) => void): DispatchCall {
      calls.push({ ownedId, raw });
      say({ state: 'worker-sent-grant', ref: `n:${'c'.repeat(20)}`, text: 'the child' });
      let done: (v: { ok: boolean; text: string }) => void = () => {};
      const reply = hold ? new Promise<{ ok: boolean; text: string }>((r) => { done = r; }) : Promise.resolve({ ok: true, text });
      return {
        reply,
        cancel() {
          cancelled++;
          done({ ok: false, text: 'withdrawn' });
        },
      };
    },
    sentOf: () => null,
  };
  return { port, calls, cancelled: () => cancelled };
}

test('the dispatch tool: thread/start offers it, a call goes to the port under the session\'s own id, the answer comes back, and no tool row is left', async (t) => {
  const p = fakePort();
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    const start = r.received().find((m) => m.method === 'thread/start');
    assert.deepEqual(start?.params?.dynamicTools, [{ type: 'function', ...DISPATCH_TOOL }]);
    await turn(s, 'dispatch', 1);
    assert.deepEqual(p.calls, [{ ownedId: s.ownedId, raw: { task: 'say hi', harness: 'codex' } }]);
    assert.deepEqual(r.answers(), [['srv-1', { contentItems: [{ type: 'inputText', text: 'Dispatched: a test.' }], success: true }]]);
    assert.ok(has(s, 'note', 'worker-sent-grant'));
    assert.ok(!has(s, 'tool') && !has(s, 'tool-result'), 'its row is the note');
  }, { dispatch: p.port });
});

test('the dispatch tool from a thread that is not the root\'s is refused, and the port never hears it', async (t) => {
  const p = fakePort();
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    await turn(s, 'dispatch-member', 1);
    assert.deepEqual(p.calls, []);
    assert.deepEqual(r.answers(), [['srv-1', { contentItems: [{ type: 'inputText', text: 'This tool is not available here.' }], success: false }]]);
  }, { dispatch: p.port });
});

test('a stop gives up a dispatch still waiting, and the request is answered all the same; the session\'s end too', async (t) => {
  const p = fakePort('x', true);
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('dispatch', U(1));
    await until('the call', () => p.calls.length === 1);
    await s.interrupt();
    assert.equal(p.cancelled(), 1);
    await until('the answer', () => r.answers().length === 1);
    assert.deepEqual(r.answers(), [['srv-1', { contentItems: [{ type: 'inputText', text: 'withdrawn' }], success: false }]]);
    await until('the turn to end', () => s.state === 'idle');
    s.send('dispatch', U(2));
    await until('the second call', () => p.calls.length === 2);
    s.end();
    assert.equal(p.cancelled(), 2);
  }, { dispatch: p.port });
});

test('a session with no port offers no tool: thread/start as before', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    assert.equal(Object.hasOwn(r.received().find((m) => m.method === 'thread/start')?.params ?? {}, 'dynamicTools'), false);
  });
});

test('redaction comes before the cut: a token-shaped string in a message never reaches the feed', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    await turn(s, 'secret', 1);
    const text = events(s).filter((e) => e.kind === 'text').map((e) => e.text).join('');
    assert.ok(!text.includes('ghp_0123456789'), text);
    assert.match(text, /\[redacted:[a-z-]+\]/);
    assert.ok(events(s).find((e) => e.kind === 'text')!.redactions > 0);
  });
});

test('end: open approvals are declined, the child is stopped, and the session reads ended', async (t) => {
  await withRig(t, async (r) => {
    const s = await newSession(r);
    await s.ready;
    s.send('run-then-hold', U(1));
    await until('the approval', () => r.approvals.list().length === 1);
    assert.deepEqual(s.end(), { denied: 1 });
    assert.equal(s.state, 'ended');
    assert.equal(s.endReason, 'you-ended');
    // Written before the child is stopped; whether the child read it before it went is the child's race.
    assert.deepEqual(events(s).filter((e) => e.kind === 'auto-denied').map((e) => e.state), ['end']);
    assert.ok(has(s, 'lifecycle', 'ended'));
    assert.deepEqual(s.send('more', U(2)), { ok: false, reason: 'ended' });
    assert.equal(r.owned.active(), 0);
  });
});

test('model whitelist: only zcode/*, opencode-go/* and codex/*; anything else is refused before a work dir or a child exists', async (t) => {
  await withRig(t, async (r) => {
    for (const model of ['gpt-5', 'openai/gpt-5', 'codex/', 'zcode', 'codex/a b', 'codex/../x', 'CODEX/gpt', ' codex/gpt']) {
      const made = r.owned.create({ model });
      assert.deepEqual(made, { ok: false, reason: 'model-refused', detail: model }, model);
    }
    assert.equal(r.spawned, 0);
    assert.deepEqual(fs.readdirSync(r.workRoot), []);
    let launched = 0;
    const direct = startCodexSession({
      ownedId: '0'.repeat(20), cwd: r.workRoot, model: 'anthropic/claude', approvals: r.approvals, now: () => 0, redact: (text) => ({ text, count: 0 }),
      launch: () => {
        launched++;
        throw new Error('must not launch');
      },
    });
    assert.deepEqual(direct, { ok: false, reason: 'model-refused', detail: 'anthropic/claude' });
    assert.equal(launched, 0);
    for (const model of ['zcode/GLM-5.3', 'opencode-go/claude-haiku-5-5', 'codex/gpt-6.1-sol']) {
      const made = r.owned.create({ model });
      assert.ok(made.ok, model);
      made.session.end();
    }
  });
});

test('the limit of running sessions: a fourth is refused with owned-limit until one ends', async (t) => {
  await withRig(t, async (r) => {
    const made = [r.owned.create(), r.owned.create(), r.owned.create()];
    assert.ok(made.every((m) => m.ok));
    assert.deepEqual(r.owned.create(), { ok: false, reason: 'owned-limit', detail: '3 running' });
    (made[0] as { session: CodexSession }).session.end();
    const again = r.owned.create();
    assert.ok(again.ok);
  });
});
