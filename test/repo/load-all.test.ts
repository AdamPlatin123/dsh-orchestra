import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'vendor') walk(p, out);
    } else if (e.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

// Importing a module must only define things. Type stripping rejects non-erasable syntax at load time,
// and a module that prints or starts work on import fails here.
test('every src module loads with erasable syntax and no import-time side effects', async () => {
  const files = walk(src);
  assert.ok(files.length > 0);
  const log = console.log;
  const err = console.error;
  const printed: string[] = [];
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try {
    for (const f of files) {
      await import(pathToFileURL(f).href);
    }
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.deepEqual(printed, [], `modules printed on import: ${printed.join(' | ')}`);
});
