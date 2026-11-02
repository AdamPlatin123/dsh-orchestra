// @ts-check
// The hash route (orchestra app plan §5): #/ the tower, #/n/<nodeId> a node open (full screen on a
// phone), #/about the about view. The one module that navigates (the hash, and openFull).
/** As shared/tower-contract.js has them (the page does not load the contract). */
const NODE_ID_RE = /^n:[0-9a-f]{20}$/;
const TOWER_HEX20_RE = /^[0-9a-f]{20}$/;

/** @typedef {{ view: 'tower' | 'about', node: string | null }} Route */

/** @param {string} s */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

/** Any hash gives a route; what does not parse is the plain tower. @param {string} hash @returns {Route} */
export function parse(hash) {
  const [head, id] = hash.replace(/^#\/?/, '').split('/').map(decode);
  if (head === 'about') return { view: 'about', node: null };
  if (head === 'n' && id !== undefined && NODE_ID_RE.test(id)) return { view: 'tower', node: id };
  return { view: 'tower', node: null };
}

/** @param {Route} r */
export function format(r) {
  if (r.view === 'about') return '#/about';
  // A node id is 'n:' + 20 hex (no escaping); anything else is the tower.
  return r.node !== null && NODE_ID_RE.test(r.node) ? `#/n/${r.node}` : '#/';
}

/**
 * Writes the route into the hash: a history entry (Back closes a node page), none with `replace`. @param {Route} r @param {boolean} [replace]
 */
export function go(r, replace = false) {
  const h = format(r);
  if (location.hash === h || (h === '#/' && location.hash === '')) return;
  if (replace) location.replace(location.pathname + location.search + h);
  else location.hash = h;
}

/** Leaves for the full record of a session (the server-rendered /session page). @param {string} id */
export function openFull(id) {
  if (TOWER_HEX20_RE.test(id)) location.href = '/session?id=' + id;
}
