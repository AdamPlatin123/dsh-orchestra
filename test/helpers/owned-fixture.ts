// The owned list and its parts as tests build them (GET /api/owned, shared/owned-contract.js validateOwnedList), and
// the tower's seats (src/sources/tower.ts OwnedSeat). Each default passes the contract, so a field it gains is added
// here once, not in every test that builds one (questions, 2026-11-08). A test names what it is about as overrides.
// Synthetic data only.
import type { OwnedSeat } from '../../src/sources/tower.ts';

type Json = Record<string, any>;

export const OWNED_ID = 'a'.repeat(20);
export const APPROVAL_ID = 'b'.repeat(32);

/** An open approval: a high-risk command shown whole, on OWNED_ID, its digest one of 'c'. */
export const approvalOf = (over: Json = {}): Json => ({
  approvalId: APPROVAL_ID, ownedId: OWNED_ID, kind: 'command', title: 'req', preview: 'command: npm test', tooLong: false, redactions: 0,
  digest: 'c'.repeat(64), risk: 'shell', high: true, tainted: false, origin: null, rev: 1, canAccept: true, canText: false, questions: null, deadline: 0, ...over,
});

/** A session of the list: Codex, running, nothing open, no Job of its own, no dispatch tool, where it works not known. */
export const ownedOf = (over: Json = {}): Json => ({
  ownedId: OWNED_ID, harness: 'codex', model: 'codex/gpt-6.1-sol', title: 't', state: 'running', endReason: null, waiting: null, queued: 0, tokens: null,
  lastSeq: 1, createdAt: 1, brake: false, stoppable: false, cwd: null, dispatch: null, frontDesk: false, ...over,
});

/** The list: on, Codex only, no project root, empty (a list that holds a running session says so in its limits). */
export const ownedListOf = (over: Json = {}): Json => ({
  v: 1, kind: 'owned-list', rev: 1, enabled: true, disabledWhy: null, brakeWhy: null, harnesses: { codex: true, claude: false }, roots: [],
  owned: [], approvals: [], limits: { maxOwned: 4, active: 0 }, requests: [], requestedGone: [], sentGone: [], presence: 'unknown',
  frontDesk: { on: false, ownedId: null, model: 'zcode/GLM-5.3-Flash', tools: null }, ...over,
});

/** A seat of the tower: Codex, running, nothing open, no feed event yet. */
export const seatOf = (over: Partial<OwnedSeat> = {}): OwnedSeat => ({
  ownedId: OWNED_ID, harness: 'codex', title: 't', state: 'running', endReason: null, waiting: null, lastAt: null, ...over,
});
