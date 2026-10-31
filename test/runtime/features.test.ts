import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFeatures, missingFeatures, versionAtLeast, MIN_NODE } from '../../src/runtime/features.ts';

test('the current runtime has every feature', () => {
  const f = detectFeatures();
  assert.deepEqual(missingFeatures(f), []);
  assert.equal(f.nodeAtLeastMin, true);
  assert.equal(f.zstd, true);
  assert.equal(f.registerHooks, true);
  assert.equal(f.sqlite, true);
  assert.equal(f.typeStripping, true);
});

test('a bare runtime reports all five gaps in a fixed order without throwing', () => {
  const f = detectFeatures({
    nodeVersion: '22.14.0',
    typescript: false,
    zlib: {},
    module: { isBuiltin: () => false },
  });
  assert.deepEqual(missingFeatures(f), [
    `node>=${MIN_NODE.join('.')}`,
    'zlib zstd',
    'module.registerHooks',
    'node:sqlite',
    'typescript type stripping',
  ]);
});

test('zstd needs both the streaming and the sync decoder', () => {
  const f = detectFeatures({
    nodeVersion: '24.22.0',
    typescript: 'strip',
    zlib: { createZstdDecompress: () => {} },
    module: { registerHooks: () => {}, isBuiltin: () => true },
  });
  assert.equal(f.zstd, false);
});

test('versionAtLeast boundaries', () => {
  assert.equal(versionAtLeast('24.22.0', [24, 22, 0]), true);
  assert.equal(versionAtLeast('v24.22.0', [24, 22, 0]), true);
  assert.equal(versionAtLeast('24.21.9', [24, 22, 0]), false);
  assert.equal(versionAtLeast('24.22.1', [24, 22, 0]), true);
  assert.equal(versionAtLeast('25.0.0', [24, 22, 0]), true);
  assert.equal(versionAtLeast('24.22', [24, 22, 0]), true);
  assert.equal(versionAtLeast('23.99.99', [24, 22, 0]), false);
});
