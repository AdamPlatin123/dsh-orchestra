import { createServer } from 'node:net';
import type { RunIn } from '../os/project-roots.ts';
import type { Server, Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';
import { S } from '../../shared/protocol.js';
import { frozen } from '../../shared/frozen.js';
import type { Shape } from './routes.ts';
import { OWNED_BODY_MAX_BYTES, shapeError } from './routes.ts';
import type { AgentRequest, OutputCut, Requests } from '../route/requests.ts';
import { OVER, REQUEST_ID_RE, REQUESTER_ID_RE, REQUEST_LIMITS, REQUEST_STATES, WITHDRAW_KEY_RE, requestTextFits } from '../route/requests.ts';
import type { After } from '../net/magpie.ts';
import type { Log } from '../runtime/log.ts';

// The agent request port (seat, orchestrad side; final.md §5.1; r4 §10.11 item 4: the human verbs hang
// only on the UI listener, the agent side gets a route table of its own on a named pipe). A DSH bundle
// (integrations/dsh-seat, a later step) reaches orchestrad here and nowhere else. It may do exactly three
// things, and only these three routes exist on this listener:
//
//   POST /agent/v1/requests                 {harness, text, cwd, label?, requester: {kind: 'dsh', sessionId | null}}
//                                           asks for one Codex or Claude run (r4 A17): a card on the paired
//                                           page, nothing more; answers {requestId, state, expiresAt, withdrawKey}.
//   GET  /agent/v1/requests/:id?wait=<s>    the request's state; with wait (at most 25 s) a long poll that
//                                           answers at the request's next move or when the wait is over.
//   POST /agent/v1/requests/:id/withdraw    {withdrawKey}: the requester is gone: a pending request goes, a
//                                           dispatched or running one ends its session the normal way (never
//                                           the brake). Only the submitter holds the key (403 not-requester).
//
// Anything else is 404, whatever it names: there is no allow, deny, dispatch, brake, owned-new or route
// here, not even as a refusal (D8: the agent side physically has none of these; test/server/agent-port
// .test.ts walks the table and knocks on each of the UI's human routes). A request on one of the three
// that does not prove the token is 401.
//
// The token: 32 random bytes from node:crypto, base64url, made at each start and written through the
// write fence to ORCHESTRA_HOME\agent-port.token; removed when the port closes. It never crosses the pipe
// and is never logged, printed or handed to the page. Both sides prove they hold it (AGENT_AUTH):
//   - the client sends a fresh nonce, its wall time and HMAC-SHA256(token, request line: nonce, time,
//     method, path, sha256 of the body); orchestrad checks the MAC in constant time, the time within
//     AGENT_PORT_LIMITS.skewMs of its own, and that it has not seen the nonce (a replay is 401);
//   - orchestrad answers every request it authenticated with HMAC-SHA256(token, reply line: that nonce,
//     the status, the body) in x-orchestra-proof, and the seat believes nothing without it.
// So a process of the same user that only grabs the pipe name (Windows lets it add an instance of the
// same pipe, and orchestrad's crash leaves the name free) learns no token and cannot forge a reply. What
// stays (final.md §6.3 B: no pipe-client-pid check in this first slice; the same class as the Job handle
// residual, it stops accidents, not a hostile process of the same user):
//   - whoever reads the token file can ask for work, and only ask: every request waits for a person;
//     the requester it names is its own word (the page says "自称", "未核实"). A same-user process,
//     an owned Codex session whose sandbox reads anything among them, can read that file wherever it lies.
//   - whoever reads the token file can also answer as orchestrad on a pipe instance it grabbed, and so
//     forge a "done" with any text: the seat says only what orchestrad's port reported, and marks the
//     worker's text as unreviewed data (integrations/dsh-seat/README.md, known limits).
//   - a pipe grabber can drop or delay what it intercepts, or relay it once (a relay is the request
//     the seat itself sent: the MAC binds the method, path and body).
//
// The pipe: \\.\pipe\orchestra-agent-<profile> (agentPipeName). node:net listens on it with a
// prototype-free options object (as src/runtime/lock.ts does), at most AGENT_PORT_LIMITS.sockets at once
// (every request orchestrad keeps can hold one long poll, plus room for submits and withdraws); node:http
// only parses what arrives there and never listens itself, so its own header and request timeouts never
// run (node arms them on 'listening'): each socket has deadlines of its own on the Clock instead (headerMs
// to send a request, requestMs for one request, then headerMs again), and a socket past one is destroyed.
// test/helpers/scan-rules.ts (net:agent-port-pipe-only) holds the one listen call here to the pipe options.

/** Every agent pipe name starts so; agentPipeName adds the profile. */
const PIPE_PREFIX = '\\\\.\\pipe\\orchestra-agent-';

export const AGENT_PORT_LIMITS = frozen({
  /** Sockets at once: one long poll for every request orchestrad keeps, and room for submits and withdraws. */
  sockets: REQUEST_LIMITS.kept + 4,
  /** The longest a GET may wait, in seconds (final.md §5.1: wait=25). */
  waitS: 25,
  /** The largest request body. */
  bodyBytes: 16 * 1024,
  /** A socket must have sent a whole request head this soon after it opened or its last reply. */
  headerMs: 5_000,
  /** One request, a long poll included, ends this soon after its head arrived. */
  requestMs: 25_000 + 15_000,
  /** How far a client's wall time may be from orchestrad's. */
  skewMs: 60_000,
  /** Nonces remembered (each for twice skewMs); a full cache refuses with 429 busy. */
  nonces: 4096,
  /** A refused request is logged at most once in this long (the lines between are counted). */
  refusedLogMs: 60_000,
  /** At close, long polls already answered get this long to hand their reply to the pipe. */
  closeWaitMs: 500,
});

/** The token file's name in ORCHESTRA_HOME. */
export const AGENT_TOKEN_FILE = 'agent-port.token';
/** A token as the token file holds it: 32 bytes, base64url. */
export const AGENT_TOKEN_RE = frozen(/^[A-Za-z0-9_-]{43}$/);

/** How a request and its reply prove the token (the header's names; the seat restates them). */
export const AGENT_AUTH = frozen({
  scheme: 'Orchestra-HMAC',
  nonceHeader: 'x-orchestra-nonce',
  timeHeader: 'x-orchestra-time',
  proofHeader: 'x-orchestra-proof',
});
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const TIME_RE = /^[1-9][0-9]{0,15}$/;
const MAC_HEADER_RE = /^Orchestra-HMAC ([A-Za-z0-9_-]{43})$/;

/** The request's MAC: HMAC-SHA256(token, nonce, time, method, path and query, sha256 of the body), base64url. */
export function agentRequestMac(token: string, nonce: string, time: string, method: string, pathAndQuery: string, body: Buffer | string): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', token).update(`orchestra-agent-request\n${nonce}\n${time}\n${method}\n${pathAndQuery}\n${bodyHash}`).digest('base64url');
}

/** The reply's proof: HMAC-SHA256(token, the request's nonce, the status, the body), base64url. */
export function agentReplyMac(token: string, nonce: string, status: number, body: Buffer | string): string {
  return crypto.createHmac('sha256', token).update(`orchestra-agent-reply\n${nonce}\n${status}\n`).update(body).digest('base64url');
}

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

const { en, re, text, obj, konst, nul } = S;
/**
 * POST /agent/v1/requests's body. The text may be up to the owned body cap as a shape; over
 * REQUEST_LIMITS.textBytes (or over it once written out) it is 422 text-too-long. sessionId null: the
 * requester named none (the card says 未知).
 */
export const AGENT_REQUEST_BODY: Shape = frozen(obj({
  harness: en(['codex', 'claude']),
  text: text(OWNED_BODY_MAX_BYTES, 'message'),
  cwd: text(260, 'cwd'),
  label: text(120, 'route-title'),
  requester: obj({ kind: konst('dsh'), sessionId: nul(re(REQUESTER_ID_RE, 'requester')) }),
}, ['label']));
/** POST /agent/v1/requests/:id/withdraw's body: the key create() handed the submitter. */
export const AGENT_WITHDRAW_BODY: Shape = frozen(obj({ withdrawKey: re(WITHDRAW_KEY_RE, 'withdrawKey') }));

/** What GET and withdraw answer: A16's thin completion (state, a bounded output marked when cut and why, why). */
export type AgentReply = {
  requestId: string; state: (typeof REQUEST_STATES)[number]; ownedId: string | null; output: string | null; truncated: boolean;
  /** Where the output was cut (cap, final-cut, feed-clipped); empty when it was not. */
  cuts: OutputCut[];
  why: string | null;
  /** The wall time a pending request expires at; null once it is not pending. */
  expiresAt: number | null;
};

export function agentReply(r: AgentRequest): AgentReply {
  return {
    requestId: r.requestId, state: r.state, ownedId: r.ownedId, output: r.output, truncated: r.truncated, cuts: [...r.cuts], why: r.why,
    expiresAt: r.state === 'pending' ? r.expiresWall : null,
  };
}

export type AgentPortDeps = {
  /** One-shot timers on the Clock (r4 invariant 21): the socket deadlines and the close wait. */
  after: After;
  nowMono(): number;
  /** The wall time a client's x-orchestra-time is held against. */
  nowWall(): number;
  pipe: string;
  /** ORCHESTRA_HOME\agent-port.token. */
  tokenFile: string;
  /** The write fence's atomic write and its rm: the only way the token reaches the disk and leaves it. */
  writeToken(file: string, text: string): void;
  removeToken(file: string): void;
  requests: Requests;
  /**
   * Whether the cwd a requester names may be shown on a card: null when it may, else a reason code. The
   * spawn gate's own table judges it (src/os/cwd.ts place: no data dir, harness root, ~/.ssh ...).
   */
  judgeCwd(cwd: string): string | null;
  /**
   * Where a dispatched session for this cwd would run (orchestra app plan 项目根): in it when it lies in a
   * project root the person named and passes the table (src/os/project-roots.ts placeRunIn), else null and
   * why. Absent (no project roots, or the owned part off): it runs in ORCHESTRA_HOME\work\<id> whatever it named.
   */
  placeCwd?(cwd: string): RunIn;
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

/** The body, at most `max` bytes; null when it is over or the stream failed. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export async function startAgentPort(deps: AgentPortDeps): Promise<AgentPortStart> {
  const { requests, log } = deps;
  const token = randomBytes(32).toString('base64url');

  // Nonces seen, each until a mono time (a replay inside the time window is refused).
  const seen = new Map<string, number>();
  /** Why the request does not prove the token, or its nonce when it does. */
  const prove = (req: IncomingMessage, body: Buffer): { ok: true; nonce: string } | { ok: false; why: 'token' | 'time' | 'replay' | 'busy' } => {
    const m = MAC_HEADER_RE.exec(String(req.headers.authorization ?? ''));
    const nonce = req.headers[AGENT_AUTH.nonceHeader];
    const time = req.headers[AGENT_AUTH.timeHeader];
    if (m === null || typeof nonce !== 'string' || !NONCE_RE.test(nonce) || typeof time !== 'string' || !TIME_RE.test(time)) return { ok: false, why: 'token' };
    const want = Buffer.from(agentRequestMac(token, nonce, time, req.method ?? '', req.url ?? '', body));
    const given = Buffer.from(m[1]!);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, why: 'token' };
    if (Math.abs(Number(time) - deps.nowWall()) > AGENT_PORT_LIMITS.skewMs) return { ok: false, why: 'time' };
    const now = deps.nowMono();
    for (const [n, until] of seen) if (until <= now) seen.delete(n);
    if (seen.has(nonce)) return { ok: false, why: 'replay' };
    if (seen.size >= AGENT_PORT_LIMITS.nonces) return { ok: false, why: 'busy' };
    seen.set(nonce, now + 2 * AGENT_PORT_LIMITS.skewMs);
    return { ok: true, nonce };
  };

  // Refusals are counted and logged at most once a refusedLogMs (an unauthorized flood cannot grow the log).
  let refused = 0;
  let refusedAt = -Infinity;
  const noteRefused = (why: string) => {
    refused++;
    const now = deps.nowMono();
    if (now - refusedAt < AGENT_PORT_LIMITS.refusedLogMs) return;
    log.info('agent-port-refused', { why, count: refused });
    refused = 0;
    refusedAt = now;
  };

  /** One JSON reply; with the request's nonce it carries the proof that orchestrad holds the token. */
  const send = (res: ServerResponse, status: number, json: unknown, nonce: string | null = null): void => {
    if (res.headersSent || res.destroyed) return;
    const body = JSON.stringify(json);
    const headers: Record<string, string | number> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) };
    if (nonce !== null) headers[AGENT_AUTH.proofHeader] = agentReplyMac(token, nonce, status, body);
    res.writeHead(status, headers);
    res.end(body);
  };

  // Long polls in flight: at close they are let go and get closeWaitMs to hand their reply to the pipe.
  let letGo: () => void = () => {};
  const closingNow = new Promise<void>((r) => {
    letGo = r;
  });
  const answering = new Set<Promise<void>>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const m = matchAgentRoute(req.method, req.url);
    // Not one of the three: nothing to say, whatever it named (no allow, deny, brake, dispatch here).
    if (m === null) {
      req.resume();
      return send(res, 404, { error: 'not-found' });
    }
    const raw = await readBody(req, AGENT_PORT_LIMITS.bodyBytes);
    if (raw === null) return send(res, 413, { error: 'body-too-big' });
    const proof = prove(req, raw);
    if (!proof.ok) {
      noteRefused(proof.why);
      return proof.why === 'busy' ? send(res, 429, { error: 'busy' }) : send(res, 401, { error: 'not-authorized' });
    }
    const nonce = proof.nonce;
    const reply = (status: number, json: unknown) => send(res, status, json, nonce);
    const parse = (shape: Shape): unknown => {
      if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return undefined;
      try {
        const body: unknown = JSON.parse(raw.toString('utf8'));
        return shapeError(shape, body) === null ? body : undefined;
      } catch {
        return undefined;
      }
    };
    if (m.route.path === '/agent/v1/requests') {
      const body = parse(AGENT_REQUEST_BODY);
      if (body === undefined) return reply(400, { error: 'bad-request' });
      const b = body as { harness: 'codex' | 'claude'; text: string; cwd: string; label?: string; requester: { kind: 'dsh'; sessionId: string | null } };
      // The owned message's own checks (owned-new runs them again at the dispatch).
      if (b.text.trim() === '') return reply(400, { error: 'bad-request' });
      if (!requestTextFits(b.text)) return reply(422, { error: 'text-too-long' });
      if (b.text.trimStart().startsWith('/')) return reply(422, { error: 'slash-command' });
      const cwdWhy = deps.judgeCwd(b.cwd);
      if (cwdWhy !== null) {
        log.info('agent-request-refused', { why: 'cwd-forbidden', detail: cwdWhy });
        return reply(422, { error: 'cwd-forbidden' });
      }
      const at: RunIn = deps.placeCwd?.(b.cwd) ?? { runIn: null, why: 'no-roots' };
      const made = requests.create({ harness: b.harness, text: b.text, cwd: b.cwd, label: b.label ?? null, requester: { kind: 'dsh', sessionId: b.requester.sessionId }, runIn: at.runIn, runInWhy: at.why });
      if (!made.ok) {
        log.info('agent-request-refused', { why: made.why });
        const status = made.why === 'stopped' ? 503 : made.why === 'text-too-long' || made.why === 'cwd-too-long' ? 422 : 429;
        return reply(status, { error: made.why });
      }
      // The withdraw key goes to this reply alone: never logged, never listed, never on the page.
      return reply(200, { requestId: made.request.requestId, state: made.request.state, expiresAt: made.request.expiresWall, withdrawKey: made.withdrawKey });
    }
    const id = m.id!;
    if (m.route.method === 'GET') {
      const keys = [...m.query.keys()];
      if (raw.length > 0 || keys.some((k) => k !== 'wait') || keys.length > 1) return reply(400, { error: 'bad-request' });
      const w = m.query.get('wait');
      if (w !== null && !/^(?:0|[1-9][0-9]?)$/.test(w)) return reply(400, { error: 'bad-request' });
      const waitS = Math.min(AGENT_PORT_LIMITS.waitS, w === null ? 0 : Number(w));
      const first = requests.get(id);
      if (first === null) return reply(404, { error: 'request-unknown' });
      if (waitS > 0 && !OVER.includes(first.state)) {
        let free: () => void = () => {};
        const out = new Promise<void>((r) => {
          free = () => {
            answering.delete(out);
            r();
          };
        });
        answering.add(out);
        res.once('finish', free);
        res.once('close', free);
        await Promise.race([requests.wait(id, waitS * 1000), closingNow]);
        if (res.destroyed) return;
      }
      const now = requests.get(id);
      if (now === null) return reply(404, { error: 'request-unknown' });
      // T1: "fetched" only once a done reply went to the pipe (still no proof the requester read it).
      if (now.state === 'done') res.once('finish', () => requests.fetched(id));
      return reply(200, agentReply(now));
    }
    const body = parse(AGENT_WITHDRAW_BODY);
    if (body === undefined) return reply(400, { error: 'bad-request' });
    const r = requests.withdraw(id, (body as { withdrawKey: string }).withdrawKey);
    if (!r.ok) {
      if (r.why === 'not-requester') log.info('agent-request-refused', { why: 'not-requester' });
      return r.why === 'request-unknown' ? reply(404, { error: 'request-unknown' }) : reply(403, { error: 'not-requester' });
    }
    log.info('agent-request-withdrawn', { requestId: id, state: r.request.state });
    return reply(200, agentReply(r.request));
  };

  // Each socket's deadline (node:http's own timeouts never run here: it never listens).
  const deadlines = new WeakMap<Socket, (ms: number) => void>();
  const web = createHttpServer((req, res) => {
    const arm = deadlines.get(req.socket);
    arm?.(AGENT_PORT_LIMITS.requestMs);
    // The reply is out: the next request on this socket must come soon, or the socket goes.
    res.once('finish', () => arm?.(AGENT_PORT_LIMITS.headerMs));
    void handle(req, res).catch((e: unknown) => {
      log.warn('agent-port-failed', { error: e });
      send(res, 500, { error: 'failed' });
    });
  });
  web.keepAliveTimeout = 5_000;
  const sockets = new Set<Socket>();
  const net: Server = createServer((socket) => {
    sockets.add(socket);
    let cancel: () => void = () => {};
    let gone = false;
    const arm = (ms: number) => {
      if (gone) return;
      cancel();
      cancel = deps.after(ms, () => socket.destroy());
    };
    deadlines.set(socket, arm);
    arm(AGENT_PORT_LIMITS.headerMs);
    socket.on('close', () => {
      gone = true;
      cancel();
      sockets.delete(socket);
    });
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
    deps.writeToken(deps.tokenFile, `${token}\n`);
  } catch (e) {
    await new Promise<void>((r) => net.close(() => r()));
    log.warn('agent-port-off', { pipe: deps.pipe, why: 'token-failed', error: e });
    return { ok: false, why: 'token-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  log.info('agent-port', { pipe: deps.pipe, tokenFile: deps.tokenFile });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => (closing ??= (async () => {
    const shut = new Promise<void>((r) => net.close(() => r()));
    // Long polls answer first (the requests' close() moved them to failed, daemon-stop; any other answers
    // its state now), each with closeWaitMs at most to hand its reply to the pipe; then every socket goes.
    letGo();
    let cancel: () => void = () => {};
    await Promise.race([Promise.all([...answering]), new Promise<void>((r) => { cancel = deps.after(AGENT_PORT_LIMITS.closeWaitMs, r); })]);
    cancel();
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
