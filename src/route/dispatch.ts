import * as crypto from 'node:crypto';
import { frozen } from '../../shared/frozen.js';
import type { RunIn, RunInWhy } from '../os/project-roots.ts';
import { isClaudeModel, isOwnedModel } from '../owned/models.ts';
import { utf8Length } from '../owned/text.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import type { Rec } from '../store/journal.ts';
import type { Desk } from './desk.ts';
import type { Presence } from './presence.ts';
import type { AgentRequest, AskWhy, RequestRefusal, Requests } from './requests.ts';
import { REQUEST_LIMITS } from './requests.ts';
import type { RouteHarness } from './rules.ts';
import { ROUTE_HARNESSES, ROUTE_MODELS } from './rules.ts';

// A worker's dispatch (orchestra app plan 派活权限; docs/design/mocks/2026-11-03-ensemble/round3/BRIEF.md 第 1.1 节): an
// owned session sends another one out through a tool orchestrad gave it. Codex calls it as a dynamic tool (item/tool/call),
// Claude through an in-process MCP server of the host (hosts/claude/host-core.mjs); both reach this module through their
// driver, so which session called is what orchestrad knows, never a word of the model's.
//
// Each session has one level, set only by a person on the paired, unlocked page (POST /api/owned/:id/dispatch-grant; D8;
// the agent port has no such route):
//   ask   派前问你, the default: the call becomes a request card (src/route/requests.ts), the tool's answer waits for your
//         派出 or 拒绝, and time up is a refusal (D8);
//   free  直接派出: no card and no click, but every other check of a dispatch: the model list, the project roots, the
//         limit of running sessions, the requests' rate, then the spawn gate. A journal `auto` record and a `route` record
//         of mode auto say so, never a `human` one.
// 你不在也派 is no level: r4 D20 does not allow it (you away, no new execution task goes out), and the route refuses it.
//
// What no permission opens:
//   - a tainted session's calls go back to ask whatever its level, and what they dispatch is tainted too (r4 §8.5);
//   - while you are away or nobody knows (presence.ts), a free session's calls go back to ask (r4 D20);
//   - what a session dispatched starts at ask: no level is inherited, so nothing multiplies by itself (r4 A17);
//   - the chain of dispatches is at most DISPATCH_LIMITS.depth deep, for both levels;
//   - a sub-agent has no such tool (Codex gave it none, measured; the host refuses it for Claude): its session's level says nothing of it;
//   - a seat request never meets a level: it comes in over the port as a pending request, and only a click dispatches it;
//   - what was dispatched asks for approval as any session of its harness does: this is the going out, nothing more.
//
// Over the limit of running sessions a free call is refused and the worker told, nothing is queued: a queued call would
// hold its own worker's turn, and that worker is one of the sessions the queue waits on, so three of them could only
// time out. Nothing is lost: the worker has the task and the reason.
//
// What a tool call gets back is fixed text of this module, never another session's words. What comes of the dispatched
// session does not come back to the worker: the person sees it (its row, its card, its own talk).

export const DISPATCH_TOOL = frozen({
  name: 'orchestra_dispatch',
  description: 'Send a task to a new worker: a separate Codex or Claude session of Orchestra that works on its own. Use it only when the person asked for that or a separate worker clearly helps. '
    + 'Orchestra decides: it may ask the person first, which can take minutes, or refuse. Read the result: it says whether the worker went out. The new worker does not report back to you; the person sees its result.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'harness'],
    properties: {
      task: { type: 'string', description: 'What the new worker should do, complete in itself: it sees nothing of this conversation.' },
      harness: { type: 'string', enum: ['codex', 'claude'], description: 'Which harness runs it.' },
      model: { type: 'string', description: 'Optional: a model of the local gateway, like zcode/GLM-5.3. Left out, the harness default.' },
      cwd: { type: 'string', description: 'Optional: an absolute folder inside a project root the person opened. Left out, the worker gets its own empty folder.' },
    },
  },
});

export const DISPATCH_LIMITS = frozen({
  /** How deep a chain of dispatches goes: a session this many dispatches from a person's own may dispatch no further. */
  depth: 2,
  /** A cwd as a tool call may name it (the seat's body takes as much). */
  cwdChars: 260,
});

export const DISPATCH_LEVELS = frozen(['ask', 'free'] as const);
export type DispatchLevel = (typeof DISPATCH_LEVELS)[number];

/** Why a call was refused: a code the feed says; the tool's answer is REFUSED's text of it. */
export type DispatchRefusal =
  | 'off' | 'bad-input' | 'depth' | 'model-refused' | 'cwd-forbidden' | 'cwd-outside' | 'owned-limit' | 'harness-off' | 'start-failed' | 'record-failed'
  | 'you-rejected' | 'expired' | 'stopped' | 'gone' | RequestRefusal;

/** What the model reads; fixed text, nothing of the call is echoed back. */
const REFUSED: Readonly<Record<DispatchRefusal, string>> = frozen({
  off: 'Orchestra cannot dispatch now.',
  'bad-input': 'Not dispatched: the call needs task (text, not starting with a slash) and harness (codex or claude), and may have model and cwd. Nothing else.',
  depth: `Not dispatched: this session is ${DISPATCH_LIMITS.depth} dispatches from the person, the most Orchestra allows.`,
  'model-refused': 'Not dispatched: that model is not one this harness may run here.',
  'cwd-forbidden': 'Not dispatched: that folder is protected.',
  'cwd-outside': 'Not dispatched: that folder is not inside a project root the person opened. Leave cwd out to give the worker its own folder.',
  'owned-limit': 'Not dispatched: as many sessions run as Orchestra allows. Nothing was queued. Keep the task; it can go out once one has ended.',
  'harness-off': 'Not dispatched: that harness is off here.',
  'start-failed': 'Not dispatched: the session could not start.',
  'record-failed': 'Not dispatched: Orchestra could not write it down, so the session was ended again.',
  'you-rejected': 'The person refused this dispatch.',
  expired: 'Nobody answered in time, so this dispatch was refused.',
  stopped: 'This dispatch was withdrawn: the turn was stopped.',
  gone: 'This dispatch is no longer known to Orchestra; what became of it is unknown.',
  full: 'Not dispatched: too many requests are open. Nothing was queued.',
  rate: 'Not dispatched: too many dispatches in the last minute. Nothing was queued.',
  'requester-full': 'Not dispatched: too many of this session\'s requests are waiting for the person.',
  'text-too-long': 'Not dispatched: the task is too long.',
  'cwd-too-long': 'Not dispatched: the folder name is too long.',
});

/** What the session's talk says of a call: a note of its feed, for the driver to push. */
export type DispatchNote = { readonly state: 'worker-sent' | 'worker-sent-grant' | 'worker-asked' | 'worker-refused'; readonly ref: string | null; readonly text: string | null };
export type DispatchReply = { readonly ok: boolean; readonly text: string };
export type DispatchCall = {
  /** What the tool answers. Never rejects. */
  readonly reply: Promise<DispatchReply>;
  /** The turn was stopped or the session ended: a card still waiting goes. What already went out stays. */
  cancel(): void;
};
/** How a session was sent out: on a level (`grantAt`: the wall time the person opened it), or by a person's 派出. */
export type SentBy = { readonly by: string; readonly via: 'grant' | 'person'; readonly grantAt: number | null };

/** What a session's driver and its manager hold: the only way in from an agent's side. No level can be set through it. */
export type DispatchPort = {
  call(ownedId: string, raw: unknown, say: (n: DispatchNote) => void): DispatchCall;
  sentOf(ownedId: string): SentBy | null;
};

/** A session as the page's permission panel reads it. */
export type DispatchView = {
  readonly level: DispatchLevel;
  /** Wall ms of the person's change that set it; null while it stands at the default. */
  readonly grantAt: number | null;
  readonly depth: number;
  readonly tainted: boolean;
};

export type DispatchSession = { readonly title: string; readonly tainted: boolean; readonly over: boolean };
/** r4 §8.5: the source chain the cards of what was dispatched show: which session sent it, by which request. */
export type DispatchOrigin = { readonly kind: 'worker-dispatch'; readonly requestId: string; readonly requester: string; readonly label: string | null };
export type DispatchStart = { harness: RouteHarness; model: string; text: string; uuid: string; cwd: string | null; origin: DispatchOrigin };

export type DispatchDeps = {
  requests: Requests;
  desk: Desk | null;
  presence(): Presence;
  /** A session as orchestrad holds it, or null. */
  session(ownedId: string): DispatchSession | null;
  /** Whether a harness is on. */
  on(harness: RouteHarness): boolean;
  /** Whether a new session of that harness would be refused as owned-limit now. */
  full(harness: RouteHarness): boolean;
  /** owned-new's start, with no person: the manager's create, and so the spawn gate. */
  start(req: DispatchStart): { ok: true; ownedId: string; model: string } | { ok: false; reason: 'model-refused' | 'owned-limit' | 'cwd-failed' | 'spawn-refused'; detail: string };
  /** Ends a session that was started and could not be written down. */
  end(ownedId: string): void;
  /** Why a named cwd is refused outright (the spawn gate's table), or null. */
  judgeCwd(cwd: string): string | null;
  /** Where a session for this cwd runs; absent: no project root was named. */
  placeCwd?(cwd: string): RunIn;
  /** The `owned-cwd` record of a session in a project root (owned-handlers.ts ownedCwdRec). */
  cwdRecord(d: { actionId: string; ownedId: string; requestId: string; cwd: string }): Rec[];
  commit(records: readonly Rec[]): void;
  nowWall(): number;
  log: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
};

export type Dispatcher = DispatchPort & {
  /** A person's change, once its record is committed. */
  grant(ownedId: string, level: DispatchLevel, actionId: string): void;
  view(ownedId: string): DispatchView;
  /** A person dispatched a session's request. */
  adopted(r: AgentRequest, ownedId: string): void;
  /** What a dispatched session's cards name its sender by: its title as a label (a title may be twice as long); null when it has none or is gone. */
  labelOf(ownedId: string): string | null;
  presence(): Presence;
};

/** Whether a call of a session at `level` goes out at once, or waits for you, and why when its level said otherwise. */
export function gateOf(level: DispatchLevel, tainted: boolean, presence: Presence): { go: true } | { go: false; why: AskWhy | null } {
  if (level === 'ask') return { go: false, why: null };
  if (tainted) return { go: false, why: 'tainted' };
  if (presence === 'present') return { go: true };
  return { go: false, why: presence === 'away' ? 'away' : 'presence-unknown' };
}

type Args = { task: string; harness: RouteHarness; model: string | null; cwd: string | null };

/** A tool call's arguments as the tool's schema has them, or null. The harness checks nothing of this for us. */
export function dispatchArgs(raw: unknown): Args | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Object.keys(o).every((k) => k === 'task' || k === 'harness' || k === 'model' || k === 'cwd')) return null;
  const { task, harness, model, cwd } = o;
  if (typeof task !== 'string' || task.trim() === '' || task.trimStart().startsWith('/')) return null;
  if (typeof harness !== 'string' || !(ROUTE_HARNESSES as readonly string[]).includes(harness)) return null;
  if (model !== undefined && model !== null && typeof model !== 'string') return null;
  if (cwd !== undefined && cwd !== null && (typeof cwd !== 'string' || cwd === '' || cwd.length > DISPATCH_LIMITS.cwdChars)) return null;
  return { task, harness: harness as RouteHarness, model: model ?? null, cwd: cwd ?? null };
}

/** Whether `harness` may run `model`: the owned list, and Claude's own narrower one. */
const takes = (harness: RouteHarness, model: string): boolean => (harness === 'claude' ? isClaudeModel(model) : isOwnedModel(model));

/** The tool's way in, for the managers that are made before the dispatcher. Until it is bound every call is refused. */
export function makeDispatchLink(): { port: DispatchPort; bind(d: DispatchPort): void } {
  let to: DispatchPort | null = null;
  return Object.freeze({
    port: Object.freeze({
      call: (ownedId: string, raw: unknown, say: (n: DispatchNote) => void): DispatchCall => to?.call(ownedId, raw, say) ?? { reply: Promise.resolve({ ok: false, text: REFUSED.off }), cancel: () => {} },
      sentOf: (ownedId: string) => to?.sentOf(ownedId) ?? null,
    }),
    bind(d: DispatchPort): void {
      to = d;
    },
  });
}

export function makeDispatcher(deps: DispatchDeps): Dispatcher {
  const { requests, log } = deps;
  const levels = new Map<string, { level: DispatchLevel; at: number; actionId: string }>();
  /** Sessions a dispatch started: who sent them, and how far from a person's own they are. */
  const lines = new Map<string, SentBy & { depth: number }>();
  const depthOf = (ownedId: string) => lines.get(ownedId)?.depth ?? 0;
  const levelOf = (ownedId: string): DispatchLevel => levels.get(ownedId)?.level ?? 'ask';
  const labelOf = (ownedId: string): string | null => requests.label(deps.session(ownedId)?.title ?? '');

  const refused = (ownedId: string, why: DispatchRefusal, say: (n: DispatchNote) => void): DispatchReply => {
    log.info('dispatch-refused', { ownedId, why });
    say({ state: 'worker-refused', ref: null, text: why });
    return { ok: false, text: REFUSED[why] };
  };
  const sent = (child: string, model: string | null, harness: RouteHarness, state: DispatchNote['state'], say: (n: DispatchNote) => void): DispatchReply => {
    say({ state, ref: `n:${child}`, text: deps.session(child)?.title ?? null });
    return { ok: true, text: `Dispatched: a new ${harness} worker, session ${child}${model === null ? '' : `, on ${model}`}. Its result does not come back to you; the person sees it.` };
  };

  /** A cwd a call named, held to what a dispatch may take; null for none named. */
  const place = (cwd: string | null): { ok: true; at: RunIn } | { ok: false; why: DispatchRefusal } => {
    const none: RunIn = { runIn: null, why: 'no-roots' as RunInWhy };
    if (cwd === null) return { ok: true, at: none };
    if (deps.judgeCwd(cwd) !== null) return { ok: false, why: 'cwd-forbidden' };
    return { ok: true, at: deps.placeCwd?.(cwd) ?? none };
  };

  const direct = (ownedId: string, a: Args, say: (n: DispatchNote) => void): DispatchReply => {
    const grant = levels.get(ownedId)!;
    const model = a.model ?? ROUTE_MODELS[a.harness][0]!;
    if (!takes(a.harness, model)) return refused(ownedId, 'model-refused', say);
    const placed = place(a.cwd);
    if (!placed.ok) return refused(ownedId, placed.why, say);
    // No card to say where it would run instead: a folder it named and may not have is a refusal.
    if (a.cwd !== null && placed.at.runIn === null) return refused(ownedId, 'cwd-outside', say);
    if (deps.full(a.harness)) return refused(ownedId, 'owned-limit', say);
    const made = requests.create({ harness: a.harness, text: a.task, cwd: a.cwd ?? '', label: null, requester: { kind: 'owned', sessionId: ownedId }, runIn: placed.at.runIn, runInWhy: placed.at.why, tainted: false, model, auto: true });
    if (!made.ok) return refused(ownedId, made.why, say);
    const r = made.request;
    if (a.cwd !== null && r.runIn === null) {
      requests.fail(r.requestId, 'start-failed');
      return refused(ownedId, 'cwd-outside', say);
    }
    const actionId = crypto.randomUUID();
    const started = deps.start({ harness: a.harness, model, text: r.text, uuid: actionId, cwd: r.runIn, origin: { kind: 'worker-dispatch', requestId: r.requestId, requester: ownedId, label: labelOf(ownedId) } });
    if (!started.ok) {
      requests.fail(r.requestId, 'start-failed');
      log.warn('dispatch-start-failed', { ownedId, harness: a.harness, reason: started.reason, detail: started.detail });
      return refused(ownedId, started.reason === 'model-refused' ? 'model-refused' : started.reason === 'owned-limit' ? 'owned-limit' : 'start-failed', say);
    }
    const child = started.ownedId;
    requests.bind(r.requestId, child);
    const depth = depthOf(ownedId) + 1;
    lines.set(child, { by: ownedId, via: 'grant', grantAt: grant.at, depth });
    const decision = deps.desk?.auto(r.text, { actionId, ownedId: child, harness: a.harness, model: started.model }) ?? null;
    const decisionId = decision === null ? null : String((decision.body as { decisionId: unknown }).decisionId);
    try {
      deps.commit([
        ...(decision === null ? [] : [decision]),
        { kind: 'auto', body: { actionId, requestId: r.requestId, by: ownedId, ownedId: child, harness: a.harness, model: started.model, grantActionId: grant.actionId, depth, textDigest: canonicalDigest(r.text), decisionId } },
        ...(r.runIn === null ? [] : deps.cwdRecord({ actionId, ownedId: child, requestId: r.requestId, cwd: r.runIn })),
      ]);
    } catch (e) {
      // 每一次都留记录: what cannot be written down does not stay out.
      log.warn('dispatch-record-failed', { ownedId, child, error: e });
      deps.end(child);
      return refused(ownedId, 'record-failed', say);
    }
    deps.desk?.dispatched({ ownedId: child, harness: a.harness, model: started.model, auto: true });
    log.info('dispatch-auto', { ownedId, child, harness: a.harness, model: started.model, depth });
    return sent(child, started.model, a.harness, 'worker-sent-grant', say);
  };

  const ask = (ownedId: string, a: Args, tainted: boolean, why: AskWhy | null, say: (n: DispatchNote) => void): DispatchCall => {
    const done = (reply: DispatchReply): DispatchCall => ({ reply: Promise.resolve(reply), cancel: () => {} });
    if (a.model !== null && !takes(a.harness, a.model)) return done(refused(ownedId, 'model-refused', say));
    const placed = place(a.cwd);
    if (!placed.ok) return done(refused(ownedId, placed.why, say));
    const made = requests.create({
      harness: a.harness, text: a.task, cwd: a.cwd ?? '', label: null, requester: { kind: 'owned', sessionId: ownedId }, runIn: placed.at.runIn, runInWhy: placed.at.why, tainted, model: a.model, askWhy: why,
    });
    if (!made.ok) return done(refused(ownedId, made.why, say));
    const id = made.request.requestId;
    say({ state: 'worker-asked', ref: id, text: why });
    const settle = (r: AgentRequest): DispatchReply => {
      if (r.ownedId !== null) return sent(r.ownedId, r.model, r.harness, 'worker-sent', say);
      return refused(ownedId, r.state === 'rejected' ? 'you-rejected' : r.state === 'expired' ? 'expired' : r.state === 'withdrawn' ? 'stopped' : 'gone', say);
    };
    const reply = (async (): Promise<DispatchReply> => {
      for (;;) {
        const r = requests.get(id);
        if (r === null) return refused(ownedId, 'gone', say);
        if (r.state !== 'pending') return settle(r);
        await requests.wait(id, REQUEST_LIMITS.ttlMs);
      }
    })();
    return {
      reply,
      cancel() {
        if (requests.get(id)?.state === 'pending') requests.withdraw(id, made.withdrawKey);
      },
    };
  };

  const call = (ownedId: string, raw: unknown, say: (n: DispatchNote) => void): DispatchCall => {
    const done = (reply: DispatchReply): DispatchCall => ({ reply: Promise.resolve(reply), cancel: () => {} });
    const s = deps.session(ownedId);
    if (s === null || s.over) return done(refused(ownedId, 'off', say));
    const a = dispatchArgs(raw);
    if (a === null || utf8Length(a.task) > REQUEST_LIMITS.textBytes) return done(refused(ownedId, a === null ? 'bad-input' : 'text-too-long', say));
    if (depthOf(ownedId) >= DISPATCH_LIMITS.depth) return done(refused(ownedId, 'depth', say));
    if (!deps.on(a.harness)) return done(refused(ownedId, 'harness-off', say));
    const gate = gateOf(levelOf(ownedId), s.tainted, deps.presence());
    return gate.go ? done(direct(ownedId, a, say)) : ask(ownedId, a, s.tainted, gate.why, say);
  };

  return Object.freeze({
    call,
    sentOf(ownedId: string): SentBy | null {
      const l = lines.get(ownedId);
      return l === undefined ? null : Object.freeze({ by: l.by, via: l.via, grantAt: l.grantAt });
    },
    grant(ownedId: string, level: DispatchLevel, actionId: string): void {
      levels.set(ownedId, { level, at: deps.nowWall(), actionId });
    },
    view(ownedId: string): DispatchView {
      const g = levels.get(ownedId);
      return Object.freeze({ level: g?.level ?? 'ask', grantAt: g?.at ?? null, depth: depthOf(ownedId), tainted: deps.session(ownedId)?.tainted === true });
    },
    adopted(r: AgentRequest, ownedId: string): void {
      if (r.requester.kind !== 'owned') return;
      lines.set(ownedId, { by: r.requester.sessionId, via: 'person', grantAt: null, depth: depthOf(r.requester.sessionId) + 1 });
    },
    labelOf,
    presence: () => deps.presence(),
  });
}
