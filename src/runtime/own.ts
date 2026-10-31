// Option bags are read as own properties only. A field the caller left out of an ordinary object
// literal is looked up on Object.prototype, where any module could have put a value (or a getter that
// receives the bag as `this` and reads the fields that are set, a raw io among them). undici reads
// RequestInit that way (see import-fence.ts), Node's server.listen reads `port` that way (lock.ts),
// and so did our own gates for every optional field until step 2c.

/**
 * A copy of the listed fields that are own properties of `bag`, in an object without a prototype:
 * a field the caller did not set reads undefined, never Object.prototype's. Each field is read once.
 * Anything that is not an object gives an empty record; the caller's required-field checks decide.
 */
export function ownFields<T extends object, K extends keyof T & string>(bag: T | null | undefined, keys: readonly K[]): Partial<Pick<T, K>> {
  const out = Object.create(null) as Partial<Pick<T, K>>;
  if (typeof bag !== 'object' || bag === null) return out;
  for (const k of keys) if (Object.hasOwn(bag, k)) out[k] = bag[k];
  return out;
}

/** The own value of one field, or undefined. */
export function ownField<T extends object, K extends keyof T & string>(bag: T | null | undefined, key: K): T[K] | undefined {
  return typeof bag === 'object' && bag !== null && Object.hasOwn(bag, key) ? bag[key] : undefined;
}

/** A frozen copy of an env record's own string entries, without a prototype. */
export function ownEnv(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  if (typeof env !== 'object' || env === null) return Object.freeze(out);
  for (const k of Object.keys(env)) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * `name` from an env record, own entries only: exact name first, then a case-insensitive match
 * (Windows names compare that way). A name missing from the record reads undefined, never a value
 * some module put on Object.prototype.
 */
export function envGet(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  if (Object.hasOwn(env, name) && env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}
