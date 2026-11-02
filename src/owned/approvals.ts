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
//  - declining is taken at once, whatever the revision;
//  - an entry the page cannot show whole (tooLong), or whose kind has no allow (a question, an MCP
//    elicitation, a write grant for the rest of the session), offers only decline;
//  - each entry is answered once: its state turns answered before the answer is written to the child.
// Answers are only {accept} or {decline} (or, for a question, a text): never "for this session", never
// a rule that outlives the one request (the session maps them; codex-session.ts).

export const APPROVAL_LIMITS = frozen({
  /** Q4: an open approval is declined after 30 minutes. */
  timeoutMs: 30 * 60 * 1000,
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
  readonly canAccept: boolean;
  readonly canText: boolean;
  readonly deadlineMono: number;
  readonly deadlineWall: number;
};

export type ApprovalVerdict = 'ok' | 'approval-gone' | 'digest-mismatch' | 'stale-view';

type Entry = { view: ApprovalView; answer: ApprovalInput['answer']; timerId: string };

export type ApprovalsOptions = {
  /** The hub the composition root holds; the queue takes its own Clock from it. */
  hub: ClockHub;
  timeoutMs?: number;
  /** Hears every change of the list (the page's revision moved). */
  onChange?: () => void;
};

export class Approvals {
  readonly #open = new Map<string, Entry>();
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #onChange: () => void;
  #rev = 0;

  constructor(opts: ApprovalsOptions) {
    const timeoutMs = opts.timeoutMs ?? APPROVAL_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('approvals: timeoutMs must be a positive integer');
    this.#timeoutMs = timeoutMs;
    this.#onChange = opts.onChange ?? (() => {});
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
      risk, high, canAccept: whole && input.canAccept, canText: whole && input.canText,
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

  /** The person allows what the page showed: `digest` from the card, `rev` the list revision it was drawn from. */
  allow(approvalId: string, seen: { digest: string; rev: number }): ApprovalVerdict {
    const e = this.#open.get(approvalId);
    if (e === undefined) return 'approval-gone';
    if (seen.rev !== this.#rev) return 'stale-view';
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
    if (seen.rev !== this.#rev) return 'stale-view';
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
    return true;
  }

  /** Drops every open entry of a session whose child is gone; the count dropped. */
  forgetOwned(ownedId: string): number {
    const mine = [...this.#open.values()].filter((e) => e.view.ownedId === ownedId);
    for (const e of mine) this.#drop(e);
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
    try {
      this.#onChange();
    } catch {
      // A listener that throws must not leave an entry half answered.
    }
  }
}
frozenClass(Approvals);
