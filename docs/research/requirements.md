## Personas & jobs-to-be-done

Short names used below: `$DSH` = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai` (installed 0.2.1-rc.2). `ATD` = `G:\_Projects\dsh-TUI\docs\agent-teams-design.md`.

| Persona | Job to be done |
|---|---|
| **P1 Multi-project conductor** (the user) | "I run 2+ large apps at once. Tell me which project needs me now, what decision is waiting on me, and keep everything else moving without me holding the context." The pain is ADHD-style switching between framework choices, a backend design, a runaway grep, and a flaky UI test. |
| **P2 Team-mechanism tinkerer** (dsh-context, BSB and TUI contributors) | "Show me how the agents actually talk to each other (DMs, report-backs, dispatch) so I can find out why a Lead fails to dispatch, dispatches to the wrong member, or a reviewer bounces work forever." |
| **P3 Domain-agent builder** (moved from Pi plus a custom frontend to native DSH) | "Move my agents between frontends without their memory getting scrambled." |
| **P4 Cost-conscious evaluator** | "Measure whether a team mechanism is better at about 1 CNY per task, and choose a model mix (DeepSeek or MiniMax) that does not blow up under concurrency." |
| **P5 Vibe conductor** ("Tokenmaxxing") | "I only want to talk to the main agent or the group. It should route to the right agent and keep going (a persistent bot, AutoRoute, like Ultracode)." |

## Requirements

Grounding facts used in the table:
- In team mode, `list_agents` lists only the Lead and its durable teammates: `$DSH\dsh-experimental-tool-agent-team\lib\index.js:321-323`.
- `wait_agent` exists only in team mode, and it returns `noProgress` when no peer is active: `:330-347`.
- The legacy `dsh-tool-subagent-control` registers only `send_message` and `interrupt_agent` (`lib\index.js:18-63`). Its `list_agents` is a separate subpath export that is not registered by default (`package.json:21`), so this last point is inferred.
- The legacy interrupt "Subagents it started will keep running" (`lib\index.js:63`).
- Defaults:
  - `maxActiveSubagents` 8 and `maxDepth` 1: `$DSH\dsh-subagent\lib\index.js:2979-2980`
  - Team `maxMembers` 16, `maxTasks` 256, message limit 64 KiB: `dsh-experimental-agent-team\lib\index.js:1420-1422`
  - Ralph `maxRounds` 256: `dsh-tool-ralph\lib\index.js:20`
- Teammates share a working directory, a team lives in one process only, and task owners are never auto-released: `ATD:99`.
- The team on/off switch works only per profile: `ATD:58,90`.
- `/export` leaves out team messages: `ATD:97`.

| ID | Requirement | Source (paraphrase) | Pri | Acceptance signal |
|---|---|---|---|---|
| R01 | One roster of every live session across Codex, Claude Code and DSH, grouped by project, then harness, then agent tree, with a compact status line per group | User: one Orchestra panel for 3 harnesses; many apps at once | P0 | All live sessions on one screen; state within 2 s; `team 2/3 running · tasks 3/7`-style summary (ATD:51) |
| R02 | **Observe before control**: an A2A timeline and formation view with every send, relay, steer, dispatch and settle as a directed edge, plus replay | dsh-context author: observability comes first; "agents get reused but we never see them talk directly" | P0 | 100% of `agent-message` relay events (ATD:20) and spawn/settle events rebuilt as edges; a finished run can be replayed |
| R03 | Full subagent tree at every depth, including children spawned by teammates | "List agents often returns 0; can't see the subagents I dispatched" | P0 | Tree count matches the harness count; no "0" while descendants are running |
| R04 | An event-driven **join/wait** primitive across harnesses; detect polling | dsh-apollo added `wait_subagent` and the problem went away; without it agents either ignore subagents or poll frantically | P0 | Lead blocks on a join; flag when the same list/poll call repeats more than N times in T |
| R05 | **Lifecycle reaper**: release idle children, detect orphans, kill a whole tree | "DSH doesn't release subagents, so the backend crashes"; interrupt leaves grandchildren running | P0 | 0 orphans after a parent ends; resident count stays at or under the cap; one-click kill tree |
| R06 | **Tempo governor**: caps per project and per model on active agents, tokens/min and CNY; queue instead of failing | MiniMax is cheap but concurrency "explodes"; DeepSeek controls it well | P0 | Caps enforced; queue depth visible; no crash at 2x the cap in a burst |
| R07 | **Runaway detector**: identical tool-call loops (grep), memory/RSS growth, output floods → auto-pause and alert | "A subagent looping grep ate all the memory" | P0 | K repeated calls or crossing the RSS limit → paused within 10 s, with an inbox item |
| R08 | **Loop termination policy**: explicit done criteria, a round cap, and a reviewer bounce cap that escalates to the human | Workflows "finish in round 1 or loop forever"; the reviewer bounces work back endlessly | P0 | Bounce count visible; Nth rejection escalates; flag when the rounds-to-done histogram is bimodal |
| R09 | **Dispatch audit**: task board with owner, unassigned and stale tasks, mis-route marks; human can claim or reassign (BSB "claim") | Leads skip dispatch or dispatch the wrong task | P0 | Task unassigned for more than T is flagged; reassign in 1 action; owners released (ATD:99 gap) |
| R10 | **Attention inbox**: one queue across projects for approvals, decisions, failures and blocked items, with snooze, reminders and priority | "Context switching turned me ADHD"; reminders | P0 | Every blocking item reaches the inbox and links to its session; a reminder fires |
| R11 | **Cross-harness A2A bus**: shared envelope, addressing, delivery receipts, reply threading | "A2A is the prerequisite for multitasking" | P0 | A Claude Code session messages a DSH agent; reply is logged with a receipt |
| R12 | **Context provenance**: a per-project decision log (ADR) bound to git (commit, date) that outranks stale comments and early dev notes; contradictions flagged | Early code comments polluted context and conflicted with the corrected direction; "bind to git history?" | P1 | A planted stale comment is ignored in favor of the ADR; conflict surfaced |
| R13 | **Transcript ACL**: scoped read access to earlier task transcripts and memory; log every read | "Read early dev transcripts without permission" | P1 | Reads outside scope are denied and logged |
| R14 | **Layered, portable memory**: instruct memory (operator) separate from self memory (agent) separate from project memory; versioned; append vs overwrite made explicit; import/export with diff | Pi → native DSH migration left memory confused | P1 | A migration round trip gives an identical set; conflicts listed, never silently overwritten |
| R15 | **Member work journal**: structured self-report of each work or control event, joined to harness events | The community member's added log | P1 | Each journal entry links to a harness event; mismatches flagged |
| R16 | **Score / graph view**: conditional nodes (A AND B → branch), loops with repeat caps, live run overlay; reads dynamic workflows | "Circuit diagram"; Dify-like A AND B node | P1 | Define an AND branch; live run shows node states; it can stay view-only |
| R17 | **Persistent conductor and AutoRoute**: always-on bot that routes requests to the right project and agent through a capability registry; shows its reasoning; user can override | Bot architecture; Ultracode-like persistent interaction | P1 | Every route shows reason and confidence; override in 1 action; accuracy measured on a labeled set |
| R18 | **Agent and preset registry**: reusable agent profiles across teams; Skill Cluster self-creation vs a curated preset menu | The user's Skill Cluster plus `/init`; "external presets to choose from?" | P1 | Catalog shows which teams used which agent |
| R19 | **Repro bundles for UI bugs**: environment, seed, trace or recording; rerun ×N; flake rate | "How to reproduce UI-test bugs reliably" | P1 | Bug has an attached bundle; rerun ×N reports a rate |
| R20 | **Decision board per project** (framework, architecture) pending on the human; agents read the decisions | "Which frontend framework, which backend architecture" | P1 | Pending decisions appear in the inbox; resolved ones feed R12 |
| R21 | **Escape containment**: permission and sandbox profile per agent, file-system write scope, network policy, out-of-policy detection | "Escaping the harness is as easy as breathing" | P1 (P0 for unattended bots) | Violations blocked and logged |
| R22 | **Workspace isolation**: worktree or write lock per agent | Teammates share a working directory (ATD:99) | P1 | No two concurrent writers on one file |
| R23 | **Group-talk mode**: talk to one agent, a section, or everyone (DS-Bot style group chat) | "Just talk well to the main agent or group" | P1 | Broadcast reaches the section; replies threaded |
| R24 | **Reuse the ecosystem**: link or embed BSB, dsh-context, tonghuashun ledger, dsh-adaptive-router instead of rebuilding | BSB and TUI sub-ecosystems, "plugins of plugins" | P1 | Deep links work; costs come from the ledger |
| R25 | Session-level team on/off (needs upstream) | Team switch is per profile only (ATD:70) | P2 | Per-session opt-in |
| R26 | Exports include A2A messages | `/export` omits them (ATD:97) | P2 | Export carries the reason behind each reply |
| R27 | Tokenmaxxing mode: whole-codebase context with a cost preview | "Just attend to the whole codebase" | P2 | Cost estimate shown before running |
| R28 | Rich media preview (images, video, Blender) | Image and video work in the TUI | P2 | Inline preview |

## Non-goals

- **No forking of harness internals.** Orchestra adapts to public behavior, like dsh-TUI's rule "consume upstream public behavior only" (ATD:3). Shims such as a wait or reaper layer are allowed; patching TeamService is not.
- **Not a new agent loop or model router.** Reuse `dsh-adaptive-router` and each harness's own loop.
- **Not a Dify-style no-code platform for end users.** The graph is for observing and constraining agent flows, not a product builder.
- **No fully autonomous unattended mode in v1** without R05, R06, R07 and R21 in place.
- **No cloud or multi-tenant service.** Local, single user, Windows first.
- **No full benchmark runs** (all of DeepSWE). Subsets only.
- **No replacing each harness's memory store.** Orchestra brokers and layers memory (R14); it does not own it.
- **No fixing of upstream DSH bugs** (lack of release, `list_agents` scope). Detect them, work around them, and report them upstream.

## Orchestra metaphor → UI mapping

| Metaphor | UI element | Backing data |
|---|---|---|
| Conductor on the podium | The human plus the persistent conductor agent; baton = command bar with AutoRoute | R17 route decisions |
| Sections (left harp/flute/violin, right timpani/cello, center winds) | Lanes by project, colored by harness (e.g. white = Claude, orange = Codex, blue = DSH) | R01 roster |
| Principal player | Team Lead or persistent agent; implicit Lead per root (ATD:9) | team roster projection |
| Chibi clones (same hair color) | Subagent instances inheriting the lineage color; solid = running, faded = inactive or awakeable (ATD:14), ghost = orphan | R03 tree, R05 reaper |
| Music stand | Task sheet: current task, plan, done criteria; turning a page = progress | `team_task_*`, goal/plan |
| Score | Workflow graph; measures = rounds; repeat/volta signs = loops with a cap (R08) | R16 |
| Cue gesture / cue lines | Dispatch and `send_message`; animated edges between players | R02 A2A timeline |
| Tempo / metronome | Concurrency and budget governor | R06 |
| Dynamics (pp–ff) | Token burn rate; tonghuashun K-line sparkline per player | ledger |
| Rests | `wait`/join; a long rest with no join = polling smell | R04 |
| Fermata | Blocked on the human; goes to the inbox | R10 |
| Concertmaster | Reviewer role with a bounce counter | R08 |
| Wrong note / feedback squeal | Runaway or loop alert; the player is muted (paused) | R07 |
| Stagehand | Reaper that clears idle or orphaned players | R05 |
| Tuning before the concert | Context warm-up: `/init`, ADR and memory load, stale-context check | R12, R14 |
| Sheet-music library | Preset and Skill Cluster registry | R18 |
| Program / setlist | Multi-project agenda with reminders; intermission = scheduled check-in | R10, R20 |
| Rehearsal | Eval run on stub or cheap models | Evaluation plan |
| Encore | Replay or rerun for repro (×N) | R19, R02 replay |
| Stage boundary | Sandbox and write scope; a player walking off stage = escape alert | R21, R22 |

## Evaluation plan ideas

1. **Zero-cost rehearsal with scripted stub models.** dsh-TUI already tests teams with scripted stub models (ATD:7). Build deterministic scenarios and score each:
   - **Dispatch accuracy**: tasks seeded with a known correct owner.
   - **Join correctness**: a child settles at time t; count poll calls before and after the R04 join.
   - **Bounce cap**: a reviewer stub always rejects; it must escalate at N.
   - **Loop termination**: a goal that is never met must stop at the cap.
   - **Orphan cleanup**: parent ends with grandchildren still running.
   - **Burst**: spawn 3x `maxActiveSubagents` (default 8).
2. **Replay-based observability score.** Feed recorded session logs into Orchestra's projections and measure what share of spawn, relay, settle and task events become edges. Target 100% before adding control features.
3. **Micro-DeepSWE.** 10–20 stratified tasks at about 1 CNY each on DeepSeek. Compare single agent, native DSH team, and team plus Orchestra guards. Metrics: pass rate, CNY per solved task, wall time, human touches. Use the same seeds, run ×3, report variance.
4. **Model-mix stress.** MiniMax vs DeepSeek at caps 4, 8 and 16. Measure failure or crash rate, queue latency and cost, to find a safe tempo per model.
5. **Context-pollution probe.** Plant a stale code comment that contradicts the ADR. Score how often the agent follows the ADR, with and without R12 provenance injection.
6. **Memory migration round trip.** Export, import into another frontend, and diff the instruct, self and project layers. Score conflicts that would be silently overwritten (target 0).
7. **Attention metrics for the human.** Interventions per hour, time from blocked to noticed, number of project switches, and items that missed a reminder. A weekly self-report of overwhelm on a 1–5 scale.
8. **Health metrics on every run** (shown as charts). Distribution of rounds to done (bimodal at 1 vs the cap is bad), polling ratio, orphan count, reviewer bounce count, tokens per useful diff line.