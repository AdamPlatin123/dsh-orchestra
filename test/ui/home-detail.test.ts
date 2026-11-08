import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeElement, parseHtml } from '../helpers/fake-dom.ts';
import { TOWER_TEXT } from '../../shared/strings.js';

// A read-only session's detail on the page: ui/home.js booted against the real ui/home.html in the fake DOM, with
// the browser's powers stubbed and the frame queue flushed by hand (moved from the old tower page's boot test,
// 2026-11-08: ui/drive.js reads the detail for both). What it proves: the page polls only /api/tower and
// /api/peek/session before the unlock; a session read that gets no answer goes out again 2, 4 and 8 s after its
// answer, then no more on the same rev, and says so; only the latest read's answer lands; a tower that breaks the
// contract is not shown, the alert says so and the last one stays. Synthetic data only (the golden tower).

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/home.html', import.meta.url)), 'utf8');
const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/tower-snapshot.json', import.meta.url)), 'utf8')) as Record<string, any>;
const HOME = pathToFileURL(fileURLToPath(new URL('../../ui/home.js', import.meta.url))).href;

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

test('a session read: timeouts said and retried 2, 4 and 8 s after, then no more on the rev; only the latest answer lands; a broken tower is not shown', async () => {
  const doc = parseHtml(HTML);
  const frames: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const fetched: string[] = [];
  let mono = 1000;
  let tower: Record<string, any> = structuredClone(GOLDEN);
  /** How the next session reads fail: as a fetch past its deadline, or not at all. */
  let sessionFails: 'timeout' | null = null;
  /** While set, session reads wait here until the test answers them, each in the order it picks. */
  let held: { url: string; answer: (timeout: boolean) => void }[] | null = null;
  const loc = { hash: '', href: '', pathname: '/', search: '', replace(u: string) { this.hash = u.slice(u.indexOf('#')); } };
  const win = {};
  Object.assign(doc, { hidden: false, addEventListener: (t: string, fn: Listener) => on(doc, t, fn) });
  (FakeElement.prototype as any).addEventListener = function (this: object, t: string, fn: Listener) { on(this, t, fn); };
  const g = globalThis as any;
  const saved = Object.fromEntries(['document', 'location', 'window', 'fetch', 'performance', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Element', 'Node', 'localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { configurable: true, writable: true, value: v });
  define('document', doc);
  define('location', loc);
  define('window', { addEventListener: (t: string, fn: Listener) => on(win, t, fn), matchMedia: () => ({ matches: false }) });
  define('performance', { now: () => mono });
  define('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  define('setInterval', (fn: () => void) => { intervals.push(fn); return intervals.length; });
  define('clearInterval', () => {});
  define('setTimeout', () => 0);
  define('clearTimeout', () => {});
  define('Element', FakeElement);
  define('Node', FakeElement);
  // Storage blocked: the page still runs.
  define('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  const answer = (url: string) => ({ status: 200, ok: true, json: async () => ({ session: { id: url.slice(-20) }, events: [{ at: '2026-11-02T10:00:00.000Z', type: 'assistant', text: 'synthetic event' }], unparsed: 0, note: null }) });
  define('fetch', async (url: string) => {
    fetched.push(url);
    // A timeout comes back when the page's 4 s deadline has passed, not at once.
    if (sessionFails === 'timeout' && url.startsWith('/api/peek/session')) {
      mono += 4000;
      throw new DOMException('signal timed out', 'TimeoutError');
    }
    if (held !== null && url.startsWith('/api/peek/session')) {
      const list = held;
      return new Promise((resolve, reject) => list.push({ url, answer: (timeout) => (timeout ? reject(new DOMException('signal timed out', 'TimeoutError')) : resolve(answer(url))) }));
    }
    if (url === '/api/tower') return { status: 200, ok: true, json: async () => structuredClone(tower) };
    return answer(url);
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    while (frames.length > 0) frames.shift()!();
  };
  try {
    await import(HOME);
    await flush();
    const detail = doc.getElementById('detail')!;
    const ro = () => doc.getElementById('rail')!.querySelector('[data-slot=ro]')!.children;
    assert.equal(doc.documentElement!.getAttribute('data-ready'), '1');
    assert.equal(doc.title, TOWER_TEXT['home.titleWait']!.replace('{n}', '2'));
    assert.equal(doc.getElementById('pins')!.querySelectorAll('.pin').length, 2);
    assert.deepEqual([...new Set(fetched)], ['/api/tower']);

    // A route to a read-only agent opens it (its group unfolds); its session is read once.
    const claude = GOLDEN.projects[0].nodes.find((n: any) => n.harness === 'claude' && n.layer === 'agent');
    // Its first read gets no answer within the page's deadline: the note says so, not "network".
    sessionFails = 'timeout';
    loc.hash = `#/n/${claude.id}`;
    fire(win, 'hashchange');
    await flush();
    assert.equal(detail.getAttribute('data-mode'), 'node');
    assert.equal(detail.querySelector('[data-slot=title]')!.textContent, claude.title);
    assert.equal(ro().length, 3, 'the read-only group is open on it');
    assert.ok(fetched.includes(`/api/peek/session?id=${claude.session}`));
    await flush();
    assert.equal(detail.querySelector('[data-slot=evNote]')!.textContent, TOWER_TEXT['detail.err.timeout']!.replace('{s}', '4'));
    assert.equal(detail.querySelectorAll('.ev').length, 0);
    const reads = () => fetched.filter((u) => u === `/api/peek/session?id=${claude.session}`).length;
    assert.equal(reads(), 1);
    // The answer came back 4 s after the read went out: the next goes out POLL_MS after the answer, not
    // at once, then 4 s and 8 s after the next answers, on the same rev; one read at a time.
    const tick = async (ms: number) => {
      mono += ms;
      intervals[1]!();
      await flush();
      await flush(); // a read that went out has its answer back
    };
    await tick(0);
    await tick(1000);
    assert.equal(reads(), 1, 'nothing at once, nor 1 s after the failed answer');
    await tick(1000);
    assert.equal(reads(), 2, '2 s after it');
    await tick(3000);
    assert.equal(reads(), 2);
    await tick(1000);
    assert.equal(reads(), 3, '4 s after the second');
    await tick(7000);
    assert.equal(reads(), 3);
    await tick(1000);
    assert.equal(reads(), 4, '8 s after the third');
    // Four reads in a row got no answer: no more on the same rev, and the note says so.
    for (let i = 0; i < 6; i++) await tick(10_000);
    assert.equal(reads(), 4);
    assert.equal(detail.querySelector('[data-slot=evNote]')!.textContent, TOWER_TEXT['detail.err.timeout.last']!.replace('{s}', '4').replace('{n}', '4'));
    // A new rev reads it again, and it lands.
    sessionFails = null;
    tower.meta.rev = '00000000000000aa';
    intervals[0]!();
    await flush();
    await tick(0);
    assert.equal(reads(), 5);
    await flush();
    assert.equal(detail.querySelectorAll('.ev').length, 1);
    // A read that landed is not read again on the same rev.
    await tick(5000);
    assert.equal(reads(), 5);

    // Answers out of order: A (a new rev), B, then A again go out; the first A's answer, a timeout,
    // comes back while the second is out. Only the latest read's answer lands, and no other read of A
    // goes out meanwhile.
    const other = GOLDEN.projects[0].nodes.find((n: any) => n.layer === 'agent' && typeof n.session === 'string' && n.session !== claude.session);
    assert.ok(other !== undefined, 'the golden tower has a second agent with a session');
    const select = async (id: string) => {
      fire(doc, 'click', { target: ro().map((li) => li.querySelector('.rr')!).find((b) => b.getAttribute('data-node') === id)!.querySelector('[data-slot=name]') });
      await flush();
    };
    const queue: { url: string; answer: (timeout: boolean) => void }[] = [];
    held = queue;
    tower.meta.rev = '00000000000000bb';
    intervals[0]!();
    await flush();
    await tick(0);
    assert.equal(reads(), 6, 'A1');
    await select(other.id);
    await select(claude.id);
    assert.equal(reads(), 7, 'A2');
    assert.deepEqual(queue.map((q) => q.url), [`/api/peek/session?id=${claude.session}`, `/api/peek/session?id=${other.session}`, `/api/peek/session?id=${claude.session}`]);
    queue[0]!.answer(true);
    await flush();
    assert.equal(detail.querySelector('[data-slot=evNote]')!.textContent, TOWER_TEXT['detail.loading'], 'A1 did not land');
    await tick(3000);
    await tick(3000);
    assert.equal(reads(), 7, 'no read of A while A2 is out');
    queue[1]!.answer(false);
    queue[2]!.answer(false);
    held = null;
    await flush();
    await flush();
    assert.equal(detail.querySelectorAll('.ev').length, 1, 'A2 landed');
    await tick(5000);
    assert.equal(reads(), 7);
    assert.equal(loc.hash, `#/n/${claude.id}`);
    assert.equal(doc.textContent.includes('完成'), false);

    // A payload that breaks the contract is not shown: the alert says so and the last tower stays.
    assert.equal(doc.getElementById('alert')!.getAttribute('data-hide'), '1');
    tower = { meta: { v: 2 } };
    intervals[0]!();
    await flush();
    assert.equal(doc.getElementById('alert')!.getAttribute('data-hide'), '0');
    assert.equal(ro().length, 3);
    assert.equal(detail.querySelector('[data-slot=title]')!.textContent, claude.title);
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
