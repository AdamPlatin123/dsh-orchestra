// @ts-check
// The collaboration graph (协作图) of one group in one lane (0.1 alpha design §6, plain-language pass):
// pure geometry, same lane in, same marks out. Identifiers keep the score's names (staff = a member's
// row, phrase = a work bar, slur = the dispatch arrow, tie = the report arrow, fermata = the 等你 badge).
// One row per player of the group, principals first and members below in parent order, indented by
// depth. One column per work item handed out, in the order the lane records them. A bar sits on its
// executor's row and grows with log2 of the context the executor read (flow.childBytes); a dispatch
// cue draws an arrow down from the owner's row, a report cue an arrow back up whose weight grows with
// log2 of the report's bytes. No flow, no length: the bar is a short stub that says 未知.
import { frozen } from '../shared/frozen.js';

/** @typedef {import('../shared/stage-contract.js').Lane} Lane */
/** @typedef {import('../shared/stage-contract.js').Player} Player */
/** @typedef {import('../shared/stage-contract.js').WorkItem} WorkItem */
/** @typedef {{ id: string, player: Player | null, y: number, x: number }} Staff */
/** @typedef {{ x: number, y: number, dx: number, dy: number }} Arc */
/**
 * @typedef {{ item: WorkItem, col: number, staff: string, y: number, x0: number, x1: number, x2: number,
 *   kind: 'flow' | 'stub' | 'open', tail: number, slur: Arc | null, tie: (Arc & { w: number }) | null }} Phrase
 */

export const SCORE = frozen({
  /** Width of the staff-head column, its own SVG beside the scrolling music. */
  head: 224,
  row: 46,
  /** Height of the ordinal row above the first staff. */
  top: 28,
  col: 140,
  /** Music before the first column and after the last. */
  lead: 14,
  tail: 44,
  /** From a column's start (where the dispatch arrow leaves the owner) to its bar. */
  gap: 22,
  /** Width kept for a 等你 badge at a row's end. */
  badge: 200,
  stub: 18,
  min: 14,
  max: 96,
  indent: 12,
  /** Left edge of a depth-0 head, clear of the group's bracket. */
  x: 16,
});

const S = SCORE;

/** Compact bytes for a caption, ASCII only: 940, 1.2k, 48k, 3.1M. @param {number} n */
export function kb(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** Phrase length for the context a member read. @param {number} bytes */
export function phraseLen(bytes) {
  return Math.min(S.max, Math.max(S.min, Math.round(8 * Math.log2(Math.max(bytes, 1) / 64))));
}

/** Tie weight 1..4 for a report's bytes. @param {number} bytes */
export function tieWeight(bytes) {
  return Math.min(4, Math.max(1, Math.round(Math.log2(Math.max(bytes, 1)) / 4)));
}

/** The players of one group, principals first, each member after its parent. @param {Lane} lane @param {string} harness */
export function groupPlayers(lane, harness) {
  const mine = lane.players.filter((p) => p.harness === harness);
  const ids = new Set(mine.map((p) => p.id));
  /** @type {Map<string | null, Player[]>} */
  const kids = new Map();
  for (const p of mine) {
    const up = p.parent !== null && ids.has(p.parent) && p.parent !== p.id ? p.parent : null;
    kids.set(up, [...(kids.get(up) ?? []), p]);
  }
  const roots = kids.get(null) ?? [];
  /** @type {Player[]} */
  const out = [];
  const seen = new Set();
  /** @param {Player} p */
  const walk = (p) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
    for (const k of kids.get(p.id) ?? []) walk(k);
  };
  for (const p of [...roots.filter((r) => r.role === 'principal'), ...roots.filter((r) => r.role !== 'principal')]) walk(p);
  // A parent loop leaves players unreached; they still get a staff.
  for (const p of mine) walk(p);
  return out;
}

/** The work items a group handed out (todos stay on the lead's desk), in record order. @param {Lane} lane @param {string} harness */
export function groupItems(lane, harness) {
  const of = new Map(lane.players.map((p) => [p.id, p.harness]));
  return lane.items.filter((w) => w.source !== 'todo' && (of.get(w.owner) ?? (w.executor !== null ? of.get(w.executor) : undefined)) === harness);
}

/**
 * What a member handed on that the records link to an executor: the one list behind 部门：下派 n, on
 * the score and in 分谱 alike (T3). Items a member owns sit in its own group, so a lane's items and a
 * group's give the same list.
 * @param {readonly WorkItem[]} items @param {string | null} id
 */
export function handedOn(items, id) {
  return id === null ? [] : items.filter((w) => w.source !== 'todo' && w.join !== null && w.owner === id && w.executor !== id);
}

/**
 * @param {Lane} lane @param {string} harness @param {readonly string[]} fermatas
 * @returns {{ w: number, h: number, staves: Staff[], phrases: Phrase[], cols: { n: number, x: number }[],
 *   ferms: { id: string, x: number, y: number }[], depts: { id: string, x: number, y0: number, y1: number }[],
 *   brace: { y0: number, y1: number } }}
 */
export function layoutScore(lane, harness, fermatas) {
  const players = groupPlayers(lane, harness);
  const items = groupItems(lane, harness);
  const ids = new Set(players.map((p) => p.id));
  const base = Math.min(...players.map((p) => p.depth), 4);
  /** @type {Staff[]} */
  const staves = players.map((p, i) => ({ id: p.id, player: p, y: S.top + S.row * i + S.row / 2, x: S.x + S.indent * Math.min(Math.max(p.depth - base, 0), 4) }));
  // Items whose executor has no staff here sit on one grey 未关联 staff at the bottom.
  if (items.some((w) => w.executor === null || !ids.has(w.executor))) staves.push({ id: `u:${harness}`, player: null, y: S.top + S.row * staves.length + S.row / 2, x: S.x });
  const at = new Map(staves.map((s) => [s.id, s]));
  const cue = (/** @type {string} */ item, /** @type {string} */ kind) => lane.cues.some((c) => c.item === item && c.kind === kind);
  /** @type {Phrase[]} */
  const phrases = items.map((w, col) => {
    const st = /** @type {Staff} */ (at.get(w.executor !== null && ids.has(w.executor) ? w.executor : `u:${harness}`));
    const owner = at.get(w.owner);
    const x0 = S.lead + S.col * col;
    const x1 = x0 + S.gap;
    const kind = w.flow !== null ? 'flow' : w.state === 'working' ? 'open' : 'stub';
    const x2 = x1 + (w.flow !== null ? phraseLen(w.flow.childBytes) : S.stub);
    const linked = owner !== undefined && owner !== st;
    const slur = linked && cue(w.id, 'dispatch') ? { x: x0, y: owner.y, dx: S.gap - 9, dy: st.y - owner.y } : null;
    const back = w.report !== null ? w.report.bytes : w.flow !== null ? w.flow.reportBytes : 1;
    const tie = linked && cue(w.id, 'report') ? { x: x2, y: owner.y, dx: 12, dy: st.y - owner.y, w: tieWeight(back) } : null;
    return { item: w, col, staff: st.id, y: st.y, x0, x1, x2, kind, tail: kind === 'open' ? x0 + S.col - 22 : x2, slur, tie };
  });
  const edge = S.lead + S.col * items.length + 10;
  const ferms = staves
    .filter((s) => s.player !== null && fermatas.includes(s.id))
    .map((s) => {
      const mine = phrases.filter((p) => p.staff === s.id);
      return { id: s.id, x: mine.length > 0 ? Math.max(...mine.map((p) => p.tail)) + 14 : edge, y: s.y };
    });
  // A member that hands work on gets a bracket from its row to its last descendant's.
  const depts = staves
    .filter((s) => s.player !== null && s.player.role !== 'principal' && handedOn(items, s.id).length > 0)
    .map((s) => {
      let j = staves.indexOf(s);
      while (j + 1 < staves.length && staves[j + 1].player !== null && staves[j + 1].x > s.x) j++;
      return { id: s.id, x: s.x - 6, y0: s.y - 15, y1: staves[j].y + 15 };
    });
  const last = staves.length > 0 ? staves[staves.length - 1].y : S.top;
  return {
    w: Math.max(S.lead + S.col * Math.max(items.length, 1) + S.tail, ...ferms.map((m) => m.x + S.badge)),
    h: S.top + S.row * staves.length + 6,
    staves,
    phrases,
    cols: items.map((_, i) => ({ n: i + 1, x: S.lead + S.col * i + S.gap })),
    ferms,
    depts,
    brace: { y0: staves.length > 0 ? staves[0].y - 18 : S.top, y1: last + 18 },
  };
}
