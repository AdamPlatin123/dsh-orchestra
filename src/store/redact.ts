import { ownEnv, ownFields } from '../runtime/own.ts';
import { frozen, frozenClass } from '../../shared/frozen.js';

// Redaction of source text before it reaches the snippet table (plan step 3, r4 §6.1 #1, invariant
// 14). Three layers, applied in this order to every text:
//
//   3. whole-block drop: the output of `env`, `printenv`, `Get-ChildItem env:` (and its aliases) and of
//      a tool that read a `.env*` file is dropped whole, as is text that looks like such a dump, since
//      the command is not always known;
//   1. known values, replaced exactly: tokens you pasted, and every value of orchestrad's own
//      environment of at least MIN_KNOWN characters, except path-like values (a drive letter or UNC
//      at the start) and a fixed list of system variables (代-10); an unknown variable's value is
//      replaced, as r4 says;
//   2. format rules (provider key prefixes, JWT, PEM, Authorization and bearer, key=value secrets,
//      credentials in URLs), then high-entropy tokens.
//
// The result is a pure function of the redactor's inputs and the text: no clock, no randomness, no
// locale. `verdict` is the small structured value a judgment record keeps (which layers hit, how
// many), never the text. REDACT_VERSION changes whenever a rule does, so a recomputation in CI can
// tell a rule change from a regression. The exported tables are frozen through and through
// (shared/frozen.js): redact() reads FORMAT_RULES on every text, and a module that emptied it would
// let every secret through. A frozen RegExp cannot be handed to replace() with its g flag (replace
// resets lastIndex first), so redact() uses a fresh copy of each, made from its internal pattern.

// 2 (2026-11-03): the entropy rule lets path-like names through (isPathLikeName), in every text.
// 3 (2026-11-03): only in a text marked `name: true` (a project's directory name); every other text is
//   judged as in 1 again, so a pass phrase or a grouped key in an event or a snippet is replaced.
export const REDACT_VERSION = 3;

/** Known values shorter than this are not replaced: they would wreck ordinary text and are no secret. */
export const MIN_KNOWN = 8;

/** System variables whose values are never replaced (代-10). A trailing `*` matches any suffix. Case-insensitive, as Windows names are. */
export const SYSTEM_VARIABLES: readonly string[] = frozen([
  'PATH', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'SystemRoot', 'windir', 'ProgramFiles*', 'OS', 'PROCESSOR_*', 'NUMBER_OF_PROCESSORS', 'PSModulePath', 'ComSpec',
]);

const PATH_LIKE = /^(?:[A-Za-z]:|\\\\)/;

export function isSystemVariable(name: string): boolean {
  const n = name.toUpperCase();
  return SYSTEM_VARIABLES.some((v) => {
    const u = v.toUpperCase();
    return u.endsWith('*') ? n.startsWith(u.slice(0, -1)) : n === u;
  });
}

/** Is this env value replaced in every text (layer 1)? */
export function isKnownEnvValue(name: string, value: string): boolean {
  return value.length >= MIN_KNOWN && !PATH_LIKE.test(value) && !isSystemVariable(name);
}

export type FormatRule = { id: string; re: RegExp; keep?: number };

/**
 * Layer 2, in order (the more specific prefix first). `keep` names a capture group kept verbatim in
 * front of the marker (the key of key=value, the header name), so the text still reads.
 */
export const FORMAT_RULES: readonly FormatRule[] = frozen([
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
]);

/** A high-entropy token: at least this long, with a letter and a digit, and at least ENTROPY_BITS bits per character. */
export const ENTROPY_MIN_LENGTH = 20;
export const ENTROPY_BITS = 3.5;
const TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;

/** Shannon entropy in bits per character over UTF-16 code units. */
export function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  // Sorted, so the float sum is the same whatever order the map was filled in.
  for (const c of [...counts.values()].sort((a, b) => a - b)) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function isHighEntropy(token: string): boolean {
  return token.length >= ENTROPY_MIN_LENGTH && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && entropyBits(token) >= ENTROPY_BITS;
}

// Path-like names (orchestra app, 2026-11-03). A name built from words joined by - _ / reaches 3.5
// bits per character as easily as a key does: Claude Code names a project directory after the whole
// cwd (`G---Projects-shop--claude-worktrees-zen-superagent-exploration-04992d`), a worktree or a
// branch reads `feature-login-v2-final`, and the entropy rule took them all for secrets. Shannon
// entropy counts which characters occur, not whether they form words; the test below looks at the
// pieces instead. A key that random characters make up has long pieces that mix case and digits (or
// hold `+` and `=`), and those are what it refuses:
//
//   cut at - _ / (empty pieces dropped: Claude writes each character that is no letter or digit as
//   `-`, so `G:\_Projects` reads `G---Projects`). The name is path-like when it has two pieces or
//   more, every piece is one of
//     - a word: letters in lower case, Capitalized, or camelCase whose humps have 2 lower-case
//       letters or more (`superagent`, `Users`, `myApp`, `TowerView`), optionally followed by up to 4
//       digits (`Folder2`, `python311`);
//     - capitals: up to 10 capital letters, optionally followed by up to 4 digits (`C`, `README`);
//     - a number: digits only (`2024`);
//     - a short tag: up to 8 lower-case letters and digits (`v2`, `node24`, `04992d`, a short hash);
//   and the letters of words of 3 letters or more are at least half of its characters (separators
//   not counted). Capitals and tags never count toward that half: random base32 is all capitals,
//   random hex makes short tags.
//
// So a base64 or hex key, a UUID, a key with a readable prefix (`sk_live_<random>`, `xoxb-<digits>-
// <random>`) and a run of short mixed pieces (`a1b2c-3d4e5-f6g7h-8i9j0`) are judged by entropy as
// before. What goes through is anything made of word-like pieces, and secrets are made that way too:
// a pass phrase (`correct-horse-battery-staple-42`, every one), a 6-6-6 strong password of the kind a
// keychain suggests (about half), lower-case base32 in groups of 4 (about half), lower-case letters
// and digits in groups of 5 (about 1 in 7). So this test applies only where the text is a directory's
// name, which redact() is told by `name: true` (src/sources/stage.ts, a lane's name from a cwd); every
// other text (events, snippets, owned-session text, the router's titles) is judged by entropy alone.
// The format rules run first and are untouched, and so are the known values.
const PATH_SEPARATORS = /[-_/]+/;
const WORD_PIECE = /^([a-z]+|[A-Z][a-z]+|[a-z]+(?:[A-Z][a-z]{2,})+|[A-Z][a-z]{2,}(?:[A-Z][a-z]{2,})+)[0-9]{0,4}$/;
const CAPITALS_PIECE = /^[A-Z]{1,10}[0-9]{0,4}$/;
const NUMBER_PIECE = /^[0-9]+$/;
const TAG_PIECE = /^[a-z0-9]{1,8}$/;
const LONG_WORD = 3;

/** Is `token` a name made of words, numbers and short tags joined by - _ / (see above), not a secret? */
export function isPathLikeName(token: string): boolean {
  const pieces = token.split(PATH_SEPARATORS).filter((p) => p !== '');
  if (pieces.length < 2) return false;
  let chars = 0;
  let wordChars = 0;
  for (const p of pieces) {
    chars += p.length;
    const word = WORD_PIECE.exec(p);
    if (word !== null) {
      if (word[1]!.length >= LONG_WORD) wordChars += word[1]!.length;
    } else if (!CAPITALS_PIECE.test(p) && !NUMBER_PIECE.test(p) && !TAG_PIECE.test(p)) return false;
  }
  return wordChars * 2 >= chars;
}

/** Commands whose whole output is dropped (layer 3): env dumps and reads of .env files. */
const ENV_COMMANDS: readonly RegExp[] = [
  /(?:^|[\s;&|("'`])(?:env|set|export\s+-p|declare\s+-x)\s*(?:$|[;&|)"'`])/i,
  /\bprintenv\b/i,
  /\b(?:Get-ChildItem|gci|dir|ls|Get-Item|gi)\s+(?:-Path\s+)?env:/i,
  /\[\s*(?:System\.)?Environment\s*\]\s*::\s*GetEnvironmentVariables/i,
  /(?:^|[\s"'\\/=])\.env(?:\.[\w.-]+)?(?:$|[\s"'])/i,
];

const ENV_LINE = /^\s*(?:export\s+|declare\s+-x\s+)?[A-Za-z_][A-Za-z0-9_()]*=/;
const PS_ENV_HEADER = /^\s*Name\s+Value\s*$/m;

/** Does `text` look like an env dump: a `Name Value` table, or at least 3 lines of which at least half are NAME=value? */
export function looksLikeEnvDump(text: string): boolean {
  if (PS_ENV_HEADER.test(text) && /^\s*-{4}\s+-{5}\s*$/m.test(text)) return true;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  return lines.filter((l) => ENV_LINE.test(l)).length * 2 >= lines.length;
}

export function isEnvCommand(command: string): boolean {
  return ENV_COMMANDS.some((re) => re.test(command));
}

export type RedactInput = {
  text: string;
  /** The command or tool input that produced `text`, when the source knows it (a tool_use's command, say). */
  command?: string;
  /**
   * `text` is a directory's name (a project's, from a cwd), not free text: a name made of words and
   * short tags passes the entropy rule (isPathLikeName). Nothing else sets it.
   */
  name?: boolean;
};

/** Small and structured: what a judgment record stores (plan step 3), never the text. Keys in a fixed order. */
export type RedactVerdict = {
  ver: number;
  dropped: 'env-dump' | null;
  known: number;
  format: Readonly<Record<string, number>>;
  entropy: number;
};

export type RedactResult = { text: string; verdict: RedactVerdict };

export type RedactorConfig = {
  /** orchestrad's own environment (process.env): read once, own entries only. */
  env: Readonly<Record<string, string | undefined>>;
  /** Tokens you pasted (a /connect token, say); each at least MIN_KNOWN characters. */
  secrets?: readonly string[];
};

export class RedactError extends Error {
  readonly code = 'ERR_ORCHESTRA_REDACT';
}
frozenClass(RedactError);

export const marker = (rule: string) => `[redacted:${rule}]`;

/** A string-to-string redact over `r`: free text by default, a directory's name with `as = 'name'` (see RedactInput.name). */
export function redactText(r: Redactor): (text: string, as?: 'name') => string {
  return (text, as) => r.redact(as === 'name' ? { text, name: true } : { text }).text;
}

export type Redactor = { redact(input: RedactInput): RedactResult; readonly knownCount: number };

/**
 * Builds a redactor over a fixed set of known values: the longest first, so a value that contains
 * another is replaced whole. The env is copied once; a later change to process.env does not reach it.
 */
export function makeRedactor(config: RedactorConfig): Redactor {
  const cfg = ownFields(config, ['env', 'secrets'] as const);
  if (typeof cfg.env !== 'object' || cfg.env === null) throw new RedactError('redactor: env is required');
  const known = new Set<string>();
  const env = ownEnv(cfg.env);
  for (const name of Object.keys(env)) if (isKnownEnvValue(name, env[name]!)) known.add(env[name]!);
  for (const s of cfg.secrets ?? []) {
    if (typeof s !== 'string' || s.length < MIN_KNOWN) throw new RedactError(`redactor: a pasted secret must be a string of at least ${MIN_KNOWN} characters`);
    known.add(s);
  }
  const values = [...known].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze({
    knownCount: values.length,
    redact: (input: RedactInput) => redactWith(values, input),
  });
}

/**
 * Every occurrence of every known value in `text`, overlapping ones included, merged into disjoint
 * [start, end) spans in text order. Replacing value by value would leave the tail of a second secret
 * that overlaps the first; merging first replaces both whole.
 */
export function knownSpans(values: readonly string[], text: string): [number, number][] {
  const hits: [number, number][] = [];
  for (const v of values) {
    for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1)) hits.push([at, at + v.length]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const last = merged.at(-1);
    if (last !== undefined && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  return merged;
}

function redactWith(values: readonly string[], given: RedactInput): RedactResult {
  const input = ownFields(given, ['text', 'command', 'name'] as const);
  const asName = input.name === true;
  if (typeof input.text !== 'string') throw new RedactError('redact: text must be a string');
  const format: Record<string, number> = {};
  if ((typeof input.command === 'string' && isEnvCommand(input.command)) || looksLikeEnvDump(input.text)) {
    return { text: marker('env-dump'), verdict: { ver: REDACT_VERSION, dropped: 'env-dump', known: 0, format, entropy: 0 } };
  }
  const spans = knownSpans(values, input.text);
  let text = input.text;
  for (let i = spans.length - 1; i >= 0; i--) text = `${text.slice(0, spans[i]![0])}${marker('known')}${text.slice(spans[i]![1])}`;
  const known = spans.length;
  for (const rule of FORMAT_RULES) {
    text = text.replace(new RegExp(rule.re), (...m: unknown[]) => {
      format[rule.id] = (format[rule.id] ?? 0) + 1;
      return `${rule.keep !== undefined ? String(m[rule.keep] ?? '') : ''}${marker(rule.id)}`;
    });
  }
  let entropy = 0;
  text = text.replace(TOKEN, (t) => {
    if (!isHighEntropy(t) || (asName && isPathLikeName(t))) return t;
    entropy++;
    return marker('entropy');
  });
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(format).sort()) sorted[k] = format[k]!;
  return { text, verdict: { ver: REDACT_VERSION, dropped: null, known, format: sorted, entropy } };
}
