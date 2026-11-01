// @ts-check
// Seats on the stage (0.1 alpha design §6): pure geometry over one lane, in the 1200×920 viewBox.
// Principals sit in front (row 0), clones on risers behind by depth (4 a riser, 12 a section; empty
// risers are not built). Rows scale to fill the section's height, capped by width and by the row in
// front; the rest become a `+n` badge. Cue lines run shoulder to shoulder; a report line carries its
// compression label (48k→1.2k). Same lane in, same seats out.
import { frozen } from '../shared/frozen.js';

/** @typedef {import('../shared/stage-contract.js').Lane} Lane */
/** @typedef {import('../shared/stage-contract.js').Player} Player */
/** @typedef {{ id: string, x: number, y: number, s: number, w: number, section: 'claude' | 'dsh', row: number }} Seat */
/** @typedef {{ x1: number, y1: number, x2: number, y2: number, kind: 'dispatch' | 'report', label: string, item: string }} CueLine */
/** @typedef {{ section: 'claude' | 'dsh', n: number, x: number, y: number }} Overflow */
/** @typedef {{ section: 'claude' | 'dsh', row: number, x: number, y: number, w: number, h: number }} Riser */

export const STAGE_GEOM = frozen({
  w: 1200,
  h: 920,
  sections: { claude: { x0: 40, x1: 420 }, dsh: { x0: 430, x1: 770 } },
  /** Feet line of row 0. DSH sits behind the podium, so its front row stands higher. */
  base: { claude: 866, dsh: 700 },
  /** No head rises above this line (the section plaques live there). */
  top: 126,
  /** Row weights, front to back: principals, risers 1–3. */
  weight: [1, 0.76, 0.68, 0.6],
  maxScale: { principal: 3, clone: 2.3 },
  perRow: 4,
  maxLeads: 2,
  maxClones: 12,
  /** A seat's box at s=1 around (x, y); the harp widens a principal's. */
  box: { x0: -18, x0Lead: -32, x1: 44, top: -74, feet: 2 },
  /** The nameplate's height under a seat, in viewBox units. */
  label: 36,
  /** Between a nameplate and the heads in front. */
  rowGap: 8,
  /** Deepest a riser's face drops toward the row in front. */
  riser: 84,
  /** Side padding of a seat inside its cell. */
  pad: 6,
  /** Where cue lines meet a figure, at s=1: shoulder height and the side offset clear of the hair. */
  chest: 36,
  shoulder: 22,
});

const G = STAGE_GEOM;

/** Compact bytes for a cue label, ASCII only: 940, 1.2k, 48k, 3.1M. @param {number} n */
export function kb(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** @param {number} v */
const round = (v) => Math.round(v * 10) / 10;

/** Left edge of a seat's box at s=1. @param {boolean} lead */
const left = (lead) => (lead ? G.box.x0Lead : G.box.x0);

/** The box a seat covers, nameplate included, for the overlap test. @param {Seat} s @param {boolean} lead */
export function seatBox(s, lead) {
  return { x0: s.x + left(lead) * s.s, x1: s.x + G.box.x1 * s.s, y0: s.y + G.box.top * s.s, y1: s.y + G.box.feet * s.s + G.label };
}

/**
 * Scales of a section's rows for a fill factor k: each row k·weight, capped by its width, its kind and
 * the row in front of it.
 * @param {{ n: number, lead: boolean, wt: number }[]} rows @param {number} width @param {number} k
 */
function scales(rows, width, k) {
  let prev = Infinity;
  return rows.map((r) => {
    const cap = Math.min((width / r.n - 2 * G.pad) / (G.box.x1 - left(r.lead)), r.lead ? G.maxScale.principal : G.maxScale.clone, prev);
    prev = Math.floor(Math.min(k * r.wt, cap) * 100) / 100;
    return prev;
  });
}

/** Height a stack of rows takes. @param {number[]} ss */
const stackH = (ss) => ss.reduce((h, s) => h + (G.box.feet - G.box.top) * s + G.label, 0) + G.rowGap * Math.max(0, ss.length - 1);

/**
 * @param {Lane} lane
 * @returns {{ seats: Seat[], cues: CueLine[], overflow: Overflow[], risers: Riser[] }}
 */
export function layoutStage(lane) {
  /** @type {Seat[]} */
  const seats = [];
  /** @type {Overflow[]} */
  const overflow = [];
  /** @type {Riser[]} */
  const risers = [];
  for (const section of /** @type {const} */ (['claude', 'dsh'])) {
    const sec = G.sections[section];
    const width = sec.x1 - sec.x0;
    const mine = lane.players.filter((p) => p.harness === section);
    const leads = mine.filter((p) => p.role === 'principal');
    const clones = mine.filter((p) => p.role !== 'principal');
    let more = Math.max(0, leads.length - G.maxLeads) + Math.max(0, clones.length - G.maxClones);
    /** @type {Player[][]} */
    const byRow = [[], [], [], []];
    for (const p of clones.slice(0, G.maxClones)) {
      // The riser of its depth, else the next free one behind it, else in front of it.
      const want = Math.min(Math.max(p.depth, 1), 3);
      const order = [want, ...[1, 2, 3].filter((r) => r > want), ...[3, 2, 1].filter((r) => r < want)];
      const r = order.find((k) => byRow[k].length < G.perRow);
      if (r === undefined) more++;
      else byRow[r].push(p);
    }
    const rows = [
      ...(leads.length > 0 ? [{ ps: leads.slice(0, G.maxLeads), lead: true, tier: 0 }] : []),
      ...byRow.slice(1).filter((r) => r.length > 0).map((ps, i) => ({ ps, lead: false, tier: i + 1 })),
    ];
    if (rows.length === 0) continue;
    const spec = rows.map((r) => ({ n: r.ps.length, lead: r.lead, wt: G.weight[r.tier] }));
    // The front row's nameplate rests on the base line plus its label; find the largest k that fits.
    const bottom = G.base[section] + G.label;
    let lo = 0.2;
    let hi = 8;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (stackH(scales(spec, width, mid)) <= bottom - G.top) lo = mid;
      else hi = mid;
    }
    const ss = scales(spec, width, lo);
    let floor = bottom;
    /** Feet line of the row in front, where a riser's face ends. */
    let front = G.base[section];
    rows.forEach((r, i) => {
      const s = ss[i];
      const y = round(floor - G.label - G.box.feet * s);
      const cell = width / r.ps.length;
      r.ps.forEach((p, j) => {
        // Centre each box in its cell; the box sits right of the seat point (the stand), so shift it back.
        const centre = sec.x0 + cell * (j + 0.5);
        seats.push({ id: p.id, x: round(centre - ((G.box.x1 + left(r.lead)) / 2) * s), y, s, w: round(cell), section, row: r.tier });
      });
      if (!r.lead) risers.push({ section, row: r.tier, x: sec.x0, y, w: width, h: round(Math.min(Math.max(front - y, 0), G.riser)) });
      front = y;
      floor = y + G.box.top * s - G.rowGap;
    });
    if (more > 0) overflow.push({ section, n: more, x: sec.x1 - 30, y: round(Math.max(floor - 10, G.top - 16)) });
  }
  const at = new Map(seats.map((s) => [s.id, s]));
  const items = new Map(lane.items.map((w) => [w.id, w]));
  /** @type {CueLine[]} */
  const cues = [];
  for (const c of lane.cues) {
    const a = at.get(c.from);
    const b = at.get(c.to);
    if (a === undefined || b === undefined) continue;
    // A cue leaves and meets each figure at the shoulder facing the other, clear of the head.
    /** @param {Seat} s @param {Seat} o */
    const side = (s, o) => s.x + (o.x > s.x + 4 ? G.shoulder : -G.shoulder) * s.s;
    const ax = side(a, b);
    const bx = side(b, a);
    const ay = a.y - G.chest * a.s;
    const by = b.y - G.chest * b.s;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Dispatch and report between the same two players run side by side, 12 units apart: they run in
    // opposite directions, so the same left-hand offset puts them on opposite sides.
    const off = 6;
    const w = items.get(c.item);
    const label = c.kind !== 'report' || w === undefined ? '' : w.flow !== null ? `${kb(w.flow.childBytes)}→${kb(w.flow.reportBytes)}` : w.report !== null ? kb(w.report.bytes) : '';
    cues.push({
      x1: round(ax - uy * off), y1: round(ay + ux * off),
      x2: round(bx - uy * off), y2: round(by + ux * off),
      kind: c.kind, label, item: c.item,
    });
  }
  return { seats, cues, overflow, risers };
}
