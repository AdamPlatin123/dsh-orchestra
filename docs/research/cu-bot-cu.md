<!-- Raw researcher report: Opus sweep "bot-cu", 2026-10-26. Unedited. Pre-review; synthesized into computer-use.md, which wins where the two disagree. -->

## Identity & scope

This covers how persistent-bot frameworks gave their bots a browser or desktop as of 2026-10-26, and what went wrong. I checked OpenClaw, Grok Bot (grok-build plus the 0.18 reconstruction), DS-Bot (local), the DSH upstream catalog, MaiBot, AstrBot, Paperclip, Letta / letta-code, NanoClaw, ZeroClaw, nanobot, LangBot, OpenAI Operator / ChatGPT agent, and the bundled Codex browser plugin (local). Star counts were read on 2026-10-26 with `gh api repos/...`:

| Repo | Stars |
|---|---|
| openclaw | 393,156 |
| grok-build | 27,557 |
| grok-bot-0.18-reconstructed | 3,537 |
| paperclip | 107,640 |
| nanobot | 49,414 |
| AstrBot | 43,815 |
| zeroclaw | 33,050 |
| nanoclaw | 31,024 |
| letta | 25,262 |
| LangBot | 18,504 |
| MaiBot | 6,610 |
| letta-code | 3,711 |

Citation shorthand:
- `OC/` = github.com/openclaw/openclaw @ `a1b840f7`
- `GB/` = github.com/xai-org/grok-build @ `2bdd1d6a6`
- `DSB/` = G:\_Projects\DS-Bot\ds-bot (main `de55888`, 2026-10-26). The browser code is upstream Fei2411 work: commits `fc78999` 10-21, `23330c3` 10-23, `b6c9629` 10-23.
- `DSBP/` = G:\_Projects\DS-Bot\docs\plans

## Facts

**DS-Bot (local; it does have eyes and hands, contrary to what one might assume)**
- **Two layers.**
  - (a) In Desktop/app builds, every Bot gets a read-only `read_browser` tool. It reads a DOM-to-Markdown snapshot of that Bot's own Electron webview partition `bot:<id>`, with `[#n]` refs, 12k-character parts and at most 80 items (`DSB/src/host/browser.js:1-17,258`; `DSB/README.md:141-157`).
  - (b) An opt-in team-wide `browserPlugin` = `refs` | `script` | `task` drives Playwright Chromium (`DSB/src/host/browser-plugins.js:112-150`; `DSBP/2026-10-21-browser-plugins.md:17-34`). It is off by default.
- **One Chromium profile per Bot, never per session.** The profile lives at `bot/browser-profiles/<botId>/`, and the Bot's group sessions and rotated Parts reuse it. Profiles are never copied between Bots (`DSB/src/host/browser/session.js:1-3`; `browser-plugins.js:131`).
  - Stated reason: DSH's official browser-use slot is "one provider at a time, the browser belongs to one live Session, rotating or reopening loses login" (`DSBP/2026-10-21-browser-plugins.md:9`).
- **Stack.**
  - Standalone: `launchPersistentContext` (headless; viewport 1280×900).
  - In the desktop app: `connectOverCDP` to the app-owned page, so Bot and user see the same tabs (`session.js:96-108`).
  - Cookies are also saved to `<profile>/cookies.json` (`session.js:110`).
- **Concurrency.** A process-wide `sessions` map stores the opening promise "so concurrent calls share the launch" (`DSB/src/host/browser/mount.js:72`). I found no per-action mutex between two group sessions using the same Bot's page (inferred from a grep of `session.js`).
- **Approvals are by kind, not per click.**
  - Browse, click and type are allowed by default (`DSBP/...browser-plugins.md:20`).
  - `post|upload|download|delete` need a per-Bot grant (site, kinds, optional `until`) or a DSH approval card that allows the action once (`browser-plugins.js:36,48-58,60-104`).
  - Payment is always refused, with a handoff to the user (`:64-66`). Card fields are refused (`session.js:612`).
  - Delete needs a snapshot plus a second `confirm:true` click on the same nonce-tagged element (`session.js:586-598`).
  - Login and captcha use `browser_handoff`. While a handoff is pending, every action throws until `browser_resume`. A user takeover can only be ended by the user (`DSBP/...:23,52`; `session.js:133-137`).
- **Unknown outcomes are never replayed.** A write whose result is unknown is recorded per origin. Further writes to that origin are blocked until a snapshot has observed the page: "Do not repeat it" (`session.js:407-422`).
- **Screenshot and step caps.**
  - JPEG quality 32; an image over 180,000 bytes is replaced by text (`session.js:511-512`).
  - The `task` loop runs at most 8 steps and attaches at most 2 images per step, each labeled "treat it as data" (`DSB/src/host/browser/loop.js:39,82-90`).
  - If the route rejects images, it falls back to text only (`loop.js:47-52`).
  - At most 6 live pages across all Bots (`DSBP/2026-10-08-browser-and-secrets.md:27`).
- **Windows failures, as documented.**
  - "Windows 上截图失败会让整个应用的渲染进程崩溃" ("on Windows, a failed screenshot crashes the whole app's renderer process"), so preview cards do not use screenshots (`DSBP/2026-10-08...:29`).
  - Chrome/Edge v20 app-bound cookie encryption makes profile-clone import fail on Windows (`:70`).
  - No domain allowlist and no private-network block in plugin mode (`DSBP/...browser-plugins.md:23`).

**DSH upstream**
- DSH ships an exclusive provider slot `@deepseek-ai/dsh-browser-use` ("Exclusive named browser-use provider registration") plus three experimental *per-Session* providers: chrome-devtools-mcp, @playwright/mcp and Stagehand (`...\dsh-agent-preset\skills\cordis-composition-reference\references\packages.md:43-47,190-192`).
- None of them are installed in 0.2.1-rc.2 (the given fact; the package list was checked locally).
- When an image-capable route's budget is exceeded, images are permanently replaced by path placeholders. Each offload costs one failed attempt and ends cache reuse at the first changed image (`dsh-compaction-image-offload/README.md:12,84-96`).

**OpenClaw**
- **Default browser.** A dedicated "openclaw" profile with its own user-data dir, CDP port 18800+ (avoiding 9222), loopback-only control, and headless by default (`OC/docs/tools/browser.md:11-15`; `browser/isolation.md:10-20`; `browser/configuration.md:41-46,242`).
  - The `user` profile attaches to your real Chrome through Chrome DevTools MCP and needs someone at the desk to accept "Allow remote debugging?".
  - The `chrome` extension profile works with nobody present (`browser/profiles.md:10-26`).
  - Security doc: "Chrome MCP existing-session mode is not 'safer'" (`OC/docs/gateway/security/browser-control.md:21`).
- **One `browser` tool.** Snapshots are AI/ARIA trees with refs; `act` works by ref; screenshots are a separate action. `navigate` returns a compact snapshot inline. `text` is capped at 40,000 characters (`browser/agent-tools.md:10-37`).
- **Tab ownership.**
  - Tab ownership is per session and agent-qualified, stored in SQLite, swept when idle, closed on `/new` (`configuration.md:83-112`).
  - Managed Chrome has a best-effort cap of 8 page tabs (`:97-99`).
  - A screenshot timeout locks that tab until recovery (`agent-tools.md:38-41`).
- **Screenshots and context.**
  - For text-only models, a screenshot is described by an image model and wrapped in `wrapExternalContent` (`configuration.md:129-167`).
  - Screenshots are "private tool results", never auto-sent to chat. This was a fix for **#44759** (2026-03-13): screenshots were being auto-delivered to group chats.
- **Desktop computer use.**
  - One `computer` tool for the Gateway's own desktop or a paired node (`OC/docs/nodes/computer-use.md:11-30`).
  - Coordinate actions must echo the screenshot's `frameId` and display identity (`:78`).
  - A frame identical to the last one returns "screen unchanged" metadata only (`:103`).
  - Control "belongs to the admitted agent run and is released when that run ends" (`:76`).
  - Windows uses the experimental `cua-computer` SDK; the driver runs "unrestricted mode with approvals bypassed", with authorization done above it (`:21,116-118`).
  - "There is no lease, expiry, or arm/disarm" and "no per-action confirmation" (`:287,300`).
- **Approval-panel guard.** OpenClaw hides its own macOS approval panels from screenshots and refuses native input while an approval is pending. It says this does not cover browser automation or third-party drivers, and is "hardening, not an isolation boundary" (`:295-299`).
- **Login.** Manual login in the managed profile is recommended because "automated logins often trigger anti-bot defenses and can lock the account" (`OC/docs/tools/browser-login.md:9-19`).
- **Sandboxing.** A sandboxed browser exists only on the Docker backend, as a separate container (`OC/docs/gateway/sandboxing/supported-capability-matrix.md:19`).
- **Lobster** is "typed pipelines and resumable approvals" (`OC/docs/plugins/reference/lobster.md:13`). I found no browser-specific halting in it.
- **2026 advisories** (`gh api .../security-advisories`, newest 100, 2026-06-30 to 09-11):
  - GHSA-3x84-qq85-fj65: CDP discovery accepted blocked WebSocket URLs (high).
  - GHSA-p3h6-v2h4-36q2: CDP connections discarded DNS pinning (high).
  - GHSA-9x88-f7rh-4c83: browser node targets bypassed sandbox host control (high).
  - GHSA-jghr-xp78-995p: browser proxy missed its admin scope (high).
  - GHSA-pjjr-5qhr-5w6r: Codex computer-use install could omit owner authorization (high).
  - GHSA-4g58-43jr-6738: wait predicates could reach blocked destinations.
  - GHSA-m78m-7h3q-q938: relay auth exhausted pending capacity.
- **Documented failures (issues):**
  - **#43290**: concurrent sessions launched a second Chromium on the same profile, got a SingletonLock abort, and the typing indicator hung.
  - **#79960**: a stale SingletonLock plus retries every ~12 s with no backoff produced 397 spawns in 6 h, 2.5 GB RSS, a host OOM and a reboot.
  - **#176236** (open): a lock naming an old hostname blocks the profile.
  - **#59333**: a CDP disconnect caused a gateway SIGTERM, which caused a resume-and-retry crash loop.
  - **#106703**: a failed vision fallback left raw base64 in history for 3 turns and the session became "unusable".
  - **#138999**: 209 looped browser calls, then reopening the session relaunched the browser for a dead tab and left an orphan window.
  - **#105357**: screenshots force `Page.bringToFront`, stealing focus on headed browsers.
  - **#158011** (Windows 11 26200): `screen.snapshot` captures only the top-left region when display scaling is above 100%.

**Grok Bot / grok-build**
- `GROK_BOT_TOOL_IDS` contains only messaging and transcript tools (`bot_create_agent`, `bot_send_prompt`, `bot_await_turn`, …), with no browser or screenshot tool (`GB/crates/common/xai-computer-hub-core/src/bot_tools.rs:9-22`).
- The plan agent injects a rule: "A single render screenshot of the changed screen is NOT verification". With no browser tools, the agent falls back to tests or curl and says what went unverified (`GB/crates/codegen/xai-grok-agent/src/prompt/browser_verification.rs:5-17`).
- Tool-layer images are dropped on text-only harnesses, leaving placeholders (`GB/.../acp_session_impl/tool_layer_images.rs:46-55`).
- **Grok Bot 0.18 (reconstruction, no license; design reference only).** Each bot gets a remote "Grok Bot's Computer" ("forever box") streamed over VNC in a webview.
  - Per-subagent monitors `{subagentId, vncUrl, handoff}`.
  - Handoff = `{requestId, instruction, snapshotDataUrl}` with "I'm done, continue" / "Skip this step".
  - `VNC_CRASH_LIMIT` 3 per 60 s; `DIRECT_MONITOR_LIMIT` 3.
  - Sources: `b-nnett/grok-bot-0.18-reconstructed/frontend/src/recovered/features/computer/shell/model.ts:3-45`; `frontend/manifests/computer-shell-evidence.json`.

**MaiBot** (commit `29ea49088` "麦麦电脑", 2026-10-20)
- Desktop control runs inside **Windows Sandbox** (`wsb.exe`) with clipboard, audio, video and printer disabled and 4096 MB RAM. Three mapped folders: bootstrap read-only, exchange and workspace read-write.
- The guest drives SendInput and UIA plus CDP to an Edge instance *inside* the sandbox: "No host input automation is used" (`Mai-with-u/MaiBot/src/computer/bridge.py:22-44`; `guest.ps1:1,213-217`).
- Batch actions are schema-validated in full before any input is sent (`src/computer/actions.py:41-42`).
- One pending operation at a time. A timeout is "未重放操作" (not replayed): the agent must call `computer_poll` (`bridge.py:187,252-256`).
- Defaults: `computer_tools=False`, `networking=True`, `screenshot_max_edge=1600`, JPEG quality 90 (`src/agent/config.py:43-58`; `guest.ps1:136-147`).

**AstrBot**
- A `ComputerBooter` per session (`session_booter[session_id]`), backed by local, Shipyard (default `shipyard_neo`), BoxLite or CUA sandboxes (`astrbot/core/computer/computer_client.py:22-23,553-569`).
- The CUA booter boots a Linux image with TTL 3600 and an idle cleanup; screenshots are returned as base64 PNG (`booters/cua_defaults.py:1-9`; `booters/cua.py:651-661`).

**Paperclip**
- Browsing is delegated to the hosted Browser Use Cloud, reviewed as `browser_start|status|continue|cancel|end` ("destructive-capable") and run under the normal approval policy (`paperclipai/paperclip/doc/connections/BROWSER-USE.md:26-46`).
- The API key stays in a vault. Agents never see CDP, viewer URLs or browser IDs (`:41-43,128-153`).
- A per-run cost cap is the minimum of the request, grant and remaining budgets (`:139-143`).
- A lost paid-create response "is never submitted again automatically"; a reconciler searches for an invocation marker (`:111-113,376-386`).
- Viewer sizing uses a 20 s lease (`:100-104`).
- Passkeys do not forward (`:365-374`).

**Letta, NanoClaw, ZeroClaw, nanobot, LangBot**
- **letta-code:** a built-in `browser-use` skill over raw CDP. Dedicated profile; "Never attach to the user's normal profile unless explicitly asked"; headed when a display exists, so the user can watch or take over (`letta-ai/letta-code/src/skills/builtin/browser-use/SKILL.md:6-57`).
- **Letta core:** no browser tool in the tree (inferred from the path listing).
- **NanoClaw:** `agent-browser` CLI inside a `--rm` container with a per-spawn HOME. Login persists through `state save/load auth.json`.
  - Skill text: "Use whenever a browser would be useful, not just when the user explicitly asks" and "Retrying the same unbounded wait is what causes the hang" (`qwibitai/nanoclaw/container/skills/agent-browser/SKILL.md:3,125-128,139-152`; `container/agent-runner/src/browser-trust.ts:1-6`).
- **ZeroClaw:** browser automation is opt-in, and each call goes through approval unless a risk profile lists it in `auto_approve`. Upgrades may leave a stale `"browser"` entry that silently suppresses prompts. `allowed_domains` defaults to `["*"]` (`zeroclaw-labs/zeroclaw/docs/book/src/tools/browser.md:52-56`).
- **nanobot:** no browser tool; `agent/tools/` has only web and MCP (path listing). It does have `_windows_job.py` and a credential-safe Windows browser handoff for login (`nanobot/cli/windows_browser.py:1-7`).
- **LangBot:** its bot runtime has a code "box" but no browser in `src/` (path listing). Its developer skills prefer "Codex Computer Use, Claude Computer Use" over Playwright MCP (`skills/skills/langbot-env-setup/references/browser-access-selection.md:5-15`).

**OpenAI Operator / ChatGPT agent** (Operator System Card, 2025-01-23; possibly stale)
- Pixel-only CUA failed at OCR of API keys and wallet addresses, and looped "trying to fix" visual edits in nano and VS Code (pp. 4-5).
- 13 of 100 unmitigated tasks had errors, 5 of them irreversible. Confirmations cut the risk by about 90%, with 92% confirmation recall over 607 tasks (p. 8).
- Watch mode pauses when the user is inactive on sensitive sites (p. 10).
- Prompt-injection susceptibility fell from 62% to 23%. The injection monitor reached 99% recall and 90% precision, with 46 false flags out of 13,704 benign screens (pp. 10-11).
- OSWorld score 38.1% (p. 12).
- The 2026 status of ChatGPT agent (one guide claims it was retired in August 2026) is **not verified**: help.openai.com and openai.com returned 403.

**Codex bundled browser plugin (local, 26.1021.31345)**
- Three confirmation tiers: hand-off required (password change, safety-interstitial bypass); always confirm at action time even if pre-approved (delete, permissions, CAPTCHA, installing software); and the rest (`C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\docs\confirmations.md:20-40`).
- "Typing sensitive data into a form counts as transmission" (`:14-17`).
- Tab claiming compares title and URL against a snapshot "to fail closed if a numeric browser tab id was reused" (`docs/tab-claiming-chrome.md`).

**Chromium and Job Objects**
- Chromium: "Each renderer runs in its own Job object", with a one-active-process limit (chromium.googlesource.com `docs/design/sandbox.md`, "The Job Object").
- An agent Chromium launched under procguard's nested job therefore needs nested-job support (Windows 8 and later) and must not inherit outer UI or active-process limits (inferred; not tested).

## Patterns for Orchestra

**Adopt**
1. **Eyes belong to the Musician's identity, not its session** (§3.1-3, §6.1).
   - Add `capabilities.browser = none|dom-read|drive|desktop` and `browserProfile` to Musician. The profile survives Part rotation (DS-Bot `session.js:1-3`).
   - Never use DSH's per-Session experimental providers for bots (`packages.md:190-192`; `DSBP:9`).
2. **Route look-ups to Musicians that have eyes** instead of building a browser into Orchestra (§3.2 "不做新的 agent loop" (no new agent loop), §9.2 candidates, R19 QA Musician).
   - Claude (built-in pane / Chrome) and Codex (sky + browser plugin) have eyes; owned DSH does not, until an upstream provider exists (inferred).
3. **DOM/accessibility snapshot first, pixels second** (§10.12 budgets). Evidence: DS-Bot `read_browser`, OpenClaw refs, sky `get_window_state`, Operator OCR failures pp. 4-5.
4. **Classify browser actions by kind** (read / post / upload / download / delete / payment / login), with per-site grants that carry an expiry.
   - Payment and password changes are always handed off.
   - Delete gets a two-step nonce confirm.
   - These feed the same human-only queue (§10.9, D8). Sources: `browser-plugins.js:36-104`; Codex `confirmations.md`.
5. **Unknown result → observe, never resend** (§3.1-8, §8.3). Write the browser-action outcome as `unknown-outcome` in the InboxItem (§6.1). Sources: `session.js:407-422`; MaiBot `bridge.py:187`; Paperclip `:376-386`.
6. **One-holder lease per browser profile or desktop**, keyed by Musician, with launch-promise sharing (§10.2 governor, §5.4).
   - Desktop control is held by one run and released at run end (OC `computer-use.md:76`).
   - Queue the second requester rather than failing it (§3.1-4).
7. **Taint every browser observation** (§8.5). Add `browser-page` and `screen` to the provenance list. Wrap described screenshots as external content (OC `configuration.md:163`).
8. **Screenshots are model-only.** Never forward them to Rooms, the inbox or exports; snippets are text-only (§6.1 redaction, §11.2 peek). Lesson of OC #44759.
9. **Runaway signals for browsers** (§10.3):
   - The same URL plus snapshot hash, or "screen unchanged", repeated counts as a near-duplicate.
   - Cap steps (DS-Bot 8), images per step (2), live pages (6 to 8), and screenshot bytes or long edge (180 KB / 1600 px).
   - Treat image offload as a cache-breaking cost event in the Ledger (§11.5; DSH offload README:88-96).
10. **Reaper owns stale profile locks** (§10.4, §5.4):
    - Agent Chromium goes *inside* the host job, so it dies with the host.
    - On restart, check `SingletonLock` against the PID plus creation time.
    - Retry with backoff and a cap, then raise P0 instead of looping (OC #79960, #43290).
11. **Handoff as a first-class InboxItem `kind:handoff`** (Fermatas, §11.2): reason, URL, snapshot, and "done / skip" buttons. A user takeover can only be ended by the user (DS-Bot; Grok Bot `ComputerHandoff`).

**Avoid**
1. **Attaching agents to your real signed-in browser** (§10.11).
   - Claude in Chrome, OpenClaw `user`/`chrome` profiles and Codex tab claiming all act with your cookies.
   - Concretely, an agent in your real Chrome can open `orchestra.localhost`, which already holds the pairing cookie and a matching Origin, and click Approve. That breaks D8 (inferred).
   - Mitigation: serve the Orchestra UI in a browser profile that no agent extension or CDP ever attaches to. Count `--chrome` / computer-use-enabled sessions next to bypass sessions as "capability-equivalent to you" (§10.9 policy, §10.11-6).
2. **Unrestricted desktop control on the host desktop** (§10.8). It has no per-action confirmation (OC `computer-use.md:287,300`). Codex sky on Windows activates target windows automatically (given fact), so an agent can foreground any window, including Orchestra's. If desktop control is needed, prefer MaiBot-style Windows Sandbox isolation.
3. **Screenshotting inside Orchestra's own UI** (§3.2 "不抓取屏幕内容" (no screen-content capture)). It risks Windows renderer crashes (`DSBP/2026-10-08:29`), DPI-scaling crops (OC #158011) and focus theft (OC #105357).
4. **Reading browser profile directories.** Add `**/browser-profiles/**`, `cookies.json`, `*storageState*.json` and `auth.json`-style state files to the default-deny fs wrapper (§10.11 read allow-list). DS-Bot writes cookies in plaintext JSON (`session.js:110`).
5. **Auto-approve lists that survive upgrades** (§10.10 desired vs applied). ZeroClaw's leftover `"browser"` entry silently suppressed prompts (`browser.md:54`).
6. **"Use whenever useful" browser defaults** (NanoClaw). They multiply token cost and taint. Keep browsing opt-in per Musician (§10.2).

## Verdict on the user's claim

The claim is half supported: being able to look things up behind a login matters, but it does not decide what a bot is.

- **For the claim:** by October 2026 almost every serious persistent-bot framework had shipped eyes and hands. OpenClaw, Grok Bot (a cloud computer per bot), DS-Bot (10-21 to 10-24), MaiBot (10-20), AstrBot, Paperclip, letta-code, NanoClaw and ZeroClaw all did. A bot that cannot read a CI page or a dashboard behind a login really is weaker at look-ups.
- **Against it:**
  - Most ship it **off by default** and gated: DS-Bot `browserPlugin` unset, MaiBot `computer_tools=False`, ZeroClaw opt-in, OpenClaw `cua-computer` needs explicit enabling.
  - Well-regarded bots exist without it: nanobot, LangBot's runtime, and grok-build, whose bot tool list is messaging only.
  - The work that succeeds is mostly DOM/accessibility snapshots, not pixels. Most documented failures come from the pixel/desktop path and from sharing profiles: lock storms, crash loops, leaked screenshots, base64 contamination, OCR errors.
- **Conclusion for Orchestra:** eyes should be a per-Musician capability with a profile tied to the bot's identity, a one-holder lease and approvals by action kind. They should be routed to harnesses that already have them (Claude, Codex), not made Orchestra's definition of a bot. The biggest new risk is that an agent with eyes on your real browser or desktop can click Orchestra's own Approve button.

## Open questions

1. Will you accept "the Orchestra UI runs in a browser profile no agent is attached to" as a D8 requirement? Do sessions with computer use or `--chrome` count toward the "equivalent to you" tally?
2. Should an owned DSH Musician get eyes at all before upstream `dsh-browser-use` stabilizes? Or should look-ups always route to Claude or Codex Musicians?
3. Should desktop computer use on the host be refused outright for owned Musicians, with Windows Sandbox (MaiBot) as the only allowed path?
4. Will procguard's nested Job limits stay compatible with Chromium's per-renderer jobs? This is untested and needs an S-spike.
5. ChatGPT agent's 2026 status and controls are **not verified** (OpenAI pages returned 403).
6. DS-Bot shares one page across a Bot's group sessions with no action mutex (inferred). Would Orchestra need its own lease if it drove DS-Bot Bots in M4?

## Sources

- github.com/openclaw/openclaw @a1b840f7:
  - docs/tools/browser.md
  - docs/tools/browser/{isolation,profiles,security,agent-tools,configuration,existing-session}.md
  - docs/tools/browser-login.md
  - docs/gateway/security/browser-control.md
  - docs/gateway/sandboxing/supported-capability-matrix.md
  - docs/nodes/computer-use.md
  - docs/plugins/codex-computer-use.md
  - docs/plugins/reference/lobster.md
  - docs/releases/2026.8.1/browser-and-computer-use.md
- OpenClaw issues #43290, #44759, #59333, #79960, #105357, #106703, #138999, #158011, #176236.
- OpenClaw GHSA-3x84-qq85-fj65, GHSA-p3h6-v2h4-36q2, GHSA-9x88-f7rh-4c83, GHSA-jghr-xp78-995p, GHSA-pjjr-5qhr-5w6r, GHSA-4g58-43jr-6738, GHSA-m78m-7h3q-q938.
- github.com/xai-org/grok-build @2bdd1d6a6:
  - crates/common/xai-computer-hub-core/src/{lib.rs,bot_tools.rs}
  - crates/codegen/xai-grok-agent/src/prompt/browser_verification.rs
  - crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_layer_images.rs
- github.com/b-nnett/grok-bot-0.18-reconstructed: frontend/src/recovered/features/computer/shell/model.ts; frontend/manifests/computer-shell-evidence.json
- G:\_Projects\DS-Bot\ds-bot:
  - src/host/browser.js
  - src/host/browser-plugins.js
  - src/host/browser/{session,mount,loop,task}.js
  - README.md:141-157
- G:\_Projects\DS-Bot\docs\plans\2026-10-08-browser-and-secrets.md; 2026-10-21-browser-plugins.md
- C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-composition-reference\references\packages.md; dsh-compaction-image-offload\README.md
- C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\docs\{confirmations,browser-safety,tab-claiming-chrome,screenshots}.md
- github.com/Mai-with-u/MaiBot: src/computer/{actions.py,bridge.py,guest.ps1}; src/agent/config.py; commit 29ea49088
- github.com/AstrBotDevs/AstrBot: astrbot/core/computer/computer_client.py; booters/{cua.py,cua_defaults.py}
- github.com/paperclipai/paperclip: doc/connections/BROWSER-USE.md
- github.com/letta-ai/letta-code: src/skills/builtin/browser-use/SKILL.md
- github.com/qwibitai/nanoclaw: container/skills/agent-browser/SKILL.md; container/agent-runner/src/browser-trust.ts
- github.com/zeroclaw-labs/zeroclaw: docs/book/src/tools/browser.md
- github.com/HKUDS/nanobot: nanobot/cli/windows_browser.py; tree of nanobot/agent/tools
- github.com/langbot-app/LangBot: skills/skills/langbot-env-setup/references/browser-access-selection.md
- OpenAI, Operator System Card, 2025-01-23 (cdn.openai.com/operator_system_card.pdf), pp. 1-12
- Chromium docs/design/sandbox.md ("The Job Object")
- Raw downloads (untrusted, not executed): C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\bots\raw\
