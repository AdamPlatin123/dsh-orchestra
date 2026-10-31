import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { resolveEnv } from '../../src/runtime/env.ts';
import type { ResolvedEnv } from '../../src/runtime/env.ts';
import { computeHarnessRoots, launcherRootFs } from '../../src/fs/harness-roots.ts';
import { ReadGate, ReadGateError } from '../../src/fs/read-gate.ts';
import { realIo } from '../helpers/read-io.ts';
import type { Milestone, ReadDecision, ReadGateConfig, ReadIo } from '../../src/fs/read-gate.ts';
import { junction, probeAds, probeJunction, put, shortNameOf, withTmp } from '../helpers/tmp.ts';

const U1 = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Fixture = { base: string; home: string; claude: string; dsh: string; codex: string; gate: ReadGate; make(cfg?: Partial<ReadGateConfig>): ReadGate };

const rootsOf = (env: ResolvedEnv) => computeHarnessRoots(env, launcherRootFs(env));

/** Hard links need a volume that has them; the caller skips with the reason otherwise. */
function tryLink(existing: string, alias: string): string | null {
  try {
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.linkSync(existing, alias);
    return null;
  } catch (e) {
    return `hard link creation failed: ${(e as { code?: string }).code}`;
  }
}

/** A fake home with every file the policy must allow or deny, generated on the spot. */
function fixture(t: TestContext, milestone: Milestone = 'M0'): Fixture {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  const claude = path.join(home, '.claude');
  const dsh = path.join(home, '.dsh');
  const codex = path.join(home, '.codex');
  const files = [
    ...['sessions/123.json', 'sessions/abc.json', 'sessions/123.key', 'projects/x/y.jsonl', 'projects/x/credentials.jsonl',
      'projects/x/y.bak.jsonl', 'projects/x/.env.jsonl', 'projects/x/sub/subagents/agent-1.meta.json', 'projects/x/subagents/auth.json',
      '.claude.json', '.claude.json.backup', '.credentials.json', 'settings.json', 'cookies.json', 'a.storageState.json', '.env', '.env.local',
      'settings.json.bak', 'daemon/pipe.key', 'server.key'].map((f) => path.join(claude, f)),
    ...[`sessions/--G--proj--/${U1}/session.v4.jsonl.zstd`, `sessions/--G--proj--/session-${U2}/session.v4.jsonl.zstd`,
      `sessions/--G--proj--/${U1}/session.jsonl.zstd`, `sessions/plain/${U1}/session.v4.jsonl.zstd`, '.credentials.yaml', '.credentials.yaml.bak',
      'watchdog-2026-10-30.log', 'storages/session_projcache', 'bot/state.json', 'settings.yml'].map((f) => path.join(dsh, f)),
    ...['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm', 'auth.json', 'thread_history_1.sqlite', 'logs_2.sqlite',
      `sessions/2026/10/30/rollout-2026-10-30T01-02-03-${U1}.jsonl`, `sessions/2026/10/29/rollout-2026-10-29T01-02-03-${U2}.jsonl.zst`,
      'config.toml'].map((f) => path.join(codex, f)),
    path.join(home, 'notes.txt'),
    path.join(home, '.rec', 'claude', 'accounts', 'notes.txt'),
  ];
  for (const f of files) put(f, `content of ${path.basename(f)}`);
  fs.mkdirSync(path.join(claude, 'sessions', '999.json'));
  const env = resolveEnv({ home, env: {}, extraHarnessRoots: [path.join(base, 'dsbot-desktop')] });
  put(path.join(base, 'dsbot-desktop', 'state.json'));
  const roots = rootsOf(env);
  const make = (cfg: Partial<ReadGateConfig> = {}) => new ReadGate({ roots, milestone, ...cfg });
  return { base, home, claude, dsh, codex, gate: make(), make };
}

function why(d: ReadDecision): string {
  if (d.allow) return `allow:${d.rule}`;
  if (d.reason === 'denied-name') return `denied-name:${d.rule}`;
  if (d.reason === 'bad-path') return `bad-path:${d.detail}`;
  return d.reason;
}

test('must deny: every credential-like name, even where an allow rule would match (deny before allow)', (t) => {
  const { claude, dsh, codex, gate } = fixture(t);
  const cases: Array<[string, string]> = [
    [path.join(claude, 'sessions', '123.key'), 'denied-name:*.key'],
    [path.join(claude, 'server.key'), 'denied-name:*.key'],
    [path.join(claude, 'daemon', 'pipe.key'), 'denied-name:*.key'],
    [path.join(claude, '.credentials.json'), 'denied-name:*credentials*'],
    [path.join(claude, 'projects', 'x', 'credentials.jsonl'), 'denied-name:*credentials*'],
    [path.join(codex, 'auth.json'), 'denied-name:auth.json'],
    [path.join(claude, 'projects', 'x', 'subagents', 'auth.json'), 'denied-name:auth.json'],
    [path.join(claude, '.claude.json'), 'denied-name:.claude.json*'],
    [path.join(claude, '.claude.json.backup'), 'denied-name:.claude.json*'],
    [path.join(claude, 'settings.json.bak'), 'denied-name:*.bak*'],
    [path.join(claude, 'projects', 'x', 'y.bak.jsonl'), 'denied-name:*.bak*'],
    [path.join(dsh, 'watchdog-2026-10-30.log'), 'denied-name:watchdog*.log'],
    [path.join(claude, '.env'), 'denied-name:.env*'],
    [path.join(claude, '.env.local'), 'denied-name:.env*'],
    [path.join(claude, 'projects', 'x', '.env.jsonl'), 'denied-name:.env*'],
    [path.join(codex, 'thread_history_1.sqlite'), 'denied-name:thread_history_1.sqlite*'],
    [path.join(codex, 'logs_2.sqlite'), 'denied-name:logs_2.sqlite*'],
    [path.join(dsh, '.credentials.yaml'), 'denied-name:.credentials.yaml*'],
    [path.join(dsh, '.credentials.yaml.bak'), 'denied-name:.credentials.yaml*'],
    [path.join(claude, 'cookies.json'), 'denied-name:cookies.json'],
    [path.join(claude, 'a.storageState.json'), 'denied-name:*storageState*.json'],
    [path.join(claude, 'sessions', 'abc.json'), 'not-whitelisted'],
    [path.join(claude, 'settings.json'), 'not-whitelisted'],
    [path.join(dsh, `sessions/--G--proj--/${U1}/session.jsonl.zstd`), 'not-whitelisted'],
    [path.join(dsh, `sessions/plain/${U1}/session.v4.jsonl.zstd`), 'not-whitelisted'],
    [path.join(dsh, 'settings.yml'), 'not-whitelisted'],
    [path.join(codex, 'state_5.sqlite-shm'), 'not-whitelisted'],
    [path.join(codex, 'config.toml'), 'not-whitelisted'],
  ];
  for (const [file, want] of cases) {
    assert.equal(why(gate.decide(file, 'read')), want, file);
    assert.throws(() => gate.readFile(file), (e: unknown) => {
      assert.ok(e instanceof ReadGateError);
      assert.equal(e.code, 'ERR_ORCHESTRA_READ_GATE');
      assert.equal(why(e.decision), want);
      return true;
    });
  }
  assert.equal(gate.openHandles(), 0);
});

test('must allow: the whitelisted files of each root, and their content comes back', (t) => {
  const { claude, dsh, codex, gate } = fixture(t);
  const cases: Array<[string, string]> = [
    [path.join(claude, 'sessions', '123.json'), 'sessions/<digits>.json'],
    [path.join(claude, 'projects', 'x', 'y.jsonl'), 'projects/**/*.jsonl'],
    [path.join(claude, 'projects', 'x', 'sub', 'subagents', 'agent-1.meta.json'), '**/subagents/**'],
    [path.join(dsh, `sessions/--G--proj--/${U1}/session.v4.jsonl.zstd`), 'sessions/--<cwd>--/{<uuid>|session-<uuid>}/session.v4.jsonl.zstd'],
    [path.join(dsh, `sessions/--G--proj--/session-${U2}/session.v4.jsonl.zstd`), 'sessions/--<cwd>--/{<uuid>|session-<uuid>}/session.v4.jsonl.zstd'],
    [path.join(dsh, 'storages', 'session_projcache'), 'storages/session_projcache'],
    [path.join(codex, 'state_5.sqlite'), 'state_5.sqlite'],
    [path.join(codex, 'state_5.sqlite-wal'), 'state_5.sqlite-wal'],
    [path.join(codex, `sessions/2026/10/30/rollout-2026-10-30T01-02-03-${U1}.jsonl`), 'sessions/**/rollout-*.jsonl'],
    [path.join(codex, `sessions/2026/10/29/rollout-2026-10-29T01-02-03-${U2}.jsonl.zst`), 'sessions/**/rollout-*.jsonl.zst'],
  ];
  for (const [file, rule] of cases) {
    assert.equal(why(gate.decide(file, 'read')), `allow:${rule}`, file);
    assert.equal(gate.readFile(file).toString('utf8'), `content of ${path.basename(file)}`);
  }
  assert.equal(gate.readRange(cases[0]![0], 11, 3).toString('utf8'), '123');
  assert.equal(gate.readRange(cases[0]![0], 1000, 3).length, 0);
  assert.equal(gate.openHandles(), 0);
});

test('deny rules judge file names, not directories: a project slug containing "credentials" is still a transcript', (t) => {
  const { claude, gate } = fixture(t);
  const transcript = put(path.join(claude, 'projects', 'C--work-credentials-service', 's.jsonl'), 'ok');
  const hidden = put(path.join(claude, 'projects', 'C--work-credentials-service', 'auth.json'), 'no');
  assert.equal(why(gate.decide(transcript, 'read')), 'allow:projects/**/*.jsonl');
  assert.equal(why(gate.decide(hidden, 'read')), 'denied-name:auth.json');
});

test('rules that start in a later milestone are inactive in M0 and active from their milestone', (t) => {
  const m0 = fixture(t);
  const botState = path.join(m0.dsh, 'bot', 'state.json');
  const rollout = path.join(m0.codex, `sessions/2026/10/30/rollout-2026-10-30T01-02-03-${U1}.jsonl`);
  assert.equal(why(m0.gate.decide(botState, 'read')), 'rule-not-active');
  assert.equal(why(m0.gate.decide(rollout, 'tail')), 'tail-not-allowed');
  const m2 = m0.make({ milestone: 'M2' });
  assert.equal(why(m2.decide(botState, 'read')), 'allow:bot/state.json');
  assert.equal(why(m2.decide(rollout, 'tail')), 'allow:sessions/**/rollout-*.jsonl');
});

test('tail handles only on files whose rule allows tailing', (t) => {
  const { claude, dsh, codex, gate } = fixture(t);
  assert.equal(why(gate.decide(path.join(dsh, `sessions/--G--proj--/${U1}/session.v4.jsonl.zstd`), 'tail')).startsWith('allow:'), true);
  assert.equal(why(gate.decide(path.join(claude, 'projects', 'x', 'y.jsonl'), 'tail')), 'tail-not-allowed');
  assert.equal(why(gate.decide(path.join(codex, 'state_5.sqlite'), 'tail')), 'tail-not-allowed');
  assert.throws(() => gate.openTail(path.join(codex, 'state_5.sqlite')), ReadGateError);
  assert.equal(gate.openHandles(), 0);
});

test('outside every root, and existence is not leaked: a missing path gets the same policy reason', (t) => {
  const { base, home, claude, codex, gate } = fixture(t);
  assert.equal(why(gate.decide(path.join(home, 'notes.txt'), 'read')), 'outside-roots');
  assert.equal(why(gate.decide(path.join(home, 'missing.txt'), 'read')), 'outside-roots');
  assert.equal(why(gate.decide(path.join(base, 'elsewhere', 'sessions', '1.json'), 'read')), 'outside-roots');
  assert.equal(why(gate.decide(path.join(codex, 'auth.json'), 'stat')), 'denied-name:auth.json');
  assert.equal(why(gate.decide(path.join(codex, 'sessions', 'auth.json'), 'stat')), 'denied-name:auth.json');
  assert.equal(why(gate.decide(path.join(claude, 'sessions', '777.json'), 'read')), 'not-found');
  assert.equal(why(gate.decide(path.join(claude, 'sessions', '999.json'), 'read')), 'not-a-file');
});

test('stat and readdir only inside listable roots, the glob prefix included; files there are still not readable', (t) => {
  const { base, home, claude, codex, gate } = fixture(t);
  assert.ok(gate.readdir(claude).includes('sessions'));
  assert.deepEqual(gate.readdir(path.join(claude, 'sessions')).sort(), ['123.json', '123.key', '999.json', 'abc.json']);
  assert.equal(gate.stat(path.join(codex, 'state_5.sqlite')).isFile(), true);
  const prefix = path.join(home, '.rec', 'claude', 'accounts');
  assert.deepEqual(gate.readdir(prefix), ['notes.txt']);
  assert.equal(why(gate.decide(path.join(prefix, 'notes.txt'), 'read')), 'not-whitelisted');
  assert.equal(why(gate.decide(home, 'readdir')), 'outside-roots');
  assert.equal(why(gate.decide(path.join(base, 'dsbot-desktop'), 'readdir')), 'not-listable');
  assert.equal(why(gate.decide(path.join(base, 'dsbot-desktop', 'state.json'), 'read')), 'not-whitelisted');
  assert.equal(why(gate.decide(path.join(claude, 'sessions', '123.json'), 'readdir')), 'not-a-directory');
  assert.throws(() => gate.readdir(home), ReadGateError);
  assert.deepEqual(gate.subdirs(path.join(claude, 'sessions')), ['999.json']);
  assert.throws(() => gate.subdirs(home), ReadGateError);
});

test('PoC: a hard link to a credential file under an allowed name is refused, for read and tail alike', (t) => {
  const { claude, dsh, gate } = fixture(t);
  const creds = path.join(claude, '.credentials.json');
  const alias = path.join(claude, 'projects', 'x', 'transcript.jsonl');
  const skip = tryLink(creds, alias);
  if (skip !== null) return t.skip(skip);
  assert.equal(why(gate.decide(creds, 'read')), 'denied-name:*credentials*');
  const d = gate.decide(alias, 'read');
  assert.deepEqual(d.allow ? d : [d.reason, (d as { links?: number }).links], ['hardlink', 2]);
  for (const read of [() => gate.readFile(alias), () => gate.readRange(alias, 0, 6)]) {
    assert.throws(read, (e: unknown) => {
      assert.ok(e instanceof ReadGateError);
      assert.equal(e.decision.reason, 'hardlink');
      return true;
    });
  }
  const session = path.join(dsh, `sessions/--G--x--/${U1}/session.v4.jsonl.zstd`);
  const skipTail = tryLink(path.join(dsh, '.credentials.yaml'), session);
  if (skipTail !== null) return t.skip(skipTail);
  assert.equal(why(gate.decide(session, 'tail')), 'hardlink');
  assert.throws(() => gate.openTail(session), ReadGateError);
  assert.equal(gate.openHandles(), 0);
});

test('a hard link made between the check and the open is caught on the handle, which is closed', (t) => {
  const { base, claude, make } = fixture(t);
  const file = path.join(claude, 'sessions', '123.json');
  const opened: number[] = [];
  const closed: number[] = [];
  let skip: string | null = null;
  const io: ReadIo = {
    ...realIo,
    openSync: (p, flags) => {
      skip = tryLink(p, path.join(base, 'late-link.json'));
      const fd = realIo.openSync(p, flags);
      opened.push(fd);
      return fd;
    },
    closeSync: (fd) => {
      closed.push(fd);
      realIo.closeSync(fd);
    },
  };
  const gate = make({ io });
  assert.equal(why(gate.decide(file, 'read')), 'allow:sessions/<digits>.json');
  let err: unknown = null;
  try {
    gate.readFile(file);
  } catch (e) {
    err = e;
  }
  if (skip !== null) return t.skip(skip);
  assert.ok(err instanceof ReadGateError, String(err));
  assert.equal(err.decision.reason, 'hardlink');
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened);
  assert.equal(gate.openHandles(), 0);
});

test('ORCHESTRA_HOME inside a harness root does not widen it: the harness policy decides there (deny first)', (t) => {
  const { home, claude, make } = fixture(t);
  const orch = path.join(claude, 'x');
  const inside = put(path.join(orch, 'history.jsonl.txt'), 'h');
  const nested = make({ orchestraHome: orch });
  const d = nested.decide(inside, 'read');
  assert.equal(why(d), 'not-whitelisted');
  assert.equal((d as { kind?: string }).kind, 'claude');
  assert.throws(() => nested.readFile(inside), ReadGateError);
  const around = make({ orchestraHome: home });
  assert.equal(why(around.decide(path.join(claude, 'settings.json'), 'read')), 'not-whitelisted');
  assert.equal(why(around.decide(path.join(claude, 'sessions', '123.json'), 'read')), 'allow:sessions/<digits>.json');
});

test('version files: the exact package.json is readable, its neighbours are not', (t) => {
  const { base, make } = fixture(t);
  const appData = path.join(base, 'appdata');
  const dshPkg = put(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"version":"0.2.1-rc.2"}');
  put(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'secret.json'));
  const gate = make({ versionFiles: [dshPkg] });
  assert.equal(why(gate.decide(dshPkg, 'read')), 'allow:package.json');
  assert.equal(JSON.parse(gate.readFile(dshPkg).toString('utf8')).version, '0.2.1-rc.2');
  assert.equal(why(gate.decide(path.join(path.dirname(dshPkg), 'secret.json'), 'read')), 'outside-roots');
});

test('orchestrad may read its own data dir, minus the global deny names', (t) => {
  const { home, make } = fixture(t);
  const orch = path.join(home, '.orchestra');
  put(path.join(orch, 'journal.jsonl'), 'j');
  put(path.join(orch, 'secrets.key'), 'k');
  const gate = make({ orchestraHome: orch });
  assert.equal(gate.readFile(path.join(orch, 'journal.jsonl')).toString(), 'j');
  assert.equal(why(gate.decide(path.join(orch, 'secrets.key'), 'read')), 'denied-name:*.key');
});

test('a junction out of a root is judged by where it leads', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, claude, gate } = fixture(t);
  put(path.join(base, 'secret', 'y.jsonl'), 'secret');
  put(path.join(base, 'secret', 'auth.json'), 'secret');
  junction(base, path.join(claude, 'projects', 'link'), path.join(base, 'secret'));
  assert.equal(why(gate.decide(path.join(claude, 'projects', 'link', 'y.jsonl'), 'read')), 'outside-roots');
  assert.equal(why(gate.decide(path.join(claude, 'projects', 'link'), 'readdir')), 'outside-roots');
  junction(base, path.join(claude, 'projects', 'inner'), path.join(claude, 'sessions'));
  assert.equal(why(gate.decide(path.join(claude, 'projects', 'inner', 'abc.json'), 'read')), 'not-whitelisted');
  assert.equal(why(gate.decide(path.join(claude, 'projects', 'inner', '123.json'), 'read')), 'allow:sessions/<digits>.json');
});

test('an 8.3 short name is judged by the long name it stands for', (t) => {
  const { claude, gate } = fixture(t);
  const shortClaudeJson = shortNameOf(claude, '.claude.json');
  if (shortClaudeJson === null) return t.skip('the temp volume does not generate 8.3 short names');
  assert.equal(why(gate.decide(path.join(claude, shortClaudeJson), 'read')), 'denied-name:.claude.json*');
  const shortCreds = shortNameOf(claude, '.credentials.json');
  if (shortCreds !== null) assert.equal(why(gate.decide(path.join(claude, shortCreds), 'read')), 'denied-name:*credentials*');
});

test('an alternate data stream of an allowed file is refused by name', (t) => {
  const probe = probeAds();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, gate } = fixture(t);
  const file = path.join(claude, 'projects', 'x', 'y.jsonl');
  fs.writeFileSync(`${file}:hidden`, 'stream');
  assert.equal(fs.readFileSync(`${file}:hidden`, 'utf8'), 'stream');
  assert.equal(why(gate.decide(`${file}:hidden`, 'read')), 'bad-path:ads');
  assert.equal(gate.readFile(file).toString('utf8'), 'content of y.jsonl');
});

test('test mode refuses everything outside the test dirs before any fs call', (t) => {
  const outside = fixture(t);
  const testDir = withTmp(t);
  put(path.join(testDir, 'roots', 'claude', 'sessions', '1.json'), '{}');
  const calls: string[] = [];
  const io: ReadIo = {
    ...realIo,
    realpath: (p) => {
      calls.push(`realpath ${p}`);
      return realIo.realpath(p);
    },
    statSync: (p) => {
      calls.push(`stat ${p}`);
      return realIo.statSync(p);
    },
  };
  const testRoot = path.join(testDir, 'roots', 'claude');
  const outsideRoots = rootsOf(resolveEnv({ home: outside.home, env: {} }));
  const gate = new ReadGate({
    roots: [...outsideRoots, { kind: 'claude', path: testRoot, real: testRoot }],
    versionFiles: [path.join(outside.home, 'package.json')],
    orchestraHome: path.join(outside.home, '.orchestra'),
    testDirs: [testDir],
    io,
  });
  assert.equal(gate.testMode, true);
  for (const op of ['read', 'stat', 'readdir'] as const) {
    assert.equal(why(gate.decide(path.join(outside.claude, 'sessions', '123.json'), op)), 'test-mode-outside');
    assert.equal(why(gate.decide(path.join(outside.home, '.orchestra', 'x'), op)), 'test-mode-outside');
  }
  const leaked = calls.filter((c) => !c.toLowerCase().includes(testDir.toLowerCase()));
  assert.deepEqual(leaked, [], 'the gate touched a path outside the test dir');
  assert.equal(gate.readFile(path.join(testRoot, 'sessions', '1.json')).toString(), '{}');
});

test('test mode: a junction from the test dir to elsewhere is refused after canonicalization', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const base = withTmp(t);
  const testDir = path.join(base, 'orchestra-test-x');
  put(path.join(base, 'real', 'sessions', '5.json'), '{}');
  fs.mkdirSync(path.join(testDir, 'roots'), { recursive: true });
  junction(base, path.join(testDir, 'roots', 'claude'), path.join(base, 'real'));
  const root = path.join(testDir, 'roots', 'claude');
  const gate = new ReadGate({ roots: [{ kind: 'claude', path: root, real: root }], testDirs: [testDir] });
  assert.equal(why(gate.decide(path.join(root, 'sessions', '5.json'), 'read')), 'test-mode-outside');
});

test('decisions are deterministic and bad paths are typed', (t) => {
  const { claude, gate } = fixture(t);
  const file = path.join(claude, 'sessions', '123.json');
  assert.deepEqual(gate.decide(file, 'read'), gate.decide(file, 'read'));
  assert.equal(why(gate.decide('relative\\x', 'read')), 'bad-path:not-absolute');
  assert.equal(why(gate.decide(`\\\\?\\${file}`, 'read')), 'bad-path:device-namespace');
  assert.equal(why(gate.decide(`${file}.`, 'read')), 'bad-path:trailing-dot-or-space');
  assert.throws(() => new ReadGate({ roots: [], testDirs: [] }), /test mode needs at least one test dir/);
});
