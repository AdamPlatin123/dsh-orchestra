// @ts-check
// What both pages do to Orchestra's own sessions (orchestra app plan §2-§5, slice design §2.7): the unlock, the
// owned list and feeds, the dispatch desk, messages, the stops, and each allow under r4 §10.9's guards (D8: a
// person, on a page). One copy, so the home page (/) and the old tower (/tower) hold the same rules: an allow is
// held or typed where it must be, void while the list settles, and a tainted session's high risk is typed only.
// makeDrive only defines things; each page's boot (ui/app.js, ui/home.js) calls it with its own state and host.
import { getFeed, getOwned, getSession, oneAtATime, post } from './api.js';
import { after, fmtClock, nowMono } from './clock.js';
import {
  HOLD_MS, SETTLE_MS, brakeWhyText, closedTo, deskOf, modelsOf, atBottom, chatNews, describeAskPins, describeDesk, describeNew, describeReassign, describeOwned, describeOwnedDock, describeRequestPins, errText, isFeed, isOwnedList, isSuggestion, mergeFeed, msgError,
  allowHow, notifyRequestText, notifyText, ownedIdOf, pinExtra, pinWhole, requestModel, whyText, withQueued, withRequests,
} from './owned.js';
import { getCsrf, setCsrf, setTheme } from './prefs.js';
import { indexOf } from './tree.js';
import { describeDock, describePins, t } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('./view.js').Detail} Detail
 */

export const POLL_MS = 2000;
const NOTE_MS = 8000;
/** Ending a session takes a second click this soon. */
const ARM_MS = 3000;
/** Session reads that got no answer go out again this many times, 2, 4 and 8 s after each failed answer. */
const DETAIL_RETRIES = 3;

/** The part of a page's state this module keeps. */
export const driveState = () => ({
  /** @type {TowerSnapshot | null} */ snap: null,
  /** Monotonic time of the last good answer; null before the first. @type {number | null} */ okMono: null,
  /** The selected row's key. @type {string | null} */ sel: null,
  /** @type {Detail | null} */ detail: null,
  detailRev: '',
  /** The latest session read is out: no other goes out for the same session meanwhile. */ detailOut: false,
  /** The latest session read's number: only its answer lands (an older one's is dropped). */ detailSeq: 0,
  /** When the latest session read's answer came back (monotonic ms). */ detailMono: 0,
  /** Session reads in a row that got no answer (timeout, network), for the selected session. */ detailFails: 0,
  // csrf: this tab's token (null: locked); pinSig: bar and queue as drawn (a change starts the 750 ms);
  // to: the recipient, held once you type (§1.5).
  /** @type {string | null} */ csrf: getCsrf(),
  /** @type {any} */ owned: null,
  /** @type {Map<string, any>} */ feeds: new Map(),
  /** @type {string | null} */ feedFor: null,
  feedOut: false,
  // The chat's reader: what was said, up to which seq of which session (a session opened says nothing of its past).
  heard: { id: '', seq: 0, text: '' },
  pinSig: '',
  changedMono: -Infinity,
  settleTok: 'a',
  pinHover: false,
  pinFocus: false,
  /** @type {string[] | null} */ pinOrder: null,
  /** @type {{ id: string, cancel: () => void } | null} */ hold: null,
  // Approvals: one a hold just allowed; one answered (the focus moves on).
  /** @type {string | null} */ justHeld: null,
  /** @type {any} */ apprFocus: null,
  busy: false,
  // An unlock code is being asked for (one at a time: each replaces the last).
  unlockAsking: false,
  /** @type {string | null} */ note: null,
  /** @type {(() => void) | null} */ noteOff: null,
  /** @type {{ id: string, title: string } | null} */ to: null,
  /** The front desk's talk is open (no worker is selected then). */ front: false,
  /** @type {string | null} */ endArm: null,
  /** The session whose brake waits for its second click (ARM_MS). @type {string | null} */
  brakeArm: null,
  told: new Set(),
  // The dispatch desk: the last suggestion and the sentence it was for (null: none); a suggestion out.
  /** @type {{ text: string, reply: any } | null} */ desk: null,
  asking: false,
  // Bumped when a dispatch or a closed dialog makes a suggestion still out void: its reply is dropped.
  deskTok: 0,
  /** 改派: the request whose dialog is open (null: none). @type {string | null} */ re: null,
});

/**
 * @param {any} state a page's state, driveState() and more (its theme)
 * @param {ReturnType<typeof import('./dom.js').makePatcher>} dom
 * @param {{ schedule: () => void, render: () => void, poll: () => Promise<void> | void, openNode: (key: string) => void, homeId: string, rows?: any, openFront?: () => void, frontTalk?: any }} host
 * schedule: one render on the next frame; render: one now; poll: the tower read; openNode: shows a node (a new
 * session, an entry that says 去看); homeId: where the focus goes when the last entry of a list was answered;
 * openFront, frontTalk: the home page's way to the front desk's talk, and what it draws (ui/front.js).
 */
export function makeDrive(state, dom, host) {
  const { schedule } = host;
  /** @param {string} id */
  const val = (id) => String(/** @type {any} */ (dom.byId(id)).value ?? '');
  /** @param {string} id @param {string} v */
  const setVal = (id, v) => { /** @type {any} */ (dom.byId(id)).value = v; };

  const settling = () => nowMono() - state.changedMono < SETTLE_MS;
  const guard = () => ({ unlocked: state.csrf !== null, settle: settling() ? state.settleTok : '', hold: state.hold?.id ?? null, busy: state.busy, nowWall: nowWall() });

  /** The selected owned session as a recipient, or null. */
  function selTo() {
    if (state.front) {
      const d = deskOf(state.owned);
      return d === null ? null : { id: d.ownedId, title: t('front.name'), front: true };
    }
    const n = state.snap === null || state.sel === null ? undefined : indexOf(state.snap).byId.get(state.sel)?.node;
    const id = ownedIdOf(n);
    return id === null || n === undefined ? null : { id, title: n.title };
  }

  /** The daemon's time now: its observedAt plus the monotonic time since that answer (T7). */
  function nowWall() {
    if (state.snap === null || state.okMono === null) return 0;
    return state.snap.meta.observedAt + (nowMono() - state.okMono);
  }

  /** The dispatch dialog (always there, painted before the first tower too). */
  function paintDesk() {
    const nowDesk = {
      text: val('nw-text'), harness: val('nw-harness') || 'codex', model: val('nw-model'), asking: state.asking,
      enabled: state.owned?.enabled !== false, maxOwned: state.owned?.limits?.maxOwned,
    };
    dom.paintId('new-dlg', { slots: { ...describeNew(state.owned, nowDesk.harness, state.busy, val('nw-cwd')), ...describeDesk(state.desk, nowDesk) } });
    if (state.re !== null) dom.paintId('re-dlg', { slots: describeReassign(state.owned, pendingReq(state.re), val('re-harness') || 'codex', state.busy) });
  }

  /** The agent request `id` while it still waits for you, or null. @param {string} id */
  const pendingReq = (id) => state.owned?.requests?.find((/** @type {any} */ x) => x.requestId === id && x.state === 'pending') ?? null;

  /**
   * The bar or queue moved: allows are void for SETTLE_MS (r4 §10.9), a hold lets go.
   * seat: a new or gone agent request moves the bar too (派出 is void for SETTLE_MS, as an allow).
   * The model 派出 would send is in it too: a suggestion that comes later changes the button, so it waits again.
   * @param {readonly { node: string }[]} pinBar
   */
  function settleOn(pinBar) {
    const reqIds = (state.owned?.requests ?? []).filter((/** @type {any} */ r) => r.state === 'pending').map((/** @type {any} */ r) => `${r.requestId}:${requestModel(r).model}`).join();
    const sig = `${pinBar.map((e) => e.node).join()}|${state.owned?.rev ?? ''}|${reqIds}`;
    if (sig === state.pinSig) return;
    state.pinSig = sig;
    settle();
  }

  /** Allows are void from now for SETTLE_MS: the list moved, or (the home page) it moved on the page. */
  function settle() {
    state.changedMono = nowMono();
    state.settleTok = state.settleTok === 'a' ? 'b' : 'a';
    if (state.hold !== null) say(t('appr.holdCancelled'));
    cancelHold();
    after(SETTLE_MS + 20, schedule);
  }

  /** 「等你」 as it is drawn: the request cards (the list once unlocked; before that, or while it loads, the tower's router.asks) and the bar. @param {TowerSnapshot} snap @param {any} pinBar */
  function pinsPaint(snap, pinBar) {
    const g = guard();
    const reqCards = state.owned === null ? describeAskPins(snap.router.asks ?? [], g) : describeRequestPins(state.owned, g);
    return withQueued(withRequests(describePins(snap, { sel: state.sel, nowWall: nowWall(), bar: pinBar, extra: (/** @type {any} */ e) => pinExtra(e, state.owned, g) }), reqCards, pinBar), state.owned, g);
  }

  /**
   * The selected session's pane and the composer: `detail` is its describeDetail, the owned box and the chat go in here.
   * @param {TowerSnapshot} snap @param {any} detail
   * @param {boolean} [atEnd] the chat stood at its end before this frame moved anything; a page that paints above it first says so, as its height has changed by now
   */
  function paintSession(snap, detail, atEnd) {
    const g = guard();
    const mine = selTo();
    if ((mine?.id ?? null) !== state.feedFor) {
      state.feedFor = mine?.id ?? null;
      void pollFeed();
    }
    // Not a session of Orchestra's own: its box goes, and no control of the last one stays behind in it.
    /** @type {any} */
    const own = mine === null ? { ownBox: { data: { hide: '1' } }, ownActs: { kids: [] }, cards: { kids: [] }, chat: { kids: [] } } : mine.front === true ? host.frontTalk(mine.id, state.owned, state.feeds.get(mine.id), g, fmtClock) : describeOwned(mine.id, state.owned, state.feeds.get(mine.id), g);
    // The home page draws a dispatch row its own way; the old page takes it as any other line.
    if (mine !== null && own.chat !== undefined && host.rows !== undefined) own.chat = { kids: host.rows(own.chat.kids) };
    Object.assign(/** @type {any} */ (detail.slots), own);
    const feed = mine === null ? undefined : state.feeds.get(mine.id);
    const opened = feed !== undefined && state.heard.id !== mine?.id;
    if (feed !== undefined && mine !== null && (opened || feed.to > state.heard.seq)) {
      state.heard = { id: mine.id, seq: feed.to, text: opened ? '' : chatNews(feed, state.heard.seq) || state.heard.text };
    }
    /** @type {any} */ (detail.slots).chatSay = { text: mine !== null && state.heard.id === mine.id ? state.heard.text : '' };
    const chatEl = dom.slot(dom.byId('detail'), 'chat');
    const follow = opened || (atEnd ?? atBottom(chatEl));
    dom.paintId('detail', detail);
    // A draft holds its recipient until the box is emptied; a session that takes no more has no box, so nothing could
    // free it, and every other worker's composer would stay out of reach. The draft stays, and the line says to whom it goes now.
    if (state.to !== null && closedTo(state.owned, state.to.id)) {
      say(t('dock.toGone', { who: state.to.title }));
      state.to = null;
    }
    const dock = describeDock(snap, state.sel);
    const to = state.to ?? mine;
    Object.assign(/** @type {any} */ (dock.slots), describeOwnedDock(to, state.owned, g, state.to !== null, to !== null && state.endArm === to.id, to !== null && state.brakeArm === to.id), state.to === null ? {} : { to: { text: t('dock.to', { who: state.to.title }) } });
    const asksDesk = to !== null && to.id === deskOf(state.owned)?.ownedId;
    if (asksDesk) /** @type {any} */ (dock.slots).to = { text: t('front.ask') };
    /** @type {any} */ (dock.slots).in = { .../** @type {any} */ (dock.slots).in, attr: { placeholder: asksDesk ? t('front.ask') : null } };
    dom.paintId('dock', { ...dock, attr: { 'aria-disabled': String(to === null || !g.unlocked) } });
    // Last: the composer's height is the chat's too.
    if (follow && chatEl.scrollHeight !== undefined) chatEl.scrollTop = chatEl.scrollHeight;
  }

  /** An answered card or bar entry goes: a focus on it moves to the next there, else a heading (WCAG 2.4.3). */
  function moveFocusOn() {
    const f = state.apprFocus;
    if (!f || f.el.isConnected) return;
    const list = f.list;
    state.apprFocus = null;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.isConnected) return;
    /** @type {any} */ (list?.children[Math.min(f.i, list.children.length - 1)]?.querySelector('button') ?? dom.byId(f.card ? 'dt-title' : host.homeId)).focus();
  }

  /** @param {Element} el @param {string} id */
  function answeredAt(el, id) {
    const item = /** @type {any} */ (el.closest('.card') ?? el.closest('.pin'));
    const list = item?.parentNode;
    if (list) state.apprFocus = { id, el: item, list, card: item.classList.contains('card'), i: Array.from(list.children).indexOf(item) };
  }

  /**
   * The selected node's session detail, read once per session and rev, one read at a time. A read that got
   * no answer (timeout, network) goes out again POLL_MS after its answer came back, then 2x and 4x that
   * (DETAIL_RETRIES times, the note says it is read again); after that only when the rev changes, and the
   * note says so. A stuck orchestrad answers the tower with no new rev either, so the page stops asking.
   * @param {TowerSnapshot} snap @returns {Detail | null}
   */
  function detailFor(snap) {
    const hit = state.sel === null ? undefined : indexOf(snap).byId.get(state.sel);
    const id = hit?.node.session ?? null;
    if (id === null) return null;
    const same = state.detail !== null && state.detail.id === id;
    const body = same ? /** @type {Detail} */ (state.detail).body : null;
    const unanswered = body !== null && 'error' in body && (body.error === 'timeout' || body.error === 'network');
    const waiting = unanswered && state.detailFails <= DETAIL_RETRIES;
    const retry = waiting && nowMono() - state.detailMono >= POLL_MS * 2 ** (state.detailFails - 1);
    if (same && (state.detailOut || (waiting ? !retry : state.detailRev === snap.meta.rev))) return state.detail;
    if (!same) {
      state.detail = { id, body: null };
      state.detailFails = 0;
    }
    state.detailRev = snap.meta.rev;
    state.detailOut = true;
    const seq = ++state.detailSeq;
    void getSession(id).then((a) => {
      if (seq !== state.detailSeq) return;
      state.detailOut = false;
      state.detailMono = nowMono();
      const failed = !a.ok && (a.code === 'timeout' || a.code === 'network');
      state.detailFails = failed ? state.detailFails + 1 : 0;
      state.detail = { id, body: a.ok ? /** @type {any} */ (a.body) : state.detailFails > DETAIL_RETRIES ? { error: a.code, reads: state.detailFails } : { error: a.code } };
      schedule();
    });
    return state.detail;
  }

  // == owned sessions, once unlocked (hidden: read every 10 s, for notifications)
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

  /** Notifies approvals and agent requests that came while hidden; never an allow or a dispatch (r4 §10.9). @param {any} list @param {boolean} first */
  function tell(list, first) {
    const can = () => !first && document.hidden && globalThis.Notification?.permission === 'granted';
    for (const a of list.approvals) {
      if (!state.told.has(a.approvalId) && can()) {
        try {
          new Notification(t('notify.title'), { body: notifyText(a, list.owned.find((/** @type {any} */ o) => o.ownedId === a.ownedId)?.title || t('bar.brand')), tag: a.approvalId });
        } catch {} // refused (a phone): the tab's count (paintTitle) still moves, at the 10 s hidden read
      }
      state.told.add(a.approvalId);
    }
    for (const r of list.requests ?? []) {
      if (r.state !== 'pending') continue;
      if (!state.told.has(r.requestId) && can()) {
        try {
          new Notification(t('notify.reqTitle'), { body: notifyRequestText(r, nowWall(), list), tag: r.requestId });
        } catch {} // as above
      }
      state.told.add(r.requestId);
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
    // Each code replaces the last (src/server/owned.ts issue): a held Enter or quick clicks once asked 7 times
    // in 60 ms on the real profile (2026-11-03), and only the last printed code worked. One ask at a time; an
    // open dialog keeps its code.
    if (state.unlockAsking || /** @type {any} */ (dom.byId('unlock-dlg')).open) return openDlg('unlock-dlg', 'ul-code');
    state.unlockAsking = true;
    const a = await post(null, 'owned/unlock-code', null).finally(() => { state.unlockAsking = false; });
    if (!a.ok) return say(a.code === 'http-503' ? t('unlock.off') : a.code === 'unpaired' ? t('unlock.closed') : errText(a.code));
    dlgSay('unlock-dlg', '');
    openDlg('unlock-dlg', 'ul-code');
  }

  async function unlockGo() {
    const code = val('ul-code').trim();
    const a = /^[0-9]{8}$/.test(code) ? await post(null, 'owned/unlock', { code }) : null;
    const csrf = a?.ok ? /** @type {any} */ (a.body)?.csrf : null;
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
      const reason = a.ok ? t('route.failed.shape') : a.code === 'network' || a.code === 'timeout' || /^http-5(?!01)\d\d$/.test(a.code) ? t('route.failed.none') : errText(a.code);
      return dlgSay('new-dlg', t('route.failed', { why: reason }));
    }
    const reply = /** @type {any} */ (a.body);
    state.desk = { text, reply };
    const open = /** @type {any} */ (dom.byId('new-dlg')).open === true;
    const untouched = open && val('nw-text') === text && val('nw-harness') === before.harness && val('nw-model') === before.model;
    const first = reply.candidates[0];
    if (first !== undefined && untouched) pick(first);
    const now = { h: val('nw-harness') || 'codex', m: val('nw-model') };
    dlgSay('new-dlg', [first !== undefined && untouched && t('route.picked', { h: t(`harness.${now.h}`), m: now.m }), t('route.nothing')].filter(Boolean).join(t('sep.notes')));
    schedule();
  }

  /** A candidate into the two selects: the model list follows the harness at once, then the model. @param {{ harness: string, model: string }} c */
  function pick(c) {
    setVal('nw-harness', c.harness);
    host.render();
    setVal('nw-model', c.model);
  }

  /** Nothing leaves until 派出 (orchestra app plan §3); a card for this very sentence goes with it (routeId). */
  async function dispatch() {
    const text = val('nw-text');
    const why = msgError(text);
    const harness = val('nw-harness') || 'codex';
    const routeId = state.desk !== null && state.desk.text === text ? state.desk.reply.routeId : null;
    // A project root only as the list names it (--project-root); '' is Orchestra's own work dir.
    const root = val('nw-cwd');
    const body = { text, harness, model: val('nw-model') || modelsOf(harness)[0], ...(routeId === null ? {} : { routeId }), ...(root !== '' && (state.owned?.roots ?? []).includes(root) ? { root } : {}) };
    const a = why === null ? await op('owned/new', body) : null;
    if (a?.ok !== true) return a === null && why === null ? undefined : dlgSay('new-dlg', why ?? errText(a.code));
    state.desk = null;
    state.deskTok++;
    setVal('nw-text', '');
    closeDlg('new-dlg');
    say(t('new.sent'));
    void host.poll();
    const id = a.body?.ownedId;
    if (/^[0-9a-f]{20}$/.test(id)) host.openNode(`n:${id}`);
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
    if (a?.ok) void host.poll();
  }

  /**
   * 改派: the dialog for a waiting request, its harness and the model 派出 would take picked to begin with (the card's).
   * @param {HTMLElement} el
   */
  function reassignOpen(el) {
    const r = pendingReq(el.dataset.req ?? '');
    if (r === null) return;
    state.re = r.requestId;
    dlgSay('re-dlg', '');
    setVal('re-harness', r.harness);
    host.render();
    setVal('re-model', requestModel(r).model);
    openDlg('re-dlg', 're-harness');
  }

  /** 改派's 派出: owned-new with the requestId and the card's text, on the harness and model picked; the server checks them as any dispatch. */
  async function reassignGo() {
    const r = state.re === null ? null : pendingReq(state.re);
    if (r === null) return dlgSay('re-dlg', t('re.gone'));
    if (settling()) return dlgSay('re-dlg', t('appr.settling'));
    const harness = val('re-harness') === 'claude' ? 'claude' : 'codex';
    const model = val('re-model') || modelsOf(harness)[0];
    const routeId = r.suggestion?.routeId ?? null;
    const a = await op('owned/new', { text: r.text, harness, model, requestId: r.requestId, ...(routeId === null ? {} : { routeId }) });
    if (a?.ok !== true) return a === null ? undefined : dlgSay('re-dlg', errText(a.code));
    closeDlg('re-dlg');
    say(t('re.sent'));
    void host.poll();
    const id = a.body?.ownedId;
    if (/^[0-9a-f]{20}$/.test(id)) host.openNode(`n:${id}`);
  }

  /** seat: 拒绝 an agent request (always taken while it waits). @param {HTMLElement} el */
  async function requestNo(el) {
    const id = el.dataset.req ?? '';
    if (!/^[0-9a-f]{20}$/.test(id)) return;
    const a = await op(`agent-requests/${id}/reject`, {});
    if (a?.ok) answeredAt(el, id);
    said(a, t('req.rejected'));
  }

  /** A worker's dispatch permission: a person, this page (D8). @param {HTMLElement} el */
  async function setGrant(el) {
    const id = el.dataset.owned ?? '';
    const level = el.dataset.level ?? '';
    if (!/^[0-9a-f]{20}$/.test(id) || (level !== 'ask' && level !== 'free')) return;
    const a = await op(`owned/${id}/dispatch-grant`, { level });
    said(a, t('grant.set', { l: t(`grant.level.${level}`) }));
  }

  /** You open the front desk: owned-new, as any session you start, on the model the tile's select holds. */
  async function openFront() {
    const a = await op('owned/new', { text: t('front.opening'), harness: 'claude', model: val('front-model') || undefined, frontDesk: true });
    said(a, t('front.opened'));
    if (a?.ok) host.openFront?.();
  }

  /** The stop on a receipt: the same order as the session's own, for the worker the row names. @param {HTMLElement} el */
  async function stopWorker(el) {
    const id = el.dataset.owned ?? '';
    if (!/^[0-9a-f]{20}$/.test(id)) return;
    const a = await op(`owned/${id}/interrupt`, {});
    said(a, t('op.done', { what: t('dock.interrupt') }));
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

  /**
   * An allow carries the shown digest and the queue rev; high risk only held or typed, and a tainted session's
   * high risk only typed (r4 §8.5). @param {string} id @param {'click' | 'held' | 'typed'} how @param {boolean} inPin @param {Element | null} el
   */
  async function allow(id, how, inPin, el = null) {
    const list = state.owned;
    const a = list?.approvals.find((/** @type {any} */ x) => x.approvalId === id);
    if (!list || !a || !a.canAccept || a.tooLong || (inPin && !pinWhole(a))) return;
    const need = allowHow(a);
    if (settling() || (need === '1' && how === 'click') || (need === '2' && how !== 'typed')) return say(t(settling() ? 'appr.settling' : need === '2' ? 'appr.typeOnlyHint' : 'appr.holdHint'));
    const r = await op(`approvals/${id}/allow`, { digest: a.digest, rev: list.rev });
    if (r?.ok && el !== null) answeredAt(el, id);
    said(r, t('appr.allowed'));
  }

  /** r4 §10.9's typed way (browse-mode screen readers, phones). @param {HTMLElement} el @param {string} id */
  function typed(el, id) {
    const a = state.owned?.approvals.find((/** @type {any} */ x) => x.approvalId === id);
    const got = a && window.prompt(t(a.tainted === true ? 'appr.typePromptTainted' : 'appr.typePrompt', { t: a.title }));
    if (typeof got === 'string') return got.trim() === t('appr.typeWord') ? allow(id, 'typed', el.closest('.pin') !== null, el) : say(t('appr.typeWrong'));
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
      if (state.owned?.rev === rev) void allow(id, 'held', el.closest('.pin') !== null, el);
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
    const pos = new Map((state.pinOrder ?? []).map((/** @type {string} */ k, /** @type {number} */ i) => [k, i]));
    const out = !pinsHeld() ? bar : [...bar.filter((e) => pos.has(e.node)).sort((p, q) => Number(pos.get(p.node)) - Number(pos.get(q.node))), ...bar.filter((e) => !pos.has(e.node))];
    state.pinOrder = out.map((e) => e.node);
    return out;
  }

  /** The dispatch dialog, or the unlock when this tab is locked. */
  function openNew() {
    if (state.csrf === null) return void unlockStart();
    dlgSay('new-dlg', '');
    pollOwned();
    openDlg('new-dlg', 'nw-text');
  }

  /** What a control does here; false: the page's own (filters, routes, folds). @param {HTMLElement} t0 */
  function act(t0) {
    const a = t0.dataset.act;
    const appr = t0.dataset.appr ?? '';
    // aria-disabled keeps the focus: the click does nothing (a void allow still says why).
    if (t0.getAttribute('aria-disabled') === 'true' && a !== 'allow') return true;
    if (a === 'unlock') return void unlockStart(), true;
    if (a === 'unlockGo') return void unlockGo(), true;
    if (a === 'close') return /** @type {any} */ (t0.closest('dialog')).close(), true;
    if (a === 'new') return openNew(), true;
    if (a === 'dispatch') return void dispatch(), true;
    if (a === 'suggest') return void suggest(), true;
    if (a === 'pick') {
      const k = Number(/** @type {HTMLElement | null} */ (t0.closest('.cand'))?.dataset.pick);
      const c = state.desk?.reply.candidates[k];
      if (c !== undefined) pick(c);
      return schedule(), true;
    }
    if (a === 'send') return void sendMsg(), true;
    if (a === 'interrupt' || a === 'end' || a === 'brake') return void stop(a), true;
    if (a === 'deny') {
      void op(`approvals/${appr}/deny`, {}).then((r) => {
        if (r?.ok) answeredAt(t0, appr);
        said(r, t('appr.denied'));
      });
      return true;
    }
    // High risk: held or typed (a tainted session's: typed only, data-high 2); the click a finished hold ends with is the hold's own.
    if (a === 'allow') {
      if (t0.dataset.high === '0') void allow(appr, 'click', t0.closest('.pin') !== null, t0);
      else if (t0.dataset.high === '2' || state.justHeld !== appr) void typed(t0, appr);
      else state.justHeld = null;
      return true;
    }
    if (a === 'req-go') return void requestGo(t0), true;
    if (a === 'req-no') return void requestNo(t0), true;
    if (a === 'req-re') return reassignOpen(t0), true;
    if (a === 're-go') return void reassignGo(), true;
    if (a === 'grant') return void setGrant(t0), true;
    if (a === 'stop-worker') return void stopWorker(t0), true;
    if (a === 'theme') {
      state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
      setTheme(state.theme);
      return schedule(), true;
    }
    return false;
  }

  /** The listeners both pages share. @param {Element} pinsEl where 「等你」 is drawn */
  function listen(pinsEl) {
    pinsEl.addEventListener('pointerenter', () => { state.pinHover = true; });
    pinsEl.addEventListener('pointerleave', () => { state.pinHover = false; schedule(); });
    pinsEl.addEventListener('focusin', () => { state.pinFocus = true; });
    pinsEl.addEventListener('focusout', (e) => { if (!(/** @type {FocusEvent} */ (e).relatedTarget instanceof Node && pinsEl.contains(/** @type {FocusEvent} */ (e).relatedTarget))) state.pinFocus = false; schedule(); });
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
      if (!(e.target instanceof Element) || !['nw-harness', 'nw-model', 'nw-cwd', 're-harness', 're-model'].includes(e.target.id)) return;
      // A new harness redraws its model list first, so the card reads the model the select really shows (as pick() does).
      // A new work dir redraws its note at once (what a session there may do); 改派's where-line follows its harness.
      if (e.target.id === 'nw-harness' || e.target.id === 'nw-cwd' || e.target.id === 're-harness') host.render();
      schedule();
    });
    // A closed dispatch dialog drops the suggestion still out (its reply would change nothing on screen).
    dom.byId('new-dlg')?.addEventListener('close', () => {
      if (state.asking) state.deskTok++;
    });
    dom.byId('re-dlg')?.addEventListener('close', () => { state.re = null; });
    document.addEventListener('input', (e) => {
      // An edited sentence makes the card stale at once.
      if (e.target instanceof Element && e.target.id === 'nw-text') return schedule();
      if (!(e.target instanceof Element) || e.target.id !== 'dock-in') return;
      state.to = val('dock-in') === '' ? null : (state.to ?? selTo());
      schedule();
    });
  }

  return { act, cancelHold, detailFor, guard, holdPins, listen, moveFocusOn, nowWall, openFront, openNew, paintDesk, paintSession, pinsPaint, pollFeed, pollOwned, say, selTo, settle, settleOn, settling, unlock: unlockStart };
}
