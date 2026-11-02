import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImports } from '../helpers/scan-rules.ts';
import { parseHtml } from '../helpers/fake-dom.ts';
import { UI_ASSETS } from '../../src/server/ui-assets.ts';
import { UI_FILES } from '../../scripts/embed-ui.ts';

// ui/stage.html under the stage CSP of the 0.1 alpha design §1 (script-src 'self', style-src 'self',
// require-trusted-types-for 'script', trusted-types 'none'): no inline script, style or handler, one
// module script, the two aria-live regions and three icons the page design asks for (UID:140), and the
// templates ui/view.js names. The size budget counts what the browser loads for /stage.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HTML = read('ui/stage.html');

test('stage.html carries no inline script, style, handler, form or named input', () => {
  assert.equal([...HTML.matchAll(/<script\b/g)].length, 1);
  assert.match(HTML, /<script type="module" src="\/assets\/ui\/app\.js"><\/script>/);
  assert.doesNotMatch(HTML, /<script(?![^>]*\bsrc=)[^>]*>/, 'an inline script');
  assert.doesNotMatch(HTML, /<style\b/);
  assert.doesNotMatch(HTML, /\sstyle\s*=/);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(HTML, /<form\b/i);
  // The ui:input-name rule: no form control carries a name (the only name= left is the viewport meta).
  assert.doesNotMatch(HTML, /<(?:input|select|textarea|button)\b[^>]*\sname\s*=/i);
  assert.deepEqual([...HTML.matchAll(/\sname\s*=\s*"([^"]*)"/g)].map((m) => m[1]), ['viewport', 'color-scheme']);
  assert.doesNotMatch(HTML, /javascript:/i);
  assert.match(HTML, /<link rel="stylesheet" href="\/assets\/ui\/stage\.css">/);
});

test('stage.html has two aria-live regions (polite and assertive) and three data-URI icons', () => {
  assert.deepEqual([...HTML.matchAll(/aria-live="(\w+)"/g)].map((m) => m[1]).sort(), ['assertive', 'polite']);
  const icons = [...HTML.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(icons.length, 3);
  for (const i of icons) assert.ok(i.startsWith('data:image/svg+xml,'), i.slice(0, 40));
});

test('stage.html holds every template ui/view.js names, with SVG templates in the SVG namespace', () => {
  const doc = parseHtml(HTML);
  const view = read('ui/view.js');
  const named = [...new Set([...view.matchAll(/tpl: '(tpl-[a-z]+)'/g)].map((m) => m[1]!))].sort();
  assert.ok(named.length >= 10);
  for (const id of named) assert.ok(doc.getElementById(id)?.content, `no <template id=${id}>`);
  for (const id of ['tpl-shead', 'tpl-phrase', 'tpl-staff', 'tpl-ferm']) {
    const g = doc.getElementById(id)!.content!.firstElementChild!.firstElementChild!;
    assert.deepEqual([g.localName, g.namespaceURI], ['g', 'http://www.w3.org/2000/svg'], id);
  }
  // ui/dom.js copies the five instrument glyphs from tpl-glyph into every empty .ins at boot.
  assert.equal(doc.getElementById('tpl-glyph')!.content!.firstElementChild!.firstElementChild!.children.length, 5);
  // Script never sets href: every <use> points at a symbol that the page defines.
  const symbols = new Set(doc.querySelectorAll('symbol').map((s) => s.getAttribute('id')));
  const uses = [...HTML.matchAll(/<use[^>]*href="#([\w-]+)"/g)].map((m) => m[1]!);
  assert.ok(uses.length >= 8);
  for (const u of uses) assert.ok(symbols.has(u), `#${u} is not a symbol`);
});

test('motion: animations only under prefers-reduced-motion: no-preference, keyframes only fade and move, notes are drawn not typed', () => {
  const css = read('ui/stage.css');
  const open = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
  assert.ok(open > 0);
  const close = css.indexOf('\n}', open);
  const outside = css.slice(0, open) + css.slice(close);
  assert.doesNotMatch(outside.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, ''), /animation/);
  for (const m of css.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g)) {
    for (const d of m[1]!.matchAll(/([\w-]+):/g)) assert.ok(['opacity', 'transform'].includes(d[1]!), d[1]);
  }
  // With reduced motion the second note stays hidden and the first stands still: one static note.
  assert.match(outside, /\.notes \.n2 \{ display: none; \}/);
  const doc = parseHtml(HTML);
  for (const id of ['nt1', 'nt2']) assert.equal(doc.getElementById(id)!.textContent, '', id);
  assert.match(HTML, /<g class="notes" data-slot="notes" aria-hidden="true">/);
  assert.match(HTML, /data-t="legend\.notes"/);
});

test('what the browser loads for /stage stays within budget: ui/ itself and the shared modules it imports', () => {
  const ui = fs.readdirSync(path.join(REPO, 'ui')).map((f) => `ui/${f}`);
  // The import closure from the page's one entry script.
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const r of findImports(read(rel))) if (r.form !== 'dynamic' && /^\.\.?\//.test(r.spec)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), r.spec)));
  };
  walk('ui/app.js');
  const shared = [...seen].filter((f) => f.startsWith('shared/')).sort();
  // protocol.js imports constants.js, so the embed whitelist needs it beside the three design §4 names;
  // the page never loads stage-contract.js (the tests validate against it, the page does not).
  assert.deepEqual(shared, ['shared/constants.js', 'shared/frozen.js', 'shared/protocol.js', 'shared/strings.js']);
  // The daemon embeds the page (src/server/ui-assets.ts, made by scripts/embed-ui.ts from its UI_FILES
  // whitelist): every module the page loads must be a key of that map and of the whitelist, or the
  // browser meets a 404 halfway through the module graph.
  for (const f of [...seen, 'ui/stage.html', 'ui/stage.css']) {
    assert.ok(Object.hasOwn(UI_ASSETS, f), `${f} is not embedded`);
    assert.ok(UI_FILES.includes(f), `${f} is not in embed-ui's UI_FILES`);
  }
  const bytes = (fs: string[]) => fs.reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
  const uiBytes = bytes(ui);
  assert.ok(uiBytes <= 100 * 1024, `ui/ is ${uiBytes} bytes`);
  assert.ok(uiBytes + bytes(shared) <= 140 * 1024, `the page loads ${uiBytes + bytes(shared)} bytes`);
});
