import * as path from 'node:path';
import type { ChildPipe } from '../os/child-pipe.ts';
import type { JobOutcome } from '../os/procguard.ts';
import type { ClockHub } from '../runtime/clock.ts';
import type { Answer, AnswerCause, ApprovalKind, ApprovalRisk, Approvals } from './approvals.ts';
import type { RpcClient, RpcExit, RpcId, RpcStats } from './codex-rpc.ts';
import type { FeedInput, FeedTokens } from './feed.ts';
import type { Redact } from './text.ts';
import { isWithin } from '../fs/paths.ts';
import { RpcError, makeRpcClient } from './codex-rpc.ts';
import { guardedPlace } from './guarded.ts';
import { Feed } from './feed.ts';
import { isOwnedModel } from './models.ts';
import { OWNED_TEXT_LIMITS, liveTail, shown, splitUtf8 } from './text.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// One owned Codex session over `codex app-server` (orchestra app plan §2; protocol measured on
// codex-cli 0.165.0, shapes from its generated JSON Schema):
//
//   start:     initialize {clientInfo} -> notification initialized -> thread/start {cwd, model,
//              approvalPolicy:'on-request', sandbox:'workspace-write'}. The reply must echo on-request and
//              a workspace-write (or read-only) sandbox, else the session ends as policy-mismatch. A tainted
//              session (a seat request, r4 §8.5) asks for 'untrusted' instead, and its reply must echo that.
//   a message: turn/start while no turn runs; turn/steer {expectedTurnId} while one does; while the
//              thread is still starting, or a turn/start is in flight, it waits here (at most 5).
//   stop:      every open approval of the session is declined first, the waiting messages withdrawn,
//              then turn/interrupt (sent as soon as the turn has an id, if it had none yet).
//   end:       open approvals declined, then the child is stopped (stdin closed, then killed). Started
//              inside a procguard Job (pipe.job), the child is procguard and its end closes the Job, so
//              what codex's commands started dies with it (r4 D4); once it closed, the Job is checked
//              through the resident procguard and the feed says what was found (tree-ended, tree-left,
//              or tree-unsure: unknown, T1). Without a Job (procguard off) only codex.exe itself is
//              killed and the feed says its commands' children may remain (children-may-remain).
//   brake:     (a Job only) every process in the Job is ended at once through the resident procguard,
//              the open approvals are declined, the session ends as braked, then the child's handle
//              goes; the feed says how many processes the Job held and whether any is left.
//   deadlines: initialize and thread/start get 60 s (then start-failed), turn/start and turn/steer 60 s
//              (then the message is msg-unsure: sent, its fate unknown), turn/interrupt 10 s.
//
// Each message of yours carries the uuid of its human record, and its fate is a feed note with that
// uuid as ref: msg-queued (live) while it waits here, then msg-sent (handed to codex), msg-not-sent
// (codex refused it, with why), msg-withdrawn (a stop or the end took it back) or msg-unsure (no answer).
//
// Paths an approval names (a file change, a write root, a command's cwd) are resolved against the work
// dir first, then judged by realpath (junctions followed) against the spawn gate's own cwd table: one
// that hits a protected row (the data dir, a harness root, ~/.claude, ~/.dsh, the repository, AppData...)
// is declined at once without a card (cause protected: an automatic refusal, which D8 allows); one only
// outside the work dir is a card of risk protected, to be held (r4 §10.9).
//
// Order (measured on codex-cli 0.165.0): codex announces a command or file change (item/started) before
// it asks about it, so its row would sit above the card that decides it. The announcement is taken out
// of the feed while the card is open and told again after the answer (or after an automatic refusal, or
// when codex settles the request itself): the feed reads ask, answer, then the command and its result.
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

/**
 * The codex-cli versions this driver was measured on: the app-server protocol, the private CODEX_HOME's
 * [skills] keys (codex-home.ts: a key a later version does not know is ignored without a word) and the
 * Windows sandbox findings (orchestra app plan, "已实测"). codex.exe is the user's global npm install and
 * updates with it; a session whose initialize reply names another version ends as policy-mismatch.
 */
export const CODEX_VERSIONS = frozen(['0.165.0']);

/** The codex-cli version in initialize's userAgent ("<client name>/0.165.0 (Windows ...) ..."), or null. */
export function codexVersionOf(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null;
  const m = /^[^/\s]{1,64}\/(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?)(?:\s|$)/.exec(userAgent);
  return m === null ? null : m[1]!;
}

/** The JSON-RPC error code a server request Orchestra does not answer gets: method not found. */
export const UNANSWERED_REQUEST_CODE = -32601;

export const CODEX_DEADLINES = frozen({ startMs: 60_000, turnMs: 60_000, interruptMs: 10_000 });

/** unknown: a session an earlier orchestrad started (its registry entry outlived a restart); nobody here holds its child. */
export type CodexSessionState = 'starting' | 'idle' | 'running' | 'ended' | 'failed' | 'unknown';
/**
 * daemon-stop: orchestrad ended it on its own way out (nobody pressed end); braked: you stopped its whole
 * tree; requester-withdrew: the agent that asked for it (seat) withdrew, and it was ended by the same stop
 * order as your end; the rest: shared/owned-contract.js.
 */
export type CodexEndReason = 'you-ended' | 'exited' | 'start-failed' | 'policy-mismatch' | 'daemon-restart' | 'daemon-stop' | 'braked' | 'requester-withdrew';
/** Why an end() ran: a person, orchestrad's own stop, or the agent request's withdrawal (seat); each runs the same stop order. */
export type EndWhy = 'you-ended' | 'daemon-stop' | 'requester-withdrew';

/**
 * What the brake did: ok with the processes the Job held when it came (killed) and those left after the
 * wait (left: 0 is the whole tree stopped), each null when procguard could not say (T1: unknown); not ok
 * when the session had ended already, or runs without a Job (procguard off: brake-unavailable).
 */
export type OwnedBrake = { ok: true; killed: number | null; left: number | null } | { ok: false; reason: 'ended' | 'no-job' };

/**
 * The feed note of a Job's end: tree-stopped (the Job held processes when the kill came, its text their
 * count, and none is left), tree-ended (no process was left in it, or no Job of that name is left at
 * all), tree-left (some still counted after the wait, its text how many), tree-unsure (procguard could
 * not say, its text why: T1, unknown, never "none left").
 */
export function treeNote(o: JobOutcome): { state: 'tree-stopped' | 'tree-ended' | 'tree-left' | 'tree-unsure'; text: string | null } {
  if (!o.ok) return { state: 'tree-unsure', text: o.why };
  if (o.left > 0) return { state: 'tree-left', text: `${o.left}` };
  return o.found && o.killed > 0 ? { state: 'tree-stopped', text: `${o.killed}` } : { state: 'tree-ended', text: null };
}
/** No child of it runs here any more (or, unknown, none ever did in this orchestrad). */
export const isOver = (state: CodexSessionState): boolean => state === 'ended' || state === 'failed' || state === 'unknown';

/**
 * Where a path an approval names really lies: its realpath (the nearest existing ancestor's, joined with
 * the rest) and the protected row of the spawn gate's cwd table it hits, or null. src/os/cwd.ts CwdPolicy.place.
 */
export type PathJudge = (absPath: string) => { real: string | null; hit: string | null };

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
  /** The Clock hub the request deadlines run on; without one no request has a deadline. */
  hub?: ClockHub;
  /** Judges the paths an approval names; without one only the lexical place in the work dir counts. */
  judge?: PathJudge;
  /** cwd is a project root or a folder in one (--project-root): thread/start must answer the read-only sandbox, else policy-mismatch. */
  projectRoot?: boolean;
  /**
   * r4 §8.5 来源追踪: the session's turns come from an unbound sender (a seat request: a DSH session asked, a
   * person only dispatched it). thread/start asks for the untrusted approval policy and its reply must echo
   * it, else policy-mismatch. The thread keeps it: turn/start names no approvalPolicy (its schema's field
   * overrides "this turn and subsequent turns" only when given). Absent: on-request, as before.
   */
  tainted?: boolean;
};

/** The approval policy thread/start asks for, and its reply must echo (codex-cli 0.165.0 AskForApproval: untrusted | on-request | never | {granular}). */
export const codexApprovalPolicy = (tainted: boolean): 'untrusted' | 'on-request' => (tainted ? 'untrusted' : 'on-request');

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
  /** Ends the session: a person's end (you-ended), orchestrad stopping (daemon-stop) or its requester withdrawing (requester-withdrew), one stop order. */
  end(why?: EndWhy): { denied: number };
  /** Whether its child's whole tree runs in a Job of its own and the child has not closed (so the brake can still end it, even while it is ending). */
  readonly jobbed: boolean;
  /** The brake: the whole tree stopped now, the approvals declined, the session ended as braked. */
  brake(): Promise<OwnedBrake>;
  stats(): { rpc: RpcStats | null; stderrTail: string; failure: string | null };
};

export type StartResult = { ok: true; session: CodexSession } | { ok: false; reason: 'model-refused' | 'spawn-refused'; detail: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= CODEX_SESSION_LIMITS.idChars ? v : null);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
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
  const rpc: RpcClient = makeRpcClient(pipe, {
    name: /^[0-9a-f]{1,40}$/.test(ownedId) ? ownedId : 'c',
    ...(opts.rpcLineMaxBytes === undefined ? {} : { lineMaxBytes: opts.rpcLineMaxBytes }),
    ...(opts.hub === undefined ? {} : { hub: opts.hub }),
  });
  const D = CODEX_DEADLINES;

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
  const queue: { text: string; uuid: string }[] = [];
  const items = new Map<string, Item>();
  /** Turns codex said ended, so a turn/start reply read after its own turn/completed does not revive it. */
  const endedTurns: string[] = [];
  /** Server request -> the approval it waits on. */
  const asked = new Map<string, string>();
  /** A command's or file change's announcement while its item runs: hidden while an approval about it is open. */
  const toolEvents = new Map<string, { seq: number; input: FeedInput; hidden: boolean }>();
  /** Approval -> the item it decides, while it is open. */
  const askItem = new Map<string, string>();
  /** Items of this turn codex asked about (any answer, an automatic refusal too): a command or file change that ran without one is said (ran-unasked). */
  const askedItems = new Set<string>();

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
  /** The work dir's own realpath, for the place of what lies below it. */
  const realCwd = (() => {
    try {
      return opts.judge?.(cwd).real ?? cwd;
    } catch {
      return cwd;
    }
  })();
  /**
   * Where a path lies: resolved against the work dir first (a relative path, `..` included), then its
   * realpath (a junction in the work dir that points out is outside); the protected row it hits, if any.
   */
  const place = (p: string): { abs: string; real: string; outside: boolean; hit: string | null } => {
    const abs = win.resolve(cwd, p);
    let j: { real: string | null; hit: string | null };
    try {
      j = opts.judge === undefined ? { real: abs, hit: null } : opts.judge(abs);
    } catch (e) {
      j = { real: null, hit: `unresolved: ${errText(e)}` };
    }
    const real = j.real ?? abs;
    return { abs, real, outside: !isWithin(abs, cwd) || !isWithin(real, realCwd), hit: j.hit };
  };
  /** A path as the feed shows it: relative inside the work dir, else only its last name (no absolute path in the feed). */
  const feedPath = (p: string) => {
    const at = place(p);
    const rel = win.relative(cwd, at.abs);
    return at.outside ? `(outside the work dir) ${win.basename(at.abs)}` : rel === '' ? '.' : rel;
  };
  /** A path as an approval shows it: relative inside the work dir, else whole (and where it really goes), so the person sees it. */
  const askPath = (p: string) => {
    const at = place(p);
    const rel = win.relative(cwd, at.abs);
    if (!at.outside) return rel === '' ? '.' : rel;
    return `(outside the work dir) ${at.abs}${at.real.toLowerCase() !== at.abs.toLowerCase() ? ` (really ${at.real})` : ''}`;
  };
  const note = (stateName: string, text: string | null = null) => {
    const s = text === null ? null : shownFeed(text, 'head');
    feed.push({ kind: 'note', ref: null, text: s?.text ?? null, state: stateName, redactions: s?.redactions ?? 0 });
  };
  /** Takes a command's announcement out of the feed while a card about it is open. */
  const hideTool = (iid: string | null) => {
    const t = iid === null ? undefined : toolEvents.get(iid);
    if (t === undefined || t.hidden) return;
    feed.withdraw(t.seq);
    t.hidden = true;
  };
  /** Tells a hidden announcement again, below what decided it. */
  const showTool = (iid: string | null) => {
    const t = iid === null ? undefined : toolEvents.get(iid);
    if (t === undefined || !t.hidden) return;
    t.seq = feed.push(t.input).seq;
    t.hidden = false;
  };
  const showAllTools = () => {
    for (const iid of toolEvents.keys()) showTool(iid);
  };
  /** A message's fate, under its uuid: msg-queued is live (replaced), the rest are final. */
  const fate = (uuid: string, stateName: 'msg-queued' | 'msg-sent' | 'msg-not-sent' | 'msg-withdrawn' | 'msg-unsure', text: string | null = null) => {
    if (uuid === '') return;
    const s = text === null ? null : shownFeed(text, 'head');
    const ev = { kind: 'note' as const, ref: uuid, text: s?.text ?? null, state: stateName, redactions: s?.redactions ?? 0 };
    if (stateName === 'msg-queued') {
      feed.upsert(`msg:${uuid}`, ev);
    } else {
      feed.settle(`msg:${uuid}`);
      feed.push(ev);
    }
  };
  /** Every waiting message goes back: each says so under its uuid, and one note counts them. */
  const withdrawAll = (): number => {
    const lost = queue.splice(0, queue.length);
    for (const m of lost) fate(m.uuid, 'msg-withdrawn');
    if (lost.length > 0) note('withdrawn', `${lost.length}`);
    return lost.length;
  };
  /** The Job the child's tree runs in (null: procguard off). */
  const job = pipe.job ?? null;
  /** The brake took the tree: the check after the close is its own, not repeated. */
  let braked = false;
  /** Without a Job only codex.exe is killed: what its commands started may outlive it. With one, the check after the close says. */
  const residue = () => {
    if (job === null) note('children-may-remain');
  };
  const noteTree = (o: JobOutcome) => {
    const n = treeNote(o);
    note(n.state, n.text);
    changed();
  };
  /** The child (the wrapper, with procguard) closed. */
  let closed = false;
  // However the child closed (an end, a failure, an exit of its own), its Job is checked once it did:
  // the wrapper's close closed the Job, so this finds nothing left, or ends what is and says so.
  pipe.onClose(() => {
    closed = true;
    if (job === null || braked) return;
    void job.endTree().then(noteTree);
  });

  // --- ending ----------------------------------------------------------------------------------------

  const fail = (reason: CodexEndReason, detail: string) => {
    if (terminal()) return;
    // Declined while the child can still read the answers; then it is stopped.
    approvals.declineOwned(ownedId, 'end');
    state = 'failed';
    endReason = reason;
    failure = detail;
    withdrawAll();
    turnId = null;
    feed.push({ kind: 'lifecycle', ref: null, text: shownFeed(detail, 'head').text, state: reason });
    rpc.stop();
    residue();
    settleReady(false);
    changed();
  };

  rpc.onExit((exit: RpcExit) => {
    // A pipe that failed may leave its child running (the client stops it too): stopped here whatever
    // ended the session, so no codex.exe outlives it and holds a seat nobody can see (D4, D8's brake).
    rpc.stop();
    if (terminal()) return;
    // Nobody can answer what the child asked any more.
    approvals.forgetOwned(ownedId);
    asked.clear();
    askItem.clear();
    showAllTools();
    const what = exit.error !== null ? `pipe ${exit.error}` : exit.code !== null ? `exit code ${exit.code}` : `signal ${String(exit.signal)}`;
    state = 'failed';
    endReason = 'exited';
    failure = what;
    turnId = null;
    feed.push({ kind: 'lifecycle', ref: null, text: what, state: 'exited' });
    withdrawAll();
    residue();
    settleReady(false);
    changed();
  });

  pipe.onStderr((chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-L.stderrChars);
  });

  // --- messages --------------------------------------------------------------------------------------

  const input = (text: string) => [{ type: 'text', text }];

  /** A request that failed: refused (not sent), or unanswered by its deadline (sent, its fate unknown). */
  const lost = (m: { uuid: string }, e: unknown) => {
    if (e instanceof RpcError && e.reason === 'timeout') fate(m.uuid, 'msg-unsure', errText(e));
    else fate(m.uuid, 'msg-not-sent', errText(e));
  };

  const startTurn = async (m: { text: string; uuid: string }) => {
    turnStarting = true;
    changed();
    try {
      const r = obj(await rpc.request('turn/start', { threadId, input: input(m.text) }, D.turnMs));
      const tid = id(obj(r.turn).id);
      if (tid !== null && !terminal() && !endedTurns.includes(tid)) {
        turnId = tid;
        state = 'running';
      }
      fate(m.uuid, 'msg-sent');
    } catch (e) {
      if (!terminal()) lost(m, e);
    } finally {
      turnStarting = false;
      afterTurnRequest();
    }
  };

  const steer = async (m: { text: string; uuid: string }) => {
    const expected = turnId;
    steering = true;
    try {
      await rpc.request('turn/steer', { threadId, expectedTurnId: expected, input: input(m.text) }, D.turnMs);
      fate(m.uuid, 'msg-sent');
    } catch (e) {
      if (terminal()) return;
      // The turn ended under the steer: the message opens the next turn instead.
      if (turnId !== expected && !(e instanceof RpcError && e.reason === 'timeout')) {
        queue.unshift(m);
        fate(m.uuid, 'msg-queued');
      } else {
        lost(m, e);
      }
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
    const m = queue.shift()!;
    if (turnId === null) void startTurn(m);
    else void steer(m);
  };

  const sendInterrupt = async (tid: string) => {
    try {
      await rpc.request('turn/interrupt', { threadId, turnId: tid }, D.interruptMs);
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
      const input: FeedInput = { kind: 'tool', ref: iid, text: s.text, state: 'command', redactions: s.redactions };
      toolEvents.set(iid, { seq: feed.push(input).seq, input, hidden: false });
    } else if (type === 'fileChange') {
      const it = itemOf(iid, type);
      it.changes = changesOf(item.changes);
      const s = shownFeed(changeSummary(it.changes ?? [], feedPath), 'head');
      const input: FeedInput = { kind: 'tool', ref: iid, text: s.text, state: 'file-change', redactions: s.redactions };
      toolEvents.set(iid, { seq: feed.push(input).seq, input, hidden: false });
    } else if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
      itemOf(iid, type);
      const what = type === 'mcpToolCall' ? `${str(item.server) ?? '?'} / ${str(item.tool) ?? '?'}` : type === 'webSearch' ? str(item.query) ?? '' : str(item.tool) ?? '?';
      const s = shownFeed(what, 'head');
      feed.push({ kind: 'tool', ref: iid, text: s.text, state: type === 'webSearch' ? 'web-search' : type === 'mcpToolCall' ? 'mcp' : 'tool', redactions: s.redactions });
    }
  };

  /**
   * A command or file change that ran (completed or failed) though codex never asked about it: it is
   * said in the feed (ran-unasked), so a run past the approval queue (codex runs what it judges safe
   * without asking, and on Windows its sandbox is only read-only) is never just another row (D8, r4 §10.9).
   */
  const ranUnasked = (iid: string, status: string | null, what: string) => {
    if (askedItems.has(iid) || (status !== 'completed' && status !== 'failed')) return;
    note('ran-unasked', what.split('\n', 1)[0] ?? '');
  };

  const STATUS: Readonly<Record<string, string>> = { completed: 'ran', failed: 'failed', declined: 'declined', inProgress: 'running' };

  const itemCompleted = (item: Obj) => {
    const iid = id(item.id);
    const type = str(item.type);
    if (iid === null || type === null) return;
    const it = items.get(iid);
    items.delete(iid);
    // A result never comes before its command: an announcement still hidden is told first.
    showTool(iid);
    toolEvents.delete(iid);
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
      ranUnasked(iid, str(item.status), it?.command ?? str(item.command) ?? '');
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
      ranUnasked(iid, str(item.status), changeSummary(changes, feedPath));
      const s = shownFeed(changeSummary(changes, feedPath), 'head');
      feed.push({ kind: 'tool-result', ref: iid, text: s.text, state: STATUS[str(item.status) ?? ''] ?? 'unknown', redactions: s.redactions });
    } else if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
      feed.push({ kind: 'tool-result', ref: iid, text: null, state: STATUS[str(item.status) ?? ''] ?? 'unknown' });
    }
  };

  const messageDelta = (iid: string, delta: string) => {
    const it = itemOf(iid, 'agentMessage');
    if (it.msg.length < L.messageChars) it.msg += delta.slice(0, L.messageChars - it.msg.length);
    const s = liveTail(redact, it.msg, L.liveChars, FEED);
    feed.upsert(`text:${iid}`, { kind: 'text', ref: iid, text: s.text, state: 'partial', redactions: s.redactions });
  };

  const outputDelta = (iid: string, delta: string) => {
    const it = itemOf(iid, 'commandExecution');
    it.out = (it.out + delta).slice(-L.outputChars);
    const s = liveTail(redact, it.out, L.liveChars, FEED);
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
        askedItems.clear();
        showAllTools();
        toolEvents.clear();
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
        const { inputTokens: i, cachedInputTokens: c, outputTokens: o, totalTokens: t } = total;
        // T1: a count codex did not report whole is not a 0; the last whole report stands (null before any).
        if (!count(i) || !count(c) || !count(o) || !count(t)) return;
        tokens = Object.freeze({ input: i, cachedInput: c, output: o, total: t });
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
        showTool(askItem.get(approvalId) ?? null);
        askItem.delete(approvalId);
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
    /** The protected row a path of the request hits: then it is declined at once, without a card. */
    refuse: string | null;
    /** The command or file change the request decides (its itemId), if codex named one. */
    item: string | null;
    reply(a: Answer): unknown;
  };

  type AskBase = Omit<Ask, 'item'>;

  const queueAsk = (rid: RpcId, ask: Ask) => {
    const t = shown(redact, ask.title, 400, 'head');
    // Bounded before the redactor, far past what a card can show (16 KiB): a cut there halves nothing shown.
    const p = shown(redact, ask.preview.slice(0, 1024 * 1024), Number.MAX_SAFE_INTEGER, 'head');
    let approvalId = '';
    const view = approvals.add({
      ownedId, kind: ask.kind, title: t.text, preview: p.text, redactions: t.redactions + p.redactions, risk: ask.risk, canAccept: ask.canAccept, canText: ask.canText,
      tainted: opts.tainted === true,
      answer: (a: Answer, cause: AnswerCause) => {
        asked.delete(rpcKey(rid));
        rpc.respond(rid, ask.reply(a));
        const shownText = a.decision === 'text' ? shownFeed(a.text, 'head') : null;
        feed.push({
          kind: cause === 'human' ? 'answer' : 'auto-denied', ref: approvalId, text: shownText?.text ?? null,
          state: cause === 'human' ? (a.decision === 'text' ? 'answered' : a.decision) : cause, redactions: shownText?.redactions ?? 0,
        });
        askItem.delete(approvalId);
        showTool(ask.item);
        changed();
      },
    });
    approvalId = view.approvalId;
    asked.set(rpcKey(rid), approvalId);
    if (ask.item !== null) askItem.set(approvalId, ask.item);
    hideTool(ask.item);
    feed.push({ kind: 'ask', ref: approvalId, text: shownFeed(ask.title, 'head').text, state: ask.kind });
    changed();
  };

  const decide = (a: Answer) => ({ decision: a.decision === 'accept' ? 'accept' : 'decline' });

  const askCommand = (p: Obj): AskBase => {
    const command = str(p.command) ?? '';
    const net = p.networkApprovalContext;
    const at = str(p.cwd) ?? cwd;
    // What codex says the command reads, lists or searches (commandActions): a path outside the work dir is named.
    const away = (Array.isArray(p.commandActions) ? p.commandActions.map(obj) : [])
      .map((a) => ({ type: str(a.type) ?? '?', path: str(a.path) }))
      .filter((a): a is { type: string; path: string } => a.path !== null && a.path !== '' && place(a.path).outside)
      .map((a) => `outside the work dir: ${a.type} ${askPath(a.path)}`);
    const lines = [
      `command: ${command}`,
      `cwd: ${askPath(at)}`,
      ...away,
      ...(str(p.reason) !== null ? [`reason: ${str(p.reason)}`] : []),
      ...(net !== undefined && net !== null ? [`network: ${JSON.stringify(net)}`] : []),
      ...(str(p.kind) !== null && p.kind !== 'command' ? [`kind: ${str(p.kind)}`] : []),
    ];
    return {
      kind: 'command', title: command.split('\n', 1)[0] ?? '', preview: lines.join('\n'), risk: net !== undefined && net !== null ? 'net' : 'shell',
      canAccept: true, canText: false, refuse: place(at).hit, reply: decide,
    };
  };

  const askFileChange = (p: Obj): AskBase => {
    const it = items.get(id(p.itemId) ?? '');
    const changes = it?.changes ?? null;
    const grantRoot = str(p.grantRoot);
    const lines: string[] = [];
    if (str(p.reason) !== null) lines.push(`reason: ${str(p.reason)}`);
    if (grantRoot !== null) lines.push(`asks to write under ${askPath(grantRoot)} for the rest of the session: only a refusal is offered`);
    if (changes === null) lines.push('the changes were not announced before this request: only a refusal is offered');
    for (const c of changes ?? []) lines.push(`--- ${c.kind} ${askPath(c.path)}`, c.diff);
    const places = [...(changes ?? []).map((c) => place(c.path)), ...(grantRoot === null ? [] : [place(grantRoot)])];
    const away = places.some((x) => x.outside);
    // r4 §7.4: a file other programs run or read as configuration (.git/hooks, .claude, package.json ...) is no ordinary write.
    const guarded = [...new Set(places.map((x) => guardedPlace({ p: x.abs, real: x.real }, cwd, realCwd)).filter((g): g is string => g !== null))];
    if (guarded.length > 0) lines.unshift(`changes a protected path in the work dir (r4 §7.4, run by other programs outside this session): ${guarded.join(', ')}`);
    return {
      kind: 'file-change', title: changes === null ? 'file change' : `${changes.length} file change${changes.length === 1 ? '' : 's'}`, preview: lines.join('\n'),
      risk: away || guarded.length > 0 ? 'protected' : 'write', canAccept: changes !== null && grantRoot === null, canText: false,
      refuse: places.find((x) => x.hit !== null)?.hit ?? null, reply: decide,
    };
  };

  const askPermissions = (p: Obj): AskBase => {
    const requested = obj(p.permissions);
    const lines = [...(str(p.reason) !== null ? [`reason: ${str(p.reason)}`] : []), `permissions: ${JSON.stringify(requested)}`, 'granted for this turn only'];
    const net = obj(requested.network).enabled === true;
    return {
      kind: 'permissions', title: str(p.reason) ?? 'more permissions', preview: lines.join('\n'), risk: net ? 'net' : 'protected', canAccept: true, canText: false, refuse: null,
      reply: (a) => (a.decision === 'accept' ? { permissions: requested, scope: 'turn' } : { permissions: {}, scope: 'turn' }),
    };
  };

  const askQuestion = (p: Obj): AskBase => {
    const questions = Array.isArray(p.questions) ? p.questions.map(obj) : [];
    const lines = questions.flatMap((q) => {
      const options = Array.isArray(q.options) ? q.options.map(obj).map((o) => `  - ${str(o.label) ?? ''}: ${str(o.description) ?? ''}`) : [];
      return [`${str(q.header) ?? ''}`, `${str(q.question) ?? ''}`, ...options, ...(q.isSecret === true ? ['(asks for a secret: only a refusal is offered)'] : [])];
    });
    const one = questions.length === 1 ? questions[0]! : null;
    const qid = one === null ? null : str(one.id);
    return {
      kind: 'question', title: str(one?.question) ?? `${questions.length} questions`, preview: lines.join('\n'), risk: 'other', canAccept: false,
      canText: qid !== null && one!.isSecret !== true, refuse: null,
      reply: (a) => (a.decision === 'text' && qid !== null ? { answers: { [qid]: { answers: [a.text] } } } : { answers: {} }),
    };
  };

  const askElicitation = (p: Obj): AskBase => {
    const lines = [`server: ${str(p.serverName) ?? '?'}`, `message: ${str(p.message) ?? ''}`, ...(str(p.url) !== null ? [`url: ${str(p.url)}`] : []), 'only a refusal is offered'];
    return {
      kind: 'elicitation', title: str(p.message) ?? 'an MCP server asks', preview: lines.join('\n'), risk: str(p.url) !== null ? 'net' : 'other',
      canAccept: false, canText: false, refuse: null, reply: () => ({ action: 'decline', content: null }),
    };
  };

  const ASKS: Readonly<Record<string, (p: Obj) => AskBase>> = {
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
    const ask = { ...make(obj(params)), item: id(obj(params).itemId) };
    if (ask.item !== null && askedItems.size < 4096) askedItems.add(ask.item);
    // A session that is ending answers what still arrives with the refusal.
    if (terminal()) {
      rpc.respond(rid, ask.reply({ decision: 'decline' }));
      return;
    }
    // A protected path: declined at once, no card (slice design §2.2: an automatic refusal; D8 forbids only automatic allows).
    if (ask.refuse !== null) {
      rpc.respond(rid, ask.reply({ decision: 'decline' }));
      hideTool(ask.item);
      const s = shownFeed(`${ask.title} (${ask.refuse})`, 'head');
      feed.push({ kind: 'auto-denied', ref: null, text: s.text, state: 'protected', redactions: s.redactions });
      showTool(ask.item);
      changed();
      return;
    }
    queueAsk(rid, ask);
  });

  // --- start -----------------------------------------------------------------------------------------

  void (async () => {
    try {
      const init = obj(await rpc.request('initialize', { clientInfo: { ...CODEX_CLIENT_INFO } }, D.startMs));
      if (terminal()) return;
      const version = codexVersionOf(init.userAgent);
      if (version === null || !CODEX_VERSIONS.includes(version)) {
        fail('policy-mismatch', `codex-cli ${version ?? 'version unknown'}; Orchestra was measured on ${CODEX_VERSIONS.join(', ')}`);
        return;
      }
      rpc.notify('initialized');
      const policy = codexApprovalPolicy(opts.tainted === true);
      const r = obj(await rpc.request('thread/start', { cwd, model, approvalPolicy: policy, sandbox: 'workspace-write' }, D.startMs));
      if (terminal()) return;
      const tid = id(obj(r.thread).id);
      const sandbox = str(obj(r.sandbox).type);
      if (tid === null) {
        fail('start-failed', 'thread/start returned no thread id');
        return;
      }
      if (r.approvalPolicy !== policy || (sandbox !== 'workspaceWrite' && sandbox !== 'readOnly')) {
        fail('policy-mismatch', `approvalPolicy ${JSON.stringify(r.approvalPolicy)}, sandbox ${String(sandbox)}`);
        return;
      }
      // In a project root (a real project, not its own empty work dir) only the read-only sandbox (as measured
      // on Windows, codex 0.165.0) keeps every write asking: under workspace-write, on-request writes in cwd unasked.
      if (opts.projectRoot === true && sandbox !== 'readOnly') {
        fail('policy-mismatch', `sandbox ${String(sandbox)} in a project root: Orchestra runs codex there only with the read-only sandbox`);
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
      queue.push({ text, uuid });
      const via = !now ? 'queued' : turnId === null ? 'turn/start' : 'turn/steer';
      if (!now) fate(uuid, 'msg-queued');
      pump();
      return { ok: true, via };
    },
    async interrupt() {
      if (terminal()) return { withdrawn: 0, denied: 0 };
      // Slice design §2.5: the approvals first, then the waiting messages, then the turn. The turn's
      // interrupt is sent, not awaited: its outcome is the feed's (turn-interrupted, or interrupt-failed).
      const denied = approvals.declineOwned(ownedId, 'interrupt');
      const withdrawn = withdrawAll();
      if (turnId !== null) void sendInterrupt(turnId);
      else if (turnStarting) interruptWanted = true;
      changed();
      return { withdrawn, denied };
    },
    end(why: EndWhy = 'you-ended') {
      if (terminal()) return { denied: 0 };
      const denied = approvals.declineOwned(ownedId, 'end');
      state = 'ended';
      endReason = why === 'daemon-stop' || why === 'requester-withdrew' ? why : 'you-ended';
      turnId = null;
      withdrawAll();
      feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'ended' });
      rpc.stop();
      residue();
      settleReady(false);
      changed();
      return { denied };
    },
    get jobbed() {
      return job !== null && !closed && !braked;
    },
    async brake(): Promise<OwnedBrake> {
      if (closed || braked) return { ok: false, reason: 'ended' };
      if (job === null) return { ok: false, reason: 'no-job' };
      braked = true;
      // The kill goes first; the rest of the end happens while procguard ends the tree.
      const ending = job.endTree();
      approvals.declineOwned(ownedId, 'brake');
      // Ending already (its child not closed yet): the end reason it had stays, the feed says braked.
      if (!terminal()) {
        state = 'ended';
        endReason = 'braked';
        turnId = null;
        withdrawAll();
        settleReady(false);
      }
      feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'braked' });
      changed();
      const o = await ending;
      // The wrapper too: its Job is empty (or going with it, when procguard could not say).
      rpc.stop();
      noteTree(o);
      return o.ok ? { ok: true, killed: o.killed, left: o.left } : { ok: true, killed: null, left: null };
    },
    stats: () => ({ rpc: rpc.stats(), stderrTail, failure }),
  };
  return Object.freeze(session);
}
