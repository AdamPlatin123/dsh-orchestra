import { createServer } from 'node:net';
import type { Server } from 'node:net';
import * as crypto from 'node:crypto';

// The single-writer lock (plan §2 row 单写者锁, I12): identity, not heartbeat. The process holds the
// server end of a named pipe for its whole life; a second listen on the same name gets EADDRINUSE
// (verified on this machine, in-process and across processes), and the kernel frees the name the
// moment the holder dies. daemon.json only feeds the hint and diagnostics. There is no takeover
// branch: however old the heartbeat, a held pipe means another orchestrad is alive.

export const HEARTBEAT_MS = 10_000;

/** The pipe for one data dir: derived from realpath(ORCHESTRA_HOME), lowercased. */
export function lockPipeName(homeReal: string): string {
  const h = crypto.createHash('sha256').update(homeReal.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\orchestra-${h}-lock`;
}

export type HeldLock = { readonly pipe: string; release(): Promise<void> };

export type LockResult =
  | { ok: true; lock: HeldLock }
  | { ok: false; reason: 'held'; pipe: string }
  | { ok: false; reason: 'listen-failed'; pipe: string; detail: string };

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e);
}

/** Exclusive listen. Nobody is served on the pipe: every connection is closed at once. */
export function acquireLock(pipe: string): Promise<LockResult> {
  return new Promise((resolve) => {
    const server: Server = createServer((socket) => socket.destroy());
    const onError = (e: unknown) => {
      const code = errCode(e);
      resolve(code === 'EADDRINUSE' ? { ok: false, reason: 'held', pipe } : { ok: false, reason: 'listen-failed', pipe, detail: code });
    };
    server.once('error', onError);
    server.listen(pipe, () => {
      server.off('error', onError);
      // A later server error cannot hand the pipe to anyone else while this process lives.
      server.on('error', () => {});
      let released: Promise<void> | null = null;
      resolve({
        ok: true,
        lock: {
          pipe,
          release: () => (released ??= new Promise<void>((done) => server.close(() => done()))),
        },
      });
    });
  });
}

export type Profile = 'real' | 'test';

export type DaemonInfo = {
  v: 1;
  pid: number;
  /** Filled in once procguard reports it (step 6); null until then. */
  createTime: number | null;
  profile: Profile;
  startedAt: string;
  heartbeatAt: string;
};

export function encodeDaemonInfo(i: DaemonInfo): string {
  return `${JSON.stringify({ v: i.v, pid: i.pid, createTime: i.createTime, profile: i.profile, startedAt: i.startedAt, heartbeatAt: i.heartbeatAt })}\n`;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** daemon.json as written by encodeDaemonInfo, or null for anything else. */
export function parseDaemonInfo(text: string): DaemonInfo | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  const pidOk = Number.isSafeInteger(r.pid) && (r.pid as number) > 0;
  const ctOk = r.createTime === null || (Number.isSafeInteger(r.createTime) && (r.createTime as number) >= 0);
  const isoOk = (v: unknown) => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
  if (r.v !== 1 || !pidOk || !ctOk || (r.profile !== 'real' && r.profile !== 'test') || !isoOk(r.startedAt) || !isoOk(r.heartbeatAt)) return null;
  return { v: 1, pid: r.pid as number, createTime: r.createTime as number | null, profile: r.profile, startedAt: r.startedAt as string, heartbeatAt: r.heartbeatAt as string };
}

/** The one console line a second instance prints before it exits. */
export function heldMessage(home: string, info: DaemonInfo | null, nowMs: number): string {
  const who = info === null
    ? 'holder unknown: daemon.json is missing or unreadable'
    : `pid ${info.pid}, heartbeat ${Math.max(0, Math.round((nowMs - Date.parse(info.heartbeatAt)) / 1000))} s ago`;
  return `orchestrad: another orchestrad holds the lock for ${home} (${who}). This instance will not take over: close that orchestrad, or end its process yourself if it is stuck, then start again.`;
}

export type Timers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type HeartbeatConfig = {
  info: Omit<DaemonInfo, 'heartbeatAt'>;
  /** Replaces daemon.json (the write fence's writeAtomic). */
  write(text: string): void;
  now(): number;
  intervalMs?: number;
  timers?: Timers;
  onError?(e: unknown): void;
};

export type Heartbeat = { beat(): void; stop(): void };

/** Writes daemon.json now and every `intervalMs`; a failed write is reported, never fatal. */
export function startHeartbeat(cfg: HeartbeatConfig): Heartbeat {
  const timers = cfg.timers ?? NODE_TIMERS;
  const beat = () => {
    try {
      cfg.write(encodeDaemonInfo({ ...cfg.info, heartbeatAt: new Date(cfg.now()).toISOString() }));
    } catch (e) {
      cfg.onError?.(e);
    }
  };
  beat();
  let handle: unknown = timers.setInterval(beat, cfg.intervalMs ?? HEARTBEAT_MS);
  return {
    beat,
    stop: () => {
      if (handle === null) return;
      timers.clearInterval(handle);
      handle = null;
    },
  };
}
