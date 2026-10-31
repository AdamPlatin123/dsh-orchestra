import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import type { CanonicalReason } from '../../src/store/canonical-json.ts';
import { CanonicalJsonError, MAX_DEPTH, canonicalDigest, canonicalJson, parseCanonical } from '../../src/store/canonical-json.ts';

// Plan step 3: the encoding every digest is taken over. One value, one encoding; a value that has no
// single encoding is refused.

const reason = (r: CanonicalReason) => (e: unknown) => e instanceof CanonicalJsonError && e.reason === r;

test('keys are sorted by UTF-16 code units at every depth, whatever order they were made in; arrays keep their order', () => {
  const a = { b: 1, a: { z: [3, 1, 2], y: null }, B: true, '10': 'ten', '2': 'two', é: 'e-acute', 'ｚ': 'fullwidth', '\u{1F600}': 'astral', '￿': 'max-bmp' };
  const b = { '￿': 'max-bmp', '\u{1F600}': 'astral', 'ｚ': 'fullwidth', é: 'e-acute', '2': 'two', '10': 'ten', B: true, a: { y: null, z: [3, 1, 2] }, b: 1 };
  const text = canonicalJson(a);
  assert.equal(text, canonicalJson(b));
  // '10' < '2' < 'B' < 'a' < 'b' < 'é' < U+1F600 (its first unit is D83D) < 'ｚ' (U+FF5A) < U+FFFF: code units, not code points.
  assert.equal(text, '{"10":"ten","2":"two","B":true,"a":{"y":null,"z":[3,1,2]},"b":1,"é":"e-acute","\u{1F600}":"astral","ｚ":"fullwidth","￿":"max-bmp"}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson(Object.create(null) as object), '{}');
});

test('numbers: safe integers only; -0 is written 0; NaN, Infinity, fractions, unsafe integers and bigints are refused', () => {
  assert.equal(canonicalJson([0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e3]), `[0,0,1,-1,${Number.MAX_SAFE_INTEGER},${Number.MIN_SAFE_INTEGER},1000]`);
  assert.equal(canonicalJson({ n: -0 }), canonicalJson({ n: 0 }));
  assert.throws(() => canonicalJson(Number.NaN), reason('non-finite'));
  assert.throws(() => canonicalJson({ x: Infinity }), reason('non-finite'));
  assert.throws(() => canonicalJson([-Infinity]), reason('non-finite'));
  assert.throws(() => canonicalJson(0.1), reason('non-integer'));
  assert.throws(() => canonicalJson(1.5e-7), reason('non-integer'));
  assert.throws(() => canonicalJson(2 ** 53), reason('unsafe-integer'));
  assert.throws(() => canonicalJson(-(2 ** 53)), reason('unsafe-integer'));
  assert.throws(() => canonicalJson(1e21), reason('unsafe-integer'));
  assert.throws(() => canonicalJson(10n), reason('bigint'));
});

test('strings: lone surrogates are refused; no Unicode normalization; only quote, backslash and C0 are escaped', () => {
  assert.throws(() => canonicalJson('\ud800'), reason('lone-surrogate'));
  assert.throws(() => canonicalJson('a\udc00b'), reason('lone-surrogate'));
  assert.throws(() => canonicalJson({ ['k\ud83d']: 1 }), reason('lone-surrogate'), 'in a key too');
  assert.equal(canonicalJson('\u{1F600}'), '"\u{1F600}"', 'a well-formed pair is written as it is');
  const nfc = 'café';
  const nfd = 'café';
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'));
  assert.notEqual(canonicalJson(nfc), canonicalJson(nfd), 'NFC and NFD are two strings, as they are two names on NTFS');
  assert.notEqual(canonicalDigest({ cwd: nfc }), canonicalDigest({ cwd: nfd }));
  assert.equal(canonicalJson('q"b\\s/\u0000\u001f\u007f ‮'), '"q\\"b\\\\s/\\u0000\\u001f\u007f ‮"');
  assert.equal(canonicalJson('\b\f\n\r\t'), '"\\b\\f\\n\\r\\t"');
});

test('only JSON values in plain containers: undefined, functions, symbols, class instances, accessors, symbol keys, sparse or decorated arrays, cycles and depth are refused', () => {
  const cases: [unknown, CanonicalReason][] = [
    [undefined, 'bad-type'],
    [{ a: undefined }, 'bad-type'],
    [[1, undefined], 'bad-type'],
    [() => 1, 'bad-type'],
    [{ f() { return 1; } }, 'bad-type'],
    [Symbol('s'), 'bad-type'],
    [new Date(0), 'not-plain'],
    [new Map(), 'not-plain'],
    [Buffer.from('x'), 'not-plain'],
    [new (class P { a = 1; })(), 'not-plain'],
    [Object.create({ inherited: 1 }) as object, 'not-plain'],
    [{ get a() { return 1; } }, 'accessor'],
    [{ [Symbol('k')]: 1 }, 'symbol-key'],
    // eslint-disable-next-line no-sparse-arrays
    [[1, , 3], 'sparse-array'],
    [Object.assign([1, 2], { extra: true }), 'array-extra-key'],
    // eslint-disable-next-line no-sparse-arrays
    [Object.assign([1, , 3], { x: 1 }), 'sparse-array'],
    [new (class A extends Array {})(), 'not-plain'],
  ];
  for (const [v, why] of cases) assert.throws(() => canonicalJson(v), reason(why), String(why));
  let getterRan = false;
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'x', { get: () => { getterRan = true; return 1; }, enumerable: true })), reason('accessor'));
  assert.equal(getterRan, false, 'a getter never runs');
  const hidden = Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false });
  assert.equal(canonicalJson(hidden), '{"a":1,"h":2}', 'a non-enumerable field still counts: nothing drops out of the digest unseen');
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = { back: cyc };
  assert.throws(() => canonicalJson(cyc), reason('cycle'));
  const shared = { s: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"s":1},"b":{"s":1}}', 'a shared object is no cycle');
  let deep: unknown = 0;
  for (let i = 0; i < MAX_DEPTH; i++) deep = [deep];
  assert.equal(canonicalJson(deep).length, 2 * MAX_DEPTH + 1);
  assert.throws(() => canonicalJson([deep]), reason('too-deep'));
  const err = (() => { try { canonicalJson({ ok: 1, list: [0, { bad: 0.5 }] }); } catch (e) { return e as CanonicalJsonError; } return null; })();
  assert.equal(err?.at, '$.0[1].0', 'the path names positions, never key text');
});

test('canonicalDigest is sha256 over the UTF-8 bytes of the canonical text, independent of key order', () => {
  const v = { kind: 'human', body: { actionId: '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', verb: 'seen', target: 'it-41' }, n: [1, 2] };
  const text = canonicalJson(v);
  assert.equal(canonicalDigest(v), crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
  assert.equal(canonicalDigest({ n: [1, 2], body: { target: 'it-41', verb: 'seen', actionId: '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e' }, kind: 'human' }), canonicalDigest(v));
  assert.match(canonicalDigest(v), /^[0-9a-f]{64}$/);
  assert.notEqual(canonicalDigest({ n: [2, 1] }), canonicalDigest({ n: [1, 2] }));
});

test('parseCanonical accepts exactly the canonical text: duplicate keys, -0, lost precision, order, whitespace and odd escapes are refused', () => {
  const v = { b: [1, 'x'], a: null };
  assert.deepEqual(parseCanonical(canonicalJson(v)), { a: null, b: [1, 'x'] });
  const refused: [string, CanonicalReason][] = [
    ['{"a":1,"a":2}', 'not-canonical'],
    ['-0', 'not-canonical'],
    ['[-0]', 'not-canonical'],
    ['9007199254740993', 'unsafe-integer'],
    ['{"b":1,"a":2}', 'not-canonical'],
    ['{"a": 1}', 'not-canonical'],
    ['"\\u0041"', 'not-canonical'],
    ['"\\/"', 'not-canonical'],
    ['1.0', 'not-canonical'],
    ['1e2', 'not-canonical'],
    ['0.5', 'non-integer'],
    ['"\\ud800"', 'lone-surrogate'],
    ['{"a":1', 'not-json'],
    ['', 'not-json'],
  ];
  for (const [text, why] of refused) assert.throws(() => parseCanonical(text), reason(why), text);
});

test('the same value encodes to the same bytes however it was built: 200 random key orders of one record', () => {
  const entries: [string, unknown][] = [['jseq', 41], ['bootId', '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'], ['kind', 'transition'], ['body', { entity: 'item', id: 'it-41', from: 'open', to: 'seen', cause: { kind: 'human', actionId: 'a-1' } }], ['obsMono', 1234], ['obsWall', 1_761_897_600_000]];
  const want = canonicalJson(Object.fromEntries(entries));
  let s = 12345;
  for (let i = 0; i < 200; i++) {
    const order = [...entries];
    for (let j = order.length - 1; j > 0; j--) {
      s = (s * 48271) % 2147483647;
      const k = s % (j + 1);
      [order[j], order[k]] = [order[k]!, order[j]!];
    }
    assert.equal(canonicalJson(Object.fromEntries(order)), want);
  }
});
