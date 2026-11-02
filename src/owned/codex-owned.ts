import * as crypto from 'node:crypto';
import type { ChildPipe } from '../os/child-pipe.ts';
import type { OwnedSeat } from '../sources/tower.ts';
import type { Approvals } from './approvals.ts';
import type { CodexSession } from './codex-session.ts';
import type { Redact } from './text.ts';
import { startCodexSession } from './codex-session.ts';
import { DEFAULT_CODEX_MODEL, isOwnedModel } from './models.ts';
import { shown } from './text.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// The owned Codex sessions of one orchestrad (orchestra app plan §2): it names each new session (20
// lowercase hex digits from node:crypto, slice design §2.4), has its work dir made, starts it, and keeps
// it for the routes to find. It holds no gate and no fence of its own: the composition root hands it
// makeWorkDir (the write fence) and launch (the spawn gate, rule codex-app-server, cwd checked there).

export const CODEX_OWNED_LIMITS = frozen({
  /** Sessions running at once (slice design §2.4's suggested 3). */
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
  }

  get approvals(): Approvals {
    return this.#opts.approvals;
  }

  /** How many sessions may run at once. */
  get maxActive(): number {
    return this.#max;
  }

  /** Sessions whose child still runs. */
  active(): number {
    return [...this.#sessions.values()].filter((s) => s.state !== 'ended' && s.state !== 'failed').length;
  }

  /** A new session; `text` (with the uuid of its human record) is its first message. The model is checked before anything is made. */
  create(req: { model?: string; text?: string; uuid?: string } = {}): NewOwned {
    const model = req.model ?? DEFAULT_CODEX_MODEL;
    if (!isOwnedModel(model)) return { ok: false, reason: 'model-refused', detail: String(model) };
    if (this.active() >= this.#max) return { ok: false, reason: 'owned-limit', detail: `${this.#max} running` };
    const ownedId = crypto.randomBytes(10).toString('hex');
    let cwd: string;
    try {
      cwd = this.#opts.makeWorkDir(ownedId);
    } catch (e) {
      return { ok: false, reason: 'cwd-failed', detail: e instanceof Error ? e.message : String(e) };
    }
    const o = this.#opts;
    const started = startCodexSession({
      ownedId, cwd, model, launch: () => o.launch(cwd), approvals: o.approvals, now: o.now, redact: o.redact,
      ...(o.onChange !== undefined ? { onChange: o.onChange } : {}),
      ...(o.rpcLineMaxBytes !== undefined ? { rpcLineMaxBytes: o.rpcLineMaxBytes } : {}),
    });
    if (!started.ok) return started;
    const first = (req.text ?? '').trim().split('\n', 1)[0] ?? '';
    const title = first === '' ? '' : shown(o.redact, first, CODEX_OWNED_LIMITS.titleBytes, 'head').text;
    this.#sessions.set(ownedId, started.session);
    this.#meta.set(ownedId, Object.freeze({ ownedId, harness: 'codex', title, createdAt: o.now() }));
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
      };
    });
  }

  /** Ends every running session (orchestrad stops): their open approvals are declined first. */
  endAll(): number {
    let n = 0;
    for (const s of this.#sessions.values()) {
      if (s.state === 'ended' || s.state === 'failed') continue;
      s.end();
      n++;
    }
    return n;
  }

  #trim(): void {
    const ended = [...this.#sessions.values()].filter((s) => s.state === 'ended' || s.state === 'failed');
    for (const s of ended.slice(0, Math.max(0, ended.length - CODEX_OWNED_LIMITS.ended))) {
      this.#sessions.delete(s.ownedId);
      this.#meta.delete(s.ownedId);
    }
  }
}
frozenClass(CodexOwned);
