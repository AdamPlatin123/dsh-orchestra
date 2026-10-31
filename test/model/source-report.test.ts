import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceReport } from '../../src/model/source-report.ts';
import { COUNT_NAMES, STALL_FLOOR_MS, SourceReportError, sourceReport, stallAfterMs, stalled } from '../../src/model/source-report.ts';

// Plan step 3: each source's Tuning report (root, version, counts, errors) and its three times.
// Stalled is judged on lastPollMono alone (invariant 20): max(3 x the poll interval, 15 s), and from
// the source's setup before its first poll; the wall readings are display only.

const base = (): SourceReport => ({
  source: 'claude', root: 'C:\\fake\\claude', version: '2.1.17',
  counts: { sessions: 3, events: 120, items: 2, parseErrors: 0, skippedLines: 1, missedTransitions: 0 },
  errors: [{ code: 'registry.parse', count: 2, lastWall: 1_761_868_800_000 }], othersCount: 0,
  pollIntervalMs: 250, registeredMono: 1000, lastPollMono: 9000, lastPollWall: 1_761_868_808_000, lastEventWall: null,
});

test('a report is copied, frozen and checked field by field; the version passes its grammar or is null', () => {
  const r = sourceReport(base());
  assert.deepEqual({ ...r, counts: { ...r.counts }, errors: r.errors.map((e) => ({ ...e })) }, base());
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.counts) && Object.isFrozen(r.errors) && Object.isFrozen(r.errors[0]));
  assert.equal(sourceReport({ ...base(), version: null }).version, null);
  assert.deepEqual(Object.keys(r.counts), [...COUNT_NAMES]);
  const bad: [string, Partial<SourceReport> | Record<string, unknown>][] = [
    ['source', { source: 'emacs' }],
    ['root', { root: 'relative\\dir' }],
    ['root', { root: '\\\\server\\share' }],
    ['version', { version: '1.2.3 beta' }],
    ['version', { version: '2.1.17\u202e' }],
    ['counts', { counts: { ...base().counts, secrets: 1 } }],
    ['counts.events', { counts: { ...base().counts, events: -1 } }],
    ['counts.items', { counts: { ...base().counts, items: 1.5 } }],
    ['errors[0]', { errors: [{ code: 'has space', count: 1, lastWall: 0 }] }],
    ['errors[0]', { errors: [{ code: 'x', count: 0, lastWall: 0 }] }],
    ['errors', { errors: [{ code: 'x', count: 1, lastWall: 0 }, { code: 'x', count: 2, lastWall: 0 }] }],
    ['errors', { errors: Array.from({ length: 17 }, (_, i) => ({ code: `e${i}`, count: 1, lastWall: 0 })) }],
    ['othersCount', { othersCount: -1 }],
    ['registeredMono', { registeredMono: 1.5 }],
    ['pollIntervalMs', { pollIntervalMs: 0 }],
    ['lastPollMono', { lastPollMono: 999 }],
    ['lastPollWall', { lastPollMono: null }],
    ['lastEventWall', { lastEventWall: -5 }],
    ['text', { text: 'source free text' }],
  ];
  for (const [field, patch] of bad) assert.throws(() => sourceReport({ ...base(), ...patch } as SourceReport), (e: unknown) => e instanceof SourceReportError && e.field === field, field);
});

test('a report reads its own fields only: a version on Object.prototype is no version, the report is incomplete', () => {
  const r: Record<string, unknown> = { ...base() };
  delete r.version;
  Object.defineProperty(Object.prototype, 'version', { value: '9.9.9', configurable: true, writable: true });
  try {
    assert.throws(() => sourceReport(r as SourceReport), (e: unknown) => e instanceof SourceReportError && e.field === 'version');
  } finally {
    delete (Object.prototype as Record<string, unknown>).version;
  }
});

test('stalled: max(3 x interval, 15 s) on the monotonic clock; a 1 s event-loop stall never flags a 250 ms poller; a source that never polled stalls from its setup', () => {
  assert.equal(stallAfterMs(250), STALL_FLOOR_MS);
  assert.equal(stallAfterMs(5000), 15_000);
  assert.equal(stallAfterMs(10_000), 30_000);
  const r = sourceReport(base());
  assert.equal(stalled(r, 9000 + 1250), false, 'one poll late by a 1 s stall');
  assert.equal(stalled(r, 9000 + 15_000), false, 'at the threshold: not yet');
  assert.equal(stalled(r, 9000 + 15_001), true);
  const slow = sourceReport({ ...base(), pollIntervalMs: 10_000 });
  assert.equal(stalled(slow, 9000 + 29_000), false);
  assert.equal(stalled(slow, 9000 + 30_001), true);
  const never = sourceReport({ ...base(), lastPollMono: null, lastPollWall: null });
  assert.equal(stalled(never, 1000 + 15_000), false);
  assert.equal(stalled(never, 1000 + 15_001), true, 'no poll at all is a stall too');
});

test('stalled never reads a wall time: the same mono readings with the wall moved by an hour either way give the same verdicts', () => {
  for (const now of [9000, 9000 + 15_000, 9000 + 15_001, 9000 + 60_000]) {
    const verdicts = [-3_600_000, 0, 3_600_000].map((d) => stalled(sourceReport({ ...base(), lastPollWall: base().lastPollWall! + d, lastEventWall: 1_761_868_808_000 + d }), now));
    assert.equal(new Set(verdicts).size, 1, String(now));
  }
  // Only the three fields it is typed to take: a report without wall fields stalls the same.
  assert.equal(stalled({ pollIntervalMs: 250, registeredMono: 0, lastPollMono: 9000 }, 24_001), true);
});

test('stalled reads its own fields only and refuses a report it cannot judge: a lastPollMono on Object.prototype is no poll', () => {
  Object.defineProperty(Object.prototype, 'lastPollMono', { value: 1_000_000, configurable: true, writable: true });
  try {
    assert.equal(stalled({ pollIntervalMs: 250, registeredMono: 0 } as never, 20_000), true, 'measured from its setup, not from the poisoned poll');
  } finally {
    delete (Object.prototype as Record<string, unknown>).lastPollMono;
  }
  assert.throws(() => stalled({ pollIntervalMs: 250 } as never, 20_000), SourceReportError);
  assert.throws(() => stalled({ pollIntervalMs: 250, registeredMono: 0, lastPollMono: null }, Number.NaN), SourceReportError);
});
