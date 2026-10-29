<!-- Raw researcher report: Opus sweep "harness-cu", 2026-10-26. Unedited except for a stripped harness banner. Pre-review; synthesized into computer-use.md, which wins where the two disagree. -->

## Identity & scope

Researcher **harness-attach**. Angle: what Claude Code, Codex and DSH can each do today (2026-10-26) for browser use and computer use (CU), and exactly how an outside browser or CU capability plugs into each, in particular into an Orchestra-owned Musician (Claude Agent SDK, `codex app-server`, private DSH `acp`/`web`). Local installs were only read, never executed. Downloaded npm tarballs and docs are in `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\harness-attach\raw\` (untrusted, read-only).

Path abbreviations:
- **SKY** = `C:\Users\Calx\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node_modules\@oai\sky`
- **OB** = `C:\Users\Calx\.codex\plugins\cache\openai-bundled`
- **DP** = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
- **RAW** = the scratch `raw\` directory above
- **CCD** = `RAW\ccdocs\` (copies of code.claude.com/docs/en/*.md fetched today)

## Facts

### Claude Code (2.1.310)

- **Browser pane.** This is a desktop-app feature. It runs a clean profile "separate from your personal browser, with none of your saved logins" (CCD/desktop.md:157). Users can sign in inside the pane, and "Keep cookies" persists them (desktop.md:132, 140).
  - Write actions on external pages pass through safety classifiers in every permission mode. There is a per-site card: Allow once / Always allow / Deny. Localhost and project files need no approval (desktop.md:143-151).
  - Admins can turn it off with `browserExternalPageTools` and `disableBrowserExternalNavigation` (desktop.md:1893-1895). It is unavailable in SSH sessions (desktop.md:123).
  - Only an SDK host application (an Agent SDK app or the desktop app) can register an in-process `type:"sdk"` MCP server (CCD/mcp.md:85). So the `mcp__Claude_Browser__*` tools are host-registered by the desktop app (inferred) and do not exist in a bare `claude -p` or Agent SDK child.
- **Claude in Chrome.** It drives the user's real Chrome or Edge (Brave, Arc, Vivaldi and Opera are detected) with their login state, in a visible window. It pauses on logins and CAPTCHAs (CCD/chrome.md:11, 20).
  - It needs `--chrome` (or `/chrome` → Enabled by default) and a claude.ai `/login`. It stays off with an API key or `setup-token` (chrome.md:46, 56, 100). A project cannot enable it via `CLAUDE_CODE_ENABLE_CFC` (chrome.md:275). It is not on Bedrock, Agent Platform or Foundry (chrome.md:50), and not in WSL (chrome.md:20).
  - Permissions: per-site permissions are inherited from the extension. Prompts start "Claude in Chrome wants to" and offer allow-all-on-site for the session (chrome.md:75, 112). In auto mode the classifier can stand in for the per-site check (chrome.md:112).
  - It uses native messaging host `com.anthropic.claude_code_browser_extension`, registered under HKCU on Windows (chrome.md:258-266). The `--chrome` and `--no-chrome` flags are listed in CCD/cli.md:78, 110. Whether it works under `-p` is (not verified).
  - Published safety numbers, from claude.com/blog/claude-for-chrome (2025-08-25, updated 2025-11-24 and 2025-12-18; **pre-2025-06 rule does not apply, but the numbers may be stale**):
    - 123 test cases across 29 attack scenarios.
    - Prompt-injection attack success 23.6% without mitigations, 11.2% with them.
    - Browser-specific challenge set: 35.7% → 0%.
    - High-risk site categories are blocked, and high-risk actions (publish, purchase, share personal data) require confirmation.
- **Desktop CU.**
  - CLI: macOS only, Pro/Max only, interactive only ("not available in non-interactive mode with the `-p` flag") (CCD/computer-use.md:11, 200, 203).
  - Desktop app: macOS and Windows (computer-use.md:180). On Windows the toggle is under Settings > This computer > System and takes effect immediately (desktop.md:351-357).
  - Per-app "Allow for this session". Tiers are fixed by app category: browsers are **view-only**, terminals and IDEs click-only, everything else full control (desktop.md:368-380).
  - **One session at a time** holds the CU lock until that session exits (computer-use.md:99-101). Other apps are hidden while it works, and the terminal is excluded from screenshots (computer-use.md:105, 131).
- **Images from MCP tools.** PNG, JPEG, GIF and WebP results are shown to Claude inline, and the original is also saved under `tool-results` (CCD/mcp.md:1526-1532). Image results stay subject to `MAX_MCP_OUTPUT_TOKENS`, default 25,000 (mcp.md:435, 1491).
- **Attaching MCP.**
  - Config sources: `.mcp.json` (project, approval-gated), `~/.claude.json`, `claude mcp add`, `--mcp-config` (mcp.md:81, 253-259; CCD/headless.md:57).
  - `--bare -p` connects only the servers passed on the command line (headless.md:63). Skipped entries show up in `system/init.mcp_server_errors` (headless.md:288).
  - Per-server `timeout` and `MCP_TOOL_TIMEOUT` (mcp.md:434-451). A tool can force approval on every call with `_meta["anthropic/requiresUserInteraction"]=true` (mcp.md:1568).
- **Gating.**
  - Hooks: `PreToolUse` and `PermissionRequest` match tool names, e.g. `mcp__.*`. The `.*` suffix is required. Plugin servers are named `mcp__plugin_<plugin>_<server>__<tool>` (CCD/hooks.md:281, 293, 351-357).
  - `-p` runs start in Manual mode. An unapproved call is denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves it (headless.md:315).
  - The spec notes the vendored SDK backend sets `hooks: 'omit'`, so owned Musicians gate through `canUseTool` (spec §7.4 line 578).

### Codex (CLI 0.139.0 local; latest release rust-v0.164.0, 2026-10-23; openai/codex 131,024★ on 2026-10-26)

- **Windows CU runtime: `@oai/sky` 0.7.13** (SKY\package.json:2-3; exports `./service`, package.json:9-11).
  - Windows skill: "SendInput and UI Automation… Windows.Graphics.Capture… even if they are occluded" (SKY\docs\skills\oai_sky_lib\windows\SKILL.md:14). It is driven only from `node_repl` JavaScript with persistent state (SKILL.md:16-20).
  - API: `list_apps`, `get_window`, `launch_app`, `get_window_state` (screenshot + a11y tree with element indexes), `click`, `type_text`, `press_key`, `scroll`, `set_value`, `drag`, `perform_secondary_action`, `activate_window`, `paste` (SKILL.md:110-124, 233-239).
  - "input methods activate their target window automatically", i.e. it **steals focus** on Windows (SKILL.md:123; sky-window2-api.md:28, `target:"windows"`).
  - Screenshots are "displayed automatically" to the model (SKILL.md:84-86).
  - The runtime waits about 1 s, and up to about 5 s more, after an action before capturing state (SKILL.md:241-247).
  - Background input "without activating it or moving the desktop pointer" exists only for `target:"linux"` (sky-full-desktop-api.md:7, 41).
- **Plugins** (all 26.1021.31345; `config.toml:195-202` enables `browser`, `unified-computer-use` and `computer-use`).
  - `computer-use`: "Control desktop apps on Windows". Its SKILL says not to spawn `codex-computer-use.exe` and to import `@oai/sky` (OB\computer-use\26.1021.31345\.codex-plugin\plugin.json:56; skills\computer-use\SKILL.md:20).
  - Confirmation taxonomy (OB\computer-use\…\docs\confirmations.md:23-88):
    - hand-off required: password change, bypassing safety interstitials;
    - always confirm: delete, account creation, CAPTCHA, installs, third-party communication, purchases;
    - pre-approval allowed: login, uploads, sensitive data;
    - no confirmation: cookie banners, downloads.
  - This taxonomy is **model-instruction policy, not a harness gate** (inferred: it is a prompt doc).
  - `unified-computer-use` defines MCP server `cua_repl`: `node.exe …\@oai\cua-repl\bin\cua-repl.mjs`, enabled tools `js`, `js_reset`, `turn_ended`, `output_token_limit` 25000, `CUA_REPL_ENABLED_SURFACES=browser,computer`, `BROWSER_USE_AVAILABLE_BACKENDS=chrome,iab,mcpapps`, `SKY_CUA_NATIVE_PIPE_DIRECTORY=\\.\pipe\codex-computer-use-8ea23fb9-…`, plus app-injected `env_vars` `BROWSER_USE_ACCESS_EXECUTOR_ID/PIPE_PATH/VERIFYING_IDENTITY` (OB\unified-computer-use\26.1021.31345\.mcp.json:3-49).
  - `config.toml:98-121` has the same shape for `[mcp_servers.node_repl]`. `config.toml:8` sets `notify=[codex-computer-use.exe,"turn-ended"]`. `config.toml:123-124` sets `[windows] sandbox="elevated"`.
- **Browser plugin** (OB\browser\26.1021.31345).
  - Backends: **chrome**, i.e. the user's real Chrome, Edge, Brave, Opera or Vivaldi via the "ChatGPT" extension `hehggadaopoacecdllhhajmbjkdcmajg` / `odlomjlbamekndcpllcnffbgeohgkmjh` and native host `com.openai.codexextension` (scripts\extension-ids.json); **iab**, the in-app browser; and **mcpapps**.
  - The manifest says it is mainly for "localhost… file://… current in-app browser tab" (.codex-plugin\plugin.json:56, 75). Hooks fire `node_repl.turn_ended` on Stop, SubagentStop and Interrupt (plugin.json:4-54).
  - Capabilities:
    - `cdp`: raw CDP scoped to the tab's origin (docs\capabilities\tab\cdp.md:2);
    - `management`: tabs, windows and bookmarks, with an audit trail and no navigation or history (capabilities\browser\management.md:2, 74-93);
    - `visibility`: background by default (docs\visibility.md:3);
    - `browserAuth`: credentials are collected in a secure form and "never… model-visible" (capabilities\tab\browserAuth.md, Non-Negotiable Rules);
    - tab claiming of the user's open tabs (docs\tab-claiming-chrome.md:8-9).
  - `browser-safety.md:3-11` repeats the confirmation policy, again at the prompt level.
- **Public docs** (developers.openai.com/codex/app/computer-use → 308 → learn.chatgpt.com/docs/computer-use):
  - "Computer Use in the ChatGPT desktop app is available on macOS and Windows".
  - The app asks per app, with "Always allow". On Windows, decisions are saved as `always_allowed_app_ids` in `$CODEX_HOME/config.toml`.
  - Admins can disable it via `requirements.toml`.
  - **No CLI or app-server mention.**
- **App-server surface (openai/codex master, 2026-10-26).**
  - `ThreadItem` variant `mcpToolCall{server, tool, arguments, status, pluginId, readOnlyHint, result, error, durationMs}` (codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts:112-126).
  - `AppToolApproval = "auto"|"prompt"|"writes"|"approve"` (…/v2/AppToolApproval.ts).
  - Per-tool approval resolves in `codex-rs/core/src/mcp_tool_call.rs:225-280` and is delivered as **`mcpServer/elicitation/request`**, falling back to **`item/tool/requestUserInput`**, which is root-thread only (mcp_tool_call.rs:~1717-1768).
  - Server-request methods include `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/requestUserInput` (…/typescript/ServerRequest.ts).
  - The user's config already gates Playwright per tool: `browser_navigate`, `browser_evaluate`, `browser_file_upload` and `browser_click` all have `approval_mode="approve"` (config.toml:50-66).
- **Can a private `codex app-server` (separate `CODEX_HOME`, D5) use sky or the browser plugin?** (not verified)
  - The runtime depends on a named pipe and `BROWSER_USE_ACCESS_*` env injected by the desktop app (`.mcp.json:24-29, 44`). A private home would not carry `[plugins]` or `node_repl`.
  - So treat it as **desktop-app-only** (inferred).

### DSH (0.2.1-rc.2 installed; deepseek-ai/deepseek-harness 262,534★ per GitHub API on 2026-10-26)

- **Out-of-box web is fetch-only.** `dsh-tool-web` gives `web_search` and `web_fetch`.
  - `web_fetch({url})` returns `Fetched <url> (HTTP n)` plus an untrusted-content notice plus Markdown from HTML with active and hidden content removed. The cap is 200,000 chars, timeout 30 s (DP\dsh-tool-web\README.md:44-53, 68, 219).
  - The HTTP provider fetches public pages anonymously "without sending credentials", "rejects non-public destinations" (i.e. no localhost and no LAN), rejects binary, and fails on cross-origin redirects (DP\dsh-web-fetch-http\README.md:12, 64).
  - There is no JS execution and no login (inferred from the above). "Public fetches do not request approval", so a `tools/pre-execute` policy is needed to gate them (dsh-tool-web\README.md:253).
- **Sidebar browser is not model-reachable.** Model Experience is "None… register no tool, prompt section, or Session event" (DP\dsh-client-ui-sidebar-browser\README.md:92). DSH-D#10277 (2026-10-19, idea, no replies) proposes a lease-scoped CDP channel so agents could drive it.
- **Browser and CU exist as loadable, unbundled packages** (correction to the "ships no browser tool" framing). The generated catalog inside the install lists:
  - `dsh-browser-use` and `dsh-computer-use` (single-provider registries);
  - `dsh-experimental-browser-use-{playwright-mcp, chrome-devtools-mcp, stagehand-native}`;
  - `dsh-experimental-computer-use-cua-driver-{mcp,native}`;
  - `dsh-experimental-cua-macos`.

  Sources: DP\dsh-agent-preset\skills\cordis-composition-reference\references\packages.md:43-47, 133-137, 190-200. All are on npm with `next`=0.2.1-rc.4 and a 0.2.1-rc.2 build that matches the install (`npm view`, 2026-10-26).
  - Playwright provider (RAW\dsh-experimental-browser-use-playwright-mcp\package\README.md):
    - pins `@playwright/mcp` 0.0.80 (package.json);
    - `mode: launch|attach`, `headless: true` by default, `executablePath`, `endpoint` (README:30-46);
    - one browser per live Session, retained across turns; no cookies restored on resume (README:62);
    - Chromium only, and "Cancellation does not undo navigation, clicks" (README:100-104);
    - tool names `mcp__playwright-mcp__<tool>`; screenshots need an attachment store and an image-capable route (README:84).
  - The Chrome DevTools provider pins `chrome-devtools-mcp` 1.9.0 and names tools `mcp__chrome-devtools-mcp__*` (README:84).
  - Cua Driver MCP: `command: cua-driver`, `args:[mcp]`, tools `mcp__cua-driver-mcp__*`. "callers coordinate concurrent Sessions themselves" (computer-use-cua-driver-mcp README:12, 26-46). The native variant shares the host process ("native crashes can terminate that process") and uses the `cua_driver_native__` prefix (README:43, 113).
  - Subsystem doc: the shared service "rejects any second provider". An attached browser is reserved for one Session per provider instance (github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/browser-use.md, "Choose a provider", "Session ownership").
- **Field reports, all Windows-relevant, no maintainer answers found:**
  - DSH-D#7007 (Win10) and DSH-D#7169 (Win11, 0.1.6-alpha.2): mounting the Playwright provider rejects every Session or agent creation after the first.
  - DSH-D#6799: startup failure aborted Session resume, fixed by `failOnStartupError:false` per a follow-up comment.
  - DSH-D#9688 and DSH-D#8095: the attach slot is held forever by a background agent.
  - DSH-D#11012 (rc.3): MCP tools vanish after upgrade.
  - CU plugins are community and macOS (DSH-D#3868, DSH-D#10741, DSH-D#10997).
- **Generic MCP.** `dsh-mcp-client` is configured per entry: `serverName`, `transport: stdio|streamable-http`, `command/args/env/cwd` or `url/headers`, `toolCallTimeoutMs` 60,000, reconnect 500 ms→30 s ×10. Tool names are `mcp__<serverName>__<tool>` (DP\dsh-mcp-client\README.md:34-75). Ambient env matching `KEY|PASSWORD|SECRET|TOKEN` is scrubbed for stdio (README:137).
  - Images reach the model "when the current model accepts image input and the harness attachment feature is enabled" (README:87). PNG, JPEG, WebP and GIF only (README:211).
- **Approval for MCP calls.** The pipeline runs `tools/pre-execute` (allow/deny/ask) → guards → `tools/execute` → `tools/post-execute` → `tools/result` (DP\dsh-tools\README.md:89, 109).
  - `ask` goes through `dsh-user-approval`: one-shot grants only, fail-closed (DP\dsh-user-approval\README.md:12, 28, 154).
  - I found no default pre-execute listener that asks for MCP tools. The only pre-execute READMEs are repeat-tool-reminder, tool-web, workspace-changes and auto-review. So an **MCP click runs unprompted** under every preset unless a policy is added (inferred). Presets bundle only sandbox mode and approval policy; there is no per-tool class (DP\dsh-permission-presets\README.md:32-49, 133).
- **Image-capable models.** The default catalog has `deepseek-flash` ("DeepSeek-V4.1-Flash", `inputModalities:["text","image"]`) and `deepseek-v4-pro` (text only) (DP\dsh-llm-deepseek\lib\index.js:43-53). "unlisted model ids [pass] through as text-only routes" (dsh-llm-deepseek\README.md:53).
  - The spec's Maestro choice `deepseek-v4-flash` (§17 Q3) is **not** in that catalog, so screenshots would arrive as placeholders unless `models` is declared (inferred).

### Third-party servers (2026-10-26)

- **microsoft/playwright-mcp**: 38,668★, v0.0.83 (2026-09-28).
  - "No vision models needed… structured data" (README:16).
  - `--headless`, `--isolated`, `--user-data-dir`, `--storage-state`, `--caps vision,pdf,devtools`, `--extension` (attaches to the user's real browser) (README:415-457).
  - A persistent profile is single-instance, so parallel clients need `--isolated` or distinct dirs (README:485).
- **ChromeDevTools/chrome-devtools-mcp**: 54,206★, v1.12.0.
- **trycua/cua**: 31,035★.

### Job Objects

- Chromium puts "Each renderer… in its own Job object" with an active-process limit (chromium.googlesource.com/…/docs/design/sandbox.md). Its behaviour when the browser is already inside a kill-on-close nested job is not documented there (not verified).

## Capability table (today, Windows 11)

| | Claude Code | Codex | DSH |
|---|---|---|---|
| Native browser (model-driven) | Desktop-app pane, clean profile; Claude in Chrome on the real profile (`--chrome`, claude.ai login) | Desktop app: browser plugin (iab, or the user's real Chrome/Edge via extension) through `node_repl`/`cua_repl` `js` | None in the default bundle; `web_fetch` is anonymous, public-only, no JS |
| Native desktop CU | Desktop app on macOS and Windows; CLI macOS only, interactive only; one-session lock | Desktop app, Windows via `@oai/sky` (steals focus) | Optional experimental Cua Driver packages; community plugins are macOS |
| Owned Musician + browser MCP | Yes: SDK `mcpServers` (spec S3 flips `omit`→`set`) or `--mcp-config` | Yes: private `CODEX_HOME` `[mcp_servers.*]` | Yes: ACP `session/new{mcpServers}` (candidate A) or a bundle mount of `dsh-browser-use` + provider (candidate B) |
| Screenshots reach model | Yes (inline, 25k-token cap) | Yes (image content in MCP result) | Only on an image route (`deepseek-flash`) with an attachment store; else diagnostic text |
| Click approval surfaces at | `canUseTool` (SDK) / `PermissionRequest` hook / `requiresUserInteraction` | `approval_mode="approve"` → `mcpServer/elicitation/request` (fallback `item/tool/requestUserInput`) | Nothing by default; needs a `tools/pre-execute` → `ask` → `dsh-user-approval` policy (over ACP presumably `session/request_permission`, not verified) |
| Native CU in an owned Musician | No (pane and CU are desktop-only; Chrome uses the real profile) | No (desktop pipe and env; not verified) | Possible (cua-driver), but shared desktop, no reservation |

**Timeline event names Orchestra would observe**
- Claude: `tool_use.name` = `mcp__<srv>__browser_click` etc. Native-only names, never in owned Musicians: `mcp__Claude_Browser__{navigate,computer,read_page,find,form_input,get_page_text,javascript_tool,preview_start,resize_window}`, `mcp__claude-in-chrome__*`, `mcp__computer-use__*`.
- Codex: `item/started|completed` with `mcpToolCall{server:"playwright"|"node_repl"|"cua_repl", tool:"browser_click"|"js", readOnlyHint, pluginId}`, plus `mcpServer/elicitation/request`.
- DSH: `mcp__<serverName>__<tool>` / `mcp__playwright-mcp__*` / `mcp__chrome-devtools-mcp__*` / `mcp__cua-driver-mcp__*` / `cua_driver_native__*` through `tools/pre-execute`…`tools/result` (in-process), and ACP `session/update` tool_call (not verified).

## Patterns for Orchestra

**Adopt**
1. **Give Musicians eyes and hands as an Orchestra-attached browser MCP, not the vendors' native CU** (§5.4 D5, §8.5, §16 S2/S3).
   - Pin one server (playwright-mcp 0.0.8x, matching DSH's 0.0.80 pin).
   - Inject per Musician: Claude via SDK `mcpServers`; DSH via `session/new{mcpServers}` with an absolute command; Codex via private `config.toml`.
   - The same tool names on all three harnesses give one timeline vocabulary (§11.3, §13.1).
2. **One isolated profile per Musician** (`--isolated` or `--user-data-dir=~/.orchestra/browsers/<musician>`), headless by default (§10.8, §10.11).
   - Logged-in look-ups use a human-supplied `--storage-state` file, stored like credentials (DPAPI).
   - Never use `--extension`, attach mode, Claude in Chrome or the Codex chrome backend on the user's real profile for owned Musicians.
3. **Classify browser tools as read (navigate, snapshot, screenshot) or write (click, type, fill, evaluate, file_upload, CDP)** and send writes to the single D8 queue (§10.9).
   - Claude: `canUseTool`.
   - Codex: `approval_mode="approve"` per write tool, relaying `mcpServer/elicitation/request` into the queue, never auto-accepting (D8). `readOnlyHint` from `mcpToolCall` can pre-label items.
   - DSH: add item ⑧b to the S2 checklist: a canary `browser_click` must produce an approval request. If candidate A cannot install a pre-execute policy, browser tools on DSH Musicians must be read-only (navigate/snapshot only) or wait for candidate B.
4. **Everything a browser tool returns is `tainted`** (§8.5). Add "browser snapshot/screenshot/console" explicitly next to "fetched URL", because DOM text can carry injected instructions; even Anthropic's published post-mitigation figure is 11.2%. A tainted turn cannot trigger write-class browser actions without a fresh human approval.
5. **Governor accounting for images** (§10.2). Screenshots cost visual tokens: Claude 25k MCP cap; DSH 600 images / 20 MiB inline. Prefer accessibility snapshots, which playwright-mcp needs no vision for, and enable `--caps vision` only per task.
6. **Model routing** (§17 Q3). A DSH Musician that must see pixels needs `deepseek-flash` or a declared `models` entry with image input. `deepseek-v4-flash` as written in Q3 is text-only by default.
7. **procguard** (§5.4 D4, S4): launch the browser MCP and its Chromium inside the host's nested kill-on-close Job, and verify in S4 that Chromium's own per-renderer jobs start and get reaped. User-facing or attached browsers stay outside Jobs (§5.4 line 422).

**Avoid**
1. **Native desktop CU for v1 Musicians** (§3.2 "不抓取屏幕内容", §10.8):
   - Codex on Windows activates and steals focus;
   - Claude's CU is a single-session lock and hides apps;
   - DSH Cua leaves coordination to the caller;
   - all of them act on the user's live desktop.

   Make it a §17 decision, M4+ opt-in at most.
2. **Treating the Codex browser and CU confirmation docs as a gate.** They are prompt policy; D8 must still own the decision (§10.9).
3. **DSH's attach mode and single-provider service as a multi-Musician design.** It is per-provider exclusive, and DSH-D#7007, #7169 and #9688 report Windows breakage. Use per-session MCP injection instead.
4. **Answering native site-permission or CU prompts in observed sessions.** Deep-link only (§10.1).

## Verdict on the user's claim

From the harness-capability angle the claim is half right. Out of the box, DSH really cannot do the look-ups the user means. `web_fetch` is anonymous, public-only (localhost dashboards blocked), runs no JS and cannot log in; `dsh-tool-web` and `dsh-web-fetch-http` READMEs. So a DSH Musician today is "blind" for CI pages behind login, local dashboards and UI bugs.

But eyes and hands are not missing from the ecosystem. All three harnesses accept a browser MCP with screenshots and accessibility trees; DSH even publishes experimental Playwright, Chrome DevTools and Cua providers. What Orchestra lacks is not the capability but a safe attachment: per-Musician profiles, D8 gating of clicks, and taint on DOM output.

The vendor-native CU features (Claude's pane, Chrome and CU; Codex's sky and browser plugin) are tied to the desktop apps or to the user's real browser. They are not available to Orchestra-owned SDK, app-server or ACP Musicians, so "real bot" in Orchestra should mean "has an isolated, gated browser MCP." Full desktop CU is a different and riskier capability that most look-ups don't need.

## Open questions

1. Can a private `codex app-server` (0.160.x, own `CODEX_HOME`) load `@oai/sky` or the browser plugin without the desktop app's pipe and env? (not verified, needs a controlled run)
2. Under DSH candidate A (`dsh --profile acp`), can Orchestra add a `tools/pre-execute` ask policy without a bundle? If not, browser tools on DSH Musicians must stay read-only until candidate B is chosen.
3. Does Claude in Chrome work under `-p` / the Agent SDK with `settingSources: []`? Irrelevant if we refuse real-profile use, but it should be confirmed.
4. Is a Chromium sandbox inside a kill-on-close nested Job created suspended by procguard reliable on Windows 11 26200? Add to S4.
5. Does ACP surface DSH `ask` decisions as `session/request_permission` for MCP tools? Verify in S2.
6. Should the human hand over login state (storage-state files) for logged-in look-ups, and how does it rotate? This is a §10.11 extension that needs a decision.
7. Is desktop CU ever in scope (e.g. M4 opt-in for native-app QA)? It needs a §17 entry.

## Sources

- Local files (read only): SKY\package.json; SKY\docs\sky-full-desktop-api.md; sky-window2-api.md; skills\oai_sky_lib\windows\SKILL.md; OB\{browser,computer-use,unified-computer-use}\26.1021.31345\ (plugin.json, .mcp.json, docs\*.md, scripts\extension-ids.json); C:\Users\Calx\.codex\config.toml (lines 1-30, 50-70, 95-125, 190-202); C:\Users\Calx\.codex\computer-use\config.json.
- DP READMEs: dsh-tool-web, dsh-web-fetch-http, dsh-mcp-client, dsh-attachment, dsh-client-ui-sidebar-browser, dsh-permission-presets, dsh-user-approval, dsh-tools, dsh-llm, dsh-llm-deepseek (+ lib\index.js:43-53), dsh-agent-preset\…\references\packages.md.
- npm tarballs (0.2.1-rc.2) in RAW: dsh-browser-use, dsh-computer-use, dsh-experimental-browser-use-{playwright-mcp,chrome-devtools-mcp,stagehand-native}, dsh-experimental-computer-use-cua-driver-{mcp,native}.
- github.com/deepseek-ai/deepseek-harness docs/subsystems/browser-use.md; Discussions DSH-D#3868, #5856, #6799, #7007, #7169, #8095, #9688, #10277, #10741, #10997, #11012.
- code.claude.com/docs/en/{chrome,computer-use,desktop,mcp,hooks,headless,cli-reference}.md (fetched 2026-10-26).
- claude.com/blog/claude-for-chrome (2025-08-25, updated 2025-12-18).
- learn.chatgpt.com/docs/computer-use (via developers.openai.com/codex/app/computer-use).
- openai/codex: codex-rs/app-server-protocol/schema/typescript/v2/{ThreadItem,AppToolApproval}.ts, schema/typescript/ServerRequest.ts, codex-rs/core/src/mcp_tool_call.rs.
- github.com/microsoft/playwright-mcp README; ChromeDevTools/chrome-devtools-mcp; trycua/cua (GitHub API, 2026-10-26).
- chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md.
- Spec G:\_Projects\dsh-orchestra\docs\specs\2026-10-26-dsh-orchestra-design.md §3.2, §5.4 (D4/D5), §7.4, §8.5, §10.1, §10.8, §10.9, §16 S2/S3, §17.
