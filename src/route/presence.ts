import { frozen } from '../../shared/frozen.js';

// Whether you are here (r4 Q-P3, settled 2026-10-28: 在场 = a UI heartbeat and a UI action within 30 minutes; the 30 is
// r4's own assumption). The only reader is the dispatch permission (src/route/dispatch.ts): r4 D20 says no new execution
// task goes out while you are away, so a session's 直接派出 holds only while you are present.
//
// The heartbeat is an unlocked page's read of GET /api/owned (src/server/owned.ts): 2 s while it is in front, 10 s while
// hidden, and a hidden page counts, as r4 has it (§8.9: the gate closes while the heartbeat goes on, because the action
// is what tells). The action is any human record of the owned API; a page that only reads never is one. r4's way of telling
// you worked in a terminal or an IDE does not exist here: this is the page alone, so a person busy elsewhere for 30
// minutes reads as away, the safe side.
//
// unknown: no page was heard since orchestrad started. It is not told from away for the permission (both go back to 派前问你),
// only for the words: nobody knows whether you are there. Nothing here outlives a restart.

export const PRESENCE_LIMITS = frozen({
  /** No heartbeat for this long is away: three of a hidden page's polls. */
  beatMs: 30_000,
  /** No action for this long is away (r4 Q-P3). */
  actionMs: 30 * 60 * 1000,
});

export type Presence = 'present' | 'away' | 'unknown';

export type PresenceWatch = {
  /** An unlocked page read the list. */
  beat(): void;
  /** A person's action was recorded. */
  acted(): void;
  state(): Presence;
};

export function makePresence(deps: { nowMono(): number }): PresenceWatch {
  let beatAt: number | null = null;
  let actedAt: number | null = null;
  return Object.freeze({
    beat(): void {
      beatAt = deps.nowMono();
    },
    acted(): void {
      actedAt = deps.nowMono();
    },
    state(): Presence {
      if (beatAt === null) return 'unknown';
      const now = deps.nowMono();
      return now - beatAt <= PRESENCE_LIMITS.beatMs && actedAt !== null && now - actedAt <= PRESENCE_LIMITS.actionMs ? 'present' : 'away';
    },
  });
}
