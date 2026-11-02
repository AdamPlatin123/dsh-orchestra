// The live run of the dispatch desk (orchestra app plan §3): orchestrad in the test profile with --owned,
// driven over HTTP as the page drives it, against the local magpie gateway (http://127.0.0.1:3425, no key)
// as the router model. Not part of the test run.
//   node scripts/live-route.ts [--dispatch] [--keep]
//
// What it does: makes %TEMP%\orchestra-test-route-XXXX (the test profile's dir), starts orchestrad from
// this repository with --test-profile --test-dir <it> --peek-port <free port> --owned, pairs and unlocks
// with the codes orchestrad prints, and asks POST /api/route/suggest for three synthetic sentences. With
// --dispatch it then dispatches the last sentence to its first candidate (POST /api/owned/new with the
// card's routeId), ends that session at once, and reads the tower's router row (GET /api/tower).
//
// What it prints: for each sentence the router model's state (answered, no-answer and why, skipped), the
// candidates as harness, model and source (rule id or the router model), and the time the card took.
// The router model's title and reason are its words about a synthetic sentence; only their lengths are
// printed. Never a code, a token or a path outside the test dir. The test dir is removed unless --keep.
//
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts), as live-smoke.ts: it spawns orchestrad, speaks
// HTTP to it on 127.0.0.1 and waits on timers; it touches no harness root.
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SENTENCES = ['把 README 翻成英文', '用 codex 修一个测试', '解释一下这段代码'];

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
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const doDispatch = argv.includes('--dispatch');
  const testDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-route-'));
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
    throw new Error(`live-route: orchestrad did not print ${re}`);
  };
  const report: Record<string, unknown> = {};
  let code = 1;
  try {
    const pair = (await waitLine(/pairing code (\d{8})/))[1]!;
    await waitLine(/peek page at /);
    report.startup = lines.filter((l) => /owned (Codex|Claude) sessions (on|are off)/.test(l)).map((l) => l.replace(/ \(model .*$/, '').replace(/^orchestrad: /, ''));
    const paired = await request(port, host, 'POST', '/pair', { origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `code=${pair}`);
    if (paired.status !== 303) throw new Error(`live-route: pairing answered ${paired.status}`);
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!;
    const before = lines.length;
    const asked = await request(port, host, 'POST', '/api/owned/unlock-code', { cookie, origin, 'sec-fetch-site': 'same-origin' });
    if (asked.status !== 204) throw new Error(`live-route: unlock-code answered ${asked.status}`);
    const unlockCode = (await waitLine(/unlock code (\d{8})/, before))[1]!;
    const json = { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const unlocked = await request(port, host, 'POST', '/api/owned/unlock', json, JSON.stringify({ code: unlockCode }));
    if (unlocked.status !== 200) throw new Error(`live-route: unlock answered ${unlocked.status}`);
    const h = { ...json, 'x-orchestra-csrf': String(unlocked.json.csrf) };

    const cards: { text: string; card: any }[] = [];
    const out: Record<string, unknown>[] = [];
    for (const text of SENTENCES) {
      const t0 = Date.now();
      const r = await request(port, host, 'POST', '/api/route/suggest', h, JSON.stringify({ text }));
      const ms = Date.now() - t0;
      if (r.status !== 200) {
        out.push({ sentence: text, status: r.status, body: r.body.slice(0, 200) });
        continue;
      }
      cards.push({ text, card: r.json });
      out.push({
        sentence: text, ms, router: r.json.router.state, why: r.json.router.why, taskClass: r.json.taskClass, rules: r.json.rules,
        candidates: r.json.candidates.map((c: any, k: number) => `${c.harness} · ${c.model} · ${c.source === 'model' ? 'router-model' : `rule:${c.rule}${r.json.router.pick === k ? ' (router model agrees)' : ''}`}`),
        titleChars: [...String(r.json.title)].length, modelReasonChars: r.json.candidates.filter((c: any) => c.reason !== null).map((c: any) => [...String(c.reason)].length), off: r.json.off,
      });
    }
    report.suggestions = out;
    const owned = (await request(port, host, 'GET', '/api/owned', { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-orchestra-csrf': h['x-orchestra-csrf'] })).json;
    report.sessionsAfterSuggestions = owned.owned.length;

    if (doDispatch && cards.length > 0) {
      const { text, card } = cards.at(-1)!;
      const first = card.candidates[0];
      const made = await request(port, host, 'POST', '/api/owned/new', h, JSON.stringify({ actionId: crypto.randomUUID(), text, harness: first.harness, model: first.model, routeId: card.routeId }));
      report.dispatch = { status: made.status, harness: first.harness, model: first.model };
      if (made.status === 200) {
        await request(port, host, 'POST', `/api/owned/${made.json.ownedId}/end`, h, JSON.stringify({ actionId: crypto.randomUUID() }));
        const tower = (await request(port, host, 'GET', '/api/tower', { cookie, origin, 'sec-fetch-site': 'same-origin' })).json;
        const d = tower?.router?.dispatch ?? null;
        report.routerRow = d === null ? null : { harness: d.harness, model: d.model, linked: d.node !== null, titleChars: [...String(d.title)].length };
      }
    }
    code = out.every((o) => o.router !== undefined) && report.sessionsAfterSuggestions === 0 ? 0 : 1;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.orchestradSaid = lines.filter((l) => /owned|refus|failed|error/i.test(l) && !/code \d{8}/.test(l)).map((l) => l.replace(testDir, '<testDir>'));
  } finally {
    child.kill();
    await Promise.race([exited, sleep(5000)]);
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

process.exitCode = await main();
