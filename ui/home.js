// @ts-check
// The home page's boot (第三轮方案 22), the one module with effects (the old tower page went 2026-11-08): the 2 s
// poll (10 s while hidden), the route, clicks and keys, one render per frame. ui/wings.js and ui/fold.js say what
// shows; everything done to a session goes through ui/drive.js, which holds the allow guards, so nothing here can
// loosen an allow. A card opens only when clicked, and a new one comes out once at the end of its wire, never moving
// the reader's place or the focus. The wires are the one thing measured here: they follow every frame, scroll and resize.
// The right side is shut until clicked open (第三轮 mock 21), from the capsule of what is going on; a card there pushes
// its worker's page, and Esc or the way back returns to the card. A phone has it as a drawer.
import { TIMEOUT_MS, getTower, oneAtATime } from './api.js';
import { after, every, fmtClock, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { POLL_MS, driveState, makeDrive } from './drive.js';
import { describeFront } from './front.js';
import { SETTLE_MS, atBottom, deskOf, ownedIdOf, queuedN } from './owned.js';
import { getRightOpen, getTheme, setRightOpen } from './prefs.js';
import { go, openFull, parse } from './route.js';
import { indexOf, towerFrame } from './tree.js';
import { describeDetail, detectsError, t } from './view.js';
import { avatarOf, clipsOf, describeErrs, describeFrontHead, describeFrontTile, describeGrant, describeIsland, describeLost, describeRail, describeRunCap, describeRunList, describeRunPage, describeSubs, describeTop, describeWires, grantsLine, railList, rootOf, runCards, subCards, wireRows, workersOf } from './wings.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */

const STALE_MS = 10000;
const HIDDEN_MS = 10000;
/** How long a new card stays marked: its CSS animation (the wire first, then the card) and a margin. */
const GROW_MS = 700;
/** How long a new wire stands out, then it goes back to faint. */
const WIRE_MS = 2200;
/** One column: the row and the card stand one under the other, and no wire goes between them. */
const NARROW = '(max-width: 899px)';
const narrow = () => window.matchMedia(NARROW).matches;
/** After the pointer or focus left, the left list holds this long (research §1.5). */
const QUIET_MS = 5000;
/** The chain of dispatches a worker may stand at the end of (src/route/dispatch.ts DISPATCH_LIMITS.depth): the panel says so there. */
const MAX_DEPTH = 2;
const dom = makePatcher(document);
/** @param {Element} el */
const focusOn = (el) => /** @type {HTMLElement} */ (el).focus();

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
  /** The left list's ids as drawn: it holds them under the pointer or focus (research §1.5). @type {string[]} */ railOrder: [],
  /** The right side is open; a phone's drawer never opens by itself. */ runOpen: !narrow() && getRightOpen(),
  /** The worker whose page is pushed over the right side's list, by key. @type {string | null} */ runPage: null,
  /** Its title as last seen, for a page whose worker left the snapshot. */ runTitle: '',
  /** The cards' keys as drawn: the list holds them as the left one does. @type {string[]} */ runOrder: [],
  /** When the right side last opened, shut or turned a page: a double click's second half goes nowhere then. */ runMoved: -Infinity,
  /** When a card left the list while it held: those under it moved up, so a click on a card goes nowhere a while. */ runShrunk: -Infinity,
  /** Where the capsules' block stands on the page. */ islAt: '',
  /** The talk stood at its end at the last frame or scroll: what grew it shorter since says nothing of the reader. */ chatEnd: true,
};

/** The tab's count: a pending agent request waits for you too. @param {TowerSnapshot} snap */
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
  // One column, a shut right side or a worker's page over the cards: no wire to a card out of sight.
  const none = narrow() || !state.runOpen || state.runPage !== null;
  dom.paintId('wires', describeWires(none ? [] : ends, { chat: chat.getBoundingClientRect(), frame: dom.byId('detail').getBoundingClientRect(), subs: subs.getBoundingClientRect(), x: list.getBoundingClientRect().left }));
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
  dom.paintId('right', { data: { open: state.runOpen ? '1' : '0', page: state.runPage === null ? 'list' : 'card' } });
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
  // The capsule, the cards and the page: one run of one snapshot (T3).
  const held = runHeld();
  const run = runCards(snap, held ? state.runOrder : []);
  const keys = [...run.cards, ...run.failed].map((c) => c.key);
  // The hold keeps the order, not a card that left: those under it moved up under the pointer (as a moved list of 「等你」).
  if (held && state.runOrder.some((k) => !keys.includes(k))) state.runShrunk = nowMono();
  state.runOrder = keys;
  if (state.runPage !== null) state.runTitle = run.all.get(state.runPage)?.node.title ?? state.runTitle;
  const clips = clipsOf(snap);
  const isl = describeIsland(pins, errs, { open: state.island, nowWall: wall, bar: pinBar, detects: detectsError(snap) });
  Object.assign(/** @type {any} */ (isl.slots), describeRunCap(run, { open: state.runOpen, clipped: clips.total }));
  dom.paintId('isl', isl);
  dom.paintId('pins', { ...pins, data: { hide: state.island && n > 0 ? '0' : '1' } });
  dom.paintId('rail', describeRail(snap, { sel: state.sel, roOpen: state.roOpen, order: railIds(snap) }));
  // Drawn under a page too, out of sight: the way back finds the very card it left.
  dom.paintId('run', describeRunList(run, { list: state.owned, nowWall: wall, clipped: clips }));
  dom.paintId('run-page', describeRunPage(run, { page: state.runPage, title: state.runTitle, list: state.owned, nowWall: wall }));

  state.rows = new Map();
  const detail = describeDetail(snap, state.sel, drive.detailFor(snap), { nowWall: wall, fmtIso });
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
  go({ node: id }, true);
  schedule();
}

/** The front desk's talk takes the page's middle; no worker is selected meanwhile. */
function openFrontTalk() {
  state.front = true;
  state.sel = null;
  go({ node: null }, true);
  schedule();
}

/** Whether the cards stand in sight: the right side open on its list, not shut nor under a worker's page. */
const cardsShown = () => state.runOpen && state.runPage === null;

/** A dispatch row of the selected worker's talk, tied to its card: expanded only while its card is open and in sight. @param {readonly import('./dom.js').Desc[]} kids */
function chatRows(kids) {
  const rows = wireRows(kids, state.snap === null ? [] : subCards(state.snap, cardsOf()), cardsShown() ? state.folds : new Set(), fmtClock);
  for (const r of rows) {
    const fold = r.tpl === 'tpl-disp' ? r.slots?.b?.data?.fold : '';
    if (fold) state.rows.set(fold, r.key);
  }
  return rows;
}

const drive = makeDrive(state, dom, { schedule, render, poll, openNode, openFront: openFrontTalk, frontTalk: describeFront, homeId: 'cap-wait', rows: chatRows });

/**
 * Opens or shuts the right side. Either moves what is under the pointer (the left half's width, or a drawer over it), which
 * no change of a list says: allows are void a while, as after one (r4 §10.9). A wide window keeps the choice; a phone
 * never opens to a drawer. The focus: into a drawer that opened, back to the capsule from a side that shut under it.
 * @param {boolean} open @param {Element | null} from what was clicked or had the key; null moves no focus
 */
function setRun(open, from) {
  const was = from !== null && dom.byId('right').contains(from);
  state.runOpen = open;
  if (!open) state.runPage = null;
  if (!narrow()) setRightOpen(open);
  state.runMoved = nowMono();
  drive.settle();
  render();
  if (from === null) return;
  if (open && narrow()) focusOn(dom.byId('run-h'));
  else if (!open && (was || narrow())) focusOn(dom.byId('cap-run'));
}

/** A card's worker's page over the list; its title takes the focus. @param {string} key */
function runPush(key) {
  state.runPage = key;
  state.runTitle = '';
  state.runMoved = nowMono();
  render();
  focusOn(dom.byId('rpg-h'));
}

/** Back to the list: the focus to the card it came from, or with that one gone, to the list's head. */
function runBack() {
  const key = state.runPage;
  state.runPage = null;
  state.runMoved = nowMono();
  render();
  const run = dom.byId('run');
  const li = key === null ? null : dom.keyed(dom.slot(run, 'list'), key) ?? dom.keyed(dom.slot(run, 'flist'), key);
  focusOn(li === null ? dom.byId('run-h') : dom.slot(li, 'b'));
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

/** @param {Element} el */
function act(el) {
  const t0 = /** @type {HTMLElement} */ (el);
  const a = t0.dataset.act;
  // The list here can move under a pointer (a capsule opened, a composer of another height), and a no that was not
  // meant is an answer too (D8): void as an allow is, the stops left alone.
  if ((a === 'deny' || a === 'req-no') && t0.closest('.pin-acts') !== null && drive.settling()) return drive.say(t('home.moved'));
  if (drive.act(t0)) return;
  if (a === 'run') return setRun(!state.runOpen, t0);
  if (a === 'run-card') return nowMono() - state.runShrunk < SETTLE_MS ? drive.say(t('home.moved')) : runPush(t0.dataset.run ?? '');
  if (a === 'run-back') return runBack();
  if (a === 'worker') {
    // From a phone's drawer: it shuts, or the talk opened would be under it.
    if (!(state.runOpen && narrow() && dom.byId('right').contains(t0))) return openNode(t0.dataset.node ?? '');
    setRun(false, null);
    openNode(t0.dataset.node ?? '');
    render();
    return focusOn(dom.byId('dt-title'));
  }
  if (a === 'front') return state.csrf === null ? void drive.unlock() : openFrontTalk();
  if (a === 'front-open') return void drive.openFront();
  if (a === 'fold') {
    const k = t0.dataset.fold ?? '';
    const dr = t0.classList.contains('dr');
    // A row folds its card only when that card stands open in sight; one open out of sight, under a shut side or a
    // page, is opened to view, not folded unseen.
    if (state.folds.has(k) && (!dr || cardsShown())) state.folds.delete(k);
    else state.folds.add(k);
    // Clicked in the talk: the card comes into view. Only a click moves the right side, and opens it if shut (the
    // choice not kept: it was the row's), or turns back a page over the cards.
    if (dr && state.folds.has(k)) {
      state.reveal = k;
      state.runPage = null;
      if (!state.runOpen) {
        state.runOpen = true;
        state.runMoved = nowMono();
        drive.settle();
        if (narrow()) {
          render();
          const li = dom.keyed(dom.slot(dom.byId('subs'), 'list'), k);
          return li === null ? focusOn(dom.byId('run-h')) : focusOn(dom.slot(li, 'b'));
        }
      }
    }
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
  // The right side just opened, shut or turned a page: a double click's second half would undo it, or land on what
  // came up under it. It goes nowhere (the allows are void meanwhile anyway).
  if (el !== null && e.detail > 1 && nowMono() - state.runMoved < SETTLE_MS) return;
  if (el !== null) act(el);
});

// n opens the dispatch desk from anywhere but a field or an open dialog; the arrows walk the worker list.
document.addEventListener('keydown', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
  // Esc turns back a worker's page, then shuts the side, from inside it or the capsule (on a phone from anywhere: the
  // drawer is over everything); not from the composer of a wide window, nor a dialog, which has its own.
  if (e.key === 'Escape' && el?.closest('dialog') == null) {
    const inRight = el !== null && dom.byId('right').contains(el);
    if (state.runPage !== null && (inRight || narrow())) {
      e.preventDefault();
      return runBack();
    }
    if (state.runOpen && (inRight || narrow() || el?.id === 'cap-run')) {
      e.preventDefault();
      return setRun(false, el);
    }
  }
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

// == the lists' hold (research §1.5): the pointer or focus holds the order, so a click picks the row it was
// aimed at; leaving starts the quiet timer. The left list and the right side's cards alike.
/** @param {Element} el @returns {() => boolean} whether it holds now */
function holdOn(el) {
  let hover = false;
  let focus = false;
  /** Cancels the pending release. @type {(() => void) | null} */
  let quiet = null;
  const held = () => hover || focus || quiet !== null;
  const hold = () => {
    quiet?.();
    quiet = null;
  };
  const release = () => {
    if (held()) return;
    quiet = after(QUIET_MS, () => {
      quiet = null;
      schedule();
    });
  };
  el.addEventListener('pointerenter', () => { hover = true; hold(); });
  el.addEventListener('pointerleave', () => { hover = false; release(); });
  el.addEventListener('focusin', () => { focus = true; hold(); });
  el.addEventListener('focusout', (e) => {
    const to = /** @type {FocusEvent} */ (e).relatedTarget;
    if (to instanceof Node && el.contains(to)) return;
    focus = false;
    release();
  });
  return held;
}
const railHeld = holdOn(dom.byId('rail'));
const runHeld = holdOn(dom.byId('run'));
// A window gone narrow shuts the side, the choice kept for the wide one; a drawer never opens by itself. A focus in it
// goes back to the capsule, or it would fall to the page's top with what held it. Gone wide again, the side is as the
// wide window last had it: a drawer shut on a phone is no choice for the desk.
window.matchMedia(NARROW).addEventListener?.('change', (/** @type {MediaQueryListEvent} */ e) => {
  if (!e.matches) {
    if (state.runOpen === getRightOpen()) return;
    state.runOpen = getRightOpen();
    state.runMoved = nowMono();
    drive.settle();
    render();
    return;
  }
  if (!state.runOpen) return;
  const had = document.activeElement;
  const was = had != null && dom.byId('right').contains(had);
  state.runOpen = false;
  state.runPage = null;
  state.runMoved = nowMono();
  drive.settle();
  render();
  if (was) focusOn(dom.byId('cap-run'));
});
// The drawer covers the page (its CSS takes what it covers out of the Tab order too): a focus that got out under it, a
// Shift+Tab or a reader's jump, goes back to its head, so nothing under it is pressed unseen. A dialog has its own.
document.addEventListener('focusin', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!state.runOpen || !narrow() || el === null || dom.byId('right').contains(el) || el.closest('dialog') != null) return;
  focusOn(dom.byId(state.runPage === null ? 'run-h' : 'rpg-h'));
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
