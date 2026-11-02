import type { ApprovalView } from '../owned/approvals.ts';
import type { CodexOwned } from '../owned/codex-owned.ts';
import type { CodexSession } from '../owned/codex-session.ts';
import { isOver } from '../owned/codex-session.ts';
import type { FeedEvent } from '../owned/feed.ts';
import type { Log } from '../runtime/log.ts';
import type { OwnedCall, OwnedHandlers, OwnedOutcome } from './owned.ts';
import { OWNED_V } from '../../shared/owned-contract.js';
import { makeOwnedHandlers } from './owned.ts';

// The owned-session routes' handlers (orchestra app plan §2-§4; slice design §2.7): what runs once
// src/server/owned.ts has taken a request through its whole check chain (the cookie, Origin,
// Sec-Fetch-Site, JSON, the controller token, the caps, the shape, the dedup). Each human action that
// a handler accepts gets its `human` and `human.result` records from that base, after the effect; a
// refusal (an error code of the route) writes nothing.
//
//   POST /api/owned/new                 {text, harness, model?}: a new session; codex now, claude only
//                                       once its host is wired (owned-disabled until then).
//   POST /api/owned/:id/message         {text}: turn/start, turn/steer, or waits (queued); the reply says
//                                       which (via), and the uuid of the message in the feed is the
//                                       actionId of its human record (its fate follows as msg-* notes).
//   POST /api/owned/:id/interrupt       declines the session's open approvals, withdraws its waiting
//                                       messages, then sends the turn's interrupt (not awaited: its
//                                       outcome is the feed's).
//   POST /api/owned/:id/end             declines the open approvals, then stops the child.
//   POST /api/approvals/:id/allow       {digest, rev}: D8, only here and only by a person. Another
//                                       digest is declined (digest-mismatch), another rev or a list
//                                       that moved in the last 750 ms changes nothing (stale-view).
//   POST /api/approvals/:id/deny        always taken.
//   GET  /api/owned                     OwnedList (shared/owned-contract.js).
//   GET  /api/owned/:id/feed?after=     OwnedFeed.
// POST /api/owned/:id/retry and the import routes keep no handler (501): an owned Codex session is not
// resumed after its child went away, and imports are a later step.

export type OwnedRoutesDeps = {
  /** The owned Codex sessions, or null when they are off. */
  codex: CodexOwned | null;
  /** Why the owned Codex sessions are off (working.ts OwnedCodexStatus.why); ignored when they are on. */
  codexOff: string;
  /** Claude owned sessions run on the 0.2 host, which is not wired into orchestrad yet: always off. */
  claude: null;
  log: Log;
};

/** No child of it runs here: ended, failed, or left by an earlier orchestrad (unknown). */
const FINAL = (s: CodexSession) => isOver(s.state);

/** Whether any harness can start an owned session now: what the check chain's owned-disabled step reads. */
export const ownedEnabled = (deps: Pick<OwnedRoutesDeps, 'codex' | 'claude'>): boolean => deps.codex !== null || deps.claude !== null;

function approvalEntry(a: ApprovalView) {
  return {
    approvalId: a.approvalId, ownedId: a.ownedId, kind: a.kind, title: a.title, preview: a.preview, tooLong: a.tooLong, redactions: a.redactions,
    digest: a.digest, risk: a.risk, high: a.high, rev: a.rev, canAccept: a.canAccept, canText: a.canText, deadline: a.deadlineWall,
  };
}

function feedEntry(e: FeedEvent) {
  return {
    seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, uuid: e.uuid, text: e.text, state: e.state, redactions: e.redactions, live: e.live,
    exitCode: e.exitCode ?? null, tokens: e.tokens === undefined ? null : { ...e.tokens },
  };
}

/** GET /api/owned's reply: every session the manager keeps, the open approvals in queue order, the limits. */
export function ownedList(deps: Pick<OwnedRoutesDeps, 'codex' | 'claude' | 'codexOff'>) {
  const { codex } = deps;
  const approvals = codex === null ? [] : codex.approvals.list();
  const sessions = codex === null ? [] : codex.list();
  const owned = sessions.map((s) => {
    const mine = approvals.filter((a) => a.ownedId === s.ownedId);
    // The one due first; among equal deadlines the one that came first (queue order, a stable sort).
    const first = [...mine].sort((p, q) => p.deadlineWall - q.deadlineWall)[0] ?? null;
    const meta = codex!.meta(s.ownedId);
    return {
      ownedId: s.ownedId, harness: 'codex', model: s.model, title: meta?.title ?? '', state: s.state, endReason: s.endReason,
      waiting: first === null ? null : first.approvalId, queued: FINAL(s) ? 0 : s.queued, tokens: s.tokens === null ? null : { ...s.tokens },
      lastSeq: s.feed.lastSeq, createdAt: meta?.createdAt ?? 0,
    };
  });
  const enabled = ownedEnabled(deps);
  return {
    v: OWNED_V, kind: 'owned-list', rev: codex === null ? 0 : codex.approvals.rev, enabled, disabledWhy: enabled ? null : deps.codexOff,
    harnesses: { codex: codex !== null, claude: deps.claude !== null },
    owned, approvals: approvals.map(approvalEntry),
    limits: { maxOwned: codex === null ? 0 : codex.maxActive, active: sessions.filter((s) => !FINAL(s)).length },
  };
}

const refuse = (error: Extract<OwnedOutcome, { ok: false }>['error']): OwnedOutcome => ({ ok: false, error });

/** Registers every owned route this build handles on `handlers` (a fresh table when none is given) and returns it. */
export function registerOwnedHandlers(deps: OwnedRoutesDeps, handlers: OwnedHandlers = makeOwnedHandlers()): OwnedHandlers {
  const { codex, log } = deps;
  const session = (call: OwnedCall): CodexSession | null => (codex === null || call.id === null ? null : codex.get(call.id));

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

  handlers.register('POST', '/api/owned/new', (call) => {
    const body = call.body!;
    if (body.harness === 'claude' || codex === null) return refuse('owned-disabled');
    const made = codex.create({ text: String(body.text), uuid: call.actionId!, ...(typeof body.model === 'string' ? { model: body.model } : {}) });
    if (!made.ok) {
      if (made.reason === 'owned-limit') return refuse('owned-limit');
      log.warn('owned-start-failed', { harness: 'codex', reason: made.reason, detail: made.detail });
      // The model was checked by the route's shape; what is left is the child or its work dir.
      return refuse(made.reason === 'model-refused' ? 'owned-disabled' : 'spawn-failed');
    }
    log.info('owned-started', { harness: 'codex', ownedId: made.ownedId, model: made.session.model });
    return { ok: true, reply: { ownedId: made.ownedId }, targetId: made.ownedId };
  });

  handlers.register('POST', '/api/owned/:id/message', (call) => {
    const s = session(call);
    if (s === null) return refuse('item-unknown');
    const sent = s.send(String(call.body!.text), call.actionId!);
    if (!sent.ok) return refuse(sent.reason === 'ended' ? 'owned-ended' : 'queue-full');
    return { ok: true, reply: { uuid: call.actionId!, queued: s.queued, via: sent.via } };
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

  handlers.register('POST', '/api/approvals/:id/allow', (call) => {
    if (codex === null) return refuse('approval-gone');
    const body = call.body!;
    const v = codex.approvals.allow(call.id!, { digest: String(body.digest), rev: Number(body.rev) });
    if (v !== 'ok') {
      // A wrong digest was declined on the spot (slice design §2.6); the 409 writes no human record, so the log keeps it.
      if (v === 'digest-mismatch') log.info('approval-declined-mismatch', { approvalId: call.id });
      return refuse(v);
    }
    return { ok: true, reply: {} };
  });

  handlers.register('POST', '/api/approvals/:id/deny', (call) => {
    if (codex === null) return refuse('approval-gone');
    const v = codex.approvals.deny(call.id!);
    return v === 'ok' ? { ok: true, reply: {} } : refuse('approval-gone');
  });

  return handlers;
}
