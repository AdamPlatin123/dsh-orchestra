<!-- Raw researcher report: Opus sweep "koishi-maibot", 2026-10-26. Unedited except for a stripped harness banner. Synthesized and red-teamed into bot-architectures.md; where the two disagree, the synthesized file wins (see its Review log). -->

# Koishi/cordis and MaiBot: what two Chinese-community bot lineages offer Orchestra

Path keys used below:
- `$DSH` = `C:\Users\Calx\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
- `K/` = `https://github.com/koishijs/koishi/blob/master/packages/core/src/`
- `W/` = `https://github.com/koishijs/webui/blob/main/`
- `M\` = `G:\_Projects\maibot\MaiBot\`, the local snapshot: v0.11.0 (`pyproject.toml:3`), commit 8ca150bf, 2025-10-27
- `MU/` = `https://github.com/Mai-with-u/MaiBot/blob/main/`, upstream v1.3.15 released 2026-10-23 (`gh api .../releases`)

## Identity & scope

| Project | What it is | Stars / license / language / last push (gh api) |
|---|---|---|
| cordiverse/cordis | Plugin and dependency-injection kernel (context, fiber, services, events). Packages: core, loader, include, group, timer, hmr, fs-node, logger-console, create | 9,410 / MIT / TS / 2026-10-26 |
| koishijs/koishi | Cross-platform chatbot framework, core 4.18.11 | 6,288 / MIT / TS / 2026-10-08 |
| satorijs/satori | Adapter protocol layer for Koishi. The repo has 15 adapters (qq, telegram, discord, slack, lark, kook, matrix, wecom, …) | 263 / MIT |
| koishijs/webui | Koishi Console and plugin market | 40 / **AGPL-3.0** / Vue |
| Mai-with-u/MaiBot | Persona agent for QQ group chats | 6,607 / **GPL-3.0** / Python / 2026-10-26 |
| MaiBot-Napcat-Adapter | Bridge from OneBot (Napcat) to maim_message | 88 / no license detected |
| maim_message | WebSocket message bus library | 13 / MIT |

**Confirmed: DSH's kernel is cordis. DSH does not descend from Koishi.**
- `$DSH\cordis\package.json`: version 4.0.5, author "Shigma <shigma10826@gmail.com>", MIT, repository directory `vendor/cordis` inside deepseek-harness. `$DSH\cordis\LICENSE:3` reads "Copyright (c) 2021-present Shigma".
- The vendored `src/` has the same 9 files as upstream `packages/core/src` (context, events, fiber, index, logger, reflect, registry, service, utils). The `FiberState {PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING}` enum is identical (`$DSH\cordis\src\fiber.ts:147-153` vs upstream `fiber.ts:90-97`). A diff of `context.ts`/`index.ts` shows mostly added JSDoc, `@deepseek-ai/cosmokit` imports, and a public `root` property.
- `$DSH\cordis-plugin-loader\README.md:1` still carries the upstream title `@cordisjs/plugin-loader`. The packages group 1.0.5, include 1.0.10, loader 1.0.6, timer 1.1.7, cosmokit 1.8.6 and schemastery 3.18.5 are all authored by Shigma under `vendor/*` (each `package.json`).
- The timer's `setTimeout/setInterval/throttle/debounce` are "disposed with the current fiber" (`$DSH\cordis-plugin-timer\lib\types\index.d.ts:3-27`).
- Koishi 4.18.11 depends on `cordis ^3.18.1` (`koishijs/koishi/packages/core/package.json`); DSH runs cordis 4.x. DSH's `node_modules` has no `@satorijs`, `@minatojs` or `koishi` (checked). So DSH and Koishi are **siblings on the same kernel**. Koishi's bot layer (adapters, Session, middleware, commands, database) is not part of DSH. DS-Bot is effectively a Koishi-style bot layer rebuilt on DSH services (inferred).
- What this means for Orchestra: cordis lifecycle rules apply directly to the private-home bundle. Every effect is owned by a fiber. `inject` gates start-up. Services can disappear across an `await` (own-blocks.md:102).

## Architecture facts

### Koishi

- **Identity.** `User{id, authority, permissions}` plus `Binding{aid, bid, pid, platform}`; lookups go from (platform, pid) to aid (`K/database.ts:41-66, 155-171`).
  - Cross-platform binding uses a `bind` challenge: a token is sent from the original platform within 5 minutes, then confirmed from the target platform (a group chat asks for a second confirmation). The target account's data is overwritten by the original (https://koishi.chat/zh-CN/manual/usage/platform.html).
- **Session.** One Session per inbound event. `stripped{hasAt, atSelf, appel, prefix, content}` is derived only from **leading** `<at>` elements, or from the bot's nickname followed by a comma or space (`K/session.ts:138-187`). `session.prompt()` installs a temporary middleware scoped to the session's `fid`, with a default timeout of 1 minute (`session.ts:436-472`; `context.ts:190`).
- **Middleware chain.** `Next.MAX_DEPTH = 64` throws "middleware stack exceeded" (`K/middleware.ts:36-37, 250-254`). A bot ignores its own messages (`:235`). There is a `maxListeners` leak warning at 64 (`context.ts:195`). I found no other guard against bot-to-bot loops (inferred).
- **Who answers in a group.** Each channel has an `assignee` (a bot's selfId). Unless the channel's assignee is this bot, or the message @-mentions this bot, `attach` returns early (`K/middleware.ts:210-212`). `autoAssign` defaults to true, which makes the first bot to receive a message the assignee (`context.ts:179`; `session.ts:240-242`). Channels also have `ignore` and `silent` flags (`middleware.ts:211`; `database.ts:226`).
- **Command routing.**
  - In guild chats a command needs a prefix or a direct address. `prefixMode: 'strict'` requires the prefix (`context.ts:173-177`; `command/index.ts:60-61, 291-293`).
  - A message that @-mentions someone else is skipped (`command/index.ts:86-87`; `session.ts:503-504`).
  - Filters (`user/guild/channel/platform/private` with union, intersect and exclude) create scoped contexts (`K/filter.ts:23-31, 62-98`).
- **Permissions.** Authority levels 0–4 plus a permission graph with `inherits` and `depends` edges (`K/permission.ts:26-27, 48-53, 132-140`).
- **Console (plugins adding UI).**
  - Server side: `ctx.console.addEntry(files, data)`, `addListener(event, cb, {authority})`, and `DataService` objects that push `refresh`/`patch` (`W/packages/console/src/index.ts:96-120`, `service.ts:6-35`).
  - Client side: `ctx.page({path, name, order, authority, fields, when, disabled})` and `ctx.slot({type, component, order, when})` (`W/packages/client/client/plugins/router.ts:18-44, 163-177`). A page stays disabled until every key in its `fields` exists in the store (`router.ts:95-99`). `ctx.action(id, {shortcut, hidden, disabled, action})` and `ctx.menu` are also available (`action.ts:8-32, 119-123`).
  - Bundled console plugins include sandbox ("Test Your Virtual Bot in Console"), insight ("plugin dependency graph"), status, analytics, notifier and logger (`W/plugins/*/package.json`).
- **Market conventions.**
  - The package manifest field `koishi.{service:{required, optional, implements}, insecure, hidden, preview, browser, category, locales}` declares dependencies and flags. Descriptions are cut to 1024 characters. Keywords such as `required:` and `impl:` are parsed (`W/packages/registry/src/utils.ts:34-75`).
  - The index shows score, rating, `verified`, `portable`, `insecure` and downloads (`types.ts:118-135`).
- **Compare with DSH.** DSH client slots are a typed `SlotMap` built by declaration merging, with `kind: 'single'` and `scope: 'session'` (`$DSH\dsh-client-ui-approval\lib\types\client\contract\slots.d.ts:12-24`). BSB's `registerTab` is the equivalent "plugins add to a plugin" hook (landscape.md:4). DSH's manifest compatibility "is declarative"; installers do not enforce `engines.dsh` (`$DSH\dsh-package-manifest\README.md:93`).

### MaiBot (local 0.11.0, then upstream changes)

- **Transport.** Adapter → maim_message WebSocket `Router` → core (`G:\_Projects\maibot\maim_message\README.md:10-11, 87`). It reconnects with exponential backoff (`ws_connection.py:580-586`). A grep found no ack, receipt or idempotency logic.
- **The adapter is closed by default.** `group_list_type = "whitelist"` with an empty list; the same applies to private chats and a ban list (`MaiBot-Napcat-Adapter\template\template_config.toml:18-28`).
- **Inbound pipeline.** Pre-process event → ban words and regex → plugin Commands, which are deterministic and may `intercept_message` → `ON_MESSAGE` → heartflow (`M\src\chat\message_receive\bot.py:87-135, 210-280`).
- **Session model.** One loop per chat stream: `HeartFChatting` for groups, `BrainChatting` for private chats (`src\chat\heart_flow\heartflow.py:19-35`).
- **How 0.11.0 decides not to speak** (`src\chat\heart_flow\heartFC_chat.py`):
  1. **`no_reply_until_call` latch.** The bot stays silent until it is @-mentioned or named, ≥8 new messages arrive, or 600 s pass (`:225-240`).
  2. **Mentions force a reply** when `mentioned_bot_reply` is on (`:244-254, 396-405`).
  3. **Otherwise a random draw.** It replies only if `random() < talk_value × frequency_adjust`; if not, it sleeps 10 s (`:255-264`). `talk_value_rules` set the value per chat and per time of day (`template\bot_config_template.toml:88-108`).
  4. **An LLM tunes frequency.** At most every 120 s, and only with more than 5 new messages, a small LLM is asked whether users find the bot "过于频繁/过少" (too frequent / too quiet). The factor is multiplied by 0.8 or 1.2 and clamped to 0.1–3.0 (`src\chat\frequency_control\frequency_control.py:58-121`).
  5. **The planner LLM picks the action:** `reply`, `no_reply`, `no_reply_until_call`, or a plugin action. Invalid or failed output falls back to `no_reply` (`src\chat\planner_actions\planner.py:46-75, 188-197, 515-524`).
  6. **`planner_smooth`** sets a minimum cycle time (`heartFC_chat.py:477-482`; template:93).
  - Plugin actions only reach the planner through activation types NEVER, ALWAYS, LLM_JUDGE, RANDOM or KEYWORD (`src\plugin_system\base\component_types.py:31-39`).
  - **History.** The earlier "willing" model (per-chat willingness that decays ×0.9/s, plus interest, plus a bump when mentioned) was deleted on 2025-08-11 (commit 1f91967d; see `git show 1f91967d^:src/chat/willing/mode_classical.py`). The changelog for 0.10.3 says "移除激活度系统，现在回复完全由planner控制" (activation system removed; replies now fully controlled by the planner) (`changelogs\changelog.md:34`).
- **Upstream 2026 adds deterministic gates in `maisaka/turn_trigger`:**
  - A logistic "reply likelihood" gate. Its weights were "由…Planner 首轮记录拟合得到" (fitted from logged first-round planner decisions), and @-mentions bypass it (`MU/src/maisaka/turn_trigger/reply_likelihood.py:1-6, 21-30, 74-88`).
  - An adaptive threshold that keeps actual replies close to expected × frequency over a 3600 s window. Below 20 scored batches it falls back to a static offline table (`dynamic_gate.py:1-28`).
  - Exponential idle backoff after consecutive no-action cycles, skipped once enough messages are pending (`idle_backoff.py:24-34, 65-91`).
  - Fixed message debounce: the whole batch is capped at 8 s and an @-mention at 1 s; same-sender and different-sender messages get different windows; no model calls (`MU/src/chat/debounce/README.md`).
- **Memory.**
  - `MemoryChest` keeps running content per chat_id. It rebuilds on thresholds of message count combined with quiet time, merges memories by title with an LLM, and answers by question lookup (`src\memory_system\Memory_chest.py:27-120, 224, 433-705`).
  - Hippocampus was removed on 2025-09-29 (commit e2310de6).
  - LPMM (OpenIE + knowledge graph + PPR + embedding QA) is off by default (`src\chat\knowledge\qa_manager.py`, `kg_manager.py`; template:162-176).
  - Upstream now ships `src/A_memorix`.
- **Expression learning.** Per chat stream it learns situation→style pairs, gated by a minimum interval and message count (`src\express\expression_learner.py:99-128, 163-236`). Scope is configured with `learning_list` rows of [stream, use, learn, intensity] and with `expression_groups`, which share learned styles across streams (template:66-87).
- **Relationships.**
  - Identity is `person_id = md5(platform_userid)`, per platform, with no cross-platform merge (`src\person_info\person_info.py:25-31`).
  - A person is registered automatically on their first message (`heartflow_message_processor.py:86-90`).
  - The `[relationship]` config section is marked "此系统暂时移除" (temporarily removed) (template:243-245).
- **Schedule, mood and proactive speech.**
  - There is no schedule module; `SCHEDULER` is reserved (`component_types.py:23`).
  - Mood is per chat and reverts toward neutral every 45 s, at most twice; it is off by default (`src\mood\mood_manager.py:176-193`; template:131-132).
  - Proactive "curious" questions fire with a probability of 3e-5 to 3e-4 per loop, rising with idle time (`heartFC_chat.py:187-218`).
- **Budgets.** There are no spend caps: a grep finds only Gemini's thinking budget. Every LLM call carries a `request_type` tag (`frequency_control.py:45-47`, `Memory_chest.py:30-37`), aggregated into an HTML report (`src\chat\utils\statistic.py:137-142`).
- **Robustness.** A crashed loop restarts after 3 s with no limit (`heartFC_chat.py:497-501`).
- **Upstream plugin isolation and UI.**
  - Plugins run in a Runner subprocess with a session token regenerated per spawn, a list of trusted directories, and host-version checks (`MU/src/plugin_runtime/__init__.py:12-40`).
  - The plugin WebUI schema v2 offers two kinds of page. Declarative pages are built from stack, grid, tabs, table, chart, button and similar blocks. Custom pages are isolated HTML, ≤2 MiB, with a declared capability list (`MU/src/plugin_runtime/webui_schema.py:1, 16-20, 326-437`).

## What Orchestra should lift / avoid

**Lift**
1. **Treat Koishi's assignee as the Room admin.** Two independent lineages, Koishi assignee and DS-Bot admin mode, arrived at the same rule: unaddressed messages go to one designated responder, and addressed messages go to whoever is mentioned. This supports keeping §9.2 step 4. Have the human set `adminMusicianId`; do not copy `autoAssign`, where the first bot to receive a message wins (non-deterministic across restarts, inferred).
2. **Only leading mentions route.** A message is addressed only by a leading `@` or name-plus-comma. A leading `@other` suppresses the admin's default reply (Koishi `session.ts:154-187`, `command/index.ts:86-87`). A mention inside a body, such as an agent quoting "@Ren said…", is a reference, not a route. This prevents fan-out from agent prose. Apply it when deriving `to.mentions` (§8.1) and in RoomRouter.
3. **Strict prefix for room commands.** Following Koishi's `prefixMode: 'strict'`, `/continue` and `/decide` should parse only from human-trust messages that carry an explicit prefix. Agent text never parses as a command (consistent with §8.5).
4. **Add a "quiet until called" latch alongside `[PASS]`.** Use MaiBot's `no_reply_until_call` with deterministic exits: an @-mention, a human message, N new messages, or T elapsed. In `everyone` mode, a musician that PASSes K times in a row latches. Add upstream's exponential idle backoff that is skipped when enough messages are pending. This targets the cost of every speaker rereading its own context [bot].
5. **Fail silent.** MaiBot maps planner or parse failure to `no_reply`. For Orchestra: a RoomRouter or Maestro failure means PASS inside a room, and a `route-ask` InboxItem for a direct request. It never "picks someone anyway".
6. **Debounce with hard caps.** Extend Post Office rule 4 (merge per sender) with MaiBot's batch window: continue the window for the same sender, cap it absolutely at 8 s, and give mentions or human messages a fast path of 1 s or less. This handles human typing bursts and members fanning in to the admin.
7. **Gates fitted from logged decisions.** MaiBot fitted its pre-planner gate from logged planner outcomes and falls back to a static table below 20 samples. This is the same shape as AutoRoute's path from labels to the Wilson gate to `no-route`. It supports logging RouteDecisions from M1 and suggests adding a static fallback table below N samples.
8. **Separate read and write per memory scope.** Copy the `learning_list` [use, learn] split and the `expression_groups` share groups: each `memoryScopes[]` entry gets separate `read` and `write` flags plus a named share group (project or section), rather than one global pool.
9. **Tag every LLM call with its purpose.** MaiBot's `request_type` maps to a Ledger `purpose` field (maestro.route, steward.handoff, review), so the daily CNY cap can be attributed.
10. **Bind identities by challenge.** Koishi's aid ↔ (platform, pid) is the same shape as Musician ↔ Part. Its `bind` flow (a one-time token posted from both sides, 5-minute lifetime) suggests a UX for promoting an observed or `unbound` session to a bound Musician: Orchestra shows a code, you paste it into that session, and the observer sees it in the log and binds them (inferred).
11. **Two tiers for plugin-contributed UI.**
    - Declarative panels: rendered by Orchestra from daemon data services, and shown only when their required capability exists (Koishi's `fields` gate maps to D12's capability registry). They are removed when the plugin unloads (cordis effects).
    - Custom pages: only in a sandboxed iframe on a **different origin** from the paired-cookie UI (D8), following MaiBot's declarative-versus-isolated split.
    - Koishi's `action({shortcut})` registry maps onto §11.9 shortcuts.
12. **Tuning features worth copying.** Koishi's sandbox ("test your virtual bot") becomes a zero-token rehearsal chat with a virtual musician. Koishi's insight graph becomes a view of the bundle and service dependency graph.
13. **Enforce `engines.dsh` ourselves.** DSH does not enforce it (`README.md:93`). The Orchestra bundle should refuse to start on a version mismatch (D12).

**Avoid**
- Random speak probability and LLM self-rating of frequency. Both are unauditable and conflict with principle 5 and §9.2 step 7 ("reject model self-assessment").
- Unbounded crash-restart loops (`heartFC_chat.py:497-501`). Restart with backoff and raise an InboxItem.
- Proactive "curious" speech for coding musicians. Reminders stay explicit.
- LLM-merged memory as a source of decisions (MemoryChest merges by title). This is R12 pollution; only human Decisions get injected.
- A transport without receipts or idempotency (maim_message).
- Running plugin JavaScript in the same origin as human-verb buttons. Koishi's console loads plugin entries into the console app (inferred from `addEntry`).
- Copying code. koishijs/webui is AGPL-3.0 and MaiBot is GPL-3.0, so borrow design only. Koishi core, cordis and satori are MIT.

## Open questions
1. Could cordis `ctx.isolate`/`ctx.intercept` (`$DSH\cordis\src\context.ts:121-144`) scope Orchestra services per musician inside one DSH host, instead of relying only on per-Part tokens? This needs testing in S2.
2. Should `everyone` mode ship in M3 at all? MaiBot moved from random draws to a fitted gate only after months of logs. Admin-only plus @-mentions may be enough at first.
3. Does DS-Bot's `src/shared/mentions.js` (ds-bot.md:142) treat body mentions as addresses? If so, it conflicts with lift #2. Check this before reusing its semantics.
4. Can an agent-created Room (`orchestra_post_room`) name its own admin, or only the human?
5. Are Koishi console plugin entries in the same JS realm as the console app? I assumed yes and did not verify.
6. Upstream MaiBot `maisaka` (`subagent_tasks.py`, `reasoning_engine.py`) is moving toward an agent loop with sub-tasks. It is relevant to merging dynamic Workflow, but I did not study it here.

Scratch copies of the fetched upstream sources are in `C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\` (folders `cordis-up`, `koishi`, `webui`, `maibot-up`).