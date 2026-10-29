# DSH computer use: the socket, not the instrument

2026-10-26. Extends [computer-use.md](computer-use.md) after 「另外检查到dsh-computer-use，尝试调研」; its errata were applied there on 2026-10-26, spec amendments stay proposals. `DSH/` = clone `deepseek-harness@22ddee3`; `DP/` = installed rc.2 `@deepseek-ai`; `CUA/` = `trycua/cua` `libs/cua-driver/` @ v0.37.0. **[cn] = consent-lib**; `D#n` = `DSH-D#n`; `cua#n` = trycua/cua.

## Position

1. `dsh-computer-use` is a 30-line registry reserving one provider name per Cordis service instance: no tools, lock, lease or approval (`DSH/packages/computer-use/computer-use/src/index.ts:16-46`) [rp].
2. Experimental providers carry it: `cua-driver-mcp` spawns upstream `cua-driver mcp`, `cua-driver-native` loads SDK 0.28.0 in-process, macOS `dsh-cua` + `cua-macos` add per-app consent [rp][cn][mn].
3. None is in rc.2; their npm `latest` (0.1.6-alpha.1) breaks boot (D#6788) [cv].
4. **Answer:** yes, a DSH scout gets desktop eyes and narrow hands via upstream Cua Driver, but DSH is only the socket: coordination is left to callers (`DSH/docs/subsystems/computer-use.md:35`), tools are host-global and inherited by subagents, and nothing in the scout composition asks first. Orchestra supplies Lease, approvals, isolation and kill.
5. **Changes:** Tier 2 gets a candidate driver (`cua-driver`, MIT, window-addressed, exact refusals) behind `orchestra-desktop`, an MCP server any owned harness mounts; the host is Q-DC0; an S-CU spike (driver only) runs at M2 end.
6. Windows "background" is compensated: unpostable clicks become screen-point pen taps, element-addressed or not, and Electron/Chromium typing is refused, so Tier 2 is look-first; `act` waits for S-CU's write measurements (inferred) [uw].
7. **Unchanged:** D8, the Post Office as the only bus, D18, Tier 0, the Lease state machine (plus an absence trigger), E5 (unless Q-DC1 or Q-DC7 says otherwise), no vendor CU in owned Claude/Codex.

## Package map

`npm view`, 2026-10-26 (L latest). Each published DSH row also has `alpha` 0.2.1-alpha.5, `next` 0.2.1-rc.4 and exact `0.2.1-rc.2`.

| Package (`@deepseek-ai/`) | Role | Platform | L | In rc.2 |
|---|---|---|---|---|
| `dsh-computer-use` | name registry | any | 0.1.6-alpha.1 | No |
| `…-computer-use-cua-driver-mcp` | spawns `cua-driver mcp` | any (no OS gate) | 0.1.6-alpha.1 | No |
| `…-computer-use-cua-driver-native` | in-process SDK 0.28.0 | win32/darwin/linux | 0.1.6-alpha.1 | No (out of the install closure since 0.1.7-rc.2, `a3480857` [cv]) |
| `dsh-cua` | object API, consent, images | neutral | 0.2.1-alpha.3 | No |
| `dsh-experimental-cua-macos` | provider + Swift helper | macOS 14+ | 0.2.1-alpha.3 | No |
| `dsh-cua-bundle` | registry + cua-macos + dsh-cua | macOS | E404 | No |
| `dsh-mcp-client` | MCP client, result adapter | any | 0.0.1-rc.1 | Yes |
| `@trycua/cua-driver` | upstream SDK (exe only in zips) | win32/darwin/linux | 0.37.0 | No |

Sources under `DSH/packages/{computer-use,experimental,mcp}`. Providers depend (not peer) on `dsh-mcp-client` [rp].

## How DSH does it

**Registration slot.** `register()` throws while any name is held (`computer-use/src/index.ts:35-45`); DSH rejected a "Session ownership broker" (`.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md:29`) [rp].

**Process models.** *MCP:* a stdio client in the provider ctx; config `command`, `args`, `toolCallTimeoutMs`, `reconnect`, no env (`computer-use-cua-driver-mcp/src/index.ts:20-42,52-70`); no Session serialization (README:114). *Native:* in-process; a crash kills the host (README:43) [of]. *Swift helper:* global FIFO, `{dispatched:true, verified:false}` (`cua/src/protocol.ts:130`) [mn].

**Consent** (macOS; `cua/src/application-access.ts:134-183,272-277`) [cn]: per-app ask; session grants in memory, "Always allow" writes profile-wide `allowedApps`, denials sticky per Session, revoke aborts in-flight work; identity SHA-256(path + designated requirement) (`ApplicationAuthorization.swift:14-24`). ACP bridges only `approval/request`, no User Questions or elicitation (`acp/acp/src/index.ts:158-176`; `acp/README.md:82,177`), so an ACP scout fails closed unless `allowedApps` lists the app; `cua` tools mount only for the `agentPreset` (default `ptc`, `cua/src/index.ts:349-376`).

**Image path.** Screenshots need an attachment store and an image-declaring route (`mcp-client/src/tools.ts:352-379`): dsh-base mounts `attachment-local` (`DP/dsh-base/cordis.patch.yml:146-147`) and `deepseek-flash` declares images (`DP/dsh-llm-deepseek/lib/index.js:42-48`), but the ACP row's `deepseek-v4-flash` is uncatalogued. The model sees `content` (`tools.ts:261-263,307-311`), never `structuredContent` (`effect`, `delivery.mode`, `element_token`; D#7788, open) [rp][cv].

**Approval.** `tools/pre-execute` defaults to allow (`core/tools/src/pipeline.ts:198-205`). Of its five listeners only auto-review (an LLM, `auto-review/src/index.ts:706`) and hooks-claude-code (PreToolUse, `hooks-claude-code/src/index.ts:243-249`) return `ask`; neither is in dsh-base or the acp profile, so scout desktop tools run unprompted. A PreToolUse hook would reach ACP `session/request_permission` with only a `toolCallId`, no arguments (`acp/src/index.ts:158-174`).

**Leftovers.** browser-use-runtime gives each Agent its own MCP client and keeps the hold on failed close (`browser-use-runtime/src/mcp.ts:102-219`; `index.ts:60-197`), but the hold is unqueued (DSH-D#7007, #7169, #9688). Computer use leaves to callers: cross-Session coordination, app reservation, rollback, permission UI, redaction, kill switch, attachment GC (`DSH/docs/subsystems/attachment.md:176`) [cn].

**Where the reports disagree.** The native SDK works on Windows 11 (D#6780, D#8927), but the `cua-driver mcp` exe is unverified here and DSH's Windows helper has no public code [mn]. The MCP provider pins no binary (`src/index.ts:33-34`); only ≥0.32.0 ships sigstore (`install.ps1:177-181`; 0.28.0 has `checksums.txt`). 0.38.0 scoped element tokens to one process (cua#5910), fatal only for one-shot `call`.

## Windows reality

**Ledger** (`CUA/docs/action-support.md:21,32-33,54-60`; Windows rows unchanged 0.28.0→0.37.0, but from one run, `29257963004` at `64e82449`, 2026-07-13): 122 rows, 99 delivered, 23 exact refusals. Electron delivers only left clicks and child-window actions in background (right/double click, drag → `background_occluded`); Tauri broad; WPF, WinUI3, WebView2 partial. Chromium counts posted pointer, keyboard and text as dropped (`input/delivery.rs:101-112`): typing, keys and scroll are refused, clicks rerouted, never UIA-invoked [uw].

**Focus and injection.** Element clicks try UIA Invoke/Toggle/Select/Expand first (inside `EnableWindow(FALSE)` only for XAML and Chromium hosts, `fg_bypass.rs:22-30,58-75`); if those fail, targets that drop posted clicks (WPF, Tk, GTK; `input/delivery.rs:101-155`) get a synthetic pen tap, others PostMessage (`tools/impl_.rs:4069-4086`). In background, Chromium skips UIA: single left clicks are posted, others are pen (`impl_.rs:3916-3973,4270-4311`), as are GTK double clicks (`:7020-7042`). The tap is routed by screen point after an occlusion check, under `WS_EX_NOACTIVATE`, then your foreground is re-asserted (`inject.rs:116-131,176-220,291-367`). `launch_app` (UWP restore), `invoke_menu`, `bring_to_front` and foreground key/mouse paths inject `keybd_event(VK_NONAME)` (`inject.rs:138-146`; `launch_uwp.rs:141-173`; `keyboard.rs:613`; `mouse.rs:579`); foreground delivery and desktop-scope scroll use SendInput (`keyboard.rs:476,572`; `mouse.rs:639`; `impl_.rs:6355-6392`). Window state is restored only in Rust `Drop`, so a mid-call kill can leave the target disabled; open: cua#3355, cua#1706 [uw].

**Gates.** `standard` is promptless (`cua-driver-core/src/tool.rs:2495-2506,2659-2666,2763-2766`) unless a capability manifest is configured, which then denies undeclared tools and limits desktop input and observation to listed windows or apps, never checking delivery mode (`tool.rs:2667-2693`; `authorization.rs:269-288,1156-1176`; `session_manifest.rs:293-312`). `bounded` needs a manifest yet lifts the existing-browser-profile and Computer History adapters to allowed (`authorization.rs:170-189,393-460`): looser than `standard`. A manifest needs `…_FILE` and `…_APPROVED=1` (`authorization.rs:1314-1319`). Telemetry (`telemetry.rs:1-26`) and `run_script` default on; no lock gate on input (its lock classifier only explains a failed capture, `diagnostics.rs:180-224,262-266`; `capture.rs:774-778`) [uw].

**Process.** Only `cua-driver mcp --direct` always owns its runtime; bare `mcp` proxies to (or launches) the detached `serve` daemon on `\\.\pipe\cua-driver` once a Computer History admission preference exists (`main.rs:436-452`; `history_runtime.rs:73-98`; `cli.rs:1601-1641,1849-1932`); `serve` accepts any same-user process, and extensions load from `CUA_DRIVER_RS_HOME` (`extension_manager.rs:1052`). `install.ps1` defaults `$AutoStart = $true` (its help at `:61-67` says "Default off") with a RunLevel=Highest task (`scripts/install.ps1:94-100,677-684`) and breaks on zh-CN (cua#2106), this machine's locale. UWP top-level windows belong to the shared `ApplicationFrameHost.exe` (`impl_.rs:2847-2856`) [uw].

**Maturity.** All prerelease, 14 releases in three weeks, five Windows P0s open including cua#3330 (bounded identity cannot match Windows app grants; unconfirmed at 0.37.0) [uw]. The installer requires a `Cua AI, Inc.` Authenticode signature from 0.22.0 (`install.ps1:69-73,1335-1349`); community `dsh-computer-use-win` borrows the foreground [cv].

## Fit with the instrument model

| Orchestra | DSH mechanism | Gap |
|---|---|---|
| Lease | name slot | no holder, queue or expiry |
| Grant | macOS consent; `allowedApps` profile-wide | none on Windows |
| E5 | consent cards in DSH web/Desktop | a holder could click them |
| E6–E9 | no taint; attachments never GC'd | proxy; orchestrad sweep |
| E12 | dispatched ≠ verified | model sees only `content` text, also on `isError` (`tools.ts:261-263,296-299`); the proxy folds `effect`, `transport`, refusal `code` into it |
| E15 / Clone | subagents inherit tools; no caller id | one Musician, one Session, no subagents per host |
| D8 | ACP forwards `session/request_permission` only | consent has no ACP answerer |

**Decisions.** *Reuse:* browser-use hold semantics (queued, in the Lease), attachment store (orchestrad sweeps), `standard` + manifest (tool allowlist, exact-window ceiling). *Wrap:* ACP `session/new{mcpServers}` for `orchestra-desktop`, Agent-scoped (`acp/acp/src/mcp.ts:20-33`); its default reconnect (`mcp-client/src/connection.ts:41-46`) is harmless since authority lives in orchestrad; the registry + `cua-driver-mcp` provider only if S2 finds that mount drops images; the result adapter.

## Composition recipe

**Windows desktop host** (if Q-DC0 picks DSH): `hostKey` = musicianId; orchestrad, its only ACP peer, sends one `session/new` and never `session/resume` (`acp/acp/src/index.ts:189`); the profile disables the nine delegation rows (`DP/dsh-base/cordis.patch.yml:359-407`); private `DSH_HOME`; exact 0.2.1-rc.2 pins; a new Part restarts the host.

```yaml
# <scout DSH_HOME>/profiles/acp/cordis.patch.yml
- id: acp
  config: { provider: deepseek-official, model: deepseek-flash }   # declares image input
- { id: subagent, disabled: true }   # and the other eight delegation rows
# ACP session/new mcpServers[0], never on disk:
# { name: orchestra-desktop, command: <node.exe>, args: [<orchestra-desktop.mjs>, --part, <partId>],
#   env: [{ name: ORCHESTRA_PART_NONCE, value: <rotated per Part> }] }
```

**`orchestra-desktop`** (harness-facing MCP server):
- serves a fixed ~10-tool list with no driver running (D#7080: 55 tools ≈ 23.5k tokens; S-CU counts 0.37.0's); ignores upstream annotations;
- reaches orchestrad over a named pipe, admitted only as a descendant of the registered host (procguard `pipe-client-pid`, pid + createTime) holding the per-Part nonce (spec §8.5; S2 checks DSH never logs it); one per Lease;
- only while the Lease is `active`, spawns `procguard.exe run-in-job --job lease:<id> --env-allowlist <file> -- cua-driver.exe mcp --direct` as its stdio child (one-shot, KILL_ON_JOB_CLOSE, nested in the host Job); orchestrad records `actuator{pid, createTime, jobId}` and kills via `kill-tree`. Env from scratch, no `CUA_DRIVER_HOME` (it outranks `CUA_DRIVER_RS_HOME`, `history_runtime.rs:374-376`): `CUA_DRIVER_PERMISSION_MODE=standard`; `CUA_DRIVER_CAPABILITY_MANIFEST_FILE` = YAML orchestrad writes from your desktop Grant: `allow.tools` = the proxy's tools, `resources.desktop.windows` = exact (pid, window_id) pairs (AFH pid + frame for packaged apps), no `apps`, `applications` or `display`, `expires_after` = lease TTL, `idle_timeout` 60 s (`session_manifest.rs:525-627`; no delivery field, so the background ceiling is proxy-only); `CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED=1`; an empty per-lease `CUA_DRIVER_RS_HOME`; `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`; `DO_NOT_TRACK=1`; `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`; `CUA_DRIVER_RS_UPDATE_CHECK=false`;
- admits one element-addressed call at a time with `pid` + `window_id`; refuses x/y; admits `click` only as left, `count` 1, never on WPF, Tk or GTK windows, where failed UIA falls back to pen (`impl_.rs:4069-4084`); a `windows_targeted_injection` result → `suspended`, P1; refuses `double_click`, `right_click`, `drag`, `launch_app`, `invoke_menu`, `bring_to_front`, `set_window_frame`, desktop-scope `move_cursor`, foreground delivery, `get_desktop_state`, clipboard, `run_script`, `run_steps`, `kill_app`, `page`/`browser_*`, recording and history; never calls `list_windows`/`list_apps` (procguard enumerates), so no `display` grant, which would also allow desktop-wide input (`session_manifest.rs:221-228`);
- matches each target per call: an `ApplicationFrameHost.exe` frame by its hosted `CoreWindow` pid's AUMID (resolved as `win32/windows.rs:732-773` does), others by AUMID, else exe path + Authenticode signer, else path + SHA-256 pinned at grant (Q-DC2); plus pid + createTime; AFH is never an app identity; always denies terminals (packaged ones by AUMID), Run, Settings, UAC, password managers, the UI browser, DSH web/Desktop;
- records each target's enabled state and style; at its own deadline (below the host's MCP timeout) journals `unknown-outcome`, restarts the driver and answers `busy` until a read settles it;
- executes `act` only through the route Q-DC7 picks, else refuses writes (`no-approval-route`); a step binds (app identity, HWND, tool, every argument, `role`, `label`, parent labels, `frame` ±4 px, text digest) and runs only if exactly one fresh row matches, in plan order, once; a miss, ambiguity, `in_web_content` target or `unknown-outcome` aborts the plan (0.37.0 rows carry no RuntimeId; `label` falls back to value, `impl_.rs:1109-1163`); auto-denies repeats of a denied (Part, app, window, actionClass) with one P2 `flood`; folds result fields into text; redacts, meters, taints; `look` defaults to UIA text, images opt-in.

| Lease state | Action |
|---|---|
| queued → active | new driver process, so no old token survives |
| active → draining (≤2 s) → releasing → released | stop admission; at 2 s `kill-tree` even mid-call (write → `unknown-outcome`); restore window state |
| suspended, revoked, lost | orchestrad kills the Job; procguard restores window state; P1 on `lost` |
| proxy pipe closes or host exits | `lost`, P1 |
| always (≤500 ms) | no `cua-driver*.exe` outside the Job, no new `\\.\pipe\cua-driver*`, input desktop = Default, session unlocked (WTS notification), you present (non-synthetic Raw Input within N s, Q-C9; not GetLastInputInfo), all checked by procguard; else suspend + `kill-tree` |

**Prerequisites:** the 0.37.0 zip verified by sigstore, SHA256SUMS and Authenticode (never `install.ps1`); an orchestrad TTL sweep of `<DSH_HOME>/attachments`; a scout preset with `read-only` sandbox, `approval: ask` (`DP/dsh-base/cordis.patch.yml:259-270`; it routes only sandbox escalations), no shell (E6); human-only Inbox approvals (D8); a one-shot stdio `run-in-job` wrapper with `--env-allowlist` in S4.

**macOS:** not offered: `cua-macos` has no Lease gate or proxy, its tools are live for every PTC Agent, consent outlives leases, "Always allow" is profile-wide (E13), and PTC conflicts with E6 [of].

## Errata to computer-use.md

Applied 2026-10-26; items summarise the text in computer-use.md (see its Review log).

1. `:18` DSH exception. 2. `:29` packages. 3. `:30` pins, providers, host-global tools. 4. `:32` `structuredContent`. 5. `:33` askers. 6. `:49` Tier 2 candidate, gaps. 7. `:74` kill switch by driver. 8. `:75-76` driver, fallbacks, watches. 9. `:84` PreToolUse hook. 10. `:96` E15. 11. `:113` rejections re-sourced. 12. `:141` §13. 13. `:162` test 17. 14–18. `:174-175,179-181` Q-C1, Q-C5, Q-C7–Q-C9. 19. `:7`, `:34`, `:159` tool prefixes; Review log `:192-193`. 20. Post-fix review: `:7`, `:33`, `:49`, `:64`, `:74-75`, `:91`, `:98`, `:110`, `:113`, `:124`, `:141`, `:162`, `:175`, `:179`, Review log `:194-195`.

## Patterns adopted / rejected

| # | Pattern | Source | Lands |
|---|---|---|---|
| A31 | Dispatched ≠ verified; observe, never replay | `cua/src/protocol.ts:130` [mn] | M3 |
| A32 | A changed target element voids its approval | `WINDOWS.md:521-546` [uw] | M4 |
| A33 | Locked or absent session → driver killed | `NativePlatform.swift:91-104` [mn] | M3 |
| A34 | cua-driver: background only; a refusal never authorizes foreground (Q-DC4) | native `src/index.ts:37-41` | M3 |
| A35 | Identity = AUMID or path + signer, plus pid + createTime | `ApplicationAuthorization.swift:14-24`; `platform-windows/src/history.rs:139-147` (AFH → hosted pid) | M3 |
| A36 | Session-only grants; no `allowedApps` | `application-access.ts:137-146` [cn] | M3 |
| A37 | Revoke aborts in-flight work; fresh driver process | `DSH/.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md:25` [cn] | M3 |
| A38 | Exclusive queued hold; failed close keeps hold | `browser-use-runtime/src/index.ts:60-197` | M2 |
| A39 | Result fields folded into text; curated tool subset | D#7788, D#7080 | M3 |

**Rejected:** the registry as a lease; the native provider; `allowedApps` (E13); DSH approvals, Auto review included, as the binding gate (D8); `bounded`; bare `mcp`; `install.ps1`, `serve`, Computer History; `run_script`, `run_steps`, `launch_app`; pen clicks in v1 (x/y and element fallback); one-shot `call` (cua#5910); `cua-macos`, community bundles.

## Requirements delta

| ID | Requirement | Pri | Evidence |
|---|---|---|---|
| R52 | Driver via `mcp --direct` in a per-lease Job under the proxy; sigstore + SHA256SUMS + Authenticode; no daemon; private home, allowlisted env | P0 (Tier 2) | `main.rs:436-452`; `install.ps1:177-181` |
| R53 | The proxy is the binding desktop gate; a PreToolUse `ask` hook is optional | P0 | `pipeline.ts:198-205`; `hooks-claude-code/src/index.ts:243-249` |
| R54 | Result fields reach model and journal; `unverifiable` = unknown | P0 (act) | D#7788; cua#3355 |
| R55 | Lock or absence kills the driver (procguard checks) | P0 (Tier 2) | `diagnostics.rs:180-224`; `capture.rs:774-778` |
| R56 | Exact pins; Windows smoke matrix per bump | P1 | D#6788; cua#5910 |
| R57 | Telemetry, updates and scripting off | P1 | `telemetry.rs:217-245` |
| R58 | Detect a foreign `cua-driver` and observed DSH CU | P1 | `serve.rs:1650-1661` |
| R59 | One desktop Musician, one Session, no subagents per host | P0 (Tier 2) | `mcp-client/src/tools.ts:136-150`; `scope/README.md:12` |
| R60 | Window state repaired after any kill | P1 | `fg_bypass.rs:58-71`; `inject.rs:176-221` |

Amendments: R42 a new driver process per lease; R45 adds the desktop binding above (TTL ≤ the lease's granted duration), browser binding unchanged; R50 counts the desktop catalog.

## Spec amendments

- **§4:** D17 (instruments) adds, if Q-DC6 picks it: desktop driver = upstream Cua Driver behind `orchestra-desktop`, host per Q-DC0.
- **§6.1:** Lease gains `actuator{pid, createTime, jobId, driverVersion, manifestDigest}`; desktop `hostKey` = musicianId.
- **§8.6:** lease-requests count toward the flood quota; denials stick per (Part, instrument) until you clear them.
- **§10:** §10.4 reaper covers `cua-driver*.exe` and its pipes; §10.9 desktop `act` approval per Q-DC7; §10.12 15 s timeout, one call in flight, 5-min lease (assumption).
- **§13:** if Q-C5 = Tier 2, S-CU at M2 end (+2–3 d): the driver alone, measuring `look` and write delivery. Go if `kill-tree` reaps the driver and restores windows; `--direct` stays direct; the manifest parses, admits an allowlisted Win32 window, refuses another (cua#3330); Settings is refused while Calculator is allowed (AFH frames: hosted AUMID, frame window_id); Authenticode is Valid, `Cua AI, Inc.`; Q-DC2 delivery, Raw Input's view of pen and a DSH image round-trip are measured. M3 `look` (+1.5–2 weeks; needs S2 go and Q-C8, or a Claude host). M4 `act` (+1 week) only if enough writes deliver. ≈ 33–35.5 weeks with Tier 2 (≈ 30–32 without) plus the Arrangement (inferred).

## Acceptance tests

Zero-token, against a fake `cua-driver` MCP.

18. The scout config pins exact 0.2.1-rc.2, disables the delegation rows, has no native provider or `allowedApps`, and an image-declaring model.
19. Without an active Lease every desktop tool returns `no-lease`; no driver runs.
20. Everything the proxy refuses above (foreground, x/y, non-single-left or WPF/Tk/GTK clicks, `launch_app` incl. `urls`, the other listed tools) is refused before dispatch; a `windows_targeted_injection` result → `suspended`, P1.
21. `effect: unverifiable` and refusal `code`s only in `structuredContent` reach the model's text, also on `isError`; the Exchange records `unknown-outcome`.
22. Approve element E: changed label or frame → `stale-approval`; a same-label sibling moved into E's frame → `ambiguous-target`, 0 executions; changed arguments or out-of-order steps → refused; an unrelated repaint is harmless.
23. A fake lock mid-call → 0 drivers, 0 further calls, nothing replayed.
24. `kill-tree` mid-Invoke leaves 0 drivers and the target enabled; the host survives; in-flight writes → `unknown-outcome`; killing the proxy or host → 0 drivers, `lost`.
25. Two desktop scouts: separate hosts, one `active`, one `queued`; one `session/new`, no `session/resume`; no `subagent`, `subagent_fork` or `workflow` tools; an `orchestra-desktop` outside the host or with a wrong nonce gets `no-lease`.
26. A copied exe, a reused pid, Windows Terminal (by AUMID), or Settings while Calculator is allowed is refused; the manifest parses under 0.37.0 with no `display`.
27. The driver's argv, env and manifest match the recipe exactly.
28. A `serve` task or pipe blocks grants, P1; with a fake daemon on the pipe, the driver runs direct and the daemon gets 0 calls.
29. Desktop plans are approved only from the paired UI, never while a lease is `active`; an off-plan step repeated 10 times yields 0 executions and 1 P2 `flood`.
30. A write past the proxy deadline, then a retry: 1 execution, 1 `unknown-outcome`.

## Risks

- Restoring your foreground may raise the UI browser and trip E5 (inferred).
- Raw Input's view of pen is unknown (pen routes refused in v1, `impl_.rs:3961-3973,4069-4084`).
- Churn (cua#5910, cua#3330).
- Allowed windows show all they contain.

## Open questions for the user

Prefix Q-DC keeps these distinct from bot-architectures.md's Q-D.

- **Q-DC0** Desktop scout host: DSH (images untested), Claude (images verified), or either?
- **Q-DC1** Look-only desktop leases that leave your UI unfrozen?
- **Q-DC2** Which Windows apps go on the first allowlist, and may unsigned ones join by path + SHA-256?
- **Q-DC3** Pin cua-driver by sigstore + SHA-256 + Authenticode `Cua AI, Inc.`, refusing any build failing one?
- **Q-DC4** M4 `act`: background-only, or foreground per step under your grant (Windows-MCP, nonce kill switch)?
- **Q-DC5** Own DSH sessions with a CU package outside desktop hosts: P1 banner + pseudo-lease (test 14), or P2 banner?
- **Q-DC6** Primary driver: cua-driver (prerelease, background) or Windows-MCP (foreground)?
- **Q-DC7** Desktop `act` approvals: a plan drafted in a `look` lease, approved between leases (E5 unchanged; two leases per task), or amend E5 so the paired UI answers step cards mid-lease from behind the target?
- **Q-DC8** Retention TTL for opt-in desktop screenshots?

## Sources

- **Raw reports** (Opus, 2026-10-26): [rp] `dcu-registry-providers.md`; [cn] `dcu-consent-lib.md`; [mn] `dcu-macos-native.md`; [uw] `dcu-upstream-windows.md`; [cv] `dcu-community-versions.md`; [of] `dcu-orchestra-fit.md`. Their A-numbers are superseded.
- **Trees:** `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/{dsh-src/repo,dcu/upstream-windows/cua-0.{28,37}.0}`; installed `@deepseek-ai`, `@oai/sky` 0.7.13.
- **Re-run 2026-10-26:** `npm view`; `gh api graphql` (D#6780, #6788, #7007, #7788, #8927); `gh api` releases v0.28.0/v0.37.0, issues cua#3330, cua#5910.

## Review log

Two red-team lenses, 2026-10-26; each issue re-checked against primary sources.

**Accepted (facts):** all 20 fact-check issues (hooks-claude-code `ask`, Electron ledger, Authenticode, 0.28.0 lacks sigstore, #5910 scope, pen/VK_NONAME, #3330, `--direct`, manifest env, D# citations, sky, dist-tags, spans), plus safety's source facts (`bounded` looser, AFH, `launch_app` args, no lock check, `Drop`-only repair).

**Accepted (design):** one Musician per desktop host, no subagents; `--direct`, private home, allowlisted env; `standard` + manifest; element-addressed calls; no `launch_app`; AUMID/signer identity; window repair; lock kills the driver; split kill switch; deadline → `unknown-outcome`; sticky denials; attachment sweep; macOS not offered; conditional schedule; Q-DC0, Q-DC6–Q-DC8.

**Rejected or partial:** "only DSH can mount it" is corrected, but DSH hosting stays an option (Q-DC0). E5 is not amended; pre-approved plans keep it (Q-DC7). `MANIFEST_APPROVED=1` is set by the proxy in both modes, derived only from your Grant. `bounded` vs `standard` is settled by source, not asked. The Windows-MCP fallback stays, under the nonce rule.

**Uncertain:** pen fallback for element clicks; Raw Input's view of pen and VK_NONAME; #3330 at 0.37.0 under `standard` + manifest; the exe's actual signature (not downloaded); schedule figures.

Errata: all 19 applied to computer-use.md; none unapplied.

**Post-fix review 2026-10-26:** three lenses, re-checked in source. Accepted: element clicks reach pen (`impl_.rs:3961-3973,4069-4084`), so only single-left clicks off WPF/Tk/GTK pass; manifest schema (no delivery field); driver as the proxy's stdio child; Agent-scoped ACP mount, nonce, delegation rows off; AFH via hosted AUMID; RuntimeId-free binding; Q-DC7 open; Lease table; Q-D→Q-DC. Rejected: Q-C edits, CU-/WF- test prefixes, merging Q-DC4 into Q-DC6. Uncertain: GitHub-only claims (API down), Raw Input and pen. Earlier "pen fallback" and "E5 not amended" notes are superseded.
