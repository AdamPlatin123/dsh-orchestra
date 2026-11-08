import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import type { Clock } from '../runtime/clock.ts';
import type { Log } from '../runtime/log.ts';
import type { PeekEvent, PeekView, Redact } from '../sources/peek.ts';
import { PEEK_LIMITS, findSession, readSession } from '../sources/peek.ts';
import { makeStageBuilder } from '../sources/stage.ts';
import type { OwnedSeats, TowerSnapshot } from '../sources/tower.ts';
import { makeTowerBuilder } from '../sources/tower.ts';
import { validateTower } from '../../shared/tower-contract.js';
import type { OwnedAnswer, OwnedApiOptions } from './owned.ts';
import { makeOwnedApi } from './owned.ts';
import type { Pairings } from './pairings.ts';
import { PAIR_COOKIE, makePairings, pairCookie } from './pairings.ts';
import { PAIR_CODE_RE, routeOf, shapeError } from './routes.ts';
import { ERROR_STATUS } from '../../shared/protocol.js';
import type { ErrorCode } from '../../shared/protocol.js';
import type { UiAsset } from './ui-assets.ts';
import { UI_ASSETS } from './ui-assets.ts';
import { frozen } from '../../shared/frozen.js';

// The peek server: the thin slice ahead of plan steps 4-5. It shows the tower of the sessions under the
// harness roots and the last events of one, and pairs a browser.
//
// Taken from step 4 as it stands there: loopback only (127.0.0.1 and ::1 on the same port; a port
// someone else holds on ::1 refuses the start, since the browser may try ::1 first and would hand that
// holder the cookie); Host exactly orchestra.localhost:<port>; an 8-digit one-time pairing code from
// the console, 10 minutes, compared in constant time, void after 5 wrong tries in a row, pairing shut
// after 20 wrong in all until a restart; a host-only cookie (HttpOnly, SameSite=Strict, Path=/); Origin
// exact and Sec-Fetch-Site same-origin on the POSTs; Sec-Fetch-Site, when sent, only same-origin or none
// on any route; no CORS header.
//
// Pairing (2026-11-08: pair once). A browser pairs once, with one code, and stays paired across restarts
// of orchestrad and of the browser (src/server/pairings.ts: 16 browsers at most, 90 days each, kept on
// disk as digests only). The console prints a code at the start only while no browser is remembered;
// POST /api/pair-code (no cookie needed, no body) prints a fresh one there, replacing the last, and
// answers 204, never the code. POST /api/pair (JSON {code}) trades a right code for the cookie
// (Max-Age 90 days) and the controller token, in that one reply; a browser that pairs again drops its
// old pairing. The token is the only thing the page must keep (ui/prefs.js); the cookie alone buys the
// shell and the read-only peek GETs, never an owned route (src/server/owned.ts says why).
//
// Not as step 4 has it, for this slice only: the full-record page (/session) is rendered here as HTML
// with every source string escaped, and carries no script at all, so its CSP is stricter than r4:595
// (script-src 'none' through default-src).
//
// The page (orchestra app plan §5, 第三轮方案 22) is the one place with a script: GET / serves the embedded
// ui/home.html, paired or not (unpaired, the page shows its pairing dialog and its reads answer 403);
// /assets/ui/* and /assets/shared/* serve the embedded modules and styles it loads (src/server/ui-assets.ts,
// by map lookup only, no cookie: they hold no session data), and /api/tower and /api/peek/session answer
// its polls with JSON. Those routes carry UI_CSP: script and connections to self only, trusted types on
// with no policy, so the page writes the DOM through textContent and attributes alone. Every other route
// keeps the scriptless CSP: /session, the full record of one session the page's detail links to (unpaired:
// a redirect to /). The old stage and tower pages are gone (2026-11-08 for the tower): /stage and /tower
// answer a redirect to /. GET /api/peek/stage still answers the stage snapshot the tower is built from
// (shared/stage-contract.js), for tools and tests; no page polls it.
//
// alpha 0.2 (slice design §2.7): when given `owned`, the owned-session routes of routes.ts (/api/owned/*,
// /api/approvals/*, /api/import/*, POST /api/pair/forget) go to src/server/owned.ts, which runs their
// check chain after the Host check here: the pairing cookie, Origin, Sec-Fetch-Site, JSON, and the
// controller token of that cookie's pairing. Without `owned` they do not exist. With `ownedSeats` the tower
// draws the owned sessions too, in a project of their own (src/sources/tower.ts).
//
// GET /api/tower answers a snapshot only once it passes shared/tower-contract.js (T1-T3 travel with the
// payload), the way the owned routes hold their replies to theirs; one that does not is logged and
// answered 500, and the page keeps the last good one. The page itself checks only the frame it reads.

export const PEEK_HOST = 'orchestra.localhost';
export const PAIR_TTL_MS = 10 * 60 * 1000;
/** The largest body POST /api/pair takes: `{"code":"12345678"}` and some room. */
export const PAIR_BODY_MAX_BYTES = 1024;

const LIMITS = frozen({ wrongInRow: 5, wrongTotal: 20 });
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const CSP = "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";
/** The page's CSP: stricter than r4:595 (nothing inline, trusted types with no policy). */
export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const UI_HEADERS: readonly [string, string][] = frozen([['Content-Security-Policy', UI_CSP]]);
const ASSET_PATH = /^(?:ui|shared)\/[a-z0-9][a-z0-9-]*\.(?:js|css)$/;
const HEX20 = /^[0-9a-f]{20}$/;
const PAIR_ROUTE = routeOf('POST', '/api/pair')!;
const BASE_HEADERS: readonly [string, string][] = frozen([
  ['Content-Security-Policy', CSP],
  ['X-Content-Type-Options', 'nosniff'],
  // Not no-referrer, as step 4 has it: under no-referrer a browser sends `Origin: null` on a POST,
  // even to its own origin (Fetch, "append a request Origin header"), and the exact Origin check would
  // refuse every pairing. same-origin sends nothing to another site either.
  ['Referrer-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  // Every page holds session text: never cached.
  ['Cache-Control', 'no-store'],
]);

export type PeekServerOptions = {
  /** 0 picks a free port (tests). */
  port: number;
  gate: ReadGate;
  roots: readonly HarnessRoot[];
  redact: Redact;
  clock: Clock;
  log: Log;
  /** The code the console printed at the start, or null (none printed: a browser is remembered, or the console is off). */
  pairingCode: string | null;
  /**
   * Prints a code POST /api/pair-code issued, where the pairing code goes (never through the log or a
   * reply); null or absent when that console is off: the route answers 503.
   */
  printPairCode?: ((code: string) => void) | null;
  /** The remembered browsers (src/server/pairings.ts); absent, a store in memory only. */
  pairings?: Pairings;
  profile: 'real' | 'test';
  /** The embedded page files: UI_ASSETS unless a test hands its own. */
  assets?: Readonly<Record<string, UiAsset>>;
  /** The owned-session API (alpha 0.2); absent, its routes do not exist. */
  owned?: OwnedApiOptions;
  /** The owned sessions as the tower draws them (orchestra app plan section 2); absent, the tower has none. */
  ownedSeats?: OwnedSeats;
};

export type PeekServer = { port: number; url: string; close(): Promise<void>; /** The tower as GET /api/tower answers it, for the front desk's read. */ tower(): TowerSnapshot };

export type PairOutcome = 'ok' | 'wrong' | 'voided' | 'shut' | 'expired' | 'no-code';

/** A fresh 8-digit code from node:crypto. */
export function newPairCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0');
}

/**
 * The pairing rules of plan step 4 over one console code at a time; the time is the Clock's monotonic
 * one. issue() replaces the code (and its count of wrong tries in a row); the count in all stays.
 */
export function makePairing(code: string | null, issuedAt: number) {
  let current = code;
  let issuedMono = issuedAt;
  let wrongInRow = 0;
  let wrongTotal = 0;
  return {
    get open(): boolean {
      return current !== null && wrongTotal < LIMITS.wrongTotal;
    },
    /** A fresh code, replacing any; null once pairing is shut (20 wrong in all). */
    issue(nowMono: number): string | null {
      if (wrongTotal >= LIMITS.wrongTotal) return null;
      current = newPairCode();
      issuedMono = nowMono;
      wrongInRow = 0;
      return current;
    },
    attempt(given: string, nowMono: number): PairOutcome {
      if (wrongTotal >= LIMITS.wrongTotal) return 'shut';
      if (current === null) return 'no-code';
      if (nowMono - issuedMono > PAIR_TTL_MS) {
        current = null;
        return 'expired';
      }
      const a = Buffer.from(current);
      const b = Buffer.from(given);
      if (PAIR_CODE_RE.test(given) && a.length === b.length && timingSafeEqual(a, b)) {
        current = null;
        return 'ok';
      }
      wrongInRow++;
      wrongTotal++;
      if (wrongTotal >= LIMITS.wrongTotal) {
        current = null;
        return 'shut';
      }
      if (wrongInRow >= LIMITS.wrongInRow) {
        current = null;
        return 'voided';
      }
      return 'wrong';
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

const CSS = `body{font:14px/1.45 system-ui,"Microsoft YaHei",sans-serif;margin:16px;color:#1d1d1f;background:#fafafa}
h1{font-size:18px;margin:0 0 4px}p.sub{color:#666;margin:0 0 12px}a{color:#0b57d0}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e5e5e5;padding:4px 6px;text-align:left;vertical-align:top}
th{font-weight:600;color:#444;background:#f2f2f2}td.t{white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,Consolas,monospace}
td.n{white-space:nowrap;color:#555;font-size:12px}.test{background:#b00020;color:#fff;padding:2px 8px;font-weight:700;display:inline-block;margin-bottom:8px}
.note{background:#fff4e5;border:1px solid #f0c36d;padding:6px 8px;margin:8px 0}
@media (prefers-color-scheme:dark){body{background:#151515;color:#e6e6e6}table{background:#1e1e1e}th{background:#262626;color:#ccc}td,th{border-color:#333}a{color:#8ab4f8}.note{background:#3a2c12;border-color:#7a5b1d}p.sub,td.n{color:#aaa}}
`;

const NOTES: Readonly<Record<NonNullable<PeekView['note']>, string>> = frozen({
  'tail-only': `只读了文件末尾 ${PEEK_LIMITS.claudeTailBytes / 1024} KiB，更早的事件没显示（Codex 会话另读了开头第一行）。`,
  'too-large': `文件太大（DSH 超过 ${PEEK_LIMITS.dshMaxBytes / 1024 / 1024} MiB；Codex 压缩包超过 ${PEEK_LIMITS.codexMaxBytes / 1024 / 1024} MiB 或解开后超过上限），这一版不读全：Codex 只读开头第一行。`,
  'bad-frame': '遇到一个解不开的帧，停在了那里；之前的事件照常显示。',
  'unfinished-frame': '文件末尾有一帧还没写完（DSH 可能正在写），下次刷新再看。',
});

function page(title: string, profile: 'real' | 'test', body: string): string {
  const banner = profile === 'test' ? '<div class="test">TEST PROFILE</div>\n' : '';
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(profile === 'test' ? `[测试] ${title}` : title)}</title><link rel="stylesheet" href="/style.css"></head>
<body>${banner}${body}</body></html>\n`;
}

const kib = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);
const two = (n: number) => String(n).padStart(2, '0');
/**
 * A time as this machine's local wall time, YYYY-MM-DD hh:mm:ss: the page beside it shows the same
 * events in local time (ui/clock.js fmtIso), and the page and orchestrad run on one machine, so one
 * event reads the same in both places. A conversion of a time the source wrote, never a clock read.
 */
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

function eventRow(e: PeekEvent): string {
  const ms = e.at === null ? NaN : Date.parse(e.at);
  return `<tr><td class="n">${Number.isFinite(ms) ? escapeHtml(local(ms)) : ''}</td><td class="n">${escapeHtml(e.type)}</td><td class="t">${escapeHtml(e.text)}</td></tr>`;
}

function sessionPage(profile: 'real' | 'test', v: PeekView): string {
  const s = v.session;
  const note = v.note === null ? '' : `<p class="note">${escapeHtml(NOTES[v.note])}</p>`;
  const unparsed = v.unparsed > 0 ? `<p class="sub">${v.unparsed} 行不是 JSON 对象，没显示。</p>` : '';
  return page(`Orchestra · ${s.project}`, profile, `<p><a href="/">← 回到首页</a></p><h1>${escapeHtml(s.project)}</h1>
<p class="sub">${s.harness} · ${kib(s.size)} · 修改于 ${local(s.mtimeMs)}（本机时间） · 最后 ${v.events.length} 条事件（上限 ${PEEK_LIMITS.events}）</p>${note}${unparsed}
<table><thead><tr><th>时间（本机）</th><th>类型</th><th>内容</th></tr></thead><tbody>${v.events.map(eventRow).join('\n')}</tbody></table>`);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: readonly (readonly [string, string])[] = []): void {
  res.statusCode = status;
  for (const [k, v] of BASE_HEADERS) res.setHeader(k, v);
  for (const [k, v] of extra) res.setHeader(k, v);
  res.setHeader('Content-Type', type);
  res.end(body);
}

const html = (res: ServerResponse, status: number, body: string, extra: [string, string][] = []) => send(res, status, 'text/html; charset=utf-8', body, extra);
const plain = (res: ServerResponse, status: number, body: string, extra: readonly (readonly [string, string])[] = []) => send(res, status, 'text/plain; charset=utf-8', `${body}\n`, extra);
// Tower JSON holds session text like every page: never cached (BASE_HEADERS' no-store).
const json = (res: ServerResponse, status: number, body: unknown, extra: readonly (readonly [string, string])[] = []) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), [...UI_HEADERS, ...extra]);
/** A refusal with its code (shared/protocol.js ERROR_STATUS), and for pairing which outcome it was. */
const refuse = (res: ServerResponse, code: ErrorCode, why?: string) => json(res, ERROR_STATUS[code], why === undefined ? { error: code } : { error: code, why });

function cookieOf(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === PAIR_COOKIE) return v.join('=');
  }
  return null;
}

/** The request body, up to `max` bytes; null past it. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startPeekServer(opts: PeekServerOptions): Promise<PeekServer> {
  const { gate, roots, redact, clock, log, profile } = opts;
  const pairing = makePairing(opts.pairingCode, clock.nowMono());
  const pairings = opts.pairings ?? makePairings({ nowWall: () => clock.nowWall(), io: null, log });
  const printPairCode = opts.printPairCode ?? null;
  const stage = makeStageBuilder({ gate, roots, redact, clock, profile });
  const tower = makeTowerBuilder(stage, opts.ownedSeats ?? null);
  // The embedded files, decoded once; looked up by exact name, nothing else reaches them.
  const assets = new Map<string, { type: string; etag: string; body: Buffer }>();
  const given = opts.assets ?? UI_ASSETS;
  for (const name of Object.keys(given)) assets.set(name, { type: given[name]!.type, etag: given[name]!.etag, body: Buffer.from(given[name]!.hex, 'hex') });
  let host = '';
  let origin = '';
  const owned = opts.owned === undefined ? null : makeOwnedApi({ ...opts.owned, pairings, log, origin: () => origin, readBody });
  const answer = (res: ServerResponse, a: OwnedAnswer): void => {
    const extra = a.headers ?? [];
    if (a.json !== undefined) return json(res, a.status, a.json, extra);
    if (a.text !== undefined) return plain(res, a.status, a.text, [...UI_HEADERS, ...extra]);
    return send(res, a.status, 'text/plain; charset=utf-8', '', [...UI_HEADERS, ...extra]);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.host !== host) return plain(res, 403, 'wrong host');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return plain(res, 403, 'cross-site request');
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && url.pathname === '/style.css') return send(res, 200, 'text/css; charset=utf-8', CSS);
    if (url.pathname.startsWith('/assets/')) {
      if (req.method !== 'GET') return plain(res, 405, 'method not allowed');
      const name = url.pathname.slice('/assets/'.length);
      const asset = ASSET_PATH.test(name) ? assets.get(name) : undefined;
      if (asset === undefined) return plain(res, 404, 'not found', UI_HEADERS);
      // Revalidated on every load (no-cache), so a new build shows at once; the ETag spares the bytes.
      const headers: [string, string][] = [...UI_HEADERS, ['Cache-Control', 'no-cache'], ['ETag', asset.etag]];
      if (req.headers['if-none-match'] === asset.etag) return send(res, 304, asset.type, '', headers);
      return send(res, 200, asset.type, asset.body, headers);
    }

    const sid = cookieOf(req);
    const paired = sid !== null && pairings.has(sid);

    // Pairing: a POST of the page's own origin, with no cookie needed. The code goes to the console only.
    if (url.pathname === '/api/pair-code' || url.pathname === '/api/pair') {
      if (req.method !== 'POST') return plain(res, 405, 'method not allowed', UI_HEADERS);
      if (req.headers.origin !== origin) return plain(res, 403, 'wrong origin', UI_HEADERS);
      if (site !== 'same-origin') return plain(res, 403, 'cross-site request', UI_HEADERS);
      if (url.pathname === '/api/pair-code') {
        if ((req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined) return plain(res, 400, 'bad request', UI_HEADERS);
        if (printPairCode === null) return plain(res, 503, 'pairing is off: the console is not interactive', UI_HEADERS);
        const code = pairing.issue(clock.nowMono());
        log.info('pair-code', { issued: code !== null });
        if (code === null) return refuse(res, 'not-unlocked', 'shut');
        // Straight to the console, never through the log or a reply.
        printPairCode(code);
        return send(res, 204, 'text/plain; charset=utf-8', '', UI_HEADERS);
      }
      if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return plain(res, 400, 'bad request', UI_HEADERS);
      const declared = Number(req.headers['content-length']);
      const raw = Number.isFinite(declared) && declared > PAIR_BODY_MAX_BYTES ? null : await readBody(req, PAIR_BODY_MAX_BYTES);
      if (raw === null) return refuse(res, 'body-too-big');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return plain(res, 400, 'bad request', UI_HEADERS);
      }
      if (shapeError(PAIR_ROUTE.body!, body) !== null) return plain(res, 400, 'bad request', UI_HEADERS);
      const outcome = pairing.attempt((body as { code: string }).code, clock.nowMono());
      log.info('peek-pair', { outcome });
      if (outcome !== 'ok') return refuse(res, 'not-unlocked', outcome);
      // A browser that pairs again leaves its old pairing behind: it goes.
      if (paired) pairings.forget(sid);
      const fresh = pairings.pair();
      log.info('pairings', { remembered: pairings.count });
      return json(res, 200, { csrf: fresh.csrf }, [['Set-Cookie', pairCookie(fresh.sid)]]);
    }

    if (owned !== null) {
      const a = await owned.handle(req, url, paired ? sid : null);
      if (a !== null) return answer(res, a);
    }
    if (req.method !== 'GET') return plain(res, 405, 'method not allowed');
    // The old stage and tower pages are gone; a bookmark of either lands on the home page.
    if (url.pathname === '/stage' || url.pathname === '/tower') {
      res.setHeader('Location', '/');
      return plain(res, 301, 'moved to /');
    }
    // The page, paired or not: unpaired it shows its pairing dialog, and its reads below answer 403.
    if (url.pathname === '/') {
      const page = assets.get('ui/home.html');
      if (page === undefined) return plain(res, 503, 'ui-not-embedded', UI_HEADERS);
      return send(res, 200, page.type, page.body, UI_HEADERS);
    }
    if (!paired) {
      if (url.pathname === '/session') {
        res.setHeader('Location', '/');
        return plain(res, 303, 'not paired: pair on /');
      }
      return plain(res, 403, 'not paired');
    }
    try {
      if (url.pathname === '/session') {
        const s = findSession(gate, roots, redact, url.searchParams.get('id') ?? '');
        if (s === null) return plain(res, 404, 'no such session');
        return html(res, 200, sessionPage(profile, readSession(gate, s, redact)));
      }
      if (url.pathname === '/api/peek/stage') return json(res, 200, stage.snapshot());
      if (url.pathname === '/api/tower') {
        const t = tower.snapshot();
        const v = validateTower(t);
        if (v.ok) return json(res, 200, t);
        log.warn('tower-misshapen', { errors: v.errors.slice(0, 8) });
        return plain(res, 500, 'tower misshapen');
      }
      if (url.pathname === '/api/peek/session') {
        const id = url.searchParams.get('id') ?? '';
        if (!HEX20.test(id)) return json(res, 400, { error: 'bad-id' });
        const detail = stage.session(id);
        if (detail === null) return json(res, 404, { error: 'not-found' });
        return json(res, 200, detail);
      }
    } catch (e) {
      log.warn('peek-read-failed', { error: e });
      return plain(res, 500, 'read failed');
    }
    return plain(res, 404, 'not found');
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      log.warn('peek-request-failed', { error: e });
      if (!res.headersSent) plain(res, 500, 'failed');
      else res.destroy();
    });
  };
  const v4 = createServer(onRequest);
  const v6 = createServer(onRequest);
  await listen(v4, opts.port, '127.0.0.1');
  const address = v4.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  let both = true;
  try {
    await listen(v6, port, '::1');
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
      await closeServer(v4);
      throw e;
    }
    // No IPv6 loopback on this machine: nobody else can hold ::1 either.
    both = false;
  }
  host = `${PEEK_HOST}:${port}`;
  origin = `http://${host}`;
  log.info('peek-listening', { port, ipv6: both });
  return {
    port,
    url: `${origin}/`,
    tower: () => tower.snapshot(),
    close: async () => {
      await Promise.all([closeServer(v4), both ? closeServer(v6) : Promise.resolve()]);
    },
  };
}
