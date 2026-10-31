// The export walk of finding N3 (test/runtime/minting.test.ts): every way an exported value can still
// be changed in place by whoever imports it. Imports nothing, so loading it freezes nothing and the
// walk of a module sees only what that module's own graph did.

const PLAIN_PROTOS: readonly (object | null)[] = [null, Object.prototype, Array.prototype, RegExp.prototype];

export const isClass = (v: unknown): boolean => typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v));

/**
 * An exported object, array or RegExp must be frozen at every level, a RegExp also with its own
 * compile() that throws and leaves the pattern as it was (shared/frozen.js); an exported class must be
 * frozen with its prototype; an object whose contents live in internal slots (a URL, Map, Set, typed
 * array) cannot be frozen at all and is reported as such. Functions other than classes are skipped.
 */
export function openPaths(v: unknown, at: string, seen = new Set<unknown>()): string[] {
  if (seen.has(v) || v === null || (typeof v !== 'object' && typeof v !== 'function')) return [];
  seen.add(v);
  const out: string[] = [];
  if (typeof v === 'function') {
    if (!isClass(v)) return [];
    const cls = v as { prototype: object };
    if (!Object.isFrozen(cls)) out.push(`${at} (class)`);
    if (!Object.isFrozen(cls.prototype)) out.push(`${at}.prototype`);
    for (const k of Reflect.ownKeys(cls)) {
      if (k === 'prototype' || k === 'length' || k === 'name') continue;
      const d = Object.getOwnPropertyDescriptor(cls, k)!;
      if (Object.hasOwn(d, 'value')) out.push(...openPaths(d.value, `${at}.${String(k)}`, seen));
    }
    return out;
  }
  if (!PLAIN_PROTOS.includes(Object.getPrototypeOf(v))) return [`${at} (${Object.prototype.toString.call(v)}: contents Object.freeze cannot hold)`];
  if (!Object.isFrozen(v)) out.push(at);
  if (v instanceof RegExp) {
    const d = Object.getOwnPropertyDescriptor(v, 'compile');
    const source = v.source;
    let threw = false;
    try {
      (v as unknown as { compile(p: string): unknown }).compile('^[\\s\\S]*$');
    } catch {
      threw = true;
    }
    if (d === undefined || d.writable !== false || d.configurable !== false || !threw || v.source !== source) out.push(`${at} (compile() not stubbed)`);
  }
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (Object.hasOwn(d, 'value')) out.push(...openPaths(d.value, `${at}.${String(k)}`, seen));
  }
  return out;
}

/** The walk of one module namespace: the exports it looked at (objects and classes) and what is open. */
export function walkModule(ns: Record<string, unknown>, rel: string): { walked: string[]; open: string[] } {
  const walked: string[] = [];
  const open: string[] = [];
  for (const [name, v] of Object.entries(ns)) {
    if (v !== null && (typeof v === 'object' || isClass(v))) walked.push(`${rel}:${name}`);
    open.push(...openPaths(v, `${rel}:${name}`));
  }
  return { walked, open };
}
