// @ts-check
// The descriptors the page shares (orchestra app plan §5, research §1-§3): words, times, 「等你」, a session's
// detail and the composer's recipient, as pure functions to ui/dom.js Paint values. Words come from
// shared/strings.js via t(); source strings are text, never parsed; time is an argument.

import { TOWER_TEXT } from '../shared/strings.js';
import { TIMEOUT_MS } from './api.js';
import { indexOf, pathOf } from './tree.js';

/**
 * @typedef {import('./dom.js').Paint} Paint
 * @typedef {import('./dom.js').Desc} Desc
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {'claude' | 'dsh' | 'codex'} Harness
 * @typedef {{ session: { id: string }, events: { at: string | null, type: string, text: string }[], unparsed: number, note: string | null }} SessionDetail
 * @typedef {{ id: string, body: SessionDetail | { error: string, reads?: number } | null }} Detail
 */

export const HARNESSES = Object.freeze(/** @type {const} */ (['claude', 'dsh', 'codex']));
/** How many of a session's last events the detail shows, newest first. */
export const EVENTS_SHOWN = 12;

/** TOWER_TEXT[key], each {name} filled from args; an unknown key throws. @param {string} key @param {Record<string, string | number>} [args] */
export function t(key, args = {}) {
  if (!Object.hasOwn(TOWER_TEXT, key)) throw new Error(`no text ${key}`);
  return TOWER_TEXT[key].replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(args, k) ? String(args[k]) : m));
}

/** A duration in one unit: `age` (6 分) or `ago` (6 分钟前); not known is the dash, never 0 (T1). @param {number | null} ms @param {'age' | 'ago'} [unit] */
export function fmtAge(ms, unit = 'age') {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return t('dash');
  const s = Math.floor(ms / 1000);
  if (s < 60) return t(`${unit}.s`, { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${unit}.m`, { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t(`${unit}.h`, { n: h });
  return t(`${unit}.d`, { n: Math.floor(h / 24) });
}

/** Time left on an Orchestra deadline as m:ss (h:mm:ss from an hour); 0:00 when it has passed. @param {number} ms */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** @param {string} h */
const harnessName = (h) => t(`harness.${h}`);
/** A state read off a log or guessed from a write carries ≈ (T1). @param {Node} n */
export const guessed = (n) => n.basis === 'log' || n.basis === 'mtime';

/** The row's icon: what it waits on, else its state. @param {Node} n */
export function iconOf(n) {
  return n.waiting !== null ? t(`icon.${n.waiting.kind}`) : t(`icon.${n.state}`);
}

/** What a row does or waits on; an inferred wait names no tool or argument (research §1.5). @param {Node} n */
export function activityOf(n) {
  if (n.waiting !== null) {
    if (n.waiting.source === 'inferred') return t('wait.inferred');
    const w = t(`wait.${n.waiting.kind}`);
    return n.activity === null ? w : `${w} · ${n.activity}`;
  }
  if (n.activity !== null) return n.activity;
  return n.state === 'unknown' ? t('state.unknown') : t('dash');
}

/** The subtree box, read aloud (errors only if the build reads failures). @param {Node['counts']} c @param {boolean} detectsError */
const kidsSr = (c, detectsError) => (detectsError ? t('kids.sr', { c: c.children, e: c.errors, w: c.waiting }) : t('kids.srNoErr', { c: c.children, w: c.waiting }));

/** A waiting source's text; Orchestra's counts down on the daemon's time. @param {NonNullable<Node['waiting']>} w @param {string} harness @param {number} nowWall */
function clockOf(w, harness, nowWall) {
  if (w.source === 'orchestra' && w.deadline !== null) {
    const left = w.deadline - nowWall;
    return left > 0 ? t('wait.left', { t: fmtLeft(left) }) : t('wait.overdue');
  }
  if (w.source === 'native') return t('wait.native', { h: harnessName(harness) });
  return '';
}

/** Whether the build reads failures (unsaid: true). @param {TowerSnapshot | null} snap */
export const detectsError = (snap) => snap === null || snap.meta.detects?.error !== false;

/** One source's sentence (T1: clipped is never empty). @param {TowerSnapshot} snap @param {Harness} h */
export function srcText(snap, h) {
  const s = snap.meta.sources[h];
  const name = harnessName(h);
  if (s.state === 'error') return t('src.error', { h: name, code: s.error ?? '' });
  if (s.state === 'empty') return t('src.empty', { h: name });
  // Claude counts main sessions only; a DSH or Codex subagent is a file of its own.
  const unit = t(`unit.${h}`);
  if (s.shown < s.total) return t('src.clipped', { h: name, total: s.total, unit, shown: s.shown });
  return t('src.ok', { h: name, total: s.total, unit });
}

/**
 * The waiting bar (ctx.bar's order while held); an entry opens its node. A native or inferred one only says
 * where to go (§1.5); Orchestra's own adds ctx.extra (owned.js pinExtra). @param {TowerSnapshot} snap @param {any} ctx @returns {Paint}
 */
export function describePins(snap, ctx) {
  const ix = indexOf(snap);
  /** @type {Desc[]} */
  const kids = [];
  for (const e of ctx.bar ?? snap.waitingBar) {
    const hit = ix.byId.get(e.node);
    if (hit === undefined) continue;
    const n = hit.node;
    const w = /** @type {NonNullable<Node['waiting']>} */ (n.waiting);
    const h = harnessName(n.harness);
    // ctx.extra's data (a tainted session's pin, owned.js) goes on the pin itself; the rest are slots.
    const { data: xd, ...xs } = ctx.extra?.(e) ?? {};
    kids.push({
      key: e.node, tpl: 'tpl-pin',
      data: { node: e.node, src: e.source, harness: n.harness, sel: ctx.sel === e.node ? '1' : '0', ...xd },
      slots: {
        ico: { text: t(`icon.${e.kind}`) },
        kind: { text: e.source === 'inferred' ? t('wait.inferred') : t(`wait.${e.kind}`) },
        path: { text: [t('pin.you'), ...pathOf(snap, e.node)].join(t('sep.path')) },
        clock: { text: clockOf(w, n.harness, ctx.nowWall) },
        hint: { text: e.source === 'orchestra' ? '' : t(e.source === 'inferred' ? 'wait.goNativeGuess' : 'wait.goNative', { h }) },
        acts: { kids: [] }, pv: { text: '' },
        ...xs,
      },
    });
  }
  return {
    data: { hide: kids.length === 0 ? '1' : '0' },
    slots: {
      n: { text: t('pin.n', { n: kids.length }) },
      note: { text: snap.waitingBar.some((e) => e.deadline !== null) ? t('pin.order') : '' },
      list: { kids },
    },
  };
}

/** What a node without a session file says in its place. @param {Node} n */
const noSession = (n) => t(n.ownership !== 'owned' ? 'detail.noSession' : n.layer === 'subagent' ? 'detail.ownedMember' : 'detail.ownedSession');

/** Sessions the limits left out, over every source (each source's total - shown). @param {TowerSnapshot} snap */
export const clippedSessions = (snap) => HARNESSES.reduce((k, h) => k + snap.meta.clipped.sessions[h], 0);

/** @param {string} k @param {string} v @returns {Desc} */
const kv = (k, v) => ({ key: k, tpl: 'tpl-kv', slots: { k: { text: t(`detail.${k}`) }, v: { text: v } } });

/**
 * The selected worker's pane: its fields, basis and last events. @param {TowerSnapshot} snap @param {string | null} sel
 * @param {Detail | null} detail @param {{ nowWall: number, fmtIso: (s: string) => string }} ctx @returns {Paint}
 */
export function describeDetail(snap, sel, detail, ctx) {
  const hit = sel === null ? undefined : indexOf(snap).byId.get(sel);
  const off = { data: { hide: '1' } };
  if (hit !== undefined) {
    const { node, project } = hit;
    const w = node.waiting;
    const layer = node.layer === 'agent' ? t('layer.agent') : t('layer.sub', { d: node.depth });
    /** @type {Desc[]} */
    const facts = [
      kv('state', guessed(node) ? `${t(`state.${node.state}`)} ${t('mark.inferred')}` : t(`state.${node.state}`)),
      kv('basis', t(`basis.${node.basis}`)),
    ];
    if (w !== null) {
      facts.push(kv('wait', t(`wait.${w.kind}`)));
      facts.push(kv('waitSrc', w.source === 'orchestra' ? `${t('source.orchestra')} · ${clockOf(w, node.harness, ctx.nowWall)}` : t(`source.${w.source}`, { h: harnessName(node.harness) })));
    }
    const member = node.ownership === 'owned' && node.layer === 'subagent';
    facts.push(kv('harness', harnessName(node.harness)), kv('owner', t(member ? 'own.ownedMemberLong' : `own.${node.ownership}Long`)), kv('layer', layer));
    if (node.layer === 'subagent') facts.push(kv('type', node.agentType ?? t('detail.noType')), kv('took', node.durationMs === null ? t('detail.noTook') : fmtAge(node.durationMs)));
    if (member) facts.push(kv('model', node.model ?? t('detail.noModel')));
    facts.push(
      kv('kids', kidsSr(node.counts, detectsError(snap))),
      kv('age', fmtAge(node.ageMs, 'ago')),
      kv('session', node.session ?? noSession(node)),
      kv('project', project.name),
    );
    return {
      data: { mode: 'node', state: node.state, harness: node.harness, src: w?.source ?? '' },
      slots: {
        ico: { text: iconOf(node) },
        title: { text: node.title },
        sub: { text: `${harnessName(node.harness)} · ${layer} · ${t(`own.${node.ownership}`)}` },
        empty: { text: '' },
        facts: { kids: facts },
        actBox: { data: { hide: '0' } },
        act: { text: node.activity ?? t('detail.noActivity') },
        ...events(node.session, detail, ctx.fmtIso),
      },
    };
  }
  return {
    data: { mode: 'empty', state: '', harness: '', src: '' },
    slots: { ico: { text: '' }, facts: { kids: [] }, actBox: off, evBox: off, title: { text: '' }, sub: { text: '' }, empty: { text: t('detail.empty') } },
  };
}

/**
 * Why a session's events were not read, in words where the code is known (T1): no answer within the page's
 * deadline, no connection, or no such file now; any other code as it came. `reads` is set once the page
 * has stopped reading again on its own (ui/drive.js, DETAIL_RETRIES): that many reads in a row got no answer.
 * @param {string} code @param {number} [reads]
 */
export function detailErr(code, reads) {
  const last = reads !== undefined && (code === 'timeout' || code === 'network');
  if (code === 'timeout') return t(last ? 'detail.err.timeout.last' : 'detail.err.timeout', { s: TIMEOUT_MS / 1000, n: reads ?? 0 });
  if (last) return t('detail.err.network.last', { n: reads });
  return Object.hasOwn(TOWER_TEXT, `detail.err.${code}`) ? t(`detail.err.${code}`) : t('detail.err', { code });
}

/** A session's last events, newest first; the note says what was not read (T1). @param {string | null} session @param {Detail | null} detail @param {(s: string) => string} fmtIso @returns {Record<string, Paint>} */
function events(session, detail, fmtIso) {
  const box = { data: { hide: '0' } };
  if (session === null) return { evBox: box, evNote: { text: t('detail.noSession') }, events: { kids: [] }, full: { data: { hide: '1' } } };
  const body = detail !== null && detail.id === session ? detail.body : null;
  if (body === null) return { evBox: box, evNote: { text: t('detail.loading') }, events: { kids: [] }, full: { data: { hide: '0' } } };
  if ('error' in body) return { evBox: box, evNote: { text: detailErr(body.error, body.reads) }, events: { kids: [] }, full: { data: { hide: '0' } } };
  const last = body.events.slice(-EVENTS_SHOWN).reverse();
  const notes = [];
  if (body.note !== null && Object.hasOwn(TOWER_TEXT, `note.${body.note}`)) notes.push(t(`note.${body.note}`));
  if (body.unparsed > 0) notes.push(t('detail.unparsed', { n: body.unparsed }));
  notes.unshift(last.length === 0 ? t('detail.noEvents') : t('detail.lastN', { n: last.length }));
  return {
    evBox: box,
    evNote: { text: notes.join(t('sep.notes')) },
    events: { kids: last.map((e, i) => ({ key: String(i), tpl: 'tpl-ev', slots: { at: { text: e.at === null ? t('dash') : fmtIso(e.at) }, ty: { text: e.type }, tx: { text: e.text } } })) },
    full: { data: { hide: '0' } },
  };
}

/** The composer's recipient (owned.js adds the rest). @param {TowerSnapshot} snap @param {string | null} sel @returns {Paint} */
export function describeDock(snap, sel) {
  const hit = sel === null ? undefined : indexOf(snap).byId.get(sel);
  return { slots: { to: { text: hit !== undefined ? t('dock.to', { who: hit.node.title }) : t('dock.none') } } };
}
