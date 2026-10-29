# W1 — Harness-native goal loops: Claude Code, DSH, Codex

Lane W1 of the 许愿式编程 research (brief dated 2026-10-27). Question: when you give each harness a wish and let it run, how does the wish become a plan, who decides "done", how does the loop end, what survives a restart, what bounds cost, and what breaks? All fetches and local reads were made on 2026-10-27.

## Evidence keys

| Key | Source |
|---|---|
| **CC-GOAL** | https://code.claude.com/docs/en/goal (fetched as `.md`; line numbers refer to that copy) |
| **CC-HOOKS** / **CC-HG** | https://code.claude.com/docs/en/hooks and `/hooks-guide` (`.md`) |
| **CC-WF** | https://code.claude.com/docs/en/workflows (`.md`) |
| **CC-SCHED** | https://code.claude.com/docs/en/scheduled-tasks (`.md`) |
| **CC-SDK** | https://code.claude.com/docs/en/agent-sdk/typescript, `/agent-sdk/agent-loop`, `/agent-sdk/permissions` (`.md`) |
| **CC-PM** | https://code.claude.com/docs/en/permission-modes (`.md`) |
| **CC-BIN** | `C:\Users\Calx\.local\bin\claude.exe`, embedded `VERSION:"2.1.310"`, read with `grep -a` / `dd` only; `@n` = byte offset |
| **DSH:** | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`, version 0.2.1-rc.2 |
| **CX@aa854da** | github.com/openai/codex `main` at commit `aa854dab…` (2026-10-27T19:11Z), read with `gh api` |
| **CX-BIND** | `G:\_Projects\dsh-TUI\src\backends\codex\protocol\generated\` (bindings generated from Codex 0.160.1) |
| **CX-CB** | https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex (no date on the page; it says Goals arrived in 0.128.0) |
| **CC#n / CX#n** | Issues in anthropics/claude-code and openai/codex. Reporter claims, not reproduced here. |
| **DSH-D#n** | Discussions in deepseek-ai/deepseek-harness (issues are disabled on that repo). Reporter claims, not reproduced here. |
| **[spec] §x** | `docs/specs/2026-10-27-dsh-orchestra-design-r3.md` |

## 1. Answer first

1. **All three harnesses now ship a persisted "goal" loop.** They are Claude Code `/goal`, DSH `dsh-goal` plus `goal-round-driver`, and Codex Goals (`thread/goal/*`, Stable and on by default). All three are single-session and single-objective, and all three continue at idle (CC-GOAL:9; DSH:dsh-goal/README.md:12; CX@aa854da `codex-rs/features/src/lib.rs:2060-2065`).
2. **None of them has an independent verifier with tool access by default.**
   - Claude's `/goal` evaluator is a separate small model that reads the transcript only (`tools:[]`) (CC-BIN@256582544; CC-GOAL:56,173).
   - DSH lets the working model decide, and its own READMEs list "No independent evaluator" as a limitation (DSH:dsh-goal/README.md:159; dsh-goal-round-driver/README.md:125).
   - Codex also lets the working model decide, through a long "completion audit" prompt (CX@aa854da `templates/goals/continuation.md:35-46`).
   - The only tool-using verifiers are Claude's experimental `type:"agent"` Stop hooks (CC-HG:877-881) and deterministic command or `TaskCompleted` hooks.
3. **Their budget models differ, and the budget is reset or missing in exactly the places that matter for unattended runs.**
   - DSH meters only rounds (DSH:dsh-goal/README.md:158).
   - Claude meters no tokens inside `/goal`. Its turn count, timer and token baseline reset on every resume (CC-GOAL:104; CC-BIN restore path sets `iterations:0, tokensAtStart:dy()`). SDK `maxBudgetUsd` ignores spend restored from a resumed session (CC-SDK typescript.md:525).
   - Only Codex keeps a per-goal `tokenBudget`, `tokensUsed` and `timeUsedSeconds` (CX-BIND `v2/ThreadGoal.ts`).
4. **They disagree on restart.** DSH disarms an active goal after any session-start edge "until an explicit human-authorized resume" (DSH:dsh-goal-round-driver/README.md:57). Claude restores the goal on every resume route (CC-GOAL:102). Codex re-arms an `Active` goal on resume (CX@aa854da `ext/goal/src/runtime.rs:412-433`).
5. **The dominant field failures:**
   - false "done" (CX#53814, CX#56927, DSH-D#10710);
   - endless re-prompting when the last step needs a human or is refused (CC#100010, CC#98066, CX#50767);
   - spinning while waiting on background work or the clock (DSH-D#6169, DSH-D#9607, CC#83266);
   - goal drift after compaction (CX#31659);
   - goals started without real consent (CX#41838, DSH-D#11098);
   - token blow-ups (DSH-D#7894: 642M tokens in one session).
6. **The harnesses' own fixes are worth copying, and none of them requires an LLM.**
   - Claude: a block cap; a stop when the model makes no tool calls; evaluation deferred while background work runs; check-ins with backoff.
   - Codex: a "verified wait" versus "no progress" classification, and a system-owned `budget_limited` state.
   - DSH: a durability flush before each round, and no automatic retry.
7. **For Orchestra the conclusion is division of labour.** The harness goal loop is at most the *inner* layer, and for owned musicians it stays off (as [spec] §7.4 already does for DSH). Orchestra must own three things: the "done" decision (an independent verifier plus your acceptance), the budget across restarts, and the decision to start another round.

## 2. Comparison

| | Claude Code 2.1.310 | DSH 0.2.1-rc.2 | Codex (main, 0.160.1 bindings) |
|---|---|---|---|
| **Wish → plan** | Plan mode (`ExitPlanMode`, human approves; edits blocked outside interactive bypass sessions, CC-PM:292,661). A Workflow script is the plan as code, approved before launch in interactive modes, but **no prompt under `-p` or the SDK** (CC-WF:175-180). `/goal` is a condition with no plan. Tasks (`TaskCreate`/`TaskUpdate`) track steps. | `/plan` and `exit_plan_mode`; "every tool remains available", so plan mode is advisory (DSH:dsh-plan-mode/README.md:12). Plan guidance asks for "goal and success criteria… acceptance criteria" (DSH:dsh-base/cordis.patch.yml:344). Session-scoped `todo_write`. | `ModeKind = "plan" \| "default"`. `turn/plan/updated` carries steps `pending\|inProgress\|completed` (CX-BIND). Goal objective plus optional token budget. CX-CB template: "<end state> verified by <evidence> while preserving <constraints>". |
| **Who decides done** | `/goal`: a fresh small model judging transcript evidence only, with verdicts met / not met / impossible (CC-GOAL:120-124; CC-BIN@256582544). Optionally an agent hook with tools, up to 50 turns (CC-HG:877-881), or a command hook. A `TaskCompleted` exit 2 blocks completion (CC-HOOKS). | The working model. `complete` is allowed in any goal round immediately. `blocked` is accepted only after 3 consecutive rounds (DSH:dsh-tool-goal/README.md:48,55). Ralph: the worker "self-declaration" with an `evidence` field (DSH:dsh-tool-ralph/README.md:69,161). | The working model via `update_goal(status:"complete")` after a prompted requirement-by-requirement audit (continuation.md:35-46). `blocked` needs 3 consecutive turns (:48-54; `spec.rs:66`). `budgetLimited` and `usageLimited` are set by the system only (`tool.rs:253-257`). |
| **Termination** | Met or impossible. Stop-hook block cap of 8, reset by any tool call (CC-HOOKS:2738). No tool use for several turns → loop stops, goal kept (CC-GOAL:126). Four fatal errors clear the goal; other errors retry 3× (1/5/15 min ±20%) then pause, **interactive only** (CC-GOAL:130-148; CC-BIN `$s=[60000,300000,900000]`, `isNonInteractiveSession` early return). Workflows: 1,000 agents per run, at most min(16, CPUs−2) concurrent, ≤5 stall restarts per agent (CC-WF:356-362,413-419). | Round cap, default 256 (`defaultMaxGoalRounds`); the Ralph bundle sets 64 (DSH:dsh-experimental-ralph-bundle/cordis.patch.yml:16). Hitting the cap is a `round-limit` blocker. Also stops on max tokens, a failed durability write, cancel or unload (DSH:dsh-goal-round-driver/README.md:53). | Complete or blocked by the model. Turn error → `Blocked`; empty response → `Blocked`; usage limit → `UsageLimited`; token budget → `budget_limited` with a wrap-up prompt (`runtime.rs:314-340`; `budget_limit.md:14-16`). No tool call → next continuation suppressed (CX-CB). |
| **Checkpoint / resume** | Goal restored on resume, counters reset (CC-GOAL:102-104). Workflow: replay of saved results in agent-start order; the first changed prompt, the first failure, and everything after re-run. A run does **not** continue after you leave the session (CC-WF:374-398). Cron tasks are session-scoped, capped at 50, expire after 7 days, and do not catch up (CC-SCHED:170,209,236-240). | Event-sourced `goal/change` with CAS revisions in the session log (DSH:dsh-goal/README.md:97-100). Continuation is process-local and disarmed after resume or fork (:72,99). The checkpoint policy flushes before each model request, tool body and step, and recovers an interrupted tool call as unknown, with no retry (DSH:dsh-session-checkpoint-policy/README.md:12). Schedule can deliver twice after a crash (DSH:dsh-schedule/README.md:65). Ralph is foreground only, with no resume checkpoint (DSH:dsh-tool-ralph/README.md:162). | Goal in the state DB. `restore_after_resume` re-arms `Active` (`runtime.rs:412-433`). Continuation starts only via `start_turn_if_idle` (`runtime.rs:436-500`). |
| **Cost control** | None inside `/goal` except a turn or time clause the evaluator judges from text (CC-GOAL:66). SDK `maxTurns` / `maxBudgetUsd` per call (CC-SDK agent-loop.md:194-197). Workflow `budget` = the turn's "+500k"-style output-token target, a **hard** ceiling; with no target, `remaining()` is `Infinity` (CC-BIN@276779707). The "Large workflow" warning is advisory (CC-WF:443-445). | Rounds only. "Round cap, not resource budget" (DSH:dsh-goal-round-driver/README.md:128; dsh-tool-ralph/README.md:167). | Per-goal `tokenBudget` with persisted `tokensUsed` and `timeUsedSeconds` (CX-BIND `v2/ThreadGoal.ts`). Deployment ceiling `max_goal_token_budget` (`tool.rs:212-213`). `rollout_budget` (shared across agent threads) is UnderDevelopment and off (`features/src/lib.rs:2079-2083`). |
| **Who may start a loop** | `ultracode` keyword only from `origin:{kind:"human"}`, not from `-p`, unstamped SDK, scheduled or relayed text (CC-WF:131-136). Script-computed `agent()` prompts are not user requests (CC-WF:311). | `create/edit/pause/resume` require a host-attested `{kind:'user'}` message in a root agent's current turn (DSH:dsh-tool-goal/README.md:55,72). Schedule deliveries are producer `schedule`, not user (DSH:dsh-schedule/README.md:125). | Tool description says "only when explicitly requested", but `handle_create` has **no provenance check** (`spec.rs:46`; `tool.rs:204-230`). |

## 3. Claude Code

**The Stop-hook substrate.** A `Stop` or `SubagentStop` hook that returns `decision:"block"` plus a `reason` (or exits 2) sends Claude back to work. `additionalContext` does the same with gentler transcript labelling (CC-HOOKS:2798-2826). Two loop guards exist:
- `stop_hook_active`, which a hook must check itself;
- a cap of 8 consecutive continuations, which "resets each time Claude calls a tool" (CC-HOOKS:2736-2738; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 0 disables).

The second property matters: a model that makes one cheap tool call per turn can loop indefinitely under the cap (inferred from the reset rule). The Stop input now carries `background_tasks` and `session_crons`, so a hook can tell "done" from "paused waiting for a wake-up" (CC-HOOKS:2744-2770).

**`/goal`** is "a wrapper around a session-scoped prompt-based Stop hook" (CC-GOAL:120). The binary registers it as `{type:"prompt", prompt: condition}` on `Stop` (CC-BIN, `sessionHooksRegistry.remove(…,"Stop",{type:"prompt",…})`). The evaluator system prompt says to answer "based on transcript evidence only", to default to `{"ok": false, "reason": "insufficient evidence in transcript"}`, and to treat the assistant's own "impossible" as "evidence, not proof". It runs with thinking disabled and `tools:[]` (CC-BIN@256582544). Three consequences:
- **Completion can only be as good as what the worker chose to surface.** The docs say so: "It doesn't run commands or read files independently" (CC-GOAL:56).
- **A human-only step looks like "not yet met" forever.** CC#100010 (OAuth sign-in only the user could do) and CC#98066 (auto-mode classifier denied `gh pr merge`; ~15 re-fires) show it. CC#94041 shows re-fires continuing after verifiable evidence of completion. The only exit was the 8-block safety valve.
- **A fork inherits the parent's goal directive** (CC#72659), and a loop can push the model to drastic action to escape (CC#67665, closed).

Recovery around `/goal`:
- Background work defers evaluation. A check-in comes due after 30 min, then doubles up to 4× (1 h, then every 2 h). At most 3 idle check-ins run between human prompts (CC-GOAL:150-163; `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`).
- CC#83266 (closed) shows the earlier bug this fixed: the session went idle indefinitely when background work ended.
- **Retries and idle check-ins are skipped in non-interactive sessions** (CC-GOAL:143,156). The binary returns early on `isNonInteractiveSession` (CC-BIN). Orchestra drives Claude through the SDK ([spec] §7.1), so it would get none of this recovery.

**Workflows.** "The script" decides what runs next (CC-WF:21-30), and replay is deterministic (CC-WF:328,374-386).
- `budget` exists and is a hard per-turn output-token ceiling shared with the main loop; [spec] §8.7 still marks it unverified (CC-BIN@276779707).
- With **ultracode** on, Claude "plans a workflow for each substantive task" and turns off the Large-workflow warning, the concurrent-subagent limit and, in auto mode, launch approval (CC-WF:140-156). This documents what [spec] §2.4 only assumed.

**SDK.** `maxBudgetUsd` is checked after each response and can be overshot (CC-SDK agent-loop.md:205). `SDKMessageOrigin` (`human`, `peer{fromMode}`, `task-notification`, `auto-continuation`, …) is the provenance hook. A user message with no `origin` has been "unattributed" since 2.1.210 (CC-SDK typescript.md:2414-2440).

## 4. DSH

**Goal = state + driver + tools, kept apart on purpose.**
- `dsh-goal` stores one objective per session: `active|paused|blocked|complete`, CAS revisions, strict replay (DSH:dsh-goal/README.md:56-68,97-101).
- `goal-round-driver` queues one `<goal_round>` prompt at whole-agent idle. Since rc.2 it waits until "progressing descendants settle" (DSH:dsh-goal-round-driver/README.md:49,53).
- The prompt tells the model to "verify the result. Before claiming completion, gather evidence…" (DSH:dsh-goal-round-driver/lib/index.js:15). That is an instruction, not a check.
- The tool policy makes completion cheap and blocking expensive. A goal round "may complete the goal immediately". A block is "mechanically rejected until the configured number of consecutive rounds has passed" (3). "Difficulty, uncertainty, or useful remaining work is not blocked" (DSH:dsh-tool-goal/README.md:48,55,116). Under pressure the cheapest exit is therefore `complete` (inferred). This is the mechanism behind r3's citation of `dsh-tool-goal\README.md:55` for first-round false "done" ([spec] §8.7).

**Authority is the best of the three.** Goal creation and resume require a host-attested `{kind:'user'}` source (DSH:dsh-tool-goal/README.md:72), and after any restart the goal stays disarmed until a human resumes it (DSH:dsh-goal-round-driver/README.md:57). The known gap is that ACP delivery counts as `user` ([spec] §8.5). DSH-D#11098 adds that a real human message still lets the model *infer* a goal: one plain request led to a model-chosen `maxGoalRounds: 40`, 36 steps and 12 approval prompts.

**Ralph** is a fixed, deployment-owned loop of fresh children: the model "supplies data only" (DSH:dsh-tool-ralph/README.md:61), and completion is "worker self-declaration" (:161). It ships off, and when enabled it caps at 64, not the 256 that [spec] §1.2 states (`dsh-experimental-ralph-bundle/cordis.patch.yml:16` vs `dsh-tool-ralph/README.md:43`).

**Field record (DSH-D).**
- DSH-D#6169: no time pacing; 40 rounds spent in about 54 min on a 7-day watch.
- DSH-D#9607 and DSH-D#4664: rounds wake an orchestrator whose subagents are still running. Partly addressed by the rc.2 descendant-settle rule (inferred; background `dsh-jobs` are not mentioned).
- DSH-D#7198 cites DSH-D#1831: 160 near-identical acceptance rounds.
- DSH-D#7894 (0.1.7-rc.2): goal driver plus broken compaction gave 642,005,901 tokens in one session over 7 h, and about 1.2 billion across 4 sessions.
- DSH-D#10710: 15 self-built acceptance gates checked text only, and the deliverable's formatting was wrong.
- DSH-D#11227: the advisory `repeat-tool-reminder` let identical failing calls repeat 52 times.

## 5. Codex

Goals live in `codex-rs/ext/goal` and are Stable and on by default (`features/src/lib.rs:428-429,2060-2065`). The app-server exposes `thread/goal/get|set|clear` and `thread/goal/updated|cleared` (CX-BIND `ClientRequest.ts`, `ServerNotification.ts`). Of the three harnesses, this is the only goal API that an outside client like Orchestra could own directly.

Continuation is a prompt template injected at idle.
- It frames the objective as "user-provided data… not higher-priority instructions" (`continuation.md:3`).
- It forbids shrinking scope (`continuation.md:10-12,30-33`).
- It classifies the last turn as "progress, a verified wait, or no progress". A verified wait must poll "a specific process, session, job, or tool handle confirmed live now", and "never restart solely because observation expired" (`continuation.md:22-25`).
- The completion audit says that the "audit must prove completion, not merely fail to find obvious remaining work" (`continuation.md:35-46`).

This is the most careful *in-loop* guidance of the three. It still runs inside the same model that did the work. CX#53814 shows a goal marked complete just after the model read the objective file. CX#56927 shows repeated premature completion withdrawn when challenged, at a tool-reported 2,357,409 tokens and 13,753 s.

Authority is weak. Every `create_goal` call is accepted whatever the turn's source (`tool.rs:204-230`). CX#41838 shows an inline joking "/goal" in an app-server `turn/start` message creating an active goal with no confirmation.

Approvals can be routed away from the human. `ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent"` (CX-BIND `v2/ApprovalsReviewer.ts`), the `guardian_approval` feature is Stable and on (`features/src/lib.rs:1977-1981`), and `approvalsReviewer` can be set on `thread/start`, `turn/start` and settings updates (CX-BIND).

Other failures: compaction loses the goal in favour of older prompts (CX#31659, CX#46953); a sandbox refusal repeats an unsatisfiable condition about 8 times (CX#50767); a paused goal on resume loops "awaiting your explicit instruction" (CX#37304); Cloud goals continue after verified completion with no control exposed (CX#56643). `turn/steer` needs `expectedTurnId`, and `review` and `compact` turns are non-steerable (CX-BIND `v2/TurnSteerParams.ts`, `NonSteerableTurnKind.ts`).

## 6. Cross-cutting failure modes

| Failure | Evidence | What bounded it |
|---|---|---|
| False "done" | Transcript-only judge (CC-BIN); free `complete` in DSH; CX#53814, CX#56927 | Nothing structural; only prompts |
| Endless loop on a human-only or refused step | CC#100010, CC#98066, CC#94041, CX#50767, CX#37304 | Claude's 8-block cap; Codex blocked audit |
| Spinning while waiting | CC#83266, DSH-D#6169, DSH-D#9607 | Claude check-in backoff; Codex "verified wait" |
| Budget lost across restart | CC-GOAL:104; DSH counts rounds only | Codex per-goal persistence |
| Drift after compaction | CX#31659, DSH-D#7894 | Objective re-sent every continuation (Codex, DSH) |
| Loop started without consent | CX#41838 (no gate), DSH-D#11098 (intent inferred) | DSH host attestation; Claude human-origin rule |

## 7. Implications for Orchestra

1. **Orchestra, not the harness, decides "done".** All three harnesses default to self-report or a transcript-only judge (§1.2).
   - The Wish layer should mark a step done only on three inputs: (a) a deterministic check from `Task.doneCriteria` ([spec] §6.1), run as a test or CI command; (b) a fresh verifier that has tool access and no access to the worker's narration (the M1 QA template, [spec] §13.3; Arrangement's adversarial-check template, §8.8); and (c) your acceptance for taste items (Decision, §11.6).
   - This extends §9.2 step 7 ("拒绝模型自评") from routing labels to completion. The rationale is the DSH asymmetry: completing costs nothing, while blocking costs 3 rounds.
2. **Keep native goal loops off in every owned musician, not only DSH.** [spec] §7.4 disables the DSH goal stack. Add:
   - Codex: `features.goals=false` in the private `CODEX_HOME`, checked in CI. `turn/start` from the Post Office is exactly the CX#41838 path.
   - Claude: assert no `/goal` or ultracode on owned Parts; workflows are already off before R33 ([spec] §8.7).
   - Codex: assert `approvalsReviewer == "user"` on every `thread/start` and `turn/start`, like the `approval: never` check for DSH. `guardian_subagent` is delegated approval, which D8 forbids (§10.9).
3. **Map trust onto each harness's provenance field.** [spec] §8.5 defines `trust` but does not map it to Claude's `SDKMessageOrigin`.
   - `human` only for messages you typed in Program.
   - A2A deliveries become `peer` (or are left unattributed). Since 2.1.210 an absent origin is no longer human (CC-SDK typescript.md:2414-2440).
   - This is the Claude-side twin of the DSH relay-source bundle (§8.5, §12.1). Add it to the R34 acceptance.
4. **The daemon decides the next round, by event, not by idle.** DSH-D#6169 and DSH-D#9607 show what idle-triggered rounds do.
   - Copy Claude's evidence-tested schedule into the open check-in defaults ([spec] §8.3 rule 11, §10.12 "N / T 待定"): defer while delegated work is live; first check-in at T = 30 min, doubling to at most 2 h; at most 3 unanswered check-ins, then `stalled-delegation` P1 (§6.5).
   - Refine "没有进展" (§10.7) with Codex's "verified wait". Polling a handle confirmed live counts as neither progress nor stall.
5. **A human-only step suspends the Wish. It never loops.**
   - When the remaining step is an approval, a denial, a `handoff` (§6.5), a sandbox refusal or a Decision, the Wish leaves the active loop for `waiting-human`. It is not resumed until you act.
   - A denied action is recorded once under `actionClass` and "上游已拒绝" (A5, §8.5), and the Wish never retries it.
   - This is what CC#100010, CC#98066 and CX#50767 lacked.
6. **Budgets belong to the ledger and survive restarts.** Claude resets its goal counters on resume, `maxBudgetUsd` excludes restored spend, and DSH counts only rounds.
   - Make the Wish a `rootId` so tokens and CNY roll up through `BudgetIncident` (§6.1, §10.2 A14).
   - Keep three hard caps per Wish: CNY (ledger), rounds (`roundCap`, §6.1), and wall-clock rounds per hour, which DSH-D#6169 shows is needed.
   - Codex's per-goal `tokensUsed` and `timeUsedSeconds` are the closest native analogue and can feed the ledger for observed Codex threads (M4).
7. **After a daemon restart the Wish resumes only when you click.** Adopt DSH's rule (DSH:dsh-goal-round-driver/README.md:57), not Claude's or Codex's auto-restore. A restart leaves the Wish `paused(restart)` with an InboxItem showing "n/m steps verified". This matches §3.2 (no v1 unattended autonomy) and §8.3 restart rule (b), which replays the interrupted turn once and never re-runs the original task. Auto-resume can be a later gate item with evidence (§14, Q11).
8. **Re-inject the Wish verbatim on every Part.** Compaction drift (CX#31659, DSH-D#7894) argues that the objective, constraints and acceptance list must be re-sent in full at each Part start and rotation. Inject them like ADRs (§11.6, A18 persona freezing) and never rely on a summarised history. Codex re-states the objective in every continuation (`continuation.md:5-7`), and DSH does the same in every `<goal_round>`.
9. **Plans are Orchestra Tasks, and plan approval is a Decision.**
   - Harness plans (Claude Tasks, DSH todo, Codex `turn/plan/updated`) are session-scoped, maintained by the model, and have no acceptance field. Ingest them only as observed `source: codex-plan` and similar ([spec] §6.1).
   - DSH's plan-mode text already says "conversational agreement… approves nothing" (DSH:dsh-base/cordis.patch.yml:336). A Wish plan is approved by your Decision click, never by a chat "ok".
10. **Measure false "done" before lifting the unattended gate.** Add three Wish metrics to §14 beside rounds-to-done: the `complete→reopened` rate, the human-only-step loop count (target 0), and tokens per verified step. A confident claim later withdrawn (CX#56927, DSH-D#10710) is a signal that §3.2's R05/R06/R07/R21 gate does not capture on its own.

## 8. Uncertain / not verified

- **Claude.**
  - Whether `/goal` or session-scoped prompt hooks work in an SDK session with `settingSources: []` and vendored `hooks:'omit'` ([spec] §7.4). This was not tested; no binary was run.
  - Whether a `"/goal …"` prompt sent through SDK `query()` behaves like `-p "/goal …"` (CC-GOAL:108). Not verified.
  - The "+500k" directive syntax that sets the Workflow `budget` comes from the binary's tool text (CC-BIN@276779707), not from public docs.
  - `goal_propose` and `tengu_goal_proposed` strings in the binary suggest a feature where the model proposes goals. Its behaviour was not read.
- **Codex.**
  - The goal behaviour cited is from `main` at `aa854da`. The 0.160.1 bindings have the same API surface, but the runtime behaviour of the 0.160.x private binary was not checked.
  - The "no tool call suppresses the next continuation" rule is from CX-CB only and was not located in `runtime.rs`.
- **DSH.**
  - Whether the rc.2 descendant-settle rule also covers `dsh-jobs` background jobs.
  - Whether DSH-D#6169 (no time throttle) still reproduces on rc.2. The README describes no pacing, so this is inferred.
- **Issues and discussions.** All CC, CX and DSH-D items are reporter accounts. Token figures in CX#56927 and DSH-D#7894 are the reporters' or tools' numbers, not billed usage. CC#75759 and CC#93745 were seen by title only.
- **Line numbers.** Line references for code.claude.com pages refer to the `.md` copies fetched on 2026-10-27 and can shift when the docs change.
