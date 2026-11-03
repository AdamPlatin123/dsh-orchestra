import type { OwnedJob } from './procguard.ts';
import type { ProcHandle } from './spawn.ts';

// The Claude host as its driver sees it (alpha 0.2 design §2.1 "停止顺序"; orchestra app step 4), and the
// order it is stopped in. The handle's kill stays here in src/os/ (static scan kill-only-in-os).
//
// ProcHandle.kill is child.kill(): on Windows it ends node.exe (the host) only, and claude.exe, which
// the SDK started, would be left. So a kill is the last step, never the first:
//   1. the close frame: the host calls query.close(), the SDK ends claude.exe, the host exits; wait 3 s;
//   2. stdin closed: the host reads EOF and does the same; wait 2 s;
//   3. kill the host. Started inside a procguard Job (rule procguard-claude), the handle is procguard's,
//      and its end closes the Job: claude.exe and whatever it ran go with it (r4 D4). Started without one
//      (procguard off), claude.exe may remain: the caller hears `killed` and says so in the feed.

export const HOST_STOP_MS = Object.freeze({ afterClose: 3000, afterEof: 2000 });

export type HostPipe = {
  readonly pid: number | null;
  write(data: string): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (code: string) => void): void;
  /** Closes stdin; the host takes EOF as goodbye. */
  closeStdin(): void;
  /** The last resort: ends node.exe only (claude.exe may remain) or, in a Job, procguard and so the whole tree. */
  kill(): void;
  /** The Job the host's whole tree runs in, or null when it was started without one (procguard off). */
  readonly job: OwnedJob | null;
};

/** The pipe over a handle the spawn gate started (rule claude-host); frozen, without a prototype, with no path back to the handle. */
export function hostPipe(h: ProcHandle, job: OwnedJob | null = null): HostPipe {
  let eof = false;
  let killed = false;
  const pipe = Object.assign(Object.create(null) as HostPipe, {
    pid: h.pid,
    job,
    write: (data: string) => {
      if (!eof) h.write(data);
    },
    onStdout: (cb: (chunk: Buffer) => void) => h.onStdout(cb),
    onStderr: (cb: (chunk: Buffer) => void) => h.onStderr(cb),
    onClose: (cb: (code: number | null, signal: string | null) => void) => h.onClose(cb),
    onError: (cb: (code: string) => void) => h.onError(cb),
    closeStdin: () => {
      if (eof) return;
      eof = true;
      try {
        h.end();
      } catch {
        // A stdin that is gone already: the host is going too, or the kill ends it.
      }
    },
    kill: () => {
      if (killed) return;
      killed = true;
      h.kill();
    },
  });
  return Object.freeze(pipe);
}

/**
 * The brake's end of a host (no stop order: its Job was killed already, or is being killed): the host's
 * handle goes at once, so its pipes close and its session hears the close.
 */
export function endHostNow(p: HostPipe): void {
  p.closeStdin();
  p.kill();
}

/** A one-shot timer of the caller's Clock: runs `fn` after `ms`; the returned function cancels it. */
export type After = (ms: number, fn: () => void) => () => void;

/**
 * Stops a host in the design's order. `closed()` says whether the child has exited already; `killed`
 * hears that step 3 was needed. Returns a function that cancels the pending steps (the child exited).
 */
export function stopHostInOrder(p: HostPipe, o: { closeFrame: string; after: After; closed(): boolean; killed(): void }): () => void {
  let cancel: () => void = () => {};
  let done = false;
  const step = (fn: () => void) => () => {
    if (done || o.closed()) return;
    fn();
  };
  try {
    p.write(o.closeFrame);
  } catch {
    // Its stdin may be gone: the next step closes it and then kills.
  }
  cancel = o.after(HOST_STOP_MS.afterClose, step(() => {
    p.closeStdin();
    cancel = o.after(HOST_STOP_MS.afterEof, step(() => {
      done = true;
      p.kill();
      o.killed();
    }));
  }));
  return () => {
    done = true;
    cancel();
  };
}
