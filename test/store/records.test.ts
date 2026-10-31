import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Kind } from '../../src/store/records.ts';
import { BODY_SCHEMAS, KINDS, brakeStatus, checkBody, planExpired, sourceString, sourceStringError } from '../../src/store/records.ts';
import { PLAN_TTL_MS } from '../../shared/constants.js';
import { T0 } from '../helpers/store.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { R, digestOf, uuidOf } from '../helpers/records.ts';

// Plan step 3: the body schemas of the journal's kinds, one failing sample per check. Each sample
// breaks exactly one rule, so each rule's check is what refuses it (reason and place).

const A = uuidOf('records');
const ok = (kind: Kind, body: unknown) => checkBody(kind, body, null);
const why = (kind: Kind, body: unknown) => {
  const e = checkBody(kind, body, null);
  return e === null ? 'ok' : `${e.reason} ${e.at}`;
};
const sub = (status: string, killed = 1, residual = 0) => ({ root: { pid: 5, createTime: '13' }, requestId: 'r1', killed, residual, status });
const with_ = (r: { body: Record<string, unknown> }, patch: Record<string, unknown>) => ({ ...r.body, ...patch });

test('brakeStatus: unknown before refused before residual before ok', () => {
  assert.equal(brakeStatus([sub('refused', 0), sub('unknown', 0)]), 'unknown');
  assert.equal(brakeStatus([sub('partial', 1, 2), sub('refused', 0)]), 'refused');
  assert.equal(brakeStatus([sub('ok'), sub('partial', 1, 2)]), 'partial');
  assert.equal(brakeStatus([sub('ok', 1, 3)]), 'partial', 'any residual is residual');
  assert.equal(brakeStatus([sub('ok'), sub('ok')]), 'ok');
});

test('source strings: type, length, grammar per kind, and the redactor', () => {
  const red = makeRedactor({ env: { MY_TOKEN: 'abcdefghij1234567890' } });
  assert.equal(sourceStringError('version', '', null), 'type');
  assert.equal(sourceStringError('version', 7, null), 'type');
  assert.equal(sourceStringError('cwd', `C:\\${'a'.repeat(125)}`, null), null, '128 characters');
  assert.equal(sourceStringError('cwd', `C:\\${'a'.repeat(126)}`, null), 'too-long');
  assert.equal(sourceStringError('cwd', 'relative\\dir', null), 'grammar');
  assert.equal(sourceStringError('cwd', 'C:\\a\u0085b', null), 'grammar', 'a C1 control');
  assert.equal(sourceStringError('version', '1.2.3 beta', null), 'grammar');
  assert.equal(sourceStringError('tool', 'two words', null), 'grammar');
  assert.equal(sourceStringError('errorCode', '9starts-with-digit', null), 'grammar');
  assert.equal(sourceStringError('cwd', 'C:\\work\\abcdefghij1234567890', red), 'redacted');
  assert.equal(sourceStringError('cwd', 'C:\\work\\abcdefghij1234567890', null), null, 'without a redactor only the grammar counts');
  assert.equal(sourceString('tool', 'Bash', red), 'Bash');
  assert.equal(sourceString('tool', 'two words', red), null);
});

test('objects: plain, closed, every field own and present; accessors and symbol keys refused', () => {
  const ev = R.event('p1', 1);
  assert.equal(ok('event', ev.body), null);
  assert.equal(why('event', Object.assign(Object.create({}) as object, ev.body)), 'not-plain $');
  assert.equal(why('event', [ev.body]), 'not-plain $');
  assert.equal(why('event', with_(ev, { extra: 1 })), 'extra-key $');
  assert.equal(why('event', { ...ev.body, [Symbol('s')]: 1 }), 'extra-key $');
  const missing: Record<string, unknown> = { ...ev.body };
  delete missing.tool;
  assert.equal(why('event', missing), 'missing $.tool');
  assert.equal(why('event', Object.defineProperty({ ...missing }, 'tool', { get: () => null, enumerable: true })), 'missing $.tool');
  assert.equal(why('event', with_(ev, { srcSeq: null })), 'type $.srcSeq', 'null only where the schema says');
});

test('leaves: id, uuid, digest, createTime, target, timerId (and its class), outcome, int, const, enum', () => {
  assert.equal(why('event', with_(R.event('p1', 1), { partRef: 'a:b' })), 'grammar $.partRef');
  assert.equal(why('event', with_(R.event('p1', 1), { partRef: 5 })), 'type $.partRef');
  assert.equal(why('human', with_(R.human(A, 'seen'), { actionId: A.toUpperCase() })), 'grammar $.actionId');
  assert.equal(why('event', with_(R.event('p1', 1), { digest: 'ABC' })), 'grammar $.digest');
  assert.equal(why('protect', with_(R.protect('add', 4, '1'), { createTime: '0012' })), 'grammar $.createTime');
  assert.equal(why('human', with_(R.human(A, 'seen'), { targetId: '12:0' })), 'grammar $.targetId');
  assert.equal(why('human', with_(R.human(A, 'seen'), { targetId: '101:133000000000000001' })), 'ok');
  assert.equal(why('clock', with_(R.clock('reminder:r1:0', 'wall', 1, 1, 1), { timerId: 'reminder:r1' })), 'grammar $.timerId');
  assert.equal(why('clock', with_(R.clock('reminder:r1:0', 'wall', 1, 1, 1), { timerId: 'deadline:r1:0' })), 'enum $.timerId');
  assert.equal(why('human.result', with_(R.result(A, 'seen', 'i1'), { outcome: 1 })), 'type $.outcome');
  assert.equal(why('human.result', with_(R.result(A, 'seen', 'i1'), { outcome: 'noop:bored' })), 'enum $.outcome');
  assert.equal(why('human.result', with_(R.result(A, 'seen', 'i1'), { outcome: 'noop:already-ended' })), 'ok');
  assert.equal(why('project', with_(R.project('x', 'C:\\x'), { hue: 12 })), 'range $.hue');
  assert.equal(why('project', with_(R.project('x', 'C:\\x'), { hue: -1 })), 'range $.hue');
  assert.equal(why('project', with_(R.project('x', 'C:\\x'), { hue: '1' })), 'type $.hue');
  assert.equal(why('brake.plan', with_(R.plan('p', 1, 2), { ttlMs: 60_001 })), 'range $.ttlMs');
  assert.equal(why('part', with_(R.part('p1'), { harness: 3 })), 'type $.harness');
  assert.equal(why('part', with_(R.part('p1'), { harness: 'emacs' })), 'enum $.harness');
});

test('arrays, tagged unions and records', () => {
  const res = (subtrees: unknown) => ({ ...R.result(A, 'brake', '101:133000000000000001', 'applied', 'cmd1', null).body, subtrees });
  assert.equal(why('human.result', res({ 0: sub('ok'), length: 1 })), 'type $.subtrees');
  assert.equal(why('human.result', res([])), 'range $.subtrees');
  assert.equal(why('human.result', res(Array.from({ length: 65 }, () => sub('ok')))), 'range $.subtrees');
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(why('human.result', res([sub('ok'), , sub('ok')])), 'shape $.subtrees[1]');
  const tr = (cause: unknown) => ({ entity: 'inbox_item', id: 'i1', from: 'open', to: 'seen', cause });
  assert.equal(why('transition', tr([])), 'not-plain $.cause');
  assert.equal(why('transition', tr({ partRef: 'p1', srcSeq: 1 })), 'missing $.cause.kind');
  assert.equal(why('transition', tr({ kind: 'timer', timerId: 'reminder:r:0' })), 'enum $.cause.kind');
  assert.equal(why('transition', tr({ kind: 'human', actionId: A, partRef: 'p1' })), 'extra-key $.cause');
  const j = (format: unknown) => ({ ...R.judgment(digestOf('x')).body, value: { ver: 1, dropped: null, known: 0, format, entropy: 0 } });
  assert.equal(why('judgment', j([])), 'not-plain $.value.format');
  assert.equal(why('judgment', j({ [Symbol('s')]: 1 })), 'extra-key $.value.format');
  // A rule id outside today's FORMAT_RULES is refused at the append (policy, with the redactor) and
  // read in a stored line (format: an id in its grammar), so a retired rule never breaks an old journal.
  assert.equal(why('judgment', j({ secrets: 1 })), 'ok', 'a stored line: any rule id in its grammar');
  const atAppend = checkBody('judgment', j({ secrets: 1 }), makeRedactor({ env: {} }));
  assert.equal(atAppend === null ? 'ok' : `${atAppend.reason} ${atAppend.at}`, 'enum $.value.format', 'the append: today\'s rule ids only');
  assert.equal(why('judgment', j({ 'No Rule': 1 })), 'enum $.value.format', 'a key outside the rule-id grammar');
  assert.equal(why('judgment', j(Object.defineProperty({}, 'pem', { get: () => 1, enumerable: true }))), 'shape $.value.format');
  assert.equal(why('judgment', j({ pem: 1.5 })), 'type $.value.format[0]');
});

test('rules across fields: srcTime and its precision, the edges of each machine, a brake result with both or neither of commandId and subtrees, a command status that says what its subtrees say', () => {
  assert.equal(why('event', with_(R.event('p1', 1), { srcTime: 9, srcTimePrecision: 'none' })), 'consistency $.srcTime');
  assert.equal(why('event', with_(R.event('p1', 1), { srcTime: null, srcTimePrecision: 's' })), 'consistency $.srcTime');
  const tr = (entity: string, from: string, to: string) => ({ entity, id: 'x1', from, to, cause: { kind: 'human', actionId: A } });
  assert.equal(why('transition', tr('reminder', 'open', 'fired')), 'consistency $.from');
  assert.equal(why('transition', tr('reminder', 'pending', 'seen')), 'consistency $.to');
  assert.equal(why('transition', tr('inbox_item', 'expired', 'open')), 'consistency $.to');
  assert.equal(why('transition', tr('inbox_item', 'seen', 'snoozed')), 'ok');
  assert.equal(why('human.result', with_(R.result(A, 'seen', 'i1'), { commandId: 'cmd1' })), 'consistency $.commandId');
  assert.equal(why('human.result', with_(R.result(A, 'seen', 'i1'), { subtrees: [sub('ok')] })), 'consistency $.commandId');
  assert.equal(why('human.result', R.result(A, 'brake', '101:133000000000000001', 'applied', 'cmd1', [sub('refused', 2)]).body), 'consistency $.subtrees[0]');
  const cmd = (subs: unknown[], status: string) => R.command('cmd1', A, subs as never, status).body;
  assert.equal(why('command', cmd([sub('ok'), sub('refused', 0)], 'partial')), 'consistency $.status');
  assert.equal(why('command', cmd([sub('ok'), sub('refused', 0)], 'refused')), 'ok');
  assert.equal(why('command', cmd([sub('refused', 1)], 'refused')), 'consistency $.subtrees[0]');
  assert.equal(why('command', cmd([sub('refused', 0, 1)], 'refused')), 'consistency $.subtrees[0]');
  assert.equal(why('command', cmd([sub('ok', 1, 1)], 'partial')), 'consistency $.subtrees[0]');
  assert.equal(why('command', cmd([sub('partial', 1, 0)], 'partial')), 'consistency $.subtrees[0]');
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('no two kinds share a set of body keys, so a body\'s digest binds its kind (the chain covers digests only)', () => {
  const keysOf = (k: Kind) => {
    const s = BODY_SCHEMAS[k] as { t: string; fields?: Record<string, unknown> };
    return Object.keys(s.fields ?? {}).sort().join(',');
  };
  const seen = new Map<string, Kind>();
  for (const k of KINDS) {
    const key = keysOf(k);
    assert.ok(!seen.has(key), `${k} has the keys of ${seen.get(key)}`);
    seen.set(key, k);
  }
});

test('C6: the plan\'s optional fields (targetId?, commandId?, subtrees?) are nullable and always written: one left out is missing', () => {
  const human = { ...R.human(A, 'seen', 'i1').body };
  delete (human as Record<string, unknown>).targetId;
  assert.equal(why('human', human), 'missing $.targetId');
  const result = { ...R.result(A, 'seen', 'i1').body };
  delete (result as Record<string, unknown>).commandId;
  assert.equal(why('human.result', result), 'missing $.commandId');
});

test('R2-I: a brake plan carries its node list and createdWall; expiresAt is createdWall + 60 s and every root is a node', () => {
  const plan = R.plan('plan1', 1000, T0).body;
  assert.equal(why('brake.plan', plan), 'ok');
  assert.equal(why('brake.plan', with_({ body: plan }, { expiresAt: T0 + 10 * 365 * 86_400_000 })), 'consistency $.expiresAt');
  assert.equal(why('brake.plan', with_({ body: plan }, { nodes: [{ pid: 102, createTime: '133000000000000002' }] })), 'consistency $.roots[0]');
  assert.equal(why('brake.plan', with_({ body: plan }, { nodes: [] })), 'range $.nodes');
  const { nodes: _n, ...noNodes } = plan as Record<string, unknown>;
  assert.equal(why('brake.plan', noNodes), 'missing $.nodes');
});

test('R2-I: planExpired counts both clocks, the first to its end wins; another boot\'s plan has expired', () => {
  const boot = uuidOf('plan-boot');
  const plan = { createdMono: 5000, ttlMs: PLAN_TTL_MS, expiresAt: T0 + PLAN_TTL_MS };
  assert.equal(planExpired(plan, boot, { bootId: boot, mono: 5000, wall: T0 }), false);
  assert.equal(planExpired(plan, boot, { bootId: boot, mono: 5000 + PLAN_TTL_MS - 1, wall: T0 + PLAN_TTL_MS - 1 }), false);
  // The wall clock set back an hour: the monotonic 60 s still end the plan.
  assert.equal(planExpired(plan, boot, { bootId: boot, mono: 5000 + PLAN_TTL_MS, wall: T0 - 3_600_000 }), true);
  // The wall clock set forward an hour: expired at once.
  assert.equal(planExpired(plan, boot, { bootId: boot, mono: 5001, wall: T0 + 3_600_000 }), true);
  assert.equal(planExpired(plan, boot, { bootId: uuidOf('next-boot'), mono: 5001, wall: T0 + 1 }), true);
});

test('R2-K: a stored judgment names its rules by id grammar only; today\'s rule list holds at the append alone', () => {
  const j = (format: Record<string, number>) => ({ ...R.judgment(digestOf('x')).body, value: { ver: 1, dropped: null, known: 0, format, entropy: 0 } });
  assert.equal(why('judgment', j({ 'retired-rule': 1 })), 'ok');
  assert.equal(why('judgment', j({ pem: 1 })), 'ok');
  const atAppend = checkBody('judgment', j({ 'retired-rule': 1 }), makeRedactor({ env: {} }));
  assert.deepEqual(atAppend, { reason: 'enum', at: '$.value.format' });
  assert.equal(checkBody('judgment', j({ pem: 1 }), makeRedactor({ env: {} })), null);
});
