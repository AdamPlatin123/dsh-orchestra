// orchestrad stops in order when its stdin pipe closes (orchestra app: stdin-EOF shutdown). A program that
// starts orchestrad with a pipe for stdin (the preview launcher, a script, Git Bash's terminal) holds the
// write end; when that program ends, however it ends, Windows closes the write end and orchestrad reads
// EOF. orchestrad then runs the same stop as Ctrl+C: the owned sessions end with daemon-stop, their Jobs
// close, the store closes, the process exits. Without this a killed parent left orchestrad running alone,
// and a TerminateProcess of orchestrad itself skips its stop entirely.
//
// Only a pipe counts. A console (TTY) never: the person at it stops orchestrad with Ctrl+C, and a console
// has no EOF that means "the parent is gone". Nor NUL (stdio 'ignore', a detached start) or a file
// redirect: both read EOF at once, which says nothing about a parent. Imports nothing.

/** What fd 0 is: an interactive console, a pipe (or socket) from the program that started orchestrad, or anything else. */
export type StdinKind = 'tty' | 'pipe' | 'other';

/** The part of process.stdin this module touches. */
export type StdinLike = {
  readonly isTTY?: boolean;
  on(event: 'data' | 'end' | 'close' | 'error', fn: (arg?: unknown) => void): unknown;
  off(event: 'data' | 'end' | 'close' | 'error', fn: (arg?: unknown) => void): unknown;
  resume(): unknown;
  pause(): unknown;
};

/**
 * Node makes process.stdin a tty.ReadStream for a console, a net.Socket for a pipe, an fs.ReadStream for
 * a file or the NUL device (what stdio 'ignore' and a detached start give a child on Windows), and a
 * Readable that ends at once for a closed fd 0 (measured on Node 24, Windows). A net.Socket is the one
 * with setNoDelay; a tty.ReadStream is one too, so isTTY is asked first.
 */
export function stdinKind(stdin: unknown): StdinKind {
  if (typeof stdin !== 'object' || stdin === null) return 'other';
  if ((stdin as { isTTY?: unknown }).isTTY === true) return 'tty';
  return typeof (stdin as { setNoDelay?: unknown }).setNoDelay === 'function' ? 'pipe' : 'other';
}

/** Why the watch fired: the pipe ended (EOF or closed), or reading it failed (the other end is gone in another way). */
export type StdinEndWhy = 'stdin-eof' | 'stdin-error';

/**
 * Reads `stdin` to its end and calls `ended` once: on EOF, on close, or on a read error. What is read is
 * dropped: orchestrad takes no input there. Returns the undo, which stops reading and calls nothing more.
 * The caller decides that `stdin` is a pipe (stdinKind); this function watches whatever it is given.
 */
export function watchStdinEnd(stdin: StdinLike, ended: (why: StdinEndWhy, detail: string | null) => void): () => void {
  let done = false;
  const fire = (why: StdinEndWhy, detail: string | null) => {
    if (done) return;
    done = true;
    undo();
    ended(why, detail);
  };
  const onData = () => {};
  const onEnd = () => fire('stdin-eof', null);
  const onError = (e?: unknown) => fire('stdin-error', e instanceof Error ? `${(e as { code?: unknown }).code ?? e.name}` : String(e));
  const undo = () => {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    // The error listener stays: a read error after the undo is not ours to act on, but must not crash orchestrad.
    try {
      stdin.pause();
    } catch {
      // A stream that cannot pause any more has ended.
    }
  };
  stdin.on('error', (e) => onError(e));
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);
  stdin.resume();
  return () => {
    if (done) return;
    done = true;
    undo();
  };
}
