import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';
import { S } from '../../shared/protocol.js';
import { frozen } from '../../shared/frozen.js';
import type { Shape } from './routes.ts';
import { OWNED_BODY_MAX_BYTES, shapeError } from './routes.ts';
import type { AgentRequest, Requests } from '../route/requests.ts';
import { OVER, REQUEST_ID_RE, REQUESTER_ID_RE, REQUEST_LIMITS, REQUEST_STATES, requestTextFits } from '../route/requests.ts';
import type { Log } from '../runtime/log.ts';

// The agent request port (seat, orchestrad side; final.md §5.1; r4 §10.11 item 4: the human verbs hang
// only on the UI listener, the agent side gets a route table of its own on a named pipe). A DSH bundle
// (integrations/dsh-seat, a later step) reaches orchestrad here and nowhere else. It may do exactly three
// things, and only these three routes exist on this listener:
//
//   POST /agent/v1/requests                 {harness, text, cwd, label?, requester: {kind: 'dsh', sessionId}}
//                                           asks for one Codex or Claude run (r4 A17): a card on the paired
//                                           page, nothing more; answers {requestId, state, expiresAt}.
//   GET  /agent/v1/requests/:id?wait=<s>    the request's state; with wait (at most 25 s) a long poll that
//                                           answers at the request's next move or when the wait is over.
//   POST /agent/v1/requests/:id/withdraw    the requester is gone: a pending request goes, a dispatched or
//                                           running one ends its session the normal way (never the brake).
//
// Anything else is 404, whatever it names: there is no allow, deny, dispatch, brake, owned-new or route
// here, not even as a refusal (D8: the agent side physically has none of these; test/server/agent-port
// .test.ts walks the table and knocks on each of the UI's human routes). A request on one of the three
// with a missing or wrong token is 401.
//
// The token: 32 random bytes from node:crypto, base64url, made at each start and written through the
// write fence to ORCHESTRA_HOME\agent-port.token; removed when the port closes. It is compared in
// constant time and never logged, printed or handed to the page. Who can read that file can ask for
// work, and only ask: every request still waits for a person (final.md §6.3 B: no pipe-client-pid check
// in this first slice; the same class as the Job handle residual: it stops accidents, not a hostile
// process of the same user).
//
// The pipe: \\.\pipe\orchestra-agent-<profile> (agentPipeName). node:net listens on it with a
// prototype-free options object (as src/runtime/lock.ts does), at most AGENT_PORT_LIMITS.sockets at once;
// node:http only parses what arrives there and never listens itself. test/helpers/scan-rules.ts
// (net:agent-port-pipe-only) holds the one listen call here to the pipe options.

/** Every agent pipe name starts so; agentPipeName adds the profile. */
const PIPE_PREFIX = '\\\\.\\pipe\\orchestra-agent-';

export const AGENT_PORT_LIMITS = frozen({
  /** Sockets at once: a few long polls and a submit. */
  sockets: 8,
  /** The longest a GET may wait, in seconds (final.md §5.1: wait=25). */
  waitS: 25,
  /** The largest request body. */
  bodyBytes: 16 * 1024,
});

/** The token file's name in ORCHESTRA_HOME. */
export const AGENT_TOKEN_FILE = 'agent-port.token';
/** A token as the Authorization header carries it: 32 bytes, base64url. */
export const AGENT_TOKEN_RE = frozen(/^[A-Za-z0-9_-]{43}$/);

/** The only routes of this listener (method and path pattern). Nothing else is ever matched. */
export const AGENT_ROUTES: readonly { readonly method: 'GET' | 'POST'; readonly path: string }[] = frozen([
  { method: 'POST', path: '/agent/v1/requests' },
  { method: 'GET', path: '/agent/v1/requests/:id' },
  { method: 'POST', path: '/agent/v1/requests/:id/withdraw' },
]);

/** A label for the pipe name: the profile, and for the test profile its dir's own name (a test runs beside others). */
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The agent port's pipe: \\.\pipe\orchestra-agent-real, or for the test profile
 * \\.\pipe\orchestra-agent-test-<name> where <name> is what follows orchestra-test- in its dir's name
 * (lowercased; one outside [a-z0-9._-] or over 64 characters is replaced by 16 hex of its sha256).
 */
export function agentPipeName(profile: 'real' | 'test', testName: string | null = null): string {
  if (profile === 'real') return `${PIPE_PREFIX}real`;
  const n = (testName ?? '').toLowerCase();
  const label = LABEL_RE.test(n) ? n : crypto.createHash('sha256').update(n, 'utf8').digest('hex').slice(0, 16);
  return `${PIPE_PREFIX}test-${label}`;
}

/** The listen options: the pipe and nothing a prototype could add (src/runtime/lock.ts). */
function pipeOptions(pipe: string): { path: string } {
  if (!pipe.startsWith(PIPE_PREFIX)) throw new TypeError(`[agent-port] not an agent pipe: ${pipe}`);
  return Object.freeze(Object.assign(Object.create(null) as { path: string }, { path: pipe }));
}

const { en, re, text, obj, konst } = S;
/** POST /agent/v1/requests's body. The text may be up to the owned body cap as a shape; over REQUEST_LIMITS.textBytes it is 422 text-too-long. */
export const AGENT_REQUEST_BODY: Shape = frozen(obj({
  harness: en(['codex', 'claude']),
  text: text(OWNED_BODY_MAX_BYTES, 'message'),
  cwd: text(260, 'cwd'),
  label: text(120, 'route-title'),
  requester: obj({ kind: konst('dsh'), sessionId: re(REQUESTER_ID_RE, 'requester') }),
}, ['label']));

/** What GET and withdraw answer: A16's thin completion (state, a bounded output marked when cut, why). */
export type AgentReply = {
  requestId: string; state: (typeof REQUEST_STATES)[number]; ownedId: string | null; output: string | null; truncated: boolean; why: string | null;
  /** The wall time a pending request expires at; null once it is not pending. */
  expiresAt: number | null;
};

export function agentReply(r: AgentRequest): AgentReply {
  return {
    requestId: r.requestId, state: r.state, ownedId: r.ownedId, output: r.output, truncated: r.truncated, why: r.why,
    expiresAt: r.state === 'pending' ? r.expiresWall : null,
  };
}

export type AgentPortDeps = {
  pipe: string;
  /** ORCHESTRA_HOME\agent-port.token. */
  tokenFile: string;
  /** The write fence's atomic write and its rm: the only way the token reaches the disk and leaves it. */
  writeToken(file: string, text: string): void;
  removeToken(file: string): void;
  requests: Requests;
  /**
   * Whether the cwd a requester names may be shown on a card: null when it may, else a reason code. The
   * spawn gate's own table judges it (src/os/cwd.ts place: no data dir, harness root, ~/.ssh ...); the
   * session still runs in ORCHESTRA_HOME\work\<id> whatever it named.
   */
  judgeCwd(cwd: string): string | null;
  log: Log;
};

export type AgentPort = { readonly pipe: string; readonly tokenFile: string; close(): Promise<void> };
export type AgentPortStart = { ok: true; port: AgentPort } | { ok: false; why: 'pipe-busy' | 'listen-failed' | 'token-failed'; detail: string };

type Match = { route: (typeof AGENT_ROUTES)[number]; id: string | null };

/** The route a method and path name, with its id; null for anything else (404). A query is only GET's. */
export function matchAgentRoute(method: string | undefined, rawUrl: string | undefined): (Match & { query: URLSearchParams }) | null {
  let u: URL;
  try {
    u = new URL(rawUrl ?? '', 'http://agent.invalid');
  } catch {
    return null;
  }
  if (u.hash !== '' || (rawUrl ?? '').includes('#')) return null;
  const parts = u.pathname.split('/');
  for (const route of AGENT_ROUTES) {
    if (route.method !== method) continue;
    const want = route.path.split('/');
    if (want.length !== parts.length) continue;
    let id: string | null = null;
    let fits = true;
    for (let i = 0; i < want.length && fits; i++) {
      if (want[i] === ':id') {
        id = parts[i]!;
        fits = REQUEST_ID_RE.test(id);
      } else fits = want[i] === parts[i];
    }
    if (!fits) continue;
    if (method !== 'GET' && u.search !== '') return null;
    return { route, id, query: u.searchParams };
  }
  return null;
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, json: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(json);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export async function startAgentPort(deps: AgentPortDeps): Promise<AgentPortStart> {
  const { requests, log } = deps;
  const token = Buffer.from(randomBytes(32).toString('base64url'));
  const holds = (header: unknown): boolean => {
    if (typeof header !== 'string') return false;
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (m === null) return false;
    const given = Buffer.from(m[1]!);
    return given.length === token.length && timingSafeEqual(given, token);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const m = matchAgentRoute(req.method, req.url);
    // Not one of the three: nothing to say, whatever it named (no allow, deny, brake, dispatch here).
    if (m === null) {
      req.resume();
      return send(res, 404, { error: 'not-found' });
    }
    if (!holds(req.headers.authorization)) {
      req.resume();
      log.info('agent-port-refused', { why: 'token' });
      return send(res, 401, { error: 'not-authorized' });
    }
    if (m.route.path === '/agent/v1/requests') {
      if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
        req.resume();
        return send(res, 400, { error: 'bad-request' });
      }
      const raw = await readBody(req, AGENT_PORT_LIMITS.bodyBytes);
      if (raw === null) return send(res, 413, { error: 'body-too-big' });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'bad-request' });
      }
      if (shapeError(AGENT_REQUEST_BODY, body) !== null) return send(res, 400, { error: 'bad-request' });
      const b = body as { harness: 'codex' | 'claude'; text: string; cwd: string; label?: string; requester: { kind: 'dsh'; sessionId: string } };
      // The owned message's own checks (owned-new runs them again at the dispatch).
      if (b.text.trim() === '') return send(res, 400, { error: 'bad-request' });
      if (!requestTextFits(b.text)) return send(res, 422, { error: 'text-too-long' });
      if (b.text.trimStart().startsWith('/')) return send(res, 422, { error: 'slash-command' });
      const cwdWhy = deps.judgeCwd(b.cwd);
      if (cwdWhy !== null) {
        log.info('agent-request-refused', { why: 'cwd-forbidden', detail: cwdWhy });
        return send(res, 422, { error: 'cwd-forbidden' });
      }
      const made = requests.create({ harness: b.harness, text: b.text, cwd: b.cwd, label: b.label ?? null, requester: { kind: 'dsh', sessionId: b.requester.sessionId } });
      if (!made.ok) {
        log.info('agent-request-refused', { why: made.why });
        return send(res, made.why === 'stopped' ? 503 : 429, { error: made.why });
      }
      return send(res, 200, { requestId: made.request.requestId, state: made.request.state, expiresAt: made.request.expiresWall });
    }
    req.resume();
    const id = m.id!;
    if (m.route.method === 'GET') {
      const keys = [...m.query.keys()];
      if (keys.some((k) => k !== 'wait') || keys.length > 1) return send(res, 400, { error: 'bad-request' });
      const w = m.query.get('wait');
      if (w !== null && !/^(?:0|[1-9][0-9]?)$/.test(w)) return send(res, 400, { error: 'bad-request' });
      const waitS = Math.min(AGENT_PORT_LIMITS.waitS, w === null ? 0 : Number(w));
      const first = requests.get(id);
      if (first === null) return send(res, 404, { error: 'request-unknown' });
      if (waitS > 0 && !OVER.includes(first.state)) {
        await requests.wait(id, waitS * 1000);
        if (res.destroyed) return;
      }
      const now = requests.get(id);
      return now === null ? send(res, 404, { error: 'request-unknown' }) : send(res, 200, agentReply(now));
    }
    if ((req.headers['content-length'] ?? '0') !== '0' && !JSON_TYPE.test(req.headers['content-type'] ?? '')) return send(res, 400, { error: 'bad-request' });
    const r = requests.withdraw(id);
    if (r === null) return send(res, 404, { error: 'request-unknown' });
    log.info('agent-request-withdrawn', { requestId: id, state: r.state });
    return send(res, 200, agentReply(r));
  };

  const web = createHttpServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      log.warn('agent-port-failed', { error: e });
      send(res, 500, { error: 'failed' });
    });
  });
  web.keepAliveTimeout = 5_000;
  const sockets = new Set<Socket>();
  const net: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    web.emit('connection', socket);
  });
  net.maxConnections = AGENT_PORT_LIMITS.sockets;

  const listened = await new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
    const onError = (e: unknown) => resolve({ ok: false, code: typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : String(e) });
    net.once('error', onError);
    net.listen(pipeOptions(deps.pipe), () => {
      net.off('error', onError);
      net.on('error', (e) => log.warn('agent-port-error', { error: e }));
      resolve({ ok: true });
    });
  });
  if (!listened.ok) {
    log.warn('agent-port-off', { pipe: deps.pipe, why: listened.code });
    return { ok: false, why: listened.code === 'EADDRINUSE' ? 'pipe-busy' : 'listen-failed', detail: listened.code };
  }
  try {
    deps.writeToken(deps.tokenFile, `${token.toString('ascii')}\n`);
  } catch (e) {
    await new Promise<void>((r) => net.close(() => r()));
    log.warn('agent-port-off', { pipe: deps.pipe, why: 'token-failed', error: e });
    return { ok: false, why: 'token-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  log.info('agent-port', { pipe: deps.pipe, tokenFile: deps.tokenFile });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => (closing ??= (async () => {
    const shut = new Promise<void>((r) => net.close(() => r()));
    for (const s of sockets) s.destroy();
    web.closeAllConnections();
    await shut;
    try {
      deps.removeToken(deps.tokenFile);
    } catch (e) {
      log.warn('agent-port-token-left', { tokenFile: deps.tokenFile, error: e });
    }
    log.info('agent-port-closed', { pipe: deps.pipe });
  })());
  return { ok: true, port: Object.freeze({ pipe: deps.pipe, tokenFile: deps.tokenFile, close }) };
}

/** The limit of a request's wait as REQUEST_LIMITS says it, restated for the seat side's docs. */
export const AGENT_REQUEST_TTL_MS = REQUEST_LIMITS.ttlMs;
