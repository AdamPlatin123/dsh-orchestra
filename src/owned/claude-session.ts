import * as path from 'node:path';
import type { After, HostPipe } from '../os/owned-proc.ts';
import type { ClockHub, Fired } from '../runtime/clock.ts';
import type { DispatchPort } from '../route/dispatch.ts';
import type { StatusPort } from '../route/front-desk.ts';
import type { Answer, AnswerCause, ApprovalKind, ApprovalOrigin, ApprovalRisk, Approvals } from './approvals.ts';
import type { PathJudge } from './codex-session.ts';
import type { FeedInput, FeedTokens } from './feed.ts';
import type { MemberBase, MemberRun, SessionMember } from './members.ts';
import type { JobOutcome, JobProc } from '../os/procguard.ts';
import type { OwnedBrake } from './codex-session.ts';
import { treeNote } from './codex-session.ts';
import type { Redact } from './text.ts';
import { isWithin } from '../fs/paths.ts';
import { endHostNow, stopHostInOrder } from '../os/owned-proc.ts';
import { Feed } from './feed.ts';
import { guardedPlace } from './guarded.ts';
import { MEMBERS_STOP_REF, memberRun, memberTable } from './members.ts';
import { isClaudeModel } from './models.ts';
import { memberLive } from './registry.ts';
import { OWNED_TEXT_LIMITS, shown } from './text.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// One owned Claude session over the 0.2 host (alpha 0.2 design §2.2-§2.6; orchestra app step 4): node.exe
// runs hosts/claude/host.mjs through the spawn gate (rule claude-host), the host drives claude.exe through
// the Agent SDK, and the two talk JSON lines over stdio (design §2.3). This is the driver: the same
// approval queue, feed and session shape as the owned Codex sessions (codex-session.ts), so the routes and
// the tower treat both alike.
//
//   start:     the start frame (ownedId, model, cwd, the private config dir, claude.exe, the protected
//              roots, the approval timeout), then your first message as a user frame at once: the CLI
//              says system/init only once it reads one. init must come within CLAUDE_DEADLINES.initMs
//              of that, else the session fails as start-failed and the host is stopped.
//   a message: written as a user frame when no turn runs (its result ends the turn), else it waits here
//              (at most 5, design §2.5) and goes after the turn's result. A message never reaches the
//              SDK while a turn runs, so a stop can take back everything that waits.
//   stop:      every open approval of the session is declined first (perm frames), the waiting messages
//              are withdrawn, then the interrupt frame (design §2.5). An interrupt receipt that does not
//              say "nothing still queued" ends the session (the host is closed).
//   end:       open approvals declined, waiting messages withdrawn, then the host is stopped in the
//              design's order (src/os/owned-proc.ts): the close frame, stdin closed, a kill last. Started
//              inside a procguard Job (pipe.job), the host's close closes the Job, so claude.exe and what
//              it ran go too (r4 D4); once the host closed, the Job is checked through the resident
//              procguard and the feed says what was found (tree-ended, tree-left, tree-unsure). Without a
//              Job (procguard off), when the kill was needed the feed says claude.exe may remain
//              (note host-killed).
//   brake:     (a Job only) every process in the Job ended at once, the approvals declined, the session
//              ended as braked, then the host's handle goes, with no stop order (codex-session.ts). It
//              works as long as the host has not closed: also while an end or a failure walks the stop
//              order (up to 5 s; phase 4 review), when the order's remaining steps give way to it and the
//              session keeps the end reason it already had (the feed says braked).
//
// What the host says becomes feed events: text (a reply, in chunks of at most 2 KB), tool (a tool call
// by name; hidden while an approval about it is open, told again after the answer, as codex-session.ts
// does), auto-denied (the host refused it itself: protected, background, disallowed), the turn's end and
// its cost. What it asks becomes an approval in the shared queue; the answer goes back as one perm frame
// {reqId, allow, digest}, with the digest the host computed over the call (it computes it again before it
// runs anything). Never a rule for the rest of the session: the host passes no suggestions on (D8).
//
// Paths an ask names are judged by the spawn gate's own cwd table (PathJudge, as codex-session.ts does):
// a protected row is declined at once without a card; a place outside the work dir is a card of risk
// protected (held or typed, r4 §10.9).
//
// Sub-agents (measured on CLI 2.1.287, 2026-11-05; the list itself is members.ts, shared with codex-session.ts): a
// session whose tree runs in a Job may start them (the start frame's subagents; host-core.mjs SUBAGENT_TOOLS), and only
// then. They run inside claude.exe; every tool call of theirs comes to the host's hook and canUseTool with their agent
// id, so what they ask is a card here like the session's own, and it says which (from subagent: <name> (task …), inside
// what the digest covers). Starting one is a card too. The host passes on states only: what a sub-agent says stays out
// of the feed. A member is known from its sub-start, by task id (the agent id on its asks is the same); its name is the
// description the model gave it, its type the subagent_type, its times when Orchestra heard them. A report makes it
// returned, a failure or a stop ended (T2: nothing is ever done); a step that failed and that nobody refused is counted
// (member.failed). When the session goes, a member still live turns unknown (T1).
//
// The dispatch tool (src/route/dispatch.ts; measured on CLI 2.1.287, 2026-11-05): the host offers it as an in-process MCP
// server when the start frame says dispatch, and a call of the root comes here as a dispatch frame; the answer goes back as
// a dispatch-reply frame. A sub-agent's call is refused by the host (it holds the tool, measured). A stop takes back a card
// still waiting; the CLI cancels the call itself (dispatch-gone) and the turn ends.
//
// The front desk (src/route/front-desk.ts): a start frame with its system prompt makes the host hold it to its two tools, and
// its reads come here as status frames, answered like a dispatch at once. The feed keeps which read it was (a desk-read note, for
// the sources under an answer), never what it said. It has no sub-agents, whatever the session's Job.
//
// A dispatch: the root's Agent calls of one model reply (one message.id, which the host passes on as reply) are a batch;
// a sub-agent's own spawn (depth 2) has no row and no batch.
//
// A background sub-agent outlives the root's turn, its default (measured): the turn ends, the session stands idle, and
// when the sub-agent ends the CLI wakes the model into a turn nobody's message opened. It comes with no user frame, and
// anything of the root's says it began: text, a tool row, an ask or a refusal of the root's own (an Agent call has no tool
// row, so a reply that only dispatches the next one shows as its ask). Such a turn counts as running (wake), so messages
// wait and a stop reaches it. Until the first such frame the session stands idle: a message written then is not told from
// it, the first result ends both here, and the next message may then wait in the CLI, which a stop reads as still queued
// and closes the session.
//
// So a run is not over at its first result: a turn is owed (owed) from a sub-agent's end with no turn open until the next
// result. One that ended while a turn ran may have been told in that turn, or get a turn of its own right after (not
// measured), so after that turn's result the session waits CLAUDE_DEADLINES.wakeWaitMs for one. session.run tells a
// request (src/route/requests.ts) that, and whether a stop or the session's end cut the run short.
//
// A stop: the interrupt frame ends every sub-agent, in a turn or with the root idle, and the foreground commands they run
// (measured: the task stopped within 250 ms, its ping gone; no wake follows). What the shell of a running command started
// goes with it (measured once), but a process let go whose shell is gone has no task and no frame ever names it: it stays
// in the Job until the session ends or the brake (measured, --subagent-stop --loose). So a stop with a member in reach,
// listed or past the bound, sends it whether or not a turn runs, and what it did is read twice over. The
// CLI's frames say which members ended; the Job says whether a command's process is left, and only an empty one lets the
// feed say the commands are gone (T1). The frames come first (measured: the outer shells took 3.4 to 3.7 s to go), so the
// Job is read again every stopSettleMs up to stopJobMs. Sending says nothing: the feed says members-stopping (live), then
// members-stopped (ended, no command open, nothing of a command in the Job), members-job-left or members-job-unsure
// (ended, and the Job holds something or could not be read), and members-not-stopped (the rest, those of unknown state
// and those past the bound with no end heard); all but members-stopped keep the stop on offer, as a stop on its way does.

export const CLAUDE_SESSION_LIMITS = frozen({
  /** Messages waiting for the turn to end. */
  queue: 5,
  /** One host line (hosts/claude/host-core.mjs LINE_MAX_BYTES). */
  lineBytes: 64 * 1024,
  /** The tail of the host's stderr kept for the report of a failure. */
  stderrChars: 4096,
});

export const CLAUDE_DEADLINES = frozen({
  initMs: 120_000,
  /** How long after a stop what it did is read, and how often the Job is read again. */
  stopSettleMs: 2_000,
  /** How long a stop waits for the Job to hold no command's process (measured: 3.4 to 3.7 s). */
  stopJobMs: 6_000,
  /** How long after a result a turn of its own is awaited for a sub-agent that ended in that turn. */
  wakeWaitMs: 45_000,
});

/** What stays in a session's Job with no command running (measured 2026-11-05): the wrapper, the host and claude.exe, with their consoles. */
export const CLAUDE_JOB_RESIDENTS = frozen(['procguard.exe', 'node.exe', 'claude.exe', 'conhost.exe']);

/** How many of a Job's processes are a command's: all but the residents, the host being one node.exe of those there are. */
export function commandsOf(procs: readonly JobProc[]): number {
  const image = (p: JobProc) => (p.image ?? '').toLowerCase();
  const nodes = procs.filter((p) => image(p) === 'node.exe').length;
  return procs.filter((p) => !CLAUDE_JOB_RESIDENTS.includes(image(p))).length + Math.max(0, nodes - 1);
}

export type ClaudeSessionState = 'starting' | 'idle' | 'running' | 'ended' | 'failed' | 'unknown';
/**
 * you-ended: a person ended it; daemon-stop: orchestrad ended it on its way out; interrupt-unsure: an
 * interrupt left something queued in the CLI, so Orchestra ended it (design §2.5); protocol-error: the
 * host said something Orchestra cannot read, so Orchestra stopped it; exited: the host went away by
 * itself; start-failed, safety-stop, daemon-restart: shared/owned-contract.js.
 */
export type ClaudeEndReason = 'you-ended' | 'exited' | 'start-failed' | 'safety-stop' | 'daemon-restart' | 'interrupt-unsure' | 'protocol-error' | 'daemon-stop' | 'braked' | 'requester-withdrew';
export const isClaudeOver = (state: ClaudeSessionState): boolean => state === 'ended' || state === 'failed' || state === 'unknown';

export type ClaudeSessionOptions = {
  ownedId: string;
  /** The work dir, already made (ORCHESTRA_HOME\work\<ownedId>). */
  cwd: string;
  /** The private config dir, already made (ORCHESTRA_HOME\claude\<ownedId>): the host's CLAUDE_CONFIG_DIR for this session. */
  configDir: string;
  model: string;
  /** The SDK's claude.exe (src/owned/claude-site.ts). */
  claudeExe: string;
  /** Roots the host denies every tool call into (the data dir, the repository, the harness roots). */
  protectedRoots: readonly string[];
  /** orchestrad's approval timeout; the host's own backstop runs 60 s past it. */
  askTimeoutMs: number;
  /** Starts the host through the spawn gate (rule claude-host) in `cwd`; throws when the gate refuses. */
  launch(): HostPipe;
  approvals: Approvals;
  now(): number;
  redact: Redact;
  hub: ClockHub;
  onChange?: () => void;
  judge?: PathJudge;
  /**
   * r4 §8.5 来源追踪: the session's turns come from an unbound sender (a seat request: a DSH session asked, a
   * person only dispatched it), so the host's canUseTool asks for everything, Read, Glob and Grep in cwd
   * too (host-core.mjs judge). Absent: false, as before (a person's own sentence).
   */
  tainted?: boolean;
  /** r4 §8.5: where its turns came from (a seat request), shown at the top of its cards; display only. */
  origin?: ApprovalOrigin | null;
  /** Offers the session the dispatch tool, and takes its calls; absent: no such tool, the start frame as before. */
  dispatch?: DispatchPort;
  /** Makes it the front desk: its system prompt, and the read its status tool calls. Needs `dispatch`. */
  frontDesk?: { system: string; port: StatusPort };
};

export type ClaudeSendResult = { ok: true; via: 'turn/start' | 'queued' } | { ok: false; reason: 'ended' | 'queue-full' };

export type ClaudeSession = {
  readonly ownedId: string;
  readonly harness: 'claude';
  readonly model: string;
  readonly cwd: string;
  readonly state: ClaudeSessionState;
  readonly endReason: ClaudeEndReason | null;
  readonly sessionId: string | null;
  /** r4 §8.5: its turns come from an unbound sender, as the start frame said. */
  readonly tainted: boolean;
  /** The host reports cost, not tokens: always null (T1: not a 0). */
  readonly tokens: FeedTokens | null;
  /** The cost the last result reported (USD), or null before any. */
  readonly costUsd: number | null;
  /** The tools system/init listed, as it passed the host's check; null before init. */
  readonly tools: readonly string[] | null;
  readonly queued: number;
  /** Its sub-agents, in the order they were first heard of. */
  readonly members: readonly SessionMember[];
  /** Sub-agents past the bound, counted and not listed. */
  readonly membersOver: number;
  /** Moves whenever what the registry keeps of the members changes. */
  readonly membersRev: number;
  /** A stop has a member to reach: one live, past the bound with no end heard, or over with a command still open or its last stop unconfirmed. */
  readonly stoppable: boolean;
  /** Where its sub-agents leave the run a request waits on. */
  readonly run: MemberRun;
  readonly feed: Feed;
  /** Settles true once init passed, false when the session ended or failed before that. */
  readonly ready: Promise<boolean>;
  /** Settles once the host process closed (at once for a session an earlier orchestrad left: nothing of it runs here). */
  readonly exited: Promise<void>;
  send(text: string, uuid: string): ClaudeSendResult;
  interrupt(): Promise<{ withdrawn: number; denied: number }>;
  /** Ends the session: a person's end (you-ended), orchestrad stopping (daemon-stop) or its requester withdrawing (requester-withdrew, seat), one stop order. */
  end(why?: 'you-ended' | 'daemon-stop' | 'requester-withdrew'): { denied: number };
  /** Whether its host's whole tree runs in a Job of its own and the host has not closed (so the brake can still end it, even while it is ending). */
  readonly jobbed: boolean;
  /** The brake: the whole tree stopped now, the approvals declined, the session ended as braked. */
  brake(): Promise<OwnedBrake>;
  /** closed: the host process closed (or none of it runs here). */
  stats(): { stderrTail: string; failure: string | null; exit: { reason: string; detail: string | null } | null; closed: boolean };
};

export type ClaudeStartResult = { ok: true; session: ClaudeSession } | { ok: false; reason: 'model-refused' | 'spawn-refused'; detail: string };

type Member = MemberBase & {
  /** Its foreground commands that have not ended. */
  commands: Set<string>;
  /** The last stop did not see it end with no command open. */
  stopLeft: boolean;
};

/** Something of its may still run, whatever its state says. */
const memberBusy = (m: Member) => m.state === 'running' || m.commands.size > 0 || m.stopLeft;
/** A stop has something to send it. */
const stopReaches = (m: Member) => m.state !== 'unknown' && (memberLive(m) || memberBusy(m));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const REQ_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL_ID_MAX = 256;
const SHELLS = ['Bash', 'PowerShell'];
const WRITES = ['Write', 'Edit'];

/** The approval kind and the feed's tool state of a core tool. */
const kindOf = (tool: string): ApprovalKind => (SHELLS.includes(tool) ? 'command' : WRITES.includes(tool) ? 'file-change' : 'tool');
const toolState = (tool: string): string => (SHELLS.includes(tool) ? 'command' : WRITES.includes(tool) ? 'file-change' : 'tool');

/** The turn's end as the feed names it, by the result's subtype. */
const TURN_END: Readonly<Record<string, string>> = { success: 'turn-ended', error_max_turns: 'turn-max-turns', error_during_execution: 'turn-failed' };

/** How the session ended, by the host's exit reason (hosts/claude/host-core.mjs finish). */
function endOf(reason: string): ClaudeEndReason {
  if (reason === 'safety-stop') return 'safety-stop';
  if (reason === 'bad-start' || reason === 'sdk-missing') return 'start-failed';
  return 'exited';
}

/** Starts an owned Claude session; the host is running when this returns ok, the session starting. */
export function startClaudeSession(opts: ClaudeSessionOptions, first: { text: string; uuid: string } | null = null): ClaudeStartResult {
  // A session a seat request started is tainted even if the caller left tainted out (r4 §8.5): its host and its
  // cards agree, and the owned contract (such an origin only on a tainted entry) never fails the whole list over it.
  // A worker's dispatch is no unbound sender: its session is tainted only when the caller says so (that worker is).
  if (opts.origin?.kind === 'agent-request' && opts.tainted !== true) opts = { ...opts, tainted: true };
  if (!isClaudeModel(opts.model)) return { ok: false, reason: 'model-refused', detail: String(opts.model) };
  let pipe: HostPipe;
  try {
    pipe = opts.launch();
  } catch (e) {
    const decision = (e as { decision?: { reason?: unknown; detail?: unknown } }).decision;
    return { ok: false, reason: 'spawn-refused', detail: decision === undefined ? errText(e) : `${String(decision.reason)}${decision.detail === undefined ? '' : `: ${String(decision.detail)}`}` };
  }
  return { ok: true, session: run(opts, pipe, first) };
}

function run(opts: ClaudeSessionOptions, pipe: HostPipe, first: { text: string; uuid: string } | null): ClaudeSession {
  const { ownedId, cwd, model, approvals, redact } = opts;
  const L = CLAUDE_SESSION_LIMITS;
  const FEED = OWNED_TEXT_LIMITS.feedBytes;
  const feed = new Feed(opts.now);

  let state: ClaudeSessionState = 'starting';
  let endReason: ClaudeEndReason | null = null;
  let failure: string | null = null;
  let exitFrame: { reason: string; detail: string | null } | null = null;
  let sessionId: string | null = null;
  let costUsd: number | null = null;
  let tools: readonly string[] | null = null;
  /** A user frame went to the host and its result has not come. */
  let turn = false;
  /** A turn nobody's message opened runs (see the header). */
  let wake = false;
  /** A stop went to a turn: its result says so. */
  let cutOff = false;
  /** A turn nobody's message opened is due or under way (see the header); the next result settles it. */
  let owed = false;
  let cancelOwed: () => void = () => {};
  /** A sub-agent ended while a turn ran: the result may be followed by a turn about it. */
  let endedInTurn = false;
  let closed = false;
  let stderrTail = '';
  const queue: { text: string; uuid: string }[] = [];
  /** Messages written to the host whose receipt it has not confirmed yet (a lifecycle frame of the uuid, or the turn's result). */
  const written = new Set<string>();
  /** reqId -> the approval it waits on. */
  const asked = new Map<string, string>();
  /** A tool call's announcement: hidden while an approval about it is open. */
  const toolEvents = new Map<string, { seq: number; input: FeedInput; hidden: boolean }>();
  /** approvalId -> the tool call it decides. */
  const askTool = new Map<string, string>();
  /** approvalId -> the sub-agent that asked, while it is open. */
  const askMember = new Map<string, Member>();
  /** Dispatch tool calls waiting for their answer, by callId: each one's way to take a card still waiting back. */
  const calls = new Map<string, () => void>();
  const dropCalls = () => {
    for (const giveUp of [...calls.values()]) giveUp();
  };
  /** A sub-agent's approval left the queue, however it did. */
  const settled = (approvalId: string) => {
    const m = askMember.get(approvalId);
    if (m === undefined) return;
    askMember.delete(approvalId);
    m.asks = m.asks.filter((a) => a !== approvalId);
  };

  let settleReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((r) => {
    settleReady = r;
  });
  let settleExited!: () => void;
  const exited = new Promise<void>((r) => {
    settleExited = r;
  });

  // --- timers (the init deadline, the stop order) on the Clock -----------------------------------------
  const fns = new Map<string, () => void>();
  let timerSeq = 0;
  const clock = opts.hub.port((f: Fired) => {
    const fn = fns.get(f.timerId);
    fns.delete(f.timerId);
    fn?.();
  });
  const after: After = (ms, fn) => {
    const timerId = `deadline:claude-${ownedId}:${timerSeq++}`;
    fns.set(timerId, fn);
    clock.schedule({ timerId, class: 'deadline', clock: 'mono', due: clock.nowMono() + ms });
    return () => {
      if (!fns.delete(timerId)) return;
      clock.cancel(timerId);
    };
  };
  let cancelInit: () => void = () => {};
  let cancelStop: () => void = () => {};

  const changed = () => {
    try {
      opts.onChange?.();
    } catch {
      // A listener's failure is its own.
    }
  };
  const terminal = () => state === 'ended' || state === 'failed';
  const shownFeed = (raw: string, keep: 'head' | 'tail') => shown(redact, raw, FEED, keep);
  const note = (stateName: string, text: string | null = null) => {
    const s = text === null ? null : shownFeed(text, 'head');
    feed.push({ kind: 'note', ref: null, text: s?.text ?? null, state: stateName, redactions: s?.redactions ?? 0 });
  };
  // msg-queued: waiting here; msg-written: written to the host, its receipt not confirmed yet; msg-sent:
  // the host confirmed it (a lifecycle frame of its uuid, or the turn's result); msg-unsure: written, and
  // the session ended or the host went away before it confirmed anything (T1: never "sent" unconfirmed).
  const fate = (uuid: string, stateName: 'msg-queued' | 'msg-written' | 'msg-sent' | 'msg-not-sent' | 'msg-withdrawn' | 'msg-unsure', text: string | null = null) => {
    if (uuid === '') return;
    if (stateName !== 'msg-written') written.delete(uuid);
    const ev = { kind: 'note' as const, ref: uuid, text, state: stateName };
    if (stateName === 'msg-queued' || stateName === 'msg-written') {
      feed.upsert(`msg:${uuid}`, ev);
    } else {
      feed.settle(`msg:${uuid}`);
      feed.push(ev);
    }
  };
  const withdrawAll = (): number => {
    const lost = queue.splice(0, queue.length);
    for (const m of lost) fate(m.uuid, 'msg-withdrawn');
    if (lost.length > 0) note('withdrawn', `${lost.length}`);
    return lost.length;
  };
  /** What was written and never confirmed: its fate is unknown now. */
  const unsureAll = () => {
    for (const uuid of [...written]) fate(uuid, 'msg-unsure', 'the host did not confirm it before the session ended');
  };
  /** The turn's result: the host took every message written so far (one user frame per turn). */
  const confirmAll = () => {
    for (const uuid of [...written]) fate(uuid, 'msg-sent');
  };
  const table = memberTable<Member>({
    ownedId, feed, redact, idWord: 'task', note,
    extra: () => ({ commands: new Set<string>(), stopLeft: false }),
  });
  /** A stop's final word on the sub-agents: it replaces the live note, and a page keeps that until one of its ref comes. */
  const stopSaid = (stateName: string, text: string | null) => {
    feed.settle(MEMBERS_STOP_REF);
    feed.push({ kind: 'note', ref: MEMBERS_STOP_REF, text, state: stateName });
  };
  /** Of those past the bound, the ones whose end was heard. */
  const overEnded = new Set<string>();
  /** Those past the bound with no end heard: listed nowhere, and a stop reaches them all the same. */
  const overOut = () => table.over.size - overEnded.size;
  /** The members a stop waits to hear of, until it reads what came back; `overs` of those past the bound, `reads` of the Job so far. */
  let stopping: { reached: Member[]; busy: Member[]; overs: number; reads: number } | null = null;
  let cancelStopRead: () => void = () => {};
  /** The session is gone: nobody can hear a member again, so one still live is unknown, never running (T1). */
  const loseMembers = () => {
    cancelStopRead();
    cancelOwed();
    if (stopping !== null) stopSaid('members-stop-unanswered', `${stopping.busy.length + stopping.overs}`);
    stopping = null;
    table.lose();
    dropCalls();
  };
  const hideTool = (id: string | null) => {
    const t = id === null ? undefined : toolEvents.get(id);
    if (t === undefined || t.hidden) return;
    feed.withdraw(t.seq);
    t.hidden = true;
  };
  const showTool = (id: string | null) => {
    const t = id === null ? undefined : toolEvents.get(id);
    if (t === undefined || !t.hidden) return;
    t.seq = feed.push(t.input).seq;
    t.hidden = false;
  };
  const showAllTools = () => {
    for (const id of toolEvents.keys()) showTool(id);
  };

  const write = (frame: Obj) => {
    try {
      pipe.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // A host gone already: its close ends the session.
    }
  };

  // --- ending ----------------------------------------------------------------------------------------

  /** The Job the host's tree runs in (null: procguard off). */
  const job = pipe.job ?? null;
  /** The brake took the tree: the check after the close is its own, not repeated. */
  let braked = false;
  const noteTree = (o: JobOutcome) => {
    const n = treeNote(o);
    note(n.state, n.text);
    changed();
  };

  const stopHost = () => {
    cancelInit();
    cancelStop = stopHostInOrder(pipe, {
      closeFrame: `${JSON.stringify({ t: 'close' })}\n`,
      after,
      closed: () => closed,
      killed: () => {
        // In a Job the kill took the whole tree, and the check after the close says so.
        if (job !== null) return;
        note('host-killed');
        changed();
      },
    });
  };

  const fail = (reason: ClaudeEndReason, detail: string) => {
    if (terminal()) return;
    approvals.declineOwned(ownedId, 'end');
    state = 'failed';
    endReason = reason;
    failure = detail;
    turn = false;
    wake = false;
    loseMembers();
    withdrawAll();
    unsureAll();
    showAllTools();
    feed.push({ kind: 'lifecycle', ref: null, text: shownFeed(detail, 'head').text, state: reason });
    stopHost();
    settleReady(false);
    changed();
  };

  pipe.onClose((code, signal) => {
    closed = true;
    cancelStop();
    cancelInit();
    settleExited();
    // However the host closed, its Job is checked once it did (codex-session.ts does the same).
    if (job !== null && !braked) void job.endTree().then(noteTree);
    // Nobody can answer what the host asked any more, however the session ended: a card an ask frame
    // brought in while it was ending would otherwise wait on a host that is gone.
    approvals.forgetOwned(ownedId);
    asked.clear();
    askTool.clear();
    loseMembers();
    if (terminal()) {
      changed();
      return;
    }
    showAllTools();
    const why = exitFrame !== null ? `${exitFrame.reason}${exitFrame.detail === null ? '' : `: ${exitFrame.detail}`}` : code !== null ? `exit code ${code}` : `signal ${String(signal)}`;
    state = 'failed';
    endReason = exitFrame === null ? 'exited' : endOf(exitFrame.reason);
    failure = why;
    turn = false;
    wake = false;
    feed.push({ kind: 'lifecycle', ref: null, text: shownFeed(why, 'head').text, state: endReason });
    withdrawAll();
    unsureAll();
    settleReady(false);
    changed();
  });
  pipe.onError(() => {
    // The close that follows ends the session; a write to a dead stdin lands here too.
  });
  pipe.onStderr((chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-L.stderrChars);
  });

  // --- messages --------------------------------------------------------------------------------------

  const sendNow = (m: { text: string; uuid: string }) => {
    turn = true;
    if (state === 'idle') state = 'running';
    write({ t: 'user', uuid: m.uuid, text: m.text });
    if (m.uuid !== '') written.add(m.uuid);
    fate(m.uuid, 'msg-written');
  };
  const pump = () => {
    if (terminal() || turn || wake || queue.length === 0) return;
    sendNow(queue.shift()!);
    changed();
  };

  // --- what the host says ----------------------------------------------------------------------------

  /** A dispatch tool call: orchestrad decides; the answer may be a person's, minutes away. */
  const onDispatch = (f: Obj) => {
    const id = str(f.callId);
    if (id === null || !/^[0-9a-f]{32}$/.test(id)) return;
    const port = opts.dispatch;
    if (port === undefined || terminal()) {
      write({ t: 'dispatch-reply', callId: id, ok: false, text: 'This tool is not available here.' });
      return;
    }
    woke();
    const call = port.call(ownedId, f.input, (n) => {
      if (terminal()) return;
      const s = n.text === null ? null : shownFeed(n.text, 'head');
      feed.push({ kind: 'note', ref: n.ref, text: s?.text ?? null, state: n.state, redactions: s?.redactions ?? 0 });
      changed();
    });
    calls.set(id, () => {
      calls.delete(id);
      call.cancel();
    });
    void call.reply.then((r) => {
      calls.delete(id);
      write({ t: 'dispatch-reply', callId: id, ok: r.ok, text: r.text });
      changed();
    });
  };

  /** A front desk's read: answered at once, its text never in the feed. */
  const onStatus = (f: Obj) => {
    const id = str(f.callId);
    if (id === null || !/^[0-9a-f]{32}$/.test(id)) return;
    const desk = opts.frontDesk;
    if (desk === undefined || terminal()) {
      write({ t: 'dispatch-reply', callId: id, ok: false, text: 'This tool is not available here.' });
      return;
    }
    woke();
    const r = desk.port.status(f.input);
    feed.push({ kind: 'note', ref: r.ref, text: r.source, state: 'desk-read' });
    write({ t: 'dispatch-reply', callId: id, ok: r.ok, text: r.text });
  };

  /** The root speaks with no message of ours in flight: the CLI woke it. */
  const woke = () => {
    if (turn || wake || state !== 'idle') return;
    cancelOwed();
    wake = true;
    owed = true;
    state = 'running';
  };
  /** A sub-agent ended by itself: the CLI tells the model (a stop's end wakes nothing, measured). */
  const memberOver = (status: unknown) => {
    if ((status !== 'completed' && status !== 'failed') || stopping !== null) return;
    if (turn || wake) {
      endedInTurn = true;
    } else {
      cancelOwed();
      owed = true;
    }
  };
  /** The member a gate frame names; `via` is how a card says which, null for the session's own call. */
  const askerOf = (f: Obj): { member: Member | null; via: string | null } => {
    const tid = str(f.agentId);
    if (tid === null || tid.length > TOOL_ID_MAX) return { member: null, via: null };
    const member = table.of(tid);
    if (member !== null) member.lastAt = opts.now();
    return { member, via: table.label(member, tid) };
  };
  /** A call as the feed tells it: a sub-agent's under its name, so what it asked is never taken for the session's. */
  const told = (via: string | null, title: string) => (via === null ? title : `${via}: ${title}`);

  /** What the host says of a sub-agent: its state, never its words. */
  const onMember = (f: Obj) => {
    const tid = str(f.taskId);
    if (tid === null || tid.length > TOOL_ID_MAX) return;
    const now = opts.now();
    const m = f.t === 'sub-start' ? table.of(tid) : (table.all.get(tid) ?? null);
    if (f.t === 'sub-end') memberOver(f.status);
    if (m === null) {
      if (f.t === 'sub-end' && table.over.has(tid)) overEnded.add(tid);
      return;
    }
    m.lastAt = now;
    switch (f.t) {
      case 'sub-start':
        table.name(m, str(f.name));
        table.type(m, str(f.type));
        table.started(m, now);
        table.runs(m);
        // A sub-agent's own spawn is not the root's act.
        if (f.depth === 1) table.dispatched(m, str(f.reply));
        return;
      case 'sub-model':
        table.model(m, str(f.model));
        return;
      case 'sub-failed':
        // What a stop cut short is no step of its that failed.
        if (m.state === 'running' && stopping === null) {
          m.failed++;
          table.bump();
        }
        return;
      case 'sub-cmd': {
        const cmd = str(f.id);
        if (cmd === null) return;
        if (f.open === true) m.commands.add(cmd);
        else m.commands.delete(cmd);
        return;
      }
      case 'sub-end':
        if (f.status === 'completed') table.returned(m, now);
        else if (f.status === 'failed') table.ended(m, 'failed', now);
        else if (f.status === 'stopped') table.ended(m, 'interrupted', now);
        else table.move(m, 'unknown');
        return;
      default:
    }
  };

  /** How many of the Job's processes are a command's; null when the Job could not be read. */
  const commandsInJob = async (): Promise<number | null> => {
    const procs = job === null ? [] : await job.procs();
    return procs === null ? null : commandsOf(procs);
  };
  /** What a stop did, read from what came back and from the Job. */
  const readStop = async () => {
    const was = stopping;
    if (was === null) return;
    was.reads++;
    const inJob = await commandsInJob();
    // The session went while the Job was read: what it said at its end stands.
    if (stopping !== was) return;
    if (inJob !== null && inJob > 0 && was.reads * CLAUDE_DEADLINES.stopSettleMs < CLAUDE_DEADLINES.stopJobMs) {
      cancelStopRead = after(CLAUDE_DEADLINES.stopSettleMs, () => void readStop());
      return;
    }
    stopping = null;
    const left = was.reached.filter((m) => m.state === 'running' || m.state === 'unknown' || m.commands.size > 0);
    for (const m of was.reached) m.stopLeft = left.includes(m) || (inJob !== 0 && was.busy.includes(m));
    const stopped = was.busy.filter((m) => !left.includes(m)).length + Math.max(0, was.overs - overOut());
    // Of one in an unknown state, or past the bound with no end heard, nothing is known (T1).
    const unsure = [...table.all.values()].filter((m) => m.state === 'unknown' && !was.reached.includes(m)).length + overOut();
    if (stopped > 0) {
      if (inJob === 0) stopSaid('members-stopped', `${stopped}`);
      else if (inJob === null) stopSaid('members-job-unsure', `${stopped}`);
      else stopSaid('members-job-left', `${inJob}`);
    }
    if (left.length + unsure > 0) stopSaid('members-not-stopped', `${left.length + unsure}`);
    changed();
  };

  /** The card of an ask frame, or the reason it is declined without one. */
  const askOf = (f: Obj, via: string | null) => {
    const toolName = str(f.toolName) ?? '';
    const paths = Array.isArray(f.paths) ? f.paths.filter((p): p is string => typeof p === 'string') : [];
    const placed = paths.map((p) => {
      let j: { real: string | null; hit: string | null };
      try {
        j = opts.judge === undefined ? { real: p, hit: null } : opts.judge(p);
      } catch (e) {
        j = { real: null, hit: `unresolved: ${errText(e)}` };
      }
      const real = j.real ?? p;
      return { p, real, hit: j.hit, outside: !isWithin(p, cwd) || !isWithin(real, realCwd) };
    });
    const hit = placed.find((x) => x.hit !== null)?.hit ?? null;
    const away = placed.filter((x) => x.outside);
    const hostRisk = str(f.risk);
    // r4 §7.4: a change to a file other programs run or read as configuration (.git/hooks, .claude, package.json ...) is no ordinary write.
    const guarded = hostRisk === 'read' ? [] : [...new Set(placed.map((x) => guardedPlace(x, cwd, realCwd)).filter((g): g is string => g !== null))];
    // A read that asks: outside cwd (it asks nobody inside, unless the session is tainted, r4 §8.5). A tainted
    // session's read of a named place inside cwd is an ordinary card; one that names no place stays protected.
    const readInside = hostRisk === 'read' && opts.tainted === true && placed.length > 0 && away.length === 0 && f.unplaced !== true;
    const risk: ApprovalRisk = away.length > 0 || f.unplaced === true || guarded.length > 0 || (hostRisk === 'read' && !readInside) ? 'protected'
      : hostRisk === 'shell' ? 'shell' : hostRisk === 'write' ? 'write' : hostRisk === 'net' ? 'net' : 'other';
    const lines = [
      ...(via === null ? [] : [`from subagent: ${via}`]),
      `tool: ${toolName}`,
      ...(guarded.length > 0 ? [`changes a protected path in the work dir (r4 §7.4, run by other programs outside this session): ${guarded.join(', ')}`] : []),
      ...away.map((x) => `outside the work dir: ${x.p}`),
      ...(f.unplaced === true ? ['reaches a place Orchestra could not name'] : []),
      '',
      str(f.preview) ?? '',
    ];
    // A shell's command line as the host gave it; for the rest the first place, relative inside the work dir.
    const where = (p: string) => (isWithin(p, cwd) ? win.relative(cwd, p) || '.' : p);
    const subject = SHELLS.includes(toolName) ? (str(f.subject) ?? '') : paths[0] === undefined ? '' : where(paths[0]);
    const title = `${toolName}${subject === '' ? '' : ` · ${subject}`}`;
    return { toolName, title, preview: lines.join('\n'), risk, hit, tooLong: f.tooLong === true };
  };

  const onAsk = (f: Obj) => {
    const reqId = str(f.reqId);
    const digest = str(f.digest);
    const toolUseId = str(f.toolUseId);
    if (reqId === null || !REQ_ID.test(reqId) || digest === null || !DIGEST.test(digest) || toolUseId === null || toolUseId.length > TOOL_ID_MAX || typeof f.preview !== 'string') {
      fail('protocol-error', 'the host sent an ask frame Orchestra cannot read');
      return;
    }
    const perm = (allow: boolean) => write({ t: 'perm', reqId, allow, digest });
    const { member, via } = terminal() ? { member: null, via: null } : askerOf(f);
    // A session that is ending answers what still arrives with the refusal, no card (as codex-session.ts does).
    if (terminal()) {
      perm(false);
      const s = shownFeed(str(f.toolName) ?? '', 'head');
      feed.push({ kind: 'auto-denied', ref: toolUseId, text: s.text, state: 'ending', redactions: s.redactions });
      changed();
      return;
    }
    // The root's own call: with no tool row for an Agent call, this may be the first a woken turn says.
    if (via === null) woke();
    const a = askOf(f, via);
    if (a.hit !== null) {
      // A protected row of the spawn gate's table: declined at once, no card (D8 forbids only automatic allows).
      perm(false);
      const s = shownFeed(told(via, `${a.title} (${a.hit})`), 'head');
      feed.push({ kind: 'auto-denied', ref: toolUseId, text: s.text, state: 'protected', redactions: s.redactions });
      changed();
      return;
    }
    const t = shown(redact, a.title, 400, 'head');
    const p = shown(redact, a.preview, Number.MAX_SAFE_INTEGER, 'head');
    let approvalId = '';
    const view = approvals.add({
      ownedId, kind: kindOf(a.toolName), title: t.text, preview: p.text, redactions: t.redactions + p.redactions + (typeof f.redactions === 'number' ? f.redactions : 0),
      risk: a.risk, canAccept: !a.tooLong, canText: false, tainted: opts.tainted === true, origin: opts.origin ?? null,
      answer: (ans: Answer, cause: AnswerCause) => {
        asked.delete(reqId);
        settled(approvalId);
        perm(ans.decision === 'accept');
        feed.push({ kind: cause === 'human' ? 'answer' : 'auto-denied', ref: approvalId, text: null, state: cause === 'human' ? ans.decision : cause });
        askTool.delete(approvalId);
        showTool(toolUseId);
        changed();
      },
    });
    approvalId = view.approvalId;
    asked.set(reqId, approvalId);
    askTool.set(approvalId, toolUseId);
    if (member !== null) {
      member.asks.push(approvalId);
      askMember.set(approvalId, member);
      table.runs(member);
    }
    hideTool(toolUseId);
    feed.push({ kind: 'ask', ref: approvalId, text: shownFeed(told(via, a.title), 'head').text, state: kindOf(a.toolName) });
    changed();
  };

  const onFrame = (f: Obj) => {
    switch (f.t) {
      case 'init': {
        const sid = str(f.sessionId);
        if (sid === null || !UUID.test(sid)) return;
        const fresh = sessionId === null;
        sessionId = sid;
        if (!fresh) return;
        tools = Array.isArray(f.tools) ? Object.freeze(f.tools.filter((x): x is string => typeof x === 'string')) : null;
        cancelInit();
        if (state === 'starting') state = turn ? 'running' : 'idle';
        feed.push({ kind: 'lifecycle', ref: sid, text: model, state: 'started' });
        settleReady(true);
        pump();
        return;
      }
      case 'lifecycle': {
        const uuid = str(f.uuid);
        if (uuid === null) return;
        if (f.state === 'refused') fate(uuid, 'msg-not-sent', 'refused by the host');
        else if (f.state === 'cancelled') fate(uuid, 'msg-withdrawn');
        else if (written.has(uuid)) fate(uuid, 'msg-sent');
        return;
      }
      case 'text': {
        const chunk = str(f.chunk);
        if (chunk === null) return;
        woke();
        const s = shownFeed(chunk, 'head');
        feed.push({ kind: 'text', ref: str(f.uuid), text: s.text, state: 'final', redactions: s.redactions });
        return;
      }
      case 'tool': {
        const id = str(f.toolUseId);
        const name = str(f.name);
        if (id === null || name === null || id.length > TOOL_ID_MAX) return;
        woke();
        const s = shownFeed(name, 'head');
        const input: FeedInput = { kind: 'tool', ref: id, text: s.text, state: toolState(name), redactions: s.redactions };
        toolEvents.set(id, { seq: feed.push(input).seq, input, hidden: false });
        return;
      }
      case 'ask':
        onAsk(f);
        return;
      case 'ask-gone': {
        const reqId = str(f.reqId);
        const approvalId = reqId === null ? undefined : asked.get(reqId);
        if (approvalId === undefined) return;
        asked.delete(reqId!);
        if (approvals.forget(approvalId)) feed.push({ kind: 'note', ref: approvalId, text: null, state: 'ask-withdrawn' });
        settled(approvalId);
        showTool(askTool.get(approvalId) ?? null);
        askTool.delete(approvalId);
        return;
      }
      case 'denied-auto': {
        const { via } = askerOf(f);
        if (via === null) woke();
        const s = shownFeed(told(via, str(f.name) ?? ''), 'head');
        const why = str(f.why);
        feed.push({ kind: 'auto-denied', ref: str(f.toolUseId), text: s.text, state: why !== null && /^[a-z-]{1,32}$/.test(why) ? why : 'host', redactions: s.redactions });
        return;
      }
      case 'dispatch':
        onDispatch(f);
        return;
      case 'status':
        onStatus(f);
        return;
      case 'dispatch-gone': {
        const id = str(f.callId);
        if (id !== null) calls.get(id)?.();
        return;
      }
      case 'interrupted': {
        note('interrupted');
        // Something the CLI still holds would run after the stop (design §2.5): the session is closed.
        if (f.stillQueued !== 0) {
          note('interrupt-unsure', f.stillQueued === null ? null : String(f.stillQueued));
          endSession('end', 'interrupt-unsure');
        }
        return;
      }
      case 'sub-start':
      case 'sub-model':
      case 'sub-progress':
      case 'sub-failed':
      case 'sub-cmd':
      case 'sub-end':
        onMember(f);
        return;
      case 'result': {
        turn = false;
        wake = false;
        cancelOwed();
        owed = endedInTurn;
        if (endedInTurn) {
          cancelOwed = after(CLAUDE_DEADLINES.wakeWaitMs, () => {
            owed = false;
          });
        }
        endedInTurn = false;
        confirmAll();
        if (state === 'running') state = 'idle';
        const sub = str(f.subtype) ?? '';
        // The CLI calls the turn a stop cut off an error (measured): it is your stop, not a failure.
        const ended = cutOff && sub === 'error_during_execution' ? 'turn-interrupted' : TURN_END[sub] ?? 'turn-unknown';
        cutOff = false;
        feed.push({ kind: 'lifecycle', ref: str(f.uuid), text: null, state: ended });
        if (typeof f.costUsd === 'number' && Number.isFinite(f.costUsd) && f.costUsd >= 0) {
          costUsd = f.costUsd;
          feed.upsert('cost', { kind: 'note', ref: null, text: `$${f.costUsd.toFixed(4)}`, state: 'cost' });
        }
        showAllTools();
        toolEvents.clear();
        pump();
        return;
      }
      case 'exit': {
        exitFrame = { reason: str(f.reason) ?? 'unknown', detail: str(f.detail) };
        return;
      }
      default:
        return;
    }
  };

  // --- stdout lines ----------------------------------------------------------------------------------
  // Once the session ended or failed only two frames still count: exit (why the host left) and ask
  // (answered with the refusal, onAsk); the rest is dropped, and a line past the bound is skipped up to
  // its newline instead of growing the buffer until the host is stopped.
  let buf = Buffer.alloc(0);
  let skipping = false;
  pipe.onStdout((chunk) => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      if (line.trim() === '') continue;
      let f: unknown;
      try {
        f = JSON.parse(line);
      } catch {
        fail('protocol-error', 'the host wrote a line that is not JSON');
        continue;
      }
      if (!isObj(f) || typeof f.t !== 'string') continue;
      if (terminal() && f.t !== 'exit' && f.t !== 'ask') continue;
      onFrame(f);
      changed();
    }
    if (buf.length > L.lineBytes) {
      buf = Buffer.alloc(0);
      skipping = true;
      fail('protocol-error', 'the host wrote a line over 64 KiB');
    }
  });

  /** The work dir's own realpath, for the place of what lies below it. */
  const realCwd = (() => {
    try {
      return opts.judge?.(cwd).real ?? cwd;
    } catch {
      return cwd;
    }
  })();

  // --- start -----------------------------------------------------------------------------------------
  write({
    t: 'start', ownedId, model, cwd, configDir: opts.configDir, tainted: opts.tainted === true, claudeExe: opts.claudeExe,
    protectedRoots: [...opts.protectedRoots], askTimeoutMs: opts.askTimeoutMs, subagents: job !== null && opts.frontDesk === undefined, ...(opts.dispatch === undefined ? {} : { dispatch: true }),
    ...(opts.frontDesk === undefined ? {} : { frontDesk: opts.frontDesk.system }),
  });
  if (first !== null) {
    const s = shownFeed(first.text, 'head');
    feed.push({ kind: 'you', ref: null, uuid: first.uuid, text: s.text, state: s.cut ? 'cut' : null, redactions: s.redactions });
    sendNow(first);
    cancelInit = after(CLAUDE_DEADLINES.initMs, () => {
      if (sessionId === null) fail('start-failed', `no init from the host within ${CLAUDE_DEADLINES.initMs / 1000} s`);
    });
  }

  function endSession(cause: 'end', why: 'you-ended' | 'daemon-stop' | 'interrupt-unsure' | 'requester-withdrew' = 'you-ended'): { denied: number } {
    if (terminal()) return { denied: 0 };
    const denied = approvals.declineOwned(ownedId, cause);
    state = 'ended';
    endReason = why;
    turn = false;
    wake = false;
    loseMembers();
    withdrawAll();
    unsureAll();
    showAllTools();
    feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'ended' });
    stopHost();
    settleReady(false);
    changed();
    return { denied };
  }

  const session: ClaudeSession = {
    ownedId,
    harness: 'claude',
    model,
    cwd,
    get state() {
      return state;
    },
    get endReason() {
      return endReason;
    },
    get sessionId() {
      return sessionId;
    },
    tainted: opts.tainted === true,
    tokens: null,
    get costUsd() {
      return costUsd;
    },
    get tools() {
      return tools;
    },
    get queued() {
      return queue.length;
    },
    get members() {
      return table.list();
    },
    get membersOver() {
      return table.over.size;
    },
    get membersRev() {
      return table.rev;
    },
    get stoppable() {
      return !terminal() && (overOut() > 0 || [...table.all.values()].some(stopReaches));
    },
    get run() {
      return memberRun(table.all.values(), owed || overOut() > 0, terminal());
    },
    feed,
    ready,
    exited,
    send(text: string, uuid: string): ClaudeSendResult {
      if (terminal()) return { ok: false, reason: 'ended' };
      const now = !turn && !wake && queue.length === 0;
      if (!now && queue.length >= L.queue) return { ok: false, reason: 'queue-full' };
      const s = shownFeed(text, 'head');
      feed.push({ kind: 'you', ref: null, uuid, text: s.text, state: s.cut ? 'cut' : null, redactions: s.redactions });
      if (now) {
        sendNow({ text, uuid });
        if (sessionId === null) {
          cancelInit();
          cancelInit = after(CLAUDE_DEADLINES.initMs, () => {
            if (sessionId === null) fail('start-failed', `no init from the host within ${CLAUDE_DEADLINES.initMs / 1000} s`);
          });
        }
      } else {
        queue.push({ text, uuid });
        fate(uuid, 'msg-queued');
      }
      changed();
      return { ok: true, via: now ? 'turn/start' : 'queued' };
    },
    async interrupt() {
      if (terminal()) return { withdrawn: 0, denied: 0 };
      // Design §2.5: the approvals first, then the waiting messages, then the turn.
      const denied = approvals.declineOwned(ownedId, 'interrupt');
      const withdrawn = withdrawAll();
      dropCalls();
      const reached = [...table.all.values()].filter(stopReaches);
      const overs = overOut();
      if (turn || wake || reached.length > 0 || overs > 0) {
        write({ t: 'interrupt' });
        cutOff = turn || wake;
        // After it no wake follows (measured); a woken turn still has its result to come.
        if (!wake) {
          cancelOwed();
          owed = false;
        }
        endedInTurn = false;
      }
      if ((reached.length > 0 || overs > 0) && stopping === null) {
        const busy = reached.filter(memberBusy);
        stopping = { reached, busy, overs, reads: 0 };
        // Unconfirmed until it is read, so the stop stays on offer meanwhile.
        for (const m of busy) m.stopLeft = true;
        if (busy.length + overs > 0) feed.upsert(MEMBERS_STOP_REF, { kind: 'note', ref: MEMBERS_STOP_REF, text: `${busy.length + overs}`, state: 'members-stopping' });
        cancelStopRead = after(CLAUDE_DEADLINES.stopSettleMs, () => void readStop());
      }
      changed();
      return { withdrawn, denied };
    },
    end: (why: 'you-ended' | 'daemon-stop' | 'requester-withdrew' = 'you-ended') => endSession('end', why === 'daemon-stop' || why === 'requester-withdrew' ? why : 'you-ended'),
    get jobbed() {
      return job !== null && !closed && !braked;
    },
    async brake(): Promise<OwnedBrake> {
      if (closed || braked) return { ok: false, reason: 'ended' };
      if (job === null) return { ok: false, reason: 'no-job' };
      braked = true;
      const ending = job.endTree();
      approvals.declineOwned(ownedId, 'brake');
      cancelInit();
      // Ending already (the stop order runs): the rest of the order gives way, the end reason stays.
      cancelStop();
      if (!terminal()) {
        state = 'ended';
        endReason = 'braked';
        turn = false;
        wake = false;
        loseMembers();
        withdrawAll();
        unsureAll();
        showAllTools();
        settleReady(false);
      }
      feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'braked' });
      changed();
      const o = await ending;
      if (!closed) endHostNow(pipe);
      noteTree(o);
      return o.ok ? { ok: true, killed: o.killed, left: o.left } : { ok: true, killed: null, left: null };
    },
    stats: () => ({ stderrTail, failure, exit: exitFrame, closed }),
  };
  return Object.freeze(session);
}
