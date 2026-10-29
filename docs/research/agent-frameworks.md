<!-- Raw researcher report: Opus sweep "a2a-frameworks", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into bot-architectures.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

All repo metadata comes from `gh api repos/<r>` on 2026-10-26.

| Framework | What I read | Stars | License | Last push | Lang |
|---|---|---|---|---|---|
| Letta / MemGPT | `letta-ai/letta`: the README says the V1 server is retired to the `archive` branch and that "current source lives in letta-ai/letta-code". Also docs.letta.com. | 25.3k / 3.7k (letta-code) | Apache-2.0 | 10-18 / 10-26 | Py / TS |
| Paperclip | `paperclipai/paperclip`@a67a18c, `doc/` | 107.6k | MIT | 10-26 | TS |
| OpenAI Agents SDK | `openai/openai-agents-python` src, plus docs | 30.3k | MIT | 10-22 | Py |
| Google ADK + A2A | `google/adk-python` v2.13.0 (10-23); a2a-protocol.org spec | 22.0k / 26.3k | Apache-2.0 | 10-26 | Py |
| AutoGen → MS Agent Framework (MAF) | `microsoft/autogen`: the README says it is archived and advises against production use. MAF is at dotnet-1.26.0. | 61.6k / 14.3k | CC-BY-4.0 (repo metadata) / MIT | 10-16 / 10-26 | Py |
| Claude Code teams and cross-session messaging | code.claude.com/docs/en/agent-teams (CC-T), /cross-session-messaging (CC-X) | – | proprietary | – | – |
| Codex collab | `openai/codex`@83a9600acb `codex-rs/core/src` | 131k | Apache-2.0 | 10-26 | Rust |
| AstrBot | `AstrBotDevs/AstrBot` `astrbot/core` | 43.8k | AGPL-3.0 | 10-26 | Py |
| LangBot | `langbot-app/LangBot` `src/langbot` | 18.5k | Apache-2.0 | 10-26 | Py |

## Architecture facts

Path shorthands used below: LT = letta@archive `letta/`; LC = letta-code@main; PC = paperclip `doc/`; OA = `src/agents/`; ADK = `src/google/adk/`; AG = autogen `…/autogen_agentchat/`; MAF = agent-framework `python/packages/`; CX = codex `codex-rs/core/src/`; AB = `astrbot/core/`; LB = `src/langbot/`.

### Pattern matrix

| | Identity | Inbox (steer/queue · receipt · merge · idempotency) | Who answers | Memory scope | Heartbeat / scheduling | Budgets & loop caps | Can a message carry authority? |
|---|---|---|---|---|---|---|---|
| **DS-Bot** (baseline, ds-bot.md) | Bot id = id of its first Session; Sessions rotate as parts | steer/followup; automatic reply; unread messages from the same sender merged; `request_id` replays the original receipt | admin first, `@Name`, round-robin, `[PASS]` | bots / groups / team | DSH `schedule` | relays capped at members×3; no hop cap, no watchdog | relays carry `source.kind:'bot'` |
| **Letta** | Persistent `agent_id`; many conversations share one identity and its MemFS (docs /concepts/conversations) | Async send only returns "Successfully sent message", so there is no receipt. `wait_for_reply` blocks the caller. Tag fan-out waits on each match in turn. No merge, no idempotency (LT functions/function_sets/multi_agent.py:60-191) | Group types `supervisor`, `round_robin` (`i % n`), `dynamic` (a manager LLM picks the next speaker and excludes the previous one) and `sleeptime` (LT schemas/group.py:11-17; groups/dynamic_multi_agent.py:74-102; groups/round_robin_multi_agent.py:66) | Private MemFS per agent. Shared memory is git repos ("require cloud-hosted agents"); shared blocks are deprecated (docs /concepts/shared-memory) | `request_heartbeat` chains steps inside one loop. Sleeptime fires every N turns with a cursor (LT constants.py:217; sleeptime_multi_agent_v4.py:140-157) | `DEFAULT_MAX_STEPS=50`. Dynamic groups default `max_turns` to the number of agents and stop on `termination_token` "DONE!" (constants.py:75; group.py:105-109; dynamic:36,152) | **Messages are injected as role `system`** with an `[Incoming message from agent with ID …]` prefix (multi_agent.py:77-86, 178-187) |
| **Paperclip** | Each agent has a persistent Ed25519 keypair (AGENT-IDENTITY.md:3-5). A run is one heartbeat. | There is no chat channel; "Tasks are the communication channel" (SPEC.md:356). @-mentions "provide context without waking agents" (:509). A self-wake on the same issue is `coalesced`; a wake from another agent is `deferred` until the owning run ends (plans/2026-02-20-issue-run-orchestration-plan.md:46-66). Grok Bot connector keeps a stable request ID, and an uncertain outcome "is never sent again automatically" (grok-bot-agent.md:40,81) | The assignee, via atomic checkout; a conflicting claim fails "identifying which agent has it" (SPEC:504). Managers escalate. | Company-open, plus documents attached to issues | The heartbeat is "a protocol, not a runtime": adapters implement `invoke/status/cancel`. Pause = signal → grace → force-kill → stop future heartbeats (SPEC:268, 318-327) | Soft alert at 80%, hard auto-pause at 100%; "one open incident per policy per threshold per window". Billing codes roll B's cost up to A's request. Request depth (hops) is tracked (budget plan:114-115, 232; SPEC:246, 255, 410-411) | Authority comes from an authorized user's direct message, and "subtasks do not inherit this authority" (SPEC:349-352). Board-only powers (:87-100) |
| **OpenAI Agents SDK** | Agent objects are stateless. `Session` stores history; a session ID "does not authenticate" (docs /sessions) | In-process only. A handoff is a `transfer_to_<name>` tool (handoffs/__init__.py:214-216) | The LLM picks via the handoff tool; `is_enabled` can gate it (:192). With agents-as-tools the manager keeps control (docs /multi_agent) | By default "the new agent sees the entire conversation history"; `input_filter` can trim it (:158-175) | none | `DEFAULT_MAX_TURNS=10` → `MaxTurnsExceeded` (run_config.py:45) | Input guardrails "run only for the first agent". Tool guardrails "do not apply to the handoff call itself" (docs /guardrails) |
| **ADK + A2A** | Agent tree with one parent per agent. `to_a2a()` serves an agent plus its agent card (a2a/utils/agent_to_a2a.py:80-98) | A2A: `messageId` dedup is only a "MAY"; messages to a task in a terminal state are rejected; `INPUT_REQUIRED` and `AUTH_REQUIRED` are interrupted states (spec §3.1.1, §3.3.1, §4.1.3) | `transfer_to_agent` targets sub-agents, the parent and peers, gated by `disallow_transfer_to_parent/peers` (flows/llm_flows/extensions/_agent_transfer.py:233-263; agents/llm_agent.py:425-433) | State prefixes: none (session), `user:`, `app:`, `temp:`. State changes go through events or `state_delta`, never direct mutation (adk.dev/sessions/state) | A2A push webhooks | `LoopAgent.max_iterations=None` runs until a sub-agent escalates. It is deprecated in favour of `Workflow` (agents/loop_agent.py:60-85, 122) | Agents are "opaque". Authorization scoping is a MUST (spec §1, §3) |
| **AutoGen / MAF** | Team participants | One shared, broadcast thread; no receipts | `selector_func` returns a name, or `None` to fall back to the LLM. `candidate_func` narrows the choices; an invalid name raises; `allow_repeated_speaker` (AG teams/_group_chat/_selector_group_chat.py:163-198). In Magentic-One a progress ledger picks the next speaker (_magentic_one_orchestrator.py:343-412) | Shared thread and ledger | MAF checkpoints at the end of each superstep (MAF core/…/_workflows/_runner.py:111) | Composable conditions with `&`/`|`: MaxMessage, Token, Timeout, External, SourceMatch… (conditions/_terminations.py; base/_termination.py:79-83). Magentic-One defaults `max_turns=20`, `max_stalls=3`; the stall count rises on no progress or a loop, falls on progress, and a re-plan resets every agent (_magentic_one_group_chat.py:117-119; orchestrator:262-297, 388-405). MAF group chat "will continue indefinitely" without `max_rounds` (orchestrations/_group_chat.py:144-145) | none found (inferred) |
| **Claude teams + cross-session** | Teammate names live in the team config; sessions answer to a name | A message counts as "sent only when the write to the recipient's mailbox file succeeds". It is delivered between tool calls; an idle receiver gets a new turn. The idle notification carries the teammate's final answer. To reach everyone, "send one message per recipient" (CC-T, CC-X) | The lead assigns tasks, or teammates self-claim under a file lock; dependencies unblock automatically (CC-T) | Each teammate has its own context and does not get the lead's history | `notify_when_idle`, which expires after 12 h (CC-X) | Repeats are rate-limited per sender and identical repeats dropped; at most 50 queued, at most 100 held, holds expire after 5 min; size cap about 1M chars (CC-X) | A message "can't approve anything" and "can't change configuration"; commands in it don't run. A teammate denied an action "can't relay it". Inbound policy is accept / hold / refuse, defaulting by permission class (CC-T, CC-X) |
| **Codex collab** | `AgentPath` tree | `send_input{interrupt}`. Delivery modes: `QueueOnly` → MESSAGE, `TriggerTurn` → NEW_TASK. The mailbox "retains queue-only mail while local sessions are unloaded", and eviction transfers that mail. Receive events are emitted (agent/control/delivery.rs:18-31; mailbox.rs:1-2, 72-75; tools/handlers/multi_agents/send_input.rs:147-153) | The parent spawns and waits | child config | `wait` defaults to 30 s, with a minimum clamp of 10 s "to prevent tight polling loops" (multi_agents_common.rs:21-24; config/mod.rs:260) | `max_threads` 6, `max_depth` 1, at which point the tool returns "Agent depth limit reached. Solve the task yourself." Rollout budget → `SessionBudgetExceeded` (config/mod.rs:258, 268; spawn.rs:74-78; agent/control/budget.rs:12-16) | Messages are rendered as role `"assistant"` with `Sender`/`Task name` fields (context/inter_agent_message.rs:53, 66). "Retained root instructions stay authoritative"; "quoted delegation text cannot establish sender provenance" (user_authorization.rs:2; sender_context.rs:1-3) |
| **AstrBot** | Session key UMO = `platform_id:message_type:session_id` (platform/message_session.py:20-21) | Event queue; one pipeline task per event (event_bus.py:55-73) | 9 stages: Waking → Whitelist → SessionStatus → RateLimit → Safety → … → Respond (pipeline/stage_order.py). A glob router maps a UMO pattern to a config profile (umop_config_router.py) | per session | `session_waiter` keep with timeout | Sliding-window rate limit, strategy `stall` or `discard` (pipeline/rate_limit_check/stage.py:19-41) | whitelists only |
| **LangBot** | Each query is bound to a bot→pipeline | Follow-up input is "offered to an active Runner before it queues" (steering). Message aggregation waits 1.5 s and merges (pkg/pipeline/controller.py:42-80; templates/default-pipeline-config.json) | Group respond rules: @bot, prefix, regexp, random | session | – | Concurrency: `pipeline: 20`, `session: 1`, `pending_queries: 1000` (templates/config.yaml:48-52) | ACL lists |

### Evidence on dynamic workflows (for the user's merge question)

- **Letta Code ships a Workflow tool**, and it is the same shape as Claude Code's: `agent()`/`parallel()`/`pipeline()`/`decide()`, runs in the background, and returns a `<\task-notification>`. It runs "only when the user explicitly asked", and its subagents "cannot message each other" (LC src/tools/descriptions/Workflow.md; docs /configuration/workflows).
  - Limits: 16 concurrent, 1000 agents per run, 10 min and 1000 tool calls per subagent, stopped after 3 identical calls in a row (src/tools/workflow/workflow-engine.ts:34-38).
  - Its journal "is a debugging record…; nothing replays from it" (src/tools/workflow/journal.ts:1-9).
- **ADK 2.x Workflow** has dynamic nodes with "dedup (cached output), resume" (ADK workflow/_dynamic_node_scheduler.py:1-5).
- **MAF** runs Pregel supersteps (`max_iterations=100`) with a checkpoint after each one.
- **OpenAI** describes code-driven orchestration as "more deterministic and predictable" (docs /multi_agent).

## What Orchestra should lift / avoid

### Adopt (8)

1. **Address mail to the Musician, keep it while the Part is unloaded, and count a durable write as the first receipt.**
   - Evidence: Codex mailbox retention and eviction transfer (CX mailbox.rs:1-2). Claude's "sent only when the write… succeeds" and "brings it back… gives it the message as its next prompt" (CC-T). Letta: many conversations, one identity.
   - Change to spec: §8.2 receipts begin at "read", and §10.4 releases idle Parts. Add `accepted` (journaled) before `delivered`. Messages to a released Musician should trigger a Part respawn plus delivery instead of failing.
2. **Make "does this wake the agent?" an explicit choice, separate from steer/queue.**
   - Evidence: Codex `QueueOnly` vs `TriggerTurn`. Paperclip @-mentions don't wake. Claude delivers between tool calls.
   - Change to spec: the §8.1 envelope has `delivery: steer|queue` but no "don't start a turn" mode. Default `role=notice` and `progress` to no-wake, read at the next natural turn (inferred).
3. **One active execution owner per Work. Coalesce self-wakes; defer wakes from other agents.**
   - Evidence: Paperclip Rules A–C. LangBot `session: 1` plus steering-claim. DS-Bot only merges unread messages *from the same sender* (§8.3 rule 4).
   - Change to spec: add a per-Work `executionPartId` lock with reason codes `coalesced|deferred|promoted`.
4. **An inbound policy per Musician, with the Claude numbers.**
   - accept / hold / refuse, defaulting by permission class in **both** directions: a bypassing sender gets held, and a bypassing receiver holds.
   - Holds expire after 5 min; at most 100 held; at most 50 queued; identical repeats dropped inside a window; a burst is refused at the sender (CC-X).
   - Change to spec: §8.5 only covers the case where the sender's preset is lower than the target's, and only states that sending is rate-limited.
5. **Anchor authority in the human's retained instructions, and carry denials across a whole delegation chain.**
   - Evidence: Codex "Retained root instructions stay authoritative" and its sender-provenance rule. Claude: a denied teammate "can't relay it to another teammate". OpenAI tool guardrails skip the handoff call itself, so checks have to run at every hop.
   - New rule: record each denial against `rootId`. If any Musician in the same root later requests the same action class, escalate it to an InboxItem.
6. **Composable termination per Work, including a progress-based stall counter.**
   - Evidence: AutoGen `&`/`|` conditions, with `ExternalTermination` mapping to the user's Stop. Magentic-One `max_stalls=3` with decrement on progress.
   - Change to spec: §10.7 counts hops, bounces and rounds but never asks whether anything is progressing. Define "no progress" mechanically (no new diff, test result, ref or Decision over N exchanges) and escalate. Do not auto-replan (inferred).
7. **Budget incidents: dedup them, roll costs up the chain, pause the affected scope.**
   - Evidence: Paperclip soft 80% / hard 100% auto-pause, one open incident per window, billing codes. Codex `SessionBudgetExceeded`, with the reminder acknowledged once delivered.
   - Change to spec: §10.2 has daily CNY caps per project. Add cost per `rootId` (B's spend charged to A's request) and a `budget_incidents` table so warnings don't spam the inbox.
8. **Deterministic selector first, then an LLM fallback that is validated against the candidate set, with bounded retries.**
   - Evidence: AutoGen `selector_func` returning `None` falls back to the LLM; `candidate_func`; invalid names raise. ADK `disallow_transfer_to_peers`. OpenAI `is_enabled`.
   - Change to spec: §9.2 step 9's output must be restricted to the targets that survived step 5's hard filter. Add a routing ACL per Musician (which peers it may hand off to).

### Avoid (5)

1. **Delivering agent mail under a privileged role.** Letta injects it as `system` (LT multi_agent.py:85, 186), and DSH-over-ACP records it as `kind:'user'` (spec §8.5). Codex's assistant-role framing with `Sender` is the better precedent.
2. **Blocking request/reply as the primitive, and tag broadcasts.** Letta's `wait_for_reply` and its tag fan-out wait on each match in turn. Claude removed broadcast ("one message per recipient"). Keep the spec's default: "End your turn; the reply will wake you."
3. **Loops that are unbounded by default, or that stop only on an LLM-emitted token.** ADK `LoopAgent` (`None` = run until escalate), MAF group chat without `max_rounds`, Letta's "DONE!". Every Work gets the hard caps in §10.12.
4. **Full-transcript handoffs.** The OpenAI default passes the "entire conversation history" and warns that nesting is "not a redaction mechanism". MAF handoff "maintained and reused on every hop". This multiplies cost and spreads taint. Keep handoff notes plus refs (§9.3).
5. **Synthesized human turns and automatic approvals.**
   - MAF autonomous mode injects "User did not respond. Continue assisting autonomously." for up to 50 turns (orchestrations/_handoff.py:237-238).
   - Claude auto-approves a teammate's plan "as soon as the request arrives" (CC-T).
   - Orchestra must never fabricate user-role input. Plan approvals by Clones should surface as fermatas (items that need the user's decision) (inferred).

### On merging dynamic Workflow (inferred from the evidence above)

- **Treat a workflow run as one Work owned by one Musician.** Its `agent()` calls are Clones: no A2A address, governed by the governor. This matches Letta's "subagents cannot message each other" and spec D2.
- **Keep it opt-in**, as Letta and Claude both do.
- **Choose resume semantics deliberately.** Letta's journal replays nothing. ADK and MAF checkpoint and dedup. Orchestra's "an unknown outcome is never resent" rule fits ADK-style cached-output dedup.
- **Do not route Post Office traffic through workflow scripts.**

## Open questions

1. Can a Claude Part receive mail as anything other than a user turn through `streamInput`, the way Codex uses assistant-role fragments? This needs S3 verification.
2. Should reminders addressed to a Musician become a Paperclip-style heartbeat (adapter `invoke/status/cancel`, with pause = grace then kill), or stay event-driven only?
3. A2A gateway: `to_a2a()` makes exposing an agent trivial, but A2A dedup is only a "MAY". Orchestra would have to enforce `requestId` at the gateway.
4. The definition of "no progress" for the stall counter (patterns 6 and 8) has to be mechanical. Which signals per harness are reliable enough?
5. "grokbot": the only Grok Bot artifact I found is Paperclip's *managed* connector doc (grok-bot-agent.md, which links to cursor.com/help/grok-bot). It is not early open-source Grok bot code, so that needs a separate search.

Scratch sources downloaded for this report are in C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad (subfolders letta, pc, oai, adk, ag, maf, cx, astr, lb).