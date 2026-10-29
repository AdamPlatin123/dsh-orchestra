<!-- Raw researcher report: Opus sweep "cua-landscape", 2026-10-26. Unedited except for a stripped harness banner. Pre-review; synthesized into computer-use.md, which wins where the two disagree. -->

## Identity & scope

Angle: the 2026 computer-use and browser-automation stack, and which pieces Orchestra should wrap rather than build. Sources are vendor docs, GitHub repos (stars and versions fetched 2026-10-26 via `gh api`), locally installed software (read only), and Chromium and Microsoft sources. Benchmark figures come mostly from vendor or aggregator pages and are marked as such. Spec sections touched: §3.2, §5.4, D4, D5, D8, §8.5, §10.1–10.4, §10.9, §10.11, §17.

## Facts

**Model vendors**
- **Anthropic API.** On Claude Opus 5.5 and Sonnet 5.5, computer use works only through `{"type":"computer_toolset_20260801"}` on the Claude API and Google Cloud. That form has no beta header, no `name` and no display size. It has 17 member tools, `zoom` included and on by default. Each action is the `tool_use` block's `name`, and one turn can carry several actions. The older `computer_20251124` (beta header `computer-use-2025-11-24`) returns a 400 there; Bedrock still accepts it (claude-api skill 2.1.308, `shared/model-migration.md:1967-1970`, `shared/error-codes.md:192`). A separate `browser_toolset_20260801` exists (`model-migration.md:1992`, `:2310`). Images are high-resolution up to a 2576 px long edge, costing about 4,784 tokens per image versus about 1,600 before (`model-migration.md:705`). The recommended computer-use screenshot is 1080p, or 720p / 1366×768 for low cost (`:798`). I could not fetch the live computer-use page itself (HTTP 400, and a TLS-intercepting proxy blocked curl), so this is the bundled skill's cached copy (not verified live).
- **Claude in Chrome (Claude Code).**
  - It runs in the user's real Chrome or Edge through an extension plus a native-messaging host, and "shares your browser's login state". Pages run in a visible window, and Claude pauses on login pages and CAPTCHAs (https://code.claude.com/docs/en/chrome).
  - It requires `/login` OAuth. With an API key or `setup-token`, Chrome integration stays off even with `--chrome`. It is not available on Bedrock, Vertex or Foundry.
  - A project's `.claude/settings.json` cannot turn it on (`CLAUDE_CODE_ENABLE_CFC` is ignored). Site permissions come from the extension.
  - Windows: "Named pipe conflicts (EADDRINUSE)… Close any other Claude Code sessions that might be using Chrome." Not supported in WSL.
- **OpenAI.**
  - The `computer` tool is screenshot-based. The model sends `click/double_click/drag/move/scroll/keypress/type/wait/screenshot` as an ordered `actions` batch inside a `computer_call`.
  - The docs now say: "For GPT-6 Astra, we recommend code execution. The `computer` tool remains supported as an alternative." They also mention a migration path from `computer-use-preview` and SDK toolsets: `BrowserToolset`, which is structured (`read_page` gives ref/role/label), and `ComputerToolset`, which is screenshot-based.
  - Hosted environments named: Browserbase, Browser Use, Daytona, E2B (https://developers.openai.com/api/docs/guides/tools-computer-use; model names `gpt-6.1-sol` and `gpt-6-astra` as the page shows them).
- **Codex desktop on this machine (local, given).** `@oai/sky` 0.7.13 drives Windows apps through SendInput plus UI Automation, and captures occluded windows with Windows.Graphics.Capture (`…\@oai\sky\docs\skills\oai_sky_lib\windows\SKILL.md:14`). The flow is `get_window_state` (accessibility tree, optional screenshot) first, then window-relative coordinates only "when accessibility elements are unavailable" (`:36-38`, `:82`).
  - The bundled Codex browser plugin is also accessibility-first: "Use the accessibility API (`ax`)… as the primary way". The tree comes back as a diff from the previous one "for token efficiency" (`C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\docs\accessibility.md:3-13`).
  - It can claim the user's external Chrome tabs (`docs\tab-claiming-chrome.md`). It ships a written confirmation policy: hand-off for password changes and safety interstitials, and confirmation at action time for transmissions (`docs\confirmations.md`, `docs\browser-safety.md`).
  - It is wired through the `node_repl` MCP and plugin hooks on Stop, Interrupt and SubagentStop (`.codex-plugin\plugin.json`).
  - Codex can require approval per MCP tool (`approval_mode = "approve"` in config.toml, given).
- **Google.**
  - Gemini API `computer_use` covers browser, mobile and desktop environments, with 0–999 normalized coordinates and a `safety_decision` → `require_confirmation` → `safety_acknowledgement` handshake.
  - Policy categories include financial, account creation and legal terms. Prompt-injection detection is opt-in.
  - Models named: `gemini-3.8-flash` (recommended), `gemini-4-argon` and others (https://ai.google.dev/gemini-api/docs/computer-use).
  - Project Mariner was shut down on 2026-05-04 and folded into Gemini Agent, AI Mode and Chrome auto-browse (secondary sources only: gigazine 20260507, androidheadlines 2026/05; not verified at a primary source).
- **DeepSeek.**
  - Only `deepseek-flash` takes image input. It is served by DeepSeek-V4.1-Flash-1017, and the earlier `-vision-exp` name is retired.
  - In Chat Completions, images may appear in `user` messages only; `system` or `assistant` returns a 400. The Responses API also allows images in `function_call_output`.
  - Each image costs at most 1,024 tokens (https://api-docs.deepseek.com/guides/vision). The 2026-08-21 launch post said "up to 384 tokens each", which conflicts with the guide, and claimed multimodal-agent performance "close to Opus-4.8" without naming benchmarks (https://api-docs.deepseek.com/news/news260821).
  - The guide does not mention GUI agents, grounding, coordinates or computer use. The V4.1 release (2026-10-17, news261017) mentions none either.
  - **No DeepSeek model officially supports screenshot-grounded GUI actions** (inferred from the absence in all three pages). DSH ships no browser tool (given).

**Open-source servers and agents** (stars, license and latest release as of 2026-10-26)

| Repo | Stars | License | Latest | Model |
|---|---|---|---|---|
| microsoft/playwright-mcp | 38,668 | Apache-2.0 | v0.0.83 (2026-09-28) | accessibility snapshot first |
| microsoft/playwright-cli | 14,649 | Apache-2.0 | v0.1.22 (2026-09-28) | CLI + skills |
| ChromeDevTools/chrome-devtools-mcp | 54,206 | Apache-2.0 | 1.12.0 (2026-10-22) | CDP/Puppeteer, snapshot + DevTools |
| vercel-labs/agent-browser | 44,644 | Apache-2.0 | v0.39.4 (2026-10-26) | Rust CLI, accessibility refs `@e1` |
| browser-use/browser-use | 119,217 | MIT | 0.13.14 | Python agent loop (Bash: WSL on Windows) |
| browserbase/stagehand | 25,828 | MIT | server v3.7.7 | act/observe/extract, hosted MCP |
| browserbase/mcp-server-browserbase | 3,397 | Apache-2.0 | **archived** | replaced by mcp.browserbase.com |
| Skyvern-AI/skyvern | 23,281 | **AGPL-3.0** | v1.0.56 | vision LLM loop |
| magnitudedev/browser-agent | 4,135 | Apache-2.0 | last push 2026-02-08 | vision-first |
| lightpanda-io/browser | 37,015 | **AGPL-3.0** | 1.0.2 | headless engine; "no native Windows binary" (README:100) |
| steel-dev/steel-browser | 7,870 | Apache-2.0 | v0.5.4-beta | self-hostable CDP browser API |
| CursorTouch/Windows-MCP | 10,435 | MIT | v0.8.8 | UIA desktop MCP |
| microsoft/UFO | 10,093 | MIT | v3.0.10 | UFO² desktop AgentOS (UIA/Win32/COM) + Galaxy |
| microsoft/OmniParser | 25,558 | CC-BY-4.0 | — | screen parsing |
| pywinauto/pywinauto | 6,231 | BSD-3 | — | UIA library |

**playwright-mcp details** (README on main)
- The accessibility tree is the default and it "bypass[es] the need for screenshots" (:3, :15).
- Coordinate tools are opt-in via `--caps=vision`. The old `--vision` and `--save-trace` flags are gone from the option table. Tracing and video are now tools (`browser_start_tracing`, `browser_start_video`) plus `--save-session`.
- Profile and state: `--isolated` keeps the profile in memory; `--user-data-dir`; `--storage-state`; `--shared-browser-context` (one context for all HTTP clients).
- "A persistent profile can only be used by one browser instance at a time… start each additional client with `--isolated` or a distinct `--user-data-dir`" (:485).
- `--allowed-origins` and `--blocked-origins` explicitly "*does not* serve as a security boundary and *does not* affect redirects" (:410-412).
- Other relevant options: `--image-responses allow|omit|only`, `--snapshot-mode full|none`, `--cdp-endpoint`, `--extension` (attach to the user's running Edge or Chrome), `--idle-timeout`, `--no-webmcp`.
- `--secrets` replaces values in tool output but "is a convenience and not a security feature" (:680-682).
- `browser_run_code_unsafe` "is RCE-equivalent" (:1084).
- The README itself recommends CLI plus skills for coding agents, because MCP loads "large tool schemas and verbose accessibility trees" (:9).

**playwright-cli** gives named sessions per agent (`PLAYWRIGHT_CLI_SESSION=todo-app claude .`), keeps profiles in memory unless `--persistent`, and closes headless sessions after 1 h idle. `playwright-cli show` is a dashboard with a live screencast grid of all sessions and click-to-take-over (README:75-130).

**chrome-devtools-mcp**
- Page-ID routing is on by default for concurrent sessions. `--isolated` gives a temporary profile; otherwise the default profile `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile` can be used by only one browser at a time (docs/advanced-usage.md:3-41).
- `--autoConnect` attaches to the user's running Chrome 144+ after an "Allow" dialog, and gets "access to all open windows for the selected profile" (:53-100).
- `--browser-url` requires a non-default `--user-data-dir` for `--remote-debugging-port` (:132).
- `--allowedUrlPattern` (Chrome 149+) blocks navigations and subresources and rejects patterns that cannot be enforced on redirects (docs/configuration.md:128-135).
- `--javascriptEvaluation=false`; `--experimentalVision` for `click_at`; `--screenshotMaxWidth` and JPEG/WebP output ("~3-5x smaller than PNG").
- Usage statistics go to Google **by default** unless `--no-usage-statistics` is passed (README:43-55).

**Windows-MCP** has tool whitelisting (`--tools`, `--exclude-tools`, e.g. exclude PowerShell and Registry), safety tiers ("relaxed" = direct input; "balanced" adds PowerShell and process kill), and 0.2–0.5 s per action (README:66, 486-490, 654-655).

**Benchmarks** (vendor or aggregator unless noted; DeepSeek has no published GUI-agent number)
- **OSWorld 2.0** (108 tasks, median 1.6 human-hours; 318 tool calls per task vs about 30 in v1; arXiv 2606.29537):
  - Claude Opus 4.8: 20.6% binary / 54.8% partial at 500 steps.
  - Claude Opus 4.7: 18.2% at about 150K output tokens.
  - GPT-5.5: about 14% at about 39K output tokens, called "most token-efficient" (https://osworld-v2.xlang.ai/).
- **OSWorld-Verified.** The official page did not render its data. The last official update is 2025-07-28 (xlang-ai/OSWorld README:36, possibly stale). BenchLM (aggregator, 2026-06-02) lists Opus 4.8 at 83.4% (not verified).
- **Windows Agent Arena:** Navi 19.5% vs human 74.5% on 150+ tasks (arXiv 2409.08264, 2024: **stale**).
- **WebVoyager:** Magnitude 94% (self-reported, README:13); Skyvern 2.0 85.8% (self-reported blog, older).
- WebArena, Mind2Web and AndroidWorld: 2026 figures for Claude, OpenAI or DeepSeek not verified this session.

**Token cost per step**
- Screenshots: Claude about 1,600–4,784 tokens per image depending on resolution; DeepSeek ≤1,024 per image.
- Accessibility snapshots are text whose size depends on the page. playwright-mcp and the Codex plugin both treat full trees as expensive and offer `browser_find`, `depth`, `--snapshot-mode none` or diffs.
- On a typical dashboard a full snapshot is probably on the order of a few thousand tokens, and a diff or targeted find is far smaller (inferred, not measured).

**Windows Job Objects**
- Nested jobs form "if… neither job sets UI limits" (https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs, §Nested Job Hierarchies).
- Chromium's sandbox job sets `JobObjectBasicUIRestrictions` (clipboard, handles, desktop and others) (chromium `sandbox/win/src/job.cc:39-78` @ 63d3b40, 2026-10-26).
- `base/process/launch_win.cc:384-386` supports `CREATE_BREAKAWAY_FROM_JOB`.
- So a sandboxed Chrome launched inside procguard's kill-on-close job may not be able to place renderers into its UI-restricted jobs unless the outer job permits breakaway (inferred; needs an S4 test).

## Patterns for Orchestra

**Adopt**
1. **Wrap playwright-mcp (or playwright-cli), not a computer-use model loop** (§3.2 "no new agent loop", D5). It is harness-neutral MCP, Apache-2.0, accessibility-first, and works with text-only DeepSeek models via `--image-responses omit`. Each harness keeps its own loop. Add chrome-devtools-mcp as a second, opt-in "debug" server (console, network, performance), always run with `--no-usage-statistics`.
2. **Thin `orchestra-browser` MCP proxy, one upstream per lease** (§8.6, §10.2):
   - The Post Office or Governor grants a *browser lease* per Musician. The proxy spawns `@playwright/mcp` pinned to a version (D12) with `--isolated` or `--user-data-dir=~/.orchestra/browser/<musicianId>`, plus `--output-dir` and `--idle-timeout`.
   - Never use `--shared-browser-context` across Musicians.
   - Leases count against `tempo.maxActive` (each Chromium is hundreds of MB, inferred).
3. **Login state is seeded by a human.** The person signs in once in a headed profile, or exports `--storage-state`. Agents never type credentials (§10.11). Treat profile directories like credential files: put them on the fs-wrapper deny list.
4. **Taint stamp on every result** (§8.5). Any browser tool result is a "fetched URL", so the turn becomes `tainted` with `provenance:[url]`. The proxy appends the current origin to provenance.
5. **Approval hook in the proxy** (D8, §10.9):
   - Classify `browser_navigate` to a new origin, `browser_fill_form` / `browser_type` into password or payment fields, `browser_file_upload`, `browser_handle_dialog`, and clicks on submit-like accessibility roles as high-risk. In tainted turns they go to the human queue.
   - Hide `browser_run_code_unsafe` and `browser_evaluate`, or gate them behind typed confirmation.
   - For Codex, also use native `approval_mode = "approve"` per tool; for Claude, `canUseTool`.
6. **Network restriction outside the browser.** Origin allow-lists in playwright-mcp are not a boundary. Route through `--proxy-server` to an Orchestra loopback egress filter, or use chrome-devtools-mcp `--allowedUrlPattern`. Default-deny `orchestra.localhost` so a Musician cannot click the human-only UI (D8, §10.11).
7. **Redaction.** Run every snapshot and text result through the existing three-layer redactor (§6.1) before it enters the event store. `--secrets` is only a backstop. Screenshots go to the purgeable table with a TTL and are never hashed into the chain.
8. **Observability for free.** Link `playwright-cli show` or per-session tracing/video from the Musician page (§11.7) instead of building a viewer.
9. **Process placement** (D4, §5.4, §10.4). Run the browser under the proxy's job with breakaway allowed, or outside the job with pid + createTime tracking and CDP `Browser.close` for reaping. Add a Chrome-in-nested-job test to S4.

**Avoid**
- Building a CUA or vision loop, or pixel-first agents (Skyvern, Magnitude) as Musician tools. Their own loops duplicate the harness, and Skyvern is AGPL (§12.2 MIT).
- `--extension`, `--autoConnect` or Claude in Chrome against the human's real profile for owned Musicians. That gives full access to every signed-in tab, which conflicts with D8 and taint rules. Leave these to the human's own native sessions (observed, §5.4).
- Desktop computer use (sky, Windows-MCP, UFO) for unattended Musicians in v1. On Windows, input "activate[s] their target window automatically" (sky SKILL.md, given), so parallel Musicians fight the human for focus. Windows-MCP "balanced" adds PowerShell. If used later, offer only a human-started, single-lease, foreground "hands" mode.
- Hosted browsers (Browserbase, Steel cloud, Browser Use Cloud), because of §3.2 local-only. Lightpanda has no native Windows build and is AGPL.

## Verdict on the user's claim

The claim holds from this angle in one narrow sense: a Musician that only has `web_fetch` cannot check a dashboard behind login, a CI page rendered client-side, or reproduce a UI bug. Every vendor shipped a browser or computer toolset in 2026: Anthropic `computer_toolset_20260801` and `browser_toolset_20260801`, OpenAI `computer` and code-execution toolsets, Gemini `computer_use`, and Codex `@oai/sky` plus its browser plugin. DeepSeek has no GUI-action model or tool.

The claim overreaches if it means Orchestra must provide pixel-level "eyes and hands". The 2026 consensus is accessibility-first: playwright-mcp, the Codex `ax` diffs, sky reading `ax_tree` before coordinates, and OpenAI recommending code execution over the `computer` tool. Text-only DeepSeek Musicians can use that through MCP today. Even the best desktop agents score only about 20% binary on OSWorld 2.0.

So "bot = needs a browser" is a capability requirement that Orchestra should meet by handing each Musician a leased, isolated, tainted, approval-gated Playwright MCP. It should not do this by building its own computer-use model loop.

## Open questions

1. Does DSH's DeepSeek path deliver MCP tool images into a user turn? DeepSeek's Chat Completions rejects images outside `user` messages (vision guide), while `dsh-mcp-client` README:87 says images "appear in the conversation". Until a test confirms it, DSH Musicians should run with `--image-responses omit`.
2. S4: does Chrome or Edge with its sandbox enabled start correctly inside a procguard nested kill-on-close job, both without and with `JOB_OBJECT_LIMIT_BREAKAWAY_OK`?
3. Do owned Claude Musicians (SDK, `settingSources: []`, `strictMcpConfig`) get any built-in browser? Claude in Chrome needs `/login` plus `--chrome` (docs). Presumably only Orchestra-injected MCP applies (inferred).
4. Should the egress filter for tainted browser turns be per-Musician, given D5 presets? Is a new `browser` permission preset needed?
5. Are the Gemini computer-use, OSWorld-Verified 2026 and Mind2Web/AndroidWorld numbers needed for AutoRoute (§9)? If so, they need primary sources.
6. The PII and credential exposure of Codex `tab-claiming-chrome` in observed sessions should be shown on the Tuning bypass panel (§10.9).

## Sources

- Spec `G:\_Projects\dsh-orchestra\docs\specs\2026-10-26-dsh-orchestra-design.md` §3, D4, D5, D8, §5.4, §6.1, §8.1, §8.5, §10, §11.1, §13.1, §17; `docs\research\ds-bot.md:116`
- claude-api skill 2.1.308: `shared/model-migration.md:705,798,1967-1992,2310`, `shared/error-codes.md:192`
- https://code.claude.com/docs/en/chrome
- https://developers.openai.com/api/docs/guides/tools-computer-use
- https://ai.google.dev/gemini-api/docs/computer-use
- https://api-docs.deepseek.com/ ; /guides/vision ; /news/news260821 ; /news/news261017
- Local: `C:\Users\Calx\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node_modules\@oai\sky\docs\skills\oai_sky_lib\windows\SKILL.md:14,36-38,82`; `C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\{.codex-plugin\plugin.json, docs\accessibility.md, docs\browser-safety.md, docs\confirmations.md, docs\tab-claiming-chrome.md}`
- GitHub READMEs and docs (fetched 2026-10-26 into `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\landscape\raw\`): microsoft/playwright-mcp, microsoft/playwright-cli, ChromeDevTools/chrome-devtools-mcp (README, docs/advanced-usage.md, docs/configuration.md, docs/tool-reference.md), vercel-labs/agent-browser, browser-use/browser-use, browserbase/stagehand, Skyvern-AI/skyvern, magnitudedev/browser-agent, lightpanda-io/browser, steel-dev/steel-browser, CursorTouch/Windows-MCP, microsoft/UFO, microsoft/WindowsAgentArena, xlang-ai/OSWorld
- https://osworld-v2.xlang.ai/ (arXiv 2606.29537); http://osworld-v1.xlang.ai/; arXiv 2409.08264
- https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs ; chromium/chromium `sandbox/win/src/job.cc`, `base/process/launch_win.cc` @ 63d3b40; https://chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md
- Secondary (flagged): benchlm.ai/benchmarks/osWorldVerified; gigazine.net 20260507 (Mariner shutdown); androidheadlines.com 2026/05
