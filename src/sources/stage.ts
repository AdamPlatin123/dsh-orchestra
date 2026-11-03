import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import type { Clock } from '../runtime/clock.ts';
import type { PeekNote, PeekSession, PeekView, Redact, SubagentFile } from './peek.ts';
import { ReadGateError } from '../fs/read-gate.ts';
import { PEEK_LIMITS, eachRecord, fairShare, findSession, keepPinned, listSessions, listSubagents, readSession, shown, sourceMs } from './peek.ts';
import { STAGE_RULE_IDS } from '../../shared/stage-contract.js';
import { frozen } from '../../shared/frozen.js';

// The stage preview (0.1 alpha design §3-§4): who plays in each project, who dispatched what to whom,
// what came back, and who waits on you, read from the same sessions the peek page lists: Claude
// transcripts, DSH logs and Codex rollouts (orchestra app plan §1: the three harnesses alike). A labelled M2
// preview (r4:2051): step 4 or 5 merges or deletes it, together with GET /api/peek/stage.
//
// Read-only and stateless but for a memo: every read goes through the read gate via peek.ts's readers
// (the same tail, frame and size limits), time comes only from the Clock, and nothing is written. Every
// source string that leaves passes shown() (redacted, cleaned, clipped to 120), no path leaves at all
// (lanes and players are named by digests), and the memo holds only what shown() already made.
//
// Honesty rules the snapshot carries (design §2): no item claims a verdict (D19: only a non-author
// reviewer or you can call work done; M0 has neither), done criteria are always undeclared, reported is
// the furthest an item gets, and every rule reports n 0 (no sample checked against real data yet), so
// the page can only show it untested. Every key path below that the repo has not verified on real data
// lives in KEYS; an event that is there without its keys counts as a mismatch, never as empty.

const win = path.win32;

export const STAGE_LIMITS = frozen({
  /**
   * Principals (tree roots) in one snapshot, newest first, shared between the harnesses (each gets a
   * floor; peek.ts fairShare). Only Claude transcripts are cut to this many before they are read; every
   * listed DSH log and Codex rollout is read (a Codex subagent is a rollout of its own, so whose root it
   * is shows only after the read), within decodedPerBuild.
   */
  principals: 24,
  /** Subagent files read under one Claude transcript (newest first), so clones under any parent stay within 16. */
  clonesPerParent: 16,
  /** Deepest player: a principal is 0. */
  depth: 4,
  /** Items on one stand. */
  standItems: 12,
  /** One source string, as shown() clips it. */
  textChars: 120,
  /** Work items in one lane. */
  itemsPerLane: 64,
  /** The JSON body: whole lanes go, oldest first, past it. */
  bodyBytes: 256 * 1024,
  /** Tool calls the instrument looks at: the last ones. */
  window: 20,
  /** A file written this recently plays solid. */
  solidAgeMs: 60 * 1000,
  /** An unjoined or unpaired clone this old, under a parent that is not busy, is a possible orphan. */
  ghostAgeMs: 10 * 60 * 1000,
  /** Events a session detail shows: the last ones. */
  events: 50,
  /** A registry entry or a subagent meta file larger than this is not read. */
  smallFileBytes: 16 * 1024,
  /**
   * Digests kept between snapshots: after each build every entry it did not touch goes, so the memo
   * holds one build's files (at most 24 x (1 + 2 x 16) + 60 = 852); this ceiling is only a backstop.
   */
  memoEntries: 1024,
  /** A snapshot asked for again within this long (monotonic) is the same snapshot. */
  throttleMs: 2000,
  /** A Codex wait inferred from an unanswered call reads as one only while the rollout is younger than this. */
  codexWaitMaxAgeMs: 6 * 60 * 60 * 1000,
  /** A Codex call's arguments longer than this are not parsed (only spawn, plan and shell calls are). */
  codexArgsChars: 64 * 1024,
  /**
   * Text one build may decode afresh from DSH logs and Codex rollouts (the memo's files cost nothing).
   * A file is read only while what is left covers its own ceiling (peek.ts PEEK_LIMITS), so no read is
   * cut by this budget; the rest wait for the next build, newest first, and count as not shown till then.
   */
  decodedPerBuild: 256 * 1024 * 1024,
  /** Session details kept between calls, by file size and mtime (an archived .zst is decoded once). */
  detailMemo: 4,
});

/** n per rule: samples checked against real data. None yet in the alpha, so every rule shows untested. */
export const RULES: readonly { id: string; n: number }[] = frozen(STAGE_RULE_IDS.map((id: string) => ({ id, n: 0 })));

export type KeyUnit = 'claude-tool' | 'claude-result' | 'claude-meta' | 'claude-registry' | 'dsh-head' | 'dsh-event' | 'codex-record' | 'codex-plan';

/**
 * One inferred key shape. `when` says whether a unit carries the event at all (a value at `path` in
 * `in`, a trailing `*` matching a prefix, or a positive number); `paths` are the keys the event must
 * then carry (`a[].b`: every element of the array a has b). claude-result units are Claude user
 * records that hold the tool_result of a Task or Agent call: the reader decides that, so `when` is null.
 * codex-record units are Codex rollout lines; codex-plan units are the parsed arguments of an
 * update_plan call (a JSON string in the rollout).
 */
export type KeyEntry = {
  id: string;
  unit: KeyUnit;
  rule: string;
  when: { path: string; in: readonly string[] } | { path: string; positive: true } | null;
  paths: readonly string[];
};

const TASK_TOOLS: readonly string[] = ['Task', 'Agent'];

/** Every key path the stage relies on that the repo has not verified on real data (design T8). */
export const KEYS: readonly KeyEntry[] = frozen([
  { id: 'claude.todo', unit: 'claude-tool', rule: 'claude.stand.todo-keys', when: { path: 'name', in: ['TodoWrite'] }, paths: ['input.todos[].content', 'input.todos[].status'] },
  { id: 'claude.task', unit: 'claude-tool', rule: 'claude.clone.running', when: { path: 'name', in: TASK_TOOLS }, paths: ['id', 'input.description', 'input.prompt'] },
  { id: 'claude.task-result', unit: 'claude-result', rule: 'claude.join.agentId', when: null, paths: ['toolUseResult.agentId'] },
  { id: 'claude.subagent-meta', unit: 'claude-meta', rule: 'claude.join.description', when: null, paths: ['agentType', 'description'] },
  { id: 'claude.registry', unit: 'claude-registry', rule: 'claude.live.registry', when: null, paths: ['sessionId'] },
  { id: 'claude.registry-waiting', unit: 'claude-registry', rule: 'fermata.registry-waiting', when: { path: 'status', in: ['waiting'] }, paths: ['waitingFor'] },
  { id: 'dsh.child', unit: 'dsh-head', rule: 'dsh.child.parentSession', when: { path: 'delegationDepth', positive: true }, paths: ['parentSession'] },
  { id: 'dsh.todo', unit: 'dsh-event', rule: 'dsh.stand.todo-keys', when: { path: 'type', in: ['todo/write'] }, paths: ['data.todos[].content', 'data.todos[].status'] },
  { id: 'dsh.goal', unit: 'dsh-event', rule: 'dsh.stand.goal-keys', when: { path: 'type', in: ['goal/change'] }, paths: ['data.goal'] },
  { id: 'dsh.team-member', unit: 'dsh-event', rule: 'dsh.team-task-keys', when: { path: 'type', in: ['team/member/*'] }, paths: ['data.memberId', 'data.name'] },
  { id: 'dsh.team-task', unit: 'dsh-event', rule: 'dsh.team-task-keys', when: { path: 'type', in: ['team/task/*'] }, paths: ['data.taskId', 'data.title', 'data.owner', 'data.status'] },
  { id: 'dsh.catalog', unit: 'dsh-event', rule: 'dsh.child.parentSession', when: { path: 'type', in: ['subagent/catalog'] }, paths: ['data.childId', 'data.description'] },
  { id: 'dsh.tool', unit: 'dsh-event', rule: 'instrument.tool-map', when: { path: 'type', in: ['tool/call'] }, paths: ['data.name'] },
  { id: 'codex.meta', unit: 'codex-record', rule: 'codex.meta.keys', when: { path: 'type', in: ['session_meta'] }, paths: ['payload.id', 'payload.cwd', 'payload.timestamp'] },
  { id: 'codex.context', unit: 'codex-record', rule: 'codex.waiting.unpaired', when: { path: 'type', in: ['turn_context'] }, paths: ['payload.model', 'payload.approval_policy'] },
  { id: 'codex.turn', unit: 'codex-record', rule: 'codex.live.turn', when: { path: 'payload.type', in: ['task_started', 'task_complete', 'turn_aborted'] }, paths: ['payload.turn_id'] },
  { id: 'codex.tool', unit: 'codex-record', rule: 'instrument.tool-map', when: { path: 'payload.type', in: ['function_call', 'custom_tool_call'] }, paths: ['payload.name', 'payload.call_id'] },
  { id: 'codex.tool-output', unit: 'codex-record', rule: 'codex.waiting.unpaired', when: { path: 'payload.type', in: ['function_call_output', 'custom_tool_call_output'] }, paths: ['payload.call_id'] },
  { id: 'codex.child', unit: 'codex-record', rule: 'codex.child.parentThread', when: { path: 'payload.source.subagent.thread_spawn.depth', positive: true }, paths: ['payload.source.subagent.thread_spawn.parent_thread_id'] },
  { id: 'codex.sub-activity', unit: 'codex-record', rule: 'codex.join.activity', when: { path: 'payload.item.type', in: ['SubAgentActivity'] }, paths: ['payload.item.agent_thread_id', 'payload.item.kind'] },
  { id: 'codex.plan', unit: 'codex-plan', rule: 'codex.stand.plan-keys', when: null, paths: ['plan[].step', 'plan[].status'] },
]);

/**
 * Tool names by risk class (r4:2124-2131); the lowercase DSH names are inferred, the Codex ones
 * (shell_command, exec_command, write_stdin, local_shell, view_image) are the names its rollouts call.
 * Anything else is 'other'.
 */
export const TOOL_KINDS = frozen({
  read: ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'read', 'grep', 'glob', 'ls', 'list', 'web_fetch', 'web_search', 'view_image'],
  write: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'multi_edit', 'apply_patch'],
  shell: ['Bash', 'PowerShell', 'bash', 'powershell', 'shell', 'exec', 'shell_command', 'exec_command', 'write_stdin', 'local_shell'],
});

// ---- The JSON contract (design §3; shared/stage-contract.js checks it) ----

export type LiveState = 'busy' | 'idle' | 'waiting' | 'running' | 'returned' | 'quiet' | 'unknown';
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'other';
export type Instrument = { class: 'woodwind' | 'strings' | 'percussion' | 'brass' | 'unknown'; window: number; read: number; write: number; shell: number; role: string | null };
export type Stand = {
  source: 'todo' | 'task-brief' | 'goal' | 'team-task' | 'none' | 'tail-miss';
  keys: 'ok' | 'mismatch' | 'none';
  title: string | null;
  items: { text: string; status: TodoStatus }[];
  selfReported: { checked: number; total: number };
};
export type Harness = 'claude' | 'dsh' | 'codex';
export type Player = {
  id: string; session: string | null; harness: Harness; role: 'principal' | 'clone' | 'teammate';
  parent: string | null; depth: number; shade: number; label: string; agentType: string | null;
  /** The model its record names last (shown), and when it started (epoch ms): null when the record does not say. */
  model: string | null; startedAt: number | null;
  live: { state: LiveState; basis: 'registry' | 'unpaired-tool-use' | 'turn' | 'mtime' | 'none'; waitingFor: string | null; ageMs: number | null };
  look: 'solid' | 'translucent' | 'ghost'; lookRule: string;
  instrument: Instrument; stand: Stand; bytes: number; note: PeekNote | null;
};
export type WorkItem = {
  id: string; owner: string; executor: string | null; parent: string | null;
  source: 'task' | 'todo' | 'team-task' | 'subagent-catalog';
  brief: string; criteria: { state: 'undeclared' };
  state: 'working' | 'reported' | 'orphan' | 'unknown' | 'self'; stateRule: string;
  todoStatus: TodoStatus | null;
  join: 'agentId' | 'description' | 'agentPath' | 'parentSession' | 'team-owner' | null;
  report: { at: number | null; bytes: number } | null;
  flow: { childBytes: number; reportBytes: number } | null;
  verdict: 'no-reviewer';
};
export type Cue = { from: string; to: string; item: string; kind: 'dispatch' | 'report' };
export type Lane = { id: string; name: string; basis: 'cwd' | 'slug'; players: Player[]; items: WorkItem[]; cues: Cue[] };
export type Rule = { id: string; hits: number; n: number; status: 'untested' | 'keys-mismatch' };
/**
 * One source: `sessions` is every session file it holds, before any cut (T1: a source whose sessions
 * the limits pushed out is not empty); `shown` is how many of them play in this snapshot. empty only
 * when it holds none at all.
 */
export type Src = { state: 'ok' | 'empty' | 'error'; sessions: number; shown: number; registry: number | null; error: string | null };
/**
 * What the limits left out. `sessions` is, per source, its session files that play in no lane
 * (sources.<h>.sessions - sources.<h>.shown): a breakdown by source, mostly of what `players` counts
 * already, never to be added to it.
 */
export type Clipped = { lanes: number; players: number; items: number; standItems: number; sessions: Record<Harness, number> };
export type StageSnapshot = {
  v: 1; kind: 'stage-preview'; rev: string; observedAt: number; computedMs: number; profile: 'test' | 'real';
  sources: { claude: Src; dsh: Src; codex: Src };
  rules: Rule[];
  podium: { fermatas: string[]; inbox: null };
  lanes: Lane[];
  clipped: Clipped;
};
export type SessionDetail = {
  session: { id: string; harness: Harness; label: string; size: number; mtimeMs: number };
  events: { at: string | null; type: string; text: string }[];
  unparsed: number; note: PeekNote | null; brief: string | null;
};

// ---- Key shapes ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const digestOf = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
/** A 20-hex name for source text that must stay comparable but never leave (an id, a cwd). */
const key = (s: string) => digestOf(s, 20);

function valueAt(v: unknown, dotted: string): unknown {
  let x = v;
  for (const seg of dotted.split('.')) {
    if (!isObject(x)) return undefined;
    x = own(x, seg);
  }
  return x;
}

function hasPath(v: unknown, dotted: string): boolean {
  const segs = dotted.split('.');
  const walk = (x: unknown, i: number): boolean => {
    if (i === segs.length) return x !== undefined && x !== null;
    if (!isObject(x)) return false;
    const seg = segs[i]!;
    if (!seg.endsWith('[]')) return walk(own(x, seg), i + 1);
    const arr = own(x, seg.slice(0, -2));
    return Array.isArray(arr) && arr.every((e) => walk(e, i + 1));
  };
  return walk(v, 0);
}

/** Does this unit carry the entry's event? */
export function keyEvent(e: KeyEntry, v: unknown): boolean {
  if (e.when === null) return true;
  const got = valueAt(v, e.when.path);
  if ('positive' in e.when) return typeof got === 'number' && got > 0;
  if (typeof got !== 'string') return false;
  return e.when.in.some((w) => (w.endsWith('*') ? got.startsWith(w.slice(0, -1)) : got === w));
}

/** Does the unit carry every key path the entry expects? */
export function keysPresent(e: KeyEntry, v: unknown): boolean {
  return e.paths.every((p) => hasPath(v, p));
}

const entry = (id: string): KeyEntry => KEYS.find((e) => e.id === id)!;

/** Per KEYS entry: units that carried its event, and those of them that lacked a key. */
export type KeyTally = Record<string, { seen: number; missing: number }>;

/** Counts one unit against every KEYS entry of its kind; true when every entry whose event it carries had its keys. */
export function tallyKeys(tally: KeyTally, unit: KeyUnit, v: unknown): boolean {
  let ok = true;
  for (const e of KEYS) {
    if (e.unit !== unit || !keyEvent(e, v)) continue;
    const t = (tally[e.id] ??= { seen: 0, missing: 0 });
    t.seen++;
    if (!keysPresent(e, v)) {
      t.missing++;
      ok = false;
    }
  }
  return ok;
}

// ---- Digests: what one session file says, redacted ----

export type ToolKind = 'read' | 'write' | 'shell' | 'other';

export function toolKind(name: string): ToolKind {
  if (TOOL_KINDS.read.includes(name)) return 'read';
  if (TOOL_KINDS.write.includes(name)) return 'write';
  if (TOOL_KINDS.shell.includes(name)) return 'shell';
  return 'other';
}

type TodoView = { keys: 'ok' | 'mismatch'; items: { text: string; status: TodoStatus }[]; checked: number; total: number };

/** A Task or Agent call: what was asked, and whether its result came back. Keys are digests of source ids. */
export type TaskCall = {
  key: string; description: string; brief: string; agentType: string | null;
  paired: boolean; report: { at: number | null; bytes: number } | null; agentKey: string | null;
};

/** What a Codex subagent last did, as its parent's rollout records it (a SubAgentActivity item). */
export type CodexActivity = 'started' | 'interacted' | 'interrupted' | 'completed';

/** The Codex part of a digest: digests of thread ids and agent paths, never the ids themselves. */
export type CodexView = {
  idKey: string | null;
  /** The parent thread session_meta names: set for a subagent Codex spawned (thread_spawn). */
  parentKey: string | null;
  /** session_meta says a subagent started it (a thread spawn, a review, a compaction...). */
  sub: boolean;
  nickname: string | null; role: string | null;
  /** agent_path (`/root/<task>`): shown, and its digest, which a spawn_agent result names. */
  agentPath: string | null; pathKey: string | null;
  /**
   * The last turn's state: open after task_started, closed after task_complete, aborted after
   * turn_aborted (interrupted or failed: nothing says it handed anything back).
   */
  turn: 'open' | 'closed' | 'aborted' | null;
  /** What an open turn's last unanswered call waits on: a question to you, or an escalation (inferred). */
  waiting: 'request_user_input' | 'approval' | null;
  spawns: { key: string; brief: string; agentKey: string | null; pathKey: string | null; paired: boolean }[];
  /** The last activity per subagent thread. */
  activity: { agentKey: string; kind: CodexActivity; at: number | null }[];
};

export type Digest = {
  harness: Harness;
  /** The project the session ran in, from its cwd: a digest and the shown last segment, never the path. */
  lane: { key: string; name: string } | null;
  /** The last STAGE_LIMITS.window tool calls, by risk class. */
  calls: ToolKind[];
  todo: TodoView | null;
  tasks: TaskCall[];
  keys: KeyTally;
  head: { idKey: string | null; parentKey: string | null; preset: string | null } | null;
  goal: { keys: 'ok' | 'mismatch'; text: string | null } | null;
  members: { idKey: string; name: string }[];
  teamTasks: { key: string; title: string; owner: string; status: string; at: number | null }[];
  catalog: { childKey: string; description: string }[];
  /** The model the record names last (shown), and the session's start (epoch ms), or null. */
  model: string | null;
  startedAt: number | null;
  codex: CodexView | null;
  note: PeekNote | null;
};

export type DigestCtx = { redact: Redact; note?: PeekNote | null };

const text120 = (raw: unknown, redact: Redact) => shown(str(raw), redact, STAGE_LIMITS.textChars);

function emptyDigest(harness: Harness, note: PeekNote | null): Digest {
  return { harness, lane: null, calls: [], todo: null, tasks: [], keys: {}, head: null, goal: null, members: [], teamTasks: [], catalog: [], model: null, startedAt: null, codex: null, note };
}

function laneOf(cwd: string, redact: Redact): { key: string; name: string } {
  const norm = win.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase();
  // The directory's name only is judged as a name (redact.ts, RedactInput.name): a worktree reads like
  // zen-superagent-exploration-04992d, which the entropy rule alone takes for a key.
  return { key: key(`cwd:${norm}`), name: text120(win.basename(win.normalize(cwd)) || 'root', (t) => redact(t, 'name')) };
}

/**
 * A project directory's name as it may be shown: its last '-'-separated segment. Claude Code names the
 * directory by the whole absolute cwd (drive, user name, every folder: `C--Users-x-Projects-shop`) and
 * DSH alike (`--G-fx-shop--`), so the full name never leaves; it stays digest input only (design T5).
 */
export function slugTail(project: string): string {
  const parts = project.split('-').filter((p) => p !== '');
  return parts.at(-1) ?? 'project';
}

function slugLane(project: string): { key: string; name: string; basis: 'slug' } {
  return { key: key(`slug:${project.toLowerCase()}`), name: slugTail(project), basis: 'slug' };
}

const TODO_STATUS: readonly TodoStatus[] =['pending', 'in_progress', 'completed'];

function todoView(holder: unknown, ok: boolean, redact: Redact): TodoView {
  if (!ok || !isObject(holder)) return { keys: 'mismatch', items: [], checked: 0, total: 0 };
  const todos = own(holder, 'todos') as unknown[];
  const status = (t: unknown): TodoStatus => {
    const s = isObject(t) ? own(t, 'status') : undefined;
    return typeof s === 'string' && (TODO_STATUS as readonly string[]).includes(s) ? (s as TodoStatus) : 'other';
  };
  return {
    keys: 'ok',
    items: todos.slice(0, STAGE_LIMITS.standItems).map((t) => ({ text: text120(isObject(t) ? own(t, 'content') : '', redact), status: status(t) })),
    checked: todos.filter((t) => status(t) === 'completed').length,
    total: todos.length,
  };
}

/** Milliseconds from a source time (epoch ms or ISO text, peek's parse), or null; whole and not before 1970. */
function msOf(v: unknown): number | null {
  const ms = sourceMs(v);
  return ms !== null && Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'string' ? b : isObject(b) ? str(own(b, 'text')) : '')).join('\n');
}

/**
 * A digest built one record at a time, so a reader can hand records over as it parses them and keep
 * none (peek.ts eachRecord). finish() takes the reader's note.
 */
export type Digester = { add(record: unknown): void; finish(note?: PeekNote | null): Digest };

/** A Claude transcript (a principal's or a subagent's): cwd, tool calls, the latest TodoWrite, Task calls and their results. */
export function digestClaude(rec: readonly unknown[], ctx: DigestCtx): Digest {
  const dg = claudeDigester(ctx);
  for (const r of rec) dg.add(r);
  return dg.finish();
}

export function claudeDigester(ctx: DigestCtx): Digester {
  const { redact } = ctx;
  const d = emptyDigest('claude', ctx.note ?? null);
  const tasks = new Map<string, TaskCall>();
  let cwd = '';
  let first: number | null | undefined;
  const todoKeys = entry('claude.todo');
  const taskKeys = entry('claude.task');
  const add = (r: unknown): void => {
    if (!isObject(r)) return;
    if (first === undefined && own(r, 'timestamp') !== undefined) first = msOf(own(r, 'timestamp'));
    if (typeof own(r, 'cwd') === 'string' && own(r, 'cwd') !== '') cwd = own(r, 'cwd') as string;
    const message = own(r, 'message');
    if (own(r, 'type') === 'assistant' && isObject(message) && typeof own(message, 'model') === 'string' && own(message, 'model') !== '') d.model = text120(own(message, 'model'), redact);
    const content = isObject(message) ? own(message, 'content') : undefined;
    if (!Array.isArray(content)) return;
    const type = own(r, 'type');
    if (type === 'assistant') {
      for (const b of content) {
        if (!isObject(b) || own(b, 'type') !== 'tool_use') continue;
        d.calls.push(toolKind(str(own(b, 'name'))));
        tallyKeys(d.keys, 'claude-tool', b);
        if (keyEvent(todoKeys, b)) d.todo = todoView(own(b, 'input'), keysPresent(todoKeys, b), redact);
        else if (keyEvent(taskKeys, b) && typeof own(b, 'id') === 'string') {
          const input = isObject(own(b, 'input')) ? (own(b, 'input') as Record<string, unknown>) : {};
          const description = str(own(input, 'description'));
          const prompt = str(own(input, 'prompt'));
          const agentType = str(own(input, 'subagent_type'));
          tasks.set(own(b, 'id') as string, {
            key: key(`tool_use:${own(b, 'id') as string}`),
            description: text120(description, redact),
            brief: text120(prompt === '' ? description : `${description} — ${prompt}`, redact),
            agentType: agentType === '' ? null : text120(agentType, redact),
            paired: false, report: null, agentKey: null,
          });
        }
      }
    } else if (type === 'user') {
      let heldTask = false;
      for (const b of content) {
        if (!isObject(b) || own(b, 'type') !== 'tool_result') continue;
        const t = tasks.get(str(own(b, 'tool_use_id')));
        if (t === undefined) continue;
        heldTask = true;
        t.paired = true;
        t.report = { at: msOf(own(r, 'timestamp')), bytes: Buffer.byteLength(resultText(own(b, 'content')), 'utf8') };
        const agentId = valueAt(r, 'toolUseResult.agentId');
        if (typeof agentId === 'string' && agentId !== '') t.agentKey = key(`agent:${agentId}`);
      }
      if (heldTask) tallyKeys(d.keys, 'claude-result', r);
    }
    // Only the window is ever shown: drop older calls as they come, so a long file holds no long list.
    if (d.calls.length > 4 * STAGE_LIMITS.window) d.calls = d.calls.slice(-STAGE_LIMITS.window);
  };
  const finish = (note?: PeekNote | null): Digest => {
    if (note !== undefined) d.note = note;
    if (cwd !== '') d.lane = laneOf(cwd, redact);
    // A transcript read from a tail starts mid-session: its first record is not the start.
    d.startedAt = d.note === null ? first ?? null : null;
    d.calls = d.calls.slice(-STAGE_LIMITS.window);
    d.tasks = [...tasks.values()];
    return d;
  };
  return { add, finish };
}

/** A DSH session id as heads, catalogs and members spell it: the uuid, lowercase, without `session-`. */
const dshId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? key(`dsh:${v.toLowerCase().replace(/^session-/, '')}`) : null);

/** A DSH v4 log: head, tool calls, the latest goal and todo list, team members and tasks, the subagent catalog. */
export function digestDsh(rec: readonly unknown[], ctx: DigestCtx): Digest {
  const dg = dshDigester(ctx);
  for (const r of rec) dg.add(r);
  return dg.finish();
}

export function dshDigester(ctx: DigestCtx): Digester {
  const { redact } = ctx;
  const d = emptyDigest('dsh', ctx.note ?? null);
  const members = new Map<string, { idKey: string; name: string }>();
  const teamTasks = new Map<string, Digest['teamTasks'][number]>();
  const add = (r: unknown): void => {
    if (!isObject(r)) return;
    const type = str(own(r, 'type'));
    if (type === 'head') {
      if (d.head !== null) return;
      tallyKeys(d.keys, 'dsh-head', r);
      const preset = str(own(r, 'agentPreset'));
      d.head = { idKey: dshId(own(r, 'id')), parentKey: dshId(own(r, 'parentSession')), preset: preset === '' ? null : text120(preset, redact) };
      d.startedAt = msOf(own(r, 'createdAt'));
      if (typeof own(r, 'cwd') === 'string' && own(r, 'cwd') !== '') d.lane = laneOf(own(r, 'cwd') as string, redact);
      return;
    }
    tallyKeys(d.keys, 'dsh-event', r);
    const data = isObject(own(r, 'data')) ? (own(r, 'data') as Record<string, unknown>) : {};
    const has = (id: string) => keysPresent(entry(id), r);
    if (type === 'tool/call') d.calls.push(toolKind(str(own(data, 'name'))));
    else if (type === 'goal/change') d.goal = has('dsh.goal') ? { keys: 'ok', text: text120(own(data, 'goal'), redact) } : { keys: 'mismatch', text: null };
    else if (type === 'todo/write') d.todo = todoView(data, has('dsh.todo'), redact);
    else if (type.startsWith('team/member/') && has('dsh.team-member')) {
      const idKey = dshId(own(data, 'memberId'))!;
      members.set(idKey, { idKey, name: text120(own(data, 'name'), redact) });
    } else if (type.startsWith('team/task/') && has('dsh.team-task')) {
      const k = key(`team-task:${String(own(data, 'taskId'))}`);
      teamTasks.set(k, { key: k, title: text120(own(data, 'title'), redact), owner: text120(own(data, 'owner'), redact), status: str(own(data, 'status')), at: msOf(own(r, 'time')) });
    } else if (type === 'subagent/catalog' && has('dsh.catalog')) {
      const childKey = dshId(own(data, 'childId'));
      if (childKey !== null) d.catalog.push({ childKey, description: text120(own(data, 'description'), redact) });
    }
    if (d.calls.length > 4 * STAGE_LIMITS.window) d.calls = d.calls.slice(-STAGE_LIMITS.window);
  };
  const finish = (note?: PeekNote | null): Digest => {
    if (note !== undefined) d.note = note;
    d.calls = d.calls.slice(-STAGE_LIMITS.window);
    d.members = [...members.values()];
    d.teamTasks = [...teamTasks.values()];
    return d;
  };
  return { add, finish };
}

/** A Codex thread id as session_meta, spawn results and activity items spell it, lowercase. */
const codexId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? key(`codex:${v.toLowerCase()}`) : null);
const codexPath = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? key(`codex-path:${v}`) : null);
const CODEX_ACTIVITY: readonly string[] = ['started', 'interacted', 'interrupted', 'completed'];

/** A call's arguments as an object, when they are a JSON object no longer than STAGE_LIMITS.codexArgsChars. */
function codexArgs(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || v.length > STAGE_LIMITS.codexArgsChars) return null;
  try {
    const o: unknown = JSON.parse(v);
    return isObject(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * A Codex rollout (`{timestamp, type, payload}` lines): session_meta (thread id, cwd, start, the
 * parent thread of a subagent), the latest model, turn starts and ends, tool calls by risk class and
 * the ones still unanswered, the latest update_plan, spawn_agent calls and what their results name, and
 * the parent's record of each subagent's activity.
 */
export function digestCodex(rec: readonly unknown[], ctx: DigestCtx): Digest {
  const dg = codexDigester(ctx);
  for (const r of rec) dg.add(r);
  return dg.finish();
}

export function codexDigester(ctx: DigestCtx): Digester {
  const { redact } = ctx;
  const d = emptyDigest('codex', ctx.note ?? null);
  const c: CodexView = { idKey: null, parentKey: null, sub: false, nickname: null, role: null, agentPath: null, pathKey: null, turn: null, waiting: null, spawns: [], activity: [] };
  d.codex = c;
  let metaSeen = false;
  let policy: string | null = null;
  /** Calls without their output yet, in call order: the name, and whether it asks to leave the sandbox. */
  const pending = new Map<string, { name: string; escalated: boolean }>();
  const spawns = new Map<string, CodexView['spawns'][number]>();
  const activity = new Map<string, CodexView['activity'][number]>();
  const planKeys = entry('codex.plan');
  const shownOrNull = (v: unknown) => (typeof v === 'string' && v !== '' ? text120(v, redact) : null);
  const add = (r: unknown): void => {
    if (!isObject(r)) return;
    tallyKeys(d.keys, 'codex-record', r);
    const type = str(own(r, 'type'));
    const p = isObject(own(r, 'payload')) ? (own(r, 'payload') as Record<string, unknown>) : {};
    const sub = str(own(p, 'type'));
    if (type === 'session_meta') {
      // A forked or resumed rollout may carry its source's meta again later: the first one is this file's.
      if (metaSeen) return;
      metaSeen = true;
      c.idKey = codexId(own(p, 'id')) ?? codexId(own(p, 'session_id'));
      if (typeof own(p, 'cwd') === 'string' && own(p, 'cwd') !== '') d.lane = laneOf(own(p, 'cwd') as string, redact);
      d.startedAt = msOf(own(p, 'timestamp')) ?? msOf(own(r, 'timestamp'));
      const source = own(p, 'source');
      // The rollout spells it subagent; the app-server protocol (v2 SessionSource) subAgent.
      const via = isObject(source) ? own(source, 'subagent') ?? own(source, 'subAgent') : undefined;
      const spawn = isObject(via) && isObject(own(via, 'thread_spawn')) ? (own(via, 'thread_spawn') as Record<string, unknown>) : {};
      c.sub = via !== undefined;
      c.parentKey = codexId(own(p, 'parent_thread_id')) ?? codexId(own(spawn, 'parent_thread_id'));
      c.nickname = shownOrNull(own(p, 'agent_nickname')) ?? shownOrNull(own(spawn, 'agent_nickname'));
      c.role = shownOrNull(own(p, 'agent_role')) ?? shownOrNull(own(spawn, 'agent_role'));
      const agentPath = typeof own(p, 'agent_path') === 'string' ? own(p, 'agent_path') : own(spawn, 'agent_path');
      c.agentPath = shownOrNull(agentPath);
      c.pathKey = codexPath(agentPath);
      return;
    }
    if (type === 'turn_context') {
      if (typeof own(p, 'model') === 'string' && own(p, 'model') !== '') d.model = text120(own(p, 'model'), redact);
      const ap = own(p, 'approval_policy');
      policy = typeof ap === 'string' ? ap : isObject(ap) ? 'granular' : policy;
      return;
    }
    if (type === 'event_msg') {
      if (sub === 'task_started') c.turn = 'open';
      else if (sub === 'task_complete' || sub === 'turn_aborted') {
        c.turn = sub === 'task_complete' ? 'closed' : 'aborted';
        // A turn that ended answers nothing more: what it left unanswered waits on no one.
        pending.clear();
      } else if (sub === 'thread_settings_applied' && d.model === null) {
        const ts = own(p, 'thread_settings');
        if (isObject(ts) && typeof own(ts, 'model') === 'string' && own(ts, 'model') !== '') d.model = text120(own(ts, 'model'), redact);
      } else if (sub === 'item_completed') {
        const item = own(p, 'item');
        if (!isObject(item) || own(item, 'type') !== 'SubAgentActivity') return;
        const agentKey = codexId(own(item, 'agent_thread_id'));
        const kind = str(own(item, 'kind'));
        if (agentKey === null || !CODEX_ACTIVITY.includes(kind)) return;
        activity.delete(agentKey);
        activity.set(agentKey, { agentKey, kind: kind as CodexActivity, at: msOf(own(r, 'timestamp')) });
      }
      return;
    }
    if (type !== 'response_item') return;
    if (sub === 'function_call' || sub === 'custom_tool_call' || sub === 'local_shell_call') {
      const name = sub === 'local_shell_call' ? 'local_shell' : str(own(p, 'name'));
      const kind = toolKind(name);
      d.calls.push(kind);
      const callId = str(own(p, 'call_id'));
      const args = name === 'update_plan' || name === 'spawn_agent' || kind === 'shell' ? codexArgs(own(p, 'arguments')) : null;
      if (callId !== '') {
        const escalated = args !== null && (own(args, 'sandbox_permissions') === 'require_escalated' || own(args, 'with_escalated_permissions') === true);
        pending.delete(callId);
        pending.set(callId, { name, escalated });
      }
      if (name === 'update_plan' && args !== null) {
        tallyKeys(d.keys, 'codex-plan', args);
        const ok = keysPresent(planKeys, args);
        const plan = ok ? (own(args, 'plan') as unknown[]) : [];
        d.todo = todoView({ todos: plan.map((x) => ({ content: isObject(x) ? own(x, 'step') : '', status: isObject(x) ? own(x, 'status') : '' })) }, ok, redact);
      } else if (name === 'spawn_agent' && callId !== '') {
        const what = str(own(args ?? {}, 'task_name')) || str(own(args ?? {}, 'agent_type'));
        const message = str(own(args ?? {}, 'message'));
        spawns.set(callId, { key: key(`codex-call:${callId}`), brief: text120(what === '' ? message : `${what} — ${message}`, redact), agentKey: null, pathKey: null, paired: false });
      }
    } else if (sub === 'function_call_output' || sub === 'custom_tool_call_output') {
      const callId = str(own(p, 'call_id'));
      pending.delete(callId);
      const sp = spawns.get(callId);
      if (sp !== undefined) {
        sp.paired = true;
        // The result is a JSON string: {agent_id, nickname} or {task_name} (the child's agent_path).
        const out = codexArgs(own(p, 'output'));
        if (out !== null) {
          sp.agentKey = codexId(own(out, 'agent_id'));
          sp.pathKey = codexPath(own(out, 'task_name'));
        }
      }
    }
    if (d.calls.length > 4 * STAGE_LIMITS.window) d.calls = d.calls.slice(-STAGE_LIMITS.window);
  };
  const finish = (note?: PeekNote | null): Digest => {
    if (note !== undefined) d.note = note;
    d.calls = d.calls.slice(-STAGE_LIMITS.window);
    // Only an open turn waits; and only on its last unanswered call, as the rollout shows it. A
    // question (request_user_input) waits on you; a command that asked to leave the sandbox, under a
    // policy that asks, may wait on an approval the rollout does not record. Both are inferences.
    const last = c.turn === 'open' ? [...pending.values()].at(-1) : undefined;
    if (last !== undefined) {
      if (/^request_user_input/.test(last.name)) c.waiting = 'request_user_input';
      else if (last.escalated && policy !== null && policy !== 'never') c.waiting = 'approval';
    }
    c.spawns = [...spawns.values()];
    c.activity = [...activity.values()];
    return d;
  };
  return { add, finish };
}

/** One risk glyph over the last tool calls (design §3): brass, percussion, strings, woodwind, unknown, first match wins. */
export function classifyInstrument(calls: readonly ToolKind[], role: string | null): Instrument {
  const w = calls.slice(-STAGE_LIMITS.window);
  const n = (k: ToolKind) => w.filter((c) => c === k).length;
  const [read, write, shell] = [n('read'), n('write'), n('shell')];
  const cls: Instrument['class'] = role !== null && /review/i.test(role) ? 'brass' : shell > 0 ? 'percussion' : write > 0 ? 'strings' : w.length > 0 ? 'woodwind' : 'unknown';
  return { class: cls, window: w.length, read, write, shell, role };
}

export type LookInput = { state: LiveState; ageMs: number | null; unjoined: boolean; unpaired: boolean; parentBusy: boolean };

/**
 * Solid, translucent or ghost (design §3). The possible-orphan case is checked first: a clone whose
 * Task never came back reads `running`, and only its age and a parent that is not busy tell it apart.
 */
export function deriveLook(i: LookInput): { look: Player['look']; rule: string } {
  if ((i.unjoined || i.unpaired) && i.ageMs !== null && i.ageMs > STAGE_LIMITS.ghostAgeMs && !i.parentBusy) return { look: 'ghost', rule: 'look.ghost.orphan' };
  if (i.state === 'busy' || i.state === 'waiting' || i.state === 'running') return { look: 'solid', rule: `look.solid.${i.state}` };
  if (i.ageMs !== null && i.ageMs < STAGE_LIMITS.solidAgeMs) return { look: 'solid', rule: 'look.solid.mtime' };
  return { look: 'translucent', rule: `look.translucent.${i.state}` };
}

/** A subagent as the join sees it: its agent id's digest and the shown description of its meta file. */
export type SubagentDigest = { agentKey: string; description: string | null };
export type Join = { task: string; sub: number; by: 'agentId' | 'description' };

/** Task calls whose result names no agent, counted by description, over the digests of one tree. */
export function unnamedTasks(digests: readonly Digest[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of digests) for (const t of d.tasks) if (t.agentKey === null && t.description !== '') out.set(t.description, (out.get(t.description) ?? 0) + 1);
  return out;
}

/**
 * Which of `subs` ran which Task call of `parent`: by the agentId the result names first, then by a
 * description. A call whose result named an agent joins that agent or nothing. A description joins
 * only when exactly one free subagent carries it and exactly one unnamed call carries it in `unnamed`
 * (the whole tree's count; this parent's own by default), so no call takes another's subagent. Each
 * subagent joins one call at most.
 */
export function joinClones(parent: Digest, subs: readonly SubagentDigest[], unnamed: ReadonlyMap<string, number> = unnamedTasks([parent])): Join[] {
  const out: Join[] = [];
  const taken = new Set<number>();
  for (const t of parent.tasks) {
    if (t.agentKey === null) continue;
    const i = subs.findIndex((s, j) => !taken.has(j) && s.agentKey === t.agentKey);
    if (i < 0) continue;
    taken.add(i);
    out.push({ task: t.key, sub: i, by: 'agentId' });
  }
  for (const t of parent.tasks) {
    if (t.agentKey !== null || t.description === '' || (unnamed.get(t.description) ?? 0) !== 1) continue;
    const hits = subs.map((s, j) => (!taken.has(j) && s.description === t.description ? j : -1)).filter((j) => j >= 0);
    if (hits.length !== 1) continue;
    taken.add(hits[0]!);
    out.push({ task: t.key, sub: hits[0]!, by: 'description' });
  }
  return out;
}

// ---- The registry (Claude Code's sessions/<pid>.json) ----

export type RegistryEntry = {
  sessionKey: string;
  status: 'busy' | 'idle' | 'waiting' | null;
  waitingFor: string | null;
  name: string | null;
  lane: { key: string; name: string } | null;
  mtimeMs: number;
};

/** The registry entries under the Claude roots, the plan step 10 keys only; the newest file wins per session. */
export function readRegistry(gate: ReadGate, claudeRoots: readonly HarnessRoot[], redact: Redact): { entries: RegistryEntry[]; error: string | null; keys: KeyTally } {
  const bySession = new Map<string, RegistryEntry>();
  const keys: KeyTally = {};
  let error: string | null = null;
  for (const root of claudeRoots) {
    const dir = win.join(root.path, 'sessions');
    let names: string[] = [];
    try {
      names = gate.readdir(dir).filter((n) => /^\d+\.json$/.test(n)).sort();
    } catch (e) {
      if (!(e instanceof ReadGateError) && !isFsError(e)) throw e;
      if (!(e instanceof ReadGateError) || e.decision.reason !== 'not-found') error = 'registry-read-failed';
      continue;
    }
    for (const name of names) {
      const file = win.join(dir, name);
      let o: unknown;
      let mtimeMs = 0;
      try {
        const st = gate.stat(file);
        if (!st.isFile() || Number(st.size) > STAGE_LIMITS.smallFileBytes) continue;
        mtimeMs = Number(st.mtimeMs);
        o = JSON.parse(gate.readRange(file, 0, Number(st.size)).toString('utf8'));
      } catch (e) {
        if (e instanceof ReadGateError) {
          if (e.decision.reason !== 'not-found' && e.decision.reason !== 'changed-during-open') error = 'registry-read-failed';
          continue;
        }
        if (e instanceof SyntaxError) continue;
        if (!isFsError(e)) throw e;
        error = 'registry-read-failed';
        continue;
      }
      if (!isObject(o)) continue;
      tallyKeys(keys, 'claude-registry', o);
      const sessionId = str(own(o, 'sessionId'));
      if (sessionId === '') continue;
      const status = own(o, 'status');
      const cwd = str(own(o, 'cwd'));
      const e: RegistryEntry = {
        sessionKey: key(`claude:${sessionId.toLowerCase()}`),
        status: status === 'busy' || status === 'idle' || status === 'waiting' ? status : null,
        waitingFor: status === 'waiting' && typeof own(o, 'waitingFor') === 'string' ? text120(own(o, 'waitingFor'), redact) : null,
        name: typeof own(o, 'name') === 'string' && own(o, 'name') !== '' ? text120(own(o, 'name'), redact) : null,
        lane: cwd === '' ? null : laneOf(cwd, redact),
        mtimeMs,
      };
      const had = bySession.get(e.sessionKey);
      if (had === undefined || had.mtimeMs < e.mtimeMs) bySession.set(e.sessionKey, e);
    }
  }
  return { entries: [...bySession.values()], error, keys };
}

// ---- Assembly ----

type Meta = { agentType: string | null; description: string | null };

/** A player before it is written out: the tree is built on these, then flattened per lane. */
type Seat = {
  id: string; session: PeekSession; harness: Harness; role: Player['role'];
  parent: Seat | null; children: Seat[]; depth: number;
  digest: Digest; label: string; agentType: string | null;
  live: Player['live']; unjoined: boolean; unpaired: boolean; stand: Stand;
};

type Hits = Record<string, number>;

const NO_STAND: Stand = frozen({ source: 'none', keys: 'none', title: null, items: [], selfReported: { checked: 0, total: 0 } }) as Stand;
const copyStand = (s: Stand): Stand => ({ ...s, items: s.items.map((i) => ({ ...i })), selfReported: { ...s.selfReported } });

function todoStand(t: TodoView, title: string | null, source: Stand['source']): Stand {
  return { source, keys: t.keys, title, items: t.items.map((i) => ({ ...i })), selfReported: { checked: t.checked, total: t.total } };
}

function sortNewest<T extends { mtimeMs: number; id: string }>(xs: T[]): T[] {
  return xs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A Claude transcript's session uuid, lowercase, from its file name. */
const uuidOf = (file: string) => win.basename(file).replace(/\.jsonl$/i, '').toLowerCase();

/** An error the file system raised (EPERM, EBUSY, EACCES...): its message holds a path, so only its source is marked. */
function isFsError(e: unknown): boolean {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { syscall?: unknown }).syscall === 'string';
}

const ageOf = (mtimeMs: number, nowWall: number) => Math.max(0, Math.trunc(nowWall - mtimeMs));
const pid = (s: string) => `p:${key(`player:${s}`)}`;
const iid = (kind: string, s: string) => `w:${kind}:${digestOf(`item:${s}`, 16)}`;

/** Everything a snapshot is made from, read through the gate (memoized per file) by the builder. */
export type Gathered = {
  claude: { session: PeekSession; digest: Digest; subs: { file: SubagentFile; digest: Digest; meta: Meta }[]; subsClipped: number }[];
  dsh: { session: PeekSession; digest: Digest }[];
  codex: { session: PeekSession; digest: Digest }[];
  registry: RegistryEntry[];
  keys: KeyTally[];
};

type Assembled = { lanes: Lane[]; clipped: Clipped; rules: Rule[]; fermatas: string[] };

/**
 * The lanes of a snapshot from what was read: players, their tree, work items and cues per lane, the
 * clip counts and the rule hits. Pure: time is `nowWall`, and every string in `g` is shown() already.
 */
export function assembleLanes(g: Gathered, nowWall: number, extraClipped = 0): Assembled {
  const clipped: Clipped = { lanes: 0, players: extraClipped, items: 0, standItems: 0, sessions: { claude: 0, dsh: 0, codex: 0 } };
  const hits: Hits = Object.fromEntries(STAGE_RULE_IDS.map((id: string) => [id, 0]));
  const registry = new Map(g.registry.map((e) => [e.sessionKey, e]));
  const roots: Seat[] = [];
  const itemsBySeat = new Map<Seat, WorkItem[]>();
  const owned = new Map<string, string>();
  const pushItem = (seat: Seat, w: WorkItem) => {
    const list = itemsBySeat.get(seat) ?? [];
    list.push(w);
    itemsBySeat.set(seat, list);
    if (w.executor !== null && !owned.has(w.executor)) owned.set(w.executor, w.id);
  };
  const laneOfSeat = new Map<Seat, { key: string; name: string; basis: Lane['basis'] }>();

  // Claude: the principal, then its subagents joined to the Task calls that started them.
  for (const c of g.claude) {
    const uuid = uuidOf(c.session.file);
    const reg = registry.get(key(`claude:${uuid}`));
    const ageMs = ageOf(c.session.mtimeMs, nowWall);
    const state: LiveState = reg === undefined ? 'unknown' : reg.status ?? 'unknown';
    if (reg !== undefined) hits['claude.live.registry']!++;
    const d = c.digest;
    let stand: Stand;
    if (d.todo !== null) {
      stand = todoStand(d.todo, null, 'todo');
      hits['claude.stand.todo-keys']!++;
    } else stand = d.note === 'tail-only' ? { ...copyStand(NO_STAND), source: 'tail-miss' } : copyStand(NO_STAND);
    const lane = d.lane ?? reg?.lane ?? null;
    const root: Seat = {
      id: pid(`claude:${uuid}`), session: c.session, harness: 'claude', role: 'principal', parent: null, children: [], depth: 0,
      digest: d, label: reg?.name ?? lane?.name ?? slugTail(c.session.project), agentType: null,
      live: { state, basis: reg === undefined ? 'none' : 'registry', waitingFor: state === 'waiting' ? reg?.waitingFor ?? null : null, ageMs },
      unjoined: false, unpaired: false, stand,
    };
    roots.push(root);
    laneOfSeat.set(root, lane === null ? slugLane(c.session.project) : { ...lane, basis: 'cwd' });
    clipped.players += c.subsClipped;

    const free = new Map(c.subs.map((s, i) => [i, s]));
    // A Workflow agent is started by the Workflow tool, never by a Task or Agent call: no call can name it.
    const joinable = (i: number) => c.subs[i]!.file.via !== 'workflow';
    const candidates = () => [...free.keys()].filter(joinable);
    const asJoin = (i: number): SubagentDigest => ({ agentKey: key(`agent:${c.subs[i]!.file.agentId}`), description: c.subs[i]!.meta.description });
    const unnamed = unnamedTasks([d, ...c.subs.map((s) => s.digest)]);
    // A subagent no Task call names is a possible orphan only when every transcript of the tree was
    // read whole: a call may lie before a tail, or in a subagent file that was not read.
    const tailOnly = d.note === 'tail-only' || c.subs.some((s) => s.digest.note === 'tail-only');
    const partial = d.note !== null || c.subs.some((s) => s.digest.note !== null) || c.subsClipped > 0;
    // A subagent past the depth limit goes, and so does every subagent its own Task calls name.
    const clipTree = (i: number): void => {
      free.delete(i);
      clipped.players++;
      const idx = candidates();
      for (const j of joinClones(c.subs[i]!.digest, idx.map(asJoin), unnamed)) if (free.has(idx[j.sub]!)) clipTree(idx[j.sub]!);
    };
    const seatOfSub = (i: number, parent: Seat, task: TaskCall | null, by: Join['by'] | null, orphan = false): Seat | null => {
      const s = c.subs[i]!;
      if (parent.depth + 1 > STAGE_LIMITS.depth) {
        clipTree(i);
        return null;
      }
      free.delete(i);
      const subAge = ageOf(s.file.jsonl.mtimeMs, nowWall);
      const description = s.meta.description ?? task?.description ?? null;
      const agentType = s.meta.agentType ?? task?.agentType ?? null;
      const live: Player['live'] = task === null
        ? { state: 'unknown', basis: 'none', waitingFor: null, ageMs: subAge }
        : { state: task.paired ? 'returned' : 'running', basis: 'unpaired-tool-use', waitingFor: null, ageMs: subAge };
      const sd = s.digest;
      const seat: Seat = {
        id: pid(`claude:${uuid}:agent:${s.file.agentId}`), session: s.file.jsonl, harness: 'claude', role: 'clone', parent, children: [], depth: parent.depth + 1,
        digest: sd, label: description !== null && description !== '' ? description : `agent-${s.file.agentId}`.slice(0, STAGE_LIMITS.textChars), agentType,
        // Unjoined (a ghost once old) only when no Task call can name it on the evidence read.
        live, unjoined: task === null && orphan, unpaired: task !== null && !task.paired,
        stand: sd.todo !== null ? todoStand(sd.todo, description, 'todo')
          : description !== null && description !== '' ? { source: 'task-brief', keys: 'ok', title: description, items: [], selfReported: { checked: 0, total: 0 } } : copyStand(NO_STAND),
      };
      if (by !== null) hits[by === 'agentId' ? 'claude.join.agentId' : 'claude.join.description']!++;
      parent.children.push(seat);
      return seat;
    };
    const taskItems = (owner: Seat, joined: Map<string, { seat: Seat | null; by: Join['by'] }>) => {
      for (const t of owner.digest.tasks) {
        const j = joined.get(t.key);
        const executor = j?.seat ?? null;
        // A join names how the executor was found: with no executor shown (clipped), there is none.
        const by = j === undefined || executor === null ? null : j.by;
        if (!t.paired) hits['claude.clone.running']!++;
        pushItem(owner, {
          id: iid('task', `${owner.id}:${t.key}`), owner: owner.id, executor: executor?.id ?? null, parent: owned.get(owner.id) ?? null,
          source: 'task', brief: t.brief, criteria: { state: 'undeclared' },
          state: t.paired ? 'reported' : 'working', stateRule: t.paired ? (by === null ? 'claude.task.paired' : `claude.join.${by}`) : 'claude.clone.running',
          todoStatus: null, join: by, report: t.paired ? t.report : null,
          flow: t.paired && t.report !== null && executor !== null ? { childBytes: executor.session.size, reportBytes: t.report.bytes } : null,
          verdict: 'no-reviewer',
        });
      }
    };
    // Breadth first from the principal: each owner's Task calls take the free subagents they name.
    const queue: Seat[] = [root];
    for (;;) {
      while (queue.length > 0) {
        const owner = queue.shift()!;
        const freeIdx = candidates();
        const joins = joinClones(owner.digest, freeIdx.map(asJoin), unnamed);
        const joined = new Map<string, { seat: Seat | null; by: Join['by'] }>();
        for (const j of joins) {
          const task = owner.digest.tasks.find((t) => t.key === j.task)!;
          const seat = seatOfSub(freeIdx[j.sub]!, owner, task, j.by);
          joined.set(j.task, { seat, by: j.by });
          if (seat !== null) queue.push(seat);
        }
        taskItems(owner, joined);
      }
      // A subagent no Task call names, under the principal: a possible orphan when the whole tree was
      // read and it is no Workflow agent; otherwise its dispatcher is unknown.
      const next = [...free.keys()][0];
      if (next === undefined) break;
      const workflow = !joinable(next);
      const orphan = !workflow && !partial;
      const seat = seatOfSub(next, root, null, null, orphan);
      if (seat === null) continue;
      if (orphan) hits['claude.clone.orphan']!++;
      const rule = orphan ? 'claude.clone.orphan' : workflow ? 'claude.clone.workflow' : tailOnly ? 'claude.clone.tail-only' : 'claude.clone.partial-read';
      pushItem(root, {
        id: iid('agent', seat.id), owner: root.id, executor: seat.id, parent: null, source: 'subagent-catalog',
        brief: c.subs[next]!.meta.description ?? seat.label, criteria: { state: 'undeclared' },
        state: orphan ? 'orphan' : 'unknown', stateRule: rule,
        todoStatus: null, join: null, report: null, flow: null, verdict: 'no-reviewer',
      });
      queue.push(seat);
    }
  }

  // DSH: a log whose head names a listed parent is that parent's teammate (a team member) or clone.
  const dshSeats = new Map<string, Seat>();
  const dshParent = new Map<Seat, string | null>();
  const dshKey = new Map<Seat, string>();
  for (const x of g.dsh) {
    const d = x.digest;
    const dirId = win.basename(win.dirname(x.session.file));
    const idKey = d.head?.idKey ?? dshId(dirId)!;
    if (dshSeats.has(idKey)) continue;
    hits['dsh.live.mtime']!++;
    const ageMs = ageOf(x.session.mtimeMs, nowWall);
    const seat: Seat = {
      id: pid(`dsh:${idKey}`), session: x.session, harness: 'dsh', role: 'principal', parent: null, children: [], depth: 0,
      digest: d, label: d.lane?.name ?? slugTail(x.session.project), agentType: d.head?.preset ?? null,
      live: { state: ageMs < STAGE_LIMITS.solidAgeMs ? 'running' : 'quiet', basis: 'mtime', waitingFor: null, ageMs },
      unjoined: false, unpaired: false, stand: copyStand(NO_STAND),
    };
    dshSeats.set(idKey, seat);
    dshKey.set(seat, idKey);
    dshParent.set(seat, d.head?.parentKey ?? null);
  }
  hits['dsh.child.parentSession']! += linkParents(dshSeats, dshParent);
  for (const [idKey, seat] of dshSeats) {
    if (seat.parent !== null) continue;
    roots.push(seat);
    // A head that names a parent session which is not listed (older than the listing, or gone) is a
    // child whose lead is unknown: it stays at the root of its lane, but never plays as a lead.
    const parentKey = dshParent.get(seat) ?? null;
    if (parentKey !== null && parentKey !== idKey && !dshSeats.has(parentKey)) {
      seat.role = 'clone';
      seat.label = seat.digest.head?.preset ?? seat.label;
    }
    const lane = seat.digest.lane;
    laneOfSeat.set(seat, lane === null ? slugLane(seat.session.project) : { ...lane, basis: 'cwd' });
  }
  // Depth, roles, stands and items, from each DSH principal down.
  const dshWalk = (seat: Seat, depth: number): void => {
    seat.depth = depth;
    const p = seat.parent;
    const member = p?.digest.members.find((m) => m.idKey === dshKey.get(seat));
    if (p !== null) {
      seat.role = member !== undefined ? 'teammate' : 'clone';
      const catalog = p.digest.catalog.find((cat) => cat.childKey === dshKey.get(seat));
      seat.label = member?.name ?? seat.digest.head?.preset ?? catalog?.description ?? 'dsh';
    }
    const d = seat.digest;
    if (d.goal !== null) {
      seat.stand = d.todo !== null ? todoStand(d.todo, d.goal.text, 'goal') : { ...copyStand(NO_STAND), source: 'goal', title: d.goal.text };
      seat.stand.keys = d.goal.keys === 'mismatch' || d.todo?.keys === 'mismatch' ? 'mismatch' : 'ok';
      hits['dsh.stand.goal-keys']!++;
    } else if (d.todo !== null) {
      seat.stand = todoStand(d.todo, null, 'todo');
    } else if (member !== undefined) {
      const task = [...p!.digest.teamTasks].reverse().find((t) => t.owner === member.name);
      if (task !== undefined) seat.stand = { source: 'team-task', keys: 'ok', title: task.title, items: [], selfReported: { checked: 0, total: 0 } };
    }
    if (d.todo !== null) hits['dsh.stand.todo-keys']!++;
    for (const t of d.teamTasks) {
      const m = d.members.find((x) => x.name === t.owner);
      const executor = m === undefined ? undefined : seat.children.find((c) => dshKey.get(c) === m.idKey);
      const reported = t.status === 'completed' || t.status === 'done';
      hits['dsh.team-task-keys']!++;
      pushItem(seat, {
        id: iid('team', `${seat.id}:${t.key}`), owner: seat.id, executor: executor?.id ?? null, parent: owned.get(seat.id) ?? null,
        source: 'team-task', brief: t.title, criteria: { state: 'undeclared' },
        state: reported ? 'reported' : t.status === 'pending' || t.status === 'in_progress' || t.status === 'open' ? 'working' : 'unknown', stateRule: 'dsh.team-task-keys',
        todoStatus: null, join: executor === undefined ? null : 'team-owner',
        // The log holds the status change, not a report body: its size is unknown, so 0.
        report: reported ? { at: t.at, bytes: 0 } : null, flow: null, verdict: 'no-reviewer',
      });
    }
    for (const cat of d.catalog) {
      const executor = seat.children.find((c) => dshKey.get(c) === cat.childKey);
      pushItem(seat, {
        id: iid('dsh', `${seat.id}:${cat.childKey}`), owner: seat.id, executor: executor?.id ?? null, parent: owned.get(seat.id) ?? null,
        source: 'subagent-catalog', brief: cat.description, criteria: { state: 'undeclared' },
        // The log has no start or end event for a subagent (dsh-core:11): its state is unknown.
        state: 'unknown', stateRule: 'dsh.child.parentSession', todoStatus: null, join: executor === undefined ? null : 'parentSession',
        report: null, flow: null, verdict: 'no-reviewer',
      });
    }
    const kids = seat.children;
    seat.children = [];
    for (const c of kids) {
      if (depth + 1 > STAGE_LIMITS.depth) {
        clipped.players += 1 + countBelow(c);
        continue;
      }
      seat.children.push(c);
      dshWalk(c, depth + 1);
    }
  };
  for (const seat of roots) if (seat.harness === 'dsh') dshWalk(seat, 0);

  // Codex: a rollout whose session_meta names a listed parent thread is that thread's clone (Codex
  // subagents are threads of their own, each with its own rollout). The parent's spawn_agent calls
  // are its work items, joined to a clone by the agent id or the agent path their results name.
  const cxSeats = new Map<string, Seat>();
  const cxParent = new Map<Seat, string | null>();
  const cxKey = new Map<Seat, string>();
  for (const x of g.codex) {
    const d = x.digest;
    const idKey = d.codex?.idKey ?? codexId(ROLLOUT_ID.exec(win.basename(x.session.file))?.[1]) ?? key(`codex-file:${x.session.id}`);
    if (cxSeats.has(idKey)) continue;
    if ((d.codex?.idKey ?? null) !== null) hits['codex.meta.keys']!++;
    const seat: Seat = {
      id: pid(`codex:${idKey}`), session: x.session, harness: 'codex', role: 'principal', parent: null, children: [], depth: 0,
      digest: d, label: d.lane?.name ?? slugTail(x.session.project), agentType: d.codex?.role ?? null,
      live: codexLive(d, ageOf(x.session.mtimeMs, nowWall), false, hits),
      unjoined: false, unpaired: false, stand: copyStand(NO_STAND),
    };
    cxSeats.set(idKey, seat);
    cxKey.set(seat, idKey);
    cxParent.set(seat, d.codex?.parentKey ?? null);
  }
  hits['codex.child.parentThread']! += linkParents(cxSeats, cxParent);
  // A subagent by its nickname, else its agent path's last segment (`/root/docs`: docs), else its role.
  const cxName = (seat: Seat) => seat.digest.codex?.nickname ?? seat.digest.codex?.agentPath?.split('/').filter((x) => x !== '').at(-1) ?? seat.digest.codex?.role ?? seat.label;
  for (const seat of cxSeats.values()) {
    if (seat.parent !== null) continue;
    roots.push(seat);
    // A subagent whose parent thread is not listed (older than the listing, or gone) stays at the
    // root of its lane, but never plays as a lead.
    if (seat.digest.codex?.sub === true) {
      seat.role = 'clone';
      seat.label = cxName(seat);
      seat.live = codexLive(seat.digest, seat.live.ageMs ?? 0, true, null);
    }
    const lane = seat.digest.lane;
    laneOfSeat.set(seat, lane === null ? slugLane(seat.session.project) : { ...lane, basis: 'cwd' });
  }
  const cxWalk = (seat: Seat, depth: number): void => {
    seat.depth = depth;
    const d = seat.digest;
    if (seat.parent !== null) {
      seat.role = 'clone';
      seat.label = cxName(seat);
      seat.live = codexLive(d, seat.live.ageMs ?? 0, true, null);
    }
    if (d.todo !== null) {
      seat.stand = todoStand(d.todo, null, 'todo');
      hits['codex.stand.plan-keys']!++;
    }
    // Past the depth limit a subtree goes before any item can name one of its players.
    if (depth + 1 > STAGE_LIMITS.depth) {
      for (const ch of seat.children) clipped.players += 1 + countBelow(ch);
      seat.children = [];
    }
    const c = d.codex;
    const acts = new Map((c?.activity ?? []).map((a) => [a.agentKey, a]));
    const claimed = new Set<Seat>();
    const item = (executor: Seat | null, act: CodexView['activity'][number] | undefined, fallback: WorkItem['state'], fallbackRule: string) => {
      if (act !== undefined) hits['codex.join.activity']!++;
      const state: WorkItem['state'] = act === undefined ? fallback : act.kind === 'completed' ? 'reported' : act.kind === 'interrupted' ? 'unknown' : 'working';
      // The parent records that its subagent finished, not what it sent back: the size is unknown, so 0.
      return { state, stateRule: act === undefined ? fallbackRule : 'codex.join.activity', report: state === 'reported' ? { at: act?.at ?? null, bytes: 0 } : null, executor: executor?.id ?? null };
    };
    for (const sp of c?.spawns ?? []) {
      let executor: Seat | null = null;
      let join: WorkItem['join'] = null;
      const byId = sp.agentKey === null ? undefined : seat.children.find((ch) => !claimed.has(ch) && cxKey.get(ch) === sp.agentKey);
      const byPath = byId !== undefined || sp.pathKey === null ? undefined : seat.children.find((ch) => !claimed.has(ch) && ch.digest.codex?.pathKey === sp.pathKey);
      if (byId !== undefined) [executor, join] = [byId, 'agentId'];
      else if (byPath !== undefined) [executor, join] = [byPath, 'agentPath'];
      if (executor !== null) {
        claimed.add(executor);
        hits['codex.join.spawn']!++;
      }
      const s = item(executor, executor === null ? undefined : acts.get(cxKey.get(executor)!), sp.paired ? 'unknown' : 'working', 'codex.join.spawn');
      pushItem(seat, {
        id: iid('codex', `${seat.id}:${sp.key}`), owner: seat.id, executor: s.executor, parent: owned.get(seat.id) ?? null,
        source: 'task', brief: sp.brief, criteria: { state: 'undeclared' }, state: s.state, stateRule: s.stateRule,
        todoStatus: null, join, report: s.report, flow: null, verdict: 'no-reviewer',
      });
    }
    // A subagent no spawn result names (an older call, or a result without its id): found by its parent thread.
    for (const ch of seat.children) {
      if (claimed.has(ch)) continue;
      const s = item(ch, acts.get(cxKey.get(ch)!), 'unknown', 'codex.child.parentThread');
      pushItem(seat, {
        id: iid('codex', `${seat.id}:${ch.id}`), owner: seat.id, executor: s.executor, parent: owned.get(seat.id) ?? null,
        source: 'subagent-catalog', brief: cxName(ch), criteria: { state: 'undeclared' }, state: s.state, stateRule: s.stateRule,
        todoStatus: null, join: 'parentSession', report: s.report, flow: null, verdict: 'no-reviewer',
      });
    }
    for (const ch of seat.children) cxWalk(ch, depth + 1);
  };
  for (const seat of roots) if (seat.harness === 'codex') cxWalk(seat, 0);

  // At most STAGE_LIMITS.principals, newest first but shared fairly between the harnesses (fairShare:
  // each gets a floor), and one that waits on you is always kept, whether its registry says so or its
  // rollout suggests it (a Codex wait inferred within codexWaitMaxAgeMs): its file ages while it waits,
  // and the harnesses are treated alike. A dropped principal takes its tree with it.
  const ordered = sortNewest(roots.map((r) => ({ r, id: r.id, mtimeMs: r.session.mtimeMs })));
  const keptSet = new Set(fairShare(ordered, STAGE_LIMITS.principals, (o) => o.r.harness, (o) => o.r.live.state === 'waiting'));
  const kept = ordered.filter((o) => keptSet.has(o)).map((o) => o.r);
  for (const o of ordered) if (!keptSet.has(o)) clipped.players += 1 + countBelow(o.r);

  const lanes = new Map<string, Lane>();
  const fermatas: string[] = [];
  for (const root of kept) {
    const l = laneOfSeat.get(root)!;
    let lane = lanes.get(l.key);
    if (lane === undefined) {
      lane = { id: l.key, name: l.name, basis: l.basis, players: [], items: [], cues: [] };
      lanes.set(l.key, lane);
    }
    const walk = (seat: Seat) => {
      lane.players.push(toPlayer(seat, hits, clipped));
      if (seat.live.state === 'waiting' && seat.live.basis === 'registry') fermatas.push(seat.id);
      for (const w of itemsBySeat.get(seat) ?? []) lane.items.push(w);
      // A stand's todo list is its owner's own work: one self item per shown entry.
      if (seat.stand.source === 'todo' || (seat.stand.source === 'goal' && seat.digest.todo !== null)) {
        seat.stand.items.forEach((it, i) => lane.items.push({
          id: `w:todo:${seat.id.slice(2)}:${i}`, owner: seat.id, executor: null, parent: null, source: 'todo', brief: it.text, criteria: { state: 'undeclared' },
          state: 'self', stateRule: seat.harness === 'claude' ? 'claude.stand.todo-keys' : 'dsh.stand.todo-keys', todoStatus: it.status,
          join: null, report: null, flow: null, verdict: 'no-reviewer',
        }));
      }
      for (const c of seat.children) walk(c);
    };
    walk(root);
  }
  hits['fermata.registry-waiting'] = fermatas.length;
  for (const lane of lanes.values()) {
    if (lane.items.length > STAGE_LIMITS.itemsPerLane) {
      clipped.items += lane.items.length - STAGE_LIMITS.itemsPerLane;
      lane.items = lane.items.slice(0, STAGE_LIMITS.itemsPerLane);
    }
    const ids = new Set(lane.items.map((w) => w.id));
    for (const w of lane.items) {
      if (w.parent !== null && !ids.has(w.parent)) w.parent = null;
      if (w.executor === null) continue;
      lane.cues.push({ from: w.owner, to: w.executor, item: w.id, kind: 'dispatch' });
      if (w.state === 'reported') lane.cues.push({ from: w.executor, to: w.owner, item: w.id, kind: 'report' });
    }
  }

  const missing = new Set<string>();
  for (const tally of g.keys) for (const e of KEYS) if ((tally[e.id]?.missing ?? 0) > 0) missing.add(e.rule);
  const rules: Rule[] = RULES.map((r) => ({ id: r.id, hits: hits[r.id] ?? 0, n: r.n, status: missing.has(r.id) ? 'keys-mismatch' : 'untested' }));
  return { lanes: [...lanes.values()], clipped, rules, fermatas };
}

function countBelow(s: Seat): number {
  return s.children.reduce((n, c) => n + 1 + countBelow(c), 0);
}

/**
 * Hangs each seat under the seat its parent key names, when that one is listed and the chain does not
 * loop back (such a seat stays a principal). Returns how many were hung.
 */
function linkParents(seats: ReadonlyMap<string, Seat>, parentOf: ReadonlyMap<Seat, string | null>): number {
  let linked = 0;
  for (const [idKey, seat] of seats) {
    const parentKey = parentOf.get(seat) ?? null;
    const parent = parentKey === null || parentKey === idKey ? undefined : seats.get(parentKey);
    if (parent === undefined) continue;
    let up: Seat | undefined = parent;
    let loops = false;
    for (let n = 0; up !== undefined && n < 64; n++) {
      if (up === seat) {
        loops = true;
        break;
      }
      const k = parentOf.get(up) ?? null;
      up = k === null ? undefined : seats.get(k);
    }
    if (loops) continue;
    seat.parent = parent;
    parent.children.push(seat);
    linked++;
  }
  return linked;
}

/** A rollout's thread id from its file name (`rollout-<time>-<uuid>.jsonl[.zst]`), for a file without session_meta. */
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/**
 * A Codex thread's live state from its own rollout: an inferred wait (an open turn's last call
 * unanswered: a question, or an escalated command under a policy that asks) while the file is younger
 * than STAGE_LIMITS.codexWaitMaxAgeMs; else an open turn runs (quiet once ghostAgeMs passed without a
 * write); a closed turn is idle, or returned for a clone; an aborted turn (interrupted or failed) is
 * unknown, never returned (T2: nothing says it sent anything back) nor idle; with no turn event, the
 * file's age decides. `hits` (null when recomputed for a clone) counts the rules used.
 */
function codexLive(d: Digest, ageMs: number, clone: boolean, hits: Hits | null): Player['live'] {
  const c = d.codex;
  if (c !== null && c.waiting !== null && ageMs < STAGE_LIMITS.codexWaitMaxAgeMs) {
    if (hits !== null) hits['codex.waiting.unpaired']!++;
    return { state: 'waiting', basis: 'unpaired-tool-use', waitingFor: c.waiting, ageMs };
  }
  if (c !== null && c.turn !== null) {
    if (hits !== null) hits['codex.live.turn']!++;
    const state: LiveState = c.turn === 'open' ? (ageMs < STAGE_LIMITS.ghostAgeMs ? 'running' : 'quiet') : c.turn === 'aborted' ? 'unknown' : clone ? 'returned' : 'idle';
    return { state, basis: 'turn', waitingFor: null, ageMs };
  }
  return { state: ageMs < STAGE_LIMITS.solidAgeMs ? 'running' : 'quiet', basis: 'mtime', waitingFor: null, ageMs };
}

function toPlayer(s: Seat, hits: Hits, clipped: Clipped): Player {
  const role = s.harness === 'dsh' ? s.digest.head?.preset ?? null : s.agentType;
  const instrument = classifyInstrument(s.digest.calls, role);
  if (instrument.window > 0) hits['instrument.tool-map']!++;
  const look = deriveLook({ state: s.live.state, ageMs: s.live.ageMs, unjoined: s.unjoined, unpaired: s.unpaired, parentBusy: s.parent?.live.state === 'busy' });
  if (s.stand.source === 'todo' || s.stand.source === 'goal') clipped.standItems += Math.max(0, s.stand.selfReported.total - s.stand.items.length);
  return {
    id: s.id, session: s.session.id, harness: s.harness, role: s.role, parent: s.parent?.id ?? null,
    depth: s.depth, shade: Math.min(2, s.depth), label: s.label, agentType: s.agentType,
    model: s.digest.model, startedAt: s.digest.startedAt,
    live: s.live, look: look.look, lookRule: look.rule, instrument, stand: s.stand,
    bytes: s.session.size, note: s.digest.note,
  };
}

/** 16 hex over the snapshot without its time fields: unchanged data, unchanged rev. */
function revOf(body: unknown): string {
  const timeless = JSON.stringify(body, (k, v) => (k === 'rev' || k === 'observedAt' || k === 'computedMs' || k === 'ageMs' ? undefined : v));
  return digestOf(timeless, 16);
}

export type StageDeps = { gate: ReadGate; roots: readonly HarnessRoot[]; redact: Redact; clock: Clock; profile: 'test' | 'real' };

type MemoSlot = { size: number; mtimeMs: number; value: unknown };

/**
 * The stage builder the peek server holds. snapshot() reads the roots afresh, but a file whose size
 * and mtime are unchanged is not read again (the memo holds its shown() digest), and a call within
 * STAGE_LIMITS.throttleMs of the last one returns that one. session(id) is one session's last events.
 */
export function makeStageBuilder(deps: StageDeps): { snapshot(): StageSnapshot; session(id: string): SessionDetail | null } {
  const { gate, roots, redact, clock, profile } = deps;
  const memo = new Map<string, MemoSlot>();
  /** The memo keys this build used: the rest go when it ends (no cyclic scan can flush a working set). */
  const touched = new Set<string>();
  let last: { mono: number; snap: StageSnapshot } | null = null;
  /** The last session details read, most recent last (session()). */
  const views = new Map<string, { size: number; mtimeMs: number; view: PeekView }>();

  const remember = <T>(s: PeekSession, make: () => T): T => {
    touched.add(s.id);
    const hit = memo.get(s.id);
    if (hit !== undefined && hit.size === s.size && hit.mtimeMs === s.mtimeMs) {
      memo.delete(s.id);
      memo.set(s.id, hit);
      return hit.value as T;
    }
    const value = make();
    memo.delete(s.id);
    memo.set(s.id, { size: s.size, mtimeMs: s.mtimeMs, value });
    while (memo.size > STAGE_LIMITS.memoEntries) memo.delete(memo.keys().next().value!);
    return value;
  };
  /** Whether reading `s` now means reading its file (the memo holds no digest of it as it is). */
  const fresh = (s: PeekSession): boolean => {
    const hit = memo.get(s.id);
    return hit === undefined || hit.size !== s.size || hit.mtimeMs !== s.mtimeMs;
  };
  // Records go straight from the reader into the digest: none is kept, however long the file.
  // `spent` hears how much text the read decoded.
  const digestFile = (s: PeekSession, spent: (chars: number) => void = () => {}): Digest => remember(s, () => {
    const dg = s.harness === 'claude' ? claudeDigester({ redact }) : s.harness === 'codex' ? codexDigester({ redact }) : dshDigester({ redact });
    const r = eachRecord(gate, s, (rec) => dg.add(rec));
    spent(r.chars);
    return dg.finish(r.note);
  });
  const metaFile = (s: PeekSession | null, keys: KeyTally): Meta => {
    if (s === null || s.size > STAGE_LIMITS.smallFileBytes) return { agentType: null, description: null };
    const got = remember(s, () => {
      let o: unknown = null;
      try {
        o = JSON.parse(gate.readRange(s.file, 0, s.size).toString('utf8'));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
      const tally: KeyTally = {};
      if (isObject(o)) tallyKeys(tally, 'claude-meta', o);
      const field = (k: string) => (isObject(o) && typeof own(o, k) === 'string' && own(o, k) !== '' ? text120(own(o, k), redact) : null);
      return { meta: { agentType: field('agentType'), description: field('description') }, tally };
    });
    keys.push(got.tally);
    return got.meta;
  };

  const build = (nowWall: number): Omit<StageSnapshot, 'rev' | 'observedAt' | 'computedMs'> => {
    const errors: Record<Harness, string | null> = { claude: null, dsh: null, codex: null };
    const keys: KeyTally[] = [];
    const reg = readRegistry(gate, roots.filter((r) => r.kind === 'claude'), redact);
    keys.push(reg.keys);
    if (reg.error !== null) errors.claude = reg.error;
    // A session the registry says waits on you is listed and read whatever its age: while it waits on
    // a prompt its transcript is not written, so newer sessions would push it out.
    const waiting = new Set(reg.entries.filter((e) => e.status === 'waiting').map((e) => e.sessionKey));
    const isWaiting = (s: PeekSession) => s.harness === 'claude' && waiting.has(key(`claude:${uuidOf(s.file)}`));
    const listed = listSessions(gate, roots, redact, isWaiting);
    const g: Gathered = { claude: [], dsh: [], codex: [], registry: reg.entries, keys };
    // A file that vanished or was replaced between the listing and the read is skipped; any other
    // refusal, or a file the system would not open (locked, denied), marks its source.
    const guarded = <T>(harness: Harness, read: () => T): T | null => {
      try {
        return read();
      } catch (e) {
        if (e instanceof ReadGateError) {
          if (e.decision.reason !== 'not-found' && e.decision.reason !== 'changed-during-open') errors[harness] = 'read-denied';
          return null;
        }
        if (!isFsError(e)) throw e;
        errors[harness] = 'read-failed';
        return null;
      }
    };
    // Claude transcripts are principals: only STAGE_LIMITS.principals are read at all, newest first
    // but the waiting ones always.
    const claudeListed = listed.sessions.filter((s) => s.harness === 'claude');
    const claudeRead = keepPinned(claudeListed, STAGE_LIMITS.principals, isWaiting);
    for (const s of claudeRead) {
      const got = guarded('claude', () => {
        const digest = digestFile(s);
        keys.push(digest.keys);
        const all = sortNewest(listSubagents(gate, s, redact).map((f) => ({ f, id: f.jsonl.id, mtimeMs: f.jsonl.mtimeMs })));
        const subs = [];
        let unread = Math.max(0, all.length - STAGE_LIMITS.clonesPerParent);
        for (const { f } of all.slice(0, STAGE_LIMITS.clonesPerParent)) {
          const sd = guarded('claude', () => digestFile(f.jsonl));
          if (sd === null) {
            unread++;
            continue;
          }
          keys.push(sd.keys);
          subs.push({ file: f, digest: sd, meta: guarded('claude', () => metaFile(f.meta, keys)) ?? { agentType: null, description: null } });
        }
        return { session: s, digest, subs, subsClipped: unread };
      });
      if (got !== null) g.claude.push(got);
    }
    // DSH logs and Codex rollouts are read whole (a .zst decoded): one build decodes afresh at most
    // STAGE_LIMITS.decodedPerBuild, newest first over both, and reads a file only while what is left
    // covers its own ceiling, so no read is cut short by the budget. The rest wait for the next build
    // (the memo keeps what this one read, so the next one goes further) and count as not shown till then.
    let budget = STAGE_LIMITS.decodedPerBuild;
    let deferred = 0;
    const ceiling = (s: PeekSession): number =>
      s.harness === 'dsh' ? PEEK_LIMITS.dshMaxDecodedBytes
        : /\.zst$/i.test(s.file) ? PEEK_LIMITS.codexMaxDecodedBytes : PEEK_LIMITS.codexHeadBytes + PEEK_LIMITS.codexTailBytes;
    for (const s of listed.sessions) {
      const h = s.harness;
      if (h === 'claude') continue;
      if (fresh(s) && budget < ceiling(s)) {
        deferred++;
        continue;
      }
      const digest = guarded(h, () => digestFile(s, (chars) => { budget -= chars; }));
      if (digest === null) continue;
      keys.push(digest.keys);
      g[h].push({ session: s, digest });
    }
    const unread = listed.total - listed.sessions.length + (claudeListed.length - claudeRead.length) + deferred;
    const a = assembleLanes(g, nowWall, unread);
    // A source counts every session it holds, before the listing's and the principals' cuts, and says
    // how many of them play: a source the limits pushed out reads as clipped, never as empty (T1).
    const listedById = new Map(listed.sessions.map((s) => [s.id, s.harness]));
    const tally = (lanes: readonly Lane[]) => {
      const shown: Record<Harness, number> = { claude: 0, dsh: 0, codex: 0 };
      const seen = new Set<string>();
      for (const lane of lanes) {
        for (const p of lane.players) {
          const h = p.session === null ? undefined : listedById.get(p.session);
          if (h === undefined || seen.has(p.session!)) continue;
          seen.add(p.session!);
          shown[h]++;
        }
      }
      const src = (harness: Harness, registry: number | null): Src => {
        const sessions = listed.totals[harness];
        const error = errors[harness];
        return { state: error !== null ? 'error' : sessions > 0 ? 'ok' : 'empty', sessions, shown: shown[harness], registry, error };
      };
      const sources = { claude: src('claude', reg.entries.length), dsh: src('dsh', null), codex: src('codex', null) };
      for (const h of ['claude', 'dsh', 'codex'] as const) a.clipped.sessions[h] = sources[h].sessions - sources[h].shown;
      return sources;
    };
    const body = {
      v: 1 as const, kind: 'stage-preview' as const, profile,
      sources: tally(a.lanes),
      rules: a.rules, podium: { fermatas: a.fermatas, inbox: null }, lanes: a.lanes, clipped: a.clipped,
    };
    // Past the body limit whole lanes go, the oldest first, and are counted; a lane with a player who
    // waits on you goes only when no other is left.
    while (body.lanes.length > 0 && Buffer.byteLength(JSON.stringify(body), 'utf8') > STAGE_LIMITS.bodyBytes - 1024) {
      const waits = new Set(body.podium.fermatas);
      let at = body.lanes.length - 1;
      while (at > 0 && body.lanes[at]!.players.some((p) => waits.has(p.id))) at--;
      if (body.lanes[at]!.players.some((p) => waits.has(p.id))) at = body.lanes.length - 1;
      const gone = body.lanes.splice(at, 1)[0]!;
      body.clipped.lanes++;
      body.clipped.players += gone.players.length;
      body.clipped.items += gone.items.length;
      const ids = new Set(gone.players.map((p) => p.id));
      body.podium.fermatas = body.podium.fermatas.filter((f) => !ids.has(f));
      body.sources = tally(body.lanes);
    }
    return body;
  };

  const snapshot = (): StageSnapshot => {
    const t0 = clock.nowMono();
    if (last !== null && t0 - last.mono < STAGE_LIMITS.throttleMs) return last.snap;
    const observedAt = clock.nowWall();
    touched.clear();
    const body = build(observedAt);
    for (const k of [...memo.keys()]) if (!touched.has(k)) memo.delete(k);
    const snap: StageSnapshot = { v: body.v, kind: body.kind, rev: revOf(body), observedAt, computedMs: Math.max(0, Math.round(clock.nowMono() - t0)), ...body };
    last = { mono: t0, snap };
    return snap;
  };

  const session = (id: string): SessionDetail | null => {
    if (!/^[0-9a-f]{20}$/.test(id)) return null;
    let s = findSession(gate, roots, redact, id);
    let subLabel: string | null = null;
    if (s === null) {
      for (const p of listSessions(gate, roots, redact).sessions) {
        const sub = p.harness === 'claude' ? listSubagents(gate, p, redact).find((f) => f.jsonl.id === id) : undefined;
        if (sub !== undefined) {
          s = sub.jsonl;
          subLabel = sub.jsonl.project;
          break;
        }
      }
    }
    if (s === null) return null;
    // The page asks again on every new snapshot revision: a file whose size and mtime are unchanged is
    // not read again (an archived .zst would be decoded whole each time).
    const found = s;
    const kept = views.get(found.id);
    const v: PeekView = kept !== undefined && kept.size === found.size && kept.mtimeMs === found.mtimeMs ? kept.view : readSession(gate, found, redact);
    views.delete(found.id);
    views.set(found.id, { size: found.size, mtimeMs: found.mtimeMs, view: v });
    while (views.size > STAGE_LIMITS.detailMemo) views.delete(views.keys().next().value!);
    let brief: string | null = null;
    let label: string | null = null;
    for (const lane of (last ?? { snap: snapshot() }).snap.lanes) {
      const player = lane.players.find((p) => p.session === id);
      if (player !== undefined) label = player.label;
      const item = player === undefined ? undefined : lane.items.find((w) => w.executor === player.id);
      if (item !== undefined) brief = item.brief;
    }
    return {
      // The file path stays here, and so does the project directory's name (an encoded absolute cwd):
      // the label is the player's, `agent-<id>` for a subagent, or the name's last segment.
      session: { id: s.id, harness: s.harness, label: label ?? subLabel ?? slugTail(s.project), size: s.size, mtimeMs: Math.trunc(s.mtimeMs) },
      events: v.events.slice(-STAGE_LIMITS.events), unparsed: v.unparsed, note: v.note, brief,
    };
  };

  return { snapshot, session };
}
