import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { WriteFence, WriteFenceError } from '../../src/fs/write-fence.ts';
import type { WriteIo } from '../../src/fs/write-fence.ts';
import { DEFAULT_IMPORT_LIMITS, ImportCopyError, ImportStager, STAGE_PREFIX } from '../../src/import/staged-copy.ts';
import type { CopyGate, ImportLimits } from '../../src/import/staged-copy.ts';
import { realIo } from '../helpers/read-io.ts';
import { realWriteIo } from '../helpers/write-io.ts';
import { junction, probeJunction, put, treeDigest, withTmp } from '../helpers/tmp.ts';

// Synthetic fixtures only: made-up transcript lines, never a real session.
const SID = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';
const LINES = ['{"type":"user","n":1}', '{"type":"assistant","n":2}', '{"type":"user","n":3}'].map((l) => `${l}\n`).join('');

type Fx = {
  base: string;
  claude: string;
  orch: string;
  imports: string;
  /** the tmp folder of ORCHESTRA_HOME, the stager's staging parent (design §3.0). */
  tmp: string;
  transcript: string;
  sessionDir: string;
  gate: ReadGate;
  fence: WriteFence;
  fenceWith(io: Partial<WriteIo>): WriteFence;
  stager(opts?: { gate?: CopyGate; fence?: WriteFence; limits?: Partial<ImportLimits> }): ImportStager;
};

function fixture(t: TestContext): Fx {
  const base = withTmp(t);
  const home = path.join(base, 'home');
  const claude = path.join(home, '.claude');
  const orch = path.join(home, '.orchestra');
  const project = path.join(claude, 'projects', 'C--work-demo');
  const transcript = put(path.join(project, `${SID}.jsonl`), LINES);
  const sessionDir = path.join(project, SID);
  put(path.join(sessionDir, 'subagents', 'agent-a1.jsonl'), '{"type":"user","sub":1}\n');
  put(path.join(sessionDir, 'subagents', 'deep', 'agent-a2.jsonl'), '{"type":"user","sub":2}\n');
  put(path.join(sessionDir, 'subagents', '.credentials.json'), '{"not":"copied"}');
  fs.mkdirSync(orch, { recursive: true });
  const claudeReal = fs.realpathSync.native(claude);
  const gate = new ReadGate({ roots: [{ kind: 'claude', path: claude, real: claudeReal }], orchestraHome: orch, io: realIo });
  const fenceWith = (io: Partial<WriteIo>) => new WriteFence({ orchestraHome: orch, harnessRoots: [claude], io: { ...realWriteIo, ...io } });
  const fence = fenceWith({});
  const stager = (opts: { gate?: CopyGate; fence?: WriteFence; limits?: Partial<ImportLimits> } = {}) =>
    new ImportStager({ gate: opts.gate ?? gate, fence: opts.fence ?? fence, stagingParent: path.join(orch, 'tmp'), limits: opts.limits });
  return { base, claude, orch, imports: path.join(orch, 'imports', 'claude'), tmp: path.join(orch, 'tmp'), transcript, sessionDir, gate, fence, fenceWith, stager };
}

const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const stagesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(STAGE_PREFIX)) : []);
/** Stages left anywhere a stage can be made: the tmp folder of ORCHESTRA_HOME and beside the target. */
const leftovers = (fx: Fx) => [...stagesIn(fx.tmp), ...stagesIn(fx.imports)];

function reason(r: string): (e: unknown) => boolean {
  return (e) => {
    assert.ok(e instanceof ImportCopyError, String(e));
    assert.equal(e.reason, r, e.message);
    return true;
  };
}

/** A gate that forwards to `gate` and runs `onRead` before each chunk read from an openRead handle. */
function gateWith(gate: ReadGate, onRead: (n: number) => void): CopyGate {
  let n = 0;
  return {
    decide: (p, op) => gate.decide(p, op),
    stat: (p) => gate.stat(p),
    readdir: (p) => gate.readdir(p),
    entries: (p) => gate.entries(p),
    openRead: (p) => {
      const h = gate.openRead(p);
      return {
        path: h.path,
        real: h.real,
        stat: () => h.stat(),
        read: (pos, len) => {
          onRead(n++);
          return h.read(pos, len);
        },
        close: () => h.close(),
      };
    },
  };
}

function snapshot(fx: Fx) {
  const mtimes = [fx.transcript, path.join(fx.sessionDir, 'subagents', 'agent-a1.jsonl')].map((f) => fs.statSync(f).mtimeMs);
  return { digest: treeDigest(fx.claude), mtimes };
}

test('copies through a stage, writes the receipt, commits with one rename; the source is unchanged', (t) => {
  const fx = fixture(t);
  const before = snapshot(fx);
  const target = path.join(fx.imports, 'imp-1');
  const stage = fx.stager().begin(target);
  assert.equal(path.dirname(stage.dir), fx.tmp, 'the stage lies in the tmp folder of ORCHESTRA_HOME (design §3.0), which every start empties');
  assert.match(path.basename(stage.dir), /^\.import-[0-9a-f]{12}$/);
  stage.addFile(fx.transcript, 'transcript.jsonl');
  stage.addTree(path.join(fx.sessionDir, 'subagents'), 'subagents');
  assert.ok(!fs.existsSync(target));
  const report = stage.copy();
  assert.deepEqual(report.files.map((f) => f.rel), ['transcript.jsonl', 'subagents/agent-a1.jsonl', 'subagents/deep/agent-a2.jsonl']);
  assert.deepEqual(report.skipped.map((s) => [s.rel, s.reason]), [['subagents/.credentials.json', 'denied-name']]);
  assert.equal(report.files[0]!.sha256, sha(LINES));
  assert.equal(report.files[0]!.changed, false);
  assert.equal(report.bytes, report.files.reduce((n, f) => n + f.bytes, 0));
  stage.writeReceipt('imported.json', { v: 1, files: report.files.map((f) => f.rel), skipped: report.skipped.map((s) => s.rel) });
  assert.ok(!fs.existsSync(target), 'nothing at the target before the commit');
  assert.deepEqual(stage.commit(), { ok: true, path: target });
  assert.equal(stage.state, 'committed');
  assert.equal(fs.readFileSync(path.join(target, 'transcript.jsonl'), 'utf8'), LINES);
  assert.equal(fs.readFileSync(path.join(target, 'subagents', 'deep', 'agent-a2.jsonl'), 'utf8'), '{"type":"user","sub":2}\n');
  assert.ok(!fs.existsSync(path.join(target, 'subagents', '.credentials.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'imported.json'), 'utf8')).skipped, ['subagents/.credentials.json']);
  assert.deepEqual(leftovers(fx), []);
  assert.deepEqual(snapshot(fx), before, 'source tree and mtimes unchanged');
});

test('a cut copies only [0, cut); chunks smaller than the file still give the same bytes', (t) => {
  const fx = fixture(t);
  const cut = LINES.indexOf('\n') + 1;
  const stage = fx.stager({ limits: { chunkBytes: 7 } }).begin(path.join(fx.imports, 'cut'));
  stage.addFile(fx.transcript, 'a.jsonl', { cut });
  stage.addFile(fx.transcript, 'b.jsonl');
  const r = stage.copy();
  assert.equal(r.files[0]!.bytes, cut);
  assert.equal(r.files[0]!.sha256, sha(LINES.slice(0, cut)));
  stage.writeReceipt('imported.json', {});
  stage.commit();
  assert.equal(fs.readFileSync(path.join(fx.imports, 'cut', 'a.jsonl'), 'utf8'), LINES.slice(0, cut));
  assert.equal(fs.readFileSync(path.join(fx.imports, 'cut', 'b.jsonl'), 'utf8'), LINES);
  assert.throws(() => fx.stager().begin(path.join(fx.imports, 'cut2')).addFile(fx.transcript, 'x', { cut: LINES.length + 1 }), RangeError);
});

test('never overwrites: an existing target is refused up front, one that appears before the commit is left as it was', (t) => {
  const fx = fixture(t);
  const existing = path.join(fx.imports, 'taken');
  put(path.join(existing, 'mine.txt'), 'keep');
  assert.throws(() => fx.stager().begin(existing), reason('target-exists'));
  assert.deepEqual(leftovers(fx), []);

  const late = path.join(fx.imports, 'late');
  const stage = fx.stager().begin(late);
  stage.addFile(fx.transcript, 't.jsonl');
  stage.copy();
  stage.writeReceipt('imported.json', {});
  put(path.join(late, 'mine.txt'), 'keep too');
  assert.throws(() => stage.commit(), reason('target-exists'));
  assert.equal(stage.state, 'discarded');
  assert.deepEqual(fs.readdirSync(late), ['mine.txt']);
  assert.equal(fs.readFileSync(path.join(late, 'mine.txt'), 'utf8'), 'keep too');
  assert.deepEqual(leftovers(fx), []);

  // renameDir itself: an existing target, even an empty directory, is reported and nothing moves.
  const a = path.join(fx.orch, 'a');
  const b = path.join(fx.orch, 'b');
  put(path.join(a, 'f'), '1');
  fs.mkdirSync(b);
  assert.deepEqual(fx.fence.renameDir(a, b), { ok: false, reason: 'exists', from: a, to: b });
  assert.ok(fs.existsSync(path.join(a, 'f')));
});

test('out of bounds: targets, stages, sources and destination names outside their place are refused', (t) => {
  const fx = fixture(t);
  const s = fx.stager();
  assert.throws(() => s.begin(path.join(fx.base, 'elsewhere', 'imp')), reason('bad-name'));
  assert.throws(() => s.begin(path.join(fx.claude, 'imp')), reason('bad-name'));
  assert.throws(() => s.begin(fx.orch), reason('bad-name'));
  assert.throws(() => s.begin(path.join(fx.imports, 'x'), { stagingParent: path.join(fx.imports, 'x', 'in') }), reason('bad-name'));
  assert.ok(!fs.existsSync(path.join(fx.base, 'elsewhere')));

  // Each refusal voids its stage, so every name gets a stage of its own.
  for (const bad of ['../escape.jsonl', 'a/../../b', 'a\\b', '', 'a//b', 'x:stream', 'con', 'nul.txt', 'trail.']) {
    const st = s.begin(path.join(fx.imports, 'imp'));
    assert.throws(() => st.addFile(fx.transcript, bad), reason('bad-name'), bad);
    assert.equal(st.state, 'discarded');
  }

  const st = s.begin(path.join(fx.imports, 'imp'));
  st.addFile(fx.transcript, 'T.jsonl');
  assert.throws(() => st.addFile(fx.transcript, 't.JSONL'), reason('duplicate-entry'));

  // A source outside every gate root: its folder cannot even be judged.
  const outside = put(path.join(fx.base, 'loose', 'x.jsonl'), '{}\n');
  const st2 = s.begin(path.join(fx.imports, 'imp'));
  assert.throws(() => st2.addFile(outside, 'x.jsonl'), reason('source-unreadable'));
  // A file the gate refuses inside a root is skipped, not copied.
  put(path.join(fx.claude, 'settings.json'), '{}');
  const st3 = s.begin(path.join(fx.imports, 'imp'));
  st3.addFile(path.join(fx.claude, 'settings.json'), 'settings.json');
  assert.deepEqual(st3.copy().skipped.map((x) => x.reason), ['not-whitelisted']);
  st3.discard();
  assert.deepEqual(leftovers(fx), []);

  // renameDir: both ends are judged by the fence.
  const a = path.join(fx.orch, 'a');
  fs.mkdirSync(a);
  assert.throws(() => fx.fence.renameDir(a, path.join(fx.base, 'out')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'outside-home');
  assert.throws(() => fx.fence.renameDir(a, path.join(fx.claude, 'in')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'harness-root');
  assert.throws(() => fx.fence.renameDir(path.join(fx.claude, 'projects'), path.join(fx.orch, 'p')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'harness-root');
  assert.throws(() => fx.fence.renameDir(a, path.join(a, 'inner')), RangeError);
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(path.join(fx.claude, 'projects')));
});

test('an abort between entries leaves nothing: no stage, no target', (t) => {
  const fx = fixture(t);
  const ac = new AbortController();
  const target = path.join(fx.imports, 'aborted');
  const gate = gateWith(fx.gate, (n) => {
    if (n === 0) ac.abort('user stopped');
  });
  const stage = fx.stager({ gate }).begin(target, { signal: ac.signal });
  stage.addFile(fx.transcript, 'a.jsonl');
  stage.addTree(path.join(fx.sessionDir, 'subagents'), 'subagents');
  assert.throws(() => stage.copy(), reason('aborted'));
  assert.equal(stage.state, 'discarded');
  assert.ok(!fs.existsSync(target));
  assert.deepEqual(leftovers(fx), []);

  // Aborted before begin: nothing is made at all.
  const done = new AbortController();
  done.abort();
  assert.throws(() => fx.stager().begin(path.join(fx.orch, 'imports', 'dsh', 'x'), { signal: done.signal }), reason('aborted'));
  assert.ok(!fs.existsSync(path.join(fx.orch, 'imports', 'dsh')));

  // Aborted after the receipt: the commit does not happen.
  const late = new AbortController();
  const st = fx.stager().begin(target, { signal: late.signal });
  st.addFile(fx.transcript, 'a.jsonl');
  st.copy();
  st.writeReceipt('imported.json', {});
  late.abort();
  assert.throws(() => st.commit(), reason('aborted'));
  assert.ok(!fs.existsSync(target));
  assert.deepEqual(leftovers(fx), []);
});

test('EPERM on the rename comes back as busy; the stage stays until a retry commits or a discard removes it', (t) => {
  const fx = fixture(t);
  let fails = 1;
  const failing = (code: string) => (from: string, to: string) => {
    // Only the stage's rename fails; the temp-file renames of writeAtomic go through.
    if (fs.lstatSync(from).isDirectory() && fails-- > 0) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    fs.renameSync(from, to);
  };
  const fence = fx.fenceWith({ renameSync: failing('EPERM') });
  const target = path.join(fx.imports, 'busy');
  const stage = fx.stager({ fence }).begin(target);
  stage.addFile(fx.transcript, 't.jsonl');
  stage.copy();
  stage.writeReceipt('imported.json', {});
  assert.deepEqual(stage.commit(), { ok: false, reason: 'busy', code: 'EPERM' });
  assert.equal(stage.state, 'receipt');
  assert.ok(fs.existsSync(path.join(stage.dir, 't.jsonl')));
  assert.ok(!fs.existsSync(target));
  assert.deepEqual(stage.commit(), { ok: true, path: target });
  assert.deepEqual(leftovers(fx), []);

  // Always busy (EBUSY here): the caller gives up and discards; nothing is left.
  fails = Infinity;
  const always = fx.fenceWith({ renameSync: failing('EBUSY') });
  const st = fx.stager({ fence: always }).begin(path.join(fx.imports, 'never'));
  st.addFile(fx.transcript, 't.jsonl');
  st.copy();
  st.writeReceipt('imported.json', {});
  for (let i = 0; i < 5; i++) assert.deepEqual(st.commit(), { ok: false, reason: 'busy', code: 'EBUSY' });
  st.discard();
  assert.ok(!fs.existsSync(path.join(fx.imports, 'never')));
  assert.deepEqual(leftovers(fx), []);

  // Any other rename error is thrown, not turned into busy.
  fails = 1;
  const other = fx.fenceWith({ renameSync: failing('EIO') });
  const a = path.join(fx.orch, 'a');
  fs.mkdirSync(a);
  assert.throws(() => other.renameDir(a, path.join(fx.orch, 'b')), /EIO/);
});

test('renameDir checks where the directory landed: same identity, stage gone', (t) => {
  const fx = fixture(t);
  const a = put(path.join(fx.orch, 'a', 'f'), '1');
  const b = path.join(fx.orch, 'b');
  assert.deepEqual(fx.fence.renameDir(path.dirname(a), b), { ok: true, from: path.dirname(a), to: b });
  assert.equal(fs.readFileSync(path.join(b, 'f'), 'utf8'), '1');
  // A rename that "succeeds" but leaves another directory at the target is caught.
  const c = put(path.join(fx.orch, 'c', 'f'), '2');
  const swapped = fx.fenceWith({
    renameSync: (from, to) => {
      fs.mkdirSync(to);
      void from;
    },
  });
  assert.throws(() => swapped.renameDir(path.dirname(c), path.join(fx.orch, 'd')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'changed-during-open');
  assert.throws(() => fx.fence.renameDir(c, path.join(fx.orch, 'e')), /moves a directory/);
});

test('leftover stages in the staging parent are swept; a live stage of the same stager is not; stagingParent is required', (t) => {
  const fx = fixture(t);
  put(path.join(fx.tmp, '.import-0123456789ab', 'half.jsonl'), 'x');
  put(path.join(fx.tmp, 'keep-me', 'x'), 'x');
  assert.throws(() => new ImportStager({ gate: fx.gate, fence: fx.fence } as never), /stagingParent is required/);
  const s = fx.stager();
  const first = s.begin(path.join(fx.imports, 'one'));
  assert.equal(first.swept, 1);
  assert.ok(!fs.existsSync(path.join(fx.tmp, '.import-0123456789ab')));
  const second = s.begin(path.join(fx.imports, 'two'));
  assert.equal(second.swept, 0);
  assert.ok(fs.existsSync(first.dir), 'a live stage is never swept');
  assert.equal(s.openStages().length, 2);
  // Beside the target (DS-Bot's layout) only when the caller asks for it.
  const third = s.begin(path.join(fx.imports, 'three'), { stagingParent: fx.imports });
  assert.equal(path.dirname(third.dir), fx.imports);
  third.addFile(fx.transcript, 't.jsonl');
  third.copy();
  third.writeReceipt('imported.json', {});
  assert.equal(third.commit().ok, true);
  first.discard();
  second.discard();
  assert.deepEqual(s.openStages(), []);
  assert.deepEqual(leftovers(fx), []);
  assert.ok(fs.existsSync(path.join(fx.tmp, 'keep-me')));
});

test('caps: total bytes, file count and the free space the caller gives', (t) => {
  const fx = fixture(t);
  const small = fx.stager({ limits: { maxBytes: 10 } }).begin(path.join(fx.imports, 'big'));
  assert.throws(() => small.addFile(fx.transcript, 't.jsonl'), reason('import-too-big'));
  assert.equal(small.state, 'discarded');
  const few = fx.stager({ limits: { maxFiles: 2 } }).begin(path.join(fx.imports, 'many'));
  assert.throws(() => few.addTree(path.join(fx.sessionDir, 'subagents'), 'subagents'), reason('too-many-files'));
  const disk = fx.stager().begin(path.join(fx.imports, 'disk'));
  disk.addFile(fx.transcript, 't.jsonl');
  assert.throws(() => disk.copy({ freeBytes: 5 }), reason('import-too-big'));
  assert.deepEqual(leftovers(fx), []);
  assert.equal(DEFAULT_IMPORT_LIMITS.maxBytes, 256 * 1024 * 1024);
  assert.throws(() => fx.stager({ limits: { maxBytes: 0 } }), RangeError);
});

test('a source that changes during its copy voids the import, or is reported when the caller allows it', (t) => {
  const fx = fixture(t);
  const grow = (n: number) => {
    if (n === 0) fs.appendFileSync(fx.transcript, '{"type":"user","n":4}\n');
  };
  const strict = fx.stager({ gate: gateWith(fx.gate, grow), limits: { chunkBytes: 8 } }).begin(path.join(fx.imports, 'strict'));
  strict.addFile(fx.transcript, 't.jsonl');
  assert.throws(() => strict.copy(), reason('source-changed'));
  assert.deepEqual(leftovers(fx), []);

  const cut = fs.statSync(fx.transcript).size;
  const lax = fx.stager({ gate: gateWith(fx.gate, grow) }).begin(path.join(fx.imports, 'lax'));
  lax.addFile(fx.transcript, 't.jsonl', { cut });
  const r = lax.copy({ requireUnchanged: false });
  assert.equal(r.files[0]!.changed, true);
  assert.equal(r.files[0]!.bytes, cut);
  assert.ok(r.files[0]!.after.size > r.files[0]!.before.size);
  lax.discard();

  // Shrunk below the planned length: always void, whatever the caller allows.
  const shrink = fx.stager({ gate: gateWith(fx.gate, (n) => n === 0 && fs.truncateSync(fx.transcript, 3)) }).begin(path.join(fx.imports, 'shrink'));
  shrink.addFile(fx.transcript, 't.jsonl');
  assert.throws(() => shrink.copy({ requireUnchanged: false }), reason('source-changed'));
  assert.deepEqual(leftovers(fx), []);
});

test('calls out of order are refused', (t) => {
  const fx = fixture(t);
  const st = fx.stager().begin(path.join(fx.imports, 'order'));
  assert.throws(() => st.writeReceipt('imported.json', {}), reason('wrong-state'));
  assert.throws(() => st.commit(), reason('wrong-state'));
  st.addFile(fx.transcript, 't.jsonl');
  st.copy();
  assert.throws(() => st.addFile(fx.transcript, 'u.jsonl'), reason('wrong-state'));
  assert.throws(() => st.writeReceipt('t.jsonl', {}), reason('duplicate-entry'));
  const st2 = fx.stager().begin(path.join(fx.imports, 'order2'));
  st2.addFile(fx.transcript, 't.jsonl');
  st2.copy();
  assert.throws(() => st2.writeReceipt('sub/r.json', {}), reason('bad-name'));
  const st3 = fx.stager().begin(path.join(fx.imports, 'order3'));
  st3.addFile(fx.transcript, 't.jsonl');
  st3.copy();
  st3.writeReceipt('imported.json', { v: 1 });
  st3.commit();
  assert.throws(() => st3.discard(), reason('wrong-state'));
});

const jp = probeJunction();
test('a junction in the copied tree, or the tree itself a junction, voids the whole import', { skip: jp.ok ? false : jp.why }, (t) => {
  const fx = fixture(t);
  const sub = path.join(fx.sessionDir, 'subagents');
  junction(fx.base, path.join(sub, 'jumped'), path.join(fx.claude, 'projects'));
  assert.deepEqual(fx.gate.entries(sub).find((e) => e.name === 'jumped'), { name: 'jumped', kind: 'link' });
  const st = fx.stager().begin(path.join(fx.imports, 'j'));
  assert.throws(() => st.addTree(sub, 'subagents'), reason('reparse-point'));
  assert.equal(st.state, 'discarded');

  const other = path.join(fx.claude, 'projects', 'C--work-demo', 'other');
  junction(fx.base, other, sub);
  const before = treeDigest(fx.claude);
  const st2 = fx.stager().begin(path.join(fx.imports, 'j'));
  assert.throws(() => st2.addTree(other, 'subagents'), reason('reparse-point'));
  // A file reached through a junction is refused too.
  const st3 = fx.stager().begin(path.join(fx.imports, 'j'));
  assert.throws(() => st3.addFile(path.join(other, 'agent-a1.jsonl'), 'a.jsonl'), reason('reparse-point'));
  assert.deepEqual(leftovers(fx), []);
  assert.equal(treeDigest(fx.claude), before);

  // renameDir never moves a link standing in for the stage.
  const real = path.join(fx.orch, 'real');
  fs.mkdirSync(real);
  junction(fx.base, path.join(fx.orch, 'linked'), real);
  assert.throws(() => fx.fence.renameDir(path.join(fx.orch, 'linked'), path.join(fx.orch, 'moved')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'link');
});

test('a junction swapped onto the way to a planned file after it was added voids the import, whatever the caller allows', { skip: jp.ok ? false : jp.why }, (t) => {
  const fx = fixture(t);
  for (const requireUnchanged of [true, false]) {
    const st = fx.stager().begin(path.join(fx.imports, `swap-${requireUnchanged}`));
    st.addFile(fx.transcript, 't.jsonl');
    // Between add and copy: the project folder becomes a junction to a decoy holding a file of the same name.
    const project = path.dirname(fx.transcript);
    const moved = `${project}-moved-${requireUnchanged}`;
    const decoy = path.join(fx.claude, 'projects', `C--decoy-${requireUnchanged}`);
    put(path.join(decoy, path.basename(fx.transcript)), '{"type":"user","decoy":true}\n');
    fs.renameSync(project, moved);
    junction(fx.base, project, decoy);
    assert.throws(() => st.copy({ requireUnchanged }), reason('reparse-point'));
    assert.equal(st.state, 'discarded');
    fs.rmdirSync(project);
    fs.renameSync(moved, project);
  }
  assert.deepEqual(leftovers(fx), []);
});

test('another file under the planned name voids the import even when changes are allowed; every chunk comes from the one checked handle', (t) => {
  const fx = fixture(t);
  const st = fx.stager().begin(path.join(fx.imports, 'other-file'));
  st.addFile(fx.transcript, 't.jsonl');
  fs.rmSync(fx.transcript);
  put(fx.transcript, LINES);
  assert.throws(() => st.copy({ requireUnchanged: false }), reason('source-changed'));
  assert.deepEqual(leftovers(fx), []);

  // One openRead per file, however many chunks: the path is not resolved again between them.
  let opens = 0;
  let reads = 0;
  const counting: CopyGate = {
    decide: (p, op) => fx.gate.decide(p, op),
    stat: (p) => fx.gate.stat(p),
    readdir: (p) => fx.gate.readdir(p),
    entries: (p) => fx.gate.entries(p),
    openRead: (p) => {
      opens++;
      const h = fx.gate.openRead(p);
      return { path: h.path, real: h.real, stat: () => h.stat(), read: (pos, len) => (reads++, h.read(pos, len)), close: () => h.close() };
    },
  };
  const many = fx.stager({ gate: counting, limits: { chunkBytes: 4 } }).begin(path.join(fx.imports, 'chunks'));
  many.addFile(fx.transcript, 't.jsonl');
  const r = many.copy();
  assert.equal(opens, 1);
  assert.ok(reads > 3, `${reads} chunk reads`);
  assert.equal(r.files[0]!.sha256, sha(LINES));
  assert.equal(fx.gate.openHandles(), 0, 'the handle is closed');
  many.discard();
});

test('a commit whose rename happened but whose after-checks failed is reported as unverified, not discarded', (t) => {
  const fx = fixture(t);
  const target = path.join(fx.imports, 'landed');
  // The real rename runs, then the landed folder is swapped for another one: renameDir's identity check fails.
  const fence = fx.fenceWith({
    renameSync: (from: string, to: string) => {
      fs.renameSync(from, to);
      if (path.resolve(to) === path.resolve(target)) {
        fs.renameSync(to, `${to}-orig`);
        fs.mkdirSync(to);
      }
    },
  });
  const st = fx.stager({ fence }).begin(target);
  st.addFile(fx.transcript, 't.jsonl');
  st.copy();
  st.writeReceipt('imported.json', { v: 1 });
  assert.throws(() => st.commit(), (e: unknown) => {
    assert.ok(e instanceof ImportCopyError, String(e));
    assert.equal(e.reason, 'commit-unverified');
    assert.ok(e.detail.includes(target), e.detail);
    return true;
  });
  assert.equal(st.state, 'unverified');
  assert.throws(() => st.discard(), reason('wrong-state'));
  assert.ok(fs.existsSync(path.join(`${target}-orig`, 'imported.json')), 'the moved copy is left where the rename put it');
});

// Pins a Windows gap renameDir cannot close (see its doc comment): Node's rename replaces a FILE that
// appears at the target between the existence check and the rename. The single-writer lock is what
// keeps that gap empty; this test keeps the gap visible until a no-replace rename exists.
test('renameDir: a file that appears at the target after the check is replaced on Windows (known gap)', { skip: process.platform === 'win32' ? false : 'Windows rename semantics' }, (t) => {
  const fx = fixture(t);
  const stage = path.join(fx.orch, 'stage-gap');
  put(path.join(stage, 'a.txt'), 'a');
  const target = path.join(fx.orch, 'gap-target');
  const fence = fx.fenceWith({
    renameSync: (from: string, to: string) => {
      if (path.resolve(to) === path.resolve(target)) fs.writeFileSync(to, 'raced in');
      fs.renameSync(from, to);
    },
  });
  const r = fence.renameDir(stage, target);
  assert.equal(r.ok, true);
  assert.ok(fs.statSync(target).isDirectory(), 'the raced-in file is gone, replaced by the stage');
  assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'a');
});
