import type { BootPorts } from './boot.ts';
import type { Features } from './runtime/features.ts';
import type { FenceStatus } from './runtime/import-fence.ts';
import { missingFeatures } from './runtime/features.ts';

export async function start(f: Features, _fence?: FenceStatus, _ports?: BootPorts): Promise<void> {
  const missing = missingFeatures(f);
  const note = missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '';
  console.log(`orchestrad M0 scaffold on node ${f.node}${note}`);
}
