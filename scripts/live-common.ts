// What the live runs (scripts/live-smoke.ts, scripts/live-route.ts) share for talking to orchestrad and
// for leaving nothing behind (orchestra app plan, phase 3 review): an HTTP request with a deadline, so a
// reply that never comes cannot hang a run (and keep orchestrad, a host, claude.exe or codex.exe alive);
// the end of an owned session waited out through the stop order; orchestrad itself stopped by closing its
// stdin (stopDaemon: it then runs its own stop, as on Ctrl+C), and killed only when that does not end it in
// time (a kill on Windows is TerminateProcess: orchestrad's own stop never runs); and a look at the children orchestrad
// recorded (run/pids.jsonl of the test dir) once it is gone. A pid alone never proves a process is ours
// (Windows reuses pids quickly; r4 D4 asks for pid + creation time and refuses taskkill /T as a reaper:
// phase 4 review): a wrapped start's tree is ended through its Job, by the Job's name, with the script's
// own procguard; a start without a Job that still runs under its rule's image is only counted
// (unverified), never ended. With procguard on, a session's whole tree is in its Job: jobsOf and probe
// read the Jobs orchestrad made and what is in them (by pid + creation time). The script's procguard is
// the exe orchestrad built in the test dir, held first to the sha256 orchestrad logged for it.
//
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts), as the two scripts that use it: it speaks HTTP to
// orchestrad on 127.0.0.1, waits on timers, reads the pid log and the log of a test dir and ends the Jobs
// orchestrad made there.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

/** Longest any one request to orchestrad may take. */
export const REQUEST_MS = 30_000;
/** The Claude host's stop order (src/os/owned-proc.ts HOST_STOP_MS: 3 s + 2 s) and a margin. */
export const STOP_ORDER_MS = 5_500;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; json: any };

export function request(port: number, host: string, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          if ((res.headers['content-type'] ?? '').startsWith('application/json')) json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_MS, () => req.destroy(new Error(`live: ${method} ${pathname} had no answer within ${REQUEST_MS / 1000} s`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Ends an owned session and waits until the list says it ended or failed (at most `ms`), then the whole
 * stop order: only then is orchestrad killed. Never throws: what happened is the result.
 */
export async function endAndWait(end: () => Promise<Reply>, state: () => Promise<string | null>, ms = 15_000): Promise<{ endAnswer: number | null; settled: string | null }> {
  let endAnswer: number | null = null;
  try {
    endAnswer = (await end()).status;
  } catch {
    endAnswer = null;
  }
  let settled: string | null = null;
  for (let waited = 0; waited < ms; waited += 500) {
    try {
      settled = await state();
    } catch {
      settled = null;
    }
    if (settled === 'ended' || settled === 'failed') break;
    await sleep(500);
  }
  await sleep(STOP_ORDER_MS);
  return { endAnswer, settled };
}

/**
 * How long orchestrad may take to stop once its stdin closed: its own wait for the Claude hosts' stop order
 * (src/runtime/working.ts OWNED_STOP_WAIT_MS, 6 s), the store and the console, and a margin.
 */
export const DAEMON_STOP_MS = 15_000;

/**
 * Stops orchestrad the way a parent that goes away does: its stdin (a pipe) is closed, and orchestrad runs
 * the same stop as Ctrl+C (src/runtime/stdin-end.ts): owned sessions end with daemon-stop, their Jobs close,
 * the store closes, it exits 0. Only when it has not exited within `ms` is it killed (a kill on Windows is
 * TerminateProcess: no stop of its own runs). Says which of the two it took and the exit code.
 */
export async function stopDaemon(child: { stdin: { end(): unknown } | null; kill(): boolean }, exited: Promise<number | null>, ms = DAEMON_STOP_MS): Promise<{ how: 'stdin-eof' | 'killed'; code: number | null }> {
  child.stdin?.end();
  const timeout = Symbol('timeout');
  const first = await Promise.race([exited, sleep(ms).then(() => timeout)]);
  if (first !== timeout) return { how: 'stdin-eof', code: first as number | null };
  child.kill();
  const code = await Promise.race([exited, sleep(5000).then(() => null)]);
  return { how: 'killed', code };
}

/** The end reason orchestrad wrote for an owned session (ORCHESTRA_HOME\owned\<id>.json in the test dir), or null when there is none. */
export function endReasonOnDisk(testDir: string, ownedId: string): { state: string | null; endReason: string | null } | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(testDir, 'orchestra', 'owned', `${ownedId}.json`), 'utf8')) as { state?: unknown; endReason?: unknown };
    return { state: typeof o.state === 'string' ? o.state : null, endReason: typeof o.endReason === 'string' ? o.endReason : null };
  } catch {
    return null;
  }
}

/** What the record on disk counts of each sub-agent of a session, or null when it cannot be read. Never a name. */
export function membersOnDisk(testDir: string, ownedId: string): { failed: number; ranUnasked: number }[] | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(testDir, 'orchestra', 'owned', `${ownedId}.json`), 'utf8')) as { members?: { failed: number; ranUnasked: number }[] };
    return o.members === undefined ? null : o.members.map((m) => ({ failed: m.failed, ranUnasked: m.ranUnasked }));
  } catch {
    return null;
  }
}

/** The image a start without a Job runs under: only ever counted, never ended by its pid (see leftovers). */
const IMAGE: Readonly<Record<string, string>> = { 'claude-host': 'node.exe', 'codex-app-server': 'codex.exe', procguard: 'procguard.exe' };

type PidLine = { rule: string; pid: number | null; job: string | null };
const JOB_RE = /^orchestra-job-[0-9a-f]{32}$/;

/** The test dir's run/pids.jsonl, line by line (a torn line is skipped). */
function pidLines(testDir: string): PidLine[] {
  const file = path.join(testDir, 'orchestra', 'run', 'pids.jsonl');
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    lines = [];
  }
  const out: PidLine[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { rule?: unknown; pid?: unknown; job?: unknown };
      if (typeof e.rule !== 'string') continue;
      const pid = typeof e.pid === 'number' && Number.isSafeInteger(e.pid) && e.pid > 0 ? e.pid : null;
      out.push({ rule: e.rule, pid, job: typeof e.job === 'string' && JOB_RE.test(e.job) ? e.job : null });
    } catch {
      // A torn line: nothing to find in it.
    }
  }
  return out;
}

/** The image name of a running pid (tasklist), or null when none runs under it. */
function imageOf(pid: number): string | null {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const m = /^"([^"]+)","(\d+)"/m.exec(out);
    return m !== null && Number(m[2]) === pid ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type Leftovers = {
  /** Starts orchestrad recorded (run/pids.jsonl lines with a pid). */
  recorded: number;
  /** The Jobs its wrapped starts made. */
  jobs: number;
  /** Processes found still running: those still in a Job, plus the unverified ones. */
  leftover: number;
  /** Of those in a Job, how many its kill-job ended. */
  ended: number;
  /** A start without a Job whose pid runs under its rule's image now: maybe ours, maybe a reused pid. Counted, never ended. */
  unverified: number;
  /** A start without a Job whose pid runs under another image: someone else's (pids are reused). */
  otherImage: number;
  /** Jobs nobody could look into (no verified procguard, or no answer): unknown, never "none left" (T1). */
  unchecked: number;
  /** Why the script had no procguard of its own, or null. */
  probe: string | null;
};

/**
 * After orchestrad is gone: what is left of the children it recorded. A wrapped start's tree is ended
 * through its Job, by the Job's name (128 random bits orchestrad gave it; no pid involved), with the
 * script's own procguard, and counted (before, and what the kill ended). A start without a Job (the
 * resident procguard; codex.exe or node.exe started without procguard) is only looked up by pid: one that
 * runs under its rule's image is counted as unverified and left alone, since a pid alone cannot prove it
 * is ours (no taskkill, no /T: phase 4 review, r4 D4).
 */
export async function leftovers(testDir: string): Promise<Leftovers> {
  const lines = pidLines(testDir);
  const jobs = [...new Set(lines.flatMap((l) => (l.job === null ? [] : [l.job])))];
  let leftover = 0;
  let ended = 0;
  let unverified = 0;
  let otherImage = 0;
  let unchecked = 0;
  let why: string | null = null;
  if (jobs.length > 0) {
    const p = probeOf(testDir);
    why = p.why;
    if (p.pg === null) {
      unchecked = jobs.length;
    } else {
      try {
        for (const job of jobs) {
          try {
            const k = await p.pg.kill(job);
            if (!k.found) continue;
            if (k.before === null || k.after === null) {
              unchecked++;
              continue;
            }
            leftover += k.before;
            ended += k.before - k.after;
          } catch {
            unchecked++;
          }
        }
      } finally {
        p.pg.close();
      }
    }
  }
  const seen = new Set<number>();
  for (const l of lines) {
    if (l.job !== null || l.pid === null || !Object.hasOwn(IMAGE, l.rule) || seen.has(l.pid)) continue;
    seen.add(l.pid);
    const image = imageOf(l.pid);
    if (image === null) continue;
    if (image === IMAGE[l.rule]) {
      unverified++;
      leftover++;
    } else {
      otherImage++;
    }
  }
  return { recorded: lines.filter((l) => l.pid !== null).length, jobs: jobs.length, leftover, ended, unverified, otherImage, unchecked, probe: why };
}

// --- procguard's Jobs (orchestra app: owned sessions in procguard Jobs) -----------------------------------

/** The Jobs orchestrad's wrapped starts made, from the test dir's run/pids.jsonl (the `job` of each entry), in order. */
export function jobsOf(testDir: string): { rule: string; job: string; pid: number | null }[] {
  return pidLines(testDir).flatMap((l) => (l.job === null ? [] : [{ rule: l.rule, job: l.job, pid: l.pid }]));
}

export type JobProc = { pid: number; createTime: string | null; image: string | null };

export type Probe = {
  /**
   * job-info: found false only on procguard's own "no such Job" (ok:true, found:false). Any other answer
   * (ok:false: OpenJobObject refused, an exception) throws: a probe that failed is never "the Job is gone".
   */
  info(job: string): Promise<{ found: boolean; procs: JobProc[] }>;
  /** Ends every process in the Job named `job` (kill-job): found false when there is no such Job any more. */
  kill(job: string): Promise<{ found: boolean; before: number | null; after: number | null }>;
  /** alive: an answer that is not ok:true with an alive array throws (never read as "none alive"). */
  alive(procs: { pid: number; createTime: string }[]): Promise<string[]>;
  close(): void;
};

/** What orchestrad logged of the procguard it built at its startup (the last such line of run/orchestrad.log), or null. */
function loggedProcguard(testDir: string): { exe: string; sha256: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(testDir, 'orchestra', 'run', 'orchestrad.log'), 'utf8');
  } catch {
    return null;
  }
  let found: { exe: string; sha256: string } | null = null;
  for (const l of text.split('\n')) {
    if (!l.includes('"procguard"')) continue;
    try {
      const e = JSON.parse(l) as { event?: unknown; fields?: { on?: unknown; exe?: unknown; sha256?: unknown } };
      const f = e.fields;
      if (e.event === 'procguard' && f?.on === true && typeof f.exe === 'string' && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) found = { exe: f.exe, sha256: f.sha256 };
    } catch {
      // A torn line.
    }
  }
  return found;
}

/**
 * A resident procguard of the script's own: the exe orchestrad built in the test dir
 * (orchestra\runtime\procguard\<hash>\procguard.exe), started only once its bytes hash to the sha256
 * orchestrad logged for it at its startup (phase 4 review: never an unchecked exe). It opens a Job by
 * name to say what is in it or to end it, and checks processes by pid + creation time. No probe (and
 * why) when orchestrad logged no build, the exe is not in the test dir, or it does not match.
 */
export function probeOf(testDir: string): { pg: Probe; why: null } | { pg: null; why: string } {
  const logged = loggedProcguard(testDir);
  if (logged === null) return { pg: null, why: 'orchestrad logged no procguard it built (procguard off?)' };
  let root: string;
  let exe: string;
  try {
    root = fs.realpathSync.native(path.join(testDir, 'orchestra', 'runtime', 'procguard'));
    exe = fs.realpathSync.native(logged.exe);
  } catch {
    return { pg: null, why: 'the procguard.exe orchestrad logged is not there' };
  }
  const rel = path.relative(root, exe);
  if (rel.startsWith('..') || path.isAbsolute(rel) || path.basename(exe).toLowerCase() !== 'procguard.exe') return { pg: null, why: 'the procguard.exe orchestrad logged is not in the test dir' };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(exe);
  } catch {
    return { pg: null, why: 'procguard.exe unreadable' };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== logged.sha256) return { pg: null, why: 'procguard.exe is not the exe orchestrad built (sha256 differs)' };
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } });
  let tail = '';
  let seq = 0;
  const waiting = new Map<number, (v: any) => void>();
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    tail += d;
    let i: number;
    while ((i = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, i);
      tail = tail.slice(i + 1);
      try {
        const m = JSON.parse(line) as { id?: number };
        if (typeof m.id === 'number') waiting.get(m.id)?.(m);
      } catch {
        // Not ours.
      }
    }
  });
  const ask = (cmd: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`probe: ${String(cmd.cmd)} had no answer`)), 15_000);
    waiting.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    child.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
  });
  const n = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
  return {
    why: null,
    pg: {
      info: async (job) => {
        const r = await ask({ cmd: 'job-info', name: job });
        // Review fix: an error answer has no found field; read as found:false it would pass as "the Job is gone".
        if (r.ok !== true || typeof r.found !== 'boolean') throw new Error(`probe: job-info failed: ${String(r.error)}${r.message === undefined ? '' : ` (${String(r.message)})`}`);
        return { found: r.found, procs: Array.isArray(r.procs) ? r.procs : [] };
      },
      kill: async (job) => {
        const r = await ask({ cmd: 'kill-job', name: job, waitMs: 3000 });
        if (r.ok !== true) throw new Error(`probe: kill-job refused: ${String(r.error)}`);
        return { found: r.found === true, before: n(r.before), after: n(r.after) };
      },
      alive: async (procs) => {
        const r = await ask({ cmd: 'alive', procs });
        if (r.ok !== true || !Array.isArray(r.alive)) throw new Error(`probe: alive failed: ${String(r.error)}${r.message === undefined ? '' : ` (${String(r.message)})`}`);
        return r.alive;
      },
      close: () => {
        child.stdin.end();
      },
    },
  };
}

/** probeOf without the reason: the probe, or null. */
export function probe(testDir: string): Probe | null {
  return probeOf(testDir).pg;
}
