import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { frozen } from '../../shared/frozen.js';
import type { Log } from '../runtime/log.ts';

// The remembered browsers (2026-11-08: pair once). One correct console code (src/server/http.ts, POST
// /api/pair) pairs a browser for good: it gets the pairing cookie (sid) and the controller token, and
// both stay good across restarts of orchestrad and of the browser, until 90 days have passed, the
// browser forgets itself (POST /api/pair/forget), or 16 newer browsers pushed it out.
//
// What is kept, here and on disk: the sha256 of the sid and of the token, and when the pairing was
// made (the Clock's wall time). Never the sid or the token themselves, so the file buys nobody a
// cookie or a token. The token is compared in constant time over its digest. A token is good only with
// the sid it was handed out with, so a cookie alone (which a page on another port of
// orchestra.localhost also gets) still buys nothing an owned route answers.
//
// Persistence is injected (working.ts: ORCHESTRA_HOME\pairings.json, read through the read gate,
// written through the write fence); null keeps it in memory, for the tests that do not care. Every
// change is saved at once. A file that cannot be read or does not parse is logged (never its text)
// and treated as none remembered: the next browser pairs with a code, and the next save rewrites it.

/** Where working.ts keeps them, under ORCHESTRA_HOME (beside agent-port.token: state of this data dir, not of one run). */
export const PAIRINGS_FILE = 'pairings.json';
/** How long a pairing holds: 90 days, the cookie's Max-Age too. */
export const PAIRING_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** The most browsers remembered; the oldest pairing goes first. */
export const PAIRINGS_MAX = 16;

/** The pairing cookie: its name, the Set-Cookie of a new pairing, and the one that clears it. */
export const PAIR_COOKIE = 'orchestra_sid';
export const pairCookie = (sid: string): string => `${PAIR_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PAIRING_TTL_MS / 1000}`;
export const CLEAR_PAIR_COOKIE = `${PAIR_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

const HEX64 = frozen(/^[0-9a-f]{64}$/);
/** A sid and a token as pair() makes them: 32 random bytes, base64url (routes.ts CSRF_RE; not imported, so working.ts loads no route table for this). */
const TOKEN_RE = frozen(/^[A-Za-z0-9_-]{43}$/);

export type PairingsIo = {
  /** The saved text, or null when there is none yet; throws when it cannot be read. */
  load(): string | null;
  save(text: string): void;
};

export type Pairings = {
  /** How many browsers are remembered now. */
  readonly count: number;
  /** A new browser: its sid and its token (only in this reply, never kept as they are). */
  pair(): { sid: string; csrf: string };
  /** Is `sid` a remembered browser's (and not past 90 days)? */
  has(sid: string): boolean;
  /** Is `header` the token handed out with `sid`? Constant time over the digests. */
  holds(sid: string, header: unknown): boolean;
  /** Forgets the browser of `sid`; false when it was not remembered. */
  forget(sid: string): boolean;
};

type Entry = { readonly csrf: Buffer; readonly pairedAt: number };

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** The entries of a saved text (by sid digest, oldest first), or why there are none. */
function parse(text: string): Map<string, Entry> | 'bad-json' | 'bad-shape' {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return 'bad-json';
  }
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1 || !Array.isArray((v as { browsers?: unknown }).browsers)) return 'bad-shape';
  const rows: [string, Entry][] = [];
  for (const b of (v as { browsers: unknown[] }).browsers) {
    if (typeof b !== 'object' || b === null) return 'bad-shape';
    const { sidSha256: s, csrfSha256: c, pairedAt: at } = b as Record<string, unknown>;
    if (typeof s !== 'string' || !HEX64.test(s) || typeof c !== 'string' || !HEX64.test(c) || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return 'bad-shape';
    rows.push([s, { csrf: Buffer.from(c, 'hex'), pairedAt: at }]);
  }
  rows.sort((a, b) => a[1].pairedAt - b[1].pairedAt);
  return new Map(rows);
}

export function makePairings(opts: { nowWall: () => number; io: PairingsIo | null; log: Log }): Pairings {
  const { nowWall, io, log } = opts;
  let entries = new Map<string, Entry>();
  const dead = (e: Entry) => nowWall() - e.pairedAt > PAIRING_TTL_MS;

  const save = (): void => {
    if (io === null) return;
    const browsers = [...entries].map(([s, e]) => ({ sidSha256: s, csrfSha256: e.csrf.toString('hex'), pairedAt: e.pairedAt }));
    try {
      io.save(`${JSON.stringify({ v: 1, browsers })}\n`);
    } catch (e) {
      // Kept in memory: this boot still knows the browser; a restart asks it for a code again.
      log.warn('pairings-save-failed', { error: e });
    }
  };

  if (io !== null) {
    let text: string | null = null;
    try {
      text = io.load();
    } catch (e) {
      log.warn('pairings-unreadable', { why: 'read-failed', error: e });
    }
    if (text !== null) {
      const got = parse(text);
      if (typeof got === 'string') log.warn('pairings-unreadable', { why: got });
      else {
        entries = got;
        const before = entries.size;
        for (const [s, e] of entries) if (dead(e)) entries.delete(s);
        if (entries.size !== before) save();
      }
    }
    log.info('pairings', { remembered: entries.size });
  }

  /** The live entry of `sid`; a dead one is dropped (and saved) on the way. */
  const live = (sid: string): [string, Entry] | null => {
    if (typeof sid !== 'string' || !TOKEN_RE.test(sid)) return null;
    const key = digest(sid).toString('hex');
    const e = entries.get(key);
    if (e === undefined) return null;
    if (dead(e)) {
      entries.delete(key);
      save();
      return null;
    }
    return [key, e];
  };

  return Object.freeze({
    get count(): number {
      return entries.size;
    },
    pair(): { sid: string; csrf: string } {
      const sid = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      while (entries.size >= PAIRINGS_MAX) {
        let oldest: string | null = null;
        let at = Infinity;
        for (const [s, e] of entries) {
          if (e.pairedAt < at) {
            at = e.pairedAt;
            oldest = s;
          }
        }
        entries.delete(oldest!);
      }
      entries.set(digest(sid).toString('hex'), { csrf: digest(csrf), pairedAt: nowWall() });
      save();
      return { sid, csrf };
    },
    has: (sid: string): boolean => live(sid) !== null,
    holds(sid: string, header: unknown): boolean {
      if (typeof header !== 'string' || !TOKEN_RE.test(header)) return false;
      const e = live(sid);
      return e !== null && timingSafeEqual(e[1].csrf, digest(header));
    },
    forget(sid: string): boolean {
      const e = live(sid);
      if (e === null) return false;
      entries.delete(e[0]);
      save();
      return true;
    },
  });
}
