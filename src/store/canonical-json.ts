import * as crypto from 'node:crypto';
import { frozenClass } from '../../shared/frozen.js';

// The canonical JSON encoding every digest is taken over (plan step 3: journal digest = sha256 of the
// canonical body, the requestDigest of a human verb, view-parity's byte-equal snapshots). One value has
// exactly one encoding, and a value that could have two, or that would not survive a round trip, is
// refused instead of being made to fit:
//
//   - Keys are sorted by UTF-16 code units (RFC 8785's order), never by locale.
//   - Numbers are safe integers only. NaN and Infinity have no JSON form; an integer beyond 2^53 - 1
//     does not round-trip through a JS number; a fraction would make the digest rest on float
//     formatting. -0 is the integer 0 and is written 0 (as JSON.stringify and RFC 8785 do); the text
//     "-0" is therefore never canonical. A bigint is refused: encode it as a decimal string first.
//   - Strings must be well-formed UTF-16: a lone surrogate has no UTF-8 form. They are not normalized:
//     two strings are equal when their code points are (NTFS does not normalize names either, so the
//     NFC and NFD spellings of a cwd are two different directories). Escaping is JSON.stringify's
//     (ES2019 well-formed): '"', '\' and U+0000–U+001F only.
//   - Only null, booleans, strings, numbers, arrays and plain objects (prototype Object.prototype or
//     null). undefined, functions, symbols, class instances (a Map, a Buffer), accessors, sparse or
//     decorated arrays, symbol keys and cycles are refused, as is nesting deeper than MAX_DEPTH.

export const MAX_DEPTH = 64;

export type CanonicalReason =
  | 'non-finite'
  | 'unsafe-integer'
  | 'non-integer'
  | 'bigint'
  | 'lone-surrogate'
  | 'bad-type'
  | 'not-plain'
  | 'accessor'
  | 'symbol-key'
  | 'sparse-array'
  | 'array-extra-key'
  | 'cycle'
  | 'too-deep'
  | 'not-json'
  | 'not-canonical';

export class CanonicalJsonError extends Error {
  readonly code = 'ERR_ORCHESTRA_CANONICAL_JSON';
  readonly reason: CanonicalReason;
  /** Where in the value: `$`, then `[i]` for an index and `.<n>` for the n-th key in canonical order (no key text, which may be source text). */
  readonly at: string;
  constructor(reason: CanonicalReason, at: string) {
    super(`[ERR_ORCHESTRA_CANONICAL_JSON] ${reason} at ${at}`);
    this.reason = reason;
    this.at = at;
  }
}
frozenClass(CanonicalJsonError);

function encodeNumber(n: number, at: string): string {
  if (!Number.isFinite(n)) throw new CanonicalJsonError('non-finite', at);
  if (!Number.isInteger(n)) throw new CanonicalJsonError('non-integer', at);
  if (!Number.isSafeInteger(n)) throw new CanonicalJsonError('unsafe-integer', at);
  // String(-0) is '0', so -0 needs no branch of its own (parseCanonical refuses the text "-0").
  return String(n);
}

function encodeString(s: string, at: string): string {
  if (!s.isWellFormed()) throw new CanonicalJsonError('lone-surrogate', at);
  return JSON.stringify(s);
}

/** The value of an own data property; an accessor is refused, its getter never runs. */
function dataValue(o: object, key: string, at: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !('value' in d)) throw new CanonicalJsonError('accessor', at);
  return d.value;
}

function encode(v: unknown, at: string, depth: number, open: Set<object>): string {
  switch (typeof v) {
    case 'string':
      return encodeString(v, at);
    case 'number':
      return encodeNumber(v, at);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalJsonError('bigint', at);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError('bad-type', at);
  }
  if (v === null) return 'null';
  if (depth >= MAX_DEPTH) throw new CanonicalJsonError('too-deep', at);
  if (open.has(v)) throw new CanonicalJsonError('cycle', at);
  open.add(v);
  try {
    if (Object.getOwnPropertySymbols(v).length > 0) throw new CanonicalJsonError('symbol-key', at);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) throw new CanonicalJsonError('not-plain', at);
      const len = v.length;
      const keys = Object.getOwnPropertyNames(v);
      // An array's own names are its indices and 'length'; anything else is a decorated array.
      if (keys.length !== len + 1) {
        const holes = keys.filter((k) => k !== 'length' && String(Number(k)) === k).length !== len;
        throw new CanonicalJsonError(holes ? 'sparse-array' : 'array-extra-key', at);
      }
      const parts: string[] = [];
      for (let i = 0; i < len; i++) {
        if (!Object.hasOwn(v, i)) throw new CanonicalJsonError('sparse-array', `${at}[${i}]`);
        parts.push(encode(dataValue(v, String(i), `${at}[${i}]`), `${at}[${i}]`, depth + 1, open));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError('not-plain', at);
    // Every own string key, enumerable or not: a hidden field would otherwise drop out of the digest.
    const keys = Object.getOwnPropertyNames(v).sort();
    const parts: string[] = [];
    keys.forEach((k, i) => {
      const where = `${at}.${i}`;
      parts.push(`${encodeString(k, where)}:${encode(dataValue(v, k, where), where, depth + 1, open)}`);
    });
    return `{${parts.join(',')}}`;
  } finally {
    open.delete(v);
  }
}

/** The canonical encoding of `value`; throws CanonicalJsonError for anything that has none. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', 0, new Set());
}

/** sha256 over the UTF-8 bytes of the canonical encoding, as 64 lowercase hex digits. */
export function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Parses `text` and checks it is the canonical encoding of what it parses to: the same bytes come back.
 * Catches duplicate keys (JSON.parse keeps the last), "-0", integers that lost precision, unsorted
 * keys, extra whitespace and escapes JSON.stringify would not write.
 */
export function parseCanonical(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CanonicalJsonError('not-json', '$');
  }
  if (canonicalJson(value) !== text) throw new CanonicalJsonError('not-canonical', '$');
  return value;
}
