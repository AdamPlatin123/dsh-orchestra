import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Rec } from '../../src/store/journal.ts';
import { JournalError, scanJournal } from '../../src/store/journal.ts';
import { checkBody } from '../../src/store/records.ts';
import { dumpProjection, rebuildProjection } from '../../src/store/rebuild.ts';
import { R, digestOf, srcCause } from '../helpers/records.ts';
import { deleteDb, mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, 补2: judgment{name, inputDigest, ver, value}. value is a small structured conclusion
// with no text; replay and rebuild read value and never recompute it. M0's real user is the
// redaction verdict of a snippet.

const verdict = { ver: 1, dropped: null, known: 0, format: {}, entropy: 0 };

test('the judgment format: name from the list, inputDigest a sha256, ver an integer, value the verdict shape with rule ids for keys and counts for values, no text anywhere', () => {
  const ok = (body: unknown) => checkBody('judgment', body, null);
  assert.equal(ok(R.judgment(digestOf('x')).body), null);
  assert.equal(ok(R.judgment(digestOf('x'), { ver: 1, dropped: 'env-dump', known: 0, format: {}, entropy: 0 }).body), null);
  assert.equal(ok(R.judgment(digestOf('x'), { ver: 1, dropped: null, known: 2, format: { pem: 1, 'url-credentials': 3 }, entropy: 4 }).body), null);
  const bad: [string, unknown, string][] = [
    ['an unknown name', { name: 'origin', inputDigest: digestOf('x'), ver: 1, value: verdict }, 'enum'],
    ['an inputDigest that is text', { name: 'redact', inputDigest: 'the raw text', ver: 1, value: verdict }, 'grammar'],
    ['a fractional ver', { name: 'redact', inputDigest: digestOf('x'), ver: 1.5, value: verdict }, 'type'],
    ['a text in value', { name: 'redact', inputDigest: digestOf('x'), ver: 1, value: { ...verdict, text: 'the redacted text' } }, 'extra-key'],
    ['a format key that is no rule', { name: 'redact', inputDigest: digestOf('x'), ver: 1, value: { ...verdict, format: { 'my secret': 1 } } }, 'enum'],
    ['a format count that is a string', { name: 'redact', inputDigest: digestOf('x'), ver: 1, value: { ...verdict, format: { pem: '1' } } }, 'type'],
    ['dropped of another kind', { name: 'redact', inputDigest: digestOf('x'), ver: 1, value: { ...verdict, dropped: 'whatever' } }, 'enum'],
    ['value missing', { name: 'redact', inputDigest: digestOf('x'), ver: 1 }, 'missing'],
  ];
  for (const [what, body, why] of bad) assert.equal(ok(body)?.reason, why, what);
});

test('a malformed judgment is refused before the append', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  assert.throws(() => s.commit([{ kind: 'judgment', body: { name: 'redact', inputDigest: digestOf('x'), ver: 1, value: { ...verdict, text: 'oops' } } }]), JournalError);
});

test('all snippets cleared, the projection rebuilt from the journal is the same row by row; the judgment\'s value is read, never recomputed (not even under another environment)', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f, { env: { MY_TOKEN: 'abcdefghij1234567890' } }).store;
  s.commit([R.part('p1')]);
  for (let i = 1; i <= 3; i++) {
    const put = s.snippets.put(`sn${i}`, { text: `line ${i} with abcdefghij1234567890 and ghp_${'a1'.repeat(15)}` });
    s.commit([R.event('p1', i, { snippetRef: `sn${i}`, evKind: 'tool' }), put.judgment, R.item(`i${i}`, { partRef: 'p1' }), R.tr('inbox_item', `i${i}`, 'none', 'open', srcCause('p1', i)), R.cursor('p1', i * 100, i)]);
  }
  // A value no redactor would compute from that input: a rebuild that recomputed would change it.
  const odd: Rec = R.judgment(digestOf('line 1'), { ver: 1, dropped: null, known: 99, format: {}, entropy: 0 });
  s.commit([odd]);
  const before = dumpProjection(s.db);
  assert.equal(s.snippets.purge(), 3);
  s.db.run('DELETE FROM snippet');
  rebuildProjection(s.db, (() => {
    const scan = scanJournal(fs.readFileSync(f.journal));
    assert.ok(scan.ok);
    return scan.batches;
  })());
  assert.deepEqual(dumpProjection(s.db), before);
  const bodies = s.db.all("SELECT body FROM event WHERE kind = 'judgment' ORDER BY jseq").map((r) => JSON.parse(String(r.body)) as { value: { known: number } });
  assert.deepEqual(bodies.map((b) => b.value.known), [1, 1, 1, 99]);
  s.close();
  // The database lost whole, another environment: the same projection again.
  deleteDb(f);
  const again = mustOpen(f, { env: { SOMETHING_ELSE: 'zyxwvutsrq0987654321' } });
  assert.deepEqual(dumpProjection(again.store.db), before);
  assert.equal(again.store.snippets.get('sn1').textState, 'lost');
});
