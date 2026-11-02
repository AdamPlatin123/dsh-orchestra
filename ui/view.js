// @ts-check
// Pure descriptors of the stage preview (0.1 alpha design §6–§7): snapshot in, `{key, tpl, cls, data,
// attr, text, slots, kids}` out, for ui/dom.js to patch. Nothing here touches the DOM, the clock or
// the network, so node:test drives every function with the sample JSON.
// The truthfulness rules of §2 hold here: T1, T2 (D19), T3 (counts from view()), T4, T6.
import { STAGE_TEXT } from '../shared/strings.js';
import { kb, layoutStage } from './layout.js';

/**
 * @typedef {import('../shared/stage-contract.js').StageSnapshot} StageSnapshot
 * @typedef {import('../shared/stage-contract.js').Lane} Lane
 * @typedef {import('../shared/stage-contract.js').Player} Player
 * @typedef {import('../shared/stage-contract.js').WorkItem} WorkItem
 * @typedef {import('../shared/stage-contract.js').Rule} Rule
 * @typedef {import('../shared/stage-contract.js').SessionDetail} SessionDetail
 * @typedef {{ text?: string, cls?: string, data?: Record<string, string>, attr?: Record<string, string>,
 *   slots?: Record<string, Paint>, kids?: Desc[] }} Paint
 * @typedef {Paint & { key: string, tpl: string }} Desc
 * @typedef {{ time(ms: number): string, iso(s: string): string }} Fmt
 * @typedef {'sent' | 'running' | 'reported' | 'reviewed'} Chip
 */

/** The filter chips, in the order they show. */
export const CHIPS = /** @type {const} */ (['sent', 'running', 'reported', 'reviewed']);

/** @type {Readonly<Record<Chip, (w: WorkItem) => boolean>>} */
const CHIP_TEST = Object.freeze({
  sent: (w) => w.source !== 'todo',
  running: (w) => w.source !== 'todo' && w.state === 'working',
  reported: (w) => w.state === 'reported',
  // Reviewed needs a reviewer who did not write the work (D19); M0 has none, so no row ever qualifies.
  reviewed: (w) => w.verdict !== 'no-reviewer',
});

const PLAYING = ['busy', 'running', 'waiting'];
const TODO_GLYPH = Object.freeze({ pending: '○', in_progress: '◐', completed: '☑', other: '?' });
const DOT = Object.freeze({ pending: 'pending', in_progress: 'current', completed: 'selfchecked', other: 'other' });

/**
 * A STAGE_TEXT entry with its `{name}` placeholders filled; an unknown key shows itself, raw.
 * @param {string} key @param {Record<string, string | number>} [args]
 */
export function fill(key, args = {}) {
  const s = Object.hasOwn(STAGE_TEXT, key) ? STAGE_TEXT[key] : key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(args, k) ? String(args[k]) : m));
}

/**
 * Clips to `units` display columns (a wide character counts two), ending in … when cut.
 * @param {string} s @param {number} units
 */
export function clipW(s, units) {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) || ch.codePointAt(0) > 0x1ffff ? 2 : 1;
    if (used + w > units) return `${out}…`;
    used += w;
    out += ch;
  }
  return out;
}

/** Bytes for people: 940 字节, 1.2k 字节. @param {number} n */
export const bytes = (n) => fill('bytes', { n: kb(n) });

/** @param {StageSnapshot | null} snap @param {string | null} id @returns {Lane | null} */
export function pickLane(snap, id) {
  if (snap === null || snap.lanes.length === 0) return null;
  return snap.lanes.find((l) => l.id === id) ?? snap.lanes[0];
}

/**
 * The rows a chip stands for and their count, from the same array (T3).
 * @param {Lane} lane @param {Chip} chip
 */
export function view(lane, chip) {
  const rows = lane.items.filter(CHIP_TEST[chip]);
  return { count: rows.length, rows };
}

/** @param {Lane} lane */
function playing(lane) {
  const rows = lane.players.filter((p) => PLAYING.includes(p.live.state));
  return { count: rows.length, rows };
}

/** @param {Player} p */
const basisText = (p) => STAGE_TEXT[p.live.basis === 'registry' ? 'basis.registry' : p.live.basis === 'none' ? 'basis.none' : 'basis.inferred'];
/** @param {Player} p */
const liveText = (p) => `${STAGE_TEXT[`live.${p.live.state}`]}（${basisText(p)}）`;
/** The state, with what it waits for said once: 在等你：x（登记表）. @param {Player} p */
const liveWait = (p) => (p.live.waitingFor !== null ? `${fill('player.waiting', { w: p.live.waitingFor })}（${basisText(p)}）` : liveText(p));
/** @param {Player} p */
const eyes = (p) => (PLAYING.includes(p.live.state) ? 'open' : 'shut');

/** A figure with no player behind it: a ghost that plays nothing. */
const NOFIG = Object.freeze({ lineage: 'none', shade: '0', role: 'clone', look: 'ghost', instr: 'unknown', eyes: 'shut', basis: 'none' });

/** The figure's look, shared by stage seats, desk heads and row chibis. @param {Player} p */
function figure(p) {
  return { lineage: p.harness, shade: String(p.shade), role: p.role, look: p.look, instr: p.instrument.class, eyes: eyes(p), basis: p.live.basis };
}

/** What the music stand shows: the current todo, else the title, else why there is none. @param {Player} p */
export function plateText(p) {
  const st = p.stand;
  if (st.keys === 'mismatch') return STAGE_TEXT['stand.mismatch'];
  if (st.source === 'todo') {
    const cur = st.items.find((i) => i.status === 'in_progress') ?? st.items.find((i) => i.status === 'pending');
    return cur !== undefined ? cur.text : fill('desk.todo', { x: st.selfReported.checked, y: st.selfReported.total });
  }
  if (st.title !== null) return st.title;
  return STAGE_TEXT[`stand.${st.source === 'tail-miss' ? 'tail-miss' : 'none'}`];
}

// ---- header

/**
 * @param {StageSnapshot} snap @param {string | null} laneId
 * @param {{ stale: boolean, at: string }} fresh
 */
export function describeHeader(snap, laneId, fresh) {
  const lane = pickLane(snap, laneId);
  const test = snap.profile === 'test';
  const errs = /** @type {const} */ (['claude', 'dsh']).filter((h) => snap.sources[h].state === 'error');
  const a = lane === null ? 0 : playing(lane).count;
  const reported = lane === null ? 0 : view(lane, 'reported').count;
  const sent = lane === null ? 0 : view(lane, 'sent').count;
  return {
    title: `${test ? `${STAGE_TEXT['bar.test']} ` : ''}${STAGE_TEXT['page.title']}`,
    laneIndex: lane === null ? -1 : snap.lanes.indexOf(lane),
    counts: { a, b: lane === null ? 0 : lane.players.length, c: reported, d: sent },
    /** @type {Record<string, Paint>} */
    slots: {
      lane: { kids: snap.lanes.map((l) => ({ key: l.id, tpl: 'tpl-opt', text: l.basis === 'slug' ? `${l.name} ≈` : l.name, data: { lane: l.id } })) },
      approx: { data: { hide: lane !== null && lane.basis === 'slug' ? '0' : '1' } },
      players: { text: fill('bar.players', { a, b: lane === null ? 0 : lane.players.length }) },
      items: { text: fill('bar.items', { c: reported, d: sent }) },
      sources: {
        text: errs.length > 0
          ? errs.map((h) => fill('bar.srcError', { h, code: snap.sources[h].error ?? '' })).join('；')
          : fill('bar.sources', { c: snap.sources.claude.sessions, d: snap.sources.dsh.sessions }),
        data: { tone: errs.length > 0 ? 'warn' : '' },
      },
      fresh: { text: fill(fresh.stale ? 'bar.stale' : 'bar.fresh', { t: fresh.at }), data: { tone: fresh.stale ? 'warn' : '' } },
      test: { text: test ? STAGE_TEXT['bar.test'] : '', data: { hide: test ? '0' : '1' } },
    },
  };
}

// ---- stage

/**
 * Nameplate: the tag (harness and role, or role and agent type) and the label without the project,
 * which the header names; a label that is only the project gives way to the session key.
 * @param {Player} p @param {Lane} lane
 */
export function nameplate(p, lane) {
  const role = STAGE_TEXT[`role.${p.role}`];
  const tag = p.role === 'principal' ? `${STAGE_TEXT[`harness.${p.harness}`]} ${role}` : p.agentType !== null ? `${role}（${p.agentType}）` : role;
  const cut = p.label.indexOf(' · ');
  let name = p.label;
  if (cut > 0 && p.label.slice(0, cut) === lane.name) name = p.label.slice(cut + 3);
  else if (p.label === lane.name) name = p.session !== null ? fill('plate.session', { id: p.session.slice(0, 6) }) : STAGE_TEXT['dr.noSession'];
  return { tag, short: p.agentType ?? tag, name };
}

/** @param {Player} p @param {Lane} lane @param {import('./layout.js').Seat} seat @param {string | null} sel @param {Set<string>} fermatas @returns {Desc} */
function seatDesc(p, lane, seat, sel, fermatas) {
  const instr = STAGE_TEXT[`instr.${p.instrument.class}`];
  const plate = plateText(p);
  const np = nameplate(p, lane);
  // The nameplate is in viewBox units, so its width in columns follows the seat's cell.
  const room = Math.max(seat.w, 70) - 12;
  const tagW = Math.min(30, Math.floor(room / 6.6));
  /** @type {Record<string, Paint>} */
  const slots = {
    title: { text: fill('player.title', { label: p.label, role: STAGE_TEXT[`role.${p.role}`], instr, live: liveWait(p), plate }) },
    body: { attr: { transform: `scale(${seat.s})` } },
    plate: { text: clipW(plate, 9) },
    tag: { text: clipW(clipW(np.tag, tagW) === np.tag ? np.tag : np.short, tagW) },
    name: { text: clipW(np.name, Math.min(24, Math.floor(room / 8.8))) },
  };
  for (let i = 0; i < 12; i++) {
    const it = p.stand.items[i];
    slots[`d${i}`] = { data: { s: it === undefined ? 'off' : DOT[it.status] } };
  }
  return {
    key: p.id,
    tpl: 'tpl-player',
    data: { node: p.id, ...figure(p), fermata: fermatas.has(p.id) ? '1' : '0', sel: sel === p.id ? '1' : '0' },
    attr: { transform: `translate(${seat.x} ${seat.y})`, 'aria-current': sel === p.id ? 'true' : 'false' },
    slots,
  };
}

/**
 * The stage of one lane: seats, cue lines, overflow badges and the podium line.
 * @param {StageSnapshot} snap @param {string | null} laneId @param {string | null} sel
 * @returns {Record<string, Paint>}
 */
export function describeStage(snap, laneId, sel) {
  const lane = pickLane(snap, laneId);
  const podium = { text: fill('podium', { n: snap.podium.fermatas.length }), data: { n: String(snap.podium.fermatas.length) } };
  if (lane === null) return { risers: { kids: [] }, players: { kids: [] }, cues: { kids: [] }, more: { kids: [] }, podium, nolanes: { text: STAGE_TEXT['plan.noLanes'], data: { hide: '0' } } };
  const L = layoutStage(lane);
  const byId = new Map(lane.players.map((p) => [p.id, p]));
  const fermatas = new Set(snap.podium.fermatas);
  const selPlayer = sel !== null && sel.startsWith('w:') ? (lane.items.find((w) => w.id === sel)?.executor ?? null) : sel;
  return {
    // Back risers first, so the step in front paints over the one behind it.
    risers: {
      kids: [...L.risers].sort((x, y) => y.row - x.row).map((r) => ({
        key: `${r.section}|${r.row}`,
        tpl: 'tpl-riser',
        data: { lineage: r.section },
        slots: { face: { attr: { transform: `translate(${r.x} ${r.y}) scale(${r.w} ${r.h})` } }, lip: { attr: { transform: `translate(${r.x} ${r.y}) scale(${r.w} 1)` } } },
      })),
    },
    // Back rows first, so a figure in front paints over the riser behind it.
    players: { kids: [...L.seats].sort((x, y) => y.row - x.row).map((s) => seatDesc(/** @type {Player} */ (byId.get(s.id)), lane, s, selPlayer, fermatas)) },
    cues: {
      kids: L.cues.map((c) => ({
        key: `${c.item}|${c.kind}`,
        tpl: 'tpl-cue',
        data: { kind: c.kind, sel: sel === c.item ? '1' : '0' },
        slots: {
          glow: { attr: { x1: String(c.x1), y1: String(c.y1), x2: String(c.x2), y2: String(c.y2) } },
          line: { attr: { x1: String(c.x1), y1: String(c.y1), x2: String(c.x2), y2: String(c.y2) } },
          label: { text: c.label, attr: { x: String(Math.round((c.x1 + c.x2) / 2 + 10)), y: String(Math.round((c.y1 + c.y2) / 2)) } },
        },
      })),
    },
    more: { kids: L.overflow.map((o) => ({ key: o.section, tpl: 'tpl-more', attr: { transform: `translate(${o.x} ${o.y})` }, slots: { t: { text: fill('overflow', { n: o.n }) } } })) },
    podium,
    nolanes: { text: '', data: { hide: '1' } },
  };
}

// ---- plan

/** Log₂ bucket of the compression ratio, 0..8, for the funnel's width. @param {{ childBytes: number, reportBytes: number }} f */
export function flowBucket(f) {
  const r = f.childBytes / Math.max(f.reportBytes, 1);
  return String(Math.min(8, Math.max(0, Math.round(Math.log2(Math.max(r, 1))))));
}

/** @param {number} r */
const ratio = (r) => (r >= 10 ? String(Math.round(r)) : r.toFixed(1));

/** @param {WorkItem} w */
function flowText(w) {
  if (w.flow !== null) return fill('flow.line', { a: bytes(w.flow.childBytes), b: bytes(w.flow.reportBytes), r: ratio(w.flow.childBytes / Math.max(w.flow.reportBytes, 1)) });
  if (w.state === 'working') return STAGE_TEXT['flow.pending'];
  const u = STAGE_TEXT['flow.unknownSide'];
  return fill('flow.half', { a: u, b: w.report !== null ? bytes(w.report.bytes) : u });
}

/** @param {WorkItem} w @param {Fmt} fmt */
function reportText(w, fmt) {
  if (w.state === 'reported' && w.report !== null) return fill('rep.reported', { t: w.report.at !== null ? fmt.time(w.report.at) : STAGE_TEXT['rep.noTime'], b: bytes(w.report.bytes) });
  return STAGE_TEXT[w.state === 'working' ? 'rep.working' : w.state === 'orphan' ? 'rep.orphan' : w.state === 'self' ? 'rep.self' : 'rep.unknown'];
}

/**
 * One work item row: the four columns of §7 (brief, executor, report, verdict) plus the funnel.
 * @param {WorkItem | null} w @param {Player | null} ex @param {number} depth @param {string | null} sel
 * @param {{ n: number, d: number } | null} dept @param {Fmt} fmt @param {string} [key]
 * @returns {Desc}
 */
function rowDesc(w, ex, depth, sel, dept, fmt, key) {
  const fig = ex !== null ? figure(ex) : NOFIG;
  const node = w !== null ? w.id : /** @type {Player} */ (ex).id;
  const on = sel === node || (ex !== null && sel === ex.id);
  return {
    key: key ?? node,
    tpl: 'tpl-row',
    data: {
      node, ...fig, depth: String(Math.min(depth, 4)), state: w !== null ? w.state : 'orphan', sel: on ? '1' : '0',
      flow: w !== null && w.flow !== null ? flowBucket(w.flow) : 'none', dept: dept !== null ? '1' : '0',
    },
    slots: {
      brief: { text: w !== null ? w.brief : `${/** @type {Player} */ (ex).label}：${STAGE_TEXT['plan.noBrief']}`, attr: { 'aria-current': on ? 'true' : 'false' } },
      src: { text: w !== null ? STAGE_TEXT[`src.${w.source}`] : STAGE_TEXT['join.none'] },
      exName: { text: ex !== null ? ex.label : STAGE_TEXT['plan.noExec'] },
      exInstr: { text: ex !== null ? STAGE_TEXT[`instr.${ex.instrument.class}`] : STAGE_TEXT['instr.unknown'] },
      exLive: { text: ex !== null ? liveText(ex) : STAGE_TEXT['live.unknown'] },
      report: { text: w !== null ? reportText(w, fmt) : STAGE_TEXT['rep.orphan'] },
      flowText: { text: w !== null ? flowText(w) : fill('flow.half', { a: STAGE_TEXT['flow.unknownSide'], b: STAGE_TEXT['flow.unknownSide'] }) },
      verdict: { text: STAGE_TEXT['plan.verdict'] },
      dept: { text: dept !== null ? fill('plan.dept', dept) : '', data: { hide: dept !== null ? '0' : '1' } },
      deep: { data: { hide: dept !== null && dept.d > 2 ? '0' : '1' } },
    },
  };
}

/** @param {Player} p @param {string | null} sel @returns {Desc} */
function deskDesc(p, sel) {
  const st = p.stand;
  const goal = p.harness === 'dsh' && st.source === 'goal' && st.title !== null ? fill('desk.goal', { g: st.title }) : STAGE_TEXT['desk.noGoal'];
  const todo = st.source === 'todo' ? st.items : [];
  const { checked, total } = st.selfReported;
  let head = STAGE_TEXT['desk.noTodo'];
  if (st.source === 'todo') head = fill('desk.todo', { x: checked, y: total }) + (total > 0 && checked === total ? `，${STAGE_TEXT['desk.allChecked']}` : '');
  let note = '';
  if (st.keys === 'mismatch') note = fill('health.keys', { ids: `${p.harness}.stand` });
  else if (st.source === 'tail-miss') note = STAGE_TEXT['stand.tail-miss'];
  if (p.note !== null) note = note === '' ? STAGE_TEXT[`note.${p.note}`] : `${note}；${STAGE_TEXT[`note.${p.note}`]}`;
  return {
    key: p.id,
    tpl: 'tpl-desk',
    data: { node: p.id, ...figure(p), sel: sel === p.id ? '1' : '0' },
    slots: {
      name: { text: p.label, attr: { 'aria-current': sel === p.id ? 'true' : 'false' } },
      who: { text: `${STAGE_TEXT[`harness.${p.harness}`]} ${STAGE_TEXT['role.principal']}，${liveText(p)}` },
      goal: { text: goal, data: { tone: goal === STAGE_TEXT['desk.noGoal'] ? 'none' : '' } },
      todoHead: { text: head },
      todo: { kids: todo.map((it, i) => todoDesc(it, i)) },
      note: { text: note, data: { hide: note === '' ? '1' : '0' } },
    },
  };
}

/** @param {{ text: string, status: 'pending' | 'in_progress' | 'completed' | 'other' }} it @param {number} i @returns {Desc} */
function todoDesc(it, i) {
  return { key: String(i), tpl: 'tpl-todo', data: { s: it.status }, slots: { g: { text: TODO_GLYPH[it.status] }, t: { text: it.text }, st: { text: STAGE_TEXT[`todo.${it.status}`] } } };
}

/**
 * The rule list (T4): 未测（N=n） with class `untested` whatever the hits, or 字段对不上 when keys are missing.
 * @param {readonly Rule[]} rules @returns {Desc[]}
 */
export function describeRules(rules) {
  return rules.map((r) => {
    const bad = r.status === 'keys-mismatch';
    return {
      key: r.id,
      tpl: 'tpl-rule',
      cls: bad ? 'mismatch' : 'untested',
      data: { status: bad ? 'mismatch' : 'untested' },
      slots: { id: { text: r.id }, n: { text: bad ? STAGE_TEXT['rule.mismatch'] : fill('rule.untested', { n: r.n }) }, hits: { text: fill('rule.hits', { h: r.hits }) } },
    };
  });
}

/**
 * The plan view (分谱) of one lane: the leads' desks, the chips, the work item tree with departments
 * and the 未关联 bucket, the lane's context total, health and the rules. With a chip on, the list is
 * exactly that chip's rows, flat, so the chip's number and the rows shown are one array (T3).
 * @param {StageSnapshot} snap @param {string | null} laneId @param {Chip | null} chip
 * @param {string | null} sel @param {Fmt} fmt
 * @returns {{ rows: number, slots: Record<string, Paint> }}
 */
export function describePlan(snap, laneId, chip, sel, fmt) {
  const lane = pickLane(snap, laneId);
  const mismatch = snap.rules.filter((r) => r.status === 'keys-mismatch').map((r) => r.id);
  const srcErr = /** @type {const} */ (['claude', 'dsh']).filter((h) => snap.sources[h].state === 'error').map((h) => fill('health.src', { h, code: snap.sources[h].error ?? '' }));
  const health = [...(mismatch.length > 0 ? [fill('health.keys', { ids: mismatch.join(', ') })] : []), ...srcErr].join('；');
  const clippedN = snap.clipped.lanes + snap.clipped.players + snap.clipped.items + snap.clipped.standItems;
  /** @type {Record<string, Paint>} */
  const common = {
    health: { text: health, data: { hide: health === '' ? '1' : '0' } },
    clipped: { text: clippedN > 0 ? fill('clipped', { n: clippedN }) : '', data: { hide: clippedN > 0 ? '0' : '1' } },
    rules: { kids: describeRules(snap.rules) },
  };
  if (lane === null) {
    return { rows: 0, slots: { ...common, desk: { kids: [] }, chips: { kids: [] }, list: { kids: [] }, total: { text: '', data: { hide: '1' } }, empty: { text: STAGE_TEXT['plan.noLanes'], data: { hide: '0' } } } };
  }
  const byId = new Map(lane.players.map((p) => [p.id, p]));
  /** @param {string | null} id */
  const player = (id) => (id === null ? null : byId.get(id) ?? null);
  const chips = CHIPS.map((k) => ({
    key: k, tpl: 'tpl-chip', text: fill(`chip.${k}`, { n: view(lane, k).count }),
    data: { chip: k }, attr: { 'aria-pressed': chip === k ? 'true' : 'false' },
  }));

  /** @type {Desc[]} */
  const rows = [];
  let itemRows = 0;
  if (chip !== null) {
    for (const w of view(lane, chip).rows) rows.push(rowDesc(w, player(w.executor), 0, sel, null, fmt));
    itemRows = rows.length;
  } else {
    const sent = lane.items.filter((w) => w.source !== 'todo');
    const linked = sent.filter((w) => w.join !== null);
    const ids = new Set(linked.map((w) => w.id));
    const seen = new Set();
    /** @param {WorkItem} w */
    const children = (w) => linked.filter((x) => !seen.has(x.id) && x.id !== w.id && (x.parent === w.id || (w.executor !== null && x.owner === w.executor && (x.parent === null || !ids.has(x.parent)))));
    /** @param {WorkItem} w @param {number} depth */
    const emit = (w, depth) => {
      seen.add(w.id);
      const ex = player(w.executor);
      const kids = children(w);
      kids.forEach((k) => seen.add(k.id));
      rows.push(rowDesc(w, ex, depth, sel, kids.length > 0 && ex !== null ? { n: kids.length, d: ex.depth } : null, fmt));
      for (const k of kids) emit(k, depth + 1);
    };
    const executors = new Set(linked.map((w) => w.executor));
    for (const w of linked) if (!seen.has(w.id) && (w.parent === null || !ids.has(w.parent)) && !executors.has(w.owner)) emit(w, 0);
    for (const w of linked) if (!seen.has(w.id)) emit(w, 0);
    itemRows = rows.length;
    const loose = sent.filter((w) => w.join === null);
    const executing = new Set(lane.items.map((w) => w.executor));
    const strays = lane.players.filter((p) => p.role !== 'principal' && !executing.has(p.id));
    const n = loose.length + strays.length;
    if (n > 0) {
      rows.push({ key: 'h:unlinked', tpl: 'tpl-head', slots: { t: { text: fill('plan.unlinked', { n }) }, note: { text: STAGE_TEXT['plan.unlinkedNote'] } } });
      for (const w of loose) rows.push(rowDesc(w, player(w.executor), 0, sel, null, fmt));
      for (const p of strays) rows.push(rowDesc(null, p, 0, sel, null, fmt, `x:${p.id}`));
      itemRows += loose.length;
    }
  }
  const flows = lane.items.filter((w) => w.flow !== null);
  const sumChild = flows.reduce((s, w) => s + /** @type {{ childBytes: number }} */ (w.flow).childBytes, 0);
  const sumBack = flows.reduce((s, w) => s + /** @type {{ reportBytes: number }} */ (w.flow).reportBytes, 0);
  const emptyText = chip === 'reviewed' ? STAGE_TEXT['plan.emptyReviewed'] : chip !== null ? STAGE_TEXT['plan.emptyChip'] : STAGE_TEXT['plan.empty'];
  return {
    rows: itemRows,
    slots: {
      ...common,
      desk: { kids: lane.players.filter((p) => p.role === 'principal').map((p) => deskDesc(p, sel)) },
      chips: { kids: chips },
      list: { kids: rows },
      total: {
        text: flows.length > 0 ? fill('flow.total', { a: bytes(sumChild), b: bytes(sumBack), c: bytes(Math.max(0, sumChild - sumBack)), n: flows.length }) : '',
        data: { hide: flows.length > 0 ? '0' : '1' },
      },
      empty: { text: rows.length === 0 ? emptyText : '', data: { hide: rows.length === 0 ? '0' : '1' } },
    },
  };
}

// ---- drawer

/** @param {number} ms */
function age(ms) {
  if (ms < 60000) return fill('age.s', { n: Math.round(ms / 1000) });
  if (ms < 3600000) return fill('age.m', { n: Math.round(ms / 60000) });
  return fill('age.h', { n: Math.round(ms / 3600000) });
}

/** @param {string} k @param {string} v @param {string} [tone] @returns {Desc} */
const kv = (k, v, tone = '') => ({ key: k, tpl: 'tpl-kv', data: { tone }, slots: { k: { text: STAGE_TEXT[k] }, v: { text: v } } });

/**
 * The drawer of one player or work item: identity, the basis of its state, the instrument's evidence,
 * the rules with 未测（N=0）, the stand, the brief with its label, and the last events. `detail` is
 * null while the session is read, or `{ error }` when that failed. Null when the node is gone.
 * @param {StageSnapshot} snap @param {string | null} laneId @param {string} node
 * @param {SessionDetail | { error: string } | null} detail @param {Fmt} fmt @param {number} sinceMs ms since the snapshot arrived (T7)
 * @returns {{ session: string | null, slots: Record<string, Paint> } | null}
 */
export function describeDrawer(snap, laneId, node, detail, fmt, sinceMs) {
  const lane = pickLane(snap, laneId);
  if (lane === null) return null;
  const w = node.startsWith('w:') ? lane.items.find((x) => x.id === node) ?? null : null;
  const pid = w !== null ? w.executor ?? w.owner : node;
  const p = lane.players.find((x) => x.id === pid) ?? null;
  if (p === null && w === null) return null;
  const rule = (/** @type {string} */ id) => {
    const r = snap.rules.find((x) => x.id === id);
    if (r === undefined) return `${id}：${fill('rule.untested', { n: 0 })}`;
    return `${id}：${r.status === 'keys-mismatch' ? STAGE_TEXT['rule.mismatch'] : fill('rule.untested', { n: r.n })}，${fill('rule.hits', { h: r.hits })}`;
  };
  /** @type {Desc[]} */
  const facts = [];
  if (p !== null) {
    const who = `${STAGE_TEXT[`harness.${p.harness}`]} ${STAGE_TEXT[`role.${p.role}`]}${p.agentType !== null ? `（${p.agentType}）` : ''}，${fill('dr.depth', { d: p.depth })}`;
    facts.push(kv('dr.who', who));
    facts.push(kv('dr.session', p.session === null ? STAGE_TEXT['dr.noSession'] : `${p.session.slice(0, 8)}（${bytes(p.bytes)}）${p.note !== null ? `，${STAGE_TEXT[`note.${p.note}`]}` : ''}`, p.note !== null ? 'warn' : ''));
    const ageText = p.live.ageMs !== null ? `，${age(p.live.ageMs + sinceMs)}` : '';
    facts.push(kv('dr.live', `${liveWait(p)}${ageText}`, p.live.state === 'waiting' ? 'warn' : ''));
    facts.push(kv('dr.look', `${STAGE_TEXT[`look.${p.look}`]}（${p.lookRule}）`));
    const ins = p.instrument;
    facts.push(kv('dr.instr', `${STAGE_TEXT[`instr.${ins.class}`]}${ins.role !== null ? `（${ins.role}）` : ''}；${fill('dr.instrLine', { n: ins.window, r: ins.read, w: ins.write, s: ins.shell })}`));
    facts.push(kv('dr.rule', rule('instrument.tool-map')));
  }
  if (w !== null) {
    facts.push(kv('dr.report', `${reportText(w, fmt)}；${flowText(w)}`));
    facts.push(kv('dr.verdict', STAGE_TEXT['plan.verdict']));
    facts.push(kv('dr.join', `${STAGE_TEXT[w.join === null ? 'join.none' : `join.${w.join}`]}；${rule(w.stateRule)}`, w.join === null ? 'warn' : ''));
  }
  const session = p !== null ? p.session : null;
  /** @type {Desc[]} */
  let events = [];
  let evNote = '';
  if (session === null) evNote = STAGE_TEXT['dr.noSession'];
  else if (detail === null) evNote = STAGE_TEXT['dr.loading'];
  else if ('error' in detail) evNote = fill('dr.err', { code: detail.error });
  else {
    events = detail.events.slice(-50).map((e, i) => ({ key: String(i), tpl: 'tpl-ev', slots: { at: { text: e.at !== null ? fmt.iso(e.at) : '--:--:--' }, ty: { text: e.type }, tx: { text: e.text } } }));
    const bits = [...(events.length === 0 ? [STAGE_TEXT['dr.noEvents']] : []), ...(detail.unparsed > 0 ? [fill('dr.unparsed', { n: detail.unparsed })] : []), ...(detail.note !== null && Object.hasOwn(STAGE_TEXT, `note.${detail.note}`) ? [STAGE_TEXT[`note.${detail.note}`]] : [])];
    evNote = bits.join('；');
  }
  const brief = w !== null ? w.brief : p !== null && p.stand.source === 'task-brief' ? p.stand.title : null;
  const stand = p !== null ? p.stand.items : [];
  return {
    session,
    slots: {
      head: { data: p !== null ? figure(p) : NOFIG },
      title: { text: p !== null ? p.label : w !== null ? w.brief : '' },
      sub: { text: p !== null ? `${STAGE_TEXT[`instr.${p.instrument.class}`]}，${liveWait(p)}` : '' },
      facts: { kids: facts },
      briefBox: { data: { hide: brief === null ? '1' : '0' } },
      brief: { text: brief ?? '' },
      standBox: { data: { hide: stand.length === 0 ? '1' : '0' } },
      standHead: { text: p !== null && p.stand.source === 'todo' ? fill('desk.todo', { x: p.stand.selfReported.checked, y: p.stand.selfReported.total }) : STAGE_TEXT['dr.stand'] },
      stand: { kids: stand.map((it, i) => todoDesc(it, i)) },
      events: { kids: events },
      evNote: { text: evNote, data: { hide: evNote === '' ? '1' : '0' } },
      peek: { data: { hide: session === null ? '1' : '0' } },
    },
  };
}
