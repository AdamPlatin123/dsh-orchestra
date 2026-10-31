import type { Features } from './runtime/features.ts';
import { detectFeatures, missingFeatures } from './runtime/features.ts';

type MainModule = { start(f: Features): Promise<void> };

export async function boot(entry: URL): Promise<void> {
  const f = detectFeatures();
  if (!f.sqlite || !f.typeStripping) {
    console.error(`orchestrad: cannot start, missing: ${missingFeatures(f).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  // From step 1: installImportFence() goes here; a missing registerHooks is left to planStartup() (step 2), which picks ui-only.
  const main = (await import(entry.href)) as MainModule;
  await main.start(f);
}

if (import.meta.main) {
  await boot(new URL('./main.ts', import.meta.url));
}
