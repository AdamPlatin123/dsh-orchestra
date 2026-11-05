import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RowKey } from '../../shared/protocol.js';
import {
  ACTION_OUTCOMES, BRAKE_STATUSES, CAUSE_KINDS, CWD_TAIL_MAX, CWD_TAIL_RE, END_CLASSES, ERROR_CODES, ERROR_STATUS, GROUPS, HUMAN_VERBS, HUMAN_VERB_ROUTES,
  ID_RE, ITEM_VERBS, NOOP_REASONS, PROTOCOL_V, RESERVED_ERROR_CODES, SEVERITIES, TOOL_NAME_RE, UUID_RE, VERSION_RE, compareRows, cwdTailArg, isActionOutcome,
  toolNameArg, versionArg,
} from '../../shared/protocol.js';
import { ACK_WINDOW_MS, PLAN_TTL_MS, REMINDER_TEXT_MAX, SNIPPET_MAX_BYTES, SNIPPET_TTL_MS, STALE_MS, TICK_MS } from '../../shared/constants.js';
import { ARG_UNKNOWN, END_TEXT, ERROR_TEXT, OUTCOME_TEXT, missingTexts } from '../../shared/strings.js';
import { decideBuiltin } from '../../src/runtime/builtin-policy.ts';
import { decideImport } from '../../src/runtime/import-fence.ts';
import { findImports } from '../helpers/scan-rules.ts';

// shared/protocol.js is the one source of the enums and grammars the daemon and the page share (plan
// step 3; UI design 一). These tests freeze what step 3 freezes: the verbs, the error-code table, the
// end classes, ActionOutcome, the id grammar and the title-arg grammars, and the row order.

const REPO = new URL('../../', import.meta.url);

test('the enums are the frozen sets of UI design 一, each unique and frozen', () => {
  assert.equal(PROTOCOL_V, 1);
  assert.deepEqual([...HUMAN_VERBS], [
    'seen', 'snooze', 'acted', 'remind', 'brake', 'roots-add', 'roots-confirm', 'protect-add', 'protect-remove', 'dsh-connect', 'self-rating',
    // alpha 0.2's owned sessions (slice design §2.7): new, message, interrupt, end, retry, allow, deny, and the two imports
    'owned-new', 'owned-message', 'owned-interrupt', 'owned-end', 'owned-brake', 'owned-retry', 'approval-allow', 'approval-deny', 'import-claude', 'import-dsh',
    // seat: you reject an agent request (its dispatch is owned-new with the requestId); and a session's dispatch permission
    'request-reject', 'dispatch-grant',
  ]);
  assert.deepEqual(Object.keys(HUMAN_VERB_ROUTES), [...HUMAN_VERBS], 'every human verb has its route, in the same order');
  assert.ok(Object.values(HUMAN_VERB_ROUTES).every((r) => /^\/api\/[a-z/:-]+$/.test(r)));
  assert.equal(new Set(Object.values(HUMAN_VERB_ROUTES)).size, HUMAN_VERBS.length, 'one route per verb');
  for (const v of ITEM_VERBS) assert.ok((HUMAN_VERBS as readonly string[]).includes(v) || v === 'open' || v === 'peek', v);
  assert.deepEqual([...END_CLASSES], ['acted', 'auto-cleared', 'expired']);
  assert.deepEqual([...CAUSE_KINDS], ['source', 'human', 'clock']);
  assert.deepEqual([...NOOP_REASONS], ['already-ended']);
  assert.deepEqual([...ACTION_OUTCOMES], ['applied', 'noop:already-ended', 'unknown']);
  assert.deepEqual([...BRAKE_STATUSES], ['ok', 'partial', 'refused', 'unknown']);
  for (const list of [HUMAN_VERBS, ITEM_VERBS, END_CLASSES, CAUSE_KINDS, NOOP_REASONS, ACTION_OUTCOMES, BRAKE_STATUSES, ERROR_CODES, GROUPS, SEVERITIES]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
  }
  assert.ok(Object.isFrozen(ERROR_STATUS) && Object.isFrozen(HUMAN_VERB_ROUTES));
  assert.throws(() => { (HUMAN_VERBS as unknown as string[]).push('reopen'); }, TypeError);
});

test('the error codes are UI design 一 5\'s table, with ui-only, procguard-timeout and not-test-root, each with its status', () => {
  assert.deepEqual({ ...ERROR_STATUS }, {
    'in-flight': 409,
    'actionId-reused': 422,
    'actionId-missing': 400,
    'verb-not-allowed': 422,
    'ui-only': 503,
    'item-unknown': 404,
    'text-too-long': 422,
    'brake-unavailable': 503,
    'not-test-root': 422,
    'procguard-timeout': 503,
    'plan-expired': 409,
    // alpha 0.2 (slice design §2.7): the controller token, owned sessions, approvals, imports
    'not-unlocked': 403,
    'owned-disabled': 409,
    'owned-limit': 409,
    'desk-open': 409,
    'slash-command': 422,
    'digest-mismatch': 409,
    'approval-gone': 409,
    'stale-view': 409,
    'still-running': 409,
    'source-live': 409,
    'cwd-gone': 409,
    'cwd-forbidden': 409,
    'unfinished-frame': 409,
    'source-changed': 409,
    'newer-format': 409,
    'reparse-point': 409,
    'import-too-big': 413,
    'gateway-real-data': 409,
    'rename-busy': 503,
    'host-tampered': 503,
    // step 5: an owned-session body over 64 KiB
    'body-too-big': 413,
    // the orchestra app's owned-session handlers
    'owned-ended': 409,
    'queue-full': 409,
    'spawn-failed': 503,
    // seat: the agent request a dispatch or a refusal names no longer waits, or is not what the card showed
    'request-gone': 409,
    'request-mismatch': 409,
  });
  assert.deepEqual([...ERROR_CODES], Object.keys(ERROR_STATUS));
  assert.deepEqual([...RESERVED_ERROR_CODES], ['ui-only']);
});

test('ActionOutcome is applied, noop:<reason> or unknown and nothing else', () => {
  for (const o of ['applied', 'noop:already-ended', 'unknown']) assert.ok(isActionOutcome(o), o);
  for (const o of ['noop', 'noop:', 'noop:whatever', 'Applied', 'refused', '', null, 1, ['applied']]) assert.equal(isActionOutcome(o), false, String(o));
});

test('ID_RE: ASCII id of 1 to 64 that composes into a timerId and a snapshot id; UUID_RE: what crypto.randomUUID() makes', () => {
  for (const ok of ['a', 'it-41', 'r_7', 'A0', 'x'.repeat(64), '0b9c3d7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e']) assert.ok(ID_RE.test(ok), ok);
  for (const bad of ['', '-a', '_a', 'x'.repeat(65), 'a:b', 'a.b', 'a b', 'a/b', 'é', 'a\n', 'a\u202e']) assert.equal(ID_RE.test(bad), false, JSON.stringify(bad));
  for (let i = 0; i < 200; i++) assert.ok(UUID_RE.test(crypto.randomUUID()));
  for (const bad of ['0B9C3D7E-1F2A-4B3C-8D4E-5F6A7B8C9D0E', '0b9c3d7e-1f2a-1b3c-8d4e-5f6a7b8c9d0e', '0b9c3d7e-1f2a-4b3c-cd4e-5f6a7b8c9d0e', '0b9c3d7e1f2a4b3c8d4e5f6a7b8c9d0e', ` ${crypto.randomUUID()}`]) {
    assert.equal(UUID_RE.test(bad), false, bad);
  }
});

test('title args: tool names and versions match their grammars or are not shown', () => {
  for (const ok of ['Bash', 'mcp__dsh:run', 'rg.exe', 'a-b_c', 'x'.repeat(64)]) assert.equal(toolNameArg(ok), ok);
  for (const bad of ['', 'x'.repeat(65), 'rm -rf', 'Bash\u202e', 'a/b', 'name\n', '工具', 7, null]) assert.equal(toolNameArg(bad), null, JSON.stringify(bad));
  for (const ok of ['2.1.17', '0.2.4', '24.22.0', '1.2.3.4', '1.0.0-beta.1', '1.0.0+build.7', '99999.1']) assert.equal(versionArg(ok), ok);
  for (const bad of ['1', 'v1.2.3', '1.2.3.4.5', '123456.1', '1.2-', `1.2-${'a'.repeat(33)}`, '1.2.3 ', '1.2.3\u200b', '١.٢', null]) assert.equal(versionArg(bad), null, JSON.stringify(bad));
  assert.equal(TOOL_NAME_RE.flags, '');
  assert.equal(VERSION_RE.flags, '');
});

test('cwd tail: the last segment, at most 32 code points, with no control, format (zero-width and bidi), surrogate or separator character', () => {
  assert.equal(cwdTailArg('C:\\Users\\alexander\\proj'), 'proj');
  assert.equal(cwdTailArg('C:\\Users\\alexander\\shop-web\\\\'), 'shop-web');
  assert.equal(cwdTailArg('/home/a/项目'), '项目');
  assert.equal(cwdTailArg('C:\\'), 'C:');
  assert.equal(cwdTailArg('\\\\'), null);
  assert.equal(cwdTailArg(''), null);
  assert.equal(cwdTailArg(42), null);
  const astral = '😀'.repeat(CWD_TAIL_MAX);
  assert.equal(astral.length, 64, 'counted in code points, not UTF-16 units');
  assert.equal(cwdTailArg(`C:\\x\\${astral}`), astral);
  assert.equal(cwdTailArg(`C:\\x\\${astral}a`), null);
  assert.equal(cwdTailArg(`C:\\x\\${'a'.repeat(33)}`), null);
  // Each zero-width and bidi control the design lists, plus other Cf, Cc, separators and a lone surrogate.
  const bad = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0xfeff, 0x00ad, 0x2060, 0xe0041, 0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9b, 0x2028, 0x2029];
  for (const cp of bad) assert.equal(cwdTailArg(`C:\\x\\shop${String.fromCodePoint(cp)}web`), null, cp.toString(16));
  assert.equal(cwdTailArg('C:\\x\\shop\ud800web'), null, 'a lone surrogate');
  assert.equal(CWD_TAIL_RE.test('canary-7Q\u202e'), false, 'the step 4 canary with U+202E after it');
  assert.equal(CWD_TAIL_RE.test('a/b'), false);
  assert.equal(CWD_TAIL_RE.test('a\\b'), false);
});

const row = (group: string, sev: string, committedJseq: number, id: string): RowKey => ({ group, sev, committedJseq, id });

/** Park–Miller shuffle, seeded. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test('compareRows: group, then severity, then committedJseq (older first), then id by code units; a total order, whatever the input order', () => {
  const rows = [
    row('reminders', 'P1', 3, 'r-1'),
    row('fermatas', 'P1', 9, 'it-2'),
    row('fermatas', 'P0', 12, 'it-3'),
    row('fermatas', 'P1', 9, 'it-10'),
    row('wrong-notes', 'P0', 1, 'it-1'),
    row('fermatas', 'P1', 4, 'it-9'),
    row('ready-for-review', 'P3', 2, 'it-5'),
    row('fermatas', 'P1', 9, 'It-2'),
    row('mystery', 'P0', 0, 'x'),
    row('fermatas', 'P9', 0, 'y'),
    row('fermatas', 'P1', Number.NaN, 'z'),
  ];
  const expected = ['it-3', 'it-9', 'It-2', 'it-10', 'it-2', 'z', 'y', 'it-1', 'it-5', 'r-1', 'x'];
  assert.deepEqual([...rows].sort(compareRows).map((r) => r.id), expected);
  for (let seed = 1; seed <= 50; seed++) assert.deepEqual(shuffled(rows, seed * 31).sort(compareRows).map((r) => r.id), expected, `seed ${seed}`);
  assert.equal(compareRows(rows[0]!, rows[0]!), 0);
  assert.deepEqual([...GROUPS], ['fermatas', 'wrong-notes', 'ready-for-review', 'reminders']);
  assert.deepEqual([...SEVERITIES], ['P0', 'P1', 'P2', 'P3']);
});

test('strings: every error code, end class and outcome has a text, and no two in a table share one (P1)', () => {
  assert.deepEqual(missingTexts(ERROR_CODES, END_CLASSES, ACTION_OUTCOMES), []);
  for (const table of [ERROR_TEXT, END_TEXT, OUTCOME_TEXT]) {
    const texts = Object.values(table);
    assert.equal(new Set(texts).size, texts.length);
    assert.ok(texts.every((t) => t.length > 0 && !/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(t)));
  }
  assert.deepEqual(Object.keys(ERROR_TEXT), [...ERROR_CODES]);
  // R3-7: every table keyed by its enum exactly, so missingTexts() is not the only check of the outcome and end tables.
  assert.deepEqual(Object.keys(OUTCOME_TEXT), [...ACTION_OUTCOMES]);
  assert.deepEqual(Object.keys(END_TEXT), [...END_CLASSES]);
  assert.deepEqual(missingTexts(ERROR_CODES, END_CLASSES, ACTION_OUTCOMES), []);
  assert.equal(ARG_UNKNOWN, '未知');
  // One code, two limits (a reminder's REMINDER_TEXT_MAX characters, an owned-session message's 2048 bytes): the text names neither.
  assert.doesNotMatch(ERROR_TEXT['text-too-long'], /\d|提醒/);
});

test('constants: the numbers step 3 shares, as the plan states them', () => {
  assert.equal(REMINDER_TEXT_MAX, 120);
  assert.equal(SNIPPET_MAX_BYTES, 2048);
  assert.equal(SNIPPET_TTL_MS, 14 * 86_400_000);
  assert.equal(PLAN_TTL_MS, 60_000);
  assert.equal(ACK_WINDOW_MS, 1500);
  assert.equal(TICK_MS, 5000);
  assert.equal(STALE_MS, 4 * TICK_MS);
});

test('shared/ imports nothing but shared/ and no builtin, for the static scan and the import fence alike; src/ may import shared/', () => {
  const dir = fileURLToPath(new URL('shared/', REPO));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  // frozen.js: the one deep freeze of every exported table (finding N3). stage-contract.js: the stage
  // preview's contract, which the daemon's golden file and the page's sample both pass (alpha design §3).
  // tower-contract.js: the tower's contract (orchestra app plan §1), which GET /api/tower answers.
  // owned-contract.js: the owned sessions' contract (GET /api/owned and its feed), the server's self-check.
  assert.deepEqual(files.sort(), ['constants.js', 'frozen.js', 'owned-contract.js', 'protocol.js', 'stage-contract.js', 'strings.js', 'tower-contract.js']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(text.startsWith('// @ts-check\n'), `${f} is checked JS`);
    for (const r of findImports(text)) assert.match(r.spec, /^\.\/[a-z-]+\.js$/, `${f}: ${r.spec}`);
  }
  for (const b of ['node:path', 'node:crypto', 'node:fs', 'path']) {
    const d = decideBuiltin('shared/protocol.js', b);
    assert.ok(!d.allow && d.reason === 'no-builtins-here', `${b}: ${JSON.stringify(d)}`);
    const i = decideImport(new URL('shared/protocol.js', REPO).href, b.startsWith('node:') ? b : `node:${b}`, undefined, REPO);
    assert.ok(!i.allow && i.reason === 'no-builtins-here', JSON.stringify(i));
  }
  assert.ok(decideBuiltin('src/model/inbox.ts', 'node:path').allow, 'src keeps its defaults');
  const fromSrc = decideImport(new URL('src/model/inbox.ts', REPO).href, new URL('shared/protocol.js', REPO).href, undefined, REPO);
  assert.ok(fromSrc.allow, JSON.stringify(fromSrc));
  const fromShared = decideImport(new URL('shared/strings.js', REPO).href, new URL('shared/protocol.js', REPO).href, undefined, REPO);
  assert.ok(fromShared.allow, JSON.stringify(fromShared));
});
