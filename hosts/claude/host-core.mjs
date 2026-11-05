// The Claude host's logic (alpha 0.2 design §1 route B, §2.2, §2.3). orchestrad starts `node host.mjs`
// through its spawn gate; host.mjs loads the Agent SDK and hands every power this module uses (the SDK's
// query, stdio, crypto, realpath, the one timer, the env) to runHost. This module imports nothing, so
// the tests drive it with a fake SDK (test/fixtures/fake-sdk.ts), in-process, with no child.
//
// The host is agent-side: everything it writes is agent data to orchestrad (A4). The human verbs
// (allow, deny, interrupt, send) reach it only as frames orchestrad wrote after its own checks; the host
// makes none of them up. Every refusal here fails closed: a frame it cannot read ends the host, a tool
// call it cannot judge goes to the human or is denied, an approval nobody answers is denied.

/** One stdio line either way, without its newline (design §2.3). An input line over it ends the host. */
export const LINE_MAX_BYTES = 64 * 1024;
/** A `text` frame's chunk: long text is split into chunks of at most this many UTF-8 bytes, never cut. */
export const TEXT_CHUNK_BYTES = 2048;
/** An `ask` frame's preview (design §2.6): past this the preview is cut and `tooLong` is set. */
export const PREVIEW_MAX_BYTES = 16 * 1024;
/** The places an ask frame names, at most this many (a Glob or Grep names its root and its pattern's base). */
export const ASK_PATHS_MAX = 8;
/** A place longer than this (in UTF-16 units) is left out of an ask frame's `paths`. */
export const ASK_PATH_MAX_CHARS = 1024;
/** An ask frame's `subject`, in UTF-8 bytes. */
export const SUBJECT_MAX_BYTES = 200;
/** The SDK's turn cap. It counts per message (probe §10 item 4): hitting it ends that turn, not the session. */
export const MAX_TURNS = 50;
/** orchestrad's approval timeout when the start frame names none (design §8 item 7: 30 minutes). */
export const DEFAULT_ASK_TIMEOUT_MS = 30 * 60 * 1000;
/** The host's own backstop runs this much after orchestrad's timeout, so a dead orchestrad cannot leave a tool hanging. */
export const ASK_BACKSTOP_EXTRA_MS = 60 * 1000;

/**
 * The models a session may run: the local magpie gateway's zcode/* and opencode-go/* (orchestra app plan
 * §2; the user's goal of 2026-11-02 widened r4 §7.2's haiku-only guard to these two families). codex/*
 * speaks the Responses API, not Anthropic's Messages API, so it is not here. The start frame names one
 * model of this grammar; from then on the guard is exact: init, every assistant message and every
 * modelUsage key must name that model (or the small fast model the host's env names, below).
 */
export const MODEL_RE = /^(?:zcode|opencode-go)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The env variable naming the small fast model (orchestrad sets it); a model of MODEL_RE or ignored. */
export const SMALL_FAST_ENV = 'ANTHROPIC_SMALL_FAST_MODEL';
/** What the CLI writes as the model of an assistant message it made up itself (an API error, say); no model ran. */
const SYNTHETIC_MODEL = '<synthetic>';

/** The tools a session may use at all. Every other tool name is denied by the hook (probe §10 item 2). */
export const CORE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'PowerShell', 'Bash']);
const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/**
 * The tool that starts a sub-agent: system/init lists it as Task, a call names it Agent (measured on CLI 2.1.287,
 * 2026-11-05). It is let through only for a session whose whole tree runs in a procguard Job (the start frame's
 * subagents); then every call of it is a card (judge), and every tool a sub-agent calls comes to the same hook and
 * canUseTool as the session's own, with its agent id (measured: foreground, background, after the root's turn ended,
 * nested, tainted, each of AGENT_TYPES). Without a Job it stays disallowed, as DISALLOWED_TOOLS says.
 */
export const SUBAGENT_TOOLS = Object.freeze(['Task', 'Agent']);
/**
 * The dispatch tool (src/route/dispatch.ts, whose DISPATCH_TOOL this restates: the host imports nothing, and a test holds
 * the two equal): an in-process MCP server the start frame's dispatch turns on, written here by hand because the SDK's
 * tool() takes only a zod schema, and a bare JSON schema is what both harnesses are given. Measured on CLI 2.1.287,
 * 2026-11-05: the SDK calls instance.connect(transport), init then lists mcp__orchestra__dispatch and one server
 * connected, a hook answer of allow runs it with no canUseTool, a call stays open as long as its answer takes, and an
 * interrupt comes as notifications/cancelled. A sub-agent holds the tool too, with its agent id on the hook, and is refused.
 * The call runs on orchestrad's word, not on a card: dispatch.ts decides, and every check of a dispatch is there.
 */
export const DISPATCH_SERVER = 'orchestra';
export const DISPATCH_TOOL = Object.freeze({
  name: 'dispatch',
  description: 'Send a task to a new worker: a separate Codex or Claude session of Orchestra that works on its own. Use it only when the person asked for that or a separate worker clearly helps. '
    + 'Orchestra decides: it may ask the person first, which can take minutes, or refuse. Read the result: it says whether the worker went out. The new worker does not report back to you; the person sees its result.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'harness'],
    properties: {
      task: { type: 'string', description: 'What the new worker should do, complete in itself: it sees nothing of this conversation.' },
      harness: { type: 'string', enum: ['codex', 'claude'], description: 'Which harness runs it.' },
      model: { type: 'string', description: 'Optional: a model of the local gateway, like zcode/GLM-5.3. Left out, the harness default.' },
      cwd: { type: 'string', description: 'Optional: an absolute folder inside a project root the person opened. Left out, the worker gets its own empty folder.' },
      why: { type: 'string', description: 'Optional: why this worker, in one sentence. The person reads it on the order.' },
      returns: { type: 'string', description: 'Optional: what the worker should hand back, in one sentence. The person reads it on the order; say it in task too, the worker sees only task.' },
    },
  },
});
/** The dispatch tool's name as the CLI lists and calls it. */
export const DISPATCH_TOOL_ID = `mcp__${DISPATCH_SERVER}__${DISPATCH_TOOL.name}`;
/**
 * The front desk's read tool (src/route/front-desk.ts, whose STATUS_TOOL this restates as DISPATCH_TOOL is, and a test
 * holds the two equal). Only a start frame's frontDesk offers it, on the dispatch tool's server; orchestrad answers it.
 */
export const STATUS_TOOL = Object.freeze({
  name: 'status',
  description: 'Read the state of Orchestra itself: what sessions there are, what waits for the person, one session. It never holds a conversation or the output of a command. Read it before you say anything about a session, a count or a wait.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['what'],
    properties: {
      what: { type: 'string', enum: ['overview', 'waiting', 'session'], description: 'overview: every session and its state; waiting: what waits for the person; session: one session.' },
      session: { type: 'string', description: 'With what=session: its id, as overview lists it.' },
    },
  },
});
export const STATUS_TOOL_ID = `mcp__${DISPATCH_SERVER}__${STATUS_TOOL.name}`;
/**
 * All a front desk may hold, as system/init must list it: `tools: []` takes every built-in away (measured on CLI 2.1.287,
 * 2026-11-05: init then lists these two and nothing else, Task and Agent included), so anything more is a safety-stop.
 */
export const FRONT_DESK_TOOLS = Object.freeze([DISPATCH_TOOL_ID, STATUS_TOOL_ID]);
/** A front desk's turn cap: a question takes a read or two and a reply, so a turn this long is something gone wrong (the SDK's count, as MAX_TURNS). */
export const FRONT_DESK_MAX_TURNS = 8;
/** What an Agent call may name; anything else is refused unseen by a person (agent-input). `isolation` runs it out of cwd, or out of the Job; `name` and `mode` were never measured. */
const AGENT_INPUT_KEYS = Object.freeze(['description', 'prompt', 'subagent_type', 'model', 'run_in_background']);
/** The kinds of sub-agent measured to come to the gate. statusline-setup would only edit a protected file, and `fork` was never seen. */
export const AGENT_TYPES = Object.freeze(['general-purpose', 'Explore', 'Plan', 'claude']);
/** The model names sessionEnv pins to the session's one model (measured: sonnet ran on it). `fable` has no such variable, so it is refused. */
export const AGENT_MODELS = Object.freeze(['sonnet', 'opus', 'haiku']);

/**
 * Passed as `disallowedTools`: the 20 non-core tools of the owned CLI 2.1.310 (probe §10 item 1), then
 * names of other CLI versions that start subagents, manage background shells, schedule, reach the
 * network or edit outside the core tools. The hook denies any non-core name anyway; this list keeps
 * them out of the model's tool list too, and the init check refuses a session that still offers one.
 */
export const DISALLOWED_TOOLS = Object.freeze([
  'Task', 'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterPlanMode', 'EnterWorktree',
  'ExitPlanMode', 'ExitWorktree', 'ListAgents', 'NotebookEdit', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill',
  'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch',
  'Agent', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'TaskOutput', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'SlashCommand', 'MultiEdit', 'NotebookRead', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Workflow',
  'RemoteTrigger', 'PushNotification', 'Config', 'LSP',
]);

/**
 * The CLI's built-in skills and plugins, which `skills: []` hides from the model but cannot remove from
 * system/init (probe §10 item 3, CLI 2.1.310; design §8 item 13). init may report these and no others.
 */
export const PINNED_SKILLS = Object.freeze([
  'design', 'design-sync', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'simplify', 'batch',
  'fewer-permission-prompts', 'doctor', 'loop', 'claude-api', 'run', 'run-skill-generator', 'plugin-authoring',
]);
export const PINNED_PLUGINS = Object.freeze(['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring']);

/**
 * The CLI build the SDK 0.3.287 brings (its package.json claudeCodeVersion; the claude.exe of
 * @anthropic-ai/claude-agent-sdk-win32-x64 carries the same VERSION). The checks above were measured
 * against a CLI; a session whose init reports another version is stopped (safety-stop cli-version):
 * a reinstalled CLI alone, with sdk.mjs unchanged, could change what those checks rely on.
 */
export const CLI_VERSION = '2.1.287';

const HEX20 = /^[0-9a-f]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQ_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** task_updated's and task_notification's ends as a sub-start's end says them. */
const TASK_ENDS = Object.freeze({ completed: 'completed', failed: 'failed', stopped: 'stopped', killed: 'stopped' });
const LIFECYCLE_STATES = Object.freeze(['queued', 'started', 'completed', 'cancelled']);
const MAX_PROTECTED_ROOTS = 64;
const MAX_TOOL_USE_ID = 256;
const ASK_TIMEOUT_MIN_MS = 1000;
const ASK_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;

/** What the model reads when a tool call is refused. Fixed text: nothing of the call is echoed back. */
const DENY_MESSAGES = Object.freeze({
  user: 'The user did not allow this tool call.',
  timeout: 'The user did not answer in time, so this tool call was not allowed.',
  digest: 'The approval did not match this tool call, so it was not allowed.',
  aborted: 'This tool call was cancelled.',
  ending: 'The session is ending, so this tool call was not allowed.',
  protected: 'This path is protected: tools in this session may not touch it.',
  background: 'Background commands are not allowed in this session.',
  disallowed: 'This tool is not available in this session.',
  'agent-input': 'A sub-agent may be started only with description, prompt, an available subagent_type, and optionally run_in_background and model sonnet, opus or haiku. Nothing else is allowed in this session.',
  'bad-input': 'This tool call could not be shown to the user, so it was not allowed.',
  'dispatch-subagent': 'A sub-agent may not dispatch: only the session itself may.',
});

const ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------------------------------
// Canonical JSON: a copy of src/store/canonical-json.ts's encoder (the host cannot import src/). The
// vectors in test/fixtures/canonical-json-vectors.json run against both, so the two stay one algorithm.

export const CANONICAL_MAX_DEPTH = 64;

export class CanonicalError extends Error {
  constructor(reason, at) {
    super(`canonical json: ${reason} at ${at}`);
    this.reason = reason;
    this.at = at;
  }
}

function encodeNumber(n, at) {
  if (!Number.isFinite(n)) throw new CanonicalError('non-finite', at);
  if (!Number.isInteger(n)) throw new CanonicalError('non-integer', at);
  if (!Number.isSafeInteger(n)) throw new CanonicalError('unsafe-integer', at);
  return String(n);
}

function encodeString(s, at) {
  if (!s.isWellFormed()) throw new CanonicalError('lone-surrogate', at);
  return JSON.stringify(s);
}

function dataValue(o, key, at) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !('value' in d)) throw new CanonicalError('accessor', at);
  return d.value;
}

function encode(v, at, depth, open) {
  switch (typeof v) {
    case 'string':
      return encodeString(v, at);
    case 'number':
      return encodeNumber(v, at);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalError('bigint', at);
    case 'object':
      break;
    default:
      throw new CanonicalError('bad-type', at);
  }
  if (v === null) return 'null';
  if (depth >= CANONICAL_MAX_DEPTH) throw new CanonicalError('too-deep', at);
  if (open.has(v)) throw new CanonicalError('cycle', at);
  open.add(v);
  try {
    if (Object.getOwnPropertySymbols(v).length > 0) throw new CanonicalError('symbol-key', at);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) throw new CanonicalError('not-plain', at);
      const len = v.length;
      const keys = Object.getOwnPropertyNames(v);
      if (keys.length !== len + 1) {
        const holes = keys.filter((k) => k !== 'length' && String(Number(k)) === k).length !== len;
        throw new CanonicalError(holes ? 'sparse-array' : 'array-extra-key', at);
      }
      const parts = [];
      for (let i = 0; i < len; i++) {
        if (!Object.hasOwn(v, i)) throw new CanonicalError('sparse-array', `${at}[${i}]`);
        parts.push(encode(dataValue(v, String(i), `${at}[${i}]`), `${at}[${i}]`, depth + 1, open));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalError('not-plain', at);
    const keys = Object.getOwnPropertyNames(v).sort();
    const parts = [];
    keys.forEach((k, i) => {
      const where = `${at}.${i}`;
      parts.push(`${encodeString(k, where)}:${encode(dataValue(v, k, where), where, depth + 1, open)}`);
    });
    return `{${parts.join(',')}}`;
  } finally {
    open.delete(v);
  }
}

/** The canonical encoding of `value`; throws CanonicalError for anything that has none. */
export function canonicalJson(value) {
  return encode(value, '$', 0, new Set());
}

// ---------------------------------------------------------------------------------------------------
// Secret redaction for previews: a port of layer 2 (format rules) and the entropy rule of
// src/store/redact.ts, same patterns and markers. The env-dump layer is left out on purpose: dropping a
// whole command would hide what the human is asked to allow. Known values (layer 1) have no source
// here. test/fixtures/redact-vectors.json runs against both, and a test compares the patterns.

export const REDACT_RULES = Object.freeze([
  { id: 'pem', re: /-----BEGIN [A-Z0-9 ]{1,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,64}-----|$)/g },
  { id: 'sk-ant', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { id: 'sk', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { id: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g },
  { id: 'authorization', re: /\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, keep: 1 },
  { id: 'bearer', re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: 1 },
  { id: 'url-credentials', re: /\b([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, keep: 1 },
  {
    id: 'secret-param',
    re: /((["']?)\b(?:[a-z0-9_]*token|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|cookie)\2\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&"',;]+)/gi,
    keep: 1,
  },
].map((r) => Object.freeze(r)));

export const ENTROPY_MIN_LENGTH = 20;
export const ENTROPY_BITS = 3.5;
const ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;

function entropyBits(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of [...counts.values()].sort((a, b) => a - b)) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function isHighEntropy(token) {
  return token.length >= ENTROPY_MIN_LENGTH && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && entropyBits(token) >= ENTROPY_BITS;
}

const redactMarker = (rule) => `[redacted:${rule}]`;

/** `text` with suspected secrets replaced by `[redacted:<rule>]`, and how many were replaced. */
export function redactSecrets(text) {
  let out = text;
  let count = 0;
  for (const rule of REDACT_RULES) {
    out = out.replace(new RegExp(rule.re), (...m) => {
      count++;
      return `${rule.keep !== undefined ? String(m[rule.keep] ?? '') : ''}${redactMarker(rule.id)}`;
    });
  }
  out = out.replace(new RegExp(ENTROPY_TOKEN), (t) => {
    if (!isHighEntropy(t)) return t;
    count++;
    return redactMarker('entropy');
  });
  return { text: out, count };
}

// ---------------------------------------------------------------------------------------------------
// Previews (design §2.6: what you see is what you allow).

// Control, format (bidi, zero-width, tags), separator and surrogate code points, and the invisible
// fillers and variation selectors that are none of those. A tab, a newline and the CR of a CRLF stay.
const INVISIBLE = /(?![\t\n])(?!\r\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/gu;

/** Invisible characters written out as `\uXXXX` (or `\u{XXXXX}`), never removed: the text shown is the text run. */
export function escapeInvisible(text) {
  return text.replace(INVISIBLE, (ch) => {
    const cp = ch.codePointAt(0);
    const hex = cp.toString(16).toUpperCase();
    return cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/** UTF-8 length of `s` (a lone surrogate counts as the 3 bytes of U+FFFD). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `text` split into pieces of at most `max` UTF-8 bytes, on code point boundaries; joined, they are `text`. */
export function splitUtf8(text, max) {
  const out = [];
  let start = 0;
  let size = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const units = cp > 0xffff ? 2 : 1;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp > 0xffff ? 4 : 3;
    if (size + n > max && i > start) {
      out.push(text.slice(start, i));
      start = i;
      size = 0;
    }
    size += n;
    i += units;
  }
  if (i > start) out.push(text.slice(start, i));
  return out;
}

/** Risk class of a tool call shown on its card (design §2.6). */
export function riskOf(toolName, isProtected) {
  if (isProtected) return 'protected';
  if (READ_TOOLS.includes(toolName)) return 'read';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'write';
  if (SHELL_TOOLS.includes(toolName)) return 'shell';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'net';
  return 'other';
}

/**
 * The preview of a tool input: every field in canonical key order, one `name: value` per field (a
 * string as it is, anything else as canonical JSON); suspected secrets redacted and counted; invisible
 * characters escaped; cut to PREVIEW_MAX_BYTES with `tooLong` set. `input` must have a canonical form.
 */
export function buildPreview(input) {
  const lines = Object.keys(input).sort().map((k) => {
    const v = input[k];
    return `${k}: ${typeof v === 'string' ? v : canonicalJson(v)}`;
  });
  const red = redactSecrets(lines.join('\n'));
  const shown = escapeInvisible(red.text);
  if (utf8Length(shown) <= PREVIEW_MAX_BYTES) return { preview: shown, redactions: red.count, tooLong: false };
  return { preview: splitUtf8(shown, PREVIEW_MAX_BYTES)[0] ?? '', redactions: red.count, tooLong: true };
}

// ---------------------------------------------------------------------------------------------------
// Windows paths, lexically. The host runs only on Windows (claude.exe); no node:path here.

/**
 * `p` as a normalized drive-absolute path: drive letter upper-cased, `\` separators, `.` and `..`
 * resolved, trailing dots and spaces of each name dropped as Win32 does. A `\\?\C:\` prefix is read
 * through. null for anything else: relative, drive-relative, UNC and device paths.
 */
export function winAbsolute(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return null;
  let s = p;
  if (/^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/.test(s)) s = s.slice(4);
  const m = /^([A-Za-z]):[\\/]/.exec(s);
  if (m === null) return null;
  const names = [];
  for (const raw of s.slice(3).split(/[\\/]+/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      names.pop();
      continue;
    }
    const name = raw.replace(/[. ]+$/, '');
    if (name !== '') names.push(name);
  }
  return `${m[1].toUpperCase()}:\\${names.join('\\')}`;
}

/** Is `child` `root` or inside it? Case-insensitive, as NTFS names are. Both normalized by winAbsolute. */
export function isInside(child, root) {
  const c = child.toLowerCase();
  const r = root.toLowerCase();
  if (r.endsWith('\\')) return c.startsWith(r);
  return c === r || c.startsWith(`${r}\\`);
}

function parentOf(p) {
  const i = p.lastIndexOf('\\');
  if (i <= 2) return p.slice(0, 3);
  return p.slice(0, i);
}

const baseName = (p) => p.slice(p.lastIndexOf('\\') + 1);

/** `p` as named by a tool: `~` is home, a relative path is against cwd. null when it cannot be placed. */
function placePath(p, cwd, home) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (/^~(?:[\\/]|$)/.test(p)) return winAbsolute(`${home}\\${p.slice(1)}`);
  if (/^[A-Za-z]:/.test(p) || /^[\\/]/.test(p)) return winAbsolute(p);
  return winAbsolute(`${cwd}\\${p}`);
}

/**
 * The real path of `abs`: realpath of the path, or of its nearest existing ancestor with the missing
 * names put back. null when realpath fails for any reason but a missing name.
 */
async function realOf(abs, realpath) {
  const tail = [];
  let cur = abs;
  for (;;) {
    let real;
    try {
      real = await realpath(cur);
    } catch (e) {
      const code = e !== null && typeof e === 'object' ? e.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const up = parentOf(cur);
      if (up === cur) return null;
      tail.unshift(baseName(cur));
      cur = up;
      continue;
    }
    const base = winAbsolute(real);
    if (base === null) return null;
    return tail.length === 0 ? base : winAbsolute(`${base}\\${tail.join('\\')}`);
  }
}

/** The static part of a glob pattern (the names before the first one with a wildcard), placed. */
function globBase(pattern, base, home) {
  const names = pattern.split(/[\\/]/);
  const fixed = [];
  for (const n of names) {
    if (/[*?[\]{}]/.test(n)) break;
    fixed.push(n);
  }
  if (fixed.length === names.length) fixed.pop();
  const head = fixed.join('\\');
  if (head === '') return /^[\\/]/.test(pattern) ? null : base;
  // `C:/**` names the whole drive.
  if (/^[A-Za-z]:$/.test(head)) return winAbsolute(`${head}\\`);
  return placePath(head, base, home);
}

/**
 * The places a core tool call reaches. `file` paths reach one name; `tree` paths reach everything below
 * them (a Glob or Grep root). `unplaced` when a path cannot be placed or a pattern climbs with `..`.
 */
function toolReach(toolName, input, cwd, home) {
  const files = [];
  const trees = [];
  let unplaced = false;
  const place = (p, into) => {
    const at = placePath(p, cwd, home);
    if (at === null) unplaced = true;
    else into.push(at);
  };
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') place(input.file_path, files);
  if (toolName === 'Glob' || toolName === 'Grep') {
    let root = cwd;
    if (input.path !== undefined) {
      root = placePath(input.path, cwd, home);
      if (root === null) unplaced = true;
    }
    const pattern = toolName === 'Glob' ? input.pattern : input.glob;
    if (root !== null) trees.push(root);
    if (typeof pattern === 'string' && root !== null) {
      if (pattern.includes('..')) unplaced = true;
      const at = globBase(pattern, root, home);
      if (at === null) unplaced = true;
      else trees.push(at);
    } else if (pattern !== undefined && typeof pattern !== 'string') unplaced = true;
  }
  return { files, trees, unplaced };
}

// ---------------------------------------------------------------------------------------------------
// Frames and the start frame.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));

const START_KEYS = Object.freeze(['t', 'ownedId', 'model', 'cwd', 'configDir', 'resume', 'fork', 'resumeAt', 'appendSystem', 'tainted', 'claudeExe', 'protectedRoots', 'askTimeoutMs', 'subagents', 'dispatch', 'frontDesk']);

/** The env value of `name`, matched case-insensitively as Windows does; undefined when absent. */
function envValue(env, name) {
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want && typeof env[k] === 'string') return env[k];
  return undefined;
}

/**
 * Checks a start frame field by field. `{ ok: true, start }` with paths normalized, or `{ ok: false,
 * field }` naming the first field that failed (it ends the host with exit reason bad-start).
 */
export function parseStart(f, env) {
  const bad = (field) => ({ ok: false, field });
  if (!onlyKeys(f, START_KEYS)) return bad('keys');
  if (typeof f.ownedId !== 'string' || !HEX20.test(f.ownedId)) return bad('ownedId');
  if (typeof f.model !== 'string' || !MODEL_RE.test(f.model)) return bad('model');
  const cwd = winAbsolute(f.cwd);
  if (cwd === null || cwd.length === 3) return bad('cwd');
  const configDir = winAbsolute(f.configDir);
  if (configDir === null || !HEX20.test(baseName(configDir)) || baseName(parentOf(configDir)) !== 'claude') return bad('configDir');
  if (f.resume !== undefined && (typeof f.resume !== 'string' || !UUID.test(f.resume))) return bad('resume');
  if (f.fork !== undefined && (typeof f.fork !== 'boolean' || f.resume === undefined)) return bad('fork');
  // A cut point only on a fork: a plain resume never rewrites the source session.
  if (f.resumeAt !== undefined && (typeof f.resumeAt !== 'string' || !UUID.test(f.resumeAt) || f.fork !== true)) return bad('resumeAt');
  if (f.appendSystem !== undefined && (typeof f.appendSystem !== 'string' || f.appendSystem.length === 0)) return bad('appendSystem');
  if (typeof f.tainted !== 'boolean') return bad('tainted');
  if (f.subagents !== undefined && typeof f.subagents !== 'boolean') return bad('subagents');
  if (f.dispatch !== undefined && typeof f.dispatch !== 'boolean') return bad('dispatch');
  // The front desk's own system prompt: it runs on that alone, with the dispatch tool, as a fresh session of no sub-agents.
  if (f.frontDesk !== undefined && (typeof f.frontDesk !== 'string' || f.frontDesk.length === 0 || f.dispatch !== true || f.subagents === true || f.resume !== undefined || f.appendSystem !== undefined)) return bad('frontDesk');
  const claudeExe = winAbsolute(f.claudeExe);
  if (claudeExe === null || baseName(claudeExe).toLowerCase() !== 'claude.exe') return bad('claudeExe');
  if (!Array.isArray(f.protectedRoots) || f.protectedRoots.length > MAX_PROTECTED_ROOTS) return bad('protectedRoots');
  const protectedRoots = f.protectedRoots.map(winAbsolute);
  if (protectedRoots.some((r) => r === null)) return bad('protectedRoots');
  let askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;
  if (f.askTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(f.askTimeoutMs) || f.askTimeoutMs < ASK_TIMEOUT_MIN_MS || f.askTimeoutMs > ASK_TIMEOUT_MAX_MS) return bad('askTimeoutMs');
    askTimeoutMs = f.askTimeoutMs;
  }
  const home = winAbsolute(envValue(env, 'USERPROFILE'));
  if (home === null || home.length === 3) return bad('USERPROFILE');
  // The host adds the roots it can name itself: your .claude, .dsh and .orchestra, and this session's
  // own config dir (design §2.2 rule 1).
  const roots = [...protectedRoots, `${home}\\.claude`, `${home}\\.dsh`, `${home}\\.orchestra`, configDir];
  // The small fast model the CLI may use for its own side calls: allowed by the running guard too, when
  // it is a model of the same grammar; anything else in that variable is ignored (and then any use of it stops the session).
  const fast = envValue(env, SMALL_FAST_ENV);
  const smallFast = typeof fast === 'string' && MODEL_RE.test(fast) ? fast : null;
  return {
    ok: true,
    start: Object.freeze({
      ownedId: f.ownedId, model: f.model, cwd, configDir, resume: f.resume, fork: f.fork === true, resumeAt: f.resumeAt,
      appendSystem: f.appendSystem, tainted: f.tainted, subagents: f.subagents === true, dispatch: f.dispatch === true, frontDesk: f.frontDesk ?? null, claudeExe, protectedRoots: Object.freeze(roots), askTimeoutMs, home,
      hardRoots: Object.freeze([`${home}\\.claude`, `${home}\\.dsh`, configDir]),
      models: Object.freeze(smallFast === null || smallFast === f.model ? [f.model] : [f.model, smallFast]),
    }),
  };
}

/**
 * The owned work root exemption (src/os/cwd.ts does the same for the spawn gate's table): a session's
 * cwd may lie in `<root>\work\<name>` of a protected root, because orchestrad keeps the owned work dirs
 * in its data dir (ORCHESTRA_HOME\work, inside ~/.orchestra in the real profile). Below that root only
 * this session's own cwd is open; the root itself, its `work` dir and every other session's dir stay
 * protected. Returns the protected root the cwd sits in through this exemption, or null.
 */
function workRootOf(cwd, root) {
  return isInside(cwd, `${root}\\work`) && cwd.toLowerCase() !== `${root}\\work`.toLowerCase() ? root : null;
}

/** The env claude.exe gets: the host's own, then the session's config dir and every default model pinned to the one model. */
function sessionEnv(env, start) {
  const set = {
    CLAUDE_CONFIG_DIR: start.configDir,
    ANTHROPIC_MODEL: start.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: start.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: start.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: start.model,
    CLAUDE_CODE_SUBAGENT_MODEL: start.model,
  };
  const names = Object.keys(set);
  const out = {};
  // Names compare case-insensitively on Windows: a second spelling of one we set would race ours.
  for (const k of Object.keys(env)) if (typeof env[k] === 'string' && !names.includes(k.toUpperCase())) out[k] = env[k];
  return { ...out, ...set };
}

/** The tools a session keeps from the model: all of DISALLOWED_TOOLS, but for SUBAGENT_TOOLS where its tree is in a Job. */
export function disallowedFor(subagents) {
  return subagents === true ? DISALLOWED_TOOLS.filter((t) => !SUBAGENT_TOOLS.includes(t)) : DISALLOWED_TOOLS;
}

/** Whether an Agent call stays inside what was measured. */
export function agentInputOk(input) {
  if (!onlyKeys(input, AGENT_INPUT_KEYS)) return false;
  if (typeof input.description !== 'string' || typeof input.prompt !== 'string') return false;
  if (input.subagent_type !== undefined && !AGENT_TYPES.includes(input.subagent_type)) return false;
  if (input.model !== undefined && !AGENT_MODELS.includes(input.model)) return false;
  return input.run_in_background === undefined || typeof input.run_in_background === 'boolean';
}

/**
 * The SDK options of a session (design §2.2 with the probe's changes). Fixed except for what the start
 * frame names. Never: a bypassing or edit-accepting permission mode, permission prompt tools, a
 * fallback model or a budget cap.
 */
export function sdkOptions(start, env, gate) {
  const options = {
    cwd: start.cwd,
    model: start.model,
    pathToClaudeCodeExecutable: start.claudeExe,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: start.dispatch ? { [DISPATCH_SERVER]: { type: 'sdk', name: DISPATCH_SERVER, instance: gate.dispatchServer } } : {},
    permissionMode: 'default',
    disallowedTools: [...disallowedFor(start.subagents)],
    skills: [],
    env: sessionEnv(env, start),
    extraArgs: { 'no-chrome': null },
    maxTurns: MAX_TURNS,
    persistSession: true,
    hooks: { PreToolUse: [{ hooks: [gate.preToolUse] }] },
    canUseTool: gate.canUseTool,
  };
  if (start.frontDesk !== null) {
    options.tools = [];
    options.systemPrompt = start.frontDesk;
    options.maxTurns = FRONT_DESK_MAX_TURNS;
  }
  if (start.appendSystem !== undefined) {
    // On a resume the append only takes effect with snapshot: false (probe §10 item 8).
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: start.appendSystem, ...(start.resume !== undefined ? { snapshot: false } : {}) };
  }
  if (start.resume !== undefined) {
    options.resume = start.resume;
    if (start.fork) {
      options.forkSession = true;
      if (start.resumeAt !== undefined) options.resumeSessionAt = start.resumeAt;
    }
  }
  return options;
}

/** Why a system/init frame stops the session, or null when it passes (design §2.2 startup checks). */
export function initProblem(m, model, subagents = false, dispatch = false, frontDesk = false) {
  if (m.claude_code_version !== CLI_VERSION) return 'cli-version';
  if (m.model !== model) return 'model';
  if (m.permissionMode !== 'default') return 'permission-mode';
  if (typeof m.session_id !== 'string' || !UUID.test(m.session_id)) return 'session-id';
  const mine = frontDesk ? FRONT_DESK_TOOLS : dispatch ? [DISPATCH_TOOL_ID] : [];
  if (!Array.isArray(m.tools) || m.tools.some((t) => typeof t !== 'string' || (t.startsWith('mcp__') && !mine.includes(t)) || disallowedFor(subagents).includes(t))) return 'tools';
  // A front desk holds its two tools and not one more: no list of names could say what a new build's built-in reaches.
  if (frontDesk && (m.tools.length !== FRONT_DESK_TOOLS.length || !FRONT_DESK_TOOLS.every((t) => m.tools.includes(t)))) return 'tools';
  if (dispatch && !m.tools.includes(DISPATCH_TOOL_ID)) return 'tools';
  if (!Array.isArray(m.mcp_servers) || m.mcp_servers.length !== (dispatch ? 1 : 0)) return 'mcp-servers';
  if (dispatch && (m.mcp_servers[0]?.name !== DISPATCH_SERVER || m.mcp_servers[0]?.status !== 'connected')) return 'mcp-servers';
  if (!Array.isArray(m.skills) || m.skills.some((s) => !PINNED_SKILLS.includes(s))) return 'skills';
  if (!Array.isArray(m.plugins) || m.plugins.some((p) => !PINNED_PLUGINS.includes(isPlainObject(p) ? p.name : p))) return 'plugins';
  return null;
}

/** A plugin of system/init by name (the CLI reports `{ name, path }`). */
const pluginName = (p) => (isPlainObject(p) && typeof p.name === 'string' ? p.name : String(p));

/** The streaming prompt the SDK reads user messages from (it feeds them to the CLI through streamInput). */
function makeInbox() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(m) {
      if (ended) return;
      items.push(m);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length > 0) yield items.shift();
        if (ended) return;
        await new Promise((r) => {
          wake = r;
        });
        wake = null;
      }
    },
  };
}

/** Splits stdin bytes into lines of at most LINE_MAX_BYTES. push returns the complete lines and whether the cap was passed. */
function lineSplitter() {
  let parts = [];
  let size = 0;
  const joined = () => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    parts = [];
    size = 0;
    return out;
  };
  return {
    push(bytes) {
      const lines = [];
      let start = 0;
      for (;;) {
        const nl = bytes.indexOf(10, start);
        const piece = bytes.slice(start, nl < 0 ? bytes.length : nl);
        size += piece.length;
        if (size > LINE_MAX_BYTES) return { lines, over: true };
        parts.push(piece);
        if (nl < 0) return { lines, over: false };
        lines.push(joined());
        start = nl + 1;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The host.

/**
 * Runs one host: reads frames from `input` until a close frame, stdin EOF or a stop, and writes frames
 * to `output`. Resolves with the exit reason once the exit frame is written.
 *
 * powers: query (the SDK's), input (an async iterable of stdin chunks), output (writes one line),
 * schedule(ms, fn) => cancel, randomBytes(n) => Uint8Array, sha256(text) => hex, realpath(p) =>
 * Promise<string> (throws with a code), env (the host's own environment), log(line) optional.
 */
export function runHost(powers) {
  const { query, input, output, schedule, randomBytes, sha256, realpath, env } = powers;
  const log = typeof powers.log === 'function' ? powers.log : () => {};
  const inbox = makeInbox();
  const pending = new Map();
  const autoDenied = new Set();
  const sentUuids = new Set();
  /** Tool calls the gate saw: a sub-agent's call that ran without it stops the session (onSubResult). */
  const judged = new Set();
  /** Tool calls the gate or a person refused: their error result is no failed step. */
  const refused = new Set();
  /** A sub-agent's tool call -> the task that made it. */
  const toolOwner = new Map();
  /** A root Agent call -> the model reply it came in: the calls of one reply are one dispatch. */
  const replyOf = new Map();
  /** Sub-agents by task id: the tool call that started each, and whether its model was told. */
  const tasks = new Map();
  /** The tool call that started a task -> the task. */
  const taskByTool = new Map();
  /** Tasks whose end was told. */
  const endedTasks = new Set();
  /** A sub-agent's foreground command (a local_bash task) -> the sub-agent. */
  const commands = new Map();
  /** Dispatch tool calls orchestrad has not answered yet, by callId: the JSON-RPC id of each. */
  const dispatchCalls = new Map();
  /** The dispatch server's way to the CLI, once the SDK connected it. */
  let dispatchWire = null;
  let start = null;
  let started = false;
  let q = null;
  let realCwd = null;
  let guarded = [];
  let sessionId = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });

  const write = (frame) => {
    const line = JSON.stringify(frame);
    if (utf8Length(line) > LINE_MAX_BYTES) return false;
    output(`${line}\n`);
    return true;
  };
  const emit = (frame) => {
    if (finished) return;
    if (!write(frame)) finish('frame-too-large', frame.t);
  };

  function finish(reason, detail) {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.settle({ behavior: 'deny', message: DENY_MESSAGES.ending });
    pending.clear();
    for (const id of dispatchCalls.values()) mcpAnswer(id, false, DENY_MESSAGES.ending);
    dispatchCalls.clear();
    inbox.end();
    if (q !== null) {
      if (reason === 'safety-stop') {
        try {
          Promise.resolve(q.interrupt()).catch(() => {});
        } catch {
          // close() below ends it either way
        }
      }
      try {
        q.close();
      } catch {
        // nothing more to stop
      }
    }
    write(detail === undefined ? { t: 'exit', reason } : { t: 'exit', reason, detail });
    resolveDone(Object.freeze({ reason, detail: detail ?? null }));
  }

  const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // ---- the dispatch tool -----------------------------------------------------------------------------

  /** To the CLI; a query that closed first has nobody to hear it. */
  function mcpSend(m) {
    try {
      Promise.resolve(dispatchWire?.send(m)).catch(() => {});
    } catch {
      // as above
    }
  }

  function mcpAnswer(id, ok, text) {
    mcpSend({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(ok ? {} : { isError: true }) } });
  }

  /** The MCP messages the SDK hands over: the handshake, the one tool, a cancel. Everything else has no method here. */
  function onMcp(m) {
    const ok = (result) => mcpSend({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: DISPATCH_SERVER, version: '1.0.0' } });
    if (m.method === 'tools/list') return ok({ tools: start.frontDesk === null ? [DISPATCH_TOOL] : [DISPATCH_TOOL, STATUS_TOOL] });
    if (m.method === 'tools/call') {
      const read = start.frontDesk !== null && m.params?.name === STATUS_TOOL.name;
      if ((!read && m.params?.name !== DISPATCH_TOOL.name) || finished) return mcpAnswer(m.id, false, DENY_MESSAGES.disallowed);
      const callId = hexOf(randomBytes(16));
      dispatchCalls.set(callId, m.id);
      return emit({ t: read ? 'status' : 'dispatch', callId, input: isPlainObject(m.params.arguments) ? m.params.arguments : {} });
    }
    if (m.method === 'notifications/cancelled') {
      for (const [callId, id] of dispatchCalls) {
        if (id !== m.params?.requestId) continue;
        dispatchCalls.delete(callId);
        emit({ t: 'dispatch-gone', callId });
      }
      return undefined;
    }
    if (m.id !== undefined) mcpSend({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
    return undefined;
  }

  const dispatchServer = Object.freeze({
    async connect(transport) {
      dispatchWire = transport;
      transport.onmessage = onMcp;
      await transport.start?.();
    },
  });

  // ---- the permission gate -------------------------------------------------------------------------

  /** Is `at` (or what it resolves to) inside a protected root, or, for a tree, does it hold one? */
  async function reachOf(input, toolName) {
    const reach = toolReach(toolName, input, start.cwd, start.home);
    let isProtected = false;
    let inCwd = !reach.unplaced;
    for (const [list, tree] of [[reach.files, false], [reach.trees, true]]) {
      for (const lexical of list) {
        const real = await realOf(lexical, realpath);
        for (const at of real === null ? [lexical] : [lexical, real]) {
          const mine = isInside(at, start.cwd) || isInside(at, realCwd);
          if (guarded.some((g) => (isInside(at, g.at) && !(g.open && mine)) || (tree && isInside(g.at, at)))) isProtected = true;
        }
        if (real === null || !isInside(real, realCwd)) inCwd = false;
      }
    }
    return { isProtected, inCwd };
  }

  /**
   * The rules of design §2.2 as the probe amended them, in order: a protected path is denied without a
   * card; a background shell command is denied; a tool outside CORE_TOOLS is denied; a tainted session
   * asks for everything; Read, Glob and Grep inside cwd run by the CLI's default (which asks nobody);
   * everything else asks the human.
   */
  async function judge(toolName, input, agent) {
    if (typeof toolName !== 'string' || !isPlainObject(input)) return { verdict: 'deny', why: 'bad-input' };
    // A front desk has these two, whatever a session holds besides.
    if (start.frontDesk !== null && !FRONT_DESK_TOOLS.includes(toolName)) return { verdict: 'deny', why: 'disallowed' };
    // Not a call a card decides: orchestrad does, in dispatch.ts, whatever the session's taint. A front desk's read asks nobody either.
    if (toolName === DISPATCH_TOOL_ID || toolName === STATUS_TOOL_ID) {
      if (toolName === DISPATCH_TOOL_ID ? !start.dispatch : start.frontDesk === null) return { verdict: 'deny', why: 'disallowed' };
      return agent === null ? { verdict: 'dispatch' } : { verdict: 'deny', why: 'dispatch-subagent' };
    }
    // Starting a sub-agent is a card like any other call that is no read inside cwd: a person sees its whole prompt.
    if (SUBAGENT_TOOLS.includes(toolName)) {
      if (!start.subagents) return { verdict: 'deny', why: 'disallowed' };
      return agentInputOk(input) ? { verdict: 'ask' } : { verdict: 'deny', why: 'agent-input' };
    }
    if (!CORE_TOOLS.includes(toolName)) return { verdict: 'deny', why: 'disallowed' };
    const { isProtected, inCwd } = await reachOf(input, toolName);
    if (isProtected) return { verdict: 'deny', why: 'protected' };
    if (SHELL_TOOLS.includes(toolName) && input.run_in_background !== undefined && input.run_in_background !== false && input.run_in_background !== null) {
      return { verdict: 'deny', why: 'background' };
    }
    if (start.tainted) return { verdict: 'ask' };
    if (READ_TOOLS.includes(toolName) && inCwd) return { verdict: 'default' };
    return { verdict: 'ask' };
  }

  /** The sub-agent a gate input names, or null for the session's own call. */
  const agentOf = (id) => (typeof id === 'string' && id.length > 0 && id.length <= MAX_TOOL_USE_ID ? id : null);

  /** The gate saw this call. */
  function sawTool(toolUseId, agent) {
    if (typeof toolUseId !== 'string') return;
    judged.add(toolUseId);
    if (agent !== null) toolOwner.set(toolUseId, agent);
  }

  function deniedAuto(toolUseId, name, why, agent) {
    if (typeof toolUseId !== 'string' || autoDenied.has(toolUseId)) return;
    autoDenied.add(toolUseId);
    refused.add(toolUseId);
    emit({ t: 'denied-auto', toolUseId, name: typeof name === 'string' ? name : '', why, ...(agent === null ? {} : { agentId: agent }) });
  }

  const hookOut = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });

  async function preToolUse(hookInput) {
    if (!isPlainObject(hookInput) || hookInput.hook_event_name !== 'PreToolUse') return {};
    const toolUseId = hookInput.tool_use_id;
    const agent = agentOf(hookInput.agent_id);
    sawTool(toolUseId, agent);
    if (finished) return hookOut('deny', DENY_MESSAGES.ending);
    const j = await judge(hookInput.tool_name, hookInput.tool_input, agent);
    if (j.verdict === 'deny') {
      deniedAuto(toolUseId, hookInput.tool_name, j.why, agent);
      return hookOut('deny', DENY_MESSAGES[j.why]);
    }
    if (j.verdict === 'dispatch') return hookOut('allow', 'Orchestra decides this call itself.');
    if (j.verdict === 'ask') return hookOut('ask', 'Orchestra asks the user.');
    return {};
  }

  const deny = (key) => ({ behavior: 'deny', message: DENY_MESSAGES[key] });

  /**
   * What an ask frame names besides its preview, for orchestrad to judge and title the card with: the
   * places the call reaches (absolute, lexical, as toolReach places them; at most ASK_PATHS_MAX) and
   * `subject`, one line: a shell command's first line, else the first place (redacted, invisible
   * characters written out, at most SUBJECT_MAX_BYTES). The preview stays what the person allows.
   */
  function askPlaces(toolName, input) {
    const reach = toolReach(toolName, input, start.cwd, start.home);
    const all = [...reach.files, ...reach.trees];
    // A place too long to name whole is not named: the card then says the call reaches somewhere unplaced.
    const paths = all.filter((p) => p.length <= ASK_PATH_MAX_CHARS).slice(0, ASK_PATHS_MAX);
    const raw = SHELL_TOOLS.includes(toolName) && typeof input.command === 'string' ? input.command.split('\n', 1)[0] : (paths[0] ?? '');
    const subject = splitUtf8(escapeInvisible(redactSecrets(raw).text), SUBJECT_MAX_BYTES)[0] ?? '';
    return { paths, unplaced: reach.unplaced || paths.length !== all.length, subject };
  }

  async function canUseTool(toolName, toolInput, options) {
    if (finished) return deny('ending');
    const opts = options !== null && typeof options === 'object' ? options : {};
    const toolUseId = opts.toolUseID;
    const signal = opts.signal;
    if (typeof toolUseId !== 'string' || toolUseId.length === 0 || toolUseId.length > MAX_TOOL_USE_ID) return deny('bad-input');
    const agent = agentOf(opts.agentID);
    sawTool(toolUseId, agent);
    // The hook's rules again: a call that reaches canUseTool by any route is judged the same. A call
    // the CLI would have run by default is asked about here too: once it is here, a human decides.
    const j = await judge(toolName, toolInput, agent);
    if (finished) return deny('ending');
    if (j.verdict === 'deny') {
      deniedAuto(toolUseId, toolName, j.why, agent);
      return deny(j.why);
    }
    if (j.verdict === 'dispatch') return { behavior: 'allow', updatedInput: toolInput };
    let digest;
    let preview;
    let inputBytes;
    try {
      digest = sha256(canonicalJson({ toolName, toolUseId, input: toolInput }));
      inputBytes = utf8Length(canonicalJson(toolInput));
      preview = buildPreview(toolInput);
    } catch {
      deniedAuto(toolUseId, toolName, 'bad-input', agent);
      return deny('bad-input');
    }
    const reqId = hexOf(randomBytes(16));
    return new Promise((resolve) => {
      let cancelTimer = () => {};
      const onAbort = () => {
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        emit({ t: 'ask-gone', reqId });
        entry.settle(deny('aborted'));
      };
      const entry = {
        toolName,
        toolUseId,
        input: toolInput,
        digest,
        settle(result) {
          if (result.behavior === 'deny') refused.add(toolUseId);
          cancelTimer();
          signal?.removeEventListener?.('abort', onAbort);
          resolve(result);
        },
      };
      pending.set(reqId, entry);
      cancelTimer = schedule(start.askTimeoutMs + ASK_BACKSTOP_EXTRA_MS, () => {
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        emit({ t: 'ask-gone', reqId });
        entry.settle(deny('timeout'));
      });
      emit({
        t: 'ask', reqId, toolName, toolUseId, preview: preview.preview, inputBytes, digest, redactions: preview.redactions, tooLong: preview.tooLong, risk: riskOf(toolName, false),
        ...askPlaces(toolName, toolInput),
        ...(agent === null ? {} : { agentId: agent }),
      });
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  // ---- what the SDK says ---------------------------------------------------------------------------

  const stop = (check) => finish('safety-stop', check);

  /** A line of what the model wrote for a member (its description, its kind), at most SUBJECT_MAX_BYTES. */
  const memberText = (v) => (typeof v === 'string' ? splitUtf8(escapeInvisible(redactSecrets(v.split('\n', 1)[0]).text), SUBJECT_MAX_BYTES)[0] ?? null : null);

  function endTask(taskId, status) {
    if (!tasks.has(taskId) || endedTasks.has(taskId) || !Object.hasOwn(TASK_ENDS, status)) return;
    endedTasks.add(taskId);
    emit({ t: 'sub-end', taskId, status: TASK_ENDS[status] });
  }

  /**
   * The life of a sub-agent. Only states go on: task_started's prompt, task_progress's and task_notification's
   * summary are its words and stay here. local_agent is a sub-agent, local_bash a foreground command, each its own
   * task (measured); any other kind is not read.
   */
  function onTask(m) {
    const id = agentOf(m.task_id);
    if (id === null) return;
    if (m.subtype === 'task_started' && m.task_type === 'local_agent') {
      const toolUseId = typeof m.tool_use_id === 'string' ? m.tool_use_id : null;
      tasks.set(id, { modelTold: false });
      if (toolUseId !== null) taskByTool.set(toolUseId, id);
      emit({ t: 'sub-start', taskId: id, name: memberText(m.description), type: memberText(m.subagent_type), depth: Number.isSafeInteger(m.spawn_depth) ? m.spawn_depth : null, reply: replyOf.get(toolUseId) ?? null });
    } else if (m.subtype === 'task_started' && m.task_type === 'local_bash') {
      const owner = toolOwner.get(m.tool_use_id);
      if (owner === undefined || !tasks.has(owner)) return;
      commands.set(id, owner);
      emit({ t: 'sub-cmd', taskId: owner, id, open: true });
    } else if (m.subtype === 'task_progress') {
      if (tasks.has(id)) emit({ t: 'sub-progress', taskId: id });
    } else if (m.subtype === 'task_updated') {
      if (isPlainObject(m.patch)) endTask(id, m.patch.status);
    } else if (m.subtype === 'task_notification') {
      endTask(id, m.status);
      const owner = commands.get(id);
      if (owner === undefined) return;
      commands.delete(id);
      emit({ t: 'sub-cmd', taskId: owner, id, open: false });
    }
  }

  /** What a sub-agent's model wrote: its words stay here, the guard above read its model. */
  function onSubAssistant(m, message) {
    const taskId = taskByTool.get(m.parent_tool_use_id);
    const task = taskId === undefined ? undefined : tasks.get(taskId);
    if (task === undefined || task.modelTold || typeof message.model !== 'string' || message.model === SYNTHETIC_MODEL) return;
    task.modelTold = true;
    emit({ t: 'sub-model', taskId, model: message.model });
  }

  /**
   * What came back of a sub-agent's tool calls. A result the gate never saw is a call that ran past the hook and
   * canUseTool: nothing measured does that, and approvals are what let sub-agents run at all, so the session stops.
   * A call that never ran (bad input, an unknown tool) has an error result and never reached the hook.
   */
  function onSubResult(m) {
    const content = isPlainObject(m.message) && Array.isArray(m.message.content) ? m.message.content : [];
    const taskId = taskByTool.get(m.parent_tool_use_id);
    for (const b of content) {
      if (!isPlainObject(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      if (b.is_error !== true) {
        if (!judged.has(b.tool_use_id)) return stop('unjudged-tool');
      } else if (taskId !== undefined && !refused.has(b.tool_use_id)) {
        emit({ t: 'sub-failed', taskId });
      }
    }
  }

  function onMessage(m) {
    if (!isPlainObject(m)) return;
    if (m.type === 'system' && m.subtype === 'init') {
      const problem = initProblem(m, start.model, start.subagents, start.dispatch, start.frontDesk !== null);
      if (problem !== null) return stop(problem);
      if (m.session_id !== sessionId) {
        sessionId = m.session_id;
        emit({ t: 'init', sessionId, model: m.model, permissionMode: m.permissionMode, tools: [...m.tools], mcpServers: [], plugins: m.plugins.map(pluginName), skills: [...m.skills] });
      }
      return;
    }
    if (m.type === 'system' && typeof m.subtype === 'string' && m.subtype.startsWith('task_')) return onTask(m);
    if (m.type === 'user' && typeof m.parent_tool_use_id === 'string') return onSubResult(m);
    if (m.type === 'command_lifecycle') {
      if (typeof m.command_uuid === 'string' && LIFECYCLE_STATES.includes(m.state)) emit({ t: 'lifecycle', uuid: m.command_uuid, state: m.state });
      return;
    }
    if (m.type === 'assistant') {
      if (sessionId === null) return stop('no-init');
      const message = isPlainObject(m.message) ? m.message : {};
      if (message.model !== undefined && !start.models.includes(message.model) && message.model !== SYNTHETIC_MODEL) return stop('model');
      if (typeof m.parent_tool_use_id === 'string') return onSubAssistant(m, message);
      const uuid = typeof m.uuid === 'string' ? m.uuid : null;
      for (const b of Array.isArray(message.content) ? message.content : []) {
        if (!isPlainObject(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') for (const chunk of splitUtf8(b.text, TEXT_CHUNK_BYTES)) emit({ t: 'text', uuid, chunk });
        if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
        // A dispatch is told by its sub-start, not as a tool row. One reply's calls share message.id (sdk.d.ts).
        if (SUBAGENT_TOOLS.includes(b.name)) replyOf.set(b.id, agentOf(message.id));
        // A dispatch tool call is told by orchestrad's own note, not as a tool row; so is a front desk's read.
        else if (b.name !== DISPATCH_TOOL_ID && b.name !== STATUS_TOOL_ID) emit({ t: 'tool', toolUseId: b.id, name: b.name });
      }
      return;
    }
    if (m.type === 'result') {
      if (sessionId === null) return stop('no-init');
      if (m.modelUsage !== undefined && (!isPlainObject(m.modelUsage) || Object.keys(m.modelUsage).some((k) => !start.models.includes(k)))) return stop('model');
      // error_max_turns ends this turn only (probe §10 item 4): the session goes on.
      emit({
        t: 'result',
        subtype: typeof m.subtype === 'string' ? m.subtype : null,
        costUsd: typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null,
        uuid: typeof m.user_message_uuid === 'string' ? m.user_message_uuid : null,
      });
    }
  }

  async function pump() {
    try {
      for await (const m of q) {
        if (finished) return;
        onMessage(m);
        if (finished) return;
      }
    } catch {
      finish('sdk-error');
      return;
    }
    finish('sdk-ended');
  }

  // ---- what orchestrad says ------------------------------------------------------------------------

  async function onStart(f) {
    if (started) return finish('bad-frame', 'second-start');
    started = true;
    const parsed = parseStart(f, env);
    if (!parsed.ok) return finish('bad-start', parsed.field);
    start = parsed.start;
    try {
      realCwd = winAbsolute(await realpath(start.cwd));
    } catch {
      realCwd = null;
    }
    if (realCwd === null) return finish('bad-start', 'cwd');
    const roots = [];
    for (const r of start.protectedRoots) {
      const hard = start.hardRoots.includes(r);
      roots.push({ at: r, hard, open: false });
      const real = await realOf(r, realpath);
      if (real !== null) roots.push({ at: real, hard, open: false });
    }
    // The cwd holds no protected root, and lies in one only through the owned work root exemption.
    for (const g of roots) {
      for (const c of [start.cwd, realCwd]) {
        if (isInside(g.at, c)) return finish('bad-start', 'cwd-protected');
        if (!isInside(c, g.at)) continue;
        if (g.hard || workRootOf(c, g.at) === null) return finish('bad-start', 'cwd-protected');
        g.open = true;
      }
    }
    guarded = roots;
    if (finished) return;
    try {
      q = query({ prompt: inbox, options: sdkOptions(start, env, { preToolUse, canUseTool, dispatchServer }) });
    } catch {
      return finish('sdk-error');
    }
    pump();
  }

  function onUser(f) {
    if (q === null) return finish('bad-frame', 'user-before-start');
    if (!onlyKeys(f, ['t', 'uuid', 'text']) || typeof f.uuid !== 'string' || !UUID.test(f.uuid) || typeof f.text !== 'string' || f.text.length === 0) {
      return finish('bad-frame', 'user');
    }
    // orchestrad refuses these first (design §5); a slash command or a reused uuid never reaches the CLI.
    if (sentUuids.has(f.uuid) || /^\s*\//.test(f.text)) return emit({ t: 'lifecycle', uuid: f.uuid, state: 'refused' });
    sentUuids.add(f.uuid);
    inbox.push({ type: 'user', uuid: f.uuid, message: { role: 'user', content: f.text }, parent_tool_use_id: null, origin: { kind: 'human' } });
  }

  function onPerm(f) {
    if (!onlyKeys(f, ['t', 'reqId', 'allow', 'digest']) || typeof f.reqId !== 'string' || !REQ_ID.test(f.reqId) || typeof f.allow !== 'boolean' || typeof f.digest !== 'string' || !DIGEST.test(f.digest)) {
      return finish('bad-frame', 'perm');
    }
    const p = pending.get(f.reqId);
    if (p === undefined) {
      log(`perm for an unknown reqId dropped: ${f.reqId}`);
      return;
    }
    pending.delete(f.reqId);
    if (!f.allow) return p.settle(deny('user'));
    // The digest is taken again over the input the host kept: what was allowed is what runs.
    let again;
    try {
      again = sha256(canonicalJson({ toolName: p.toolName, toolUseId: p.toolUseId, input: p.input }));
    } catch {
      again = null;
    }
    if (again !== p.digest || f.digest !== p.digest) return p.settle(deny('digest'));
    p.settle({ behavior: 'allow', updatedInput: p.input });
  }

  function onDispatchReply(f) {
    if (!onlyKeys(f, ['t', 'callId', 'ok', 'text']) || typeof f.callId !== 'string' || !REQ_ID.test(f.callId) || typeof f.ok !== 'boolean' || typeof f.text !== 'string') return finish('bad-frame', 'dispatch-reply');
    const id = dispatchCalls.get(f.callId);
    // The CLI gave up on it first (a stop): its answer has nowhere to go.
    if (id === undefined) return undefined;
    dispatchCalls.delete(f.callId);
    return mcpAnswer(id, f.ok, f.text);
  }

  function onInterrupt(f) {
    if (q === null || !onlyKeys(f, ['t'])) return finish('bad-frame', 'interrupt');
    let receipt;
    try {
      receipt = Promise.resolve(q.interrupt());
    } catch {
      receipt = Promise.reject(new Error('interrupt failed'));
    }
    // stillQueued null: the CLI said nothing usable, and orchestrad closes the session (design §2.5).
    receipt.then(
      (r) => emit({ t: 'interrupted', stillQueued: isPlainObject(r) && Array.isArray(r.still_queued) ? r.still_queued.length : null }),
      () => emit({ t: 'interrupted', stillQueued: null }),
    );
  }

  async function onLine(bytes) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return finish('bad-frame', 'utf8');
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return finish('bad-frame', 'json');
    }
    if (!isPlainObject(f) || typeof f.t !== 'string') return finish('bad-frame', 'shape');
    switch (f.t) {
      case 'start':
        return onStart(f);
      case 'user':
        return onUser(f);
      case 'perm':
        return onPerm(f);
      case 'interrupt':
        return onInterrupt(f);
      case 'dispatch-reply':
        return onDispatchReply(f);
      case 'close':
        return onlyKeys(f, ['t']) ? finish('closed') : finish('bad-frame', 'close');
      default:
        return finish('bad-frame', 'type');
    }
  }

  async function readLoop() {
    const lines = lineSplitter();
    for await (const chunk of input) {
      if (finished) return;
      const got = lines.push(typeof chunk === 'string' ? ENCODER.encode(chunk) : chunk);
      for (const line of got.lines) {
        await onLine(line);
        if (finished) return;
      }
      if (got.over) return finish('line-too-long');
    }
    // stdin EOF: orchestrad is gone. close() ends claude.exe, then the host exits.
    finish('stdin-eof');
  }

  readLoop().catch(() => finish('host-error'));
  return done;
}
