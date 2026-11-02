import type { OwnedSeat } from '../sources/tower.ts';
import type { ClaudeSession } from './claude-session.ts';
import type { CodexSession } from './codex-session.ts';
import type { OwnedRecord, OwnedRegistry } from './registry.ts';
import { recentOf } from './codex-owned.ts';
import { afterRestart } from './registry.ts';

// The sessions an earlier orchestrad left, for a harness that is off in this one (orchestra app plan
// §2, "自有会话跨重启"). When a harness is on, its manager (codex-owned.ts, claude-owned.ts) lists its
// own records again at start; when it is off (Claude's SDK missing, its host changed, codex.exe not
// found, a setup that failed), nobody would read them, and a session that was still running when the
// old orchestrad went would vanish from the page instead of showing as unknown (T1: not knowing is
// said, never left out). Here they are listed read only: no child, nothing sent, send and end refused
// as for any restored session; one that had not ended is unknown with endReason daemon-restart, and
// its registry entry says so from now on (the same afterRestart the managers apply).

/** How many records of one harness are listed again (the managers' own `ended` bound). */
export const RESTORED_KEEP = 50;

type AnySession = CodexSession | ClaudeSession;

export type RestoredOwned = {
  readonly harness: 'codex' | 'claude';
  /** How many sessions it lists. */
  readonly restored: number;
  get(ownedId: string): AnySession | null;
  list(): AnySession[];
  meta(ownedId: string): { readonly title: string; readonly createdAt: number } | null;
  towerSeats(): OwnedSeat[];
};

/**
 * The records of `harness` the registry holds, listed read only; `make` builds the restored session of
 * that harness (codex-owned.ts or claude-owned.ts restoredSession). A registry that cannot be read lists none.
 */
export function restoredOwned(harness: 'codex' | 'claude', registry: OwnedRegistry, now: () => number, make: (r: OwnedRecord, now: () => number) => AnySession): RestoredOwned {
  let all: OwnedRecord[];
  try {
    all = registry.load().filter((r) => r.harness === harness);
  } catch {
    all = [];
  }
  const sessions = new Map<string, AnySession>();
  const meta = new Map<string, { title: string; createdAt: number }>();
  for (const was of all.slice(-RESTORED_KEEP)) {
    const r = afterRestart(was);
    if (r !== was) {
      try {
        registry.save(r);
      } catch {
        // The page still says unknown; the file says it again at the next start.
      }
    }
    sessions.set(r.ownedId, make(r, now));
    meta.set(r.ownedId, Object.freeze({ title: r.title, createdAt: r.createdAt }));
  }
  return Object.freeze({
    harness,
    restored: sessions.size,
    get: (ownedId: string) => sessions.get(ownedId) ?? null,
    list: () => [...sessions.values()],
    meta: (ownedId: string) => meta.get(ownedId) ?? null,
    towerSeats: (): OwnedSeat[] => [...sessions.values()].map((s) => ({
      ownedId: s.ownedId, harness, title: meta.get(s.ownedId)?.title ?? '', state: s.state, endReason: s.endReason,
      waiting: null, lastAt: s.feed.lastAt, recent: recentOf(s.feed),
    })),
  });
}
