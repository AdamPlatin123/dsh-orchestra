import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { RealpathFn } from '../fs/paths.ts';
import type { Clock, ClockHub, Fired } from '../runtime/clock.ts';
import { checkPath, pathKey } from '../fs/paths.ts';
import { tableSeq } from '../runtime/clock.ts';
import type { CwdPolicySpec } from './cwd.ts';
import { CwdPolicy } from './cwd.ts';
import { envGet, ownFields } from '../runtime/own.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// The only way to a child process (plan §6 invariant 6): an exact list of (absolute exe, exact argv)
// pairs. No shell, no .cmd/.bat, no relative path, no argv that is not on the list. Every exe and
// fixed argument is pinned here; a caller only picks which rules a gate allows. The backend that
// really spawns is minted in src/os/node-proc.ts (the only importer of node:child_process) and
// reaches a gate only through node-proc.ts's gate factory: a gate built anywhere else spawns through whatever its
// builder wrote, which cannot start a process.

export type SpawnRule =
  | 'whoami' | 'csc' | 'powershell-toast' | 'procguard' | 'codex-app-server' | 'codex-app-server-fake' | 'claude-host'
  | 'procguard-codex' | 'procguard-codex-fake' | 'procguard-claude';
const RULES: readonly SpawnRule[] = Object.freeze([
  'whoami', 'csc', 'powershell-toast', 'procguard', 'codex-app-server', 'codex-app-server-fake', 'claude-host', 'procguard-codex', 'procguard-codex-fake', 'procguard-claude',
]);

/**
 * The owned sessions' children, each started inside a Job of its own (r4 D4; orchestra app: owned
 * sessions in procguard Jobs): procguard.exe run-in-job --name <job> --env-allowlist <file> -- <the inner
 * rule's exe and argv, exactly as that rule allows them>. The inner rule decides the exe, the argv, the
 * cwd and the environment; procguard only puts its tree into the Job and passes its stdio through.
 */
export type WrappableRule = 'codex-app-server' | 'codex-app-server-fake' | 'claude-host';
export type WrappedRule = 'procguard-codex' | 'procguard-codex-fake' | 'procguard-claude';
export const WRAPPED_OF: Readonly<Record<WrappedRule, WrappableRule>> = Object.freeze({
  'procguard-codex': 'codex-app-server', 'procguard-codex-fake': 'codex-app-server-fake', 'procguard-claude': 'claude-host',
});
const WRAP_OF: Readonly<Record<WrappableRule, WrappedRule>> = Object.freeze({
  'codex-app-server': 'procguard-codex', 'codex-app-server-fake': 'procguard-codex-fake', 'claude-host': 'procguard-claude',
});
const isWrapped = (r: SpawnRule): r is WrappedRule => Object.hasOwn(WRAPPED_OF, r);
const isWrappable = (r: SpawnRule): r is WrappableRule => Object.hasOwn(WRAP_OF, r);
/** The rule whose whitelist and extras a rule's child gets: a wrapped rule's is its inner rule's (procguard passes them on by name). */
const envRuleOf = (r: SpawnRule): SpawnRule => (isWrapped(r) ? WRAPPED_OF[r] : r);
/** A Job's name as orchestrad makes it (src/os/procguard.ts newJobName) and procguard takes it (native/procguard/ProcGuard.cs). */
export const PROCGUARD_JOB_RE = frozen(/^orchestra-job-[0-9a-f]{32}$/);
/** The fixed head of a wrapped argv; the job, the env file, `--` and the inner exe and argv follow in that order. */
export const RUN_IN_JOB = 'run-in-job';
/** procguard's argv for a wrapped start: run-in-job --name <job> --env-allowlist <file> -- <exe> <argv...>. */
export function runInJobArgv(job: string, envFile: string, exe: string, argv: readonly string[]): readonly string[] {
  return Object.freeze([RUN_IN_JOB, '--name', job, '--env-allowlist', envFile, '--', exe, ...argv]);
}

// The argv tables the gate decides from on every call are frozen where they are defined: a module that
// imports one could otherwise push an argument into what the gate allows (P8).
export const WHOAMI_ARGV: readonly string[] = Object.freeze(['/groups', '/fo', 'csv', '/nh']);
/** The fixed csc vector of plan §2; `/out:<path>` and the source file follow it. */
export const CSC_FLAGS: readonly string[] = Object.freeze([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-', '/r:System.Core.dll', '/r:System.Web.Extensions.dll',
]);
/** Followed by exactly one argument: the constant script of os/toast-script.ts, encoded. */
export const TOAST_FLAGS: readonly string[] = Object.freeze(['-NoProfile', '-NonInteractive', '-NoLogo', '-WindowStyle', 'Hidden', '-EncodedCommand']);
/** The encoded constant of os/toast-script.ts. That module arrives in step 17; until then the rule cannot be enabled. */
const TOAST_ENCODED: string | null = null;
const PROTECT_LIST = /^[1-9]\d{0,9}:\d{1,20}(?:,[1-9]\d{0,9}:\d{1,20})*$/;
const SOURCE_HASH = /^[0-9a-f]{64}$/;

// The environment of a child (alpha 0.2 design §2.1, §5 "子进程环境"): never this process's whole env.
// Each rule names the variables it gets; their values are copied from the gate's env source once, at
// construction, and the composition root may add fixed extras per rule. Everything else (NODE_OPTIONS,
// COR_PROFILER, COMPlus_*, LIB, PATH and its DLL search order, proxies, tokens) stays behind.
// One exception the gate cannot close (measured on Node 24.22, owned Codex step): on Windows libuv itself
// copies a fixed list into every child whose env lacks them, from orchestrad's own environment:
// LIBUV_ADDED_ENV below, PATH among them. None of them is a token; a rule that must not see one would
// have to pin its value as an extra. spawn-codex.test measures the list on a real child.
/** What libuv adds to a child's env on Windows when the env given lacks it (libuv make_program_env). */
export const LIBUV_ADDED_ENV: readonly string[] = Object.freeze(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']);
/** Never handed to any child, by whitelist or extra: they load code into a node child before its own. */
export const ENV_NEVER: readonly string[] = Object.freeze(['NODE_OPTIONS', 'NODE_PATH']);
const SYSTEM_ENV = ['SystemRoot', 'SystemDrive', 'windir'] as const;
export const ENV_WHITELIST: Readonly<Record<SpawnRule, readonly string[]>> = Object.freeze({
  whoami: Object.freeze([...SYSTEM_ENV]),
  // csc writes its intermediate files under %TEMP%.
  csc: Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP']),
  procguard: Object.freeze([...SYSTEM_ENV]),
  // Not runnable before step 17 (TOAST_ENCODED); the list is checked against a real toast then.
  'powershell-toast': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']),
  // The owned Codex sessions (orchestra app plan §2): the profile and AppData variables codex.exe reads
  // to find its own state, plus CODEX_HOME as a fixed extra the composition root must give (the private
  // ORCHESTRA_HOME\codex-home); the gate hands over no PATH, no proxy, no key (libuv still adds its own
  // list, PATH among it: LIBUV_ADDED_ENV above). The fake app-server of the tests gets the same.
  'codex-app-server': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']),
  'codex-app-server-fake': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']),
  // The Claude host (alpha 0.2 design §2.1; orchestra app step 4): node.exe running hosts/claude/host.mjs,
  // which hands its env to claude.exe. The probe's system list: the profile and AppData (claude.exe finds
  // its temp and cache dirs there), and PATH, PATHEXT, COMSPEC for the shell tools a person allows. The
  // gateway, the private config dir and the model come as fixed extras (CLAUDE_HOST_REQUIRED_ENV), and
  // the gate adds CLAUDE_HOST_FIXED_ENV itself; no key, no proxy with credentials, no NODE_OPTIONS.
  'claude-host': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'COMSPEC']),
  // A wrapped rule hands procguard exactly its inner rule's environment; procguard builds the child's
  // from zero with the same names (its --env-allowlist, SpawnGate.envAllowlist), so the child sees what
  // it saw when the gate started it directly, libuv's own additions (LIBUV_ADDED_ENV) included.
  'procguard-codex': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']),
  'procguard-codex-fake': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']),
  'procguard-claude': Object.freeze([...SYSTEM_ENV, 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'COMSPEC']),
});
const isNever = (name: string) => ENV_NEVER.some((x) => x.toLowerCase() === name.toLowerCase());
for (const names of Object.values(ENV_WHITELIST)) if (names.some(isNever)) throw new Error('spawn gate: a whitelist names NODE_OPTIONS or NODE_PATH');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Any name that mentions a proxy (HTTPS_PROXY, ftp_proxy, socks_proxy, npm_config_https_proxy,
// GLOBAL_AGENT_HTTP_PROXY, NO_PROXY...): NO_PROXY carries no '@', so it passes the check below.
const PROXY_NAME = /proxy/i;

/** Fixed extras per rule, set once by the composition root (the claude-host rule's NO_PROXY and the like). */
export type EnvExtra = Partial<Record<SpawnRule, Readonly<Record<string, string>>>>;

// Not the URL parser: `user:pass@proxy:8080` parses as scheme `user:` with no userinfo, yet curl,
// git and npm read it as credentials. The authority is whatever follows an optional scheme:// up to
// the first / ? or #; an '@' in it is userinfo.
function hasUserinfo(value: string): boolean {
  const rest = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  return rest.split(/[/?#]/, 1)[0]!.includes('@');
}

/** One rule's child env: its whitelist read from the source, then its extras; frozen, without a prototype. */
function ruleEnv(rule: SpawnRule, source: Readonly<Record<string, string | undefined>>, extraGiven: unknown): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  const names = ENV_WHITELIST[rule];
  for (const name of names) {
    const v = envGet(source, name);
    if (typeof v === 'string' && !v.includes('\0')) out[name] = v;
  }
  if (extraGiven !== undefined) {
    if (typeof extraGiven !== 'object' || extraGiven === null) throw new Error(`spawn gate: envExtra.${rule} must be a record of strings`);
    // Windows env names are case-insensitive: two spellings of one name would leave the child's
    // value to block order, not to the gate.
    const extraSeen = new Set<string>();
    for (const key of Object.keys(extraGiven)) {
      const value = (extraGiven as Record<string, unknown>)[key];
      if (!ENV_NAME.test(key)) throw new Error(`spawn gate: envExtra.${rule}: bad variable name ${JSON.stringify(key)}`);
      if (isNever(key)) throw new Error(`spawn gate: envExtra.${rule}: ${key} is never handed to a child`);
      if (names.some((n) => n.toLowerCase() === key.toLowerCase())) throw new Error(`spawn gate: envExtra.${rule}: ${key} is already on the rule's whitelist`);
      if (extraSeen.has(key.toLowerCase())) throw new Error(`spawn gate: envExtra.${rule}: ${key} is given twice (names are case-insensitive)`);
      extraSeen.add(key.toLowerCase());
      if (typeof value !== 'string' || value.includes('\0')) throw new Error(`spawn gate: envExtra.${rule}.${key} must be a string without NUL`);
      if (PROXY_NAME.test(key) && hasUserinfo(value)) throw new Error(`spawn gate: envExtra.${rule}.${key}: a proxy URL with user:pass@ would reach the child's tools`);
      out[key] = value;
    }
  }
  if (rule === 'claude-host') {
    for (const [k, v] of Object.entries(CLAUDE_HOST_FIXED_ENV)) {
      if (Object.keys(out).some((n) => n.toLowerCase() === k.toLowerCase())) throw new Error(`spawn gate: envExtra.claude-host: ${k} is set by the gate itself`);
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

export const WHOAMI_REL = 'System32\\whoami.exe';
export const CSC_REL = 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
export const POWERSHELL_REL = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * codex.exe below %APPDATA% as npm installs @openai/codex (orchestra app plan, measured on codex-cli
 * 0.165.0): the npm `codex` command is a node shim, and the gate pins the real binary behind it.
 */
export const CODEX_EXE_REL = 'npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
/** The one argv codex.exe runs with: the stdio JSON-RPC app-server. */
export const CODEX_APP_SERVER_ARGV: readonly string[] = Object.freeze(['app-server']);
/** The variable every codex rule must get as a fixed extra: without it codex.exe would use the user's own ~/.codex. */
export const CODEX_HOME_VAR = 'CODEX_HOME';

/**
 * The Claude host's gateway placeholder (orchestra app plan §2, measured 2026-11-02): magpie needs no
 * key, but the CLI wants some auth token before it calls; this fixed string is that token. Not a secret.
 */
export const CLAUDE_GATEWAY_TOKEN = 'orchestra-magpie-no-key';
/** Only a loopback gateway: an owned Claude session's prompts and files go to this machine and nowhere else. */
export const CLAUDE_GATEWAY_RE = frozen(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
/**
 * The extras the composition root must give the claude-host rule, each checked here: the private config
 * dir (never the user's ~/.claude), the loopback gateway, the placeholder token, the small fast model.
 * The session's own model and config dir go in the host's start frame (hosts/claude/host-core.mjs).
 */
export const CLAUDE_HOST_REQUIRED_ENV: readonly string[] = Object.freeze(['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_SMALL_FAST_MODEL', 'NO_PROXY']);
/** Never an extra of the claude-host rule: a real key would leave the gateway's placeholder behind. */
const CLAUDE_HOST_REFUSED_ENV: readonly string[] = Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']);
/**
 * What the gate itself adds for claude-host (alpha 0.2 design §2.1): no workflows (R33), no self-update
 * (a CLI that changes under the host), no traffic the session does not need.
 */
export const CLAUDE_HOST_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
const MODEL_ENV_RE = /^(?:zcode|opencode-go)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The Claude host as the composition root names it (orchestra app step 4): the repository's node.exe,
 * resolved at startup; host.mjs, the one argument; and the pin check (src/owned/claude-pins.ts), which
 * the gate runs again before every start: a host file or the SDK that changed since startup is refused
 * (host-tampered) without a child.
 */
export type ClaudeHostSite = { node: string; entry: string; verify(): string | null };

const REPO = win.join(import.meta.dirname, '..', '..');
/** The one file csc may compile. */
export const PROCGUARD_SOURCE = win.join(REPO, 'native', 'procguard', 'ProcGuard.cs');
/** The development build of procguard. */
export const PROCGUARD_BUILD_EXE = win.join(REPO, 'build', 'procguard.exe');
/**
 * The test suite's stand-in for codex.exe (test/fixtures/fake-codex-app-server.ts), run by node.exe:
 * the rule codex-app-server-fake allows exactly [this script]. It opens only under the test runner
 * (TEST_RUNNER_MARKER in the gate's env source) and only with a node.exe the caller names; the static
 * scan keeps the rule's name and that option out of every daemon module but this one.
 */
export const FAKE_CODEX_SCRIPT = win.join(REPO, 'test', 'fixtures', 'fake-codex-app-server.ts');
/** runtime/test-profile.ts's TEST_RUNNER_MARKER, restated: spawn.ts is in boot's pre-fence graph (spawn-codex.test holds the two equal). */
export const TEST_RUNNER_MARKER = 'NODE_TEST_CONTEXT';

export type CodexExe = { ok: true; path: string } | { ok: false; reason: 'appdata-unset' | 'appdata-bad-path' | 'missing' | 'reparsed'; detail?: string };

/** codex.exe below %APPDATA% of `env`, lexically: the path the gate pins, or why there is none. */
function codexExeOf(env: Readonly<Record<string, string | undefined>>): CodexExe {
  const appData = envGet(env, 'APPDATA');
  if (appData === undefined || appData.trim() === '') return { ok: false, reason: 'appdata-unset' };
  const c = checkPath(appData);
  if (!c.ok) return { ok: false, reason: 'appdata-bad-path', detail: c.reason };
  return { ok: true, path: win.join(c.path, CODEX_EXE_REL) };
}

/**
 * Where codex.exe is, for the composition root to decide at startup whether owned Codex sessions can
 * run at all: the pinned path below %APPDATA%, which must exist and be its own realpath (no junction).
 * Not found means the feature stays off, with this reason in the log and the console.
 */
export function resolveCodexExe(env: Readonly<Record<string, string | undefined>>, realpath: RealpathFn): CodexExe {
  const lexical = codexExeOf(env);
  if (!lexical.ok) return lexical;
  let real: string;
  try {
    real = realpath(lexical.path);
  } catch (e) {
    return { ok: false, reason: 'missing', detail: errCode(e) };
  }
  if (pathKey(real) !== pathKey(lexical.path)) return { ok: false, reason: 'reparsed', detail: real };
  return lexical;
}

export type SystemRootReason = 'unset' | 'bad-path' | 'not-top-level-dir' | 'windir-mismatch' | 'unresolved' | 'reparsed';
export type SystemRoot = { ok: true; path: string } | { ok: false; reason: SystemRootReason; detail?: string };
export type ProvenSystemRoot = Extract<SystemRoot, { ok: true }>;

// The ok results resolveSystemRoot handed out. A gate takes only one of these, never a look-alike
// object or a bare string, so its System32 went through every check below.
const PROVEN = new WeakSet<object>();

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

/**
 * %SystemRoot% from the injected environment. Windows sets it for every process from HKLM; changing
 * it takes control of our parent's environment, which is already the same user (r4 §10.11 #6). The
 * checks catch misconfiguration: a top-level directory of a drive, equal to %windir% when that is
 * set, resolving to itself (no junction). Anything else leaves every exe below it unresolved.
 */
export function resolveSystemRoot(env: Readonly<Record<string, string | undefined>>, realpath: RealpathFn): SystemRoot {
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

/** job: the Job a wrapped start made (procguard's --name), so run/pids.jsonl says which Job holds which session's tree. */
export type PidEntry = { at: string; rule: SpawnRule; exe: string; pid: number | null; job?: string; error?: string };

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

  /** Later lines stay in memory only; working mode calls this before it gives up the lock. */
  detach(): void {
    this.#sink = null;
    this.#onFailure = null;
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
frozenClass(PidLog);

/** The spawn options the gate itself chooses; callers never pass any. */
export type BackendOptions = {
  cwd: string;
  /** The rule's whitelist plus its fixed extras, built by the gate; the backend hands exactly this to the child. */
  env: Readonly<Record<string, string>>;
  windowsHide: true;
  shell: false;
  stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
};

export type ChildLike = Pick<ChildProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'on' | 'once' | 'kill'>;

export type SpawnBackend = (exe: string, argv: readonly string[], opts: BackendOptions) => ChildLike;

/**
 * What start() hands a caller: a frozen, null-prototype view of a long-lived child with no path back
 * to the raw ChildProcess or its stdio (the streams of a piped child are net.Socket objects whose
 * class reaches the whole outbound network). P8: a holder gets exactly these powers, not the object
 * behind them. The data and close callbacks receive Buffers; nothing exposes the socket itself.
 */
export type ProcHandle = {
  readonly pid: number | null;
  /** Writes to the child's stdin (a no-op when stdin is not piped). */
  write(data: Uint8Array | string): void;
  /** Closes the child's stdin. */
  end(): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number | null, signal: string | null) => void): void;
  /**
   * Hears a failure of the child or of one of its pipes, by error code: ENOENT or EACCES when the
   * exe vanished or was blocked between the gate's check and the spawn, EPIPE on a write to a dead
   * child's stdin. Each failure is handled here (the gate records the first in the pid log), so none
   * becomes an uncaught exception that ends orchestrad; a callback added late hears the last one.
   */
  onError(cb: (code: string) => void): void;
  kill(): void;
};

/** The ProcHandle's own keys, a fixed set; the measure in spawn.test.ts holds the handle to exactly these. */
export const HANDLE_KEYS: readonly string[] = Object.freeze(['pid', 'write', 'end', 'onStdout', 'onStderr', 'onClose', 'onError', 'kill']);

function toBuf(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
}

/**
 * Wraps a live child in a ProcHandle; the child itself stays captured here and never leaves. An
 * 'error' listener sits on the child and on each of its pipes from the start, so a spawn failure Node
 * reports asynchronously, or EPIPE on stdin, reaches `failed` (once) and the holder's onError, never
 * the uncaught-exception handler.
 */
function handleOf(child: ChildLike, failed: (code: string) => void): ProcHandle {
  const listeners: ((code: string) => void)[] = [];
  let last: string | null = null;
  const onFailure = (e: unknown) => {
    const code = errCode(e);
    if (last === null) failed(code);
    last = code;
    for (const cb of listeners) cb(code);
  };
  child.on('error', onFailure);
  for (const s of [child.stdin, child.stdout, child.stderr]) s?.on('error', onFailure);
  const h = Object.assign(Object.create(null) as ProcHandle, {
    pid: typeof child.pid === 'number' ? child.pid : null,
    write: (data: Uint8Array | string) => {
      child.stdin?.write(data);
    },
    end: () => {
      child.stdin?.end();
    },
    onStdout: (cb: (chunk: Buffer) => void) => {
      child.stdout?.on('data', (c: Buffer | string) => cb(toBuf(c)));
    },
    onStderr: (cb: (chunk: Buffer) => void) => {
      child.stderr?.on('data', (c: Buffer | string) => cb(toBuf(c)));
    },
    onClose: (cb: (code: number | null, signal: string | null) => void) => {
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => cb(code, signal === null ? null : String(signal)));
    },
    onError: (cb: (code: string) => void) => {
      listeners.push(cb);
      if (last !== null) cb(last);
    },
    kill: () => {
      child.kill();
    },
  });
  return Object.freeze(h);
}

export type SpawnRequest = {
  exe: string;
  argv: readonly string[];
  /**
   * The child's working directory, for a rule that takes one from its caller (CALLER_CWD: the codex rules
   * and claude-host), checked by the gate's CwdPolicy. Every other rule runs in its exe's directory and is
   * refused a cwd (`cwd-not-allowed`).
   */
  cwd?: string;
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
  | 'not-startable'
  | 'argv-mismatch'
  | 'out-path-denied'
  | 'exe-unresolved'
  | 'exe-reparsed'
  | 'cwd-not-allowed'
  | 'cwd-denied'
  | 'host-tampered'
  | 'procguard-tampered';

/** The rules that run as a long-lived child, the only ones start() may launch; run-only rules stay run(). */
const STARTABLE: readonly SpawnRule[] = ['procguard', 'powershell-toast', 'codex-app-server', 'codex-app-server-fake', 'claude-host', 'procguard-codex', 'procguard-codex-fake', 'procguard-claude'];
/** The rules that run in a cwd their caller names, checked by the gate's CwdPolicy; the rest run in their exe's directory. */
const CALLER_CWD: readonly SpawnRule[] = Object.freeze(['codex-app-server', 'codex-app-server-fake', 'claude-host']);

export type SpawnDecision =
  | { allow: true; rule: SpawnRule; exe: string; argv: readonly string[]; cwd: string; job?: string }
  | { allow: false; reason: SpawnDenyReason; exe: string; rule?: SpawnRule; detail?: string };

export class SpawnRefusedError extends Error {
  readonly code = 'ERR_ORCHESTRA_SPAWN';
  readonly decision: Extract<SpawnDecision, { allow: false }>;
  constructor(decision: Extract<SpawnDecision, { allow: false }>) {
    super(`[ERR_ORCHESTRA_SPAWN] spawn refused (${decision.reason}${decision.rule ? `, ${decision.rule}` : ''}): ${decision.exe}`);
    this.decision = decision;
  }
}
frozenClass(SpawnRefusedError);

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
  /** Required, no default: the real one is node-proc.ts's, handed in by its gate factory. */
  backend: SpawnBackend;
  realpath: RealpathFn;
  /** Required, no default: the hub the composition root holds. The gate mints its own Clock from it: pid entries read its wall clock, run() deadlines are its timers. */
  clock: ClockHub;
  /**
   * Required, no default: where the whitelisted variables' values come from (main.ts's `env`, which is
   * process.env in orchestrad). Read once, at construction; a later change to it reaches no child.
   */
  env: Readonly<Record<string, string | undefined>>;
  /** Fixed extras per rule, added after the whitelist; a name on the rule's whitelist or on ENV_NEVER is refused. */
  envExtra?: EnvExtra;
  /** Where a caller-chosen cwd may lie (CwdPolicy). Without it no rule may run in a caller's cwd. */
  cwd?: CwdPolicySpec;
  /**
   * Tests only: the node.exe that runs FAKE_CODEX_SCRIPT under the rule codex-app-server-fake. Refused
   * unless the env source carries TEST_RUNNER_MARKER; the static scan bans the name in daemon code.
   */
  fakeCodexNode?: string;
  /** The Claude host's node.exe, host.mjs and pin check; required when the rule claude-host (or procguard-claude) is on. */
  claudeHost?: ClaudeHostSite;
  /**
   * procguard.exe's pin check (src/os/procguard.ts: the sha256 of this startup's build, in memory), run before every
   * start of it, resident or wrapped: a procguard that changed since startup starts nothing
   * (procguard-tampered). Required when a wrapped rule is on.
   */
  procguardPin?: () => string | null;
  /** The --env-allowlist file of each wrapped rule, by its inner rule; required for every wrapped rule that is on. */
  procguardEnv?: Partial<Record<WrappableRule, string>>;
};

const CONFIG_KEYS = [
  'systemRoot', 'rules', 'csc', 'procguard', 'record', 'backend', 'realpath', 'clock', 'env', 'envExtra', 'cwd', 'fakeCodexNode', 'claudeHost', 'procguardPin', 'procguardEnv',
] as const;

/** timeoutMs is a positive integer (a Clock due time is whole milliseconds), at most 2^31 - 1. */
export type RunLimits = { timeoutMs: number; maxBytes: number };
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type RunResult =
  | { ok: true; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { ok: false; reason: 'refused'; decision: Extract<SpawnDecision, { allow: false }> }
  | { ok: false; reason: 'spawn-failed'; detail: string }
  | { ok: false; reason: 'timeout'; timeoutMs: number }
  | { ok: false; reason: 'output-too-large'; maxBytes: number }
  | { ok: false; reason: 'signal'; signal: string };

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * run() deadlines are numbered on the timer table of the gate's Clock (clock.ts tableSeq), across every
 * gate whose Clock shares it: a timerId is pending at most once per table, and boot's hub carries
 * main.ts's integrity gate and working.ts's gate at once, so gates numbering their own runs would both
 * arm `deadline:spawn-1:0` and the second schedule would be refused. Counting on the table, not on the
 * hub object a caller passed, keeps that true for a wrapper or a Proxy over one hub too. The same runs
 * on a fresh virtual clock get the same timerIds every time.
 */
const RUN_SEQ = 'spawn-run';

function mustPath(p: string, what: string): string {
  const c = checkPath(p);
  if (!c.ok) throw new Error(`spawn gate: ${what} rejected (${c.reason}): ${String(p)}`);
  return c.path;
}

function procguardExe(given: ProcguardSite): string {
  const site = ownFields(given as { at?: string; homeReal?: string; sourceHash?: string }, ['at', 'homeReal', 'sourceHash'] as const);
  if (site.at === 'build') return mustPath(PROCGUARD_BUILD_EXE, 'procguard build exe');
  if (site.at === 'runtime') {
    if (typeof site.sourceHash !== 'string' || !SOURCE_HASH.test(site.sourceHash)) {
      throw new Error(`spawn gate: procguard source hash must be 64 lowercase hex digits: ${String(site.sourceHash)}`);
    }
    return win.join(mustPath(site.homeReal as string, 'procguard data dir'), 'runtime', 'procguard', site.sourceHash, 'procguard.exe');
  }
  throw new Error('spawn gate: a procguard site is { at: "runtime", homeReal, sourceHash } or { at: "build" }');
}

type RequestCopy = { ok: true; exe: string; argv: readonly string[]; cwd: string | undefined; options: readonly [string, unknown][] } | { ok: false; exe: string };

/**
 * Reads each field of a caller-owned request exactly once and copies it, so a getter or a Proxy
 * cannot show the checks one vector and spawn another. Everything after this sees only the copy.
 */
function copyRequest(req: unknown): RequestCopy {
  if (typeof req !== 'object' || req === null) return { ok: false, exe: `<${req === null ? 'null' : typeof req}>` };
  let exe: unknown;
  let argv: unknown;
  let options: unknown;
  let cwd: unknown;
  try {
    // Own fields only, each read once: a field the caller did not set reads undefined, never one
    // some module put on Object.prototype (a poisoned `options` would otherwise refuse a bare whoami).
    const r = req as Record<string, unknown>;
    exe = Object.hasOwn(r, 'exe') ? r.exe : undefined;
    argv = Object.hasOwn(r, 'argv') ? r.argv : undefined;
    options = Object.hasOwn(r, 'options') ? r.options : undefined;
    cwd = Object.hasOwn(r, 'cwd') ? r.cwd : undefined;
  } catch {
    return { ok: false, exe: '<unreadable>' };
  }
  const exeText = typeof exe === 'string' ? exe : `<${exe === null ? 'null' : typeof exe}>`;
  try {
    if (typeof exe !== 'string' || !Array.isArray(argv)) return { ok: false, exe: exeText };
    const copy: unknown[] = Array.from(argv as unknown[]);
    if (!copy.every((a) => typeof a === 'string')) return { ok: false, exe: exeText };
    if (options !== undefined && (typeof options !== 'object' || options === null)) return { ok: false, exe: exeText };
    if (cwd !== undefined && typeof cwd !== 'string') return { ok: false, exe: exeText };
    const entries = options === undefined ? [] : Object.entries(options);
    return { ok: true, exe, argv: Object.freeze(copy as string[]), cwd, options: entries };
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
  readonly #clock: Clock;
  /** Each rule's child env, built once at construction. */
  readonly #env: ReadonlyMap<SpawnRule, Readonly<Record<string, string>>>;
  readonly #cwd: CwdPolicy | null;
  /** The Claude host's entry and pin check, when the rule claude-host is on. */
  readonly #claudeHost: { entry: string; verify(): string | null } | null;
  /** procguard.exe's pin check, when one was given (always, when a wrapped rule is on). */
  readonly #pgPin: (() => string | null) | null;
  /** Each wrapped rule's --env-allowlist file, by its inner rule. */
  readonly #pgEnv: ReadonlyMap<WrappableRule, string>;
  /** run() deadlines by timerId; the Clock fires into #expire, which looks the run up here. */
  readonly #deadlines = new Map<string, () => void>();

  constructor(config: SpawnGateConfig) {
    // Own fields only: an optional field the caller left out reads undefined, never Object.prototype's.
    const cfg = ownFields(config, CONFIG_KEYS);
    const sys = cfg.systemRoot;
    if (typeof sys !== 'object' || sys === null || !PROVEN.has(sys)) throw new Error('spawn gate: systemRoot must be the ok result of resolveSystemRoot()');
    if (typeof cfg.record !== 'function') throw new Error('spawn gate: record is required, every spawn lands in run/pids.jsonl');
    for (const k of ['backend', 'realpath'] as const) {
      if (typeof cfg[k] !== 'function') throw new Error(`spawn gate: ${k} is required, there is no default`);
    }
    const hub = cfg.clock;
    if (typeof hub !== 'object' || hub === null || typeof hub.port !== 'function') throw new Error('spawn gate: clock is required, there is no default');
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
    for (const r of cfg.rules!) if (!RULES.includes(r)) throw new Error(`spawn gate: unknown rule ${String(r)}`);
    this.#rules = new Set(cfg.rules);
    // A missing env source is refused below, after the checks that come before it.
    const envSource = typeof cfg.env === 'object' && cfg.env !== null ? cfg.env : {};
    // codex.exe below the source's %APPDATA%; known whenever APPDATA is there, so a request for it while
    // the rule is off reads rule-not-enabled, and enabling the rule without it refuses the gate.
    const codex = codexExeOf(envSource);
    if (codex.ok) add('codex-app-server', codex.path);
    else if (this.#rules.has('codex-app-server') || this.#rules.has('procguard-codex')) throw new Error(`spawn gate: codex-app-server enabled without codex.exe below %APPDATA% (${codex.reason})`);
    if (cfg.fakeCodexNode !== undefined) {
      if (envGet(envSource, TEST_RUNNER_MARKER) === undefined) throw new Error('spawn gate: the fake codex app-server runs only under the test runner');
      const node = mustPath(cfg.fakeCodexNode, 'fake codex node.exe');
      if (win.basename(node).toLowerCase() !== 'node.exe') throw new Error(`spawn gate: the fake codex app-server runs under node.exe, not ${node}`);
      add('codex-app-server-fake', node);
    } else if (this.#rules.has('codex-app-server-fake') || this.#rules.has('procguard-codex-fake')) {
      throw new Error('spawn gate: codex-app-server-fake enabled without fakeCodexNode');
    }
    let host: { entry: string; verify(): string | null } | null = null;
    if (cfg.claudeHost !== undefined) {
      const site = ownFields(cfg.claudeHost as ClaudeHostSite, ['node', 'entry', 'verify'] as const);
      const node = mustPath(site.node as string, 'claude host node.exe');
      if (win.basename(node).toLowerCase() !== 'node.exe') throw new Error(`spawn gate: the Claude host runs under node.exe, not ${node}`);
      const entry = mustPath(site.entry as string, 'claude host entry');
      if (win.basename(entry).toLowerCase() !== 'host.mjs') throw new Error(`spawn gate: the Claude host entry is host.mjs, not ${entry}`);
      if (typeof site.verify !== 'function') throw new Error('spawn gate: the Claude host needs its pin check (verify)');
      const verify = site.verify;
      add('claude-host', node);
      host = Object.freeze({ entry, verify: () => verify() });
    } else if (this.#rules.has('claude-host') || this.#rules.has('procguard-claude')) {
      throw new Error('spawn gate: claude-host enabled without its site (node.exe, host.mjs, the pin check)');
    }
    this.#claudeHost = host;
    const pin = cfg.procguardPin;
    if (pin !== undefined && typeof pin !== 'function') throw new Error('spawn gate: procguardPin must be a function');
    this.#pgPin = pin === undefined ? null : () => pin();
    const envFiles = ownFields(cfg.procguardEnv as Record<WrappableRule, unknown> | undefined, ['codex-app-server', 'codex-app-server-fake', 'claude-host'] as const);
    const pgEnv = new Map<WrappableRule, string>();
    for (const wrapped of Object.keys(WRAPPED_OF) as WrappedRule[]) {
      if (!this.#rules.has(wrapped)) continue;
      const inner = WRAPPED_OF[wrapped];
      if (pgDirs.size === 0) throw new Error(`spawn gate: ${wrapped} enabled without a procguard site`);
      if (this.#pgPin === null) throw new Error(`spawn gate: ${wrapped} enabled without procguard's pin check (procguardPin)`);
      const file = envFiles[inner];
      if (typeof file !== 'string') throw new Error(`spawn gate: ${wrapped} needs procguardEnv.${inner}, the --env-allowlist file`);
      pgEnv.set(inner, mustPath(file, `procguard env allowlist of ${inner}`));
    }
    this.#pgEnv = pgEnv;
    this.#exes = exes;
    if (this.#rules.has('powershell-toast') && TOAST_ENCODED === null) {
      throw new Error('spawn gate: powershell-toast needs the constant script of os/toast-script.ts, which arrives in step 17');
    }
    if (this.#rules.has('procguard') && pgDirs.size === 0) throw new Error('spawn gate: procguard enabled without a site');
    const outAllowed = ownFields(cfg.csc, ['outAllowed'] as const).outAllowed;
    this.#csc = typeof outAllowed === 'function' ? { outDirs: pgDirs, outAllowed } : null;
    if (this.#rules.has('csc') && (this.#csc === null || pgDirs.size === 0)) throw new Error('spawn gate: csc enabled without an /out: verdict and a procguard site to build into');
    const source = cfg.env;
    if (typeof source !== 'object' || source === null) throw new Error('spawn gate: env is required, there is no default');
    const extra = cfg.envExtra;
    if (extra !== undefined && (typeof extra !== 'object' || extra === null)) throw new Error('spawn gate: envExtra must be a record per rule');
    for (const k of extra === undefined ? [] : Object.keys(extra)) {
      if (!RULES.includes(k as SpawnRule)) throw new Error(`spawn gate: envExtra names an unknown rule ${k}`);
      if (isWrapped(k as SpawnRule)) throw new Error(`spawn gate: envExtra.${k}: a wrapped rule takes its inner rule's extras (envExtra.${WRAPPED_OF[k as WrappedRule]})`);
    }
    const extras = ownFields(extra, RULES);
    for (const rule of ['codex-app-server', 'codex-app-server-fake'] as const) {
      if (!this.#rules.has(rule) && !this.#rules.has(WRAP_OF[rule])) continue;
      const home = ownFields(extras[rule] as Record<string, unknown> | undefined, [CODEX_HOME_VAR] as const)[CODEX_HOME_VAR];
      if (typeof home !== 'string' || !checkPath(home).ok) throw new Error(`spawn gate: ${rule} needs envExtra.${rule}.${CODEX_HOME_VAR}, an absolute path (else codex.exe uses the user's own ~/.codex)`);
    }
    if (this.#rules.has('claude-host') || this.#rules.has('procguard-claude')) {
      const given = (extras['claude-host'] ?? {}) as Record<string, unknown>;
      const names = Object.keys(given);
      const value = (name: string) => given[names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? ''];
      for (const name of CLAUDE_HOST_REQUIRED_ENV) {
        if (typeof value(name) !== 'string' || (value(name) as string) === '') throw new Error(`spawn gate: claude-host needs envExtra.claude-host.${name}`);
      }
      const configDir = checkPath(value('CLAUDE_CONFIG_DIR') as string);
      if (!configDir.ok) throw new Error('spawn gate: claude-host needs CLAUDE_CONFIG_DIR, an absolute path (else claude.exe uses the user\'s own ~/.claude)');
      if (!CLAUDE_GATEWAY_RE.test(value('ANTHROPIC_BASE_URL') as string)) throw new Error(`spawn gate: claude-host's gateway must be http://127.0.0.1:<port>, got ${String(value('ANTHROPIC_BASE_URL'))}`);
      if (value('ANTHROPIC_AUTH_TOKEN') !== CLAUDE_GATEWAY_TOKEN) throw new Error('spawn gate: claude-host\'s ANTHROPIC_AUTH_TOKEN is the fixed gateway placeholder, never a key');
      if (!MODEL_ENV_RE.test(value('ANTHROPIC_SMALL_FAST_MODEL') as string)) throw new Error('spawn gate: claude-host\'s ANTHROPIC_SMALL_FAST_MODEL must be a zcode/ or opencode-go/ model');
      for (const name of CLAUDE_HOST_REFUSED_ENV) if (value(name) !== undefined) throw new Error(`spawn gate: envExtra.claude-host: ${name} is never handed to the Claude host`);
    }
    this.#env = new Map(RULES.map((rule) => [rule, ruleEnv(envRuleOf(rule), source, extras[envRuleOf(rule)])]));
    this.#cwd = cfg.cwd === undefined ? null : new CwdPolicy({ spec: cfg.cwd, env: source, systemRoot: sys.path, realpath: cfg.realpath! });
    this.#backend = cfg.backend!;
    this.#record = cfg.record;
    this.#realpath = cfg.realpath!;
    this.#clock = hub.port((f) => this.#expire(f));
    Object.freeze(this);
  }

  decide(req: SpawnRequest): SpawnDecision {
    return this.#decide(req);
  }

  #decide(req: SpawnRequest): SpawnDecision {
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
    if (known.rule === 'procguard' && r.argv[0] === RUN_IN_JOB) return this.#decideWrapped(r, known.exe, deny);
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
    if (rule === 'claude-host') {
      // The pins again, now: a host file or the SDK that changed since startup starts no child.
      let why: string | null;
      try {
        why = this.#claudeHost!.verify();
      } catch (e) {
        why = `verify failed: ${errCode(e)}`;
      }
      if (why !== null) return deny('host-tampered', { rule, detail: why });
    }
    if (rule === 'procguard') {
      const why = this.#pinWhy();
      if (why !== null) return deny('procguard-tampered', { rule, detail: why });
    }
    let cwd = win.dirname(known.exe);
    if (CALLER_CWD.includes(rule)) {
      if (r.cwd === undefined) return deny('cwd-not-allowed', { rule, detail: 'required' });
      if (this.#cwd === null) return deny('cwd-denied', { rule, detail: 'no-policy' });
      const v = this.#cwd.check(r.cwd);
      if (!v.ok) return deny('cwd-denied', { rule, detail: v.detail === undefined ? v.reason : `${v.reason}: ${v.detail}` });
      cwd = v.path;
    } else if (r.cwd !== undefined) {
      return deny('cwd-not-allowed', { rule });
    }
    return { allow: true, rule, exe: known.exe, argv: r.argv, cwd };
  }

  /** procguard.exe's pin check now: null when it holds (or none was given for a resident-only gate), else why not. */
  #pinWhy(): string | null {
    if (this.#pgPin === null) return null;
    try {
      return this.#pgPin();
    } catch (e) {
      return `verify failed: ${errCode(e)}`;
    }
  }

  /**
   * A wrapped start: procguard.exe run-in-job --name <job> --env-allowlist <file> -- <inner exe> <inner argv>.
   * The job must have PROCGUARD_JOB_RE's form, the file must be the one given for the inner rule, and the
   * inner exe and argv exactly what the inner rule allows; the wrapped rule (not the inner) must be on.
   * Then both exes must be their own realpath, the pins hold (the Claude host's, procguard's), and the cwd
   * is checked as the inner rule's would be.
   */
  #decideWrapped(r: Extract<RequestCopy, { ok: true }>, pgExe: string, deny: (reason: SpawnDenyReason, extra?: { rule?: SpawnRule; detail?: string }) => SpawnDecision): SpawnDecision {
    const a = r.argv;
    if (a.length < 7 || a[1] !== '--name' || a[3] !== '--env-allowlist' || a[5] !== '--') return deny('argv-mismatch', { rule: 'procguard' });
    const job = a[2]!;
    if (!PROCGUARD_JOB_RE.test(job)) return deny('argv-mismatch', { rule: 'procguard', detail: 'job name' });
    const ic = checkPath(a[6]!);
    if (!ic.ok || ic.path !== a[6]) return deny('argv-mismatch', { rule: 'procguard', detail: 'inner exe' });
    const inner = this.#exes.get(pathKey(ic.path));
    if (inner === undefined || !isWrappable(inner.rule)) return deny('argv-mismatch', { rule: 'procguard', detail: 'inner exe' });
    const rule = WRAP_OF[inner.rule];
    if (!this.#rules.has(rule)) return deny('rule-not-enabled', { rule });
    const file = this.#pgEnv.get(inner.rule);
    if (file === undefined || a[4] !== file) return deny('argv-mismatch', { rule, detail: 'env allowlist' });
    const innerWhy = this.#argvOk(inner.rule, a.slice(7));
    if (innerWhy !== null) return deny(innerWhy, { rule });
    for (const exe of [pgExe, inner.exe]) {
      let real: string;
      try {
        real = this.#realpath(exe);
      } catch (e) {
        return deny('exe-unresolved', { rule, detail: errCode(e) });
      }
      if (pathKey(real) !== pathKey(exe)) return deny('exe-reparsed', { rule, detail: real });
    }
    if (inner.rule === 'claude-host') {
      let why: string | null;
      try {
        why = this.#claudeHost!.verify();
      } catch (e) {
        why = `verify failed: ${errCode(e)}`;
      }
      if (why !== null) return deny('host-tampered', { rule, detail: why });
    }
    const pinWhy = this.#pinWhy();
    if (pinWhy !== null) return deny('procguard-tampered', { rule, detail: pinWhy });
    if (r.cwd === undefined) return deny('cwd-not-allowed', { rule, detail: 'required' });
    if (this.#cwd === null) return deny('cwd-denied', { rule, detail: 'no-policy' });
    const v = this.#cwd.check(r.cwd);
    if (!v.ok) return deny('cwd-denied', { rule, detail: v.detail === undefined ? v.reason : `${v.reason}: ${v.detail}` });
    return { allow: true, rule, exe: pgExe, argv: r.argv, cwd: v.path, job };
  }

  /**
   * The --env-allowlist a wrapped rule's procguard reads: the names of the environment the gate hands its
   * inner rule, then the names libuv adds on Windows (LIBUV_ADDED_ENV) when they are missing. procguard
   * copies each from its own environment, which is the gate's with libuv's additions: the child gets the
   * very environment the gate gave it when it started it directly, and no value is ever written to disk.
   */
  envAllowlist(rule: WrappableRule): string {
    const names = Object.keys(this.#env.get(rule) ?? {});
    for (const n of LIBUV_ADDED_ENV) if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    return `# procguard --env-allowlist for ${rule} (src/os/spawn.ts SpawnGate.envAllowlist): names only, values come from procguard's own environment.\n${names.join('\n')}\n`;
  }

  #argvOk(rule: SpawnRule, argv: readonly string[]): SpawnDenyReason | null {
    switch (rule) {
      case 'whoami':
        return sameArgv(argv, WHOAMI_ARGV) ? null : 'argv-mismatch';
      case 'powershell-toast':
        return TOAST_ENCODED !== null && argv.length === TOAST_FLAGS.length + 1 && sameArgv(argv.slice(0, -1), TOAST_FLAGS) && argv.at(-1) === TOAST_ENCODED
          ? null
          : 'argv-mismatch';
      case 'codex-app-server':
        return sameArgv(argv, CODEX_APP_SERVER_ARGV) ? null : 'argv-mismatch';
      case 'codex-app-server-fake':
        return argv.length === 1 && argv[0] === FAKE_CODEX_SCRIPT ? null : 'argv-mismatch';
      case 'claude-host':
        return argv.length === 1 && argv[0] === this.#claudeHost!.entry ? null : 'argv-mismatch';
      case 'procguard-codex':
      case 'procguard-codex-fake':
      case 'procguard-claude':
        // Decided whole in #decideWrapped; never by the plain path.
        return 'argv-mismatch';
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
    const at = new Date(this.#clock.nowWall()).toISOString();
    let child: ChildLike;
    try {
      child = this.#backend(d.exe, d.argv, { cwd: d.cwd, env: this.#env.get(d.rule)!, windowsHide: true, shell: false, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (e) {
      this.#record({ at, rule: d.rule, exe: d.exe, pid: null, ...(d.job === undefined ? {} : { job: d.job }), error: errCode(e) });
      throw e;
    }
    this.#record({ at, rule: d.rule, exe: d.exe, pid: typeof child.pid === 'number' ? child.pid : null, ...(d.job === undefined ? {} : { job: d.job }) });
    return child;
  }

  /**
   * A long-lived child (toast worker, procguard) with stdin, stdout and stderr piped, handed back as
   * a ProcHandle that holds no path to the raw ChildProcess or its sockets. Only the long-lived rules
   * may be started; a run-only rule (whoami, csc) is refused here, so a module handed such a gate
   * cannot reach a live ChildProcess through start() (P8).
   */
  start(req: SpawnRequest): ProcHandle {
    const d = this.#decide(req);
    if (!d.allow) throw new SpawnRefusedError(d);
    if (!STARTABLE.includes(d.rule)) throw new SpawnRefusedError({ allow: false, reason: 'not-startable', exe: d.exe, rule: d.rule });
    const child = this.#spawn(d, 'pipe');
    const pid = typeof child.pid === 'number' ? child.pid : null;
    return handleOf(child, (code) => this.#record({ at: new Date(this.#clock.nowWall()).toISOString(), rule: d.rule, exe: d.exe, pid, error: code }));
  }

  /**
   * Runs to completion and collects the output; past the time or size limit the child is killed. The
   * time limit is a deadline timer of the gate's Clock (`deadline:spawn-<n>:0`, n counting the runs on
   * its timer table, RUN_SEQ), so a virtual clock drives it in tests exactly as the real one does in
   * orchestrad. The deadline is armed before the child starts: a schedule the Clock refuses (its timerId
   * already pending, armed by some other code on the same table) or a Clock that clock.ts did not make
   * ends the run as spawn-failed with no child started, never with one left running without a deadline.
   */
  run(req: SpawnRequest, given: RunLimits): Promise<RunResult> {
    const { timeoutMs, maxBytes } = ownFields(given, ['timeoutMs', 'maxBytes'] as const);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs! <= 0 || timeoutMs! > MAX_TIMEOUT_MS) throw new Error('spawn gate: run limits need timeoutMs, a positive integer of milliseconds up to 2^31 - 1');
    if (!Number.isSafeInteger(maxBytes) || maxBytes! < 0) throw new Error('spawn gate: run limits need maxBytes, a non-negative integer');
    const limits: RunLimits = { timeoutMs: timeoutMs!, maxBytes: maxBytes! };
    const d = this.#decide(req);
    if (!d.allow) return Promise.resolve({ ok: false, reason: 'refused', decision: d });
    let id: string;
    try {
      id = `deadline:spawn-${tableSeq(this.#clock, RUN_SEQ)}:0`;
      this.#clock.schedule({ timerId: id, class: 'deadline', clock: 'mono', due: this.#clock.nowMono() + limits.timeoutMs });
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'spawn-failed', detail: errCode(e) });
    }
    // A Clock fires only from a later tick, never inside schedule(), so collect() hands over its
    // onTimeout before the deadline can come.
    let onTimeout: (() => void) | null = null;
    this.#deadlines.set(id, () => onTimeout?.());
    const deadline: Deadline = {
      arm: (f) => {
        onTimeout = f;
      },
      disarm: () => {
        this.#deadlines.delete(id);
        this.#clock.cancel(id);
      },
    };
    let child: ChildLike;
    try {
      child = this.#spawn(d, 'ignore');
    } catch (e) {
      deadline.disarm();
      return Promise.resolve({ ok: false, reason: 'spawn-failed', detail: errCode(e) });
    }
    return collect(child, limits, deadline);
  }

  #expire(f: Fired): void {
    const onTimeout = this.#deadlines.get(f.timerId);
    this.#deadlines.delete(f.timerId);
    onTimeout?.();
  }
}

// The prototype and every instance are frozen: a module holding a SpawnGate (or the class) can neither
// replace a method every holder calls nor change an instance's fields or prototype, and the gate's
// own paths call only its private members, so a subclass cannot steer them either.
frozenClass(SpawnGate);

/** A run's deadline, already scheduled by run(): arm() hands it what to do when it fires, disarm() cancels it. */
type Deadline = { arm(onTimeout: () => void): void; disarm(): void };

function collect(child: ChildLike, limits: RunLimits, deadline: Deadline): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let stop: 'timeout' | 'output-too-large' | null = null;
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      deadline.disarm();
      resolve(r);
    };
    const halt = (why: 'timeout' | 'output-too-large') => {
      if (stop !== null) return;
      stop = why;
      child.kill();
    };
    deadline.arm(() => halt('timeout'));
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
