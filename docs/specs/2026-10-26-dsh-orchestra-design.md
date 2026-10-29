# DSH Orchestra 设计规划（草案 r2）

> **已被 r3 取代（2026-10-27）**：本文件是 2026-10-26 的草案 r2，保留供对照和 diff；当前版本见 [2026-10-27-dsh-orchestra-design-r4.md](2026-10-27-dsh-orchestra-design-r4.md)；r3 见 [2026-10-27-dsh-orchestra-design-r3.md](2026-10-27-dsh-orchestra-design-r3.md)，r3 相对 r2 的改动见其附录 D，r4 相对 r3 的改动见 r4 的附录 G。

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-26（r2：已吸收 4 个视角的评审，见附录 C） |
| 状态 | 草案 / 待决策（§17 有 14 个问题需要你拍板，其中 Q0、Q2、Q8、Q9 在 M0–M1 前就要定） |
| 维护者 | AdamPlatin123 |
| 范围 | 为 Codex、Claude Code、DeepSeek Harness（DSH）做一个本地的「超级 Orchestra 工作台」：跨项目注意力收件箱、跨 harness A2A、安全控制（限流 / 熔断 / 回收）、指挥家 Maestro 与 AutoRoute。单用户，Windows 11，仅 loopback。 |
| 不在范围 | 云端或多租户；v1 的无人值守自治；修改任何 harness 的内部实现（见 §3.2） |
| 依据 | `docs/research/` 下 7 份调研（标签见下表，链接见附录 A）；设计综合稿 v1 与 3 位评审的打分（方法见附录 B）；4 个视角的评审记录（附录 C） |
| 工期估算 | M0–M5 约 25 周（单人），每个里程碑都能单独使用 |

**阅读指引**：只有 5 分钟，读 §0。想知道"为什么这么做"，读 §2 和 §4。准备动手，读 §13 和 §17。

**证据标签**（全文统一使用）

| 标签 | 文件 | 主要内容 |
|---|---|---|
| [core] | [dsh-core.md](../research/dsh-core.md) | DSH 内核：launcher / profile、ACP / SDK / Web 接口、subagent、Agent Team、存储格式、发布节奏 |
| [tui] | [dsh-tui.md](../research/dsh-tui.md) | dsh-TUI：`AgentSession` / `AgentEvent`、Claude SDK 与 Codex app-server 后端、herdr、inject pipe |
| [bot] | [ds-bot.md](../research/ds-bot.md) | DS-Bot：身份与 parts、`message_bot` 语义、群聊路由、steward、记忆、`/api/bot` |
| [proto] | [cc-codex-protocols.md](../research/cc-codex-protocols.md) | Claude Code / Codex 的协议与磁盘格式、ACP、A2A 1.0 |
| [land] | [landscape.md](../research/landscape.md) | 社区与竞品：BSB、dsh-apollo、dsh-context、Conductor、herdr 等 |
| [own] | [own-blocks.md](../research/own-blocks.md) | 你自己的积木：adaptive-router、tonghuashun、hermes-agent、DSH-plugins 的踩坑记录 |
| [req] | [requirements.md](../research/requirements.md) | 画像、R01–R28、非目标、乐团隐喻映射、评估思路 |
| [核验] | — | 综合稿写完后，由编排器或评审在本机核验过的事实（2026-10-26），见 §5.3 和附录 C |

- **（假设）** 表示调研报告没有确证的内容。
- **（本文补充）** 表示综合稿里没有、本文为了完整性加上的内容，同样需要你确认。
- "impl N" 指对应报告 "Implications for Orchestra" 一节的第 N 条。
- 引用本机安装的 DSH 包时，路径相对于 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（版本 0.2.1-rc.2）。

---

## 0. 一页纸摘要

### 0.1 Orchestra 是什么

1. **一个本机常驻的守护进程 `orchestrad`，加一个浏览器界面。** 它把你同时开着的 Claude Code、Codex、DSH 会话（连同它们派出的子代理）汇总成一个跨项目的「需要你」收件箱和一张乐团舞台图。
2. **在 Orchestra 里新建的会话是有固定名字的「乐手」。** 乐手之间通过 Orchestra 的「邮局」互发消息、自动回信，你不用再在它们之间传话。每个乐手有自己的对话页，你可以像在原生 CLI 里一样和它持续对话。
   - **注意**：你现在在终端、Codex Desktop、DSH Web、dsh-TUI 里开着的会话只能被看见，**不能**收发 A2A 消息。想让两个会话互相对话，要在 Orchestra 里新建乐手。M1 只有 Claude 和 DSH 乐手；Codex 乐手最早在 M4，还取决于 Q1。
3. **审批、拍板、杀进程永远只由你来做。** 守护进程负责排队限流、死循环熔断和孤儿进程回收；指挥家 Maestro 先按规则分派，规则判断不了才动用 LLM，并且先在「影子模式」下只建议、不执行。

### 0.2 术语速查与示例角色

| 术语 | 含义 |
|---|---|
| 乐手 Musician | 有固定名字的 agent，换了多少次会话都还是它 |
| 乐章 Part | 乐手的一次会话；上下文满了就换下一个乐章 |
| 分身 Clone | 原生 subagent / teammate，画在乐手身后，不能直接收 A2A 消息 |
| 声部 Section | 一组乐手：同一个 harness、同一个群聊房间，或一个 DS-Bot 团队 |
| 邮局 Post Office | Orchestra 的 A2A 投递，带回执、去重、上限 |
| 延长记号 Fermata | 需要你拍板的事：审批、提问、决策 |
| 错音 Wrong note | 出错告警：死循环、孤儿、越权等 |
| 指挥家 Maestro | 负责分派、不写代码的乐手（M4） |
| 场务 Stagehand | kill-tree 刹车与回收器 |
| 影子模式 shadow | 只建议"会派给谁"，执行的仍是你的选择 |
| observed / owned / foreign-held | 只读观察 / Orchestra 自有 / 被别的程序持有 |

全文示例统一使用这几位：

| 角色 | harness | 项目 | 所有权 | 能否收发 A2A |
|---|---|---|---|---|
| Aiko | Claude | shop-web 前端 | 自有 | 可以（M1） |
| Ren | DSH | api-core 后端 | 自有 | 可以（M1，取决于 S2） |
| Mio | Claude | shop-web QA | 自有（QA 模板，只读 + 测试命令白名单） | 可以（M1） |
| Kaito | Codex | api-core | 只读观察（你在 Codex CLI 里开的） | M4 前不能 |

### 0.3 你在什么时候得到什么

| 周 | 里程碑 | 你得到什么 |
|---|---|---|
| 第 4 周 | M0 | 现有会话的跨项目收件箱、一次性提醒、死循环告警（Claude、DSH）和手动刹车；Codex 先只显示在不在、忙不忙 |
| 第 8 周 | M1 | 在 Orchestra 里新建 Claude / DSH 乐手，有对话页；乐手互发消息、自动回信；审批集中处理；决策板 + ADR 导出，已定决策自动带进新乐章；QA 乐手模板（反复跑 flaky 测试并回报失败率） |
| 第 12 周 | M2 | 乐团舞台图、账本、自动限流与回收；Codex 实时跟踪；专注模式、30 分钟摘要、周期提醒 |
| 第 16 周 | M3 | 委托树、群聊房间、任务板、时间线回放、worktree；私有 DSH 里的 `wait_subagent` 与孙代理回收 |
| 第 20 周 | M4 | 指挥家 Maestro（先影子模式）、Codex 乐手（取决于 Q1）、DS-Bot 声部。派活标签从 M1 开始积累，所以影子模式一开就有数据；真正自动派活要等一致率过门槛（Q11） |
| 第 25 周 | M5 | 决策溯源探针、记忆范围、UI 测试复现包、导出、成本报价 |

M3 和 M5 的范围可以顺延，不会卡住 A2A。

### 0.4 你的一天（M1 之后）

- 早上打开 Program，看到 3 个 fermata。按 `a` 批准 Aiko 跑 `pnpm test:e2e`；卡片上写着这次调用是被谁的消息触发的。
- Ren 问「分页用 cursor 还是 offset」。按 `d` 把它转成 Decision，你选 cursor；之后 Aiko 和 Ren 新开的乐章都会带上这条决定，Ren 收到通知后回信「已更新」。
- 下午 api-core 里 Kaito（Codex，只读观察）的 grep 子代理把内存涨到 3 GB：弹出 P0 toast，按 `K`，弹窗默认只勾 RSS 最大的那棵 `rg.exe` 子树，Kaito 的会话本身保留。
- 傍晚 QA 乐手 Mio 回报：e2e 跑 20 遍挂 3 遍，附上每次失败的日志路径。

### 0.5 最重要的 6 个决策

| # | 决策 | 为什么 |
|---|---|---|
| 1 | **先看见，再对话。** 前 4 周只读，先帮你管住已经开着的会话；第 5–8 周就让新建的乐手互发消息。（D1） | 过载来自已经开着的会话；A2A 是你的首要诉求，不排在"先用两周再说"之后 |
| 2 | **乐手是固定名字，会话只是它的一个乐章。** 子代理画成分身，不能直接收消息。（D2） | 名字要扛得过上下文换新和守护进程重启；原生的子代理消息只能在父子之间传 |
| 3 | **三类所有权：只读观察、自有、别人持有。** Orchestra 只驱动自己启动的会话；自有进程装进能整体回收的 Job Object。（D4） | 不和 DSH Web、dsh-TUI、DS-Bot 抢同一个会话；守护进程崩了也不留孤儿 |
| 4 | **A2A 走 Orchestra 自己的邮局。** 自动回信、去重，外加跳数、转发次数、截止时间三道上限。（D7） | 原生通道没有一条能同时跨 harness、跨进程、跨重启；DS-Bot 的语义好用，但没有上限和看门狗 |
| 5 | **审批、拍板、刹车只有你能做。** 一个审批队列，超时即拒；只有配对过的浏览器能点这些按钮。（D8） | Claude 的权限提示永不超时；本机任何同用户进程都能调本地接口，所以要配对 |
| 6 | **自动分派先走规则，拿不准就问你；先影子，后执行。**（D9） | 冷启动时没有证据；规则可审计，LLM 只在规则判断不了时用 |

其余决策见 §4：守护进程的运行时与存储（D3）、自有驱动的选型（D5）、对抗版本漂移（D12）等。

### 0.6 M0 在约 3.5 周内交付什么

- **前 3 天只做与 M0 有关的 3 个技术验证**：实时读日志（S1）、进程回收 helper（S4）、Claude 的"等待输入"信号（S5）。私有 DSH（S2）和 Claude 后端（S3）移到 M1 第 1 周，DS-Bot 字段（S6）移到 M2。每个验证都有后备方案。
- **一个只读守护进程。** 读取 Claude（所有配置根目录）、DSH（v4 日志）和 Codex（线程数据库的快照）。所有写入只经过一个"写围栏"模块，用一次 Procmon 实跑证明对任何 harness 零写入；凭据文件一律不读。
- **首页 Program。** 跨项目收件箱（审批、提问、失败、死循环、待审、提醒）、一次性提醒、浏览器通知。
- **刹车。** 死循环告警 v0（Claude、DSH）、RSS 采样，以及人工点击的 kill-tree（默认只杀子树，受保护的宿主要键入确认）。
- **本机 UI 安全。** 一次性配对码、CSRF、内容安全策略：agent 无法冒充你点"批准"或"刹车"。
- **Tuning 面板。** 第一天就能看到 `codex 0.139 < 0.144 → harness-unsupported` 和 Claude CLI 的版本漂移。

### 0.7 需要你拍板的问题（详见 §17）

M1 之前要定的：
- **Q0** 哪些工作搬进 Orchestra 乐手？（建议先搬后台型工作，前台主力会话留在原生 CLI）
- **Q2** 私有 DSH 的模型凭据：建议给 Orchestra 单独一把可吊销的 API key。
- **Q8** 自有 Claude 乐手沿用你的 `CLAUDE_CONFIG_DIR`（复用登录，可 `--resume`），还是独立根目录？
- **Q9** Orchestra 是自用还是发布给 DSH 社区？许可证用 MIT 吗？

之后再定的：Q1 Codex 怎么接入（M4 前）、Q3 Maestro 的模型与每日 CNY 上限（M2 前）、Q4 审批超时、Q5a/Q5b live web profile 与 DS-Bot 升级、Q6 Claude hooks、Q7 worktree、Q10 通知分级、Q11 影子→执行的门槛、Q12 你最看重 Ultracode 的哪一点。

---

## 1. 背景与要解决的问题

### 1.1 你的处境

你同时推进 2 个以上的大型应用，手里同时开着 Claude Code、Codex（CLI 和 Desktop）、DSH Web 与 dsh-TUI 的多个会话。真正消耗你的不是写代码，而是在下面这些事之间反复切换注意力：

| 你遇到的事 | 现在怎么处理 | 根因 | Orchestra 里谁接手 |
|---|---|---|---|
| 前端会话要等后端定下"分页怎么做" | 你在两个窗口之间转述 | 会话之间没有可寻址、能回信的通道 | 给后端乐手发 A2A 请求，或升级为 Decision（§8，M1） |
| 前端框架选哪个、后端架构怎么定 | 在对话里聊着就定了，过两天又被早期注释带偏 | 品味类决策没有持久、可追溯的载体（R12） | Decision board + ADR 导出 + 注入新乐章，都在 M1；陈旧注释探针在 M5（§11.6） |
| 一个 grep 子代理死循环，把内存吃光 | 发现时机器已经卡住 | 没有看门狗；DSH 不回收子代理 | 死循环检测 + 刹车 + 回收器（§10，场景走查见 §10.3） |
| UI 测试偶发失败，复现不了 | 手动反复跑 | 缺少环境、种子、录屏的打包 | M1 起用 QA 乐手模板反复跑并回报失败率；完整的 repro bundle 有意放在 M5（R19），因为它依赖 worktree 和导出 |
| 各种"过会儿记得看一眼" | 靠脑子记 | 没有面向人的提醒 | Orchestra 自己的调度器（§11.2） |
| "现在哪个项目需要我？" | 挨个窗口轮询 | 状态散落在三家 harness 的 UI 里 | 首页的注意力收件箱（§11.2） |

你明确说过三件事：比起 bot 框架，你更看重 **A2A**，并认为它是多任务的前提；你喜欢 Claude "Ultracode" 那种持续交互加自动分派的体验；你也想要 **Tokenmaxxing**，即只和主代理或群聊说话，让它关注整个代码库。§2 专门回答这三点。

### 1.2 社区 agent-team 的共性痛点

下表是 DSH 社区（dsh-context、BSB、dsh-TUI 的贡献者等）的反馈 [req]，以及调研中与之对应的事实：

| 痛点（转述） | 事实依据 |
|---|---|
| "`list_agents` 经常返回 0，看不到我派出去的子代理" | 团队模式下 `list_agents` 只列出 Lead 和持久 teammate [req]（注：0.2.1-rc.2 的 dsh-base 确实挂载了 `list-agents`，`dsh-base/cordis.patch.yml:377` [核验]） |
| "DSH 不释放 subagent，后端崩了"；中断父代理后孙代理还在跑 | 旧版 interrupt 的说明原文是 "Subagents it started will keep running" [req]；ACP 的 `session/cancel` 只停根活动，之后子代理消息还可能启动新的自主工作，只有 `session/close` 会回收后代（`dsh-acp/README.md` [核验]） |
| "MiniMax 便宜，但一并发就炸" | 达到 `maxActiveSubagents`（默认每个激活树 8 个）时直接报 `ACTIVATION_LIMIT_REACHED`，不排队；`maxDepth` 默认 1 [core][req] |
| "工作流要么第 1 轮就结束，要么无限循环"；"reviewer 永远打回" | goal round driver 上限 256 轮，Ralph 的 `maxRounds` 也是 256 [core][req] |
| "Lead 不派活，或者派错人" | 任务 owner 永远不会自动释放 [req] |
| "agent 被复用了，但我们从没看到它们直接对话" | dsh-context 作者主张观测先于控制 [req]；`/export` 不包含团队消息 [req] |
| "没有 `wait_subagent` 时，agent 要么不管子代理，要么疯狂轮询" | dsh-apollo 加了 `wait_subagent` 之后问题消失 [req][land]；`wait_agent` 在没有活跃 peer 时返回 `noProgress` [core] |
| "逃出 harness 像呼吸一样容易" | bypass 模式会扩散到所有 teammate [land]；dsh-TUI 的 Claude 后端始终传 `allowDangerouslySkipPermissions: true`，因此运行时随时可以切到 bypass（并非默认处于 bypass）[tui][核验]；DSH 内置的 Full access 预设是 `approval: never`，即根本不发审批请求（`dsh-base/cordis.patch.yml:274-276` [核验]） |
| teammates 共享一个 cwd、一个进程；团队开关只能按 profile 切换 | [core][req] |
| 早期代码注释污染上下文；早期 transcript 被无权限读取；从 Pi 迁到原生 DSH 后记忆混乱 | R12–R14 [req] |

### 1.3 画像

| 画像 | 要完成的事（jobs-to-be-done） |
|---|---|
| **P1 多项目指挥**（就是你） | "我同时跑 2 个以上的大应用。告诉我现在哪个项目需要我、哪个决定在等我，其余的事在不需要我记住上下文的情况下继续推进。" |
| **P2 团队机制折腾者**（dsh-context、BSB、TUI 贡献者） | "让我看到 agent 之间到底怎么交流（私信、回报、派活），好查出 Lead 为什么不派活、派错人，或者 reviewer 为什么无限打回。" |
| **P3 领域 agent 搭建者**（从 Pi 加自制前端迁到原生 DSH） | "在不同前端之间迁移 agent，而记忆不被打乱。" |
| **P4 成本敏感的评估者** | "以每个任务约 1 CNY 的成本衡量某种团队机制是否更好，并选出一个在并发下不会崩的模型组合（DeepSeek 或 MiniMax）。" |
| **P5 Vibe 指挥（Tokenmaxxing）** | "我只想和主代理或群聊说话，由它分派给合适的 agent 并持续推进（常驻 bot、AutoRoute，像 Ultracode 那样）。" |

P2–P4 是社区画像。Orchestra 先按 P1（你）自用来设计；是否面向社区发布由 Q9 决定，它影响 BSB tab、许可证以及 P2–P4 需求的优先级。

### 1.4 一句话定义问题

> 多个大应用并行时，你是唯一知道"谁在等谁"的人（注意力），是唯一的传话筒（A2A），也是唯一的保险丝（安全）。Orchestra 要把这三件事从你脑子里搬出来，并按风险从低到高依次交付：**先看见（M0），再对话（M1），再管住（M2）**。

---

## 2. 先回答三个问题

### 2.1 Bot 框架到底好在哪

**一句话：bot 框架就是给会话一个不会消失的名字和一个收件箱。** 对你来说，下表第 1、2 条就是 A2A 本身；第 3–6 条是让 A2A 在换上下文、重启时不掉链子。

**你其实已经在用。** 你的 live web profile 里装着 DS-Bot 0.1.7 fork，`~/.dsh/bot/state.json` 里有 9 个 bot、2 个房间 [bot]。在 DSH Web 里 @某个 bot、等它自动回信，这就是第 1、2 条。你感觉不到它的好处，是因为它只活在 DSH Web 里，够不着 Claude 和 Codex，也没有限流和看门狗；Orchestra 补的正是这两块。

| 能力 | 普通会话 | Bot / Orchestra 乐手 | 例子 |
|---|---|---|---|
| 1. 跨轮换的地址 | 只有人能找到它；上下文满了换新会话，"它"就没了 | 稳定的 id，换了几个乐章都能寻址 | 「@Ren，API 需要分页吗？」在 Ren 的上下文轮换两次、守护进程重启之后照样送达 |
| 2. 异步收件箱 | 只能你手动粘贴 | 可以 steer（插进正在跑的回合）或 queue（排到下一回合）；回复自动送回；同一发送者的未读消息合并；重试不会让一件活被做两遍 | Aiko 发完问题就结束回合；Ren 回信时 Aiko 被自动唤醒，接着写分页 UI |
| 3. 委托树 | 无 | 结果沿委托链回到发起者；B 把活转包后，B 给 A 的回复要等 B 的子任务都结束；给正在等同一份活的上游发消息会被拒绝 | 避免 A 和 B 互相等死 |
| 4. 重启存活 | 进程一死就断 | 在途回合恢复一次、按会话日志结算、结果不明的绝不重发（§8.3） | 守护进程崩溃后不会把同一个请求重复执行 |
| 5. 按身份配置 | 跟着 harness 的默认值走 | 模型、权限预设、工作目录、人设、记忆、定时提醒都挂在身份上 | 你在 DS-Bot 里遇到的权限竞态 bug，就是这种挂在身份上的设置和实际运行的值对不上；所以 Orchestra 每次修改后都回读一次（§10.10） |
| 6. 无限对话长度 | 上下文满了只能重开 | 乐章 + 交接笔记（handoff note）+ 对旧乐章的全文检索 | steward 在上下文压力达到 0.8 时决定是压缩还是换乐章 |

DS-Bot 还提供分范围的记忆与自动复审、带成本控制的群聊路由、每个 bot 的状态与用量 [bot]。Orchestra 分别在 M5（记忆范围）、M3（Rooms）、M0 / M2（状态、Ledger）里提供对应能力。

**它买不到的是安全。** 死循环、内存爆炸、孤儿进程要靠 governor、检测器和回收器来管；DS-Bot 自己"没有看门狗，等待没有超时" [bot]。所以 Orchestra 把这些放在 bot **旁边**，而不是指望 bot 自觉守规矩。

**对照你的 5 个痛点**

| 痛点 | 是 bot 能力吗 | Orchestra 用什么解决 |
|---|---|---|
| 前后端互相等 | 是（A2A） | 邮局，M1 |
| 框架、架构选型被带偏 | 不是 | Decision + ADR + 注入新乐章，M1 |
| grep 子代理爆内存 | 不是 | 看门狗、刹车、回收器，M0 / M2 |
| UI 测试偶发失败 | 部分是（常驻 QA 身份） | QA 乐手模板 M1；复现包 M5 |
| 各种提醒 | 不是 | Orchestra 调度器，M0 |

### 2.2 为什么 A2A 是多任务的前提

1. **瓶颈不在开会话，而在会话之间的依赖。** 多开一个会话几乎没有成本；但每多一个并行任务，就多出几条"它需要别人的结论"的依赖线。没有 A2A，这些线都要经过你：读 A 的问题，切到 B，转述，等 B 回答，再切回 A。依赖线的数量比会话数增长得更快（推论），这就是"切到 ADHD"的机制。
2. **原生通道补不上这个缺口。**

   | 原生通道 | 局限 |
   |---|---|
   | DSH subagent 的 `sendMessage` | 只在直接父子之间、同一进程内 [core] |
   | DSH Agent Team | 单进程、共享 cwd、按 profile 开关 [core] |
   | Claude `SendMessage` / Codex `send_input` | 都经父代理中转；回执不代表已读 [tui] |
   | Claude 跨会话 pipe | 只能传纯文本，没有回执；消息 token（`peerToken`）写在磁盘的 `sessions/<pid>.<hash>.key` 里，同用户进程可能读到 [核验：仅文件名与键名]。Orchestra **主动不用**这条通道：那等于在你不知情时往你的会话里注入输入 |

   没有一条能同时**跨 harness、跨进程、跨重启**。
3. **所以 A2A 必须由 Orchestra 自己做。** 在会话层投递：Claude 用 `streamInput`，Codex 用 `turn/steer`，DSH 用 `session/prompt` [proto impl 3][tui impl 4]。投递带回执、自动回信、幂等和上限（§8）。
4. **"前提"不等于"最先交付"，也不等于"所有会话都能用"。** A2A 只对 Orchestra 自有的会话起作用：你现在在终端、Codex Desktop、DSH Web 里开着的会话不能收发 A2A 消息，想让它们对话，要把这部分工作搬进 Orchestra 乐手（Q0）。你**现有**会话带来的过载先靠只读注意力层缓解。所以顺序是：M0 看得见 → M1 能对话（第 5–8 周，不设"先用两周"的门槛）→ M2 管得住。
5. **A2A 自己也会带来新风险**：循环、扇出、提示注入。所以邮局在 DS-Bot 语义之上加了跳数上限、转发上限、截止时间、来源追踪和信任标签（§8.5）。

```
没有 A2A                                          有 A2A（两边都是 Orchestra 乐手）
 前端会话 --问--> 你 --转述--> 后端会话             Aiko --orchestra_send--> Ren
 前端会话 <--转述-- 你 <--回答-- 后端会话           Aiko <-----自动回信------ Ren
 (每条依赖都要占用你一次上下文切换)                  只有收件箱里的事才找你：
                                                    fermata（审批、提问、拍板）和 wrong note（死循环等告警）
```

### 2.3 Tokenmaxxing："和主代理沟通好就行"在哪里成立

**成立的前提**：主代理手里有通讯录（`orchestra_list_musicians`）、异步收件箱、能读到的已定决策（`orchestra_get_decisions`），而且有上限防止它无限扇出。满足这些条件时，你只和一个对话说话，就能推动多个项目。**M1–M3 由你指定的一个自有乐手当主代理；M4 起可以换成 Maestro。**

**一个场景**：你只对主代理说「shop-web 前端框架定 Vite SPA；api-core 分页用 cursor，通知相关的人。」→ 主代理用 `orchestra_request_decision` 生成 2 个 Decision → 你在收件箱确认 → 主代理用 `orchestra_send` 通知 Aiko 和 Ren → 两人各自回信「已更新」，你在主代理的对话页里看到回执。

**失效的地方，以及 Orchestra 怎么补：**

| 失效点 | 原因 | Orchestra 的做法 |
|---|---|---|
| 审批 | 按设计就不能委托 | 进收件箱，只能你点 |
| 品味类决策（框架、架构） | 让 agent 在对话里"顺手定了"，早期笔记会污染后续上下文（R12） | 必须是人拍板的 Decision，可导出为 ADR 并注入新乐章（M1） |
| 上下文有限 | "关注整个代码库"的 token 成本按 agent 数和群聊发言人数线性增长；群聊里每个发言者都要重读自己的上下文 [bot][land]；DeepSeek 高峰时段价格是 2 倍 [land] | steward 在上下文压力 0.8 时轮换乐章；派活前的成本报价在 M5（R27） |
| 审查是瓶颈 | 二手数据：Faros 报告称 PR 审查时间上升约 91% [land] | 待审上限：某项目待审超过 N 条时，Maestro 的新派活排队（§10.2，M4） |
| 冷启动路由 | 还没有证据 | 先用确定性规则，拿不准就问你（一键选择的 "Route to?"）；你的每次手动派活从 M1 起都记成标签 |

**结论：不建议让每个乐手读整个代码库。** 推荐每个乐手只读自己负责的目录和已定 Decision，需要跨模块的信息时用 A2A 问负责的乐手。你坚持要全库上下文时，M5 的报价会先给出 token / CNY 估算。"整库上下文模式"本身不做（R27 只做报价）。

### 2.4 AutoRoute 与 Claude "Ultracode" 式编排的关系

调研没有覆盖 Ultracode 的实现。下面对它的描述来自你的说法（假设），§17 Q12 会问你最看重它的哪一点：一个主会话持续交互，由同一个模型凭判断把工作自动分给 subagent 或 workflow。

| 维度 | Ultracode 式（假设） | Orchestra AutoRoute |
|---|---|---|
| 作用范围 | 单个 harness、单个主会话之内 | 跨 3 个 harness、跨项目、跨重启 |
| 分派对象 | 临时 subagent | 持久乐手（有身份、权限、记忆、预算）；原生 subagent 仍以分身形式存在 |
| 怎么决定 | LLM 判断 | 第 1–4 步确定性规则 → 第 5–8 步硬过滤加证据门 → 第 9 步才用便宜的 LLM 分类器 |
| 可审计性 | 主要靠对话记录 | 每次路由写一条 RouteDecision：sha256 `decisionId`、各候选及其拒绝码、理由 chip |
| 冷启动 | 不涉及 | 标签从 M1 起积累；shadow 模式只显示"会路由到 X"，你的每次改派都变成标注 |
| 成本与并发 | 依赖 harness 自身 | governor 排队、每日 CNY 上限、待审上限 |
| 什么时候有 | 现在就有 | 你指定的主代理乐手在 M1；Maestro 影子模式在 M4；自动派活要等一致率过门槛（Q11） |
| 二者关系 | — | **互补**：乐手内部照样可以用原生 subagent / workflow（即 Ultracode 式）；Orchestra 管的是乐手之间、项目之间 |

---

## 3. 设计原则与非目标

### 3.1 原则

1. **先看见，再控制。** 某项控制上线前，它直接依赖的事件类型在黄金回放里的覆盖率达到 100%（M1：A2A exchange 与审批；M2：spawn / settle、分身树、runaway 事件）；全部边类型 100% 在 M3 达成（R02）。
2. **人是唯一的权威。** 审批、拍板、杀进程只能由人在配对过的浏览器里点击；消息永远不携带权限。
3. **身份高于会话。** 地址、配置、记忆挂在乐手身上，会话可以随时轮换。
4. **排队，不失败。** 超出上限的工作排队等待，而不是报错（对照 DSH 的 `ACTIVATION_LIMIT_REACHED`）。
5. **确定性优先，LLM 兜底。**
6. **只对接，不魔改。** 只依赖 harness 的公开行为，不写别人的锁和状态文件；可以加 shim（只在 Orchestra 私有的 DSH home 里），不打内部补丁；需要改上游的，先提上游。
7. **钉死版本；解析失败时降级为 `unknown`，绝不降级为错误的状态。**
8. **单写者、可重放；结果不明就不重发。** 存储用 SQLite 加 journal；哈希链只覆盖摘要，片段和正文放在可清除的表里（§6.1）。
9. **本地、只走 loopback、Windows 优先。**
10. **每个里程碑都能单独使用。** 后面的范围可以延期，但不能卡住 A2A。
11. **如实标注置信度。** 状态带 `stateConfidence`；界面上明示哪些结论来自低置信的启发式。

### 3.2 非目标

来自 [req]：
- **不分叉 harness 的内部实现。** 只适配公开行为，和 dsh-TUI 的规则 "consume upstream public behavior only" 一致。允许 wait 层、回收层这类 shim（只在私有 DSH home 里加载），不允许给 TeamService 打补丁。
- **不做新的 agent loop 或模型路由器。** 复用 `dsh-adaptive-router` 和各 harness 自己的 loop。
- **不做 Dify 式的无代码平台。** 图用来观察和约束 agent 的流程，不是给终端用户的产品搭建器。
- **v1 不做无人值守的自治模式**，在 R05、R06、R07、R21 到位之前都不做。
- **不做云端或多租户服务。** 本地、单用户、Windows 优先。
- **不跑完整 benchmark**（整个 DeepSWE），只跑子集。
- **不替换各 harness 的记忆存储。** Orchestra 只做中介和分层（R14），不拥有记忆。
- **不在 Orchestra 内部修上游 DSH 的 bug。** 检测器触发时，用零 token 彩排生成最小复现，记进 Tuning 的「上游台账」（`docs/upstream/NNNN-*.md`），由你决定是否提交到上游（§12.3）。

来自综合稿：
- 不做终端网格，也不嵌入 TUI pane；不抓取屏幕内容。
- 不用 Electron 或 BSB 当外壳。
- 不把 A2A 1.0 当内部协议。
- 不使用 CLIProxyAPI。
- 不写 DS-Bot 的 `state.json`；不调用 DS-Bot 的 `approval-answer`。
- 默认不往 live `web` profile 安装任何东西。
- 不自动批准任何审批。

---

## 4. 关键架构决策（D1–D12）

| ID | 决策 | 否决的方案 | 理由与证据 |
|---|---|---|---|
| D1 | **工作顺序**：M0 只读注意力层 → M1 自有的 Claude 与 DSH 会话互发消息 → M2 安全强制 → M3 声部（sections）→ M4 Maestro / AutoRoute。每张表在首次用到它的里程碑里通过迁移创建；M0 观察到的边先作为 Event 存，形状与 A2A 信封一致。 | ① bot-a2a 提案的"M0 只做自有会话"：只对新会话有用，而且把未经验证的 ACP 启动叠在本机从没跑过的 Claude 后端上 [proto][tui]。② observe-first 提案把 A2A 放在约第 11 周，还要先过 2 周的使用门槛。③ 在 M0 一次建好全部 13 张表（评审：拖慢 M0）。 | 过载来自已经存在的会话，两层观察是"减少切换最便宜的方式" [proto impl 5]。A2A 是你的首要诉求，不该排在使用门槛之后。 |
| D2 | **Musician** = 持久身份；**Part（乐章）** = 一次 harness 会话；原生 subagent / teammate 是画在主奏下面的 **Clone（分身）**，永远不作为 A2A 地址。 | 把每个会话当成一个 agent；直接给原生 subagent 寻址。 | bot 框架真正增加的是一个比会话活得久的身份 [bot]。原生消息只走父子之间，回执也不代表已读 [core][tui]。 |
| D3 | **一个守护进程 `orchestrad`**：TypeScript，跑在磁盘上已有的便携 Node 24（v24.22.0）；单写者心跳锁；`node:sqlite`（WAL）加 journal（哈希链只覆盖摘要）；本地 Web UI 走 SSE，只在 `http://orchestra.localhost:<port>` 提供，一次性配对码换 HttpOnly cookie，CSRF 头加严格 Origin 校验（§10.11）。 | Node 22.14；Electron；BSB 外壳；寄宿在 `dsh web` 里；better-sqlite3（需要原生编译）；只靠 launch token + Origin 的 loopback 守卫。 | 系统 Node 22.14.0 缺 `module.registerHooks` [own]，也缺 `zlib.createZstdDecompress`；便携 Node 24.22.0 两者都有，并能无告警加载 `node:sqlite`（SQLite 3.53.4）[核验]。DSH 日志和 Codex rollouts 都是 zstd 格式 [core][proto]。改 profile 曾让宿主卡住 87 s，HMR 也不会重载代码 [own]；BSB 的 fs 路由没有目录围栏 [land]。tonghuashun 的 `http.js` 在请求不带 Origin 时跳过校验，curl 可以直接通过 [核验]，所以不能只复用它。锁和原子写复用 DS-Bot `home-lock.js` 与 tonghuashun `acquireLock` / `writeAtomic` 的设计。 |
| D4 | **三类所有权**：observed、owned、foreign-held。Orchestra 只驱动自己创建的会话。每个自有的子进程宿主（Claude CLI、DSH host、codex app-server）各自一个嵌套的 kill-on-close Job Object，都挂在 orchestrad 的总 Job 下；由 procguard helper 以"挂起创建 → 分配 Job → 恢复"的顺序拉起（S4）。每个进程记录 pid 加创建时间。 | 附着到任意会话；用 `taskkill /T` 当回收器；所有子进程放进同一个 Job（无法单独回收一棵树）。 | DSH 对第二个写者返回 `session/writer-held` [core]；其他写者登记在 `session-mounts.json` 和 DS-Bot 的 `state.lock` 里 [tui][bot]。守护进程崩溃时，ACP host 会因 stdio 断开而自行收尾（`dsh-acp/README.md` 的 teardown 一节 [核验]），Node 也会结束直接子进程；但它们派生的 shell、grep、stdio MCP 进程（孙进程）以及卡住的收尾都没有保证（libuv 的全局 Job 允许孙进程脱离，调研之外，S4 验证），所以仍用 Job Object 兜底。`taskkill /T` 找不到父进程已退出的孙进程（评审意见）。 |
| D5 | **自有驱动**：Claude 用 vendored 的 dsh-TUI SDK 后端，强制关闭 bypass，`settingSources: []` 加 `strictMcpConfig`（不继承你的设置、hooks 和 `.mcp.json`，§7.4）。DSH 的驱动在 S2 之后决定：候选 A 是新写的 ACP 客户端连接私有钉死安装的 `dsh --profile acp`（默认）；候选 B 是在私有 `DSH_HOME` 下拉起 `dsh web`（或 profile-boot 的 `runProfile()` 引擎）加一个 ≤300 行的私有 bundle。无论哪个，**每个（项目，权限预设）一个 host，每个 host 独占一个私有 `DSH_HOME`**。Codex 用 vendored 的 app-server hub，前提是一个**私有**的 codex ≥0.144（独立 `CODEX_HOME`）先通过一次受控实跑。 | Claude、Codex 走 ACP 适配器（保真度有损失 [proto]）；`exec --json`（没有审批和 steer [tui]）；DSH SDK profile（没有 cancel / close [core]）；每个乐手一个 DSH 进程（太吃内存）；多个 host 共用一个 `DSH_HOME`（同一存储的并发访问需要不存在的跨进程租约协议，`dsh-subagent/README.md` [核验]）。 | 两个功能最丰富的 harness 用原生驱动 [proto impl 2]；ACP 一条连接上能跑多个会话 [core]；ACP 的独特优势是 `session/new` 按会话注入 `mcpServers`，候选 B 的优势是 steer、非 user 来源投递、单个分身中断和 job kill [core]，所以由 S2 的同一张清单打分决定。本机 codex 0.139 低于 `MIN_CODEX_VERSION` 0.144.0 [tui][核验]。 |
| D6 | **自有 DSH 会话的分身可见性**来自 tail 该会话自己的 v4 日志，复用观察器的同一个解析器。之后再加一个 Orchestra bundle 来增强（`subagent/start\|end`、以非 user 来源投递、`wait_subagent`、后代回收），它**只**在 Orchestra 私有的 `DSH_HOME` 里通过 `$DSH_HOME/cordis.patch.yml` 加载（DSH 启动器的层叠机制 [core]）。 | 依赖 ACP 获取 subagent 信息；bot-a2a 提案里 bridge 钩子能"够到" `--profile acp` 乐手（这是一个内部矛盾）。 | ACP 的 `session/update` 只携带消息、思考、工具生命周期和上下文用量；DSH subagent 在 ACP 上的可见性是 "Unknown" [core][proto]。 |
| D7 | **A2A = Orchestra 自己的持久邮局（Post Office）**：DS-Bot 语义，加跳数、转发、截止时间上限和来源追踪，在会话层投递。A2A 1.0 只作为默认关闭的边界网关出现。 | 原生的 team / subagent 消息；把 A2A 1.0 当内部协议；把 Claude 跨会话 pipe 当主总线。 | 投递走 `streamInput`、`turn/steer`、`session/prompt` [proto impl 3][tui impl 4]。DS-Bot 的语义经过验证，但没有上限、没有看门狗 [bot]。A2A 1.0 对编码场景太粗：没有工具调用流，也没有细粒度的审批 [proto]。DSH 按消息来源判定人类授权，而 ACP 投递一律记为 `{kind:'user'}`（`dsh-acp/lib/index.js:835` [核验]），所以 DSH 侧有专门的对策（§8.5）。 |
| D8 | **只有一个审批队列**：超时即拒；审批永远不经 agent 转发、不能通过 MCP 解决、不会自动放行；Orchestra 从不替非自有会话回答审批。人类动词（批准、拒绝、拍板、刹车、受保护宿主确认）只挂在需要配对 cookie 的 UI 监听器上，agent 一侧的通道物理上没有这些路由。 | hermes 的自动 `allow_once`；让 agent 侧和 UI 共用一个 HTTP API。 | Claude 的权限提示永不超时，UI 死了 agent 就挂住；转发的消息绝不能携带审批 [proto]。hermes 的做法是反模式 [own]。任何同用户进程都能调本机接口（评审）。 |
| D9 | **AutoRoute**：先走确定性规则；再用分叉的 adaptive-router `router-core`（类型化硬过滤；只认确定性或人工标注的 Wilson 门；滞回；sha256 `decisionId`）；只有请求模糊时才用 LLM 分类器；先 shadow，后 active。 | LLM 优先的指挥家；不分叉直接用 router。 | 冷启动时 Wilson 门（20 个样本、下界 0.8）返回 `no-route`；缺 token 字段时 `validateTaskPolicy` 直接抛错 [own]。DS-Bot 的群组本来就是确定性路由 [bot]。 |
| D10 | **首页 = 跨项目注意力收件箱。** 通知首选 UI 页面的浏览器 Notification API（Edge / Chrome 转成系统 toast），没有页面在线时退回 PowerShell 5.1 的 WinRT toast，另加 `herdr notification show`（M2）；分 P0–P3 级别，带去重键、专注模式和 30 分钟摘要。提醒由 **Orchestra 自己的调度器**负责。 | 终端网格；用 dsh-schedule 做面向人的提醒；toast 上放"允许"按钮。 | 收件箱即首页是成熟模式 [land impl 2]；dsh-schedule 把提醒投进 agent 会话，而不是投给人 [core]；herdr 已经装好 [tui]。`*.localhost` 是安全上下文，Notification API 可用（调研之外）。 |
| D11 | **只对接，不魔改（联邦，不分叉）。** DS-Bot 的文件只读；`/api/bot` 只用在 0.1.7+fork.1 源码里核对过的端点；live `web` profile 里不放 Orchestra 代码；任何 bundle 先在隔离的 `DSH_HOME` 加 3099 / 3199 端口上验证；需要改上游的（dsh-TUI 的 bypass 选项、DS-Bot 的权限竞态修复）先提上游 PR；配套许可证与 NOTICE 计划。 | 写 DS-Bot 的 `state.json`；重建你的 bot；长期维护对 dsh-TUI 的私有补丁。 | DS-Bot 是单写者（`state.lock`）。0.1.7+fork.1 有 `state`、`send`、`approval-answer`、`stop-member-work`、`room-progress`、`usage`，没有 `room-continue` 和 `run-stats`；`send` 每次生成新的 requestId，所以非幂等 [bot][核验-源码]。隔离验证是你自己用过的方法 [own]。 |
| D12 | **对抗版本漂移**：钉死每个二进制和 SDK；解析器按版本嗅探，失败就降级为 `unknown`，绝不降级为错误状态；黄金 fixture（Codex 覆盖 0.139.0、0.153.4、0.159.2、0.160.0，外加一份 <0.130 的历史样本验证降级）；零 token 的契约 CI；每晚 canary；带类型化拒绝码的能力登记表，M0 起就在界面上可见。 | 一直追最新版。 | DSH 已发布 38 个预发布版，约每 2 天一个；SDK 协议没有版本协商（`serverInfo.version` 恒为 0.0.1），ACP 只在 `initialize` 里声明能力，没有兼容性承诺 [core]。本机 257 个 Codex rollout 有 27 种 `cli_version`（0.34.0–0.160.0，含第三方构建 0.98.0-cometix）[核验]。dsh-TUI 已经用 `PROTOCOL_DIGEST` 守护 Codex [tui]。 |

---

## 5. 总体架构

### 5.1 拓扑

```
 Browser tab  http://orchestra.localhost:<port>
   Program · 乐手页 · Stage · Score · Ledger · Decisions · Rooms · Tuning
        │ HTTP+SSE（一次性配对码 → HttpOnly SameSite=Strict cookie · CSRF 头 · 严格 Origin · CSP）
┌───────┴────────────── orchestrad  (portable Node 24, TS, single writer) ───────────────┐
│ Inbox+Notifier · Reminders · Decisions · ApprovalQueue · PostOffice · RoomRouter       │
│ Maestro/AutoRoute · Governor · Detectors · Reaper · Ledger · CapabilityRegistry        │
│ orchestra.db (node:sqlite, WAL) + journal.jsonl (hash chain over digests) · fs fence   │
│ procguard.exe：root Job → 每个自有 host 一个嵌套 Job；进程快照；pipe-client-pid       │
├─ sources/ (READ-ONLY, allowlist) ┬─ drivers/ (OWNED) ─────────┬─ federation/ ─────────┤
│ claude: registry, jsonl, meta,   │ claude-sdk (vendored,      │ dsh-tui inject pipe   │
│   `agents --json`, opt-in hooks  │   bypass off, settingSrc   │   (human-confirmed)   │
│ codex: state_5 snapshot copy,    │   [], in-process SDK MCP)  │ DS-Bot /api/bot (M4,  │
│   rollouts (live tail M2)        │ dsh (S2: ACP or private    │   verified endpoints) │
│ dsh: v4 frame tail, projcache,   │   web; one DSH_HOME/host)  │ herdr agent/notify    │
│   web attach (interactions=none) │ codex-appserver (gated,    │                       │
│ ds-bot files, dsh-tui mounts,    │   private 0.160.x, own     │                       │
│   herdr; os: snapshot + RSS      │   CODEX_HOME)              │                       │
└──────────────────────────────────┴──────────┬─────────────────┴───────────────────────┘
                                              │ 每个 host 在自己的嵌套 Job 里
   claude CLI（经 spawnClaudeCodeProcess）· dsh host（每 host 一个 DSH_HOME）· codex app-server
   └── dsh 乐章启动 `orchestra-mcp`（stdio）→ named pipe 连回 orchestrad（核 pid + 每乐章 token）
```

图里的三列：
- **`sources/`（只读）**：观察所有会话，包括不是 Orchestra 创建的；只能读白名单里的文件（§10.11）。
- **`drivers/`（自有）**：只驱动 Orchestra 自己拉起的会话。每个宿主进程在自己的嵌套 Job 里，可以单独回收；守护进程一死，总 Job 关闭，全部跟着结束。注意：一个 DSH host 上复用的多个乐手只能整体回收进程，回收单个乐手用 `session/close`（§10.4）。
- **`federation/`**：通过别人的公开接口有限地协作，而且每一项都需要人工确认或事先验证。

### 5.2 组件

| 组件 | 职责 | 首次出现 |
|---|---|---|
| `sources/` | 只读观察器，每个数据源、每个版本一个模块，统一归一化为 dsh-TUI 的 `AgentEvent` 词汇（从 `src/agent` vendor，MIT）[tui] | M0：Claude、DSH、Codex（只有 state_5 快照）；M2：Codex rollout 实时 tail、DS-Bot、dsh-tui、herdr |
| `drivers/` | 实现 `AgentSession` / `AgentBackend`：`open`、`submit(placement)`、`cancel`、`capabilities`、`detect` [tui]。自有会话的事件**也**经过对应 source 的解析器，因此自有和只读两边共用一套事件模型 | M1（Codex 在 M4） |
| `federation/` | dsh-tui inject pipe（人工确认）、DS-Bot `/api/bot`（核对过的端点）、herdr | M2 / M4 |
| Inbox + Notifier | 跨项目收件箱，P0–P3，去重，浏览器通知 + PowerShell toast 后备；专注模式、摘要、herdr 在 M2 | M0 |
| Reminders | Orchestra 自己的调度器，提醒在重启后不丢 | M0 一次性提醒；M2 周期提醒（rrule）；M3 发给乐手的提醒 |
| CapabilityRegistry | `detect()` 的结果（是否安装、是否已认证、版本漂移）以及各项能力是否存在；类型化拒绝码 | M0 |
| Detectors | runaway、polling、bounce、orphan、stale、two-writers、policy（bypass / `approval: never`） | M0：runaway v0（Claude、DSH）、policy v0（Claude transcript 里的 bypass）；M2：其余与 DSH / DS-Bot 的 policy；M3：bounce / round |
| procguard | csc.exe 编译的常驻 helper：嵌套 Job、挂起创建、进程快照、`kill-tree{pid, createTime}`、`pipe-client-pid`（S4） | M0 |
| Store | `orchestra.db`（`node:sqlite`）+ `journal.jsonl`（哈希链只覆盖摘要）+ 可清除的片段表 | M0 |
| 写围栏 / 读白名单 | 所有写只经一个 fs 模块，默认只允许 `~/.orchestra`；所有读只允许白名单文件 | M0 |
| 乐手页 | 每个自有乐手一页：对话（流式）+ 档案卡；新建乐手向导；交还原生 | M1 |
| Decisions | 决策板、ADR 导出、已定决策注入新乐章 v0 | M1（陈旧注释探针在 M5） |
| ApprovalQueue | 唯一的审批队列，超时即拒，批准与请求摘要绑定 | M1 |
| PostOffice | 信封、投递、回执、规则 1–8、重启三阶段处理 | M1（规则 2、3、7 在 M3） |
| `orchestra-mcp` | Claude 乐章用 SDK 进程内 MCP；DSH 乐章用 stdio MCP 进程经 named pipe 连回守护进程 | M1 |
| Governor | 按项目 / 模型 / harness 排队，加每日 CNY 上限；M4 起加待审上限 | M2 |
| Reaper | 回收自有进程树，释放闲置乐章，标出幽灵分身 | M2（刹车在 M0） |
| Ledger | token 与 CNY 账本，reserve / settle | M2 |
| RoomRouter | 群聊路由（admin 优先、`[PASS]`、转发上限） | M3 |
| Maestro / AutoRoute | 指挥家与 10 步路由流水线；派活标签从 M1 起积累 | M4 |

### 5.3 运行时

- **Node**：`orchestrad` 跑在 `G:\_Projects\DSH-plugins\.tools\node24\node.exe`（v24.22.0）上 [own]。
  - 这个版本有 `zlib.createZstdDecompress` [核验]，所以综合稿里"Node 24 是否带 zstd"的假设已经解决。
  - 系统 Node v22.14.0 **没有** zstd [核验]，也缺 `module.registerHooks` [own]，因此不使用。
  - `package.json` 用 `engines.node` 声明最低版本；启动时检测 `zlib.createZstdDecompress` 和 `module.registerHooks`，缺失就在 Tuning 中报错。本机默认使用便携 Node 24，不把路径写死在代码里。
- **不要直接拉起 npm 的 `.cmd` shim。** `dsh` 解析成 `node <package bin script>`，`claude` / `codex` 用原生可执行文件。（假设，调研之外：CVE-2024-27980 修复后，Node 不再允许不经 shell 启动 `.cmd`。）
- **SQLite**：定为 `node:sqlite`（`DatabaseSync`），不引入任何原生模块 [核验]。`orchestra.db` 设 `journal_mode=WAL`、`synchronous=NORMAL`，只有一个写者。`DatabaseSync` 是同步的，所以读取 Codex 和 DS-Bot 库、全文检索这类重查询放在 `worker_thread` 里，不阻塞 SSE 和 runaway 定时器。
- **进程枚举**：本机没有 `wmic` [核验]，依赖它的 npm 库（ps-tree、旧版 pidusage）不可用；进程快照和 RSS 由 procguard 提供。
- **UI**：HTTP + SSE，只在 `orchestra.localhost` 上提供；配对、CSRF、Origin 规则见 §10.11。orchestrad 检测到自己以管理员权限运行就拒绝启动。
- **渲染与外发规则**（评审补充）：
  1. 每个响应都带 CSP：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`。不使用任何内联脚本。
  2. 所有来自 harness 或 agent 的字符串（助手文本、工具参数和结果、A2A 正文、Decision 题干与选项、提醒文本、会话和乐手标题、cwd 路径）一律用 `textContent` 渲染。markdown 渲染关闭 HTML，经 DOMPurify 净化，链接只允许 http(s)，外链先过一个中转确认页。
  3. toast 的 XML 由守护进程转义后，经 stdin 或 `-EncodedCommand` 传给 PowerShell，绝不拼进命令串；herdr 调用用 argv 数组加 `--` 分隔，并剥除 C0 / C1 控制字符和 ESC（防 OSC 52 写剪贴板、OSC 8 伪造链接）。
  4. 会话 id 必须匹配 UUID 正则才能进入 argv；任何深链都不经 shell，由浏览器端打开。
  5. 单字段长度上限 2 KB。
- **数据目录**：`~/.orchestra/`（本文补充，假设）。它不得位于任何 harness 的根目录之内；私有 DSH home（`~/.orchestra/dsh/<project>/<preset>/`）和私有 `CODEX_HOME`（`~/.orchestra/codex-home`）都在它下面，并且必须在所有项目根目录之外。乐手的 cwd 如果位于任何 `DSH_HOME`、`CLAUDE_CONFIG_DIR` 或 `~/.orchestra` 之内，一律拒绝。
- **自有乐章的状态写在哪里**（评审补充）：
  - 私有 DSH：写在各自 host 的私有 `DSH_HOME` 里。
  - 私有 codex：写在独立的 `CODEX_HOME` 里，不碰 `~/.codex`。
  - 自有 Claude：默认沿用你的 `CLAUDE_CONFIG_DIR`（复用登录，结束后可以在原生 CLI 里 `--resume`），所以它的 transcript 和 `sessions/<pid>.json` 会写进那里；是否改用独立根目录（需要单独登录）是 §17 Q8。
- **零写入是持续的不变量**，不只是 M0 的一次验收：写围栏 + CI grep（禁止其它模块直接 import `fs.write*` / `rename` / `rm`）始终生效；从 M1 起，Procmon 审计按 sessionId 白名单排除自有 Claude 乐章自己的 transcript 和 registry 条目。源文件读完立即关闭句柄，闲置文件不持有句柄。

### 5.4 三类会话所有权

```mermaid
flowchart LR
  S[发现一个会话] --> A{由 Orchestra 的 driver 创建?}
  A -- 是 --> O["owned<br/>发送 / steer / 中断<br/>审批入队 / 自动回收"]
  A -- 否 --> B{"有别的写者持有?<br/>session-mounts.json<br/>DS-Bot state.lock<br/>非 Orchestra 创建的 Claude registry 条目"}
  B -- 是 --> F["foreign-held<br/>徽标 + 只读"]
  B -- 否 --> V["observed<br/>只读 + 告警 + 深链<br/>+ 人工刹车"]
```

| 类别 | 判定 | Orchestra 可以做 | Orchestra 不做 |
|---|---|---|---|
| **observed** | 观察器发现的、不是 Orchestra 创建的会话 | 读取、告警、深链跳转；唯一的写操作是人工点击的 kill-tree | 发消息、回答审批、修改配置、使用磁盘上的 `peerToken` |
| **owned** | 由 procguard 拉起、放进嵌套 kill-on-close Job 的会话 | 全部控制：send / steer / interrupt、审批入队、回收。守护进程重启后按投递阶段处理在途工作（§8.3）：没返回的先核对日志、不重发；已投递但被杀断的恢复一次；已结束的按日志结算 [bot] | 绕过审批，使用 bypass 或 `approval: never` 的预设 |
| **foreign-held** | observed 的一个子集：明确有另一个活着的写者持有（`session-mounts.json`、DS-Bot `state.lock`、或不是 Orchestra 创建的 Claude registry 条目） | 显示徽标，只读（M2 起显示；M0 只显示 observed） | 以后也不"接管" |

守护进程崩溃时，总 Job 关闭，所有嵌套 Job 里的进程（包括孙进程）一起结束，DSH 的写锁随之释放。这正是 D4 拒绝 `taskkill /T` 的原因。守护进程绝不在 Job 里启动面向你的程序（浏览器、承载 `claude --resume` 的终端、VS Code），否则守护进程一死，这些程序会一起被杀。

---

## 6. 数据模型与状态机

### 6.1 实体

| 实体 | 关键字段 |
|---|---|
| **Project** | `id`, `name`, `roots[]`（cwd 前缀、worktree）, `gitRemote`, `color`, `priority`, `focusMuted`, `quietHours`, `budget{cnyDay, tokensMin}`, `tempo{maxActive, perModel, perHarness}`, `reviewCap` |
| **Musician** | `id`（稳定）, `projectId`, `name`, `role`, `lineageHue`（同一 harness 内分深浅）, `persona`（逐字节稳定，以保住 prompt cache [bot]）, `harness`, `model`, `effort`, `permissionProfile`, `desired/applied{model, permission}`（每次修改后回读）, `memoryScopes[]`, `kind`（`principal`、`bot`、`maestro` 或 `qa`）, `ownership`, `hostKey`（DSH：项目 + 预设 + teamMode） |
| **Part（乐章）** | `id`, `musicianId`, `seq`, `ref{backendId, sessionId}`（dsh-TUI 的全局身份 [tui]）, `configRoot`, `cwd`, `harnessVersion`, `status`（`starting`、`idle`、`running`、`requires-action`、`disposed` [tui]）, `stateConfidence`, `handoffNote`, `endReason`（`rotate`、`crash`、`budget`、`user`、`handed-back`）, `proc{pid, createdAt, jobId}`, `sourceCursor`, `contextPressure` |
| **Clone（分身）** | `id`, `partId`, `parentCloneId`, `nativeId`（`parent_tool_use_id`、spawn edge 或 DSH catalog id）, `depth`, `status`（`running`、`inactive`、`done`、`orphan`） |
| **Exchange** | `exchangeId`, `requestId`, `parentExchangeId`, `workId`, `rootId`, `from`, `to`, `role`, `delivery`, `replyTo`, `hop`, `deadline`, `trust`, `taint`（`clean` 或 `tainted`）, `provenance[]`, `bodyRef`, `state`, `receipts[]`, `resumed` |
| **Work** | `id`, `exchangeId`, `owner`, `children[]`, `heldReply`, `bounceCount`, `deadline` |
| **Task** | `id`, `projectId`, `source`（`orchestra`、`dsh-team`、`claude-team`、`codex-plan`）, `owner`, `deps[]`, `revision`（CAS）, `doneCriteria`, `roundCap`, `staleSince` |
| **InboxItem** | `id`, `projectId`, `kind`（approval、question、decision、failure、runaway、polling、bounce、orphan、stale-task、two-writers、policy、ready-for-review、route-ask、unknown-outcome、reminder、flood）, `severity`（P0–P3）, `dedupKey`（含发送者）, `partRef`, `deepLink`, `evidence[]`, `state`, `snoozeUntil`, `timeoutPolicy`, `requestDigest`（审批：规范化参数的 sha256） |
| **Decision** | `id`, `projectId`, `question`（agent 写的题干只作为数据引用）, `options[]`, `askedBy`, `status`（`pending`、`resolved`、`superseded`）, `choice`, `rationale`（只能由你写）, `resolvedBy`（永远是人）, `gitHead`, `adrPath` |
| **Reminder** | `id`, `projectId?`, `target`（`human` 或 `musician`）, `text`, `dueAt`, `rrule?`, `linkedItem?`, `createdBy` |
| **RouteDecision** | `decisionId`（sha256）, `input`, `taskClass`, `candidates[{id, rejection}]`, `chosen`, `confidence`, `reason`, `mode`（`manual`、`shadow` 或 `active`）, `overriddenBy` |
| **LedgerEntry** | 幂等 `id`, `partRef`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`（都可为空；未知就是 null，绝不记 0 [own]）, `costCny` 加估算标记, reserve / settle |
| **Event** | `partRef`, `seq`, `ts`, `kind`（含 M0 的 `edge`）, `digest`, `snippetRef`（指向可清除的片段表）, `sourcePtr`。原始 transcript 留在原地，Orchestra 只存指针 |
| **Command** | `id`, `requestId`, `target`, `verb`, `issuer`, `status`, `receipt` |
| **Room**（M3，本文补充，字段取自 bot-a2a 提案） | `id`, `projectId`, `name`, `adminMusicianId`, `members[]`, `mode`（`admin` 或 `everyone`）, `relayCap`（默认 members×3）, `lastHumanAt` |

一个 `rootId` 下的整棵 Exchange 树就是一次 **Run**，也是 Score 回放和导出的单位。每张表在首次用到它的里程碑里通过迁移创建（D1）。

**脱敏与可清除性**（评审补充）：
1. 三层脱敏：
   - 已知值精确替换：Orchestra 自己注入的 DSH key、粘贴进来的 token、守护进程自身环境变量的值。
   - 格式规则：`sk-`、`sk-ant-`、`ghp_` / `github_pat_`、`AKIA`、JWT、PEM 块、`Authorization:`、`token=` / `password=`、连接串，再加高熵检测。
   - 整段丢弃：`env`、`printenv`、`Get-ChildItem env:`、读取 `.env*` 的工具输出不保留片段。
2. journal 只对摘要做哈希链；片段和 A2A 正文放在一张可清除的表里，默认 TTL 14 天，并提供「清除秘密」命令：写入 tombstone、保留摘要，链不断。
3. 黄金 fixture 要么合成，要么经清洗脚本处理并人工复核；fixture 目录默认 gitignore；CI 跑 gitleaks。你的仓库会公开在 GitHub 上，私有代码和 token 不能进 fixture。

```mermaid
erDiagram
  Project ||--o{ Musician : has
  Musician ||--o{ Part : "rotates through"
  Part ||--o{ Clone : spawns
  Clone ||--o{ Clone : "parentCloneId"
  Part ||--o{ Event : "points into native log"
  Part ||--o{ LedgerEntry : meters
  Project ||--o{ Task : owns
  Project ||--o{ Decision : owns
  Project ||--o{ InboxItem : owns
  Project ||--o{ Room : owns
  Musician ||--o{ Exchange : "sends / receives"
  Exchange }o--o| Work : "opens / answers"
  Work ||--o{ Work : children
  RouteDecision }o--|| Musician : chosen
```

### 6.2 乐手状态（由各乐章推导）

乐手的状态取它所有乐章中**优先级最高**的那个，排序在 DS-Bot 的基础上扩展而来 [bot]：

```
needs-approval > needs-answer > runaway(muted) > failed > switching-part
  > working > waiting-on-musician > ready-for-review > idle > done > unknown
```

- 只读会话的状态带 `stateConfidence`。例如未自有的 Codex 会话处于"working 但长时间没有输出"时，只能低置信地推测"可能在等审批"。
- 对外导出：OSC 7501 用 `idle`、`working`、`blocked`、`done`、`error` [tui]；herdr `pane report-agent --state` 只接受 `idle`、`working`、`blocked`、`unknown` [核验]，所以 `done` 映射为 `idle`，`error` 映射为 `blocked` 并附 `--message`。

### 6.3 Exchange 状态

```
drafted → queued(governor) → delivered → read → working → replied
   └→ refused   （cycle | hop cap | relay cap | trust）
                   └→ timedOut（deadline → InboxItem） │ cancelled │ unknown
```

| 状态 | 含义 |
|---|---|
| `queued` | 被 governor 挡住，或目标正忙、由 Orchestra 排队 |
| `delivered` | 投递调用已成功返回，或重启后在目标日志里核对到了这条消息 |
| `read` | 目标的某个回合已经带着这条消息开始（证据见 §8.2；不是"已投递"就算已读） |
| `working` / `replied` | 目标在处理；回复信封已生成 |
| `refused` | 撞上循环、跳数上限、转发上限或信任规则 |
| `timedOut` | 超过 Work 的截止时间，生成一条 InboxItem |
| `unknown` | 投递结果不确定，且自动核对失败（§8.3）。**绝不重发**，并生成一条 InboxItem 请你核对；你可以一键手动重发 |

### 6.4 Task 状态

```
open → claimed → working → in-review → done ⇄ reopen
in-review → working   （被打回：bounce+1；N=3 时 → 升级为 InboxItem）
any → stale           （超过 T 没有事件）
claim / update 必须带当前 revision；不匹配时返回 STALE_REVISION
```

CAS 语义对齐 DSH `team_task_*` 和 BSB 的 claim / release [land]。

### 6.5 InboxItem 状态

```
open → seen → snoozed → open        （snoozeUntil 到期后）
open | seen → acted | auto-cleared（源头已解决） | expired
审批额外出口：allowed | denied | expired→denied | withdrawn（harness 自己撤回了请求）
             | withdrawn(answered-in-native-ui)（你在私有 DSH 控制台里直接回答了，记入 journal）
```

---

## 7. Harness 适配层

### 7.1 三家对照

| | Claude Code | Codex | DSH |
|---|---|---|---|
| **自有传输** | 用 vendored dsh-TUI 后端里的 Agent SDK 流式 `query()`；SDK `0.3.287`，`pathToClaudeCodeExecutable` 指向 `claude` 2.1.310 [tui]。经 `spawnClaudeCodeProcess` 由 procguard 拉起。`settingSources: []` 加 `strictMcpConfig: true`；项目的 CLAUDE.md 由 Orchestra 只读读取，作为 system prompt 附加段传入。MCP 用 SDK 进程内服务器（§8.5） | `codex app-server` over stdio，每个设置指纹一个 hub，服务多个 thread [tui]。**有门控**：需要私有的 ≥0.144 二进制（钉 0.160.x，已有验证过的绑定），独立 `CODEX_HOME` | 由 S2 决定（D5）。候选 A：从私有钉死安装启动 `dsh --profile acp`；`session/new{cwd, mcpServers}` 在 dsh-acp 0.2.1-rc.2 的实现中已有校验，stdio `command` 必须是绝对路径（`dsh-acp/lib/index.js:225-245`，评审核验），S2 只做端到端验证。候选 B：私有 `dsh web` 或 `runProfile()` 引擎加私有 bundle。都是每个（项目，预设）一个 host，每个 host 独占一个私有 `DSH_HOME` |
| **只读传输** | `<每个 CLAUDE_CONFIG_DIR>/sessions/<pid>.json`（busy / idle；只读这种文件名，同目录的 `.key` 不读）；`projects/<slug>/<id>.jsonl`；`subagents/*.meta.json`（`spawnDepth`）；`claude agents --json`（帮助文本确认包含交互式和后台会话，`--all` 额外包含已完成的后台会话 [核验]；是否暴露等待状态由 S5 验证）；opt-in 的 HTTP hooks | `state_5.sqlite` 的快照副本（`threads`、`thread_spawn_edges`、`tokens_used`，规则见 §7.3）；`rollout-*.jsonl.zst`（`task_started/complete`、`token_count`），按 `cli_version` 嗅探版本。M0 只轮询快照；rollout 实时 tail 在 M2，只跟踪最近 10 分钟内修改过的文件、最多 8 个 | 按帧 tail `~/.dsh/sessions/--<cwd>--/{<uuid>\|session-<uuid>}/session.v4.jsonl.zstd`（两种目录名并存，观察器两种都要匹配 [核验]）；后备是 `storages/session_projcache`；只读 web attach：`/connect?…&interactions=none`，URL **由你粘贴**，收到后立即换成只放在内存里的 cookie，token 当场丢弃 [core] |
| **消息 / steer** | `streamInput`：`next` = steer，`later` = queue，另有 `now` [tui] | steer：`turn/steer{expectedTurnId}`。Queue：由 Orchestra 自己排队，目标空闲时 `turn/start`；`thread/queue/*`（0.160.1 绑定里有，dsh-TUI 未接线 [核验]）作为可选优化，在 Codex 受控实跑中验证 | 候选 A：`session/prompt`。每个会话同时只能有一个 prompt 在途，且要等所有后代结束才 settle，所以**由 Orchestra 维护队列**；ACP 没有 steer，且投递一律记为人类输入（§8.5）。候选 B：`session.prompt` 支持 Steer / Queue 和 `requestId` 去重 [core]（S2 验证） |
| **中断** | `interrupt()`；对单个 subagent 用 `stopTask()` | `turn/interrupt{threadId, turnId}` | 先 `session/cancel` 停根回合；后代仍有活动时 `session/close`（quiescent cancellation + descendant disposal），再 `session/resume` 继续同一会话 [核验]。候选 A 无法中断单个分身；候选 B 可以对自有会话直接用 `subagent.interruptByParent` / `job.kill` [core]。live web 宿主上的这些操作推迟，并且需要人工确认 |
| **审批** | `canUseTool` → 审批队列，超时拒绝 | `item/{commandExecution,fileChange,permissions}/requestApproval` → `accept` 或 `decline`；超时则 `decline` | `session/request_permission` → 审批队列。只用会发审批请求（`approval: ask`）的预设；`approval: never` 的预设（包括内置 Full access）对自有乐手一律禁用（§7.4） |
| **Subagent 可见性** | `SDKTask*`、`parent_tool_use_id`；磁盘上的 `subagents/` | `collabAgentToolCall`、`subAgentActivity`、`thread_spawn_edges` | 从日志读：`subagent/catalog\|descriptor`、`team/*`（没有 start / end 事件）。M3 起私有 home 里的 bundle 提供 `subagent/start\|end`。**ACP 上拿不到** |
| **用量** | `modelUsage`（含 subagent）；`total_cost_usd` 只作参考 | `thread/tokenUsage/updated`；只有 token | `usage_update`；日志里的 `assistant/message.usage` |
| **非自有会话的控制** | 会话还活着时，`o` 把它所在的窗口切到前台（在 herdr 里就用 herdr 聚焦；否则由 procguard 按 pid 找到窗口）；会话已经退出才给出可复制的 `claude --resume <id>`，守护进程不代为启动。磁盘上的 `peerToken` 可能让任何同用户进程往会话里注入消息（待核实）；Orchestra 主动不用这条通道，并对"读取 `sessions/*.key` 或连接 `cc-msg-*` 管道"的工具调用发 policy 告警 | 无。非自有会话等审批时，只能用低置信启发式"working 且静默超过 T"来标记 | 无。往 live web 宿主 steer 推迟 |
| **版本钉与契约测试** | SDK 0.3.287（CLI 从 2.1.287 漂到 2.1.310 只提示，不阻断）；`claude-fake-sdk`；`claude-haiku-only` 守卫；`system/init.capabilities`（S3 确认 2.1.310 含 `msg_lifecycle_v1`） | 绑定 0.160.1 + `PROTOCOL_DIGEST`；`codex-fake-app-server`；`codex-cheap-only` 守卫 | 钉死私有版本；基于 `@agentclientprotocol/sdk` 的 mock ACP agent（假设）；每次升级前检查 `agentCapabilities` [core impl 8]，并比对私有 home 合成后的 `cordis.yml` 快照（§7.4） |

### 7.2 版本钉死与契约测试

| 对象 | 钉到 | 本机现状 | 契约 / 守卫 | 漂移时 |
|---|---|---|---|---|
| Claude Agent SDK | 0.3.287 [tui] | — | `claude-fake-sdk`；真实回合只允许走 `claude-haiku-only` | 能力检查 `system/init.capabilities` |
| Claude CLI | 验证线 2.1.287 [tui] | 2.1.310 [proto] | — | 只在 Tuning 提示，不阻断 |
| Codex | 门槛 `MIN_CODEX_VERSION = '0.144.0'`（`src/backends/codex/contract.ts:37`）；私有二进制钉 0.160.x | 全局 0.139.0 → `harness-unsupported` [tui][核验]；Codex Desktop 写出的 rollout 标的是 0.153.4–0.160.0，其中 0.160.0 只有 1 份 [核验] | 0.160.1 生成的绑定 + `PROTOCOL_DIGEST`；`codex-fake-app-server`；`codex-cheap-only` | 不通过受控实跑就保持只读 |
| DSH | 私有安装的确切版本 | 全局 0.2.1-rc.2；`next` 标签 0.2.1-rc.4 于 2026-10-26 发布 [core] | mock ACP agent（假设）；升级前比对 `agentCapabilities` 和合成配置快照 | 先跑契约测试再升级；不跟随全局自动更新 |
| 解析器 | 每个数据源 × 每个版本一个模块 | 本机 257 个 Codex rollout 有 27 种 `cli_version`（0.34.0–0.160.0，含第三方构建 0.98.0-cometix ×42）[核验]；DSH v4 有迁移链 [core] | 按 `version` / `cli_version` / DSH 包版本嗅探；黄金 fixture：Codex 0.139.0、0.153.4、0.159.2、0.160.0 各至少一份，再加一份 <0.130 的历史样本，用来验证降级为 `unknown`；每晚对已安装工具跑 canary | 未知结构降级为 `unknown`；历史 rollout 只读 `state_5` 里的元数据，首次建索引在后台限速进行 |

**零 token CI**：fake SDK、fake app-server、mock ACP agent，再加几条检查：vendored 代码里出现任何 `dangerously` / bypass 标志时失败；私有 home 合成配置里出现 `approval: never` 时失败；其它模块直接 import `fs.write*` / `rename` / `rm` 时失败。

### 7.3 其它数据源与读取规则

- **SQLite 只读规则**（评审补充）：Codex 的 `state_5.sqlite` 处于 WAL 模式（有 `-shm` 和 `-wal`）[核验]。WAL 读者会往 `-shm` 写读标记，长时间的读事务还会挡住 Codex 的 checkpoint。所以：
  1. `state_5`（约 3.5 MB）采用快照读：每次轮询把 db 和 `-wal` 复制到 `~/.orchestra/tmp/` 再打开副本，原库零锁、零 `-shm` 写入；副本不一致就丢弃重试。轮询间隔 ≥2 s。
  2. 必须直接打开原库时，用 `DatabaseSync(path, {readOnly:true})` 加 `PRAGMA query_only=1`，查询完立即关闭，不跨 `await` 持有语句。
  3. 永不打开 `thread_history_1.sqlite` 和 `logs_2.sqlite`。
  4. `node:sqlite` 是否支持 `immutable=1` URI 不确定，需要验证。
  5. DS-Bot 的 `usage.sqlite`（M2）用同样的规则。
- **DS-Bot 0.1.7 fork（只读，M2 起）**：
  - `state.json`（`exchanges`、`works`、`bots`）。
  - `inflight.json` 的 `turns` 是一个 **map**：`sid→{botId, roomId, since, trigger, approval, resumed}` [bot]。这些字段要在 0.1.7 上重新核对（S6，M2）。
  - `usage.sqlite` 的 `calls` 表。
- **dsh-tui**：`session-mounts.json` 用来把会话标为 foreign-held；`inject/servers.json` 列出 inject 服务器。
- **herdr**：`agent list/get`，只信任 `custom:` 来源的自报状态 [tui][land]。
- **OS**：进程快照 + RSS 采样都来自 procguard。注意 `dsh web`、Orchestra 的 DSH host、Claude CLI 都在一个进程里托管多个会话或进程内子代理，RSS 只能归因到进程 [core]。

### 7.4 运行与安装规则

- **Codex**：只用私有二进制和独立的 `CODEX_HOME`（例如 `~/.orchestra/codex-home`，需要单独登录一次，见 Q1）；全局的 0.139、`~/.codex` 和 Codex Desktop 都不动。
- **vendoring 卫生**：
  - **先上游、后补丁。** M1 第 1 周向 dsh-TUI 上游提 PR：把 `allowDangerouslySkipPermissions` 改为调用方传入的选项（默认值由维护者决定），并把 `credentials` 依赖改为注入接口，让 `src/backends/*` 成为真正的孤岛。合并后按钉死的 commit vendor，本地零 diff；M1 结束前仍未合并，就保留本地补丁：把 `src/backends/claude/options.ts:274` 的 `allowDangerouslySkipPermissions: true` 改成 `false` [核验]，剥掉 `backends/shared/channel-tokens.ts → src/utils/credentials.ts` 这条依赖以及 claude.ai 订阅 token 注入（有服务条款方面的顾虑 [tui]）。
  - 要 vendor 的文件：`src/agent`、`src/backends/{claude,codex,shared}`、被引用到的 `src/shared/*` 文件（display-path、image-size、elicitation），以及只含类型的 `src/adapter/ports/channel-{view,session}.ts`（`src/agent` 的多个文件从这里 import 类型 [核验]）。`dsh-adapter/migrate/parse` 的 import 边界未经验证，要么先做边界检查，要么自己写解析器。
  - vendored 的 Claude 选项里 `mcpServers` 和 `hooks` 都是 `'omit'` [核验]。所以 MCP 注入是对 vendored 代码的修改（S3：把 `mcpServers` 改为 `set`，传入 SDK 进程内服务器），Claude 的 `PreToolUse` hook 在自有乐章上不可用，写租约改用 `canUseTool` 执行（§10.8）。
  - CI 在 vendored 树里发现任何 `dangerously` / bypass 标志就失败。
- **自有 Claude 乐章的配置隔离**（评审补充）：
  1. `settingSources: []` 并开 `strictMcpConfig: true`。权限规则全部由 Orchestra 显式传入，不继承你的 user / project / local 设置、hooks 和 `.mcp.json`（vendored 后端默认加载全部三种设置来源 [核验]；你的用户设置里有 `skipDangerousModePermissionPrompt: true`，评审核验）。禁止使用 `acceptEdits`。
  2. 受保护路径：`.claude/**`、`.mcp.json`、`.codex/**`、`.dsh/**`、`cordis.patch.yml`、`.git/hooks/**`、`.vscode/tasks.json`、`package.json` 的 scripts、`.husky/**`。对这些路径的任何写入都进审批队列，并要求键入确认。
  3. 零 token CI：乐手写入 allow 规则或 hook 之后，下一次 Bash 调用仍然进入审批队列。
- **私有 DSH home 组合 v1**（评审补充；dsh-acp-app 建立在 dsh-base 之上，自有乐手默认继承 dsh-base 的全部插件 [核验]）：

  | 插件 / 设置 | 处理 | 原因 |
  |---|---|---|
  | `goal-round-driver`、`tool-goal`、`command-goal` | 关闭，直到以非 user 来源投递落地（M3 bundle 或 S2 选 B） | ACP 投递被记为人类输入，任何 agent 消息都能开启自主轮次（§8.5） |
  | `tool-workflow` | 关闭，直到 governor 能看见它的派生 | 并行扇出绕过 governor |
  | `subagent.maxActiveSubagents` / `maxDepth` | 设为 governor 对该模型的 `perModel` 上限 / 1 | 超限时 DSH 报错而不排队，计为 `over-cap` 事件 |
  | `repeat-tool-reminder` | 保留，作为证据源 | §10.3 |
  | `dsh-schedule` | 不挂载（dsh-base 本来也没有 [核验]） | 发给乐手的提醒由 Orchestra 调度（M3） |
  | 遥测 | 启动时设 `DSH_TELEMETRY_DISABLED=1` | 默认导出到 deepseeksvc 的收集器（`dsh-base/cordis.patch.yml:208-225` [核验]） |
  | 权限 | 启动时显式设置 `DSH_PERMISSION_MODE`，不继承你的环境；合成后的配置里不得出现 `approval: never` | Full access = `danger-full-access` + `approval: never` [核验] |

  S2 输出合成后 `cordis.yml` 的快照；每次升级私有 DSH 版本时，CI 比对快照，出现新增 bundle 就失败。
- **Windows 上的 DSH 沙箱**：EPERM 的根因是受限进程内以 `stdio:'pipe'` 再派生子进程（dsh-sandbox-windows-acl 的已知限制）；inherit / ignore stdio 与 PowerShell 匿名管道可用 [own]。S2 逐项测：`workspace-write`+`ask`、`read-only`+`ask`，以及（必须关闭沙箱时）自定义预设 `{sandbox: danger-full-access, approval: ask}` 是否仍会产生审批请求。
- **DSH 凭据**：私有 home 的凭据不能从 `~/.dsh/.credentials.yaml` 复制。建议（§17 Q2）：用一把 Orchestra 专用、可随时吊销的 API key，DPAPI 加密存在 `~/.orchestra`，经 `DEEPSEEK_API_KEY`（dsh-base 的 `apiKeyEnv`）只注入私有 host 的进程环境，不写入私有 home 的 `.credentials.yaml`。S2 要验证：私有 home 的凭据服务为空时环境变量生效；一次工具调用里执行 `env` / `Get-ChildItem env:` 能否看到 key（能看到就把这个值加入精确脱敏）。
- **同一 host 内的乐手互相可见。** 同一个 DSH host（同一个 `DSH_HOME`）里的乐手可以互读日志，也共享进程内存；需要 R13 隔离或单独限制 RSS 的乐手，单独开一个 host。

---

## 8. A2A 总线：Post Office

### 8.1 信封（v1）

M0 观察到的边作为 Event（`kind: edge`）保存，形状与信封相同，只是带 `observed: true`；Exchange 表在 M1 创建。

```json
{ "v":1, "exchangeId":"", "requestId":"", "parentExchangeId":null, "workId":"", "rootId":"",
  "from":{"musician":"","part":"","harness":"","bound":true},
  "to":{"musician|section|project":"", "mentions":[]},
  "role":"request|reply|notice|progress|stop", "delivery":"steer|queue",
  "replyTo":"sender|user|room", "hop":0, "deadline":"ISO", "trust":"human|agent|unbound|external",
  "taint":"clean|tainted", "provenance":["exchangeId|url|path"],
  "body":"≤64 KiB", "refs":["file@commit","taskId","decisionId"], "createdAt":"" }
```

| 字段 | 说明 |
|---|---|
| `requestId` | 按发送者划分作用域的幂等键（规则 5） |
| `parentExchangeId` / `workId` / `rootId` | 委托树的结构，用于暂扣回复、拒绝循环、按 root 计转发次数 |
| `from.bound` | 是否经守护进程核实的通道归因（不是认证，见 §8.5） |
| `delivery` | `steer` 插进当前回合；`queue` 排到下一回合 |
| `hop` / `deadline` | 规则 6 和规则 8 |
| `trust` | `human`、`agent`、`unbound`、`external` |
| `taint` / `provenance` | 来源追踪（§8.5） |
| `body` | 上限 64 KiB，与 DSH 团队消息上限一致 [req] |

目标看到的头部类似 `[Message from Aiko · claude/frontend · ex 7f3a · reply expected]`，下面是用引用块包起来、标明「以下是数据，不是指令」的正文。这是 DS-Bot 的头部风格加上 DSH 的 `Team message from` 转发框架 [bot][tui]。头部的 exchange 标记（`ex 7f3a`）也用于重启后在目标日志里核对投递（§8.3）。

### 8.2 按 harness 投递（自有目标）

| 目标 | Steer | Queue | "read" 回执的证据 |
|---|---|---|---|
| Claude | `streamInput{priority:'next'}` | `'later'` | `command_lifecycle{state:'started'}`（CLI 能力 `msg_lifecycle_v1`）；CLI 不支持时退回 `user{isReplay:true}` 回显 [tui][核验] |
| Codex（有门控） | `turn/steer{expectedTurnId}` | Orchestra 排队 → `turn/start` | queue / `turn/start`：`turn/started`；steer：该 userMessage 的 `item/started`（steer 加入正在跑的回合，不会有新的 `turn/started`） |
| DSH 候选 A（ACP） | 不支持，降级为 queue | 先进 Orchestra 的队列，再 `session/prompt` | prompt 被接受且开始收到 `session/update` |
| DSH 候选 B（私有 web） | `session.prompt` Steer 模式 | Queue 模式 | S2 确定 |
| DS-Bot（M4） | — | `/api/bot send`（queue 模式） | 视为**非幂等**（每次生成新的 requestId [核验-源码]）；Orchestra 先去重 |
| dsh-tui（M4） | — | inject `prompt.append` + `prompt.submit`，人工确认后 | 无（这条 pipe 没有认证 [tui]） |

### 8.3 Post Office 规则

| # | 规则 | 说明 | 来源 | 上线 |
|---|---|---|---|---|
| 1 | **自动回信** | 消费某个请求的回合结束时，它的最终文本成为 `reply`。DSH 以 prompt settle 为准 | [bot] | M1 |
| 2 | **暂扣回复** | 回复要等所有子 Work 都结束 | [bot] | M3 |
| 3 | **拒绝循环** | 给一个正在等同一 Work 的上游乐手发消息会被拒绝 | [bot] | M3 |
| 4 | **合并** | 同一发送者的未读消息合并成一条 | [bot] | M1 |
| 5 | **`requestId` 幂等** | 按发送者划分作用域。同 id 同内容：重放原回执；同 id 不同内容：拒绝；结果为 `unknown` 的绝不自动重发 | [bot]；"绝不重发"来自 adaptive-router `OUTCOME_UNKNOWN` [own] | M1 |
| 6 | **跳数上限** | 默认 4 | 新增 | M1 |
| 7 | **每 root 转发上限** | 默认 20（假设） | 新增 | M3 |
| 8 | **每 Work 截止时间** | 默认 30 min，超时生成 `timedOut` InboxItem | 新增 | M1 |

**重启后按投递阶段处理**（评审补充，解决"恢复一次"和"绝不重发"的冲突）。守护进程崩溃时，Job 会杀掉所有自有宿主，所以在途回合都是"被打断"，而不是"在没人看的时候结束"：

| 阶段 | 处理 |
|---|---|
| (a) 投递调用还没有返回 | 先自动核对：在目标会话的日志里查找头部的 exchange 标记（DSH v4 日志、Claude transcript；候选 B 还可以用同一 `requestId` 重发，宿主按已提交的 `user/message` 去重 [core]）。找到就记为 `delivered`，进入 (b) 或 (c)；找不到就记为 `unknown`，**绝不自动重发**，生成 `unknown-outcome` InboxItem |
| (b) 已 delivered，但回合被 Job 杀断 | 用 `session/resume`（Claude 用 `resume`）恢复会话，只发一次固定的「继续上一回合」提示（不重发原始正文），journal 记 `resumed: true`；再次被打断就转为 `unknown` |
| (c) 回合在日志里已经结束 | 按日志结算，生成回信 |

### 8.4 一次完整的往返

```mermaid
sequenceDiagram
  autonumber
  participant FE as 前端乐手 Aiko（Claude，owned）
  participant MCP as orchestra 工具（Aiko 乐章的进程内 SDK MCP）
  participant PO as Post Office（orchestrad）
  participant GOV as Governor
  participant BE as 后端乐手 Ren（DSH，owned）
  FE->>MCP: orchestra_send(to="Ren", body, role="request", request_id)
  MCP->>PO: 信封 v1（from 由守护进程持有的 query 对象归因，trust=agent）
  PO->>PO: 幂等检查、hop、信任与 taint 规则
  PO->>GOV: 申请投递名额
  GOV-->>PO: 放行（否则状态为 queued，排队等待）
  PO->>BE: session/prompt（候选 A 没有 steer，由 Orchestra 排队）
  Note over PO,BE: 回执 delivered
  BE-->>PO: session/update 开始，回执 read
  BE-->>PO: prompt settle（所有后代都已结束）
  PO->>PO: 规则 1：最终文本生成 reply 信封
  PO->>FE: streamInput（Aiko 此前已结束回合，回信唤醒新回合）
  Note over FE: 看到 [Reply from Ren · dsh/backend · ex 7f3a]
```

### 8.5 信任规则

- **通道归因，不是认证。** 所有进程都以同一个 Windows 用户身份运行。
  - Claude 乐章用 SDK 进程内 MCP（`type:'sdk'` / `createSdkMcpServer`）：没有独立进程，也不需要 token，身份就是守护进程手里的那个 `query()` 对象。这样也避开了 SDK 把 stdio MCP 配置（含 env）写进 `claude.exe` 命令行（`--mcp-config`）的问题（评审核验）。
  - DSH 乐章：`orchestra-mcp` 经 named pipe 连接守护进程，守护进程用 procguard 的 `pipe-client-pid` 核实对端确实是该 host 的子孙进程，再用每乐章 token 区分同一 host 内的不同乐章。token 在每次乐章启动时轮换；S2 检查 token 是否出现在私有 home 的会话日志里。同一 host 内的乐手视为互相信任，需要隔离时单独开 host。
- **DSH 按消息来源判定人类授权。** 经 ACP `session/prompt` 或 Web `session.prompt` 投递的内容一律被记为 `{kind:'user'}`（直接人类输入）（`dsh-acp/lib/index.js:835` [核验]；`dsh-api-session-controller` 同理），因此会获得建目标等权限，并清零原生循环守卫和 jobs 唤醒预算。对策：
  - A2A 投递到 DSH 的目标形态是非 user 来源 `{kind:'orchestra', form:'relay', exchangeId, senderMusicianId}`（DS-Bot 和 Agent Team 都这样做 [bot][core]），由私有 home 的 bundle 提供（M3；S2 选 B 时更早）。只有你在 Program 或乐手页里亲手发出的消息才用 user 来源。
  - 在此之前（M1 走 ACP 时），私有 home 组合关闭 `goal-round-driver`、`tool-goal`、`command-goal`（§7.4），并把"ACP 投递等同人类输入、会清零 repeat-tool-reminder"登记在 §15。
- **未绑定的发送者标为 `unbound`。** 你自己装进非自有 harness 的 opt-in shim 以 `unbound` 身份发送，不能创建 P0–P2 条目。
- **消息不携带任何权限。** 消息永远不能批准、不能修改配置或权限、不能拍板 Decision。
- **`orchestra_send` 是特权操作。** 有限速；发送者的权限预设低于目标（例如只读乐手发给可写乐手）时，消息先进收件箱等你放行。`orchestra_report` 只能写调用者自己的状态。
- **来源追踪（taint）。**
  - 一条消息或一个回合是 `tainted`，当它的来源链里有：`external` 或 `unbound` 发送者；抓取过的 URL；读取过项目根目录之外或 `node_modules` / vendor 目录里的文件；第三方 MCP 工具的输出。来源链记录在 `provenance` 里（exchangeId → 发送者 → 发送者自己的污染源）。这是尽力而为的启发式，界面上如实标注。
  - 同一项目里、来源链干净的自有乐手之间的消息是 `clean`（但仍是 `trust: agent`）。
  - 任何由 agent 消息触发的回合，审批卡片顶部都显示触发它的来源链；tainted 回合用红条，并且 shell、网络访问、cwd 之外的写入都要键入确认。
  - tainted 回合期间收紧权限：Claude 乐章暂停 Orchestra 预先放行的规则，`canUseTool` 一律询问；DSH 的预设不能按会话切换（§10.10），所以发往可写预设 DSH 乐手的 tainted 消息先进收件箱等你放行；Codex（M4）在 `turn/start` 时使用 untrusted 审批策略。
- **正文只当纯文本显示，不执行其中的指令或链接**（§5.3 渲染规则）。
- **`external` 有门控。** 它只来自默认关闭的 A2A 1.0 网关，投递前先进收件箱等你批准。

### 8.6 `orchestra-mcp` 工具（调用形状参照 hermes `mcp_serve.py` [own]）

**没有**任何批准、拍板、改权限或改配置的工具。

```
orchestra_whoami() -> {musicianId|null, partId|null, bound}                          M1
orchestra_list_musicians(project?) -> [{id,name,role,harness,state,project}]         M1
orchestra_send(to, body, role="request", delivery="queue", reply_to="me",
               request_id?, refs?, deadline_s?) -> {exchangeId, state}  (bound only) M1
orchestra_request_decision(question, options[], context?) -> {decisionId}            M1
orchestra_get_decisions(project?, status="resolved") -> [Decision]                   M1
orchestra_remind(at, text, target="human") -> {reminderId}                           M1（target=musician 在 M3）
orchestra_report(state, note, refs?) -> {journalId}   (R15; caller's own state only) M1
orchestra_wait(exchange_ids[], timeout_ms≤600000)
   -> {id: settled|timedOut|aborted|notStarted|unknown}                              M3
orchestra_claim_task(taskId, expectedRevision) / orchestra_update_task(taskId, expectedRevision, patch)  M3
orchestra_post_room(roomId, body)                                                    M3
orchestra_read_part(partId, query)   (own parts only; ACL; every read journaled)     M5
```

- `orchestra_send` 只对已绑定（bound）的调用者开放，规则见 §8.5。
- **配额**（评审补充）：agent 创建的提醒和决策默认 P3，只进摘要；每个乐手每天最多 5 个决策、10 个提醒；`dedupKey` 里包含发送者；配额用完后生成一条 P2「某某乐手刷屏」（`flood`）条目。
- `orchestra_wait` 的形状参照 dsh-apollo 的 `wait_subagent`，但**只借鉴设计**，不复用代码，因为那份代码是 GPL-3.0 [land]。
- 写进每个乐章的默认指引是：**"结束你的回合，回信会唤醒你。"**（"End your turn; the reply will wake you."）`wait` 只留给真正的 AND-join。
- Claude 进程内 MCP 和 DSH `session/new{mcpServers}` 的注入由 S3 / S2 端到端验证；Codex app-server 能否接受注入的 MCP 配置在 M4 的受控实跑中验证（假设）。

---

## 9. 指挥家 Maestro 与 AutoRoute

### 9.1 Maestro 是谁

- Maestro 是一个**自有乐手**：负责路由、委派、总结，**从不改代码**。
- 你通过顶部的 baton bar（`/`）和它说话。显式的 `@mention` 会绕过它。
- 它用哪个 harness、哪个模型由你决定（§17 Q3）。本文建议的默认值：跑在 DSH 私有 home（ACP）上，模型 `deepseek-v4-flash`（它是 ACP 的默认模型 [core]，但选它来做路由是一个选择，不是事实）；Maestro 自身每日 2 CNY（假设）。
- M1–M3 期间没有 Maestro，你可以指定任意一个自有乐手当"主代理"（§2.3）。

### 9.2 十步流水线

| 步 | 内容 | 用 LLM? | 依据 |
|---|---|---|---|
| 1 | 显式 `@musician`、`@section` 或 `@project` | 否 | [bot] |
| 2 | 线程亲和：对某个未结 exchange 的回复，回到那个线程 | 否 | [bot] |
| 3 | 当前聚焦的项目 chip | 否 | — |
| 4 | 房间规则：admin 先答、`[PASS]`、自你上次发言起转发上限为 members×3 | 否 | [bot] |
| 5 | 硬过滤，带类型化拒绝码；用分叉的 `router-core`，主键改为 `[harness, musician, project/worktree, model, configVersion]` | 否 | [own] |
| 6 | 亲和加滞回：`evaluateSwitch`，冷却 300 s，阈值 1500 bps | 否 | [own] |
| 7 | 证据门：每个 `taskClass` 一个 Wilson 下界，只认确定性或人工标签（测试 / CI 通过、你在审查中接受、**你自己的派活选择**）；拒绝模型自评 | 否 | [own] |
| 8 | 按配额或成本排序 | 否 | [own] |
| 8b | 报价（M5）：为选中的目标估算 token 和 CNY，超过阈值时先问你 | 否 | R27 |
| 9 | **只有 1–8 步之后仍然模糊时**，才用便宜的分类器，输出 `{project, target, taskClass, confidence, reason}` | 是 | — |
| 10 | 置信度低时生成一条一键选择的 "Route to?" InboxItem | 否 | — |

（本文澄清）命中第 1–4 步的请求直接得到目标，但仍要过第 5 步硬过滤：例如目标 `busy` 就进队列，`harness-unsupported` 就直接拒绝并说明原因。

**拒绝码**（第 5 步）：

| 拒绝码 | 例子 |
|---|---|
| `harness-unsupported` | codex 0.139 < 0.144 |
| `auth-missing` | 私有 DSH home 还没有凭据 |
| `foreign-held` | 目标会话被 dsh-tui 或 DS-Bot 持有 |
| `permission-mismatch` | 任务需要写权限，乐手是只读预设 |
| `busy` | 乐手在忙，或 governor 已满，或项目待审超过上限 |
| `over-budget` | 超过项目每日 CNY 上限 |
| `project-mismatch` | 乐手不属于该项目 |

### 9.3 跨 harness 迁移

把工作从一个 harness 挪到另一个时，**永远开一个新乐章并附上交接笔记，绝不重放历史**（`SESSION_MIGRATION_REQUIRED` [own]）。

### 9.4 审计

每次路由都写一条 RouteDecision：sha256 `decisionId`、所有候选及其拒绝码、选中的目标、置信度、理由；界面上显示为一个理由 chip。

### 9.5 从标签到 shadow 再到 active

```
M1 起：你每次用 m、@、行内回复派活，或在新建乐手时选定目标，都记成一条
       RouteDecision（mode=manual），附上按规则分出的 taskClass
   │
   ▼
M4 shadow：显示"会路由到 X（置信度、理由）"，执行的仍是你的选择；每次改派继续记成标签
   │  门槛（默认值，假设，§17 Q11）：最近 50 条派活的 shadow 一致率 ≥80%，
   │  并且 blocked→noticed 的中位时间 <2 min
   ▼
active：按 AutoRoute 执行；改派仍然只要 1 个动作（拖动卡片，或用 @ 重新发送），每次改派继续记成标签
```

- 因为标签从 M1 起积累，M4 开启 shadow 时已经有数周的标签；但 Wilson 门（20 样本、下界 0.8）在样本不足的 `taskClass` 上仍会返回 `no-route` [own]，这些请求继续靠第 1–4 步加第 10 步。这是有意为之。
- 进入 active 模式还受人类注意力指标的约束（§14）。

---

## 10. 控制与安全

### 10.1 能力矩阵

| 能力 | owned | observed | foreign-held |
|---|---|---|---|
| 读取状态和事件 | 驱动事件流 + 日志 | 日志 / registry / sqlite 快照（只读白名单） | 同 observed |
| 发送、steer | 可以（M1） | 不可以（Orchestra 主动不用磁盘上的 `peerToken`） | 不可以 |
| 中断 | 可以（DSH：cancel → close → resume） | 只能人工 kill-tree | 同 observed（受保护宿主需二次确认） |
| 审批 | 进队列，超时拒绝 | 只深链到原生 UI | 同 observed |
| 死循环 | 自动中断 + 静音 + P0 | P0 + toast + 刹车按钮 | 同 observed |
| 回收 | 每个 host 一个嵌套 Job；单个 DSH 乐手用 `session/close` | 只检测，显示幽灵分身 | 同 observed |
| Governor | 强制排队 | 只计量，80% 时预警 | 同 observed |

### 10.2 Governor（速度控制）

- **自有工作**：Post Office 按项目、模型、harness 给乐章启动和投递排队，另有每日 CNY 上限。什么都不会失败，超额的工作只是等待。Governor 只管得住 Orchestra 自己发起的投递和乐章启动。
- **DSH 原生子代理**：仍受 `maxActiveSubagents` 约束（每个激活树 8 个、进程内计数、不排队），超限时报 `ACTIVATION_LIMIT_REACHED` [core]。Orchestra 先把私有 home 的 `maxActiveSubagents` 设为 governor 对该模型的 `perModel` 上限（§7.4），超限计为 `over-cap` 事件；等私有 home 的 bundle 能在 `tools/pre-execute` 拦截时，再改为排队（假设）。
- **待审上限**（M4）：某个项目的 ready-for-review 超过 N 条（默认 3，假设）时，Maestro 的新派活进队列等待；你手动派活时只提示、不阻止。
- **只读会话**：只计量，达到 80% 时预警 [own]。
- 每个模型的默认上限由"模型组合压力测试"校准（§14）。

### 10.3 Runaway（死循环）检测

- **触发条件**：
  - 同一工具名 + 归一化参数哈希（能抓到近似重复），在 120 s 内出现 ≥5 次；
  - RSS 超过上限，或增长速度超过阈值；
  - 输出洪泛。
- **与 DSH 原生守卫的分工**：DSH 的 `repeat-tool-reminder` 在精确重复 3 / 5 / 8 次时发提醒，只是建议性的 [核验]。DSH 源把这些提醒消息解析为证据（P2，「原生守卫已介入」）；对 DSH 会话，精确重复在第 8 次提醒之后仍在继续，才升为 P0。Orchestra 自己的检测聚焦原生守卫没有覆盖的部分：近似重复、RSS 和输出洪泛。
- **自有会话**：中断并**静音**，10 s 内生成 P0。DSH 先 `session/cancel`，后代仍在活动就 `session/close`，再 `session/resume`。
- **只读会话**：P0 + toast，并提供刹车。
- **RSS 的限制**：只能按进程归因。`dsh web` 和 Orchestra 的 DSH host 都在一个进程里托管多个会话（DSH 的 spawn / fork 子代理也在进程内），Claude 的 Task 子代理也跑在 claude 进程内 [core]，所以 RSS 只能归因到宿主进程。宿主超限时生成 P0，并列出该宿主上的所有乐手。

**场景走查：grep 子代理把内存吃光**

| 场景 | 发生什么 | 你能做什么 |
|---|---|---|
| ① Claude 终端会话（observed） | P0 toast（≤10 s） | `K` 弹窗默认只勾 RSS 最大的那棵子树（例如 `rg.exe`），会话本身保留。如果内存涨在 claude 进程自己身上（进程内子代理），弹窗提示「到该终端按 Esc」，`o` 把那个终端窗口切到前台，不执行 `claude --resume` |
| ② Codex Desktop（受保护宿主） | P0 toast | 只能杀它的子进程子树；杀宿主本身需要键入确认 |
| ③ DSH Web（多会话宿主） | P0，显示宿主的总 RSS，并按重复的工具调用定位疑似会话 | 默认只杀子进程；宿主不能安全刹车，界面提示「到原生 UI 取消该会话，或粘贴 `interactions=answer` 的 URL」 |
| ④ 自有乐手（M2 起） | 10 s 内自动中断并静音，P0 进收件箱 | 查看分身树和证据；需要时 `K` |

### 10.4 Reaper（回收器）

- **自有进程**：每个宿主（Claude CLI、DSH host、codex app-server）在自己的嵌套 Job 里，可以单独结束。一个 DSH host 上复用的多个乐手只能整体结束进程；回收单个 DSH 乐手用 `session/close`，不杀进程。闲置乐章在 N 分钟后释放，身份保留；没有会话的 host 随之关闭。
- **自有会话的分身**：Claude 用 `stopTask()`，Codex 用中断回合。DSH 先 `session/cancel` 停根回合；若后代仍有活动，则 `session/close`（README：quiescent cancellation + descendant disposal），再 `session/resume` 继续同一会话 [核验]；仍无效时才对该 host 用刹车（会波及同一 host 上的其它乐手，需要你确认）。M3 起私有 home 的 bundle 在父回合结束或被中断时级联中断仍在运行的后代，并用 `subagent/end` 核对。
- **只读会话的孤儿**：检测出来并画成幽灵，判定规则是：
  - DSH：父会话 `turn/end` 之后，某个 subagent 仍在活动（它自己的日志还有新事件）超过 T；resident / inactive 的可继续子代理不算孤儿（DSH 设计上就会让闲置子树常驻 [核验]）。低置信。
  - Codex：父会话已结束，spawn edge 仍是 `running`；
  - Claude：subagent 的父会话已经不在。

### 10.5 Kill-tree 刹车（场务 stagehand）

1. **只能由人点击。** 弹窗列出每个后代进程的 pid、映像名、命令行和 RSS；可以勾选任意子树，默认选 RSS 最大的那棵。
2. **安全遍历进程树**：Windows 上 PPID 不会更新、PID 会被复用。遍历时每条边都要满足子进程创建时间 ≥ 父进程创建时间，否则判定为 PID 复用并剪掉该边。按 pid + 创建时间来杀，循环到进程树不再变化为止，最多 5 轮。
3. **受保护宿主**按「映像名 + 命令行 + 父链」识别（几乎都是 `node.exe`，只看映像名没有意义），需要第二次**键入**确认：
   - `dsh web` 宿主（DS-Bot 与所有 live web 会话）和 watchdog 的 bash；
   - DSH Desktop 宿主（`desktop` profile，若在用）；
   - Orchestra 自己的 DSH host（走回收器，不手动 kill，以便把在途 Exchange 标为 `unknown`）；
   - DS-Bot 桌面引擎（`~/.ds-bot`）；
   - Codex Desktop、共享的 `codex app-server` daemon、Claude Desktop；
   - herdr、Windows Terminal / OpenConsole / conhost、VS Code / Cursor、承载 UI 的浏览器、explorer、wsl.exe / vmmem；
   - 承载当前工作的那个 Claude 会话；
   - procguard、`orchestrad` 自己。
4. **默认只杀 harness 进程以下的子孙。**「连同宿主一起杀」只对单会话宿主开放（Claude CLI，之后可以 `--resume` 恢复），并且要键入确认。对多会话宿主，界面显示「无法安全刹车」以及替代做法（§10.3 场景 ③）。
5. 守护进程拒绝以管理员身份运行。

### 10.6 Join / wait 与轮询检测

- `orchestra_wait` 加自动回信，替代 Exchange 之间的轮询。
- M3 起，私有 home 的 bundle 提供净室实现的 `wait_subagent(ids[], timeout_ms)`，覆盖自有 DSH 乐手内部的原生分身（§12.1）。
- 轮询嫌疑检测器：标记反复调用 `list_agents`，或 `wait_agent` 反复返回 `noProgress` 的情况 [core]。

### 10.7 循环与打回上限

| 上限 | 默认 | 触发后 |
|---|---|---|
| 跳数上限 | 4 | `refused` |
| 每 root 转发上限 | 20（假设） | `refused` |
| 房间转发上限 | 自你上次发言起 members×3 [bot] | 房间暂停，直到你按 **Continue** 或发言 |
| 打回上限 | 每个（task，A↔B）N=3 | 升级为 InboxItem |
| 轮次上限 + 完成标准 | 每个 Task 单独设置 | 到上限即停 |
| rounds-to-done 直方图 | — | 呈双峰（第 1 轮就结束 vs 撞上限）时标记 |

以上检测与强制都在 M3（R08）；M2 只有 runaway。

### 10.8 隔离

- **worktree 按需创建**，并分配端口。每个 worktree 占 0.5–1 GB，跨 worktree 合并仍是未解决的问题 [land]。界面上明确标注"这不是沙箱"。
- **双写者告警**：同一根目录下，两个活跃乐章编辑同一路径时触发。
- **写租约只是建议性的**：只在自有乐章上执行——Claude 通过 `canUseTool`（vendored 后端不传 hooks），Codex 通过 `fileChange` 审批。shell 命令的编辑会绕过这两者，对账 `git status` 后显示为"未归因"漂移（tonghuashun 的做法 [own]）。

### 10.9 审批

- 一个队列，超时即拒（默认 30 min，假设，§17 Q4），只能由人解决。超时拒绝针对的是「你不在」，不针对「你在专注别的项目」：专注模式下被静音项目的审批暂停计时（规则见 §11.2）。
- **批准与请求绑定**：批准请求必须带上（itemId、partId、toolUseId 或 Codex itemId、规范化参数的 sha256），摘要对不上就拒绝，防止 harness 撤回后换参数重发时继承批准。
- 焦点在列表上时冻结排序，列表变化后 750 ms 内 `a` 无效；高风险工具类（shell、网络、受保护路径、cwd 之外的写入）要键入确认或长按确认。
- toast 和摘要里永远不放「允许」按钮。
- 有测试证明：通过 MCP 试图解决审批会被拒绝。
- 任何地方都不使用 bypass 标志，也不使用 `approval: never` 的预设。
- **policy 告警**：
  - 自有乐章出现 bypass / `approval: never`：P0（按设计不该发生）。
  - 只读会话：Claude transcript 里的 bypass `permissionMode`（M0）；DSH 会话的权限投影和 DS-Bot `state.json` 的 `bots[].permission` 出现 `danger-full-access` 或 `never`（M2）。每个会话或 bot 只生成一条 P2（去重），Tuning 顶部常驻显示「N 个 bypass / 无审批会话：它们在能力上等同于你」。

### 10.10 Desired vs applied（期望值与实际值）

每次修改模型或权限（`setModel`、`setPermissionMode`、`set_config_option`）后，Orchestra 都回读实际值，有漂移就显示出来 [bot impl 8]。这正是你在 DS-Bot 里遇到的权限竞态 bug 的教训。

DSH 的权限预设不能经 ACP 修改：`set_config_option` 只覆盖 `model` 和 `reasoning_effort` [核验]，所以只回读这两项。预设由 host 启动时的配置决定；host 启动后用一次受控工具调用探测实际生效的预设（例如向工作区外写文件的金丝雀命令应当产生审批请求）。

### 10.11 凭据与 UI 安全

**读取白名单**（默认拒绝）：各数据源只允许读这些文件——`projects/**/*.jsonl`、`sessions/<数字>.json`、`**/subagents/**`、`state_5.sqlite`（快照）、`sessions/**/rollout-*.jsonl.zst`、`session.v4.jsonl.zstd`、`storages/session_projcache`、DS-Bot 的 `state.json` / `inflight.json` / `usage.sqlite`、dsh-tui 的 `session-mounts.json` / `servers.json`。其余文件，包括 `*.key`、`*credentials*`、`auth.json`、`.claude.json`、`*.bak*`、`watchdog*.log`、`.env*`，一律由统一的 fs 封装拒绝，并有单元测试覆盖。这些文件在本机确实存在 [核验：仅文件名]。

**粘贴的 `/connect` URL**：收到后立刻用 `interactions=none` 换成 cookie，cookie 只放内存，token 当场丢弃、不落库；守护进程重启后需要重新粘贴（watchdog 每次重启宿主 token 也会失效，核查时 3080 端口上没有任何进程在监听 [core]）。所有日志和片段里的 `token=` 一律替换为 `***`。DS-Bot `/api/bot` 所需的 `interactions` 级别在 M4 验证。

**UI 鉴权**（评审补充；替换"复用 tonghuashun 守卫"的旧方案）：
1. launch token 永不落盘、不进 argv、不进日志、不进 toast 或 URL。首次配对时，守护进程在自己的控制台打印 8 位一次性配对码，由你在页面输入；随后服务端下发 HttpOnly + SameSite=Strict 的 host-only cookie（不设 Domain）。
2. UI 只在 `http://orchestra.localhost:<port>` 提供（浏览器把 `*.localhost` 解析到回环，调研之外的知识），Host 白名单只放这一个值。这样 cookie 不会发给 agent 在 `127.0.0.1` 或 `localhost` 上起的 dev server。
3. 所有变更操作只接受 POST，必须带与会话绑定的 `X-Orchestra-CSRF` 头；Origin 缺失或不完全相等时一律拒绝。不能单独依赖 SameSite（`localhost:5173` 与 `orchestra.localhost` 可能被视为同站），以 Origin 精确匹配加 CSRF 头为准。
4. 人类动词（allow / deny / resolve / kill / 受保护宿主确认）只挂在 UI 监听器上。agent 侧走独立的 named pipe 路由表，物理上没有这些路由。
5. orchestrad 检测到自己以提升权限运行就拒绝启动。
6. **残余风险，明示**：同一 Windows 用户下、拥有无审批 shell 的会话（任何 bypass 会话）在能力上等同于你，它可以读你的文件、模拟你的输入。Orchestra 不假装能防住它，只在 Tuning 顶部常驻显示数量（§10.9）。

**opt-in 片段**：hooks / MCP 片段由你自己从界面上复制粘贴；粘贴后重新建立零写审计的基线。`PermissionRequest` hook 要先通过 fail-through 测试才会提供。

### 10.12 默认参数一览

| 参数 | 默认 | 来源 / 状态 |
|---|---|---|
| 跳数上限 | 4 | 综合稿 |
| 每 root 转发上限 | 20 | （假设） |
| 每 Work 截止 | 30 min → `timedOut` InboxItem | 综合稿 |
| 审批超时 | 30 min → deny；专注模式下暂停计时 | （假设，§17 Q4） |
| 审批按键冻结 | 列表变化后 750 ms | 评审 |
| 房间转发上限 | members × 3 | [bot] |
| 打回上限 | N = 3 | 综合稿 |
| 待审上限 | 每项目 3 条（M4，只约束 Maestro 派活） | （假设） |
| 死循环判据 | ≥5 次 / 120 s；DSH 精确重复以原生第 8 次提醒为界 | 综合稿 / 评审 |
| 死循环响应 | ≤10 s 出 P0 | R07 |
| 预算预警 | 80% | [own] |
| 每日 CNY 上限 | 每项目 20，Maestro 2 | （假设，§17 Q3） |
| agent 创建的条目 | 默认 P3；每乐手每天 ≤5 个决策、≤10 个提醒 | 评审 |
| 乐章轮换阈值 | 上下文压力 0.8 | [bot] |
| 亲和滞回 | 冷却 300 s，1500 bps | [own] |
| Wilson 门 | 20 样本，下界 0.8 | [own] |
| shadow → active | 最近 50 条一致率 ≥80% + blocked→noticed 中位 <2 min | （假设，§17 Q11） |
| `orchestra_wait` 超时 | ≤600000 ms | 综合稿 |
| 消息体 | ≤64 KiB | [req] |
| 事件片段 | ≤2 KB，三层脱敏，TTL 14 天 | 综合稿 / 评审 |
| `state_5` 快照轮询 | ≥2 s | 评审 |
| Codex 实时解码器 | 最近 10 min 修改的文件，最多 8 个 | 评审 |
| "可能在等你"静默阈值 | 工具调用发出后 20 s（S5 无等待信号时） | 评审 |
| 摘要周期 | 30 min | 综合稿 |
| 闲置乐章释放 | N 分钟（待定） | 综合稿 |
| DSH 原生激活树上限 | 8（私有 home 设为 `perModel`） | [core] |

---

## 11. 界面设计

### 11.1 屏幕清单

| 屏幕 | 用途 | 里程碑 |
|---|---|---|
| **Program（首页）** | 跨项目注意力收件箱 | M0（行内回复在 M1，baton bar 在 M4） |
| **乐手页** | 每个自有乐手一页：对话（默认标签）+ 档案卡；新建乐手向导；交还原生（§11.7） | M1 |
| **Stage** | 乐团舞台图：项目、声部、乐手、分身、谱架 | M2 |
| **Score** | 泳道时间线、回放、健康图表 | M3（AND-join 视图在 M5） |
| **Ledger** | token 与 CNY 的 K 线、governor 计量 | M2 |
| **Decision board** | 待定与已定决策、ADR 导出、注入新乐章 | M1（陈旧注释探针在 M5） |
| **Rooms** | 群聊 | M3 |
| **Tuning** | 能力登记表、版本钉与漂移、粘贴的 connect URL、opt-in 片段、上游台账、bypass 数量、勿扰状态 | M0（静态版），M2 起完整 |
| **私有 DSH 控制台**（可选） | 自有 DSH 乐手的原生 DSH 界面 | M2（可选） |

### 11.2 首页 Program：注意力收件箱

**分组**（从上到下）：
1. **Fermatas（需要你）**：审批、提问、决策。
2. **Wrong notes（出错了）**：runaway、failed、orphan、polling、bounce、policy。
3. **Ready for review（待审）**。
4. **Reminders（提醒）**。

（本文补充）two-writers、flood 归入 Wrong notes；route-ask、unknown-outcome、timedOut 归入 Fermatas。

**每一行**显示项目 chip、harness 颜色、所有权徽标和存在时长。M0 只显示 observed；foreign-held 徽标从 M2 起显示（它依赖 `session-mounts.json` 和 DS-Bot `state.lock` 两个数据源）。Peek 显示最近的事件和最后一段助手文本（只当纯文本显示）。owned 的条目可以直接在行内回复，完整对话在乐手页。M4 起顶部是 baton bar。

```
[ / baton: 对 Maestro 说话，或 @乐手 / @声部 / @项目 ...................... ]   focus: shop-web
--------------------------------------------------------------------------------------------
FERMATAS                                                                               3
 P1  [shop-web]  white  owned     Aiko 请求执行 pnpm test:e2e          2m   a 允许 / x 拒绝
 P1  [api-core]  blue   owned     Ren 问：分页用 cursor 还是 offset？  9m   d 转为 Decision
 P2  [shop-web]  --     decision  前端框架：Next / Remix / Vite SPA     1d   o 打开
WRONG NOTES                                                                            1
 P0  [api-core]  orange observed  Kaito 的子代理 grep x7 / 120s，RSS 3.1 GB   40s   K 刹车
READY FOR REVIEW                                                                       2
REMINDERS                                                                              1
--------------------------------------------------------------------------------------------
p peek（最近事件 + 最后一段助手文本）   o 打开   s 稍后   r 提醒   f 专注模式
```

**通知分级**（本文建议，待你确认，§17 Q10）：

| 级别 | 典型条目 | 通知方式 |
|---|---|---|
| P0 | runaway、two-writers、自有乐章的 policy | 立即通知；专注模式下也不静音；标签页标题和图标闪烁并播放声音 |
| P1 | approval、question、unknown-outcome、timedOut；你自己设的到点 reminder | 通知；专注模式下其它项目的 P1 只进收件箱（审批的特殊规则见下） |
| P2 | decision、failure、orphan、bounce、polling、stale-task、route-ask、observed 的 policy、flood | 只进收件箱，汇入 30 分钟摘要 |
| P3 | ready-for-review；agent 创建的提醒和决策 | 只进收件箱，汇入摘要 |

- **通知通道**：首选 UI 页面调用浏览器 Notification API；没有 SSE 客户端在线时退回 PowerShell 5.1 WinRT toast（文本 XML 转义后经 stdin 传入；点击用 `activationType="protocol"` 打开 `http://orchestra.localhost:<port>/#/item/<id>`，URL 里不带 token）；M2 起另加 `herdr notification show`。Tuning 显示当前是否处于 Windows 勿扰或专注时段（它会压住系统通知）。
- 去重键（`dedupKey`）防止同一件事反复弹窗。
- **专注模式（`f`，M2）**静音其它项目的非 P0 通知，但审批例外：
  - 被静音项目的审批暂停超时计时，退出专注模式后才开始计 30 min；
  - 离超时只剩 5 min 时，即使在专注模式下也升级为一次通知；
  - 退出专注模式时先弹出「专注期间积压的审批 N 条」。
- 提醒必须在 ±5 s 内触发，并且重启后不丢失。验收以"5 s 内提交通知"为准，不承诺"5 s 内可见"。

### 11.3 Stage：乐团隐喻

**参考图中的元素 → Orchestra 里的含义**

| 参考图元素 | 在 Orchestra 里是什么 | 界面表现 | 数据来源 |
|---|---|---|---|
| 舞台中央手持指挥棒的指挥家 | 你；M4 起加上常驻指挥家 Maestro | 舞台前方的指挥台。M2–M3 只站「你」，显示收件箱计数和 fermata 数；M4 起 Maestro 登台，指挥棒 = 顶部 baton bar（`/`），旁边是每次路由的理由 chip | 收件箱；RouteDecision（§9） |
| 左声部：白发竖琴手（主奏） | Claude Code 的主奏乐手（白色系） | 大头像 + 乐器图标 + 所有权徽标 | Claude registry / SDK 驱动 |
| 左声部：一群白发 Q 版分身吹长笛、拉小提琴 | 这个 Claude 乐手派出的 subagent（分身），继承主奏的发色 | 小头像排在主奏身后，脚下一圈主奏的名牌色；实心 = running，半透明 = inactive，幽灵 = orphan | `parent_tool_use_id`、`SDKTask*`、`subagents/*.meta.json`（`spawnDepth`） |
| 右声部：橙发小提琴手（主奏） | Codex 的主奏乐手（橙色系） | 同上 | `state_5.sqlite threads` / app-server 驱动 |
| 右声部：一群橙发 Q 版分身敲定音鼓、拉大提琴 | Codex 的子代理分身 | 同上 | `collabAgentToolCall`、`subAgentActivity`、`thread_spawn_edges` |
| 中间：一群蓝发 Q 版分身吹单簧管、小号 | DSH 声部：Agent Team 的 teammate 和 subagent；隐式 Lead（根会话）坐首席 [core]。M4 起 DS-Bot 团队也作为一个声部，Chief 任声部首席 | 蓝色分身群，首席坐第一排 | DSH v4 日志 `subagent/catalog\|descriptor`、`team/*`；DS-Bot 文件 |
| 各种不同的乐器 | 权限与风险等级（见下方图例），不是随意的角色 | 乐器小图标 | 工具调用类别 + 权限预设 + `agentType` / `agent_role` / DSH descriptor |
| 每位演奏者面前的谱架 | 这个乐手或分身当前的 Task、todo 或 goal，加完成标准 | 谱架上显示任务标题和 done criteria；翻页 = 进度 | Task、`todo/write`、`goal/change`、`team_task_*` |
| 同声部的分身与主奏同一发色 | 血缘色（lineage hue） | 分身颜色永远跟随主奏；同一 harness 的多个主奏在同一色系里分深浅（例如白、银、铂金） | `Musician.lineageHue` |

**乐器图例**（本文的设计选择）：harness 已经由声部位置和发色表示，所以乐器不再重复表达 harness，而是表达风险。

| 乐器 | 含义 | 典型 |
|---|---|---|
| 木管（长笛、单簧管） | 只读探索 | Explore、调研 |
| 弦乐（竖琴、小提琴、大提琴） | 会写代码 | worker、主奏 |
| 打击乐（定音鼓） | 跑 shell 或测试 | grep 死循环、e2e 都在这一类，最常出「错音」 |
| 铜管（小号） | 审查、打回 | reviewer |

**其余隐喻元素**（来自 [req] 与综合稿）：

| 隐喻 | 界面元素 | 里程碑 |
|---|---|---|
| 舞台横条（lanes） | 项目；总览模式下每个项目一条 | M2 |
| 声部（sections） | harness 分组；M3 起也可以是 Room | M2 / M3 |
| 提示线（cue lines） | 进行中的 Exchange，带动画 | M2（边从 M0 起记录） |
| 节拍器（metronome） | governor 队列深度 | M2 |
| 力度记号（pp–ff） | 燃烧速率 sparkline | M2 |
| 延长记号（fermata）徽标 | 需要你 | M0（收件箱）/ M2（舞台） |
| 被静音、头顶红色"错音" | 死循环 | M0 告警 / M2 自动处理 |
| 场务（stagehand）按钮 | kill-tree 刹车 / 回收器 | M0 / M2 |
| 状态行 | 例如 `team 2/3 running · tasks 3/7` | M2 |
| 休止符 | `orchestra_wait` / join；长时间休止却没有 join = 轮询嫌疑 | M3 |
| 首席小提琴（concertmaster） | reviewer 角色 + 打回计数 | M3 |
| 调音 | Tuning 页（能力、版本钉、漂移）；上下文预热（ADR、记忆加载、陈旧上下文检查） | M0 / M5 |
| 乐谱库 | 预设与 Skill Cluster 登记（R18） | 未排期 |
| 节目单（program）与中场休息 | 首页收件箱 + 提醒；中场 = 30 分钟摘要 | M0 / M2 |
| 总谱（score）与反复记号 | 时间线与回放；反复记号 = 带上限的循环 | M3 / M5 |
| 彩排 | 零 token 评估 | M1 起 |
| 返场 | 回放或复跑 ×N（repro） | M1（QA 模板）/ M5 |
| 舞台边界 | 沙箱与写入范围；乐手走下舞台 = 越界告警 | M2 |

**Stage 草图**（M2–M3，单个项目）：

```
 Stage · shop-web                               status: team 2/3 running · tasks 3/7
                                                metronome: queue 2   dynamics: ▁▃▆█▅

 LEFT  Claude (white)          CENTER  DSH (blue)               RIGHT  Codex (orange)
 [stand] Aiko  harp  *owned    [stand] Lead (root session)      [stand] Kaito  violin  observed
   [stand] flute   Explore ◉   [stand] clarinet  explore  ◉       [stand] cello    worker ◉
   [stand] timpani test    ◉   [stand] violin    worker   ◉       [stand] trumpet  review ◌
   ( ghost )       orphan  ◌   [stand] trumpet   review   ◌
 [stand] Mio   timpani *owned (QA, silver)

            ~~~~~~~~~~~~~ cue lines: live exchanges ~~~~~~~~~~~~~

                         [ podium: you · fermata 3 · inbox 7 ]   （M4 起：you + Maestro）
                                                         [ K stagehand: kill-tree ]
```

### 11.4 Score

泳道时间线：exchange、派生、settle 各占一条；带回放拖动条、按边类型过滤，以及健康图表（rounds-to-done、轮询比、打回次数、孤儿数、每小时干预次数）。**只看不编辑**，没有图编辑器。M3 起 `orchestra_report` 的工作日志与事件关联显示（R15）。M5 加入只读的 AND-join / 循环视图（R16）。

### 11.5 Ledger

按乐手、按模型显示 token 和 CNY 的 K 线（tonghuashun 的 `deriveCandles`），旁边是 governor 计量。未知用量显示为"未知"，不按 0 计。

### 11.6 Decision board

- 显示待定和已定的决策。
- "Export ADR" 写出 `docs/decisions/NNNN-*.md`，附带 git HEAD，**只能由你点击**（M1）。
- **已定决策注入 v0（M1）**：每个新乐章的第一条消息附上本项目已定 Decision 的摘要（Decision 编号、你选中的选项、你亲手写的理由、git HEAD）。agent 写的题干只作为数据引用，不以你的口吻注入。
- 对你在原生 CLI 里的会话，建议你自己在 CLAUDE.md / AGENTS.md 里加一行「以 `docs/decisions/` 为准」。这一行由你手动添加，不破坏零写入。
- M5：陈旧注释探针和冲突标记，用来验证注入是否真的有效（R12）。

### 11.7 乐手页、新建向导与交还原生（M1）

**乐手页**：每个自有乐手一页，两个标签。
- **对话**（默认）：流式显示当前乐章的助手文本和工具调用（可折叠）、改动文件列表（链接到 git diff）、收发过的 A2A 信封（带回执状态和 taint 标记）；底部是输入框，可切换 steer（插进当前回合）或 queue（排到下一回合）；顶部显示上下文压力和当日花费。所有内容按 §5.3 的渲染规则显示。
- **档案**：人设、乐章历史与交接笔记、desired vs applied、journal、账本。

**新建乐手向导**：项目 → harness（Claude / DSH；Codex 在 M4）→ 权限预设（只读 / 可写）→ 人设模板（前端、后端、QA、调研、主代理）→ 目录或 worktree（worktree 在 M3）。QA 模板默认只读预设 + 测试命令白名单（例如 `pnpm test:e2e`），可以用 `orchestra_remind` 定时触发，用 `orchestra_report` 回报失败率和失败日志路径。

**交还原生**：结束当前乐章后一键交还。Claude 乐章给出可复制的 `claude --resume <id>`（自有 Claude 沿用你的 `CLAUDE_CONFIG_DIR` 时可用，Q8），该会话随之降为 observed，`endReason = handed-back`。DSH 乐章在私有 DSH 控制台（M2，可选）里继续。

**验收**：从新建乐手到在对话页看到第一段流式输出 ≤30 s（假设）。

### 11.8 其它屏幕

- **Rooms**（M3）：@、`[PASS]`、转发上限的 Continue 按钮。
- **Tuning**：能力登记表、版本钉与漂移、粘贴的 connect URL（只显示是否有效，不显示 token）、opt-in 片段、上游台账（§12.3）、bypass / 无审批会话数量、勿扰状态。
- **私有 DSH 控制台**（可选，M2）：procguard 拉起 `DSH_HOME=<Orchestra 私有 home> dsh web --port 3199`，token 取自该子进程的 stdout，只放内存。对自有 DSH 乐手，`o` 打开该控制台里的会话页。你在这里直接回答的审批，在 Orchestra 队列里以 `withdrawn(answered-in-native-ui)` 结案。它也是安装 BSB、dsh-context 和 Orchestra 只读 tab 的安全位置。

### 11.9 快捷键

| 键 | 动作 |
|---|---|
| `j` / `k` | 上下移动 |
| `o` | 打开：活着的观察会话切到它的窗口；自有乐手打开乐手页；已退出的会话给出可复制的 resume 命令 |
| `p` | Peek |
| `s` | 稍后（snooze） |
| `r` | 设提醒 |
| `d` | 转为 Decision |
| `a` / `x` | 允许 / 拒绝自有会话的审批；列表变化后 750 ms 内无效；高风险工具类需要键入确认 |
| `m` | 给某个乐手发消息（记成派活标签） |
| `/` | baton bar（M4） |
| `f` | 专注模式（M2；静音其它项目的非 P0，审批暂停计时） |
| `K` | kill-tree |
| `g s` / `g p` / `g l` | 跳到 Stage / Program / Ledger |

---

## 12. 与 DSH 生态的集成与许可证计划

### 12.1 集成

| 生态组件 | 怎么用 | 何时 | 边界与前提 |
|---|---|---|---|
| **Orchestra bundle（"bridge"）** | 通过 `systemPrompt.section` 注入人设；转发 `subagent/start\|end`；以非 user 来源（`kind:'orchestra', form:'relay'`）投递；净室实现的 `wait_subagent(ids[], timeout_ms)`（只借鉴 dsh-apollo 的调用形状，不阅读其代码；每个 id 返回 settled\|timedOut\|aborted\|notStarted）；后代回收（父回合结束或被中断时，对 `listDescendants` 中仍在运行的后代级联中断，用 `subagent/end` 核对）；之后可以在 `tools/pre-execute` 拦截派生 | M3（S2 选 B 时投递部分提前到 M1） | **只**在 Orchestra 私有的 `DSH_HOME` 里通过 `$DSH_HOME/cordis.patch.yml` 加载；声明 `package.json#dsh`，`engines.dsh` 钉死确切版本，不用 `dsh-plugin.json`；每次 `await` 之后重新获取服务 [core][own]；先在隔离 home + 3099 / 3199 端口上验证；除非你 opt-in，否则不进 live `web` profile（那里 DS-Bot 的 `approvals.js` 已经在拦截 `approval/request` [bot]） |
| **私有 DSH 控制台** | 在 Orchestra 私有 home 上跑 `dsh web --port 3199`，给自有 DSH 乐手原生界面 | M2（可选） | token 只放内存；orchestrad 只为只读 GET 端点给它单独发一个只读 token，不共享 UI cookie |
| **BSB tab** | 只读的 `registerTab`，只通过 loopback 拉取守护进程的数据 | M3 起可在私有控制台试装（可选）；装进 live profile 需 Q5a opt-in | BSB 目前没有在任何 profile 中启用，只有 `.pnpm` 缓存里的旧副本 [核验]；不使用 BSB 的任何 fs 路由 |
| **dsh-context** | 深链到单会话的上下文视图；共享 fixture | 本机未安装 [核验]。M0 只提供 DSH 原生深链（你粘贴的 `/connect` URL 下的会话页）；dsh-context 深链要等你在 live profile（Q5a）或私有控制台里安装它。M3（可选）：与它对齐边类型（relay、mailbox delivery、spawn、settle），把 Orchestra 的 DSH v4 黄金 fixture 和可观测性得分测试以 PR 形式提供给它，并邀请作者担任 P2 评审 | 支持 0.2.0-rc.2 到 0.2.1 这条线 [land]；两个独立解析器会漂移，所以尽量共用 fixture |
| **tonghuashun** | 提取 `normalizeUsage`、OHLC 指标、`acquireLock` / `writeAtomic` | M0 / M2 | MIT，你自己的代码；`http.js` 的 loopback 守卫在请求不带 Origin 时会放行，不能当鉴权用 [核验] |
| **DS-Bot** | M2 起只读遥测；M4 起把一个 DS-Bot 团队当作一个**声部**，Chief 任首席，通过 `POST /api/bot` 访问 | M2 / M4 | 0.1.7+fork.1 源码已核对：有 `state`、`send`、`approval-answer`、`stop-member-work`、`room-progress`、`usage`；没有 `room-continue`、`run-stats`；`send` 每次生成新的 requestId，所以非幂等 [核验-源码]。Orchestra 永不调用 `approval-answer`、永不写 `state.json`。`/api/bot` 需要 DSH web 会话 cookie，来源同样是你粘贴的 `/connect` URL（所需的 `interactions` 级别在 M4 验证）。建议向上游提议让 `state` 返回 API 版本号，作为契约检查点 |
| **herdr** | M2 起 `notification show`；`agent list/get` 作为数据源；M4 起 `agent prompt` | M2 / M4 | 只信任 `custom:` 自报；状态映射见 §6.2 |
| **dsh-TUI** | vendor 文件清单见 §7.4（先上游、后补丁）；尊重 `session-mounts.json`；inject 需人工确认。Orchestra 的 DSH 客户端按 `AgentBackend` 接口编写，可作为 dsh-TUI 预留的 `acp:` 后端回馈上游（可选） | M0 / M1 / M4 | M3（可选，不在关键路径）向上游提 RFC / PR：① inject pipe 首行加认证 token（仿 Claude 的 `{"type":"auth"}`）；② 只读的 AgentEvent NDJSON 导出管道（`permission.request`、`question.request`、`turn.end`、`subagent.*`），通过 `servers.json` 发现。合并后 dsh-TUI 会话升级为高置信度的 observed 源，审批等待可以进收件箱（仍只深链，不远程批准） |
| **adaptive-router** | 分叉 `router-core`；提取 `session-routing`、计量 `Ledger`、恢复用的 `ExecutionRegistry` | M2 / M4 | 没有 LICENSE 文件 [own]，提取前先补上 |
| **hermes-agent** | 只借鉴形状：`mcp_serve.py` 的工具形状、ACP 客户端骨架 | M1 | 去掉自动 `allow_once` |
| **社区已有的相近项目** | dsh-flowglass（会话流视图，含子代理分支）、dsh-sentinel（按条件唤醒 agent）、dsh-session-search（索引 DSH、Codex、Claude 三家会话）[land] | 动手做 Score、发给乐手的提醒、全文检索之前 | 先评估能否复用或对接，再决定自己写 |

### 12.2 许可证

| 来源 | 许可证 | 复用方式 | 义务 |
|---|---|---|---|
| dsh-TUI | MIT（© 2026 chimney）[tui] | vendor 源码（尽量按上游 commit 零 diff） | 保留版权声明；剥掉凭据和订阅 token 注入 |
| DS-Bot | Apache-2.0 [bot] | `home-lock`、`requests`、`mentions`、steward 的模式 | 保留 LICENSE 与 NOTICE，说明修改 |
| `@deepseek-ai/dsh-win32-process` | MIT [核验] | procguard "挂起创建 → 分配 Job → 恢复"顺序的参考设计；S4 的备选实现 | 若 vendor 则保留版权声明 |
| adaptive-router | 无 LICENSE 文件 [own] | 分叉 / 提取 | 先补 LICENSE（你自己的代码） |
| tonghuashun | MIT（你自己的）[own] | 提取函数 | 保留声明 |
| hermes-agent | MIT [own] | 只借鉴形状 | — |
| dsh-apollo | GPL-3.0 [land] | **只借鉴设计**（`wait_subagent` 的调用形状），净室实现 | 不复制、不阅读代码 |
| CLIProxyAPI | — | **不使用** | 可能违反服务商条款 [own] |

Orchestra 自身的许可证在 M0 定（§17 Q9，建议 MIT，附 NOTICE），与 vendored 的 dsh-TUI（MIT）和借鉴 DS-Bot（Apache-2.0）的方式兼容。

### 12.3 上游台账与社区

- **上游台账**：下列检测器触发时，用零 token 彩排生成最小复现，记入 Tuning 的「上游台账」（`docs/upstream/NNNN-*.md`），由你决定是否提交到 deepseek-ai/deepseek-harness：孤儿孙代理、`ACTIVATION_LIMIT_REACHED` 不排队、任务 owner 不释放、`list_agents` 的范围、按 profile 的团队开关、`repeat-tool-reminder` 不做归一化参数匹配。每个里程碑预算 0.5 天。提交前先对照当前钉死版本的 dsh-base 组合核实（例如 0.2.1-rc.2 的 dsh-base 已经挂载 `list-agents` [核验]）。
- **你自己的上游 PR**（建议，由你提交）：dsh-TUI 的 bypass 选项与凭据注入接口（M1 第 1 周，§7.4）；DS-Bot 的 `fix/permission-switch-race`（M0–M1，§17 Q5b）。
- **可选的社区产出**（不在关键路径，取决于 Q9）：把净室 `wait_subagent` 和后代回收器作为独立包（MIT 或 Apache-2.0）发布到 DSH 群，标注「best-effort，钉死 DSH 版本线」，Orchestra 不依赖它们被采纳；M2 起提供只读的 `orchestra observe --dsh` 健康报告（轮询比、打回次数、rounds-to-done、孤儿、`list_agents` 调用次数），群友可以对自己的 `~/.dsh` 运行；征集经过脱敏的多版本 fixture 进入黄金语料。

---

## 13. 里程碑 M0–M5

### 13.1 总览

```
周:  1  2  3  4 | 5  6  7  8 | 9 10 11 12 | 13 14 15 16 | 17 18 19 20 | 21 22 23 24 25
     M0         | M1         | M2         | M3          | M4          | M5
     节目单      | 两位乐手    | 安全舞台    | 声部与总谱   | 指挥家       | 溯源与生态
```

| 里程碑 | 周 | 工期 | 交付后你得到什么 |
|---|---|---|---|
| M0 "The Program"（节目单） | 1–4 | 约 3.5 周（15–18 个工作日） | 只读的跨项目收件箱、一次性提醒、死循环告警（Claude、DSH）、刹车、本机 UI 安全 |
| M1 "Two musicians talk"（两位乐手对话） | 5–8 | 约 4 周（第 1 周含 S2、S3） | 新建 Claude / DSH 乐手、乐手页、乐手互发消息、审批集中处理、决策板 + ADR + 注入、QA 乐手模板、派活标签 |
| M2 "Safe Stage"（安全舞台） | 9–12 | 约 4 周 | 舞台图、账本、对自有会话强制限流与回收、Codex 实时跟踪、专注模式、摘要、周期提醒、DS-Bot 只读 |
| M3 "Sections & Score"（声部与总谱） | 13–16 | 约 4 周 | 委托树、群聊、任务板、时间线回放、worktree、私有 home bundle |
| M4 "Maestro"（指挥家） | 17–20 | 约 4 周 | 指挥家与 AutoRoute（先 shadow），Codex 驱动（过门槛的话），DS-Bot 声部 |
| M5 "Provenance & ecosystem"（溯源与生态） | 21–25 | 约 5 周 | 陈旧注释探针、记忆范围、repro bundle、导出、成本报价、A2A 1.0 网关 |

M3 和 M5 的范围可以顺延，不会卡住 A2A。每个里程碑都有削减顺序。

### 13.2 M0 "The Program"（第 1–4 周）

M0 按评审的工作量估算重新定界（原范围约 35–45 个工作日）。S2、S3 只服务 M1，移到 M1 第 1 周；S6 与 DS-Bot 源一起移到 M2。如果 M0 提前完成，先在 M0 末尾跑 S2，尽早暴露 DSH 风险。

**第 1–3 天：spike，每个都给出 go / no-go**

| Spike | 要回答的问题 | go 判据 | no-go 时的后备 |
|---|---|---|---|
| **S1-DSH** 按帧 tail | DSH v4 日志由许多独立的 zstd 帧组成（每帧 83 B–62 KB，带校验，windowLog 21）[核验]。用约 40 行的帧遍历器，每个完整帧调一次 `zstdDecompressSync`，游标就是下一帧的字节偏移；测 DSH 的 flush 节奏 | 延迟 ≤2 s | `storages/session_projcache`、只读 web attach；验收改为"有文档记录的后备延迟" |
| **S1-Codex** 单帧 rollout | Codex rollout 每个文件只有一个 zstd 帧（最大的 142 MB）[核验]，需要常驻的流式解码器，重启后要从字节 0 重新解码。在一个正在运行的 Codex 会话上测：每写一条事件，完整 block 能否被解出来？ | 能逐事件解码，延迟 ≤3 s | M0 本来就只轮询 `state_5`；结果只决定 M2 的实时 tail 做不做 |
| **S4** procguard | 用系统自带的 `csc.exe`（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` [核验]）编译约 300 行的 C# helper，作为常驻 JSON-lines 进程，提供 5 个命令：`run-in-job`（建 Job、KILL_ON_JOB_CLOSE、不设 `BREAKAWAY_OK`；以 CREATE_SUSPENDED 启动 → 加入 Job → 恢复；继承 stdio）、`snapshot`（Toolhelp32：pid、ppid、映像名、创建时间、工作集、命令行）、`kill-job`、`kill-tree{pid, createTime}`、`pipe-client-pid` | 杀掉 orchestrad 后，孙进程 `ping -t` 和 agent 启动的 dev server 都退出；DSH 沙箱内部的嵌套 Job 也随外层结束；Job 记账显示活动进程为 0 | 备选：vendored `@deepseek-ai/dsh-win32-process`（MIT，Koffi）的挂起→分配→恢复原语做 Job，进程快照另走慢路径。最后的后备：登记 pid + 创建时间，重启时清扫，并在 Tuning 里提示孤儿风险。不用 PowerShell Add-Type 常驻进程（启动约 1 s、约 60 MB，且先 spawn 再入 Job 之间有竞态） |
| **S5** Claude 根目录与等待信号 | 枚举所有 `CLAUDE_CONFIG_DIR` 根目录；人为挂起一个审批，记录这段时间 registry 的 `status` / `statusUpdatedAt`、jsonl 的变化，以及 `claude agents --json` 是否有 `waitingFor` 之类的字段、每次调用耗时 | 根目录清单完整；存在可用的等待信号 | 没有等待信号时：工具调用发出后静默超过 20 s，生成一条低置信的「可能在等你」条目；Q6 从"偏好题"变成"可行性题"（≤5 s 只能靠 hooks） |

活跃文件对已打开的句柄每 ≤1 s 做一次 `fstat` 轮询，不依赖 `fs.watch`（Windows 上被占用文件的目录项更新可能滞后，调研之外，S1 顺带验证）。

**交付物**
- 守护进程：锁、`node:sqlite` 存储、journal（只链摘要）、可清除片段表、写围栏、读取白名单。
- UI 鉴权：配对码、host-only cookie、CSRF、CSP、渲染规则（§5.3、§10.11）。
- Claude 源（多根目录）；DSH 帧级 tail（两种目录名）；Codex 只用 `state_5` 快照轮询（最近 N 天的线程；历史 rollout 只读元数据）。
- 归一化器和状态机；观察到的边作为 Event 记录。
- 收件箱 Program（`j` / `k` / `o` / `p` / `s` / `r`）；一次性提醒；浏览器通知加 PowerShell toast 后备。
- runaway v0（Claude、DSH）、RSS 采样、procguard 进程树刹车（§10.5 的安全遍历与受保护名单）。
- policy v0：Claude transcript 里的 bypass `permissionMode`（只告警）。
- 脱敏后的 fixture 和回放（合成或清洗；gitignore + gitleaks）。
- 静态版 Tuning。
- Orchestra 的许可证（Q9）。

**验收**
- 黄金回放（Claude、DSH、Codex `state_5` 快照）产生的状态转换与预期**完全一致**。
- 活跃会话在 ≤2 s（Claude、DSH）内出现，或者在有文档记录的后备延迟内出现；Codex 在一个轮询周期 + 2 s 内出现。
- Claude 的"需要输入"：S5 找到等待信号时，不装 hooks ≤5 s、装了 hooks ≤2 s 内生成收件箱条目并提交通知；找不到时降级为 20 s 静默的低置信条目，以 hooks 方案为准。
- 一次性提醒在 ±5 s 内触发，并且守护进程重启后不丢。
- 实时追加的 grep×5 fixture（Claude、DSH）在 ≤10 s 内触发 P0。
- 刹车能杀掉一个假进程树；对受保护宿主，没有键入确认就拒绝执行；PID 复用的边被剪掉。
- **零写入**：① 写围栏 + CI grep；② 一次 30 分钟实跑，用 Procmon 只盯 orchestrad 及其子孙进程，过滤 CreateFile（写访问）、WriteFile、SetInformation，在 `C:\Users\Calx\.rec\claude\accounts\53087\config`（以及找到的所有根目录）、`~/.claude`、`~/.codex`、`~/.dsh`（含 `bot/`）、`~/.dsh-tui` 下的命中数为 0；③ 哈希 diff 只在 harness 全部停掉后、对冻结复制出来的 fixture 树执行。
- **UI 安全**：用 curl 不带 cookie 调 approve / kill 返回 403；从 `127.0.0.1:5173` 页面发起 fetch 返回 403；注入 `<img onerror>` 标题和 OSC 52 序列的 fixture 不会执行，也不会写剪贴板。
- 读取白名单的单元测试：`*.key`、`*credentials*`、`auth.json`、`.claude.json`、`*.bak*`、`watchdog*.log` 全部被拒。
- Tuning 显示 `codex 0.139 < 0.144 → harness-unsupported` 和 Claude 的版本漂移。
- 20 个会话时守护进程的 RSS 只测量、记录，不设门槛。

**M0 削减顺序**（本文建议）：PowerShell toast 后备 → policy v0 → Tuning 的漂移显示 → Codex 快照轮询（Codex 推到 M2）。不能削减的：写围栏与读取白名单、UI 鉴权、收件箱、刹车、fixture。

### 13.3 M1 "Two musicians talk"（第 5–8 周）

**第 1 周：spike**

| Spike | 要回答的问题 | go 判据 | no-go 时的后备 |
|---|---|---|---|
| **S2a / S2b** 私有 DSH | 用同一张清单给候选 A（私有 `dsh --profile acp`）和候选 B（私有 `dsh web` / `runProfile()` + bundle）打分：① 以非 user 来源投递；② steer；③ 分身树可见；④ 中断单个分身；⑤ job kill；⑥ 崩溃后 `requestId` 去重或日志核对；⑦ 按会话注入 MCP，或原生调用者身份；⑧ 各预设下审批请求能到达（金丝雀命令：向工作区外写文件）；⑨ 3 个会话时的 RSS；⑩ `session/cancel` 是否停止后代、`session/close` 是否回收后代；⑪ 环境变量凭据在空凭据服务下是否生效、`env` 工具调用能否看到 key；⑫ 每乐章 token 是否出现在会话日志里；⑬ 合成后 `cordis.yml` 的快照。预算比原计划 +1 天 | 一次 prompt 跑通；`orchestra-mcp` 被调用；至少一个预设下金丝雀命令产生审批请求，进入审批队列并超时拒绝；合成配置里没有 `approval: never`。默认选 A，B 在清单上明显占优时改用 B | `approval: never` 的任何预设（含内置 Full access）对自有乐手是 no-go，不进入 §17 重新确认。没有可用预设时，M1 先交付 Claude↔Claude 的 A2A（例如 Aiko ↔ Mio），DSH 乐手顺延并在 M2 重新评估 |
| **S3** Claude 后端 | vendored 的 Claude 后端能否配合 fake SDK 运行，并在 haiku-only 守卫下真实跑通一个回合？把 `mcpServers` 从 `omit` 改为 `set`，传入 SDK 进程内服务器，Orchestra 工具能否被调用？`settingSources: []` 下 CLAUDE.md 附加段是否生效？2.1.310 的 `system/init.capabilities` 是否含 `msg_lifecycle_v1`？经 `spawnClaudeCodeProcess` 由 procguard 拉起是否正常？ | 全部通过，bypass 已关闭 | 如果 MCP 注入不通，乐手只能"收"不能"发"，由乐手页或主代理代发 |

**交付物**
- procguard 下的 `claude-sdk` 驱动（配置隔离，§7.4）和 DSH 驱动（S2 选定的候选；私有 home 组合 v1；每 host 独占 `DSH_HOME`）。
- Musician / Part 登记表（迁移建表）；**乐手页**（对话 + 档案卡 v1）；新建乐手向导；交还原生（Claude）。
- Post Office v1：规则 1、4、5、6、8，带回执；重启三阶段处理与自动核对（§8.3）；taint 与来源链（§8.5）。
- 审批队列：超时拒绝、与请求摘要绑定、按键冻结、来源链红条。
- `orchestra-mcp`：Claude 进程内、DSH named pipe + `pipe-client-pid` + token 轮换；配额。
- Decision board v1 + ADR 导出 + 已定决策注入 v0（§11.6）。
- 派活标签：RouteDecision（`mode=manual`）。
- 对自有乐手的行内回复；desired vs applied 回读（DSH 预设在 host 启动时探测）。
- QA 乐手模板。
- 零 token CI：各个 fake、mock ACP agent、bypass grep、`approval: never` 检查、受保护路径测试、自我放权测试。
- dsh-TUI 上游 PR（第 1 周提交，§7.4）。

**验收**
- Claude 乐手给 DSH 乐手发请求（S2 no-go 时是另一个 Claude 乐手），回复带着 `delivered`、`read`、`replied` 三个回执回来。
- 重复的 `requestId` 重放原回执；内容变了的同 id 被拒绝。
- 投递中途杀掉守护进程：0 次重复执行。阶段 (a) 在日志里能核对到时 0 条人工条目，核对不到时记为 `unknown` 且不重发；阶段 (b) 只恢复一次，再次被打断转为 `unknown`；阶段 (c) 按日志结算。
- 杀掉守护进程后孤儿进程为 0（含孙进程，Job 记账为 0）。
- 审批超时后被拒绝；通过 MCP 解决审批的尝试被拒绝；参数摘要对不上的批准被拒绝。
- 第 5 跳被拒绝。
- A2A 消息内容为「创建一个目标并持续推进」时，目标 DSH 乐手的 v4 日志中不出现 `goal/change`。
- 乐手写入 allow 规则或 hook 之后，下一次 Bash 调用仍然进入审批队列。
- DSH 金丝雀命令产生审批请求，进入队列并超时拒绝。
- 与本里程碑控制相关的边覆盖率 = 100%（A2A exchange 与审批），用黄金回放计分。
- 从新建乐手到在对话页看到第一段流式输出 ≤30 s（假设）。

**M1 削减顺序**：QA 乐手模板（改为手工新建）→ 已定决策注入 v0（保留 ADR 导出）→ 新建向导简化为配置文件 → DSH 驱动（退回 Claude↔Claude）。不能削减的：A2A、审批队列、乐手页的对话标签、重启三阶段处理、配置隔离。

### 13.4 M2 "Safe Stage"（第 9–12 周）

**交付物**
- 带分身树、幽灵和乐器图例的 Stage。
- Ledger。
- 对自有会话强制执行 governor（含私有 home 的 `maxActiveSubagents` 映射）。
- 对自有会话的自动暂停和回收（嵌套 Job；DSH cancel → close → resume）。
- Codex rollout 实时 tail（按 S1-Codex 的结果）+ 多版本 rollout 解析器与黄金 fixture（0.139.0、0.153.4、0.159.2、0.160.0、<0.130 降级样本）。
- S6 字段核对后的 DS-Bot 源；dsh-tui、herdr 源；foreign-held 徽标。
- 只读 web attach（粘贴即换 cookie）。
- herdr 通知；专注模式（含审批暂停计时）；30 分钟摘要；周期提醒（rrule）；Claude SDK 漂移检测。
- 完整的 policy 告警（DSH 权限投影、DS-Bot `bots[].permission`）和双写者告警。
- 可选：私有 DSH 控制台；`orchestra observe --dsh` 健康报告。

**验收**
- 分身树的数量与 `thread_spawn_edges`、`subagents/` 文件数、DSH catalog 一致。
- 孤儿在 ≤5 s 内显示为幽灵；resident / inactive 的 DSH 子代理不被误判。
- 3 倍上限的突发请求全部排队，没有崩溃。
- 自有会话里的模拟 grep 循环在 ≤10 s 内被中断（DSH：cancel 不够时 close）。
- 父会话结束后，自有孤儿为 0（DSH 经 `session/close` 回收后代）。
- Ledger 与 Codex `tokens_used`、Claude 用量之和相差 ≤±1%。
- 专注模式下，其它项目的审批不会因超时被拒绝。
- Codex 多版本黄金回放一致；<0.130 样本降级为 `unknown`。
- 与本里程碑控制相关的边覆盖率 = 100%（spawn / settle、分身树、runaway 事件）。

**M2 削减顺序**：私有 DSH 控制台 → 健康报告 → 周期提醒 → Codex rollout 实时 tail（保持 `state_5` 轮询）。

### 13.5 M3 "Sections & Score"（第 13–16 周）

**交付物**
- Work 树、暂扣回复、拒绝循环、`orchestra_wait`。
- 转发与打回上限；bounce / round 检测与 rounds-to-done 直方图（R08）。
- Rooms。
- CAS 任务板。
- 乐章轮换与 steward：轮换时开一个新乐章并附交接笔记，或者在 harness 有原生压缩时使用它（Claude / DSH 的 `compact` 能力；Codex 的 `thread/compact/start` 在 M4 Codex 驱动过门槛后启用）。对比：DS-Bot 是**关掉** DSH 的原生压缩，改写自己的 `[Checkpoint N]` [bot]。
- Score 与回放；`orchestra_report` 工作日志与事件关联（R15）。
- 按需 worktree（QA 乐手在自己的 worktree 里跑，不干扰主线）。
- 私有 home 里的 bundle：非 user 来源投递、人设段、`subagent/start|end`、`wait_subagent`、后代级联回收；host 键加入 teamMode（R25）。
- 发给乐手的提醒（`target: musician`，经 Post Office 投递、受 governor 约束、乐章轮换时随身份迁移）。
- 可选：私有控制台里的 BSB tab；与 dsh-context 对齐 fixture；dsh-TUI 上游 RFC。

**验收**
- 一个永远打回的 reviewer 在 N=3 时升级给你。
- 可观测性得分：全部边类型 100%（转发、exchange、spawn edge、subagent 派生）。
- 回放是确定性的。
- 目标 settle 后 ≤2 s 内 `wait` 返回；`wait_subagent` 对每个 id 返回正确状态。
- 父回合被中断后，自有 DSH 乐手的孙代理被级联回收。
- 以 relay 来源投递后，目标的 `repeat-tool-reminder` 计数不被清零。
- 乐章切换后身份不变。
- 模拟的轮询行为被标记出来。

### 13.6 M4 "Maestro"（第 17–20 周）

**交付物**
- Maestro、baton bar 和 AutoRoute：先 shadow，后 active（标签自 M1 起积累）。
- 待审上限。
- Codex 驱动（如果过了门槛；Q1 也可能让它提前到 M2 末）。
- 联邦：inject pipe、经核对的 `/api/bot` 声部、`herdr agent prompt`。

**验收**
- 每次路由都显示理由、置信度和 `decisionId`。
- 改派只需 1 个动作。
- 进入 active 之前满足 Q11 的门槛（默认：最近 50 条派活 shadow 一致率 ≥80%，blocked→noticed 中位 <2 min）。
- Codex 受控实跑通过；否则 Codex 保持只读。

### 13.7 M5 "Provenance & ecosystem"（第 21–25 周）

**交付物**
- 陈旧注释探针与冲突标记（注入本身在 M1）。
- 带 journal 的记忆范围。
- `read_part` 的 ACL。
- 带 AND-join 的 Score（只读）。
- repro bundle v0。
- 导出。
- 派活前的成本报价（第 8b 步）。
- 可选的 OTel GenAI 导出。
- A2A 1.0 网关（默认关闭）。

**验收**
- 陈旧注释探针中，agent 遵循 ADR（有无注入对比）。
- 记忆往返迁移，静默覆盖为 0。
- 越权读取被拒绝并记录。
- 对一个已知 flaky 的测试 rerun ×20，报告失败率，每次失败都附上 seed、环境和 trace / 录屏路径（R19）。

---

## 14. 评估方案

| # | 评估 | 方法 | 指标 / 门槛 | 何时 |
|---|---|---|---|---|
| 1 | **零 token 彩排（CI）** | `claude-fake-sdk`、`codex-fake-app-server`、mock ACP agent、DS-Bot `dev/mock-llm.mjs` | 场景：派活准确率；join 正确性（`wait` 前后的轮询调用次数）；打回上限；循环终止；孤儿清理；3×8 的突发 [req] | M1 起每次提交 |
| 2 | **黄金 fixture + 可观测性得分** | 用录制（脱敏）的会话日志喂投影 | 某项控制上线前，它直接依赖的事件类型覆盖率 100%（M1、M2 验收）；全部边类型 100%（M3）；每晚对已安装工具跑 canary | M0 起 |
| 3 | **人类注意力指标** | 从 M0 起持续采集 | blocked→noticed 的中位时间 < 2 min；每小时干预次数；项目切换次数；漏掉的提醒 = 0；每周一次过载自评（1–5） | M0 起。**用来卡 M4 的 active 路由（Q11），不卡 M1** |
| 4 | **Micro-DeepSWE** | 10–20 个分层抽样任务，每个约 1 CNY，×3 个种子 | 比较单 agent、原生 DSH 团队、带 Orchestra 守护的团队：通过率、每解决一个任务的 CNY、墙钟时间、人工介入次数，报告方差 [req] | M2 后 |
| 5 | **模型组合压力测试** | MiniMax vs DeepSeek，上限设为 4、8、16 | 失败 / 崩溃率、排队延迟、成本，据此得出每个模型的安全速度，写入 governor 的 `perModel` 默认值和私有 home 的 `maxActiveSubagents` | M2 |
| 6 | **上下文污染探针 + 记忆往返** | 埋一条与 ADR 矛盾的陈旧注释；导出→导入→比对 instruct / self / project 三层 | 遵循 ADR 的比例（有无溯源注入对比）；静默覆盖 = 0 | M5 |
| 7 | **AutoRoute** | 标注集（自 M1 起积累）+ shadow 一致率 | 标注集准确率；Q11 的门槛 | M4 |
| 8 | **安全回归**（评审补充） | 零 token CI 里的固定用例 | curl / 跨源 fetch 调人类动词 → 403；XSS 与 OSC 注入 fixture 不执行；读取白名单拒绝凭据文件；自我放权后仍进审批；`approval: never` 不出现在合成配置里；relay 投递不开启目标 | M0 起 |

每次运行还会画出健康图表：rounds-to-done 分布（集中在第 1 轮和上限两头是坏信号）、轮询比、孤儿数、reviewer 打回次数、每行有效 diff 消耗的 token [req]。

---

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 实时 zstd tail 延迟高或失败 | DSH 按帧 tail，基本确定 [核验]；Codex 是单帧文件，M0 只轮询 `state_5`，M2 再按 S1-Codex 的结果决定实时 tail；后备：projcache、web attach、自有会话的驱动事件流 |
| DSH 频繁变动（约 2 天一个版本） | 私有钉死安装；每次升级前跑契约测试并比对合成配置快照；按版本嗅探；解析失败降级为 `unknown` |
| 私有 DSH 只有 Full access（`approval: never`）能用，或凭据、沙箱 EPERM 走不通 | S2 的硬性 no-go；专用可吊销 key 经环境变量注入；逐个测试预设；退回 Claude↔Claude 的 A2A |
| ACP 投递被 DSH 记为人类输入：可开启自主目标、清零原生循环守卫和 jobs 唤醒预算 | M1 在私有 home 关闭 goal 插件；M3 bundle 以 relay 来源投递；Orchestra 自己的 runaway 检测不依赖原生守卫 |
| 守护进程崩溃留下孤儿进程或重复执行 | 嵌套 Job kill-on-close（含孙进程）；重启三阶段处理；结果不明绝不自动重发 |
| 本机其它进程（含 bypass 会话、agent 起的 dev server）调用 UI 接口冒充你批准或刹车 | 配对码 + host-only cookie + CSRF + Origin 精确匹配；人类动词只在 UI 监听器上；残余风险在 Tuning 明示 |
| agent 写的文本在 UI、toast、herdr 里注入脚本或终端转义 | CSP、`textContent`、DOMPurify、toast XML 转义经 stdin、剥除控制字符 |
| 自有乐手自己给自己放权（写 settings / hooks / `.mcp.json`） | `settingSources: []`、`strictMcpConfig`、受保护路径进审批、CI 用例 |
| 通过 A2A 的提示注入 | taint 与来源链、审批卡片红条、消息不带权限、`orchestra_send` 限速、低预设发往高预设需你放行、`external` 需门控 |
| 每乐章 token 被伪造 | Claude 用进程内 MCP（无 token）；DSH 用 named pipe 核实 pid + 轮换 token；同一 host 内视为互信 |
| 秘密进入 journal 或公开仓库的 fixture | 三层脱敏；哈希链只覆盖摘要，片段可清除；fixture 合成或清洗、gitignore、gitleaks |
| 读 harness 的 SQLite 干扰 harness（锁、checkpoint） | `state_5` 快照读；不碰大库；查询完立即关闭 |
| 通知反而加重过载 | 分级、去重、专注模式（审批暂停计时）、摘要、agent 条目配额；跟踪每小时干预次数 |
| 非自有会话的盲区（Codex、DSH 的审批等待；Claude 无 hooks 时的等待） | 低置信启发式，并标出置信度；S5；自有驱动可以补上这块 |
| DS-Bot 0.1.7 的 API 与文档不符 | 端点已按 fork 源码核对，只剩 cookie 所需的 `interactions` 级别待 M4 验证；`send` 非幂等，Orchestra 先去重；建议先把权限修复提给上游再升级 0.2.x |
| 刹车误杀 live 宿主 | 受保护名单按映像名 + 命令行 + 父链识别；PID 复用剪边；多会话宿主不提供"连宿主一起杀"；键入确认 |
| vendored dsh-TUI 的私有补丁变成长期维护负担 | 先上游、后补丁；按上游 commit vendor，目标本地零 diff |
| S2 移到 M1 后，DSH 风险暴露得更晚 | M0 若提前完成先跑 S2；no-go 时 M1 退回 Claude↔Claude，不卡 A2A |
| 单人工作量（约 25 周） | M0 重新定界为 15–18 个工作日；每个里程碑都有削减顺序；M3、M5 可以顺延，不卡 A2A |
| opt-in 的 hooks / MCP 片段破坏零写保证 | 由你自己从显示的片段粘贴；之后重建审计基线；`PermissionRequest` hook 先通过 fail-through 测试 |

---

## 16. 需求追溯 R01–R28

优先级来自 [req]：R01–R11 为 P0；R12–R24 为 P1（R21 对无人值守的 bot 是 P0）；R25–R28 为 P2。

| ID | 需求（简称） | 优先级 | 里程碑 | 说明 |
|---|---|---|---|---|
| R01 | 跨 harness 的统一花名册 | P0 | M0 / M2 | 花名册在 M0（Codex 只有 `state_5`）；状态行在 M2 |
| R02 | 先观测：A2A 时间线与回放 | P0 | M0–M3 | 边从 M0 起作为 Event 记录；与控制相关的边覆盖率 100% 随 M1、M2 验收；全部边类型 100% 与时间线回放在 M3 |
| R03 | 任意深度的完整 subagent 树 | P0 | M2 | 树并核对数量；自有 DSH 从日志读，M3 起由 bundle 增强 |
| R04 | 事件驱动的 join/wait；轮询检测 | P0 | M3 | `orchestra_wait`（Exchange 级）+ 私有 home 的 `wait_subagent`（原生分身级）+ 轮询检测 |
| R05 | 生命周期回收器 | P0 | M0 / M2 / M3 | 刹车在 M0；回收与孤儿在 M2（DSH：cancel → close → resume）；自有 DSH 孙代理的级联回收在 M3 |
| R06 | 速度 governor（排队不失败） | P0 | M2 | 对自有会话强制；DSH 原生子代理先用 `maxActiveSubagents` 硬上限；对只读会话计量 |
| R07 | 死循环检测 | P0 | M0 / M2 | 告警在 M0（Claude、DSH；Codex 在 M2）；对自有会话自动暂停在 M2 |
| R08 | 循环终止策略 | P0 | M3 | 检测与强制都在 M3；M2 只有 runaway |
| R09 | 派活审计与任务板 | P0 | M3 | CAS 任务板、陈旧标记、重新分派 |
| R10 | 注意力收件箱 | P0 | M0 / M2 | 收件箱、一次性提醒、浏览器通知在 M0；专注模式、摘要、周期提醒、herdr 在 M2 |
| R11 | 跨 harness A2A 总线 | P0 | M1 | Claude↔DSH，带回执（S2 no-go 时先 Claude↔Claude） |
| R12 | 上下文溯源（ADR 绑定 git） | P1 | M1 / M5 | ADR 导出与已定决策注入 v0 在 M1；陈旧注释探针与冲突标记在 M5 |
| R13 | transcript ACL | P1 | M5 | `read_part` ACL，每次读取都记录；同一 DSH host 内互相可见，需要隔离时单开 host |
| R14 | 分层、可迁移的记忆 | P1 | M5 | 部分覆盖：范围与 journal |
| R15 | 成员工作日志 | P1 | M1 / M3 | `orchestra_report` 在 M1；与事件关联在 M3（Score） |
| R16 | Score / 图视图 | P1 | M5 | 只读的 AND / 循环总谱 |
| R17 | 常驻指挥家与 AutoRoute | P1 | M4 | Maestro + AutoRoute；派活标签从 M1 起积累 |
| R18 | agent 与预设登记 | P1 | M1 / — | 乐手登记表兼作目录（M1）；预设与 Skill Cluster 推迟，未排期 |
| R19 | UI bug 的 repro bundle | P1 | M1 / M5 | QA 乐手模板（rerun ×N 报告失败率）在 M1；repro bundle v0 及其验收在 M5 |
| R20 | 每项目的决策板 | P1 | M1 | Decision board |
| R21 | 越界防护 | P1（无人值守为 P0） | M0–M2 | Claude transcript 的 bypass 检测在 M0；无 bypass、禁用 `approval: never`、自有乐章配置隔离在 M1；DSH / DS-Bot 的 policy 告警在 M2；容器层推迟 |
| R22 | 工作区隔离 | P1 | M2 / M3 | 双写者告警在 M2；worktree 在 M3 |
| R23 | 群聊模式 | P1 | M3 | Rooms |
| R24 | 复用生态 | P1 | M0–M5 | DSH 原生深链在 M0；DS-Bot 文件在 M2；私有 DSH 控制台在 M2（可选）；BSB tab 在私有控制台 M3（可选）；`/api/bot` 在 M4；dsh-context 要先安装（Q5a） |
| R25 | 会话级团队开关 | P2 | M3 | 私有 home 的 host 键改为（项目，预设，teamMode）；只有 teamMode=on 的 host 挂载 `dsh-experimental-agent-team-profile`（它会关闭旧版 subagent 工具，`maxMembers` 为 8）；按会话开关的需求记入上游台账 |
| R26 | 导出包含 A2A 消息 | P2 | M5 | 运行导出包含 A2A 及每次回复的理由 |
| R27 | Tokenmaxxing 模式与成本预估 | P2 | M5 | 派活前的成本报价（第 8b 步）；"整库上下文"模式不做，原因见 §2.3 |
| R28 | 富媒体预览 | P2 | — | 推迟 |

---

## 17. 需要你拍板的问题

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q0 | **搬什么进来、在哪里对话**：哪些工作要搬进 Orchestra 乐手？ | A 只搬后台型工作；B 主力会话也搬 | A：先搬后台型的工作（另一个项目的后端、QA 重跑、调研），在乐手页里对话；前台主力会话继续留在原生 CLI，由 M0 负责观察 | M1 开始前 |
| Q1 | **Codex** 怎么接入 A2A？ | A 私装钉死的 codex 0.160.x，独立 `CODEX_HOME`（需要单独登录），全局和 Desktop 都不动；B 把全局 codex CLI 升到 ≥0.144（与 Codex Desktop 写出的 0.160.0 对齐，但会改变你日常 CLI 的行为）；C Codex 一直只读 | A（门槛是 ≥0.144；0.160.x 有 dsh-TUI 的绑定和 `PROTOCOL_DIGEST`）。子问题：如果 Codex 是你的日常主力，要不要把 Codex 驱动从 M4 提前到 M2 末，作为 M2 的可削减项？请先说明你在三家 harness 上的使用比例 | M2 开始前（子问题）/ M4 开始前 |
| Q2 | **DSH 凭据**：私有 DSH host 的模型凭据怎么来？ | A 每个 home 登录一次；B 环境变量 | B：给 Orchestra 单独申请一把可随时吊销的 API key，DPAPI 加密存在 `~/.orchestra`，经 `DEEPSEEK_API_KEY` 只注入私有 host 的进程环境。不用你的主 key，不写 `.credentials.yaml`，绝不从 `~/.dsh/.credentials.yaml` 复制 | S2（M1 第 1 周） |
| Q3 | **Maestro**：用哪个 harness、哪个模型？每日 CNY 上限是多少？ | DSH / Claude；模型；上限 | DSH 私有 home（ACP），模型 `deepseek-v4-flash`；每个项目每日 20 CNY，Maestro 自身每日 2 CNY（都是假设，M2 模型组合压测后校准） | 每日上限在 M2 前（governor 要用）；模型在 M4 前 |
| Q4 | **审批超时**：你不在时，自有会话的审批是超时后拒绝，还是挂更久？ | 30 min / 更长 / 按项目设置 | 30 min deny，可按项目覆盖；专注模式下被静音项目的审批暂停计时 | M1 |
| Q5a | **live `web` profile**：是否永远不放 Orchestra 代码？是否允许在那里安装 dsh-context / BSB？ | 永不 / 你 opt-in | 默认永远不放；dsh-context、BSB 先装进 Orchestra 的私有 DSH 控制台 | M2（私有控制台）/ M3（bundle） |
| Q5b | **DS-Bot fork** 要不要升级到 0.2.x 以获得 `request_id` 幂等？ | 升级 / 留在 0.1.7 | 建议在 M0–M1 期间向 Fei2411/DS-Bot 提交你的 `fix/permission-switch-race` PR；合并后先在隔离的 `DSH_HOME`（3099）上验证 0.2.x，再由你升级 live profile。M4 的 DS-Bot 声部以 0.2.x 的 `/api/bot` 为目标；只有仍停留在 0.1.7 时，才退回"每次发送都需你确认" | M4 开始前 |
| Q6 | **Claude hooks**：要不要粘贴 opt-in 的 Claude hook 片段（Notification、Stop）？ | 粘贴 / 不粘贴 | 这首先是可行性题：S5 若找不到等待信号，不装 hooks 时"需要输入"只能低置信地在 20 s 后推测，≤5 s 只能靠 hooks（且要先通过 fail-through 测试）。先零写入跑完 M0，看 blocked→noticed 的中位时间是否 < 2 min 再决定 | M0 验收后 |
| Q7 | **Worktree**：自有乐手只在需要时才拿 worktree，还是默认每人一个？ | 按需 / 默认 | 按需（每个 0.5–1 GB，跨 worktree 合并未解决） | M3 |
| Q8 | **自有 Claude 的配置根**：沿用你的 `CLAUDE_CONFIG_DIR`，还是独立根目录？ | A 沿用；B 独立根（需要单独登录） | A：复用登录，乐章结束后能在原生 CLI 里 `--resume`；transcript 会写进你的配置根，零写审计按 sessionId 白名单排除。无论哪种都用 `settingSources: []`，不加载你的 hooks、MCP 和权限规则 | M1 开始前 |
| Q9 | **自用还是发布**：Orchestra 是自用，还是发布给 DSH 社区？许可证用什么？ | 自用 / 社区；MIT / Apache-2.0 | M0–M2 自用，M3 前再定是否发布；许可证现在就定 MIT（附 NOTICE）。这会影响 BSB tab、可选的社区产出以及 P2–P4 需求的优先级 | 许可证在 M0；发布在 M3 前 |
| Q10 | **通知分级**：是否接受 §11.2 的分级表和专注模式规则？ | 接受 / 调整 | 接受，跑完 M0 后按每小时干预次数微调 | M0 验收后 |
| Q11 | **shadow → active 的门槛** | 一致率与样本数；注意力指标 | 最近 50 条派活一致率 ≥80%，并且 blocked→noticed 中位时间 < 2 min | M4 |
| Q12 | **你说的 Ultracode 体验最看重哪一点？** | A 不用自己选派给谁；B 一个主对话一直不断；C 自动拆活、并行推进 | 建议优先 B：M1 的主代理乐手（有通讯录、收件箱、已定决策）就能给你；A 要等 M4 的 Maestro 和足够的标签；C 依赖 M3 的委托树 | M4 开始前（M1 前回答更好） |

---

## 附录 A 证据索引

**调研报告**

| 文件 | 本文主要用到的部分 |
|---|---|
| [dsh-core.md](../research/dsh-core.md) | 发布节奏（38 个预发布版）、启动器层叠、ACP / SDK / Web 接口对照、subagent 上限、Agent Team、存储路径、凭据位置 |
| [dsh-tui.md](../research/dsh-tui.md) | `AgentSession` / `AgentEvent` / `SessionCapabilities`、Claude SDK 后端选项、Codex hub、版本门槛、herdr、inject pipe、可 vendor 的孤岛 |
| [ds-bot.md](../research/ds-bot.md) | 身份与 parts、`message_bot` 语义、请求幂等、群聊路由、steward、记忆、`inflight.json`、`/api/bot`、"bot 框架带来什么" |
| [cc-codex-protocols.md](../research/cc-codex-protocols.md) | Claude 磁盘格式与 registry、Agent SDK、hooks、跨会话消息、Codex app-server 方法与审批、`state_5.sqlite`、ACP、A2A 1.0、对照矩阵 |
| [landscape.md](../research/landscape.md) | BSB、dsh-apollo `wait_subagent`、dsh-context、Claude agent view、Conductor、herdr、审查瓶颈、10 个模式与 5 个反模式 |
| [own-blocks.md](../research/own-blocks.md) | adaptive-router 的流水线与 Wilson 门、`ExecutionRegistry`、tonghuashun 的账本与守卫、hermes 的 ACP 客户端与 MCP 形状、Node 24、EPERM、87 s 卡顿、隔离验证模式 |
| [requirements.md](../research/requirements.md) | 画像 P1–P5、R01–R28、非目标、乐团隐喻映射、评估思路 |

**本机关键路径**

| 路径 | 用途 |
|---|---|
| `G:\_Projects\DSH-plugins\.tools\node24\node.exe` | 便携 Node v24.22.0，有 `zlib.createZstdDecompress`、`module.registerHooks`、`node:sqlite` [核验] |
| `G:\_Projects\dsh-TUI\src\backends\claude\options.ts` | `:274` `allowDangerouslySkipPermissions: true`（只让 bypass 可达，并非默认处于 bypass）；`:88` `settingSources: 'set'`；`:49` `hooks: 'omit'`；`:68` `mcpServers: 'omit'`；`:43` `extraArgs` 只在缺 `msg_lifecycle_v1` 时传 `replay-user-messages` [核验] |
| `G:\_Projects\dsh-TUI\src\backends\codex\contract.ts:37` | `MIN_CODEX_VERSION = '0.144.0'` [核验] |
| `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` | 全局 DSH 0.2.1-rc.2 的内部包：`dsh-acp`（README 的 cancel / close 语义；`lib/index.js:835` 的 user 来源）、`dsh-base/cordis.patch.yml`（预设、遥测、goal、`list-agents`）、`dsh-win32-process`（MIT）[核验] |
| `C:\Users\Calx\.rec\claude\accounts\53087\config` | 实际的 `CLAUDE_CONFIG_DIR`（`~/.claude` 里只有备份）[proto]。同目录下的 `.credentials.json`、`.claude.json`、`sessions/*.key` **永不读取** |
| `~/.codex/state_5.sqlite`（WAL）、`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst` | Codex 的线程、spawn edge 与 rollouts [proto]。`~/.codex/auth.json`、`thread_history_1.sqlite`、`logs_2.sqlite` **永不打开** |
| `~/.dsh/sessions/--<cwd>--/{<uuid>\|session-<uuid>}/session.v4.jsonl.zstd`、`~/.dsh/storages/session_projcache` | DSH 会话日志（两种目录名并存，约 114 个 / 92 个 [核验]）与投影缓存 [core]。`~/.dsh/.credentials.yaml*`、`watchdog*.log` **永不读取** |
| `~/.dsh/bot/{state.json, inflight.json, usage.sqlite, state.lock}` | DS-Bot 数据（只读）[bot] |
| `~/.dsh-tui/session-mounts.json`、`~/.dsh-tui/inject/servers.json` | dsh-tui 的会话所有权与 inject 发现 [tui] |
| `~/.dsh/profiles/web/package.json` | live web profile，链接 DS-Bot fork 0.1.7+fork.1 [bot]；不含 BSB、dsh-context [核验] |
| `G:\_Projects\DSH-plugins\deepseek-bot-fork\ds-bot\src\host\channel.js` | `/api/bot` 的端点清单（0.1.7+fork.1）[核验-源码] |
| `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` | 系统自带的 C# 编译器，用于 procguard helper（评审核验） |
| `G:\_Projects\DSH-plugins\dsh-adaptive-router`、`G:\_Projects\dsh-tonghuashun`、`G:\_Projects\hermes-agent`、`G:\_Projects\DS-Bot` | 可复用的积木 [own][bot] |

---

## 附录 B 方法说明

### B.1 流程

```
7 个调研代理（research readers），各自核对本机文件与公开文档
  dsh-core · dsh-tui · ds-bot · cc-codex-protocols · landscape · own-blocks · requirements
        │
        ▼
4 个视角的设计组：observe-first · bot-a2a · standalone daemon · DSH-native
  （standalone daemon 与 DSH-native 两个视角因上游 502 错误失败，没有产出提案）
        │
        ▼
3 位评审，各从一个视角给剩下的两份提案打分：feasibility / user-value / ecosystem-safety
        │
        ▼
综合稿 brief v1：以 observe-first 为底，嫁接 bot-a2a 的身份模型、Post Office、安全补丁和 Maestro，
              并把 bot-a2a 的自有会话 A2A 切片提前到 M1
        │
        ▼
编排器补充核验：Node 24 的 zstd、options.ts:274、MIN_CODEX_VERSION
        │
        ▼
本文 r1（中文设计规划）
        │
        ▼
4 个视角的评审（facts · user-fit · dsh-native · feasibility-safety）→ 本文 r2（记录见附录 C）
```

### B.2 评分

| 视角 | observe-first | bot-a2a | 该评审推荐的底稿 |
|---|---|---|---|
| feasibility（可行性） | 7.5 | 4.5 | observe-first |
| user-value（用户价值） | 6 | 7 | bot-a2a |
| ecosystem-safety（生态与安全） | 7.5 | 6.5 | observe-first |
| **合计** | **21** | **18** | — |

- 两份提案各自最大的问题：
  - **observe-first**：把 A2A 推迟到约第 11 周，而且前一阶段只检测、不强制。
  - **bot-a2a**：M0 叠了好几个未经验证的集成；把 bridge 装进 live web profile；守护进程崩溃会留下占着写锁的孤儿；自身存在 ACP 看不到 DSH subagent 的矛盾。
- 综合稿的做法是取 observe-first 的低风险底座，采纳 bot-a2a 的终态设计，并把 A2A 提前。

### B.3 评审指出、并已在综合稿中修正的错误

- 零写审计必须指向真实的 `CLAUDE_CONFIG_DIR` 根目录，而不只是 `~/.claude`。
- `inflight.json` 的 `turns` 是按 session id 索引的 map，不是数组。
- ACP `session/new{mcpServers}` 当时被认为"只在 README 里有记载"；r2 评审确认 dsh-acp 的实现里已有校验，S2 只做端到端验证。
- DS-Bot 是**关掉** DSH 原生压缩、自己写 `[Checkpoint N]`，并不是"使用原生压缩"。
- dsh-TUI 的 `dsh-adapter/migrate/parse` 不是已验证的孤岛。
- `/api/bot` 是按上游 0.2.2 记录的；r2 评审已按 0.1.7+fork.1 源码核对端点，`send` 非幂等。
- "`from` 不可伪造"的说法夸大了，改为"只用于归因"。
- 把 bridge 装进 live web profile，又假设 bridge 钩子能影响 `--profile acp` 乐手，这是自相矛盾的；改为只在私有 `DSH_HOME` 里加载。
- "Orchestra 不能往非自有 Claude 会话里投递"是推断；r2 评审发现磁盘上有 `peerToken`，改为"可能可行，但 Orchestra 主动不用"。
- 评审指出，Node 22.13 起 `node:sqlite` 已不需要 flag（调研之外的知识），所以选 Node 24 的理由是 zstd 和 `module.registerHooks`，而不是 `node:sqlite`。
- `deepseek-v4-flash` 是 ACP 的默认模型（有文档记载），但拿它做路由仍然是一种选择。
- `dsh web :3080` 在核查时没有进程在监听，token 会随 watchdog 重启而失效，所以需要"重新粘贴"的流程。

### B.4 r1 相对综合稿的改动

- **Node 24 zstd 已核验**：D3 的理由、§5.3 运行时和 S1 都已更新。
- **bypass 位置精确到行**：`src/backends/claude/options.ts:274`。
- **Codex 版本表述统一**：门槛是 `MIN_CODEX_VERSION` 0.144.0（`contract.ts:37`），私有二进制钉 0.160.x。
- **DSH 粒度**：r1 写的是"私有安装 + 每项目一个私有 `DSH_HOME` + 每个（项目，预设）一个 ACP host"；r2 改为每个 host 独占一个私有 `DSH_HOME`（见附录 C）。
- **foreign-held 的含义说清楚**：它是 observed 的子集，表示"有别的活着的写者持有"。
- **补充项（都已标注）**：Room 实体（取自 bot-a2a）；S2–S6 的 no-go 后备；收件箱分组的补全与通知分级；数据目录（假设）；第 1–4 步命中后仍过第 5 步硬过滤的澄清；M0 削减顺序；§17 各问题的建议与决策期限；对 Ultracode 的描述标为假设。

### B.5 局限

- **设计阶段两个视角缺席。** standalone daemon 视角有一部分被两份提案覆盖；DSH-native 视角在设计阶段没有被正面论证，r2 的 dsh-native 评审补上了一部分（私有 home 的组合、候选 B、上游路线），结论是独立守护进程仍然正确，但应该更充分地利用私有 DSH home。
- **评审和综合都由 LLM 完成。** 部分事实是二手的，例如 Faros 的 91%、landscape 里对第三方产品的描述。
- **许多数值是假设**：每 root 转发上限 20、审批超时 30 min、待审上限 3、每日 CNY 上限、shadow 一致率 80% 等，需要在 M0–M2 中校准。
- **调研之外的假设**也在文中标出，例如 `.cmd` shim 的限制、libuv 全局 Job 允许孙进程脱离、`*.localhost` 解析与安全上下文、NTFS 目录项延迟更新。


---

## 附录 C 评审记录

r1 交给 4 个视角评审：facts（事实核对）、user-fit（是否贴合你）、dsh-native（DSH 原生视角）、feasibility-safety（可行性与安全）。编辑时在本机抽查了有争议的说法（见 C.4），然后逐条决定采纳、合并或驳回。

### C.1 采纳的主要改动

**安全**
- 本机 UI 鉴权重做：一次性配对码换 host-only cookie，只在 `orchestra.localhost` 提供，CSRF 头 + Origin 精确匹配；人类动词只挂在 UI 监听器上（D3、D8、§10.11）。
- 渲染与外发规则：CSP、`textContent`、DOMPurify、toast XML 经 stdin、herdr 剥除控制字符（§5.3）。
- 自有 Claude 乐章配置隔离：`settingSources: []`、`strictMcpConfig`、受保护路径进审批、自我放权 CI 用例（§7.4）。
- DSH 的 `approval: never` 预设（含内置 Full access）对自有乐手一律 no-go，S2 不再"回到 §17 重新确认"（§7.4、§13.3）。
- DSH 按来源判定人类授权、ACP 投递一律记为 user：M1 关闭 goal 插件，M3 bundle 以 relay 来源投递（§8.5）。
- `orchestra-mcp` 改为 Claude 进程内 SDK MCP、DSH named pipe + `pipe-client-pid` + 轮换 token；`orchestra_send` 定为特权操作（§8.5）。
- 来源追踪（taint）与审批卡片的来源链红条（§8.5）。
- 读取白名单（默认拒绝 `*.key`、`*credentials*`、`auth.json` 等）；粘贴的 `/connect` URL 立即换 cookie、不落库（§10.11）。
- 三层脱敏、哈希链只覆盖摘要、片段可清除、fixture gitignore + gitleaks（§6.1、原则 8）。
- 审批与请求摘要绑定、列表变化后按键冻结、toast 不放"允许"按钮（§10.9）。
- agent 创建条目的默认级别与配额（§8.6）。
- kill-tree 安全遍历（创建时间剪边）、受保护名单按命令行 + 父链识别并大幅补全、多会话宿主不提供"连宿主一起杀"（§10.5）。
- `state_5.sqlite` 改为快照读，永不打开大库（§7.3）。

**DSH 生命周期与宿主**
- 回收与中断改为 `session/cancel` → `session/close` → `session/resume`；DSH 孤儿规则排除常驻的可继续子代理（§7.1、§10.3、§10.4）。
- 每个子进程宿主一个嵌套 Job，挂在总 Job 下；单个 DSH 乐手用 `session/close` 回收；RSS 只归因到宿主（D4、§5.1、§10.3）。
- 每个（项目，预设）host 独占一个私有 `DSH_HOME`（D5、§5.3）。
- 私有 home 组合 v1（关闭 goal、workflow；`maxActiveSubagents` = `perModel`；关遥测；显式权限模式；合成配置快照 CI）（§7.4）。
- S2 改为候选 A（ACP）与候选 B（私有 `dsh web` / `runProfile()` + bundle）用同一张清单对比，预算 +1 天（D5、§13.3）。
- M3 bundle 增加净室 `wait_subagent` 与后代级联回收（§12.1、R04、R05）。
- DSH 的 runaway 检测消费原生 `repeat-tool-reminder` 的信号（§10.3）。
- Governor 不再声称"挡在 `ACTIVATION_LIMIT_REACHED` 前面"（§10.2）。
- DSH 权限预设不能经 ACP 修改，只回读 model 与 reasoning_effort，预设在 host 启动时探测（§10.10）。
- R25 通过 host 键（项目，预设，teamMode）在 M3 落地。
- 发给乐手的提醒（`target: musician`，M3）。

**重启与投递**
- 重启后按投递阶段处理：(a) 先在日志里核对 exchange 标记，核对不到才 `unknown`；(b) 恢复一次、只发固定的继续提示；(c) 按日志结算（§8.3、M1 验收）。
- "read" 回执改用 `command_lifecycle{state:'started'}`（`msg_lifecycle_v1`）；Codex steer 用 `item/started`（§8.2）。
- Codex Queue 由 Orchestra 自己排队，`thread/queue/*` 只作可选优化（§7.1）。

**范围、里程碑与追溯**
- M0 按工作量重新定界为 15–18 个工作日：S2、S3 移到 M1 第 1 周，S6 和 DS-Bot 源移到 M2；Codex 在 M0 只轮询 `state_5`；专注模式、摘要、rrule、herdr 通知移到 M2；150 MB RSS 只测量（§13.2）。
- 总工期从约 22 周调整为约 25 周；M1、M2 各 4 周（§13.1）。
- S1 拆成 S1-DSH（按帧，易）和 S1-Codex（单帧，难）；活跃文件用 `fstat` 轮询（§13.2）。
- procguard 定为 csc.exe 编译的 C# helper（Job、快照、kill-tree、pipe-client-pid），`dsh-win32-process` 作参考设计与备选（D4、S4）。
- 零写审计改为写围栏 + Procmon 实跑 + 冻结树哈希，M1 起按 sessionId 白名单排除自有 Claude 乐章（§5.3、§13.2）。
- "Claude 需要输入 ≤5 s 不装 hooks"改为以 S5 找到等待信号为前提，否则 20 s 低置信条目；Q6 变成可行性题。
- 原则 1 改为"控制直接依赖的事件类型覆盖率 100%"，M1、M2 验收各加一条覆盖率（§3.1、§14）。
- R08、R12、R15、R18、R19、R21、R24、R25、R27 的里程碑与交付物对齐；Musician card 并入 M1 的乐手页；Codex `thread/compact/start` 推迟到 M4 驱动之后；foreign-held 徽标从 M2 起显示（§16、§11）。
- Codex 黄金 fixture 覆盖 0.139.0、0.153.4、0.159.2、0.160.0 + <0.130 降级样本（本机 27 种 `cli_version`）（D12、§7.2）。
- `node:sqlite` 定案，重查询放 `worker_thread`；启动时检测 zstd 与 `registerHooks`（§5.3）。
- 通知首选浏览器 Notification API，PowerShell WinRT toast 后备，验收改为"5 s 内提交"（D10、§11.2）。

**用户体验与表述**
- 新增乐手页（对话 + 档案）、新建乐手向导、交还原生（§11.7）。
- §0 重写：术语速查、示例角色、"你在什么时候得到什么"、"你的一天"，决策表改成白话。
- §0.1、§2.2 写明现有会话不能收发 A2A、Codex 最早在 M4。
- §2.1 从你已经在用的 DS-Bot（9 个 bot、2 个房间）讲起，加"对照你的 5 个痛点"。
- §2.3 / §2.4 加主代理场景、"不建议整库上下文"的结论、"什么时候有"一行。
- 派活标签从 M1 起积累；shadow → active 门槛给出默认值（§9.5、Q11）。
- grep 爆内存的四种场景走查；`o` 对活着的会话聚焦窗口而不是 `--resume`（§10.3、§11.9）。
- ADR 导出与已定决策注入 v0 提前到 M1，只注入你选的选项和你写的理由（§11.6）。
- QA 乐手模板在 M1，M5 补 R19 验收（§11.7、§13.7）。
- 专注模式下被静音项目的审批暂停计时，剩 5 min 时升级通知（§11.2、§10.9）。
- Part 统一译为「乐章」，「声部」只指 Section；Kaito 固定为只读观察的 Codex 会话；§2.2 示意图的 fermata / wrong note 分开。
- 乐器图例改为表达风险等级，同色系分深浅，指挥台在 M4 前只站你（§11.3）。
- 待审上限（M4）与报价第 8b 步（M5）补进设计，兑现 §2 的说法（§10.2、§9.2）。
- §17 补 Q0、Q5a / Q5b、Q8–Q12；Q3 给出具体默认值；Q1 增加"升级全局 codex"选项和"提前 Codex 驱动"子问题。
- 措辞：Vibe 指挥、场务、"只对接，不魔改"、"正文只当纯文本显示"等。

**事实修正**
- §1.2：dsh-TUI 的 bypass 标志只让 bypass 可达，并非默认处于 bypass。
- §6.2：herdr 只接受 `idle/working/blocked/unknown`，`done → idle`、`error → blocked`。
- 附录 A：DSH 会话目录有 `<uuid>` 和 `session-<uuid>` 两种名字。
- D12：只有 SDK 协议没有版本协商；ACP 在 `initialize` 里声明能力。
- D4：ACP host 会因 stdio 断开自行收尾，Job 的理由改为孙进程和卡住的收尾。
- §7.1：`claude agents --json` 已确认包含交互式会话；`mcpServers` 在 dsh-acp 实现里已有校验。
- §7.4：vendor 清单补上 `src/shared/*` 与 `src/adapter/ports/channel-{view,session}.ts`；`hooks` / `mcpServers` 在 vendored 选项里是 `omit`，写租约改用 `canUseTool`。
- §12.1：DS-Bot 0.1.7+fork.1 的端点已按源码核对；dsh-context、BSB 不在任何 profile 里；受保护宿主补上 DSH Desktop 与 Orchestra 自己的 host。
- §2.2、§7.1：Claude 的 `peerToken` 在磁盘上，"无法投递"改为"可能可行但主动不用"，并加 policy 告警。

**生态与上游**
- 新增 §12.3 上游台账（每个里程碑 0.5 天）与可选社区产出。
- dsh-TUI 先上游、后补丁；DS-Bot 权限修复建议先提上游再升级 0.2.x（Q5b）。
- 私有 DSH 控制台（M2，可选），BSB tab 可在其中试装（M3，可选）。
- 动手做 Score、提醒、检索前先评估 dsh-flowglass、dsh-sentinel、dsh-session-search。
- Orchestra 许可证在 M0 定（Q9，建议 MIT）。

### C.2 评审之间的冲突与裁决

| 冲突 | 裁决 | 理由 |
|---|---|---|
| 自有 Claude 的设置：facts 建议"默认沿用你的配置根，评估收窄 `settingSources`"；feasibility-safety 要求 `settingSources: []` | 采用 `[]`，配置根单列为 Q8 | 收窄不够：项目级 `.claude/settings.local.json` 一次文件编辑就能给自己放权；配置根（登录、`--resume`）是另一个问题 |
| DSH 只有 Full access 时：feasibility-safety 建议标「无护栏」、每条 A2A 逐条批准；dsh-native 判 no-go | 判 no-go | `approval: never` 根本不发审批请求，逐条批准 A2A 也拦不住乐手在回合内执行的命令；退回 Claude↔Claude 不卡 A2A |
| procguard：feasibility-safety 主张 csc.exe 编译的 C# helper；dsh-native 主张 vendor `dsh-win32-process`（Koffi） | 默认 C# helper，库作参考设计和备选 | 该库只提供 Job 与 stdio 原语，没有进程快照和 `pipe-client-pid`，而这两样无论如何都需要；一个 helper 覆盖五个命令更简单；Koffi 在 Node 24.22 上的表现未验证 |
| Codex 黄金 fixture：facts 要求 M0 覆盖 4 个以上版本；feasibility-safety 让 M0 只轮询 `state_5` | 多版本 rollout fixture 随 rollout 解析器一起移到 M2；M0 的 Codex fixture 只有 `state_5` 快照 | M0 不解析 rollout，就不需要 rollout fixture；版本跨度的事实保留在 D12 和 §7.2 |
| 零写审计：facts 提议按 sessionId 白名单；feasibility-safety 提议写围栏 + Procmon + 冻结树 | 两者合并 | Procmon 盯的是 orchestrad 的子孙进程，自有 Claude CLI 也在其中，所以仍需要白名单 |
| 重启规则：facts 的三阶段规则；dsh-native 的自动核对 | 合并：阶段 (a) 先核对日志再判 `unknown` | 两者互补；自动核对减少人工条目，三阶段规则解决"恢复一次"和"绝不重发"的冲突 |
| DSH 宿主：r1 认定 ACP；dsh-native 主张私有 `dsh web` + bundle 同场比较 | S2 用同一张清单打分，默认 ACP | ACP 有按会话注入 MCP 的独特优势；候选 B 在 steer、来源、单分身中断上占优；没有实测不宜预判 |
| 专注模式的审批规则：user-fit 要求 M1 验收；feasibility-safety 把专注模式移到 M2 | 规则随专注模式在 M2 交付并验收 | M1 没有专注模式，审批 P1 照常通知，不存在被静默拒绝的问题 |
| policy 告警级别：dsh-native 要求 observed 的 Full access / DS-Bot bot 出 P0；user-fit 担心通知过载 | 自有乐章 P0；observed 每个会话或 bot 一条 P2 + Tuning 常驻计数 | 你的 live 环境里本来就可能有 bypass 会话，反复 P0 会制造告警疲劳；自有乐章按设计不该出现，出现就是 P0 |
| Q2 凭据：dsh-native 建议用 `DEEPSEEK_API_KEY` 环境变量；feasibility-safety 建议专用可吊销 key + DPAPI | 合并：专用 key、DPAPI 存放、经环境变量只注入私有 host | 两者解决不同问题（如何注入 / 用哪把 key） |
| 决策注入：user-fit 要求提前到 M1；feasibility-safety 要求 agent 写的题干不以人类权威注入 | 合并：M1 注入，只注入你选的选项和你写的理由 | — |

### C.3 驳回或部分驳回的意见

| 意见（视角） | 处理 | 理由 |
|---|---|---|
| 凡输入里含 agent 内容的回合一律标 tainted 并收紧权限（feasibility-safety） | 部分驳回 | 照此执行，每个 A2A 回合的工具调用都要手动审批，M1 的价值会被抵消。改为：只有来源链里有 external / unbound 发送者、抓取的 URL、项目外或 `node_modules` 文件、第三方 MCP 输出时才算 tainted；所有由 agent 消息触发的审批卡片仍显示来源链 |
| S2 只有 Full access 时继续使用、标「无护栏」（feasibility-safety） | 驳回 | 见 C.2，违反硬性安全规则 |
| procguard 不需要自编 helper，直接用 `dsh-win32-process`（dsh-native） | 部分驳回 | 见 C.2；保留为参考设计与备选 |
| observed 的 DSH / DS-Bot Full access 出 P0（dsh-native） | 部分驳回 | 降为 P2 + Tuning 计数；自有乐章仍是 P0 |
| BSB tab 从 M5 提前到 M3 作为交付物（dsh-native） | 部分驳回 | 改为 M3 起在私有控制台可选试装；M3 已满，且 BSB 当前没有在任何 profile 启用 |
| 把私有控制台 `127.0.0.1:3199` 加进 orchestrad 的 Origin 白名单（dsh-native） | 部分驳回 | 与 UI 鉴权的"Origin 只放一个值"冲突；改为只读 GET 端点单独发只读 token |
| M1 验收"A2A 投递后 repeat-tool-reminder 计数不被清零"（dsh-native） | 推迟到 M3 | ACP 把来源写死为 user（`dsh-acp/lib/index.js:835` [核验]），M1 走 ACP 时无法满足；M1 只保留"不出现 `goal/change`"一条 |
| M1 验收"专注模式下审批不被超时拒绝"（user-fit） | 推迟到 M2 | 见 C.2 |
| R18 在 M5 加"预设库 v0"（user-fit 的选项之一） | 选了另一个选项 | M5 已有 5 周且可能顺延；R18 改为"登记表兼目录在 M1，预设未排期" |
| 从 §2 删掉"待审队列深度"（user-fit 的选项之一） | 选了另一个选项 | 保留为 M4 的待审上限，成本低且兑现了 §2 的说法 |
| Q1 加"升级全局 codex" | 作为选项 B 加入，但不推荐 | 会改变你日常 CLI 的行为，与"全局不动"的默认相冲突；是否采用由你决定 |

抽查范围内没有发现评审在事实上说错的地方；被驳回的都是方案取舍，不是事实之争。

### C.4 编辑时在本机核验的事实

- `dsh-acp/README.md`：`session/cancel` 只停根活动，"Later child messages may start autonomous work"；`session/close` 包含 descendant disposal；client disconnect 与 close 走同一套 teardown；`set_config_option` 只覆盖 `model` / `reasoning_effort`。
- `dsh-acp/lib/index.js:835`：`source: { kind: "user" }`。
- `dsh-base/cordis.patch.yml`：`danger-full-access` 预设为 `approval: never`（:274-276）；`DSH_PERMISSION_MODE` 默认 `workspace-write`（:246）；遥测导出地址（:225）；`goal-round-driver`（:326）；`list-agents`（:377）；没有 schedule bundle。
- `dsh-win32-process`：MIT；只提供 Job / stdio 原语（README）。
- `dsh-repeat-tool-reminder/README.md`：只检测精确重复，dsh-base 在 3 / 5 / 8 次时提醒，只是建议，新的 user 消息会清零计数。
- `dsh-subagent/README.md`：对同一持久化存储的并发访问需要跨进程租约协议（不存在）；崩溃可能丢失已接受但未写入子会话日志的消息。后者支持 §8.3 阶段 (a)"日志里找不到就判 `unknown`、不自动重发"。
- tonghuashun `src/http.js`：Origin 校验写作 `if (req.headers.origin && …)`，不带 Origin 的请求会通过。
- dsh-TUI `options.ts`：`hooks`、`mcpServers` 为 `'omit'`（:49、:68），`settingSources: 'set'`（:88），`extraArgs` 只在缺 `msg_lifecycle_v1` 时使用（:43），`allowDangerouslySkipPermissions: true`（:274）；`contract.ts:40` 的 `lifecycle: 'msg_lifecycle_v1'`；`src/agent` 的 6 个文件 import `adapter/ports`；`thread/queue` 只出现在生成的绑定里。
- `~/.dsh/sessions`：114 个 `<uuid>` 目录、92 个 `session-<uuid>` 目录。
- `~/.dsh/profiles/*/package.json` 与 web 的 lockfile 都不含 BSB 或 dsh-context。
- `herdr pane report-agent --state`：`idle, working, blocked, unknown`。
- DS-Bot fork `package.json` 为 `0.1.7+fork.1`；`channel.js` 有 `state`、`send`、`approval-answer`、`stop-member-work`、`room-progress`、`usage`，没有 `room-continue`、`run-stats`。
- `claude agents --help`：`--json` 包含交互式和后台会话，`--all` 额外包含已完成的后台会话。
- 凭据类文件确实存在（只看了文件名）：配置根下的 `.credentials.json`、`.claude.json`、`sessions/<pid>.<hash>.key`；`~/.codex/auth.json`。
- `ds-bot.md`：`state.json` 有 `bots(9)`、`rooms(2)`。

### C.5 仍然存在的不确定性

- **DSH 宿主选型**：候选 A 与 B 谁更好，要等 S2；Windows 上是否存在一个既会发审批请求、又不被 EPERM 卡住常用工具的预设，也要等 S2。没有的话，M1 只有 Claude↔Claude。
- **自定义预设 `{sandbox: danger-full-access, approval: ask}`** 是否真的会发审批请求，未知。
- **Codex 单帧 rollout 的实时解码**（S1-Codex），以及 Windows 上 `fstat` 轮询能否及时看到追加。
- **Claude 不装 hooks 时有没有等待信号**（S5）。
- **libuv 全局 Job 允许孙进程脱离**的说法来自调研之外，嵌套 Job 的行为、Koffi 备选在 Node 24.22 上能否工作、杀软是否误报，都由 S4 验证。
- **`orchestra.localhost` 方案**：浏览器对 `*.localhost` 的解析、cookie 和 SameSite 行为来自调研之外的知识；agent 若在 `orchestra.localhost` 的其它端口起服务，host-only cookie 仍会被发送（cookie 不区分端口），残余风险依赖 CSRF 头和 Origin 校验。
- **`peerToken` 是否真能注入**：没有、也不打算主动测试；只做告警。
- **私有 host 的 key 是否对工具子进程可见**、每乐章 token 是否进入 DSH 日志：S2。
- **taint 启发式的覆盖率**：尽力而为，会有漏判。
- **`settingSources: []` 的代价**：自有 Claude 乐章用不到你的用户级 skills、插件和 MCP；体验是否明显变差，M1 实用后再评估。
- **`node:sqlite` 的 `immutable=1` URI**、Windows 勿扰下通知能否突破，未验证。
- **工作量**：M0 15–18 个工作日、M1 4 周（加了乐手页、向导、注入、标签、QA 模板）仍是单人估算，M1 的削减顺序可能会被用到；总工期约 25 周。
- **数值默认值**：待审上限 3、每日 CNY 上限、shadow 一致率 80%、首个流式输出 ≤30 s、配额等都是假设。
- **上游 PR 能否合并**（dsh-TUI、DS-Bot）：不在关键路径，但影响维护负担和 DS-Bot 升级时间。
- **你的偏好**：Q0（搬什么进来）、Q12（Ultracode 最看重哪一点）的答案可能改变 M1 的重点。
