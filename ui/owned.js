// @ts-check
// Owned sessions on the tower (orchestra app plan §2-§5, slice design §2.6-§2.8): pure descriptors of the
// chat, approvals, composer, dispatch, and r4 §10.9's allow guards (D8: a person, this page). app.js sends.
import { ERROR_TEXT, TOWER_TEXT } from '../shared/strings.js';
import { fmtLeft, t } from './view.js';

// Payloads: shared/owned-contract.js. A guard g: { unlocked, settle ('' or a countdown token), hold, busy
// (aria-disabled: the focus stays), nowWall }.

/** src/owned/models.ts per harness, the default first: Codex takes magpie's codex/, zcode/ and opencode-go/; Claude (Anthropic's API) only zcode/ and opencode-go/. */
export const MODELS = Object.freeze({
  codex: Object.freeze(['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'codex/gpt-6.1-terra', 'zcode/GLM-5.3', 'opencode-go/glm-5.3']),
  claude: Object.freeze(['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash', 'zcode/GLM-5.2', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3', 'opencode-go/claude-haiku-5-5']),
});
/** The models of a harness (an unknown one reads as codex). */
export const modelsOf = (harness) => (harness === 'claude' ? MODELS.claude : MODELS.codex);
/** r4 §10.9: an allow is void this long after the list moved; a high-risk one is held this long. */
export const SETTLE_MS = 750;
export const HOLD_MS = 1000;

/** A code's text; an unknown code takes the fallback (T1). */
const tk = (p, v, fb, a = {}) => t(Object.hasOwn(TOWER_TEXT, `${p}.${v}`) ? `${p}.${v}` : fb, { s: v ?? '', ...a });
const btn = (key, text, data, attr = {}) => ({ key, tpl: 'tpl-btn', text, data, attr });
const lockBtn = () => btn('lock', t('op.lock'), { act: 'unlock' });
const join = (parts, sep = 'sep.parts') => parts.filter(Boolean).join(t(sep));
const off = { data: { hide: '1' } };
const on = { data: { hide: '0' } };
const entry = (list, id) => list?.owned.find((x) => x.ownedId === id);
const busy = (g) => (g.busy ? 'true' : null);

export const ownedIdOf = (n) => (n?.ownership === 'owned' && /^n:[0-9a-f]{20}$/.test(n.id) ? n.id.slice(2) : null);
export const isOwnedList = (b) => b?.kind === 'owned-list' && Array.isArray(b.owned) && Array.isArray(b.approvals) && Number.isSafeInteger(b.rev);
export const isFeed = (b) => b?.kind === 'owned-feed' && Array.isArray(b.events) && Number.isSafeInteger(b.to);
/** No reply or a 5xx (maybe after the effect) is unknown, not a failure (T1). */
export const errText = (code) => (Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : t(code === 'network' || /^http-5(?!01)\d\d$/.test(code) ? 'op.unknown' : 'op.err', { code }));

/** working.ts OwnedCodexStatus.why in words. */
export const whyText = (why) => tk('why', why, 'why.other');
/** Why a session has no brake: the list's brakeWhy (procguard's state), else no Job of its own. */
const brakeWhyText = (why) => tk('bwhy', why ?? 'no-job', 'bwhy.other');

/** The server's 422s, said first (routes.ts OWNED_TEXT_MAX_BYTES). */
export function msgError(text) {
  const n = new TextEncoder().encode(text).length;
  return text.trim() === '' ? t('msg.empty') : text.trimStart().startsWith('/') ? t('msg.slash') : n > 2048 ? t('msg.long', { n }) : null;
}

/** A live event goes when the next of its kind and ref comes (src/owned/feed.ts upsert). */
export function mergeFeed(had, page) {
  let events = had?.events ?? [];
  const seen = new Set(events.map((e) => e.seq));
  for (const e of page.events) {
    if (seen.has(e.seq)) continue;
    events = events.filter((x) => !(x.live && x.kind === e.kind && x.ref === e.ref && (x.ref !== null || x.state === e.state)));
    events.push(e);
  }
  return { to: Math.max(had?.to ?? 0, page.to), clipped: had?.clipped === true || page.clipped, events: events.slice(-500) };
}

const MSG = /^msg-/;

/** The chat, the last 200: a command folds with its output; your messages say their fate (msg-*). */
export function describeChat(feed) {
  if (feed === undefined) return { kids: [], note: t('detail.loading') };
  /** @type {Desc[]} */
  const kids = [];
  /** @type {Map<string, any>} */
  const tools = new Map();
  const fates = new Map(feed.events.filter((e) => e.kind === 'note' && MSG.test(e.state ?? '')).map((e) => [e.ref, e]));
  /** @type {Map<string, number>} */
  const parts = new Map();
  // A long reply comes in chunks of one ref (2 KB each, src/owned/text.ts): adjacent final chunks are one
  // message, under the first chunk's key, so it reads (and is heard) as one.
  /** @type {{ ref: string, node: any } | null} */
  let lastText = null;
  for (const e of feed.events) {
    if (e.kind === 'note' && MSG.test(e.state ?? '')) continue;
    const tx = e.text ?? '';
    const k = e.ref ?? `#${e.seq}`;
    // A message keeps one node from its first delta to its final words (the reader hears it once).
    const n = parts.get(k) ?? 0;
    if (e.kind === 'text' && e.ref !== null) parts.set(k, n + 1);
    const key = e.kind === 'text' && e.ref !== null ? `m${k}:${n}` : `e${e.seq}`;
    if (e.kind === 'text' && e.ref !== null && !e.live && lastText !== null && lastText.ref === e.ref && kids[kids.length - 1] === lastText.node) {
      lastText.node.slots.tx.text += tx;
      continue;
    }
    const msg = (who, text, kind) => kids.push({ key, tpl: 'tpl-msg', data: { kind, live: e.live ? '1' : '0' }, slots: { who: { text: who }, tx: { text } } });
    // A command told again moves below the approval that decided it (src/owned/codex-session.ts).
    if (e.kind === 'tool' && tools.has(k)) kids.splice(kids.indexOf(tools.get(k)), 1);
    if (e.kind === 'tool' || (e.kind === 'tool-result' && !tools.has(k))) {
      const sum = e.kind === 'tool' ? `${tk('tool', e.state, 'tool.tool')} · ${tx.replace(/^command: /, '').split('\n', 1)[0]}` : t('chat.out');
      tools.set(k, { key: `t${k}`, tpl: 'tpl-tool', data: { kind: 'tool', live: '0' }, slots: { sum: { text: sum }, body: { text: e.kind === 'tool' ? tx : '' } } });
      kids.push(tools.get(k));
    }
    if (e.kind === 'tool-result') {
      const d = tools.get(k);
      d.slots.sum.text += ` · ${join([tk('res', e.state, 'res.unknown'), e.exitCode !== null && t('chat.exit', { n: e.exitCode })])}`;
      if (tx !== '') d.slots.body.text = d.slots.body.text === '' ? tx : `${d.slots.body.text}\n\n${t('chat.out')}\n${tx}`;
      d.data.live = e.live ? '1' : '0';
    } else if (e.kind === 'you') {
      const f = fates.get(e.uuid);
      msg(join([t('chat.you'), f && tk('msgst', f.state, 'msgst.other', { t: f.text ?? '' })]), tx, 'you');
    } else if (e.kind === 'text' || e.kind === 'result') {
      msg(t('chat.agent'), e.live ? tx + t('chat.live') : tx, 'agent');
      if (e.kind === 'text' && e.ref !== null && !e.live) lastText = { ref: e.ref, node: kids[kids.length - 1] };
    } else if (e.kind === 'ask') msg(t('icon.approval'), t('chat.ask', { t: tx }), 'ask');
    else if (e.kind === 'answer') msg(t('chat.you'), tk('chat', e.state, 'chat.answered'), 'answer');
    // An automatic refusal says its reason; one this page has no words for says its code, never "timed out" (T1).
    else if (e.kind === 'auto-denied') msg('', tk('chat', e.state, 'chat.autoOther', { t: tx }), 'auto');
    else if (e.kind === 'lifecycle') msg('', join([tk('life', e.state, 'chat.life'), tx]), 'life');
    else if (e.kind === 'note' && e.state !== 'tokens') msg('', tk('fnote', e.state, 'fnote.other', { t: tx }), 'note');
  }
  const shown = kids.slice(-200);
  return { kids: shown, note: join([shown.length === 0 ? t('chat.none') : kids.length > 200 && t('chat.cut', { n: 200 }), feed.clipped && t('chat.clipped')], 'sep.notes') };
}

/** What a screen reader hears of the events after `after`: not your own words, not a live one, at most the last three. */
export function chatNews(feed, after) {
  const fresh = feed.events.filter((e) => e.seq > after && !e.live && e.kind !== 'you' && e.kind !== 'answer' && !(e.kind === 'note' && (MSG.test(e.state ?? '') || e.state === 'tokens')));
  const lines = describeChat({ clipped: false, events: fresh }).kids.map((d) => (d.tpl === 'tpl-tool' ? d.slots.sum.text : join([d.slots.who.text, d.slots.tx.text])));
  return lines.slice(-3).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join(t('sep.notes'));
}

/** The chat follows new messages only while the reader is at its bottom (scrolled up, it stays put). */
export const atBottom = (el) => !((el.scrollHeight ?? 0) - (el.scrollTop ?? 0) - (el.clientHeight ?? 0) > 24);

/** The waiting bar shows this request whole. */
export const pinWhole = (a) => !a.tooLong && a.preview.length <= 280 && a.preview.split('\n').length <= 4;

/** Deny first; allow only where the request shows whole (high risk: held or typed; void within SETTLE_MS of a change), else 去看. */
export function apprActs(a, g, where) {
  if (!g.unlocked) return [lockBtn()];
  const appr = a.approvalId;
  const what = { t: a.title || tk('kind', a.kind, 'kind.command') };
  const out = [btn('deny', t('appr.deny'), { act: 'deny', appr }, { 'aria-disabled': busy(g), 'aria-label': t('appr.denyLabel', what) })];
  if (a.canAccept && !a.tooLong && (where === 'card' || pinWhole(a))) {
    out.push(btn('allow', t(a.high ? 'appr.hold' : 'appr.allow'), { act: 'allow', appr, high: a.high ? '1' : '0', settle: g.settle, hold: g.hold === appr ? '1' : '0' }, {
      'aria-disabled': g.settle !== '' ? 'true' : busy(g), title: a.high ? t('appr.holdHint') : null, 'aria-label': t(a.high ? 'appr.holdLabel' : 'appr.allowLabel', what),
    }));
  } else if (where === 'pin') out.push(btn('see', t('appr.see'), { act: 'see', appr }));
  return out;
}

/** An approval in full. */
export function describeCard(a, g) {
  const left = a.deadline - g.nowWall;
  return {
    key: a.approvalId, tpl: 'tpl-card', data: { high: a.high ? '1' : '0' },
    slots: {
      kind: { text: join([tk('kind', a.kind, 'kind.command'), tk('risk', a.risk, 'risk.other'), a.high && t('appr.high')]) },
      left: { text: left > 0 ? t('wait.left', { t: fmtLeft(left) }) : t('wait.overdue') },
      title: { text: a.title },
      pv: { text: a.preview },
      note: { text: join([a.tooLong ? t('appr.cut') : !a.canAccept && t('appr.noAccept'), a.redactions > 0 && t('appr.redacted', { n: a.redactions })], 'sep.notes') },
      acts: { kids: apprActs(a, g, 'card') },
    },
  };
}

/** A waiting-bar entry of Orchestra's queue: its first request, whole, and its buttons; others stay read only. */
export function pinExtra(e, list, g) {
  const a = list?.approvals.find((x) => x.approvalId === entry(list, e.node.slice(2))?.waiting);
  const mine = e.source === 'orchestra';
  return { acts: { kids: !mine ? [] : !g.unlocked ? [lockBtn()] : a === undefined ? [] : apprActs(a, g, 'pin') }, pv: { text: mine && g.unlocked && a !== undefined && pinWhole(a) ? a.preview : '' } };
}

/** Never an allow in a notification (r4 §10.9). */
export const notifyText = (a, who) => t('notify.body', { who, what: tk('kind', a.kind, 'kind.command') });

/** An owned session's page: standing, approvals, chat. */
export function describeOwned(id, list, feed, g) {
  const o = entry(list, id);
  if (!g.unlocked || list === null || o === undefined) {
    return { ownBox: on, evBox: off, ownSt: { text: t(!g.unlocked ? 'own.locked' : list === null ? 'detail.loading' : 'own.missing') }, ownActs: { kids: g.unlocked ? [] : [lockBtn()] }, cardsH: off, cards: { kids: [] }, chatBox: off };
  }
  const mine = list.approvals.filter((a) => a.ownedId === id);
  const chat = describeChat(feed);
  return {
    ownBox: on, evBox: off, ownActs: { kids: [] }, chatBox: on, chatNote: { text: chat.note }, chat: { kids: chat.kids },
    ownSt: {
      text: join([
        t('own.st', { model: o.model, state: tk('state', o.state, 'state.unknown') }), o.endReason === 'daemon-restart' && t('life.daemon-restart'),
        o.queued > 0 && t('own.queued', { n: o.queued }), o.tokens !== null && t('own.tokens', { n: o.tokens.total }),
      ]),
    },
    cardsH: { data: { hide: mine.length > 0 ? '0' : '1' }, text: t('own.cards', { n: mine.length }) },
    cards: { kids: mine.map((a) => describeCard(a, g)) },
  };
}

/**
 * The composer: a message steers a running turn; three stops: interrupt, end (two clicks), and for a
 * session in a Job of its own the brake (two clicks), its whole tree; without one the note says why not.
 */
export function describeOwnedDock(to, list, g, held, armed, brakeArmed = false) {
  const o = entry(list, to?.id);
  const note = to === null ? 'dock.readonly' : !g.unlocked ? 'dock.locked' : o === undefined ? 'own.missing'
    : o.state === 'unknown' ? 'dock.unknown' : o.state === 'ended' || o.state === 'failed' ? 'dock.ended' : '';
  if (note !== '' || o === undefined) return { st: { text: '' }, in: off, btns: { kids: g.unlocked || to === null ? [] : [lockBtn()] }, note: { text: t(note) } };
  const run = o.state === 'running';
  const b = busy(g);
  const lead = o.queued > 0 ? 'dock.afterQueue' : run ? 'dock.steer' : 'dock.idle';
  return {
    st: { text: join([t(lead), o.queued > 0 && t('own.queued', { n: o.queued })]) },
    in: on,
    btns: {
      kids: [
        btn('send', t(run && o.queued === 0 ? 'dock.sendSteer' : 'dock.send'), { act: 'send' }, { 'aria-disabled': b }),
        btn('int', t('dock.interrupt'), { act: 'interrupt' }, { 'aria-disabled': run || o.queued > 0 ? b : 'true' }),
        btn('end', t(armed ? 'dock.endSure' : 'dock.end'), { act: 'end', armed: armed ? '1' : '0' }, { 'aria-disabled': b }),
        ...(o.brake ? [btn('brake', t(brakeArmed ? 'dock.brakeSure' : 'dock.brake'), { act: 'brake', armed: brakeArmed ? '1' : '0' }, { 'aria-disabled': b })] : []),
      ],
    },
    note: { text: join([held && t('dock.lockedTo'), !o.brake && t('dock.noBrake', { why: brakeWhyText(list?.brakeWhy) })], 'sep.notes') },
  };
}

/** The dispatch dialog: a harness that cannot start is greyed, with why. */
export function describeNew(list, harness, busy) {
  const h = list?.harnesses ?? {};
  return {
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
