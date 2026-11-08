// @ts-check
// The dispatch dialog (orchestra app plan §3): what it shows, the "Route to?" card, and 派出.
import { post } from './api.js';
import { errText, join, modelsOf, msgError, tk, whyText } from './owned.js';
import { t } from './view.js';

/**
 * The dispatch dialog: a harness that cannot start is greyed, with why. The work dir is Orchestra's own by
 * default; the other choices are the project roots the list names (--project-root), never a free path, and
 * the note says what a session there may do (`root`: the select's value, '' for the default).
 */
export function describeNew(list, harness, busy, root = '') {
  const h = list?.harnesses ?? {};
  const roots = Array.isArray(list?.roots) ? list.roots : [];
  const picked = roots.includes(root) ? root : '';
  return {
    cwdBox: { data: { hide: roots.length === 0 ? '1' : '0' } },
    cwdSel: { kids: [{ key: 'cwd:', tpl: 'tpl-opt', text: t('new.cwdWork'), attr: { value: '' } }, ...roots.map((r) => ({ key: `cwd:${r}`, tpl: 'tpl-opt', text: r, attr: { value: r } }))] },
    cwdNote: { text: picked === '' ? t(roots.length === 0 ? 'new.cwd' : 'new.cwdWorkNote') : t(harness === 'claude' ? 'new.cwdRootClaude' : 'new.cwdRootCodex', { d: picked }) },
    hCodex: { attr: { disabled: h.codex ? null : '' } }, hClaude: { attr: { disabled: h.claude ? null : '' } },
    why: { text: join([list === null ? t('new.noList') : !list.enabled && t('new.off', { why: whyText(list.disabledWhy ?? '') }), list !== null && !h.claude && t('new.claudeOff'), list !== null && !h.codex && list.enabled && t('new.codexOff')], 'sep.notes') },
    // The list follows the harness: keyed by harness too, so a switch replaces the options (and the default is the first).
    model: { kids: modelsOf(harness).map((m) => ({ key: `${harness}:${m}`, tpl: 'tpl-opt', text: m, attr: { value: m } })) },
    note: { text: t(harness === 'claude' ? 'new.claudeNote' : 'new.sandbox') },
    go: { text: t(busy ? 'op.busy' : 'new.go'), attr: { disabled: busy || !list?.enabled || !h[harness] ? '' : null } },
  };
}

// --- the dispatch desk (orchestra app plan §3): the "Route to?" card ------------------------------------

/** POST /api/route/suggest's reply (src/server/routes.ts SUGGEST_REPLY), enough to draw it. */
export const isSuggestion = (b) => typeof b?.routeId === 'string' && /^[0-9a-f]{20}$/.test(b.routeId) && Array.isArray(b?.candidates) && typeof b?.router?.state === 'string' && Array.isArray(b?.off);

/** The candidate the dialog's two selects name, or -1 (set by hand). */
export const pickedIndex = (reply, harness, model) => (reply === null ? -1 : reply.candidates.findIndex((c) => c.harness === harness && c.model === model));

/**
 * The card: first and alternatives, each with its harness, model, reason and where it came from; what
 * the router model did; the pick the selects hold. A sentence edited after the suggestion makes it stale
 * (its dispatch carries no routeId). `desk`: { text, reply } or null; `now`: { text, harness, model, asking,
 * enabled (false: orchestrad has no owned sessions, so no desk either: the button stays off), maxOwned }.
 */
export function describeDesk(desk, now) {
  const reply = desk?.reply ?? null;
  const stale = desk !== null && desk.text !== now.text;
  const ask = { text: t(now.asking ? 'new.asking' : 'new.ask'), attr: { 'aria-disabled': now.asking || now.enabled === false ? 'true' : null } };
  if (reply === null) return { ask, card: { data: { hide: '1', stale: '0' } }, rtTitle: { text: '' }, rtNote: { text: '' }, cands: { kids: [] }, rtPick: { text: '' } };
  const i = pickedIndex(reply, now.harness, now.model);
  const r = reply.router;
  const noWhy = r.why === null ? '' : tk('route.no', r.why, 'route.no.other');
  const state = tk('route.state', r.state, 'route.state.off', { m: r.model, why: noWhy });
  const cands = reply.candidates.map((c, k) => {
    const rank = t(k === 0 ? 'route.first' : 'route.alt');
    const hm = `${t(`harness.${c.harness}`)} · ${c.model}`;
    const src = t(c.source === 'model' ? 'route.src.model' : r.pick === k ? 'route.src.both' : 'route.src.rule');
    const why = c.source === 'model' ? c.reason ?? t('route.why.model') : tk('route.why', c.rule, 'route.why.fallback');
    return {
      key: `${reply.routeId}:${k}`, tpl: 'tpl-cand', data: { pick: String(k), harness: c.harness },
      // A reader hears the parts apart (the spans alone run into one another).
      slots: { b: { attr: { 'aria-pressed': k === i ? 'true' : 'false', 'aria-label': t('route.candLabel', { rank, hm, src, why }) } }, rank: { text: rank }, hm: { text: hm }, src: { text: src }, why: { text: why } },
    };
  });
  const offH = reply.off.length === 0 ? '' : t('route.offH', { h: reply.off.map((h) => t(`harness.${h}`)).join(t('sep.parts')) });
  return {
    ask,
    card: { data: { hide: '0', stale: stale ? '1' : '0' } },
    rtTitle: { text: t(reply.titleSource === 'model' ? 'route.taskTitleModel' : 'route.taskTitle', { t: reply.title }) },
    rtNote: { text: join([state, reply.full === true && t('route.full', { n: now.maxOwned ?? '?' }), offH, reply.candidates.length === 0 && t('route.none')], 'sep.notes') },
    cands: { kids: cands },
    rtPick: { text: stale ? t('route.stale') : i < 0 ? t('route.manual') : t('route.picked', { h: t(`harness.${now.harness}`), m: now.model }) },
  };
}

/** @param {any} c ui/drive.js's shared parts */
export function makeNew(c) {
  const { state, host, schedule, val, setVal, say, op } = c;
  const dlg = c.dialog('new-dlg', 'nw-text', {
    paint() {
      const nowDesk = {
        text: val('nw-text'), harness: val('nw-harness') || 'codex', model: val('nw-model'), asking: state.asking,
        enabled: state.owned?.enabled !== false, maxOwned: state.owned?.limits?.maxOwned,
      };
      return { ...describeNew(state.owned, nowDesk.harness, state.busy, val('nw-cwd')), ...describeDesk(state.desk, nowDesk) };
    },
    // A closed dispatch dialog drops the suggestion still out (its reply would change nothing on screen).
    shut() { if (state.asking) state.deskTok++; },
  });

  /**
   * The dispatch desk: a "Route to?" card for the sentence; it starts nothing (orchestra app plan §3). The
   * reply fills the two selects only if, meanwhile, the dialog stayed open, the sentence and both selects
   * stayed as they were, and nothing was dispatched: a choice made by hand is never overwritten.
   */
  async function suggest() {
    const text = val('nw-text');
    const why = msgError(text);
    if (why !== null) return dlg.say(why);
    // orchestrad without owned sessions has no desk (POST /api/route/suggest is 501): say why, not the code.
    if (state.owned !== null && state.owned.enabled === false) return dlg.say(t('new.off', { why: whyText(state.owned.disabledWhy ?? '') }));
    if (state.asking || state.csrf === null) return;
    const tok = ++state.deskTok;
    const before = { harness: val('nw-harness'), model: val('nw-model') };
    state.asking = true;
    dlg.say('');
    schedule();
    const a = await post(state.csrf, 'route/suggest', { text });
    state.asking = false;
    if (tok !== state.deskTok) return schedule();
    if (!a.ok || !isSuggestion(a.body)) {
      if (!a.ok && a.code === 'not-unlocked') c.lock();
      schedule();
      // No suggestion is no harm: nothing was started or written; the person can pick by hand.
      const reason = a.ok ? t('route.failed.shape') : a.code === 'network' || a.code === 'timeout' || /^http-5(?!01)\d\d$/.test(a.code) ? t('route.failed.none') : errText(a.code);
      return dlg.say(t('route.failed', { why: reason }));
    }
    const reply = /** @type {any} */ (a.body);
    state.desk = { text, reply };
    const untouched = dlg.shown() && val('nw-text') === text && val('nw-harness') === before.harness && val('nw-model') === before.model;
    const first = reply.candidates[0];
    if (first !== undefined && untouched) pick(first);
    const now = { h: val('nw-harness') || 'codex', m: val('nw-model') };
    dlg.say([first !== undefined && untouched && t('route.picked', { h: t(`harness.${now.h}`), m: now.m }), t('route.nothing')].filter(Boolean).join(t('sep.notes')));
    schedule();
  }

  /** A candidate into the two selects: the model list follows the harness at once, then the model. @param {{ harness: string, model: string }} cand */
  function pick(cand) {
    setVal('nw-harness', cand.harness);
    host.render();
    setVal('nw-model', cand.model);
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
    if (a?.ok !== true) return a === null && why === null ? undefined : dlg.say(why ?? errText(a.code));
    state.desk = null;
    state.deskTok++;
    setVal('nw-text', '');
    dlg.close();
    say(t('new.sent'));
    void host.poll();
    const id = a.body?.ownedId;
    if (/^[0-9a-f]{20}$/.test(id)) host.openNode(`n:${id}`);
  }

  /** The dispatch dialog, or the pairing while this browser is not paired. */
  const openNew = () => (state.csrf === null ? c.pairOpen() : dlg.open({}, () => c.pollOwned()));

  /** @param {HTMLElement} t0 */
  function pickAct(t0) {
    const k = Number(/** @type {HTMLElement | null} */ (t0.closest('.cand'))?.dataset.pick);
    const cand = state.desk?.reply.candidates[k];
    if (cand !== undefined) pick(cand);
    schedule();
  }

  function listen() {
    // The dispatch dialog's model list follows its harness at once.
    document.addEventListener('change', (e) => {
      if (!(e.target instanceof Element) || !['nw-harness', 'nw-model', 'nw-cwd'].includes(e.target.id)) return;
      // A new harness redraws its model list first, so the card reads the model the select really shows (as pick() does).
      // A new work dir redraws its note at once (what a session there may do).
      if (e.target.id === 'nw-harness' || e.target.id === 'nw-cwd') host.render();
      schedule();
    });
    // An edited sentence makes the card stale at once.
    document.addEventListener('input', (e) => { if (e.target instanceof Element && e.target.id === 'nw-text') schedule(); });
  }

  return { openNew, listen, acts: { new: openNew, dispatch, suggest, pick: pickAct } };
}
