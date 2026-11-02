# Claude Agent SDK 探针：报告

日期：2026-11-01（UTC 约 21:05–22:20）。分支 `claude/sdk-probe-bead9f`，从最薄通路分支 `claude/m0-thin-slice-e9066d` 的 3b34a53 切出。

**一句话结论：partial。** SDK 能在本机以普通权限（Medium 完整性）拉起 Claude 会话，消息能发进去、事件能收回来，注册表、磁盘 transcript、peek 页这三条只读路径都能看到这次会话。但子进程**鉴权失败**，没有一次真正调到模型。所以凡是要模型真正回答的问题都还没答：插话（`next`）、排队（`later`）、中断一个在跑的回合、`canUseTool` 拒绝后会话怎么走、注册表里的 `waiting`。

鉴权失败直接碰到一条已定决策：r4 的 Q8（自有 Claude 会话的配置根，2026-10-29 已定 A：沿用你的 `CLAUDE_CONFIG_DIR`、复用你的登录，r4 第 2908 行）。本机的配置根由桌面应用托管，登录靠桌面宿主续期；Orchestra 单独拉起的 CLI 用不上这份登录（§1 第 1c 行、§5）。

花费 $0。本版已按独立复核者的意见改过，处理见文末「复核」。

**2026-11-02 补测（模拟后端，§9）：** 用户让 CLI 改走本机 magpie 网关上 opencode-go 转售的 `claude-haiku-5-5`，配置目录用一次性的临时目录，不碰用户的登录。这样测的是 CLI 和 SDK 一侧的行为，不是 Q8 的登录路径，也不代表 Anthropic API 本身。跑了两次，结果一致：插话和排队都**不会**插进正在跑的纯文本回合，要等它结束才开始；`interrupt()` 能停下在跑的回合；`canUseTool` 被调用、拒绝后会话照常继续；注册表出现 `waiting`；消息带上 uuid 以后，流里有 `command_lifecycle` 帧，状态依次是 `queued → started → completed / cancelled`。peek 页读这次会话，user 和 assistant 行都有内容。

## 0. 这是什么

r4（现行规格 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`）§7.1 的设计是：Orchestra 自己拉起的 Claude 会话（「自有乐章」）用 Agent SDK 的流式 `query()`。这条路排在 M1（自有驱动：Orchestra 自己拉起会话、收发消息）。M0（只读观察）阶段 M0 计划第 74 行不许有通用启动器，所以探针放在 `spikes/claude-sdk/`，不进 `src/`。目的是在写 `drivers/` 之前，先在真实环境里把 SDK 这条路摸一遍。

会话设置照 r4 §7.1 的自有 Claude 乐章：

- `settingSources: []`，`strictMcpConfig: true`，`mcpServers: {}`；
- `permissionMode` 用默认值，不传 bypass，不传任何 `dangerously*`；
- `canUseTool` 一律拒绝并记录（拒绝前故意等 6 s，好让 1 s 轮询看到 `waiting`）；
- 环境变量 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`；`maxTurns: 3`；`effort: 'low'`；
- `cwd` 用系统临时目录下新建的空目录；
- `model: 'haiku'`，并加 `claude-haiku-only` 守卫（r4 §7.2：真实回合只许走 haiku）：`system/init` 报的模型不含 haiku 就立即 `interrupt()` 并结束；
- `pathToClaudeCodeExecutable` 指向 PATH 上的 `~/.local/bin/claude.exe`，`claude --version` 报 **2.1.310**；
- 子进程环境用白名单：只带系统变量、`CLAUDE_CONFIG_DIR`、`HTTPS_PROXY`（见 §1）。原因见 §4 第 3 条。另做过一次对照（`--env inherit`）：继承本会话的完整环境，只去掉桌面宿主的消息管道、会话 id 和沙箱代理。

SDK：npm 上有 r4 §7.2 钉的 **0.3.287**（2026-10-01 发布；当前 latest 是 0.3.316），就用它。它带一个平台包 `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.287`，里面有自己的 `claude.exe`（对应 Claude Code 2.1.287）。探针没用这个自带的，用的是 2.1.310。装在 `spikes/claude-sdk/package.json`，版本钉死，提交了 lockfile（v3，112 个包），`node_modules` 被根目录 `.gitignore` 的 `node_modules/` 忽略。根目录 `package.json` 仍是零依赖。

## 1. 逐题结论

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1a | 能否以普通权限拉起会话 | **能** | 9 次 `query()`（零模型 3、真实回合 2、`--phase init` 两轮各 2）都拉起了 CLI。从调用 `query()` 算起：`initializationResult()` 约 1.4 s 返回，首个 `system/init` 在 1.5 s（运行 1）/ 2.8 s（运行 2）到达。全量测试里要真正启动 orchestrad 的用例都过了，说明本会话不是提权运行（orchestrad 在提权环境下拒绝启动）|
| 1b | 能否拿到回复 | **不能，鉴权失败** | 运行 1：每个回合都是 CLI 合成的错误（assistant 的 `model` 是 `<synthetic>`，`isApiErrorMessage: true`），内容是 `API Error: 403 Request not allowed`。运行 2 加了代理以后变成 `OAuth session expired and could not be refreshed`，之后是 `Not logged in · Please run /login`；`system/api_error` 记的是 401 `invalid x-api-key` |
| 1c | 鉴权走哪个配置目录 | 继承的 `CLAUDE_CONFIG_DIR`，即本会话所在的账号目录 `accounts/54102/config` | 子进程只拿到这一个配置目录。`init.apiKeySource` = `none`。这个目录里存的登录已过期，刷新失败。桌面应用里的 CLI 是由宿主代为续期的：本会话的环境里有 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`，单独拉起的子进程拿不到这种续期（推断：没有去读凭据文件）。排除了「白名单造成的」：`--env inherit` 对照带上了白名单去掉的 `CLAUDE_CODE_OAUTH_SCOPES` 等变量，两个回合照样是 `authentication_failed`（`init-inherit.json`）|
| 1d | 网络 | CLI **不读 Windows 系统代理**，要显式传 `HTTPS_PROXY` | 不经代理时，连一个不带任何凭据的 `curl` 都得到 403 `forbidden / Request not allowed`；正常情况下不带凭据应该是 401。改走系统代理（HKCU 里的 `ProxyServer` = 127.0.0.1:10809）后，同一个 `curl` 得到正常的 401 `x-api-key header is required`。会话环境里的 `https_proxy=127.0.0.1:12477` 是沙箱的中间人代理，证书不受信，不能给子进程用。这组 curl 对照只在本会话里手跑过，没有存进证据文件 |
| 1e | `system/init.capabilities` 里有没有 `msg_lifecycle_v1` | **有**（2.1.310） | 13 项：`interrupt_receipt_v1, interrupt_cancel_queued_v1, interrupt_send_now_v1, interrupt_requeue_taken_v1, msg_lifecycle_v1, request_marker_lists_v1, lifecycle_wakeup_source_v1, sdk_mcp_tools_list_changed, sdk_mcp_manifests, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1, mcp_call_result_not_for_model_v1`。init 帧在调模型之前发出，不受鉴权失败影响。注意：`initializationResult()` 返回的 `capabilities` 是另一张表，只有 `ui_surface_v1, mcp_call_result_not_for_model_v1` 两项；能力检查要看 `system/init`，不要看 initialize 的返回 |
| 2a | `streamInput` 发后续消息 | **通**，每条消息开一个回合 | 运行 2：首条消息走 `prompt`，后面 6 条走 `q.streamInput()`；7 条消息各得到一组 `system/init` → `system/status` →（`system/api_retry` ×2）→ `assistant` → `result` |
| 2b | `next`（插话）/ `later`（排队） | 真实登录下**未测**。模拟后端：**纯文本回合里两者都不插进当前回合**，见 §9 | 真实登录那次：每个回合都在 20 ms–2.7 s 内以合成错误结束，消息是在会话空闲时才发的，不说明任何语义 |
| 2c | `interrupt()` 能否停下当前回合 | 真实登录下**未测**。模拟后端：**能**，见 §9 | 真实登录那次只测到：会话空闲时调用 `interrupt()` 返回 `{still_queued: []}`，不抛错 |
| 3a | 工作流有没有关掉 | **`Workflow` 工具去掉了；工作流命令还在，能不能启动未测** | 零模型阶段是干净对照（只差这一个环境变量）：设了以后命令表只少 `deep-research`、`workflow-authoring` 两项。`--phase init` 各跑一个回合：不设时 `system/init.tools` 有 28 项，含 `Workflow`；设了是 27 项，没有 `Workflow`。但这组对照不干净：两次的命令表还差 4 项（设了的一边多出 `schedule`、`ultrareview`、`usage-credits`、`extra-usage`），推断和 §4 第 1 条的登录状态有关。关掉以后，命令表里仍有 `__remote-workflow`、`workflow-launch-exec` |
| 3b | `canUseTool` 有没有被调用；拒绝后会话怎么表现 | 真实登录下**未测**。模拟后端：**被调用，拒绝后会话照常继续**，见 §9 | 真实登录那次 0 次调用：模型没跑起来，就不会有工具调用 |
| 4a | 注册表 `sessions/<pid>.json` 的 `entrypoint` | **`sdk-ts`**，`kind` = `interactive`，`version` = 2.1.310 | 1 s 轮询，只读文件名是 `<数字>.json` 的那些，按 `sessionId` 或 `cwd` 匹配。r4 §7.1 表后和 S5 记的 `sdk-cli` 是 `claude -p` 加 stdio 审批的入口；SDK 的 `query()` 是另一个值。M1 判断「这是不是 Orchestra 自己的会话」，两个值都要认，并且不能只靠它，要用自己记下的 pid 和 `sessionId` 对上 |
| 4b | 注册表出现得多快 | `query()` 后 ≤1 s 出现文件，`status` 键在 1–2 s 之间出现 | 调 `query()` 那一刻的轮询是 absent，下一次（约 1.0 s）已有文件、没有 `status`，再下一次（约 2.0 s）有 `status`。运行 1 和运行 2 一样。S5 测到的是 28–46 s，但那是 `claude -p`、高负载、另一个版本，差别不能只归到负载 |
| 4c | busy / idle / waiting 能否用 1 s 轮询看到 | busy 与 idle：**能**，限于长过轮询间隔的回合。waiting：真实登录下未测；模拟后端**能**（`waiting` / `permission prompt`，见 §9） | 运行 2：两次各 2.3–2.7 s 的回合连在一起，合成一段 busy，两段都是 5.0 s，之后回到 idle。20 ms 级的回合分不出来：它们落在第一段 busy（约 2.0→3.0 s）里。会话关闭后的下一次轮询（≤1 s）里，注册表文件已经消失。没有工具调用，所以没有出现 `waiting` |
| 4d | 注册表的键 | `cwd, entrypoint, kind, messagingSocketPath, name, nameSince, nameSource, peerFeatures, peerProtocol, pid, pidDomain, procStart, sessionId, startedAt, version`，有状态后再加 `status, statusUpdatedAt, updatedAt` | SDK 拉起的会话**也开了消息管道**（`messagingSocketPath`、`peerProtocol`）。r4 §7.1「非自有会话的控制」一行说磁盘上的 `peerToken` 可能让同用户进程往会话里注入消息（未核实）。推断这对自有会话同样成立；轮询器只读 `<数字>.json`，没有查有没有对应的 `.key` 文件 |
| 5 | SDK 事件流和磁盘 transcript 的对照 | 有重叠，也各有对方没有的东西。见 §2 | 运行 2：流里 36 个带 uuid 的消息，磁盘上 48 个带 uuid 的行，两边共有的只有 7 个，全是 assistant |
| 6 | peek 页能否读出这次会话 | **这次能，读取器不用改；真实会话很快会超出它的尾读窗口** | `peek-check.mjs` 起一个测试 profile 的 orchestrad（`--test-profile --peek-port`），根目录里只放这一个 transcript 的副本。配对 303；列表 200、1 行；会话页 200、91 行，transcript 也是 91 行，每种类型的行数相等（只比了计数，没有逐行对）。91 行里有 77 行「内容」列是空的：8 种非消息行（`queue-operation, attachment, atis-latch, last-prompt, api-request-shape, api-request-blob, api-request, cost-state`，这些行型 `docs/research/cc-codex-protocols.md` 第 10 行早就列过，不是 2.1.310 新出现的）只显示类型；8 行 `system/api_error` 没有 `content` 字段，读取器取不到文字（`peek.ts` 第 198 行）。文件 204,617 B，已接近 `peek.ts` 第 48 行的 256 KiB 尾读窗口：每个空回合约 29 KB，真实会话的最后 200 行很可能大半是 `api-request-blob` 和 `attachment`。列表里的项目名不是原样的目录名（推断：经过了脱敏器，`peek.ts` 第 92 行）|
| 7 | S3 遗留项 | 见 §3 | |

## 2. 事件流与磁盘的对照（运行 2）

运行 2 的 7 个回合全是合成错误，所以下面**没有** tool_use、tool_result、真正的 assistant 文本，也没有 `stream_event`（流式增量），这些都要等真实回合再对照。

| 只在 SDK 事件流里 | 两边都有 | 只在磁盘上 |
|---|---|---|
| `system/init`（每回合一帧，带 tools、命令、技能、插件、capabilities）×7 | `assistant` ×7（同一 uuid） | 我们发的 `user` 消息 ×7，磁盘行带 `promptId, promptSource, turnOrigin, turnPosition`。流里没有回显：但探针发消息时**没有带 uuid**。类型声明里生命周期帧和中断收据都以消息的 uuid 为键（`sdk.d.ts` 第 4601、4613 行），推断不带 uuid 的消息就不会有。所以这只说明「不带 uuid 时没有」 |
| `system/status` ×7 | | `attachment` ×26，11 种：`environment, model, deferred_tools_delta, agent_listing_delta, skill_listing, total_tokens_reminder, budget_usd, session_context, date, credential_org, prompt_snapshot` |
| `result`（每回合一个，带累计花费、`modelUsage`、`permission_denials`）×7 | | `system/api_error` ×8（同一时刻流里是 `system/api_retry`，uuid 不同） |
| `system/api_retry` ×8 | | 不带 uuid 的行：`queue-operation` ×14（`enqueue` / `dequeue`）、`api-request` ×8（`params` 的键：`betas, context_management, max_tokens, model, output_config, thinking`；`querySource` = `sdk`）、`api-request-blob` ×8（存请求消息的正文块）、`api-request-shape` ×2、`atis-latch` ×5、`last-prompt` ×5、`cost-state` ×1（只在最后一行） |

对 M1 的含义：r4 §5.2 要求自有会话的事件也经只读解析器，好让自有和只读两边共用一套事件模型。按这次看到的结构，这一条做得到，但不够：

- **按回合的美元花费只在流里有。** 磁盘上没有 `result`，美元数只在最后一行 `cost-state`。回合边界磁盘上也能拼出来（user 行有 `turnPosition`），真实回合的 `assistant.message.usage` 也有 token 数（`docs/research/cc-codex-protocols.md` 第 12 行，本次没见到，因为没有真实回合）。
- **用户消息和排队操作：本次只在磁盘上见到，但没测公平。** r4 第 952 行的设计用的正是流里的消息生命周期帧（`command_lifecycle`）和回显（`isReplay`）；它们要求消息带 uuid，探针没带。M1 的驱动要给每条消息带 uuid，再看流里有没有。模拟后端补测里带了 uuid：生命周期帧有了，`isReplay` 回显仍然没有（§9）。
- **磁盘比流晚。** S5 测过 tool_use 写进 transcript 比 stdout 晚 0.8–2.5 s。

所以 M1 的形状更像：消息内容走解析器（和只读一侧同一套）；回合生命周期、花费和审批走流。两边用 assistant 的 uuid 对齐。这是推断，要在真实回合上再对一次。

磁盘体积：7 个只有一句错误的回合，transcript 就有 204,617 B（约 200 KiB），因为每次请求都把正文块存进 `api-request-blob`。

## 3. S3 遗留项（r4 末尾「未核实」清单里和 SDK 会话相关的几条）

S3 是 r4 §13.3 里 M1 的 Claude 后端 spike。

| 项 | 结论 | 证据 |
|---|---|---|
| 乐章实际生效的 effort 能否回读 | **设定值能回读；API 是否照办未测** | 传 `effort: 'low'` 后，`q.getSettings()`（SDK 有这个方法，但 `sdk.d.ts` 的 Query 接口里没声明）的 `applied.effort` = `low`，不传时是 `medium`；磁盘上的 `api-request.params.output_config.effort` = `low`，`assistant.perTurnEffort` = `low`。`system/init.effort` 是 null：类型注释说只有 Remote Control 一类宿主才发这个字段 |
| 传 `disableAllHooks: true` 能否关掉 `/goal` | **命令还在；执行未测** | 零模型阶段：`settings: {disableAllHooks: true}` 生效了（`getSettings().effective.disableAllHooks` = true），命令表里仍有 `goal`。没有执行 `/goal`：它会开启自动续跑，要调模型 |
| 愿望档案要用 `disallowedTools` 去掉的工具叫什么 | **名字已知** | 2.1.310 在本机 SDK 会话里暴露：`CronCreate, CronDelete, CronList, ScheduleWakeup, RemoteTrigger, PushNotification`；没有 `Monitor`，也没有 `Bash`：只有 `PowerShell` 工具。本机其实装了 Git Bash（`I:Git`，在 PATH 上），CLI 为什么不暴露 Bash 没查；`PowerShell` 有没有后台执行的参数也没查。另有 `SendMessage, ListAgents, DesignSync, ReportFindings, AskUserQuestion, EnterWorktree` 等，完整列表在证据 `init.json` 里 |
| SDK 能否报告回合结束时还在跑的后台任务数 | 未测 | SDK 有 `backgroundTasks()` 方法和 `background_tasks_changed` 事件（据类型声明），没跑到 |
| `autoContinueAtUsageLimit: false`、`maxEffortLevel` 在 SDK 会话里是否生效 | 未测 | |
| `settingSources: []` 下 CLAUDE.md 附加段是否生效 | 未测 | |
| 经 `spawnClaudeCodeProcess` 由 procguard 拉起 | 未测 | 探针直接由 SDK spawn |

## 4. 顺带发现（会影响 M1）

1. **同一个会话里，工具表会在回合之间变。** 运行 2 的第 5 个回合起，`system/init.tools` 多了 `RemoteTrigger`，技能多了 `schedule`；运行 1 一开始就有。第 4 个回合是第一次报 `Not logged in`，所以推断这和登录状态有关，而且 init 帧比登录状态的变化晚一个回合。r4 §7.4（第 902 行，愿望档案）要求「每次乐章启动断言 `system/init.tools`」，只在启动时断言不够，要每个回合的 init 帧都断言。
2. **`settingSources: []` 挡不住 CLI 自带的技能和插件。** 每个 init 帧都报 3 个插件（`cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring`）和 16–18 个技能（`design, dataviz, loop, schedule, claude-api, run…`）。复核者查过：配置目录 `skills/synced` 下用户同步的技能一个都没出现，`plugins/` 里也找不到这 3 个插件，所以它们像是 CLI 自带的（推断）。r4 §7.4 的配置隔离要把自带的这部分算进去，必要时用 `disallowedTools` 或 `skills` 选项收窄。
3. **子进程的环境必须用白名单。** 本会话是桌面应用托管的，环境里有 `CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_HOST_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION`、沙箱代理等几十个变量。SDK 默认把 `process.env` 整个传给子进程，子进程就会以为自己是桌面会话的一部分。orchestrad 自己不跑在桌面会话里，但 r4 §10.16 的 `--env-allowlist` 思路同样适用于 Claude host。
4. **`initializationResult().account` 不代表已登录（证据偏弱）。** 它返回了 `email`、`subscriptionType`（证据里只记了 `email` 的键名，`subscriptionType` 记了值 `Claude Max`）。但零模型阶段跑在 21:09–21:10 UTC，早于 21:16 第一次刷新失败，当时登录也许还没失效；要在确认失效以后重测一次才算数。接入向导的「登录状态」卡（r4 §5.2 SecretStore 与接入向导一行）不能拿它当判据；要么跑一个真实回合，要么看 `api_error`。
5. **代理。** 见 §1 第 1d 行。M1 的 Claude host 要从 Tuning 或系统设置拿代理，显式传 `HTTPS_PROXY`。

## 5. 没验到的，和怎么补

真实回合全卡在鉴权上。要补，得先让子进程能登录。（2026-11-02 的模拟后端补测绕开了登录，答了 CLI 一侧的问题，见 §9；登录这一条仍然没解决。）

先说冲突：r4 的 Q8 已定 A（自有 Claude 会话沿用你的 `CLAUDE_CONFIG_DIR`、复用你的登录，好处是乐章结束后能在原生 CLI 里 `--resume`）。本机这个配置根是桌面应用托管的：桌面里的 CLI 由宿主续期登录，Orchestra 单独拉起的 CLI 没有宿主，用的是目录里存的那份，而那份已经过期、刷新失败。所以照 Q8 的做法，在本机现在跑不通。选项（要用户定）：

- A. 照 Q8：由用户本人在普通终端里，对这个配置根重新登录一次：`$env:CLAUDE_CONFIG_DIR='<本会话的配置根>'; claude`，再执行 `/login`。不清楚的是：这会不会影响桌面应用对同一目录的登录管理，存下的登录能撑多久、过期后谁来刷新（未测）。
- B. 偏离 Q8，给 Orchestra 单独一个 Claude 配置目录，由用户本人在那里登录一次。代价是要重开 Q8：会话不在你的 `projects/` 里，原生 CLI 的 `--resume` 要指向那个目录。r4 §5.3 只规定 `~/.orchestra` 不得在 harness 根目录之内，跟这件事只是类比，不是依据。
- C. 用本机其它已有的配置根（S5 当时用的是 `accounts/53087/config`）。我没有去看那些目录里的登录是否有效：那要读凭据文件。
- D. 就停在这里，等 M1 的 S3 再测。

补测命令（选 A、B 或 C 之后，约 4 分钟，haiku，上限 $0.15）：

```
node spikes/claude-sdk/probe.mjs --phase live --proxy http://127.0.0.1:10809 --config-dir <目录> --out <草稿区>/evidence
node spikes/claude-sdk/summarize.mjs <草稿区>/evidence/live.json
node spikes/claude-sdk/peek-check.mjs --transcript <目录>/projects/<…>/<sessionId>.jsonl
```

真实回合跑通以后还要看：§1 的 2b、2c、3b、4c 的 waiting；§2 里 tool_use / tool_result / stream_event 的对照；§3 的 effort 是否真被 API 采用。

## 6. 花费

**$0。** 没有一次请求被 API 接受：

- 运行 1：发出了请求，403（网络层拒绝，没走代理）。
- 运行 2：前 3 个回合在发请求之前就以「OAuth 过期且刷新失败」结束；后 4 个回合各发了 2 次请求，都是 401（凭据无效），磁盘上 `api-request` 共 8 行。
- `--phase init`（两轮）：transcript 里没有 `api-request` 行，CLI 在发请求前就判定未登录。

所有 `result.total_cost_usd` 都是 0，`modelUsage` 都是空的。上限：运行 2 一个 `query()` 设 `maxBudgetUsd: 0.15`，比任务简报建议的 0.05 高（这个 0.05 是简报给的，r4 里没有），因为一个 `query()` 里有 7 条消息，SDK 的预算按整个 `query()` 累计；`--phase init` 每个 `query()` 0.02；零模型阶段 0.01（不调模型）。

模拟后端补测（§9）：两次 `query()`，CLI 按 haiku 价目自己算的累计花费是 $0.0048 和 $0.0027。这笔钱实际计在 magpie 里的 opencode-go 账号上，不计在 Anthropic 账号上；opencode-go 实际扣多少，我没查。

## 7. 留在本机的痕迹

**claude 自己写进 `accounts/54102/config` 的**（没有删，由用户决定）：

`projects/` 下 6 个目录，名字都以 `C--Users-Calx-AppData-Local-Temp-orchestra-sdk-` 开头：

| 目录后缀 | 来源 | 内容 |
|---|---|---|
| `zero-1zXME0`、`zero-JbXzIY` | 零模型阶段（两次） | 只有一个空的 `memory/`：没发消息也会建目录 |
| `probe-ejqi6N` | 运行 1（无代理） | 1 个 jsonl，181 KB |
| `probe-aC0TNi` | 运行 2（有代理） | 1 个 jsonl，204,617 B |
| `init-VRk5ea` | `--phase init`（白名单环境） | 2 个 jsonl，共 57 KB |
| `init-pgosUL` | `--phase init --env inherit`（复核后补的对照） | 2 个 jsonl，共 58 KB |

注册表：这几次会话的 `sessions/<pid>.json` 都已自行删除。查不了的：每个新会话可能往 `.claude.json`、`history.jsonl` 写了东西（没有读这些文件）。

**模拟后端补测**：配置目录是草稿区里一次性的 `mockcfg/`，transcript 和注册表都写在那里，用户的配置根里**没有**新增。两个 cwd（系统临时目录下 `orchestra-sdk-probe-sGqDBu`、`-TH86PW`）是空的，已删除。magpie 会在它自己的调用记录里记下这些请求（它的存储，不归探针管）。

**进程**：结束前按命令行查过，没有残留的 claude.exe 或 node.exe。补测时看到的两个 `src/boot.ts` 进程（真实 profile 端口 7470、测试 profile `orchestra-test-stage`）早在补测之前就已经在跑，不是探针起的，没有动它们。

**临时目录**：探针的 6 个 cwd（系统临时目录下 `orchestra-sdk-*`）始终是空的，已删除。`peek-check.mjs` 的测试 profile 目录用完即删。

**证据**（只有结构、计数、键名、时间，不含会话内容）在本会话的草稿区 `…/scratchpad/evidence/`：`zero.json`、`live-run1-no-proxy.json`、`live.json`、`init.json`、`init-inherit.json`、`peek-check.json`、`projects-before.txt`。草稿区不跨机器，所以本报告里的数字是自足的。

**读的范围**：只打开过 `sessions/<数字>.json`、`projects/` 下这几次会话自己的 jsonl。为了诊断，读过 transcript 里 CLI 合成的错误文本（只有三种，都已原文写在 §1）。没有读 `.key`、`.claude.json`、任何凭据文件。

## 8. 复现

Node 用 `.tools/node24/node.exe`（24.22）。会话里 Bash 的沙箱代理会让 npm 和 claude 都连不上，以下命令要在不经沙箱代理的环境里跑，并显式传系统代理。

```
cd spikes/claude-sdk
npm ci --ignore-scripts                     # 装 lockfile 里钉死的 0.3.287
node probe.mjs --phase zero --proxy http://127.0.0.1:10809 --out <dir>   # 不调模型，约 12 s
node probe.mjs --phase init --proxy http://127.0.0.1:10809 --out <dir>   # 每种工作流设置 1 个回合；登录失效时 $0
node probe.mjs --phase init --env inherit --proxy http://127.0.0.1:10809 --out <dir>   # 同上，继承完整环境的对照
node probe.mjs --phase live --proxy http://127.0.0.1:10809 --out <dir>   # 约 4 分钟；登录有效时会花钱（haiku，上限 $0.15）
node summarize.mjs <dir>/live.json
node peek-check.mjs --transcript <CLAUDE_CONFIG_DIR>/projects/<目录>/<sessionId>.jsonl --out <dir>/peek-check.json
# 模拟后端（§9）：本机 magpie 网关，不需要钥匙、不经代理；配置目录用一次性的空目录
node probe.mjs --phase live --gateway http://127.0.0.1:3425 --model opencode-go/claude-haiku-5-5 --config-dir <一次性目录> --out <dir>
```

脚本：

| 脚本 | 作用 |
|---|---|
| `probe.mjs` | 拉起会话、轮询注册表、记录事件流和 transcript 的结构 |
| `summarize.mjs` | 把 `live.json` 打成时间线、注册表、流与磁盘对照 |
| `peek-check.mjs` | 用测试 profile 的 orchestrad 和 peek 页读回一个 transcript，只输出计数和类型 |
| `probe2.mjs` | §10 的 11 项补测：`node probe2.mjs --gateway http://127.0.0.1:3425 --model opencode-go/claude-haiku-5-5 --out <dir> [--only …] [--desktop-transcript <文件>]`，约 4 分钟 |

全量测试：`.tools/node24/node.exe --test "test/**/*.test.ts"`，958 条，955 过、0 失败、1 跳过、2 todo，和起点（最薄通路分支 3b34a53）相同。

## 9. 模拟后端补测（2026-11-02，UTC 约 07:10–07:20）

**为什么能这样测。** 本机装着 magpie（0.1.2629，一个第三方的多服务模型网关），它在 `127.0.0.1:3425` 上提供兼容 Anthropic 的本地网关，不要钥匙。它接的服务里，opencode-go 转售 `claude-haiku-5-5`。`probe.mjs` 新加了 `--gateway` 和 `--model`：给子进程设 `ANTHROPIC_BASE_URL`，并把 `ANTHROPIC_API_KEY` 设成占位串（网关不验，不是凭据）。`--config-dir` 指向草稿区里一次性的空目录。其余设置和 §0 一样：默认权限模式、`canUseTool` 全拒、工作流关、`settingSources: []`。每条消息现在都带 uuid。`claude-haiku-only` 守卫照常生效：init 报的模型是 `opencode-go/claude-haiku-5-5`，每个 assistant 消息的 `model` 也是它。

**能说明什么、不能说明什么。** 能说明 CLI 和 SDK 一侧的行为：消息怎么排队、怎么中断、审批怎么走、注册表、生命周期帧、transcript 结构、peek。不能说明：Q8 的登录路径；Anthropic API 本身的行为（effort 是否被采用、花费、thinking）。opencode-go 背后是不是 Anthropic 的模型，我没有核实。

跑了两次，结果一致。第一次没记下生命周期帧的 `state`（探针只在 `type: 'system'` 的帧上记，而这种帧的 `type` 是 `command_lifecycle`），改了一行再跑。下表的时间都取第二次，单位是从调 `query()` 起的 ms。

| 回合 | 做了什么 | 看到什么 |
|---|---|---|
| T1 | 发一条要求只回 PONG 的消息 | 生命周期帧 `queued` 1277 → `started` 1279；`result/success` 5431；`completed` 5432 |
| T2 | 要求用 Write 工具建文件 | `canUseTool` 在 7761 被调用（工具 `Write`，入参键 `content, file_path`），探针拖 6 s 后在 13773 拒绝。注册表 8135 变 `waiting`（`waitingFor` = `permission prompt`），14179 回到 `busy`。拒绝后模型回了一句话，`result/success`，`permission_denials` = `["Write"]`，会话继续接下一条消息。磁盘上工具结果那一行多了 `permissionDecision`、`toolDenialKind` 两个键。`canUseTool` 第三个参数的键：`agentID, blockedPath, decisionReason, defaultToNo, description, displayName, requestId, signal, suggestions, suppressAlwaysAllowRule, title, toolUseID` |
| T3 | 让模型数到 400；流出文字后 1.7 s 发 `priority: 'next'` 的插话 | 插话 18226 进入 `queued`，但**当前回合没被打断**：模型数完了 400，20022 才出 `result`；插话 20024 才 `started`，21899 得到 STEER-ACK |
| T4 | 让模型数到 300；流出文字后发 `priority: 'later'` 的排队消息 | 和 T3 一样：24594 `queued`，当前回合数完 300，26232 结束，26233 `started`，35706 得到 QUEUED-ACK |
| T5 | 让模型数到 800；流出文字后 0.5 s 调 `interrupt()` | 37497 返回 `{still_queued: []}`；37500 `result/error_during_execution`，模型只数到 97；37501 这条消息的生命周期帧是 `cancelled`。磁盘上那条 assistant 行带 `isAbortedMidStream`，后面多一条不是我们发的 user 行（推断是中断标记） |
| 结束 | 空闲 45 s 后关闭 | 注册表 38358 变 `idle`；关闭后 82742 消失 |

**消息的 uuid。** 我们发的 7 个 uuid 就是磁盘上那 7 条 user 行的 uuid。流里不回显 user 消息（没有 `isReplay`），但生命周期帧的 `command_uuid`，以及 `stream_event`、`assistant`、`result` 的 `user_message_uuid` / `user_message_uuids`，都指向我们发的 uuid。所以 M1 能用自己生成的 uuid，把「发出的消息」「流里的回合」「磁盘上的行」三者对上。

**对 r4 §8.2（按 harness 投递）的影响。** r4 第 952 行把 Claude 的 Steer 写成 `streamInput{priority:'next'}`，把 "read" 回执写成 `command_lifecycle{state:'started'}`。这次看到的是：

- 在一个不调工具的长回复里，`next` 不会插进当前回合，和 `later` 一样要等回合结束才开始。它会不会在两次工具调用之间插进去，没测（T3 没有工具调用）。所以在纯文本回合里，Claude 的 Steer 实际上等于 Queue，UI 不能许诺「立即插话」。
- `started` 只在消息真正开始执行时才来，所以长回合里插话的 "read" 回执要等到回合结束。`queued` 帧倒是立刻就来（≤1 ms），可以当「已收到」。
- `next` 和 `later` 在这次的测法下看不出区别：队列里只有一条消息。多条排队时谁先谁后，没测。
- 中断的回执是被中断那条消息的 `cancelled`；`interrupt()` 的返回值本身只有 `still_queued`。

**其它。**

- 7 个回合的 `system/init.tools` 都是同样 26 项，没有 `RemoteTrigger`。这和 §4 第 1 条的推断一致：那一项跟着 claude.ai 的登录状态走，用 API key 时不出现。
- `capabilities` 和 §1 第 1e 行的 13 项相同。`getSettings().applied.effort` = `low`。
- 流和磁盘（第二次；第一次是 107 / 44 / 12，构成相同）：流里 99 个带 uuid 的帧，磁盘上 43 个带 uuid 的行，共有 11 个。流独有：`command_lifecycle` 21、`stream_event` 45（连续的增量合并成一行计）、`system/init` 7、`system/status` 8、`result` 7。磁盘独有：user 7、attachment 25。tool_use 和 tool_result 在两边都有，正文块在流里分成增量，在磁盘上是整块。
- peek 页（`peek-check.mjs`，transcript 181,846 B）：会话页 88 行，transcript 也是 88 行。70 行没有内容，全是非消息行（`attachment` 25、`queue-operation` 14、`api-request` 10、`api-request-blob` 8、`atis-latch` 4、`last-prompt` 4、`ai-title` 3、`api-request-shape` 1、`cost-state` 1）。9 行 user 和 9 行 assistant 都有内容，包括 tool_use、tool_result 和 thinking 行。`peek-check.mjs` 为此加了按类型统计空行。
- 证据：草稿区 `evidence-mock/live.json`（第一次）、`evidence-mock2/live.json` 和 `evidence-mock2/peek-check.json`（第二次），只有结构、计数、键名、时间。
- 这一节**没有**交给独立复核。

## 10. 第二轮补测：11 项 SDK 行为（2026-11-02，UTC 约 08:00–08:40）

用途：给 alpha 0.2 交互薄切片（2026-11-02 用户决定做的下一条薄切片，导入也并进去）当前置结论。题目来自上游会话的 11 项清单，下文按清单编号写作「第 N 项」。

做法：新脚本 `probe2.mjs`。后端、模型和设置都和 §9 相同：magpie 网关、opencode-go 的 `claude-haiku-5-5`、默认权限模式、`settingSources: []`、工作流关、`canUseTool` 默认拒绝。只用合成提示词，例如「记住暗号 BLUE-HERON-42」「数到 N」，以及临时目录里造的 `a.txt`、`big.txt`。全部 31 个配置目录和 cwd 都建在系统临时目录下同一个 `orchestra-sdk2-*` 根目录里，跑完整个删掉。没装新包，没碰真实登录，没读凭据文件。证据（只有结构、计数、键名、布尔值）在草稿区 `evidence-r2/`、`evidence-r2a/`、`evidence-r2b/` 的 `probe2.json`。仍是模拟后端，所以下表只说明 CLI 和 SDK 一侧的行为。

| 项 | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 换了 `CLAUDE_CONFIG_DIR`、把 transcript 复制进新目录的 `projects/` 后，`resume` 能否接上；能否跨项目目录找到会话 | **能，两种都能** | 在配置目录 A 里开会话，记一个暗号；把 `.jsonl` 复制到全新的配置目录，再用 `resume: <id>` 问暗号。三种放法都答对了，会话 id 不变，新回合追加进**复制过去的那个文件本身**，不另建文件：① 放在按 cwd 算出的同名项目目录；② 放在一个随便起名的项目目录（`C--some-other-project`）；③ 放在原目录名下，但从另一个 cwd 去 resume。所以 resume 是按会话 id 在整个 `projects/` 下找，不要求目录名和 cwd 对得上。从另一个 cwd resume 时，新回合记的是哪个 cwd，没查 |
| 1′ | CLI 按 cwd 算项目目录名的规则 | 所有不是 `A–Z a–z 0–9` 的字符都换成 `-`，**一个字符换一个**；超过 200 个字符时，保留前 200 个，再接 `-` 和一段 6 位短串 | 规则逐字符核对过：`C:\…\cwd-naming-dot.under_score space 中文` 得到的目录名和 `cwd.replace(/[^A-Za-z0-9]/g, '-')` 完全相同（点、下划线、空格、两个汉字各变一个 `-`）。237 字符的 cwd 得到 207 字符的目录名：前 200 个字符和规则结果一致，后面是 `-h7worv`。这段短串怎么算的（推断是某种哈希）没查，所以**目录名超过 200 字符时不能自己算出来**，只能列目录去找。另外，Windows 不允许 260 字符以上的路径当进程 cwd：那样的会话根本起不来（spawn 直接报 `ENOTCONN`），这是 Windows 的限制，不是 CLI 的 |
| 2 | 除了 `*.jsonl` 和 `subagents/`，resume 还需要别的文件吗 | **接上会话只要 `.jsonl`**；但大块工具输出的全文只存在旁边的 `tool-results/` 里 | 让 PowerShell 读一个约 280 KB 的合成文件：全文存成 `projects/<目录>/<id>/tool-results/<随机名>.txt`（286,912 B），transcript 里只有预览和指向它的路径。只复制 `.jsonl` 去 resume：接得上，模型从预览里答对了首行；复制整个项目目录也一样。没测：模型在 resume 以后要读预览以外的内容时，如果 `tool-results/` 没复制过去会怎样。保险的做法是连同 `<id>/` 子目录一起复制。配置根下还出现了 `session-env/<id>/`（空目录）、`.claude.json`、`backups/`、`sessions/`；resume 不依赖它们（新配置目录里本来就没有）|
| 3 | `resumeSessionAt` 加 `forkSession`，截在最后一条主链消息处 | **新会话、新文件，原文件不动；截断点之后的内容确实被丢掉** | 原会话两个回合，各记一个暗号。主链最后一条正好是第二个回合的 assistant 消息。截在这里 fork：新 session id，新文件和原文件在同一个项目目录，38 行，没有一行的 `sessionId` 是原 id；原会话主链的 17 个 uuid 原样复制进新文件；原文件行数不变；新会话两个暗号都答得出。截在第一个回合的 assistant 消息处 fork：只复制了 12 个 uuid，只答得出第一个暗号。之后再普通地 resume 原会话，两个都还在。新文件里多一种行型 `mode`。`resumeDropsTurn`（声明要丢弃的回合、由 CLI 校验）没测 |
| 4 | `systemPrompt` 的追加段怎么写才生效 | 用 `{ type: 'preset', preset: 'claude_code', append: '…' }`，**在会话的第一个请求里定下来**；以后 resume 时换了 `append` 不生效，除非加 `snapshot: false` | 追加段要求每句回复以 `ZETA-7` 结尾：生效。直接传字符串（整段替换 Claude Code 的系统提示词）也生效，工具仍是 26 项。resume 时把追加段换成要求 `KAPPA-5`：回复里仍是 `ZETA-7`，新的不生效。同样的换法加 `snapshot: false`：变成 `KAPPA-5`。这和 `sdk.d.ts` 对 `snapshot` 的说明一致：默认在第一次请求时把系统提示词记进会话，以后照抄 |
| 5 | `--no-chrome` 经 `extraArgs` 传进去是否生效 | **传到了 CLI，CLI 也接受；效果在这个设置下看不出来** | `extraArgs: { 'no-chrome': null }` 和 `{ chrome: null }`：子进程 claude.exe 的命令行里分别出现 `--no-chrome`、`--chrome`，没有报错，回合成功。但三种设置（不传、`--chrome`、`--no-chrome`）的工具表和 MCP 服务器表完全一样，都没有任何 chrome 相关项：`strictMcpConfig` 加空 `mcpServers`，加上临时配置目录里没有浏览器扩展配置，本来就不会加载 Claude in Chrome。要看出效果，得在装了扩展的配置里对照，没测 |
| 6 | transcript 开头有没有 `entrypoint` 一类字段，能否据此认出 Desktop 托管的会话 | **有，但不在第一行；能认出** | 两种 transcript 的前两行都是 `queue-operation`，没有 `entrypoint`，也没有 uuid。从第三行起，每个带 uuid 的行都有 `entrypoint` 和 `userType`。SDK 会话是 `sdk-ts`；本会话（桌面应用托管）是 `claude-desktop`，全文 1381 行只有这一个值；`userType` 两边都是 `external`。所以要读到第一个带 uuid 的行，而不是只看第一行。只看了一份 Desktop transcript；交互式 `claude` 和 `claude -p`（S5 记的 `sdk-cli`）的值这次没取样 |
| 7 | 流式输入下，`maxTurns` 按每条消息算，还是整个 `query()` 累计 | **按每条消息算** | `maxTurns: 1`，同一个 `query()` 里连发 5 条：3 条只要一句回复的都成功；第 4 条要调工具（Write，被拒）需要 2 个回合，得到 `error_max_turns`（`Reached maximum number of turns (1)`）；第 5 条又成功了 |
| 8 | host（node 进程）被杀后，claude.exe 会不会在 stdin EOF 时自己退出 | **会，约 0.5 s 内；但注册表文件留下了** | 子 node 进程拉起会话，强杀它（`SIGKILL`，Windows 上就是 TerminateProcess）。空闲时和回合进行中（正在数到 3000）两种情况，claude.exe 都在 513 / 515 ms 内退出（每 500 ms 查一次，所以只能精确到这个粒度）。但它的 `sessions/<pid>.json` 两次都**没有被删掉**。M1 和导入都要处理这种死掉的注册表项：pid 已经不在了，文件还在 |
| 9 | 全新的私有配置目录下，SDK 模式会不会卡在首次使用或信任目录的提示上 | **不会** | 31 个配置目录全是新建的空目录，没有一个卡住。单独记录的那一次：`system/init` 在 1.7 s 到达，回复正常。CLI 写出的 `.claude.json` 只有 `firstStartTime, firstStartVersion, machineID, userID, migrationVersion…` 等 10 个顶层键，没有 `projects`、信任标记，也没有 `hasCompletedOnboarding`；SDK 模式根本不走这些提示 |
| 10 | `settingSources: []` 加默认权限模式时，哪些工具不经过 `canUseTool`；PreToolUse 返回 `ask` 会不会转到 `canUseTool` | **只读类工具不经过；`ask` 会转到 `canUseTool`** | 不经过 `canUseTool`、直接执行的：`Read`、`Glob`、`Grep`、只读的 `PowerShell`（`Get-ChildItem`；第 2 项里的 `Get-Content` 也是）、`CronList`、`EnterPlanMode`、`Skill`。经过 `canUseTool`（被拒，没有执行，文件确实没被改）的：会写文件的 `PowerShell`（`New-Item`）、`Write`、`Edit`、`AskUserQuestion`。要注意 `EnterPlanMode` 不问就执行了，它会改变会话的权限模式；执行后会话处在哪个模式，没查。PreToolUse 钩子对 `Read` 返回 `permissionDecision: 'ask'`：钩子被调用，接着 `canUseTool` 收到 `Read`，拒绝后 `Read` 没有执行。没测的工具：`WebFetch`、`WebSearch`、`Task`、`NotebookEdit`、`CronCreate`、`ScheduleWakeup`、`SendMessage` 等；PowerShell 哪些命令算只读，也没摸清 |
| 11 | `skills: []` 这个选项是否存在，能否关掉内置技能和插件；关不掉的话，内置名单是什么 | **选项存在（`skills?: string[] \| 'all'`），能把技能从模型面前拿掉；插件关不掉** | 不传 `skills` 时，transcript 里有一行 `skill_listing` 附件（键 `content, digests, isInitial, names, skillCount, type`），`Skill` 工具能调 `dataviz`。传 `skills: []`：没有 `skill_listing` 这行，调 `Skill` 返回错误。传 `skills: ['dataviz']`：清单里只剩它，调用成功。但不管传什么，`system/init.skills` 都照报 16 个，`plugins` 照报 3 个，命令表都是 46 项；再加 `plugins: []` 也一样。所以 init 帧不能用来判断技能是否被关掉。类型注释说这是「上下文过滤，不是沙箱」：技能文件仍能用 Read 读到。`Skill` 工具本身也不经过 `canUseTool`（第 10 项）。内置名单（CLI 2.1.310）：技能 `design, design-sync, dataviz, update-config, verify, debug, code-review, simplify, batch, fewer-permission-prompts, doctor, loop, claude-api, run, run-skill-generator, plugin-authoring`；插件 `cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring` |

对 alpha 0.2 薄切片的几条直接含义（推断，供上游会话取舍）：

- 导入别处的 Claude 会话，复制 `.jsonl`（最好连同 `<id>/` 子目录）到 Orchestra 用的配置目录的 `projects/` 下任意一个目录就能 resume，不必按 cwd 算目录名。但 resume 会往复制过去的那个文件里接着写。
- 认 Desktop 托管的会话，读第一个带 uuid 的行的 `entrypoint`（`claude-desktop`）。
- 判断会话是否还活着，不能只看注册表文件在不在，要验 pid（第 8 项）。
- 「全拒」的 `canUseTool` 挡不住只读工具、`EnterPlanMode` 和 `Skill`。真要禁，得用 `disallowedTools` 或 PreToolUse 钩子（钩子返回 `ask` 会转给 `canUseTool`，返回 `deny` 这次没测）。

花费：CLI 按 haiku 价目估算，每条消息 $0.0007–0.0018，约 50 条，估计合计不到 $0.1。计在 magpie 里的 opencode-go 账号上，不在 Anthropic 账号上。

痕迹：临时根目录已删除；两次中途崩溃的试跑留下的两个空 `orchestra-sdk2-*` 目录也已删除。第 8 项强杀的子 node 进程和它的 claude.exe 都已确认退出。本节没有交给独立复核。

## 复核

初稿交给一个没参与写作的子代理，要求逐条去推翻（只读证据、代码和规格，不调模型）。它判定成立的：1b、1d、1e、2a、2b、2c、3b、4a；流与磁盘 36 / 48 / 7 的算法和 §2 的计数；§3 的 effort、`/goal`、后台任务三行；§4 第 3、5 条；§7；r4 第 902、2404 行和 M0 计划第 74 行的引用。打折扣或推翻的，处理如下（都已改进正文）：

| 复核意见 | 判定 | 处理 |
|---|---|---|
| §2「用户消息、出队只在磁盘上有」：探针没给消息带 uuid，而 r4 第 952 行的投递确认用的正是流里的 `command_lifecycle` 和 `isReplay` 回显 | 推翻 | 接受。改成「不带 uuid 时没见到」，并写明 M1 要给每条消息带 uuid 再测 |
| 「回合边界和花费只在流里」 | 打折扣 | 接受。改成「按回合的美元花费只在流里」：回合边界磁盘上也能拼，token 数真实回合在磁盘上也有 |
| §3「本机没有 Git Bash」 | 推翻 | 接受，已核实 `I:\Git\usr\bin\bash.exe` 存在。改成「CLI 没暴露 Bash，原因没查」 |
| §4.2「`settingSources: []` 挡不住插件和技能」 | 打折扣 | 接受。改成「挡不住 CLI 自带的」：用户同步的技能没有加载 |
| §4.1「第 4 个回合起」 | 推翻 | 接受，已核实是第 5 个 init 帧。并写明 init 帧比登录状态晚一个回合 |
| 3a「只差一个变量」 | 打折扣 | 接受。`--phase init` 的两次命令表还差 4 项；干净对照只有零模型阶段。结论改成「`Workflow` 工具去掉了，工作流命令还在，能否启动未测」 |
| 4b「第一次轮询就出现」 | 打折扣 | 接受。改成「≤1 s 出现，`status` 在 1–2 s 之间」；和 S5 的差别不只来自负载 |
| 1a 的次数和计时起点 | 打折扣 | 接受。改成 9 次 `query()`（含复核后补的对照），时间从调 `query()` 算 |
| 4c「20 ms 的回合一次都没看到」 | 打折扣 | 接受。改成「分不出来」：它们落在第一段 busy 里 |
| 4d「peerToken 对自有会话同样成立」 | 打折扣 | 接受，标成推断：没查 `.key` 文件 |
| 6「peek 不用改」 | 打折扣 | 接受。补上：256 KiB 尾读窗口很快会被 `api-request-blob` 占满；空行是 8 种非消息行加 8 行 `api_error`；这些行型早有记录，不是 2.1.310 新出现的；「一一对应」只比了计数 |
| §4.4「account 不代表已登录」 | 打折扣 | 接受。零模型阶段早于第一次刷新失败，证据偏弱，要重测 |
| §6 失败原因和回合数；「建议的 0.05」r4 里没有 | 打折扣 | 接受。按运行逐个写失败原因；0.05 注明出自任务简报 |
| §5 选项 A 引用不准：Q8 已定沿用你的配置根，§5.3 只能算类比 | 引用不准 | 接受。§5 重写：先写和 Q8 的冲突，再列选项 |
| 1c：也可能是环境白名单造成的 | 打折扣 | 补测了对照：`--env inherit` 继承完整环境（只去掉桌面宿主的消息管道、会话 id 和沙箱代理），仍是 `authentication_failed`，$0。这条原因排除 |
| transcript 体积 §2 和 §7 不一致 | 小问题 | 统一成 204,617 B |

## 代号速查

| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| r4 | 现行设计规格 | `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` |
| M0 / M1 | M0：只读观察，不拉起会话；M1：自有驱动，Orchestra 自己拉起会话、收发消息 | r4 §13.2、§13.3 |
| 自有乐章 | Orchestra 自己拉起并驱动的一次 harness 会话 | r4 §7.1 |
| S3 | M1 的 Claude 后端 spike：vendored 后端、haiku 真实回合、MCP 注入、`msg_lifecycle_v1`、`/goal`、工具名等 | r4 §13.3（第 2404 行） |
| S5 | 2026-10-29/30 的 Claude 根目录与等待信号 spike | `spikes/s5-claude/REPORT.md` |
| Q8 | 自有 Claude 会话的配置根：2026-10-29 已定 A，沿用你的 `CLAUDE_CONFIG_DIR`、复用你的登录 | r4 第 2908 行 |
| `command_lifecycle` | 流里的消息生命周期帧，r4 用 `state:'started'` 当投递确认 | r4 第 952 行 |
| `claude-haiku-only` | 契约守卫：真实回合只许走 haiku | r4 §7.2 |
| `msg_lifecycle_v1` | `system/init.capabilities` 里的一项协议能力；r4 用它做能力检查 | r4 §7.1、§7.2 |
| `sdk-cli` / `sdk-ts` | 注册表的 `entrypoint`：前者是 `claude -p` 加 stdio 审批，后者是 SDK 的 `query()`（本次实测） | r4 §7.1 表后；本报告 §1 |
| 配置隔离 | 自有会话不读用户的 settings、MCP、hooks | r4 §7.4 |
| `--env-allowlist` | procguard 的 `run-in-job` 只把白名单里的环境变量传给子进程 | r4 §5.2、§10.16 |
| magpie / opencode-go | 本机装的第三方模型网关，以及它接的一家转售服务；§9 的模拟后端 | 本报告 §9 |
| Steer / Queue | 插话（加进正在跑的回合）/ 排队（当前回合结束后再开始） | r4 §8.2（第 952 行） |
