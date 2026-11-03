import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImports } from '../helpers/scan-rules.ts';
import { parseHtml, type FakeElement, type FakeText } from '../helpers/fake-dom.ts';
import { UI_ASSETS } from '../../src/server/ui-assets.ts';
import { UI_FILES } from '../../scripts/embed-ui.ts';
import { TOWER_TEXT } from '../../shared/strings.js';
import { STAGE_ENUMS } from '../../shared/stage-contract.js';
import { TOWER_ENUMS } from '../../shared/tower-contract.js';

// ui/tower.html and ui/tower.css under the page CSP of the peek server (script-src 'self', style-src
// 'self', require-trusted-types-for 'script', trusted-types 'none'), the text rule (every word from
// shared/strings.js), the colour rule of the chart palette (one colour, one meaning: P1), motion only
// without a reduced-motion preference, the narrow layout, and the size budget of what the browser loads.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HTML = read('ui/tower.html');
const CSS = read('ui/tower.css');
const UI_JS = fs.readdirSync(path.join(REPO, 'ui')).filter((f) => f.endsWith('.js')).map((f) => `ui/${f}`);
const HAN = /[㐀-鿿豈-﫿　-〿＀-￯]/;

test('tower.html carries no inline script, style, handler, form or named input; one module script, one stylesheet', () => {
  assert.equal([...HTML.matchAll(/<script\b/g)].length, 1);
  assert.match(HTML, /<script type="module" src="\/assets\/ui\/app\.js"><\/script>/);
  assert.doesNotMatch(HTML, /<script(?![^>]*\bsrc=)[^>]*>/, 'an inline script');
  assert.doesNotMatch(HTML, /<style\b/);
  assert.doesNotMatch(HTML, /\sstyle\s*=/);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(HTML, /<form\b/i);
  assert.doesNotMatch(HTML, /<(?:input|select|textarea|button)\b[^>]*\sname\s*=/i);
  assert.deepEqual([...HTML.matchAll(/\sname\s*=\s*"([^"]*)"/g)].map((m) => m[1]), ['viewport', 'color-scheme']);
  assert.doesNotMatch(HTML, /javascript:/i);
  assert.doesNotMatch(HTML, /<a\b/i, 'no link: the page navigates through ui/route.js only');
  assert.match(HTML, /<link rel="stylesheet" href="\/assets\/ui\/tower\.css">/);
  const icons = [...HTML.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(icons.length, 1);
  assert.ok(icons[0]!.startsWith('data:image/svg+xml,'));
});

test('tower.html: an ARIA tree, a polite live region, an alert, and every template ui/view.js and ui/owned.js name', () => {
  const doc = parseHtml(HTML);
  const tree = doc.getElementById('tree')!;
  assert.equal(tree.getAttribute('role'), 'tree');
  assert.equal(tree.getAttribute('aria-labelledby'), 'tower-h tree-name', 'the tree is named in words, not only by its metaphor');
  assert.equal(doc.getElementById('tree-name')!.getAttribute('data-t'), 'tree.label');
  assert.equal(doc.getElementById('live')!.getAttribute('aria-live'), 'polite');
  assert.equal(doc.getElementById('alert')!.getAttribute('role'), 'alert');
  const view = read('ui/view.js') + read('ui/owned.js');
  const named = [...new Set([...view.matchAll(/tpl: '(tpl-[a-z]+)'/g)].map((m) => m[1]!))].sort();
  assert.deepEqual(named, ['tpl-arow', 'tpl-btn', 'tpl-cand', 'tpl-card', 'tpl-ev', 'tpl-group', 'tpl-kv', 'tpl-msg', 'tpl-node', 'tpl-opt', 'tpl-pin', 'tpl-proj', 'tpl-req', 'tpl-rule', 'tpl-src', 'tpl-tool']);
  for (const id of named) assert.ok(doc.getElementById(id)?.content?.firstElementChild, `no <template id=${id}>`);
  for (const id of ['tpl-node', 'tpl-proj', 'tpl-group']) {
    const li = doc.getElementById(id)!.content!.firstElementChild!;
    assert.deepEqual([li.localName, li.getAttribute('role'), li.getAttribute('tabindex')], ['li', 'treeitem', '-1'], id);
  }
  // The counts are buttons that say whether their filter is on.
  for (const f of ['waiting', 'error', 'running']) assert.equal(doc.querySelector(`[data-filter=${f}]`)!.getAttribute('aria-pressed'), 'false');
  // Room for the next phase's composer, said to be read only now.
  assert.equal(doc.getElementById('dock')!.getAttribute('aria-disabled'), 'true');
});

test('every word comes from shared/strings.js: no Han text in ui/, and every key the page names exists', () => {
  // The page shell holds no text at all but its <title>: fillStatic writes each [data-t] at boot.
  const doc = parseHtml(HTML);
  const texts: string[] = [];
  const walk = (el: { childNodes: unknown[] }, inTitle: boolean) => {
    for (const c of el.childNodes as (FakeElement | FakeText)[]) {
      if ('data' in c) { if (!inTitle) texts.push(c.data); } else {
        walk(c, inTitle || c.localName === 'title');
        if (c.content !== null) walk(c.content, false);
      }
    }
  };
  walk(doc, false);
  assert.deepEqual(texts, []);
  for (const f of ['ui/tower.html', ...UI_JS]) assert.doesNotMatch(read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), HAN, `${f} holds Han text outside comments`);
  const keys = new Set<string>();
  for (const m of HTML.matchAll(/data-t="([^"]+)"/g)) keys.add(m[1]!);
  for (const f of UI_JS) for (const m of read(f).matchAll(/\bt\('([^'$`]+)'/g)) keys.add(m[1]!);
  assert.ok(keys.size > 80, String(keys.size));
  for (const k of keys) assert.ok(Object.hasOwn(TOWER_TEXT, k), `TOWER_TEXT has no ${k}`);
  // The keys ui/view.js builds from an enum: every value has its text.
  const families: [string, readonly string[]][] = [
    ['state', TOWER_ENUMS.state], ['icon', [...TOWER_ENUMS.state.filter((s) => s !== 'waiting'), ...TOWER_ENUMS.waitingKind]], ['basis', TOWER_ENUMS.basis],
    ['own', TOWER_ENUMS.ownership], ['own', TOWER_ENUMS.ownership.map((o) => `${o}Long`)], ['harness', TOWER_ENUMS.harness],
    ['wait', TOWER_ENUMS.waitingKind], ['source', TOWER_ENUMS.waitingSource], ['group', ['returned', 'idle', 'same']],
    ['count', ['waiting', 'error', 'running']], ['theme', ['auto', 'light', 'dark']], ['note', STAGE_ENUMS.note],
    ['age', ['s', 'm', 'h', 'd']], ['ago', ['s', 'm', 'h', 'd']],
  ];
  for (const [p, vs] of families) for (const v of vs) assert.ok(Object.hasOwn(TOWER_TEXT, `${p}.${v}`), `${p}.${v}`);
});

test('T2: no text of the page says done; one glyph, one meaning among the icons (P1)', () => {
  for (const [k, v] of Object.entries(TOWER_TEXT)) assert.equal(v.includes('完成'), false, k);
  const icons = Object.entries(TOWER_TEXT).filter(([k]) => k.startsWith('icon.')).map(([, v]) => v);
  assert.equal(new Set(icons).size, icons.length);
  assert.ok(!icons.includes('✓'), 'no check mark: it reads as done');
});

/** Every rule of the stylesheet with its selector, the at-rules it sits in, and its declarations. */
function cssRules(css: string): { sel: string; at: string; body: string }[] {
  const out: { sel: string; at: string; body: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (src: string, at: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(body, `${at} ${head}`.trim());
      else out.push({ sel: head, at, body });
      i = j;
    }
  };
  walk(text, '');
  return out;
}

test('one colour, one meaning: yellow only for waiting, vermilion only for errors, teal only for running', () => {
  const rules = cssRules(CSS);
  const uses = (name: string) => rules.filter((r) => new RegExp(`var\\(--${name}\\)`).test(r.body));
  const only: [string, RegExp][] = [
    ['wait', /waiting|data-filter=waiting|\.pin|\.k-w/],
    ['err', /error|data-filter=error|\.k-e|\.alert|keys-mismatch/],
    ['run', /running|data-filter=running/],
  ];
  for (const [name, ok] of only) {
    const u = uses(name);
    assert.ok(u.length > 0, name);
    for (const r of u) {
      // A token definition passes its value on; every use names what it marks.
      if (/^--/m.test(r.body.trim()) && r.sel.includes(':root')) continue;
      for (const s of r.sel.split(',')) assert.match(s, ok, `--${name} used by ${s.trim()}`);
    }
  }
  // The signal values appear only in the token blocks, never written straight into a rule.
  const tokens = rules.filter((r) => r.sel.startsWith(':root')).map((r) => r.body).join('\n');
  for (const hex of ['#C98A00', '#F0B429', '#C2362B', '#FF6A5C', '#1C7487', '#4DB0C2']) {
    assert.ok(tokens.includes(hex), hex);
    const elsewhere = rules.filter((r) => !r.sel.startsWith(':root')).some((r) => r.body.toUpperCase().includes(hex));
    assert.equal(elsewhere, false, hex);
  }
  // Both themes define every signal and harness token: by preference and by data-theme.
  const dark = rules.filter((r) => r.sel.includes(':root') && /color-scheme: dark/.test(r.body));
  assert.equal(dark.length, 2);
  assert.ok(dark.some((r) => r.at.includes('prefers-color-scheme: dark') && r.sel.includes(':not([data-theme=light])')));
  for (const d of dark) for (const tkn of ['paper', 'ink', 'wait', 'err', 'run', 'claude', 'dsh', 'codex']) assert.match(d.body, new RegExp(`--${tkn}:`), tkn);
  // Text sizes: nothing below 12px (meta is 12.5px), as the chart direction asks.
  for (const m of CSS.matchAll(/font-size: ([\d.]+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
  assert.match(CSS, /--row: 30px;/);
  assert.match(CSS, /font-variant-numeric: tabular-nums/);
});

test('motion: animations only without a reduced-motion preference; keyframes only fade and turn', () => {
  const rules = cssRules(CSS);
  for (const r of rules) {
    if (/\banimation\b/.test(r.body)) assert.ok(r.at.includes('prefers-reduced-motion: no-preference'), `${r.sel} animates outside the motion query`);
  }
  for (const m of CSS.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g)) {
    for (const d of m[2]!.matchAll(/([\w-]+):/g)) assert.ok(['opacity', 'transform'].includes(d[1]!), `${m[1]}: ${d[1]}`);
  }
  // A state change replays the flash: one keyframe name per state, so the name changes with it.
  for (const s of TOWER_ENUMS.state) assert.match(CSS, new RegExp(`\\.row\\[data-flash=${s}\\]::after \\{ animation: flash-${s} 1\\.2s`));
  // Waiting stands still: no rule animates a waiting row.
  assert.ok(!rules.some((r) => /data-state=waiting/.test(r.sel) && /animation/.test(r.body)));
});

test('wide screens: the waiting bar, the split and the dock keep their rows, so an empty (hidden) bar never squeezes the dock to 0px', () => {
  const wide = cssRules(CSS).filter((r) => r.at.includes('min-width: 900px'));
  const rowOf = (sel: string) => wide.find((r) => r.sel === sel)?.body.match(/grid-row: (\d)/)?.[1];
  assert.match(wide.find((r) => r.sel === '.main')!.body, /grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.equal(rowOf('.pins'), '1');
  assert.equal(rowOf('.split'), '2', 'the tree and detail take the 1fr row');
  assert.equal(rowOf('.main > .dock'), '3', 'the composer and stop buttons take the last auto row');
});

test('narrow screens: one column, rows 44px tall, the node page full screen, nothing wider than the screen', () => {
  const rules = cssRules(CSS);
  const narrow = rules.filter((r) => r.at.includes('max-width: 899px'));
  const phone = rules.filter((r) => r.at.includes('max-width: 720px'));
  assert.ok(narrow.some((r) => r.sel.includes('.cols') && /display: none/.test(r.body)));
  assert.ok(narrow.some((r) => r.sel === '.detail' && /display: none/.test(r.body)));
  assert.ok(narrow.some((r) => r.sel.includes(':root[data-view=node] .detail') && /display: block/.test(r.body)));
  assert.ok(narrow.some((r) => r.sel.includes(':root[data-view=node] .tower') && /display: none/.test(r.body)));
  assert.ok(phone.some((r) => r.sel === ':root' && /--row: 44px/.test(r.body)));
  assert.ok(phone.some((r) => r.sel === '.count' && /min-height: 44px/.test(r.body)));
  // A button acting on an owned session (an approval card's, the composer's) is 44px tall at any width;
  // on a phone every button is, the waiting bar's included.
  assert.ok(rules.some((r) => r.sel === '.acts .btn' && r.at === '' && /min-height: 44px/.test(r.body)));
  assert.ok(phone.some((r) => r.sel === '.op, .btn' && /min-height: 44px/.test(r.body)));
  // No fixed width past 375px outside the wide-screen query; long text ellipsizes instead of pushing.
  for (const r of rules.filter((x) => !x.at.includes('min-width: 900px'))) {
    for (const m of r.body.matchAll(/(?:^|;|\s)(?:min-)?width: (\d+)px/g)) assert.ok(Number(m[1]) <= 375, `${r.sel}: ${m[0]}`);
  }
  for (const sel of ['.act', '.nm', '.pin-path']) {
    const r = rules.find((x) => x.sel === sel && x.at === '');
    assert.ok(r !== undefined && /text-overflow: ellipsis/.test(r.body) && /white-space: nowrap/.test(r.body), sel);
  }
  assert.ok(rules.some((r) => r.sel === '.ab-table' && /overflow-x: auto/.test(r.body)), 'the about table scrolls inside itself');
});

test('what the browser loads for / stays within budget: ui/ itself and the shared modules it imports', () => {
  const ui = fs.readdirSync(path.join(REPO, 'ui')).map((f) => `ui/${f}`);
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const r of findImports(read(rel))) if (r.form !== 'dynamic' && /^\.\.?\//.test(r.spec)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), r.spec)));
  };
  walk('ui/app.js');
  const shared = [...seen].filter((f) => f.startsWith('shared/')).sort();
  // strings.js imports only frozen.js, and the daemon holds each tower to its contract before it answers:
  // the page loads neither protocol.js nor tower-contract.js (orchestra app, owned sessions in the tower).
  assert.deepEqual(shared, ['shared/frozen.js', 'shared/strings.js']);
  // The daemon embeds the page (src/server/ui-assets.ts, made by scripts/embed-ui.ts from UI_FILES):
  // every module the page loads must be in both, or the browser meets a 404 halfway through the graph.
  for (const f of [...seen, 'ui/tower.html', 'ui/tower.css']) {
    assert.ok(Object.hasOwn(UI_ASSETS, f), `${f} is not embedded`);
    assert.ok(UI_FILES.includes(f), `${f} is not in embed-ui's UI_FILES`);
  }
  assert.deepEqual([...ui].sort(), [...seen].filter((f) => f.startsWith('ui/')).concat(['ui/tower.css', 'ui/tower.html']).sort(), 'every file in ui/ is loaded by the page');
  const bytes = (fs: string[]) => fs.reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
  const uiBytes = bytes(ui);
  // Caps: the user set page 168 KiB, ui/ 120 KiB (2026-11-02); widened to page 240 KiB, ui/ 200 KiB the
  // same day for the whole-app goal (dispatch desk and more to come). Plan: divergences and residual risks.
  assert.ok(uiBytes <= 200 * 1024, `ui/ is ${uiBytes} bytes`);
  assert.ok(uiBytes + bytes(shared) <= 240 * 1024, `the page loads ${uiBytes + bytes(shared)} bytes`);
});
