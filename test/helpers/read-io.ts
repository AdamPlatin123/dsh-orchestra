// A real-fs ReadIo for tests that wrap it to count or fault calls; the gate's own io is private.
import * as fs from 'node:fs';
import type { ReadIo } from '../../src/fs/read-gate.ts';

export const realIo: ReadIo = {
  realpath: (p) => fs.realpathSync.native(p),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buf, offset, length, position) => fs.readSync(fd, buf, offset, length, position),
  fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
  statSync: (p) => fs.statSync(p, { bigint: true }),
  closeSync: (fd) => fs.closeSync(fd),
  readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
};
