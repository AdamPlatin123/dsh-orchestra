import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';

// The daemon's one outbound HTTP call (orchestra app plan §3, the dispatch desk): a JSON POST to the
// local magpie gateway. Only this module may open a client connection: builtin-policy.ts gives it
// node:http's request and nothing else, and test/helpers/scan-rules.ts (net:magpie-post-loopback-only)
// holds every request call here to host LOOPBACK and method POST. The address is a constant of the
// composition root (working.ts MAGPIE_CHAT_URL); a test hands its own 127.0.0.1 port through the same
// factory, which refuses any other host, scheme, query, fragment or user info.
//
// No proxy and no keep-alive (agent: false), no redirect is followed (a 3xx is just a status), no
// credentials are sent. The reply is read up to maxBytes; past that the call fails as too-big. The
// deadline runs on the Clock the caller hands in (`after`): when it fires the request is torn down and
// the answer is timeout.

const LOOPBACK = '127.0.0.1';

export type LoopbackPostResult =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | { readonly ok: false; readonly why: 'timeout' | 'network' | 'too-big' };

/** A one-shot timer on the Clock: runs `fn` after `ms`, unless the returned cancel ran first. */
export type After = (ms: number, fn: () => void) => () => void;

/** POSTs `body` as JSON to the one address the factory was given. Never rejects. */
export type LoopbackPost = (body: unknown) => Promise<LoopbackPostResult>;

/** The port and path of an http://127.0.0.1[:port]/path URL, or null for anything else. */
export function parseLoopbackUrl(url: string): { port: number; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.hostname !== LOOPBACK || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
  const port = u.port === '' ? 80 : Number(u.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { port, path: u.pathname };
}

export function makeLoopbackPost(opts: { url: string; after: After; timeoutMs: number; maxBytes: number }): LoopbackPost {
  const target = parseLoopbackUrl(opts.url);
  if (target === null) throw new TypeError(`[net] not a loopback http URL: ${opts.url}`);
  const { port } = target;
  const path = target.path;
  return (body) => new Promise<LoopbackPostResult>((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    let cancel: () => void = () => {};
    const done = (r: LoopbackPostResult) => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(r);
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(payload.length), connection: 'close' };
    const req = request({ host: LOOPBACK, port, method: 'POST', path, agent: false, headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) {
          done({ ok: false, why: 'too-big' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done({ ok: true, status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done({ ok: false, why: 'network' }));
    });
    cancel = opts.after(opts.timeoutMs, () => {
      done({ ok: false, why: 'timeout' });
      req.destroy();
    });
    req.on('error', () => done({ ok: false, why: 'network' }));
    req.end(payload);
  });
}
