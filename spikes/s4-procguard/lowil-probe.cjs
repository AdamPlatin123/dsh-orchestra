// S4 side probe. test.mjs runs this under the portable Node 24, whose node.exe carries an inherited
// Low mandatory label, so this process (and every child) starts at Low integrity.
// It prints one JSON line: our integrity level, whether we can write into <tmpDir> (one tiny file,
// deleted at once), and what a procguard helper started from here can see in a snapshot.
// argv: <procguard.exe> <tmpDir>
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const [helper, tmpDir] = process.argv.slice(2);
const w = spawnSync('C:\\Windows\\System32\\whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
const integrity = (w.stdout || '').split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '')).find((g) => /Mandatory Level/.test(g)) || null;
let write = 'ok';
const f = path.join(tmpDir, `lowil-${process.pid}.txt`);
try { fs.writeFileSync(f, 'x'); fs.unlinkSync(f); } catch (e) { write = e.code || String(e); }
const h = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
readline.createInterface({ input: h.stdout }).on('line', (l) => {
  const j = JSON.parse(l);
  if (j.event) { h.stdin.write(JSON.stringify({ id: 1, cmd: 'snapshot', cmdline: true }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ integrity, node: process.version, writeTmp: write, helperPid: h.pid, total: j.total, raw: j.raw, openFailed: j.openFailed, cmdlineNull: j.cmdlineNull }) + '\n');
  h.stdin.end();
});
