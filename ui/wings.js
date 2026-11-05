// @ts-check
// The home page's descriptors (第三轮方案 22「左 worker，右 team」, docs/design/mocks/2026-11-03-ensemble/round3):
// pure functions to ui/dom.js Paint values, like ui/view.js. Left the workers, Orchestra's own first and the
// read-only ones folded under one count; right what the current worker sent out. Everything comes from the tower
// snapshot: no router and no team exist yet, and nothing here draws one. What waits on you and what failed stay
// at the top whatever is folded (describeIsland), each count the length of the list it opens (T3).
import { describeFold, stateWord } from './fold.js';
import { ownedIdOf } from './owned.js';
import { indexOf, pathOf } from './tree.js';
import { HARNESSES, activityOf, detectsError, fmtAge, fmtLeft, guessed, srcText, t, clippedSessions } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {import('../shared/tower-contract.js').Project} Project
 * @typedef {import('./dom.js').Paint} Paint
 * @typedef {import('./dom.js').Desc} Desc
 */

/**
 * The trees of the snapshot: those Orchestra drives and those it only reads (a foreign one takes no message either).
 * A root is what leads a tree, an agent or a sub-agent whose parent the lane does not hold: left out, it would be
 * running where no row or count says so (T1). @param {TowerSnapshot} snap
 */
export function workersOf(snap) {
  /** @type {{ node: Node, project: Project }[]} */
  const owned = [];
  /** @type {{ node: Node, project: Project }[]} */
  const readonly = [];
  for (const project of snap.projects) {
    for (const node of project.nodes) {
      if (node.parent === null) (ownedIdOf(node) === null ? readonly : owned).push({ node, project });
    }
  }
  return { owned, readonly };
}

/**
 * The left list's rows in `order` (the ids as drawn while the list holds, research §1.5), newcomers last. With none,
 * the snapshot's, whose ranks change on every event. @param {TowerSnapshot} snap @param {readonly string[]} order
 */
export function railList(snap, order) {
  const pos = new Map(order.map((id, i) => [id, i]));
  const held = (/** @type {{ node: Node, project: Project }[]} */ list) => [
    ...list.filter((w) => pos.has(w.node.id)).sort((a, b) => Number(pos.get(a.node.id)) - Number(pos.get(b.node.id))),
    ...list.filter((w) => !pos.has(w.node.id)),
  ];
  const { owned, readonly } = workersOf(snap);
  return { owned: held(owned), readonly: held(readonly) };
}

/** The session a node belongs to (itself if it is one); null when the snapshot has no such node. @param {TowerSnapshot} snap @param {string} id */
export function rootOf(snap, id) {
  const ix = indexOf(snap);
  let n = ix.byId.get(id)?.node;
  while (n !== undefined && n.parent !== null) n = ix.byId.get(n.parent)?.node;
  return n?.id ?? null;
}

/** What a corner of an avatar says: failed, waits on you (below it too: a fold hides nothing), runs; a guess is hollow, unknown dashed (T1). @param {Node} n */
function badgeOf(n) {
  if (n.state === 'error' || n.counts.errors > 0) return 'err';
  if (n.state === 'waiting' && n.waiting?.source === 'inferred') return 'guess';
  if (n.state === 'waiting' || n.counts.waiting > 0) return 'wait';
  if (n.state === 'unknown') return 'unk';
  if (n.state === 'running') return guessed(n) ? 'guess' : 'run';
  return 'none';
}

/** A name's first character on a colour block; a read-only session's block is hollow. @param {Node} n @returns {Paint} */
export function avatarOf(n) {
  return {
    data: { harness: n.harness, ro: ownedIdOf(n) === null ? '1' : '0' },
    slots: { ch: { text: Array.from(n.title.trim())[0] ?? '' }, bd: { data: { b: badgeOf(n) } } },
  };
}

/** A row's second line: what it does or whom it waits on, else its state, a guess said in words too, never a blank (T1). @param {Node} n */
function lineOf(n) {
  const a = activityOf(n);
  return a === t('dash') ? `${stateWord(n)}${guessed(n) ? t('mark.inferredSr') : ''}` : a;
}

/** @param {{ node: Node, project: Project }} w @param {string | null} sel @param {boolean} ro @returns {Desc} */
function workerRow(w, sel, ro) {
  const n = w.node;
  const line = ro ? `${w.project.name}${t('sep.parts')}${lineOf(n)}` : lineOf(n);
  const on = sel === n.id;
  return {
    key: n.id, tpl: 'tpl-wk', data: { on: on ? '1' : '0' },
    slots: {
      b: { data: { node: n.id }, attr: { 'aria-current': on ? 'true' : null, title: `${n.title}${t('sep.parts')}${line}` } },
      av: avatarOf(n),
      name: { text: n.title },
      l2: { text: line, data: { tone: n.state === 'error' ? 'err' : n.state === 'waiting' ? 'wait' : '' } },
    },
  };
}

/**
 * The left list. The read-only group's count is the length of what it opens (T3); folded, it still says what in
 * it waits or failed. `order` is the list's while it holds (railList).
 * @param {TowerSnapshot} snap @param {{ sel: string | null, roOpen: boolean, order?: readonly string[] }} ctx @returns {Paint}
 */
export function describeRail(snap, ctx) {
  const { owned, readonly } = railList(snap, ctx.order ?? []);
  const waits = readonly.filter((w) => w.node.state === 'waiting' || w.node.counts.waiting > 0).length;
  const errs = readonly.filter((w) => w.node.state === 'error' || w.node.counts.errors > 0).length;
  return {
    slots: {
      ownH: { text: t('home.owned', { n: owned.length }) },
      own: { kids: owned.map((w) => workerRow(w, ctx.sel, false)) },
      noOwn: { data: { hide: owned.length === 0 ? '0' : '1' } },
      roB: { data: { hide: readonly.length === 0 ? '1' : '0' }, attr: { 'aria-expanded': ctx.roOpen ? 'true' : 'false' } },
      roH: { text: t('home.readonly', { n: readonly.length }) },
      roW: { text: t('fold.flagWait', { n: waits }), data: { hide: waits > 0 ? '0' : '1' } },
      roE: { text: t('fold.flagErr', { n: errs }), data: { hide: errs > 0 ? '0' : '1' } },
      ro: { data: { hide: ctx.roOpen ? '0' : '1' }, kids: ctx.roOpen ? readonly.map((w) => workerRow(w, ctx.sel, true)) : [] },
    },
  };
}

/**
 * What this snapshot could not read: a source that failed, and what the limits left out, sessions, projects and
 * nodes alike. It stands over both halves at every width, never left to look like none (T1).
 * @param {TowerSnapshot} snap @returns {Paint}
 */
export function describeLost(snap) {
  const sessions = clippedSessions(snap);
  const { projects, nodes } = snap.meta.clipped;
  const lines = [
    ...HARNESSES.filter((h) => snap.meta.sources[h].state === 'error').map((h) => srcText(snap, h)),
    sessions > 0 && t('home.clipped', { n: sessions }),
    (projects > 0 || nodes > 0) && t('about.clipped', { p: projects, n: nodes }),
  ].filter(Boolean);
  return { text: lines.join(t('sep.notes')), data: { hide: lines.length > 0 ? '0' : '1' } };
}

/** @param {Node} a @param {Node} b */
const byName = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What a worker sent out, as cards: its direct sub-agents by agent type (a same-type batch is one card), each with
 * what they sent in turn. Keys and order hold from poll to poll, so a card never jumps: its members go by name, not
 * by the snapshot's rank, which changes on every event and would swap the card's title and the row being read.
 * A sub-agent names no group of its own in the data, so no card claims to be one dispatch.
 * @param {TowerSnapshot} snap @param {string | null} sel @returns {{ key: string, label: string | null, members: { node: Node, depth: number }[] }[]}
 */
export function subCards(snap, sel) {
  const hit = sel === null ? undefined : indexOf(snap).byId.get(sel);
  if (hit === undefined) return [];
  /** @type {Map<string, Node[]>} */
  const under = new Map();
  for (const n of hit.project.nodes) if (n.parent !== null) under.set(n.parent, [...(under.get(n.parent) ?? []), n]);
  for (const kids of under.values()) kids.sort(byName);
  /** @param {Node} n @param {number} depth @returns {{ node: Node, depth: number }[]} */
  const walk = (n, depth) => [{ node: n, depth }, ...(under.get(n.id) ?? []).flatMap((k) => walk(k, depth + 1))];
  /** @type {Map<string, { key: string, label: string | null, members: { node: Node, depth: number }[] }>} */
  const cards = new Map();
  for (const n of under.get(hit.node.id) ?? []) {
    const type = n.agentType ?? '';
    const card = cards.get(type) ?? { key: `${hit.node.id}:${type}`, label: n.agentType, members: [] };
    card.members.push(...walk(n, 0));
    cards.set(type, card);
  }
  return [...cards.values()].sort((a, b) => (a.label === null ? 1 : b.label === null ? -1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** A card of no agent type (a Codex session's are all so) goes by its first member's name. @param {readonly { node: Node }[]} members */
const titleOf = (members) => { const who = members[0]?.node.title ?? ''; return members.length === 1 ? who : t('fold.group', { who, n: members.length }); };

/**
 * Why the right side is empty for this worker, or what its cards can and cannot say. A count equals its list (T3), so
 * what the limits left out is said here: the snapshot counts it, it does not say whose it was (T1).
 * @param {Node | undefined} n @param {number} cards @param {number} over nodes the limits left out
 */
function subsNote(n, cards, over) {
  if (n === undefined) return t('home.subsPick');
  const ro = ownedIdOf(n) === null;
  const says = cards === 0 ? [t(ro ? 'home.subsRo' : n.harness === 'claude' ? 'home.subsClaude' : 'home.subsNone')] : ro ? [t('home.subsRoNote'), t('home.noWireRo')] : [t('home.noWire')];
  return [...says, ...(over > 0 ? [t('home.subsClipped', { n: over })] : [])].join(t('sep.notes'));
}

/**
 * The right side's cards for the selected worker: folded unless clicked open (`open`, by key), running or not.
 * @param {TowerSnapshot} snap @param {string | null} sel @param {{ open: ReadonlySet<string>, fresh: ReadonlySet<string> }} ctx @returns {Paint}
 */
export function describeSubs(snap, sel, ctx) {
  const n = sel === null ? undefined : indexOf(snap).byId.get(sel)?.node;
  const cards = subCards(snap, sel);
  const total = cards.reduce((k, c) => k + c.members.length, 0);
  return {
    slots: {
      head: { text: n === undefined ? t('home.subsPlain') : t('home.subsH', { who: n.title }) },
      n: { text: cards.length === 0 ? '' : t('fold.n', { n: total }) },
      note: { text: subsNote(n, cards.length, snap.meta.clipped.nodes) },
      list: {
        kids: cards.map((c) => describeFold({
          key: c.key, members: c.members, open: ctx.open.has(c.key), fresh: ctx.fresh.has(c.key),
          title: c.label ?? titleOf(c.members),
        })),
      },
    },
  };
}

/**
 * What failed, each with its way there in full. It takes no action here: a read-only session is handled where it
 * runs, and the row opens its worker. Never shown as a list of none where the build reads no failures (T1).
 * @param {TowerSnapshot} snap @returns {Desc[]}
 */
export function describeErrs(snap) {
  if (!detectsError(snap)) return [];
  /** @type {Desc[]} */
  const kids = [];
  for (const p of snap.projects) {
    for (const n of p.nodes) {
      if (n.state !== 'error') continue;
      kids.push({
        key: `e:${n.id}`, tpl: 'tpl-pin', data: { node: n.id, src: 'error', harness: n.harness, sel: '0' },
        slots: {
          ico: { text: t('icon.error') }, kind: { text: t('state.error') },
          path: { text: [t('pin.you'), ...pathOf(snap, n.id)].join(t('sep.path')) },
          clock: { text: '' }, hint: { text: n.ownership === 'owned' ? n.activity ?? '' : t('wait.goNative', { h: t(`harness.${n.harness}`) }) },
          acts: { kids: [] }, pv: { text: '' },
        },
      });
    }
  }
  return kids;
}

/**
 * The two capsules over the composer. `pins` is 「等你」 as it is drawn and `errs` the failures: each capsule counts
 * the very list it opens (T3); the soonest deadline is said, and folded, where the first one came from.
 * @param {Paint} pins @param {readonly Desc[]} errs
 * @param {{ open: boolean, nowWall: number, bar: readonly { deadline: number | null }[], detects: boolean }} ctx @returns {Paint}
 */
export function describeIsland(pins, errs, ctx) {
  const kids = /** @type {readonly Desc[]} */ (pins.slots?.list?.kids ?? []);
  const due = [...ctx.bar.map((e) => e.deadline), ...kids.map((k) => Number(k.data?.due))].filter((d) => Number.isFinite(d));
  const first = kids[0]?.slots;
  const expanded = ctx.open ? 'true' : 'false';
  return {
    slots: {
      capW: { data: { zero: kids.length === 0 ? '1' : '0' }, attr: { 'aria-expanded': expanded } },
      capWn: { text: t('home.capWait', { n: kids.length }) },
      capWt: { text: due.length === 0 ? '' : t('home.capSoon', { t: fmtLeft(Math.min(.../** @type {number[]} */ (due)) - ctx.nowWall) }) },
      capE: { data: { hide: ctx.detects && errs.length > 0 ? '0' : '1' }, attr: { 'aria-expanded': expanded } },
      capEn: { text: t('home.capErr', { n: errs.length }) },
      hint: { text: ctx.open ? '' : first?.path?.text ?? first?.what?.text ?? '' },
      errs: { data: { hide: ctx.open && errs.length > 0 ? '0' : '1' }, kids: ctx.open ? errs : [] },
    },
  };
}

/** The top bar: where the data stands, then the two ways in. @param {TowerSnapshot | null} snap @param {{ ageMs: number | null, stale: boolean, theme: string }} ctx @returns {Paint} */
export function describeTop(snap, ctx) {
  const fresh = ctx.ageMs === null ? t('fresh.none') : ctx.stale ? t('fresh.stale', { n: Math.floor(ctx.ageMs / 1000) }) : t('fresh.live', { age: fmtAge(ctx.ageMs, 'ago') });
  return {
    slots: {
      test: { data: { hide: snap !== null && snap.meta.profile === 'test' ? '0' : '1' } },
      fresh: { text: fresh, data: { fresh: ctx.ageMs === null ? 'none' : ctx.stale ? 'stale' : 'live' } },
      theme: { text: t(`theme.${ctx.theme}`) },
    },
  };
}
