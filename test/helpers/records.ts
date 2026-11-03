// Journal record builders for the store tests (plan step 3): one valid body per kind, built the way
// a source, the model or a human verb would hand it to Store.commit().
import * as crypto from 'node:crypto';
import type { Line, Rec, Tail } from '../../src/store/journal.ts';
import { canonicalDigest } from '../../src/store/canonical-json.ts';
import { chainHash } from '../../src/store/journal.ts';

export const digestOf = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** A fixed version-4 UUID per name, so a scenario is the same on every run. */
export function uuidOf(name: string): string {
  const h = digestOf(`uuid:${name}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type Cause = { kind: 'source'; partRef: string; srcSeq: number } | { kind: 'human'; actionId: string } | { kind: 'clock'; timerId: string };

export const srcCause = (partRef: string, srcSeq: number): Cause => ({ kind: 'source', partRef, srcSeq });
export const humanCause = (actionId: string): Cause => ({ kind: 'human', actionId });
export const clockCause = (timerId: string): Cause => ({ kind: 'clock', timerId });

export const R = {
  project: (projectId: string, cwd: string, hue = 0): Rec => ({ kind: 'project', body: { projectId, cwd, hue } }),
  part: (partRef: string, o: { harness?: string; projectId?: string | null; cwd?: string | null; version?: string | null } = {}): Rec => ({
    kind: 'part', body: { partRef, harness: o.harness ?? 'claude', projectId: o.projectId ?? null, cwd: o.cwd ?? null, version: o.version ?? null },
  }),
  cursor: (partRef: string, cursor: number, srcSeq: number): Rec => ({ kind: 'part.cursor', body: { partRef, cursor, srcSeq } }),
  event: (partRef: string, srcSeq: number, o: { evKind?: string; srcTime?: number | null; precision?: string; snippetRef?: string | null; tool?: string | null; errorCode?: string | null } = {}): Rec => ({
    kind: 'event',
    body: {
      partRef, srcSeq, srcTime: o.srcTime ?? null, srcTimePrecision: o.precision ?? (o.srcTime == null ? 'none' : 'ms'), evKind: o.evKind ?? 'waiting',
      digest: digestOf(`${partRef}:${srcSeq}`), snippetRef: o.snippetRef ?? null, tool: o.tool ?? null, errorCode: o.errorCode ?? null,
    },
  }),
  item: (itemId: string, o: { itemKind?: string; sev?: string; group?: string; conf?: string; projectId?: string | null; partRef?: string | null; dedup?: string; reminderId?: string | null } = {}): Rec => ({
    kind: 'item',
    body: {
      itemId, itemKind: o.itemKind ?? 'question', sev: o.sev ?? 'P1', group: o.group ?? 'fermatas', conf: o.conf ?? 'high',
      projectId: o.projectId ?? null, partRef: o.partRef ?? null, dedupKey: digestOf(o.dedup ?? itemId), reminderId: o.reminderId ?? null,
    },
  }),
  tr: (entity: 'inbox_item' | 'reminder', id: string, from: string, to: string, cause: Cause): Rec => ({ kind: 'transition', body: { entity, id, from, to, cause } }),
  snooze: (itemId: string, untilWall: number): Rec => ({ kind: 'snooze', body: { itemId, untilWall } }),
  reminder: (reminderId: string, dueWall: number, snippetRef: string | null = null, projectId: string | null = null): Rec => ({ kind: 'reminder', body: { reminderId, dueWall, snippetRef, projectId } }),
  notified: (itemId: string, attempt: number, via: 'browser' | 'toast', atMono: number, atWall: number): Rec => ({ kind: 'notified', body: { itemId, attempt, via, atMono, atWall } }),
  human: (actionId: string, verb: string, targetId: string | null = null, request = 'r'): Rec => ({ kind: 'human', body: { actionId, verb, targetId, requestDigest: digestOf(request) } }),
  /** A human.result repeats its human record's verb and target (apply holds them equal). */
  result: (actionId: string, verb: string, targetId: string | null = null, outcome = 'applied', commandId: string | null = null, subtrees: unknown[] | null = null): Rec => ({
    kind: 'human.result', body: { actionId, verb, targetId, outcome, commandId, subtrees },
  }),
  clock: (timerId: string, clock: 'mono' | 'wall', durationMs: number, firedMono: number, firedWall: number): Rec => ({ kind: 'clock', body: { timerId, clock, durationMs, firedMono, firedWall } }),
  judgment: (inputDigest: string, value?: Record<string, unknown>): Rec => ({
    kind: 'judgment', body: { name: 'redact', inputDigest, ver: 1, value: value ?? { ver: 1, dropped: null, known: 0, format: {}, entropy: 0 } },
  }),
  protect: (op: 'add' | 'remove', pid: number, createTime: string): Rec => ({ kind: 'protect', body: { op, pid, createTime, reason: 'tuning' } }),
  command: (commandId: string, actionId: string, subtrees: { root: { pid: number; createTime: string }; requestId: string; killed: number; residual: number; status: string }[], status: string): Rec => ({
    kind: 'command', body: { commandId, actionId, verb: 'kill-tree', harness: { pid: 100, createTime: '133000000000000000' }, status, subtrees },
  }),
  /** A brake plan made at (createdMono, createdWall); expiresAt is createdWall + 60 s. */
  plan: (planId: string, createdMono: number, createdWall: number): Rec => ({
    kind: 'brake.plan',
    body: {
      planId, harness: { pid: 100, createTime: '133000000000000000' }, roots: [{ pid: 101, createTime: '133000000000000001' }],
      nodes: [{ pid: 101, createTime: '133000000000000001' }, { pid: 102, createTime: '133000000000000002' }], protected: [], createdMono, createdWall, ttlMs: 60_000, expiresAt: createdWall + 60_000,
    },
  }),
};

/** One valid record of every kind a caller may append, in an order a fresh store applies. */
/** A RouteDecision (the dispatch desk's `route` record) for a dispatch of `ownedId` by the action `actionId`: the person took the router model's pick. */
export function routeRec(actionId: string, ownedId: string, over: Record<string, unknown> = {}): Rec {
  const body = {
    actionId, routeId: 'fedcba9876543210fedc', ownedId, taskClass: 'code', rules: ['code-or-command', 'fallback'],
    candidates: [
      { harness: 'claude', model: 'zcode/GLM-5.3', source: 'model', rule: null },
      { harness: 'codex', model: 'codex/gpt-6.1-sol', source: 'rule', rule: 'code-or-command' },
    ],
    chosen: { harness: 'claude', model: 'zcode/GLM-5.3' }, pick: 0, reason: 'router-model', router: 'answered', routerModel: 'zcode/GLM-5.3', routerWhy: null, mode: 'manual', ...over,
  };
  return { kind: 'route', body: { decisionId: canonicalDigest(body), ...body } };
}

/** A person's decision on an agent request (seat's `agent-request` record): dispatched as `ownedId`, naming its RouteDecision, or rejected. */
export function agentRequestRec(actionId: string, over: Record<string, unknown> = {}): Rec {
  return {
    kind: 'agent-request',
    body: {
      requestId: 'abcdef0123456789abcd', actionId, verdict: 'dispatched', harness: 'codex', requesterKind: 'dsh', requesterDigest: canonicalDigest('dsh:sess-1'),
      ownedId: '0123456789abcdef0123', decisionId: canonicalDigest('a decision'), ...over,
    },
  };
}

export function oneOfEach(): Rec[][] {
  const a = uuidOf('each-action');
  const b = uuidOf('each-brake');
  const sub = { root: { pid: 101, createTime: '133000000000000001' }, requestId: 'req-1', killed: 3, residual: 0, status: 'ok' };
  return [
    [R.project('prj1', 'C:\\work\\demo', 3), R.part('p1', { projectId: 'prj1', cwd: 'C:\\work\\demo', version: '2.1.4' })],
    [R.event('p1', 1, { tool: 'Bash', srcTime: 1_761_868_800, precision: 's' }), R.item('i1', { partRef: 'p1', projectId: 'prj1' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1)), R.cursor('p1', 120, 1)],
    [R.notified('i1', 1, 'browser', 5000, 1_761_868_801_000)],
    [R.tr('inbox_item', 'i1', 'open', 'snoozed', humanCause(a)), R.snooze('i1', 1_761_872_400_000), R.human(a, 'snooze', 'i1'), R.result(a, 'snooze', 'i1')],
    [R.reminder('rem1', 1_761_900_000_000), R.tr('reminder', 'rem1', 'none', 'pending', humanCause(uuidOf('each-remind'))), R.human(uuidOf('each-remind'), 'remind'), R.result(uuidOf('each-remind'), 'remind', null)],
    [
      R.clock('reminder:rem1:0', 'wall', 31_200_000, 9000, 1_761_900_000_000), R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem1:0')),
      R.item('i2', { itemKind: 'reminder', group: 'reminders', sev: 'P1', reminderId: 'rem1' }), R.tr('inbox_item', 'i2', 'none', 'open', clockCause('reminder:rem1:0')),
    ],
    [R.judgment(digestOf('raw text'), { ver: 1, dropped: null, known: 1, format: { 'sk-ant': 2 }, entropy: 0 })],
    [R.plan('plan1', 1000, 1_761_868_800_000)],
    // A brake: `human` after the check order, before execution; the Command and `human.result` once it is done.
    [R.human(b, 'brake', '101:133000000000000001')],
    [R.command('cmd1', b, [sub], 'ok'), R.result(b, 'brake', '101:133000000000000001', 'applied', 'cmd1', [sub])],
    [R.protect('add', 4242, '133000000000000042')],
    // A dispatch from the dispatch desk: owned-new's human records and its RouteDecision, one batch.
    [R.human(uuidOf('each-route'), 'owned-new', '0123456789abcdef0123'), R.result(uuidOf('each-route'), 'owned-new', '0123456789abcdef0123'), routeRec(uuidOf('each-route'), '0123456789abcdef0123')],
    // seat: a person rejects an agent request: request-reject's human records and the `agent-request` record, one batch.
    [
      R.human(uuidOf('each-reject'), 'request-reject', 'abcdef0123456789abcd'), R.result(uuidOf('each-reject'), 'request-reject', 'abcdef0123456789abcd'),
      agentRequestRec(uuidOf('each-reject'), { verdict: 'rejected', ownedId: null, decisionId: null }),
    ],
  ];
}

/** The commit record of a batch of `count` records stamped (bootId, obsMono, obsWall), as the journal writes it. */
export const commitRec = (count: number, bootId: string, obsMono = 1, obsWall = 2): Rec => ({ kind: 'commit', body: { count, bootId, obsMono, obsWall } });

/** Lines as the journal would write them, but without any check: what a corrupted or hand-made journal could hold. */
export function rawBatch(after: Tail, recs: Rec[], bootId = uuidOf('raw-boot')): Line[] {
  let prev = after;
  return [...recs, commitRec(recs.length, bootId)].map((r) => {
    const digest = canonicalDigest(r.body);
    const line = { jseq: prev.jseq + 1, bootId, obsMono: 1, obsWall: 2, kind: r.kind, body: r.body, digest, prevHash: prev.hash, hash: chainHash(prev.hash, digest) };
    prev = { jseq: line.jseq, hash: line.hash };
    return line as Line;
  });
}
