<!-- Raw researcher report: Opus sweep "windows-isolation", 2026-10-26. Unedited. Pre-review; synthesized into computer-use.md, which wins where the two disagree. -->

## Identity & scope

This angle covers how several Musicians can get eyes and hands on one Windows 11 Pro machine (27.8 GB RAM, measured with `Get-CimInstance` on 2026-10-26) without taking over the human's own desktop, and what each option costs. The evidence comes from Microsoft Learn, the Chromium and CDP sources, the Playwright and Playwright-MCP sources, the locally installed `@oai/sky` 0.7.13 and Codex browser plugin docs (read, never executed), and three local measurements. In those measurements I ran Google Chrome 156.0.8078.47 headless with throwaway profiles in the scratchpad and killed every one of those processes afterwards (leftover count 0). One further test, reading `chrome://sandbox` from inside a Job, was refused by the permission classifier. Its result is therefore marked "(not verified)" below.

## Facts

**OS input (SendInput) cannot target a window, and focus cannot be taken quietly**
- SendInput "inserts the events … serially into the keyboard or mouse input stream" and has no window parameter. It "is subject to UIPI", and a failure caused by UIPI is not reported (MS Learn, SendInput, Remarks / Return value). Synthesized input therefore goes to whatever window is in the foreground. It cannot be aimed at a background window. (A conclusion from the API shape and the docs.)
- SetForegroundWindow has these limits: "An application cannot force a window to the foreground while the user is working with another window. Instead, Windows flashes the taskbar button." The foreground process can also block it with LockSetForegroundWindow (MS Learn, SetForegroundWindow, Remarks; page updated 2025-10-07).
- @oai/sky on Windows says "input methods activate their target window automatically" (`…\@oai\sky\docs\sky-window2-api.md:28`; `docs\skills\oai_sky_lib\windows\SKILL.md:123`). Its recovery path covers input that "is over `StartMenuExperienceHost.exe` or another non-target window" (SKILL.md:96). In other words, Windows computer use as shipped takes the foreground. (inferred)
- On Linux, by contrast, sky "sends input to that window without activating it or moving the desktop pointer… Targeted input never falls back to activating the window. Apps may still … grab the pointer; text entry uses the shared clipboard" (`docs\skills\oai_sky_lib\linux\SKILL.md:26-30`; `docs\sky-full-desktop-api.md:7`).
- Physical input can be told apart from injected input. A low-level mouse hook sees `LLMHF_INJECTED` (bit 0) and `LLMHF_LOWER_IL_INJECTED` (bit 1) (MS Learn, MSLLHOOKSTRUCT `flags`). Orchestra can use this to revoke a lease as soon as the human touches the mouse. (inferred; I assume the keyboard flag `LLKHF_INJECTED` is analogous but did not verify it.)
- UIA: `IUIAutomationInvokePattern::Invoke` "should return immediately without blocking. However, this behavior depends on the implementation". `IUIAutomationElement::SetFocus` "Sets the keyboard focus to this UI Automation element" (MS Learn). Neither page says foreground is required. Invoke/Value on a background window works per app and has no documented guarantee. SetFocus, and anything typed, needs keyboard focus, which only the foreground window has. (inferred)
- Desktop objects: "only one of these desktops at a time is active … the *input desktop* … is the one that is currently visible to the user and that receives user input", and "Window messages can be sent only between processes that are on the same desktop" (MS Learn, Desktops).
- Virtual desktops: `IVirtualDesktopManager` has only `GetWindowDesktopId`, `IsWindowOnCurrentVirtualDesktop` and `MoveWindowToDesktop`. There is no documented API to create or switch desktops. The docs say "When one virtual desktop is hidden, all of the windows associated with it are also hidden" and "applications should avoid automatically switching the user … Only the user should instigate that change" (MS Learn, IVirtualDesktopManager, Remarks).

**Capture**
- Windows.Graphics.Capture draws "a yellow notification border … around the actively captured item" (MS Learn, Screen capture, updated 2026-08-27). Turning the border off requires `GraphicsCaptureAccess.RequestAccessAsync(Borderless)`, which prompts the user, plus the packaged capability `graphicsCaptureWithoutBorder` (MS Learn, `GraphicsCaptureSession.IsBorderRequired`, Remarks; Win 10.0.20348+).
- sky claims WGC capture "works even if they are occluded" (Windows SKILL.md:14). How WGC behaves on minimized windows is not verified.
- PrintWindow is synchronous. "The application that owns the window … processes the PrintWindow call" through WM_PRINT (MS Learn, PrintWindow, Remarks). Its fidelity therefore depends on the app, and many GPU-composited apps probably come out blank. (inferred / not verified)

**CDP-only control of a headed or headless browser** (ChromeDevTools/devtools-protocol `pdl/domains`, master commit 7245ec5, 2026-10-22)
- `Input.dispatchMouseEvent` "Dispatches a mouse event to the page". x and y are "relative to the main frame's viewport in CSS pixels" (`Input.pdl:164-176`). The OS cursor and OS focus are not involved. (inferred)
- `Target.createTarget` has `background` and `focus` parameters. With the default `background: false` and no `focus` argument, "the new target is focused and the browser window is brought to the foreground". `background:true` keeps the window where it is. There is also a `hidden` target type that is "not present in the tab UI strip" (`Target.pdl:166-181`). `Page.bringToFront` "activates tab" (`Page.pdl:580-581`).
- `Emulation.setFocusEmulationEnabled` (experimental) is "simulating a focused and active page" (`Emulation.pdl:228-232`). `setDeviceMetricsOverride` takes `deviceScaleFactor` (`Emulation.pdl:279-281`). `Browser.setWindowBounds` supports `minimized` (`Browser.pdl:13-18,309-315`).
- Playwright adds `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling` to every Chromium launch (`playwright-core/src/server/chromium/chromiumSwitches.ts:62-80`). It talks over `--remote-debugging-pipe`, not a TCP port (`chromium.ts:358`, commit 91a765d, 2026-10-24).
- **Playwright passes `--no-sandbox` unless `chromiumSandbox: true`** (`chromium.ts:386-387`). Playwright MCP has explicit `--sandbox` and `--no-sandbox` flags (playwright-mcp `README.md:437,445`).
- Profiles: "browsers do not allow launching multiple instances with the same User Data Directory". Automating the default Chrome profile "is not supported" (playwright.dev BrowserType.launchPersistentContext). Playwright MCP keeps one persistent profile per workspace at `%USERPROFILE%\AppData\Local\ms-playwright\mcp-{channel}-{workspace-hash}`, and says that "concurrent MCP clients sharing the same workspace will conflict" (README:473-485). This machine already has 11 `mcp-chrome-*` profiles under `C:\Users\Calx\AppData\Local\ms-playwright` (listed locally).
- Versions as of 2026-10-26: Playwright v1.64.1 (released 2026-10-14), 98,582 stars. playwright-mcp v0.0.83 (2026-09-28), 38,668 stars.

**Measured on this machine (single runs, so treat as noisy)**
- Headless Chrome 156 (`--headless=new`), one profile, about:blank: 10 processes, 568 MB working set, **284 MB private**.
- Four separate profiles, each loading github.com/microsoft/playwright: 56 processes, 2,174 MB WS, 1,116 MB private (**about 279 MB private per instance**).
- One browser with four CDP `createBrowserContext` contexts on the same page: 17 processes, 2,005 MB WS, 1,387 MB private (291 MB baseline).
- Conclusion: roughly 0.3 GB private / 0.5 GB WS per Musician on a real page. Contexts save processes but not much memory on heavy pages. On 27.8 GB, eight browser Musicians cost about 2.5–4.5 GB. (inferred)
- A second launch on a profile that is already in use exited at once with **exit code 21**, and `lockfile` was present in the user-data-dir. `--remote-debugging-port=0` produced distinct ports (4232–4238) in `DevToolsActivePort`.

**Chromium vs procguard Job Objects**
- Nesting rule: if a process is already in a job, the new job "must be in the hierarchy … and it cannot have UI limits set (… JobObjectBasicUIRestrictions)". Jobs "are nested by default if … neither job sets UI limits" (MS Learn, AssignProcessToJobObject parameters; Nested Jobs). A nested breakaway stops at "a job that does not allow breakaway" (same pages).
- Chromium's renderer job sets UI limits: clipboard, handles, global atoms, display settings, system parameters, desktop and exit-windows (`sandbox/win/src/job.cc:39-54`). Chromium dropped its unconditional `CREATE_BREAKAWAY_FROM_JOB` because it broke launches under Task Scheduler on Win8+ (codereview 1546313002, commit 7db0660, 2016-01, possibly stale).
- **Measured:** Chrome 156 launched from a process in a `KILL_ON_JOB_CLOSE` job (no `BREAKAWAY_OK`, no UI limits, which matches spec §13.2 S4 at spec:1212) started normally: 15 processes, renderers present, no `--no-sandbox` on any command line. **The same launch with UI limits `0x41` (HANDLES|DESKTOP) on the outer job produced 0 Chrome processes after 6 s.** Whether the renderers actually ran sandboxed inside the job (`chrome://sandbox`) is not verified, because that test was refused.
- Chromium's sandbox design doc: "Each renderer runs in its own Job object". Renderers are sandboxed "unless the `--no-sandbox` command line" flag is given (chromium docs/design/sandbox.md).

**Disposable desktops**
- Windows Sandbox: Pro is supported. It is a "disposable virtual machine" that "Takes a few seconds to launch" with "smart memory management" (MS Learn, Windows Sandbox overview, updated 2026-10-08). **"Windows Sandbox currently doesn't allow multiple instances to run simultaneously."** Networking, vGPU, clipboard redirection and audio input are on by default. Default capacity is 4 GB, the `MemoryInMB` floor is 2048 MB, and a write-mapped folder persists after disposal. `LogonCommand` takes one command. The window size cannot be configured (MS Learn, configure-using-wsb-file, 2026-03-31).
- The `wsb` CLI (Windows 11 24H2+) offers start, list, exec, stop, share, connect and ip. "There is no support for process I/O". Running exec as `ExistingLogin` needs an active session created with `wsb connect`, which opens an RDP window; `-r System` avoids that (MS Learn, Windows Sandbox CLI).
- Locally, `C:\Windows\System32\WindowsSandbox.exe` is absent and `wsb` is not on PATH, so the feature is probably not enabled. (inferred)
- Second interactive session: "Windows 10/11 Enterprise multi-session … allows multiple concurrent interactive sessions. Previously, only Windows Server could do this". Running it outside Azure Virtual Desktop "is against the licensing agreement" (MS Learn, multisession FAQ). Microsoft Q&A 1857388 also states that Pro allows one session at a time, and the RDP-wrapper workarounds are unsupported (not official docs; RDP loopback to self on Pro not tested).
- Hyper-V Enhanced Session runs RDP to a Windows VM that is "resizable and high-DPI aware", with clipboard and drive sharing (MS Learn, enhanced-session-mode, 2026-01-21). Windows 365 pricing and latency were not verified.
- WSL2: the default VM memory is "50% of total memory on Windows". `guiApplications` (WSLg) is on by default. `networkingMode` defaults to NAT. `localhostForwarding` defaults to true. `.wslconfig` does not apply to `wslc.exe` containers (MS Learn, wsl-config, updated 2026-10-16). `wsl.exe` and Docker are installed locally (Get-Command).
- Windows containers: on Pro they are allowed only "for test or development purposes" (MS Learn, Windows Containers FAQ). That they offer no interactive GUI desktop is not verified on Learn.

**Existing harness patterns (local)**
- The Codex browser plugin 26.1021.31345: "Keep browser work in the background by default" (`docs\visibility.md:3`). Agent-created in-app tabs "close when the turn ends" (`docs\tab-cleanup-iab.md:3`). It can claim a user's tab in their real browser (`docs\tab-claiming-chrome.md:9`). Control stops "because the extension or user took control" (`docs\browser-control-interruption.md:3`).
- Codex can require approval per browser tool (`config.toml` per-tool `approval_mode`, as given). sky reads the accessibility tree first and uses window-relative screenshot coordinates tied to a `screenshotId` (Windows SKILL.md:36-42,82).

**Coordinates and DPI**
- SendInput absolute coordinates are normalized to 0–65,535 on the primary monitor, or across the whole virtual desktop with `MOUSEEVENTF_VIRTUALDESK` (MS Learn, MOUSEINPUT, Remarks). Hook coordinates are "per-monitor-aware screen coordinates" (MSLLHOOKSTRUCT).
- CDP input uses CSS px, while screenshots come in device px (×`deviceScaleFactor`). A bot that clicks at screenshot pixels on a 150%-scaled monitor misses by 1.5× unless it converts. sky's window-relative + `screenshotId` scheme is the safe abstraction. (inferred)

## Patterns for Orchestra

**Adopt**
1. **Tier 0, the default and fully parallel tier: one headless Chromium per Musician, with its own user-data-dir and Playwright `--remote-debugging-pipe`.**
   - Storage-state JSON is exported only for profiles you approve.
   - Launch inside that Musician's existing procguard nested Job, with `chromiumSandbox: true` / MCP `--sandbox`.
   - This is an Orchestra-owned, bot-facing process, so the §5.4 rule "never put user-facing programs in a Job" (spec:422) does not apply.
   - Crash recovery: on exit code 21 or a stale `lockfile`, procguard checks that no live process holds the dir (§10.5 pid+createTime) before reusing it.
   - Budget about 0.3–0.5 GB per Musician into §10.2 Governor and §10.12.
   - Touches §5.4, §10.2, §10.5, §10.8, S4.
2. **Pipe rather than TCP CDP.** Any same-user process can drive a `--remote-debugging-port`, which is the same class of risk §8.5 already flags for `peerToken` (inferred). If a port is unavoidable, read it from `DevToolsActivePort` and never publish it on the Post Office. Touches §8.5, §10.11.
3. **Count every browser observation as taint.** §8.5 already lists "抓取过的 URL" ("fetched URLs") as a taint source. Screenshots and accessibility trees from Tier 0–3 should carry `provenance` the same way, and the turn should get the red bar. Touches §8.5, §10.9.
4. **Tier 1: headed browser windows, controlled only through CDP.** Create targets with `background:true` (or `focus:false`) and `setFocusEmulationEnabled`, never call `bringToFront`, and keep Playwright's anti-occlusion switches. Use this only when a site rejects headless. The window can sit minimized or on another virtual desktop through `MoveWindowToDesktop` on its own HWND; whether rendering and screenshots keep working there is not verified, so test it in S4. UIA Invoke/Value on background windows belongs here as best effort, per app. Touches §10.8, §13 M2 spike.
5. **Tier 2: an exclusive desktop lease for real OS computer use** (sky or Claude `computer-use`). This is the only way to drive arbitrary Windows apps, and it necessarily owns the one keyboard and mouse.
   - One global lease in orchestrad, granted only by a human click (D8), time-boxed (for example 5 min), and shown in the Program banner.
   - A topmost click-through overlay. The WGC yellow border is also a useful, unforgeable "bot is watching" signal, so do not try to suppress it.
   - Emergency release: procguard runs a `RegisterHotKey` handler plus a low-level hook that revokes the lease on any physical input without `*_INJECTED`, then kills the Musician's Job.
   - Touches §5.4 (a new "desktop" resource owned by one movement), §10.5, §10.9, §11.2, §13 M2/M4.
6. **Tier 3: a disposable desktop** for risky or logged-out exploration and to reproduce UI bugs.
   - Windows Sandbox: single instance, so a one-slot queue under §3.1 principle 4. Networking off unless the task needs it. Read-only mapped folders. Clipboard redirection off. `wsb exec -r System`, with results written to a write-mapped scratch dir.
   - For parallel Linux browsers: WSL2 with Xvfb (not WSLg, which would draw windows on the human's desktop) and a `memory=` cap in `.wslconfig`.
   - A Hyper-V VM with Enhanced Session when a persistent Windows desktop is needed.
   - Touches §10.8 ("这不是沙箱", "this is not a sandbox"; Tier 3 is the only tier that actually is one), §13 M3+.

**Avoid**
- **Any Job UI limits in procguard.** Per the measured result, Chromium will not start under them. Write "never set JobObjectBasicUIRestrictions" into S4 next to "no BREAKAWAY_OK" (§13.2 spec:1212, D4).
- **Playwright's default `--no-sandbox`.** It silently removes the renderer sandbox that Tier 0 relies on. Add a contract test in §7.2.
- **Giving owned Musicians the human's real browser** (Claude in Chrome, Codex tab claiming, Playwright `--extension`, or the default Chrome profile). That browser may be the paired browser hosting `orchestra.localhost`. An OS-input bot (Tier 2) can also click and type in that browser. Either way the bot can press Approve, which defeats D8 and §10.9's typed confirmations (inferred). Mitigations:
  - Run the Orchestra UI in a dedicated browser profile.
  - Exclude its window from Tier 2 leases, with procguard refusing a lease while that window is in the foreground.
  - Require that approvals inside a lease use physical (non-injected) input.
  - Touches §10.11, §10.9.
- **Virtual-desktop switching or SendInput for "background" bots.** Both take the human's desktop (IVirtualDesktopManager remarks; SendInput has no target).
- **RDP-to-self or multi-session hacks on Pro.** They are unlicensed or unsupported.
- **WSB for parallel use.** Only one instance can run.
- **Conflict with the §3.2 non-goal "不抓取屏幕内容" ("don't scrape screen content").** Tiers 1–3 are screen capture. Reword the non-goal to "Orchestra never captures the human's screen; Musicians may capture only their own leased or isolated surfaces". Touches §3.2.

## Verdict on the user's claim

From this angle the claim is half right. Real lookups (a CI page, a dashboard behind login, reproducing a UI bug) do need eyes and hands. But on one Windows desktop, only browser-scoped, CDP-driven eyes and hands can be given to several Musicians in parallel without hijacking the human. SendInput has no target window, and Windows will not hand the foreground to a background process while the user is working. Tier 0 headless Chromium covers most lookups at about 0.3 GB per Musician. It runs alongside the procguard Jobs as long as the Job has no UI limits and Playwright's `--no-sandbox` default is overridden. True OS-level computer use, which Codex already ships through sky, is a single exclusive resource. It belongs behind a human-granted lease or in a disposable sandbox/VM, not built into every bot. So "a bot without computer use isn't a real bot" overstates it. A better version: every Musician should have a browser, and one Musician at a time may borrow the desktop.

## Open questions

1. Do Chrome 156 renderers stay sandboxed (renderer job applied, untrusted integrity) when launched under procguard's Job with no UI limits? Check `chrome://sandbox` in S4. That test was blocked here.
2. Does Chromium's renderer job with UI limits nest under a parent job without UI limits, given MS's "neither job sets UI limits" rule? Or does Chromium fall back to something else? The source was not traced.
3. Do CDP screenshots and input keep working for a headed window that is minimized or on a non-current virtual desktop, with Playwright's anti-occlusion switches?
4. Do WGC and sky capture minimized windows? Do UIA Invoke/Value work on windows on another virtual desktop without switching?
5. Windows Sandbox boot time and RAM on this machine: the feature is not enabled, so nothing was measured. Does enabling it need admin rights (a §10.11 "refuses to run as admin" interaction)?
6. Does the sky Linux "no activation, no pointer" mode work against Xvfb inside WSL2? Is it licensed or extractable from the Codex runtime? (Never executed here.)
7. Windows 365 cost and latency, and Hyper-V guest licensing for a persistent Tier-3 desktop: not verified.
8. Should Tier 2 approval clicks require physical input, detected by low-level hooks in procguard (a new S4 command), and is a global hook acceptable in a non-admin daemon?

## Sources

- Local, read-only:
  - `C:\Users\Calx\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node_modules\@oai\sky\docs\sky-window2-api.md:28`
  - `…\@oai\sky\docs\sky-full-desktop-api.md:7`
  - `…\@oai\sky\docs\skills\oai_sky_lib\windows\SKILL.md:14,82,96,123`
  - `…\@oai\sky\docs\skills\oai_sky_lib\linux\SKILL.md:26-30`
  - `…\@oai\sky\package.json:3` (0.7.13)
  - `C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\docs\{visibility.md:3,tab-cleanup-iab.md:3,tab-claiming-chrome.md:9,browser-control-interruption.md:3}`
  - `C:\Users\Calx\AppData\Local\ms-playwright\` (listing)
  - Spec `G:\_Projects\dsh-orchestra\docs\specs\2026-10-26-dsh-orchestra-design.md` §3.2 (l.295), D4 (l.312), §5.4 (l.422), §8.5, §10.1, §10.5, §10.8, §10.9, §13.2 S4 (l.1212)
- Local measurement scripts and raw downloads:
  - `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\desktop-sharing\scripts\measure.ps1`
  - `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\desktop-sharing\scripts\ctx.ps1`
  - `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\desktop-sharing\scripts\injob.ps1`
  - `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\desktop-sharing\raw\`
- Microsoft Learn: SendInput; SetForegroundWindow; MOUSEINPUT; MSLLHOOKSTRUCT; IUIAutomationInvokePattern::Invoke; IUIAutomationElement::SetFocus; Desktops (winstation); IVirtualDesktopManager; PrintWindow; Screen capture (Windows.Graphics.Capture); GraphicsCaptureSession.IsBorderRequired; Nested Jobs; AssignProcessToJobObject; Windows Sandbox overview; Windows Sandbox configure-using-wsb-file; Windows Sandbox CLI; Windows Enterprise multi-session FAQ; Hyper-V enhanced-session-mode; WSL wsl-config; Windows Containers FAQ
- Microsoft Q&A 1857388 (RDP on Windows 11 for multiple users; not official docs)
- Chromium:
  - https://chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md
  - `sandbox/win/src/job.cc:39-54` (main)
  - `sandbox/policy/win/sandbox_win.cc` (main)
  - codereview.chromium.org/1546313002 (commit 7db0660, 2016; possibly stale)
- ChromeDevTools/devtools-protocol `pdl/domains/{Input,Target,Page,Emulation,Browser}.pdl` @ 7245ec5 (2026-10-22)
- microsoft/playwright `packages/playwright-core/src/server/chromium/{chromium.ts:358,386-387, chromiumSwitches.ts:62-80}` @ 91a765d (2026-10-24); playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- microsoft/playwright-mcp `README.md:437,445,473-485` (v0.0.83)
