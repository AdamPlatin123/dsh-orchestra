import type { ProcHandle } from './spawn.ts';

// The Claude host as its driver sees it (alpha 0.2 design §2.1 "停止顺序"; orchestra app step 4), and the
// order it is stopped in. The handle's kill stays here in src/os/ (static scan kill-only-in-os).
//
// ProcHandle.kill is child.kill(): on Windows it ends node.exe (the host) only, and claude.exe, which
// the SDK started, would be left. So a kill is the last step, never the first:
//   1. the close frame: the host calls query.close(), the SDK ends claude.exe, the host exits; wait 3 s;
//   2. stdin closed: the host reads EOF and does the same; wait 2 s;
//   3. kill the host. claude.exe may then remain (no kill-on-close Job yet, D4's residual risk): the
//      caller hears `killed` and says so in the feed.

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
  /** The last resort: ends node.exe only (claude.exe may remain). */
  kill(): void;
};

/** The pipe over a handle the spawn gate started (rule claude-host); frozen, without a prototype, with no path back to the handle. */
export function hostPipe(h: ProcHandle): HostPipe {
  let eof = false;
  let killed = false;
  const pipe = Object.assign(Object.create(null) as HostPipe, {
    pid: h.pid,
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
