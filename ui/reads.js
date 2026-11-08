// @ts-check
// What the page reads of Orchestra's own sessions: a session's detail, the owned list and its feeds, and the notifications.
import { getFeed, getOwned, getSession, oneAtATime } from './api.js';
import { nowMono } from './clock.js';
import { isFeed, isOwnedList, mergeFeed, notifyRequestText, notifyText } from './owned.js';
import { indexOf } from './tree.js';
import { t } from './view.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot @typedef {import('./view.js').Detail} Detail */

/** The page reads every this often (the tower, the list, the feed). */
export const POLL_MS = 2000;
/** Session reads that got no answer go out again this many times, 2, 4 and 8 s after each failed answer. */
const DETAIL_RETRIES = 3;

/** @param {any} c ui/drive.js's shared parts */
export function makeReads(c) {
  const { state, schedule } = c;

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
    if (!a.ok && (a.code === 'not-unlocked' || a.code === 'unpaired')) c.lock();
    else if (a.ok && isOwnedList(a.body)) {
      const first = state.owned === null;
      state.owned = a.body;
      tell(a.body, first);
    }
    schedule();
  }

  async function pollFeed() {
    const id = c.selTo()?.id;
    if (id === undefined || state.csrf === null || state.feedOut) return;
    state.feedOut = true;
    const a = await getFeed(state.csrf, id, state.feeds.get(id)?.to ?? 0);
    state.feedOut = false;
    if (!a.ok && a.code === 'not-unlocked') c.lock();
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
          new Notification(t('notify.reqTitle'), { body: notifyRequestText(r, c.nowWall(), list), tag: r.requestId });
        } catch {} // as above
      }
      state.told.add(r.requestId);
    }
  }

  return { detailFor, pollOwned, pollFeed };
}
