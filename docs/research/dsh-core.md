
## Facts
Path aliases used below: `$DSH` = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` and `$N` = `$DSH\node_modules\@deepseek-ai`. `GH` = github.com/deepseek-ai/deepseek-harness (default branch `master`).

- **Version and release cadence.** The installed version is 0.2.1-rc.2 (`$DSH\package.json:4`, `dsh --version`). npm dist-tags are `latest=0.2.1-rc.2`, `next=0.2.1-rc.4` (published 2026-10-26) and `alpha=0.2.1-alpha.5`. 38 versions have shipped since 0.0.1-rc.1 on 2026-08-10, roughly one every 2 days, and every one is a prerelease (`npm view @deepseek-ai/dsh time`). The last push to GH was 2026-10-23 (`gh api repos/...`).
- **Launcher model.** `dsh` boots a *profile*: an ordered stack of Cordis bundle patch layers, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` (`$DSH\README.md:37-46`). The shipped entry modes are `web`, `headless`, `sdk`, `sdk-minimal` and `acp`. The `desktop` profile name is reserved for Electron (`$DSH\README.md:11-22`). Plugins are managed with `dsh plugin --profile <name> <pnpm args>`, and changes hot-reload when HMR is on (`$DSH\README.md:18,37`).
- **Plugin manifest.** The real manifest is the `dsh` field in `package.json` (`manifestVersion: 1`, `bundle.patch`, `client`) plus `engines.dsh` (`$N\dsh-package-manifest\README.md`, "Use this package" section). DSH never reads `dsh-plugin.json` (`manifestVersion 0.15`, facets, permissions, subscriptions); the user's own README says so (`G:\_Projects\dsh-tonghuashun\README.md:92`). Its two subscriptions do correspond to real Cordis events: `tools/execute` (`$N\dsh-tools\lib\types\index.d.ts:58`) and `session/event` (`$N\dsh-session\lib\types\index.d.ts:61`).
- **In-process hook points**:
  - Tools: `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result` (`dsh-tools\...\index.d.ts:47-92`).
  - Agents: `agent/created|disposed|status|inbox/inserted|inbox/claimed|inbox/discarded|pre-step|request|request-error|assistant-stream|turn-stopping|error` (`$N\dsh-agent\lib\types\runtime-types.d.ts:227-402`).
  - Subagents: `subagent/start`, `subagent/end` (`$N\dsh-subagent\lib\types\index.d.ts:86,94`).
- **Token usage** is carried only as `usage` on each step's `assistant/message` event. There is no separate usage record (`$N\dsh-session\lib\types\types.d.ts:322-343`). `ctx.tokenMeter` exposes `tokenUsage` and `contextPressure` projections (`$N\dsh-token-meter\README.md` Summary).
- **Durable event vocabulary** includes `turn/*`, `step/*`, `tool/call`, `tool/result`, `subagent/catalog|descriptor`, `team/member|task|message/*`, `todo/write`, `goal/change`, `schedule/change`, `job/registered|settled` and `hook/invoked|result` (`$N\dsh-session\lib\types\known-event-types.js`).
- **Storage layout.** Session logs live at `~/.dsh/sessions/--<cwd-encoded>--/<uuid>/session.v4.jsonl.zstd` (observed: `~/.dsh/sessions/--G-_Projects-DSH-plugins--/0b5d2ffe…/session.v4.jsonl.zstd`). There is a projection cache at `~/.dsh/storages/session_projcache`.
- **ACP.** `dsh --profile acp` speaks standard ACP v1 over stdio and can run several sessions on one connection:
  - Methods: `initialize`, `session/new|list|resume|close|prompt|cancel|set_config_option`.
  - Server-to-client: `session/update` (messages, thoughts, tool lifecycle, context usage) and `session/request_permission`.
  - Not supported: `session/load`, fork, modes, plans, terminals, elicitation (`$N\dsh-acp\README.md:60-80`).
  - Defaults: model `deepseek-v4-flash`, HMR off (`$N\dsh-acp-app\cordis.patch.yml`).
- **SDK.** `dsh --profile sdk` speaks newline-delimited JSON-RPC over stdio.
  - Requests: `initialize`, `session/prompt` (returns only a `messageId` receipt), `session/resume`, `session/wait`, `session/working-directory/get|set`, `shutdown`.
  - Notifications: `session.event` (every session, unfiltered), `session.status` (running/idle), `subagent.started`, `subagent.finished` (in-process children only) (`$N\dsh-sdk-protocol\README.md:36-54`).
  - There is no cancel or close method (`dsh-sdk-protocol\README.md:120-122`; `$N\dsh-sdk-jsonrpc-server\README.md:130-131`).
- **Web host transport.** `dsh web` serves HTTP on loopback only; binding `0.0.0.0` is rejected.
  - Unary calls are `POST api/<endpoint>` with body `{type:"client-request", rpcId, method, payload}` (`$N\dsh-client-connection\lib\client.browser.js:1212-1231`).
  - Streams and `$events` are multiplexed over the `/api/remote.mux` WebSocket, with a Ping every 2 s (`$N\dsh-api-gateway\README.md:39,47`). SSE is not used for the API (inferred; the gateway README mentions SSE only as excluded from compression).
  - Auth starts from a per-process launch token that is exchanged for a signed cookie. Programmatic callers use `GET /connect?token=…&interactions=answer|none`, which returns a 302 plus an API cookie. Authorization headers are not accepted (`dsh-client-connection\README.md:41,51`).
- **Web Remote methods.**
  - Session: `session.create|list|prompt|cancel|fork|rename|search|selectModel|updateQueue|page|projections`, plus the streams `session.control` and `session.follow` (`$N\dsh-api-session-controller\lib\typert.remote-client.d.ts:17-35`).
  - Subagent: `subagent.prompt` and `subagent.interruptByParent` (`$N\dsh-subagent\lib\typert.remote-client.d.ts:12-13`).
  - Jobs: `job.list`, `job.follow`, `job.kill` (`$N\dsh-api-job-controller\README.md`).
  - Non-owner peers are gated by role policies (`$N\dsh-api-remote-access\README.md`).
- **Headless.** `dsh headless "task" [--json] [--session-id <id>]` writes NDJSON events: `session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`, `final`, `error`. Strings are capped at 8 KiB and text arrives per committed step, not per token (`$N\dsh-headless\README.md:74-78,162`).
- **Subagent providers.**
  - `spawn` and `fork` run in-process and are continuable. `acp`, `dsh-sdk`, `codex` and `claude-code` are external and run once, with no follow-up (`$N\dsh-subagent\README.md:12,61,201`).
  - Limits: `maxActiveSubagents` defaults to 8 per activation tree and fails with `ACTIVATION_LIMIT_REACHED` rather than queueing; `maxDepth` defaults to 1 (`$N\dsh-subagent\README.md:49-57`).
  - `sendMessage` only works between a direct parent and child. Completion arrives as a user-role notice to the parent (`$N\dsh-subagent\README.md:69,136`).
  - The model gets `send_message`, `interrupt_agent` and `list_agents`, but no `wait_subagent` (`$N\dsh-tool-subagent-control\README.md:12`). Programmatic waits do exist: the `result` promise with `delivery:'caller'`, and SDK `session/wait`.
- **Codex and Claude Code as providers.**
  - `@deepseek-ai/dsh-subagent-codex` starts a fresh `codex app-server` and one ephemeral `thread/start` per run, with `permissionMode` defaulting to `never` (GH `packages/subagent/subagent-codex/README.md:43-105`).
  - `@deepseek-ai/dsh-subagent-claude-code` uses the Claude Agent SDK with a platform-pinned runtime and never the host `claude`; `permissionMode` defaults to `dontAsk`, and usage stays out of the parent (GH `packages/subagent/subagent-claude-code/README.md:12-98`).
  - Neither is installed locally: `$N` contains only `dsh-subagent-fork-in-process` and `-spawn-in-process`. The experimental `subagent-oar` provider uses the native CLIs instead.
- **Agent Team (experimental).** It is enabled in the user's web profile (`~/.dsh/profiles/web/package.json` bundles).
  - Structure: the root session is the implicit Lead (`TeamId = SessionId`). Teammates are created fresh or as forks, and member status is `running`, `inactive`, `provisioning` or `failed` (`$N\dsh-experimental-agent-team\README.md:58-62,126`).
  - Nine tools: `spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create|list|get|update` (`$N\dsh-experimental-tool-agent-team\lib\index.js:251-457`).
  - `wait_agent` takes a 10 s to 1 h timeout (default 30 s). It returns `noProgress` when no peer is active and the caller then re-reads state (`lib\index.js:330-345`).
  - Messages are delivered to the target's inbox at the next step boundary, framed as "Team message from <name>:". There is no separate "report back" primitive: teammates `send_message` to `lead` (inferred from README:130 and the policy text).
  - Constraints: one process, one shared cwd. Task updates are compare-and-set; write-scope overlap only produces warnings (README:32,76-78).
  - The profile layer sets `maxMembers` to 8 and disables the legacy subagent tools (`$N\dsh-experimental-agent-team-profile\cordis.patch.yml`).
- **Goals, todos, schedules, jobs, workflows.**
  - `dsh-goal`: one persistent objective per session; with `goal-round-driver` it continues automatically, capped at 256 rounds.
  - `dsh-tool-todo`: a session-scoped list.
  - `dsh-schedule`: cron, daily and one-shot reminders delivered into the original session, which is cold-resumed if needed.
  - `dsh-jobs`: background jobs with ids.
  - `dsh-workflow`: JavaScript `agent()`, `parallel()` and `pipeline()` fan-out.
  - Sources: the Summary sections of each package README in `$N`.
- **Plugin markets.** The official `dsh-plugin-market` reads index format 1 (`$N\dsh-plugin-market\README.md`). The user's installed `dshmarket` 1.66.38 is third-party (github.com/dsh-market/dsh-market; registry awesome-dsh-plugin.com) (`~/.dsh/profiles/web/node_modules/dshmarket/package.json`).
- **Hook bridges.** `dsh-hooks-claude-code` and `dsh-hooks-codex` run the user's existing `hooks.json` command hooks, and `claude-code-mods` is an alpha bridge for Claude Code mods. They appear only as devDependencies and are not installed (`$DSH\package.json` devDependencies; GH `packages/experimental/hooks-*/README.md`).
- **Local web instance.** The user's watchdog restarts `dsh web --no-open` on 127.0.0.1:3080 (`~/.dsh/watchdog.sh`). Nothing was listening on 3080 when checked (netstat).
- **dsh-TUI** runs inside DSH as its own profile (`--profile dsh-tui`), not as an external client (`G:\_Projects\dsh-TUI\src\dsh-adapter\plugin-guard.ts:61`).

## Integration surfaces / reusable pieces

| Surface | (a) Observe | (b) Control / spawn | (c) Message |
|---|---|---|---|
| **ACP stdio** (`dsh --profile acp`) | `session/update`: committed messages and thoughts, tool lifecycle, context usage | `session/new` (cwd, MCP servers), `list`, `resume`, `close`, `cancel`, `set_config_option` (model, reasoning effort) | `session/prompt` (one in flight per session; settles after descendants finish) |
| **SDK JSON-RPC stdio** (`dsh --profile sdk`; TypeScript `dsh-sdk-client` and Python SDK) | `session.event` (raw SessionEvent with usage), `session.status`, `subagent.started/finished` | `initialize` (route, `maxTokens`), `session/resume`, `session/wait`, working-directory get/set, `shutdown` | `session/prompt` returns a `messageId` (can be sent while busy: queues) |
| **Web host API** (`dsh web`, live long-running instance) | `session.control` stream (list and projection frames), `session.follow` (journal with gap repair), `session.projections` (todos, goals, agentTeam, tokenUsage), `$events`, `job.follow` | `session.create/fork/cancel/selectModel/updateQueue/rename`, `job.kill`, `subagent.interruptByParent` | `session.prompt` (Queue or Steer, `requestId` dedup), `subagent.prompt` |
| **Headless** (`dsh headless --json`) | NDJSON `status`, `tool_call`, `tool_result`, `final` | one process per task; exit code 0/1 | `--session-id` continues a stored session |
| **In-process Cordis bundle** (an Orchestra bridge plugin) | every `ctx.on` event listed in Facts | `ctx.subagents.startActivation({provider, delivery:'caller'})` returns `{childId, result, dispose}`; `ctx.agentTeams`; `ctx.webhookRuntime` (experimental) | `ctx.subagents.sendMessage`, `agentTeams.sendMessage` |
| **Files** | `session.v4.jsonl.zstd` logs; `dsh-session-query-sqlite` search | n/a | n/a |

Pieces worth reusing:
- `dsh-tool-workflow` / `dsh-workflow`: the `agent/parallel/pipeline/phase` DSL.
- The CAS task board (dependency graph, `writeHints`) as a cross-agent task model.
- `dsh-schedule` and `dsh-goal` for persistent "bot" agents.
- The subagent-codex `app-server` wire code (`src/wire.ts`) as a reference Codex driver.
- The hooks bridges, which let one `hooks.json` govern DSH, Claude Code and Codex alike.
- The `remote-access` principal and role model, for read-only observer peers (`interactions=none`).

## Gaps & risks

- **Prerelease churn.** A release lands about every 2 days and there is no stable tag. The SDK has no protocol-version negotiation (`serverInfo.version` is 0.0.1). The web Remote API is generated and internal, with no compatibility promise. The session format is at v4 with a migration chain.
- **No cross-process coordination.** Inboxes and activation residency are process-local. There is no durable parent mailbox and no cross-process lease (`dsh-subagent\README.md:210`). A second writer gets `session/writer-held`. Agent Team works in one process only and its write scopes are advisory.
- **Gaps in control:**
  - SDK sessions cannot be cancelled or closed except by killing the process.
  - ACP has no fork, replay, todos or plans.
  - External Codex and Claude Code children run once, report no token usage, and send no `subagent.finished` over SDK.
  - Hitting the concurrency cap fails the call instead of queueing.
  - Lifecycle events are observe-only.
- **The model has no blocking wait for a subagent.** It relies on completion notices; `wait_agent` exists only in Team mode.
- **Plugin trust.** Bundles run fully trusted inside the host process. `dsh-plugin.json` permissions are not enforced anywhere (inferred from the user's own scan).
- **Secrets.**
  - `~/.dsh/.credentials.yaml` holds the cookie-signing secret.
  - The launch-token URL is written to `~/.dsh/watchdog-server.log` (1 occurrence; not printed here).
  - A non-loopback bind without TLS leaks the cookie.
  - The Claude Code provider's `bypassPermissions` mode is dangerous.
- **Version skew.** The Claude Code provider uses its own pinned runtime, which can differ from the user's `claude` at `~/.local/bin`.
- **Logs** are zstd-compressed and use a strict schema, so outside readers need zstd plus the v4 schema.

## Implications for Orchestra

1. **Use ACP as the common protocol for every agent.** DSH (`--profile acp`), Claude Code (through an ACP adapter) and Codex (app-server or ACP) can then sit behind one client. Use the SDK profile where Orchestra needs raw `SessionEvent`s (usage, subagent lifecycle, team events). Attach to the user's live `dsh web` on 3080 through `/connect?token=…&interactions=none` for read-only monitoring.
2. **Orchestra must own agent-to-agent messaging across processes.** DSH messaging is in-process and parent/child only. Build a durable external mailbox that delivers with ACP `session/prompt` or web `session.prompt` in Steer mode. Treat DSH Team and subagents as an internal section under one Orchestra musician.
3. **Keep one owning process per session.** Keep a sessionId → process registry, handle `session/writer-held`, and consider a separate `DSH_HOME` per project or long-running agent to avoid store contention (inferred: DSH_HOME is honored per the README's use of `$DSH_HOME`).
4. **Normalize telemetry onto one event bus:**
   - Tokens from `assistant/message.usage` and ACP context usage.
   - Tool calls from `tool/call` and `tool/result`.
   - Spawn and finish from `subagent/catalog`, `subagent.started` and `subagent.finished`.
   - Team state from `team/*`.
   - Activity from `session.status`.

   This feeds a multi-project attention view, for example "needs approval", "idle with result", "blocked goal".
5. **AutoRoute must queue and throttle itself.** DSH rejects work at `maxActiveSubagents` (8) and depth 1, so Orchestra should hold a priority queue per project and route through `dsh-adaptive-router` evidence plus the configured provider and model.
6. **Build persistent bot-like agents on DSH primitives.** Combine a goal with the round driver for unattended loops, schedules (cron into a session) for wake-ups, and `session/resume` after restarts. Orchestra only needs to supervise these, not re-implement them.
7. **Ship the DSH side as a real bundle.** It should use `package.json#dsh` and pin `engines.dsh` exactly. A host plugin can subscribe to `agent/*`, `subagent/*` and `tools/*` and relay them outward, and can start `caller`-delivery activations. Do not rely on `dsh-plugin.json`.
8. **Pin DSH and re-test each upgrade.** Pin the version, and before upgrading run keyless conformance checks against the ACP, SDK and Web APIs. Updates arrive about every 2 days.