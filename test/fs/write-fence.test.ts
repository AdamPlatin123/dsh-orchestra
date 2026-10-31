import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { resolveEnv } from '../../src/runtime/env.ts';
import type { ResolvedEnv } from '../../src/runtime/env.ts';
import { computeHarnessRoots, launcherRootFs, rootDenyList } from '../../src/fs/harness-roots.ts';
import { WriteFence, WriteFenceError } from '../../src/fs/write-fence.ts';
import { makeReadGate, makeWriteFence, realpath } from '../../src/fs/node-io.ts';
import { realWriteIo } from '../helpers/write-io.ts';
import type { WriteDecision, WriteIo } from '../../src/fs/write-fence.ts';
import { junction, probeJunction, probeSymlink, put, shortNameOf, treeDigest, withTmp } from '../helpers/tmp.ts';

type Fixture = { base: string; home: string; orch: string; fence: WriteFence; make(io: WriteIo): WriteFence };

const fsPorts = { makeReadGate, realpath };
const computeHarnessRootsOf = (env: ResolvedEnv) => computeHarnessRoots(env, launcherRootFs(env, fsPorts));
/** A fence on the real fs through the test's own io (the production io is private to node-io.ts and is exercised through makeWriteFence). */
const fenceOf = (cfg: Omit<ConstructorParameters<typeof WriteFence>[0], 'io'>) => new WriteFence({ ...cfg, io: realWriteIo });

/** Fake user home with three harness roots; ORCHESTRA_HOME defaults to <home>\.orchestra. */
function fixture(t: TestContext, orchestraHome?: (home: string) => string): Fixture {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  put(path.join(home, '.claude', 'settings.json'), '{"a":1}');
  put(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), '{}\n');
  put(path.join(home, '.dsh', 'sessions', 'x.zstd'), 'zz');
  put(path.join(home, '.codex', 'state_5.sqlite'), 'db');
  const orch = orchestraHome ? orchestraHome(home) : path.join(home, '.orchestra');
  const env = resolveEnv({ home, env: { ORCHESTRA_HOME: orch } });
  const harnessRoots = rootDenyList(computeHarnessRootsOf(env));
  const make = (io?: WriteIo) => new WriteFence({ orchestraHome: env.orchestraHome, harnessRoots, io: io ?? realWriteIo });
  return { base, home, orch, fence: make(), make };
}

type Staged = { io: WriteIo; ran(): boolean; closed(): boolean; renames: Array<[string, string]> };

/**
 * Real fs underneath; `before` runs once, just before the fence's first open or mkdir (after its
 * check), `after` once, just after that open returned, and `afterClose` once, just after the first
 * close (in writeAtomic: between the temp file's close and the re-checks before its rename). Every
 * rename is recorded. This is how a racing process is staged.
 */
function staged(stage: { before?: () => void; after?: () => void; afterClose?: () => void }): Staged {
  let ran = false;
  let closed = false;
  const renames: Array<[string, string]> = [];
  return {
    io: {
      ...realWriteIo,
      openSync: (p, flags) => {
        const first = !ran;
        if (first) stage.before?.();
        ran = true;
        const fd = realWriteIo.openSync(p, flags);
        if (first) stage.after?.();
        return fd;
      },
      mkdirSync: (p) => {
        if (!ran) stage.before?.();
        ran = true;
        fs.mkdirSync(p);
      },
      closeSync: (fd) => {
        fs.closeSync(fd);
        if (!closed) {
          closed = true;
          stage.afterClose?.();
        }
      },
      renameSync: (from, to) => {
        renames.push([from, to]);
        fs.renameSync(from, to);
      },
    },
    ran: () => ran,
    closed: () => closed,
    renames,
  };
}

function changed(detail: string): (e: unknown) => boolean {
  return (e) => {
    assert.ok(e instanceof WriteFenceError, String(e));
    assert.equal(e.decision.reason, 'changed-during-open');
    assert.equal((e.decision as { detail?: string }).detail, detail);
    return true;
  };
}

function tryLink(existing: string, alias: string): string | null {
  try {
    fs.linkSync(existing, alias);
    return null;
  } catch (e) {
    return `hard link creation failed: ${(e as { code?: string }).code}`;
  }
}

function reason(d: WriteDecision): string {
  return d.allow ? 'allow' : d.reason === 'bad-path' ? `bad-path:${d.detail}` : d.reason;
}

test('writes inside ORCHESTRA_HOME: mkdirp, writeAtomic, append; no temp file left behind', (t) => {
  const { orch, fence } = fixture(t);
  assert.deepEqual(fence.mkdirp(path.join(orch, 'run')), [orch, path.join(orch, 'run')]);
  assert.deepEqual(fence.mkdirp(path.join(orch, 'run')), []);
  const file = path.join(orch, 'run', 'daemon.json');
  fence.writeAtomic(file, '{"v":1}');
  fence.writeAtomic(file, '{"v":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}');
  fence.append(path.join(orch, 'run', 'log.jsonl'), 'a\n');
  fence.append(path.join(orch, 'run', 'log.jsonl'), Buffer.from('b\n'), { fsync: true });
  assert.equal(fs.readFileSync(path.join(orch, 'run', 'log.jsonl'), 'utf8'), 'a\nb\n');
  assert.deepEqual(fs.readdirSync(path.join(orch, 'run')).sort(), ['daemon.json', 'log.jsonl']);
});

test('lexical escapes are denied with a typed reason and nothing is written', (t) => {
  const { base, home, orch, fence } = fixture(t);
  fence.mkdirp(orch);
  const cases: Array<[string, string]> = [
    [path.join(orch, '..', '.claude', 'x'), 'harness-root'],
    [`${orch}\\..\\.claude\\settings.json`, 'harness-root'],
    [path.join(orch, '..', 'elsewhere.txt'), 'outside-home'],
    [path.join(base, 'outside.txt'), 'outside-home'],
    [path.join(home, '.CLAUDE', 'x'), 'harness-root'],
    [path.join(home, '.Codex', 'state_5.sqlite'), 'harness-root'],
    [path.join(orch, 'a.txt:hidden'), 'bad-path:ads'],
    [path.join(orch, 'a.txt::$DATA'), 'bad-path:ads'],
    [`${path.join(home, '.claude')}:stream`, 'bad-path:ads'],
    [path.join(orch, 'CON'), 'bad-path:device-name'],
    [path.join(orch, 'nul.txt'), 'bad-path:device-name'],
    [path.join(orch, 'COM1'), 'bad-path:device-name'],
    [`\\\\?\\${path.join(orch, 'x')}`, 'bad-path:device-namespace'],
    [`\\\\.\\${path.join(orch, 'x')}`, 'bad-path:device-namespace'],
    [`\\\\localhost\\C$\\${path.join(orch, 'x').slice(3)}`, 'bad-path:unc'],
    [path.join(orch, 'x.'), 'bad-path:trailing-dot-or-space'],
    [`${path.join(orch, 'x')} `, 'bad-path:trailing-dot-or-space'],
    [`${path.join(home, '.claude')}.\\x`, 'bad-path:trailing-dot-or-space'],
    ['relative\\x', 'bad-path:not-absolute'],
  ];
  for (const [target, want] of cases) {
    assert.equal(reason(fence.check(target, 'write')), want, target);
    assert.throws(() => fence.writeAtomic(target, 'nope'), WriteFenceError, target);
    assert.throws(() => fence.append(target, 'nope'), WriteFenceError, target);
  }
  assert.equal(fs.existsSync(path.join(home, '.claude', 'x')), false);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(path.join(base, 'outside.txt')), false);
});

test('ORCHESTRA_HOME itself: mkdir allowed, every other operation is home-root', (t) => {
  const { orch, fence } = fixture(t);
  assert.equal(reason(fence.check(orch, 'mkdir')), 'allow');
  assert.equal(reason(fence.check(orch, 'write')), 'home-root');
  assert.equal(reason(fence.check(orch, 'append')), 'home-root');
  assert.equal(reason(fence.check(orch, 'rm')), 'home-root');
});

test('deny first: with ORCHESTRA_HOME = the fake home, writes under a harness root are still refused', (t) => {
  const { home, fence } = fixture(t, (h) => h);
  assert.equal(reason(fence.check(path.join(home, '.claude', 'x'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(home, '.dsh', 'sessions', 'y'), 'append')), 'harness-root');
  assert.equal(reason(fence.check(path.join(home, '.ds-bot', 'z'), 'mkdir')), 'harness-root');
  assert.throws(() => fence.writeAtomic(path.join(home, '.claude', 'x'), 'nope'), (e: unknown) => {
    assert.ok(e instanceof WriteFenceError);
    assert.equal(e.code, 'ERR_ORCHESTRA_WRITE_FENCE');
    assert.equal(e.decision.reason, 'harness-root');
    return true;
  });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'x')), false);
  fence.writeAtomic(path.join(home, 'ok.txt'), 'fine');
  assert.equal(fs.readFileSync(path.join(home, 'ok.txt'), 'utf8'), 'fine');
});

test('deny first: launcher roots, their glob prefix and extra roots inside ORCHESTRA_HOME are refused', (t) => {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  put(path.join(home, '.rec', 'claude', 'accounts', '1', 'config', 'sessions', '1.json'), '{}');
  put(path.join(home, '.rec', 'dsbot', 'state.json'), '{}');
  const orch = path.join(home, '.rec');
  const env = resolveEnv({ home, env: { ORCHESTRA_HOME: orch }, extraHarnessRoots: [path.join(home, '.rec', 'dsbot')] });
  const fence = fenceOf({ orchestraHome: orch, harnessRoots: rootDenyList(computeHarnessRootsOf(env)) });
  assert.equal(reason(fence.check(path.join(orch, 'claude', 'accounts', '1', 'config', 'x'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'claude', 'accounts', '2'), 'mkdir')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'dsbot', 'state.json'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'claude', 'other.txt'), 'write')), 'allow');
});

test('a launcher root behind a junction is denied at its target too (glob expansion + realpath)', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const base = withTmp(t);
  const home = path.join(base, 'home');
  const orch = path.join(base, 'data');
  put(path.join(orch, 'claude-7', 'sessions', '1.json'), '{}');
  fs.mkdirSync(path.join(home, '.rec', 'claude', 'accounts', '7'), { recursive: true });
  junction(base, path.join(home, '.rec', 'claude', 'accounts', '7', 'config'), path.join(orch, 'claude-7'));
  const env = resolveEnv({ home, env: { ORCHESTRA_HOME: orch } });
  const roots = computeHarnessRootsOf(env);
  assert.ok(roots.some((r) => r.kind === 'claude' && r.real.toLowerCase() === fs.realpathSync.native(path.join(orch, 'claude-7')).toLowerCase()));
  const fence = fenceOf({ orchestraHome: orch, harnessRoots: rootDenyList(roots) });
  assert.equal(reason(fence.check(path.join(orch, 'claude-7', 'sessions', '1.json'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'claude-7'), 'rm')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'other.json'), 'write')), 'allow');
});

test('append refuses a file with other hard links; writeAtomic replaces only its own entry', (t) => {
  const { home, orch, fence } = fixture(t, (h) => h);
  const harnessFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.join(orch, 'tmp'));
  const alias = path.join(orch, 'tmp', 'alias.json');
  try {
    fs.linkSync(harnessFile, alias);
  } catch (e) {
    return t.skip(`hard link creation failed: ${(e as { code?: string }).code}`);
  }
  const d = fence.check(alias, 'append');
  assert.deepEqual(d.allow ? null : [d.reason, (d as { links?: number }).links], ['hardlink', 2]);
  assert.throws(() => fence.append(alias, 'x'), WriteFenceError);
  fence.writeAtomic(alias, 'replaced');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'replaced');
  assert.equal(fs.readFileSync(harnessFile, 'utf8'), '{"a":1}');
  assert.equal(reason(fence.check(alias, 'append')), 'allow');
});

test('a junction inside ORCHESTRA_HOME cannot be written through', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, home, orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'tmp'));
  fs.mkdirSync(path.join(base, 'outside'));
  junction(base, path.join(orch, 'tmp', 'to-claude'), path.join(home, '.claude'));
  junction(base, path.join(orch, 'tmp', 'to-outside'), path.join(base, 'outside'));
  assert.equal(reason(fence.check(path.join(orch, 'tmp', 'to-claude', 'x'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'tmp', 'to-claude', 'settings.json'), 'append')), 'harness-root');
  assert.equal(reason(fence.check(path.join(orch, 'tmp', 'to-outside', 'x'), 'write')), 'outside-home');
  assert.throws(() => fence.append(path.join(orch, 'tmp', 'to-claude', 'settings.json'), 'x'), WriteFenceError);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(path.join(base, 'outside')), []);
});

test('ORCHESTRA_HOME behind a junction: both the written and the canonical form must be inside it', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const base = withTmp(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  put(path.join(home, '.claude', 'settings.json'));
  junction(base, path.join(home, '.orchestra'), path.join(base, 'data'));
  const env = resolveEnv({ home, env: {} });
  const fence = fenceOf({ orchestraHome: env.orchestraHome, harnessRoots: rootDenyList(computeHarnessRootsOf(env)) });
  assert.equal(reason(fence.check(path.join(home, '.orchestra', 'run', 'x'), 'write')), 'allow');
  assert.equal(reason(fence.check(path.join(base, 'data', 'run', 'x'), 'write')), 'outside-home');
});

test('an 8.3 short name of a harness root is denied', (t) => {
  const { home, fence } = fixture(t);
  const short = shortNameOf(home, '.claude');
  if (short === null) return t.skip('the temp volume does not generate 8.3 short names');
  assert.notEqual(short.toLowerCase(), '.claude');
  assert.equal(reason(fence.check(path.join(home, short, 'x'), 'write')), 'harness-root');
  assert.equal(reason(fence.check(path.join(home, short, 'settings.json'), 'rm')), 'harness-root');
});

test('a directory link to a harness root cannot be written through', (t) => {
  const probe = probeSymlink();
  if (!probe.ok) return t.skip(probe.why);
  const { home, orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'tmp'));
  fs.symlinkSync(path.join(home, '.claude'), path.join(orch, 'tmp', 'l'), 'dir');
  assert.equal(reason(fence.check(path.join(orch, 'tmp', 'l', 'x'), 'write')), 'harness-root');
});

test('safe rm: a junction to a fake harness root is removed as an entry and the root stays byte-identical', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, home, orch, fence } = fixture(t);
  const tmp = path.join(orch, 'tmp');
  fence.mkdirp(path.join(tmp, 'sub'));
  put(path.join(tmp, 'a.txt'));
  put(path.join(tmp, 'sub', 'b.txt'));
  put(path.join(base, 'outside', 'keep.txt'), 'keep');
  junction(base, path.join(tmp, 'to-claude'), path.join(home, '.claude'));
  junction(base, path.join(tmp, 'sub', 'to-dsh'), path.join(home, '.dsh'));
  junction(base, path.join(tmp, 'sub', 'to-outside'), path.join(base, 'outside'));
  const before = { claude: treeDigest(path.join(home, '.claude')), dsh: treeDigest(path.join(home, '.dsh')), out: treeDigest(path.join(base, 'outside')) };

  assert.deepEqual(fence.rm(tmp, { recursive: true }), { removed: 7 });

  assert.equal(fs.existsSync(tmp), false);
  assert.equal(treeDigest(path.join(home, '.claude')), before.claude);
  assert.equal(treeDigest(path.join(home, '.dsh')), before.dsh);
  assert.equal(treeDigest(path.join(base, 'outside')), before.out);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{"a":1}');
});

test('safe rm on the junction itself removes only the link', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, home, orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'tmp'));
  junction(base, path.join(orch, 'tmp', 'j'), path.join(home, '.claude'));
  const before = treeDigest(path.join(home, '.claude'));
  assert.equal(reason(fence.check(path.join(orch, 'tmp', 'j'), 'rm')), 'allow');
  assert.deepEqual(fence.rm(path.join(orch, 'tmp', 'j'), { recursive: true }), { removed: 1 });
  assert.equal(fs.existsSync(path.join(orch, 'tmp', 'j')), false);
  assert.equal(treeDigest(path.join(home, '.claude')), before);
});

test('safe rm: paths through a junction, harness roots and their ancestors are refused before anything is removed', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, home, orch, fence } = fixture(t, (h) => h);
  fence.mkdirp(path.join(home, 'tmp'));
  junction(base, path.join(home, 'tmp', 'j'), path.join(home, '.claude'));
  const before = treeDigest(home);
  assert.equal(reason(fence.check(path.join(home, 'tmp', 'j', 'settings.json'), 'rm')), 'harness-root');
  assert.equal(reason(fence.check(path.join(home, '.claude', 'settings.json'), 'rm')), 'harness-root');
  assert.equal(reason(fence.check(path.join(home, '.claude'), 'rm')), 'harness-root');
  assert.equal(reason(fence.check(orch, 'rm')), 'contains-harness-root');
  assert.throws(() => fence.rm(home, { recursive: true }), WriteFenceError);
  assert.throws(() => fence.rm(path.join(home, 'tmp', 'j', 'settings.json')), WriteFenceError);
  assert.equal(treeDigest(home), before);
});

test('rm of a missing path is a no-op; a denied missing path still throws', (t) => {
  const { home, orch, fence } = fixture(t);
  assert.deepEqual(fence.rm(path.join(orch, 'nope')), { removed: 0 });
  assert.throws(() => fence.rm(path.join(home, '.claude', 'nope')), WriteFenceError);
});

test('non-recursive rm refuses a non-empty directory and removes nothing', (t) => {
  const { orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'd'));
  put(path.join(orch, 'd', 'f.txt'));
  assert.throws(() => fence.rm(path.join(orch, 'd')), { code: 'ENOTEMPTY' });
  assert.equal(fs.existsSync(path.join(orch, 'd', 'f.txt')), true);
});

test('mkdirp never creates a directory outside ORCHESTRA_HOME', (t) => {
  const { base, fence } = fixture(t, (h) => path.join(h, '..', 'missing', 'orch'));
  assert.throws(() => fence.mkdirp(path.join(base, 'missing', 'orch', 'run')), (e: unknown) => {
    assert.ok(e instanceof WriteFenceError);
    assert.equal(e.decision.reason, 'outside-home');
    return true;
  });
  assert.equal(fs.existsSync(path.join(base, 'missing')), false);
});

test('writeAtomic cleans its temp file when the rename fails', (t) => {
  const { orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'dir-target'));
  assert.throws(() => fence.writeAtomic(path.join(orch, 'dir-target'), 'x'));
  assert.deepEqual(fs.readdirSync(orch), ['dir-target']);
  assert.throws(() => fence.writeAtomic(path.join(orch, 'no-such-dir', 'f'), 'x'), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(orch), ['dir-target']);
});

test('mkdtemp makes a fresh directory inside ORCHESTRA_HOME and nowhere else', (t) => {
  const { home, orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'tmp'));
  const made = fence.mkdtemp(path.join(orch, 'tmp'), 'snap-');
  assert.ok(fs.statSync(made).isDirectory());
  assert.match(path.basename(made), /^snap-.{6}$/);
  assert.throws(() => fence.mkdtemp(path.join(home, '.codex'), 'snap-'), WriteFenceError);
  assert.deepEqual(fs.readdirSync(path.join(home, '.codex')), ['state_5.sqlite']);
});

/** orch\swap is a plain directory at check time; the stage turns it into a junction into the fake .claude. */
function swapFixture(t: TestContext) {
  const f = fixture(t);
  const claude = path.join(f.home, '.claude');
  const swap = path.join(f.orch, 'swap');
  fs.mkdirSync(swap, { recursive: true });
  const swapToClaude = (target: string) => () => {
    fs.renameSync(swap, `${swap}-old`);
    junction(f.base, swap, target);
  };
  return { ...f, claude, swap, swapToClaude };
}

test('race: writeAtomic whose directory turns into a junction after check() writes nothing into the harness root', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, swap, swapToClaude, make } = swapFixture(t);
  const before = treeDigest(claude);
  const s = staged({ before: swapToClaude(path.join(claude, 'projects')) });
  assert.equal(reason(make(s.io).check(path.join(swap, 'state.json'), 'write')), 'allow');
  assert.throws(() => make(s.io).writeAtomic(path.join(swap, 'state.json'), 'payload'), changed('harness-root'));
  assert.ok(s.ran());
  assert.equal(treeDigest(claude), before, 'the temp file opened in the harness root was taken back');
  assert.deepEqual(fs.readdirSync(`${swap}-old`), []);
});

test('race: writeAtomic whose directory turns into a junction between the temp file\'s close and its rename never renames', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, orch, swap, swapToClaude, make } = swapFixture(t);
  // Control: unstaged, the same io sees one close and one rename onto the target.
  const plain = staged({});
  make(plain.io).writeAtomic(path.join(orch, 'plain.json'), 'x');
  assert.ok(plain.closed());
  assert.deepEqual(plain.renames.map(([, to]) => to), [path.join(orch, 'plain.json')]);
  put(path.join(claude, 'projects', 'state.json'), 'theirs');
  const before = treeDigest(claude);
  const s = staged({ afterClose: swapToClaude(path.join(claude, 'projects')) });
  assert.throws(() => make(s.io).writeAtomic(path.join(swap, 'state.json'), 'payload'), changed('harness-root'));
  assert.ok(s.closed(), 'the swap was staged after the close');
  assert.deepEqual(s.renames, [], 'the rename never ran');
  assert.equal(treeDigest(claude), before, 'the fake harness root is byte-identical');
  assert.equal(fs.readFileSync(path.join(claude, 'projects', 'state.json'), 'utf8'), 'theirs');
});

test('race: writeAtomic whose target turns into a junction into the harness root before the rename is refused and never renames', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, claude, swap, make } = swapFixture(t);
  const target = put(path.join(swap, 'state.json'), 'mine');
  const before = treeDigest(claude);
  // Only the target entry changes: the temp file beside it still checks out.
  const s = staged({
    afterClose: () => {
      fs.renameSync(target, `${target}.old`);
      junction(base, target, path.join(claude, 'projects'));
    },
  });
  assert.throws(() => make(s.io).writeAtomic(target, 'payload'), (e: unknown) => {
    assert.ok(e instanceof WriteFenceError, String(e));
    assert.equal(e.decision.reason, 'harness-root');
    return true;
  });
  assert.deepEqual(s.renames, [], 'the rename never ran');
  assert.equal(treeDigest(claude), before);
  assert.equal(fs.readFileSync(`${target}.old`, 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(swap).filter((n) => n.endsWith('.tmp')), [], 'the temp file was removed');
});

test('race: append through a swapped directory touches neither an existing nor a new harness file', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, swap, swapToClaude, make } = swapFixture(t);
  put(path.join(swap, 'log.jsonl'), 'mine\n');
  put(path.join(claude, 'projects', 'log.jsonl'), 'theirs\n');
  const before = treeDigest(claude);
  const s = staged({ before: swapToClaude(path.join(claude, 'projects')) });
  assert.throws(() => make(s.io).append(path.join(swap, 'log.jsonl'), 'x\n'), changed('harness-root'));
  assert.equal(fs.readFileSync(path.join(claude, 'projects', 'log.jsonl'), 'utf8'), 'theirs\n');
  assert.equal(treeDigest(claude), before);
  assert.equal(fs.readFileSync(path.join(`${swap}-old`, 'log.jsonl'), 'utf8'), 'mine\n');
});

test('race: append that would create a file through a swapped directory removes the file it created', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, swap, swapToClaude, make } = swapFixture(t);
  const before = treeDigest(claude);
  const s = staged({ before: swapToClaude(path.join(claude, 'projects')) });
  assert.throws(() => make(s.io).append(path.join(swap, 'new.jsonl'), 'x\n'), changed('harness-root'));
  assert.equal(fs.existsSync(path.join(claude, 'projects', 'new.jsonl')), false);
  assert.equal(treeDigest(claude), before);
});

test('race: mkdirp whose parent turns into a junction removes the directory it made in the harness root', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { claude, swap, swapToClaude, make } = swapFixture(t);
  const before = treeDigest(claude);
  const s = staged({ before: swapToClaude(claude) });
  assert.throws(() => make(s.io).mkdirp(path.join(swap, 'run')), changed('harness-root'));
  assert.ok(s.ran());
  assert.equal(fs.existsSync(path.join(claude, 'run')), false);
  assert.equal(treeDigest(claude), before);
});

/** Real fs, except that the first mkdir of `level` runs `stage` first (a racing process making it). */
function mkdirRace(level: string, stage: () => void): { io: WriteIo; ran(): boolean } {
  let ran = false;
  return {
    io: {
      ...realWriteIo,
      mkdirSync: (p) => {
        if (!ran && p === level) {
          ran = true;
          stage();
        }
        fs.mkdirSync(p);
      },
      closeSync: (fd) => fs.closeSync(fd),
      renameSync: (from, to) => fs.renameSync(from, to),
    },
    ran: () => ran,
  };
}

test('race: mkdirp whose level appears as a junction into the harness root just before its mkdir (EEXIST) is refused, not taken as made', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, home, orch, make } = fixture(t);
  fs.mkdirSync(orch);
  const claude = path.join(home, '.claude');
  const before = treeDigest(claude);
  const run = path.join(orch, 'run');
  const s = mkdirRace(run, () => junction(base, run, claude));
  assert.throws(() => make(s.io).mkdirp(run), changed('harness-root'));
  assert.ok(s.ran(), 'the junction was staged before the mkdir');
  assert.equal(treeDigest(claude), before);
  assert.ok(fs.lstatSync(run).isSymbolicLink(), 'a link this call did not make is not removed');
  // A link that stays inside ORCHESTRA_HOME is refused too: the level must be a plain directory.
  const tmp = path.join(orch, 'tmp');
  fs.mkdirSync(path.join(orch, 'elsewhere'));
  const s2 = mkdirRace(tmp, () => junction(base, tmp, path.join(orch, 'elsewhere')));
  assert.throws(() => make(s2.io).mkdirp(tmp), changed('link'));
  // Control: a plain directory made meanwhile is fine, and is not reported as made by this call.
  const runtime = path.join(orch, 'runtime');
  const s3 = mkdirRace(runtime, () => fs.mkdirSync(runtime));
  assert.deepEqual(make(s3.io).mkdirp(runtime), []);
  assert.ok(s3.ran());
});

/** Files under `dir` (links not followed) whose content is exactly `content`. */
function filesWith(dir: string, content: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) out.push(...filesWith(p, content));
    else if (st.isFile() && fs.readFileSync(p, 'utf8') === content) out.push(p);
  }
  return out;
}

test('race: writeAtomic whose directory, temp file included, is moved into the harness root and junctioned there between close and rename lands nothing in the root', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const { base, claude, swap, make } = swapFixture(t);
  const moved = path.join(claude, 'projects', 'moved');
  let moveRan = false;
  const s = staged({
    afterClose: () => {
      fs.renameSync(swap, moved);
      junction(base, swap, moved);
      moveRan = true;
    },
  });
  assert.throws(() => make(s.io).writeAtomic(path.join(swap, 'state.json'), 'payload'), changed('harness-root'));
  assert.ok(moveRan, 'the move and the junction were staged after the close');
  assert.deepEqual(s.renames, [], 'the rename never ran');
  assert.deepEqual(filesWith(claude, 'payload'), [], 'no payload file under the harness root');
  assert.equal(fs.existsSync(path.join(moved, 'state.json')), false);
});

test('race: a file replaced right after the open is refused by identity, and neither file is written', (t) => {
  const { orch, make } = fixture(t);
  const target = put(path.join(orch, 'run', 'log.jsonl'), 'a\n');
  const s = staged({
    after: () => {
      fs.renameSync(target, `${target}.moved`);
      fs.writeFileSync(target, 'fresh\n');
    },
  });
  assert.throws(() => make(s.io).append(target, 'b\n'), changed('identity'));
  assert.equal(fs.readFileSync(`${target}.moved`, 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'fresh\n');
});

test('race: a hard link made after check() is caught on the append handle itself', (t) => {
  const { orch, make } = fixture(t);
  const target = put(path.join(orch, 'run', 'log.jsonl'), 'a\n');
  let skip: string | null = null;
  const s = staged({ before: () => { skip = tryLink(target, path.join(orch, 'run', 'other.jsonl')); } });
  assert.equal(reason(make(s.io).check(target, 'append')), 'allow');
  let err: unknown = null;
  try {
    make(s.io).append(target, 'b\n');
  } catch (e) {
    err = e;
  }
  if (skip !== null) return t.skip(skip);
  assert.ok(err instanceof WriteFenceError, String(err));
  assert.deepEqual([err.decision.reason, (err.decision as { links?: number }).links], ['hardlink', 2]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'a\n');
});

test('append creates a missing file exclusively and appends to an existing one without recreating it', (t) => {
  const { orch, fence } = fixture(t);
  fence.mkdirp(path.join(orch, 'run'));
  const file = path.join(orch, 'run', 'j.jsonl');
  fence.append(file, '1\n');
  const ino = fs.statSync(file, { bigint: true }).ino;
  fence.append(file, '2\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '1\n2\n');
  assert.equal(fs.statSync(file, { bigint: true }).ino, ino);
});

test('a bad ORCHESTRA_HOME or harness root fails construction', () => {
  assert.throws(() => fenceOf({ orchestraHome: 'relative', harnessRoots: [] }), /ORCHESTRA_HOME rejected \(not-absolute\)/);
  assert.throws(() => fenceOf({ orchestraHome: 'C:\\o', harnessRoots: ['\\\\srv\\share'] }), /harness root rejected \(unc\)/);
});

test('confine (test profile): the fence is not built when ORCHESTRA_HOME leads out of the test dir', (t) => {
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const sibling = path.join(base, 'sibling');
  put(path.join(sibling, 'keep.txt'), 'keep');
  const before = treeDigest(sibling);
  const home = path.join(testDir, 'orchestra');
  const ok = fenceOf({ orchestraHome: home, harnessRoots: [], confine: testDir });
  ok.mkdirp(path.join(home, 'run'));
  assert.ok(fs.statSync(path.join(home, 'run')).isDirectory());
  assert.throws(() => fenceOf({ orchestraHome: testDir, harnessRoots: [], confine: testDir }), /leaves the test dir/, 'home = the test dir itself');
  assert.throws(() => fenceOf({ orchestraHome: path.join(base, 'orchestra'), harnessRoots: [], confine: testDir }), /leaves the test dir/);
  const linkedHome = path.join(testDir, 'linked');
  junction(base, linkedHome, sibling);
  assert.throws(() => fenceOf({ orchestraHome: linkedHome, harnessRoots: [], confine: testDir }), /leaves the test dir/);
  const linkedDir = path.join(base, 'dir-link');
  junction(base, linkedDir, testDir);
  assert.throws(() => fenceOf({ orchestraHome: path.join(linkedDir, 'orchestra'), harnessRoots: [], confine: linkedDir }), /leaves the test dir/, 'the test dir must be canonical');
  assert.equal(treeDigest(sibling), before);
});

test('makeWriteFence: node-io.ts\'s own io does each act, appends without truncating, and removes a junction as an entry', async (t) => {
  const probe = probeJunction();
  const base = fs.realpathSync.native(withTmp(t));
  const home = path.join(base, 'orchestra');
  const outside = path.join(base, 'outside');
  put(path.join(outside, 'keep.txt'), 'keep');
  const before = treeDigest(outside);
  const fence = await makeWriteFence({ orchestraHome: home, harnessRoots: [outside], confine: base });
  assert.deepEqual(fence.mkdirp(path.join(home, 'run')), [home, path.join(home, 'run')]);
  const log = path.join(home, 'run', 'a.log');
  fence.append(log, 'one\n');
  fence.append(log, 'two\n', { fsync: true });
  assert.equal(fs.readFileSync(log, 'utf8'), 'one\ntwo\n', 'the second append opened the existing file for appending');
  fence.writeAtomic(path.join(home, 'run', 'd.json'), '{"v":1}');
  fence.writeAtomic(path.join(home, 'run', 'd.json'), '{"v":2}');
  assert.equal(fs.readFileSync(path.join(home, 'run', 'd.json'), 'utf8'), '{"v":2}');
  const made = fence.mkdtemp(home, 'x-');
  assert.ok(fs.statSync(made).isDirectory());
  put(path.join(home, 'tmp', 'deep', 'f.bin'), 'f');
  if (probe.ok) junction(base, path.join(home, 'tmp', 'to-outside'), outside);
  assert.equal(fence.rm(path.join(home, 'tmp'), { recursive: true }).removed, probe.ok ? 4 : 3);
  assert.equal(fs.existsSync(path.join(home, 'tmp')), false);
  assert.throws(() => fence.writeAtomic(path.join(outside, 'keep.txt'), 'x'), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'harness-root');
  assert.deepEqual(fs.readdirSync(path.join(home, 'run')).sort(), ['a.log', 'd.json']);
  assert.equal(treeDigest(outside), before, 'the junction target is untouched');
});
