# Claude Agent SDK 探针：报告

日期：2026-11-01（UTC 约 21:05–21:45）。分支 `claude/sdk-probe-bead9f`，从最薄通路分支 `claude/m0-thin-slice-e9066d` 的 3b34a53 切出。

**一句话结论：partial。** SDK 能在本机以普通权限（Medium 完整性）拉起 Claude 会话，收发都通，注册表、磁盘 transcript、peek 页这三条只读路径都能看到这次会话。但子进程**鉴权失败**，没有一次真正调到模型。所以凡是要模型真正回答的问题都还没答：插话（`next`）、排队（`later`）、中断一个在跑的回合、`canUseTool` 拒绝后会话怎么走、注册表里的 `waiting`。

花费 $0。

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
- 子进程环境用白名单：只带系统变量、`CLAUDE_CONFIG_DIR`、`HTTPS_PROXY`（见 §1）。原因见 §6 第 3 条。

SDK：npm 上有 r4 §7.2 钉的 **0.3.287**（2026-10-01 发布；当前 latest 是 0.3.316），就用它。它带一个平台包 `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.287`，里面有自己的 `claude.exe`（对应 Claude Code 2.1.287）。探针没用这个自带的，用的是 2.1.310。装在 `spikes/claude-sdk/package.json`，版本钉死，提交了 lockfile（v3，112 个包），`node_modules` 被根目录 `.gitignore` 的 `node_modules/` 忽略。根目录 `package.json` 仍是零依赖。

## 1. 逐题结论

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1a | 能否以普通权限拉起会话 | **能** | 4 次 `query()` 都拉起了 CLI：`initializationResult()` 在 1.8 s 内返回，`system/init` 在 1.6–2.9 s 到达。全量测试里要真正启动 orchestrad 的用例都过了，说明本会话不是提权运行（orchestrad 在提权环境下拒绝启动）|
| 1b | 能否拿到回复 | **不能，鉴权失败** | 运行 1：每个回合都是 CLI 合成的错误（assistant 的 `model` 是 `<synthetic>`，`isApiErrorMessage: true`），内容是 `API Error: 403 Request not allowed`。运行 2 加了代理以后变成 `OAuth session expired and could not be refreshed`，之后是 `Not logged in · Please run /login`；`system/api_error` 记的是 401 `invalid x-api-key` |
| 1c | 鉴权走哪个配置目录 | 继承的 `CLAUDE_CONFIG_DIR`，即本会话所在的账号目录 `accounts/54102/config` | 子进程只拿到这一个配置目录。`init.apiKeySource` = `none`。这个目录里存的登录已过期，刷新失败。桌面应用里的 CLI 是由宿主代为续期的：本会话的环境里有 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`。单独拉起的子进程拿不到这种续期（推断：没有去读凭据文件，见 §5）|
| 1d | 网络 | CLI **不读 Windows 系统代理**，要显式传 `HTTPS_PROXY` | 不经代理时，连一个不带任何凭据的 `curl` 都得到 403 `forbidden / Request not allowed`；正常情况下不带凭据应该是 401。改走系统代理（HKCU 里的 `ProxyServer` = 127.0.0.1:10809）后，同一个 `curl` 得到正常的 401 `x-api-key header is required`。会话环境里的 `https_proxy=127.0.0.1:12477` 是沙箱的中间人代理，证书不受信，不能给子进程用 |
| 1e | `system/init.capabilities` 里有没有 `msg_lifecycle_v1` | **有**（2.1.310） | 13 项：`interrupt_receipt_v1, interrupt_cancel_queued_v1, interrupt_send_now_v1, interrupt_requeue_taken_v1, msg_lifecycle_v1, request_marker_lists_v1, lifecycle_wakeup_source_v1, sdk_mcp_tools_list_changed, sdk_mcp_manifests, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1, mcp_call_result_not_for_model_v1`。init 帧在调模型之前发出，不受鉴权失败影响。注意：`initializationResult()` 返回的 `capabilities` 是另一张表，只有 `ui_surface_v1, mcp_call_result_not_for_model_v1` 两项；能力检查要看 `system/init`，不要看 initialize 的返回 |
| 2a | `streamInput` 发后续消息 | **通**，每条消息开一个回合 | 运行 2：首条消息走 `prompt`，后面 6 条走 `q.streamInput()`；7 条消息各得到一组 `system/init` → `system/status` →（`system/api_retry` ×2）→ `assistant` → `result` |
| 2b | `next`（插话）/ `later`（排队） | **未测** | 探针等长回复流出第一个文字增量后再发插话或排队消息。但每个回合都在 20 ms–2.7 s 内以合成错误结束，等增量等到 60 s 超时，消息是在会话空闲时才发的，不说明任何语义。磁盘上的行都没有 `priority` 字段，同样因为没测成，不能当证据 |
| 2c | `interrupt()` 能否停下当前回合 | **未测** | 只测到会话空闲时调用 `interrupt()` 会返回 `{still_queued: []}`，不抛错 |
| 3a | 工作流有没有关掉 | **关掉了** | 同一配置目录、同一 CLI，只差这一个环境变量，各跑一个回合（`--phase init`）：不设时 `system/init.tools` 有 28 项，含 `Workflow`；设了是 27 项，没有 `Workflow`；技能和命令表也少了 `deep-research`、`workflow-authoring`。零模型阶段的命令表差异与此一致 |
| 3b | `canUseTool` 有没有被调用；拒绝后会话怎么表现 | **未测** | 0 次调用：模型没跑起来，就不会有工具调用 |
| 4a | 注册表 `sessions/<pid>.json` 的 `entrypoint` | **`sdk-ts`**，`kind` = `interactive`，`version` = 2.1.310 | 1 s 轮询，只读文件名是 `<数字>.json` 的那些，按 `sessionId` 或 `cwd` 匹配。r4 §7.1 表后和 S5 记的 `sdk-cli` 是 `claude -p` 加 stdio 审批的入口；SDK 的 `query()` 是另一个值。M1 判断「这是不是 Orchestra 自己的会话」，两个值都要认，并且不能只靠它（见 §6 第 4 条）|
| 4b | 注册表出现得多快 | 第一次轮询就出现：`query()` 后约 1.0 s 已有文件，约 2.1 s 出现 `status` 键 | 运行 1 和运行 2 一样。S5 在高负载下测到的是 28–46 s，这次机器不忙（推断：差别来自负载）|
| 4c | busy / idle / waiting 能否用 1 s 轮询看到 | busy 与 idle：**能**，限于长过轮询间隔的回合。waiting：**未测** | 运行 2：2.3–2.7 s 的回合（两次 API 重试）都看到了 busy → idle（两个连着的回合合成一段 busy，各 5.0 s）；20 ms 的回合一次都没看到。会话关闭后的下一次轮询（≤1 s）里，注册表文件已经消失。没有工具调用，所以没有出现 `waiting` |
| 4d | 注册表的键 | `cwd, entrypoint, kind, messagingSocketPath, name, nameSince, nameSource, peerFeatures, peerProtocol, pid, pidDomain, procStart, sessionId, startedAt, version`，有状态后再加 `status, statusUpdatedAt, updatedAt` | SDK 拉起的会话**也开了消息管道**（`messagingSocketPath`、`peerProtocol`）。r4 §7.1「非自有会话的控制」一行说磁盘上的 `peerToken` 可能让同用户进程往会话里注入消息（未核实）。这对自有会话同样成立 |
| 5 | SDK 事件流和磁盘 transcript 的对照 | 有重叠，也各有对方没有的东西。见 §2 | 运行 2：流里 36 个带 uuid 的消息，磁盘上 48 个带 uuid 的行，两边共有的只有 7 个，全是 assistant |
| 6 | peek 页能否读出这次会话 | **能，读取器不用改** | `peek-check.mjs` 起一个测试 profile 的 orchestrad（`--test-profile --peek-port`），根目录里只放这一个 transcript 的副本。配对 303；列表 200、1 行；会话页 200、**91 行，对应 transcript 的 91 行**，类型一一对应。问题是 91 行里有 77 行「内容」列是空的：读取器只给 user、assistant、system、summary 取文字，2.1.310 新出现的 7 种行（见 §2）都只显示类型。列表里的项目名不是原样的目录名（推断：经过了脱敏器，`peek.ts` 第 92 行）|
| 7 | S3 遗留项 | 见 §3 | |

## 2. 事件流与磁盘的对照（运行 2）

运行 2 的 7 个回合全是合成错误，所以下面**没有** tool_use、tool_result、真正的 assistant 文本，也没有 `stream_event`（流式增量），这些都要等真实回合再对照。

| 只在 SDK 事件流里 | 两边都有 | 只在磁盘上 |
|---|---|---|
| `system/init`（每回合一帧，带 tools、命令、技能、插件、capabilities）×7 | `assistant` ×7（同一 uuid） | 我们发的 `user` 消息 ×7。流里不回显，磁盘行带 `promptId, promptSource, turnOrigin, turnPosition` |
| `system/status` ×7 | | `attachment` ×26，11 种：`environment, model, deferred_tools_delta, agent_listing_delta, skill_listing, total_tokens_reminder, budget_usd, session_context, date, credential_org, prompt_snapshot` |
| `result`（每回合一个，带累计花费、`modelUsage`、`permission_denials`）×7 | | `system/api_error` ×8（同一时刻流里是 `system/api_retry`，uuid 不同） |
| `system/api_retry` ×8 | | 不带 uuid 的行：`queue-operation` ×14（`enqueue` / `dequeue`）、`api-request` ×8（`params` 的键：`betas, context_management, max_tokens, model, output_config, thinking`；`querySource` = `sdk`）、`api-request-blob` ×8（存请求消息的正文块）、`api-request-shape` ×2、`atis-latch` ×5、`last-prompt` ×5、`cost-state` ×1（只在最后一行） |

对 M1 的含义：r4 §5.2 要求自有会话的事件也经只读解析器，好让自有和只读两边共用一套事件模型。按这次看到的结构，这一条做得到，但不够：

- **回合边界和花费只在流里有。** 磁盘上没有 `result`，花费只有最后一行 `cost-state`。驱动的「回合结束」「花了多少」要从流里取。
- **用户消息、排队操作只在磁盘上有。** 流里看不到自己发出的消息落盘没有、什么时候出队。
- **磁盘比流晚。** S5 测过 tool_use 写进 transcript 比 stdout 晚 0.8–2.5 s。

所以 M1 的形状更像：消息内容走解析器（和只读一侧同一套）；回合生命周期、花费和审批走流。两边用 assistant 的 uuid 对齐。这是推断，要在真实回合上再对一次。

磁盘体积：7 个只有一句错误的回合，transcript 就有 204 KB，因为每次请求都把正文块存进 `api-request-blob`。

## 3. S3 遗留项（r4 末尾「未核实」清单里和 SDK 会话相关的几条）

S3 是 r4 §13.3 里 M1 的 Claude 后端 spike。

| 项 | 结论 | 证据 |
|---|---|---|
| 乐章实际生效的 effort 能否回读 | **设定值能回读；API 是否照办未测** | 传 `effort: 'low'` 后，`q.getSettings()`（SDK 有这个方法，但 `sdk.d.ts` 的 Query 接口里没声明）的 `applied.effort` = `low`，不传时是 `medium`；磁盘上的 `api-request.params.output_config.effort` = `low`，`assistant.perTurnEffort` = `low`。`system/init.effort` 是 null：类型注释说只有 Remote Control 一类宿主才发这个字段 |
| 传 `disableAllHooks: true` 能否关掉 `/goal` | **命令还在；执行未测** | 零模型阶段：`settings: {disableAllHooks: true}` 生效了（`getSettings().effective.disableAllHooks` = true），命令表里仍有 `goal`。没有执行 `/goal`：它会开启自动续跑，要调模型 |
| 愿望档案要用 `disallowedTools` 去掉的工具叫什么 | **名字已知** | 2.1.310 在本机 SDK 会话里暴露：`CronCreate, CronDelete, CronList, ScheduleWakeup, RemoteTrigger, PushNotification`；没有 `Monitor`，也没有 `Bash`（本机没有 Git Bash，只有 `PowerShell` 工具；后台执行的参数在不在它上面未查）。另有 `SendMessage, ListAgents, DesignSync, ReportFindings, AskUserQuestion, EnterWorktree` 等，完整列表见 §7 的 `init.json` |
| SDK 能否报告回合结束时还在跑的后台任务数 | 未测 | SDK 有 `backgroundTasks()` 方法和 `background_tasks_changed` 事件（据类型声明），没跑到 |
| `autoContinueAtUsageLimit: false`、`maxEffortLevel` 在 SDK 会话里是否生效 | 未测 | |
| `settingSources: []` 下 CLAUDE.md 附加段是否生效 | 未测 | |
| 经 `spawnClaudeCodeProcess` 由 procguard 拉起 | 未测 | 探针直接由 SDK spawn |

## 4. 顺带发现（会影响 M1）

1. **同一个会话里，工具表会在回合之间变。** 运行 2 的第 4 个回合起，`system/init.tools` 多了 `RemoteTrigger`，技能多了 `schedule`；运行 1 一开始就有。推断这和账号的登录状态有关。r4 §7.4（第 902 行，愿望档案）要求「每次乐章启动断言 `system/init.tools`」，只在启动时断言不够，要每个回合的 init 帧都断言。
2. **`settingSources: []` 挡不住插件和技能。** 每个 init 帧都报 3 个插件（`cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring`）和 16–18 个技能（`design, dataviz, loop, schedule, claude-api, run…`）。来源没查：可能是 CLI 自带的，也可能来自配置目录的 `plugins/`、`skills/`。r4 §7.4 的配置隔离要把这一条算进去。
3. **子进程的环境必须用白名单。** 本会话是桌面应用托管的，环境里有 `CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_HOST_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION`、沙箱代理等几十个变量。SDK 默认把 `process.env` 整个传给子进程，子进程就会以为自己是桌面会话的一部分。orchestrad 自己不跑在桌面会话里，但 r4 §10.16 的 `--env-allowlist` 思路同样适用于 Claude host。
4. **`initializationResult().account` 不代表已登录。** 登录已过期时它照样返回 `email` 和 `subscriptionType`（只记了键名）。接入向导的「登录状态」卡（r4 §5.2 SecretStore 与接入向导一行）不能拿它当判据；要么跑一个真实回合，要么看 `api_error`。
5. **代理。** 见 §1 第 1d 行。M1 的 Claude host 要从 Tuning 或系统设置拿代理，显式传 `HTTPS_PROXY`。

## 5. 没验到的，和怎么补

真实回合全卡在鉴权上。要补，得先让子进程能登录。选项（要用户定）：

- A. 给 Orchestra 单独一个 Claude 配置目录（例如 `%USERPROFILE%\.orchestra-claude-probe`），由用户本人在那里登录一次：`$env:CLAUDE_CONFIG_DIR='…'; claude`，再在里面执行 `/login`。好处：探针的会话目录不进日常的 `projects/`，和 r4 §5.3「`~/.orchestra` 不得在 harness 根目录之内」的方向一致。代价：多一份登录；M1 是不是也这样做，要另外定。
- B. 用本机其它已有的配置目录（S5 当时用的是 `accounts/53087/config`）。我没有去看那些目录里的登录是否有效：那要读凭据文件。
- C. 就停在这里，等 M1 的 S3 再测。

补测命令（选 A 或 B 之后，约 4 分钟，haiku，预计远低于 $0.15）：

```
node spikes/claude-sdk/probe.mjs --phase live --proxy http://127.0.0.1:10809 --config-dir <目录> --out <草稿区>/evidence
node spikes/claude-sdk/summarize.mjs <草稿区>/evidence/live.json
node spikes/claude-sdk/peek-check.mjs --transcript <目录>/projects/<…>/<sessionId>.jsonl
```

真实回合跑通以后还要看：§1 的 2b、2c、3b、4c 的 waiting；§2 里 tool_use / tool_result / stream_event 的对照；§3 的 effort 是否真被 API 采用。

## 6. 花费

**$0。** 没有一次请求被 API 接受。运行 1 是 403（网络层拒绝），运行 2 和 `--phase init` 是 401（凭据无效）。所有 `result.total_cost_usd` 都是 0，`modelUsage` 都是空的。上限：运行 2 一个 `query()` 设 `maxBudgetUsd: 0.15`（比建议的 0.05 高：一个 `query()` 里有 5 个回合加一次空闲，SDK 的预算按整个 `query()` 累计）；`--phase init` 每个 `query()` 0.02；零模型阶段 0.01（不调模型）。

## 7. 留在本机的痕迹

**claude 自己写进 `accounts/54102/config` 的**（没有删，由用户决定）：

`projects/` 下 5 个目录，名字都以 `C--Users-Calx-AppData-Local-Temp-orchestra-sdk-` 开头：

| 目录后缀 | 来源 | 内容 |
|---|---|---|
| `zero-1zXME0`、`zero-JbXzIY` | 零模型阶段（两次） | 只有一个空的 `memory/`：没发消息也会建目录 |
| `probe-ejqi6N` | 运行 1（无代理） | 1 个 jsonl，181 KB |
| `probe-aC0TNi` | 运行 2（有代理） | 1 个 jsonl，205 KB |
| `init-VRk5ea` | `--phase init` | 2 个 jsonl，共 57 KB |

注册表：这几次会话的 `sessions/<pid>.json` 都已自行删除。查不了的：每个新会话可能往 `.claude.json`、`history.jsonl` 写了东西（没有读这些文件）。

**进程**：结束前按命令行查过，没有残留的 claude.exe 或 node.exe。

**临时目录**：探针的 5 个 cwd（系统临时目录下 `orchestra-sdk-*`）始终是空的，已删除。`peek-check.mjs` 的测试 profile 目录用完即删。

**证据**（只有结构、计数、键名、时间，不含会话内容）在本会话的草稿区 `…/scratchpad/evidence/`：`zero.json`、`live-run1-no-proxy.json`、`live.json`、`init.json`、`peek-check.json`、`projects-before.txt`。草稿区不跨机器，所以本报告里的数字是自足的。

**读的范围**：只打开过 `sessions/<数字>.json`、`projects/` 下这几次会话自己的 jsonl。为了诊断，读过 transcript 里 CLI 合成的错误文本（只有三种，都已原文写在 §1）。没有读 `.key`、`.claude.json`、任何凭据文件。

## 8. 复现

Node 用 `.tools/node24/node.exe`（24.22）。会话里 Bash 的沙箱代理会让 npm 和 claude 都连不上，以下命令要在不经沙箱代理的环境里跑，并显式传系统代理。

```
cd spikes/claude-sdk
npm ci --ignore-scripts                     # 装 lockfile 里钉死的 0.3.287
node probe.mjs --phase zero --proxy http://127.0.0.1:10809 --out <dir>   # 不调模型，约 12 s
node probe.mjs --phase init --proxy http://127.0.0.1:10809 --out <dir>   # 每种工作流设置 1 个回合；登录失效时 $0
node probe.mjs --phase live --proxy http://127.0.0.1:10809 --out <dir>   # 约 4 分钟；登录有效时会花钱（haiku，上限 $0.15）
node summarize.mjs <dir>/live.json
node peek-check.mjs --transcript <CLAUDE_CONFIG_DIR>/projects/<目录>/<sessionId>.jsonl --out <dir>/peek-check.json
```

脚本：

| 脚本 | 作用 |
|---|---|
| `probe.mjs` | 拉起会话、轮询注册表、记录事件流和 transcript 的结构 |
| `summarize.mjs` | 把 `live.json` 打成时间线、注册表、流与磁盘对照 |
| `peek-check.mjs` | 用测试 profile 的 orchestrad 和 peek 页读回一个 transcript，只输出计数和类型 |

全量测试：`.tools/node24/node.exe --test "test/**/*.test.ts"`，958 条，955 过、0 失败、1 跳过、2 todo，和起点（最薄通路分支 3b34a53）相同。

## 代号速查

| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| r4 | 现行设计规格 | `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` |
| M0 / M1 | M0：只读观察，不拉起会话；M1：自有驱动，Orchestra 自己拉起会话、收发消息 | r4 §13.2、§13.3 |
| 自有乐章 | Orchestra 自己拉起并驱动的一次 harness 会话 | r4 §7.1 |
| S3 | M1 的 Claude 后端 spike：vendored 后端、haiku 真实回合、MCP 注入、`msg_lifecycle_v1`、`/goal`、工具名等 | r4 §13.3（第 2404 行） |
| S5 | 2026-10-29/30 的 Claude 根目录与等待信号 spike | `spikes/s5-claude/REPORT.md` |
| `claude-haiku-only` | 契约守卫：真实回合只许走 haiku | r4 §7.2 |
| `msg_lifecycle_v1` | `system/init.capabilities` 里的一项协议能力；r4 用它做能力检查 | r4 §7.1、§7.2 |
| `sdk-cli` / `sdk-ts` | 注册表的 `entrypoint`：前者是 `claude -p` 加 stdio 审批，后者是 SDK 的 `query()`（本次实测） | r4 §7.1 表后；本报告 §1 |
| 配置隔离 | 自有会话不读用户的 settings、MCP、hooks | r4 §7.4 |
| `--env-allowlist` | procguard 的 `run-in-job` 只把白名单里的环境变量传给子进程 | r4 §5.2、§10.16 |
