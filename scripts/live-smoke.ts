// The live end-to-end run of an owned session (orchestra app step 4): orchestrad in the test profile with
// --owned, driven over HTTP exactly as the page drives it, against the real codex.exe or the Claude host
// and the local magpie gateway (http://127.0.0.1:3425, no key). Not part of the test run.
//   node scripts/live-smoke.ts --harness codex|claude [--model <id>] [--outside | --brake | --daemon-stop | --daemon-kill | --project-root | --subagent] [--keep]
//
// --subagent (orchestra app plan 子代理, codex only): the task is to spawn one sub-agent that runs one ping and
// to wait for it. Each round the run reads GET /api/tower (it answers only what passes the tower contract), and
// reports the states the sub-agent's node went through, whether it had a name and a duration, its model, how
// many of its steps ran unasked, whether the feed stayed the root's (no tool row), and whether each card said
// which sub-agent asked. Its node's state after the session ended is read too. Never the name itself: the
// model chose it. It passes only if every sub-agent got to returned, named, with a duration, one card said
// which, the feed holds no tool row and every tower read answered 200.
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
// Job held before the end and how many of those processes are still alive after it.
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
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endAndWait, endReasonOnDisk, jobsOf, leftovers, type probe, probeOf, type Reply, request, sleep, stopDaemon } from './live-common.ts';

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

function args(): { harness: 'codex' | 'claude'; model: string | null; keep: boolean; outside: boolean; brake: boolean; daemonStop: boolean; daemonKill: boolean; projectRoot: boolean; subagent: boolean } {
  const a = process.argv.slice(2);
  let harness: string | null = null;
  let model: string | null = null;
  let keep = false;
  let outside = false;
  let brake = false;
  let daemonStop = false;
  let daemonKill = false;
  let projectRoot = false;
  let subagent = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--harness') harness = a[++i] ?? null;
    else if (a[i] === '--model') model = a[++i] ?? null;
    else if (a[i] === '--keep') keep = true;
    else if (a[i] === '--outside') outside = true;
    else if (a[i] === '--brake') brake = true;
    else if (a[i] === '--daemon-stop') daemonStop = true;
    else if (a[i] === '--daemon-kill') daemonKill = true;
    else if (a[i] === '--project-root') projectRoot = true;
    else if (a[i] === '--subagent') subagent = true;
    else throw new Error(`live-smoke: unknown argument ${a[i]}`);
  }
  if (harness !== 'codex' && harness !== 'claude') throw new Error('live-smoke: --harness codex|claude');
  if ([outside, brake, daemonStop, daemonKill, projectRoot, subagent].filter(Boolean).length > 1) throw new Error('live-smoke: one of --outside, --brake, --daemon-stop, --daemon-kill, --project-root, --subagent');
  if (subagent && harness !== 'codex') throw new Error('live-smoke: --subagent is for --harness codex');
  return { harness, model, keep, outside, brake, daemonStop, daemonKill, projectRoot, subagent };
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

async function main(): Promise<number> {
  const { harness, model, keep, outside, brake, daemonStop, daemonKill, projectRoot, subagent } = args();
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
    const made = await post('/api/owned/new', { text: outside ? outsideTask(probeFile) : brake ? BRAKE_TASK : daemonKill ? KILL_TASK : subagent ? SUBAGENT_TASK : TASK, harness, ...(model === null ? {} : { model }), ...(root === null ? {} : { root }) });
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
    const memberFacts = { named: false, durationMs: null as number | null, models: new Set<string | null>(), towerAnswers: new Set<number>() };
    let cardsFromSubagent = 0;
    const readMembers = async () => {
      const tower = await get('/api/tower');
      memberFacts.towerAnswers.add(tower.status);
      const nodes: { id: string; parent: string | null; ownership: string; state: string; title: string; durationMs: number | null; model: string | null }[] = (tower.json?.projects ?? []).flatMap((p: { nodes: unknown[] }) => p.nodes);
      for (const n of nodes.filter((x) => x.parent === `n:${ownedId}`)) {
        const seen = (memberStates[n.id] ??= []);
        if (seen.at(-1) !== n.state) seen.push(n.state);
        if (!n.title.startsWith('子代理（')) memberFacts.named = true;
        if (n.durationMs !== null) memberFacts.durationMs = n.durationMs;
        memberFacts.models.add(n.model);
      }
    };
    let after = 0;
    const events: { kind: string; state: string | null; text: string | null }[] = [];
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
      if (subagent) await readMembers();
      const feed = (await get(`/api/owned/${id}/feed?after=${after}`)).json;
      for (const e of feed.events) events.push({ kind: e.kind, state: e.state, text: e.text });
      after = feed.to;
      replied = events.some((e) => e.kind === 'text' && e.state !== 'partial' && (e.text ?? '').length > 0);
      const turnOver = events.some((e) => e.kind === 'lifecycle' && /^turn-(ended|failed|max-turns|interrupted|unknown)$/.test(e.state ?? ''));
      if (me !== undefined && (me.state === 'failed' || me.state === 'ended')) break;
      if (replied && turnOver && me?.state === 'idle') break;
      if (daemonKill) {
        // The kill comes while the turn runs: once the ping is in the session's Job.
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
    if (subagent) {
      await readMembers();
      report.subagent = {
        states: Object.values(memberStates), named: memberFacts.named, durationMs: memberFacts.durationMs, models: [...memberFacts.models], cardsFromSubagent, towerAnswers: [...memberFacts.towerAnswers], toolRowsInFeed,
        ranUnasked: Number(events.findLast((e) => e.kind === 'note' && e.state === 'members-ran-unasked')?.text ?? 0),
      };
    }
    if (!daemonStop && !daemonKill) report.treeNotes = ((await get(`/api/owned/${id}/feed`)).json?.events ?? []).filter((e: { kind: string; state: string }) => e.kind === 'note' && /^tree-|children-may-remain|host-killed/.test(e.state)).map((e: { state: string; text: string | null }) => `${e.state}${e.text === null ? '' : `=${e.text}`}`);
    const noSurvivors = pg === null || report.survivors === 0;
    const ds = report.daemonStop as { how: string; code: number | null } | undefined;
    const dsRecord = report.daemonStopRecord as { endReason: string | null } | null | undefined;
    const restarted = report.afterRestart as { state: string; endReason: string | null } | null | undefined;
    code = subagent
      ? (replied && Object.keys(memberStates).length > 0 && Object.values(memberStates).every((s) => s.includes('returned')) && memberFacts.named && memberFacts.durationMs !== null
        && cardsFromSubagent > 0 && toolRowsInFeed === 0 && memberFacts.towerAnswers.size === 1 && memberFacts.towerAnswers.has(200) ? 0 : 1)
      : daemonKill
      ? (report.survivors === 0 && held.length > 0 && report.aliveBeforeKill === held.length &&Number((report.jobBeforeEnd as { images: Record<string, number> } | null)?.images?.['ping.exe'] ?? 0) > 0
        && (report.jobAfterKill as { found: boolean } | undefined)?.found === false && restarted?.state === 'unknown' && restarted.endReason === 'daemon-restart' ? 0 : 1)
      : daemonStop
      ? (ds?.how === 'stdin-eof' && ds.code === 0 && dsRecord?.endReason === 'daemon-stop' && report.survivors === 0 && held.length > 0 ? 0 : 1)
      : brake
      ? (report.survivors === 0 && (report.brakeAnswer as { status: number }).status === 200 && last?.endReason === 'braked' && held.length > 0 ? 0 : 1)
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
    if (daemonKill && lo.leftover + lo.unchecked !== 0) code = 1;
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
