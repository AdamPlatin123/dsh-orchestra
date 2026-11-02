// @ts-check
// The hash route of the tower page (orchestra app plan §5): #/ is the tower, #/n/<nodeId> the tower with
// that node open (on a phone, its full-screen page), #/about the about view. This is the one module that
// navigates: the hash, and the server-rendered full record of a session (openFull).
import { NODE_ID_RE, TOWER_HEX20_RE } from '../shared/tower-contract.js';

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
  // A node id is 'n:' + 20 hex (NODE_ID_RE): nothing in it needs escaping; anything else is the tower.
  return r.node !== null && NODE_ID_RE.test(r.node) ? `#/n/${r.node}` : '#/';
}

/** Writes the route into the hash (a history entry, so Back closes a node page); hashchange brings it back. @param {Route} r */
export function go(r) {
  const h = format(r);
  if (location.hash !== h && !(h === '#/' && location.hash === '')) location.hash = h;
}

/** Leaves for the full record of a session (the server-rendered /session page). @param {string} id */
export function openFull(id) {
  if (TOWER_HEX20_RE.test(id)) location.href = '/session?id=' + id;
}
