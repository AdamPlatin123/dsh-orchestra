# B1 — Harness effort and budget tiers

Lane B1 of the 愿望预算档位 study (brief dated 2026-10-28). Question: how do Claude Code, the Claude API, Codex and DSH express effort or spend as discrete tiers; what does each tier map to internally; how is subscription quota exposed and can an owned client read it; what happens at each cap. All fetches and local reads were made on 2026-10-28 unless a row says otherwise.

## Evidence keys

| Key | Source |
|---|---|
| **CC-MC** | https://code.claude.com/docs/en/model-config.md (line numbers refer to the fetched copy) |
| **CC-SET** | `…/settings-reference.md` |
| **CC-COST** / **CC-SL** / **CC-IM** / **CC-CLI** | `…/costs.md`, `…/statusline.md`, `…/interactive-mode.md`, `…/cli-reference.md` |
| **CC-WF** | `…/workflows.md` |
| **CC-GW** | `…/claude-apps-gateway-spend-limits.md` |
| **SDK-TS** / **SDK-LOOP** / **SDK-COST** | `…/agent-sdk/typescript.md`, `…/agent-sdk/agent-loop.md`, `…/agent-sdk/cost-tracking.md` |
| **CC-BIN** | `C:\Users\Calx\.local\bin\claude.exe`, embedded `VERSION:"2.1.310"`, read with `grep -a` / `dd` only; `@n` = byte offset |
| **CC-BLOG** | https://claude.dev/blog/spending-your-effort/ (Thariq Shihipar, published 2026-09-25) |
| **API-TS** | `anthropics/anthropic-sdk-typescript` at `cb5fba4` (2026-10-23), `src/resources/messages/messages.ts` and `beta/messages/messages.ts`, read with `gh api` |
| **API-SKILL** | `claude-api` skill bundled with Claude Code 2.1.308 (`SKILL.md` "Thinking & Effort", "Task Budgets"; `shared/cost-optimization.md` §2.6). Secondary source: platform.claude.com was unreachable from this sandbox (WebFetch HTTP 400, curl TLS failure) |
| **CX@ce2d47b** | `openai/codex` main at `ce2d47b` (2026-10-28T13:56Z), read with `gh api`; **CX@0.160.1** = tag `rust-v0.160.1` (the r4 pin); latest release is `rust-v0.165.0` (2026-10-27) |
| **CX-BIND** | `G:\_Projects\dsh-TUI\src\backends\codex\protocol\generated\` (bindings generated from Codex 0.160.1; read-only) |
| **TUI** | `G:\_Projects\dsh-TUI\src\` (vendored backend code; read-only) |
| **DSH:** | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`, version 0.2.1-rc.2 |
| **DS-PRICE** | https://api-docs.deepseek.com/zh-cn/quick_start/pricing |
| **[spec] §x** | `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` |

Labels: （推断）= my inference; （未核实）= not confirmed from a primary source.

## 1. Answer first

1. **Effort is a short ladder of named levels everywhere, and no harness says what a level means in tokens.** Claude: five levels, "the same level name does not represent the same underlying value across models" (CC-MC:600-604,671). Codex: each model advertises its own subset and default (CX-BIND `v2/Model.ts`). DSH/DeepSeek: four levels; effort ids are "adapter-owned opaque strings" with no shared vocabulary (DSH:`dsh-llm/README.md:194`).
2. **Defaults sit in the middle; the top is opt-in.** Claude 5.5 models default to `medium`, others to `high`; `max` is session-only (CC-MC:612,625). Codex's enum default is `medium`, and each model can set its own; DSH defaults to `high`, the third of four.
3. **Caps only lower a level, and the lowest scope wins** (`maxEffortLevel`, CC-SET:497-503). An unsupported level falls back to the highest supported one below it (CC-MC:606).
4. **"Orchestrate more" is a separate switch, not a higher level:** Claude Code `ultracode` (CC-MC:633) and Codex `ultra` (CX@ce2d47b `reasoning_effort.rs:10-38`).
5. **Every harness spend cap is a soft landing; none kills in-flight work.** This holds for the Workflow `budget` (CC-BIN@266978552), SDK `maxBudgetUsd` (SDK-LOOP:205), the Codex goal `tokenBudget` (`budget_limit.md:14`) and gateway spend caps (CC-GW:9). It matches Q-P10 = B ([spec] §8.9 (d)).
6. **Subscription quota is visible only as percent used plus reset time, per account-wide 5 h / 7 d window.** Owned clients can read it through the SDK stream (Claude) and the app-server (Codex). The window is shared by every session on the account (CC-COST:233), so a per-wish quota share can only be estimated.
7. **DeepSeek has no window.** It bills prepaid CNY per token, off-peak at half price (DS-PRICE). DSH's ACP wire carries no cost data (DSH:`dsh-acp/lib/index.js:626-636`).

## 2. Comparison

| | Claude Code / Agent SDK | Claude API | Codex | DSH (DeepSeek route) |
|---|---|---|---|---|
| **Effort tiers** | `low` `medium` `high` `xhigh` `max`; Opus/Sonnet 4.6 lack `xhigh` (CC-MC:600-604) | same five in `output_config.effort` (API-TS `messages.ts:4935-4942`) | `none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra` `persistent` + `Custom` (CX@ce2d47b `openai_models.rs:67-80`; same at CX@0.160.1) | `off` `low` `high` `max` (DSH:`dsh-llm-deepseek/README.md:59`) |
| **Default** | `medium` on 5.5 models, `high` elsewhere (CC-MC:612) | `high` except Opus 5.5 / Haiku 5.5 = `medium` (API-SKILL) | per model `defaultReasoningEffort` (CX-BIND `v2/Model.ts`); enum default `medium` | `high` |
| **Maps to** | adaptive thinking depth plus tool-call depth; per-model calibration (CC-MC:596,671) | thinking + text + tool-call tokens; `budget_tokens` rejected on 5.x models (API-SKILL) | Responses API `reasoning.effort`; `persistent` → `"disabled"` (reasoning_effort.rs:36-37) | `low`/`high`/`max` → `output_config.effort`; `off` → `thinking: disabled` (DSH:`dsh-llm-deepseek/README.md:103`) |
| **Orchestration switch** | `ultracode` (sets `xhigh` when started by flag) (CC-MC:633-647) | — | `ultra` → proactive multi-agent | — |
| **Spend / step caps** | `maxTurns`, `maxBudgetUsd`, alpha `taskBudget` (SDK-TS:527-558); Workflow `budget` (CC-BIN@276779549) | beta `task_budget` (advisory, ≥20,000 tokens) (API-TS beta `messages.ts:7470-7486`; API-SKILL) | per-goal `tokenBudget` (CX-BIND `v2/ThreadGoal.ts`) | goal round cap; "No built-in turn budget" (DSH:`dsh-agent-loop/README.md:220`) |
| **At the cap** | `error_max_turns` / `error_max_budget_usd`; overshoot ≤ one response + running subagents (SDK-LOOP:197-205) | model paces itself; not enforced | `budgetLimited` + wrap-up steering; no interrupt | rounds stop; turns unbounded |
| **Quota exposed** | 5 h / 7 d `%` + reset: `rate_limit_event`, `/usage` → `usage_report`, status line (SDK-TS:1709-1715,2349-2400,5865-5884) | org rate limits (not read here) | `account/rateLimits/read`, `account/rateLimits/updated`, rollout `token_count.rate_limits` | prepaid balance (`getBalance`); `QUOTA` on HTTP 402 |
| **What the user sees** | effort slider; footer level; "You've hit your session/weekly limit · resets …" | — | effort picker; persistent accent while on `max` / `ultra` (tui `effort_ignition.rs:1-3`) | effort selector; top-up modal on quota failure |

## 3. Claude Code and the Claude API

### 3.1 Effort levels

- **Guidance per level** (CC-MC:658-667). The docs tie the levels to how much you supervise: `low` for "quick exchanges where you review each result", up to `max` for "hard problems you want Claude to work through without you". `max` is "prone to overthinking".
- **Persistence.** `max` cannot be saved in `effortLevel` or `modelSettings` (CC-MC:693). `maxEffortLevel` exists for every provider (CC-SET:497-503). Enterprise admins can cap effort per role (CC-MC:440-446).
- **Measured cost of a level (CC-BLOG; Anthropic's runs, not Orchestra workloads).**
  - On Terminal-Bench 3.0, Fable 5.1 used a median of 73k tokens per attempt at `low` and 222k at `max`, about 3×. Passes rose from 140 to 214 of 370.
  - On an underspecified build task, Opus 5.5 took 1.5 min at `low`, 11 min at `high` and 67 min at `max`.
  - Gains from effort were largest in security and hardware and small in operations.
- **Tuning advice (API-SKILL `cost-optimization.md` §2.6).** Sweep effort before changing the model. Run everything at a low setting and re-run only the failures at a higher one. In Anthropic's coding runs this "held the pass rate … for a little over half the cost".
- **Per-turn raise.** `ultrathink` raises one turn to `xhigh` without changing the session setting (CC-MC:677-683).

### 3.2 Ultracode and the Workflow budget

- **Ultracode** plans a workflow for each substantive task "at whichever effort level the session runs at" (CC-WF:140). It "reaches a session or weekly limit sooner" (CC-WF:150). It also switches off the `Large workflow` warning and the concurrent-subagent limit (CC-WF:152-155).
- **Workflow token budget.** The Workflow runtime's `budget` is "the turn's token target from the user's \"+500k\"-style directive". It is "a HARD ceiling", counts output tokens shared by the main loop and all workflows, and has `remaining()` = `Infinity` when unset (CC-BIN@276779549).
- **What happens at the ceiling.** Hitting it throws `WorkflowBudgetExceededError`: "Stopping further agent() calls. In-flight agents will complete; their results are preserved" (CC-BIN@266978552).
- **Advisory size warning.** Above 25 agents or 1.5M projected tokens there is a `Large workflow` warning, which is "advisory: it doesn't pause or limit the run" (CC-WF:439-441).
- **Turn budget telemetry in the SDK stream.** The `system/turn_duration` frame carries `budget_tokens`, `budget_limit` ("Turn token-budget ceiling") and `budget_nudges` (CC-BIN@246137701). Owned SDK clients can therefore observe a turn budget.

### 3.3 SDK caps

- **`maxTurns`** counts agentic turns. Under streaming input a queued message starts a new turn "and the max-turns count starts over" (SDK-LOOP:201). In practice `maxTurns` is a per-dispatch cap, as [spec] §8.9 (d) already says.
- **`maxBudgetUsd`** applies to "the client-side cost estimate" at list price.
  - It accumulates across messages in one conversation (SDK-LOOP:201).
  - It "counts only the call's own spend": restored session spend does not count, and a `/clear` starts the budget over (SDK-COST:75).
  - Subagent spend counts. At the cap, spawning another subagent fails with `Budget limit reached` and background subagents stop (SDK-LOOP:199).
  - The estimate is computed for subscription sessions too, so the cap works as a list-price proxy for quota use（推断）.
- **`taskBudget: {total}`** is marked *Alpha*: "the model is told its remaining token budget so it can pace tool use" (SDK-TS:558). The API's `task_budget` is beta and advisory, and "very tight budgets can produce refusal-like behavior" (API-SKILL §2.6).
- **`AgentDefinition.effort`** accepts "a named level or an integer" (SDK-TS:1239,1260). The integer's meaning is not documented.

### 3.4 Quota exposure to an owned client

- **`SDKRateLimitEvent`** (SDK-TS:5865-5884). The public fields are `status` (`allowed` / `allowed_warning` / `rejected`), `resetsAt` and `utilization`.
  - The binary's schema adds `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …) and per-window `unifiedWindows`. Both are tagged `@internal` and are "always absent for API-key, Bedrock, and Vertex sessions" (CC-BIN@246000483).
  - The vendored backend already reads both fields and de-duplicates the warnings (TUI `backends/claude/translate/core.ts:312-318`; `translate/system.ts:122-140`).
- **`/usage` sent as a prompt** returns `usage_report.rate_limits.limits[{kind, percent, resets_at, severity, is_active}]` and `extra_usage` (SDK-TS:2349-2400). This needs SDK ≥ 0.3.273, which the r4 pin 0.3.287 meets. It also needs a claude.ai credential with a known plan or the `user:profile` scope. A `setup-token` token does not qualify (SDK-TS:1709-1715).
- **Claude Code's own warnings are pace-based, not flat thresholds.**
  - The 5 h window warns at ≥90% used while ≤72% of the window has elapsed.
  - The 7 d window warns at 75%/60%, 50%/35% and 25%/15% (CC-BIN@251248480; elapsed fraction computed at CC-BIN@251248896).
  - Behind a gateway, spend warnings fire at 75% and 95% (CC-GW:89).
- **Claude Code's own suggestions near a weekly limit (Pro plan).**
  - "try /model sonnet · ~2× runway".
  - "try /effort medium" when the session runs at `high`, `xhigh` or `max` (CC-BIN@251247150).
- **At the limit** an interactive session waits and "continues the task on its own after the limit resets", on by default (`autoContinueAtUsageLimit`: CC-IM:735; CC-SET:2561-2575). It re-arms at most twice (CC-IM:752). Workflow runs pause and resume the same way (CC-WF:396-407).

## 4. Codex

### 4.1 Effort tiers

- **The level set is data, not code.** `model/list` returns `supportedReasoningEfforts[{reasoningEffort, description}]` and `defaultReasoningEffort` for each model (CX-BIND `v2/Model.ts`, `v2/ReasoningEffortOption.ts`). The JSON schema types effort as "a non-empty reasoning effort value advertised by the model" (CX@ce2d47b `openai_models.rs`, `JsonSchema` impl).
- **Config keys.** `model_reasoning_effort` and `plan_mode_reasoning_effort` exist (CX@ce2d47b `core/config.schema.json`). There is no token budget key beyond `tool_output_token_limit` and the auto-compact limit.
- **Top tiers are marked in the UI.** `max` and `ultra` get a one-shot animation and "the persistent prompt accent that remains while one of those tiers is active" (CX@ce2d47b `tui/src/bottom_pane/effort_ignition.rs:1-3`).

### 4.2 Budget and quota

- **Per-goal budget.** A goal carries `tokenBudget`, `tokensUsed` and `timeUsedSeconds`. Its status is one of `active | paused | blocked | usageLimited | budgetLimited | complete` (CX-BIND `v2/ThreadGoal.ts`, `ThreadGoalStatus.ts`).
- **At the token budget.** The goal is marked `budget_limited` and the model gets a steering message: "do not start new substantive work … Wrap up this turn soon" (CX@ce2d47b `ext/goal/templates/goals/budget_limit.md:1-16`). The active goal is cleared only when no turn is running (`ext/goal/src/runtime.rs:243-247`).
- **At a usage limit.** The goal moves to `usageLimited` (`runtime.rs:271-273,318-322`).
- **`account/rateLimits/read`** returns `primary` / `secondary` windows `{usedPercent, windowDurationMins, resetsAt}`, plus `credits`, `planType` and `rateLimitReachedType`. It also returns `ordinaryUsageAllowed`; "clients must not infer recovery from percentages or reset times" (CX-BIND `v2/GetAccountRateLimitsResponse.ts`, `RateLimitSnapshot.ts`, `RateLimitWindow.ts`).
- **`account/rateLimits/updated`** is a sparse push to merge into the last read. Both methods are in the 0.160.1 bindings, and TUI already decodes the push (`backends/codex/translate/usage.ts:58-70`). It maps 300 min to `five_hour` and 10,080 min to `seven_day` (`usage.ts:49-55`); the server owns the real lengths.
- **Passive reads.** Rollout `token_count` events carry the same `rate_limits` snapshot (CX@ce2d47b `protocol/src/protocol.rs:2573-2631`).

## 5. DSH and DeepSeek

- **Effort mapping.** `reasoningEffort` defaults to `high`. `low`, `high` and `max` serialize as `output_config.effort`. `off` sends `thinking.type: disabled`. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before any network I/O (DSH:`dsh-llm-deepseek/README.md:45,59,103`).
- **Changing effort over ACP.** `session/set_config_option` changes `reasoning_effort`. A prompt snapshots the setting for its whole turn (DSH:`dsh-acp/README.md:70,80`).
- **Budget knobs.**
  - `maxTokens` is a per-request output cap, default 256,000 (DSH:`dsh-llm-deepseek/README.md:46,60`).
  - Goal rounds have their own cap, `defaultMaxGoalRounds` 256 (DSH:`dsh-goal/README.md:46`).
  - There is no turn or cost budget (DSH:`dsh-agent-loop/README.md:220`).
- **Money and quota.**
  - The account route exposes `getBalance` (DSH:`dsh-api-account-controller/README.md:23`).
  - Insufficient balance fails as `QUOTA` (HTTP 402), which the account route renames `ACCOUNT_QUOTA` (DSH:`dsh-llm-deepseek-account/README.md:66`; `dsh-llm-deepseek/README.md:119`).
  - ACP `usage_update` reports only `{used, size}` context occupancy (DSH:`dsh-acp/lib/index.js:626-636`). Per-turn tokens must come from the session log, as [spec] §7.1 already plans.
- **Prices (DS-PRICE), CNY per million tokens, off-peak / peak.**
  - `deepseek-flash`: input cache hit 0.02/0.04, input cache miss 1/2, output 4/8.
  - `deepseek-v4-pro`: input cache hit 0.15/0.30, input cache miss 4.5/9.0, output 13.5/27.0.
  - Off-peak is "half" of peak. Peak hours are Beijing weekdays 9:00–12:00 and 14:00–18:00.
  - Server-side Search/Fetch calls made from DSH, Claude Code or Codex become billable from 2026-11-01 at 5 CNY per 1,000 requests.

## 6. Cross-cutting patterns

| Pattern | Evidence |
|---|---|
| Ladder of 4–5 named levels; the shared core is low / mid / max | CC 5; DSH 4; Opus 4.6 4; Codex models advertise subsets |
| Level semantics are per model; the client resolves "highest supported ≤ requested" | CC-MC:606,671; DSH `dsh-llm/README.md:194`; Codex catalog |
| Default is mid; top is opt-in and session-scoped | CC-MC:612,625; Codex `Medium` |
| Caps lower, never raise; lowest scope wins | CC-SET:497-503 |
| Fan-out is a separate toggle from effort | `ultracode`; Codex `ultra` |
| Caps stop *new* work; in-flight work finishes or is asked to wrap up | CC-BIN@266978552; SDK-LOOP:205; `budget_limit.md`; CC-GW:9 |
| Quota = % of a shared rolling window + reset; warnings are pace-based or 75/95 | CC-SL:193-194; CC-BIN@251248480; CC-GW:89; CX-BIND `RateLimitWindow` |
| The harness's own advice for saving quota: lower effort, then a cheaper model | CC-BIN@251247150; API-SKILL §2.6 |

## 7. Implications for Orchestra

1. **Make tier names Orchestra-owned and resolve them per harness and per model.** Pass no effort names through. Take the highest advertised level at or below the tier's target, as Claude Code does. The advertised lists come from `supportedEffortLevels` for Claude (SDK-TS:5117-5132), `model/list` for Codex, and the ACP `reasoning_effort` option for DSH. No harness defines tokens per level, so effort alone cannot make a tier promise a token count (CC-MC:671).
2. **A tier should bundle an effort ceiling with the envelope numbers.** The envelope numbers are the `calls(n)` multiplier, `wallCapMin`, quota share and CNY. Effort is the per-call cost lever the vendors recommend (CC-BIN@251247150; API-SKILL §2.6). From `low` to `max`, tokens grew about 3× and wall-clock grew tens of times (CC-BLOG). A tier that raises `calls(n)` but leaves effort at `max` can still overrun（推断）.
3. **3 tiers map cleanly; 5 tiers collapse on some backends.** DSH has four levels and no `medium`. Opus 4.6 and Sonnet 4.6 have no `xhigh`. A 5-tier scale aligned to Claude's names would therefore put two tiers on the same DSH level. `low`, `high` and `max` are the only names all four surfaces share. A 3-tier scale maps onto low, each backend's default and max everywhere（推断）.
4. **Default to the middle tier.** Allow the top tier per wish only, never as a saved project default. This mirrors `max` being session-only (CC-MC:625) and Codex's persistent accent on `max` / `ultra`. Show the active tier on the wish card at all times（推断）.
5. **"Agents cannot raise the tier" has a harness precedent.**
   - Claude: put the tier's ceiling into the musician's `maxEffortLevel`, which skill and subagent frontmatter cannot exceed (CC-SET:497-503). Whether this setting reaches a session started with `settingSources: []` is not verified (§8).
   - Codex: set effort per thread or turn. DSH: pin `reasoning_effort` at session start.
   - Keep fan-out out of the tiers. `ultracode` and `ultra` switch off the large-run guards (CC-WF:152-155), and D13 keeps fan-out with you.
6. **Treat quota shares as estimates.** The Claude and Codex windows are account-wide, so your own interactive use counts too (CC-COST:233). Make tokens from `modelUsage` / `thread/tokenUsage/updated` the primary ledger unit. Use the window-percent delta as a guard and label it `estimated`, per [spec] §10.2's rule "unknown = estimate, never 0".
7. **Read quota through the owned channels.**
   - Claude: `rate_limit_event`, which TUI already decodes, plus `/usage` → `usage_report` when the credential qualifies.
   - Codex: `account/rateLimits/read` and `account/rateLimits/updated`, both in the 0.160.1 bindings.
   - DSH: logged tokens × DS-PRICE.
   - Where the signal is missing (API key, Bedrock, an unqualified token), fall back to a labelled token-to-quota estimate.
8. **Consider pace-based quota warnings.** Claude Code warns when usage runs ahead of elapsed window time: 90% used by 72% elapsed for 5 h, and 75/60, 50/35 and 25/15 for 7 d. A tier could cap "share of the remaining window" and warn on pace. The 80% / 100% `budget-incident` rule stays for CNY and per-wish caps.
9. **The inner backstops all behave like Q-P10 = B, so per-tier values only set how far a turn can overshoot.**
   - Claude: per-tier `maxTurns`, and `maxBudgetUsd` set to the part's share. That figure is a list-price estimate, excludes restored spend and resets on `/clear`. Orchestra must never send `/clear` to a wish part without settling the ledger.
   - Codex: `tokenBudget` exists only on goals, and the native goal loop stays off ([spec] §8.9 (i)). Until a budget is shown to work without continuation, Codex has no automatic token backstop.
   - DSH: none (`dsh-agent-loop/README.md:220`).
10. **No harness may resume a wish on its own after quota exhaustion.**
    - Set `autoContinueAtUsageLimit: false` explicitly for owned Claude parts. It defaults to `true` interactively; SDK behaviour is not verified.
    - Map Codex `usageLimited` to `waitingOn: time(until reset)`, as [spec] §8.9 (g) does.
    - §8.7's clamp should note that Workflow runs auto-resume after a reset (CC-WF:396-407).
11. **DeepSeek CNY per tier depends on the clock.** Off-peak, the same CNY buys twice the tokens. Reserve at the price in force at dispatch time, or conservatively at peak, and record the price band in `LedgerEntry`（推断）. From 2026-11-01, add per-request Search/Fetch charges to the ledger.
12. **Calibration.** For each dispatch, record the tier, the resolved effort, tokens, CNY and the window-percent delta. Then §14 row 12 can report estimate against actual per tier and per harness. Vendor curves differ by workload and model (API-SKILL §2.6).

## 8. Uncertain / not verified

- **Sources not reached.** platform.claude.com and developers.openai.com were unreachable from this sandbox. The Claude API facts come from API-TS and API-SKILL; the Codex facts come from source code and bindings only.
- **Agent SDK behaviour.**
  - What an integer `AgentDefinition.effort` means (SDK-TS:1260).
  - Whether `maxEffortLevel` reaches an SDK session started with `settingSources: []`.
  - Whether `autoContinueAtUsageLimit` applies to SDK sessions.
  - Whether an SDK client can set the "+500k" turn budget. The `turn_duration.budget_*` fields were seen only in the binary.
  - Whether `/usage` through the SDK costs a model call. I infer it does not.
- **Codex.** Whether a goal `tokenBudget` works with continuation off.
- **Unstable or server-owned values.**
  - `rateLimitType` and `unifiedWindows` are tagged `@internal`.
  - Codex window lengths are set by the server.
  - Prices and plan sizes change, and no absolute subscription allowance was found.
- **CC-BLOG numbers** come from Anthropic's benchmarks, not Orchestra workloads.
