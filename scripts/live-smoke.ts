// The live end-to-end run of an owned session (orchestra app step 4): orchestrad in the test profile with
// --owned, driven over HTTP exactly as the page drives it, against the real codex.exe or the Claude host
// and the local magpie gateway (http://127.0.0.1:3425, no key). Not part of the test run.
//   node scripts/live-smoke.ts --harness codex|claude [--model <id>] [--outside | --brake [--via-subagent] | --daemon-stop | --daemon-kill | --project-root | --subagent [--pair] | --subagent-stop [--loose] | --root-stop | --dispatch-tool] [--keep]
//
// --dispatch-tool (orchestra app plan 派活权限): one worker of this harness, told to call the dispatch tool, through both
// levels and what no level opens. 派前问你: a card with the worker as its requester and nothing started; the run stands in for
// the person and presses 派出. 直接派出: the run sets the level (POST /api/owned/:id/dispatch-grant), and the next call
// starts a session with no card. At the limit of running sessions the next call is refused and the worker told. Away (no
// read of the list for longer than the heartbeat): the level goes back to a card, which is rejected. A seat request
// (signed, over the agent port) stays a card with every level open; dispatched, its session is tainted: at 直接派出 its call
// is a card too, and what that dispatches is tainted. It passes only if each of those held, the agent port answers 404 to
// the permission's route, level away is refused, what was dispatched starts at 派前问你, the journal has exactly one `auto`
// record, on the right sessions and the person's grant, `route` lines of mode manual and auto to match, no `human` record
// for the session the level started, and nothing of a Job is left.
//
// --subagent (orchestra app plan 子代理): the task is to spawn one sub-agent that runs one ping and
// to wait for it. Each round the run reads GET /api/tower (it answers only what passes the tower contract), and
// reports the states the sub-agent's node went through, whether it had a name and a duration, its model, how
// many of its steps ran unasked, whether the feed stayed the root's (no tool row), and whether each card said
// which sub-agent asked. Its node's state after the session ended is read too. Never the name itself: the
// model chose it. It passes only if every sub-agent got to returned, named, with a duration, one card said
// which, the feed holds no tool row, every tower read answered 200, and the feed has a dispatch row for each
// sub-agent: its ref the node's id, its batch the node's, and a name in the end. With --pair the task is to spawn two
// at once: the report says how many batches they made (the model decides how it spawns, so that is a finding, not a
// pass or fail), and it must see two. With --harness claude the sub-agent is a background one and the root's turn ends
// before it does: the run waits for it to be over and for the turn it wakes, and starting it is a card of its own.
//
// --subagent-stop (orchestra app plan 子代理): the stop, pressed as the page does (POST
// /api/owned/:id/interrupt) while a sub-agent's `ping -n 120` runs, twice in one session: first with the root
// turn waiting for the sub-agent, then, after a message that spawns another and does not wait, with the root idle.
// After each press the run checks by pid + creation time that the ping and the shell around it are gone, that
// the Job holds nothing but what stays there with no command (JOB_RESIDENTS: read before the Job closes, or the
// close would take a shell the stop left), that the node is ended, that the feed's final word is members-stopped=1
// (at most 15 s, far inside the ping's own two minutes), and that the session itself still stands idle. The list
// must have offered the stop before the press (the page's button goes by it) and offer it no more after, and the
// record on disk must count no step failed or run unasked. It passes only if both rounds did, every tower read
// answered 200, and nothing of the Job is left after the end. With --harness claude the first sub-agent runs in the
// foreground (run_in_background false, so the root's turn waits for it) and the second in the background.
// With --loose (Claude only, one round) the sub-agent's command first lets a `ping -t` go with Start-Process, a process no
// frame ever names, and the stop comes during the ping it then runs: it passes only if that ping is still in the Job after the
// stop, the feed's final word is members-job-left, never members-stopped, the stop stays on offer, and the end takes it.
//
// --root-stop (orchestra app plan 派发和拉线, codex only): the stop, pressed as the page does while the root's own
// `ping -n 120` runs. After the press the run checks by pid + creation time that the ping and the shell around it are
// gone and that the Job holds only JOB_RESIDENTS, that the feed's final word is commands-stopped=1 (at most 15 s), that
// the command's end reads stopped, not failed, that no ran-unasked note came of it, that the session stands idle with no
// stop left on offer, and then that a message opens a new turn and gets a reply. It passes only if all of that held and
// nothing of the Job is left after the end.
//
// --daemon-kill (orchestra app plan 进程树的 Job 回收, residual 2): orchestrad is killed while a turn runs.
// The task is to run `ping -n 60 127.0.0.1` and wait for it; once the approval was given and PING.EXE is
// in the session's Job, orchestrad gets child.kill() (TerminateProcess on Windows: its stdin is not closed
// first, its own stop never runs). The run then checks by pid + creation time, with its own procguard,
// how many of the Job's processes are still alive (polled for 20 s, well inside the ping's own minute)
// and whether the Job can still be opened by its name (it can while anything holds a handle to it: the
// wrapper, above all). Then it starts orchestrad again on the same test dir, pairs and unlocks again, and
// reports what GET /api/owned and the record on disk say of the session (state, endReason).
//
// --project-root (orchestra app plan 项目根): the run makes <test dir>\proj, starts orchestrad with
// --project-root on it, checks GET /api/owned lists it, and dispatches the session with root set to it (as
// the page's work dir select does). The file is looked for in that root, not in the session's work dir;
// the report says whether the session's own work dir was made at all (it should not be) and what the list
// said of the session's cwd.
//
// --daemon-stop (orchestra app: stdin-EOF shutdown): after the reply the session is not ended through the
// page; orchestrad's stdin is closed instead, as when the program that started it goes away. The run
// checks that orchestrad exited by itself (not killed), that the session's record on disk ended with
// daemon-stop, and by pid + creation time that nothing of the session's Job survived.
//
// --brake (orchestra app: owned sessions in procguard Jobs): the task is instead to start a ping that
// keeps running (Start-Process, so it outlives the command that started it), the run waits until that
// PING.EXE is in the session's Job, presses the brake (POST /api/owned/:id/brake, as the page does) and
// checks by pid + creation time that none of the Job's processes survived. Every run reports what its
// Job held before the end and how many of those processes are still alive after it. With --via-subagent
// (--harness claude) a sub-agent starts that ping: what it lets out of its own command must be in the Job too.
//
// --outside: the task is instead to read a synthetic file the script writes in the test dir, outside the
// session's work dir; the report says whether the harness asked about it (approvals by kind and risk) or
// ran it without asking (ran-unasked notes). It answers whether a read outside the work dir is asked about.
//
// What it does: makes %TEMP%\orchestra-test-smoke-XXXX (the test profile's dir, its data dir inside),
// starts orchestrad from this repository (src/boot.ts) with --test-profile --test-dir <it> --peek-port
// <free port> --owned, reads the pairing code and the unlock code from orchestrad's stdout, pairs
// (POST /pair, form field code=, Host orchestra.localhost:<port>, Origin), unlocks (POST
// /api/owned/unlock-code, then /api/owned/unlock), dispatches one session (POST /api/owned/new) whose
// task is to write a file in its work dir and read it back, allows each approval it raises (POST
// /api/approvals/:id/allow with the card's digest and the list's rev: this script stands in for the
// person, on this one synthetic task, in a throwaway test dir), waits for the reply, checks the file on
// disk, ends the session and stops orchestrad.
//
// What it prints: event kinds and counts, the session's states, the approvals by kind, whether the file
// is there with the content asked for, and what was left running (scripts/live-common.ts leftovers). Never
// the model's words, a path outside the test dir, a code or a token. The test dir is removed at the end
// unless --keep is given.
//
// Leaving nothing behind: every request has a 30 s deadline, and the loop checks the time limit after each
// one; whatever happens, a session that was dispatched is ended through orchestrad (POST /end, then the
// stop order is waited out; with --daemon-stop through orchestrad's own stop instead), orchestrad is
// stopped by closing its stdin (killed only if it has not exited 15 s later), and the children orchestrad
// recorded are looked for afterwards (a Job still there is ended by its name; a pid without a Job is only
// counted, never ended: scripts/live-common.ts leftovers).
//
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts): it spawns orchestrad, speaks HTTP to it on
// 127.0.0.1, waits on timers and reads the one file the session wrote in its test dir; it touches no
// harness root.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_JOB_RESIDENTS } from '../src/owned/claude-session.ts';
import { AGENT_AUTH, AGENT_TOKEN_FILE, agentPipeName, agentRequestMac } from '../src/server/agent-port.ts';
import { endAndWait, endReasonOnDisk, jobsOf, leftovers, membersOnDisk, type probe, probeOf, type Reply, request, sleep, stopDaemon } from './live-common.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const FILE = 'smoke.txt';
const WORD = 'orchestra-smoke-ok';
const TASK = `Create a file named ${FILE} in the current working directory containing exactly the text ${WORD}, then read the file back and tell me what it contains.`;
const LIMIT_MS = 6 * 60 * 1000;

const OUTSIDE_FILE = 'outside-probe.txt';
const OUTSIDE_WORD = 'orchestra-outside-probe';
const outsideTask = (file: string) => `Run a shell command that prints the contents of the file ${file} and tell me the word it contains. Do not change any file.`;
const BRAKE_TASK = 'Run exactly this one shell command, once, and then reply with the single word started: '
  + 'powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList \'-t\',\'127.0.0.1\'"';

const KILL_TASK = 'Run exactly this one shell command, once, wait until it has finished, and then reply with the single word finished: ping -n 60 127.0.0.1';
const SUBAGENT_TASK = 'Spawn exactly one sub-agent with the task name ping_once. Its task: run exactly this one shell command, once, and report back: ping -n 2 127.0.0.1. '
  + 'Do not run the command yourself. Wait for the sub-agent to finish, and then reply with the single word finished.';

const SUBAGENT_PAIR_TASK = 'In one step, spawn exactly two sub-agents at once, with the task names ping_a and ping_b. The task of each: run exactly this one shell command, once, and report back: ping -n 2 127.0.0.1. '
  + 'Do not run the command yourself. Wait for both sub-agents to finish, and then reply with the single word finished.';

const ROOT_STOP_TASK = 'Run exactly this one shell command yourself, once, in the foreground, wait until it has finished, and then reply with the single word finished: `ping -n 120 127.0.0.1` ';
const ROOT_AGAIN_TASK = 'Reply with the single word again. Do not run anything.';

const SUBAGENT_STOP_TASK = 'Spawn exactly one sub-agent with the task name ping_wait. Its task: run exactly this one shell command, once, wait for it, and report back: `ping -n 120 127.0.0.1` '
  + 'Do not run the command yourself. Wait for the sub-agent to finish, and then reply with the single word finished.';
const SUBAGENT_FREE_TASK = 'Spawn exactly one more sub-agent with the task name ping_free. Its task: run exactly this one shell command, once, wait for it, and report back: `ping -n 120 127.0.0.1` '
  + 'Do not run the command yourself and do not wait for the sub-agent: as soon as it is spawned, end your turn by replying with the single word spawned.';

/** The same four tasks in the words of the Claude CLI's Agent tool. */
const CLAUDE_TASKS = {
  one: 'Use the Agent tool exactly once, with subagent_type general-purpose and the description ping_once. Its prompt: run exactly this one shell command, once, and report back: ping -n 2 127.0.0.1. '
    + 'Do not run the command yourself. When it has reported, reply with the single word finished.',
  pair: 'In one single reply, call the Agent tool exactly twice, both with subagent_type general-purpose, with the descriptions ping_a and ping_b. The prompt of each: run exactly this one shell command, once, and report back: ping -n 2 127.0.0.1. '
    + 'Do not run the command yourself. When both have reported, reply with the single word finished.',
  stop: 'Use the Agent tool exactly once, with run_in_background false, subagent_type general-purpose and the description ping_wait. Its prompt: run exactly this one shell command in the foreground, once, wait for it, and report back: `ping -n 120 127.0.0.1` '
    + 'Do not run the command yourself. When it has reported, reply with the single word finished.',
  brake: 'Use the Agent tool exactly once, with subagent_type general-purpose and the description ping_loose. Its prompt: run exactly this one shell command, once, and report back: '
    + 'powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList \'-t\',\'127.0.0.1\'" Do not run the command yourself.',
  loose: 'Use the Agent tool exactly once, with run_in_background false, subagent_type general-purpose and the description ping_loose. Its prompt: run exactly this one shell command in the foreground, once, wait for it, and report back: '
    + 'powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList \'/c\',\'start\',\'/b\',\'ping\',\'-t\',\'127.0.0.1\'; ping.exe -n 120 127.0.0.1" Do not run the command yourself. When it has reported, reply with the single word finished.',
  free: 'Use the Agent tool exactly once more, with run_in_background true, subagent_type general-purpose and the description ping_free. Its prompt: run exactly this one shell command in the foreground, once, wait for it, and report back: `ping -n 120 127.0.0.1` '
    + 'Do not run the command yourself and do not wait for it: as soon as it is spawned, end your turn by replying with the single word spawned.',
};
/** How long a Claude run waits for the turn a background sub-agent's end wakes. */
const WAKE_MS = 45_000;
/** How long a stop has to show what it did, far inside the ping's own two minutes. */
const STOP_CHECK_MS = 15_000;
/** The stop order of the sessions a run ended, before orchestrad goes (scripts/live-common.ts STOP_ORDER_MS). */
const STOP_SETTLE_MS = 5_500;
/** What stays in a session's Job with no command running (measured after a clean, 2026-11-04): anything else is a command's. */
const JOB_RESIDENTS: ReadonlySet<string> = new Set(['codex.exe', 'codex-code-mode-host.exe', 'conhost.exe']);

function args(): { harness: 'codex' | 'claude'; model: string | null; keep: boolean; outside: boolean; brake: boolean; viaSubagent: boolean; daemonStop: boolean; daemonKill: boolean; projectRoot: boolean; subagent: boolean; pair: boolean; subagentStop: boolean; loose: boolean; rootStop: boolean; dispatchTool: boolean } {
  const a = process.argv.slice(2);
  let harness: string | null = null;
  let model: string | null = null;
  let keep = false;
  let outside = false;
  let brake = false;
  let viaSubagent = false;
  let daemonStop = false;
  let daemonKill = false;
  let projectRoot = false;
  let subagent = false;
  let pair = false;
  let subagentStop = false;
  let loose = false;
  let rootStop = false;
  let dispatchTool = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--harness') harness = a[++i] ?? null;
    else if (a[i] === '--model') model = a[++i] ?? null;
    else if (a[i] === '--keep') keep = true;
    else if (a[i] === '--outside') outside = true;
    else if (a[i] === '--brake') brake = true;
    else if (a[i] === '--via-subagent') viaSubagent = true;
    else if (a[i] === '--daemon-stop') daemonStop = true;
    else if (a[i] === '--daemon-kill') daemonKill = true;
    else if (a[i] === '--project-root') projectRoot = true;
    else if (a[i] === '--subagent') subagent = true;
    else if (a[i] === '--pair') pair = true;
    else if (a[i] === '--subagent-stop') subagentStop = true;
    else if (a[i] === '--loose') loose = true;
    else if (a[i] === '--root-stop') rootStop = true;
    else if (a[i] === '--dispatch-tool') dispatchTool = true;
    else throw new Error(`live-smoke: unknown argument ${a[i]}`);
  }
  if (harness !== 'codex' && harness !== 'claude') throw new Error('live-smoke: --harness codex|claude');
  if ([outside, brake, daemonStop, daemonKill, projectRoot, subagent, subagentStop, rootStop, dispatchTool].filter(Boolean).length > 1) throw new Error('live-smoke: one of --outside, --brake, --daemon-stop, --daemon-kill, --project-root, --subagent, --subagent-stop, --root-stop, --dispatch-tool');
  if (rootStop && harness !== 'codex') throw new Error('live-smoke: --root-stop is for --harness codex');
  if (pair && !subagent) throw new Error('live-smoke: --pair goes with --subagent');
  if (viaSubagent && (!brake || harness !== 'claude')) throw new Error('live-smoke: --via-subagent goes with --brake and --harness claude');
  if (loose && (!subagentStop || harness !== 'claude')) throw new Error('live-smoke: --loose goes with --subagent-stop and --harness claude');
  return { harness, model, keep, outside, brake, viaSubagent, daemonStop, daemonKill, projectRoot, subagent, pair, subagentStop, loose, rootStop, dispatchTool };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}


type Daemon = {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  /** Settles once its stdio closed. */
  exited: Promise<number | null>;
  /** Settles once the process itself exited (its stdio may close later). */
  exitedProc: Promise<number | null>;
  port: number;
  waitLine(re: RegExp, from?: number, ms?: number): Promise<RegExpExecArray>;
};

/** orchestrad from this repository in the test profile on <testDir>, on a free port. */
async function startDaemon(testDir: string, extra: string[]): Promise<Daemon> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'boot.ts'), '--test-profile', '--test-dir', testDir, '--peek-port', String(port), '--owned', ...extra], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const lines: string[] = [];
  let tail = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    tail += d;
    const parts = tail.split(/\r?\n/);
    tail = parts.pop() ?? '';
    lines.push(...parts);
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>((r) => child.on('close', r));
  const exitedProc = new Promise<number | null>((r) => child.on('exit', r));
  const waitLine = async (re: RegExp, from = 0, ms = 30_000): Promise<RegExpExecArray> => {
    for (let waited = 0; waited < ms; waited += 50) {
      for (let i = from; i < lines.length; i++) {
        const m = re.exec(lines[i]!);
        if (m !== null) return m;
      }
      await sleep(50);
    }
    throw new Error(`live-smoke: orchestrad did not print ${re}`);
  };
  return { child, lines, exited, exitedProc, port, waitLine };
}

type Api = { get(p: string): Promise<Reply>; post(p: string, body: Record<string, unknown>): Promise<Reply>; owned: string[] };

/** Pairs (the form, as the page posts it) and unlocks (the code goes to orchestrad's console only): the owned API's GET and POST. */
async function connect(d: Daemon): Promise<Api> {
  const { port, lines, waitLine } = d;
  const host = `orchestra.localhost:${port}`;
  const origin = `http://${host}`;
  const pair = (await waitLine(/pairing code (\d{8})/))[1]!;
  await waitLine(/peek page at /);
  const owned = lines.filter((l) => /owned (Codex|Claude) sessions (on|are off)/.test(l)).map((l) => l.replace(/ \(model .*$/, '').replace(/^orchestrad: /, ''));
  const paired = await request(port, host, 'POST', '/pair', { origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${pair}`);
  if (paired.status !== 303) throw new Error(`live-smoke: pairing answered ${paired.status}`);
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!;
  const before = lines.length;
  const asked = await request(port, host, 'POST', '/api/owned/unlock-code', { cookie, origin, 'sec-fetch-site': 'same-origin' });
  if (asked.status !== 204) throw new Error(`live-smoke: unlock-code answered ${asked.status}`);
  const unlockCode = (await waitLine(/unlock code (\d{8})/, before))[1]!;
  const json = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const unlocked = await request(port, host, 'POST', '/api/owned/unlock', json, JSON.stringify({ code: unlockCode }));
  if (unlocked.status !== 200) throw new Error(`live-smoke: unlock answered ${unlocked.status}`);
  const h = { ...json, 'x-orchestra-csrf': String(unlocked.json.csrf) };
  return {
    owned,
    get: (p: string) => request(port, host, 'GET', p, { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-orchestra-csrf': h['x-orchestra-csrf'] }),
    post: (p: string, body: Record<string, unknown>) => request(port, host, 'POST', p, h, JSON.stringify({ actionId: crypto.randomUUID(), ...body })),
  };
}

const isPing = (p: { image: string | null }) => (p.image ?? '').toLowerCase() === 'ping.exe';

/** The heartbeat's limit (src/route/presence.ts PRESENCE_LIMITS.beatMs) and a margin: this long without a read of the list is away. */
const AWAY_MS = 32_000;
const DISPATCH_MODEL = 'zcode/GLM-5.3';
const dispatchTask = (tool: string, harness: string) => `Call the tool ${tool} exactly once, with task "Reply with the single word pong. Do not run anything." and harness ${harness} and model ${DISPATCH_MODEL}. Do not do anything else first. Then reply with exactly what the tool returned, word for word.`;

/** One signed request of the agent port, as the seat sends it: over the test dir's pipe, with the token orchestrad wrote there. */
function seatRequest(testDir: string, method: string, pathname: string, body: unknown): Promise<{ status: number; json: any }> {
  const name = path.basename(testDir).slice('orchestra-test-'.length);
  const token = fs.readFileSync(path.join(testDir, 'orchestra', AGENT_TOKEN_FILE), 'utf8').trim();
  const payload = JSON.stringify(body);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const time = String(Date.now());
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: agentPipeName('test', name), method, path: pathname, agent: false,
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `${AGENT_AUTH.scheme} ${agentRequestMac(token, nonce, time, method, pathname, payload)}`,
        [AGENT_AUTH.nonceHeader]: nonce, [AGENT_AUTH.timeHeader]: time,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('live-smoke: the agent port had no answer')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** --dispatch-tool: see the head of this file. */
async function dispatchRun(harness: 'codex' | 'claude', model: string | null, keep: boolean): Promise<number> {
  const testDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-smoke-'));
  fs.mkdirSync(path.join(testDir, 'roots'));
  const d = await startDaemon(testDir, ['--agent-port']);
  const report: Record<string, unknown> = { harness, mode: 'dispatch-tool' };
  const checks: Record<string, boolean> = {};
  const check = (name: string, ok: boolean) => {
    checks[name] = ok;
  };
  const sessions: string[] = [];
  let code = 1;
  let api: Api | null = null;
  const until = async <T>(what: string, ms: number, read: () => Promise<T | null | undefined>): Promise<T> => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(700)) {
      const v = await read();
      if (v !== null && v !== undefined) return v;
    }
    throw new Error(`live-smoke: no ${what} within ${ms / 1000} s`);
  };
  try {
    const a = await connect(d);
    api = a;
    report.startup = a.owned;
    const tool = harness === 'claude' ? 'mcp__orchestra__dispatch' : 'orchestra_dispatch';
    const task = dispatchTask(tool, harness);
    const list = async () => (await a.get('/api/owned')).json;
    const events = async (id: string): Promise<{ seq: number; kind: string; ref: string | null; state: string | null; text: string | null }[]> => (await a.get(`/api/owned/${id}/feed`)).json.events;
    const note = async (id: string, state: string, after = 0) => (await events(id)).find((e) => e.seq > after && e.kind === 'note' && e.state === state) ?? null;
    const last = async (id: string) => (await events(id)).at(-1)?.seq ?? 0;
    const entry = async (id: string) => (await list()).owned.find((o: { ownedId: string }) => o.ownedId === id);
    const nodeOf = async (id: string) => ((await a.get('/api/tower')).json?.projects ?? []).flatMap((p: { nodes: unknown[] }) => p.nodes).find((n: { id: string }) => n.id === `n:${id}`) as { sent: { by: string; via: string; grantAt: number | null } | null } | undefined;
    const pending = async (from: string) => (await list()).requests.find((r: { requester: string; state: string }) => r.state === 'pending' && r.requester === from) ?? null;
    /** The session's turn, over and said: the tool's answer reached the model when its next words came. */
    const spoke = (id: string, after: number, re: RegExp) => until('reply', 120_000, async () => {
      const es = await events(id);
      return es.some((e) => e.seq > after && e.kind === 'text' && e.state !== 'partial' && re.test(e.text ?? '')) ? true : null;
    });
    const idle = (id: string) => until('idle session', 120_000, async () => ((await entry(id))?.state === 'idle' ? true : null));
    const send = async (id: string, text: string) => {
      const r = await a.post(`/api/owned/${id}/message`, { text });
      if (r.status !== 200) throw new Error(`live-smoke: message answered ${r.status}`);
    };
    const click = async (r: { text: string; harness: string; requestId: string }) => {
      const m = await a.post('/api/owned/new', { text: r.text, harness: r.harness, model: DISPATCH_MODEL, requestId: r.requestId });
      if (m.status !== 200) throw new Error(`live-smoke: 派出 answered ${m.status} ${m.body}`);
      sessions.push(String(m.json.ownedId));
      return String(m.json.ownedId);
    };
    const end = async (id: string) => {
      await a.post(`/api/owned/${id}/end`, {});
      await until('end', 20_000, async () => (['ended', 'failed'].includes((await entry(id))?.state) ? true : null));
    };

    // -- 派前问你 --------------------------------------------------------------------------------------
    const made = await a.post('/api/owned/new', { text: task, harness, ...(model === null ? {} : { model }) });
    if (made.status !== 200) throw new Error(`live-smoke: new answered ${made.status} ${made.body}`);
    const W = String(made.json.ownedId);
    sessions.push(W);
    report.level0 = (await entry(W))?.dispatch?.level ?? null;
    check('starts at ask', report.level0 === 'ask');
    const card = await until('card', 150_000, () => pending(`owned:${W}`));
    check('ask: a card, requester the worker, nothing started', card.auto === false && card.tainted === false && card.ownedId === null && (await list()).owned.length === 1);
    check('ask: the feed says it waits', (await note(W, 'worker-asked')) !== null);
    const c1 = await click(card);
    await spoke(W, 0, /Dispatched/);
    await idle(W);
    const sent1 = await note(W, 'worker-sent');
    const n1 = await nodeOf(c1);
    check('ask: receipt names the session, by your click', sent1?.ref === `n:${c1}` && n1?.sent?.by === `n:${W}` && n1?.sent?.via === 'person' && n1?.sent?.grantAt === null);

    // -- the route and who can reach it ---------------------------------------------------------------
    check('level away is refused', (await a.post(`/api/owned/${W}/dispatch-grant`, { level: 'away' })).status === 400);
    report.agentPortGrant = (await seatRequest(testDir, 'POST', `/api/owned/${W}/dispatch-grant`, { level: 'free' })).status;
    check('the agent port has no such route', report.agentPortGrant === 404);

    // -- 直接派出 --------------------------------------------------------------------------------------
    const g = await a.post(`/api/owned/${W}/dispatch-grant`, { level: 'free' });
    if (g.status !== 200) throw new Error(`live-smoke: grant answered ${g.status} ${g.body}`);
    const grantAction = String(g.json.actionId);
    report.presence = (await list()).presence;
    check('free is set, and you are present', (await entry(W))?.dispatch?.level === 'free' && report.presence === 'present');
    let mark = await last(W);
    await send(W, task);
    let cardSeen = false;
    const sent2 = await until('free dispatch', 150_000, async () => {
      if ((await pending(`owned:${W}`)) !== null) cardSeen = true;
      return note(W, 'worker-sent-grant', mark);
    });
    const c2 = String(sent2.ref).slice(2);
    sessions.push(c2);
    await spoke(W, mark, /Dispatched/);
    await idle(W);
    const auto = (await list()).requests.find((r: { ownedId: string | null }) => r.ownedId === c2);
    const n2 = await nodeOf(c2);
    check('free: no card, the request is auto', !cardSeen && auto?.auto === true);
    check('free: the receipt says the permission and when', n2?.sent?.by === `n:${W}` && n2?.sent?.via === 'grant' && typeof n2?.sent?.grantAt === 'number');
    check('free: what it dispatched starts at ask', (await entry(c2))?.dispatch?.level === 'ask');
    check('free: what a clean worker dispatched is clean (r4 §8.5)', (await entry(c2))?.dispatch?.tainted === false && (await entry(c1))?.dispatch?.tainted === false);
    await until('its first reply', 120_000, async () => ((await events(c2)).some((e) => e.kind === 'text' && e.state !== 'partial') ? true : null));

    // -- the limit: the worker and the two it sent out are three --------------------------------------
    report.limits = (await list()).limits;
    mark = await last(W);
    await send(W, task);
    const over = await until('refusal at the limit', 150_000, () => note(W, 'worker-refused', mark));
    await spoke(W, mark, /Not dispatched/);
    await idle(W);
    check('limit: refused, told, no fourth', over.text === 'owned-limit' && (await list()).limits.active === 3 && (await pending(`owned:${W}`)) === null);
    await end(c1);
    await end(c2);

    // -- away -----------------------------------------------------------------------------------------
    await sleep(AWAY_MS);
    mark = await last(W);
    await send(W, task);
    const asked = await until('card while away', 150_000, () => note(W, 'worker-asked', mark));
    const held = await pending(`owned:${W}`);
    check('away: back to a card, and it says why', asked.text === 'away' && held?.askWhy === 'away');
    const no = await a.post(`/api/agent-requests/${held.requestId}/reject`, {});
    await spoke(W, mark, /refused/i);
    await idle(W);
    check('away: 拒绝 reaches the worker', no.status === 200 && (await note(W, 'worker-refused', mark))?.text === 'you-rejected');

    // -- a seat request and a tainted session ---------------------------------------------------------
    const seat = await seatRequest(testDir, 'POST', '/agent/v1/requests', { harness, text: task, cwd: 'D:\\work\\smoke', requester: { kind: 'dsh', sessionId: 'smoke-seat' } });
    if (seat.status !== 200) throw new Error(`live-smoke: the seat request answered ${seat.status}`);
    await sleep(3000);
    const waiting = await pending('dsh:smoke-seat');
    check('seat: a card, whatever level anyone has', waiting !== null && waiting.auto === false && waiting.tainted === true);
    const T = await click(waiting);
    await until('tainted session', 30_000, async () => (await entry(T)) ?? null);
    check('seat: its session is tainted', (await entry(T))?.dispatch?.tainted === true);
    const g2 = await a.post(`/api/owned/${T}/dispatch-grant`, { level: 'free' });
    const tCard = await until('card of the tainted session', 150_000, () => pending(`owned:${T}`));
    check('tainted: back to a card at free, and it says why', g2.status === 200 && tCard.askWhy === 'tainted' && tCard.tainted === true && tCard.auto === false);
    const c3 = await click(tCard);
    await until('child', 30_000, async () => (await entry(c3)) ?? null);
    check('tainted: what it dispatched is tainted', (await entry(c3))?.dispatch?.tainted === true);
    report.c3Sent = (await nodeOf(c3))?.sent?.via ?? null;
    for (const id of sessions) {
      const e = await entry(id);
      if (e !== undefined && !['ended', 'failed'].includes(e.state)) await end(id);
    }
    await sleep(STOP_SETTLE_MS);

    report.stopped = await stopDaemon(d.child, d.exited);
    api = null;
    const lines = fs.readFileSync(path.join(testDir, 'orchestra', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { kind: string; body: Record<string, any> });
    const of = (k: string) => lines.filter((l) => l.kind === k).map((l) => l.body);
    const autos = of('auto');
    const routes = of('route');
    const requests = of('agent-request');
    report.journal = { auto: autos.length, routeManual: routes.filter((r) => r.mode === 'manual').length, routeAuto: routes.filter((r) => r.mode === 'auto').length, grants: of('dispatch-grant').map((b) => b.level), agentRequests: requests.map((r) => `${r.requesterKind}:${r.verdict}`) };
    check('journal: one auto record, the right sessions, on your grant', autos.length === 1 && autos[0]!.by === W && autos[0]!.ownedId === c2 && autos[0]!.grantActionId === grantAction && autos[0]!.depth === 1);
    check('journal: its route line is mode auto, the others manual', routes.filter((r) => r.mode === 'auto').length === 1 && routes.find((r) => r.mode === 'auto')?.ownedId === c2 && routes.find((r) => r.mode === 'auto')?.decisionId === autos[0]!.decisionId
      && [W, c1, T, c3].every((id) => routes.find((r) => r.ownedId === id)?.mode === 'manual'));
    check('journal: no human record started it', of('human').every((h) => !(h.verb === 'owned-new' && h.targetId === c2)) && of('human').filter((h) => h.verb === 'owned-new').length === 4);
    check('journal: each level change is a person\'s', of('dispatch-grant').length === 2 && of('human').filter((h) => h.verb === 'dispatch-grant').length === 2);
    check('journal: the requests say who asked', requests.filter((r) => r.requesterKind === 'owned' && r.verdict === 'dispatched').length === 2 && requests.filter((r) => r.requesterKind === 'owned' && r.verdict === 'rejected').length === 1 && requests.filter((r) => r.requesterKind === 'dsh' && r.verdict === 'dispatched').length === 1);
    code = Object.values(checks).every(Boolean) ? 0 : 1;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.orchestradSaid = d.lines.filter((l) => /owned|refus|failed|error/i.test(l) && !/code \d{8}/.test(l)).map((l) => l.replace(testDir, '<testDir>'));
  } finally {
    report.checks = checks;
    if (api !== null) {
      for (const id of sessions) await (api as Api).post(`/api/owned/${id}/end`, {}).catch(() => {});
      await sleep(STOP_SETTLE_MS);
    }
    report.stopped ??= await stopDaemon(d.child, d.exited);
    report.leftovers = await leftovers(testDir);
    const lo = report.leftovers as { leftover: number; unchecked: number };
    if (lo.leftover + lo.unchecked !== 0) code = 1;
    if (!keep) {
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(1000);
        }
      }
    }
    report.testDirKept = keep || fs.existsSync(testDir);
  }
  console.log(JSON.stringify(report, null, 2));
  return code;
}

async function main(): Promise<number> {
  const { harness, model, keep, outside, brake, viaSubagent, daemonStop, daemonKill, projectRoot, subagent, pair, subagentStop, loose, rootStop, dispatchTool } = args();
  if (dispatchTool) return dispatchRun(harness, model, keep);
  const testDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-smoke-'));
  fs.mkdirSync(path.join(testDir, 'roots'));
  // --project-root: a project root inside the test dir (the test profile takes roots only there).
  const proj = path.join(testDir, 'proj');
  if (projectRoot) fs.mkdirSync(proj);
  const extra = projectRoot ? ['--project-root', proj] : [];
  const first = await startDaemon(testDir, extra);
  const { child, lines, exited } = first;
  /** --daemon-kill: the orchestrad started again on the same test dir, until it is stopped. */
  let second: Daemon | null = null;
  const report: Record<string, unknown> = { harness };
  let code = 1;
  /** Set once a session is dispatched: the finally ends it through orchestrad, whatever else happened. */
  let ownedId: string | null = null;
  let endIt: (() => Promise<void>) | null = null;
  /** The script's own procguard (the exe orchestrad built in the test dir), once there is one. */
  let pg: ReturnType<typeof probe> = null;
  /** What the session's Job held before its end, by identity: checked once it ended. */
  let held: { pid: number; createTime: string }[] = [];
  try {
    const { get, post, owned } = await connect(first);
    report.startup = owned;

    const probeFile = path.join(testDir, OUTSIDE_FILE);
    if (outside) fs.writeFileSync(probeFile, `${OUTSIDE_WORD}\n`);
    let root: string | null = null;
    if (projectRoot) {
      const roots: unknown = (await get('/api/owned')).json?.roots;
      report.rootsListed = Array.isArray(roots) ? roots.map((r) => (typeof r === 'string' ? r.replace(testDir, '<testDir>') : '?')) : null;
      root = Array.isArray(roots) && typeof roots[0] === 'string' ? roots[0] : null;
      if (root === null) throw new Error('live-smoke: GET /api/owned lists no project root');
    }
    const claude = harness === 'claude';
    const residents = claude ? new Set(CLAUDE_JOB_RESIDENTS) : JOB_RESIDENTS;
    const subagentTask = claude ? (pair ? CLAUDE_TASKS.pair : CLAUDE_TASKS.one) : pair ? SUBAGENT_PAIR_TASK : SUBAGENT_TASK;
    const made = await post('/api/owned/new', { text: outside ? outsideTask(probeFile) : viaSubagent ? CLAUDE_TASKS.brake : brake ? BRAKE_TASK : daemonKill ? KILL_TASK : subagent ? subagentTask : subagentStop ? (loose ? CLAUDE_TASKS.loose : claude ? CLAUDE_TASKS.stop : SUBAGENT_STOP_TASK) : rootStop ? ROOT_STOP_TASK : TASK, harness, ...(model === null ? {} : { model }), ...(root === null ? {} : { root }) });
    if (made.status !== 200) throw new Error(`live-smoke: new answered ${made.status} ${made.body}`);
    const id = String(made.json.ownedId);
    ownedId = id;
    endIt = async () => {
      const r = await endAndWait(() => post(`/api/owned/${id}/end`, {}), async () => (await get('/api/owned')).json?.owned?.find((o: { ownedId: string }) => o.ownedId === id)?.state ?? null);
      report.endAnswer = r.endAnswer;
      report.settledAs = r.settled;
    };
    const states: string[] = [];
    const allowed: Record<string, number> = {};
    const refusals: Record<string, number> = {};
    // r4 §8.5: each card's source chain as GET /api/owned listed it (a session a person opened has none: null).
    const origins: Record<string, number> = {};
    const seenAppr = new Set<string>();
    /** --subagent: what the tower said of the session's sub-agent nodes, and how many cards named one. */
    const memberStates: Record<string, string[]> = {};
    const memberFacts = { named: false, durationMs: null as number | null, models: new Set<string | null>(), types: new Set<string | null>(), towerAnswers: new Set<number>() };
    let cardsFromSubagent = 0;
    /** The session's sub-agent nodes as the last tower read gave them. */
    let kids: { id: string; state: string; batch: number | null }[] = [];
    const readMembers = async () => {
      const tower = await get('/api/tower');
      memberFacts.towerAnswers.add(tower.status);
      const nodes: { id: string; parent: string | null; ownership: string; state: string; title: string; durationMs: number | null; model: string | null; agentType: string | null; batch: number | null }[] = (tower.json?.projects ?? []).flatMap((p: { nodes: unknown[] }) => p.nodes);
      kids = nodes.filter((x) => x.parent === `n:${ownedId}`);
      for (const n of kids as typeof nodes) {
        const seen = (memberStates[n.id] ??= []);
        if (seen.at(-1) !== n.state) seen.push(n.state);
        if (!n.title.startsWith('子代理（')) memberFacts.named = true;
        if (n.durationMs !== null) memberFacts.durationMs = n.durationMs;
        memberFacts.models.add(n.model);
        memberFacts.types.add(n.agentType);
      }
    };
    /** --subagent-stop: what the session's Job holds now beyond its residents: a command's shell and what that started. */
    const commandsInJob = async () => {
      const job = jobsOf(testDir).at(-1)?.job ?? null;
      if (job === null) return [];
      if (pg === null) {
        const opened = probeOf(testDir);
        if (opened.pg === null) throw new Error(`live-smoke: no probe: ${opened.why}`);
        pg = opened.pg;
      }
      return (await pg.info(job)).procs.filter((p) => !residents.has((p.image ?? '').toLowerCase()));
    };
    const imagesOf = (procs: readonly { image: string | null }[]) => procs.map((p) => (p.image ?? '?').toLowerCase()).sort();
    type StopRound = { rootBefore: string; offered: boolean; answer: number; commandBefore: string[]; alive: number; inJob: string[]; goneMs: number | null; nodes: string[]; notes: string[]; rootAfter: string | null; offeredAfter: boolean | null; failed: number | null; ranUnasked: number | null };
    const stops: StopRound[] = [];
    /** The nodes a stop already took: the next round's is another. */
    const stoppedNodes = new Set<string>();
    /** The stop, as the page presses it, and what is true of the command, the node and the feed afterwards. */
    const pressStop = async (rootBefore: string, offered: boolean, nodes: readonly string[], procs: readonly { pid: number; createTime: string | null; image: string | null }[], notesOf = 'members-') => {
      const known = procs.filter((p) => p.createTime !== null).map((p) => ({ pid: p.pid, createTime: p.createTime! }));
      if (known.length !== procs.length) throw new Error('live-smoke: a process without a creation time cannot be checked');
      const mark = (await get(`/api/owned/${id}/feed`)).json.to as number;
      const t = Date.now();
      const r = await post(`/api/owned/${id}/interrupt`, {});
      const round: StopRound = { rootBefore, offered, answer: r.status, commandBefore: imagesOf(procs), alive: known.length, inJob: imagesOf(procs), goneMs: null, nodes: [], notes: [], rootAfter: null, offeredAfter: null, failed: null, ranUnasked: null };
      stops.push(round);
      for (;;) {
        await readMembers();
        round.alive = (await pg!.alive(known)).length;
        round.inJob = imagesOf(await commandsInJob());
        if (round.goneMs === null && round.alive === 0 && round.inJob.length === 0) round.goneMs = Date.now() - t;
        round.nodes = kids.filter((n) => nodes.includes(n.id)).map((n) => n.state);
        const page = (await get(`/api/owned/${id}/feed?after=${mark}`)).json;
        round.notes = page.events.filter((e: { kind: string; state: string }) => e.kind === 'note' && e.state.startsWith(notesOf) && e.state !== 'members-ran-unasked').map((e: { state: string; text: string | null }) => `${e.state}=${String(e.text)}`);
        const over = round.goneMs !== null && !round.nodes.includes('running') && round.notes.length > 0 && !round.notes.some((n) => n.startsWith(`${notesOf}stopping=`));
        if (over || Date.now() - t > STOP_CHECK_MS) break;
        await sleep(250);
      }
      const listed = (await get('/api/owned')).json.owned.find((o: { ownedId: string }) => o.ownedId === id);
      round.rootAfter = listed?.state ?? null;
      round.offeredAfter = listed?.stoppable ?? null;
      const onDisk = membersOnDisk(testDir, id);
      round.failed = onDisk === null ? null : onDisk.reduce((n, m) => n + m.failed, 0);
      round.ranUnasked = onDisk === null ? null : onDisk.reduce((n, m) => n + m.ranUnasked, 0);
      for (const n of nodes) stoppedNodes.add(n);
    };
    const stopHeld = (r: StopRound) => r.answer === 200 && r.offered && r.commandBefore.includes('ping.exe') && r.alive === 0 && r.inJob.length === 0 && r.nodes.length > 0 && r.nodes.every((n) => n === 'ended')
      && r.notes.length === 1 && r.notes[0] === `members-stopped=${r.nodes.length}` && r.rootAfter === 'idle' && r.offeredAfter === false && r.failed === 0 && r.ranUnasked === 0;
    /** --loose: the let-go ping outlives the stop; the Job says so, and the stop stays on offer. */
    const looseHeld = (r: StopRound | undefined) => r !== undefined && r.answer === 200 && r.offered && r.alive > 0 && r.inJob.includes('ping.exe') && r.nodes.length > 0 && r.nodes.every((n) => n === 'ended')
      && r.notes.length === 1 && r.notes[0] === `members-job-left=${r.inJob.length}` && r.rootAfter === 'idle' && r.offeredAfter === true;
    /** --subagent with Claude: when every sub-agent was over, and the turn count then; the turn it wakes is awaited. */
    let membersOverAt: { t: number; turns: number } | null = null;
    let turnAfterMembers = false;
    /** --root-stop: the feed position the message after the stop went out at; a reply past it is the proof. */
    let againFrom: number | null = null;
    let after = 0;
    const events: { seq: number; kind: string; ref: string | null; state: string | null; text: string | null; batch: number | null }[] = [];
    let replied = false;
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > LIMIT_MS) throw new Error('live-smoke: no reply within the time limit');
      const list = (await get('/api/owned')).json;
      if (Date.now() - t0 > LIMIT_MS) throw new Error('live-smoke: no reply within the time limit');
      const me = list.owned.find((o: { ownedId: string }) => o.ownedId === id);
      if (me !== undefined && states.at(-1) !== me.state) states.push(me.state);
      for (const a of list.approvals.filter((x: { ownedId: string }) => x.ownedId === id)) {
        if (!seenAppr.has(a.approvalId)) {
          seenAppr.add(a.approvalId);
          const k = a.origin === undefined ? 'absent' : a.origin === null ? 'null' : 'set';
          origins[k] = (origins[k] ?? 0) + 1;
          if (String(a.preview).startsWith('from subagent: ')) cardsFromSubagent++;
        }
        if (!a.canAccept) {
          await post(`/api/approvals/${a.approvalId}/deny`, {});
          continue;
        }
        // The list just moved (the card came): an allow within 750 ms of a change is stale-view. Wait, read again.
        await sleep(900);
        const fresh = (await get('/api/owned')).json;
        if (!fresh.approvals.some((x: { approvalId: string }) => x.approvalId === a.approvalId)) continue;
        const r = await post(`/api/approvals/${a.approvalId}/allow`, { digest: a.digest, rev: fresh.rev });
        if (r.status === 200) allowed[`${a.kind}/${a.risk}`] = (allowed[`${a.kind}/${a.risk}`] ?? 0) + 1;
        else refusals[String(r.json?.error ?? r.status)] = (refusals[String(r.json?.error ?? r.status)] ?? 0) + 1;
      }
      if (subagent || subagentStop || rootStop || viaSubagent) await readMembers();
      const feed = (await get(`/api/owned/${id}/feed?after=${after}`)).json;
      for (const e of feed.events) events.push({ seq: e.seq, kind: e.kind, ref: e.ref, state: e.state, text: e.text, batch: e.batch });
      after = feed.to;
      replied = events.some((e) => e.kind === 'text' && e.state !== 'partial' && (e.text ?? '').length > 0);
      const turnOver = events.some((e) => e.kind === 'lifecycle' && /^turn-(ended|failed|max-turns|interrupted|unknown)$/.test(e.state ?? ''));
      if (me !== undefined && (me.state === 'failed' || me.state === 'ended')) break;
      if (subagentStop) {
        // Round one with the root's turn running (it waits for the sub-agent), round two with the root idle.
        const fresh = kids.filter((n) => !stoppedNodes.has(n.id));
        if (fresh.some((n) => n.state === 'returned')) throw new Error('live-smoke: the sub-agent reported before a stop could reach it');
        const procs = await commandsInJob();
        if (me?.state === (stops.length === 0 ? 'running' : 'idle') && procs.filter(isPing).length >= (loose ? 2 : 1) && fresh.some((n) => n.state === 'running')) {
          await pressStop(me.state, me.stoppable === true, fresh.map((n) => n.id), procs);
          if (stops.length === 2 || loose) break;
          const sent = await post(`/api/owned/${id}/message`, { text: claude ? CLAUDE_TASKS.free : SUBAGENT_FREE_TASK });
          if (sent.status !== 200) throw new Error(`live-smoke: message answered ${sent.status}`);
        }
        await sleep(500);
        continue;
      }
      if (rootStop) {
        if (againFrom === null) {
          const procs = await commandsInJob();
          if (me?.state === 'running' && procs.some(isPing)) {
            await pressStop(me.state, true, [], procs, 'commands-');
            const sent = await post(`/api/owned/${id}/message`, { text: ROOT_AGAIN_TASK });
            if (sent.status !== 200) throw new Error(`live-smoke: message answered ${sent.status}`);
            againFrom = (await get(`/api/owned/${id}/feed`)).json.to as number;
          }
        } else if (me?.state === 'idle' && events.some((e) => e.seq > againFrom! && e.kind === 'text' && e.state !== 'partial' && (e.text ?? '').length > 0)) break;
        await sleep(500);
        continue;
      }
      if (subagent && claude) {
        // The root's turn ends before a background sub-agent's: its end is what counts here, and the turn it wakes after.
        const turns = events.filter((e) => e.kind === 'lifecycle' && /^turn-/.test(e.state ?? '')).length;
        if (membersOverAt === null && kids.length >= (pair ? 2 : 1) && kids.every((n) => n.state !== 'running')) membersOverAt = { t: Date.now(), turns };
        if (membersOverAt !== null && me?.state === 'idle') {
          turnAfterMembers = turns > membersOverAt.turns;
          if (turnAfterMembers || Date.now() - membersOverAt.t > WAKE_MS) break;
        }
        await sleep(500);
        continue;
      }
      if (viaSubagent ? false : replied && turnOver && me?.state === 'idle') break;
      if (daemonKill || viaSubagent) {
        // The kill (or, --via-subagent, the brake) comes while the turn runs: once the ping is in the session's Job.
        const job = jobsOf(testDir).at(-1)?.job ?? null;
        if (pg === null && job !== null) {
          const opened = probeOf(testDir);
          if (opened.pg === null) throw new Error(`live-smoke: no probe: ${opened.why}`);
          pg = opened.pg;
        }
        if (pg !== null && job !== null && (await pg.info(job)).procs.some(isPing)) break;
      }
      await sleep(1000);
    }
    const file = path.join(projectRoot ? proj : path.join(testDir, 'orchestra', 'work', id), FILE);
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (projectRoot) {
      const cwd = (await get('/api/owned')).json?.owned?.find((o: { ownedId: string }) => o.ownedId === id)?.cwd ?? null;
      report.listedCwd = cwd === null ? null : { kind: cwd.kind, path: String(cwd.path).replace(testDir, '<testDir>') };
      report.workDirMade = fs.existsSync(path.join(testDir, 'orchestra', 'work', id));
      report.fileInRoot = written !== null;
    }
    const mentions = events.some((e) => e.kind === 'text' && (e.text ?? '').includes(outside ? OUTSIDE_WORD : WORD));
    // The session's Job (procguard on): what it holds now, by image name; its members by identity.
    const jobs = jobsOf(testDir);
    report.jobs = jobs.map((j) => j.rule);
    const job = jobs.at(-1)?.job ?? null;
    if (pg === null) {
      const opened = job === null ? null : probeOf(testDir);
      pg = opened?.pg ?? null;
      report.probe = opened === null ? null : opened.why;
    } else {
      report.probe = null;
    }
    if (pg !== null && job !== null) {
      let info = await pg.info(job);
      if (brake) {
        // The ping may take a moment after the reply: wait for it, at most 60 s.
        for (let waited = 0; waited < 60_000 && !info.procs.some((p) => (p.image ?? '').toLowerCase() === 'ping.exe'); waited += 1000) {
          await sleep(1000);
          info = await pg.info(job);
        }
      }
      const images: Record<string, number> = {};
      for (const p of info.procs) images[(p.image ?? '?').toLowerCase()] = (images[(p.image ?? '?').toLowerCase()] ?? 0) + 1;
      held = info.procs.filter((p) => p.createTime !== null).map((p) => ({ pid: p.pid, createTime: p.createTime! }));
      report.jobBeforeEnd = { found: info.found, images, unidentified: info.procs.length - held.length, wrapperInJob: info.procs.some((p) => p.pid === jobs.at(-1)?.pid) };
    } else {
      report.jobBeforeEnd = null;
    }
    if (daemonStop) {
      // As when the program that started orchestrad goes away: its stdin closes, and its own stop runs.
      endIt = null;
      report.daemonStop = await stopDaemon(child, exited);
      report.orchestradStopped = report.daemonStop;
      report.daemonStopRecord = endReasonOnDisk(testDir, id);
    } else if (daemonKill) {
      // TerminateProcess, its stdin left open: none of orchestrad's own stop runs.
      endIt = null;
      report.recordBeforeKill = endReasonOnDisk(testDir, id);
      // The same check just before the kill: it must find every one of them alive, or its 0 after says nothing.
      if (pg !== null) report.aliveBeforeKill = (await pg.alive(held)).length;
      const k0 = Date.now();
      child.kill();
      const gone = await Promise.race([first.exitedProc, sleep(10_000).then(() => 'timeout' as const)]);
      report.orchestradStopped = { how: 'killed', code: gone === 'timeout' ? null : gone };
      report.killExitMs = gone === 'timeout' ? null : Date.now() - k0;
      if (pg !== null && job !== null) {
        // How many of the Job's processes still run, by pid + creation time, as the time since the kill goes on.
        const timeline: { ms: number; alive: number }[] = [];
        for (;;) {
          const n = (await pg.alive(held)).length;
          if (timeline.at(-1)?.alive !== n) timeline.push({ ms: Date.now() - k0, alive: n });
          if (n === 0 || Date.now() - k0 > 20_000) break;
          await sleep(250);
        }
        report.aliveAfterKill = timeline;
        // The pass/fail reads this: the count within 20 s of the kill (review fix: never the recount after the restart).
        report.survivors = timeline.at(-1)!.alive;
        // found:false only from procguard's own "no such Job"; a probe that failed is recorded apart, and fails the run.
        try {
          const after = await pg.info(job);
          report.jobAfterKill = after.found ? { found: true, procs: after.procs.length } : { found: false };
        } catch (e) {
          report.jobAfterKill = { found: null, error: e instanceof Error ? e.message : String(e) };
        }
      }
      report.recordAfterKill = endReasonOnDisk(testDir, id);
      await Promise.race([exited, sleep(10_000)]);
      // The procguard.exe the restart builds replaces this one: the probe goes first.
      if (pg !== null) {
        pg.close();
        pg = null;
        await sleep(500);
      }
      second = await startDaemon(testDir, extra);
      const api2 = await connect(second);
      const listed = (await api2.get('/api/owned')).json?.owned?.find((o: { ownedId: string }) => o.ownedId === id) ?? null;
      report.afterRestart = listed === null ? null : { state: listed.state, endReason: listed.endReason, brake: listed.brake, waiting: listed.waiting };
      report.recordAfterRestart = endReasonOnDisk(testDir, id);
      report.restartStopped = await stopDaemon(second.child, second.exited);
      second = null;
      // Once more after the second orchestrad is gone too (its procguard.exe is the one the probe now runs).
      const again = probeOf(testDir);
      pg = again.pg;
      if (pg === null) report.probeAfterRestart = again.why;
    } else if (brake) {
      const b = await post(`/api/owned/${id}/brake`, {});
      report.brakeAnswer = { status: b.status, killed: b.json?.killed ?? null, left: b.json?.left ?? null, error: b.json?.error ?? null };
      await sleep(500);
      endIt = null;
    } else {
      await endIt();
      endIt = null;
    }
    // --daemon-kill: survivors is the count within 20 s of the kill; the recount after the restart is kept apart.
    if (pg !== null && daemonKill) report.survivorsAfterRestart = held.length === 0 ? null : (await pg.alive(held)).length;
    else if (pg !== null) report.survivors = held.length === 0 ? null : (await pg.alive(held)).length;
    const last = daemonStop || daemonKill ? null : (await get('/api/owned')).json.owned.find((o: { ownedId: string }) => o.ownedId === id);
    const count: Record<string, number> = {};
    for (const e of events) {
      const k = `${e.kind}${e.state === null ? '' : `:${e.state}`}`;
      count[k] = (count[k] ?? 0) + 1;
    }
    Object.assign(report, {
      states, endState: last === undefined || last === null ? null : `${last.state}/${last.endReason}`,
      approvalsAllowed: allowed, approvalRefusals: refusals, approvalOrigins: origins, feedEvents: count, replyInFeed: replied, replyNamesTheWord: mentions,
      fileWritten: written !== null, fileContentAsAsked: written !== null && written.trim() === WORD,
    });
    if (outside) report.ranUnasked = events.filter((e) => e.kind === 'note' && e.state === 'ran-unasked').length;
    const toolRowsInFeed = events.filter((e) => e.kind === 'tool' || e.kind === 'tool-result').length;
    if (subagentStop) {
      await readMembers();
      report.subagentStop = { rounds: stops, held: stops.map(loose ? looseHeld : stopHeld), states: Object.values(memberStates), towerAnswers: [...memberFacts.towerAnswers] };
    }
    // What the talk says of each sub-agent: the last telling of its dispatch (it is told again once its name is known).
    if (viaSubagent) report.viaSubagent = { states: Object.values(memberStates), cardsFromSubagent };
    const sentRows = new Map(events.filter((e) => e.kind === 'note' && e.state === 'dispatch').map((e) => [e.ref, e]));
    let dispatchHeld = false;
    if (subagent) {
      await readMembers();
      dispatchHeld = sentRows.size === kids.length && kids.length >= (pair ? 2 : 1) && kids.every((n) => n.batch !== null && sentRows.get(n.id)?.batch === n.batch && (sentRows.get(n.id)?.text ?? '') !== '');
      report.subagent = {
        states: Object.values(memberStates), named: memberFacts.named, durationMs: memberFacts.durationMs, models: [...memberFacts.models], types: [...memberFacts.types], cardsFromSubagent, ...(claude ? { turnAfterMembers } : {}), towerAnswers: [...memberFacts.towerAnswers], toolRowsInFeed,
        ranUnasked: Number(events.findLast((e) => e.kind === 'note' && e.state === 'members-ran-unasked')?.text ?? 0),
        dispatch: { rows: sentRows.size, members: kids.length, batches: new Set(kids.map((n) => n.batch)).size, nodesWithBatch: kids.filter((n) => n.batch !== null).length, held: dispatchHeld },
      };
    }
    /** The end of the command the stop reached, and whether it was said to have run unasked. */
    const rootResults = events.filter((e) => e.kind === 'tool-result').map((e) => e.state);
    const rootRanUnasked = events.filter((e) => e.kind === 'note' && e.state === 'ran-unasked').length;
    const rootHeld = (r: StopRound | undefined) => r !== undefined && r.answer === 200 && r.commandBefore.includes('ping.exe') && r.alive === 0 && r.inJob.length === 0 && r.notes.length === 1 && r.notes[0] === 'commands-stopped=1' && r.rootAfter === 'idle' && r.offeredAfter === false;
    if (rootStop) {
      report.rootStop = {
        round: stops[0] ?? null, held: rootHeld(stops[0]), results: rootResults, ranUnasked: rootRanUnasked, turnsInterrupted: events.filter((e) => e.state === 'turn-interrupted').length,
        repliedAfter: againFrom !== null && events.some((e) => e.seq > againFrom! && e.kind === 'text' && e.state !== 'partial'),
      };
    }
    if (!daemonStop && !daemonKill) report.treeNotes = ((await get(`/api/owned/${id}/feed`)).json?.events ?? []).filter((e: { kind: string; state: string }) => e.kind === 'note' && /^tree-|children-may-remain|host-killed/.test(e.state)).map((e: { state: string; text: string | null }) => `${e.state}${e.text === null ? '' : `=${e.text}`}`);
    const noSurvivors = pg === null || report.survivors === 0;
    const ds = report.daemonStop as { how: string; code: number | null } | undefined;
    const dsRecord = report.daemonStopRecord as { endReason: string | null } | null | undefined;
    const restarted = report.afterRestart as { state: string; endReason: string | null } | null | undefined;
    code = rootStop
      ? (rootHeld(stops[0]) && rootResults.includes('stopped') && !rootResults.includes('failed') && rootRanUnasked === 0 && (report.rootStop as { repliedAfter: boolean }).repliedAfter && report.survivors === 0 && held.length > 0 ? 0 : 1)
      : subagentStop
      ? ((loose ? looseHeld(stops[0]) : stops.length === 2 && stops.every(stopHeld)) && report.survivors === 0 && held.length > 0 && memberFacts.towerAnswers.size === 1 && memberFacts.towerAnswers.has(200) ? 0 : 1)
      : subagent
      ? (replied && Object.keys(memberStates).length > 0 && Object.values(memberStates).every((s) => s.includes('returned')) && memberFacts.named && memberFacts.durationMs !== null
        && cardsFromSubagent > 0 && toolRowsInFeed === 0 && memberFacts.towerAnswers.size === 1 && memberFacts.towerAnswers.has(200) && dispatchHeld ? 0 : 1)
      : daemonKill
      ? (report.survivors === 0 && held.length > 0 && report.aliveBeforeKill === held.length &&Number((report.jobBeforeEnd as { images: Record<string, number> } | null)?.images?.['ping.exe'] ?? 0) > 0
        && (report.jobAfterKill as { found: boolean } | undefined)?.found === false && restarted?.state === 'unknown' && restarted.endReason === 'daemon-restart' ? 0 : 1)
      : daemonStop
      ? (ds?.how === 'stdin-eof' && ds.code === 0 && dsRecord?.endReason === 'daemon-stop' && report.survivors === 0 && held.length > 0 ? 0 : 1)
      : brake
      ? (report.survivors === 0 && (report.brakeAnswer as { status: number }).status === 200 && last?.endReason === 'braked' && held.length > 0 && (!viaSubagent || cardsFromSubagent > 0) ? 0 : 1)
      : outside ? (replied ? 0 : 1)
      : projectRoot ? (replied && written !== null && written.trim() === WORD && noSurvivors && report.workDirMade === false && (report.listedCwd as { kind?: string } | null)?.kind === 'project-root' ? 0 : 1)
      : replied && written !== null && written.trim() === WORD && noSurvivors ? 0 : 1;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.orchestradSaid = lines.filter((l) => /owned|refus|failed|error/i.test(l) && !/code \d{8}/.test(l)).map((l) => l.replace(testDir, '<testDir>'));
  } finally {
    // A session the run did not get to end (an error on the way) is ended through orchestrad first.
    if (ownedId !== null && endIt !== null) await endIt().catch(() => {});
    // orchestrad stops through its stdin (its own stop runs); killed only when that does not end it in time.
    report.orchestradStopped ??= await stopDaemon(child, exited);
    if (second !== null) report.restartStopped = await stopDaemon(second.child, second.exited);
    // After orchestrad itself is gone, nothing of the Job may remain.
    if (pg !== null) {
      if (held.length > 0) report.survivorsAfterDaemon = (await pg.alive(held)).length;
      pg.close();
      await sleep(300);
    }
    report.leftovers = await leftovers(testDir);
    const lo = report.leftovers as { leftover: number; unchecked: number };
    if ((daemonKill || subagentStop || rootStop) && lo.leftover + lo.unchecked !== 0) code = 1;
    if (!keep) {
      // The host and claude.exe may still be leaving: a few tries.
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(1000);
        }
      }
    }
    report.testDirKept = keep || fs.existsSync(testDir);
  }
  console.log(JSON.stringify(report, null, 2));
  return code;
}

process.exitCode = await main();
