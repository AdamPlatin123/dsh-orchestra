# Dynamic Workflow × bots/A2A: should Orchestra merge them?

Date 2026-10-26, revised after two red-team reviews (Review log). Position paper refined from [wf] and the five other researcher reports; does not edit the spec.

**Evidence keys.** [oc] [km] [grok] [a2a] [cv] [bot] [spec] as in [bot-architectures.md](bot-architectures.md), plus:
- `$DSH` = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` (0.2.1-rc.2).
- `CC-W` = https://code.claude.com/docs/en/workflows. `LG` = https://docs.langchain.com/oss/python/langgraph/{graph-api,interrupts,durable-execution}. `CR` = https://docs.crewai.com/en/concepts/flows. `TP` = https://docs.temporal.io/workflows.
- `AP` = https://github.com/Menghuan1918/dsh-apollo/blob/HEAD/skills/exec/SKILL.md (GPL-3.0, design only).
- `LC` = https://github.com/letta-ai/letta-code/blob/main/src/tools/workflow/; `GW` = https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-workflow/src/.

"(tool description)" marks Claude Code facts from the Workflow tool text, not verified against `CC-W`.

## Position

**Merge, in two layers and in stages, never as the A2A bus.**

**Layer 1: native workflows stay inside one Part (M1–M3).** Every engine studied scopes a workflow to one session, and most default to one-shot workers that cannot be messaged (OpenClaw Swarm, Grok Build, Claude Code). Two exceptions: DSH local children are catalogued and accept messages while resident (`$DSH\dsh-workflow-ptc\README.md:71`; `dsh-subagent\README.md:61,123`), and letta-code resumes a worker by `conversationId` within the same parent (`LC/workflow-engine.ts:335-341`; `LC/sdk-spawner.ts:445-470`). "Clones are never A2A addresses" is therefore Orchestra policy, not a harness fact.
- A native run is a Run inside one Musician's Part, drawn as a Clone group.
- Orchestra clamps it (M1, an R06 criterion), observes it (M2) and governs it (M3, R33): admission, deadline, budget, never auto-relaunch.

**Layer 2: Orchestra's own cross-harness workflow, the Arrangement — deferred to M6, behind a go/no-go after M4.** ([wf] called it "Score", already the §11.4 screen.)
- A deterministic script run in a WASM-sandboxed interpreter; a Post Office *client* with `trust: runtime`, so every call gets receipts, `requestId` idempotency, caps, taint and the governor, and a crash replays without double delivery.
- **v0:** fixed read-only templates, synchronous `parallel`. **v1:** named Musicians, `pipeline`/`race`/`quorum`, `ask()`, user scripts, Maestro proposals (shadow).
- Why defer: the ~25-week solo plan has no slack; M1 and M3 are already the heaviest milestones (spec §13.3, §13.5).

**The split:** Musicians are *who* does the work; workflows are *how* a bounded piece fans out. Orchestra builds no graph DSL, declarative format or editor, no model-owned termination, and no unattended starts.

## What "dynamic" means

- **Static DAG** (Dify, n8n): graph and width fixed before the run; Dify rejoins only exclusive branches (`docs/research/landscape.md:67-68`).
- **Static nodes, dynamic width:** LangGraph `Send`; `interrupt()` restarts the node on resume, so earlier side effects must be idempotent (`LG`). CrewAI `and_()`/`or_()`, `@persist` in SQLite (`CR`).
- **Code as workflow:** the program decides count, branches and loops; the "graph" is a trace. Claude Code, DSH, Grok Build (Rhai), letta-code, OpenClaw Swarm ("The program is the orchestration", `D/tools/swarm.md:17-18`), ADK 2.x dynamic nodes, MAF Pregel supersteps.
- **dsh-apollo `/exec`** (`AP`): one `workflow` call per dependency wave; fresh reviewer per round, breaker after 5; worktree operations on the main thread.
- **Temporal** (`TP`): replays code against event history; each activity runs once; no `Date.now`/random.

**R16** (`docs/research/requirements.md:45`): before a run only a *skeleton* exists (phases, gates, loop brackets); counts and branches exist only in the trace. R16 = "skeleton + trace", never an editor.

## Five engines compared

| Aspect | Claude Code | DSH 0.2.1-rc.2 | Grok Build `xai-workflow` | letta-code | OpenClaw Swarm |
|---|---|---|---|---|---|
| Script | JS + `export const meta` | JS; JSON `meta` whose vocabulary "matches the Claude Code dynamic-workflows meta block" (`$DSH\dsh-workflow\lib\types\types.d.ts:36-37`) | Rhai; `meta` first | `agent/parallel/pipeline/decide` | `agents.run()` in JS Code Mode (`swarm.md:127-150`) |
| Caps | 16 concurrent by default, env-settable 1–256; 4,096 items per call; 1,000 per run. >25 agents or 1.5M tokens: advisory warning (`CC-W`) | min(16, cores−2); 1,000 total; "cooperative" (`dsh-workflow-ptc\lib\index.js:631`; `README.md:155`) | 128 calls (max 1,024); 32 concurrent; 4 runs/session (`lib.rs:10-19`, `host_service.rs:24-26,75`, `manager.rs:22`) | Run: 16 concurrent, 1,000 agents, 1,000 `decide()`, 1,000 script tool calls, 4,096 items (`LC/workflow-engine.ts:34-38`). Worker: 10 min, 1,000 tool calls, stop at 3 identical (`LC/sdk-spawner.ts:98-100`) | 32 / 50 / 200; wait ≤600 s (`swarm.md:60-63`) |
| Budget | `budget{total,spent(),remaining()}` (tool description) | None (`dsh-workflow\README.md:129`) | `budget()`, a journaled host call (`GW/engine.rs:776-784`) | — | — |
| Engine, resume | Async JS. Same-session replay in agent start order; the first changed prompt and every later agent rerun; `Date.now`/`Math.random` throw (`CC-W`) | No resume (`README.md:127`) | Synchronous: `parallel([specs])` allocates seq in array order; no `pipeline`/`race`; `timestamp()`/`sleep()` are errors (`GW/engine.rs:128-145,510-575`). Journal `(seq,kind,req_hash,result)`; a different call is `Divergence` (`journal.rs:6,43,187`) | Debug journal; "nothing replays" (`journal.ts:1-9`) | — |
| Children | Subagents; no mid-run input (`CC-W`) | Local continuable children: catalogued, messageable while resident, `NOT_RESUMABLE` once disposed; they hold activation slots (`dsh-workflow-ptc\README.md:71`, contradicting `:53`; `lib\index.js:330`; `dsh-subagent\README.md:53`). Provider fixed per registration; per-call `provider`/`model` overrides (`dsh-tool-workflow\README.md:172`; `dsh-workflow-ptc\lib\index.js:12`) | Workflow children unaddressable; ordinary children addressable (`address.rs:46-57`) | One-shot by default; `conversationId` resumes an agent-free worker of the same parent (`LC/workflow-engine.ts:335-341`) | One-shot; not steerable (`swarm.md:317-323`) |
| Approvals | Script prompts are not user requests (auto mode); runs pause for agent permission prompts (`CC-W`) | Children pinned to `approvalPolicy:"never"`: refused silently (DSH-D#11062) | Pause kinds incl. `NoProgress`, `BackOff` (`run.rs:8-14`); `await_user()` | — | Collectors deny approvals (`swarm.md:366-367`); Lobster halts with a resume token (`D/tools/lobster.md:9-31`) |
| Records | `agent-*.jsonl` + `.meta.json` (`docs/research/cc-codex-protocols.md:14`); script and saved results under the session dir (`CC-W`); `journal.jsonl` (tool description, unverified) | Run/agent start-end only; UI "identities and statuses only" (`README.md:76-80`; `dsh-client-ui-workflow-run` README:88-91) | Phase / log / telemetry | `<task-notification>` | Flat groups; no saved definitions or DSL (`swarm.md:399,652-654`) |

**Takeaways.** Runs are session-scoped everywhere and caps live in code; most engines default to one-shot workers, but DSH and letta-code can continue them. Durability differs: GB replays a *synchronous* engine with divergence checks; Claude replays by start order in-session; ADK/MAF checkpoint; Letta and DSH do not resume. DSH (no budget, journal or OR-join) cannot be the cross-harness engine.

## What broke in the wild

From [cv]:
- **Caps conflict or get bypassed.** DSH auto-sets `maxConcurrentAgents` up to 16, above `maxActiveSubagents` 8, so `ACTIVATION_LIMIT_REACHED` fails the run (DSH-D#10655); `maxDepth` is unenforced on the workflow path (DSH-D#7098). Claude's caps are env-configurable to 256 concurrent and its large-run warning is advisory (`CC-W`).
- **Authority relay.** The triggering human message reached every `agent()` as an overriding instruction (CC#96640, CC#100033).
- **Non-idempotent relaunch.** A keypress restarted a run, killed a live agent, re-ran finished ones and overwrote files (CC#86777).
- **Silent loss.** 26 of 70 agents died in a network blip (CC#66686); `agent()` returned another session's content (CC#96546); output truncated (DSH-D#10115).
- **Over-provisioning.** 25 agents instead of 6–7, about 10× the cost (CC#91532).
- **Boundary retyping** by a model (CC#67684). **Subagent storms**, braked with workflow limits (v2ex.com/t/1228533). **Bots ignore workflows** unless prompted (DSB#420, DSB#421).

## Who owns which failure

- **Script:** false "done" in round 1 (`$DSH\dsh-tool-goal\README.md:55`) → fresh verifier with a schema verdict or a test command; loops to the cap of 256 (`$DSH\dsh-goal\README.md:12,158`) → literal K; silent partial results (CC#66686) → completeness critic, null count.
- **Daemon:** no progress under the caps (Magentic-One `max_stalls=3`) → stall counter; fan-out cost (CC#91532) → governor, hard budget, R41 estimate; activation crash (DSH-D#10655) → admission queue, clamp; lost or duplicated runs (CC#86777) → journal + `requestId`, never auto-relaunch; authority relay (CC#96640) → `trust: runtime` (R34).
- **Human:** taste inside a loop (R12) → Decision via `ask()`; approval stalls (D8) → one queue, timeout = deny; bounce N=3 (§10.7).
- **Model:** an objective with unknown decomposition → a capped goal loop inside one Musician, wrapped by a scripted verifier.

The rule: the model owns work inside a step; the script owns fan-out, joins and termination; the human owns taste, approvals and cap overrides; the daemon owns admission, budget and durability.

## Merge design

### Layer 1: native workflows inside a Part (M1 → M3)

- **M1 clamp (R06).** `tool-workflow` stays off in private DSH homes (§7.4). Once enabled: `maxConcurrentAgents ≤ maxActiveSubagents−1`, `maxTotalAgents ≤ 64`, `enableRunInBackground:false`, CI-checked. A background run returns at once (`dsh-tool-workflow\README.md:42,50`), so the Part looks idle: §10.4 idle release would `close` it and kill the run, and the Post Office would deliver into it.
- **Claude.** Workflows off on owned Parts until R33 (`disableWorkflows` or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, `CC-W`; else SDK `disallowedTools`). Verifying this is an S3 go criterion.
- **M2 observe.** Parse DSH `tool-workflow/*` events and Claude run records into Clone groups with a Stage card (phase, members, tokens, nulls). Resident DSH workflow children stay Clones (`inactive`); the reaper tracks their slots against `maxActiveSubagents`. Count fan-out from events, never caps. 25 agents or 1.5M tokens → P2 `workflow-run` item. Whitelist verified record paths (§10.11).
- **M3 govern (R33).** Deadline and budget per run. A breach runs cancel → close → resume (§10.4), keeping the Musician's context. After a daemon restart a run is never relaunched; an InboxItem says "interrupted, n of m done" and offers in-session resume. GB pause kinds map to inbox kinds: `user` → question, `verification` → ready-for-review, `no_progress` → runaway, `back_off`/`infra` → failure.

### Layer 2: Arrangements over the Post Office (M6, after go/no-go)

**(a) Runtime and API.**
- **Sandbox.** A JS interpreter compiled to WebAssembly (e.g. QuickJS-in-WASM) in an orchestrad child; only Arrangement host calls cross a message channel; no fs, net, timer, `Date` or `Math.random` bindings; optionally an AppContainer/LPAC token without network. Why: a Job gives kill-on-close and accounting only (S4 procguard, spec §13.2); Node's permission model gives no "security guarantees in the presence of malicious code" and has no network flag (nodejs.org v24 permissions); `node:vm` "is not a security boundary" (`dsh-workflow-ptc\README.md:158`).
- **API v0:** `agent`, `parallel([specs])`, `phase`, `log`, `args`, `budget`. **v1** adds `pipeline`, `race`, `quorum(k)`, `ask`, `to:`.
- **`agent(prompt, {template | to, label, phase, schema, deadline_s})`:**
  - `template:` runs a worker Part of a **template Musician** (`kind:'template'`, one system Musician per template, never addressable: `template-not-addressable`). Templates are deployment-owned ("The model supplies data only and cannot alter the loop", `$DSH\dsh-tool-ralph\README.md:61`) and read-only in v0. The QA-rerun template reuses the M1 QA template's preset and persona.
  - v1 `to:'Ren'`: an Exchange with `role:request`, `delivery:queue`, `trust:runtime`, `from.kind:'arrangement'`, under inbound policy, `executionPartId` and concurrency 1. ACP prompts land on DSH as `{kind:'user'}` (§8.5), so a DSH target needs the relay-source bundle, else `relay-source-missing`.
- Template workers get no orchestra-mcp tools except `orchestra_report` (CI assertion), so they cannot `orchestra_send`.

**(b) Durability.**
- **Replay v0 (GB's model):** synchronous `parallel`, seq allocated in spec order, dense journal; every host call is journaled, including `budget()` reads and `args`; divergence is checked per seq (`GW/engine.rs:510-575`; `journal.rs:33-43`).
- **Replay v1 (Temporal-style, needed for `pipeline`/`race`):** journal per-call completion events; replay resolves cached promises in recorded completion order; calls are identified by deterministic call-site path (`phase/stage/itemIndex/occurrence`), divergence checked per path.
- **Keys.** `key = v1:sha256(canonical{target, templateDigest, harnessVersion, prompt, opts})`; `requestId = arr:<lineageId>:<path>#<occurrence>`. `lineageId` survives "resume with edits", which is refused while any call is in-flight or `unknown`.
- **Outcomes.** Each call journals one `CallOutcome`: `ok | timedOut | denied | schemaInvalid | unknown | cancelled | budgetPaused | late`. `unknown` is final for that occurrence. A human resend (§6.3) is a new Exchange outside the run (`from.kind:'human-resend'`); its result goes to the human, never to replay.
- **Result storage.** ArrangementCall keeps `resultDigest` and `resultRef`; bodies of non-terminal runs are pinned against the 14-day TTL and secret purge (§6.1 redaction #2). A purged pinned body makes the run `unresumable` with an InboxItem; never `null`.
- **Why replay** rather than Letta's "nothing replays": §8.3 promises zero duplicate execution; a script's only side effects are `requestId`-keyed Post Office calls, so LangGraph's idempotency precondition holds (inferred).

**(c) Joins.** `agent()` returns the value or `null`; `outcome(h)` gives the reason; denials resolve to `null` with `denied`.

| Primitive | Semantics |
|---|---|
| `parallel` (v0) | AND barrier |
| `race` (v1) | First `ok` wins; denied or failed calls never win; all fail → `null`, `allFailed`. Stops go only to template workers; named Musicians are never interrupted (A4): result discarded, billed |
| `pipeline` (v1) | Per item, no barrier; a stage failure drops that item to `null` and skips its later stages, as DSH does (`dsh-tool-workflow\lib\index.js:143-145`) |
| `quorum(k)` (v1) | Counts only `ok`; fails early once k is unreachable |
| `orchestra_wait` | AND across Exchanges, Musician side (§8.6) |

- **Deadlines** count from the admission request; on expiry a queued call is withdrawn or a delivered template call stopped (`timedOut`). Late replies journal `late`, billed, never surfaced.
- **BUDGET pause:** no new admissions; in-flight calls finish and are journaled; refused calls stay unjournaled, so a raised cap resumes them without double charge (GB `engine.rs:1258,1431`).
- **Caps.** The per-root relay cap (20) stays hard for A2A Exchanges; Arrangement calls use a separate `arrangementCalls` cap (64); hop cap 4.

**(d) Termination.** `meta.stop` composes conditions AutoGen-style (`AG/base/_termination.py:79-83`): `calls(n) | cny(x) | wall(min) | external | stall(3)`. Loops need a literal K or `loopUntilDry({dry:2, max:K})` (lint); review loops also use bounce N=3. Per-worker defaults from letta-code (`LC/sdk-spawner.ts:98-100`): 10 min, 1,000 tool calls, stop after 3 identical calls.

**(e) Governor and budget.** Every call goes through governor admission, which queues and never fails (closes "fan-out bypasses governor", §7.4). The Ledger reserves an estimate and settles on real usage: 80% → P2 incident; 100% → `BUDGET` pause + P1, and only you raise the cap. Incidents dedup per policy, threshold and window, rolled up to `rootId` (Paperclip). Defaults: `arrangementCalls` 64, `maxConcurrent` = min(8, free slots), 60 min wall, CNY ≤ project daily cap; unknown usage is an estimate, never 0. More than 25 projected calls shows a pre-run estimate (new R41).

**(f) Authority and approvals.**
- **Start.** Your click authorizes the run, not each worker's actions. Computed prompts carry `trust:runtime`; the triggering text is never interpolated as an instruction (R34; CC#96640).
- **Provenance.** `ArrangementRun.authoredBy`; an agent-authored script (Maestro) taints every call. Before Start, a zero-token dry run against the fake harnesses shows the projected call graph, budget and targets; agent-authored scripts need typed confirmation.
- **Template approvals.** Claude workers use native SDK permission rules, like the M1 QA template. DSH has only one-shot grants and `ask|never` policy (`dsh-user-approval\README.md:154`; `dsh-permission-presets\README.md:133`), so a DSH "allowlist" would mean Orchestra answering `allow`, which D8 and §3.2 forbid. DSH workers get capability from sandbox mode only; Orchestra auto-denies each `request_permission` (safe under D8) and aggregates denials into one InboxItem per run (cf. OpenClaw collectors, `swarm.md:366-367`). No batched approvals: each stays bound to its request digest (§10.9).
- Named Musicians (v1) keep their own approval queue. Scripts have no approval verb: `ask()` creates a Decision and suspends the run durably, with a timeout (default cancel) and ledger reservations released; resolving it through MCP is refused.

**(g) Cross-harness caveats.** Schemas: prompt for JSON, validate, one repair turn, then `null`; DSH's subset is the common denominator (`dsh-tool-workflow\lib\index.js:143`). v0 templates are read-only, so no worktrees; a fix a verdict asks for goes as an Exchange to the owning Musician. Per-call cost is an estimate. Cancelling DSH needs `close`. Taint follows interpolation and script provenance. No nested native workflows in workers.

**(h) Not for:** taste, approvals, live pairing, git topology, unattended starts, one or two delegations (`dsh-tool-workflow\README.md:12`), Musician conversation.

**(i) Rendering.** M3: native runs as read-only run → phase → member trees (R16). M6: a Circuit tab in the §11.4 Score screen; skeleton from the AST and `meta.phases` (phase columns, AND/OR gates, `×n` bus, "↻ ≤K" loops) plus a live overlay (Exchange colours, counters, nulls, budget meter).

## Corrections to the original report

"Score" → **Arrangement**; v0 templates only; the Arrangement is a Post Office *client*, never the bus ([grok], [a2a], [cv]); the activation collision is reported (DSH-D#10655, #7098); template approvals deny-and-report. Added: divergence check (GB), stall counter and composable stops (AutoGen), budget incidents (Paperclip), R33.

## Spec amendments

- **§2.4**: + Orchestra observes and governs native runs; Arrangements come later.
- **§3.2**: + no graph DSL, declarative format or editor; no LLM calls outside Orchestra-owned, governor-admitted sessions.
- **§4**: + **D13** two layers (native workflows = Clone groups; Arrangement = Post Office client). Rejected: DSH `tool-workflow` as cross-harness engine; Dify editor; goal loops owning termination; workflows as the A2A bus.
- **§6.1** (M2/M6): Musician kind `template`; `ArrangementRun{id, lineageId, scriptDigest, authoredBy, args, budget, stop, status, startedBy}`; `ArrangementCall{runId, path, key, occurrence, target, exchangeId, outcome, resultDigest, resultRef}`; Clone + `groupId`, `phase`.
- **§6.5**: + `workflow-run` (M2), `arrangement-paused`, `budget-incident`.
- **§7.4** (M1): the clamp incl. `enableRunInBackground:false`; Claude workflows off on owned Parts; surface silently refused approvals.
- **§7.3 / §10.11** (M2): verified Claude record paths (`journal.jsonl` after S3); DSH `tool-workflow/*` events.
- **§8.1 / §8.3** (M6): `trust:'runtime'`, `from.kind:'arrangement'|'human-resend'`, `replyFormat.schema`; path-derived `requestId`; separate `arrangementCalls` cap; `unknown` final; divergence stops.
- **§10.2 / §10.7 / §10.9**: admission of every call; 80/100% incidents; event-counted fan-out; K-lint; stall(3); `ask()` = Decision only; DSH templates auto-deny and report.
- **§11.3 / §11.4**: group cards (M2); native run trees (M3); Circuit tab (M6).
- **§13**: M1 clamp; M2 observe; M3 R33. **M6** (go/no-go after M4): Arrangement v0 with read-only templates (QA rerun ×N, adversarial verify, review verdict). v1 later: named Musicians, `pipeline`/`race`/`quorum`, `ask`, user scripts, Maestro proposals (shadow).
- **§15**: + (inferred) Arrangement v0 ≈ 4–6 weeks, outside the 25-week plan.
- **§16 / §17**: R16 → M3 (native trees only); + R33, R34, R41. + **Q-W1** who may author and start an Arrangement, and its default budget. + **Q-W2** accept that DSH templates are sandbox-only (no out-of-sandbox commands)?

## Acceptance tests (zero-token CI)

1. Kill the daemon after 3 of 5 calls replied: the rerun makes 0 new deliveries for those 3 and never resends in-flight calls.
2. The same call twice in a loop gets two distinct `requestId`s.
3. A script touching `Date.now`, `require('fs')`, `fetch` or `process` fails closed (`ARRANGEMENT_NONDETERMINISTIC` or sandbox error).
4. A replay issuing a changed call at a seq/path stops with `ARRANGEMENT_DIVERGENCE`, 0 deliveries.
5. v1: out-of-order `pipeline` completions, and a branch on `budget.remaining()`, replay identically after a kill.
6. `parallel` with one timed-out call yields `[a, null, c]`, outcome `timedOut`; a call stuck in admission times out from its admission request.
7. A `race` with one denied and one successful worker returns the success; an all-fail race yields `allFailed`.
8. `cny(1)` pauses with a P1 item, no further deliveries; three crossings of one threshold → one incident.
9. 30 parallel calls with `perHarness=4` keep ≤4 in flight, 0 failures.
10. Always-rejecting reviewer: 3 rounds, then escalation; three no-progress rounds trip `stall(3)`.
11. One schema validates on fake Claude, mock DSH, fake Codex; malformed JSON gets one repair turn.
12. Tainted input or an agent-authored script yields tainted Exchanges.
13. No worker prompt carries the triggering human text as an instruction; every envelope has `trust:runtime` (CC#96640 fixture).
14. A DSH template worker's `request_permission` is auto-denied; the script sees `denied`; exactly 1 InboxItem per run.
15. `ask()` survives a restart; resolving it via MCP is refused. A purged pinned result makes the run `unresumable`.
16. Native-trace fixtures produce Clone groups with matching counts; a restart never relaunches a native run.
17. With the clamp, `parallel(12)` on 12 cores gives 0 `ACTIVATION_LIMIT_REACHED`, and `run_in_background` is rejected.
18. An Arrangement delivery to DSH creates no `goal/change`; a DSH `to:` target without the relay-source bundle is refused.

## Risks

- **Scope creep** toward Dify → templates first, no editor or DSL (OpenClaw declines them too, `swarm.md:652-654`); go/no-go gate.
- **Replay bugs** (async ordering, purged bodies) → v0 synchronous; pinned results; fail closed.
- **Named Musicians are stateful** → v1 only, with the relay-source bundle on DSH.
- **Fan-out cost** (DeepSeek 2× peak pricing, §2.3) → R41 estimate, hard budget, incidents.
- **Weak schema compliance** → repair turn, completeness critic, null count.
- **Harness drift** (DSH ships every ~2 days; Claude records undocumented) → parsers degrade to `unknown`; event-counted fan-out.
- **Over-denial** by DSH templates → one aggregated item; wider sandbox mode (Q-W2).
- **License** → dsh-apollo (GPL-3.0) and GBR design-only; reusing grok-build's (Apache-2.0) journal design needs no NOTICE, copied code keeps its LICENSE and attribution.

## Review log

Two red-team reviews, 2026-10-26; re-checked against local `$DSH` files, `gh api` (grok-build, letta-code), `CC-W` and Node docs.

**Accepted:**
- DSH children continuable (`README.md:71` vs `:53`); letta `conversationId`; "all engines agree" weakened; Clone rule = policy.
- Ultracode restated; caps env-configurable 1–256.
- letta run vs worker caps split; `meta` quote re-cited; per-call provider overrides.
- `journal.jsonl` unverified; `principal` → `trust:runtime`; R27 untouched, R41 added.
- Replay: v0 synchronous with journaled `budget()`; v1 path ids and completion-order replay.
- DSH approvals sandbox-only, auto-deny, one item; batched option removed.
- WASM sandbox plus escape test. Layer 2 → M6 go/no-go; v0 read-only.
- `CallOutcome`, deadlines from admission, late and budget-pause rules, pipeline stage failure.
- Lineage ids, human resend outside the run, digests in key; pinned results, `unresumable`, `ask()` timeout.
- DSH `to:` needs relay-source bundle; race stops template-only; template Musician kind; non-goal reworded.
- Clamp disables background runs; cancel → close → resume; Claude workflows off until R33.
- Relay cap kept, separate `arrangementCalls`, workers only `orchestra_report`; `authoredBy` taint plus dry run.

**Rejected or partial:**
- Writing the six reports is out of scope here and is logged as blocking in the companion.
- `disallowedTools` is kept only as a fallback: `CC-W` documents `disableWorkflows`, which is preferred.

**Uncertain:**
- Claude `budget()` and record names rely on the tool description.
- Node's network flag was checked for v24 only.
- The 4–6 week estimate is inferred.
