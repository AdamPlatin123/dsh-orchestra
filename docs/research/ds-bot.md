## Facts

Path shorthands: `DSB` = G:\_Projects\DS-Bot (upstream Fei2411/DS-Bot @73fed3a), `H` = DSB\ds-bot\src\host, `P` = DSB\docs\plans, `REP` = G:\_Projects\DSH-plugins\reports\deepseek-bot-fork.

**Versions and what the user actually runs**
- The upstream repo was renamed from DeepSeek-Bot to DS-Bot. The plugin `ds-bot` is at 0.2.2 and targets DSH 0.2.1-rc.2 (DSB\ds-bot\package.json; git commit 6a773c8).
- The user's live DSH Web profile runs the **fork**, not upstream: `~/.dsh/profiles/web/package.json` has `"ds-bot": "link:G:/_Projects/DSH-plugins/deepseek-bot-fork/ds-bot"`, and the resolved version is `0.1.7+fork.1`.
- The fork is upstream v0.1.7 plus one branch, `fix/permission-switch-race` (4 files, +102/-18, from `git diff a9052f4 HEAD`).
- Upstream 0.2.2 still has the unguarded `presets().set(...)` after an `await` (H\permissions.js:23-26), so the user's fix was never merged upstream.
- Running 0.1.7 means the user lacks the 0.2.x reliability fixes: `request_id` idempotency, `handoff-results/`, settling replies from the session log, and the memory `pending.json` (DSB\CHANGELOG.md:7-64; P\2026-10-16-bot-handoffs.md:130-133).

**Plugin structure**
- DS-Bot is a Cordis DSH plugin with two facets:
  - A host facet, `index.js`. It injects `llm, tools, systemPrompt, sessionController, sessions, sessionTitle, workspaceRegistry, connection` and installs 34 modules in order (DSB\ds-bot\index.js:43-49).
  - A web client facet, `client.js`, declared via `dsh.client.platform: "web"`, plus a bundle patch `cordis.patch.yml`. The patch also mounts a second plugin, `ds-bot/web-search` (DSB\ds-bot\package.json, cordis.patch.yml:3-19).

**Bot identity and persona**
- Each Bot is a DSH root Session in a workspace named "DS Bot". The Bot id is the id of its first Session (H\roster.js:79-87, 149-151). Live bot ids are `session-…`.
- The persona is a system-prompt section `bot-identity` (order 640): "You are {name}… Your role…", then the instructions, then TEAM_RULES, plus MAIN_RULES for Main Bots. The text depends only on the Bot record, so the cached prompt prefix stays byte-identical (H\prompt.js:1-2, 44-72).
- Each Bot owns its model, effort, permission, workDir and capabilities, and does **not** follow DSH defaults (P\2026-10-10-bot-runtime.md:11, 19-27).
- Live bot record keys: `id,name,role,color,avatar,instructions,createdAt,createdBy,capabilities,model,appliedModel,effort,appliedEffort,permission,workDir,segments,sessionId`.

**Chief and Main Bots**
- On first open the plugin creates a Main Bot named "Chief" with the role "Chief of Staff" (index.js:64-67).
- Main-only powers are `create_bot`, changing other Bots, `stop_bot`, and managing any group. More than one Main Bot is allowed. Only the user can delete a Bot (H\prompt.js:27-38; DSB\docs\vision.md:24-25).
- The 26 team tools are listed in H\constants.js:64-71. They are hidden from plain "DSH Agent" sessions via `agent.ctx.tools.restrict({deny})` (H\agents.js:45-62).

**Bot-to-bot messaging: messages, not execution requests**
- The tool signature is `message_bot(to, message, reply_to: me|user, when: now|queue, request_id)` (H\tools.js:141-268).
- Delivery uses `createUserMessage` with `source:{kind:'bot', form:'relay', role, exchangeId, senderName,…}`. It is injected with `agent.steer()` (mid-turn, at the next step) or `agent.followup()` (next turn), after `ctx.sessionController.resolveAgent()` (H\delivery.js:51-103).
- Messages carry header lines such as `[Message from X]`, `[Reply from X]` and `[Stopped by X]` (delivery.js:17-34).
- A turn opened by a request automatically sends its final text back to the sender (H\turns.js:27-40, `answerSender`).
- **Handoff tree.** If B passes work on, B's reply to A is held until every sub-task returns. Messaging a Bot upstream that is waiting on the same work is refused. Unread messages from the same sender are merged into one. There are no hop or count caps, and the waits are kept in `state.json.works` (P\2026-10-16-bot-handoffs.md:51-108; tools.js:226-229).
- **request_id.** The same name with the same payload replays the original receipt. The same name with a different payload is refused. An uncertain outcome is never resent (tools.js:166-186).
- **Status per Bot**, in priority order: waiting for approval > switching part > working (where, how long, which tool, for whom) > waiting on another Bot > idle.
  - It is exposed through `list_bots` and in `message_bot` results.
  - It is deliberately kept out of the prompt so the prompt cache holds (bot-handoffs.md:28-45).

**Group routing: deterministic code, not LLM auto-routing**
- A group is its own Session (room id = session id) and never calls a model: an `llm/stream` middleware fakes a `group_relay` tool call (H\groups.js:964-998).
- Each member has a hidden Session per group (`room.sessions[botId]`), so a group never sees a Bot's private chat. `read_own_chat` is the only bridge, and the group can see when it is used (groups.js:197-229).
- **Who answers:**
  - In `admin` mode (the default for new groups), a plain message goes to the admin alone, who calls others with `@Name`.
  - In `everyone` mode, members answer round-robin, admin first.
  - `@Name` picks speakers directly. `@all` counts only from the admin or the user.
  - Members speak one at a time and each sees only what is new since it last looked. `[PASS]` stays silent (groups.js:4-13, 80, 101, 748-765; constants.js:49-53).
- **Busy members and limits:**
  - After 15 s of tool work the round moves on without the member.
  - Progress lines are batched every 30 s, and late replies are still posted.
  - A member with no activity for 4 minutes times out.
  - Bot-to-bot relays are capped at members×3 since the user last wrote; at the cap the group pauses until the user presses Continue or writes.
  - A group holds at most 12 members (constants.js:38-56; groups.js:37-40; P\2026-10-07-group-chat.md:42-47).

**Context management (compaction redesign)**
- DSH's own compaction is turned off for Bot Sessions (H\parts.js:245-266).
- When a turn ends past the check line (0.8 × usable window), a separate small "steward" model call reads about 6k tokens of recent messages. It answers with one line, `{"action":"switch"|"compact"}` (H\steward.js:1-40).
  - `compact`: older messages are condensed in place into a `[Checkpoint N]`, which is a summary plus the user's recent messages word for word.
  - `switch`: the chat moves to a new DSH Session "part" that opens with a handoff note plus recent messages. The old part is archived, and scheduled tasks are moved to the new part (H\schedules.js:127-148).
- The user still sees one continuous chat. Earlier parts are searchable with `read_own_chat` (SQLite FTS5, trigram tokenizer, BM25 ranking) (P\2026-10-09-context-and-memory.md:22-75).

**Memory**
- Memory is Markdown in the AgentMemoryRepo format, in three scopes: `bots/<id>`, `groups/<id>` and `team`.
- Size caps: 300 characters per entry, 4,000 per MEMORY.md, 16,000 per topic, 40 topics per scope.
- After each idle turn, an automatic review keeps, updates or removes entries. A group is reviewed once, by the admin's model (DSB\ds-bot\README.md:92-112).
- **How it avoids corruption:**
  - Only the process holding `bot/state.lock` writes (lock keys `pid,host,token,since`; a second DSH is read-only) (H\store.js:45-60).
  - Writes go through one queue (H\memory.js:525).
  - Each change follows a fixed order: write `pending.json`, then the files, then a `journal.jsonl` line with before/after. A half-written journal line is moved to `journal.torn` (memory.js:466).
  - Each Session freezes its memory section in `snapshots/<session>.md` (memory.js:969).
  - Entries that look like secrets are refused (`looksSecret`, memory.js:225), and memory is treated as data, not instructions.
- The live journal has 662 lines with keys `time,op,scope,file,actor,actorName,auto,after,before,removedTopic`.

**In-flight work, scheduling, sandboxing**
- **In-flight work.** `inflight.json` = `{turns:{sid→{botId,roomId,since,trigger,approval,resumed}}, queued:{sid→[{at,args}]}}` (H\resume.js:95-110).
  - After a restart, an interrupted turn is resumed once.
  - A turn that ended while DS-Bot was not watching is settled from DSH's session log and never resent (resume.js:1-11).
  - The file exists live (22 KB) but is missing from the README's data table.
- **Scheduling.** There is no scheduler of its own. It uses DSH's optional `schedule` service (`at/every/daily/weekly/cron` with a time zone), bound to a Bot's chat Session or a group's Session (H\schedules.js:1-125).
- **Sandboxing:**
  - Each Bot gets a DSH permission preset (Read only / Workspace / Full access) through `permissionPresets.set`, and a group can override it for all members. Bots cannot change permissions.
  - Working folders inside `$DSH_HOME` or the team data are refused (P\2026-10-10-bot-runtime.md:42-51).
  - Approval requests from hidden group Sessions are intercepted via `approval/request` and shown in the group (H\approvals.js:1-30).
  - DSH refuses to change sandbox mode while persistent terminals are open. This is the cause of the user's state-versus-runtime split (REP\01-permission-switch-bug.md:9-13, 103-113).
  - The Docker image's boundary is the container (DSB\docker\README.md:1-5).

**Task panel and short- vs long-range agents**
- There are **no task objects**. A kanban was explicitly rejected: "任务对象…留给独立 app" ("task objects… are left for a standalone app") (bot-handoffs.md:114).
- What exists instead: the status capsule, sidebar mascot animations, Settings → Scheduled tasks, Usage, and approvals in group details.
- The user's roadmap lists Activity view, attention states, a "needs you" (需要你) inbox and budgets as gaps (REP\02-roadmap.md:14-16, 28-38).
- The code has no "long-range/short-range" terms. The closest split (inferred) is:
  - long-lived Bots, versus
  - plain "DSH Agent" Sessions without team tools (H\agents.js:1-3) and DSH subagents (H\usage.js:323-329).
  - Side chat (`/side`, formerly `/btw`) is a one-off question with no tools, answered from a snapshot and kept out of history (P\2026-10-21-btw.md:8).

**Desktop app**
- It is an Electron app (`deepseek-bot` 0.2.2) that pins `@deepseek-ai/dsh@0.2.1-rc.2` and about 30 dsh packages.
- An engine child process boots the profile with `runProfile()` from `@deepseek-ai/dsh/profile-boot` (dsh-base + dsh-web-app + ds-bot). It listens on 127.0.0.1 only and keeps its own `DSH_HOME` (`~/.ds-bot`).
- It imports an existing team from `~/.dsh` read-only (DSB\app\package.json; DSB\app\README.md; P\2026-10-16-desktop-app.md:20-30).

**Live `~/.dsh/bot`** (names and schema only)
- `state.json`: keys `version,mainBotIds,bots(9),rooms(2),agents,capabilities,exchanges,exchangeTurns,works,questions,prefs,revision,workspaceId`.
- `inflight.json` and `state.lock`.
- `chat-index.sqlite`: FTS5 table `lines(text,session,seq,time,who)` plus `marks`.
- `usage.sqlite`: `calls(key,session,time,provider,model,kind,live,input,cache_read,cache_write,output)`, `marks`, `owners`, `kinds`.
- Also `memory/{bots/*,team,journal.jsonl,reviewed.json,snapshots}`, `group-lines/<room>/<seq>.txt`, `logs/diagnostics.jsonl` (keys `time,level,source,text,code,stack,bot,where,sessionId`), `ocr.json` and `workspace/`.

**What a bot framework actually adds over plain agent sessions**
1. **Identity that outlives sessions.** A stable Bot id owns its model, permissions, folder, persona and schedules, while the underlying Sessions rotate as parts (roster.js:149; bot-runtime.md:11; schedules.js:127).
2. **Addressability.** Bots are reached by exact name (`message_bot`, `@Name`), and `list_bots` is a directory with live status (tools.js:58-80).
3. **An inbox that works asynchronously.** You choose between steering a running Bot and queueing for later; replies come back on their own, so nobody polls; unread messages merge, and retries don't send the work twice (delivery.js:99-100; bot-handoffs.md:51-72).
4. **A delegation tree.** Results flow back up to whoever asked, and messaging a Bot that is waiting on the same work is refused (bot-handoffs.md:74-98).
5. **Surviving restarts.** Running turns and queued messages are recorded and resumed or settled after a restart (resume.js).
6. **Scoped memory with an automatic review**, plus consistent writes (context-and-memory.md:77-125).
7. **Unlimited conversation length** through the steward's compact-or-switch decision and full-text search of earlier parts.
8. **Group routing with cost control.** Admin answers first, one speaker at a time, `[PASS]`, and a pause at the relay limit.
9. **Per-agent isolation.** Each Bot has its own permission preset, secrets, browser profile and working folder.
10. **Observability.** A derived status per Bot and token usage per Bot and per model.

A plain session has none of these: its context and memory die with it, it cannot be addressed, and it has no inbound channel except a human.

## Integration surfaces / reusable pieces

- **HTTP:** DSH Web serves `POST /api/bot` with body `{endpoint, payload}` and returns `{ok, value | error{code}}`. It is authenticated by the DSH web session cookie (H\channel.js:518-530). Endpoints (channel.js:146-460):
  - `state`: the whole team view.
  - `send {sessionId|botId, text}`: calls `sessionController.prompt`, mode `queue`.
  - `create-bot`, `update-bot`, `delete-bot`, `set-main`.
  - `create-room`, `update-room`, `room-continue`, `room-progress`.
  - `approval-answer`, `stop-member-work`, `answer-question`.
  - `schedules`, `schedule-create`, `schedule-delete`.
  - `memory-view`, `memory-ask`, `memory-forget`.
  - `usage`; `run-stats` (sessionStats, tokenUsage, contextPressure); `exchange-text`; `side-new`, `side-ask`; `diagnostics`.
  - A window that does not hold the lock gets `bot/read-only`.
- **Read-only telemetry:**
  - The `state.json`, `inflight.json` and `usage.sqlite` schemas above.
  - DSH session logs in `~/.dsh/sessions/<ws>/session-<id>`, with event types `user/message` (filter `source.kind==='bot'`, `exchangeId`), `turn/start`, `turn/end`, `tool/call`, `tool/result` and `assistant/message` (H\turns.js:360-524).
- **Hooking in as a sibling DSH plugin**, using the same hooks DS-Bot uses:
  - `ctx.on('session/event' | 'llm/stream' | 'agent/pre-step' | 'approval/request' | 'tools/execute' | 'system-prompt/assemble' | 'agent/created')`.
  - `ctx.sessionController.create/resolveAgent/prompt`; `agent.steer/followup/cancel`; `agent.inbox.nextStep/nextTurn`.
  - `ctx.tools.register/restrict/guard`, `ctx.systemPrompt.section`, `ctx.connection.fetch.register`.
  - `ctx.get('permissionPresets' | 'attachments' | 'compaction' | 'agentPresets')`, `ctx.inject(['schedule'])`.
- **Reusable code and designs (Apache-2.0):**
  - `src/shared/mentions.js` (the @mention rules).
  - The steward's prompt and `linesFor()` (window math).
  - `requests.js` (request identity and idempotency).
  - `home-lock.js` (heartbeat lock).
  - The memory `pending.json` / journal scheme.
  - `chat-index.js` (FTS5 trigram index).
  - The `inflight.json` resume scheme.
  - `dev/mock-llm.mjs` and `dev/llm-tap.mjs` for tests that cost no tokens.
- **Engine pattern:** `runProfile()` from `@deepseek-ai/dsh/profile-boot` hosts a pinned, headless DSH on 127.0.0.1 (desktop-app.md:24).

## Gaps & risks

- **DSH only.** There is no Codex or Claude backend. "Local agent CLIs as Bots" is only planned (vision.md:31).
- **Single writer.** `state.lock` makes any second DSH instance read-only. An Orchestra that writes `state.json` directly would corrupt the team.
- **Desired state is not checked against reality.** Permission (and, by the same pattern, model) changes can save one value while the running Session keeps another. Upstream is still unfixed (permissions.js:23-26; REP\03-fork-notes.md:34).
- **The user is stuck on the 0.1.7 fork**, linked into the live profile, so every upgrade needs a manual merge.
- **No watchdog.** A stuck model stream never ends its turn (concession C11). Waits on handed-off work have no timeout. Loops between Bots run until the user stops them (bot-handoffs.md:120-121; P\2026-10-13-dsh-concessions.md).
- **No task objects, budgets (tokens only, no cost), notifications or cross-team inbox.**
- **The data format is pre-1.0 and can change** (ds-bot README:5).
- **Fragile coupling to DSH:** the UI relies on DSH's private class names (C7, C14), and `/goal` is disabled inside Bots (C2).
- **Secrets:** masking catches exact copies only, and Windows ignores the file mode (README "Secrets").
- **Groups are slow and costly:** members speak one at a time, and each speaker re-reads its whole context.
- **Stale memory in open Sessions:** memory frozen at Session start stays stale until the Bot calls `recall` (#214).
- **The `/api/bot` contract is internal and unversioned.**

## Implications for Orchestra

1. **Make the "musician" a persistent identity record that maps to many harness sessions.** Each identity has an ordered list of `{harness, sessionId, part, handoffNote}`. Model, permission, workDir, persona, memory scopes and schedules live on the identity, never on a session. Apply DS-Bot's parts-plus-handoff-note approach to Codex and Claude sessions too; Orchestra records where each part begins and ends.
2. **Build A2A as inbox messages, not RPC.** Use an envelope `{exchangeId, from, role, steer|queue, request_id}`, send each reply back automatically, merge unread messages, track a handoff tree with refusal of messages to waiting upstream agents, and make retries idempotent. Mapping to Claude/Codex inputs (resume/stdin) is inferred and needs verification.
3. **Keep AutoRoute deterministic and cheap.** The conductor or admin answers first, then explicit @mentions, `[PASS]`, and a relay cap that pauses for the human. Only the conductor uses an LLM to route. DS-Bot's `llm/stream` trick that fakes a tool call keeps the router out of the model.
4. **Don't fight DS-Bot's lock.** Treat each DS-Bot team as one section with Chief as section leader. Drive it via `POST /api/bot` (`send`, `state`, `run-stats`, `approval-answer`, `room-continue`), or as a sibling plugin. Read its files as telemetry only.
5. **Attention management is the space DS-Bot explicitly leaves open (task objects "left for a standalone app"), so own it:**
   - one status order across all harnesses (approval > switching > working > waiting-on-agent > idle);
   - one "needs you" inbox for approvals and questions;
   - per-project lanes;
   - budgets.
6. **Copy the durability rules:** a ledger of in-flight work, resume once, settle from the session log, never resend an unknown outcome, and a single writer with a heartbeat lock.
7. **Use three memory scopes:** agent, project (the equivalent of a group) and global. Markdown, a journal with an intent file, snapshots frozen per session, and memory treated as data.
8. **Reconcile after every change:** read back the actual sandbox and model after each apply, and show failures. This is the lesson of the user's own permission bug.