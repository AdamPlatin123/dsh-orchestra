// S5: verify, per spike session, whether the model was actually called and with how many tokens.
// Reads ONLY the transcripts of the sessions this spike started: <CLAUDE_CONFIG_DIR>/projects/*s5-claude-tmp-*/<id>.jsonl
// (cwd = scratchpad/spikes/s5-claude/tmp/<run>/cwd). Opens read-only. Prints record `type` counts, model ids,
// token numbers and cost-state numbers only, never message text.
// usage: node spend.mjs [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outFile = opt('--out', null);
const pdir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
const out = { measuredAt: new Date().toISOString(), sessions: {} };
for (const d of fs.readdirSync(pdir).filter((n) => /s5-claude-tmp-.*-cwd$/.test(n))) {
  const label = d.replace(/.*s5-claude-tmp-/, '').replace(/-cwd$/, '');
  for (const f of fs.readdirSync(path.join(pdir, d)).filter((n) => n.endsWith('.jsonl'))) {
    const fd = fs.openSync(path.join(pdir, d, f), 'r');
    const buf = Buffer.alloc(fs.fstatSync(fd).size); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const types = {}; const responses = new Map(); let apiRequests = 0; let costState = null;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      types[j.type] = (types[j.type] ?? 0) + 1;
      if (j.type === 'api-request') apiRequests++;
      if (j.type === 'assistant' && j.message) {
        const u = j.message.usage ?? {};
        responses.set(j.message.id ?? j.uuid, { model: j.message.model, in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
      }
      if (j.type === 'cost-state') costState = { totalCostUSD: j.totalCostUSD, totalAPIDuration: j.totalAPIDuration, modelUsage: j.modelUsage && Object.fromEntries(Object.entries(j.modelUsage).map(([m, v]) => [m, { in: v.inputTokens, out: v.outputTokens, cacheRead: v.cacheReadInputTokens, cacheWrite: v.cacheCreationInputTokens, costUSD: v.costUSD }])) };
    }
    out.sessions[label] = { sessionIdPrefix: f.slice(0, 8), bytes: buf.length, types, apiRequests, responses: [...responses.values()], costState };
  }
}
const all = Object.values(out.sessions);
out.totals = { sessions: all.length, sessionsThatCalledModel: all.filter((s) => s.apiRequests > 0).length, apiRequests: all.reduce((a, s) => a + s.apiRequests, 0), billedUSDRecorded: all.reduce((a, s) => a + (s.costState?.totalCostUSD ?? 0), 0) };
const text = JSON.stringify(out, null, 1);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
