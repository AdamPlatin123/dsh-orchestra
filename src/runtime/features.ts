import * as zlib from 'node:zlib';
import * as nodeModule from 'node:module';

export type FeatureDeps = {
  nodeVersion: string;
  typescript: unknown;
  zlib: { createZstdDecompress?: unknown; zstdDecompressSync?: unknown };
  module: { registerHooks?: unknown; isBuiltin(name: string): boolean };
};

export type Features = {
  node: string;
  nodeAtLeastMin: boolean;
  zstd: boolean;
  registerHooks: boolean;
  sqlite: boolean;
  typeStripping: boolean;
};

export const MIN_NODE = [24, 22, 0] as const;

export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function detectFeatures(deps: FeatureDeps = {
  nodeVersion: process.versions.node,
  typescript: process.features.typescript,
  zlib,
  module: nodeModule,
}): Features {
  return {
    node: deps.nodeVersion,
    nodeAtLeastMin: versionAtLeast(deps.nodeVersion, MIN_NODE),
    zstd: typeof deps.zlib.createZstdDecompress === 'function'
      && typeof deps.zlib.zstdDecompressSync === 'function',
    registerHooks: typeof deps.module.registerHooks === 'function',
    sqlite: deps.module.isBuiltin('node:sqlite'),
    typeStripping: deps.typescript === 'strip' || deps.typescript === 'transform',
  };
}

/** Missing features in a fixed order, for the console and Tuning. */
export function missingFeatures(f: Features): string[] {
  const out: string[] = [];
  if (!f.nodeAtLeastMin) out.push(`node>=${MIN_NODE.join('.')}`);
  if (!f.zstd) out.push('zlib zstd');
  if (!f.registerHooks) out.push('module.registerHooks');
  if (!f.sqlite) out.push('node:sqlite');
  if (!f.typeStripping) out.push('typescript type stripping');
  return out;
}
