import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { SNIPPET_MAX_BYTES, SNIPPET_TTL_MS } from '../../shared/constants.js';
import { REDACT_VERSION, makeRedactor } from '../../src/store/redact.ts';
import { SnippetError, Snippets, fitBytes } from '../../src/store/snippets.ts';
import { R, clockCause, digestOf, humanCause, uuidOf } from '../helpers/records.ts';
import { T0, mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, snippets.ts: redacted text, at most 2 KB, 14 days; expiry and "purge secrets" leave
// tombstones; a pending reminder's text is pinned until it fires or is cancelled. The text never
// reaches the journal.

const DAY = 24 * 60 * 60 * 1000;

test('put redacts, keeps at most 2 KB without splitting a character, and returns the judgment for the batch; the journal never sees the text', async (t) => {
  const f = await storeFixture(t);
  const env = { MY_TOKEN: 'abcdefghij1234567890' };
  const s = mustOpen(f, { env }).store;
  const raw = `run with abcdefghij1234567890 and sk-ant-REALLYSECRET123 then ${'界'.repeat(1000)}`;
  const put = s.snippets.put('sn1', { text: raw });
  assert.deepEqual(put.judgment.body.value, { ver: REDACT_VERSION, dropped: null, known: 1, format: { 'sk-ant': 1 }, entropy: 0 });
  // Keyed (HMAC-SHA256 under the install's key), never the bare sha256 a guess could be checked against.
  assert.equal(put.judgment.body.inputDigest, s.snippets.digest(raw));
  assert.notEqual(put.judgment.body.inputDigest, digestOf(raw));
  const got = s.snippets.get('sn1');
  assert.equal(got.textState, 'present');
  assert.ok(!got.text!.includes('abcdefghij1234567890') && !got.text!.includes('REALLYSECRET'));
  assert.ok(Buffer.byteLength(got.text!, 'utf8') <= SNIPPET_MAX_BYTES);
  assert.ok(Buffer.byteLength(got.text!, 'utf8') > SNIPPET_MAX_BYTES - 3, 'cut at the last whole character');
  assert.ok(!got.text!.includes('\ufffd'), 'no character was split');
  s.commit([R.event('p1', 1, { snippetRef: 'sn1' }), put.judgment]);
  const journal = fs.readFileSync(f.journal, 'utf8');
  assert.ok(!journal.includes('界') && !journal.includes('run with'), 'the journal has the snippetRef and the digests, never the text');
  assert.match(journal, /"snippetRef":"sn1"/);
  // An env dump is dropped whole, by its command or by its look.
  s.snippets.put('sn2', { text: 'PATH=C:\\x\nFOO=bar\nBAZ=qux', command: 'printenv' });
  assert.equal(s.snippets.get('sn2').text, '[redacted:env-dump]');
});

test('fitBytes never splits a code point, at any cut', () => {
  const text = 'a界😀b'.repeat(20);
  for (let max = 0; max <= Buffer.byteLength(text, 'utf8'); max++) {
    const cut = fitBytes(text, max);
    assert.ok(Buffer.byteLength(cut, 'utf8') <= max);
    assert.ok(text.startsWith(cut) && cut.isWellFormed(), String(max));
  }
});

test('the TTL is 14 days: an expired text leaves a tombstone with its digest; purge tombstones the rest; snippetRev counts both; a missing row reads lost', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.snippets.put('a1', { text: 'first text' });
  f.clock.advanceBy(DAY);
  s.snippets.put('a2', { text: 'second text' });
  f.clock.advanceBy(SNIPPET_TTL_MS - DAY - 1);
  assert.equal(s.snippets.expire(), 0);
  assert.equal(s.snippets.rev, 0);
  f.clock.advanceBy(1);
  assert.equal(s.snippets.expire(), 1);
  assert.deepEqual(s.snippets.get('a1'), { textState: 'expired', text: null });
  assert.deepEqual(s.snippets.get('a2'), { textState: 'present', text: 'second text' });
  assert.equal(s.db.get('SELECT digest FROM snippet WHERE ref = ?', 'a1')!.digest, s.snippets.digest('first text'), 'the tombstone keeps the (keyed) digest');
  assert.equal(s.snippets.rev, 1);
  assert.equal(s.snippets.purge(), 1);
  assert.deepEqual(s.snippets.get('a2'), { textState: 'purged', text: null });
  assert.equal(s.snippets.rev, 2);
  assert.equal(s.snippets.purge(), 0);
  assert.equal(s.snippets.rev, 2, 'a purge that cleared nothing is no change');
  assert.deepEqual(s.snippets.get('never'), { textState: 'lost', text: null });
});

test('a pending reminder\'s text is pinned: past the TTL and through a purge it stays; once the reminder fires (or is cancelled) it is unpinned and goes', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const fire = uuidOf('pin-fire');
  const cancel = uuidOf('pin-cancel');
  for (const [id, ref, action] of [['rem1', 'rt1', fire], ['rem2', 'rt2', cancel]] as const) {
    s.snippets.put(ref, { text: `remember ${id}` });
    s.commit([R.reminder(id, T0 + 30 * DAY, ref), R.tr('reminder', id, 'none', 'pending', humanCause(action)), R.human(action, 'remind'), R.result(action, 'remind', null)]);
  }
  s.snippets.put('other', { text: 'not pinned' });
  f.clock.advanceBy(SNIPPET_TTL_MS + DAY);
  assert.equal(s.snippets.expire(), 1, 'only the unpinned text expired');
  assert.equal(s.snippets.purge(), 0);
  assert.equal(s.snippets.get('rt1').textState, 'present');
  assert.equal(s.snippets.get('rt2').textState, 'present');
  // rem1 fires; rem2 is cancelled.
  s.commit([R.clock('reminder:rem1:0', 'wall', 30 * DAY, f.clock.mono, f.clock.wall), R.tr('reminder', 'rem1', 'pending', 'fired', clockCause('reminder:rem1:0'))]);
  const c2 = uuidOf('pin-cancel-2');
  s.commit([R.tr('reminder', 'rem2', 'pending', 'cancelled', humanCause(c2)), R.human(c2, 'remind', 'rem2'), R.result(c2, 'remind', 'rem2')]);
  assert.equal(s.snippets.expire(), 2);
  assert.deepEqual([s.snippets.get('rt1').textState, s.snippets.get('rt2').textState], ['expired', 'expired']);
});

test('a snippet ref is an id and the text a string; Snippets takes no default db, redactor or clock', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  assert.throws(() => s.snippets.put('has space', { text: 'x' }), SnippetError);
  assert.throws(() => s.snippets.put('ok1', { text: 5 } as never), SnippetError);
  const redactor = makeRedactor({ env: {} });
  assert.throws(() => new Snippets({ db: s.db, redactor } as never), /required, there is no default/);
  assert.throws(() => new Snippets({ db: s.db, clock: f.clock.port(null) } as never), /required, there is no default/);
  assert.throws(() => new Snippets({ db: s.db, redactor, clock: {} } as never), /required, there is no default/, 'a clock that cannot read');
  const inherited = Object.assign(Object.create({ clock: f.clock.port(null) }) as Record<string, unknown>, { db: s.db, redactor });
  assert.throws(() => new Snippets(inherited as never), /required, there is no default/, 'a clock on the prototype is not read');
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('S4: the TTL holds on every read: past 14 days get() reads expired and tombstones the text, with no sweep first; a pinned text stays', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.snippets.put('snip1', { text: 'note one end' });
  s.snippets.put('pin1', { text: 'pinned words' });
  const make = uuidOf('pin-make');
  s.commit([R.reminder('remP', T0 + 30 * DAY, 'pin1'), R.tr('reminder', 'remP', 'none', 'pending', humanCause(make)), R.human(make, 'remind', null), R.result(make, 'remind', null)]);
  f.clock.advanceBy(15 * DAY);
  assert.deepEqual(s.snippets.get('snip1'), { textState: 'expired', text: null });
  assert.deepEqual({ ...s.db.get("SELECT state, text FROM snippet WHERE ref = 'snip1'")! }, { state: 'expired', text: null }, 'tombstoned on the read');
  assert.equal(s.snippets.rev, 1);
  assert.deepEqual(s.snippets.get('pin1'), { textState: 'present', text: 'pinned words' });
  // A start sweeps too: a text past its TTL is tombstoned by openStore, read or not.
  s.snippets.put('snip2', { text: 'second note' });
  s.close();
  f.clock.advanceBy(15 * DAY);
  const again = mustOpen(f).store;
  assert.equal(again.db.get("SELECT state FROM snippet WHERE ref = 'snip2'")!.state, 'expired');
});

test('S5: a purged text leaves no copy on disk: secure_delete is on and the purge checkpoints, so neither orchestra.db nor its -wal holds it while the store is open', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  assert.equal(s.db.pragma('secure_delete'), 1);
  // Plain words: a high-entropy marker would be redacted before it ever reached the table.
  const marker = 'the quiet river purge canary';
  s.snippets.put('sm1', { text: `before ${marker} after` });
  s.commit([R.event('p1', 1, { snippetRef: 'sm1' })]);
  const onDisk = () => ['', '-wal'].map((x) => (fs.existsSync(`${f.db}${x}`) ? fs.readFileSync(`${f.db}${x}`).includes(Buffer.from(marker)) : false));
  assert.ok(onDisk().some((x) => x), 'control: before the purge the text is on disk');
  assert.equal(s.snippets.purge(), 1);
  assert.deepEqual(onDisk(), [false, false], 'after the purge: not in orchestra.db, not in the -wal');
  // The same for an expiry.
  s.snippets.put('sm2', { text: `x ${marker} y` });
  f.clock.advanceBy(SNIPPET_TTL_MS);
  assert.equal(s.snippets.expire(), 1);
  assert.deepEqual(onDisk(), [false, false]);
});

test('S6: content digests are keyed with the install\'s key (32 random bytes beside the journal, never in it), and stay the same across a reopen', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const d1 = s.snippets.digest('short text');
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.notEqual(d1, digestOf('short text'));
  s.commit([R.part('p1')]);
  const key = s.db.get('SELECT key FROM install_key WHERE id = 1')!.key as Uint8Array;
  assert.equal(key.length, 32);
  s.close();
  const again = mustOpen(f).store;
  assert.equal(again.snippets.digest('short text'), d1);
  assert.ok(!fs.readFileSync(f.journal).includes(Buffer.from(key)));
});
