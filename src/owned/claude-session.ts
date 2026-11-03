import * as path from 'node:path';
import type { After, HostPipe } from '../os/owned-proc.ts';
import type { ClockHub, Fired } from '../runtime/clock.ts';
import type { Answer, AnswerCause, ApprovalKind, ApprovalRisk, Approvals } from './approvals.ts';
import type { PathJudge } from './codex-session.ts';
import type { FeedInput, FeedTokens } from './feed.ts';
import type { JobOutcome } from '../os/procguard.ts';
import type { OwnedBrake } from './codex-session.ts';
import { treeNote } from './codex-session.ts';
import type { Redact } from './text.ts';
import { isWithin } from '../fs/paths.ts';
import { endHostNow, stopHostInOrder } from '../os/owned-proc.ts';
import { Feed } from './feed.ts';
import { guardedPlace } from './guarded.ts';
import { isClaudeModel } from './models.ts';
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

export const CLAUDE_SESSION_LIMITS = frozen({
  /** Messages waiting for the turn to end. */
  queue: 5,
  /** One host line (hosts/claude/host-core.mjs LINE_MAX_BYTES). */
  lineBytes: 64 * 1024,
  /** The tail of the host's stderr kept for the report of a failure. */
  stderrChars: 4096,
});

export const CLAUDE_DEADLINES = frozen({ initMs: 120_000 });

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
  /** The host reports cost, not tokens: always null (T1: not a 0). */
  readonly tokens: FeedTokens | null;
  /** The cost the last result reported (USD), or null before any. */
  readonly costUsd: number | null;
  readonly queued: number;
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
  /** A user frame went to the host and its result has not come. */
  let turn = false;
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
    if (terminal() || turn || queue.length === 0) return;
    sendNow(queue.shift()!);
    changed();
  };

  // --- what the host says ----------------------------------------------------------------------------

  /** The card of an ask frame, or the reason it is declined without one. */
  const askOf = (f: Obj) => {
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
    // A session that is ending answers what still arrives with the refusal, no card (as codex-session.ts does).
    if (terminal()) {
      perm(false);
      const s = shownFeed(str(f.toolName) ?? '', 'head');
      feed.push({ kind: 'auto-denied', ref: toolUseId, text: s.text, state: 'ending', redactions: s.redactions });
      changed();
      return;
    }
    const a = askOf(f);
    if (a.hit !== null) {
      // A protected row of the spawn gate's table: declined at once, no card (D8 forbids only automatic allows).
      perm(false);
      const s = shownFeed(`${a.title} (${a.hit})`, 'head');
      feed.push({ kind: 'auto-denied', ref: toolUseId, text: s.text, state: 'protected', redactions: s.redactions });
      changed();
      return;
    }
    const t = shown(redact, a.title, 400, 'head');
    const p = shown(redact, a.preview, Number.MAX_SAFE_INTEGER, 'head');
    let approvalId = '';
    const view = approvals.add({
      ownedId, kind: kindOf(a.toolName), title: t.text, preview: p.text, redactions: t.redactions + p.redactions + (typeof f.redactions === 'number' ? f.redactions : 0),
      risk: a.risk, canAccept: !a.tooLong, canText: false,
      answer: (ans: Answer, cause: AnswerCause) => {
        asked.delete(reqId);
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
    hideTool(toolUseId);
    feed.push({ kind: 'ask', ref: approvalId, text: shownFeed(a.title, 'head').text, state: kindOf(a.toolName) });
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
        const s = shownFeed(chunk, 'head');
        feed.push({ kind: 'text', ref: str(f.uuid), text: s.text, state: 'final', redactions: s.redactions });
        return;
      }
      case 'tool': {
        const id = str(f.toolUseId);
        const name = str(f.name);
        if (id === null || name === null || id.length > TOOL_ID_MAX) return;
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
        showTool(askTool.get(approvalId) ?? null);
        askTool.delete(approvalId);
        return;
      }
      case 'denied-auto': {
        const s = shownFeed(str(f.name) ?? '', 'head');
        const why = str(f.why);
        feed.push({ kind: 'auto-denied', ref: str(f.toolUseId), text: s.text, state: why !== null && /^[a-z-]{1,32}$/.test(why) ? why : 'host', redactions: s.redactions });
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
      case 'result': {
        turn = false;
        confirmAll();
        if (state === 'running') state = 'idle';
        const sub = str(f.subtype) ?? '';
        feed.push({ kind: 'lifecycle', ref: str(f.uuid), text: null, state: TURN_END[sub] ?? 'turn-unknown' });
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
    protectedRoots: [...opts.protectedRoots], askTimeoutMs: opts.askTimeoutMs,
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
    tokens: null,
    get costUsd() {
      return costUsd;
    },
    get queued() {
      return queue.length;
    },
    feed,
    ready,
    exited,
    send(text: string, uuid: string): ClaudeSendResult {
      if (terminal()) return { ok: false, reason: 'ended' };
      const now = !turn && queue.length === 0;
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
      if (turn) write({ t: 'interrupt' });
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
