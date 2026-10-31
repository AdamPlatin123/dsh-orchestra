import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { WorkerContext, WorkerPayload } from '../runtime/workers.ts';
import { checkWorkerTarget, WORKER_DATA_KEY } from '../runtime/workers.ts';
import { installImportFence } from '../runtime/import-fence.ts';

type WorkerModule = { run?: (ctx: WorkerContext) => unknown };

/** Worker entry: fence first, then the worker module. Only startWorker() points a thread here. */
export async function runBootstrap(): Promise<void> {
  const port = parentPort;
  if (isMainThread || port === null) throw new Error('workers/bootstrap.ts runs only as a worker entry');
  const payload = (workerData as Record<string, WorkerPayload | undefined> | null)?.[WORKER_DATA_KEY];
  const c = checkWorkerTarget(payload?.target);
  if (payload === undefined || !c.ok) throw new Error(`workers/bootstrap.ts: bad worker target (${c.ok ? 'missing' : c.reason})`);
  // Fail closed: without the resolve hook a worker module could import any builtin.
  if (!installImportFence().resolveHook) throw new Error('workers/bootstrap.ts: module.registerHooks is missing, worker refused');
  const mod = (await import(c.href)) as WorkerModule;
  if (typeof mod.run !== 'function') throw new Error(`worker module exports no run(): ${c.href}`);
  await mod.run({
    data: payload.data,
    post: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', listener);
    },
  });
}

if (import.meta.main) {
  await runBootstrap();
}
