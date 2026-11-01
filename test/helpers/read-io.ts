// A real-fs ReadIo for tests that wrap it to count or fault calls; the gate's own io is private.
// Read-only whoever holds it: scripts/stage-keys-sample.ts, a scanned script, takes it too (the scan's
// code-no-test-import rule allows this one helper), so openSync refuses every flag but 'r'.
import * as fs from 'node:fs';
import type { ReadIo } from '../../src/fs/read-gate.ts';

export const realIo: ReadIo = {
  realpath: (p) => fs.realpathSync.native(p),
  openSync: (p, flags) => {
    if (flags !== 'r') throw new Error(`read-io opens read-only, not '${String(flags)}'`);
    return fs.openSync(p, 'r');
  },
  readSync: (fd, buf, offset, length, position) => fs.readSync(fd, buf, offset, length, position),
  fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
  statSync: (p) => fs.statSync(p, { bigint: true }),
  closeSync: (fd) => fs.closeSync(fd),
  readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
};
