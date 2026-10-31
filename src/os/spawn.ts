import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { RealpathFn } from '../fs/paths.ts';
import { checkPath, nativeRealpath, pathKey } from '../fs/paths.ts';

const win = path.win32;

// The only child_process entry (plan §6 invariant 6): an exact list of (absolute exe, exact argv)
// pairs. No shell, no .cmd/.bat, no relative path, no argv that is not on the list. Every exe and
// fixed argument is pinned here; a caller only picks which rules a gate allows.

export type SpawnRule = 'whoami' | 'csc' | 'powershell-toast' | 'procguard';
const RULES: readonly SpawnRule[] = ['whoami', 'csc', 'powershell-toast', 'procguard'];

export const WHOAMI_ARGV: readonly string[] = ['/groups', '/fo', 'csv', '/nh'];
/** The fixed csc vector of plan §2; `/out:<path>` and the source file follow it. */
export const CSC_FLAGS: readonly string[] = [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-', '/r:System.Core.dll', '/r:System.Web.Extensions.dll',
];
/** Followed by exactly one argument: the constant script of os/toast-script.ts, encoded. */
export const TOAST_FLAGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden', '-EncodedCommand'];
/** The encoded constant of os/toast-script.ts. That module arrives in step 17; until then the rule cannot be enabled. */
const TOAST_ENCODED: string | null = null;
const PROTECT_LIST = /^[1-9]\d{0,9}:\d{1,20}(?:,[1-9]\d{0,9}:\d{1,20})*$/;
const SOURCE_HASH = /^[0-9a-f]{64}$/;

export const WHOAMI_REL = 'System32\\whoami.exe';
export const CSC_REL = 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
export const POWERSHELL_REL = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const REPO = win.join(import.meta.dirname, '..', '..');
/** The one file csc may compile. */
export const PROCGUARD_SOURCE = win.join(REPO, 'native', 'procguard', 'ProcGuard.cs');
/** The development build of procguard. */
export const PROCGUARD_BUILD_EXE = win.join(REPO, 'build', 'procguard.exe');

export type SystemRootReason = 'unset' | 'bad-path' | 'not-top-level-dir' | 'windir-mismatch' | 'unresolved' | 'reparsed';
export type SystemRoot = { ok: true; path: string } | { ok: false; reason: SystemRootReason; detail?: string };
export type ProvenSystemRoot = Extract<SystemRoot, { ok: true }>;

// The ok results resolveSystemRoot handed out. A gate takes only one of these, never a look-alike
// object or a bare string, so its System32 went through every check below.
const PROVEN = new WeakSet<object>();

function envGet(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

/**
 * %SystemRoot% from the injected environment. Windows sets it for every process from HKLM; changing
 * it takes control of our parent's environment, which is already the same user (r4 §10.11 #6). The
 * checks catch misconfiguration: a top-level directory of a drive, equal to %windir% when that is
 * set, resolving to itself (no junction). Anything else leaves every exe below it unresolved.
 */
export function resolveSystemRoot(env: Readonly<Record<string, string | undefined>>, realpath: RealpathFn = nativeRealpath): SystemRoot {
  const raw = envGet(env, 'SystemRoot');
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'unset' };
  const c = checkPath(raw);
  if (!c.ok) return { ok: false, reason: 'bad-path', detail: c.reason };
  if (!/^[A-Za-z]:\\[^\\]+$/.test(c.path)) return { ok: false, reason: 'not-top-level-dir', detail: c.path };
  const windir = envGet(env, 'windir');
  if (windir !== undefined && windir.trim() !== '') {
    const w = checkPath(windir);
    if (!w.ok || pathKey(w.path) !== pathKey(c.path)) return { ok: false, reason: 'windir-mismatch', detail: windir };
  }
  let real: string;
  try {
    real = realpath(c.path);
  } catch (e) {
    return { ok: false, reason: 'unresolved', detail: errCode(e) };
  }
  if (pathKey(real) !== pathKey(c.path)) return { ok: false, reason: 'reparsed', detail: real };
  const proven: ProvenSystemRoot = Object.freeze({ ok: true as const, path: c.path });
  PROVEN.add(proven);
  return proven;
}

export type PidEntry = { at: string; rule: SpawnRule; exe: string; pid: number | null; error?: string };

/**
 * Every spawn, in order. Lines wait in memory until a sink is attached (working mode attaches
 * run/pids.jsonl through the write fence); whoami runs before the data dir is known, and a ui-only
 * process never gets a sink because it never writes. A failing sink keeps the line in memory.
 */
export class PidLog {
  readonly #all: PidEntry[] = [];
  #unwritten: string[] = [];
  #sink: ((line: string) => void) | null = null;
  #onFailure: ((failures: number, error: unknown) => void) | null = null;
  #failures = 0;

  record(e: PidEntry): void {
    this.#all.push(e);
    this.#unwritten.push(`${JSON.stringify(e)}\n`);
    this.#flush();
  }

  /** `onFailure` hears every failed write with the running count (working mode logs the first). */
  attach(sink: (line: string) => void, onFailure?: (failures: number, error: unknown) => void): void {
    this.#sink = sink;
    this.#onFailure = onFailure ?? null;
    this.#flush();
  }

  entries(): readonly PidEntry[] {
    return [...this.#all];
  }

  /** Lines not yet written to the sink (all of them while none is attached). */
  unwritten(): number {
    return this.#unwritten.length;
  }

  failures(): number {
    return this.#failures;
  }

  #flush(): void {
    if (this.#sink === null) return;
    while (this.#unwritten.length > 0) {
      try {
        this.#sink(this.#unwritten[0]!);
      } catch (e) {
        this.#failures++;
        try {
          this.#onFailure?.(this.#failures, e);
        } catch {
          // A failing reporter must not take the spawn down either.
        }
        return;
      }
      this.#unwritten.shift();
    }
  }
}

/** The spawn options the gate itself chooses; callers never pass any. */
export type BackendOptions = {
  cwd: string;
  windowsHide: true;
  shell: false;
  stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
};

export type ChildLike = Pick<ChildProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'on' | 'once' | 'kill'>;

export type SpawnBackend = (exe: string, argv: readonly string[], opts: BackendOptions) => ChildLike;

const NODE_BACKEND: SpawnBackend = (exe, argv, opts) => nodeSpawn(exe, [...argv], opts);

export type SpawnRequest = {
  exe: string;
  argv: readonly string[];
  /** Present only so a caller asking for a shell or other options is refused with a reason. */
  options?: Readonly<Record<string, unknown>>;
};

export type SpawnDenyReason =
  | 'bad-request'
  | 'shell'
  | 'option-not-allowed'
  | 'not-absolute'
  | 'bad-exe-path'
  | 'script-shim'
  | 'not-exe'
  | 'unknown-exe'
  | 'rule-not-enabled'
  | 'argv-mismatch'
  | 'out-path-denied'
  | 'exe-unresolved'
  | 'exe-reparsed';

export type SpawnDecision =
  | { allow: true; rule: SpawnRule; exe: string; argv: readonly string[] }
  | { allow: false; reason: SpawnDenyReason; exe: string; rule?: SpawnRule; detail?: string };

export class SpawnRefusedError extends Error {
  readonly code = 'ERR_ORCHESTRA_SPAWN';
  readonly decision: Extract<SpawnDecision, { allow: false }>;
  constructor(decision: Extract<SpawnDecision, { allow: false }>) {
    super(`[ERR_ORCHESTRA_SPAWN] spawn refused (${decision.reason}${decision.rule ? `, ${decision.rule}` : ''}): ${decision.exe}`);
    this.decision = decision;
  }
}

/** Where procguard.exe may run from: the data dir's runtime\procguard\<source sha256>\, or the repo's build\. */
export type ProcguardSite = { at: 'runtime'; homeReal: string; sourceHash: string } | { at: 'build' };

export type SpawnGateConfig = {
  /** The ok result of resolveSystemRoot() itself; a look-alike object is refused. */
  systemRoot: ProvenSystemRoot;
  /** The rules this gate allows; any other matching request is refused with `rule-not-enabled`. */
  rules: readonly SpawnRule[];
  /** csc: the write fence's verdict on `/out:`. The source is always PROCGUARD_SOURCE, and `/out:` must sit in a procguard site. */
  csc?: { outAllowed(out: string): boolean };
  procguard?: readonly ProcguardSite[];
  /** Hears every spawn (PidLog.record, which ends up in run/pids.jsonl). Required: no spawn goes unrecorded. */
  record: (e: PidEntry) => void;
  backend?: SpawnBackend;
  realpath?: RealpathFn;
  now?: () => number;
};

export type RunLimits = { timeoutMs: number; maxBytes: number };

export type RunResult =
  | { ok: true; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { ok: false; reason: 'refused'; decision: Extract<SpawnDecision, { allow: false }> }
  | { ok: false; reason: 'spawn-failed'; detail: string }
  | { ok: false; reason: 'timeout'; timeoutMs: number }
  | { ok: false; reason: 'output-too-large'; maxBytes: number }
  | { ok: false; reason: 'signal'; signal: string };

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function mustPath(p: string, what: string): string {
  const c = checkPath(p);
  if (!c.ok) throw new Error(`spawn gate: ${what} rejected (${c.reason}): ${String(p)}`);
  return c.path;
}

function procguardExe(site: ProcguardSite): string {
  if (site?.at === 'build') return mustPath(PROCGUARD_BUILD_EXE, 'procguard build exe');
  if (site?.at === 'runtime') {
    if (typeof site.sourceHash !== 'string' || !SOURCE_HASH.test(site.sourceHash)) {
      throw new Error(`spawn gate: procguard source hash must be 64 lowercase hex digits: ${String(site.sourceHash)}`);
    }
    return win.join(mustPath(site.homeReal, 'procguard data dir'), 'runtime', 'procguard', site.sourceHash, 'procguard.exe');
  }
  throw new Error('spawn gate: a procguard site is { at: "runtime", homeReal, sourceHash } or { at: "build" }');
}

type RequestCopy = { ok: true; exe: string; argv: readonly string[]; options: readonly [string, unknown][] } | { ok: false; exe: string };

/**
 * Reads each field of a caller-owned request exactly once and copies it, so a getter or a Proxy
 * cannot show the checks one vector and spawn another. Everything after this sees only the copy.
 */
function copyRequest(req: unknown): RequestCopy {
  if (typeof req !== 'object' || req === null) return { ok: false, exe: `<${req === null ? 'null' : typeof req}>` };
  let exe: unknown;
  let argv: unknown;
  let options: unknown;
  try {
    const r = req as Record<string, unknown>;
    exe = r.exe;
    argv = r.argv;
    options = r.options;
  } catch {
    return { ok: false, exe: '<unreadable>' };
  }
  const exeText = typeof exe === 'string' ? exe : `<${exe === null ? 'null' : typeof exe}>`;
  try {
    if (typeof exe !== 'string' || !Array.isArray(argv)) return { ok: false, exe: exeText };
    const copy: unknown[] = Array.from(argv as unknown[]);
    if (!copy.every((a) => typeof a === 'string')) return { ok: false, exe: exeText };
    if (options !== undefined && (typeof options !== 'object' || options === null)) return { ok: false, exe: exeText };
    const entries = options === undefined ? [] : Object.entries(options);
    return { ok: true, exe, argv: Object.freeze(copy as string[]), options: entries };
  } catch {
    return { ok: false, exe: exeText };
  }
}

export class SpawnGate {
  readonly #exes: ReadonlyMap<string, { rule: SpawnRule; exe: string }>;
  readonly #rules: ReadonlySet<SpawnRule>;
  readonly #csc: { outDirs: ReadonlySet<string>; outAllowed(out: string): boolean } | null;
  readonly #backend: SpawnBackend;
  readonly #record: (e: PidEntry) => void;
  readonly #realpath: RealpathFn;
  readonly #now: () => number;

  constructor(cfg: SpawnGateConfig) {
    const sys = cfg?.systemRoot;
    if (typeof sys !== 'object' || sys === null || !PROVEN.has(sys)) throw new Error('spawn gate: systemRoot must be the ok result of resolveSystemRoot()');
    if (typeof cfg.record !== 'function') throw new Error('spawn gate: record is required, every spawn lands in run/pids.jsonl');
    const exes = new Map<string, { rule: SpawnRule; exe: string }>();
    const add = (rule: SpawnRule, exe: string) => exes.set(pathKey(exe), { rule, exe });
    add('whoami', win.join(sys.path, WHOAMI_REL));
    add('csc', win.join(sys.path, CSC_REL));
    add('powershell-toast', win.join(sys.path, POWERSHELL_REL));
    const pgDirs = new Set<string>();
    for (const site of cfg.procguard ?? []) {
      const exe = procguardExe(site);
      add('procguard', exe);
      pgDirs.add(pathKey(win.dirname(exe)));
    }
    this.#exes = exes;
    for (const r of cfg.rules) if (!RULES.includes(r)) throw new Error(`spawn gate: unknown rule ${String(r)}`);
    this.#rules = new Set(cfg.rules);
    if (this.#rules.has('powershell-toast') && TOAST_ENCODED === null) {
      throw new Error('spawn gate: powershell-toast needs the constant script of os/toast-script.ts, which arrives in step 17');
    }
    if (this.#rules.has('procguard') && pgDirs.size === 0) throw new Error('spawn gate: procguard enabled without a site');
    const outAllowed = cfg.csc?.outAllowed;
    this.#csc = typeof outAllowed === 'function' ? { outDirs: pgDirs, outAllowed } : null;
    if (this.#rules.has('csc') && (this.#csc === null || pgDirs.size === 0)) throw new Error('spawn gate: csc enabled without an /out: verdict and a procguard site to build into');
    this.#backend = cfg.backend ?? NODE_BACKEND;
    this.#record = cfg.record;
    this.#realpath = cfg.realpath ?? nativeRealpath;
    this.#now = cfg.now ?? Date.now;
  }

  decide(req: SpawnRequest): SpawnDecision {
    const r = copyRequest(req);
    const deny = (reason: SpawnDenyReason, extra: { rule?: SpawnRule; detail?: string } = {}): SpawnDecision => ({ allow: false, reason, exe: r.exe, ...extra });
    if (!r.ok) return deny('bad-request');
    for (const [key, value] of r.options) {
      if (key === 'shell') {
        if (value !== false) return deny('shell', { detail: typeof value === 'object' || typeof value === 'function' ? typeof value : String(value) });
      } else {
        return deny('option-not-allowed', { detail: key });
      }
    }
    const c = checkPath(r.exe);
    if (!c.ok) return deny(c.reason === 'not-absolute' ? 'not-absolute' : 'bad-exe-path', { detail: c.reason });
    const lower = c.path.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return deny('script-shim');
    if (!lower.endsWith('.exe')) return deny('not-exe');
    const known = this.#exes.get(pathKey(c.path));
    if (known === undefined) return deny('unknown-exe');
    const rule = known.rule;
    if (!this.#rules.has(rule)) return deny('rule-not-enabled', { rule });
    const argvCheck = this.#argvOk(rule, r.argv);
    if (argvCheck !== null) return deny(argvCheck, { rule });
    let real: string;
    try {
      real = this.#realpath(known.exe);
    } catch (e) {
      return deny('exe-unresolved', { rule, detail: errCode(e) });
    }
    if (pathKey(real) !== pathKey(known.exe)) return deny('exe-reparsed', { rule, detail: real });
    return { allow: true, rule, exe: known.exe, argv: r.argv };
  }

  #argvOk(rule: SpawnRule, argv: readonly string[]): SpawnDenyReason | null {
    switch (rule) {
      case 'whoami':
        return sameArgv(argv, WHOAMI_ARGV) ? null : 'argv-mismatch';
      case 'powershell-toast':
        return TOAST_ENCODED !== null && argv.length === TOAST_FLAGS.length + 1 && sameArgv(argv.slice(0, -1), TOAST_FLAGS) && argv.at(-1) === TOAST_ENCODED
          ? null
          : 'argv-mismatch';
      case 'procguard':
        return argv.length === 0 || (argv.length === 2 && argv[0] === '--protect' && PROTECT_LIST.test(argv[1]!)) ? null : 'argv-mismatch';
      case 'csc': {
        const csc = this.#csc!;
        if (argv.length !== CSC_FLAGS.length + 2 || !sameArgv(argv.slice(0, CSC_FLAGS.length), CSC_FLAGS)) return 'argv-mismatch';
        const outArg = argv[CSC_FLAGS.length]!;
        const source = argv[CSC_FLAGS.length + 1]!;
        if (!outArg.startsWith('/out:')) return 'argv-mismatch';
        const src = checkPath(source);
        if (!src.ok || src.path !== source || pathKey(src.path) !== pathKey(PROCGUARD_SOURCE)) return 'argv-mismatch';
        const outText = outArg.slice('/out:'.length);
        const out = checkPath(outText);
        if (!out.ok || out.path !== outText || !out.path.toLowerCase().endsWith('.exe')) return 'out-path-denied';
        if (!csc.outDirs.has(pathKey(win.dirname(out.path)))) return 'out-path-denied';
        try {
          return csc.outAllowed(out.path) === true ? null : 'out-path-denied';
        } catch {
          return 'out-path-denied';
        }
      }
    }
  }

  #spawn(d: Extract<SpawnDecision, { allow: true }>, stdin: 'ignore' | 'pipe'): ChildLike {
    const at = new Date(this.#now()).toISOString();
    let child: ChildLike;
    try {
      child = this.#backend(d.exe, d.argv, { cwd: win.dirname(d.exe), windowsHide: true, shell: false, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (e) {
      this.#record({ at, rule: d.rule, exe: d.exe, pid: null, error: errCode(e) });
      throw e;
    }
    this.#record({ at, rule: d.rule, exe: d.exe, pid: typeof child.pid === 'number' ? child.pid : null });
    return child;
  }

  /** A long-lived child (toast worker, procguard) with stdin, stdout and stderr piped. */
  start(req: SpawnRequest): ChildLike {
    const d = this.decide(req);
    if (!d.allow) throw new SpawnRefusedError(d);
    return this.#spawn(d, 'pipe');
  }

  /** Runs to completion and collects the output; past the time or size limit the child is killed. */
  run(req: SpawnRequest, limits: RunLimits): Promise<RunResult> {
    const d = this.decide(req);
    if (!d.allow) return Promise.resolve({ ok: false, reason: 'refused', decision: d });
    let child: ChildLike;
    try {
      child = this.#spawn(d, 'ignore');
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'spawn-failed', detail: errCode(e) });
    }
    return collect(child, limits);
  }
}

function collect(child: ChildLike, limits: RunLimits): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let stop: 'timeout' | 'output-too-large' | null = null;
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const halt = (why: 'timeout' | 'output-too-large') => {
      if (stop !== null) return;
      stop = why;
      child.kill();
    };
    const timer = setTimeout(() => halt('timeout'), limits.timeoutMs);
    const take = (into: Buffer[]) => (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
      bytes += b.length;
      if (bytes > limits.maxBytes) halt('output-too-large');
      else into.push(b);
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(err));
    child.on('error', (e: Error) => finish({ ok: false, reason: 'spawn-failed', detail: errCode(e) }));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (stop === 'timeout') finish({ ok: false, reason: 'timeout', timeoutMs: limits.timeoutMs });
      else if (stop === 'output-too-large') finish({ ok: false, reason: 'output-too-large', maxBytes: limits.maxBytes });
      else if (code === null) finish({ ok: false, reason: 'signal', signal: String(signal) });
      else finish({ ok: true, exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}
