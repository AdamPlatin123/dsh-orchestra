// @ts-check
// The tower page's boot (orchestra app plan §5), the one module with top-level effects: the 2 s poll of
// /api/tower (stopped while the page is hidden), the hash route, clicks and keys, and one render per
// frame. Read only: nothing here asks orchestrad to change anything (M0).
//
// While the pointer or focus is in the tree, its order holds still (research §1.5): fresh data still
// reaches the rows that stay, and what would appear, go or move is counted on the "↻ N" button, applied
// on a click or 5 s after the pointer and focus have left.
import { getSession, getTower, oneAtATime } from './api.js';
import { after, every, fmtIso, nowMono, onFrame } from './clock.js';
import { activates, makePatcher } from './dom.js';
import { getTheme, setTheme } from './prefs.js';
import { go, openFull, parse } from './route.js';
import { FILTERS, buildRows, freeze, groupKey, indexOf, navigate, projectKey } from './tree.js';
import { describeAbout, describeBar, describeDetail, describeDock, describePins, describeTower, t } from './view.js';
import { validateTower } from '../shared/tower-contract.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */
/** @typedef {import('./tree.js').Row} Row */
/** @typedef {import('./tree.js').Filter} Filter */
/** @typedef {import('./view.js').Detail} Detail */

const POLL_MS = 2000;
const STALE_MS = 10000;
const QUIET_MS = 5000;
const dom = makePatcher(document);
const treeEl = dom.byId('tree');
const towerEl = dom.byId('tower');

const state = {
  /** @type {TowerSnapshot | null} */ snap: null,
  /** Monotonic time of the last good answer; null before the first. @type {number | null} */ okMono: null,
  /** @type {string | null} */ error: null,
  route: parse(location.hash),
  /** @type {Filter | null} */ filter: null,
  /** @type {Set<string>} */ collapsed: new Set(),
  /** @type {Set<string>} */ open: new Set(),
  /** @type {Set<string>} */ peek: new Set(),
  /** The selected row's key. @type {string | null} */ sel: null,
  theme: getTheme(),
  hover: false,
  focusIn: false,
  /** Cancels the pending unfreeze. @type {(() => void) | null} */ quiet: null,
  /** The frozen layout. @type {Row[] | null} */ held: null,
  /** The rows on screen. @type {Row[]} */ rows: [],
  /** @type {Detail | null} */ detail: null,
  detailRev: '',
  /** @type {Map<string, string>} */ lastState: new Map(),
  /** @type {Map<string, string>} */ flash: new Map(),
  /** @type {number | null} */ lastWaiting: null,
  /** A row to focus after the next render. @type {string | null} */ focusKey: null,
  queued: false,
};

const frozen = () => state.hover || state.focusIn || state.quiet !== null;

function schedule() {
  if (state.queued || document.hidden) return;
  state.queued = true;
  onFrame(() => {
    state.queued = false;
    render();
  });
}

/** The daemon's time now: its observedAt plus the monotonic time since that answer (T7). */
function nowWall() {
  if (state.snap === null || state.okMono === null) return 0;
  return state.snap.meta.observedAt + (nowMono() - state.okMono);
}

function render() {
  const root = document.documentElement;
  const view = state.route.view === 'about' ? 'about' : state.route.node !== null ? 'node' : 'tower';
  dom.paint(root, { data: { theme: state.theme, view, ready: state.snap === null ? '0' : '1', filter: state.filter ?? '' } });
  dom.paintId('alert', { text: state.error ?? '', data: { hide: state.error === null ? '1' : '0' } });
  const ageMs = state.okMono === null ? null : nowMono() - state.okMono;
  const snap = state.snap;
  dom.paintId('bar', describeBar(snap, { filter: state.filter, ageMs, stale: ageMs !== null && ageMs > STALE_MS, theme: state.theme, view }));
  if (snap === null) return;
  const waiting = snap.tally.waiting;
  dom.title(waiting > 0 ? t('page.titleWait', { n: waiting }) : t('page.title'));

  const fresh = buildRows(snap, { filter: state.filter, collapsed: state.collapsed, open: state.open });
  let pending = 0;
  let rows = fresh;
  if (frozen() && state.held !== null) ({ rows, pending } = freeze(fresh, state.held));
  state.held = frozen() ? rows : null;
  state.rows = rows;

  const wall = nowWall();
  dom.paintId('pins', describePins(snap, { sel: state.sel, nowWall: wall }));
  dom.paintId('tower', describeTower(rows, { filter: state.filter, pending, sel: state.sel, peek: state.peek, flash: state.flash }));
  dom.paintId('detail', describeDetail(snap, state.sel, rows, detailFor(snap), { nowWall: wall, fmtIso }));
  dom.paintId('dock', describeDock(snap, state.sel));
  const about = dom.byId('about');
  dom.paint(about, { data: { hide: view === 'about' ? '0' : '1' } });
  if (view === 'about') dom.paint(about, describeAbout(snap));

  if (state.focusKey !== null) {
    const el = dom.keyed(treeEl, state.focusKey);
    state.focusKey = null;
    if (el !== null) /** @type {HTMLElement} */ (el).focus();
  }
}

/**
 * The selected node's session detail, read once per session and snapshot revision.
 * @param {TowerSnapshot} snap @returns {Detail | null}
 */
function detailFor(snap) {
  const hit = state.sel === null ? undefined : indexOf(snap).byId.get(state.sel);
  const id = hit?.node.session ?? null;
  if (id === null) return null;
  if (state.detail !== null && state.detail.id === id && state.detailRev === snap.meta.rev) return state.detail;
  if (state.detail === null || state.detail.id !== id) state.detail = { id, body: null };
  state.detailRev = snap.meta.rev;
  void getSession(id).then((a) => {
    if (state.detail === null || state.detail.id !== id) return;
    state.detail = { id, body: a.ok ? /** @type {any} */ (a.body) : { error: a.code } };
    schedule();
  });
  return state.detail;
}

const towerOnce = oneAtATime(getTower);

async function poll() {
  const a = await towerOnce();
  if (a === null) return;
  if (!a.ok) {
    state.error = a.code === 'unpaired' ? t('err.unpaired') : a.code === 'network' ? t('err.network') : t('err.http', { code: a.code });
    return schedule();
  }
  const body = /** @type {any} */ (a.body);
  const same = state.snap !== null && body !== null && typeof body === 'object' && body.meta?.rev === state.snap.meta.rev;
  if (!same) {
    // A new revision is held to the contract before it is shown (T1-T3 travel with the payload).
    const v = validateTower(body);
    if (!v.ok) {
      state.error = t('err.shape', { why: v.errors[0] ?? '' });
      return schedule();
    }
  }
  const snap = /** @type {TowerSnapshot} */ (body);
  state.error = null;
  state.okMono = nowMono();
  // A state that changed lights its row once (the flash name is the new state, research §1.5).
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const p of snap.projects) {
    for (const n of p.nodes) {
      const was = state.lastState.get(n.id);
      if (was !== undefined && was !== n.state) state.flash.set(n.id, n.state);
      seen.set(n.id, n.state);
    }
  }
  for (const id of state.flash.keys()) if (!seen.has(id)) state.flash.delete(id);
  state.lastState = seen;
  // The screen reader hears only how many things wait on you, and only when that number moves.
  if (state.lastWaiting !== null && state.lastWaiting !== snap.tally.waiting) dom.say(dom.byId('live'), t('live.wait', { n: snap.tally.waiting }));
  state.lastWaiting = snap.tally.waiting;
  state.snap = snap;
  if (state.route.node !== null && state.sel === null) select(state.route.node, false);
  schedule();
}

/** @type {(() => void)[]} */
let timers = [];
function wake() {
  timers.forEach((stop) => stop());
  timers = [];
  if (document.hidden) return;
  void poll();
  timers = [every(POLL_MS, () => void poll()), every(1000, schedule)];
}

/**
 * Makes `key` visible and selected: its ancestors unfold, the group it sits in opens, and a filter it
 * does not pass is dropped.
 * @param {string} key @param {boolean} focus
 */
function select(key, focus) {
  state.sel = key;
  const snap = state.snap;
  if (snap !== null) {
    const ix = indexOf(snap);
    const hit = ix.byId.get(key);
    if (hit !== undefined) {
      if (state.filter !== null && hit.node.state !== state.filter) state.filter = null;
      state.collapsed.delete(projectKey(hit.project.id));
      for (let n = hit.node; ;) {
        const parentKey = n.parent ?? projectKey(hit.project.id);
        const groups = n.parent === null ? hit.project.groups : (ix.byId.get(n.parent)?.node.groups ?? []);
        for (const g of groups) if (g.ids.includes(n.id)) state.open.add(groupKey(parentKey, g));
        if (n.parent === null) break;
        state.collapsed.delete(n.parent);
        const up = ix.byId.get(n.parent);
        if (up === undefined) break;
        n = up.node;
      }
      state.held = null;
    }
  }
  if (focus) state.focusKey = key;
  schedule();
}

/** Folds or unfolds a row: a project or node by its key, a group by its own. @param {string} key @param {boolean} open */
function setOpen(key, open) {
  const set = key.startsWith('g:') ? state.open : state.collapsed;
  const add = key.startsWith('g:') ? open : !open;
  if (add) set.add(key);
  else set.delete(key);
  state.held = null;
  schedule();
}

/** @param {Row} r */
const toggle = (r) => setOpen(r.key, !r.expanded);

/** Opens a row: a node's page (its detail; full screen on a phone), else its fold. @param {Row} r */
function openRow(r) {
  if (r.kind === 'node') {
    select(r.key, false);
    go({ view: 'tower', node: r.key });
  } else {
    state.sel = r.key;
    toggle(r);
  }
}

// == freezing: the pointer or focus in the tree holds its order; leaving starts the quiet timer
function hold() {
  if (state.quiet !== null) {
    state.quiet();
    state.quiet = null;
  }
  // The layout on screen now is the one that holds (a fold or filter you choose lays out afresh).
  if (state.held === null && state.rows.length > 0) state.held = state.rows;
}
function release() {
  if (state.hover || state.focusIn || state.quiet !== null) return;
  state.quiet = after(QUIET_MS, () => {
    state.quiet = null;
    if (!state.hover && !state.focusIn) {
      state.held = null;
      schedule();
    }
  });
}
towerEl.addEventListener('pointerenter', () => { state.hover = true; hold(); });
towerEl.addEventListener('pointerleave', () => { state.hover = false; release(); });
towerEl.addEventListener('focusin', () => { state.focusIn = true; hold(); });
towerEl.addEventListener('focusout', (e) => {
  if (e.relatedTarget instanceof Node && towerEl.contains(e.relatedTarget)) return;
  state.focusIn = false;
  release();
});

/** @param {Element} el */
function act(el) {
  const t0 = /** @type {HTMLElement} */ (el);
  const f = t0.dataset.filter;
  if (f !== undefined) {
    const want = /** @type {Filter} */ (f);
    state.filter = state.filter === want || !FILTERS.includes(want) ? null : want;
    state.held = null;
    return schedule();
  }
  const a = t0.dataset.act;
  if (a === 'theme') {
    state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    setTheme(state.theme);
    return schedule();
  }
  if (a === 'about') return go({ view: state.route.view === 'about' ? 'tower' : 'about', node: null });
  if (a === 'clear') {
    state.filter = null;
    state.held = null;
    return schedule();
  }
  if (a === 'apply') {
    state.held = null;
    return schedule();
  }
  if (a === 'back') return go({ view: 'tower', node: null });
  if (a === 'full') {
    const hit = state.snap === null || state.sel === null ? undefined : indexOf(state.snap).byId.get(state.sel);
    if (hit !== undefined && hit.node.session !== null) openFull(hit.node.session);
    return;
  }
  const node = t0.dataset.node;
  if (node !== undefined && t0.classList.contains('pin')) {
    select(node, true);
    return go({ view: 'tower', node });
  }
}

/** The row element an event happened in, and its row. @param {EventTarget | null} target */
function rowAt(target) {
  const el = target instanceof Element ? target.closest('[data-key]') : null;
  if (el === null || !treeEl.contains(el)) return null;
  const key = /** @type {HTMLElement} */ (el).dataset.key;
  const i = state.rows.findIndex((r) => r.key === key);
  return i < 0 ? null : { el, i, row: /** @type {Row} */ (state.rows[i]) };
}

document.addEventListener('click', (e) => {
  const hit = rowAt(e.target);
  if (hit !== null) {
    const onTwisty = e.target instanceof Element && e.target.closest('.tw') !== null;
    if (onTwisty && hit.row.expandable) {
      state.sel = hit.row.key;
      return toggle(hit.row);
    }
    return openRow(hit.row);
  }
  const el = e.target instanceof Element ? e.target.closest('[data-act],[data-filter],.pin') : null;
  if (el !== null) act(el);
});

treeEl.addEventListener('keydown', (e) => {
  const hit = rowAt(e.target);
  if (hit === null || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
  const { row, i } = hit;
  if (e.key === ' ') {
    e.preventDefault();
    if (row.kind === 'node') {
      if (state.peek.has(row.key)) state.peek.delete(row.key);
      else state.peek.add(row.key);
      state.sel = row.key;
      return schedule();
    }
    state.sel = row.key;
    return toggle(row);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    return openRow(row);
  }
  const to = navigate(state.rows, i, e.key);
  if (to === null) return;
  e.preventDefault();
  if ('select' in to) {
    const r = state.rows[to.select];
    if (r === undefined) return;
    state.sel = r.key;
    state.focusKey = r.key;
    return schedule();
  }
  setOpen(to.toggle, to.open);
});

document.addEventListener('keydown', (e) => {
  if (!activates(e)) return;
  const el = e.target instanceof Element ? e.target.closest('.pin') : null;
  if (el !== null) {
    e.preventDefault();
    act(el);
  }
});

window.addEventListener('hashchange', () => {
  state.route = parse(location.hash);
  if (state.route.node !== null && state.route.node !== state.sel) select(state.route.node, false);
  schedule();
});
document.addEventListener('visibilitychange', wake);

dom.fillStatic();
render();
wake();
