import * as path from 'node:path';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { PathRejectReason, RealpathFn } from '../fs/paths.ts';
import { canonicalize, checkPath, isWithin, nativeRealpath, pathKey } from '../fs/paths.ts';

const win = path.win32;

// Profiles (plan §2 row 测试 profile, §6 invariant 11, D8 r4:492, r4:1701). The real profile takes
// no arguments at all. The test profile is the only one an agent may start: a temp data dir,
// synthetic roots, brakes only on registered fake-agent trees, and a pairing code on stdout.

export const TEST_DIR_PREFIX = 'orchestra-test-';
/** The command-line marker of the test harness's fake agents (test/fixtures/fake-agent.ts). */
export const FAKE_AGENT_MARKER = '--orchestra-fake-agent';
export const FROZEN_DIR = 'orchestra-frozen';
export const TEST_ROOT_KINDS = ['claude', 'dsh', 'codex'] as const;

export type RealProfile = { kind: 'real' };
export type TestProfile = {
  kind: 'test';
  /** Canonical form: every later path derives from it, so lexical and canonical never differ. */
  testDir: string;
  orchestraHome: string;
  /** <testDir>\roots, or the --roots-dir under %LOCALAPPDATA%\orchestra-frozen\. */
  rootsDir: string;
  rootsDirGiven: boolean;
  rootPids: number[];
};
export type Profile = RealProfile | TestProfile;

export type ProfileRefusal =
  | { reason: 'unknown-argument'; arg: string }
  | { reason: 'missing-value'; flag: string }
  | { reason: 'duplicate-flag'; flag: string }
  | { reason: 'test-flag-without-test-profile'; flag: string }
  | { reason: 'test-dir-required' }
  | { reason: 'test-dir-bad-path'; path: string; detail: PathRejectReason }
  | { reason: 'test-dir-not-found'; path: string; detail: string }
  | { reason: 'test-dir-outside-tmp'; path: string; tmp: string }
  | { reason: 'test-dir-name'; path: string }
  | { reason: 'tmpdir-unavailable'; detail: string }
  | { reason: 'bad-root-pid'; value: string }
  | { reason: 'duplicate-root-pid'; pid: number }
  | { reason: 'localappdata-unset' }
  | { reason: 'roots-dir-bad-path'; path: string; detail: PathRejectReason }
  | { reason: 'roots-dir-outside-frozen'; path: string; frozen: string };

export type ProfileParse = { ok: true; profile: Profile } | { ok: false; refusal: ProfileRefusal };

export type ProfileDeps = {
  env: Readonly<Record<string, string | undefined>>;
  realpath?: RealpathFn;
};

function envGet(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

/**
 * os.tmpdir() on Windows, from the injected environment: TEMP, else TMP, else %SystemRoot%\temp,
 * trailing separator dropped unless it is a drive root. Computed here because this module may not
 * import node:os (builtin-policy.ts); test/runtime/test-profile.test.ts checks it equals os.tmpdir().
 */
export function windowsTmpdir(env: Readonly<Record<string, string | undefined>>): string {
  const p = envGet(env, 'TEMP') || envGet(env, 'TMP') || `${envGet(env, 'SystemRoot') || envGet(env, 'windir')}\\temp`;
  return p.length > 1 && p.endsWith('\\') && !p.endsWith(':\\') ? p.slice(0, -1) : p;
}

const FLAGS_WITH_VALUE = new Set(['--test-dir', '--test-root-pid', '--roots-dir']);
const PID = /^[1-9]\d{0,9}$/;

/**
 * Parses orchestrad's own arguments. Anything unrecognized, repeated or out of place refuses the
 * start: the real profile accepts none; the test profile exactly
 * `--test-profile --test-dir <dir> [--test-root-pid <pid>]... [--roots-dir <dir>]`, in any order.
 */
export function parseProfileArgs(argv: readonly string[], deps: ProfileDeps): ProfileParse {
  const refuse = (refusal: ProfileRefusal): ProfileParse => ({ ok: false, refusal });
  let testProfile = false;
  let testDir: string | null = null;
  let rootsDir: string | null = null;
  const pids: number[] = [];
  const seenTestFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--test-profile') {
      if (testProfile) return refuse({ reason: 'duplicate-flag', flag: arg });
      testProfile = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(arg)) return refuse({ reason: 'unknown-argument', arg });
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return refuse({ reason: 'missing-value', flag: arg });
    i++;
    seenTestFlags.push(arg);
    if (arg === '--test-dir') {
      if (testDir !== null) return refuse({ reason: 'duplicate-flag', flag: arg });
      testDir = value;
    } else if (arg === '--roots-dir') {
      if (rootsDir !== null) return refuse({ reason: 'duplicate-flag', flag: arg });
      rootsDir = value;
    } else {
      if (!PID.test(value) || Number(value) > 0xffffffff) return refuse({ reason: 'bad-root-pid', value });
      const pid = Number(value);
      if (pids.includes(pid)) return refuse({ reason: 'duplicate-root-pid', pid });
      pids.push(pid);
    }
  }
  if (!testProfile) {
    return seenTestFlags.length > 0 ? refuse({ reason: 'test-flag-without-test-profile', flag: seenTestFlags[0]! }) : { ok: true, profile: { kind: 'real' } };
  }
  if (testDir === null) return refuse({ reason: 'test-dir-required' });
  const realpath = deps.realpath ?? nativeRealpath;

  const given = checkPath(testDir);
  if (!given.ok) return refuse({ reason: 'test-dir-bad-path', path: testDir, detail: given.reason });
  let dirReal: string;
  try {
    dirReal = realpath(given.path);
  } catch (e) {
    return refuse({ reason: 'test-dir-not-found', path: given.path, detail: errCode(e) });
  }
  const tmpRaw = windowsTmpdir(deps.env);
  const tmp = checkPath(tmpRaw);
  if (!tmp.ok) return refuse({ reason: 'tmpdir-unavailable', detail: `${tmp.reason}: ${tmpRaw}` });
  let tmpReal: string;
  try {
    tmpReal = realpath(tmp.path);
  } catch (e) {
    return refuse({ reason: 'tmpdir-unavailable', detail: `${errCode(e)}: ${tmp.path}` });
  }
  if (pathKey(win.dirname(dirReal)) !== pathKey(tmpReal)) return refuse({ reason: 'test-dir-outside-tmp', path: dirReal, tmp: tmpReal });
  const name = win.basename(dirReal);
  if (!name.toLowerCase().startsWith(TEST_DIR_PREFIX) || name.length === TEST_DIR_PREFIX.length) {
    return refuse({ reason: 'test-dir-name', path: dirReal });
  }

  let roots = win.join(dirReal, 'roots');
  if (rootsDir !== null) {
    const local = envGet(deps.env, 'LOCALAPPDATA');
    if (local === undefined || local.trim() === '') return refuse({ reason: 'localappdata-unset' });
    const r = checkPath(rootsDir);
    if (!r.ok) return refuse({ reason: 'roots-dir-bad-path', path: rootsDir, detail: r.reason });
    const l = checkPath(local);
    if (!l.ok) return refuse({ reason: 'roots-dir-bad-path', path: local, detail: l.reason });
    const frozen = win.join(l.path, FROZEN_DIR);
    let inside: boolean;
    try {
      const frozenReal = canonicalize(frozen, realpath);
      const rReal = canonicalize(r.path, realpath);
      const strictly = (p: string, base: string) => isWithin(p, base) && pathKey(p) !== pathKey(base);
      inside = strictly(r.path, frozen) && strictly(rReal, frozenReal);
    } catch {
      inside = false;
    }
    if (!inside) return refuse({ reason: 'roots-dir-outside-frozen', path: r.path, frozen });
    roots = r.path;
  }
  return {
    ok: true,
    profile: { kind: 'test', testDir: dirReal, orchestraHome: win.join(dirReal, 'orchestra'), rootsDir: roots, rootsDirGiven: rootsDir !== null, rootPids: pids },
  };
}

export function describeRefusal(r: ProfileRefusal): string {
  switch (r.reason) {
    case 'unknown-argument':
      return `unknown argument ${JSON.stringify(r.arg)} (the real profile takes none; see --test-profile)`;
    case 'missing-value':
      return `${r.flag} needs a value`;
    case 'duplicate-flag':
      return `${r.flag} given twice`;
    case 'test-flag-without-test-profile':
      return `${r.flag} only works with --test-profile`;
    case 'test-dir-required':
      return '--test-profile needs --test-dir <dir>';
    case 'test-dir-bad-path':
      return `--test-dir rejected (${r.detail}): ${r.path}`;
    case 'test-dir-not-found':
      return `--test-dir does not exist (${r.detail}): ${r.path}`;
    case 'test-dir-outside-tmp':
      return `--test-dir must be directly inside ${r.tmp}: ${r.path}`;
    case 'test-dir-name':
      return `--test-dir name must start with ${TEST_DIR_PREFIX}: ${r.path}`;
    case 'tmpdir-unavailable':
      return `the temp directory cannot be resolved (${r.detail})`;
    case 'bad-root-pid':
      return `--test-root-pid needs a positive integer, got ${JSON.stringify(r.value)}`;
    case 'duplicate-root-pid':
      return `--test-root-pid ${r.pid} given twice`;
    case 'localappdata-unset':
      return '--roots-dir needs %LOCALAPPDATA%';
    case 'roots-dir-bad-path':
      return `--roots-dir rejected (${r.detail}): ${r.path}`;
    case 'roots-dir-outside-frozen':
      return `--roots-dir must lie below ${r.frozen}: ${r.path}`;
  }
}

/** The test profile's harness roots: <rootsDir>\{claude,dsh,codex}, and nothing else. */
export function testProfileRoots(p: TestProfile, realpath: RealpathFn = nativeRealpath): HarnessRoot[] {
  return TEST_ROOT_KINDS.map((kind) => {
    const dir = win.join(p.rootsDir, kind);
    return { kind, path: dir, real: canonicalize(dir, realpath) };
  });
}

/** What the test profile's read gate may see: the test dir, plus the frozen roots dir when given. */
export function testReadDirs(p: TestProfile): string[] {
  return p.rootsDirGiven ? [p.testDir, p.rootsDir] : [p.testDir];
}

export type PairingOutput =
  | { print: 'stdout'; reason: 'test-profile' }
  | { print: 'console'; reason: 'interactive' }
  | { print: 'none'; reason: 'not-interactive' };

/**
 * Where the pairing code goes. The test harness reads it from stdout; the real profile prints it
 * only to an interactive console (stdin and stdout both TTYs) and otherwise turns pairing off.
 */
export function decidePairingOutput(profile: Profile, tty: { stdin: boolean; stdout: boolean }): PairingOutput {
  if (profile.kind === 'test') return { print: 'stdout', reason: 'test-profile' };
  return tty.stdin && tty.stdout ? { print: 'console', reason: 'interactive' } : { print: 'none', reason: 'not-interactive' };
}

/** A process the test profile may register as a brake root: node.exe carrying the fake-agent marker. */
export function isFakeAgent(image: string, commandLine: string): boolean {
  return win.basename(image).toLowerCase() === 'node.exe' && commandLine.split(/\s+/).includes(FAKE_AGENT_MARKER);
}

export type TestRootState =
  | { pid: number; state: 'unresolved' }
  | { pid: number; state: 'registered'; createTime: number }
  | { pid: number; state: 'rejected'; why: 'not-found' | 'not-fake-agent' };

export type BrakeRootCheck =
  | { ok: true; scope: 'real-profile' | 'test-root' }
  | { ok: false; reason: 'not-test-root' | 'unresolved' | 'rejected' | 'create-time-mismatch' };

/**
 * The --test-root-pid list. Each pid is resolved once to pid:createTime through procguard (step 6);
 * until then it stays unresolved and no brake may use it.
 */
export class TestRoots {
  readonly #roots = new Map<number, TestRootState>();

  constructor(pids: readonly number[]) {
    for (const pid of pids) this.#roots.set(pid, { pid, state: 'unresolved' });
  }

  /** `info` is procguard's view of the pid, or null when no such process exists. */
  resolve(pid: number, info: { createTime: number; image: string; commandLine: string } | null): TestRootState | null {
    const cur = this.#roots.get(pid);
    if (cur === undefined || cur.state !== 'unresolved') return cur ?? null;
    const next: TestRootState = info === null
      ? { pid, state: 'rejected', why: 'not-found' }
      : isFakeAgent(info.image, info.commandLine) ? { pid, state: 'registered', createTime: info.createTime } : { pid, state: 'rejected', why: 'not-fake-agent' };
    this.#roots.set(pid, next);
    return next;
  }

  check(pid: number, createTime: number): BrakeRootCheck {
    const cur = this.#roots.get(pid);
    if (cur === undefined) return { ok: false, reason: 'not-test-root' };
    if (cur.state === 'unresolved') return { ok: false, reason: 'unresolved' };
    if (cur.state === 'rejected') return { ok: false, reason: 'rejected' };
    return cur.createTime === createTime ? { ok: true, scope: 'test-root' } : { ok: false, reason: 'create-time-mismatch' };
  }

  entries(): TestRootState[] {
    return [...this.#roots.values()];
  }
}

/** May a brake be rooted at (pid, createTime)? In the test profile only at a registered test root. */
export function checkBrakeRoot(profile: Profile, roots: TestRoots | null, pid: number, createTime: number): BrakeRootCheck {
  if (profile.kind === 'real') return { ok: true, scope: 'real-profile' };
  return roots === null ? { ok: false, reason: 'not-test-root' } : roots.check(pid, createTime);
}
