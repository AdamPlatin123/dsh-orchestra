// S5: hook command (exec form: command = node, args = [this file, <log>, <tag>, ...]).
// Appends {t, tag} at process start, then {t, tag, ev, nt, tool, detail:true} once stdin is read.
// Never prints to stdout, so it never changes Claude's decision; exits 0
// (or 2 with --exit2, used only to block a prompt in the zero-cost hook-loading check).
import fs from 'node:fs';

const t = Date.now();
const [out, tag = ''] = process.argv.slice(2);
const exit2 = process.argv.includes('--exit2');
fs.appendFileSync(out, JSON.stringify({ t, tag }) + '\n');
let data = '';
let finished = false;
const done = (extra) => {
  if (finished) return; finished = true;
  let j = {};
  try { j = JSON.parse(data); } catch { /* empty or partial stdin */ }
  fs.appendFileSync(out, JSON.stringify({ t: Date.now(), tag, ev: j.hook_event_name, nt: j.notification_type, tool: j.tool_name, detail: true, ...extra }) + '\n');
  if (exit2) process.stderr.write('blocked by S5 hook-loading check\n');
  process.exit(exit2 ? 2 : 0);
};
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => done({}));
process.stdin.on('error', () => done({ stdinError: true }));
setTimeout(() => done({ stdinTimeout: true }), 1500);
