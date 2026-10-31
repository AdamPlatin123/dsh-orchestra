import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLE_ARG_NAMES, TITLE_KEYS, titleError } from '../../shared/protocol.js';
import { ARG_UNKNOWN, TITLE_TEXT, formatTitle } from '../../shared/strings.js';

// Plan step 3, UI design 一 2: a title is {key, args}, never text. protocol.js checks the shape and
// each arg's grammar (titleError); strings.js holds the text of every key and fills it (formatTitle),
// for the page and the toast alike.

test('every title key has a text and no other key does; the texts are distinct and free of control and bidi characters', () => {
  assert.deepEqual(Object.keys(TITLE_TEXT), [...TITLE_KEYS]);
  const texts = Object.values(TITLE_TEXT);
  assert.equal(new Set(texts).size, texts.length, 'one symbol, one meaning');
  assert.ok(texts.every((t) => !/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(t)));
  for (const t of texts) for (const m of t.matchAll(/\{([^}]*)\}/g)) assert.ok((TITLE_ARG_NAMES as readonly string[]).includes(m[1]!), `${t}: {${m[1]}}`);
});

test('formatTitle fills each placeholder with its arg, shows 未知 for an arg the daemon left out, and never shows a key it does not know', () => {
  assert.equal(formatTitle({ key: 'item.approval', args: { project: 'shop-web' } }), 'shop-web 在等你批准');
  assert.equal(formatTitle({ key: 'item.approval', args: {} }), `${ARG_UNKNOWN} 在等你批准`);
  assert.equal(formatTitle({ key: 'item.nope', args: { project: 'x' } }), ARG_UNKNOWN);
  assert.equal(formatTitle({ key: 'toString', args: {} }), ARG_UNKNOWN, 'an inherited name is no key');
  assert.equal(formatTitle({ key: 'item.reminder', args: { project: 'x' } }), '提醒到点');
});

test('titleError: a plain {key, args} with own data fields only; the key from the list; args by name through their grammars', () => {
  const ok = { key: 'item.question', args: { project: 'shop-web', tool: 'Bash', version: '2.1.17' } };
  assert.equal(titleError(ok), null);
  assert.equal(titleError({ key: 'item.reminder', args: {} }), null, 'a reminder title needs no project');
  const cases: [unknown, string][] = [
    ['shop-web 在等你回答', 'shape'],
    [null, 'shape'],
    [[ok.key, ok.args], 'shape'],
    [Object.assign(Object.create({}) as object, ok), 'shape'],
    [{ key: ok.key }, 'shape'],
    [{ ...ok, [Symbol('s')]: 1 }, 'shape'],
    [Object.defineProperty({ args: ok.args }, 'key', { get: () => 'item.question', enumerable: true }), 'key'],
    [{ key: 'item.Question', args: ok.args }, 'key'],
    [{ key: ok.key, args: [] }, 'args'],
    [{ key: ok.key, args: 'shop-web' }, 'args'],
    [{ key: ok.key, args: { project: 'x', [Symbol('s')]: 'y' } }, 'arg-name'],
    [{ key: ok.key, args: { cwd: 'C:\\x' } }, 'arg-name'],
    [{ key: ok.key, args: { project: 7 } }, 'project'],
    [{ key: ok.key, args: { project: 'shop\u2066web' } }, 'project'],
    [{ key: ok.key, args: { tool: 'a b' } }, 'tool'],
    [{ key: ok.key, args: { version: 'v1' } }, 'version'],
  ];
  for (const [t, want] of cases) assert.equal(titleError(t), want, JSON.stringify(t));
});
