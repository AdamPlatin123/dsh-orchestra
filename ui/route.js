// @ts-check
// The hash route (0.1 alpha design §1): #/<view>/<laneId>[/<nodeId>[/peek]], view stage or plan. The
// view matters only on a phone, where one of the two shows; /peek means the drawer is open. This is
// the one module that navigates away (openPeek).
import { frozen } from '../shared/frozen.js';

/** @typedef {{ view: 'stage' | 'plan', lane: string | null, node: string | null, peek: boolean }} Route */

export const VIEWS = frozen(['stage', 'plan']);
const LANE = /^[0-9a-f]{20}$/;
const NODE = /^(?:p:[0-9a-f]{20}|w:[A-Za-z0-9][A-Za-z0-9_.:-]{0,79})$/;

/** @param {string} s */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

/** @param {string} hash @returns {Route} */
export function parse(hash) {
  const [view, lane, node, peek] = hash.replace(/^#\/?/, '').split('/').map(decode);
  const okNode = node !== undefined && NODE.test(node);
  return {
    view: view === 'plan' ? 'plan' : 'stage',
    lane: lane !== undefined && LANE.test(lane) ? lane : null,
    node: okNode ? node : null,
    peek: okNode && peek === 'peek',
  };
}

/** @param {Route} r */
export function format(r) {
  if (r.lane === null) return `#/${r.view}`;
  if (r.node === null) return `#/${r.view}/${r.lane}`;
  return `#/${r.view}/${r.lane}/${encodeURIComponent(r.node)}${r.peek ? '/peek' : ''}`;
}

/** Writes the route into the hash; hashchange brings it back to the page. @param {Route} r */
export function go(r) {
  const h = format(r);
  if (location.hash !== h) location.hash = h;
}

/** Leaves for the full peek page of a session (the server-rendered /session view). @param {string} id */
export function openPeek(id) {
  if (LANE.test(id)) location.href = '/session?id=' + id;
}
