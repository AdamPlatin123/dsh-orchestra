// @ts-check
// The tower page's descriptors (orchestra app plan §5, tower panel research §1-§3): pure functions from
// a TowerSnapshot, the rows of ui/tree.js and the page's choices to the Paint values ui/dom.js writes.
// Every word comes from shared/strings.js (TOWER_TEXT) through t(); source strings (titles, activity,
// event text) are written as text, never parsed. Time arrives as arguments: the page's clock is ui/clock.js.

import { TOWER_TEXT } from '../shared/strings.js';
import { indexOf, pathOf } from './tree.js';

/** @typedef {import('./dom.js').Paint} Paint */
/** @typedef {import('./dom.js').Desc} Desc */
/** @typedef {import('./tree.js').Row} Row */
/** @typedef {import('./tree.js').Filter} Filter */
/** @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot */
/** @typedef {import('../shared/tower-contract.js').Node} Node */
/** @typedef {import('../shared/tower-contract.js').Group} Group */
/** @typedef {'claude' | 'dsh' | 'codex'} Harness */
/** @typedef {{ session: { id: string }, events: { at: string | null, type: string, text: string }[], unparsed: number, note: string | null }} SessionDetail */
/** @typedef {{ id: string, body: SessionDetail | { error: string } | null }} Detail */

export const HARNESSES = Object.freeze(/** @type {const} */ (['claude', 'dsh', 'codex']));
/** How many of a session's last events the detail shows, newest first. */
export const EVENTS_SHOWN = 12;

/**
 * The text under `key` with each {name} filled from `args`. An unknown key throws: every key the page
 * names is in TOWER_TEXT (test/ui/tower-strings.test.ts walks them all).
 * @param {string} key @param {Record<string, string | number>} [args]
 */
export function t(key, args = {}) {
  if (!Object.hasOwn(TOWER_TEXT, key)) throw new Error(`no text ${key}`);
  return TOWER_TEXT[key].replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(args, k) ? String(args[k]) : m));
}

/**
 * A duration in one coarse unit: `age` for the row column (6 分), `ago` for a sentence (6 分钟前).
 * Null, negative or not a number is the dash: not known is never 0 (T1).
 * @param {number | null} ms @param {'age' | 'ago'} [unit]
 */
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

/**
 * The one line a row says about what it does or waits on. An inferred wait says only that it may be
 * waiting (research §1.5: no tool name or argument for a guess).
 * @param {Node} n
 */
export function activityOf(n) {
  if (n.waiting !== null) {
    if (n.waiting.source === 'inferred') return t('wait.inferred');
    const w = t(`wait.${n.waiting.kind}`);
    return n.activity === null ? w : `${w} · ${n.activity}`;
  }
  if (n.activity !== null) return n.activity;
  return n.state === 'unknown' ? t('state.unknown') : t('dash');
}

/** @param {Group} g */
export function groupText(g) {
  if (g.kind === 'same-type') return t('group.same', { label: g.label ?? '', n: g.count });
  return t(`group.${g.kind}`, { n: g.count });
}

/**
 * The text of a waiting source; an Orchestra wait counts down against the daemon's time.
 * @param {NonNullable<Node['waiting']>} w @param {string} harness @param {number} nowWall
 */
function clockOf(w, harness, nowWall) {
  if (w.source === 'orchestra' && w.deadline !== null) {
    const left = w.deadline - nowWall;
    return left > 0 ? t('wait.left', { t: fmtLeft(left) }) : t('wait.overdue');
  }
  if (w.source === 'native') return t('wait.native', { h: harnessName(harness) });
  return '';
}

/**
 * The top bar: counts that are filters, the three sources, the freshness of the data.
 * @param {TowerSnapshot | null} snap
 * @param {{ filter: Filter | null, ageMs: number | null, stale: boolean, theme: string, view: string }} ctx
 * @returns {Paint}
 */
export function describeBar(snap, ctx) {
  const tally = snap?.tally ?? { waiting: 0, error: 0, running: 0 };
  /** @param {Filter} f @returns {Paint} */
  const count = (f) => ({
    text: t(`count.${f}`, { n: tally[f] }),
    data: { n: tally[f] > 0 ? '1' : '0' },
    attr: { 'aria-pressed': ctx.filter === f ? 'true' : 'false' },
  });
  const fresh = ctx.ageMs === null ? t('fresh.none') : ctx.stale ? t('fresh.stale', { n: Math.floor(ctx.ageMs / 1000) }) : t('fresh.live', { age: fmtAge(ctx.ageMs, 'ago') });
  return {
    slots: {
      test: { data: { hide: snap !== null && snap.meta.profile === 'test' ? '0' : '1' } },
      waiting: count('waiting'),
      error: count('error'),
      running: count('running'),
      srcs: { kids: snap === null ? [] : HARNESSES.map((h) => describeSrc(snap, h)) },
      fresh: { data: { fresh: ctx.ageMs === null ? 'none' : ctx.stale ? 'stale' : 'live' } },
      freshT: { text: fresh },
      about: { text: ctx.view === 'about' ? t('bar.tower') : t('bar.about'), attr: { 'aria-pressed': ctx.view === 'about' ? 'true' : 'false' } },
      theme: { text: t(`theme.${ctx.theme}`) },
    },
  };
}

/** One source's sentence: what it holds and how much of it shows (T1: clipped is never empty). @param {TowerSnapshot} snap @param {Harness} h */
export function srcText(snap, h) {
  const s = snap.meta.sources[h];
  const name = harnessName(h);
  if (s.state === 'error') return t('src.error', { h: name, code: s.error ?? '' });
  if (s.state === 'empty') return t('src.empty', { h: name });
  if (s.shown < s.total) return t('src.clipped', { h: name, total: s.total, shown: s.shown });
  return t('src.ok', { h: name, total: s.total });
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
 * The waiting bar: one entry per waiting node, in the snapshot's order (deadlines first). In M0 every
 * entry is native or inferred: no button, only where to go (research §1.5).
 * @param {TowerSnapshot} snap @param {{ sel: string | null, nowWall: number }} ctx
 * @returns {Paint}
 */
export function describePins(snap, ctx) {
  const ix = indexOf(snap);
  /** @type {Desc[]} */
  const kids = [];
  for (const e of snap.waitingBar) {
    const hit = ix.byId.get(e.node);
    if (hit === undefined) continue;
    const n = hit.node;
    const w = /** @type {NonNullable<Node['waiting']>} */ (n.waiting);
    const h = harnessName(n.harness);
    kids.push({
      key: e.node, tpl: 'tpl-pin',
      data: { node: e.node, src: e.source, harness: n.harness, sel: ctx.sel === e.node ? '1' : '0' },
      slots: {
        ico: { text: t(`icon.${e.kind}`) },
        kind: { text: e.source === 'inferred' ? t('wait.inferred') : t(`wait.${e.kind}`) },
        path: { text: [t('pin.you'), ...pathOf(snap, e.node)].join(t('sep.path')) },
        clock: { text: clockOf(w, n.harness, ctx.nowWall) },
        hint: { text: e.source === 'orchestra' ? '' : t(e.source === 'inferred' ? 'wait.goNativeGuess' : 'wait.goNative', { h }) },
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

/**
 * The tree's rows. One row keeps the roving tabindex: the selected one, else the first.
 * @param {readonly Row[]} rows
 * @param {{ sel: string | null, peek: ReadonlySet<string>, flash: ReadonlyMap<string, string> }} ctx
 * @returns {Desc[]}
 */
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
  return {
    key: r.key, tpl: 'tpl-proj', data: { ...base, kind: 'project' }, attr,
    slots: {
      name: { text: p.name },
      act: { text: t('project.n', { n: p.nodes.length }) },
      ke: { text: errors > 0 ? t('kids.err', { n: errors }) : '' },
      kw: { text: waiting > 0 ? t('kids.wait', { n: waiting }) : '' },
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
      name: { text: groupText(g) },
      act: { text: t('group.note') },
    },
  };
}

/**
 * @param {Row} r @param {Record<string, string | null>} attr @param {Record<string, string>} base
 * @param {{ peek: ReadonlySet<string>, flash: ReadonlyMap<string, string> }} ctx @returns {Desc}
 */
function nodeRow(r, attr, base, ctx) {
  const n = /** @type {Node} */ (r.node);
  const c = n.counts;
  const approx = guessed(n);
  const state = t(`state.${n.state}`);
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
      act: { text: activityOf(n) },
      kids: { data: { has: c.children > 0 ? '1' : '0' }, attr: { title: c.children > 0 ? t('kids.sr', { c: c.children, e: c.errors, w: c.waiting }) : null } },
      kc: { text: c.children > 0 ? String(c.children) : '' },
      ke: { text: c.errors > 0 ? t('kids.err', { n: c.errors }) : '' },
      kw: { text: c.waiting > 0 ? t('kids.wait', { n: c.waiting }) : '' },
      kidsSr: { text: c.children > 0 ? t('kids.sr', { c: c.children, e: c.errors, w: c.waiting }) : '' },
      age: { text: fmtAge(n.ageMs) },
      own: { text: t(`own.${n.ownership}`), data: { own: n.ownership } },
      pkState: { text: t('peek.state', { s: state, b: t(`basis.${n.basis}`) }) },
      pkType: { text: n.agentType === null ? '' : t('peek.type', { t: n.agentType }) },
      pkAct: { text: n.activity === null ? '' : t('peek.act', { a: n.activity }) },
      pkSession: { text: n.session === null ? t('detail.noSession') : t('peek.session', { id: n.session }) },
    },
  };
}

/**
 * The tree's frame: the filter line, the pending changes of a frozen tree, the rows, the empty line.
 * @param {readonly Row[]} rows
 * @param {{ filter: Filter | null, pending: number, sel: string | null, peek: ReadonlySet<string>, flash: ReadonlyMap<string, string> }} ctx
 * @returns {Paint}
 */
export function describeTower(rows, ctx) {
  const f = ctx.filter;
  const n = rows.filter((r) => r.match).length;
  return {
    slots: {
      filterBox: { data: { hide: f === null ? '1' : '0' } },
      filterT: { text: f === null ? '' : t('tree.filter', { f: t(`state.${f}`), n }) },
      changes: { text: ctx.pending > 0 ? t('tree.changes', { n: ctx.pending }) : '', data: { hide: ctx.pending > 0 ? '0' : '1' }, attr: { title: t('tree.changesHint') } },
      tree: { kids: describeRows(rows, ctx) },
      empty: { data: { hide: rows.length === 0 ? '0' : '1' }, text: f === null ? t('tree.empty') : t('tree.emptyFilter', { f: t(`state.${f}`) }) },
    },
  };
}

/** @param {string} k @param {string} v @returns {Desc} */
const kv = (k, v) => ({ key: k, tpl: 'tpl-kv', slots: { k: { text: t(`detail.${k}`) }, v: { text: v } } });

/**
 * The right pane (the node page on a phone): the selected row's fields, its basis, its last events.
 * @param {TowerSnapshot} snap @param {string | null} sel @param {readonly Row[]} rows
 * @param {Detail | null} detail
 * @param {{ nowWall: number, fmtIso: (s: string) => string }} ctx
 * @returns {Paint}
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
      kv('kids', t('kids.sr', { c: node.counts.children, e: node.counts.errors, w: node.counts.waiting })),
      kv('age', fmtAge(node.ageMs, 'ago')),
      kv('session', node.session ?? t('detail.noSession')),
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
        empty: { text: t('detail.counts', { r: k('running'), w: k('waiting'), e: k('error') }) },
      },
    };
  }
  if (shown !== null && shown.kind === 'group') {
    const g = /** @type {Group} */ (shown.group);
    return {
      data: { mode: 'group', state: '', harness: '', src: '' },
      slots: { ...blank, title: { text: t('detail.groupTitle', { n: g.count }) }, sub: { text: t('detail.groupSub', { label: groupText(g) }) }, empty: { text: t('group.note') } },
    };
  }
  return {
    data: { mode: 'empty', state: '', harness: '', src: '' },
    slots: { ...blank, title: { text: '' }, sub: { text: '' }, empty: { text: t('detail.empty') } },
  };
}

/**
 * The detail's last events of a session, newest first; the note says what was not read (T1).
 * @param {string | null} session @param {Detail | null} detail @param {(s: string) => string} fmtIso
 * @returns {Record<string, Paint>}
 */
function events(session, detail, fmtIso) {
  const box = { data: { hide: '0' } };
  if (session === null) return { evBox: box, evNote: { text: t('detail.noSession') }, events: { kids: [] }, full: { data: { hide: '1' } } };
  const body = detail !== null && detail.id === session ? detail.body : null;
  if (body === null) return { evBox: box, evNote: { text: t('detail.loading') }, events: { kids: [] }, full: { data: { hide: '0' } } };
  if ('error' in body) return { evBox: box, evNote: { text: t('detail.err', { code: body.error }) }, events: { kids: [] }, full: { data: { hide: '0' } } };
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

/**
 * The reserved composer: in M0 it only says who a message would go to and that it cannot be sent yet.
 * @param {TowerSnapshot} snap @param {string | null} sel @returns {Paint}
 */
export function describeDock(snap, sel) {
  const hit = sel === null ? undefined : indexOf(snap).byId.get(sel);
  return { slots: { to: { text: hit === undefined ? t('dock.none') : t('dock.to', { who: hit.node.title }) } } };
}

/**
 * The about view: every source's totals, what the limits clipped, the rules and their sample counts.
 * @param {TowerSnapshot} snap @returns {Paint}
 */
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
