import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeElement, parseHtml } from '../helpers/fake-dom.ts';
import { TOWER_TEXT } from '../../shared/strings.js';

// ui/app.js booted against the real ui/tower.html in the fake DOM, with the browser's powers stubbed
// (orchestra app plan §5): the poll of /api/tower, the hash route, clicks and keys, and the frame
// queue flushed by hand. What it proves: the page boots, renders the tower it fetched, polls only
// /api/tower and /api/peek/session, selects and opens a node, moves with the keys, filters by a
// count, and freezes the order while the pointer is in the tree. Synthetic data only (the golden tower).

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/tower.html', import.meta.url)), 'utf8');
const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url)), 'utf8')) as Record<string, any>;
const APP = pathToFileURL(fileURLToPath(new URL('../../ui/app.js', import.meta.url))).href;

type Listener = (e: any) => void;
const listeners = new WeakMap<object, Map<string, Listener[]>>();
function on(target: object, type: string, fn: Listener) {
  let m = listeners.get(target);
  if (m === undefined) listeners.set(target, (m = new Map()));
  m.set(type, [...(m.get(type) ?? []), fn]);
}
function fire(target: object, type: string, e: Record<string, unknown> = {}) {
  const ev = { preventDefault() { (ev as any).prevented = true; }, isComposing: false, ...e };
  for (const fn of listeners.get(target)?.get(type) ?? []) fn(ev);
  return ev as any;
}

test('the page boots, renders the fetched tower, and drives selection, keys, filters and freezing', async () => {
  const doc = parseHtml(HTML);
  const frames: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const fetched: string[] = [];
  let mono = 1000;
  let tower: Record<string, any> = structuredClone(GOLDEN);
  /** How the next session reads fail: as a fetch past its deadline, or not at all. */
  let sessionFails: 'timeout' | null = null;
  const loc = { hash: '', href: '', pathname: '/', search: '', replaced: [] as string[], replace(u: string) { this.replaced.push(u); this.hash = u.slice(u.indexOf('#')); } };
  const win = {};
  let narrow = false;
  Object.assign(doc, { hidden: false, addEventListener: (t: string, fn: Listener) => on(doc, t, fn) });
  (FakeElement.prototype as any).addEventListener = function (this: object, t: string, fn: Listener) { on(this, t, fn); };
  const g = globalThis as any;
  const saved = Object.fromEntries(['document', 'location', 'window', 'fetch', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Element', 'Node', 'localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const timeouts: (() => void)[] = [];
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  define('document', doc);
  define('location', loc);
  define('window', { addEventListener: (t: string, fn: Listener) => on(win, t, fn), matchMedia: (q: string) => ({ matches: q === '(max-width: 899px)' && narrow }) });
  define('performance', { now: () => mono });
  define('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  define('setInterval', (fn: () => void) => { intervals.push(fn); return intervals.length; });
  define('clearInterval', () => {});
  define('setTimeout', (fn: () => void) => { timeouts.push(fn); return timeouts.length; });
  define('clearTimeout', () => {});
  define('Element', FakeElement);
  define('Node', FakeElement);
  define('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  define('fetch', async (url: string) => {
    fetched.push(url);
    if (sessionFails === 'timeout' && url.startsWith('/api/peek/session')) throw new DOMException('signal timed out', 'TimeoutError');
    const body = url === '/api/tower' ? tower : { session: { id: url.slice(-20) }, events: [{ at: '2026-11-02T10:00:00.000Z', type: 'assistant', text: 'synthetic event' }], unparsed: 0, note: null };
    return { status: 200, ok: true, json: async () => structuredClone(body) };
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    while (frames.length > 0) frames.shift()!();
  };
  try {
    await import(APP);
    await flush();
    const tree = doc.getElementById('tree')!;
    const rows = () => tree.children;
    assert.equal(rows().length, 12, 'the project and its 11 nodes');
    assert.equal(doc.documentElement!.getAttribute('data-ready'), '1');
    assert.equal(doc.title, `(2) ${TOWER_TEXT['page.title']}`);
    assert.equal(doc.getElementById('pins')!.querySelectorAll('.pin').length, 2);
    assert.deepEqual([...new Set(fetched)], ['/api/tower']);

    // A click on a node row selects it and opens its page (#/n/<id>); its session is read once.
    const claude = GOLDEN.projects[0].nodes.find((n: any) => n.harness === 'claude' && n.layer === 'agent');
    // Its first read gets no answer within the page's deadline: the note says so, not "network".
    sessionFails = 'timeout';
    const row = rows().find((r) => r.getAttribute('data-key') === claude.id)!;
    fire(doc, 'click', { target: row.querySelector('[data-slot=act]') });
    assert.equal(loc.hash, `#/n/${claude.id}`);
    assert.deepEqual(loc.replaced, [`/#/n/${claude.id}`], 'a wide-screen selection replaces the entry: no page opened, nothing for Back to close');
    fire(win, 'hashchange');
    await flush();
    assert.equal(doc.documentElement!.getAttribute('data-view'), 'node');
    assert.equal(row.getAttribute('aria-selected'), 'true');
    assert.equal(row.getAttribute('tabindex'), '0');
    const detail = doc.getElementById('detail')!;
    assert.equal(detail.getAttribute('data-mode'), 'node');
    assert.equal(detail.querySelector('[data-slot=title]')!.textContent, claude.title);
    assert.ok(fetched.includes(`/api/peek/session?id=${claude.session}`));
    await flush();
    assert.equal(detail.querySelector('[data-slot=evNote]')!.textContent, TOWER_TEXT['detail.err.timeout'].replace('{s}', '4'));
    assert.equal(detail.querySelectorAll('.ev').length, 0);
    const reads = () => fetched.filter((u) => u === `/api/peek/session?id=${claude.session}`).length;
    assert.equal(reads(), 1);
    // Within POLL_MS nothing goes out again; past it, the same rev, the read goes out again and lands.
    sessionFails = null;
    mono += 1000;
    intervals[1]!();
    await flush();
    assert.equal(reads(), 1);
    mono += 1000;
    intervals[1]!();
    await flush();
    assert.equal(reads(), 2);
    await flush();
    assert.equal(detail.querySelectorAll('.ev').length, 1);
    // A read that landed is not read again on the same rev.
    mono += 5000;
    intervals[1]!();
    await flush();
    assert.equal(reads(), 2);

    // Down moves the selection and the focus to the next row; Space opens its peek in place.
    fire(tree, 'keydown', { target: row, key: 'ArrowDown' });
    await flush();
    const next = rows()[rows().indexOf(row) + 1]!;
    assert.equal(next.getAttribute('aria-selected'), 'true');
    assert.equal(next.focused, true);
    fire(tree, 'keydown', { target: next, key: ' ' });
    await flush();
    assert.equal(next.getAttribute('data-peek'), '1');
    // Left on an open parent folds it: its subtree leaves, the rest stays.
    fire(tree, 'keydown', { target: row, key: 'ArrowLeft' });
    await flush();
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(rows().length, 12 - claude.counts.children);
    fire(tree, 'keydown', { target: row, key: 'ArrowRight' });
    await flush();
    assert.equal(rows().length, 12);

    // A count is a filter: the rows it marks are as many as it says (T3); a second click drops it.
    const btn = doc.querySelector('[data-filter=running]')!;
    fire(doc, 'click', { target: btn });
    await flush();
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(tree.querySelectorAll('[data-match=1]').length, GOLDEN.tally.running);
    fire(doc, 'click', { target: btn });
    await flush();
    assert.equal(btn.getAttribute('aria-pressed'), 'false');

    // The pointer in the tree holds the order: a poll that reorders shows as "↻ N", not as moves.
    const towerEl = doc.getElementById('tower')!;
    fire(towerEl, 'pointerenter');
    await flush();
    const order = rows().map((r) => r.getAttribute('data-key'));
    tower = structuredClone(GOLDEN);
    const p = tower.projects[0];
    const roots = p.nodes.filter((n: any) => n.parent === null);
    const subtree = (r: any) => p.nodes.filter((x: any) => x === r || x.parent === r.id || p.nodes.some((y: any) => y.parent === r.id && x.parent === y.id));
    // The two waiting agents swap places: still in state order, so the contract holds.
    assert.deepEqual(roots.map((r: any) => r.state), ['waiting', 'waiting', 'running']);
    p.nodes = [roots[1], roots[0], roots[2]].flatMap(subtree);
    tower.meta.rev = '0123456789abcdef';
    mono += 2000;
    intervals[0]!();
    await flush();
    assert.deepEqual(rows().map((r) => r.getAttribute('data-key')), order);
    const apply = doc.querySelector('[data-act=apply]')!;
    assert.equal(apply.getAttribute('data-hide'), '0');
    // Leaving starts the quiet timer; when it fires the fresh order shows.
    fire(towerEl, 'pointerleave');
    fire(towerEl, 'focusout', { relatedTarget: null });
    assert.equal(timeouts.length > 0, true);
    timeouts.at(-1)!();
    await flush();
    assert.notDeepEqual(rows().map((r) => r.getAttribute('data-key')), order);
    assert.equal(apply.getAttribute('data-hide'), '1');

    // On a narrow screen a node opens a page of its own: back on the tree the focus returns to the row
    // it came from; a waiting-bar entry (a button) opens its node's page with a history entry, and the
    // focus moves to the page's title, never staying on a hidden element.
    narrow = true;
    fire(doc, 'click', { target: doc.querySelector('[data-act=back]') });
    assert.equal(loc.hash, '#/');
    fire(win, 'hashchange');
    await flush();
    assert.equal(doc.documentElement!.getAttribute('data-view'), 'tower');
    const selected = rows().filter((r) => r.getAttribute('aria-selected') === 'true');
    assert.equal(selected.length, 1);
    selected[0]!.focused = false;
    // A node selected again by its route, then closed: its row takes the focus back.
    fire(doc, 'click', { target: selected[0]!.querySelector('[data-slot=act]') });
    assert.equal(loc.replaced.length, 1, 'a page opened on a narrow screen: a history entry');
    fire(win, 'hashchange');
    await flush();
    assert.equal(doc.getElementById('dt-title')!.focused, true);
    doc.getElementById('dt-title')!.focused = false;
    fire(doc, 'click', { target: doc.querySelector('[data-act=back]') });
    fire(win, 'hashchange');
    await flush();
    assert.equal(selected[0]!.focused, true, 'back on the tree, the row it came from has the focus');
    const pins = doc.getElementById('pins')!;
    const pinNode = pins.querySelectorAll('.pin')[1]!.getAttribute('data-node')!;
    for (const r of rows()) r.focused = false;
    doc.getElementById('dt-title')!.focused = false;
    fire(doc, 'click', { target: pins.querySelectorAll('.pin-go')[1]!.querySelector('[data-slot=kind]') });
    assert.equal(loc.hash, `#/n/${pinNode}`);
    assert.equal(loc.replaced.length, 1, 'a page opened: a history entry, so Back closes it');
    assert.equal(rows().find((r) => r.getAttribute('data-key') === pinNode)!.focused, false, 'no focus left on a row the page hides');
    fire(win, 'hashchange');
    await flush();
    assert.equal(doc.documentElement!.getAttribute('data-view'), 'node');
    assert.equal(doc.getElementById('dt-title')!.focused, true);
    narrow = false;

    // A state that changed lights its row once, for 1.2 s; past that the row loses the mark, so a row
    // put back later (unfolded, refiltered, shown again) does not replay an old change.
    tower = structuredClone(GOLDEN);
    const flip = tower.projects[0].nodes.find((n: any) => n.state === 'returned' && n.harness === 'claude');
    Object.assign(flip, { state: 'unknown', basis: 'none' });
    tower.tally.returned -= 1;
    tower.tally.unknown += 1;
    tower.meta.rev = 'fedcba9876543210';
    mono += 2000;
    intervals[0]!();
    await flush();
    const flipped = rows().find((r) => r.getAttribute('data-key') === flip.id)!;
    assert.equal(doc.getElementById('alert')!.getAttribute('data-hide'), '1');
    assert.equal(flipped.getAttribute('data-flash'), 'unknown');
    mono += 1300;
    intervals[1]!();
    await flush();
    assert.equal(flipped.getAttribute('data-flash'), '');

    // The about view, then back; nothing the page shows says done (T2).
    fire(doc, 'click', { target: doc.querySelector('[data-act=about]') });
    assert.equal(loc.hash, '#/about');
    fire(win, 'hashchange');
    await flush();
    assert.equal(doc.getElementById('about')!.getAttribute('data-hide'), '0');
    assert.equal(doc.getElementById('about')!.querySelectorAll('.rule').length, GOLDEN.meta.rules.length);
    assert.equal(doc.textContent.includes('完成'), false);
    // A payload that breaks the contract is not shown: the alert says so and the last tower stays.
    tower = { meta: { v: 2 } };
    intervals[0]!();
    await flush();
    assert.equal(doc.getElementById('alert')!.getAttribute('data-hide'), '0');
    assert.equal(rows().length, 12);
    assert.deepEqual([...new Set(fetched.map((u) => u.replace(/\?.*$/, '')))].sort(), ['/api/peek/session', '/api/tower']);
  } finally {
    await flush();
    for (const [k, d] of Object.entries(saved)) {
      if (d === undefined) delete g[k];
      else Object.defineProperty(g, k, d);
    }
    delete (FakeElement.prototype as any).addEventListener;
  }
});
