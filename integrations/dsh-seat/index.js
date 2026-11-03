// @local/orchestra-seat: Orchestra as a governed Codex / Claude subagent backend for DSH 0.2.1-rc.2
// (seat, step 2; scratchpad final.md §3 and §5.2, step 0 findings in seat-lab/api-check.md).
//
// What it does, and all it does:
//   - registers two out-of-process subagent providers, orchestra-codex and orchestra-claude, on
//     ctx.subagents (effect-scoped: they go when this plugin unloads). The two dsh-tool-subagent rows of
//     cordis.patch.yml turn them into the model tools subagent_codex_governed / subagent_claude_governed.
//   - start() never starts a process. It ASKS orchestrad for one run over orchestrad's agent request port
//     (a named pipe with three routes: submit, poll, withdraw; src/server/agent-port.ts) and waits. A
//     person decides on the paired Orchestra page; nobody deciding in time is a refusal (r4 D8: one
//     approval queue, timeout = deny; dispatch / approve / brake only by a human on the paired page, the
//     agent side physically has no such routes; r4 A17: an agent may only request a new musician).
//   - registers one ctx.tools.guard that refuses plugin_manager, so a session in this host cannot load
//     code into it (everything this bundle can reach, the agent could then reach).
//
// What it never does: answer, register for or observe any DSH approval (no approval/request listener);
// call any route but the three; hold the token past one HTTP request (the token file is read fresh for
// every request, since orchestrad writes a new one at each start); declare work done (r4 D19). A
// `completed` here only says the dispatched session's first turn came back (A16's thin completion: the
// last agent message, at most 8 KiB, marked when cut; never the transcript).
//
// Result mapping (SubagentResult.stopReason; the result promise never rejects after start resolved):
//   done                              -> completed, output = provenance line + the last agent message
//   rejected / expired / seat timeout -> refusal, diagnostic says a person did not dispatch it
//   failed / unknown id / port errors -> error, diagnostic names the orchestrad code (never source text)
//   request.signal aborted            -> withdraw (once) + aborted; orchestrad ends a dispatched session
//                                        through the normal owned-end stop order, never the brake
// dispose() is also called after a normal end (dsh-subagent finishDisposal): it withdraws only while the
// request is not known to be over, at most once, and never throws.
//
// Zero dependencies: only node builtins. The three dsh-subagent helpers (NO_START_CAPABILITIES,
// settleRunResult, subprocessRunHandle) are restated locally in the small form this provider needs.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export const name = 'orchestra-seat';
export const inject = ['subagents', 'tools'];

/** Every agent pipe orchestrad opens starts so (src/server/agent-port.ts PIPE_PREFIX). */
export const PIPE_PREFIX = '\\\\.\\pipe\\orchestra-agent-';

export const SEAT_LIMITS = Object.freeze({
  /** The default time a request may stay undispatched before the seat gives up (orchestrad's own TTL is 10 min). */
  requestTimeoutMs: 10 * 60 * 1000,
  /** The shortest seat timeout config may set (a smoke uses 60 s). */
  minTimeoutMs: 5_000,
  /** orchestrad answers a long poll after at most 25 s. */
  waitS: 25,
  submitMs: 15_000,
  withdrawMs: 5_000,
  /** Consecutive failed polls before the run settles as error. */
  pollFailures: 3,
  retryMs: 1_000,
  /** SubagentResult.diagnostic: at most 4096 UTF-8 bytes. */
  diagnosticBytes: 4096,
  /** orchestrad's own caps (src/route/requests.ts REQUEST_LIMITS, agent-port.ts AGENT_REQUEST_BODY). */
  textBytes: 2048,
  labelChars: 100,
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_RE = /^[0-9a-f]{20}$/;
/** orchestrad's REQUESTER_ID_RE. */
const REQUESTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OVER = new Set(['done', 'rejected', 'expired', 'withdrawn', 'failed']);

/** dsh-subagent's NO_START_CAPABILITIES: an out-of-process child honors no parent-enforced start feature. */
export const NO_START_CAPABILITIES = Object.freeze({ agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false });

/** A string cut to `max` UTF-8 bytes on a character boundary. */
export function headUtf8(text, max) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= max) return String(text);
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** The diagnostic as the seam allows it: at most 4096 UTF-8 bytes. */
export const limitDiagnostic = (text) => headUtf8(text, SEAT_LIMITS.diagnosticBytes);

const errorCode = (e) => (e && typeof e === 'object' && typeof e.code === 'string' ? e.code : e instanceof Error ? e.name : 'unknown');

/** The task text of a prompt: its text blocks, joined. */
export function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
}

/** The requester id the card shows: the parent's session id (Agent.id, the only public field), held to orchestrad's id shape. */
export function requesterId(parent) {
  const raw = parent && typeof parent.id === 'string' ? parent.id : '';
  if (REQUESTER_ID_RE.test(raw)) return raw;
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
  return cleaned === '' ? 'unknown' : cleaned;
}

/** Checks the plugin config; the reason it is unusable, or null. */
export function configProblem(config) {
  if (config === null || typeof config !== 'object') return 'no config';
  if (typeof config.pipe !== 'string' || !config.pipe.startsWith(PIPE_PREFIX) || config.pipe.length <= PIPE_PREFIX.length) return `pipe must start with ${PIPE_PREFIX}`;
  if (typeof config.tokenFile !== 'string' || config.tokenFile === '' || !path.isAbsolute(config.tokenFile)) return 'tokenFile must be an absolute path (orchestrad writes <ORCHESTRA_HOME>\\agent-port.token)';
  if (config.requestTimeoutMs !== undefined && (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < SEAT_LIMITS.minTimeoutMs)) return `requestTimeoutMs must be an integer >= ${SEAT_LIMITS.minTimeoutMs}`;
  return null;
}

/**
 * The agent port as one HTTP call over the named pipe: node:http with socketPath, the token read fresh from
 * the token file for this request only, `Authorization: Bearer <token>`. Resolves {status, json}; rejects
 * on a transport fault (with a code: ENOENT when no orchestrad listens, token-missing, token-bad, timeout,
 * AbortError). The token never leaves this function: not logged, not in an error.
 */
export function makePipePort({ pipe, tokenFile }) {
  const readToken = () => {
    let text;
    try {
      text = fs.readFileSync(tokenFile, 'utf8');
    } catch (e) {
      throw Object.assign(new Error('orchestra-seat: no token file (orchestrad not running with --agent-port?)'), { code: 'token-missing', cause: errorCode(e) });
    }
    const token = text.trim();
    if (!TOKEN_RE.test(token)) throw Object.assign(new Error('orchestra-seat: the token file does not hold a token'), { code: 'token-bad' });
    return token;
  };
  return Object.freeze({
    pipe,
    call(method, pathname, body, { signal, timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        let token;
        try {
          token = readToken();
        } catch (e) {
          return reject(e);
        }
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
        if (payload !== null) Object.assign(headers, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
        else headers['content-length'] = '0';
        token = null;
        const req = http.request({ socketPath: pipe, method, path: pathname, headers, agent: false, ...(signal ? { signal } : {}) }, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= 64 * 1024) chunks.push(c);
          });
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
          res.on('error', reject);
        });
        if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('orchestra-seat: the agent port did not answer in time'), { code: 'timeout' })));
        req.on('error', (e) => reject(e));
        req.end(payload ?? undefined);
      });
    },
  });
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() {
    clearTimeout(t);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

const HARNESS_NAME = Object.freeze({ codex: 'Codex', claude: 'Claude Code' });

/** The diagnostic of each refusal and error (Chinese first, the orchestrad code in brackets). */
export const DIAG = Object.freeze({
  rejected: '没有派出：人在 Orchestra 配对页上点了「拒绝」。DSH 这边无法让它通过（r4 D8：派出只能由人在配对页上做）。[rejected]',
  expired: '没有派出：请求在 orchestrad 的时限内没有人在 Orchestra 配对页上点「派出」，超时即拒（r4 D8）。[expired]',
  seatTimeout: (s) => `没有派出：${s} 秒内没有人在 Orchestra 配对页上点「派出」，seat 已撤回请求，超时即拒（r4 D8）。[seat-timeout]`,
  withdrawnElsewhere: '请求被撤回了，但不是这次委派撤回的；如果已派出，会话按正常结束顺序收尾。[withdrawn]',
  aborted: '委派被取消；seat 已向 orchestrad 撤回请求。已派出的会话按正常结束顺序收尾，不是刹车。[aborted]',
  failed: (why) => `orchestrad 报告这次运行失败：${why}。[failed]`,
  unknown: 'orchestrad 不认识这条请求了（请求只存在 orchestrad 内存里，它可能重启过）。[request-unknown]',
  token: 'orchestrad 不认这次的令牌（它可能重启过，令牌每次启动都换）。[not-authorized]',
  status: (st, code) => `orchestrad 请求口回了 HTTP ${st}${code ? ` ${code}` : ''}。[port-status]`,
  unreachable: (code) => `连不上 orchestrad 请求口（${code}）。[unreachable]`,
});

/** Why orchestrad would not take a request (POST /agent/v1/requests), by its code; start() rejects with it. */
export const SUBMIT_REFUSED = Object.freeze({
  'cwd-forbidden': 'orchestrad 不收这个工作目录：它在受保护的位置（例如 %USERPROFILE%\\AppData 下、orchestra 仓库里、系统目录）。请在普通项目目录里运行 DSH，或给委派传一个这样的 cwd。',
  'text-too-long': 'orchestrad 不收：任务文字超过 2048 字节。',
  'slash-command': 'orchestrad 不收以 / 开头的任务文字。',
  rate: 'orchestrad 不收：一分钟内的请求太多了（限速 6 条），稍后再试。',
  full: 'orchestrad 不收：等你处理的请求已满（最多 16 条）。',
  stopped: 'orchestrad 正在停机，不收新请求。',
});

const codeOf = (json) => (json && typeof json.error === 'string' && /^[a-z0-9-]{1,40}$/.test(json.error) ? json.error : null);
const safeWhy = (why) => (typeof why === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(why) ? why : '未知');

/**
 * One governed provider. `port` is makePipePort's shape ({call}); `now` and `sleep` are injectable for
 * tests. Each start() owns its own state (concurrent children never share a request).
 */
export function makeSeatProvider({ providerName, harness, port, requestTimeoutMs = SEAT_LIMITS.requestTimeoutMs, now = () => Date.now(), wait = sleep, logger = null }) {
  if (harness !== 'codex' && harness !== 'claude') throw new TypeError(`orchestra-seat: unknown harness ${harness}`);
  const log = (level, msg) => {
    try {
      logger?.[level]?.(msg);
    } catch {
      // The log's trouble is not the run's.
    }
  };

  async function start(request) {
    const signal = request.signal;
    signal?.throwIfAborted?.();
    const text = promptText(request.prompt);
    if (text.trim() === '') throw new Error('orchestra-seat: the delegation has no task text');
    if (Buffer.byteLength(text, 'utf8') > SEAT_LIMITS.textBytes) throw new Error(`orchestra-seat: the task text is over ${SEAT_LIMITS.textBytes} UTF-8 bytes (orchestrad's owned message cap); shorten it`);
    const label = typeof request.label === 'string' && request.label.trim() !== '' ? request.label.split('\n', 1)[0].slice(0, SEAT_LIMITS.labelChars) : null;
    const body = { harness, text, cwd: String(request.cwd ?? ''), ...(label === null ? {} : { label }), requester: { kind: 'dsh', sessionId: requesterId(request.parent) } };

    // Submit. Failing here rejects start(): nothing was published, so nothing needs undoing (an abort that
    // lands after orchestrad made the card leaves one pending card, which expires on its own: timeout = deny).
    let sub;
    try {
      sub = await port.call('POST', '/agent/v1/requests', body, { signal, timeoutMs: SEAT_LIMITS.submitMs });
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      throw new Error(`orchestra-seat: ${DIAG.unreachable(errorCode(e))}`);
    }
    if (sub.status === 401) throw new Error(`orchestra-seat: ${DIAG.token}`);
    if (sub.status !== 200 || !REQUEST_ID_RE.test(String(sub.json?.requestId ?? ''))) {
      const code = codeOf(sub.json);
      const known = code !== null && Object.hasOwn(SUBMIT_REFUSED, code) ? `${SUBMIT_REFUSED[code]} ` : '';
      throw new Error(`orchestra-seat: ${known}${DIAG.status(sub.status, code)}`);
    }
    const requestId = sub.json.requestId;
    log('info', `orchestra-seat: request ${requestId} (${harness}) waits for a person on the paired page`);

    const polls = new AbortController();
    let over = false;
    let disposed = false;
    let withdrawal = null;
    const withdrawOnce = () => (withdrawal ??= (async () => {
      try {
        const r = await port.call('POST', `/agent/v1/requests/${requestId}/withdraw`, undefined, { timeoutMs: SEAT_LIMITS.withdrawMs });
        if (r.status === 200 && r.json && OVER.has(r.json.state)) over = true;
        log('info', `orchestra-seat: request ${requestId} withdrawn (${r.status} ${r.json?.state ?? ''})`);
        return r.status === 200 ? r.json : null;
      } catch (e) {
        log('warn', `orchestra-seat: withdraw of ${requestId} failed (${errorCode(e)}); orchestrad expires it on its own`);
        return null;
      }
    })());
    const onAbort = () => polls.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const deadline = now() + requestTimeoutMs;
    const aborted = () => ({ output: [], stopReason: 'aborted', diagnostic: DIAG.aborted });
    const refusal = (d) => ({ output: [], stopReason: 'refusal', diagnostic: limitDiagnostic(d) });
    const error = (d) => ({ output: [], stopReason: 'error', diagnostic: limitDiagnostic(d) });
    const completed = (s) => {
      const head = `[Orchestra：人在配对页派出的自有 ${HARNESS_NAME[harness]} 会话 ${typeof s.ownedId === 'string' ? s.ownedId : '未知'}，这一回合的最后一条消息；未复核，不是完成判定]`;
      const out = typeof s.output === 'string' && s.output !== '' ? s.output : '（orchestrad 没有交回文字）';
      const cut = s.truncated === true ? '\n[已截断：orchestrad 最多交回 8 KiB，原文更长]' : '';
      return { output: [{ type: 'text', text: `${head}\n${out}${cut}` }], stopReason: 'completed' };
    };
    /** A state orchestrad reported, as the seam's result; null while it is still open. */
    const settle = (s, { ourTimeout = false } = {}) => {
      switch (s?.state) {
        case 'done': over = true; return completed(s);
        case 'rejected': over = true; return refusal(DIAG.rejected);
        case 'expired': over = true; return refusal(DIAG.expired);
        case 'withdrawn':
          over = true;
          if (ourTimeout) return refusal(DIAG.seatTimeout(Math.round(requestTimeoutMs / 1000)));
          return withdrawal !== null || signal?.aborted || disposed ? aborted() : { output: [], stopReason: 'aborted', diagnostic: DIAG.withdrawnElsewhere };
        case 'failed': over = true; return error(DIAG.failed(safeWhy(s.why)));
        default: return null;
      }
    };

    const result = (async () => {
      let failures = 0;
      let state = sub.json.state ?? 'pending';
      try {
        for (;;) {
          if (signal?.aborted || disposed) {
            await withdrawOnce();
            return aborted();
          }
          if (state === 'pending' && now() >= deadline) {
            const w = await withdrawOnce();
            return settle(w ?? { state: 'withdrawn' }, { ourTimeout: true }) ?? refusal(DIAG.seatTimeout(Math.round(requestTimeoutMs / 1000)));
          }
          const waitS = state === 'pending' ? Math.max(1, Math.min(SEAT_LIMITS.waitS, Math.ceil((deadline - now()) / 1000))) : SEAT_LIMITS.waitS;
          let r;
          try {
            r = await port.call('GET', `/agent/v1/requests/${requestId}?wait=${waitS}`, undefined, { signal: polls.signal, timeoutMs: (waitS + 10) * 1000 });
          } catch (e) {
            if (signal?.aborted || disposed) continue;
            if (++failures >= SEAT_LIMITS.pollFailures) return error(DIAG.unreachable(errorCode(e)));
            await wait(SEAT_LIMITS.retryMs, polls.signal);
            continue;
          }
          failures = 0;
          if (r.status === 404) return error(DIAG.unknown);
          if (r.status === 401) return error(DIAG.token);
          if (r.status !== 200 || r.json === null || typeof r.json !== 'object') return error(DIAG.status(r.status, codeOf(r.json)));
          const done = settle(r.json);
          if (done !== null) return done;
          state = r.json.state;
        }
      } catch (e) {
        // Settle as the seam asks (settleRunResult): never a rejection once the run is published.
        return signal?.aborted || disposed ? aborted() : error(`orchestra-seat: ${errorCode(e)}`);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    })();

    let disposal = null;
    return {
      id: `orchestra-${requestId}`,
      result,
      dispose() {
        return (disposal ??= (async () => {
          try {
            disposed = true;
            // After a normal end there is nothing to withdraw (dsh-subagent disposes every run).
            if (!over) {
              polls.abort();
              await withdrawOnce();
            }
            await result;
          } catch {
            // dispose() never throws.
          }
        })());
      },
    };
  }

  return Object.freeze({ name: providerName, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false, start });
}

/** The guard: plugin_manager is refused in this host, whoever calls it. */
export function pluginManagerGuard(exec) {
  if (exec && exec.name === 'plugin_manager') return 'orchestra-seat: plugin_manager is refused in this DSH host. The seat bundle reaches an Orchestra request port; loading more code here would hand that reach to whatever the code is. Install plugins from the command line instead.';
  return undefined;
}

export function apply(ctx, config) {
  const logger = ctx.logger;
  const tools = ctx.tools;
  if (typeof tools?.guard !== 'function') {
    logger?.warn?.('orchestra-seat: this host has no ctx.tools.guard; nothing registered (the seat never runs without its plugin_manager guard)');
    return;
  }
  tools.guard(pluginManagerGuard);
  const subagents = ctx.subagents;
  if (typeof subagents?.registerProvider !== 'function') {
    logger?.warn?.('orchestra-seat: this host has no ctx.subagents.registerProvider (not DSH 0.2.1?); no provider registered');
    return;
  }
  const problem = configProblem(config);
  if (problem !== null) {
    logger?.warn?.(`orchestra-seat: config unusable (${problem}); no provider registered`);
    return;
  }
  const port = makePipePort({ pipe: config.pipe, tokenFile: config.tokenFile });
  const requestTimeoutMs = config.requestTimeoutMs ?? SEAT_LIMITS.requestTimeoutMs;
  subagents.registerProvider(makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port, requestTimeoutMs, logger }));
  subagents.registerProvider(makeSeatProvider({ providerName: 'orchestra-claude', harness: 'claude', port, requestTimeoutMs, logger }));
  logger?.info?.(`orchestra-seat: providers orchestra-codex and orchestra-claude registered on ${config.pipe}; each request waits for a person on the paired Orchestra page`);
}
