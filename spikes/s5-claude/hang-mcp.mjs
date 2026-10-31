// S5: minimal MCP stdio server whose only tool, approval_prompt, never answers.
// Used as `--permission-prompt-tool mcp__hang__approval_prompt` so a permission request hangs.
// JSON-RPC 2.0, newline-delimited. Logs only {t, method, id} (never params) to argv[2].
import fs from 'node:fs';

const logFile = process.argv[2];
const note = (o) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...o }) + '\n'); };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const TOOL = {
  name: 'approval_prompt',
  description: 'Permission prompt handler for a spike. It never answers.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

function handle(msg) {
  note({ method: msg.method ?? '(response)', id: msg.id ?? null });
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hang', version: '0.0.1' },
      } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
    case 'tools/call':
      return; // the point of the spike: never reply
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    default:
      if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { note({ method: '(unparsable)', bytes: line.length }); }
  }
});
process.stdin.on('end', () => { note({ method: '(stdin-eof)' }); process.exit(0); });
note({ method: '(started)', pid: process.pid });
