// @ts-check
// Pure descriptors of the graph, task list and drawer (0.1 alpha design §6–§7) for ui/dom.js to patch;
// no DOM, clock or network. Truthfulness rules T1–T4 and T6 of §2 hold here.
import { STAGE_TEXT } from '../shared/strings.js';
import { SCORE, groupItems, groupPlayers, handedOn, kb, layoutScore } from './layout.js';

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
  // Needs a reviewer who did not write the work (D19); M0 has none.
  reviewed: (w) => w.verdict !== 'no-reviewer',
});

const PLAYING = ['busy', 'running', 'waiting'];
const TODO_GLYPH = Object.freeze({ pending: '○', in_progress: '◐', completed: '☑', other: '?' });

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

/** Display columns of a string, as clipW counts them: a wide character is two. @param {string} s */
export const cols = (s) => [...s].reduce((n, ch) => n + (clipW(ch, 1) === ch ? 1 : 2), 0);

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
/** What a member waits for, in plain words when the source's wording is known. @param {string | null} w */
const waitWord = (w) => (w === null ? STAGE_TEXT['live.unknown'] : Object.hasOwn(STAGE_TEXT, `waitFor.${w}`) ? STAGE_TEXT[`waitFor.${w}`] : w);
/** The state, with what it waits for said once. @param {Player} p */
const liveWait = (p) => (p.live.waitingFor !== null ? `${fill('player.waiting', { w: waitWord(p.live.waitingFor) })}（${basisText(p)}）` : liveText(p));
/** A rule's plain name; the raw id only when none is written. @param {string} id */
const ruleName = (id) => (Object.hasOwn(STAGE_TEXT, `rn.${id}`) ? STAGE_TEXT[`rn.${id}`] : id);
/** Whether a reported item's size is known: a DSH team task logs the status change, not the report. @param {WorkItem} w */
const sized = (w) => w.report !== null && w.source !== 'team-task';
/** No player behind a mark: no lineage, no instrument. */
const NOFIG = Object.freeze({ lineage: 'none', role: 'clone', look: 'ghost', instr: 'unknown', basis: 'none' });

/** A player's marks, shared by staff heads, desks, rows and the drawer: each one a field (T1). @param {Player} p */
function figure(p) {
  return { lineage: p.harness, role: p.role, look: p.look, instr: p.instrument.class, basis: p.live.basis };
}

/** What the music stand shows: the current todo, else the title, else why there is none. @param {Player} p */
export function plateText(p) {
  const st = p.stand;
  if (st.keys === 'mismatch') return STAGE_TEXT['stand.mismatch'];
  if (st.source === 'todo') {
    const cur = st.items.find((i) => i.status === 'in_progress') ?? st.items.find((i) => i.status === 'pending');
    return cur !== undefined ? cur.text : fill('stand.todo', { x: st.selfReported.checked, y: st.selfReported.total });
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

// ---- score

/**
 * Nameplate: the tag and the label without the project; a bare project label gives way to the session.
 * @param {Player} p @param {Lane} lane
 */
export function nameplate(p, lane) {
  const role = STAGE_TEXT[`role.${p.role}`];
  const tag = p.role === 'principal' ? `${STAGE_TEXT[`harness.${p.harness}`]} ${role}` : p.agentType !== null ? `${role}（${p.agentType}）` : role;
  const cut = p.label.indexOf(' · ');
  let name = p.label;
  if (cut > 0 && p.label.slice(0, cut) === lane.name) name = p.label.slice(cut + 3);
  else if (p.label === lane.name) name = p.session !== null ? fill('plate.session', { id: p.session.slice(0, 6) }) : STAGE_TEXT['dr.noSession'];
  return { tag, name };
}

/** The harnesses that can have a system on the score; Codex is static and says 未接入. */
export const GROUPS = /** @type {const} */ (['claude', 'dsh']);

/**
 * How one group works together, every number the length of a list returned beside it (T3).
 * @param {Lane} lane @param {string} harness @param {readonly string[]} fermatas
 */
export function groupSummary(lane, harness, fermatas) {
  const players = groupPlayers(lane, harness);
  const sent = groupItems(lane, harness);
  const clones = players.filter((p) => p.role === 'clone');
  const teammates = players.filter((p) => p.role === 'teammate');
  const depts = players.filter((p) => p.role !== 'principal' && handedOn(sent, p.id).length > 0);
  /** @param {WorkItem['state']} s */
  const by = (s) => sent.filter((w) => w.state === s);
  const lists = {
    players, clones, teammates, depts, sent,
    working: by('working'), reported: by('reported'), orphan: by('orphan'), unknown: by('unknown'),
    flows: sent.filter((w) => w.flow !== null),
    waiting: players.filter((p) => fermatas.includes(p.id)),
  };
  const form = teammates.length > 0 ? 'team' : clones.length > 0 ? 'tree' : 'solo';
  /** @param {string} k @param {readonly unknown[]} l */
  const part = (k, l) => (l.length > 0 ? [fill(k, { n: l.length })] : []);
  const crew = [...part('grp.teammates', teammates), ...part('grp.clones', clones), ...part('grp.depts', depts)];
  const how = [...part('grp.working', lists.working), ...part('grp.reported', lists.reported), ...part('grp.orphan', lists.orphan), ...part('grp.unknown', lists.unknown)];
  const work = sent.length === 0 ? STAGE_TEXT['grp.noSent'] : `${fill('grp.sent', { n: sent.length })}${how.length > 0 ? `：${how.join('，')}` : ''}`;
  const child = lists.flows.reduce((s, w) => s + /** @type {{ childBytes: number }} */ (w.flow).childBytes, 0);
  const back = lists.flows.reduce((s, w) => s + /** @type {{ reportBytes: number }} */ (w.flow).reportBytes, 0);
  const r = child / Math.max(back, 1);
  const flow = lists.flows.length > 0 ? [fill(r >= 10 ? 'grp.flow' : 'grp.flowPct', { r: Math.round(r), p: Math.round(100 / r), n: lists.flows.length })] : [];
  const text = [crew.length > 0 ? crew.join('，') : STAGE_TEXT['grp.alone'], work, ...flow, ...part('grp.wait', lists.waiting)].join('；');
  return { form, lists, text };
}

/** A work item's state in a word, with no sizes. @param {WorkItem} w */
const stateWord = (w) => STAGE_TEXT[w.state === 'reported' ? 'ph.reported' : w.state === 'working' ? 'rep.working' : w.state === 'orphan' ? 'rep.orphan' : w.state === 'self' ? 'rep.self' : 'rep.unknown'];

/** What a bar says under itself. @param {WorkItem} w */
function caption(w) {
  if (w.flow !== null) return fill('ph.flow', { a: kb(w.flow.childBytes), b: kb(w.flow.reportBytes) });
  if (w.state === 'reported' && w.report !== null) return sized(w) ? fill('ph.report', { b: kb(w.report.bytes) }) : STAGE_TEXT['ph.reportUnknown'];
  return STAGE_TEXT[w.state === 'working' ? 'ph.running' : 'ph.size'];
}

/** @param {number} x @param {number} y @param {number} [sx] @param {number} [sy] */
const tf = (x, y, sx, sy) => `translate(${x} ${y})${sx === undefined ? '' : ` scale(${sx} ${sy})`}`;
const HIDE = Object.freeze({ data: Object.freeze({ hide: '1' }) });
export const NOTES = 6; // bars with notes, at most, a page
/** One of four note drifts, fixed by the id. @param {string} id */
export const noteOf = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return String(h % 4 + 1); };

/**
 * The row label of one player: icon, name and tag (or what it handed on, with its bracket).
 * @param {import('./layout.js').Staff} st @param {Lane} lane @param {string | null} sel
 * @param {{ x: number, y0: number, y1: number } | undefined} dept @param {number} n @returns {Desc}
 */
function headDesc(st, lane, sel, dept, n) {
  if (st.player === null) return { key: st.id, tpl: 'tpl-uhead', text: STAGE_TEXT['row.unknown'], attr: { x: String(st.x + 22), y: String(st.y - 6) } };
  const p = st.player;
  const np = nameplate(p, lane);
  const room = SCORE.head - st.x - 26;
  const role = p.role === 'principal' ? np.tag : `${STAGE_TEXT[`role.${p.role}`]}${p.agentType !== null ? `（${p.agentType}）` : ''}`;
  const tag = dept !== undefined ? fill('plan.dept', { n, d: p.depth }) : `${role}，${STAGE_TEXT[`live.${p.live.state}`]}`;
  const on = sel === p.id;
  const tx = String(st.x + 22);
  return {
    key: p.id,
    tpl: 'tpl-shead',
    data: { node: p.id, ...figure(p), sel: on ? '1' : '0' },
    attr: { 'aria-current': on ? 'true' : 'false' },
    slots: {
      title: { text: fill('player.title', { label: p.label, role: STAGE_TEXT[`role.${p.role}`], instr: STAGE_TEXT[`instr.${p.instrument.class}`], look: STAGE_TEXT[`look.${p.look}`], live: liveWait(p), plate: plateText(p) }) },
      hit: { attr: { transform: tf(0, st.y - SCORE.row / 2, SCORE.head, SCORE.row) } },
      ins: { attr: { transform: tf(st.x, st.y - 21) } },
      name: { text: clipW(np.name, Math.floor(room / 6.8)), attr: { x: tx, y: String(st.y - 6) } },
      tag: { text: clipW(tag, Math.floor(room / 5.6)), attr: { x: tx, y: String(st.y + 15) } },
      hline: { attr: { x1: tx, y1: String(st.y), x2: String(SCORE.head), y2: String(st.y) } },
      dept: dept !== undefined ? { data: { hide: '0' }, attr: { transform: tf(dept.x, dept.y0, 5, dept.y1 - dept.y0) } } : HIDE,
    },
  };
}

/**
 * One work item: its bar with state above and sizes below, its dispatch and report arrows.
 * @param {import('./layout.js').Phrase} ph @param {Map<string, Player>} byId @param {string} group @param {string | null} sel
 * @param {() => boolean} more @returns {Desc}
 */
function phraseDesc(ph, byId, group, sel, more) {
  const w = ph.item;
  const ex = w.executor !== null ? byId.get(w.executor) ?? null : null;
  const on = sel === w.id;
  const y = String(ph.y);
  const cap = caption(w);
  const sl = ph.slur;
  const tie = ph.tie;
  const up = tie !== null && tie.dy > 0 ? -90 : 90;
  const live = ph.kind === 'open' && ex !== null && ex.live.basis === 'registry' && ex.look === 'solid';
  const notes = live && more() ? noteOf(w.id) : '0';
  return {
    key: w.id,
    tpl: 'tpl-phrase',
    data: {
      node: w.id, lineage: ex !== null ? ex.harness : group, state: w.state, kind: ph.kind, sel: on ? '1' : '0',
      breathe: live ? '1' : '0', notes,
    },
    attr: { 'aria-current': on ? 'true' : 'false' },
    slots: {
      title: { text: fill('ph.title', { brief: w.brief, state: stateWord(w), flow: flowText(w) }) },
      hit: { attr: { transform: tf(ph.x1 - 7, ph.y - 24, Math.max(ph.tail - ph.x1, cols(cap) * 6) + 14, 48) } },
      st: { text: stateWord(w), attr: { x: String(ph.x1), y: String(ph.y - 9) } },
      notes: notes !== '0' ? { attr: { transform: tf(ph.tail + 3, ph.y - 5) } } : {},
      tail: ph.kind === 'open' ? { data: { hide: '0' }, attr: { x1: String(ph.x2), y1: y, x2: String(ph.tail), y2: y } } : HIDE,
      body: { attr: { x1: String(ph.x1), y1: y, x2: String(ph.x2), y2: y } },
      cap: { text: cap, data: { hide: cap === '' ? '1' : '0' }, attr: { x: String(ph.x1 - 3), y: String(ph.y + 19) } },
      slur: sl !== null ? { data: { hide: '0' }, attr: { transform: tf(sl.x, sl.y, sl.dx, sl.dy) } } : HIDE,
      sah: sl !== null ? { data: { hide: '0' }, attr: { transform: tf(ph.x1 - 7, ph.y) } } : HIDE,
      slab: sl !== null ? { data: { hide: '0' }, attr: { x: String(sl.x + 4), y: String(sl.y + (sl.dy > 0 ? 15 : -6)) } } : HIDE,
      dot: sl !== null ? { data: { hide: '0' }, attr: { transform: tf(sl.x, sl.y) } } : HIDE,
      tie: tie !== null ? { data: { hide: '0', w: String(tie.w) }, attr: { transform: tf(tie.x, tie.y, tie.dx, tie.dy) } } : HIDE,
      tah: tie !== null ? { data: { hide: '0', w: String(tie.w) }, attr: { transform: `${tf(tie.x + tie.dx, tie.y - Math.sign(tie.dy) * 6)} rotate(${up}) scale(${1 + (tie.w - 1) / 6})` } } : HIDE,
    },
  };
}

/**
 * The graph of one lane: the waits on the 你 row, then one block per group.
 * @param {StageSnapshot} snap @param {string | null} laneId @param {string | null} sel
 * @returns {Record<string, Paint>}
 */
export function describeScore(snap, laneId, sel) {
  const f = snap.podium.fermatas;
  const everyone = snap.lanes.flatMap((l) => l.players);
  const waits = f.map((id) => {
    const p = everyone.find((x) => x.id === id);
    const text = p !== undefined ? fill('wait.one', { who: clipW(p.label, 40), w: clipW(waitWord(p.live.waitingFor), 40) }) : STAGE_TEXT['wait.lost'];
    return { key: id, tpl: 'tpl-wait', data: { wait: p !== undefined ? id : '' }, slots: { t: { text } } };
  });
  const podium = { text: fill('podium', { n: f.length }), data: { n: String(f.length) } };
  const lane = pickLane(snap, laneId);
  if (lane === null) return { waits: { kids: waits }, podium, systems: { kids: [] }, nolanes: { text: STAGE_TEXT['plan.noLanes'], data: { hide: '0' } } };
  const byId = new Map(lane.players.map((p) => [p.id, p]));
  let noted = 0;
  const systems = GROUPS.filter((h) => lane.players.some((p) => p.harness === h)).map((h) => {
    const L = layoutScore(lane, h, f);
    const sum = groupSummary(lane, h, f);
    const depts = new Map(L.depts.map((d) => [d.id, d]));
    const box = (/** @type {number} */ w) => ({ attr: { width: String(w), height: String(L.h), viewBox: `0 0 ${w} ${L.h}` } });
    /** @type {Desc} */
    const desc = {
      key: h,
      tpl: 'tpl-system',
      data: { lineage: h, form: sum.form },
      slots: {
        sysName: { text: STAGE_TEXT[`harness.${h}`] },
        sysForm: { text: STAGE_TEXT[`grp.${sum.form}`] },
        sysLine: { text: sum.text },
        hsvg: box(SCORE.head),
        msvg: box(L.w),
        brace: { attr: { transform: tf(4, L.brace.y0, 1, L.brace.y1 - L.brace.y0) } },
        heads: { kids: L.staves.map((st) => headDesc(st, lane, sel, depts.get(st.id), handedOn(lane.items, st.id).length)) },
        staves: {
          kids: L.staves.map((st) => {
            const empty = st.player !== null && st.player.role !== 'principal' && !L.phrases.some((p) => p.staff === st.id);
            return {
              key: st.id,
              tpl: 'tpl-staff',
              data: { lineage: st.player !== null ? h : 'none', look: st.player !== null ? st.player.look : 'ghost', sel: sel === st.id ? '1' : '0' },
              slots: {
                line: { attr: { x1: '0', y1: String(st.y), x2: String(L.w), y2: String(st.y) } },
                note: { text: empty ? STAGE_TEXT['plan.noBrief'] : '', data: { hide: empty ? '0' : '1' }, attr: { x: String(SCORE.lead), y: String(st.y - 7) } },
              },
            };
          }),
        },
        ords: { kids: L.cols.map((c) => ({ key: String(c.n), tpl: 'tpl-ord', text: fill('score.col', { n: c.n }), attr: { x: String(c.x), y: '17' } })) },
        phrases: { kids: L.phrases.map((ph) => phraseDesc(ph, byId, h, sel, () => noted++ < NOTES)) },
        ferms: {
          kids: L.ferms.map((m) => {
            const p = /** @type {Player} */ (byId.get(m.id));
            const t = fill('wait.badge', { w: clipW(waitWord(p.live.waitingFor), 20) });
            return {
              key: m.id, tpl: 'tpl-ferm', data: { node: m.id }, attr: { transform: tf(m.x, m.y) },
              slots: { title: { text: liveWait(p) }, bg: { attr: { width: String(Math.round(cols(t) * 6.6 + 16)) } }, t: { text: t } },
            };
          }),
        },
      },
    };
    return desc;
  });
  return { waits: { kids: waits }, podium, systems: { kids: systems }, nolanes: { text: '', data: { hide: '1' } } };
}

// ---- plan

/** Log₂ bucket of the compression ratio, 0..8, for the funnel's width. @param {{ childBytes: number, reportBytes: number }} f */
export function flowBucket(f) {
  const r = f.childBytes / Math.max(f.reportBytes, 1);
  return String(Math.min(8, Math.max(0, Math.round(Math.log2(Math.max(r, 1))))));
}

/** @param {WorkItem} w */
function flowText(w) {
  if (w.flow !== null) {
    const r = w.flow.childBytes / Math.max(w.flow.reportBytes, 1);
    return fill(r >= 10 ? 'flow.line' : 'flow.linePct', { a: bytes(w.flow.childBytes), b: bytes(w.flow.reportBytes), r: Math.round(r), p: Math.round(100 / r) });
  }
  if (w.state === 'working') return STAGE_TEXT['flow.pending'];
  const u = STAGE_TEXT['flow.unknownSide'];
  return fill('flow.half', { a: u, b: sized(w) ? bytes(/** @type {{ bytes: number }} */ (w.report).bytes) : u });
}

/** @param {WorkItem} w @param {Fmt} fmt */
function reportText(w, fmt) {
  if (w.state === 'reported' && w.report !== null) return fill('rep.reported', { t: w.report.at !== null ? fmt.time(w.report.at) : STAGE_TEXT['rep.noTime'], b: sized(w) ? bytes(w.report.bytes) : STAGE_TEXT['ph.reportUnknown'] });
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
  if (st.keys === 'mismatch') note = fill('health.keys', { ids: `${STAGE_TEXT[`harness.${p.harness}`]} ${STAGE_TEXT['dr.stand']}` });
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
 * The rule list (T4): 没测过（n 个样本） with class `untested` whatever the hits, or a format mismatch.
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
      slots: { id: { text: ruleName(r.id) }, n: { text: bad ? STAGE_TEXT['rule.mismatch'] : fill('rule.untested', { n: r.n }) }, hits: { text: fill('rule.hits', { h: r.hits }) } },
    };
  });
}

/**
 * The task list (任务清单) of one lane. With a chip on, the list is exactly that chip's rows (T3).
 * @param {StageSnapshot} snap @param {string | null} laneId @param {Chip | null} chip
 * @param {string | null} sel @param {Fmt} fmt
 * @returns {{ rows: number, slots: Record<string, Paint> }}
 */
export function describePlan(snap, laneId, chip, sel, fmt) {
  const lane = pickLane(snap, laneId);
  const mismatch = snap.rules.filter((r) => r.status === 'keys-mismatch').map((r) => r.id);
  const srcErr = /** @type {const} */ (['claude', 'dsh']).filter((h) => snap.sources[h].state === 'error').map((h) => fill('health.src', { h, code: snap.sources[h].error ?? '' }));
  const health = [...(mismatch.length > 0 ? [fill('health.keys', { ids: mismatch.map(ruleName).join('、') })] : []), ...srcErr].join('；');
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
    const seen = new Set();
    // A row nests what its executor handed on: the list the score counts.
    /** @param {WorkItem} w */
    const children = (w) => handedOn(linked, w.executor).filter((x) => !seen.has(x.id) && x.id !== w.id);
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
    for (const w of linked) if (!seen.has(w.id) && !executors.has(w.owner)) emit(w, 0);
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
 * The drawer of one player or work item; `detail` is null while loading. Null when the node is gone.
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
    if (r === undefined) return `${ruleName(id)}：${fill('rule.untested', { n: 0 })}`;
    return `${ruleName(id)}：${r.status === 'keys-mismatch' ? STAGE_TEXT['rule.mismatch'] : fill('rule.untested', { n: r.n })}，${fill('rule.hits', { h: r.hits })}`;
  };
  /** @type {Desc[]} */
  const facts = [];
  if (p !== null) {
    const who = `${STAGE_TEXT[`harness.${p.harness}`]} ${STAGE_TEXT[`role.${p.role}`]}${p.agentType !== null ? `（${p.agentType}）` : ''}，${fill('dr.depth', { d: p.depth })}`;
    facts.push(kv('dr.who', who));
    facts.push(kv('dr.session', p.session === null ? STAGE_TEXT['dr.noSession'] : `${p.session.slice(0, 8)}（${bytes(p.bytes)}）${p.note !== null ? `，${STAGE_TEXT[`note.${p.note}`]}` : ''}`, p.note !== null ? 'warn' : ''));
    const ageText = p.live.ageMs !== null ? `，${age(p.live.ageMs + sinceMs)}` : '';
    facts.push(kv('dr.live', `${liveWait(p)}${ageText}`, p.live.state === 'waiting' ? 'warn' : ''));
    facts.push(kv('dr.look', STAGE_TEXT[`look.${p.look}`]));
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
      standHead: { text: p !== null && p.stand.source === 'todo' ? fill('stand.todo', { x: p.stand.selfReported.checked, y: p.stand.selfReported.total }) : STAGE_TEXT['dr.stand'] },
      stand: { kids: stand.map((it, i) => todoDesc(it, i)) },
      events: { kids: events },
      evNote: { text: evNote, data: { hide: evNote === '' ? '1' : '0' } },
      peek: { data: { hide: session === null ? '1' : '0' } },
    },
  };
}
