# Bot application architectures compared, and what Orchestra lifts

Date 2026-10-26, revised after two red-team reviews (Review log). Proposes spec amendments; does not edit the spec. Companion: [dynamic-workflow-merge.md](dynamic-workflow-merge.md).

**Evidence keys**
- [spec] = `docs/specs/2026-10-26-dsh-orchestra-design.md`, [bot] = `docs/research/ds-bot.md`, [req] = `docs/research/requirements.md`.
- [oc] OpenClaw: `D/` = https://github.com/openclaw/openclaw/blob/7d0c5121/docs/
- [km] Koishi/MaiBot: `K/` = https://github.com/koishijs/koishi/blob/master/packages/core/src/, `MU/` = https://github.com/Mai-with-u/MaiBot/blob/main/, `M\` = `G:\_Projects\maibot\MaiBot\` (v0.11.0), `$DSH` = local DSH 0.2.1-rc.2.
- [grok]: `GB/` = https://github.com/xai-org/grok-build, `GBR/` = https://github.com/b-nnett/grok-bot-0.18-reconstructed (unofficial reconstruction, below).
- [a2a] Letta, letta-code, Paperclip (`doc/`), `AG` = microsoft/autogen, `MAF` = microsoft/agent-framework, OpenAI Agents SDK, Google ADK; `CC-T`/`CC-X` = code.claude.com/docs/en/agent-teams and /cross-session-messaging; `CX` = https://github.com/openai/codex/blob/83a9600acb/codex-rs/core/src/
- [cv] `DSB#n`/`DSB-D#n` = Fei2411/DS-Bot issues/discussions; `DSH-D#n` = deepseek-ai/deepseek-harness discussions; `CC#n`, `CX#n`, `OC#n` = issues in anthropics/claude-code, openai/codex, openclaw/openclaw.
- [wf] = dynamic-workflow report, refined in the companion file.

**Durability.** The six researcher reports ([oc] [km] [grok] [a2a] [cv] [wf]) are saved verbatim as `docs/research/{openclaw,koishi-maibot,grok,agent-frameworks,community,dynamic-workflow}.md` (raw, pre-review; this file and the companion supersede them where they disagree). `docs/` is still uncommitted. Each fact also repeats its primary path. (inferred) marks our conclusions.

## Why this survey

You asked whether Orchestra should copy existing bot architectures (GitHub, communities, the early open-sourced "grokbot", DS-Bot).

**Answer: use them as a pattern library, not as a base.**

- **None does Orchestra's core job** (cross-harness A2A with receipts, a cross-project inbox, a governor). DS-Bot is DSH-only with no watchdog [bot]. OpenClaw has no DSH target, changes weekly and is single-owner [oc]. Grok Bot is closed [grok].
- **Lightweight OpenClaw clones** share a channel router, per-agent workspace and memory, a scheduler and an isolation boundary; A2A is not in that core (inferred; [oc] NanoClaw/nanobot/ZeroClaw READMEs).
- **Partial convergence:**
  - grok-build keeps identity across activations (`GB/crates/common/xai-message-delivery-core/src/identity.rs:12-14,58-60`) and never accepts a session id as an address (`address.rs:1-9`), but it addresses every *non-workflow* child (`address.rs:46-57`). "Clones are never addressable" (D2) is our policy, not convergent evidence.
  - A designated responder answers unaddressed messages (Koishi `assignee`, `K/middleware.ts:210-212`; DS-Bot admin mode).
  - With no matching binding, OpenClaw falls back to a caller-supplied, default or sole agent, else a config error (`D/concepts/agent-bindings.md:65`). Asking the human per message (§9.2 step 10) is our own choice.

So D2, D7 and D9 stand. The survey adds ~20 delivery, authority and termination rules plus a requirements delta.

## Candidates

| Project | What it is | Stars, license, activity | Lang |
|---|---|---|---|
| **DS-Bot** | DSH plugin: bots over rotating parts, `message_bot`, groups, steward [bot]; you run 0.1.7+fork.1 | 4,112, Apache-2.0, ~120 issues/week (126 opened 10-19..26) | JS |
| Tobs (BotHarness/DeepSeekBot) | Second DSH "GrokBot replacement"; not studied [grok] | 337, MIT, since 2026-09-16 | TS |
| **OpenClaw** | Gateway owning channels, agents, sessions; 19 acpx targets incl. claude, codex, grok-build, plus `pi`; no DSH (`D/tools/acp-agents/quickstart.md:84-108`) [oc] | 393,139, MIT, 7 releases in Oct, ~5.1k open issues (~7.9k incl. PRs) | TS |
| **Koishi / cordis** | Chatbot framework; DSH vendors cordis 4.0.5 (`$DSH\cordis\package.json`): siblings [km] | 9,410 / 6,288 MIT; webui AGPL-3.0 | TS |
| **MaiBot** | QQ group persona agent; planner and gates decide when to speak [km] | 6,607, GPL-3.0, v1.3.15 | Py |
| **Grok Bot** (xAI) | Always-on agents, chief-of-staff bot, groups, routines (x.ai/news/introducing-grok-bot). Bundle signed by Anysphere (`GBR/PROVENANCE.md:7,20`): built or shipped by it (inferred) | Closed; beta since 2026-08-11 | — |
| ↳ GBR | TypeScript "reconstructed and extended" from the Grok Bot 0.18 binary | 3,538, **no license**, archived | TS |
| ↳ xai-org/grok-build (GB) | Harness + TUI with `bot_relay`, `xai-message-delivery-core`, `xai-workflow` | 27,552, Apache-2.0, last sync 2026-09-29 | Rust |
| **Letta → letta-code** | Persistent `agent_id`, MemFS, groups, Workflow tool [a2a] | 25.3k / 3.7k, Apache-2.0 | Py/TS |
| **Paperclip** | Task-centric "agent company", heartbeats, budgets [a2a] | 107.6k, MIT | TS |
| **OpenAI Agents SDK** / **Google ADK + A2A** | In-process handoffs / agent tree + A2A protocol [a2a] | 30.3k MIT / 22.0k + 26.3k Apache-2.0 | Py |
| **AutoGen → MS Agent Framework** | Selectors, termination conditions, Pregel workflows [a2a] | 61.6k (archived) / 14.3k MIT | Py/.NET |
| **CC agent teams** / **CC cross-session** / **Codex collab** | JSON mailbox files, "sent" = write (`CC-T`) / per-session socket or named pipe with `crossSessionInbound` accept/hold/refuse (`CC-X`) / `AgentPath` tree with mailbox retention [a2a] | proprietary / 131k Apache-2.0 | —/Rust |
| **AstrBot / LangBot** | IM bot pipelines [a2a] | 43.8k AGPL-3.0 / 18.5k Apache-2.0 | Py |

**Grok Bot identification.** No official Grok Bot source release was found ([grok] `gh api orgs/xai-org/repos`; [a2a]; [cv]). Three candidates for "grokbot 早期开源出来的代码", unranked because no method supports a ranking:
- **GBR** (created 2026-08-23, 12 days after launch; no license; archived). Its README says "reconstructed and extended", with names and module boundaries inferred from the compiled app; its NOTICE grants no license. **Not** Grok Bot source.
- **grok-build** (2026-07-16, Apache-2.0): what xAI actually open-sourced; later syncs carry relay and delivery plumbing.
- **`xai-org/grok-prompts`** (2025-05-15, AGPL-3.0): xAI's own early release for "the `@grok` bot on X": prompts, not code.

Patterns cite grok-build first; GBR-only details are marked "reconstruction" (Q-A). `gawkbot` was seen, not studied.

## Pattern matrix

| Dimension | DS-Bot [bot] | OpenClaw [oc] | Grok Bot/Build [grok] | Agent frameworks [a2a] | Harness-native [a2a][cv] | Chat bots [km][a2a] |
|---|---|---|---|---|---|---|
| **Identity** | Bot id = first Session id | `agentId` + workspace; human approves new agents | `AgentId` ≠ `AttemptId`; opaque address | Letta persistent id; Paperclip Ed25519 key | CC names; Codex `AgentPath` | Koishi aid↔(platform,pid) |
| **Rotation** | Steward compact\|switch at 0.8 + handoff note | Stable key, rotating sessionId; memory flush first | New attempt per resume/fork | Letta: many conversations, one id | Codex mailbox kept while unloaded | One loop per chat |
| **Who answers** | Admin, `@Name` anywhere, round-robin, `[PASS]` | Binding, else default owner, else config error | `@handle` anywhere, else all; rotating | Selector, then validated LLM | Lead assigns or self-claim | Koishi assignee + leading mention; MaiBot gate |
| **Inbox** | steer/followup, auto-reply, merge, `request_id` | Admission ≠ reply receipt; ping-pong removed | No auto-reply; Pending→Projecting→Delivered | Paperclip coalesced wakes; Letta no receipt | CC teams "sent" = write; CC cross-session accept/hold/refuse; Codex QueueOnly | LangBot 1.5 s merge |
| **Memory** | bots/groups/team; journal | Markdown + daily notes | ≤500-char facts, 30-day half-life | ADK `user:`/`app:`/`temp:` | Teammate lacks lead history | MaiBot `[use, learn]` |
| **Schedule** | DSH `schedule` | One scheduler; heartbeat retired | Routines ≤50 per agent | Paperclip heartbeat | CC `notify_when_idle` 12 h | MaiBot random speech |
| **Caps** | Relays members×3; no watchdog | Depth 5, children 5, concurrency 8; loop detection | Room 3 rounds/10 turns; workflow 128 calls | Composable termination; `max_stalls=3`; 80/100% | Codex depth 1; CC ≤50 queued | Middleware depth 64 |
| **Authority** | `source.kind:'bot'` | `isUser=false`; env marker | Typed `Principal` + `OperationSet` | Paperclip no inherited authority; Letta mail as `system` | CC mail can't approve; denials not relayable | Authority 0–4 |
| **UI** | Capsule | Roster | FleetView | Task board | Run tree | Console |

## Patterns Orchestra adopts

| # | Pattern | Source | Lands in | Acceptance test (zero-token CI) |
|---|---|---|---|---|
| A1 | **Musician-only addressing.** Only Musician ids are addresses; Part ids (incl. `replyTo`) re-resolve to the current Part. Refusals: `raw-session-id`, `stale` (archived Musician), `foreign`, `unresolved`, `clone-not-addressable`, `template-not-addressable` | `GB/.../address.rs:86-127` (`RawSessionId`, `Foreign`, `Stale`, `WorkflowNotAddressable`, `Unresolved`). Clone/template refusals are our policy: GB addresses ordinary children (`:46-57`) | §6.1, §6.3; M1 | Raw sessionId, Clone or template target refused with its code; a reply after two rotations and a restart reaches the Musician |
| A2 | **Mail goes to the Musician and survives Part release.** `accepted` (journaled) precedes `delivered`. Admission (`queued\|steered\|held`) is reported apart from reply delivery, with `sentBeforeError` | `CX/agent/control/mailbox.rs:1-2,72-75`; `CC-T`; `D/concepts/session-tool.md:379-399` | §6.3, §8.2, §10.4; M1 | Sending to a released Musician respawns its Part and delivers once, even if the daemon dies mid-way |
| A3 | **Silence is valid; nothing is dropped.** reply/notice/progress never open a Work or auto-reply. `wake: turn\|none`, `none` for notices. Ack-only replies arrive as receipts without a wake (`replied(suppressed)`), so waits never hang. Ack-only = sender set `replyFormat:'none'`, or short body without refs | OpenClaw ping-pong removal (`D/releases/2026.10.1.md:1182`; `D/tools/acp-agents/delivery.md:80-86`); Codex QueueOnly; CC#47930 (no-op acks ~13%, up to 22%); `GBR/.../agent-messaging.ts:46,115` (reconstruction) | §8.1, rule 9; M1 | "Thanks" ends after one reply; the sender's wait returns `replied`; a notice starts 0 turns |
| A4 | **Typed authority, one field.** Extend §8.1 `trust` with `runtime`; no separate `principal`. `human` = paired UI; `agent` = bound Part; `unbound` = same-user process without a Part; `external` = imported; `runtime` = daemon-computed. Agents only `queue\|steer`; `interject`/`interruptAndSend` human-only. Mail is attributed data, never `system` | `GB/.../envelope.rs:4-18,92,111`; `CX/context/inter_agent_message.rs:53,66`; anti-example Letta `multi_agent.py:77-86` | §8.1, §8.5; M1 | Agent code cannot construct `human`/`runtime`; an agent interrupt is refused |
| A5 | **Authority-chain hygiene.** Relayed or computed text never carries human authority; denials are not relayable (`CC-T`). (inferred) Record denials on `rootId`; the same action class elsewhere in the root escalates "denied upstream". No CLI has approve/resolve/kill (D8, §10.11 #4); CLI `send` uses the agent pipe, else `unbound`. `ORCHESTRA_PART` env marker = UX hint only | `CC-T`; CC#96640, CC#65784; `OPENCLAW_SHELL` (`D/concepts/session-tool.md:432-439`) | §8.5; M2 | Deny X for Aiko; Aiko asks Ren for X; Ren's card shows the denial. Unsetting the env var gains nothing |
| A6 | **Inbound policy per Musician:** accept/hold/refuse by permission class, human-changed only. Agent-only holds expire in 5 min; holds awaiting human release follow the approval timeout (Q4) and focus-mode pause. ≤100 held, ≤50 queued; repeats dropped; send ≠ visibility | `CC-X`; `D/concepts/session-tool.md:230-248,278-284` | §6.1, §8.5; M2, hold M3 | Expired hold → P2 item; agent policy change refused |
| A7 | **Re-admission under current policy.** Endpoint = (Musician, project, inbound policy), not a Part: the Job kills owned Parts on a crash (§5.4). Input id reused; sender never re-run | OpenClaw needs the exact sessions to exist (`D/concepts/session-tool.md:286-308`); its sessions persist, ours do not | §8.3; M2 | Policy revoked → refused; intact → resumed once (§8.3 b) |
| A8 | **One execution owner per Work** (`executionPartId`): self-wakes coalesce, others defer. Steers reach the working Part. Queued Exchanges are editable | Paperclip `plans/2026-02-20-issue-run-orchestration-plan.md:46-66`; DSB-D#527, DSB-D#207 | §6.1, §8.3; M1 edit, M3 owner | A steer to a Musician busy in a Room lands in that Room's Part |
| A9 | **Check-in and stall counter.** Wake the asker once after N exchanges or T minutes, plus an InboxItem. "No progress" = no new diff, test, ref or Decision. Escalate at 3 stalls; never auto-replan | DSB-D#501; `AG/.../_magentic_one_orchestrator.py:262-297` | §10.7; M1, stall M3 | Non-converging delegates → one check-in, then P1 |
| A10 | **Room hygiene.** Only a *leading* mention routes (Koishi; a deliberate departure from DS-Bot and GBR, which route body mentions). Human sets the admin; strict-prefix room commands need human trust. ≤6 members, 3 rounds, 10 member turns, 2 messages/turn, rotating order. Quiet latch after K PASS. Debounce ≤8 s (mentions 1 s). Router failure = PASS | `K/session.ts:138-187`; DS-Bot `src/shared/mentions.js:1-3,52`; caps `GBR/host/groups/group-chat.ts:1` (reconstruction); `M\src\chat\heart_flow\heartFC_chat.py:225-240`; `MU/src/chat/debounce/README.md` | §9.2 step 4, §10.7; M3 | Quoting "@Ren said…" routes nowhere; the room halts at its round cap |
| A11 | **Ask, never default.** The step-9 LLM picks only from step-5 survivors; per-Musician handoff ACL; static fallback below N labels | `AG/teams/_group_chat/_selector_group_chat.py:163-198`; `MU/src/maisaka/turn_trigger/dynamic_gate.py:1-28` | §9.2; M4 | An LLM choice outside the candidates is rejected |
| A12 | **Runaway details.** 3 identical tool errors end the turn; warn → block → end; 10th identical `wait` blocked; PID, duration, cwd stripped before hashing | `D/tools/loop-detection.md:11-17,91-95,189-208` | §10.3; M0/M2 | Repeats with varying PID still trip |
| A13 | **Rotation breaker.** Deterministic vs transient failures; cap rotations per hour; verify the old Part archived; backoff + InboxItem | DSB#485 (1,971 `runSwitch` frames, then OOM); anti-example MaiBot `heartFC_chat.py:497-501` | §10.4; M1 hourly cap, M3 rest | A missing-key fixture → ≤3 attempts, P1, no OOM |
| A14 | **Budget incidents.** Soft 80%, auto-pause 100%; one open incident per policy, threshold and window; cost rolls up to `rootId`; calls carry `purpose` | Paperclip `doc/SPEC.md:410`, `doc/plans/2026-03-14-budget-policies-and-enforcement.md:114-115,232`; `CX/agent/control/budget.rs:12-16`; MaiBot `request_type` | §10.2, §11.5; M2 | 3 crossings of one threshold in one window → 1 incident |
| A15 | **Watcher protocol** for primary agent and Maestro: coalesced byte-stable notices, frozen watermark, no self-notice, `changesSince` + `historyGap`; SSE `{upserted, removed}` + resync frame; dead after 4× keepalive silence | `D/concepts/session-state.md:95-103`; `GB/.../agent/roster.rs:1-32`; `agent/relay.rs:18-22` | §5, §11.2; M2/M3 | The polling-token share on a replay stays under its threshold |
| A16 | **Thin completions**: status, bounded summary and refs; truncation flagged | OC#96975, CC#67684, DSH-D#10115 | rule 1; M1 | A 200 KB reply arrives as summary + ref, marked `truncated` |
| A17 | **No self-replication.** Typed requests to create Musicians or routines; a human approves | `D/concepts/multi-agent.md:95-110`; anti-example Grok's "aggressive" routine prompt | §8.6; M1 | `orchestra_request_musician` creates only an InboxItem |
| A18 | **Freeze injected context per Part.** Lane-contract personas (owns / does-not-own / chat budget / handoff) + DS-Bot's 沟通纪律 (communication rules) | `GBR/host/runner/sand-memory.ts:24-38` (reconstruction); `D/.../parallel-specialist-lanes.md:99`; DSB-D#322 | §11.6, §11.7; M1 | Persona and injected block are byte-identical across a Part |
| A19 | **Routines as Reminder v2**: trigger, `expiresAt`, quiet hours, pause after auth failures; payloads are data. ≤50 per Musician, last 20 runs kept, ≤25 events per wake | `GBR/host/automations/automation.ts:9,11,13` (reconstruction) | §6.1 Reminder; M3 | An expired watch stops firing |
| A20 | **Separate read/write flags per memory scope**, plus share groups | `M\template\bot_config_template.toml:66-87` | M5 | A read-only scope rejects a write |

## Patterns Orchestra rejects

- Automatic agent↔agent multi-turn exchange (OpenClaw, retired): echo loops (A3).
- Random speak probability, self-rated frequency (MaiBot): unauditable; principle 5.
- Unvalidated LLM speaker choice (Letta `dynamic`, AutoGen fallback): A11.
- Agents interrupting agents (`GBR/.../agent-messaging.ts:92-93`): human-only (A4).
- Mail injected as `system` or `user` (Letta; DSH ACP `{kind:'user'}`, §8.5): privilege escalation.
- Blocking request/reply (Letta `wait_for_reply`): "end your turn" stays default.
- Loops unbounded or ended by an LLM token (ADK `LoopAgent`, MAF, Letta "DONE!"): hard caps.
- Full-transcript handoffs (OpenAI default, MAF): handoff notes + refs instead.
- Synthesized human turns, automatic plan approval (MAF `_handoff.py:237-238`; CC teams): fabricated authority.
- Default visibility `all` (`D/concepts/session-tool.md:529-533`): project scope instead.
- cwd-only isolation, skill auto-install (OpenClaw/ClawHub, secondary source).
- Client-chosen permission mode (`GB/.../leader/protocol.rs:176-190`): D5.
- Heartbeat-specific scheduler (OpenClaw retired it): D10. LLM-merged memory as decisions (MaiBot `MemoryChest`): R12.
- Dropping caps to save runs (DSB-D#501): caused A9's stall.
- Hosting on OpenClaw: no DSH target, weekly churn, a 1,722-line `restart-recovery.md` (Q-C).
- Copying GBR, MaiBot (GPL-3.0), webui or grok-prompts (AGPL-3.0) code. A cloud relay (Grok Bot): local-only scope.

## Community findings → requirements delta

**Confirmed** [cv]: R02 DSB-D#197/#331/#463; R03 DSH-D#9523; R04 wait/status polling at 19.8% of tokens (CX#35259); R05 DSH-D#8740, CX#13947; R06 DSH-D#131, DSH-D#10655; R07 DSB#485, OC#159612; R08 DSB-D#501; R09 DSB#469; R11 DSB#506, CC#94624, OC#44925; R21 DSB#513, DSH-D#11062; R22 DSB#564; R23 DSB#534; R27 CX#9748, CC#91532.

**New** (priority; evidence):
- R29 stalled-delegation check-in, A9 (P0; DSB-D#501, OC#44925).
- R30 liveness age in roster; flag "promised work, no tool call" (P1; DSH-D#6216, DSB#469).
- R31 edit a queued Exchange; steer reaches the working Part (P1; DSB#534, DSB-D#527).
- R32 rotation breaker, A13 (P0; DSB#485, DSB#571).
- R33 workflow-run adapter: observe, admit, deadline, budget, never auto-relaunch; the M1 clamp is an R06 criterion (P1, M3; DSH-D#10655, CC#86777).
- R34 authority hygiene for computed tasks and A2A hops (P0; CC#96640, CC#100033, CC#65784).
- R35 protected `~/.orchestra`, private `DSH_HOME`s and locks (P0; DSB#513).
- R36 thin completions, A16 (P1; OC#96975). R37 per-Part delivery key checked on read (P1; OC#64199, CC#96546).
- R38 silence and wake control, A3 (P0; OpenClaw ping-pong removal; CC#47930 ack overhead).
- R39 per-Musician inbound policy, A6 (P1; `CC-X`). R40 typed requests to create Musicians or routines, A17 (P1; `D/concepts/multi-agent.md:95-110`).
- R41 pre-run fan-out cost estimate, landing with Arrangements (P1; CC#91532, CX#9748).

**Changes to existing requirements:**
- R21 becomes P0 for any A2A receiver.
- R27 is unchanged (P2, M5, step 8b); the fan-out estimate is R41 instead.
- R16's read-only tree of *native* workflow runs moves from M5 to M3; the Arrangement circuit lands with Arrangements.
- R23 is scheduled after R29 and R31.
- New acceptance criteria: R04 polling-token share; R11 the `accepted` receipt and delivery to a released Part; R06 budget-incident dedup and the workflow clamp (0 `ACTIVATION_LIMIT_REACHED`).

## Amendments to the spec

- **§0.4 / §2.3** (Ren and Aiko reply 「已更新」 to a Decision notice): Decision notices are `wake:none`, injected at the next Part start (§11.6); the receipt shows "read", not a reply.
- **§2.1 row 2**: + "a notice doesn't wake; a reply never triggers a reply".
- **§3.2**: + no automatic agent↔agent exchanges; no agent-created Musicians.
- **§4**: + **D13** two-layer workflow merge (companion); **D14** Musician-only addressing (A1); **D15** `trust` + `runtime` (A4); **D16** silence and wake (A3).
- **§6.1**: Musician `inbound`, `handoffAcl`, `laneContract`, kind `template`; Part `attempt`; Work `executionPartId`, `stallCount`, `checkInAt`; Exchange `op`, `wake`; LedgerEntry `purpose`, `rootId`; new `BudgetIncident`.
- **§6.3**: + `accepted`, `held`, `replied(suppressed)`; A1 refusal codes plus `policy`, `held-expired`. **§6.5**: + `stalled-delegation`, `rotation-breaker`, `budget-incident`, `held-message`, `musician-request`, `workflow-run`.
- **§8.1**: `trust` += `runtime`; + `op`, `wake`, `replyFormat`. **§8.5**: A4–A6.
- **§8.3**: rule 1 thin completion; rule 4 8 s/1 s debounce + `collect`; new rules **9** silence, **10** re-admission, **11** check-in; restart phases Pending / Projecting / Delivered.
- **§8.6**: `orchestra_send → {exchangeId, admission, code, sentBeforeError?}`; + `orchestra_request_musician`.
- **§9.2**: step 4 leading mentions, human-set admin, quiet latch; step 9 candidates only; step 10 a router failure asks the human.
- **§10.2–10.4**: A14, A12, A13. **§10.7 / §10.12**: + stall 3, check-in N/T, Room caps 6/3/10/2, hold 5 min/100, queue 50, debounce 8 s/1 s.
- **§12.2**: GBR: no further code reading, README-level reference only. grok-build Apache-2.0: design reuse needs no NOTICE; copied code keeps its LICENSE and attribution in Orchestra's third-party NOTICE (grok-build has none). MaiBot GPL-3.0, webui and grok-prompts AGPL-3.0: design-only. cordis, Koishi, OpenClaw, Paperclip MIT.
- **§13**: M1 A1–A4, A13 hourly cap, A16–A18. M2 A5, A6, A7, A12, A14, A15. M3 A6 hold, A8–A10, A13 rest, A19. M4 A11. M5 A20. Update each cut order.
- **§15**: + (inferred) the patterns add ~3–4 weeks to M1–M3 (≈28–29 weeks solo); cut first A19, A15 extras, A10 defaults beyond the caps.
- **§16 / §17**: + R29–R41 and the changes above; + Q-A to Q-E.

## Open questions for the user

- **Q-A.** Which "grokbot" did you mean: GBR, grok-build, `xai-org/grok-prompts`, or a forum link? Keep GBR-only details (labelled) or drop them? Delete the fetched GBR raw content in the session scratchpad (`gbr\raw`)? Is any design reference to unlicensed reconstructed code acceptable under MIT (Q9)?
- **Q-B.** Auto-reply by message role (requests yes, notices never), or every reply explicit like Grok? Recommendation: by role.
- **Q-C.** Ever federate OpenClaw as a harness host (`dsh --profile acp` as a custom acpx agent, untested)? Recommendation: reference only.
- **Q-D.** Ship the `everyone` room mode in M3? MaiBot needed months of logs for its fitted gate. Recommendation: admin plus leading mentions only.
- **Q-E.** Study Tobs? Grok Build as a fourth harness? It speaks ACP, keeps `~/.grok/sessions` (dsh-TUI has a parser); Windows binaries exist, source builds best-effort (`GB/README.md:43-47,72`).
- **Also to confirm:** the R29 N/T defaults and which budget pays for the check-in. DS-Bot routes body mentions (`mentions.js:52`), so a DS-Bot Section imported in M4 behaves differently from Orchestra Rooms; acceptable?

## Review log

Two red-team reviews (facts, design), 2026-10-26; claims re-checked via `gh api`, local DS-Bot/DSH files and spec lines.

**Accepted:**
- GB addresses ordinary children: A1 re-cited (`address.rs:46-57,86-127`), `unresolved` added, Clone/template refusals = our policy.
- A10 leading-only is Koishi-derived; DS-Bot and GBR route body mentions.
- A19 20 = run history kept. A14 re-cited, "per threshold".
- CC#47930 is ack overhead (R38); R04 keeps CX#35259.
- OpenClaw bindings fall back to a default owner. A5 path fixed; rootId propagation (inferred).
- ACP targets (19 + `pi`); DS-Bot ~120 issues/week; OpenClaw ~5.1k issues.
- `principal` folded into `trust` + `runtime`; R27 untouched, new R41.
- Anysphere via PROVENANCE; 12 days; archived; Windows binaries; NOTICE wording; CC teams vs cross-session split.
- GBR probabilities dropped; grok-prompts listed; GBR details labelled; §12.2 README-only.
- No CLI approve; env marker UX-only. A3 never drops replies; §0.4/§2.3 amendment.
- Musician-only addressing; A7 endpoint; human holds follow Q4.
- Milestones rebalanced, §15 risk row, D14 split into D14–D16, durability gap blocking.

**Rejected or partial:**
- Writing the six reports and committing `docs/` is outside this task's write scope, so it is recorded as blocking.
- "`stale` only for raw session ids": `raw-session-id` covers those, so `stale` means an archived Musician.
- Re-sourcing GBR patterns from grok-build needs new research, so they are labelled instead.

**Uncertain:** the x.ai post's lack of an Anysphere mention and Koishi `session.ts` lines were not re-checked; the week estimate is inferred.
