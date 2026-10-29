<!-- Raw researcher report: Opus sweep "dynamic-workflow", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into dynamic-workflow-merge.md; where the two disagree, the synthesized file wins (see its Review log). -->

**Verdict.** Yes, merge dynamic workflows into Orchestra, but as an Orchestra-level **Score**: a script that orchestrad runs over the Post Office. Do not adopt DSH's `tool-workflow` as the cross-harness engine. Leave native workflows (DSH `workflow`, Claude Code Workflow) as tools that run inside a single musician; Orchestra observes them as groups of Clones. The reasons: in DSH 0.2.1-rc.2 the child provider is fixed for a whole run, and there is no budget, no journal, no resume and no OR-join. Losing those properties would make A2A worse.

`$DSH` = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`; "spec" = `G:\_Projects\dsh-orchestra\docs\specs\2026-10-26-dsh-orchestra-design.md`.

## What 'dynamic' means vs static DAGs (Dify/n8n)

- **Static DAG.** The graph is declared before the run, branches are predicates over variables, and fan-out width is fixed when you design it. In n8n, one AND/OR setting covers a whole IF node. Dify's Variable Aggregator rejoins only exclusive branches, not parallel ones (`docs\research\landscape.md:67-68`).
- **Static nodes, dynamic width.**
  - LangGraph `Send` handles the case where "the exact edges are not known ahead of time": map-reduce fan-out decided at runtime ([graph-api](https://docs.langchain.com/oss/python/langgraph/graph-api)).
  - `interrupt()` needs a checkpointer plus a `thread_id`. On resume it "restarts the entire node from the beginning", so side effects before the interrupt must be idempotent ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)).
  - Durability modes are `exit`, `async` and `sync`. A task that started but did not finish is re-run on resume, and the docs recommend idempotency keys ([durable-execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)).
  - CrewAI Flows: decorators are static and `@router` labels are chosen at runtime. `and_()` waits for all listed methods; `or_()` fires once per emitting method. `@persist` saves state to SQLite, and you resume by state id ([flows](https://docs.crewai.com/en/concepts/flows)).
- **Dynamic (code-as-workflow).** Claude Code Workflow and DSH `dsh-workflow` decide agent count, loop iterations and branches from agent outputs at runtime, so the "graph" is a trace. dsh-apollo `/exec` shows the pattern (GPL-3.0; design only, [skills/exec/SKILL.md](https://github.com/Menghuan1918/dsh-apollo/blob/HEAD/skills/exec/SKILL.md)):
  - exactly one `workflow` call per dependency wave;
  - the review loop is code: a fresh reviewer each round, a schema-checked verdict, and a breaker after 5 rounds;
  - worktree creation, merge and cleanup stay on the main thread, because "the workflow engine has no filesystem".
- **Temporal** is the reference model for durability. It re-runs workflow code against the event history; activities run once and their results are reused; `Date.now()`/random are forbidden ([docs.temporal.io/workflows](https://docs.temporal.io/workflows)). Claude Code's journal plus its Date/Math ban follows the same pattern.

**Implication for R16 ("A AND B → branch", loops with caps, `docs\research\requirements.md:45`).** `const [a,b]=await parallel(...); if (a?.ok && b?.ok) …` expresses this exactly. Before a run you can only draw a *skeleton* (phases, gates, loop brackets with K). Fan-out counts and which branches were taken exist only in the live overlay. So R16 is "skeleton + trace" and never an editor, which matches the spec's §3.2 non-goal (spec:287).

## DSH vs Claude Code workflow primitives

| Aspect | Claude Code Workflow (given) | DSH 0.2.1-rc.2 (evidence) |
|---|---|---|
| Meta | `export const meta{}` inside the script | Separate JSON `meta` param; vocabulary "matches the Claude Code dynamic-workflows meta block" (`dsh-workflow\lib\types\types.d.ts:33-38`; `dsh-tool-workflow\README.md:32`) |
| `agent()` options | label, phase, schema, model, effort, `isolation:'worktree'`, agentType | label, phase, schema, provider, model. `effort`/`isolation`/`agentType` are named as **deferred** and rejected `UNSUPPORTED_OPTION` (`dsh-workflow-ptc\lib\index.js:12`, embedded guest) |
| Child failure | `null` | `null`. Hook misuse, tripped caps and **child start failure** (`AGENT_START`) kill the script (same file:12; `dsh-workflow\lib\types\index.d.ts:81`) |
| `parallel` / `pipeline` | Barrier / per-item, no barrier | Identical text (`dsh-tool-workflow\lib\index.js:144-146`) |
| OR / race with cancel | None | None. A script can call `Promise.race`, but `agent()` exposes no cancel handle, so losers keep running (inferred) |
| Caps | Concurrency min(16, cpus−2); lifetime 1000 | Same: `min(16,max(1,cores−2))`, `maxTotalAgents` 1000. Caps are "cooperative" (`dsh-workflow-ptc\lib\index.js:631`; README:41-45,155) |
| Budget | `budget{total,spent(),remaining()}`, hard | "No token-budget vocabulary" (`dsh-workflow\README.md:129`) |
| Nesting | `workflow()`, one level | None (README:128) |
| Resume | `journal.jsonl` plus cached-prefix replay | "No journaling or resume" (README:127) |
| Determinism | Date.now/Math.random forbidden | No rule (nothing is replayed). Script has "no filesystem, network, timer, or Node.js APIs" (`dsh-tool-workflow\lib\index.js:148`) |
| Child routing | Claude subagents only | **One subagent provider per run**, set by deployment config (`dsh-tool-workflow\README.md:172`). The per-agent `provider` option is the *LLM* provider (`dsh-workflow-ptc\lib\index.js:12`, `startChild` → `agentOptions`). The seam names external ACP/SDK/Codex/Claude Code providers that "execute once" (`dsh-subagent\README.md:12,205`), but none are installed locally (verified with `ls`) |
| Durable records | `<config>/projects/<slug>/<sid>/subagents/workflows/wf_*/` with `agent-*.jsonl`, `.meta.json` (`workflowPhase`), `.prefix.json`, and `journal.jsonl` (`launched`, `started{key,agentId,label,phase}`, `result{key,agentId,result}`, key `v2:`+64 hex). Verified locally from keys only | Top-level calls only: `tool-workflow/run-start`, `agent-start{seq,label,phase,childId}`, `agent-end`, `run-end` in the parent session log. `phase()`/`log()` are not durable (`dsh-tool-workflow\README.md:76-80`; `lib\types\types.d.ts:9-55`) |
| Built-in UI | — | `dsh-client-ui-workflow-run`: run → phase → member disclosure, "identities and statuses only; scripts, outputs, errors, logs, usage, topology, and controls remain outside" (README:12,88-91) |
| Background | — | `run_in_background` → `ctx.jobs` job (`dsh-tool-workflow\README.md:42`) |

**Differences that matter**

1. A DSH script cannot mix harnesses, cannot hold a budget, and loses all progress on a crash. It cannot be Orchestra's durable cross-harness engine.
2. **Activation-pool collision (inferred, untested).** Workflow children draw on the parent's `maxActiveSubagents` pool (default 8, shared by descendants, `dsh-subagent\README.md:53`). DSH does not queue at that cap (spec:148). This machine has 12 cores, so auto-concurrency is 10. The 9th concurrent start would fail, and `AGENT_START` is fatal, so a wide `parallel()` could kill the whole script. The spec plan to set `maxActiveSubagents` = `perModel` (spec:590) makes this collision more likely.
3. Both harnesses leave zero-token observable traces of workflow runs, so Orchestra can show native workflows as grouped Clones from M2 onward.
4. Ralph is a *deployment-owned fixed script*: "the model supplies data only and cannot alter the loop" (`dsh-tool-ralph\README.md:61`). Orchestra should copy this for Score templates.

## Failure modes and which control-flow owner fixes them

| Failure | Evidence | Owner that fixes it |
|---|---|---|
| False "done" in round 1 | A goal round "may complete the goal immediately" (`dsh-tool-goal\README.md:55`); Ralph's reports are "not independently verified" (`dsh-tool-ralph\README.md:12`) | **Script**: a fresh verifier agent with a schema verdict, or a deterministic test command, gates completion |
| Loops to the cap | Goal cap 256 → `round-limit`; self-block only after 3 consecutive rounds (`dsh-goal\README.md:12`; `dsh-tool-goal\README.md:48`); "round-count budget only" (`dsh-goal\README.md:158`) | **Script** with a literal K (apollo uses 5), plus **human** escalation at bounce N=3 (spec §10.7) |
| These two together give the bimodal "round 1 or forever" | Community complaint (`docs\research\requirements.md:37`) | Rule: the model never owns termination |
| Fan-out cost runaway | DSH caps are cooperative; no tokens or CNY tracked | **Daemon**: governor plus a hard Score budget |
| Activation-cap crash | Collision (2) above | **Daemon**: queue at admission; cap native concurrency |
| Crash loses the run | No DSH journal | **Daemon**: journal plus `requestId` replay |
| Silent partial results (`.filter(Boolean)`) | Child failure resolves to `null` | **Script** completeness critic; the Score view counts nulls |
| Taste decided inside a loop | R12 | **Human** Decision; the script may only `ask()` |
| Approval stall | Claude prompts never time out (spec D8) | **Human** queue, with timeout = deny |
| Open-ended objective with unknown decomposition | — | **Model-driven goal loop** inside one musician, round-capped, wrapped by a scripted verifier |

Division of labour: the **model** owns the work inside a step. The **script** owns fan-out, joins and termination. The **human** owns taste, approvals and cap overrides. The **daemon** owns admission, budget and durability.

## Merge design for Orchestra

**(a) Score = workflow script → Exchanges**

- **Where it runs.** In a child process of orchestrad, inside a procguard Job, with no fs/net. A `node:vm` alone is "not a security boundary" (`dsh-workflow-ptc\README.md:158`).
- **API.** A DSH/Claude Code-compatible subset — `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget` — plus `race` and `ask`. `agent(prompt, {to | template, label, phase, schema, deadline_s})`:
  - `to:'Ren'` creates a Post Office Exchange (`role:request`, `delivery:queue`, `from:{kind:'score', runId}`). The auto-reply (rule 1) becomes the return value. `timedOut`, `refused`, `cancelled`, `unknown` and schema failure all return `null`.
  - `template:'reviewer@claude'` creates an *ephemeral Part* of a template identity, used for wide fan-out, and disposes it after the reply.
- **Cached resume ⇄ idempotency.**
  - `key = v1:sha256(canonical{target,prompt,opts})` and `requestId = score:<runId>:<key>#<occurrence>`.
  - The journal mirrors Claude Code's `launched/started/result` records.
  - On restart the daemon re-executes the script from the top. Calls that already replied hit rule 5 ("same id same content → replay receipt"), so nothing is redelivered.
  - In-flight calls follow the three phases of §8.3. An `unknown` outcome returns `null` plus an InboxItem and is never resent.
  - `Date.now` and `Math.random` are absent from the script's environment. Instead, `args.startedAt` carries the start time, recorded once at launch.
- **Script edits.** A changed script digest starts a new run. Cached results are reused only for template calls, and only on an explicit "resume with edits".

**(b) Join semantics**

| Primitive | Meaning | Circuit glyph |
|---|---|---|
| `parallel` | AND barrier; failed items become `null` | AND gate |
| `race(thunks)` (new) | OR: the first non-null wins. Losers get a Post Office `stop` and end `cancelled`, but are still billed. This differs from CrewAI `or_`, which fires per emission | OR gate |
| `pipeline` | Per-item chain, no barrier | Bus ×n |
| `quorum(thunks,k)` (optional) | k-of-n, for judge panels | k/n gate |
| `orchestra_wait` (existing) | Musician-side AND across Exchanges (spec:720-730) | Rest sign |

A ScoreRun is a Work root. For Exchanges that originate from a Score, the per-root relay cap of 20 (rule 7) is replaced by `budget.agents`. The hop cap of 4 still applies to any onward forwarding.

**(c) Score view rendering.** Add a **Circuit** tab next to the existing timeline (spec §11.4).

- **Skeleton**, from the script's AST plus `meta.phases`:
  - phases as columns;
  - AND/OR gates;
  - a pipeline as a bus labelled `×args.items.length`;
  - an `if` on a schema field as a diamond;
  - loops as a repeat-sign bracket "↻ ≤K". A lint step requires a literal K, or `loopUntilDry({dry:2, max:K})`.
- **Live overlay**, from ScoreCall journal events:
  - node colour = Exchange state (§6.3);
  - iteration counter "2/5", dry counter "dry 1/2", null count;
  - **budget meter** showing CNY, tokens and agents spent vs. total, with reservations hatched, next to the governor's queue depth.
- **Native runs.** DSH `tool-workflow/*` events and Claude Code `wf_*` journals render as read-only run → phase → member trees, at the same level of detail as `dsh-client-ui-workflow-run`.

**(d) Governor and budget integration**

- Every `agent()` call goes through governor admission: it queues and never fails. This closes the spec's "fan-out bypasses governor" gap (spec:589) and the activation-cap crash.
- The Ledger reserves an estimate per call and settles it when usage is known. When a reservation would exceed `budget.total`, the call throws `BUDGET` (a hard ceiling, as in Claude Code). The run stops with a P1 InboxItem; raising the cap is a human-only action.
- Proposed defaults: 64 agents, `maxConcurrent` = min(8, free governor slots), 60 minutes wall time, CNY ≤ the project's daily cap. Unknown usage is recorded as an estimate and never as 0.

**(e) Where workflows must NOT be used**

- **Taste decisions.** A script may call `ask(decision)`. That creates a Decision and suspends the run durably, like LangGraph's interrupt. The script can never resolve a Decision.
- **Approvals.** A script has no approval verb; children's approvals go to the human queue.
- **Live pairing** with a musician.
- **Git topology.** Merging and deleting worktrees is done by the daemon with human confirmation, following apollo's split.
- **Unattended starts.** In v1 a Score starts only from a paired human click; Maestro may only propose one (shadow mode).
- **Small delegations.** For one or two delegations use plain subagents, as DSH's own guidance says (`dsh-tool-workflow\README.md:12`).

**(f) Cross-harness fan-out.** One Score can fan out to Claude, DSH and Codex musicians. A native DSH script cannot (one provider per run), and a Claude Code script is Claude-only. What breaks:

1. **Schema output.** A conversational turn has no native structured output. Orchestra must add format instructions to the prompt, extract and validate the JSON, and allow one repair turn before returning `null`. Use DSH's schema subset as the common denominator: object root with `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf` (`dsh-tool-workflow\lib\index.js:143`). Codex has `exec --output-schema` (`docs\research\cc-codex-protocols.md:64`), but the app-server path is unverified.
2. **Worktree isolation.** Claude Code supports it per agent; DSH defers the option; musicians have a fixed `Part.cwd`. So isolation applies only to ephemeral template Parts, and the daemon creates their worktrees (M3, §10.8).
3. **Usage attribution.** A musician's turn may mix several messages (rule-4 coalescing, steer). Claude's `modelUsage` includes subagents; Codex reports tokens only. Per-call cost is therefore an estimate, with null meaning unknown.
4. **Concurrency.** DSH ACP allows one prompt in flight per session, so `parallel()` calls to the same musician run one at a time. Lint should warn and suggest templates.
5. **Cancellation.** DSH `cancel` does not stop descendants; `close` is needed to reclaim them (spec:537).
6. **Taint.** If a call's prompt interpolates output from a tainted call, the new Exchange is tainted too.
7. **Nested native workflows.** Keep DSH `tool-workflow` off in musicians. If it is ever enabled, require `maxConcurrentAgents ≤ maxActiveSubagents−1`.

## Concrete spec amendments

| § | Amendment | Milestone |
|---|---|---|
| §4 | **D13**: dynamic workflows = Orchestra Score over the Post Office. Rejected alternatives: a Dify editor; DSH `tool-workflow` as the cross-harness engine; goal loops owning termination | — |
| §3.2 | Clarify: a Score is code plus a read-only circuit. No editor. No LLM call outside musicians, so no new agent loop | — |
| §6.1 | Entities `ScoreRun{id,name,scriptDigest,args,budget,status,startedBy}` and `ScoreCall{runId,seq,key,occurrence,label,phase,target,exchangeId,outcome}`; Exchange gains `score{runId,seq}` | M3 |
| §8.1 / §8.3 | Envelope `from.kind:'score'` and `replyFormat.schema`; **rule 9** (requestId from key; `budget.agents` replaces the relay cap; `unknown` → `null` + InboxItem) | M3 |
| §7.4 | `tool-workflow` row: when enabled, `maxConcurrentAgents ≤ maxActiveSubagents−1` and `maxTotalAgents ≤ 64`; CI check | M1 |
| §7.3 / §10.11 | Parse DSH `tool-workflow/*` events and Claude Code `wf_*/{journal.jsonl,*.meta.json}` into Clone groups; add them to the read whitelist | M2 |
| §10.2 / §10.7 / §10.9 | Score admission through the governor; K-lint for loops; bounce N=3 applies to Score loops; `ask()` creates a Decision only | M3 |
| §11.4 / R16 | Circuit tab: skeleton, overlay and budget meter in M3; OR and `ask` in M4; full AST rendering in M5 | M3–M5 |
| §13 | M3: Score v0 with fixed templates only (QA rerun ×N, adversarial verify, review loop K≤3), cuttable. M4: user-authored scripts, `race`, `ask`, Maestro proposes Scores (shadow) | M3 / M4 |
| §17 | **Q13**: who may author and start a Score; default budget | M3 |

**Acceptance tests (zero-token CI)**

1. Kill the daemon after 3 of 5 calls have replied. The rerun makes 0 new deliveries for the 3, never resends in-flight calls, and causes 0 duplicate executions.
2. The same call twice in a loop gets two distinct requestIds.
3. A script that calls `Date.now` fails with `SCORE_NONDETERMINISTIC`.
4. `parallel` with one timed-out call yields `[a, null, c]`.
5. In a `race`, the loser is `cancelled` in ≤5 s and is still billed.
6. `budget.cny=1` stops the run, raises a P1, and makes no further deliveries.
7. 30 parallel calls with `perHarness=4`: at most 4 in flight, 0 failures.
8. A reviewer that always rejects: 3 rounds, then escalation.
9. The same schema sent to fake Claude, a mock DSH and fake Codex validates everywhere. Malformed JSON gets exactly one repair turn.
10. Tainted input produces a tainted Exchange.
11. `ask()` survives a restart; resolving it through MCP is refused.
12. Fixtures with native workflow traces produce Clone groups whose counts match.
13. A Score delivery to DSH creates no `goal/change`.

## Risks

- **Scope creep** toward a Dify-style platform or a new agent loop. Mitigation: templates first, no editor.
- **Replay bugs causing duplicate side effects.** Mitigation: requestId idempotency; `unknown` is never resent.
- **Named musicians are stateful.** A cached reply is correct by idempotency, but the musician's context has moved on since.
- **Fan-out cost.** DeepSeek's 2× peak pricing (spec:243) and poor usage estimates can make a wide Score expensive.
- **Weak schema compliance** from DeepSeek/MiniMax could flood runs with `null`s. Needs a completeness critic.
- **Two orchestration layers can confuse users.** Rule: native workflows inside a musician; Scores across musicians.
- **Drift.** DSH ships a pre-release about every 2 days (spec:320). Claude Code's journal format (`v2:` key) is undocumented. Parsers must degrade to `unknown`.
- **License.** dsh-apollo is GPL-3.0; use its design only.

Sources: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution), [LangGraph graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [CrewAI Flows](https://docs.crewai.com/en/concepts/flows), [Temporal workflows](https://docs.temporal.io/workflows), [dsh-apollo exec skill](https://github.com/Menghuan1918/dsh-apollo/blob/HEAD/skills/exec/SKILL.md).