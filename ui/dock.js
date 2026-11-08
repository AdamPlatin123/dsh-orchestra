// @ts-check
// The selected session's pane and what you tell a session there: the composer, the three stops, a worker's grant, the front desk.
import { after, fmtClock } from './clock.js';
import { atBottom, brakeWhyText, chatNews, closedTo, deskOf, describeOwned, describeOwnedDock, msgError } from './owned.js';
import { describeDock, t } from './view.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */

/** Ending a session takes a second click this soon. */
const ARM_MS = 3000;

/** @param {any} c ui/drive.js's shared parts */
export function makeDock(c) {
  const { state, dom, host, schedule, val, setVal, say, op, said, selTo } = c;

  /**
   * The selected session's pane and the composer: `detail` is its describeDetail, the owned box and the chat go in here.
   * @param {TowerSnapshot} snap @param {any} detail
   * @param {boolean} [atEnd] the chat stood at its end before this frame moved anything; a page that paints above it first says so, as its height has changed by now
   */
  function paintSession(snap, detail, atEnd) {
    const g = c.guard();
    const mine = selTo();
    if ((mine?.id ?? null) !== state.feedFor) {
      state.feedFor = mine?.id ?? null;
      void c.pollFeed();
    }
    // Not a session of Orchestra's own: its box goes, and no control of the last one stays behind in it.
    /** @type {any} */
    const own = mine === null ? { ownBox: { data: { hide: '1' } }, ownActs: { kids: [] }, cards: { kids: [] }, chat: { kids: [] } } : mine.front === true ? host.frontTalk(mine.id, state.owned, state.feeds.get(mine.id), g, fmtClock) : describeOwned(mine.id, state.owned, state.feeds.get(mine.id), g);
    // The page draws a dispatch row its own way (host.rows).
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

  // Typing holds the recipient (research §1.5).
  const listen = () => document.addEventListener('input', (e) => {
    if (!(e.target instanceof Element) || e.target.id !== 'dock-in') return;
    state.to = val('dock-in') === '' ? null : (state.to ?? selTo());
    schedule();
  });

  return {
    openFront, paintSession, listen,
    acts: { send: sendMsg, interrupt: () => stop('interrupt'), end: () => stop('end'), brake: () => stop('brake'), grant: setGrant, 'stop-worker': stopWorker },
  };
}
