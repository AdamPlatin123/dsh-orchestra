// @ts-check
// The home page's boot (第三轮方案 22), the second module with effects, beside ui/app.js for the old tower: the 2 s
// poll (10 s while hidden), the route, clicks and keys, one render per frame. ui/wings.js and ui/fold.js say what
// shows; everything done to a session goes through ui/drive.js, the old page's own code, so nothing here can
// loosen an allow. A card opens only when clicked, and a new one comes out once, never moving the reader's place.
import { TIMEOUT_MS, getTower, oneAtATime } from './api.js';
import { after, every, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { POLL_MS, driveState, makeDrive } from './drive.js';
import { atBottom } from './owned.js';
import { getTheme } from './prefs.js';
import { go, openFull, parse } from './route.js';
import { indexOf, towerFrame } from './tree.js';
import { describeDetail, detectsError, t } from './view.js';
import { avatarOf, describeErrs, describeIsland, describeLost, describeRail, describeSubs, describeTop, railList, rootOf, subCards, workersOf } from './wings.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */

const STALE_MS = 10000;
const HIDDEN_MS = 10000;
/** How long a new card stays marked: its CSS animation and a margin. */
const GROW_MS = 600;
/** After the pointer or focus left, the left list holds this long, as the old page's tree. */
const QUIET_MS = 5000;
const dom = makePatcher(document);

const state = {
  ...driveState(),
  /** @type {string | null} */ error: null,
  theme: getTheme(),
  queued: false,
  /** The capsules' lists are open. */ island: false,
  /** The read-only group is open. */ roOpen: false,
  /** The cards clicked open, by key. @type {Set<string>} */ folds: new Set(),
  /** Per worker, the cards already seen: one that appears later comes out once. @type {Map<string, Set<string>>} */ seen: new Map(),
  /** @type {Map<string, number>} */ fresh: new Map(),
  /** @type {number | null} */ lastWaiting: null,
  // The left list holds its order under the pointer or focus (research §1.5): a click picks the row it was aimed at.
  railHover: false,
  railFocus: false,
  /** Cancels the pending release. @type {(() => void) | null} */ railQuiet: null,
  /** The ids as drawn. @type {string[]} */ railOrder: [],
  /** Where the capsules' block stands on the page. */ islAt: '',
  /** The talk stood at its end at the last frame. */ chatEnd: true,
};

const railHeld = () => state.railHover || state.railFocus || state.railQuiet !== null;

/** The tab's count, as the old page's: a pending agent request waits for you too. @param {TowerSnapshot} snap */
function paintTitle(snap) {
  const waiting = snap.tally.waiting + (snap.router.asks?.length ?? 0);
  dom.title(waiting > 0 ? t('home.titleWait', { n: waiting }) : t('home.title'));
}

function schedule() {
  if (state.queued || document.hidden) return;
  state.queued = true;
  onFrame(() => {
    state.queued = false;
    render();
  });
}

/** Marks the selected worker's new cards; a worker's first look marks none, so nothing plays on opening it. @param {TowerSnapshot} snap */
function freshCards(snap) {
  const sel = state.sel;
  const keys = subCards(snap, sel).map((c) => c.key);
  if (sel !== null) {
    const had = state.seen.get(sel);
    if (had !== undefined) {
      for (const k of keys) {
        if (had.has(k)) continue;
        state.fresh.set(k, nowMono() + GROW_MS);
        after(GROW_MS, schedule);
      }
    }
    state.seen.set(sel, new Set([...(had ?? []), ...keys]));
  }
  for (const [k, until] of state.fresh) if (nowMono() >= until) state.fresh.delete(k);
  return new Set(state.fresh.keys());
}

/** The left list's order for this frame: the one drawn while it holds, else the snapshot's. @param {TowerSnapshot} snap */
function railIds(snap) {
  const { owned, readonly } = railList(snap, railHeld() ? state.railOrder : []);
  state.railOrder = [...owned, ...readonly].map((w) => w.node.id);
  return state.railOrder;
}

/**
 * Whatever moved the capsules' block moved the buttons in it under the pointer, which no change of the list says:
 * opening it, a composer of another height. Those allows are void as after a change of the list (r4 §10.9).
 */
function settlePlace() {
  const isl = /** @type {HTMLElement} */ (dom.byId('isl'));
  const at = `${isl.offsetTop}:${isl.offsetHeight}`;
  if (at === state.islAt) return;
  state.islAt = at;
  drive.settle();
}

function render() {
  const snap = state.snap;
  // Before anything here changes the chat's height, the note above it included.
  const atEnd = atBottom(dom.slot(dom.byId('detail'), 'chat'));
  dom.paint(document.documentElement, { data: { theme: state.theme, ready: snap === null ? '0' : '1' } });
  dom.paintId('alert', { text: state.error ?? '', data: { hide: state.error === null ? '1' : '0' } });
  dom.paintId('note', { text: state.note ?? '', data: { hide: state.note === null ? '1' : '0' } });
  const ageMs = state.okMono === null ? null : nowMono() - state.okMono;
  const open = state.csrf !== null;
  const top = describeTop(snap, { ageMs, stale: ageMs !== null && ageMs > STALE_MS, theme: state.theme });
  Object.assign(/** @type {any} */ (top.slots), { unlock: { text: t(open ? 'bar.unlocked' : 'bar.unlock') } });
  dom.paintId('top', top);
  dom.paintId('desk', { slots: { new: { text: t(open ? 'bar.new' : 'bar.newLocked'), attr: { title: t('bar.newHint') } } } });
  drive.paintDesk();
  if (snap === null) return;
  paintTitle(snap);
  dom.paintId('lost', describeLost(snap));

  const wall = drive.nowWall();
  const pinBar = drive.holdPins(snap);
  drive.settleOn(pinBar);
  const pins = drive.pinsPaint(snap, pinBar);
  const errs = describeErrs(snap);
  const n = /** @type {readonly unknown[]} */ (pins.slots?.list?.kids ?? []).length;
  // The last one answered, the lists fold: no open capsule over nothing, and the next one waits folded until clicked.
  if (n === 0 && errs.length === 0) state.island = false;
  dom.paintId('isl', describeIsland(pins, errs, { open: state.island, nowWall: wall, bar: pinBar, detects: detectsError(snap) }));
  dom.paintId('pins', { ...pins, data: { hide: state.island && n > 0 ? '0' : '1' } });
  dom.paintId('rail', describeRail(snap, { sel: state.sel, roOpen: state.roOpen, order: railIds(snap) }));

  const detail = describeDetail(snap, state.sel, [], drive.detailFor(snap), { nowWall: wall, fmtIso });
  const node = state.sel === null ? undefined : indexOf(snap).byId.get(state.sel)?.node;
  const face = node === undefined ? { data: { hide: '1' } } : avatarOf(node);
  Object.assign(/** @type {any} */ (detail.slots), { hav: { ...face, data: { hide: node === undefined ? '1' : '0', ...face.data } } }, node === undefined ? { empty: { text: t('home.pick') } } : {});
  drive.paintSession(snap, detail, atEnd);
  dom.paintId('subs', describeSubs(snap, state.sel, { open: state.folds, fresh: freshCards(snap) }));
  drive.moveFocusOn();
  settlePlace();
  state.chatEnd = atBottom(dom.slot(dom.byId('detail'), 'chat'));
}

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
  // The screen reader hears the waiting count when it moves.
  if (state.lastWaiting !== null && state.lastWaiting !== snap.tally.waiting) dom.say(dom.byId('live'), t('live.wait', { n: snap.tally.waiting }));
  state.lastWaiting = snap.tally.waiting;
  state.snap = snap;
  settleSel(snap);
  // Hidden, schedule() draws nothing: the tab's count is painted here so it moves in the background too.
  if (document.hidden) paintTitle(snap);
  schedule();
}

/** The route's worker (a sub-agent's route opens its session); with none, the first of Orchestra's own. A poll changes nothing the route already says, so a group folded by hand stays so. @param {TowerSnapshot} snap */
function settleSel(snap) {
  const want = parse(location.hash).node;
  const root = want === null ? null : rootOf(snap, want);
  if (root !== null) {
    if (root !== state.sel) show(root);
  } else if (state.sel === null) state.sel = workersOf(snap).owned[0]?.node.id ?? null;
}

/** Selects a worker; a read-only one's group opens so its row shows. @param {string} id */
function show(id) {
  state.sel = id;
  if (state.snap !== null && workersOf(state.snap).readonly.some((w) => w.node.id === id)) state.roOpen = true;
}

/** Opens a worker from anywhere: a row, an entry of the capsules, a new session. @param {string} key */
function openNode(key) {
  const id = state.snap === null ? key : rootOf(state.snap, key) ?? key;
  show(id);
  go({ view: 'tower', node: id }, true);
  schedule();
}

const drive = makeDrive(state, dom, { schedule, render, poll, openNode, homeId: 'cap-wait' });

/** @type {(() => void)[]} */
let timers = [];
function wake() {
  timers.forEach((stop) => stop());
  // Hidden: the tower and the queue every 10 s, for the tab's count and the notifications.
  timers = document.hidden ? [every(HIDDEN_MS, () => { void poll(); drive.pollOwned(); })] : [every(POLL_MS, () => { void poll(); drive.pollOwned(); drive.pollFeed(); }), every(1000, schedule)];
  if (!document.hidden) void poll();
  drive.pollOwned();
}

/** @param {Element} el */
function act(el) {
  const t0 = /** @type {HTMLElement} */ (el);
  const a = t0.dataset.act;
  // The old page's list never moves under a pointer, so a no there always counts. Here it can, and a no that was not
  // meant is an answer too (D8): void as an allow is, the stops left alone.
  if ((a === 'deny' || a === 'req-no') && t0.closest('.pin-acts') !== null && drive.settling()) return drive.say(t('home.moved'));
  if (drive.act(t0)) return;
  if (a === 'worker') return openNode(t0.dataset.node ?? '');
  if (a === 'fold') {
    const k = t0.dataset.fold ?? '';
    if (state.folds.has(k)) state.folds.delete(k);
    else state.folds.add(k);
    return schedule();
  }
  if (a === 'ro') {
    state.roOpen = !state.roOpen;
    return schedule();
  }
  if (a === 'island') {
    state.island = !state.island;
    return schedule();
  }
  if (a === 'full') {
    const id = state.snap === null || state.sel === null ? undefined : indexOf(state.snap).byId.get(state.sel)?.node.session;
    if (typeof id === 'string') openFull(id);
    return;
  }
  // An entry of 「等你」 or 出错 opens its worker; 去看 too (the whole request is on its card).
  const pin = a === 'see' || t0.classList.contains('pin-go') ? t0.closest('.pin') : null;
  const node = pin === null ? undefined : /** @type {HTMLElement} */ (pin).dataset.node;
  if (node !== undefined && node !== '') openNode(node);
}

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-act],.pin-go') : null;
  if (el !== null) act(el);
});

// n opens the dispatch desk from anywhere but a field or an open dialog; the arrows walk the worker list.
document.addEventListener('keydown', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'n' && !(el !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) && el?.closest('dialog') == null) {
    e.preventDefault();
    return drive.openNew();
  }
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || el === null || !el.classList.contains('rr')) return;
  const rows = Array.from(dom.byId('rail').querySelectorAll('.rr'));
  const to = /** @type {HTMLElement | undefined} */ (rows[rows.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)]);
  if (to === undefined) return;
  e.preventDefault();
  to.focus();
});

drive.listen(dom.byId('pins'));

// == the left list's hold, as the old page's tree: the pointer or focus holds it; leaving starts the quiet timer
const railEl = dom.byId('rail');
function railHold() {
  state.railQuiet?.();
  state.railQuiet = null;
}
function railRelease() {
  if (railHeld()) return;
  state.railQuiet = after(QUIET_MS, () => {
    state.railQuiet = null;
    schedule();
  });
}
railEl.addEventListener('pointerenter', () => { state.railHover = true; railHold(); });
railEl.addEventListener('pointerleave', () => { state.railHover = false; railRelease(); });
railEl.addEventListener('focusin', () => { state.railFocus = true; railHold(); });
railEl.addEventListener('focusout', (e) => {
  const to = /** @type {FocusEvent} */ (e).relatedTarget;
  if (to instanceof Node && railEl.contains(to)) return;
  state.railFocus = false;
  railRelease();
});

// The session's facts open over the talk's height, between two frames: a reader at the end stays there, or the next line would not follow.
dom.slot(dom.byId('detail'), 'facts').parentElement?.addEventListener('toggle', () => {
  const chat = dom.slot(dom.byId('detail'), 'chat');
  if (state.chatEnd && chat.scrollHeight !== undefined) chat.scrollTop = chat.scrollHeight;
});

window.addEventListener('hashchange', () => {
  if (state.snap !== null) settleSel(state.snap);
  schedule();
});
document.addEventListener('visibilitychange', wake);

dom.fillStatic();
render();
wake();
