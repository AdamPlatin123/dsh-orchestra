import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { PEEK_LIMITS, claudeEvent, clip, dshEvent, fairShare, findSession, listSessions, readSession } from '../../src/sources/peek.ts';
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

test('only the shown records are redacted: a log of thousands costs as much as its last PEEK_LIMITS.events', (t) => {
  // Redacting every record of a 16 MB Codex rollout held the daemon past the page's 4 s, and the
  // page said "读取失败：network". Every line still counts toward unparsed; only the kept ones are redacted.
  const fx = fixture(t);
  const n = PEEK_LIMITS.events * 10;
  const rows: unknown[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ type: 'tool/call', seq: i, time: 1_793_560_000_000 + i, data: { text: `${i} ${SECRET}` } });
    if (i % 100 === 0) rows.push('not json');
  }
  put(path.join(fx.dsh, 'sessions', '--p--', U1, 'session.v4.jsonl.zstd'), frame(rows));
  let calls = 0;
  const counting = (text: string) => {
    calls++;
    return redact(text);
  };
  const v = readSession(fx.gate, listSessions(fx.gate, fx.roots, redact).sessions[0]!, counting);
  assert.equal(v.note, null);
  assert.equal(v.unparsed, n / 100);
  assert.equal(v.events.length, PEEK_LIMITS.events);
  assert.equal(v.events[0]!.type, `#${n - PEEK_LIMITS.events} tool/call`);
  assert.equal(v.events.at(-1)!.type, `#${n - 1} tool/call`);
  assert.ok(v.events.every((e) => !e.text.includes(SECRET)));
  // dshEvent redacts twice per record (its type and its text).
  assert.equal(calls, 2 * PEEK_LIMITS.events);
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

test('fairShare: every group gets its floor before the newest take the rest; pinned first; order kept', () => {
  // Newest first: ten of a, then three of b, then two of c, all older than every a.
  const xs = [...Array.from({ length: 10 }, (_, i) => `a${i}`), 'b0', 'b1', 'b2', 'c0', 'c1'];
  const group = (x: string) => x[0]!;
  // n 6 over three groups: a floor of 2 each.
  assert.deepEqual(fairShare(xs, 6, group), ['a0', 'a1', 'b0', 'b1', 'c0', 'c1']);
  // n 9: floors of 3; c holds only two, so the one left goes to the newest, a.
  assert.deepEqual(fairShare(xs, 9, group), ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'c0', 'c1']);
  // A pinned item counts in its group's floor, whatever its age.
  assert.deepEqual(fairShare(xs, 6, group, (x) => x === 'a9'), ['a0', 'a9', 'b0', 'b1', 'c0', 'c1']);
  // One group: the newest n, as before.
  assert.deepEqual(fairShare(xs.slice(0, 10), 3, group), ['a0', 'a1', 'a2']);
  assert.deepEqual(fairShare(xs, 0, group), []);
  assert.deepEqual(fairShare(xs, 100, group), xs);
});

test('the listing shares its places between the harnesses and counts every session before the cut (T1)', (t) => {
  const base = fs.realpathSync.native(withTmp(t));
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(base, 'roots', kind);
    fs.mkdirSync(p, { recursive: true });
    return { kind, path: p, real: p };
  });
  const gate = new ReadGate({ roots, io: realIo, testDirs: [base] });
  const uuid = (n: number, i: number) => `${String(n).repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const T = 1_700_000_000;
  // Claude is busy: 80 transcripts, every one newer than any DSH or Codex session.
  for (let i = 0; i < 80; i++) touch(put(path.join(roots[0]!.path, 'projects', 'G--fx', `${uuid(1, i)}.jsonl`), '{}\n'), T + 10_000 - i);
  for (let i = 0; i < 30; i++) touch(put(path.join(roots[1]!.path, 'sessions', '--G-fx--', uuid(2, i), 'session.v4.jsonl.zstd'), frame([{ type: 'head' }])), T + 5_000 - i);
  for (let i = 0; i < 25; i++) touch(put(path.join(roots[2]!.path, 'sessions', '2026', '10', '01', `rollout-2026-10-01T00-00-00-${uuid(3, i)}.jsonl`), '{}\n'), T - i);
  const list = listSessions(gate, roots, redact);
  const by = (h: string) => list.sessions.filter((s) => s.harness === h).length;
  assert.equal(list.sessions.length, PEEK_LIMITS.sessions);
  // 60 places over three harnesses: a floor of 20 each, so neither older source is pushed out.
  assert.deepEqual([by('claude'), by('dsh'), by('codex')], [20, 20, 20]);
  assert.deepEqual(list.totals, { claude: 80, dsh: 30, codex: 25 });
  assert.equal(list.total, 135);
  // Still newest first, and each harness keeps its newest.
  assert.ok(list.sessions.every((s, i) => i === 0 || list.sessions[i - 1]!.mtimeMs >= s.mtimeMs));
  assert.equal(Math.max(...list.sessions.filter((s) => s.harness === 'dsh').map((s) => s.mtimeMs)), (T + 5_000) * 1000);
  assert.equal(gate.openHandles(), 0);
});
