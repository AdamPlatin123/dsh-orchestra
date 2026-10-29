<!-- Raw researcher report: Opus sweep "upstream-windows", 2026-10-26. Unedited. Synthesized and red-teamed into dsh-computer-use.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

- **Subject:** upstream trycua/cua `libs/cua-driver` (Rust) on Windows. I compared two tags: `cua-driver-rs-v0.28.0` (1b50c02e, the version DSH pins) and `cua-driver-rs-v0.37.0` (2d2f9922, npm latest).
- **Clones:** sparse, read only, at `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dcu/upstream-windows/cua-0.28.0` and `.../cua-0.37.0`.
- **Citation paths:** all paths below are relative to `libs/cua-driver/` at 0.37.0 unless marked otherwise.
- **Nothing was run:** no binary was executed and nothing was installed. I only used npm view, npm pack --dry-run, gh api and git ls-remote.
- **Question:** is cua-driver 0.37.x the right Tier 2 driver for this Windows 11 machine, behind an `orchestra-desktop` proxy?

## Facts

**Versions and packaging**

1. **A newer version exists than the verified list says.** Tags `cua-driver-rs-v0.38.0` (85e2b131) and nightlies up to `nightly-cua-driver-rs-v0.38.1-nightly.20261026` exist (git ls-remote; gh api releases). npm has no 0.38.0 (`npm view @trycua/cua-driver@0.38.0` gives E404). Every GitHub release I checked is flagged `prerelease=true`, including 0.28.0 and 0.37.0 (gh api releases/tags). The repo's "latest" release is `cua-spaces-v0.16.0`, not the driver.
2. **The npm package is the in-process SDK, not the MCP server.** `@trycua/cua-driver@0.37.0`:
   - has no `scripts` (so no postinstall) and is MIT;
   - picks the platform binary through six `optionalDependencies`, including `win32-x64-msvc` and `win32-arm64-msvc` (npm view);
   - the Windows x64 package holds `cua_driver_sdk.dll` (30.5 MB) and `cua_driver_node_runtime.node`, with no `cua-driver.exe` (npm pack --dry-run).
   - README.md:47-51 says the language packages run the native runtime in-process and are "for client applications, not agents".
   - The MCP binary comes from release zips (`cua-driver-rs-0.37.0-windows-x86_64.zip`, which has a sigstore bundle) or from `irm https://cua.ai/driver/install.ps1 | iex` (release notes).
   - (inferred) DSH's `cua-driver-native` provider embeds this DLL inside the DSH host process.
3. **Release cadence is fast, with frequent breaking changes.** There were 14 npm releases between 0.30.4 (2026-09-28) and 0.37.0 (2026-10-20) (npm time). Breaking changes:
   - 0.31.0 "resolve element tokens against a snapshot store invalidated on read" (rust/CHANGELOG.md:339-341);
   - 0.35.0 `get_window_state` drops `elements` by default and caps output at 250 nodes (rust/CHANGELOG.md:141);
   - 0.35.0 makes `run_script` (sandboxed QuickJS that drives the driver's own tools) **on by default** on Windows. It can be turned off with `CUA_DRIVER_DISABLE_RUN_SCRIPT=1` (rust/CHANGELOG.md:155; rust/crates/cua-driver-core/src/script_tool.rs:6,48).

**MCP tool catalog**

4. **The live Windows registry** (rust/crates/platform-windows/src/tools/impl_.rs:10288-10450) registers:
   - **Window and app:** list_apps, list_windows, get_window_state, verify_state, launch_app, kill_app, bring_to_front, set_window_frame, invoke_menu, debug_window_info.
   - **Input:** click, double_click, right_click, drag, type_text, press_key, hotkey, set_value, scroll, move_cursor.
   - **Clipboard:** clipboard tools.
   - **Desktop and cursor:** get_screen_size, get_desktop_state, get_cursor_position, the agent-cursor tools, check_permissions, health_report.
   - **Config and inspection:** get_config/set_config, get_accessibility_tree, zoom, page.
   - **Browser:** the browser_* family.
   - **Other:** recording tools and session tools.
   - **Plus core and host tools:** run_steps, run_script, get_guide, check_for_update, and history_status/history_query (authorization.rs:259, 897-933).
   - `type_text_chars` is deliberately not registered (impl_.rs:10426-10430).
5. **Annotations exist and are MCP-standard.** `readOnlyHint` and `destructiveHint` are emitted (cua-driver-core/src/tool.rs:180-181). The checked-in contract (`contract/manifest.json`, contract_version 0.8.0, 29 portable tools) classifies:
   - **read-only:** clipboard_read, get_* tools, list_*, verify_state, parse_visual_regions;
   - **destructive:** click, drag, hotkey, press_key, type_text, invoke_menu, clipboard_write, end_session;
   - **write, not destructive:** scroll, move_cursor, set_window_frame, the cursor tools, start_session.
   - From the source, launch_app is not destructive, while kill_app, set_value, double_click and right_click are destructive (impl_.rs tool defs).
6. **Element ids are snapshot-bound.** The token format is `"s0000002a:22"`, and snapshots are keyed on `(pid, window_id)` (rust/Skills/cua-driver/WINDOWS.md:521-528, 546).
   - Each read replaces the snapshot and lists `invalidated_snapshot_ids`. A stale token is refused with `stale_element_token`.
   - The `since:<snapshot_id>` argument returns only changes (WINDOWS.md:379-383).
   - Separate sessions do not isolate "another observer's snapshot cache" (RUNTIME.md:48).
   - Open issue #5910 (2026-10-25): on Windows 0.38.0, tokens no longer survive across one-shot `cua-driver call` processes. Inside one `mcp` session they still do.
7. **Results arrive in `structuredContent`.** Every action returns a closed object `{effect, route, delivery.mode, evidence, summary, error?, hint?, next_call?, escalation?}` there (docs/action-result-contract.md:15-46).
   - `effect` is one of confirmed, partial, unverifiable, suspected_noop or refused.
   - "Text is diagnostic, not a stable parsing API" (docs/tool-output-format.md:9).
   - `next_call` is never a foreground retry or anything that needs consent (action-result-contract.md:77-85).
   - After three direct actions in a row, the third result carries a hint nudging the agent toward `run_steps` (action-result-contract.md:117-124).
8. **MCP protocol.** Stdio supports modern MCP `2026-07-28` and legacy `2025-06-18`, and embeds an 8-file skill pack as `skill://` resources (docs/mcp-protocol-and-skills.md:3-10, 81-85). The HTTP loopback endpoint is legacy-only and needs a bearer token of at least 32 characters (mcp-protocol-and-skills.md:113-119; RUNTIME.md:115).

**What "background" means on Windows**

9. **Two delivery modes.** `delivery_mode` takes `"background"` (default) or `"foreground"`; the old `"auto"` was removed, and unknown values fall back to background (WINDOWS.md:33-57; platform-windows/src/input/delivery.rs:9-25).
   - **Foreground** means "SendInput with brief `SetForegroundWindow(target)` → restore" (WINDOWS.md:36).
10. **Background routes, in order:**
    - (a) **Element token:** `IUIAutomationInvokePattern::Invoke()`, falling back to `PostMessage(WM_LBUTTONDOWN/UP)` to the deepest child HWND (WINDOWS.md:549-571).
    - (b) **Pixel click:** UIA hit-test that picks the smallest Invoke-bearing element containing the point and calls Invoke. If that misses, it uses coordinate-routed synthetic pen/touch through the system input queue, **only if the target is the top-most visible window at that point**. PostMessage is the fallback for plain Win32 (WINDOWS.md:35, 594-605; input/inject.rs:1-28, 340-351).
    - (c) **Keys and text:** `PostMessageW(WM_CHAR / WM_KEYDOWN/UP)` (input/mod.rs:1-10).
    - (d) **Chromium modifier hotkeys:** PostMessage (WINDOWS.md:264-276).
    - Right-click and multi-click skip UIA and are always PostMessage (WINDOWS.md:636-645).
    - Modifiers on background clicks are silently ignored (WINDOWS.md:278-284).
11. **Refusal codes.** `would_be_silently_dropped()` refuses up front with `background_unavailable` (input/delivery.rs:101-160) for:
    - Chromium windows: click, move, scroll, keystroke, key combo and text;
    - WebView2 hosts: move, scroll and key combo;
    - WPF: pointer, and keys while not in the foreground;
    - Tk, GTK clicks, and VCL accelerators.

    After a failed injection attempt, the code is chosen by matching the cause string:
    - `background_occluded` for "occluded";
    - `background_uipi_blocked` for "uipi" or "higher-integrity";
    - `background_unavailable` otherwise (input/delivery.rs:331-338).
12. **The Windows rows of the action-support ledger, as published** (docs/action-support.md:21, 32-33, 54-60). They are byte-identical at 0.28.0 and 0.37.0 (diff).
    - **Baseline:** "Windows/Win32 | `64e82449` | Run `29257963004`: 122/122 rows, 99 delivered and 23 exact refusals". That run is dated 2026-07-13 (gh api).
    - **Electron, delivered in background:** "left click and child window AX/PX".
    - **Electron, refused in background:** "right click and double click AX/PX, plus drag PX: `background_occluded`; type text, press key, hotkey, and scroll AX/PX plus editor save AX: `background_unavailable`; `start_minimized` launch: `background_unavailable` when Windows denies the foreground lock, with no process spawned".
    - **Tauri, delivered:** "left/right/double click AX/PX, type text AX/PX, press key AX/PX, child window AX/PX, scroll AX, editor save AX".
    - **Tauri, refused:** "hotkey AX/PX and scroll PX: `background_unavailable`; drag PX: `background_occluded`".
    - **WPF, proven:** "Native AX controls; background combo selection, left click, and value changes; PX background left click through UIA hit-testing; foreground pointer gestures".
    - **WPF, gaps:** "Background F5 and PX drag are `background_unavailable`. Additional PX gesture rows remain unproven."
    - **WinUI3, proven:** "Current UIA control, value, selection, popup, and slider rows".
    - **WinUI3, gaps:** "Background right/double-click refusal behavior and broader PX coverage remain unproven."
    - **WebView2, proven:** "CDP page operations; native PX background left click through UIA hit-testing".
    - **WebView2, gaps:** "Native keyboard and broader pointer cells remain unproven outside the shared Tauri/Electron hosts."
    - **UIPI:** `background_uipi_blocked` "is a production refusal code with no canonical elevated fixture today" (action-support.md:58-60).
13. **"Background" changes foreground state behind the scenes. This is stronger than "never steals focus".**
    - `fg_bypass.rs`: wraps UIA Invoke on XAML/WinUI and Chromium hosts in `EnableWindow(host, FALSE)/…/TRUE`, because those apps call `SetForegroundWindow(self)` during Invoke. Without it, the user's window lost foreground "in 91% of poller samples" (platform-windows/src/uia/fg_bypass.rs:1-30).
    - The pen-injection path temporarily sets `WS_EX_NOACTIVATE` on the target. After the tap it calls `force_foreground_attached(prev_fg)` twice, which is `AttachThreadInput` plus `SetForegroundWindow` on the **user's** window (input/inject.rs:116-131, 352-367).
    - Posted clicks do the same re-assertion (input/mouse.rs:137-161).
    - `launch_app` uses `LockSetForegroundWindow` and a VK_NONAME keystroke, and polls `SetForegroundWindow(prior)` every 100 ms for up to 3 s (inject.rs:74-80; WINDOWS.md:252-262).
    - WINDOWS.md:172-174 calls `AttachThreadInput`+`SetForegroundWindow` "Forbidden" for agents, yet the driver uses it internally.
14. **Background delivery has open P0/P1 Windows bugs.** Per the maintainer issue map #3442, all still open (gh api):
    - #3355: a background click can return `unverifiable` with no delivery;
    - #3343: Chrome background clicks use the wrong coordinates;
    - #1706: WPF UIA Invoke and SetValue steal foreground;
    - #2201: background Chrome clicks blur the foreground sentinel;
    - #2207: element-token clicks deadlock on UWP Calculator.
    - (inferred) The macOS bug #4350 (a pixel click turned into an AX press at the element's centre) has a Windows analogue: the hit-test path picks the smallest element containing the point and calls Invoke, so the point itself is lost.

**Permissions and consent on Windows**

15. **Three permission modes, fixed at launch** (README.md:73-84):
    - `standard`, "the promptless default";
    - `bounded`, reviewed manifest only;
    - `unrestricted`, which needs `--dangerously-bypass-approvals`.

    In code, standard mode with no manifest does **no** grant check for desktop input, foreground included: "Standard and unrestricted input do not need a protected grant" (cua-driver-core/src/tool.rs:2659-2666).

    The adapter inventory:
    - `desktop_input` (click … `bring_to_front`, `set_window_frame`) is `Routine`, so it is allowed in standard (authorization.rs:268-287, 462-476);
    - `private_observation`, which includes `get_desktop_state`, is Routine (authorization.rs:228-243, 428-442);
    - clipboard is Routine (604-626);
    - `kill_app` is "driver_ownership_in_standard" (547-562);
    - `check_permissions[prompt=true]` is `Denied` (565-579);
    - existing-profile browser attach and Computer History are `GrantInStandard` (410-425, 445-459).

    So the RUNTIME.md:52 rule "use foreground only when the user authorized" is advice to the agent, not enforced (inferred from tool.rs).
16. **Windows has no OS consent gate.** "Windows has no TCC equivalent"; no admin is needed for normal use; SmartScreen may flag the unsigned binary (WINDOWS.md:473-482). Grants:
    - the only launch grant is `existing-profile` (authorization.rs:24-38);
    - embedders can supply a `DriverAuthorizationHost` / `ProtectedConsentProvider`, and "Cua Driver does not render its own authorization modal" (README.md:92-94; impl_.rs:10209);
    - a capability manifest is a deny-by-default ceiling even in standard mode (RUNTIME.md:68-72).

    Per-app manifest grants on Windows:
    - #3330 (open) said bounded mode refused everything;
    - a community retest on 0.34.1 says desktop apps granted by `executable` now match;
    - matching Store apps by `bundle_id` is still in open PR #4962 (gh api).

    The Windows Hello approval collector exists only in a draft plan, dated 2026-07-20 against 0.9.1 (docs/driver-permission-modes-and-consent-plan.md:3-8, 450). I found no code for it (grep `WindowsHello`: none).

**Process model**

17. **Three ways to run it:**
    - bare `cua-driver mcp` "owns a runtime on Windows/Linux";
    - `--socket` selects the `serve` daemon on `\\.\pipe\cua-driver`, which one-shot CLI calls use;
    - the in-process SDK / embedded host (RUNTIME.md:18-26; WINDOWS.md:491-497; serve.rs:1-19).

    Constraints:
    - The runtime owner must be in Session ≥1; Session 0 is refused (WINDOWS.md:453-468).
    - The pipe ACL is current-user only, `D:P(A;;GA;;;{sid})` with a low integrity label (serve.rs:1650-1661). (inferred) Any process running as the same user, such as another Musician, can call the daemon.
    - **The installer default contradicts its own comments:** `install.ps1:100` sets `[switch]$AutoStart = $true`, while the header comment at 61-67 says "Default off". AutoStart registers a `RunLevel=Highest` (elevated) scheduled task running `serve`, justified because at Medium integrity the cross-AppContainer UIA tree is cut to about one element (install.ps1:677-684).
18. **No single-holder lock.** I found no cross-process input lock (no CreateMutex hits). The docs say "Keep one controller per shared desktop" (RUNTIME.md:48; SKILL.md:79), and sessions are labels, "never a grant" (RUNTIME.md:89-91). "Shared fleet" means Cua's cloud Fleet sandboxes, not local multi-client: docs/shared-fleet-mcp-client.md:1-8 at 0.28.0, and the doc is **removed** at 0.37.0.

**Capture**

19. **Per-window capture with fallbacks.** Capture is per window by default (`get_window_state` returns the UIA tree plus a PNG; `capture_mode` is ignored) (WINDOWS.md:389-396).
    - The backends are PrintWindow `PW_RENDERFULLCONTENT`, then Windows.Graphics.Capture for black or occluded UWP windows (works occluded, Win10 1903+, not when minimized), then a screen-region BitBlt that fails when occluded (capture.rs:1-27; wgc.rs:1-19).
    - The code assumes Per-Monitor V2 DPI awareness (capture.rs:243-246, 512-514).
    - Images default to `max_image_dimension` 1568 (impl_.rs:606). Output is PNG only; `format` and `quality` are rejected (WINDOWS.md:791-794).
    - Full-desktop capture is `get_desktop_state` (WINDOWS.md:402-408).
    - Open P0 #3449: DPI-virtualized capture in the in-process SDK.

**Privacy**

20. **Telemetry is on by default.** It sends to PostHog EU, `https://eu.i.posthog.com/capture/`, with a project key embedded in the binary (cua-driver/src/telemetry.rs:1-12, 25-26).
    - Every MCP tool completion sends the tool name, error class, duration and size buckets, rate-limited per hour, plus the MCP client name and version at session start (telemetry.rs:485-507, 975-988, 1023-1041).
    - Ways to opt out: `DO_NOT_TRACK`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`, `CUA_TELEMETRY` (telemetry.rs:217-245).
    - The update check calls GitHub, cached for an hour; turn it off with `CUA_DRIVER_RS_UPDATE_CHECK=false` (version_check.rs:1-30).
21. **Computer History is now cross-platform but off by default.** It is in nightly builds for macOS, Windows **and** Linux (docs/computer-history-preview.md:3-8). README.md:58 still says "macOS preview", which is stale. The Windows key sits in Credential Manager via `keyring` (platform-windows/src/history.rs:1-24).

**Claude Code compat flag**

22. **The verified list's README citation is stale for Windows.** On Windows, `--claude-code-computer-use-compat` is a **no-op at both 0.28.0 and 0.37.0**: `let _ = compat; // formerly drove the ScreenshotCompatTool branch` (impl_.rs:10389 at 0.37.0; :10080 at 0.28.0). RUNTIME.md:32 confirms the flag adds no screenshot tool. README.md:206-214 is out of date.
    - Separately, Claude Code 2.1.268 could read the embedded skill resources but did not activate the skill natively (mcp-protocol-and-skills.md:99-102).

**Maturity**

23. **Maturity signals:**
    - 304 open issues match "windows" (gh search).
    - Issue map #3442 lists 5 Windows P0s, all open: #3329, #3330, #3355, #3343, #3449.
    - The Windows interactive E2E workflow runs only on manual dispatch: 10 runs between 2026-10-03 and 10-26, 3 of them failures (gh api workflows/310707725/runs).
    - The installer fails on zh-CN locales, issue #2106 (open since 2026-07-04).
    - UIA enumeration is about 100x slower than raw UIA, issue #2100 (open).

**Comparison candidates**

24. **@oai/sky 0.7.13** (Codex):
    - Windows automation via SendInput + UI Automation and WGC screenshots "even if they are occluded" (docs/skills/oai_sky_lib/windows/SKILL.md:14);
    - "input methods activate their target window automatically" (SKILL.md:123);
    - uses `element_index` and `screenshotId` (SKILL.md:52-58);
    - has no `license` field and depends on `@statsig/js-client` (package.json);
    - Windows binary at `bin/windows/codex-computer-use.exe`.
25. **Windows-MCP** (CursorTouch, MIT, 10,438 stars, pushed 2026-10-26, 30 open issues):
    - desktop "control" gating with policies relaxed, balanced and strict;
    - physical-input takeover detection with idle timeout;
    - tool exclusion via `--exclude-tools`;
    - full-screen capture backends dxcam, mss and pillow;
    - telemetry on by default to PostHog US (README, fetched via gh api, lines ~602-660, 705-718, 775-781).
    - The design note's current Tier 2 bullet is computer-use.md:75.

| | cua-driver 0.37 | @oai/sky 0.7.13 | Windows-MCP |
|---|---|---|---|
| a11y-first | Yes: UIA Invoke/Value/ExpandCollapse (F10) | Yes: UIA plus element_index (F24) | UIA snapshot plus coordinates (not verified) |
| Background delivery | Yes for UIA/PostMessage/pen; exact refusals otherwise (F10-12) | No (F24) | No (inferred: direct input is gated) |
| Focus stealing | Avoided by compensation (EnableWindow, NOACTIVATE, restoring the user's window); open P0/P1 bugs (F13-14) | Yes, by design | Yes (inferred) |
| Per-window capture | Yes: PrintWindow, then WGC for occluded (F19) | Yes: WGC, occluded OK | No, full screen (F25) |
| Element ids | Snapshot-bound tokens, invalidated on read (F6) | element_index + screenshotId | Snapshot labels (not verified) |
| Approval hooks | Manifest ceiling, ProtectedConsentProvider; standard mode is promptless (F15-16) | None in the API (not verified) | Ownership gate, takeover, tool exclusion |
| Process isolation | Separate process for `mcp`; per-user pipe; elevated autostart by default (F17) | Codex-owned exe | Python process, serialized tools |
| License | MIT (OmniParser extension AGPL, opt-in; README.md:19-26) | Unstated (not verified) | MIT |
| Windows maturity | 122-row harness (July baseline); 5 P0s open; fast releases | Shipping inside Codex | Large user base; no ledger |

## Patterns for Orchestra

- **Adopt the delivery-mode ladder as the Lease's enforcement point (F9, F15).** The proxy should forward only `delivery_mode:"background"`. It should refuse `"foreground"`, `bring_to_front`, `get_desktop_state`, `kill_app`, `clipboard_*`, `run_script` and `run_steps` unless the human-granted Lease covers them. The driver itself will not refuse these in standard mode.
- **Run bare `cua-driver mcp` as a stdio child of the proxy only (F17).**
  - Install from the release zip with sigstore verification (`-RequireSignature`), or with `-NoAutoStart`.
  - Make sure no `cua-driver-serve` task exists, so no Musician can reach `\\.\pipe\cua-driver`.
  - Launch with `--permission-mode standard --capability-manifest … --approve-capability-manifest` (RUNTIME.md:76-81) so the manifest removes tools at the source.
  - Set `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`, `DO_NOT_TRACK=1` and `CUA_DRIVER_RS_UPDATE_CHECK=false` (F3, F20).
- **Use the closed `ActionResult` as the evidence record (F7).** Log `effect`, `route` and `delivery.mode` per action in the Post Office. Treat `unverifiable` as unknown, never as success.
  - The proxy must pass `structuredContent` through intact. DSH's D#7788 shows what breaks when it doesn't: element_token is lost.
- **Own the single-holder lock in the proxy (F18, F6).** Hold one MCP connection per Lease, and invalidate tokens when the holder changes. The driver has no lock, and a second observer silently invalidates the first one's tokens.
- **Avoid assuming "background" means "invisible to the human" (F13-14).** The driver briefly disables windows and re-asserts foreground. The Lease UI should say so, and the spike must measure focus drops while the user is typing.
- **Avoid the native embed path for Orchestra (F2).** The DLL in the host process is what DSH's README warns can crash the host. The `mcp` subprocess keeps the crash boundary.
- **Pin an exact version and re-run a Windows smoke matrix on every bump (F3, F23).** Token scoping changed in 0.31 and again in 0.38 (#5910).

## Verdict

Yes: the M4 spike should switch from Windows-MCP to cua-driver 0.37.x, run as a proxy-owned stdio `cua-driver mcp` child with no daemon. It is the only one of the three candidates with UIA-first background delivery, exact refusal codes, per-window occluded capture, snapshot-bound element tokens and an MIT license. Windows-MCP and sky both drive the real foreground. Keep Windows-MCP as the fallback rather than deleting it from the note.

The three biggest risks:

1. **Authorization lives entirely in Orchestra.** Standard mode is promptless for input, foreground, desktop capture and clipboard. Per-app manifest grants only recently started working for desktop executables, and Store apps are still pending. The default installer registers an elevated `serve` daemon that any same-user process can call.
2. **"Background" is compensated rather than side-effect-free.** It uses EnableWindow, NOACTIVATE and AttachThreadInput to restore the user's foreground, and synthetic pen input to the top-most window. Open P0/P1 bugs (silent no-ops, wrong Chrome coordinates, WPF focus steal) make it unsafe to assume a human can keep working undisturbed.
3. **Churn and immaturity on Windows.** Releases are weekly, every GitHub release is flagged prerelease, and breaking changes are frequent. The Windows ledger evidence dates from July and the interactive E2E runs only on manual dispatch. The installer is broken on zh-CN locales (#2106), and telemetry is on by default.

## Open questions

- Does `cua-driver mcp` at Medium integrity (non-elevated) give usable UIA trees for UWP apps on this machine? install.ps1:677-684 says no; WINDOWS.md:473-476 says no admin is needed. (not verified)
- Can a capability manifest in standard mode scope `delivery_mode_ceiling` per resource, so the driver enforces background-only? (tool.rs:2667-2700 builds the resource; matching is not verified)
- Is this machine's system locale zh-CN? That would trigger #2106 if Orchestra used install.ps1. (not verified)
- Can two concurrent `cua-driver mcp` processes run, and what happens to their interleaved input? (no lock found; behavior not verified)
- Has DSH's rc.2 `dsh-mcp-client` fixed `structuredContent` passthrough (D#7788)? This matters if Orchestra ever reuses DSH's MCP provider. (not verified)
- Do the 0.38.0 token-scope changes (#5910) also affect a single long-lived `mcp` session? (reporter says no; not verified)
- What is the license of @oai/sky, and does it have any approval hook? (not verified)

## Sources

- Clones (read only): `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dcu/upstream-windows/cua-0.37.0/libs/cua-driver/` and `.../cua-0.28.0/libs/cua-driver/`.
  - Docs: README.md; docs/action-support.md, action-result-contract.md, tool-output-format.md, mcp-protocol-and-skills.md, driver-permission-modes-and-consent-plan.md, permission-adapters-and-session-modes-plan.md, computer-history-preview.md; docs/shared-fleet-mcp-client.md (0.28.0 only).
  - Skills: rust/Skills/cua-driver/{WINDOWS,RUNTIME,SKILL}.md.
  - Changelog: rust/CHANGELOG.md.
  - Code: rust/crates/platform-windows/src/{input/mod.rs, input/delivery.rs, input/inject.rs, input/mouse.rs, uia/fg_bypass.rs, wgc.rs, capture.rs, history.rs, tools/impl_.rs}; rust/crates/cua-driver-core/src/{authorization.rs, tool.rs, script_tool.rs}; rust/crates/cua-driver/src/{telemetry.rs, version_check.rs, serve.rs}; contract/manifest.json; scripts/install.ps1.
- `git ls-remote --tags https://github.com/trycua/cua.git`
- gh api:
  - releases: cua-driver-rs-v0.28.0, cua-driver-rs-v0.37.0;
  - issues: #3442, #3329, #3330, #3355, #3343, #1706, #2201, #2207, #3449, #2106, #2100, #4350, #5910;
  - PR #4962;
  - actions: workflows/310707725/runs, runs/29257963004.
- `npm view @trycua/cua-driver` (dist-tags, time, optionalDependencies, scripts); `npm pack @trycua/cua-driver-win32-x64-msvc@0.37.0 --dry-run`
- `C:/Users/Calx/AppData/Local/OpenAI/Codex/runtimes/cua_node/1fb7137c46617d50/bin/node_modules/@oai/sky/{package.json, docs/skills/oai_sky_lib/windows/SKILL.md, docs/sky-window2-api.md}`
- github.com/CursorTouch/Windows-MCP (repo metadata and README via gh api)
- G:/_Projects/dsh-orchestra/docs/research/computer-use.md:75 (read only)
