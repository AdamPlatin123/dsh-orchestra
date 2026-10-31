// S4 cleanup check: lists processes this spike could have left behind, matched only by our own markers
// (scratch path 's4-procguard', the fake dev server body, the fake 'dsh web --port 0', our pipe/job prefix 'pg-s4-').
// The shells running this check also match 's4-procguard'; ignore those. Prints pid/name/createTime only.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const [helperPath, flag] = process.argv.slice(2);
const markers = ['s4-procguard', "s.end('ok')", 'dsh web --port 0', 'pg-s4-'];
const h = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const pend = new Map(); let id = 0;
const call = (cmd, a = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); h.stdin.write(JSON.stringify({ id: i, cmd, ...a }) + '\n'); });
readline.createInterface({ input: h.stdout }).on('line', async (l) => {
  const j = JSON.parse(l);
  if (j.event === 'ready') {
    const s = await call('snapshot', { cmdline: true });
    const mine = s.procs.filter((p) => p.pid !== j.pid && p.pid !== process.pid && p.cmdline && markers.some((m) => p.cmdline.includes(m)) && p.ppid !== process.pid);
    const names = s.procs.reduce((m, p) => { const n = p.name.toLowerCase(); if (n === 'ping.exe' || n === 'procguard.exe') m[n] = (m[n] || 0) + 1; return m; }, {});
    console.log(JSON.stringify({ total: s.total, markerMatches: mine.map((p) => ({ pid: p.pid, name: p.name, createTime: p.createTime })), pingAndHelperCounts: names }));
    if (flag === '--kill') for (const p of mine) {
      const sub = await call('snapshot', { under: { pid: p.pid, createTime: p.createTime }, cmdline: false });
      const r = await call('kill-tree', { pid: p.pid, createTime: p.createTime, includeRoot: true, confirm: sub.procs.map((q) => `${q.pid}:${q.createTime}`) });
      console.log('kill', p.pid, r.ok, r.error || '', (r.killed || []).map((k) => k.name).join(','));
    }
    h.stdin.end(); return;
  }
  const r = pend.get(j.id); if (r) { pend.delete(j.id); r(j); }
});
