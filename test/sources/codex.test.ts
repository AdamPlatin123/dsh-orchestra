import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import type { ReadIo } from '../../src/fs/read-gate.ts';
import type { PeekSession } from '../../src/sources/peek.ts';
import type { Player, StageSnapshot } from '../../src/sources/stage.ts';
import { ReadGate, ReadGateError } from '../../src/fs/read-gate.ts';
import { decodePrefix } from '../../src/lib/zstd/frames.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { PEEK_LIMITS, claudeEvent, codexEvent, eachRecord, findSession, listSessions, readSession } from '../../src/sources/peek.ts';
import { towerFromStage } from '../../src/sources/tower.ts';
import { STAGE_LIMITS, codexDigester, digestCodex, makeStageBuilder } from '../../src/sources/stage.ts';
import { validateSession, validateStage } from '../../shared/stage-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { FX, STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { junction, put, withTmp } from '../helpers/tmp.ts';

// Codex as an observed source (orchestra app plan §1), over synthetic rollouts only: every id, path
// and text here is made up. The .zst files are compressed here, with node:zlib, as Codex does.

const U1 = '01a00000-0000-7000-8000-000000000001';
const U2 = '01a00000-0000-7000-8000-000000000002';
const U3 = '01a00000-0000-7000-8000-000000000003';
const SECRET = 'codex-test-secret-value-0123456789';
const redactor = makeRedactor({ env: { ORCHESTRA_CODEX_TEST_TOKEN: SECRET } });
const redact = (text: string) => redactor.redact({ text }).text;
const BASE = 1_793_560_000_000;

type Fx = { base: string; codex: string; roots: HarnessRoot[]; gate: ReadGate };

function fixture(t: TestContext, wrap: (io: ReadIo) => ReadIo = (io) => io): Fx {
  const base = fs.realpathSync.native(withTmp(t));
  const codex = path.join(base, 'roots', 'codex');
  fs.mkdirSync(codex, { recursive: true });
  const roots: HarnessRoot[] = [{ kind: 'codex', path: codex, real: codex }];
  return { base, codex, roots, gate: new ReadGate({ roots, io: wrap(realIo), testDirs: [base] }) };
}

const iso = (s: number) => new Date(BASE + s * 1000).toISOString();
const rec = (type: string, payload: Record<string, unknown>, s = 0) => ({ timestamp: iso(s), type, payload });
const meta = (id: string, extra: Record<string, unknown> = {}) =>
  rec('session_meta', { id, session_id: id, timestamp: iso(0), cwd: 'G:\\fx\\cart', originator: 'codex_exec', base_instructions: { text: 'long instructions' }, ...extra });
const ev = (type: string, extra: Record<string, unknown> = {}, s = 0) => rec('event_msg', { type, ...extra }, s);
const item = (type: string, extra: Record<string, unknown> = {}, s = 0) => rec('response_item', { type, ...extra }, s);
const call = (id: string, name: string, args: unknown, s = 0) => item('function_call', { name, arguments: typeof args === 'string' ? args : JSON.stringify(args), call_id: id }, s);
const out = (id: string, output: string, s = 0) => item('function_call_output', { call_id: id, output }, s);
const lines = (...rows: unknown[]) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const zst = (text: string) => zlib.zstdCompressSync(Buffer.from(text));
const day = (fx: Fx, d = '01') => path.join(fx.codex, 'sessions', '2026', '11', d);
const rollout = (id: string, ext: '.jsonl' | '.jsonl.zst' = '.jsonl') => `rollout-2026-11-01T10-00-00-${id}${ext}`;

function touch(file: string, sec: number): string {
  fs.utimesSync(file, sec, sec);
  return file;
}

const only = (fx: Fx): PeekSession => {
  const l = listSessions(fx.gate, fx.roots, redact);
  assert.equal(l.sessions.length, 1);
  return l.sessions[0]!;
};

const records = (fx: Fx, s: PeekSession, decoded?: number) => {
  const got: Record<string, unknown>[] = [];
  const r = eachRecord(fx.gate, s, (o) => got.push(o), decoded);
  return { got, ...r };
};

test('Codex rollouts are listed from sessions/YYYY/MM/DD and archived_sessions, one per thread, newest file first', (t) => {
  const fx = fixture(t);
  const a = touch(put(path.join(day(fx), rollout(U1)), lines(meta(U1))), 1_700_000_100);
  // The same thread compressed later (its archived .zst is newer): listed once, as the newer file.
  touch(put(path.join(day(fx), rollout(U2)), lines(meta(U2))), 1_700_000_000);
  const b = touch(put(path.join(fx.codex, 'archived_sessions', rollout(U2, '.jsonl.zst')), zst(lines(meta(U2)))), 1_700_000_200);
  // Not rollouts, or not where Codex writes them: never listed.
  put(path.join(day(fx), 'notes.jsonl'), lines(meta(U3)));
  put(path.join(fx.codex, 'sessions', 'misc', '11', '01', rollout(U3)), lines(meta(U3)));
  put(path.join(fx.codex, 'sessions', rollout(U3)), lines(meta(U3)));
  put(path.join(fx.codex, 'archived_sessions', 'deeper', rollout(U3)), lines(meta(U3)));
  const l = listSessions(fx.gate, fx.roots, redact);
  assert.deepEqual(l.sessions.map((s) => [s.harness, s.project, s.file]), [['codex', 'codex', b], ['codex', 'codex', a]]);
  assert.equal(l.total, 2);
  assert.equal(findSession(fx.gate, fx.roots, redact, l.sessions[1]!.id)?.file, a);
  assert.equal(fx.gate.openHandles(), 0);
});

test('the read gate: a rollout behind a junction out of the root is not listed, and a path outside the roots is refused', (t) => {
  const fx = fixture(t);
  const outside = path.join(fx.base, 'elsewhere', '01');
  put(path.join(outside, rollout(U1)), lines(meta(U1)));
  junction(fx.base, path.join(fx.codex, 'sessions', '2026', '11', '01'), outside);
  assert.deepEqual(listSessions(fx.gate, fx.roots, redact).sessions, []);
  // Every file name the gate denies stays unread, whatever directory it is in.
  put(path.join(fx.codex, 'archived_sessions', 'auth.json'), '{}');
  assert.equal(fx.gate.decide(path.join(fx.codex, 'archived_sessions', 'auth.json'), 'read').allow, false);
  assert.equal(fx.gate.decide(path.join(fx.codex, 'archived_sessions', rollout(U2, '.jsonl.zst')), 'stat').allow, false, 'missing, so refused');
  const forged: PeekSession = { id: '0'.repeat(20), harness: 'codex', project: 'codex', file: path.join(outside, rollout(U1)), size: 10, mtimeMs: 0 };
  assert.throws(() => eachRecord(fx.gate, forged, () => {}), ReadGateError);
  assert.equal(fx.gate.openHandles(), 0);
});

test('a plain rollout shows its readable parts, redacted; its base instructions never; bad lines are counted, never shown', (t) => {
  const fx = fixture(t);
  put(path.join(day(fx), rollout(U1)), lines(
    meta(U1),
    item('message', { role: 'user', content: [{ type: 'input_text', text: `fix the cart ${SECRET}` }] }, 1),
    item('reasoning', { summary: [] }, 2),
    call('c1', 'exec_command', { cmd: 'rg cart' }, 3),
    out('c1', 'src/cart.ts', 3),
    '{not json',
    '[1,2]',
    ev('task_complete', { turn_id: 't', last_agent_message: 'done' }, 4),
  ));
  const v = readSession(fx.gate, only(fx), redact);
  assert.deepEqual(v.events.map((e) => e.type), ['session_meta', 'response_item:message', 'response_item:reasoning', 'response_item:function_call', 'response_item:function_call_output', 'event_msg:task_complete']);
  assert.deepEqual([v.unparsed, v.note], [2, null]);
  assert.equal(v.events[0]!.text, 'id: 01a00000-0000-7000-8000-000000000001\nsource: ');
  assert.equal(JSON.stringify(v).includes('long instructions'), false);
  assert.equal(JSON.stringify(v).includes('fx\\\\cart'), false, 'no cwd');
  assert.equal(JSON.stringify(v).includes(SECRET), false);
  assert.match(v.events[1]!.text, /^user: fix the cart \[redacted/);
  assert.equal(v.events[3]!.text, '[function_call exec_command] {"cmd":"rg cart"}');
  assert.equal(v.events[4]!.text, '[output] src/cart.ts');
  assert.equal(codexEvent('null', redact), null);
  assert.deepEqual(validateSession({ session: { id: v.session.id, harness: 'codex', label: 'cart', size: v.session.size, mtimeMs: 1 }, events: v.events, unparsed: v.unparsed, note: v.note, brief: null }).errors, []);
});

test('a plain rollout past its tail limit: its first line (session_meta), then its tail without the cut line', (t) => {
  const fx = fixture(t);
  const filler = Array.from({ length: 400 }, (_, i) => item('message', { role: 'assistant', content: [{ type: 'output_text', text: `${i} ${'z'.repeat(1000)}` }] }, 5));
  put(path.join(day(fx), rollout(U1)), lines(meta(U1), call('early', 'update_plan', { plan: [{ step: 'early', status: 'pending' }] }, 1), ...filler, ev('task_started', { turn_id: 't2' }, 9)));
  const s = only(fx);
  assert.ok(s.size > PEEK_LIMITS.codexTailBytes);
  const r = records(fx, s);
  assert.equal(r.note, 'tail-only');
  assert.equal(r.got[0]!.type, 'session_meta');
  assert.equal(r.got.some((o) => JSON.stringify(o).includes('"early"')), false, 'the plan before the tail is not read');
  assert.ok(r.got.length < 300 && r.got.length > 200);
  assert.equal(r.unparsed, 0, 'the line the tail cut is dropped, not counted bad');
  const dg = codexDigester({ redact });
  for (const o of r.got) dg.add(o);
  const d = dg.finish(r.note);
  assert.deepEqual([d.lane?.name, d.startedAt, d.codex?.turn, d.todo, d.note], ['cart', BASE, 'open', null, 'tail-only']);
});

test('a .zst rollout is decoded whole; past its decoded ceiling only its first line comes, noted too-large', (t) => {
  const fx = fixture(t);
  const body = lines(meta(U1, { source: 'vscode' }), '{bad', ...Array.from({ length: 50 }, (_, i) => call(`c${i}`, 'shell_command', { command: `echo ${i}` }, 2)));
  put(path.join(fx.codex, 'archived_sessions', rollout(U1, '.jsonl.zst')), zst(body));
  const s = only(fx);
  const whole = records(fx, s);
  assert.deepEqual([whole.got.length, whole.unparsed, whole.note], [51, 1, null]);
  const capped = records(fx, s, 4096);
  assert.equal(capped.note, 'too-large');
  assert.deepEqual(capped.got.map((o) => o.type), ['session_meta']);
  assert.equal(digestCodex(capped.got, { redact, note: capped.note }).lane?.name, 'cart');
  // Past codexMaxBytes on disk the file is not decoded whole: only its head is.
  const huge = records(fx, { ...s, size: PEEK_LIMITS.codexMaxBytes + 1 });
  assert.deepEqual([huge.got.map((o) => o.type), huge.note], [['session_meta'], 'too-large']);
  assert.equal(fx.gate.openHandles(), 0);
});

test('a .zst that is no zstd is a bad frame; a prefix decodes what its bytes hold and no more than its ceiling', (t) => {
  const fx = fixture(t);
  put(path.join(fx.codex, 'archived_sessions', rollout(U1, '.jsonl.zst')), 'plain text, not zstd');
  const r = records(fx, only(fx));
  assert.deepEqual([r.got, r.note], [[], 'bad-frame']);
  const text = lines(...Array.from({ length: 2000 }, (_, i) => meta(`id-${i}`)));
  const b = zst(text);
  const half = decodePrefix(b.subarray(0, Math.floor(b.length / 2)), 64 * 1024 * 1024).toString('utf8');
  assert.ok(half.length > 0 && text.startsWith(half));
  assert.throws(() => decodePrefix(b, 1024), (e: unknown) => e instanceof RangeError && (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE');
});

test('the digest: a question waits on you, an escalated command may wait under a policy that asks, a closed turn waits on no one', () => {
  const ctx = (policy: string) => rec('turn_context', { turn_id: 't', model: 'codex/fx-model', approval_policy: policy });
  const d1 = digestCodex([meta(U1), ctx('never'), ev('task_started', { turn_id: 't' }), call('q', 'request_user_input', { questions: [{ id: 'a', question: 'which?' }] })], { redact });
  assert.deepEqual([d1.codex?.turn, d1.codex?.waiting, d1.model, d1.calls], ['open', 'request_user_input', 'codex/fx-model', ['other']]);
  const escalate = call('x', 'shell_command', { command: 'git push', sandbox_permissions: 'require_escalated' });
  assert.equal(digestCodex([ctx('on-request'), ev('task_started'), escalate], { redact }).codex?.waiting, 'approval');
  assert.equal(digestCodex([ctx('never'), ev('task_started'), escalate], { redact }).codex?.waiting, null, 'never asks');
  assert.equal(digestCodex([ctx('on-request'), ev('task_started'), call('y', 'shell_command', { command: 'ls' })], { redact }).codex?.waiting, null, 'sandboxed');
  assert.equal(digestCodex([ctx('on-request'), ev('task_started'), escalate, out('x', 'ok')], { redact }).codex?.waiting, null, 'answered');
  assert.equal(digestCodex([ctx('on-request'), ev('task_started'), escalate, ev('turn_aborted', { reason: 'interrupted' })], { redact }).codex?.waiting, null, 'turn over');
  assert.equal(digestCodex([ctx('on-request'), ev('task_started'), call('z', 'shell_command', '{not json')], { redact }).codex?.waiting, null, 'bad arguments read as none');
  // The thread settings name the model when no turn context has yet.
  assert.equal(digestCodex([ev('thread_settings_applied', { thread_settings: { model: 'codex/other' } })], { redact }).model, 'codex/other');
});

test('the digest: session_meta names the parent thread either way it is spelled; a plan without its keys is a mismatch', () => {
  const P = '01a00000-0000-7000-8000-00000000aaaa';
  const snake = digestCodex([meta(U1, { source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: '/root/tests', agent_nickname: 'Ada', agent_role: 'worker' } } } })], { redact });
  const camel = digestCodex([meta(U1, { source: { subAgent: { thread_spawn: { parent_thread_id: P, depth: 1 } } } })], { redact });
  const flat = digestCodex([meta(U1, { parent_thread_id: P })], { redact });
  assert.ok(snake.codex!.parentKey !== null);
  assert.deepEqual([camel.codex!.parentKey, flat.codex!.parentKey], [snake.codex!.parentKey, snake.codex!.parentKey]);
  assert.deepEqual([snake.codex!.sub, snake.codex!.nickname, snake.codex!.role, snake.codex!.agentPath, flat.codex!.sub], [true, 'Ada', 'worker', '/root/tests', false]);
  assert.equal(snake.keys['codex.child']!.missing, 0);
  // A later session_meta (a fork carries its source's) does not rename this thread.
  const forked = digestCodex([meta(U1), meta(U2)], { redact });
  assert.equal(forked.codex!.idKey, digestCodex([meta(U1)], { redact }).codex!.idKey);
  const plan = digestCodex([call('p', 'update_plan', { plan: [{ text: 'renamed key', state: 'pending' }] })], { redact });
  assert.deepEqual([plan.todo?.keys, plan.keys['codex.plan']], ['mismatch', { seen: 1, missing: 1 }]);
  const noMeta = digestCodex([rec('session_meta', { cwd: 'G:\\x' })], { redact });
  assert.equal(noMeta.keys['codex.meta']!.missing, 1);
});

// ---- The stage over the shared fixture (test/helpers/stage-fixture.ts) and variations of it

function stage(t: TestContext, write: (dir: string) => void = (dir) => void writeStageFixture(dir, BASE), wrap: (io: ReadIo) => ReadIo = (io) => io) {
  const dir = fs.realpathSync.native(withTmp(t));
  write(dir);
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    fs.mkdirSync(p, { recursive: true });
    return { kind, path: p, real: p };
  });
  const gate = new ReadGate({ roots, io: wrap(realIo), testDirs: [dir] });
  const builder = makeStageBuilder({ gate, roots, redact, clock: new VirtualClock({ mono: 1000, wall: BASE + 30_000 }).port(null), profile: 'test' });
  const snap = builder.snapshot();
  assert.deepEqual(validateStage(snap).errors, []);
  return { dir, gate, builder, snap };
}

const codexPlayers = (s: StageSnapshot) => s.lanes.flatMap((l) => l.players).filter((p) => p.harness === 'codex');
const named = (s: StageSnapshot, label: string): Player => {
  const p = codexPlayers(s).find((x) => x.label === label);
  assert.ok(p !== undefined, `no codex player ${label}`);
  return p;
};

test('stage: the Codex lead, its subagents hung under it, and their work items joined by agent id and agent path', (t) => {
  const { snap } = stage(t);
  assert.deepEqual(snap.sources.codex, { state: 'ok', sessions: 3, shown: 3, registry: null, error: null });
  const lead = codexPlayers(snap).find((p) => p.role === 'principal')!;
  const ada = named(snap, 'Ada');
  const docs = named(snap, 'docs');
  assert.deepEqual([lead.label, lead.model, lead.startedAt, lead.instrument.class], ['shop', 'codex/gpt-fx', BASE, 'percussion']);
  // The rollout records no approval request: the wait is inferred, and so it is no fermata.
  assert.deepEqual(lead.live, { state: 'waiting', basis: 'unpaired-tool-use', waitingFor: 'approval', ageMs: 2000 });
  assert.equal(snap.podium.fermatas.includes(lead.id), false);
  assert.deepEqual([lead.stand.source, lead.stand.selfReported, lead.stand.items.map((i) => i.status)], ['todo', { checked: 1, total: 3 }, ['completed', 'in_progress', 'pending']]);
  assert.deepEqual([ada.role, ada.parent, ada.depth, ada.agentType, ada.live.state, ada.live.basis, ada.instrument.class], ['clone', lead.id, 1, 'worker', 'returned', 'turn', 'strings']);
  assert.deepEqual([docs.role, docs.parent, docs.live.state, docs.live.basis], ['clone', lead.id, 'running', 'turn']);
  const items = snap.lanes.flatMap((l) => l.items).filter((w) => w.owner === lead.id && w.source === 'task');
  const of = (p: Player) => items.find((w) => w.executor === p.id)!;
  assert.deepEqual([of(ada).join, of(ada).state, of(ada).report, of(ada).stateRule], ['agentId', 'reported', { at: BASE + 20_000, bytes: 0 }, 'codex.join.activity']);
  assert.deepEqual([of(docs).join, of(docs).state, of(docs).stateRule], ['agentPath', 'working', 'codex.join.activity']);
  const cues = snap.lanes.flatMap((l) => l.cues).filter((q) => q.from === lead.id || q.to === lead.id);
  assert.deepEqual(cues.map((q) => q.kind).sort(), ['dispatch', 'dispatch', 'report']);
  // The canary in the plan and the spawn message never leaves.
  assert.equal(JSON.stringify(snap).includes(STAGE_CANARY), false);
  const rule = (id: string) => snap.rules.find((r) => r.id === id)!.hits;
  assert.deepEqual(['codex.meta.keys', 'codex.child.parentThread', 'codex.join.spawn', 'codex.join.activity', 'codex.waiting.unpaired'].map(rule), [3, 2, 2, 2, 1]);
});

test('stage: a subagent whose parent is not listed stays at the root as a clone; a loop of parents stays principals', (t) => {
  const { snap } = stage(t, (dir) => {
    const d = path.join(dir, 'roots', 'codex', 'sessions', '2026', '11', '01');
    const P = '01a00000-0000-7000-8000-00000000ffff';
    put(path.join(d, rollout(U1)), lines(meta(U1, { source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_nickname: 'Orphan' } } } })));
    put(path.join(d, rollout(U2)), lines(meta(U2, { parent_thread_id: U3, cwd: 'G:\\fx\\loop' })));
    put(path.join(d, rollout(U3)), lines(meta(U3, { parent_thread_id: U2, cwd: 'G:\\fx\\loop' })));
  });
  const orphan = named(snap, 'Orphan');
  assert.deepEqual([orphan.role, orphan.parent, orphan.depth], ['clone', null, 0]);
  const loop = codexPlayers(snap).filter((p) => p.label === 'loop');
  assert.deepEqual(loop.map((p) => [p.role, p.parent]), [['principal', null], ['principal', null]]);
});

test('stage: a chain of spawns deeper than the depth limit is cut, counted, and no item names a cut player', (t) => {
  const ids = Array.from({ length: 7 }, (_, i) => `01a00000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`);
  const { snap } = stage(t, (dir) => {
    const d = path.join(dir, 'roots', 'codex', 'sessions', '2026', '11', '01');
    ids.forEach((id, i) => {
      const next = ids[i + 1];
      const spawn = next === undefined ? [] : [call(`s${i}`, 'spawn_agent', { task_name: `n${i + 1}`, message: 'go' }), out(`s${i}`, JSON.stringify({ agent_id: next }))];
      put(path.join(d, rollout(id)), lines(meta(id, { cwd: 'G:\\fx\\deep', ...(i === 0 ? {} : { parent_thread_id: ids[i - 1], agent_nickname: `n${i}` }) }), ...spawn));
    });
  });
  const deep = codexPlayers(snap);
  assert.equal(Math.max(...deep.map((p) => p.depth)), STAGE_LIMITS.depth);
  assert.equal(deep.length, STAGE_LIMITS.depth + 1);
  assert.equal(snap.clipped.players, ids.length - STAGE_LIMITS.depth - 1);
  const last = deep.find((p) => p.depth === STAGE_LIMITS.depth)!;
  const cut = snap.lanes.flatMap((l) => l.items).find((w) => w.owner === last.id)!;
  assert.deepEqual([cut.executor, cut.join, cut.state], [null, null, 'unknown']);
});

test('stage: an inferred wait in a rollout older than codexWaitMaxAgeMs reads quiet, and a closed turn idle', (t) => {
  const { snap } = stage(t, (dir) => {
    const d = path.join(dir, 'roots', 'codex', 'sessions', '2026', '11', '01');
    const old = put(path.join(d, rollout(U1)), lines(meta(U1, { cwd: 'G:\\fx\\old' }), ev('task_started'), call('q', 'request_user_input', { questions: [] })));
    const sec = Math.round((BASE - STAGE_LIMITS.codexWaitMaxAgeMs - 60_000) / 1000);
    fs.utimesSync(old, sec, sec);
    const done = put(path.join(d, rollout(U2)), lines(meta(U2, { cwd: 'G:\\fx\\done' }), ev('task_started'), ev('task_complete')));
    fs.utimesSync(done, BASE / 1000, BASE / 1000);
  });
  assert.deepEqual([named(snap, 'old').live.state, named(snap, 'old').live.basis, named(snap, 'old').live.waitingFor], ['quiet', 'turn', null]);
  assert.deepEqual([named(snap, 'done').live.state, named(snap, 'done').live.basis], ['idle', 'turn']);
  assert.equal(snap.rules.find((r) => r.id === 'codex.waiting.unpaired')!.hits, 0);
});

test('stage: a rollout the system will not open marks the Codex source, and its path never shows', (t) => {
  const { snap, dir, gate } = stage(t, undefined, (io) => ({
    ...io,
    openSync: (p, flags) => {
      if (p.includes(FX.codexDocs)) throw Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: 'EPERM', syscall: 'open', path: p });
      return io.openSync(p, flags);
    },
  }));
  assert.deepEqual([snap.sources.codex.state, snap.sources.codex.error], ['error', 'read-failed']);
  assert.equal(codexPlayers(snap).some((p) => p.label === 'docs'), false);
  assert.equal(JSON.stringify(snap).includes(dir), false);
  assert.equal(gate.openHandles(), 0);
});

test('stage: a Codex session detail is its last events, through the same reader', (t) => {
  const { snap, builder } = stage(t);
  const lead = codexPlayers(snap).find((p) => p.role === 'principal')!;
  const d = builder.session(lead.session!)!;
  assert.deepEqual(validateSession(d).errors, []);
  assert.deepEqual([d.session.harness, d.session.label, d.events[0]!.type], ['codex', 'shop', 'session_meta']);
  assert.equal(JSON.stringify(d).includes(STAGE_CANARY), false);
});

// ---- Review fixes (orchestra app phase 1)

test('a secret the 600-character cut runs through is redacted before the cut, so no prefix of it shows', () => {
  // The redactor wants 8 characters after sk-ant-: cut first, only 3 would be left and pass as text.
  const key = `sk-ant-${'Q'.repeat(30)}`;
  const args = `${'x'.repeat(589)} ${key}`;
  const cx = codexEvent(JSON.stringify(item('function_call', { name: 'shell_command', arguments: args, call_id: 'c' })), redact)!;
  const cl = claudeEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { c: `${'x'.repeat(581)} ${key}` } }] } }), redact)!;
  for (const text of [cx.text, cl.text]) {
    assert.equal(text.includes('sk-ant-'), false, text.slice(-40));
    assert.equal(text.includes('QQQ'), false, text.slice(-40));
  }
});

test('a .zst rollout is read no further than the size it was listed with (plus one byte), whatever it became', (t) => {
  let read = 0;
  const fx = fixture(t, (io) => ({ ...io, readSync: (fd, buf, off, len, pos) => { const n = io.readSync(fd, buf, off, len, pos); read += n; return n; } }));
  put(path.join(fx.codex, 'archived_sessions', rollout(U1, '.jsonl.zst')), zst(lines(meta(U1), ...Array.from({ length: 200 }, (_, i) => call(`c${i}`, 'shell_command', { command: `echo ${i}` })))));
  const s = only(fx);
  read = 0;
  const whole = records(fx, s);
  assert.deepEqual([whole.got.length, whole.note], [201, null]);
  assert.equal(read, s.size, 'the listed size, and the extra byte finds the end of the file');
  // Listed smaller than it is now (it grew, or was swapped, after the listing): only the listed bytes and one more.
  read = 0;
  const grown = records(fx, { ...s, size: 64 });
  assert.ok(read <= 65, String(read));
  assert.equal(grown.got.length, 0);
  assert.notEqual(grown.note, null);
  assert.equal(fx.gate.openHandles(), 0);
});

test('an aborted turn is no report: a Codex subagent whose turn was aborted is unknown, never returned (T2)', (t) => {
  assert.equal(digestCodex([meta(U1), ev('task_started'), ev('turn_aborted', { reason: 'interrupted' })], { redact }).codex?.turn, 'aborted');
  assert.equal(digestCodex([meta(U1), ev('task_started'), ev('task_complete')], { redact }).codex?.turn, 'closed');
  const { snap } = stage(t, (dir) => {
    const d = path.join(dir, 'roots', 'codex', 'sessions', '2026', '11', '01');
    put(path.join(d, rollout(U1)), lines(meta(U1, { cwd: 'G:\\fx\\cut' }), ev('task_started'), ev('task_complete')));
    for (const [id, nick, end] of [[U2, 'Stopped', 'turn_aborted'], [U3, 'Sent', 'task_complete']] as const) {
      put(path.join(d, rollout(id)), lines(meta(id, { cwd: 'G:\\fx\\cut', source: { subagent: { thread_spawn: { parent_thread_id: U1, depth: 1, agent_nickname: nick } } } }), ev('task_started'), ev(end)));
    }
    // A lead whose own turn was aborted is not idle either.
    const L = '01a00000-0000-7000-8000-000000000004';
    put(path.join(d, rollout(L)), lines(meta(L, { cwd: 'G:\\fx\\halt' }), ev('task_started'), ev('turn_aborted')));
  });
  assert.deepEqual([named(snap, 'Stopped').live.state, named(snap, 'Sent').live.state, named(snap, 'halt').live.state], ['unknown', 'returned', 'unknown']);
  const tower = towerFromStage(snap);
  const all = tower.projects.flatMap((p) => p.nodes);
  const stopped = all.find((n) => n.title === 'Stopped')!;
  assert.deepEqual([stopped.state, stopped.basis], ['unknown', 'none']);
  assert.equal(all.find((n) => n.title === 'halt')!.state, 'unknown');
  assert.equal(tower.projects.flatMap((p) => [...p.groups, ...p.nodes.flatMap((n) => n.groups)]).some((g) => g.ids.includes(stopped.id)), false);
});

test('a Codex session that may wait on you stays in the snapshot however many newer ones push at it', (t) => {
  const newer = Array.from({ length: STAGE_LIMITS.principals }, (_, i) => `01a00000-0000-7000-8000-0000000002${String(i).padStart(2, '0')}`);
  const { snap } = stage(t, (dir) => {
    const d = path.join(dir, 'roots', 'codex', 'sessions', '2026', '11', '01');
    newer.forEach((id, i) => {
      const f = put(path.join(d, rollout(id)), lines(meta(id, { cwd: `G:\\fx\\n${i}` }), ev('task_started'), ev('task_complete')));
      fs.utimesSync(f, BASE / 1000 - i, BASE / 1000 - i);
    });
    // Older than all of them, and well within codexWaitMaxAgeMs: an open turn's question.
    const f = put(path.join(d, rollout(U1)), lines(meta(U1, { cwd: 'G:\\fx\\asks' }), ev('task_started'), call('q', 'request_user_input', { questions: [] })));
    fs.utimesSync(f, BASE / 1000 - 3600, BASE / 1000 - 3600);
  });
  const asks = named(snap, 'asks');
  assert.deepEqual([asks.live.state, asks.live.basis], ['waiting', 'unpaired-tool-use']);
  const tower = towerFromStage(snap);
  const node = tower.projects.flatMap((p) => p.nodes).find((n) => n.title === 'asks')!;
  assert.deepEqual(tower.waitingBar.map((w) => w.node), [node.id]);
  assert.equal(tower.tally.waiting, 1);
  assert.equal(codexPlayers(snap).filter((p) => p.role === 'principal').length, STAGE_LIMITS.principals, 'a newer one went instead');
});

test('stage: a session detail is read once while its file is unchanged (an archived .zst is not decoded on every revision)', (t) => {
  let opens = 0;
  const { snap, builder } = stage(t, undefined, (io) => ({ ...io, openSync: (p, flags) => { if (p.includes(FX.codexTests)) opens++; return io.openSync(p, flags); } }));
  const ada = named(snap, 'Ada');
  opens = 0;
  const one = builder.session(ada.session!)!;
  const two = builder.session(ada.session!)!;
  assert.equal(opens, 1);
  assert.deepEqual(two.events, one.events);
});
