// Every way orchestrad ends on its own, one code per meaning (P1). Node exits by itself with 1, 3-7,
// 9, 10, 12, 13, 14 and above 128 (an uncaught error, a V8 out-of-memory, a bad flag, a signal), so
// every typed code lives in 20-29 and no exit of Node's own reads as one of these. boot.ts reads this
// before the import fence is in place, so this module imports nothing.

export const EXIT = {
  /** A clean stop after a signal. */
  ok: 0,
  /** Running at High integrity or above: the plan refuses before reading anything. */
  elevated: 20,
  /** A core feature is missing: node:sqlite, type stripping, or module.registerHooks (no import fence). */
  missingFeatures: 21,
  /** ui-only has no HTTP UI to serve until step 4, so for now it reports and exits. */
  uiOnly: 22,
  lockHeld: 23,
  /** The arguments were refused, or the real profile was started under the test runner. */
  badArgs: 24,
  /** A typed startup stage failed: gates, lock or data dir. */
  startFailed: 25,
  /** Anything thrown that no stage typed: a bug or an unexpected environment. */
  crashed: 26,
} as const;
