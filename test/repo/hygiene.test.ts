import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');
const lines = (p: string) => read(p).split(/\r?\n/).map((l) => l.trim());

test('.gitignore keeps the runtime, binaries and raw fixtures out of git', () => {
  const ig = lines('.gitignore');
  for (const want of ['.tools/', '*.exe', 'fixtures/*', '!fixtures/synthetic/', '!fixtures/golden/']) {
    assert.ok(ig.includes(want), `.gitignore lacks ${want}`);
  }
});

test('.gitattributes keeps fixtures byte-exact', () => {
  assert.ok(lines('.gitattributes').includes('fixtures/** -text'));
});

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('production code never imports from spikes/', () => {
  const offenders: string[] = [];
  for (const root of ['src', 'shared', 'ui']) {
    for (const f of walk(path.join(repo, root))) {
      const text = fs.readFileSync(f, 'utf8');
      if (/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\bspikes[\\/]/.test(text)) offenders.push(path.relative(repo, f));
    }
  }
  assert.deepEqual(offenders, []);
});
