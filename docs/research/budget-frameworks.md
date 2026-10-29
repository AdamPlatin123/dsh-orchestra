# B2: Tiered and packaged budgets in agent products and frameworks

Lane B2 of the 愿望预算档位 study (brief dated 2026-10-28). The question: how do agent products and frameworks package spend into a few named tiers? For each system this report records the tier count and names, the default, what one tier bundles, who picks it, how it maps to concrete per-backend limits, and what their own trackers say went wrong. Two non-AI analogies (Kubernetes QoS, cloud instance ladders) are included. Unless a date is given, every web page was fetched on 2026-10-28. Local repositories were read only, never executed.

## Evidence keys

| Key | Source (fetched 2026-10-28 unless stated) |
|---|---|
| **CCW** | https://code.claude.com/docs/en/workflows.md. Line numbers refer to that copy |
| **CUR-P / CUR-R / CUR-U** | cursor.com `docs/models-and-pricing.md`, `docs/cursor-router.md`, `help/models-and-usage/usage-limits.md` (undated pages) |
| **CUR-B** | https://cursor.com/blog/june-2025-pricing (2025-07-04) |
| **CUR-F1 / CUR-F2** | forum.cursor.com `t/switching-models-against-my-wishes/166613` (2026-07-25…08-13); `t/why-does-auto-silently-fall-back-to-api-usage/164874` (2026-07-06/08). These are user reports with replies from people speaking for Cursor |
| **DV-SS / DV-U / DV-T / DV-A / DV-M** | docs.devin.ai `admin/billing/self-serve.md`, `admin/billing/usage.md`, `admin/billing/user-acu-limits.md`, `cli/adaptive.md`, `cli/models.md` |
| **DV-KB** | knowledge.cognition.ai/articles/1715208244 ("Last updated 1 year ago") |
| **MN-C / MN-E / MN-P / MN-F** | help.manus.im articles 11711097 (credit rules), 13185575 (pre-task estimate, 2025-12-18), 11711111 (pricing), 16312548 (free-access campaign) |
| **MN-15** | manus.im/blog/manus-1.5-release (dated "Thursday, October 16", no year) |
| **GB** | github.com/xai-org/grok-build @`2bdd1d6` (2026-09-29), files under `crates/codegen/` (sparse clone) |
| **RC / RC-D** | github.com/RooCodeInc/Roo-Code @`b867ec9` (2026-05-15); roocodeinc.github.io/Roo-Code/advanced-usage/rate-limits-costs ("Last updated on May 15, 2026") |
| **CL / CL#7180** | github.com/cline/cline @`f817e59` (2026-10-27); PR #7180 (merged 2025-10-30) |
| **OH-E / OH-B / OH#n** | docs.openhands.dev `openhands/usage/environment-variables.md`, `openhands/usage/cloud/organizations/budgets.md`; issues in OpenHands/OpenHands, read with `gh api` |
| **PC / PC#n** | github.com/paperclipai/paperclip @`25f1070` (2026-10-28), `doc/` only; issues read with `gh api` |
| **HA** | `G:\_Projects\hermes-agent` @`954f398` (2026-04-12, your fork), read-only |
| **DSB** | `G:\_Projects\DS-Bot` @`aff6777` (2026-10-27), read-only |
| **K8S** | kubernetes/website `main` @`e55841d`, `content/en/docs/concepts/workloads/pods/pod-qos.md` |
| **AWS-GP / AWS-BU / AWS-BS** | docs.aws.amazon.com: `ec2/latest/instancetypes/gp.html`; `AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html`; `…-standard-mode.html` |
| **[spec] §x** | `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` |

Labels: (inference) is my reasoning. (unverified) is a claim I could not confirm from a primary source.

## 1. Answer first

1. **Spend and routing tiers settle at three named levels plus an escape hatch.** The examples:
   - Cursor Auto: Cost / Balance / Intelligence (CUR-R:19-21).
   - Manus agents: Lite / Standard / Max (MN-F).
   - Kubernetes QoS: BestEffort / Burstable / Guaranteed (K8S:31-32).
   - Claude Code workflow size: small / medium / large, plus `unrestricted` (CCW:461-466).

   The ladders with four to seven steps are per-call reasoning-effort knobs, not spend budgets: Grok Build `low…xhigh` (+`none/minimal/max`), hermes `minimal…xhigh`, Cline `none…xhigh`. The other long ladders are purchase plans: Cursor Plus / Premium / Super / Ultra at 1× / 4× / 15× / 50× (CUR-P:12-15), and AWS sizes that double at each step.
2. **The better designs hide the backend's unit behind one meter.**
   - Cursor's Cost mode bills one pool rate "whichever model serves it" (CUR-U).
   - Devin Adaptive draws quota "at a fixed per-token rate, regardless of which underlying model is selected" (DV-A:52).
   - Paperclip refuses to count subscription-included usage against a money budget. It keeps "quota" as visibility only (PC `plans/2026-03-14-budget-policies-and-enforcement.md:40-45,79-97`).
3. **A tier sets a target, and a separate hard cap is the backstop.**
   - Claude Code's size guideline is "advice, not a cap". The runtime still caps a run at 1,000 agents (CCW:358,457).
   - Grok Build workflows default to 128 agent calls, and 1,024 is the maximum (GB `xai-workflow/src/lib.rs:17-18`).
4. **Defaults sit in the middle or lower.**
   - Claude Code: `medium`, or `small` on Pro (CCW:468).
   - Cursor Plus: effort fixed at medium (CUR-P:22).
   - Devin: a designated default tier (DV-T:19).
   - OpenHands: a default user budget for new members (OH-B:58-71).
5. **Raising a limit is a request that someone else approves.**
   - Devin tiers carry an increase `policy` (`unconditional`, `conditional` or `manual`) and a `max_limit` (DV-T:56-57).
   - In Paperclip, a hard stop creates a `budget_override_required` approval with three actions (PC plan:365-371).
6. **The recurring failures** (detail in §4):
   - surprise exhaustion (CUR-B);
   - silent model switching or billing spillover at the limit (CUR-F1, CUR-F2);
   - an effort level silently ignored (DSB, GB);
   - a cap that never fired or was never read (OH#8238, CL `CHANGELOG.md:370`);
   - caps removed outright (CL#7180, OH#11920);
   - cost visible only at the end (OH#17691; MN-E);
   - a quota wait mistaken for stuck work (PC#10344);
   - one effort word meaning different levels at different vendors (HA).

## 2. Comparison

| System | Tiers (count: names) | Default | What one tier bundles | Who picks | At the cap |
|---|---|---|---|---|---|
| Claude Code workflow size | 4: `unrestricted`, `small` (<5 agents), `medium` (<10), `large` (<50) (CCW:461-466) | `medium`; `small` on Pro with ≥2.1.271 (CCW:468) | A target agent count, sent to Claude as advice (CCW:457) | You, in `/config` or a settings key (CCW:470) | Advisory `Large workflow` warning above 25 agents or 1.5M projected tokens (CCW:439-441). Hard caps: 1,000 agents per run, 16 concurrent (CCW:355-358). At a usage limit the run waits for the reset, at most twice and within 24 h (CCW:396-407) |
| Cursor Auto | 3: Cost, Balance, Intelligence (CUR-R:19-21) | Cost (the only mode on individual plans) | A routing policy over a hidden model pool, plus a billing rule. "Balance and Intelligence use your usage limits faster" (CUR-R:23) | You, per chat. Admins can disable up to 2 modes and impose Auto soft or hard (CUR-R:34-36) | Editor notification, then prepaid credit, weekly reset or an upgrade. "Requests are never downgraded" (CUR-P:137), but see CUR-F1 |
| Cursor plans | 5: Free, Plus, Premium, Super, Ultra (Base, 4×, 15×, 50× usage) | — | Weekly pool size plus features. Plus has fixed settings: effort medium, Fast off (CUR-P:12-25) | Purchase. Personas: "Premium suits new Agent users, Super … daily, Ultra … power users" (CUR-P:27) | As above |
| Devin | 4 plans: Free, Pro, Max, Teams (DV-SS). Enterprise user tiers are named by admins, any number (DV-T) | One default tier per account (DV-T:19) | Pro: daily and weekly quota. Max: weekly only (DV-SS:106-107). A tier is a `cycle_acu_limit` plus an increase `policy` and `max_limit` (DV-T:54-57) | Admin assignment, IdP group or the default tier. Users file limit-increase requests (DV-T:19-22) | Quota exhausted → on-demand credits "keep you working without interruption" (DV-SS:109). A tier or org limit blocks new work. The session limit puts Devin to sleep after each message (DV-KB). Idle sessions sleep after 30 min and do not consume (DV-U:77). Per-model thinking levels are a separate knob (DV-M:29-31) |
| Manus | 3 agent levels in 2.0: Lite, Standard, Max (MN-F) | Free plans get Lite only. Daily credits are spendable only in Lite (MN-C) | Agent capability plus credit burn. Lite was "optimized for cost efficiency", and subscribers got 50% off Lite (MN-15) | You, per task, gated by plan (Pro "starting from" 4,000 or 8,000 monthly credits, MN-P) | No estimate before a task (MN-E). The last action may overdraw the balance; no new task starts at ≤0 (MN-C) |
| Grok Build | Effort menu of 4: xhigh, high, medium, low. `none`, `minimal` and `max` are also accepted (GB `xai-grok-pager/src/slash/commands/effort_levels.rs:7-25`). Workflow agent budget | `models.default_reasoning_effort` (GB `26-config-reference.md:442`). Workflows: 128 | Effort may swap in a different model id (GB `xai-grok-shell/src/agent/mvp_agent/reasoning_effort.rs:33-36`). The workflow budget counts agent calls (GB `session/workflow/host_service.rs:360-370`) | You. A run's launch effort is immutable; a child may override it (GB `session/workflow/manager.rs:189,1527`) | `BudgetLimited`; resumable until 1,024 (GB `manager.rs:178-184`) |
| Roo Code | 2 numbers, no tiers: `allowedMaxRequests`, `allowedMaxCost` | Unset = `Infinity` (RC `src/core/auto-approval/AutoApprovalHandler.ts:51,99`) | Consecutive auto-approved requests; estimated $ | You | Pause and "Reset and Continue"; the counter restarts (RC:59-84; RC-D) |
| Cline | Request cap removed. Effort: none, low, medium, high, xhigh (CL `apps/cli/src/tui/views/onboarding/model.ts:30`) | — | — | — | — |
| OpenHands | 2 numbers: `MAX_ITERATIONS` 100 and `MAX_BUDGET_PER_TASK` 0 = no cap (OH-E:41-42). Cloud: org monthly cap, default user budget, per-user overrides (OH-B) | Default user budget is lifetime (OH-B:71) | $ | Admin | Alerts at 80 / 90 / 100%. "New conversations may be blocked" (OH-B:45-51) |
| Paperclip | Three control levels: visibility, soft alert, hard ceiling. Amount per scope, or unlimited (PC `SPEC.md:405-413`) | Soft 80%, hard 100% (PC plan:112-117) | Billed cents only; never tokens first (PC plan:519-527) | The board | Pause the scope and open an approval; request graceful cancel of the active run (PC plan:329-338) |
| hermes-agent | Effort 5: minimal…xhigh | medium (HA `agent/anthropic_adapter.py:1322`) | Thinking tokens 4k / 8k / 16k / 32k on older Claude models, otherwise `ADAPTIVE_EFFORT_MAP` (HA `anthropic_adapter.py:30-37`). Iterations: 90 per parent, 50 per subagent (HA `hermes_cli/config.py:335,619`) | You | One grace call to summarise (HA `run_agent.py:10065-10073`) |
| DS-Bot | Per-Bot thinking level from the provider's list | Provider default | — | You name it; agents pass one only when you named it (DSB `ds-bot/src/host/prompt.js:34`) | n/a. No spend budget |
| Kubernetes QoS | 3: Guaranteed, Burstable, BestEffort | Derived, never chosen | How request relates to limit (K8S:37-92) | Derived from the spec | Eviction order under pressure: BestEffort first, Guaranteed last (K8S:31-32) |
| AWS EC2 | Size ladder ×2 per step: m7i.large 2 vCPU / 8 GiB, xlarge 4/16, 2xlarge 8/32 … 48xlarge 192/768 (AWS-GP). T credit modes: 2, standard and unlimited | T3 / T4g / T3a / T8i launch `unlimited` (AWS-BU) | — | You | Standard: CPU "gradually lowered to the baseline" (AWS-BS). Unlimited: keeps running and charges surplus credits (AWS-BU) |

## 3. Details the table does not carry

- **Claude Code.** The size guideline is a target for the planner, separate from fixed runtime caps (CCW:346-358,457). The running line names the size in force (CCW:468). A usage-limit hit is a *wait* that resumes on its own, but only in interactive subscription sessions, not under `-p` or the Agent SDK (CCW:396-407). Ultracode "reaches a session or weekly limit sooner" (CCW:150). The `budget` directive and effort are lane B1.
- **Cursor.** The routed model is hidden by default "so results are judged on their own merit" (CUR-R:35). The SDK exposes the tier as `optimize_for` = `cost | balanced | intelligence` (CUR-R:40). The tier changes routing and burn rate. Hard caps sit at account level: weekly pool, prepaid credit, a "monthly additional usage limit" (CUR-U).
- **Devin.** Three mechanisms coexist: a calendar quota, ACU caps managed as named tiers, and a per-session "session limit" that "does not reset the overall session ACU consumption" (DV-KB). An effective limit resolves as permanent override → temporary override → assigned tier → IdP tier → default tier (DV-T:21). Admins also set "default session spending limits", value undocumented (DV-SS:119).
- **Grok Build.** The workflow "budget" counts agent calls (`BudgetState{total, spent, reserved, remaining}` from `agent_budget` / `agents_used`, GB `host_service.rs:360-370`), though the error text says "token budget" (GB `xai-workflow/src/host.rs:54`). Stopped agents release their slot, so a resume does not double-charge (GB `xai-workflow/src/engine.rs:1431-1486`).
- **Roo Code.** Its two numbers are circuit breakers on *auto-approval*, counted from the last reset, not budgets (RC:59-84).
- **Paperclip.** "Budgets are policy controls; quotas are usage visibility" (PC plan:40-45). `subscription_included` usage "does not count against money budget" (PC plan:79-97). Admission counts each unfinished operation at the larger of reservation and observed spend; hard stops count actual spend only (PC `SPEC-implementation.md:1707-1724`).
- **hermes.** Subagent budgets are independent, so "total iterations … can exceed the parent's cap" (HA `run_agent.py:170-180`).
- **Analogies.** A K8s QoS class is not chosen: it follows from whether requests equal limits, are lower, or are absent, and it sets eviction order (K8S:31-92). The tier names a *reservation shape*, not a size. AWS T modes are hard-versus-soft in miniature: standard degrades to baseline, unlimited keeps running and bills the surplus (AWS-BS; AWS-BU).

## 4. What went wrong (catalogue)

| Failure | Case | Source |
|---|---|---|
| Surprise exhaustion | Cursor, June 2025: the change "came as a surprise", and "unlimited" applied only to Auto. Refunds covered 2025-06-16 to 07-04 | CUR-B |
| Silent switch at the limit | Cursor "auto-switches to another model instead of stopping", even to a disabled model. Fixed in 3.14.7. "There isn't a setting" for fail-closed | CUR-F1 |
| Silent billing spillover | Auto spilled into included API quota "without telling me". "Expected behavior"; no toggle | CUR-F2 |
| Effort silently ignored | DS-Bot drops an unsupported level at run time. Grok drops it with a log-only warning | DSB `models.js:140-147`; GB `reasoning_effort.rs:21-31` |
| Same word, different level | hermes `xhigh` becomes Claude `max` | HA `anthropic_adapter.py:31-37` |
| Knob not wired | OpenHands cost flag never fired. Cline's Yolo toggle was read by nothing | OH#8238; CL `CHANGELOG.md:370` |
| Cap removed | Cline max requests; OpenHands V1 per-task budget | CL#7180; OH#11920 |
| Cost known too late | Cost published only at the end; no pre-task estimate; overdraft on the last action | OH#17691; MN-E; MN-C |
| Quota treated as stuck | Claude weekly limit parked as `blocked` with no monitor | PC#10344 |
| Cap catches loops late | "only after significant waste" | PC#390 |
| Confusing limit names | Devin's "session limit" is not a session cap. Cursor called included usage "rate limits", which "wasn't an intuitive way to describe the limit" | DV-KB; CUR-B |

## 5. Implications for Orchestra

1. **The evidence favours three wish-budget tiers plus a "custom" escape hatch.**
   - Every spend or routing tier seen here has three named levels (Cursor Auto, Manus, K8s, Claude Code's small / medium / large). Each adds an open end (`unrestricted`, unlimited, custom numbers).
   - Five-step ladders appear only for per-call reasoning effort and for purchase plans.
   - The wish tier is a spend-and-scope tier, so five levels would mostly duplicate the effort knobs each harness already has (lane B1). (inference)
2. **Keep the wish tier and per-musician effort on separate axes.** A tier may *set* a default effort per harness through a versioned mapping table, but never through a shared word: hermes shows that `xhigh` on one side can be `max` on the other. The plan card shows the resolved per-harness values ([spec] §8.9 (c)(h)). (inference)
3. **Give you one meter and let the daemon map units.** Follow Cursor Cost mode and Devin Adaptive: the meter shows "% of the tier", and the daemon maps a tier to a Claude quota share, a Codex quota share and DeepSeek CNY.
   - Copy Paperclip's split as well. Only DeepSeek spend counts against `cny`.
   - An exhausted Claude or Codex window is a wait (`waitingOn: time(until reset)`, already in [spec] §8.9 (g) 夜间失败), not a `budget-incident`.
   - PC#10344 shows what happens otherwise.
4. **Make the tier a target for the planner and a ceiling for validation, and leave the harness caps as backstop.**
   - Claude Code pattern: a guideline to the planner, fixed runtime caps underneath.
   - Grok pattern: a default plus a maximum.
   - In r4 terms, the tier fixes the `calls(n)` coefficient, `wallCapMin`, `callsPerHour` and the verify reserve. §8.9 (c) rejects plans above the tier's ceiling. `maxTurns` and the `maxBudgetUsd` share (§8.9 (d)) are derived from the tier, not typed in.
5. **Raising a tier is a Decision that only you approve (D8, A14).**
   - Agents may *request* a raise, as with Devin's limit-increase requests, but there is no "unconditional" auto-approve policy.
   - Reuse Paperclip's three resolutions on the 100% `budget-incident` card: raise the tier and continue; allow this once; stay paused.
6. **Never switch silently at the limit.** Cursor's fallback to another model is exactly the failure to avoid. Exhaustion means `paused(budget)` plus a P1, never an automatic move to another harness, model or tier (consistent with Q-P10 = B: notify, don't interrupt). If a harness cannot honour a tier's knob (DS-Bot or Grok style), the plan card says "not applied" instead of dropping it quietly.
7. **Use a middle default, overridable per wish.**
   - The project default is the middle tier, and the plan card offers a per-wish override.
   - The wish card names the tier in force, as Claude Code's running line does.
   - A lower default may suit a smaller subscription, as Claude Code defaults to `small` on Pro. (inference)
8. **Test that every tier value reaches every harness.** OH#8238, Cline's cosmetic Yolo toggle and OH#11920 all show caps that silently do nothing. Zero-token cases should assert, for each tier, that the derived `maxTurns`, the `maxBudgetUsd` share, `calls(n)` and `wallCapMin` appear in the fake harness's launch parameters.
9. **Say plainly that one turn can overshoot.**
   - Cost arrives late (OH#17691) and can overdraw (MN-C).
   - Reserve from the tier before each dispatch, counting the larger of reservation and observed spend as Paperclip does.
   - Print on the plan card that one in-flight turn can exceed the tier, which is what Q-P10 = B already accepts ([spec] §8.9 (d)).
10. **Space tiers geometrically, about ×2–×4 per step.** AWS doubles per size, Cursor goes 1× / 4× / 15× / 50×, and Claude Code goes <5 / <10 / <50. A step should change caps enough to matter. Calibrate each tier's estimate against actual per tier in [spec] §14 row 12. (inference)
11. **Optional: tiers as reservation shapes (the K8s analogy).**
    - The cheapest tier could reserve its whole ceiling up front (Guaranteed-like).
    - Higher tiers could reserve a base and allow headroom up to the ceiling with the 80% notice (Burstable-like).
    - Treat this as a design option only: it adds a concept, and §10.2 reservations already exist. (inference)

## 6. Uncertain / not verified

- **Manus numbers.** The help-centre pages have no calendar dates ("Updated over a month ago"). I found no official credit-cost ratio between Lite, Standard and Max. Third-party plan figures (for example a $99 Max with 5,000 credits) conflict, and I did not use them. (unverified)
- **Devin defaults.** I did not find the default value of "default session spending limits", or whether the session limit still exists under that name. DV-KB is about a year old. (unverified)
- **Cursor pages are undated.** They describe the X Subscription era (Plus, Premium, Super, Ultra) with legacy plans kept alongside. The dollar size of the weekly pool is not given. Forum threads are user reports; replies from Cursor-affiliated posters were taken at face value.
- **Roo Code status.** The last commit and the docs footer are both dated 2026-05-15. A search snippet said the extension was shut down that day; I did not confirm this from a primary page.
- **Grok Build.** The effort-ignore and effort-to-model-id behaviour comes from code and comments, not from running the tool. The default effort per model comes from the server's `/v1/models` row, which I did not inspect.
- **hermes.** This is your fork at 2026-04-12, and upstream may differ. The thinking-token table applies only to older Claude models without adaptive thinking.
- **Lane overlap.** Claude Code effort levels, the Workflow `budget` directive (+500k, hard ceiling) and the Agent SDK `maxBudgetUsd` / `maxTurns` semantics belong to lane B1 and are not verified here.
- **Analogies are inference.** K8s QoS and AWS ladders are offered as design analogies, not as evidence about user behaviour. Lane B3 covers choice-count evidence.
