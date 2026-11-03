import * as crypto from 'node:crypto';
import type { ChildPipe } from '../os/child-pipe.ts';
import type { ClockHub } from '../runtime/clock.ts';
import type { OwnedSeat } from '../sources/tower.ts';
import type { Approvals } from './approvals.ts';
import type { CodexEndReason, CodexSession, CodexSessionState, PathJudge } from './codex-session.ts';
import type { OwnedRecord, OwnedRegistry } from './registry.ts';
import type { Redact } from './text.ts';
import { isOver, startCodexSession } from './codex-session.ts';
import { Feed } from './feed.ts';
import { DEFAULT_CODEX_MODEL, isOwnedModel } from './models.ts';
import { afterRestart } from './registry.ts';
import { shown } from './text.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The owned Codex sessions of one orchestrad (orchestra app plan §2): it names each new session (20
// lowercase hex digits from node:crypto, slice design §2.4), has its work dir made, starts it, and keeps
// it for the routes to find. It holds no gate and no fence of its own: the composition root hands it
// makeWorkDir (the write fence) and launch (the spawn gate, rule codex-app-server, cwd checked there).
//
// With a registry (src/owned/registry.ts) each session's state is kept on disk as it changes, and the
// sessions an earlier orchestrad left are listed again at start: those that had not ended as unknown
// (daemon-restart), never resumed. They hold no child and no seat here; their feed says only that.

/**
 * The running owned sessions of both harnesses together (slice design §2.4: "同时最多 3 个活动的自有会话",
 * a total, and §4's text "同时最多 3 个，先结束一个"). The composition root hands both managers one pool.
 */
export const OWNED_POOL_MAX = 3;
/** What both managers count against: the total that may run, and how many run now (every harness). */
export type OwnedPool = { readonly max: number; active(): number };

export const CODEX_OWNED_LIMITS = frozen({
  /** Codex sessions running at once when no shared pool is given (tests); with one, the pool's total counts too. */
  active: 3,
  /** Ended sessions kept for their feed; the oldest go first. */
  ended: 50,
  /** A session's title: the first line of its first message, at most this many UTF-8 bytes once shown. */
  titleBytes: 240,
});

/** What the routes and the tower know of a session beyond its driver: its title and when it was made. */
export type OwnedMeta = { readonly ownedId: string; readonly harness: 'codex'; readonly title: string; readonly createdAt: number };

export type CodexOwnedOptions = {
  approvals: Approvals;
  /** Makes ORCHESTRA_HOME\work\<ownedId> through the write fence and returns it. */
  makeWorkDir(ownedId: string): string;
  /** Starts codex app-server in `cwd` through the spawn gate. */
  launch(cwd: string): ChildPipe;
  now(): number;
  redact: Redact;
  onChange?: () => void;
  maxActive?: number;
  /** Tests only: a smaller line bound for the JSON-RPC client. */
  rpcLineMaxBytes?: number;
  /** The Clock hub the sessions' request deadlines run on. */
  hub?: ClockHub;
  /** Judges the paths an approval names (the spawn gate's cwd table, src/os/cwd.ts CwdPolicy.place). */
  judge?: PathJudge;
  /** Where each session's state is kept across a restart; without one nothing outlives this orchestrad. */
  registry?: OwnedRegistry;
  /** The limit both harnesses share (OWNED_POOL_MAX); without one only this manager's own count limits it. */
  pool?: OwnedPool;
};

export type NewOwned =
  | { ok: true; ownedId: string; session: CodexSession }
  | { ok: false; reason: 'model-refused' | 'owned-limit' | 'cwd-failed' | 'spawn-refused'; detail: string };

export class CodexOwned {
  readonly #opts: CodexOwnedOptions;
  readonly #sessions = new Map<string, CodexSession>();
  readonly #meta = new Map<string, OwnedMeta>();
  readonly #max: number;

  constructor(opts: CodexOwnedOptions) {
    this.#opts = opts;
    this.#max = opts.maxActive ?? CODEX_OWNED_LIMITS.active;
    if (opts.registry !== undefined) {
      // The registry holds every harness's sessions; the owned Claude sessions list their own (claude-owned.ts).
      const all = this.#load(opts.registry).filter((r) => r.harness === 'codex');
      // The newest kept, as #trim keeps them; older files stay on disk unread.
      for (const was of all.slice(-CODEX_OWNED_LIMITS.ended)) {
        const r = afterRestart(was);
        if (r !== was) this.#save(r);
        this.#sessions.set(r.ownedId, restoredSession(r, opts.now));
        this.#meta.set(r.ownedId, Object.freeze({ ownedId: r.ownedId, harness: 'codex', title: r.title, createdAt: r.createdAt }));
      }
    }
  }

  /** How many sessions an earlier orchestrad left that this one lists again. */
  get restored(): number {
    return [...this.#sessions.values()].filter((s) => s.endReason === 'daemon-restart' || s.stats().failure === RESTORED).length;
  }

  #load(registry: OwnedRegistry): OwnedRecord[] {
    try {
      return registry.load();
    } catch {
      return [];
    }
  }

  /** Keeps a session's state on disk; a failed write leaves the last one there (logged by whoever watches onChange). */
  #save(r: OwnedRecord): void {
    try {
      this.#opts.registry?.save(r);
    } catch {
      this.#saveFailures++;
    }
  }

  #saveFailures = 0;

  /** Registry writes that failed since start. */
  get saveFailures(): number {
    return this.#saveFailures;
  }

  get approvals(): Approvals {
    return this.#opts.approvals;
  }

  /** How many sessions may run at once (the shared pool's total when there is one). */
  get maxActive(): number {
    return this.#opts.pool?.max ?? this.#max;
  }

  /** Whether a new session would be refused as owned-limit now. */
  full(): boolean {
    const pool = this.#opts.pool;
    return this.active() >= this.#max || (pool !== undefined && pool.active() >= pool.max);
  }

  /** Sessions whose child still runs. */
  active(): number {
    return [...this.#sessions.values()].filter((s) => !isOver(s.state)).length;
  }

  /**
   * A new session; `text` (with the uuid of its human record) is its first message, `title` (the dispatch desk's) names it in place of that message's first line.
   * `cwd`: a project root (or a folder in one) the composition root let through (--project-root); absent, the session gets its own ORCHESTRA_HOME\work\<id>.
   * The spawn gate holds either to its cwd table again. The model is checked before anything is made.
   * `tainted` (r4 §8.5): the first message comes from an unbound sender (a seat request): the thread starts with
   * the untrusted approval policy, and a thread/start reply that does not echo it ends the session as policy-mismatch.
   */
  create(req: { model?: string; text?: string; uuid?: string; title?: string; cwd?: string; tainted?: boolean } = {}): NewOwned {
    const model = req.model ?? DEFAULT_CODEX_MODEL;
    if (!isOwnedModel(model)) return { ok: false, reason: 'model-refused', detail: String(model) };
    if (this.full()) return { ok: false, reason: 'owned-limit', detail: `${this.maxActive} running` };
    const ownedId = crypto.randomBytes(10).toString('hex');
    let cwd: string;
    try {
      cwd = req.cwd ?? this.#opts.makeWorkDir(ownedId);
    } catch (e) {
      return { ok: false, reason: 'cwd-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    const o = this.#opts;
    const first = (req.title ?? req.text ?? '').trim().split('\n', 1)[0] ?? '';
    const title = first === '' ? '' : shown(o.redact, first, CODEX_OWNED_LIMITS.titleBytes, 'head').text;
    const createdAt = o.now();
    // The registry entry follows the state: written when the session is made and whenever its state moves.
    let mine: CodexSession | null = null;
    let kept = '';
    const keep = () => {
      if (mine === null || o.registry === undefined) return;
      const key = `${mine.state}|${String(mine.endReason)}`;
      if (key === kept) return;
      kept = key;
      this.#save({ v: 1, ownedId, harness: 'codex', model, title, createdAt, state: mine.state, endReason: mine.endReason });
    };
    const started = startCodexSession({
      ownedId, cwd, model, launch: () => o.launch(cwd), approvals: o.approvals, now: o.now, redact: o.redact,
      onChange: () => {
        keep();
        o.onChange?.();
      },
      ...(o.rpcLineMaxBytes !== undefined ? { rpcLineMaxBytes: o.rpcLineMaxBytes } : {}),
      ...(o.hub !== undefined ? { hub: o.hub } : {}),
      ...(o.judge !== undefined ? { judge: o.judge } : {}),
      // A cwd handed in is a project root (or a folder in one): only the read-only sandbox is taken there.
      ...(req.cwd !== undefined ? { projectRoot: true } : {}),
      ...(req.tainted === true ? { tainted: true } : {}),
    });
    if (!started.ok) return started;
    mine = started.session;
    keep();
    this.#sessions.set(ownedId, started.session);
    this.#meta.set(ownedId, Object.freeze({ ownedId, harness: 'codex', title, createdAt }));
    this.#trim();
    if (req.text !== undefined) started.session.send(req.text, req.uuid ?? '');
    return { ok: true, ownedId, session: started.session };
  }

  get(ownedId: string): CodexSession | null {
    return this.#sessions.get(ownedId) ?? null;
  }

  list(): CodexSession[] {
    return [...this.#sessions.values()];
  }

  meta(ownedId: string): OwnedMeta | null {
    return this.#meta.get(ownedId) ?? null;
  }

  /** Every session as the tower draws it: the driver's state, and the earliest open approval with its deadline. */
  towerSeats(): OwnedSeat[] {
    const open = this.#opts.approvals.list();
    return this.list().map((s) => {
      const mine = open.filter((a) => a.ownedId === s.ownedId).sort((a, b) => a.deadlineWall - b.deadlineWall);
      const first = mine[0] ?? null;
      return {
        ownedId: s.ownedId, harness: 'codex' as const, title: this.#meta.get(s.ownedId)?.title ?? '', state: s.state, endReason: s.endReason,
        waiting: first === null ? null : { kind: first.kind === 'question' ? 'question' as const : 'approval' as const, deadline: first.deadlineWall, title: first.title },
        lastAt: s.feed.lastAt,
        recent: recentOf(s.feed),
      };
    });
  }

  /**
   * Ends every running session as orchestrad stops (endReason daemon-stop, not you-ended: nobody pressed
   * end): their open approvals are declined first, then each child is stopped (stdin closed, then killed
   * at once, child-pipe.ts). In a Job, its whole tree goes with it; without one (procguard off), what its
   * commands started may remain (children-may-remain).
   */
  endAll(): number {
    let n = 0;
    for (const s of this.#sessions.values()) {
      if (isOver(s.state)) continue;
      s.end('daemon-stop');
      n++;
    }
    return n;
  }

  #trim(): void {
    const ended = [...this.#sessions.values()].filter((s) => isOver(s.state));
    for (const s of ended.slice(0, Math.max(0, ended.length - CODEX_OWNED_LIMITS.ended))) {
      this.#sessions.delete(s.ownedId);
      this.#meta.delete(s.ownedId);
    }
  }
}
frozenClass(CodexOwned);

/**
 * The newest thing a session said or did that a person reads, for the tower's activity line: its last
 * words (a message still streaming counts), a command or file change, your message, an automatic refusal.
 * Turn starts, token counts and notes are not activity. Null when the feed holds none of these.
 */
export function recentOf(feed: Feed): OwnedSeat['recent'] {
  const e = feed.last((x) => x.text !== null && x.text.trim() !== '' && (x.kind === 'text' || x.kind === 'you' || x.kind === 'auto-denied' || x.kind === 'tool'));
  if (e === null || e.text === null) return null;
  if (e.kind === 'tool') return { kind: e.state === 'file-change' ? 'file-change' : 'command', text: e.text.split('\n', 1)[0]! };
  return { kind: e.kind === 'text' ? 'text' : e.kind === 'you' ? 'you' : 'auto-denied', text: e.text };
}

/** The failure text of a session listed again after a restart. */
const RESTORED = 'listed again after a restart';

/**
 * A session an earlier orchestrad left, as the routes and the tower see it: no child, no seat, nothing
 * sent to it; its feed says only that orchestrad restarted (the conversation stayed with the old one).
 */
export function restoredSession(r: OwnedRecord, now: () => number): CodexSession {
  const feed = new Feed(now);
  feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'daemon-restart' });
  const state = r.state as CodexSessionState;
  const endReason = r.endReason as CodexEndReason | null;
  return Object.freeze({
    ownedId: r.ownedId, model: r.model, cwd: '', state, endReason, threadId: null, turnId: null, tokens: null, queued: 0, feed,
    ready: Promise.resolve(false),
    send: () => ({ ok: false as const, reason: 'ended' as const }),
    interrupt: async () => ({ withdrawn: 0, denied: 0 }),
    end: () => ({ denied: 0 }),
    jobbed: false,
    brake: async () => ({ ok: false as const, reason: 'ended' as const }),
    stats: () => ({ rpc: null, stderrTail: '', failure: RESTORED }),
  });
}
