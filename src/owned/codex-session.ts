import * as path from 'node:path';
import type { ChildPipe } from '../os/child-pipe.ts';
import type { Answer, AnswerCause, ApprovalKind, ApprovalRisk, Approvals } from './approvals.ts';
import type { RpcClient, RpcExit, RpcId, RpcStats } from './codex-rpc.ts';
import type { FeedTokens } from './feed.ts';
import type { Redact } from './text.ts';
import { makeRpcClient } from './codex-rpc.ts';
import { Feed } from './feed.ts';
import { isOwnedModel } from './models.ts';
import { OWNED_TEXT_LIMITS, shown, splitUtf8 } from './text.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// One owned Codex session over `codex app-server` (orchestra app plan §2; protocol measured on
// codex-cli 0.165.0, shapes from its generated JSON Schema):
//
//   start:     initialize {clientInfo} -> notification initialized -> thread/start {cwd, model,
//              approvalPolicy:'on-request', sandbox:'workspace-write'}. The reply must echo on-request and
//              a workspace-write (or read-only) sandbox, else the session ends as policy-mismatch.
//   a message: turn/start while no turn runs; turn/steer {expectedTurnId} while one does; while the
//              thread is still starting, or a turn/start is in flight, it waits here (at most 5).
//   stop:      every open approval of the session is declined first, the waiting messages withdrawn,
//              then turn/interrupt (sent as soon as the turn has an id, if it had none yet).
//   end:       open approvals declined, then the child is stopped (stdin closed, then killed).
//
// What codex sends becomes feed events: message deltas (one live event per message) and the final
// message, a command's start, its output so far (live) and its end, file changes, turn start and end,
// token usage (live), errors. Every text is redacted first and cut after (text.ts).
//
// What codex asks becomes an approval in the shared queue (approvals.ts): a command, a file change, a
// permission grant; a question (item/tool/requestUserInput) and an MCP elicitation enter it as asks of
// the person too. The answers written back are only these:
//   command, file change:  {decision:'accept'} or {decision:'decline'}; never acceptForSession, never an
//                          execpolicy or network-policy amendment (nothing outlives the one request, D8);
//   permissions:           the requested profile with scope 'turn', or an empty grant (its schema has no
//                          decision field);
//   question:              one text for its one question, or no answers at all; a secret question, or
//                          more than one, takes only the refusal;
//   elicitation:           {action:'decline'} only (its accept needs content in an MCP server's schema).
// Any other server request is answered with a JSON-RPC error.

export const CODEX_SESSION_LIMITS = frozen({
  /** Messages waiting for the thread or for a turn/start in flight. */
  queue: 5,
  /** Of one message, the first this many characters are kept (and redacted whole when it ends). */
  messageChars: 1024 * 1024,
  /** Of one command's output, the last this many characters are kept. */
  outputChars: 256 * 1024,
  /** A live event shows the tail of this window, redacted as one piece. */
  liveChars: 8 * 1024,
  /** A final message is at most this many feed events of 2 KB. */
  finalParts: 16,
  /** The tail of the child's stderr kept for the report of a failure. */
  stderrChars: 4096,
  /** A thread or turn id longer than this is not codex's. */
  idChars: 200,
});

export const CODEX_CLIENT_INFO = frozen({ name: 'orchestra', title: 'Orchestra', version: '0.2.0' });

/** The JSON-RPC error code a server request Orchestra does not answer gets: method not found. */
export const UNANSWERED_REQUEST_CODE = -32601;

export type CodexSessionState = 'starting' | 'idle' | 'running' | 'ended' | 'failed';
export type CodexEndReason = 'you-ended' | 'exited' | 'start-failed' | 'policy-mismatch';

export type CodexSessionOptions = {
  ownedId: string;
  /** The session's work dir, already made (ORCHESTRA_HOME\work\<ownedId>). */
  cwd: string;
  model: string;
  /** Starts the child in `cwd` through the spawn gate; throws when the gate refuses. */
  launch(): ChildPipe;
  approvals: Approvals;
  /** The wall clock of the Clock the composition root handed down. */
  now(): number;
  redact: Redact;
  /** Hears every change of the session's state, feed or queue. */
  onChange?: () => void;
  /** Tests only: a smaller line bound for the JSON-RPC client. */
  rpcLineMaxBytes?: number;
};

export type SendResult = { ok: true; via: 'turn/start' | 'turn/steer' | 'queued' } | { ok: false; reason: 'ended' | 'queue-full' };

export type CodexSession = {
  readonly ownedId: string;
  readonly model: string;
  readonly cwd: string;
  readonly state: CodexSessionState;
  readonly endReason: CodexEndReason | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  /** The latest total token usage codex reported, or null before any. */
  readonly tokens: FeedTokens | null;
  /** Messages waiting here. */
  readonly queued: number;
  readonly feed: Feed;
  /** Settles true once the thread started, false when the session ended or failed before that. */
  readonly ready: Promise<boolean>;
  send(text: string, uuid: string): SendResult;
  interrupt(): Promise<{ withdrawn: number; denied: number }>;
  end(): { denied: number };
  stats(): { rpc: RpcStats | null; stderrTail: string; failure: string | null };
};

export type StartResult = { ok: true; session: CodexSession } | { ok: false; reason: 'model-refused' | 'spawn-refused'; detail: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= CODEX_SESSION_LIMITS.idChars ? v : null);
const int = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const rpcKey = (rid: RpcId) => (typeof rid === 'number' ? `n:${rid}` : `s:${rid}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Item = { type: string; command: string | null; changes: { path: string; kind: string; diff: string }[] | null; msg: string; out: string };

/** Starts an owned Codex session; the child is running when this returns ok, the thread starting. */
export function startCodexSession(opts: CodexSessionOptions): StartResult {
  if (!isOwnedModel(opts.model)) return { ok: false, reason: 'model-refused', detail: String(opts.model) };
  let pipe: ChildPipe;
  try {
    pipe = opts.launch();
  } catch (e) {
    const decision = (e as { decision?: { reason?: unknown; detail?: unknown } }).decision;
    return { ok: false, reason: 'spawn-refused', detail: decision === undefined ? errText(e) : `${String(decision.reason)}${decision.detail === undefined ? '' : `: ${String(decision.detail)}`}` };
  }
  return { ok: true, session: run(opts, pipe) };
}

function run(opts: CodexSessionOptions, pipe: ChildPipe): CodexSession {
  const { ownedId, cwd, model, approvals, redact } = opts;
  const L = CODEX_SESSION_LIMITS;
  const FEED = OWNED_TEXT_LIMITS.feedBytes;
  const feed = new Feed(opts.now);
  const rpc: RpcClient = makeRpcClient(pipe, opts.rpcLineMaxBytes === undefined ? {} : { lineMaxBytes: opts.rpcLineMaxBytes });

  let state: CodexSessionState = 'starting';
  let endReason: CodexEndReason | null = null;
  let failure: string | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnStarting = false;
  let steering = false;
  let interruptWanted = false;
  let tokens: FeedTokens | null = null;
  let stderrTail = '';
  const queue: string[] = [];
  const items = new Map<string, Item>();
  /** Turns codex said ended, so a turn/start reply read after its own turn/completed does not revive it. */
  const endedTurns: string[] = [];
  /** Server request -> the approval it waits on. */
  const asked = new Map<string, string>();

  let settleReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => {
    settleReady = r;
  });

  const changed = () => {
    try {
      opts.onChange?.();
    } catch {
      // A listener's failure is its own.
    }
  };
  const terminal = () => state === 'ended' || state === 'failed';
  const shownFeed = (raw: string, keep: 'head' | 'tail') => shown(redact, raw, FEED, keep);
  /** A path as the feed shows it: relative inside the work dir, else only its last name (no absolute path in the feed). */
  const feedPath = (p: string) => {
    const rel = win.isAbsolute(p) ? win.relative(cwd, p) : p;
    return rel.startsWith('..') || win.isAbsolute(rel) ? `(outside the work dir) ${win.basename(p)}` : rel === '' ? '.' : rel;
  };
  /** A path as an approval shows it: relative inside the work dir, else whole, so the person sees where it goes. */
  const askPath = (p: string) => {
    const rel = win.isAbsolute(p) ? win.relative(cwd, p) : p;
    return rel.startsWith('..') || win.isAbsolute(rel) ? `(outside the work dir) ${p}` : rel === '' ? '.' : rel;
  };
  const outside = (p: string) => {
    const rel = win.isAbsolute(p) ? win.relative(cwd, p) : p;
    return rel.startsWith('..') || win.isAbsolute(rel);
  };
  const note = (stateName: string, text: string | null = null) => {
    const s = text === null ? null : shownFeed(text, 'head');
    feed.push({ kind: 'note', ref: null, text: s?.text ?? null, state: stateName, redactions: s?.redactions ?? 0 });
  };

  // --- ending ----------------------------------------------------------------------------------------

  const fail = (reason: CodexEndReason, detail: string) => {
    if (terminal()) return;
    // Declined while the child can still read the answers; then it is stopped.
    approvals.declineOwned(ownedId, 'end');
    state = 'failed';
    endReason = reason;
    failure = detail;
    queue.length = 0;
    turnId = null;
    feed.push({ kind: 'lifecycle', ref: null, text: shownFeed(detail, 'head').text, state: reason });
    rpc.stop();
    settleReady(false);
    changed();
  };

  rpc.onExit((exit: RpcExit) => {
    if (terminal()) return;
    // Nobody can answer what the child asked any more.
    approvals.forgetOwned(ownedId);
    asked.clear();
    const what = exit.error !== null ? `pipe ${exit.error}` : exit.code !== null ? `exit code ${exit.code}` : `signal ${String(exit.signal)}`;
    state = 'failed';
    endReason = 'exited';
    failure = what;
    const lost = queue.length;
    queue.length = 0;
    turnId = null;
    feed.push({ kind: 'lifecycle', ref: null, text: what, state: 'exited' });
    if (lost > 0) note('withdrawn', `${lost}`);
    settleReady(false);
    changed();
  });

  pipe.onStderr((chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-L.stderrChars);
  });

  // --- messages --------------------------------------------------------------------------------------

  const input = (text: string) => [{ type: 'text', text }];

  const startTurn = async (text: string) => {
    turnStarting = true;
    changed();
    try {
      const r = obj(await rpc.request('turn/start', { threadId, input: input(text) }));
      const tid = id(obj(r.turn).id);
      if (tid !== null && !terminal() && !endedTurns.includes(tid)) {
        turnId = tid;
        state = 'running';
      }
    } catch (e) {
      if (!terminal()) note('not-sent', errText(e));
    } finally {
      turnStarting = false;
      afterTurnRequest();
    }
  };

  const steer = async (text: string) => {
    const expected = turnId;
    steering = true;
    try {
      await rpc.request('turn/steer', { threadId, expectedTurnId: expected, input: input(text) });
    } catch (e) {
      if (terminal()) return;
      // The turn ended under the steer: the message opens the next turn instead.
      if (turnId !== expected) queue.unshift(text);
      else note('not-sent', errText(e));
    } finally {
      steering = false;
      pump();
    }
  };

  const afterTurnRequest = () => {
    if (interruptWanted && turnId !== null && !terminal()) {
      interruptWanted = false;
      void sendInterrupt(turnId);
    }
    pump();
  };

  const pump = () => {
    changed();
    if (terminal() || threadId === null || queue.length === 0 || turnStarting || steering) return;
    const text = queue.shift()!;
    if (turnId === null) void startTurn(text);
    else void steer(text);
  };

  const sendInterrupt = async (tid: string) => {
    try {
      await rpc.request('turn/interrupt', { threadId, turnId: tid });
    } catch (e) {
      if (!terminal()) note('interrupt-failed', errText(e));
    }
  };

  // --- what codex tells ------------------------------------------------------------------------------

  const itemOf = (iid: string, type: string): Item => {
    let it = items.get(iid);
    if (it === undefined) {
      it = { type, command: null, changes: null, msg: '', out: '' };
      items.set(iid, it);
    }
    return it;
  };

  const changesOf = (v: unknown): { path: string; kind: string; diff: string }[] | null => {
    if (!Array.isArray(v)) return null;
    return v.map((c) => {
      const o = obj(c);
      const k = o.kind;
      const kind = typeof k === 'string' ? k : str(obj(k).type) ?? 'change';
      return { path: str(o.path) ?? '?', kind, diff: str(o.diff) ?? '' };
    });
  };
  const changeSummary = (changes: { path: string; kind: string }[], at: (p: string) => string) => changes.map((c) => `${c.kind} ${at(c.path)}`).join('\n');

  const itemStarted = (item: Obj) => {
    const iid = id(item.id);
    const type = str(item.type);
    if (iid === null || type === null) return;
    if (type === 'agentMessage') {
      itemOf(iid, type);
    } else if (type === 'commandExecution') {
      const it = itemOf(iid, type);
      it.command = str(item.command) ?? '';
      const s = shownFeed(it.command, 'head');
      feed.push({ kind: 'tool', ref: iid, text: s.text, state: 'command', redactions: s.redactions });
    } else if (type === 'fileChange') {
      const it = itemOf(iid, type);
      it.changes = changesOf(item.changes);
      const s = shownFeed(changeSummary(it.changes ?? [], feedPath), 'head');
      feed.push({ kind: 'tool', ref: iid, text: s.text, state: 'file-change', redactions: s.redactions });
    } else if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
      itemOf(iid, type);
      const what = type === 'mcpToolCall' ? `${str(item.server) ?? '?'} / ${str(item.tool) ?? '?'}` : type === 'webSearch' ? str(item.query) ?? '' : str(item.tool) ?? '?';
      const s = shownFeed(what, 'head');
      feed.push({ kind: 'tool', ref: iid, text: s.text, state: type === 'webSearch' ? 'web-search' : type === 'mcpToolCall' ? 'mcp' : 'tool', redactions: s.redactions });
    }
  };

  const STATUS: Readonly<Record<string, string>> = { completed: 'ran', failed: 'failed', declined: 'declined', inProgress: 'running' };

  const itemCompleted = (item: Obj) => {
    const iid = id(item.id);
    const type = str(item.type);
    if (iid === null || type === null) return;
    const it = items.get(iid);
    items.delete(iid);
    if (type === 'agentMessage') {
      feed.settle(`text:${iid}`);
      const raw = (str(item.text) ?? it?.msg ?? '').slice(0, L.messageChars);
      const s = shown(redact, raw, Number.MAX_SAFE_INTEGER, 'head');
      const parts = splitUtf8(s.text, FEED);
      const keep = parts.slice(0, L.finalParts);
      keep.forEach((p, i) => {
        const last = i === keep.length - 1;
        feed.push({ kind: 'text', ref: iid, text: p, state: last && parts.length > keep.length ? 'final-cut' : 'final', redactions: i === 0 ? s.redactions : 0 });
      });
      if (keep.length === 0) feed.push({ kind: 'text', ref: iid, text: '', state: 'final' });
    } else if (type === 'commandExecution') {
      feed.settle(`out:${iid}`);
      const raw = (str(item.aggregatedOutput) ?? it?.out ?? '').slice(-L.outputChars);
      const s = shownFeed(raw, 'tail');
      const exit = item.exitCode;
      feed.push({
        kind: 'tool-result', ref: iid, text: s.text, state: STATUS[str(item.status) ?? ''] ?? 'unknown', redactions: s.redactions,
        exitCode: Number.isSafeInteger(exit) ? (exit as number) : null,
      });
    } else if (type === 'fileChange') {
      const changes = changesOf(item.changes) ?? it?.changes ?? [];
      const s = shownFeed(changeSummary(changes, feedPath), 'head');
      feed.push({ kind: 'tool-result', ref: iid, text: s.text, state: STATUS[str(item.status) ?? ''] ?? 'unknown', redactions: s.redactions });
    } else if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
      feed.push({ kind: 'tool-result', ref: iid, text: null, state: STATUS[str(item.status) ?? ''] ?? 'unknown' });
    }
  };

  const messageDelta = (iid: string, delta: string) => {
    const it = itemOf(iid, 'agentMessage');
    if (it.msg.length < L.messageChars) it.msg += delta.slice(0, L.messageChars - it.msg.length);
    const s = shownFeed(it.msg.slice(-L.liveChars), 'tail');
    feed.upsert(`text:${iid}`, { kind: 'text', ref: iid, text: s.text, state: 'partial', redactions: s.redactions });
  };

  const outputDelta = (iid: string, delta: string) => {
    const it = itemOf(iid, 'commandExecution');
    it.out = (it.out + delta).slice(-L.outputChars);
    const s = shownFeed(it.out.slice(-L.liveChars), 'tail');
    feed.upsert(`out:${iid}`, { kind: 'tool-result', ref: iid, text: s.text, state: 'running', redactions: s.redactions });
  };

  const TURN_END: Readonly<Record<string, string>> = { completed: 'turn-ended', interrupted: 'turn-interrupted', failed: 'turn-failed' };

  rpc.onNotification((method, params) => {
    if (terminal()) return;
    const p = obj(params);
    // Another thread's turns and items (a sub-agent's) are not this session's to show yet; its
    // approvals still come in, and their settling (serverRequest/resolved) is read whatever the thread.
    const tid = str(p.threadId);
    const foreign = tid !== null && threadId !== null && tid !== threadId;
    if (foreign && (method.startsWith('turn/') || method.startsWith('item/') || method.startsWith('thread/'))) return;
    switch (method) {
      case 'turn/started': {
        const t = id(obj(p.turn).id);
        if (t === null || endedTurns.includes(t)) return;
        turnId = t;
        state = 'running';
        feed.push({ kind: 'lifecycle', ref: t, text: null, state: 'turn-started' });
        afterTurnRequest();
        return;
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        const t = id(turn.id);
        if (t !== null) {
          endedTurns.push(t);
          if (endedTurns.length > 32) endedTurns.shift();
        }
        if (t === null || turnId === null || t === turnId) {
          turnId = null;
          state = 'idle';
        }
        items.clear();
        const err = str(obj(turn.error).message);
        const s = err === null ? null : shownFeed(err, 'head');
        feed.push({ kind: 'lifecycle', ref: t, text: s?.text ?? null, state: TURN_END[str(turn.status) ?? ''] ?? 'turn-unknown', redactions: s?.redactions ?? 0 });
        pump();
        return;
      }
      case 'item/started':
        itemStarted(obj(p.item));
        changed();
        return;
      case 'item/completed':
        itemCompleted(obj(p.item));
        changed();
        return;
      case 'item/agentMessage/delta': {
        const iid = id(p.itemId);
        const d = str(p.delta);
        if (iid !== null && d !== null) messageDelta(iid, d);
        changed();
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const iid = id(p.itemId);
        const d = str(p.delta);
        if (iid !== null && d !== null) outputDelta(iid, d);
        changed();
        return;
      }
      case 'thread/tokenUsage/updated': {
        const total = obj(obj(p.tokenUsage).total);
        tokens = Object.freeze({ input: int(total.inputTokens), cachedInput: int(total.cachedInputTokens), output: int(total.outputTokens), total: int(total.totalTokens) });
        feed.upsert('tokens', { kind: 'note', ref: null, text: null, state: 'tokens', tokens });
        changed();
        return;
      }
      case 'error': {
        const e = obj(p.error);
        note(p.willRetry === true ? 'error-retrying' : 'error', str(e.message) ?? 'error');
        changed();
        return;
      }
      case 'serverRequest/resolved': {
        const rid = p.requestId;
        if (typeof rid !== 'number' && typeof rid !== 'string') return;
        const approvalId = asked.get(rpcKey(rid));
        if (approvalId === undefined) return;
        asked.delete(rpcKey(rid));
        // Codex settled it itself (the turn ended under it): the card goes, nobody answered it.
        if (approvals.forget(approvalId)) feed.push({ kind: 'note', ref: approvalId, text: null, state: 'ask-withdrawn' });
        changed();
        return;
      }
      default:
        return;
    }
  });

  // --- what codex asks -------------------------------------------------------------------------------

  type Ask = {
    kind: ApprovalKind;
    title: string;
    preview: string;
    risk: ApprovalRisk;
    canAccept: boolean;
    canText: boolean;
    reply(a: Answer): unknown;
  };

  const queueAsk = (rid: RpcId, ask: Ask) => {
    const t = shown(redact, ask.title, 400, 'head');
    // Bounded before the redactor, far past what a card can show (16 KiB): a cut there halves nothing shown.
    const p = shown(redact, ask.preview.slice(0, 1024 * 1024), Number.MAX_SAFE_INTEGER, 'head');
    let approvalId = '';
    const view = approvals.add({
      ownedId, kind: ask.kind, title: t.text, preview: p.text, redactions: t.redactions + p.redactions, risk: ask.risk, canAccept: ask.canAccept, canText: ask.canText,
      answer: (a: Answer, cause: AnswerCause) => {
        asked.delete(rpcKey(rid));
        rpc.respond(rid, ask.reply(a));
        const shownText = a.decision === 'text' ? shownFeed(a.text, 'head') : null;
        feed.push({
          kind: cause === 'human' ? 'answer' : 'auto-denied', ref: approvalId, text: shownText?.text ?? null,
          state: cause === 'human' ? (a.decision === 'text' ? 'answered' : a.decision) : cause, redactions: shownText?.redactions ?? 0,
        });
        changed();
      },
    });
    approvalId = view.approvalId;
    asked.set(rpcKey(rid), approvalId);
    feed.push({ kind: 'ask', ref: approvalId, text: shownFeed(ask.title, 'head').text, state: ask.kind });
    changed();
  };

  const decide = (a: Answer) => ({ decision: a.decision === 'accept' ? 'accept' : 'decline' });

  const askCommand = (p: Obj): Ask => {
    const command = str(p.command) ?? '';
    const net = p.networkApprovalContext;
    const lines = [
      `command: ${command}`,
      `cwd: ${askPath(str(p.cwd) ?? cwd)}`,
      ...(str(p.reason) !== null ? [`reason: ${str(p.reason)}`] : []),
      ...(net !== undefined && net !== null ? [`network: ${JSON.stringify(net)}`] : []),
      ...(str(p.kind) !== null && p.kind !== 'command' ? [`kind: ${str(p.kind)}`] : []),
    ];
    return {
      kind: 'command', title: command.split('\n', 1)[0] ?? '', preview: lines.join('\n'), risk: net !== undefined && net !== null ? 'net' : 'shell',
      canAccept: true, canText: false, reply: decide,
    };
  };

  const askFileChange = (p: Obj): Ask => {
    const it = items.get(id(p.itemId) ?? '');
    const changes = it?.changes ?? null;
    const grantRoot = str(p.grantRoot);
    const lines: string[] = [];
    if (str(p.reason) !== null) lines.push(`reason: ${str(p.reason)}`);
    if (grantRoot !== null) lines.push(`asks to write under ${askPath(grantRoot)} for the rest of the session: only a refusal is offered`);
    if (changes === null) lines.push('the changes were not announced before this request: only a refusal is offered');
    for (const c of changes ?? []) lines.push(`--- ${c.kind} ${askPath(c.path)}`, c.diff);
    const away = (changes ?? []).some((c) => outside(c.path)) || (grantRoot !== null && outside(grantRoot));
    return {
      kind: 'file-change', title: changes === null ? 'file change' : `${changes.length} file change${changes.length === 1 ? '' : 's'}`, preview: lines.join('\n'),
      risk: away ? 'protected' : 'write', canAccept: changes !== null && grantRoot === null, canText: false, reply: decide,
    };
  };

  const askPermissions = (p: Obj): Ask => {
    const requested = obj(p.permissions);
    const lines = [...(str(p.reason) !== null ? [`reason: ${str(p.reason)}`] : []), `permissions: ${JSON.stringify(requested)}`, 'granted for this turn only'];
    const net = obj(requested.network).enabled === true;
    return {
      kind: 'permissions', title: str(p.reason) ?? 'more permissions', preview: lines.join('\n'), risk: net ? 'net' : 'protected', canAccept: true, canText: false,
      reply: (a) => (a.decision === 'accept' ? { permissions: requested, scope: 'turn' } : { permissions: {}, scope: 'turn' }),
    };
  };

  const askQuestion = (p: Obj): Ask => {
    const questions = Array.isArray(p.questions) ? p.questions.map(obj) : [];
    const lines = questions.flatMap((q) => {
      const options = Array.isArray(q.options) ? q.options.map(obj).map((o) => `  - ${str(o.label) ?? ''}: ${str(o.description) ?? ''}`) : [];
      return [`${str(q.header) ?? ''}`, `${str(q.question) ?? ''}`, ...options, ...(q.isSecret === true ? ['(asks for a secret: only a refusal is offered)'] : [])];
    });
    const one = questions.length === 1 ? questions[0]! : null;
    const qid = one === null ? null : str(one.id);
    return {
      kind: 'question', title: str(one?.question) ?? `${questions.length} questions`, preview: lines.join('\n'), risk: 'other', canAccept: false,
      canText: qid !== null && one!.isSecret !== true,
      reply: (a) => (a.decision === 'text' && qid !== null ? { answers: { [qid]: { answers: [a.text] } } } : { answers: {} }),
    };
  };

  const askElicitation = (p: Obj): Ask => {
    const lines = [`server: ${str(p.serverName) ?? '?'}`, `message: ${str(p.message) ?? ''}`, ...(str(p.url) !== null ? [`url: ${str(p.url)}`] : []), 'only a refusal is offered'];
    return {
      kind: 'elicitation', title: str(p.message) ?? 'an MCP server asks', preview: lines.join('\n'), risk: str(p.url) !== null ? 'net' : 'other',
      canAccept: false, canText: false, reply: () => ({ action: 'decline', content: null }),
    };
  };

  const ASKS: Readonly<Record<string, (p: Obj) => Ask>> = {
    'item/commandExecution/requestApproval': askCommand,
    'item/fileChange/requestApproval': askFileChange,
    'item/permissions/requestApproval': askPermissions,
    'item/tool/requestUserInput': askQuestion,
    'mcpServer/elicitation/request': askElicitation,
  };

  rpc.onRequest((rid, method, params) => {
    const make = Object.hasOwn(ASKS, method) ? ASKS[method]! : null;
    if (make === null) {
      rpc.respondError(rid, UNANSWERED_REQUEST_CODE, `Orchestra does not answer ${method}`);
      if (!terminal()) note('request-refused', method);
      changed();
      return;
    }
    const ask = make(obj(params));
    // A session that is ending answers what still arrives with the refusal.
    if (terminal()) {
      rpc.respond(rid, ask.reply({ decision: 'decline' }));
      return;
    }
    queueAsk(rid, ask);
  });

  // --- start -----------------------------------------------------------------------------------------

  void (async () => {
    try {
      await rpc.request('initialize', { clientInfo: { ...CODEX_CLIENT_INFO } });
      rpc.notify('initialized');
      const r = obj(await rpc.request('thread/start', { cwd, model, approvalPolicy: 'on-request', sandbox: 'workspace-write' }));
      if (terminal()) return;
      const tid = id(obj(r.thread).id);
      const sandbox = str(obj(r.sandbox).type);
      if (tid === null) {
        fail('start-failed', 'thread/start returned no thread id');
        return;
      }
      if (r.approvalPolicy !== 'on-request' || (sandbox !== 'workspaceWrite' && sandbox !== 'readOnly')) {
        fail('policy-mismatch', `approvalPolicy ${JSON.stringify(r.approvalPolicy)}, sandbox ${String(sandbox)}`);
        return;
      }
      threadId = tid;
      state = 'idle';
      feed.push({ kind: 'lifecycle', ref: tid, text: model, state: 'started' });
      settleReady(true);
      pump();
    } catch (e) {
      if (!terminal()) fail('start-failed', errText(e));
      settleReady(false);
    }
  })();

  // --- the session -----------------------------------------------------------------------------------

  const session: CodexSession = {
    ownedId,
    model,
    cwd,
    get state() {
      return state;
    },
    get endReason() {
      return endReason;
    },
    get threadId() {
      return threadId;
    },
    get turnId() {
      return turnId;
    },
    get tokens() {
      return tokens;
    },
    get queued() {
      return queue.length;
    },
    feed,
    ready,
    send(text: string, uuid: string): SendResult {
      if (terminal()) return { ok: false, reason: 'ended' };
      const now = threadId !== null && queue.length === 0 && !turnStarting && !steering;
      if (!now && queue.length >= L.queue) return { ok: false, reason: 'queue-full' };
      const s = shownFeed(text, 'head');
      feed.push({ kind: 'you', ref: null, uuid, text: s.text, state: s.cut ? 'cut' : null, redactions: s.redactions });
      queue.push(text);
      const via = !now ? 'queued' : turnId === null ? 'turn/start' : 'turn/steer';
      pump();
      return { ok: true, via };
    },
    async interrupt() {
      if (terminal()) return { withdrawn: 0, denied: 0 };
      // Slice design §2.5: the approvals first, then the waiting messages, then the turn.
      const denied = approvals.declineOwned(ownedId, 'interrupt');
      const withdrawn = queue.length;
      queue.length = 0;
      if (withdrawn > 0) note('withdrawn', `${withdrawn}`);
      if (turnId !== null) await sendInterrupt(turnId);
      else if (turnStarting) interruptWanted = true;
      changed();
      return { withdrawn, denied };
    },
    end() {
      if (terminal()) return { denied: 0 };
      const denied = approvals.declineOwned(ownedId, 'end');
      const lost = queue.length;
      queue.length = 0;
      state = 'ended';
      endReason = 'you-ended';
      turnId = null;
      if (lost > 0) note('withdrawn', `${lost}`);
      feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'ended' });
      rpc.stop();
      settleReady(false);
      changed();
      return { denied };
    },
    stats: () => ({ rpc: rpc.stats(), stderrTail, failure }),
  };
  return Object.freeze(session);
}
