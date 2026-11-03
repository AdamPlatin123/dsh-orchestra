import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import { pathKey } from '../fs/paths.ts';
import { ReadGateError } from '../fs/read-gate.ts';
import { FrameError, decodeFrame, decodePrefix, walkFrames } from '../lib/zstd/frames.ts';
import { frozen } from '../../shared/frozen.js';

// The thin slice ahead of plan steps 9-11: list the Claude transcripts, DSH v4 logs and Codex rollouts under the
// harness roots and show the last events of one, read-only, for the peek page (src/server/http.ts).
// Every read goes through the read gate: 'r' only, closed as soon as the read is done, no tail handle
// held, so nothing here keeps a file open that its harness may replace (plan §6 invariant 4). Nothing
// is kept: no cursor, no journal, no db. Every string that leaves comes from the source, so it is
// cleaned of control characters, run through the redactor, and clipped to one field's size.
// Steps 9-11 replace the readers (cursors, normalization, the hot set); step 5 replaces the page.

export type PeekHarness = 'claude' | 'dsh' | 'codex';

export type PeekSession = {
  /** Opaque: a digest of the file's path. The page names a session by it, never by a path. */
  id: string;
  harness: PeekHarness;
  /** The project directory's name as the harness wrote it (cleaned and clipped). */
  project: string;
  file: string;
  size: number;
  mtimeMs: number;
};

export type PeekEvent = { at: string | null; type: string; text: string };

export type PeekView = {
  session: PeekSession;
  events: PeekEvent[];
  /** Lines that were no JSON object, counted, never shown. */
  unparsed: number;
  /** Why fewer events than the file holds may show, or null. */
  note: 'tail-only' | 'too-large' | 'bad-frame' | 'unfinished-frame' | null;
};

export const PEEK_LIMITS = frozen({
  /**
   * Sessions the list shows, newest first, shared between the harnesses (each gets a floor; see fairShare).
   * The list is cut before any file is read, so only a wait the Claude registry reports can pin a session
   * here: a Codex session that may wait on you (inferred from its rollout) ages like any other and can
   * fall out of the list; the tower's about view says so. A Codex or DSH subagent is a session file of its
   * own and takes a place here; a Claude subagent does not (it lives under its parent's transcript).
   */
  sessions: 60,
  /** Events a session view shows: the last ones. */
  events: 200,
  /** A Claude transcript is read from its end: this many bytes at most. */
  claudeTailBytes: 256 * 1024,
  /** A DSH log is walked from byte 0 (frame boundaries are known only from the start); larger ones are not read. */
  dshMaxBytes: 32 * 1024 * 1024,
  /** A DSH log's decoded text over all its frames; past it the walk stops with note too-large. */
  dshMaxDecodedBytes: 4 * 32 * 1024 * 1024,
  /** One shown field, in UTF-16 code units (plan step 5's 2 KB per field). */
  fieldChars: 2048,
  /** A plain Codex rollout past this size is read as its first line (session_meta) and its last codexTailBytes. */
  codexTailBytes: 256 * 1024,
  /** The bytes a Codex rollout's first line is looked for in (a plain file), or decoded from (a .zst past codexMaxBytes). */
  codexHeadBytes: 256 * 1024,
  /** What those head bytes of a .zst may decode to; past it the head is not read. */
  codexHeadDecodedBytes: 4 * 1024 * 1024,
  /** A Codex .zst rollout (one frame of the whole session) is decoded whole only up to this size; past it, its head only. */
  codexMaxBytes: 32 * 1024 * 1024,
  /** What a Codex rollout may decode to (a .zst whole); past it, its head only, noted too-large. */
  codexMaxDecodedBytes: 16 * 1024 * 1024,
});

/**
 * Source text to its shown form. `as = 'name'` marks a directory's name (a lane's, from a cwd): a name
 * made of words and short tags then passes the entropy rule (src/store/redact.ts, RedactInput.name).
 */
export type Redact = (text: string, as?: 'name') => string;

const win = path.win32;
const UUID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DSH_LOG = 'session.v4.jsonl.zstd';
const ROLLOUT = /^rollout-[^\\/]*\.jsonl(?:\.zst)?$/i;
/** Codex names a session's file by its start time and thread id; archiving moves it, compressing renames it. */
const rolloutKey = (name: string) => name.toLowerCase().replace(/\.zst$/, '');
// C0 and C1 controls but tab and newline, DEL, and the bidi embeddings, overrides and isolates.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** At most `n` UTF-16 code units, never ending on half a surrogate pair. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\ud800-\udbff]$/.test(cut) ? `${cut.slice(0, -1)}…` : `${cut}…`;
}

/**
 * Source text as it may be shown: a bounded slice, redacted, cleaned, clipped to one field. The stage
 * preview (src/sources/stage.ts) sends every source string through it too.
 */
export function shown(raw: string, redact: Redact, n: number = PEEK_LIMITS.fieldChars): string {
  return clip(redact(clip(raw, n * 4)).replace(CONTROLS, ''), n);
}

function idOf(file: string): string {
  return createHash('sha256').update(pathKey(file)).digest('hex').slice(0, 20);
}

/** The gate's answer, or `fallback` when it refuses (a missing directory, a denied name, a link). */
function tryGate<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof ReadGateError) return fallback;
    throw e;
  }
}

function session(harness: PeekHarness, project: string, file: string, gate: ReadGate, redact: Redact): PeekSession | null {
  const st = tryGate(() => gate.stat(file), null);
  if (st === null || !st.isFile()) return null;
  return { id: idOf(file), harness, project: shown(project, redact, 120), file, size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
}

/**
 * Every Claude transcript (`projects/<dir>/<uuid>.jsonl`), DSH v4 log and Codex rollout
 * (`sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` and `archived_sessions/rollout-*`) under one root. A
 * Codex session found twice (plain and compressed, or live and archived) is listed once: its newest file.
 */
function walkRoot(gate: ReadGate, root: HarnessRoot, redact: Redact): PeekSession[] {
  const out: PeekSession[] = [];
  const add = (s: PeekSession | null) => {
    if (s !== null) out.push(s);
  };
  if (root.kind === 'claude') {
    const projects = win.join(root.path, 'projects');
    for (const dir of tryGate(() => gate.subdirs(projects), [])) {
      for (const name of tryGate(() => gate.readdir(win.join(projects, dir)), [])) {
        if (/\.jsonl$/i.test(name)) add(session('claude', dir, win.join(projects, dir, name), gate, redact));
      }
    }
  } else if (root.kind === 'dsh') {
    const sessions = win.join(root.path, 'sessions');
    for (const dir of tryGate(() => gate.subdirs(sessions), [])) {
      if (!/^--.*--$/.test(dir)) continue;
      for (const sub of tryGate(() => gate.subdirs(win.join(sessions, dir)), [])) {
        if (UUID.test(sub)) add(session('dsh', dir, win.join(sessions, dir, sub, DSH_LOG), gate, redact));
      }
    }
  } else if (root.kind === 'codex') {
    const byName = new Map<string, PeekSession>();
    const rollout = (dir: string) => {
      for (const name of tryGate(() => gate.readdir(dir), [])) {
        if (!ROLLOUT.test(name)) continue;
        // No project directory: Codex keeps the cwd inside the file, read by the stage digest.
        const s = session('codex', 'codex', win.join(dir, name), gate, redact);
        if (s === null) continue;
        const had = byName.get(rolloutKey(name));
        if (had === undefined || had.mtimeMs < s.mtimeMs) byName.set(rolloutKey(name), s);
      }
    };
    const sessions = win.join(root.path, 'sessions');
    for (const y of tryGate(() => gate.subdirs(sessions), [])) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const m of tryGate(() => gate.subdirs(win.join(sessions, y)), [])) {
        if (!/^\d{2}$/.test(m)) continue;
        for (const d of tryGate(() => gate.subdirs(win.join(sessions, y, m)), [])) if (/^\d{2}$/.test(d)) rollout(win.join(sessions, y, m, d));
      }
    }
    rollout(win.join(root.path, 'archived_sessions'));
    out.push(...byName.values());
  }
  return out;
}

function walkAll(gate: ReadGate, roots: readonly HarnessRoot[], redact: Redact): PeekSession[] {
  const byId = new Map<string, PeekSession>();
  for (const root of roots) for (const s of walkRoot(gate, root, redact)) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}

/**
 * The first `n` of `xs` (already in order), but every item `pinned` holds is kept first, whatever its
 * place; what is kept stays in the order of `xs`.
 */
export function keepPinned<T>(xs: readonly T[], n: number, pinned?: (x: T) => boolean): T[] {
  if (pinned === undefined) return xs.slice(0, n);
  const keep = new Set(xs.filter(pinned).slice(0, n));
  for (const x of xs) {
    if (keep.size >= n) break;
    keep.add(x);
  }
  return xs.filter((x) => keep.has(x));
}

/**
 * At most `n` of `xs` (already in order, newest first), shared fairly between the groups `groupOf`
 * names, so one busy source cannot push the others out: every item `pinned` holds first (up to n), then
 * each group up to its floor (n split evenly over the groups present, pinned ones counted in), then the
 * rest in the order of `xs`. What is kept stays in the order of `xs`.
 */
export function fairShare<T>(xs: readonly T[], n: number, groupOf: (x: T) => string, pinned?: (x: T) => boolean): T[] {
  const keep = new Set<T>(pinned === undefined ? [] : xs.filter(pinned).slice(0, Math.max(0, n)));
  const groups = new Map<string, T[]>();
  for (const x of xs) {
    const g = groupOf(x);
    const members = groups.get(g);
    if (members === undefined) groups.set(g, [x]);
    else members.push(x);
  }
  const floor = groups.size === 0 ? 0 : Math.floor(n / groups.size);
  for (const members of groups.values()) {
    let have = members.filter((x) => keep.has(x)).length;
    for (const x of members) {
      if (have >= floor || keep.size >= n) break;
      if (keep.has(x)) continue;
      keep.add(x);
      have++;
    }
  }
  for (const x of xs) {
    if (keep.size >= n) break;
    keep.add(x);
  }
  return xs.filter((x) => keep.has(x));
}

export type SessionList = {
  /** At most PEEK_LIMITS.sessions, newest first, shared between the harnesses by fairShare(). */
  sessions: PeekSession[];
  /** Every session under the roots, before the cut. */
  total: number;
  /** The same, per harness: what the source holds, not what the list shows (T1). */
  totals: Record<PeekHarness, number>;
};

/**
 * The sessions under the roots, newest first, at most PEEK_LIMITS.sessions of them, shared fairly
 * between the harnesses (fairShare). A session `pinned` holds is listed whatever its age (the stage
 * pins the ones its registry says wait on you).
 */
export function listSessions(gate: ReadGate, roots: readonly HarnessRoot[], redact: Redact, pinned?: (s: PeekSession) => boolean): SessionList {
  const all = walkAll(gate, roots, redact);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totals: Record<PeekHarness, number> = { claude: 0, dsh: 0, codex: 0 };
  for (const s of all) totals[s.harness]++;
  return { sessions: fairShare(all, PEEK_LIMITS.sessions, (s) => s.harness, pinned), total: all.length, totals };
}

/** The session with this id, looked up afresh: the page can name only what the roots hold now. */
export function findSession(gate: ReadGate, roots: readonly HarnessRoot[], redact: Redact, id: string): PeekSession | null {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  return walkAll(gate, roots, redact).find((s) => s.id === id) ?? null;
}

/** Epoch milliseconds from a source timestamp (ISO text or epoch milliseconds), or null. A parse, never a clock read. */
export function sourceMs(v: unknown): number | null {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? ms : null;
}

/** An ISO time from a source timestamp, or null. */
function isoOf(v: unknown): string | null {
  const ms = sourceMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The readable part of one Claude content block. */
function claudeBlock(b: unknown, redact: Redact): string {
  if (typeof b === 'string') return b;
  if (!isObject(b)) return '';
  switch (own(b, 'type')) {
    case 'text':
      return str(own(b, 'text'));
    case 'thinking':
    case 'redacted_thinking':
      return '[thinking]';
    case 'tool_use': {
      let input = '';
      try {
        input = JSON.stringify(own(b, 'input')) ?? '';
      } catch {
        input = '';
      }
      // Redacted before it is clipped: a secret the cut ran through would leave its prefix unredacted.
      return `[tool_use ${str(own(b, 'name'))}] ${shown(input, redact, 600)}`;
    }
    case 'tool_result': {
      const c = own(b, 'content');
      const body = Array.isArray(c) ? c.map((x) => claudeBlock(x, redact)).join('\n') : str(c);
      return `[tool_result] ${body}`;
    }
    case 'image':
      return '[image]';
    default:
      return '';
  }
}

/** One transcript line, or null when it is no JSON object. */
export function claudeEvent(line: string, redact: Redact): PeekEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  const type = str(own(o, 'type'));
  let text = '';
  const message = own(o, 'message');
  if ((type === 'user' || type === 'assistant') && isObject(message)) {
    const content = own(message, 'content');
    text = Array.isArray(content) ? content.map((x) => claudeBlock(x, redact)).filter((s) => s !== '').join('\n') : str(content);
  } else if (type === 'summary') {
    text = str(own(o, 'summary'));
  } else if (type === 'system') {
    text = str(own(o, 'content'));
  }
  return { at: isoOf(own(o, 'timestamp')), type: shown(type || '?', redact, 64), text: shown(text, redact) };
}

/** `key: value` for the string, number and boolean leaves of a DSH event's data, depth first, bounded. */
function leaves(v: unknown, at: string, out: string[], budget: { chars: number }, depth: number, skip: RegExp | null = null): void {
  if (budget.chars <= 0 || depth > 6) return;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const line = at === '' ? String(v) : `${at}: ${String(v)}`;
    out.push(line);
    budget.chars -= line.length;
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => leaves(x, `${at}[${i}]`, out, budget, depth + 1, skip));
    return;
  }
  if (isObject(v)) for (const k of Object.keys(v)) if (skip === null || !skip.test(k)) leaves(v[k], at === '' ? k : `${at}.${k}`, out, budget, depth + 1, skip);
}

/** One DSH log line (`{type, seq, time, data}`), or null when it is no JSON object. */
export function dshEvent(line: string, redact: Redact): PeekEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  const out: string[] = [];
  leaves(own(o, 'data'), '', out, { chars: PEEK_LIMITS.fieldChars * 4 }, 0);
  const seq = own(o, 'seq');
  const type = `${typeof seq === 'number' ? `#${seq} ` : ''}${str(own(o, 'type')) || '?'}`;
  return { at: isoOf(own(o, 'time')), type: shown(type, redact, 64), text: shown(out.join('\n'), redact) };
}

/** Keys whose values are paths in Codex events (cwd, workdir, workspace_roots, writable_roots, agent_path...). */
const CODEX_PATH_KEYS = /cwd|dir|path|root|instructions/i;

/** The readable part of a Codex response item's content: its text blocks. */
function codexContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (isObject(b) ? str(own(b, 'text')) : '')).filter((t) => t !== '').join('\n');
}

/** One Codex rollout line (`{timestamp, type, payload}`), or null when it is no JSON object. */
export function codexEvent(line: string, redact: Redact): PeekEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  const type = str(own(o, 'type')) || '?';
  const p = isObject(own(o, 'payload')) ? (own(o, 'payload') as Record<string, unknown>) : {};
  const sub = str(own(p, 'type'));
  let text = '';
  if (type === 'session_meta') {
    // Not its base instructions, nor its cwd (an absolute path): the id and what started it.
    const source = own(p, 'source');
    text = [`id: ${str(own(p, 'id'))}`, `source: ${typeof source === 'string' ? source : isObject(source) ? Object.keys(source).join(',') : ''}`].join('\n');
  } else if (sub === 'message' || sub === 'agent_message') {
    text = `${str(own(p, 'role'))}: ${codexContent(own(p, 'content'))}`;
  } else if (sub === 'function_call' || sub === 'custom_tool_call') {
    const args = own(p, 'arguments') ?? own(p, 'input');
    // Redacted before it is clipped: a secret the cut ran through would leave its prefix unredacted.
    text = `[${sub} ${str(own(p, 'name'))}] ${typeof args === 'string' ? shown(args, redact, 600) : ''}`;
  } else if (sub === 'function_call_output' || sub === 'custom_tool_call_output') {
    const out = own(p, 'output');
    text = `[output] ${typeof out === 'string' ? out : isObject(out) ? str(own(out, 'content')) : ''}`;
  } else if (sub === 'reasoning') {
    text = '[reasoning]';
  } else {
    const out: string[] = [];
    // Settings and events carry the cwd, workspace roots and sandbox paths: no path-like key is shown.
    leaves(p, '', out, { chars: PEEK_LIMITS.fieldChars * 4 }, 0, CODEX_PATH_KEYS);
    text = out.join('\n');
  }
  return { at: isoOf(own(o, 'timestamp')), type: shown(sub === '' ? type : `${type}:${sub}`, redact, 64), text: shown(text, redact) };
}

export type PeekNote = NonNullable<PeekView['note']>;

/**
 * Hands every whole line of a session to `each`, in file order, read once through the gate: a Claude
 * transcript's last PEEK_LIMITS.claudeTailBytes, a Codex rollout as codexLines() says, a DSH log frame by frame from byte 0 (none past
 * PEEK_LIMITS.dshMaxBytes, and no more decoded text than `decoded` bytes: each frame is decoded with
 * what is left of it as its ceiling, so a frame that claims a huge size cannot grow past it). Returns
 * why fewer lines than the file holds may have come, or null.
 */
function eachLine(gate: ReadGate, s: PeekSession, each: (line: string) => void, decoded: number = PEEK_LIMITS.dshMaxDecodedBytes): PeekNote | null {
  let note: PeekNote | null = null;
  if (s.harness === 'codex') return codexLines(gate, s, each, Math.min(decoded, PEEK_LIMITS.codexMaxDecodedBytes));
  if (s.harness === 'claude') {
    const start = Math.max(0, s.size - PEEK_LIMITS.claudeTailBytes);
    const text = gate.readRange(s.file, start, s.size - start).toString('utf8');
    const lines = text.split('\n');
    // A read from the middle starts inside a line; the last line may still be half written.
    if (start > 0) {
      lines.shift();
      note = 'tail-only';
    }
    if (!text.endsWith('\n')) lines.pop();
    for (const line of lines) each(line);
    return note;
  }
  if (s.size > PEEK_LIMITS.dshMaxBytes) return 'too-large';
  const b = boundedRead(gate, s, PEEK_LIMITS.dshMaxBytes);
  return b === null ? 'too-large' : frameLines(b, each, decoded).note;
}

/**
 * A file read from byte 0, never more than `max` bytes: the size the listing saw, plus one byte that
 * tells a file grown since then; null when that is past `max`. The bound holds whatever the file
 * became between the listing and the read (the gate checks only that it opened the file it decided on).
 */
function boundedRead(gate: ReadGate, s: PeekSession, max: number): Buffer | null {
  const b = gate.readRange(s.file, 0, Math.min(s.size, max) + 1);
  return b.length > max ? null : b;
}

const tooLarge = (e: unknown) => e instanceof RangeError && (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';

/**
 * Every line of every complete frame of `b`, frame by frame, no more decoded text than `decoded` bytes
 * (each frame is decoded with what is left as its ceiling). `lines` counts the lines handed over.
 */
function frameLines(b: Buffer, each: (line: string) => void, decoded: number): { note: PeekNote | null; lines: number } {
  let note: PeekNote | null = null;
  let lines = 0;
  let walked: ReturnType<typeof walkFrames>;
  try {
    walked = walkFrames(b);
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
    return { note: 'bad-frame', lines };
  }
  let left = decoded;
  for (const f of walked.frames) {
    if (f.skippable) continue;
    if (left <= 0) {
      note = 'too-large';
      break;
    }
    let text: string;
    try {
      const out = decodeFrame(b, f, left);
      left -= out.length;
      text = out.toString('utf8');
    } catch (e) {
      note = tooLarge(e) ? 'too-large' : 'bad-frame';
      break;
    }
    for (const line of text.split('\n')) {
      lines++;
      each(line);
    }
  }
  if (note === null && walked.next < b.length) note = 'unfinished-frame';
  return { note, lines };
}

/** A zlib error (Z_DATA_ERROR, Z_BUF_ERROR...): bytes that are no zstd, or end too soon. */
const isZlibError = (e: unknown) => e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && /^Z_/.test((e as { code: string }).code);

/**
 * A Codex rollout's lines. A plain one (the live file) is read whole up to PEEK_LIMITS.codexTailBytes;
 * past it, its first line (session_meta: id, cwd, start) and then its last codexTailBytes, noted
 * tail-only. A .zst one (Codex compresses a finished session into one frame) is decoded whole up to
 * codexMaxBytes and `decoded` bytes of text; past either, only its first line comes, decoded from its
 * first codexHeadBytes, noted too-large: the rest of it is never read.
 */
function codexLines(gate: ReadGate, s: PeekSession, each: (line: string) => void, decoded: number): PeekNote | null {
  const L = PEEK_LIMITS;
  if (/\.zst$/i.test(s.file)) {
    const whole = s.size <= L.codexMaxBytes ? boundedRead(gate, s, L.codexMaxBytes) : null;
    if (whole !== null) {
      const got = frameLines(whole, each, decoded);
      if (got.note !== 'too-large' || got.lines > 0) return got.note;
    }
    // Its own small ceiling, not what is left of `decoded`: a prefix that decodes past it is cut to a
    // quarter and tried again while it is over 1 KiB, since the first line sits in the first bytes.
    const bytes = gate.readRange(s.file, 0, Math.min(s.size, L.codexHeadBytes));
    for (let n = bytes.length; n > 0; ) {
      let head: string;
      try {
        head = decodePrefix(bytes.subarray(0, n), L.codexHeadDecodedBytes).toString('utf8');
      } catch (e) {
        if (!tooLarge(e)) {
          if (isZlibError(e)) return 'bad-frame';
          throw e;
        }
        n = n > 1024 ? Math.floor(n / 4) : 0;
        continue;
      }
      const nl = head.indexOf('\n');
      if (nl > 0) each(head.slice(0, nl));
      break;
    }
    return 'too-large';
  }
  if (s.size <= L.codexTailBytes) {
    const text = gate.readRange(s.file, 0, s.size).toString('utf8');
    const lines = text.split('\n');
    if (!text.endsWith('\n')) lines.pop();
    for (const line of lines) each(line);
    return null;
  }
  const headBuf = gate.readRange(s.file, 0, Math.min(s.size, L.codexHeadBytes));
  const nl = headBuf.indexOf(0x0a);
  if (nl > 0) each(headBuf.subarray(0, nl).toString('utf8'));
  const start = Math.max(nl + 1, s.size - L.codexTailBytes);
  const text = gate.readRange(s.file, start, s.size - start).toString('utf8');
  const lines = text.split('\n');
  // A read from the middle starts inside a line, unless it starts right after the first; the last may be half written.
  if (start !== nl + 1) lines.shift();
  if (!text.endsWith('\n')) lines.pop();
  for (const line of lines) each(line);
  return 'tail-only';
}

/** Whether a line is one JSON object: the lines the event parsers turn into an event, the rest they refuse. */
function isRecordLine(line: string): boolean {
  try {
    return isObject(JSON.parse(line));
  } catch {
    return false;
  }
}

/**
 * The last events of a session, read once through the gate. Every line is checked, but only the last
 * PEEK_LIMITS.events records become events: redaction is the costly step, and a 16 MB Codex rollout
 * holds thousands of records (redacting them all held the daemon's one thread past the page's 4 s).
 */
export function readSession(gate: ReadGate, s: PeekSession, redact: Redact): PeekView {
  const keep = PEEK_LIMITS.events;
  const last: string[] = [];
  let unparsed = 0;
  const parse = s.harness === 'claude' ? claudeEvent : s.harness === 'codex' ? codexEvent : dshEvent;
  const note = eachLine(gate, s, (line) => {
    if (line.trim() === '') return;
    if (!isRecordLine(line)) {
      unparsed++;
      return;
    }
    last.push(line);
    if (last.length > keep) last.shift();
  });
  const events: PeekEvent[] = [];
  for (const line of last) {
    const e = parse(line, redact);
    if (e !== null) events.push(e);
  }
  return { session: s, events, unparsed, note };
}

/**
 * Hands each JSON object of a session to `each`, in file order, as it is parsed, through the same
 * reader and limits as readSession; nothing is collected, so a caller holds only what it keeps. They are
 * raw source values: a caller sends every string it keeps through shown(). `decoded` is the DSH
 * decoded-text ceiling (PEEK_LIMITS.dshMaxDecodedBytes unless a test sets a smaller one; a Codex
 * rollout never past PEEK_LIMITS.codexMaxDecodedBytes). `chars` is the text it handed over, lines and all.
 */
export function eachRecord(gate: ReadGate, s: PeekSession, each: (record: Record<string, unknown>) => void, decoded: number = PEEK_LIMITS.dshMaxDecodedBytes): { unparsed: number; note: PeekNote | null; chars: number } {
  let unparsed = 0;
  let chars = 0;
  const note = eachLine(gate, s, (line) => {
    chars += line.length;
    if (line.trim() === '') return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      unparsed++;
      return;
    }
    if (isObject(o)) each(o);
    else unparsed++;
  }, decoded);
  return { unparsed, note, chars };
}

/**
 * A Claude subagent's transcript and, when it is there, its meta file, both as sessions of their own.
 * `via` says where it was found: `subagents/` beside the transcript (started by a Task or Agent call)
 * or `subagents/workflows/wf_*` (started by the Workflow tool, which no Task call names).
 */
export type SubagentFile = { agentId: string; via: 'task' | 'workflow'; jsonl: PeekSession; meta: PeekSession | null };

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.(jsonl|meta\.json)$/;

/**
 * The subagents of one Claude transcript: `agent-<id>.jsonl` beside `agent-<id>.meta.json` in
 * `<dir>/<uuid>/subagents/`, or one level down in `subagents/workflows/wf_<name>/` (the read gate's
 * subagents rule allows both). A meta file without its transcript is skipped. Sorted by agent id;
 * [] for a DSH log or a transcript without subagents.
 */
export function listSubagents(gate: ReadGate, s: PeekSession, redact: Redact): SubagentFile[] {
  if (s.harness !== 'claude' || !/\.jsonl$/i.test(s.file)) return [];
  const dir = win.join(s.file.slice(0, -'.jsonl'.length), 'subagents');
  const found = new Map<string, { via: SubagentFile['via']; jsonl?: string; meta?: string }>();
  const scan = (d: string, via: SubagentFile['via']) => {
    for (const name of tryGate(() => gate.readdir(d), [])) {
      const m = AGENT_FILE.exec(name);
      if (m === null) continue;
      const slot = found.get(m[1]!) ?? { via };
      if (m[2] === 'jsonl') slot.jsonl = win.join(d, name);
      else slot.meta = win.join(d, name);
      found.set(m[1]!, slot);
    }
  };
  scan(dir, 'task');
  const workflows = win.join(dir, 'workflows');
  for (const wf of tryGate(() => gate.subdirs(workflows), [])) if (/^wf_/.test(wf)) scan(win.join(workflows, wf), 'workflow');
  const out: SubagentFile[] = [];
  for (const agentId of [...found.keys()].sort()) {
    const slot = found.get(agentId)!;
    if (slot.jsonl === undefined) continue;
    // Its own name only: the project directory's name is Claude Code's spelling of an absolute cwd.
    const label = `agent-${agentId}`;
    const jsonl = session('claude', label, slot.jsonl, gate, redact);
    if (jsonl === null) continue;
    out.push({ agentId, via: slot.via, jsonl, meta: slot.meta === undefined ? null : session('claude', label, slot.meta, gate, redact) });
  }
  return out;
}
