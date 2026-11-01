// Prints the structure of a live.json written by probe.mjs: timeline, registry, permission
// requests, results, stream-vs-disk comparison. Structure only, like the evidence itself.
//   node summarize.mjs <live.json>
import fs from 'node:fs';

const e = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = (...a) => console.log(...a);
out(`claude ${e.claudeVersion} · sdk ${e.sdkVersion} · session ${e.sessionId} · budget $${e.budgetUsd}${e.error ? ` · error ${e.error}` : ''}`);
out('\n## timeline (ms since start)');
for (const x of e.turns) out(`  ${String(x.t).padStart(7)}  ${x.name}${x.ir ? ` ${JSON.stringify(x.ir)}` : ''}`);
out('\n## registry samples (changes only, 1 s poll)');
for (const r of e.registry) out(`  ${String(r.t).padStart(7)}  ${r.status}${r.waitingFor ? `/${r.waitingFor}` : ''}${r.entrypoint ? `  entrypoint=${r.entrypoint} kind=${r.kind} v=${r.version}` : ''}`);
out('\n## canUseTool requests');
for (const p of e.permissionRequests) out(`  ${p.t} → ${p.answeredAt}  ${p.toolName} inputKeys=${p.inputKeys.join(',')} optsKeys=${p.optsKeys.join(',')} suggestions=${p.suggestions}`);
out('\n## stream (deltas collapsed)');
let lastInit = '';
for (const r of e.stream) {
  if (r.init) {
    const sig = JSON.stringify({ ...r.init });
    out(`  ${String(r.t).padStart(7)}  system/init${sig === lastInit ? ' (same as before)' : ` model=${r.init.model} perm=${r.init.permissionMode} effort=${r.init.effort} tools=${r.init.tools.length} cmds=${r.init.slashCommands.length} apiKeySource=${r.init.apiKeySource}`}`);
    lastInit = sig;
    continue;
  }
  const extra = r.type === 'assistant' ? ` blocks=${r.blocks} len=${r.textLen} marks=${JSON.stringify(r.marks)} maxInt=${r.maxInt} model=${r.model}` : r.type === 'user' ? ` blocks=${r.blocks} priority=${r.priority} synthetic=${r.isSynthetic}` : r.type === 'result' ? ` ${JSON.stringify(r.result)}` : r.event ? ` ${r.event}${r.n ? ` ×${r.n}` : ''}` : '';
  out(`  ${String(r.t).padStart(7)}  ${r.type}/${r.subtype ?? ''}${extra}`);
}
const init = e.stream.find((r) => r.init)?.init;
if (init) {
  out('\n## first init');
  out(`  capabilities: ${(init.capabilities ?? []).join(', ')}`);
  out(`  tools: ${init.tools.join(', ')}`);
  out(`  workflow/cron/monitor-ish tools: ${init.tools.filter((x) => /workflow|cron|wake|monitor|schedule|remote|goal/i.test(x)).join(', ') || '(none)'}`);
  out(`  goal command: ${init.slashCommands.includes('goal')}; workflow-ish commands: ${init.slashCommands.filter((x) => /workflow|ultra/i.test(x)).join(', ')}`);
  out(`  skills: ${(init.skills ?? []).join(', ')}; plugins: ${(init.plugins ?? []).join(', ')}`);
}
out(`\n## settings after turns: ${JSON.stringify(e.settingsAfter)}`);
const results = e.stream.filter((r) => r.result);
const last = results[results.length - 1]?.result;
out(`\n## results: ${results.length}; last cumulative cost $${last?.costUsd}; modelUsage ${JSON.stringify(last?.modelUsage)}`);
if (e.transcript) {
  const c = {};
  for (const l of e.transcript.lines) c[l.type] = (c[l.type] ?? 0) + 1;
  out(`\n## transcript ${e.transcript.dir}: ${e.transcript.lines.length} lines ${JSON.stringify(c)}`);
  const pr = e.transcript.lines.filter((l) => l.priority);
  out(`  lines with priority: ${pr.map((l) => `${l.type}:${l.priority}`).join(', ') || '(none)'}`);
  const keysBy = {};
  for (const l of e.transcript.lines) (keysBy[l.type] ??= new Set()).add(l.keys);
  for (const [k, v] of Object.entries(keysBy)) out(`  keys ${k}: ${[...v].join(' | ')}`);
}
if (e.compare) out(`\n## stream vs disk\n${JSON.stringify(e.compare, null, 2)}`);
out(`\n## stderr: ${JSON.stringify(e.stderr)}`);
