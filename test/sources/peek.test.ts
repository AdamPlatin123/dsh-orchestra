import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { PEEK_LIMITS, claudeEvent, clip, dshEvent, findSession, listSessions, readSession } from '../../src/sources/peek.ts';
import { realIo } from '../helpers/read-io.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// Synthetic roots only: the peek readers never meet a real session in a test (plan §6 invariant 18).

const U1 = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'peek-test-secret-value-0123456789';
const redactor = makeRedactor({ env: { ORCHESTRA_PEEK_TEST_TOKEN: SECRET } });
const redact = (text: string) => redactor.redact({ text }).text;

type Fx = { claude: string; dsh: string; gate: ReadGate; roots: HarnessRoot[] };

function fixture(t: TestContext): Fx {
  const base = fs.realpathSync.native(withTmp(t));
  const claude = path.join(base, 'roots', 'claude');
  const dsh = path.join(base, 'roots', 'dsh');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'sessions'), { recursive: true });
  const roots: HarnessRoot[] = [{ kind: 'claude', path: claude, real: claude }, { kind: 'dsh', path: dsh, real: dsh }];
  return { claude, dsh, roots, gate: new ReadGate({ roots, io: realIo, testDirs: [base] }) };
}

const jsonl = (...rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
const frame = (lines: unknown[]) => zlib.zstdCompressSync(Buffer.from(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

function touch(file: string, mtimeSec: number): void {
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

test('both harnesses are listed newest first by an opaque id; other files are not', (t) => {
  const fx = fixture(t);
  const c = put(path.join(fx.claude, 'projects', 'G--proj', `${U1}.jsonl`), jsonl({ type: 'user', message: { content: 'hi' } }) + '\n');
  const d = put(path.join(fx.dsh, 'sessions', '--G--proj--', U2, 'session.v4.jsonl.zstd'), frame([{ type: 'head', cwd: 'G:\\proj' }]));
  put(path.join(fx.dsh, 'sessions', '--G--proj--', U2, 'session.v4.jsonl.zstd.seed.bak'), 'x');
  put(path.join(fx.dsh, 'sessions', '--G--proj--', U1, 'session.jsonl.zstd'), 'x');
  put(path.join(fx.claude, 'projects', 'G--proj', 'notes.txt'), 'x');
  touch(c, 1_700_000_000);
  touch(d, 1_700_000_100);
  const list = listSessions(fx.gate, fx.roots, redact);
  assert.equal(list.total, 2);
  assert.deepEqual(list.sessions.map((s) => [s.harness, s.project]), [['dsh', '--G--proj--'], ['claude', 'G--proj']]);
  for (const s of list.sessions) assert.match(s.id, /^[0-9a-f]{20}$/);
  assert.equal(findSession(fx.gate, fx.roots, redact, list.sessions[1]!.id)?.file, c);
  assert.equal(findSession(fx.gate, fx.roots, redact, '0'.repeat(20)), null);
  assert.equal(findSession(fx.gate, fx.roots, redact, '..\\..\\x'), null);
  assert.equal(fx.gate.openHandles(), 0);
});

test('a Claude transcript shows its readable parts, cleaned and redacted; a half-written last line waits', (t) => {
  const fx = fixture(t);
  const file = put(path.join(fx.claude, 'projects', 'p', `${U1}.jsonl`), jsonl(
    { type: 'user', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: `run it \u001b[31m with ${SECRET}` } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:01.000Z', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a.txt' }] }] } },
    { type: 'summary', summary: 'the gist \u202e' },
    'not json',
    '[1,2]',
    { type: 'user', message: { content: 'half' } },
  ).slice(0, -3));
  const s = findSession(fx.gate, fx.roots, redact, listSessions(fx.gate, fx.roots, redact).sessions[0]!.id)!;
  assert.equal(s.file, file);
  const v = readSession(fx.gate, s, redact);
  assert.equal(v.note, null);
  assert.equal(v.unparsed, 2);
  assert.deepEqual(v.events.map((e) => e.type), ['user', 'assistant', 'user', 'summary']);
  assert.equal(v.events[0]!.at, '2026-11-01T10:00:00.000Z');
  assert.equal(v.events[0]!.text.includes(SECRET), false);
  assert.match(v.events[0]!.text, /\[redacted:/);
  assert.equal(v.events[0]!.text.includes('\u001b'), false);
  assert.equal(v.events[1]!.text, '[thinking]\nok\n[tool_use Bash] {"command":"ls"}');
  assert.equal(v.events[1]!.text.includes('private'), false);
  assert.equal(v.events[2]!.text, '[tool_result] a.txt');
  assert.equal(v.events[3]!.text, 'the gist ');
  assert.equal(fx.gate.openHandles(), 0);
});

test('a long Claude transcript is read from its end only, and the cut line is dropped', (t) => {
  const fx = fixture(t);
  const rows = Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', message: { content: `${i} ${'y'.repeat(1000)}` } }));
  put(path.join(fx.claude, 'projects', 'p', `${U1}.jsonl`), `${jsonl(...rows)}\n`);
  const s = listSessions(fx.gate, fx.roots, redact).sessions[0]!;
  const v = readSession(fx.gate, s, redact);
  assert.equal(v.note, 'tail-only');
  assert.equal(v.unparsed, 0);
  assert.equal(v.events.length, PEEK_LIMITS.events);
  assert.match(v.events[v.events.length - 1]!.text, /^399 /);
  assert.ok(v.events.every((e) => e.text.length <= PEEK_LIMITS.fieldChars + 1));
});

test('a DSH log is walked frame by frame; an unfinished last frame is left for later', (t) => {
  const fx = fixture(t);
  const done = Buffer.concat([
    frame([{ type: 'head', version: 4, cwd: 'G:\\proj' }]),
    frame([{ type: 'assistant/message', seq: 1, time: 1_793_560_000_000, data: { role: 'assistant', text: `hello ${SECRET}` } }, { type: 'tool/call', seq: 2, time: '2026-11-01T10:00:02Z', data: { name: 'read', args: { path: 'a', n: 3 } } }]),
  ]);
  const half = frame([{ type: 'later', seq: 3, time: 0, data: {} }]);
  put(path.join(fx.dsh, 'sessions', '--G--proj--', `session-${U2}`, 'session.v4.jsonl.zstd'), Buffer.concat([done, half.subarray(0, half.length - 3)]));
  const s = listSessions(fx.gate, fx.roots, redact).sessions[0]!;
  assert.equal(s.harness, 'dsh');
  const v = readSession(fx.gate, s, redact);
  assert.equal(v.note, 'unfinished-frame');
  assert.deepEqual(v.events.map((e) => e.type), ['head', '#1 assistant/message', '#2 tool/call']);
  assert.equal(v.events[1]!.at, new Date(1_793_560_000_000).toISOString());
  assert.equal(v.events[1]!.text.includes(SECRET), false);
  assert.match(v.events[1]!.text, /^role: assistant\ntext: hello \[redacted:/);
  assert.equal(v.events[2]!.text, 'name: read\nargs.path: a\nargs.n: 3');
  assert.equal(fx.gate.openHandles(), 0);
});

test('a DSH log that is no zstd stops at the bad frame', (t) => {
  const fx = fixture(t);
  put(path.join(fx.dsh, 'sessions', '--p--', U1, 'session.v4.jsonl.zstd'), 'plain text, not zstd at all');
  const v = readSession(fx.gate, listSessions(fx.gate, fx.roots, redact).sessions[0]!, redact);
  assert.deepEqual([v.note, v.events.length], ['bad-frame', 0]);
});

test('single lines: what is no JSON object is null; clip never splits a surrogate pair', () => {
  assert.equal(claudeEvent('nope', redact), null);
  assert.equal(dshEvent('"a string"', redact), null);
  assert.equal(claudeEvent('{"type":"x"}', redact)?.type, 'x');
  assert.equal(clip('ab\u{1F600}', 3), 'ab…');
  assert.equal(clip('abc', 3), 'abc');
});
