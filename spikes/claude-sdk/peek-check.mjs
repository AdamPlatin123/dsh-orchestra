// Spike: can the thin slice's peek page (src/sources/peek.ts + src/server/http.ts) show the session
// probe.mjs started, unchanged? Runs a TEST-profile orchestrad over a scratch root that holds a copy
// of that one transcript, pairs, fetches the list and the session page, and prints counts and the
// type column only: no event text is printed or written.
//
//   node peek-check.mjs --transcript <projects/<dir>/<uuid>.jsonl> [--out <json>]
// The test profile wants --test-dir directly inside the OS temp dir, so the copy lives in a fresh
// directory there and is removed at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []));
const BOOT = fileURLToPath(new URL('../../src/boot.ts', import.meta.url));
const src = args.transcript;
if (!src) throw new Error('need --transcript');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-peek-check-'));
const id = path.basename(src, '.jsonl');
const dirName = path.basename(path.dirname(src));
const dst = path.join(work, 'roots', 'claude', 'projects', dirName, `${id}.jsonl`);
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const child = spawn(process.execPath, [BOOT, '--test-profile', '--test-dir', work, '--peek-port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const lines = [];
const onData = (b) => lines.push(...String(b).split(/\r?\n/).filter(Boolean));
child.stdout.on('data', onData);
child.stderr.on('data', onData);
const deadline = Date.now() + 90000;
while (!lines.some((l) => l.startsWith('orchestrad: peek page at ')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
const code = /^orchestrad: pairing code (\d{8})$/.exec(lines.find((l) => l.startsWith('orchestrad: pairing code')) ?? '')?.[1];

function request(method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `orchestra.localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Stop orchestrad and remove the scratch copy only; the original transcript is never touched.
async function cleanup() {
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 10000))]);
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const out = { port, started: code !== undefined, bootLines: lines.length };
if (!out.started) {
  await cleanup();
  console.log(lines.join('\n')); // orchestrad's own boot output: paths and reasons, no session text
  throw new Error('orchestrad did not print a pairing code');
}
try {
  const paired = await request('POST', '/pair', { origin: `http://orchestra.localhost:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, `code=${code}`);
  out.pairStatus = paired.status;
  const cookie = String(paired.headers['set-cookie']).split(';')[0];
  const list = await request('GET', '/', { cookie });
  const ids = [...list.body.matchAll(/href="\/session\?id=([0-9a-f]{20})"/g)].map((m) => m[1]);
  out.list = { status: list.status, rows: ids.length, showsProjectDir: list.body.includes(dirName) };
  const page = await request('GET', `/session?id=${ids[0]}`, { cookie });
  const rows = [...page.body.matchAll(/<tr><td class="n">([^<]*)<\/td><td class="n">([^<]*)<\/td><td class="t">([^<]*)<\/td><\/tr>/g)];
  const types = {};
  let emptyText = 0;
  const emptyByType = {};
  let noTime = 0;
  for (const r of rows) {
    types[r[2]] = (types[r[2]] ?? 0) + 1;
    if (r[3].trim() === '') {
      emptyText += 1;
      emptyByType[r[2]] = (emptyByType[r[2]] ?? 0) + 1;
    }
    if (r[1].trim() === '') noTime += 1;
  }
  out.session = { status: page.status, eventRows: rows.length, types, emptyText, emptyByType, noTime, transcriptLines: fs.readFileSync(dst, 'utf8').split('\n').filter(Boolean).length };
} finally {
  await cleanup();
}
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
