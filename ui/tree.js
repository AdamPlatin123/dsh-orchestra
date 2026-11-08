// @ts-check
// The tower snapshot as the page reads it (orchestra app plan §5): the frame it checks, a node by id, a node's
// path from its project. The tree of rows it once drew went with the old tower page (2026-11-08).

/**
 * @typedef {import('../shared/tower-contract.js').TowerSnapshot} TowerSnapshot
 * @typedef {import('../shared/tower-contract.js').Project} Project
 * @typedef {import('../shared/tower-contract.js').Node} Node
 * @typedef {{ byId: Map<string, { node: Node, project: Project }> }} TowerIndex
 */

/** Where a tower misses the frame the page reads, or null; the daemon holds the whole contract. @param {any} b */
export function towerFrame(b) {
  const m = b?.meta;
  if (m?.v !== 1 || !/^[0-9a-f]{16}$/.test(m.rev) || !Number.isSafeInteger(m.observedAt)) return '$.meta';
  for (const k of ['projects', 'waitingBar']) if (!Array.isArray(b[k])) return `$.${k}`;
  return typeof b.tally === 'object' && b.tally !== null && typeof m.sources === 'object' && Array.isArray(m.rules) ? null : '$.tally';
}

/** @type {WeakMap<TowerSnapshot, TowerIndex>} */
const indexes = new WeakMap();

/** Node by id (with its project), once per snapshot. @param {TowerSnapshot} snap @returns {TowerIndex} */
export function indexOf(snap) {
  let ix = indexes.get(snap);
  if (ix !== undefined) return ix;
  ix = { byId: new Map() };
  for (const project of snap.projects) for (const node of project.nodes) ix.byId.set(node.id, { node, project });
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
