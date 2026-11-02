// @ts-check
// Orchestra's own sessions on the tower (orchestra app plan §2-§5, slice design §2.6-§2.8): pure
// descriptors of the chat, approvals, composer and dispatch dialog, and r4 §10.9's guards on an allow
// (D8: only a person, only on this page). app.js sends.
import { ERROR_TEXT, TOWER_TEXT } from '../shared/strings.js';
import { fmtLeft, t } from './view.js';

// Payloads: shared/owned-contract.js OwnedList, OwnedFeed. A guard g: { unlocked, settle ('' or a token
// restarting the countdown), hold (the approval held), busy, nowWall }.
/** @typedef {any} Approval @typedef {any} OwnedList @typedef {any} Feed @typedef {any} Guard @typedef {any} Desc @typedef {any} Paint */

/** src/owned/models.ts: magpie's codex/, zcode/, opencode-go/. */
export const MODELS = Object.freeze(['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'zcode/GLM-5.3', 'opencode-go/glm-5.3']);
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

export const ownedIdOf = (n) => (n?.ownership === 'owned' && /^n:[0-9a-f]{20}$/.test(n.id) ? n.id.slice(2) : null);
export const isOwnedList = (b) => b?.kind === 'owned-list' && Array.isArray(b.owned) && Array.isArray(b.approvals) && Number.isSafeInteger(b.rev);
export const isFeed = (b) => b?.kind === 'owned-feed' && Array.isArray(b.events) && Number.isSafeInteger(b.to);
/** No reply is an unknown outcome, never a failure (T1). */
export const errText = (code) => (Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : t(code === 'network' ? 'op.unknown' : 'op.err', { code }));

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

/** The chat, the last 200; a command folds under one line with its output. */
export function describeChat(feed) {
  if (feed === undefined) return { kids: [], note: t('detail.loading') };
  /** @type {Desc[]} */
  const kids = [];
  /** @type {Map<string, any>} */
  const tools = new Map();
  for (const e of feed.events) {
    const tx = e.text ?? '';
    const k = e.ref ?? `#${e.seq}`;
    /** @param {string} who @param {string} text @param {string} kind */
    const msg = (who, text, kind) => kids.push({ key: `e${e.seq}`, tpl: 'tpl-msg', data: { kind, live: e.live ? '1' : '0' }, slots: { who: { text: who }, tx: { text } } });
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
    } else if (e.kind === 'you') msg(t('chat.you'), tx, 'you');
    else if (e.kind === 'text' || e.kind === 'result') msg(t('chat.agent'), e.live ? tx + t('chat.live') : tx, 'agent');
    else if (e.kind === 'ask') msg(t('icon.approval'), t('chat.ask', { t: tx }), 'ask');
    else if (e.kind === 'answer') msg(t('chat.you'), tk('chat', e.state, 'chat.answered'), 'answer');
    else if (e.kind === 'auto-denied') msg('', tk('chat', e.state, 'chat.clock'), 'auto');
    else if (e.kind === 'lifecycle') msg('', join([tk('life', e.state, 'chat.life'), tx]), 'life');
    else if (e.kind === 'note' && e.state !== 'tokens') msg('', tk('fnote', e.state, 'fnote.other', { t: tx }), 'note');
  }
  const shown = kids.slice(-200);
  return { kids: shown, note: join([shown.length === 0 ? t('chat.none') : kids.length > 200 && t('chat.cut', { n: 200 }), feed.clipped && t('chat.clipped')], 'sep.notes') };
}

/** The waiting bar shows this request whole. */
export const pinWhole = (a) => !a.tooLong && a.preview.length <= 280 && a.preview.split('\n').length <= 4;

/**
 * Deny first; allow only where the whole request shows and may be allowed (held if high risk, void and
 * counting down within SETTLE_MS of a change); where it cannot show whole, the bar offers 去看 instead.
 * @param {Approval} a @param {Guard} g @param {'card' | 'pin'} where @returns {Desc[]}
 */
export function apprActs(a, g, where) {
  if (!g.unlocked) return [lockBtn()];
  const appr = a.approvalId;
  const out = [btn('deny', t('appr.deny'), { act: 'deny', appr }, { disabled: g.busy ? '' : null })];
  if (a.canAccept && !a.tooLong && (where === 'card' || pinWhole(a))) {
    out.push(btn('allow', t(a.high ? 'appr.hold' : 'appr.allow'), { act: 'allow', appr, high: a.high ? '1' : '0', settle: g.settle, hold: g.hold === appr ? '1' : '0' }, {
      'aria-disabled': g.settle !== '' || g.busy ? 'true' : null, title: a.high ? t('appr.holdHint') : null,
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
    ownSt: { text: join([t('own.st', { model: o.model, state: tk('state', o.state, 'state.unknown') }), o.queued > 0 && t('own.queued', { n: o.queued }), o.tokens !== null && t('own.tokens', { n: o.tokens.total })]) },
    cardsH: { data: { hide: mine.length > 0 ? '0' : '1' }, text: t('own.cards', { n: mine.length }) },
    cards: { kids: mine.map((a) => describeCard(a, g)) },
  };
}

/**
 * The composer: a message steers a running turn; two stops (no brake route yet, the note says so).
 * @param {{ id: string } | null} to @param {OwnedList | null} list @param {Guard} g @param {boolean} held @param {boolean} armed @returns {Record<string, Paint>}
 */
export function describeOwnedDock(to, list, g, held, armed) {
  const o = entry(list, to?.id);
  const note = to === null ? 'dock.readonly' : !g.unlocked ? 'dock.locked' : o === undefined ? 'own.missing' : o.state === 'ended' || o.state === 'failed' ? 'dock.ended' : '';
  if (note !== '' || o === undefined) return { st: { text: '' }, in: off, btns: { kids: g.unlocked || to === null ? [] : [lockBtn()] }, note: { text: t(note) } };
  const run = o.state === 'running';
  const busy = g.busy ? '' : null;
  return {
    st: { text: join([t(run ? 'dock.steer' : 'dock.idle'), o.queued > 0 && t('own.queued', { n: o.queued })]) },
    in: on,
    btns: {
      kids: [
        btn('send', t(run ? 'dock.sendSteer' : 'dock.send'), { act: 'send' }, { disabled: busy }),
        btn('int', t('dock.interrupt'), { act: 'interrupt' }, { disabled: run || o.queued > 0 ? busy : '' }),
        btn('end', t(armed ? 'dock.endSure' : 'dock.end'), { act: 'end', armed: armed ? '1' : '0' }, { disabled: busy }),
      ],
    },
    note: { text: join([held && t('dock.lockedTo'), t('dock.noBrake')], 'sep.notes') },
  };
}

/** The dispatch dialog: a harness that cannot start is greyed, with why. */
export function describeNew(list, harness, busy) {
  const h = list?.harnesses ?? {};
  return {
    hCodex: { attr: { disabled: h.codex ? null : '' } }, hClaude: { attr: { disabled: h.claude ? null : '' } },
    why: { text: join([list === null ? t('new.noList') : !list.enabled && t('new.off', { why: list.disabledWhy ?? '' }), !h.claude && t('new.claudeOff')], 'sep.notes') },
    model: { kids: MODELS.map((m) => ({ key: m, tpl: 'tpl-opt', text: m, attr: { value: m } })) },
    go: { text: t(busy ? 'op.busy' : 'new.go'), attr: { disabled: busy || !list?.enabled || !h[harness] ? '' : null } },
  };
}
