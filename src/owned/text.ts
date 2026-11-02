import { frozen } from '../../shared/frozen.js';

// Text as owned sessions show it (alpha 0.2 slice design §2.6, §2.8): what the page shows is what the
// child runs, so invisible characters are written out, never removed; a feed text is at most 2 KB and
// an approval preview at most 16 KiB of UTF-8. Redaction always comes first and the cut after it, so a
// cut never halves a secret the redactor would have known whole.

export const OWNED_TEXT_LIMITS = frozen({
  /** One feed event's text, in UTF-8 bytes (slice design §2.8). */
  feedBytes: 2048,
  /** One approval preview, in UTF-8 bytes (slice design §2.6). */
  previewBytes: 16 * 1024,
});

// Control, format (bidi, zero-width, tags), separator and surrogate code points, and the invisible
// fillers and variation selectors that are none of those. A tab, a newline and the CR of a CRLF stay.
// The same class as hosts/claude/host-core.mjs's escapeInvisible.
const INVISIBLE = /(?![\t\n])(?!\r\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/gu;

/** Invisible characters written out as `\uXXXX` (or `\u{XXXXX}`), never removed. */
export function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE, (ch) => {
    const cp = ch.codePointAt(0)!;
    const hex = cp.toString(16).toUpperCase();
    return cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

export const utf8Length = (s: string): number => Buffer.byteLength(s, 'utf8');

/** `text` in pieces of at most `max` UTF-8 bytes, cut on code point boundaries; joined, they are `text`. */
export function splitUtf8(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  let size = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
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

/** The first `max` UTF-8 bytes of `text` (whole code points), and whether anything was cut. */
export function headUtf8(text: string, max: number): { text: string; cut: boolean } {
  if (utf8Length(text) <= max) return { text, cut: false };
  return { text: splitUtf8(text, max)[0] ?? '', cut: true };
}

/** The last `max` UTF-8 bytes of `text` (whole code points), and whether anything was cut. */
export function tailUtf8(text: string, max: number): { text: string; cut: boolean } {
  if (utf8Length(text) <= max) return { text, cut: false };
  let size = 0;
  let i = text.length;
  while (i > 0) {
    let j = i - 1;
    const c = text.charCodeAt(j);
    if (c >= 0xdc00 && c <= 0xdfff && j > 0) {
      const h = text.charCodeAt(j - 1);
      if (h >= 0xd800 && h <= 0xdbff) j--;
    }
    const n = utf8Length(text.slice(j, i));
    if (size + n > max) break;
    size += n;
    i = j;
  }
  return { text: text.slice(i), cut: true };
}

/** What a redactor tells a session: the text with suspected secrets replaced, and how many it replaced. */
export type Redact = (text: string) => { text: string; count: number };

/** Redacted, invisible characters written out, then cut to `max` bytes keeping the head or the tail. */
export function shown(redact: Redact, raw: string, max: number, keep: 'head' | 'tail'): { text: string; cut: boolean; redactions: number } {
  const r = redact(raw);
  const esc = escapeInvisible(r.text);
  const c = keep === 'head' ? headUtf8(esc, max) : tailUtf8(esc, max);
  return { text: c.text, cut: c.cut, redactions: r.count };
}
