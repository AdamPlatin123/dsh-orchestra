import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemKind } from '../../shared/protocol.js';
import { GROUPS, ITEM_KINDS, SEVERITIES, TITLE_KEYS, compareRows } from '../../shared/protocol.js';
import { TITLE_TEXT, formatTitle } from '../../shared/strings.js';
import { InboxError, KIND_RULES, defaultSeverity, groupOf, itemBodyError, openItem, titleKey, verbsFor } from '../../src/model/inbox.ts';
import { checkBody } from '../../src/store/records.ts';
import { JournalError } from '../../src/store/journal.ts';
import { R, srcCause } from '../helpers/records.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';

// Plan step 3, r4 §11.2: kinds and their default levels and groups, the guess classes, the verbs each
// kind offers and its title key. The journal refuses an item body that breaks the kind table, at the
// append as at the scan and at apply (records.ts consistency).

test('the kind table covers protocol.js\'s kinds, in order, and nothing else', () => {
  assert.deepEqual(Object.keys(KIND_RULES), [...ITEM_KINDS]);
  assert.ok(Object.isFrozen(KIND_RULES) && Object.values(KIND_RULES).every((r) => Object.isFrozen(r) && Object.isFrozen(r.sevs) && Object.isFrozen(r.verbs)));
});

test('groups and default levels are r4 §11.2\'s for M0 (observed only): one level per kind', () => {
  const table = Object.fromEntries(ITEM_KINDS.map((k) => [k, `${groupOf(k)} ${defaultSeverity(k)} ${KIND_RULES[k].sevs.join('|')}`]));
  assert.deepEqual(table, {
    approval: 'fermatas P1 P1',
    question: 'fermatas P1 P1',
    failure: 'wrong-notes P2 P2',
    runaway: 'wrong-notes P0 P0',
    policy: 'wrong-notes P2 P2',
    'ready-for-review': 'ready-for-review P3 P3',
    flood: 'wrong-notes P2 P2',
    reminder: 'reminders P1 P1',
    'unknown-outcome': 'fermatas P1 P1',
  });
  for (const k of ITEM_KINDS) {
    assert.ok((GROUPS as readonly string[]).includes(groupOf(k)), k);
    assert.ok(KIND_RULES[k].sevs.every((s) => (SEVERITIES as readonly string[]).includes(s)), k);
  }
});

test('only approval and question may be a guess, and a guess has a title key of its own whose text says 推测', () => {
  assert.deepEqual(ITEM_KINDS.filter((k) => KIND_RULES[k].confs.includes('low')), ['approval', 'question']);
  for (const k of ITEM_KINDS) {
    assert.equal(titleKey(k, 'high'), `item.${k}`);
    if (KIND_RULES[k].confs.includes('low')) {
      assert.equal(titleKey(k, 'low'), `item.${k}.guess`);
      assert.ok(TITLE_TEXT[titleKey(k, 'low')]!.startsWith('推测：'), k);
      assert.ok(!TITLE_TEXT[titleKey(k, 'high')]!.includes('推测'), k);
    } else {
      assert.throws(() => titleKey(k, 'low'), InboxError, k);
    }
  }
  const used = ITEM_KINDS.flatMap((k) => KIND_RULES[k].confs.map((c) => titleKey(k, c)));
  assert.deepEqual([...used].sort(), [...TITLE_KEYS].sort(), 'every title key is some kind\'s, and every kind has one');
  assert.equal(formatTitle({ key: 'item.question.guess', args: { project: 'shop-web' } }), '推测：shop-web 可能在等你回答');
});

test('verbs by kind: every kind offers open, peek, seen, snooze and acted; only runaway and flood offer the brake; a reminder offers no remind', () => {
  const brake = ITEM_KINDS.filter((k) => verbsFor(k, 'open').includes('brake'));
  assert.deepEqual(brake, ['runaway', 'flood']);
  for (const k of ITEM_KINDS) for (const v of ['open', 'peek', 'seen', 'snooze', 'acted'] as const) assert.ok(verbsFor(k, 'open').includes(v), `${k} ${v}`);
  assert.deepEqual(ITEM_KINDS.filter((k) => !verbsFor(k, 'open').includes('remind')), ['reminder']);
});

test('the row order follows the kind table: a P0 runaway still sorts after a P1 question, since the group comes first (UI design 一 7)', () => {
  const row = (k: ItemKind, id: string, committedJseq: number) => ({ group: groupOf(k), sev: defaultSeverity(k), committedJseq, id });
  const rows = [row('ready-for-review', 'a', 1), row('runaway', 'b', 2), row('reminder', 'c', 3), row('question', 'd', 9), row('failure', 'e', 0)];
  assert.deepEqual([...rows].sort(compareRows).map((r) => r.id), ['d', 'b', 'e', 'a', 'c']);
});

test('an item body that breaks the kind table is refused: the group, a level the kind does not have, a guess it cannot be, a reminder id on the wrong kind', async (t) => {
  const why = (patch: Record<string, unknown>) => {
    const b = { ...R.item('x1').body, ...patch };
    const e = checkBody('item', b, null);
    return e === null ? 'ok' : `${e.reason} ${e.at}`;
  };
  assert.equal(why({}), 'ok');
  assert.equal(why({ group: 'wrong-notes' }), 'consistency $.group');
  assert.equal(why({ sev: 'P0' }), 'consistency $.sev');
  assert.equal(why({ itemKind: 'failure', group: 'wrong-notes', sev: 'P2', conf: 'low' }), 'consistency $.conf');
  assert.equal(why({ reminderId: 'rem1' }), 'consistency $.reminderId');
  assert.equal(why({ itemKind: 'reminder', group: 'reminders', sev: 'P1', reminderId: null }), 'consistency $.reminderId');
  assert.equal(why({ itemKind: 'reminder', group: 'reminders', sev: 'P1', reminderId: 'rem1' }), 'ok');
  assert.equal(itemBodyError({ ...R.item('x1').body, itemKind: 'nope' }), '$.itemKind');
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  assert.throws(() => s.commit([R.item('i1', { sev: 'P3' }), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record');
  assert.equal(s.db.get('SELECT count(*) AS n FROM inbox_item')!.n, 0);
});

test('openItem takes the level and group from the kind table: a level the kind does not have, or a guess it cannot be, is refused', () => {
  const index = { live: () => null, count: () => 0 };
  const base = { kind: 'runaway' as const, partRef: 'p1', sender: 'p1', segment: null, conf: 'high' as const, projectId: null, reminderId: null };
  const d = openItem(index, base, srcCause('p1', 1));
  assert.deepEqual(d.kind === 'open' ? { sev: d.records[0]!.body.sev, group: d.records[0]!.body.group } : null, { sev: 'P0', group: 'wrong-notes' });
  assert.throws(() => openItem(index, { ...base, sev: 'P2' }, srcCause('p1', 1)), InboxError);
  assert.throws(() => openItem(index, { ...base, conf: 'low' }, srcCause('p1', 1)), InboxError);
  assert.throws(() => openItem(index, { ...base, reminderId: 'rem1' }, srcCause('p1', 1)), InboxError);
  assert.throws(() => openItem(index, { ...base, projectId: 'a:b' }, srcCause('p1', 1)), InboxError);
  const remind = { kind: 'reminder' as const, partRef: null, sender: 'rem1', segment: null, conf: 'high' as const, projectId: null, reminderId: 'rem1' };
  assert.equal(openItem(index, remind, { kind: 'clock', timerId: 'reminder:rem1:0' }).kind, 'open');
  assert.throws(() => openItem(index, { ...remind, reminderId: 'a:b' }, { kind: 'clock', timerId: 'reminder:rem1:0' }), InboxError, 'a reminder id outside the id grammar');
});
