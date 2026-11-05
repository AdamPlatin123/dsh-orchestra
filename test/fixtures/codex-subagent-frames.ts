// The sub-agent event sequences measured on codex-cli 0.165.0 (2026-11-04, three real runs through a local
// recording proxy), as frames for an in-memory pipe: the methods, fields, order and states as they came, the
// thread, turn and item ids made up, the times taken from the runs, and no word any model wrote (aggregated
// output and message text are left out or replaced by CHILD_WORDS, which must never reach a feed).
// Frames that are the root thread's own message items are left out too: they do not bear on the members.

export const ROOT = 'thr';
export const CHILD = '01a1a882-8697-73f0-9a8d-0a68bde66d08';
export const ROOT_TURN = 'turn-root';
export const CHILD_TURN = 'turn-child';
export const CHILD_WORDS = 'CHILD-THREAD-WORDS';

/** The start of the child's life in the runs, in wall ms; its turn's times are whole seconds. */
export const T0 = 1_793_828_488_917;
export const SECS0 = 1_793_828_488;

export type Frame = { method: string; params: Record<string, unknown> };
const note = (method: string, params: Record<string, unknown>): Frame => ({ method, params });

export const statusOf = (type: string, threadId = CHILD, activeFlags?: string[]): Frame =>
  note('thread/status/changed', { threadId, status: activeFlags === undefined ? { type } : { type, activeFlags } });

export const childTurn = (method: 'turn/started' | 'turn/completed', over: Record<string, unknown> = {}, threadId = CHILD): Frame =>
  note(method, {
    threadId,
    turn: {
      id: CHILD_TURN, rootTurnId: ROOT_TURN, items: [], itemsView: 'notLoaded', error: null, startedAt: SECS0,
      ...(method === 'turn/started' ? { status: 'inProgress', completedAt: null, durationMs: null } : { status: 'completed', completedAt: SECS0 + 16, durationMs: 15_978 }),
      ...over,
    },
  });

/** subAgentActivity comes as item/started and item/completed in the same millisecond, on the root thread; `completed` has no model. */
export const activity = (phase: 'started' | 'completed', kind: string, at: number, agentThreadId = CHILD, agentPath: string | undefined = '/root/ping_once'): Frame =>
  note(`item/${phase}`, {
    threadId: ROOT, turnId: ROOT_TURN, [phase === 'started' ? 'startedAtMs' : 'completedAtMs']: at,
    item: {
      type: 'subAgentActivity', id: kind === 'started' ? 'call_spawn' : `subagent-${kind}-${CHILD_TURN}`, kind, agentThreadId, agentPath,
      model: kind === 'started' ? 'codex/gpt-6.1-sol' : null, reasoningEffort: kind === 'started' ? 'low' : null,
    },
  });

/** A collab tool call (v1, and wait on v2): receiverThreadIds and agentsStates as that step measured them. */
export const collab = (phase: 'started' | 'completed', tool: string, at: number, receiverThreadIds: unknown = [], agentsStates: unknown = {}, status: string = phase === 'started' ? 'inProgress' : 'completed'): Frame =>
  note(`item/${phase}`, {
    threadId: ROOT, turnId: ROOT_TURN, [phase === 'started' ? 'startedAtMs' : 'completedAtMs']: at,
    item: { type: 'collabAgentToolCall', id: `call_${tool}`, tool, status, senderThreadId: ROOT, receiverThreadIds, prompt: null, model: null, reasoningEffort: null, agentsStates },
  });

export const childCommand = (phase: 'started' | 'completed', at: number, status: string, exitCode: number | null = null): Frame =>
  note(`item/${phase}`, {
    threadId: CHILD, turnId: CHILD_TURN, [phase === 'started' ? 'startedAtMs' : 'completedAtMs']: at,
    item: { type: 'commandExecution', id: 'exec-child', command: 'ping', cwd: 'C:\\work', status, commandActions: [{ type: 'unknown', command: 'ping' }], aggregatedOutput: phase === 'started' ? null : CHILD_WORDS, exitCode },
  });

export const childMessage = (at: number): Frame[] => [
  note('item/started', { threadId: CHILD, turnId: CHILD_TURN, startedAtMs: at, item: { type: 'agentMessage', id: 'msg-child', text: '' } }),
  note('item/agentMessage/delta', { threadId: CHILD, turnId: CHILD_TURN, itemId: 'msg-child', delta: CHILD_WORDS }),
  note('item/completed', { threadId: CHILD, turnId: CHILD_TURN, completedAtMs: at, item: { type: 'agentMessage', id: 'msg-child', text: CHILD_WORDS } }),
];

const usage = { totalTokens: 33_363, inputTokens: 33_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 363, reasoningOutputTokens: 0 };
export const childTokens: Frame = note('thread/tokenUsage/updated', { threadId: CHILD, turnId: CHILD_TURN, tokenUsage: { total: usage, last: usage, modelContextWindow: 258_400 } });

/** The approval as it came (run 1): the child's threadId and turnId, and availableDecisions on the wire. */
export const childApproval = (id: number) => ({
  id, method: 'item/commandExecution/requestApproval',
  params: {
    kind: 'command', threadId: CHILD, turnId: CHILD_TURN, itemId: 'exec-child', startedAtMs: T0 + 6_069, environmentId: 'local', command: 'ping', cwd: 'C:\\Users\\u\\.orchestra\\work\\0123456789abcdef0123',
    commandActions: [{ type: 'unknown', command: 'ping' }], proposedExecpolicyAmendment: ['ping'], availableDecisions: ['accept', 'decline'],
  },
});
export const resolved = (requestId: number): Frame => note('serverRequest/resolved', { threadId: CHILD, requestId });

/** v2 (codex/gpt-6.1-sol, run 1), up to the approval: subAgentActivity builds the member. */
export const V2_TO_APPROVAL: readonly Frame[] = [
  activity('started', 'started', T0),
  statusOf('idle'),
  activity('completed', 'started', T0),
  statusOf('active', CHILD, []),
  childTurn('turn/started'),
  collab('started', 'wait', T0 + 4_521),
  statusOf('active', CHILD, ['waitingOnApproval']),
  childCommand('started', T0 + 6_071, 'inProgress'),
];

/** v2 after the approval, to the end of the root turn. */
export const V2_FROM_APPROVAL: readonly Frame[] = [
  statusOf('active', CHILD, []),
  childCommand('completed', T0 + 12_479, 'completed', 0),
  childTokens,
  ...childMessage(T0 + 15_820),
  activity('started', 'completed', T0 + 15_982),
  statusOf('idle'),
  childTurn('turn/completed'),
  activity('completed', 'completed', T0 + 15_982),
  collab('completed', 'wait', T0 + 15_986),
];

/** v1 (zcode/GLM-5.3, run 2), up to the approval. The child's first status comes before the spawn's item/completed. */
export const V1_TO_APPROVAL: readonly Frame[] = [
  collab('started', 'spawnAgent', T0),
  statusOf('idle'),
  collab('completed', 'spawnAgent', T0 + 55, [CHILD], { [CHILD]: { status: 'pendingInit', message: null } }),
  statusOf('active', CHILD, []),
  childTurn('turn/started'),
  collab('started', 'wait', T0 + 5_239, [CHILD]),
  statusOf('active', CHILD, ['waitingOnApproval']),
  childCommand('started', T0 + 7_186, 'inProgress'),
];

/** v1 after the approval: wait carries the state, closeAgent unloads the thread; no subAgentActivity at all. */
export const V1_FROM_APPROVAL: readonly Frame[] = [
  statusOf('active', CHILD, []),
  childCommand('completed', T0 + 12_945, 'completed', 0),
  childTokens,
  ...childMessage(T0 + 17_034),
  statusOf('idle'),
  childTurn('turn/completed', { completedAt: SECS0 + 17, durationMs: 17_001 }),
  collab('completed', 'wait', T0 + 17_060, [CHILD], { [CHILD]: { status: 'completed', message: CHILD_WORDS } }),
  collab('started', 'closeAgent', T0 + 22_501, [CHILD]),
  statusOf('notLoaded'),
  collab('completed', 'closeAgent', T0 + 22_505, [CHILD], { [CHILD]: { status: 'completed', message: CHILD_WORDS } }),
];

/**
 * A stop (2026-11-04, three more runs, stop run 3 for these times; a member in a long command). turn/interrupt on
 * its thread is answered {}, these two follow in the same millisecond, and no subAgentActivity comes; the command
 * is still running then, and still in the Job.
 */
export const STOP_INTERRUPTED: readonly Frame[] = [
  statusOf('idle'),
  childTurn('turn/completed', { status: 'interrupted', completedAt: SECS0 + 10, durationMs: 10_061 }),
];

/** What thread/backgroundTerminals/clean brings, 5 ms after its {}: the command's end, under the turn that already ended. */
export const STOP_CLEANED: readonly Frame[] = [childCommand('completed', T0 + 12_500, 'failed', -1)];
