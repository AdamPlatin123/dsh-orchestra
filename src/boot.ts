import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import { detectFeatures, missingFeatures } from './runtime/features.ts';
import { installImportFence } from './runtime/import-fence.ts';

/** Capabilities boot takes before the fence locks them, for main.ts to hand to the one module allowed each. */
export type BootPorts = { fetch: typeof globalThis.fetch };

type MainModule = { start(f: Features, fence: FenceStatus, ports: BootPorts): Promise<void> };

export type BootDeps = { detectFeatures(): Features; installImportFence(): FenceStatus };

export type BootOutcome =
  | { started: true }
  | { started: false; reason: 'missing-features'; missing: string[] }
  | { started: false; reason: 'no-resolve-hook'; fence: FenceStatus };

const DEFAULT_DEPS: BootDeps = { detectFeatures, installImportFence: () => installImportFence() };

export async function boot(entry: URL, deps: BootDeps = DEFAULT_DEPS): Promise<BootOutcome> {
  const f = deps.detectFeatures();
  if (!f.sqlite || !f.typeStripping) {
    const missing = missingFeatures(f);
    console.error(`orchestrad: cannot start, missing: ${missing.join(', ')}`);
    process.exitCode = 2;
    return { started: false, reason: 'missing-features', missing };
  }
  const ports: BootPorts = { fetch: globalThis.fetch };
  // Hooks only see modules resolved after registration, so the fence goes in before main.ts is
  // imported. Without the resolve hook nothing would stop main.ts's graph from importing any
  // builtin, so boot refuses (fail closed) until planStartup() (step 2) can offer ui-only.
  const fence = deps.installImportFence();
  if (!fence.resolveHook) {
    console.error(`orchestrad: cannot start, import fence has no resolve hook (module.registerHooks missing): ${JSON.stringify(fence)}`);
    process.exitCode = 2;
    return { started: false, reason: 'no-resolve-hook', fence };
  }
  const main = (await import(entry.href)) as MainModule;
  await main.start(f, fence, ports);
  return { started: true };
}

if (import.meta.main) {
  await boot(new URL('./main.ts', import.meta.url));
}
