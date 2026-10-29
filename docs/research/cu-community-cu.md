<!-- Raw researcher report: Opus sweep "community-cu", 2026-10-26. Unedited. Pre-review; synthesized into computer-use.md, which wins where the two disagree. -->

## Identity & scope

This is the practitioner-evidence angle: what people ask for and complain about once their bots get a browser or a desktop, and whether anyone actually holds that a bot without computer use is not a real bot. I swept GitHub issues and discussions on 2026-10-26 using `gh api` title and full-text search, ranked by reactions. I also read official docs and the locally installed Codex browser plugin and `@oai/sky` docs, which I read but did not run. The Chinese forums (V2EX, linux.do, 知乎) mostly could not be verified: searches found no relevant threads and 知乎 returned 403. The Chinese-language evidence below therefore comes from the DSH discussion board.

Repo sizes on 2026-10-26: anthropics/claude-code 153,471★, openai/codex 131,024★, deepseek-ai/deepseek-harness 262,533★ (master `22ddee3792`), openclaw/openclaw 393,155★ (main `e68d555292`), browser-use/browser-use 119,217★, microsoft/playwright-mcp 38,668★, Fei2411/DS-Bot 4,120★.

## Facts

**Volume of demand.** These are GitHub title-search hit counts as of 2026-10-26. They are approximate because they include unrelated hits such as OAuth "browser" login.
- claude-code: "chrome" 1,444 hits; `"computer use"` 177; "browser" 940; "screenshot" 263.
- codex: `"computer use"` 963; "browser" 1,485; "node_repl" 165.
- openclaw: "browser" 2,963; "cdp" 306.
- DSH discussions (full text): "browser" 1,247; "浏览器" 1,263; `"computer use"` 58.

DSH browser and computer-use threads get only 1–5 upvotes each, and none of the ones I read has a maintainer (MEMBER) reply: D#7169, D#6929, D#6956, D#7865, D#6891, D#10229, D#10098, D#3868, D#1561, D#9313.

**What vendors themselves recommend.**
- Claude Code docs, "When computer use applies": "Computer use is the broadest and slowest, so Claude tries the most precise tool first". The order is MCP server, then Bash, then Claude in Chrome, then computer use. "Screen control is reserved for things nothing else can reach" (code.claude.com/docs/en/computer-use).
- OpenAI, "When to use Computer Use": if an app has a dedicated integration, "prefer that structured integration for data access and repeatable operations"; for local web apps, use the built-in browser first (learn.chatgpt.com/docs/computer-use).

**Platform and launch-mode limits that hit bots, not humans.**
- **Claude Code CLI computer use:**
  - macOS only, Pro or Max only.
  - "not available in non-interactive mode with the `-p` flag".
  - "Only one session at a time… A session takes a lock at its first computer use action and releases it when the session exits, not when the task finishes."
  - Browsers and trading platforms are view-only (computer-use doc, "One session at a time", "Differences from the Desktop app").
- **Claude in Chrome:**
  - If you sign in with an API key or `setup-token`, "Claude Code keeps Chrome integration off, even when you pass `--chrome`".
  - It pauses at login pages and CAPTCHAs for the human.
  - "a project can't turn on Claude in Chrome".
  - Enabling it by default "increases context usage" (code.claude.com/docs/en/chrome, Prerequisites / Enable Chrome by default / Troubleshooting).
- **Codex on Windows:** computer use "can't operate in the background while you keep using the same Windows session"; expect it to "move the pointer, type, and take over the foreground"; "Locked use is for macOS" (learn.chatgpt.com/docs/computer-use #windows-foreground-use, #locked-use). The local sky Windows SKILL.md:123 agrees: "input methods activate their target window automatically". Codex added native Windows computer use per maintainer etraut-openai on 2026-08-05 (codex#19305).
- **Codex browser plugin (local):**
  - Background by default: "Keep browser work in the background by default" (`…\browser\26.1021.31345\docs\visibility.md:3`).
  - Explicit tab claiming that fails closed (`tab-claiming-chrome.md:6-9`).
  - Credential handoff that never shows the model the values (`capabilities\tab\browserAuth.md:5-30`).
  - Bot-detection reporting (`capabilities\tab\botDetection.md:2`).
- **Upstream DSH master has opt-in experimental providers; the local rc.2 install bundles none of them.**
  - Browser-use providers: Playwright MCP, Chrome DevTools MCP, Stagehand (`docs/subsystems/browser-use.md:9-15`).
  - Computer-use providers: Cua Driver MCP or native, plus `cua-macos` (`docs/subsystems/computer-use.md:7-27`).
  - "One registered provider does not reserve a desktop for a Session. Callers coordinate complete observe, act, and verify workflows across Sessions" (computer-use.md:35).
  - The decision record rejected a "Session ownership broker… leaving workflow coordination to callers" (`.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md:29`).
  - An attached browser is reserved for one Session; "Separate DSH processes and other clients remain outside this reservation" (browser-use.md:23).
  - The native CUA runtime "shares the host process, so native crashes can terminate that process" (`packages/experimental/computer-use-cua-driver-native/README.md:43`).
  - Application consent goes through User Questions, keyed by signed-executable identity (`2026-09-26-cua-application-consent.md:13-21`).
  - Windows desktop computer use for DSH exists only as a community plugin: "填补 Windows 空白" (D#1561).

**Contention: many agents, one browser or screen.**
- CC#15193 (39 reactions): swarm agents "fight for the same tabs"; the only workaround is separate `--user-data-dir` profiles, which "Loses the seamless 'same session as user' benefit".
- CC#39558: the Chrome extension "steals focus and hijacks keyboard input", and two Cowork tasks "fight each other and the user for the single shared cursor/keyboard".
- CC#87115 lists three takeover dimensions: pointer, focus and input routing, and hiding of other apps.
- playwright-mcp#893: a maintainer says parallel subagents are "a question for Claude". Users work around it with one MCP server per agent plus `--user-data-dir`, or a `tabId` parameter (microsoft/playwright#39703). This is from 2025-08, possibly stale.
- DSH D#10229 「浏览器标签被其他 agent 抢走了」.
- DSH D#10098: the exclusive slot is held "闲置期间也一直占着", and a community provider already added `attachSharing`.
- DSH D#7857: in 0.1.7-rc.2 a startup "会话恢复/播种" activation grabs the exclusive slot and never releases it. Logs show playwright tools called 0 times against 185 cua calls.
- DSH D#7169 (3 upvotes), D#6929, D#6956: once one agent holds the browser, every new session creation fails or hangs.
- OC#105356: tab creation stole focus because CDP `Target.createTarget` defaulted to foreground.

**Screenshots bricking sessions and bloating storage.**
- CC#13480 (90 reactions): one oversized image makes "all subsequent requests" fail.
- CC#37418: a 4K MCP screenshot hits the 20 MB limit and the "session becomes completely unusable".
- CC#21230: "Context limit reached" at 25% usage after a Playwright screenshot of about 1,900 tokens.
- codex#31040: compaction re-embeds screenshots; one rollout reached 3.9 GB with "81 `data:image` base64 payloads" in one record, then 10–20 GB RSS and a kernel panic.
- DSB#560: ds-bot 0.2.2 `browser_screenshot` wrote an inline-base64 block that made every later request fail. DSB#578 fixed it by storing screenshots as attachments and repairing persisted blocks.
- DSH D#5728: 2048 px normalization breaks Anthropic's 2000 px many-image limit, causing a "permanent session lockup".
- Tool-catalog cost:
  - DSH CU registers 55 tools, about 23.5k tokens per request; the browser group alone is about 4,780 (D#7080).
  - `@playwright/mcp` uses 4,024 tokens across 24 tools (playwright-mcp#1714, measured 2026-08-16).

**Tools or approvals missing when the bot isn't the foreground interactive session.**
- codex#49458 (26 reactions, 97 comments): tasks started by a "dot" on Windows get no `node_repl`/`cua_repl`, while ordinary sessions do.
- codex#33599: the Desktop app silently fails to attach node_repl to new tasks.
- codex#37180: the Windows approval prompt "never appears".
- CC#103373: `request_access` is "auto-denied without any prompt" when the session is driven from a Projects thread.
- CC#87340 and CC#99609: computer-use access can't be approved from Remote Control mobile.
- CC#64433: a 900 s idle timeout tears down the computer-use connector and never re-registers it.
- CC#78142: browser-pane read tools are blocked because "approval card never appears" in Auto mode.

**Leaks and runaway processes.**
- codex#17832: "213 leaked `npm exec @playwright/mcp`… pairs… 13.6 GB of RSS" from subagent teardown. A maintainer PR is pending (openai/codex#19753).
- codex#28352: headless Chrome workers outlive the session.
- OC#79960: a stale `SingletonLock` led to 397 failed spawns and a host reboot from OOM.
- DSH D#7865: a failed Playwright MCP startup fails every session and leaves orphaned browser processes.

**Privacy and authority.**
- codex#24433: Codex Desktop `ambient_suggestions` used computer use on the user's real Chrome to open Gmail "without a visible user-initiated task".
- codex#29343: Taobao and 1688 are blocked server-side: "Browser Use is not permitted on https://detail.1688.com".
- OpenClaw recommends manual login in a dedicated `openclaw` profile, because "Automated logins often trigger anti-bot defenses and can lock the account" (docs/tools/browser-login.md:8-12, commit 03af81024d).
- OC#44635 asks for a per-agent `userDataDir`. OC#75879 asks for a headed handoff "If the agent gets stuck, hits auth/2FA/CAPTCHA".

**The look-up ("查询") jobs people actually show.**
- DSH D#10996 (dsh-chrome-control, community, MIT) opens with the user's exact complaint: 「你让 Agent 去公司后台查本周数据，它回你一句「需要登录」」. Its examples: summarize this week's 47 tickets from the ticket backend; export orders and compute refund rate per channel; check the landing page for mobile overflow. It works in background tabs of the user's real Chrome.
- DSH D#10997 (Kimi CU, macOS) uses the accessibility tree first and screenshots only for canvases and charts, "不移动你的鼠标指针". Its example: copy rows from an internal client with no export.
- The Claude Chrome doc lists: authenticated Gmail, Notion and Docs "without API connectors"; console errors on a dashboard; data extraction to CSV; calendar look-ups.
- DSH D#5856 (WebMCP): turning verified page actions into tools cuts repeated page reads. Its bench has 49 tasks covering "查询、搜索、购物…".

**DS-Bot already treats eyes as a per-Bot policy.** DSB#32 (open PR) gives each Bot a mode: Off (default), Look only, or Act with approval. Acting is "allowed only in the Bot's own chat. In a group Session or a subagent… the Bot can only look", and subagents inherit the mode. DSB#451 gives each Bot its own persistent sandboxed browser partition. DSB#461 imports cookies with a preview and without logging values.

## Patterns for Orchestra

**Adopt**
1. **Eyes lease broker in the Post Office.** Touches §10.2, §3.1 rule 4 and §6.1 (new `Lease{resource: browser-profile|tab|desktop, holder, since, idleRelease}` entity). DSH explicitly leaves "workflow coordination to callers" (decision record :29). Claude holds its lock until session exit, and DSH slots stick while idle (D#10098, D#7857). Orchestra should queue rather than fail, release on idle, and show the holder (inferred).
2. **Per-Musician `eyes` mode: off / look / act-with-approval.** Touches §6.1 Musician, D5 and D8/§10.9. Acting only where the human can see the approval card, with subagents inheriting the mode, matches DSB#32. Codex can already gate individual browser tools via `approval_mode` (given).
3. **Everything seen is tainted.** Touches §8.5. Screenshots, accessibility trees and page text from any app count as `provenance:url|app`. A tainted turn may look but not act or type (inferred from codex#24433 and the CC computer-use warning).
4. **Images by reference only.** Touches §8.1 and §6.1 redaction/TTL. The envelope `body` stays text; screenshots go in `refs` pointing to a purgeable attachment store, with dimensions capped at ≤2000 px. Add a "poisoned image" detector to `failure` items. Evidence: CC#13480, codex#31040, DSB#560/#578, D#5728.
5. **New InboxItem kind `handoff`** (login, 2FA, CAPTCHA, site blocked, approval card not visible), filed in Fermatas. Touches §11.2 and §6.1 InboxItem. Evidence: Chrome doc, OC#75879, codex browserAuth, CC#78142.
6. **Reaper and runaway cover bot-owned browsers.** Touches §10.3 and §10.4. Count Chromium/Playwright descendants and stale `SingletonLock`s. Headless browsers the bot owns go inside the host Job; a user-facing browser still never does (§5.4). Evidence: codex#17832, OC#79960, D#7865.
7. **Stage and Ledger.** Touches §11.3 and §10.12. Add a "spotlight" badge for whoever holds the screen or browser, and meter screenshot count and image tokens per Part.

**Avoid**
- Desktop computer use from owned Musicians on your own Windows session while you work. On Windows it is foreground-only by design (learn.chatgpt.com). This extends the §3.2 non-goal "v1 不做无人值守".
- Attaching bots to your main Chrome profile by default. Use a dedicated profile per Musician (OC docs, DSB#451). This touches §10.11.
- Relaying any computer-use approval through A2A or MCP. Approvals stay native or in the Orchestra UI (D8, §10.9).
- Orchestra itself looking at the screen. Keep the §3.2 rule 「不抓取屏幕内容」: Orchestra brokers the leases and never sees the pixels.

## Verdict on the user's claim

The claim is partly supported and mostly refuted as stated. Demand is real: thousands of browser and computer-use issues across Claude Code, Codex and OpenClaw, and DS-Bot built per-Bot browsers. The most common look-up complaint is literally 「它回你一句『需要登录』」 (D#10996). So a bot with no authenticated way to read web pages is weak at look-ups.

But nobody in the material I swept says that without computer use a bot is not a real bot. Both vendors' own docs rank desktop computer use last, as "broadest and slowest", and say to prefer structured integrations for data access. The recurring look-up jobs split three ways:
- **API or CLI:** CI status (`gh`), ticket systems with APIs.
- **Logged-in browser read via the accessibility tree or text:** dashboards, SSO docs, ERP/OA, price checks.
- **Pixels or desktop only:** canvases and charts, apps with no API, chat clients, reproducing visual UI bugs.

The practitioner record shows "eyes and hands" are dangerous for multi-bot setups: shared-screen contention, session-bricking screenshots, approvals that never surface, and leaked browsers. A better rule (inferred): a real bot needs a leased, logged-in, look-first browser path plus a human handoff; desktop computer use is an optional, leased, foreground capability.

**Requirements delta (proposed R42+):**
- **R42 (P0): eyes leases.** Exclusive, queued, idle-released leases on browser profiles, tabs and the desktop, with the holder visible. Evidence: CC#15193, CC#39558, PW#893, D#10229, D#7857, DSH decision record :29.
- **R43 (P0): per-Musician eyes mode** (off / look / act-with-approval). Act only where the approval is visible; subagents inherit; tainted turns look only. Evidence: DSB#32, codex#24433, CC#103373.
- **R44 (P1): look-up ladder in AutoRoute and Musician capability.** Order: API/MCP, then fetch, then browser accessibility tree or text, then screenshot, then desktop. The roster shows which rung each Musician can actually reach in its launch mode. Evidence: CC and OpenAI docs, codex#49458, Chrome off with API-key auth.
- **R45 (P1): images by reference.** Size caps and poison detection. Evidence: CC#13480, codex#31040, DSB#560.
- **R46 (P1): `handoff` inbox kind** for login, 2FA, CAPTCHA and site blocks. Evidence: Chrome doc, OC#75879.
- **R47 (P1): reaper covers bot browsers and stale profile locks.** Evidence: codex#17832, OC#79960, D#7865.
- **R48 (P2): image-token and tool-prefix metering.** Evidence: D#7080 (23.5k tokens), playwright-mcp#1714.

**The three most common failure stories:**
1. **"They fought over one browser or screen."** Root cause: the browser or desktop is one stateful resource; harness locks are per-process or per-provider, held until session exit, and nobody brokers them across sessions.
2. **"One screenshot killed the session or the disk."** Root cause: images are persisted inline in durable transcripts and replayed on every request and compaction, with validation done after they are persisted.
3. **"The bot had no eyes, or the approval never appeared, when it ran spawned, remote or headless."** Root cause: computer use is tied to an interactive foreground host with OS permissions and a native approval UI. Orchestra-spawned SDK, ACP or app-server sessions are exactly the class that loses it (inferred for Orchestra).

## Open questions

- Do Orchestra-owned Claude Musicians (Agent SDK) get Claude in Chrome or computer use at all? The CLI version needs an interactive session (not `-p`) and `/login`, not an API key. Not verified for the SDK path.
- Does a Codex `app-server` thread driven by Orchestra (spec Q1) expose `node_repl` browser and computer-use tools? codex#49458 and #33599 suggest non-default launch paths lose them. Not verified.
- Does the DeepSeek model on your DSH route accept image input? `dsh-llm` validates input modalities (given). If it doesn't, DSH Musicians can only look via the accessibility tree or text.
- Does Chromium's sandbox behave inside procguard's nested kill-on-close Jobs? Not verified.
- For foreground desktop computer use on Windows: would you accept a separate Windows VM or second user session, which is what OpenAI suggests for unattended tasks?
- Does a per-Musician browser profile with cookie import (the DSB#461 pattern) conflict with §10.11's read-whitelist and credential rules?

## Sources

- Local: `G:\_Projects\dsh-orchestra\docs\specs\2026-10-26-dsh-orchestra-design.md` §3, §5.4, §6.1, §8.1, §8.5, §10, §11.1–11.3, §13.1, §16, §17; `docs\research\requirements.md:30-57`; `docs\research\bot-architectures.md:120-130`; `docs\research\ds-bot.md:116`
- Local Codex: `C:\Users\Calx\.codex\plugins\cache\openai-bundled\browser\26.1021.31345\docs\{visibility.md, tab-claiming-chrome.md, screenshots.md, capabilities\tab\browserAuth.md, capabilities\tab\botDetection.md}`; `C:\Users\Calx\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node_modules\@oai\sky\docs\skills\oai_sky_lib\windows\SKILL.md:123`
- Docs: https://code.claude.com/docs/en/computer-use ; https://code.claude.com/docs/en/chrome ; https://learn.chatgpt.com/docs/computer-use
- DSH master `22ddee3792`: `docs/subsystems/computer-use.md`, `docs/subsystems/browser-use.md`, `docs/upgrade-guide/v0.2.1-rc.2/cua-preset-scope/guide.md`, `.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md`, `…/2026-09-26-cua-application-consent.md`, `packages/experimental/computer-use-cua-driver-native/README.md`
- DSH discussions: D#10229, D#10098, D#7857, D#7169, D#6929, D#6956, D#6891, D#7865, D#7788, D#8927, D#7080, D#5856, D#5728, D#10996, D#10997, D#10277, D#9313, D#3868, D#1561
- anthropics/claude-code: #15193, #39558, #87115, #13480, #37418, #21230, #95580, #28013, #103373, #87340, #99609, #64433, #78142, #57034
- openai/codex: #19305, #20851, #24433, #29343, #31040, #17832, #28352, #49458, #33599, #37180, #13476; PR #19753
- Fei2411/DS-Bot: #32, #451, #461, #560, #578, #278
- openclaw/openclaw: #44635, #79960, #105356, #75879; `docs/tools/browser-login.md` (03af81024d), `docs/tools/browser/isolation.md`
- microsoft/playwright-mcp: #893, #1714; microsoft/playwright#39703
- Secondary only, not verified: https://codex.danielvaughan.com/2026/06/04/codex-computer-use-windows-foreground-desktop-automation-agent-sandbox-permissions/ ; https://zhuanlan.zhihu.com/p/2058555446731003032 (403)
- Downloaded copies (read only): `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\cu\practitioners\raw\`
