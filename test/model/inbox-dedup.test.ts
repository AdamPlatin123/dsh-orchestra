import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rec } from '../../src/store/journal.ts';
import type { DedupSpec, ItemIndex, OpenSpec, Segment } from '../../src/model/inbox.ts';
import { ID_RE } from '../../shared/protocol.js';
import { InboxError, dedupKey, itemIdFor, itemIndex, moveItem, openItem, readItem } from '../../src/model/inbox.ts';
import { ApplyError, appliedTail, applyBatch } from '../../src/store/rebuild.ts';
import { R, digestOf, rawBatch, srcCause } from '../helpers/records.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, r4 §11.2: dedupKey = kind + partRef + sender, and a Claude waiting item's segment
// (root, pid, procStart, statusUpdatedAt). One live item per key: a signal that repeats a live item
// opens nothing; once it has ended, the same key opens a new item with the next occurrence's id.

const SEG: Segment = { root: 'root1', pid: 4242, procStart: '133000000000000100', statusUpdatedAt: 1_761_868_800_123 };
const spec = (patch: Partial<DedupSpec> = {}): DedupSpec => ({ kind: 'approval', partRef: 'p1', sender: 'p1', segment: SEG, ...patch });
const open = (patch: Partial<OpenSpec> = {}): OpenSpec => ({ ...spec(), conf: 'high', projectId: null, reminderId: null, ...patch } as OpenSpec);

test('dedupKey is a sha256 digest of kind, partRef, sender and segment: the same spec gives the same key, any field changed gives another', () => {
  const k = dedupKey(spec());
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(dedupKey(spec()), k);
  assert.equal(dedupKey({ segment: SEG, sender: 'p1', partRef: 'p1', kind: 'approval' }), k, 'key order of the spec does not matter');
  assert.equal(dedupKey(spec({ segment: { statusUpdatedAt: SEG.statusUpdatedAt, procStart: SEG.procStart, pid: SEG.pid, root: SEG.root } })), k);
  const others = [
    spec({ kind: 'question' }), spec({ partRef: 'p2' }), spec({ partRef: null }), spec({ sender: 'sub-1' }), spec({ segment: null }),
    spec({ segment: { ...SEG, root: 'root2' } }), spec({ segment: { ...SEG, pid: 4243 } }), spec({ segment: { ...SEG, procStart: '133000000000000101' } }),
    spec({ segment: { ...SEG, statusUpdatedAt: SEG.statusUpdatedAt + 1 } }),
  ].map(dedupKey);
  assert.equal(new Set([k, ...others]).size, others.length + 1, 'every field is part of the key');
});

test('dedupKey composes without separators: ids that would collide when joined with any character still give different keys', () => {
  assert.notEqual(dedupKey(spec({ partRef: 'a', sender: 'b-c', segment: null })), dedupKey(spec({ partRef: 'a-b', sender: 'c', segment: null })));
  assert.notEqual(dedupKey(spec({ partRef: 'ab', sender: 'c', segment: null })), dedupKey(spec({ partRef: 'a', sender: 'bc', segment: null })));
  assert.notEqual(dedupKey(spec({ partRef: null, sender: 'p1', segment: null })), dedupKey(spec({ partRef: 'p1', sender: 'p1', segment: null })));
});

test('dedupKey refuses what is not an id, a segment on a kind that is not a waiting kind, a part on a reminder item, and reads own fields only', () => {
  const bad: Partial<DedupSpec>[] = [
    { kind: 'mystery' as never }, { kind: 'mystery' as never, segment: null }, { partRef: 'a:b' }, { partRef: '' }, { sender: 'x y' }, { sender: 'é' }, { sender: null as never },
    { kind: 'failure' }, { kind: 'reminder', partRef: 'p1', segment: null },
    { segment: { ...SEG, pid: 0 } }, { segment: { ...SEG, pid: 2 ** 32 } }, { segment: { ...SEG, procStart: '0' } }, { segment: { ...SEG, statusUpdatedAt: -1 } },
    { segment: { ...SEG, statusUpdatedAt: 1.5 } }, { segment: { ...SEG, root: 'a:b' } }, { segment: { ...SEG, extra: 1 } as never }, { segment: [1, 2, 3, 4] as never },
  ];
  for (const b of bad) assert.throws(() => dedupKey(spec(b)), (e: unknown) => e instanceof InboxError && e.reason === 'bad-spec', JSON.stringify(b));
  assert.match(dedupKey({ kind: 'reminder', partRef: null, sender: 'rem1', segment: null }), /^[0-9a-f]{64}$/);
  const k = dedupKey(spec({ segment: null }));
  Object.defineProperty(Object.prototype, 'segment', { value: SEG, configurable: true, writable: true });
  try {
    const own = { kind: 'approval', partRef: 'p1', sender: 'p1' } as unknown as DedupSpec;
    assert.throws(() => dedupKey(own), InboxError, 'a segment the spec does not own is no segment: the spec is incomplete');
    assert.equal(dedupKey(spec({ segment: null })), k);
  } finally {
    delete (Object.prototype as Record<string, unknown>).segment;
  }
});

test('itemIdFor: deterministic, inside the id grammar, one id per occurrence; a key that is not a digest is refused', () => {
  const k = dedupKey(spec());
  assert.equal(itemIdFor(k, 0), `it-${k.slice(0, 40)}-0`);
  assert.equal(itemIdFor(k, 0), itemIdFor(k, 0));
  assert.notEqual(itemIdFor(k, 0), itemIdFor(k, 1));
  assert.ok(ID_RE.test(itemIdFor(k, Number.MAX_SAFE_INTEGER)));
  for (const [key, n] of [['abc', 0], [k.toUpperCase(), 0], [k, -1], [k, 1.5]] as const) assert.throws(() => itemIdFor(key, n), InboxError);
});

test('openItem against an index: a live item under the key is a dedup; otherwise the item and its none>open transition, with the id of the next occurrence', () => {
  const k = dedupKey(spec());
  const index = (live: string | null, count: number): ItemIndex => ({ live: (key) => (key === k ? live : null), count: (key) => (key === k ? count : 0) });
  assert.deepEqual(openItem(index('it-x', 1), open(), srcCause('p1', 4)), { kind: 'dedup', itemId: 'it-x', dedupKey: k });
  const d = openItem(index(null, 2), open(), srcCause('p1', 4));
  assert.equal(d.kind, 'open');
  assert.equal(d.itemId, itemIdFor(k, 2));
  assert.deepEqual((d as { records: Rec[] }).records, [
    { kind: 'item', body: { itemId: d.itemId, itemKind: 'approval', sev: 'P1', group: 'fermatas', conf: 'high', projectId: null, partRef: 'p1', dedupKey: k, reminderId: null } },
    { kind: 'transition', body: { entity: 'inbox_item', id: d.itemId, from: 'none', to: 'open', cause: { kind: 'source', partRef: 'p1', srcSeq: 4 } } },
  ]);
  assert.throws(() => openItem(index(null, 0), open(), { kind: 'human', actionId: '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e' }), (e: unknown) => e instanceof InboxError && e.reason === 'bad-cause', 'you open no item');
  assert.throws(() => openItem(index(null, 0), open(), { kind: 'clock', timerId: 'snooze:p1:0' }), InboxError, 'a snooze timer opens no item');
});

test('in the store: a re-read of a live segment opens nothing; a new statusUpdatedAt is a new item; after the item ends the same segment opens the next occurrence', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1')]);
  const signal = (seq: number, seg: Segment) => {
    const d = openItem(itemIndex(s.db), open({ segment: seg }), srcCause('p1', seq));
    s.commit([R.event('p1', seq), ...(d.kind === 'open' ? d.records : []), R.cursor('p1', seq * 10, seq)]);
    return d;
  };
  const first = signal(1, SEG);
  assert.equal(first.kind, 'open');
  assert.deepEqual(signal(2, SEG), { kind: 'dedup', itemId: first.itemId, dedupKey: first.dedupKey });
  const next = signal(3, { ...SEG, statusUpdatedAt: SEG.statusUpdatedAt + 5000 });
  assert.equal(next.kind, 'open');
  assert.notEqual(next.dedupKey, first.dedupKey);
  s.commit([R.event('p1', 4), ...moveItem(readItem(s.db, first.itemId)!, 'auto-cleared', srcCause('p1', 4))]);
  const again = signal(5, SEG);
  assert.deepEqual([again.kind, again.itemId], ['open', itemIdFor(first.dedupKey, 1)]);
  assert.equal(Number(s.db.get('SELECT count(*) AS n FROM inbox_item WHERE dedup_key = ?', first.dedupKey)!.n), 2);
  assert.equal(Number(s.db.get('SELECT count(*) AS n FROM inbox_item WHERE dedup_key = ? AND end_class IS NULL', first.dedupKey)!.n), 1);
});

test('apply refuses a second live item under one dedupKey (dedup-live), typed, before the unique index under it would; an ended one does not count', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.event('p1', 1), R.item('i1', { dedup: 'k1' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  const apply = (recs: Rec[]) => {
    try {
      applyBatch(s.db, rawBatch(appliedTail(s.db), recs));
      return 'applied';
    } catch (e) {
      return e instanceof ApplyError ? e.reason : String(e);
    }
  };
  assert.equal(apply([R.event('p1', 2), R.item('i2', { dedup: 'k1' }), R.tr('inbox_item', 'i2', 'none', 'open', srcCause('p1', 2))]), 'dedup-live');
  assert.throws(() => s.db.run("INSERT INTO inbox_item (id, kind, sev, grp, conf, state, dedup_key, rev, created_jseq) VALUES ('raw', 'question', 'P1', 'fermatas', 'high', 'open', ?, 1, 1)", digestOf('k1')), /UNIQUE constraint failed/, 'the backstop');
  s.commit([R.event('p1', 3), R.tr('inbox_item', 'i1', 'open', 'auto-cleared', srcCause('p1', 3))]);
  assert.equal(apply([R.event('p1', 4), R.item('i2', { dedup: 'k1' }), R.tr('inbox_item', 'i2', 'none', 'open', srcCause('p1', 4))]), 'applied');
});
