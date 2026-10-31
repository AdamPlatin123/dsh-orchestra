import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult } from '../../src/os/spawn.ts';
import { SpawnGate, resolveSystemRoot } from '../../src/os/spawn.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { judgeWhoamiRun, levelForRid, parseCsvLine, parseWhoamiGroups, probeIntegrity } from '../../src/runtime/integrity.ts';
import { fakeSpawn, whoamiChinese, whoamiEnglish, whoamiSpy } from '../helpers/fake-spawn.ts';

const ran = (stdout: Buffer | string, exitCode = 0): RunResult => ({ ok: true, exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
const level = (r: RunResult) => judgeWhoamiRun(r);

for (const [lang, make] of [['English', whoamiEnglish], ['Chinese (GBK)', whoamiChinese]] as const) {
  test(`whoami ${lang}: Medium, High, System, Low and Untrusted map by the label SID alone`, () => {
    assert.deepEqual(level(ran(make('Medium Mandatory Level'))), { level: 'medium', rid: 8192, sid: 'S-1-16-8192' });
    assert.deepEqual(level(ran(make('Medium Plus Mandatory Level'))), { level: 'medium', rid: 8448, sid: 'S-1-16-8448' });
    assert.deepEqual(level(ran(make('High Mandatory Level'))), { level: 'high-or-above', rid: 12288, sid: 'S-1-16-12288' });
    assert.deepEqual(level(ran(make('System Mandatory Level'))), { level: 'high-or-above', rid: 16384, sid: 'S-1-16-16384' });
    assert.deepEqual(level(ran(make('Low Mandatory Level'))), { level: 'low', rid: 4096, sid: 'S-1-16-4096' });
    assert.deepEqual(level(ran(make('Untrusted Mandatory Level'))), { level: 'low', rid: 0, sid: 'S-1-16-0' });
  });

  test(`whoami ${lang}: no label line is unknown`, () => {
    assert.deepEqual(level(ran(make(null))), { level: 'unknown', reason: 'no-label' });
  });
}

test('whoami: empty or blank output is unknown', () => {
  assert.deepEqual(level(ran('')), { level: 'unknown', reason: 'empty-output' });
  assert.deepEqual(level(ran('\r\n  \r\n')), { level: 'unknown', reason: 'empty-output' });
});

test('whoami: the same bytes decoded as UTF-8 group names parse the same way', () => {
  const utf8 = Buffer.from('"Everyone","已知组","S-1-1-0","必需的组, 启用于默认, 启用的组"\r\n"Mandatory Label\\Medium Mandatory Level","标签","S-1-16-8192",""\r\n', 'utf8');
  assert.equal(level(ran(utf8)).level, 'medium');
});

test('whoami: a failed run is unknown whatever it printed, 0xC0000142 included', () => {
  const good = whoamiEnglish('Medium Mandatory Level');
  assert.deepEqual(level(ran(good, 3221225794)), { level: 'unknown', reason: 'exit-nonzero', detail: '0xC0000142' });
  assert.deepEqual(level(ran(good, 1)), { level: 'unknown', reason: 'exit-nonzero', detail: '1' });
  assert.deepEqual(level({ ok: false, reason: 'timeout', timeoutMs: 10 }), { level: 'unknown', reason: 'timeout', detail: '10 ms' });
  assert.deepEqual(level({ ok: false, reason: 'spawn-failed', detail: 'ENOENT' }), { level: 'unknown', reason: 'spawn-failed', detail: 'ENOENT' });
  assert.deepEqual(level({ ok: false, reason: 'signal', signal: 'SIGTERM' }), { level: 'unknown', reason: 'signal', detail: 'SIGTERM' });
  assert.deepEqual(level({ ok: false, reason: 'output-too-large', maxBytes: 5 }), { level: 'unknown', reason: 'output-too-large', detail: '5 bytes' });
  assert.deepEqual(level({ ok: false, reason: 'refused', decision: { allow: false, reason: 'argv-mismatch', exe: 'x' } }), { level: 'unknown', reason: 'spawn-refused', detail: 'argv-mismatch' });
});

test('whoami: two label lines or broken quoting are unknown, never a guess', () => {
  const two = Buffer.concat([whoamiEnglish('Medium Mandatory Level'), whoamiEnglish('High Mandatory Level')]);
  assert.equal((level(ran(two)) as { reason?: string }).reason, 'multiple-labels');
  assert.deepEqual(level(ran('"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192\r\n')), { level: 'unknown', reason: 'parse-error', detail: 'quoting broken on line 1' });
  assert.equal((level(ran('"a"b,"S-1-16-8192"\r\n')) as { reason?: string }).reason, 'parse-error');
  assert.equal((level(ran('"x","S-1-16-99999999999"\r\n')) as { reason?: string }).reason, 'no-label');
  assert.equal((level(ran('"x","S-1-16-4294967296"\r\n')) as { reason?: string }).reason, 'bad-rid');
  // A SID inside a longer field is not the label.
  assert.equal((level(ran('"x","prefix S-1-16-8192"\r\n')) as { reason?: string }).reason, 'no-label');
});

test('rid boundaries', () => {
  assert.equal(levelForRid(8191), 'low');
  assert.equal(levelForRid(8192), 'medium');
  assert.equal(levelForRid(12287), 'medium');
  assert.equal(levelForRid(12288), 'high-or-above');
  assert.equal(levelForRid(20480), 'high-or-above');
});

test('CSV: quoted commas, doubled quotes, empty fields', () => {
  assert.deepEqual(parseCsvLine('"a, b","c""d","",e'), ['a, b', 'c"d', '', 'e']);
  assert.deepEqual(parseCsvLine(''), ['']);
  assert.equal(parseCsvLine('"open'), null);
  assert.equal(parseCsvLine('"a"x'), null);
});

test('probeIntegrity runs exactly whoami /groups /fo csv /nh through the gate and judges it', async () => {
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok, JSON.stringify(sys));
  const spy = whoamiSpy(whoamiChinese('Low Mandatory Level'));
  const gate = new SpawnGate({ systemRoot: sys, rules: ['whoami'], backend: spy.backend, record: () => {}, realpath, clock: makeRealClock() });
  assert.deepEqual(await probeIntegrity(gate, sys.path), { level: 'low', rid: 4096, sid: 'S-1-16-4096' });
  assert.equal(spy.calls.length, 1);
  assert.match(spy.calls[0]!.exe, /\\System32\\whoami\.exe$/i);
  assert.deepEqual(spy.calls[0]!.argv, ['/groups', '/fo', 'csv', '/nh']);
  assert.equal(spy.calls[0]!.opts.shell, false);
});

test('probeIntegrity: a whoami that never exits is killed through its handle and judged unknown', async () => {
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const spy = fakeSpawn(() => ({ hang: true }));
  const gate = new SpawnGate({ systemRoot: sys, rules: ['whoami'], backend: spy.backend, record: () => {}, realpath, clock: makeRealClock() });
  const r = await gate.run({ exe: `${sys.path}\\System32\\whoami.exe`, argv: ['/groups', '/fo', 'csv', '/nh'] }, { timeoutMs: 20, maxBytes: 1024 });
  assert.deepEqual(judgeWhoamiRun(r), { level: 'unknown', reason: 'timeout', detail: '20 ms' });
  assert.equal(spy.kills, 1);
});

test('the real whoami.exe (the one binary these tests run) gives a typed level', async (t) => {
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const recorded: string[] = [];
  // The production backend, as main.ts gets it: makeSpawnGate from the minted src/os/node-proc.ts.
  const gate = makeSpawnGate({ systemRoot: sys, rules: ['whoami'], record: (e) => recorded.push(e.rule), realpath, clock: makeRealClock() });
  const i = await probeIntegrity(gate, sys.path);
  assert.deepEqual(recorded, ['whoami'], 'the run was recorded');
  t.diagnostic(`this process: ${JSON.stringify(i)}`);
  if (i.level === 'unknown') {
    // S5 saw one 0xC0000142; that outcome is legal, and planStartup turns it into ui-only.
    assert.ok(['exit-nonzero', 'spawn-failed', 'timeout'].includes(i.reason), JSON.stringify(i));
  } else {
    assert.match(i.sid, /^S-1-16-\d+$/);
  }
  assert.equal(parseWhoamiGroups('').level, 'unknown');
});
