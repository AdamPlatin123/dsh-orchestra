// @ts-check
// The front desk's talk (src/route/front-desk.ts; 第二轮简报 F1, F2), on the home page alone: the old page has no way to it. Pure
// descriptors, as ui/owned.js, whose guards and buttons they share: a click on an order is the click on its card in 「等你」.
import { MSG, btn, busy, describeOwned, entry, join, off, on, reqActs, reqWhat, reqWhere, reqWhy, requestModel, tk, workerName } from './owned.js';
import { fmtLeft, t } from './view.js';

/** What an order's 现在怎样 says, from the request (null: orchestrad no longer holds it) and what the feed said of a call that made none, or of one that came to nothing. */
function orderNow(r, refused, g) {
  if (r === null) return refused === null || refused === 'gone' ? t('front.now.unknown') : t('front.now.refused', { t: tk('dispwhy', refused, 'dispwhy.other') });
  if (r.state === 'pending') return join([t('front.now.pending', { t: fmtLeft(Math.max(0, r.expiresAt - g.nowWall)) }), r.askWhy != null && tk('askwhy', r.askWhy, 'askwhy.other')], 'sep.notes');
  if (r.state === 'done') return r.report === null ? t('front.now.noReport') : t('front.now.report', { t: r.report });
  if (r.state === 'failed') return t('front.now.failed', { t: reqWhy(r.why) });
  return t(`front.now.${r.state}`);
}

/**
 * An order (F2): its six things, each 未知 when nothing says it (T1), how it went out, and what it can do now. The same
 * buttons as its card in 「等你」, so a click here is that click.
 */
function orderRow(key, r, refused, list, g) {
  const o = r === null || r.ownedId === null ? undefined : entry(list, r.ownedId);
  const live = o !== undefined && (o.state === 'running' || o.state === 'starting' || o.stoppable === true || o.waiting !== null);
  const none = t('front.unknown');
  const acts = r === null ? [] : r.state === 'pending' ? reqActs(r, requestModel(r), reqWhat(r), g) : o === undefined ? [] : [
    btn('open', t('front.goWorker'), { act: 'worker', node: `n:${o.ownedId}` }),
    ...(live ? [btn('stop', t('home.stopWorker'), { act: 'stop-worker', owned: o.ownedId }, { 'aria-label': t('home.stopWorkerLabel', { t: o.title }), 'aria-disabled': busy(g) })] : []),
  ];
  return {
    key, tpl: 'tpl-order', data: { kind: 'order', state: r?.state ?? 'unknown' },
    slots: {
      who: { text: r === null ? none : join([t(`harness.${r.harness}`), o?.model ?? requestModel(r).model]) },
      where: { text: r === null ? none : reqWhere(r) },
      what: { text: r?.text ?? none }, why: { text: r?.reason ?? none }, back: { text: r?.returns ?? none },
      now: { text: orderNow(r, refused, g) },
      how: { text: r === null || r.state === 'pending' || r.ownedId === null ? '' : t(r.auto ? 'front.via.grant' : 'front.via.person') },
      acts: { kids: acts },
    },
  };
}

/** Where an answer came from, as orchestrad saw the reads of its turn: never the model's own word. */
function sourcesOf(reads, list, fmt) {
  if (reads.length === 0) return t('front.srcNone');
  const seen = new Set();
  const says = reads.filter((e) => !seen.has(`${e.text}|${e.ref}`) && seen.add(`${e.text}|${e.ref}`)).map((e) => {
    const at = fmt(e.at);
    return e.text === 'session' ? t('front.src.session', { t: workerName(list, String(e.ref).slice(2)), at }) : tk('front.src', e.text, 'front.src.refused', { at });
  });
  return t('front.src', { t: says.join(t('sep.parts')) });
}

/**
 * The desk's talk (F1): your words, its answers each with where it came from, the orders. Nothing else of the feed: a read is
 * no row (it comes back as the answer's source), and no tool, no note, no lifecycle line shows. A report is on its order, so
 * no model call stands behind it. What went wrong with a turn goes to the note over the talk, never left out (T1).
 *
 * A turn's reads end with the turn, not with your next words: what you say while it runs queues behind it, and its answer
 * still comes from what it read. The sentence the page sent for the click on 开启 is no word of yours, so it is said as what happened:
 * the model ran only once it was handed over; until then, or when it never was, the line says what became of it (T1).
 */
export function describeFrontChat(feed, list, g, fmt) {
  if (feed === undefined) return { kids: [], note: t('detail.loading') };
  /** @type {Desc[]} */
  const kids = [];
  const orders = new Set();
  let reads = [];
  let lastAnswer = null;
  let failed = null;
  const fates = new Map(feed.events.filter((e) => e.kind === 'note' && MSG.test(e.state ?? '')).map((e) => [e.ref, e]));
  const opening = feed.events.find((e) => e.kind === 'you' && e.text === t('front.opening'));
  /** What the feed says became of an order that was refused: the request may be gone by now. */
  const ends = new Map(feed.events.filter((e) => e.kind === 'note' && e.state === 'worker-refused' && e.ref !== null).map((e) => [e.ref, e.text ?? '']));
  /** Orders orchestrad forgot and nothing yet ended: a person's 派出 of one of them says only its session, and it is one of these rows, all alike. */
  let forgotten = 0;
  const order = (key, r, refused = null) => {
    if (orders.has(key)) return;
    orders.add(key);
    kids.push(orderRow(key, r, refused, list, g));
  };
  const byId = (id) => list?.requests?.find((r) => r.requestId === id) ?? null;
  const bySent = (ref) => list?.requests?.find((r) => `n:${r.ownedId}` === ref) ?? null;
  for (const e of feed.events) {
    if (e.kind === 'you') {
      const f = fates.get(e.uuid);
      lastAnswer = null;
      failed = null;
      if (e === opening) kids.push({ key: `y${e.seq}`, tpl: 'tpl-msg', data: { kind: 'life', live: '0' }, slots: { who: { text: '' }, tx: { text: f?.state === 'msg-sent' ? t('front.openedNote') : t('front.openedNoteNot', { t: tk('msgst', f?.state, 'msgst.other', { t: f?.text ?? '' }) }) } } });
      else kids.push({ key: `y${e.seq}`, tpl: 'tpl-msg', data: { kind: 'you', live: '0' }, slots: { who: { text: join([t('chat.you'), f && tk('msgst', f.state, 'msgst.other', { t: f.text ?? '' })]) }, tx: { text: e.text ?? '' } } });
    } else if (e.kind === 'text') {
      const src = sourcesOf(reads, list, fmt);
      if (lastAnswer !== null && lastAnswer.ref === e.ref && kids[kids.length - 1] === lastAnswer.node) {
        lastAnswer.node.slots.tx.text += e.text ?? '';
        lastAnswer.node.slots.src.text = src;
        continue;
      }
      const node = { key: `a${e.seq}`, tpl: 'tpl-fa', data: { kind: 'agent', live: e.live ? '1' : '0' }, slots: { who: { text: t('front.name') }, tx: { text: e.text ?? '' }, src: { text: src } } };
      kids.push(node);
      lastAnswer = { ref: e.ref, node };
    } else if (e.kind === 'note' && e.state === 'desk-read') reads.push(e);
    else if (e.kind === 'note' && e.state === 'worker-asked') {
      const r = byId(e.ref);
      if (r === null && !ends.has(e.ref)) forgotten += 1;
      order(`o${e.ref}`, r, ends.get(e.ref) ?? null);
    } else if (e.kind === 'note' && (e.state === 'worker-sent' || e.state === 'worker-sent-grant')) {
      const r = bySent(e.ref);
      if (r === null && e.state === 'worker-sent' && forgotten > 0) forgotten -= 1;
      else order(r === null ? `o${e.ref}` : `o${r.requestId}`, r);
    } else if (e.kind === 'note' && e.state === 'worker-refused') order(e.ref === null ? `x${e.seq}` : `o${e.ref}`, byId(e.ref), e.text ?? '');
    else if (e.kind === 'lifecycle' && /^turn-/.test(e.state ?? '')) {
      reads = [];
      if (!/^turn-(?:ended|started)$/.test(e.state ?? '')) failed = e.state;
    }
  }
  const shown = kids.slice(-200);
  const note = join([shown.length === 0 && t('chat.none'), failed !== null && tk('life', failed, 'chat.life'), feed.clipped && t('chat.clipped')], 'sep.notes');
  return { kids: shown, note };
}

/** The desk's page, as describeOwned is a session's: its standing and its talk, no approval (it has no tool that asks one). */
export function describeFront(id, list, feed, g, fmt) {
  const o = entry(list, id);
  if (!g.unlocked || list === null || o === undefined) return describeOwned(id, list, feed, g);
  const chat = describeFrontChat(feed, list, g, fmt);
  return {
    ownBox: on, evBox: off, ownActs: { kids: [] }, chatBox: on, chatNote: { text: chat.note }, chat: { kids: chat.kids },
    ownSt: { text: join([t('own.st', { model: o.model, state: tk('state', o.state, 'state.unknown') }), o.endReason !== null && o.endReason !== 'you-ended' && tk('life', o.endReason, 'chat.life'), o.queued > 0 && t('own.queued', { n: o.queued })]) },
    cardsH: off, cards: { kids: [] },
  };
}
