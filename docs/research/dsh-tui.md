## Facts

**Identity, license, local state**
- The repo is a clone of `github.com/ccch1mneyyy/dsh-TUI`, at HEAD 71f5ac93 (2026-10-24), version 0.17.0, licensed MIT (Copyright 2026 chimney). Evidence: `git remote -v`, `G:\_Projects\dsh-TUI\package.json:3,19`, `LICENSE:1-3`.
- The locally installed copy is far behind the repo. `~/.dsh/profiles/dsh-tui/package.json` pins `0.10.0-beta.5`, the global npm copy is also 0.10.0-beta.5, the Claude SDK is not in the profile, and `~/.dsh-tui/backends/` does not exist. So the Claude and Codex backends have never been used on this machine.
- Local CLI versions are outside the validated lines:
  - `codex --version` reports 0.139.0. That is below `MIN_CODEX_VERSION = '0.144.0'` (`src/backends/codex/contract.ts:37`), so the Codex backend would report "not installed".
  - `claude --version` reports 2.1.310. The validated CLI is `2.1.287` (`src/backends/claude/contract.ts:34`), so this only produces a drift notice, not a stop (`contract.ts:1-8`).

**What herdr is**
- `src/herdr.ts` integrates with Herdr, a "terminal workspace manager for AI coding agents". It is installed locally at `~/.herdr/.../0.8.2-x86_64-pc-windows-msvc/herdr` (from `herdr --help`).
- When `HERDR_ENV=1`, `HERDR_BIN_PATH` and `HERDR_PANE_ID` are set (`herdr.ts:59-63`), dsh-TUI shells out to `herdr pane report-agent <pane> --source custom:dsh-tui --agent dsh-tui --state idle|working|blocked [--message "Waiting for user input"] --seq N`. On exit it calls `pane release-agent` (`herdr.ts:115-123, 164-169`).
- The state is "blocked" whenever a question or approval is pending (`herdr.ts:88-91`). The integration is wired in `src/dsh-adapter/plugin.ts:2204`.
- The Herdr CLI also offers `agent list/get/read/prompt/wait/start` and `notification show` (from `herdr agent --help`).
- Separately, dsh-TUI emits OSC 7501 "Program Status Protocol" states `idle/working/blocked/done/error` over the pty (`src/ink/termio/osc7501.ts:1-22`; README.md:230). It can be turned off with `DSH_TUI_PROGRAM_STATUS=0`.

**Architecture**
- The layering is: UI (`src/screens`, `components`, `ink`), then the `ChannelUi` port, then the backend-neutral channel core, then the Agent Domain in `src/agent/` (pure types, no I/O), then three backends (`docs/agent-backend-design.md:13-28`).
- **One process runs one backend**, chosen at startup with `--backend`, a config row, or `/kernel`. Switching backends restarts the process (`agent-backend-design.md:34-35`).
- One TUI process can host several sessions. Parked sessions keep running, and all of them die when the process exits (`docs/session-mount-runtime.en.md:36-56`).
- Ownership across processes is tracked in `~/.dsh-tui/session-mounts.json` as `{pid, startedAt, sessionIds}`. It uses a lock file, and a record counts as live only while its pid exists (`session-mount-runtime.en.md:92-176`). Claude mounts are recorded as `claude:<id>` (`agent-backend-design.md:190-191`).
- dsh-TUI currently runs as a Cordis plugin inside a DSH profile (`docs/architecture.en.md:7-20`).
- Plan B ("standalone host") makes dsh-TUI own its own entry point. Under the Claude or Codex kernels it composes a light profile without DSH's agent core. It has been accepted for Claude but **not accepted for Codex** (`docs/standalone-host-design.md` §5, §8).

**Normalized interface (`src/agent/`)**
- `AgentSession` (`session.ts:65-80`) has:
  - `ref {backendId, sessionId}`, `cwd`, `status` (`starting|idle|running|requires-action|disposed`) and `capabilities`.
  - `history()`, `subscribe(batch, meta{replay, wake})`, `submit(input, placement)` with placement `turn|steer|followup|now` (`:33`), `cancel(cause)` returning a `CancelReceipt{stillQueued, outcome}`, and `dispose()`.
- `AgentEvent` (`events.ts:209-409`) covers:
  - session: `.ready/.title/.cwd/.reset/.status`
  - turns: `turn.start` with origin `user|system|notification`, `turn.end` with reason, usage and cost; `step.*`
  - messages: `user.message`, whose source includes `team-message` and `notification` and carries a `sender`; `assistant.attempt/delta/message`; `usage`
  - tools: `tool.call/result/progress/output`
  - prompts: `permission.request/settled`, `question.request/settled`
  - background work: `subagent.start/progress/end` (with `parentAgentId` and `depth`), `task.*`, `tasks.snapshot`
  - context: `compaction.*`, `context.capacity/usage`
  - settings: `model.changed`, `effort.changed`, `mode.changed`, `commands.changed`, `goal.change`, `todo.write`
  - other: `agent.message` (an observed agent-to-agent relay, `:393-402`), `notice`, `rate-limit`, `custom`
- `SessionCapabilities` (`capabilities.ts:170-383`) are all optional. A missing capability means "unsupported", never a silent no-op. They include:
  - `permissions.respond`, `questions.respond`
  - `models.list/set`, `effort.levels/forModel/set`, `modes.list/cycle/set`
  - `compact`, `rewind`, `fork`
  - `subagents{interrupt, history, messaging:'parent-mediated', messagingTool}` (`:279-293`)
  - `tasks.stop/readOutput`, `transcript`, `mcp`, `sideQuery.ask`, `rename`, `images`, `commands`, `context.usage`, `account`, `auth`, `channels`, `goals.set`, `workingActivity.subscribe`, `diagnostics`
- `AgentBackend` (`backend.ts:209-224`) has `id`, `detect(host)` returning installed/auth/version/drift/hint, `open({kind:'create',cwd} | {kind:'resume',sessionId,cwd?}, host)`, an optional `catalog` (list/info/preview/rename/delete), and `launch.sessionPrefs/resumeCommand`. The id comment already names `acp:<agent>`.
- How each backend maps `seq`, `anchor`, `turn`, `attemptId`, `callId`, `parentCallId` and `agentId` is in the table at `agent-backend-design.md:65-73`.

**Claude transport: Agent SDK, not raw stream-json**
- It uses one long-lived streaming-input `query()` per session (`src/backends/claude/session/lifecycle.ts:1-35, 262-287`). The SDK is loaded with a dynamic `import()` (`sdk.ts:31`) and pinned at `@anthropic-ai/claude-agent-sdk 0.3.287` (`contract.ts:25`).
- The options (`options.ts:256-290`) are:
  - the `claude_code` preset for system prompt and tools, with `settingSources` user/project/local
  - `canUseTool`, `onElicitation` and `onUserDialog` handled by the TUI
  - `includePartialMessages`, `forwardSubagentText`, `perTaskStopAffordance`, `enableFileCheckpointing`
  - `sessionId` or `resume`, `pathToClaudeCodeExecutable`, and `extraArgs['replay-user-messages']`
  - `allowDangerouslySkipPermissions: true`, always on
- Placement maps to SDK priority: steer becomes `priority:'next'`, followup becomes `'later'`, now becomes `'now'` (`lifecycle.ts:6-9`).
- History comes from the SDK's `getSessionMessages` plus a read-only scan of the native `~/.claude/projects/<cwd>/<id>.jsonl`, which is refused above 64 MiB (`agent-backend-design.md:99-101, 182-185`).
- Sessions created through the SDK do not appear in the CLI's own `/resume` picker; they have to be opened with `claude --resume <id>` (`:176-178`).

**Codex transport: `codex app-server` JSON-RPC v2 over stdio, not `exec --json`**
- The design explicitly rejected `@openai/codex-sdk`, because it wraps `exec`: no approvals, no steer, no in-place interrupt. It also rejected `codex mcp-server` and embedding the Rust core via napi (`docs/codex-backend-design.md:24-27, 127`).
- `rpc/transport.ts:1-20` spawns `codex app-server` with newline-delimited JSON on stdout. `rpc/hub.ts:1-25` keeps one child per settings fingerprint that serves many threads, routes messages by thread id, closes after 30 s idle, and restarts with 0.5/2/5 s backoff.
- Methods are listed at `protocol/index.ts:57-144`: `thread/start|resume|fork|list|read|turns/list|archive|compact/start`, `turn/start|steer|interrupt`, `model/list`, `thread/goal/*`, `thread/backgroundTerminals/*`, and notifications `item/*`, `turn/*`, `thread/status/changed`.
- Protocol types are generated from codex-cli 0.160.1 and checked in (875 files), guarded by a digest (`contract.ts:28-52`).
- Subagent messaging is parent-mediated through `send_input` (`session/subagents.ts:196-197`).

**Maturity**
- **DSH backend:** the reference backend. Its translator was split out and checked against golden projections (`agent-backend-design.md:272-278`).
- **Claude backend:** labelled "experimental", with known gaps: no `/add-dir`, no `/tree`, and it cannot detect a concurrent `claude --resume` (`docs/claude-backend.en.md:225-248`).
- **Codex backend:** labelled "experimental" and described as development-branch documentation. Only 9 offline checks have run against a real app-server. **No real model turns, OAuth or TTY have been tested** (`docs/codex-backend.en.md:1-17, 330-334`; `codex-backend-progress.md:303-342`).

**Agent teams (`docs/agent-teams-design.md`)**
- This is DSH-only. It adapts the experimental packages `@deepseek-ai/dsh-experimental-agent-team-*`.
- Every root session is an implicit Lead, and teammates are continuable subagents (`:9-11`).
- From 0.2.1, messages travel as a generic relay: `{kind:'agent-message', form:'relay', senderSessionId}` with the prefix `Team message from <name>:` (`:20`). The 0.2.1 behaviour was read from package source, not run live (`:16`).
- Teams are switched on per profile with `/plugin enable|disable`, not per session (`:58`).
- Phase 1 and the dashboard part of phase 2 are done; the status-line summary and "enter teammate session" are not (`:41-52`).
- Upstream limits: teammates share one cwd, a team lives in a single process, and task owners are never auto-released (`:99`).

**Roadmap**
- The project goal is a DSH terminal workbench. "A cross-frontend unified workbench" and "independent Agent services" are listed as Future Work (`docs/roadmap.en.md:100-109`).
- Full Channel state (L5) is deferred; replay is still "minimal" (`docs/roadmap-adapter-channel-l4-l5.md:2-4`).
- An ACP backend directory is reserved but does not exist yet (`ADAPTER.md:11`).

## Integration surfaces / reusable pieces

- **Library candidates (backend-neutral by rule):**
  - `src/agent/*` is about 1.6k lines of types and helpers. Its only imports are types from `src/adapter/ports/channel-{view,session}.ts`.
  - `src/backends/{claude,codex,shared}` are "islands": they import only `agent/`, `shared/`, Node built-ins and their vendor package. This is enforced by `verify:boundary` (`ADAPTER.md` table). The one allowed exception is `shared/channel-tokens.ts → src/utils/credentials.ts`.
  - None of these import React, Ink or Cordis (checked with grep).
  - The npm package does **not** export them: its exports are `./api` (types only), `./panels`, `./extensions` and similar. Reusing them means vendoring the source, which MIT allows.
- **Reusable entry points:** `codexBackend` and `closeAllCodexHubs` (`src/backends/codex/index.ts`), and the Claude backend's `backend.ts` and `index.ts`. Each implements `AgentBackend.open()`, which returns an `AgentSession`.
- **Fakes for tests:** `scripts/lib/claude-fake-sdk.ts`, `scripts/lib/codex-fake-app-server.ts`, and the cost guards `claude-haiku-only.mjs` and `codex-cheap-only.mjs`.
- **Neutral helpers:** `src/channel/` contains the shared projector (`projection.ts`), permission and question stores and usage. It is mostly UI-free but imports `i18n.js` and `ink/stringWidth`.
- **Driving a running dsh-tui from outside:**
  - The inject socket is `\\.\pipe\dsh-tui-inject-<sessionId>` on Windows. Discovery is via `~/.dsh-tui/inject/servers.json` records `{pid, sessionId, cwd, socketPath, startedAt}`.
  - The wire format is NDJSON with two messages: `{"type":"prompt.append","text":…}` and `{"type":"command.execute","command":"prompt.submit"}` (`src/dsh-adapter/inject-channel.ts:1-23`).
- **Observing a running dsh-tui:** Herdr `report-agent` states, OSC 7501, and `~/.dsh-tui/session-mounts.json` (which process owns which session).
- **Foreign-session parsers:** `src/dsh-adapter/migrate/` (`browse.ts`, `parse/`) reads the Claude Code jsonl, Codex rollouts, grok-build and zcode formats into turn and step models. This could feed cross-harness history handoff (`docs/foreign-session-tabs-design.md:167-240`).
- **Third-party backend bundle:** a package with `dsh-plugin.json` containing `contributes['x-dsh-tui']` of `kind:'Backend'` and a default export `backend` is installed into the profile and appears in the kernel picker after a restart (`agent-backend-design.md:364-387`). This stage is alpha with no stability promise.

## Gaps & risks

- **Coupling to DSH and Cordis.** The DSH backend needs an in-process Cordis context and `@deepseek-ai/dsh-agent` (`src/dsh-adapter/backend/session.ts:12-15`). It is not usable as a standalone library, and the peer dependency list is pinned to DSH release lines.
- **One backend per process.** A TUI process cannot mix Claude, Codex and DSH. This is a limit of the TUI's kernel, not of the backend code: the Codex hub already multiplexes threads.
- **No external event API.** There is no IPC or wire protocol for the `AgentEvent` stream, and the Channel is "not JSON wire state" (L4 notes; L5 deferred). An outside process sees only status (Herdr/OSC), prompt injection, and the on-disk logs.
- **Inject socket risks:**
  - It has no authentication by design; any local process can submit prompts.
  - It binds to `channel.agentId` (`plugin.ts:2806-2818`). Whether that is set for Claude and Codex sessions is (inferred) plausible but not verified.
- **Unverified backends:**
  - Codex has no live model-turn, OAuth or TTY verification, and this machine's codex 0.139 is below the supported minimum.
  - Claude is experimental and always passes `allowDangerouslySkipPermissions: true`, so bypass mode is reachable at runtime.
  - Injecting a claude.ai subscription token carries Anthropic terms-of-service caveats (`claude-backend.en.md:247-248`).
- **No direct agent-to-agent channel.** In both Claude (`SendMessage`) and Codex (`send_input`), subagent messaging is parent-mediated, and a receipt does not mean the message was read. There is no direct child inbox.
- **Agent teams are narrow.** They are DSH-only, experimental, switched per profile, single-process, share one cwd, and need an exact version line. Cross-harness teams do not exist.
- **Double drivers.**
  - The mount ledger only works on one machine.
  - A plain `claude --resume`, or a Codex "active writer" in another terminal, goes undetected or ends in a conflict.
  - Parked sessions die when the TUI exits: there is no supervisor.
- **Version drift.** The pins (SDK 0.3.287, CLI 2.1.287, codex 0.160.1) will lag the installed tools. The code reports drift and falls back by checking capabilities, but behaviour on new versions is not guaranteed.

## Implications for Orchestra

1. **Adopt `AgentSession`, `AgentEvent` and `SessionCapabilities` as the "musician" contract.** Vendor `src/agent` and `src/backends/{shared,claude,codex}` under MIT rather than reinventing transports. Use stdio JSON-RPC to `codex app-server` and the streaming-input `query()` of the Claude Agent SDK, not `exec --json` or `-p`.
2. **Run the backends in a long-lived Orchestra daemon, without the one-backend-per-process limit.** Use one Codex hub per settings fingerprint (it already serves many threads) and one Claude `query()` per session. Reach DSH either via `@deepseek-ai/dsh/profile-boot` or by attaching to a running dsh-tui. This also fixes "sessions die when the TUI exits".
3. **Build attention management on `status: requires-action` plus `permission.request`, `question.request` and `turn.end`.** Use one cross-harness vocabulary, `idle|working|blocked|done|error` (the OSC 7501 and Herdr states). Consider Herdr (installed locally) as the pane and notification substrate: `herdr agent wait/prompt/read` and `report-agent`.
4. **Implement A2A and AutoRoute at the session level, not the subagent level.** Deliver a message with `submit(input, 'steer'|'followup'|'now')` into the target session. Label it with the existing `user.message{source:'team-message', sender}` and the DSH 0.2.1 relay framing (`Team message from <name>:`). For routing, use `detect()` (installed, auth, drift), `models.list()`, `effort.levels()`, the presence of capabilities, and the user's dsh-adaptive-router evidence.
5. **Use `{backendId, sessionId}` refs as global identity.** Create Claude sessions with an explicit `sessionId`. Respect `~/.dsh-tui/session-mounts.json` before driving any session, and never drive one that a dsh-tui process or another `claude`/`codex` process holds. Prefer that Orchestra creates and owns the sessions it conducts.
6. **Federate existing dsh-tui windows instead of replacing them.** Discover them via `servers.json` and session-mounts. Push work through the inject pipe (`prompt.append` then `prompt.submit`, with Orchestra-side authorization and confirmation). Read progress from the durable logs: DSH session logs, `~/.claude/projects/*.jsonl` and `$CODEX_HOME` rollouts. Reuse the `migrate/parse` parsers for summaries and handoff.
7. **Gate backends on version contracts.** Upgrade codex to at least 0.144 (0.160.x is validated) and pin the Claude SDK at 0.3.287 before relying on these backends. Treat Codex as unverified until a cheap guarded live run passes.
8. **Treat DSH Agent Teams as an optional "section" inside one DSH root, not the cross-harness orchestration model.** Teams are profile-scoped and single-process, and Orchestra's conductor has to sit above all three harnesses.