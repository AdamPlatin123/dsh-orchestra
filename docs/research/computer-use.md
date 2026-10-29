# Computer use for Musicians: eyes and hands as stage instruments

Date 2026-10-26, revised after two red-team reviews. Position paper from six researcher reports; it proposes spec amendments and does not edit the spec. Companions: [bot-architectures.md](bot-architectures.md), [dynamic-workflow-merge.md](dynamic-workflow-merge.md).

**Evidence keys**
- [spec]; [req] `requirements.md`; [bot] `bot-architectures.md` (A1–A20, R29–R41, D13–D16).
- [hc] harness-cu, [bc] bot-cu, [cl] cua-landscape, [sc] security-cu, [wi] windows-isolation, [cc] community-cu, kept raw as `cu-<key>.md`. This file wins where they disagree (e.g. "DSH ships no browser tool" in [cl]/[sc] is superseded). DSH desktop CU: see dsh-computer-use.md.
- Paths: `SKY` = Codex's `cua_node\…\@oai\sky`; `OB` = `C:\Users\Calx\.codex\plugins\cache\openai-bundled`; `DP` = local DSH 0.2.1-rc.2 `@deepseek-ai`; `CCD/` = code.claude.com/docs/en/; `PWM` = playwright-mcp README v0.0.83; `DSB/` = `G:\_Projects\DS-Bot\ds-bot\`.
- Issues: `CC#` claude-code, `CX#` codex, `OC#` openclaw, `DSB#` DS-Bot, `DSH-D#` deepseek-harness discussions.
- Codex protocol facts were checked against openai/codex master on 2026-10-26 (local CLI 0.139.0; latest rust-v0.164.0). Orchestra pins one version and cites file@sha (D12).
- Markers: (inferred); (not verified); (assumption) = proposed default.

## Position

1. You are right that a bot without eyes fails the look-ups (查询) you care about. DSH's `web_fetch` is anonymous, public-only, runs no JS and cannot log in (`DP\dsh-web-fetch-http\README.md:12,64`) [hc], so SSO'd CI, local dashboards, logged-in docs and UI-bug repros are out of reach. A community plugin pitch frames the gap as 「它回你一句『需要登录』」 (DSH-D#10996) [cc].
2. Three refinements:
   - **Most 查询 need structured reads, not pixels:** API/CLI, then logged-in accessibility text, then a pixel-only remainder [cc]; both vendors rank screen control last. On OSWorld 2.0's long-horizon workflows (median ~1.6 human-hours) the best model evaluated by mid-2026 (Opus 4.8) completes 20.6% (arXiv 2606.29537); short-task benchmarks score far higher (OSWorld-Verified 83.4%, aggregator, not verified) [cl].
   - **CU is a harness capability.** Claude and Codex ship it only in desktop apps or your real browser, not in the SDK, app-server or ACP sessions Orchestra owns (CCD/computer-use.md:203; `OB\unified-computer-use\…\.mcp.json:24-29`) [hc]. DSH is the exception: opt-in experimental CU packages can mount in an owned host; none ships in rc.2 ([dsh-computer-use.md](dsh-computer-use.md)).
   - **Risk sits in the instrument.** Older CUA red-teaming reported 42–98% attack success, mostly on retired models (e.g. arXiv 2505.21936). A 2026 audit found 0/140 multi-step browser attacks succeeded against Sonnet 4.6 and GPT-5.4, but coding skill injection reached 100% (arXiv 2606.05233) [sc]. The sharper failure is D8: an agent driving a browser or desktop where `orchestra.localhost` is logged in *is* you [sc][bc].
3. **Eyes and hands are stage instruments: browsers are many and per-Musician, logged-in profiles are granted by you, the desktop is one and leased.** Orchestra owns isolation, egress, taint, approvals, redaction and cost.
4. Refined claim (inferred): a real bot has a leased, isolated, look-first browser plus a human handoff. Whether owned desktop CU is a v1 requirement is **Q-C1**; the answer moves the schedule.

## Harness capability table

[hc], Windows 11.

| | Claude Code 2.1.310 | Codex (CLI 0.139; app 26.1021) | DSH 0.2.1-rc.2 |
|---|---|---|---|
| Native eyes today | Desktop-app pane, clean profile (`CCD/desktop.md:157`); Claude in Chrome on your real profile (`chrome.md:46,56,100`); CU in the desktop app; CLI CU is macOS-only, not under `-p`, one session (`computer-use.md:11,99-101`) | Desktop app: `@oai/sky` 0.7.13 (SendInput + UIA, activates target windows, `SKY\…\SKILL.md:123`); browser plugin via `node_repl`/`cua_repl` | `web_fetch`; unbundled opt-in packages (`DP\dsh-agent-preset\…\packages.md:43-47,190-200`): browser-use providers; computer use = registry + `cua-driver-mcp`/`cua-driver-native` (any OS) or `dsh-cua` + `cua-macos` (macOS, PTC, per-app consent) |
| In an *owned* Musician | No: the pane is a host `type:"sdk"` server (inferred) | No: needs the app's pipe and env (not verified); spawned tasks lose `node_repl` (CX#49458) | None installed; pin exact 0.2.1-rc.2 (`latest` 0.1.6-alpha.1 breaks boot when listed in `dsh.profile.bundles`). Mountable: playwright-mcp, chrome-devtools-mcp, stagehand; `cua-driver-mcp` (child process: chosen), `cua-driver-native` (in-process: rejected), `cua-macos` (no proxy: not offered); desktop tools are host-global, inherited by subagents, unqueued |
| Orchestra browser MCP attaches via | SDK `mcpServers` | Private `CODEX_HOME` `[mcp_servers.*]` | ACP `session/new{mcpServers}` or a bundle |
| Screenshots reach the model | Inline, 25k-token cap; originals saved under `tool-results` (`mcp.md:435,1526-1532`) | MCP image content | Image-capable model + attachment store only: `deepseek-flash` in the default catalog, or ids declared/listed with image input (`DP\dsh-llm-deepseek\lib\index.js:42-54`, `README.md:53`). The shipped ACP row's `deepseek-v4-flash` is uncatalogued → text-only (`dsh-acp-app\cordis.patch.yml:15-20`); the model gets `content` (text, admitted images), never `structuredContent` (`element_token`, `effect`, `delivery.mode`) (`mcp-client/src/tools.ts:261-263`; DSH-D#7788 open) |
| Click approval | `canUseTool` | `approval_mode="approve"` → `mcpServer/elicitation/request` | No default gate; per call, Auto review (an LLM) or a hooks-claude-code PreToolUse `ask` hook can ask through `approval/request`, and a claude-code-mods `tool.call` hook through User Questions (`packages/experimental/claude-code-mods/src/index.ts:1-11`); none is mounted by default. Requests carry no tool arguments; one-shot grants (`dsh-user-approval\README.md:154-155`). Nothing in the scout composition asks for Cua Driver tools; `cua-macos` asks per app via User Questions, which ACP cannot answer |
| Orchestra observes | `mcp__<srv>__browser_*`. Native-only: `mcp__Claude_Browser__*`, `mcp__claude-in-chrome__*`, `mcp__computer-use__*`, `mcp__remote-devices__computer_*`, `mcp__remote-devices__Claude_Browser__*` | `mcpToolCall{server, tool, readOnlyHint}`, elicitations | `mcp__<server>__*` in the v4 log; also `cua_driver_native__*`, `cua` |

**Where the reports disagree**
- **Native eyes for routing:** [bc] would route to Claude/Codex; [hc] shows their eyes are app- or real-profile-only. We pick [hc].
- **Chrome inside procguard's Job.** [wi] saw Chrome start from a `KILL_ON_JOB_CLOSE` job without UI limits and not start with UI limits `0x41`. But the script checked only its own membership, used `Start-Process` (not Node → playwright-mcp) and killed via `Stop-Process`; and jobs nest only if neither sets UI limits, while Chromium's renderer jobs do (MS Learn, Nested Jobs; `job.cc:36-54`). **Chrome starts; membership, reaping and the renderer sandbox are not verified**, so [cl]'s breakaway concern stays open for S4.
- **Lease broker:** the Governor, not the Post Office [cc].
- **Who gets eyes:** [sc] scouts only vs a per-Musician mode [bc][cc]. Resolved in E6: the mode is the field; only scouts may hold it.
- **DeepSeek images:** budget ≤1,024 tokens (vision guide) [cl]. [cl]'s rejection rule is for Chat Completions; DSH uses `/anthropic/v1/messages` (`dsh-llm-deepseek\README.md:57,83-85`), untested. `--image-responses omit` until tested.

## Instrument model

| Tier | Mechanism | Guarantee | Cannot do |
|---|---|---|---|
| **0: per-Musician browser** (default) | Pinned `@playwright/mcp` over stdio in a per-lease Job; grant profile or `--isolated`; headless; `--remote-debugging-pipe`; `--proxy-server` to the egress filter. playwright-mcp already sandboxes Chromium off Linux (`tools/mcp/config.ts:236-243`); `--sandbox` is belt-and-braces. ~280 MB private each [wi] | Parallel; never takes focus; never your cookies | Native apps; sites refusing headless; one dir twice (exit 21) |
| **1: headed, CDP-only** | Needs a custom driver: stock Playwright's `Target.createTarget` omits `background`, which focuses the target and raises the window (`crBrowser.ts:380`; `Target.pdl:176-178`). Conflicts with unmodified pins, so **not in v1** | No focus stealing only with that driver (inferred) | Rendering minimized (not verified). SendInput/UIA typing needs the foreground; CDP key events do not (verify in S4) |
| **2: desktop lease** | One holder; human-granted; banner; kill switch below. **Driver candidate:** upstream `cua-driver mcp --direct` (MIT) behind `orchestra-desktop`, mountable by any owned harness; window-addressed background calls, exact `background_*` refusals; unvalidated (S-CU) | Exclusion; human kill switch | Parallelism; mediating sky/Claude CU; with cua-driver: foreground delivery, pen-tap clicks (Chromium/Electron other than single-left; WPF/Tk/GTK elements UIA cannot act on; element- or x/y-addressed), typing into Electron/Chromium, full UWP trees at Medium IL (not verified); the Windows-MCP fallback is foreground-only (nonce kill switch). A holder can open a terminal as you, so it counts as a bypass session (spec §10.11 #6) |
| **3: disposable desktop** | Windows Sandbox with a `LogonCommand`-started guest, results via a mapped folder (MaiBot `bridge.py:22-41,139`; `wsb exec -r System` GUI use not verified); Hyper-V VM; WSL2 only hardened (`automount`, `interop`, `appendWindowsPath` off; defaults mount drives read-write and launch Windows processes, MS Learn wsl-config) | Only Sandbox and a VM are default boundaries; output is `provenance:[sandbox]` | One at a time; needs a one-time admin enable; network via the egress filter. **Outside the plan** |

**Grant (new entity).** One SSO login unlocks every app behind the IdP, so a grant is per IdP with explicit origins: `Grant{id, label, loginUrl (typed by you), origins[] (incl. IdP), mode: look|act, profileId, musicians[], expiresAt, createdBy: human}`.
- **Login:** orchestrad opens headed Chrome on the grant profile, outside the Job, no CDP, egress limited to `loginUrl` + IdP, password saving and autofill off. You log in (QR included) and close it.
- **Re-auth:** a redirect to the IdP raises `handoff{reason: reauth, grantId}`, which opens `loginUrl`, never the agent's URL (an injected agent could stage a lookalike login).
- **No storage-state files** (same-user DPAPI does not stop a Musician's shell, inferred). Revoking wipes the profile. Profiles are leased.
- **Presence:** grant profiles and `act` work only while you are present (UI heartbeat) until R05/R06/R07/R21 pass; unattended runs get `look` on public origins.

**Lease:** `Lease{id, instrument: browser-profile:<grantId|musicianId>|desktop|sandbox:<slot>, holder{musicianId, partId}, tier, expiresAt, idleReleaseAt, reason, grantedBy: runtime|human, nonce, state}`

```
requested → awaiting-human (Tier 2/3) → granted | denied | expired→denied | withdrawn
granted → queued → active → releasing → released     (releasing → stuck → kill-job)
queued → foreign-held     (profile locked by a non-Orchestra pid; P2)
active → suspended        (screen lock, input desktop ≠ Default, UI foreground, foreign injector, your absence)
suspended → revoked       (never auto-resumed)
active → draining (≤2 s)  → flush key/button-ups; in-flight writes → unknown-outcome
active → lost             (holder died; on daemon restart every active/draining row, + P1)
```
Tier 2/3 are never re-granted automatically; only you extend a lease.

- **Governor.** The runtime grants Tier 0 against a separate `instruments{maxBrowsers: 6, ramGB}` budget (not `tempo.maxActive`, which would count a browsing Musician twice). Only you grant Tier 2/3 (D8); agents call request-only `orchestra_request_lease` (§8.6).
- **Reaper (Windows).** Chrome's `lockfile` is delete-on-close, so a second launch exits 21 instead of leaving a stale lock [wi]. On 21, find the holder by pid + createTime: ours → kill or queue; foreign → `foreign-held`. `SingletonLock` handling is Linux-only. P0 after 3 failures (OC#79960, Linux).
- **Jobs and kill.** Each browser MCP `command` is `procguard.exe run-in-job --job lease:<id> -- node <pinned playwright-mcp>`, a per-lease Job under the host Job (under the root Job for Claude's in-process SDK). Kill: `browser_close` (2 s) → `kill-job` → `unknown-outcome` for in-flight writes. The UI browser stays protected.
- **Tier 2 kill switch.** Raw Input (`RIDEV_INPUTSINK`) on its own procguard thread detects physical input (`hDevice ≠ NULL`, verify in S4). Low-level hooks are silently removed after `LowLevelHooksTimeout`, so they are only secondary. A foreground driver (Windows-MCP, patched) stamps each SendInput with the lease `nonce` in `dwExtraInfo`; injected input without it → `suspended`, P1. cua-driver cannot stamp one. It injects pen taps (Chromium/Electron clicks other than single-left, and WPF/Tk/GTK element clicks when UIA cannot act; `impl_.rs:3961-3973,4069-4084`), SendInput for foreground delivery and desktop-scope scroll (`keyboard.rs:476,572`; `mouse.rs:639`; `impl_.rs:6355-6392`) and VK_NONAME for foreground activation (`inject.rs:138-146`; `keyboard.rs:613`; `mouse.rs:579`; paths under cua-driver 0.37.0 `rust/crates/platform-windows/src/`). The proxy refuses all of these, admitting only single-left element clicks off WPF/Tk/GTK windows, so any injected input during its lease is foreign → `suspended`, P1, with no in-flight attribution (S-CU checks that Raw Input flags pen as injected). Background leases end on hotkey or absence (no non-synthetic Raw Input for N s, Q-C9; not `GetLastInputInfo`), not on your physical input. `RegisterHotKey` always on.
- **Tier 2 driver.** Ships only if S-CU passes and you pick it (dsh-computer-use.md Q-DC6). Candidate: cua-driver-rs 0.37.0 `mcp --direct` (sigstore + SHA256SUMS + Authenticode, never `install.ps1`), spawned by procguard only during an `active` lease in Job `lease:<id>`, `standard` + per-lease manifest, private `CUA_DRIVER_RS_HOME`, element-addressed background calls only; fallbacks: the newest ≥0.32.0 passing S-CU, then pinned Windows-MCP without PowerShell, Registry or process tools (foreground). An `orchestra-desktop` proxy checks each target (AUMID or exe path + signer, plus pid + createTime; never `ApplicationFrameHost.exe` as an identity, AFH frames resolve to the hosted app) against a per-lease allowlist you grant; terminals, Run, Settings, UAC, password managers, the UI browser and DSH web/Desktop windows are always denied ([sc]).
- **Harness-native CU is observed, never mediated** [sc]. During any lease procguard polls (≤500 ms) for `codex-computer-use.exe`, node with `cua-repl`/`@oai\sky`, `\\.\pipe\codex-computer-use-*`, the Claude Desktop CU helper, `cua-driver*.exe` outside our Jobs, the `cua-driver-serve` task, `\\.\pipe\cua-driver*` and foreign injection. On detection: suspend the owned driver, flush keys, P1, `desktop` pseudo-lease. Native CU you start wins.

## Rules Orchestra enforces

| # | Rule | Enforcer |
|---|---|---|
| E1 | **Isolated profile.** Never `--extension`, `--autoConnect`, Claude in Chrome or Codex `claimTab` for owned Musicians. Owned Claude spawns pass `--no-chrome` (CCD/cli.md:110); each Part start asserts `system/init.tools` has no native-only prefix, else P0 | orchestrad, procguard |
| E2 | **Logged-in state only through a Grant.** Agents never type credentials | you, orchestrad |
| E3 | **Action classes.** Regular: navigate within grant origins, read. Two-phase approval: transmit (submit, upload, typing, select, Enter, drag, any click not provably navigation-only), representational, destructive/financial (incl. `handle_dialog` accept). Handoff, Orchestra's stricter choice: credentials, payment, CAPTCHA (DS-Bot hands off payment, `browser-plugins.js:64-66`; Claude in Chrome pauses at login/CAPTCHA, `chrome.md:11`). Codex `confirmations.md:21-79` is cited for the tiers only (it makes CAPTCHA and financial "always confirm"). Always hidden: `browser_evaluate`, `browser_run_code_unsafe` | proxy (binding); `canUseTool`, `approval_mode` as second layer; DSH pre-execute only via a hooks-claude-code PreToolUse `ask` hook (callId only) |
| E4 | **Egress filter.** Every Tier 0 Chromium uses `--proxy-server` to orchestrad's filter; non-proxied WebRTC UDP and QUIC off. Deny by default; allow grant origins (IDNA-normalised CONNECT host, redirects re-checked: CVE-2025-47241); always deny loopback, LAN, `orchestra.localhost`. `PWM:410-412` lists and Codex `deniedDomains` are defence in depth only | egress filter |
| E5 | **The UI profile** gets no agent extension or CDP. During any Tier 2 lease the UI server rejects every human verb except `revoke-lease` ("approvals frozen"); a `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` watch revokes the lease if the UI browser comes forward | UI server, procguard |
| E6 | **Sticky taint, scouts only.** Navigate, snapshot or screenshot taints the Part (`provenance:[browser:<origin>]`). A new Part starts tainted if its `handoffNote` came from a tainted Part or its Musician holds a grant with mode ≠ off; idle release does not clear it. Clearing needs your evidenced action, or rotation with a runtime-generated structured note plus profile reset. Instruments go only to `kind: scout` (read-only preset, no shell, own host) | orchestrad, proxy |
| E7 | **Images by ref only, never relayed by an agent** (one changed image hijacks agents up to 67%, arXiv 2406.12814) | Post Office, store |
| E8 | **Redaction in the proxy, on the response path**, before the model or any harness log. Images default to `--image-responses omit`; with vision on, secret-matching element boxes are blacked out | proxy |
| E9 | **Retention.** Orchestra store: screenshots 24 h (assumption), snapshots 14 d. Harness stores (Claude `tool-results`, DSH attachments, Codex rollouts) are outside it: vision-enabled Claude Musicians use Q8-B (private config root, short `cleanupPeriodDays`) and Part disposal purges past-TTL files | store, orchestrad |
| E10 | **No browser state:** no reads of profile dirs, `cookies.json`, `*storageState*.json`, `auth.json` or DPAPI; never `--caps storage\|config\|network`; the proxy hides `browser_cookie_*`, `browser_storage_state` (PWM:1233-1386) | fs whitelist, proxy |
| E11 | **Caps:** 8 steps, 2 images per step (`loop.js:39,88`); ≤180 KB (`session.js:511-512`); ≤1,600 px (MaiBot `config.py`); ~20 images per Part-hour (assumption), metered as `imageTokens{estimated}` and reserved by the Governor. Browser MCP attaches only to browsing Parts (~4.8k schema tokens, DSH-D#7080) | proxy, Governor |
| E12 | **Unknown write outcomes are observed, never resent** (`session.js:407-422`) | proxy |
| E13 | **Never answer `always`** to a native grant; pinned, stdio-only MCP (CVE-2025-9611) | orchestrad |
| E14 | **Kill closes the lease's Job**, never your Chrome | procguard |
| E15 | **No sharing.** `hostKey` includes the instrument class; one call in flight per lease; Clones get `off` unless the server sees `parent_tool_use_id`; DSH Clones are indistinguishable, so a DSH desktop host runs one Musician, one Session, no subagents | orchestrad, proxy |

**Two-phase approval.** A write-class call returns `{status: 'approval-pending', approvalId}` at once, so no harness timeout fires (DSH MCP: 60 s). The proxy builds the InboxItem from its own fresh snapshot (URL, frame, role, name, crop); the agent's `element` text is shown as tainted. On re-call with `approvalId` the proxy re-checks digest, URL and frame and executes once. Tier 2 desktop writes never return `approval-pending` while E5 freezes approvals; they follow dsh-computer-use.md Q-DC7 and are refused until it is answered.

## Patterns adopted / rejected

| # | Pattern | Source | Lands |
|---|---|---|---|
| A21 | Wrap playwright-mcp per lease, accessibility tree first | `PWM:3,15`; [cl] | M1/M2 |
| A22 | `orchestra-browser` proxy: classify, two-phase, taint, redact, meter | [cl]; [sc] | M2 |
| A23 | Profile bound to a Grant, leased, surviving rotation | `DSB/…/session.js:1-3` | M2 |
| A24 | Look-up ladder: API → fetch → accessibility text → screenshot → desktop | CCD/computer-use | M4 |
| A25–A27 | Observe-never-resend; `handoff` item (only you end it); nonce confirm for deletes | DS-Bot; MaiBot `bridge.py:187`; OC#75879 | M2 |
| A28 | Images by reference with caps | CC#13480, CX#31040, DSB#560, DSB#578 (open PR) | M2 |
| A29 | Desktop lease revoked by physical input (foreground drivers) or by hotkey and absence (background cua-driver) | [wi]; OC is a counter-example: run-scoped, "no lease, expiry" (`docs/nodes/computer-use.md:76,287`) | M4 |
| A30 | Disposable desktop slot | MaiBot; [wi] | outside plan |

**Rejected:** an Orchestra CUA loop and pixel-first agents (Skyvern is AGPL); Claude/Codex vendor CU in owned Musicians; DSH's provider registries as a lease or multi-Musician design (one name per Cordis service instance, `docs/subsystems/browser-use.md:17-23`, `packages/computer-use/computer-use/src/index.ts:35-45`; DSH rejected a Session ownership broker, `2026-09-12-computer-use-provider-registration.md:29`; browser-use's unqueued hold rejects other Sessions, DSH-D#7007, #7169 on 0.1.6-alpha.2, #9688, so the Lease queues); the in-process native Cua Driver provider; Codex confirmation docs as a gate; storage-state handover; default-config WSL2 as a boundary; "use whenever useful" browsing and sticky auto-approve lists [bc]; unattended logged-in browsing [sc]; hosted browsers, Lightpanda; virtual-desktop switching, SendInput- or pen-based "background" (window-addressed UIA/PostMessage with exact refusals is allowed), RDP-to-self, Job UI limits [wi].

## Community findings → requirements delta

**Confirmed** [cc]: R05 leaked Playwright processes (CX#17832, macOS, 13.6 GB); R06 agents "fight for the same tabs" (CC#15193; DSH-D#10229); R07 209 looped calls (OC#138999); R10 approvals that never surface (CX#37180, CC#103373).

**Not a community-reported complaint:** no swept thread says a bot without CU "isn't a real bot". That does not settle Q-C1, which is yours.

| ID | Requirement | Pri | Evidence |
|---|---|---|---|
| R42 | Instrument leases with the full state table | P0 | CC#15193, CC#39558, DSH-D#7857 (0.1.7-rc.2) |
| R43 | Instruments only on scouts; tainted Parts act only via two-phase approval (browser) or the dsh-computer-use.md Q-DC7 route (desktop) | P0 | DSB#32, CX#24433 |
| R44 | Grants, isolated profiles, egress filter; UI frozen during Tier 2 | P0 | [sc] B5/B6 |
| R45 | Element-bound approvals in the proxy | P0 for act | Codex `confirmations.md`; Operator card p.8 |
| R46–R48 | Look-up ladder; images by reference; `handoff` kind | P1 | CX#49458, CC#13480, OC#75879 |
| R49 | Reaper covers browsers and exit-21 holders | P1 | CX#17832, OC#79960 (Linux) |
| R50 | Image-token and tool-schema metering | P1 | DSH-D#7080 |
| R51 | Disposable desktop | P2 | MaiBot |

## Spec amendments

- **§3.2** "Orchestra captures your desktop only during a Tier 2 lease you grant, per window, for allowlisted apps; otherwise Musicians capture only isolated browsers." Keep no unattended autonomy in v1.
- **§5.4** Per-lease browser Jobs; S4 launches through playwright-mcp under procguard, runs `IsProcessInJob` on every chrome.exe, closes the job and counts survivors, reads `chrome://sandbox`.
- **§6.1** `Grant`, `Lease`; Musician `instruments{browser: off|look|act, desktop: none|lease, grantIds}`, kind `scout`; Part `taintSticky`, `leaseId`; `hostKey` + instrument class; LedgerEntry `imageTokens{estimated}`.
- **§6.5** Kinds `lease-request` (P1), `lease-expired` (P2), `handoff` (P1); approvals gain `actionClass` (A5's key, so denials escalate per root) and `elementDigest`.
- **§8.1 / §8.6** Taint per E6; provenance `browser:`, `screen:`, `sandbox`; refs `shot:<id>`; request-only `orchestra_request_lease`.
- **§10** E3–E5, E13–E15; Tier 2 holders count as bypass sessions; E11 caps, 6 browsers × ~0.4 GB, Tier 2 lease 5 min (assumptions).
- **§4 / §12** D17 instruments; D18 isolated-profile default. Apache-2.0 playwright tools pinned, unmodified; Windows-MCP MIT; AGPL tools unused; `@oai/sky` rights (not verified).
- **§13** Re-staged (inferred): M0 S4 Chrome-in-Job (+0.5 d). **M1 (+3–4 d): look-only Tier 0 for Claude Musicians**, public origins, egress allowlist, `canUseTool` denies non-read tools. M2 (+3 weeks): grants, egress filter, two-phase `act`, redaction, per-lease Jobs. M3: DSH `act`. If Q-C5 = Tier 2: S-CU at M2 end (+2–3 d); M3 Tier 2 `look` (+1.5–2 weeks; needs S2 go and Q-C8, or a Claude host). M4: Codex; Tier 2 `act` (+1 week) only if S-CU shows enough deliverable writes. Tier 3 outside the plan. Total ≈ 33–35.5 weeks with Tier 2 (≈ 30–32 without) plus the 4–6-week Arrangement (inferred).

## Acceptance tests (zero-token CI)

Fake browser MCP with recorded fixtures.
1. Two Musicians get two dirs; a held profile queues.
2. Configs never contain `--extension`, `--autoConnect`, `--no-sandbox`, `--caps storage|config|network`, a default profile or Job UI limits; owned Claude spawns carry `--no-chrome`.
3. Egress denies `orchestra.localhost`, `user@orchestra.localhost`, redirects into it, loopback, LAN and unlisted origins.
4. A snapshot taints the Part; taint survives compaction, idle release and a model-written rotation note.
5. Navigate creates no item; typing into a password field creates a `handoff`; `browser_evaluate` is absent.
6. Snapshot → click → `approval-pending`; unapproved nothing runs; approved, once; a changed digest voids it.
7. A 4K PNG becomes a ref ≤1,600 px; no `data:image` in an Exchange, the journal or a replay.
8. An `sk-ant-…` string is redacted before the model sees it; screenshots purge at TTL.
9. A 9th step pauses the turn; five identical URL + snapshot hashes raise P0; the 21st image in a Part-hour is refused.
10. An agent creates only a `lease-request`; an MCP grant is refused; expiry → `draining`, `lease-expired`, input stops.
11. A brake kills the lease Job; the UI browser survives.
12. A lost write response becomes `unknown-outcome`, 0 replays.
13. Exit 21 with our holder kills or queues once; a foreign holder → `foreign-held`; 3 failures → P0.
14. Observed `mcp__computer-use__*` and `mcp__remote-devices__*`, plus `mcp__cua-driver-mcp__*`, `cua_driver_native__*` or `cua` outside desktop hosts, raise a banner and pseudo-lease; native CU during an owned lease suspends it.
15. An owned Codex elicitation never selects "always".
16. During a lease the UI comes forward and posts approve → 409, lease revoked.
17. Kill mid-drag flushes button-up (foreground drivers); kill mid-Invoke leaves the target enabled and activatable (cua-driver); lock → `suspended`; restart → `lost` + P1; parallel Task subagents are serialised; DSH subagents get no desktop tools; during a cua-driver lease, physical input does not revoke it while the hotkey and absence do.

## Risks

- **Prompt injection is not solvable outside the model:** 1.4% (Opus 4.5) to 2.4% (Haiku 4.5) for Claude for Chrome with Anthropic's safeguards (Anthropic, 2025-11-24) [sc]; no comparable figure for DeepSeek or Codex. Mitigation: scouts, taint, egress, two-phase `act`.
- **An agent clicks Approve in your browser** (D8). Mitigation: E5.
- **Leaked browsers** (CX#17832 macOS, OC#79960 Linux). Mitigation: Jobs, reaper.
- **Unverified on Windows:** Job membership and renderer sandbox; Raw Input `hDevice`; CDP typing when minimized; DPI-scaled crops (OC#158011); Electron screenshot crashes (DS-Bot plan :29).
- **URLs leave the machine (verified):** Codex's browser plugin sends each checked URL (path and query) plus conversation and turn ids to OpenAI's `/aura/site_status` (`browser-service.mjs:1052,1141`). Observed Codex sessions are not local-only (§3.1).

## Open questions for the user

- **Q-C1** Does "real bot" mean a leased isolated browser plus handoff (look-ups from M1, `act` in M2), or must owned Musicians drive your desktop (Tier 2: S-CU at M2 end, `look` M3, `act` M4 if S-CU allows; isolated desktops are outside the plan)?
- **Q-C5** Desktop CU for owned Musicians: Tier 2 via `orchestra-desktop` + cua-driver (host harness per dsh-computer-use.md Q-DC0), Tier 3 only, or never?
- **Q-C2** Will you run the UI in a dedicated profile? Do `--chrome` and CU sessions count as "equivalent to you"?
- **Q-C3** Scouts-only instruments, and look-only Tier 0 in M1?
- **Q-C4** Which IdPs and origins go in the first grants, and for how long?
- **Q-C7** DSH Musicians read-only (look-ups routed to Claude), or allow DSH scouts, including desktop scouts if dsh-computer-use.md Q-DC0 picks DSH?
- **Q-C8** DSH eyes need `deepseek-flash`: switch scouts to it and keep other DSH Musicians on text-only `deepseek-v4-flash`?
- **Q-C9** Tier 2 kill switch: Raw Input plus nonce for foreground drivers, hotkey plus presence for background cua-driver?

## Review log

**Accepted (facts, re-checked against the cited source):** all 23 facts-lens issues on this file, notably 2606.05233 (0/140), the [wi] Job result (`injob.ps1` checks only itself), exit 21 instead of `SingletonLock`, Tier 1 (`crBrowser.ts:380`), WSL2, DSH-D#10996 (a plugin pitch), playwright-mcp's Windows sandbox (`config.ts:236-243`), MaiBot LogonCommand, Codex's taxonomy, DSH models and approvals, and site_status (`browser-service.mjs:1052`).

**Accepted (design):** all 21 issues, in condensed form (E5, Grant, E4, E6, E15, lease table, kill switch, Tier 2 driver, Jobs, E9, E11, §13, §3.2).

**Rejected / partial:** edits to `cu-cua-landscape.md` and `cu-community-cu.md` (raw files out of scope; noted under Evidence keys instead); `--start-minimized` (Tier 1 is out of v1); Haiku 2.4%, `browser-use.md:17-23` and the WSL defaults rest on the reviewers' checks, not re-fetched.

**Uncertain:** renderer jobs under procguard; Raw Input `hDevice` for injected input; whether Codex-spawned MCP servers sit in Codex's sandbox; `--chrome` under the SDK; schedule figures.

**Errata 2026-10-26 (dsh-computer-use):** 19 errata from [dsh-computer-use.md](dsh-computer-use.md), corrected by two red-team reviews before application, changed lines 7, 18, 29, 30, 32-34, 49, 74-76, 84, 96, 113, 141, 159, 162 and 174-181. They add DSH's opt-in CU packages and exact-pin advice to the capability table, and say that per-call `ask` comes from Auto review or a hooks-claude-code PreToolUse hook, neither mounted by default. They name upstream `cua-driver mcp --direct` behind `orchestra-desktop` as the Tier 2 driver candidate. That entry covers sigstore + SHA256SUMS + Authenticode, `standard` + manifest, element-addressed background calls, AUMID or signer identity and an `ApplicationFrameHost.exe` exclusion. The kill switch is split by driver: a nonce for foreground drivers, a hotkey plus presence for cua-driver, since cua-driver's pen and VK_NONAME routes are refused. E15 now applies one Musician, one Session and no subagents per DSH desktop host. The DSH slot rejection is re-sourced, since D#7007/#7169/#9688 are browser-use reports. The pen-based "background" is rejected. §13 is conditional on Q-C5 (≈ 33–35.5 weeks, inferred), test 17 adds window repair after a kill, and Q-C1, Q-C5 and Q-C7–Q-C9 are reworded. None was left unapplied.

**Post-fix review 2026-10-26 (dsh-computer-use):** a facts, coherence and design re-check of the errata against the cua-driver 0.37.0 and DSH sources changed lines 7 (evidence key), 33 (claude-code-mods can also ask), 49 (Tier 2 gaps are cua-driver's; pen taps are chosen by input stack, not addressing), 64 (absence suspends), 74 (cua-driver also injects pen from element clicks and SendInput in foreground paths; all refused, no in-flight attribution; absence defined), 75 (Q-DC6; AFH frames resolve to the hosted app), 91 (escaped pipes), 98 (desktop writes follow Q-DC7, not `approval-pending`), 110 (A29), 113 (registry citation), 124 (R43), 141 (totals with and without Tier 2), 162 (test 17), 175 and 179 (Q-D renamed Q-DC). The errata entry above also changed 174-175 and 179-181 (not 176-178) and added lines 192-193.
