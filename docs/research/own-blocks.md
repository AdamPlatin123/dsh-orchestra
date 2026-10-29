## Facts

**(1) dsh-adaptive-router** (`G:\_Projects\DSH-plugins\dsh-adaptive-router`)
- It is a JS ESM package with no dependencies, needs Node>=22, and is marked `"private": true`. Version 0.1.0. There is no LICENSE file and no `license` field (`package.json:1-12`). It has its own `.gitignore` but no `.git`; `git log` there resolves to the parent repo (inferred: not separately versioned).
- It describes itself as a prototype, "not full production P4". It has no real account-pool scheduling and no invoice reconciliation (`README.md:3`).
- Size is about 1,400 LOC (10 package `index.js` files plus `application.js`, `store.js`, `index.js`, `client.js`). There are about 106 `test(` cases across `tests/*.js` and `packages/*/tests/*.js`.
- It is not installed in any DSH profile. None of `~/.dsh/profiles/{desktop,dsh-tui,dzcf,headless,web}/package.json` references it.
- `route(task, deployments, policy, session)` works in four steps (`packages/router-core/index.js:36-103`):
  - It applies hard filters with typed rejection codes (`manual-model-mismatch`, `capability-unknown`, `quality-below-minimum`, `price-unknown`, `cost-over-budget`…).
  - Quality must clear a Wilson lower bound. Evidence is scoped by `taskClass`.
  - Survivors are sorted by cost.
  - Session affinity is applied, and the result carries a deterministic sha256 `decisionId`.
- The router has model-specific assumptions baked in:
  - The task must contain `inputTokens/outputTokens/contextTokens/modalities` (`router-core/index.js:17-34`).
  - `quota` and `health` evidence are mandatory (`:69-70`).
  - The deployment key is fixed to `[model, provider, endpoint, credentialRef, configVersion]` (`packages/contracts/index.js:19-21`).
- Evidence model (`contracts/index.js:60-72`):
  - Sources are `declared|probed|observed`; states are `supported|unsupported|unknown`.
  - Any active `unsupported` or `unknown` vetoes a positive.
  - `declared` never certifies.
  - Evidence is version-scoped and expires.
- Session affinity uses cooldown, hysteresis in bps, a switch penalty, and a minimum saving. It is pure code, 41 LOC (`packages/session-routing/index.js:18-41`). Defaults are `cooldownMs 300000, hysteresisBps 1500` (`packages/dsh-plugin/application.js:8`).
- Predictors reject model self-rating. Labels must be `human|deterministic|external`, with `verified:true` (`packages/predictors/index.js:3-15`).
- Metering `Ledger` (`packages/metering/README.md`):
  - Supports reserve, settle, release, refund, and `recordUsage`/`resolveUsage`.
  - Uses BigInt string money and idempotent IDs.
  - `FileJournal` is a hash-chained JSONL file with fsync. It is single-writer and has no cross-process locking.
- In the online path, usage is always recorded as `pending` with `costAmount: null` (`application.js:123-124`, `README.md:55`).
- Recovery (`packages/recovery/README.md`; `index.js:37-175`):
  - `classifyError` maps errors to scopes: account, endpoint, model, or request.
  - `decideRecovery` returns one of stop, retry, `failover-*`.
  - `ExecutionRegistry` refuses to replay when a side effect's outcome is unknown (`OUTCOME_UNKNOWN`).
  - None of this is wired in: the adapter sets `maxRetries: 0` (`index.js:44`, `README.md:57`).
- DSH hooks used: `inject=['llm','commands','tools']`, `ctx.llm.registerAdapter`, `ctx.on('llm/stream', …)` for shadow dry-runs, and `ctx.llm.listProviders/listModels/resolveModelInfo` (`index.js:8,61-74`; `packages/provider-bridge/index.js:6-15`).
- If the selected deployment changes in a session that has assistant history, it refuses with `SESSION_MIGRATION_REQUIRED` and says to start an isolated worker (`application.js:89-94`).

**(2) dsh-tonghuashun** (`G:\_Projects\dsh-tonghuashun`)
- MIT, © AdamPlatin123, GitHub `AdamPlatin123/dsh-tonghuashun` (`README.md:100`). Version 0.3.4, Node>=22.14. Dependencies are `diff`, `lightweight-charts` (Apache-2.0) and `lucide-react` (`package.json`).
- Source is about 1,737 LOC in `src/`. Five test files are in `tests/`.
- It is installed in the `desktop` profile as a `file:` tgz (`~/.dsh/profiles/desktop/package.json`).
- Host surface (`src/index.js:8-40`):
  - `inject=['sessions','sessionQuery','tools','webServer']`.
  - `ctx.on('tools/execute',(exec,next)=>…)` and `ctx.on('session/event',(session,event)=>…)`.
  - `ctx.webServer.register({kind:'exact',path:'/tonghuashun/ledger'})`.
- It reads token usage from `assistant/chunk` events where `chunk.type==='usage'`, from `assistant/message` `data.usage`, and from `llm/retry-started`. Events are keyed by `session.id:event.seq`, and inherited fork events are skipped via `inheritedEventCount` (`src/host/service.js:318-338`).
- Backfill reads history through `sessionQuery.listSessions()` and `readSession(id)` (`service.js:340-357`).
- File scanning (`src/host/scan.js:23-26`; `README.md:29`):
  - One `git ls-files --cached --others --exclude-standard -z` call per scan, with a 32 MB maxBuffer.
  - Falls back to a filesystem walk.
  - Path handling is symlink-safe (`safeRelative`).
- Shell commands are deliberately not attributed to agents. External changes show up as "unattributed reconciliation" bars instead (`README.md:48`).
- `TOKEN_FIELDS` are total, input, output, cacheRead, cacheWrite and reasoning. Unknown values stay `null` rather than 0 (`src/core/metrics.js:3-6,316-335`).
- The ledger has a single writer, protected by a pid+host lock with a stale-lock recovery guard. Writes are atomic (tmp, fsync, rename) (`service.js:68-112`; `README.md:50`).
- The HTTP endpoint answers loopback requests only and rejects cross-origin ones (`src/http.js:9-15`).
- The client polls every 1.5 s; there is no push (`src/client/project-store.js:31`).
- The `dsh-plugin.json` manifest (facets, permissions, subscriptions) is not read by the local DSH (`README.md:92`).

**(3) hermes-agent** (`G:\_Projects\hermes-agent`)
- Python>=3.11, MIT, v0.8.0 (`pyproject.toml:6-12`). It is a fork of NousResearch (git remote).
- The last commit is from 2026-04-12. The local branch is `fix/security-memory-scan-parity`, with uncommitted edits in `tools/memory_tool.py`.
- `~/.hermes` does not exist, so it is not in use locally (inferred).
- `acp_adapter/` is an ACP **server** on `agent-client-protocol>=0.9,<1.0`:
  - It supports initialize, new, load, resume, fork, list, cancel, prompt, and set model/mode (`acp_adapter/server.py:217-712`).
  - Updates are sent via `conn.session_update` (`acp_adapter/events.py`).
  - Sessions are persisted in `~/.hermes/state.db` (`acp_adapter/session.py:3,265`).
- `acp_registry/agent.json` is a registry manifest that runs `hermes acp`. The script entry is `hermes-acp` (`pyproject.toml:115`).
- `agent/copilot_acp_client.py` (570 LOC) is an ACP **client** over stdio JSON-RPC:
  - It sends `initialize`, then `session/new`, then `session/prompt`.
  - It handles `session/update`, `session/request_permission` and `fs/*` with cwd confinement (`:440-485`).
  - It **auto-answers every permission request with `allow_once`** (`:519-530`).
- `tools/delegate_tool.py`:
  - Child agents have blocked tools, `MAX_DEPTH=2`, and at most 3 concurrent children (`:29-39`).
  - A per-task `acp_command` can spawn "Claude Code (claude --acp --stdio)" (`:1047-1060`). The local `claude --help` has **no `--acp` flag** (verified).
- `gateway/platforms/api_server.py` runs on 127.0.0.1:8642:
  - Routes: `/v1/chat/completions`, `/v1/responses`, `POST /v1/runs` plus SSE `/v1/runs/{id}/events`, and `/api/jobs` CRUD with pause/resume/run (`:1-11,1736-1754`).
  - SSE events: `tool.started`, `tool.completed`, `reasoning.available`, `message.delta`, `run.completed`, `run.failed` (`:1478-1634`).
  - With no API key configured, every request is allowed (`:415-416`).
- `mcp_serve.py` is a stdio MCP "channel bridge" for MCP clients such as Claude Code and Codex. Tools: `conversations_list`, `messages_read`, `events_poll`, `events_wait`, `messages_send`, `permissions_list_open`, `permissions_respond`, `channels_list` (`:1-27,452-677`).
- `gateway/platforms/` has about 20 adapters (telegram, discord, slack, feishu, dingtalk, wecom, weixin, email, sms, webhook…) on `BasePlatformAdapter` (`base.py:726`).
- Cron:
  - Jobs live in `~/.hermes/cron/jobs.json`; output goes to `cron/output/{job}/{ts}.md` (`cron/jobs.py:1-36`).
  - `tick()` runs every 60 s under a file lock (`cron/scheduler.py:1-9,873`).
  - Delivery targets look like `telegram:123`, or origin, or local (`gateway/delivery.py:1-9`).
  - `gateway/mirror.py` writes a "delivery-mirror" record into the target session's transcript.
- The code is monolithic: `run_agent.py` 531 KB, `cli.py` 434 KB, `gateway/run.py` 8,672 lines.

**(4) CLIProxyAPI** (`G:\_Projects\CLIProxyAPI`)
- This is an upstream clone of `router-for-me/CLIProxyAPI`, not the user's code. Go 1.26, MIT, last commit 2026-02-15 (`go.mod`, `LICENSE`, git).
- It exposes OpenAI-, Gemini-, Claude- and Codex-compatible APIs backed by CLI OAuth subscriptions (Codex, Claude Code, Gemini CLI, Qwen, iFlow). It load-balances across multiple accounts round-robin (`README.md:41-58`).
- Config (`config.example.yaml`):
  - `routing.strategy: round-robin|fill-first` (`:82-84`).
  - `quota-exceeded.switch-project` and `switch-preview-model` (`:77-80`).
  - Usage statistics are in memory and `false` by default (`:62-63`).
- `GET /v0/management/usage` returns success/failure counts and tokens per API key per model (`internal/api/server.go:475-478`; `internal/usage/logger_plugin.go:109-133`). It has an embeddable Go SDK (`sdk/cliproxy`).
- It is not deployed: there is no `config.yaml`, `auths/` is empty, and `~/.codex/config.toml` has 0 references to `8317` (inferred).

**(5) DSH-plugins build scripts and reports**
- Every pnpm call must share one store, "otherwise pnpm keeps relinking junctions and Windows renames collide" (`clean-build-dsh-tui.ps1:4-5`). The fallback was `node-linker=hoisted` (`hoisted-build.ps1:7-14`).
- The DSH `workspace-write` sandbox causes `spawn EPERM` on piped child processes and EPERM on `%LOCALAPPDATA%` npm-cache. `git clone` over https fails, so code was fetched as Node tarballs (`reports/deepseek-bot-fork/03-fork-notes.md:14,75,102,130`).
- Node 22.14 lacks `module.registerHooks`, so a portable Node 24 is kept in `.tools/node24` (`03-fork-notes.md:129`).
- DSH HMR only recomposes plugin config and does not re-import cached modules, so a restart is needed (`03-fork-notes.md:143`). Writing `cordis.patch.yml` stalled the host for 87 s (`01-permission-switch-bug.md` §3.5).
- Cordis services can vanish across an `await` (`ctx.get` returns undefined while the fiber is not ACTIVE). The DSH kernel refuses sandbox-mode changes while persistent terminals are open. DS-Bot swallowed partial failures, so stored intent and the running session diverged (`01-permission-switch-bug.md` §3.1-3.5).
- The fix is on DS-Bot fork branch `fix/permission-switch-race` (commits `8c73edb`, `c2cccc1`, `a0b73e3`), license Apache-2.0. It is linked into the `web` profile (`~/.dsh/profiles/web/package.json`).
- The safe validation pattern used: an isolated `DSH_HOME`, a second `dsh web` on port 3099 or 3199, and junction-linked `node_modules` (`03-fork-notes.md` §6-7).
- The roadmap asks for a derived attention state machine (`working|waiting_on_user|unread|idle|scheduled|done_today`), a "needs you" inbox, budget warnings at 80%, and Routines v2 (`02-roadmap.md` §2).

## Integration surfaces / reusable pieces

| Block | Lift as-is | Lift with generalization |
|---|---|---|
| adaptive-router | `contracts.{validateEvidence,resolveCapability,wilsonLowerBound}`, `session-routing.{evaluateSwitch,applySessionAffinity}`, the whole `metering` (Ledger/FileJournal/quoteUsage) and `recovery` (`RetryBudget`, `decideRecovery`, `ExecutionRegistry`), `evaluations.{assignCanary,comparePairedTraces}`, `predictors.validateObservation` | `router-core.route`: swap the deployment key for `[harness, profile/agentId, model, worktree, configVersion]`. Make token, context and quota checks optional and add agent capabilities (sandbox mode, MCP tools, repo access, language). Quality per `taskClass` comes from deterministic labels (tests or CI green) or human accept. "Price" becomes subscription quota burn |
| tonghuashun | `scan.js` (`gitFileList`, `sourcePath`, `safeRelative`); `metrics.js` (`normalizeUsage`, `recordChange` OHLC, `deriveCandles`, `intradaySeries`); `acquireLock` and `writeAtomic`; the loopback guard in `http.js` | Move the `tools/execute` and `session/event` ingestion behind a per-harness adapter interface (DSH events here; Codex and Claude transcripts are other subagents' scope). Replace 1.5 s polling with SSE |
| hermes-agent | ACP client skeleton `agent/copilot_acp_client.py` (replace auto-`allow_once` with an approval queue); ACP server pattern `acp_adapter/server.py` and `events.py`; `/v1/runs` plus SSE event vocabulary; `mcp_serve.py`'s 8-tool channel-bridge shape (events_wait, permissions_respond) as an A2A-over-MCP template; `gateway/platforms/*` for phone and chat notifications; `cron/jobs.py` schedule parsing and `delivery.py` target syntax; `mirror.py` "delivery-mirror into recipient transcript" | Python. Run it as a sidecar process (HTTP or MCP), not as a library import |
| CLIProxyAPI | `/v0/management/usage` snapshot; `routing.strategy` and `quota-exceeded` semantics as design reference | It attributes usage per agent only if each agent gets its own client API key |
| DSH plugin know-how | `cordis.patch.yml` insert entry, `dsh.bundle.patch`, `exports["./client"]`, `dsh.client.{platform,immediately,inject,external:["react"]}`, client slots (`conversation.session.header.utilities`, `conversation.composer.dock`, `details`, `settings.general.item`), `ctx.sessions.binding(id).ctx.remote.commands.execute` (`dsh-adaptive-router/client.js:99-101`), `plugin_manager(action:"install_bundle")` | n/a |

## Gaps & risks

- **Adaptive-router is not a production component.** No certified route exists until real evidence is imported. Cost stays `pending`. Recovery is not wired in. It is not installed anywhere, has no LICENSE, and has no git history of its own.
- **Its router has model concepts in its core.** `validateTaskPolicy` throws without token and modality fields, so AutoRoute needs a fork of `router-core`, not just configuration.
- **There is no agent-level quality data.** Wilson gating at the default 20 samples and 0.8 lower bound (`policies/default.json`) means a cold start yields `no-route` for everything. Orchestra needs a manual or heuristic fallback plus a label pipeline from test or CI outcomes.
- **Several stores assume a single writer.** The Ledger and RouterStore are single-writer per directory (`writer.lock`), and so is the tonghuashun ledger. An Orchestra spanning several hosts and harnesses needs one owner process or a real database.
- **Tonghuashun misses shell work.** Edits made through shell commands appear only as unattributed drift, and Codex and Claude edit heavily through shell. It also covers DSH only.
- **Hermes has dangerous defaults.** The ACP client auto-approves permissions, and `api_server` without a key allows everything. Its `claude --acp --stdio` claim does not match the local Claude CLI (no flag), so an external ACP adapter would be needed (inferred). The codebase is huge, monolithic and six months stale, with an uncommitted local branch.
- **CLIProxyAPI may breach provider terms.** It proxies consumer OAuth subscriptions to third-party clients, which plausibly violates provider terms (inferred). It also concentrates every token in one process, and its usage stats are in memory and off by default. It is someone else's code.
- **DSH runtime is fragile.** Services vanish during HMR. Sandbox-mode changes are refused while persistent terminals are open. HMR does not reload code. Profile edits stall the host. Windows plus the sandbox produce EPERM on pipes and caches. DS-Bot targets dsh 0.2.0-rc.2 while 0.2.1-rc.2 runs locally (`01-permission-switch-bug.md` §1).

## Implications for Orchestra

1. **Build AutoRoute on the router's shape, not its schema.** Keep the pipeline: hard filters with typed rejection reasons, then gating on expiring, version-scoped evidence per taskClass, then cost or quota sort, then affinity with hysteresis, then a deterministic `decisionId` written to an audit log. Re-key on (harness, agent, project/worktree). Also lift `dry-run` and `shadow` modes so routing can be watched before it acts.
2. **Make session affinity the default and switching expensive.** Copy `evaluateSwitch` (cooldown, hysteresis, penalty). Copy the `SESSION_MIGRATION_REQUIRED` rule too: moving a task to another harness spawns a new worker with a handoff summary, never a replay of history across harnesses.
3. **Treat agent dispatch as a side effect.** Use `recovery.ExecutionRegistry` semantics: if a task's outcome is unknown, never auto-redispatch it; reconcile against git state first. Share one `RetryBudget` across failover layers.
4. **Use one durable, idempotent ledger owned by the Orchestra host.** Hash-chained JSONL, `reserve`/`settle` per project or agent budget, and unknown usage kept `null` or `pending`, never 0. Feed it from each harness's own usage events (DSH: `assistant/message` usage). Do not rely on CLIProxyAPI.
5. **Port tonghuashun's observability as a harness-neutral activity model.** Per-project git `ls-files` line counts, per-tool-call edit records, and token ledgers per session, served over loopback with origin checks. Add the attention states from the DS-Bot roadmap (`working|waiting_on_user|unread|idle|done_today`) and push over SSE instead of polling.
6. **Use ACP (stdio JSON-RPC) and an MCP channel bridge for messaging.** Wrap each harness as an ACP agent, or drive it with an ACP client modelled on `copilot_acp_client.py`. Route every `session/request_permission` into one "needs you" inbox, never auto-allow. Expose A2A to agents as MCP tools in the `events_wait/messages_send/permissions_respond` shape.
7. **Keep persistent bots and routines out of process.** Reuse hermes's cron job format, delivery targets and platform adapters as a sidecar for scheduled and phone-reachable bots. Mirror deliveries into the recipient's transcript so receiving agents have context.
8. **Build defensively when hosting inside DSH.** Re-acquire services after every await. Always surface partial failures. Reconcile intended against actual permission and model state every turn. Use isolated `DSH_HOME` and port test instances, a portable Node 24, and a shared pnpm store, and plan for restarts, not HMR.