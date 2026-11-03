import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { After } from './owned-proc.ts';
import type { ProcHandle, RunResult } from './spawn.ts';
import { PROCGUARD_JOB_RE } from './spawn.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

const win = path.win32;

// procguard for the owned sessions (r4 D4: every owned child tree in a Job of its own that dies when it
// closes, started through procguard; orchestra app: owned sessions in procguard Jobs). Three parts:
//
//  - the build: native/procguard/ProcGuard.cs, held to its pinned sha256 (procguard-pins.ts), compiled by
//    the system csc.exe only (the spawn gate's rule csc, its fixed flags) into
//    ORCHESTRA_HOME\runtime\procguard\<source sha256>\procguard.exe. The old csc has no /deterministic,
//    so the exe cannot be pinned in the repository: its sha256 is written next to it when it is built
//    (procguard.exe.sha256) and the exe is held to that at every startup and before every start of it
//    (the spawn gate's procguardPin). An exe that does not match is tampered: the owned sessions stay
//    off (T1, with the reason). A source that does not match its pin is never built: no Job, no brake,
//    and the page says why.
//  - the Jobs: each owned session's child starts as procguard.exe run-in-job --name <job> ... -- <exe>
//    (the spawn gate's wrapped rules). Its whole tree lives in that Job; when the wrapper ends, however
//    it ends, the Job's last handle closes and everything in it dies (KILL_ON_JOB_CLOSE).
//  - the resident procguard (one per orchestrad, rule procguard): it opens a Job by name to say what is
//    in it (job-info) or to end everything in it now and count what is left (kill-job): the brake, and
//    the check after a session's end. It exits when orchestrad does (stdin EOF).

/** The files of one procguard site, ORCHESTRA_HOME\runtime\procguard\<source sha256>\. */
export const PROCGUARD_FILES = frozen({
  exe: 'procguard.exe',
  /** The sha256 of procguard.exe as it was built, one line of hex. */
  pin: 'procguard.exe.sha256',
  /** What csc writes before it is checked and moved into place. */
  build: 'procguard.new.exe',
});

/** The --env-allowlist file of a wrapped rule's inner rule, in the site dir. */
export const envAllowlistFile = (dir: string, inner: string): string => win.join(dir, `env-${inner}.txt`);

/** A fresh Job name: 128 random bits from node:crypto, of PROCGUARD_JOB_RE's form. */
export function newJobName(): string {
  return `orchestra-job-${crypto.randomBytes(16).toString('hex')}`;
}

export const sha256 = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

/** Why the owned sessions run without Jobs, or are off (tampered), as GET /api/owned's brakeWhy names it. */
export type ProcguardOffWhy = 'not-asked' | 'procguard-source-unpinned' | 'procguard-build-failed' | 'procguard-tampered' | 'procguard-start-failed' | 'procguard-setup-failed';

export type ProcguardSite =
  | { ok: true; dir: string; exe: string; sha256: string; built: boolean }
  | { ok: false; why: Exclude<ProcguardOffWhy, 'not-asked' | 'procguard-start-failed'>; detail: string };

export type ProcguardBuildDeps = {
  /** ORCHESTRA_HOME\runtime\procguard\<sourceHash>. */
  dir: string;
  /** The pinned sha256 of native/procguard/ProcGuard.cs (procguard-pins.ts). */
  sourceHash: string;
  /** The source's bytes, through a read gate pinned on it. */
  readSource(): Uint8Array;
  /** A file of the site through the read gate; throws when it is not there (code ENOENT, or the read gate's not-found). */
  readFile(file: string): Uint8Array;
  mkdirp(dir: string): void;
  writeAtomic(file: string, data: string | Uint8Array): void;
  rm(file: string): void;
  /** The spawn gate's csc run with /out:<out> and the pinned source. */
  runCsc(out: string): Promise<RunResult>;
};

const codeOf = (e: unknown): string => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Not there: ENOENT from the file system, or the read gate's not-found (src/fs/read-gate.ts ReadGateError). */
const missing = (e: unknown): boolean => codeOf(e) === 'ENOENT'
  || (typeof e === 'object' && e !== null && 'decision' in e && (e as { decision?: { reason?: unknown } }).decision?.reason === 'not-found');

/** A file's bytes, or null when it is not there; any other failure throws. */
function maybe(read: () => Uint8Array): Uint8Array | null {
  try {
    return read();
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** csc's own words, at most a few lines, for the log (they name no secret: the source is ours). */
function cscSaid(r: RunResult): string {
  if (r.ok) return `exit code ${r.exitCode}: ${Buffer.concat([r.stdout, r.stderr]).toString('latin1').replace(/\s+/g, ' ').trim().slice(0, 400)}`;
  return r.reason === 'refused' ? `refused (${r.decision.reason})` : r.reason === 'spawn-failed' ? `spawn failed (${r.detail})` : r.reason;
}

/**
 * The procguard site, built when it is not there: the source held to its pin, an exe and its recorded
 * sha256 that match (used as is), or a new build (csc to procguard.new.exe, its sha256 written, then the
 * exe moved into place). An exe whose recorded sha256 it does not match is tampered and never replaced
 * here: a person deletes the site dir to have it built again.
 */
export async function ensureProcguard(d: ProcguardBuildDeps): Promise<ProcguardSite> {
  const exe = win.join(d.dir, PROCGUARD_FILES.exe);
  const pinFile = win.join(d.dir, PROCGUARD_FILES.pin);
  const out = win.join(d.dir, PROCGUARD_FILES.build);
  let source: Uint8Array;
  try {
    source = d.readSource();
  } catch (e) {
    return { ok: false, why: 'procguard-source-unpinned', detail: `source unreadable: ${codeOf(e)}` };
  }
  const got = sha256(source);
  if (got !== d.sourceHash) return { ok: false, why: 'procguard-source-unpinned', detail: `ProcGuard.cs is ${got}, pinned ${d.sourceHash} (run scripts/pin-procguard.ts after a reviewed change)` };
  try {
    d.mkdirp(d.dir);
    const have = maybe(() => d.readFile(exe));
    const pinned = maybe(() => d.readFile(pinFile));
    if (have !== null && pinned !== null) {
      const want = Buffer.from(pinned).toString('latin1').trim();
      const now = sha256(have);
      if (HEX64.test(want) && now === want) return { ok: true, dir: d.dir, exe, sha256: now, built: false };
      return { ok: false, why: 'procguard-tampered', detail: `${PROCGUARD_FILES.exe} is ${now}, built as ${HEX64.test(want) ? want : 'an unreadable pin'}; delete ${d.dir} to have it built again` };
    }
    if (maybe(() => d.readFile(out)) !== null) d.rm(out);
    const r = await d.runCsc(out);
    if (!r.ok || r.exitCode !== 0) return { ok: false, why: 'procguard-build-failed', detail: cscSaid(r) };
    const bytes = maybe(() => d.readFile(out));
    if (bytes === null || bytes.length === 0) return { ok: false, why: 'procguard-build-failed', detail: 'csc wrote no exe' };
    const hash = sha256(bytes);
    d.writeAtomic(pinFile, `${hash}\n`);
    d.writeAtomic(exe, bytes);
    d.rm(out);
    return { ok: true, dir: d.dir, exe, sha256: hash, built: true };
  } catch (e) {
    return { ok: false, why: 'procguard-setup-failed', detail: errText(e) };
  }
}

/** The pin check the spawn gate runs before every start of procguard.exe: null when it still is what was built. */
export function procguardPin(readFile: (file: string) => Uint8Array, exe: string, want: string): () => string | null {
  return () => {
    let now: string;
    try {
      now = sha256(readFile(exe));
    } catch (e) {
      return `${PROCGUARD_FILES.exe} unreadable: ${codeOf(e)}`;
    }
    return now === want ? null : `${PROCGUARD_FILES.exe} is ${now}, built as ${want}`;
  };
}

// --- the resident procguard ----------------------------------------------------------------------------

export const PROCGUARD_LIMITS = frozen({
  /** The longest the resident may take to say ready (a .NET start on a loaded machine took up to 0.97 s in S4). */
  readyMs: 15_000,
  /** The longest one command may take before its caller hears procguard-timeout. */
  commandMs: 5_000,
  /** How long kill-job waits for the Job to count no process (procguard caps it at 10 s). */
  killWaitMs: 3_000,
  /** One line of the resident's, at most (a Job's member list is the longest). */
  lineBytes: 1024 * 1024,
});

/** A process in a Job: its pid, its creation time (a FILETIME, decimal), its image name; null where procguard could not open it. */
export type JobProc = { readonly pid: number; readonly createTime: string | null; readonly image: string | null };
export type JobInfo = { readonly found: false } | { readonly found: true; readonly active: number; readonly total: number; readonly procs: readonly JobProc[] };
/** found false: no Job of that name (any more): nothing of it runs. before, after: the active processes when it came, and after the kill and the wait. */
export type JobKill = { readonly found: false } | { readonly found: true; readonly before: number; readonly after: number; readonly procs: readonly JobProc[] };

export class ProcguardError extends Error {
  readonly code = 'ERR_ORCHESTRA_PROCGUARD';
  /** timeout: no answer in time; gone: the resident is not running; refused: it answered with an error. */
  readonly reason: 'timeout' | 'gone' | 'refused';
  constructor(reason: 'timeout' | 'gone' | 'refused', message: string) {
    super(`[ERR_ORCHESTRA_PROCGUARD] ${reason}: ${message}`);
    this.reason = reason;
  }
}

frozenClass(ProcguardError);

export type Resident = {
  /** Settles true once the resident said ready, false when it never did (or went away first). */
  readonly ready: Promise<boolean>;
  /** Whether it runs and said ready. */
  readonly up: boolean;
  jobInfo(name: string): Promise<JobInfo>;
  killJob(name: string, waitMs?: number): Promise<JobKill>;
  /** Which of the given processes still run, as `pid:createTime` (by identity, never by pid alone). */
  alive(procs: readonly { pid: number; createTime: string }[]): Promise<string[]>;
  /** Closes its stdin: it exits on EOF. */
  stop(): void;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

function procsOf(v: unknown): JobProc[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((p) => Object.freeze({
    pid: count(p.pid) ?? 0,
    createTime: typeof p.createTime === 'string' && /^\d{1,20}$/.test(p.createTime) ? p.createTime : null,
    image: typeof p.image === 'string' && p.image.length <= 260 ? p.image : null,
  }));
}

/**
 * The client of a resident procguard the spawn gate started (rule procguard, no argv): one JSON command
 * per line, answers matched by id, each with a deadline on the caller's Clock (`after`).
 */
export function residentOf(h: ProcHandle, after: After, limits: { readyMs?: number; commandMs?: number } = {}): Resident {
  const readyMs = limits.readyMs ?? PROCGUARD_LIMITS.readyMs;
  const commandMs = limits.commandMs ?? PROCGUARD_LIMITS.commandMs;
  let up = false;
  let gone = false;
  let seq = 0;
  let tail = '';
  const waiting = new Map<number, { resolve(v: Obj): void; reject(e: Error): void; cancel(): void }>();
  let settleReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => {
    settleReady = r;
  });
  const cancelReady = after(readyMs, () => settleReady(false));
  const end = () => {
    if (gone) return;
    gone = true;
    up = false;
    cancelReady();
    settleReady(false);
    for (const w of waiting.values()) {
      w.cancel();
      w.reject(new ProcguardError('gone', 'procguard is not running'));
    }
    waiting.clear();
  };
  const line = (text: string) => {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (m.event === 'ready') {
      up = true;
      cancelReady();
      settleReady(true);
      return;
    }
    const id = count(m.id);
    const w = id === null ? undefined : waiting.get(id);
    if (w === undefined || id === null) return;
    waiting.delete(id);
    w.cancel();
    if (m.ok === true) w.resolve(m);
    else w.reject(new ProcguardError('refused', typeof m.error === 'string' ? `${m.error}${typeof m.message === 'string' ? `: ${m.message}` : ''}` : 'no reason'));
  };
  h.onStdout((chunk) => {
    tail += chunk.toString('utf8');
    if (tail.length > PROCGUARD_LIMITS.lineBytes) tail = '';
    let i: number;
    while ((i = tail.indexOf('\n')) >= 0) {
      const one = tail.slice(0, i).trim();
      tail = tail.slice(i + 1);
      if (one !== '') line(one);
    }
  });
  h.onStderr(() => {});
  h.onClose(() => end());
  h.onError(() => end());
  const send = (cmd: Obj): Promise<Obj> => {
    if (gone) return Promise.reject(new ProcguardError('gone', 'procguard is not running'));
    const id = ++seq;
    return new Promise<Obj>((resolve, reject) => {
      const cancel = after(commandMs, () => {
        if (!waiting.delete(id)) return;
        reject(new ProcguardError('timeout', `${String(cmd.cmd)} had no answer within ${commandMs} ms`));
      });
      waiting.set(id, { resolve, reject, cancel });
      try {
        h.write(`${JSON.stringify({ id, ...cmd })}\n`);
      } catch (e) {
        waiting.delete(id);
        cancel();
        reject(new ProcguardError('gone', errText(e)));
      }
    });
  };
  const named = (name: string) => {
    if (!PROCGUARD_JOB_RE.test(name)) throw new ProcguardError('refused', 'not a job name');
    return name;
  };
  return Object.freeze({
    ready,
    get up() {
      return up && !gone;
    },
    jobInfo: async (name: string): Promise<JobInfo> => {
      const r = await send({ cmd: 'job-info', name: named(name) });
      if (r.found !== true) return Object.freeze({ found: false as const });
      return Object.freeze({ found: true as const, active: count(r.activeProcesses) ?? 0, total: count(r.totalProcesses) ?? 0, procs: Object.freeze(procsOf(r.procs)) });
    },
    killJob: async (name: string, waitMs: number = PROCGUARD_LIMITS.killWaitMs): Promise<JobKill> => {
      const r = await send({ cmd: 'kill-job', name: named(name), waitMs });
      if (r.found !== true) return Object.freeze({ found: false as const });
      const before = count(r.before);
      const left = count(r.after);
      if (before === null || left === null) throw new ProcguardError('refused', 'kill-job answered without its counts');
      return Object.freeze({ found: true as const, before, after: left, procs: Object.freeze(procsOf(r.procs)) });
    },
    alive: async (procs: readonly { pid: number; createTime: string }[]): Promise<string[]> => {
      const r = await send({ cmd: 'alive', procs: procs.map((p) => ({ pid: p.pid, createTime: p.createTime })) });
      return Array.isArray(r.alive) ? r.alive.filter((x): x is string => typeof x === 'string') : [];
    },
    stop: () => {
      try {
        h.end();
      } catch {
        // Gone already.
      }
    },
  });
}

// --- one owned session's Job -----------------------------------------------------------------------------

/**
 * What became of a Job when it was ended: ok with found false (no Job of that name any more: nothing of
 * it runs), ok with the processes it held when the kill came and how many were left after the wait (0:
 * the whole tree stopped), or not ok with why the resident could not say (T1: unknown, never "none left").
 */
export type JobOutcome = { readonly ok: true; readonly found: boolean; readonly killed: number; readonly left: number } | { readonly ok: false; readonly why: string };

/** An owned session's Job, as its driver holds it (src/owned/): its name and the kill. */
export type OwnedJob = {
  readonly name: string;
  /** Ends every process in the Job now and waits until none is left (the brake; and the check after an end). */
  endTree(): Promise<JobOutcome>;
};

/** The Job named `name`, killed through the resident procguard (null: none runs, so every kill is unknown). */
export function ownedJob(name: string, resident: Resident | null): OwnedJob {
  if (!PROCGUARD_JOB_RE.test(name)) throw new Error(`procguard: not a job name: ${name}`);
  return Object.freeze({
    name,
    endTree: async (): Promise<JobOutcome> => {
      if (resident === null || !resident.up) return Object.freeze({ ok: false as const, why: 'procguard-not-running' });
      try {
        const r = await resident.killJob(name);
        return Object.freeze(r.found ? { ok: true as const, found: true, killed: r.before, left: r.after } : { ok: true as const, found: false, killed: 0, left: 0 });
      } catch (e) {
        return Object.freeze({ ok: false as const, why: e instanceof ProcguardError ? `procguard-${e.reason}` : 'procguard-failed' });
      }
    },
  });
}
