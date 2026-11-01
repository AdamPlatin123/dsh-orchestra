// A keys-only sample of real sessions for the stage preview's inferred key paths (0.1 alpha design
// §11 risk 1, plan step 9's sampler idea): for every entry of src/sources/stage.ts's KEYS table, how
// many units carried its event and how many of them had the expected keys. Read-only, through the
// read gate's production policy and peek's limits (the newest 60 sessions, a Claude transcript's last
// 256 KiB, no DSH log past 32 MiB), exactly what the stage reads. It prints counts and nothing else:
// no value, no file name, no path, no project name; tool names and event types only from fixed lists.
// A file the gate refuses or the system will not open is counted as unreadable, and any other failure
// prints its class and code only, never its message (a Node or gate error's message names a path).
//   node scripts/stage-keys-sample.ts [--claude-root <dir>]... [--dsh-root <dir>]...
// Without roots it finds them the way orchestrad's real profile does (src/fs/harness-roots.ts over the
// environment). Scanned like daemon code: it reads real roots (plan step 1).
import * as path from 'node:path';
import type { HarnessRoot, RootFs } from '../src/fs/harness-roots.ts';
import { computeHarnessRoots, globListRoot } from '../src/fs/harness-roots.ts';
import { ReadGate, ReadGateError } from '../src/fs/read-gate.ts';
import { resolveEnv } from '../src/runtime/env.ts';
import { makeRedactor } from '../src/store/redact.ts';
import type { PeekSession } from '../src/sources/peek.ts';
import { eachRecord, listSessions, listSubagents } from '../src/sources/peek.ts';
import type { KeyEntry, KeyTally } from '../src/sources/stage.ts';
import { KEYS, STAGE_LIMITS, claudeDigester, dshDigester, keyEvent, readRegistry, tallyKeys } from '../src/sources/stage.ts';
import { realIo } from '../test/helpers/read-io.ts';

const win = path.win32;

/** Tool names counted by name; every other tool_use counts as other. */
const TOOL_NAMES: readonly string[] = ['Task', 'Agent', 'TodoWrite', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'Bash', 'WebFetch', 'WebSearch'];

/** DSH event types counted: head and the types the KEYS table names (a trailing * groups a family). */
const DSH_TYPES: readonly string[] = ['head', ...new Set(KEYS.filter((e) => e.unit === 'dsh-event' && e.when !== null && 'in' in e.when).flatMap((e) => (e.when as { in: readonly string[] }).in))];

/**
 * Key paths counted beside each entry's own, to show where a key went when the expected one is
 * missing. Constants: their presence is counted, their values are never read out.
 */
const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  'claude.todo': ['input.todos[].activeForm', 'input.todos[].id', 'input.todos[].text'],
  'claude.task': ['input.subagent_type', 'input.name', 'input.model'],
  'claude.task-result': ['toolUseResult.agent_id', 'toolUseResult.subagentId', 'toolUseResult.sessionId', 'toolUseResult.status', 'toolUseResult.content', 'agentId'],
  'claude.subagent-meta': ['subagent_type', 'name', 'prompt', 'spawnDepth'],
  'claude.registry': ['status', 'cwd', 'name', 'statusUpdatedAt'],
  'claude.registry-waiting': ['status'],
  'dsh.child': ['parentId', 'parent', 'origin'],
  'dsh.todo': ['data.todos[].text', 'data.todos[].title', 'data.items', 'data.list'],
  'dsh.goal': ['data.objective', 'data.text', 'data.title', 'data.revision'],
  'dsh.team-member': ['data.id', 'data.sessionId', 'data.member.id', 'data.member.name'],
  'dsh.team-task': ['data.id', 'data.subject', 'data.assignee', 'data.task.id', 'data.task.title'],
  'dsh.catalog': ['data.id', 'data.sessionId', 'data.childSessionId', 'data.entries'],
  'dsh.tool': ['data.tool', 'data.toolName'],
};

/** A bad command line: the one failure whose message is printed whole (it holds only the sampler's own words). */
class UsageError extends Error {}

function usage(why: string): never {
  throw new UsageError(`stage-keys-sample: ${why}\nusage: node scripts/stage-keys-sample.ts [--claude-root <dir>]... [--dsh-root <dir>]...`);
}

/** An error the file system raised (EPERM, EBUSY, EACCES...): its message names the file. */
function isFsError(e: unknown): boolean {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { syscall?: unknown }).syscall === 'string';
}

/** A file the gate refused or the system would not open: counted as unreadable, never printed. */
const unreadable = (e: unknown) => e instanceof ReadGateError || isFsError(e);

function parseArgs(args: readonly string[]): { kind: 'claude' | 'dsh'; path: string }[] {
  const out: { kind: 'claude' | 'dsh'; path: string }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag !== '--claude-root' && flag !== '--dsh-root') usage(`unknown argument ${flag}`);
    if (value === undefined || value.startsWith('--')) usage(`${flag} needs a directory`);
    out.push({ kind: flag === '--claude-root' ? 'claude' : 'dsh', path: win.resolve(value) });
  }
  return out;
}

/** The harness roots orchestrad's real profile reads (main.ts locate()), glob listing through a read gate as launcherRootFs does. */
function realRoots(): HarnessRoot[] {
  const home = process.env.USERPROFILE;
  if (home === undefined || home === '') usage('USERPROFILE is not set, so the home directory is unknown');
  const env = resolveEnv({ home, env: process.env });
  const prefixes: HarnessRoot[] = env.claudeRootCandidates.filter((c) => c.includes('*')).map((p) => globListRoot(p)).map((dir) => ({ kind: 'claude-prefix', path: dir, real: dir }));
  const lister = new ReadGate({ roots: prefixes, io: realIo });
  const rfs: RootFs = {
    realpath: realIo.realpath,
    listDirs(dir) {
      try {
        return lister.subdirs(dir);
      } catch (e) {
        if (e instanceof ReadGateError && e.decision.reason === 'not-found') return [];
        throw e;
      }
    },
  };
  return computeHarnessRoots(env, rfs);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

function hasPath(v: unknown, dotted: string): boolean {
  const segs = dotted.split('.');
  const walk = (x: unknown, i: number): boolean => {
    if (i === segs.length) return x !== undefined && x !== null;
    if (!isObject(x)) return false;
    const seg = segs[i]!;
    if (!seg.endsWith('[]')) return walk(own(x, seg), i + 1);
    const arr = own(x, seg.slice(0, -2));
    return Array.isArray(arr) && arr.every((e) => walk(e, i + 1));
  };
  return walk(v, 0);
}

type Counts = Map<string, number>;
const bump = (m: Counts, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/** Per KEYS entry and per path (its own and the candidates): units with the event, units with the path. */
const pathSeen: Counts = new Map();
function samplePaths(unit: KeyEntry['unit'], v: unknown): void {
  for (const e of KEYS) {
    if (e.unit !== unit || !keyEvent(e, v)) continue;
    for (const p of [...e.paths, ...(CANDIDATES[e.id] ?? [])]) if (hasPath(v, p)) bump(pathSeen, `${e.id} ${p}`);
  }
}

function main(): void {
  const given = parseArgs(process.argv.slice(2));
  const roots: HarnessRoot[] = given.length > 0
    ? given.map((r) => ({ kind: r.kind, path: r.path, real: realIo.realpath(r.path) }))
    : realRoots();
  const gate = new ReadGate({ roots, io: realIo });
  const redactor = makeRedactor({ env: process.env });
  const redact = (text: string) => redactor.redact({ text }).text;
  const tally: KeyTally = {};
  const merge = (t: KeyTally) => {
    for (const [k, v] of Object.entries(t)) {
      const into = (tally[k] ??= { seen: 0, missing: 0 });
      into.seen += v.seen;
      into.missing += v.missing;
    }
  };
  const files: Counts = new Map();
  const tools: Counts = new Map();
  const types: Counts = new Map();
  const skipped = () => bump(files, 'unreadable');

  // Records are handed over as they are parsed and kept by no one, as in the stage builder.
  const read = (s: PeekSession, each: (rec: Record<string, unknown>) => void) => {
    try {
      return eachRecord(gate, s, each);
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped();
      return null;
    }
  };
  const claudeFile = (s: PeekSession, what: string) => {
    const dg = claudeDigester({ redact });
    const taskIds = new Set<string>();
    const r = read(s, (rec) => {
      dg.add(rec);
      const message = own(rec, 'message');
      const content = isObject(message) ? own(message, 'content') : undefined;
      if (!Array.isArray(content)) return;
      let holdsTask = false;
      for (const b of content) {
        if (!isObject(b)) continue;
        if (own(rec, 'type') === 'assistant' && own(b, 'type') === 'tool_use') {
          const name = own(b, 'name');
          bump(tools, typeof name === 'string' && TOOL_NAMES.includes(name) ? name : 'other');
          samplePaths('claude-tool', b);
          if ((name === 'Task' || name === 'Agent') && typeof own(b, 'id') === 'string') taskIds.add(own(b, 'id') as string);
        } else if (own(rec, 'type') === 'user' && own(b, 'type') === 'tool_result' && taskIds.has(String(own(b, 'tool_use_id')))) holdsTask = true;
      }
      if (holdsTask) samplePaths('claude-result', rec);
    });
    if (r === null) return;
    bump(files, what);
    if (r.note !== null) bump(files, `${what} ${r.note}`);
    merge(dg.finish(r.note).keys);
  };

  const listed = listSessions(gate, roots, redact);
  const claude = listed.sessions.filter((s) => s.harness === 'claude');
  for (const s of claude.slice(0, STAGE_LIMITS.principals)) {
    claudeFile(s, 'claude transcripts');
    let subs: ReturnType<typeof listSubagents> = [];
    try {
      subs = listSubagents(gate, s, redact).sort((a, b) => b.jsonl.mtimeMs - a.jsonl.mtimeMs);
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped();
    }
    if (subs.length > STAGE_LIMITS.clonesPerParent) bump(files, 'subagent transcripts past the 16 read', subs.length - STAGE_LIMITS.clonesPerParent);
    for (const sub of subs.slice(0, STAGE_LIMITS.clonesPerParent)) {
      claudeFile(sub.jsonl, 'subagent transcripts');
      if (sub.meta === null) {
        bump(files, 'subagent transcripts without meta');
        continue;
      }
      if (sub.meta.size > STAGE_LIMITS.smallFileBytes) {
        bump(files, 'subagent meta too large');
        continue;
      }
      try {
        const o: unknown = JSON.parse(gate.readRange(sub.meta.file, 0, sub.meta.size).toString('utf8'));
        bump(files, 'subagent meta');
        if (isObject(o)) {
          const t: KeyTally = {};
          tallyKeys(t, 'claude-meta', o);
          merge(t);
          samplePaths('claude-meta', o);
        }
      } catch (e) {
        if (unreadable(e) || e instanceof SyntaxError) skipped();
        else throw e;
      }
    }
  }
  for (const s of listed.sessions.filter((x) => x.harness === 'dsh')) {
    const dg = dshDigester({ redact });
    let headSeen = false;
    const r = read(s, (rec) => {
      dg.add(rec);
      const type = typeof own(rec, 'type') === 'string' ? (own(rec, 'type') as string) : '';
      const group = DSH_TYPES.find((w) => (w.endsWith('*') ? type.startsWith(w.slice(0, -1)) : type === w));
      bump(types, group ?? 'other');
      if (type === 'head' && !headSeen) {
        headSeen = true;
        samplePaths('dsh-head', rec);
      } else if (type !== 'head') samplePaths('dsh-event', rec);
    });
    if (r === null) continue;
    bump(files, 'dsh logs');
    if (r.note !== null) bump(files, `dsh logs ${r.note}`);
    merge(dg.finish(r.note).keys);
  }
  const claudeRoots = roots.filter((r) => r.kind === 'claude');
  const reg = readRegistry(gate, claudeRoots, redact);
  merge(reg.keys);
  bump(files, 'registry sessions', reg.entries.length);
  if (reg.error !== null) skipped();
  // The registry files once more, the way readRegistry reads them, for the per-path counts.
  for (const root of claudeRoots) {
    const dir = win.join(root.path, 'sessions');
    let names: string[] = [];
    try {
      names = gate.readdir(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch (e) {
      if (!unreadable(e)) throw e;
      continue;
    }
    for (const name of names) {
      try {
        const st = gate.stat(win.join(dir, name));
        if (!st.isFile() || Number(st.size) > STAGE_LIMITS.smallFileBytes) continue;
        const o: unknown = JSON.parse(gate.readRange(win.join(dir, name), 0, Number(st.size)).toString('utf8'));
        bump(files, 'registry files');
        samplePaths('claude-registry', o);
      } catch (e) {
        if (unreadable(e) || e instanceof SyntaxError) skipped();
        else throw e;
      }
    }
  }

  const line = (m: Counts, order: readonly string[]) => order.map((k) => `${k} ${m.get(k) ?? 0}`).join(', ');
  console.log('stage-keys-sample: read-only, keys only; counts, never values, names or paths');
  console.log(`roots: claude ${roots.filter((r) => r.kind === 'claude').length}, dsh ${roots.filter((r) => r.kind === 'dsh').length}`);
  console.log(`sessions listed: ${listed.sessions.length} of ${listed.total} (claude ${claude.length}, of them read ${Math.min(claude.length, STAGE_LIMITS.principals)})`);
  console.log(`files: ${[...files.keys()].sort().map((k) => `${k} ${files.get(k)}`).join(', ')}`);
  console.log('KEYS entries: units with the event / with every expected key / missing one; then units with each path');
  for (const e of KEYS) {
    const t = tally[e.id] ?? { seen: 0, missing: 0 };
    const paths = [...e.paths, ...(CANDIDATES[e.id] ?? [])].map((p) => `${e.paths.includes(p) ? '' : '~'}${p} ${pathSeen.get(`${e.id} ${p}`) ?? 0}`);
    console.log(`  ${e.id.padEnd(24)} ${t.seen} / ${t.seen - t.missing} / ${t.missing}   [${paths.join(', ')}]`);
  }
  console.log(`tool_use names: ${line(tools, [...TOOL_NAMES, 'other'])}`);
  console.log(`dsh event types: ${line(types, [...DSH_TYPES, 'other'])}`);
  console.log('(~ marks a candidate path counted beside the expected ones)');
}

/** What a failure may print: its class and a short code, never its message. */
function failure(e: unknown): string {
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  const shownCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? ` ${code}` : '';
  return `stage-keys-sample: failed: ${e instanceof Error ? e.name : typeof e}${shownCode}`;
}

// Rethrown, so the process ends non-zero (the exit code is boot.ts's alone to set), but as an error
// that carries only the line above: no message, path or stack of the original.
try {
  main();
} catch (e) {
  if (e instanceof UsageError) throw e;
  const out = new Error(failure(e));
  out.stack = out.message;
  throw out;
}
