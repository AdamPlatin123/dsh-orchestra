import assert from 'node:assert/strict';
import * as http from 'node:http';

// Pairing a browser the way the page does (src/server/http.ts, 2026-11-08: pair once): POST /api/pair
// with the console code as JSON, from the page's own origin. One helper for every test that needs a
// paired, token-holding browser; owned-http.test.ts and pairing.test.ts test the routes themselves.

export type Paired = { cookie: string; csrf: string };

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function post(port: number, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  const host = `orchestra.localhost:${port}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Pairs with `code`: the cookie as a Cookie header sends it (`orchestra_sid=...`) and the controller token. */
export async function pairBrowser(server: { port: number }, code: string): Promise<Paired> {
  const r = await post(server.port, '/api/pair', { 'content-type': 'application/json' }, JSON.stringify({ code }));
  assert.equal(r.status, 200, `pairing answered ${r.status}: ${r.body}`);
  const csrf = (JSON.parse(r.body) as { csrf: string }).csrf;
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, csrf };
}

/** Asks for a fresh code on the console (POST /api/pair-code); the status (204 when one was printed). */
export async function askPairCode(server: { port: number }): Promise<number> {
  return (await post(server.port, '/api/pair-code', {})).status;
}
