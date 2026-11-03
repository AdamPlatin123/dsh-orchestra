import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CwdPolicy, MAIN_CHECKOUT, REPO_ROOT } from '../../src/os/cwd.ts';
import { checkProjectRoots, placeRunIn } from '../../src/os/project-roots.ts';
import type { ProjectRootsDeps } from '../../src/os/project-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { realIo } from '../helpers/read-io.ts';
import { withTmp } from '../helpers/tmp.ts';

// Project roots (orchestra app plan 项目根, --project-root): each root is held at startup to what a cwd must
// be, through the spawn gate's own cwd table (src/os/cwd.ts), the realpath port and a stat-only read gate;
// an agent request's cwd runs in a root only from inside it, with no `..` and no link escape.

const realpath = (p: string) => fs.realpathSync.native(p);
const SYS = process.env.SystemRoot ?? 'C:\\Windows';

/** A fixture: <base>\orchestra-test-x as the test dir, its data dir and a harness root, a fake profile, and <base> as %LOCALAPPDATA%. */
function fixture(t: Parameters<typeof withTmp>[0]) {
  const base = fs.realpathSync.native(withTmp(t));
  const testDir = path.join(base, 'orchestra-test-x');
  const home = path.join(testDir, 'orchestra');
  const harness = path.join(testDir, 'roots', 'claude');
  const profile = path.join(base, 'profile');
  const proj = path.join(testDir, 'proj');
  for (const d of [home, harness, profile, path.join(proj, 'sub')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'file.txt'), 'x');
  // %LOCALAPPDATA% is <base>: the whole fixture lies in an AppData row, as %TEMP% does on a real machine.
  const env = { LOCALAPPDATA: base };
  const policy = (extra: { testDir?: string; projectRoots?: string[] } = {}) => new CwdPolicy({
    spec: { allowedRoots: [], protectedDirs: [home, harness], userHome: profile, ...extra }, env, systemRoot: SYS, realpath,
  });
  const gate = (roots: string[]) => new ReadGate({ roots: [], projectRoots: roots, io: realIo });
  const deps = (p: CwdPolicy): ProjectRootsDeps => ({ realpath, rootHit: (x) => p.rootHit(x), isDirectory: (x) => gate([x]).stat(x).isDirectory() });
  return { base, testDir, home, harness, profile, proj, policy, gate, deps };
}

test('checkProjectRoots: a directory strictly inside the test dir passes in the test profile, the AppData row aside; each root once', (t) => {
  const f = fixture(t);
  const v = checkProjectRoots([f.proj, path.join(f.proj, 'sub')], f.deps(f.policy({ testDir: f.testDir })));
  assert.deepEqual(v, { ok: true, roots: [f.proj, path.join(f.proj, 'sub')] });
});

test('checkProjectRoots: each kind of unfit root refuses with the root and why, and nothing after it is looked at', (t) => {
  const f = fixture(t);
  const test = f.deps(f.policy({ testDir: f.testDir }));
  const real = f.deps(f.policy());
  const no = (roots: string[], deps: ProjectRootsDeps) => {
    const v = checkProjectRoots(roots, deps);
    assert.equal(v.ok, false, JSON.stringify(v));
    return v as Extract<typeof v, { ok: false }>;
  };
  assert.equal(no(['relative\\dir'], test).why, 'bad-path');
  assert.equal(no(['C:\\'], test).why, 'drive-root');
  assert.equal(no(['\\\\server\\share\\x'], test).why, 'bad-path');
  // The test profile takes roots only in its test dir; the test dir itself holds the data dir.
  assert.equal(no([f.profile], test).why, 'outside-test-dir');
  assert.equal(no([f.testDir], test).why, 'outside-test-dir');
  // The data dir, a harness root, and what holds one.
  assert.deepEqual([no([f.home], test).why, no([f.home], test).detail], ['protected', 'protected']);
  assert.equal(no([path.join(f.testDir, 'roots')], test).why, 'protected');
  assert.equal(no([path.join(f.home, 'work')], test).why, 'protected');
  assert.equal(no([path.join(f.testDir, 'missing')], test).why, 'not-found');
  assert.equal(no([path.join(f.proj, 'file.txt')], test).why, 'not-a-directory');
  // The same dir under a second spelling.
  const dup = no([f.proj, f.proj.toUpperCase()], test);
  assert.deepEqual([dup.why, dup.root], ['duplicate', f.proj.toUpperCase()]);
  // The first unfit root is the one named.
  assert.equal(no([f.proj, 'nope'], test).root, 'nope');
  // The real profile: no exemption, so a root in AppData (%TEMP% included) is refused; the profile itself, its parents, the system dir, the repository.
  assert.deepEqual([no([f.proj], real).why, no([f.proj], real).detail], ['protected', 'user-profile\\AppData']);
  assert.equal(no([f.profile], real).detail, 'user-profile');
  assert.equal(no([path.dirname(f.profile)], real).why, 'protected', 'a parent of the profile');
  assert.equal(no([SYS], real).detail, 'system-root');
  assert.equal(no([path.join(SYS, 'System32')], real).detail, 'system-root');
  assert.equal(no([REPO_ROOT], real).detail, 'repo');
  assert.equal(no([path.join(REPO_ROOT, 'src')], real).detail, 'repo');
  assert.equal(no([path.dirname(MAIN_CHECKOUT ?? REPO_ROOT)], real).detail, 'repo', 'a parent of the repository');
});

test('checkProjectRoots: a junction is refused, as a root and as a part of one (reparsed), even when it points at a fit directory', (t) => {
  const f = fixture(t);
  const link = path.join(f.testDir, 'link');
  fs.symlinkSync(f.proj, link, 'junction');
  const v = checkProjectRoots([link], f.deps(f.policy({ testDir: f.testDir })));
  assert.equal(v.ok, false);
  if (!v.ok) assert.deepEqual([v.why, v.detail], ['reparsed', f.proj]);
  const below = checkProjectRoots([path.join(link, 'sub')], f.deps(f.policy({ testDir: f.testDir })));
  assert.equal(below.ok ? 'ok' : below.why, 'reparsed');
});

test('CwdPolicy with project roots: a cwd in one passes the gate; the AppData exemption holds only inside them and only in the test profile', (t) => {
  const f = fixture(t);
  const p = f.policy({ testDir: f.testDir, projectRoots: [f.proj] });
  assert.deepEqual(p.projectRoots(), [f.proj]);
  assert.deepEqual(p.check(f.proj), { ok: true, path: f.proj });
  assert.deepEqual(p.check(path.join(f.proj, 'sub')), { ok: true, path: path.join(f.proj, 'sub') });
  // Elsewhere in the test dir the AppData row still applies.
  const other = path.join(f.testDir, 'other');
  fs.mkdirSync(other);
  assert.equal(p.check(other).ok, false);
  assert.equal(p.place(path.join(f.proj, 'a.txt')).hit, null, 'an approval naming a file in the root hits nothing');
  assert.equal(p.place(path.join(other, 'a.txt')).hit, 'user-profile\\AppData');
  // A root the table refuses, or one behind a link, makes no policy at all.
  assert.throws(() => f.policy({ projectRoots: [f.proj] }), /refused \(user-profile\\AppData\)/);
  assert.throws(() => f.policy({ testDir: f.testDir, projectRoots: [f.home] }), /refused \(protected\)/);
  const link = path.join(f.testDir, 'link');
  fs.symlinkSync(f.proj, link, 'junction');
  assert.throws(() => f.policy({ testDir: f.testDir, projectRoots: [link] }), /behind a link/);
});

test('CwdPolicy without project roots: the same verdicts as before (no exemption, no extra allowed root)', (t) => {
  const f = fixture(t);
  const before = f.policy();
  const withTest = f.policy({ testDir: f.testDir });
  for (const p of [f.proj, path.join(f.proj, 'sub'), f.home, f.profile]) {
    assert.deepEqual(withTest.check(p), before.check(p), p);
    assert.equal(withTest.check(p).ok, false, p);
  }
  assert.deepEqual(before.projectRoots(), []);
});

test('placeRunIn: inside a root (the root, a folder below) it runs there; outside, with .., behind a junction, not a dir, or with no roots it says why', (t) => {
  const f = fixture(t);
  const p = f.policy({ testDir: f.testDir, projectRoots: [f.proj] });
  const outside = path.join(f.testDir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.proj, 'escape'), 'junction');
  const g = f.gate([f.proj]);
  const deps = { roots: [f.proj], check: (x: string) => p.check(x), isDirectory: (x: string) => g.stat(x).isDirectory() };
  assert.deepEqual(placeRunIn(f.proj, deps), { runIn: f.proj, why: null });
  assert.deepEqual(placeRunIn(path.join(f.proj, 'sub'), deps), { runIn: path.join(f.proj, 'sub'), why: null });
  // Case and a trailing separator do not matter; the canonical form is what runs.
  assert.deepEqual(placeRunIn(`${path.join(f.proj, 'SUB')}\\`, deps), { runIn: path.join(f.proj, 'SUB'), why: null });
  assert.deepEqual(placeRunIn(outside, deps), { runIn: null, why: 'outside-roots' });
  assert.deepEqual(placeRunIn(`${f.proj}\\..\\outside`, deps), { runIn: null, why: 'dot-segments' });
  assert.deepEqual(placeRunIn(`${f.proj}\\sub\\..`, deps), { runIn: null, why: 'dot-segments' }, 'a .. never counts, even one that stays inside');
  assert.deepEqual(placeRunIn(`${f.proj}/../outside`, deps), { runIn: null, why: 'dot-segments' });
  assert.deepEqual(placeRunIn(path.join(f.proj, 'escape'), deps), { runIn: null, why: 'reparsed' }, 'a junction out of the root');
  assert.deepEqual(placeRunIn(path.join(f.proj, 'file.txt'), deps), { runIn: null, why: 'not-a-directory' });
  assert.deepEqual(placeRunIn(path.join(f.proj, 'missing'), deps), { runIn: null, why: 'not-found' });
  assert.deepEqual(placeRunIn('relative', deps), { runIn: null, why: 'bad-path' });
  assert.deepEqual(placeRunIn(f.proj, { ...deps, roots: [] }), { runIn: null, why: 'no-roots' });
});

test('the project-root read gate stats a path in a root and nothing else: no read, no listing, nothing outside', (t) => {
  const f = fixture(t);
  const g = f.gate([f.proj]);
  assert.equal(g.stat(f.proj).isDirectory(), true);
  assert.equal(g.stat(path.join(f.proj, 'file.txt')).isDirectory(), false);
  assert.equal(g.decide(path.join(f.proj, 'file.txt'), 'read').allow, false);
  assert.equal(g.decide(f.proj, 'readdir').allow, false);
  assert.equal(g.decide(f.home, 'stat').allow, false);
});

// --- project-root review ------------------------------------------------------------------------------

test('a sibling whose name toLowerCase folds onto the root\'s (KELVIN SIGN U+212A for K) is another directory on NTFS: the gate and placeRunIn keep it out', (t) => {
  const f = fixture(t);
  const kit = path.join(f.testDir, 'kit');
  const kelvin = path.join(f.testDir, '\u212Ait');
  fs.mkdirSync(kit);
  fs.mkdirSync(path.join(kelvin, 'x'), { recursive: true });
  assert.notEqual(fs.realpathSync.native(path.join(kelvin, 'x')), path.join(kit, 'x'), 'NTFS keeps two directories');
  // The test profile: the AppData exemption is an allow, so it holds only strictly inside the root; the sibling hits the row.
  const p = f.policy({ testDir: f.testDir, projectRoots: [kit] });
  const v = p.check(path.join(kelvin, 'x'));
  assert.deepEqual(v.ok ? 'ok' : [v.reason, v.detail], ['protected', 'user-profile\\AppData']);
  assert.deepEqual(p.check(kit), { ok: true, path: kit }, 'the root itself still passes');
  assert.equal(p.place(path.join(kelvin, 'x', 'a.txt')).hit, 'user-profile\\AppData', 'an approval naming a file in the sibling is not in the root');
  const g = f.gate([kit]);
  const deps = { roots: [kit], check: (x: string) => p.check(x), isDirectory: (x: string) => g.stat(x).isDirectory() };
  assert.deepEqual(placeRunIn(path.join(kelvin, 'x'), deps), { runIn: null, why: 'protected' });
  // With no AppData row in the way (as a real-profile root outside AppData): the realpaths compare strictly, outside-allowed.
  const plain = new CwdPolicy({ spec: { allowedRoots: [], protectedDirs: [f.home, f.harness], userHome: f.profile, projectRoots: [kit] }, env: {}, systemRoot: SYS, realpath });
  const w = plain.check(path.join(kelvin, 'x'));
  assert.deepEqual(w.ok ? 'ok' : w.reason, 'outside-allowed');
  assert.deepEqual(plain.check(path.join(kit)), { ok: true, path: kit });
  assert.deepEqual(placeRunIn(path.join(kelvin, 'x'), { ...deps, check: (x: string) => plain.check(x) }), { runIn: null, why: 'outside-roots' });
  // An ASCII case difference still passes (NTFS folds ASCII as toLowerCase does).
  fs.mkdirSync(path.join(kit, 'Web'));
  assert.deepEqual(plain.check(path.join(kit, 'WEB')), { ok: true, path: path.join(kit, 'WEB') });
});

test('placeRunIn: a directory the read gate will not stat (a name rule such as *credentials*) is stat-refused, never not-found (T1)', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.proj, 'credentials-svc'));
  const p = f.policy({ testDir: f.testDir, projectRoots: [f.proj] });
  const g = f.gate([f.proj]);
  const deps = { roots: [f.proj], check: (x: string) => p.check(x), isDirectory: (x: string) => g.stat(x).isDirectory() };
  assert.deepEqual(placeRunIn(path.join(f.proj, 'credentials-svc'), deps), { runIn: null, why: 'stat-refused' });
  assert.deepEqual(placeRunIn(path.join(f.proj, 'missing'), deps), { runIn: null, why: 'not-found' }, 'what is not there stays not-found');
  // A realpath that failed for another reason (EACCES) is unknown too; ENOENT is not-found.
  const unresolved = (detail: string) => placeRunIn(path.join(f.proj, 'sub'), { ...deps, check: () => ({ ok: false, reason: 'unresolved', detail }) as never });
  assert.deepEqual(unresolved('EACCES'), { runIn: null, why: 'stat-refused' });
  assert.deepEqual(unresolved('ENOENT'), { runIn: null, why: 'not-found' });
  const thrown = (code: string) => placeRunIn(path.join(f.proj, 'sub'), { ...deps, isDirectory: () => {
    throw Object.assign(new Error(code), { code });
  } });
  assert.deepEqual(thrown('EPERM'), { runIn: null, why: 'stat-refused' });
  assert.deepEqual(thrown('ENOENT'), { runIn: null, why: 'not-found' });
});

test('checkProjectRoots: a root the page\'s contract or owned-new\'s route would refuse (a bidi or C1 character, too long) refuses the start; a root is kept as the disk spells it', (t) => {
  const f = fixture(t);
  const deps = f.deps(f.policy({ testDir: f.testDir }));
  const no = (roots: string[]) => {
    const v = checkProjectRoots(roots, deps);
    assert.equal(v.ok, false, JSON.stringify(v));
    return v as Extract<typeof v, { ok: false }>;
  };
  assert.equal(no([path.join(f.testDir, 'p\u202Eq')]).why, 'bad-chars');
  assert.equal(no([path.join(f.testDir, 'p\u0085q')]).why, 'bad-chars');
  const long = path.join(f.testDir, 'x'.repeat(Math.max(1, 261 - f.testDir.length)));
  assert.equal(no([long]).why, 'too-long');
  const wide = path.join(f.testDir, '\u4e2d'.repeat(250));
  assert.equal(no([wide]).why, 'too-long', 'over 780 UTF-8 bytes');
  const v = checkProjectRoots([path.join(f.testDir, 'PROJ')], deps);
  assert.deepEqual(v, { ok: true, roots: [f.proj] }, 'the realpath\'s spelling, as the cwd table compares an allow');
});
