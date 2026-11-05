// What the Agent SDK says of a sub-agent, as measured on CLI 2.1.287 through the host (2026-11-05, 14 probes and the
// live runs): the message types, fields, order and states as they came, the ids made up, and no word any model wrote
// (SUB_WORDS stands for them and must never reach a frame or a feed; a prompt and a summary are only here to be left out).
//
// One background sub-agent, the default: the root's Agent call, its card allowed, task_started with is_backgrounded
// true, the root's turn may end here; then the sub-agent's messages with parent_tool_use_id set, task_progress beside
// them, a foreground command as a local_bash task of its own, and the end as task_updated then task_notification.

import type { Msg } from './fake-sdk.ts';

export const SUB_WORDS = 'SUB-AGENT-WORDS';
export const ROOT_CALL = 'call_root_0001';
export const SUB_CALL = 'call_sub_0001';
export const TASK = 'abad7ff68ba9672c9';
export const BASH_TASK = 'bn48vce49';
export const REPLY = 'msg_reply_0001';
export const MODEL = 'opencode-go/claude-haiku-5-5';

/** The root's Agent call, one content block of the reply `reply`. */
export const rootCall = (id = ROOT_CALL, reply = REPLY, model = MODEL): Msg => ({
  type: 'assistant', parent_tool_use_id: null, uuid: 'a0000000-0000-4000-8000-000000000001',
  message: { id: reply, model, content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'ping once', prompt: SUB_WORDS, subagent_type: 'general-purpose' } }] },
});

export const taskStarted = (over: Msg = {}): Msg => ({
  type: 'system', subtype: 'task_started', task_id: TASK, tool_use_id: ROOT_CALL, subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true, spawn_depth: 1,
  description: 'ping once', prompt: SUB_WORDS, ...over,
});

/** What a sub-agent's model wrote: `content` as it came, one block a message. */
export const subAssistant = (block: Msg, parent = ROOT_CALL, model = MODEL): Msg => ({
  type: 'assistant', parent_tool_use_id: parent, subagent_type: 'general-purpose', uuid: 'a0000000-0000-4000-8000-000000000002', message: { id: 'msg_sub', model, content: [block] },
});
export const subText = (parent = ROOT_CALL): Msg => subAssistant({ type: 'text', text: SUB_WORDS }, parent);
export const subToolUse = (id = SUB_CALL, name = 'PowerShell', parent = ROOT_CALL): Msg => subAssistant({ type: 'tool_use', id, name, input: { command: 'ping -n 2 127.0.0.1' } }, parent);

/** What came back of its tool call. A success has no is_error (measured). */
export const subResult = (id = SUB_CALL, isError = false, parent = ROOT_CALL): Msg => ({
  type: 'user', parent_tool_use_id: parent, subagent_type: 'general-purpose', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: SUB_WORDS, ...(isError ? { is_error: true } : {}) }] },
});

export const taskProgress = (): Msg => ({
  type: 'system', subtype: 'task_progress', task_id: TASK, tool_use_id: ROOT_CALL, subagent_type: 'general-purpose', last_tool_name: 'PowerShell',
  usage: { total_tokens: 204, tool_uses: 1, duration_ms: 7005 }, description: 'Running ping', summary: SUB_WORDS,
});

export const bashStarted = (toolUseId = SUB_CALL): Msg => ({ type: 'system', subtype: 'task_started', task_id: BASH_TASK, tool_use_id: toolUseId, task_type: 'local_bash', is_backgrounded: false, description: 'ping' });
export const bashEnded = (toolUseId = SUB_CALL, status = 'completed'): Msg => ({ type: 'system', subtype: 'task_notification', task_id: BASH_TASK, tool_use_id: toolUseId, status, summary: SUB_WORDS, output_file: '' });

export const taskUpdated = (status: string, taskId = TASK): Msg => ({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status, end_time: 1_793_872_857_366 } });
export const taskNotification = (status: string, taskId = TASK): Msg => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: ROOT_CALL, status, summary: SUB_WORDS, output_file: '',
  ...(status === 'completed' ? { usage: { total_tokens: 6682, tool_uses: 2, duration_ms: 19_538 } } : {}),
});
