<!-- Raw researcher report: Opus sweep "grokbot", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into bot-architectures.md; where the two disagree, the synthesized file wins (see its Review log). -->

# grokbot: which project it is, and what Orchestra can take from it

## Identity & scope

**What "Grok Bot" is.** xAI shipped Grok Bot as a beta on 2026-08-11. The launch page describes always-on agents that each have their own cloud computer, a "chief of staff" bot that sits over specialist bots, bots that message each other and work in group chats, saved "routines", and a usage pool separate from Grok and Cursor plans ([x.ai/news/introducing-grok-bot](https://x.ai/news/introducing-grok-bot)). The shipped app is built by Anysphere: its bundle id is `com.anysphere.sand` and it downloads from `downloads.cursor.com/grokbot/...` (GBR `PROVENANCE.md`). I found no official source release of Grok Bot, either in the `xai-org` repo list (`gh api orgs/xai-org/repos`) or on the launch page.

The DSH bot community treats Grok Bot as the product to match:
- DS-Bot's handoff plan copies Grok Bot's waiting animation (`G:\_Projects\DS-Bot\docs\plans\2026-10-16-bot-handoffs.md:48`).
- Tobs (formerly BotHarness/DeepSeekBot) calls itself an "开源的 GrokBot 平替", i.e. an open-source GrokBot replacement (its README).

**Candidates, ranked by how well they fit "grokbot 早期开源出来的代码"**

| # | Repo | Stars / forks | First commit | Lang / license | What it is | Plausibility |
|---|---|---|---|---|---|---|
| 1 | **[b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed)** (GBR) | 3,538 / 3,651 | 2026-08-22 (`bf66838a6`); only 2 commits | TypeScript; **no license** | Readable TypeScript rebuilt from the public **Grok Bot 0.18.0** desktop binary: Electron main, host, coordinator, local-exec, protocol. Adds a router for Cursor, Claude Code, Codex and OpenRouter, plus a local Docker sandbox (README) | **Best guess, ~60%.** It is actual Grok Bot code from an early version (0.18, 11 days after launch) that became public |
| 2 | **[xai-org/grok-build](https://github.com/xai-org/grok-build)** (GB) | 27,552 / 5,198 | 2026-07-16 `c68e39f60` "Publish harness and TUI open-source" | Rust; Apache-2.0 | SpaceXAI's coding-agent harness and TUI, the "grok-build" format that dsh-TUI's migrate adapter reads (`G:\_Projects\dsh-TUI\src\dsh-adapter\migrate\adapters\grok-build.ts:1-9`). 51 commits, all "Synced from monorepo" by `grokkybara[bot]`; the last is 2026-09-29 `2bdd1d6a6`. Syncs from late August added Grok Bot plumbing: the `bot_relay` wire fixtures (first seen `9684fa3cd`, 08-27), the `GROK_BOT_TOOL_IDS` list, and `xai-message-delivery-core` (`bc7f02edd`, 08-28) | **~30%.** This is the code xAI really open-sourced, and it carries Grok Bot's harness protocol |
| 3 | [xai-org/grok-prompts](https://github.com/xai-org/grok-prompts) | 4,547 | 2025-05-15 | Jinja; AGPL-3.0 | Prompts for the `@grok` bot on X | ~5%. It is literally an early open-source "grok bot", but it contains prompts, not architecture |
| 4 | [najmuzzaman-mohammad/gawkbot](https://github.com/najmuzzaman-mohammad/gawkbot) | 1,521 | 2026-03-25 | Go; "Sustainable Use License" (not OSI-approved) | Tagline "open source grok bot". It was renamed from wuphf (`cmd/wuphf`), adopts running Claude Code and Codex sessions (`internal/agentdetect/sessions.go:17-27`), and has a chief-of-staff inbox | ~5%. Only the branding matches |
| 5 | [BotHarness/DeepSeekBot](https://github.com/BotHarness/DeepSeekBot) (Tobs) | 337 | 2026-09-16 | TypeScript; MIT | A second "GrokBot replacement" running as a DSH plugin, separate from DS-Bot (README comparison table) | Not Grok Bot code, but the closest DSH analogue after DS-Bot |

Repos named grokbot/grok-bot that are noise: `zostaff/grokbot-pumpfun`, `ScriptedAlchemy/grok-bot-cli`, and the awesome-lists (`gh search repos grokbot`). I found no Chinese-community project that is itself nicknamed "grokbot". The web search for "grokbot 开源" returned only Grok Build coverage.

**Legal status.** GBR says it grants no license, and it stores the original installers through Git LFS (`NOTICE.md`; `PROVENANCE.md`, "No upstream source-code license is implied"). Treat it as a design reference only. GB is Apache-2.0, so code can be lifted with a NOTICE entry.

I treat GBR as the product/host layer and GB as the harness plus its delivery and workflow cores. The facts below cover both.

## Architecture facts

**Identity model**
- In GBR, a bot is a folder under `<sandRoot>/agents/<agentId>/` (`source/host/storage/agent-paths.ts:2`). It holds:
  - `profile.json` (name, description, title, avatar), written atomically (`agent-profile.ts:6-12,42-47`)
  - `store.db`, `enabled-workflows.json`, `automations/*/automation.json` (`agent-clone.ts:9-11`)
  - `group.json` and `projects.json`
- Cloning a bot copies its store, profile, settings, workflows and routines, then rewrites the identity. Chat history is not carried over (`agent-clone.ts:15-25`).
- Agents can create teammates (`CreateAgent`) and edit them (`UpdateAgent`), but no agent has a delete tool. Only the user can delete a bot (`source/host/agents/agent-messaging.ts:6-8,47`).
- Agents discover each other through files: `<root>/<id>/profile.json` and `group.json` (`agent-messaging.ts:51`).
- GB's delivery core separates two ids (`crates/common/xai-message-delivery-core/src/identity.rs`):
  - `AgentId` is a logical name that survives restarts (`:12-14`).
  - `AttemptId` is one activation; "a resume or fork always mints a new one" (`:58-60`).
  - `next_identity` returns Start, Resume (same agent, new attempt) or Fork (new agent) (`:93-127`).
- An address is not a session id (`address.rs:1`). It is a "server-minted capability for one child generation" (`:7-9`). Resolution returns `Owned{presence}`, `RawSessionId`, `Foreign`, `Stale`, `WorkflowNotAddressable` or `Unresolved` (`:87-130`). Workflow children are never addressable (`:46-64`).

**Session model**
- GB runs one leader process per machine. It owns agent state, speaks ACP internally, and serves TUI, IDE and headless clients over `~/.grok/leader.sock` (`crates/codegen/xai-grok-shell/src/leader/mod.rs:1-33`).
- The leader lock is an `flock` with the PID inside. Crash cleanup differs from handoff, and `GROK_LEADER_SOCKET` sandboxes a second instance (`leader/lock.rs:36-39,106-118`).
- Sessions sync to grok.com over WebSocket. Local disk stays the source of truth, and a `relay_sync.json` cursor lets sync resume after going offline (`relay/mod.rs:1-9`).
- The relay treats a connection as dead after 4× the 15 s keepalive with no inbound frame. Backoff resets only when there is evidence the credential was accepted (`agent/relay.rs:18-22,33-34`).
- The FleetView roster exposes `x.ai/sessions/list` and an `x.ai/sessions/changed {upserted, removed}` broadcast. Its activity states cover a running turn, idle, a pending permission/question/plan, dormant on disk, finished and failed (`agent/roster.rs:1-32`).
- In GBR, each agent's history is unified across its DM and group chats; group turns are tagged `[Group chat: …]` (`agent-messaging.ts:76-77`). A goal is bound to an `agentSessionId` (`packages/agent-core/goal-continuation.ts:9-11`). Each agent's store runs in a `worker_threads` worker: pool of 64, 5-minute idle eviction (`host/agent-isolation/agent-worker-pool.ts:4,259-261`).

**Routing (who answers)**
- 1:1 messages go to an explicit id. `@`-mentions add an address block to the turn's context (`agent-messaging.ts:131-141`).
- Groups (`host/groups/group-chat.ts`, `group-store.ts`):
  - At most 6 members, and a group cannot contain another group (`group-store.ts:1`; `group-chat.ts:5-6`).
  - The responders are the members `@`-mentioned since the user's last message. If nobody is mentioned, or `@everyone`/`@all` is used, every member responds (`:9-10`).
  - The speaking order rotates each round (`:3`).
  - Caps: `GROUP_MAX_ROUNDS=3`, `GROUP_MAX_MEMBER_TURNS=10`, `GROUP_MAX_MESSAGES_PER_TURN=2`, 24 lines of history (`:1`).
  - A member can reply "(pass)" (`:11`).
- Cross-user shared rooms hold `remoteMembers{ownerAuthId, agentId}` (`group-store.ts:1-3`). In those rooms, tool calls stay private scratch work; only `SendMessage` text reaches the room (`group-chat.ts:15`).
- Compared with DS-Bot: DS-Bot's admin answers first, uses `[PASS]`, and caps relays at members×3 (`docs/research/ds-bot.md:43-51`). Grok Bot instead rotates speakers and caps rounds and turns.

**Messaging between agents, and receipts**
- In GBR, `SendToAgent` is asynchronous. It returns an acknowledgement at once, the reply arrives later as a new hidden turn starting with `[agent]`, and the sender is told not to wait or poll (`agent-messaging.ts:4-6,42,46`).
- **There is no auto-reply.** The recipient must call `SendToAgent` back, and is told to stay silent rather than send acknowledgements back and forth (`:46,115`).
- Body cap is 8,000 characters (`:9`).
- Messaging several teammates, or posting to a group, requires an explicit user ask or a confirmation widget. This is a prompt rule only (`:44`).
- "Priority" messages interrupt the recipient's non-user work (`:92-93`). A user broadcast arrives with the `[broadcast]` cue (`:120-129`).
- If a group turn is interrupted by a DM, it is redelivered with a note saying so (`group-chat.ts:12`).
- The only receipt is the "sent to <name>" acknowledgement. GBR shows no read receipts (inferred from `:42`).
- GB's delivery core types the source of every message:
  - `Principal{Human, Agent, Runtime}`, with the source fixed at compile time (`HumanSource` / `AgentSource`).
  - `Operation{Queue, Steer, Interject, InterruptAndSend}`, checked against an `OperationSet` by `authorize_operation` (`envelope.rs:4-18,92,111`).
  - Each delivery goes Pending → Projecting → Delivered. Completion, SoftCancel and Rewind fall back to pending; HardTeardown and ActorDrop do not (`lifecycle.rs:74-104`).
- On the bot-relay wire, `seq` is not a dedupe key, and only an explicit `hub:resync_required` frame counts as a resync (GB `crates/common/xai-tool-protocol/fixtures/bot_relay/README.md`).
- The harness tool ids are `bot_create_agent`, `bot_list_agents`, `bot_send_prompt`, `bot_get_agent_transcript{,_page,_tail,_window}`, `bot_await_turn` and `bot_search_agents` (`crates/common/xai-computer-hub-core/src/bot_tools.rs:9-43`).

**Memory scoping**
- Facts are `profile` or `log`, capped at 500 characters each, with a 30-day decay half-life and an episode summary every 6 turns (`host/runner/sand-memory.ts:5,12,18,21`).
- There are separate user and project prompt limits; at most 3 project facts are injected (`:13-17`).
- The memory prompt is frozen per compaction epoch, which keeps it stable across turns (`:24-38`).
- Each agent records which projects it belongs to (`extensions/memory/project-membership.ts`).
- "Workflows" are `SKILL.md` files in a global library shared by all assistants, with per-agent enablement (`shared/workflow-model.ts:4,33`; `agent-workflow-enablement.ts:1`).

**Scheduling and heartbeats**
- A routine is a saved prompt plus a trigger: cron, or a Slack, GitHub, Teams, Linear, Sentry or PagerDuty listener (`host/automations/automation.ts:19-60`).
- Limits: 50 routines per agent, 20 runs of history, at most 25 events per wake (`:8-13`).
- Event payloads are labelled as data from an outside sender, not instructions (`:99,101-107`).
- The prompt tells agents to default to weekday, waking-hours schedules, to make finite watches expire themselves, and to pause a routine after repeated auth failures. Saving a routine may need user confirmation.
- Each turn gets a fresh routine-status reminder that overrides earlier ones (`automation-status-reminder.ts`).
- In GB, one-shot scheduled tasks are reconciled after restart from a persisted receipt journal, with at most 50 pending (`xai-grok-tools/.../scheduler/occurrence_journal.rs:1-12`). The sandbox is kept awake while a `/loop` is alive, polled every 30 s (`xai-grok-workspace/src/scheduler_liveness.rs:1-15`).

**Budgets and loop caps**
- GBR has the group caps above. Messaging discipline (fan-out, ping-pong) is enforced only through prompts.
- GB workflow limits:
  - Agent-call quota: 128 by default, 1,024 maximum; `MAX_PARALLEL` 1,024; 10,000 host calls (`crates/codegen/xai-workflow/src/lib.rs:10-19`).
  - Rhai `max_ops` 1e8 (`engine.rs:23`).
  - 4 active runs per session (`xai-grok-shell/src/session/workflow/manager.rs:22`).
  - 32 concurrent agents, reduced to the machine's parallelism; wider fan-outs queue in order (`host_service.rs:24-26,75`).
  - Pause kinds include `NoProgress` and `BackOff` (`run.rs:8-14`).

**Isolation and permissions**
- Each Grok Bot works on a remote "box". GBR adds an optional loopback-only Docker box (README).
- Local tool approvals are persisted, with writes serialized per file (`host/local-exec/local-tool-approvals.ts:7-25`).
- GB's leader injects `yoloMode` / `autoMode` into `session/new`, based on what each client declares (`leader/protocol.rs:176-190`).

**Observability UI**
- GBR drives OS notifications and a dock badge from agents events and a roster seed (`electron-main/notifications/agents-control-feed.ts:14-39`).
- GB has the FleetView dashboard (`roster.rs`; user guide `23-dashboard.md`).

## What Orchestra should lift / avoid

**Lift**
1. **Separate identity from each activation.** GB's `AgentId`/`AttemptId` split is the same as Musician/Part (D2), and workflow children being unaddressable matches Clones. Two changes:
   - Add `stale`, `foreign`, `raw-session-id` and `clone-not-addressable` to the Post Office refusal codes.
   - Never accept a harness session id as an A2A address; mint an opaque address per Part instead. The source is Apache-2.0, so it can be ported.
2. **Type the principal and the allowed operations.** Add `principal: human|agent|runtime` to envelope v1 (§8.1) and an operation set per target (`queue|steer|interject|interruptAndSend`) to the §8.2 delivery table. Make "human" impossible to construct in agent-facing code. This strengthens D8.
3. **Reuse the delivery lifecycle.** Pending/Projecting/Delivered, with terminal causes that fall back, maps directly onto the §8.3 restart table: rewind or soft-cancel returns the message to queued, hard teardown makes it `unknown`. Borrow the names.
4. **Make silence a valid answer.** Keep DS-Bot-style auto-reply for `role=request` (§8.3 rule 1). For `role=notice`/`progress`, follow Grok Bot: no reply is expected, and replies that only acknowledge are dropped. The wake header should say plainly that the turn came from an agent, not the user (Grok's `[agent]` cue, similar to our `[Message from …]`).
5. **Enforce what Grok Bot only asks for.** A turn that sends to more than one distinct recipient under one root should become a Fermata unless the human asked for it (Grok's rule at `agent-messaging.ts:44`). Orchestra's principle is deterministic first, so this belongs in the Post Office, not the prompt.
6. **Room defaults for M3:** 6 members, no nested rooms, 3 rounds, 10 member turns, 2 messages per turn, rotating speakers, `(pass)`, and the redelivery note. These combine with DS-Bot's members×3 relay cap.
7. **Routines as Reminder v2** (`target=musician`, M3): add `trigger` (cron or listener), `expiresAt` for finite watches, `runs[]` capped at 20, pausing after repeated auth failures, quiet hours by default, and a per-turn status reminder.
8. **Freeze injected context per epoch.** Freeze the injected Decisions and memory per Part or compaction epoch, the same way `sand-memory.ts:24-38` does. This keeps the prompt cache warm and fits the "persona byte-stable" field on Musician.
9. **Shape the SSE stream after the roster.** The Stage feed can be `{upserted[], removed[]}` deltas, with an explicit resync frame instead of resyncing on a sequence gap (bot_relay README).
10. **Watch host connections with a read deadline.** Use 4× keepalive with no inbound frame as the liveness rule for orchestrad's ACP/SDK host connections, and reset backoff only on evidence of success.

**Avoid**
1. **Do not copy GBR code or prompt text.** It is unlicensed and derived from Anysphere's binary (`NOTICE.md`). Record it as reference-only in the §12.2 license plan.
2. **Do not let agents interrupt each other.** Grok's "priority" message tells the recipient to drop in-flight work (`agent-messaging.ts:92-93`). Keep `InterruptAndSend` and `Interject` for humans only.
3. **Do not encourage agents to create routines.** Grok Bot's prompt tells agents to be "aggressive" about it (`automation.ts` system prompt), which conflicts with §8.6 quotas and the rule that only the human holds authority. Agent-created routines stay P3, need confirmation, and count against quota.
4. **Do not let a connecting client set the permission mode.** GB's leader takes yolo/auto mode from whichever client connects (`protocol.rs:180-190`). D5 already forces bypass off; keep it that way.
5. **Leave out the cloud box and the grok.com relay.** They are outside our local-only scope.
6. **Look closer at gawkbot's adoption before borrowing it.** `claude_answer.go` reads foreign Claude logs to find a turn's final reply after a hand-off (`internal/agentdetect/claude_answer.go:16-21`). How it injects that hand-off was not checked (inferred). Reading logs is fine for M0 observation, but driving foreign sessions would break D4.

**On merging dynamic Workflow**

"Workflow" means two different things in these projects:
- **GB `xai-workflow`** is a Rhai-scripted engine where "scripts orchestrate agents through a host channel" (`Cargo.toml`). It exposes `agent()`, `parallel()`, `phase()`, `await_user()`, `budget()`, scratch files and `git_diff_since` (`engine.rs:492-776`; `host.rs:64-112`). It validates that `meta` is the first statement (`meta.rs`). Every host call is journaled as `(seq, kind, req_hash, result)`; on replay the host is never called again, and a script that issues a different call is a hard `Divergence` error (`journal.rs:6,43,187`). Runs are scoped to one session, and their children cannot be addressed.
- **GBR "workflows"** are just `SKILL.md` recipes that can have a cron trigger and are projected into routines (`workflow-model.ts:4-6,19-20`).

My view:
- **Do not put a workflow engine into the Post Office.** Workflow runs belong inside a Part, as Clone trees. Orchestra watches them (`phase`/`log`/`telemetry` → Score), governs them (agent-call reserve/settle → Ledger and Governor), and reaps them.
- **Map pause kinds to inbox items:** `user` → question, `verification` → ready-for-review, `no_progress` → runaway, `back_off`/`infra` → failure.
- **Lift the journal pattern for Orchestra's own multi-Musician runs later (M3 and after).** Its "replay never calls the host again" rule is the same as our "never resend an unknown outcome" rule in §8.3. Grok Build's 4 runs per session and queued fan-out also confirm "queue, don't fail".
- **Maestro can propose a script in shadow mode.** Execution stays in a harness's own workflow tool, under Orchestra's caps.

## Open questions
1. Which did you mean by "grokbot 早期开源出来的代码": (a) the Grok Bot 0.18 reconstruction, (b) xai-org/grok-build, (c) the `@grok` prompts, (d) gawkbot, or something else such as a link from a Chinese forum? Please send the URL if you have it.
2. Is a design-only reference to unlicensed reconstructed code acceptable for a public MIT Orchestra (Q9)?
3. Should Orchestra auto-reply depending on the message role (proposal 4 above), or follow Grok Bot and make every reply explicit?
4. Should Grok Build become a fourth harness? It speaks ACP, keeps sessions in `~/.grok/sessions`, and dsh-TUI already has a parser for it. Its README says Windows builds are only best-effort.
5. GB's public syncs stopped at 2026-09-29. Is that a normal pause or the end of syncing? I have not verified it.
6. Should Tobs (BotHarness/DeepSeekBot: Git-backed memory, bots with their own IM identities) be researched as the second DSH bot reference next to DS-Bot?

Raw files I fetched are under `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\gb\raw\` (grok-build) and `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\gbr\raw\` (reconstruction).