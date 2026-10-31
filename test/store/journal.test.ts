import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Param } from '../../src/store/db.ts';
import type { StoreWriter } from '../../src/store/store.ts';
import type { Line, Rec } from '../../src/store/journal.ts';
import { canonicalDigest, canonicalJson, parseCanonical } from '../../src/store/canonical-json.ts';
import { GENESIS, Journal, JournalError, chainHash, scanJournal } from '../../src/store/journal.ts';
import { BODY_SCHEMAS, JOURNAL_KINDS, KINDS, MAX_BATCH } from '../../src/store/records.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { appliedTail, dumpProjection } from '../../src/store/rebuild.ts';
import { Snippets } from '../../src/store/snippets.ts';
import { Store, StoreError, cutMarkerPath } from '../../src/store/store.ts';
import { acquireLock, lockPipeName } from '../../src/runtime/lock.ts';
import { detectFeatures } from '../../src/runtime/features.ts';
import { EXIT } from '../../src/runtime/exit.ts';
import { R, commitRec, digestOf, humanCause, oneOfEach, srcCause, uuidOf } from '../helpers/records.ts';
import { T0, deleteDb, mustOpen, storeFixture } from '../helpers/store.ts';
import { runOrchestrad } from '../helpers/orchestrad.ts';
import { FENCE_OK, captureConsole, minimalEnv, startInProcess, testPorts } from '../helpers/start.ts';
import { withTmp } from '../helpers/tmp.ts';

// Plan step 3, journal.ts: the line format, one fsync per batch, the commit marker, the startup
// reconciliation (torn tail cut and recorded, a break in the middle is journal-chain and exit 22
// with the lock left to the process), a schema per kind checked before the append, and no source
// string outside the four whitelisted ones.

const LINE_KEYS = ['body', 'bootId', 'digest', 'hash', 'jseq', 'kind', 'obsMono', 'obsWall', 'prevHash'];
const linesOf = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
const parsedOf = (file: string): Line[] => linesOf(file).map((l) => JSON.parse(l) as Line);

test('every line is the canonical JSON of the nine fields; digest = sha256(canonical body), hash = sha256(prevHash || digest); each batch ends with its commit and shares one stamp', async (t) => {
  const f = await storeFixture(t);
  const bootId = uuidOf('boot-format');
  const s = mustOpen(f, { bootId }).store;
  s.commit([R.project('prj1', 'C:\\work\\demo'), R.part('p1', { projectId: 'prj1' })]);
  f.clock.advanceBy(250);
  s.commit([R.event('p1', 1), R.cursor('p1', 10, 1)]);
  const texts = linesOf(f.journal);
  assert.equal(texts.length, 6);
  let prev = GENESIS;
  texts.forEach((text, i) => {
    assert.equal(canonicalJson(parseCanonical(text)), text, `line ${i + 1} is canonical`);
    const l = JSON.parse(text) as Line;
    assert.deepEqual(Object.keys(l), LINE_KEYS, 'the canonical order of the nine keys');
    assert.equal(l.jseq, i + 1);
    assert.equal(l.bootId, bootId);
    assert.equal(l.digest, crypto.createHash('sha256').update(canonicalJson(l.body), 'utf8').digest('hex'));
    assert.equal(l.prevHash, prev);
    assert.equal(l.hash, crypto.createHash('sha256').update(prev + l.digest, 'utf8').digest('hex'));
    assert.equal(l.hash, chainHash(prev, l.digest));
    prev = l.hash;
  });
  const lines = parsedOf(f.journal);
  assert.deepEqual(lines.map((l) => l.kind), ['project', 'part', 'commit', 'event', 'part.cursor', 'commit']);
  // The commit body carries the batch's stamps, so the digest chain binds them (journal.ts).
  assert.deepEqual([lines[2]!.body, lines[5]!.body], [{ count: 2, bootId, obsMono: 1000, obsWall: T0 }, { count: 2, bootId, obsMono: 1250, obsWall: T0 + 250 }]);
  assert.deepEqual(lines.map((l) => [l.obsMono, l.obsWall]), [[1000, T0], [1000, T0], [1000, T0], [1250, T0 + 250], [1250, T0 + 250], [1250, T0 + 250]]);
  assert.equal(canonicalDigest({ count: 2, bootId, obsMono: 1000, obsWall: T0 }), lines[2]!.digest);
});

/** A writer that writes `keep` bytes of each batch at most (or every byte, then fails: a crash after the fsync) and then throws, as a crash would. */
function crashingWriter(fence: StoreWriter, mode: { cutAt?: (text: string) => number; afterFsync?: boolean }): StoreWriter {
  return {
    append: (target, data, opts) => {
      const text = String(data);
      if (mode.afterFsync === true) {
        fence.append(target, text, opts);
        throw new Error('crash after the fsync');
      }
      fence.append(target, text.slice(0, mode.cutAt!(text)), opts);
      throw new Error('crash in the middle of the write');
    },
    shorten: (target, length) => fence.shorten(target, length),
    writeAtomic: (target, data) => fence.writeAtomic(target, data),
    rm: (target) => fence.rm(target),
  };
}

test('a torn last line is cut back to the last complete batch through the write fence, a recovered record says how many bytes, and the next start verifies cleanly', async (t) => {
  const f = await storeFixture(t);
  const first = mustOpen(f).store;
  first.commit([R.project('prj1', 'C:\\work\\demo')]);
  const before = fs.statSync(f.journal).size;
  // Half a line: the crash comes in the middle of the first line of the batch.
  const s = mustOpen(f, { writer: crashingWriter(f.fence, { cutAt: (text) => Math.floor(text.indexOf('\n') / 2) }) }).store;
  assert.throws(() => s.commit([R.part('p1')]), (e: unknown) => e instanceof JournalError && e.reason === 'append-failed');
  assert.equal(s.db.get("SELECT count(*) AS n FROM part")!.n, 0, 'the transaction rolled back');
  assert.throws(() => s.commit([R.part('p2')]), (e: unknown) => e instanceof JournalError && e.reason === 'unusable', 'a journal whose append failed takes nothing more');
  s.close();
  const torn = fs.statSync(f.journal).size - before;
  assert.ok(torn > 0 && !fs.readFileSync(f.journal, 'utf8').endsWith('\n'));
  const again = mustOpen(f);
  assert.equal(again.report.cutBytes, torn);
  const text = fs.readFileSync(f.journal, 'utf8');
  assert.ok(text.endsWith('\n'), 'the file ends with a complete line');
  const lines = parsedOf(f.journal);
  assert.deepEqual(lines.slice(-2).map((l) => [l.kind, l.kind === 'commit' ? l.body.count : l.body]), [['recovered', { bytesCut: torn }], ['commit', 1]]);
  const scan = scanJournal(fs.readFileSync(f.journal));
  assert.ok(scan.ok && scan.cutBytes === 0);
  again.store.close();
  const third = mustOpen(f);
  assert.deepEqual(third.report, { cutBytes: 0, appliedBatches: 0, orphansClosed: 0 });
  assert.equal(parsedOf(f.journal).filter((l) => l.kind === 'recovered').length, 1);
});

test('whole lines of a batch whose commit never reached the disk are the uncommitted tail too: cut whole, never applied', async (t) => {
  const f = await storeFixture(t);
  mustOpen(f).store.commit([R.project('prj1', 'C:\\work\\demo')]);
  const s = mustOpen(f, { writer: crashingWriter(f.fence, { cutAt: (text) => text.lastIndexOf('\n', text.length - 2) + 1 }) }).store;
  assert.throws(() => s.commit([R.part('p1'), R.part('p2')]));
  s.close();
  const tail = linesOf(f.journal).slice(-2).map((l) => (JSON.parse(l) as Line).kind);
  assert.deepEqual(tail, ['part', 'part'], 'both records are on disk, their commit is not');
  const again = mustOpen(f);
  assert.ok(again.report.cutBytes > 0);
  assert.equal(again.store.db.get('SELECT count(*) AS n FROM part')!.n, 0);
  assert.deepEqual(parsedOf(f.journal).map((l) => l.kind), ['project', 'commit', 'recovered', 'commit']);
});

test('a crash after the fsync and before the db commit: the next start applies the committed batch', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f, { writer: crashingWriter(f.fence, { afterFsync: true }) }).store;
  assert.throws(() => s.commit([R.project('prj1', 'C:\\work\\demo')]));
  assert.equal(s.db.get('SELECT count(*) AS n FROM project')!.n, 0);
  s.close();
  const again = mustOpen(f);
  assert.deepEqual(again.report, { cutBytes: 0, appliedBatches: 1, orphansClosed: 0 });
  assert.equal(again.store.db.get('SELECT cwd FROM project')?.cwd, 'C:\\work\\demo');
});

/** Builds a store with three batches and returns its journal's lines. */
async function threeBatches(t: Parameters<typeof storeFixture>[0], cwd = 'C:\\work\\demo') {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.project('prj1', cwd, 3)]);
  s.commit([R.part('p1', { projectId: 'prj1' })]);
  s.commit([R.part('p2', { projectId: 'prj1' })]);
  s.close();
  return { f, lines: linesOf(f.journal) };
}

const breakOf = (f: Awaited<ReturnType<typeof storeFixture>>) => {
  let o: ReturnType<typeof f.open>;
  try {
    o = f.open();
  } catch (e) {
    return `threw ${(e as Error).message}`;
  }
  if (o.ok) o.store.close();
  return o.ok ? 'opened' : `${o.break.why}@${o.break.line}`;
};

/** Journal text from scratch, every line chained as the journal would chain it; `recs` include their commit records. */
function chainOf(recs: Rec[], bootId = uuidOf('chain-boot')): string {
  let prev = { jseq: 0, hash: GENESIS };
  return recs.map((r) => {
    const digest = canonicalDigest(r.body);
    const line = { jseq: prev.jseq + 1, bootId, obsMono: 1, obsWall: 2, kind: r.kind, body: r.body, digest, prevHash: prev.hash, hash: chainHash(prev.hash, digest) };
    prev = { jseq: line.jseq, hash: line.hash };
    return `${canonicalJson(line)}\n`;
  }).join('');
}
const commit = (count: number): Rec => commitRec(count, uuidOf('chain-boot'));

/** Rewrites line `i` (from 0) through `edit`, then makes digest and hash fit again from that line on. */
function refit(lines: string[], i: number, edit: (x: Record<string, unknown>) => void): string {
  const out = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  edit(out[i]!);
  for (let k = i; k < out.length; k++) {
    const x = out[k]!;
    if (k > i) x.prevHash = out[k - 1]!.hash;
    x.digest = canonicalDigest(x.body);
    x.hash = chainHash(x.prevHash as string, x.digest as string);
  }
  return out.map((x) => canonicalJson(x)).join('\n') + '\n';
}

test('more breaks: a null line, a tenth key, a bootId or obsWall out of grammar, a kind nobody has, a prevHash rewritten with its hash made to fit', async (t) => {
  const cases: [string, (lines: string[]) => string, string][] = [
    ['a line that is null', (l) => [l[0]!, 'null', ...l.slice(1)].join('\n') + '\n', 'shape@2'],
    ['a tenth key', (l) => refit(l, 1, (x) => { x.extra = 1; }), 'shape@2'],
    ['a bootId that is no UUID', (l) => refit(l, 1, (x) => { x.bootId = 'boot'; }), 'boot-id@2'],
    ['a negative obsWall', (l) => refit(l, 1, (x) => { x.obsWall = -5; }), 'obs@2'],
    ['a kind nobody has', (l) => refit(l, 1, (x) => { x.kind = 'gossip'; }), 'kind@2'],
    ['a prevHash rewritten, its hash made to fit', (l) => {
      const x = JSON.parse(l[1]!) as Record<string, unknown>;
      x.prevHash = 'e'.repeat(64);
      x.hash = chainHash(x.prevHash as string, x.digest as string);
      return refit([l[0]!, canonicalJson(x), ...l.slice(2)], 2, () => {});
    }, 'prev-hash@2'],
  ];
  for (const [what, edit, want] of cases) {
    const { f, lines } = await threeBatches(t);
    deleteDb(f);
    fs.writeFileSync(f.journal, edit(lines));
    assert.equal(breakOf(f), want, what);
  }
});

test('batches in the file: recovered opens a batch of its own, a commit counts its batch, and no batch runs past MAX_BATCH records', async (t) => {
  const f = await storeFixture(t);
  fs.writeFileSync(f.journal, chainOf([R.part('p1'), { kind: 'recovered', body: { bytesCut: 3 } }, commit(2)]));
  assert.equal(breakOf(f), 'recovered-misplaced@2');
  fs.writeFileSync(f.journal, chainOf([R.part('p1'), R.part('p2'), commit(1), R.part('p3'), commit(1)]));
  assert.equal(breakOf(f), 'commit@3');
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => R.part(`p${i}`));
  fs.writeFileSync(f.journal, chainOf([...many, commit(MAX_BATCH)]));
  assert.equal(breakOf(f), `commit@${MAX_BATCH + 1}`);
  // Control: well-formed batches open.
  fs.writeFileSync(f.journal, chainOf([R.part('p1'), commit(1), { kind: 'recovered', body: { bytesCut: 3 } }, commit(1)]));
  assert.equal(breakOf(f), 'opened');
});

test('a bad complete line after the last commit is the uncommitted tail, cut like half a line; before a commit (by its text, even in a torn last line) it is a break', async (t) => {
  const { f, lines } = await threeBatches(t);
  const good = lines.join('\n') + '\n';
  fs.writeFileSync(f.journal, `${good}{"garbage\n`);
  assert.equal(breakOf(f), 'opened');
  assert.deepEqual(parsedOf(f.journal).slice(-2).map((l) => [l.kind, l.kind === 'commit' ? l.body.count : l.body]), [['recovered', { bytesCut: '{"garbage\n'.length }], ['commit', 1]]);
  const second = await threeBatches(t);
  const torn = '{"body":{"count":1},"bootId":"x","digest":"y","hash":"z","jseq":9,"kind":"commit"';
  fs.writeFileSync(second.f.journal, `${second.lines.join('\n')}\n{"garbage\n${torn}`);
  assert.equal(breakOf(second.f), 'opened', 'the commit text in the torn last line commits nothing');
  const third = await threeBatches(t);
  fs.writeFileSync(third.f.journal, `${third.lines.slice(0, 3).join('\n')}\n{"garbage\n${third.lines.slice(3).join('\n')}\n`);
  deleteDb(third.f);
  assert.equal(breakOf(third.f), 'not-canonical@4');
});

test('a break in the middle is the typed result journal-chain, with the line and why: digest, jseq, not canonical, not UTF-8, body, prevHash, hash', async (t) => {
  const cases: [string, (lines: string[]) => string | Buffer, string][] = [
    ['an edited body', (l) => [l[0]!.replace('"hue":3', '"hue":4'), ...l.slice(1)].join('\n') + '\n', 'digest@1'],
    ['a line taken out', (l) => [l[0]!, ...l.slice(2)].join('\n') + '\n', 'jseq@2'],
    ['a space added', (l) => [l[0]!, l[1]!.replace(',', ', '), ...l.slice(2)].join('\n') + '\n', 'not-canonical@2'],
    ['a byte that is no UTF-8', (l) => Buffer.concat([Buffer.from(`${l[0]}\n`), Buffer.from([0xff, 0x0a]), Buffer.from(`${l.slice(1).join('\n')}\n`)]), 'not-utf8@2'],
    ['a hash rewritten', (l) => {
      const x = JSON.parse(l[1]!) as Record<string, unknown>;
      x.hash = 'f'.repeat(64);
      return [l[0]!, canonicalJson(x), ...l.slice(2)].join('\n') + '\n';
    }, 'hash@2'],
    ['a body outside its schema, digest and chain made to fit', (l) => {
      const x = JSON.parse(l[0]!) as { body: Record<string, unknown>; digest: string; hash: string; prevHash: string };
      x.body = { ...x.body, note: 'free text' };
      x.digest = canonicalDigest(x.body);
      x.hash = chainHash(x.prevHash, x.digest);
      return [canonicalJson(x), ...l.slice(1)].join('\n') + '\n';
    }, 'body@1'],
  ];
  for (const [what, edit, want] of cases) {
    const { f, lines } = await threeBatches(t);
    deleteDb(f);
    fs.writeFileSync(f.journal, edit(lines));
    assert.equal(breakOf(f), want, what);
  }
});

test('the database may hold no more than the journal, and the line it holds must be the journal\'s: a lost or replaced journal is journal-chain too', async (t) => {
  const lost = await threeBatches(t);
  fs.rmSync(lost.f.journal);
  assert.equal(breakOf(lost.f), 'db-ahead@1');
  const shorter = await threeBatches(t);
  fs.writeFileSync(shorter.f.journal, shorter.lines.slice(0, 4).join('\n') + '\n');
  assert.equal(breakOf(shorter.f), 'db-ahead@5');
  // Another journal with the same number of lines: the hash the database keeps is not in it. (The
  // chain covers the bodies' digests only, so the other journal differs in a body.)
  const other = await threeBatches(t);
  const swap = await threeBatches(t, 'C:\\work\\other');
  fs.copyFileSync(swap.f.journal, other.f.journal);
  assert.equal(breakOf(other.f), 'db-mismatch@6');
  // Control: the same journal opens.
  assert.equal(breakOf(swap.f), 'opened');
  // The jseq the database holds ends no batch of this journal.
  const odd = await threeBatches(t);
  fs.writeFileSync(odd.f.journal, chainOf([R.project('prj1', 'C:\\work\\demo', 3), commit(1), R.part('p1'), R.part('p2'), commit(2), R.part('p3'), R.part('p4'), commit(2)]));
  assert.equal(breakOf(odd.f), 'db-mismatch@6');
});

test('a batch apply refuses never reaches the journal; the journal stays usable', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1')]);
  const size = fs.statSync(f.journal).size;
  assert.throws(() => s.commit([R.tr('inbox_item', 'nope', 'open', 'seen', srcCause('p1', 1))]), /missing-row/);
  assert.equal(fs.statSync(f.journal).size, size);
  s.commit([R.part('p2')]);
  assert.equal(s.db.get('SELECT count(*) AS n FROM part')!.n, 2);
});

test('a batch is written only after the tail it was prepared on; each commit records commitDoneMono by jseq in the metric side table', async (t) => {
  const f = await storeFixture(t);
  const writes: string[] = [];
  const j = new Journal({
    file: f.journal, writer: { append: (_t, d) => { writes.push(String(d)); } }, bootId: uuidOf('tail'),
    clock: f.clock.port(null), redactor: makeRedactor({ env: {} }), tail: { jseq: 0, hash: GENESIS },
  });
  const a = j.prepare([R.part('p1')]);
  const b = j.prepare([R.part('p2')]);
  j.write(a);
  assert.throws(() => j.write(b), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record' && /prepared after another tail/.test(e.message));
  assert.equal(writes.join('').split('\n').length - 1, 2);
  const s2 = mustOpen(f);
  s2.store.commit([R.part('p3')]);
  f.clock.advanceBy(5);
  s2.store.commit([R.part('p4')]);
  const rows = s2.store.db.all("SELECT jseq, value FROM metric WHERE name = 'commitDoneMono' ORDER BY jseq");
  assert.deepEqual(rows.map((r) => [r.jseq, r.value]), [[2, 1000], [4, 1005]]);
});

test('a store that cannot open is start-failed at the store stage, with the lock released; a working stop closes the database', async (t) => {
  // R3-8: registered before withTmp's cleanup (after-hooks run in order, and a failing one stops the rest),
  // so an in-process orchestrad left running by a failed assertion is stopped before its fixture goes.
  const live: (() => Promise<void>)[] = [];
  t.after(async () => { for (const stop of live) await stop(); });
  const dir = fs.realpathSync.native(withTmp(t));
  const args = ['--test-profile', '--test-dir', dir];
  const base = { argv: args, home: path.join(dir, 'user-home'), env: minimalEnv() };
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, console: captureConsole().port });
  // R3-8: whatever assertion fails below, the in-process orchestrad (its lock pipe) is stopped, so the file ends.
  if (o.mode === 'working') live.push(o.stop);
  assert.equal(o.mode, 'working');
  if (o.mode === 'working') await o.stop();
  const db = path.join(dir, 'orchestra', 'orchestra.db');
  // Closed on stop: Windows refuses to rename an open database (EBUSY).
  let renamed = 'renamed';
  try {
    fs.renameSync(db, `${db}.moved`);
    fs.renameSync(`${db}.moved`, db);
  } catch (e) {
    renamed = String((e as { code?: unknown }).code);
  }
  assert.equal(renamed, 'renamed', 'stop() closed the database');
  const raw = new DatabaseSync(db);
  raw.exec('PRAGMA user_version = 9');
  raw.close();
  const con = captureConsole();
  const failed = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, console: con.port });
  if (failed.mode === 'working') live.push(failed.stop);
  assert.equal(failed.mode, 'start-failed', con.all().join('\n'));
  assert.equal(failed.mode === 'start-failed' ? failed.stage : '', 'store');
  assert.match(con.err.join('\n'), /cannot open the store in .+schema version 9/);
  const lock = await acquireLock(lockPipeName(fs.realpathSync.native(path.join(dir, 'orchestra'))));
  assert.ok(lock.ok);
  if (lock.ok) await lock.lock.release();
});

test('measured in a child: a broken chain prints why and exits with the ui-only code 22, the lock goes with the process, and the next instance gets it; in-process the lock is still held until stop()', async (t) => {
  // R3-8: registered before withTmp's cleanup (after-hooks run in order, and a failing one stops the rest),
  // so an in-process orchestrad left running by a failed assertion is stopped before its fixture goes.
  const live: (() => Promise<void>)[] = [];
  t.after(async () => { for (const stop of live) await stop(); });
  const dir = fs.realpathSync.native(withTmp(t));
  const args = ['--test-profile', '--test-dir', dir];
  const base = { argv: args, home: path.join(dir, 'user-home'), env: minimalEnv(), console: captureConsole().port };
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), base);
  if (o.mode === 'working') live.push(o.stop);
  assert.equal(o.mode, 'working');
  if (o.mode !== 'working') return;
  o.store.commit([R.project('prj1', 'C:\\work\\demo', 3)]);
  o.store.commit([R.part('p1', { projectId: 'prj1' })]);
  await o.stop();
  const home = path.join(dir, 'orchestra');
  const journal = path.join(home, 'journal.jsonl');
  const lines = linesOf(journal);
  fs.writeFileSync(journal, [lines[0]!.replace('"hue":3', '"hue":4'), ...lines.slice(1)].join('\n') + '\n');

  const r = runOrchestrad(args, { cwd: dir });
  assert.equal(r.status, EXIT.uiOnly, r.stderr);
  assert.match(r.stderr, /^orchestrad: the journal is broken at line 1 \(digest: digest is not sha256 of the canonical body\); not working, exiting with the ui-only code 22$/m);
  assert.doesNotMatch(r.stdout, /orchestrad: working/);
  const pipe = lockPipeName(fs.realpathSync.native(home));
  const next = await acquireLock(pipe);
  assert.ok(next.ok, 'the next instance gets the lock');
  if (next.ok) await next.lock.release();

  // In-process the outcome leaves the lock held: no release by hand while the process lives on.
  const con = captureConsole();
  const c = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), { ...base, console: con.port });
  if (c.mode === 'journal-chain' || c.mode === 'working') live.push(c.stop);
  assert.equal(c.mode, 'journal-chain', con.all().join('\n'));
  if (c.mode !== 'journal-chain') return;
  assert.equal(c.code, EXIT.uiOnly);
  assert.deepEqual({ line: c.break.line, why: c.break.why }, { line: 1, why: 'digest' });
  const held = await acquireLock(pipe);
  assert.equal(held.ok, false, 'the in-process outcome did not release the lock');
  if (held.ok) await held.lock.release();
  else assert.equal(held.reason, 'held');
  await c.stop();
  const after = await acquireLock(pipe);
  assert.ok(after.ok, 'IN_PROCESS_STOP released it');
  if (after.ok) await after.lock.release();
});

test('a schema per kind: every kind has one, one valid body of each appends and applies, and the journal\'s own kinds are refused to callers', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const batches = oneOfEach();
  const covered = new Set(batches.flat().map((r) => r.kind));
  assert.deepEqual([...covered, ...JOURNAL_KINDS].sort(), [...KINDS].sort(), 'oneOfEach covers every kind a caller appends');
  assert.deepEqual([...KINDS].sort(), Object.keys(BODY_SCHEMAS).sort());
  for (const b of batches) s.commit(b);
  assert.equal(s.tail.jseq, batches.reduce((n, b) => n + b.length + 1, 0));
  for (const k of JOURNAL_KINDS) {
    assert.throws(() => s.commit([{ kind: k, body: k === 'commit' ? { count: 1 } : { bytesCut: 1 } } as Rec]), (e: unknown) => e instanceof JournalError && e.reason === 'journal-kind', k);
  }
  assert.throws(() => s.commit([]), (e: unknown) => e instanceof JournalError && e.reason === 'batch-size');
});

test('a body outside its schema is refused before the append and nothing reaches the file: extra keys, missing keys, wrong types, unknown enums, free text in an id', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1')]);
  const size = fs.statSync(f.journal).size;
  const a = uuidOf('schema');
  const bad: [string, Rec][] = [
    ['extra key', { kind: 'event', body: { ...R.event('p1', 1).body, note: 'hello' } }],
    ['missing key', { kind: 'event', body: Object.fromEntries(Object.entries(R.event('p1', 1).body).filter(([k]) => k !== 'snippetRef')) }],
    ['free text as an id', { kind: 'event', body: { ...R.event('p1', 1).body, partRef: 'C:\\some dir\\x' } }],
    ['free text as a snippetRef', { kind: 'event', body: { ...R.event('p1', 1).body, snippetRef: 'the source said hello' } }],
    ['a fraction', { kind: 'part.cursor', body: { partRef: 'p1', cursor: 1.5, srcSeq: 1 } }],
    ['a number as a string', { kind: 'part.cursor', body: { partRef: 'p1', cursor: '1', srcSeq: 1 } }],
    ['an unknown enum', { kind: 'part', body: { ...R.part('p9').body, harness: 'vim' } }],
    ['srcTime without its precision', { kind: 'event', body: { ...R.event('p1', 1).body, srcTime: 5, srcTimePrecision: 'none' } }],
    ['a verb nobody has', R.human(a, 'format-disk')],
    ['an actionId that is no UUID', R.human('not-a-uuid', 'seen')],
    ['an outcome outside the enum', R.result(a, 'seen', 'i1', 'done')],
    ['a poll timer in a clock record', R.clock('poll:p1:0', 'mono', 1, 1, 1)],
    ['a plan whose ttl is not 60 s', { kind: 'brake.plan', body: { ...R.plan('plan1', 1, 2).body, ttlMs: 90_000 } }],
    ['a createTime of 0', R.protect('add', 4, '0')],
    ['a brake status that hides an unknown subtree', R.command('cmd1', a, [{ root: { pid: 5, createTime: '13' }, requestId: 'r1', killed: 0, residual: 0, status: 'unknown' }], 'ok')],
    ['a refused subtree that killed something', R.command('cmd1', a, [{ root: { pid: 5, createTime: '13' }, requestId: 'r1', killed: 1, residual: 0, status: 'refused' }], 'refused')],
    ['an accessor', { kind: 'part.cursor', body: Object.defineProperty({ partRef: 'p1', srcSeq: 1 }, 'cursor', { get: () => 1, enumerable: true }) }],
    ['a class instance', { kind: 'snooze', body: Object.assign(Object.create({ x: 1 }) as Record<string, unknown>, { itemId: 'i1', untilWall: 1 }) }],
  ];
  for (const [what, rec] of bad) {
    assert.throws(() => s.commit([rec]), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record', what);
  }
  assert.equal(fs.statSync(f.journal).size, size, 'nothing was written');
  assert.ok(s.usable, 'a refused body is no failed append');
});

test('source strings: only cwd, version, tool name and error code, each in its grammar and unchanged by redact.ts; anything else is refused, and the startup scan never re-runs the redactor', async (t) => {
  const f = await storeFixture(t);
  const env = { MY_TOKEN: 'abcdefghij1234567890' };
  const s = mustOpen(f, { env }).store;
  s.commit([R.part('p1')]);
  const refused = (rec: Rec) => {
    try {
      s.commit([rec]);
      return 'appended';
    } catch (e) {
      return e instanceof JournalError ? (/ (\S+) at /.exec(e.message)?.[1] ?? e.reason) : String(e);
    }
  };
  assert.equal(refused(R.event('p1', 1, { tool: 'rm -rf /' })), 'grammar');
  assert.equal(refused(R.event('p1', 1, { tool: 'Zk8q3Xv9Lm2Pw7Rt5Yb1Qd' })), 'redacted', 'a high-entropy tool name');
  assert.equal(refused(R.event('p1', 1, { errorCode: 'bad thing happened' })), 'grammar');
  assert.equal(refused(R.part('p2', { version: 'v1.2' })), 'grammar');
  assert.equal(refused(R.part('p2', { version: '1.2.3\u202e' })), 'grammar');
  assert.equal(refused(R.part('p2', { cwd: 'work\\demo' })), 'grammar', 'a relative cwd');
  assert.equal(refused(R.part('p2', { cwd: `C:\\${'x'.repeat(130)}` })), 'too-long');
  assert.equal(refused(R.part('p2', { cwd: 'C:\\work\\a\u0007b' })), 'grammar');
  assert.equal(refused(R.part('p2', { cwd: 'C:\\work\\abcdefghij1234567890' })), 'redacted', 'a cwd holding a value of the environment');
  assert.equal(refused(R.project('prj2', 'C:\\Users\\x\\token=sk-ant-abcdefghijk')), 'redacted', 'a cwd with a key=value secret in a segment');
  // Control: the same kinds with good strings append, a profile path among them.
  assert.equal(refused(R.part('p3', { cwd: 'C:\\Users\\Calx\\proj', version: '2.1.4-beta.1' })), 'appended');
  assert.equal(refused(R.event('p1', 2, { tool: 'mcp__srv__tool.x', errorCode: 'ERR_TIMEOUT' })), 'appended');
  s.close();
  // A line appended under one environment opens under any other: the scan checks grammar only.
  const other = mustOpen(f, { env: { OTHER: 'C:\\Users\\Calx\\proj'.slice(3) } });
  assert.equal(other.report.cutBytes, 0);
});

test('a brake leaves its human without a result until the Command answers: the next start closes the orphan with outcome unknown, once', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const brake = uuidOf('orphan-brake');
  const seen = uuidOf('orphan-seen');
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  s.commit([R.tr('inbox_item', 'i1', 'open', 'seen', humanCause(seen)), R.human(seen, 'seen', 'i1'), R.result(seen, 'seen', 'i1')]);
  s.commit([R.human(brake, 'brake', '101:133000000000000001')]);
  assert.deepEqual(s.orphanActions(), [brake]);
  s.close();
  const again = mustOpen(f);
  assert.equal(again.report.orphansClosed, 1);
  const last = parsedOf(f.journal).slice(-2);
  assert.deepEqual(last.map((l) => [l.kind, l.kind === 'commit' ? l.body.count : l.body]), [
    ['human.result', { actionId: brake, verb: 'brake', targetId: '101:133000000000000001', outcome: 'unknown', commandId: null, subtrees: null }], ['commit', 1],
  ]);
  again.store.close();
  assert.equal(mustOpen(f).report.orphansClosed, 0);
});

test('a line the journal would not read back is never written: a clock reading below zero is refused before the write', () => {
  const writes: string[] = [];
  const j = new Journal({
    file: 'C:\\x\\journal.jsonl', writer: { append: (_t, d) => { writes.push(String(d)); } }, bootId: uuidOf('readback'),
    clock: { nowMono: () => -1, nowWall: () => 0 }, redactor: makeRedactor({ env: {} }), tail: { jseq: 0, hash: GENESIS },
  });
  assert.throws(() => j.write(j.prepare([R.part('p1')])), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record' && /obs/.test(e.message));
  assert.deepEqual(writes, []);
  assert.equal(j.tail.jseq, 0);
});

test('the journal takes nothing by default: writer, clock, redactor, bootId and tail are required', () => {
  const ok = { file: 'C:\\x\\journal.jsonl', writer: { append: () => {} }, bootId: uuidOf('cfg'), clock: { nowMono: () => 0, nowWall: () => 0 }, redactor: makeRedactor({ env: {} }), tail: { jseq: 0, hash: GENESIS } };
  assert.ok(new Journal(ok));
  for (const k of ['writer', 'clock', 'redactor', 'bootId', 'tail', 'file'] as const) {
    const without = Object.fromEntries(Object.entries(ok).filter(([key]) => key !== k));
    assert.throws(() => new Journal(without as never), JournalError, k);
  }
  const proto = Object.create({ writer: ok.writer, clock: ok.clock, redactor: ok.redactor }) as Record<string, unknown>;
  Object.assign(proto, { file: ok.file, bootId: ok.bootId, tail: ok.tail });
  assert.throws(() => new Journal(proto as never), JournalError, 'fields on the prototype are not read');
});

const REPLAY_GOLDEN = '21cf03ebc37246ff6dd3dc655fa8b110308742d825b9c9d8e70a65d56bd7cd66';

test('replay is deterministic: the same records, bootId and clock give byte-identical journals and identical projections', async (t) => {
  const runs: { journal: string; dump: unknown }[] = [];
  for (let i = 0; i < 2; i++) {
    const f = await storeFixture(t);
    const s = mustOpen(f, { bootId: uuidOf('det') }).store;
    for (const b of oneOfEach()) {
      s.commit(b);
      f.clock.advanceBy(17);
    }
    runs.push({ journal: fs.readFileSync(f.journal, 'utf8').split(f.home).join('<H>'), dump: dumpProjection(s.db) });
  }
  assert.equal(runs[0]!.journal, runs[1]!.journal);
  assert.deepEqual(runs[0]!.dump, runs[1]!.dump);
  // R3-12: a golden, so nondeterminism constant within one process (locale, insertion order) or any
  // change of the line format shows up too. Update it on purpose with a deliberate format change.
  assert.equal(digestOf(runs[0]!.journal), REPLAY_GOLDEN);
});

// --- step 3 fixes -------------------------------------------------------------------------------

test('S1/R2-F: a body is read once; a Proxy that answers the redaction check one way and the write another never gets the other value into the journal or the db', async (t) => {
  const f = await storeFixture(t);
  const secret = 'Zx9QwErTy7';
  const s = mustOpen(f, { env: { MY_TOKEN: secret } }).store;
  assert.throws(() => s.commit([R.project('prjA', `C:\\work\\${secret}`)]), (e: unknown) => e instanceof JournalError && /redacted/.test(e.message), 'the baseline is refused');
  let n = 0;
  const body = new Proxy({ projectId: 'prjB', cwd: 'C:\\work\\safe', hue: 1 }, {
    getOwnPropertyDescriptor(target, k) {
      const d = Reflect.getOwnPropertyDescriptor(target, k);
      return k === 'cwd' && d !== undefined ? { ...d, value: n++ === 0 ? 'C:\\work\\safe' : `C:\\work\\${secret}` } : d;
    },
  });
  // The snapshot is what is checked and what is written: one value, so the commit takes the clean one.
  assert.doesNotThrow(() => s.commit([{ kind: 'project', body }]));
  assert.ok(n >= 1, 'the trap ran');
  assert.ok(!fs.readFileSync(f.journal, 'utf8').includes(secret), 'the journal holds the value that was checked');
  assert.equal(s.db.get('SELECT cwd FROM project WHERE id = ?', 'prjB')!.cwd, 'C:\\work\\safe');
  // A getter anywhere in the body, nested too, is refused before anything is read twice.
  const nested = { ...R.plan('plan9', 1000, T0).body, harness: Object.defineProperty({ createTime: '133000000000000000' }, 'pid', { get: () => 100, enumerable: true }) };
  assert.throws(() => s.commit([{ kind: 'brake.plan', body: nested }]), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record');
});

test('S3: a record\'s kind is read once as an own data field: a getter that answers project, then recovered, is refused', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.part('p1')]);
  const size = fs.statSync(f.journal).size;
  let n = 0;
  const forged = { get kind() { return n++ === 0 ? 'project' : 'recovered'; }, body: { bytesCut: 999999 } };
  assert.throws(() => s.commit([forged as unknown as Rec]), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record');
  assert.equal(fs.statSync(f.journal).size, size);
  assert.equal(parsedOf(f.journal).filter((l) => l.kind === 'recovered').length, 0);
  // A kind inherited from a prototype is no kind of the record's own.
  const inherited = Object.assign(Object.create({ kind: 'part' }) as Record<string, unknown>, { body: R.part('p9').body });
  assert.throws(() => s.commit([inherited as unknown as Rec]), (e: unknown) => e instanceof JournalError && e.reason === 'bad-record');
  assert.equal(fs.statSync(f.journal).size, size);
});

test('S2: Store.commit is the one writer: the store hands out no Journal, and the Journal has no append', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  assert.equal('journal' in s, false);
  assert.equal(typeof (Journal.prototype as unknown as Record<string, unknown>).append, 'undefined');
  assert.equal(s.tail.jseq, 0);
  assert.equal(s.usable, true);
  // What apply sees is frozen: a prepared line cannot be changed between the check and the write.
  const j = new Journal({ file: f.journal, writer: { append: () => {} }, bootId: uuidOf('frozen'), clock: f.clock.port(null), redactor: makeRedactor({ env: {} }), tail: s.tail });
  const p = j.prepare([R.part('p1')]);
  assert.throws(() => { (p.lines[0]!.body as Record<string, unknown>).partRef = 'p2'; }, TypeError);
  assert.throws(() => { (p.lines as Line[]).push(p.lines[0]!); }, TypeError);
});

test('S7/R2-G: a batch\'s stamps are bound by its commit body: rewriting a line\'s obsWall or bootId, or every line\'s, is journal-chain (stamp)', async (t) => {
  const edits: [string, (x: Record<string, unknown>, i: number) => void][] = [
    ['a record line\'s obsWall back 30 days', (x, i) => { if (i === 0) x.obsWall = (x.obsWall as number) - 30 * 86_400_000; }],
    ['a record line\'s bootId', (x, i) => { if (i === 0) x.bootId = uuidOf('other-boot'); }],
    ['every line\'s obsWall, the commit body left', (x) => { x.obsWall = (x.obsWall as number) + 86_400_000; }],
  ];
  for (const [what, edit] of edits) {
    const f = await storeFixture(t);
    const s = mustOpen(f).store;
    s.commit([R.project('prj1', 'C:\\work\\demo'), R.part('p1')]);
    s.close();
    const lines = linesOf(f.journal).map((l) => JSON.parse(l) as Record<string, unknown>);
    lines.forEach((x, i) => edit(x, i));
    fs.writeFileSync(f.journal, lines.map((x) => canonicalJson(x)).join('\n') + '\n');
    deleteDb(f);
    assert.match(breakOf(f), /^stamp@/, what);
  }
});

test('S9: a cwd follows the cwd-tail grammar\'s character rules in the journal too: no bidi, zero-width, line or paragraph separator', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  for (const cwd of ['C:\\work\\\u202eexe.txt', 'C:\\work\\a\u200bb', 'C:\\work\\a\u2028b', 'C:\\work\\a\u2029b', 'C:\\work\\a\u2066b']) {
    assert.throws(() => s.commit([{ kind: 'project', body: { projectId: 'prjG', cwd, hue: 0 } }]), (e: unknown) => e instanceof JournalError && / grammar at \$\.cwd/.test(e.message), JSON.stringify(cwd));
  }
  s.commit([R.project('prjG', 'C:\\work\\项目 one')]);
});

/** A wrapper around the real db whose transaction fails after its body ran (COMMIT failing), once; or whose metric insert throws. */
function faultyDb(db: Db, mode: 'commit' | 'metric'): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, k) {
      if (k === 'transaction' && mode === 'commit') {
        return <T>(fn: () => T): T => target.transaction(() => {
          const out = fn();
          if (armed) {
            armed = false;
            throw new Error('SQLITE_FULL at COMMIT');
          }
          return out;
        });
      }
      if (k === 'run' && mode === 'metric') {
        return (sql: string, ...p: Param[]) => {
          if (sql.startsWith('INSERT INTO metric')) throw new Error('SQLITE_FULL');
          return target.run(sql, ...p);
        };
      }
      const v = Reflect.get(target, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function scanTail(file: string): { jseq: number; hash: string } {
  const r = scanJournal(fs.existsSync(file) ? fs.readFileSync(file) : new Uint8Array(0));
  if (!r.ok) throw new Error('scan failed');
  return r.tail;
}

test('R2-B: a batch whose db transaction fails after the fsync is committed-not-applied and the store takes nothing more; the restart applies it. A failed metric row never fails a commit', async (t) => {
  const f = await storeFixture(t);
  const clock = f.clock.port(null);
  const journal = () => new Journal({ file: f.journal, writer: f.fence, bootId: uuidOf('r2b'), clock, redactor: makeRedactor({ env: {} }), tail: scanTail(f.journal) });
  const db = f.track(f.opener.open(f.db));
  const store = new Store(faultyDb(db, 'commit'), journal(), new Snippets({ db, redactor: makeRedactor({ env: {} }), clock }), clock);
  assert.throws(() => store.commit([R.project('prj1', 'C:\\work\\demo')]), (e: unknown) => e instanceof StoreError && e.reason === 'committed-not-applied' && e.jseq === 2);
  assert.equal(scanTail(f.journal).jseq, 2, 'the batch is in the journal');
  assert.equal(db.get('SELECT count(*) AS n FROM project')!.n, 0);
  assert.equal(store.usable, false);
  assert.throws(() => store.commit([R.part('p1')]), (e: unknown) => e instanceof StoreError && e.reason === 'unusable');
  db.close();
  const again = mustOpen(f);
  assert.equal(again.report.appliedBatches, 1);
  assert.equal(again.store.db.get('SELECT cwd FROM project')!.cwd, 'C:\\work\\demo');
  again.store.close();
  // B2: the commitDoneMono row fails; the commit still returns, and the failure is counted.
  const db2 = f.track(f.opener.open(f.db));
  const s2 = new Store(faultyDb(db2, 'metric'), journal(), new Snippets({ db: db2, redactor: makeRedactor({ env: {} }), clock }), clock);
  let lines: readonly Line[] = [];
  assert.doesNotThrow(() => { lines = s2.commit([R.part('p2')]); }, 'a side-table failure is no failed commit');
  assert.equal(lines.at(-1)!.jseq, 4);
  assert.equal(s2.metricFailures, 1);
  assert.equal(db2.get('SELECT count(*) AS n FROM part')!.n, 1);
  assert.equal(appliedTail(db2).jseq, 4);
});

test('R2-E: a human action reaches the journal once: commit refuses a second human or human.result of an actionId the db holds, before the append', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  const a = uuidOf('dup-at-append');
  s.commit([R.event('p1', 1), R.item('i1'), R.tr('inbox_item', 'i1', 'none', 'open', srcCause('p1', 1))]);
  s.commit([R.tr('inbox_item', 'i1', 'open', 'seen', humanCause(a)), R.human(a, 'seen', 'i1'), R.result(a, 'seen', 'i1')]);
  const size = fs.statSync(f.journal).size;
  assert.throws(() => s.commit([R.human(a, 'seen', 'i1'), R.result(a, 'seen', 'i1')]), (e: unknown) => e instanceof StoreError && e.reason === 'duplicate-action');
  assert.equal(fs.statSync(f.journal).size, size);
  assert.equal(s.usable, true);
});

test('R2-A: a garbled line inside the final batch, whose commit line ends the file and which the db never applied, is an unacknowledged write: cut and recorded', async (t) => {
  const f = await storeFixture(t);
  const s = mustOpen(f).store;
  s.commit([R.project('prj1', 'C:\\work\\demo')]);
  const tail = s.tail;
  s.close();
  const j = new Journal({ file: f.journal, writer: { append: () => {} }, bootId: uuidOf('torn'), clock: f.clock.port(null), redactor: makeRedactor({ env: {} }), tail });
  const text = j.prepare([R.part('p1'), R.part('p2')]).text;
  const nl = text.indexOf('\n');
  const garbled = '\0'.repeat(nl) + text.slice(nl);
  fs.appendFileSync(f.journal, garbled);
  const opened = f.open();
  assert.equal(opened.ok ? 'opened' : `${opened.break.why}@${opened.break.line}`, 'opened', 'the unacknowledged batch is cut, not a break');
  if (!opened.ok) return;
  const o = opened;
  assert.equal(o.report.cutBytes, Buffer.byteLength(garbled));
  assert.equal(o.store.db.get('SELECT count(*) AS n FROM part')!.n, 0);
  assert.deepEqual(parsedOf(f.journal).slice(-2).map((l) => l.kind), ['recovered', 'commit']);
  o.store.close();
  // A complete batch after it: the bad line is no tail, it is a break.
  const g = await storeFixture(t);
  const s2 = mustOpen(g).store;
  s2.commit([R.project('prj1', 'C:\\work\\demo')]);
  const tail2 = s2.tail;
  s2.close();
  const j2 = new Journal({ file: g.journal, writer: { append: () => {} }, bootId: uuidOf('torn2'), clock: g.clock.port(null), redactor: makeRedactor({ env: {} }), tail: tail2 });
  const p1 = j2.prepare([R.part('p1'), R.part('p2')]);
  j2.write(p1);
  const p2 = j2.prepare([R.part('p3')]);
  const n1 = p1.text.indexOf('\n');
  fs.appendFileSync(g.journal, '\0'.repeat(n1) + p1.text.slice(n1) + p2.text);
  assert.equal(breakOf(g), 'not-canonical@3');
  // The final batch garbled after the db applied it: never cut.
  const h = await storeFixture(t);
  const s3 = mustOpen(h).store;
  s3.commit([R.project('prj1', 'C:\\work\\demo')]);
  s3.commit([R.part('p1'), R.part('p2')]);
  s3.close();
  const lines = linesOf(h.journal);
  lines[2] = '\0'.repeat(lines[2]!.length);
  fs.writeFileSync(h.journal, lines.join('\n') + '\n');
  assert.equal(breakOf(h), 'not-canonical@3');
});

/** A writer that passes the fence through, except where `fail` says. */
function failingWriter(fence: StoreWriter, fail: { append?: (text: string) => number | 'throw'; rm?: boolean }): StoreWriter {
  return {
    append: (target, data, opts) => {
      const text = String(data);
      const r = fail.append?.(text);
      if (r === undefined) {
        fence.append(target, text, opts);
        return;
      }
      if (r !== 'throw') fence.append(target, text.slice(0, r), opts);
      throw new Error('crash in the recovered append');
    },
    shorten: (target, length) => fence.shorten(target, length),
    writeAtomic: (target, data) => fence.writeAtomic(target, data),
    rm: (target) => {
      if (fail.rm === true) throw new Error('crash before the marker went');
      return fence.rm(target);
    },
  };
}

test('R2-C: the cut is announced before it is made, so a crash after the cut, or in the recovered append, still records the original bytes cut, once', async (t) => {
  const torn = '{"body":{"partRef":"p';
  const cases: [string, { append?: (text: string) => number | 'throw' }][] = [
    ['a crash after the cut, before the recovered append', { append: () => 'throw' }],
    ['a crash part-way through the recovered append', { append: () => 30 }],
  ];
  for (const [what, fail] of cases) {
    const f = await storeFixture(t);
    mustOpen(f).store.commit([R.project('prj1', 'C:\\work\\demo')]);
    fs.appendFileSync(f.journal, torn);
    assert.throws(() => f.open({ writer: failingWriter(f.fence, fail) }), JournalError, what);
    assert.ok(fs.existsSync(cutMarkerPath(f.home)), `${what}: the marker outlives the crash`);
    const again = mustOpen(f);
    assert.equal(again.report.cutBytes, torn.length, what);
    assert.deepEqual(parsedOf(f.journal).filter((l) => l.kind === 'recovered').map((l) => l.body), [{ bytesCut: torn.length }], what);
    assert.equal(fs.existsSync(cutMarkerPath(f.home)), false, `${what}: the marker is gone once recorded`);
    again.store.close();
    assert.equal(mustOpen(f).report.cutBytes, 0);
  }
  // A crash after the recovered batch committed, before the marker went: the next start only removes it.
  const g = await storeFixture(t);
  mustOpen(g).store.commit([R.project('prj1', 'C:\\work\\demo')]);
  fs.appendFileSync(g.journal, torn);
  assert.throws(() => g.open({ writer: failingWriter(g.fence, { rm: true }) }));
  const reopened = g.open();
  assert.equal(reopened.ok ? 'opened' : `${reopened.break.why}`, 'opened', 'a marker whose recovered batch committed is only removed');
  if (!reopened.ok) return;
  const after = reopened;
  assert.equal(after.report.cutBytes, 0);
  assert.equal(parsedOf(g.journal).filter((l) => l.kind === 'recovered').length, 1);
  assert.equal(fs.existsSync(cutMarkerPath(g.home)), false);
  after.store.close();
  // A marker that fits no cut of this journal: journal-chain, never a guess.
  fs.writeFileSync(cutMarkerPath(g.home), canonicalJson({ v: 1, committedBytes: 3, cutBytes: 9, tailJseq: 1, tailHash: 'a'.repeat(64) }));
  assert.match(breakOf(g), /^cut-marker@/);
  // And one that is no marker this store writes at all.
  fs.writeFileSync(cutMarkerPath(g.home), '{"cut":"garbage"}');
  assert.match(breakOf(g), /^cut-marker@/);
});

test('R3-5: only a missing journal reads as empty; a journal the gate refuses for another reason (a directory there) stops the open', async (t) => {
  const f = await storeFixture(t);
  fs.mkdirSync(f.journal);
  assert.throws(() => f.open(), (e: unknown) => {
    const reason = (e as { decision?: { reason?: unknown } }).decision?.reason;
    return reason !== undefined && reason !== 'not-found';
  });
  assert.equal(fs.statSync(f.journal).isDirectory(), true, 'nothing was written over it');
});

test('R3-3: the working store\'s redactor gets orchestrad\'s own environment: a value of it is refused in a source string and replaced in a snippet', async (t) => {
  // R3-8: registered before withTmp's cleanup (after-hooks run in order, and a failing one stops the rest),
  // so an in-process orchestrad left running by a failed assertion is stopped before its fixture goes.
  const live: (() => Promise<void>)[] = [];
  t.after(async () => { for (const stop of live) await stop(); });
  const dir = fs.realpathSync.native(withTmp(t));
  const probe = 'qZ7xK2mW9pR4tL8v';
  const o = await startInProcess(detectFeatures(), FENCE_OK, testPorts(), {
    argv: ['--test-profile', '--test-dir', dir], home: path.join(dir, 'user-home'), env: minimalEnv({ PROBE_VALUE: probe }), console: captureConsole().port,
  });
  if (o.mode === 'working') live.push(o.stop);
  assert.equal(o.mode, 'working');
  if (o.mode !== 'working') return;
  assert.throws(() => o.store.commit([R.part('p9', { cwd: `C:\\work\\${probe}` })]), (e: unknown) => e instanceof JournalError && /redacted/.test(e.message));
  o.store.snippets.put('probe1', { text: `the value ${probe} once` });
  assert.ok(!o.store.snippets.get('probe1').text!.includes(probe));
  await o.stop();
});

test('R2-K and R2-I at the scan: a stored judgment naming a retired rule reads; a plan whose createdMono is after its line does not', async (t) => {
  const f = await storeFixture(t);
  const judgment = (format: Record<string, number>): Rec => ({ kind: 'judgment', body: { name: 'redact', inputDigest: 'a'.repeat(64), ver: 1, value: { ver: 1, dropped: null, known: 0, format, entropy: 0 } } });
  assert.ok(scanJournal(Buffer.from(chainOf([judgment({ 'retired-rule': 1 }), commit(1)]))).ok, 'a rule a later redact version retired');
  assert.equal(scanJournal(Buffer.from(chainOf([judgment({ 'Not A Rule': 1 }), commit(1)]))).ok, false, 'a key outside the rule-id grammar');
  // chainOf stamps every line obsMono 1: a plan made at mono 1 fits, one made at mono 2 is after its line.
  const plan = (createdMono: number): Rec => ({ kind: 'brake.plan', body: { ...R.plan('plan1', createdMono, T0).body } });
  assert.ok(scanJournal(Buffer.from(chainOf([plan(1), commit(1)]))).ok);
  fs.writeFileSync(f.journal, chainOf([plan(2), commit(1)]));
  assert.equal(breakOf(f), 'body@1');
});
