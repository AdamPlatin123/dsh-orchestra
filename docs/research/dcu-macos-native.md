<!-- Raw researcher report: Opus sweep "macos-native", 2026-10-26. Unedited. Synthesized and red-teamed into dsh-computer-use.md; where the two disagree, the synthesized file wins (see its Review log). -->

## Identity & scope

Key: **macos-native**. This section covers `@deepseek-ai/dsh-experimental-cua-macos`, the Swift helper `dsh-cua-native`, as an engineer would read it before writing the planned Windows C# helper. Sources are the sparse clone at HEAD `22ddee37` (paths below are relative to the repo root), npm metadata, the GitHub REST API, and upstream trycua/cua `platform-windows` at tag `cua-driver-rs-v0.28.0`. I ran no binary, installed nothing, and read no credential.

## Facts

**Shape and provenance**
1. The helper is a macOS 14+ Swift 6 executable that speaks JSON-lines. It uses AppKit, AX, CoreGraphics and ScreenCaptureKit: `packages/experimental/cua-macos/native/README.md:12`, `native/Package.swift:6-7`. It has 27 Swift files and about 3.7k lines (wc). `upstream.json` lists 6 files adapted from the Rust `platform-macos` crate (keyboard, mouse, skylight, windows, ax/tree, apps). The other 19 files are DSH's own, including all request-pipeline, capture, consent and formatter code (`native/upstream.json:7-49`).
2. **Refines the verified list.** The cua-macos README says "Windows support is in development" (`README.md:34,216`; `native/README.md:12`; `cua-bundle/README.md:12`; `src/native-build.ts:20` throws on non-darwin). The shared `dsh-cua` README still says "planned as a separate provider package with a C# helper". It requires "cross-compilation evidence" to be kept separate from "Windows desktop validation" (`packages/experimental/cua/README.md:112-114`).
3. Nothing for Windows exists anywhere I could see:
   - no `windows/`, `csharp/` or `.csproj` and no UIA/SendInput mention under `packages/` (grep);
   - the public repo has only one branch, `master` (`gh api .../branches`);
   - pulls returns 404 and issues are disabled (`has_issues:false`);
   - commit search for "cua windows", "C# helper", "UI Automation" and "csharp" returns nothing;
   - npm has none of `@deepseek-ai/dsh-experimental-cua-windows`, `dsh-cua-windows` or `-cua-win32` (all E404).
   PR merges reference a separate `deepseek-harness/*` org (e.g. "Merge pull request #6806 from deepseek-harness/fix/cua-relative-999"), so work in progress is probably private (inferred).
4. Timeline: the first cua commits are 2026-09-23 (`2355950d`, `17a4118c`, and `7417c38a` "copy licensed macOS accessibility and input primitives"). On 2026-10-11, `f65cb889` "separate shared execution from macOS provider" split the platform-neutral `dsh-cua` from `cua-macos`. #4456 `feat/experimental-dsh-cua` merged 2026-10-14. cua-macos has had 81 commits up to 2026-10-23. The ALREADY VERIFIED dist-tags omit one value: `dsh-experimental-cua-macos` also has tag `alpha: 0.2.1-alpha.5` (npm view, modified 2026-10-26).
5. The published `0.2.1-rc.4` tarball ships Swift sources and no `native/bin` binary: 472,983 B unpacked, 59 files (`npm pack --dry-run`). The README says installed packages need a prepared helper (`README.md:32`). Signing and Desktop distribution are "future work" (`README.md:221`).

**(1) Request pipeline**
6. **One request per connection.** A frame that arrives while a request is active fails with `NATIVE_PROTOCOL` "Concurrent helper request admission". The only exception is one frame buffered during reply writing (`RequestCoordinator.swift:67-68`). Cancel frames are `{type:"cancel",id}`, and a late cancel gets no reply (`native/README.md:38`).
7. **Admission.** `RequestParameters` rejects unknown methods (`UNSUPPORTED`), unknown fields and bad enums (`INVALID_ARGUMENT`) against generated tables (`RequestAdmission.swift:7-22`). The tables come from the Zod protocol in `packages/experimental/cua/src/protocol.ts` (`README.md:125`).
8. **Global FIFO.** `RequestScheduler` holds one process-wide owner slot across all connections, i.e. all Agents and Hosts. Queued waiters cancel with `NATIVE_CANCELLED`, and socket writes do not hold the slot (`RequestScheduler.swift:1-49`; `native/README.md:30`).
9. **Deadlines.**
   - `timeoutMs` 30000 per operation; screenshots use `min(timeoutMs, screenshotTimeoutMs=5000)` (`RequestCoordinator.swift:81-82`).
   - `axTimeoutMs` 3000 per AX system call via `AXUIElementSetMessagingTimeout` (`AXAccess.swift:40`).
   - Other defaults: request limit 1 MiB, response limit 32 MiB, `maxElements` 2000, `maxDepth` 25 (`README.md:50-59`).
10. **Cancellation escalation** (`RequestScheduler.swift:52-58`):
    - After `grace`: if the operation never started or already finished, the reply channel is shut down.
    - After `axTimeout + grace`: if the operation started but did not finish, the result is `NATIVE_UNRESPONSIVE` and `onFatal`, which invalidates the shared process and every handle (`RequestCoordinator.swift:87-93`; decision `2026-10-09-cua-shared-native-helper.md:17`).
11. **Single capture slot.** `WindowCapture.active` is one token. While a system callback is outstanding, new screenshots fail fast with `CAPTURE_BUSY`, and AX and input stay available. Cancellation returns immediately ("late frames are discarded"), but the slot is held until the real callback arrives (`WindowCapture.swift:56-85,149-151`). The reason is a system constraint: replayd keys capture clients by executable path, so two helpers at one path keep evicting each other. That is why one shared service exists per executable digest (`2026-10-09-cua-shared-native-helper.md:9-13`).
12. **Dispatched ≠ verified.** Every input method returns `{dispatched:true, verified:false}` (`AXWorker.swift:190`; `native/README.md:53`). Errors never promise rollback, and the host must not retry input (`native/README.md:58`).
13. **Button release on cancel.** For `holdMs`, "cancellation, timeout and disconnect interrupt the hold and post the pending mouse-up before releasing that slot". However, "forced process termination cannot guarantee cleanup" (`native/README.md:74`). In code, `postPair` pairs every down with one up (`WindowPointerInput.swift:212-213`), and drag posts the held release at the last point (`:142,205`). Keyboard cleanup releases only the keys that call pressed (`KeyboardInput.swift:27,58-60`).
14. **Shared service transport (POSIX-only host code).**
    - Owner-only Unix socket in `/tmp/dsh-cua-<uid>` with mode 0700, checked by uid (`src/shared-native.ts:140-147`).
    - `flock` version lock plus a real-path lock (`SharedHelperRuntime.swift:94`).
    - A hello frame carries each connection's limits.
    - Each connection gets its own `AXWorker`, and the service exits after the last connection finishes cleanup (`native/README.md:28`).

**(2) Background input**
15. **`PIDEventPoster`** (`PIDEventPoster.swift:18-54`):
    - `dlopen`s SkyLight and resolves `SLEventPostToPid`, `CGEventSetWindowLocation` and `SLEventSetIntegerValueField`.
    - `post()` falls back to the public `CGEvent.postToPid` only when `SLEventPostToPid` is missing.
    - **Correction to "public fallback":** `stampWindow()` throws `NATIVE_ERROR` "Window-local input routing is unavailable on this macOS version" if either private field setter is missing (`:57-63`). `mouseEvent()` always stamps the window (`WindowPointerInput.swift:252`), so **all pointer input (click/scroll/drag) needs the private symbols**. Only keyboard posting survives on the public API (inferred from code).
16. **Delivered without focus,** as PID- and window-routed events with no activation (`native/README.md:72-78`):
    - left single/double click, right and middle single click, with modifiers and an optional hold;
    - line scroll of ±10 lines per axis;
    - one-window drag with button and modifiers, `durationMs` 1–5000 and steps 1–240;
    - `typeText` as per-scalar Unicode events, and `pressKey` chords with PID-targeted modifier transitions.
    Keyboard input targets the process's focused control, not a window. Unmodified element clicks prefer `AXPress`/`AXPick`/`AXShowMenu` (`AXWorker.swift:362-363`). Paste uses the app's standard Paste menu command plus a clipboard transaction.
    Known failures: Unicode text not appearing in Blender, and background Cmd+A not selecting in AppKit (`README.md:220`). Applications may still change focus after input (`README.md:43`).
17. **`FOREGROUND_REQUIRED` has exactly one producer:** the system-pointer hover route. It requires `frontPID == owner.pid` and an AppKit mouse hit-test window equal to the target, and posts on `.cghidEventTap`, a global move of the real cursor (`WindowPointerInput.swift:32-58`). Hover tries `AXShowAlternateUI`/`AXShowDefaultUI` first, without moving the cursor. An AX failure propagates with no fallback (`2026-10-13-cua-hover-routes-and-coordinates.md:13`). The result reports `hoverRoute` and `systemPointerMoved` (`AXWorker.swift:488-489`).
18. **Stage Manager.** Thumbnails make the AX frame and CG bounds disagree. Capture and pointer input check CG bounds before and after an AX frame read, and reject with `WINDOW_CHANGED` before any event (`native/README.md:76`; `README.md:107,218`). Explicit `activate`/AXRaise returns before/after foreground observations, which "do not establish who caused" a focus change (`native/README.md:42`; `RequestCoordinator.swift:225-243`).

**(3) Observation**
19. **AX text format.** The default output is text lines `- [index] Role subrole= disabled focused expanded= selected valueWritable= selectionWritable= "title" = value` (`AXTextFormatter.swift:61-90`).
    - Menus collapse unless `includeMenus` is set.
    - Truncation names the limit it reached (`AXAccess.swift:460-467`).
    - `details:true` adds identifiers, global bounds and full action names (`README.md:74`).
    - **No diffing exists.** `disableDiffing` appears only in `cua/src/types.ts:38` and the guidance, not in the protocol, and the README lists "AX diffs" as unsupported (`README.md:216`).
20. **Snapshot invalidation.** Each read replaces the indices for its (appHandle, windowId) scope, while other windows' snapshots survive (`native/README.md:70`).
    - `STALE_SNAPSHOT` is raised for an unknown snapshot ID (`AXWorker.swift:141-143`) and for an `invalidUIElement` during traversal, which publishes no partial tree (`:195-199`).
    - `STALE_APP` is raised on PID+start-time mismatch (`NativePlatform.swift:88-89`).
    - A resize causes `WINDOW_CHANGED`; a move keeps window-local coordinates.
    - Absolute pixels with no screenshot cause `SCREENSHOT_REQUIRED`, which is enforced on the Host (`cua/src/coordinates.ts:62`).
21. **Capture.**
    - ScreenCaptureKit `desktopIndependentWindow`, so per-window capture of off-screen windows is included (`onScreenWindowsOnly:false`).
    - No cursor or shadow, native pixel scale, PNG only (`WindowCapture.swift:90-159`).
    - Geometry mismatch before or after capture gives `WINDOW_CHANGED`.
    - Model-side resizing belongs to the Host (`LlmAdapter.imageRequestTarget`, `2026-10-13-...md:17`).
    - `ScreenshotTrace` emits stage/elapsed/errorCode frames with no titles or pixels, at most 8192 B per request (`ScreenshotTrace.swift`; `README.md:80`).

**(4) Identity and permissions**
22. **Permissions.** `Permissions.swift` reports `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess`. Prompts happen only through Host-only `requestPermission`/`openPermissionSettings`, which are not model tools (`Permissions.swift:13-50`; `native/README.md:82`). The responsible app for TCC comes from the SPI `responsibility_get_pid_responsible_for_pid`, captured before ready (`native/README.md:82`). `launcher_identity_e2e.py` checks it through nested launchers (`native/README.md:108`).
23. **Consent identity.** It is SHA-256(canonical executable path + designated requirement), with strict validation and ad-hoc signatures rejected. Unsigned code falls back to `process:pid:start` (running) or an executable hash (stopped), and is not persistable (`ApplicationAuthorization.swift:7-25,27-43`).
24. **Session lock.** `sessionLocked()` reads `CGSessionCopyCurrentDictionary`.
    - `CGSSessionScreenIsLocked` gives true.
    - On-console plus login-done gives false.
    - Anything else gives null, which maps to `SESSION_UNAVAILABLE` (`NativePlatform.swift:91-104`).
    Any non-false observation **drops all snapshots and observed bounds** (`AXWorker.swift:114-117`). Hover, pointer input and launch check this before dispatch (`WindowPointerInput.swift:36`; `ApplicationDiscovery.swift:68`).

**Upstream Windows (for the C# port)**
25. Upstream's Windows driver is Rust (`platform-windows/src`: `input/{delivery,inject,keyboard,mouse}.rs`, `uia/*`, `wgc.rs`, `capture.rs`, `msaa.rs`, `virtualdesk.rs`). The C# files in the tree are only test fixtures (WPF, WinUI3, WebView2) and samples (`gh api git/trees/cua-driver-rs-v0.28.0`). There is no C# driver to copy.
26. **Upstream input strategy.** `PostMessageW` sends `WM_*BUTTON*`, `WM_CHAR` and `WM_KEYDOWN/UP`, which "does NOT activate the target window" (`input/mod.rs:1-10`).
    - `delivery.rs:1-30` has two modes. `background` is the default and never brings a window forward; when `would_be_silently_dropped(class, kind)` holds it returns `background_unavailable`. `foreground` uses SendInput with a brief `SetForegroundWindow` swap.
    - The old silent "auto" fallback was removed.
    - `background_uipi_blocked` comes from integrity-level checks (`delivery.rs:368-369,521-530`; `input/mod.rs:43-129`).
    - `uia/fg_bypass.rs` wraps UIA `Invoke` in `EnableWindow(FALSE/TRUE)`, because XAML and Chromium hosts bring themselves forward. Measured: 91% z-drops before the wrapper, 0/507 after.
    - `wgc.rs:1-19`: WGC is used for occluded or black PrintWindow windows, cannot capture minimized windows, and needs Windows 10 1903 or later.

## Patterns for Orchestra

- **Adopt verbatim in the Lease state machine:** the input result `{dispatched:true, verified:false}` with a mandatory observe-after (F12), plus "never auto-replay uncertain input" as a Lease invariant. Without it, Lease retry or failover after a crash would replay input (F12, F13).
- **Adopt the error vocabulary as Lease-level reasons**, mapped from any driver: `STALE_APP`, `STALE_SNAPSHOT`, `WINDOW_CHANGED`, `SCREENSHOT_REQUIRED`, `FOREGROUND_REQUIRED`, `SESSION_LOCKED`/`SESSION_UNAVAILABLE`, `CAPTURE_BUSY`, `NATIVE_TIMEOUT`/`NATIVE_UNRESPONSIVE`. Add upstream's `background_unavailable` and `background_uipi_blocked` for Windows (F20, F24, F26). Note that `SESSION_UNAVAILABLE` (null) is a separate state from locked. Orchestra should model "unverifiable" as suspended, not as granted (F24).
- **Session lock suspends the Lease and wipes all snapshot and coordinate state.** Resuming needs fresh observation and must not replay queued input (F24). Windows equivalents: `WTSRegisterSessionNotification`/`WM_WTSSESSION_CHANGE`, `WTSQuerySessionInformation(WTSSessionInfoEx)` lock flag, active-console vs RDP session, `OpenInputDesktop` failure (inferred from Windows API knowledge, not in the tree).
- **Escalation tiers:** request cancel, then connection close, then process invalidation, then all handles dead. Orchestra's Lease should separate request, snapshot, handle, capture-backend and process failure, as `2026-10-09` requires (F10). A wedged capture should degrade to "AX and input OK, no screenshots", not revoke the Lease (F11).
- **Mouse-up on cancel is best-effort only.** If Orchestra kills a Musician, a button may stay down. The Lease release path should send a synthetic release or "all buttons up" before handing the desktop back to the human (F13, inferred).
- **App handles are not ownership.** DSH explicitly gives no cross-call reservation, and its global FIFO orders single operations only (F8; `README.md:212`). Orchestra's Lease is the missing exclusivity layer and must sit above any DSH helper. Do not assume the helper serializes Musicians' multi-step gestures.
- **Background-first, with explicit foreground escalation:** observe and act in the background by default, and make activation an explicit, logged step with before/after foreground evidence. On Windows, use upstream's honest-refusal ladder rather than SendInput fallback (F16-18, F26). A Lease could tier this: background input under a Grant, and foreground under a stronger human grant (inferred).
- **What a C# helper must replace:**

  | macOS-specific | Windows replacement |
  | --- | --- |
  | SkyLight PID/window posting | PostMessage + UIA patterns; SendInput only in foreground mode |
  | AX tree | UIA (plus MSAA fallback upstream) |
  | ScreenCaptureKit | WGC per-window (occluded OK, minimized not) |
  | TCC Accessibility/Screen Recording + responsible-app SPI | No TCC; integrity level/UIPI and possibly `uiAccess` |
  | SecCode designated requirement | Authenticode signer (inferred) |
  | `proc_pidinfo` start time | Process creation time (inferred) |
  | `CGSession` lock check | WTS session state |
  | Stage Manager | Virtual desktops (`virtualdesk.rs`) |
  | Unix socket + flock in `/tmp/dsh-cua-uid` | Per-user named pipe with ACL + mutex (inferred) |

  The Zod protocol, consent flow, coordinate mapping, Host-side `SCREENSHOT_REQUIRED` and the object API are platform-neutral (F7; `README.md:123`). Host transport code in `shared-native.ts` is POSIX-specific (F14).
- **Avoid:** private-symbol dependence as a Lease precondition. DSH itself says to validate each OS version (`README.md:219`).

## Verdict

For Orchestra's Tier 2 Windows Lease, adopt these verbatim: the input contract (dispatched ≠ verified, never auto-replay); the stale-handle, stale-snapshot and window-changed codes; scoped snapshot invalidation; and suspension on session-locked or unverifiable session with all observation state wiped. Then add upstream's `background_unavailable`/`background_uipi_blocked` refusals. The helper's request pipeline gives per-operation FIFO and a single capture slot, not desktop ownership. The Lease still has to supply exclusivity and the hand-back to the human. A DSH Windows helper is **months away, not weeks**, as far as the public record shows:
- no Windows or C# code, branch, PR, commit or npm package exists;
- the docs disagree on status ("in development" vs "planned");
- upstream offers only a large Rust Windows driver to port, not C#;
- the smaller macOS helper took about 3 weeks to first merge and is still experimental, unsigned and built locally (inferred estimate).

Orchestra should not wait on it. On Windows, a Tier 2 driver today means an upstream `cua-driver` MCP via the experimental provider, or Orchestra's own driver.

## Open questions

- Is there a private Windows/C# branch in the `deepseek-harness` org? Merge messages point there, but I cannot see it (not verified).
- Does the C# helper keep the Unix-socket shared-service design, or use named pipes? Does WGC have a replayd-like per-path client conflict that would justify the shared service on Windows (not verified)?
- Does upstream `platform-windows` detect a locked workstation or secure desktop (WTS/`OpenInputDesktop`)? I did not grep the 515 KB `tools/impl_.rs` (not verified).
- Under UIPI, can a medium-IL DSH helper drive elevated apps at all without a signed `uiAccess` build in Program Files? That would affect the Lease's admissible-app list (inferred).
- Can the pointer path ever run on stock macOS without SkyLight, and how often do the private symbols break across macOS versions (README warning only)?

## Sources

- Clone `22ddee37`:
  - `packages/experimental/cua-macos/README.md:32-60,70-113,123,210-221`
  - `packages/experimental/cua-macos/native/README.md:12,28-30,38,42,46-58,70-82,108`
  - `packages/experimental/cua-macos/native/upstream.json`, `native/Package.swift`
  - `native/Sources/CuaNative/{RequestAdmission,RequestScheduler,RequestCoordinator,PIDEventPoster,WindowPointerInput,WindowCapture,Permissions,ApplicationAuthorization,ScreenshotTrace,NativePlatform,AXWorker,AXAccess,AXTextFormatter}.swift` (lines as cited)
  - `src/index.ts`, `src/native-build.ts:20`, `src/shared-native.ts:140-157`
  - `tests/provider-lifecycle.spec.ts`, `tests/shared-native.spec.ts`
  - `packages/experimental/cua/README.md:112-114`, `cua/src/coordinates.ts:62`, `cua/src/types.ts:38`, `cua-bundle/README.md:12`
  - `.agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.md`, `2026-10-13-cua-hover-routes-and-coordinates.md`
- GitHub API:
  - `repos/deepseek-ai/deepseek-harness/{branches,pulls,commits?path=packages/experimental/cua*}`, commit `f65cb889`, `2e215f20`
  - `gh search commits` ("cua windows", "C# helper", "UI Automation", "csharp", "Windows support")
- npm: `npm view @deepseek-ai/dsh-experimental-cua-macos`, `npm pack --dry-run @0.2.1-rc.4`, E404s for `dsh-experimental-cua-windows`, `dsh-cua-windows`, `dsh-experimental-cua-win32`, `dsh-experimental-cua-bundle`.
- Upstream trycua/cua @ `cua-driver-rs-v0.28.0`: `libs/cua-driver/rust/crates/platform-windows/src/{input/mod.rs,input/delivery.rs,input/inject.rs,uia/fg_bypass.rs,wgc.rs}`, plus a tree listing showing that C# files are fixtures only. Fetched copies are in `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/dcu/macos-native/up/`.
