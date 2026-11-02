import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { TestContext } from 'node:test';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import type { ReadIo } from '../../src/fs/read-gate.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import type { Player, StageSnapshot, WorkItem } from '../../src/sources/stage.ts';
import { KEYS, RULES, STAGE_LIMITS, classifyInstrument, deriveLook, joinClones, makeStageBuilder, slugTail } from '../../src/sources/stage.ts';
import { PEEK_LIMITS, eachRecord, listSessions } from '../../src/sources/peek.ts';
import { STAGE_RULE_IDS, validateSession, validateStage } from '../../shared/stage-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { FX, STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { put, withTmp } from '../helpers/tmp.ts';

// The stage preview over synthetic roots only (plan §6 invariant 18), through the real read gate.

const BASE = 1_793_560_000_000;
const NOW = BASE + 30_000;
const redactor = makeRedactor({ env: {} });
const redact = (text: string) => redactor.redact({ text }).text;

type Fx = { dir: string; roots: HarnessRoot[]; gate: ReadGate; hub: VirtualClock; opened: string[]; build: () => ReturnType<typeof makeStageBuilder> };

function fixture(t: TestContext, write: (dir: string) => void = (dir) => void writeStageFixture(dir, BASE), wrap: (io: ReadIo) => ReadIo = (io) => io): Fx {
  const dir = fs.realpathSync.native(withTmp(t));
  write(dir);
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    fs.mkdirSync(p, { recursive: true });
    return { kind, path: p, real: p };
  });
  const opened: string[] = [];
  const io: ReadIo = wrap({ ...realIo, openSync: (p, flags) => (opened.push(p), realIo.openSync(p, flags)) });
  const gate = new ReadGate({ roots, io, testDirs: [dir] });
  const hub = new VirtualClock({ mono: 1000, wall: NOW });
  return { dir, roots, gate, hub, opened, build: () => makeStageBuilder({ gate, roots, redact, clock: hub.port(null), profile: 'test' }) };
}

const players = (s: StageSnapshot) => s.lanes.flatMap((l) => l.players);
const items = (s: StageSnapshot) => s.lanes.flatMap((l) => l.items);
const byLabel = (s: StageSnapshot, label: string): Player => {
  const p = players(s).find((x) => x.label === label);
  assert.ok(p !== undefined, `no player ${label}`);
  return p;
};
const itemOf = (s: StageSnapshot, executor: Player): WorkItem => {
  const w = items(s).find((x) => x.executor === executor.id);
  assert.ok(w !== undefined, `no item run by ${executor.label}`);
  return w;
};
const ok = (s: unknown) => {
  const v = validateStage(s);
  assert.deepEqual(v.errors, []);
};

test('Task calls join their subagents by agentId or by description; the unnamed one is a possible orphan', (t) => {
  const fx = fixture(t);
  const s = fx.build().snapshot();
  ok(s);
  const lead = players(s).find((p) => p.harness === 'claude' && p.role === 'principal')!;
  const a1 = byLabel(s, 'Explore cart');
  const a2 = byLabel(s, 'Review diff');
  const a3 = byLabel(s, 'Scan legacy coupons');
  assert.deepEqual([a1.parent, a2.parent, a3.parent], [lead.id, lead.id, lead.id]);

  const w1 = itemOf(s, a1);
  assert.deepEqual([w1.join, w1.state, w1.stateRule, w1.source], ['agentId', 'reported', 'claude.join.agentId', 'task']);
  assert.deepEqual(w1.report, { at: Date.parse('2026-11-01T10:00:20Z'), bytes: Buffer.byteLength('cart.ts, cart.test.ts') });
  assert.deepEqual(w1.flow, { childBytes: a1.bytes, reportBytes: w1.report!.bytes });
  assert.deepEqual([a1.live.state, a1.look], ['returned', 'translucent']);

  const w2 = itemOf(s, a2);
  assert.deepEqual([w2.join, w2.state, w2.report, w2.flow], ['description', 'working', null, null]);
  assert.deepEqual([a2.live.state, a2.live.basis, a2.look], ['running', 'unpaired-tool-use', 'solid']);

  const w3 = itemOf(s, a3);
  assert.deepEqual([w3.join, w3.state, w3.source], [null, 'orphan', 'subagent-catalog']);
  assert.deepEqual([a3.live.state, a3.live.basis, a3.look, a3.lookRule], ['unknown', 'none', 'ghost', 'look.ghost.orphan']);
  // Nothing claims more than reported, and no item has criteria or a verdict (D19).
  for (const w of items(s)) assert.deepEqual([w.criteria.state, w.verdict], ['undeclared', 'no-reviewer']);
  const cues = s.lanes[0]!.cues;
  assert.ok(cues.some((c) => c.kind === 'report' && c.from === a1.id && c.to === lead.id && c.item === w1.id));
  assert.equal(cues.some((c) => c.kind === 'report' && c.from === a2.id), false);
});

test('a subagent that dispatches its own Task call heads a department at depth 2', (t) => {
  const s = fixture(t).build().snapshot();
  const a2 = byLabel(s, 'Review diff');
  const a4 = byLabel(s, 'Run checkout tests');
  assert.deepEqual([a4.parent, a4.depth, a4.shade, a4.role], [a2.id, 2, 2, 'clone']);
  const w4 = itemOf(s, a4);
  assert.equal(w4.owner, a2.id);
  assert.equal(w4.parent, itemOf(s, a2).id);
  assert.equal(a4.instrument.class, 'percussion');
});

test('the lead\'s latest TodoWrite is its stand, self-checked items counted, and its own work items', (t) => {
  const s = fixture(t).build().snapshot();
  const lead = players(s).find((p) => p.harness === 'claude' && p.role === 'principal')!;
  assert.equal(lead.stand.source, 'todo');
  assert.equal(lead.stand.keys, 'ok');
  assert.deepEqual(lead.stand.selfReported, { checked: 1, total: 3 });
  assert.deepEqual(lead.stand.items.map((i) => i.status), ['completed', 'in_progress', 'pending']);
  const own = items(s).filter((w) => w.owner === lead.id && w.source === 'todo');
  assert.deepEqual(own.map((w) => [w.state, w.todoStatus, w.executor]), [['self', 'completed', null], ['self', 'in_progress', null], ['self', 'pending', null]]);
});

test('instrument: brass by role, then percussion, strings, woodwind, unknown over the last 20 calls', () => {
  assert.equal(classifyInstrument(['shell', 'write'], 'code-reviewer').class, 'brass');
  assert.equal(classifyInstrument(['read', 'write', 'shell'], null).class, 'percussion');
  assert.equal(classifyInstrument(['read', 'write', 'other'], 'worker').class, 'strings');
  assert.equal(classifyInstrument(['read', 'other'], null).class, 'woodwind');
  assert.equal(classifyInstrument([], null).class, 'unknown');
  const old = classifyInstrument(['shell', ...Array.from({ length: 20 }, () => 'read' as const)], null);
  assert.deepEqual([old.class, old.window, old.read, old.shell], ['woodwind', 20, 20, 0]);
});

test('look: a possible orphan needs age and a parent that is not busy; live states play solid', () => {
  const base = { state: 'running' as const, ageMs: STAGE_LIMITS.ghostAgeMs + 1, unjoined: false, unpaired: true, parentBusy: false };
  assert.equal(deriveLook(base).look, 'ghost');
  assert.equal(deriveLook({ ...base, parentBusy: true }).look, 'solid');
  assert.equal(deriveLook({ ...base, ageMs: 1000 }).look, 'solid');
  assert.equal(deriveLook({ ...base, state: 'returned', unpaired: false, ageMs: 59_000 }).look, 'solid');
  assert.equal(deriveLook({ ...base, state: 'returned', unpaired: false, ageMs: 61_000 }).look, 'translucent');
});

test('joinClones prefers the agentId, then a description only one free subagent carries', () => {
  const task = (k: string, description: string, agentKey: string | null) => ({ key: k, description, brief: description, agentType: null, paired: agentKey !== null, report: null, agentKey });
  const parent = { tasks: [task('t1', 'same', 'A'), task('t2', 'same', null), task('t3', 'twice', null)] } as never;
  const joins = joinClones(parent, [{ agentKey: 'B', description: 'same' }, { agentKey: 'A', description: 'other' }, { agentKey: 'C', description: 'twice' }, { agentKey: 'D', description: 'twice' }]);
  assert.deepEqual(joins, [{ task: 't1', sub: 1, by: 'agentId' }, { task: 't2', sub: 0, by: 'description' }]);
  // F4: a call whose result named agent X joins X or nothing, never another subagent by description.
  const named = { tasks: [task('t1', 'Run tests', 'X'), task('t2', 'Run tests', null)] } as never;
  assert.deepEqual(joinClones(named, [{ agentKey: 'Y', description: 'Run tests' }]), [{ task: 't2', sub: 0, by: 'description' }]);
  // F5: two unnamed calls carry the description (here, or anywhere in the tree): neither takes the one subagent.
  const twice = { tasks: [task('t1', 'Run tests', null), task('t2', 'Run tests', null)] } as never;
  assert.deepEqual(joinClones(twice, [{ agentKey: 'Y', description: 'Run tests' }]), []);
  const once = { tasks: [task('t1', 'Run tests', null)] } as never;
  assert.deepEqual(joinClones(once, [{ agentKey: 'Y', description: 'Run tests' }], new Map([['Run tests', 2]])), []);
  assert.deepEqual(joinClones(once, [{ agentKey: 'Y', description: 'Run tests' }], new Map([['Run tests', 1]])), [{ task: 't1', sub: 0, by: 'description' }]);
});


test('registry waiting puts the lead on the podium; without a registry entry its state is unknown', (t) => {
  const fx = fixture(t);
  const s = fx.build().snapshot();
  const lead = players(s).find((p) => p.harness === 'claude' && p.role === 'principal')!;
  assert.deepEqual(lead.live, { state: 'waiting', basis: 'registry', waitingFor: 'permission prompt', ageMs: 5000 });
  assert.deepEqual(s.podium, { fermatas: [lead.id], inbox: null });
  assert.equal(s.sources.claude.registry, 1);

  const bare = fixture(t, (dir) => {
    writeStageFixture(dir, BASE);
    fs.rmSync(path.join(dir, 'roots', 'claude', 'sessions', '41234.json'));
  });
  const s2 = bare.build().snapshot();
  ok(s2);
  const lead2 = players(s2).find((p) => p.harness === 'claude' && p.role === 'principal')!;
  assert.deepEqual([lead2.live.state, lead2.live.basis, lead2.live.waitingFor], ['unknown', 'none', null]);
  assert.deepEqual(s2.podium.fermatas, []);
  assert.equal(s2.rules.find((r) => r.id === 'claude.live.registry')!.hits, 0);
});

test('DSH: parentSession nests the children, team members are teammates, the lead\'s goal is its stand', (t) => {
  const s = fixture(t).build().snapshot();
  const lead = players(s).find((p) => p.harness === 'dsh' && p.role === 'principal')!;
  const impl = byLabel(s, 'impl');
  const reviewer = byLabel(s, 'reviewer');
  assert.deepEqual([impl.role, impl.parent, impl.depth, impl.instrument.class], ['teammate', lead.id, 1, 'strings']);
  assert.deepEqual([reviewer.role, reviewer.parent, reviewer.instrument.class, reviewer.live.state, reviewer.look], ['clone', lead.id, 'brass', 'quiet', 'translucent']);
  assert.deepEqual([lead.live.basis, lead.stand.source, lead.stand.selfReported], ['mtime', 'goal', { checked: 1, total: 3 }]);
  assert.match(lead.stand.title ?? '', /^Ship checkout; deploy key \[redacted:/);
  assert.deepEqual([impl.stand.source, impl.stand.title], ['team-task', 'Implement checkout']);
  const team = itemOf(s, impl);
  assert.deepEqual([team.source, team.join, team.state], ['team-task', 'team-owner', 'working']);
  const cat = itemOf(s, reviewer);
  assert.deepEqual([cat.source, cat.join, cat.state], ['subagent-catalog', 'parentSession', 'unknown']);
  // Both leads worked in G:\fx\shop: one lane, named by the cwd's last segment only.
  assert.deepEqual(s.lanes.map((l) => [l.name, l.basis]), [['shop', 'cwd']]);
  assert.deepEqual(s.sources.codex, { state: 'ok', sessions: 3, shown: 3, registry: null, error: null });
});

test('a transcript read from its tail: a TodoWrite before it is a tail miss, and an unnamed subagent is unknown', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-long');
    const todo = { type: 'assistant', cwd: 'G:\\fx\\long', message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'TodoWrite', input: { todos: [{ content: 'early', status: 'pending' }] } }] } };
    const filler = Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'assistant', cwd: 'G:\\fx\\long', message: { content: `${i} ${'z'.repeat(1000)}` } }));
    put(path.join(project, `${FX.claudeSession}.jsonl`), `${[JSON.stringify(todo), ...filler].join('\n')}\n`);
    old(put(path.join(project, FX.claudeSession, 'subagents', 'agent-q1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: 'x' } })}\n`), 900);
  });
  const s = fx.build().snapshot();
  ok(s);
  const lead = players(s).find((p) => p.role === 'principal')!;
  assert.deepEqual([lead.note, lead.stand.source, lead.stand.keys], ['tail-only', 'tail-miss', 'none']);
  const q1 = byLabel(s, 'agent-q1');
  const w = itemOf(s, q1);
  assert.deepEqual([w.state, w.join, w.stateRule], ['unknown', null, 'claude.clone.tail-only']);
  assert.equal(s.rules.find((r) => r.id === 'claude.clone.orphan')!.hits, 0);
  // 15 min old, yet no possible orphan: the call that started it may lie before the tail.
  assert.deepEqual([q1.look, q1.lookRule], ['translucent', 'look.translucent.unknown']);
});

test('an event without its expected keys is a keys mismatch, never an empty stand', (t) => {
  const fx = fixture(t, (dir) => {
    writeStageFixture(dir, BASE);
    const frame = (rows: unknown[]) => zlib.zstdCompressSync(Buffer.from(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`));
    put(path.join(dir, 'roots', 'dsh', 'sessions', '--G-fx-other--', '55555555-5555-4555-8555-555555555555', 'session.v4.jsonl.zstd'), Buffer.concat([
      frame([{ type: 'head', id: '55555555-5555-4555-8555-555555555555', cwd: 'G:\\fx\\other', delegationDepth: 0 }]),
      frame([{ type: 'goal/change', seq: 1, time: BASE, data: { objective: 'renamed key' } }]),
    ]));
  });
  const s = fx.build().snapshot();
  ok(s);
  const other = players(s).find((p) => p.harness === 'dsh' && p.label === 'other')!;
  assert.deepEqual([other.stand.source, other.stand.keys, other.stand.title], ['goal', 'mismatch', null]);
  const rule = s.rules.find((r) => r.id === 'dsh.stand.goal-keys')!;
  assert.deepEqual([rule.status, rule.n], ['keys-mismatch', 0]);
});

test('every rule is listed once with n 0, untested unless its keys are missing', (t) => {
  const s = fixture(t).build().snapshot();
  assert.deepEqual(s.rules.map((r) => r.id), [...STAGE_RULE_IDS]);
  assert.deepEqual(RULES.map((r) => r.n), STAGE_RULE_IDS.map(() => 0));
  for (const r of s.rules) assert.deepEqual([r.n, r.status], [0, 'untested'], r.id);
  assert.equal(s.rules.find((r) => r.id === 'claude.join.agentId')!.hits, 1);
  // Every KEYS entry reports through a rule the snapshot lists.
  for (const e of KEYS) assert.ok((STAGE_RULE_IDS as readonly string[]).includes(e.rule), e.id);
});

test('limits: 24 principals and 16 subagents each, the rest counted as clipped', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-many');
    for (let i = 0; i < 30; i++) {
      const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const f = put(path.join(project, `${uuid}.jsonl`), `${JSON.stringify({ type: 'user', cwd: `G:\\fx\\many${i}`, message: { content: 'hi' } })}\n`);
      fs.utimesSync(f, BASE / 1000 - i, BASE / 1000 - i);
      if (i === 0) for (let k = 0; k < 20; k++) put(path.join(project, uuid, 'subagents', `agent-k${k}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { content: 'x' } })}\n`);
    }
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.equal(players(s).filter((p) => p.role === 'principal').length, STAGE_LIMITS.principals);
  assert.equal(players(s).filter((p) => p.role === 'clone').length, STAGE_LIMITS.clonesPerParent);
  assert.equal(s.clipped.players, 6 + 4);
  assert.equal(fx.gate.openHandles(), 0);
});

test('the body stays under 256 KiB: past it whole lanes go and are counted', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-big');
    const long = (s: string) => `${s} ${'w'.repeat(110)}`;
    for (let i = 0; i < 24; i++) {
      const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const todos = Array.from({ length: 14 }, (_, k) => ({ content: long(`todo ${k}`), status: 'pending' }));
      const calls = Array.from({ length: 16 }, (_, k) => ({ type: 'tool_use', id: `toolu_${k}`, name: 'Task', input: { description: long(`job ${k}`), prompt: long('do it') } }));
      put(path.join(project, `${uuid}.jsonl`), `${[
        { type: 'assistant', cwd: `G:\\fx\\big${i}`, message: { content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos } }, ...calls] } },
      ].map((r) => JSON.stringify(r)).join('\n')}\n`);
      for (let k = 0; k < 16; k++) {
        const sub = path.join(project, uuid, 'subagents');
        put(path.join(sub, `agent-k${k}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { content: 'x' } })}\n`);
        put(path.join(sub, `agent-k${k}.meta.json`), JSON.stringify({ agentType: 'Explore', description: long(`job ${k}`) }));
      }
    }
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.ok(Buffer.byteLength(JSON.stringify(s), 'utf8') <= STAGE_LIMITS.bodyBytes);
  assert.ok(s.clipped.lanes > 0);
  assert.ok(s.clipped.standItems > 0);
  assert.ok(s.lanes.every((l) => l.items.length <= STAGE_LIMITS.itemsPerLane));
});

test('redaction: the canary in the fixture never reaches a snapshot or a session detail, nor does a path', (t) => {
  const fx = fixture(t);
  // Control: the raw files do hold the canary, so its absence below is the reader's doing.
  const raw = fs.readFileSync(path.join(fx.dir, 'roots', 'claude', 'projects', FX.claudeProject, `${FX.claudeSession}.jsonl`), 'utf8');
  assert.equal(raw.split(STAGE_CANARY).length - 1, 2, 'the transcript holds the canary twice');
  const log = zlib.zstdDecompressSync(fs.readFileSync(path.join(fx.dir, 'roots', 'dsh', 'sessions', FX.dshProject, FX.dshLead, 'session.v4.jsonl.zstd'))).toString('utf8');
  assert.equal(log.split(STAGE_CANARY).length - 1, 1, 'the DSH log holds it in the goal');
  const b = fx.build();
  const s = b.snapshot();
  const details = players(s).map((p) => b.session(p.session!));
  for (const d of details) {
    assert.ok(d !== null);
    assert.deepEqual(validateSession(d).errors, []);
  }
  const out = JSON.stringify(s) + JSON.stringify(details);
  assert.equal(out.includes(STAGE_CANARY), false);
  assert.equal(out.includes('sk-ant-api03'), false);
  assert.equal((JSON.stringify(s).match(/\[redacted:sk-ant\]/g) ?? []).length >= 4, true, 'todo stand, todo item, Task brief, DSH goal');
  assert.match(JSON.stringify(details), /\[redacted:/);
  // The project directories' names spell the absolute cwd (G--fx-shop is G:\fx\shop): never shown either.
  for (const p of [fx.dir, JSON.stringify(fx.dir).slice(1, -1), FX.cwd, JSON.stringify(FX.cwd).slice(1, -1), FX.claudeProject, FX.dshProject, 'fx-shop']) assert.equal(out.includes(p), false, `leaks ${p}`);
  assert.doesNotMatch(out, /[A-Za-z]:\\\\/);
  assert.equal(fx.gate.openHandles(), 0);
});

test('session(id): a principal or a subagent by digest, the last 50 events, no file path; anything else null', (t) => {
  const fx = fixture(t, (dir) => {
    writeStageFixture(dir, BASE);
    const rows = Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: `line ${i}` } }));
    put(path.join(dir, 'roots', 'claude', 'projects', FX.claudeProject, FX.claudeSession, 'subagents', 'agent-a1.jsonl'), `${rows.join('\n')}\n`);
  });
  const b = fx.build();
  const s = b.snapshot();
  const a1 = byLabel(s, 'Explore cart');
  const d = b.session(a1.session!)!;
  assert.deepEqual(Object.keys(d.session), ['id', 'harness', 'label', 'size', 'mtimeMs']);
  assert.equal(d.events.length, STAGE_LIMITS.events);
  assert.equal(d.events.at(-1)!.text, 'line 79');
  assert.equal(d.brief, 'Explore cart — Find cart code. Done when files listed.');
  assert.deepEqual(validateSession(d).errors, []);
  assert.equal(b.session('0'.repeat(20)), null);
  assert.equal(b.session('..\\x'), null);
  assert.equal(fx.gate.openHandles(), 0);
});

test('the memo reads an unchanged file once; a call within 2 s returns the same snapshot', (t) => {
  const fx = fixture(t);
  const b = fx.build();
  const first = b.snapshot();
  const transcripts = () => fx.opened.filter((p) => /\.(jsonl|zstd|meta\.json)$/i.test(p));
  const readOnce = transcripts().length;
  assert.ok(readOnce >= 10);
  assert.equal(b.snapshot(), first, 'throttled');
  advance(fx.hub, STAGE_LIMITS.throttleMs);
  const second = b.snapshot();
  assert.notEqual(second, first);
  assert.equal(transcripts().length, readOnce, 'nothing re-read');
  assert.equal(second.rev, first.rev, 'unchanged data, unchanged rev');
  // A changed file is read again.
  const a2 = path.join(fx.dir, 'roots', 'claude', 'projects', FX.claudeProject, FX.claudeSession, 'subagents', 'agent-a2.jsonl');
  fs.appendFileSync(a2, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: {} }] } })}\n`);
  advance(fx.hub, STAGE_LIMITS.throttleMs);
  const third = b.snapshot();
  assert.equal(transcripts().length, readOnce + 1);
  assert.notEqual(third.rev, first.rev);
  assert.equal(fx.gate.openHandles(), 0);
});

/** Sets a file's mtime `sec` seconds before BASE (so NOW sees it 30 s older); returns it. */
function old(file: string, sec: number): string {
  fs.utimesSync(file, BASE / 1000 - sec, BASE / 1000 - sec);
  return file;
}

const jl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const taskCall = (id: string, description: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description, prompt: `do ${description}` } }] } });
const taskResult = (id: string, agentId: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { agentId } });
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'assistant', message: { content: `${i} ${'z'.repeat(1000)}` } }));
const orphanHits = (s: StageSnapshot) => s.rules.find((r) => r.id === 'claude.clone.orphan')!.hits;

test('SEC-1: DSH records stream to the digest, and decoded text past its ceiling stops with too-large', (t) => {
  const fx = fixture(t, (dir) => {
    const frame = (rows: unknown[]) => zlib.zstdCompressSync(Buffer.from(jl(rows)));
    const rows = (from: number) => Array.from({ length: 1000 }, (_, i) => ({ type: 'tool/call', seq: from + i, data: { name: 'read', pad: 'p'.repeat(80) } }));
    put(path.join(dir, 'roots', 'dsh', 'sessions', '--G-fx-big--', '66666666-6666-4666-8666-666666666666', 'session.v4.jsonl.zstd'),
      Buffer.concat([frame([{ type: 'head', id: '66666666-6666-4666-8666-666666666666', cwd: 'G:\\fx\\big' }, ...rows(0)]), frame(rows(1000)), frame(rows(2000))]));
    // One frame that decodes to 2 MiB: it may not grow past what is left of the ceiling.
    put(path.join(dir, 'roots', 'dsh', 'sessions', '--G-fx-bomb--', '77777777-7777-4777-8777-777777777777', 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'head', pad: 'b'.repeat(2 * 1024 * 1024) })}\n`)));
  });
  const listed = listSessions(fx.gate, fx.roots, redact).sessions;
  const big = listed.find((s) => s.project === '--G-fx-big--')!;
  const bomb = listed.find((s) => s.project === '--G-fx-bomb--')!;
  let n = 0;
  const whole = eachRecord(fx.gate, big, () => void n++);
  assert.deepEqual([whole.note, n], [null, 3001]);
  n = 0;
  const cut = eachRecord(fx.gate, big, () => void n++, 150 * 1024);
  assert.equal(cut.note, 'too-large');
  assert.ok(n > 1000 && n < 3001, `${n} records`);
  n = 0;
  assert.deepEqual([eachRecord(fx.gate, bomb, () => void n++, 1024 * 1024).note, n], ['too-large', 0]);
  assert.equal(PEEK_LIMITS.dshMaxDecodedBytes, 4 * PEEK_LIMITS.dshMaxBytes);
  assert.equal(fx.gate.openHandles(), 0);
});

test('SEC-2: with more files than any count of entries, an unchanged tree is read once and never again', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-wide');
    for (let i = 0; i < 12; i++) {
      const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      put(path.join(project, `${uuid}.jsonl`), jl([{ type: 'user', cwd: `G:\\fx\\wide${i}`, message: { content: 'hi' } }]));
      for (let k = 0; k < 4; k++) {
        put(path.join(project, uuid, 'subagents', `agent-k${k}.jsonl`), jl([{ type: 'assistant', message: { content: 'x' } }]));
        put(path.join(project, uuid, 'subagents', `agent-k${k}.meta.json`), JSON.stringify({ agentType: 'Explore', description: `job ${k}` }));
      }
    }
  });
  const b = fx.build();
  b.snapshot();
  const reads = () => fx.opened.filter((p) => /\.(jsonl|zstd|meta\.json)$/i.test(p)).length;
  const first = reads();
  assert.ok(first >= 12 * 9, `${first} reads`);
  for (let i = 0; i < 3; i++) {
    advance(fx.hub, STAGE_LIMITS.throttleMs);
    b.snapshot();
  }
  assert.equal(reads(), first, 'no file read twice');
});

test('SEC-3: a lane named by its project directory shows the last segment only, and a session detail never the directory', (t) => {
  const project = 'C--Users-someone-Projects-secretapp';
  const fx = fixture(t, (dir) => {
    put(path.join(dir, 'roots', 'claude', 'projects', project, `${FX.claudeSession}.jsonl`), jl([{ type: 'user', message: { content: 'no cwd here' } }]));
  });
  const b = fx.build();
  const s = b.snapshot();
  ok(s);
  assert.deepEqual(s.lanes.map((l) => [l.name, l.basis]), [['secretapp', 'slug']]);
  assert.equal(players(s)[0]!.label, 'secretapp');
  const d = b.session(players(s)[0]!.session!)!;
  assert.equal(d.session.label, 'secretapp');
  assert.equal((JSON.stringify(s) + JSON.stringify(d)).includes('someone'), false);
  assert.deepEqual([slugTail('--G-fx-shop--'), slugTail('plain'), slugTail('---')], ['shop', 'plain', 'project']);
});

test('SEC-4: a file the system will not open marks its source, and neither fails the snapshot nor shows its path', (t) => {
  const fx = fixture(t, undefined, (io) => ({
    ...io,
    openSync: (p, flags) => {
      if (/agent-a1\.jsonl$/.test(p)) throw Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: 'EPERM', syscall: 'open', path: p });
      return io.openSync(p, flags);
    },
  }));
  const s = fx.build().snapshot();
  ok(s);
  assert.deepEqual([s.sources.claude.state, s.sources.claude.error], ['error', 'read-failed']);
  assert.equal(JSON.stringify(s).includes(fx.dir), false);
  assert.equal(players(s).some((p) => p.label === 'Explore cart'), false);
  assert.equal(fx.gate.openHandles(), 0);
});

test('F2: a Workflow agent is never joined by description nor called a possible orphan', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-wf');
    put(path.join(project, `${FX.claudeSession}.jsonl`), jl([
      { type: 'assistant', cwd: 'G:\\fx\\wf', message: { content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: 'x' } }] } },
      { ...taskCall('toolu_t', 'Check types'), cwd: 'G:\\fx\\wf' },
    ]));
    const wf = path.join(project, FX.claudeSession, 'subagents', 'workflows', 'wf_abc');
    old(put(path.join(wf, 'agent-w1.jsonl'), jl([{ type: 'assistant', message: { content: 'x' } }])), 900);
    put(path.join(wf, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Check types' }));
  });
  const s = fx.build().snapshot();
  ok(s);
  const w1 = byLabel(s, 'Check types');
  const w = itemOf(s, w1);
  assert.deepEqual([w.source, w.state, w.stateRule, w.join], ['subagent-catalog', 'unknown', 'claude.clone.workflow', null]);
  assert.notEqual(w1.look, 'ghost');
  assert.equal(orphanHits(s), 0);
  // The Task call with the same description stays unjoined: it did not start the Workflow agent.
  const task = items(s).find((x) => x.source === 'task')!;
  assert.deepEqual([task.executor, task.join], [null, null]);
});

test('F3: a subagent named by no call, under a clone read from its tail, is unknown, not an orphan', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-deep');
    put(path.join(project, `${FX.claudeSession}.jsonl`), jl([{ ...taskCall('toolu_1', 'Big job'), cwd: 'G:\\fx\\deep' }, taskResult('toolu_1', 'a2')]));
    const subs = path.join(project, FX.claudeSession, 'subagents');
    put(path.join(subs, 'agent-a2.jsonl'), jl([taskCall('toolu_n', 'Nested'), ...filler(300)]));
    old(put(path.join(subs, 'agent-a4.jsonl'), jl([{ type: 'assistant', message: { content: 'x' } }])), 900);
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.equal(byLabel(s, 'Big job').note, 'tail-only');
  const a4 = byLabel(s, 'agent-a4');
  assert.deepEqual([itemOf(s, a4).state, itemOf(s, a4).stateRule], ['unknown', 'claude.clone.tail-only']);
  assert.notEqual(a4.look, 'ghost');
  assert.equal(orphanHits(s), 0);
});

test('F6: a session waiting on you is listed, read and on the podium however many newer ones there are', (t) => {
  const waitingUuid = `00000000-0000-4000-8000-${String(60).padStart(12, '0')}`;
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-many');
    for (let i = 0; i <= 60; i++) {
      const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      old(put(path.join(project, `${uuid}.jsonl`), jl([{ type: 'user', cwd: `G:\\fx\\many${i}`, message: { content: 'hi' } }])), i);
    }
    put(path.join(dir, 'roots', 'claude', 'sessions', '9.json'), JSON.stringify({ sessionId: waitingUuid, status: 'waiting', waitingFor: 'permission prompt' }));
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.equal(s.podium.fermatas.length, 1);
  const p = players(s).find((x) => x.id === s.podium.fermatas[0])!;
  assert.deepEqual([p.live.state, p.live.waitingFor, p.label], ['waiting', 'permission prompt', 'many60']);
  assert.equal(players(s).filter((x) => x.role === 'principal').length, STAGE_LIMITS.principals);
  // 61 listed less 60 shown, and 60 Claude principals less the 24 read.
  assert.equal(s.clipped.players, 1 + 36);
});

test('F7: a subagent past the depth limit takes the subagents it dispatched with it', (t) => {
  const fx = fixture(t, (dir) => {
    const project = path.join(dir, 'roots', 'claude', 'projects', 'G--fx-chain');
    put(path.join(project, `${FX.claudeSession}.jsonl`), jl([{ ...taskCall('toolu_0', 'step 1'), cwd: 'G:\\fx\\chain' }, taskResult('toolu_0', 'c1')]));
    const subs = path.join(project, FX.claudeSession, 'subagents');
    for (let i = 1; i <= 6; i++) {
      const rows = i < 6 ? [taskCall(`toolu_${i}`, `step ${i + 1}`), taskResult(`toolu_${i}`, `c${i + 1}`)] : [{ type: 'assistant', message: { content: 'x' } }];
      old(put(path.join(subs, `agent-c${i}.jsonl`), jl(rows)), 900);
    }
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.deepEqual(players(s).map((p) => [p.label, p.depth]), [['chain', 0], ['step 1', 1], ['step 2', 2], ['step 3', 3], ['step 4', 4]]);
  assert.equal(s.clipped.players, 2);
  assert.equal(orphanHits(s), 0);
  const c4 = byLabel(s, 'step 4');
  const clippedTask = items(s).find((w) => w.owner === c4.id)!;
  assert.deepEqual([clippedTask.executor, clippedTask.join, clippedTask.stateRule], [null, null, 'claude.task.paired']);
});

test('F9: a DSH child whose parent log is not listed stays at the root, but as a clone, never a lead', (t) => {
  const fx = fixture(t, (dir) => {
    const frame = (rows: unknown[]) => zlib.zstdCompressSync(Buffer.from(jl(rows)));
    put(path.join(dir, 'roots', 'dsh', 'sessions', '--G-fx-kid--', `session-${FX.dshImpl}`, 'session.v4.jsonl.zstd'),
      frame([{ type: 'head', id: FX.dshImpl, cwd: 'G:\\fx\\kid', delegationDepth: 1, parentSession: FX.dshLead, agentPreset: 'worker' }]));
  });
  const s = fx.build().snapshot();
  ok(s);
  const kid = players(s)[0]!;
  assert.deepEqual([kid.role, kid.parent, kid.depth, kid.label], ['clone', null, 0, 'worker']);
  assert.equal(s.rules.find((r) => r.id === 'dsh.child.parentSession')!.hits, 0);
});

function advance(hub: VirtualClock, ms: number): void {
  hub.advanceBy(ms);
}

test('a source the limits push out is counted, not empty: places are shared per harness (T1)', (t) => {
  const uuid = (n: number, i: number) => `${String(n).repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const frame = (rows: unknown[]) => zlib.zstdCompressSync(Buffer.from(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`));
  const stamp = (f: string, sec: number) => fs.utimesSync(f, sec, sec);
  const T = BASE / 1000;
  const fx = fixture(t, (dir) => {
    // Claude is busy: 40 transcripts, every one newer than any DSH or Codex session.
    for (let i = 0; i < 40; i++) {
      const f = put(path.join(dir, 'roots', 'claude', 'projects', `G--fx-c${i}`, `${uuid(1, i)}.jsonl`), `${JSON.stringify({ type: 'user', cwd: `G:\fx\c${i}`, message: { content: 'hi' } })}\n`);
      stamp(f, T - i);
    }
    for (let i = 0; i < 30; i++) {
      const id = uuid(2, i);
      const f = put(path.join(dir, 'roots', 'dsh', 'sessions', `--G-fx-d${i}--`, id, 'session.v4.jsonl.zstd'),
        frame([{ type: 'head', version: 4, id, createdAt: BASE, cwd: `G:\fx\d${i}`, isSeeded: false, delegationDepth: 0 }]));
      stamp(f, T - 86_400 - i);
    }
    for (let i = 0; i < 30; i++) {
      const id = uuid(3, i);
      const meta = { timestamp: new Date(BASE).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(BASE).toISOString(), cwd: `G:\\fx\\k${i}`, source: 'exec' } };
      const f = put(path.join(dir, 'roots', 'codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T00-00-00-${id}.jsonl`), `${JSON.stringify(meta)}\n`);
      stamp(f, T - 2 * 86_400 - i);
    }
  });
  const s = fx.build().snapshot();
  ok(s);
  // The listing gives each harness 20 of its 60 places; the 24 principals are 8 per harness.
  const principals = (h: string) => players(s).filter((p) => p.harness === h && p.parent === null).length;
  assert.deepEqual([principals('claude'), principals('dsh'), principals('codex')], [8, 8, 8]);
  assert.deepEqual(s.sources.claude, { state: 'ok', sessions: 40, shown: 8, registry: 0, error: null });
  assert.deepEqual(s.sources.dsh, { state: 'ok', sessions: 30, shown: 8, registry: null, error: null });
  assert.deepEqual(s.sources.codex, { state: 'ok', sessions: 30, shown: 8, registry: null, error: null });
  assert.deepEqual(s.clipped.sessions, { claude: 32, dsh: 22, codex: 22 });
  // The shown DSH sessions are its newest: d0 to d7 (each lane is named after its cwd).
  const dshShown = players(s).filter((p) => p.harness === 'dsh').map((p) => Number(/(\d+)$/.exec(p.label)?.[1])).sort((a, b) => a - b);
  assert.deepEqual(dshShown, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(fx.gate.openHandles(), 0);
});

test('a source that holds no session at all is the only empty one', (t) => {
  const fx = fixture(t, (dir) => {
    const f = put(path.join(dir, 'roots', 'claude', 'projects', 'G--fx-one', `${'1'.repeat(8)}-0000-4000-8000-000000000000.jsonl`), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    fs.utimesSync(f, BASE / 1000, BASE / 1000);
  });
  const s = fx.build().snapshot();
  ok(s);
  assert.deepEqual(s.sources.claude, { state: 'ok', sessions: 1, shown: 1, registry: 0, error: null });
  assert.deepEqual(s.sources.dsh, { state: 'empty', sessions: 0, shown: 0, registry: null, error: null });
  assert.deepEqual(s.sources.codex, { state: 'empty', sessions: 0, shown: 0, registry: null, error: null });
  assert.deepEqual(s.clipped.sessions, { claude: 0, dsh: 0, codex: 0 });
});
