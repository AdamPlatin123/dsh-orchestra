
## Facts

**Versions and data locations**
- Local Claude Code is 2.1.310 and local Codex CLI is 0.139.0 (`claude --version`, `codex --version`). The Codex Desktop app wrote rollouts stamped `cli_version: 0.160.0` (`session_meta` in `~/.codex/sessions/2026/10/09/rollout-…jsonl.zst`). dsh-TUI's generated Codex bindings come from 0.160.1 (`G:\_Projects\dsh-TUI\src\backends\codex\protocol\generated\README.md:3`). So at least two Codex protocol versions are on this machine.
- Claude data does not live in `~/.claude`. That folder holds only `backups/`, `sessions/` (empty) and `settings.json`. The env has `CLAUDE_CONFIG_DIR=C:\Users\Calx\.rec\claude\accounts\53087\config`, which holds `projects/`, `sessions/`, `session-env/`, `file-history/` and the rest.

**Claude Code on disk**
- Transcripts live at `<config>/projects/<cwd-slug>/<sessionId>.jsonl`.
  - Record `type`s: `user`, `assistant`, `attachment`, `system`, `queue-operation`, `last-prompt`, `custom-title`, `agent-name`, `file-history-snapshot/-delta`, `api-request*`.
  - Common fields: `uuid`, `parentUuid`, `sessionId`, `cwd`, `gitBranch`, `isSidechain`, `permissionMode`, `entrypoint`, `version`, `timestamp`.
  - `assistant.message.usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, `speed`. There is no USD field.
  - Source: `…/projects/G---Projects-dsh-TUI/591a3117-….jsonl`, field names only.
- Subagent transcripts: `<sessionId>/subagents/[workflows/wf_*/]agent-<id>.jsonl`, plus `.meta.json` with `agentType`, `description`, `workflowPhase`, `spawnDepth`, `requestNonInteractive` (`…/G---Projects-dsh-orchestra/9a172ed9-…/subagents/`).
- Live-session registry: `<config>/sessions/<pid>.json` with `pid`, `sessionId`, `cwd`, `kind`, `entrypoint`, `status` (busy/idle), `name`, `messagingSocketPath` (`\\.\pipe\LOCAL\cc-msg-<hex>`), `peerProtocol: 1`, `peerFeatures: [notify_idle, artifact_yield]`. This format is undocumented (inferred: internal).

**Claude Code CLI and docs**
- CLI flags (`claude --help`):
  - Headless: `-p`, `--output-format stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--include-hook-events`, `--forward-subagent-text`, `--replay-user-messages`
  - Sessions: `--resume`, `--session-id <uuid>`, `--fork-session`
  - Permissions and limits: `--permission-mode`, `--permission-prompts host|none`, `--max-budget-usd`, `--json-schema`
  - Other: `-w/--worktree`, `--bg`, `--bare`, `--remote-control`
  - Subcommands: `agents --json`, `attach`, `logs`, `stop`, `rm`, `respawn`, `mcp serve`
- Stream behaviour (https://code.claude.com/docs/en/headless):
  - `system/init` carries a `capabilities` array (e.g. `interrupt_receipt_v1`).
  - Subagent messages carry `parent_tool_use_id`.
  - The `result` event carries `total_cost_usd`, which is a client-side estimate.
  - SIGINT or SDK `interrupt()` ends the turn. SIGTERM leaves it unfinished (exit 143).
  - `--resume` finds a session ID in any project.
- Agent SDK (TypeScript) (https://code.claude.com/docs/en/agent-sdk/typescript):
  - Entry point `query()` returns a `Query` with `interrupt()`, `streamInput()`, `setPermissionMode()`, `setModel()`, `stopTask()` and `close()`.
  - Session functions: `listSessions`, `getSessionMessages`, `forkSession`.
  - Approval callback `canUseTool` returns `{behavior: allow|deny}`. Returning nothing blocks forever, because prompts never time out.
  - `SDKResultMessage` has `total_cost_usd`, `usage` (main loop only) and `modelUsage` (includes subagents).
  - Subagent messages: `SDKTaskStarted`, `SDKTaskProgress`, `SDKTaskNotification`.
- dsh-TUI already drives Claude through `@anthropic-ai/claude-agent-sdk` 0.3.287 (`G:\_Projects\dsh-TUI\package.json`; `src/backends/claude/contract.ts:25`).
- Hooks (https://code.claude.com/docs/en/hooks):
  - About 33 events, including `SessionStart/End`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart/Stop`, `Stop`, `StopFailure`, `Notification`, `TeammateIdle`, `TaskCreated/Completed`, `WorktreeCreate/Remove`, `PreCompact`.
  - Handler types: `command`, `http` (POST), `mcp_tool`, `prompt`, `agent`.
  - Every event's input includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
- Agent teams are experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) (https://code.claude.com/docs/en/agent-teams).
  - Storage: mailbox `~/.claude/teams/{team}/inboxes/{agent}.json`, tasks `~/.claude/tasks/{team}/`.
  - They need an interactive session (not `-p` or the SDK), cannot be nested, and in-process teammates are not restored on resume. Split panes are not supported in Windows Terminal.
- Cross-session messaging (https://code.claude.com/docs/en/cross-session-messaging):
  - Uses a named pipe per session on Windows.
  - Bound for `-p` sessions too, but not under `--bare`.
  - Windows requires a first line `{"type":"auth","token":$CLAUDE_CODE_MESSAGING_TOKEN}`.
  - Plain text only. Inbound policy is `crossSessionInbound` = accept/hold/refuse.
  - A message never counts as consent.

**Codex app-server and CLI**
- `codex app-server` transports: `--listen stdio://|unix://|ws://`. Also `daemon start|stop|version`, `proxy --sock`, `generate-ts/-json-schema`, `codex remote-control`, and `codex --remote ws://…` to point the TUI at a server (`codex app-server --help`).
- Methods, from the generated bindings (`…/protocol/generated/ClientRequest.ts`, `ServerRequest.ts`, `ServerNotification.ts`):
  - Client requests: `thread/start|resume|fork|list|read|turns/list|items/list|search`, `thread/queue/*`, `turn/start`, `turn/steer` (needs `expectedTurnId`, `v2/TurnSteerParams.ts`), `turn/interrupt {threadId, turnId}`, `review/start`, `project/*`, `threadSection/*`.
  - Server requests (approvals): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`.
  - Notifications: `item/started|completed`, `item/agentMessage/delta`, `turn/started|completed`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated {total,last,modelContextWindow}`, `account/rateLimits/updated`, `hook/started|completed`, `serverRequest/resolved`.
- Approval decisions: `accept | acceptForSession | decline | cancel`, plus execpolicy and network amendments (`v2/CommandExecutionApprovalDecision.ts`).
- Subagents:
  - `ThreadItem` includes `collabAgentToolCall` and `subAgentActivity`.
  - `CollabAgentTool` values: `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`.
  - `CollabAgentStatus` values: `pendingInit`, `running`, `completed`, `errored`, …
  - Source: `v2/ThreadItem.ts`, `v2/CollabAgentTool.ts`.
- Worktrees: no worktree field anywhere in the v2 bindings (grep). Worktrees are a Codex app feature (`$CODEX_HOME/worktrees`, handoff) with open bugs (https://developers.openai.com/codex/app/worktrees; openai/codex #21432, #27584, #34238).
- `codex exec`: `--json` prints JSONL, plus `exec resume <id|--last>`, `--ephemeral`, `--output-schema`, `-o`, `-C` (`codex exec --help`). Events are `thread.started`, `turn.started|completed|failed` (usage is on `turn.completed`), `item.started|updated|completed`. Field names have drifted between versions (`item_type` vs `type`) (https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/).
- `codex mcp-server` exposes the tools `codex` and `codex-reply {threadId}` (https://techdevnotes.com/releases/codex-cli/0.152.0/content/docs/codex-rs/codex_mcp_interface.md).

**Codex on disk**
- All 257 rollouts are zstd files: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`.
  - Record types: `session_meta`, `turn_context`, `response_item`, `event_msg` (`item_completed`, `token_count`, `task_started/complete`), `token_usage_record`, `world_state`.
  - `CommandExecution` items have `command`, `cwd`, `exit_code`, `duration`.
- `~/.codex/state_5.sqlite` (read-only query):
  - `threads` has `id`, `rollout_path`, `cwd`, `title`, `source`, `tokens_used`, `git_branch`, `agent_nickname`, `agent_role`, `project_id`, `is_pinned`.
  - Other tables: `thread_spawn_edges(parent_thread_id, child_thread_id, status)`, `projects`, `project_roots`, `thread_read_receipts`.
  - Contents: 263 threads and 18 spawn edges. Sources are cli, exec and vscode, plus subagent threads (their `source` is JSON).

**Cross-agent protocols**
- ACP (https://agentclientprotocol.com/protocol/overview, …/prompt-turn):
  - Methods: `initialize`, `session/new|load|prompt|set_mode|set_config_option`, `session/cancel`. Capability-gated: `session/list|resume|close`.
  - Agent-to-client requests: `session/request_permission`, `fs/*`, `terminal/*`.
  - `session/update` kinds: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `session_info_update`, …
  - Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- Who speaks ACP: Claude through the adapter `claude-agent-acp`, Codex through `codex-acp` (https://agentclientprotocol.com/overview/agents). `codex-acp` has moved to `@agentclientprotocol/codex-acp`, which is built on the app-server (https://github.com/zed-industries/codex-acp). Neither CLI has a native ACP flag (`codex --help | grep acp` is empty).
- DSH ships `@deepseek-ai/dsh-acp`, described as an "Automation-only Agent Client Protocol server for driving DeepSeek Harness agents over JSON-RPC stdio" (`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-acp\package.json`).
  - It uses `@agentclientprotocol/sdk` 1.4.0 and emits `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `usage_update`, `config_option_update`.
  - It advertises list/resume/close and calls `requestPermission` (`lib/index.js:1142,1176`).
  - How to launch it was not verified (inferred: an ACP profile via `dsh-acp-app`).
- hermes-agent has `acp_adapter/` (server, session, events, permissions) and `acp_registry/agent.json` (`G:\_Projects\hermes-agent`).
- A2A 1.0 (https://a2a-protocol.org/latest/specification/):
  - Bindings: JSON-RPC, gRPC and HTTP+JSON.
  - Methods: `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, push-config CRUD.
  - Agent card at `/.well-known/agent-card.json`.
  - Task states: SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, CANCELED, FAILED, REJECTED. Events: `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`. `contextId` groups tasks into a conversation.
  - Governance: Linux Foundation; the AAIF move (inferred, secondary source).

## Integration surfaces / reusable pieces

**Comparison matrix**

| | Claude Code (Agent SDK / `-p` stream-json) | Codex app-server (JSON-RPC) | Codex `exec --json` / `mcp-server` | DSH (`dsh-acp`) |
|---|---|---|---|---|
| Spawn / resume | `query({resume, sessionId, forkSession})`; `--bg` with `agents --json`/`attach`; `listSessions` | `thread/start/resume/fork/list`; one daemon serves many threads | `exec`, `exec resume <id>`; `codex`/`codex-reply` | `session/new/load/resume/list` |
| Stream events | NDJSON: `system/init`, `assistant`, `user`, `stream_event`, `result`, `hook_*`, `api_retry`; 39 SDK message types | `item/*`, `item/agentMessage/delta`, `turn/*`, diff and plan updates | `thread.*`, `turn.*`, `item.*`; MCP result only | `session/update` |
| Follow-up mid-run | `streamInput` (queued); cross-session pipe (plain text, read between tool calls) | `turn/steer` (`expectedTurnId`); `thread/queue/*` | No (inferred) | `session/prompt` after the turn ends (inferred) |
| Interrupt | `interrupt()` (receipt) or SIGINT | `turn/interrupt` | Kill the process | `session/cancel` |
| Approvals | `canUseTool`; `--permission-prompt-tool`; `PermissionRequest` http hook | Server requests `…/requestApproval` | Policy flags only | `session/request_permission` |
| Subagent visibility | `parent_tool_use_id`, `--forward-subagent-text`, `SDKTask*`, `subagents/*.jsonl`, `SubagentStart/Stop` | `collabAgentToolCall`, `subAgentActivity`, `thread_spawn_edges` | Weak (inferred) | Unknown |
| Tokens / cost | `total_cost_usd` and `modelUsage` (estimates) | `thread/tokenUsage/updated`, rate limits; no USD | `turn.completed.usage` | `usage_update` |
| Worktree | `-w`, `WorktreeCreate/Remove` hooks | Not in protocol; pass `cwd` | `-C` | `cwd` (inferred) |

- **Reuse from dsh-TUI.** It already has typed Codex bindings with a `PROTOCOL_DIGEST` contract check (`src/backends/codex/contract.ts`), defensive parsing (`narrow.ts`), and a Claude SDK backend with SendMessage delivery-state parsing (`src/backends/claude/send-message.ts`).
- **Passive observation without owning the process:**
  - Watch `<CLAUDE_CONFIG_DIR>/sessions/*.json` for busy/idle status.
  - Tail `projects/**/*.jsonl` for Claude transcripts.
  - Read `state_5.sqlite` read-only, plus the zstd rollouts, for Codex.
  - Use `claude agents --json` and `codex app-server daemon version`.
- **Hooks as a telemetry bus.** HTTP hooks can POST every Claude lifecycle event to a local Orchestra endpoint. Codex has `hooks/list` and the `hook/*` notifications.
- **MCP as the tool plane.** Orchestra can expose its own MCP server ("conductor" tools such as post-to-section, claim-task, ask-human) to every harness. `codex mcp-server` and `claude mcp serve` also let one harness call another as a tool.

## Gaps & risks

- **Undocumented Claude internals.** The registry and pipe format (`peerProtocol 1`) is not documented. The messaging token is only exported to the session's own child processes, so Orchestra probably cannot post into a Claude session it did not launch on Windows (inferred).
- **Protocol churn.** Codex app-server is marked `[experimental]` and its ws transport is "unsupported". This machine has a 0.139 CLI next to 0.160 Desktop and bindings. The `exec --json` field names have drifted.
- **Gaps in ACP.** It has no steer verb, no standard subagent tree and no USD cost. The Claude and Codex adapters are third-party and lose fidelity (inferred). ACP's `session/list` and `session/resume` are optional capabilities.
- **A2A is too coarse for coding.** It has no tool-call stream and no granular permission request; INPUT_REQUIRED is the closest thing to an approval.
- **Security:**
  - `-p` without `--bare` runs project hooks and `.mcp.json` servers in untrusted folders without a trust dialog.
  - The bypass flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) would multiply across N agents.
  - Agent-to-agent relays must never carry approvals; Claude's own docs enforce this.
  - Claude permission prompts never time out, so a dead UI leaves the agent hung.
- **Cost accounting.** Claude USD figures are estimates, and `usage` excludes subagents. Codex reports tokens only, under a subscription and a custom `model_provider`.
- **Fragile features.** Agent teams are experimental and interactive-only. Codex worktrees have handoff and setup bugs. Rollouts are compressed and paginated, which makes tailing them harder.
- **Several Claude data roots.** Account-scoped `CLAUDE_CONFIG_DIR` means discovery has to enumerate more than one root.

## Implications for Orchestra

1. **Make ACP the internal normalization layer, extended.** Model every musician as an ACP session: `session/prompt`, `session/update`, `request_permission`, `cancel`, `list/resume`. Add Orchestra `_meta` extensions for `steer`, the subagent tree (`parentSessionId`/`parentToolUseId`), `usage` with estimated USD, and `worktree`. Reasons:
   - DSH speaks ACP natively.
   - Claude and Codex have maintained adapters.
   - Hermes, Gemini, OpenCode and Goose plug in for free.
   - Its vocabulary matches coding turns and approvals.
   - A2A is for discovery between agents and is too coarse inside the panel.
2. **Use native drivers for the two richest harnesses rather than their ACP adapters.** Drive Claude with the Agent SDK, reusing dsh-TUI's backend, and Codex through app-server on one shared daemon with many threads. Use the generic ACP driver for DSH and everything else. Translate each into the ACP-shaped event model at the edge.
3. **Expose A2A only at the boundary.** Give each persistent "bot" an agent card, map tasks to turns, `contextId` to session, and SubscribeToTask to the event stream. Internal messaging between agents should run on Orchestra's own bus, delivered by:
   - Claude: `streamInput`
   - Codex: `turn/steer` or `turn/start`
   - DSH: `session/prompt`
   - Unowned Claude sessions: the cross-session pipe, plain text only
4. **One central approval and attention queue.** Feed every permission request into it: `canUseTool`, `PermissionRequest` http hooks, Codex `requestApproval`, ACP `request_permission`. Enforce a timeout-to-deny policy, never accept approvals relayed by another agent, and rank the queue by project so the conductor sees one inbox.
5. **Observe in two tiers.** Owned sessions get the full live stream. For unowned sessions, read-only watchers on the Claude registry and transcripts and on the Codex sqlite and rollouts give status, title, tokens and spawn edges across all projects. This is the cheapest way to reduce context switching.
6. **Orchestra owns worktrees.** Create one `git worktree` per musician and pass it as `cwd` to all harnesses. Don't rely on Codex's app-only worktrees; Claude's `-w` is optional.
7. **Pin versions and feature-detect.** Pin each harness binary per driver and copy dsh-TUI's `PROTOCOL_DIGEST` contract tests. Feature-detect through Claude's `system/init.capabilities`, Codex `initialize` capabilities and ACP `agentCapabilities`.
8. **Normalize cost to tokens.** Compute USD from a price table, feeding the dsh-tonghuashun ledger. Treat Claude's `total_cost_usd` as advisory, and use `modelUsage` so subagents are counted.