<!-- Raw researcher report: Opus sweep "orchestra-fit", 2026-10-26. Unedited. Synthesized and red-teamed into dsh-computer-use.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

Key `orchestra-fit`. This maps DSH's computer-use (CU) stack onto Orchestra's design, read as Orchestra's architect. Inputs:
- The spec: §4, §6.1, §6.5, §8.1, §8.6, §10.1–10.12 and §13.
- `docs/research/computer-use.md` in full (cited below as `cu.md:<line>`).
- The A1–A20 and D13–D16 rows of `bot-architectures.md`.
- From the clone at `22ddee37`: the READMEs, subsystem docs and decision records. Repo paths below are relative to the clone root.

I also read a few source lines where a README did not settle a question: `cua/src/application-access.ts`, `computer-use-cua-driver-mcp/src/index.ts` and `cua/src/protocol.ts`. I pulled `packages/acp` and `packages/interaction` into the sparse checkout. Upstream trycua files were fetched with `gh api` into `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dcu/orchestra-fit/` (`cua-readme.md` and `WINDOWS.md`, both at tag `cua-driver-rs-v0.28.0`). Nothing was executed or installed, and nothing was written under `G:/_Projects/dsh-orchestra`.

## Facts

1. The registry reserves a provider name, not a desktop. It holds no "provider object, shared operation type, dispatch method, Session lock" (`.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md`, Decision ¶1). A "Session ownership broker" was rejected (same file, Alternatives). "Callers coordinate complete observe, act, and verify workflows" (`docs/subsystems/computer-use.md:35`).
2. **The MCP provider's tools are composition-global.** `inject = ['computerUse','tools']` and there is no `agentPreset` option (`packages/experimental/computer-use-cua-driver-mcp/src/index.ts:17,20-29`). One stdio child serves every Agent on that host (`:52-70`).
   - Config is limited to `command`, `args`, `toolCallTimeoutMs` and `reconnect`. There is no env and no cwd (`:20-29`). Args are "passed directly without a shell" (README:45).
3. **Kill interacts with reconnect.** "Later disconnects retain the registration while the MCP client reconnects or exhausts its attempt budget; unload the entry to release it" (`computer-use-cua-driver-mcp/README.md:53`). If Orchestra kills the child while reconnect is on, the MCP client respawns it (inferred).
4. **The native provider is coupled to the host process.** "Native crashes can terminate that process" (`computer-use-cua-driver-native/README.md:43`). A failed native shutdown leaves "the registration … occupied. Restart the host" (`:133`). Its guidance says "A refusal does not authorize a foreground retry" (`:96`).
5. **This contradicts the upstream Windows skill, which matters for the MCP provider.** The upstream skill tells the model to retry a refused action with `delivery_mode:"foreground"` (`WINDOWS.md:64-67,100-103`). The refusal payload itself suggests "Retry this action with delivery_mode:\"foreground\"" (`WINDOWS.md:87`). The MCP provider adds no DSH guidance, only upstream tool text (`computer-use-cua-driver-mcp/README.md:55`). So DSH's anti-escalation rule exists only on the native path.
6. **Windows runtime placement.** "Bare `cua-driver mcp` owns its runtime directly on Windows" (`WINDOWS.md:509-511`). That makes the actuator a child that a Job Object can contain (inferred).
   - The runtime must run in Session 1 or later; Session 0 is refused (`:471-480`).
   - Normal use needs no admin rights (`:493-494`). The binary is unsigned and triggers SmartScreen (`:497-499`).
   - The autostart Scheduled Task `cua-driver-serve` creates a persistent daemon outside any Job (`:509-523`).
   - On macOS, plain `cua-driver mcp` "may proxy through this daemon automatically" (`cua-readme.md:165`), so the actuator can sit outside DSH's child tree.
7. A standalone Windows build exists: release `cua-driver-rs-v0.28.0` (2026-09-11) has `cua-driver-rs-0.28.0-windows-x86_64-binary.zip` (29.0 MB) and `checksums.txt` (`gh api repos/trycua/cua/releases/tags/cua-driver-rs-v0.28.0`).
8. **Upstream permission modes.** `standard` is "the promptless default" and `bounded` admits only manifest-listed tools. The mode is set at launch, for `mcp` through `CUA_DRIVER_PERMISSION_MODE` and the manifest variables (`cua-readme.md:43-52`). `--grant existing-profile` attaches a logged-in Chromium profile (`:57`). Cua Driver "does not render its own authorization modal" (`:62`).
9. **Snapshot-bound targets on Windows.** "The server replaces the element index map on every snapshot". Stale targets fail with `stale_element_token` or `snapshot_id_required` (`WINDOWS.md:553-562`).
   - DSH-D#7788 is still open (`closed:false`): `structuredContent` (where `element_token` arrives) does not reach the model. A 2026-09-26 comment places the loss downstream of the bridge (`gh api graphql`). Whether rc.2 models see `element_token` is not verified.
10. **cua-macos consent goes through User Questions and is code-enforced.** The source of truth is `packages/experimental/cua/src/application-access.ts`:
    - No `userQuestions` service gives `APP_APPROVAL_UNAVAILABLE` (`:143-144`).
    - Cancel counts as a denial (`:159-161`). A delegated caller (subagent) gives `APP_APPROVAL_UNAVAILABLE` (`:163-164`).
    - Only an exact offered label grants access; free text never does (`:169-171`).
    - "Always allow" is offered only when the identity is persistable and saving is on (`:146,172`).
    - Saved grants (`allowedApps`) are profile-wide and checked before any per-session decision (`:137,262`).
    - Session decisions are keyed by `agent.id` (`:138,267`). The decision record says "Session ID" (`2026-09-26-cua-application-consent.md:21`). This is not a contradiction of the brief, which said session+application.
11. **ACP gives consent no answerer.** The ACP server "intentionally exposes only the standard ACP v1 surface" with no elicitation (rc.2 `dsh-acp/README.md:32,175`). `grep -rli question packages/acp/acp` finds nothing, and its only interaction hook is `approval/request` (`packages/acp/acp/src/index.ts:158`).
    - Inferred: under `dsh --profile acp`, a cua-macos consent prompt fails (`NO_PROVIDER` or `APP_APPROVAL_UNAVAILABLE`) unless a bundle registers an in-process `user-questions/request` answerer. DSH documents that seam (`docs/upgrade-guide/v0.2.1-rc.2/sdk-desktop-context/guide.md:16`).
12. **The cua-macos helper is shared per user across Hosts, with no cross-call ownership.** "Agents and Hosts belonging to one user share a helper for the same native build … desktop operations use a global queue" (`cua-macos/README.md:123`).
    - "A may retain its app object while B screenshots and changes the same application" (`2026-10-09-cua-shared-native-helper.md:25`).
    - Cross-call reservation was rejected (`2026-10-13-cua-continuous-hover.md:19`).
    - A screenshot that times out keeps the single capture slot, and new captures get `CAPTURE_BUSY` (`2026-10-09…:17`).
13. **cua-macos runs only in the PTC preset.** `agentPreset` defaults to `ptc` (`cua/README.md:68`; `cua-bundle/cordis.patch.yml:4-8`). "Persistent PTC and separately authorized shell tools are not an operating-system sandbox" (`cua-macos/README.md:70`).
14. **Result contract.** `ActionResult = {dispatched: true, verified: false}` (`cua/src/protocol.ts:130`).
    - `SESSION_LOCKED` means stop and ask the user (`cua-macos/README.md:158`).
    - Indices are valid only with their `snapshotId`. `STALE_APP` and `STALE_SNAPSHOT` require a re-read, and a resize gives `WINDOW_CHANGED` (`cua/README.md:40`; `cua-macos/README.md:195`).
    - `maxClickHoldMs` defaults to 5000 and `timeoutMs` to 30000 (`cua-macos/README.md:51,60`).
15. Revocation closes every Agent connection that holds the application. "Reauthorization uses a fresh connection, so old … snapshots cannot become valid again" (`2026-09-26-cua-application-consent.md:25`). Session decisions have no eviction (`cua/README.md:111`).
16. Images: screenshots need an attachment store plus an image-capable route (`cua/README.md:36`; `docs/subsystems/computer-use.md:39`). Inline bytes stay outside Session events (`computer-use-cua-driver-mcp/README.md:101`).
17. **Browser side.** A launched browser belongs to "the exact live Agent and Session"; reload or fork starts fresh state, and profiles are not restored (`docs/subsystems/browser-use.md:21`).
    - Attach mode reserves one external browser per Session within that provider instance. "Separate DSH processes … remain outside this reservation" (`:23`).
    - Playwright-mcp attach needs an HTTP or WS debugging `endpoint` (`browser-use-playwright-mcp/README.md:38,45`).
18. **Versions.**
    - The provider's npm `latest` is `0.1.6-alpha.1`. A plain install would get a stale build (D#6788 reports that 0.1.6-alpha.1 broke profile boot).
    - `0.2.1-rc.2` exists with exact-pinned `dsh-computer-use` and `dsh-mcp-client` at rc.2 (`npm view …@0.2.1-rc.2 peerDependencies dependencies`), matching the installed DSH.
    - `dsh-cua`, `dsh-experimental-cua-macos` and `dsh-computer-use` all have rc.1–rc.4.
    - `dsh-experimental-cua-bundle` returns 404 on npm.
19. Windows status: "Windows support is planned as a separate provider package with a C# helper" (`cua/README.md:112`; also `cua-bundle/README.md:12`). On Windows today, the only working DSH CU is the two cua-driver providers.

## Patterns for Orchestra

### (1) Concept → DSH mechanism → gap

| Orchestra | DSH mechanism | Gap / conflict |
|---|---|---|
| Tier 0 per-Musician browser | Launched browser owned by the live Agent and Session (F17) | Ownership dies on Part rotation, which conflicts with A23 (a grant profile must survive rotation). Attach mode needs a CDP port, while Tier 0 uses `--remote-debugging-pipe`, so any same-user process could reach the port. Use DSH launch mode for anonymous look-ups only. Grant browsers stay Orchestra-launched; attach only behind a loopback guard (not verified). |
| Grant | cua-macos per-app consent; `allowedApps` saved profile-wide (F10) | Windows providers have no consent at all (F2, F8). `allowedApps` would leak to every later Part and every Musician on the host. Orchestra homes keep `allowedApps: []` and `save` off. |
| Lease | "callers coordinate"; FIFO with no cross-call ownership (F1, F12) | DSH declined exactly the thing Lease supplies. No conflict, but Orchestra is the only coordinator, including against your own `dsh web` CU (F12: shared helper). |
| E3 classes and two-phase approval | No per-action gate. Consent is per app, not per action. `standard` mode is promptless (F8). | The MCP path can be gated by an `orchestra-desktop` proxy in front of stdio. cua-macos runs inside PTC `run_code`, so a two-phase "pending" would break scripts: lease-level `act` only (inferred). |
| E5 UI freeze | Consent cards render in DSH web/Desktop (`docs/subsystems/user-questions.md:25`) | A desktop holder could click its own DSH consent card or the DSH permission page. Extend E5 and the app denylist to DSH web/Desktop windows. |
| E6 taint | The tool log holds AX text and screenshots | Compatible. Taint on any `mcp__cua-driver-mcp__*`, `cua_driver_native__*` or `cua` call. |
| E7/E8/E9 images | Durable attachment store; bytes outside events (F16) | On the MCP path the proxy can redact before DSH stores anything. cua-macos has no interception point, so E8 cannot hold there. Purging DSH attachments at Part disposal is not verified. |
| E11 caps | `maxClickHoldMs`, `timeoutMs`, `screenshotTimeoutMs` (F14) | No per-Part image or step cap: the proxy enforces it (MCP), or a bundle `tools/pre-execute` hook does (cua-macos, assumption). |
| E14 kill | MCP registration retained across reconnects (F3). Native crash kills the host and a failed shutdown sticks (F4). macOS `mcp` may proxy to an external daemon (F6). | Set `reconnect.enabled:false`. Use a per-lease scout host so a stuck registration dies with the host. Never use the native provider. On macOS, forbid the CuaDriver.app daemon. |
| E15 no sharing | One provider per composition; MCP tools global to every Agent (F2). The macOS helper is shared across Hosts (F12). | The scout host must hold exactly one session: `hostKey` = project + scout preset + `lease:<id>`. |
| D8 human-only approvals | Consent via User Questions; ACP has no answerer (F11). DSH `approval/request` → ACP `session/request_permission`. | The Orchestra bundle registers a `user-questions/request` answerer that only enqueues an InboxItem. The answer comes from the paired UI only. Clones get `APP_APPROVAL_UNAVAILABLE` (F10), which matches E15. |
| D5 presets | cua-macos requires preset `ptc` (F13) | PTC is code execution, which conflicts with E6 "scouts: no shell". So macOS scouts are look-only, or need a PTC-only preset with no file or shell tools (not verified). |
| R43 scouts only | Composition-scoped mounting | Fits: CU is mounted only in scout hosts. |
| R45 element-bound approvals | `snapshotId` + index; `element_token`/`snapshot_id`; `STALE_SNAPSHOT` (F9, F14) | Bind the approval digest to (window id, snapshot id, token or index, crop). A new snapshot voids pending approvals. Because of D#7788 the model may only have coordinates, so the approval binds to a coordinate + crop. |

### (2) cordis.patch.yml fragments

**Windows scout host**. One host per Tier 2 lease, with a private `DSH_HOME`, pinned DSH and provider at `0.2.1-rc.2`. Use cua-driver-mcp, not the native provider: native loads the Rust driver into the DSH host, so a driver crash kills the scout's session and a failed shutdown leaves the slot stuck (F4). MCP keeps the actuator in a child process that procguard can Job-contain and kill, and Orchestra can put its proxy on the stdio boundary.

```yaml
# <DSH_HOME scout:lease-<id>>/cordis.patch.yml
- insert:
    - id: cu-registry
      name: '@deepseek-ai/dsh-computer-use'
    - id: cu-provider
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      config:
        command: 'C:\Users\Calx\.orchestra\bin\procguard.exe'
        args: ['run-in-job', '--job', 'lease:<leaseId>', '--',
               'C:\Users\Calx\.orchestra\node24\node.exe',
               'C:\Users\Calx\.orchestra\lib\orchestra-desktop.mjs',
               '--lease', '<leaseId>',
               '--upstream', 'C:\Users\Calx\.orchestra\vendor\cua-driver-rs-0.28.0\cua-driver.exe',
               '--upstream-args', 'mcp',
               '--mode', 'bounded', '--manifest', 'C:\Users\Calx\.orchestra\cua\scout-manifest.json']
        toolCallTimeoutMs: 15000
        reconnect: { enabled: false }   # schema accepts enabled alone: not verified
    - id: orchestra
      name: 'orchestra-dsh-bundle'      # user-questions/request answerer -> InboxItem; tools/pre-execute meter
```

What the proxy does:
- Sets `CUA_DRIVER_PERMISSION_MODE=bounded` and the manifest on the upstream process (F8).
- Strips `delivery_mode:"foreground"`, `bring_to_front`, `launch_app` outside the allowlist, recording and `--grant` (F5, F8).
- Returns `approval-pending` for write-class calls.
- Checks every target pid/HWND against the Lease's app allowlist plus the always-deny list (terminals, Settings, UAC, password managers, the Orchestra UI browser, DSH web/Desktop).

Hard rules:
- Never run `install.ps1`/`autostart`. Pin the zip by `checksums.txt` (F6, F7).
- The host starts on grant and closes on release. If teardown stalls, `kill-job lease:<id>` and then kill the host Job.

**macOS host** (not this machine):

```yaml
- insert:
    - id: cu-registry
      name: '@deepseek-ai/dsh-computer-use'
    - id: cua
      name: '@deepseek-ai/dsh-experimental-cua-macos'
      disabled: !!js process.platform !== 'darwin'
      config:
        agentPreset: ptc
        allowedApps: []          # never saved grants in Orchestra homes
        helperPath: '/Users/<u>/.orchestra/cua/dsh-cua-native-<digest>'  # pinned; distinct build from your dsh web
        timeoutMs: 15000
        maxClickHoldMs: 1000
    - id: ui-cua
      name: '@deepseek-ai/dsh-cua'
    - id: orchestra
      name: 'orchestra-dsh-bundle'
```

The helper is a user-wide shared service (F12), so the per-lease Job cannot own it. Kill goes through in-process `ctx.cuaAccess.revoke()` from the bundle, then host close. A distinct `helperPath` build gives a separate helper (F12, inferred), at the cost of a second capture client.

### (3) Errata for `computer-use.md`

1. **`:18`** "Claude and Codex ship it only in desktop apps…". Append: "DSH is the exception: official, opt-in experimental CU packages (`dsh-computer-use` + cua-driver MCP/native providers, all platforms; `cua-macos`, macOS-only) mount in an owned private-home host; none are installed in rc.2."
2. **`:29`** DSH "Native eyes today". Replace with: "`web_fetch`; unbundled opt-in packages: browser-use (playwright/chrome-devtools/stagehand) and computer-use (registry + `cua-driver-mcp` / `cua-driver-native`; DSH's `cua-macos` PTC-only with per-app consent). Windows CU = cua-driver providers only."
3. **`:30`** Replace with: "None installed. Mountable in a private home: browser providers, cua-driver-mcp (preferred; Job-containable on Windows), cua-driver-native (in host process, rejected), cua-macos (PTC preset, consent needs a User-Questions answerer that ACP lacks)."
4. **`:33`** DSH click approval. Replace with: "No per-action gate. cua-macos adds per-application consent (session or saved, fail-closed without answerer); cua-driver providers add none; upstream `standard` mode is promptless, `bounded` restricts tools by manifest."
5. **`:49`** Tier 2 "**No driver yet**". Replace with: "Candidate driver exists: cua-driver-rs 0.28.0 (MIT) via DSH's MCP provider behind `orchestra-desktop`; background-first (UIA/PostMessage), `background_unavailable` refusals; not validated on this machine." In the "Cannot do" column add: "foreground delivery (stripped by proxy)".
6. **`:75`** Replace "Ships only if an M4 spike picks one. Candidate: pinned Windows-MCP…" with: "Primary: cua-driver-rs 0.28.0 `mcp` (bounded manifest, background only, per-lease Job, reconnect off). Fallback: Windows-MCP without PowerShell/Registry/process tools. Same proxy and allowlist either way."
7. **`:76`** Add to the detected native CU list: `cua-driver.exe` outside our Jobs, Scheduled Task `cua-driver-serve`, `\\.\pipe\cua-driver`, the macOS `dsh-cua-native` helper, and observed DSH sessions calling `mcp__cua-driver-mcp__*`, `cua_driver_native__*` or `cua`.
8. **`:113`** Replace "DSH's exclusive provider slot as a multi-Musician design (… `browser-use.md:17-23` …)" with: "DSH's provider registries (browser and computer use) as a lease: they reserve a provider name per composition, not a desktop or browser per workflow (`computer-use.md:29,35`); kept only as a composition guard." Also qualify "vendor CU in owned Musicians" to read "Claude/Codex vendor CU". Qualify "'background' SendInput" to read "SendInput-based background; UIA/PostMessage background (cua-driver) is allowed".
9. **`:140`** Add: "cua-driver (trycua, MIT) pinned binary; DSH CU packages MIT; never `install.ps1`/autostart."
10. **`:141`** Replace "M4: … Tier 2 after a driver spike (+2 weeks)" with: "M2 end: S-CU spike (+2–3 d) — cua-driver 0.28.0 under procguard in Session 1, kill-job reaps it, background click into Notepad without focus change, `bounded` manifest. M3: Tier 2 *look* for DSH scouts. M4: Tier 2 *act* (two-phase) after R05–R07 pass."
11. **`:159`** test 14. Add `mcp__cua-driver-mcp__*`, `cua_driver_native__*`, `cua` in observed DSH logs.
12. **`:174` Q-C1 / `:175` Q-C5**. Replace "(Tier 2 after an M4 spike, +2 weeks…)" with "(Tier 2 for DSH scouts from M3 look / M4 act, gated by the S-CU spike)".
13. **`:179` Q-C7**. Replace with: "DSH scouts are the only owned Musicians that can mount desktop CU: allow DSH desktop scouts, or keep DSH read-only and route look-ups to Claude Tier 0?"
14. **`:180` Q-C8**. Replace with: "Any DSH CU needs an image-capable route plus attachment store; switching scouts to `deepseek-flash` is a prerequisite, not an option."
15. **`:7`** Add: "'DSH has no CU stack' (this file, pre-revision) is superseded by the `orchestra-fit` and `dcu-*` reports."

### (4) Patterns A31+ (with zero-token CI tests)

- **A31 Dispatched is not verified** (F14). Every CU write is `outcome: dispatched`, and the Exchange stays `working` until a fresh observation. *Test:* a fake click returns `dispatched` and no `replied` is emitted until an observe call.
- **A32 Snapshot-scoped targets void approvals** (F9, F14). *Test:* approve on snapshot S1, re-snapshot to S2, execute: refused `stale-approval`.
- **A33 `SESSION_LOCKED` / Session 0 sets the lease to `suspended`, never auto-resumed** (F6, F14). *Test:* a fake `SESSION_LOCKED` gives `suspended` + P1, and later calls are refused.
- **A34 Background-only; a refusal never authorizes foreground** (F4, F5). *Test:* `delivery_mode:"foreground"` and `bring_to_front` are refused by the proxy; a `background_unavailable` result is shown to the model without the `suggestion` field.
- **A35 Per-window capture and fail-fast capture** (F12). Capture only allowlisted HWNDs; a capture timeout gives `CAPTURE_BUSY` and the Part pauses. *Test:* a screenshot of a non-allowlisted window is refused; a second capture during a hung one fails at once.
- **A36 App identity = executable path + signer** (F10; on Windows, Authenticode as the analog, inferred). Unsigned apps are bound to a pid + createTime. *Test:* a copied exe at a new path does not match the grant.
- **A37 Session-only grants in Orchestra hosts** (F10). `allowedApps: []`; "Always allow" is never offered. *Test:* the composed config has no `allowedApps` entries and `save` is off.
- **A38 Consent before launch** (`2026-09-26…:19`). *Test:* a denied app is never started.
- **A39 Revoke invalidates the whole connection; no revival** (F15). *Test:* after revoke, old handles fail and new grants use a fresh connection.
- **A40 Orchestra supplies the cross-call ownership DSH declined** (F1, F12). *Test:* two scouts asking for the desktop get one `active` and one `queued`.

### (5) Risks of combining Lease with DSH consent

- **Double prompts.** You would see the Lease grant, then cua-macos app consent, then DSH tool approval for `run_code`. Fold them: the Lease card names the apps, and the bundle's answerer answers *session* consent only for apps already in the human-granted Lease (assumption). This is human-derived and journaled, never agent-derived.
- **A Musician answering its own User Question.** Text answers cannot do it (F10: exact label only, and ACP has no elicitation). Clicking can: a desktop holder could click DSH's consent card or "Always allow" on the DSH permission page. Mitigation: E5 plus a denylist covering DSH web/Desktop, and no saving.
- **Consent cached across Parts.** Decisions live in memory until DSH restarts and survive agent replacement (F10, F15). Saved grants are profile-wide. With a per-lease host and `allowedApps: []`, nothing outlives the lease.
- **Revoke racing a Lease.** Delivered input cannot be undone. On the MCP path a kill without `reconnect:false` respawns the driver (F3). Order: proxy stops admission → drain (≤2 s, key/button-up) → `revoke` (cua-macos) or `kill-job` → host close; in-flight writes become `unknown-outcome`.
- **Your own DSH CU colliding with a lease.** On macOS your `dsh web` shares the helper FIFO (F12). On Windows a user-installed `cua-driver-serve` acts outside Orchestra. Detect both (erratum 7) and suspend the lease.

## Verdict

Yes, conditionally. DSH is the only harness whose *owned* session can mount desktop CU today (F2, F18), and on Windows the cua-driver-mcp path can be Job-contained and proxied (F6, F7). That moves DSH-scout Tier 2 from "after an M4 spike (+2 weeks)" to a 2–3-day spike at the end of M2, *look* in M3 and *act* in M4.

Conditions:
- Lease, Governor and the approval queue exist first (M2).
- A per-lease single-session scout host on an image-capable route.
- `bounded` mode, background only, `reconnect:false`, a pinned binary and no autostart.
- A bundle-provided User-Questions answerer that routes to the UI.
- E5 extended to DSH UIs.

cua-macos does not help on this Windows machine, and its PTC requirement conflicts with scouts having no shell. Claude and Codex Musicians stay without desktop CU.

## Open questions

- Does the `reconnect` schema accept `{enabled:false}` alone, and does the registration release when reconnect is disabled and the child dies (F3)? (not verified)
- Is D#7788 fixed in rc.2–rc.4, so that the model sees `element_token`? (not verified)
- Does cua-driver 0.28.0 `mcp` on Windows run inside a `KILL_ON_JOB_CLOSE` Job without UI limits, and does kill-job reap it? Needs the S-CU spike.
- What is the format of the `bounded` manifest, and can it deny `delivery_mode:"foreground"` per tool, or only whole tools (`cua-readme.md:43-52`)? (not verified)
- Can a private-home bundle register a `user-questions/request` answerer under `--profile acp` (F11)? (inferred, not tested)
- How are DSH attachments purged at Part disposal (E9)? (not verified)
- Does the cua-driver `background` path deliver text into the apps you care about? Electron typing is `background_unavailable` per the ledger already verified by the orchestrator.

## Sources

- Clone `deepseek-ai/deepseek-harness@22ddee37`:
  - `packages/computer-use/computer-use/README.md`; `docs/subsystems/{computer-use,browser-use,user-questions,approval}.md`
  - `packages/experimental/{computer-use-cua-driver-mcp/README.md,src/index.ts}`; `computer-use-cua-driver-native/README.md`
  - `cua/README.md`; `cua/src/{application-access.ts,protocol.ts}`; `cua-macos/README.md`; `cua-bundle/{README.md,cordis.patch.yml}`
  - `browser-use-runtime/README.md`; `browser-use-playwright-mcp/README.md`; `packages/acp/acp/src/index.ts`
  - `.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md`, `2026-09-17-experimental-cua-object-api.md`, `2026-09-26-cua-application-consent.md`, `2026-10-09-cua-shared-native-helper.md`, `2026-10-13-cua-continuous-hover.md`, `2026-10-13-cua-hover-routes-and-coordinates.md`
  - `docs/upgrade-guide/v0.2.1-rc.2/sdk-desktop-context/guide.md`
- Local rc.2: `C:/Users/Calx/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-acp/README.md`.
- Upstream: `gh api repos/trycua/cua/contents/libs/cua-driver/README.md?ref=cua-driver-rs-v0.28.0`, `…/rust/Skills/cua-driver/WINDOWS.md?ref=cua-driver-rs-v0.28.0`, `repos/trycua/cua/releases/tags/cua-driver-rs-v0.28.0`; GraphQL for DSH-D#7788.
- npm: `npm view @deepseek-ai/dsh-experimental-computer-use-cua-driver-{mcp,native} dist-tags|versions`, `…@0.2.1-rc.2 peerDependencies dependencies`, `@deepseek-ai/{dsh-cua,dsh-experimental-cua-macos,dsh-computer-use} versions`, `dsh-experimental-cua-bundle` (404).
- Orchestra: `G:/_Projects/dsh-orchestra/docs/specs/2026-10-26-dsh-orchestra-design.md` (§4, §6, §8.1, §8.6, §10, §13); `docs/research/computer-use.md`; `docs/research/bot-architectures.md`.
