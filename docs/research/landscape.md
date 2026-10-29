## Facts

**DSH community items**
- **DSH-better-sidebar (BSB):** a single npm package with a host half and a client half. Other plugins can add to it through `ctx.betterSidebar.registerTab` / `registerFileViewer`, which is the "plugins of plugins" idea; the README lists 28 third-party tab plugins. Its Tasks page shows a live subagent topology (graph or tree) and a list of background jobs with exit codes and force-kill. Side Chat is beta. v0.28.1 requires DSH ≥0.2.1-rc.1. Since v0.23.0 the fs routes have no workspace-containment check. (github.com/omdsh-dev/DSH-better-sidebar README.) Version 0.26.1 is installed locally at `C:\Users\Calx\.dsh\profiles\web\node_modules\.pnpm\dsh-better-sidebar@0.26.1_*\node_modules\dsh-better-sidebar\package.json`.
- **"Claim task to current agent"** is BSB's Teams block, built on DSH's experimental agent-team service.
  - Write routes are `teams.taskCreate` / `teams.taskUpdate`. The CAS actions are `claim, release, edit, set_dependencies, complete, reopen, reassign, delete`. A `TEAM_TASK_STALE_REVISION` error maps to 409.
  - The read path comes from the `agentTeam` projection in `SessionListState.projectionsBySession`.
  - These routes exist only when `dsh-experimental-agent-team` (`ctx.agentTeams`) is mounted (`...\src\team-routes.ts:1-37,58-60`).
  - The topology view comes from `ctx.get('subagents')`'s `listDescendants` (`src\subagent-live-route.ts:2-19`).
- **dsh-apollo:** a bundle of skills (`/brainstorming`, and `/exec`, which runs dependency waves as worktree → parallel → review → merge), the `eng` / `eng-noask` presets, an exit guard, Codex/Claude CLI background tasks, and `dsh-better-goal`. It has 5 stars and 15 commits, is GPL-3.0, and requires DSH `>=0.2.1-rc.2 <0.3.0` (github.com/Menghuan1918/dsh-apollo).
- **dsh-apollo `wait_subagent`** (`presets/eng/plugins/wait-subagent/index.js`):
  - Parameters are `subagent_id[]` and an optional shared `timeout_ms`.
  - It checks the ids against `ctx.subagents.listChildren`, then waits on the `subagent/end` event, with a 30 s start grace that polls `ctx.agents.get`.
  - It returns one status per id: settled, timedOut, aborted or notStarted. The child's final text arrives as a separate settlement notice, not in the tool result.
  - An earlier design read `agent.inbox`; it broke when upstream removed `subagent-report` in 0.1.2-alpha.4.
- **dsh-apollo's Codex driver** (`src/cli/codex.js`) runs `codex … -a never exec [resume <id>] --json --skip-git-repo-check -`. It parses `thread.started`, `item.completed`, `turn.completed` and `turn.failed`; only `turn.completed` counts as success.
- **dsh-context** (github.com/bowenliang123/dsh-context, about 3.6k stars):
  - Views: a Context Insights page, a per-session Context tab, a Fleet tab, and a `/context` command. The Fleet tab shows parents and subagents, team relays, mailbox deliveries and a message timeline.
  - Data comes from V4 session logs and the `contextPressure` / `contextBreakdown` projections; prices come from models.dev.
  - Per-category token counts are heuristic, some Fleet surfaces are placeholders, and it only supports DSH 0.2.0-rc.2 through the 0.2.1 line.
- **Other DSH plugins:** the awesome list (github.com/0xsline/awesome-deepseek-harness) includes dsh-team-rooms (message bus, shared board, approval-gated handoffs), dsh-collaboration (`team_call/team_message/team_status`), dsh-routed-subagent (external codex/claude engines), dsh-taskswarm (worktree lanes) and dsh-session-search (indexes DSH, Codex and Claude sessions). @loongsuite/dsh-plugin exports traces over OTLP (signoz.io/docs/deepseek-harness-observability).

**Harness-native multi-session features**
- **Claude Code agent teams** (code.claude.com/docs/en/agent-teams):
  - Opt-in via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
  - Tasks are pending, in progress or completed, can have dependencies, and are claimed under a file lock.
  - Mailboxes live at `~/.claude/teams/{team}/inboxes/{agent}.json` and tasks at `~/.claude/tasks/{team}/`.
  - Hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted` (exit 2 blocks).
  - Limits: one team per session, no nested teams, in-process teammates are not restored on resume, and task status can lag. Split panes don't work in Windows Terminal.
- **Claude agent view** (code.claude.com/docs/en/agent-view):
  - `claude agents` groups sessions into Pinned, Ready for review, Needs input, Working and Completed. Space peeks at a session without attaching.
  - `claude --bg` puts each dispatched session in its own worktree under `.claude/worktrees/`.
  - The `Notification` hook fires `agent_needs_input` / `agent_completed`.
  - Scripts poll `claude agents --json --all` for `state`, `status` and `waitingFor`. The local v2.1.310 `--help` confirms `--json`.
- **Claude cross-session messaging** (code.claude.com/docs/en/cross-session-messaging):
  - Tools are `ListAgents` and `SendMessage`. Each session has its own socket, which is a named pipe on Windows.
  - `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` are exported to the session; on native Windows the auth line is required.
  - `crossSessionInbound` can be accept, hold or refuse. `notify_when_idle` subscribes to another session going idle.
  - Messages are plain text only and capped at about 1M characters; at most 50 are queued and loops are throttled. An incoming message can never approve anything or change config.
- **Claude Desktop** (code.claude.com/docs/en/desktop): a per-session Worktree toggle, split view, and an OS notification when a session finishes while you aren't viewing it. The PR card shows CI status with Auto-fix and "Merge when ready" (squash via `gh`), and sessions can auto-archive after merge.
- **Codex app** (learn.chatgpt.com/docs/app): projects and chats, Local/Worktree/Cloud modes, Scheduled tasks, Notifications and App Server; it runs on Windows. Locally, codex-cli 0.139.0 has `app-server {daemon,proxy,generate-ts,generate-json-schema}`, `remote-control`, `mcp-server`, `cloud`, `fork` and `archive` (verified with `codex --help`).

**Third-party orchestrators**
- **Conductor:**
  - Isolation: one git worktree per workspace, branched from `origin/main`. Its docs say "Workspace isolation is development isolation, not a security boundary." It exposes `CONDUCTOR_PORT` and keeps notes and handoffs in a `.context` folder. Flow: diff → PR → merge → archive (conductor.build/docs/concepts/workspaces-and-branches).
  - REST API at `api.conductor.build/v0`: create a workspace, post messages, read session status (`idle/working/errored`) and workspace lifecycle (`initializing/ready/sleeping/archived`), and search transcripts with `POST /v0/sql`. Status is polled; there are no outbound events (conductor.build/docs/api).
- **Claude Squad:** tmux plus a worktree per session; `-y` auto-accepts prompts; `c` commits and pauses, `s` pushes. No cost tracking (github.com/smtg-ai/claude-squad).
- **Vibe Kanban:** kanban issues become workspaces with a branch, terminal and dev server, across about 10 agent CLIs. Inline diff comments go back to the agent. The company shut down on 2026-04-10 ("couldn't find a business model") and the project is now community-maintained (vibekanban.com/blog/shutdown, via search).
- **Crystal:** parallel worktree sessions for Codex and Claude; deprecated in Feb 2026 in favour of Nimbalyst (github.com/stravu/crystal).
- **Sculptor (Imbue):**
  - Isolation: a Docker container per agent. Pairing Mode syncs the agent's code into your IDE in both directions.
  - HN complaints: high idle CPU and memory, containers and databases too heavy for a laptop, doubts about the cognitive load of parallel agents, and Claude-only support (imbue.com/sculptor; hn.svelte.dev/item/45427697).
- **Omnara:** wraps Claude Code, parses the session file and terminal output, streams to web and mobile over SSE, and sends a push when an agent needs input (hn.svelte.dev/item/44878650).
- **opcode (formerly Claudia):** a Tauri GUI with a cost/token dashboard broken down by model, project and time, plus a checkpoint timeline with fork (third-party, search).
- **Terragon:** a cloud sandbox per task that ends in a PR. The site is now titled "Terragon Shutdown" (terragonlabs.com).
- **herdr:**
  - States: working, blocked, idle, done and unknown, detected by matching the screen. Its socket API offers `agent.list/wait/prompt`.
  - Pain points: Codex shows as `unknown`, dev-server port collisions, about 10× quota burn with 10 agents, and review as the bottleneck (developertoolkit.ai/en/ecosystem/agent-tools/parallel-agents/).
  - dsh-TUI already reports its own state to herdr: `herdr pane report-agent <pane> --source custom:dsh-tui --state idle|working|blocked --seq` (`G:\_Projects\dsh-TUI\src\herdr.ts:116-124`).
- **Cursor 3 Agents Window:** parallel agents across local, worktree, cloud and SSH, shown in a grid, with handoff to the cloud. Forum reports include "Parallel agents writes to the root repository instead of the worktree" (forum.cursor.com, third-party).
- **Devin:** a coordinator runs child Devins, each in its own VM, monitors their ACU spend, and can sleep or terminate them (cognition.com/blog/devin-can-now-manage-devins). An ACU overrun example in the docs: 42 used against 12 expected.
- **Jules:** a cloud VM per task, a plan you approve, then a PR. Concurrency tiers conflict across sources (inferred).
- **OpenHands:** Docker runtime by default, with a remote runtime for running many conversations in parallel (docs.all-hands.dev).
- **Kiro:** specs (requirements, design, tasks), hooks that act as background agents on events, and checkpoints (third-party, inferred).

**Workflow graphs**
- **n8n IF node:** one AND/OR setting applies to the whole node; use Switch for more than two outputs and a Merge node to rejoin (docs.n8n.io).
- **Dify:** IF/ELIF/ELSE with AND/OR. The Variable Aggregator joins only exclusive branches, not parallel ones (docs.dify.ai variable-aggregator).
- **CrewAI Flows:** `and_()` waits for all listed methods and `or_()` for any; `@router` returns labels, `@persist` uses SQLite, and `flow.plot()` draws the graph (docs.crewai.com/en/concepts/flows).
- **Mastra:** `.then/.parallel/.branch` plus suspend/resume snapshots (mastra.ai).
- **LangGraph Studio:** breakpoints, state editing, time travel and threads (docs.langchain.com/langsmith/studio).
- **AutoGen Studio:** drag-and-drop team builder over a JSON spec with a message-flow graph; its own docs call it "not meant to be a production-ready app".

**Observability**
- **Langfuse:** an agent graph inferred from observation types and timing, with Aggregated and Expanded modes, plus per-call cost (langfuse.com/docs/observability/features/agent-graphs).
- **AgentOps:** waterfall view, replay and cost tracking (secondhand, ag2 docs).
- **OTel GenAI:** the conventions moved to github.com/open-telemetry/semantic-conventions-genai.
  - Spans: `invoke_agent {gen_ai.agent.name}` (CLIENT or INTERNAL), `invoke_workflow {gen_ai.workflow.name}` (INTERNAL), `create_agent` and `execute_tool`.
  - `gen_ai.conversation.id` is Conditionally Required and the `gen_ai.usage.*_tokens` attributes are Recommended. All of it is still "Development".
  - `gen_ai.agent.id` should be stable; the spec advises against using in-memory instance ids.

## Integration surfaces / reusable pieces
- **DSH (plugin-side):** the `subagent/end` event, `ctx.subagents.listChildren/listDescendants`, `ctx.agents.get`, the `ctx.agentTeams` CAS task board and `projectionsBySession`, and dsh-context's `contextPressure/contextBreakdown`. Orchestra could live inside DSH web as a BSB `registerTab`, and a local DSH OTLP export already exists.
- **Claude Code:**
  - `claude agents --json --all`, `claude --bg --name`, and `claude attach|logs|stop|respawn|rm`.
  - The `Notification` hook types `agent_needs_input` / `agent_completed`, and the `TeammateIdle/TaskCompleted` hooks.
  - The inbox named pipe with its token auth line. Orchestra should only post to it as a session's own child, through a hook, because any other sender passes through `crossSessionInbound`.
  - Team task files under `~/.claude/tasks/{team}/`, to read only.
- **Codex:**
  - `codex app-server` with `generate-json-schema` / `generate-ts`, which gives a typed protocol.
  - The `exec --json` JSONL stream, `exec resume <thread_id>`, and `-a never -s workspace-write`.
  - `codex mcp-server`, which lets the conductor call Codex as a tool.
- **Cross-tool:**
  - herdr's `report-agent` gives a ready-made state vocabulary, and dsh-TUI already emits it.
  - Conductor's REST resource model (projects → workspaces → sessions → messages/status) is a useful template for an API.
  - OTel GenAI spans can carry traces into Langfuse.
  - dsh-session-search already indexes all three harnesses.

## Gaps & risks
- **No shared state model across harnesses.** Tools that read the screen get state wrong: herdr shows Codex as `unknown` and treats unfamiliar prompts as idle.
- **Most pieces are experimental.** Claude agent teams are experimental and agent view is a research preview. DSH is a developer preview and its agent-team service is experimental. Codex app-server is experimental, and OTel GenAI is still "Development". dsh-apollo has already been broken once by a DSH internal change.
- **Review is the real bottleneck.** The cited Faros report says PR review time rose about 91% (secondhand). Parallelism without a gated review queue makes the overload worse, and Sculptor's HN thread raises the same cognitive-load doubt.
- **Isolation is not security.**
  - Worktrees are not a sandbox (Conductor says so itself).
  - BSB's fs routes are unfenced.
  - autoyes and bypass modes carry over to all teammates.
  - Agent-to-agent messages can carry prompt injection. Only Claude explicitly treats them as untrusted; whether DSH and Codex do is unknown (inferred).
- **Cost.** Usage scales roughly linearly with the number of agents, and Devin's ACU spend varies a lot from estimates. Only dsh-context, opcode and Langfuse attribute cost per session, and DeepSeek's peak-hour rate is 2×.
- **Vendor churn.** Vibe Kanban, Crystal and Terragon all shut down or were deprecated in 2026.
- **Windows.** tmux-based tools and Claude's split panes don't work well on Windows, and Conductor is Mac-first.
- **Still unsolved:** merge conflicts across worktrees, dev-server port collisions, about 0.5–1 GB of disk per worktree, and agents that edit the root repo instead of their worktree.

## Implications for Orchestra
1. **Build one adapter layer with a normalized state machine:** working, needs-input, blocked, idle, ready-for-review, done, failed, stopped. Feed it only from native signals: Claude hooks and `agents --json`, Codex app-server and JSONL events, and DSH `subagent/end` plus session projections. Accept herdr-style self-reports as a fallback and never scrape screens.
2. **Make an attention inbox the home screen, not a grid of terminals.** Group across all projects by state, as agent view does (Needs input → Ready for review → Working), with project as the second axis. Add peek-and-reply, one notification channel, and a dispatch cap that stops new work while the review queue is full.
3. **Make the task board the A2A substrate.** Mirror DSH agentTeams' CAS semantics (claim, release, set_dependencies, complete, plus a stale-revision error) across harnesses, so AutoRoute assigns work by claiming tasks rather than by chatting.
4. **Give the conductor explicit join semantics:** `and_`/`or_` (CrewAI), plus `wait_subagent` with a shared timeout and a status per id, plus `notify_when_idle`. Don't copy Dify's aggregator, which can't merge parallel branches.
5. **Isolate each task in a worktree by default**, with its own port (`CONDUCTOR_PORT` style) and a `.context` handoff folder. Offer a container tier for unattended or autonomous agents, and label clearly that a worktree is not a sandbox.
6. **Treat A2A messages as untrusted.** Tag each one with its origin, never let one approve an action or change config, and rate-limit and de-duplicate them (Claude's rules).
7. **Emit OTel GenAI spans** with `conversation.id` set to the session and a stable `agent.id`, and show a Langfuse-style graph that switches between Aggregated and Expanded views. Keep a per-agent cost ledger that feeds dsh-tonghuashun.
8. **Build on harness primitives and ship inside DSH as a BSB tab, plus a standalone app.** Don't depend on third-party orchestrators, and pin harness versions.

**10 most transferable patterns**
1. Worktree per task, with an auto-named branch and archive on merge (Conductor, Claude, Codex).
2. A dashboard grouped by state across projects (agent view, herdr).
3. Push notifications when an agent needs input, on desktop and mobile (Omnara, `Notification` hook).
4. Peek at and reply to a session without attaching to it (agent view Space).
5. A shared task board with claim, dependencies and CAS (Claude teams, DSH agentTeams).
6. Wait/join primitives that return a status per agent (`wait_subagent`, `notify_when_idle`).
7. Quality-gate hooks that fire on idle or task-complete (exit 2).
8. A PR chip coloured by CI state, with "Merge when ready" and Auto-fix.
9. A checkpoint, fork and time-travel timeline (opcode, LangGraph, `/fork`).
10. A per-agent breakdown of context and cost, plus handoff notes (dsh-context, `.context`).

**5 anti-patterns**
1. Inferring agent state by scraping terminal output.
2. Fanning out without limit, with no caps on review capacity or quota.
3. Treating worktrees or autoyes as a safety boundary.
4. Letting messages between agents carry authority, or letting them loop without throttling.
5. Building on one vendor's orchestrator or on unpinned experimental internals.

Local evidence paths:
- `C:\Users\Calx\.dsh\profiles\web\node_modules\.pnpm\dsh-better-sidebar@0.26.1_i5mvkq3arbbqwn5vjk7hrqlcsa\node_modules\dsh-better-sidebar\src\team-routes.ts`
- `C:\Users\Calx\.dsh\profiles\web\node_modules\.pnpm\dsh-better-sidebar@0.26.1_i5mvkq3arbbqwn5vjk7hrqlcsa\node_modules\dsh-better-sidebar\src\subagent-live-route.ts`
- `G:\_Projects\dsh-TUI\src\herdr.ts`