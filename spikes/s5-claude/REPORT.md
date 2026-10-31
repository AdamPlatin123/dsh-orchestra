# S5 Claude 根目录与等待信号：报告

日期：2026-10-29 至 10-30（UTC）。

- 第一任执行者在 22:41–23:38 UTC 做完调模型的实跑（4 个会话）。
- 第二任执行者做了零模型复核和汇总。
- 复核者复跑了零模型部分，提出 10 条意见（S5-CLAUDE-01 到 10）。
- 本版由修复者在 01:10–01:40 UTC 按意见修改，另外加了两项零模型、零写入的观测：被动轮询注册表 25 分钟；只读的过期注册表对照窗口。

本版没有起任何 claude 会话，没有调模型。

## 1. 问题

规格 r4 §13.2 第 2346 行原文：

- **要回答的问题**：枚举所有 `CLAUDE_CONFIG_DIR` 根目录；人为挂起一个审批，记录这段时间 registry 的 `status` / `statusUpdatedAt`、jsonl 的变化，以及 `claude agents --json` 是否有 `waitingFor` 之类的字段、每次调用耗时
- **go 判据**：根目录清单完整；存在可用的等待信号
- **no-go 后备**：没有等待信号时，工具调用发出后静默超过 20 s，生成一条低置信的「可能在等你」条目；Q6 从「偏好题」变成「可行性题」（≤5 s 只能靠 hooks）

## 2. 结论：partial

等待信号确实存在，就在注册表 `sessions/<pid>.json` 里：`status` 变成 `waiting`，并带上 `waitingFor`。SDK 宿主路径实测到了，Desktop 托管路径被动观察到了。但终端 TUI 路径一次也没测成；`-p` 配 MCP 审批工具的路径没有信号；根目录完整性也只在一个有活会话的根上验证过。所以判 partial，规格改动只能先落在 SDK / Desktop 路径上。

| 路径 | 结论 | 依据 |
|---|---|---|
| 根目录清单 | go，有限定 | 候选 5 个，存在 4 个。四次检查中，活着的 Claude Code 进程 7/7、11/11、11/11、9/9 都在注册表里。但这些进程全是 Desktop 拉起的，只有 53087 一个根有活会话；终端 TUI 进程在新目录里活了 75 s / 150 s，都没写注册表 |
| SDK 宿主（`-p --permission-prompt-tool stdio`，entrypoint `sdk-cli`；Orchestra 自有 Claude 乐手也走这条） | go | run C（n=1）：注册表比审批请求早 328 ms 写出 `waiting` / `permission prompt`，0.5 s 轮询在 448 ms 后看到 |
| Desktop 托管（entrypoint `claude-desktop`，本机所有活会话都是这种） | 观察到 waiting；`permission prompt` 这一种还没亲眼见过 | 被动轮询 1500 s：一个 Desktop 会话 `waiting` / `input needed` 持续 678 s，之后回到 `busy`。`permission prompt` 只有静态证据：Desktop 实际跑的 2.1.308 二进制里有同一张状态映射，并且无条件订阅后写注册表 |
| 终端 TUI | 未验证 | run D、probe E 都没写出注册表（推测卡在信任对话框） |
| `-p --permission-prompt-tool mcp__…` | 没有信号 | A、A2：MCP 审批工具不回复时，注册表一直是 busy |

简报 §5 第 5 点，逐条回答：

- **有没有可用的等待信号**：有。文件是 `<root>/sessions/<pid>.json`，字段是 `status`（值为 `waiting`）和 `waitingFor`。它和审批请求同时出现：run C 里比 stdout 上的 `can_use_tool` 早 0.33 s。从 `tool_use` 到审批请求，run C 用了 28.2 s，但这段时间 spike 自己的 `claude agents --json` 探针几乎一直在跑（重叠 28.1 s），PreToolUse hook 也跑了 7.0 s，所以这个数不能代表 Claude 本身（S5-CLAUDE-03）。
- **hooks 路径的延迟**：机器高负载、有 spike 自身干扰时，PermissionRequest hook 的时间戳比审批请求晚 0.87 s（A2）/ 4.8 s（C）。hook 的启动事件和审批请求在同一毫秒，多出来的时间是 node 冷启动加负载，不是 hook 机制本身慢；A2 本来就在 2 s 以内。Notification hook 晚 10.0–11.1 s，原因没查清：推测和 PermissionRequest hook 先跑有关，未证实。这些数不能说明 hooks 做不到 ≤2 s。
- **`claude agents --json` 能不能当信号**：内容上能，等待时有 `waitingFor`。但每次调用 4.0–6.1 s（空闲）或 7.9–35.2 s（实验期间），而且会写根目录。Orchestra 不能用它。
- **对 Q6 和 M0 验收的含义**：在 SDK / Desktop 路径上，「需要输入 ≤5 s」不靠 hooks 也能做到，Q6 对这两条路径回到偏好题。TUI 路径测到之前，Q6 对 TUI 仍是可行性题。「装了 hooks ≤2 s」这条门槛先保留，等用轻量 hook、关掉探针复测后再定。

**升级成 go 只差一步**（M0 里做，最多 1 次模型调用）：开着 `passive-poll.mjs`，由用户在一个已信任的目录里起一次终端 `claude`，让它触发一次 Bash 审批；再在一个 Desktop 会话里遇到一次审批（正常使用中碰上就行）。两边都出现 `waiting` / `permission prompt`、批准后回到 `busy`，S5 就是 go。

## 3. 数字

「高负载」指 22:41–23:38 UTC 的实验期间：spike 背靠背地跑 `claude agents --json`，另外还有 3 个 spike 同时在跑；一次零模型的 claude 启动就用了 116 s。

| 量 | 值 | 怎么测的 |
|---|---|---|
| 候选根 / 实际存在的根 | 5 / 4：`accounts/53087/config`（即 CLAUDE_CONFIG_DIR）、`~/.claude`、`accounts/46470/config`、`accounts/52373/config`；`~/.config/claude` 不存在 | `roots.mjs`：候选来自环境变量、默认位置、XDG 和 `~/.rec/claude/accounts/*/config`，按 realpath 不分大小写去重，有 `sessions/` 或 `projects/` 才算根。22:55Z、00:37Z、01:16Z 三次结果相同 |
| 其它位置 | AppData 下各 Claude 目录、`.claudecode`、`.reclaude`、`accounts/*/app/…` 都没有 `sessions/` 或 `projects/`；`claude --help`、`claude doctor --help` 没提到其它根 | 第一任执行者逐个看目录名 |
| 注册表条目数（`.key` 同数，只数不读） | 53087：7 → 11 → 9（22:55Z / 00:37Z / 01:16Z）；其它三个根始终是 0 | `roots.mjs` |
| `projects/` 子目录数 | 53087：10 → 16 → 16；46470：22；52373：6；`~/.claude` 没有 `projects/`，有空的 `sessions/`、`backups/` 和 `settings.json` | `roots.mjs`，只数名字 |
| 完整性：活着的 Claude Code 进程能在注册表里找到 | 7/7、11/11、11/11（复核者）、9/9，缺 0；同时排除的 Desktop Electron 进程 18 / 14 / 12 / 13 个。只覆盖 53087 一个根：这些进程的 exe 都是 `accounts/53087/app/claude-code/2.1.308/…`，父进程都是 Desktop | `roots.mjs`：Get-CimInstance 列出 claude.exe，exe 旁边有 `resources/app.asar` 的算 Electron。本版改为按 `<pid>.json` 文件名匹配，启动不到 60 s 的进程单独记为「宽限期内未注册」 |
| 注册表 status 分布 | busy 6 idle 1 → busy 7 idle 4 → busy 3 idle 5 waiting 1；全部是 interactive / claude-desktop / 2.1.308 | `roots.mjs`；01:16Z 那次正好有一个 Desktop 会话在等 |
| 注册表键名 | 简报列的 18 个，另有 `nameSource`（偶尔出现）和 `waitingFor`（只在等待时出现） | `roots.mjs` 的键频次；hang-*.json |
| `updatedAt − statusUpdatedAt` | 中位 0，最大 4572 ms | `roots.mjs` |
| `roots.mjs` 一次耗时 | 9.1–10.0 s（高负载）、5.2 s（复核时）、9.1 s（本版） | 前后时间差 |
| Desktop 会话被动观察 | 1500 s、2826 轮、23153 个样本、10 个 Desktop 会话：busy 12921、idle 9437、waiting 787、无 status 键 8。只有一段 waiting：`input needed`，在轮询开始前约 258 s 就开始了，共持续 678 s，之后变成 `busy`。状态转换：busy→idle 10、idle→busy 9、waiting→busy 1 | `passive-poll.mjs`：只读 `%CLAUDE_CONFIG_DIR%/sessions/*.json`，0.5 s 一轮。复核者之前轮询 240 s，一次 waiting 都没看到 |
| 新会话从注册表出现到有 status 键 | 3.2–9.1 s（spike 会话，高负载）；5.1–11.2 s（复核者看到的 4 个 Desktop 会话）；4.2 s（本版，1 个） | regSamples；被动轮询 |
| 注册表首次出现距 spawn | 27.8–46.4 s（高负载） | hang-*.json 的 regSamples |
| `claude agents --json` 空闲耗时 | 4011 / 5139 / 6112 ms（最小 / 中位 / 最大，n=5） | `agents-probe.mjs` 串行调用 |
| `claude agents --json` 实验期间耗时 | 7905 / 21846 / 35237 ms（n=17）；清扫那次 11061 ms | `hang-run.mjs` 背靠背调用 |
| `claude agents --json` 元素键名 | `cwd, kind, name, pid, sessionId, startedAt, status`，等待时多一个 `waitingFor`；没有 `needsInput` / `blocked` | agents-probe；run C |
| `claude agents --json` 写根目录 | 5 次调用的 25.8 s 窗口里：`.claude.json` 被改 1 次，新建 `daemon/pipe.key`（16 B）；同样长的空闲窗口里 0 处变化。它还删过过期的 `sessions/41788.json`，当时 `.key` 留着；01:20Z 复查时已经没有孤立的 `.key` | 只做 stat 的快照对比；`stale-sweep.json`（单样本）；`stale-sweep-control.json` |
| run C：注册表 waiting 与审批请求的先后 | −328 ms（statusUpdatedAt 89247 ms，`can_use_tool` 89575 ms，都相对 spawn）；`waitingFor` = `permission prompt` | `hang-run.mjs --mode stdio`，0.5 s 采样 |
| run C：轮询滞后 | 448 ms | 轮询看到的时刻 − statusUpdatedAt |
| tool_use → 审批请求（高负载，有 spike 干扰） | C 28169、A2 15085、A 14023 ms；B 在 8767 ms 后自动拒绝。这四段窗口里，探针分别跑了 28097 / 14724 / 14023 / 8766 ms，几乎是整段；C、A2 的 PreToolUse hook 还各占 6966 / 2769 ms。C 在一次探针调用结束后 51 ms 就变成 waiting | stdout 时间戳；`summarize.mjs` 的 `interference` 字段 |
| PermissionRequest hook 时间戳距审批请求（高负载） | C 4836、A2 868 ms；hook_started 和审批请求在同一毫秒 | `stamp.mjs`，exec 形式，node 22 |
| Notification hook 距审批请求（高负载） | 不限类型的 10000 ms、permission_prompt 的 11077 ms（C） | `stamp.mjs` |
| hook 进程启动耗时（高负载） | PreToolUse 4208（C）/ 2154（A2）ms；PermissionRequest 4836 / 865 ms | hook_started 到第一行时间戳之差 |
| 等待期间 transcript 的变化 | C、A2 都是 0 条新记录；最后一条一直是 assistant（tool_use） | 每 0.5 s 看文件大小和最后一条的 type |
| transcript 写入 tool_use 比 stdout 晚 | 836–2507 ms（A2 836、B 1214、C 1347、A 2507） | trSamples 与 stdout 时间戳之差 |
| `-p` 配 MCP 审批工具（A2） | tool_use 后 96 s、`tools/call` 后 81 s 内注册表一直是 busy，从没出现 waiting | `hang-run.mjs --mode mcp` |
| `-p` 不带审批工具（B） | tool_use 后 8767 ms 自动拒绝（permission_denials = 1），不会挂起；注册表 busy → idle，退出时删除 | `--mode none`（旧版脚本） |
| taskkill /F 后的注册表文件 | A：5945 ms 后消失，当时没有探针在跑（A 的 entrypoint 是 claude-desktop）。C：7681 ms 后消失，当时探针正在跑，而且结果里已经没有这个会话，很可能就是探针删的。A2：超过 15 s 仍在，后来被一次 `agents --json` 删掉了 `.json` | 每 250 ms 检查一次文件是否存在 |
| hook 写法 | exec 形式（command + args）能跑；shell 形式（带引号的路径；本机没有 Git Bash，会走 PowerShell）报 error；UserPromptSubmit 退出码 2 能拦住提示词，0 次模型调用；这次零模型启动用了 116 s | `hook-load-check.mjs` |
| 静态分析：状态映射 | `{running:"busy",requires_action:"waiting",idle:"idle"}` 在 2.1.310 和 2.1.308 里各出现 1 处；两个版本都有 `sessionState.stateChanged.subscribe(…)`，无条件订阅后写注册表；`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 只控制 stdout 事件 | 对两个二进制做 `grep -a -o` |
| 静态分析：`waitingFor` 的取值 | `waitingFor:"…"` 形式的字面量：dialog open ×19、input needed ×5、sandbox request ×1、goal proposal ×1；带引号的 `"permission prompt"` 有 4 处（写在三元表达式和 switch 里，上面的模式抓不到）；`"worker request"` 3 处（TUI 路径） | grep；之前写的 ×3 改为 4 |
| 本机的 Claude Code 安装 | 2.1.308（Desktop 自带，所有活会话都用它）、2.1.310（`~/.local/bin`，在 PATH 上）、2.1.260（`%APPDATA%/npm/node_modules/@anthropic-ai/claude-code`，PATH 上没有它的 shim） | 注册表的 `version`；`claude --version`；package.json 的 version 字段 |
| 模型用量 | 4 个会话、5 个 API 请求（A 1、B 2、C 1、A2 1），全部是 claude-sonnet-5-5；B 实际计费 $0.0357；A / A2 / C 估算约 $0.12 / $0.07 / $0.03；合计约 $0.25 | `spend.mjs` 读本 spike 会话 transcript 里的 usage 和 cost-state；估算按 1:5:0.1:1.25 的价格比、用 B 的计费反推单价 |

## 4. 方法与复跑命令

脚本都在 `G:/_Projects/dsh-orchestra/spikes/s5-claude/`。下面是本版各脚本 sha256 的前 16 位：

| 脚本 | 作用 | sha256 前 16 位 |
|---|---|---|
| roots.mjs | 根目录枚举、注册表统计、完整性检查 | 5538d95ce4f6ef9a |
| passive-poll.mjs | 被动轮询注册表（本版新增） | d6d17e001615613c |
| stale-sweep.mjs | 过期注册表清理的对照实验（本版新增，替代原来的单行 bash） | 8288d646521dbdda |
| agents-probe.mjs | `agents --json` 计时与写根检查 | dd1d67039a7631d6 |
| hang-run.mjs | 挂起审批，采样全部信号 | abcea8633f1ddc07 |
| hang-mcp.mjs | 永不回复的 MCP 审批工具 | 7f0ba9a6380f916c |
| stamp.mjs | hook 时间戳 | 963bbac0ee9a70aa |
| hook-load-check.mjs | 零模型的 hook 加载检查 | 51382468db5a61e7 |
| interactive-probe.mjs | 零模型的 TUI 启动探针 | b719a1662ee964cd |
| spend.mjs | 本 spike 会话的模型用量 | ecb72dee90647b2e |
| summarize.mjs | 从证据文件重算全部数字 | 92792b8211a5e2e9 |

证据在草稿区 `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/spikes/s5-claude/evidence/`，共 16 个小 JSON，只含偏移、大小、计数、时间戳、键名、type 和状态取值。

环境：Git Bash 加系统 node 22.14。S5 用不到 zstd；便携 node24 在第一任执行者的会话里写草稿区时报 EPERM。

**零模型、零写入，5 分钟内能重跑：**

```
D=G:/_Projects/dsh-orchestra/spikes/s5-claude
S=C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/spikes/s5-claude
mkdir -p $S/evidence
node $D/roots.mjs --out $S/evidence/roots-fix.json            # 约 10 s
node $D/stale-sweep.mjs --control-s 20 --skip-agents --out $S/evidence/stale-sweep-control.json
node $D/passive-poll.mjs --seconds 120 --out $S/evidence/passive-poll-rerun.json   # 想碰上 waiting 就开久一点
node $D/spend.mjs --out $S/evidence/spend.json                # 只读本 spike 会话的 transcript
node $D/summarize.mjs --evidence $S/evidence --out $S/evidence/summary.json
X=/c/Users/Calx/.local/bin/claude.exe   # Desktop 用的是 ~/.rec/claude/accounts/53087/app/claude-code/2.1.308/<hash>/claude.exe
grep -a -o -E 'waitingFor:"[^"]{1,40}"' $X | sort | uniq -c
grep -a -o -E '.{0,12}"permission prompt"' $X | sort | uniq -c
grep -a -o '{running:"busy",requires_action:"waiting",idle:"idle"}' $X | wc -l
```

**会启动 claude、会写根目录的部分**：`claude agents --json` 会改 `.claude.json`、新建 `daemon/pipe.key`、删除过期注册表，违反零写入，要用户同意才跑。

```
mkdir -p $S/tmp/empty-cwd
cd $S/tmp/empty-cwd && node $D/agents-probe.mjs --runs 5 --cwd . --out $S/evidence/agents-probe-rerun.json
cd $S/tmp && node $D/hook-load-check.mjs --work . --out $S/evidence/hook-load-check-rerun.json   # 零模型，但会在 projects/ 下建目录
node $D/stale-sweep.mjs --control-s 30 --out $S/evidence/stale-sweep-full.json             # 含一次 agents --json
```

**调模型的部分**（复现等待信号）：

```
cd $S/tmp && node $D/hang-run.mjs --label C --mode stdio --work . --sample-s 90 --agents-max 6 --out $S/evidence/hang-C-rerun.json
#   复现证据 C：1 个 API 请求，约 3 分钟
cd $S/tmp && node $D/hang-run.mjs --label C2 --mode stdio --work . --sample-s 60 --agents-max 0 --hooks permission --max-turns 1 --out $S/evidence/hang-C2.json
#   复核者建议的干净复测：不跑探针、不装 PreToolUse hook、只跑 1 轮；用来量 tool_use → 审批和 PermissionRequest hook 的延迟
```

跑完删掉 `$S/tmp`。

**复跑结果对不上时，先看这几条：**

- `hang-run.mjs` 会给子进程注入 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`。静态分析显示它只控制 stdout 上的 `session_state_changed` 事件，不影响注册表。从本版起，证据文件里会记成 `injectedEnv`。
- 子进程的环境默认会去掉父会话的宿主变量（名字记在 `droppedEnvNames`），让它看起来像从终端启动。
- 证据 A、B 是旧版脚本跑的。A 用的是旧参数名，没有清理环境变量（所以 entrypoint 是 claude-desktop），hook 是 shell 形式（全部报错，`hooks` 为空）。B 没加 `--include-hook-events`，hook 记录也是空的。用现在的脚本跑 `--mode none` 会多出 exec 形式的 hook 和 hook 事件，结果不会和证据 B 一样。
- 2026-10-29 的证据文件没有记录脚本哈希；从本版起，每个脚本都会把 `script` 和 `scriptSha256` 写进输出。
- 旧版 `hang-run.mjs` 把 `registryAfterKill.existedAtKill` 写死成 true，所以 D 的 `goneAfterMs: 0`、E 的 `registryGoneAfterKillMs: 1` 没有意义：这两次从来没有过注册表文件。本版改为在 taskkill 之前检查，并记下当时探针是否还在跑。
- 本版还改了这些：`hang-run.mjs` 的正则 `/s+/` 改成 `/\s+/`（只影响 interactive 模式）；`agents-probe.mjs` 去掉 `shell: true`，直接调 claude.exe，并记下每次调用的 PID；`hook-load-check.mjs`、`interactive-probe.mjs` 会记下 claude 和 PowerShell 的 PID；`roots.mjs` 和 `passive-poll.mjs` 只打开 `%CLAUDE_CONFIG_DIR%` 下的注册表文件，其它根只数文件名（加 `--open-all-roots` 才会打开）。

## 5. 没验到的

1. **终端 TUI 路径。** run D（150 s，带提示词）和 probe E（75 s，不带提示词）都没写注册表，也没建 projects 目录。推测是卡在新目录的信任对话框，但没截屏，未证实。怎样验：M0 期间开着 `passive-poll.mjs`，由用户在一个已信任的目录里起一次 `claude`，触发一次 Bash 审批（1 次模型调用）；同时确认信任对话框阶段是不是根本不写注册表。
2. **Desktop 会话的 `permission prompt`。** 被动轮询只碰上了 `input needed`。怎样验：同上；或者 M0 日常使用时一直开着被动轮询，碰上一次就够（不需要额外的模型调用）。
3. **`dialog open` / `worker request` / `sandbox request` / `goal proposal`。** 只有静态证据。
4. **tool_use → 审批请求为什么要 8.8–28.2 s。** 四次实跑里，探针都几乎占满了这段窗口，C、A2 还有 PreToolUse hook。C 在一次探针调用结束后 51 ms 就变成 waiting，分不清是巧合还是争用（A2 的审批请求发生在一次探针调用中间）。怎样验：`hang-run.mjs --agents-max 0 --hooks permission --max-turns 1`（1 次模型调用）。
5. **空闲机器上的 hook 延迟，以及轻量 hook（小 exe 或 `type: http`）。** 没测，和上一条一起测。
6. **过期注册表由谁清理。** 推测：sdk-cli 会话留下的过期条目，要等下一个 claude CLI 启动时才清（`agents --json` 就是一种）；Desktop 会话的条目由宿主清。A（entrypoint 是 claude-desktop）的文件消失时没有探针在跑，符合这个推测，但只有一个样本。`stale-sweep.mjs` 已经写好，带对照窗口；完整模式要跑一次 `agents --json`，会写根目录，本轮没跑。本轮只读的对照窗口（20 s）里没有过期文件可观察。
7. **A、A2、C 的花费是估算（±30%）。** 这三次被 kill，没有 result 事件。A 继承了父会话的环境，stdout 出现过 `task_summary`，可能有 transcript 不记录的旁路请求。
8. **便携 node24 的异常。** 写草稿区报 EPERM；它起的 PowerShell 只看到 7 个 claude.exe（实际 25 个）；whoami 以 0xC0000142 退出；node.exe 的 ACL 里有 CodexSandboxUsers。原因没查。orchestrad 要跑在 Node 24 上，需要在正常令牌下单独确认一次进程可见性和写权限。
9. **另外两个根有活会话时的完整性。** 46470、52373 在整个 spike 期间都没有活会话。
10. **每个 spike 会话有没有往 `.claude.json` 写 cwd 或信任条目。** 不读这个文件就查不了。
11. **账号切换器布局。** `~/.rec/claude/accounts/*/config` 是本机账号切换器的布局，别的机器上未必有。

## 6. 对规格的影响

行号按 r4（`docs/specs/2026-10-27-dsh-orchestra-design-r4.md`，3918 行）。

**该改的句子：**

- **第 815 行**（§7.1 三家对照，「只读传输」，Claude 列）
  - 第一处原文：`<每个 CLAUDE_CONFIG_DIR>/sessions/<pid>.json`（busy / idle；只读这种文件名，同目录的 `.key` 不读）
  - 改成：`<每个 CLAUDE_CONFIG_DIR>/sessions/<pid>.json`（`status` = busy / idle / waiting；waiting 时带 `waitingFor`：permission prompt / input needed / dialog open / worker request / sandbox request / goal proposal；新会话注册后几秒内没有 `status` 键，属正常过渡；只读这种文件名，同目录的 `.key` 不读）[S5]
  - 第二处原文：`claude agents --json`（帮助文本确认包含交互式和后台会话，`--all` 额外包含已完成的后台会话 [核验]；是否暴露等待状态由 S5 验证）
  - 改成：从只读传输里删掉，换成一句说明：`claude agents --json` 能看到 `waitingFor`，但每次要 4–35 s，并且会写根目录（`.claude.json`、`daemon/pipe.key`，还会删过期注册表），Orchestra 不调用，只留给人工排障 [S5]
- **第 525 行**（架构图 sources/ 里 claude 那一格）：`` `agents --json`, opt-in hooks `` 改成 `registry waiting, opt-in hooks`（框宽不变）。
- **第 1734 行**（阈值表「"可能在等你"静默阈值」）
  - 原文：工具调用发出后 20 s（S5 无等待信号时）
  - 改成：只用于没有注册表等待信号的会话（`-p --permission-prompt-tool mcp__*`、注册表缺失、TUI 实测之前）：注册表 busy，transcript 最后一条是没配对的 `tool_use`，并且静默 20 s；低置信 [S5]
  - 说明：锚点改动是预防性的。S5 测到的 tool_use → 审批 8.8–28 s 受 spike 自身干扰，不作为依据，也不写进规格。
- **第 2353 行**（M0 交付物「Claude 源（多根目录）」）：后面补「根目录发现算法见 §7.1（S5）」。算法见本节末尾。
- **第 2365 行**（M0 验收「活跃会话在 ≤2 s（Claude、DSH）内出现」）：补一句「Claude 从注册表文件出现时算起，不从进程启动时算起」（S5：高负载下注册表在 spawn 后 28–46 s 才出现）。
- **第 2366 行**（M0 验收，Claude 的「需要输入」）
  - 原文：S5 找到等待信号时，不装 hooks ≤5 s、装了 hooks ≤2 s 内生成收件箱条目并提交通知；找不到时降级为 20 s 静默的低置信条目，以 hooks 方案为准。
  - 改成：注册表写出 `waiting`（以 `statusUpdatedAt` 为准）后 ≤2 s（1 s 轮询）生成收件箱条目并提交通知，不依赖 hooks。SDK 宿主路径已实测，Desktop 托管路径已观察到，TUI 路径在 M0 由用户在场实测一次。装了 hooks 的会话仍要求 ≤2 s（门槛保留，等轻量 hook 在无干扰条件下复测）。没有注册表信号的会话，降级为 20 s 静默的低置信条目。
- **第 2370 行**（零写入）：「`C:\Users\Calx\.rec\claude\accounts\53087\config`（以及找到的所有根目录）」改成逐个列出：`…/accounts/53087/config`、`…/accounts/46470/config`、`…/accounts/52373/config`、`~/.claude`，以及 Tuning 里手填的额外根。
- **第 2373 行**（Tuning 的版本漂移）：补一句「Claude 的版本按注册表里每个会话的 `version` 判断，不看 PATH：本机 Desktop 托管的会话跑自带的 2.1.308，PATH 上的 CLI 是 2.1.310，另有一个不在 PATH 上的 npm 全局安装 2.1.260」。
- **第 2734 行**（风险表）
  - 原文：非自有会话的盲区（Codex、DSH 的审批等待；Claude 无 hooks 时的等待）｜低置信启发式，并标出置信度；S5；自有驱动可以补上这块
  - 改成：非自有会话的盲区（Codex、DSH 的审批等待；Claude TUI 会话的等待（S5 未实测，信任对话框阶段可能不写注册表）；`-p --permission-prompt-tool mcp__*` 会话的等待）｜Claude 的 SDK / Desktop 会话用注册表 `waiting` 信号；其余用低置信启发式，并标出置信度；自有驱动可以补上这块
- **第 2887 行**（Q6）
  - 原文：这首先是可行性题：S5 若找不到等待信号，不装 hooks 时「需要输入」只能低置信地在 20 s 后推测，≤5 s 只能靠 hooks（且要先通过 fail-through 测试）。……
  - 改成：S5 已经找到等待信号（注册表 `waiting`）。对 SDK / Desktop 会话，这是偏好题；对终端 TUI 会话，M0 实测之前仍是可行性题。如果要粘贴片段，必须用 exec 形式（`command` + `args`），因为本机没有 Git Bash 时，shell 形式会经 PowerShell 执行并失败。优先用 `PermissionRequest`，不用 `Notification`（S5 里晚 10–11 s，原因未证实）。仍要先通过 fail-through 测试。其余部分（先零写入跑完 M0，看 blocked→noticed 的中位时间）不变。
- **第 3002 行**（附录路径表）
  - 原文：实际的 `CLAUDE_CONFIG_DIR`（`~/.claude` 里只有备份）[proto]
  - 改成：实际的 `CLAUDE_CONFIG_DIR`。`~/.claude` 有空的 `sessions/`、`backups/` 和 `settings.json`，没有 `projects/`；另有 `accounts/46470/config`（22 个项目目录）和 `accounts/52373/config`（6 个）两个根 [S5]
- **第 3138 行**（附录 C 变更记录）：原句是 r4 的历史记录，不改。在 r5 的变更记录里加一条：S5（2026-10-30）：Claude 的 SDK / Desktop 会话有注册表等待信号（`status=waiting` 加 `waitingFor`），「需要输入」不靠 hooks；TUI 待实测；`claude agents --json` 不再作为传输。
- **第 3168 行**（附录 C 事实修正）：「`claude agents --json` 已确认包含交互式会话」成立，后面补「（S5：它会写根目录，Orchestra 不调用）」。
- **第 3237 行**（C.5 仍然存在的不确定性）
  - 原文：**Claude 不装 hooks 时有没有等待信号**（S5）。
  - 改成：**Claude TUI 会话不装 hooks 时有没有等待信号**（S5 已回答 SDK / Desktop：有，注册表 `status=waiting`；TUI 待 M0 由用户在场实测）。
- **§7.1 补充事实**（建议写在第 815 行之后的说明里）：
  - 注册表要在 spawn 后几十秒才出现（高负载下 28–46 s），之后再过 3–11 s 才有 `status` 键。
  - `-p` 会话的 `kind` 也是 interactive，要用 `entrypoint` 区分 `sdk-cli` 和 `claude-desktop`。
  - taskkill /F 之后，注册表文件可能残留超过 15 s，判活要用 `pid` 加 `procStart`。
  - 正常退出时，注册表文件会自行删除。
- **调研笔记** `docs/research/cc-codex-protocols.md` 第 15 行：`status` (busy/idle) 改成 `status` (busy/idle/waiting)，加上 `waitingFor`；键名补 `nameSource`。

**[核验] 和其它事实：**

- 第 815 行「帮助文本确认包含交互式和后台会话，`--all` 额外包含已完成的后台会话」[核验]：成立；`-p` 会话的 kind 也是 interactive。
- 第 815 行「sessions/<pid>.json 的 status 只有 busy / idle」：不成立，还有 waiting。
- 第 815 行「`agents --json` 是否暴露等待状态由 S5 验证」：会暴露（`waitingFor`），但慢，而且会写根目录。
- 第 2346 / 2887 行「≤5 s 只能靠 hooks」：对 SDK / Desktop 不成立，对 TUI 未定。
- 第 3002 行「`~/.claude` 里只有备份」[proto]：不成立。
- 第 3168 行「`agents --json` 包含交互式会话」：成立。
- 第 352 行列出的 hook 事件里有 `PermissionRequest`：实跑中触发了，成立。
- 简报 §1 的注册表键名（18 个）和「见过的 status 只有 idle」：不完整，见上。
- 本机 CLI 是 2.1.310：成立；但 Desktop 会话跑的是 2.1.308，另外还有一个 2.1.260 的 npm 安装。

**根目录发现算法**（建议写进 §7.1 和第 2353 行的交付物）：

1. 候选来源：orchestrad 自己的 `CLAUDE_CONFIG_DIR`、`~/.claude`、`$XDG_CONFIG_HOME/claude` 或 `~/.config/claude`、已知的启动器布局（本机是 `~/.rec/claude/accounts/*/config`）、Tuning 里手填的额外根。
2. 目录里有 `sessions/` 或 `projects/` 才算根；按 realpath 不分大小写去重。
3. 每 60 s 做一次完整性检查：用 procguard 的 snapshot 列出 claude.exe，排除 exe 旁边有 `resources/app.asar` 的（Desktop 的 Electron 进程）；剩下的每个 pid 都应该在某个根里有 `sessions/<pid>.json`（看文件名就够，不用打开）。**进程起来不到 60 s 不算缺失。** 超过 60 s 还没有的，先标成「未注册（可能卡在信任对话框，也可能是未知根）」，请人看一眼，不要直接报「未知根目录」。
4. 可以按 exe 路径 `…/accounts/<id>/app/claude-code/…` 猜出候选根 `…/accounts/<id>/config`，人工确认后才加入。
5. 只打开 `sessions/<pid>.json` 和 `projects/**/*.jsonl`；永远不读 `.key`、`.claude.json`、`*credentials*`。
6. 已知限制：完整性的证据只覆盖一个有活会话的根，而且全是 Desktop 子进程。

## 7. 费用与副作用

**模型调用**：全部由第一任执行者在 2026-10-29 22:41–23:38 UTC 发起，之后各轮都是 0 次。

| 会话 | 模式 | API 请求 | token（输入 / 输出 / 缓存读 / 缓存写） | 费用 |
|---|---|---|---|---|
| A | mcp（旧版脚本） | 1 | 2 / 115 / 0 / 36778 | 估算约 $0.12 |
| B | none | 2 | 4 / 285 / 36937 / 7293 | 实际 $0.0357 |
| C | stdio | 1 | 2 / 90 / 16813 / 6261 | 估算约 $0.03 |
| A2 | mcp | 1 | 2 / 90 / 0 / 23060 | 估算约 $0.07 |

合计约 $0.25。按会话算是 4 次，在简报的上限 4 次以内；按 API 请求算是 5 次，超出 1 次（B 自动拒绝后，`--max-turns 3` 允许它再跑一轮）。另有 3 次没调模型的 claude 启动（hook-load-check、D、E）。以后做对照跑请用 `--max-turns 1`。

**进程**：全部已结束。只按 PID 用 `taskkill /F /T` 杀过进程，从没按映像名杀过。

- 第一任执行者：
  - claude 会话：A 60944、B 31256、C 30296、D 62520、E 56732、A2 41788。
  - MCP 服务器：49748（A）、60504（B）、5576（C）、58232（A2），随进程树退出，或在 stdin EOF 时退出。
  - 实验期间的 `claude agents --json` 共 17 次：A 53124、53464、46008、59904、23960、34624、31492；B 32484；C 57152、58096、17316、7516、55104；A2 64276、57848、10364、60144。
  - 没记 PID 的：`agents-probe` 5 次、清扫 1 次、`hook-load-check` 1 次 claude 启动。它们都是同步调用，已经自己退出；脚本已改成记 PID。
- 第二任执行者：只有短命的 node / powershell / grep / icacls / `claude --version`。
- 复核者：后台被动轮询的 node 36420（到点自己退出），以及 roots / summarize / spend 的 node 短进程。
- 本轮（修复者）：
  - 被动轮询 node 61804：第一版会打开所有根的注册表文件，跑了约 2 分钟后按 PID 杀掉。当时其它根没有注册表文件，实际没读到任何别的根的文件。
  - 重启后的被动轮询 node 28104：1500 s 到点自己退出。
  - `stale-sweep.mjs` 54800，以及它起的 PowerShell 47316、42384。
  - `roots.mjs` 一次（含一个 Get-CimInstance 的 PowerShell）。
  - `summarize.mjs`、`grep`、`tasklist`、`node --check` 等短进程。
  - 结束前按 PID 核对，以上进程都已不在。
- PID 复用：57848 现在是别人的 magpie-bun.exe（2026-10-30 00:51Z 创建），不是我们的，没碰。

**claude 自己写进 `%CLAUDE_CONFIG_DIR%` 的东西**：简报第 3、4 步要求起会话、跑 `agents --json`，这些写入来自 claude 本身，不来自 spike 代码。

- `projects/` 下有 5 个目录，名字以 `…-scratchpad-spikes-s5-claude-tmp-{hook-load,run-A,run-A2,run-B,run-C}-cwd` 结尾，各有 1 个 jsonl 和一个空的 `memory/`，共约 580 KB。**没有删**：删除也算修改这个目录，留给用户决定。另外 `spend.mjs` 复跑要用到它们。
- 这几次会话的注册表文件：都已经不在了。
- `agents --json`（共 23 次）：改过 `.claude.json`，新建了 `daemon/pipe.key`（16 B，只看过名字），删过过期的 `sessions/41788.json`。都没有恢复；`.claude.json` 从没读过内容。
- 查不了的：每个新会话可能也往 `.claude.json` 写了 cwd 或信任条目。

**读的范围**：2026-10-29 版的 `roots.mjs` 会打开所有候选根的 `sessions/*.json`，超出了简报的读白名单；但另外三个根始终没有注册表文件，实际一个也没读到。现在的 `roots.mjs` 和 `passive-poll.mjs` 只打开 `%CLAUDE_CONFIG_DIR%` 下的注册表文件。没有读过任何禁读文件（复核者核对过前任的转录）。

**临时文件**：`tmp/` 已删除（复核者删过一次，本轮没有再建）。`evidence/` 保留 16 个小 JSON。仓库 `spikes/s5-claude/` 下只有 11 个 .mjs 和本报告，没有 .jsonl / .zst。没有 `git add` / `git commit`。

## 附：复核意见的处理

| 编号 | 处理 |
|---|---|
| 01 REPORT.md 缺失、内容不自足 | 接受。本文自足：复跑命令、没验到的、规格影响、副作用全部写全，§3 改成三列表格 |
| 02 结论范围过宽 | 接受。结论改为 partial，按路径分开写。新增被动轮询，在 Desktop 会话上直接看到 `waiting`（`input needed`）以及回到 `busy`。规格改动限定在 SDK / Desktop；TUI 的 Q6 仍是可行性题，风险表保留 TUI 盲区 |
| 03 延迟数字受干扰 | 接受。量化了干扰：四段窗口里探针几乎全程在跑。相关数字都标上「高负载、有干扰」；第 2366 行保留「装了 hooks ≤2 s」；第 1734 行不写 8.8–28 s。`hang-run.mjs` 加了 `--agents-max 0`、`--hooks permission`、`--max-turns`，方便干净复测（需要 1 次模型调用，本轮不能跑） |
| 04 「注册表自行消失」的说法 | 接受。C 注明和探针重叠；「谁清理」改成推测，列入没验到的。新写 `stale-sweep.mjs`（带对照窗口），加进复跑命令；只读对照窗口跑了一次（20 s，没有过期文件）；完整模式会写根目录，没跑 |
| 05 完整性检查会误报 | 接受。算法第 3 步加 60 s 宽限期和「未注册」标签，`roots.mjs` 同步实现；写明证据只覆盖一个根 |
| 06 把推断写成了事实 | 接受。两处都改成「推测」 |
| 07 模型调用超出 1 次 | 接受，保留披露；加了 `--max-turns` 参数 |
| 08 有进程没记 PID | 接受。三个脚本都改成记 PID；`agents-probe` 去掉 `shell: true`；清扫改成脚本 |
| 09 复跑对不上 / 小 bug / 环境注入 | 接受。修了正则；每个脚本输出 `scriptSha256`；§4 披露注入的环境变量，并注明 A、B 来自旧版脚本。另外修了 `existedAtKill` 写死为 true 的问题 |
| 10 漏了 2.1.260 | 接受。已核实（package.json 的 version 是 2.1.260，PATH 上没有 shim），写进 §3 和第 2373 行 |

本轮自己发现并改正的数字：A2 原写「tools/call 之后 96 s」，应为 tool_use 后 96 s、tools/call 后 81 s；`"permission prompt"` 字面量是 4 处，不是 3 处；D、E 的「kill 后注册表消失」时间没有意义，因为它们从来没有过注册表文件。
