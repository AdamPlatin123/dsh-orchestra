// A real-fs WriteIo for tests that wrap it to stage a race or count calls; the production io is
// private to src/fs/node-io.ts and reaches a fence only through makeWriteFence.
import * as fs from 'node:fs';
import type { WriteIo } from '../../src/fs/write-fence.ts';

const FLAGS = { wx: 'wx', ax: 'ax', 'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND, 'write-existing': fs.constants.O_WRONLY } as const;

export const realWriteIo: WriteIo = {
  realpath: (p) => fs.realpathSync.native(p),
  openSync: (p, flags) => fs.openSync(p, FLAGS[flags]),
  writeSync: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, length),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  ftruncateSync: (fd, length) => fs.ftruncateSync(fd, length),
  closeSync: (fd) => fs.closeSync(fd),
  fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
  statSync: (p) => fs.statSync(p, { bigint: true }),
  lstatSync: (p) => fs.lstatSync(p),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (p) => fs.unlinkSync(p),
  rmdirSync: (p) => fs.rmdirSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  mkdirSync: (p) => {
    fs.mkdirSync(p);
  },
  mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
};
