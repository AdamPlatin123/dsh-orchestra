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
export const tk = (p, v, fb, a = {}) => t(Object.hasOwn(TOWER_TEXT, `${p}.${v}`) ? `${p}.${v}` : fb, { s: v ?? '', ...a });
export const btn = (key, text, data, attr = {}) => ({ key, tpl: 'tpl-btn', text, data, attr });
const lockBtn = () => btn('lock', t('op.lock'), { act: 'unlock' });
export const join = (parts, sep = 'sep.parts') => parts.filter(Boolean).join(t(sep));
export const off = { data: { hide: '1' } };
export const on = { data: { hide: '0' } };
export const entry = (list, id) => list?.owned.find((x) => x.ownedId === id);
export const busy = (g) => (g.busy ? 'true' : null);

/** The list says this session takes no more messages: gone from it, ended, or unknown since a restart. Locked, nothing says so. */
/** The front desk the list holds: the one that runs, else the last one; null with none. */
export const deskOf = (list) => {
  const all = list?.owned?.filter((o) => o.frontDesk === true) ?? [];
  return all.find((o) => o.ownedId === list.frontDesk?.ownedId) ?? all.at(-1) ?? null;
};

export const closedTo = (list, id) => {
  const o = entry(list, id);
  return list != null && (o === undefined || o.state === 'unknown' || o.state === 'ended' || o.state === 'failed');
};

/** The owned session a node is; a sub-agent under one is none (its id is a hash, and it takes no message). */
export const ownedIdOf = (n) => (n?.ownership === 'owned' && n.layer !== 'subagent' && /^n:[0-9a-f]{20}$/.test(n.id) ? n.id.slice(2) : null);
export const isOwnedList = (b) => b?.kind === 'owned-list' && Array.isArray(b.owned) && Array.isArray(b.approvals) && Number.isSafeInteger(b.rev);
export const isFeed = (b) => b?.kind === 'owned-feed' && Array.isArray(b.events) && Number.isSafeInteger(b.to);
/** No reply or a 5xx (maybe after the effect) is unknown, not a failure (T1). */
export const errText = (code) => (Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : t(code === 'network' || code === 'timeout' || /^http-5(?!01)\d\d$/.test(code) ? 'op.unknown' : 'op.err', { code }));

/** working.ts OwnedCodexStatus.why in words. */
export const whyText = (why) => tk('why', why, 'why.other');
/** Why a session has no brake (or a blind one): the list's brakeWhy (procguard's state), else no Job of its own. */
export const brakeWhyText = (why) => tk('bwhy', why ?? 'no-job', 'bwhy.other');

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

export const MSG = /^msg-/;

/** A dispatch in words: its one name, or the first and how many. @param {readonly string[]} names */
export function sentText(names) {
  const who = names[0] || t('chat.unnamed');
  return t('fnote.dispatch', { t: names.length === 1 ? who : t('fold.group', { who, n: names.length }) });
}

/**
 * The chat, the last 200: a command folds with its output; your messages say their fate (msg-*); a dispatch is one
 * row, however many it sent. `over`: the list knows the session ended, so the line a restart leaves does not say its
 * state is not known (T1 both ways).
 */
export function describeChat(feed, over = false, handed = false) {
  if (feed === undefined) return { kids: [], note: t('detail.loading') };
  /** Someone else sent this session out: its first message is the order they wrote, no word of yours. Past a clip, which one came first is not known. */
  let order = handed && !feed.clipped;
  /** @type {Desc[]} */
  const kids = [];
  /** @type {Map<string, any>} */
  const tools = new Map();
  const fates = new Map(feed.events.filter((e) => e.kind === 'note' && MSG.test(e.state ?? '')).map((e) => [e.ref, e]));
  /** @type {Map<string, number>} */
  const parts = new Map();
  /** Each batch's row, and its sub-agents' names by ref. @type {Map<number, { node: any, names: Map<string, string> }>} */
  const sent = new Map();
  // A long reply comes in chunks of one ref (2 KB each, src/owned/text.ts): adjacent final chunks are one
  // message, under the first chunk's key, so it reads (and is heard) as one.
  /** @type {{ ref: string, node: any } | null} */
  let lastText = null;
  for (const e of feed.events) {
    if (e.kind === 'note' && MSG.test(e.state ?? '')) continue;
    // A worker it sent out: a row of its own, tied to that worker's card (ui/wings.js); the feed says how it went.
    if (e.kind === 'note' && (e.state === 'worker-sent' || e.state === 'worker-sent-grant')) {
      kids.push({ key: `w${e.ref}`, tpl: 'tpl-msg', data: { kind: 'disp', live: '0', batch: '', worker: e.ref, via: e.state === 'worker-sent-grant' ? 'grant' : 'person' }, slots: { who: { text: '' }, tx: { text: tk('fnote', e.state, 'fnote.other', { t: e.text ?? t('chat.unnamed') }) } } });
      continue;
    }
    if (e.kind === 'note' && e.state === 'dispatch') {
      let b = sent.get(e.batch);
      if (b === undefined) {
        b = { names: new Map(), node: { key: `d${e.batch}`, tpl: 'tpl-msg', data: { kind: 'disp', live: '0', batch: String(e.batch) }, slots: { who: { text: '' }, tx: { text: '' } } } };
        sent.set(e.batch, b);
        kids.push(b.node);
      }
      // Told again once its name is known (src/owned/codex-session.ts): the same sub-agent, in the same place.
      b.names.set(e.ref, e.text ?? '');
      b.node.slots.tx.text = sentText([...b.names.values()]);
      continue;
    }
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
      // Nothing runs on after the session: what it was doing at the end has no result, and no end was heard (T1).
      d.slots.sum.text += ` · ${join([tk('res', over && e.state === 'running' ? 'over' : e.state, 'res.unknown'), e.exitCode !== null && t('chat.exit', { n: e.exitCode })])}`;
      if (tx !== '') d.slots.body.text = d.slots.body.text === '' ? tx : `${d.slots.body.text}\n\n${t('chat.out')}\n${tx}`;
      d.data.live = e.live ? '1' : '0';
    } else if (e.kind === 'you') {
      const f = fates.get(e.uuid);
      msg(join([t(order ? 'chat.order' : 'chat.you'), f && tk('msgst', f.state, 'msgst.other', { t: f.text ?? '' })]), tx, 'you');
      order = false;
    } else if (e.kind === 'text' || e.kind === 'result') {
      msg(t('chat.agent'), e.live ? tx + t('chat.live') : tx, 'agent');
      if (e.kind === 'text' && e.ref !== null && !e.live) lastText = { ref: e.ref, node: kids[kids.length - 1] };
    } else if (e.kind === 'ask') msg(t('icon.approval'), t('chat.ask', { t: tx }), 'ask');
    else if (e.kind === 'answer') msg(t('chat.you'), tk('chat', e.state, 'chat.answered'), 'answer');
    // An automatic refusal says its reason; one this page has no words for says its code, never "timed out" (T1).
    else if (e.kind === 'auto-denied') msg('', tk('chat', e.state, 'chat.autoOther', { t: tx }), 'auto');
    else if (e.kind === 'lifecycle') msg('', join([tk('life', over && e.state === 'daemon-restart' ? 'daemon-restart-over' : e.state, 'chat.life'), tx]), 'life');
    else if (e.kind === 'note' && e.state === 'worker-asked') msg('', join([t('fnote.worker-asked'), e.text !== null && tk('askwhy', e.text, 'askwhy.other')], 'sep.notes'), 'note');
    else if (e.kind === 'note' && e.state === 'worker-refused') msg('', t('fnote.worker-refused', { t: tk('dispwhy', tx, 'dispwhy.other') }), 'note');
    else if (e.kind === 'note' && e.state === 'dispatch-grant') msg('', t('fnote.dispatch-grant', { t: tk('grant.level', tx, 'dash') }), 'note');
    else if (e.kind === 'note' && e.state !== 'tokens') msg('', tk('fnote', e.state, 'fnote.other', { t: tx }), 'note');
  }
  const shown = kids.slice(-200);
  return { kids: shown, note: join([shown.length === 0 ? t('chat.none') : kids.length > 200 && t('chat.cut', { n: 200 }), feed.clipped && t('chat.clipped')], 'sep.notes') };
}

/** What a screen reader hears of the events after `after`: not your own words, not a live one, at most the last three. */
export function chatNews(feed, after) {
  const fresh = feed.events.filter((e) => e.seq > after && !e.live && e.kind !== 'you' && e.kind !== 'answer' && !(e.kind === 'note' && (MSG.test(e.state ?? '') || e.state === 'tokens' || e.state === 'desk-read')));
  const lines = describeChat({ clipped: false, events: fresh }).kids.map((d) => (d.tpl === 'tpl-tool' ? d.slots.sum.text : join([d.slots.who.text, d.slots.tx.text])));
  return lines.slice(-3).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join(t('sep.notes'));
}

/** The chat follows new messages only while the reader is at its bottom (scrolled up, it stays put). */
export const atBottom = (el) => !((el.scrollHeight ?? 0) - (el.scrollTop ?? 0) - (el.clientHeight ?? 0) > 24);

/** The waiting bar shows this request whole. */
export const pinWhole = (a) => !a.tooLong && a.preview.length <= 280 && a.preview.split('\n').length <= 4;

/**
 * How a card's allow is given: '0' a click; '1' held (or typed), r4 §10.9's high risk; '2' typed only: a high-risk
 * request of a tainted session (r4 §8.5: shell, the network, a write outside cwd take the typed word).
 */
export const allowHow = (a) => (!a.high ? '0' : a.tainted === true ? '2' : '1');

/** The pin's source chain cuts the requester's id and the label at this many characters each (the card shows them whole). */
export const PIN_ORIGIN_CHARS = 16;
/** A worker named where the words go on around it. */
const WORKER_CHARS = 60;
// Controls, format characters (bidi marks, embeddings, isolates, ALM, zero-width) and the line and paragraph
// separators, written out as \u{..} should one ever arrive: never drawn as itself (r4 §5.3 rendering rule 2).
// src/owned/text.ts escapeInvisible writes them out first and the contract refuses them in an origin's label;
// this is the page's own second line. Tab and newline too: the chain is one line.
const CTRL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const esc = (ch) => `\\u{${ch.codePointAt(0).toString(16)}}`;
const plain = (s) => String(s).replace(CTRL, esc);
// The chain's own marks, written out in a label: the DSH session wrote it, so a 」 or a → in it never closes the
// quote or adds a link that reads as Orchestra's own (a label 'x」→ 这个会话（已核实）' stays inside its quote).
const MARKS = /[\u300c\u300d\u300e\u300f\u2192]/g;
const quoted = (s) => plain(s).replace(MARKS, esc);
// What a reader sees as one character (a letter and its combining marks, a flag, an emoji and its skin tone): a cut never splits one.
const SEG = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (SEG === null ? [...s] : Array.from(SEG.segment(s), (g) => g.segment));
/** At most n characters (graphemes; code points where Intl.Segmenter is missing), a cut ending in '…'. */
const cutTo = (s, n) => {
  const cps = graphemes(s);
  return cps.length > n ? { text: `${cps.slice(0, Math.max(1, n - 1)).join('')}…`, cut: true } : { text: s, cut: false };
};

/**
 * r4 §8.5: the source chain at the top of a card (and a pin): who asked (the DSH session id the request named
 * itself by, its own word: 自称, 未核实; 未知 when it named none, T1), which request (its label is the DSH
 * session's own words too, said so, its 「」→ written out), and this session. ''
 * when the approval has no origin and its session is not tainted (a person's own sentence); a tainted one
 * without an origin says only that a DSH session asked. max: the pin's cut of the id and the label, which
 * the line then says (A16: never silently short). A worker's dispatch names that worker: orchestrad knows it, nothing here is its word.
 * The front desk's says so, in words of ours.
 */
export function originLine(a, max = Infinity) {
  const o = a.origin;
  if (o?.kind === 'desk-dispatch') return t('appr.originDesk');
  if (o?.kind === 'worker-dispatch') {
    const who = cutTo(quoted(o.label ?? o.requester ?? ''), max);
    return t('appr.originWorker', { who: who.text }) + (who.cut ? t('appr.originCut') : '');
  }
  if (o == null || o.kind !== 'agent-request') return a.tainted === true ? t('appr.tainted') : '';
  const id = o.requester === null ? null : cutTo(plain(o.requester), max);
  const label = o.label === null ? null : cutTo(quoted(o.label), max);
  const who = id === null ? t('appr.originWhoNone') : t('appr.originWho', { id: id.text });
  const line = label === null ? t('appr.originNoLabel', { who, req: plain(o.requestId) }) : t('appr.origin', { who, label: label.text });
  return id?.cut === true || label?.cut === true ? line + t('appr.originCut') : line;
}

/** Deny first; allow only where the request shows whole (high risk: held or typed, tainted: typed; void within SETTLE_MS of a change), else 去看. */
export function apprActs(a, g, where) {
  if (!g.unlocked) return [lockBtn()];
  const appr = a.approvalId;
  const what = { t: a.title || tk('kind', a.kind, 'kind.command') };
  const out = [btn('deny', t('appr.deny'), { act: 'deny', appr }, { 'aria-disabled': busy(g), 'aria-label': t('appr.denyLabel', what) })];
  if (a.canAccept && !a.tooLong && (where === 'card' || pinWhole(a))) {
    const how = allowHow(a);
    out.push(btn('allow', t(how === '2' ? 'appr.typeOnly' : how === '1' ? 'appr.hold' : 'appr.allow'), { act: 'allow', appr, high: how, settle: g.settle, hold: g.hold === appr ? '1' : '0' }, {
      'aria-disabled': g.settle !== '' ? 'true' : busy(g), title: how === '2' ? t('appr.typeOnlyHint') : how === '1' ? t('appr.holdHint') : null,
      'aria-label': t(how === '2' ? 'appr.typeOnlyLabel' : how === '1' ? 'appr.holdLabel' : 'appr.allowLabel', what),
    }));
  } else if (where === 'pin') out.push(btn('see', t('appr.see'), { act: 'see', appr }));
  return out;
}

/**
 * A tainted card's note: high risk is typed only; with a source chain, the chain stops at the DSH session that
 * asked, or says why what a worker or the front desk sent is held so. Without one (an older list; GET /api/owned lists one for
 * every tainted approval today) the head says only that a DSH session asked, and the note says the card has no chain (T1).
 */
const taintNote = (a) => {
  const how = a.high ? 'High' : 'Note';
  const k = a.origin?.kind;
  return k === 'desk-dispatch' ? `appr.taintedDesk${how}` : k === 'worker-dispatch' ? `appr.taintedWorker${how}` : `appr.tainted${how}${a.origin != null ? '' : 'Bare'}`;
};

/** An approval in full. */
export function describeCard(a, g) {
  const left = a.deadline - g.nowWall;
  return {
    key: a.approvalId, tpl: 'tpl-card', data: { high: a.high ? '1' : '0', tainted: a.tainted === true ? '1' : '0' },
    slots: {
      // r4 §8.5: an agent-triggered session's card says first where its turns came from, the source chain whole (a red bar, tower.css).
      kind: { text: join([originLine(a), tk('kind', a.kind, 'kind.command'), tk('risk', a.risk, 'risk.other'), a.high && t('appr.high')]) },
      left: { text: left > 0 ? t('wait.left', { t: fmtLeft(left) }) : t('wait.overdue') },
      title: { text: a.title },
      pv: { text: a.preview },
      note: { text: join([a.tooLong ? t('appr.cut') : !a.canAccept && t('appr.noAccept'), a.redactions > 0 && t('appr.redacted', { n: a.redactions }), a.tainted === true && t(taintNote(a))], 'sep.notes') },
      acts: { kids: apprActs(a, g, 'card') },
    },
  };
}

/** A waiting-bar entry of Orchestra's queue: a request (`a`, by default its session's first), whole, and its buttons. */
export function pinExtra(e, list, g, a = list?.approvals.find((x) => x.approvalId === entry(list, e.node.slice(2))?.waiting)) {
  const mine = e.source === 'orchestra';
  // r4 §8.5: a tainted session's pin says where its turns came from (the source chain, its id and label cut
  // at PIN_ORIGIN_CHARS, the cut said), with the same red bar as its card.
  const taint = mine && a !== undefined && (a.tainted === true || a.origin != null);
  return { ...(taint ? { data: { tainted: a.tainted === true || a.origin?.kind === 'agent-request' ? '1' : '0' }, hint: { text: originLine(a, PIN_ORIGIN_CHARS) } } : {}), acts:{ kids: !mine ? [] : !g.unlocked ? [lockBtn()] : a === undefined ? [] : apprActs(a, g, 'pin') }, pv: { text: mine && g.unlocked && a !== undefined && pinWhole(a) ? a.preview : '' } };
}

/** What waits in a session behind its first request: the bar has that one alone. @param {any} list */
const behindFirst = (list) => (list?.approvals ?? []).filter((/** @type {any} */ a) => {
  const first = entry(list, a.ownedId)?.waiting;
  return first != null && first !== a.approvalId;
});

/** The answers the tower's count, one a session, leaves out. @param {any} list */
export const queuedN = (list) => behindFirst(list).length;

/**
 * Sub-agents ask side by side, so one session can hold several requests while the bar stands for the first alone.
 * Each of the others gets its pin after that one, as it has its card in the session: 等你 then counts the answers it
 * takes, and agrees with the card that says who asks (T3). Locked, the list cannot be read: only the first shows.
 * @param {any} pins @param {any} list @param {any} g
 */
export function withQueued(pins, list, g) {
  const rest = behindFirst(list);
  const kids = pins.slots.list.kids.flatMap((/** @type {any} */ k) => {
    if (k.data?.src !== 'orchestra') return [k];
    return [k, ...rest.filter((/** @type {any} */ a) => `n:${a.ownedId}` === k.data.node).map((/** @type {any} */ a) => {
      const { data, ...slots } = pinExtra({ node: k.data.node, source: 'orchestra' }, list, g, a);
      const left = a.deadline - g.nowWall;
      return { ...k, key: `${k.key}:${a.approvalId}`, data: { ...k.data, ...data }, slots: { ...k.slots, ...slots, clock: { text: left > 0 ? t('wait.left', { t: fmtLeft(left) }) : t('wait.overdue') } } };
    })];
  });
  return kids.length === pins.slots.list.kids.length ? pins : { ...pins, slots: { ...pins.slots, n: { text: t('pin.n', { n: kids.length }) }, list: { kids } } };
}

// --- seat: agent requests in 「等你」 (src/route/requests.ts; r4 A17, D8) ---------------------------------

/**
 * The model a request's 派出 sends: the router model's pick for its harness, else the first suggested, else
 * the harness's default; src says which, and for the default why there is no suggestion (still asked, no
 * desk, none given, failed: never one word for all four, T1).
 */
export function requestModel(r) {
  if (typeof r.model === 'string') return { model: r.model, src: 'req.src.worker' };
  const g = r.suggestion;
  const m = g == null ? undefined : g.models[g.pick ?? 0];
  if (m !== undefined && modelsOf(r.harness).includes(m.model)) return { model: m.model, src: m.source === 'model' ? 'req.src.model' : 'req.src.rule' };
  const why = Object.hasOwn(TOWER_TEXT, `req.src.${r.suggesting}`) ? r.suggesting : g == null ? 'asking' : 'ready';
  return { model: modelsOf(r.harness)[0], src: `req.src.${why}` };
}

/** The owned session a request came from, or null for a DSH session's. */
const workerOf = (r) => (typeof r.requester === 'string' && r.requester.startsWith('owned:') ? r.requester.slice(6) : null);
/** That session's title as the list has it, cut as the tower cuts one (it is the whole first message), or its id. */
export const workerName = (list, id) => { const s = entry(list, id)?.title; return s !== undefined && s !== '' ? cutTo(s, WORKER_CHARS).text : id; };

/** Why a request went no further, in the talk's own words where it has them; a code it has none for stays a code (T1). */
export const reqWhy = (why) => (why == null ? t('dash') : tk('life', why.replace(/^session-/, ''), 'chat.life'));

/** Who asked, as the card says it: the requester's own id, or 未知 when it named none. */
const reqWho = (r) => (typeof r.requester === 'string' && r.requester.startsWith('dsh:') ? r.requester.slice(4) : t('req.whoNone'));

/**
 * Where a request's session runs, as its card says it: in its cwd (inside a project root; per harness, what it may do there unasked), else
 * Orchestra's own work dir and why. Either way the session is held as untrusted (r4 §8.5: a DSH session asked), which the card says.
 */
export const reqWhere = (r) => (workerOf(r) !== null ? join([typeof r.runIn === 'string' ? t('req.workerRoot', { cwd: r.cwd, run: r.runIn }) : r.cwd === '' ? t('req.workerWork') : t('req.cwd', { cwd: r.cwd, why: tk('cwdwhy', r.runInWhy ?? 'no-roots', 'cwdwhy.other') }), t(r.fromDesk === true ? (r.harness === 'claude' ? 'req.deskTaintedClaude' : 'req.deskTaintedCodex') : r.tainted === true ? 'req.workerTainted' : 'req.workerClean')], 'sep.notes')
  : typeof r.runIn === 'string' ? t(r.harness === 'claude' ? 'req.cwdRootClaude' : 'req.cwdRoot', { cwd: r.cwd, run: r.runIn })
  : join([t('req.cwd', { cwd: r.cwd, why: tk('cwdwhy', r.runInWhy ?? 'no-roots', 'cwdwhy.other') }), t(r.harness === 'claude' ? 'req.untrustedClaude' : 'req.untrustedCodex')], 'sep.notes'));

/** Where a session works, for its page: a project root or Orchestra's own dir; unknown from before a restart (T1); nothing from a list without the field. */
export const cwdText = (o) => (o?.cwd === undefined ? '' : o.cwd === null ? t('own.cwdUnknown') : t(o.cwd.kind === 'project-root' ? 'own.cwdRoot' : 'own.cwdWork', { d: o.cwd.path }));

/** What a request card names it by: its label, else its text's first line, at most 120 characters. */
export const reqWhat = (r) => {
  const s = (r.label ?? r.text.split('\n', 1)[0] ?? '').trim();
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

/**
 * The pending agent requests as cards for 「等你」, the one expiring first on top: who asked (its own word),
 * what, where it wanted to work, the model a dispatch would take, the time left (then it is a refusal, D8),
 * and 派出 / 拒绝. 派出 is void for SETTLE_MS after the bar moved (r4 §10.9, as an allow). The list only
 * comes once unlocked; before that the page shows describeAskPins (the tower's router.asks). data.due is
 * the deadline withRequests sorts by.
 */
export function describeRequestPins(list, g) {
  if (list === null || !Array.isArray(list.requests)) return [];
  const pending = list.requests.filter((r) => r.state === 'pending').sort((p, q) => p.expiresAt - q.expiresAt);
  return pending.map((r) => {
    const left = r.expiresAt - g.nowWall;
    const what = reqWhat(r);
    const m = requestModel(r);
    const worker = workerOf(r);
    return {
      key: `req:${r.requestId}`, tpl: 'tpl-req', data: { req: r.requestId, harness: r.harness, due: String(r.expiresAt) },
      slots: {
        kind: { text: worker === null ? t('req.kind', { h: t(`harness.${r.harness}`) }) : t('req.kindWorker', { who: workerName(list, worker), h: t(`harness.${r.harness}`) }) },
        what: { text: what },
        clock: { text: left > 0 ? t('req.left', { t: fmtLeft(left) }) : t('req.overdue') },
        pv: { text: r.text },
        meta: { text: join([worker === null ? t('req.who', { who: reqWho(r) }) : t('req.whoWorker', { who: workerName(list, worker) }), r.askWhy != null && tk('askwhy', r.askWhy, 'askwhy.other'), r.reason != null && t('req.reason', { t: r.reason }), r.returns != null && t('req.returns', { t: r.returns }), reqWhere(r), t('req.model', { m: m.model, src: t(m.src) })], 'sep.notes') },
        acts: { kids: reqActs(r, m, what, g) },
      },
    };
  });
}

/** What the order of a request may do while it waits: 拒绝, 派出 (void for SETTLE_MS after the bar moved, r4 §10.9). */
export function reqActs(r, m, what, g) {
  return !g.unlocked ? [lockBtn()] : [
    btn('no', t('req.no'), { act: 'req-no', req: r.requestId }, { 'aria-disabled': busy(g), 'aria-label': t('req.noLabel', { what }) }),
    btn('go', t('req.go'), { act: 'req-go', req: r.requestId, model: m.model, settle: g.settle }, { 'aria-disabled': g.settle !== '' ? 'true' : busy(g), 'aria-label': t('req.goLabel', { what }) }),
  ];
}

/**
 * Before the unlock (or while the list loads): the pending requests as the tower's router.asks gives them
 * to every paired page, harness and deadline only, so a locked page still sees that something waits and
 * when it is refused (D8). The text and who asked come with the unlock; the button is the unlock.
 */
export function describeAskPins(asks, g) {
  if (!Array.isArray(asks)) return [];
  return asks.map((a, i) => {
    const left = a.deadline - g.nowWall;
    return {
      key: `ask:${i}`, tpl: 'tpl-req', data: { req: '', harness: a.harness, due: String(a.deadline) },
      slots: {
        kind: { text: t('req.kindLocked', { h: t(`harness.${a.harness}`) }) },
        what: { text: t('req.lockedWhat') },
        clock: { text: left > 0 ? t('req.left', { t: fmtLeft(left) }) : t('req.overdue') },
        pv: { text: '' }, meta: { text: '' },
        acts: { kids: g.unlocked ? [] : [lockBtn()] },
      },
    };
  });
}

/**
 * 「等你」 with the request cards merged in: everything with a deadline by the time left, soonest first (the
 * request cards by data.due, the bar's own by `bar`'s deadlines), then the rest in the bar's order; its
 * count is the list's length (T3).
 */
export function withRequests(pins, reqs, bar = []) {
  if (reqs.length === 0) return pins;
  const due = new Map(bar.map((e) => [e.node, e.deadline]));
  const all = [...reqs.map((k) => ({ k, d: Number(k.data.due) })), ...pins.slots.list.kids.map((k) => ({ k, d: due.get(k.key) ?? null }))];
  const kids = all.map((x, i) => ({ ...x, i })).sort((a, b) => (a.d === null ? (b.d === null ? a.i - b.i : 1) : b.d === null ? -1 : a.d - b.d || a.i - b.i)).map((x) => x.k);
  return { ...pins, data: { ...pins.data, hide: '0' }, slots: { ...pins.slots, n: { text: t('pin.n', { n: kids.length }) }, note: { text: t('pin.order') }, list: { kids } } };
}

/** A notification of a new pending request: who asked, as its card says it; never a dispatch in it (r4 §10.9). */
export const notifyRequestText = (r, nowWall, list = null) => {
  const worker = workerOf(r);
  const v = { h: t(`harness.${r.harness}`), t: fmtLeft(Math.max(0, r.expiresAt - nowWall)) };
  return worker === null ? t('notify.reqBody', v) : t('notify.reqBodyWorker', { ...v, who: workerName(list, worker) });
};

/**
 * What a session page says of the agent request it was dispatched for (seat): you dispatched it at that
 * request, which names itself; once orchestrad no longer holds the request (evicted, a restart), that it
 * was one, and whether you dispatched it or a worker sent it out on your permission; '' for a session you started
 * yourself. Nobody fetches a worker's result: it stays with the session.
 */
export function requestOf(list, ownedId) {
  const r = list?.requests?.find((x) => x.ownedId === ownedId);
  if (r === undefined) return list?.requestedGone?.includes(ownedId) === true ? t('req.ofGone') : list?.sentGone?.includes(ownedId) === true ? t('req.ofAutoGone') : '';
  const worker = workerOf(r);
  const st = r.state === 'done' ? t(worker !== null ? 'reqst.doneWorker' : r.fetched === true ? 'reqst.fetched' : 'reqst.done') : tk('reqst', r.state, 'reqst.other', { why: reqWhy(r.why) });
  if (worker !== null) return t(r.auto === true ? 'req.ofAuto' : 'req.ofWorker', { who: workerName(list, worker), st });
  return t('req.of', { who: reqWho(r), st });
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
  const chat = describeChat(feed, o.state === 'ended' || o.state === 'failed', (o.dispatch?.depth ?? 0) > 0 || o.dispatch?.tainted === true);
  return {
    ownBox: on, evBox: off, ownActs: { kids: [] }, chatBox: on, chatNote: { text: chat.note }, chat: { kids: chat.kids },
    ownSt: {
      text: join([
        t('own.st', { model: o.model, state: tk('state', o.state, 'state.unknown') }), o.endReason === 'daemon-restart' && t('life.daemon-restart'),
        o.queued > 0 && t('own.queued', { n: o.queued }), o.tokens !== null && t(o.harness === 'codex' ? 'own.tokensRoot' : 'own.tokens', { n: o.tokens.total }), cwdText(o), requestOf(list, id),
      ]),
    },
    cardsH: { data: { hide: mine.length > 0 ? '0' : '1' }, text: t('own.cards', { n: mine.length }) },
    cards: { kids: mine.map((a) => describeCard(a, g)) },
  };
}

/**
 * The composer: a message steers a running turn; three stops: interrupt, end (two clicks), and for a
 * session in a Job of its own the brake (two clicks), every process in that Job; without one the note
 * says why not, and a brake that cannot report what it did says that. An ended session whose child has
 * not closed yet (its stop order runs) keeps the brake alone.
 */
export function describeOwnedDock(to, list, g, held, armed, brakeArmed = false) {
  const o = entry(list, to?.id);
  const note = to === null ? (g.unlocked ? 'dock.readonlyOpen' : 'dock.readonly') : !g.unlocked ? 'dock.locked' : o === undefined ? 'own.missing'
    : o.state === 'unknown' ? 'dock.unknown' : o.state === 'ended' || o.state === 'failed' ? 'dock.ended' : '';
  if (note === 'dock.ended' && o?.brake === true) {
    return {
      st: { text: '' }, in: off,
      btns: { kids: [btn('brake', t(brakeArmed ? 'dock.brakeSure' : 'dock.brake'), { act: 'brake', armed: brakeArmed ? '1' : '0' }, { 'aria-disabled': busy(g) })] },
      note: { text: join([t('dock.stopping'), list?.brakeWhy != null && t('dock.brakeUnsure', { why: brakeWhyText(list.brakeWhy) })], 'sep.notes') },
    };
  }
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
        btn('int', t('dock.interrupt'), { act: 'interrupt' }, { 'aria-disabled': run || o.queued > 0 || o.stoppable === true ? b : 'true' }),
        btn('end', t(armed ? 'dock.endSure' : 'dock.end'), { act: 'end', armed: armed ? '1' : '0' }, { 'aria-disabled': b }),
        ...(o.brake ? [btn('brake', t(brakeArmed ? 'dock.brakeSure' : 'dock.brake'), { act: 'brake', armed: brakeArmed ? '1' : '0' }, { 'aria-disabled': b })] : []),
      ],
    },
    note: { text: join([held && t('dock.lockedTo'), o.brake ? list?.brakeWhy != null && t('dock.brakeUnsure', { why: brakeWhyText(list.brakeWhy) }) : t('dock.noBrake', { why: brakeWhyText(list?.brakeWhy) })], 'sep.notes') },
  };
}

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
