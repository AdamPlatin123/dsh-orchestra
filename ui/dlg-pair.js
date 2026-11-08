// @ts-check
// The pairing and forget dialogs (2026-11-08: pair once): one code pairs this browser for good, across restarts of both sides.
import { forgetBrowser, pair, pairCode } from './api.js';
import { nowMono } from './clock.js';
import { errText } from './owned.js';
import { setCsrf } from './prefs.js';
import { t } from './view.js';

/** How long a code the console printed holds (src/server/http.ts PAIR_TTL_MS): no new one is asked for meanwhile. */
const PAIR_CODE_MS = 10 * 60 * 1000;

/** @param {any} c ui/drive.js's shared parts */
export function makePair(c) {
  const { state, host, val, setVal, say } = c;
  // Opening asks for no code: the one printed at the start may be good, and a code asked for stays good 10 minutes.
  const pairDlg = c.dialog('pair-dlg', 'pr-code', { keep: true });
  const forgetDlg = c.dialog('forget-dlg', 'fg-no');

  /** This browser's token, and what it read, gone; nothing is asked of the daemon. */
  function unpair() {
    setCsrf((state.csrf = null));
    state.owned = null;
    state.feeds.clear();
    c.cancelHold();
  }

  /** The token is no good (the browser was forgotten, the cookie is gone, 90 days passed): the pairing dialog again. */
  function lock() {
    unpair();
    say(t('pair.lost'));
    pairOpen();
  }

  /** The top bar's button and a 先配对: unpaired, the pairing dialog; paired, the way to forget this browser. */
  const pairOpen = () => (state.csrf !== null ? forgetDlg : pairDlg).open();

  /**
   * The daemon prints a code on its console (204: never in a reply). Each code replaces the last: a held Enter or
   * quick clicks once asked 7 times in 60 ms on the real profile (2026-11-03), and only the last printed code
   * worked. So one ask at a time, and none while the last one printed is still good (10 minutes, unless the daemon
   * said it was spent): one click, at most one code.
   */
  async function pairCodeAsk() {
    if (state.pairAsking) return;
    if (nowMono() - state.pairAskedMono < PAIR_CODE_MS) return pairDlg.say(t('pair.asked'));
    state.pairAsking = true;
    const a = await pairCode().finally(() => { state.pairAsking = false; });
    if (a.ok) state.pairAskedMono = nowMono();
    pairDlg.say(a.ok ? t('pair.asked') : a.code === 'http-503' ? t('pair.off') : a.code === 'not-unlocked' ? pairWhy(a.why) : errText(a.code));
    /** @type {any} */ (c.dom.byId('pr-code')).focus();
  }

  /** What a refused code means. @param {string | undefined} why */
  function pairWhy(why) {
    // A spent code (voided, expired, none, shut) is no longer worth keeping: the next click asks for a new one.
    if (why !== 'wrong') state.pairAskedMono = -Infinity;
    return why === 'voided' ? t('pair.voided') : why === 'expired' ? t('pair.expired') : why === 'no-code' ? t('pair.noCode') : why === 'shut' ? t('pair.shut') : t('pair.wrong');
  }

  async function pairGo() {
    if (state.pairing) return;
    const code = val('pr-code').trim();
    if (!/^[0-9]{8}$/.test(code)) return pairDlg.say(t('pair.format'));
    state.pairing = true;
    const a = await pair(code).finally(() => { state.pairing = false; });
    const csrf = a.ok ? /** @type {any} */ (a.body)?.csrf : null;
    if (!/^[\w-]{43}$/.test(csrf)) return pairDlg.say(a.ok ? t('pair.wrong') : a.code === 'not-unlocked' ? pairWhy(a.why) : errText(a.code));
    // The cookie came with the reply: the page works at once, no reload.
    setCsrf((state.csrf = csrf));
    state.pairAskedMono = -Infinity;
    state.error = null;
    setVal('pr-code', '');
    pairDlg.close();
    say(t('pair.ok'));
    if (globalThis.Notification?.permission === 'default') void Notification.requestPermission();
    void host.poll();
    c.pollOwned();
    c.pollFeed();
  }

  /** Forgets this browser (confirmed in its dialog): the daemon drops its pairing and clears the cookie. */
  async function forgetGo() {
    if (state.csrf === null) return forgetDlg.close();
    const a = await forgetBrowser(state.csrf);
    // A token already dead is forgotten here too; anything else leaves the pairing as it was.
    if (!a.ok && a.code !== 'not-unlocked' && a.code !== 'unpaired') return forgetDlg.say(errText(a.code));
    unpair();
    forgetDlg.close();
    say(t('pair.forgotten'));
  }

  /** Enter in the code's field tries it. */
  const listen = () => document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !(e.target instanceof Element) || e.target.id !== 'pr-code') return;
    e.preventDefault();
    void pairGo();
  });

  return { lock, pairOpen, listen, acts: { pair: pairOpen, pairCode: pairCodeAsk, pairGo, forgetGo } };
}
