// A stand-in for `codex app-server` (orchestra app plan §2): the same stdio JSON-RPC, one object per
// line, scripted by the text of each turn. It runs under node.exe through the spawn gate's test-only
// rule codex-app-server-fake (src/os/spawn.ts FAKE_CODEX_SCRIPT), and makes no model call and no file
// outside its log. Every line it reads is appended to %FAKE_CODEX_LOG% (when set) before it acts, so a
// test reads back exactly what Orchestra sent: the handshake, the turns, and every approval answer.
//
// A turn's text picks the script (first word):
//   say <words>     a message streamed word by word, token usage, the turn ends
//   secret          a message carrying a synthetic GitHub-token-shaped string, for the redactor
//   run <cmd>       a command that asks for approval; accept runs it (output), decline declines it
//   read-outside    as run, but codex says the command reads a file outside the work dir (commandActions)
//   run-then-hold   as run, but the turn stays open until turn/interrupt
//   run-crash       asks for a command approval, then exits with code 3 before any answer
//   edit            a file change in the work dir that asks for approval
//   grant           a file change that asks to write under a root for the rest of the session
//   perm            asks for network permission
//   ask             asks the person one question, then says the answer back
//   elicit          an MCP server asks for form input
//   tool-call       a server request Orchestra does not answer (item/tool/call)
//   garbage         lines that are not JSON-RPC, a stray response, a line past 1 KiB, then says ok
//   hold            the turn stays open until turn/interrupt
// thread/start with model codex/fake-loose answers approvalPolicy 'never'; codex/fake-die exits first.
import * as fs from 'node:fs';
import * as readline from 'node:readline';

type Msg = Record<string, any>;

const logFile = process.env.FAKE_CODEX_LOG;
const record = (line: string) => {
  if (logFile !== undefined) fs.appendFileSync(logFile, `${line}\n`);
};
const send = (msg: Msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const notify = (method: string, params: Msg) => send({ method, params });
const raw = (b: string | Buffer) => process.stdout.write(b);

const THREAD = 'thr_fake';
let cwd = '';
let turnSeq = 0;
let reqSeq = 0;
let active: string | null = null;
const waiting = new Map<string, (result: any) => void>();

/** Sends a server request and waits for Orchestra's answer (its result, or {error}). */
const ask = (method: string, params: Msg): Promise<any> => {
  const id = `srv-${++reqSeq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
};

const usage = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 };

function say(turnId: string, text: string, n: number): void {
  const itemId = `msg_${n}`;
  notify('item/started', { threadId: THREAD, turnId, startedAtMs: 0, item: { type: 'agentMessage', id: itemId, text: '' } });
  const words = text.split(' ');
  words.forEach((w, i) => notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId, delta: i === 0 ? w : ` ${w}` }));
  notify('item/completed', { threadId: THREAD, turnId, completedAtMs: 0, item: { type: 'agentMessage', id: itemId, text } });
  notify('thread/tokenUsage/updated', { threadId: THREAD, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
}

function endTurn(turnId: string, status: 'completed' | 'interrupted' | 'failed' = 'completed'): void {
  if (active !== turnId) return;
  active = null;
  notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status, items: [], error: null } });
}

async function runCommand(turnId: string, n: number, command: string, hold: boolean, commandActions: Msg[] = []): Promise<void> {
  const itemId = `cmd_${n}`;
  notify('item/started', { threadId: THREAD, turnId, startedAtMs: 0, item: { type: 'commandExecution', id: itemId, command, cwd, status: 'inProgress', commandActions } });
  const r = await ask('item/commandExecution/requestApproval', {
    threadId: THREAD, turnId, itemId, command, cwd, reason: 'the script asks', startedAtMs: 0, commandActions,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], proposedExecpolicyAmendment: [command],
  });
  if (r?.decision === 'accept') {
    notify('item/commandExecution/outputDelta', { threadId: THREAD, turnId, itemId, delta: 'line one\n' });
    notify('item/commandExecution/outputDelta', { threadId: THREAD, turnId, itemId, delta: 'line two\n' });
    notify('item/completed', { threadId: THREAD, turnId, completedAtMs: 0, item: { type: 'commandExecution', id: itemId, command, cwd, status: 'completed', exitCode: 0, aggregatedOutput: 'line one\nline two\n' } });
  } else {
    notify('item/completed', { threadId: THREAD, turnId, completedAtMs: 0, item: { type: 'commandExecution', id: itemId, command, cwd, status: 'declined', exitCode: null, aggregatedOutput: null } });
  }
  if (!hold) endTurn(turnId);
}

async function fileChange(turnId: string, n: number, grant: boolean): Promise<void> {
  const itemId = `fc_${n}`;
  const changes = [{ path: `${cwd}\\notes.txt`, kind: { type: 'add' }, diff: '+hello\n' }];
  notify('item/started', { threadId: THREAD, turnId, startedAtMs: 0, item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } });
  const r = await ask('item/fileChange/requestApproval', { threadId: THREAD, turnId, itemId, reason: 'write notes', startedAtMs: 0, grantRoot: grant ? cwd : null });
  const status = r?.decision === 'accept' ? 'completed' : 'declined';
  notify('item/completed', { threadId: THREAD, turnId, completedAtMs: 0, item: { type: 'fileChange', id: itemId, changes, status } });
  endTurn(turnId);
}

async function runTurn(turnId: string, n: number, text: string): Promise<void> {
  const [word, ...rest] = text.split(' ');
  switch (word) {
    case 'say':
      say(turnId, rest.join(' '), n);
      endTurn(turnId);
      return;
    case 'secret':
      say(turnId, 'the key is ghp_0123456789abcdefghijABCDEFGHIJ ok', n);
      endTurn(turnId);
      return;
    case 'run':
      return runCommand(turnId, n, rest.join(' ') || 'echo hi', false);
    case 'read-outside':
      return runCommand(turnId, n, 'Get-Content ../elsewhere/SKILL.md', false, [{ type: 'read', command: 'Get-Content ../elsewhere/SKILL.md', name: 'SKILL.md', path: '../elsewhere/SKILL.md' }, { type: 'read', command: 'Get-Content a.txt', name: 'a.txt', path: 'a.txt' }]);
    case 'run-then-hold':
      return runCommand(turnId, n, 'echo held', true);
    case 'run-crash':
      void ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: `cmd_${n}`, command: 'echo doomed', cwd, startedAtMs: 0 });
      setTimeout(() => process.exit(3), 100);
      return;
    case 'edit':
      return fileChange(turnId, n, false);
    case 'grant':
      return fileChange(turnId, n, true);
    case 'perm': {
      await ask('item/permissions/requestApproval', { threadId: THREAD, turnId, itemId: `perm_${n}`, cwd, reason: 'needs the network', startedAtMs: 0, permissions: { network: { enabled: true } } });
      endTurn(turnId);
      return;
    }
    case 'ask': {
      const r = await ask('item/tool/requestUserInput', {
        threadId: THREAD, turnId, itemId: `q_${n}`, isBlocking: true, questions: [{ id: 'q1', header: 'Colour', question: 'Which colour?', options: null, isOther: false, isSecret: false }],
      });
      const got = r?.answers?.q1?.answers?.[0];
      say(turnId, typeof got === 'string' ? `you said ${got}` : 'no answer', n);
      endTurn(turnId);
      return;
    }
    case 'elicit': {
      await ask('mcpServer/elicitation/request', { threadId: THREAD, turnId, serverName: 'forms', mode: 'form', message: 'Fill this in', requestedSchema: { type: 'object', properties: {} } });
      endTurn(turnId);
      return;
    }
    case 'tool-call': {
      await ask('item/tool/call', { threadId: THREAD, turnId, callId: 'c1', tool: 'x', arguments: {} });
      endTurn(turnId);
      return;
    }
    case 'garbage':
      raw('not json at all\n');
      raw('[1,2,3]\n');
      raw(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
      raw('{"id":424242,"result":{}}\n');
      raw(`{"method":"warning","params":{"message":"${'a'.repeat(4096)}"}}\n`);
      raw('{"id":1}\n');
      say(turnId, 'ok', n);
      endTurn(turnId);
      return;
    case 'hold':
      return;
    default:
      say(turnId, `unknown script ${word}`, n);
      endTurn(turnId);
  }
}

function onRequest(m: Msg): void {
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      record(JSON.stringify({ env: Object.keys(process.env).sort() }));
      send({ id: m.id, result: { userAgent: 'fake-codex/0.0.0' } });
      return;
    case 'thread/start': {
      if (p.model === 'codex/fake-die') process.exit(7);
      cwd = String(p.cwd ?? '');
      const loose = p.model === 'codex/fake-loose';
      send({
        id: m.id,
        result: {
          thread: { id: THREAD, cwd, status: { type: 'idle' }, turns: [] },
          approvalPolicy: loose ? 'never' : p.approvalPolicy, approvalsReviewer: 'user',
          sandbox: { type: p.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess' },
          model: p.model, modelProvider: 'magpie', cwd,
        },
      });
      return;
    }
    case 'turn/start': {
      const n = ++turnSeq;
      const turnId = `turn_${n}`;
      active = turnId;
      send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      notify('turn/started', { threadId: THREAD, turn: { id: turnId, status: 'inProgress', items: [] } });
      const text = String(p.input?.[0]?.text ?? '');
      void runTurn(turnId, n, text);
      return;
    }
    case 'turn/steer':
      if (active !== null && p.expectedTurnId === active) send({ id: m.id, result: { turnId: active } });
      else send({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } });
      return;
    case 'turn/interrupt':
      if (active !== null && p.turnId === active) {
        send({ id: m.id, result: {} });
        endTurn(active, 'interrupted');
      } else {
        send({ id: m.id, error: { code: -32600, message: 'no such turn' } });
      }
      return;
    default:
      send({ id: m.id, error: { code: -32601, message: `fake: no ${m.method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  record(line);
  let m: Msg;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof m.method === 'string') {
    if (m.id !== undefined) onRequest(m);
    return;
  }
  const done = waiting.get(String(m.id));
  if (done !== undefined) {
    waiting.delete(String(m.id));
    done(m.error !== undefined ? { error: m.error } : m.result);
  }
});
rl.on('close', () => process.exit(0));
