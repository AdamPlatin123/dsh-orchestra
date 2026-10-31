import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEnv } from '../../src/runtime/env.ts';
import { computeHarnessRoots, defaultVersionFiles, expandGlob, globListRoot, launcherRootFs, rootDenyList } from '../../src/fs/harness-roots.ts';
import type { RootFs } from '../../src/fs/harness-roots.ts';
import { ReadGateError } from '../../src/fs/read-gate.ts';
import { junction, probeJunction, put, withTmp } from '../helpers/tmp.ts';

function refusal(reason: string): (e: unknown) => boolean {
  return (e) => {
    assert.ok(e instanceof ReadGateError, String(e));
    assert.equal(e.decision.reason, reason);
    return true;
  };
}

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

/** A fake directory tree on drive X:, keyed by lower-case path. */
function fakeFs(dirs: Record<string, string[]>, existing: string[], realOf: Record<string, string> = {}): RootFs {
  const exists = new Set(existing.map((p) => p.toLowerCase()));
  return {
    realpath: (p) => {
      const key = p.toLowerCase();
      if (realOf[key] !== undefined) return realOf[key]!;
      if (!exists.has(key)) throw missing();
      return p;
    },
    listDirs: (d) => dirs[d.toLowerCase()] ?? [],
  };
}

test('expandGlob: `*` matches whole or partial segments, only existing matches, sorted by full path', () => {
  const rfs = fakeFs(
    { 'x:\\h\\.rec\\claude\\accounts': ['2', '10', '1'], 'x:\\h\\.rec\\claude': ['accounts', 'acc-old', 'other'] },
    ['X:\\h\\.rec\\claude\\accounts\\1\\config', 'X:\\h\\.rec\\claude\\accounts\\10\\config', 'X:\\h\\.rec\\claude\\acc-old\\9\\config'],
  );
  assert.deepEqual(expandGlob('X:\\h\\.rec\\claude\\accounts\\*\\config', rfs), [
    'X:\\h\\.rec\\claude\\accounts\\10\\config',
    'X:\\h\\.rec\\claude\\accounts\\1\\config',
  ]);
  const rfs2 = fakeFs({ 'x:\\h\\.rec\\claude': ['accounts', 'acc-old', 'other'], 'x:\\h\\.rec\\claude\\acc-old': ['9'] }, ['X:\\h\\.rec\\claude\\acc-old\\9\\config']);
  assert.deepEqual(expandGlob('X:\\h\\.rec\\claude\\acc*\\*\\config', rfs2), ['X:\\h\\.rec\\claude\\acc-old\\9\\config']);
});

test('computeHarnessRoots: typed roots plus expanded launcher roots, each with its canonical form', () => {
  const env = resolveEnv({ home: 'X:\\h', env: {} });
  const rfs = fakeFs(
    { 'x:\\h\\.rec\\claude\\accounts': ['7'] },
    ['X:\\h\\.claude', 'X:\\h\\.rec\\claude\\accounts', 'X:\\h\\.rec\\claude\\accounts\\7\\config'],
    { 'x:\\h\\.rec\\claude\\accounts\\7\\config': 'Y:\\moved\\config' },
  );
  const roots = computeHarnessRoots(env, rfs);
  const launcher = roots.find((r) => r.path === 'X:\\h\\.rec\\claude\\accounts\\7\\config');
  assert.deepEqual(launcher, { kind: 'claude', path: 'X:\\h\\.rec\\claude\\accounts\\7\\config', real: 'Y:\\moved\\config' });
  assert.deepEqual(roots.find((r) => r.kind === 'claude-prefix'), { kind: 'claude-prefix', path: 'X:\\h\\.rec\\claude\\accounts', real: 'X:\\h\\.rec\\claude\\accounts' });
  assert.deepEqual(roots.find((r) => r.path === 'X:\\h\\.dsh'), { kind: 'dsh', path: 'X:\\h\\.dsh', real: 'X:\\h\\.dsh' });
  const deny = rootDenyList(roots).map((p) => p.toLowerCase());
  assert.ok(deny.includes('y:\\moved\\config') && deny.includes('x:\\h\\.rec\\claude\\accounts\\7\\config'));
  assert.equal(new Set(deny).size, deny.length);
});

test('computeHarnessRoots fails closed: an unreadable directory is an error, not a shorter deny list', () => {
  const env = resolveEnv({ home: 'X:\\h', env: {} });
  const rfs: RootFs = {
    realpath: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
    listDirs: () => [],
  };
  assert.throws(() => computeHarnessRoots(env, rfs), { code: 'EACCES' });
});

test('computeHarnessRoots on disk resolves a junctioned launcher root', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const base = withTmp(t);
  const home = path.join(base, 'home');
  put(path.join(base, 'elsewhere', 'sessions', '1.json'), '{}');
  fs.mkdirSync(path.join(home, '.rec', 'claude', 'accounts', '3'), { recursive: true });
  junction(base, path.join(home, '.rec', 'claude', 'accounts', '3', 'config'), path.join(base, 'elsewhere'));
  const env = resolveEnv({ home, env: {} });
  const roots = computeHarnessRoots(env, launcherRootFs(env));
  const r = roots.find((x) => x.path.toLowerCase().endsWith('\\accounts\\3\\config'));
  assert.equal(r?.kind, 'claude');
  assert.equal(r?.real.toLowerCase(), fs.realpathSync.native(path.join(base, 'elsewhere')).toLowerCase());
});

test('globListRoot: the directory before the first segment with a `*`', () => {
  assert.equal(globListRoot('X:\\h\\.rec\\claude\\accounts\\*\\config'), 'X:\\h\\.rec\\claude\\accounts');
  assert.equal(globListRoot('X:\\h\\.rec\\claude\\acc*\\*\\config'), 'X:\\h\\.rec\\claude');
  assert.equal(globListRoot('X:\\*\\config'), 'X:\\');
});

test('there is no default listing: expandGlob and computeHarnessRoots need an explicit RootFs', () => {
  const env = resolveEnv({ home: 'X:\\h', env: {} });
  const call = computeHarnessRoots as unknown as (e: typeof env) => unknown;
  assert.throws(() => call(env), TypeError);
  const glob = expandGlob as unknown as (p: string) => unknown;
  assert.throws(() => glob('X:\\h\\.rec\\claude\\accounts\\*\\config'), TypeError);
});

test('launcherRootFs lists through the read gate: glob roots only, links listed, missing is empty, test mode honoured', (t) => {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  const accounts = path.join(home, '.rec', 'claude', 'accounts');
  fs.mkdirSync(path.join(accounts, '1', 'config'), { recursive: true });
  fs.mkdirSync(path.join(accounts, '2'), { recursive: true });
  put(path.join(accounts, 'notes.txt'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const env = resolveEnv({ home, env: {} });
  const rfs = launcherRootFs(env);
  const linked = probeJunction().ok;
  if (linked) junction(base, path.join(accounts, '3'), path.join(accounts, '2'));
  assert.deepEqual(rfs.listDirs(accounts), linked ? ['1', '2', '3'] : ['1', '2']);
  assert.deepEqual(rfs.listDirs(path.join(accounts, 'missing')), []);
  assert.throws(() => rfs.listDirs(path.join(home, '.claude')), refusal('outside-roots'));
  assert.throws(() => rfs.listDirs(home), refusal('outside-roots'));
  assert.deepEqual(computeHarnessRoots(env, rfs).filter((r) => r.kind === 'claude' && r.path.startsWith(accounts)).map((r) => r.path),
    [path.join(accounts, '1', 'config')]);

  const testRfs = launcherRootFs(env, { testDirs: [withTmp(t)] });
  assert.throws(() => testRfs.listDirs(accounts), refusal('test-mode-outside'));

  const partial = resolveEnv({ home, env: {}, launcherGlobs: ['~/.rec/claude/acc*/*/config'] });
  assert.ok(computeHarnessRoots(partial, launcherRootFs(partial)).some((r) => r.path === path.join(accounts, '1', 'config')));
});

test('defaultVersionFiles: the two global package.json files under APPDATA, or a typed reason why not', () => {
  assert.deepEqual(defaultVersionFiles({ APPDATA: 'X:\\Users\\u\\AppData\\Roaming' }), {
    ok: true,
    files: [
      'X:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\package.json',
      'X:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\package.json',
    ],
  });
  assert.deepEqual(defaultVersionFiles({}), { ok: false, reason: 'appdata-unset' });
  assert.deepEqual(defaultVersionFiles({ APPDATA: '  ' }), { ok: false, reason: 'appdata-unset' });
  assert.deepEqual(defaultVersionFiles({ APPDATA: '\\\\server\\share' }), { ok: false, reason: 'appdata-rejected', detail: 'unc' });
  assert.deepEqual(defaultVersionFiles({ APPDATA: 'relative\\dir' }), { ok: false, reason: 'appdata-rejected', detail: 'not-absolute' });
});
