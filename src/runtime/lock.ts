import { createServer } from 'node:net';
import type { Server } from 'node:net';
import * as crypto from 'node:crypto';

// The single-writer lock (plan §2 row 单写者锁, I12): identity, not heartbeat. The process holds the
// server end of a named pipe for its whole life; a second listen on the same name gets EADDRINUSE
// (verified on this machine, in-process and across processes), and the kernel frees the name the
// moment the holder dies. There is no takeover branch and no time threshold: a held pipe means
// another orchestrad is alive, however long its event loop has been stuck. daemon.json is written
// once when the lock is taken (step 6 may add the createTime: at most two writes per start), and
// only feeds the second instance's hint and diagnostics.

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
  profile: Profile;
  /** A fresh random UUID per start: tells two starts with the same pid apart. */
  bootId: string;
  startedAt: string;
};

export function encodeDaemonInfo(i: DaemonInfo): string {
  return `${JSON.stringify({ v: i.v, pid: i.pid, profile: i.profile, bootId: i.bootId, startedAt: i.startedAt })}\n`;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const bootOk = typeof r.bootId === 'string' && UUID.test(r.bootId);
  const startedOk = typeof r.startedAt === 'string' && ISO.test(r.startedAt) && Number.isFinite(Date.parse(r.startedAt));
  if (r.v !== 1 || !pidOk || (r.profile !== 'real' && r.profile !== 'test') || !bootOk || !startedOk) return null;
  return { v: 1, pid: r.pid as number, profile: r.profile, bootId: r.bootId as string, startedAt: r.startedAt as string };
}

/** The one console line a second instance prints before it exits. */
export function heldMessage(home: string, info: DaemonInfo | null): string {
  const who = info === null ? 'holder unknown: daemon.json is missing or unreadable' : `pid ${info.pid}, started ${info.startedAt}`;
  return `orchestrad: another orchestrad holds the lock for ${home} (${who}). This instance will not take over: close that orchestrad, or end its process yourself if it is stuck, then start again.`;
}
