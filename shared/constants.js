// @ts-check
// Numbers the daemon and the page share, each with where it comes from (plan step 3; UI design 一). A
// value changes only with the decision it cites. Plain ESM without imports, like shared/protocol.js.

/** A reminder's own text, in code points; longer is 422 text-too-long, never cut short (UI design 一 2). */
export const REMINDER_TEXT_MAX = 120;

/** One snippet, in UTF-8 bytes (r4 §5.3 rule 5, plan step 3 snippets.ts). */
export const SNIPPET_MAX_BYTES = 2048;

/** Snippet time to live: 14 days (r4 §6.1 #2). Pinned reminder texts are exempt until they fire or are cancelled. */
export const SNIPPET_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** A source string kept in a journal body (cwd, version, tool name, error code), in characters (plan step 3 journal.ts). */
export const JOURNAL_STRING_MAX = 128;

/** A brake plan is valid this long on the monotonic clock, and until its wall-clock expiresAt, whichever comes first (plan step 3, P4). */
export const PLAN_TTL_MS = 60_000;

/** A notify attempt's window: a dispatched ack with no error inside it sets notifiedAt (D-15). */
export const ACK_WINDOW_MS = 1500;

/** The SSE tick (代-13). */
export const TICK_MS = 5000;

/** No frame for this long and the page shows its data as stale (代-13, 4 × TICK_MS). */
export const STALE_MS = 20_000;

/** Items in one snapshot; the rest are counted in `clipped` (UI design 一 1). */
export const ITEMS_MAX = 500;

/** Ended items in one snapshot (UI design 一 1). */
export const ENDED_MAX = 20;

/** Action outcomes in one snapshot, read from the journal's tail of human.result records (UI design 一 1). */
export const RECENT_ACTIONS_MAX = 64;

/** Project hues are 0 to HUE_COUNT - 1 (UI design 一 2). */
export const HUE_COUNT = 12;
