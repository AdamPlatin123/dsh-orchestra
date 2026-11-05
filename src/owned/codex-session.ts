import * as path from 'node:path';
import type { ChildPipe } from '../os/child-pipe.ts';
import type { JobOutcome } from '../os/procguard.ts';
import type { ClockHub } from '../runtime/clock.ts';
import type { Answer, AnswerCause, ApprovalKind, ApprovalOrigin, ApprovalRisk, Approvals } from './approvals.ts';
import type { DispatchPort } from '../route/dispatch.ts';
import { DISPATCH_TOOL } from '../route/dispatch.ts';
import type { RpcClient, RpcExit, RpcId, RpcStats } from './codex-rpc.ts';
import type { FeedInput, FeedTokens } from './feed.ts';
import type { MemberBase, MemberRun, SessionMember } from './members.ts';
import type { Redact } from './text.ts';
import { isWithin } from '../fs/paths.ts';
import { RpcError, makeRpcClient } from './codex-rpc.ts';
import { guardedPlace } from './guarded.ts';
import { Feed } from './feed.ts';
import { MEMBERS_STOP_REF, MEMBER_LIMITS, memberRun, memberTable } from './members.ts';
import { isOwnedModel } from './models.ts';
import { REGISTRY_LIMITS, memberLive } from './registry.ts';
import { oneShot } from '../runtime/clock.ts';
import { OWNED_TEXT_LIMITS, liveTail, shown, splitUtf8 } from './text.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// One owned Codex session over `codex app-server` (orchestra app plan §2; protocol measured on
// codex-cli 0.165.0, shapes from its generated JSON Schema):
//
//   start:     initialize {clientInfo, capabilities} -> notification initialized -> thread/start {cwd, model,
//              approvalPolicy:'on-request', sandbox:'workspace-write'}. capabilities asks for experimentalApi,
//              which thread/backgroundTerminals/* need (without it codex refuses them; with it, measured, the
//              replies to initialize and thread/start carry the same keys). The reply must echo on-request and
//              a workspace-write (or read-only) sandbox, else the session ends as policy-mismatch. A tainted
//              session (a seat request, r4 §8.5) asks for 'untrusted' instead, and its reply must echo that.
//   a message: turn/start while no turn runs; turn/steer {expectedTurnId} while one does; while the
//              thread is still starting, or a turn/start is in flight, it waits here (at most 5).
//   stop:      every open approval of the session is declined first, the waiting messages withdrawn,
//              then turn/interrupt (sent as soon as the turn has an id, if it had none yet) and, with a turn
//              or a command known to be out, thread/backgroundTerminals/clean on the root (see Root commands
//              below), then the sub-agents, whether or not the root still has a turn (see Sub-agents below).
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
//              (then the message is msg-unsure: sent, its fate unknown), turn/interrupt and
//              thread/backgroundTerminals/* 10 s each; a stop reads its outcome 2 s after those answered.
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
//
// The dispatch tool (src/route/dispatch.ts; measured on codex-cli 0.165.0, 2026-11-05): thread/start's dynamicTools gives the
// root thread orchestra_dispatch, on both v1 and v2 models. A call comes as the server request item/tool/call, with the
// item/started and item/completed of a dynamicToolCall around it, and no approval comes first under on-request or untrusted.
// A sub-agent's thread does not get the tool (measured: it said it had none); one that called anyway would be refused here.
// The request may stay open: a reply 330 s later came through. turn/interrupt cancels it on codex's side, the item completes
// failed and the turn interrupted, so a stop takes back a card still waiting and answers the request all the same. The
// answer is {contentItems, success}: success false reaches the model with its text. The call's row in the feed is the note
// dispatch.ts says, not a tool row: the tool's rows are left out as an Agent call's are.
//
// Sub-agents (measured on codex-cli 0.165.0, 2026-11-04, three real runs): a thread that is not the
// session's own is one of its sub-agents, a member. Nothing needs turning on: the private CODEX_HOME's
// default model can spawn them (codex-home.ts). They run in the same codex.exe, inside the same Job, under
// the same approval policy (measured on on-request sessions only: under a tainted session's untrusted it
// was not, and the feed says so, members-untrusted); their requests come here with their own threadId. Only
// their state is read: what another thread says never enters this feed, but for the title of a request it
// makes, always under its name (the ask row, an automatic refusal). A member is known from whichever comes first:
//   v2 models:  subAgentActivity items on the root thread: started names agentThreadId and agentPath,
//               completed says it reported back; there is no kind for a failure;
//   v1 models:  a collabAgentToolCall spawnAgent names it only when it completes (receiverThreadIds), and
//               wait and closeAgent carry agentsStates; no subAgentActivity, and no name anywhere but
//               thread/read (agentNickname), asked once when its turn starts;
//   both:       its own thread/status/changed and turn/started and turn/completed; no thread/started or
//               thread/closed ever came for one, and in v1 its first status came 3 ms before the spawn's
//               item/completed, so a thread nobody announced is taken as it is.
// How the state moves: a turn that starts makes it running, and only a new turn revives one that is over;
// a report makes it returned (T2: nothing is ever done); a turn that failed or was interrupted makes it
// ended with that reason, whatever said otherwise before. Its own steps can fail and its turn still
// complete (measured: exit code 1, turn and activity completed), so those are counted apart (failed).
// When the session goes, a member still live turns unknown (T1), never running: the root going idle says
// nothing about one (measured: an approval came from a member after the root turn had ended).
// A stop (measured 2026-11-04, one member in a long command): turn/interrupt on the root leaves the member's
// turn and command running. turn/interrupt on the member's thread with its turn id is answered, its turn
// completes interrupted (no subAgentActivity comes), and its command runs on: no item/completed, the process
// still in the Job 10 s later. thread/backgroundTerminals/clean on its thread ends it (the list is per
// thread, osPid null): item/completed failed with exit code -1, after the turn's end, the process gone within
// 250 ms. So each live member gets both, in that order, and so does one over whose turn or command is still
// open or whose last stop was not confirmed: its state says it ended, not that its command did. The same goes
// for one that comes up while a stop is on its way (the root's interrupt cancels no spawn, measured), in a
// round of its own. Sending says nothing: its state moves only on what comes back, and the feed says
// members-stopping (live), then members-stopped (no turn open and no background terminal left) and
// members-not-stopped (the rest, those of unknown state and those past the bound); the brake ends them all
// with the Job. The final notes carry the live one's ref, as members-stop-unanswered does when the session goes
// first: a page keeps a live event until one of its ref comes, and the feed never says one was taken out.
// More members than the bound are counted (members-over), never dropped in silence. A request from a
// member says which on its card, inside what the digest covers; a file change it announced is kept for that
// card apart from the session's own items, whose end is the root turn's, and a member outlives that (measured).
// A step of its that ran though codex never asked is counted (member.ranUnasked, members-ran-unasked),
// without its words. The model codex says it runs on is kept: spawn_agent's model never meets isOwnedModel,
// so one outside the list is said (member-off-list), not stopped. session.tokens is the root thread's only:
// each member reports its own count, which is not added in.
//
// A dispatch: the root sending a member out is the one thing of theirs that is the root's own act, so it is a feed
// event (a note of state dispatch), and the only one: what a member says stays out. Its ref is the member's node id
// (src/sources/tower.ts: a hash, no thread id reaches the page), its text the name (null until one is known; v1 knows
// it only from thread/read, and then it is told again with the name, under the same ref, the first telling left where
// it stands, so its row keeps its place on a page opened later as on one open all along), its batch the dispatch it
// belongs to. It comes from subAgentActivity started (v2) or a spawnAgent that names its thread (v1), on the root
// thread only: a spawn on a member's thread (nested, not measured) is not the root's act, and that member has no
// batch, as has one nothing announced. Nothing in the protocol says which spawns were one decision, so a batch is what
// the root thread shows: the spawns of one turn (the turnId of their items) with no other item of the root started
// between them, reasoning, a message or a wait included. Two calls of one model reply and two steps back to back read
// the same here, and both count as one dispatch. An item that names no turn is a batch of its own, and opens none.
//
// Root commands (measured 2026-11-04): turn/interrupt on the root leaves a running command in the Job, as it does a
// member's, and thread/backgroundTerminals/clean on the root ends it. So a stop of a turn sends both, in that order,
// whether or not a command was seen open: clean takes nothing else from the session, which stands idle and takes the
// next message. A root with no turn gets the clean only when a command is known to be out (one its turn left open, or
// one the last stop did not confirm): those leave the stop on offer (session.stoppable), and with none the stop is not
// offered and sends nothing, so a process whose item ended and that stays behind an idle root is neither seen nor
// reached (the brake is). What the clean is about to end is read first (thread/backgroundTerminals/list, between the
// interrupt and the clean), so a process an earlier turn left is said too; a count is of ids, the items seen open and
// the list's itemId, each once. Sending says nothing again: 2 s later the list says, and the feed says commands-stopping
// (live), then commands-stopped (the turn over and the list empty) or commands-not-stopped; nothing when nothing was
// open and the list came back empty or not at all. One not confirmed that comes back later takes its count off, and
// when the last has, commands-back says so, as it does when all came back but the turn or the list said nothing. The
// command comes back failed after the turn's end, so a turn's end keeps what was asked about a command still out, or it
// would read as run past the queue, and a command a stop reached comes back as stopped, not failed: what codex said is
// its exit code.

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
  idChars: REGISTRY_LIMITS.memberIdChars,
  /** The sub-agents one session lists; past this they are only counted (members.ts). */
  members: MEMBER_LIMITS.members,
  /** The file changes of sub-agents kept at once for their cards; past this the oldest goes, and its card offers only a refusal. */
  memberChanges: 64,
  /** Of the sub-agents' open items, those kept as asked about; the root's own bound. */
  memberAsked: 4096,
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

export const CODEX_DEADLINES = frozen({ startMs: 60_000, turnMs: 60_000, interruptMs: 10_000, stopSettleMs: 2_000 });

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
  /** r4 §8.5: where its turns came from (a seat request), shown at the top of its cards; display only. */
  origin?: ApprovalOrigin | null;
  /** Offers the root thread the dispatch tool, and takes its calls; absent: no such tool, thread/start as before. */
  dispatch?: DispatchPort;
};

/** The approval policy thread/start asks for, and its reply must echo (codex-cli 0.165.0 AskForApproval: untrusted | on-request | never | {granular}). */
export const codexApprovalPolicy = (tainted: boolean): 'untrusted' | 'on-request' => (tainted ? 'untrusted' : 'on-request');

/** A sub-agent of the session as its driver knows it now (members.ts). */
export type CodexMember = SessionMember;

export type SendResult = { ok: true; via: 'turn/start' | 'turn/steer' | 'queued' } | { ok: false; reason: 'ended' | 'queue-full' };

export type CodexSession = {
  readonly ownedId: string;
  readonly model: string;
  readonly cwd: string;
  readonly state: CodexSessionState;
  readonly endReason: CodexEndReason | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  /** r4 §8.5: its turns come from an unbound sender, as thread/start was told. */
  readonly tainted: boolean;
  /** The root thread's latest total token usage as codex reported it, or null before any; a sub-agent's own usage is not in it. */
  readonly tokens: FeedTokens | null;
  /** Messages waiting here. */
  readonly queued: number;
  /** Its sub-agents, in the order they were first heard of. */
  readonly members: readonly CodexMember[];
  /** Sub-agents past the bound, counted and not listed. */
  readonly membersOver: number;
  /** Moves whenever what the registry keeps of the members changes. */
  readonly membersRev: number;
  /** A stop has a member to reach: one live, or one over with something that may still run. */
  readonly stoppable: boolean;
  /** Where its sub-agents leave the run a request waits on. */
  readonly run: MemberRun;
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
/** A time codex gave in ms, or in seconds (a turn's), as wall ms; null when it gave none. */
const atMs = (v: unknown): number | null => (count(v) ? v : null);
const atSecs = (v: unknown): number | null => (count(v) && Number.isSafeInteger(v * 1000) ? v * 1000 : null);
const rpcKey = (rid: RpcId) => (typeof rid === 'number' ? `n:${rid}` : `s:${rid}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Changes = { path: string; kind: string; diff: string }[];
type Item = { type: string; command: string | null; changes: Changes | null; msg: string; out: string };

type Member = MemberBase & {
  /** The turn codex last said ended, so a turn/started read after it does not revive the member. */
  endedTurn: string | null;
  /** The turn codex said started and not yet ended: what a stop interrupts. */
  turn: string | null;
  /** Its commands announced and not yet ended: they outlive an interrupted turn (measured). */
  commands: Set<string>;
  /** The last stop that reached it did not end with its list empty and its turn over. */
  stopLeft: boolean;
  /** thread/read was asked for its name (once). */
  nameAsked: boolean;
};

/** The refs of a stop's notes, live and final: the members', the root's own commands'. */
const STOP_REF = MEMBERS_STOP_REF;
const ROOT_STOP_REF = 'root-stop';

/** A root item that sends a sub-agent out: the one kind that leaves a batch open. */
const spawns = (item: Obj) => (str(item.type) === 'subAgentActivity' && str(item.kind) === 'started') || (str(item.type) === 'collabAgentToolCall' && str(item.tool) === 'spawnAgent');

/** Something of its may still run, whatever its state says. */
const memberBusy = (m: Member) => m.state === 'running' || m.turn !== null || m.commands.size > 0 || m.stopLeft;
/** A stop has something to send it. Of one in an unknown state no turn is known (T1). */
const stopReaches = (m: Member) => m.state !== 'unknown' && (memberLive(m) || memberBusy(m));

/** Starts an owned Codex session; the child is running when this returns ok, the thread starting. */
export function startCodexSession(opts: CodexSessionOptions): StartResult {
  // A session a seat request started is tainted even if the caller left tainted out (r4 §8.5): its policy and its
  // cards agree, and the owned contract (such an origin only on a tainted entry) never fails the whole list over it.
  // A worker's dispatch is no unbound sender: its session is tainted only when the caller says so (that worker is).
  if (opts.origin?.kind === 'agent-request' && opts.tainted !== true) opts = { ...opts, tainted: true };
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
  /** A command's or file change's announcement while its item runs: hidden while an approval about it is open, held from then until it is allowed (held, it never ran). */
  const toolEvents = new Map<string, { seq: number; input: FeedInput; hidden: boolean; held: boolean }>();
  /** Approval -> the item it decides, while it is open. */
  const askItem = new Map<string, string>();
  /** Items of this turn codex asked about (any answer, an automatic refusal too): a command or file change that ran without one is said (ran-unasked). */
  const askedItems = new Set<string>();
  /** Approval -> the member that asked, while it is open. */
  const askMember = new Map<string, Member>();
  /** Dispatch tool calls waiting for their answer: each one's way to take a card still waiting back. */
  const calls = new Set<() => void>();
  const dropCalls = () => {
    for (const giveUp of [...calls]) giveUp();
  };
  /** Sub-agents' file changes by thread and item, from their announcement to their end, for the card that may ask about them. */
  const memberChanges = new Map<string, Changes>();
  /** Sub-agents' items codex asked about (any answer, an automatic refusal too), by thread and item, until they end. */
  const memberAsked = new Set<string>();
  /** Steps of sub-agents, listed or only counted, that ran though codex never asked. */
  let memberUnasked = 0;
  /** A stop is on its way to the sub-agents: another press adds nothing to it. */
  let membersStopping = false;
  /** A stop is on its way to the root's commands. */
  let rootStopping = false;
  /** The root's commands a stop reached and that have not come back. */
  const rootStopped = new Set<string>();
  /** The root's commands that ran and that their turn's end left open, until they come back or a stop confirms none is left. */
  const rootOpen = new Set<string>();
  /** The ids the last stop of the root's could not confirm gone and that have not come back; none when it could. */
  const rootLeft = new Set<string>();
  /** How many the last commands-not-stopped said. */
  let rootSaid = 0;
  /** The timer of a stop's wait, made at the first stop. */
  let stopAfter: ((ms: number, fn: () => void) => () => void) | null = null;

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
  /** A stop's final word: it takes the place of the live note, in the feed and on a page that holds it. */
  const stopSaid = (ref: string, stateName: string, text: string | null) => {
    feed.settle(ref);
    feed.push({ kind: 'note', ref, text, state: stateName });
  };
  /** Takes a command's announcement out of the feed while a card about it is open. */
  const hideTool = (iid: string | null) => {
    const t = iid === null ? undefined : toolEvents.get(iid);
    if (t === undefined || t.hidden) return;
    feed.withdraw(t.seq);
    t.hidden = true;
    t.held = true;
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
  /** The thread id, if it is a thread of a sub-agent. */
  const memberThread = (v: unknown): string | null => {
    const t = id(v);
    return t === null || threadId === null || t === threadId ? null : t;
  };
  /** A sub-agent's item: an id of its thread, which may mean something else on another. */
  const memberKey = (tid: string, iid: string) => `${tid}\n${iid}`;
  /** Sub-agents by thread id, in the order first heard of (members.ts). */
  const table = memberTable<Member>({
    ownedId, feed, redact, idWord: 'thread', note,
    extra: () => ({ endedTurn: null, turn: null, commands: new Set<string>(), stopLeft: false, nameAsked: false }),
    // Measured under on-request only: whether it takes this thread's untrusted or the config's on-request nobody knows.
    onFirst: () => {
      if (opts.tainted === true) note('members-untrusted');
    },
  });
  const { all: members, over: overIds, of: memberOf, move: moveMember, started: memberStart, runs: memberRuns, returned: memberReturned, ended: memberEnded, name: memberName, dispatched, model: memberModel, label: memberLabel } = table;
  /** The session is gone: nobody can hear a member again, so one still live is unknown, never running (T1). */
  const loseMembers = () => {
    const stopping = feed.last((e) => e.live && e.ref === STOP_REF);
    if (stopping !== null) stopSaid(STOP_REF, 'members-stop-unanswered', stopping.text);
    const stoppingRoot = feed.last((e) => e.live && e.ref === ROOT_STOP_REF);
    if (stoppingRoot !== null) stopSaid(ROOT_STOP_REF, 'commands-stop-unanswered', stoppingRoot.text);
    askMember.clear();
    table.lose();
    dropCalls();
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
    // Nothing yet: a failure here comes before the thread's id, and without it no thread is a member. For whatever fails later.
    loseMembers();
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
    loseMembers();
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
      void stopTurn(turnId, new Set(rootOut()));
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

  /** A request of a stop to a thread: its reply, or null when codex refused it or never answered. */
  const stopCall = async (method: string, params: Obj): Promise<Obj | null> => {
    try {
      return obj(await rpc.request(method, params, D.interruptMs));
    } catch {
      return null;
    }
  };

  /** Its turn first, then what that leaves running: an interrupted turn does not end its command (measured). */
  const stopMember = async (m: Member) => {
    if (m.turn !== null) await stopCall('turn/interrupt', { threadId: m.threadId, turnId: m.turn });
    await stopCall('thread/backgroundTerminals/clean', { threadId: m.threadId });
  };

  /** The background terminals its list holds; null when that is not known (T1). */
  const terminalsOn = async (tid: string): Promise<unknown[] | null> => {
    const r = await stopCall('thread/backgroundTerminals/list', { threadId: tid });
    return r !== null && Array.isArray(r.data) ? r.data : null;
  };
  const terminalsLeft = async (tid: string) => (await terminalsOn(tid))?.length ?? null;
  /** The root's list by item, each entry once. */
  const rootTerminals = async () => (await terminalsOn(threadId!))?.map((t, i) => id(obj(t).itemId) ?? `terminal ${i}`) ?? null;

  const stopPause = () => new Promise<void>((r) => {
    if (opts.hub === undefined) {
      r();
      return;
    }
    stopAfter ??= oneShot(opts.hub, `codex-stop-${/^[0-9a-f]{1,40}$/.test(ownedId) ? ownedId : 'c'}`);
    stopAfter(D.stopSettleMs, r);
  });

  /**
   * The stop reaches what it can; what it did is read afterwards, from what came back. Each round takes the
   * members no round took yet, so one that came up on the way gets the same, and the last read finds none new.
   * `busy` are those it says it stopped or not (an idle one has no turn, only what it may have left).
   */
  const stopMembers = async () => {
    membersStopping = true;
    /** Each member reached, and whether its list said none is left. */
    const heard = new Map<Member, boolean>();
    const busy = new Set<Member>();
    for (;;) {
      const round = [...members.values()].filter((m) => stopReaches(m) && !heard.has(m));
      if (round.length === 0) break;
      for (const m of round) if (memberBusy(m)) busy.add(m);
      if (busy.size > 0) feed.upsert(STOP_REF, { kind: 'note', ref: STOP_REF, text: `${busy.size}`, state: 'members-stopping' });
      await Promise.all(round.map(stopMember));
      await stopPause();
      if (terminal()) break;
      const left = await Promise.all(round.map((m) => terminalsLeft(m.threadId)));
      round.forEach((m, i) => heard.set(m, left[i] === 0));
    }
    membersStopping = false;
    // The session went meanwhile: its end says what became of them.
    if (terminal()) return;
    const left = [...heard].filter(([m, clean]) => !clean || m.state === 'running' || m.state === 'unknown' || m.turn !== null).map(([m]) => m);
    for (const m of heard.keys()) {
      m.stopLeft = left.includes(m);
      if (!m.stopLeft) m.commands.clear();
    }
    const stopped = [...busy].filter((m) => !left.includes(m)).length;
    // Of one in an unknown state, or past the bound, no turn is known (T1).
    const unsure = [...members.values()].filter((m) => m.state === 'unknown' && !heard.has(m)).length + overIds.size;
    if (stopped > 0) stopSaid(STOP_REF, 'members-stopped', `${stopped}`);
    if (left.length + unsure > 0) stopSaid(STOP_REF, 'members-not-stopped', `${left.length + unsure}`);
    changed();
  };

  /** Commands of the root known to be out with no turn to say so. */
  const rootOut = () => [...rootOpen, ...rootLeft];
  /** A stop reached these: what comes back of them is the stop's. */
  const rootReached = (ids: Iterable<string>) => {
    for (const iid of ids) rootStopped.add(iid);
    while (rootStopped.size > L.memberChanges) rootStopped.delete(rootStopped.values().next().value!);
  };

  /**
   * The root's turn, then what that leaves running (see Root commands in the header). `open` are the ids of the
   * commands the stop found out, and it adds what the list holds. What it did is read afterwards, from what came back.
   */
  const stopRoot = async (turn: string | null, open: Set<string>) => {
    rootStopping = true;
    const stopping = () => {
      if (open.size > 0) feed.upsert(ROOT_STOP_REF, { kind: 'note', ref: ROOT_STOP_REF, text: `${open.size}`, state: 'commands-stopping' });
    };
    // A message after the stop may have opened a turn: what that runs is on the list, and no part of this stop.
    const moved = () => turnId !== null && turnId !== turn;
    const notBack = () => [...open].filter((iid) => rootStopped.has(iid));
    stopping();
    if (turn !== null) await sendInterrupt(turn);
    const found = terminal() || moved() ? null : await rootTerminals();
    if (found !== null && found.some((iid) => !open.has(iid))) {
      for (const iid of found) open.add(iid);
      if (!terminal()) stopping();
    }
    rootReached(open);
    await stopCall('thread/backgroundTerminals/clean', { threadId });
    await stopPause();
    const left = terminal() ? null : moved() ? notBack() : await rootTerminals();
    rootStopping = false;
    // The session went meanwhile: its end says what became of them.
    if (terminal()) return;
    const heard = left?.length === 0 && (turn === null || turnId !== turn);
    rootLeft.clear();
    if (heard) rootOpen.clear();
    else for (const iid of [...notBack(), ...(left ?? [])]) rootLeft.add(iid);
    rootSaid = rootLeft.size;
    if (heard && open.size > 0) stopSaid(ROOT_STOP_REF, 'commands-stopped', `${open.size}`);
    else if (rootLeft.size > 0) stopSaid(ROOT_STOP_REF, 'commands-not-stopped', `${rootLeft.size}`);
    else if (open.size > 0) stopSaid(ROOT_STOP_REF, 'commands-back', `${open.size}`);
    changed();
  };

  /** A stop of a turn; while one is on its way its clean has gone out, and only the turn is new. */
  const stopTurn = (turn: string, open: Set<string>) => (rootStopping ? sendInterrupt(turn) : stopRoot(turn, open));

  // --- what codex tells ------------------------------------------------------------------------------

  const itemOf = (iid: string, type: string): Item => {
    let it = items.get(iid);
    if (it === undefined) {
      it = { type, command: null, changes: null, msg: '', out: '' };
      items.set(iid, it);
    }
    return it;
  };

  const changesOf = (v: unknown): Changes | null => {
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
      toolEvents.set(iid, { seq: feed.push(input).seq, input, hidden: false, held: false });
    } else if (type === 'fileChange') {
      const it = itemOf(iid, type);
      it.changes = changesOf(item.changes);
      const s = shownFeed(changeSummary(it.changes ?? [], feedPath), 'head');
      const input: FeedInput = { kind: 'tool', ref: iid, text: s.text, state: 'file-change', redactions: s.redactions };
      toolEvents.set(iid, { seq: feed.push(input).seq, input, hidden: false, held: false });
    } else if (type === 'dynamicToolCall' && item.tool === DISPATCH_TOOL.name) {
      // Its row is the note the dispatcher says.
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
      const reached = rootStopped.delete(iid);
      rootOpen.delete(iid);
      ranUnasked(iid, str(item.status), it?.command ?? str(item.command) ?? '');
      feed.settle(`out:${iid}`);
      const raw = (str(item.aggregatedOutput) ?? it?.out ?? '').slice(-L.outputChars);
      const s = shownFeed(raw, 'tail');
      const exit = item.exitCode;
      feed.push({
        kind: 'tool-result', ref: iid, text: s.text, state: reached && str(item.status) === 'failed' ? 'stopped' : STATUS[str(item.status) ?? ''] ?? 'unknown', redactions: s.redactions,
        exitCode: Number.isSafeInteger(exit) ? (exit as number) : null,
      });
      // The last one a stop could not confirm came back: the note that said so has its answer, and nothing is left to stop.
      if (rootLeft.delete(iid) && rootLeft.size === 0 && !rootStopping) stopSaid(ROOT_STOP_REF, 'commands-back', `${rootSaid}`);
    } else if (type === 'fileChange') {
      const changes = changesOf(item.changes) ?? it?.changes ?? [];
      ranUnasked(iid, str(item.status), changeSummary(changes, feedPath));
      const s = shownFeed(changeSummary(changes, feedPath), 'head');
      feed.push({ kind: 'tool-result', ref: iid, text: s.text, state: STATUS[str(item.status) ?? ''] ?? 'unknown', redactions: s.redactions });
    } else if (type === 'dynamicToolCall' && item.tool === DISPATCH_TOOL.name) {
      // As at its start.
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

  // --- what codex says of its sub-agents -------------------------------------------------------------

  /** A sub-agent nothing has named yet: thread/read, once, for its nickname or role. Without an answer it stays unnamed (T1). */
  const askMemberName = async (m: Member) => {
    m.nameAsked = true;
    try {
      const t = obj(obj(await rpc.request('thread/read', { threadId: m.threadId }, D.interruptMs)).thread);
      if (terminal()) return;
      memberName(m, str(t.agentNickname) ?? str(t.agentRole));
      changed();
    } catch {
      // Nothing for the feed: the tower says its name is not known.
    }
  };

  const subAgentActivity = (item: Obj, at: number | null, root: boolean, turn: string | null) => {
    const tid = memberThread(item.agentThreadId);
    const m = tid === null ? null : memberOf(tid);
    if (m === null) return;
    m.lastAt = opts.now();
    memberName(m, str(item.agentPath));
    memberModel(m, str(item.model));
    const kind = str(item.kind);
    if (kind === 'started') {
      memberStart(m, at);
      memberRuns(m);
      if (root) dispatched(m, turn);
    } else if (kind === 'completed') {
      memberReturned(m, at);
    } else if (kind === 'interrupted') {
      memberEnded(m, 'interrupted', at);
    }
  };

  /** A member's last known status in a collab call (agentsStates; its message is another thread's words, never read). */
  const collabState = (m: Member, status: string | null, at: number | null) => {
    if (status === 'pendingInit' || status === 'running') memberRuns(m);
    else if (status === 'completed') memberReturned(m, at);
    else if (status === 'interrupted') memberEnded(m, 'interrupted', at);
    else if (status === 'errored') memberEnded(m, 'failed', at);
    else if (status === 'shutdown' && m.state !== 'returned' && m.state !== 'ended') memberEnded(m, 'shutdown', at);
    else if (status === 'notFound' && memberLive(m)) moveMember(m, 'unknown');
  };

  const collabCall = (item: Obj, done: boolean, at: number | null, root: boolean, turn: string | null) => {
    const spawn = str(item.tool) === 'spawnAgent';
    const named = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    const states = obj(item.agentsStates);
    for (const raw of [...named, ...Object.keys(states)]) {
      const tid = memberThread(raw);
      const m = tid === null ? null : memberOf(tid);
      if (m === null) continue;
      m.lastAt = opts.now();
      if (spawn) {
        memberStart(m, at);
        memberModel(m, str(item.model));
        if (root) dispatched(m, turn);
      }
    }
    for (const [raw, st] of Object.entries(states)) {
      const m = members.get(raw);
      if (m !== undefined) collabState(m, str(obj(st).status), at);
    }
    // A spawn that named nobody: there is no thread to list, so the feed says it.
    if (spawn && done && named.length === 0 && str(item.status) === 'failed') note('subagent-spawn-failed');
  };

  /** The items that tell of sub-agents, on whichever thread they come; every other item is left to the session's own. */
  const memberItem = (p: Obj, done: boolean, root: boolean) => {
    const item = obj(p.item);
    const type = str(item.type);
    const at = atMs(done ? p.completedAtMs : p.startedAtMs);
    const turn = id(p.turnId);
    if (type === 'subAgentActivity') subAgentActivity(item, at, root, turn);
    else if (type === 'collabAgentToolCall') collabCall(item, done, at, root, turn);
  };

  /**
   * A sub-agent's command or file change. Announced, its changes are kept for a card, never for this feed.
   * Ended, one that ran though codex never asked is counted, and said without its words: a run past the
   * approval queue leaves a trace here too (ranUnasked is the root's; D8, r4 §10.9).
   */
  const memberStep = (done: boolean, item: Obj, tid: string, m: Member | null) => {
    const iid = id(item.id);
    const type = str(item.type);
    if (iid === null || (type !== 'commandExecution' && type !== 'fileChange')) return;
    const key = memberKey(tid, iid);
    if (m !== null && type === 'commandExecution') {
      if (done) m.commands.delete(iid);
      else m.commands.add(iid);
      if (m.commands.size > L.memberChanges) m.commands.delete(m.commands.values().next().value!);
      changed();
    }
    if (!done) {
      const changes = type === 'fileChange' ? changesOf(item.changes) : null;
      if (changes === null) return;
      memberChanges.set(key, changes);
      if (memberChanges.size > L.memberChanges) memberChanges.delete(memberChanges.keys().next().value!);
      return;
    }
    memberChanges.delete(key);
    const asked = memberAsked.delete(key);
    const status = str(item.status);
    if (asked || (status !== 'completed' && status !== 'failed')) return;
    memberUnasked++;
    if (m !== null) m.ranUnasked++;
    table.bump();
    feed.upsert('members-ran-unasked', { kind: 'note', ref: null, text: `${memberUnasked}`, state: 'members-ran-unasked' });
  };

  /** Its turn ended: nothing of that turn can be asked about any more. */
  const memberTurnOver = (tid: string) => {
    for (const k of memberChanges.keys()) if (k.startsWith(`${tid}\n`)) memberChanges.delete(k);
    for (const k of memberAsked) if (k.startsWith(`${tid}\n`)) memberAsked.delete(k);
  };

  /** What a sub-agent's own thread says: its state and times, nothing it wrote. Fields that are missing move nothing. */
  const memberHeard = (method: string, p: Obj, tid: string) => {
    const m = memberOf(tid);
    if (method === 'item/started' || method === 'item/completed') {
      memberItem(p, method === 'item/completed', false);
      memberStep(method === 'item/completed', obj(p.item), tid, m);
    }
    // An interrupted turn's command ends after it, once a stop cleans it up: what was asked about it is still needed then.
    if (method === 'turn/completed' && str(obj(p.turn).status) !== 'interrupted') memberTurnOver(tid);
    if (m === null) return;
    m.lastAt = opts.now();
    switch (method) {
      case 'thread/status/changed': {
        const status = str(obj(p.status).type);
        if (status === 'active') memberRuns(m);
        else if (status === 'idle' && (m.state === 'running' || m.state === 'unknown')) moveMember(m, 'idle');
        else if (status === 'systemError') memberEnded(m, 'failed', null);
        // Unloaded (measured after a closeAgent, on one that had reported): of one still live it says nothing more.
        else if (status === 'notLoaded' && memberLive(m)) moveMember(m, 'unknown');
        return;
      }
      case 'turn/started': {
        const turn = obj(p.turn);
        const t = id(turn.id);
        if (t !== null && t === m.endedTurn) return;
        m.turn = t;
        moveMember(m, 'running');
        m.endedAt = null;
        memberStart(m, atSecs(turn.startedAt));
        if (m.name === null && !m.nameAsked) void askMemberName(m);
        return;
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        const status = str(turn.status);
        const at = atSecs(turn.completedAt);
        m.endedTurn = id(turn.id);
        if (m.endedTurn === null || m.endedTurn === m.turn) m.turn = null;
        memberStart(m, atSecs(turn.startedAt));
        if (status === 'completed') memberReturned(m, at);
        else if (status === 'interrupted') memberEnded(m, 'interrupted', at);
        else if (status === 'failed') memberEnded(m, 'failed', at);
        else if (memberLive(m)) moveMember(m, 'unknown');
        return;
      }
      case 'item/completed':
        // A command a stop ended comes back failed after the interrupted turn (measured): not a step of its that failed.
        if (str(obj(p.item).status) === 'failed' && m.why !== 'interrupted') {
          m.failed++;
          table.bump();
        }
        return;
      case 'error':
        if (p.willRetry !== true) {
          m.failed++;
          table.bump();
        }
        return;
      default:
    }
  };

  rpc.onNotification((method, params) => {
    if (terminal()) return;
    const p = obj(params);
    // Another thread's turns and items (a sub-agent's) are read for its state only: nothing it says enters
    // this feed. Its approvals still come in, and their settling (serverRequest/resolved) is read whatever the thread.
    const tid = str(p.threadId);
    const foreign = tid !== null && threadId !== null && tid !== threadId;
    if (foreign && (method.startsWith('turn/') || method.startsWith('item/') || method.startsWith('thread/') || method === 'error')) {
      const was = table.rev;
      const from = memberThread(tid);
      if (from !== null) memberHeard(method, p, from);
      if (table.rev !== was) changed();
      return;
    }
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
        // A turn's end does not end its commands (measured on an interrupted one): one that ran and is still open is out,
        // and what was asked about whatever may yet come back is still needed then, past this turn and the next.
        for (const [iid, t] of toolEvents) if (!t.held && t.input.state === 'command') rootOpen.add(iid);
        while (rootOpen.size > L.memberChanges) rootOpen.delete(rootOpen.values().next().value!);
        for (const iid of askedItems) if (!toolEvents.has(iid) && !rootOpen.has(iid) && !rootStopped.has(iid)) askedItems.delete(iid);
        showAllTools();
        toolEvents.clear();
        const err = str(obj(turn.error).message);
        const s = err === null ? null : shownFeed(err, 'head');
        feed.push({ kind: 'lifecycle', ref: t, text: s?.text ?? null, state: TURN_END[str(turn.status) ?? ''] ?? 'turn-unknown', redactions: s?.redactions ?? 0 });
        pump();
        return;
      }
      case 'item/started':
        if (!spawns(obj(p.item))) table.closeDispatch();
        memberItem(p, false, true);
        itemStarted(obj(p.item));
        changed();
        return;
      case 'item/completed':
        memberItem(p, true, true);
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
        askSettled(approvalId);
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
    /** The session's own command or file change the request decides (its itemId), if codex named one; a member's has no row here. */
    item: string | null;
    /** The sub-agent that asks; null when the session itself does, or past the bound. */
    member: Member | null;
    /** How the card names that sub-agent; null when the session itself asks. */
    via: string | null;
    reply(a: Answer): unknown;
  };

  type AskBase = Omit<Ask, 'item' | 'member' | 'via'>;

  /** A request as the feed tells it: a sub-agent's under its name, so what it asked is never taken for the session's. */
  const told = (ask: Ask) => (ask.via === null ? ask.title : `${ask.via}: ${ask.title}`);

  /** A member's approval left the queue, however it did. */
  const askSettled = (approvalId: string) => {
    const m = askMember.get(approvalId);
    if (m === undefined) return;
    askMember.delete(approvalId);
    m.asks = m.asks.filter((a) => a !== approvalId);
  };

  const queueAsk = (rid: RpcId, ask: Ask) => {
    const t = shown(redact, ask.title, 400, 'head');
    // Bounded before the redactor, far past what a card can show (16 KiB): a cut there halves nothing shown.
    const p = shown(redact, ask.preview.slice(0, 1024 * 1024), Number.MAX_SAFE_INTEGER, 'head');
    let approvalId = '';
    const view = approvals.add({
      ownedId, kind: ask.kind, title: t.text, preview: p.text, redactions: t.redactions + p.redactions, risk: ask.risk, canAccept: ask.canAccept, canText: ask.canText,
      tainted: opts.tainted === true, origin: opts.origin ?? null,
      answer: (a: Answer, cause: AnswerCause) => {
        asked.delete(rpcKey(rid));
        rpc.respond(rid, ask.reply(a));
        const shownText = a.decision === 'text' ? shownFeed(a.text, 'head') : null;
        feed.push({
          kind: cause === 'human' ? 'answer' : 'auto-denied', ref: approvalId, text: shownText?.text ?? null,
          state: cause === 'human' ? (a.decision === 'text' ? 'answered' : a.decision) : cause, redactions: shownText?.redactions ?? 0,
        });
        askItem.delete(approvalId);
        askSettled(approvalId);
        const tool = ask.item === null ? undefined : toolEvents.get(ask.item);
        if (tool !== undefined && a.decision === 'accept') tool.held = false;
        showTool(ask.item);
        changed();
      },
    });
    approvalId = view.approvalId;
    asked.set(rpcKey(rid), approvalId);
    if (ask.item !== null) askItem.set(approvalId, ask.item);
    if (ask.member !== null) {
      ask.member.asks.push(approvalId);
      askMember.set(approvalId, ask.member);
    }
    hideTool(ask.item);
    feed.push({ kind: 'ask', ref: approvalId, text: shownFeed(told(ask), 'head').text, state: ask.kind });
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
    const from = memberThread(p.threadId);
    const iid = id(p.itemId) ?? '';
    const changes = (from === null ? items.get(iid)?.changes : memberChanges.get(memberKey(from, iid))) ?? null;
    const grantRoot = str(p.grantRoot);
    const lines: string[] = [];
    if (str(p.reason) !== null) lines.push(`reason: ${str(p.reason)}`);
    if (grantRoot !== null) lines.push(`asks to write under ${askPath(grantRoot)} for the rest of the session: only a refusal is offered`);
    // Of a sub-agent's, Orchestra may have let the announcement go (L.memberChanges): it only knows it holds none.
    if (changes === null) lines.push(from === null ? 'the changes were not announced before this request: only a refusal is offered' : 'Orchestra holds no announcement of these changes: only a refusal is offered');
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

  /** What item/tool/call answers. */
  const toolReply = (ok: boolean, text: string) => ({ contentItems: [{ type: 'inputText', text }], success: ok });

  /** A dispatch tool call of the root thread: orchestrad decides; the answer may be a person's, minutes away. */
  const dispatchCall = (rid: RpcId, p: Obj) => {
    const port = opts.dispatch!;
    if (p.tool !== DISPATCH_TOOL.name || terminal() || memberThread(p.threadId) !== null) {
      rpc.respond(rid, toolReply(false, 'This tool is not available here.'));
      return;
    }
    const call = port.call(ownedId, p.arguments, (n) => {
      if (terminal()) return;
      const s = n.text === null ? null : shownFeed(n.text, 'head');
      feed.push({ kind: 'note', ref: n.ref, text: s?.text ?? null, state: n.state, redactions: s?.redactions ?? 0 });
      changed();
    });
    const giveUp = () => {
      calls.delete(giveUp);
      call.cancel();
    };
    calls.add(giveUp);
    void call.reply.then((r) => {
      calls.delete(giveUp);
      rpc.respond(rid, toolReply(r.ok, r.text));
      changed();
    });
  };

  rpc.onRequest((rid, method, params) => {
    if (method === 'item/tool/call' && opts.dispatch !== undefined) return dispatchCall(rid, obj(params));
    const make = Object.hasOwn(ASKS, method) ? ASKS[method]! : null;
    if (make === null) {
      rpc.respondError(rid, UNANSWERED_REQUEST_CODE, `Orchestra does not answer ${method}`);
      if (!terminal()) note('request-refused', method);
      changed();
      return;
    }
    const p = obj(params);
    const made = make(p);
    // A sub-agent's request: its card says which, in the preview, so the digest of what the person saw covers it.
    // Measured for the command request; the other kinds carry the same threadId in their types.
    const from = terminal() ? null : memberThread(p.threadId);
    const member = from === null ? null : memberOf(from);
    if (member !== null) {
      member.lastAt = opts.now();
      memberRuns(member);
    }
    const via = from === null ? null : memberLabel(member, from);
    const iid = id(p.itemId);
    const ask: Ask = { ...made, preview: via === null ? made.preview : `from subagent: ${via}\n${made.preview}`, item: from === null ? iid : null, member, via };
    if (ask.item !== null && askedItems.size < 4096) askedItems.add(ask.item);
    if (from !== null && iid !== null && memberAsked.size < L.memberAsked) memberAsked.add(memberKey(from, iid));
    // A session that is ending answers what still arrives with the refusal.
    if (terminal()) {
      rpc.respond(rid, ask.reply({ decision: 'decline' }));
      return;
    }
    // A protected path: declined at once, no card (slice design §2.2: an automatic refusal; D8 forbids only automatic allows).
    if (ask.refuse !== null) {
      rpc.respond(rid, ask.reply({ decision: 'decline' }));
      hideTool(ask.item);
      const s = shownFeed(`${told(ask)} (${ask.refuse})`, 'head');
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
      const init = obj(await rpc.request('initialize', { clientInfo: { ...CODEX_CLIENT_INFO }, capabilities: { experimentalApi: true, requestAttestation: false } }, D.startMs));
      if (terminal()) return;
      const version = codexVersionOf(init.userAgent);
      if (version === null || !CODEX_VERSIONS.includes(version)) {
        fail('policy-mismatch', `codex-cli ${version ?? 'version unknown'}; Orchestra was measured on ${CODEX_VERSIONS.join(', ')}`);
        return;
      }
      rpc.notify('initialized');
      const policy = codexApprovalPolicy(opts.tainted === true);
      const r = obj(await rpc.request('thread/start', { cwd, model, approvalPolicy: policy, sandbox: 'workspace-write', ...(opts.dispatch === undefined ? {} : { dynamicTools: [{ type: 'function', ...DISPATCH_TOOL }] }) }, D.startMs));
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
    tainted: opts.tainted === true,
    get tokens() {
      return tokens;
    },
    get queued() {
      return queue.length;
    },
    get members() {
      return table.list();
    },
    get membersOver() {
      return overIds.size;
    },
    get membersRev() {
      return table.rev;
    },
    get stoppable() {
      return rootOut().length > 0 || [...members.values()].some(stopReaches);
    },
    get run() {
      return memberRun(members.values(), false, terminal());
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
      // Before the refusals below: a command whose card is open never ran, and the refusal shows it again.
      const running = [...toolEvents].filter(([, t]) => !t.held && t.input.state === 'command').map(([iid]) => iid);
      // By id: a command the last stop left and still running is one command, however many presses it took.
      const open = new Set([...running, ...rootOut()]);
      rootReached(open);
      // Slice design §2.5: the approvals first, then the waiting messages, then the turn. The turn's
      // interrupt is sent, not awaited: its outcome is the feed's (turn-interrupted, or interrupt-failed).
      const denied = approvals.declineOwned(ownedId, 'interrupt');
      const withdrawn = withdrawAll();
      dropCalls();
      if (turnId !== null) void stopTurn(turnId, open);
      else {
        if (turnStarting) interruptWanted = true;
        if (open.size > 0 && !rootStopping) void stopRoot(null, open);
      }
      // Its sub-agents, with the root's turn or without one (a root that went idle leaves them running, measured).
      // Sent is not stopped: the outcome is the feed's. What it cannot reach is said too.
      const anyToSay = overIds.size > 0 || [...members.values()].some((m) => m.state === 'unknown' || stopReaches(m));
      if (!membersStopping && anyToSay) void stopMembers();
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
      loseMembers();
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
        loseMembers();
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
