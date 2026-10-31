import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Log, MAX_STRING, REDACTED, scrubString, scrubValue } from '../../src/runtime/log.ts';

const T0 = Date.parse('2026-10-31T08:00:00Z');
/** The wall clock a Log stamps entries with: fixed here. */
const clock = { nowWall: () => T0 };

test('secret-named fields never reach an entry or the sink, at any depth', () => {
  const lines: string[] = [];
  const log = new Log({ clock, sink: (l) => lines.push(l) });
  log.info('pairing', { code: '12345678', pairingCode: '87654321', nested: { launchToken: 'abc', csrf: 'x', cookie: 'y', Authorization: 'Bearer q', apiKey: 'k', password: 'p' }, exitCode: 3 });
  const e = log.entries()[0]!;
  assert.deepEqual(e.fields, {
    code: REDACTED,
    pairingCode: REDACTED,
    nested: { launchToken: REDACTED, csrf: REDACTED, cookie: REDACTED, Authorization: REDACTED, apiKey: REDACTED, password: REDACTED },
    exitCode: 3,
  });
  const text = lines.join('');
  for (const secret of ['12345678', '87654321', 'abc', 'Bearer q']) assert.ok(!text.includes(secret), secret);
});

test('token= values and bearer tokens are masked inside any string; control characters are replaced', () => {
  assert.equal(scrubString('http://127.0.0.1:3080/connect?token=s3cr3t&interactions=none'), 'http://127.0.0.1:3080/connect?token=***&interactions=none');
  assert.equal(scrubString('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
  assert.equal(scrubString('a\u001b]8;;http://x\u0007b\u009bc\r\n'), 'a?]8;;http://x?b?c??');
});

test('long strings are cut at 2 KB, long arrays at 50 items; depth, cycles and odd values are made safe', () => {
  const long = scrubString('x'.repeat(MAX_STRING + 10));
  assert.ok(long.startsWith('x'.repeat(MAX_STRING)) && long.endsWith('…[+10]'));
  const arr = scrubValue(Array.from({ length: 60 }, (_, i) => i)) as unknown[];
  assert.equal(arr.length, 51);
  assert.equal(arr.at(-1), '[+10]');
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  assert.deepEqual(scrubValue(cyc), { a: 1, self: '[circular]' });
  assert.deepEqual(scrubValue({ a: { b: { c: { d: { e: 1 } } } } }), { a: { b: { c: { d: '[depth]' } } } });
  assert.deepEqual(scrubValue({ n: NaN, b: 5n, f: () => 1, u: undefined }), { n: 'NaN', b: '5', f: '[function]', u: null });
  const err = Object.assign(new Error('open token=abc failed'), { code: 'EPERM' });
  assert.deepEqual(scrubValue({ error: err }), { error: { name: 'Error', message: 'open token=*** failed', code: 'EPERM' } });
});

test('a Log needs a clock: no default, and the old now field is no clock', () => {
  assert.throws(() => new Log({} as never), /log: clock is required, there is no default/);
  assert.throws(() => new Log({ now: () => T0 } as never), /log: clock is required/);
  assert.throws(() => new Log(Object.create({ clock }) as never), /log: clock is required/, 'an inherited clock is not one the caller set');
  const log = new Log({ clock: { nowWall: () => T0 + 1 } });
  log.info('x');
  assert.equal(log.entries()[0]!.at, '2026-10-31T08:00:00.001Z');
});

test('the ring keeps the newest entries; event names are a fixed alphabet', () => {
  const log = new Log({ clock, capacity: 3 });
  for (let i = 0; i < 5; i++) log.info('tick', { i });
  log.warn('Bad Event Name!');
  assert.deepEqual(log.entries().map((e) => [e.seq, e.event]), [[4, 'tick'], [5, 'tick'], [6, 'invalid-event-name']]);
  assert.equal(log.dropped(), 3);
  assert.equal(log.entries()[0]!.at, '2026-10-31T08:00:00.000Z');
});

test('attach() writes what the ring holds, then every new entry, as JSON lines; a failing sink is counted, never thrown', () => {
  const log = new Log({ clock });
  log.info('before', { x: 1 });
  const lines: string[] = [];
  log.attach((l) => lines.push(l));
  log.error('after');
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { event: string }).event), ['before', 'after']);
  assert.ok(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
  log.attach(() => {
    throw new Error('disk full');
  });
  assert.doesNotThrow(() => log.info('still-fine'));
  assert.ok(log.sinkFailures() >= 1);
  assert.equal(log.entries().at(-1)!.event, 'still-fine');
});
