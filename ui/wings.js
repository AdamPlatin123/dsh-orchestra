// @ts-check
// The home page's descriptors (第三轮方案 22「左 worker，右 team」, docs/design/mocks/2026-11-03-ensemble/round3):
// pure functions to ui/dom.js Paint values, like ui/view.js. Left the workers, Orchestra's own first and the
// read-only ones folded under one count; right what the current worker sent out, a card a dispatch, tied by a wire
// to its row in the talk. Everything comes from the tower snapshot and the talk: no team exists yet, and nothing here draws
// one. The front desk (总台) has no seat on the tower, so no list or count of workers holds it: its tile stands over them, from
// GET /api/owned. What waits on you and what failed stay at the top whatever is folded (describeIsland), each count the
// length of the list it opens (T3). Over the right half, once clicked open (第三轮 mock 21): every worker with something
// reported going on, a card each, and a worker's page pushed over them.
import { askingOf, describeFold, describeRun, memberRow, stateWord, toneOf } from './fold.js';
import { deskOf, modelsOf, ownedIdOf, sentText } from './owned.js';
import { indexOf, pathOf } from './tree.js';
import { HARNESSES, activityOf, detectsError, fmtAge, fmtLeft, guessed, srcText, t, clippedSessions } from './view.js';

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {import('../shared/tower-contract.js').Project} Project
 * @typedef {import('./dom.js').Paint} Paint
 * @typedef {import('./dom.js').Desc} Desc
 * @typedef {{ key: string, node: Node, project: Project, ro: boolean, members: { node: Node, depth: number }[], waits: boolean }} RunEntry
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
 * A node and all under it, depth first, each one's children by name: an order that holds from poll to poll.
 * @param {Project} project @returns {(n: Node, depth: number) => { node: Node, depth: number }[]}
 */
function treeOf(project) {
  /** @type {Map<string, Node[]>} */
  const under = new Map();
  for (const n of project.nodes) if (n.parent !== null) under.set(n.parent, [...(under.get(n.parent) ?? []), n]);
  for (const kids of under.values()) kids.sort(byName);
  /** @param {Node} n @param {number} depth @returns {{ node: Node, depth: number }[]} */
  const walk = (n, depth) => [{ node: n, depth }, ...(under.get(n.id) ?? []).flatMap((k) => walk(k, depth + 1))];
  return walk;
}

/**
 * What a worker sent out, as cards: one a dispatch (a batch, in the order they went out, as their rows stand in the
 * talk), then those no batch names (a read-only session's, all of them) by agent type, a same-type group one card that
 * claims no dispatch. Each member comes with what it sent in turn. Keys and order hold from poll to poll, so a card
 * never jumps: its members go by name, not by the snapshot's rank, which changes on every event and would swap the
 * card's title and the row being read.
 * A session it sent out through its dispatch tool is a worker of its own on the left and a card of its own here, with
 * what it sent in turn; those come last, by key.
 * @param {TowerSnapshot} snap @param {string | null} sel @returns {{ key: string, label: string | null, batch: number | null, worker?: string, members: { node: Node, depth: number }[] }[]}
 */
export function subCards(snap, sel) {
  const hit = sel === null ? undefined : indexOf(snap).byId.get(sel);
  // The front desk has no node of its own; what it sent out has.
  const project = hit?.project ?? snap.projects.find((p) => p.nodes.some((n) => n.sent?.by === sel));
  if (project === undefined) return [];
  const walk = treeOf(project);
  /** @type {Map<string, { key: string, label: string | null, batch: number | null, worker?: string, members: { node: Node, depth: number }[] }>} */
  const cards = new Map();
  // Its own sub-agents: the walk's first level, by name.
  for (const n of hit === undefined ? [] : walk(hit.node, 0).filter((m) => m.depth === 1).map((m) => m.node)) {
    const key = n.batch === null ? `${sel}:${n.agentType ?? ''}` : `${sel}#${n.batch}`;
    const card = cards.get(key) ?? { key, label: n.agentType, batch: n.batch, members: [] };
    card.members.push(...walk(n, 0));
    cards.set(key, card);
  }
  for (const n of project.nodes) {
    if (n.sent?.by !== sel) continue;
    const key = `${sel}~${n.id}`;
    cards.set(key, { key, label: null, batch: null, worker: n.id, members: walk(n, 0) });
  }
  return [...cards.values()].sort((a, b) => {
    if (a.worker !== undefined || b.worker !== undefined) return a.worker === undefined ? -1 : b.worker === undefined ? 1 : a.key < b.key ? -1 : 1;
    if (a.batch !== null || b.batch !== null) return (a.batch ?? Infinity) - (b.batch ?? Infinity);
    return a.label === null ? 1 : b.label === null ? -1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

/** A card of no agent type (a Codex session's are all so) goes by its first member's name. @param {readonly { node: Node }[]} members */
const titleOf = (members) => { const who = members[0]?.node.title ?? ''; return members.length === 1 ? who : t('fold.group', { who, n: members.length }); };

/**
 * The talk's dispatch rows for the home page: each a button that opens its card. Its words are the card's, so what it
 * says is what it opens (T3); a row whose card this snapshot does not hold says what the feed said, and opens nothing.
 * A worker's row is the receipt: how it went out, whose permission and when, and a stop while it has something to stop.
 * @param {readonly Desc[]} kids describeChat's rows @param {ReturnType<typeof subCards>} cards @param {ReadonlySet<string>} open
 * @param {(ms: number) => string} [at] a wall time as the receipt says it @returns {Desc[]}
 */
export function wireRows(kids, cards, open, at = String) {
  return kids.map((k) => {
    if (k.data?.kind !== 'disp') return k;
    const worker = k.data?.worker;
    const c = cards.find((x) => (worker === undefined ? String(x.batch) === k.data?.batch : x.worker === worker));
    const lead = c?.members[0]?.node;
    // A worker's row only: a batch of sub-agents is no session a stop could name. All of it counts: a background
    // sub-agent outlives its root's turn, and the stop reaches it.
    const held = worker !== undefined && c !== undefined && c.members.some((m) => m.node.state === 'running' || m.node.state === 'waiting');
    const how = lead?.sent?.grantAt == null ? t('home.sentPerson') : t('home.sentGrant', { at: at(lead.sent.grantAt) });
    return {
      ...k, tpl: 'tpl-disp',
      slots: {
        ...k.slots,
        ...(c === undefined ? {} : { tx: { text: worker === undefined ? sentText(c.members.map((m) => m.node.title)) : `${sentText([lead?.title ?? ''])}${t('sep.parts')}${how}` } }),
        stop: { text: t('home.stopWorker'), data: { hide: held ? '0' : '1', owned: lead === undefined ? '' : ownedIdOf(lead) ?? '' }, attr: { 'aria-label': t('home.stopWorkerLabel', { t: lead?.title ?? '' }) } },
        b: { data: { fold: c?.key ?? '' }, attr: { 'aria-expanded': c === undefined ? null : open.has(c.key) ? 'true' : 'false', disabled: c === undefined ? '' : null, title: c === undefined ? t('home.wireNoCard') : null } },
      },
    };
  });
}

/**
 * The wires: one a row and card that both stand in view, row and card measured by the page. A pair with either end
 * scrolled out has none: a line to nothing says nothing. The geometry goes in attributes, as the CSP has it.
 * @param {readonly { key: string, hot: boolean, grow: boolean, row: DOMRect, card: DOMRect }[]} ends
 * @param {{ chat: DOMRect, frame: DOMRect, subs: DOMRect, x: number }} box where the two lists stand, what cuts the talk off (it keeps a least height, so in a low window it runs past its pane), and x the cards' left edge @returns {Paint}
 */
export function describeWires(ends, box) {
  const seen = (/** @type {number} */ y, /** @type {DOMRect} */ r) => r.height > 0 && y >= r.top && y <= r.bottom;
  /** @type {Desc[]} */
  const kids = [];
  for (const e of ends) {
    const y1 = e.row.top + e.row.height / 2;
    const y2 = e.card.top + Math.min(e.card.height / 2, 30);
    if (!seen(y1, box.chat) || !seen(y1, box.frame) || !seen(y2, box.subs)) continue;
    const x1 = e.row.right + 4;
    const mx = x1 + (box.x - x1) * 0.55;
    kids.push({
      key: e.key, tpl: 'tpl-wire', data: { hot: e.hot ? '1' : '0', grow: e.grow ? '1' : '0' },
      slots: { p: { attr: { d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${box.x} ${y2}` } }, c: { attr: { cx: String(box.x), cy: String(y2) } } },
    });
  }
  return { kids };
}

/**
 * Why the right side is empty for this worker, or what its cards can and cannot say. A count equals its list (T3), so
 * what the limits left out is said here: the snapshot counts it, it does not say whose it was (T1). A card with a wire
 * needs no word; one without says why it has none: the talk is locked, not read yet, or holds no row for it.
 * @param {Node | undefined} n @param {readonly { key: string }[]} cards @param {number} over nodes the limits left out
 * @param {{ rows?: { has(k: string): boolean }, read?: boolean, locked?: boolean }} ctx the rows drawn, whether the talk was read, and whether that is for want of the unlock
 */
function subsNote(n, cards, over, ctx) {
  if (n === undefined) return t('home.subsPick');
  const ro = ownedIdOf(n) === null;
  const lone = cards.some((c) => ctx.rows?.has(c.key) !== true);
  const says = cards.length === 0 ? [t(ro ? 'home.subsRo' : n.harness === 'claude' ? 'home.subsClaude' : 'home.subsNone')] : ro ? [t('home.subsRoNote'), t('home.noWireRo')] : lone ? [t(ctx.read !== false ? 'home.noWire' : ctx.locked === true ? 'home.noWireLocked' : 'home.noWireUnread')] : [];
  return [...says, ...(over > 0 ? [t('home.subsClipped', { n: over })] : [])].join(t('sep.notes'));
}

/**
 * The right side's cards for the selected worker: folded unless clicked open (`open`, by key), running or not.
 * `front`: `sel` is the front desk's, which no node stands for.
 * @param {TowerSnapshot} snap @param {string | null} sel @param {{ open: ReadonlySet<string>, fresh: ReadonlySet<string>, rows?: { has(k: string): boolean }, read?: boolean, locked?: boolean, front?: boolean }} ctx @returns {Paint}
 */
export function describeSubs(snap, sel, ctx) {
  const n = sel === null ? undefined : indexOf(snap).byId.get(sel)?.node;
  const cards = subCards(snap, sel);
  const total = cards.reduce((k, c) => k + c.members.length, 0);
  return {
    slots: {
      head: { text: ctx.front === true ? t('home.subsH', { who: t('front.name') }) : n === undefined ? t('home.subsPlain') : t('home.subsH', { who: n.title }) },
      n: { text: cards.length === 0 ? '' : t('fold.n', { n: total }) },
      note: { text: ctx.front === true ? (cards.length === 0 ? t('front.subsNone') : '') : subsNote(n, cards, snap.meta.clipped.nodes, ctx) },
      list: {
        kids: cards.map((c) => describeFold({
          key: c.key, members: c.members, open: ctx.open.has(c.key), fresh: ctx.fresh.has(c.key),
          title: c.worker === undefined ? c.label ?? titleOf(c.members) : c.members[0]?.node.title ?? '',
          ...(c.worker === undefined ? {} : { kind: t('home.kindWorker'), opens: true }),
        })),
      },
    },
  };
}

/**
 * The bar under the right half: how many of the workers running go on which level, each count the workers the list has
 * for that level (T3); with no list it says why: locked, or not read yet (T1).
 * @param {any} list GET /api/owned's reply, or null @param {boolean} [unlocked] @returns {string}
 */
export function grantsLine(list, unlocked = false) {
  if (list === null || !Array.isArray(list.owned)) return t(unlocked ? 'home.grantsUnread' : 'home.grantsLocked');
  // The front desk is no worker: its level is on its own tile.
  const live = list.owned.filter((/** @type {any} */ o) => o.dispatch != null && o.frontDesk !== true);
  if (live.length === 0) return t('home.grantsNone');
  const free = live.filter((/** @type {any} */ o) => o.dispatch.level === 'free').length;
  return t('home.grants', { free, ask: live.length - free });
}

/**
 * A worker's dispatch permission in its 资料: the two levels you may set, the one r4 D20 does not allow, what its level
 * does now. Hidden on a read-only session.
 * @param {string | null} id the selected session, null for none of Orchestra's own @param {any} list GET /api/owned's reply, or null
 * @param {{ unlocked: boolean, fmt: (ms: number) => string, maxDepth: number }} ctx @returns {Paint}
 */
export function describeGrant(id, list, ctx) {
  if (id === null) return { data: { hide: '1' } };
  const o = list?.owned?.find((/** @type {any} */ x) => x.ownedId === id);
  const d = o?.dispatch ?? null;
  const row = (/** @type {string} */ level, /** @type {boolean} */ can) => ({
    key: level, tpl: 'tpl-lv', data: { on: d?.level === level ? '1' : '0', can: can ? '1' : '0' },
    slots: {
      b: { data: { level, owned: id }, attr: { 'aria-pressed': d?.level === level ? 'true' : 'false', disabled: can && ctx.unlocked && d !== null ? null : '', title: ctx.unlocked || !can ? null : t('grant.locked') } },
      name: { text: t(`grant.level.${level}`) },
      note: { text: t(level === 'free' && o?.frontDesk === true ? 'grant.note.freeFront' : `grant.note.${level}`) },
    },
  });
  const here = list == null ? '' : t(`grant.here.${list.presence ?? 'unknown'}`);
  // No level here: the list has not read this session (or does not know its state), it ended, or it has no tool (T1).
  const none = o === undefined || o.state === 'unknown' ? 'grant.unknown' : o.state === 'ended' || o.state === 'failed' ? 'grant.over' : 'grant.none';
  const says = !ctx.unlocked ? [t('grant.locked')] : d === null ? [t(none)] : [
    d.grantAt === null ? t('grant.default') : t('grant.since', { at: ctx.fmt(d.grantAt) }),
    o?.frontDesk === true && t(d.level === 'free' ? 'grant.frontFree' : 'grant.frontAsk'),
    d.tainted === true && t(d.byDesk !== true ? 'grant.tainted' : o?.harness === 'claude' ? 'grant.taintedDeskClaude' : 'grant.taintedDeskCodex'),
    d.depth >= ctx.maxDepth && t('grant.depth', { d: d.depth }),
    here,
  ];
  return { data: { hide: '0' }, slots: { st: { text: says.filter(Boolean).join(t('sep.notes')) }, lv: { kids: [row('ask', true), row('free', true), row('away', false)] } } };
}

/**
 * The front desk's tile over the workers: off with why, not open with the way to open it, or open and how it stands. It is
 * no worker, so it counts nowhere, and what is not known locked is said so (T1): the tower has no word of it.
 * @param {any} list GET /api/owned's reply, or null @param {{ unlocked: boolean, on: boolean, busy: boolean }} ctx @returns {Record<string, Paint>}
 */
export function describeFrontTile(list, ctx) {
  const f = list?.frontDesk ?? null;
  const d = deskOf(list);
  const live = f?.ownedId != null ? d : null;
  const max = list?.limits?.maxOwned ?? '?';
  const closed = f !== null && live === null;
  // You ended it: nothing to say. Anything else that ended it is said (a safety-stop above all).
  const over = d === null || d.endReason === null || d.endReason === 'you-ended' ? null : t(`life.${d.endReason}`);
  const l2 = !ctx.unlocked ? t('front.locked') : f === null ? t('front.unread') : live !== null ? `${live.model}${t('sep.parts')}${t(`state.${live.state}`)}`
    : !f.on ? t('front.off') : over !== null ? t('front.lastOver', { why: over }) : t('front.closed');
  const note = !ctx.unlocked ? t('front.noteLocked') : live !== null ? t('front.noteOpen', { n: max, l: t(`grant.level.${live.dispatch?.level ?? 'ask'}`) }) : `${t('home.noRouter')}${f?.on === true ? `${t('front.what', { n: max })}${t('front.sends')}` : ''}`;
  const pick = closed && f.on === true;
  return {
    tile: { data: { on: ctx.on ? '1' : '0', open: live !== null ? '1' : '0' } },
    b: { attr: { 'aria-current': ctx.on ? 'true' : null, title: note } },
    bd: { data: { b: live === null ? 'none' : live.state === 'running' || live.state === 'starting' ? 'run' : 'none' } },
    l2: { text: l2 },
    openBox: { data: { hide: pick ? '0' : '1' } },
    model: { kids: pick ? [f.model, ...modelsOf('claude').filter((m) => m !== f.model)].map((m) => ({ key: m, tpl: 'tpl-opt', text: m, attr: { value: m } })) : [] },
    open: { text: t('front.open'), attr: { disabled: ctx.busy ? '' : null } },
    note: { text: note },
  };
}

/**
 * The desk's head and 资料, over what describeDetail said of nothing selected. @param {any} d its entry, null while it has none
 * @param {any} list @returns {Paint}
 */
export function describeFrontHead(d, list) {
  // No way to open it is no reason to point at the way (T1); a list not read yet says nothing either way.
  if (d === null) return { data: { mode: 'empty' }, slots: { empty: { text: t(list == null ? 'front.unread' : list.frontDesk?.on === true ? 'front.pick' : 'front.off') } } };
  const kv = (/** @type {string} */ k, /** @type {string} */ v) => ({ key: k, tpl: 'tpl-kv', slots: { k: { text: t(k) }, v: { text: v } } });
  // The list names only the tools of the one that runs: of one that ended, no check is still to come.
  const running = list?.frontDesk?.ownedId === d.ownedId;
  const tools = running ? list.frontDesk.tools : null;
  return {
    data: { mode: 'front', state: '', harness: 'claude', src: '' },
    slots: {
      title: { text: t('front.name') }, sub: { text: t('front.sub', { m: d.model }) }, empty: { text: '' },
      facts: { kids: [kv('front.factTools', tools !== null ? tools.join(t('sep.parts')) : t(running ? 'front.factToolsNone' : 'front.factToolsOver')), kv('front.factCwd', d.cwd?.path ?? t('front.unknown')), kv('front.factPlace', t('front.factPlaceV')), kv('front.factSends', t('front.sends'))] },
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

/** A guess that it runs or waits: read off a log or a write, or a wait inferred. It makes no card (T1), only a count. @param {Node} n */
const looksBusy = (n) => (guessed(n) && (n.state === 'running' || n.state === 'waiting')) || n.waiting?.source === 'inferred';

/**
 * Every worker with something reported going on: one of its members runs or waits on you as reported, never a guess or
 * unknown (T1, toneOf). Free, those that wait on you first, then Orchestra's own, each by name; held (`order`, the keys
 * as drawn while the pointer or focus is on the list), as drawn, newcomers last. `failed`: those going on no more with
 * a sub-agent whose turn failed, which counts nowhere else (shared/tower-contract.js): with the right side shut their
 * subs card is out of sight, so they stand on the list, apart, and the capsule counts them. `all` has every worker,
 * going or not, for its page: the cards, the capsule and the page all come of this one call on one snapshot (T3).
 * @param {TowerSnapshot} snap @param {readonly string[]} order
 * @returns {{ cards: RunEntry[], failed: RunEntry[], guessed: number, all: Map<string, RunEntry> }}
 */
export function runCards(snap, order) {
  const { owned, readonly } = workersOf(snap);
  /** @type {Map<Project, ReturnType<typeof treeOf>>} */
  const walks = new Map();
  /** @type {Map<string, RunEntry>} */
  const all = new Map();
  /** @type {RunEntry[]} */
  const cards = [];
  /** @type {RunEntry[]} */
  const failed = [];
  let guesses = 0;
  for (const w of [...owned.map((x) => ({ ...x, ro: false })), ...readonly.map((x) => ({ ...x, ro: true }))]) {
    let walk = walks.get(w.project);
    if (walk === undefined) walks.set(w.project, (walk = treeOf(w.project)));
    const members = walk(w.node, 0);
    const tones = members.map((m) => toneOf(m.node));
    const e = { key: w.node.id, node: w.node, project: w.project, ro: w.ro, members, waits: tones.includes('wait') };
    all.set(e.key, e);
    if (tones.some((k) => k === 'run' || k === 'wait')) cards.push(e);
    else {
      if (members.some((m) => m.node.mark === 'failed')) failed.push(e);
      if (members.some((m) => looksBusy(m.node))) guesses++;
    }
  }
  const pos = new Map(order.map((id, i) => [id, i]));
  /** @param {RunEntry[]} list */
  const held = (list) => [...list.filter((c) => pos.has(c.key)).sort((a, b) => Number(pos.get(a.key)) - Number(pos.get(b.key))), ...list.filter((c) => !pos.has(c.key))];
  if (pos.size > 0) return { cards: held(cards), failed: held(failed), guessed: guesses, all };
  cards.sort((a, b) => Number(b.waits) - Number(a.waits) || Number(a.ro) - Number(b.ro) || byName(a.node, b.node));
  failed.sort((a, b) => Number(a.ro) - Number(b.ro) || byName(a.node, b.node));
  return { cards, failed, guessed: guesses, all };
}

/**
 * What the limits left out of this snapshot, sessions, projects and nodes: with any, a list of none says it read
 * none, never that there is none (T1).
 * @param {TowerSnapshot} snap @returns {{ sessions: number, projects: number, nodes: number, total: number }}
 */
export function clipsOf(snap) {
  const sessions = clippedSessions(snap);
  const { projects, nodes } = snap.meta.clipped;
  return { sessions, projects, nodes, total: sessions + projects + nodes };
}

/** A worker's kind on its card: its harness, a read-only one said so. @param {RunEntry} e */
const kindOf = (e) => (e.ro ? t('run.kindRo', { h: t(`harness.${e.node.harness}`) }) : t(`harness.${e.node.harness}`));

/**
 * How long a worker has been open: Orchestra's own by GET /api/owned's createdAt. Of a read-only one, or with no list
 * (locked, not read yet), it is not known and says so (T1). How long its turn has run, no route says.
 * @param {RunEntry} e @param {any} list GET /api/owned's reply, or null @param {number} nowWall
 */
export function runSince(e, list, nowWall) {
  const id = ownedIdOf(e.node);
  const o = id === null || !Array.isArray(list?.owned) ? undefined : list.owned.find((/** @type {any} */ x) => x.ownedId === id);
  const at = Number(o?.createdAt);
  return Number.isFinite(at) && at > 0 && nowWall >= at ? t('run.since', { t: fmtAge(nowWall - at) }) : t('run.noSince');
}

/**
 * The capsule beside 「等你」: the first two names and how many more, so its names and its number are the cards it
 * opens (T3); the members that failed, the sum of the flags on all the cards it opens, those going on and those apart
 * (a sub-agent's failed turn counts nowhere else), in words of its own: 「出错」 beside it counts another list. With no
 * card it says so, a guess said apart; with what the limits left out, that it read none, not that there is none (T1).
 * @param {ReturnType<typeof runCards> | null} run @param {{ open: boolean, clipped?: number }} ctx clipped: clipsOf's total
 * @returns {Record<string, Paint>}
 */
export function describeRunCap(run, ctx) {
  const cards = run?.cards ?? [];
  const names = cards.map((c) => c.node.title);
  const errs = [...cards, ...(run?.failed ?? [])].reduce((k, c) => k + c.members.filter((m) => toneOf(m.node) === 'err').length, 0);
  const clipped = ctx.clipped ?? 0;
  const none = clipped > 0 ? t('run.capNoneClipped', { n: clipped }) : t(run !== null && run.guessed > 0 ? 'run.capNoneGuess' : 'run.capNone');
  const tail = run === null ? t('run.capUnknown') : cards.length === 0 ? none : cards.length <= 2 ? t('run.capDoing') : t('run.capMore', { n: cards.length - 2 });
  return {
    capR: { data: { zero: cards.length === 0 ? '1' : '0' }, attr: { 'aria-expanded': ctx.open ? 'true' : 'false', title: names.length === 0 ? tail : t('run.capTitle', { who: names.join(t('run.sepNames')) }) } },
    capRw: { text: names.slice(0, 2).join(t('run.sepNames')) },
    capRn: { text: tail },
    capRe: { text: t('run.capErr', { n: errs }), data: { hide: errs > 0 ? '0' : '1' } },
  };
}

/**
 * The right side's list: a card a worker going on, its count the cards; then, apart, those going on no more whose
 * sub-agent failed, their count theirs. Why there is none, the guesses left out and what the limits left out
 * (sessions, projects and nodes) are said, never drawn as none (T1).
 * @param {ReturnType<typeof runCards>} run @param {{ list: any, nowWall: number, clipped: ReturnType<typeof clipsOf> }} ctx @returns {Paint}
 */
export function describeRunList(run, ctx) {
  const c = ctx.clipped;
  const notes = [
    run.cards.length === 0 && t(c.total > 0 ? 'run.noneClipped' : 'run.none'),
    run.guessed > 0 && t('run.guessed', { n: run.guessed }),
    c.total > 0 && t('run.clipped', { s: c.sessions, p: c.projects, n: c.nodes }),
  ].filter(Boolean);
  const card = (/** @type {RunEntry} */ e) => describeRun({ key: e.key, title: e.node.title, kind: kindOf(e), took: runSince(e, ctx.list, ctx.nowWall), members: e.members });
  return {
    slots: {
      n: { text: run.cards.length === 0 ? '' : t('fold.n', { n: run.cards.length }) },
      note: { text: notes.join(t('sep.notes')) },
      list: { kids: run.cards.map(card) },
      fh: { data: { hide: run.failed.length > 0 ? '0' : '1' } },
      fn: { text: t('fold.n', { n: run.failed.length }) },
      flist: { kids: run.failed.map(card) },
    },
  };
}

/**
 * A worker's page over the list, pushed by a click on its card: its members as rows, from the same run as the card, a
 * row a mark (T3). Only its own row leads to its talk; it takes no action (D8: an allow, a no and a stop stay in its
 * talk and in 「等你」). One that stopped going on, or left the snapshot, says so and stays until you go back.
 * @param {ReturnType<typeof runCards>} run @param {{ page: string | null, title: string, list: any, nowWall: number }} ctx @returns {Paint}
 */
export function describeRunPage(run, ctx) {
  if (ctx.page === null) return { data: { hide: '1' }, slots: { list: { kids: [] } } };
  const e = run.all.get(ctx.page);
  if (e === undefined) return { data: { hide: '0' }, slots: { title: { text: ctx.title }, sub: { text: '' }, note: { text: t('run.pageGone') }, list: { kids: [] } } };
  const tones = e.members.map((m) => toneOf(m.node));
  const asking = askingOf(e.members.map((m) => m.node));
  const errs = tones.filter((k) => k === 'err').length;
  const sub = [kindOf(e), t('run.members', { n: e.members.length }), runSince(e, ctx.list, ctx.nowWall), asking > 0 && t('fold.flagWait', { n: asking }), errs > 0 && t('fold.flagErr', { n: errs })];
  return {
    data: { hide: '0' },
    slots: {
      title: { text: e.node.title },
      sub: { text: sub.filter(Boolean).join(t('sep.parts')) },
      note: { text: [!run.cards.includes(e) && t('run.pageNotNow'), t('run.pageActs')].filter(Boolean).join(t('sep.notes')) },
      list: { kids: e.members.map((m, i) => memberRow(m.node, m.depth, i === 0)) },
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
