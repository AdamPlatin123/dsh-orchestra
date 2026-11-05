// @ts-check
// The home page's boot (第三轮方案 22), the second module with effects, beside ui/app.js for the old tower: the 2 s
// poll (10 s while hidden), the route, clicks and keys, one render per frame. ui/wings.js and ui/fold.js say what
// shows; everything done to a session goes through ui/drive.js, the old page's own code, so nothing here can
// loosen an allow. A card opens only when clicked, and a new one comes out once at the end of its wire, never moving
// the reader's place or the focus. The wires are the one thing measured here: they follow every frame, scroll and resize.
import { TIMEOUT_MS, getTower, oneAtATime } from './api.js';
import { after, every, fmtClock, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { POLL_MS, driveState, makeDrive } from './drive.js';
import { describeFront } from './front.js';
import { atBottom, deskOf, ownedIdOf, queuedN } from './owned.js';
import { getTheme } from './prefs.js';
import { go, openFull, parse } from './route.js';
import { indexOf, towerFrame } from './tree.js';
import { describeDetail, detectsError, t } from './view.js';
import { avatarOf, describeErrs, describeFrontHead, describeFrontTile, describeGrant, describeIsland, describeLost, describeRail, describeSubs, describeTop, describeWires, grantsLine, railList, rootOf, subCards, wireRows, workersOf } from './wings.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */

const STALE_MS = 10000;
const HIDDEN_MS = 10000;
/** How long a new card stays marked: its CSS animation (the wire first, then the card) and a margin. */
const GROW_MS = 700;
/** How long a new wire stands out, then it goes back to faint. */
const WIRE_MS = 2200;
/** One column: the row and the card stand one under the other, and no wire goes between them. */
const NARROW = '(max-width: 899px)';
/** After the pointer or focus left, the left list holds this long, as the old page's tree. */
const QUIET_MS = 5000;
/** The chain of dispatches a worker may stand at the end of (src/route/dispatch.ts DISPATCH_LIMITS.depth): the panel says so there. */
const MAX_DEPTH = 2;
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
  /** The talk's rows with a card, row key by card key. @type {Map<string, string>} */ rows: new Map(),
  /** Per worker, the wires already seen. @type {Map<string, Set<string>>} */ wired: new Map(),
  /** The wires standing out since they came, until when. @type {Map<string, number>} */ wireNew: new Map(),
  /** The card or row under the pointer or focus. @type {string | null} */ wireAim: null,
  /** The rows and cards painted hot: one that lost its other end has no wire to stand out for. @type {Set<Element>} */ hotEnds: new Set(),
  /** A row was clicked open: its card comes into view. @type {string | null} */ reveal: null,
  /** @type {number | null} */ lastWaiting: null,
  // The left list holds its order under the pointer or focus (research §1.5): a click picks the row it was aimed at.
  railHover: false,
  railFocus: false,
  /** Cancels the pending release. @type {(() => void) | null} */ railQuiet: null,
  /** The ids as drawn. @type {string[]} */ railOrder: [],
  /** Where the capsules' block stands on the page. */ islAt: '',
  /** The talk stood at its end at the last frame or scroll: what grew it shorter since says nothing of the reader. */ chatEnd: true,
};

const railHeld = () => state.railHover || state.railFocus || state.railQuiet !== null;

/** The tab's count, as the old page's: a pending agent request waits for you too. @param {TowerSnapshot} snap */
function paintTitle(snap) {
  const waiting = snap.tally.waiting + queuedN(state.owned) + (snap.router.asks?.length ?? 0);
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

/** Whose cards the right side shows: the selected worker's, or with the front desk's talk open, the desk's. */
function cardsOf() {
  const d = state.front ? deskOf(state.owned) : null;
  return d === null ? state.sel : `n:${d.ownedId}`;
}

/** Marks the selected worker's new cards; a worker's first look marks none, so nothing plays on opening it. @param {TowerSnapshot} snap */
function freshCards(snap) {
  const sel = cardsOf();
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

/** Marks the wires that came since the last look; a worker's first look with its talk read marks none, as cards. @param {boolean} read */
function freshWires(read) {
  const sel = state.sel;
  if (read && sel !== null) {
    const had = state.wired.get(sel);
    for (const k of state.rows.keys()) {
      if (had === undefined || had.has(k)) continue;
      state.wireNew.set(k, nowMono() + WIRE_MS);
      after(WIRE_MS, schedule);
    }
    state.wired.set(sel, new Set([...(had ?? []), ...state.rows.keys()]));
  }
  for (const [k, until] of state.wireNew) if (nowMono() >= until) state.wireNew.delete(k);
}

/** Measures the rows and cards and draws the wires between them; the rest of the page does not move for it. */
function paintWires() {
  const chat = dom.slot(dom.byId('detail'), 'chat');
  const subs = dom.byId('subs');
  const list = dom.slot(subs, 'list');
  const ends = [];
  /** @type {Set<Element>} */
  const hotEnds = new Set();
  for (const [key, rowKey] of state.rows) {
    const row = dom.keyed(chat, rowKey);
    const card = dom.keyed(list, key);
    if (row === null || card === null) continue;
    const grow = state.wireNew.has(key);
    const hot = grow || state.wireAim === key || state.folds.has(key);
    for (const el of [row, card]) {
      dom.paint(el, { data: { hot: hot ? '1' : '0' } });
      if (hot) hotEnds.add(el);
    }
    ends.push({ key, hot, grow, row: dom.slot(row, 'b').getBoundingClientRect(), card: dom.slot(card, 'b').getBoundingClientRect() });
  }
  for (const el of state.hotEnds) if (!hotEnds.has(el)) dom.paint(el, { data: { hot: '0' } });
  state.hotEnds = hotEnds;
  const narrow = window.matchMedia(NARROW).matches;
  dom.paintId('wires', describeWires(narrow ? [] : ends, { chat: chat.getBoundingClientRect(), frame: dom.byId('detail').getBoundingClientRect(), subs: subs.getBoundingClientRect(), x: list.getBoundingClientRect().left }));
}

let wiresQueued = false;
function wiresSoon() {
  if (wiresQueued || document.hidden) return;
  wiresQueued = true;
  onFrame(() => {
    wiresQueued = false;
    paintWires();
  });
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
  // Held from before anything changed the chat's height: the note above it here, the window any time.
  const atEnd = state.chatEnd;
  dom.paint(document.documentElement, { data: { theme: state.theme, ready: snap === null ? '0' : '1' } });
  dom.paintId('alert', { text: state.error ?? '', data: { hide: state.error === null ? '1' : '0' } });
  dom.paintId('note', { text: state.note ?? '', data: { hide: state.note === null ? '1' : '0' } });
  const ageMs = state.okMono === null ? null : nowMono() - state.okMono;
  const open = state.csrf !== null;
  const top = describeTop(snap, { ageMs, stale: ageMs !== null && ageMs > STALE_MS, theme: state.theme });
  Object.assign(/** @type {any} */ (top.slots), { unlock: { text: t(open ? 'bar.unlocked' : 'bar.unlock') } });
  dom.paintId('top', top);
  dom.paintId('desk', { slots: { new: { text: t(open ? 'bar.new' : 'bar.newLocked'), attr: { title: t('bar.newHint') } }, ...describeFrontTile(state.owned, { unlocked: open, on: state.front, busy: state.busy }) } });
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

  state.rows = new Map();
  const detail = describeDetail(snap, state.sel, [], drive.detailFor(snap), { nowWall: wall, fmtIso });
  const node = state.sel === null ? undefined : indexOf(snap).byId.get(state.sel)?.node;
  const face = node === undefined ? { data: { hide: '1' } } : avatarOf(node);
  Object.assign(/** @type {any} */ (detail.slots), { hav: { ...face, data: { hide: node === undefined ? '1' : '0', ...face.data } } }, node === undefined ? { empty: { text: t('home.pick') } } : {});
  const desk = state.front ? deskOf(state.owned) : null;
  if (state.front) {
    const head = describeFrontHead(desk, state.owned);
    Object.assign(/** @type {any} */ (detail.data), head.data);
    Object.assign(/** @type {any} */ (detail.slots), head.slots, { hav: { data: { hide: desk === null ? '1' : '0', harness: 'claude', ro: '0' }, slots: { ch: { text: t('front.ch') }, bd: { data: { b: 'none' } } } } });
  }
  Object.assign(/** @type {any} */ (detail.slots), { grant: describeGrant(desk !== null ? desk.ownedId : node === undefined ? null : ownedIdOf(node), state.owned, { unlocked: open, fmt: fmtClock, maxDepth: MAX_DEPTH }) });
  drive.paintSession(snap, detail, atEnd);
  const own = desk !== null ? desk.ownedId : node === undefined ? null : ownedIdOf(node);
  const read = own !== null && state.feeds.has(own);
  dom.paintId('subs', describeSubs(snap, cardsOf(), { open: state.folds, fresh: freshCards(snap), rows: state.rows, read, locked: !open, front: state.front }));
  dom.paintId('rbar', { text: grantsLine(state.owned, open) });
  freshWires(read);
  drive.moveFocusOn();
  settlePlace();
  if (state.reveal !== null) dom.keyed(dom.slot(dom.byId('subs'), 'list'), state.reveal)?.scrollIntoView?.({ block: 'nearest' });
  state.reveal = null;
  paintWires();
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
  const waiting = snap.tally.waiting + queuedN(state.owned);
  if (state.lastWaiting !== null && state.lastWaiting !== waiting) dom.say(dom.byId('live'), t('live.wait', { n: waiting }));
  state.lastWaiting = waiting;
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
  } else if (state.sel === null && !state.front) state.sel = workersOf(snap).owned[0]?.node.id ?? null;
}

/** Selects a worker; a read-only one's group opens so its row shows. @param {string} id */
function show(id) {
  state.front = false;
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

/** The front desk's talk takes the page's middle; no worker is selected meanwhile. */
function openFrontTalk() {
  state.front = true;
  state.sel = null;
  go({ view: 'tower', node: null }, true);
  schedule();
}

/** A dispatch row of the selected worker's talk, tied to its card. @param {readonly import('./dom.js').Desc[]} kids */
function chatRows(kids) {
  const rows = wireRows(kids, state.snap === null ? [] : subCards(state.snap, cardsOf()), state.folds, fmtClock);
  for (const r of rows) {
    const fold = r.tpl === 'tpl-disp' ? r.slots?.b?.data?.fold : '';
    if (fold) state.rows.set(fold, r.key);
  }
  return rows;
}

const drive = makeDrive(state, dom, { schedule, render, poll, openNode, openFront: openFrontTalk, frontTalk: describeFront, homeId: 'cap-wait', rows: chatRows });

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
  if (a === 'front') return state.csrf === null ? void drive.unlock() : openFrontTalk();
  if (a === 'front-open') return void drive.openFront();
  if (a === 'fold') {
    const k = t0.dataset.fold ?? '';
    if (state.folds.has(k)) state.folds.delete(k);
    else state.folds.add(k);
    // Clicked in the talk: the card comes into view. Only a click moves the right side.
    if (t0.classList.contains('dr') && state.folds.has(k)) state.reveal = k;
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

// == the wires: a row or card under the pointer or focus stands out, and they follow whatever moves the two lists
const chatEl = dom.slot(dom.byId('detail'), 'chat');
/** @param {Event} e */
function aim(e) {
  const el = e.type === 'pointerover' || e.type === 'focusin' ? e.target : null;
  state.wireAim = el instanceof Element ? /** @type {HTMLElement | null} */ (el.closest('[data-fold]'))?.dataset.fold ?? null : null;
  wiresSoon();
}
/** Between two frames the talk grew shorter (the window, the composer's grip, the session's facts): a reader at the end stays there, or the next line would not follow. */
function keepEnd() {
  const chat = dom.slot(dom.byId('detail'), 'chat');
  if (state.chatEnd && chat.scrollHeight !== undefined) chat.scrollTop = chat.scrollHeight;
}
chatEl.addEventListener('scroll', () => { state.chatEnd = atBottom(chatEl); });
for (const el of [chatEl, dom.byId('subs')]) {
  for (const type of ['pointerover', 'pointerleave', 'focusin', 'focusout']) el.addEventListener(type, aim);
  el.addEventListener('scroll', wiresSoon);
  // A command folding open moves the rows under it with no scroll and no new size; toggle does not bubble.
  el.addEventListener('toggle', wiresSoon, true);
  if ('ResizeObserver' in globalThis) new ResizeObserver(() => {
    keepEnd();
    wiresSoon();
  }).observe(el);
}
window.addEventListener('resize', wiresSoon);

dom.slot(dom.byId('detail'), 'facts').parentElement?.addEventListener('toggle', keepEnd);

window.addEventListener('hashchange', () => {
  if (state.snap !== null) settleSel(state.snap);
  schedule();
});
document.addEventListener('visibilitychange', wake);

dom.fillStatic();
render();
wake();
