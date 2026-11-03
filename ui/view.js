// @ts-check
// The tower page's descriptors (orchestra app plan §5, research §1-§3): pure functions to ui/dom.js Paint
// values. Words come from shared/strings.js via t(); source strings are text, never parsed; time is an argument.

import { TOWER_TEXT } from '../shared/strings.js';
import { TIMEOUT_MS } from './api.js';
import { indexOf, pathOf } from './tree.js';

/**
 * @typedef {import('./dom.js').Paint} Paint
 * @typedef {import('./dom.js').Desc} Desc
 * @typedef {import('./tree.js').Row} Row
 * @typedef {import('./tree.js').Filter} Filter
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {import('../shared/tower-contract.js').Group} Group
 * @typedef {'claude' | 'dsh' | 'codex'} Harness
 * @typedef {{ session: { id: string }, events: { at: string | null, type: string, text: string }[], unparsed: number, note: string | null }} SessionDetail
 * @typedef {{ id: string, body: SessionDetail | { error: string } | null }} Detail
 * @typedef {{ sel: string | null, peek: ReadonlySet<string>, flash: ReadonlyMap<string, string>, detectsError?: boolean, cwdOf?: (id: string) => string | null }} RowCtx
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
const guessed = (n) => n.basis === 'log' || n.basis === 'mtime';

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

/** States in sibling order, for a breakdown. */
const STATES = Object.freeze(/** @type {const} */ (['waiting', 'error', 'running', 'unknown', 'returned', 'idle', 'ended']));

/**
 * A folded row's text; a same-type group says how its members stand (×12 Explore · 9 已回报), so a fold
 * never hides unknowns (T1). @param {Group} g @param {readonly Node[]} [nodes] the project's nodes, where the members are
 */
export function groupText(g, nodes = []) {
  if (g.kind !== 'same-type') return t(`group.${g.kind}`, { n: g.count });
  const head = t('group.same', { label: g.label ?? '', n: g.count });
  const ids = new Set(g.ids);
  /** @type {Map<string, number>} */
  const by = new Map();
  for (const n of nodes) if (ids.has(n.id)) by.set(n.state, (by.get(n.state) ?? 0) + 1);
  const parts = STATES.filter((s) => by.has(s)).map((s) => t('group.part', { n: by.get(s) ?? 0, s: t(`state.${s}`) }));
  return [head, ...parts].join(t('sep.parts'));
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

/**
 * The top bar: counts that filter, a source only when it failed (research §1.2), freshness. No failure
 * rule, no error count: 出错 0 would say "none" for "not looked" (T1). @param {TowerSnapshot | null} snap
 * @param {{ filter: Filter | null, ageMs: number | null, stale: boolean, theme: string, view: string }} ctx
 * @returns {Paint}
 */
export function describeBar(snap, ctx) {
  const tally = snap?.tally ?? { waiting: 0, error: 0, running: 0 };
  /** @param {Filter} f @returns {Paint} */
  const count = (f) => ({
    text: t(`count.${f}`, { n: tally[f] }),
    data: { n: tally[f] > 0 ? '1' : '0', hide: f === 'error' && !detectsError(snap) ? '1' : '0' },
    attr: { 'aria-pressed': ctx.filter === f ? 'true' : 'false' },
  });
  const fresh = ctx.ageMs === null ? t('fresh.none') : ctx.stale ? t('fresh.stale', { n: Math.floor(ctx.ageMs / 1000) }) : t('fresh.live', { age: fmtAge(ctx.ageMs, 'ago') });
  const failed = snap === null ? [] : HARNESSES.filter((h) => snap.meta.sources[h].state === 'error');
  return {
    slots: {
      test: { data: { hide: snap !== null && snap.meta.profile === 'test' ? '0' : '1' } },
      waiting: count('waiting'),
      error: count('error'),
      running: count('running'),
      srcBox: { data: { hide: failed.length === 0 ? '1' : '0' } },
      srcs: { kids: snap === null ? [] : failed.map((h) => describeSrc(snap, h)) },
      fresh: { data: { fresh: ctx.ageMs === null ? 'none' : ctx.stale ? 'stale' : 'live' } },
      freshT: { text: fresh },
      about: { text: ctx.view === 'about' ? t('bar.tower') : t('bar.about'), attr: { 'aria-pressed': ctx.view === 'about' ? 'true' : 'false' } },
      theme: { text: t(`theme.${ctx.theme}`) },
    },
  };
}

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

/** @param {TowerSnapshot} snap @param {Harness} h @returns {Desc} */
function describeSrc(snap, h) {
  const s = snap.meta.sources[h];
  const text = srcText(snap, h);
  return {
    key: h, tpl: 'tpl-src',
    data: { state: s.state, clipped: s.shown < s.total ? '1' : '0', harness: h },
    attr: { title: text },
    slots: { h: { text: harnessName(h) }, sr: { text } },
  };
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

/** The tree's rows; the roving tabindex is the selected row's, else the first's. @param {readonly Row[]} rows @param {RowCtx} ctx @returns {Desc[]} */
export function describeRows(rows, ctx) {
  const focus = rows.some((r) => r.key === ctx.sel) ? ctx.sel : (rows[0]?.key ?? null);
  return rows.map((r) => {
    const sel = r.key === ctx.sel;
    const attr = {
      'aria-level': String(r.level),
      'aria-expanded': r.expandable ? String(r.expanded) : null,
      'aria-selected': sel ? 'true' : 'false',
      'aria-setsize': String(r.setsize),
      'aria-posinset': String(r.posinset),
      tabindex: r.key === focus ? '0' : '-1',
    };
    const base = { key: r.key, sel: sel ? '1' : '0', open: r.expandable ? (r.expanded ? '1' : '0') : '', gone: r.gone ? '1' : '0' };
    if (r.kind === 'project') return projectRow(r, attr, base);
    if (r.kind === 'group') return groupRow(r, attr, base);
    return nodeRow(r, attr, base, ctx);
  });
}

/** @param {Row} r @param {Record<string, string | null>} attr @param {Record<string, string>} base @returns {Desc} */
function projectRow(r, attr, base) {
  const p = r.project;
  const errors = p.nodes.filter((n) => n.state === 'error').length;
  const waiting = p.nodes.filter((n) => n.state === 'waiting').length;
  // The box, said aloud (it is hidden from a screen reader).
  const parts = [...(errors > 0 ? [t('kids.srErr', { n: errors })] : []), ...(waiting > 0 ? [t('kids.srWait', { n: waiting })] : [])];
  return {
    key: r.key, tpl: 'tpl-proj', data: { ...base, kind: 'project' }, attr,
    slots: {
      name: { text: p.name },
      act: { text: t('project.n', { n: p.nodes.length }) },
      ke: { text: errors > 0 ? t('kids.err', { n: errors }) : '' },
      kw: { text: waiting > 0 ? t('kids.wait', { n: waiting }) : '' },
      kidsSr: { text: parts.length === 0 ? '' : t('project.sr', { parts: parts.join(t('sep.list')) }) },
    },
  };
}

/** @param {Row} r @param {Record<string, string | null>} attr @param {Record<string, string>} base @returns {Desc} */
function groupRow(r, attr, base) {
  const g = /** @type {Group} */ (r.group);
  return {
    key: r.key, tpl: 'tpl-group', data: { ...base, kind: 'group', group: g.kind }, attr,
    slots: {
      ind: { data: { depth: String(Math.max(0, r.level - 2)) } },
      ico: { text: g.kind === 'same-type' ? '' : t(g.kind === 'returned' ? 'icon.returned' : 'icon.idle') },
      name: { text: groupText(g, r.project.nodes) },
      act: { text: t('group.note') },
    },
  };
}

/**
 * A row's activity, and for an owned session the folder it works in (its last path part) once the page is
 * unlocked: ctx.cwdOf reads the owned list, which the tower snapshot never carries. @param {Node} n @param {RowCtx} ctx
 */
function actWithCwd(n, ctx) {
  const a = activityOf(n);
  const cwd = n.ownership === 'owned' && typeof ctx.cwdOf === 'function' ? ctx.cwdOf(n.id) : null;
  if (typeof cwd !== 'string' || cwd === '') return a;
  const where = t('row.cwd', { d: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd });
  return a === '' ? where : `${a}${t('sep.parts')}${where}`;
}

/** @param {Row} r @param {Record<string, string | null>} attr @param {Record<string, string>} base @param {RowCtx} ctx @returns {Desc} */
function nodeRow(r, attr, base, ctx) {
  const n = /** @type {Node} */ (r.node);
  const c = n.counts;
  const approx = guessed(n);
  const state = t(`state.${n.state}`);
  const sr = c.children > 0 ? kidsSr(c, ctx.detectsError ?? true) : '';
  return {
    key: r.key, tpl: 'tpl-node',
    data: {
      ...base, kind: 'node', state: n.state, harness: n.harness, basis: n.basis, src: n.waiting?.source ?? '',
      match: r.match ? '1' : '0', peek: ctx.peek.has(n.id) ? '1' : '0', flash: ctx.flash.get(n.id) ?? '',
    },
    attr,
    slots: {
      ind: { data: { depth: String(Math.max(0, r.level - 2)) } },
      ico: { text: iconOf(n) },
      name: { text: n.title },
      approx: { text: approx ? t('mark.inferred') : '' },
      srState: { text: approx ? `${state}${t('mark.inferredSr')}` : state },
      act: { text: actWithCwd(n, ctx) },
      kids: { data: { has: c.children > 0 ? '1' : '0' }, attr: { title: c.children > 0 ? sr : null } },
      kc: { text: c.children > 0 ? String(c.children) : '' },
      ke: { text: c.errors > 0 ? t('kids.err', { n: c.errors }) : '' },
      kw: { text: c.waiting > 0 ? t('kids.wait', { n: c.waiting }) : '' },
      kidsSr: { text: sr },
      age: { text: fmtAge(n.ageMs) },
      own: { text: t(`own.${n.ownership}`), data: { own: n.ownership } },
      pkState: { text: t('peek.state', { s: state, b: t(`basis.${n.basis}`) }) },
      pkType: { text: n.agentType === null ? '' : t('peek.type', { t: n.agentType }) },
      pkAct: { text: n.activity === null ? '' : t('peek.act', { a: n.activity }) },
      pkSession: { text: n.session === null ? t(n.ownership === 'owned' ? 'detail.ownedSession' : 'detail.noSession') : t('peek.session', { id: n.session }) },
    },
  };
}

/** The tree's frame: filter line, pending changes, rows, sessions the limits left out (T1). @param {readonly Row[]} rows @param {RowCtx & { filter: Filter | null, pending: number, clipped?: number, dispatch?: any, nowWall?: number, desk?: { on: boolean, why?: string } | null, unlocked?: boolean }} ctx @returns {Paint} */
export function describeTower(rows, ctx) {
  const f = ctx.filter;
  const n = rows.filter((r) => r.match).length;
  const clipped = ctx.clipped ?? 0;
  return {
    slots: {
      filterBox: { data: { hide: f === null ? '1' : '0' } },
      filterT: { text: f === null ? '' : t('tree.filter', { f: t(`state.${f}`), n }) },
      changes: { text: ctx.pending > 0 ? t('tree.changes', { n: ctx.pending }) : '', data: { hide: ctx.pending > 0 ? '0' : '1' }, attr: { title: t('tree.changesHint') } },
      tree: { kids: describeRows(rows, ctx) },
      empty: { data: { hide: rows.length === 0 ? '0' : '1' }, text: f === null ? t('tree.empty') : t('tree.emptyFilter', { f: t(`state.${f}`) }) },
      clipNote: { data: { hide: clipped > 0 ? '0' : '1' }, text: clipped > 0 ? t('tree.clipped', { n: clipped }) : '' },
      rNote: { text: routerNote(ctx.dispatch ?? null, ctx.nowWall ?? 0, ctx.desk ?? null) },
      // With no dispatch to show, the row points at the way to make one: the top bar's button, here too.
      rGo: { text: t(ctx.unlocked === true ? 'bar.new' : 'bar.newLocked'), data: { hide: (ctx.dispatch ?? null) === null && ctx.desk?.on !== false ? '0' : '1' } },
    },
  };
}

/**
 * The router row ("你"): the dispatch desk's last dispatch; else why there is none. The tower snapshot
 * never says whether the desk is on: desk is what the owned list said (unlocked only), null before (T1:
 * then it is unknown, not "no desk"). desk.why is already the reason in words.
 * @param {any} d @param {number} nowWall @param {{ on: boolean, why?: string } | null} [desk]
 */
export function routerNote(d, nowWall, desk = null) {
  if (d !== null) return t('router.last', { t: d.title, h: t(`harness.${d.harness}`), m: d.model, ago: fmtAge(nowWall - d.at, 'ago') });
  if (desk === null) return t('router.unknown');
  return desk.on ? t('router.none') : t('router.note', { why: desk.why ?? '' });
}

/** Sessions the limits left out, over every source (each source's total - shown). @param {TowerSnapshot} snap */
export const clippedSessions = (snap) => HARNESSES.reduce((k, h) => k + snap.meta.clipped.sessions[h], 0);

/** @param {string} k @param {string} v @returns {Desc} */
const kv = (k, v) => ({ key: k, tpl: 'tpl-kv', slots: { k: { text: t(`detail.${k}`) }, v: { text: v } } });

/**
 * The right pane (a phone's node page): the selected row's fields, basis and last events. @param {TowerSnapshot} snap
 * @param {string | null} sel @param {readonly Row[]} rows @param {Detail | null} detail @param {{ nowWall: number, fmtIso: (s: string) => string }} ctx @returns {Paint}
 */
export function describeDetail(snap, sel, rows, detail, ctx) {
  const ix = indexOf(snap);
  const shown = rows.find((r) => r.key === sel) ?? null;
  const hit = sel === null ? undefined : ix.byId.get(sel);
  const node = hit?.node ?? (shown?.kind === 'node' ? shown.node : null);
  const off = { data: { hide: '1' } };
  const blank = { ico: { text: '' }, facts: { kids: [] }, actBox: off, evBox: off, gone: off };
  if (node !== null && node !== undefined) {
    const project = hit?.project ?? shown?.project;
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
    facts.push(kv('harness', harnessName(node.harness)), kv('owner', t(`own.${node.ownership}Long`)), kv('layer', layer));
    if (node.layer === 'subagent') facts.push(kv('type', node.agentType ?? t('detail.noType')));
    facts.push(
      kv('kids', kidsSr(node.counts, detectsError(snap))),
      kv('age', fmtAge(node.ageMs, 'ago')),
      kv('session', node.session ?? t(node.ownership === 'owned' ? 'detail.ownedSession' : 'detail.noSession')),
      kv('project', project?.name ?? t('dash')),
    );
    return {
      data: { mode: 'node', state: node.state, harness: node.harness, src: w?.source ?? '' },
      slots: {
        ico: { text: iconOf(node) },
        title: { text: node.title },
        sub: { text: `${harnessName(node.harness)} · ${layer} · ${t(`own.${node.ownership}`)}` },
        empty: { text: '' },
        gone: { data: { hide: hit === undefined ? '0' : '1' }, text: t('detail.gone') },
        facts: { kids: facts },
        actBox: { data: { hide: '0' } },
        act: { text: node.activity ?? t('detail.noActivity') },
        ...events(node.session, detail, ctx.fmtIso),
      },
    };
  }
  if (shown !== null && shown.kind === 'project') {
    const p = shown.project;
    const k = (/** @type {string} */ s) => p.nodes.filter((n) => n.state === s).length;
    return {
      data: { mode: 'project', state: '', harness: '', src: '' },
      slots: {
        ...blank, title: { text: p.name }, sub: { text: t('detail.projectSub', { n: p.nodes.length }) },
        empty: { text: detectsError(snap) ? t('detail.counts', { r: k('running'), w: k('waiting'), e: k('error') }) : t('detail.countsNoErr', { r: k('running'), w: k('waiting') }) },
      },
    };
  }
  if (shown !== null && shown.kind === 'group') {
    const g = /** @type {Group} */ (shown.group);
    return {
      data: { mode: 'group', state: '', harness: '', src: '' },
      slots: { ...blank, title: { text: t('detail.groupTitle', { n: g.count }) }, sub: { text: t('detail.groupSub', { label: groupText(g, shown.project.nodes) }) }, empty: { text: t('group.note') } },
    };
  }
  return {
    data: { mode: 'empty', state: '', harness: '', src: '' },
    slots: { ...blank, title: { text: '' }, sub: { text: '' }, empty: { text: t('detail.empty') } },
  };
}

/**
 * Why a session's events were not read, in words where the code is known (T1): no answer within the page's
 * deadline, no connection, or no such file now; any other code as it came.
 * @param {string} code
 */
export function detailErr(code) {
  if (code === 'timeout') return t('detail.err.timeout', { s: TIMEOUT_MS / 1000 });
  return Object.hasOwn(TOWER_TEXT, `detail.err.${code}`) ? t(`detail.err.${code}`) : t('detail.err', { code });
}

/** A session's last events, newest first; the note says what was not read (T1). @param {string | null} session @param {Detail | null} detail @param {(s: string) => string} fmtIso @returns {Record<string, Paint>} */
function events(session, detail, fmtIso) {
  const box = { data: { hide: '0' } };
  if (session === null) return { evBox: box, evNote: { text: t('detail.noSession') }, events: { kids: [] }, full: { data: { hide: '1' } } };
  const body = detail !== null && detail.id === session ? detail.body : null;
  if (body === null) return { evBox: box, evNote: { text: t('detail.loading') }, events: { kids: [] }, full: { data: { hide: '0' } } };
  if ('error' in body) return { evBox: box, evNote: { text: detailErr(body.error) }, events: { kids: [] }, full: { data: { hide: '0' } } };
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
  // A project or a group is selected: say why it takes no message.
  const text = hit !== undefined ? t('dock.to', { who: hit.node.title }) : sel !== null && (sel.startsWith('p:') || sel.startsWith('g:')) ? t('dock.notNode') : t('dock.none');
  return { slots: { to: { text } } };
}

/** The about view: sources' totals, what was clipped, the rules and their samples. @param {TowerSnapshot} snap @returns {Paint} */
export function describeAbout(snap) {
  const { sources, clipped, rules } = snap.meta;
  return {
    slots: {
      srcRows: {
        kids: HARNESSES.map((h) => {
          const s = sources[h];
          const state = s.state === 'error' ? t('about.stateError', { code: s.error ?? '' }) : s.state === 'empty' ? t('about.stateEmpty') : t('about.stateOk');
          return {
            key: h, tpl: 'tpl-arow', data: { state: s.state, harness: h },
            slots: {
              h: { text: harnessName(h) }, st: { text: state }, total: { text: String(s.total) }, shown: { text: String(s.shown) },
              clip: { text: String(clipped.sessions[h]) }, reg: { text: s.registry === null ? t('about.noRegistry') : String(s.registry) },
            },
          };
        }),
      },
      clipped: { text: clipped.projects > 0 || clipped.nodes > 0 ? t('about.clipped', { p: clipped.projects, n: clipped.nodes }) : t('about.noClip') },
      rules: {
        kids: rules.map((r) => ({
          key: r.id, tpl: 'tpl-rule', data: { status: r.status },
          slots: {
            d: { text: Object.hasOwn(TOWER_TEXT, `rule.${r.id}`) ? t(`rule.${r.id}`) : t('rule.unknown') },
            id: { text: r.id },
            st: { text: r.status === 'keys-mismatch' ? t('rule.mismatch') : t('rule.untested', { n: r.n }) },
            hits: { text: t('rule.hits', { h: r.hits }) },
          },
        })),
      },
      noRules: { data: { hide: rules.length === 0 ? '0' : '1' }, text: t('about.noRules') },
    },
  };
}
