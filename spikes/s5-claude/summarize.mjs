// S5: rebuild the REPORT.md number table from the evidence files (no claude call, no model call).
// Reads only the small JSON records written by roots.mjs / agents-probe.mjs / hang-run.mjs /
// hook-load-check.mjs / interactive-probe.mjs / passive-poll.mjs / stale-sweep.mjs and spend.mjs.
// Prints numbers, key names and enum values only.
// Per hang run it also reports the spike's own interference inside the tool_use -> permission-ask window
// (overlapping `claude agents --json` probe calls, PreToolUse hook run time), see review finding S5-CLAUDE-03.
// usage: node summarize.mjs --evidence <dir> [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ev = path.resolve(opt('--evidence', '.'));
const outFile = opt('--out', null);
const load = (n) => { try { return JSON.parse(fs.readFileSync(path.join(ev, n), 'utf8')); } catch { return null; } };
const stat = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? { n: s.length, min: s[0], p50: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] } : { n: 0 }; };

const out = {};

// ---- roots + registry ----
for (const name of ['roots.json', 'roots-recheck.json', 'roots-fix.json']) {
  const r = load(name); if (!r) continue;
  out[name] = {
    measuredAt: r.measuredAt, scriptSha256: r.scriptSha256 ?? '(older version, no hash)',
    roots: r.roots.map((x) => ({ path: x.path.replace(/^.*\\Users\\[^\\]+/, '~'), exists: x.exists, sessionsJson: x.sessionsJson, keyFilesCounted: x.sessionsKeyFilesCountedNotRead, projectsSubdirs: x.projectsSubdirs, status: x.registry?.status, kind: x.registry?.kind, entrypoint: x.registry?.entrypoint, version: x.registry?.version, statusLagMs: x.registry?.statusLagMsSummary, waitingForPresent: x.registry?.waitingForPresent, live: x.registry?.live, dead: x.registry?.dead })),
    liveClaudeCode: r.liveClaudeExe && { processes: r.liveClaudeExe.claudeCodeProcesses, inSomeRegistry: r.liveClaudeExe.inSomeRegistry, unregisteredWithinGrace: r.liveClaudeExe.unregisteredWithinGrace, notInAnyRegistry: r.liveClaudeExe.notInAnyRegistry },
  };
}

// ---- claude agents --json timings ----
const ap = load('agents-probe.json');
const hangs = Object.fromEntries(['A', 'B', 'C', 'D', 'A2'].map((l) => [l, load(`hang-${l}.json`)]).filter(([, v]) => v));
const duringRuns = Object.values(hangs).flatMap((h) => (h.agentsCalls ?? []).map((a) => a.ms));
const sweep = load('stale-sweep.json');
out.agents = {
  quietRunsMs: ap?.runs.map((r) => r.ms), quiet: ap?.msSummary,
  elementKeysQuiet: ap ? Object.keys(ap.runs[0].keys).sort() : null,
  elementKeysWhileWaiting: [...new Set(Object.values(hangs).flatMap((h) => (h.agentsCalls ?? []).filter((a) => a.status === 'waiting').map((a) => a.keys)))],
  waitingForValues: [...new Set(Object.values(hangs).flatMap((h) => (h.agentsCalls ?? []).map((a) => a.waitingFor).filter(Boolean)))],
  duringHangRuns: stat(duringRuns),
  staleSweepCallMs: sweep?.agentsMs ?? null,
  rootWritesDuringQuietCalls: ap?.rootChangesDuringCalls, rootWritesDuringEqualIdleWindow: ap?.rootChangesDuringEqualQuietWindow,
  staleSweep: sweep && { pid: sweep.pid, filesBefore: sweep.filesBefore, filesAfter: sweep.filesAfter },
};

// ---- hang runs ----
out.hang = {};
for (const [l, h] of Object.entries(hangs)) {
  const tl = h.timeline ?? {};
  const res = (h.events ?? []).find((e) => e.type === 'result');
  const regStates = (h.regSamples ?? []).map((s) => (s.reg ? `${s.reg.status ?? '(no status)'}${s.reg.waitingFor ? '/' + s.reg.waitingFor : ''}@${s.t}` : `absent@${s.t}`));
  const firstReg = (h.regSamples ?? []).find((s) => s.reg);
  const hookStart = (name) => (h.events ?? []).find((e) => e.subtype === 'hook_started' && e.hook === name)?.t ?? null;
  const toolResult = (h.events ?? []).find((e) => e.type === 'user' && (e.blocks ?? []).some((b) => b.startsWith('tool_result')));
  out.hang[l] = {
    mode: h.mode ?? (h.usePromptTool ? 'mcp' : undefined), envScrubbed: h.inheritEnv === false, pid: h.pid,
    stopReason: h.stopReason, exit: h.exitInfo,
    registryFirstSeenMs: firstReg?.t ?? null, entrypoint: firstReg?.reg?.entrypoint ?? null,
    registryStates: regStates,
    toolUseMs: tl.toolUseOnStdout,
    toolResultMs: toolResult?.t ?? null, toolResultBlocks: toolResult?.blocks ?? null,
    permissionAskMs: tl.controlRequestCanUseTool ?? tl.mcpToolsCall ?? null,
    registryWaiting: tl.registryWaitingStatusUpdatedAt != null ? { statusUpdatedAt: tl.registryWaitingStatusUpdatedAt, seenByPoll: tl.registryWaitingSeen, waitingFor: tl.registryWaitingFor } : null,
    hooks: { preToolUseStarted: hookStart('PreToolUse'), preToolUseStamp: tl.hookPreToolUse, permissionRequestStarted: hookStart('PermissionRequest'), permissionRequestStamp: tl.hookPermissionRequest, notificationAnyStamp: tl.hookNotificationAny, notificationPermissionPromptStamp: tl.hookNotificationPermissionPrompt },
    agentsFirstWaitingEndMs: tl.agentsFirstWaiting,
    scriptSha256: h.scriptSha256 ?? '(older version, no hash)',
    transcript: (h.trSamples ?? []).map((t) => `${t.last}${t.blocks ? '(' + t.blocks + ')' : ''}@${t.t}:${t.size}B`),
    transcriptChangesAfterToolUse: (h.trSamples ?? []).filter((t) => tl.toolUseOnStdout != null && t.t > tl.toolUseOnStdout + 2000).length,
    result: res ? { num_turns: res.num_turns, cost: res.cost, in: res.in, out: res.out, cacheR: res.cacheR, cacheW: res.cacheW, denials: res.denials } : null,
    registryAfterKill: h.registryAfterKill,
  };
  // derived deltas (ms)
  const o = out.hang[l]; const w = o.registryWaiting;
  o.derived = {
    toolUseToPermissionAsk: o.permissionAskMs != null && o.toolUseMs != null ? o.permissionAskMs - o.toolUseMs : null,
    registryWaitingMinusAsk: w && o.permissionAskMs != null ? w.statusUpdatedAt - o.permissionAskMs : null,
    pollLag: w ? w.seenByPoll - w.statusUpdatedAt : null,
    permissionRequestHookStampAfterAsk: o.hooks.permissionRequestStamp != null && o.permissionAskMs != null ? o.hooks.permissionRequestStamp - o.permissionAskMs : null,
    notificationAnyAfterAsk: o.hooks.notificationAnyStamp != null && o.permissionAskMs != null ? o.hooks.notificationAnyStamp - o.permissionAskMs : null,
    notificationPermissionPromptAfterAsk: o.hooks.notificationPermissionPromptStamp != null && o.permissionAskMs != null ? o.hooks.notificationPermissionPromptStamp - o.permissionAskMs : null,
    hookSpawnPreToolUse: o.hooks.preToolUseStamp != null && o.hooks.preToolUseStarted != null ? o.hooks.preToolUseStamp - o.hooks.preToolUseStarted : null,
    hookSpawnPermissionRequest: o.hooks.permissionRequestStamp != null && o.hooks.permissionRequestStarted != null ? o.hooks.permissionRequestStamp - o.hooks.permissionRequestStarted : null,
    agentsWaitingAfterRegistry: w && o.agentsFirstWaitingEndMs != null ? o.agentsFirstWaitingEndMs - w.statusUpdatedAt : null,
    autoDenyAfterToolUse: l === 'B' && o.toolResultMs != null ? o.toolResultMs - o.toolUseMs : null,
  };
  // the spike's own load inside [tool_use, permission ask] (or [tool_use, auto-deny] for B)
  const wEnd = o.permissionAskMs ?? o.toolResultMs;
  const hookResp = (name) => (h.events ?? []).find((e) => e.subtype === 'hook_response' && e.hook === name)?.t ?? null;
  o.interference = o.toolUseMs == null || wEnd == null ? null : {
    window: [o.toolUseMs, wEnd],
    agentsProbeCallsOverlapping: (h.agentsCalls ?? []).filter((a) => a.tStart < wEnd && a.tEnd > o.toolUseMs).length,
    agentsProbeBusyMsInWindow: (h.agentsCalls ?? []).reduce((acc, a) => acc + Math.max(0, Math.min(a.tEnd, wEnd) - Math.max(a.tStart, o.toolUseMs)), 0),
    preToolUseHookRunMs: hookStart('PreToolUse') != null && hookResp('PreToolUse') != null ? hookResp('PreToolUse') - hookStart('PreToolUse') : null,
    lastProbeEndToRegistryWaitingMs: w ? Math.min(...(h.agentsCalls ?? []).map((a) => (w.statusUpdatedAt >= a.tEnd ? w.statusUpdatedAt - a.tEnd : Infinity))) : null,
  };
}

// ---- zero-model launches ----
const hl = load('hook-load-check.json');
out.hookLoadCheck = hl && { exit: hl.exit, result: hl.result, assistantMessages: hl.assistantMessages, hookTags: [...new Set(hl.hooks.map((x) => x.tag))], shellFormStamped: hl.hooks.some((x) => x.tag === 'shell-form'), sessionStartOutcomes: hl.streamTypes.filter((s) => s.startsWith('system/hook_response/SessionStart')) };
const pe = load('interactive-probe-E.json');
out.interactiveProbeE = pe && { pid: pe.pid, registryEverSeen: pe.samples.some((s) => s.reg), aliveAtEnd: pe.aliveAtEnd, childImagesAtEnd: pe.childImagesAtEnd, projectDirCreated: pe.projectDirCreated };

// ---- passive registry watch + read-only stale-sweep control (2026-10-30, zero model, zero write) ----
const pp = load('passive-poll.json');
if (pp) out.passivePoll = { scriptSha256: pp.scriptSha256, final: pp.final, elapsedS: pp.elapsedS, rootsWatched: pp.rootsWatched, rounds: pp.rounds, samples: pp.samples, statusSamples: pp.statusSamples, sessionsSeen: pp.sessionsSeen, byEntrypointKindVersion: pp.byEntrypointKindVersion, newSessions: pp.newSessions, removedDuringWatch: pp.removedDuringWatch, waitingEpisodes: pp.waitingEpisodes, transitionCounts: pp.transitionCounts };
const sc = load('stale-sweep-control.json');
if (sc) out.staleSweepControl = { scriptSha256: sc.scriptSha256, controlS: sc.controlS, skipAgents: sc.skipAgents, start: sc.controlBefore?.start, end: sc.controlBefore?.end, staleRemoved: sc.controlBefore?.staleRemoved };

// ---- model spend (from spend.mjs) ----
const sp = load('spend.json');
if (sp) out.spend = sp;

const text = JSON.stringify(out, null, 1);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
