// @ts-check
// 改派 (seat): the dialog that dispatches a waiting agent request on a harness and model of your pick.
import { errText, join, modelsOf, reqWhere, requestModel, workerOf } from './owned.js';
import { t } from './view.js';

/**
 * 改派: the dialog that dispatches a waiting request on a harness and model of your pick (D8: only here, unlocked). The
 * text, where it runs and its taint are the request's (r4 §8.5), so the where-line is the card's for the harness picked.
 * `r`: the pending request, or null once it waits no more (派出 is off and says so); `harness`: the select's value.
 */
export function describeReassign(list, r, harness, busy) {
  const h = list?.harnesses ?? {};
  const asked = r === null ? '' : typeof r.model === 'string' ? t('re.askedModel', { h: t(`harness.${r.harness}`), m: r.model }) : t('re.asked', { h: t(`harness.${r.harness}`) });
  return {
    reWhat: { text: r === null ? '' : r.text },
    reAsked: { text: asked },
    reCodex: { attr: { disabled: h.codex ? null : '' } }, reClaude: { attr: { disabled: h.claude ? null : '' } },
    reWhy: { text: join([list !== null && !h.claude && t('new.claudeOff'), list !== null && !h.codex && list.enabled && t('new.codexOff')], 'sep.notes') },
    reModel: { kids: modelsOf(harness).map((m) => ({ key: `${harness}:${m}`, tpl: 'tpl-opt', text: m, attr: { value: m } })) },
    reWhere: { text: r === null ? t('re.gone') : reqWhere({ ...r, harness }) },
    reNote: { text: join([t('re.note'), r !== null && workerOf(r) !== null && t('re.worker')], 'sep.notes') },
    reGo: { text: t(busy ? 'op.busy' : 're.go'), attr: { disabled: busy || r === null || !list?.enabled || !h[harness] ? '' : null } },
  };
}

/** @param {any} c ui/drive.js's shared parts */
export function makeRe(c) {
  const { state, host, schedule, val, setVal, say, op } = c;
  const dlg = c.dialog('re-dlg', 're-harness', { on: 're', paint: () => describeReassign(state.owned, pendingReq(state.re), val('re-harness') || 'codex', state.busy) });

  /** The agent request `id` while it still waits for you, or null. @param {string} id */
  const pendingReq = (id) => state.owned?.requests?.find((/** @type {any} */ x) => x.requestId === id && x.state === 'pending') ?? null;

  /**
   * 改派: the dialog for a waiting request, its harness and the model 派出 would take picked to begin with (the card's).
   * @param {HTMLElement} el
   */
  function reassignOpen(el) {
    const r = pendingReq(el.dataset.req ?? '');
    if (r === null) return;
    dlg.open({ re: r.requestId }, () => {
      setVal('re-harness', r.harness);
      host.render();
      setVal('re-model', requestModel(r).model);
    });
  }

  /** 改派's 派出: owned-new with the requestId and the card's text, on the harness and model picked; the server checks them as any dispatch. */
  async function reassignGo() {
    const r = state.re === null ? null : pendingReq(state.re);
    if (r === null) return dlg.say(t('re.gone'));
    if (c.settling()) return dlg.say(t('appr.settling'));
    const harness = val('re-harness') === 'claude' ? 'claude' : 'codex';
    const model = val('re-model') || modelsOf(harness)[0];
    const routeId = r.suggestion?.routeId ?? null;
    const a = await op('owned/new', { text: r.text, harness, model, requestId: r.requestId, ...(routeId === null ? {} : { routeId }) });
    // Closed while it was out: why it was refused goes to the page's note, not to a dialog nobody sees.
    const open = dlg.shown();
    if (a?.ok !== true) return a === null ? undefined : open ? dlg.say(errText(a.code)) : say(errText(a.code));
    if (open) dlg.close();
    say(t('re.sent'));
    void host.poll();
    const id = a.body?.ownedId;
    if (/^[0-9a-f]{20}$/.test(id)) host.openNode(`n:${id}`);
  }

  const listen = () => document.addEventListener('change', (e) => {
    if (!(e.target instanceof Element) || !['re-harness', 're-model'].includes(e.target.id)) return;
    // 改派's where-line follows its harness.
    if (e.target.id === 're-harness') host.render();
    // 改派 back on the card's harness: its model again, not the list's first.
    const back = e.target.id === 're-harness' && state.re !== null ? pendingReq(state.re) : null;
    if (back !== null && back.harness === val('re-harness')) setVal('re-model', requestModel(back).model);
    schedule();
  });

  return { listen, acts: { 'req-re': reassignOpen, 're-go': reassignGo } };
}
