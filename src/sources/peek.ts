import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import { pathKey } from '../fs/paths.ts';
import { ReadGateError } from '../fs/read-gate.ts';
import { FrameError, decodeFrame, walkFrames } from '../lib/zstd/frames.ts';
import { frozen } from '../../shared/frozen.js';

// The thin slice ahead of plan steps 9-11: list the Claude transcripts and DSH v4 logs under the
// harness roots and show the last events of one, read-only, for the peek page (src/server/http.ts).
// Every read goes through the read gate: 'r' only, closed as soon as the read is done, no tail handle
// held, so nothing here keeps a file open that its harness may replace (plan §6 invariant 4). Nothing
// is kept: no cursor, no journal, no db. Every string that leaves comes from the source, so it is
// cleaned of control characters, run through the redactor, and clipped to one field's size.
// Steps 9-11 replace the readers (cursors, normalization, the hot set); step 5 replaces the page.

export type PeekHarness = 'claude' | 'dsh';

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
  /** Sessions the list shows, newest first. */
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
});

export type Redact = (text: string) => string;

const win = path.win32;
const UUID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DSH_LOG = 'session.v4.jsonl.zstd';
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

/** Every Claude transcript (`projects/<dir>/<uuid>.jsonl`) and DSH v4 log under one root. */
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
 * The sessions under the roots, newest first, at most PEEK_LIMITS.sessions of them. A session `pinned`
 * holds is listed whatever its age (the stage pins the ones its registry says wait on you).
 */
export function listSessions(gate: ReadGate, roots: readonly HarnessRoot[], redact: Redact, pinned?: (s: PeekSession) => boolean): { sessions: PeekSession[]; total: number } {
  const all = walkAll(gate, roots, redact);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sessions: keepPinned(all, PEEK_LIMITS.sessions, pinned), total: all.length };
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
function claudeBlock(b: unknown): string {
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
      return `[tool_use ${str(own(b, 'name'))}] ${clip(input, 600)}`;
    }
    case 'tool_result': {
      const c = own(b, 'content');
      const body = Array.isArray(c) ? c.map(claudeBlock).join('\n') : str(c);
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
    text = Array.isArray(content) ? content.map(claudeBlock).filter((s) => s !== '').join('\n') : str(content);
  } else if (type === 'summary') {
    text = str(own(o, 'summary'));
  } else if (type === 'system') {
    text = str(own(o, 'content'));
  }
  return { at: isoOf(own(o, 'timestamp')), type: shown(type || '?', redact, 64), text: shown(text, redact) };
}

/** `key: value` for the string, number and boolean leaves of a DSH event's data, depth first, bounded. */
function leaves(v: unknown, at: string, out: string[], budget: { chars: number }, depth: number): void {
  if (budget.chars <= 0 || depth > 6) return;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const line = at === '' ? String(v) : `${at}: ${String(v)}`;
    out.push(line);
    budget.chars -= line.length;
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => leaves(x, `${at}[${i}]`, out, budget, depth + 1));
    return;
  }
  if (isObject(v)) for (const k of Object.keys(v)) leaves(v[k], at === '' ? k : `${at}.${k}`, out, budget, depth + 1);
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

export type PeekNote = NonNullable<PeekView['note']>;

/**
 * Hands every whole line of a session to `each`, in file order, read once through the gate: a Claude
 * transcript's last PEEK_LIMITS.claudeTailBytes, a DSH log frame by frame from byte 0 (none past
 * PEEK_LIMITS.dshMaxBytes, and no more decoded text than `decoded` bytes: each frame is decoded with
 * what is left of it as its ceiling, so a frame that claims a huge size cannot grow past it). Returns
 * why fewer lines than the file holds may have come, or null.
 */
function eachLine(gate: ReadGate, s: PeekSession, each: (line: string) => void, decoded: number = PEEK_LIMITS.dshMaxDecodedBytes): PeekNote | null {
  let note: PeekNote | null = null;
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
  const b = gate.readFile(s.file);
  let walked: ReturnType<typeof walkFrames>;
  try {
    walked = walkFrames(b);
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
    return 'bad-frame';
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
      note = e instanceof RangeError && (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'bad-frame';
      break;
    }
    for (const line of text.split('\n')) each(line);
  }
  if (note === null && walked.next < b.length) note = 'unfinished-frame';
  return note;
}

/** The last events of a session, read once through the gate. */
export function readSession(gate: ReadGate, s: PeekSession, redact: Redact): PeekView {
  const keep = PEEK_LIMITS.events;
  const events: PeekEvent[] = [];
  let unparsed = 0;
  const parse = s.harness === 'claude' ? claudeEvent : dshEvent;
  const note = eachLine(gate, s, (line) => {
    if (line.trim() === '') return;
    const e = parse(line, redact);
    if (e === null) {
      unparsed++;
      return;
    }
    events.push(e);
    if (events.length > keep) events.shift();
  });
  return { session: s, events, unparsed, note };
}

/**
 * Hands each JSON object of a session to `each`, in file order, as it is parsed, through the same
 * reader and limits as readSession; nothing is collected, so a caller holds only what it keeps. They are
 * raw source values: a caller sends every string it keeps through shown(). `decoded` is the DSH
 * decoded-text ceiling (PEEK_LIMITS.dshMaxDecodedBytes unless a test sets a smaller one).
 */
export function eachRecord(gate: ReadGate, s: PeekSession, each: (record: Record<string, unknown>) => void, decoded: number = PEEK_LIMITS.dshMaxDecodedBytes): { unparsed: number; note: PeekNote | null } {
  let unparsed = 0;
  const note = eachLine(gate, s, (line) => {
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
  return { unparsed, note };
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
