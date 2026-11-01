// The stage preview's synthetic roots (0.1 alpha design §4, §9): one project, "shop", played by a
// Claude lead with three subagents and a nested one, and a DSH lead with a teammate and a reviewer.
// Every value is made up. The key paths are the inferred ones of src/sources/stage.ts's KEYS table:
// the fixture shows what the stage does with them, not that real sessions carry them.
//
// Writes <dir>\roots\{claude,dsh,codex} (the test profile's layout) with mtimes set relative to
// `baseMs`, so a clock at baseMs + 30 s sees the same ages every run:
// - the lead waits on a permission prompt (registry), its TodoWrite has 1 of 3 checked;
// - a1 (Explore) reported, joined by agentId, written 4 min before baseMs: translucent;
// - a2 (code-reviewer) still running, joined by description: solid, brass;
// - a4 runs under a2 (a Task call of a2's own): the department at depth 2;
// - a3 has no Task call naming it and is 15 min old: a possible orphan, ghost;
// - DSH lead with a goal and a todo list, teammate impl (writes: strings), child reviewer (brass).
// STAGE_CANARY sits in a TodoWrite item, a Task prompt and the DSH goal: none of it may leave.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** A fake Anthropic key: the redactor's sk-ant rule must take it out wherever it appears. */
export const STAGE_CANARY = `sk-ant-api03-${'FAKEcanary0123456789abcdefFAKEcanary0123'}`;

export const FX = {
  claudeSession: '11111111-1111-4111-8111-111111111111',
  dshLead: '22222222-2222-4222-8222-222222222222',
  dshImpl: '33333333-3333-4333-8333-333333333333',
  dshReviewer: '44444444-4444-4444-8444-444444444444',
  claudeProject: 'G--fx-shop',
  dshProject: '--G-fx-shop--',
  cwd: 'G:\\fx\\shop',
} as const;

function put(file: string, content: string | Uint8Array, mtimeMs: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  // Whole seconds: they round-trip through every file system's timestamp exactly.
  const sec = Math.round(mtimeMs / 1000);
  fs.utimesSync(file, sec, sec);
  return file;
}

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const frame = (rows: unknown[]) => zlib.zstdCompressSync(Buffer.from(jsonl(rows)), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

const S = FX.claudeSession;
const base = { sessionId: S, cwd: FX.cwd, isSidechain: false };
const side = (agentId: string) => ({ sessionId: S, cwd: FX.cwd, isSidechain: true, agentId });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/**
 * A snapshot with what differs from run to run fixed: the time fields, the rev, and the session ids
 * (digests of file paths, so of the temp dir), renumbered in order of appearance. What stays is what
 * the golden file pins (test/fixtures/stage-snapshot.json).
 */
export function normalizeSnapshot(snap: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(snap, (k, v) => {
    if (k === 'rev') return '0'.repeat(16);
    if (k === 'observedAt' || k === 'computedMs') return 0;
    if (k === 'ageMs') return v === null ? null : 0;
    if (k === 'session' && typeof v === 'string') {
      if (!ids.has(v)) ids.set(v, (ids.size + 1).toString(16).padStart(20, '0'));
      return ids.get(v);
    }
    return v;
  }));
}

/** Writes the stage fixture under `dir`; returns the roots it made. */
export function writeStageFixture(dir: string, baseMs: number): { claude: string; dsh: string; codex: string } {
  const at = (s: number) => baseMs + s * 1000;
  const roots = { claude: path.join(dir, 'roots', 'claude'), dsh: path.join(dir, 'roots', 'dsh'), codex: path.join(dir, 'roots', 'codex') };
  fs.mkdirSync(roots.codex, { recursive: true });

  put(path.join(roots.claude, 'sessions', '41234.json'), JSON.stringify({
    pid: 41234, sessionId: S, cwd: FX.cwd, kind: 'interactive', entrypoint: 'sdk-cli', version: '2.1.310', name: 'shop',
    status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: at(29), updatedAt: at(29), procStart: 'fx',
  }), at(29));

  const project = path.join(roots.claude, 'projects', FX.claudeProject);
  put(path.join(project, `${S}.jsonl`), jsonl([
    { type: 'user', uuid: 'u1', parentUuid: null, ...base, gitBranch: 'main', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'add checkout' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', ...base, timestamp: '2026-11-01T10:00:02Z', message: { role: 'assistant', content: [toolUse('toolu_todo1', 'TodoWrite', { todos: [
      { content: 'Explore cart code', status: 'completed', activeForm: 'Exploring cart code' },
      { content: 'Implement checkout', status: 'in_progress', activeForm: 'Implementing checkout' },
      { content: `Rotate the key ${STAGE_CANARY}`, status: 'pending', activeForm: 'Rotating the key' },
    ] })] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', ...base, timestamp: '2026-11-01T10:00:03Z', message: { role: 'assistant', content: [
      toolUse('toolu_t1', 'Task', { description: 'Explore cart', prompt: 'Find cart code. Done when files listed.', subagent_type: 'Explore' }),
      toolUse('toolu_t2', 'Task', { description: 'Review diff', prompt: `Review checkout diff; the old key was ${STAGE_CANARY}`, subagent_type: 'code-reviewer' }),
    ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', ...base, timestamp: '2026-11-01T10:00:20Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t1', content: 'cart.ts, cart.test.ts' }] }, toolUseResult: { agentId: 'a1' } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u2', ...base, timestamp: '2026-11-01T10:00:25Z', message: { role: 'assistant', content: [toolUse('toolu_b1', 'Bash', { command: 'npm test' })] } },
  ]), at(25));

  const subs = path.join(project, S, 'subagents');
  const meta = (id: string, agentType: string, description: string, spawnDepth: number) =>
    put(path.join(subs, `agent-${id}.meta.json`), JSON.stringify({ agentType, description, spawnDepth, requestNonInteractive: true }), at(0));
  const agent = (id: string, rows: unknown[], mtime: number) => put(path.join(subs, `agent-${id}.jsonl`), jsonl(rows), mtime);
  meta('a1', 'Explore', 'Explore cart', 1);
  agent('a1', [{ type: 'assistant', uuid: 's1', ...side('a1'), timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', content: [toolUse('toolu_g1', 'Grep', { pattern: 'cart' })] } }], at(-240));
  meta('a2', 'code-reviewer', 'Review diff', 1);
  agent('a2', [
    { type: 'assistant', uuid: 's2', ...side('a2'), timestamp: '2026-11-01T10:00:06Z', message: { role: 'assistant', content: [toolUse('toolu_r1', 'Read', { file_path: 'checkout.ts' })] } },
    { type: 'assistant', uuid: 's3', ...side('a2'), timestamp: '2026-11-01T10:00:08Z', message: { role: 'assistant', content: [toolUse('toolu_t5', 'Task', { description: 'Run checkout tests', prompt: 'Run only the checkout tests and paste failures.', subagent_type: 'general-purpose' })] } },
  ], at(20));
  meta('a4', 'general-purpose', 'Run checkout tests', 2);
  agent('a4', [{ type: 'assistant', uuid: 's4', ...side('a4'), timestamp: '2026-11-01T10:00:10Z', message: { role: 'assistant', content: [toolUse('toolu_b4', 'Bash', { command: 'npm test -- checkout' })] } }], at(24));
  meta('a3', 'Explore', 'Scan legacy coupons', 1);
  agent('a3', [{ type: 'assistant', uuid: 's5', ...side('a3'), timestamp: '2026-11-01T09:45:00Z', message: { role: 'assistant', content: [toolUse('toolu_g3', 'Glob', { pattern: '**/coupon*' })] } }], at(-900));

  const dsh = path.join(roots.dsh, 'sessions', FX.dshProject);
  const head = (id: string, extra: Record<string, unknown>) => ({ type: 'head', version: 4, id, createdAt: baseMs, cwd: FX.cwd, isSeeded: false, ...extra });
  put(path.join(dsh, FX.dshLead, 'session.v4.jsonl.zstd'), Buffer.concat([
    frame([head(FX.dshLead, { delegationDepth: 0 })]),
    frame([
      { type: 'turn/start', seq: 1, time: at(1), data: {} },
      { type: 'goal/change', seq: 2, time: at(2), data: { revision: 1, goal: `Ship checkout; deploy key ${STAGE_CANARY}` } },
      { type: 'todo/write', seq: 3, time: at(3), data: { todos: [{ content: 'Spec checkout', status: 'completed' }, { content: 'Implement', status: 'in_progress' }, { content: 'e2e', status: 'pending' }] } },
      { type: 'tool/call', seq: 4, time: at(4), data: { name: 'spawn_teammate', args: { name: 'impl' } } },
      { type: 'team/member/added', seq: 5, time: at(5), data: { memberId: FX.dshImpl, name: 'impl', status: 'running' } },
    ]),
    frame([
      { type: 'tool/call', seq: 6, time: at(6), data: { name: 'team_task_create', args: { title: 'Implement checkout', owner: 'impl' } } },
      { type: 'team/task/updated', seq: 7, time: at(7), data: { taskId: 't1', title: 'Implement checkout', status: 'in_progress', owner: 'impl', revision: 1 } },
      { type: 'subagent/catalog', seq: 8, time: at(8), data: { childId: FX.dshReviewer, provider: 'spawn', description: 'review diff' } },
      { type: 'approval/decided', seq: 9, time: at(9), data: { decision: 'allow' } },
    ]),
  ]), at(25));
  put(path.join(dsh, `session-${FX.dshImpl}`, 'session.v4.jsonl.zstd'), Buffer.concat([
    frame([head(FX.dshImpl, { delegationDepth: 1, parentSession: FX.dshLead, agentPreset: 'worker' })]),
    frame([{ type: 'tool/call', seq: 1, time: at(9), data: { name: 'edit', args: { path: 'cart.ts' } } }]),
  ]), at(10));
  put(path.join(dsh, `session-${FX.dshReviewer}`, 'session.v4.jsonl.zstd'), Buffer.concat([
    frame([head(FX.dshReviewer, { delegationDepth: 1, parentSession: FX.dshLead, agentPreset: 'reviewer' })]),
    frame([{ type: 'tool/call', seq: 1, time: at(-70), data: { name: 'read', args: { path: 'cart.ts' } } }]),
  ]), at(-60));
  return roots;
}
