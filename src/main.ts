import type { Features } from './runtime/features.ts';
import { missingFeatures } from './runtime/features.ts';

export async function start(f: Features): Promise<void> {
  const missing = missingFeatures(f);
  const note = missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '';
  console.log(`orchestrad M0 scaffold on node ${f.node}${note}`);
}
