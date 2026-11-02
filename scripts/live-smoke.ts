// The live end-to-end run of an owned session (orchestra app step 4): orchestrad in the test profile with
// --owned, driven over HTTP exactly as the page drives it, against the real codex.exe or the Claude host
// and the local magpie gateway (http://127.0.0.1:3425, no key). Not part of the test run.
//   node scripts/live-smoke.ts --harness codex|claude [--model <id>] [--keep]
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
// is there with the content asked for. Never the model's words, a path outside the test dir, a code or a
// token. The test dir is removed at the end unless --keep is given.
//
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts): it spawns orchestrad, speaks HTTP to it on
// 127.0.0.1, waits on timers and reads the one file the session wrote in its test dir; it touches no
// harness root.
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const FILE = 'smoke.txt';
const WORD = 'orchestra-smoke-ok';
const TASK = `Create a file named ${FILE} in the current working directory containing exactly the text ${WORD}, then read the file back and tell me what it contains.`;
const LIMIT_MS = 6 * 60 * 1000;

function args(): { harness: 'codex' | 'claude'; model: string | null; keep: boolean } {
  const a = process.argv.slice(2);
  let harness: string | null = null;
  let model: string | null = null;
  let keep = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--harness') harness = a[++i] ?? null;
    else if (a[i] === '--model') model = a[++i] ?? null;
    else if (a[i] === '--keep') keep = true;
    else throw new Error(`live-smoke: unknown argument ${a[i]}`);
  }
  if (harness !== 'codex' && harness !== 'claude') throw new Error('live-smoke: --harness codex|claude');
  return { harness, model, keep };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; json: any };

function request(port: number, host: string, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if ((res.headers['content-type'] ?? '').startsWith('application/json')) json = JSON.parse(text);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main(): Promise<number> {
  const { harness, model, keep } = args();
  const testDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-smoke-'));
  fs.mkdirSync(path.join(testDir, 'roots'));
  const port = await freePort();
  const host = `orchestra.localhost:${port}`;
  const origin = `http://${host}`;
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'boot.ts'), '--test-profile', '--test-dir', testDir, '--peek-port', String(port), '--owned'], {
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
  const exited = new Promise<number | null>((r) => child.on('close', r));
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
  const report: Record<string, unknown> = { harness };
  let code = 1;
  try {
    const pair = (await waitLine(/pairing code (\d{8})/))[1]!;
    await waitLine(/peek page at /);
    const owned = lines.filter((l) => /owned (Codex|Claude) sessions (on|are off)/.test(l)).map((l) => l.replace(/ \(model .*$/, '').replace(/^orchestrad: /, ''));
    report.startup = owned;
    // Pair: the form, as the page posts it.
    const paired = await request(port, host, 'POST', '/pair', { origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${pair}`);
    if (paired.status !== 303) throw new Error(`live-smoke: pairing answered ${paired.status}`);
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!;
    // Unlock: the code goes to orchestrad's console only.
    const before = lines.length;
    const asked = await request(port, host, 'POST', '/api/owned/unlock-code', { cookie, origin, 'sec-fetch-site': 'same-origin' });
    if (asked.status !== 204) throw new Error(`live-smoke: unlock-code answered ${asked.status}`);
    const unlockCode = (await waitLine(/unlock code (\d{8})/, before))[1]!;
    const json = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const unlocked = await request(port, host, 'POST', '/api/owned/unlock', json, JSON.stringify({ code: unlockCode }));
    if (unlocked.status !== 200) throw new Error(`live-smoke: unlock answered ${unlocked.status}`);
    const h = { ...json, 'x-orchestra-csrf': String(unlocked.json.csrf) };
    const get = (p: string) => request(port, host, 'GET', p, { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-orchestra-csrf': h['x-orchestra-csrf'] });
    const post = (p: string, body: Record<string, unknown>) => request(port, host, 'POST', p, h, JSON.stringify({ actionId: crypto.randomUUID(), ...body }));

    const made = await post('/api/owned/new', { text: TASK, harness, ...(model === null ? {} : { model }) });
    if (made.status !== 200) throw new Error(`live-smoke: new answered ${made.status} ${made.body}`);
    const ownedId = String(made.json.ownedId);
    const states: string[] = [];
    const allowed: Record<string, number> = {};
    const refusals: Record<string, number> = {};
    let after = 0;
    const events: { kind: string; state: string | null; text: string | null }[] = [];
    let replied = false;
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > LIMIT_MS) throw new Error('live-smoke: no reply within the time limit');
      const list = (await get('/api/owned')).json;
      const me = list.owned.find((o: { ownedId: string }) => o.ownedId === ownedId);
      if (me !== undefined && states.at(-1) !== me.state) states.push(me.state);
      for (const a of list.approvals.filter((x: { ownedId: string }) => x.ownedId === ownedId)) {
        if (!a.canAccept) {
          await post(`/api/approvals/${a.approvalId}/deny`, {});
          continue;
        }
        // The list just moved (the card came): an allow within 750 ms of a change is stale-view. Wait, read again.
        await sleep(900);
        const fresh = (await get('/api/owned')).json;
        if (!fresh.approvals.some((x: { approvalId: string }) => x.approvalId === a.approvalId)) continue;
        const r = await post(`/api/approvals/${a.approvalId}/allow`, { digest: a.digest, rev: fresh.rev });
        if (r.status === 200) allowed[a.kind] = (allowed[a.kind] ?? 0) + 1;
        else refusals[String(r.json?.error ?? r.status)] = (refusals[String(r.json?.error ?? r.status)] ?? 0) + 1;
      }
      const feed = (await get(`/api/owned/${ownedId}/feed?after=${after}`)).json;
      for (const e of feed.events) events.push({ kind: e.kind, state: e.state, text: e.text });
      after = feed.to;
      replied = events.some((e) => e.kind === 'text' && e.state !== 'partial' && (e.text ?? '').length > 0);
      const turnOver = events.some((e) => e.kind === 'lifecycle' && /^turn-(ended|failed|max-turns|interrupted|unknown)$/.test(e.state ?? ''));
      if (me !== undefined && (me.state === 'failed' || me.state === 'ended')) break;
      if (replied && turnOver && me?.state === 'idle') break;
      await sleep(1000);
    }
    const file = path.join(testDir, 'orchestra', 'work', ownedId, FILE);
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const mentions = events.some((e) => e.kind === 'text' && (e.text ?? '').includes(WORD));
    const ended = await post(`/api/owned/${ownedId}/end`, {});
    await sleep(1500);
    const last = (await get('/api/owned')).json.owned.find((o: { ownedId: string }) => o.ownedId === ownedId);
    const count: Record<string, number> = {};
    for (const e of events) {
      const k = `${e.kind}${e.state === null ? '' : `:${e.state}`}`;
      count[k] = (count[k] ?? 0) + 1;
    }
    Object.assign(report, {
      states, endState: last === undefined ? null : `${last.state}/${last.endReason}`, endAnswer: ended.status,
      approvalsAllowed: allowed, approvalRefusals: refusals, feedEvents: count, replyInFeed: replied, replyNamesTheWord: mentions,
      fileWritten: written !== null, fileContentAsAsked: written !== null && written.trim() === WORD,
    });
    code = replied && written !== null && written.trim() === WORD ? 0 : 1;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.orchestradSaid = lines.filter((l) => /owned|refus|failed|error/i.test(l) && !/code \d{8}/.test(l)).map((l) => l.replace(testDir, '<testDir>'));
  } finally {
    child.kill();
    await Promise.race([exited, sleep(5000)]);
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
