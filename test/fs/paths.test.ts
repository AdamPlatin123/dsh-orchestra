import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize, checkPath, isWithin, relativeTo } from '../../src/fs/paths.ts';
import { junction, probeJunction, put, shortNameOf, withTmp } from '../helpers/tmp.ts';

test('plain drive paths pass and are normalized; .. is resolved lexically, as Win32 does', () => {
  const cases: Array<[string, string]> = [
    ['C:\\a\\b', 'C:\\a\\b'],
    ['c:/a//b/', 'c:\\a\\b'],
    ['C:\\', 'C:\\'],
    ['C:\\a\\..\\b', 'C:\\b'],
    ['C:\\a\\.\\b\\', 'C:\\a\\b'],
    ['C:\\..\\..\\x', 'C:\\x'],
    ['D:\\x\\.claude\\..\\y', 'D:\\x\\y'],
    ['C:\\x\\.env', 'C:\\x\\.env'],
  ];
  for (const [input, want] of cases) assert.deepEqual(checkPath(input), { ok: true, path: want }, input);
});

test('every escape form is rejected with its own reason', () => {
  const cases: Array<[string, string]> = [
    ['', 'empty'],
    ['C:\\a\u0000b', 'nul-byte'],
    ['C:\\a\u0001b', 'invalid-char'],
    ['\\\\?\\C:\\x', 'device-namespace'],
    ['//?/C:/x', 'device-namespace'],
    ['\\\\.\\pipe\\x', 'device-namespace'],
    ['\\\\.\\C:\\x', 'device-namespace'],
    ['\\??\\C:\\x', 'device-namespace'],
    ['\\\\server\\share\\x', 'unc'],
    ['//server/share/x', 'unc'],
    ['\\\\localhost\\C$\\x', 'unc'],
    ['a\\b', 'not-absolute'],
    ['C:x', 'not-absolute'],
    ['\\x', 'not-absolute'],
    ['C:\\a\\b:stream', 'ads'],
    ['C:\\a\\b::$DATA', 'ads'],
    ['C:\\a\\b:', 'ads'],
    ['C:\\a\\b*', 'invalid-char'],
    ['C:\\a\\b?', 'invalid-char'],
    ['C:\\a\\<b>', 'invalid-char'],
    ['C:\\a\\b|c', 'invalid-char'],
    ['C:\\a\\b.', 'trailing-dot-or-space'],
    ['C:\\a\\b ', 'trailing-dot-or-space'],
    ['C:\\a\\.claude.\\x', 'trailing-dot-or-space'],
    ['C:\\a\\b. \\c', 'trailing-dot-or-space'],
    ['C:\\a\\...', 'trailing-dot-or-space'],
    ['C:\\a\\CON', 'device-name'],
    ['C:\\a\\nul', 'device-name'],
    ['C:\\a\\COM1', 'device-name'],
    ['C:\\a\\lpt9\\x', 'device-name'],
    ['C:\\a\\con.txt', 'device-name'],
    ['C:\\a\\NUL.tar.gz', 'device-name'],
    ['C:\\a\\aux .log', 'device-name'],
    ['C:\\a\\COM\u00b9', 'device-name'],
    ['C:\\a\\CONIN$', 'device-name'],
    ['C:\\a\\conout$', 'device-name'],
  ];
  for (const [input, reason] of cases) assert.deepEqual(checkPath(input), { ok: false, reason }, JSON.stringify(input));
});

test('names that only look like devices pass', () => {
  for (const name of ['console', 'com10', 'nullx', 'CON_x', 'lpt', 'auxiliary.txt']) {
    assert.equal(checkPath(`C:\\a\\${name}`).ok, true, name);
  }
});

test('isWithin compares case-insensitively and on segment boundaries', () => {
  assert.equal(isWithin('C:\\a\\b', 'C:\\a'), true);
  assert.equal(isWithin('C:\\a', 'C:\\a'), true);
  assert.equal(isWithin('C:\\A\\B', 'c:\\a'), true);
  assert.equal(isWithin('C:\\a\\bc', 'C:\\a\\b'), false);
  assert.equal(isWithin('C:\\a', 'C:\\a\\b'), false);
  assert.equal(isWithin('C:\\x', 'C:\\'), true);
  assert.equal(isWithin('D:\\a', 'C:\\'), false);
});

test('relativeTo gives forward slashes and "" for the root itself', () => {
  assert.equal(relativeTo('C:\\r', 'C:\\R'), '');
  assert.equal(relativeTo('C:\\r', 'c:\\r\\a\\b.json'), 'a/b.json');
});

test('canonicalize: missing tail joins onto the realpath of the nearest existing ancestor', (t) => {
  const base = withTmp(t);
  const real = fs.realpathSync.native(base);
  fs.mkdirSync(path.join(base, 'a'));
  assert.equal(canonicalize(path.join(base, 'a', 'b', 'c.txt')), path.join(real, 'a', 'b', 'c.txt'));
  assert.equal(canonicalize(path.join(base, 'A')), path.join(real, 'a'));
});

test('canonicalize resolves a junction', (t) => {
  const probe = probeJunction();
  if (!probe.ok) return t.skip(probe.why);
  const base = withTmp(t);
  const real = fs.realpathSync.native(base);
  put(path.join(base, 'target', 'f.txt'));
  junction(base, path.join(base, 'j'), path.join(base, 'target'));
  assert.equal(canonicalize(path.join(base, 'j', 'f.txt')), path.join(real, 'target', 'f.txt'));
  assert.equal(canonicalize(path.join(base, 'j', 'missing', 'x')), path.join(real, 'target', 'missing', 'x'));
});

test('canonicalize resolves an 8.3 short name', (t) => {
  const base = withTmp(t);
  const real = fs.realpathSync.native(base);
  fs.mkdirSync(path.join(base, 'averylongdirectoryname'));
  const short = shortNameOf(base, 'averylongdirectoryname');
  if (short === null) return t.skip('the temp volume does not generate 8.3 short names');
  assert.equal(canonicalize(path.join(base, short, 'x')), path.join(real, 'averylongdirectoryname', 'x'));
});

test('canonicalize propagates errors other than "missing" (callers fail closed)', () => {
  const denied = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  assert.throws(() => canonicalize('C:\\x\\y', denied), { code: 'EACCES' });
});
