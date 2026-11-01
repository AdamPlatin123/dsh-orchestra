import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every ui/ module but app.js only defines things when imported (UID:164, 0.1 alpha design §5): no
// document, window, location, storage, frame, fetch or clock is touched until a function runs. app.js
// is the one module with top-level effects, so importing it does reach the document. Each test file
// runs in its own process, so these imports are the first ones.

const UI = fileURLToPath(new URL('../../ui/', import.meta.url));
const TRAPPED = ['document', 'window', 'location', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'history', 'fetch', 'performance', 'setInterval', 'setTimeout'];

test('every ui module but app.js imports without touching the page, the network or the clock', async () => {
  const touched: string[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of TRAPPED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); return undefined; } });
  }
  const mods = fs.readdirSync(UI).filter((f) => f.endsWith('.js')).sort();
  try {
    assert.deepEqual(mods, ['api.js', 'app.js', 'clock.js', 'dom.js', 'layout.js', 'prefs.js', 'route.js', 'view.js']);
    for (const f of mods.filter((m) => m !== 'app.js')) {
      await import(pathToFileURL(`${UI}${f}`).href);
      assert.deepEqual(touched, [], `${f} touched ${touched.join(', ')} on import`);
    }
    await assert.rejects(import(pathToFileURL(`${UI}app.js`).href));
    assert.ok(touched.includes('document'), 'app.js boots against the document');
  } finally {
    for (const [name, d] of saved) {
      if (d === undefined) delete (globalThis as Record<string, unknown>)[name];
      else Object.defineProperty(globalThis, name, d);
    }
  }
});
