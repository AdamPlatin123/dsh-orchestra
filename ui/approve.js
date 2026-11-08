// @ts-check
// 「等你」's answers under r4 §10.9's guards (D8): allow, deny, a request's 派出 and 拒绝 (seat); the bar's order held.
import { after, nowMono } from './clock.js';
import { HOLD_MS, SETTLE_MS, allowHow, describeAskPins, describeRequestPins, modelsOf, pinExtra, pinWhole, requestModel, withQueued, withRequests } from './owned.js';
import { describePins, t } from './view.js';

/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */

/** @param {any} c ui/drive.js's shared parts */
export function makeApprove(c) {
  const { state, schedule, settling, say, op, said, answeredAt } = c;

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
    const g = c.guard();
    const reqCards = state.owned === null ? describeAskPins(snap.router.asks ?? [], g) : describeRequestPins(state.owned, g);
    return withQueued(withRequests(describePins(snap, { sel: state.sel, nowWall: c.nowWall(), bar: pinBar, extra: (/** @type {any} */ e) => pinExtra(e, state.owned, g) }), reqCards, pinBar), state.owned, g);
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
    if (a?.ok) void c.host.poll();
  }

  /** seat: 拒绝 an agent request (always taken while it waits). @param {HTMLElement} el */
  async function requestNo(el) {
    const id = el.dataset.req ?? '';
    if (!/^[0-9a-f]{20}$/.test(id)) return;
    const a = await op(`agent-requests/${id}/reject`, {});
    if (a?.ok) answeredAt(el, id);
    said(a, t('req.rejected'));
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

  /** @param {HTMLElement} t0 */
  function deny(t0) {
    const appr = t0.dataset.appr ?? '';
    void op(`approvals/${appr}/deny`, {}).then((r) => {
      if (r?.ok) answeredAt(t0, appr);
      said(r, t('appr.denied'));
    });
  }

  /** High risk: held or typed (a tainted session's: typed only, data-high 2); the click a finished hold ends with is the hold's own. @param {HTMLElement} t0 */
  function allowAct(t0) {
    const appr = t0.dataset.appr ?? '';
    if (t0.dataset.high === '0') void allow(appr, 'click', t0.closest('.pin') !== null, t0);
    else if (t0.dataset.high === '2' || state.justHeld !== appr) void typed(t0, appr);
    else state.justHeld = null;
  }

  /** @param {Element} pinsEl where 「等你」 is drawn */
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
      if (e.key !== 'Enter' || e.isComposing || el === null) return;
      e.preventDefault();
      if (!e.repeat) holdStart(el);
    });
  }

  return { cancelHold, holdPins, pinsPaint, settle, settleOn, listen, acts: { allow: allowAct, deny, 'req-go': requestGo, 'req-no': requestNo } };
}
