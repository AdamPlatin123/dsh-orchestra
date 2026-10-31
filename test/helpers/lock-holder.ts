// Child process for test/runtime/lock.test.ts: takes the lock of <testDir>\orchestra the way
// orchestrad does, writes daemon.json and a stand-in journal, prints "held", then either idles
// with a heartbeat that is already 120 s old ("stale") or freezes its own event loop ("freeze").
//   node lock-holder.ts <testDir> stale|freeze [freezeMs]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WriteFence } from '../../src/fs/write-fence.ts';
import { prepareDataDir } from '../../src/runtime/data-dir.ts';
import { acquireLock, encodeDaemonInfo, lockPipeName } from '../../src/runtime/lock.ts';

const [dirArg, mode, msArg] = process.argv.slice(2);
if (dirArg === undefined || (mode !== 'stale' && mode !== 'freeze')) throw new Error('usage: lock-holder.ts <testDir> stale|freeze [freezeMs]');
const home = path.join(fs.realpathSync.native(dirArg), 'orchestra');
const fence = new WriteFence({ orchestraHome: home, harnessRoots: [] });
const got = await acquireLock(lockPipeName(fence.homeReal));
if (!got.ok) {
  console.log(`not-acquired ${got.reason}`);
  process.exit(9);
}
prepareDataDir(fence, home);
const beat = new Date(mode === 'stale' ? Date.now() - 120_000 : Date.now()).toISOString();
fence.writeAtomic(path.join(home, 'run', 'daemon.json'), encodeDaemonInfo({ v: 1, pid: process.pid, createTime: null, profile: 'test', startedAt: beat, heartbeatAt: beat }));
// Stands in for the step-3 journal: a second writer would have to touch it.
fence.append(path.join(home, 'journal.jsonl'), '{"jseq":1,"kind":"holder"}\n', { fsync: true });
process.stdout.write('held\n', () => {
  if (mode === 'freeze') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(msArg ?? 125_000));
});
setInterval(() => {}, 60_000);
