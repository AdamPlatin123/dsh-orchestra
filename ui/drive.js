// @ts-check
// What the page does to Orchestra's own sessions (orchestra app plan §2-§5, slice design §2.7): the pairing, the
// owned list and feeds, the dispatch desk, messages, the stops, and each allow under r4 §10.9's guards (D8: a
// person, on a page). The rules in one place: an allow is held or typed where it must be, void while the list
// settles, and a tainted session's high risk is typed only.
// makeDrive only defines things; the page's boot (ui/home.js) calls it with its own state and host. Here: the state,
// the shared parts, a dialog's mechanics, the act table; the orders: ui/approve.js, reads.js, dock.js, dlg-*.js.
import { post } from './api.js';
import { after, nowMono } from './clock.js';
import { makeApprove } from './approve.js';
import { makeNew } from './dlg-new.js';
import { makePair } from './dlg-pair.js';
import { makeQa } from './dlg-qa.js';
import { makeRe } from './dlg-re.js';
import { makeDock } from './dock.js';
import { SETTLE_MS, deskOf, errText, ownedIdOf } from './owned.js';
import { getCsrf, setTheme } from './prefs.js';
import { makeReads } from './reads.js';
export { POLL_MS } from './reads.js';
import { indexOf } from './tree.js';
import { t } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('./view.js').Detail} Detail
 */

const NOTE_MS = 8000;

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
  // csrf: this browser's token (null: not paired); pinSig: bar and queue as drawn (a change starts the 750 ms);
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
  // Pairing: a code is being asked for (one at a time: each replaces the last); when the last printed one was
  // asked for (monotonic ms; -Infinity: none still good); a code is being tried.
  pairAsking: false,
  pairAskedMono: -Infinity,
  pairing: false,
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
  /**
   * 回答: the question card whose dialog is open and your pick for each of its questions so far (null: none yet).
   * @type {{ id: string, picks: ({ option: number } | { text: string } | null)[] } | null}
   */
  qa: null,
  /** The 回答 button the dialog was opened from: where the focus goes on once it is answered. @type {HTMLElement | null} */ qaFrom: null,
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

  /** @param {string} text */
  function say(text) {
    state.note = text;
    state.noteOff?.();
    state.noteOff = after(NOTE_MS, () => { state.note = null; schedule(); });
    schedule();
  }

  /** One owned POST at a time, on one thing. @param {string} path @param {object} body @returns {Promise<any>} */
  async function op(path, body) {
    if (state.busy || state.csrf === null) return null;
    state.busy = true;
    schedule();
    const a = await post(state.csrf, path, { actionId: crypto.randomUUID(), ...body });
    state.busy = false;
    if (!a.ok && a.code === 'not-unlocked') c.lock();
    c.pollOwned();
    c.pollFeed();
    return a;
  }
  /** @param {any} a @param {string} ok */
  const said = (a, ok) => a !== null && say(a.ok ? ok : errText(a.code));

  /** @type {ReturnType<typeof dialog>[]} */
  const dialogs = [];
  /**
   * One of the page's dialogs (ui/home.html: a <dialog>, an h2 or field to focus, slots, a msg line, buttons with
   * data-act). on: the state key of what it is open on: painted only while that is set, null again once it closes
   * (none: painted always); paint: its slots, from a describe*; shut: what else its closing drops; keep: a msg line
   * stays while it is open already. @param {string} id @param {string} focus
   * @param {{ on?: string, paint?: () => any, shut?: () => void, keep?: boolean }} [o]
   */
  function dialog(id, focus, o = {}) {
    const el = () => /** @type {any} */ (dom.byId(id));
    const d = {
      /** Open now (an answer that came back to a dialog closed meanwhile goes to the note). */
      shown: () => el().open === true,
      /** A dialog's own line (the note sits behind a modal). @param {string} text */
      say: (text) => dom.paintId(id, { slots: { msg: { text } } }),
      /** Sets what it is open on, empties its line, then fill (a render, the selects) before it shows. @param {object} [set] @param {() => void} [fill] */
      open(set = {}, fill) {
        Object.assign(state, set);
        if (!(o.keep && el().open)) d.say('');
        fill?.();
        if (!el().open) el().showModal();
        /** @type {any} */ (dom.byId(focus)).focus();
        schedule();
      },
      close: () => el().close(),
      paint() { if (o.paint && (o.on === undefined || state[o.on] !== null)) dom.paintId(id, { slots: o.paint() }); },
      listen() {
        if (o.on !== undefined || o.shut) el()?.addEventListener('close', () => { if (o.on !== undefined) state[o.on] = null; o.shut?.(); });
      },
    };
    dialogs.push(d);
    return d;
  }

  /** The parts the orders share; each module adds its own, and reaches another's through it when called. @type {any} */
  const c = { state, dom, host, schedule, val, setVal, settling, guard, nowWall, selTo, say, op, said, answeredAt, dialog };
  /** What a data-act does: the modules' own, and the two here. @type {Record<string, (el: HTMLElement) => unknown>} */
  const acts = {
    close: (t0) => /** @type {any} */ (t0.closest('dialog')).close(),
    theme: () => {
      state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
      setTheme(state.theme);
      schedule();
    },
  };
  /** @type {((pinsEl: Element) => void)[]} */
  const listens = [];
  for (const make of [makePair, makeNew, makeRe, makeQa, makeReads, makeApprove, makeDock]) {
    const { acts: a, listen: l, ...fns } = make(c);
    Object.assign(c, fns);
    Object.assign(acts, a);
    if (l) listens.push(l);
  }

  /** The dialogs, painted before the first tower too: the dispatch one always, the others while open on something. */
  const paintDesk = () => { for (const d of dialogs) d.paint(); };

  /** What a control does here; false: the page's own (filters, routes, folds). @param {HTMLElement} t0 */
  function act(t0) {
    const a = t0.dataset.act ?? '';
    // aria-disabled keeps the focus: the click does nothing (a void allow still says why).
    if (t0.getAttribute('aria-disabled') === 'true' && a !== 'allow') return true;
    if (!Object.hasOwn(acts, a)) return false;
    void acts[a](t0);
    return true;
  }

  /** The listeners the page takes from here. @param {Element} pinsEl where 「等你」 is drawn */
  function listen(pinsEl) {
    for (const l of listens) l(pinsEl);
    for (const d of dialogs) d.listen();
  }

  const { cancelHold, detailFor, holdPins, openFront, openNew, paintSession, pinsPaint, lock, pairOpen, pollFeed, pollOwned, settle, settleOn } = c;
  return { act, cancelHold, detailFor, guard, holdPins, listen, moveFocusOn, nowWall, openFront, openNew, paintDesk, paintSession, pinsPaint, lock, pairOpen, pollFeed, pollOwned, say, selTo, settle, settleOn, settling };
}
