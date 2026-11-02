// @ts-check
// The tower page's boot (orchestra app plan §5), the one module with top-level effects: the 2 s poll
// (stopped while hidden), the hash route, clicks and keys, one render per frame. The tower is read only;
// Orchestra's own sessions are driven from here once this tab is unlocked (slice design §2.7), each
// allow under r4 §10.9's guards (D8). ui/owned.js says what shows.
//
// While the pointer or focus is in the tree its order holds (research §1.5): fresh data reaches the rows
// that stay; what would appear, go or move is counted on "↻ N", applied on a click or 5 s after leaving.
import { getFeed, getOwned, getSession, getTower, oneAtATime, post } from './api.js';
import { after, every, fmtIso, nowMono, onFrame } from './clock.js';
import { makePatcher } from './dom.js';
import { getCsrf, getTheme, setCsrf, setTheme } from './prefs.js';
import {
  HOLD_MS, MODELS, SETTLE_MS, describeNew, describeOwned, describeOwnedDock, errText, isFeed, isOwnedList, mergeFeed, msgError, notifyText, ownedIdOf, pinExtra, pinWhole,
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
  /** A changed row's new state, lit until `until` (monotonic), once. @type {Map<string, { state: string, until: number }>} */ flash: new Map(),
  /** The last render's view, to move the focus when the node page opens or closes. */ lastView: 'tower',
  /** @type {number | null} */ lastWaiting: null,
  /** A row to focus after the next render. @type {string | null} */ focusKey: null,
  queued: false,
  // Owned sessions. csrf: this tab's controller token, null while locked; pinSig: the waiting bar and
  // queue as last drawn (a change starts the 750 ms); to: the recipient, held once you type (§1.5).
  csrf: getCsrf(),
  owned: null,
  /** @type {Map<string, any>} */ feeds: new Map(),
  feedFor: null,
  feedOut: false,
  pinSig: '',
  changedMono: -Infinity,
  settleTok: 'a',
  pinHover: false,
  pinFocus: false,
  pinOrder: null,
  hold: null,
  heldMono: -Infinity,
  busy: false,
  note: null,
  noteOff: null,
  to: null,
  endArm: null,
  told: new Set(),
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
  Object.assign(/** @type {any} */ (bar.slots), { new: { text: t(open ? 'bar.new' : 'bar.newLocked') }, unlock: { text: t(open ? 'bar.unlocked' : 'bar.unlock'), attr: { 'aria-pressed': String(open) } } });
  dom.paintId('bar', bar);
  dom.paintId('note', { text: state.note ?? '', data: { hide: state.note === null ? '1' : '0' } });
  dom.paintId('new-dlg', { slots: describeNew(state.owned, val('nw-h') || 'codex', state.busy) });
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
  const sig = `${pinBar.map((e) => e.node).join()}|${state.owned?.rev ?? ''}`;
  if (sig !== state.pinSig) {
    state.pinSig = sig;
    state.changedMono = nowMono();
    state.settleTok = state.settleTok === 'a' ? 'b' : 'a';
    cancelHold();
    after(SETTLE_MS + 20, schedule);
  }
  const g = guard();
  dom.paintId('pins', describePins(snap, { sel: state.sel, nowWall: wall, bar: pinBar, extra: (e) => pinExtra(e, state.owned, g) }));
  dom.paintId('tower', describeTower(rows, { filter: state.filter, pending, sel: state.sel, peek: state.peek, flash, detectsError: detectsError(snap), clipped: clippedSessions(snap) }));
  const detail = describeDetail(snap, state.sel, rows, detailFor(snap), { nowWall: wall, fmtIso });
  const mine = selTo();
  if ((mine?.id ?? null) !== state.feedFor) {
    state.feedFor = mine?.id ?? null;
    void pollFeed();
  }
  Object.assign(/** @type {any} */ (detail.slots), mine === null ? { ownBox: { data: { hide: '1' } } } : describeOwned(mine.id, state.owned, state.feeds.get(mine.id), g));
  dom.paintId('detail', detail);
  const dock = describeDock(snap, state.sel);
  const to = state.to ?? mine;
  Object.assign(/** @type {any} */ (dock.slots), describeOwnedDock(to, state.owned, g, state.to !== null, to !== null && state.endArm === to.id), state.to === null ? {} : { to: { text: t('dock.to', { who: state.to.title }) } });
  dom.paintId('dock', { ...dock, attr: { 'aria-disabled': String(to === null || !g.unlocked) } });
  const about = dom.byId('about');
  dom.paint(about, { data: { hide: view === 'about' ? '0' : '1' } });
  if (view === 'about') dom.paint(about, describeAbout(snap));

  // On a narrow screen the node page replaces the tree: the focus goes to its title, and back to the
  // row it came from when it closes (a hidden element cannot hold it).
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
}

/** The selected node's session detail, read once per session and revision. @param {TowerSnapshot} snap @returns {Detail | null} */
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
    // The daemon holds each snapshot to its contract (src/server/http.ts); the page checks the frame it reads.
    const why = towerFrame(body);
    if (why !== null) {
      state.error = t('err.shape', { why });
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
      if (was !== undefined && was !== n.state) state.flash.set(n.id, { state: n.state, until: nowMono() + FLASH_MS });
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

/** Notifies approvals that came while hidden, if granted; never an allow (r4 §10.9). @param {any} list @param {boolean} first */
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
/** A dialog's own line (the note under the bar sits behind a modal). @param {string} id @param {string} text */
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

/** One owned POST at a time, on one thing (no batch). @param {string} path @param {object} body @returns {Promise<any>} */
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

/** Nothing leaves until 派出 (orchestra app plan §3). */
async function dispatch() {
  const text = val('nw-text');
  const why = msgError(text);
  const a = why === null ? await op('owned/new', { text, harness: val('nw-h') || 'codex', model: val('nw-model') || MODELS[0] }) : null;
  if (a?.ok !== true) return a === null && why === null ? undefined : dlgSay('new-dlg', why ?? errText(a.code));
  setVal('nw-text', '');
  closeDlg('new-dlg');
  say(t('new.sent'));
  void poll();
  const id = a.body?.ownedId;
  if (/^[0-9a-f]{20}$/.test(id)) openNode(`n:${id}`);
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
  }
  said(a, t('op.done', { what: to.title }));
}

/** Two stops; ending takes a second click within ARM_MS. @param {'interrupt' | 'end'} verb */
async function stop(verb) {
  const to = state.to ?? selTo();
  if (to === null) return;
  if (verb === 'end' && state.endArm !== to.id) {
    state.endArm = to.id;
    after(ARM_MS, () => { state.endArm = null; schedule(); });
    return schedule();
  }
  state.endArm = null;
  said(await op(`owned/${to.id}/${verb}`, {}), t('op.done', { what: t(`dock.${verb}`) }));
}

/** An allow carries the shown request's digest and the queue revision. @param {string} id @param {boolean} held @param {boolean} inPin */
async function allow(id, held, inPin) {
  const list = state.owned;
  const a = list?.approvals.find((/** @type {any} */ x) => x.approvalId === id);
  if (!list || !a || !a.canAccept || a.tooLong || (inPin && !pinWhole(a))) return;
  if (settling() || (a.high && !held)) return say(t(settling() ? 'appr.settling' : 'appr.holdHint'));
  said(await op(`approvals/${id}/allow`, { digest: a.digest, rev: list.rev }), t('appr.allowed'));
}

/** A high-risk allow is held HOLD_MS (pointer or Enter); letting go or a moving list cancels it. @param {any} el */
function holdStart(el) {
  const rev = state.owned?.rev;
  if (state.hold !== null || rev === undefined || state.busy) return;
  if (settling()) return say(t('appr.settling'));
  const id = el.dataset.appr ?? '';
  const cancel = after(HOLD_MS, () => {
    if (state.hold?.id !== id) return;
    state.hold = null;
    state.heldMono = nowMono();
    if (state.owned?.rev === rev) void allow(id, true, el.closest('.pin') !== null);
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

/** Makes `key` visible and selected: ancestors unfold, its group opens, a filter it fails drops. @param {string} key @param {boolean} focus */
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

/** Opens a node: its detail beside the tree when wide (no history entry), its own page when narrow. @param {string} key */
function openNode(key) {
  select(key, false);
  go({ view: 'tower', node: key }, !narrow());
}

/** Opens a row: a node's page (its detail; full screen on a phone), else its fold. @param {Row} r */
function openRow(r) {
  if (r.kind === 'node') {
    openNode(r.key);
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
  // The layout on screen holds (a fold or filter you choose lays out afresh).
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
  if (a === 'unlock' || (a === 'new' && state.csrf === null)) return void unlockStart();
  if (a === 'unlockGo') return void unlockGo();
  if (a === 'close') return /** @type {any} */ (t0.closest('dialog')).close();
  if (a === 'new') {
    dlgSay('new-dlg', '');
    pollOwned();
    return openDlg('new-dlg', 'nw-text');
  }
  if (a === 'dispatch') return void dispatch();
  if (a === 'send') return void sendMsg();
  if (a === 'interrupt' || a === 'end') return void stop(a);
  if (a === 'deny') return void op(`approvals/${appr}/deny`, {}).then((r) => said(r, t('appr.denied')));
  // A high-risk allow goes by holding; the click ending a hold is its own.
  if (a === 'allow') return t0.dataset.high !== '1' ? void allow(appr, false, t0.closest('.pin') !== null) : nowMono() - state.heldMono > 600 && say(t('appr.holdHint'));
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
  // A waiting-bar entry opens its node; when wide the focus follows to its row.
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
document.addEventListener('pointerdown', (e) => { const el = holdBtn(e.target); if (el !== null) holdStart(el); });
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
document.addEventListener('input', (e) => {
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
