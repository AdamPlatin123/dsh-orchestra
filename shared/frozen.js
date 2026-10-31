// @ts-check
// The one deep freeze for every exported table, enum object and grammar of src/ and shared/ (P8: a
// module that imports a table may read it, never widen it). Plain ESM without imports, so the page can
// load it as it is and boot.ts's pre-fence modules can take it before the import fence goes in.
//
// Object.freeze alone does not hold a RegExp: Annex B's RegExp.prototype.compile swaps the pattern
// before it writes lastIndex, so on a frozen RegExp it throws and the new pattern is in place anyway
// (measured on Node 24.22). Each RegExp therefore gets an own `compile` that throws before it is
// frozen; the static scan bans the word in our code (ban:RegExp-compile), and a call through
// RegExp.prototype by its full name is that rule's to catch. RegExp.prototype itself stays as V8
// made it: changing any of its slots turns off V8's fast paths for every regex in the process
// (measured: split about 35 times slower, replace about 5 times).
//
// Only plain objects, arrays and RegExps can be frozen this way. A Map, Set, URL or typed array
// keeps its contents in internal slots that Object.freeze does not reach, so frozen() refuses one
// rather than return it looking frozen; export a plain value instead.
//
// An exported class is reachable the same way: whoever imports it could replace a method on its
// prototype that every instance calls, or give it a Symbol.hasInstance that answers instanceof for
// anything. frozenClass() freezes the class and its prototype; the methods are functions and stay
// as they are.

/** @param {unknown} x */
const isPlain = (x) => {
  const p = Object.getPrototypeOf(x);
  return p === null || p === Object.prototype || p === Array.prototype || p === RegExp.prototype;
};

// A function expression, so `new` on it reaches the same error.
const compileDisabled = function compileDisabled() {
  throw new TypeError('frozen RegExp: compile() would replace its pattern in place');
};

/**
 * Freezes `v` and every object, array and RegExp in it, at every level, and returns it. Functions are
 * left as they are; any other kind of object throws.
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function frozen(v) {
  freezeDeep(v, new Set());
  return v;
}

/**
 * @param {unknown} v
 * @param {Set<object>} seen
 */
function freezeDeep(v, seen) {
  if (typeof v !== 'object' || v === null || seen.has(v)) return;
  seen.add(v);
  if (!isPlain(v)) throw new TypeError(`frozen(): ${Object.prototype.toString.call(v)} keeps its contents where Object.freeze cannot reach`);
  if (v instanceof RegExp && !Object.hasOwn(v, 'compile')) {
    // A descriptor without a prototype: Object.defineProperty reads get and set through the chain.
    Object.defineProperty(v, 'compile', /** @type {PropertyDescriptor} */ ({ __proto__: null, value: compileDisabled, writable: false, enumerable: false, configurable: false }));
  }
  for (const k of Reflect.ownKeys(v)) {
    const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(v, k));
    if (Object.hasOwn(d, 'value')) freezeDeep(d.value, seen);
  }
  Object.freeze(v);
}

/**
 * Freezes a class and its prototype, and returns the class.
 * @template {Function} C
 * @param {C} c
 * @returns {C}
 */
export function frozenClass(c) {
  Object.freeze(c.prototype);
  Object.freeze(c);
  return c;
}
