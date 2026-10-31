import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FenceStat, WriteIo } from '../../src/fs/write-fence.ts';
import { WriteFence, WriteFenceError } from '../../src/fs/write-fence.ts';
import { junction, put, withTmp } from '../helpers/tmp.ts';
import { realWriteIo } from '../helpers/write-io.ts';

// Step 3's two additions to the write fence: checkByName() judges a file another component opens by
// its name (SQLite's database and side files), shorten() cuts the journal's torn tail on a handle.

function fixture(t: Parameters<typeof withTmp>[0], io: WriteIo = realWriteIo) {
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'orchestra');
  fs.mkdirSync(home);
  const fence = new WriteFence({ orchestraHome: home, harnessRoots: [path.join(dir, 'claude')], io });
  return { dir, home, fence };
}

const verdict = (d: ReturnType<WriteFence['checkByName']>) => (d.allow ? `allow ${d.id === null ? 'new' : 'existing'}` : `${d.reason}${'detail' in d ? ` ${String(d.detail)}` : ''}`);

test('checkByName: a plain file inside home is allowed, with its identity when it exists', (t) => {
  const { home, fence } = fixture(t);
  assert.equal(verdict(fence.checkByName(path.join(home, 'a.db'))), 'allow new');
  put(path.join(home, 'b.db'), 'x');
  const d = fence.checkByName(path.join(home, 'b.db'));
  assert.equal(verdict(d), 'allow existing');
  const st = fs.statSync(path.join(home, 'b.db'), { bigint: true });
  assert.deepEqual(d.allow ? d.id : null, { dev: st.dev, ino: st.ino });
});

test('checkByName refuses outside home, under a harness root, a link at the entry, a link on the way from home, and another hard link', (t) => {
  const { dir, home, fence } = fixture(t);
  assert.equal(verdict(fence.checkByName(path.join(dir, 'x.db'))), 'outside-home');
  assert.equal(verdict(fence.checkByName(path.join(dir, 'claude', 'x.db'))), 'harness-root');
  fs.mkdirSync(path.join(home, 'real'));
  junction(dir, path.join(home, 'via'), path.join(home, 'real'));
  assert.equal(verdict(fence.checkByName(path.join(home, 'via', 'x.db'))), 'link path');
  // A junction at the name itself, whose target does not exist: its canonical form looks plain.
  junction(dir, path.join(home, 'x.db-wal'), path.join(home, 'missing'));
  assert.equal(verdict(fence.checkByName(path.join(home, 'x.db-wal'))), 'link entry');
  const outside = put(path.join(dir, 'outside.bin'), 'keep');
  fs.linkSync(outside, path.join(home, 'h.db'));
  assert.equal(verdict(fence.checkByName(path.join(home, 'h.db'))), 'hardlink');
  assert.equal(verdict(fence.checkByName(`${home}\\a.db:stream`)), 'bad-path ads');
});

test('shorten cuts an existing file on its handle and syncs it; it never grows, creates or follows anything', (t) => {
  const log: string[] = [];
  const io: WriteIo = {
    ...realWriteIo,
    openSync: (p, flags) => {
      log.push(`open ${flags}`);
      return realWriteIo.openSync(p, flags);
    },
    fsyncSync: (fd) => {
      log.push('fsync');
      realWriteIo.fsyncSync(fd);
    },
  };
  const { dir, home, fence } = fixture(t, io);
  const file = put(path.join(home, 'journal.jsonl'), 'line one\nhalf a li');
  fence.shorten(file, 9);
  assert.equal(fs.readFileSync(file, 'utf8'), 'line one\n');
  assert.deepEqual(log, ['open write-existing', 'fsync']);
  assert.throws(() => fence.shorten(file, 100), RangeError, 'never grows');
  assert.equal(fs.readFileSync(file, 'utf8'), 'line one\n');
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => fence.shorten(file, bad), /shorten takes a non-negative integer length/, String(bad));
  assert.throws(() => fence.shorten(path.join(home, 'missing.jsonl'), 0), /ENOENT/);
  assert.equal(fs.existsSync(path.join(home, 'missing.jsonl')), false, 'nothing was created');
  const outside = put(path.join(dir, 'outside.jsonl'), 'keep this');
  assert.throws(() => fence.shorten(outside, 0), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'outside-home');
  fs.linkSync(outside, path.join(home, 'linked.jsonl'));
  assert.throws(() => fence.shorten(path.join(home, 'linked.jsonl'), 0), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'hardlink');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep this');
});

test('shorten judges the opened handle: a file that is another one by the time it is open is not cut', (t) => {
  let swap = false;
  const io: WriteIo = {
    ...realWriteIo,
    statSync: (p: string): FenceStat => {
      const s = realWriteIo.statSync(p);
      return swap && p.toLowerCase().endsWith('journal.jsonl') ? { ...s, ino: s.ino + 1n } : s;
    },
  };
  const { home, fence } = fixture(t, io);
  const file = put(path.join(home, 'journal.jsonl'), 'abcdef');
  swap = true;
  assert.throws(() => fence.shorten(file, 2), (e: unknown) => e instanceof WriteFenceError && e.decision.reason === 'changed-during-open');
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
});
