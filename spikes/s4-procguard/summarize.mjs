// Prints the headline numbers of one test.mjs results file (the table in REPORT.md §3).
// usage: node summarize.mjs <evidence\results-XXXX.json>
import fs from 'node:fs';

const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const C = R.cases;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const rng = (a) => (a.length ? `${Math.min(...a)}–${Math.max(...a)} (median ${med(a)})` : 'n/a');
const out = [];
const row = (k, v) => out.push(`${k.padEnd(44)} ${v}`);

row('run / node / integrity', `${R.run} / ${R.node} / ${R.integrity}`);
if (R.load) row('load: CPU busy % start→end, processes', `${R.load.start.cpuBusyPct}→${R.load.end?.cpuBusyPct} %, ${R.load.start.processes}→${R.load.end?.processes}`);
if (C.baseline) row('baseline (no procguard): survivors after 4 s', `${C.baseline.survivorsAfterKill.join(',') || 'none'} (tree ${C.baseline.tree.length})`);
for (const v of ['a-attached', 'a-detached']) {
  const a = C[v]; if (!a) continue;
  row(`${v}: tree / in our Job / ping / http before`, `${a.tree.length} / ${a.inJobCount} / ${a.tree.filter((p) => p.name.toUpperCase() === 'PING.EXE').length} / ${a.httpBefore}`);
  row(`${v}: taskkill→all gone; orch exit→all gone`, `${a.gone.allGoneMs} ms; ${a.goneAfterOrchExitMs} ms (survivors ${a.gone.survivors}, job name after: win32=${a.jobOpenAfter.win32 ?? 'open'})`);
}
if (C.b) row('b: kill-job active before→after, zero after', `${C.b.before.active}→${C.b.after.active}, ${C.b.killJob.zeroAfterMs.toFixed(2)} ms, survivors ${C.b.gone.survivors}`);
for (const v of ['c-kill-job', 'c-eof']) { const c = C[v]; if (!c) continue; row(`${v}: in both Jobs / survivors / gone`, `${c.inBoth} / ${c.gone.survivors} / ${c.gone.allGoneMs} ms, inner job after: win32=${c.innerJobAfter.win32 ?? 'open'}`); }
if (C.d) {
  const d = C.d;
  row('d1 wrong createTime', `${d.d1_wrongCreateTime.error}, alive ${d.d1_wrongCreateTime.stillAlive}/${d.d1_wrongCreateTime.of}`);
  if (d.d2a_rootWithoutToken) row('d2a includeRoot without root token', `${d.d2a_rootWithoutToken.error} (${d.d2a_rootWithoutToken.reasons}), alive ${d.d2a_rootWithoutToken.stillAlive}/${d.d2a_rootWithoutToken.of}`);
  row('d2 exact kill-tree (default: descendants)', `ok=${d.d2_exact.ok}, ${d.d2_exact.gone.allGoneMs} ms, rounds ${d.d2_exact.rounds}, killed ${d.d2_exact.killedNames}, root killed ${d.d2_exact.rootKilled}`);
  if (d.d3_protectedHost.descendantsOnlyNoToken) row('d3 dsh-web host: descendants only, no token', `${d.d3_protectedHost.descendantsOnlyNoToken.error} (${d.d3_protectedHost.descendantsOnlyNoToken.reasons})`);
  row('d3 dsh-web host: no token / token', `${d.d3_protectedHost.noToken.error} (${d.d3_protectedHost.noToken.reasons}) / ok=${d.d3_protectedHost.withToken.ok}, killed ${d.d3_protectedHost.withToken.killedNames ?? d.d3_protectedHost.withToken.killed}, alive after ${d.d3_protectedHost.withToken.aliveAfter}`);
  row('d4 explorer / winlogon(+token) dry run', `${d.d4_explorerDry.rootReason ?? d.d4_explorerDry.error} / ${d.d4_winlogonDryWithToken.rootReason ?? d.d4_winlogonDryWithToken.error}`);
  if (d.d7_identityUnknown) {
    const u = d.d7_identityUnknown;
    row('d7 createTime 0: synthetic', `ok=${u.synthetic.ok} ${u.synthetic.error ?? ''} plan [${u.synthetic.plan}]`);
    row('d7 createTime 0: real unopenable roots', u.realUnopenableWithOpenableChild.map((x) => `${x.name}: ${x.error ?? 'ok'} plan ${x.planSize} under ${x.underSnapshotSize}`).join('; ') || 'none found');
    if (u.secureSystem) row('d7 Secure System (+token)', `${u.secureSystem.error} ${u.secureSystem.reasons} (createTime ${u.secureSystem.createTime})`);
  }
  if (d.d8_ownedHost) row('d8 dsh-web host inside our Job: no token / token', `${d.d8_ownedHost.noToken.error} (${d.d8_ownedHost.noToken.reasons}), alive ${d.d8_ownedHost.noToken.stillAlive} / ok=${d.d8_ownedHost.withToken.ok}, alive after ${d.d8_ownedHost.withToken.aliveAfter}`);
  row('d5 PID-reuse pruning plan', `${d.d5_pidReuse.plan} (expect ${d.d5_pidReuse.expectPlan}), pruned ${d.d5_pidReuse.pruned}`);
  row('d6 self / orchestrad', `${d.d6_self.reasons} / ${d.d6_orchestrad.reasons}`);
}
if (C.e) row('e pipe-client-pid self / child / node-owned', `${C.e.e1_self.match} / ${C.e.e1_child.match} / fd=${C.e.e2_nodeServer.handleFd}`);
if (C.e && C.e.e3_pathB_handleWalk) for (const x of C.e.e3_pathB_handleWalk.runs) row('e3 path B: found / round trip / scan ms', `${x.foundChildAsClient} (pipe handles ${x.pipeServerEnds}, file handles ${x.ownerFileHandles}, timeouts ${x.timeouts}, dupFailed ${x.dupFailed}) / ${x.roundTripMs} ms / ${x.scanMs} ms ${x.error ?? ''}`);
if (C.i) for (const m of ['legacy', 'handleList']) { const x = C.i[m]; if (x) row(`i ${m}: B during A's hold / file busy while B alive / after kill`, `${x.bSpawnedWhileAHeld} (B ${x.bReturnedMs} ms, A ${x.aReturnedMs} ms) / ${x.fileBusyWhileBAlive} (win32 ${x.win32}) / ${x.fileBusyAfterKillJob}`); }
if (C.f) row('f env: cmd set names / node keys', `${C.f.f1_cmdSet.names.length} (${C.f.f1_cmdSet.names}) / ${C.f.f2_nodeKeys.names}; parent had ${C.f.parentSetLines}; exit ${C.f.f4_exitCodePassthrough.status}`);
for (const v of ['g-chrome', 'g-edge']) {
  const g = C[v]; if (!g) continue;
  row(`${v}: ${g.browserVersion}`, `in Job ${g.inOurJob}/${g.processes} ${JSON.stringify(g.byType)}; kill-job→0 ${g.killJob.zeroAfterMs.toFixed(1)} ms; survivors ${g.gone.survivors}, profile procs after 2 s ${g.survivorsWithOurProfileAfter2s}; sandbox text ${g.sandboxTextBytes} B`);
  if (g.ourJob) row(`${v}: our Job limitFlags / UI`, `0x${g.ourJob.limitFlags.toString(16)} / ${g.ourJob.uiRestrictions}`);
  if (g.denominators) { const x = g.denominators; row(`${v}: tree / Job active / Job pid list / total`, `${x.treeInJob}/${x.treeAtSnapshot} / ${x.jobActive} / ${x.jobPidList} (in tree ${x.jobPidsInTree}) / ${x.jobTotalSoFar} (at snapshot), ${g.killJob.totalProcesses} (at kill)`); row(`${v}: same image since launch: in Job / not / alive 2 s after`, `${x.sameImageSinceLaunchInJob}/${x.sameImageSinceLaunch} / ${x.sameImageSinceLaunchNotInJob} / ${x.sameImageInJobAliveAfter2s} (job pids alive ${x.jobPidsAliveAfter2s}; unopenable same image ${x.sameImageUnopenable})`); }
  if (g.chromiumJobs && g.chromiumJobs.jobs) {
    const kinds = {}; for (const j of g.chromiumJobs.jobs) { const k = `limit 0x${(j.limitFlags ?? 0).toString(16)} ui 0x${(j.uiRestrictions ?? 0).toString(16)} [${j.memberTypes}]`; kinds[k] = (kinds[k] || 0) + 1; }
    row(`${v}: Chromium Jobs (${g.chromiumJobs.browserJobHandles}) / in both Jobs`, `${JSON.stringify(kinds)} / ${JSON.stringify(g.inBothJobsByType)}`);
  }
  if (g.profileRm) row(`${v}: profile dir rm tries / ms / last error`, `${g.profileRm.tries} / ${g.profileRm.ms} / ${g.profileRm.lastError}`);
}
if (C.lowil) row('lowil: medium vs Low (node24) snapshot', `${C.lowil.medium.total} vs ${C.lowil.low.total} processes; Low write tmp: ${C.lowil.low.writeTmp}`);
if (C.h) {
  const h = C.h;
  row('h helper start wall ms', rng(h.starts.map((s) => s.wallMs)));
  row('h helper WS / private MB at start', `${rng(h.starts.map((s) => +(s.ws / 1048576).toFixed(1)))} / ${rng(h.starts.map((s) => +(s.privateBytes / 1048576).toFixed(1)))}`);
  row('h after 20 snapshots WS / peak / private MB', `${(h.afterSnapshots.ws / 1048576).toFixed(1)} / ${(h.afterSnapshots.peakWs / 1048576).toFixed(1)} / ${(h.afterSnapshots.privateBytes / 1048576).toFixed(1)}`);
  row('h snapshot+cmdline helper ms / round trip', `${rng(h.snapshotWithCmdline.map((r) => r.helperMs))} / ${rng(h.snapshotWithCmdline.map((r) => r.roundTripMs))}`);
  row('h snapshot no cmdline helper ms / round trip', `${rng(h.snapshotNoCmdline.map((r) => r.helperMs))} / ${rng(h.snapshotNoCmdline.map((r) => r.roundTripMs))}`);
  row('h processes / not openable / JSON KB', `${h.snapshotWithCmdline[0].total} / ${h.snapshotWithCmdline[0].openFailed} / ${Math.round(h.snapshotWithCmdline[0].jsonBytes / 1024)} (no cmdline ${Math.round(h.snapshotNoCmdline[0].jsonBytes / 1024)})`);
}
if (C.addtype) {
  const p = (rows) => rows.map((r) => { const n = r.out.split(/\r?\n/).pop().split(' ').map(Number); return { wall: r.wallMs, inner: n[0], ws: +(n[2] / 1048576).toFixed(1) }; });
  for (const k of ['plain', 'tiny', 'fullSource']) { const x = p(C.addtype[k]); row(`addtype ${k}: wall / Add-Type ms / WS MB`, `${rng(x.map((r) => r.wall))} / ${rng(x.map((r) => r.inner))} / ${rng(x.map((r) => r.ws))}`); }
}
if (R.finalSweep) row('final sweep: tracked / alive after', `${R.finalSweep.tracked} / ${R.finalSweep.aliveAfterSweep}`);
console.log(out.join('\n'));
