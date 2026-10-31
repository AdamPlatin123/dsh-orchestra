import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { computeHarnessRoots, launcherRootFs } from '../../src/fs/harness-roots.ts';
import { WriteFence, WriteFenceError } from '../../src/fs/write-fence.ts';
import { resolveEnv } from '../../src/runtime/env.ts';
import { canonicalize } from '../../src/fs/paths.ts';
import { checkDataDir, checkNewRoot, prepareDataDir } from '../../src/runtime/data-dir.ts';
import { junction, put, shortNameOf, treeDigest, withTmp } from '../helpers/tmp.ts';

// Every home, root and link lives in a fresh temp dir; nothing here looks at the real home.

function fakeHome(base: string): string {
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.rec', 'claude', 'accounts', '1', 'config'), { recursive: true });
  return fs.realpathSync.native(home);
}

function rootsOf(home: string, env: Record<string, string> = {}): { roots: HarnessRoot[]; orchestraHome: string } {
  const r = resolveEnv({ home, env });
  return { roots: computeHarnessRoots(r, launcherRootFs(r)), orchestraHome: r.orchestraHome };
}

const check = (orchestraHome: string, userHome: string, roots: HarnessRoot[]) => checkDataDir({ orchestraHome, userHome, roots });

test('the default ~/.orchestra next to the harness roots passes', (t) => {
  const home = fakeHome(withTmp(t));
  const { roots, orchestraHome } = rootsOf(home);
  const c = check(orchestraHome, home, roots);
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.home, path.join(home, '.orchestra'));
});

test('ORCHESTRA_HOME = the fake home is refused (it is the user home and contains every root)', (t) => {
  const home = fakeHome(withTmp(t));
  const { roots } = rootsOf(home);
  const c = check(home, home, roots);
  assert.deepEqual(c, { ok: false, reason: 'contains-user-home', home, userHome: home });
});

test('ORCHESTRA_HOME = <fake home>\\.rec, which holds the launcher root accounts\\1\\config, is refused', (t) => {
  const home = fakeHome(withTmp(t));
  const { roots } = rootsOf(home);
  assert.ok(roots.some((r) => r.path.toLowerCase().endsWith('\\.rec\\claude\\accounts\\1\\config')), 'the glob expanded in the fake home');
  const c = check(path.join(home, '.rec'), home, roots);
  assert.equal(c.ok, false);
  assert.equal(!c.ok && c.reason, 'contains-harness-root');
});

test('ORCHESTRA_HOME inside a harness root is refused, also when only its canonical form is', (t) => {
  const base = withTmp(t);
  const home = fakeHome(base);
  const { roots } = rootsOf(home);
  const inside = check(path.join(home, '.claude', 'orchestra'), home, roots);
  assert.equal(!inside.ok && inside.reason, 'inside-harness-root');
  const link = path.join(base, 'elsewhere', 'orch');
  junction(base, link, path.join(home, '.claude', 'projects'));
  const viaLink = check(link, home, roots);
  assert.equal(!viaLink.ok && viaLink.reason, 'inside-harness-root');
});

test('ORCHESTRA_HOME given by its 8.3 short name is still recognized as the user home', (t) => {
  const base = withTmp(t);
  const home = fakeHome(base);
  const longParent = path.join(base, 'a-long-directory-name');
  fs.mkdirSync(longParent);
  const short = shortNameOf(base, 'a-long-directory-name');
  if (short === null) {
    t.skip('the temp volume generates no 8.3 short names');
    return;
  }
  const c = checkDataDir({ orchestraHome: path.join(base, short), userHome: longParent, roots: rootsOf(home).roots });
  assert.equal(!c.ok && c.reason, 'contains-user-home');
});

test('ORCHESTRA_HOME as a drive root is refused', (t) => {
  const home = fakeHome(withTmp(t));
  const drive = path.parse(home).root;
  assert.deepEqual(check(drive, home, []), { ok: false, reason: 'drive-root', home: drive });
});

test('a bad ORCHESTRA_HOME path is refused with the path checker\'s reason', (t) => {
  const home = fakeHome(withTmp(t));
  assert.deepEqual(check('relative\\orchestra', home, []), { ok: false, reason: 'bad-path', what: 'orchestra-home', path: 'relative\\orchestra', detail: 'not-absolute' });
  assert.equal((check(`${home}\\x:ads`, home, []) as { detail?: string }).detail, 'ads');
});

test('Tuning: a root added inside ORCHESTRA_HOME, or one that contains it, is refused outright', (t) => {
  const home = fakeHome(withTmp(t));
  const { roots, orchestraHome } = rootsOf(home);
  const ok = check(orchestraHome, home, roots);
  assert.ok(ok.ok);
  assert.deepEqual(checkNewRoot(ok, path.join(orchestraHome, 'bot')), { ok: false, reason: 'root-inside-home', root: path.join(orchestraHome, 'bot'), home: orchestraHome });
  assert.deepEqual(checkNewRoot(ok, home), { ok: false, reason: 'home-inside-root', root: home, home: orchestraHome });
  assert.deepEqual(checkNewRoot(ok, path.join(home, 'bot-data')), { ok: true, root: path.join(home, 'bot-data') });
  assert.equal((checkNewRoot(ok, 'G:bot') as { reason: string }).reason, 'bad-path');
});

test('prepareDataDir creates run, tmp and runtime and empties tmp without entering a link', (t) => {
  const base = withTmp(t);
  const home = fakeHome(base);
  const { roots } = rootsOf(home);
  const orch = path.join(home, '.orchestra');
  put(path.join(orch, 'tmp', 'stale', 'part.bin'), 'old');
  put(path.join(home, '.claude', 'projects', 'p', 'keep.jsonl'), '{}\n');
  junction(base, path.join(orch, 'tmp', 'to-claude'), path.join(home, '.claude'));
  const before = treeDigest(path.join(home, '.claude'));
  const fence = new WriteFence({ orchestraHome: orch, harnessRoots: roots.flatMap((r) => [r.path, r.real]) });
  const p = prepareDataDir(fence, orch);
  for (const d of [p.run, p.tmp, p.runtime]) assert.ok(fs.statSync(d).isDirectory());
  assert.deepEqual(fs.readdirSync(p.tmp), []);
  assert.equal(p.tmpEntriesRemoved, 3);
  assert.equal(treeDigest(path.join(home, '.claude')), before, 'the harness root behind the junction is untouched');
  const again = prepareDataDir(fence, orch);
  assert.deepEqual(again.created, []);
  assert.equal(again.tmpEntriesRemoved, 0);
});

test('prepareDataDir refuses a run\\ that is a junction into a harness root', (t) => {
  const base = withTmp(t);
  const home = fakeHome(base);
  const { roots } = rootsOf(home);
  const orch = path.join(home, '.orchestra');
  fs.mkdirSync(orch);
  junction(base, path.join(orch, 'run'), path.join(home, '.claude', 'projects'));
  const before = treeDigest(path.join(home, '.claude'));
  const fence = new WriteFence({ orchestraHome: orch, harnessRoots: roots.flatMap((r) => [r.path, r.real]) });
  assert.throws(() => prepareDataDir(fence, orch), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'harness-root');
  assert.equal(treeDigest(path.join(home, '.claude')), before);
});

test('test profile: ORCHESTRA_HOME, a root or the test dir itself that leads out of the test dir is refused', (t) => {
  const base = withTmp(t);
  fs.mkdirSync(path.join(base, 'orchestra-test-x'));
  const testDir = fs.realpathSync.native(path.join(base, 'orchestra-test-x'));
  const sibling = path.join(base, 'sibling');
  fs.mkdirSync(sibling);
  const siblingReal = fs.realpathSync.native(sibling);
  const userHome = path.join(base, 'home');
  const rootsIn = (dir: string): HarnessRoot[] => (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    return { kind, path: p, real: canonicalize(p) };
  });
  const home = path.join(testDir, 'orchestra');
  const ok = checkDataDir({ orchestraHome: home, userHome, roots: rootsIn(testDir), testDir });
  assert.deepEqual(ok, { ok: true, home, homeReal: home });

  junction(base, home, sibling);
  assert.deepEqual(checkDataDir({ orchestraHome: home, userHome, roots: rootsIn(testDir), testDir }), {
    ok: false, reason: 'test-dir-escape', what: 'orchestra-home', path: home, real: siblingReal, testDir,
  });
  fs.rmdirSync(home);

  junction(base, path.join(testDir, 'roots'), sibling);
  const viaRoots = checkDataDir({ orchestraHome: home, userHome, roots: rootsIn(testDir), testDir });
  assert.equal(!viaRoots.ok && viaRoots.reason, 'test-dir-escape');
  assert.equal(!viaRoots.ok && viaRoots.reason === 'test-dir-escape' && viaRoots.what, 'harness-root');
  fs.rmdirSync(path.join(testDir, 'roots'));

  const outside = checkDataDir({ orchestraHome: path.join(base, 'orchestra'), userHome, roots: rootsIn(testDir), testDir });
  assert.equal(!outside.ok && outside.reason === 'test-dir-escape' && outside.what, 'orchestra-home');
  const itself = checkDataDir({ orchestraHome: testDir, userHome, roots: [], testDir });
  assert.equal(!itself.ok && itself.reason === 'test-dir-escape' && itself.what, 'orchestra-home');

  const dirLink = path.join(base, 'dir-link');
  junction(base, dirLink, testDir);
  const viaLink = checkDataDir({ orchestraHome: path.join(dirLink, 'orchestra'), userHome, roots: rootsIn(dirLink), testDir: dirLink });
  assert.equal(!viaLink.ok && viaLink.reason === 'test-dir-escape' && viaLink.what, 'test-dir');
  assert.deepEqual(fs.readdirSync(sibling), [], 'only checked, never written');
});
