<!-- Raw researcher report: Opus sweep "consent-lib", 2026-10-26. Unedited. Synthesized and red-teamed into dsh-computer-use.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

Key: consent-lib. I read DSH's application-consent and ownership layer for native computer use as a security designer would. The sources are `@deepseek-ai/dsh-cua` (`packages/experimental/cua`), its macOS helper (`packages/experimental/cua-macos/native`), `cua-bundle`, the consent, object, helper and hover decision notes, and the user-questions, approval, PTC and ACP code. The clone is at HEAD 22ddee37 (`C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dsh-src/repo`). I added `packages/acp`, `packages/interaction/user-questions`, `packages/interaction/user-approval` and `packages/ptc-runtime` to its sparse checkout. All code paths cited are macOS-only today. No binary was run and nothing was installed. Paths are relative to the repo root.

## Facts

**Consent state machine**

1. **Consent is enforced at dispatch time by the executor, not through the model.** The CUA executor owns application consent for every object-API and native-tool dispatch. It uses User Questions for human decisions and the profile config for saved grants (`.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md:13`). The note rejects "trust model instructions or hide controls" because retained objects can still reach native operations (`…consent.md:29`). A raw dispatch that names an `appHandle` without prior `getApp` consent throws `APP_ACCESS_REQUIRED` (`packages/experimental/cua/src/application-access.ts:209-213`; `src/index.ts:310-311`; test `tests/application-access.spec.ts:59`).
2. **Identity is a digest of path plus code signature, not bundle id.**
   - The id is SHA-256 of `canonicalExecutablePath + "\n" + authority` (`packages/experimental/cua-macos/native/Sources/CuaNative/ApplicationAuthorization.swift:14-20`).
   - For a strictly valid, non-ad-hoc signature, the authority is the designated requirement (`:47-55`). It is `persistable: true` only in that case (`:24`).
   - Otherwise the authority is `process:<pid>:<startSec>:<startUsec>`, which binds consent to one process instance (`:18-19`).
   - A not-yet-running app uses an executable content hash (`executable:<sha256>`) and is not persistable (`:27-44`).
   - The path is re-resolved through symlinks and compared to the expected path, else `STALE_APP` (`:14-16`). Launch rechecks the signing identity (`AXWorker.swift:439`).
   - `bundleId` appears only in `AppResult` (`src/protocol.ts:93-95`) and is never part of the identity.
   - Labels and icons are presentation only (`…consent.md:13,17`; `src/protocol.ts:136-137`).
   - This refines the already-verified list: "signed executable identity" means path plus designated requirement, and unsigned apps get per-process-instance consent.
3. **One question covers everything for that app.**
   - The question text is "Allow computer use to launch if needed, read, capture, and control {name}?" (`application-access.ts:150`).
   - The options are `Allow for this session` and `Deny`. `Always allow` is added only if the identity is persistable and a profile writer exists (`:145-146,154`).
   - Free text or anything other than exactly one offered label counts as denial (`:169-182`). A forged "Always allow" for an unsigned app is refused (`tests/application-access.spec.ts:145`).
   - The `approval` intent requires exactly one blocking question, with no `wait` and no multi-select (`packages/interaction/user-questions/src/index.ts:300-336`; `docs/subsystems/user-questions.md:25`).
4. **Session grants and refusals live in memory and are keyed by Session.**
   - Decisions are stored in `Map<Agent['id'], Map<CuaApplicationId, {allowed}>>` (`application-access.ts:42`). An Agent id is the Session id: "SessionId (the shared live agent and durable session identity)" (`docs/subsystems/core.md:478`).
   - Decisions survive Agent and helper replacement within the same Session id (`tests/application-access.spec.ts` "retains %s when the same session gets a new agent", around line 368).
   - They are cleared on provider disposal or DSH restart (`application-access.ts:59-66`; `…consent.md:21`).
   - There is no capacity limit or eviction (`packages/experimental/cua/README.md:111`).
   - Same-app selections within a Session are serialized, so one pending question cannot produce competing decisions (`application-access.ts:222-231`; `…consent.md:23`).
5. **Saved grants live in profile config.**
   - `allowedApps: [{id, name, executablePath}]` is part of the provider config (`src/index.ts:38-41,83-86`). It is written through `settings.mutate(entryId, set allowedApps)` with a revision check (`src/index.ts:174-181`).
   - The permission page shows it as `allowedApps` (`src/access-types.ts:190-197`).
   - Adds and removals share one mutation queue that reads the current list (`application-access.ts:297-309`; `…consent.md:23`).
   - A saved grant is checked before any question (`application-access.ts:137-142`).
   - **The saved grant therefore applies to every Session on that profile.** That includes delegated child Agents, which cannot ask (fact 12), and ACP or headless sessions (fact 13). This is inferred from the code path; no test covers a child or ACP Session holding a saved grant.
6. **Refusals are per Session and sticky.**
   - Deny or `ASK_CANCELLED` calls `invalidate(id, agent)`, records `allowed:false` for that Session only, and aborts that Agent's handles and in-flight operations for the app (`application-access.ts:158-162,179-181,272-291`).
   - A refused Session is never asked again (`:140`) until the human uses "Allow asking again", which clears refusals across all Sessions without granting anything (`:113-119`; `README.md:52`).
   - "A refusal in one session does not cancel another" is tested: Session B's Deny leaves Session A's grant valid, and A's in-flight operation keeps running (`tests/application-access.spec.ts:259,343`).
   - **Consequence for a multi-Session host (inferred):** each Musician Session asks separately (`tests/application-access.spec.ts:383`). One Musician's Deny does not stop another Musician driving the same app.
7. **Revoke from the permission page is global and cancels in-flight work.**
   - `revoke(id)` removes the saved grant, then calls `invalidate(id)` with no agent. That marks every Session holding the app as refused, aborts all in-flight operations for it, and disposes every affected Agent connection, awaiting native cleanup (`application-access.ts:88-107,272-291`).
   - Disposing a connection also invalidates that Agent's **other** application handles. Those need fresh selection, but their grants stay reusable (`…consent.md:43`).
   - Input already delivered cannot be undone, and nothing is replayed (`README.md:38,52`).
   - Removing a grant by editing config is enforced before the reload notification arrives (`application-access.ts:260-263,292-296`; `tests/application-access.spec.ts:270,280`).
   - Reauthorization uses a fresh connection, so old snapshots can never become valid again (`…consent.md:25`; `tests/access.spec.ts:253`).
   - `revoke` and `retryApproval` are `@Remote` methods any connected Client may call (`src/access.ts:122-132`).

**Per-application or per-action**

8. **Consent is per application. No step asks the human per click.** After `select`, `run()` only checks `permitted(selection)` (lifetime not aborted, and either session scope or a saved grant still present) and then dispatches (`application-access.ts:209-220,260-263`). Nothing distinguishes look from act: reading, capture, launch and input are all granted at once (`:150`). Generic tool approval is a separate requirement (`…consent.md:13`; `README.md:23`). Whether the `cua` tool or its `run_code` sub-calls ever raise `approval/request` under the default `ask` policy was not verified.
9. **Snapshot ids and their limits for binding an approval to an element.**
   - Element actions (click by index, setValue, selectText, performSecondaryAction) require `snapshotId + elementIndex` (`src/protocol.ts:17,48-56`). The native helper requires the exact snapshot ID. A new or failed refresh of the same app/window scope invalidates the old snapshot (`packages/experimental/cua-macos/native/README.md:70`; `AXWorker.swift:143,157`).
   - Coordinate actions take an optional `snapshotId` (`protocol.ts:18`). The host refuses coordinate input without an observation (`STALE_SNAPSHOT`), and absolute pixels without a screenshot (`SCREENSHOT_REQUIRED`) (`src/coordinates.ts:60-62`).
   - Snapshot generation "do[es] not lock the desktop against simultaneous user or application changes" (`native/README.md:70`).
   - Snapshots are owned per Agent connection (`2026-10-09-cua-shared-native-helper.md:15`).
   - **Inferred:** a snapshot id proves only that the agent has not re-observed since approval, not that the UI is unchanged. Only the Agent that owns the connection can present it. An outside proxy cannot mint its own snapshot inside that connection.
10. **DSH's approval channel carries no tool arguments.** `ApprovalRequest` "deliberately omits tool arguments" and links by `callId` (`docs/subsystems/approval.md` §Approval request). Outcomes are closed and fail closed (`approval.md:22-28`). PTC sub-calls get ids of the form `<parent>:ptc:<n>` and run through the full tool pipeline (`.agents/notes/implemented/feature/2026-06-15-ptc.md:51,65`).

**Headless and ACP Sessions**

11. **With no human answerer, the call fails closed and nothing is recorded.**
    - If the `userQuestions` service is absent, the call throws `APP_APPROVAL_UNAVAILABLE` (`application-access.ts:143-144`).
    - If the service is present but no answerer claims the waterfall, it throws `NO_PROVIDER` (`packages/interaction/user-questions/src/index.ts:340-349`). CUA rethrows that without granting or recording a refusal (`application-access.ts:166`; `tests/application-access.spec.ts:136,307`).
12. **Delegated children cannot ask.** `ask()` admits only the exact live runtime root; an owned child gets `DELEGATED_CALLER` (`user-questions/src/index.ts:137-150`). CUA maps that to `APP_APPROVAL_UNAVAILABLE`: "ask the main task to perform this operation" (`application-access.ts:163-165`; test `:252`).
13. **ACP exposes no User Questions channel.**
    - The ACP server bridges only `approval/request` to `session/request_permission`, with `allow-once` or `reject-once` and `toolCall: {toolCallId}`. It "never infers a durable grant" (`packages/acp/acp/src/index.ts:154-174`).
    - Elicitation is listed as unsupported (`packages/acp/acp/README.md:82,177`).
    - `packages/acp` has no `user-questions`, `userQuestions` or `AskUserQuestion` hits (grep).
    - **Inferred:** an ACP-driven Session hits `NO_PROVIDER` on first `getApp` and fails closed, **unless** the app is in profile `allowedApps`, in which case it runs with no human in the loop (fact 5).
14. **A consent wait inside `run_code` counts against the program deadline.** The `run_code` deadline includes nested tool and approval waits (default 120 s, max 600 s) (`packages/ptc-runtime/ptc-runtime-node/src/config.ts:12,33-34`). **Inferred:** a slow human aborts the program through the signal path (`ASK_ABORTED`), which is not recorded as a refusal.

**PTC-only exposure**

15. **Tools exist only for Agents on the `ptc` preset.**
    - `agentPreset` defaults to `'ptc'` (`src/index.ts:82`), and the bundle pins `agentPreset: ptc` (`packages/experimental/cua-bundle/cordis.patch.yml:7-8`).
    - Tools and guidance are registered per Agent scope only when `composedPreset(agent.ctx) === config.agentPreset`. They are re-evaluated on `agent/created` and `agent-preset/selected`, and removed when the preset changes (`src/index.ts:349-376`; `tests/agent-scopes.spec.ts:47`).
    - "Other presets receive no CUA contributions" (`cua-bundle/README.md:74`).
    - `agentPreset: false` registers globally (`src/index.ts:349`). **Inferred:** in that case a non-PTC Agent sees a top-level `cua` tool.
16. **The underlying `cua` operation tool is reachable from inside PTC.** There is one tool named `cua` with a method/params union (`src/index.ts:293-296`; `src/protocol.ts:34-73`). PTC presents it as `tools.cua` through `run_code` (`cua-macos/README.md:153`). Program code can call `tools.cua({method, params})` directly and bypass the object facade, but consent is still enforced at `run()` (fact 1). Host-only operations (`launchApp`, permission requests) are not in the model schema (`protocol.ts:84-90`).
17. **What persistent PTC means for a long-lived Musician.**
    - `persistent-in-memory` keeps one REPL per live Agent, never saved to disk.
    - Memory is cleared by restart, Agent disposal, provider unload, cancellation, timeout or overflow, and a fork starts empty (`packages/ptc-runtime/ptc-runtime-node/README.md:80-82`).
    - Concurrent runs for one owner are rejected (`:84`).
    - The mode is a profile-wide setting. Enabling it reloads the shared runtime and "may interrupt an active call" (`packages/experimental/cua/README.md:50`; `cua-bundle/README.md:89`).
    - Retained app objects do not reserve the app (`README.md:113`).
    - Consent is keyed by Session and survives an Agent rebuild, but the handles inside retained objects go stale (`STALE_APP`) after helper replacement or revocation (`AXWorker.swift:126-127`).
    - PTC code keeps its own authority: "persistent PTC and separately authorized shell tools are not an operating-system sandbox" (`cua-macos/README.md:70`; `…consent.md:13`).

**Shared native helper**

18. **What is shared and what is isolated in the helper.**
    - **Shared:** one helper service per user per executable digest, across Agents **and Hosts**, elected by a version lock plus a path lock (`2026-10-09-cua-shared-native-helper.md:13`). One FIFO orders every complete desktop operation, clipboard included (`:15`; `native/README.md:30`). There is a single screenshot RPC slot, and a timed-out capture holds it, so new captures get `CAPTURE_BUSY` (`…helper.md:17`).
    - **Cross-host paste lock:** paste is additionally serialized across helpers by `withFileLock(join(tmpdir(),'dsh-cua-system-clipboard'))` (`src/index.ts:266-267`; `native/README.md:92`).
    - **Isolated per Agent connection:** app handles, AX snapshots, limits and cancellation (`…helper.md:15`). Consent decisions are per provider instance, so per Host process (inferred from `application-access.ts:40-47` being an in-memory instance).
    - **What two Agents on the same app experience:** "An app handle grants no exclusive use"; "A may retain its app object while B screenshots and changes the same application; A reads fresh AX afterward" (`…helper.md:15,25`). Cross-call reservation was explicitly rejected, and "Explicit task coordination determines any required execution order" (`2026-10-13-cua-continuous-hover.md:15,19`).
    - **Failure scope:** an operation that cannot stop can invalidate the shared process and every handle on it (`…helper.md:17`).
19. **Single-provider slot (consistent with the verified list).** dsh-cua registers `ComputerUseProviderName('dsh-cua')` (`src/index.ts:220`).

**Image handling**

20. **Screenshot admission and storage.**
    - A screenshot requires `ctx.attachments` and a resolved model route that declares image input, else the call throws before capture (`src/index.ts:130-143`).
    - Bytes are admitted once through `admitEncodedImages`. A dimension mismatch is a `NATIVE_PROTOCOL` error (`:249-259`).
    - Model content gets metadata plus `{type:'image', attachment}`, with no base64 (`:122-127`). Admission and storage failures reject the call (`README.md:36`).
    - The **program value still contains base64** (`src/index.ts:263-264`; `README.md:36`), so PTC code holds the pixels.
    - Session events never carry base64 (`docs/subsystems/attachment.md:5`).
    - The attachment store is "retention-neutral … garbage collection is deferred" (`attachment.md:176`). **Inferred:** CUA screenshots persist in the DSH store with no TTL.
21. **No secret handling and no app denylist.** `secure|password|redact` has zero hits in `cua/src`, `cua-macos/native/Sources` and `cua-macos/README.md`. Nothing blocks consenting to Terminal, System Settings or the DSH host's own app. The AX tree reports field values (`cua-macos/README.md:160`).
22. **No kill switch or presence detection.** There is no kill switch, banner or physical-input detection (grep for kill switch, panic, physical input, takeover, banner and indicator found none). The only stop controls are revocation (fact 7), Agent disposal and a locked desktop (`SESSION_LOCKED`, `NativePlatform.swift:102`).
23. **Actions report dispatch only and are never retried.** Results are `{dispatched:true, verified:false}` (`src/protocol.ts:130`). Uncertain input is never replayed (`README.md:38`; `native/README.md:30,58`).

## Patterns for Orchestra

- **Adopt** dispatch-time enforcement keyed to a native identity rather than a label: path plus code signature, falling back to the process instance for unsigned code (facts 1–2). The Tier 2 per-lease allowlist in the Instrument model should take Windows identities the same way (Authenticode signer plus canonical path, else pid plus start time). The checks should run at dispatch, not when the lease is granted.
- **Adopt** "free text never grants" and "unknown answer = deny" (fact 3). This matches Orchestra's two-phase approval reply parsing.
- **Adopt** global revocation with the semantics of E12 and the `draining → unknown-outcome` state: abort in flight, retire connections, invalidate stale handles forever, never replay (facts 7, 23). DSH already implements E12 for CUA.
- **Adopt** DSH's admission-before-capture order: no store or no vision model means the call is rejected before capture (fact 20). Bytes stay out of the log. This partly implements E7 at the log level.
- **Avoid "Always allow" (`allowedApps`)** for any DSH Musician. Saved grants skip the question, so they authorize every Session on that profile, including delegated children and ACP Sessions with no human (facts 5, 12, 13). This contradicts E13 (never answer `always`) and D8 (human-only approvals per Musician). Orchestra should give each DSH Musician a private profile with `allowedApps: []`. It should also watch that config key and raise P1 if it becomes non-empty.
- **Avoid relying on per-Session refusal as exclusion.** One Musician's Deny does not stop another (fact 6), and the helper gives no ownership across calls (fact 18). That contradicts the single-holder Lease (Tier 2) and E15. Orchestra must hold the Lease itself; DSH "leaves this to the caller" by explicit design.
- **Two-phase approval, E3:** DSH has no per-action approval (fact 8), and its approval channel carries no arguments (fact 10). Orchestra cannot bind an approval to `snapshotId/elementIndex` through DSH. It can only use the `allow-once` per `callId` that ACP exposes, whose sub-call arguments it may not see. Binding to a snapshot id would also only prove "no re-observation since approval" (fact 9). E3 stays unimplementable on DSH-native CU without a DSH host plugin.
- **E6 taint and E1 isolation:** DSH has neither concept; CUA operates on the user's real desktop. Treat any DSH Session with dsh-cua loaded as Tier 2 (a bypass session) and taint it.
- **E8 redaction:** absent. AX values and screenshots reach the model unredacted, and PTC holds the raw bytes (facts 20, 21). Orchestra cannot redact inside DSH's pipeline.
- **E9 retention:** this conflicts with the DSH attachment store, which has no garbage collection (fact 20). Q8-B (private config root) is needed for DSH Musicians too, and disposal must purge the DSH attachment store.
- **E5 / kill switch:** absent in DSH (fact 22). Orchestra's procguard detection should treat a live `dsh-cua` helper as harness-native CU to be observed. Today that is macOS-only, so it does not apply on this Windows host.
- **Headless:** DSH fails closed when no human is reachable (facts 11–13), which aligns with "presence required". But an Orchestra-owned ACP Musician gets no consent prompt at all. Consent would need a DSH Client attached to that Session, or a DSH-side `user-questions/request` listener. That listener would be a Cordis plugin in the host, which is not verified to be possible from outside.

## Verdict

Orchestra should **wrap** DSH's application consent, not reuse it as the Grant, and must not bypass it. It is a sound inner check: identity bound at dispatch, fail-closed headless, global revoke without replay. Orchestra should keep it as a second layer. It cannot serve as Orchestra's Grant or Lease, for three reasons:
- It is per application, with no look/act split and no per-action approval.
- Its saved grants authorize every Session on the profile, children and ACP included, which conflicts with E13 and D8.
- It leaves exclusion between Sessions and Hosts explicitly to the caller.

Concretely, run DSH Musicians on a private profile with `allowedApps: []`, a non-`ptc` preset, or the bundle disabled unless a human-granted Tier 2 Lease is active. Treat any dsh-cua-enabled Session as a tainted bypass session. On this Windows machine none of this executes today, because the bundle is disabled off darwin and Windows is "planned".

## Open questions

1. Does the `cua` tool, or a `run_code` sub-call to it, raise `approval/request` under the default `ask` policy? Which component decides per-tool approval? (not verified)
2. Does ACP's `session/update` stream PTC sub-call arguments (`<parent>:ptc:<n>`), so that a `request_permission` for one can be judged? `packages/acp/acp/src/updates.ts` has no `ptc` hits. (not verified)
3. Can an external host register a `user-questions/request` answerer, for example through a profile patch plugin, to route CUA consent into the Orchestra Inbox? (not verified)
4. Is a blocking (non-timed) consent question and its answer written to the Session log anywhere? (not verified; the projection tracks only timed questions, `docs/subsystems/user-questions.md:158`)
5. Will the planned Windows C# provider keep the same identity scheme (Authenticode instead of the designated requirement) and the same cross-Host shared helper? (README:112 promises the same authorization semantics, not the mechanism)
6. Is the third-party `@qlzt` / `@qilin-agent` cua-driver-mcp republish compatible with this consent layer? No: mcp/native providers register separately and do not go through `ApplicationAccess` (inferred from the single-provider slot, `src/index.ts:220`).

## Sources

- `packages/experimental/cua/README.md:12,23,36,38,40,50,52,111-114`
- `packages/experimental/cua/src/application-access.ts:13-310`
- `packages/experimental/cua/src/access.ts:42-166`
- `packages/experimental/cua/src/access-types.ts:1-30`
- `packages/experimental/cua/src/application-types.ts:1-14`
- `packages/experimental/cua/src/index.ts:34-41,81-105,122-143,159-379`
- `packages/experimental/cua/src/protocol.ts:17-20,34-90,93-137`
- `packages/experimental/cua/src/bridge.ts:15-21`
- `packages/experimental/cua/src/coordinates.ts:1-30,60-62`
- `packages/experimental/cua/src/types.ts:7-14`
- `packages/experimental/cua/tests/application-access.spec.ts:59,128-150,252-270,307,343-395`
- `packages/experimental/cua/tests/access.spec.ts` (test list)
- `packages/experimental/cua/tests/agent-scopes.spec.ts:47`
- `packages/experimental/cua-macos/native/Sources/CuaNative/ApplicationAuthorization.swift:1-69`
- `packages/experimental/cua-macos/native/Sources/CuaNative/AXWorker.swift:126-157,243-247,433-439`
- `packages/experimental/cua-macos/native/Sources/CuaNative/NativePlatform.swift:89,102`
- `packages/experimental/cua-macos/native/README.md:30,58,70,92,94`
- `packages/experimental/cua-macos/README.md:43,47,70,86,153,160`
- `packages/experimental/cua-bundle/cordis.patch.yml:1-10`
- `packages/experimental/cua-bundle/README.md:12,36,54,74,89`
- `.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md:13-47`
- `.agents/notes/implemented/architecture/2026-09-17-experimental-cua-object-api.md:13-41`
- `.agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.md:13-25`
- `.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.md:13-19`
- `.agents/notes/implemented/feature/2026-06-15-ptc.md:51,65`
- `docs/subsystems/user-questions.md:25,158,212-300`
- `packages/interaction/user-questions/src/index.ts:137-150,300-349`
- `docs/subsystems/approval.md:5,22-45`
- `docs/subsystems/permission-presets.md:11,49`
- `docs/subsystems/attachment.md:5,176`
- `docs/subsystems/core.md:478`
- `docs/subsystems/ptc-runtime.md:104`
- `packages/ptc-runtime/ptc-runtime-node/src/config.ts:10-34`
- `packages/ptc-runtime/ptc-runtime-node/README.md:12,80-84`
- `packages/acp/acp/src/index.ts:154-174`
- `packages/acp/acp/README.md:32,74,82,177`
- Orchestra design note: `G:/_Projects/dsh-orchestra/docs/research/computer-use.md` (sections "Instrument model" and "Rules Orchestra enforces", E1–E15)
