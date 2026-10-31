import { Worker } from 'node:worker_threads';
import type { ResourceLimits } from 'node:worker_threads';
import { frozenClass } from '../../shared/frozen.js';

// A URL is mutable through its setters whatever Object.freeze says, and startWorker reads this one on
// every call: exported, any module could point it at a module of its own and start every worker past
// the bootstrap and its fence. So the URL stays in this module, and only its href (a string) is exported.
const BOOTSTRAP_URL = new URL('../workers/bootstrap.ts', import.meta.url);
/** Where every worker starts (workers/bootstrap.ts), as a string. */
export const BOOTSTRAP_HREF: string = BOOTSTRAP_URL.href;
export const WORKER_DATA_KEY = 'orchestraWorker';

/** What bootstrap.ts hands to the worker module's run(); worker modules never import worker_threads. */
export type WorkerContext = {
  data: unknown;
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
};

export type WorkerPayload = { target: string; data: unknown };

export type WorkerTargetReason = 'not-file-url' | 'not-ts-module' | 'is-bootstrap';

export type WorkerTargetCheck = { ok: true; href: string } | { ok: false; reason: WorkerTargetReason };

export class WorkerStartError extends Error {
  readonly code = 'ERR_ORCHESTRA_WORKER';
  readonly reason: WorkerTargetReason;
  constructor(reason: WorkerTargetReason, target: string) {
    super(`[ERR_ORCHESTRA_WORKER] worker target rejected (${reason}): ${target}`);
    this.reason = reason;
  }
}
frozenClass(WorkerStartError);

/** A worker module is a .ts file: URL. Source text and data: URLs are refused, so is the bootstrap itself. */
export function checkWorkerTarget(target: unknown): WorkerTargetCheck {
  let u: URL;
  try {
    u = target instanceof URL ? target : new URL(String(target));
  } catch {
    return { ok: false, reason: 'not-file-url' };
  }
  if (u.protocol !== 'file:') return { ok: false, reason: 'not-file-url' };
  if (u.search !== '' || u.hash !== '' || !u.pathname.toLowerCase().endsWith('.ts')) return { ok: false, reason: 'not-ts-module' };
  if (u.pathname.toLowerCase() === BOOTSTRAP_URL.pathname.toLowerCase()) return { ok: false, reason: 'is-bootstrap' };
  return { ok: true, href: u.href };
}

export type StartWorkerOptions = { name?: string; resourceLimits?: ResourceLimits };

/**
 * The only way to start a worker. The thread first runs workers/bootstrap.ts, which installs the
 * import fence, and only then imports `target` and calls its exported run(context).
 */
export function startWorker(target: URL, data?: unknown, opts: StartWorkerOptions = {}): Worker {
  const c = checkWorkerTarget(target);
  if (!c.ok) throw new WorkerStartError(c.reason, String(target));
  const payload: WorkerPayload = { target: c.href, data };
  return new Worker(BOOTSTRAP_URL, {
    workerData: { [WORKER_DATA_KEY]: payload },
    name: opts.name,
    resourceLimits: opts.resourceLimits,
    stdin: false,
  });
}
