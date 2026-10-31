// Stand-in for an agent host (Node, like a DSH host): it spawns a shell running `ping -t`
// and a dev server through child_process, so its children sit in this Node's own libuv Job
// (nested inside whatever Job we are in) and the ping is a grandchild that libuv lets break away.
// argv: <port for the dev server>
import { spawn } from 'node:child_process';

const port = Number(process.argv[2]);
spawn('C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'ping -t 127.0.0.1 >nul'], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setInterval(()=>{},1e3)`], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);
