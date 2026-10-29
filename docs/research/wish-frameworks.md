<!-- Raw researcher report: Opus lane W2 "planning frameworks and products", 2026-10-27. Unedited. Input to wish-programming.md; the synthesized file wins where the two disagree. -->

# W2 — How planning frameworks turn a wish into finished work

2026-10-27. Question: for each framework and product, how is a wish turned into a plan, who decides it is "done", what ends a run, how a run resumes, how cost is bounded, where the human is pulled in, and what their issue trackers say breaks on long runs. Everything was read on 2026-10-27; no code was run.

## Evidence keys

| Key | Source (SHA or fetch) |
|---|---|
| [MO] | `microsoft/autogen`@004749e (2026-10-16; README: archived, "no longer maintained"), `…/autogen_agentchat/teams/_group_chat/_magentic_one/` |
| [MO-P] | Fourney et al., *Magentic-One*, arXiv 2411.04468v1, HTML read via WebFetch |
| [MAF] | `microsoft/agent-framework`@5a950ad, `python/packages/orchestrations/agent_framework_orchestrations/_magentic.py` plus samples |
| [OH] | `OpenHands/software-agent-sdk`@de0eb5d; `OH#n` = OpenHands/OpenHands issues |
| [MSA] / [SWA] | `SWE-agent/mini-swe-agent`@04d809c / `SWE-agent/SWE-agent`@3ea751c |
| [AID] | `Aider-AI/aider`@5dc9490 (last push 2026-05-22) |
| [DV] | docs.devin.ai pages (`dynamic-workflows.md`, `advanced-capabilities.md`), fetched by curl |
| [PC] | `paperclipai/paperclip`@5982246, `doc/` only (the Windows checkout of the code tree was partial); `PC#n` = issues |
| [LC] | `letta-ai/letta-code`@9a6b55b |
| [GB] | `xai-org/grok-build`@2bdd1d6 (Apache-2.0; issues disabled). `GB/` = `crates/codegen/xai-grok-shell/src/session/` |
| [OC] | `openclaw/openclaw`@d45ff6d, `docs/tools/{goal,lobster,swarm}.md` |
| [HA] / [HU] | the user's fork `G:\_Projects\hermes-agent`@954f398 (2026-04-12, stale) / upstream `NousResearch/hermes-agent`@b63fbba |
| [DSB] | `G:\_Projects\DS-Bot`@aff6777 |

## Position

1. Two families exist:
   - **Ledger orchestrators** (Magentic-One, MAF Magentic): an LLM manager judges "satisfied / progressing / looping" each round and re-plans on stalls.
   - **Goal harnesses** (Grok Build, OpenClaw, hermes, and Paperclip's session goals over Codex `thread/goal/*`): one objective is kept alive across turns, and "done" is decided somewhere other than the worker's own final message. The 2026 reliability work is concentrated here.
2. Grok Build's goal subsystem is the most complete public answer to "is it really done": a frozen outcome contract, a 3-skeptic adversarial panel, anti-ratchet rules, a stall fingerprint, a premature-stop detector, and typed blockers that route to a human [GB].
3. Paperclip is the most complete answer to "nothing lost, nothing run twice": exact-once decomposition per plan revision, a liveness contract, a watchdog over stopped trees, and evidence-typed completion. Its tracker also shows its recovery machinery looping [PC].
4. Every system that accepts "done" on prose has a documented false-positive or fail-open path. The common fixes are to run deterministic gates first and to fail closed when the verifier's infrastructure fails.
5. Budgets enforced on *observed* spend fail when spend is reported late (OH#17691). Reserving budget at admission does not have this problem.

## Comparison

| System | Plan form | Who decides "done" | Stops on | Re-plan trigger | Resume | Human touchpoint |
|---|---|---|---|---|---|---|
| Magentic-One [MO] | Task ledger: facts (given / look up / derive / guesses) + bullet plan | Orchestrator LLM, `is_request_satisfied` | `max_turns` 20; `max_stalls` 3 → re-plan | Stall counter (LLM-judged no-progress or loop) | `save_state`: thread, facts, plan and counters (`:225-235`); no durable journal | None built in |
| MAF Magentic [MAF] | Same ledgers | Manager LLM | `max_round_count` / `max_reset_count`, default **None = unlimited** | `stall_count > max_stall_count` (3) | Checkpoint per superstep, including a pending plan review | Optional plan sign-off; re-asked after a stall re-plan |
| OpenHands SDK [OH] | `task_tracker` (todo / in_progress / done, `TASKS.md`); planning agent writes a 5-section PLAN.md | Agent `finish`; optional critic below 0.6 → retry ≤3 | 500 iterations; optional USD budget; StuckDetector | None (stuck → STUCK state) | Event log + condensation tombstones | Confirmation mode |
| mini-SWE-agent [MSA] | None (linear history) | Agent echoes a sentinel; `confirm_exit` asks the human | `cost_limit` 3.0 "after exceeding (!)", step and wall limits | — | Trajectory file | `confirm` mode; exit confirmation |
| SWE-agent [SWA] | — | Reviewer score ≥ `accept_score` | `max_attempts`, `cost_limit`, `min_budget_for_new_attempt` | New attempt | — | — |
| Aider [AID] | Architect's prose plan | Lint/test exit codes; human | `max_reflections` 3 | Lint/test failure → reflect | git commits | "Edit the files?" before the editor runs |
| Devin [DV] | Coordinator scopes child sessions; deterministic Python workflow | Script (structured outputs); coordinator | Run budget 7 days (default = max) | Script decides | Hash-keyed replay of finished agent calls | Workflows and child sessions **auto-approved by default** |
| Paperclip [PC] | Issue tree; `planning` work mode; plan document revisions | Completion contract: durable evidence, or a low-risk "claim policy" (the default) | Retry 5× within 30 min; repair allowance; budgets | Watchdog restores a live path | Exact-once fingerprints; receipts | Plan acceptance = a revision-bound interaction |
| letta-code [LC] | `UpdatePlan` (one in_progress); Task* tools | Agent | Workflow caps (see [spec] §8.7) | — | `Wake` (durable; cron at most hourly) | AskUserQuestion |
| Grok Build goal [GB] | Planner writes plan.md once: kind, 3–5 gating criteria, verification plan, non-goals | 3 adversarial skeptics, cold-panel majority | 10 verifier runs; 2 identical gap fingerprints → NoProgressPaused; 3 non-completing turns → BackOff | Strategist after repeated refutes: change HOW, never WHAT | Snapshot; unknown status → `UserPaused` | `blocking: contradiction / unverifiable` → user; plan not shown to user |
| OpenClaw goal [OC] | Objective string | Model `update_goal(complete)` | Optional token budget ("not a billing cap"); `blocked` only after 3 identical blocker turns | — | Session state; no auto-restart | `/goal` controls; Lobster halts on approval with a resume token |
| hermes upstream [HU] | Contract: outcome / verification / constraints / boundaries / stop_when, plus `/subgoal` | Shell gates first, then an LLM judge on the last ~4 KB | 20 turns; gate retries 3 | — | SessionDB | `/goal draft` shows the contract for review |
| DS-Bot [DSB] | Handoff note (Goals / Progress / Decisions / Next step…) | n/a: DSH goals are **blocked** in Bot sessions | — | — | Steward at 0.8 context: compact or rotate | Every message |

## Findings by system

**Magentic-One / AutoGen.**
- Re-planning resets every participant and clears the thread before a fresh task ledger [MO `_magentic_one_orchestrator.py:262-298`].
- The progress ledger answers five questions [MO `_prompts.py:59-100`]. A "no progress" or "in loop" answer adds a stall, and a good round subtracts one. At `max_stalls` the orchestrator rewrites facts and plan to avoid "repeating the same mistakes" [MO `:388-405`; `_prompts.py:133-136`; defaults `_magentic_one_group_chat.py:117-119`].
- All three signals are the orchestrator LLM's own judgment.
- The paper's top error codes are "persistent-inefficient-actions" and "insufficient-verification-steps". Its advice is to pause "to seek human input" before costly or irreversible actions [MO-P §5.4, §6.3].

**MAF Magentic.**
- `max_reset_count` and `max_round_count` exist, but "None means unlimited" [MAF `_magentic.py:486-498,1490-1493`].
- The stall test is `>`, one round later than AutoGen's `>=` [MAF `:1158`; MO `:402`].
- With `with_plan_review()`, a human approves the plan or asks for a revision. Each revision triggers a re-plan. With sign-off on, a stall re-plan also asks again [MAF `:1030-1074,1192-1228`].
- Checkpoints save the ledgers and the pending review at superstep boundaries (`magentic_checkpoint.py`). AutoGen itself is archived.

**OpenHands.**
- *Plans.* The planning preset fixes a five-section plan ending in "testing and validation … what success looks like" (`preset/planning.py`). The code agent uses `task_tracker` (`definition.py:29,171-178`); the two artifacts are duplicated (OH#13257).
- *Stuck detection.* `StuckDetector` thresholds are 4 / 3 / 3 / 6 [OH `conversation/types.py:150-161`]. It nudges once on an error streak, otherwise the run goes to `STUCK` [OH `local_conversation.py:774-797`].
- *Critics.* Critics retry while the score is below 0.6, up to 3 times [OH `critic/base.py:20-52`]. A finish without a critic result is accepted [OH `critic_mixin.py:108-112`].
- *Long-run issues:*
  - loop detection killed agents waiting on long processes (OH#5355);
  - a stuck conversation could not accept new messages (OH#5480);
  - the task list was forgotten after condensation (OH#10508);
  - cost reads `$0.00` until a conversation finishes, so a watchdog let a run end about $10 past a $10 ceiling (OH#17691, open).

**SWE-agent family and Aider.**
- *mini-SWE-agent* ends a run on a printed sentinel, and its cost limit stops it "after exceeding (!)" [MSA `agents/default.py:26-33,132-137`]. `confirm_exit=True` asks the human to accept "Agent wants to finish" [MSA `agents/interactive.py:29-30,146-158`].
- *SWE-agent* refuses a new attempt when the remaining budget is below `min_budget_for_new_attempt` [SWA `reviewer.py:180-216,533-541`].
- *Aider*: the architect plans, the human confirms "Edit the files?", and the editor starts with an empty history [AID `architect_coder.py:6-45`]. Lint and test failures reflect at most 3 times [AID `base_coder.py:100-107,933-944`].

**Devin.**
- A coordinator scopes child sessions, is woken when a child finishes or needs input, and gives each child its own ACU limit [DV `advanced-capabilities.md:27-40`].
- Dynamic workflows are "auto-approved by default". On resume, finished calls replay by "a hash of its prompt, schema, and execution settings". The run budget is 7 days, as default and as maximum [DV `dynamic-workflows.md:89,195-208`]. Child sessions start without asking by default [`advanced-capabilities.md:66`].

**Paperclip.**
- *Plan authority.*
  - Work mode is explicit state. Accepting the current `plan` revision moves the task from `planning` to `standard` in one transaction [PC `SPEC-implementation.md:432-436,454`].
  - The accepted revision is what authorizes execution.
  - Decomposition happens exactly once per `(sourceIssueId, acceptedPlanRevisionId)`, with a durable claim before fan-out and partial results that later attempts resume [PC `execution-semantics.md:395-463`].
  - "A child must not be created merely because a plan was accepted."
- *Liveness.* Every non-terminal issue must answer "what moves this forward next?" through one of eight typed paths, never inferred from prose [`:465-489`].
- *Evidence.*
  - Completion evidence is classified `accepted / missing / rejected / unverifiable`. The model's `run.result.proposed` "is a claim, not independent proof".
  - The default contract nevertheless uses the weaker `agent_claim_policy` [PC `architecture/native-status-arbitration.md:56-125`].
- *Task watchdog.*
  - It is opt-in. It fires when a subtree has stopped with no live path and treats each stopped leaf "as a claim that must be verified".
  - It cannot approve or spend.
  - It escalates to a human after 2–3 failed restorations of the same fingerprint [PC `TASK-WATCHDOG.md:20-28,87-112`; `execution-semantics.md:1175-1189`].
- *Allowances.* "Comments, confident wording, raw tool counts … cannot refill any allowance" [PC `plans/2026-09-22-continuation-accounting-baseline.md:10-15`].
- *Session goals.* Goal completion "does not directly close the issue" [PC `SPEC-implementation.md:1729-1748`].
- *Issue tracker:*
  - recovery holds deadlock issues while the watchdog duplicates every 30 s (PC#14600);
  - a watchdog self-retriggers on an identical tree (PC#13155);
  - quota waits are misclassified as stuck work: about 110 dead tickets a day and 66% of `blocked` (PC#10344);
  - a misattributed completion comment re-wakes the agent (PC#3817);
  - an open request for a no-progress breaker, because budgets catch loops "only after significant waste" (PC#390).

**Grok Build goal harness.**
- *Planner.* It runs once and writes the "single source of truth" for implementer, verifiers and classifier, which "the user never sees" [GB `templates/goal_planner_prompt.md:1`]. Criteria specify "OUTCOMES, not architecture": 3–5 gating items, extras listed as non-goals, and any CI the objective names kept as a gating step [`:20-22,72`]. `/goal resume` re-runs the planner [GB `goal_planner.rs:130-133`].
- *Verification panel.* Three skeptics vote; "at N=2 a 1-1 tie survives". A strict majority of the cold panel decides, and the resumed skeptic 0 cannot approve [GB `goal_classifier.rs:72-83,824-845`]. Malformed output counts as a refute [`:776-777`].
- *Verifier prompt* [GB `templates/goal_verifier_prompt.md:1,7,15-27,37-46`]:
  - default to refuted;
  - a weakened criterion in `PLAN_CHANGES` is itself grounds to refute;
  - audit the implementer's evidence and do not author new evidence;
  - prose is not evidence;
  - "the bar does NOT rise between rounds";
  - `blocking: contradiction | unverifiable` means the goal "needs a user decision, not a retry".
- *Caps.*
  - 10 verifier runs [`goal_classifier.rs:31-34`];
  - 2 identical gap fingerprints → `NoProgressPaused` [GB `goal_tracker.rs:10-20`];
  - 3 non-completing turns → `BackOffPaused`;
  - a forced re-verify after 8 rounds [GB `acp_session_impl/goal_support.rs:4-10,216-219`].
- *Strategist.* It may "change the HOW, never the WHAT" [GB `templates/goal_strategist_prompt.md:27`].
- *Premature stops.* A regex panel catches bail phrasings ("I can't proceed", "Please run…") while todos remain [GB `goal_stop_detector.rs:1-7,43-54`]. The discipline block forbids asking "permission to continue a task in flight" [GB `templates/goal_task_discipline.md:4-10`].
- *Persistence.* Unknown statuses restore as `UserPaused`, so a snapshot "can never resurrect as a self-driving goal" [GB `goal_tracker.rs:1-6,64-84`].
- *Verification failures.* On the current path an infrastructure failure gives `InfraPaused`; the `_legacy` path instead marks the goal **Complete** [GB `acp_session_impl/goal.rs:203-213,2277-2299`].
- *Plan-mode gap.* Plan mode's edit gate does not cover subagents [GB `xai-grok-pager/docs/user-guide/19-plan-mode.md:137`].

**OpenClaw.**
- The model may only mark a goal complete or blocked, and blocked only after "the same blocking condition recurs for at least three consecutive goal turns".
- It "cannot silently pause, resume, clear, or replace a goal", and "a nearly exhausted budget does not justify marking unfinished work complete" [OC `goal.md:167-190`].
- Token budgets are "not a billing cap" [`:163`].
- After shutdown, "a saved active goal alone does not start a new process" [`:235`].
- Lobster halts side effects with a resume token, and "no process waits" [OC `lobster.md:9-31,72-74`].

**hermes.**
- *The user's fork (2026-04-12)* gives each subagent its own budget of 50 under a parent cap of 90, "so total iterations … can exceed the parent's cap" [HA `run_agent.py:170-200`]. Todos are re-injected after compression [HA `tools/todo_tool.py:1-14`]. Shadow-git checkpoints are invisible to the LLM [HA `tools/checkpoint_manager.py:1-19`].
- *Upstream `/goal`*:
  - has a 5-field contract;
  - runs shell **gates** before the judge, with a red gate skipping the judge and 3 retries [HU `goals.md:81-95,136-152`];
  - parks on a typed `wait` for up to 30 min [`:156-177`];
  - judges "the agent's most recent final response (last ~4 KB)" and fails open to `continue`, with 20 turns as "the real backstop" [`:181-203`].
- *Kanban workers* must end on a terminal board tool. A narrated stop is a `protocol_violation`, with at most 2 nudges [HU `agent/kanban_stop.py:1-30`].

**DS-Bot.**
- DSH goals are blocked in Bot sessions because "DS Bot carries no goal across conversation parts" [DSB `ds-bot/src/host/tools.js:17-20,745-770`]. The preferred fix is long-task autonomy "as a Bot feature that survives part rotation" [DSB `docs/plans/2026-10-13-dsh-concessions.md:17`].
- The steward checks "item by item what the user asked against what the Bot did". Unfinished work is not a stopping point "even if the Bot says it is done" [DSB `docs/plans/2026-10-09-context-and-memory.md:52`].
- Handoff notes have fixed sections: Goals, Progress (Done / In progress / Blocked), Decisions (including rejected ones), Next step… [DSB `ds-bot/src/host/parts.js:388-397`].

## Cross-cutting patterns

- **Who may say "done", from weakest to strongest:**
  1. the worker's claim (OpenClaw, Paperclip's default);
  2. an LLM judge on the final message (hermes, Magentic-One);
  3. a score critic (OpenHands, SWE-agent);
  4. deterministic gates (Aider, hermes);
  5. an adversarial panel auditing evidence against a frozen contract (Grok Build);
  6. typed durable evidence, with a human deciding anything unverifiable (Paperclip's strong path).
- **Re-planning.** MO and MAF re-plan automatically and reset context. Grok Build freezes the WHAT and lets only the HOW be restructured. Paperclip binds authority to one plan revision.
- **Progress signals.** LLM-judged progress is the weakest signal. Durable state change [PC] and identical gap fingerprints [GB] are deterministic. Waiting needs its own type, or loop detection fires on it (OH#5355).

## Implications for Orchestra

1. **Give the wish a frozen, revisioned contract.**
   - *Gap.* [spec] §6.1 `Task.doneCriteria` is an untyped field with no verification method, no revision and no owner. §10.7 has "轮次上限 + 完成标准" but nothing says who may edit the criteria.
   - *Proposal.* Add a contract of 3–5 outcome criteria, a verification plan whose steps are tagged `gating` or `evidence`, non-goals and `stopWhen`, plus a `contractRevision` [GB][HU][PC]. Changing the WHAT is a Decision (§11.6, human-only). The verifier always receives the criteria diff. This keeps §8.3 rule 11 ("绝不自动重新规划") for the WHAT.
   - *Open question.* Whether a bounded HOW-restructure (Grok Build's strategist: once, +3 rounds) is allowed is a new question for the synthesizer, not something this report decides.
2. **Done must rest on typed evidence, and verification must fail closed.**
   - *Gap.* §8.7 "失败归属" already names a fresh verifier or a test command for Arrangement scripts, and §9.2 step 7 rejects model self-evaluation, but only for routing labels. Tasks and Works have no evidence types.
   - *Proposal.* Classify evidence as `accepted / missing / rejected / unverifiable` [PC]. Deterministic gate commands run before any LLM verifier (principle 5; [HU]). A verifier infrastructure failure becomes `ready-for-review`, never `done` (contrast GB's legacy path and HU's fail-open judge). `unverifiable` goes to the human.
3. **Make the independent verifier a `kind: qa` Musician before M6.**
   - *Gap.* §8.8 v0 templates (QA rerun, adversarial check) land only in M6.
   - *Proposal.* Give the wish verifier the existing `qa` kind (§6.1) over the Post Office. It returns a verdict `{refuted, findings[], blocking: none|contradiction|unverifiable}` and carries anti-ratchet prior gaps [GB]. `none` goes back to the executor under the bounce cap N=3 (§10.7); the other two classes become a Decision or InboxItem. A 3-verifier majority is an option for high-cost wishes (inferred).
4. **Count progress from durable change, and make waits explicit.**
   - *Gap.* §10.7's stall rule (no new diff, test, ref or Decision) matches Paperclip's rule but is counted per Work.
   - *Proposal.* Add a per-wish stall: two identical verifier-gap fingerprints → pause with an InboxItem [GB]. Reject LLM-judged progress as a primary signal [MO]. Add a typed `waitingOn{ci|process|human|time, until, cap}` so the §8.3 rule 11 check-in and the §10.3 rule "10th identical `wait` blocked" do not fire on legitimate waits (OH#5355; [HU] 30 min cap).
5. **Settling a Work requires a typed disposition.**
   - *Gap.* Under §8.3 rule 1 a turn's final text becomes the reply, so "I'll check back later" silently settles a Work.
   - *Proposal.* Require `done(evidenceRefs) | blocked(owner, action) | waiting(until) | question(→Decision)`. A prose-only settle gets at most 2 repair nudges [HU kanban_stop; PC repair allowance], then an InboxItem. This is A16 (thin completion) with a mandatory typed status. Grok Build's bail-pattern detector is cheap evidence to log (inferred).
6. **Enforce wish budgets by reservation.**
   - *Gap.* Reserve-then-settle exists only for Arrangement in M6 (§8.8 (e)). Budget incidents arrive in M2 (§10.2, A14).
   - *Proposal.* A wish needs a rolled-up `budget{cny, wall, rounds}` keyed on `rootId`. Reserve an estimate before each dispatch, and refuse a new attempt when the remaining budget is below a floor [SWA]. Never trust late-reported spend (OH#17691; [PC] `SPEC-implementation.md:1715-1722`). At 100% the wish pauses, and only the human raises the limit (D8-consistent).
7. **Recovered state is paused, and decomposition is exact-once.**
   - *Proposal.* After a daemon restart, a wish restores as paused unless the unattended gate (§3.2) is lifted; unknown states map to paused (principle 7; [GB][OC]). Creating a wish's Task tree is keyed by `(wishId, contractRevision)` through `requestId` (§8.3 rule 5), so a re-woken planner cannot create sibling trees [PC].
8. **Plan acceptance is one revision-bound Decision, followed by silence.**
   - *Proposal.* For an A2A-first, multitasking user, ask once: accept contract revision R (a Decision, §11.6). Ask again only on a contract change or a `contradiction` / `unverifiable` blocker [MAF][PC].
   - Suppress "should I proceed?" cadence questions [GB discipline]. Avoid Devin's auto-approve defaults [DV].
   - Plan acceptance never substitutes for tool approvals. In Paperclip, "tool/credential approvals do not authorize the proposal" [PC `execution-semantics.md:30-34`]. D8 is unchanged.
9. **Keep one recovery owner, bounded and visible.**
   - *Proposal.* Paperclip's watchdog over a stopped tree is the right shape for "everything stopped; is it really done?". Paperclip's tracker shows the risks: recovery self-loops, invisible holds and misclassified quota waits (PC#14600, #13155, #10344).
   - Reuse the reaper (§10.4) and check-in (§8.3 rule 11) as the only recovery owners. Fingerprint the whole subtree, including non-leaf activity [PC `execution-semantics.md:1175-1189`]. Add zero-token fixtures for "watchdog self-retrigger" and "quota treated as stuck".
10. **The wish belongs to a Project or Musician, not a session.**
    - *Evidence.* DS-Bot disabled DSH goals because they are session-bound [DSB]. hermes and OpenClaw goals are also single-session [HU][OC].
    - *Proposal.* Under principle 3 and §10.4 rotation, the wish contract, open gaps and next step must be in every handoff note, reusing DS-Bot's section list. The steward's "item-by-item asked vs done" check is a cheap pre-verifier at rotation time.

## Uncertain / not verified

- Devin's "interactive planning auto-proceeds after ~30 s" came from a search summary only; the docs page now redirects to the tutorial index. Not used above.
- OpenHands resolver details (`fix-me`, `OPENHANDS_MAX_ITER`): search summaries only. The docs URL returned 404 and there is no resolver path in the main tree.
- The Magentic-One error ranking came from a WebFetch summary of arXiv v1; the counts in Fig. 4(a) were not read.
- Grok Build: whether the `_legacy` fail-open path still ships is inferred from its name. Flag defaults (`GROK_GOAL_PLANNER`) were not checked. Issues are disabled, so there is no incident evidence.
- Paperclip: only `doc/` was read (partial Windows checkout), so the default claim policy is unverified in code. The issue reports were not reproduced.
- hermes upstream was read from documentation, not code. MAF's `>` versus `>=` was read, not run. letta-code was read only at the tool-description level.
- All numbers are documentation or source defaults; most can be overridden by environment variables or config.
