import type { ChildPipe } from '../os/child-pipe.ts';
import type { ClockHub, Fired } from '../runtime/clock.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The stdio JSON-RPC client of `codex app-server` (orchestra app plan §2, measured on codex-cli 0.165.0):
// one JSON object per line each way, without the "jsonrpc" member. Requests carry an id this client
// numbers; responses are matched by it. The server sends notifications and requests of its own
// (approvals, questions), which this client hands to its listeners; it answers none by itself.
//
// Bounds: a line longer than lineMaxBytes is dropped whole (counted), and a line that is not one JSON
// object, or not UTF-8, is dropped (counted); neither stops the stream. When the child exits, or its
// pipe fails, every request still waiting is rejected with RpcError 'closed', and nothing more is sent;
// a pipe that fails while its child may still run (a write that broke, a stream error) also stops the
// child, so no codex.exe outlives the client that could steer it (D4: Orchestra takes back what it started).
//
// A request may carry a deadline (timeoutMs): with a Clock hub given, a request still unanswered then is
// rejected with RpcError 'timeout' (the child is alive but says nothing). Its late answer, if one comes,
// is a stray response. Time only through the Clock (plan invariant 21): no timer of the host's own.

export const RPC_LIMITS = frozen({
  /** A codex line holds at most one item (a diff, a command's whole output): 8 MiB is far beyond any measured. */
  lineMaxBytes: 8 * 1024 * 1024,
});

export type RpcId = number | string;

export type RpcStats = {
  /** Lines that were not one JSON object of a known shape, or not UTF-8. */
  badLines: number;
  /** Lines over the length bound, dropped whole. */
  longLines: number;
  /** Responses to no request this client is waiting on. */
  strayResponses: number;
};

export type RpcExit = { code: number | null; signal: string | null; error: string | null };

export class RpcError extends Error {
  readonly code = 'ERR_ORCHESTRA_RPC';
  /** 'remote': the server answered with an error; 'closed': the child is gone; 'timeout': no answer by the deadline. */
  readonly reason: 'remote' | 'closed' | 'timeout';
  /** The server's error code, for 'remote'. */
  readonly rpcCode: number | null;
  constructor(reason: 'remote' | 'closed' | 'timeout', message: string, rpcCode: number | null = null) {
    super(`[ERR_ORCHESTRA_RPC] ${reason}: ${message}`);
    this.reason = reason;
    this.rpcCode = rpcCode;
  }
}
frozenClass(RpcError);

export type RpcClient = {
  /** Sends a request; settles with its result, or rejects with RpcError ('remote', 'closed', or 'timeout' past timeoutMs). */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Sends a notification; false when the child is gone. */
  notify(method: string, params?: unknown): boolean;
  /** Answers a server request; false when the child is gone. */
  respond(id: RpcId, result: unknown): boolean;
  respondError(id: RpcId, code: number, message: string): boolean;
  onNotification(cb: (method: string, params: unknown) => void): void;
  onRequest(cb: (id: RpcId, method: string, params: unknown) => void): void;
  /** Once, when the child exits or its pipe fails. */
  onExit(cb: (exit: RpcExit) => void): void;
  readonly closed: boolean;
  /** Requests still waiting for their response. */
  waiting(): number;
  stats(): RpcStats;
  /** Ends the child (stdin first, then its handle). */
  stop(): void;
};

const isId = (v: unknown): v is RpcId => (typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'string';
const keyOf = (id: RpcId) => (typeof id === 'number' ? `n:${id}` : `s:${id}`);

/** A listener's throw stays with that listener: the stream and the other listeners go on. */
function each<A extends unknown[]>(list: readonly ((...a: A) => void)[], ...a: A): void {
  for (const cb of list) {
    try {
      cb(...a);
    } catch {
      // Swallowed on purpose: a listener is the session's, and it records its own failures.
    }
  }
}

export type RpcOptions = {
  lineMaxBytes?: number;
  /** The Clock hub request deadlines run on; without one a timeoutMs is ignored. */
  hub?: ClockHub;
  /** The deadline timers' entity prefix (an owned id): `deadline:rpc-<name>-<id>:0`. */
  name?: string;
};

export function makeRpcClient(pipe: ChildPipe, opts: RpcOptions = {}): RpcClient {
  const lineMax = opts.lineMaxBytes ?? RPC_LIMITS.lineMaxBytes;
  if (!Number.isSafeInteger(lineMax) || lineMax < 16) throw new Error('rpc: lineMaxBytes must be an integer of at least 16');
  const name = opts.name ?? 'c';
  if (!/^[A-Za-z0-9]{1,40}$/.test(name)) throw new Error('rpc: name must be 1 to 40 letters or digits');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stats: RpcStats = { badLines: 0, longLines: 0, strayResponses: 0 };
  const waiting = new Map<string, { resolve(v: unknown): void; reject(e: RpcError): void; timerId: string | null }>();
  /** timerId -> the waiting key it ends. */
  const deadlines = new Map<string, string>();
  const clock = opts.hub === undefined ? null : opts.hub.port((f: Fired) => {
    const key = deadlines.get(f.timerId);
    if (key === undefined) return;
    deadlines.delete(f.timerId);
    const w = waiting.get(key);
    if (w === undefined) return;
    waiting.delete(key);
    w.reject(new RpcError('timeout', 'no answer by the deadline'));
  });
  const unarm = (w: { timerId: string | null }) => {
    if (w.timerId === null || clock === null) return;
    deadlines.delete(w.timerId);
    clock.cancel(w.timerId);
  };
  const notes: ((method: string, params: unknown) => void)[] = [];
  const asks: ((id: RpcId, method: string, params: unknown) => void)[] = [];
  const exits: ((exit: RpcExit) => void)[] = [];
  let nextId = 1;
  let closed = false;
  let exitInfo: RpcExit | null = null;

  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;

  const finish = (exit: RpcExit) => {
    if (exitInfo !== null) return;
    closed = true;
    exitInfo = exit;
    const all = [...waiting.values()];
    waiting.clear();
    for (const w of all) unarm(w);
    // A pipe that broke leaves a child that may still run: it is stopped here (stop is idempotent).
    if (exit.error !== null) {
      try {
        pipe.stop();
      } catch {
        // A handle that is gone already: nothing is left to stop.
      }
    }
    for (const w of all) w.reject(new RpcError('closed', exit.error ?? `exit ${String(exit.code ?? exit.signal)}`));
    each(exits, exit);
  };

  const send = (msg: Record<string, unknown>): boolean => {
    if (closed) return false;
    try {
      pipe.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const handle = (raw: Buffer) => {
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      stats.badLines++;
      return;
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      stats.badLines++;
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      stats.badLines++;
      return;
    }
    const m = msg as Record<string, unknown>;
    const has = (k: string) => Object.hasOwn(m, k);
    if (has('method')) {
      if (typeof m.method !== 'string' || m.method.length === 0) {
        stats.badLines++;
        return;
      }
      const params = has('params') ? m.params : undefined;
      if (has('id')) {
        if (!isId(m.id)) {
          stats.badLines++;
          return;
        }
        each(asks, m.id, m.method, params);
      } else {
        each(notes, m.method, params);
      }
      return;
    }
    if (has('id') && (has('result') || has('error'))) {
      if (!isId(m.id)) {
        stats.badLines++;
        return;
      }
      const w = waiting.get(keyOf(m.id));
      if (w === undefined) {
        stats.strayResponses++;
        return;
      }
      waiting.delete(keyOf(m.id));
      unarm(w);
      if (has('error')) {
        const e = m.error as { code?: unknown; message?: unknown } | null;
        const code = typeof e?.code === 'number' ? e.code : null;
        const message = typeof e?.message === 'string' ? e.message : 'error';
        w.reject(new RpcError('remote', message, code));
      } else {
        w.resolve(m.result);
      }
      return;
    }
    stats.badLines++;
  };

  pipe.onStdout((chunk) => {
    let at = 0;
    while (at < chunk.length) {
      const nl = chunk.indexOf(0x0a, at);
      const end = nl < 0 ? chunk.length : nl;
      if (!skipping) {
        const piece = chunk.subarray(at, end);
        if (size + piece.length > lineMax) {
          skipping = true;
          stats.longLines++;
          parts = [];
          size = 0;
        } else {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (nl < 0) break;
      if (!skipping) {
        const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        parts = [];
        size = 0;
        handle(line);
      }
      skipping = false;
      at = nl + 1;
    }
  });
  pipe.onClose((code, signal) => finish({ code, signal, error: null }));
  pipe.onError((code) => finish({ code: null, signal: null, error: code }));

  return Object.freeze({
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
      if (closed) return Promise.reject(new RpcError('closed', 'the child is gone'));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timerId = clock !== null && timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? `deadline:rpc-${name}-${id}:0` : null;
        const w = { resolve, reject, timerId };
        waiting.set(keyOf(id), w);
        if (!send({ id, method, params })) {
          waiting.delete(keyOf(id));
          reject(new RpcError('closed', 'the request could not be written'));
          return;
        }
        if (timerId !== null) {
          deadlines.set(timerId, keyOf(id));
          clock!.schedule({ timerId, class: 'deadline', clock: 'mono', due: clock!.nowMono() + timeoutMs! });
        }
      });
    },
    notify: (method: string, params?: unknown) => send(params === undefined ? { method } : { method, params }),
    respond: (id: RpcId, result: unknown) => send({ id, result }),
    respondError: (id: RpcId, code: number, message: string) => send({ id, error: { code, message } }),
    onNotification: (cb: (method: string, params: unknown) => void) => {
      notes.push(cb);
    },
    onRequest: (cb: (id: RpcId, method: string, params: unknown) => void) => {
      asks.push(cb);
    },
    onExit: (cb: (exit: RpcExit) => void) => {
      if (exitInfo !== null) each([cb], exitInfo);
      else exits.push(cb);
    },
    get closed() {
      return closed;
    },
    waiting: () => waiting.size,
    stats: () => ({ ...stats }),
    stop: () => pipe.stop(),
  });
}
