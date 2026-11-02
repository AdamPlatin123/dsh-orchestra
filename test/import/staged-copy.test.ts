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
    new ImportStager({ gate: opts.gate ?? gate, fence: opts.fence ?? fence, limits: opts.limits });
  return { base, claude, orch, imports: path.join(orch, 'imports', 'claude'), transcript, sessionDir, gate, fence, fenceWith, stager };
}

const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const stagesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(STAGE_PREFIX)) : []);

function reason(r: string): (e: unknown) => boolean {
  return (e) => {
    assert.ok(e instanceof ImportCopyError, String(e));
    assert.equal(e.reason, r, e.message);
    return true;
  };
}

/** A gate that forwards to `gate` and runs `onRead` before each readRange. */
function gateWith(gate: ReadGate, onRead: (n: number) => void): CopyGate {
  let n = 0;
  return {
    decide: (p, op) => gate.decide(p, op),
    stat: (p) => gate.stat(p),
    readdir: (p) => gate.readdir(p),
    entries: (p) => gate.entries(p),
    readRange: (p, pos, len) => {
      onRead(n++);
      return gate.readRange(p, pos, len);
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
  assert.equal(path.dirname(stage.dir), fx.imports, 'the stage lies beside the target');
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
  assert.deepEqual(stagesIn(fx.imports), []);
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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);
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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);

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

test('leftover stages beside the target are swept; a live stage of the same stager is not', (t) => {
  const fx = fixture(t);
  put(path.join(fx.imports, '.import-0123456789ab', 'half.jsonl'), 'x');
  put(path.join(fx.imports, 'keep-me', 'x'), 'x');
  const s = fx.stager();
  const first = s.begin(path.join(fx.imports, 'one'));
  assert.equal(first.swept, 1);
  assert.ok(!fs.existsSync(path.join(fx.imports, '.import-0123456789ab')));
  const second = s.begin(path.join(fx.imports, 'two'));
  assert.equal(second.swept, 0);
  assert.ok(fs.existsSync(first.dir), 'a live stage is never swept');
  assert.equal(s.openStages().length, 2);
  // A stage made elsewhere (design §3.0: ORCHESTRA_HOME\tmp) works the same way.
  const tmp = path.join(fx.orch, 'tmp');
  const third = s.begin(path.join(fx.imports, 'three'), { stagingParent: tmp });
  assert.equal(path.dirname(third.dir), tmp);
  third.addFile(fx.transcript, 't.jsonl');
  third.copy();
  third.writeReceipt('imported.json', {});
  assert.equal(third.commit().ok, true);
  first.discard();
  second.discard();
  assert.deepEqual(s.openStages(), []);
  assert.deepEqual(stagesIn(fx.imports), []);
  assert.ok(fs.existsSync(path.join(fx.imports, 'keep-me')));
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
  assert.deepEqual(stagesIn(fx.imports), []);
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
  assert.deepEqual(stagesIn(fx.imports), []);

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
  assert.deepEqual(stagesIn(fx.imports), []);
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
  assert.deepEqual(stagesIn(fx.imports), []);
  assert.equal(treeDigest(fx.claude), before);

  // renameDir never moves a link standing in for the stage.
  const real = path.join(fx.orch, 'real');
  fs.mkdirSync(real);
  junction(fx.base, path.join(fx.orch, 'linked'), real);
  assert.throws(() => fx.fence.renameDir(path.join(fx.orch, 'linked'), path.join(fx.orch, 'moved')), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'link');
});
