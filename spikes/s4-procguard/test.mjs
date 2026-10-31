// S4 procguard test driver. Plays orchestrad; runs cases a-h from SPIKES-M0.md §4 plus the libuv baseline,
// the Low-integrity side check and the Add-Type comparison. Needs Node >= 22 (global fetch/WebSocket) at
// MEDIUM integrity: the portable Node 24 under G:\_Projects\DSH-plugins\.tools carries a Low mandatory
// label, so it cannot write the evidence dir and sees only part of the process list (case "lowil").
//   set S4_SCRATCH=<scratch dir>   (tmp\ and evidence\ live under it)
//   I:\npm\node.exe test.mjs [case ...]      (no zstd here, so the system Node 22 is fine)
// Privacy: results keep only pids, image names, create times, counts and timings. Command lines of
// processes that are not ours are never written anywhere; chrome://sandbox text comes from our own
// throwaway browser profile.
import { spawn, spawnSync, execFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'out', 'procguard.exe');
const NODE = process.execPath;
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const SCR = process.env.S4_SCRATCH;
if (!SCR) throw new Error('set S4_SCRATCH');
const TMP = path.join(SCR, 'tmp');
const EVID = path.join(SCR, 'evidence');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
const RUN = Date.now().toString(36);
const only = process.argv.slice(2);
const want = (c) => only.length === 0 || only.includes(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { run: RUN, startedAt: new Date().toISOString(), node: process.version, nodePath: process.execPath, os: os.release(), testPid: process.pid, cases: {} };
{ // integrity level of this orchestrad stand-in (children inherit it)
  const w = spawnSync('C:\\Windows\\System32\\whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  R.integrity = (w.stdout || '').split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '')).find((g) => /Mandatory Level/.test(g)) || null;
}
const owned = new Map(); // "pid:createTime" -> {pid, createTime, name, from}
const spawnedPids = []; // every process this script spawned directly: {pid, what}

function track(procs, from) { for (const p of procs) owned.set(`${p.pid}:${p.createTime}`, { pid: p.pid, createTime: p.createTime, name: p.name, from }); }
const slim = (p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, createTime: p.createTime });

class Lines {
  constructor(proc, label) {
    this.proc = proc; this.label = label; this.next = 1; this.pending = new Map(); this.events = []; this.waiters = [];
    readline.createInterface({ input: proc.stdout }).on('line', (l) => this.onLine(l));
    this.exited = new Promise((res) => proc.on('exit', (code) => res({ code, t: performance.now() })));
  }
  onLine(l) {
    let j; try { j = JSON.parse(l); } catch { return; }
    if (j.event) { j.at = performance.now(); this.events.push(j); for (const w of [...this.waiters]) if (w.name === j.event) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(j); } return; }
    const cb = this.pending.get(j.id); if (cb) { this.pending.delete(j.id); cb(j); }
  }
  waitEvent(name, timeoutMs = 15000) {
    const e = this.events.find((x) => x.event === name); if (e) return Promise.resolve(e);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${this.label}: no ${name}`)), timeoutMs); this.waiters.push({ name, res: (j) => { clearTimeout(t); res(j); } }); });
  }
  call(cmd, args = {}, timeoutMs = 30000) {
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${this.label} ${cmd} timeout`)); }, timeoutMs);
      this.pending.set(id, (j) => { clearTimeout(t); res(j); });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }
  end() { this.proc.stdin.end(); return this.exited; }
}

function helper(label, { detached = false } = {}) {
  const t0 = performance.now();
  const p = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true });
  spawnedPids.push({ pid: p.pid, what: `helper:${label}` });
  p.stderr.on('data', () => {});
  const h = new Lines(p, label); h.pid = p.pid; h.t0 = t0;
  h.ready = h.waitEvent('ready').then((j) => { j.wallMs = j.at - t0; h.info = j; return j; });
  return h;
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function httpOk(port) { try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); return (await r.text()) === 'ok'; } catch { return false; } }
const devServer = (port) => `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setInterval(()=>{},1e3)`;

async function createTimeOf(obs, pid) { const r = await obs.call('snapshot', { pids: [pid], cmdline: false }); return r.procs[0] ? r.procs[0].createTime : null; }
async function treeUnder(obs, pid, createTime) { const r = await obs.call('snapshot', { under: { pid, createTime }, cmdline: false }); return r.procs.map(slim); }
async function alive(obs, procs) {
  if (procs.length === 0) return [];
  const r = await obs.call('alive', { procs: procs.map((p) => ({ pid: p.pid, createTime: p.createTime })) });
  const live = new Set(r.alive);
  return procs.filter((p) => live.has(`${p.pid}:${p.createTime}`));
}
const pings = (t) => t.filter((p) => p.name.toUpperCase() === 'PING.EXE').length;
// Poll until the trees under `roots` satisfy `ready` (children appear late on a loaded machine).
async function settle(obs, roots, ready, timeoutMs = 20000) {
  const t0 = performance.now(); let tree = [];
  while (performance.now() - t0 < timeoutMs) {
    tree = []; for (const r of roots) tree.push(...await treeUnder(obs, r.pid, r.createTime));
    if (await ready(tree)) return { tree, settleMs: Math.round(performance.now() - t0), ready: true };
    await sleep(250);
  }
  return { tree, settleMs: Math.round(performance.now() - t0), ready: false };
}
const runTaskkill = (pid, t0) => new Promise((res) => execFile(TASKKILL, ['/F', '/PID', String(pid)], { windowsHide: true }, (err) => res({ ms: Math.round(performance.now() - t0), ok: !err })));
async function waitGone(obs, procs, timeoutMs, t0) {
  const goneAt = new Map(); let left = procs;
  while (left.length && performance.now() - t0 < timeoutMs) {
    const live = await alive(obs, left); const liveKeys = new Set(live.map((p) => `${p.pid}:${p.createTime}`));
    const now = performance.now();
    for (const p of left) if (!liveKeys.has(`${p.pid}:${p.createTime}`)) goneAt.set(`${p.pid}:${p.createTime}`, now - t0);
    left = live; if (left.length) await sleep(25);
  }
  const per = procs.map((p) => ({ pid: p.pid, name: p.name, goneMs: goneAt.has(`${p.pid}:${p.createTime}`) ? Math.round(goneAt.get(`${p.pid}:${p.createTime}`)) : null }));
  const times = per.filter((x) => x.goneMs !== null).map((x) => x.goneMs);
  return { tracked: procs.length, survivors: left.length, survivorNames: left.map((p) => p.name), allGoneMs: left.length ? null : Math.max(0, ...times), per };
}
// Clean up our own leftovers: kill-tree by exact identity, confirming every node of the (own) subtree.
async function sweep(obs, procs, from) {
  const out = [];
  for (const p of await alive(obs, procs)) {
    if (!(await alive(obs, [p])).length) continue;
    const sub = await treeUnder(obs, p.pid, p.createTime);
    const r = await obs.call('kill-tree', { pid: p.pid, createTime: p.createTime, includeRoot: true, confirm: sub.map((q) => `${q.pid}:${q.createTime}`) });
    out.push({ pid: p.pid, name: p.name, ok: r.ok, error: r.error, killed: (r.killed || []).length });
  }
  if (out.length) (R.cleanup ??= []).push({ from, killed: out });
  return out;
}

// ---------- a: kill orchestrad -> tree reaped ----------
async function caseA(obs, variant) {
  const out = { variant };
  const orch = spawn(NODE, [path.join(HERE, 'fake-orchestrad.mjs'), HELPER, variant], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  spawnedPids.push({ pid: orch.pid, what: `fake-orchestrad:${variant}` });
  const c = new Lines(orch, `orch-${variant}`);
  const ev = await c.waitEvent('orch'); await c.waitEvent('ready');
  const jobName = `Local\\pg-s4-a-${variant}-${RUN}`;
  const [p1, p2] = [await freePort(), await freePort()];
  const r1 = await c.call('run-in-job', { job: 'J1', jobName, cmdline: `"${CMD}" /d /c ping -t 127.0.0.1 >nul`, noWindow: true });
  const r2 = await c.call('run-in-job', { job: 'J1', argv: [NODE, '-e', devServer(p1)], noWindow: true });
  const r3 = await c.call('run-in-job', { job: 'J1', argv: [NODE, path.join(HERE, 'fake-agent.mjs'), String(p2)], noWindow: true });
  out.spawn = [r1, r2, r3].map((r) => ({ ok: r.ok, spawnMs: r.spawnMs, inJobBeforeResume: r.inJobBeforeResume, error: r.error, message: r.message }));
  const hct = await createTimeOf(obs, ev.helperPid);
  const st = await settle(obs, [{ pid: ev.helperPid, createTime: hct }], async (t) => pings(t) >= 2 && await httpOk(p1) && await httpOk(p2));
  out.settle = { ms: st.settleMs, ready: st.ready };
  const tree = st.tree; track(tree, `a-${variant}`);
  const ij = await c.call('in-job', { job: 'J1', pids: tree.map((p) => p.pid) });
  const info = await c.call('job-info', { job: 'J1' });
  const ijm = new Map(ij.results.map((x) => [x.pid, x]));
  out.tree = tree.map((p) => ({ ...p, inJob: ijm.get(p.pid)?.inJob ?? null, inAnyJob: ijm.get(p.pid)?.inAnyJob ?? null }));
  out.inJobCount = out.tree.filter((p) => p.inJob).length;
  out.jobActiveBefore = info.activeProcesses;
  out.httpBefore = [await httpOk(p1), await httpOk(p2)];
  const t0 = performance.now();
  const tk = runTaskkill(orch.pid, t0);
  out.gone = await waitGone(obs, tree, 10000, t0);
  out.taskkill = await tk;
  out.orchExitMs = Math.round((await c.exited).t - t0);
  out.goneAfterOrchExitMs = out.gone.allGoneMs === null ? null : out.gone.allGoneMs - out.orchExitMs;
  out.httpAfter = [await httpOk(p1), await httpOk(p2)];
  const jo = await obs.call('job-open', { name: jobName });
  out.jobOpenAfter = jo.ok ? { activeProcesses: jo.activeProcesses } : { error: jo.error, win32: jo.win32 };
  await sweep(obs, tree, `a-${variant}`);
  return out;
}

// ---------- baseline: Node alone (no procguard) ----------
async function caseBaseline(obs) {
  const port = await freePort();
  const agent = spawn(NODE, [path.join(HERE, 'fake-agent.mjs'), String(port)], { stdio: 'ignore', windowsHide: true });
  spawnedPids.push({ pid: agent.pid, what: 'baseline-agent' });
  const st = await settle(obs, [{ pid: agent.pid, createTime: await createTimeOf(obs, agent.pid) }], async (t) => pings(t) >= 1 && await httpOk(port));
  const tree = st.tree; track(tree, 'baseline');
  const ij = await obs.call('in-job', { pids: tree.map((p) => p.pid) });
  const t0 = performance.now();
  const tk = await runTaskkill(agent.pid, t0);
  await sleep(Math.max(0, 2000 - (performance.now() - t0)));
  await sleep(2000);
  const surv = await alive(obs, tree);
  const out = { settle: { ms: st.settleMs, ready: st.ready }, taskkill: tk, tree: tree.map((p) => ({ ...p, inAnyJob: ij.results.find((x) => x.pid === p.pid)?.inAnyJob })), survivorsAfterKill: surv.map((p) => p.name), checkedAtMs: Math.round(performance.now() - t0), devServerAnswersAfter: await httpOk(port) };
  out.cleanup = await sweep(obs, tree, 'baseline');
  return out;
}

// ---------- b: explicit kill-job ----------
async function caseB(obs) {
  const h = helper('b'); await h.ready;
  const port = await freePort();
  const rp = await h.call('run-in-job', { job: 'J2', cmdline: `"${CMD}" /d /c ping -t 127.0.0.1 >nul`, noWindow: true });
  const ra = await h.call('run-in-job', { job: 'J2', argv: [NODE, path.join(HERE, 'fake-agent.mjs'), String(port)], noWindow: true });
  const st = await settle(obs, [rp, ra], async (t) => pings(t) >= 2 && await httpOk(port));
  const tree = st.tree; track(tree, 'b');
  const before = await h.call('job-info', { job: 'J2' });
  const t0 = performance.now();
  const k = await h.call('kill-job', { job: 'J2', waitMs: 3000 });
  const gone = await waitGone(obs, tree, 3000, t0);
  const after = await h.call('job-info', { job: 'J2' });
  await h.end();
  return { settle: { ms: st.settleMs, ready: st.ready }, treeNames: tree.map((p) => p.name), before: { active: before.activeProcesses, total: before.totalProcesses }, killJob: { zeroAfterMs: k.zeroAfterMs, active: k.activeProcesses, totalTerminated: k.totalTerminated }, after: { active: after.activeProcesses, total: after.totalProcesses, terminated: after.totalTerminated, pids: after.pids.length }, gone };
}

// ---------- c: nested Job (second helper in one-shot mode inside our Job) ----------
async function caseC(obs, how) {
  const h = helper(`c-${how}`, { detached: how === 'eof' }); await h.ready;
  const innerName = `Local\\pg-s4-c-${how}-inner-${RUN}`;
  const r = await h.call('run-in-job', { job: 'J3', argv: [HELPER, 'run-in-job', '--name', innerName, '--no-window', '--', CMD, '/d', '/c', 'ping -t 127.0.0.1'], noWindow: true });
  const st = await settle(obs, [r], async (t) => pings(t) >= 1);
  const tree = st.tree; track(tree, `c-${how}`);
  const outer = await h.call('in-job', { job: 'J3', pids: tree.map((p) => p.pid) });
  const inner = await obs.call('in-job-named', { name: innerName, pids: tree.map((p) => p.pid) });
  const out = { how, settle: { ms: st.settleMs, ready: st.ready }, tree: tree.map((p) => ({ ...p, inOuter: outer.results.find((x) => x.pid === p.pid)?.inJob, inInner: inner.ok ? inner.results.find((x) => x.pid === p.pid)?.inJob : `open-failed:${inner.win32}` })) };
  out.inBoth = out.tree.filter((p) => p.inOuter === true && p.inInner === true).length;
  const t0 = performance.now();
  if (how === 'kill-job') { const k = await h.call('kill-job', { job: 'J3', waitMs: 3000 }); out.killJob = { zeroAfterMs: k.zeroAfterMs, active: k.activeProcesses }; out.gone = await waitGone(obs, tree, 3000, t0); await h.end(); }
  else { const hTree = [{ pid: h.pid, name: 'procguard.exe(outer)', createTime: h.info.createTime }, ...tree]; h.proc.stdin.end(); out.gone = await waitGone(obs, hTree, 5000, t0); }
  const jo = await obs.call('job-open', { name: innerName });
  out.innerJobAfter = jo.ok ? { activeProcesses: jo.activeProcesses } : { error: jo.error, win32: jo.win32 };
  await sweep(obs, tree, `c-${how}`);
  return out;
}

// ---------- d: kill-tree guards ----------
async function caseD(obs) {
  const h = helper('d'); await h.ready; const out = {};
  const r = await h.call('run-in-job', { job: 'J5', cmdline: `"${CMD}" /d /c ping -t 127.0.0.1 >nul`, noWindow: true });
  const st = await settle(obs, [r], async (t) => pings(t) >= 1);
  const tree = st.tree; track(tree, 'd'); out.settle = { ms: st.settleMs, ready: st.ready };
  const bad = (BigInt(r.createTime) + 1n).toString();
  const d1 = await h.call('kill-tree', { pid: r.pid, createTime: bad });
  out.d1_wrongCreateTime = { ok: d1.ok, error: d1.error, stillAlive: (await alive(obs, tree)).length, of: tree.length };
  // includeRoot without the root's token: refused (§10.5 item 4, killing the harness itself needs typed confirmation)
  const d2a = await h.call('kill-tree', { pid: r.pid, createTime: r.createTime, includeRoot: true });
  out.d2a_rootWithoutToken = { ok: d2a.ok, error: d2a.error, reasons: (d2a.protected || []).map((p) => p.reason), stillAlive: (await alive(obs, tree)).length, of: tree.length };
  const t0 = performance.now();
  const d2 = await h.call('kill-tree', { pid: r.pid, createTime: r.createTime }); // default: descendants only
  out.d2_exact = { ok: d2.ok, rounds: d2.rounds, killedNames: (d2.killed || []).map((k) => k.name), rootKilled: (d2.killed || []).some((k) => k.pid === r.pid), ms: d2.ms, gone: await waitGone(obs, tree, 2000, t0), treeNames: tree.map((p) => p.name) };
  // protected host by command line: a node.exe that looks like `dsh web`, started outside our Jobs
  const fake = spawn(NODE, ['-e', 'setInterval(()=>{},1e3)', 'dsh', 'web', '--port', '0'], { stdio: 'ignore', windowsHide: true });
  spawnedPids.push({ pid: fake.pid, what: 'fake-dsh-web' });
  await sleep(500);
  const fct = await createTimeOf(obs, fake.pid); track([{ pid: fake.pid, createTime: fct, name: 'node.exe' }], 'd-fake-dsh-web');
  const d3c = await h.call('kill-tree', { pid: fake.pid, createTime: fct, dryRun: true }); // descendants only, still refused: the root is a multi-session host
  const d3a = await h.call('kill-tree', { pid: fake.pid, createTime: fct, includeRoot: true });
  const aliveA = (await alive(obs, [{ pid: fake.pid, createTime: fct }])).length;
  const d3b = await h.call('kill-tree', { pid: fake.pid, createTime: fct, includeRoot: true, confirm: [`${fake.pid}:${fct}`] });
  await sleep(300);
  out.d3_protectedHost = { descendantsOnlyNoToken: { ok: d3c.ok, error: d3c.error, reasons: (d3c.protected || []).map((p) => p.reason) }, noToken: { ok: d3a.ok, error: d3a.error, reasons: (d3a.protected || []).map((p) => p.reason), stillAlive: aliveA }, withToken: { ok: d3b.ok, killed: (d3b.killed || []).length, killedNames: (d3b.killed || []).map((k) => k.name), aliveAfter: (await alive(obs, [{ pid: fake.pid, createTime: fct }])).length } };
  // protected by image name, dry run only (nothing can be killed): explorer.exe; critical: winlogon.exe even with a token
  const all = await h.call('snapshot', { cmdline: false });
  const ex = all.procs.find((p) => p.name.toLowerCase() === 'explorer.exe');
  if (ex) { const d4 = await h.call('kill-tree', { pid: ex.pid, createTime: ex.createTime, dryRun: true }); out.d4_explorerDry = { ok: d4.ok, error: d4.error, rootReason: (d4.protected || []).find((p) => p.pid === ex.pid)?.reason, protectedInTree: (d4.protected || []).length }; }
  const wl = all.procs.find((p) => p.name.toLowerCase() === 'winlogon.exe');
  if (wl) { const d4c = await h.call('kill-tree', { pid: wl.pid, createTime: wl.createTime, dryRun: true, includeRoot: true, confirm: [`${wl.pid}:${wl.createTime}`] }); out.d4_winlogonDryWithToken = { ok: d4c.ok, error: d4c.error, rootReason: (d4c.protected || []).find((p) => p.pid === wl.pid)?.reason, createTimeKnown: wl.createTime !== '0' }; }
  // d7 (review S4-PROCGUARD-01): an unknown identity (createTime "0", i.e. the process cannot be opened) is refused
  const synth0 = [
    { pid: 910000, ppid: 4, name: 'svc.exe', createTime: '0' },
    { pid: 910001, ppid: 910000, name: 'node.exe', createTime: '5000' }, // an orphan whose ppid happens to match
    { pid: 910002, ppid: 910001, name: 'cmd.exe', createTime: '6000' },
  ];
  const d7a = await h.call('kill-tree', { pid: 910000, createTime: '0', dryRun: true, includeRoot: true, procs: synth0, confirm: synth0.map((p) => `${p.pid}:${p.createTime}`) });
  out.d7_identityUnknown = { synthetic: { ok: d7a.ok, error: d7a.error, plan: (d7a.plan || []).map((p) => p.pid) } };
  const openable = new Set(all.procs.filter((p) => p.createTime !== '0').map((p) => p.ppid));
  const real0 = all.procs.filter((p) => p.pid > 4 && p.createTime === '0' && openable.has(p.pid)).slice(0, 3);
  out.d7_identityUnknown.realUnopenableWithOpenableChild = [];
  for (const p of real0) {
    const d = await h.call('kill-tree', { pid: p.pid, createTime: '0', dryRun: true });
    const u = await h.call('snapshot', { under: { pid: p.pid, createTime: '0' }, cmdline: false });
    out.d7_identityUnknown.realUnopenableWithOpenableChild.push({ name: p.name, ok: d.ok, error: d.error, planSize: (d.plan || []).length, underSnapshotSize: u.procs.length });
  }
  const ss = all.procs.find((p) => p.name.toLowerCase() === 'secure system');
  if (ss) { const d = await h.call('kill-tree', { pid: ss.pid, createTime: ss.createTime, dryRun: true, includeRoot: true, confirm: [`${ss.pid}:${ss.createTime}`] }); out.d7_identityUnknown.secureSystem = { createTime: ss.createTime, ok: d.ok, error: d.error, reasons: (d.protected || []).map((p) => p.reason) }; }
  // d8 (review S4-PROCGUARD-05): a host inside our own Job is "owned-host" and still needs the token
  const ro = await h.call('run-in-job', { job: 'J5b', argv: [NODE, '-e', 'setInterval(()=>{},1e3)', 'dsh', 'web', '--port', '0'], noWindow: true });
  await sleep(500); track([{ pid: ro.pid, createTime: ro.createTime, name: 'node.exe' }], 'd8-owned-dsh-web');
  const d8a = await h.call('kill-tree', { pid: ro.pid, createTime: ro.createTime, includeRoot: true });
  const d8aAlive = (await alive(obs, [{ pid: ro.pid, createTime: ro.createTime }])).length;
  const d8b = await h.call('kill-tree', { pid: ro.pid, createTime: ro.createTime, includeRoot: true, confirm: [`${ro.pid}:${ro.createTime}`] });
  await sleep(300);
  out.d8_ownedHost = { noToken: { ok: d8a.ok, error: d8a.error, reasons: (d8a.protected || []).map((p) => p.reason), stillAlive: d8aAlive }, withToken: { ok: d8b.ok, killed: (d8b.killed || []).length, aliveAfter: (await alive(obs, [{ pid: ro.pid, createTime: ro.createTime }])).length } };
  await h.call('kill-job', { job: 'J5b', waitMs: 2000 });
  // PID-reuse pruning on a synthetic snapshot
  const procs = [
    { pid: 900100, ppid: 900001, name: 'node.exe', createTime: '1000' },
    { pid: 900101, ppid: 900100, name: 'cmd.exe', createTime: '1100' },
    { pid: 900102, ppid: 900100, name: 'PING.EXE', createTime: '900' }, // older than its "parent": PID reuse, edge pruned
    { pid: 900103, ppid: 900101, name: 'PING.EXE', createTime: '1200' },
    { pid: 900104, ppid: 900102, name: 'cmd.exe', createTime: '950' }, // below the pruned edge
  ];
  const d5 = await h.call('kill-tree', { pid: 900100, createTime: '1000', dryRun: true, includeRoot: true, confirm: ['900100:1000'], procs });
  out.d5_pidReuse = { ok: d5.ok, plan: (d5.plan || []).map((p) => p.pid), pruned: d5.pruned, expectPlan: [900100, 900101, 900103] };
  const d5b = await h.call('kill-tree', { pid: 900100, createTime: '1000', procs });
  out.d5_overrideNeedsDryRun = { ok: d5b.ok, error: d5b.error };
  const d6a = await h.call('kill-tree', { pid: h.pid, createTime: h.info.createTime, dryRun: true, includeRoot: true, confirm: [`${h.pid}:${h.info.createTime}`] });
  const myCt = await createTimeOf(obs, process.pid);
  const d6b = await h.call('kill-tree', { pid: process.pid, createTime: myCt, dryRun: true });
  out.d6_self = { ok: d6a.ok, error: d6a.error, reasons: [...new Set((d6a.protected || []).map((p) => p.reason))] };
  out.d6_orchestrad = { ok: d6b.ok, error: d6b.error, reasons: [...new Set((d6b.protected || []).map((p) => p.reason))] };
  await h.end();
  await sweep(obs, tree, 'd');
  return out;
}

// ---------- e: pipe-client-pid ----------
function connectRetry(p, timeoutMs = 5000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const go = () => { const s = net.connect(p); s.once('connect', () => res(s)); s.once('error', (e) => { s.destroy(); if (Date.now() - t0 > timeoutMs) rej(e); else setTimeout(go, 20); }); };
    go();
  });
}
async function caseE(obs) {
  const h = helper('e'); await h.ready; const out = {};
  const myCt = await createTimeOf(obs, process.pid);
  const name = `pg-s4-${RUN}`;
  const pr = h.call('pipe-client-pid', { name, timeoutMs: 5000 });
  const s = await connectRetry(`\\\\.\\pipe\\${name}`);
  const r = await pr; s.destroy();
  out.e1_self = { ok: r.ok, clientPid: r.clientPid, expected: process.pid, match: r.clientPid === process.pid, createTimeMatch: r.clientCreateTime === myCt, ancestors: (r.ancestors || []).length, ms: r.ms };
  const name2 = `pg-s4-${RUN}-child`;
  const pr2 = h.call('pipe-client-pid', { name: name2, timeoutMs: 8000 });
  await sleep(200);
  const child = spawn(NODE, ['-e', "const s=require('net').connect(process.argv[1]);s.on('data',()=>{});s.on('error',()=>{});setTimeout(()=>process.exit(0),3000)", `\\\\.\\pipe\\${name2}`], { stdio: 'ignore', windowsHide: true });
  spawnedPids.push({ pid: child.pid, what: 'pipe-client-child' });
  const r2 = await pr2;
  out.e1_child = { ok: r2.ok, clientPid: r2.clientPid, expected: child.pid, match: r2.clientPid === child.pid, parentIsTest: (r2.ancestors || [])[0] === process.pid };
  // Node owns the server end: is the server-side HANDLE reachable from JS?
  const srvPath = `\\\\.\\pipe\\pg-s4-node-${RUN}`;
  const server = net.createServer(); await new Promise((res) => server.listen(srvPath, res));
  const conn = new Promise((res) => server.once('connection', (sock) => res(sock)));
  const cli = await connectRetry(srvPath);
  const sock = await conn;
  const fd = sock._handle ? sock._handle.fd : undefined;
  out.e2_nodeServer = { handleFd: fd, usable: typeof fd === 'number' && fd > 0 };
  if (out.e2_nodeServer.usable) { const d = await h.call('pipe-client-pid', { ownerPid: process.pid, handle: fd }); out.e2_nodeServer.dup = { ok: d.ok, clientPid: d.clientPid, match: d.clientPid === process.pid, error: d.error, message: d.message }; }
  cli.destroy(); sock.destroy(); server.close();
  // e3 (review S4-PROCGUARD-06, path B): Node owns the server, a child process connects, and the helper finds
  // the peer by walking Node's File handles (no handle passed from JS, no object names read).
  const srv3Path = `\\\\.\\pipe\\pg-s4-node3-${RUN}`;
  const server3 = net.createServer((sk) => { sk.on('error', () => {}); }); await new Promise((res) => server3.listen(srv3Path, res));
  const conn3 = new Promise((res) => server3.once('connection', res));
  const child3 = spawn(NODE, ['-e', "const s=require('net').connect(process.argv[1]);s.on('data',()=>{});s.on('error',()=>{});setTimeout(()=>process.exit(0),6000)", srv3Path], { stdio: 'ignore', windowsHide: true });
  spawnedPids.push({ pid: child3.pid, what: 'pipe-client-child-e3' });
  await conn3;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now(); const pp = await h.call('pipe-peers', { ownerPid: process.pid, perHandleMs: 250 });
    const hit = (pp.pipes || []).filter((x) => x.serverPid === process.pid && x.clientPid === child3.pid);
    runs.push({ ok: pp.ok, error: pp.error, message: pp.message, roundTripMs: Math.round(performance.now() - t0), helperMs: pp.ms ? +pp.ms.toFixed(1) : null, scanMs: pp.scanMs ? +pp.scanMs.toFixed(1) : null, systemHandles: pp.systemHandles, ownerFileHandles: pp.ownerFileHandles, pipeServerEnds: (pp.pipes || []).length, notPipe: pp.notPipe, dupFailed: pp.dupFailed, timeouts: pp.timeouts, foundChildAsClient: hit.length });
  }
  out.e3_pathB_handleWalk = { childPid: child3.pid, runs };
  server3.close();
  await new Promise((res) => (child3.exitCode !== null ? res() : child3.once('exit', res)));
  await h.end();
  await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res)));
  return out;
}

// ---------- f: --env-allowlist ----------
function namesOf(stdout) { return stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('=')[0]); }
async function caseF(obs) {
  const out = {};
  const allow = path.join(TMP, 'env-allow.txt');
  fs.writeFileSync(allow, '# S4 env allowlist test\nSystemRoot\nS4_COPY\nS4_LITERAL=literal\nS4_MISSING\n');
  const env = { ...process.env, S4_COPY: 'copied' }; delete env.S4_MISSING;
  out.parentSetLines = namesOf(spawnSync(CMD, ['/d', '/c', 'set'], { env, encoding: 'utf8', windowsHide: true }).stdout).length;
  const f1 = spawnSync(HELPER, ['run-in-job', '--env-allowlist', allow, '--no-window', '--', CMD, '/d', '/c', 'set'], { env, encoding: 'utf8', windowsHide: true });
  out.f1_cmdSet = { status: f1.status, lines: namesOf(f1.stdout).length, names: namesOf(f1.stdout), expected: ['S4_COPY', 'S4_LITERAL', 'SystemRoot'] };
  const f2 = spawnSync(HELPER, ['run-in-job', '--env-allowlist', allow, '--no-window', '--', NODE, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'], { env, encoding: 'utf8', windowsHide: true });
  let f2names = null; try { f2names = JSON.parse(f2.stdout); } catch {}
  out.f2_nodeKeys = { status: f2.status, names: f2names };
  const allow2 = path.join(TMP, 'env-allow-nosysroot.txt');
  fs.writeFileSync(allow2, 'S4_LITERAL=literal\n');
  const f2b = spawnSync(HELPER, ['run-in-job', '--env-allowlist', allow2, '--no-window', '--', NODE, '-e', 'process.stdout.write(String(Object.keys(process.env).length))'], { env, encoding: 'utf8', windowsHide: true });
  out.f2b_nodeWithoutSystemRoot = { status: f2b.status, stdout: f2b.stdout.trim().slice(0, 20), stderrBytes: (f2b.stderr || '').length };
  const f4 = spawnSync(HELPER, ['run-in-job', '--no-window', '--', CMD, '/d', '/c', 'exit 7'], { encoding: 'utf8', windowsHide: true });
  out.f4_exitCodePassthrough = { status: f4.status, expected: 7 };
  const h = helper('f'); await h.ready;
  const outFile = path.join(TMP, `f3-set-${RUN}.txt`);
  const r = await h.call('run-in-job', { job: 'F', argv: [CMD, '/d', '/c', 'set'], envAllowlist: allow, stdout: outFile, noWindow: true });
  { const me = [{ pid: r.pid, createTime: r.createTime }]; const t0 = performance.now(); while ((await alive(obs, me)).length && performance.now() - t0 < 10000) await sleep(50); } // wait for exit, not a fixed sleep (a loaded machine needed > 1 s)
  const txt = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  out.f3_resident = { ok: r.ok, envCount: r.envCount, lines: namesOf(txt).length, names: namesOf(txt) };
  await h.end();
  for (const f of [allow, allow2, outFile]) try { fs.unlinkSync(f); } catch {}
  return out;
}

// ---------- i: concurrent run-in-job must not leak one call's std handles into another call's child ----------
// (review S4-PROCGUARD-08) Call A opens its stdout file and holds (test-only holdMs) before spawning; call B
// spawns a long-lived ping meanwhile. If B's child inherited A's file handle, the file stays busy after A's
// child has exited. "legacy" is the old code path (inherit everything), "handleList" the fix.
async function caseI(obs) {
  const h = helper('i'); await h.ready; const out = {};
  for (const mode of ['legacy', 'handleList']) {
    const legacyInherit = mode === 'legacy'; const job = `I-${mode}`;
    const fileA = path.join(TMP, `i-${mode}-${RUN}.txt`);
    const tI = performance.now();
    const pA = h.call('run-in-job', { job, argv: [CMD, '/d', '/c', 'echo x'], stdout: fileA, holdMs: 1000, legacyInherit, noWindow: true });
    await sleep(300);
    const rB = await h.call('run-in-job', { job, cmdline: `"${CMD}" /d /c ping -t 127.0.0.1 >nul`, legacyInherit, noWindow: true });
    const tB = performance.now() - tI;
    const rA = await pA; const tA = performance.now() - tI;
    const st = await settle(obs, [rB], async (t) => pings(t) >= 1); track(st.tree, `i-${mode}`);
    const aProc = [{ pid: rA.pid, createTime: rA.createTime, name: 'cmd.exe' }];
    const tW = performance.now(); while ((await alive(obs, aProc)).length && performance.now() - tW < 5000) await sleep(50);
    await sleep(200);
    const bAlive = (await alive(obs, [{ pid: rB.pid, createTime: rB.createTime }])).length;
    const busy = await h.call('file-busy', { path: fileA });
    const k = await h.call('kill-job', { job, waitMs: 3000 });
    await sleep(200);
    const busyAfter = await h.call('file-busy', { path: fileA });
    out[mode] = { aOk: rA.ok, bOk: rB.ok, bReturnedMs: Math.round(tB), aReturnedMs: Math.round(tA), bSpawnedWhileAHeld: tB < tA && tA >= 1000, bAliveAtCheck: bAlive, fileBusyWhileBAlive: busy.busy, win32: busy.win32 ?? 0, fileBusyAfterKillJob: busyAfter.busy, killJobActive: k.activeProcesses };
    try { fs.unlinkSync(fileA); } catch (e) { out[mode].unlinkError = e.code; }
  }
  await h.end();
  return out;
}

// ---------- g: Chromium under our Job ----------
async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  return {
    send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error(`${method} timeout`)); }, 8000); pend.set(i, (j) => { clearTimeout(t); res(j); }); ws.send(JSON.stringify({ id: i, method, params })); }),
    close: () => ws.close(),
  };
}
async function caseG(obs, label, exe) {
  const out = { label, exe: path.basename(exe) };
  const udd = path.join(TMP, `udd-${label}-${RUN}`); fs.mkdirSync(udd, { recursive: true });
  const port = await freePort();
  const h = helper(`g-${label}`); await h.ready;
  const jobName = `Local\\pg-s4-g-${label}-${RUN}`;
  const args = [exe, `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'];
  const r = await h.call('run-in-job', { job: 'G', jobName, argv: args, show: 7 });
  out.spawn = { ok: r.ok, error: r.error, message: r.message, inJobBeforeResume: r.inJobBeforeResume, spawnMs: r.spawnMs };
  if (!r.ok) { await h.end(); return out; }
  let ver = null; const tUp = performance.now();
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); } catch { await sleep(250); } }
  out.devtoolsUpMs = ver ? Math.round(performance.now() - tUp) : null; out.browserVersion = ver ? ver.Browser : null;
  let text = null;
  if (ver) {
    try {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const s = await cdpSession(target.webSocketDebuggerUrl);
      const nav = await s.send('Page.navigate', { url: 'chrome://sandbox' });
      out.navigate = nav.error ? { error: nav.error.message } : { ok: true, errorText: nav.result && nav.result.errorText };
      for (let i = 0; i < 6; i++) { await sleep(1000); const ev = await s.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }); text = ev.result && ev.result.result ? ev.result.result.value : null; if (text && /renderer/i.test(text)) break; }
      s.close();
    } catch (e) { out.cdpError = String(e.message || e); }
  }
  out.sandboxTextBytes = text ? text.length : 0;
  if (text) fs.writeFileSync(path.join(EVID, `g-sandbox-${label}.txt`), text);
  await sleep(500);
  const snap = await h.call('snapshot', { under: { pid: r.pid, createTime: r.createTime }, cmdline: true, jobs: ['G'] });
  const tree = snap.procs.map((p) => ({ ...slim(p), type: p.pid === r.pid ? 'browser' : ((p.cmdline || '').match(/--type=([\w-]+)/) || [])[1] || 'other', inJob: p.inJob.G, cmdlineRead: p.cmdline !== null }));
  track(tree, `g-${label}`);
  const anyJ = await h.call('in-job', { pids: tree.map((p) => p.pid) });
  for (const p of tree) p.inAnyJob = anyJ.results.find((x) => x.pid === p.pid)?.inAnyJob;
  out.tree = tree; out.processes = tree.length; out.inOurJob = tree.filter((p) => p.inJob).length;
  out.byType = tree.reduce((m, p) => { m[p.type] = (m[p.type] || 0) + 1; return m; }, {});
  // Denominators (review S4-PROCGUARD-04): the Job's own pid list and every process of this image created since
  // launch, system-wide, taken back to back. Same-image processes outside our Job (e.g. the user's own browser)
  // are only counted, never touched.
  const jl = await h.call('job-info', { job: 'G' });
  const sys = await h.call('snapshot', { cmdline: false });
  const img = path.basename(exe).toLowerCase(); const launched = BigInt(r.createTime);
  const same = sys.procs.filter((p) => p.name.toLowerCase() === img && p.createTime !== '0' && BigInt(p.createTime) >= launched);
  const sameIJ = same.length ? await h.call('in-job', { job: 'G', pids: same.map((p) => p.pid) }) : { results: [] };
  const sameInJob = same.filter((p) => sameIJ.results.find((x) => x.pid === p.pid)?.inJob === true);
  const jobPids = new Set(jl.pids.map(Number)); const treePids = new Set(tree.map((p) => p.pid));
  const jobProcs = sys.procs.filter((p) => jobPids.has(p.pid)).map(slim);
  track([...sameInJob.map(slim), ...jobProcs], `g-${label}-denominators`);
  // For same-image processes outside our Job, record only booleans: is it from our throwaway profile, is its
  // parent ours. Their command lines are read in memory for that test and never written.
  const notIn = same.filter((p) => !sameInJob.includes(p));
  const notInCmd = notIn.length ? await h.call('snapshot', { pids: notIn.map((p) => p.pid), cmdline: true }) : { procs: [] };
  const sameBefore = new Set(sys.procs.filter((p) => p.name.toLowerCase() === img && p.createTime !== '0' && BigInt(p.createTime) < launched).map((p) => p.pid));
  const notInJobDetail = notIn.map((p) => { const c = notInCmd.procs.find((q) => q.pid === p.pid); return { usesOurProfile: c ? (c.cmdline === null ? null : c.cmdline.includes(udd)) : 'gone', parentInOurTree: treePids.has(p.ppid), parentInOurJob: jobPids.has(p.ppid), parentIsOlderSameImage: sameBefore.has(p.ppid) }; });
  out.denominators = { sameImageBeforeLaunch: sameBefore.size, notInJobDetail, treeAtSnapshot: tree.length, treeInJob: out.inOurJob, jobActive: jl.activeProcesses, jobTotalSoFar: jl.totalProcesses, jobPidList: jobPids.size, jobPidsInTree: [...jobPids].filter((p) => treePids.has(p)).length, jobPidsInSystemSnapshot: jobProcs.length, sameImageSinceLaunch: same.length, sameImageSinceLaunchInJob: sameInJob.length, sameImageSinceLaunchNotInJob: same.length - sameInJob.length, sameImageUnopenable: sys.procs.filter((p) => p.name.toLowerCase() === img && p.createTime === '0').length };
  // Our Job's limits, then Chromium's own Jobs (handles held by the browser process): does each child sit in both?
  const ji = await h.call('job-info', { job: 'G' });
  out.ourJob = { limitFlags: ji.limitFlags, uiRestrictions: ji.uiRestrictions, active: ji.activeProcesses };
  const jh = await h.call('job-handles', { ownerPid: r.pid, pids: tree.map((p) => p.pid) });
  if (jh.ok) {
    const typeOf = new Map(tree.map((p) => [p.pid, p.type]));
    out.chromiumJobs = { ms: Math.round(jh.ms), systemHandles: jh.systemHandles, browserJobHandles: jh.ownerJobHandles,
      jobs: jh.jobs.map((j) => ({ limitFlags: j.limitFlags, uiRestrictions: j.uiRestrictions, active: j.activeProcesses, dupError: j.dupError, memberTypes: (j.members || []).map((p) => typeOf.get(p) || 'unknown') })) };
    const nested = new Set(jh.jobs.flatMap((j) => j.members || []));
    for (const p of tree) p.inChromiumJob = nested.has(p.pid);
    out.inBothJobsByType = tree.filter((p) => p.inJob && p.inChromiumJob).reduce((m, p) => { m[p.type] = (m[p.type] || 0) + 1; return m; }, {});
  } else out.chromiumJobs = { error: jh.error, message: jh.message, status: jh.status };
  const t0 = performance.now();
  const k = await h.call('kill-job', { job: 'G', waitMs: 3000 });
  out.killJob = { zeroAfterMs: k.zeroAfterMs, active: k.activeProcesses, totalProcesses: k.totalProcesses, totalTerminated: k.totalTerminated };
  out.gone = await waitGone(obs, tree, 2000, t0);
  await sleep(Math.max(0, 2000 - (performance.now() - t0)));
  out.denominators.sameImageInJobAliveAfter2s = (await alive(obs, sameInJob.map(slim))).length;
  out.denominators.jobPidsAliveAfter2s = (await alive(obs, jobProcs)).length;
  const all = await h.call('snapshot', { cmdline: true });
  out.survivorsWithOurProfileAfter2s = all.procs.filter((p) => (p.cmdline || '').includes(udd)).length;
  await h.call('close-job', { job: 'G' }); await h.end();
  const tRm = performance.now(); let rmErr = null, rmTries = 0;
  for (let i = 0; i < 20; i++) { rmTries++; try { fs.rmSync(udd, { recursive: true, force: true }); rmErr = null; break; } catch (e) { rmErr = e.code || String(e); await sleep(500); } }
  out.profileDirRemoved = !fs.existsSync(udd); out.profileRm = { tries: rmTries, ms: Math.round(performance.now() - tRm), lastError: rmErr };
  await sweep(obs, tree, `g-${label}`);
  return out;
}

// ---------- side check: portable Node 24 runs at Low integrity ----------
const NODE24 = 'G:\\_Projects\\DSH-plugins\\.tools\\node24\\node.exe';
async function caseLowIL(obs) {
  const out = { node24Exists: fs.existsSync(NODE24) };
  if (!out.node24Exists) return out;
  const med = await obs.call('snapshot', { cmdline: true });
  out.medium = { integrity: R.integrity, total: med.total, raw: med.raw, openFailed: med.openFailed, cmdlineNull: med.cmdlineNull };
  const r = spawnSync(NODE24, [path.join(HERE, 'lowil-probe.cjs'), HELPER, TMP], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  spawnedPids.push({ pid: r.pid, what: 'node24-lowil-probe' });
  try { out.low = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { out.low = { status: r.status, stdoutBytes: (r.stdout || '').length }; }
  if (out.low && out.low.helperPid) spawnedPids.push({ pid: out.low.helperPid, what: 'helper:lowil (child of node24 probe)' });
  return out;
}

// ---------- h: helper cost ----------
async function caseH() {
  const out = { starts: [] };
  for (let i = 0; i < 5; i++) { const h = helper(`h${i}`); const ri = await h.ready; const s = await h.call('self'); out.starts.push({ wallMs: Math.round(ri.wallMs), startupMs: Math.round(ri.startupMs), ws: s.ws, privateBytes: s.privateBytes }); await h.end(); }
  const h = helper('h-snap'); await h.ready;
  for (const cmdline of [true, false]) {
    const rows = [];
    for (let i = 0; i < 10; i++) { const t0 = performance.now(); const r = await h.call('snapshot', { cmdline }); rows.push({ helperMs: +r.ms.toFixed(1), enumMs: +r.enumMs.toFixed(1), roundTripMs: +(performance.now() - t0).toFixed(1), total: r.total, cmdlineNull: r.cmdlineNull, openFailed: r.openFailed, jsonBytes: JSON.stringify(r).length }); }
    out[cmdline ? 'snapshotWithCmdline' : 'snapshotNoCmdline'] = rows;
  }
  const s = await h.call('self'); out.afterSnapshots = { ws: s.ws, privateBytes: s.privateBytes, peakWs: s.peakWs, threads: s.threads };
  await h.end();
  return out;
}

// ---------- Add-Type comparison ----------
function ps(cmd) {
  const t0 = performance.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, TEMP: TMP, TMP }, windowsHide: true });
  return { wallMs: Math.round(performance.now() - t0), out: (r.stdout || '').trim(), status: r.status };
}
async function caseAddType() {
  const out = { plain: [], tiny: [], fullSource: [] };
  const tail = "$p=[Diagnostics.Process]::GetCurrentProcess(); $p.Refresh(); '{0} {1} {2}' -f $sw.ElapsedMilliseconds, $p.PeakWorkingSet64, $p.WorkingSet64";
  for (let i = 0; i < 3; i++) out.plain.push(ps(`$sw=[Diagnostics.Stopwatch]::StartNew(); ${tail}`));
  for (let i = 0; i < 3; i++) out.tiny.push(ps(`$sw=[Diagnostics.Stopwatch]::StartNew(); Add-Type -TypeDefinition 'public static class PgS4Probe${i} { public static int F(){ return 1; } }'; $null=[PgS4Probe${i}]::F(); ${tail}`));
  const src = path.join(HERE, 'ProcGuard.cs');
  for (let i = 0; i < 3; i++) out.fullSource.push(ps(`$sw=[Diagnostics.Stopwatch]::StartNew(); Add-Type -Path '${src}' -ReferencedAssemblies System.Web.Extensions,System.Core; ${tail}`));
  return out;
}

// ---------- main ----------
// CPU busy % over `ms` (all cores), to put the timings in context of the machine's load.
async function cpuBusy(ms = 1000) {
  const a = os.cpus(); await sleep(ms); const b = os.cpus(); let idle = 0, tot = 0;
  b.forEach((c, i) => { for (const k of Object.keys(c.times)) { const d = c.times[k] - a[i].times[k]; tot += d; if (k === 'idle') idle += d; } });
  return tot ? Math.round(100 * (1 - idle / tot)) : null;
}
const obs = helper('observer'); await obs.ready;
R.observer = { pid: obs.pid, startupMs: obs.info.startupMs };
R.load = { cores: os.cpus().length, start: { cpuBusyPct: await cpuBusy(), processes: (await obs.call('snapshot', { cmdline: false })).total } };
const browsers = [['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'], ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']].filter(([, p]) => fs.existsSync(p));
const plan = [
  ['baseline', () => caseBaseline(obs)],
  ['a-attached', () => caseA(obs, 'attached')],
  ['a-detached', () => caseA(obs, 'detached')],
  ['b', () => caseB(obs)],
  ['c-kill-job', () => caseC(obs, 'kill-job')],
  ['c-eof', () => caseC(obs, 'eof')],
  ['d', () => caseD(obs)],
  ['e', () => caseE(obs)],
  ['f', () => caseF(obs)],
  ['i', () => caseI(obs)],
  ...browsers.map(([l, p]) => [`g-${l}`, () => caseG(obs, l, p)]),
  ['lowil', () => caseLowIL(obs)],
  ['h', () => caseH()],
  ['addtype', () => caseAddType()],
];
for (const [name, fn] of plan) {
  if (!want(name) && !want(name.split('-')[0])) continue;
  const t0 = performance.now();
  try { R.cases[name] = await fn(); } catch (e) { R.cases[name] = { error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') }; }
  R.cases[name].caseMs = Math.round(performance.now() - t0);
  console.log(`${name}: done in ${R.cases[name].caseMs} ms`);
}
// final sweep: every process we ever saw in our trees, plus every direct child
const finalAlive = await alive(obs, [...owned.values()]);
R.finalSweep = { tracked: owned.size, aliveBeforeSweep: finalAlive.map((p) => `${p.name}@${p.from}`) };
if (finalAlive.length) await sweep(obs, finalAlive, 'final');
R.finalSweep.aliveAfterSweep = (await alive(obs, [...owned.values()])).length;
R.load.end = { cpuBusyPct: await cpuBusy(), processes: (await obs.call('snapshot', { cmdline: false })).total };
R.spawnedDirect = spawnedPids;
await obs.end();
R.finishedAt = new Date().toISOString();
const file = path.join(EVID, `results-${RUN}.json`);
try { fs.writeFileSync(file, JSON.stringify(R, null, 1)); console.log('results:', file); }
catch (e) { console.log(`cannot write results (${e.code}); JSON follows`); console.log('RESULTS-JSON ' + JSON.stringify(R)); }
