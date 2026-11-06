// @ts-check
// The folded card of the home page (mock round2/foldcard.js, as the page's CSP has it: descriptors for ui/dom.js,
// no markup): first line a name and an arrow, second line kind, count and time, third line one dot a member; past
// MAX_DOTS the dots become a bar of the same members, so the card keeps its height. It opens only when clicked:
// running never opens it. Pure, like ui/view.js. A folded card hides nothing that needs you: its flags say 等你 and
// 出错 on the second line, a sub-agent of an owned session by its mark (its state cannot say); what waits stands at
// the top of the page too, on its session's node, and so does what failed in a build that reads failures
// (ui/wings.js describeIsland). A worker's card on the right (describeRun, mock round3/21's roster panel) has the same
// face but opens nothing in place: a click pushes the worker's page over the list (ui/home.js).
import { activityOf, fmtAge, guessed, t } from './view.js';

/** @typedef {import('../shared/tower-contract.js').Node} Node */

export const MAX_DOTS = 16;
/** Marks in this order, the ones that need you first. */
const TONES = Object.freeze(/** @type {const} */ (['err', 'wait', 'run', 'guess', 'done', 'known', 'unk']));

const failed = (/** @type {Node} */ n) => n.state === 'error' || n.mark === 'failed';
const waits = (/** @type {Node} */ n) => n.state === 'waiting' || n.mark === 'asks';

/** A member's mark: only what was reported is solid; a state read off a log or a write is hollow, and unknown is dashed, never running (T1). @param {Node} n */
export function toneOf(n) {
  if (failed(n)) return 'err';
  if (n.state === 'unknown') return 'unk';
  if (guessed(n) || n.waiting?.source === 'inferred') return 'guess';
  if (waits(n)) return 'wait';
  if (n.state === 'running') return 'run';
  return n.state === 'returned' ? 'done' : 'known';
}

/** @param {readonly Node[]} members */
function marks(members) {
  const tones = members.map(toneOf).sort((a, b) => TONES.indexOf(a) - TONES.indexOf(b));
  const label = TONES.filter((k) => tones.includes(k)).map((k) => t('fold.part', { s: t(`fold.${k}`), n: tones.filter((x) => x === k).length })).join(t('sep.list'));
  const bar = members.length > MAX_DOTS;
  // One mark a member in either form: the bar's are narrow and touch, so a tone's run is its share, with no width to write (the CSP takes no style attribute).
  const kids = tones.map((k, i) => ({ key: String(i), tpl: 'tpl-fd', cls: `fd-${k}` }));
  const on = { data: { hide: '0' }, attr: { 'aria-label': label, title: label }, kids };
  const off = { data: { hide: '1' }, attr: { 'aria-label': null, title: null }, kids: [] };
  return { dots: bar ? off : on, bar: bar ? on : off };
}

/** How long a group took: its members ran side by side, so its longest; what is not known is said (T1). @param {readonly Node[]} members */
export function tookOf(members) {
  const known = members.map((n) => n.durationMs).filter((/** @type {number | null} */ d) => d !== null);
  if (known.length === 0) return t('fold.noTook');
  return t(known.length === members.length ? 'fold.took' : 'fold.tookSome', { t: fmtAge(Math.max(...known)) });
}

/** A member's state in words, a guess marked. @param {Node} n */
export const stateWord = (n) => (guessed(n) ? `${t('mark.inferred')} ${t(`state.${n.state}`)}` : t(`state.${n.state}`));

/** One row of an open card or a worker's page: its state, time and model, each unknown said as unknown. @param {Node} n @param {number} depth below the card's level @returns {import('./dom.js').Desc} */
export function memberRow(n, depth, opens = false) {
  return {
    key: n.id, tpl: 'tpl-mem', data: { depth: String(Math.min(depth, 3)) },
    slots: {
      dot: { cls: `fd-${toneOf(n)}` },
      name: { text: n.title },
      st: { text: stateWord(n) },
      took: { text: n.durationMs === null ? t('fold.noTook') : fmtAge(n.durationMs) },
      model: { text: n.model ?? t('fold.noModel') },
      act: { text: n.activity === null ? '' : activityOf(n) },
      go: { text: t('home.goWorker'), data: { hide: opens ? '0' : '1', node: n.id } },
    },
  };
}

/**
 * A card: `members` in list order, each with its depth under the worker. The count, the marks and the open list
 * all come from that one array, so they cannot disagree (T3).
 * @param {{ key: string, title: string, kind?: string, members: readonly { node: Node, depth: number }[], open: boolean, fresh?: boolean, opens?: boolean }} o opens: the first member is a worker of its own, with a way to its talk
 * @returns {import('./dom.js').Desc}
 */
export function describeFold(o) {
  const nodes = o.members.map((m) => m.node);
  return {
    key: o.key, tpl: 'tpl-fold', data: { fresh: o.fresh === true ? '1' : '0' },
    slots: {
      b: { data: { fold: o.key }, attr: { 'aria-expanded': o.open ? 'true' : 'false' } },
      title: { text: o.title },
      kind: { text: o.kind ?? t('fold.kind') },
      ...foldFace(nodes, tookOf(nodes)),
      body: { data: { hide: o.open ? '0' : '1' }, kids: o.open ? o.members.map((m, i) => memberRow(m.node, m.depth, o.opens === true && i === 0)) : [] },
    },
  };
}

/**
 * What both kinds of card show under the title: the count, a time, the flags and one mark a member. `solid`: the flags
 * count the marks, so a wait guessed off a log or inferred is no 等你 (T1), and a worker's page, counting the same
 * marks, says the same (T3).
 * @param {readonly Node[]} nodes @param {string} took @param {boolean} [solid]
 */
/**
 * How many of a worker's approvals wait, its own node first in `nodes`: a member of an owned session never waits
 * itself, its session waits for it and the member asks (src/sources/tower.ts), so a session that waits with members
 * asking is their approvals, not one more (T3: the count 「等你」 shows above). Only reported waits count (T1).
 * @param {readonly Node[]} nodes
 */
export function askingOf(nodes) {
  const tones = nodes.map(toneOf);
  const under = tones.slice(1).filter((k) => k === 'wait').length;
  return under > 0 ? under : tones[0] === 'wait' ? 1 : 0;
}

function foldFace(nodes, took, solid = false) {
  const tones = solid ? nodes.map(toneOf) : [];
  const asking = solid ? askingOf(nodes) : nodes.filter(waits).length;
  const errs = solid ? tones.filter((k) => k === 'err').length : nodes.filter(failed).length;
  return {
    n: { text: t('fold.n', { n: nodes.length }) },
    took: { text: took },
    fw: { text: t('fold.flagWait', { n: asking }), data: { hide: asking > 0 ? '0' : '1' } },
    fe: { text: t('fold.flagErr', { n: errs }), data: { hide: errs > 0 ? '0' : '1' } },
    ...marks(nodes),
  };
}

/**
 * A worker's card on the right: the folded card's face, its members the worker and all under it, a click a push to
 * its page instead of opening in place (no aria-expanded: it opens nothing here). `took` is how long it has been open,
 * as far as that is known. Its flags count the marks, as its page and the list's order do (T3).
 * @param {{ key: string, title: string, kind: string, took: string, members: readonly { node: Node, depth: number }[] }} o
 * @returns {import('./dom.js').Desc}
 */
export function describeRun(o) {
  const nodes = o.members.map((m) => m.node);
  return {
    key: o.key, tpl: 'tpl-run',
    slots: {
      b: { data: { run: o.key } },
      title: { text: o.title },
      kind: { text: o.kind },
      ...foldFace(nodes, o.took, true),
      n: { text: t('run.members', { n: nodes.length }) },
    },
  };
}
