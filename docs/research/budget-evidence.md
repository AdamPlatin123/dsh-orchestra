# B3 — Evidence on tiered choices, and the r4 budget-knob map

Lane B3 of the 愿望预算档位 study (brief dated 2026-10-28). Questions: (a) how many tiers people choose among well, what pulls the choice (middle option, default), and what model vendors advise about choosing an effort level; (b) every numeric budget knob in r4, what a tier must set for each, how a tier hides the harness-unit split, and what Q-P10 = B means for tiers. All fetches, API lookups and local reads were made on 2026-10-28. Local files were read only; the Claude binary was read with `grep -a` / `dd` only.

## Evidence keys

| Key | Source |
|---|---|
| **HICK** / **HYMAN** | Hick 1952, *QJEP* 4(1):11–26, doi:10.1080/17470215208416600 (abstract via api.openalex.org); Hyman 1953, *J Exp Psych* 45(3):188–196, doi:10.1037/h0056940 |
| **MILLER** / **COWAN** | Miller 1956, *Psych Rev* 63(2):81–97, doi:10.1037/h0043158; Cowan 2001, *BBS* 24(1):87–114, doi:10.1017/S0140525X01003922 (abstract via api.crossref.org) |
| **IL** | Iyengar & Lepper 2000, *JPSP* 79(6):995–1006, doi:10.1037/0022-3514.79.6.995 (figures from secondary summaries) |
| **IHJ** | Iyengar, Huberman & Jiang 2004, *Pension Design and Structure* (OUP); https://business.columbia.edu/faculty/research/how-much-choice-too-much-contributions-401k-retirement-plans |
| **SGT** | Scheibehenne, Greifeneder & Todd 2010, *JCR* 37(3):409–425, doi:10.1086/651235 (abstract via OpenAlex) |
| **CBG** | Chernev, Böckenholt & Goodman 2015, *JCP* 25(2):333–358, doi:10.1016/j.jcps.2014.08.002 (abstract via Crossref) |
| **SIM89** / **ST92** / **HPP** | Simonson 1989, *JCR* 16(2):158–174, doi:10.1086/209205; Simonson & Tversky 1992, *JMR* 29(3):281–295, doi:10.1177/002224379202900301; Huber, Payne & Puto 1982, *JCR* 9(1):90–98, doi:10.1086/208899 |
| **NBS** | Neumann, Böckenholt & Sinha 2016, *JCP* 26(2):193–212, doi:10.1016/j.jcps.2015.05.005 (abstract via Crossref) |
| **JG** / **MS** | Johnson & Goldstein 2003, *Science* 302:1338–1339, doi:10.1126/science.1091721; Madrian & Shea 2001, *QJE* 116(4):1149–1187, doi:10.1162/003355301753265543 |
| **JDWJ** | Jachimowicz et al. 2019, *Behavioural Public Policy* 3(2):159–186, doi:10.1017/bpp.2018.43 (abstract via Crossref) |
| **MERT** / **MAIER** | Mertens et al. 2022, *PNAS* 119(1) e2107346118 (OpenAlex abstract, truncated); Maier et al. 2022, *PNAS* 119(31) e2200300119, https://pmc.ncbi.nlm.nih.gov/articles/PMC9351501 |
| **MACKAY** | Mackay 1991, CHI '91:153–160, doi:10.1145/108844.108867 (abstract via OpenAlex) |
| **CC-MC** | https://code.claude.com/docs/en/model-config.md (curl; line numbers refer to that copy) |
| **CC-BLOG** | https://claude.com/blog/claude-model-and-effort-level-in-claude-code (L. Hallie, 2026-07-07; WebFetch) |
| **CAPI** | `claude-api` skill bundled with Claude Code 2.1.308 (model table "cached: 2026-10-06"): body § Thinking & Effort, § Task Budgets; `shared/cost-optimization.md`, `shared/managed-agents-core.md` |
| **CC-BIN** | `C:\Users\Calx\.local\bin\claude.exe` 2.1.310; `@n` = byte offset |
| **OAI-PY** | openai/openai-python main @77fd116: `src/openai/types/shared/reasoning.py`, `reasoning_effort.py`, `types/responses/response_create_params.py:108-121` |
| **CX** | openai/codex main @ce2d47b (2026-10-28T13:56Z): `codex-rs/protocol/src/openai_models.rs:64-97`; `…/openai_models/reasoning_effort.rs:10-40`; `codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__model_reasoning_selection_popup.snap` |
| **CX-BIND** | `G:\_Projects\dsh-TUI\src\backends\codex\protocol\generated\v2\` (Codex 0.160.1): `RateLimitWindow.ts:5`, `RateLimitSnapshot.ts:10`, `AccountRateLimitsUpdatedNotification.ts:13` |
| **GENAI** | googleapis/python-genai main @6e80d42: `google/genai/types.py:382-394,5816-5824,13860` |
| **[spec] §x :n** | `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`, section and line |

Labels: (inference) is my reasoning; (computed) is arithmetic on cited numbers.

## 1. Answer first

1. **The evidence does not decide between 3 and 5.** Overload studies compare 6 against 24 or more options. The meta-analyses find an average effect near zero that turns significant only under specific moderators. No study found tests 3 against 5 ordered tiers (§2).
2. **The default and the middle win, firmly.** Defaults have d = 0.68 across 58 studies (JDWJ), and middle options are chosen more often (NBS). Which tier is the default matters more than how many tiers there are.
3. **The overload moderators describe a plan-time budget choice.** They are preference uncertainty, task difficulty and an effort-minimising goal (CBG). That argues for few visible tiers and a strong preselected default (inference).
4. **Vendors moved from numeric thinking budgets to named levels, but those levels are soft.** Every vendor keeps a separate hard cap. An Orchestra tier is the reverse: hard reservations plus notification thresholds (§3).
5. **Vendors fence off the expensive top end.** Claude Code applies `max` to the current session only (CC-MC:625). Codex puts Max and Ultra behind a "More reasoning…" entry with a usage-limit warning (CX snapshot).
6. **r4 has 7 spend knobs a tier must set, and 4 have no number yet:** the per-wish CNY cap, `wallMin`, the `calls` cap and `maxTurns`. Loop caps should not vary by tier (§4.1).
7. **Under Q-P10 = B a tier gates new work only.** The worst case is the cap plus one in-flight turn, bounded only by harness caps: Claude `maxTurns`, `maxBudgetUsd` from M2, nothing for DSH. Anthropic's Managed Agents session budget has the same shape (§4.3).

## 2. Decision-design evidence

### 2.1 How many options

**Hick's law.**
- Choice reaction time grows linearly with stimulus information, about log2 of the number of alternatives (HICK, up to 10 alternatives; HYMAN).
- 3 tiers carry 2.0 bits and 5 tiers 2.58 bits, 29% more (computed, log2(n+1)).
- These are speeded tasks. A once-per-wish choice is deliberate and not under time pressure, so Hick's law is a weak argument either way (inference).

**Working memory.** Cowan puts central capacity at about 4 chunks (3–5), against Miller's rhetorical 7 ± 2 (COWAN; MILLER). Three tiers fit that limit. Five tiers need the card to show each tier's bundle (inference).

**Choice overload.**
- Jam study (IL): 24 jams drew about 60% of passers-by and about 3% of samplers bought; 6 jams drew 40%, of whom 30% bought.
- 401(k) plans (IHJ): participation fell about 2 percentage points per 10 extra funds.
- SGT (63 conditions, N = 5,036): mean effect "virtually zero" with large variance; no sufficient condition found.
- CBG (99 observations, N = 7,202): overload becomes significant with set complexity, task difficulty, preference uncertainty and an effort-minimising goal.

**Mapping to a tier choice (inference).** Preference uncertainty is high: you cannot know what a wish will cost, which is why [spec] §14 row 12 (:2610) exists. The goal is effort-minimising, since the point of 许愿 is not to manage. So three of the four moderators are present. All studied sets have at least 6 options, so the step down to 3 against 5 is extrapolation.

### 2.2 Middle option and default

**Middle option.**
- Extreme or dominated options shift share toward the middle or the target (SIM89; ST92 "extremeness aversion"; HPP).
- NBS (142 observations) finds extremeness aversion robust, but its size varies up to threefold with study design.
- It is weaker in price–quality trade-offs and in binary-versus-trinary comparisons. A budget tier is exactly such a trade-off, so expect a weaker middle pull (inference).

**Defaults.**
- Defaults raise organ-donor consent (JG) and 401(k) participation (MS).
- JDWJ (58 studies, n = 73,675): d = 0.68 (95% CI 0.53–0.83). The effect is stronger when the default reads as endorsement or status quo.
- MACKAY (51 Unix users, four months): most users customised little, because time spent customising is time not spent working.

**Caveat on size.** MERT puts nudges overall at d = 0.45 (95% CI 0.39–0.52), with decision-structure interventions, defaults among them, the strongest. MAIER's bias-adjusted reanalysis finds the evidence for structure interventions "undecided". Defaults matter, but by how much is uncertain.

**The endorsement risk (inference).** The planner's proposed tier will act as an endorsed default. r4 already places the planner's estimate beside the project default ([spec] §8.9 (c) step 3, :1231).

### 2.3 What follows for 3 against 5 (inference)

The firm findings point to few visible tiers, a preselected middle default, and extra tiers reachable but not shown. The one argument for 5 is that it reuses Claude's familiar five-level vocabulary. That alignment is nominal, because Claude's levels are soft and calibrated per model (§3). A 3-visible / 5-internal hybrid fits both the evidence and the vendor pattern.

## 3. Vendor guidance on effort and budget selection

| Vendor | Named levels | Default | Level is a cap? | Separate hard cap | Top end |
|---|---|---|---|---|---|
| Claude Code | `low` `medium` `high` `xhigh` `max`; Opus/Sonnet 4.6 lack `xhigh`; `ultracode` is a toggle, not a level (CC-MC:600-604,633) | `medium` on 5.5 models; `high` on most others; `xhigh` on Opus 4.7 (CC-MC:612) | No: adaptive reasoning (CC-MC:596) | SDK `maxTurns`, `maxBudgetUsd` ([spec] §8.9 (d) :1242) | `max` session-only unless set by env var; settings keys reject it; `maxEffortLevel` and org caps (CC-MC:440-446,625,693) |
| Claude API | same five, in `output_config.effort`; `budget_tokens` returns 400 on Opus 5.5/5/4.8/4.7, Fable, Sonnet 5.x (CAPI) | `high`; `medium` on Opus 5.5 and Haiku 5.5 | No | `max_tokens`; advisory `task_budget` (≥ 20,000 tokens); hard USD Managed Agents session budget (CAPI; `managed-agents-core.md:189-215`) | use `max` only when evals show headroom (CAPI) |
| OpenAI API | `none` `minimal` `low` `medium` `high` `xhigh` `max`, plus `mode` standard/pro (OAI-PY) | not stated in SDK | No: lower effort "can result in" fewer tokens | `max_output_tokens` includes reasoning; `max_tool_calls` (OAI-PY :108-121) | — |
| Codex | adds `ultra` (UI alias that resolves to multi-agent effort or `max`) and `persistent` (sent as `disabled`); `#[default] Medium` (CX) | `medium` | No | goal `tokenBudget`, which r4 disables ([spec] §8.9 (i) :1377) | popup shows Low, Medium (default), High, Extra high, Persistent, then "More reasoning…" warning that Max/Ultra use limits faster; `enter` saves as default, `s` applies to the session only (CX snapshot) |
| Gemini | `ThinkingLevel` MINIMAL/LOW/MEDIUM/HIGH (GENAI :382-394) | model-dependent | No | numeric `thinking_budget` (0 off, −1 auto) is not supported from Gemini 3.5, per a tuning-config field note (GENAI :5816-5824,13860) | — |

**What the vendors advise.**
1. **Treat effort as a standing preference, not a per-task decision.** Start at the default, and raise it when Claude skipped files, tests or checks. Effort "shapes token consumption but doesn't limit it"; one illustration shows about 7× the tokens at high versus low effort (CC-BLOG).
2. **Read the levels by how you work with the result.** Use `low` when you review each result, `medium` for scoped features and `high` when verification matters. Use `max` for hard work done without you; it can show diminishing returns and overthinking. Higher levels tested more and decided more alone (CC-MC:656-669).
3. **The same name means different amounts on different models.** Re-sweep after any model change (CC-MC:671; CAPI `cost-optimization.md:166`).
4. **Measured curves depend on the work** (CAPI `cost-optimization.md:169-173`).
   - Research work: nearly flat.
   - Long-horizon coding: each step down gave up single-digit pass-rate points for much lower cost, and the top settings bought little at a large multiple of cost.
   - Running low and re-running only failures higher kept the all-high pass rate at a little over half the cost.
5. **Downgrades can be silent.** An unsupported level falls back to the highest supported one below it. A request above a cap runs at the cap, and in interactive, JSON and background modes the warning goes only to the debug log (CC-MC:446,606).
6. **Hard caps gate new requests (Managed Agents).** The request that crosses the cap completes, so the overrun is at most one request per running thread. At the cap only settle events are accepted, and changing the budget resumes the session (CAPI `managed-agents-core.md:206-210`).

## 4. The r4 budget-knob map

### 4.1 Every numeric knob

| # | Knob | [spec] | r4 default | Tier should |
|---|---|---|---|---|
| 1 | `Wish.budget.cny` | §6.1 :647; §8.9 (g) :1297; §10.2 :1504 | project per-wish CNY cap, **no number**; Q-P6 open (:2838) | **set** (§4.2 for Claude/Codex) |
| 2 | `Wish.budget.cnyDay` | same | ≤ project daily cap, 20 CNY (Q3 assumption, :1664) | **set** as a share of it |
| 3 | `Wish.budget.wallMin` (active) | §8.9 (a) :1187; :1310 | project policy, **no number** | **set** |
| 4 | `verifyReserveCny` | §8.9 (e) :1274 | share set from M1–M2 data (Q-P5 = B) | **set** as a share |
| 5 | `calls(n)` | §8.9 (g) :1297,1309; :1702 | 4 × Tasks + milestones, project cap **undefined** | **set** coefficient and cap |
| 6 | `callsPerHour` | §10.2 :1504; :1703 | 6 (rate, not cap) | fixed in v1 (inference) |
| 7 | `Task.wallCapMin` | §8.9 (c) :1236; :1704 | 60 min | **set** |
| 8 | Claude `maxTurns` | §8.9 (d) :1242 | **no value** | **set** |
| 9 | Claude `maxBudgetUsd` | :1242; WP-9, WP-31 | Part share of remaining reservation, M2+ | derived |
| 10 | DSH per-turn cap | :1242 | none | unavailable before the M3 bundle |
| 11 | Retry floor; 80% / 100% thresholds | §10.2 :1501-1504; :1685 | estimate; A14 | derived; fixed |
| 12 | Loop caps (`roundCap` 3, `verifySubmissions` 3, milestone rerun 1, `gapRepeat` 2, `blockRepeat` 2, `stall(3)`, rule 7 = 20) | :1304-1317 | assumptions | fixed: they measure convergence, and varying them splits the evidence-gate sample (inference) |
| 13 | Planning caps (`estHumanMin` ≤ 30, ≤ 7 questions, 2 repair rounds) | §8.9 (c); §10.12 | assumptions | fixed |
| 14 | Project envelope: `Project.budget{cnyDay, tokensMin}`, `tempo{…}`, Maestro 2 CNY | §6.1 :627; :1664 | Q3 | not per tier (`tokensMin` undefined) |
| 15 | Arrangement: 64 calls, 60 min, CNY ≤ daily cap, quote > 25 calls; workflow-run item 25 agents / 1.5M tokens | §8.8 (e) :1145; :1686,1689 | [wf] | separate; may reuse tier names at M6 (inference) |
| 16 | `Musician.effort` | §6.1 :628 | per musician | orthogonal to the tier |
| 17 | Micro-wishes ≤ 1 h, ≤ 5 CNY | §8.9 (j) :1391 | assumption | the lowest tier's calibration set |

### 4.2 The harness-unit problem

**Each harness meters spend in a different unit.**
- **DSH** (DeepSeek, per token) is metered in CNY: `LedgerEntry.costCny` with an estimate flag (§6.1 :638).
- **Claude** reports `modelUsage`, and its `total_cost_usd` is reference only (§7.1 :811). Subscription quota is still visible. The binary emits `rate_limit_event` with `rate_limit_info{status, resetsAt, rateLimitType, utilization, surpassedThreshold, …}` (CC-BIN@261580365); `rateLimitType` values include `five_hour` and `seven_day`.
- **Codex** reports per-thread tokens only (§7.1). At account level it has primary and secondary `RateLimitWindow{usedPercent, windowDurationMins, resetsAt}`, pushed by `AccountRateLimitsUpdatedNotification` (CX-BIND).

**The daemon maps one tier to per-harness caps (inference).**
- DSH: a CNY reservation.
- Claude: a `maxBudgetUsd` share at notional list price, plus a guard that refuses a dispatch that would push `five_hour` utilization past the tier's window share.
- Codex: a token estimate, plus a guard on `usedPercent`.
- You see the tier name and one plain line per harness, such as "约 N 元" or "约占 5 小时额度 x%".

**Windows reset, so spend does not add up across them.** For subscription harnesses a tier reads better as a share per window plus calls and turns than as a total. The windows are also shared with your own interactive sessions (inference).

**When no quota signal can be read, estimate.** Convert tokens at list price and mark the figure estimated; this follows r4's rule that unknown usage is never 0 (§10.2 :1504).

### 4.3 What Q-P10 = B implies

The daemon never interrupts an in-flight wish turn (§8.9 (d) :1241; Q-P10 :2842). Tier caps therefore act at three points only:
1. **Plan validation:** the estimate is checked against the tier cap.
2. **Dispatch admission:** reservation and the retry floor.
3. **Notification:** P2 at 80%, P1 at 100%.

The in-flight turn is bounded only by:
- Claude: `maxTurns`, counted per message, and `maxBudgetUsd`, per Part from M2.
- DSH: nothing.
- In M1 there is no ledger, so only `calls(n)`, `wall(min)` and presence apply (:1253).

Consequences (inference):
- A cheap tier is not cheaper in the worst case unless it also lowers `maxTurns` and `wallCapMin`.
- A tier is a reservation ceiling plus notification thresholds, not a hard stop.
- Managed Agents has the same shape, except that a budget change resumes the session automatically, while r4 needs you to act (D8, A14).
- Lowering a tier mid-wish can put the wish over 100% at once, so a downshift should also be a human Decision.

### 4.4 Where budgets touch the rest of r4

| Touchpoint | Today | With tiers (inference) |
|---|---|---|
| Planner (§8.9 (c) step 3 :1223) | estimate in the plan schema | adds a proposed tier and an estimate per harness; proposes only (D8) |
| Plan validation (:1231) | estimate > project cap fails | estimate > chosen tier's cap fails; the card offers a higher tier, or the planner re-plans smaller |
| Plan card (:1234) | total and daily slice | tier name, derived numbers, a worst-case line per harness |
| Project defaults (§10.12 :1715) | per-wish CNY cap | project default tier |
| Governor (§10.2 :1496-1504) | project daily cap | unchanged outer envelope |
| Evidence gate (§8.9 (j) :1390-1391) | overrun = 0; micro-wishes ≤ 5 CNY | overruns counted per tier; micro-wishes run at the lowest tier |
| §14 row 12 (:2610) | estimate vs actual | stratified by (tier, harness), since levels are calibrated per model (CC-MC:671) |

## 5. Implications for Orchestra

1. Decide the tier count on visibility, since no direct evidence separates 3 from 5 (§2.3). Show 3 tiers on the plan card. If there are 5 internally, put the outer two behind "更多", as Codex and Claude Code fence their top levels.
2. Preselect the project default tier in the middle. Show the planner's tier as a labelled suggestion with its estimate, never as the preselected value. An endorsed default pulls choices (JDWJ), and only you choose (D8).
3. Do not call the tier "effort". Vendor effort is soft (CC-BLOG; OAI-PY), while an Orchestra tier sets hard reservations. Use your own names.
4. Keep `Musician.effort` out of the tier in v1. Changing effort would break the cache and per-model calibration (CAPI `cost-optimization.md:161`). Owned Claude Parts already assert that ultracode is absent (§8.9 (i) :1377), so the top tier must not mean ultracode or `max`.
5. A tier sets 7 knobs: `cny`, the `cnyDay` share, `wallMin`, the verify share, the `calls(n)` coefficient and cap, `wallCapMin` and `maxTurns`. `maxBudgetUsd` and the retry floor are derived. Loop and planning caps stay fixed.
6. Give numbers to the per-wish cap, `wallMin`, the `calls` cap and `maxTurns` before M2. Mark them （假设） and calibrate per tier through §14 row 12.
7. The daemon owns the tier-to-harness table. DSH is capped in CNY. Claude and Codex are capped as a share of each quota window plus calls and turns, marked estimated when the window signal cannot be read.
8. Under Q-P10 = B, the plan card states the worst case plainly: after the cap, one in-flight turn still finishes, and a DSH turn has no limit.
9. In M1, a tier controls only `calls(n)`, `wall(min)`, `wallCapMin` and `maxTurns`.
10. Changing tier in either direction is a human-only Decision. Never downgrade silently (cf. CC-MC:446); record desired against applied (§10.10).
11. Calibrate per (tier, harness). The micro-wishes become the lowest tier's reference set.

## 6. Uncertain / not verified

- The platform.claude.com effort and thinking pages could not be fetched: WebFetch returned HTTP 400, and curl failed on an untrusted TLS root. The Claude API facts come from the bundled `claude-api` skill (cached 2026-10-06).
- OpenAI's reasoning guide returned 403, so the API default and guidance prose are unverified. Only the SDK docstrings were read.
- The Codex popup is a test snapshot; the shipping UI may differ.
- The IL and IHJ figures come from secondary summaries.
- MERT's d = 0.45 comes from a truncated abstract; any later correction was not checked.
- No study found tests 3 against 5 ordered tiers on one dimension, so all of §2.3 is inference.
- Two things about Claude quota are unverified: whether `rate_limit_event` carries `utilization` on every event, and whether owned musicians share your subscription windows (lanes B1 and S3).
- r4 does not define `Project.budget.tokensMin`. A per-turn cap for Codex without Goals was not checked (lane B1).
