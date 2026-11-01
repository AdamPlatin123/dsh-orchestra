import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { OUT, UI_FILES, present, render } from '../../scripts/embed-ui.ts';
import { UI_ASSETS } from '../../src/server/ui-assets.ts';

// The embedded page files (src/server/ui-assets.ts) are the whitelisted files on disk, byte for byte:
// change a file under ui/ or a shared module the page loads and this fails until
// `node scripts/embed-ui.ts` is run again (0.1 alpha design §8, risk 8).

test('the embedded map holds exactly the whitelisted files that exist, with their bytes', () => {
  const disk = present();
  assert.deepEqual(Object.keys(UI_ASSETS), disk.map((f) => f.name), 'run node scripts/embed-ui.ts');
  for (const f of disk) assert.ok(Buffer.from(UI_ASSETS[f.name]!.hex, 'hex').equals(f.bytes), `${f.name} changed: run node scripts/embed-ui.ts`);
  for (const name of Object.keys(UI_ASSETS)) assert.ok(UI_FILES.includes(name), `${name} is not whitelisted`);
});

test('the generated module is what the script writes now', () => {
  // A boolean, not a diff: the module is some 100 KB of hex.
  assert.ok(fs.readFileSync(OUT, 'utf8') === render(present()), 'src/server/ui-assets.ts is stale: run node scripts/embed-ui.ts');
});
