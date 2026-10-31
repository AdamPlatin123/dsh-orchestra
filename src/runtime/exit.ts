// Every way orchestrad ends on its own, one code per meaning (P1). boot.ts reads this before the
// import fence is in place, so this module imports nothing.

export const EXIT = {
  /** A clean stop after a signal. */
  ok: 0,
  /** Fixed by the plan; it is also Node's own code for an uncaught error, which is why `crashed` exists. */
  elevated: 1,
  missingFeatures: 2,
  /** ui-only has no HTTP UI to serve until step 4, so for now it reports and exits. */
  uiOnly: 3,
  lockHeld: 4,
  badArgs: 5,
  /** A typed startup stage failed: gates, lock or data dir. */
  startFailed: 6,
  /** Anything thrown that no stage typed: a bug or an unexpected environment. */
  crashed: 7,
} as const;
