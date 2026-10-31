import * as fs from 'node:fs';
import type { RealpathFn } from './paths.ts';
import type { ReadGateConfig, ReadIo } from './read-gate.ts';
import type { WriteFence, WriteFenceConfig, WriteIo } from './write-fence.ts';
import { ReadGate } from './read-gate.ts';

// The one module that imports node:fs (plan step 2c, zen note 7.3). boot.ts imports it before the
// import fence goes in and hands what it exports to main.ts in BootPorts; once the fence is in, no
// module can resolve it (minted-before-fence, import-fence.ts). The raw io objects never leave this
// file: a caller gets a gate, whose rules are its own module's constants, built around them.
//
// Two calls take an option bag that node:fs reads through the prototype chain for the fields it
// lacks (measured on 24.22: statSync reads throwIfNoEntry, readdirSync encoding and recursive), so
// theirs is frozen, has no prototype and sets those fields. The other calls take no bag, and node:fs
// then uses its own defaults. The calls go through the `fs` namespace at call time, so a test that
// swaps an export with syncBuiltinESMExports still sees them.

const bag = <T extends object>(o: T): T => Object.freeze(Object.assign(Object.create(null) as T, o));
const STAT = bag({ bigint: true as const, throwIfNoEntry: true });
const LIST = bag({ withFileTypes: true as const, encoding: 'utf8' as const, recursive: false });

/** The native realpath: resolves junctions, links and 8.3 short names. A port, handed down by boot. */
export const realpath: RealpathFn = (p) => fs.realpathSync.native(p);

const READ_IO: ReadIo = bag({
  realpath,
  openSync: (p: string, _flags: 'r') => fs.openSync(p, 'r'),
  readSync: (fd: number, buf: Uint8Array, offset: number, length: number, position: number) => fs.readSync(fd, buf, offset, length, position),
  fstatSync: (fd: number) => fs.fstatSync(fd, STAT),
  statSync: (p: string) => fs.statSync(p, STAT)!,
  closeSync: (fd: number) => fs.closeSync(fd),
  readdirSync: (p: string) => fs.readdirSync(p, LIST),
});

// 'append-existing' opens an existing file for appending and never creates one.
const OPEN_FLAGS: Readonly<Record<'wx' | 'ax' | 'append-existing', string | number>> = bag({
  wx: 'wx',
  ax: 'ax',
  'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND,
});

const WRITE_IO: WriteIo = bag({
  realpath,
  openSync: (p: string, flags: 'wx' | 'ax' | 'append-existing') => fs.openSync(p, OPEN_FLAGS[flags]),
  writeSync: (fd: number, buf: Uint8Array, offset: number, length: number) => fs.writeSync(fd, buf, offset, length),
  fsyncSync: (fd: number) => fs.fsyncSync(fd),
  ftruncateSync: (fd: number, length: number) => fs.ftruncateSync(fd, length),
  closeSync: (fd: number) => fs.closeSync(fd),
  fstatSync: (fd: number) => fs.fstatSync(fd, STAT),
  statSync: (p: string) => fs.statSync(p, STAT)!,
  lstatSync: (p: string) => fs.lstatSync(p),
  renameSync: (from: string, to: string) => fs.renameSync(from, to),
  unlinkSync: (p: string) => fs.unlinkSync(p),
  rmdirSync: (p: string) => fs.rmdirSync(p),
  readdirSync: (p: string) => fs.readdirSync(p),
  mkdirSync: (p: string) => {
    fs.mkdirSync(p);
  },
  mkdtempSync: (prefix: string) => fs.mkdtempSync(prefix),
});

/** What a caller of makeReadGate chooses; the io is always this module's. */
export type ReadGateSpec = Omit<ReadGateConfig, 'io'>;
/** What a caller of makeWriteFence chooses; the io is always this module's. */
export type WriteFenceSpec = Omit<WriteFenceConfig, 'io'>;

// Object.assign copies the spec's own enumerable fields only, into an object without a prototype,
// and the io comes last, so an io in the spec never reaches the gate.

/** A read gate on the real file system. */
export function makeReadGate(spec: ReadGateSpec): ReadGate {
  return new ReadGate(Object.assign(Object.create(null) as ReadGateConfig, spec, { io: READ_IO }));
}

/**
 * A write fence on the real file system. Asynchronous because write-fence.ts loads only when the
 * first fence is made: a ui-only process never makes one, so it never loads the fence (plan §6
 * invariant 10). The spec is copied before the first await.
 */
export async function makeWriteFence(spec: WriteFenceSpec): Promise<WriteFence> {
  const cfg = Object.assign(Object.create(null) as WriteFenceConfig, spec, { io: WRITE_IO });
  const { WriteFence: Fence } = await import('./write-fence.ts');
  return new Fence(cfg);
}
