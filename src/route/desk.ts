import * as crypto from 'node:crypto';
import { frozen } from '../../shared/frozen.js';
import type { After, LoopbackPost } from '../net/magpie.ts';
import type { ClockHub } from '../runtime/clock.ts';
import { oneShot } from '../runtime/clock.ts';
import type { Db } from '../store/db.ts';
import type { Rec } from '../store/journal.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import type { Candidate, RouteHarness, RouterState, RuleId, TaskClass } from './rules.ts';
import { ROUTE_HARNESSES, MAX_CANDIDATES, runRules } from './rules.ts';
import type { RouterWhy } from './router-model.ts';
import { readRouterReply, routerRequest } from './router-model.ts';

// The dispatch desk (orchestra app plan §3, the superagent layer): one sentence in, a "Route to?" card
// out (r4 §9.2 step 10: the person picks, nothing is dispatched by default). The deterministic rules run
// first (D9); then, unless they settled it, the router model on magpie is asked once; its pick leads the
// card, the rules' candidates follow as alternatives, and a sentence that named a harness or a model
// keeps that first. A suggestion starts nothing: it is kept here, in memory, under its routeId, until
// the person dispatches (POST /api/owned/new with that routeId) or it ages out.
//
// When the person dispatches, the owned-new handler takes the suggestion back (only for the very same
// sentence: an edited sentence is a new task) and this module writes the RouteDecision record (r4 §6.2,
// §9.4) that goes into the journal in the same batch as the `human` records: the candidates, which one
// the person took (or none: chosen by hand), the rules that hit, what the router model did (its model,
// and why its answer was not used), mode manual. A dispatch with no suggestion for its sentence (none
// was asked for, it aged out, the sentence changed) gets one too (r4 §9.5: from M1 every dispatch is a
// RouteDecision, mode manual, with the rules' taskClass): no routeId, no candidates, router not-asked.
// The record holds ids, enums and model names only: never the sentence, a title or the model's words
// (records.ts: no source free text in a body).
//
// The router model picks only among what survived the rules (r4 §9.2 step 9): a harness the sentence
// ruled out ("不要用 codex") or one that cannot start a session now is refused as its answer. At most
// DESK_LIMITS.inFlight questions to it run at once; past that a suggestion is the rules' alone (busy).

/** Suggestions kept, how long one stays good for a dispatch, and how many router-model questions run at once. */
export const DESK_LIMITS = frozen({ kept: 64, ttlMs: 30 * 60 * 1000, inFlight: 2 });

export type SuggestReply = {
  readonly routeId: string;
  readonly title: string;
  /** Where the title came from: the sentence's first line (rule) or the router model's words (model). */
  readonly titleSource: 'rule' | 'model';
  readonly taskClass: TaskClass;
  readonly rules: readonly RuleId[];
  /** pick: the candidate the router model chose (its own, or a rule's it agreed with); null when it chose none. */
  readonly router: { readonly model: string; readonly state: RouterState; readonly why: RouterWhy | null; readonly pick: number | null };
  readonly candidates: readonly Candidate[];
  /** Harnesses that cannot start a session now: none of their candidates is shown. */
  readonly off: readonly RouteHarness[];
  /** The running owned sessions are at their limit: that is why every harness is off (owned-limit). */
  readonly full: boolean;
};

/** A suggestion as the desk keeps it until a dispatch takes it. */
export type Kept = {
  readonly reply: SuggestReply;
  /** sha256 of the sentence, in memory only: a dispatch of another sentence does not take it. */
  readonly textDigest: string;
  readonly madeMono: number;
};

/** The last dispatch, as the tower's router row shows it (title from the session's own meta). */
export type Dispatch = { readonly ownedId: string; readonly harness: RouteHarness; readonly model: string; readonly at: number; /** A worker sent it out on your permission: no click of yours. */ readonly auto: boolean };

export type DeskDeps = {
  /** The POST to magpie's chat completions; null when the router model is off (the rules alone). */
  post: LoopbackPost | null;
  routerModel: string;
  /** Which harnesses can start an owned session now (on, and below the limit of running sessions). */
  on(): Readonly<Record<RouteHarness, boolean>>;
  /** Whether the running owned sessions are at their limit (default: never). */
  full?(): boolean;
  /** The redactor, over the router model's title and reason. */
  redact(s: string): string;
  nowMono(): number;
  /** The wall clock a dispatch is stamped with on the router row. */
  nowWall(): number;
  /** The last dispatch the journal holds, read once when the desk is made (null: none). */
  restored?: Dispatch | null;
};

export type Desk = {
  /**
   * The card for one sentence. `only` (seat: an agent request names its harness) holds the rules and the
   * router model to that harness: the other one counts as off for this card.
   */
  suggest(text: string, only?: RouteHarness): Promise<SuggestReply>;
  /** The suggestion `routeId` names, if it is still kept and was made for this very sentence (it stays kept). */
  take(routeId: string, text: string): Kept | null;
  /** The RouteDecision record of a dispatch from `kept`; the suggestion is used up. */
  decision(kept: Kept, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec;
  /** The RouteDecision record of a dispatch with no suggestion for its sentence (r4 §9.5): the rules' taskClass, no candidates, router not-asked. */
  manual(text: string, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec;
  /** The RouteDecision record of a dispatch a worker made on its permission (src/route/dispatch.ts): as `manual`, mode auto, reason worker. */
  auto(text: string, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec;
  /** The title a dispatch from `kept` gives its session: the router model's only when the person took the candidate it chose, else null (the sentence's first line). */
  titleFor(kept: Kept, harness: RouteHarness, model: string): string | null;
  /** A dispatch whose records are in the journal: the router row shows it, stamped now. */
  dispatched(d: Omit<Dispatch, 'at' | 'auto'> & { auto?: boolean }): void;
  last(): Dispatch | null;
};

const digestOf = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function makeDesk(deps: DeskDeps): Desk {
  const kept = new Map<string, Kept>();
  let last: Dispatch | null = deps.restored ?? null;
  const fresh = (k: Kept) => deps.nowMono() - k.madeMono <= DESK_LIMITS.ttlMs;
  let asking = 0;

  const suggest = async (text: string, only?: RouteHarness): Promise<SuggestReply> => {
    const on = { ...deps.on() };
    if (only !== undefined) for (const h of ROUTE_HARNESSES) if (h !== only) on[h] = false;
    const full = deps.full?.() ?? false;
    const rules = runRules(text, on);
    let state: RouterState;
    let why: RouterWhy | null = null;
    let lead: Candidate | null = null;
    let title = rules.title;
    let titleSource: 'rule' | 'model' = 'rule';
    // r4 §9.2 step 9: the model picks among the harnesses the rules left (on, and not ruled out by the sentence).
    const usable = ROUTE_HARNESSES.filter((h) => on[h] && !rules.excluded.includes(h));
    if (deps.post === null) state = 'off';
    else if (rules.decided) state = 'skipped';
    else if (usable.length === 0) {
      state = 'no-answer';
      why = 'nothing-usable';
    } else if (asking >= DESK_LIMITS.inFlight) {
      state = 'no-answer';
      why = 'busy';
    } else {
      asking++;
      let answer;
      try {
        answer = readRouterReply(await deps.post(routerRequest(deps.routerModel, text)), on, deps.redact, rules.excluded);
      } finally {
        asking--;
      }
      if (answer.ok) {
        state = 'answered';
        lead = Object.freeze({ harness: answer.pick.harness, model: answer.pick.model, source: 'model', rule: null, reason: answer.pick.reason });
        title = answer.pick.title;
        titleSource = 'model';
      } else {
        state = 'no-answer';
        why = answer.why;
      }
    }
    // A sentence that named a harness or a model keeps that first; otherwise the model's pick leads.
    const named = rules.candidates.filter((c) => c.rule === 'named-model' || c.rule === 'named-harness');
    const rest = rules.candidates.filter((c) => !named.includes(c));
    const order = lead === null ? rules.candidates : [...named, lead, ...rest];
    const candidates: Candidate[] = [];
    for (const c of order) {
      if (candidates.some((x) => x.harness === c.harness && x.model === c.model)) continue;
      candidates.push(c);
    }
    const shown = candidates.slice(0, MAX_CANDIDATES);
    const at = lead === null ? -1 : shown.findIndex((c) => c.harness === lead!.harness && c.model === lead!.model);
    const reply: SuggestReply = Object.freeze({
      routeId: crypto.randomBytes(10).toString('hex'),
      title,
      titleSource,
      taskClass: rules.taskClass,
      rules: rules.hits,
      router: Object.freeze({ model: deps.routerModel, state, why, pick: at < 0 ? null : at }),
      candidates: Object.freeze(shown),
      off: Object.freeze(ROUTE_HARNESSES.filter((h) => !on[h])),
      full,
    });
    for (const [id, k] of kept) if (!fresh(k)) kept.delete(id);
    while (kept.size >= DESK_LIMITS.kept) kept.delete(kept.keys().next().value!);
    kept.set(reply.routeId, Object.freeze({ reply, textDigest: digestOf(text), madeMono: deps.nowMono() }));
    return reply;
  };

  return Object.freeze({
    suggest,
    take(routeId: string, text: string): Kept | null {
      const k = kept.get(routeId);
      if (k === undefined) return null;
      if (!fresh(k)) {
        kept.delete(routeId);
        return null;
      }
      return k.textDigest === digestOf(text) ? k : null;
    },
    decision(k: Kept, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec {
      kept.delete(k.reply.routeId);
      const candidates = k.reply.candidates.map((c) => ({ harness: c.harness, model: c.model, source: c.source, rule: c.rule }));
      const i = candidates.findIndex((c) => c.harness === d.harness && c.model === d.model);
      const pick = i < 0 ? null : i;
      const reason = pick === null ? 'manual' : candidates[pick]!.rule ?? 'router-model';
      const r = k.reply.router;
      const asked = r.state === 'answered' || (r.state === 'no-answer' && r.why !== 'busy' && r.why !== 'nothing-usable');
      const body = {
        actionId: d.actionId, routeId: k.reply.routeId, ownedId: d.ownedId, taskClass: k.reply.taskClass, rules: [...k.reply.rules],
        candidates, chosen: { harness: d.harness, model: d.model }, pick, reason, router: r.state, routerModel: asked ? r.model : null, routerWhy: r.why, mode: 'manual',
      };
      return { kind: 'route', body: { decisionId: canonicalDigest(body), ...body } };
    },
    manual(text: string, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec {
      const rules = runRules(text, { codex: true, claude: true });
      const body = {
        actionId: d.actionId, routeId: null, ownedId: d.ownedId, taskClass: rules.taskClass, rules: [...rules.hits],
        candidates: [], chosen: { harness: d.harness, model: d.model }, pick: null, reason: 'manual', router: 'not-asked', routerModel: null, routerWhy: null, mode: 'manual',
      };
      return { kind: 'route', body: { decisionId: canonicalDigest(body), ...body } };
    },
    auto(text: string, d: { actionId: string; ownedId: string; harness: RouteHarness; model: string }): Rec {
      const rules = runRules(text, { codex: true, claude: true });
      const body = {
        actionId: d.actionId, routeId: null, ownedId: d.ownedId, taskClass: rules.taskClass, rules: [...rules.hits],
        candidates: [], chosen: { harness: d.harness, model: d.model }, pick: null, reason: 'worker', router: 'not-asked', routerModel: null, routerWhy: null, mode: 'auto',
      };
      return { kind: 'route', body: { decisionId: canonicalDigest(body), ...body } };
    },
    titleFor(k: Kept, harness: RouteHarness, model: string): string | null {
      if (k.reply.titleSource !== 'model' || k.reply.router.pick === null) return null;
      const c = k.reply.candidates[k.reply.router.pick];
      return c !== undefined && c.harness === harness && c.model === model ? k.reply.title : null;
    },
    dispatched(d: Omit<Dispatch, 'at' | 'auto'> & { auto?: boolean }): void {
      last = Object.freeze({ ownedId: d.ownedId, harness: d.harness, model: d.model, at: deps.nowWall(), auto: d.auto === true });
    },
    last: () => last,
  });
}

/** The last dispatch a stored `route` body names, with the wall time of its line; null when it is not one. */
export function dispatchOf(body: unknown, obsWall: number): Dispatch | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { ownedId?: unknown; mode?: unknown; chosen?: { harness?: unknown; model?: unknown } };
  const h = b.chosen?.harness;
  if (typeof b.ownedId !== 'string' || (h !== 'codex' && h !== 'claude') || typeof b.chosen?.model !== 'string') return null;
  return Object.freeze({ ownedId: b.ownedId, harness: h, model: b.chosen.model, at: obsWall, auto: b.mode === 'auto' });
}

/** The last dispatch the journal holds (the newest `route` line), or null: read once when the desk is made. */
export function lastDispatchIn(db: Pick<Db, 'get'>): Dispatch | null {
  const r = db.get("SELECT body, obs_wall FROM event WHERE kind = 'route' ORDER BY jseq DESC LIMIT 1");
  if (r === undefined) return null;
  try {
    return dispatchOf(JSON.parse(String(r.body)), Number(r.obs_wall));
  } catch {
    return null;
  }
}

/** One-shot deadlines on the Clock for the router model's POST (r4 invariant 21: time only through the Clock port). */
export function makeAfter(hub: ClockHub): After {
  return oneShot(hub, 'route-desk');
}
