// @ts-check
// The stage preview's boot (0.1 alpha design §5), the one module with top-level effects: poll, hash
// route, clicks and keys; one render per frame while visible. Read only (r4:2051).
import { getSession, getStage, oneAtATime } from './api.js';
import { every, fmtClock, fmtIso, nowMono, onFrame } from './clock.js';
import { activates, makePatcher, outsideBox } from './dom.js';
import { getLane, getTheme, setLane, setTheme } from './prefs.js';
import { go, openPeek, parse } from './route.js';
import { CHIPS, describeDrawer, describeHeader, describePlan, describeScore, fill, pickLane } from './view.js';
import { STAGE_TEXT } from '../shared/strings.js';

/** @typedef {import('../shared/stage-contract.js').StageSnapshot} StageSnapshot */
/** @typedef {import('./view.js').Chip} Chip */

const POLL_MS = 5000;
const STALE_MS = 15000;
const fmt = { time: fmtClock, iso: fmtIso };
const dom = makePatcher(document);

const state = {
  /** @type {StageSnapshot | null} */ snap: null,
  /** Monotonic time of the last good answer. */ okMono: 0,
  route: parse(location.hash),
  /** @type {Chip | null} */ chip: null,
  theme: getTheme(),
  /** @type {{ id: string, rev: string, body: any } | null} */ detail: null,
  /** @type {string | null} */ error: null,
  queued: false,
};

/** @param {unknown} b @returns {b is StageSnapshot} */
const looksLikeStage = (b) => {
  const x = /** @type {any} */ (b);
  return typeof x === 'object' && x !== null && x.v === 1 && x.kind === 'stage-preview' && Array.isArray(x.lanes);
};

function laneId() {
  const lane = pickLane(state.snap, state.route.lane ?? getLane());
  return lane === null ? null : lane.id;
}

function schedule() {
  if (state.queued || document.hidden) return;
  state.queued = true;
  onFrame(() => {
    state.queued = false;
    render();
  });
}

function render() {
  const root = document.documentElement;
  dom.paint(root, { data: { theme: state.theme, view: state.route.view, ready: state.snap === null ? '0' : '1' } });
  dom.paintId('theme', { text: STAGE_TEXT[`theme.${state.theme}`] });
  for (const v of ['stage', 'plan']) dom.paintId(`tab-${v}`, { attr: { 'aria-pressed': state.route.view === v ? 'true' : 'false' } });
  dom.paintId('alert', { text: state.error ?? '', data: { hide: state.error === null ? '1' : '0' } });
  const snap = state.snap;
  if (snap === null) return;
  const lane = laneId();
  const stale = nowMono() - state.okMono > STALE_MS;
  // The time shown is the daemon's own observedAt; it turns amber when no answer came for 15 s (T7).
  const head = describeHeader(snap, lane, { stale, at: fmtClock(snap.observedAt) });
  dom.title(head.title);
  dom.paintId('bar', { slots: head.slots });
  dom.select(/** @type {HTMLSelectElement} */ (dom.byId('lane')), head.laneIndex);
  dom.paint(root, { data: { fresh: stale ? 'stale' : 'live' } });
  dom.paintId('stage', { slots: describeScore(snap, lane, state.route.node) });
  dom.paintId('plan', { slots: describePlan(snap, lane, state.chip, state.route.node, fmt).slots });
  const dlg = /** @type {HTMLDialogElement} */ (dom.byId('drawer'));
  const node = state.route.peek ? state.route.node : null;
  const d = node === null ? null : describeDrawer(snap, lane, node, detailFor(node), fmt, nowMono() - state.okMono);
  if (d !== null) dom.paint(dlg, { slots: d.slots });
  dom.drawer(dlg, d !== null);
}

/** The session detail for the open drawer, read once per session and snapshot revision. @param {string} node */
function detailFor(node) {
  const snap = /** @type {StageSnapshot} */ (state.snap);
  const d = describeDrawer(snap, laneId(), node, null, fmt, 0);
  const id = d === null ? null : d.session;
  if (id === null) return null;
  if (state.detail !== null && state.detail.id === id && state.detail.rev === snap.rev) return state.detail.body;
  if (state.detail === null || state.detail.id !== id) state.detail = { id, rev: snap.rev, body: null };
  else state.detail.rev = snap.rev;
  void getSession(id).then((a) => {
    if (state.detail === null || state.detail.id !== id) return;
    state.detail.body = a.ok ? a.body : { error: a.code };
    schedule();
  });
  return state.detail.body;
}

const stageOnce = oneAtATime(getStage);

async function poll() {
  const a = await stageOnce();
  if (a === null) return;
  if (!a.ok) {
    state.error = a.code === 'unpaired' ? STAGE_TEXT['err.unpaired'] : a.code === 'network' ? STAGE_TEXT['err.network'] : fill('err.http', { code: a.code });
    return schedule();
  }
  if (!looksLikeStage(a.body)) {
    state.error = STAGE_TEXT['err.shape'];
    return schedule();
  }
  state.error = null;
  state.okMono = nowMono();
  // The body is always 200; an unchanged rev keeps the rendered stage and only refreshes the time.
  const changed = state.snap === null || state.snap.rev !== a.body.rev;
  state.snap = a.body;
  if (changed) {
    const h = describeHeader(a.body, laneId(), { stale: false, at: '' }).counts;
    dom.say(dom.byId('live'), fill('live.update', h));
  }
  schedule();
}

/** @type {(() => void)[]} */
let timers = [];
function wake() {
  timers.forEach((stop) => stop());
  timers = [];
  if (document.hidden) return;
  void poll();
  timers = [every(POLL_MS, () => void poll()), every(1000, schedule)];
}

/** @param {Partial<import('./route.js').Route>} change */
const move = (change) => go({ ...state.route, lane: laneId(), ...change });

/** @param {Element} el */
function act(el) {
  const t = /** @type {HTMLElement} */ (el);
  if (t.dataset.chip !== undefined) {
    const c = /** @type {Chip} */ (t.dataset.chip);
    state.chip = state.chip === c || !CHIPS.includes(c) ? null : c;
    return schedule();
  }
  if (t.dataset.node !== undefined) return move({ node: t.dataset.node, peek: true });
  const a = t.dataset.act;
  if (a === 'theme') {
    state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    setTheme(state.theme);
    return schedule();
  }
  if (a === 'stage' || a === 'plan') return move({ view: a });
  if (a === 'close') return move({ peek: false });
  if (a === 'peek' && state.detail !== null) return openPeek(state.detail.id);
  // A wait on the 你 line may sit in another lane: go there and open that player.
  const id = t.dataset.wait;
  if (id !== undefined && state.snap !== null) {
    const lane = state.snap.lanes.find((l) => l.players.some((p) => p.id === id));
    if (lane !== undefined) go({ ...state.route, lane: lane.id, node: id, peek: true });
  }
}

const target = (/** @type {EventTarget | null} */ e) => (e instanceof Element ? e.closest('[data-node],[data-chip],[data-act],[data-wait]') : null);

document.addEventListener('click', (e) => {
  const dlg = dom.byId('drawer');
  if (e.target === dlg) {
    if (outsideBox(dlg.getBoundingClientRect(), e.clientX, e.clientY)) move({ peek: false });
    return;
  }
  const el = target(e.target);
  if (el !== null) act(el);
});
document.addEventListener('keydown', (e) => {
  if (!activates(e)) return;
  const el = target(e.target);
  // Buttons click by themselves; SVG staff heads and phrases do not.
  if (el !== null && el.localName !== 'button') {
    e.preventDefault();
    act(el);
  }
});
dom.byId('lane').addEventListener('change', (e) => {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const id = sel.selectedOptions[0]?.dataset.lane;
  if (id === undefined) return;
  setLane(id);
  go({ ...state.route, lane: id, node: null, peek: false });
});
dom.byId('drawer').addEventListener('close', () => {
  if (state.route.peek) move({ peek: false });
});
window.addEventListener('hashchange', () => {
  state.route = parse(location.hash);
  if (!state.route.peek) state.detail = null;
  schedule();
});
document.addEventListener('visibilitychange', wake);

dom.fillStatic();
render();
wake();
