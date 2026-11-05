// @ts-check
// The tower page's boot (orchestra app plan §5), the one module with effects: the 2 s poll (10 s while
// hidden), the route, clicks and keys, one render per frame. Owned sessions are driven once this tab is
// unlocked (slice design §2.7), each allow under r4 §10.9's guards (D8), by ui/drive.js, which the home page
// (ui/home.js) shares; ui/owned.js says what shows.
// Under the pointer or focus the tree's order holds (research §1.5): changes count on "↻ N".
import { TIMEOUT_MS, getTower, oneAtATime } from './api.js';
import { after, every, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { POLL_MS, driveState, makeDrive } from './drive.js';
import { getTheme } from './prefs.js';
import { whyText } from './owned.js';
import { go, openFull, parse } from './route.js';
import { FILTERS, buildRows, freeze, groupKey, indexOf, navigate, projectKey, towerFrame } from './tree.js';
import { clippedSessions, describeAbout, describeBar, describeDetail, describeTower, detectsError, t } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('./tree.js').Row} Row
 * @typedef {import('./tree.js').Filter} Filter
 * @typedef {import('./view.js').Detail} Detail
 */

const STALE_MS = 10000;
const QUIET_MS = 5000;
const HIDDEN_MS = 10000;
/** A changed row lights up this long (research §1.5; the CSS animation's length). */
const FLASH_MS = 1200;
/** Below this width a node opens its own page (tower.css). */
const NARROW = '(max-width: 899px)';
const narrow = () => window.matchMedia(NARROW).matches;
const dom = makePatcher(document);
const treeEl = dom.byId('tree');
const towerEl = dom.byId('tower');
const pinsEl = dom.byId('pins');
const state = {
  ...driveState(),
  /** @type {string | null} */ error: null,
  route: parse(location.hash),
  /** @type {Filter | null} */ filter: null,
  /** @type {Set<string>} */ collapsed: new Set(),
  /** @type {Set<string>} */ open: new Set(),
  /** @type {Set<string>} */ peek: new Set(),
  theme: getTheme(),
  hover: false,
  focusIn: false,
  /** Cancels the pending unfreeze. @type {(() => void) | null} */ quiet: null,
  /** The frozen layout. @type {Row[] | null} */ held: null,
  /** The rows on screen. @type {Row[]} */ rows: [],
  /** @type {Map<string, string>} */ lastState: new Map(),
  /** A changed row's new state, lit once until `until`. @type {Map<string, { state: string, until: number }>} */ flash: new Map(),
  /** The last render's view, to move the focus when the node page opens or closes. */ lastView: 'tower',
  /** @type {number | null} */ lastWaiting: null,
  /** A row to focus after the next render. @type {string | null} */ focusKey: null,
  queued: false,
};

const frozen = () => state.hover || state.focusIn || state.quiet !== null;
/** The tab's count. Painted by render and, while hidden (no frames then), by every tower read.
 * A pending agent request waits for you too (seat): the tab says so, though the bar's 等你 filters nodes only.
 * @param {TowerSnapshot} snap */
function paintTitle(snap) {
  const waiting = snap.tally.waiting + (snap.router.asks?.length ?? 0);
  dom.title(waiting > 0 ? t('page.titleWait', { n: waiting }) : t('page.title'));
}

function schedule() {
  if (state.queued || document.hidden) return;
  state.queued = true;
  onFrame(() => {
    state.queued = false;
    render();
  });
}

function render() {
  const root = document.documentElement;
  const view = state.route.view === 'about' ? 'about' : state.route.node !== null ? 'node' : 'tower';
  dom.paint(root, { data: { theme: state.theme, view, ready: state.snap === null ? '0' : '1', filter: state.filter ?? '' } });
  dom.paintId('alert', { text: state.error ?? '', data: { hide: state.error === null ? '1' : '0' } });
  const ageMs = state.okMono === null ? null : nowMono() - state.okMono;
  const snap = state.snap;
  const bar = describeBar(snap, { filter: state.filter, ageMs, stale: ageMs !== null && ageMs > STALE_MS, theme: state.theme, view });
  const open = state.csrf !== null;
  Object.assign(/** @type {any} */ (bar.slots), { new: { text: t(open ? 'bar.new' : 'bar.newLocked'), attr: { title: t('bar.newHint') } }, unlock: { text: t(open ? 'bar.unlocked' : 'bar.unlock') } });
  dom.paintId('bar', bar);
  dom.paintId('note', { text: state.note ?? '', data: { hide: state.note === null ? '1' : '0' } });
  drive.paintDesk();
  if (snap === null) return;
  paintTitle(snap);

  const fresh = buildRows(snap, { filter: state.filter, collapsed: state.collapsed, open: state.open });
  let pending = 0;
  let rows = fresh;
  if (frozen() && state.held !== null) ({ rows, pending } = freeze(fresh, state.held));
  state.held = frozen() ? rows : null;
  state.rows = rows;

  const wall = drive.nowWall();
  // A flash plays once: a row shown again later does not light up for a change long gone.
  /** @type {Map<string, string>} */
  const flash = new Map();
  const mono = nowMono();
  for (const [id, f] of state.flash) {
    if (mono < f.until) flash.set(id, f.state);
    else state.flash.delete(id);
  }
  const pinBar = drive.holdPins(snap);
  drive.settleOn(pinBar);
  dom.paintId('pins', drive.pinsPaint(snap, pinBar));
  dom.paintId('tower', describeTower(rows, {
    filter: state.filter, pending, sel: state.sel, peek: state.peek, flash, detectsError: detectsError(snap), clipped: clippedSessions(snap), dispatch: snap.router.dispatch, nowWall: wall,
    // Whether the dispatch desk is on: only the owned list says (after the unlock); before that, unknown (T1).
    desk: state.owned === null ? null : state.owned.enabled === false ? { on: false, why: whyText(state.owned.disabledWhy ?? '') } : { on: true }, unlocked: state.csrf !== null,
    // An owned row names the folder it works in, once unlocked (the list carries it; the tower never does).
    cwdOf: (/** @type {string} */ id) => state.owned?.owned?.find((/** @type {any} */ o) => `n:${o.ownedId}` === id)?.cwd?.path ?? null,
  }));
  drive.paintSession(snap, describeDetail(snap, state.sel, rows, drive.detailFor(snap), { nowWall: wall, fmtIso }));
  const about = dom.byId('about');
  dom.paint(about, { data: { hide: view === 'about' ? '0' : '1' } });
  if (view === 'about') dom.paint(about, describeAbout(snap));

  // Narrow: the node page replaces the tree; the focus goes to its title, and back to its row on closing.
  const was = state.lastView;
  state.lastView = view;
  if (view === 'node' && was !== 'node' && narrow()) {
    state.focusKey = null;
    /** @type {HTMLElement} */ (dom.byId('dt-title')).focus();
  } else if (view === 'tower' && was === 'node' && state.sel !== null && narrow()) {
    state.focusKey = state.sel;
  }
  if (state.focusKey !== null) {
    const el = dom.keyed(treeEl, state.focusKey);
    state.focusKey = null;
    if (el !== null) /** @type {HTMLElement} */ (el).focus();
  }
  drive.moveFocusOn();
}

const drive = makeDrive(state, dom, { schedule, render, poll, openNode, homeId: 'tower-h' });

const towerOnce = oneAtATime(getTower);

async function poll() {
  const a = await towerOnce();
  if (a === null) return;
  if (!a.ok) {
    state.error = a.code === 'unpaired' ? t('err.unpaired') : a.code === 'network' ? t('err.network') : a.code === 'timeout' ? t('err.timeout', { s: TIMEOUT_MS / 1000 }) : t('err.http', { code: a.code });
    return schedule();
  }
  const body = /** @type {any} */ (a.body);
  const same = state.snap !== null && body !== null && typeof body === 'object' && body.meta?.rev === state.snap.meta.rev;
  if (!same) {
    // The daemon holds the contract (src/server/http.ts); the page checks the frame.
    const why = towerFrame(body);
    if (why !== null) {
      state.error = t('err.shape', { why });
      return schedule();
    }
  }
  const snap = /** @type {TowerSnapshot} */ (body);
  state.error = null;
  state.okMono = nowMono();
  // A changed state lights its row once (research §1.5).
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const p of snap.projects) {
    for (const n of p.nodes) {
      const was = state.lastState.get(n.id);
      if (was !== undefined && was !== n.state) state.flash.set(n.id, { state: n.state, until: nowMono() + FLASH_MS });
      seen.set(n.id, n.state);
    }
  }
  for (const id of state.flash.keys()) if (!seen.has(id)) state.flash.delete(id);
  state.lastState = seen;
  // The screen reader hears the waiting count when it moves.
  if (state.lastWaiting !== null && state.lastWaiting !== snap.tally.waiting) dom.say(dom.byId('live'), t('live.wait', { n: snap.tally.waiting }));
  state.lastWaiting = snap.tally.waiting;
  state.snap = snap;
  if (state.route.node !== null && state.sel === null) select(state.route.node, false);
  // Hidden, schedule() draws nothing: the tab's count is painted here so it moves in the background too.
  if (document.hidden) paintTitle(snap);
  schedule();
}

/** @type {(() => void)[]} */
let timers = [];
function wake() {
  timers.forEach((stop) => stop());
  // Hidden: the tower and the queue every 10 s, for the tab's count and the notifications.
  timers = document.hidden ? [every(HIDDEN_MS, () => { void poll(); drive.pollOwned(); })] : [every(POLL_MS, () => { void poll(); drive.pollOwned(); drive.pollFeed(); }), every(1000, schedule)];
  if (!document.hidden) void poll();
  drive.pollOwned();
}

/** Selects `key` visibly: ancestors unfold, its group opens, a filter it fails drops. @param {string} key @param {boolean} focus */
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

/** Folds or unfolds a row that can (none can under a filter). @param {Row} r */
const toggle = (r) => {
  if (r.expandable) setOpen(r.key, !r.expanded);
  else schedule();
};

/** Opens a node: detail beside the tree when wide, its own page when narrow. @param {string} key */
function openNode(key) {
  select(key, false);
  go({ view: 'tower', node: key }, !narrow());
}

/** Opens a row: a node's page, else its fold. @param {Row} r */
function openRow(r) {
  if (r.kind === 'node') {
    openNode(r.key);
  } else {
    state.sel = r.key;
    toggle(r);
  }
}

// == freezing: the pointer or focus holds the tree's order; leaving starts the quiet timer
function hold() {
  if (state.quiet !== null) {
    state.quiet();
    state.quiet = null;
  }
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
  if (drive.act(t0)) return;
  const a = t0.dataset.act;
  if (a === 'see') return openNode(/** @type {any} */ (t0.closest('.pin')).dataset.node);
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
  // A bar entry opens its node (wide: the focus follows).
  const pin = t0.classList.contains('pin-go') ? t0.closest('.pin') : null;
  const node = pin === null ? undefined : /** @type {HTMLElement} */ (pin).dataset.node;
  if (node !== undefined) {
    if (!narrow()) state.focusKey = node;
    return openNode(node);
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
  const el = e.target instanceof Element ? e.target.closest('[data-act],[data-filter],.pin-go') : null;
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

drive.listen(pinsEl);

window.addEventListener('hashchange', () => {
  state.route = parse(location.hash);
  if (state.route.node !== null && state.route.node !== state.sel) select(state.route.node, false);
  schedule();
});
document.addEventListener('visibilitychange', wake);

dom.fillStatic();
render();
wake();
