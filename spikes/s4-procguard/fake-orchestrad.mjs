// Stand-in for orchestrad (S4 case a): owns one procguard helper and relays JSON lines both ways.
// argv: <procguard.exe> <attached|detached>
//   attached: helper is a normal libuv child (inside Node's global kill-on-close Job)
//   detached: helper is outside Node's Job, so only "stdin EOF -> helper exits" can reap the tree
import { spawn } from 'node:child_process';

const [helper, mode] = process.argv.slice(2);
const detached = mode === 'detached';
const h = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'], detached, windowsHide: true });
process.stdout.write(JSON.stringify({ event: 'orch', pid: process.pid, helperPid: h.pid, detached }) + '\n');
process.stdin.pipe(h.stdin);
h.stdout.pipe(process.stdout);
h.on('exit', (code) => process.stdout.write(JSON.stringify({ event: 'helper-exit', code }) + '\n'));
