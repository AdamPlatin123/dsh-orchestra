import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { HarnessRoot } from '../fs/harness-roots.ts';
import type { ReadGate } from '../fs/read-gate.ts';
import type { Clock } from '../runtime/clock.ts';
import type { Log } from '../runtime/log.ts';
import type { PeekEvent, PeekSession, PeekView, Redact } from '../sources/peek.ts';
import { PEEK_LIMITS, findSession, listSessions, readSession } from '../sources/peek.ts';
import { makeStageBuilder } from '../sources/stage.ts';
import type { UiAsset } from './ui-assets.ts';
import { UI_ASSETS } from './ui-assets.ts';
import { frozen } from '../../shared/frozen.js';

// The peek server: the thin slice ahead of plan steps 4-5. It shows the sessions under the harness
// roots and the last events of one, and nothing else: GET pages plus the one POST that pairs.
//
// Taken from step 4 as it stands there: loopback only (127.0.0.1 and ::1 on the same port; a port
// someone else holds on ::1 refuses the start, since the browser may try ::1 first and would hand that
// holder the cookie); Host exactly orchestra.localhost:<port>; an 8-digit one-time pairing code from
// the console, 10 minutes, compared in constant time, void after 5 wrong tries in a row, pairing shut
// after 20; a host-only cookie (HttpOnly, SameSite=Strict, Path=/) whose session lives in memory;
// Origin exact on the POST; Sec-Fetch-Site, when sent, only same-origin or none; no CORS header.
//
// Not as step 4 has it, for this slice only: the pages are rendered here as HTML with every source
// string escaped, and carry no script at all, so the CSP is stricter than r4:595 (script-src 'none'
// through default-src). Without a script the pairing form posts form-encoded, not JSON; there is no
// CSRF token because nothing but pairing changes state. Step 4 replaces this module's routes with the
// route table of server/routes.ts and step 5 replaces the pages.
//
// The stage preview (0.1 alpha design §4; a labelled M2 preview, r4:2051) is the one place with a
// script: GET /stage serves the embedded ui/stage.html, /assets/ui/* and /assets/shared/* serve the
// embedded modules and styles it loads (src/server/ui-assets.ts, by map lookup only, no cookie: they
// hold no session data), and /api/peek/stage and /api/peek/session answer its polls with JSON. Those
// routes carry STAGE_CSP: script and connections to self only, trusted types on with no policy, so the
// page writes the DOM through textContent and attributes alone. Every other route keeps the scriptless CSP.

export const PEEK_HOST = 'orchestra.localhost';
export const PAIR_TTL_MS = 10 * 60 * 1000;

const LIMITS = frozen({ wrongInRow: 5, wrongTotal: 20, sessions: 16, pairBodyBytes: 1024 });
const COOKIE = 'orchestra_sid';
const CSP = "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'";
/** The stage routes' CSP: stricter than r4:595 (nothing inline, trusted types with no policy). */
export const STAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const STAGE_HEADERS: readonly [string, string][] = frozen([['Content-Security-Policy', STAGE_CSP]]);
const ASSET_PATH = /^(?:ui|shared)\/[a-z0-9][a-z0-9-]*\.(?:js|css)$/;
const HEX20 = /^[0-9a-f]{20}$/;
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
  /** The code printed on the console, or null when pairing is off. */
  pairingCode: string | null;
  profile: 'real' | 'test';
  /** The embedded page files: UI_ASSETS unless a test hands its own. */
  assets?: Readonly<Record<string, UiAsset>>;
};

export type PeekServer = { port: number; url: string; close(): Promise<void> };

export type PairOutcome = 'ok' | 'wrong' | 'voided' | 'shut' | 'expired' | 'no-code';

/** The pairing rules of plan step 4 over one console code; the time is the Clock's monotonic one. */
export function makePairing(code: string | null, issuedMono: number) {
  let current = code;
  let wrongInRow = 0;
  let wrongTotal = 0;
  return {
    get open(): boolean {
      return current !== null && wrongTotal < LIMITS.wrongTotal;
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
      if (/^[0-9]{8}$/.test(given) && a.length === b.length && timingSafeEqual(a, b)) {
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
.note{background:#fff4e5;border:1px solid #f0c36d;padding:6px 8px;margin:8px 0}form{margin:12px 0}input{font-size:16px;width:10em}
@media (prefers-color-scheme:dark){body{background:#151515;color:#e6e6e6}table{background:#1e1e1e}th{background:#262626;color:#ccc}td,th{border-color:#333}a{color:#8ab4f8}.note{background:#3a2c12;border-color:#7a5b1d}p.sub,td.n{color:#aaa}}
`;

const NOTES: Readonly<Record<NonNullable<PeekView['note']>, string>> = frozen({
  'tail-only': `只读了文件末尾 ${PEEK_LIMITS.claudeTailBytes / 1024} KiB，更早的事件没显示。`,
  'too-large': `文件超过 ${PEEK_LIMITS.dshMaxBytes / 1024 / 1024} MiB，这一版不读。`,
  'bad-frame': '遇到一个解不开的帧，停在了那里；之前的事件照常显示。',
  'unfinished-frame': '文件末尾有一帧还没写完（DSH 可能正在写），下次刷新再看。',
});

function page(title: string, profile: 'real' | 'test', body: string): string {
  const banner = profile === 'test' ? '<div class="test">TEST PROFILE</div>\n' : '';
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(profile === 'test' ? `[测试] ${title}` : title)}</title><link rel="stylesheet" href="/style.css"></head>
<body>${banner}${body}</body></html>\n`;
}

function pairPage(profile: 'real' | 'test', message: string | null, open: boolean): string {
  const msg = message === null ? '' : `<p class="note">${escapeHtml(message)}</p>`;
  const form = open
    ? `<form method="post" action="/pair"><label>配对码 <input type="text" inputmode="numeric" autocomplete="off" pattern="[0-9]{8}" maxlength="8" required autofocus id="code" name="code"></label> <button type="submit">配对</button></form>`
    : '<p>配对已关闭。重启 orchestrad 会在控制台打印新的配对码。</p>';
  return page('Orchestra · 配对', profile, `<h1>Orchestra peek</h1><p class="sub">输入启动 orchestrad 的控制台里打印的 8 位配对码。</p>${msg}${form}`);
}

const kib = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);
const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function listPage(profile: 'real' | 'test', list: { sessions: PeekSession[]; total: number }): string {
  const rows = list.sessions.map((s) => `<tr><td class="n">${s.harness}</td><td><a href="/session?id=${s.id}">${escapeHtml(s.project)}</a></td><td class="n">${iso(s.mtimeMs)} UTC</td><td class="n">${kib(s.size)}</td></tr>`).join('\n');
  const more = list.total > list.sessions.length ? `<p class="sub">共 ${list.total} 个，只列最新的 ${list.sessions.length} 个。</p>` : '';
  const empty = list.total === 0 ? '<p class="note">没在 harness 根下找到 Claude 或 DSH 会话文件。</p>' : '';
  return page('Orchestra · 会话', profile, `<h1>会话（只读）</h1><p class="sub">最薄通路：按修改时间排，刷新页面重读。正文经过脱敏，不落盘。</p>${empty}${more}
<p><a href="/stage">Stage 预览（M2，只读）</a></p>
<table><thead><tr><th>harness</th><th>项目目录</th><th>修改时间</th><th>大小</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function eventRow(e: PeekEvent): string {
  return `<tr><td class="n">${e.at === null ? '' : escapeHtml(e.at.replace('T', ' ').slice(0, 23))}</td><td class="n">${escapeHtml(e.type)}</td><td class="t">${escapeHtml(e.text)}</td></tr>`;
}

function sessionPage(profile: 'real' | 'test', v: PeekView): string {
  const s = v.session;
  const note = v.note === null ? '' : `<p class="note">${escapeHtml(NOTES[v.note])}</p>`;
  const unparsed = v.unparsed > 0 ? `<p class="sub">${v.unparsed} 行不是 JSON 对象，没显示。</p>` : '';
  return page(`Orchestra · ${s.project}`, profile, `<p><a href="/">← 会话列表</a></p><h1>${escapeHtml(s.project)}</h1>
<p class="sub">${s.harness} · ${kib(s.size)} · 修改于 ${iso(s.mtimeMs)} UTC · 最后 ${v.events.length} 条事件（上限 ${PEEK_LIMITS.events}）</p>${note}${unparsed}
<table><thead><tr><th>时间（UTC）</th><th>类型</th><th>内容</th></tr></thead><tbody>${v.events.map(eventRow).join('\n')}</tbody></table>`);
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
// Stage JSON holds session text like every page: never cached (BASE_HEADERS' no-store).
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), STAGE_HEADERS);

function cookieOf(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
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
  const sessions = new Set<string>();
  const stage = makeStageBuilder({ gate, roots, redact, clock, profile });
  // The embedded files, decoded once; looked up by exact name, nothing else reaches them.
  const assets = new Map<string, { type: string; etag: string; body: Buffer }>();
  const given = opts.assets ?? UI_ASSETS;
  for (const name of Object.keys(given)) assets.set(name, { type: given[name]!.type, etag: given[name]!.etag, body: Buffer.from(given[name]!.hex, 'hex') });
  let host = '';
  let origin = '';

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
      if (asset === undefined) return plain(res, 404, 'not found', STAGE_HEADERS);
      // Revalidated on every load (no-cache), so a new build shows at once; the ETag spares the bytes.
      const headers: [string, string][] = [...STAGE_HEADERS, ['Cache-Control', 'no-cache'], ['ETag', asset.etag]];
      if (req.headers['if-none-match'] === asset.etag) return send(res, 304, asset.type, '', headers);
      return send(res, 200, asset.type, asset.body, headers);
    }

    if (url.pathname === '/pair') {
      if (req.method !== 'POST') return plain(res, 405, 'method not allowed');
      if (req.headers.origin !== origin) return plain(res, 403, 'wrong origin');
      if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return plain(res, 400, 'bad request');
      const body = await readBody(req, LIMITS.pairBodyBytes);
      if (body === null) return plain(res, 400, 'bad request');
      const outcome = pairing.attempt(new URLSearchParams(body).get('code') ?? '', clock.nowMono());
      log.info('peek-pair', { outcome });
      if (outcome === 'ok') {
        const sid = randomBytes(32).toString('base64url');
        if (sessions.size >= LIMITS.sessions) sessions.delete(sessions.values().next().value!);
        sessions.add(sid);
        res.setHeader('Location', '/');
        return html(res, 303, '', [['Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`]]);
      }
      const why: Record<Exclude<PairOutcome, 'ok'>, string> = {
        wrong: '配对码不对。',
        voided: '连错 5 次，这个配对码作废了。',
        shut: '累计错 20 次，配对已关闭。',
        expired: '配对码已过期（10 分钟）。',
        'no-code': '没有可用的配对码（已用过，或控制台不是交互式的）。',
      };
      return html(res, 403, pairPage(profile, why[outcome], pairing.open));
    }

    const sid = cookieOf(req);
    const paired = sid !== null && sessions.has(sid);
    if (req.method !== 'GET') return plain(res, 405, 'method not allowed');
    if (!paired) {
      if (url.pathname === '/') return html(res, 200, pairPage(profile, null, pairing.open));
      return plain(res, 403, 'not paired');
    }
    try {
      if (url.pathname === '/') return html(res, 200, listPage(profile, listSessions(gate, roots, redact)));
      if (url.pathname === '/session') {
        const s = findSession(gate, roots, redact, url.searchParams.get('id') ?? '');
        if (s === null) return plain(res, 404, 'no such session');
        return html(res, 200, sessionPage(profile, readSession(gate, s, redact)));
      }
      if (url.pathname === '/stage') {
        const page = assets.get('ui/stage.html');
        if (page === undefined) return plain(res, 503, 'ui-not-embedded', STAGE_HEADERS);
        return send(res, 200, page.type, page.body, STAGE_HEADERS);
      }
      if (url.pathname === '/api/peek/stage') return json(res, 200, stage.snapshot());
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
    close: async () => {
      await Promise.all([closeServer(v4), both ? closeServer(v6) : Promise.resolve()]);
    },
  };
}
