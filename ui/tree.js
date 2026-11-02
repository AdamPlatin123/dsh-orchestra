// @ts-check
// The tower's rows (orchestra app plan §5, research §1.3, §1.5): snapshot + choices (filter, folds) ->
// flat treeitems in tree order, one row format for every layer.
// - Counts are filters (T3): under a filter the matching rows are exactly the nodes in that state;
//   their ancestors are signposts only.
// - A group row stands where its first member would; running, waiting, failed nodes never fold.
// - Freezing (§1.5): under the pointer or focus the order holds; what would appear, go or move is counted.

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Project} Project
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {import('../shared/tower-contract.js').Group} Group
 * @typedef {'waiting' | 'error' | 'running'} Filter
 * @typedef {{
 *   key: string, kind: 'project' | 'node' | 'group', level: number, parentKey: string | null,
 *   expandable: boolean, expanded: boolean, match: boolean, setsize: number, posinset: number,
 *   project: Project, node: Node | null, group: Group | null, gone: boolean,
 * }} Row
 *   level: aria-level (project 1, agent 2, subagent 3 on); match: counts toward the filter; gone: a
 *   frozen row whose node is no longer there; expandable: folds now (never under a filter).
 * @typedef {{ filter: Filter | null, collapsed: ReadonlySet<string>, open: ReadonlySet<string> }} TreeUi
 * @typedef {{ byId: Map<string, { node: Node, project: Project }>, kids: Map<string, Node[]> }} TowerIndex
 */

export const FILTERS = Object.freeze(/** @type {const} */ (['waiting', 'error', 'running']));

/** Where a tower misses the frame the page reads, or null; the daemon holds the whole contract. @param {any} b */
export function towerFrame(b) {
  const m = b?.meta;
  if (m?.v !== 1 || !/^[0-9a-f]{16}$/.test(m.rev) || !Number.isSafeInteger(m.observedAt)) return '$.meta';
  for (const k of ['projects', 'waitingBar']) if (!Array.isArray(b[k])) return `$.${k}`;
  return typeof b.tally === 'object' && b.tally !== null && typeof m.sources === 'object' && Array.isArray(m.rules) ? null : '$.tally';
}

/** @param {string} id */
export const projectKey = (id) => `p:${id}`;
/** @param {string} parentKey @param {Group} g */
export const groupKey = (parentKey, g) => `g:${parentKey}:${g.kind}:${g.label ?? ''}`;

/** @type {WeakMap<TowerSnapshot, TowerIndex>} */
const indexes = new WeakMap();

/** Node by id (with its project) and children by parent id, once per snapshot. @param {TowerSnapshot} snap @returns {TowerIndex} */
export function indexOf(snap) {
  let ix = indexes.get(snap);
  if (ix !== undefined) return ix;
  ix = { byId: new Map(), kids: new Map() };
  for (const project of snap.projects) {
    for (const node of project.nodes) {
      ix.byId.set(node.id, { node, project });
      if (node.parent !== null) {
        const list = ix.kids.get(node.parent) ?? [];
        list.push(node);
        ix.kids.set(node.parent, list);
      }
    }
  }
  indexes.set(snap, ix);
  return ix;
}

/** The names from the project down to the node (a waiting entry's path). @param {TowerSnapshot} snap @param {string} id @returns {string[]} */
export function pathOf(snap, id) {
  const ix = indexOf(snap);
  const hit = ix.byId.get(id);
  if (hit === undefined) return [];
  /** @type {string[]} */
  const out = [];
  for (let n = /** @type {Node | undefined} */ (hit.node); n !== undefined; n = n.parent === null ? undefined : ix.byId.get(n.parent)?.node) out.unshift(n.title);
  out.unshift(hit.project.name);
  return out;
}

/** The rows the tree shows for these choices. @param {TowerSnapshot} snap @param {TreeUi} ui @returns {Row[]} */
export function buildRows(snap, ui) {
  const ix = indexOf(snap);
  const f = ui.filter;
  /** @type {Map<string, boolean>} */
  const hasMatch = new Map();
  /** A node in the filter's state below `n`, memoized. @param {Node} n @returns {boolean} */
  const below = (n) => {
    const known = hasMatch.get(n.id);
    if (known !== undefined) return known;
    const v = (ix.kids.get(n.id) ?? []).some((k) => k.state === f || below(k));
    hasMatch.set(n.id, v);
    return v;
  };
  const shows = (/** @type {Node} */ n) => f === null || n.state === f || below(n);

  /** @type {Row[]} */
  const rows = [];
  /** @param {Partial<Row> & Pick<Row, 'key' | 'kind' | 'level' | 'parentKey' | 'project'>} r */
  const push = (r) => {
    const row = /** @type {Row} */ ({ expandable: false, expanded: false, match: false, setsize: 0, posinset: 0, node: null, group: null, gone: false, ...r });
    rows.push(row);
    return row;
  };

  /**
   * One sibling list: each node in order, a group row where its first member stands.
   * @param {Project} project @param {Node[]} siblings @param {Group[]} groups @param {string} parentKey @param {number} level
   */
  const list = (project, siblings, groups, parentKey, level) => {
    /** @type {Map<string, Group>} */
    const firstOf = new Map();
    /** @type {Set<string>} */
    const folded = new Set();
    if (f === null) {
      for (const g of groups) {
        for (const id of g.ids) folded.add(id);
        const first = siblings.find((s) => g.ids.includes(s.id));
        if (first !== undefined) firstOf.set(first.id, g);
      }
    }
    for (const n of siblings) {
      const g = firstOf.get(n.id);
      if (g !== undefined) {
        const key = groupKey(parentKey, g);
        const open = ui.open.has(key);
        push({ key, kind: 'group', level, parentKey, project, group: g, expandable: true, expanded: open });
        if (open) for (const m of siblings) if (g.ids.includes(m.id)) one(project, m, key, level + 1);
      }
      if (folded.has(n.id)) continue;
      if (shows(n)) one(project, n, parentKey, level);
    }
  };

  /** @param {Project} project @param {Node} n @param {string} parentKey @param {number} level */
  const one = (project, n, parentKey, level) => {
    const kids = ix.kids.get(n.id) ?? [];
    const expanded = kids.length > 0 && (f !== null || !ui.collapsed.has(n.id));
    // Under a filter a signpost stays open and offers no fold.
    push({ key: n.id, kind: 'node', level, parentKey, project, node: n, expandable: kids.length > 0 && f === null, expanded, match: f !== null && n.state === f });
    if (expanded) list(project, kids, n.groups, n.id, level + 1);
  };

  for (const project of snap.projects) {
    const roots = project.nodes.filter((n) => n.parent === null);
    if (f !== null && !roots.some(shows)) continue;
    const key = projectKey(project.id);
    const expanded = roots.length > 0 && (f !== null || !ui.collapsed.has(key));
    push({ key, kind: 'project', level: 1, parentKey: null, project, expandable: roots.length > 0 && f === null, expanded });
    if (expanded) list(project, roots, project.groups, key, 2);
  }
  numberSiblings(rows);
  return rows;
}

/** aria-setsize and aria-posinset among the rows that hang from the same row. @param {Row[]} rows */
function numberSiblings(rows) {
  /** @type {Map<string, Row[]>} */
  const by = new Map();
  for (const r of rows) {
    const k = `${r.parentKey ?? ''}|${r.level}`;
    const l = by.get(k) ?? [];
    l.push(r);
    by.set(k, l);
  }
  for (const l of by.values()) l.forEach((r, i) => { r.setsize = l.length; r.posinset = i + 1; });
}

/**
 * The frozen layout: `held`'s order, fresh data where a key remains (a vanished node stays, gone), and the
 * count of rows that would appear, go or move. @param {readonly Row[]} fresh @param {readonly Row[]} held
 * @returns {{ rows: Row[], pending: number }}
 */
export function freeze(fresh, held) {
  const freshBy = new Map(fresh.map((r) => [r.key, r]));
  const heldKeys = new Set(held.map((r) => r.key));
  const rows = held.map((r) => freshBy.get(r.key) ?? { ...r, gone: true });
  const added = fresh.filter((r) => !heldKeys.has(r.key)).length;
  const removed = held.filter((r) => !freshBy.has(r.key)).length;
  const a = held.map((r) => r.key).filter((k) => freshBy.has(k));
  const b = fresh.map((r) => r.key).filter((k) => heldKeys.has(k));
  let moved = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) moved++;
  return { rows, pending: added + removed + moved };
}

/** Where a key on row `i` leads (tree view pattern). @param {readonly Row[]} rows @param {number} i @param {string} key @returns {{ select: number } | { toggle: string, open: boolean } | null} */
export function navigate(rows, i, key) {
  const r = rows[i];
  if (r === undefined) return rows.length > 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) ? { select: 0 } : null;
  if (key === 'ArrowDown') return { select: Math.min(rows.length - 1, i + 1) };
  if (key === 'ArrowUp') return { select: Math.max(0, i - 1) };
  if (key === 'Home') return { select: 0 };
  if (key === 'End') return { select: rows.length - 1 };
  if (key === 'ArrowRight') {
    if (r.expandable && !r.expanded) return { toggle: r.key, open: true };
    if (r.expanded && rows[i + 1] !== undefined && rows[i + 1]?.parentKey === r.key) return { select: i + 1 };
    return null;
  }
  if (key === 'ArrowLeft') {
    if (r.expandable && r.expanded) return { toggle: r.key, open: false };
    for (let j = i - 1; j >= 0; j--) if ((rows[j]?.level ?? 0) < r.level) return { select: j };
    return null;
  }
  return null;
}

/** Nodes per state in the rows that count toward the filter: the T3 twin of the top bar. @param {readonly Row[]} rows */
export const matched = (rows) => rows.filter((r) => r.match).length;
