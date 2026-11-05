import type { ApprovalView, Approvals } from '../owned/approvals.ts';
import type { ClaudeOwned } from '../owned/claude-owned.ts';
import type { ClaudeSession } from '../owned/claude-session.ts';
import type { CodexOwned } from '../owned/codex-owned.ts';
import type { CodexSession } from '../owned/codex-session.ts';
import { isOver } from '../owned/codex-session.ts';
import { DEFAULT_DESK_MODEL, isClaudeModel } from '../owned/models.ts';
import type { FeedEvent } from '../owned/feed.ts';
import type { RestoredOwned } from '../owned/restored.ts';
import type { Desk } from '../route/desk.ts';
import type { Dispatcher, DispatchLevel } from '../route/dispatch.ts';
import { FRONT_DESK_TITLE } from '../route/front-desk.ts';
import type { AgentRequest, Requests } from '../route/requests.ts';
import { reportLine, requesterName } from '../route/requests.ts';
import type { Rec } from '../store/journal.ts';
import type { Log } from '../runtime/log.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import { isWithin, pathKey } from '../fs/paths.ts';
import type { OwnedCall, OwnedHandlers, OwnedOutcome } from './owned.ts';
import { OWNED_V } from '../../shared/owned-contract.js';
import { makeOwnedHandlers } from './owned.ts';

// The owned-session routes' handlers (orchestra app plan §2-§4; slice design §2.7): what runs once
// src/server/owned.ts has taken a request through its whole check chain (the cookie, Origin,
// Sec-Fetch-Site, JSON, the controller token, the caps, the shape, the dedup). Each human action that
// a handler accepts gets its `human` and `human.result` records from that base, after the effect; a
// refusal (an error code of the route) writes nothing.
//
//   POST /api/route/suggest             {text}: the dispatch desk's "Route to?" card (src/route/desk.ts):
//                                       the rules, then the router model; it starts nothing, writes nothing.
//   POST /api/owned/new                 {text, harness, model?, routeId?, root?}: a new session on codex (app-server)
//                                       or claude (the 0.2 host); a harness that is off is owned-disabled.
//                                       root (orchestra app plan 项目根): one of the project roots named at
//                                       startup (--project-root), exactly as GET /api/owned lists it; the session
//                                       runs there instead of its own ORCHESTRA_HOME\work\<id>. Any other path,
//                                       or a root with a requestId, is cwd-forbidden (no free path is taken).
//                                       A RouteDecision (mode manual, r4 §9.5) joins the batch of the human
//                                       records on every dispatch: with the routeId of a suggestion for this
//                                       very sentence it names that suggestion's candidates (and the session
//                                       takes the router model's title if the person took its pick); without
//                                       one (none, aged out, another sentence) it is router not-asked.
//   POST /api/owned/new + frontDesk     you open the front desk (src/route/front-desk.ts): on Claude, in its own work dir, its first
//                                       message the sentence the page sends for that click, no routeId, requestId or root. A
//                                       `front-desk` record joins the batch; no RouteDecision, as nothing was dispatched. One
//                                       while another runs is desk-open.
//   POST /api/owned/:id/message         {text}: turn/start, turn/steer, or waits (queued); the reply says
//                                       which (via), and the uuid of the message in the feed is the
//                                       actionId of its human record (its fate follows as msg-* notes).
//   POST /api/owned/:id/interrupt       declines the session's open approvals, withdraws its waiting
//                                       messages, then sends the turn's interrupt and, with a turn of the
//                                       root or without one, its sub-agents' (not awaited: the outcome of
//                                       each is the feed's).
//   POST /api/owned/:id/end             declines the open approvals, then stops the child.
//   POST /api/owned/:id/brake           r4 D4/D8: the session's whole Job (its child and every process
//                                       under it) ended now through procguard, its open approvals declined,
//                                       the session ended as braked; the reply counts what the Job held and
//                                       what was left (null: procguard could not say). Only a session in a
//                                       Job has a brake: one without (procguard off) is brake-unavailable.
//   POST /api/approvals/:id/allow       {digest, rev}: D8, only here and only by a person. Another
//                                       digest is declined (digest-mismatch), another rev or a list
//                                       that moved in the last 750 ms changes nothing (stale-view).
//   POST /api/approvals/:id/deny        always taken.
//   POST /api/agent-requests/:id/reject seat: you refuse an agent request (r4 A17; D8, only here); one that no
//                                       longer waits is request-gone. Its `agent-request` record (rejected)
//                                       joins the batch of the human records.
//   POST /api/owned/:id/dispatch-grant  {level}: you set a session's dispatch permission (src/route/dispatch.ts; D8: only
//                                       here and only by a person). Its `dispatch-grant` record joins the batch; it takes
//                                       effect once that is committed. 你不在也派 is no level: the shape refuses it (r4 D20).
//   POST /api/owned/new + requestId     seat: you dispatch an agent request: the text and harness must be the
//                                       card's (request-mismatch) and it must still wait (request-gone); the
//                                       session is bound to the request, and an `agent-request` record
//                                       (dispatched, naming the RouteDecision) joins the batch. It runs where the
//                                       card said: the request's runIn (its cwd, inside a project root), else
//                                       its own ORCHESTRA_HOME\work\<id>; the spawn gate holds either to its table.
//                                       A request of an owned session (its dispatch tool) goes the same way, but is tainted
//                                       only when that session is, and its cards name it (origin worker-dispatch).
//                                       Else its session is tainted wherever it runs (r4 §8.5: the request came from an
//                                       unbound sender): Claude asks for every tool call, reads in cwd too; Codex
//                                       starts with the untrusted approval policy, echoed or policy-mismatch.
//                                       Its approvals carry the source chain (origin: the requestId, the DSH
//                                       session id the request named itself by or null, its label), which the
//                                       page writes at the top of the card and the pin; display only.
//   owned-new in a project root         (the dialog's root or a request's runIn) adds an `owned-cwd` record to the
//                                       batch: the sha256 of the cwd and its root, and the requestId if any.
//   GET  /api/owned                     OwnedList (shared/owned-contract.js).
//   GET  /api/owned/:id/feed?after=     OwnedFeed.
// POST /api/owned/:id/retry and the import routes keep no handler (501): an owned Codex session is not
// resumed after its child went away, and imports are a later step.

export type OwnedRoutesDeps = {
  /** The owned Codex sessions, or null when they are off. */
  codex: CodexOwned | null;
  /** Why the owned Codex sessions are off (working.ts OwnedCodexStatus.why); ignored when they are on. */
  codexOff: string;
  /** The owned Claude sessions (the 0.2 host, src/owned/claude-owned.ts), or null when they are off. */
  claude: ClaudeOwned | null;
  /** The dispatch desk; null: POST /api/route/suggest has no handler (501) and a routeId changes nothing. */
  desk?: Desk | null;
  /** Sessions an earlier orchestrad left for a harness that is off now (src/owned/restored.ts): listed read only. */
  restored?: readonly RestoredOwned[];
  /** The agent requests (seat and the dispatch tool, src/route/requests.ts); null or absent: a requestId is request-gone. */
  requests?: Requests | null;
  /** The dispatch permission (src/route/dispatch.ts); null or absent: no session has the tool, and the route says owned-ended. */
  dispatch?: Dispatcher | null;
  /** The limit of running sessions both harnesses share (codex-owned.ts OWNED_POOL_MAX); absent: each manager's own, summed. */
  maxOwned?: number;
  /** The project roots named at startup (--project-root, checked), canonical; absent or empty: none, every session runs in the work dir. */
  projectRoots?: readonly string[];
  /**
   * Why a new session's tree runs without a Job of its own, so it has no brake, or why the brake cannot
   * report what it did (procguard-resident-gone), or null when every session's brake works (working.ts:
   * procguard's status, read at each list when it is a function). Absent: not asked (no procguard at all).
   */
  brakeWhy?: string | null | (() => string | null);
  log: Log;
};

/** A session of either harness, as the routes use it. */
type AnySession = CodexSession | ClaudeSession;

/** No child of it runs here: ended, failed, or left by an earlier orchestrad (unknown). */
const FINAL = (s: AnySession) => isOver(s.state);

/** The one approval queue both harnesses share (working.ts hands both managers the same), or null when both are off. */
const queueOf = (deps: Pick<OwnedRoutesDeps, 'codex' | 'claude'>): Approvals | null => deps.codex?.approvals ?? deps.claude?.approvals ?? null;

/** Whether any harness can start an owned session now: what the check chain's owned-disabled step reads. */
export const ownedEnabled = (deps: Pick<OwnedRoutesDeps, 'codex' | 'claude'>): boolean => deps.codex !== null || deps.claude !== null;

function approvalEntry(a: ApprovalView) {
  return {
    approvalId: a.approvalId, ownedId: a.ownedId, kind: a.kind, title: a.title, preview: a.preview, tooLong: a.tooLong, redactions: a.redactions,
    digest: a.digest, risk: a.risk, high: a.high, tainted: a.tainted, origin: a.origin === null ? null : { ...a.origin }, rev: a.rev, canAccept: a.canAccept, canText: a.canText, deadline: a.deadlineWall,
  };
}

function feedEntry(e: FeedEvent) {
  return {
    seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, uuid: e.uuid, text: e.text, state: e.state, redactions: e.redactions, live: e.live,
    exitCode: e.exitCode ?? null, tokens: e.tokens === undefined ? null : { ...e.tokens }, batch: e.batch ?? null,
  };
}

/** An agent request as GET /api/owned lists it (shared/owned-contract.js RequestEntry). */
export function requestEntry(r: AgentRequest) {
  const g = r.suggestion;
  return {
    requestId: r.requestId, harness: r.harness, label: r.label, text: r.text, cwd: r.cwd, runIn: r.runIn, runInWhy: r.runInWhy, requester: requesterName(r.requester), tainted: r.tainted, model: r.model, askWhy: r.askWhy, auto: r.auto, reason: r.reason, returns: r.returns, report: reportLine(r), state: r.state,
    createdAt: r.createdWall, expiresAt: r.expiresWall, ownedId: r.ownedId, why: r.why, fetched: r.fetched,
    suggestion: g === null ? null : { routeId: g.routeId, router: g.router, models: g.models.map((m) => ({ ...m })), pick: g.pick },
    suggesting: r.suggesting,
  };
}

/** A person's decision on an agent request, for the journal (src/store/records.ts `agent-request`). */
export function agentRequestRec(r: AgentRequest, d: { actionId: string; verdict: 'dispatched' | 'rejected'; ownedId: string | null; decisionId: string | null }): Rec {
  return {
    kind: 'agent-request',
    body: {
      requestId: r.requestId, actionId: d.actionId, verdict: d.verdict, harness: r.harness, requesterKind: r.requester.kind,
      requesterDigest: canonicalDigest(requesterName(r.requester)), ownedId: d.ownedId, decisionId: d.decisionId,
    },
  };
}

/**
 * Where a session a person started works, for the journal (src/store/records.ts `owned-cwd`): only in a project
 * root (or a folder in one); the sha256 of the cwd and of that root, and the agent request it runs (seat), if any.
 */
export function ownedCwdRec(d: { actionId: string; ownedId: string; requestId: string | null; cwd: string; root: string }): Rec {
  return {
    kind: 'owned-cwd',
    body: { actionId: d.actionId, ownedId: d.ownedId, requestId: d.requestId, cwdDigest: canonicalDigest(d.cwd), rootDigest: canonicalDigest(d.root) },
  };
}

/**
 * The person's normal stop order for an owned session (POST /api/owned/:id/end's), as an agent request's
 * withdrawal runs it (seat; final.md §6.3 A: never the brake): its open approvals declined, then the child
 * stopped, the session ended as requester-withdrew. False when no harness holds a running session of that id.
 */
export function endOwnedFor(deps: Pick<OwnedRoutesDeps, 'codex' | 'claude'>, ownedId: string): boolean {
  const s: AnySession | null = deps.codex?.get(ownedId) ?? deps.claude?.get(ownedId) ?? null;
  if (s === null || FINAL(s)) return false;
  s.end('requester-withdrew');
  return true;
}

/** GET /api/owned's reply: every session the manager keeps, the open approvals in queue order, the limits, the agent requests. */
/** Where a session works, as the list says it: a project root (or a folder in one) or its own work dir; null when not known (from before a restart). */
export function cwdEntry(cwd: string, roots: readonly string[]): { path: string; kind: 'project-root' | 'work' } | null {
  if (cwd === '') return null;
  return { path: cwd, kind: roots.some((r) => isWithin(cwd, r)) ? 'project-root' : 'work' };
}

export function ownedList(deps: Pick<OwnedRoutesDeps, 'codex' | 'claude' | 'codexOff' | 'restored' | 'maxOwned' | 'brakeWhy' | 'requests' | 'projectRoots' | 'dispatch'>) {
  const { codex, claude } = deps;
  const roots = deps.projectRoots ?? [];
  const queue = queueOf(deps);
  const approvals = queue === null ? [] : queue.list();
  const sessions: { s: AnySession; harness: 'codex' | 'claude'; meta: { title: string; createdAt: number; frontDesk?: boolean } | null }[] = [
    ...(codex === null ? [] : codex.list().map((s) => ({ s: s as AnySession, harness: 'codex' as const, meta: codex.meta(s.ownedId) }))),
    ...(claude === null ? [] : claude.list().map((s) => ({ s: s as AnySession, harness: 'claude' as const, meta: claude.meta(s.ownedId) }))),
    ...(deps.restored ?? []).flatMap((r) => r.list().map((s) => ({ s, harness: r.harness, meta: r.meta(s.ownedId) }))),
  ].sort((a, b) => (a.meta?.createdAt ?? 0) - (b.meta?.createdAt ?? 0));
  const owned = sessions.map(({ s, harness, meta }) => {
    const mine = approvals.filter((a) => a.ownedId === s.ownedId);
    // The one due first; among equal deadlines the one that came first (queue order, a stable sort).
    const first = [...mine].sort((p, q) => p.deadlineWall - q.deadlineWall)[0] ?? null;
    return {
      ownedId: s.ownedId, harness, model: s.model, title: meta?.title ?? '', state: s.state, endReason: s.endReason,
      waiting: first === null ? null : first.approvalId, queued: FINAL(s) ? 0 : s.queued, tokens: s.tokens === null ? null : { ...s.tokens },
      // An ending session whose child has not closed yet can still be braked (its stop order may hang).
      lastSeq: s.feed.lastSeq, createdAt: meta?.createdAt ?? 0, brake: s.state !== 'unknown' && s.jobbed, cwd: cwdEntry(s.cwd, roots),
      // A root gone idle still has something to stop while a sub-agent of its is live, or over with a command open.
      stoppable: !FINAL(s) && 'stoppable' in s && s.stoppable,
      dispatch: deps.dispatch == null || FINAL(s) ? null : { ...deps.dispatch.view(s.ownedId) },
      frontDesk: meta?.frontDesk === true,
    };
  });
  const enabled = ownedEnabled(deps);
  const desk = claude?.frontDesk() ?? null;
  return {
    v: OWNED_V, kind: 'owned-list', rev: queue === null ? 0 : queue.rev, enabled, disabledWhy: enabled ? null : deps.codexOff,
    brakeWhy: deps.brakeWhy === undefined ? 'not-asked' : typeof deps.brakeWhy === 'function' ? deps.brakeWhy() : deps.brakeWhy,
    harnesses: { codex: codex !== null, claude: claude !== null },
    roots: [...roots],
    owned, approvals: approvals.map(approvalEntry),
    limits: { maxOwned: deps.maxOwned ?? (codex === null ? 0 : codex.maxActive) + (claude === null ? 0 : claude.maxActive), active: sessions.filter(({ s, meta }) => !FINAL(s) && meta?.frontDesk !== true).length },
    // The front desk (src/route/front-desk.ts): what runs now, or whether one could open, and the tools its host's check let through.
    frontDesk: { on: claude?.deskOn === true, ownedId: desk?.ownedId ?? null, model: desk?.model ?? DEFAULT_DESK_MODEL, tools: desk?.tools === null || desk === null ? null : [...desk.tools] },
    requests: (deps.requests?.list() ?? []).map(requestEntry),
    requestedGone: deps.requests?.requestedGone() ?? [],
    sentGone: deps.requests?.sentGone() ?? [],
    presence: deps.dispatch?.presence() ?? 'unknown',
  };
}

const refuse = (error: Extract<OwnedOutcome, { ok: false }>['error']): OwnedOutcome => ({ ok: false, error });

/** Registers every owned route this build handles on `handlers` (a fresh table when none is given) and returns it. */
export function registerOwnedHandlers(deps: OwnedRoutesDeps, handlers: OwnedHandlers = makeOwnedHandlers()): OwnedHandlers {
  const { codex, claude, log } = deps;
  const desk = deps.desk ?? null;
  const requests = deps.requests ?? null;
  const dispatch = deps.dispatch ?? null;
  const session = (call: OwnedCall): AnySession | null => {
    if (call.id === null) return null;
    const id = call.id;
    return codex?.get(id) ?? claude?.get(id) ?? (deps.restored ?? []).map((r) => r.get(id)).find((x) => x !== null) ?? null;
  };
  const queue = queueOf(deps);

  handlers.register('GET', '/api/owned', () => ({ ok: true, reply: ownedList(deps) }));

  handlers.register('GET', '/api/owned/:id/feed', (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    const after = call.query.after === undefined ? 0 : Number(call.query.after);
    const page = s.feed.since(after);
    return {
      ok: true,
      reply: { v: OWNED_V, kind: 'owned-feed', ownedId: s.ownedId, from: page.from, to: page.to, clipped: page.clipped, events: page.events.map(feedEntry) },
    };
  });

  if (desk !== null) {
    handlers.register('POST', '/api/route/suggest', async (call) => {
      const r = await desk.suggest(String(call.body!.text));
      log.info('route-suggested', { routeId: r.routeId, router: r.router.state, why: r.router.why, rules: r.rules, candidates: r.candidates.length });
      return { ok: true, reply: { ...r, rules: [...r.rules], router: { ...r.router }, candidates: r.candidates.map((c) => ({ ...c })), off: [...r.off] } };
    });
  }

  /** You open the front desk. Its first message is the sentence the page sent for that click, as any first message is. */
  const openDesk = (call: OwnedCall): OwnedOutcome => {
    const body = call.body!;
    if (claude === null || !claude.deskOn || body.harness !== 'claude' || (typeof body.model === 'string' && !isClaudeModel(body.model))) return refuse('owned-disabled');
    if (typeof body.routeId === 'string' || typeof body.requestId === 'string' || typeof body.root === 'string') return refuse('cwd-forbidden');
    const made = claude.create({ text: String(body.text), uuid: call.actionId!, title: FRONT_DESK_TITLE, frontDesk: true, ...(typeof body.model === 'string' ? { model: body.model } : {}) });
    if (!made.ok) {
      if (made.reason === 'desk-open') return refuse('desk-open');
      log.warn('front-desk-failed', { reason: made.reason, detail: made.detail });
      return refuse(made.reason === 'desk-off' || made.reason === 'model-refused' ? 'owned-disabled' : 'spawn-failed');
    }
    log.info('front-desk-opened', { ownedId: made.ownedId, model: made.session.model });
    return { ok: true, reply: { ownedId: made.ownedId }, targetId: made.ownedId, records: [{ kind: 'front-desk', body: { actionId: call.actionId!, ownedId: made.ownedId, model: made.session.model } }] };
  };

  handlers.register('POST', '/api/owned/new', (call) => {
    const body = call.body!;
    if (body.frontDesk === true) return openDesk(call);
    const harness = body.harness === 'claude' ? 'claude' : 'codex';
    const manager = harness === 'claude' ? claude : codex;
    if (manager === null) return refuse('owned-disabled');
    const text = String(body.text);
    const requestId = typeof body.requestId === 'string' ? body.requestId : null;
    // seat: a dispatch of an agent request takes exactly what its card showed, while it still waits.
    let asked: AgentRequest | null = null;
    if (requestId !== null) {
      if (requests === null) return refuse('request-gone');
      const c = requests.claim(requestId, text, harness);
      if (!c.ok) return refuse(c.why);
      asked = c.request;
    }
    // Where it runs: a project root the dialog offered (exactly one of the list), the agent request's runIn, or its own work dir.
    let cwd: string | undefined;
    if (typeof body.root === 'string') {
      const root = (deps.projectRoots ?? []).find((r) => pathKey(r) === pathKey(body.root as string));
      if (root === undefined || asked !== null) return refuse('cwd-forbidden');
      cwd = root;
    } else if (asked !== null && asked.runIn !== null) {
      cwd = asked.runIn;
    }
    const routeId = typeof body.routeId === 'string' ? body.routeId : null;
    const kept = routeId === null || desk === null ? null : desk.take(routeId, text);
    // A suggestion that aged out, or was made for another sentence: the session starts all the same, its decision a manual one.
    if (routeId !== null && kept === null) log.info('route-not-kept', { routeId });
    // The router model's title names the session only when the person took the candidate it chose; else the sentence's first line does.
    const title = kept === null || desk === null || typeof body.model !== 'string' ? null : desk.titleFor(kept, harness, body.model);
    // The project root the cwd lies in (the journal names it); a cwd outside every root never comes this far.
    const root = cwd === undefined ? null : (deps.projectRoots ?? []).find((r) => isWithin(cwd!, r)) ?? null;
    // r4 §8.5: a seat request comes from an unbound sender (a DSH session asked; the person only dispatched it),
    // so every turn of its session is tainted, wherever it runs (a project root or its own work dir): a Claude
    // session asks for every tool call, reads in cwd too (host-core.mjs judge); a Codex one starts its thread
    // with the untrusted approval policy and ends as policy-mismatch unless thread/start echoes it.
    // A request of an owned session is tainted only when that session is (the same project's clean musicians are clean, trust agent: r4 §8.5).
    const tainted = asked !== null && asked.tainted;
    // r4 §8.5: the source chain its cards show at the top (display only; a DSH requester's id is its own word, null when it named none).
    const origin = asked === null ? null : asked.requester.kind === 'owned'
      ? { kind: 'worker-dispatch' as const, requestId: asked.requestId, requester: asked.requester.sessionId, label: dispatch?.labelOf(asked.requester.sessionId) ?? null }
      : { kind: 'agent-request' as const, requestId: asked.requestId, requester: asked.requester.sessionId, label: asked.label };
    const model = typeof body.model === 'string' ? body.model : asked?.model ?? null;
    const made = manager.create({
      text, uuid: call.actionId!, ...(model === null ? {} : { model }), ...(title === null ? {} : { title }), ...(cwd === undefined ? {} : { cwd }),
      ...(tainted ? { tainted: true } : {}), ...(origin === null ? {} : { origin }),
    });
    if (!made.ok) {
      if (made.reason === 'owned-limit') return refuse('owned-limit');
      log.warn('owned-start-failed', { harness, reason: made.reason, detail: made.detail });
      // The route's shape took any model of the owned list; a codex/* model for Claude is refused here
      // (model-refused: owned-disabled for that harness and model). What is left is the child or its dirs.
      return refuse(made.reason === 'model-refused' ? 'owned-disabled' : 'spawn-failed');
    }
    log.info('owned-started', { harness, ownedId: made.ownedId, model: made.session.model, tainted, ...(cwd === undefined ? {} : { projectRoot: true, cwd }) });
    // The session runs the request from now on (bound in the same turn as the claim: no second dispatch gets it).
    if (asked !== null) {
      requests!.bind(asked.requestId, made.ownedId);
      dispatch?.adopted(asked, made.ownedId);
      log.info('agent-request-dispatched', { requestId: asked.requestId, ownedId: made.ownedId });
    }
    // In a project root: where it works, bound to this dispatch (the card's runIn for a request).
    const cwdRec: Rec[] = cwd === undefined || root === null ? [] : [ownedCwdRec({ actionId: call.actionId!, ownedId: made.ownedId, requestId: asked?.requestId ?? null, cwd, root })];
    const requestRec = (decisionId: string | null): Rec[] => [
      ...(asked === null ? [] : [agentRequestRec(asked, { actionId: call.actionId!, verdict: 'dispatched', ownedId: made.ownedId, decisionId })]),
      ...cwdRec,
    ];
    if (desk === null) return { ok: true, reply: { ownedId: made.ownedId }, targetId: made.ownedId, records: requestRec(null) };
    // Every dispatch is a RouteDecision (r4 §9.5), from a suggestion for this very sentence or by hand.
    const d = { ownedId: made.ownedId, harness, model: made.session.model } as const;
    const decision = kept === null ? desk.manual(text, { actionId: call.actionId!, ...d }) : desk.decision(kept, { actionId: call.actionId!, ...d });
    return {
      ok: true, reply: { ownedId: made.ownedId }, targetId: made.ownedId,
      // seat: the agent-request record names this RouteDecision, so the decision's source is the request.
      records: [decision, ...requestRec(String((decision.body as { decisionId: unknown }).decisionId))],
      after: () => desk.dispatched(d),
    };
  });

  handlers.register('POST', '/api/owned/:id/message', (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    const sent = s.send(String(call.body!.text), call.actionId!);
    if (!sent.ok) return refuse(sent.reason === 'ended' ? 'owned-ended' : 'queue-full');
    return { ok: true, reply: { uuid: call.actionId!, queued: s.queued, via: sent.via } };
  });

  handlers.register('POST', '/api/owned/:id/dispatch-grant', (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    // No dispatcher: no session here holds the tool, so none takes a level.
    if (FINAL(s) || dispatch === null) return refuse('owned-ended');
    const level = String(call.body!.level) as DispatchLevel;
    log.info('dispatch-grant', { ownedId: s.ownedId, level });
    return {
      ok: true, reply: { level }, records: [{ kind: 'dispatch-grant', body: { actionId: call.actionId!, ownedId: s.ownedId, level } }],
      after: () => {
        dispatch.grant(s.ownedId, level, call.actionId!);
        s.feed.push({ kind: 'note', ref: null, text: level, state: 'dispatch-grant' });
      },
    };
  });

  handlers.register('POST', '/api/owned/:id/interrupt', async (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    const r = await s.interrupt();
    return { ok: true, reply: { withdrawn: r.withdrawn, denied: r.denied } };
  });

  handlers.register('POST', '/api/owned/:id/end', (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    s.end();
    return { ok: true, reply: {} };
  });

  handlers.register('POST', '/api/owned/:id/brake', async (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    // Ended but its child still closing: the brake still reaches it (phase 4 review). Closed: owned-ended.
    if (!s.jobbed) return refuse(FINAL(s) ? 'owned-ended' : 'brake-unavailable');
    const r = await s.brake();
    if (!r.ok) return refuse(r.reason === 'ended' ? 'owned-ended' : 'brake-unavailable');
    log.info('owned-braked', { ownedId: s.ownedId, killed: r.killed, left: r.left });
    return { ok: true, reply: { killed: r.killed, left: r.left } };
  });

  handlers.register('POST', '/api/approvals/:id/allow', (call) => {
    if (queue === null) return refuse('approval-gone');
    const body = call.body!;
    const v = queue.allow(call.id!, { digest: String(body.digest), rev: Number(body.rev) });
    if (v !== 'ok') {
      // A wrong digest was declined on the spot (slice design §2.6); the 409 writes no human record, so the log keeps it.
      if (v === 'digest-mismatch') log.info('approval-declined-mismatch', { approvalId: call.id });
      return refuse(v);
    }
    return { ok: true, reply: {} };
  });

  handlers.register('POST', '/api/agent-requests/:id/reject', (call) => {
    if (requests === null) return refuse('request-gone');
    const r = requests.get(call.id!);
    if (r === null || !requests.reject(r.requestId)) return refuse('request-gone');
    log.info('agent-request-rejected', { requestId: r.requestId });
    return { ok: true, reply: {}, records: [agentRequestRec(r, { actionId: call.actionId!, verdict: 'rejected', ownedId: null, decisionId: null })] };
  });

  handlers.register('POST', '/api/approvals/:id/deny', (call) => {
    if (queue === null) return refuse('approval-gone');
    const v = queue.deny(call.id!);
    return v === 'ok' ? { ok: true, reply: {} } : refuse('approval-gone');
  });

  return handlers;
}
