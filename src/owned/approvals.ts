import * as crypto from 'node:crypto';
import type { Clock, ClockHub, Fired } from '../runtime/clock.ts';
import { canonicalDigest } from '../store/canonical-json.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';
import { OWNED_TEXT_LIMITS, headUtf8, utf8Length } from './text.ts';

// The approval queue of the owned sessions (alpha 0.2 slice design §2.6; r4 D8 and §10.9). One queue
// for every session. Only a person decides, on the paired page; nothing here allows anything by itself:
//  - every entry has a deadline on the Clock (Q4: 30 minutes); when it fires the entry is declined (D8,
//    timeout is a refusal), with cause 'clock';
//  - allowing takes the digest of what the page showed and the list revision it was drawn from: another
//    digest is declined and answered digest-mismatch; another revision changes nothing and is answered
//    stale-view (the server half of §10.9's freeze: the page knows when it drew, the server which list);
//  - an allow that comes within 750 ms of a change of the list is stale-view too (r4 10.9: a list that just
//    moved under the pointer takes no allow; the page freezes its own order, this is the server's half);
//  - declining is taken at once, whatever the revision;
//  - an entry the page cannot show whole (tooLong), or whose kind has no allow (a question, an MCP
//    elicitation, a write grant for the rest of the session), offers only decline;
//  - each entry is answered once: its state turns answered before the answer is written to the child.
// Answers are only {accept} or {decline} (or, for a question, a text): never "for this session", never
// a rule that outlives the one request (the session maps them; codex-session.ts).

export const APPROVAL_LIMITS = frozen({
  /** Q4: an open approval is declined after 30 minutes. */
  timeoutMs: 30 * 60 * 1000,
  /** r4 10.9: for this long after the list changed, an allow is not taken (stale-view). */
  settleMs: 750,
});

export const APPROVAL_KINDS = frozen(['command', 'file-change', 'permissions', 'question', 'elicitation'] as const);
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Slice design §2.6's risk classes, as far as a codex request tells them. */
export const APPROVAL_RISKS = frozen(['shell', 'write', 'net', 'protected', 'other'] as const);
export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];

export type Answer = { readonly decision: 'accept' } | { readonly decision: 'decline' } | { readonly decision: 'text'; readonly text: string };

/** Who answered: the person, the deadline, a stop of the turn, or the end of the session. */
export type AnswerCause = 'human' | 'clock' | 'interrupt' | 'end';

export type ApprovalInput = {
  ownedId: string;
  kind: ApprovalKind;
  /** One line: what is asked (a command's first line, "edit 2 files"...). Redacted and escaped already. */
  title: string;
  /** Everything the request carries that a person needs to judge it; redacted and escaped already. */
  preview: string;
  redactions: number;
  risk: ApprovalRisk;
  canAccept: boolean;
  /** A question one line of text can answer. */
  canText: boolean;
  /** Writes the answer to the child; called once. */
  answer(a: Answer, cause: AnswerCause): void;
};

export type ApprovalView = {
  readonly approvalId: string;
  readonly ownedId: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly preview: string;
  readonly tooLong: boolean;
  readonly redactions: number;
  readonly digest: string;
  readonly risk: ApprovalRisk;
  /** §10.9 high risk: a shell, the network, a grant, or a hidden secret; the page asks to hold or type. */
  readonly high: boolean;
  /** The list revision this entry came in with (the list's own rev moves on with every later change). */
  readonly rev: number;
  readonly canAccept: boolean;
  readonly canText: boolean;
  readonly deadlineMono: number;
  readonly deadlineWall: number;
};

export type ApprovalVerdict = 'ok' | 'approval-gone' | 'digest-mismatch' | 'stale-view';

type Entry = { view: ApprovalView; answer: ApprovalInput['answer']; timerId: string };

/** How an entry left the queue: answered (by whom, with what), or dropped unanswered (its child resolved it or is gone). */
export type ApprovalOutcome = { readonly decision: Answer['decision'] | 'dropped'; readonly cause: AnswerCause | 'gone' };

export type ApprovalsOptions = {
  /** The hub the composition root holds; the queue takes its own Clock from it. */
  hub: ClockHub;
  timeoutMs?: number;
  /** How long after a change of the list an allow is refused as stale-view (default APPROVAL_LIMITS.settleMs). */
  settleMs?: number;
  /** Hears every change of the list (the page's revision moved). */
  onChange?: () => void;
  /** Hears every entry that leaves the queue, after its answer was written: the composition root logs the deadline's refusals here. */
  onSettled?: (view: ApprovalView, outcome: ApprovalOutcome) => void;
};

export class Approvals {
  readonly #open = new Map<string, Entry>();
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #settleMs: number;
  readonly #onChange: () => void;
  readonly #onSettled: NonNullable<ApprovalsOptions['onSettled']>;
  #rev = 0;
  /** The monotonic reading of the last change of the list; null before any. */
  #changedMono: number | null = null;

  constructor(opts: ApprovalsOptions) {
    const timeoutMs = opts.timeoutMs ?? APPROVAL_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('approvals: timeoutMs must be a positive integer');
    const settleMs = opts.settleMs ?? APPROVAL_LIMITS.settleMs;
    if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new Error('approvals: settleMs must be a non-negative integer');
    this.#timeoutMs = timeoutMs;
    this.#settleMs = settleMs;
    this.#onChange = opts.onChange ?? (() => {});
    this.#onSettled = opts.onSettled ?? (() => {});
    this.#clock = opts.hub.port((f) => this.#fired(f));
  }

  /** The list revision: it moves whenever an entry comes or goes, in any session. */
  get rev(): number {
    return this.#rev;
  }

  add(input: ApprovalInput): ApprovalView {
    const approvalId = crypto.randomBytes(16).toString('hex');
    const whole = utf8Length(input.preview) <= OWNED_TEXT_LIMITS.previewBytes;
    const preview = whole ? input.preview : headUtf8(input.preview, OWNED_TEXT_LIMITS.previewBytes).text;
    const title = headUtf8(input.title, 200).text;
    const risk = input.risk;
    const high = risk === 'shell' || risk === 'net' || risk === 'protected' || input.kind === 'permissions' || input.redactions > 0;
    const deadlineMono = this.#clock.nowMono() + this.#timeoutMs;
    const view: ApprovalView = Object.freeze({
      approvalId, ownedId: input.ownedId, kind: input.kind, title, preview, tooLong: !whole, redactions: input.redactions,
      digest: canonicalDigest({ approvalId, kind: input.kind, title, preview }),
      risk, high, rev: this.#rev + 1, canAccept: whole && input.canAccept, canText: whole && input.canText,
      deadlineMono, deadlineWall: this.#clock.nowWall() + this.#timeoutMs,
    });
    const timerId = `deadline:${approvalId}:0`;
    this.#clock.schedule({ timerId, class: 'deadline', clock: 'mono', due: deadlineMono });
    this.#open.set(approvalId, { view, answer: input.answer, timerId });
    this.#changed();
    return view;
  }

  get(approvalId: string): ApprovalView | null {
    return this.#open.get(approvalId)?.view ?? null;
  }

  /** The open entries, oldest first; of one session when `ownedId` is given. */
  list(ownedId?: string): ApprovalView[] {
    return [...this.#open.values()].map((e) => e.view).filter((v) => ownedId === undefined || v.ownedId === ownedId);
  }

  /** True while the list changed less than settleMs ago: no allow is taken then. */
  get settling(): boolean {
    return this.#changedMono !== null && this.#clock.nowMono() - this.#changedMono < this.#settleMs;
  }

  /** The person allows what the page showed: `digest` from the card, `rev` the list revision it was drawn from. */
  allow(approvalId: string, seen: { digest: string; rev: number }): ApprovalVerdict {
    const e = this.#open.get(approvalId);
    if (e === undefined) return 'approval-gone';
    if (seen.rev !== this.#rev || this.settling) return 'stale-view';
    // A card that offers no allow (too long, a question, a session-wide grant) is declined like a stale digest:
    // what would be allowed is not what the page could show.
    if (seen.digest !== e.view.digest || !e.view.canAccept) {
      this.#answer(e, { decision: 'decline' }, 'human');
      return 'digest-mismatch';
    }
    this.#answer(e, { decision: 'accept' }, 'human');
    return 'ok';
  }

  /** The person answers a question with one text, under the same digest and revision checks as allow. */
  answerText(approvalId: string, text: string, seen: { digest: string; rev: number }): ApprovalVerdict {
    const e = this.#open.get(approvalId);
    if (e === undefined) return 'approval-gone';
    if (seen.rev !== this.#rev || this.settling) return 'stale-view';
    if (seen.digest !== e.view.digest || !e.view.canText || typeof text !== 'string') {
      this.#answer(e, { decision: 'decline' }, 'human');
      return 'digest-mismatch';
    }
    this.#answer(e, { decision: 'text', text }, 'human');
    return 'ok';
  }

  /** The person declines: taken at once, whatever the revision. */
  deny(approvalId: string): ApprovalVerdict {
    const e = this.#open.get(approvalId);
    if (e === undefined) return 'approval-gone';
    this.#answer(e, { decision: 'decline' }, 'human');
    return 'ok';
  }

  /** Declines every open entry of a session (a stop of the turn, the end); the count declined. */
  declineOwned(ownedId: string, cause: 'interrupt' | 'end'): number {
    const mine = [...this.#open.values()].filter((e) => e.view.ownedId === ownedId);
    for (const e of mine) this.#answer(e, { decision: 'decline' }, cause);
    return mine.length;
  }

  /** Drops an entry nobody can answer any more (the child resolved it, or is gone); no answer is written. */
  forget(approvalId: string): boolean {
    const e = this.#open.get(approvalId);
    if (e === undefined) return false;
    this.#drop(e);
    this.#settled(e.view, { decision: 'dropped', cause: 'gone' });
    return true;
  }

  /** Drops every open entry of a session whose child is gone; the count dropped. */
  forgetOwned(ownedId: string): number {
    const mine = [...this.#open.values()].filter((e) => e.view.ownedId === ownedId);
    for (const e of mine) {
      this.#drop(e);
      this.#settled(e.view, { decision: 'dropped', cause: 'gone' });
    }
    return mine.length;
  }

  #answer(e: Entry, a: Answer, cause: AnswerCause): void {
    // Answered first, written after: a second answer finds nothing open.
    this.#drop(e);
    try {
      e.answer(a, cause);
    } catch {
      // The session writes the answer and notes its own failures (a child already gone, say); the
      // entry is answered either way, and a deadline that fires must not throw into the Clock.
    }
    this.#settled(e.view, { decision: a.decision, cause });
  }

  #settled(view: ApprovalView, outcome: ApprovalOutcome): void {
    try {
      this.#onSettled(view, Object.freeze(outcome));
    } catch {
      // A listener that throws must not undo an answer already written.
    }
  }

  #drop(e: Entry): void {
    this.#open.delete(e.view.approvalId);
    this.#clock.cancel(e.timerId);
    this.#changed();
  }

  #fired(f: Fired): void {
    for (const e of this.#open.values()) {
      if (e.timerId === f.timerId) {
        this.#answer(e, { decision: 'decline' }, 'clock');
        return;
      }
    }
  }

  #changed(): void {
    this.#rev++;
    this.#changedMono = this.#clock.nowMono();
    try {
      this.#onChange();
    } catch {
      // A listener that throws must not leave an entry half answered.
    }
  }
}
frozenClass(Approvals);
