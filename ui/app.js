// @ts-check
// The tower page's boot (orchestra app plan §5), the one module with effects: the 2 s poll (stopped while
// hidden), the route, clicks and keys, one render per frame. Owned sessions are driven once this tab is
// unlocked (slice design §2.7), each allow under r4 §10.9's guards (D8); ui/owned.js says what shows.
// Under the pointer or focus the tree's order holds (research §1.5): changes count on "↻ N".
import { getFeed, getOwned, getSession, getTower, oneAtATime, post } from './api.js';
import { after, every, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { getCsrf, getTheme, setCsrf, setTheme } from './prefs.js';
import {
  HOLD_MS, SETTLE_MS, brakeWhyText, modelsOf, atBottom, chatNews, describeDesk, describeNew, describeOwned, describeOwnedDock, describeRequestPins, errText, isFeed, isOwnedList, isSuggestion, mergeFeed, msgError,
  notifyText, ownedIdOf, pinExtra, pinWhole, whyText, withRequests,
} from './owned.js';
import { go, openFull, parse } from './route.js';
import { FILTERS, buildRows, freeze, groupKey, indexOf, navigate, projectKey, towerFrame } from './tree.js';
import { clippedSessions, describeAbout, describeBar, describeDetail, describeDock, describePins, describeTower, detectsError, t } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('./tree.js').Row} Row
 * @typedef {import('./tree.js').Filter} Filter
 * @typedef {import('./view.js').Detail} Detail
 */

const POLL_MS = 2000;
const STALE_MS = 10000;
const QUIET_MS = 5000;
const HIDDEN_MS = 10000;
const NOTE_MS = 8000;
/** Ending a session takes a second click this soon. */
const ARM_MS = 3000;
/** A changed row lights up this long (research §1.5; the CSS animation's length). */
const FLASH_MS = 1200;
/** Below this width a node opens its own page (tower.css). */
const NARROW = '(max-width: 899px)';
const narrow = () => window.matchMedia(NARROW).matches;
const dom = makePatcher(document);
const treeEl = dom.byId('tree');
const towerEl = dom.byId('tower');
const pinsEl = dom.byId('pins');
/** @param {string} id */
const val = (id) => String(/** @type {any} */ (dom.byId(id)).value ?? '');
/** @param {string} id @param {string} v */
const setVal = (id, v) => { /** @type {any} */ (dom.byId(id)).value = v; };

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
  /** A changed row's new state, lit once until `until`. @type {Map<string, { state: string, until: number }>} */ flash: new Map(),
  /** The last render's view, to move the focus when the node page opens or closes. */ lastView: 'tower',
  /** @type {number | null} */ lastWaiting: null,
  /** A row to focus after the next render. @type {string | null} */ focusKey: null,
  queued: false,
  // csrf: this tab's token (null: locked); pinSig: bar and queue as drawn (a change starts the 750 ms);
  // to: the recipient, held once you type (§1.5).
  csrf: getCsrf(),
  owned: null,
  /** @type {Map<string, any>} */ feeds: new Map(),
  feedFor: null,
  feedOut: false,
  // The chat's reader: what was said, up to which seq of which session (a session opened says nothing of its past).
  heard: { id: '', seq: 0, text: '' },
  pinSig: '',
  changedMono: -Infinity,
  settleTok: 'a',
  pinHover: false,
  pinFocus: false,
  pinOrder: null,
  hold: null,
  // Approvals: one a hold just allowed; one answered (the focus moves on).
  justHeld: null,
  apprFocus: null,
  busy: false,
  note: null,
  noteOff: null,
  to: null,
  endArm: null,
  /** The session whose brake waits for its second click (ARM_MS). @type {string | null} */
  brakeArm: null,
  told: new Set(),
  // The dispatch desk: the last suggestion and the sentence it was for (null: none); a suggestion out.
  /** @type {{ text: string, reply: any } | null} */ desk: null,
  asking: false,
  // Bumped when a dispatch or a closed dialog makes a suggestion still out void: its reply is dropped.
  deskTok: 0,
};

const frozen = () => state.hover || state.focusIn || state.quiet !== null;
const settling = () => nowMono() - state.changedMono < SETTLE_MS;
const guard = () => ({ unlocked: state.csrf !== null, settle: settling() ? state.settleTok : '', hold: state.hold?.id ?? null, busy: state.busy, nowWall: nowWall() });
/** The selected owned session as a recipient, or null. */
function selTo() {
  const n = state.snap === null || state.sel === null ? undefined : indexOf(state.snap).byId.get(state.sel)?.node;
  const id = ownedIdOf(n);
  return id === null || n === undefined ? null : { id, title: n.title };
}

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
  const bar = describeBar(snap, { filter: state.filter, ageMs, stale: ageMs !== null && ageMs > STALE_MS, theme: state.theme, view });
  const open = state.csrf !== null;
  Object.assign(/** @type {any} */ (bar.slots), { new: { text: t(open ? 'bar.new' : 'bar.newLocked') }, unlock: { text: t(open ? 'bar.unlocked' : 'bar.unlock') } });
  dom.paintId('bar', bar);
  dom.paintId('note', { text: state.note ?? '', data: { hide: state.note === null ? '1' : '0' } });
  const nowDesk = {
    text: val('nw-text'), harness: val('nw-harness') || 'codex', model: val('nw-model'), asking: state.asking,
    enabled: state.owned?.enabled !== false, maxOwned: state.owned?.limits?.maxOwned,
  };
  dom.paintId('new-dlg', { slots: { ...describeNew(state.owned, nowDesk.harness, state.busy), ...describeDesk(state.desk, nowDesk) } });
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
  // A flash plays once: a row shown again later does not light up for a change long gone.
  /** @type {Map<string, string>} */
  const flash = new Map();
  const mono = nowMono();
  for (const [id, f] of state.flash) {
    if (mono < f.until) flash.set(id, f.state);
    else state.flash.delete(id);
  }
  const pinBar = holdPins(snap);
  // The bar or queue moved: allows are void for SETTLE_MS (r4 §10.9), a hold lets go.
  // seat: a new or gone agent request moves the bar too (派出 is void for SETTLE_MS, as an allow).
  const reqIds = (state.owned?.requests ?? []).filter((/** @type {any} */ r) => r.state === 'pending').map((/** @type {any} */ r) => r.requestId).join();
  const sig = `${pinBar.map((e) => e.node).join()}|${state.owned?.rev ?? ''}|${reqIds}`;
  if (sig !== state.pinSig) {
    state.pinSig = sig;
    state.changedMono = nowMono();
    state.settleTok = state.settleTok === 'a' ? 'b' : 'a';
    if (state.hold !== null) say(t('appr.holdCancelled'));
    cancelHold();
    after(SETTLE_MS + 20, schedule);
  }
  const g = guard();
  dom.paintId('pins', withRequests(describePins(snap, { sel: state.sel, nowWall: wall, bar: pinBar, extra: (e) => pinExtra(e, state.owned, g) }), describeRequestPins(state.owned, g)));
  dom.paintId('tower', describeTower(rows, {
    filter: state.filter, pending, sel: state.sel, peek: state.peek, flash, detectsError: detectsError(snap), clipped: clippedSessions(snap), dispatch: snap.router.dispatch, nowWall: nowWall(),
  }));
  const detail = describeDetail(snap, state.sel, rows, detailFor(snap), { nowWall: wall, fmtIso });
  const mine = selTo();
  if ((mine?.id ?? null) !== state.feedFor) {
    state.feedFor = mine?.id ?? null;
    void pollFeed();
  }
  Object.assign(/** @type {any} */ (detail.slots), mine === null ? { ownBox: { data: { hide: '1' } } } : describeOwned(mine.id, state.owned, state.feeds.get(mine.id), g));
  const feed = mine === null ? undefined : state.feeds.get(mine.id);
  const opened = feed !== undefined && state.heard.id !== mine?.id;
  if (feed !== undefined && mine !== null && (opened || feed.to > state.heard.seq)) {
    state.heard = { id: mine.id, seq: feed.to, text: opened ? '' : chatNews(feed, state.heard.seq) || state.heard.text };
  }
  /** @type {any} */ (detail.slots).chatSay = { text: mine !== null && state.heard.id === mine.id ? state.heard.text : '' };
  const chatEl = dom.slot(dom.byId('detail'), 'chat');
  const follow = opened || atBottom(chatEl);
  dom.paintId('detail', detail);
  if (follow && chatEl.scrollHeight !== undefined) chatEl.scrollTop = chatEl.scrollHeight;
  const dock = describeDock(snap, state.sel);
  const to = state.to ?? mine;
  Object.assign(/** @type {any} */ (dock.slots), describeOwnedDock(to, state.owned, g, state.to !== null, to !== null && state.endArm === to.id, to !== null && state.brakeArm === to.id), state.to === null ? {} : { to: { text: t('dock.to', { who: state.to.title }) } });
  dom.paintId('dock', { ...dock, attr: { 'aria-disabled': String(to === null || !g.unlocked) } });
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
  moveFocusOn();
}

/** An answered card or bar entry goes: a focus on it moves to the next there, else a heading (WCAG 2.4.3). */
function moveFocusOn() {
  const f = state.apprFocus;
  if (!f || f.el.isConnected) return;
  const list = f.list;
  state.apprFocus = null;
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.isConnected) return;
  /** @type {any} */ (list?.children[Math.min(f.i, list.children.length - 1)]?.querySelector('button') ?? dom.byId(f.card ? 'dt-title' : 'tower-h')).focus();
}

/** @param {Element} el @param {string} id */
function answeredAt(el, id) {
  const item = /** @type {any} */ (el.closest('.card') ?? el.closest('.pin'));
  const list = item?.parentNode;
  if (list) state.apprFocus = { id, el: item, list, card: item.classList.contains('card'), i: Array.from(list.children).indexOf(item) };
}

/** The selected node's session detail, read once per session and rev. @param {TowerSnapshot} snap @returns {Detail | null} */
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
  schedule();
}

/** @type {(() => void)[]} */
let timers = [];
function wake() {
  timers.forEach((stop) => stop());
  timers = document.hidden ? [every(HIDDEN_MS, pollOwned)] : [every(POLL_MS, () => { void poll(); pollOwned(); pollFeed(); }), every(1000, schedule)];
  if (!document.hidden) void poll();
  pollOwned();
}

// == owned sessions, once unlocked (hidden: the queue only, for notifications)
const ownedOnce = oneAtATime(async () => (state.csrf === null ? null : getOwned(state.csrf)));
async function pollOwned() {
  const csrf = state.csrf;
  const a = await ownedOnce();
  if (a == null || csrf !== state.csrf) return;
  if (!a.ok && (a.code === 'not-unlocked' || a.code === 'unpaired')) lock();
  else if (a.ok && isOwnedList(a.body)) {
    const first = state.owned === null;
    state.owned = a.body;
    tell(a.body, first);
  }
  schedule();
}

async function pollFeed() {
  const id = selTo()?.id;
  if (id === undefined || state.csrf === null || state.feedOut) return;
  state.feedOut = true;
  const a = await getFeed(state.csrf, id, state.feeds.get(id)?.to ?? 0);
  state.feedOut = false;
  if (!a.ok && a.code === 'not-unlocked') lock();
  const b = a.ok ? a.body : null;
  if (isFeed(b) && b.ownedId === id) state.feeds.set(id, mergeFeed(state.feeds.get(id), b));
  schedule();
}

/** Notifies approvals that came while hidden; never an allow (r4 §10.9). @param {any} list @param {boolean} first */
function tell(list, first) {
  for (const a of list.approvals) {
    if (!state.told.has(a.approvalId) && !first && document.hidden && globalThis.Notification?.permission === 'granted') {
      try {
        new Notification(t('notify.title'), { body: notifyText(a, list.owned.find((/** @type {any} */ o) => o.ownedId === a.ownedId)?.title || t('bar.brand')), tag: a.approvalId });
      } catch {} // refused (a phone): the title still counts
    }
    state.told.add(a.approvalId);
  }
}

/** @param {string} text */
function say(text) {
  state.note = text;
  state.noteOff?.();
  state.noteOff = after(NOTE_MS, () => { state.note = null; schedule(); });
  schedule();
}

/** The token is no good (a restart): locked again. */
function lock() {
  setCsrf((state.csrf = null));
  state.owned = null;
  state.feeds.clear();
  cancelHold();
  say(t('unlock.lost'));
}

/** @param {string} id @param {string} focus */
function openDlg(id, focus) {
  const d = /** @type {any} */ (dom.byId(id));
  if (!d.open) d.showModal();
  /** @type {any} */ (dom.byId(focus)).focus();
  schedule();
}
/** @param {string} id */
const closeDlg = (id) => /** @type {any} */ (dom.byId(id)).close();
/** A dialog's own line (the note sits behind a modal). @param {string} id @param {string} text */
const dlgSay = (id, text) => dom.paintId(id, { slots: { msg: { text } } });

/** The daemon prints a code on its console (204: never in a reply). */
async function unlockStart() {
  if (state.csrf !== null) return say(t('unlock.ok'));
  const a = await post(null, 'owned/unlock-code', null);
  if (!a.ok) return say(a.code === 'http-503' ? t('unlock.off') : a.code === 'unpaired' ? t('unlock.closed') : errText(a.code));
  dlgSay('unlock-dlg', '');
  openDlg('unlock-dlg', 'ul-code');
}

async function unlockGo() {
  const code = val('ul-code').trim();
  const a = /^[0-9]{8}$/.test(code) ? await post(null, 'owned/unlock', { code }) : null;
  const csrf = a?.ok ? a.body?.csrf : null;
  if (!/^[\w-]{43}$/.test(csrf)) {
    return dlgSay('unlock-dlg', a === null ? t('unlock.format') : a.ok || a.code === 'not-unlocked' ? t('unlock.wrong') : errText(a.code));
  }
  setCsrf((state.csrf = csrf));
  setVal('ul-code', '');
  closeDlg('unlock-dlg');
  say(t('unlock.ok'));
  if (globalThis.Notification?.permission === 'default') void Notification.requestPermission();
  pollOwned();
  pollFeed();
}

/** One owned POST at a time, on one thing. @param {string} path @param {object} body @returns {Promise<any>} */
async function op(path, body) {
  if (state.busy || state.csrf === null) return null;
  state.busy = true;
  schedule();
  const a = await post(state.csrf, path, { actionId: crypto.randomUUID(), ...body });
  state.busy = false;
  if (!a.ok && a.code === 'not-unlocked') lock();
  pollOwned();
  pollFeed();
  return a;
}
/** @param {any} a @param {string} ok */
const said = (a, ok) => a !== null && say(a.ok ? ok : errText(a.code));

/**
 * The dispatch desk: a "Route to?" card for the sentence; it starts nothing (orchestra app plan §3). The
 * reply fills the two selects only if, meanwhile, the dialog stayed open, the sentence and both selects
 * stayed as they were, and nothing was dispatched: a choice made by hand is never overwritten.
 */
async function suggest() {
  const text = val('nw-text');
  const why = msgError(text);
  if (why !== null) return dlgSay('new-dlg', why);
  // orchestrad without owned sessions has no desk (POST /api/route/suggest is 501): say why, not the code.
  if (state.owned !== null && state.owned.enabled === false) return dlgSay('new-dlg', t('new.off', { why: whyText(state.owned.disabledWhy ?? '') }));
  if (state.asking || state.csrf === null) return;
  const tok = ++state.deskTok;
  const before = { harness: val('nw-harness'), model: val('nw-model') };
  state.asking = true;
  dlgSay('new-dlg', '');
  schedule();
  const a = await post(state.csrf, 'route/suggest', { text });
  state.asking = false;
  if (tok !== state.deskTok) return schedule();
  if (!a.ok || !isSuggestion(a.body)) {
    if (!a.ok && a.code === 'not-unlocked') lock();
    schedule();
    // No suggestion is no harm: nothing was started or written; the person can pick by hand.
    const reason = a.ok ? t('route.failed.shape') : a.code === 'network' || /^http-5(?!01)\d\d$/.test(a.code) ? t('route.failed.none') : errText(a.code);
    return dlgSay('new-dlg', t('route.failed', { why: reason }));
  }
  state.desk = { text, reply: a.body };
  const open = /** @type {any} */ (dom.byId('new-dlg')).open === true;
  const untouched = open && val('nw-text') === text && val('nw-harness') === before.harness && val('nw-model') === before.model;
  const first = a.body.candidates[0];
  if (first !== undefined && untouched) pick(first);
  const now = { h: val('nw-harness') || 'codex', m: val('nw-model') };
  dlgSay('new-dlg', [first !== undefined && untouched && t('route.picked', { h: t(`harness.${now.h}`), m: now.m }), t('route.nothing')].filter(Boolean).join(t('sep.notes')));
  schedule();
}

/** A candidate into the two selects: the model list follows the harness at once, then the model. @param {{ harness: string, model: string }} c */
function pick(c) {
  setVal('nw-harness', c.harness);
  render();
  setVal('nw-model', c.model);
}

/** Nothing leaves until 派出 (orchestra app plan §3); a card for this very sentence goes with it (routeId). */
async function dispatch() {
  const text = val('nw-text');
  const why = msgError(text);
  const harness = val('nw-harness') || 'codex';
  const routeId = state.desk !== null && state.desk.text === text ? state.desk.reply.routeId : null;
  const body = { text, harness, model: val('nw-model') || modelsOf(harness)[0], ...(routeId === null ? {} : { routeId }) };
  const a = why === null ? await op('owned/new', body) : null;
  if (a?.ok !== true) return a === null && why === null ? undefined : dlgSay('new-dlg', why ?? errText(a.code));
  state.desk = null;
  state.deskTok++;
  setVal('nw-text', '');
  closeDlg('new-dlg');
  say(t('new.sent'));
  void poll();
  const id = a.body?.ownedId;
  if (/^[0-9a-f]{20}$/.test(id)) openNode(`n:${id}`);
}

/**
 * seat: 派出 an agent request: owned-new with its requestId, the card's text and harness and the model the
 * card named (the router model's pick, else the default). The server takes it only while it still waits.
 * @param {HTMLElement} el
 */
async function requestGo(el) {
  const id = el.dataset.req ?? '';
  const r = state.owned?.requests?.find((/** @type {any} */ x) => x.requestId === id && x.state === 'pending');
  if (r === undefined) return;
  if (settling()) return say(t('appr.settling'));
  const routeId = r.suggestion?.routeId ?? null;
  const model = el.dataset.model || modelsOf(r.harness)[0];
  const a = await op('owned/new', { text: r.text, harness: r.harness, model, requestId: r.requestId, ...(routeId === null ? {} : { routeId }) });
  if (a?.ok) answeredAt(el, id);
  said(a, t('req.sent'));
  if (a?.ok) void poll();
}

/** seat: 拒绝 an agent request (always taken while it waits). @param {HTMLElement} el */
async function requestNo(el) {
  const id = el.dataset.req ?? '';
  if (!/^[0-9a-f]{20}$/.test(id)) return;
  const a = await op(`agent-requests/${id}/reject`, {});
  if (a?.ok) answeredAt(el, id);
  said(a, t('req.rejected'));
}

async function sendMsg() {
  const to = state.to ?? selTo();
  const text = val('dock-in');
  const why = msgError(text);
  if (to === null || why !== null) return why === null || say(why);
  const a = await op(`owned/${to.id}/message`, { text });
  if (a?.ok) {
    setVal('dock-in', '');
    state.to = null;
    /** @type {HTMLElement} */ (dom.byId('dock-in')).focus();
  }
  said(a, t(a?.body?.via === 'queued' ? 'op.queued' : 'op.done', { what: to.title }));
}

/** Three stops; ending and the brake each take a second click within ARM_MS. @param {'interrupt' | 'end' | 'brake'} verb */
async function stop(verb) {
  const to = state.to ?? selTo();
  if (to === null) return;
  const arm = verb === 'end' ? 'endArm' : verb === 'brake' ? 'brakeArm' : null;
  if (arm !== null && state[arm] !== to.id) {
    state[arm] = to.id;
    after(ARM_MS, () => { state[arm] = null; schedule(); });
    return schedule();
  }
  state.endArm = null;
  state.brakeArm = null;
  const a = await op(`owned/${to.id}/${verb}`, {});
  if (verb !== 'brake') return said(a, t('op.done', { what: t(`dock.${verb}`) }));
  // The server knows why this session has no brake: the list's reason, not the shared code's two-way text.
  if (a !== null && !a.ok && a.code === 'brake-unavailable') return void say(t('dock.noBrake', { why: brakeWhyText(state.owned?.brakeWhy) }));
  // The brake's reply counts what the Job held and what is left; null: procguard could not say (T1).
  const b = a?.body;
  said(a, b?.left === 0 ? t('op.braked', { n: b.killed ?? 0 }) : typeof b?.left === 'number' ? t('op.brakeLeft', { n: b.left }) : t('op.brakedUnsure'));
}

/** An allow carries the shown digest and the queue rev; high risk only `sure` (held, typed). @param {string} id @param {boolean} sure @param {boolean} inPin @param {Element | null} el */
async function allow(id, sure, inPin, el = null) {
  const list = state.owned;
  const a = list?.approvals.find((/** @type {any} */ x) => x.approvalId === id);
  if (!list || !a || !a.canAccept || a.tooLong || (inPin && !pinWhole(a))) return;
  if (settling() || (a.high && !sure)) return say(t(settling() ? 'appr.settling' : 'appr.holdHint'));
  const r = await op(`approvals/${id}/allow`, { digest: a.digest, rev: list.rev });
  if (r?.ok && el !== null) answeredAt(el, id);
  said(r, t('appr.allowed'));
}

/** r4 §10.9's typed way (browse-mode screen readers, phones). @param {HTMLElement} el @param {string} id */
function typed(el, id) {
  const a = state.owned?.approvals.find((/** @type {any} */ x) => x.approvalId === id);
  const got = a && window.prompt(t('appr.typePrompt', { t: a.title }));
  if (typeof got === 'string') return got.trim() === t('appr.typeWord') ? allow(id, true, el.closest('.pin') !== null, el) : say(t('appr.typeWrong'));
}

/** A high-risk allow held HOLD_MS (pointer or Enter); letting go or a moved list cancels. @param {any} el */
function holdStart(el) {
  const rev = state.owned?.rev;
  if (state.hold !== null || rev === undefined || state.busy) return;
  if (settling()) return say(t('appr.settling'));
  const id = el.dataset.appr ?? '';
  const cancel = after(HOLD_MS, () => {
    if (state.hold?.id !== id) return;
    state.hold = null;
    state.justHeld = id;
    if (state.owned?.rev === rev) void allow(id, true, el.closest('.pin') !== null, el);
    schedule();
  });
  state.hold = { id, cancel };
  schedule();
}
function cancelHold() {
  state.hold?.cancel();
  state.hold = null;
  schedule();
}
/** @param {EventTarget | null} target */
const holdBtn = (target) => {
  const el = target instanceof Element ? /** @type {any} */ (target.closest('[data-act=allow]')) : null;
  return el?.dataset.high === '1' ? el : null;
};

/** The waiting bar holds its order under the pointer or focus (r4 §10.9); newcomers go last. */
const pinsHeld = () => state.pinHover || state.pinFocus;
/** @param {TowerSnapshot} snap */
function holdPins(snap) {
  const bar = snap.waitingBar;
  const pos = new Map((state.pinOrder ?? []).map((k, i) => [k, i]));
  const out = !pinsHeld() ? bar : [...bar.filter((e) => pos.has(e.node)).sort((p, q) => Number(pos.get(p.node)) - Number(pos.get(q.node))), ...bar.filter((e) => !pos.has(e.node))];
  state.pinOrder = out.map((e) => e.node);
  return out;
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
  const a = t0.dataset.act;
  const appr = t0.dataset.appr ?? '';
  // aria-disabled keeps the focus: the click does nothing (a void allow still says why).
  if (t0.getAttribute('aria-disabled') === 'true' && a !== 'allow') return;
  if (a === 'unlock' || (a === 'new' && state.csrf === null)) return void unlockStart();
  if (a === 'unlockGo') return void unlockGo();
  if (a === 'close') return /** @type {any} */ (t0.closest('dialog')).close();
  if (a === 'new') {
    dlgSay('new-dlg', '');
    pollOwned();
    return openDlg('new-dlg', 'nw-text');
  }
  if (a === 'dispatch') return void dispatch();
  if (a === 'suggest') return void suggest();
  if (a === 'pick') {
    const k = Number(/** @type {HTMLElement | null} */ (t0.closest('.cand'))?.dataset.pick);
    const c = state.desk?.reply.candidates[k];
    if (c !== undefined) pick(c);
    return schedule();
  }
  if (a === 'send') return void sendMsg();
  if (a === 'interrupt' || a === 'end' || a === 'brake') return void stop(a);
  if (a === 'deny') {
    return void op(`approvals/${appr}/deny`, {}).then((r) => {
      if (r?.ok) answeredAt(t0, appr);
      said(r, t('appr.denied'));
    });
  }
  // High risk: held or typed; the click a finished hold ends with is the hold's own.
  if (a === 'allow') {
    if (t0.dataset.high !== '1') return void allow(appr, false, t0.closest('.pin') !== null, t0);
    if (state.justHeld !== appr) return void typed(t0, appr);
    state.justHeld = null;
    return;
  }
  if (a === 'req-go') return void requestGo(t0);
  if (a === 'req-no') return void requestNo(t0);
  if (a === 'see') return openNode(/** @type {any} */ (t0.closest('.pin')).dataset.node);
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

pinsEl.addEventListener('pointerenter', () => { state.pinHover = true; });
pinsEl.addEventListener('pointerleave', () => { state.pinHover = false; schedule(); });
pinsEl.addEventListener('focusin', () => { state.pinFocus = true; });
pinsEl.addEventListener('focusout', (e) => { if (!(e.relatedTarget instanceof Node && pinsEl.contains(e.relatedTarget))) state.pinFocus = false; schedule(); });
document.addEventListener('pointerdown', (e) => {
  state.justHeld = null;
  const el = holdBtn(e.target);
  if (el !== null) holdStart(el);
});
// No long-press menu over a held allow: it would cancel the hold.
document.addEventListener('contextmenu', (e) => { if (holdBtn(e.target) !== null) e.preventDefault(); });
for (const ty of ['pointerup', 'pointercancel']) document.addEventListener(ty, cancelHold);
document.addEventListener('pointerout', (e) => { if (holdBtn(e.target) !== null) cancelHold(); });
document.addEventListener('keyup', (e) => { if (e.key === 'Enter') cancelHold(); });
document.addEventListener('keydown', (e) => {
  const el = holdBtn(e.target);
  const id = e.target instanceof Element ? e.target.id : '';
  if (e.key !== 'Enter' || e.isComposing || (el === null && id !== 'ul-code')) return;
  e.preventDefault();
  if (el === null) void unlockGo();
  else if (!e.repeat) holdStart(el);
});
// Typing holds the recipient (research §1.5).
// The dispatch dialog's model list follows its harness at once.
document.addEventListener('change', (e) => {
  if (!(e.target instanceof Element) || (e.target.id !== 'nw-harness' && e.target.id !== 'nw-model')) return;
  // A new harness redraws its model list first, so the card reads the model the select really shows (as pick() does).
  if (e.target.id === 'nw-harness') render();
  schedule();
});
// A closed dispatch dialog drops the suggestion still out (its reply would change nothing on screen).
dom.byId('new-dlg')?.addEventListener('close', () => {
  if (state.asking) state.deskTok++;
});
document.addEventListener('input', (e) => {
  // An edited sentence makes the card stale at once.
  if (e.target instanceof Element && e.target.id === 'nw-text') return schedule();
  if (!(e.target instanceof Element) || e.target.id !== 'dock-in') return;
  state.to = val('dock-in') === '' ? null : (state.to ?? selTo());
  schedule();
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
