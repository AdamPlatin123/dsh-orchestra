<!-- Raw researcher report: Opus sweep "openclaw", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into bot-architectures.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

- **What it is:** OpenClaw is a self-hosted personal and team agent gateway. One long-lived Gateway owns every messaging channel (WhatsApp/Baileys, Telegram/grammY, Slack, Discord, Signal, iMessage, WebChat). Control clients and device "nodes" connect to it over a typed WebSocket (`D/concepts/architecture.md:10-17`).
  - Citation shorthand: `D/` = github.com/openclaw/openclaw/blob/7d0c5121/docs/, read on 2026-10-26.
  - Lineage: "Warelay -> Clawdbot -> Moltbot -> OpenClaw" (`VISION.md:13`). Built by Peter Steinberger and the community (`README.md:118`).
- **Repo stats:** 393,139 stars, 82,650 forks, MIT, TypeScript. Repo created 2025-11-24, last push 2026-10-26, 7,946 open issues (`gh api repos/openclaw/openclaw`).
- **Release cadence:** 7 dated releases in October 2026 alone (`D/releases/2026.10.1…10.7.md`).
- **Docs size:** 1,407 Markdown pages excluding translations (counted locally).
- **Stated guardrail:** it will not merge "Heavy orchestration layers that duplicate existing agent and tool infrastructure" (`VISION.md:160`).
- **Coding-harness reach (important for us):**
  - Runs Claude Code either as a model runtime (`claude-cli`) or as an ACP harness session.
  - Runs Codex through a native app-server harness.
  - Has about 20 ACP targets, including `claude`, `codex`, `gemini` and `grok-build` (`D/tools/acp-agents.md:14-17,69-87`; `D/tools/acp-agents/quickstart.md:81-113`).
  - There is no DSH target. Custom acpx agents take a `command`/`args` (`D/tools/acp-agents-setup.md:300-318`), so `dsh --profile acp` could probably be wired in (inferred, untested).

## Architecture facts

**Identity model (one long-lived identity per agent)**
- An agent is an `agentId` that owns:
  - a workspace (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`);
  - an `agentDir` holding auth and the model registry;
  - its own SQLite session store (`D/concepts/multi-agent.md:15-27`).
- `agentDir` must never be shared between agents (`:34`).
- Bootstrap files are injected into every session (`D/concepts/agent-workspace.md:82-107`; `D/automation/standing-orders.md` Tip).
- When an agent asks for a new agent, the request is filed and the agent is created only after operator approval, with provenance kept (`D/concepts/multi-agent.md:95-110`).

**Session model**
- Session keys look like `agent:<id>:main`, `agent:<id>:subagent:<uuid>` and `agent:<id>:acp:<uuid>` (`D/tools/subagents/nesting.md:33-40`; `D/tools/acp-agents.md:60-65`).
- All session state is owned by the Gateway (`D/concepts/session.md:10-12`).
- The "main session" is one rolling conversation that all DMs collapse into (`D/concepts/main-session.md:10-21`).
  - A reset gives it a new live session id, but the old transcript stays searchable under the same key (`:104-107`).
  - Compaction runs in place, and a silent memory-flush turn runs before it (`D/concepts/memory.md:277-279`).
- Cron runs get a fresh session per run (`D/concepts/session.md:47`).

**Routing / who answers**
- Inbound channel traffic is routed by `bindings`, a deterministic match on channel, accountId, peer, guild/team and roles.
  - The most specific match wins; within a tier, the first in config order wins (`D/concepts/agent-bindings.md:100-111`).
  - With no match and no fallback owner, routing returns `AGENT_SELECTION_REQUIRED` and never picks an arbitrary agent (`:65`; `D/concepts/multi-agent.md:319`).
- Bindings are explicitly not access control (`D/concepts/agent-bindings.md:125-127`).
- Delegation `"prefer"` is "prompt guidance, not a scheduler" (`D/concepts/multi-agent.md:161`).
- The team preset is a coordinator plus specialists who do not delegate further (`:112-127`).

**Inter-agent messaging and receipts (`sessions_send`)**
- **Receipts:** admission and reply are reported separately. `targetDisposition: queued|steered` covers admission and `delivery.status: pending|skipped` covers the reply. "Neither field is a target-completion receipt" (`D/concepts/session-tool.md:379-383`).
- **Steer acknowledgement:** a steer is acknowledged only after transcript persistence, and volatile input is never acknowledged (`:386-389`).
- **Retries:** "An uncertain acceptance never replays the input" (`:330`). A retry while admission is still pending returns `sentBeforeError: true` (`:397-399`).
- **Restart recovery:** only unconsumed inputs are re-admitted, and only if their exact endpoints still exist and current policy allows it. The original input identity is reused and the sender's task is never re-run (`:298-308`).
- **Policy re-check:** policy is checked again at dispatch (`:286-289`).
- **Communication preferences:** each session can be set to Always/Ask/Never for send and for receive. Only the creator or an admin can change this; agents cannot (`:230-248`).
- **Send-only ACL:** `tools.agentToAgent.send` can allow sending to an agent without granting visibility of it (`:278-284`).
- **Provenance:** inter-session messages are marked `[Inter-session message ... isUser=false]` (`:430`). An `OPENCLAW_SHELL=exec` marker makes the CLI refuse agent-originated `sessions.send` and `chat.send` (`:432-439`).
- **Design reversal:** automatic agent-to-agent ping-pong (`session.agentToAgent.maxPingPongTurns`, default 5, max 20; `CHANGELOG/2026.5.12.md` via `gh search code`) was retired.
  - Now "Each send returns one peer reply; automatic exchanges … are removed" (`D/releases/2026.10.1.md:1182`).
  - The ACP docs also warn about a parent/child "echo loop" (`D/tools/acp-agents/delivery.md:80-86`). Line 73 of that page still describes bounded follow-up exchanges, which is doc drift.
- **Not found:** I found no cycle-refusal rule between peers (searched `session-tool.md` and `subagents/*`).

**Sub-agents**
- Default caps: `maxSpawnDepth` 5 (range 1–5), `maxChildrenPerAgent` 5, `maxConcurrent` 8 per spawning session (`D/tools/subagents/nesting.md:13-29`).
- Results announce one level at a time: "announces to its direct parent" (`:47-51`).
- Cancellation cascades down the tree (`:87-90`).
- Agents should wait for completion events rather than poll (`:55-60`).
- `sessions_yield` ends the turn, and the registry starts a successor turn once children settle (`D/concepts/subagent-yield-handoff.md:11-16`).

**Memory**
- Plain Markdown files: `USER.md`, `MEMORY.md` and daily `memory/YYYY-MM-DD.md` notes, with a "dreaming" sweep that consolidates them (`D/concepts/memory.md:18-70`).
- "Action-sensitive" memories record expiry, owner and unlock condition, but "Memory … does not enforce policy" (`:104-130`).
- Recall across conversations is opt-in and keeps groups separate (`D/concepts/session.md:212-231`).
- Memory is a single-plugin slot (`VISION.md:117`).

**Scheduling / heartbeats**
- One `GatewayScheduler` coalesces missed ticks, and owners rebuild their schedules from stored deadlines (`D/concepts/architecture.md:145-162`).
- The `HEARTBEAT.md` monitor was retired and converted into ordinary automation jobs.
  - Its heartbeat-specific dedupe and no-route skipping were removed in the process (`D/gateway/heartbeat.md:12-16, ~70`).
- Goals carry a token budget and statuses `active|paused|blocked|budget_limited|complete`. Automatic continuation is a hidden nudge that goes through the normal queue (`D/tools/goal.md:120-166,204-238`).

**Budgets, queues and loop caps**
- **Per-session mailbox:** one turn at a time per session, plus a global `main` lane.
- **Bounded priority head start:** foreground work can overtake normal work by up to 15 s, background work by up to 30 s.
- **Queue modes:** `steer|followup|collect|interrupt`, with `cap 20`, `drop: summarize` and a 500 ms debounce (`D/concepts/queue.md:21-49`).
- **Loop detection:**
  - Always on: a turn stops after 3 identical tool errors (`D/tools/loop-detection.md:11-17`).
  - Optional detectors warn first, then block, then end the run (`:189-208`).
  - 10 identical `wait` calls block the next one.
  - Hashing strips volatile metadata such as PID, duration and cwd (`:91-95`).
- **Not found:** no RSS or process-tree watchdog in the user docs (RSS appears only in CI docs).

**Isolation / permissions**
- Approvals stack on top of tool policy.
  - `askFallback` defaults to `deny` (`D/tools/exec-approvals.md:283-293`).
  - The approved argv, cwd and executable are bound; edits made after the approval request are discarded (`:56,772-773`).
- Operator scopes include `operator.approvals` and `operator.admin` (`D/gateway/operator-scopes.md:34-42`).
- A workspace is "the default cwd, not a hard sandbox" (`D/concepts/multi-agent.md:45`).
- "There is no setting that isolates an agent's auth from the shared profiles" (`D/tools/subagents/nesting.md:102`).
- Default session visibility is `all`, which "can include other users' transcripts" (`D/concepts/session-tool.md:529-533`).
- There is a single-owner state lock plus an exclusive port bind; on Windows the lock uses PID plus process start time (`D/gateway/gateway-lock.md:9-24`).

**Observability UI**
- The Control UI is a Vite + Solid single-page app on the Gateway WebSocket (`D/web/control-ui.md:11-22`).
- It has an Agents roster with live work status (`D/concepts/multi-agent.md:85-87`) and a Subagents panel (`D/tools/subagents.md:39-46`).
- **Notifications:**
  - Push categories: approvals, agent finished, questions, failures (`D/web/notifications.md:41-60`).
  - Push text is generic, with a deep link to `/approve/<id>`, and access is re-checked before every send.
  - Quiet hours suppress stale alerts rather than queueing them.
- **State-change watchers** (`D/concepts/session-state.md:95-103`):
  - one byte-stable pending notice per watcher/target pair;
  - a frozen watermark;
  - no notice for changes the watcher made itself;
  - `changesSince` with an exact `historyGap`.
- Workboard plugin: a kanban with statuses `triage…done` and `dispatch` into sub-agent workers (`D/cli/workboard.md:10,31`).

**Workflows (relevant to the "dynamic Workflow" question)**
- **Swarm:** "no graph DSL and no separate workflow format. The program is the orchestration." Scripts call `agents.run()` inside JS Code Mode (`D/tools/swarm.md:17-18,127-150`).
  - Collector children are one-shot and cannot be steered or messaged (`:317-323`).
  - Collectors "deny actions that require approval. A child never opens an operator approval prompt" (`:366-367`).
  - Groups should stay flat (`:399`).
  - Caps are 32/50/200 and a wait is at most 600 s (`:60-63`).
  - "Saved workflow definitions and a graph DSL are not part of Swarm's current direction" (`:652-654`).
- **Lobster:** a separate, optional, small typed DSL whose pipelines halt with a resume token at approval gates (`D/tools/lobster.md:9-31`).

**Lightweight re-implementations: what they treat as the core**

| Project | Stars | What it keeps as the core |
|---|---|---|
| NanoClaw (nanocoai/nanoclaw) | 31k | Claude Agent SDK, "one process and a handful of files", a container per agent group. Its critique of OpenClaw: "nearly half a million lines of code, 53 config files". Routing goes user → messaging group → agent group → session, with "Two SQLite files per session, each with exactly one writer" (inbound/outbound) (README:36-38,186-194) |
| nanobot (HKUDS) | 49k | The gateway owns sessions, tools, memory and policy around one core loop (README:450) |
| ZeroClaw | 33k | A single Rust binary; `supervised` autonomy by default; OS sandboxes (README:31,80) |
| PicoClaw | 30k | Go; "10MB RAM" (README:6) |
| IronClaw | 12.7k | WASM tool sandbox, credential injection at the host boundary, routines, heartbeat (README:85-97) |

What they all share (inferred): channel router, per-agent workspace and memory, a scheduler, and an isolation boundary. Multi-agent A2A is not part of that shared core.

## What Orchestra should lift / avoid

**Lift**
1. **Two receipts per send.** Keep admission (`queued|steered`) separate from reply delivery (`pending|skipped`). Acknowledge a steer only after the target has persisted it, and add a `sentBeforeError` result for retries (`session-tool.md:379-399`). This fits §6.3 `delivered`/`read`. It also gives the DSH ACP path, which cannot steer, an honest `queued` disposition.
2. **One reply per request; a reply never triggers another reply automatically.** OpenClaw tried ping-pong with a cap of 5–20 and removed it (`releases/2026.10.1.md:1182`), and it hit parent/child echo loops (`acp-agents/delivery.md:80-86`).
   - Add a §8.3 rule: an envelope with `role:reply` or `notice` never opens a Work and never produces an auto-reply.
3. **Re-admission after restart under current policy.** Re-admit only when the exact endpoints are still alive and current policy still allows it, and reuse the original input id (`session-tool.md:298-308`). This complements §8.3 phase (a).
4. **Per-musician receive setting Always/Ask/Never**, changeable only by a human, where Ask creates an InboxItem (`session-tool.md:230-248`). Also keep a send-only ACL separate from read visibility (`:278-284`).
5. **An `ORCHESTRA_PART=…` environment marker** in owned parts so the `orchestra` CLI refuses agent-originated send or approve calls. This protects attribution, not authentication (`session-tool.md:432-439`).
6. **Watcher protocol for Maestro and the primary agent:** byte-stable coalesced notices, a frozen watermark, no self-notification, and `changesSince`/`historyGap` (`session-state.md:95-127`). Plus a "Home" that receives new-session and group-activity notices without waking on every message (`main-session.md:52-80`). This is the persistent-conductor awareness pattern without polling.
7. **Governor details:**
   - `drop: summarize` when a musician's queue overflows;
   - bounded priority head start (15 s / 30 s) to avoid starvation;
   - a `collect` mode that merges same-sender unread messages (`queue.md:21-49`), which matches §8.3 rule 4.
8. **Runaway detector details:**
   - always end the turn on 3 identical tool errors;
   - warn, then block, then end;
   - block repeated identical `wait` calls;
   - strip volatile fields (PID, duration, cwd) before hashing (`loop-detection.md:11-17,91-95,189-208`).
9. **Approvals:**
   - bind the approved plan (argv, cwd, executable) and discard later edits (`exec-approvals.md:56,772-773`);
   - keep push text generic and require the deep link to re-check authority (`notifications.md:41`).
   - Both reinforce D8 and the `requestDigest`.
10. **Lane contracts before a conductor.** Give each musician an Owns / Does-not-own / Chat budget / Handoff / Tool posture template. "A coordinator without lane contracts just coordinates chaos" (`parallel-specialist-lanes.md:99`). This supports putting Maestro at M4.
11. **Musicians cannot create musicians.** A request to create one becomes a typed request that only a human approves (`multi-agent.md:95-110`).
12. **Unresolved route means ask, never a default.** Never fall back to an arbitrary musician (`agent-bindings.md:65`). This validates §9.2 step 10.

**Avoid**
1. **Permissive default visibility** (`all` across agents; `session-tool.md:529`). Orchestra should default to project scope.
2. **Complexity creep:**
   - `restart-recovery.md` is 1,722 lines;
   - the writer-admission redesign was driven by a 1.7 s p99 ACK (`architecture/writer-admission-authority.md:15-18`);
   - NanoClaw's critique above.
   Orchestra needs a hard scope budget per milestone.
3. **Delegation by prompt only** (`"prefer"`). Orchestra's deterministic AutoRoute is the right call.
4. **Isolation that only comes from cwd**, and a skill marketplace. ClawHub had hundreds of reported malicious skills (secondary source, figures vary: [The Hacker News](https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html)). Orchestra should never auto-install skills.
5. **Special-case schedulers.** OpenClaw retired heartbeat-specific semantics later (`heartbeat.md:12-16`). Orchestra's single scheduler (D10) avoids this.

**On merging dynamic Workflow (my view, inferred from OpenClaw evidence)**
- Make a workflow run a **Run inside one Musician's Part**, whose workers are **Clones**. Workers should not be musicians.
- Workers are one-shot and have no A2A address (as in `swarm.md:317-323`).
- Workers **deny** actions that need approval and report the denial back to the script, rather than raising a fermata each (`:366-367`).
- Each run gets a group card on Stage, governor counts, and cascade stop.
- Do not build a saved-workflow format or a graph DSL, which OpenClaw also declines (`:652-654`) and which matches the §3.2 non-goal.
- If a pipeline needs an approval gate, borrow Lobster's "halt and return a resume token" and turn the token into an InboxItem.

**DS-Bot vs OpenClaw for a coding orchestra**

| Need | DS-Bot | OpenClaw | Stronger |
|---|---|---|---|
| Harness reach | DSH only | Claude (CLI/ACP), native Codex, about 20 ACP targets; no DSH | OpenClaw |
| Identity over rotation | Explicit parts + steward handoff note | Stable key; sessionId rotates; compaction + memory flush | DS-Bot for context rotation; OpenClaw for multi-surface |
| A2A semantics | Held replies, upstream-loop refusal, `request_id` | Two receipts, durable re-admission, policy re-check, Ask gate; no cycle refusal found | Combine both |
| Caps and watchdog | None | Depth, children and concurrency caps, timeouts, loop detection; no RSS watchdog | OpenClaw |
| Multi-project attention | Left to "a standalone app" | Notifications, Agents roster, Workboard | OpenClaw, but neither has a cross-harness inbox |
| Persistent conductor | Chief with main-only powers | Home with coalesced notices; coordinator only via prompt | Combine both |
| AutoRoute | Deterministic group rules | Deterministic bindings for channel traffic only | Neither has evidence-gated routing |

## Open questions
1. **Adopt or federate?** Running OpenClaw as Orchestra's harness host would provide Claude, Codex and ACP plus the UI. But it is single-owner, uses a different trust model, and changes weekly. Is a `dsh --profile acp` custom acpx agent viable in practice?
2. **Did removing ping-pong reduce runaway loops?** Linked issues and PR #162227 still need reading.
3. **Has Workboard dispatch solved stale owners and no-owner failures?** These match our community pain points; its plugin docs have not been read yet.
4. **Collector approval policy:** should workflow workers in Orchestra always deny approval-requiring actions, or should their requests be batched into one parent fermata?