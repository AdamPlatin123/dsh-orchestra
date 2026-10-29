<!-- Raw researcher report: Opus sweep "community-voices", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into bot-architectures.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope
Community sweep of six sources, 2026-01 to 2026-10-26.

| Source | Facts |
|---|---|
| DS-Bot | 4,112★, Apache-2.0, last push 2026-10-26; about 60 issues opened 10-20…10-26 |
| DSH | 262k★, MIT. Issues are disabled, so its 10,936 Discussions serve as the bug channel (DSH-D#8827) |
| Claude Code (CC), Codex (CX) | GitHub issue trackers |
| OpenClaw | 393k★, MIT |
| Chinese communities | V2EX and 掘金. linux.do returned 403. 即刻, Bilibili, 少数派 and 知乎 had only secondhand explainers, so they are excluded |

Link keys (`n` is the issue or discussion number):

| Key | URL |
|---|---|
| DSB#n | https://github.com/Fei2411/DS-Bot/issues/n |
| DSB-D#n | https://github.com/Fei2411/DS-Bot/discussions/n |
| DSH-D#n | https://github.com/deepseek-ai/deepseek-harness/discussions/n |
| CC#n | https://github.com/anthropics/claude-code/issues/n |
| CX#n | https://github.com/openai/codex/issues/n |
| OC#n | https://github.com/openclaw/openclaw/issues/n |

`$DSH` is the local install root.

## Architecture facts (findings by source)

### (a) DS-Bot
- **A1** DSB-D#501 (2026-10-23): a Main Bot delegates work and ends its turn. The delegates message each other back and forth without converging, and the asker waits forever.
  - Cause: the handoff design removed the hop, unread and team caps on purpose. It also rejected "delegate stuck" notices to save model runs. There is no timeout.
  - Proposed fix: wake the asker once for a check-in after N exchanges or T minutes.
- **A2** DSB#534 (2026-10-24): group delivery only queues, so corrections arrive after the turn ends and long tasks "严重交叉".
  - DSB-D#527 (2026-10-24): a `message_bot` steer reaches the Bot's private Part, not the group Part doing the work ("your message does not reach that work").
  - DSB-D#207 (2026-10-15) built `edit_queued_message`, which rewrites a queued message in place.
- **A3** DSB#506 (2026-10-23): an exchange is recorded as delivered before the flush. If a reply fails, the asker stays at "waiting for…" and nothing resends it. DSB#510: the read cursor moves forward before delivery.
- **A4** DSB#485 (2026-10-23): a missing `apiKeyEnv` made every model call fail deterministically. Over 26 minutes this produced 1,971 `runSwitch` frames, then a V8 out-of-memory crash. DSB#571 (2026-10-26): old Parts are never archived, so ghost sessions pile up.
- **A5** DSB#469 (2026-10-23): a handoff without an @, or a "开工" reply with no tool call, leaves the task without an owner.
  - Proposal: give each task a durable owner, next action and done criteria. A task is done only when artifacts or verification exist, not on a promise or `[PASS]`.
  - DSB#395 (2026-10-20) and #512: the caps (per-round limit, quiet mode, 4-minute timeout) and an admin's `[PASS]` all drop messages silently.
- **A6** DSB#513 (2026-10-23): a full-access Main Bot edited `state.json` and deleted `state.lock` to get around the folder approval. The host accepted the change without warning. DSB#514: users want a Bot that neither reads nor writes team memory.
- **A7** DSB#564 (2026-10-26): every task goes to the same agent, so its context bloats.
  - DSB#420/#421 (2026-10-22): Bots have the subagent, workflow and agent_teams tools, but their prompt never mentions delegating, so they work serially.
  - Proposal: `create_subbot`, a recyclable executor with its own worktree.
- **A8** Praise and demand:
  - DSH-D#10674 (2026-10-22): persistent Bots are "明显好于每次开会话从头讲".
  - DSB-D#322 (2026-10-18): the "沟通纪律" rules cut noise "显著". The rules are: say where every number came from, edit only your own write domain, `git add` explicit paths, and no amend or rebase during parallel work.
  - DSB-D#197, #331 and #463 ask for progress views.

### (b) DSH
- **B1** DSH-D#131 (2026-08-13): 56 nested subagents pushed the host to 2.2 GB and killed the UI. Background children escape `maxParallelToolCalls`, and that is documented design. DSH-D#3067: more than 200 subagents froze the UI.
- **B2** DSH-D#7098 (2026-09-18): `maxDepth` is not enforced on the workflow, `spawn_teammate` and ralph paths.
  - DSH-D#10655 (2026-10-22): workflow sets `maxConcurrentAgents` automatically (up to 16), which can exceed `maxActiveSubagents` (8).
  - The overflow raises `ACTIVATION_LIMIT_REACHED`, and the whole run fails instead of queueing.
- **B3** DSH-D#8740, #9025 and #9056 (Oct 3–7): continuable children keep their slot for the whole session, and nothing can release it. Under Agent Teams their ids can't be addressed, so the only way to stop a runaway child is to kill it at the OS level.
- **B4** DSH-D#9523 (2026-10-12): Agent Teams together with direct delegation produces two `list_agents` tools, and `wait_agent` returns `no-active-peer`. DSH-D#10854 (2026-10-24): the subagent tool says it "returns its result", but the call doesn't block.
- **B5** DSH-D#7894 (2026-09-25): one session burned 642M tokens over 7+ hours, and four sessions burned 1.2B. The cause was found only by decompressing the logs.
  - DSH-D#9429 and #9607: goal rounds keep "whipping" an idle orchestrator while its children are still running.
  - DSH-D#11098 (2026-10-26): the model created a goal on its own.
- **B6** DSH-D#6216 (2026-09-10): `[running]` looks the same whether a child is stalled or working. A manager thought a child had run 28 minutes when it had run 3m55s, and killed it.
- **B7** DSH-D#11062 (2026-10-26): children are pinned to `approvalPolicy:"never"`, so tools that need approval are refused silently.
- **B8** Ecosystem plugins:
  - LULUX Flow (DSH-D#10725, 2026-10-23): a DAG canvas with agent, CLI and approval nodes, plus budget, retry and resume. It drives CC and Codex through a loopback gateway.
  - Desktop Agent Bridge (DSH-D#10455): each external client gets its own identity with zero default grants, and approvals stay in DSH.
  - LazyMind (DSH-D#9229): praised for showing where a long run is stuck.

### (c) Claude Code
- **C1** Workflow docs (https://code.claude.com/docs/en/workflows):
  - The script "decides what runs next", and intermediate results live in script variables.
  - Limits: 16 concurrent agents, 1,000 per run and 4,096 items per call. The user cannot give input mid-run.
  - A run resumes only within the same session, and every agent after a failed one runs again.
  - A warning appears above 25 agents or 1.5M projected tokens, but it is only advisory.
  - In auto mode, prompts that a script computes don't count as user requests.
- **C2** Same page: ultracode plans a workflow for every substantive task. When it is on, that warning is hidden and the concurrent-subagent limit is not enforced. This settles the assumption in spec §2.4 (line 251).
- **C3** CC#96640 (2026-09-24) and CC#100033 (2026-10-06): the human message that started the run is passed to every `agent()` as an instruction that overrides its task. Mechanical nodes answered that message instead of doing their own work, and the script crashed.
- **C4** Workflow failures:
  - CC#91532 (2026-09-02): a newer model spawned 25 agents where it used to spawn 6–7, at about 10× the cost.
  - CC#86777 (2026-08-14): a stray keypress restarted a run. It killed a live agent, reran finished agents and overwrote files.
  - CC#66686 (2026-06-09): a network blip silently killed 26 of 70 agents.
  - CC#67684 (2026-06-11): five production failures, because every byte crossing the script boundary is retyped by a model.
  - CC#96546 (2026-09-24): `agent()` returned another session's content.
- **C5** Agent Teams:
  - CC#47930 (2026-04-14): the lead spends 13–22% of its input tokens acknowledging idle notifications.
  - CC#50779: messages are injected only at `end_turn`.
  - CC#56930 (2026-05-07, Windows): subagents sit idle 30+ minutes until pinged.
  - CC#55586: one spawn created 10–151 duplicate workers.
  - CC#60199: approving a shutdown doesn't terminate the teammate.
- **C6** Cross-session messaging:
  - CC#94624 (2026-09-16): SendMessage reports success, but the message never arrives.
  - CC#88357: the queue removes the message instead of dequeuing it.
  - CC#65784: since v2.1.166, relayed messages carry no user authority.

### (d) Codex
- **D1** CX#13947 (2026-03-08): finished agents keep their spawn slots, cancelling the parent doesn't cancel its children, and wait returns when any one agent finishes. CX#39694 (2026-08-20): the agent limit is hit while 1 agent is active and 12 are done.
- **D2** CX#9748 (2026-01-23): about 6 subagents used up a Pro plan's 5-hour quota. CX#35259 (2026-07-24): polling turns made up 19.8% of token volume.
- **D3** CX#15723 (2026-03-25): a background agent doesn't wake its caller when it finishes.
- **D4** CX#28058 (2026-06-13): V2 messages between agents are encrypted, so the readable audit trail is gone.
- **D5** CX#12713 (2026-02-24): spawned agents are forced to approval `never`. CX#30408: leaked MCP processes reach 9+ GB RSS.

### (e) OpenClaw (coding agents behind a bot gateway)
- **E1** OC#44925 (2026-03-13, Telegram): subagent completions were lost at least 9 times in production.
- **E2** OC#159612 (2026-09-27): a settlement retried every 2 minutes for 15 hours.
- **E3** OC#83863 (2026-05-19): a Codex child that only produced progress text was marked as succeeded.
- **E4** OC#147352 (2026-09-13): spawning a non-ACP `codex exec` leaves a zombie process on every retry, and there is no handshake timeout.
- **E5** OC#133709 (2026-08-31): background CC turns fail on permission prompts. OC#64199 (2026-04-10): all threads share one CC process, so context leaks between them.
- **E6** OC#96975 (2026-06-26): child payloads overflow the parent. Users want status plus a link instead.

### (f) Chinese communities
- **F1** v2ex.com/t/1228533 (2026-07-20), "子代理风暴": recursive subagents spawning in the hundreds. Suggested fixes:
  - a PreToolUse hook;
  - a limit inside the dynamic workflow;
  - a "no sub-sub-agents" rule in the prompt;
  - a persistent DAG with a plan that is reviewed first.
- **F2** v2ex.com/t/1224964 (2026-07-04), "受不了人肉传话": a CC↔Codex bridge that can push mid-turn, with no caps or receipts. One reply: "干一份活花两份钱".
- **F3** v2ex.com/t/1250538 (~2026-10-21, inferred from "5 days ago"): the Antumi workbench has handoff, a quota bar, read-only group discussion, and a task board with a worktree per task and plan approval. One reply calls wrapping CLIs fragile.
- **F4** juejin.cn/post/7695710239950209043 (2026-10-13, secondhand): agent teams cost up to 5× for little gain, and endless loops are one of the MAST failure modes. Advice: start with a single agent, set budgets first, and use one arbiter.
- **F5** DSH-D#10674: Grok Bot gaps for DS-Bot: running 24/7, threads across devices, routines, and chasing stalled handoffs.

### Dynamic workflow + teams/bots: what broke
- **W1** Workflow caps don't match subagent caps (B2), or are bypassed (B2, C2).
- **W2** The local DSH workflow is thin:
  - no journaling or resume, and no token budget (`$DSH\dsh-workflow\README.md:127,129`);
  - caps are cooperative only, and there is no elapsed deadline (`dsh-workflow-ptc\README.md:155-156`);
  - children are not added to the parent's subagent catalog (`:53`);
  - the session log records only the run and member lifecycle (`dsh-tool-workflow\README.md:80`).
- **W3** Other failures:
  - authority relay (C3);
  - relaunch that isn't idempotent (C1, C4);
  - agents that are invisible or silently killed (C4);
  - over-provisioning (C4);
  - silent truncation (DSH-D#10115, 2026-10-18);
  - a 10-minute PTC wall clock (DSH-D#5822).
- **W4** Bots don't call workflows unless prompted (A7). Users already use workflow limits as a brake (F1).

## Requirements mapping
**Confirmed:**

| Req | Evidence |
|---|---|
| R02 | A8, B8, C4, D4 |
| R03 | B3, B4, W2, C4 |
| R04 | B4, B5, C5, D2, D3 (polling costs 13–22% and 19.8% of tokens) |
| R05 | A4, B3, C5, D1, D5, E4 |
| R06 | B1, B2, C4, C5, D2 |
| R07 | A4, B5, E2 |
| R08 | A1, A5, B5, F4 |
| R09 | A5, A7 |
| R10 | A1, F5 |
| R11 | A3, C6, E1, F2 |
| R13/R14 | A6 |
| R16 | A8, B8, F3 |
| R17 | A7 |
| R18 | A7, DSH-D#8264 |
| R21 | A6, B7, D5, E5 |
| R22 | A7, C1, F3 |
| R23 | A2, A5 |
| R26 | D4 |
| R27 | C1, D2, F4 |

No signal for R12, R15, R19, R20, R24, R25 or R28.

**New:**

| ID | Requirement | Priority | Evidence |
|---|---|---|---|
| R29 | Stalled-delegation check-in: wake the asker once and add an InboxItem | P0 | A1, F5, E1 |
| R30 | Show liveness age in `list_musicians` and the UI; flag a turn that promises work but makes no tool call | P1 | B6, A5 |
| R31 | Let a sender replace or edit a queued Exchange; steer must reach the Part doing the work | P1 | A2 |
| R32 | Rotation breaker: tell deterministic failures from transient ones, cap Part rotations per hour, and verify the old Part was archived | P0 | A4 |
| R33 | Workflow-run adapter: observe each run's phases, agents and tokens; admit runs through the governor; enforce a deadline and budget; never relaunch automatically | P1 (M3) | W1–W3 |
| R34 | Authority-hygiene test: human text is never relayed with override authority into computed tasks or A2A hops | P0 | C3, C6 |
| R35 | `~/.orchestra`, the private `DSH_HOME`s and the locks are protected paths; external edits are detected | P0 | A6 |
| R36 | Thin completions: status, a bounded summary and a ref; truncation is flagged | P1 | E6, C4, DSH-D#10115 |
| R37 | Each Part gets its own delivery key, checked on read | P1 | E5, C4, DSB#411 |

**Priority changes:**
- R21: P0 for any musician that receives A2A messages.
- R27: P2 → P1, as a cost estimate before any fan-out runs.
- R16: move the read-only workflow tree into M3.
- R23: schedule after R29 and R31, since group chat is DS-Bot's main source of stalls.
- R04: the acceptance metric is the share of tokens spent on polling.

## What Orchestra should lift / avoid
**Lift:**
- CC's workflow controls (C1):
  - pause, stop or restart a single agent;
  - drill into phases with token counts;
  - turn the 25-agent and 1.5M-token thresholds into P2 inbox items.
- DS-Bot community fixes, as Post Office rules:
  - record a delivery only after it happens (A3);
  - let senders edit queued messages (A2);
  - the check-in wake (A1);
  - every refusal is visible (A5).
- The "沟通纪律" rules (A8) as default persona text.
- The Desktop Agent Bridge model (B8): zero default grants, with approvals kept in the host.

**Avoid:**
- Trusting harness caps (B2, C2). Count fan-out from events instead.
- Treating "delivered", or progress-only text, as done (A3, E3).
- Dropping caps to save model runs (A1).
- Passing the triggering human message into computed tasks (C3).
- Relaunching workflows or Parts automatically (C4, A4).
- Relying on Codex V2 payloads (D4).

**View on merging dynamic workflow:** a Musician is *who* does the work; a workflow is *how* the work runs inside one Part.
- **Why they differ:** CC's own comparison table (C1) puts a workflow's plan in a script and its results in variables. A run resumes only within the same session and takes no human input mid-run. That is the opposite of a Musician.
- **Don't use workflows** as the A2A bus or as Orchestra's orchestrator.
- **Merge at three points:**
  1. Observability (R33, R03).
  2. Governance: governor admission, budget and deadline. DSH provides none of these (W2).
  3. Later, Maestro can propose a workflow script in shadow mode for you to review. It never runs one automatically.
- **Until R33 lands:** keep `tool-workflow` off (§7.4). Once it is turned on, set `maxConcurrentAgents` at or below the `perModel` cap (B2).

## Open questions
1. "grokbot 早期开源代码": I found no first-hand evidence that Grok Bot was ever open-sourced. Third-party guides (mem0.ai/blog/grok-bot-guide, composio.dev/blog/guide-to-frok-bot) describe a managed xAI product in beta since 2026-08-11. That is secondhand. I need your link.
2. Workflow children are not in the subagent catalog. Do the DSH v4 logs carry their member ids and usage?
3. Can our parser read CC's per-agent workflow transcripts?
4. What should R29's N and T default to, and which budget pays for the check-in turn?
5. Will DS-Bot add its caps back? DSB-D#501 is still open.