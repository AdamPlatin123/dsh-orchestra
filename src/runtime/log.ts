// orchestrad's diagnostic log: a bounded in-memory ring (what Tuning shows, and all a ui-only
// process ever keeps) plus an optional line sink that working mode points at run/orchestrad.log
// through the write fence. Every field is scrubbed on the way in (plan §6 invariant 14): secrets by
// key name, `token=` values in any string, control characters, and strings over 2 KB.

import { ownFields } from './own.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The human-facing console, apart from the log: status lines on out, refusals on err. */
export type ConsolePort = { out(line: string): void; err(line: string): void };

export type LogEntry = {
  seq: number;
  at: string;
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
};

export type LogConfig = {
  now?: () => number;
  /** Entries kept in memory; the oldest go first. */
  capacity?: number;
  sink?: (line: string) => void;
};

export const MAX_STRING = 2048;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;
const DEFAULT_CAPACITY = 500;
export const REDACTED = '***';

/** Field names whose values never reach the log, whatever they hold. */
export const SECRET_KEY = /^(?:code|pairing[-_]?code|.*token|.*secret|password|passwd|.*cookie|csrf.*|authorization|.*api[-_]?key|credentials?)$/i;

const EVENT = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// C0, DEL and C1, ESC included: a harness string must not drive the console (OSC 8, OSC 52).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TOKEN_PARAM = /(token=)[^&\s"'<>]*/gi;
const BEARER = /(bearer\s+)[^\s"'<>]+/gi;

export function scrubString(s: string): string {
  const clean = s.replace(TOKEN_PARAM, `$1${REDACTED}`).replace(BEARER, `$1${REDACTED}`).replace(CONTROL, '?');
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[+${clean.length - MAX_STRING}]` : clean;
}

/** A JSON-safe copy of `v` with secrets, control characters and oversize parts removed. */
export function scrubValue(v: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return scrubString(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'undefined') return null;
  if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
  if (seen.has(v)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(v);
  try {
    if (v instanceof Error) {
      const code = (v as { code?: unknown }).code;
      return { name: scrubString(v.name), message: scrubString(v.message), ...(code !== undefined ? { code: scrubValue(code, depth + 1, seen) } : {}) };
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ITEMS).map((x) => scrubValue(x, depth + 1, seen));
      return v.length > MAX_ITEMS ? [...items, `[+${v.length - MAX_ITEMS}]`] : items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      out[scrubString(k)] = SECRET_KEY.test(k) ? REDACTED : scrubValue(x, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

export class Log {
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #ring: LogEntry[] = [];
  #sink: ((line: string) => void) | null;
  #seq = 0;
  #dropped = 0;
  #sinkFailures = 0;

  constructor(config: LogConfig = {}) {
    // Own fields only: a sink nobody set is never one some module put on Object.prototype.
    const cfg = ownFields(config, ['now', 'capacity', 'sink'] as const);
    this.#now = cfg.now ?? Date.now;
    this.#capacity = Math.max(1, cfg.capacity ?? DEFAULT_CAPACITY);
    this.#sink = cfg.sink ?? null;
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.#add('debug', event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.#add('info', event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.#add('warn', event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.#add('error', event, fields);
  }

  entries(): readonly LogEntry[] {
    return [...this.#ring];
  }

  /** Entries that fell out of the ring. */
  dropped(): number {
    return this.#dropped;
  }

  sinkFailures(): number {
    return this.#sinkFailures;
  }

  /** Sends what the ring still holds to `sink`, then every later entry. */
  attach(sink: (line: string) => void): void {
    this.#sink = sink;
    for (const e of this.#ring) this.#emit(e);
  }

  /** Later entries stay in the ring only; working mode calls this before it gives up the lock. */
  detach(): void {
    this.#sink = null;
  }

  #add(level: LogLevel, event: string, fields: Record<string, unknown> | undefined): void {
    const scrubbed = fields === undefined ? {} : scrubValue(fields);
    const entry: LogEntry = {
      seq: ++this.#seq,
      at: new Date(this.#now()).toISOString(),
      level,
      event: EVENT.test(event) ? event : 'invalid-event-name',
      fields: typeof scrubbed === 'object' && scrubbed !== null && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : {},
    };
    this.#ring.push(entry);
    if (this.#ring.length > this.#capacity) {
      this.#ring.shift();
      this.#dropped++;
    }
    this.#emit(entry);
  }

  // A failing sink never takes the caller down: the entry stays in the ring and the failure is counted.
  #emit(entry: LogEntry): void {
    if (this.#sink === null) return;
    try {
      this.#sink(`${JSON.stringify(entry)}\n`);
    } catch {
      this.#sinkFailures++;
    }
  }
}
