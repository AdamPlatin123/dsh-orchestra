// @ts-check
// 回答: the dialog of a question card, one pick a question, sent under the checks of an allow (r4 §10.9).
import { errText, graphemes, join, originLine } from './owned.js';
import { t } from './view.js';

/** Options drawn side by side (a segmented row): two to four, short, none with a note. @param {readonly any[]} os */
const segmented = (os) => os.length >= 2 && os.length <= 4 && os.every((o) => o.description === '' && graphemes(o.label).length <= 10);

/**
 * 回答: the dialog of a question card (D8: only here, unlocked). Each question its head, the question, its options
 * as buttons (pressed: your pick; never one picked for you) and, where it takes one, a line of your own; 提交 is on
 * once every question has its pick. `a`: the approval, or null once it waits no more; `picks`: one a question, null
 * for none yet. The options and their notes are the agent's words, and the note says so.
 * @param {any} a @param {readonly ({ option: number } | { text: string } | null)[]} picks @param {boolean} busy
 */
export function describeAnswer(a, picks, busy) {
  const qs = a?.questions ?? [];
  const left = picks.filter((p) => p === null).length;
  return {
    qaFrom: { text: a === null ? '' : join([originLine(a), a.redactions > 0 && t('appr.redacted', { n: a.redactions })], 'sep.notes') },
    qaWhat: { text: a === null ? t('qa.gone') : a.title },
    qaList: {
      kids: qs.map((q, i) => {
        const p = picks[i] ?? null;
        const typed = q.options.length === 0 || q.other === true;
        return {
          key: `${a.approvalId}:${i}`, tpl: 'tpl-qa', data: { q: String(i) },
          slots: {
            h: { text: q.header }, q: { text: q.question },
            opts: {
              cls: segmented(q.options) ? 'qa-opts qa-seg' : 'qa-opts', attr: { 'aria-label': q.header || q.question },
              kids: q.options.map((o, j) => ({
                key: String(j), tpl: 'tpl-qopt', data: { q: String(i), o: String(j) }, attr: { 'aria-pressed': p !== null && 'option' in p && p.option === j ? 'true' : 'false' },
                slots: { l: { text: o.label }, d: { text: o.description } },
              })),
            },
            text: {
              data: { q: String(i), hide: typed ? '0' : '1' },
              attr: { placeholder: t(q.options.length === 0 ? 'qa.text' : 'qa.other'), 'aria-label': t('qa.otherLabel', { h: q.header || q.question }) },
            },
          },
        };
      }),
    },
    qaNote: { text: t('qa.note') },
    qaGo: { text: t(busy ? 'op.busy' : 'qa.go'), attr: { disabled: busy || a === null || left > 0 ? '' : null, title: a !== null && left > 0 ? t('qa.need', { n: left }) : null } },
  };
}

/** @param {any} c ui/drive.js's shared parts */
export function makeQa(c) {
  const { state, host, schedule, say, op } = c;
  const dlg = c.dialog('qa-dlg', 'qa-h', { on: 'qa', paint: () => describeAnswer(openQuestion(), state.qa.picks, state.busy), shut() { state.qaFrom = null; } });

  /** The question card whose dialog is open while it still waits for you, or null. */
  const openQuestion = () => (state.qa === null ? null : state.owned?.approvals.find((/** @type {any} */ x) => x.approvalId === state.qa?.id && x.canText === true) ?? null);

  /**
   * 回答: the dialog of a question card, nothing picked (D8: the person picks each answer; none is picked for them).
   * @param {HTMLElement} el
   */
  function answerOpen(el) {
    const a = state.owned?.approvals.find((/** @type {any} */ x) => x.approvalId === el.dataset.appr && x.canText === true);
    if (a === undefined) return;
    dlg.open({ qa: { id: a.approvalId, picks: a.questions.map(() => null) }, qaFrom: el }, () => host.render());
  }

  /** An option pressed: that question's pick, and a line typed for it before is cleared. @param {HTMLElement} el */
  function answerPick(el) {
    const i = Number(el.dataset.q);
    const j = Number(el.dataset.o);
    if (state.qa === null || !(i in state.qa.picks)) return;
    state.qa.picks[i] = { option: j };
    const typed = /** @type {any} */ (el.closest('.qa')?.querySelector('.qa-in'));
    if (typed) typed.value = '';
    schedule();
  }

  /** A line typed for a question is its pick; emptied, the question has none (an option pressed before stays unpressed). @param {any} el */
  function answerTyped(el) {
    const i = Number(el.dataset.q);
    if (state.qa === null || !(i in state.qa.picks)) return;
    const text = String(el.value ?? '');
    state.qa.picks[i] = text.trim() === '' ? null : { text };
    schedule();
  }

  /** 提交回答: one pick a question, under the shown digest and the list's revision (the checks of an allow). */
  async function answerGo() {
    const a = openQuestion();
    const list = state.owned;
    if (a === null || state.qa === null || !list) return dlg.say(t('qa.gone'));
    const left = state.qa.picks.filter((/** @type {any} */ p) => p === null).length;
    if (left > 0) return dlg.say(t('qa.need', { n: left }));
    if (c.settling()) return dlg.say(t('appr.settling'));
    const r = await op(`approvals/${a.approvalId}/answer`, { digest: a.digest, rev: list.rev, answers: state.qa.picks });
    // Closed while it was out: why it was refused goes to the page's note, not to a dialog nobody sees.
    const open = dlg.shown();
    if (r?.ok !== true) return r === null ? undefined : open ? dlg.say(errText(r.code)) : say(errText(r.code));
    if (state.qaFrom?.isConnected) c.answeredAt(state.qaFrom, a.approvalId);
    if (open) dlg.close();
    say(t('appr.answered'));
  }

  const listen = () => document.addEventListener('input', (e) => { if (e.target instanceof Element && e.target.classList.contains('qa-in')) answerTyped(e.target); });

  return { listen, acts: { qa: answerOpen, 'qa-pick': answerPick, 'qa-go': answerGo } };
}
