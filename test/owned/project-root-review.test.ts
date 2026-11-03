import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { CodexSession } from '../../src/owned/codex-session.ts';
import type { ClaudeSession } from '../../src/owned/claude-session.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Approvals } from '../../src/owned/approvals.ts';
import { startCodexSession } from '../../src/owned/codex-session.ts';
import { CWD_GUARDED, guardedIn, guardedPlace } from '../../src/owned/guarded.ts';
import { DEFAULT_CODEX_MODEL, DEFAULT_CLAUDE_MODEL } from '../../src/owned/models.ts';
import { initMessage } from '../fixtures/fake-sdk.ts';
import { claudeRig, until } from '../helpers/claude-host.ts';

// The project-root review's fixes in the owned sessions: r4 §7.4's protected paths inside the cwd make a
// change there a high-risk card (both harnesses); a Codex session in a project root takes only the
// read-only sandbox; a Claude session started for an agent request in a project root is tainted (r4 §8.5),
// so its reads in cwd ask too. In-memory pipes, the fake SDK, a virtual clock: no child, no model.

const CWD = 'D:\\work\\proj';
const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

test('guardedIn: r4 §7.4\'s list inside the cwd, at any depth, any case; outside the cwd or a look-alike name is not this table\'s', () => {
  assert.deepEqual([...CWD_GUARDED], ['.claude/**', '.mcp.json', '.codex/**', '.dsh/**', 'cordis.patch.yml', '.git/hooks/**', '.vscode/tasks.json', 'package.json', '.husky/**']);
  const g = (rel: string) => guardedIn(`${CWD}\\${rel}`, CWD);
  assert.equal(g('.claude\\settings.json'), '.claude/**');
  assert.equal(g('.CLAUDE'), '.claude/**');
  assert.equal(g('web\\.claude\\settings.local.json'), '.claude/**', 'a folder below may be where Claude Code starts next');
  assert.equal(g('.mcp.json'), '.mcp.json');
  assert.equal(g('.codex\\config.toml'), '.codex/**');
  assert.equal(g('.dsh\\cordis.yml'), '.dsh/**');
  assert.equal(g('cordis.patch.yml'), 'cordis.patch.yml');
  assert.equal(g('.git\\hooks\\pre-commit'), '.git/hooks/**');
  assert.equal(g('.Git\\Hooks'), '.git/hooks/**');
  assert.equal(g('.vscode\\tasks.json'), '.vscode/tasks.json');
  assert.equal(g('web\\package.json'), 'package.json');
  assert.equal(g('.husky\\pre-push'), '.husky/**');
  for (const rel of ['src\\index.ts', 'README.md', '.git\\config', '.vscode\\settings.json', 'package.json.bak', 'claude\\x', 'hooks\\.git']) assert.equal(g(rel), null, rel);
  assert.equal(guardedIn(CWD, CWD), null, 'the cwd itself');
  assert.equal(guardedIn('D:\\work\\other\\.claude\\x', CWD), null, 'outside the cwd: the place rule says that');
  // The realpath counts too: an 8.3 short name (GIT~1) resolves to .git there.
  assert.equal(guardedPlace({ p: `${CWD}\\GIT~1\\hooks\\pre-commit`, real: `${CWD}\\.git\\hooks\\pre-commit` }, CWD, CWD), '.git/hooks/**');
});

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

async function codex(opts: { projectRoot?: boolean; sandbox: string }): Promise<{ s: CodexSession; m: ReturnType<typeof memPipe>; approvals: Approvals }> {
  const clock = new VirtualClock({ mono: 1_000, wall: 1_800_000_000_000 });
  const approvals = new Approvals({ hub: clock, settleMs: 0 });
  const m = memPipe();
  const started = startCodexSession({
    ownedId: '0123456789abcdef0123', cwd: CWD, model: DEFAULT_CODEX_MODEL, launch: () => m.pipe, approvals, now: () => clock.wall,
    redact: (text) => ({ text, count: 0 }), hub: clock, ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
  });
  assert.ok(started.ok);
  await settle();
  m.send({ id: 1, result: { userAgent: 'orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)' } });
  await settle();
  m.send({ id: 2, result: { thread: { id: 'thr' }, approvalPolicy: 'on-request', sandbox: { type: opts.sandbox } } });
  await settle();
  return { s: started.session, m, approvals };
}

test('Codex in a project root: only the read-only sandbox is taken; workspaceWrite there ends the session as policy-mismatch (its own work dir keeps both)', async () => {
  const ro = await codex({ projectRoot: true, sandbox: 'readOnly' });
  assert.equal(await ro.s.ready, true);
  const ww = await codex({ projectRoot: true, sandbox: 'workspaceWrite' });
  assert.equal(await ww.s.ready, false);
  assert.deepEqual([ww.s.state, ww.s.endReason], ['failed', 'policy-mismatch']);
  const work = await codex({ sandbox: 'workspaceWrite' });
  assert.equal(await work.s.ready, true, 'outside a project root, as before');
});

test('Codex: a file change to a protected path in the cwd (.git/hooks, .claude, package.json) is a high-risk card that says so; an ordinary file stays a write', async () => {
  const r = await codex({ projectRoot: true, sandbox: 'readOnly' });
  assert.equal(await r.s.ready, true);
  const ask = (n: number, p: string) => {
    r.m.send({ method: 'item/started', params: { threadId: 'thr', item: { type: 'fileChange', id: `fc${n}`, changes: [{ path: p, kind: { type: 'update' }, diff: '+x' }] } } });
    r.m.send({ id: `srv-${n}`, method: 'item/fileChange/requestApproval', params: { threadId: 'thr', itemId: `fc${n}` } });
  };
  ask(1, '.git\\hooks\\pre-commit');
  ask(2, `${CWD}\\.claude\\settings.json`);
  ask(3, 'web\\package.json');
  ask(4, 'src\\index.ts');
  await settle();
  const cards = r.approvals.list();
  assert.deepEqual(cards.map((a) => [a.risk, a.high]), [['protected', true], ['protected', true], ['protected', true], ['write', false]]);
  assert.match(cards[0]!.preview, /^changes a protected path in the work dir \(r4 §7\.4[^\n]*\.git\/hooks\/\*\*/);
  assert.ok(!cards[3]!.preview.includes('protected path'));
});

async function claude(t: Parameters<typeof claudeRig>[0], tainted: boolean): Promise<{ r: ReturnType<typeof claudeRig>; s: ClaudeSession; cwd: string }> {
  const r = claudeRig(t);
  const made = r.owned.create({ text: 'look around', uuid: U(1), ...(tainted ? { tainted: true } : {}) });
  assert.ok(made.ok, JSON.stringify(made));
  await until('the first message reaches the SDK', () => r.host.calls.length === 1 && r.host.calls[0]!.sdk.queries.length === 1 && r.q().received.length === 1);
  r.q().emit(initMessage({ model: DEFAULT_CLAUDE_MODEL }));
  assert.equal(await made.session.ready, true);
  return { r, s: made.session, cwd: path.join(r.workRoot, made.ownedId) };
}

test('Claude, tainted (an agent request in a project root, r4 §8.5): a Read in cwd asks (an ordinary card), where an untainted session reads by the CLI\'s default', async (t) => {
  const a = await claude(t, true);
  const read = await a.r.q().callTool('Read', { file_path: 'notes.txt' }, 'toolu_r');
  assert.equal(read.decision, 'ask', 'the host asks for a read in cwd');
  await until('the card', () => a.r.approvals.list().length === 1);
  assert.deepEqual([a.r.approvals.list()[0]!.risk, a.r.approvals.list()[0]!.high], ['other', false]);
  const b = await claude(t, false);
  const plain = await b.r.q().callTool('Read', { file_path: 'notes.txt' }, 'toolu_r');
  assert.equal(plain.decision, 'default', 'untainted: as before');
  assert.equal(b.r.approvals.list().length, 0);
});

test('Claude: a Write to a protected path in cwd (.claude\\settings.json) is a high-risk card that says so; another file stays a write', async (t) => {
  const a = await claude(t, false);
  void a.r.q().callTool('Write', { file_path: '.claude\\settings.json', content: '{}' }, 'toolu_w1');
  await until('the first card', () => a.r.approvals.list().length === 1);
  void a.r.q().callTool('Write', { file_path: 'a.txt', content: 'x' }, 'toolu_w2');
  await until('the second card', () => a.r.approvals.list().length === 2);
  const [g, w] = a.r.approvals.list();
  assert.deepEqual([g!.risk, g!.high, w!.risk, w!.high], ['protected', true, 'write', false]);
  assert.ok(g!.preview.includes('changes a protected path in the work dir (r4 §7.4') && g!.preview.includes('.claude/**'), g!.preview);
});
