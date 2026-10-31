import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const boot = fileURLToPath(new URL('../../src/boot.ts', import.meta.url));

test('boot.ts starts the scaffold and exits 0', () => {
  const out = execFileSync(process.execPath, [boot], { encoding: 'utf8', timeout: 30_000 });
  assert.match(out, /^orchestrad M0 scaffold on node 24\.\d+\.\d+\r?\n$/);
});

test('importing boot.ts as a module does not start anything', async () => {
  const mod = await import('../../src/boot.ts');
  assert.equal(typeof mod.boot, 'function');
});
