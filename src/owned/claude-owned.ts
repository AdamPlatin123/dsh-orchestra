import * as crypto from 'node:crypto';
import type { HostPipe } from '../os/owned-proc.ts';
import type { ClockHub } from '../runtime/clock.ts';
import type { OwnedSeat } from '../sources/tower.ts';
import type { Approvals } from './approvals.ts';
import type { ClaudeEndReason, ClaudeSession, ClaudeSessionState } from './claude-session.ts';
import type { PathJudge } from './codex-session.ts';
import type { OwnedRecord, OwnedRegistry } from './registry.ts';
import type { Redact } from './text.ts';
import { APPROVAL_LIMITS } from './approvals.ts';
import { isClaudeOver, startClaudeSession } from './claude-session.ts';
import { recentOf } from './codex-owned.ts';
import { Feed } from './feed.ts';
import { DEFAULT_CLAUDE_MODEL, isClaudeModel } from './models.ts';
import { afterRestart } from './registry.ts';
import { shown } from './text.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The owned Claude sessions of one orchestrad (orchestra app step 4; alpha 0.2 design §2.4, §2.5), the
// twin of codex-owned.ts: it names each new session (20 lowercase hex digits from node:crypto), has its
// work dir and its private config dir made, starts its host, and keeps it for the routes and the tower.
// It holds no gate and no fence of its own: the composition root hands it makeWorkDir, makeConfigDir
// (the write fence) and launch (the spawn gate, rule claude-host).
//
// The registry is the one the owned Codex sessions use (ORCHESTRA_HOME\owned\<ownedId>.json, harness
// claude); after a restart the sessions an earlier orchestrad left come back as unknown (daemon-restart)
// when they had not ended, never resumed and never sent anything again (r4 §8.3 rule 5).

export const CLAUDE_OWNED_LIMITS = frozen({
  /** Sessions running at once (slice design §2.4's suggested 3). */
  active: 3,
  /** Ended sessions kept for their feed; the oldest go first. */
  ended: 50,
  /** A session's title: the first line of its first message, at most this many UTF-8 bytes once shown. */
  titleBytes: 240,
});

export type ClaudeMeta = { readonly ownedId: string; readonly harness: 'claude'; readonly title: string; readonly createdAt: number };

export type ClaudeOwnedOptions = {
  approvals: Approvals;
  /** Makes ORCHESTRA_HOME\work\<ownedId> through the write fence and returns it. */
  makeWorkDir(ownedId: string): string;
  /** Makes ORCHESTRA_HOME\claude\<ownedId> (the session's private CLAUDE_CONFIG_DIR) through the write fence and returns it. */
  makeConfigDir(ownedId: string): string;
  /** Starts the host through the spawn gate (rule claude-host) in `cwd`. */
  launch(cwd: string): HostPipe;
  /** The SDK's claude.exe (src/owned/claude-site.ts). */
  claudeExe: string;
  /** Roots no tool call of any session may reach (the data dir, the repository, the harness roots). */
  protectedRoots: readonly string[];
  hub: ClockHub;
  now(): number;
  redact: Redact;
  onChange?: () => void;
  maxActive?: number;
  judge?: PathJudge;
  registry?: OwnedRegistry;
  /** The approval timeout the host's own backstop counts from (default: the queue's 30 minutes). */
  askTimeoutMs?: number;
};

export type NewClaude =
  | { ok: true; ownedId: string; session: ClaudeSession }
  | { ok: false; reason: 'model-refused' | 'owned-limit' | 'cwd-failed' | 'spawn-refused'; detail: string };

export class ClaudeOwned {
  readonly #opts: ClaudeOwnedOptions;
  readonly #sessions = new Map<string, ClaudeSession>();
  readonly #meta = new Map<string, ClaudeMeta>();
  readonly #max: number;
  #saveFailures = 0;

  constructor(opts: ClaudeOwnedOptions) {
    this.#opts = opts;
    this.#max = opts.maxActive ?? CLAUDE_OWNED_LIMITS.active;
    if (opts.registry !== undefined) {
      let all: OwnedRecord[];
      try {
        all = opts.registry.load().filter((r) => r.harness === 'claude');
      } catch {
        all = [];
      }
      for (const was of all.slice(-CLAUDE_OWNED_LIMITS.ended)) {
        const r = afterRestart(was);
        if (r !== was) this.#save(r);
        this.#sessions.set(r.ownedId, restoredSession(r, opts.now));
        this.#meta.set(r.ownedId, Object.freeze({ ownedId: r.ownedId, harness: 'claude', title: r.title, createdAt: r.createdAt }));
      }
    }
  }

  /** How many sessions an earlier orchestrad left that this one lists again. */
  get restored(): number {
    return [...this.#sessions.values()].filter((s) => s.stats().failure === RESTORED).length;
  }

  get saveFailures(): number {
    return this.#saveFailures;
  }

  get approvals(): Approvals {
    return this.#opts.approvals;
  }

  get maxActive(): number {
    return this.#max;
  }

  #save(r: OwnedRecord): void {
    try {
      this.#opts.registry?.save(r);
    } catch {
      this.#saveFailures++;
    }
  }

  /** Sessions whose host still runs. */
  active(): number {
    return [...this.#sessions.values()].filter((s) => !isClaudeOver(s.state)).length;
  }

  /** A new session; `text` (with the uuid of its human record) is its first message. The model is checked before anything is made. */
  create(req: { model?: string; text?: string; uuid?: string } = {}): NewClaude {
    const model = req.model ?? DEFAULT_CLAUDE_MODEL;
    if (!isClaudeModel(model)) return { ok: false, reason: 'model-refused', detail: String(model) };
    if (this.active() >= this.#max) return { ok: false, reason: 'owned-limit', detail: `${this.#max} running` };
    const o = this.#opts;
    const ownedId = crypto.randomBytes(10).toString('hex');
    let cwd: string;
    let configDir: string;
    try {
      cwd = o.makeWorkDir(ownedId);
      configDir = o.makeConfigDir(ownedId);
    } catch (e) {
      return { ok: false, reason: 'cwd-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    const first = (req.text ?? '').trim().split('\n', 1)[0] ?? '';
    const title = first === '' ? '' : shown(o.redact, first, CLAUDE_OWNED_LIMITS.titleBytes, 'head').text;
    const createdAt = o.now();
    let mine: ClaudeSession | null = null;
    let kept = '';
    const keep = () => {
      if (mine === null || o.registry === undefined) return;
      const key = `${mine.state}|${String(mine.endReason)}`;
      if (key === kept) return;
      kept = key;
      this.#save({ v: 1, ownedId, harness: 'claude', model, title, createdAt, state: mine.state, endReason: mine.endReason });
    };
    const started = startClaudeSession({
      ownedId, cwd, configDir, model, claudeExe: o.claudeExe, protectedRoots: o.protectedRoots, askTimeoutMs: o.askTimeoutMs ?? APPROVAL_LIMITS.timeoutMs,
      launch: () => o.launch(cwd), approvals: o.approvals, now: o.now, redact: o.redact, hub: o.hub,
      onChange: () => {
        keep();
        o.onChange?.();
      },
      ...(o.judge !== undefined ? { judge: o.judge } : {}),
    }, req.text === undefined ? null : { text: req.text, uuid: req.uuid ?? '' });
    if (!started.ok) return started;
    mine = started.session;
    keep();
    this.#sessions.set(ownedId, started.session);
    this.#meta.set(ownedId, Object.freeze({ ownedId, harness: 'claude', title, createdAt }));
    this.#trim();
    return { ok: true, ownedId, session: started.session };
  }

  get(ownedId: string): ClaudeSession | null {
    return this.#sessions.get(ownedId) ?? null;
  }

  list(): ClaudeSession[] {
    return [...this.#sessions.values()];
  }

  meta(ownedId: string): ClaudeMeta | null {
    return this.#meta.get(ownedId) ?? null;
  }

  /** Every session as the tower draws it (harness claude, ownership owned). */
  towerSeats(): OwnedSeat[] {
    const open = this.#opts.approvals.list();
    return this.list().map((s) => {
      const first = open.filter((a) => a.ownedId === s.ownedId).sort((a, b) => a.deadlineWall - b.deadlineWall)[0] ?? null;
      return {
        ownedId: s.ownedId, harness: 'claude' as const, title: this.#meta.get(s.ownedId)?.title ?? '', state: s.state, endReason: s.endReason,
        waiting: first === null ? null : { kind: 'approval' as const, deadline: first.deadlineWall, title: first.title },
        lastAt: s.feed.lastAt,
        recent: recentOf(s.feed),
      };
    });
  }

  /** Ends every running session (orchestrad stops): their open approvals are declined first. */
  endAll(): number {
    let n = 0;
    for (const s of this.#sessions.values()) {
      if (isClaudeOver(s.state)) continue;
      s.end();
      n++;
    }
    return n;
  }

  #trim(): void {
    const ended = [...this.#sessions.values()].filter((s) => isClaudeOver(s.state));
    for (const s of ended.slice(0, Math.max(0, ended.length - CLAUDE_OWNED_LIMITS.ended))) {
      this.#sessions.delete(s.ownedId);
      this.#meta.delete(s.ownedId);
    }
  }
}
frozenClass(ClaudeOwned);

const RESTORED = 'listed again after a restart';

/** A session an earlier orchestrad left: no host, nothing sent to it; its feed says only that orchestrad restarted. */
function restoredSession(r: OwnedRecord, now: () => number): ClaudeSession {
  const feed = new Feed(now);
  feed.push({ kind: 'lifecycle', ref: null, text: null, state: 'daemon-restart' });
  return Object.freeze({
    ownedId: r.ownedId, harness: 'claude' as const, model: r.model, cwd: '', state: r.state as ClaudeSessionState, endReason: r.endReason as ClaudeEndReason | null,
    sessionId: null, tokens: null, costUsd: null, queued: 0, feed, ready: Promise.resolve(false),
    send: () => ({ ok: false as const, reason: 'ended' as const }),
    interrupt: async () => ({ withdrawn: 0, denied: 0 }),
    end: () => ({ denied: 0 }),
    stats: () => ({ stderrTail: '', failure: RESTORED, exit: null }),
  });
}
