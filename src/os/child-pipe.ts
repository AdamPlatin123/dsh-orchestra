import type { ProcHandle } from './spawn.ts';

// A long-lived child as a line protocol peer sees it (orchestra app plan §2: the owned Codex sessions
// talk JSON-RPC over stdio). The handle form of kill stays in src/os/ (static scan kill-only-in-os):
// a holder of a ChildPipe ends its child with stop(), which closes stdin first, so a child that reads
// EOF as "goodbye" leaves on its own, and then kills it through its handle.

export type ChildPipe = {
  readonly pid: number | null;
  write(data: string): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (code: string) => void): void;
  /** Closes stdin, then kills the child; a second call does nothing. */
  stop(): void;
};

/** The pipe over a handle the spawn gate started; frozen, without a prototype, with no path back to the handle. */
export function childPipe(h: ProcHandle): ChildPipe {
  let stopped = false;
  const pipe = Object.assign(Object.create(null) as ChildPipe, {
    pid: h.pid,
    write: (data: string) => h.write(data),
    onStdout: (cb: (chunk: Buffer) => void) => h.onStdout(cb),
    onStderr: (cb: (chunk: Buffer) => void) => h.onStderr(cb),
    onClose: (cb: (code: number | null, signal: string | null) => void) => h.onClose(cb),
    onError: (cb: (code: string) => void) => h.onError(cb),
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        h.end();
      } catch {
        // A stdin that is gone already: the kill below still ends the child.
      }
      h.kill();
    },
  });
  return Object.freeze(pipe);
}
