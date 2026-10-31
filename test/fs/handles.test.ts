import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { ReadGate, ReadGateError } from '../../src/fs/read-gate.ts';
import { realIo } from '../helpers/read-io.ts';
import type { ReadIo } from '../../src/fs/read-gate.ts';
import { put, withTmp } from '../helpers/tmp.ts';

const UUID = '0e0f3a52-7b1c-4d2e-9f00-1234567890ab';

type Counted = { io: ReadIo; opens: Array<{ fd: number; flags: string }>; closes: number[] };

/** Real fs underneath, with every open and close recorded. */
function counting(overrides: Partial<ReadIo> = {}): Counted {
  const opens: Counted['opens'] = [];
  const closes: number[] = [];
  const io: ReadIo = {
    ...realIo,
    openSync: (p, flags) => {
      const fd = realIo.openSync(p, flags);
      opens.push({ fd, flags });
      return fd;
    },
    closeSync: (fd) => {
      closes.push(fd);
      realIo.closeSync(fd);
    },
    ...overrides,
  };
  return { io, opens, closes };
}

/** Without `io` the gate uses its own private real-fs io, as in production. */
function fixture(t: TestContext, io?: ReadIo) {
  const base = withTmp(t);
  const dsh = path.join(base, '.dsh');
  const log = put(path.join(dsh, 'sessions', '--G--p--', UUID, 'session.v4.jsonl.zstd'), 'frame-1');
  const claude = path.join(base, '.claude');
  const reg = put(path.join(claude, 'sessions', '42.json'), '{"status":"idle"}');
  const gate = new ReadGate({
    roots: [{ kind: 'dsh', path: dsh, real: dsh }, { kind: 'claude', path: claude, real: claude }],
    ...(io !== undefined ? { io } : {}),
  });
  return { base, log, reg, claude, gate };
}

function assertClosed(fd: number): void {
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' }, `fd ${fd} is still open`);
}

test('every read opens with r, closes before returning, and the count returns to baseline', (t) => {
  const c = counting();
  const { log, reg, claude, gate } = fixture(t, c.io);
  assert.equal(gate.openHandles(), 0);
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.readFile(reg).toString(), '{"status":"idle"}');
    assertClosed(c.opens.at(-1)!.fd);
  }
  assert.equal(gate.readRange(log, 0, 5).toString(), 'frame');
  assertClosed(c.opens.at(-1)!.fd);
  gate.stat(reg);
  gate.readdir(path.join(claude, 'sessions'));
  assert.equal(c.opens.length, 4, 'stat and readdir open no handle of ours');
  assert.deepEqual(c.opens.map((o) => o.flags), ['r', 'r', 'r', 'r']);
  assert.deepEqual(c.closes, c.opens.map((o) => o.fd));
  assert.equal(gate.openHandles(), 0);
});

test('a read that fails half-way still closes its handle', (t) => {
  const c = counting({
    readSync: () => {
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    },
  });
  const { reg, gate } = fixture(t, c.io);
  assert.throws(() => gate.readFile(reg), { code: 'EIO' });
  assert.equal(c.opens.length, 1);
  assert.deepEqual(c.closes, [c.opens[0]!.fd]);
  assertClosed(c.opens[0]!.fd);
  assert.equal(gate.openHandles(), 0);
});

test('a file swapped between the check and the open is refused and its handle closed', (t) => {
  const c = counting({
    fstatSync: (fd) => {
      const s = realIo.fstatSync(fd);
      return { ...s, ino: s.ino + 1n, isFile: () => true, isDirectory: () => false };
    },
  });
  const { reg, gate } = fixture(t, c.io);
  assert.throws(() => gate.readFile(reg), (e: unknown) => {
    assert.ok(e instanceof ReadGateError);
    assert.equal(e.decision.reason, 'changed-during-open');
    return true;
  });
  assertClosed(c.opens[0]!.fd);
  assert.equal(gate.openHandles(), 0);
});

test('with the production io, another process appends freely while a tail handle is held', (t) => {
  const { log, gate } = fixture(t);
  const tail = gate.openTail(log);
  assert.equal(gate.openHandles(), 1);
  const before = tail.size();
  const id = tail.identity();

  const child = spawnSync(process.execPath, [
    '-e',
    'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "|frame-2"); fs.appendFileSync(process.argv[1], "|frame-3");',
    log,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);

  assert.equal(tail.size(), before + '|frame-2|frame-3'.length);
  assert.equal(tail.read(before, 100).toString(), '|frame-2|frame-3');
  assert.deepEqual(tail.identity(), id);
  assert.equal(fs.readFileSync(log, 'utf8'), 'frame-1|frame-2|frame-3');

  tail.close();
  tail.close();
  assert.equal(gate.openHandles(), 0);
  assert.throws(() => tail.read(0, 1), /tail handle closed/);
  assert.equal(gate.readFile(log).toString(), 'frame-1|frame-2|frame-3');
  assert.equal(gate.openHandles(), 0);
});

test('several tails are counted one by one', (t) => {
  const c = counting();
  const { base, log, gate } = fixture(t, c.io);
  const second = put(path.join(base, '.dsh', 'sessions', '--G--p--', `session-${UUID}`, 'session.v4.jsonl.zstd'), 'x');
  const a = gate.openTail(log);
  const b = gate.openTail(second);
  assert.equal(gate.openHandles(), 2);
  a.close();
  assert.equal(gate.openHandles(), 1);
  b.close();
  assert.equal(gate.openHandles(), 0);
  assert.deepEqual(c.opens.map((o) => o.flags), ['r', 'r']);
  assert.deepEqual(c.closes, c.opens.map((o) => o.fd));
  for (const o of c.opens) assertClosed(o.fd);
});
