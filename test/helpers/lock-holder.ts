// Child process for test/runtime/lock.test.ts: takes the lock of <testDir>\orchestra the way
// orchestrad does, writes daemon.json once and a stand-in journal, prints "held", freezes its own
// event loop for <freezeMs> (Atomics.wait), prints "thawed <epoch ms>" and then idles until stopped.
//   node lock-holder.ts <testDir> <freezeMs>
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WriteFence } from '../../src/fs/write-fence.ts';
import { prepareDataDir } from '../../src/runtime/data-dir.ts';
import { acquireLock, encodeDaemonInfo, lockPipeName } from '../../src/runtime/lock.ts';

const [dirArg, msArg] = process.argv.slice(2);
const freezeMs = Number(msArg);
if (dirArg === undefined || !Number.isSafeInteger(freezeMs) || freezeMs < 0) throw new Error('usage: lock-holder.ts <testDir> <freezeMs>');
const home = path.join(fs.realpathSync.native(dirArg), 'orchestra');
const fence = new WriteFence({ orchestraHome: home, harnessRoots: [] });
const got = await acquireLock(lockPipeName(fence.homeReal));
if (!got.ok) {
  console.log(`not-acquired ${got.reason}`);
  process.exit(9);
}
prepareDataDir(fence, home);
const info = { v: 1 as const, pid: process.pid, profile: 'test' as const, bootId: crypto.randomUUID(), startedAt: new Date().toISOString() };
fence.writeAtomic(path.join(home, 'run', 'daemon.json'), encodeDaemonInfo(info));
// Stands in for the step-3 journal: a second writer would have to touch it.
fence.append(path.join(home, 'journal.jsonl'), '{"jseq":1,"kind":"holder"}\n', { fsync: true });
process.stdout.write('held\n', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, freezeMs);
  process.stdout.write(`thawed ${Date.now()}\n`);
});
setInterval(() => {}, 60_000);
