# DSH Orchestra 设计规划（草案 r3）

> **已被 r4 取代（2026-10-27）**：本文件是 2026-10-27 的草案 r3，保留供对照和 diff；当前版本见 [2026-10-27-dsh-orchestra-design-r4.md](2026-10-27-dsh-orchestra-design-r4.md)，r4 相对 r3 的改动见其附录 G。

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-27（r3：并入 4 份研究文档，合并记录见附录 D；r2 为 2026-10-26，吸收了 4 个视角的评审，见附录 C） |
| 状态 | 草案 / 待决策（§17 有 14 个原有问题 Q0–Q12，加 r3 新增的四组 Q-A–Q-E、Q-W1–W2、Q-C1–C9、Q-DC0–DC8。Q0、Q2、Q8、Q9 在 M0–M1 前就要定；Q-C1 已于 2026-10-27 定为 B（桌面 CU 必要，Tier 2 进入计划，Q-C5 随之定为 Tier 2）；Q-C3、Q-DC0、Q-DC6、Q-DC2、Q-DC7 现在最要紧） |
| 维护者 | AdamPlatin123 |
| 范围 | 为 Codex、Claude Code、DeepSeek Harness（DSH）做一个本地的「超级 Orchestra 工作台」：跨项目注意力收件箱、跨 harness A2A、安全控制（限流 / 熔断 / 回收）、指挥家 Maestro 与 AutoRoute。r3 新增两块：乐手的「眼睛和手」（租给侦察乐手的隔离浏览器与桌面租约，§10.13–10.16），以及乐手内部原生工作流的观察与治理加 M6 的跨 harness 编排 Arrangement（§8.7–8.8）。单用户，Windows 11，仅 loopback。 |
| 不在范围 | 云端或多租户；v1 的无人值守自治；修改任何 harness 的内部实现；自建 CUA 循环或像素优先的 agent；一次性桌面（Tier 3）；图形化工作流编辑器或 DSL（见 §3.2） |
| 依据 | `docs/research/` 下 7 份调研，加 r3 并入的 4 份研究（标签见下表，链接见附录 A）；设计综合稿 v1 与 3 位评审的打分（方法见附录 B）；4 个视角的评审记录（附录 C）；4 份研究各经两轮红队复核，并入方法与结果见附录 D |
| 工期估算 | M0–M5 约 33–35.5 周（单人，含 Tier 2 桌面租约；你已在 2026-10-27 选定 Q-C1 = B）；M2 末的 S-CU 实测不通过则退回不含 Tier 2 的约 30–32 周；M6 Arrangement v0 另加 4–6 周，M4 后 go/no-go。周数均为推断（§13.1）。每个里程碑都能单独使用 |

**阅读指引**：只有 5 分钟，读 §0。想知道"为什么这么做"，读 §2 和 §4。准备动手，读 §13 和 §17。只关心乐手的眼睛和手，读 §2.5 与 §10.13–10.16；只关心工作流，读 §8.7–8.8；想知道 r3 相对 r2 改了什么，读附录 D。

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
| [arch] | [bot-architectures.md](../research/bot-architectures.md) | r3 并入：DS-Bot、OpenClaw、Koishi / MaiBot、Grok Bot / grok-build、agent 框架、harness 原生消息的对照；模式 A1–A20；R29–R41；D13–D16 的出处；Q-A–Q-E |
| [wf] | [dynamic-workflow-merge.md](../research/dynamic-workflow-merge.md) | r3 并入：「原生工作流留在乐章内 + Arrangement」两层方案；五家引擎对照；R33、R34、R41；Q-W1–W2；验收用例 WF-1–18 |
| [cu] | [computer-use.md](../research/computer-use.md) | r3 并入：乐器模型（Tier 0–3、Grant、Lease）、规则 E1–E15、模式 A21–A30、R42–R51、D17 / D18；Q-C1–C9；验收用例 CU-1–17 |
| [dcu] | [dsh-computer-use.md](../research/dsh-computer-use.md) | r3 并入：DSH 的 computer-use 包（「插座，不是乐器」）、Windows 上 cua-driver 的实况、`orchestra-desktop` 配方、A31–A39、R52–R60、Q-DC0–8；验收用例 CU-18–30 |

- **（假设）** 表示调研报告没有确证的内容。
- **（本文补充）** 表示综合稿里没有、本文为了完整性加上的内容，同样需要你确认。
- "impl N" 指对应报告 "Implications for Orchestra" 一节的第 N 条。
- 注意 **[bot] 指 ds-bot.md**（DS-Bot 本身的调研）；bot 架构综述一律用 [arch]。
- 四份研究文档内部的证据键（如 [rp]、[uw]、`impl_.rs:4069-4084`、`CC#96640`）在本文中只作括注保留，原始出处见各文档的 Sources 与 Review log。
- **（本文补充）** 在 r3 中也标记只来自本次合并、不出自四份研究文档的内容（例如 §2.6）。
- 引用本机安装的 DSH 包时，路径相对于 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（版本 0.2.1-rc.2）。

---

## 0. 一页纸摘要

### 0.1 Orchestra 是什么

1. **一个本机常驻的守护进程 `orchestrad`，加一个浏览器界面。** 它把你同时开着的 Claude Code、Codex、DSH 会话（连同它们派出的子代理）汇总成一个跨项目的「需要你」收件箱和一张乐团舞台图。
2. **在 Orchestra 里新建的会话是有固定名字的「乐手」。** 乐手之间通过 Orchestra 的「邮局」互发消息、自动回信，你不用再在它们之间传话。每个乐手有自己的对话页，你可以像在原生 CLI 里一样和它持续对话。
   - **注意**：你现在在终端、Codex Desktop、DSH Web、dsh-TUI 里开着的会话只能被看见，**不能**收发 A2A 消息。想让两个会话互相对话，要在 Orchestra 里新建乐手。M1 只有 Claude 和 DSH 乐手；Codex 乐手最早在 M4，还取决于 Q1。
3. **审批、拍板、杀进程永远只由你来做。** 守护进程负责排队限流、死循环熔断和孤儿进程回收；指挥家 Maestro 先按规则分派，规则判断不了才动用 LLM，并且先在「影子模式」下只建议、不执行。
4. **乐手的眼睛和手是租来的乐器，不是乐手的固有能力。** 只有侦察乐手能拿到一个隔离的、先看后动的浏览器（Tier 0：M1 只看公共站点，M2 起可以动）；登录态只能由你授予（Grant），而且只在你在场时可用；桌面只有一个，按租约轮流用（Tier 2；你已在 2026-10-27 决定它是必要的（Q-C1 = B），交付仍以 M2 末 S-CU 实测通过为前提）。Orchestra 管隔离、出口、污染标记、审批、脱敏和成本（§2.5、§10.13–10.16）。
5. **乐手内部照常可以用原生的 subagent 和 workflow。** Orchestra 在 M1 给它们上钳制、M2 看见它们、M3 管住它们；Orchestra 自己的跨 harness 编排 Arrangement 排在 M6，而且只是邮局的一个客户端，不是第二条总线（§8.7–8.8）。

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
| 乐器 Instrument | 乐手的眼睛和手：浏览器、桌面、一次性桌面；按 Tier 0–3 分层（§10.13） |
| 授权 Grant | 你为某个身份提供商（IdP）及其站点授予的登录态，分 look / act，只有你能创建、吊销 |
| 租约 Lease | 对一件乐器的独占使用权：一个持有者、一张状态表、一个 nonce，到期即收 |
| 侦察乐手 scout | 唯一能持有乐器的乐手种类：只读预设、无 shell、独占 host |
| 模板乐手 template | Arrangement 的 worker 所用的系统乐手，永不可寻址 |
| 编排 Arrangement | Orchestra 自己的跨 harness 工作流脚本（M6），是邮局的客户端 |
| 交接 handoff | agent 把浏览器或桌面上的一步交还给你（凭据、支付、CAPTCHA），只有你能结束 |
| 回访 check-in / 停滞 stall | 委托迟迟不回时唤醒提问者一次；累计 3 次停滞就升级给你 |
| 驾驭器 driver | 实际操作浏览器或桌面的程序：Tier 0 是钉死的 `@playwright/mcp`，Tier 2 的候选是上游 `cua-driver`（§10.13–10.16） |
| 代理 proxy | Orchestra 包在驾驭器外面的中介（`orchestra-browser`、`orchestra-desktop`），负责分级、审批、taint 与脱敏；与「子代理 / 分身」无关 |
| S-CU | M2 末只测驾驭器、不接乐手的 2–3 天验证 spike；已随 Q-C1 = B 列入计划（§13.4） |

全文示例统一使用这几位：

| 角色 | harness | 项目 | 所有权 | 能否收发 A2A |
|---|---|---|---|---|
| Aiko | Claude | shop-web 前端 | 自有 | 可以（M1） |
| Ren | DSH | api-core 后端 | 自有 | 可以（M1，取决于 S2） |
| Mio | Claude | shop-web QA | 自有（QA 模板，只读 + 测试命令白名单） | 可以（M1） |
| Kaito | Codex | api-core | 只读观察（你在 Codex CLI 里开的） | M4 前不能 |
| Yuki（r3 新增，本文补充） | Claude | shop-web 侦察 | 自有（侦察乐手：只读预设、无 shell、Tier 0 浏览器） | 可以（M1） |

### 0.3 你在什么时候得到什么

周数是单人估算。你已选定 Tier 2（Q-C1 = B，2026-10-27），所以以含 Tier 2 的约 33–35.5 周为基准（括号里的数字）；S-CU 不通过则退回不含 Tier 2 的约 30–32 周。里程碑尺标见 §13.1，全部为推断。

| 约第几周结束 | 里程碑 | 你得到什么 |
|---|---|---|
| 第 4 周 | M0 | 现有会话的跨项目收件箱、一次性提醒、死循环告警（Claude、DSH）和手动刹车；Codex 先只显示在不在、忙不忙；S4 顺带验证 Chrome 能否装进 Job |
| 第 9 周 | M1 | 在 Orchestra 里新建 Claude / DSH 乐手，有对话页；乐手互发消息、自动回信；审批集中处理；决策板 + ADR 导出，已定决策自动带进新乐章；QA 乐手模板（反复跑 flaky 测试并回报失败率）。r3 新增：只有乐手的名字能被寻址，回复不触发回复、通知不唤醒；乐手内部的原生 workflow 被钳制；Claude 侦察乐手能用隔离浏览器只看公共站点（Tier 0 look）；委托迟迟不回时回访提问者一次（A9；停滞升级在 M3） |
| 第 17 周（18） | M2 | 乐团舞台图、账本、自动限流与回收；Codex 实时跟踪；专注模式、30 分钟摘要、周期提醒。r3 新增：预算事件、入站策略、权威链卫生；看见乐手内部的原生工作流运行；Grant 登录态、出口过滤、浏览器 act 的两阶段审批、脱敏、交接条目；末尾跑 S-CU 实测驾驭器（+2–3 天，已定） |
| 第 23 周（25） | M3 | 委托树、群聊房间、任务板、时间线回放、worktree；私有 DSH 里的 `wait_subagent` 与孙代理回收。r3 新增：停滞升级（回访在 M1）、房间卫生、例程；管住原生工作流运行（截止、预算、绝不自动重启）；DSH 侦察乐手的浏览器 act；桌面 look（以 S-CU 通过为前提），约 +1.5–2 周 |
| 第 27 周（30） | M4 | 指挥家 Maestro（先影子模式）、Codex 乐手（取决于 Q1）、DS-Bot 声部。派活标签从 M1 开始积累，所以影子模式一开就有数据；真正自动派活要等一致率过门槛（Q11）。r3 新增：路由只从候选里选；查询阶梯；桌面 act（以 S-CU 的写投递结果为前提），约 +1 周 |
| 第 32 周（35.5） | M5 | 决策溯源探针、记忆范围、UI 测试复现包、导出、成本报价。r3 新增：记忆范围的读写标志 |
| M5 之后 +4–6 周 | M6 | Arrangement v0：只读模板（QA 复跑 ×N、对抗核验、评审裁决）、同步 `parallel`、可重放的 journal、Score 里的 Circuit 标签页；M4 后 go/no-go |

M3、M5 和 M6 的范围可以顺延，不会卡住 A2A。Tier 2 已定（Q-C1 = B），含 Tier 2 的工期是基准；S-CU 不通过时退回不含 Tier 2 的尺标，桌面部分按 Q-DC6 改走 Windows-MCP 前台后备或顺延。

### 0.4 你的一天（M1 之后）

- 早上打开 Program，看到 3 个 fermata。按 `a` 批准 Aiko 跑 `pnpm test:e2e`；卡片上写着这次调用是被谁的消息触发的。
- Ren 问「分页用 cursor 还是 offset」。按 `d` 把它转成 Decision，你选 cursor；之后 Aiko 和 Ren 新开的乐章都会带上这条决定。决策通知是 `wake:none` 的 notice，不会把它们叫醒，回执里显示的是「已读」而不是一条回信（D16）。
- 中午你让侦察乐手 Yuki 去看一眼 CI 面板。它用自己的隔离浏览器（Tier 0，只有公共 origin）从无障碍树里读到失败用例的名字，回报给 Aiko。需要登录的 Grafana 它看不了，只回报「需要登录」；M2 起你可以给它一个 Grant，写操作则要过两阶段审批。
- 下午 api-core 里 Kaito（Codex，只读观察）的 grep 子代理把内存涨到 3 GB：弹出 P0 toast，按 `K`，弹窗默认只勾 RSS 最大的那棵 `rg.exe` 子树，Kaito 的会话本身保留。
- 傍晚 QA 乐手 Mio 回报：e2e 跑 20 遍挂 3 遍，附上每次失败的日志路径。

### 0.5 最重要的 8 个决策

| # | 决策 | 为什么 |
|---|---|---|
| 1 | **先看见，再对话。** 前 4 周只读，先帮你管住已经开着的会话；第 5–9 周就让新建的乐手互发消息。（D1） | 过载来自已经开着的会话；A2A 是你的首要诉求，不排在"先用两周再说"之后 |
| 2 | **乐手是固定名字，会话只是它的一个乐章。** 子代理画成分身，不能直接收消息。（D2） | 名字要扛得过上下文换新和守护进程重启；原生的子代理消息只能在父子之间传 |
| 3 | **三类所有权：只读观察、自有、别人持有。** Orchestra 只驱动自己启动的会话；自有进程装进能整体回收的 Job Object。（D4） | 不和 DSH Web、dsh-TUI、DS-Bot 抢同一个会话；守护进程崩了也不留孤儿 |
| 4 | **A2A 走 Orchestra 自己的邮局。** 自动回信、去重，外加跳数、转发次数、截止时间三道上限。（D7） | 原生通道没有一条能同时跨 harness、跨进程、跨重启；DS-Bot 的语义好用，但没有上限和看门狗 |
| 5 | **审批、拍板、刹车只有你能做。** 一个审批队列，超时即拒；只有配对过的浏览器能点这些按钮。（D8） | Claude 的权限提示永不超时；本机任何同用户进程都能调本地接口，所以要配对 |
| 6 | **自动分派先走规则，拿不准就问你；先影子，后执行。**（D9） | 冷启动时没有证据；规则可审计，LLM 只在规则判断不了时用 |
| 7 | **工作流分两层：原生的留在乐手内部，跨 harness 的编排是邮局的客户端。**（D13） | 每家引擎都把工作流限定在一个会话内；跨 harness 只能由 Orchestra 来做，但它绝不能变成第二条总线 |
| 8 | **眼睛和手是租来的乐器。** 浏览器每个侦察乐手一个、隔离、先看后动；登录态由你授予；桌面只有一个、按租约用。（D17、D18） | 没有眼睛就做不了你要的查询；但驾驭着一个登录了 `orchestra.localhost` 的浏览器的 agent 就等于你，所以隔离、授权和撤销比能力本身更重要 |

其余决策见 §4：守护进程的运行时与存储（D3）、自有驱动的选型（D5）、对抗版本漂移（D12）、只有乐手可寻址（D14）、类型化权威（D15）、沉默有效（D16）等。

### 0.6 M0 在约 3.5 周内交付什么

- **前 3 天只做与 M0 有关的 3 个技术验证**：实时读日志（S1）、进程回收 helper（S4）、Claude 的"等待输入"信号（S5）。私有 DSH（S2）和 Claude 后端（S3）移到 M1 第 1 周，DS-Bot 字段（S6）移到 M2。每个验证都有后备方案。S4 顺带验证 Chrome 能否装进 kill-on-close Job 并被整体回收（约 +0.5 天，为 M1 的 Tier 0 浏览器铺路 [cu]）。
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
- **Q-C1**（r3）**已定（2026-10-27）：B**，自有乐手必须能驾驭你的桌面；Tier 2 进入 M3 / M4 计划，以 M2 末 S-CU 实测通过为前提，Q-C5 随之定为 Tier 2。
- **Q-C3**（r3）乐器只给侦察乐手、M1 只 look？建议接受。
- **Q-B**（r3）自动回信按消息角色（请求回、通知不回），还是每条显式？建议按角色（D16）。

之后再定的：Q1 Codex 怎么接入（M4 前）、Q3 Maestro 的模型与每日 CNY 上限（M2 前）、Q4 审批超时、Q5a/Q5b live web profile 与 DS-Bot 升级、Q6 Claude hooks、Q7 worktree、Q10 通知分级、Q11 影子→执行的门槛、Q12 你最看重 Ultracode 的哪一点。

r3 新增的四组问题（详见 §17 下半部分）：
- **乐器（Q-C1–Q-C9、Q-DC0–Q-DC8）**：除上面两条之外，Q-C5 已随 Q-C1 = B 定为 Tier 2（约 +3–3.5 周，推断；M2 末的 S-CU 决定 M3 look / M4 act 是否如期排）。现在最要紧的是 **Q-DC0** 桌面侦察乐手跑在 DSH 还是 Claude 上（建议先 Claude，图片路径已验证）、**Q-DC6** 主驾驭器（建议 cua-driver，Windows-MCP 作后备）、**Q-DC2** 首批 Windows 应用白名单（只有你能列）和 **Q-DC7** 桌面 act 的审批路线（建议 A：在 look 租约里起草、租约之间批准）。其余是登录态的范围（Q-C4）、DSH 侦察乐手与模型（Q-C7、Q-C8）、撤销开关（Q-C9）、钉版（Q-DC3）、act 模式（Q-DC4）、截图保留期（Q-DC8）等。
- **工作流（Q-W1、Q-W2）**：谁能编写和启动 Arrangement、默认预算多少；是否接受 DSH 模板只在沙箱内。M6 go/no-go 前回答即可。
- **bot 架构（Q-A–Q-E）**：你说的 grokbot 是哪一个；Q-B 见上；是否把 OpenClaw 当 harness 宿主联邦（建议只参考）；M3 要不要 `everyone` 房间模式（建议不要）；要不要研究 Tobs 或把 Grok Build 当第四个 harness。

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
| 要看的东西在登录后面：SSO 的 CI、本地面板、登录后的文档、UI bug 的页面 | 自己打开浏览器看，再转述给 agent | DSH 的 `web_fetch` 匿名、只看公开页、不跑 JS、不能登录 [cu]；Claude / Codex 的眼睛只在它们的桌面应用或你的真实浏览器里，自有乐手拿不到 | 侦察乐手的隔离浏览器：M1 先看公共站点，M2 起用你授予的 Grant 看登录后的页面，写操作走两阶段审批（§2.5、§10.13–10.15） |

你明确说过四件事：比起 bot 框架，你更看重 **A2A**，并认为它是多任务的前提；你喜欢 Claude "Ultracode" 那种持续交互加自动分派的体验；你也想要 **Tokenmaxxing**，即只和主代理或群聊说话，让它关注整个代码库；你还认为**没有 computer use 的 bot 不算真正的 bot**，尤其是做查询的时候。§2 专门回答这四点。

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

> 多个大应用并行时，你是唯一知道"谁在等谁"的人（注意力），是唯一的传话筒（A2A），也是唯一的保险丝（安全），还是唯一能登录进去看一眼的人（眼睛）。Orchestra 要把这四件事从你脑子里搬出来，并按风险从低到高依次交付：**先看见（M0），再对话（M1），再管住（M2）；眼睛先看后动（M1 look，M2 act）**。

---

## 2. 先回答四个问题

### 2.1 Bot 框架到底好在哪

**一句话：bot 框架就是给会话一个不会消失的名字和一个收件箱。** 对你来说，下表第 1、2 条就是 A2A 本身；第 3–6 条是让 A2A 在换上下文、重启时不掉链子。

**你其实已经在用。** 你的 live web profile 里装着 DS-Bot 0.1.7 fork，`~/.dsh/bot/state.json` 里有 9 个 bot、2 个房间 [bot]。在 DSH Web 里 @某个 bot、等它自动回信，这就是第 1、2 条。你感觉不到它的好处，是因为它只活在 DSH Web 里，够不着 Claude 和 Codex，也没有限流和看门狗；Orchestra 补的正是这两块。

| 能力 | 普通会话 | Bot / Orchestra 乐手 | 例子 |
|---|---|---|---|
| 1. 跨轮换的地址 | 只有人能找到它；上下文满了换新会话，"它"就没了 | 稳定的 id，换了几个乐章都能寻址 | 「@Ren，API 需要分页吗？」在 Ren 的上下文轮换两次、守护进程重启之后照样送达 |
| 2. 异步收件箱 | 只能你手动粘贴 | 可以 steer（插进正在跑的回合）或 queue（排到下一回合）；回复自动送回；同一发送者的未读消息合并；重试不会让一件活被做两遍；通知不唤醒，回复永远不会触发另一条回复（D16 [arch]） | Aiko 发完问题就结束回合；Ren 回信时 Aiko 被自动唤醒，接着写分页 UI |
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
| 要登录才能看的东西 | 部分是（常驻的侦察身份 + 租来的眼睛） | 侦察乐手 + Tier 0 浏览器：M1 look、M2 act；桌面 Tier 2 另议（§2.5） |

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
4. **"前提"不等于"最先交付"，也不等于"所有会话都能用"。** A2A 只对 Orchestra 自有的会话起作用：你现在在终端、Codex Desktop、DSH Web 里开着的会话不能收发 A2A 消息，想让它们对话，要把这部分工作搬进 Orchestra 乐手（Q0）。你**现有**会话带来的过载先靠只读注意力层缓解。所以顺序是：M0 看得见 → M1 能对话（第 5–9 周，不设"先用两周"的门槛）→ M2 管得住。
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

**一个场景**：你只对主代理说「shop-web 前端框架定 Vite SPA；api-core 分页用 cursor，通知相关的人。」→ 主代理用 `orchestra_request_decision` 生成 2 个 Decision → 你在收件箱确认 → 主代理用 `orchestra_send` 以 notice 通知 Aiko 和 Ren → 通知不唤醒它们（`wake:none`），两人的下一个乐章一开始就带上这两条决定，你在主代理的对话页里看到「已读」回执（D16）。

**失效的地方，以及 Orchestra 怎么补：**

| 失效点 | 原因 | Orchestra 的做法 |
|---|---|---|
| 审批 | 按设计就不能委托 | 进收件箱，只能你点 |
| 品味类决策（框架、架构） | 让 agent 在对话里"顺手定了"，早期笔记会污染后续上下文（R12） | 必须是人拍板的 Decision，可导出为 ADR 并注入新乐章（M1） |
| 上下文有限 | "关注整个代码库"的 token 成本按 agent 数和群聊发言人数线性增长；群聊里每个发言者都要重读自己的上下文 [bot][land]；DeepSeek 高峰时段价格是 2 倍 [land] | steward 在上下文压力 0.8 时轮换乐章；派活前的成本报价在 M5（R27）；原生工作流一次运行达到 25 个 agent 或 1.5M token 时事后出 P2 `workflow-run` 条目（§8.7，M2）；Arrangement 预估超过 25 次调用时在运行前先给出估算（R41 [wf]，M6） |
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
| 二者关系 | — | **互补**：乐手内部照样可以用原生 subagent / workflow（即 Ultracode 式）；Orchestra 管的是乐手之间、项目之间。Orchestra 观察并治理乐手内部的原生工作流运行（D13 第一层，§8.7）；跨 harness 的 Arrangement 在 M6 之后（第二层，§8.8）[wf] |

### 2.5 为什么乐手需要眼睛和手，以及为什么它们是「乐器」

**你的判断成立的地方。** DSH 的 `web_fetch` 匿名、只能看公开页、不跑 JS、不能登录（`dsh-web-fetch-http/README.md:12,64`）[cu]。所以 SSO 后面的 CI、本地面板、登录后的文档、UI bug 的页面，一个只有 `web_fetch` 的 bot 都够不着；社区里一个插件提案把这个缺口说成「它回你一句『需要登录』」（DSH-D#10996）[cu]。没有眼睛，你最在意的查询就做不了。

**三个修正** [cu][dcu]：
1. **大多数查询要的是结构化读取，不是像素。** 顺序是 API / CLI → 登录后的无障碍文本 → 只剩像素的那一小部分；两家厂商都把屏幕控制排在最后。在 OSWorld 2.0 的长程工作流上（中位约 1.6 人时），截至 2026 年中评测的最好模型（Opus 4.8）只完成 20.6%（arXiv 2606.29537）；短任务榜单的分数高得多（OSWorld-Verified 83.4%，聚合数据，未核实）。
2. **computer use 是 harness 的能力，不是模型的。** Claude 和 Codex 只在各自的桌面应用或你的真实浏览器里提供它，Orchestra 自有的 SDK / app-server / ACP 会话拿不到。DSH 是例外：实验性的 CU 包可以挂进自有 host，但 rc.2 一个都没装；而且 DSH 的 `dsh-computer-use` 只是一个 30 行的名字注册表，没有工具、锁、租约或审批，是「插座，不是乐器」（§10.16）。
3. **风险在乐器里。** 早期 CUA 红队报告 42–98% 的攻击成功率，多数针对已退役模型（arXiv 2505.21936）；2026 年的一次审计中 140 次多步浏览器攻击对 Sonnet 4.6 与 GPT-5.4 全部失败，但编码类技能注入达到 100%（arXiv 2606.05233）。更尖锐的失败是 D8：一个驾驭着登录了 `orchestra.localhost` 的浏览器或桌面的 agent，**就是你**。

**结论（D17）。** 眼睛和手是舞台上的乐器，不是乐手的固有能力。浏览器有很多把、每个侦察乐手一把（Tier 0），登录态由你授予（Grant），桌面只有一张、按租约用（Tier 2）。Orchestra 掌握隔离、出口、污染标记、审批、脱敏和成本；只有侦察乐手（只读预设、无 shell、独占 host）能持有乐器（E6）。

**「真正的 bot」的精确说法（推断）。** 一个真正的 bot = 一个租来的、隔离的、先看后动的浏览器，加上一条交回给你的 handoff（凭据、支付、CAPTCHA 永远由你来做）。自有乐手是否还必须能驾驭你的桌面，是 **Q-C1**；扫过的社区讨论里没有人说「没有 CU 的 bot 不算 bot」[cu]，所以这一条只由你定。**你在 2026-10-27 的回答是 B：桌面 CU 是必要的。** 因此 Tier 2 进入 M3 / M4 计划，工期以含 Tier 2 的约 33–35.5 周为基准；交付仍以 M2 末 S-CU 的实测为前提，不通过就按 Q-DC6 退到 Windows-MCP 前台后备或顺延。

**什么时候有**

| 里程碑 | 眼睛和手 |
|---|---|
| M1 | Claude 侦察乐手的 Tier 0 浏览器，只 look、只看公共 origin、经出口白名单；`canUseTool` 拒绝一切非读工具 |
| M2 | Grant 登录态；出口过滤器；浏览器 act 走两阶段审批；代理层脱敏；`handoff` 条目；每租约一个 Job；M2 末跑 S-CU 实测驾驭器（已定，Q-C1 = B） |
| M3 | DSH 侦察乐手的 act；桌面 look（S-CU 通过为前提），经 `orchestra-desktop` + cua-driver |
| M4 | 查询阶梯（A24）；桌面 act（S-CU 写投递足够为前提），只放行非 WPF / Tk / GTK 窗口上的单次左键 |
| 计划外 | Tier 3 一次性桌面（Windows Sandbox / VM） |

对照你的痛点：「要登录才能看的东西」在 §2.1 的痛点表里是部分 bot 能力（常驻的侦察身份）加租来的眼睛；其余的隔离、授权与撤销都是 Orchestra 的事，不是 bot 框架的事。

### 2.6 两条来自 Claude Code 自身的经验（本文补充）

这一节不出自四份研究文档，是 2026-10-27 合并时加上的，供 §8.7 与 §13 参考。

**(a) 钩子如何做出「看起来超长程」的自动推进。** 在本机 Claude Code 2.1.310 的二进制里核验到的 hook 事件包括 `PreToolUse`、`PostToolUse`、`PermissionRequest`、`PermissionDenied`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`Stop` / `StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`TaskCreated`、`TaskCompleted`、`TeammateIdle`、`Notification` 等；决策字段有 `decision:"block"` 加 `reason`、`continue:false` 加 `stopReason`、`permissionDecision`、`updatedInput`、`additionalContext`，输入里还有 `stop_hook_active` 标志。所谓超长程，是四件事叠出来的：① `Stop` 钩子可以 block 并给出理由，让模型继续（Ralph 式循环）；② 事件驱动的再唤醒（任务完成通知、定时唤醒、CI 与会话事件）；③ 状态外置（文件、记忆目录、journal、`--resume`）加上下文压缩；④ 确定性的 Workflow 脚本骨架。Orchestra 不依赖这些钩子（自有 Claude 乐章的 hooks 是 `omit`，§7.4），而是在守护进程一侧实现同一套机制：

| Claude Code 的机制 | Orchestra 里的对应物 |
|---|---|
| `UserPromptSubmit` / `streamInput` 注入 | 邮局投递（§8.2） |
| 带预算的 `Stop` 钩子 | Governor 与预算事件（§10.2）；Arrangement 的 `meta.stop`（§8.8） |
| 超时、`SubagentStop` | Reaper、轮换熔断（§10.4） |
| `PreToolUse` 阻断 | 租约与 `orchestra-browser` / `orchestra-desktop` 代理的拒绝（§10.14–10.16） |
| `SessionStart` 的 `additionalContext` | 已定决策注入与交接笔记（§11.6） |
| Workflow 脚本 + journal 重放 | Arrangement 的 journal 与重放（§8.8） |

**(b) 子代理不是越多越好。** Anthropic 2026-10-22 的文章 "Building agents: When to fold subagents into your main agent loop"（Diane Sarkis，https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop）的要点：单一循环加渐进式披露（skills、tool search）常常胜过一堆子代理；只在三种情况下保留子代理：可测量的上下文膨胀退化、可丢弃新窗口的并行任务、工具选择困难或指令冲突；子代理仍适合独立复核、并行工作和模块化授权；30–50 个工具定义就会拖累工具选择；一位客户折叠后快约 2 倍；Claude Code 的系统提示词削减了 80% 以上；一次折叠在两次运行中有一次打断了流程，所以评测要跑两遍、备约 10 个黄金样例、一次只折叠一个。对 Orchestra 的三点含义：
1. 乐手按项目与职责划分、彼此对等（对应条件二、三）；一个乐手内部不再按角色拆成一群子代理专家。
2. `orchestra-desktop` 只向模型暴露约 10 个工具，而不是驾驭器的全部工具（DSH-D#7080 报告过 55 个约 23.5k token；0.37.0 的实际数目由 S-CU 统计）[dcu]；`orchestra-mcp` 的工具按里程碑渐进出现（§8.6）。
3. Arrangement 的 worker 只用于可丢弃的并行与独立复核；复核者与修订者分开，交接是有损的，所以每次修订后都再独立复核一遍。这也是本文四份研究文档的产出方式（附录 D）。

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
12. **先看后动，看也要租。** 眼睛和手是按租约借给侦察乐手的乐器；写操作走两阶段审批；结果不明只观察、不重发；没有租约就没有工具。（D17 [cu]）
13. **沉默有效，唤醒可控。** 通知不唤醒，回复不触发回复，只有请求才开 Work；排队与暂扣都对发送者可见。（D16 [arch]）

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
- 不做终端网格，也不嵌入 TUI pane；不抓取屏幕内容（乐器的例外见下文「来自 r3 并入的研究」的 [cu] 一条：只在你授予的 Tier 2 租约期间、按窗口、对白名单应用捕获桌面）。
- 不用 Electron 或 BSB 当外壳。
- 不把 A2A 1.0 当内部协议。
- 不使用 CLIProxyAPI。
- 不写 DS-Bot 的 `state.json`；不调用 DS-Bot 的 `approval-answer`。
- 默认不往 live `web` profile 安装任何东西。
- 不自动批准任何审批。

来自 r3 并入的研究：
- 不让 agent 之间自动多轮对话（回复不触发回复）；不让 agent 自己创建乐手或例程，只能提出类型化请求由你批准。[arch]
- 不做图形化工作流 DSL、声明式格式或编辑器；不在 Orchestra 自有、经 governor 接纳的会话之外调用任何 LLM。[wf]
- 不自建 CUA 循环，不做像素优先的 agent；自有 Claude / Codex 乐手不用厂商自带的 computer use；只在你授予的 Tier 2 租约期间、按窗口、对白名单应用捕获你的桌面，其余时候乐手只能看隔离的浏览器。[cu]
- 不把 DSH 的 provider 注册表当租约；不用 DSH 的进程内 `cua-driver-native` provider、`allowedApps`、`bounded` 模式、裸 `mcp`、`install.ps1`、`run_script`；v1 不放行任何会走合成笔触的点击。[dcu] 一次性桌面（Tier 3）在计划外。[cu]

---

## 4. 关键架构决策（D1–D18）

D1–D12 来自 r2；D13–D18 是 r3 从四份研究文档并入的，出处标在理由列。

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
| D13 | **两层工作流。** 原生工作流（Claude Code、DSH 的 workflow 工具）留在一个乐章之内，画成分身组（Clone 组）：M1 钳制、M2 观察、M3 治理（R33）。Orchestra 自己的跨 harness 工作流叫 **Arrangement**：在 WASM 沙箱里跑的确定性脚本，是邮局的**客户端**（`trust: runtime`，每次调用都有回执、`requestId` 幂等、上限、taint 和 governor），M6，M4 后 go/no-go；v0 只有只读模板和同步 `parallel`（§8.7、§8.8）。 | DSH `tool-workflow` 当跨 harness 引擎（没有预算、journal 和 OR-join）；Dify 式编辑器；让 goal loop 掌握终止；把工作流当 A2A 总线。 | 五家引擎都把运行限定在一个会话内，上限写在代码里；DSH 的本地子代理可以继续、letta-code 能按 `conversationId` 恢复，所以「分身不可寻址」是我们的策略而不是 harness 事实。社区案例：非幂等重启杀掉活着的 agent 并覆盖文件（CC#86777）、触发消息被当成指令传给每个 worker（CC#96640）、25 个 agent 而非 6–7 个、约 10 倍成本（CC#91532）、激活上限冲突（DSH-D#10655）。r2 约 25 周（r3 含 Tier 2 约 33–35.5 周，不含约 30–32 周）的单人计划没有余量，所以 Arrangement 排到 M6。[wf][arch] |
| D14 | **只有乐手可寻址**（A1）。地址只有 Musician id；Part id（包括 `replyTo`）重解析到当前乐章。拒绝码：`raw-session-id`、`stale`（已归档的乐手）、`foreign`、`unresolved`、`clone-not-addressable`、`template-not-addressable`。 | 直接寻址会话 id、Clone 或模板乐手。 | grok-build 跨激活保持身份（`identity.rs:12-14,58-60`）、拒绝把会话 id 当地址（`address.rs:1-9,86-127`），但它给每个非工作流子代理都分配地址（`:46-57`）；拒绝 Clone 是我们的策略，不是行业共识。[arch] |
| D15 | **类型化权威，只用一个字段**（A4）。`trust` 增加 `runtime`：`human` = 配对过的 UI；`agent` = 绑定的乐章；`unbound` = 没有乐章的同用户进程；`external` = 导入；`runtime` = 守护进程计算出的文本。agent 只能 `queue\|steer`，`interject` 与中断为人类专属；邮件是带归因的数据，绝不以 `system` 注入。 | 单独的 `principal` 字段；把邮件注入为 `system`（Letta）；agent 中断 agent（GBR 重建版）。 | grok-build 的类型化 `Principal` 与 `OperationSet`（`envelope.rs:4-18`）；Codex 的 `inter_agent_message`；Claude 团队邮件不能批准、拒绝不可转发（`CC-T`）。[arch] |
| D16 | **沉默有效，唤醒可控**（A3）。`reply` / `notice` / `progress` 不开 Work、不自动回信；`wake: turn\|none`，notice 默认 `none`；只含致谢的回复（`replyFormat:'none'` 或无 refs 的短正文）作为回执到达（`replied(suppressed)`），不唤醒，所以等待永不挂死。 | agent↔agent 自动多轮交换（OpenClaw 已撤回）；阻塞式 request / reply（Letta `wait_for_reply`）。 | OpenClaw 因回声循环撤回了 ping-pong（`releases/2026.10.1.md:1182`）；Codex QueueOnly；Claude Code 里空致谢占约 13%、最高 22% 的回合（CC#47930）。[arch] |
| D17 | **乐器模型。** 眼睛和手是舞台乐器，不是乐手的固有能力：浏览器多且每个侦察乐手一把（Tier 0），登录态由你的 Grant 授予，桌面只有一张且租用（Tier 2）；只有侦察乐手能持有乐器（E6）；Orchestra 掌握隔离、出口、taint、审批、脱敏和成本。Tier 2 的驾驭器候选 = 上游 `cua-driver mcp --direct`（MIT）置于 `orchestra-desktop` 代理之后，宿主 harness 由 Q-DC0 决定，S-CU 验证通过并在 Q-DC6 选中它后才交付（Q-C5 已随 Q-C1 = B 于 2026-10-27 定为 Tier 2；§10.13–10.16）。 | 自建 CUA 循环、像素优先 agent（Skyvern 是 AGPL）；厂商 CU 进自有 Claude / Codex 乐手；DSH 的 provider 注册表当租约或多乐手设计；进程内 native provider；storage-state 交接；默认配置的 WSL2 当边界；「有用就上网」与粘性自动批准；无人值守的登录态浏览；托管浏览器；虚拟桌面切换、SendInput / pen 式「后台」、RDP 到自己、Job UI 限制。 | `web_fetch` 的限制与查询阶梯；CU 只在桌面应用里；红队数字与 D8；DSH 拒绝过 Session ownership broker、browser-use 的持有不排队（DSH-D#7007、#7169、#9688）；cua-driver 0.37.0 在 Chromium / Electron 后台把单次左键以外的点击、以及 UIA 失败后的 WPF / Tk / GTK 元素点击都改成合成笔触（`impl_.rs:3961-3973,4069-4084`），所以 act 只放行非 WPF / Tk / GTK 窗口上的单次左键，且任何 `windows_targeted_injection` 结果都 `suspended` + P1。[cu][dcu] |
| D18 | **隔离 profile 默认。** 自有乐手绝不用 `--extension`、`--autoConnect`、Claude in Chrome 或 Codex `claimTab`；自有 Claude 启动传 `--no-chrome`；UI profile 不装 agent 扩展、不开 CDP（E1、E5）。 | 复用你的 Chrome profile；UI 与 agent 共用 profile；用 Claude in Chrome / Codex `claimTab` 当乐手的眼睛。 | 一次 SSO 登录解锁 IdP 后面的所有应用，所以 Grant 按 IdP 划分、带显式 origin；驾驭着登录了 `orchestra.localhost` 的浏览器的 agent 就是你；Chrome 的 `lockfile` 删除即关闭，第二次启动退出码 21，便于回收器判定持有者。[cu] |

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
│ LeaseBroker (in Governor) · EgressFilter · RawInput + foreground watch (Tier 2 only)   │
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
   ├── dsh 乐章启动 `orchestra-mcp`（stdio）→ named pipe 连回 orchestrad（核 pid + 每乐章 token）
   └── instruments/（每个租约一个嵌套 Job `lease:<id>`，挂在 host Job 下；Claude 进程内 SDK 时挂在总 Job 下）
       ├─ orchestra-browser 代理 → pinned @playwright/mcp（headless，--proxy-server）→ 出口过滤器      Tier 0
       └─ orchestra-desktop 代理 → `cua-driver mcp --direct`（代理自己的 stdio 子进程，只在租约 active 时）Tier 2（已定，S-CU 为前提）
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
| Inbox + Notifier | 跨项目收件箱，P0–P3，去重，浏览器通知 + PowerShell toast 后备；专注模式、摘要、herdr 在 M2；面向主代理与 Maestro 的观察者协议（A15 [arch]，§11.2）在 M2 / M3 | M0 |
| Reminders | Orchestra 自己的调度器，提醒在重启后不丢 | M0 一次性提醒；M2 周期提醒（rrule）；M3 发给乐手的提醒 |
| CapabilityRegistry | `detect()` 的结果（是否安装、是否已认证、版本漂移）以及各项能力是否存在；类型化拒绝码 | M0 |
| Detectors | runaway、polling、bounce、orphan、stale、two-writers、policy（bypass / `approval: never`） | M0：runaway v0（Claude、DSH）、policy v0（Claude transcript 里的 bypass）；M2：其余与 DSH / DS-Bot 的 policy；M3：bounce / round |
| procguard | csc.exe 编译的常驻 helper：嵌套 Job、挂起创建、进程快照、`kill-tree{pid, createTime}`、`pipe-client-pid`（S4）；`run-in-job` 另有一次性 stdio 模式与 `--env-allowlist <file>`，供 Tier 2 驾驭器用（§10.16 [dcu]） | M0 |
| Store | `orchestra.db`（`node:sqlite`）+ `journal.jsonl`（哈希链只覆盖摘要）+ 可清除的片段表 | M0 |
| 写围栏 / 读白名单 | 所有写只经一个 fs 模块，默认只允许 `~/.orchestra`；所有读只允许白名单文件 | M0 |
| 乐手页 | 每个自有乐手一页：对话（流式）+ 档案卡；新建乐手向导；交还原生 | M1 |
| Decisions | 决策板、ADR 导出、已定决策注入新乐章 v0 | M1（陈旧注释探针在 M5） |
| ApprovalQueue | 唯一的审批队列，超时即拒，批准与请求摘要绑定 | M1 |
| PostOffice | 信封、投递、回执、规则 1–11、重启三阶段处理 | M1（规则 2、3、7、规则 4 的去抖与 `collect`、规则 11 的停滞升级在 M3；规则 10 在 M2） |
| `orchestra-mcp` | Claude 乐章用 SDK 进程内 MCP；DSH 乐章用 stdio MCP 进程经 named pipe 连回守护进程 | M1 |
| Governor | 按项目 / 模型 / harness 排队，加每日 CNY 上限；M4 起加待审上限 | M2 |
| Reaper | 回收自有进程树，释放闲置乐章，标出幽灵分身 | M2（刹车在 M0） |
| Ledger | token 与 CNY 账本，reserve / settle | M2 |
| RoomRouter | 群聊路由（admin 优先、`[PASS]`、转发上限） | M3 |
| Maestro / AutoRoute | 指挥家与 10 步路由流水线；派活标签从 M1 起积累 | M4 |
| 乐器租约 LeaseBroker | Governor 内的租约经纪：Tier 0 由运行时按独立的 `instruments{maxBrowsers, ramGB}` 预算授予，Tier 2/3 只有你授予（D8）；Grant 与 Lease 的状态机见 §10.14 [cu] | M1（Tier 0 由运行时按 `instruments` 预算授予，先于 Governor 的其余部分；推断）；M2（Grant、Tier 2/3 的 `lease-request`） |
| `orchestra-browser` 代理 | 每租约包装一个钉死的 `@playwright/mcp`：动作分级、两阶段审批、taint、响应路径脱敏、图片引用与计量（§10.13、§10.15）[cu] | M1 只 look（Claude 侦察乐手、公开 origin）；M2 完整 |
| 出口过滤器 | Tier 0 Chromium 的 `--proxy-server` 目标：默认拒绝，只放 Grant 的 origin，永远拒绝 loopback、LAN 与 `orchestra.localhost`（E4）[cu] | M2 |
| `orchestra-desktop` 代理 | 面向 harness 的 MCP 服务器，桌面的绑定闸门；只在租约 `active` 期间把 `cua-driver mcp --direct` 作为自己的 stdio 子进程拉进 Job `lease:<id>`（§10.14、§10.16）[dcu] | M3 look（Tier 2 已定，以 S-CU 通过为前提）；M4 act（以 S-CU 写投递与 Q-DC7 为前提） |
| 工作流观察器 | 解析 DSH `tool-workflow/*` 事件与 Claude 工作流记录，把原生工作流运行画成分身组（§8.7）[wf] | M2 |
| Arrangement 运行时 | Orchestra 自己的跨 harness 工作流：WASM 沙箱内的确定性脚本，作为邮局客户端以 `trust: runtime` 发信（§8.8）[wf] | M6（M4 后 go/no-go） |

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

守护进程崩溃时，总 Job 关闭，所有嵌套 Job 里的进程（包括孙进程）一起结束，DSH 的写锁随之释放。这正是 D4 拒绝 `taskkill /T` 的原因。守护进程绝不在 Job 里启动面向你的程序（浏览器、承载 `claude --resume` 的终端、VS Code），否则守护进程一死，这些程序会一起被杀。Grant 登录用的有头 Chrome 由 orchestrad 在 Job 之外打开（§10.14），正属于这一类。

乐器也装进 Job：每个租约一个嵌套 Job（`lease:<id>`），挂在持有它的 host Job 下（Claude 进程内 SDK 时挂在总 Job 下）；刹车只关这个 Job，绝不关你的 Chrome（E14）。S4 因此增加一项（+0.5 d）：经 procguard 启动 playwright-mcp，对每个 `chrome.exe` 跑 `IsProcessInJob`，关闭 Job 后统计幸存者，并读 `chrome://sandbox`。此前的验证只证明 Chrome 能从 `KILL_ON_JOB_CLOSE` 的 Job 启动，Job 成员、回收与渲染器沙箱都（未核实）[cu]。

---

## 6. 数据模型与状态机

### 6.1 实体

| 实体 | 关键字段 |
|---|---|
| **Project** | `id`, `name`, `roots[]`（cwd 前缀、worktree）, `gitRemote`, `color`, `priority`, `focusMuted`, `quietHours`, `budget{cnyDay, tokensMin}`, `tempo{maxActive, perModel, perHarness}`, `reviewCap` |
| **Musician** | `id`（稳定）, `projectId`, `name`, `role`, `lineageHue`（同一 harness 内分深浅）, `persona`（逐字节稳定，以保住 prompt cache [bot]；每乐章冻结注入的上下文，A18 [arch]）, `harness`, `model`, `effort`, `permissionProfile`, `desired/applied{model, permission}`（每次修改后回读）, `memoryScopes[]`, `kind`（`principal`、`bot`、`maestro`、`qa`；新增 `scout` 侦察乐手：只读预设、无 shell、独占 host，唯一能持有乐器的种类，E6 [cu]；新增 `template` 模板乐手：Arrangement 的 worker 所属的系统乐手，永不可寻址，M6 [wf]）, `ownership`, `hostKey`（DSH：项目 + 预设 + teamMode，再加乐器类别 [cu]；桌面 host 的 `hostKey` = musicianId [dcu]）, `inbound`（入站策略：按权限类别 accept / hold / refuse，只有人能改，A6 [arch]）, `handoffAcl`（第 9 步的 LLM 可以把活交给谁，A11 [arch]）, `laneContract`（车道契约：owns / does-not-own / 聊天预算 / handoff，A18 [arch]）, `instruments{browser: off\|look\|act, desktop: none\|lease, grantIds[]}`（乐器模式，§10.13 [cu]） |
| **Part（乐章）** | `id`, `musicianId`, `seq`, `ref{backendId, sessionId}`（dsh-TUI 的全局身份 [tui]）, `configRoot`, `cwd`, `harnessVersion`, `status`（`starting`、`idle`、`running`、`requires-action`、`disposed` [tui]）, `stateConfidence`, `handoffNote`, `endReason`（`rotate`、`crash`、`budget`、`user`、`handed-back`）, `proc{pid, createdAt, jobId}`, `sourceCursor`, `contextPressure`, `attempt`（每次 resume / fork 计一次尝试，对应 Grok Build 的 `AttemptId` [arch]）, `taintSticky`（粘性污染，E6 [cu]）, `leaseId`（当前持有的乐器租约 [cu]） |
| **Clone（分身）** | `id`, `partId`, `parentCloneId`, `nativeId`（`parent_tool_use_id`、spawn edge 或 DSH catalog id）, `depth`, `status`（`running`、`inactive`、`done`、`orphan`）, `groupId`, `phase`（原生工作流运行的分组与阶段，画成分身组，M2 [wf]） |
| **Exchange** | `exchangeId`, `requestId`, `parentExchangeId`, `workId`, `rootId`, `from`（含 `kind`：`musician`、`arrangement`、`human-resend` [wf]）, `to`, `role`, `op`（请求的操作，A4 [arch]）, `delivery`, `replyTo`, `wake`（`turn` 或 `none`，A3 [arch]）, `replyFormat`（`none` 或 schema [arch][wf]）, `hop`, `deadline`, `trust`（新增 `runtime` [arch]）, `taint`（`clean` 或 `tainted`）, `provenance[]`（新增 `browser:<origin>`、`screen:`、`sandbox` [cu]）, `bodyRef`, `state`, `receipts[]`, `resumed` |
| **Work** | `id`, `exchangeId`, `owner`, `children[]`, `heldReply`, `bounceCount`, `deadline`, `executionPartId`（每个 Work 一个执行者：自身的唤醒合并，其它的延后，steer 到达正在执行的乐章，A8 [arch]）, `stallCount`, `checkInAt`（回访与停滞计数，A9 [arch]） |
| **Task** | `id`, `projectId`, `source`（`orchestra`、`dsh-team`、`claude-team`、`codex-plan`）, `owner`, `deps[]`, `revision`（CAS）, `doneCriteria`, `roundCap`, `staleSince` |
| **InboxItem** | `id`, `projectId`, `kind`（approval、question、decision、failure、runaway、polling、bounce、orphan、stale-task、two-writers、policy、ready-for-review、route-ask、unknown-outcome、reminder、flood；新增 stalled-delegation、rotation-breaker、budget-incident、held-message、musician-request [arch]，workflow-run、arrangement-paused [wf]，lease-request、lease-expired、handoff [cu]，级别见 §6.5）, `severity`（P0–P3）, `dedupKey`（含发送者）, `partRef`, `deepLink`, `evidence[]`, `state`, `snoozeUntil`, `timeoutPolicy`, `requestDigest`（审批：规范化参数的 sha256）, `actionClass`（审批：动作类别，也是 A5 拒绝升级的键 [arch][cu]）, `elementDigest`（审批：代理在自己的快照上算出的目标元素摘要，变了即失效，A32 [cu][dcu]） |
| **Decision** | `id`, `projectId`, `question`（agent 写的题干只作为数据引用）, `options[]`, `askedBy`, `status`（`pending`、`resolved`、`superseded`）, `choice`, `rationale`（只能由你写）, `resolvedBy`（永远是人）, `gitHead`, `adrPath` |
| **Reminder**（v2 = 例程 Routine，A19，M3 [arch]） | `id`, `projectId?`, `target`（`human` 或 `musician`）, `text`, `dueAt`, `rrule?`, `linkedItem?`, `createdBy`, `trigger`, `expiresAt`, `quietHours`, `pauseAfterAuthFailures`；载荷只是数据；每乐手 ≤50 条，保留最近 20 次运行，每次唤醒 ≤25 个事件（v2 字段与数值为 GBR 重建件，Q-A） |
| **RouteDecision** | `decisionId`（sha256）, `input`, `taskClass`, `candidates[{id, rejection}]`, `chosen`, `confidence`, `reason`, `mode`（`manual`、`shadow` 或 `active`）, `overriddenBy` |
| **LedgerEntry** | 幂等 `id`, `partRef`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`（都可为空；未知就是 null，绝不记 0 [own]）, `costCny` 加估算标记, reserve / settle, `purpose`（这次调用的目的，A14 [arch]）, `rootId`（成本上卷到 root [arch]）, `imageTokens{estimated}`（图片 token，E11 [cu]） |
| **Event** | `partRef`, `seq`, `ts`, `kind`（含 M0 的 `edge`）, `digest`, `snippetRef`（指向可清除的片段表）, `sourcePtr`。原始 transcript 留在原地，Orchestra 只存指针 |
| **Command** | `id`, `requestId`, `target`, `verb`, `issuer`, `status`, `receipt` |
| **Room**（M3，本文补充，字段取自 bot-a2a 提案） | `id`, `projectId`, `name`, `adminMusicianId`（由人设定 [arch]）, `members[]`, `mode`（`admin` 或 `everyone`；`everyone` 是否交付见 Q-D）, `relayCap`（M4 导入的 DS-Bot 声部用 members×3，DS-Bot 的数字；Orchestra Rooms 以下列 A10 上限为默认，§10.7）, `lastHumanAt`；上限 `maxMembers`（6）、`maxRounds`（3）、`maxMemberTurns`（10）、`messagesPerTurn`（2）（A10 [arch]；数值为 GBR 重建件，Q-A） |
| **Grant**（M2 [cu]） | `id`, `label`, `loginUrl`（由你输入）, `origins[]`（含 IdP）, `mode`（`look` 或 `act`）, `profileId`, `musicians[]`, `expiresAt`, `createdBy`（永远是人）。一次 SSO 登录会解锁 IdP 后面的所有应用，所以 Grant 按 IdP 授予并显式列出 origins（§10.14） |
| **Lease**（M1 的 Tier 0 由运行时授予 [cu]，推断；Grant 绑定与 Tier 2/3 在 M2；`actuator` 随 Tier 2，M3 [dcu]） | `id`, `instrument`（`browser-profile:<grantId\|musicianId>`、`desktop`、`sandbox:<slot>`）, `holder{musicianId, partId}`, `tier`, `expiresAt`, `idleReleaseAt`, `reason`, `grantedBy`（`runtime` 或 `human`）, `nonce`, `state`（状态机见 §10.14）, `actuator{pid, createTime, jobId, driverVersion, manifestDigest}`（桌面驾驭器进程；每个租约一个新进程） |
| **BudgetIncident**（M2 [arch][wf]） | 每（策略、阈值、窗口）只开一条：`id`, `policyId`, `threshold`（80% 软 / 100% 自动暂停）, `window`, `rootId`（成本上卷到此）, `state`, `openedAt`（A14；字段名为本文补充） |
| **ArrangementRun**（M6 [wf]） | `id`, `lineageId`（「带修改恢复」后不变；有调用在途或为 `unknown` 时拒绝恢复）, `scriptDigest`, `authoredBy`（agent 编写的脚本会污染每次调用）, `args`, `budget`, `stop`（`meta.stop` 的组合条件，§8.8）, `status`, `startedBy`（建议只有人，待 Q-W1；无人值守启动是非目标） |
| **ArrangementCall**（M6 [wf]） | `runId`, `path`（确定性的调用点路径 phase / stage / itemIndex / occurrence）, `key`（`v1:sha256(canonical{target, templateDigest, harnessVersion, prompt, opts})`）, `occurrence`, `target`, `exchangeId`（每次调用本身就是一条 Exchange）, `outcome`（`ok`、`timedOut`、`denied`、`schemaInvalid`、`unknown`、`cancelled`、`budgetPaused`、`late`）, `resultDigest`, `resultRef`；`requestId = arr:<lineageId>:<path>#<occurrence>` |

一个 `rootId` 下的整棵 Exchange 树就是一次 **Run**，也是 Score 回放和导出的单位。每张表在首次用到它的里程碑里通过迁移创建（D1）。

**脱敏与可清除性**（评审补充）：
1. 三层脱敏：
   - 已知值精确替换：Orchestra 自己注入的 DSH key、粘贴进来的 token、守护进程自身环境变量的值。
   - 格式规则：`sk-`、`sk-ant-`、`ghp_` / `github_pat_`、`AKIA`、JWT、PEM 块、`Authorization:`、`token=` / `password=`、连接串，再加高熵检测。
   - 整段丢弃：`env`、`printenv`、`Get-ChildItem env:`、读取 `.env*` 的工具输出不保留片段。
2. journal 只对摘要做哈希链；片段和 A2A 正文放在一张可清除的表里，默认 TTL 14 天，并提供「清除秘密」命令：写入 tombstone、保留摘要，链不断。
3. 黄金 fixture 要么合成，要么经清洗脚本处理并人工复核；fixture 目录默认 gitignore；CI 跑 gitleaks。你的仓库会公开在 GitHub 上，私有代码和 token 不能进 fixture。
4. Arrangement 非终态运行的结果正文（`ArrangementCall.resultRef`）钉住，不受第 2 条的 14 天 TTL 和「清除秘密」影响；钉住的正文若仍被清除，运行转为 `unresumable` 并生成一条 InboxItem，绝不以 `null` 继续（M6）[wf]。

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
  Musician ||--o{ Lease : holds
  Grant ||--o{ Lease : unlocks
  ArrangementRun ||--o{ ArrangementCall : issues
  ArrangementCall }o--o| Exchange : "is a"
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
drafted → accepted(journal) → queued(governor) → delivered → read → working → replied
   │               └→ held(入站策略) → queued（你放行，或策略允许）│ refused(held-expired)
   └→ refused   （cycle | hop cap | relay cap | trust | 地址拒绝码 | policy | relay-source-missing）
                   └→ timedOut（deadline → InboxItem） │ cancelled │ unknown
replied 的变体：replied(suppressed)   （回复只含致谢：作为回执到达，不唤醒目标）
```

地址只能是乐手 id（A1 / D14）：Part id（包括 `replyTo` 里的）一律重解析到该乐手当前的乐章；邮件寄给乐手而不是乐章，乐章释放后仍会送达。`accepted` 一经写入 journal 就先于 `delivered` 成立，之后即使乐章已释放、守护进程中途崩溃，也只投递一次（A2）。接纳结果与回复投递分开报告：`orchestra_send` 返回 `admission: queued|steered|held`，出错时附 `sentBeforeError`，表示错误发生在接纳之后、消息已在 journal 里，不会重发（`sentBeforeError` 的语义取自 Codex mailbox，推断）[arch]。

| 状态 | 含义 |
|---|---|
| `accepted` | 已写入 journal，先于 `delivered`；从这一刻起消息属于目标乐手，乐章释放或守护进程重启都不会丢它（A2）[arch] |
| `queued` | 被 governor 挡住，或目标正忙、由 Orchestra 排队 |
| `held` | 被目标乐手的入站策略暂扣（A6）：只有 agent 在等的 hold 5 min 过期；等你放行的 hold 跟审批超时（Q4）走，专注模式下暂停计时；每乐手 ≤100 held [arch] |
| `delivered` | 投递调用已成功返回，或重启后在目标日志里核对到了这条消息 |
| `read` | 目标的某个回合已经带着这条消息开始（证据见 §8.2；不是"已投递"就算已读） |
| `working` / `replied` | 目标在处理；回复信封已生成 |
| `replied(suppressed)` | 回复只含致谢（发送者设了 `replyFormat:'none'`，或正文很短且没有 refs）：作为回执到达，不唤醒目标；等待方的 `orchestra_wait` 照常返回 `replied`，所以等待永不挂住（A3 / D16）[arch] |
| `refused` | 撞上循环、跳数上限、转发上限或信任规则，或下表的拒绝码 |
| `timedOut` | 超过 Work 的截止时间，生成一条 InboxItem |
| `unknown` | 投递结果不确定，且自动核对失败（§8.3）。**绝不重发**，并生成一条 InboxItem 请你核对；你可以一键手动重发 |

**拒绝码**（邮局层；§9.2 第 5 步的路由拒绝码另列；乐器代理层另有自己的一组：`no-lease`、`no-approval-route`、`stale-approval`、`ambiguous-target`、`busy`，见 §10.15–10.16）：

| 拒绝码 | 含义 | 来源 / 上线 |
|---|---|---|
| `raw-session-id` | 用原始的会话 id 当地址 | [arch] A1，M1 |
| `stale` | 目标乐手已归档 | [arch] M1 |
| `foreign` | 目标不属于 Orchestra | [arch] M1 |
| `unresolved` | 名字解析不到任何乐手 | [arch] M1 |
| `clone-not-addressable` | 分身不是地址（D2）。这是 Orchestra 的政策，不是业界共识：Grok Build 会给普通子代理寻址 | [arch] M1 |
| `template-not-addressable` | 模板乐手不是地址 | [arch][wf] M1 |
| `policy` | 被目标的入站策略拒绝（A6） | [arch] M2 |
| `held-expired` | 暂扣过期（A6），生成 P2 `held-message` | [arch] M3 |
| `relay-source-missing` | Arrangement 的 `to:` 调用指向还没有 relay-source bundle（即 §12.1 的 M3 Orchestra bundle，以非 user 来源投递）的 DSH 乐手（§8.8） | [wf] M6 |

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

**新增种类**（级别按 §11.2 的分级逻辑，分组为推断，最终以 Q10 为准）：

| 种类 | 含义 | 级别 | 来源 / 上线 |
|---|---|---|---|
| `stalled-delegation` | 委托停滞：回访一次后仍无进展，累计 3 次停滞升级（规则 11，A9） | P1 | [arch] M3 |
| `rotation-breaker` | 轮换熔断触发：同一乐手每小时轮换超限，或遇到确定性失败（A13，§10.4） | P1 | [arch] M1 小时上限 |
| `budget-incident` | 预算事件：越过 80% 软阈值为 P2，100% 自动暂停为 P1；每（策略、阈值、窗口）只开一条（A14） | P2 / P1 | [arch][wf] M2 |
| `held-message` | 被入站策略暂扣的消息：等你放行的归入 Fermatas；只有 agent 在等的 hold 过期后出 P2（A6） | P2 | [arch] M3 |
| `musician-request` | agent 请求新建乐手或例程（`orchestra_request_musician`），由你批准；agent 不能自我复制（A17） | 待定（Fermatas） | [arch] M1 |
| `workflow-run` | 原生工作流运行超过 25 个 agent 或 1.5M token（§8.7） | P2 | [wf] M2 |
| `arrangement-paused` | Arrangement 运行因预算到 100% 而暂停；只有你能提高上限（§8.8） | P1 | [wf] M6 |
| `lease-request` | 侦察乐手请求 Tier 2/3 乐器租约；只有你能授予（D8，§10.14） | P1 | [cu] M2 |
| `lease-expired` | 租约到期，进入 `draining`，输入停止 | P2 | [cu] M2 |
| `handoff` | agent 把浏览器 / 桌面里的一步交还给你：凭据、支付、CAPTCHA、重新登录（E3）；只有你能结束这条目（A26） | P1 | [cu] M2 |

审批条目新增两个字段 [arch][cu]：`actionClass`（动作类别，也是 A5 的键：同一 `rootId` 下别处再出现同类动作时标「上游已拒绝」并升级，推断）和 `elementDigest`（代理在自己的新快照上算出的目标元素摘要；两阶段审批再调用时重新核对，变了即失效：浏览器随 §10.15 在 M2，R45；桌面绑定 A32 在 M4）。

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
| **原生 computer use** | 桌面应用的 pane（干净 profile）、Claude in Chrome（你的真实 profile）、桌面应用里的 CU；CLI 的 CU 仅 macOS、不在 `-p` 下、单会话。**自有乐手里没有**：pane 是宿主的 `type:"sdk"` 服务器（推断）。自有启动传 `--no-chrome`（E1）[cu] | 桌面应用的 `@oai/sky` 0.7.13（SendInput + UIA，会激活目标窗口）；浏览器插件经 `node_repl` / `cua_repl`。**自有乐手里没有**：需要桌面应用的管道与环境（未核实），派生的任务会丢失 `node_repl`（CX#49458）[cu] | `web_fetch`（匿名、只到公开页、不跑 JS、不能登录）；可挂载 playwright-mcp、chrome-devtools-mcp、stagehand 等 MCP。CU 包 = `dsh-computer-use` 注册表 + `cua-driver-mcp`（子进程，选用）/ `cua-driver-native`（进程内，否决）/ `cua-macos`（macOS，不提供）；桌面工具 host 全局、子代理继承、不排队；rc.2 一个也没带，只按精确版本 0.2.1-rc.2 钉（§7.4）[cu][dcu] |
| **截图到模型** | 内联，25k token 上限；原图存在 `tool-results` 下（`mcp.md:435,1526-1532`）[cu] | MCP image content [cu] | 需要声明图片输入的模型（默认目录里是 `deepseek-flash`，`DP\dsh-llm-deepseek\lib\index.js:42-54`）加 attachment store（dsh-base 挂载 `attachment-local`）；ACP 行自带的 `deepseek-v4-flash` 未入目录 → 纯文本（`dsh-acp-app\cordis.patch.yml:15-20`）。模型只见 `content`，永不见 `structuredContent`（`element_token`、`effect`、`delivery.mode`；`mcp-client/src/tools.ts:261-263`；DSH-D#7788 未关闭）[cu][dcu] |

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
- **工作流记录（M2，只读）**：Claude 的 `agent-*.jsonl` + `.meta.json`，脚本与保存的结果在会话目录下，`journal.jsonl`（来自工具描述，S3 后核实）；DSH 的 `tool-workflow/*` 事件。全部只读，路径经 §10.11 白名单核实后才读（§8.7）[wf]。
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
  2. 受保护路径：`.claude/**`、`.mcp.json`、`.codex/**`、`.dsh/**`、`cordis.patch.yml`、`.git/hooks/**`、`.vscode/tasks.json`、`package.json` 的 scripts、`.husky/**`。对这些路径的任何写入都进审批队列，并要求键入确认。r3 加入 `~/.orchestra`、各私有 `DSH_HOME` 与它们的锁文件（R35，§10.11 #7）[arch]。
  3. 零 token CI：乐手写入 allow 规则或 hook 之后，下一次 Bash 调用仍然进入审批队列。
- **私有 DSH home 组合 v1**（评审补充；dsh-acp-app 建立在 dsh-base 之上，自有乐手默认继承 dsh-base 的全部插件 [核验]）：

  | 插件 / 设置 | 处理 | 原因 |
  |---|---|---|
  | `goal-round-driver`、`tool-goal`、`command-goal` | 关闭，直到以非 user 来源投递落地（M3 bundle 或 S2 选 B） | ACP 投递被记为人类输入，任何 agent 消息都能开启自主轮次（§8.5） |
  | `tool-workflow` | 关闭，直到 governor 能看见它的派生（M2 观察，§8.7）；启用时钳制为 `maxConcurrentAgents ≤ maxActiveSubagents−1`、`maxTotalAgents ≤ 64`、`enableRunInBackground:false`，CI 检查（§8.7） | 并行扇出绕过 governor；后台运行会让乐章看起来闲置，§10.4 会把它关掉 [wf] |
  | `subagent.maxActiveSubagents` / `maxDepth` | 设为 governor 对该模型的 `perModel` 上限 / 1 | 超限时 DSH 报错而不排队，计为 `over-cap` 事件 |
  | `repeat-tool-reminder` | 保留，作为证据源 | §10.3 |
  | `dsh-schedule` | 不挂载（dsh-base 本来也没有 [核验]） | 发给乐手的提醒由 Orchestra 调度（M3） |
  | 遥测 | 启动时设 `DSH_TELEMETRY_DISABLED=1` | 默认导出到 deepseeksvc 的收集器（`dsh-base/cordis.patch.yml:208-225` [核验]） |
  | 权限 | 启动时显式设置 `DSH_PERMISSION_MODE`，不继承你的环境；合成后的配置里不得出现 `approval: never` | Full access = `danger-full-access` + `approval: never` [核验] |

  S2 输出合成后 `cordis.yml` 的快照；每次升级私有 DSH 版本时，CI 比对快照，出现新增 bundle 就失败。
- **自有 Claude 乐章的工作流**：R33 前关闭（`disableWorkflows` 或 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`，后备 SDK `disallowedTools`）；S3 验证生效。被静默拒绝的审批（DSH 工作流子代理钉在 `approvalPolicy:"never"`，DSH-D#11062）要浮现为收件箱条目，不能无声消失（§8.7）[wf]。
- **Windows 上的 DSH 沙箱**：EPERM 的根因是受限进程内以 `stdio:'pipe'` 再派生子进程（dsh-sandbox-windows-acl 的已知限制）；inherit / ignore stdio 与 PowerShell 匿名管道可用 [own]。S2 逐项测：`workspace-write`+`ask`、`read-only`+`ask`，以及（必须关闭沙箱时）自定义预设 `{sandbox: danger-full-access, approval: ask}` 是否仍会产生审批请求。
- **DSH 凭据**：私有 home 的凭据不能从 `~/.dsh/.credentials.yaml` 复制。建议（§17 Q2）：用一把 Orchestra 专用、可随时吊销的 API key，DPAPI 加密存在 `~/.orchestra`，经 `DEEPSEEK_API_KEY`（dsh-base 的 `apiKeyEnv`）只注入私有 host 的进程环境，不写入私有 home 的 `.credentials.yaml`。S2 要验证：私有 home 的凭据服务为空时环境变量生效；一次工具调用里执行 `env` / `Get-ChildItem env:` 能否看到 key（能看到就把这个值加入精确脱敏）。
- **同一 host 内的乐手互相可见。** 同一个 DSH host（同一个 `DSH_HOME`）里的乐手可以互读日志，也共享进程内存；需要 R13 隔离或单独限制 RSS 的乐手，单独开一个 host。
- **乐器与原生 CU（E1、D18）**：自有 Claude 启动一律传 `--no-chrome`（`CCD/cli.md:110`）；每次乐章启动断言 `system/init.tools` 里没有原生 CU 的前缀（`mcp__Claude_Browser__*`、`mcp__claude-in-chrome__*`、`mcp__computer-use__*`、`mcp__remote-devices__*`），否则 P0。自有乐手的配置里绝不出现 `--extension`、`--autoConnect`、Claude in Chrome 或 Codex `claimTab`；UI 用的 profile 不装 agent 扩展、不开 CDP（E5）[cu]。
- **DSH 侦察乐手预设**：`read-only` 沙箱 + `approval: ask`（dsh-base 的这个预设只路由沙箱升级请求，`DP/dsh-base/cordis.patch.yml:259-270`）、无 shell（E6），自己一个 host。若 Q-DC0 选 DSH 做桌面侦察 host：profile 关闭九个委派行（`subagent` 等，`DP/dsh-base/cordis.patch.yml:359-407`）；`hostKey` = musicianId；orchestrad 是它唯一的 ACP 对端，只发一次 `session/new`、永不 `session/resume`（`acp/acp/src/index.ts:189`），新乐章即重启 host；模型用声明了图片输入的 `deepseek-flash`（Q-C8）；`orchestra-desktop` 只经 `session/new{mcpServers}` 按 Agent 挂载、不落盘，环境里带每乐章轮换的 `ORCHESTRA_PART_NONCE`（§10.16）[dcu]。
- **DSH CU 包只按精确版本钉**：`0.2.1-rc.2`。把 `latest`（0.1.6-alpha.1）列进 `dsh.profile.bundles` 会让启动失败（DSH-D#6788）；rc.2 不含任何 CU 包。需要时只接 `cua-driver-mcp`（子进程）这条路，`cua-driver-native`（进程内，崩溃即杀 host）否决，`cua-macos` 不提供；MCP 提供者本身不钉二进制，所以驾驭器的钉版由 Orchestra 自己做（§10.14 三重校验）[dcu]。

---

## 8. A2A 总线：Post Office

### 8.1 信封（v1）

M0 观察到的边作为 Event（`kind: edge`）保存，形状与信封相同，只是带 `observed: true`；Exchange 表在 M1 创建。r3 新增的字段（`from.kind`、`op`、`wake`、`replyFormat`、`trust: runtime`，以及新的 provenance 与 refs 前缀）都是向后兼容的追加 [arch][wf][cu]（本文补充：它们都是可选字段，信封版本号仍为 1）。

```json
{ "v":1, "exchangeId":"", "requestId":"", "parentExchangeId":null, "workId":"", "rootId":"",
  "from":{"musician":"","part":"","harness":"","bound":true,"kind":"musician|arrangement|human-resend"},
  "to":{"musician|section|project":"", "mentions":[]},
  "role":"request|reply|notice|progress|stop", "op":"queue|steer|interject", "delivery":"steer|queue",
  "replyTo":"sender|user|room", "wake":"turn|none", "replyFormat":"none|{schema}",
  "hop":0, "deadline":"ISO", "trust":"human|agent|unbound|external|runtime",
  "taint":"clean|tainted", "provenance":["exchangeId|url|path|browser:<origin>|screen:|sandbox"],
  "body":"≤64 KiB", "refs":["file@commit","taskId","decisionId","shot:<id>"], "createdAt":"" }
```

| 字段 | 说明 |
|---|---|
| `requestId` | 按发送者划分作用域的幂等键（规则 5）。Arrangement 的调用用路径派生的 `arr:<lineageId>:<path>#<occurrence>` [wf] |
| `parentExchangeId` / `workId` / `rootId` | 委托树的结构，用于暂扣回复、拒绝循环、按 root 计转发次数 |
| `from.bound` | 是否经守护进程核实的通道归因（不是认证，见 §8.5） |
| `from.kind` | `musician`：绑定乐章里的乐手；`arrangement`：Arrangement 运行发出的调用（M6）；`human-resend`：你对 `unknown` 结果的手动重发，是运行之外的一条新 Exchange [wf] |
| `op` | 请求的操作。agent 只能 `queue` 或 `steer`；`interject` 一类的中断只有人能发，agent 发起的中断被拒绝（A4 / D15）[arch]。取值集合为推断，对应 Grok Build 信封的 `OperationSet` |
| `delivery` | `steer` 插进当前回合；`queue` 排到下一回合 |
| `wake` | `turn`：投递后唤醒目标一个回合；`none`：只放进上下文，不唤醒。notice 为 `none`；只含致谢的回复作为回执到达，不唤醒（A3 / D16）[arch] |
| `replyFormat` | `'none'`：不需要回复，对方若回复只算致谢；`{schema}`：要求 JSON 回复并校验，校验失败给一次修复回合，再失败记 `null`（Arrangement 的 worker 用，§8.8）；缺省为自由文本 [arch][wf] |
| `hop` / `deadline` | 规则 6 和规则 8 |
| `trust` | `human`、`agent`、`unbound`、`external`，新增 `runtime`：守护进程计算出的文本（如 Arrangement 的提示）；永不携带人类权威，agent 代码也构造不出它（A4 / D15）[arch][wf] |
| `taint` / `provenance` | 来源追踪（§8.5）。provenance 新增 `browser:<origin>`（浏览器乐器的 navigate / snapshot / screenshot）、`screen:`（桌面）、`sandbox`（一次性桌面）[cu] |
| `body` | 上限 64 KiB，与 DSH 团队消息上限一致 [req]。回复是薄完成，超长正文截断并标 `truncated`（规则 1）[arch] |
| `refs` | 新增 `shot:<id>`：截图只传引用，agent 不转发图片（E7）[cu] |

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

每一行的投递都在 `accepted` 入 journal 之后才发出，所以乐章释放或守护进程中途崩溃都不会丢消息（A2 [arch]，§6.3）。

### 8.3 Post Office 规则

| # | 规则 | 说明 | 来源 | 上线 |
|---|---|---|---|---|
| 1 | **自动回信** | 消费某个请求的回合结束时，它的最终文本成为 `reply`。DSH 以 prompt settle 为准。回信是**薄完成**：状态 + 有界摘要 + refs，超长正文截断并标 `truncated`（A16） | [bot][arch] | M1 |
| 2 | **暂扣回复** | 回复要等所有子 Work 都结束 | [bot] | M3 |
| 3 | **拒绝循环** | 给一个正在等同一 Work 的上游乐手发消息会被拒绝 | [bot] | M3 |
| 4 | **合并** | 同一发送者的未读消息合并成一条；去抖 8 s，@ 提及 1 s；窗口内的消息以 `collect` 收齐后一次投递（A10） | [bot][arch] | M1（合并）；去抖与 `collect` 随 A10 在 M3 |
| 5 | **`requestId` 幂等** | 按发送者划分作用域。同 id 同内容：重放原回执；同 id 不同内容：拒绝；结果为 `unknown` 的绝不自动重发 | [bot]；"绝不重发"来自 adaptive-router `OUTCOME_UNKNOWN` [own] | M1 |
| 6 | **跳数上限** | 默认 4 | 新增 | M1 |
| 7 | **每 root 转发上限** | 默认 20（假设）；对 A2A Exchange 保持硬限，Arrangement 调用另用独立的 `arrangementCalls` 上限 64（§8.8 (c)，M6）[wf] | 新增 | M3 |
| 8 | **每 Work 截止时间** | 默认 30 min，超时生成 `timedOut` InboxItem | 新增 | M1 |
| 9 | **沉默与唤醒** | `reply`、`notice`、`progress` 不开新的 Work，也不自动回信；`wake: turn\|none`，notice 为 `none`；只含致谢的回复作为回执到达（`replied(suppressed)`），不唤醒，等待方照常收到 `replied`；什么都不丢（A3 / D16） | [arch] | M1 |
| 10 | **按当前策略重新接纳** | 端点是（乐手，项目，入站策略），不是乐章：崩溃时 Job 会杀掉自有乐章（§5.4），重启后按目标**当前**的入站策略重新接纳；输入 id 复用，发送者永不重跑；策略已撤销则 `refused`，完好则恰好恢复一次（下表 (b)）（A7） | [arch] | M2 |
| 11 | **回访** | 委托经过 N 次交换或 T 分钟仍无进展时，唤醒提问者一次并生成 InboxItem；「没有进展」= 没有新的 diff、测试、ref 或 Decision；累计 3 次停滞升级为 P1 `stalled-delegation`；绝不自动重新规划（A9；N / T 待定，§17） | [arch] | M1 回访，M3 停滞 |

每个 Work 只有一个执行乐章（`executionPartId`，A8 [arch]，M3）：自身的唤醒合并、其它延后，steer 投到正在执行的乐章；排队中的 Exchange 在乐手页可编辑（R31，M1）。

**重启后按投递阶段处理**（评审补充，解决"恢复一次"和"绝不重发"的冲突）。守护进程崩溃时，Job 会杀掉所有自有宿主，所以在途回合都是"被打断"，而不是"在没人看的时候结束"：

| 阶段 | 处理 |
|---|---|
| (a) 投递调用还没有返回 | 先自动核对：在目标会话的日志里查找头部的 exchange 标记（DSH v4 日志、Claude transcript；候选 B 还可以用同一 `requestId` 重发，宿主按已提交的 `user/message` 去重 [core]）。找到就记为 `delivered`，进入 (b) 或 (c)；找不到就记为 `unknown`，**绝不自动重发**，生成 `unknown-outcome` InboxItem |
| (b) 已 delivered，但回合被 Job 杀断 | 用 `session/resume`（Claude 用 `resume`）恢复会话，只发一次固定的「继续上一回合」提示（不重发原始正文），journal 记 `resumed: true`；再次被打断就转为 `unknown` |
| (c) 回合在日志里已经结束 | 按日志结算，生成回信 |

这三个阶段在 Grok Build 的投递核心里叫 Pending / Projecting / Delivered，Orchestra 沿用同一划分 [arch]。Arrangement 调用的 `unknown` 对该次 occurrence 是终态，replay 不会重试它；你手动重发得到的是运行之外的一条新 Exchange（`from.kind: human-resend`），结果交给你，永不进入 replay [wf]。

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
- **类型化权威，一个字段（A4 / D15）[arch]。** `trust` 就是权威类型，不另设 `principal`：`human` = 配对的 UI；`agent` = 绑定的乐章；`unbound` = 没有乐章的同用户进程；`external` = 导入的外部消息；`runtime` = 守护进程计算出的文本（如 Arrangement 的提示）。agent 代码构造不出 `human` 或 `runtime`；agent 只能 `queue` 或 `steer`，`interject` 一类的中断是人类专属，agent 发起的中断被拒绝；消息是带归因的数据，绝不以 `system` 身份注入（Letta 是反例）；以 `user` 来源到达 DSH 只是 M1 走 ACP 期间的已知例外（见上文对策与 §15），M3 bundle 改为 relay 来源后消失。M1。
- **权威链卫生（A5）[arch]。** 转发或计算出的文本永不携带人类权威；拒绝不可转发。拒绝记在 `rootId` 上（推断）：同一根下别处再出现同类动作（`actionClass`）时，卡片标「上游已拒绝」并升级。任何 CLI 都没有 approve / resolve / kill（D8、§10.11 #4）；CLI 的 `send` 走 agent pipe，否则是 `unbound`；`ORCHESTRA_PART` 环境变量只是 UX 提示，去掉它什么也得不到。M2。
- **每乐手入站策略（A6）[arch]。** `inbound` 按权限类别设 accept / hold / refuse，只有人能改，agent 改策略被拒绝。只有 agent 在等的 hold 5 min 过期（P2 `held-message`）；等你放行的 hold 跟审批超时（Q4）走，专注模式下暂停计时。每乐手 ≤100 held、≤50 queued；重复消息丢弃；发送成功 ≠ 对方可见。M2，hold 在 M3。
- **`orchestra_send` 是特权操作。** 有限速；发送者的权限预设低于目标（例如只读乐手发给可写乐手）时，消息先进收件箱等你放行。`orchestra_report` 只能写调用者自己的状态。
- **来源追踪（taint）。**
  - 一条消息或一个回合是 `tainted`，当它的来源链里有：`external` 或 `unbound` 发送者；抓取过的 URL；读取过项目根目录之外或 `node_modules` / vendor 目录里的文件；第三方 MCP 工具的输出。来源链记录在 `provenance` 里（exchangeId → 发送者 → 发送者自己的污染源）。这是尽力而为的启发式，界面上如实标注。
  - 同一项目里、来源链干净的自有乐手之间的消息是 `clean`（但仍是 `trust: agent`）。
  - 任何由 agent 消息触发的回合，审批卡片顶部都显示触发它的来源链；tainted 回合用红条，并且 shell、网络访问、cwd 之外的写入都要键入确认。
  - tainted 回合期间收紧权限：Claude 乐章暂停 Orchestra 预先放行的规则，`canUseTool` 一律询问；DSH 的预设不能按会话切换（§10.10），所以发往可写预设 DSH 乐手的 tainted 消息先进收件箱等你放行；Codex（M4）在 `turn/start` 时使用 untrusted 审批策略。
  - **粘性 taint（E6）[cu]。** 乐器带来的污染是粘的：navigate、snapshot、screenshot 都污染乐章，`provenance` 记 `browser:<origin>`（桌面记 `screen:`，一次性桌面记 `sandbox`）；新乐章若 `handoffNote` 来自污染乐章，或乐手持有 mode ≠ off 的 Grant，则一开始就是 tainted（`taintSticky`）；闲置释放不清除；清除需要你的有据动作，或带运行时生成的结构化交接笔记的轮换加 profile 重置。乐器只给 `kind: scout` 的侦察乐手；污染乐章只能经两阶段审批（浏览器，§10.15）或 Q-DC7 选定的路线（桌面）行动（R43）。
- **正文只当纯文本显示，不执行其中的指令或链接**（§5.3 渲染规则）。
- **`external` 有门控。** 它只来自默认关闭的 A2A 1.0 网关，投递前先进收件箱等你批准。

### 8.6 `orchestra-mcp` 工具（调用形状参照 hermes `mcp_serve.py` [own]）

**没有**任何批准、拍板、改权限或改配置的工具。也没有授予租约的工具：`orchestra_request_lease` 只是请求（D8）[cu]。

```
orchestra_whoami() -> {musicianId|null, partId|null, bound}                          M1
orchestra_list_musicians(project?) -> [{id,name,role,harness,state,project}]         M1
orchestra_send(to, body, role="request", delivery="queue", reply_to="me",
               request_id?, refs?, deadline_s?, wake?, reply_format?)
   -> {exchangeId, admission: queued|steered|held, code?, sentBeforeError?}  (bound only) M1
orchestra_request_decision(question, options[], context?) -> {decisionId}            M1
orchestra_get_decisions(project?, status="resolved") -> [Decision]                   M1
orchestra_remind(at, text, target="human") -> {reminderId}                           M1（target=musician 在 M3）
orchestra_report(state, note, refs?) -> {journalId}   (R15; caller's own state only) M1
orchestra_request_musician(spec) -> {itemId}   (只生成 InboxItem；A17)                M1
orchestra_request_lease(instrument, mode, reason) -> {leaseId, state}
   (request-only；Tier 2/3 只有你能授予)                                            M2
orchestra_wait(exchange_ids[], timeout_ms≤600000)
   -> {id: settled|timedOut|aborted|notStarted|unknown}                              M3
orchestra_claim_task(taskId, expectedRevision) / orchestra_update_task(taskId, expectedRevision, patch)  M3
orchestra_post_room(roomId, body)                                                    M3
orchestra_read_part(partId, query)   (own parts only; ACL; every read journaled)     M5
```

- `orchestra_send` 只对已绑定（bound）的调用者开放，规则见 §8.5。
- `orchestra_send` 的返回值报告**接纳**而不是回复：`admission` 为 `queued`、`steered` 或 `held`；`code` 为 §6.3 的拒绝码；`sentBeforeError` 标明消息已接纳、之后才出错，不会重发（A2）。`wake` 与 `reply_format` 对应信封的 `wake` / `replyFormat`（§8.1），缺省由 `role` 推导：请求唤醒一个回合，通知不唤醒（推断；是否按角色自动回信见 Q-B）[arch]。
- `replyFormat:'none'`，或正文很短且没有 refs 的回复 = 只致谢：作为回执到达，不唤醒对方（规则 9）[arch]。
- **配额**（评审补充）：agent 创建的提醒和决策默认 P3，只进摘要；每个乐手每天最多 5 个决策、10 个提醒；`dedupKey` 里包含发送者；配额用完后生成一条 P2「某某乐手刷屏」（`flood`）条目。
- `orchestra_request_musician(spec)` 只生成一条 `musician-request` 条目，乐手或例程由你批准后才创建；agent 不能自我复制（A17）[arch]。
- `orchestra_request_lease` 只是请求：Tier 0 由 Governor 按 `instruments` 预算在运行时授予，Tier 2/3 只有你能授予，经 MCP 授予一律拒绝（D8）。lease-request 计入上面的 flood 配额；被拒绝的请求按（乐章，乐器）粘住，直到你清除，期间的重复请求自动拒绝并合并成一条 P2 `flood` [cu][dcu]。
- 模板乐手（Arrangement 的 worker，§8.8）只拿到 `orchestra_report`，拿不到 `orchestra_send` 和其它工具（CI 断言）[wf]。
- `orchestra_wait` 的形状参照 dsh-apollo 的 `wait_subagent`，但**只借鉴设计**，不复用代码，因为那份代码是 GPL-3.0 [land]。
- 写进每个乐章的默认指引是：**"结束你的回合，回信会唤醒你。"**（"End your turn; the reply will wake you."）`wait` 只留给真正的 AND-join。
- Claude 进程内 MCP 和 DSH `session/new{mcpServers}` 的注入由 S3 / S2 端到端验证；Codex app-server 能否接受注入的 MCP 配置在 M4 的受控实跑中验证（假设）。

### 8.7 原生工作流：第一层（M1–M3）

**立场。** 调研过的五个引擎都把工作流限定在一个会话之内，多数默认派出一次性的、不能被寄信的 worker（OpenClaw Swarm、Grok Build、Claude Code）。两个例外：DSH 的本地子代理有目录，常驻期间可以收消息（`dsh-workflow-ptc\README.md:71`；`dsh-subagent\README.md:61,123`）；letta-code 能在同一父会话内按 `conversationId` 恢复 worker。因此「分身永不作为 A2A 地址」（D2）是 Orchestra 的策略，不是 harness 的事实 [wf]。一次原生工作流运行就是某个乐手乐章内的一次 Run，画成一个分身组（Clone 的 `groupId`、`phase`，§6.1）。Orchestra 对它只做三件事：M1 钳制（R06 的验收项）、M2 观察、M3 治理（R33：接纳、截止时间、预算、绝不自动重启）[wf][arch]。

**五个引擎对照**（[wf]；「工具描述」指来自 Claude Code Workflow 工具文本、未与 `CC-W` 文档核对的事实）：

| 维度 | Claude Code | DSH 0.2.1-rc.2 | Grok Build `xai-workflow` | letta-code | OpenClaw Swarm |
|---|---|---|---|---|---|
| 脚本 | JS + `export const meta` | JS；JSON `meta`，词表「与 Claude Code dynamic-workflows 的 meta 块一致」（`dsh-workflow\lib\types\types.d.ts:36-37`） | Rhai；`meta` 在前 | `agent/parallel/pipeline/decide` | JS Code Mode 里的 `agents.run()` |
| 上限 | 默认 16 并发，环境变量可设 1–256；每次调用 4,096 项；每次运行 1,000；>25 个 agent 或 1.5M token 只给提示性警告 | min(16, 核数−2)；总计 1,000；「协作式」（`dsh-workflow-ptc\lib\index.js:631`） | 128 次调用（最多 1,024）；32 并发；每会话 4 次运行 | 运行：16 并发、1,000 agent、1,000 次 `decide()`、1,000 次脚本工具调用、4,096 项。worker：10 min、1,000 次工具调用、3 次相同即停 | 32 / 50 / 200；wait ≤600 s |
| 预算 | `budget{total,spent(),remaining()}`（工具描述，未核实） | 无 | `budget()` 是写入 journal 的宿主调用 | 未涉及 | 未涉及 |
| 引擎与恢复 | 异步 JS。同会话内按 agent 启动顺序重放；第一个改动的 prompt 及其后的每个 agent 重跑；`Date.now` / `Math.random` 抛错 | 不能恢复 | 同步：`parallel([specs])` 按数组顺序分配 seq；没有 `pipeline` / `race`；`timestamp()` / `sleep()` 报错。journal 记 `(seq,kind,req_hash,result)`，调用不同即 `Divergence` | 只有调试 journal，「什么都不重放」 | 未涉及 |
| 子代理 | subagent；运行中不能输入 | 本地可继续子代理：有目录、常驻时可收消息、销毁后 `NOT_RESUMABLE`；占用激活槽（`README.md:71` 与 `:53` 相互矛盾，按 `:71`）。provider 按注册固定，每次调用可覆盖 `provider` / `model` | 工作流子代理不可寻址；普通子代理可寻址 | 默认一次性；`conversationId` 可恢复同一父会话的无 agent worker | 一次性；不可 steer |
| 审批 | 脚本提示不算用户请求（自动模式）；运行遇到 agent 权限提示即暂停 | 子代理钉在 `approvalPolicy:"never"`，静默拒绝（DSH-D#11062） | 暂停类型含 `NoProgress`、`BackOff`；`await_user()` | 未涉及 | collector 拒绝审批；Lobster 带恢复 token 停下 |
| 记录 | `agent-*.jsonl` + `.meta.json`；脚本与保存的结果在会话目录下；`journal.jsonl`（工具描述，未核实） | 只有 run / agent 的起止；UI「只有身份与状态」 | 阶段 / 日志 / 遥测 | `<task-notification>` | 扁平分组；不保存定义，没有 DSL |

结论：运行处处是会话级的，上限写在代码里；多数引擎默认一次性 worker，但 DSH 与 letta-code 能继续它们。持久性各异：Grok Build 重放一个同步引擎并做分歧检查；Claude 在会话内按启动顺序重放；ADK / MAF 做检查点；Letta 与 DSH 不恢复。DSH 没有预算、journal 和 OR-join，不能当跨 harness 引擎 [wf]。

**野外出过什么事**（[wf]，来自社区问题）：
- **上限冲突或被绕过**：DSH 把 `maxConcurrentAgents` 自动设到 16，高于 `maxActiveSubagents` 的 8，`ACTIVATION_LIMIT_REACHED` 让运行失败（DSH-D#10655）；`maxDepth` 在工作流路径上不生效（DSH-D#7098）。Claude 的并发上限可由环境变量设到 256，大运行警告只是提示。
- **权威转发**：触发工作流的人类消息被当成覆盖性指令送进每个 `agent()`（CC#96640、CC#100033）。
- **非幂等重启**：一次按键重启了运行，杀掉活着的 agent、重跑已完成的、覆盖了文件（CC#86777）。
- **静默丢失**：一次网络抖动让 70 个 agent 里的 26 个死掉（CC#66686）；`agent()` 返回了另一个会话的内容（CC#96546）；输出被截断（DSH-D#10115）。
- **过度配置**：该用 6–7 个 agent 的地方用了 25 个，成本约 10 倍（CC#91532）。
- 模型重设边界类型（CC#67684）；子代理风暴靠工作流上限刹住（`v2ex.com/t/1228533`）；bot 不提示就不用工作流（DSB#420、DSB#421）。

**失败归属。** 模型负责一步之内的工作；脚本负责扇出、汇合与终止；人负责品味、审批与上限覆盖；守护进程负责接纳、预算与持久性 [wf]。对应关系：
- 脚本：第一轮的假「完成」（`dsh-tool-goal\README.md:55`）→ 新开校验者给出 schema 判定或跑测试命令；循环跑到 256 的上限（`dsh-goal\README.md:12,158`）→ 字面 K；静默的部分结果 → 完整性评审 + null 计数。
- 守护进程：上限之下没有进展（Magentic-One `max_stalls=3`）→ 停滞计数器；扇出成本 → governor、硬预算、R41 估算；激活崩溃 → 接纳队列与钳制；丢失或重复的运行 → journal + `requestId`，绝不自动重启；权威转发 → `trust: runtime`（R34）。
- 人：循环里的品味（R12）→ 经 `ask()` 变成 Decision；审批卡住（D8）→ 一个队列、超时即拒；打回 N=3（§10.7）。
- 模型：分解方式未知的目标 → 一个乐手内带上限的 goal 循环，外面包一层脚本化的校验者。

**M1 钳制（R06 的验收项）** [wf]：
- 私有 DSH home 里 `tool-workflow` 保持关闭（§7.4）。启用后钳制为 `maxConcurrentAgents ≤ maxActiveSubagents−1`、`maxTotalAgents ≤ 64`、`enableRunInBackground:false`，CI 检查。后台运行会立即返回（`dsh-tool-workflow\README.md:42,50`），乐章看起来闲置：§10.4 的闲置释放会 `close` 它并杀掉运行，邮局还会继续往里面投递，所以禁止后台运行。
- 自有 Claude 乐章在 R33 之前关闭工作流：`disableWorkflows` 或 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`（`CC-W`），SDK `disallowedTools` 只作后备。验证它生效是 S3 的 go 判据。
- 验收：钳制下 `parallel(12)` 在 12 核机器上出现 0 次 `ACTIVATION_LIMIT_REACHED`，`run_in_background` 被拒绝（WF-17）。

**M2 观察** [wf]：
- 解析 DSH 的 `tool-workflow/*` 事件和 Claude 的运行记录（§7.3），组装成带 Stage 卡片的分身组（阶段、成员、token、null 数；§11.3）。
- 常驻的 DSH 工作流子代理仍是分身（`inactive`）；回收器按 `maxActiveSubagents` 追踪它们占用的槽位（§10.4）。
- 扇出按事件计数，绝不按上限推算。25 个 agent 或 1.5M token → P2 `workflow-run` 条目。
- 记录路径只读，且只读经 §10.11 白名单核实过的路径。
- 验收：原生轨迹 fixture 生成的分身组计数一致；重启后绝不重启原生运行（WF-16）。

**M3 治理（R33）** [wf][arch]：
- 每次运行有截止时间与预算。越界时 cancel → close → resume（§10.4），保留乐手的上下文。
- 守护进程重启后绝不重启运行；InboxItem 写「中断，n/m 已完成」，并提供会话内恢复。
- Grok Build 的暂停类型映射到收件箱类型：`user` → `question`，`verification` → `ready-for-review`，`no_progress` → `runaway`，`back_off` / `infra` → `failure`。
- 原生运行从 M3 起以只读的 运行 → 阶段 → 成员 树显示（R16 的这一部分从 M5 提前到 M3；AND-join / 循环视图仍在 M5，Circuit 随 M6，§11.4）。

### 8.8 Arrangement：第二层（M6，M4 后 go/no-go）

**立场。** Arrangement 是 Orchestra 自己的跨 harness 工作流：一段确定性脚本，跑在 WASM 沙箱化的解释器里；它是邮局的**客户端**（`trust: runtime`），绝不是总线。于是每次调用都自带回执、`requestId` 幂等、上限、taint 与 governor 接纳，崩溃后重放不会重复投递（D13）[wf]。[wf] 的原报告叫它 "Score"，为避免与 §11.4 的 Score 页混淆而改名。
- **v0**：固定的只读模板（QA 复跑 ×N、对抗核验、评审裁决）加同步的 `parallel`。
- **v1**：具名乐手（`to:`）、`pipeline` / `race` / `quorum`、`ask()`、用户脚本、Maestro 提案（影子模式）。
- **为什么推迟**：r2 约 25 周（r3 含 Tier 2 约 33–35.5 周，不含约 30–32 周）的单人计划没有余量，M1 和 M3 已经是最重的两个里程碑（§13.3、§13.5）；Arrangement v0 约需 4–6 周（推断），放在 M6，M4 之后做 go/no-go。
- **分工**：乐手是「谁」来做；工作流是「一段有边界的工作怎样扇出」。Orchestra 不做图 DSL、声明式格式或编辑器，不让模型掌握终止，不做无人值守的启动（§3.2）。

**(a) 运行时与 API**
- **沙箱。** 编译到 WebAssembly 的 JS 解释器（例如 QuickJS-in-WASM），跑在 orchestrad 的一个子进程里；只有 Arrangement 的宿主调用跨过消息通道；没有 fs、net、timer、`Date`、`Math.random` 绑定；可选再加一个无网络的 AppContainer / LPAC token。原因：Job 只提供 kill-on-close 与计量（S4 procguard，§13.2）；Node 的权限模型不对恶意代码提供安全保证，也没有网络开关（nodejs.org v24 permissions，只核对了 v24）；`node:vm`「不是安全边界」（`dsh-workflow-ptc\README.md:158`）[wf]。
- **API v0**：`agent`、`parallel([specs])`、`phase`、`log`、`args`、`budget`。**v1** 加 `pipeline`、`race`、`quorum(k)`、`ask`、`to:`。
- **`agent(prompt, {template | to, label, phase, schema, deadline_s})`**：
  - `template:` 启动一个**模板乐手**（`kind: template`，每个模板一个系统乐手，永不可寻址：拒绝码 `template-not-addressable`）的 worker 乐章。模板由部署方拥有（「模型只提供数据，不能改动循环」，`dsh-tool-ralph\README.md:61`），v0 只读。QA 复跑模板复用 M1 QA 模板的预设与人设。
  - v1 `to:'Ren'`：一条 Exchange，`role: request`、`delivery: queue`、`trust: runtime`、`from.kind: 'arrangement'`，受入站策略、`executionPartId` 与并发 1 约束。ACP prompt 到 DSH 会被记为 `{kind:'user'}`（§8.5），所以 DSH 目标需要 relay-source bundle（即 §12.1 的 M3 Orchestra bundle，以非 user 来源投递），否则拒绝码 `relay-source-missing`。
- 模板 worker 拿不到任何 orchestra-mcp 工具，只有 `orchestra_report`（CI 断言），所以不能 `orchestra_send`（§8.6）。

**(b) 持久性**
- **重放 v0（Grok Build 的模型）**：同步 `parallel`，seq 按 spec 顺序分配，稠密 journal；每次宿主调用都入 journal，包括 `budget()` 读取和 `args`；按 seq 检查分歧（`GW/engine.rs:510-575`；`journal.rs:33-43`）。
- **重放 v1（Temporal 式，`pipeline` / `race` 需要）**：按调用记录完成事件；重放时按记录的完成顺序解析缓存的 promise；调用由确定性的调用点路径标识（`phase/stage/itemIndex/occurrence`），按路径检查分歧。
- **键**：`key = v1:sha256(canonical{target, templateDigest, harnessVersion, prompt, opts})`；`requestId = arr:<lineageId>:<path>#<occurrence>`。`lineageId` 在「带修改恢复」时保留；任何调用在途或 `unknown` 时拒绝这种恢复。
- **结果**：每次调用在 journal 里记一个 `CallOutcome`：`ok | timedOut | denied | schemaInvalid | unknown | cancelled | budgetPaused | late`。`unknown` 对该次 occurrence 是终态。人工重发（§6.3）是运行之外的新 Exchange（`from.kind: 'human-resend'`），结果给人，绝不进重放。
- **结果存储**：ArrangementCall 保留 `resultDigest` 与 `resultRef`；非终态运行的正文钉住，不受 14 天 TTL 与「清除秘密」影响（§6.1 脱敏第 2 条）。钉住的正文被清除时，运行转为 `unresumable` 并出 InboxItem，绝不变成 `null`。
- **为什么重放**而不是 Letta 的「什么都不重放」：§8.3 承诺零重复执行；脚本唯一的副作用是按 `requestId` 键控的邮局调用，所以 LangGraph 的幂等前提成立（推断）[wf]。

**(c) 连接（join）。** `agent()` 返回值或 `null`；`outcome(h)` 给出原因；被拒绝的调用解析为 `null`，原因 `denied`。

| 原语 | 语义 |
|---|---|
| `parallel`（v0） | AND 屏障 |
| `race`（v1） | 第一个 `ok` 胜出；被拒绝或失败的调用永不胜出；全部失败 → `null`，原因 `allFailed`。stop 只发给模板 worker；具名乐手永不被中断（A4）：结果丢弃、照常计费 |
| `pipeline`（v1） | 按项流水，没有屏障；某一阶段失败就把该项降为 `null` 并跳过它后面的阶段，与 DSH 一致（`dsh-tool-workflow\lib\index.js:143-145`） |
| `quorum(k)`（v1） | 只数 `ok`；k 不可能达到时提前失败 |
| `orchestra_wait` | 乐手侧跨 Exchange 的 AND（§8.6） |

- **截止时间**从接纳请求起算；到期时排队中的调用撤回，已投递的模板调用停止（`timedOut`）。迟到的回复记 `late`，计费，不浮现。
- **BUDGET 暂停**：不再接纳新调用；在途调用跑完并入 journal；被拒的调用不入 journal，所以提高上限后恢复时不会重复计费（Grok Build `engine.rs:1258,1431`）。
- **上限**：每 root 转发上限 20（规则 7）对 A2A Exchange 保持硬限；Arrangement 调用用独立的 `arrangementCalls` 上限 64；跳数上限 4。

**(d) 终止。** `meta.stop` 以 AutoGen 的方式组合条件：`calls(n) | cny(x) | wall(min) | external | stall(3)`。循环必须有字面 K，或用 `loopUntilDry({dry:2, max:K})`（lint 检查）；评审循环还受打回 N=3 约束（§10.7）。每个 worker 的默认值来自 letta-code：10 min、1,000 次工具调用、3 次相同调用即停 [wf]。

**(e) Governor 与预算** [wf][arch]：
- 每次调用都经 governor 接纳：排队，不失败（关闭 §7.4 里「扇出绕过 governor」这一条）。
- 账本先按估算预留，再按真实用量结算：80% → P2 预算事件；100% → `BUDGET` 暂停 + P1，只有你能提高上限。事件按（策略、阈值、窗口）去重，上卷到 `rootId`（A14）。
- 默认：`arrangementCalls` 64、`maxConcurrent` = min(8, 空闲槽)、墙钟 60 min、CNY ≤ 项目日上限；未知用量按估算计，绝不按 0。
- 预估调用超过 25 次时，运行前先显示估算（R41）。

**(f) 权威与审批** [wf]：
- **启动**：你的一次点击授权的是这次运行，不是每个 worker 的每个动作。计算出的 prompt 带 `trust: runtime`；触发文本绝不被插入为指令（R34；CC#96640）。
- **来源**：`ArrangementRun.authoredBy`；agent（Maestro）编写的脚本污染它的每次调用。Start 之前先对假 harness 做一次零 token 的 dry run，显示预计的调用图、预算与目标；agent 编写的脚本需要键入确认。
- **模板审批**：Claude worker 用原生 SDK 权限规则，与 M1 QA 模板相同。DSH 只有一次性放行和 `ask|never` 策略（`dsh-user-approval\README.md:154`；`dsh-permission-presets\README.md:133`），DSH 的「白名单」就意味着 Orchestra 替它回答 `allow`，D8 与 §3.2 禁止。所以 DSH worker 的能力只来自沙箱模式；Orchestra 自动拒绝每个 `request_permission`（D8 下安全），并把拒绝汇总为每次运行一条 InboxItem（参照 OpenClaw 的 collector）。不做批量审批：每条审批仍绑定自己的请求摘要（§10.9）。
- 具名乐手（v1）保留自己的审批队列。脚本没有审批动词：`ask()` 只创建 Decision 并持久地挂起运行，带超时（默认取消）并释放账本预留；经 MCP 解决它会被拒绝。

**(g) 跨 harness 注意事项。** schema：要求 JSON、校验、一轮修复、再失败为 `null`；DSH 的子集是公分母（`dsh-tool-workflow\lib\index.js:143`）。v0 模板只读，所以没有 worktree；判定要求的修复作为 Exchange 发给负责的乐手。每次调用的成本是估算。取消 DSH 需要 `close`。taint 跟随插值与脚本来源。worker 内不嵌套原生工作流 [wf]。

**(h) 不适用的场景。** 品味、审批、实时配对、git 拓扑、无人值守的启动、只有一两次委托的情况（`dsh-tool-workflow\README.md:12`）、乐手之间的对话 [wf]。

**(i) 呈现。** M3：原生运行以只读的 运行 → 阶段 → 成员 树显示（R16）。M6：§11.4 Score 页增加 Circuit 标签页，骨架来自 AST 与 `meta.phases`（阶段列、AND/OR 门、`×n` 总线、「↻ ≤K」循环），叠加实时覆盖层（Exchange 颜色、计数、null 数、预算表）[wf]。

**风险**（[wf]）：
- 范围向 Dify 蔓延 → 先做模板，不做编辑器或 DSL（OpenClaw 也拒绝它们）；go/no-go 门。
- 重放 bug（异步顺序、被清除的正文）→ v0 同步；结果钉住；失败即关闭。
- 具名乐手有状态 → 只在 v1，且 DSH 侧要有 relay-source bundle。
- 扇出成本（DeepSeek 高峰时段 2 倍定价，§2.3）→ R41 估算、硬预算、预算事件。
- schema 遵从弱 → 修复轮、完整性评审、null 计数。
- harness 漂移（DSH 约每 2 天发版；Claude 的记录没有文档）→ 解析器降级为 `unknown`；扇出按事件计数。
- DSH 模板过度拒绝 → 一条汇总条目；更宽的沙箱模式（Q-W2）。
- 许可证 → dsh-apollo（GPL-3.0）与 GBR 只借鉴设计；复用 grok-build（Apache-2.0）的 journal 设计无需 NOTICE，复制代码则保留其 LICENSE 与归属。

待你拍板（§17）：Q-W1 谁能编写和启动 Arrangement，默认预算多少；Q-W2 是否接受 DSH 模板只在沙箱内（没有沙箱外命令）。

验收用例 WF-1…WF-18 见附录 F。

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
| 4 | 房间规则：只有**开头**的 @ 才路由（Koishi 式；有意区别于 DS-Bot 与 GBR 的正文 @）；admin 由人设定，admin 先答、`[PASS]`；严格前缀的房间命令需要人类信任；连续 K 次 `[PASS]` 后安静闩锁；路由器失败 = PASS；转发与轮次上限见 §10.7（members×3 保留为 DS-Bot 导入声部的数字）（A10） | 否 | [bot][arch] |
| 5 | 硬过滤，带类型化拒绝码；用分叉的 `router-core`，主键改为 `[harness, musician, project/worktree, model, configVersion]` | 否 | [own] |
| 6 | 亲和加滞回：`evaluateSwitch`，冷却 300 s，阈值 1500 bps | 否 | [own] |
| 7 | 证据门：每个 `taskClass` 一个 Wilson 下界，只认确定性或人工标签（测试 / CI 通过、你在审查中接受、**你自己的派活选择**）；拒绝模型自评 | 否 | [own] |
| 8 | 按配额或成本排序 | 否 | [own] |
| 8b | 报价（M5）：为选中的目标估算 token 和 CNY，超过阈值时先问你 | 否 | R27 |
| 9 | **只有 1–8 步之后仍然模糊时**，才用便宜的分类器，输出 `{project, target, taskClass, confidence, reason}`；它只能从第 5 步的幸存者里选，选到候选之外即拒绝；每乐手有 `handoffAcl`；标签不足 N 时用静态后备（A11） | 是 | [arch] |
| 10 | 置信度低，或路由器失败时，生成一条一键选择的 "Route to?" InboxItem 问你；绝不默认派给某个乐手（A11） | 否 | [arch] |

（本文补充，[arch]）DS-Bot 路由正文里的 @（`src/shared/mentions.js:52`），所以 M4 导入的 DS-Bot 声部与 Orchestra 的房间行为不同：同一段「@Ren 说过……」在 DS-Bot 里会路由，在 Orchestra 房间里不会。是否接受这个差异待你确认（§17）。

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
| 乐器（r3，§10.13–10.16） | 侦察乐手经 Governor 拿租约：Tier 0 由运行时授予，Tier 2/3 只有你能授予；写操作走两阶段审批 | 原生 computer use 只观察、不中介：横幅 + 伪租约，期间自有驾驭器挂起 | 同 observed |

### 10.2 Governor（速度控制）

- **自有工作**：Post Office 按项目、模型、harness 给乐章启动和投递排队，另有每日 CNY 上限。什么都不会失败，超额的工作只是等待。Governor 只管得住 Orchestra 自己发起的投递和乐章启动。
- **DSH 原生子代理**：仍受 `maxActiveSubagents` 约束（每个激活树 8 个、进程内计数、不排队），超限时报 `ACTIVATION_LIMIT_REACHED` [core]。Orchestra 先把私有 home 的 `maxActiveSubagents` 设为 governor 对该模型的 `perModel` 上限（§7.4），超限计为 `over-cap` 事件；等私有 home 的 bundle 能在 `tools/pre-execute` 拦截时，再改为排队（假设）。
- **待审上限**（M4）：某个项目的 ready-for-review 超过 N 条（默认 3，假设）时，Maestro 的新派活进队列等待；你手动派活时只提示、不阻止。
- **只读会话**：只计量，达到 80% 时预警 [own]。
- 每个模型的默认上限由"模型组合压力测试"校准（§14）。
- **预算事件**（A14，M2）：软阈值 80% 预警，100% 自动暂停；每（策略、阈值、窗口）只开一个 `budget-incident`，同一阈值在同一窗口内被越过 3 次仍只有 1 个事件；成本上卷到 `rootId`；每次模型调用带 `purpose`，账本据此归因 [arch]。Arrangement 运行到 100% 时进入 `BUDGET` 暂停并出 P1 `arrangement-paused` 条目，只有你能提高上限；暂停期间不再接纳新调用，在途调用照常结束并入 journal，被拒的调用不入 journal，所以提高上限后恢复不会重复计费 [wf]。
- **Arrangement 调用**（M6）：每次 `agent()` 调用都经 governor 接纳，排队而不失败，补上「扇出绕过 governor」这个口子（§7.4）；账本先按估算预留、完成后按实际用量结算，用量未知时按估算计、绝不记 0；预估超过 25 次调用先给出运行前报价（R41）；并发 `maxConcurrent` = min(8, 空闲槽)（§10.12）[wf]。
- **乐器预算**（M1 起）：Tier 0 浏览器由运行时按独立的 `instruments{maxBrowsers: 6, ramGB}` 预算授予，不占 `tempo.maxActive`（否则正在浏览的乐手会被计两次）；图片 token 作为 `imageTokens{estimated}` 预留并计量（E11）；Tier 2/3 只有你能授予（D8），agent 只能调 request-only 的 `orchestra_request_lease`（§8.6）；租约经纪在 Governor 里，不在邮局 [cu]。

### 10.3 Runaway（死循环）检测

- **触发条件**：
  - 同一工具名 + 归一化参数哈希（能抓到近似重复），在 120 s 内出现 ≥5 次；
  - RSS 超过上限，或增长速度超过阈值；
  - 输出洪泛。
- **与 DSH 原生守卫的分工**：DSH 的 `repeat-tool-reminder` 在精确重复 3 / 5 / 8 次时发提醒，只是建议性的 [核验]。DSH 源把这些提醒消息解析为证据（P2，「原生守卫已介入」）；对 DSH 会话，精确重复在第 8 次提醒之后仍在继续，才升为 P0。Orchestra 自己的检测聚焦原生守卫没有覆盖的部分：近似重复、RSS 和输出洪泛。
- **细则**（A12 [arch]，M0 / M2）：同一工具错误连续 3 次即结束回合；升级顺序固定为 warn → block → end；第 10 次相同的 `wait` 调用被阻止；参数哈希前剥除 PID、时长与 cwd，所以只换 PID 的重复仍会触发。规则取自 OpenClaw 的 loop-detection（`D/tools/loop-detection.md`）。
- **原生工作流扇出**（M2）：按 DSH `tool-workflow/*` 事件与 Claude 运行记录计数，绝不按配置的上限推算；一次运行达到 25 个 agent 或 1.5M token 时出 P2 `workflow-run` 条目（§8.7）[wf]。
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

- **自有进程**：每个宿主（Claude CLI、DSH host、codex app-server）在自己的嵌套 Job 里，可以单独结束。一个 DSH host 上复用的多个乐手只能整体结束进程；回收单个 DSH 乐手用 `session/close`，不杀进程。闲置乐章在 N 分钟后释放，身份保留；没有会话的 host 随之关闭。闲置释放不得关闭仍有工作流运行的乐章（§8.7）：后台运行会立刻返回、让乐章看起来闲置，`close` 会连运行一起杀掉，邮局还会往里投递；因此 M1 的钳制把 `enableRunInBackground` 设为 `false`，M2 起闲置判定还要看解析到的运行事件（推断）[wf]。
- **自有会话的分身**：Claude 用 `stopTask()`，Codex 用中断回合。DSH 先 `session/cancel` 停根回合；若后代仍有活动，则 `session/close`（README：quiescent cancellation + descendant disposal），再 `session/resume` 继续同一会话 [核验]；仍无效时才对该 host 用刹车（会波及同一 host 上的其它乐手，需要你确认）。M3 起私有 home 的 bundle 在父回合结束或被中断时级联中断仍在运行的后代，并用 `subagent/end` 核对。
- **只读会话的孤儿**：检测出来并画成幽灵，判定规则是：
  - DSH：父会话 `turn/end` 之后，某个 subagent 仍在活动（它自己的日志还有新事件）超过 T；resident / inactive 的可继续子代理不算孤儿（DSH 设计上就会让闲置子树常驻 [核验]）。低置信。
  - Codex：父会话已结束，spawn edge 仍是 `running`；
  - Claude：subagent 的父会话已经不在。
  - 例外：DSH 工作流的可继续子代理在运行结束后常驻，是 `inactive` 分身而不是幽灵；它们占着激活槽，reaper 对照 `maxActiveSubagents` 追踪这些槽位（§8.7）[wf]。
- **轮换熔断**（A13 [arch]，R32）：区分确定性失败（例如缺 API key）与瞬时失败，前者不再重试（推断）；每小时轮换次数有上限（§10.12）；每次轮换前核实旧乐章已归档；超限后退避并出 `rotation-breaker` 条目（P1）。M1 先做小时上限，M3 补齐其余。依据 DSB#485（DS-Bot 累积 1,971 层 `runSwitch` 栈帧后 OOM）；反例 MaiBot `heartFC_chat.py:497-501`。零 token 验收：缺 key 的 fixture 最多 3 次尝试、一条 P1、不 OOM。
- **浏览器**（R49 [cu]，M2）：每个浏览器 MCP 在自己的租约 Job（`lease:<id>`）里，挂在 host Job 下；kill 顺序为 `browser_close`（2 s）→ `kill-job` → 在途写入记 `unknown-outcome`，承载 UI 的浏览器始终受保护（E14，§10.14）。Chrome 的 `lockfile` 是删除即关闭，同一 profile 目录第二次启动以退出码 21 结束而不是留下陈旧锁；遇 21 时按 pid + createTime 找持有者：我们的 → kill 或排队，外来 → `foreign-held`（P2）；连续 3 次失败 P0。
- **桌面驾驭器**（Tier 2，[dcu]）：回收器同样覆盖 `cua-driver*.exe` 及 `\\.\pipe\cua-driver*`。驾驭器只在租约 `active` 期间作为 `orchestra-desktop` 代理的 stdio 子进程跑在 Job `lease:<id>` 里，租约结束即 `kill-tree`；Job 外的 `cua-driver*.exe`、新出现的管道或 `serve` 任务都视为外来，阻止授予并出 P1（R58）；任何 kill 之后由 procguard 修复目标窗口的启用状态（R60）。细则见 §10.14、§10.16。

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
| 房间转发上限 | Orchestra Rooms 落地后以「房间上限」一行的 A10 上限为默认 [arch]；自你上次发言起 members×3 [bot] 只保留给 M4 导入的 DS-Bot 声部 | 房间暂停，直到你按 **Continue** 或发言 |
| 打回上限 | 每个（task，A↔B）N=3 | 升级为 InboxItem |
| 轮次上限 + 完成标准 | 每个 Task 单独设置 | 到上限即停 |
| rounds-to-done 直方图 | — | 呈双峰（第 1 轮就结束 vs 撞上限）时标记 |
| 停滞 stall | 3 次（A9 [arch]）；「没有进展」= 没有新的 diff、测试、ref 或 Decision | 升级为 P1 `stalled-delegation` 条目；绝不自动重新规划 |
| 回访 check-in | N 次交换或 T 分钟（A9 [arch]；N、T 待定，§17） | 唤醒提问者一次并出 InboxItem |
| 房间上限 | ≤6 成员、3 轮、10 成员回合、每回合 2 条，轮转发言（数值为 GBR 重建件，Q-A）；去抖 8 s（@ 提及 1 s）；连续 K 次 `[PASS]` 后安静闩锁（A10 [arch]） | 到轮次上限房间暂停；路由器失败 = PASS |
| Arrangement 循环 | 字面 K，或 `loopUntilDry({dry:2, max:K})`，由 lint 强制；`meta.stop` 组合 `calls(n) \| cny(x) \| wall(min) \| external \| stall(3)`（AutoGen 式 [wf]） | 到任一条件即停；评审循环同时受打回 N=3 约束 |
| Arrangement worker | 10 min、1,000 次工具调用、连续 3 次相同调用即停（letta-code 的默认 [wf]） | 该 worker 停止 |

以上检测与强制都在 M3（R08）；M2 只有 runaway。新增行的落地：回访 M1、停滞 M3 [arch]；房间上限 M3 [arch]；Arrangement 两行随 M6 [wf]。

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
- **两阶段审批**（E3 [cu]，M2）：浏览器的写入类调用（提交、上传、输入、选择、Enter、拖拽、不能证明只是导航的点击，以及破坏 / 金融类，含 `handle_dialog` 的接受）先由 `orchestra-browser` 代理返回 `{status:'approval-pending', approvalId}`，不触发 harness 的工具超时；你在收件箱批准后 agent 带 `approvalId` 重调，代理复核目标摘要（`elementDigest`、URL、frame）后只执行一次。凭据、支付、CAPTCHA 不走审批而走 `handoff`（A26），只有你能结束。流程细节与 E1–E15 见 §10.15。
- 审批条目携带 `actionClass` 与 `elementDigest`：前者是 A5 权威链卫生的键，同一 root 内同类动作再出现时标「上游已拒绝」（推断）；后者让目标元素一变审批即失效（浏览器随两阶段审批在 M2，R45、CU-6；桌面绑定 A32 在 M4）[cu][dcu]。
- Arrangement 的 `ask()` 只创建 Decision 并把运行持久挂起，不是审批；有超时（默认取消），挂起时释放账本预留；经 MCP 解决同样被拒绝 [wf]。
- DSH 模板 worker 的 `request_permission` 一律自动拒绝（D8 下安全：Orchestra 从不替它答 `allow`，worker 的能力只来自沙箱模式），每次运行汇总为一条 InboxItem；不做批量审批，每条审批仍绑定自己的请求摘要 [wf]。
- 桌面 `act`（Tier 2）：E5 冻结人类动词期间不返回 `approval-pending`；审批走 Q-DC7 选定的路线（在 `look` 租约里起草计划、租约之间批准，或修改 E5 让配对 UI 在租约中从目标后方答步骤卡），在此之前写入一律拒绝（`no-approval-route`）[dcu]。
- Tier 2 租约持有者能以你的身份打开终端，因此与 bypass 会话同列，计入下文 policy 告警的「等同于你」计数（§10.11 #6）[cu]。
- 任何地方都不使用 bypass 标志，也不使用 `approval: never` 的预设。
- **policy 告警**：
  - 自有乐章出现 bypass / `approval: never`：P0（按设计不该发生）。
  - 只读会话：Claude transcript 里的 bypass `permissionMode`（M0）；DSH 会话的权限投影和 DS-Bot `state.json` 的 `bots[].permission` 出现 `danger-full-access` 或 `never`（M2）。每个会话或 bot 只生成一条 P2（去重），Tuning 顶部常驻显示「N 个 bypass / 无审批会话：它们在能力上等同于你」。

### 10.10 Desired vs applied（期望值与实际值）

每次修改模型或权限（`setModel`、`setPermissionMode`、`set_config_option`）后，Orchestra 都回读实际值，有漂移就显示出来 [bot impl 8]。这正是你在 DS-Bot 里遇到的权限竞态 bug 的教训。

DSH 的权限预设不能经 ACP 修改：`set_config_option` 只覆盖 `model` 和 `reasoning_effort` [核验]，所以只回读这两项。预设由 host 启动时的配置决定；host 启动后用一次受控工具调用探测实际生效的预设（例如向工作区外写文件的金丝雀命令应当产生审批请求）。

### 10.11 凭据与 UI 安全

**读取白名单**（默认拒绝）：各数据源只允许读这些文件——`projects/**/*.jsonl`、`sessions/<数字>.json`、`**/subagents/**`、`state_5.sqlite`（快照）、`sessions/**/rollout-*.jsonl.zst`、`session.v4.jsonl.zstd`、`storages/session_projcache`、DS-Bot 的 `state.json` / `inflight.json` / `usage.sqlite`、dsh-tui 的 `session-mounts.json` / `servers.json`。其余文件，包括 `*.key`、`*credentials*`、`auth.json`、`.claude.json`、`*.bak*`、`watchdog*.log`、`.env*`，一律由统一的 fs 封装拒绝，并有单元测试覆盖。这些文件在本机确实存在 [核验：仅文件名]。M2 起白名单增加经核实的工作流记录路径（只读）：Claude 的 `agent-*.jsonl` 与 `.meta.json`、会话目录下的脚本与保存结果、`journal.jsonl`（S3 后核实）；DSH 的 `tool-workflow/*` 事件 [wf]。浏览器状态永不读取（E10 [cu]）：profile 目录、`cookies.json`、`*storageState*.json`、`auth.json` 与 DPAPI 一律由同一个 fs 封装拒绝；`orchestra-browser` 代理隐藏 `browser_cookie_*` 与 `browser_storage_state`；永不以 `--caps storage|config|network` 启动 playwright-mcp。

**粘贴的 `/connect` URL**：收到后立刻用 `interactions=none` 换成 cookie，cookie 只放内存，token 当场丢弃、不落库；守护进程重启后需要重新粘贴（watchdog 每次重启宿主 token 也会失效，核查时 3080 端口上没有任何进程在监听 [core]）。所有日志和片段里的 `token=` 一律替换为 `***`。DS-Bot `/api/bot` 所需的 `interactions` 级别在 M4 验证。

**UI 鉴权**（评审补充；替换"复用 tonghuashun 守卫"的旧方案）：
1. launch token 永不落盘、不进 argv、不进日志、不进 toast 或 URL。首次配对时，守护进程在自己的控制台打印 8 位一次性配对码，由你在页面输入；随后服务端下发 HttpOnly + SameSite=Strict 的 host-only cookie（不设 Domain）。
2. UI 只在 `http://orchestra.localhost:<port>` 提供（浏览器把 `*.localhost` 解析到回环，调研之外的知识），Host 白名单只放这一个值。这样 cookie 不会发给 agent 在 `127.0.0.1` 或 `localhost` 上起的 dev server。
3. 所有变更操作只接受 POST，必须带与会话绑定的 `X-Orchestra-CSRF` 头；Origin 缺失或不完全相等时一律拒绝。不能单独依赖 SameSite（`localhost:5173` 与 `orchestra.localhost` 可能被视为同站），以 Origin 精确匹配加 CSRF 头为准。
4. 人类动词（allow / deny / resolve / kill / 受保护宿主确认）只挂在 UI 监听器上。agent 侧走独立的 named pipe 路由表，物理上没有这些路由。
5. orchestrad 检测到自己以提升权限运行就拒绝启动。
6. **残余风险，明示**：同一 Windows 用户下、拥有无审批 shell 的会话（任何 bypass 会话）在能力上等同于你，它可以读你的文件、模拟你的输入。Orchestra 不假装能防住它，只在 Tuning 顶部常驻显示数量（§10.9）。Tier 2 桌面租约的持有者能以你的身份打开终端，因此也计为 bypass 会话；Orchestra 能做的是把终端、Run、Settings、UAC、密码管理器、UI 浏览器与 DSH web / Desktop 窗口列为永远拒绝的目标（§10.14）[cu][dcu]。
7. **受保护的路径**（R35，P0 [arch]）：`~/.orchestra`、每个私有 `DSH_HOME` 与它们的锁文件加入 §7.4 的受保护路径：自有乐章对它们的写入进审批队列并要求键入确认（Claude 经 `canUseTool`，DSH 经预设与沙箱；推断）；写围栏只约束 orchestrad 自身的写入（§5.2）。依据 DSB#513。

**opt-in 片段**：hooks / MCP 片段由你自己从界面上复制粘贴；粘贴后重新建立零写审计的基线。`PermissionRequest` hook 要先通过 fail-through 测试才会提供。

### 10.12 默认参数一览

| 参数 | 默认 | 来源 / 状态 |
|---|---|---|
| 跳数上限 | 4 | 综合稿 |
| 每 root 转发上限 | 20 | （假设） |
| 每 Work 截止 | 30 min → `timedOut` InboxItem | 综合稿 |
| 审批超时 | 30 min → deny；专注模式下暂停计时 | （假设，§17 Q4） |
| 审批按键冻结 | 列表变化后 750 ms | 评审 |
| 房间转发上限 | Orchestra Rooms：以下方「房间上限」行的 A10 上限为默认；M4 导入的 DS-Bot 声部：members × 3 | [arch] / [bot] |
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
| 停滞 stall | 3 次 → P1 | [arch] A9 |
| 回访 check-in | N 次交换 / T 分钟 | （待定，§17）[arch] A9 |
| 房间上限 | 6 成员 / 3 轮 / 10 成员回合 / 每回合 2 条 | [arch] A10（GBR 重建件，Q-A） |
| 房间去抖 | 8 s；@ 提及 1 s | [arch] A10 |
| 入站暂扣 hold | 仅 agent 的 hold 5 min 过期；≤100 held、≤50 queued；等人放行的 hold 跟审批超时与专注模式 | [arch] A6 |
| 轮换熔断 | 每小时轮换上限 3（测试里 ≤3 次尝试） | （假设）[arch] A13 |
| 预算事件 | 80% 软预警 / 100% 自动暂停；每（策略、阈值、窗口）只开一个 | [arch][wf] A14 |
| Arrangement 上限 | `arrangementCalls` 64（与每 root 转发上限 20 分开）；hop 4；`maxConcurrent` = min(8, 空闲槽)；墙钟 60 min；CNY ≤ 项目日上限；预估 >25 次先报价（R41） | [wf] |
| Arrangement worker | 10 min / 1,000 次工具调用 / 连续 3 次相同调用即停 | [wf] |
| 工作流钳制 | `maxConcurrentAgents ≤ maxActiveSubagents−1`、`maxTotalAgents ≤ 64`、`enableRunInBackground:false`，CI 检查 | [wf] |
| `workflow-run` 条目阈值 | 一次运行 25 个 agent 或 1.5M token → P2 | [wf] |
| 乐器预算 | `instruments{maxBrowsers: 6, ramGB}`，约 0.4 GB / 浏览器 | （假设）[cu] |
| Tier 2 桌面租约 | 5 min；桌面调用超时 15 s；一次一个在途调用 | （假设）[dcu] |
| 乐器上限 E11 | 8 步、每步 2 图、≤180 KB、≤1,600 px、每乐章小时约 20 图 | [cu]（20 图为假设） |
| 截图 / 快照保留期 | 截图 24 h、快照 14 d；桌面截图另定 | [cu] E9（24 h 为假设；桌面见 §17 Q-DC8） |
| 租约 draining | ≤2 s，到时 `kill-job` / `kill-tree`，在途写入 `unknown-outcome` | [cu][dcu] |
| procguard 轮询 | ≤500 ms | [cu][dcu] |
| cua-driver manifest `idle_timeout` | 60 s | [dcu] |
| 离席判定 | N s 内无非合成 Raw Input（不用 `GetLastInputInfo`） | （待定，§17 Q-C9）[cu] |

### 10.13 乐器：眼睛与手（D17）

本节与 §10.14–10.16 吸收 [cu][dcu]。规则 E1–E15 与两阶段审批见 §10.15，桌面驾驭器的配方见 §10.16，模式 A21–A39 见附录 E，零 token 验收用例 CU-1…CU-30 见附录 F。

**立场**

1. **没有眼睛的 bot 做不了你在意的查询。** DSH 的 `web_fetch` 匿名、只到公开页、不跑 JS、不能登录（`DP\dsh-web-fetch-http\README.md:12,64`），所以 SSO 后面的 CI、本机仪表盘、需登录的文档、UI bug 复现都够不着。社区的一份插件提案把这个缺口概括为「它回你一句『需要登录』」（DSH-D#10996）[cu]。
2. **大多数查询要的是结构化读取，不是像素。** 顺序是 API / CLI → 登录态的无障碍文本 → 只剩像素的那一部分；两家厂商都把屏幕控制排在最后。OSWorld 2.0 的长程工作流（中位约 1.6 人时）上，2026 年中评估过的最好模型（Opus 4.8）完成率 20.6%（arXiv 2606.29537）；短任务基准高得多（OSWorld-Verified 83.4%，聚合数据，未核实）[cu]。
3. **CU 是 harness 的能力，不是模型的。** Claude 与 Codex 只在桌面应用或你的真实浏览器里提供它，不在 Orchestra 自有的 SDK、app-server、ACP 会话里（`CCD/computer-use.md:203`；`OB\unified-computer-use\…\.mcp.json:24-29`）。DSH 是例外：可选装的实验性 CU 包能挂进自有 host，但 rc.2 一个也没带（§10.16）[cu][dcu]。
4. **风险在乐器里。** 早期 CUA 红队报告 42–98% 的攻击成功率，大多针对已退役的模型（arXiv 2505.21936）；2026 年的一次审计里，140 次多步浏览器攻击对 Sonnet 4.6 与 GPT-5.4 无一成功，但编码技能注入达到 100%（arXiv 2606.05233）。更尖锐的失败是 D8 的：一个 agent 驾驭的浏览器或桌面若已登录 `orchestra.localhost`，它就**是**你 [cu]。
5. **因此（D17）：眼睛和手是舞台乐器，不是乐手的固有能力。** 浏览器多且每个侦察乐手一把（Tier 0），登录态由你的 Grant 授予，桌面只有一个且租用（Tier 2）。Orchestra 掌握隔离、出口、taint、审批、脱敏与成本；只有侦察乐手（`kind: scout`）能持有乐器（E6）。
6. （推断）「真正的 bot」= 一个租用的、隔离的、先看后动的浏览器，加一次人类交接 handoff。自有乐手是否必须驾驭你的桌面是 Q-C1；你已于 2026-10-27 答 B，Tier 2 进入计划，交付以 S-CU 为前提，工期见 §13。

**Harness 能力对照**（Windows 11 [cu]）

| | Claude Code 2.1.310 | Codex（CLI 0.139；app 26.1021） | DSH 0.2.1-rc.2 |
|---|---|---|---|
| **今天的原生眼睛** | 桌面应用的 pane，干净 profile（`CCD/desktop.md:157`）；Claude in Chrome 用你的真实 profile（`chrome.md:46,56,100`）；桌面应用里的 CU；CLI 的 CU 仅 macOS、不在 `-p` 下、单会话（`computer-use.md:11,99-101`） | 桌面应用：`@oai/sky` 0.7.13（SendInput + UIA，会激活目标窗口，`SKY\…\SKILL.md:123`）；浏览器插件经 `node_repl` / `cua_repl` | `web_fetch`；未捆绑的可选包（`DP\dsh-agent-preset\…\packages.md:43-47,190-200`）：browser-use 提供者；computer use = 注册表 + `cua-driver-mcp` / `cua-driver-native`（任意 OS），或 `dsh-cua` + `cua-macos`（macOS，PTC，按应用同意） |
| **在自有乐手里** | 没有：pane 是宿主的 `type:"sdk"` 服务器（推断） | 没有：需要桌面应用的管道与环境（未核实）；派生的任务丢失 `node_repl`（CX#49458） | 一个也没装；精确钉 0.2.1-rc.2（`latest` 0.1.6-alpha.1 列进 `dsh.profile.bundles` 会让启动失败）。可挂载：playwright-mcp、chrome-devtools-mcp、stagehand；`cua-driver-mcp`（子进程：选用）、`cua-driver-native`（进程内：否决）、`cua-macos`（无代理：不提供）。桌面工具是 host 全局的、被子代理继承、不排队 |
| **Orchestra 的浏览器 MCP 怎么挂** | SDK `mcpServers` | 私有 `CODEX_HOME` 的 `[mcp_servers.*]` | ACP `session/new{mcpServers}`，或一个 bundle |
| **截图怎么到模型** | 内联，25k token 上限；原图存在 `tool-results` 下（`mcp.md:435,1526-1532`） | MCP image content | 只经声明图片的模型 + attachment store：默认目录里的 `deepseek-flash`，或声明了图片输入的模型 id（`DP\dsh-llm-deepseek\lib\index.js:42-54`，`README.md:53`）。ACP 行自带的 `deepseek-v4-flash` 未入目录 → 纯文本（`dsh-acp-app\cordis.patch.yml:15-20`）。模型只见 `content`（文本、被接纳的图片），永不见 `structuredContent`（`element_token`、`effect`、`delivery.mode`；`mcp-client/src/tools.ts:261-263`；DSH-D#7788 未关闭） |
| **点击的审批** | `canUseTool` | `approval_mode="approve"` → `mcpServer/elicitation/request` | 没有默认闸门。逐次调用时，Auto review（一个 LLM）或 hooks-claude-code 的 PreToolUse `ask` hook 能经 `approval/request` 询问，claude-code-mods 的 `tool.call` hook 能经 User Questions 询问（`packages/experimental/claude-code-mods/src/index.ts:1-11`）；默认一个也没挂。请求不带工具参数，授权一次性（`dsh-user-approval\README.md:154-155`）。侦察乐手的组合里没有任何东西会为 Cua Driver 工具先问；`cua-macos` 按应用经 User Questions 询问，ACP 答不了 |
| **Orchestra 观察到什么** | `mcp__<srv>__browser_*`。只有原生才有的前缀：`mcp__Claude_Browser__*`、`mcp__claude-in-chrome__*`、`mcp__computer-use__*`、`mcp__remote-devices__computer_*`、`mcp__remote-devices__Claude_Browser__*` | `mcpToolCall{server, tool, readOnlyHint}`、elicitation | v4 日志里的 `mcp__<server>__*`；另有 `cua_driver_native__*`、`cua` |

**报告之间的分歧**（已裁定 [cu]）

| 分歧 | 裁定 |
|---|---|
| 用 Claude / Codex 的原生眼睛做查询路由 | 不采用：它们的眼睛只在桌面应用或真实 profile 里，自有乐手拿不到 |
| Chrome 能否在 procguard 的 Job 里跑 | 只验证过 Chrome 能从 `KILL_ON_JOB_CLOSE` 的 Job 启动、带 UI 限制 `0x41` 则起不来；那个脚本只检查了自己的成员身份、用 `Start-Process` 而不是 Node → playwright-mcp、用 `Stop-Process` 杀。Job 只有双方都不设 UI 限制才能嵌套，而 Chromium 的渲染器 Job 会设（MS Learn Nested Jobs；`job.cc:36-54`）。结论：Chrome 能启动；成员、回收、渲染器沙箱（未核实），留给 S4（§5.4） |
| 谁当租约经纪 | Governor，不是邮局 |
| 谁有眼睛：只给侦察乐手，还是每乐手一个 mode | 并入 E6：mode 是字段，只有侦察乐手能把它设为 `look` / `act` |
| DeepSeek 图片 | 预算 ≤1,024 token（视觉指南）。「拒绝超限图片」的规则是 Chat Completions 的，而 DSH 走 `/anthropic/v1/messages`（`dsh-llm-deepseek\README.md:57,83-85`），未测试；测过之前一律 `--image-responses omit` |

**乐器分级**

| Tier | 机制 | 保证 | 做不到 |
|---|---|---|---|
| **Tier 0 每乐手浏览器**（默认） | 钉死的 `@playwright/mcp` 走 stdio，跑在每租约一个的 Job 里；Grant 的 profile 或 `--isolated`；headless；`--remote-debugging-pipe`；`--proxy-server` 指向出口过滤器。playwright-mcp 在 Linux 之外本来就给 Chromium 开沙箱（`tools/mcp/config.ts:236-243`），`--sandbox` 只是双保险。每个约 280 MB 私有内存 | 并行；永不抢焦点；永不碰你的 cookie | 原生应用；拒绝 headless 的站点；同一目录开两次（退出码 21） |
| **Tier 1 有头、仅 CDP** | 需要定制驾驭器：原版 Playwright 的 `Target.createTarget` 不传 `background`，目标会取焦并把窗口抬到前台（`crBrowser.ts:380`；`Target.pdl:176-178`）。与「钉死不改」冲突，**v1 不做** | 只有配上那个驾驭器才不抢焦点（推断） | 最小化时的渲染（未核实）。SendInput / UIA 打字需要前台，CDP 键盘事件不需要（S4 验证） |
| **Tier 2 桌面租约** | 一个持有者；人授予；横幅；撤销开关见 §10.14。**驾驭器候选**：上游 `cua-driver mcp --direct`（MIT）置于 `orchestra-desktop` 之后，任何自有 harness 都能挂；按窗口寻址的后台调用、精确的 `background_*` 拒绝；未验证（S-CU） | 独占；人类的撤销开关 | 并行；中介 sky / Claude 的 CU。用 cua-driver 时还做不到：前台投递；pen 点击（Chromium / Electron 上除单次左键以外的点击，以及 UIA 动不了的 WPF / Tk / GTK 元素，不论按元素还是按 x/y 寻址）；往 Electron / Chromium 里打字；Medium IL 下的完整 UWP 树（未核实）。Windows-MCP 后备只有前台（nonce 撤销开关）。持有者能以你的身份开终端，所以计为 bypass 会话（§10.11 #6） |
| **Tier 3 一次性桌面** | Windows Sandbox，`LogonCommand` 启动客机，结果经映射文件夹回传（MaiBot `bridge.py:22-41,139`；`wsb exec -r System` 的 GUI 用法未核实）；Hyper-V 虚拟机；WSL2 只有加固后才算（关闭 `automount`、`interop`、`appendWindowsPath`；默认会把盘读写挂载并能启动 Windows 进程，MS Learn wsl-config） | 只有 Sandbox 和虚拟机是默认边界；输出标 `provenance:[sandbox]` | 一次一个；需要一次性管理员启用；网络经出口过滤器。**计划外** |

Windows 的「后台」是补偿出来的，所以 Tier 2 先看后动，`act` 要等 S-CU 的写投递测量（推断）；Tier 2 不改变 D8、邮局是唯一总线、D18、Tier 0 与 Lease 状态机，E5 维持原样，除非 Q-DC1 或 Q-DC7 另有裁定（细则见 §10.16 立场 6–7）[dcu]。

### 10.14 Grant 与 Lease

**Grant（新实体，M2 [cu]）**

一次 SSO 登录会解锁该 IdP 后面的所有应用，所以 Grant 按 IdP 发、带显式的 origin 列表：`Grant{id, label, loginUrl（由你键入）, origins[]（含 IdP）, mode: look|act, profileId, musicians[], expiresAt, createdBy: human}`（字段见 §6.1）。

- **登录**：orchestrad 在 Grant 的 profile 上打开有头 Chrome，在 Job 之外、不开 CDP、出口只放 `loginUrl` 与 IdP，关闭密码保存与自动填充。你登录（含扫码）后把它关掉。
- **重新认证**：页面跳转到 IdP 时抛出 `handoff{reason: reauth, grantId}`，打开的是 `loginUrl`，绝不是 agent 当前的 URL（被注入的 agent 可能摆一个仿冒登录页）。
- **不用 storage-state 文件**：同用户的 DPAPI 挡不住乐手自己的 shell（推断）。吊销 Grant 即清空 profile。profile 按租约出借。
- **在场规则**：Grant 的 profile 与 `act` 只在你在场（UI 心跳）时可用，直到 R05 / R06 / R07 / R21 通过；无人值守的运行只能在公开 origin 上 `look`。
- 首批 IdP、origin 与时长是 Q-C4。

**Lease（新实体；M1 的 Tier 0 由运行时授予，M2 完整 [cu][dcu]）**

`Lease{id, instrument: browser-profile:<grantId|musicianId> | desktop | sandbox:<slot>, holder{musicianId, partId}, tier, expiresAt, idleReleaseAt, reason, grantedBy: runtime|human, nonce, state, actuator{pid, createTime, jobId, driverVersion, manifestDigest}}`。`actuator` 只有桌面租约才有，记录当前驾驭器进程 [dcu]。桌面租约默认 5 min、桌面调用超时 15 s、一次只有一个在途调用（假设，§10.12）[dcu]。

```
requested → awaiting-human（Tier 2/3）→ granted | denied | expired→denied | withdrawn
granted → queued → active → releasing → released          （releasing → stuck → kill-job）
queued → foreign-held        （profile 被非 Orchestra 的 pid 锁住；P2）
active → suspended           （锁屏、输入桌面 ≠ Default、UI 浏览器来到前台、外来注入者、你离席）
suspended → revoked          （永不自动恢复）
active → draining（≤2 s）    → 冲掉未松开的键与按钮；在途写入 → unknown-outcome
active → lost                （持有者死亡；守护进程重启时每一行 active / draining 都标 lost，+ P1）
```

Tier 2/3 永不自动重新授予，只有你能延长租约。agent 只能调 request-only 的 `orchestra_request_lease(instrument, mode, reason)`（§8.6）；lease-request 计入 flood 配额，拒绝按（乐章，乐器）粘住直到你清除 [dcu]。

桌面租约的每一步动作 [dcu]：

| 租约状态变化 | 动作 |
|---|---|
| queued → active | 新起一个驾驭器进程，旧的元素 token 不会幸存 |
| active → draining（≤2 s）→ releasing → released | 停止接纳；到 2 s 即使调用还在途也 `kill-tree`（写入记 `unknown-outcome`）；恢复窗口状态 |
| suspended、revoked、lost | orchestrad 关掉 Job；procguard 恢复窗口状态；`lost` 出 P1 |
| 代理的管道关闭，或 host 退出 | `lost`，P1 |
| 始终（≤500 ms） | procguard 检查：Job 之外没有 `cua-driver*.exe`、没有新的 `\\.\pipe\cua-driver*`、输入桌面 = Default、会话未锁（WTS 通知）、你在场（N s 内有非合成的 Raw Input，Q-C9；不用 `GetLastInputInfo`）；任何一项不满足就 suspend + `kill-tree` |

**Governor、Reaper、Job 与 kill** [cu]

- **Governor**：运行时按独立的 `instruments{maxBrowsers: 6, ramGB}` 预算授予 Tier 0，不计入 `tempo.maxActive`（否则一个在浏览的乐手会被算两次）；预算按每个浏览器约 0.4 GB 预留（假设，留出 Tier 0 行约 280 MB [cu] 之上的余量；§10.12）。Tier 2/3 只有你授予（D8）。
- **Reaper（Windows）**：Chrome 的 `lockfile` 是 delete-on-close，第二次启动同一目录会以退出码 21 结束，不会留下陈旧的锁。遇到 21 时按 pid + createTime 找持有者：我们的 → kill 或排队；外来的 → `foreign-held`。`SingletonLock` 的处理只在 Linux 上有意义。连续 3 次失败后 P0（OC#79960，Linux）。
- **Job 与 kill**：每个浏览器 MCP 的 `command` 是 `procguard.exe run-in-job --job lease:<id> -- node <pinned playwright-mcp>`，每租约一个 Job，挂在 host Job 下（Claude 进程内 SDK 时挂在总 Job 下）。kill 的顺序：`browser_close`（2 s）→ `kill-job` → 在途写入记 `unknown-outcome`。UI 浏览器始终受保护（E14）。

**Tier 2 撤销开关**（Q-C9；A29）[cu][dcu]

- **探测物理输入**：procguard 自己的线程上注册 Raw Input（`RIDEV_INPUTSINK`），`hDevice ≠ NULL` 视为物理输入（S4 验证）。低级钩子超过 `LowLevelHooksTimeout` 会被系统静默移除，只做辅助。
- **前台驾驭器**（打过补丁的 Windows-MCP）：每次 SendInput 在 `dwExtraInfo` 里盖上租约的 `nonce`；没有 nonce 的注入输入 → `suspended`，P1。
- **cua-driver 盖不了 nonce。** 它会在这些路径注入输入：pen 点击（Chromium / Electron 上除单次左键以外的点击，以及 UIA 动不了时的 WPF / Tk / GTK 元素点击；`impl_.rs:3961-3973,4069-4084`）、SendInput（前台投递与桌面范围滚动；`keyboard.rs:476,572`；`mouse.rs:639`；`impl_.rs:6355-6392`）、VK_NONAME（前台激活；`inject.rs:138-146`；`keyboard.rs:613`；`mouse.rs:579`）；路径都在 cua-driver 0.37.0 的 `rust/crates/platform-windows/src/` 下。代理把这些路径全部拒绝，只接纳 WPF / Tk / GTK 之外窗口上的单次左键元素点击，所以它的租约期间任何注入输入都是外来的 → `suspended`，P1，不做在途归因。S-CU 要测 Raw Input 是否把 pen 标为注入（未核实）。
- **后台租约**以热键或离席结束（N s 内没有非合成的 Raw Input，Q-C9；不用 `GetLastInputInfo`），不以你的物理输入结束。`RegisterHotKey` 始终开着。

**Tier 2 驾驭器** [cu][dcu]

Tier 2 已定（Q-C1 = B，2026-10-27）；这个驾驭器只在 S-CU 通过且你选它（Q-DC6）时才交付。候选：cua-driver-rs 0.37.0 的 `mcp --direct`，用 sigstore + SHA256SUMS + Authenticode 三重校验（Q-DC3），绝不跑 `install.ps1`；只在租约 `active` 期间由 procguard 拉进 Job `lease:<id>`；`standard` 模式 + 每租约 manifest；私有 `CUA_DRIVER_RS_HOME`；只接纳按元素寻址的后台调用。后备顺序：通过 S-CU 的最新 ≥0.32.0 版本（更早的版本没有 sigstore）；再退到钉死的 Windows-MCP，去掉 PowerShell、Registry 与进程工具（前台，nonce 开关）。`orchestra-desktop` 代理按你授予的每租约白名单核对每个目标：AUMID，或 exe 路径 + Authenticode 签名者，再加 pid + createTime；绝不把 `ApplicationFrameHost.exe` 当作身份，AFH 的框架解析到它承载的应用。终端、运行、设置、UAC、密码管理器、UI 浏览器、DSH web / Desktop 的窗口永远拒绝。宿主 harness 由 Q-DC0 决定；完整配方、环境变量与拒绝清单见 §10.16。

**原生 CU 只观察、不中介** [cu]

任何租约期间 procguard 以 ≤500 ms 轮询：`codex-computer-use.exe`、带 `cua-repl` / `@oai\sky` 的 node、`\\.\pipe\codex-computer-use-*`、Claude Desktop 的 CU helper、我们 Job 之外的 `cua-driver*.exe`、`cua-driver-serve` 计划任务、`\\.\pipe\cua-driver*`，以及外来注入。检测到就：挂起自有驾驭器、冲掉按键、P1、建一个 `desktop` 伪租约。你自己启动的原生 CU 总是赢。自有 DSH 会话在桌面 host 之外装了 CU 包时是 P1 横幅 + 伪租约还是 P2 横幅，是 Q-DC5。

### 10.15 乐器规则 E1–E15 与两阶段审批

§10.13 给出乐器模型（D17），§10.14 给出 Grant 与 Lease。本节把它们落成 Orchestra 强制执行的 15 条规则，再写清浏览器写入类动作的两阶段审批流程。规则正文按 [cu] 翻译，「执行者」一栏写明由谁强制；[cu] 标为假设的数值这里原样保留（假设）。路径缩写沿用 [cu]：`CCD/` = code.claude.com/docs/en/；`PWM` = playwright-mcp README v0.0.83；`loop.js`、`session.js`、`browser-plugins.js` 是 DS-Bot 浏览器插件的文件。

| # | 规则 | 执行者 |
|---|---|---|
| E1 | **隔离 profile。** 自有乐手绝不使用 `--extension`、`--autoConnect`、Claude in Chrome 或 Codex `claimTab`。自有 Claude 启动时传 `--no-chrome`（`CCD/cli.md:110`）；每次乐章启动都断言 `system/init.tools` 里没有原生专属的 CU 前缀（`mcp__Claude_Browser__*`、`mcp__claude-in-chrome__*`、`mcp__computer-use__*`、`mcp__remote-devices__*`），否则 P0 [cu] | orchestrad、procguard |
| E2 | **登录态只经 Grant。** agent 永不输入凭据 [cu] | 你、orchestrad |
| E3 | **动作分级。** 常规：在 Grant 的 origin 内导航、读取。两阶段审批：传输类（submit、upload、输入文字、select、Enter、drag、任何无法证明只是导航的点击）、表态类（representational）、破坏 / 金融类（含 `handle_dialog` 的接受）。交接 handoff（Orchestra 更严格的选择）：凭据、支付、CAPTCHA（DS-Bot 把支付交回人，`browser-plugins.js:64-66`；Claude in Chrome 在登录 / CAPTCHA 处暂停，`chrome.md:11`）。Codex `confirmations.md:21-79` 只用来参考分级（它把 CAPTCHA 与金融列为「始终确认」）。永远隐藏 `browser_evaluate`、`browser_run_code_unsafe` [cu] | 代理（有绑定力）；`canUseTool`、`approval_mode` 作第二层；DSH 的 pre-execute 只能靠 hooks-claude-code 的 PreToolUse `ask` hook（只带 callId） |
| E4 | **出口过滤。** 每个 Tier 0 Chromium 用 `--proxy-server` 指向 orchestrad 的过滤器；关闭不走代理的 WebRTC UDP 与 QUIC。默认拒绝；放行 Grant 的 origin（CONNECT 主机名做 IDNA 归一化，重定向重新检查：CVE-2025-47241）；永远拒绝回环、局域网、`orchestra.localhost`。`PWM:410-412` 的列表与 Codex 的 `deniedDomains` 只是纵深防御 [cu] | 出口过滤器 |
| E5 | **UI profile。** 不装 agent 扩展、不开 CDP。任何 Tier 2 租约期间，UI 服务端拒绝除 `revoke-lease` 外的所有人类动词（「审批已冻结」）；`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 监视到 UI 浏览器来到前台即撤销租约 [cu] | UI 服务端、procguard |
| E6 | **粘性 taint，只给侦察乐手。** navigate、snapshot 或 screenshot 污染乐章（`provenance:[browser:<origin>]`）。新乐章若 `handoffNote` 来自污染乐章，或其乐手持有 mode ≠ off 的 Grant，则一开始就污染；闲置释放不清除。清除需要你的有据动作，或带运行时生成的结构化笔记的轮换加 profile 重置。乐器只给 `kind: scout`（只读预设、无 shell、独占 host）[cu] | orchestrad、代理 |
| E7 | **图片只传引用，agent 永不转发。** 一张被改过的图片能劫持高达 67% 的 agent（arXiv 2406.12814）[cu] | 邮局、存储 |
| E8 | **代理在响应路径脱敏**，先于模型和任何 harness 日志。图片默认 `--image-responses omit`；开启视觉时，匹配到密钥的元素框涂黑 [cu] | 代理 |
| E9 | **保留期。** Orchestra 存储：截图 24 h（假设）、快照 14 d。harness 自己的存储（Claude `tool-results`、DSH attachments、Codex rollouts）在此之外：开视觉的 Claude 乐手采用 Q8 的 B 选项（私有配置根目录、短 `cleanupPeriodDays`），乐章销毁时清除过期文件 [cu] | 存储、orchestrad |
| E10 | **不读任何浏览器状态。** 不读 profile 目录、`cookies.json`、`*storageState*.json`、`auth.json` 或 DPAPI；永不 `--caps storage\|config\|network`；代理隐藏 `browser_cookie_*`、`browser_storage_state`（PWM:1233-1386）[cu] | fs 白名单、代理 |
| E11 | **上限。** 8 步、每步 2 图（`loop.js:39,88`）；≤180 KB（`session.js:511-512`）；≤1,600 px（MaiBot `config.py`）；每乐章小时约 20 图（假设），按 `imageTokens{estimated}` 计量并由 Governor 预留。浏览器 MCP 只挂到正在浏览的乐章（schema 约 4.8k token，DSH-D#7080）[cu] | 代理、Governor |
| E12 | **结果不明的写入只观察，绝不重发**（`session.js:407-422`）[cu] | 代理 |
| E13 | **绝不回答 `always`。** 对任何原生授权提示不选「始终允许」；只用钉死的、仅 stdio 的 MCP（CVE-2025-9611）[cu] | orchestrad |
| E14 | **kill 只关租约的 Job**，绝不关你的 Chrome [cu] | procguard |
| E15 | **不共享。** `hostKey` 含乐器类别；每租约一个在途调用；分身默认 `off`，除非服务端看到 `parent_tool_use_id`；DSH 的分身无法区分，所以 DSH 桌面 host 只跑一个乐手、一个 Session、无子代理 [cu] | orchestrad、代理 |

**两阶段审批（E3 的执行方式）。** 写入类调用立刻返回 `{status: 'approval-pending', approvalId}`，所以不会触发任何 harness 的超时（DSH 的 MCP 调用超时是 60 s）。代理用自己新取的快照（URL、frame、role、name、裁切图）生成 InboxItem；agent 给出的 `element` 文本在卡片上标为污染内容显示。agent 带 `approvalId` 重新调用时，代理重新核对摘要、URL 和 frame，然后只执行一次。这和 §10.9「批准与请求绑定」是同一条规则在代理层的实现：审批携带 `actionClass` 与 `elementDigest`，摘要对不上就拒绝。Tier 2 的桌面写入在 E5 冻结审批期间永不返回 `approval-pending`；它们走 Q-DC7 选定的路线，在该问题回答之前一律拒绝（`no-approval-route`，§10.16）[cu][dcu]。

**模式。** 本节与 §10.13、§10.14 对应的模式是 A21–A30：按租约包装 playwright-mcp、无障碍树优先（A21）；`orchestra-browser` 代理负责分级、两阶段、taint、脱敏、计量（A22）；profile 绑定 Grant、按租约持有、跨轮换存活（A23）；查询阶梯 API → fetch → 无障碍文本 → 截图 → 桌面（A24）；结果不明不重发、`handoff` 条目只有你能结束、删除类用 nonce 确认（A25–A27）；图片只传引用并限额（A28）；桌面租约撤销：前台驾驭器凭物理输入，后台 cua-driver 凭热键与离席（A29）；一次性桌面槽位（A30，计划外）。来源与落地里程碑见附录 E；零 token 验收用例 CU-1…CU-17 见附录 F [cu]。

**否决的做法** [cu]：自建 CUA 循环与像素优先 agent、厂商 CU 进自有乐手、DSH 注册表当租约、进程内 provider、storage-state 交接、默认配置的 WSL2 当边界、无人值守的已登录浏览、SendInput / pen 式「后台」等，逐条附理由见附录 E.2「来自浏览器与桌面 computer use 调研」，此处不再重复。

### 10.16 桌面驾驭器：DSH 是插座，不是乐器

本节回答「DSH 乐手能不能有桌面的眼睛和手」，来源是 [dcu]，它是对 [cu] 的扩展；[cu] 里的勘误已经应用，这里不再重复。路径缩写沿用 [dcu]：`DSH/` = 上游仓库 `deepseek-harness@22ddee3` 的克隆；`DP/` = 本机安装的 rc.2 `@deepseek-ai`（路径约定见前言）；`CUA/` = `trycua/cua` 仓库的 `libs/cua-driver/`，v0.37.0；未加前缀的 Rust 源文件路径在 cua-driver 0.37.0 的 `rust/crates/` 下（如 `platform-windows/src/`、`cua-driver-core/src/`）。`cua#n` 指 trycua/cua 的 issue。

**立场** [dcu]

1. `dsh-computer-use` 是一个 30 行的注册表，为每个 Cordis 服务实例保留一个 provider 名字：没有工具、锁、租约或审批（`DSH/packages/computer-use/computer-use/src/index.ts:16-46`）。
2. 承载它的是实验性 provider：`cua-driver-mcp` 拉起上游的 `cua-driver mcp`；`cua-driver-native` 在进程内加载 SDK 0.28.0；macOS 上的 `dsh-cua` + `cua-macos` 另加按应用的 consent。
3. 这些包没有一个在 rc.2 里；它们的 npm `latest`（0.1.6-alpha.1）会让启动失败（DSH-D#6788）。
4. **结论**：是，一个 DSH 侦察乐手可以经上游 Cua Driver 获得桌面的眼睛和很窄的手，但 DSH 只是插座：协调留给调用方（`DSH/docs/subsystems/computer-use.md:35`），工具对整个 host 全局可见、被子代理继承，侦察乐手的组合里也没有任何东西会先问一声。Lease、审批、隔离和 kill 由 Orchestra 提供。
5. **变化**：Tier 2 得到一个候选驾驭器（`cua-driver`，MIT，按窗口寻址、拒绝码精确），放在 `orchestra-desktop` 之后；`orchestra-desktop` 是任何自有 harness 都能挂载的 MCP 服务端；宿主由 Q-DC0 决定；M2 末跑一次只测驾驭器的 S-CU spike（go 判据见 §13.4）。
6. Windows 上的「后台」是补偿出来的：无法 post 的点击会变成按屏幕坐标的 pen 点击，不论是否按元素寻址；Electron / Chromium 里的输入文字被拒绝。所以 Tier 2 先看后动；`act` 要等 S-CU 的写入投递测量（推断）。
7. **不变**：D8、邮局是唯一总线、D18、Tier 0、Lease 状态机（加一个离席触发）、E5（除非 Q-DC1 或 Q-DC7 另有决定）、自有 Claude / Codex 乐手不用厂商 CU。

**包映射** [dcu]（`npm view`，2026-10-26；每个已发布的 DSH 包还带 `alpha` 0.2.1-alpha.5、`next` 0.2.1-rc.4 两个 dist-tag，并发布了精确版本 `0.2.1-rc.2`）

| 包（`@deepseek-ai/`） | 角色 | 平台 | npm `latest` | 在 rc.2 中 |
|---|---|---|---|---|
| `dsh-computer-use` | 名字注册表 | 任意 | 0.1.6-alpha.1 | 否 |
| `…-computer-use-cua-driver-mcp`（下文简称 `cua-driver-mcp`） | 拉起 `cua-driver mcp` | 任意（无 OS 限制） | 0.1.6-alpha.1 | 否 |
| `…-computer-use-cua-driver-native` | 进程内 SDK 0.28.0 | win32 / darwin / linux | 0.1.6-alpha.1 | 否（0.1.7-rc.2 起不在安装闭包内，`a3480857`） |
| `dsh-cua` | 对象 API、consent、图片 | 平台中立 | 0.2.1-alpha.3 | 否 |
| `dsh-experimental-cua-macos` | provider + Swift helper | macOS 14+ | 0.2.1-alpha.3 | 否 |
| `dsh-cua-bundle` | 注册表 + cua-macos + dsh-cua | macOS | E404 | 否 |
| `dsh-mcp-client` | MCP 客户端、结果适配器 | 任意 | 0.0.1-rc.1 | 是 |
| `@trycua/cua-driver`（上游，不在 `@deepseek-ai/` 下） | 上游 SDK（exe 只在 release zip 里） | win32 / darwin / linux | 0.37.0 | 否 |

源码在 `DSH/packages/{computer-use,experimental,mcp}` 下。provider 对 `dsh-mcp-client` 是普通依赖，不是 peer 依赖。

**DSH 怎么做** [dcu]

- **注册槽位。** 任何名字被占用时 `register()` 直接抛错（`computer-use/src/index.ts:35-45`）；DSH 否决过「Session 所有权经纪」（`.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md:29`）。
- **进程模型。** *MCP*：provider 上下文里的一个 stdio 客户端；配置项有 `command`、`args`、`toolCallTimeoutMs`、`reconnect`，没有 env（`computer-use-cua-driver-mcp/src/index.ts:20-42,52-70`）；不对 Session 做串行化（README:114）。*Native*：进程内；崩溃会带倒 host（README:43）。*Swift helper*：全局 FIFO，返回 `{dispatched:true, verified:false}`（`cua/src/protocol.ts:130`）。
- **Consent（仅 macOS；`cua/src/application-access.ts:134-183,272-277`）。** 按应用询问；会话级授权只在内存里，「始终允许」会写入全 profile 生效的 `allowedApps`，拒绝按 Session 粘住，撤销会中止在途工作；身份 = SHA-256(路径 + designated requirement)（`ApplicationAuthorization.swift:14-24`）。ACP 只桥接 `approval/request`，没有 User Questions 或 elicitation（`acp/acp/src/index.ts:158-176`；`acp/README.md:82,177`），所以 ACP 上的侦察乐手除非 `allowedApps` 已列出该应用，否则关死；`cua` 工具只为 `agentPreset`（默认 `ptc`，`cua/src/index.ts:349-376`）挂载。
- **图片路径。** 截图需要 attachment store 和一条声明支持图片的模型路由（`mcp-client/src/tools.ts:352-379`）：dsh-base 挂了 `attachment-local`（`DP/dsh-base/cordis.patch.yml:146-147`），`deepseek-flash` 声明了图片输入（`DP/dsh-llm-deepseek/lib/index.js:42-48`），但 ACP 行配置的 `deepseek-v4-flash` 不在目录里。模型看到的是 `content`（`tools.ts:261-263,307-311`），永远看不到 `structuredContent`（`effect`、`delivery.mode`、`element_token`；DSH-D#7788，未关闭）。
- **审批。** `tools/pre-execute` 默认放行（`core/tools/src/pipeline.ts:198-205`）。它的五个监听者里只有 auto-review（一个 LLM，`auto-review/src/index.ts:706`）和 hooks-claude-code（PreToolUse，`hooks-claude-code/src/index.ts:243-249`）会返回 `ask`；两者都不在 dsh-base 或 acp profile 里，所以侦察乐手的桌面工具不经提示就执行。一个 PreToolUse hook 到达 ACP `session/request_permission` 时只带 `toolCallId`，没有参数（`acp/src/index.ts:158-174`）。
- **遗留给调用方的部分。** browser-use-runtime 给每个 Agent 自己的 MCP 客户端，关闭失败时保持持有（`browser-use-runtime/src/mcp.ts:102-219`；`index.ts:60-197`），但这个持有不排队（DSH-D#7007、#7169、#9688）。computer use 把跨 Session 协调、应用预留、回滚、权限 UI、脱敏、kill switch 和 attachment 的 GC 都留给调用方（`DSH/docs/subsystems/attachment.md:176`）。
- **报告之间的分歧。** 原生 SDK 在 Windows 11 上可用（DSH-D#6780、#8927），但 `cua-driver mcp` 的 exe 在本机未验证，DSH 的 Windows helper 没有公开代码。MCP provider 不钉任何二进制（`src/index.ts:33-34`）；只有 ≥0.32.0 带 sigstore（`install.ps1:177-181`；0.28.0 只有 `checksums.txt`）。0.38.0 把元素 token 限定到单个进程（cua#5910），只对一次性 `call` 致命。

**Windows 现实** [dcu]

- **账本。** `CUA/docs/action-support.md:21,32-33,54-60`；Windows 的行从 0.28.0 到 0.37.0 没变，但只来自一次运行（`29257963004`，提交 `64e82449`，2026-07-13）：122 行，99 行投递成功，23 行精确拒绝。Electron 在后台只投递左键点击和子窗口动作（右键、双击、拖拽 → `background_occluded`）；Tauri 覆盖面广；WPF、WinUI3、WebView2 部分可用。Chromium 把 post 进来的指针、键盘和文本都算作丢弃（`input/delivery.rs:101-112`）：输入文字、按键和滚动被拒绝，点击被改道，从不经 UIA 调用。
- **焦点与注入。** 元素点击先试 UIA 的 Invoke / Toggle / Select / Expand（只对 XAML 与 Chromium 宿主在 `EnableWindow(FALSE)` 里进行，`fg_bypass.rs:22-30,58-75`）；失败后，会丢弃 post 点击的目标（WPF、Tk、GTK；`input/delivery.rs:101-155`）得到一次合成的 pen 点击，其余走 PostMessage（`tools/impl_.rs:4069-4086`）。后台时 Chromium 跳过 UIA：单次左键用 post，其它都是 pen（`impl_.rs:3916-3973,4270-4311`），GTK 的双击也是（`:7020-7042`）。pen 点击按屏幕坐标路由，先做遮挡检查，在 `WS_EX_NOACTIVATE` 下执行，然后重新断言你的前台窗口（`inject.rs:116-131,176-220,291-367`）。`launch_app`（UWP 恢复）、`invoke_menu`、`bring_to_front` 和前台键鼠路径都会注入 `keybd_event(VK_NONAME)`（`inject.rs:138-146`；`launch_uwp.rs:141-173`；`keyboard.rs:613`；`mouse.rs:579`）；前台投递与桌面级滚动用 SendInput（`keyboard.rs:476,572`；`mouse.rs:639`；`impl_.rs:6355-6392`）。窗口状态只在 Rust 的 `Drop` 里恢复，所以调用中途被 kill 可能让目标留在禁用状态；未关闭：cua#3355、cua#1706。
- **闸门。** `standard` 模式不弹任何提示（`cua-driver-core/src/tool.rs:2495-2506,2659-2666,2763-2766`），除非配置了能力 manifest；配置后它拒绝未声明的工具，并把桌面输入和观察限制在列出的窗口或应用内，但从不检查投递模式（`tool.rs:2667-2693`；`authorization.rs:269-288,1156-1176`；`session_manifest.rs:293-312`）。`bounded` 模式需要 manifest，却把「现有浏览器 profile」和 Computer History 两个适配器提升为允许（`authorization.rs:170-189,393-460`）：比 `standard` 更松。manifest 需要 `…_FILE` 与 `…_APPROVED=1` 两个变量（`authorization.rs:1314-1319`）。遥测（`telemetry.rs:1-26`）和 `run_script` 默认开启；输入没有锁屏闸门（它的锁屏分类器只用来解释一次失败的截图，`diagnostics.rs:180-224,262-266`；`capture.rs:774-778`）。
- **进程。** 只有 `cua-driver mcp --direct` 始终拥有自己的运行时；裸 `mcp` 一旦存在 Computer History 的接纳偏好，就会代理到（或拉起）`\\.\pipe\cua-driver` 上分离运行的 `serve` 守护进程（`main.rs:436-452`；`history_runtime.rs:73-98`；`cli.rs:1601-1641,1849-1932`）；`serve` 接受任何同用户进程，扩展从 `CUA_DRIVER_RS_HOME` 加载（`extension_manager.rs:1052`）。`install.ps1` 默认 `$AutoStart = $true`（它 `:61-67` 的帮助文本却写着「默认关闭」），注册一个 RunLevel=Highest 的计划任务（`scripts/install.ps1:94-100,677-684`），并且在 zh-CN 下报错（cua#2106），而本机正是这个区域设置。UWP 顶层窗口属于共享的 `ApplicationFrameHost.exe`（`impl_.rs:2847-2856`）。
- **成熟度。** 全部是预发布版；三周内 14 个 release；5 个 Windows P0 未关闭，含 cua#3330（bounded 身份无法匹配 Windows 应用授权；在 0.37.0 上未确认）。安装器从 0.22.0 起要求 `Cua AI, Inc.` 的 Authenticode 签名（`install.ps1:69-73,1335-1349`）；社区的 `dsh-computer-use-win` 会借用前台。

**与乐器模型的契合** [dcu]

| Orchestra | DSH 机制 | 缺口 |
|---|---|---|
| Lease | 名字槽位 | 没有持有者、队列或过期 |
| Grant | macOS consent；`allowedApps` 全 profile 生效 | Windows 上没有 |
| E5 | DSH web / Desktop 里的 consent 卡片 | 持有者自己就能点它们 |
| E6–E9 | 没有 taint；attachments 永不 GC | 代理负责；orchestrad 清扫 |
| E12 | dispatched ≠ verified | 模型只见 `content` 文本，`isError` 时也是（`tools.ts:261-263,296-299`）；代理把 `effect`、`transport`、拒绝 `code` 折进文本 |
| E15 / 分身 | 子代理继承工具；没有调用者 id | 每 host 一个乐手、一个 Session、无子代理 |
| D8 | ACP 只转发 `session/request_permission` | consent 没有 ACP 侧的回答者 |

**决策。** *复用*：browser-use 的持有语义（改为排队，放进 Lease）；attachment store（由 orchestrad 清扫）；`standard` + manifest（工具白名单、精确到窗口的上限）。*包装*：用 ACP `session/new{mcpServers}` 挂 `orchestra-desktop`，Agent 级作用域（`acp/acp/src/mcp.ts:20-33`）；它的默认重连（`mcp-client/src/connection.ts:41-46`）无害，因为权威在 orchestrad；注册表 + `cua-driver-mcp` provider 只在 S2 发现 ACP 挂载会丢图片时才用；结果适配器照用 [dcu]。

**组合配方** [dcu]

*Windows 桌面 host*（若 Q-DC0 选 DSH）：`hostKey` = musicianId；orchestrad 是它唯一的 ACP 对端，只发一次 `session/new`，永不 `session/resume`（`acp/acp/src/index.ts:189`）；profile 关闭九个委派行（`DP/dsh-base/cordis.patch.yml:359-407`）；私有 `DSH_HOME`；精确钉 0.2.1-rc.2；新乐章就重启 host。

```yaml
# <侦察乐手的 DSH_HOME>/profiles/acp/cordis.patch.yml
- id: acp
  config: { provider: deepseek-official, model: deepseek-flash }   # 声明图片输入
- { id: subagent, disabled: true }   # 以及另外八个委派行
# ACP session/new 的 mcpServers[0]，永不落盘：
# { name: orchestra-desktop, command: <node.exe>, args: [<orchestra-desktop.mjs>, --part, <partId>],
#   env: [{ name: ORCHESTRA_PART_NONCE, value: <每乐章轮换> }] }
```

*`orchestra-desktop`*（面向 harness 的 MCP 服务端）：
- 对外只提供固定的约 10 个工具，驾驭器不运行时也如此（DSH-D#7080：55 个工具约 23.5k token；0.37.0 的实际数目由 S-CU 统计）；忽略上游的 annotations；
- 经 named pipe 连 orchestrad，只在它是已登记 host 的后代（procguard `pipe-client-pid`，pid + createTime）并持有每乐章 nonce 时才被接纳（§8.5；S2 核查 DSH 不会把 nonce 写进日志）；每个 Lease 一个代理实例；
- 只在 Lease 为 `active` 时，把 `procguard.exe run-in-job --job lease:<id> --env-allowlist <file> -- cua-driver.exe mcp --direct` 作为自己的 stdio 子进程拉起（一次性，KILL_ON_JOB_CLOSE，嵌套在 host Job 下）；orchestrad 记录 `actuator{pid, createTime, jobId}`，用 `kill-tree` 结束它。环境变量从零构造，不设 `CUA_DRIVER_HOME`（它优先于 `CUA_DRIVER_RS_HOME`，`history_runtime.rs:374-376`）：`CUA_DRIVER_PERMISSION_MODE=standard`；`CUA_DRIVER_CAPABILITY_MANIFEST_FILE` = orchestrad 根据你的桌面 Grant 写出的 YAML，其中 `allow.tools` = 代理的工具列表，`resources.desktop.windows` = 精确的（pid, window_id）对（打包应用用 AFH 的 pid + frame），不写 `apps`、`applications` 或 `display`，`expires_after` = 租约 TTL，`idle_timeout` 60 s（`session_manifest.rs:525-627`；manifest 没有投递模式字段，所以后台上限只能由代理执行）；`CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED=1`；每租约一个空的 `CUA_DRIVER_RS_HOME`；`CUA_DRIVER_DISABLE_RUN_SCRIPT=1`；`DO_NOT_TRACK=1`；`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`；`CUA_DRIVER_RS_UPDATE_CHECK=false`；
- 一次只接纳一个带 `pid` + `window_id` 的元素寻址调用；拒绝 x/y 坐标；`click` 只接纳左键、`count` 为 1，且绝不对 WPF、Tk、GTK 窗口（那里 UIA 失败会退到 pen，`impl_.rs:4069-4084`）；结果为 `windows_targeted_injection` 时 → `suspended`，P1；拒绝 `double_click`、`right_click`、`drag`、`launch_app`、`invoke_menu`、`bring_to_front`、`set_window_frame`、桌面级 `move_cursor`、前台投递、`get_desktop_state`、剪贴板、`run_script`、`run_steps`、`kill_app`、`page` / `browser_*`、录制与历史；从不调用 `list_windows` / `list_apps`（枚举由 procguard 做），因此不需要 `display` 授权，那同时也会放开桌面范围的输入（`session_manifest.rs:221-228`）；
- 每次调用都重新匹配目标：`ApplicationFrameHost.exe` 的 frame 按其托管 `CoreWindow` 进程的 AUMID（解析方式同 `win32/windows.rs:732-773`），其余按 AUMID，否则 exe 路径 + Authenticode 签名者，否则授权时钉住的路径 + SHA-256（Q-DC2）；外加 pid + createTime；AFH 永不作为应用身份；永远拒绝终端（打包的按 AUMID）、运行、设置、UAC、密码管理器、UI 浏览器、DSH web / Desktop；
- 记录每个目标的启用状态与窗口样式；到了自己的截止时间（低于 host 的 MCP 超时）就在 journal 记 `unknown-outcome`，重启驾驭器，并在一次读取把状态确认下来之前回答 `busy`；
- `act` 只经 Q-DC7 选定的路线执行，否则拒绝写入（`no-approval-route`）；没有 `active` 租约时任何桌面工具都返回 `no-lease`；一个步骤绑定（应用身份、HWND、工具、全部参数、`role`、`label`、父级 label、`frame` ±4 px、文本摘要），只在恰好一条新鲜的无障碍行匹配时按计划顺序执行一次；未命中（`stale-approval`）、多义（`ambiguous-target`）、`in_web_content` 目标或 `unknown-outcome` 都中止整个计划（0.37.0 的行没有 RuntimeId；`label` 回退到 value，`impl_.rs:1109-1163`）；对已被拒绝的（乐章，应用，窗口，actionClass）的重复自动拒绝，只出一条 P2 `flood`；把结果字段折进文本；脱敏、计量、taint；`look` 默认给 UIA 文本，图片须显式开启。

租约每一步的动作（queued → active 换新进程、draining ≤2 s、suspended / revoked / lost、代理管道关闭、procguard 的 ≤500 ms 检查）见 §10.14 的「桌面租约的每一步动作」表，此处不再重复。

*Claude 桌面 host*（若 Q-DC0 选 Claude；推断，细节待 S-CU 后补）：`orchestra-desktop` 像 `orchestra-mcp` 一样经 SDK `mcpServers` 以进程内服务器（`type:'sdk'`）挂载，身份就是守护进程手里的 `query()` 对象，所以不经 named pipe、也不需要每乐章 nonce（§8.5；stdio 挂载会把含 nonce 的 env 写进 `claude.exe` 命令行，不用）；驾驭器由 orchestrad 用同一条 `procguard.exe run-in-job` 命令拉起，租约 Job `lease:<id>` 挂在总 Job 下（§5.1）；`--no-chrome` 与 E1 的断言照常；环境变量与拒绝清单与上文相同。

*前提*：经 sigstore、SHA256SUMS、Authenticode 三重校验的 0.37.0 zip（永不用 `install.ps1`）；orchestrad 对 `<DSH_HOME>/attachments` 的 TTL 清扫；侦察乐手预设 = `read-only` 沙箱 + `approval: ask`（`DP/dsh-base/cordis.patch.yml:259-270`；它只路由沙箱升级类的请求）、无 shell（E6）；收件箱里只有人能审批（D8）；S4 交付一个一次性的 stdio `run-in-job` 包装器，带 `--env-allowlist` [dcu]。

**macOS：不提供。** `cua-macos` 没有 Lease 闸门也没有代理，它的工具对每个 PTC Agent 都是活的，consent 比租约活得久，「始终允许」全 profile 生效（违反 E13），而且 PTC 与 E6 冲突 [dcu]。

**模式。** 本节对应的模式是 A31–A39：dispatched ≠ verified，只观察不重放（A31）；目标元素变了审批即失效（A32）；锁屏或离席即杀驾驭器（A33）；cua-driver 只走后台，拒绝不等于放行前台（A34，Q-DC4）；身份 = AUMID 或路径 + 签名者，加 pid + createTime（A35）；只有会话级授权，不用 `allowedApps`（A36）；撤销即中止在途工作并换新驾驭器进程（A37）；独占的排队持有，关闭失败仍持有（A38）；结果字段折进文本、工具子集精选（A39）。来源与落地里程碑见附录 E；零 token 验收用例 CU-18…CU-30 见附录 F [dcu]。

**否决的做法** [dcu]：注册表当租约、原生 provider、`allowedApps`、DSH 的审批当闸门、`bounded` 模式、裸 `mcp`、`install.ps1` / `serve` / Computer History、`run_script` / `run_steps` / `launch_app`、v1 里的 pen 点击、一次性 `call`、`cua-macos` 与社区 bundle；逐条附理由见附录 E.2「来自 DSH computer use 调研」。

**风险** [dcu]：
- 驾驭器恢复你的前台窗口时可能把 UI 浏览器抬到前面，从而触发 E5（推断）。
- Raw Input 如何看待 pen 输入未知（v1 拒绝全部 pen 路径，`impl_.rs:3961-3973,4069-4084`）。
- 上游变动快（cua#5910、cua#3330）。
- 被允许的窗口会暴露其中的全部内容。

**不确定之处** [dcu]：元素点击会落到 pen 已在源码中确认，但 Raw Input 对 pen 与 VK_NONAME 的视角未知；cua#3330 在 0.37.0 的 `standard` + manifest 下是否仍然存在；exe 的实际签名未下载核实；只存在于 GitHub 上的事实（issue 状态、release 内容）在复核时因 GitHub API 不可用而未能重核（未核实）；工期数字（推断）。

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

（本文补充）two-writers、flood 归入 Wrong notes；route-ask、unknown-outcome、timedOut 归入 Fermatas。r3 新增的种类（§6.5）：`lease-request`、`handoff`、`musician-request` 和等你放行的 `held-message` 归入 Fermatas；`stalled-delegation`、`rotation-breaker`、`budget-incident`、`workflow-run`、`arrangement-paused`、`lease-expired` 归入 Wrong notes（分组为推断，以 Q10 为准）[arch][wf][cu]。

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
| P1 | approval、question、unknown-outcome、timedOut；你自己设的到点 reminder；r3 新增：lease-request、handoff、arrangement-paused、stalled-delegation、rotation-breaker、100% 的 budget-incident、musician-request（级别待定，建议 P1） | 通知；专注模式下其它项目的 P1 只进收件箱（审批的特殊规则见下） |
| P2 | decision、failure、orphan、bounce、polling、stale-task、route-ask、observed 的 policy、flood；r3 新增：lease-expired、workflow-run、held-message、80% 的 budget-incident | 只进收件箱，汇入 30 分钟摘要 |
| P3 | ready-for-review；agent 创建的提醒和决策 | 只进收件箱，汇入摘要 |

- **通知通道**：首选 UI 页面调用浏览器 Notification API；没有 SSE 客户端在线时退回 PowerShell 5.1 WinRT toast（文本 XML 转义后经 stdin 传入；点击用 `activationType="protocol"` 打开 `http://orchestra.localhost:<port>/#/item/<id>`，URL 里不带 token）；M2 起另加 `herdr notification show`。Tuning 显示当前是否处于 Windows 勿扰或专注时段（它会压住系统通知）。
- **观察者协议**（A15 [arch]，M2 / M3）：发给主代理与 Maestro 的通知合并且字节稳定，水位线冻结，不自我通知；客户端用 `changesSince` + `historyGap` 补差；SSE 推送 `{upserted, removed}` 并定期发重同步帧；keepalive 静默 4 倍即判死。验收：回放中的轮询 token 占比低于阈值（R04）。
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
| 分组卡片（原生工作流运行：阶段、成员、token、null 数） | Stage 上的分身组（§8.7） | M2 [wf] |

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

泳道时间线：exchange、派生、settle 各占一条；带回放拖动条、按边类型过滤，以及健康图表（rounds-to-done、轮询比、打回次数、孤儿数、每小时干预次数）。**只看不编辑**，没有图编辑器。M3 起 `orchestra_report` 的工作日志与事件关联显示（R15）。M5 加入只读的 AND-join / 循环视图（R16）。M3 起原生工作流运行以只读的 运行 → 阶段 → 成员 树显示（R16 的这一部分从 M5 提前到 M3，§8.7）；M6 起 Circuit 标签页显示 Arrangement 的骨架（阶段列、AND/OR 门、`×n` 总线、「↻ ≤K」循环）与实时覆盖层（Exchange 颜色、计数、null 数、预算表），仍然只看不编辑（§8.8）[wf]。

### 11.5 Ledger

按乐手、按模型显示 token 和 CNY 的 K 线（tonghuashun 的 `deriveCandles`），旁边是 governor 计量。未知用量显示为"未知"，不按 0 计。账本按每次调用的 `purpose` 归因，成本上卷到 `rootId`（A14 [arch]，M2）。

### 11.6 Decision board

- 显示待定和已定的决策。
- "Export ADR" 写出 `docs/decisions/NNNN-*.md`，附带 git HEAD，**只能由你点击**（M1）。
- **已定决策注入 v0（M1）**：每个新乐章的第一条消息附上本项目已定 Decision 的摘要（Decision 编号、你选中的选项、你亲手写的理由、git HEAD）。agent 写的题干只作为数据引用，不以你的口吻注入。注入块在一个乐章内逐字节冻结（A18 [arch]）：决策摘要、人设与交接笔记只在乐章启动时注入一次，中途不变，以保住 prompt cache。
- 对你在原生 CLI 里的会话，建议你自己在 CLAUDE.md / AGENTS.md 里加一行「以 `docs/decisions/` 为准」。这一行由你手动添加，不破坏零写入。
- M5：陈旧注释探针和冲突标记，用来验证注入是否真的有效（R12）。

### 11.7 乐手页、新建向导与交还原生（M1）

**乐手页**：每个自有乐手一页，两个标签。
- **对话**（默认）：流式显示当前乐章的助手文本和工具调用（可折叠）、改动文件列表（链接到 git diff）、收发过的 A2A 信封（带回执状态和 taint 标记）；底部是输入框，可切换 steer（插进当前回合）或 queue（排到下一回合）；顶部显示上下文压力和当日花费。所有内容按 §5.3 的渲染规则显示。
- **档案**：人设、乐章历史与交接笔记、desired vs applied、journal、账本。

**新建乐手向导**：项目 → harness（Claude / DSH；Codex 在 M4）→ 权限预设（只读 / 可写）→ 人设模板（前端、后端、QA、调研、主代理）→ 目录或 worktree（worktree 在 M3）。QA 模板默认只读预设 + 测试命令白名单（例如 `pnpm test:e2e`），可以用 `orchestra_remind` 定时触发，用 `orchestra_report` 回报失败率和失败日志路径。人设模板按车道契约填写：owns / does-not-own / 聊天预算 / handoff，并附 DS-Bot 式的沟通纪律（A18 [arch]，M1）。

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
| **playwright-mcp**（`@playwright/mcp`，Apache-2.0） | Tier 0 驾驭器：钉死版本、不改源码，经 `orchestra-browser` 代理按租约包装、无障碍树优先（A21、A22）；每个租约一个 Job，`--remote-debugging-pipe`，`--proxy-server` 指向出口过滤器 | M1（Claude 侦察乐手只 look）/ M2（完整） | 只用 stdio；代理永远隐藏 `browser_evaluate`、`browser_run_code_unsafe`、`browser_cookie_*`、`browser_storage_state`（E3、E10）；永不 `--caps storage\|config\|network`；Chrome 在 Job 内的成员关系与渲染器沙箱由 S4 核实 [cu] |
| **cua-driver**（上游 trycua/cua，MIT） | Tier 2 候选驾驭器：`cua-driver mcp --direct` 作为 `orchestra-desktop` 代理自己的 stdio 子进程，只在租约 `active` 期间由 procguard 在 Job `lease:<id>` 里拉起；`standard` + 每租约 manifest；只允许元素寻址的后台调用 | M3 look / M4 act（Tier 2 已定；都以 S-CU 通过、Q-DC6 选中为前提） | 只用 release zip，sigstore + SHA256SUMS + Authenticode（`Cua AI, Inc.`）三重校验，永不跑 `install.ps1`、`serve` 守护进程或 Computer History；全部为预发布，三周 14 个版本，五个 Windows P0 未关（含 cua#3330）；0.38.0 把元素 token 限定到单个进程（cua#5910）[dcu] |
| **Windows-MCP**（MIT） | 前台驾驭器后备（Q-DC6 不选 cua-driver 或 S-CU 不通过时）：打补丁把租约 `nonce` 写进每次 SendInput 的 `dwExtraInfo`，供撤销开关识别 | 后备 | 去掉 PowerShell、Registry 与进程类工具；只前台，物理输入即撤销（A29）[cu] |
| **grok-build**（xai-org，Apache-2.0） | 只借鉴设计：journal `(seq, kind, req_hash, result)` 与分歧检查 [wf]、地址解析的拒绝码（`RawSessionId`、`Foreign`、`Stale`、`Unresolved`）、信封的类型化权威 [arch] | 设计参考（M1 起） | 设计复用无需 NOTICE；若复制代码则保留其 LICENSE 与归属（上游没有 NOTICE 文件）；GBR（无许可证的非官方重建）只读 README 级，不再读代码（Q-A）[arch][wf] |

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
| GBR（grok-bot-0.18-reconstructed） | **无许可证**，已归档 [arch] | 只读 README 级参考；不再阅读代码 | 其 NOTICE 不授予任何许可；已标注的 GBR 细节是否保留见 Q-A |
| grok-build（xai-org） | Apache-2.0 [arch][wf] | 设计复用（journal [wf]、地址、信封 [arch]） | 设计复用无需 NOTICE；复制代码须在 Orchestra 的第三方 NOTICE 里保留其 LICENSE 与归属 |
| MaiBot | GPL-3.0 [arch] | **只借鉴设计**（去抖、记忆范围读写标志、`bridge.py` 的沙箱桥接） | 不复制代码 |
| Koishi webui、`xai-org/grok-prompts` | AGPL-3.0 [arch] | **只借鉴设计** | 不复制代码 |
| cordis、Koishi core、OpenClaw、Paperclip | MIT [arch] | 借鉴模式（中间件深度、入站策略、预算事件、观察者协议） | 若复制代码则保留版权声明 |
| playwright-mcp 等 Playwright 工具 | Apache-2.0 [cu] | 钉死版本、不修改，经代理包装 | 保留 LICENSE；不分叉 |
| Windows-MCP | MIT [cu] | 前台驾驭器后备：打 nonce 补丁、去掉 PowerShell / Registry / 进程工具 | 保留版权声明，说明修改 |
| cua-driver（trycua/cua） | MIT [dcu] | 只用经三重校验的 release zip，不改、不 vendor | 保留 LICENSE 副本；Authenticode 签名者应为 `Cua AI, Inc.`（exe 签名未下载核实） |
| Skyvern 等像素优先的 CUA 工具 | AGPL-3.0 [cu] | **不使用** | 无 |
| `@oai/sky`（Codex 桌面 CU） | 权利未核实 [cu] | **不使用**；只作能力对照 | 无 |

Orchestra 自身的许可证在 M0 定（§17 Q9，建议 MIT，附 NOTICE），与 vendored 的 dsh-TUI（MIT）和借鉴 DS-Bot（Apache-2.0）的方式兼容。r3 补充：第三方 NOTICE 还要列出复制自 grok-build 的代码（若有）及其 LICENSE 与归属，并附 playwright-mcp（Apache-2.0）、cua-driver 与 Windows-MCP（MIT）的许可证副本；对无许可证的 GBR 做任何设计参考在 MIT 下是否可接受，见 Q-A [arch][cu][dcu]。

### 12.3 上游台账与社区

- **上游台账**：下列检测器触发时，用零 token 彩排生成最小复现，记入 Tuning 的「上游台账」（`docs/upstream/NNNN-*.md`），由你决定是否提交到 deepseek-ai/deepseek-harness：孤儿孙代理、`ACTIVATION_LIMIT_REACHED` 不排队、任务 owner 不释放、`list_agents` 的范围、按 profile 的团队开关、`repeat-tool-reminder` 不做归一化参数匹配。每个里程碑预算 0.5 天。提交前先对照当前钉死版本的 dsh-base 组合核实（例如 0.2.1-rc.2 的 dsh-base 已经挂载 `list-agents` [核验]）。
- **你自己的上游 PR**（建议，由你提交）：dsh-TUI 的 bypass 选项与凭据注入接口（M1 第 1 周，§7.4）；DS-Bot 的 `fix/permission-switch-race`（M0–M1，§17 Q5b）。
- **可选的社区产出**（不在关键路径，取决于 Q9）：把净室 `wait_subagent` 和后代回收器作为独立包（MIT 或 Apache-2.0）发布到 DSH 群，标注「best-effort，钉死 DSH 版本线」，Orchestra 不依赖它们被采纳；M2 起提供只读的 `orchestra observe --dsh` 健康报告（轮询比、打回次数、rounds-to-done、孤儿、`list_agents` 调用次数），群友可以对自己的 `~/.dsh` 运行；征集经过脱敏的多版本 fixture 进入黄金语料。

---

## 13. 里程碑 M0–M6

### 13.1 总览

r3 并入四份调研后，总工期按「不含 Tier 2」与「含 Tier 2」两种情形给出；Q-C1 = B（2026-10-27）后以含 Tier 2 为基准，不含 Tier 2 为 S-CU 不通过时的退回标尺。周数全部为推断；§13.2–13.7 的小节标题已改为本节标尺的周数（不含 Tier 2；括号里是含 Tier 2 的周数）。[arch] 的 3–4 周没有按里程碑拆分，标尺里大致均摊到 M1–M3（假设）。

**不含 Tier 2（约 30–32 周，推断；S-CU 不通过时的退回标尺）**

```
周:  1–4        | 5–9            | 10–17            | 18–23            | 24–27    | 28–32      ‖ 之后 4–6 周
     M0         | M1             | M2               | M3               | M4       | M5         ‖ M6
     节目单      | 两位乐手        | 安全舞台          | 声部与总谱        | 指挥家    | 溯源与生态  ‖ 编排 Arrangement
     S4 +0.5 d  | +3–4 d 乐器     | +3 周 乐器        | DSH act          |          |            ‖ M4 后 go/no-go
                | +模式 A1–A4 等  | +模式 A5–A7 等    | +模式 A8–A10 等   |          |            ‖
```

**含 Tier 2（约 33–35.5 周，推断；基准：Q-C1 = B 已于 2026-10-27 选定，S-CU 不通过则退回上一张标尺）**

```
周:  1–4        | 5–9            | 10–18            | 19–25            | 26–30     | 31–35.5    ‖ 之后 4–6 周
     M0         | M1             | M2 + S-CU        | M3 + Tier 2 look | M4 + act  | M5         ‖ M6
                |                | 末尾 +2–3 d       | +1.5–2 周         | +1 周      |            ‖
```

含 Tier 2 的标尺按累计偏移画：中间边界取邻近的整周，总数保留 35.5 以与 [cu] 的 33–35.5 周一致；各里程碑的实际增量以其下一行的括注为准；M5 本身不含 Tier 2 的工作（推断）。

| 里程碑 | 周（r2 → r3，推断） | 工期 | 交付后你得到什么 |
|---|---|---|---|
| M0 "The Program"（节目单） | 1–4 → 1–4 | 约 3.5 周（15–18 个工作日）+ S4 0.5 d [cu] | 只读的跨项目收件箱、一次性提醒、死循环告警（Claude、DSH）、刹车、本机 UI 安全；**r3 新增**：S4 顺带核实 Chrome 留在 Job 内 |
| M1 "Two musicians talk"（两位乐手对话） | 5–8 → 5–9 | 约 4 周（第 1 周含 S2、S3）+ 3–4 d 乐器 [cu] + 模式份额 [arch] | 新建 Claude / DSH 乐手、乐手页、乐手互发消息、审批集中处理、决策板 + ADR + 注入、QA 乐手模板、派活标签；**r3 新增**：只有乐手可寻址与 `accepted` 回执、沉默与唤醒、类型化权威、薄完成、冻结注入上下文、轮换小时上限、`orchestra_request_musician`（A1–A4、A13、A16–A18；A8 可编辑排队与 A9 回访的 M1 部分）；工作流钳制与自有 Claude 乐章工作流关闭；Tier 0 只 look 的 Claude 侦察乐手 |
| M2 "Safe Stage"（安全舞台） | 9–12 → 10–17 | 约 4 周 + 3 周乐器 [cu] + 模式份额 [arch]（末尾 +2–3 d S-CU，已定） | 舞台图、账本、对自有会话强制限流与回收、Codex 实时跟踪、专注模式、摘要、周期提醒、DS-Bot 只读；**r3 新增**：权威链、入站策略、重新接纳、死循环细则、预算事件、观察者协议（A5–A7、A12、A14、A15）；原生工作流观察；Grant、出口过滤器、两阶段 `act`、脱敏、每租约 Job、`orchestra-browser` 完整版；排队持有（A38） |
| M3 "Sections & Score"（声部与总谱） | 13–16 → 18–23 | 约 4 周 + 模式份额 [arch]（+1.5–2 周 Tier 2 look，以 S-CU 通过为前提） | 委托树、群聊、任务板、时间线回放、worktree、私有 home bundle；**r3 新增**：hold、执行者、停滞升级（回访在 M1）、房间卫生、轮换熔断其余、例程（A6 hold、A8–A10、A13、A19）；R33 治理与原生运行只读树（R16 提前）；DSH `act`；S-CU 通过后：Tier 2 `look`、`orchestra-desktop`、A31、A33–A37、A39、A29 的后台撤销部分（本文拆分） |
| M4 "Maestro"（指挥家） | 17–20 → 24–27 | 约 4 周（+1 周桌面 act，以 S-CU 的写投递结果为前提） | 指挥家与 AutoRoute（先 shadow），Codex 驱动（过门槛的话），DS-Bot 声部；**r3 新增**：只从候选里选（A11）、查询阶梯（A24）、撤销开关的前台部分（A29）、元素变更即失效（A32）；S-CU 写投递足够时：桌面 `act` |
| M5 "Provenance & ecosystem"（溯源与生态） | 21–25 → 28–32 | 约 5 周 | 陈旧注释探针、记忆范围、repro bundle、导出、成本报价、A2A 1.0 网关；**r3 新增**：记忆范围读写标志（A20） |
| M6 "Arrangement"（编排） | M5 之后 | 约 4–6 周（推断），M4 后 go/no-go [wf] | Arrangement v0：WASM 沙箱里的只读模板（QA 复跑 ×N、对抗核验、评审裁决）、同步 `parallel`、journal + 回放 v0、governor 接纳、预算事件、零 token 试跑、Circuit 标签页 |

M3 和 M5 的范围可以顺延，不会卡住 A2A。每个里程碑都有削减顺序。M6 在 go/no-go 之后，可以顺延或整体不做；Tier 2 已定为必要（Q-C1 = B），但其交付仍以 S-CU 为前提，不通过则按 Q-DC6 改走后备或顺延，同样不卡 A2A。三个总数（不含 Tier 2 约 30–32 周、含 Tier 2 约 33–35.5 周、M6 另加 4–6 周）都是推断 [arch][cu][dcu][wf]。各里程碑的 r3 新增交付物、验收与削减顺序见 §13.2–13.8；WF- 与 CU- 用例全文见附录 F，模式 A1–A39 见附录 E。

### 13.2 M0 "The Program"（第 1–4 周）

M0 按评审的工作量估算重新定界（原范围约 35–45 个工作日）。S2、S3 只服务 M1，移到 M1 第 1 周；S6 与 DS-Bot 源一起移到 M2。如果 M0 提前完成，先在 M0 末尾跑 S2，尽早暴露 DSH 风险。

**第 1–3 天：spike，每个都给出 go / no-go**

| Spike | 要回答的问题 | go 判据 | no-go 时的后备 |
|---|---|---|---|
| **S1-DSH** 按帧 tail | DSH v4 日志由许多独立的 zstd 帧组成（每帧 83 B–62 KB，带校验，windowLog 21）[核验]。用约 40 行的帧遍历器，每个完整帧调一次 `zstdDecompressSync`，游标就是下一帧的字节偏移；测 DSH 的 flush 节奏 | 延迟 ≤2 s | `storages/session_projcache`、只读 web attach；验收改为"有文档记录的后备延迟" |
| **S1-Codex** 单帧 rollout | Codex rollout 每个文件只有一个 zstd 帧（最大的 142 MB）[核验]，需要常驻的流式解码器，重启后要从字节 0 重新解码。在一个正在运行的 Codex 会话上测：每写一条事件，完整 block 能否被解出来？ | 能逐事件解码，延迟 ≤3 s | M0 本来就只轮询 `state_5`；结果只决定 M2 的实时 tail 做不做 |
| **S4** procguard | 用系统自带的 `csc.exe`（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` [核验]）编译约 300 行的 C# helper，作为常驻 JSON-lines 进程，提供 5 个命令：`run-in-job`（建 Job、KILL_ON_JOB_CLOSE、不设 `BREAKAWAY_OK`；以 CREATE_SUSPENDED 启动 → 加入 Job → 恢复；继承 stdio）、`snapshot`（Toolhelp32：pid、ppid、映像名、创建时间、工作集、命令行）、`kill-job`、`kill-tree{pid, createTime}`、`pipe-client-pid`；`run-in-job` 另提供一次性 stdio 模式与 `--env-allowlist <file>`（从零构造子进程环境，Tier 2 驾驭器用，§10.16）[dcu] | 杀掉 orchestrad 后，孙进程 `ping -t` 和 agent 启动的 dev server 都退出；DSH 沙箱内部的嵌套 Job 也随外层结束；Job 记账显示活动进程为 0。**r3 追加（+0.5 d）**：经 procguard 用 `run-in-job` 启动钉死的 playwright-mcp，对每个 chrome.exe 跑 `IsProcessInJob`，关闭 Job 后统计幸存者为 0，读 `chrome://sandbox` 确认渲染器沙箱仍在；Chromium 的渲染器自己也用 Job，Job 只在双方都不设 UI 限制时才能嵌套，所以我们的 Job 不设 UI 限制（成员关系、回收与渲染器沙箱此前都未核实）[cu] | 备选：vendored `@deepseek-ai/dsh-win32-process`（MIT，Koffi）的挂起→分配→恢复原语做 Job，进程快照另走慢路径。最后的后备：登记 pid + 创建时间，重启时清扫，并在 Tuning 里提示孤儿风险。不用 PowerShell Add-Type 常驻进程（启动约 1 s、约 60 MB，且先 spawn 再入 Job 之间有竞态） |
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

### 13.3 M1 "Two musicians talk"（第 5–9 周）

**第 1 周：spike**

| Spike | 要回答的问题 | go 判据 | no-go 时的后备 |
|---|---|---|---|
| **S2a / S2b** 私有 DSH | 用同一张清单给候选 A（私有 `dsh --profile acp`）和候选 B（私有 `dsh web` / `runProfile()` + bundle）打分：① 以非 user 来源投递；② steer；③ 分身树可见；④ 中断单个分身；⑤ job kill；⑥ 崩溃后 `requestId` 去重或日志核对；⑦ 按会话注入 MCP，或原生调用者身份；⑧ 各预设下审批请求能到达（金丝雀命令：向工作区外写文件）；⑨ 3 个会话时的 RSS；⑩ `session/cancel` 是否停止后代、`session/close` 是否回收后代；⑪ 环境变量凭据在空凭据服务下是否生效、`env` 工具调用能否看到 key；⑫ 每乐章 token 是否出现在会话日志里；⑬ 合成后 `cordis.yml` 的快照。预算比原计划 +1 天 | 一次 prompt 跑通；`orchestra-mcp` 被调用；至少一个预设下金丝雀命令产生审批请求，进入审批队列并超时拒绝；合成配置里没有 `approval: never`。默认选 A，B 在清单上明显占优时改用 B | `approval: never` 的任何预设（含内置 Full access）对自有乐手是 no-go，不进入 §17 重新确认。没有可用预设时，M1 先交付 Claude↔Claude 的 A2A（例如 Aiko ↔ Mio），DSH 乐手顺延并在 M2 重新评估 |
| **S3** Claude 后端 | vendored 的 Claude 后端能否配合 fake SDK 运行，并在 haiku-only 守卫下真实跑通一个回合？把 `mcpServers` 从 `omit` 改为 `set`，传入 SDK 进程内服务器，Orchestra 工具能否被调用？`settingSources: []` 下 CLAUDE.md 附加段是否生效？2.1.310 的 `system/init.capabilities` 是否含 `msg_lifecycle_v1`？经 `spawnClaudeCodeProcess` 由 procguard 拉起是否正常？ | 全部通过，bypass 已关闭；`disableWorkflows`（或 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`；SDK `disallowedTools` 只作后备）生效，自有乐章拿不到 Workflow 工具 [wf]；顺带核实 Claude 工作流记录的路径（`journal.jsonl` 此前只见于工具描述；`agent-*.jsonl`、`.meta.json` 出自 cc-codex-protocols.md）[wf] | 如果 MCP 注入不通，乐手只能"收"不能"发"，由乐手页或主代理代发 |

**交付物**
- procguard 下的 `claude-sdk` 驱动（配置隔离，§7.4）和 DSH 驱动（S2 选定的候选；私有 home 组合 v1；每 host 独占 `DSH_HOME`）。
- Musician / Part 登记表（迁移建表）；**乐手页**（对话 + 档案卡 v1）；新建乐手向导；交还原生（Claude）。
- Post Office v1：规则 1、4（合并）、5、6、8、9 与规则 11 的回访部分，带回执；重启三阶段处理与自动核对（§8.3）；taint 与来源链（§8.5）。
- 审批队列：超时拒绝、与请求摘要绑定、按键冻结、来源链红条。
- `orchestra-mcp`：Claude 进程内、DSH named pipe + `pipe-client-pid` + token 轮换；配额。
- Decision board v1 + ADR 导出 + 已定决策注入 v0（§11.6）。
- 派活标签：RouteDecision（`mode=manual`）。
- 对自有乐手的行内回复；desired vs applied 回读（DSH 预设在 host 启动时探测）。
- QA 乐手模板。
- 模式 A1–A4（r3）：只有乐手可寻址（Part id 含 `replyTo` 重解析到当前乐章；拒绝码 `raw-session-id`、`stale`、`foreign`、`unresolved`、`clone-not-addressable`、`template-not-addressable`）；邮件寄给乐手，`accepted` 回执先于 `delivered`，乐章释放后仍送达；沉默有效（`reply` / `notice` / `progress` 不开 Work、不自动回信，`wake: turn|none`，只含致谢的回复作为 `replied(suppressed)` 回执到达、不唤醒）；类型化权威（`trust` 增加 `runtime`，agent 只能 `queue|steer`，中断为人类专属）[arch]。
- A13 轮换熔断的每小时上限；A16 薄完成（状态 + 有界摘要 + refs，截断标 `truncated`）；A17 `orchestra_request_musician`（只生成 InboxItem，由你批准）；A18 每乐章冻结注入上下文（车道契约人设：owns / does-not-own / chat budget / handoff）[arch]。
- A8 的 M1 部分：排队中的 Exchange 在乐手页可编辑（R31；执行者 `executionPartId` 随 M3）；A9 的 M1 部分：委托经 N 次交换或 T 分钟仍无进展时唤醒提问者一次并出条目（规则 11；停滞计数与 `stalled-delegation` 升级在 M3）[arch]。
- 工作流钳制（R06 的验收项）：私有 DSH home 里 `tool-workflow` 关闭；启用时 `maxConcurrentAgents ≤ maxActiveSubagents−1`、`maxTotalAgents ≤ 64`、`enableRunInBackground:false`，CI 检查；自有 Claude 乐章在 R33 之前关闭工作流（`disableWorkflows`）；被静默拒绝的审批要浮现为条目 [wf]。
- Tier 0 只 look 的 Claude 侦察乐手（`kind: scout`；+3–4 d）：隔离 profile 下钉死的 playwright-mcp，只允许公共 origin，出口白名单（M1 先用 playwright-mcp 自带的 origin 列表 `PWM:410-412`，M2 换成代理层的出口过滤器 E4；推断），`canUseTool` 拒绝一切非读工具；自有 Claude 启动传 `--no-chrome`，每次乐章启动断言 `system/init.tools` 没有原生 CU 前缀（E1）[cu]。
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
- A1：以原始 sessionId、分身或模板乐手为目标的发送被拒绝并带对应拒绝码；经两次轮换加一次守护进程重启后的回复仍到达该乐手 [arch]。
- A2：发给已释放乐手的消息会重新拉起它的乐章并只投递一次，即使守护进程在中途死掉 [arch]。
- A3：「Thanks」在一次回复后结束，发送方收到 `replied(suppressed)` 回执而不被唤醒（M3 起 `orchestra_wait` 也照常返回 `replied`）；一条 `notice` 启动 0 个回合 [arch]。
- A4：agent 代码无法构造 `trust: human` 或 `runtime`；agent 发起的中断被拒绝 [arch]。
- A16：200 KB 的回复到达时是摘要 + ref，并标 `truncated` [arch]。
- A17：`orchestra_request_musician` 只生成一条 InboxItem，不创建乐手 [arch]。
- A18：同一乐章内人设与注入块逐字节相同 [arch]。
- A9（M1 部分）：不收敛的委托触发一次回访并出一条条目；停滞升级留 M3 [arch]。
- 钳制（WF-17）：12 核机器上 `parallel(12)` 产生 0 次 `ACTIVATION_LIMIT_REACHED`；`run_in_background` 被拒绝 [wf]。
- CU-2：生成的配置里不出现 `--extension`、`--autoConnect`、`--no-sandbox`、`--caps storage|config|network`、默认 profile 或 Job UI 限制；自有 Claude 启动带 `--no-chrome` [cu]。
- CU-5（只 look 部分）：navigate 不生成条目；输入类工具被 `canUseTool` 拒绝；工具表里没有 `browser_evaluate`。「向密码框输入生成 `handoff`」子句随 M2 的 `handoff` 条目验收（§13.4）[cu]。

**M1 削减顺序**：QA 乐手模板（改为手工新建）→ Tier 0 只 look 的侦察乐手（改为 M2；本文建议）→ 已定决策注入 v0（保留 ADR 导出）→ 新建向导简化为配置文件 → DSH 驱动（退回 Claude↔Claude）。不能削减的：A2A、审批队列、乐手页的对话标签、重启三阶段处理、配置隔离。

### 13.4 M2 "Safe Stage"（第 10–17 周；含 Tier 2 到第 18 周）

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
- 模式 A5 权威链卫生（拒绝记在 `rootId`、不可转发、同根内同类动作标「上游已拒绝」）、A6 入站策略（accept / refuse；hold 在 M3）、A7 按当前策略重新接纳、A12 死循环细则、A14 预算事件（80% 软 / 100% 自动暂停，每（策略、阈值、窗口）只开一个事件）、A15 观察者协议 [arch]。
- 原生工作流观察（§8.7 M2）：解析 DSH `tool-workflow/*` 事件与 Claude 运行记录为分身组和 Stage 卡片（阶段、成员、token、null 数）；常驻的 DSH 工作流子代理仍是 `inactive` 分身，回收器追踪它们占的激活槽；扇出按事件计数；25 个 agent 或 1.5M token 出 P2 `workflow-run` 条目；核实过的记录路径进读取白名单 [wf]。
- 乐器完整版（+3 周）：Grant 实体与登录流程、出口过滤器（E4）、两阶段 `act`（E3）、代理层响应路径脱敏（E8）、每租约 Job、`orchestra-browser` 代理完整版（A22、A23、A25–A28）、`handoff` 条目、图片只传引用 [cu]。
- A38 独占的排队持有：第二个要同一 profile 的乐手排队而不是失败；关闭失败时仍持有 [dcu]。
- M2 末 S-CU spike（+2–3 d；已定，Q-C1 = B），只跑驾驭器、不接乐手，测 `look`（延迟与结果，推断）与写投递率。go 判据：`kill-tree` 能回收驾驭器并恢复窗口状态；`--direct` 始终直连、不碰 `serve`；manifest 可解析，放行一个白名单内的 Win32 窗口、拒绝另一个（cua#3330）；Calculator 放行时 Settings 被拒（AFH 框架按宿主 AUMID 与框架 window_id 识别）；Authenticode 为 Valid、签名者 `Cua AI, Inc.`；并测得 Q-DC2 首批应用的投递情况、Raw Input 对 pen 的视角、DSH 的一次图片往返 [dcu]。

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
- A5：对 Aiko 拒绝动作 X 后，Aiko 请 Ren 做 X，Ren 的审批卡片显示上游已拒绝；去掉 `ORCHESTRA_PART` 环境变量不会多得任何权限 [arch]。
- A7：策略被撤销后重新接纳被拒绝；策略不变时只恢复一次（§8.3 阶段 b）[arch]。
- A12：PID 不同的重复错误仍触发熔断 [arch]。
- A14：同一窗口内同一阈值被越过 3 次只开 1 个预算事件 [arch]。
- A15：回放里的轮询 token 占比低于阈值 [arch]。
- WF-16：原生工作流 trace fixture 生成数量一致的分身组；重启后绝不重新拉起原生运行 [wf]。
- CU-1：两个乐手拿到两个 profile 目录；被占用的 profile 排队 [cu]。
- CU-3：出口过滤器拒绝 `orchestra.localhost`、`user@orchestra.localhost`、跳转进它的重定向、loopback、LAN 与未列出的 origin [cu]。
- CU-4：一次 snapshot 即污染乐章；污染经过压缩、闲置释放与模型写的轮换笔记后仍在 [cu]。
- CU-5（M2 部分）：向密码框输入生成 `handoff` 条目，只有你能结束 [cu]。
- CU-6：snapshot → click 返回 `approval-pending`；未批准不执行，批准后只执行一次；digest 变了即作废 [cu]。
- CU-7：4K PNG 变成 ≤1,600 px 的引用；Exchange、journal 与回放里没有 `data:image` [cu]。
- CU-8：`sk-ant-…` 字符串在模型看到之前被脱敏；截图到 TTL 即清除 [cu]。
- CU-9：第 9 步暂停回合；五次相同的 URL + snapshot 哈希出 P0；一个乐章小时内第 21 张图被拒 [cu]。
- CU-10：agent 只能生成 `lease-request`；经 MCP 授予被拒绝；到期 → `draining`、`lease-expired`，输入停止 [cu]。
- CU-11：刹车杀掉租约 Job，UI 浏览器存活 [cu]。
- CU-12：丢失的写响应记为 `unknown-outcome`，0 次重放 [cu]。
- CU-13：退出码 21 且持有者是我们的 → kill 或排队一次；外来持有者 → `foreign-held`；3 次失败 → P0 [cu]。

**M2 削减顺序**：私有 DSH 控制台 → 健康报告 → 周期提醒 → Codex rollout 实时 tail（保持 `state_5` 轮询）→ A15 观察者协议的附加项（合并通知与重同步帧之外的部分）[arch]。r3：S-CU 可以移到 M3 初（本文建议；[dcu] 把它放在 M2 末，M3 的 Tier 2 look 以其 go 为前提）。不能削减的（本文建议）：出口过滤器与两阶段 `act`（否则没有 `act`，乐器只剩 look）。

### 13.5 M3 "Sections & Score"（第 18–23 周；含 Tier 2 第 19–25 周）

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
- 模式 A6 的 hold（仅 agent 的 hold 5 min 过期，等人放行的跟审批超时 Q4 与专注模式暂停）、A8 每个 Work 一个执行者（`executionPartId`）、A9 停滞计数与升级（回访在 M1）、A10 房间卫生（只认开头的 @、人设 admin、K 次 PASS 后安静闩锁、去抖）、A13 轮换熔断其余部分、A19 例程 = Reminder v2 [arch]。
- R33 工作流治理（§8.7 M3）：每次运行的截止与预算；越界即 cancel → close → resume，保留乐手上下文；守护进程重启后绝不重新拉起，出「中断，n/m 已完成」条目供会话内恢复；Grok Build 的暂停类型映射到收件箱类型；原生运行的只读 运行 → 阶段 → 成员 树（R16 的这一部分提前到 M3；AND-join / 循环视图仍在 M5）[wf]。
- DSH 侦察乐手的 `act`（两阶段审批；预设 = `read-only` 沙箱 + `approval: ask`、无 shell）[cu]。
- S-CU 通过后（Tier 2 已定，Q-C1 = B）：Tier 2 `look`（+1.5–2 周；需 S2 go 与 Q-C8，或改用 Claude host）、`orchestra-desktop` 代理（约 10 个工具、命名管道接纳（DSH 宿主；Claude 宿主为进程内挂载，§10.16）、只在 `active` 期间拉起 `cua-driver mcp --direct`）、A31 只观察不重放、A33 锁屏或离席即杀驾驭器、A34 只走后台、A35 AUMID 或路径 + 签名者身份、A36 只有会话级授权、A37 撤销即中止并换新进程、A39 结果字段折进文本 [dcu]；A29 的后台撤销部分（锁屏 / 离席 / 热键撤销；本文拆分，[cu] 原表整体为 M4）。

**验收**
- 一个永远打回的 reviewer 在 N=3 时升级给你。
- 可观测性得分：全部边类型 100%（转发、exchange、spawn edge、subagent 派生）。
- 回放是确定性的。
- 目标 settle 后 ≤2 s 内 `wait` 返回；`wait_subagent` 对每个 id 返回正确状态。
- 父回合被中断后，自有 DSH 乐手的孙代理被级联回收。
- 以 relay 来源投递后，目标的 `repeat-tool-reminder` 计数不被清零。
- 乐章切换后身份不变。
- 模拟的轮询行为被标记出来。
- A6：过期的 hold 出 P2 条目；agent 修改入站策略被拒绝 [arch]。
- A8：steer 一个正在房间里忙的乐手，消息落到该房间的乐章 [arch]。
- A9：不收敛的委托先触发一次回访，再升级 P1 [arch]。
- A10：引用「@Ren 说……」不路由到任何人；房间到轮数上限即停 [arch]。
- A13：缺 key 的 fixture → ≤3 次尝试、P1、无 OOM [arch]。
- A19：到期的 watch 不再触发 [arch]。
- CU-14：观察到 `mcp__computer-use__*`、`mcp__remote-devices__*`，或桌面 host 之外的 `mcp__cua-driver-mcp__*`、`cua_driver_native__*`、`cua`，出横幅与伪租约；自有租约期间出现原生 CU 即挂起该租约 [cu]。
- CU-16（Tier 2）：租约期间 UI 浏览器来到前台并提交 approve → 409，租约撤销 [cu]。
- CU-17（Tier 2）：拖拽中被杀会补发 button-up（前台驾驭器）；Invoke 中被杀后目标仍 enabled、可激活（cua-driver）；锁屏 → `suspended`；重启 → `lost` + P1；并行的 Task 子代理被串行化；DSH 子代理拿不到桌面工具；cua-driver 租约期间物理输入不撤销、热键与离席会撤销 [cu]。
- CU-18（Q-DC0 选 DSH 时）：侦察乐手配置精确钉 0.2.1-rc.2、关闭委派行、无原生 provider 或 `allowedApps`、模型声明图片输入 [dcu]。
- CU-19：没有 `active` 租约时每个桌面工具返回 `no-lease`，没有驾驭器进程 [dcu]。
- CU-21：只在 `structuredContent` 里的 `effect: unverifiable` 与拒绝 `code` 到达模型文本（`isError` 时也是）；Exchange 记 `unknown-outcome` [dcu]。
- CU-23：调用中途伪造锁屏 → 0 个驾驭器、0 次后续调用、0 次重放 [dcu]。
- CU-24：Invoke 中途 `kill-tree` → 0 个驾驭器、目标仍 enabled、host 存活、在途写记 `unknown-outcome`；杀代理或 host → 0 个驾驭器、`lost` [dcu]。
- CU-25：两个桌面侦察乐手各自独立 host，一个 `active` 一个 `queued`；只有一次 `session/new`、没有 `session/resume`；没有 `subagent`、`subagent_fork`、`workflow` 工具；host 之外或 nonce 错误的 `orchestra-desktop` 得到 `no-lease` [dcu]。
- CU-26：复制的 exe、复用的 pid、Windows Terminal（按 AUMID）、Calculator 放行时的 Settings 都被拒；manifest 在 0.37.0 下可解析且没有 `display` [dcu]。
- CU-27：驾驭器的 argv、env 与 manifest 与配方逐项一致 [dcu]。
- CU-28：存在 `serve` 任务或管道即阻止授予并出 P1；管道上有假守护进程时驾驭器仍直连，守护进程收到 0 次调用 [dcu]。

**M3 削减顺序**（r3 新增）：A19 例程 → 上限之外的 A10 房间默认值 [arch] → Tier 2 `look` 顺延到下一里程碑（本文建议；M4 的桌面 `act` 随之顺延）。

### 13.6 M4 "Maestro"（第 24–27 周；含 Tier 2 第 26–30 周）

**交付物**
- Maestro、baton bar 和 AutoRoute：先 shadow，后 active（标签自 M1 起积累）。
- 待审上限。
- Codex 驱动（如果过了门槛；Q1 也可能让它提前到 M2 末）。
- 联邦：inject pipe、经核对的 `/api/bot` 声部、`herdr agent prompt`。
- A11 只从候选里选：第 9 步的 LLM 只能从第 5 步幸存者里挑；每乐手 handoff ACL；标签不足 N 时用静态后备 [arch]。
- A24 查询阶梯（API → fetch → 无障碍文本 → 截图 → 桌面）；A29 撤销开关的前台部分（本文拆分，[cu] 原表整体为 M4；前台驾驭器凭物理输入 + nonce；后台 cua-driver 的锁屏 / 离席 / 热键撤销随 M3 的 Tier 2 look，R55、CU-16、CU-17）；A32 目标元素变了审批即失效（桌面绑定；浏览器版随 M2 的两阶段审批）[cu][dcu]。
- S-CU 显示足够多的写能投递时（Tier 2 已定，Q-C1 = B）：桌面 `act`（+1 周），按 Q-DC7 选定的审批路线（在 `look` 租约里起草计划、租约之间批准；或修 E5 让配对 UI 在租约中答步骤卡）；每步绑定 app 身份、HWND、工具、全部参数、`role`、`label`、父标签、`frame` ±4 px 与文本摘要，只在恰好一行新鲜匹配时按计划顺序执行一次 [dcu]。

**验收**
- 每次路由都显示理由、置信度和 `decisionId`。
- 改派只需 1 个动作。
- 进入 active 之前满足 Q11 的门槛（默认：最近 50 条派活 shadow 一致率 ≥80%，blocked→noticed 中位 <2 min）。
- Codex 受控实跑通过；否则 Codex 保持只读。
- A11：LLM 选出候选之外的乐手被拒绝 [arch]。
- CU-15（Codex 驱动过门槛时）：自有 Codex 的 elicitation 永不选「always」[cu]。
- CU-20：代理拒绝的一切（前台投递、x/y、非单击左键或 WPF / Tk / GTK 窗口上的点击、含 `urls` 的 `launch_app`、其余列出的工具）在派发前被拒；`windows_targeted_injection` 结果 → `suspended`、P1 [dcu]。
- CU-22：批准元素 E 后，标签或 frame 变了 → `stale-approval`；同标签的兄弟元素移进 E 的 frame → `ambiguous-target`、0 次执行；参数变了或步骤乱序 → 拒绝；无关重绘无影响 [dcu]。
- CU-29：桌面计划只能从配对 UI 批准，绝不在租约 `active` 时；计划外的步骤重复 10 次 → 0 次执行、1 条 P2 `flood` [dcu]。
- CU-30：写操作超过代理截止时间后重试：1 次执行、1 条 `unknown-outcome` [dcu]。

### 13.7 M5 "Provenance & ecosystem"（第 28–32 周；含 Tier 2 第 31–35.5 周）

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
- A20 记忆范围按读 / 写分开标志，加共享组 [arch]。

**验收**
- 陈旧注释探针中，agent 遵循 ADR（有无注入对比）。
- 记忆往返迁移，静默覆盖为 0。
- 越权读取被拒绝并记录。
- 对一个已知 flaky 的测试 rerun ×20，报告失败率，每次失败都附上 seed、环境和 trace / 录屏路径（R19）。
- A20：只读范围拒绝写入 [arch]。

### 13.8 M6 "Arrangement"（编排；M4 后 go/no-go；约 4–6 周，推断）

M6 排在 M5 之后，不计入 M0–M5 的总工期 [wf]。它交付 D13 的第二层：Orchestra 自己的跨 harness 工作流（§8.8），作为邮局的客户端，以 `trust: runtime` 发出每次调用，所以每次调用都有回执、`requestId` 幂等、上限、taint 与 governor，崩溃后回放而不重复投递。

**go / no-go 判据**（M4 结束时；判据为本文建议，[wf] 只给出「M4 后 go/no-go」）
- M1–M4 已交付，钳制（M1）、观察（M2）、治理（M3）都已在用。
- R33 至少观察并治理过 1 次真实的原生工作流运行。
- Q-W1（谁能编写和启动 Arrangement、默认预算）已回答。

**交付物（v0）**
- WASM 沙箱里的 JS 解释器（例如 QuickJS-in-WASM）跑在 orchestrad 子进程里：没有 fs、net、timer、`Date`、`Math.random` 绑定，只有 Arrangement host 调用过消息通道；可选无网络的 AppContainer / LPAC 令牌；沙箱逃逸用例进 CI。
- 只读模板：QA 复跑 ×N（复用 M1 QA 模板的预设与人设）、对抗核验、评审裁决；模板乐手 `kind: template`，每个模板一个系统乐手，永不可寻址；模板 worker 只拿到 `orchestra_report`。
- API v0：`agent`、`parallel([specs])`、`phase`、`log`、`args`、`budget`；同步 `parallel`（AND 屏障）；`agent()` 返回值或 `null`，`outcome(h)` 给原因。
- journal 与回放 v0（Grok Build 式：按规格顺序分配 seq、每次 host 调用含 `budget()` 与 `args` 都入 journal、逐 seq 检查分歧）；`key = v1:sha256(canonical{target, templateDigest, harnessVersion, prompt, opts})`，`requestId = arr:<lineageId>:<path>#<occurrence>`；`CallOutcome`（`ok | timedOut | denied | schemaInvalid | unknown | cancelled | budgetPaused | late`），`unknown` 为该次的终态；非终态运行的结果正文钉住、不受 14 天 TTL 与清除影响，被清除则运行 `unresumable` 并出条目。
- 每次调用经 governor 接纳（排队不失败）；Ledger 先预留估算、再按实际结算；预算事件 80% P2 / 100% 暂停 P1，只有你能提高上限；`meta.stop` 组合条件（`calls(n) | cny(x) | wall(min) | external | stall(3)`）；循环要字面 K 或 `loopUntilDry({dry:2, max:K})`（lint）；>25 次预估调用先报价（R41）。
- 零 token 试跑：Start 之前对假 harness 显示调用图、预算与目标；agent 编写的脚本需键入确认，并污染每次调用（`authoredBy`）。
- 审批：你的一次点击授权整个运行，不授权每个 worker 动作；Claude worker 走原生 SDK 权限规则（同 M1 QA 模板）；DSH 模板 worker 只有沙箱模式的能力，`request_permission` 一律自动拒绝并汇总为每次运行一条 InboxItem；不做批量审批。
- §11.4 Score 的 Circuit 标签页：从 AST 与 `meta.phases` 生成骨架（阶段列、AND/OR 门、`×n` 总线、「↻ ≤K」循环）加实时覆盖层（Exchange 颜色、计数、null、预算表）。

**之后（v1，不在 M6 内）**：具名乐手 `to:`（`role: request`、`delivery: queue`、并发 1；DSH 目标需要 relay-source bundle，否则 `relay-source-missing`）、`pipeline` / `race` / `quorum(k)`、`ask()`（只创建 Decision 并持久挂起，超时默认取消）、用户脚本、Maestro 提案（影子）、Temporal 式完成序回放与调用点路径。

**验收**（零 token；全文见附录 F）
- WF-1：5 次调用里 3 次已回复时杀掉守护进程，重跑对这 3 次 0 次新投递，在途调用绝不重发。
- WF-2：循环里同一调用两次拿到两个不同的 `requestId`。
- WF-3：脚本碰 `Date.now`、`require('fs')`、`fetch` 或 `process` 即失败关闭（`ARRANGEMENT_NONDETERMINISTIC` 或沙箱错误）。
- WF-4：回放在某个 seq / path 发出不同的调用即停在 `ARRANGEMENT_DIVERGENCE`，0 次投递。
- WF-5（v1）：乱序的 `pipeline` 完成与基于 `budget.remaining()` 的分支在被杀后回放一致。
- WF-6：`parallel` 里一个超时的调用得到 `[a, null, c]`，outcome `timedOut`；卡在接纳里的调用从接纳请求时刻起计超时。
- WF-7（v1）：一个被拒、一个成功的 `race` 返回成功者；全失败得 `allFailed`。
- WF-8：`cny(1)` 暂停并出 P1 条目，不再投递；同一阈值越过 3 次只有 1 个事件。
- WF-9：30 个并行调用在 `perHarness=4` 下在途 ≤4，0 次失败。
- WF-10：永远打回的 reviewer 3 轮后升级；3 轮无进展触发 `stall(3)`。
- WF-11：同一 schema 在 fake Claude、mock DSH、fake Codex 上都通过校验；畸形 JSON 得到一次修复回合。
- WF-12：污染的输入或 agent 编写的脚本产生污染的 Exchange。
- WF-13：任何 worker 提示里都没有把触发消息当指令；每个信封都是 `trust: runtime`（CC#96640 fixture）。
- WF-14：DSH 模板 worker 的 `request_permission` 被自动拒绝，脚本看到 `denied`，每次运行恰好 1 条 InboxItem。
- WF-15（`ask()` 部分为 v1）：`ask()` 跨重启存活；经 MCP 解决被拒绝；被清除的钉住结果让运行 `unresumable`。
- WF-18（v1）：Arrangement 投递到 DSH 不产生 `goal/change`；没有 relay-source bundle 的 DSH `to:` 目标被拒绝。
- 标 v1 的用例随 Arrangement v1 交付，不是 M6 的 go 判据。

**M6 削减顺序**（本文建议）：v1 全部 → Circuit 标签页 → 对抗核验模板。不能削减的（推断）：沙箱、回放 v0 的分歧检查、governor 接纳、自动拒绝并汇总。

---

## 14. 评估方案

| # | 评估 | 方法 | 指标 / 门槛 | 何时 |
|---|---|---|---|---|
| 1 | **零 token 彩排（CI）** | `claude-fake-sdk`、`codex-fake-app-server`、mock ACP agent、DS-Bot `dev/mock-llm.mjs` | 场景：派活准确率；join 正确性（`wait` 前后的轮询调用次数）；打回上限；循环终止；孤儿清理；3×8 的突发 [req]；r3 加：轮询 token 占比（R04 验收项，参照 CX#35259 的 19.8%）、预算事件去重（R06 验收项）[arch] | M1 起每次提交 |
| 2 | **黄金 fixture + 可观测性得分** | 用录制（脱敏）的会话日志喂投影 | 某项控制上线前，它直接依赖的事件类型覆盖率 100%（M1、M2 验收）；全部边类型 100%（M3）；每晚对已安装工具跑 canary | M0 起 |
| 3 | **人类注意力指标** | 从 M0 起持续采集 | blocked→noticed 的中位时间 < 2 min；每小时干预次数；项目切换次数；漏掉的提醒 = 0；每周一次过载自评（1–5） | M0 起。**用来卡 M4 的 active 路由（Q11），不卡 M1** |
| 4 | **Micro-DeepSWE** | 10–20 个分层抽样任务，每个约 1 CNY，×3 个种子 | 比较单 agent、原生 DSH 团队、带 Orchestra 守护的团队：通过率、每解决一个任务的 CNY、墙钟时间、人工介入次数，报告方差 [req] | M2 后 |
| 5 | **模型组合压力测试** | MiniMax vs DeepSeek，上限设为 4、8、16 | 失败 / 崩溃率、排队延迟、成本，据此得出每个模型的安全速度，写入 governor 的 `perModel` 默认值和私有 home 的 `maxActiveSubagents` | M2 |
| 6 | **上下文污染探针 + 记忆往返** | 埋一条与 ADR 矛盾的陈旧注释；导出→导入→比对 instruct / self / project 三层 | 遵循 ADR 的比例（有无溯源注入对比）；静默覆盖 = 0 | M5 |
| 7 | **AutoRoute** | 标注集（自 M1 起积累）+ shadow 一致率 | 标注集准确率；Q11 的门槛 | M4 |
| 8 | **安全回归**（评审补充） | 零 token CI 里的固定用例 | curl / 跨源 fetch 调人类动词 → 403；XSS 与 OSC 注入 fixture 不执行；读取白名单拒绝凭据文件；自我放权后仍进审批；`approval: never` 不出现在合成配置里；relay 投递不开启目标 | M0 起 |
| 9 | **工作流与 Arrangement 零 token 用例** | WF-1…WF-18（附录 F）：fake harness 上的原生 trace fixture、Arrangement 运行时对假 harness、CC#96640 权威中继 fixture | M1 钳制（WF-17）与 M2 观察（WF-16）必须通过；M6 全部通过；分歧检查与沙箱逃逸用例 0 次投递 [wf] | M1 钳制起，M6 全部 |
| 10 | **乐器零 token 用例** | CU-1…CU-30（附录 F）：假 browser MCP 带录制 fixture、假 `cua-driver` MCP | 各里程碑对应用例全过（§13.3–13.6）；配置里 0 次出现禁用标志；两阶段审批只执行一次；`unknown-outcome` 0 次重放 [cu][dcu] | M1 起 |
| 11 | **S-CU 测量**（已定，Q-C1 = B） | 只跑驾驭器：`look`（延迟与结果，推断）、写投递率（按 Q-DC2 的首批应用）、Raw Input 对 pen 与 VK_NONAME 的视角、DSH 一次图片往返 | go 判据见 §13.4；写投递率不足则 M4 不做桌面 `act` [dcu] | M2 末 |

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
| 单人工作量（r2 约 25 周；r3 约 30–32 周，含 Tier 2 约 33–35.5 周，M6 另加 4–6 周，均为推断） | M0 重新定界为 15–18 个工作日；每个里程碑都有削减顺序；M3、M5 可以顺延，不卡 A2A；[arch] 的模式约加 3–4 周，先削 A19、A15 附加项、上限之外的 A10 默认值；M6 在 go/no-go 之后，可以整体不做；Tier 2 已定为必要（Q-C1 = B），S-CU 不通过时改走后备或顺延 [arch][cu][wf] |
| opt-in 的 hooks / MCP 片段破坏零写保证 | 由你自己从显示的片段粘贴；之后重建审计基线；`PermissionRequest` hook 先通过 fail-through 测试 |
| Arrangement 向 Dify 式编辑器蔓延 | 先做只读模板，不做编辑器与 DSL（OpenClaw 也拒绝了它们）；M4 后 go/no-go [wf] |
| 回放 bug（异步顺序、被清除的正文） | v0 只有同步 `parallel`；结果正文钉住；失败关闭（`ARRANGEMENT_DIVERGENCE`、`unresumable`）[wf] |
| 具名乐手有状态，回放语义不干净 | 只在 v1；DSH 目标必须有 relay-source bundle [wf] |
| 扇出成本（DeepSeek 峰值 2 倍价，§2.3） | R41 预估、硬预算、预算事件 [wf] |
| worker 的 schema 遵从度弱 | 一次修复回合、完整性 critic、null 计数 [wf] |
| harness 漂移（DSH 约 2 天一版；Claude 工作流记录无文档） | 解析器降级为 `unknown`；扇出按事件计数、不按上限 [wf] |
| DSH 模板 worker 被过度拒绝 | 每次运行一条汇总条目；更宽的沙箱模式（Q-W2）[wf] |
| 许可证：dsh-apollo GPL-3.0、GBR 无许可证、grok-build Apache-2.0 | dsh-apollo 与 GBR 只借鉴设计；grok-build 的 journal 设计复用无需 NOTICE，复制代码保留 LICENSE 与归属 [wf][arch] |
| 提示注入在模型之外解不掉：Claude for Chrome 带 Anthropic 防护仍有 1.4%（Opus 4.5）到 2.4%（Haiku 4.5；后者为评审核对、未重取）的攻击成功率（Anthropic，2025-11-24），DeepSeek 与 Codex 没有可比数字 | 侦察乐手、粘性 taint、出口过滤、两阶段 `act` [cu]；图片只传引用（本文补充） |
| agent 在你的浏览器里点「批准」（D8） | E5：UI profile 无扩展无 CDP；Tier 2 期间除 `revoke-lease` 外冻结人类动词；UI 浏览器来到前台即撤销租约 [cu] |
| 浏览器进程泄漏（CX#17832 macOS 13.6 GB、OC#79960 Linux） | 每租约 Job；回收器处理退出码 21 的持有者（R49）[cu] |
| Windows 上未核实：Chrome 的 Job 成员关系与渲染器沙箱、Raw Input 的 `hDevice`、最小化时的 CDP 输入、DPI 缩放的裁剪（OC#158011）、Electron 截图崩溃 | S4 与 S-CU 逐项核实；核实前 Tier 1 不做、pen 路径全部拒绝 [cu] |
| Codex 浏览器插件把每个检查过的 URL（含 path 与 query）和对话、回合 id 发到 OpenAI `/aura/site_status`（已核实） | 被观察的 Codex 会话不算「只在本机」（§3.1）；自有乐手永不装该插件（D18）[cu] |
| 恢复你的前台时可能抬起 UI 浏览器而触发 E5（推断） | 对策待定；与 Q-DC1（只 look 租约是否不冻结 UI）、Q-DC7（是否修 E5）一起决定 [dcu] |
| Raw Input 对 pen 与 VK_NONAME 的视角未知 | v1 拒绝全部 pen 路径（`impl_.rs:3961-3973,4069-4084`）；S-CU 测量 [dcu] |
| cua-driver 变动快（cua#5910 元素 token 限定进程、cua#3330 身份匹配） | 精确钉版，每次升级跑 Windows 冒烟矩阵（R56）；只用 `--direct` [dcu] |
| 放行的窗口会暴露其中全部内容 | 白名单精确到（pid, window_id）；`look` 默认 UIA 文本、图片 opt-in；代理脱敏（推断的组合）[dcu] |
| 工期数字全部为推断 | 两种标尺（含 / 不含 Tier 2）；Tier 2 已定（Q-C1 = B），交付以 S-CU 通过为前提；M6 在 go/no-go 之后 [cu][dcu][wf] |

---

## 16. 需求追溯 R01–R60

优先级来自 [req]（R01–R28）与四份调研（R29–R60）：R01–R11 为 P0；R12–R24 为 P1（R21 对任何 A2A 接收方升为 P0 [arch]）；R25–R28 为 P2。R29–R41 来自 [arch]（R33、R34、R41 与 [wf] 共有），R42–R51 来自 [cu]，R52–R60 来自 [dcu]；标「Tier 2」的已随 Q-C1 = B（2026-10-27）列入计划，交付以 S-CU 通过为前提；标「S-CU 为前提」的里程碑随 S-CU 与 Q-DC 系列决定。里程碑栏已按 §13 的 r3 安排更新。

| ID | 需求（简称） | 优先级 | 里程碑 | 说明 |
|---|---|---|---|---|
| R01 | 跨 harness 的统一花名册 | P0 | M0 / M2 | 花名册在 M0（Codex 只有 `state_5`）；状态行在 M2 |
| R02 | 先观测：A2A 时间线与回放 | P0 | M0–M3 | 边从 M0 起作为 Event 记录；与控制相关的边覆盖率 100% 随 M1、M2 验收；全部边类型 100% 与时间线回放在 M3 |
| R03 | 任意深度的完整 subagent 树 | P0 | M2 | 树并核对数量；自有 DSH 从日志读，M3 起由 bundle 增强 |
| R04 | 事件驱动的 join/wait；轮询检测 | P0 | M3 | `orchestra_wait`（Exchange 级）+ 私有 home 的 `wait_subagent`（原生分身级）+ 轮询检测；r3 新增验收：回放里的轮询 token 占比低于阈值（A15；社区样本 19.8%，CX#35259）[arch] |
| R05 | 生命周期回收器 | P0 | M0 / M2 / M3 | 刹车在 M0；回收与孤儿在 M2（DSH：cancel → close → resume）；自有 DSH 孙代理的级联回收在 M3；r3：浏览器进程也在回收范围（CX#17832，泄漏的 Playwright 进程占 13.6 GB）[cu] |
| R06 | 速度 governor（排队不失败） | P0 | M1 / M2 | 对自有会话强制；DSH 原生子代理先用 `maxActiveSubagents` 硬上限；对只读会话计量；r3 新增验收：M1 工作流钳制（0 次 `ACTIVATION_LIMIT_REACHED`、`run_in_background` 被拒）与 M2 预算事件去重（A14）[arch][wf]；乐器租约让 agent 不再抢同一个标签页（CC#15193、DSH-D#10229）[cu] |
| R07 | 死循环检测 | P0 | M0 / M2 | 告警在 M0（Claude、DSH；Codex 在 M2）；对自有会话自动暂停在 M2；r3：乐器另有 E11 的 8 步上限（OC#138999，209 次循环调用）[cu] |
| R08 | 循环终止策略 | P0 | M3 | 检测与强制都在 M3；M2 只有 runaway |
| R09 | 派活审计与任务板 | P0 | M3 | CAS 任务板、陈旧标记、重新分派 |
| R10 | 注意力收件箱 | P0 | M0 / M2 | 收件箱、一次性提醒、浏览器通知在 M0；专注模式、摘要、周期提醒、herdr 在 M2；r3：两阶段审批立即返回 `approval-pending`，审批不会沉默消失（CX#37180、CC#103373）[cu] |
| R11 | 跨 harness A2A 总线 | P0 | M1 | Claude↔DSH，带回执（S2 no-go 时先 Claude↔Claude）；r3 新增验收：`accepted` 回执先于 `delivered`，发给已释放乐章的消息重新拉起并只投递一次（A2）[arch] |
| R12 | 上下文溯源（ADR 绑定 git） | P1 | M1 / M5 | ADR 导出与已定决策注入 v0 在 M1；陈旧注释探针与冲突标记在 M5 |
| R13 | transcript ACL | P1 | M5 | `read_part` ACL，每次读取都记录；同一 DSH host 内互相可见，需要隔离时单开 host |
| R14 | 分层、可迁移的记忆 | P1 | M5 | 部分覆盖：范围与 journal |
| R15 | 成员工作日志 | P1 | M1 / M3 | `orchestra_report` 在 M1；与事件关联在 M3（Score） |
| R16 | Score / 图视图 | P1 | M3 / M5 / M6 | 只读的 AND / 循环总谱（M5）；r3：原生工作流运行的只读 运行 → 阶段 → 成员 树从 M5 提前到 M3；Arrangement 的 Circuit 标签页随 M6 [wf][arch] |
| R17 | 常驻指挥家与 AutoRoute | P1 | M4 | Maestro + AutoRoute；派活标签从 M1 起积累 |
| R18 | agent 与预设登记 | P1 | M1 / — | 乐手登记表兼作目录（M1）；预设与 Skill Cluster 推迟，未排期 |
| R19 | UI bug 的 repro bundle | P1 | M1 / M5 | QA 乐手模板（rerun ×N 报告失败率）在 M1；repro bundle v0 及其验收在 M5 |
| R20 | 每项目的决策板 | P1 | M1 | Decision board |
| R21 | 越界防护 | P0（r2 为 P1、无人值守为 P0；r3 对任何 A2A 接收方升为 P0 [arch]） | M0–M2 | Claude transcript 的 bypass 检测在 M0；无 bypass、禁用 `approval: never`、自有乐章配置隔离在 M1；DSH / DS-Bot 的 policy 告警在 M2；容器层推迟 |
| R22 | 工作区隔离 | P1 | M2 / M3 | 双写者告警在 M2；worktree 在 M3 |
| R23 | 群聊模式 | P1 | M3 | Rooms；r3：排在 R29（回访）、R31（可编辑排队）之后落地；只认开头 @ 的房间规则与上限见 A10 [arch] |
| R24 | 复用生态 | P1 | M0–M5 | DSH 原生深链在 M0；DS-Bot 文件在 M2；私有 DSH 控制台在 M2（可选）；BSB tab 在私有控制台 M3（可选）；`/api/bot` 在 M4；dsh-context 要先安装（Q5a） |
| R25 | 会话级团队开关 | P2 | M3 | 私有 home 的 host 键改为（项目，预设，teamMode）；只有 teamMode=on 的 host 挂载 `dsh-experimental-agent-team-profile`（它会关闭旧版 subagent 工具，`maxMembers` 为 8）；按会话开关的需求记入上游台账 |
| R26 | 导出包含 A2A 消息 | P2 | M5 | 运行导出包含 A2A 及每次回复的理由 |
| R27 | Tokenmaxxing 模式与成本预估 | P2 | M5 | 派活前的成本报价（第 8b 步）；"整库上下文"模式不做，原因见 §2.3；r3 不变，Arrangement 运行前的扇出估算另立 R41 [arch] |
| R28 | 富媒体预览 | P2 | — | 推迟 |
| R29 | 停滞委托回访（A9） | P0 | M1 / M3 | N 次 Exchange 或 T 分钟后唤醒提问者一次并出一条回访 InboxItem（种类与级别待定；M1）；「无进展」= 没有新 diff、测试、ref 或 Decision；累计 3 次停滞升级为 P1 `stalled-delegation`（M3）；绝不自动重新规划；N / T 的默认值与回访记谁的预算待定（§17）[arch] |
| R30 | 花名册里的活性年龄 | P1 | M2（推断，随状态行） | 显示每个乐手最近一次工具调用的年龄；标出「承诺了工作却没有工具调用」（DSH-D#6216、DSB#469）[arch] |
| R31 | 可编辑排队中的 Exchange；steer 到达执行中的乐章 | P1 | M1 / M3 | 排队中的 Exchange 可编辑（M1）；每个 Work 一个执行者 `executionPartId`，steer 落到正在工作的乐章（A8，M3）[arch] |
| R32 | 轮换熔断（A13） | P0 | M1 / M3 | 每小时轮换上限，超限即退避并出 `rotation-breaker` 条目（M1）；区分确定性与瞬时失败、每次轮换前核实旧乐章已归档（M3）；依据 DSB#485（累积 1,971 层 `runSwitch` 栈帧后 OOM）；反例 MaiBot `heartFC_chat.py:497-501` [arch] |
| R33 | 工作流运行适配器 | P1 | M2 / M3 | M1 钳制是 R06 的验收项，不计入 R33；M2 观察（分身组、Stage 卡片、`workflow-run`）；M3 治理：接纳、截止、预算、cancel → close → resume、绝不自动重新拉起（CC#86777）[arch][wf] |
| R34 | 计算出的任务与 A2A 跳转的权威卫生 | P0 | M1 / M2 | `trust: runtime`（A4，M1）；转发或计算出的文本永不携带人类权威、拒绝不可转发、拒绝记在 `rootId`（A5，M2）；Arrangement 的触发文本永不作为指令插入（CC#96640、CC#100033）[arch][wf] |
| R35 | 受保护的 `~/.orchestra`、私有 `DSH_HOME` 与锁 | P0 | M1（推断，随受保护路径测试） | 自有乐手对这些路径的写入进审批（§10.11 #7）；DSB#513 [arch] |
| R36 | 薄完成（A16） | P1 | M1 | 规则 1：状态 + 有界摘要 + refs，截断标 `truncated`（OC#96975、CC#67684、DSH-D#10115）[arch] |
| R37 | 每乐章投递密钥读取时校验 | P1 | M1（推断，随 named pipe token） | 读取时核对乐章密钥，防止拿到别的会话的内容（CC#96546、OC#64199）[arch] |
| R38 | 沉默与唤醒控制（A3） | P0 | M1 | `wake: turn\|none`；`reply` / `notice` / `progress` 不开 Work、不自动回信；`replied(suppressed)`；无操作致谢在社区样本里约占 13%、最高 22%（CC#47930）[arch] |
| R39 | 每乐手入站策略（A6） | P1 | M2 / M3 | accept / refuse（M2）、hold（M3）；只有人能改；仅 agent 的 hold 5 min 过期；≤100 held、≤50 queued [arch] |
| R40 | 创建乐手或例程的类型化请求（A17） | P1 | M1 | `orchestra_request_musician` 只生成 InboxItem；agent 不自我复制 [arch] |
| R41 | 运行前扇出成本估算 | P1 | M6 | >25 次预估调用先报价（CC#91532：25 个 agent 代替 6–7 个，约 10 倍成本）；随 Arrangement 落地；R27 的第 8b 步不变 [arch][wf] |
| R42 | 乐器租约与完整状态表 | P0 | M1（Tier 0 只 look）/ M2（完整） | `Lease` 实体与 §10.14 的状态机；Tier 0 由运行时授予、Tier 2/3 只有你（D8）；每个租约一个新驾驭器进程（CC#15193、CC#39558、DSH-D#7857）[cu][dcu] |
| R43 | 乐器只给侦察乐手；污染乐章只经两阶段审批或 Q-DC7 路线行动 | P0 | M1 / M2 | `kind: scout`（只读预设、无 shell、独占 host）；粘性 taint（E6）；浏览器 `act` 经两阶段审批（M2），桌面 `act` 经 Q-DC7（M4，S-CU 写投递与 Q-DC7 为前提）（DSB#32、CX#24433）[cu][dcu] |
| R44 | Grant、隔离 profile、出口过滤；Tier 2 期间 UI 冻结 | P0 | M1 / M2 / M3 | 隔离 profile 与出口白名单（M1）；Grant 与出口过滤器（M2）；Tier 2 期间除 `revoke-lease` 外冻结人类动词（E5；M3，S-CU 通过为前提）（[cu] 安全子报告 B5 / B6）[cu] |
| R45 | 代理层的元素绑定审批 | P0（act） | M2 / M4 | 浏览器：代理用自己的新鲜 snapshot 建条目，`elementDigest` 变了即作废（M2）；桌面：按步绑定 app 身份、HWND、参数、`frame` ±4 px，TTL ≤ 租约授予时长（M4，S-CU 写投递为前提）（Codex `confirmations.md`；Operator card p.8）[cu][dcu] |
| R46 | 查询阶梯（A24） | P1 | M4 | API → fetch → 无障碍文本 → 截图 → 桌面（R46–R48 的依据在 [cu] 合并给出：CX#49458、CC#13480、OC#75879）[cu] |
| R47 | 图片只传引用（A28） | P1 | M2 | `shot:<id>`；≤1,600 px；Exchange 与 journal 里没有 `data:image`；agent 不转发图片（E7）[cu] |
| R48 | `handoff` 条目（A26） | P1 | M2 | 凭据、支付、CAPTCHA 交还给你；只有你能结束；重新登录经 `loginUrl` 而非 agent 的 URL [cu] |
| R49 | 回收器覆盖浏览器与 exit 21 持有者 | P1 | M2（推断，随回收器） | Chrome `lockfile` 删除即关闭，第二次启动退出码 21；按 pid + createTime 找持有者；外来 → `foreign-held`；3 次失败 P0（CX#17832、OC#79960）[cu] |
| R50 | 图片 token 与工具 schema 计量 | P1 | M2 / M3 | `imageTokens{estimated}` 由 Governor 预留；浏览器 MCP 约 4.8k schema token（DSH-D#7080）只挂到浏览的乐章；桌面目录（DSH-D#7080 报告过 55 个工具约 23.5k token；0.37.0 的实际数目由 S-CU 统计）计入（M3，S-CU 通过为前提）[cu][dcu] |
| R51 | 一次性桌面 | P2 | 计划外 | Windows Sandbox / Hyper-V，`provenance:[sandbox]`；需一次管理员启用（MaiBot `bridge.py`）[cu] |
| R52 | 驾驭器经 `mcp --direct` 在代理下的每租约 Job 里运行 | P0（Tier 2） | M3（S-CU 通过为前提） | sigstore + SHA256SUMS + Authenticode；不用 `serve` 守护进程、`install.ps1`；私有 `CUA_DRIVER_RS_HOME`、白名单环境 [dcu] |
| R53 | 代理是桌面的绑定闸门 | P0 | M3（S-CU 通过为前提） | DSH `tools/pre-execute` 默认放行，PreToolUse `ask` hook 只作可选的第二层 [dcu] |
| R54 | 结果字段到达模型和 journal | P0（act） | M3 / M4（S-CU 为前提） | 代理把 `effect`、`transport`、拒绝 `code` 折进文本（模型只见 `content`，DSH-D#7788）；`unverifiable` = unknown，不重放 [dcu] |
| R55 | 锁屏或离席杀驾驭器 | P0（Tier 2） | M3（S-CU 通过为前提） | procguard ≤500 ms 检查输入桌面、会话锁定、在场；cua-driver 自己对输入没有锁屏闸门 [dcu] |
| R56 | 精确钉版；每次升级跑 Windows 冒烟矩阵 | P1 | M3（S-CU 通过为前提） | DSH CU 包只按 0.2.1-rc.2 钉（`latest` 0.1.6-alpha.1 列入 `dsh.profile.bundles` 会让启动失败，D#6788）；cua-driver 钉 0.37.0（cua#5910）[dcu] |
| R57 | 遥测、更新、脚本关闭 | P1 | M3（S-CU 通过为前提） | `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`、`CUA_DRIVER_RS_UPDATE_CHECK=false`、`CUA_DRIVER_DISABLE_RUN_SCRIPT=1`、`DO_NOT_TRACK=1` [dcu] |
| R58 | 检测外来 `cua-driver` 与被观察的 DSH CU | P1 | M3 | Job 之外的 `cua-driver*.exe`、`\\.\pipe\cua-driver*`、`serve` 任务 → 阻止授予、P1；观察到的 DSH CU 工具前缀 → 横幅 + 伪租约（级别由 Q-DC5 定）[dcu][cu] |
| R59 | 每个桌面 host 一个乐手、一个 Session、无子代理 | P0（Tier 2） | M3（S-CU 通过为前提） | DSH 桌面工具 host 全局、子代理继承、没有调用者 id；`hostKey` = musicianId；关闭九个委派行；只 `session/new` 不 `session/resume`（E15）[dcu] |
| R60 | 任何 kill 之后修复窗口状态 | P1 | M3（S-CU 通过为前提） | cua-driver 只在 Rust `Drop` 里恢复窗口，中途被杀会让目标停留在 disabled；procguard 记录并恢复每个目标的 enabled 状态与样式（cua#3355、cua#1706）[dcu] |

---

## 17. 需要你拍板的问题

### 17.1 r2 的问题 Q0–Q12

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
| Q8 | **自有 Claude 的配置根**：沿用你的 `CLAUDE_CONFIG_DIR`，还是独立根目录？ | A 沿用；B 独立根（需要单独登录） | A：复用登录，乐章结束后能在原生 CLI 里 `--resume`；transcript 会写进你的配置根，零写审计按 sessionId 白名单排除。无论哪种都用 `settingSources: []`，不加载你的 hooks、MCP 和权限规则。r3 补充：开了视觉的 Claude 侦察乐手建议用 B（私有配置根、短 `cleanupPeriodDays`），因为截图会留在 `tool-results` 里（E9 [cu]） | M1 开始前 |
| Q9 | **自用还是发布**：Orchestra 是自用，还是发布给 DSH 社区？许可证用什么？ | 自用 / 社区；MIT / Apache-2.0 | M0–M2 自用，M3 前再定是否发布；许可证现在就定 MIT（附 NOTICE）。这会影响 BSB tab、可选的社区产出以及 P2–P4 需求的优先级。r3 补充：发布时 GBR（无许可证）的设计参考只能停留在 README 级（Q-A） | 许可证在 M0；发布在 M3 前 |
| Q10 | **通知分级**：是否接受 §11.2 的分级表和专注模式规则？ | 接受 / 调整 | 接受，跑完 M0 后按每小时干预次数微调 | M0 验收后 |
| Q11 | **shadow → active 的门槛** | 一致率与样本数；注意力指标 | 最近 50 条派活一致率 ≥80%，并且 blocked→noticed 中位时间 < 2 min | M4 |
| Q12 | **你说的 Ultracode 体验最看重哪一点？** | A 不用自己选派给谁；B 一个主对话一直不断；C 自动拆活、并行推进 | 建议优先 B：M1 的主代理乐手（有通讯录、收件箱、已定决策）就能给你；A 要等 M4 的 Maestro 和足够的标签；C 依赖 M3 的委托树，跨 harness 的自动拆活要等 M6 的 Arrangement | M4 开始前（M1 前回答更好） |

### 17.2 r3 新增：bot 架构（[arch]）

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-A | **你说的「grokbot 早期开源出来的代码」是哪一个？** 没有找到官方的 Grok Bot 源码发布 | A `b-nnett/grok-bot-0.18-reconstructed`（GBR：从 0.18 二进制重建，无许可证，已归档）；B `xai-org/grok-build`（Apache-2.0，xAI 真正开源的 harness，含 relay 与投递管道）；C `xai-org/grok-prompts`（AGPL-3.0，提示词不是代码）；D 某个论坛链接 | 若是 B，现有引用已足够；GBR 独有的细节（A10 的上限、A18、A19 的字段）保留并标注「重建件」，不再读其代码；本会话 scratchpad 里抓取的 GBR 原文是否删除、无许可证的重建代码能否在 MIT 下作设计参考（关联 Q9），请你拍板 | 现在（影响 §12.2 与附录 E 的标注） |
| Q-B | **自动回信**按消息角色（请求回、通知永不回），还是像 Grok 一样每条回复都显式？ | 按角色 / 每条显式 | 按角色（D16） | M1 开始前 |
| Q-C | 是否把 **OpenClaw** 当 harness 宿主来联邦（`dsh --profile acp` 作为自定义 acpx agent，未测试）？ | 联邦 / 只参考 | 只参考：OpenClaw 没有 DSH 目标、每周变动、`restart-recovery.md` 有 1,722 行 | 不急 |
| Q-D（房间模式） | M3 是否交付 `everyone` 房间模式？MaiBot 的拟合门需要数月日志 | 交付 / 只做 admin + 开头 @ | 只做 admin 加开头 @（A10） | M3 开始前 |
| Q-E | 要不要研究 **Tobs**（第二个 DSH "GrokBot replacement"）？要不要把 **Grok Build** 当第四个 harness（它说 ACP，`~/.grok/sessions` 有 dsh-TUI 的解析器，Windows 有二进制）？ | 研究 / 不研究；第四 harness / 不 | （本文补充）都不排期；Q9 选发布时再看 Tobs | 不急 |
| 也要确认 | R29 回访的 N 次 / T 分钟默认值，以及回访的费用记在哪个预算上；DS-Bot 路由正文里的 @（`mentions.js:52`），所以 M4 导入的 DS-Bot 声部与 Orchestra Rooms 行为不同，是否接受 | — | （本文补充）M1 以临时默认值（待定）上线回访，M3 前用 M1–M2 的数据校准 N、T；费用记发起委托的 root；接受差异并在 Rooms 界面标注 | M1 开始前给临时值；M3 开始前定稿 |

### 17.3 r3 新增：工作流（[wf]）

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-W1 | **谁能编写和启动 Arrangement**，默认预算多少？ | 只有你；Maestro 可提议（shadow）/ 乐手也能启动 | 只有你能启动（你的点击授权整次运行，不授权每个 worker 的动作）；Maestro 只能提议，agent 编写的脚本污染每次调用并要求键入确认；默认预算在项目日上限之内、`arrangementCalls` 64、墙钟 60 min（[wf] 的默认值，§8.8 (e)） | M6 go/no-go 前 |
| Q-W2 | 是否接受 **DSH 模板 worker 只在沙箱内**（没有沙箱外命令），因为 DSH 只有一次性放行与 `ask\|never`，Orchestra 不能替它回答 `allow`（D8）？ | 接受 / 放宽沙箱模式 | 接受：v0 模板本来只读；被拒绝的请求汇总为每次运行一条 InboxItem | M6 go/no-go 前 |

### 17.4 r3 新增：乐器（[cu]）

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-C1 | **「真正的 bot」是什么意思？** | A 租来的隔离浏览器 + 交接（M1 起能查、M2 起能动）；B 自有乐手必须能驾驭你的桌面（Tier 2：M2 末 S-CU、M3 look、M4 act；隔离桌面计划外） | **已定（2026-10-27）：B**（你的原话：「我觉得 B 是必要的」）。本文此前建议 A；现按 B 执行：Tier 2 进入 M3 / M4 计划，S-CU 为交付前提 | 已定 |
| Q-C2 | UI 是否跑在**独立的浏览器 profile** 里？你自己开的 `--chrome` 与厂商 CU 会话是否算「等同于你」？ | 独立 / 共用；算 / 不算 | 独立 profile（E5）；（本文建议）都算等同于你，Tuning 常驻计数；§10.11 #6 目前只计 bypass 会话与 Tier 2 持有者，待 Q-C2 后补 | M2 开始前 |
| Q-C3 | **乐器只给侦察乐手**，M1 的 Tier 0 只 look？ | 接受 / 任何乐手都能拿 | 接受（E6） | M1 开始前 |
| Q-C4 | **首批 Grant** 包含哪些 IdP 与 origin，有效期多长？ | 由你列出 | （本文建议）从 CI 与内部面板的一个 IdP 开始；有效期以天计，到期重新授权 | M2 开始前 |
| Q-C5 | 自有乐手的**桌面 CU**：Tier 2（`orchestra-desktop` + cua-driver，宿主见 Q-DC0）、只 Tier 3、还是永不？ | Tier 2 / Tier 3 / 永不 | **已随 Q-C1 定为 Tier 2（2026-10-27）**：M2 末跑 S-CU（+2–3 d）；M3 look / M4 act 约 +3–3.5 周（推断），是否如期排由 S-CU 结果决定（§13.4、§13.5）；Tier 3 仍在计划外 | 已定 |
| Q-C7 | **DSH 乐手只读**（查询路由给 Claude），还是允许 DSH 侦察乐手，包括 Q-DC0 选 DSH 时的桌面侦察乐手？ | 只读 / 允许 | 允许 DSH 侦察乐手，前提是 S2 go 与 Q-C8 | M3 开始前 |
| Q-C8 | DSH 的眼睛需要 `deepseek-flash`：侦察乐手切换到它，其余 DSH 乐手留在纯文本的 `deepseek-v4-flash`？ | 是 / 否 | 是；图片回传在 S2 / S-CU 测 | M3 开始前 |
| Q-C9 | **Tier 2 撤销开关**：前台驾驭器用 Raw Input 加 nonce，后台 cua-driver 用热键加在场检测？离席判定 N 秒 | 接受 / 调整 N | 接受分开的开关；N 在 S-CU 里定 | M3 开始前（Tier 2 look） |

Q-C6 在研究文档中不存在（编号跳过）。

### 17.5 r3 新增：DSH computer use 与桌面驾驭器（[dcu]）

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-DC0 | **桌面侦察乐手的宿主**：DSH（图片路径未测）、Claude（图片已验证）、还是都行？ | DSH / Claude / 都行 | 先 Claude；DSH 等 S2 与 Q-C8 | M3 开始前 |
| Q-DC1 | **只 look 的桌面租约**是否不冻结你的 UI？ | 冻结 / 不冻结 | （本文建议）v1 一律冻结，即 E5 不改（[dcu] 把是否放宽 E5 留给 Q-DC1 / Q-DC7，未下结论）；理由（推断）：look 也要把驾驭器放到你的桌面上 | M3 开始前 |
| Q-DC2 | **首批 Windows 应用白名单**有哪些？未签名的应用可否按路径 + SHA-256 加入？ | 由你列出；可以 / 不可以 | 从计算器、一个 Win32 工具开始；未签名的可以按路径 + SHA-256 加入，但在卡片上标注 | M3 开始前 |
| Q-DC3 | **cua-driver 钉版**：sigstore + SHA-256 + Authenticode `Cua AI, Inc.` 三重校验，任何一项失败就拒绝？ | 三重 / 放宽 | 三重（R52） | S-CU 前 |
| Q-DC4 | **M4 的 act**：只后台，还是在你的授权下按步前台（Windows-MCP，nonce 开关）？ | 只后台 / 按步前台 | 只后台（A34）；前台只作后备 | M4 开始前 |
| Q-DC5 | 桌面 host 之外、装了 CU 包的**自有 DSH 会话**：P1 横幅加伪租约（CU-14），还是 P2 横幅？ | P1 + 伪租约 / P2 | P1 + 伪租约 | M2 开始前 |
| Q-DC6 | **主驾驭器**：cua-driver（预发布、后台、精确拒绝）还是 Windows-MCP（前台）？ | cua-driver / Windows-MCP | cua-driver，S-CU 通过为前提；Windows-MCP 去掉 PowerShell、Registry、进程工具后作后备 | S-CU 后 |
| Q-DC7 | **桌面 act 的审批路线**：A 在 look 租约里起草计划，租约之间批准（E5 不变，一个任务两次租约）；B 修改 E5，让配对 UI 在租约中从目标窗口后方回答步骤卡 | A / B | A；在拍板前桌面写入一律拒绝（`no-approval-route`） | M4 开始前 |
| Q-DC8 | 选择保留的**桌面截图的保留期**？ | 24 h / 其它 | 24 h，与 E9 一致（假设） | M3 开始前 |

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
| [bot-architectures.md](../research/bot-architectures.md) [arch] | r3 并入。候选对照（DS-Bot、Tobs、OpenClaw、Koishi / cordis、MaiBot、Grok Bot / GBR / grok-build、Letta、Paperclip、Agents SDK / ADK、AutoGen / MAF、CC 团队与跨会话、Codex collab）、模式矩阵、A1–A20、否决的模式、R29–R41、Q-A–Q-E；两轮红队的 Review log |
| [dynamic-workflow-merge.md](../research/dynamic-workflow-merge.md) [wf] | r3 并入。「dynamic」的四种含义、五家引擎对照、社区事故、失败归属、两层合并设计（钳制 / 观察 / 治理；Arrangement 的沙箱、重放、join、终止、预算、权威、呈现）、R33 / R34 / R41、验收用例 1–18（本文编为 WF-1–18） |
| [computer-use.md](../research/computer-use.md) [cu] | r3 并入。harness 能力表、乐器模型（Tier 0–3）、Grant 与 Lease、E1–E15、两阶段审批、A21–A30、R42–R51、Q-C1–C9、验收用例 1–17（本文编为 CU-1–17）；含 2026-10-26 的 19 条勘误与复核后的更正 |
| [dsh-computer-use.md](../research/dsh-computer-use.md) [dcu] | r3 并入。DSH computer-use 包地图、注册槽、进程模型、同意、图片路径、审批；Windows 实况（投递账本、焦点与注入、闸门、进程、成熟度）；与乐器模型的契合；`orchestra-desktop` 配方；A31–A39；R52–R60；Q-DC0–8；验收用例 18–30（本文编为 CU-18–30）；两轮复核与一轮修订后复核 |
| 原始报告（评审前，与综述不一致时以综述为准） | `openclaw.md`、`koishi-maibot.md`、`grok.md`、`agent-frameworks.md`、`community.md`、`dynamic-workflow.md`（[arch] / [wf] 的六份）；`cu-{harness-cu,bot-cu,cua-landscape,security-cu,windows-isolation,community-cu}.md`（[cu] 的六份）；`dcu-{registry-providers,consent-lib,macos-native,upstream-windows,community-versions,orchestra-fit}.md`（[dcu] 的六份） |

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
| `C:\Users\Calx\.codex\plugins\cache\openai-bundled`（`unified-computer-use`）、Codex 桌面应用的 `cua_node\…\@oai\sky` 0.7.13 | Codex 自带 computer use 的位置与 `.mcp.json`，只读参考 [cu]。同目录的 `~/.codex/auth.json` **永不读取** |
| 会话 scratchpad 中的 `deepseek-harness@22ddee3` 稀疏克隆与 `trycua/cua` v0.28.0 / v0.37.0 的 `libs/cua-driver` 源码树 | [dcu] 引用的 `packages/computer-use/**`、`packages/experimental/**`、`core/tools/src/pipeline.ts` 与 `rust/crates/platform-windows/src/**` 的出处；不可信数据，从未执行；不在仓库内，复核时按文件@sha 重新获取 |

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

---

## 附录 D r3 修订记录

### D.1 做了什么

r3 把四份研究文档并入 r2，文档本身不改：
- `bot-architectures.md`（2026-10-26，两轮红队）→ 标签 [arch]。
- `dynamic-workflow-merge.md`（2026-10-26，两轮红队）→ [wf]。
- `computer-use.md`（2026-10-26，两轮红队；同日吸收 dsh-computer-use.md 的 19 条勘误并做修订后复核）→ [cu]。
- `dsh-computer-use.md`（2026-10-26，两轮红队加同日的三路修订后复核）→ [dcu]。

四份文档都从研究代理的并行扫描起步（[arch] 与 [wf] 共用同一组 6 份研究报告，[cu] 与 [dcu] 各有 6 份；只有 [dcu] 注明报告由 Opus 代理写成，其余未注明模型），再由综合者写成立场文件，然后由独立的红队代理按事实、连贯、设计三条线复核，修订者只应用在原始源码里核对过的意见。合并（2026-10-27）的做法是：先写一份带规范词表的合并计划（术语、D13–D18、A1–A39、R29–R60、E1–E15、Exchange / InboxItem 的新词、默认值、新问题），按章节簇并行起草，用脚本拼装到 r2 上，再由独立的复核代理对照四份原文检查覆盖、矛盾、编号与工期算术，修订后再复核一遍（结果见 D.4）。

### D.2 结构约定

- **章节编号不变。** r2 的 §1–§17、D1–D12、R01–R28、Q0–Q12 原样保留，邮局规则 1–8 的编号与含义保留（规则 1、4 按 [arch]、规则 7 按 [wf] 增补了文字），四份研究文档里对 r2 章节的引用因此仍然有效。新内容只出现在：§2.5、§2.6（本文补充）、§3.1 原则 12–13、§3.2 新增非目标、§4 D13–D18、§8.3 规则 9–11、§8.7、§8.8、§10.13–10.16、§13.8（M6）、§17.2–17.5、附录 D–F，以及各节内部标注了来源标签的增补。
- **ID 沿用研究文档。** A1–A39、R29–R60、E1–E15、Q-A–Q-E、Q-W1–W2、Q-C1–C9（无 Q-C6）、Q-DC0–DC8 与四份文档一致；验收用例在附录 F 统一加前缀 WF-（dynamic-workflow-merge.md 的 1–18）与 CU-（computer-use.md 的 1–17、dsh-computer-use.md 的 18–30），四份文档内部仍用原编号。
- **标签。** [bot] 仍指 ds-bot.md；[arch] [wf] [cu] [dcu] 指四份研究文档；（本文补充）标记只来自合并的内容。

### D.3 四份文档的修订要求在 r3 的落点

| 来源 | 修订要求 | r3 落点 |
|---|---|---|
| [arch] | §0.4 / §2.3 决策通知是 `wake:none`、回执显示「已读」 | §0.4 第 2 条；§2.3 场景 |
| [arch] | §2.1 第 2 行加「通知不唤醒；回复不触发回复」 | §2.1 能力表第 2 行 |
| [arch] | §3.2 不自动多轮交换、不让 agent 创建乐手 | §3.2「来自 r3 并入的研究」 |
| [arch] | §4 D13–D16 | §4 表 |
| [arch] | §6.1 字段；§6.3 状态与拒绝码；§6.5 新条目种类 | §6.1、§6.3、§6.5 |
| [arch] | §8.1 `trust` += `runtime`、`op`、`wake`、`replyFormat`；§8.5 A4–A6；§8.3 规则 1、4、9–11 与重启阶段命名；§8.6 返回形状与 `orchestra_request_musician` | §8.1、§8.3、§8.5、§8.6 |
| [arch] | §9.2 第 4、9、10 步 | §9.2 |
| [arch] | §10.2–10.4 A14、A12、A13；§10.7 / §10.12 上限与默认值 | §10.2、§10.3、§10.4、§10.7、§10.12 |
| [arch] | §12.2 许可证（GBR、grok-build、MaiBot、webui、grok-prompts、cordis / Koishi / OpenClaw / Paperclip） | §12.2 |
| [arch] | §13 各里程碑的 A 落点与削减顺序；§15 工期风险；§16 R29–R41；§17 Q-A–Q-E | §13.3–13.7、§15、§16、§17.2；模式全表在附录 E |
| [wf] | §2.4 Orchestra 观察并治理原生运行；§3.2 不做 DSL / 编辑器、不在自有会话外调用 LLM | §2.4 表末行；§3.2 |
| [wf] | §4 D13 | §4 表 |
| [wf] | §6.1 模板乐手、`ArrangementRun`、`ArrangementCall`、Clone 的 `groupId` / `phase`；§6.5 `workflow-run`、`arrangement-paused`、`budget-incident` | §6.1、§6.5 |
| [wf] | §7.4 钳制、Claude 工作流关闭、浮现被静默拒绝的审批；§7.3 / §10.11 记录路径 | §7.3、§7.4、§10.11 |
| [wf] | §8.1 / §8.3 `from.kind`、路径派生的 `requestId`、独立的 `arrangementCalls` 上限、`unknown` 终态、分叉即停 | §8.1、§8.3、§8.8(b)(c) |
| [wf] | §10.2 / §10.7 / §10.9 每次调用都接纳、80/100% 事件、按事件计数的扇出、K-lint、stall(3)、`ask()` 只建 Decision、DSH 模板自动拒绝并汇总 | §10.2、§10.7、§10.9、§8.8(d)(e)(f) |
| [wf] | §11.3 / §11.4 分组卡片、原生运行树、Circuit 标签页 | §11.3、§11.4、§8.8(i) |
| [wf] | §13 M1 钳制、M2 观察、M3 R33、M6 Arrangement v0 / v1；§15 风险；§16 R16 → M3、R33、R34、R41；§17 Q-W1、Q-W2 | §8.7、§13.3–13.5、§13.8、§15、§16、§17.3；验收用例 WF-1–18 在附录 F |
| [cu] | §3.2 只在 Tier 2 租约期间捕获桌面 | §3.2 |
| [cu] | §5.4 每租约 Job 与 S4 的 Chrome 检查 | §5.4、§13.2 S4 |
| [cu] | §6.1 `Grant`、`Lease`、`instruments`、`scout`、`taintSticky`、`leaseId`、`imageTokens`；§6.5 `lease-request`、`lease-expired`、`handoff`、审批的 `actionClass` / `elementDigest` | §6.1、§6.5 |
| [cu] | §8.1 / §8.6 E6 的 taint、`browser:` / `screen:` / `sandbox` 来源、`shot:<id>`、`orchestra_request_lease` | §8.1、§8.5、§8.6 |
| [cu] | §10 E3–E5、E13–E15；Tier 2 持有者算 bypass 会话；E11 上限；6 个浏览器 × 约 0.4 GB；Tier 2 租约 5 min | §10.2、§10.9、§10.11、§10.12、§10.15 |
| [cu] | §4 / §12 D17、D18；playwright 工具 Apache-2.0、Windows-MCP MIT、AGPL 不用、`@oai/sky` 权利未核实 | §4、§12.1、§12.2 |
| [cu] | §13 重排：M0 S4 +0.5 d、M1 Tier 0 look、M2 +3 周、M3 DSH act、条件性的 S-CU / Tier 2 look / act；总工期 | §0.3、§13.1–13.6；验收用例 CU-1–17 在附录 F |
| [dcu] | §4 D17 增加驾驭器候选与宿主 Q-DC0 | §4 D17 |
| [dcu] | §6.1 Lease 的 `actuator`；桌面 `hostKey` = musicianId | §6.1 |
| [dcu] | §8.6 lease-request 计入 flood 配额、拒绝粘住 | §8.6 |
| [dcu] | §10.4 回收器覆盖 `cua-driver*.exe` 与管道；§10.9 桌面 act 按 Q-DC7；§10.12 15 s、一个在途调用、5 min 租约 | §10.4、§10.9、§10.12 |
| [dcu] | §13 S-CU 的 go 判据、M3 look、M4 act、含 / 不含 Tier 2 的总工期 | §13.1、§13.4–13.6；验收用例 CU-18–30 在附录 F |
| [dcu] | 对 computer-use.md 的 19 条勘误与修订后更正 | 已在 2026-10-26 应用于 computer-use.md 并做修订后复核；本文按更正后的文本并入 |

### D.4 复核记录

合并后的 r3 由独立代理按七条线复核，再由修订者逐条核对原文后应用，之后再复核两轮（2026-10-27）。

| 轮次 | 线 | 检查项 | 提出 | critical / major | 处理 |
|---|---|---|---|---|---|
| 第一轮复核 | [arch] 覆盖与忠实度 | 95 | 19 | 1 / 7 | 见下 |
| | [wf] 覆盖与忠实度 | 151 | 15 | 1 / 4 | |
| | [cu] 覆盖与忠实度 | 149 | 15 | 0 / 7 | |
| | [dcu] 覆盖与忠实度 | 136 | 12 | 0 / 5 | |
| | 内部连贯 | 52 | 24 | 3 / 12 | |
| | r2 保全（105 行逐条比对 + 28 处抽查） | 133 | 9 | 2 / 3 | |
| | 设计与贴合度 | 115 | 33 | 5 / 12 | |
| 合计 | | | 127 | 12 / 50 | 修订者合并 26 组重复，核对原文后应用 84 项，驳回 9 项 |
| 修订后复核 | 事实 / 连贯 / 设计 | 93 / 172 / 64 | 26 | 1 / 8 | 第二轮修订应用 20 组、驳回 5 组（含本节由编排器补写） |
| 第二轮修订后复核 | 事实与连贯 | 25 项修改 + 26 条残留 | 2（minor） | 0 / 0 | 编排器直接修正（§13.1 M3 行、§13.5 两处措辞） |

**第一轮改了什么（按类别）**
- 事实归因：R50、§2.6、§10.16 的「55 个工具约 23.5k token」统一归于 DSH-D#7080，0.37.0 的实际数目留给 S-CU；Tier 0 浏览器约 280 MB 不再称「实测」；D14 补回 `identity.rs` 的出处；Koishi `session.ts` 的行号标「未核实」；1.4% / 2.4% 的注入率注明 Haiku 数字为评审核对、未重取；GBR 统一称「无许可证的非官方重建」，其独有的细节标「GBR 重建件，Q-A」。
- 里程碑与编号：回访在 M1、停滞升级在 M3；规则 4 的去抖与 `collect` 随 A10 在 M3，规则 10 在 M2；§5.2、§8.3、§13.3、R29、R32、R33 按此对齐；A29 拆为 M3（锁屏 / 离席 / UI 前台撤销）与 M4（前台驾驭器的 nonce 开关），四处都标为本文拆分；CU-16、CU-18 的落点写进 §13.5；A2、A14、A15、A18 在各自的落地章节补上对应句子；R16 改为「这一部分提前到 M3」，M5 的 AND-join 视图保留。
- 连贯与术语：「分身组」统一；D15 / D16 表格内的管道符转义；§6.3 的拒绝码指向 §10.16 定义的代理层代码；§8.8 的 relay-source bundle 解释为 §12.1 的 M3 bundle；`startedBy` 改为「建议只有人，待 Q-W1」；[wf] 给出的默认值不再标（假设）。
- r2 保全：恢复 §0.3 M4 行的「派活标签从 M1 开始积累」与 QA 模板说明、§11.4 的 M5 AND-join 句、§2.3 中 R27 的原意（原生工作流事后出条目，Arrangement 事前估算）。
- 设计：§2 标题改为「先回答四个问题」，§1.4 加入「眼睛」；§8.5 把「以 user 来源注入」改写为 M1 走 ACP 期间的已知例外；§10.15 / §10.16 删去重复的 Lease 动作表与否决清单；§10.16 增加 Claude 桌面宿主段（进程内挂载，推断）；§0.2 补「驾驭器」「代理」「S-CU」三条术语；§0.7 补 Q-B；§17 的多处建议加上（本文建议）。

**驳回、留给你决定的意见**（都是取舍，不是事实之争）
- 把 §2.5 的数字（OSWorld、攻击成功率）删去或移走；把 §10.16 的配方搬到新的附录 G；精简 D17 的否决列。
- 在首次出现处展开 CUA、CDP、UIA、AUMID、LPAC、PTC、WTS、Medium IL 等缩写。
- 把 Tier 0 的标签改成「侦察乐手浏览器」；把 Q4 挪进「M1 之前要定的」；把 Q-C5 拆成 Q-C5a / Q-C5b（Q-C5 已于 2026-10-27 随 Q-C1 定为 Tier 2，此条已失效）；按半周重画含 Tier 2 的标尺。
- 把附录 F.6 并入 F.3（会删掉一个小节标题）。

**复核后仍存在的不确定性**（D.6 之外）：D.5 所记「合并当日 api.github.com 仍返回 Bad Gateway」只有合并计划的记录；A29 的 M3 部分含热键撤销，所依据的 [dcu] A33 / R55 只写锁屏与离席；§10.16 的 Claude 宿主配方全部为推断；§13.1 含 Tier 2 的标尺中间边界取邻近整周、总数保留 35.5。

**结构检查**：约 2,910 行、139 个标题行（含 §10.16 YAML 块内 4 行 `#` 注释）、38 个代码围栏、表格检查 0 问题；章节与编号未增删；四份研究文档未改动，r2 只在标题下加了一行指向 r3 的说明。

### D.5 有意未并入或推迟的内容

- 四份文档各自的 18 份原始报告（`openclaw.md` 等、`cu-*.md`、`dcu-*.md`）只列入附录 A，不并入正文；与综述不一致时以综述为准。
- GBR 独有的细节（A10 的房间上限、A18 的冻结注入、A19 的例程字段）保留并标注「重建件」，等 Q-A 决定是否删除；GBR 的代码不再阅读。
- 研究文档里对 r2 以外文件的建议（例如对 `cu-*.md` 原始报告的修改）不执行。
- Q-DC4 与 Q-DC6 有重叠（act 的前台 / 后台与主驾驭器的选择），[dcu] 的修订后复核决定不合并，留给你一起回答。
- dsh-computer-use.md 中依赖 GitHub API 的事实（cua#5910 的范围、cua#3330 是否仍开、若干讨论标题、运行日期）在 [dcu] 2026-10-26 的修订后复核中因 GitHub API 不可用未能重核，标为「未复核」；合并当日（2026-10-27）再试时 api.github.com 仍返回 Bad Gateway；本文照录并保留标注。
- §2.6 的两条经验（Claude Code 的钩子机制、Anthropic 关于子代理的文章）不出自四份文档，标为（本文补充）。
- 工期数字全部是推断，没有重新估算；M6 的 4–6 周来自 [wf]，与 [cu] 的 33–35.5 周总数相加时按 [cu] 的说法另计。

### D.6 r3 仍然存在的不确定性

- cua-driver 的元素点击在源码里确认会走合成笔触，但 Raw Input 对这种笔触与 `VK_NONAME` 的视角未测；cua#3330 在 0.37.0 的 `standard` + manifest 下是否仍成立未知；可执行文件的实际签名未下载验证。
- Windows 上 Chrome 在 procguard Job 里的成员关系、回收与渲染器沙箱未验证（S4）；Raw Input 的 `hDevice` 对注入输入的表现未验证；最小化时 CDP 打字是否可用未验证。
- Claude 工作流记录（`journal.jsonl`）与 `budget()` 的说法来自 Workflow 工具描述，S3 后核实。
- Node 的网络权限标志只查了 v24；WASM 沙箱的逃逸测试尚未写。
- DSH 图片往返（`deepseek-flash` 经 `/anthropic/v1/messages`）未测；ACP 行的模型未入目录。
- 所有新增的默认值（回访 N / T、轮换上限、Tier 2 租约 5 min、桌面超时 15 s、截图 24 h、6 个浏览器）都是假设，待 M1–M3 校准。
- 工期：不含 Tier 2 约 30–32 周、含 Tier 2 约 33–35.5 周、M6 另加 4–6 周，均为单人推断。


### D.7 决策记录

| 日期 | 问题 | 决定 | 影响 |
|---|---|---|---|
| 2026-10-27 | Q-C1 「真正的 bot」是什么意思 | **B**：自有乐手必须能驾驭你的桌面（你的原话：「我觉得 B 是必要的」）。本文此前建议 A | Q-C5 随之定为 Tier 2；工期基准改为含 Tier 2 的约 33–35.5 周（§0.3、§13.1）；M2 末的 S-CU 从条件项变为计划项（§13.4）；M3 Tier 2 look、M4 桌面 act 仍以 S-CU 结果为前提，不通过则按 Q-DC6 退到 Windows-MCP 前台后备或顺延；首页表、§0.1–0.3、§0.7、§2.5、§4 D17、§5.1–5.2、§8.8、§10.13、§10.14、§12.1、§13.1–13.6、§14、§15、§16、§17.4、附录 F 的条件措辞同步改写 |

**随之变得要紧的问题**：Q-DC0（桌面侦察乐手的宿主，建议先 Claude）、Q-DC6（主驾驭器，建议 cua-driver，Windows-MCP 后备）、Q-DC2（首批 Windows 应用白名单，只有你能列）、Q-DC7（桌面 act 的审批路线，建议 A）、Q-DC3（钉版三重校验，建议是）、Q-DC4（act 只后台，建议是）、Q-C9（撤销开关分前后台，建议接受）、Q-C3（乐器只给侦察乐手、M1 只 look，建议接受）。

---

## 附录 E 模式库 A1–A39

本附录集中列出 r3 从四份调研里采纳的 39 个模式，正文只引用编号（如「A9」）。调研的结论是把这些项目当模式库，不当底座：没有一个项目做 Orchestra 的核心工作（跨 harness 带回执的 A2A、跨项目收件箱、governor），所以 D2、D7、D9 不变；补进来的是约 20 条投递、权威与终止规则 [arch]，加上乐器模型下的 19 条浏览器与桌面规则 [cu][dcu]。

- **A1–A20** 来自对 DS-Bot、OpenClaw、Koishi / MaiBot、Grok Bot / grok-build、agent 框架（Letta、Paperclip、AutoGen / MS Agent Framework、OpenAI Agents SDK、Google ADK）、harness 原生消息（CC agent teams、CC 跨会话、Codex collab）与聊天 bot 的对照调研 [arch]。
- **A21–A30** 来自浏览器与桌面 computer use 调研 [cu]；**A31–A39** 来自 DSH computer use 调研 [dcu]。
- 「来源」列是压缩后的指针，完整路径、行号与 sha 见对应调研文件。标「重建件」的细节只来自 GBR（对 Grok Bot 0.18 二进制的非官方重建，无许可证，Q-A）；按 §12.2 只做 README 级参考，不再读其代码。
- 「落地」列的 § 指本文章节，里程碑按 §13。A1–A20 的验收列照抄 [arch]；A21–A39 的验收列是本文按附录 F 的用例归并的（推断），[cu][dcu] 的模式表本身没有这一列。

### E.1 采纳的模式

| # | 模式 | 来源 | 落地（§ / 里程碑） | 零 token 验收 |
|---|---|---|---|---|
| A1 | **只有乐手可寻址。** 只有 Musician id 是地址；Part id（含 `replyTo`）重解析到当前乐章。拒绝码 `raw-session-id`、`stale`（已归档的乐手）、`foreign`、`unresolved`、`clone-not-addressable`、`template-not-addressable` | grok-build `address.rs:86-127`（`RawSessionId`、`Foreign`、`Stale`、`WorkflowNotAddressable`、`Unresolved`）；分身与模板的拒绝是本文的策略，GB 给普通子代理寻址（`:46-57`）[arch] | §6.1、§6.3、D14；M1 | 原始 sessionId、分身或模板目标按各自的拒绝码被拒；两次轮换加一次重启之后的回复仍到达乐手 |
| A2 | **邮件寄给乐手，乐章释放后仍送达。** `accepted`（已入 journal）先于 `delivered`；接纳（`queued\|steered\|held`）与回复投递分开报告，带 `sentBeforeError` | Codex `mailbox.rs:1-2,72-75`；CC agent teams；OpenClaw `session-tool.md:379-399` [arch] | §6.3、§8.2、§10.4；M1 | 发给已释放的乐手会重新拉起其乐章并只投递一次，守护进程中途崩溃也一样 |
| A3 | **沉默有效，不丢东西。** `reply` / `notice` / `progress` 不开 Work、不自动回信；`wake: turn\|none`，通知为 `none`；只含致谢的回复作为回执到达（`replied(suppressed)`），等待不会挂住。只致谢 = 发送者设 `replyFormat:'none'`，或短正文且无 refs | OpenClaw 移除 ping-pong（`releases/2026.10.1.md:1182`、`acp-agents/delivery.md:80-86`）；Codex QueueOnly；CC#47930（空操作致谢约 13%，最高 22%）；GBR `agent-messaging.ts:46,115`（重建件）[arch] | §8.1、§8.3 规则 9、D16；M1 | 「Thanks」在一次回复后结束；发送者的等待返回 `replied`；一条通知启动 0 个回合 |
| A4 | **类型化权威，一个字段。** `trust` 增加 `runtime`，不另设 `principal`：`human` = 配对 UI，`agent` = 绑定的乐章，`unbound` = 没有乐章的同用户进程，`external` = 导入，`runtime` = 守护进程计算。agent 只能 `queue\|steer`；`interject` / `interruptAndSend` 人类专属。邮件是带归因的数据，绝不以 `system` 注入 | grok-build `envelope.rs:4-18,92,111`；Codex `inter_agent_message.rs:53,66`；反例 Letta `multi_agent.py:77-86` [arch] | §8.1、§8.5、D15；M1 | agent 代码无法构造 `human` / `runtime`；agent 发起的中断被拒绝 |
| A5 | **权威链卫生。** 转发或计算出的文本永不携带人类权威；拒绝不可转发。拒绝记在 `rootId` 上，同根内同类动作再出现时标「上游已拒绝」（推断）。任何 CLI 都没有 approve / resolve / kill（D8、§10.11 #4）；CLI `send` 走 agent 管道，否则记 `unbound`；`ORCHESTRA_PART` 环境变量只是 UX 提示 | CC agent teams；CC#96640、CC#65784；`OPENCLAW_SHELL`（`session-tool.md:432-439`）[arch] | §8.5；M2 | 对 Aiko 拒绝 X；Aiko 请 Ren 做 X；Ren 的卡片显示那次拒绝。取消环境变量得不到任何东西 |
| A6 | **每乐手入站策略。** accept / hold / refuse 按权限类别，只有人能改。仅 agent 的 hold 5 min 过期；等人放行的 hold 跟审批超时（Q4）与专注模式暂停。≤100 held、≤50 queued；重复丢弃；发送 ≠ 可见 | CC 跨会话 `crossSessionInbound`；OpenClaw `session-tool.md:230-248,278-284` [arch] | §6.1、§8.5；M2，hold 在 M3 | 过期的 hold → P2 条目；agent 修改策略被拒绝 |
| A7 | **按当前策略重新接纳。** 端点 =（乐手，项目，入站策略），不是乐章：崩溃时 Job 会杀掉自有乐章（§5.4）。输入 id 复用；发送者永不重跑 | OpenClaw 需要精确的会话存在（`session-tool.md:286-308`）；它的会话持久，我们的不是 [arch] | §8.3 规则 10；M2 | 策略已撤销 → 拒绝；策略完好 → 恢复一次（§8.3 阶段 b） |
| A8 | **每个 Work 一个执行者**（`executionPartId`）：自我唤醒合并，其他延后；steer 到达执行中的乐章；排队中的 Exchange 可编辑 | Paperclip `issue-run-orchestration-plan.md:46-66`；DSB-D#527、DSB-D#207 [arch] | §6.1、§8.3、R31；M1 可编辑，M3 执行者 | 对正在房间里忙的乐手发 steer，落在那个房间的乐章里 |
| A9 | **回访与停滞计数。** N 次 exchange 或 T 分钟后唤醒提问者一次，并出 InboxItem。「无进展」= 没有新的 diff、测试、ref 或 Decision。3 次停滞升级；绝不自动重新规划 | DSB-D#501；AutoGen `_magentic_one_orchestrator.py:262-297` [arch] | §8.3 规则 11、§10.7、R29；M1 回访，M3 停滞 | 不收敛的受托者 → 一次回访，然后 P1 |
| A10 | **房间卫生。** 只有开头的 @ 才路由（Koishi 式；有意区别于路由正文 @ 的 DS-Bot 与 GBR）。admin 由人设定；严格前缀的房间命令需人类信任。≤6 成员、3 轮、10 成员回合、每回合 2 条，轮换顺序。K 次 PASS 后安静闩锁。去抖 ≤8 s（@ 提及 1 s）。路由器失败 = PASS | Koishi `session.ts:138-187`（行号未核实）；DS-Bot `mentions.js:1-3,52`；上限取自 GBR `group-chat.ts:1`（重建件）；MaiBot `heartFC_chat.py:225-240`、`debounce/README.md` [arch] | §9.2 第 4 步、§10.7；M3 | 引用「@Ren 说…」不路由到任何地方；房间在轮数上限处停下 |
| A11 | **只从候选里选，绝不默认。** 第 9 步的 LLM 只从第 5 步幸存者里选；每乐手 handoff ACL；标签不足 N 时用静态后备 | AutoGen `_selector_group_chat.py:163-198`；MaiBot `dynamic_gate.py:1-28` [arch] | §9.2；M4 | 候选之外的 LLM 选择被拒绝 |
| A12 | **死循环细则。** 同一工具错误连续 3 次结束回合；warn → block → end；第 10 次相同的 `wait` 被阻止；哈希前剥除 PID、时长、cwd | OpenClaw `loop-detection.md:11-17,91-95,189-208` [arch] | §10.3；M0 / M2 | PID 变化的重复仍然触发 |
| A13 | **轮换熔断。** 区分确定性失败与瞬时失败；每小时轮换上限；核实旧乐章已归档；退避 + InboxItem | DSB#485（1,971 帧 `runSwitch` 后 OOM）；反例 MaiBot `heartFC_chat.py:497-501` [arch] | §10.4、R32；M1 小时上限，M3 其余 | 缺 key 的 fixture → ≤3 次尝试、P1、无 OOM |
| A14 | **预算事件。** 软 80%、100% 自动暂停；每（策略、阈值、窗口）只开一个事件；成本上卷到 `rootId`；调用带 `purpose` | Paperclip `SPEC.md:410`、`budget-policies-and-enforcement.md:114-115,232`；Codex `budget.rs:12-16`；MaiBot `request_type` [arch] | §10.2、§11.5；M2 | 一个窗口内同一阈值三次越线 → 1 个事件 |
| A15 | **观察者协议**（主代理与 Maestro）：合并的、字节稳定的通知；冻结的水位线；不自我通知；`changesSince` + `historyGap`；SSE `{upserted, removed}` + 重同步帧；4 倍 keepalive 静默即判死 | OpenClaw `session-state.md:95-103`；grok-build `roster.rs:1-32`、`relay.rs:18-22` [arch] | §5、§11.2；M2 / M3 | 回放时轮询 token 占比保持在阈值之下 |
| A16 | **薄完成**：状态、有界摘要和 refs；截断有标记 | OC#96975、CC#67684、DSH-D#10115 [arch] | §8.3 规则 1、R36；M1 | 200 KB 的回复以摘要 + ref 到达，标 `truncated` |
| A17 | **不自我复制。** 创建乐手或例程走类型化请求，由人批准 | OpenClaw `multi-agent.md:95-110`；反例 Grok「激进」的例程提示 [arch] | §8.6、R40；M1 | `orchestra_request_musician` 只生成一条 InboxItem |
| A18 | **每乐章冻结注入上下文。** 车道契约人设（owns / does-not-own / 聊天预算 / handoff）+ DS-Bot 的沟通纪律 | GBR `sand-memory.ts:24-38`（重建件）；OpenClaw `parallel-specialist-lanes.md:99`；DSB-D#322 [arch] | §11.6、§11.7；M1 | 人设与注入块在同一乐章内逐字节一致 |
| A19 | **例程 = Reminder v2**：trigger、`expiresAt`、安静时段、认证失败后暂停；载荷是数据。每乐手 ≤50、保留最近 20 次运行、每次唤醒 ≤25 个事件 | GBR `automation.ts:9,11,13`（重建件）[arch] | §6.1 Reminder；M3 | 过期的 watch 不再触发 |
| A20 | **记忆范围分读写标志**，加共享组 | MaiBot `bot_config_template.toml:66-87` [arch] | 记忆范围；M5 | 只读范围拒绝写入 |
| A21 | **按租约包装 playwright-mcp，无障碍树优先** | playwright-mcp README v0.0.83 `:3,15`；CUA landscape 子报告 [cu] | §10.13、§10.14；M1 / M2 | CU-1：两个乐手两个目录，被占用的 profile 排队 |
| A22 | **`orchestra-browser` 代理**：分级、两阶段、taint、脱敏、计量 | CUA landscape 与安全子报告 [cu] | §10.14、§10.15、R45；M2 | CU-6：snapshot → click → `approval-pending`，批准后只执行一次；CU-8：脱敏 |
| A23 | **profile 绑定 Grant**，按租约使用，跨轮换存活 | DS-Bot `session.js:1-3` [cu] | §10.14 Grant、R44；M2 | CU-10：到期 → `draining`、`lease-expired`，输入停止 |
| A24 | **查询阶梯** API → fetch → 无障碍文本 → 截图 → 桌面 | Claude `computer-use` 文档 [cu] | §10.13、R46；M4 | 附录 F 无对应用例（待定） |
| A25 | **结果不明不重发**：只观察 | DS-Bot；MaiBot `bridge.py:187`；OC#75879（[cu] 对 A25–A27 合并给出） | E12、§10.15；M2 | CU-12：丢失的写响应 → `unknown-outcome`，0 次重放 |
| A26 | **`handoff` 条目**，只有你能结束 | 同 A25 [cu] | §6.5、R48；M2 | CU-5：向密码框输入生成 `handoff` |
| A27 | **删除类用 nonce 确认** | 同 A25 [cu] | E3、§10.15；M2 | 无单独用例，归入 CU-6 的两阶段审批（待定） |
| A28 | **图片只传引用并限额** | CC#13480、CX#31040、DSB#560、DSB#578（open PR）[cu] | E7、E11、R47；M2 | CU-7：4K PNG → ≤1,600 px 的引用，无 `data:image`；CU-9：第 21 张图被拒 |
| A29 | **桌面租约撤销**：前台驾驭器凭物理输入，后台 cua-driver 凭热键与离席 | Windows 隔离子报告；反例 OpenClaw 按运行作用域、「no lease, expiry」（`nodes/computer-use.md:76,287`）[cu] | §10.14 撤销开关、Q-C9；M3（锁屏 / 离席 / UI 前台撤销，随 Tier 2 look：R55、CU-16、CU-17）/ M4（前台驾驭器的 nonce 开关，随 act）（M3 / M4 的拆分为本文推断；[cu] 原表 A29 整体为 M4，M3 部分依据 [dcu] A33 / R55） | CU-17：cua-driver 租约期间物理输入不撤销、热键与离席撤销；CU-16：UI 来到前台 → 409、撤销 |
| A30 | **一次性桌面槽位** | MaiBot；Windows 隔离子报告 [cu] | §10.13 Tier 3、R51；计划外 | 无用例 |
| A31 | **dispatched ≠ verified**；只观察，不重放 | `cua/src/protocol.ts:130` [dcu] | §10.16、R54；M3 | CU-21：`effect: unverifiable` 到达模型文本，Exchange 记 `unknown-outcome` |
| A32 | **目标元素变了，审批即失效** | cua-driver `WINDOWS.md:521-546` [dcu] | §10.16、R45 桌面绑定；M4 | CU-22：label 或 frame 变化 → `stale-approval`；同 label 兄弟移入 → `ambiguous-target` |
| A33 | **锁屏或离席即杀驾驭器** | `NativePlatform.swift:91-104` [dcu] | §10.14、R55；M3 | CU-23：调用中假锁屏 → 0 个驾驭器、不重放 |
| A34 | **cua-driver 只走后台**；拒绝不等于放行前台（Q-DC4） | 原生 provider `src/index.ts:37-41` [dcu] | §10.16；M3 | CU-20：前台、x/y 等在派发前被拒；`windows_targeted_injection` → `suspended` |
| A35 | **身份 = AUMID 或路径 + 签名者，加 pid + createTime** | `ApplicationAuthorization.swift:14-24`；`platform-windows/src/history.rs:139-147`（AFH → 宿主 pid）[dcu] | §10.16、Q-DC2；M3 | CU-26：复制的 exe、复用的 pid、Terminal（AUMID）、允许 Calculator 时的 Settings 都被拒 |
| A36 | **只有会话级授权，不用 `allowedApps`** | `application-access.ts:137-146` [dcu] | E13、§10.16；M3 | CU-18：侦察配置没有 `allowedApps` |
| A37 | **撤销即中止在途工作，换新驾驭器进程** | DSH `2026-09-26-cua-application-consent.md:25` [dcu] | §10.14 租约动作表、R42 修订；M3 | CU-24：Invoke 中 `kill-tree` → 0 个驾驭器、目标保持 enabled、在途写入 `unknown-outcome` |
| A38 | **独占的排队持有**；关闭失败仍持有 | `browser-use-runtime/src/index.ts:60-197` [dcu] | §10.14 Lease；M2 | CU-25：两个桌面侦察乐手，一个 `active` 一个 `queued` |
| A39 | **结果字段折进文本，工具子集精选** | DSH-D#7788、DSH-D#7080 [dcu] | §10.16、R50、R54；M3 | CU-21：只在 `structuredContent` 里的字段到达模型文本；CU-27：argv、env、manifest 与配方一致 |

### E.2 否决的模式

每条给一个理由；工作流相关的否决项（DSH `tool-workflow` 当跨 harness 引擎、Dify 式编辑器、goal loop 掌握终止、工作流当 A2A 总线）见 D13 与 §8.8，不在此重复。

**来自 bot 架构调研 [arch]**

- 自动的 agent↔agent 多轮往来（OpenClaw 已下线）：回声循环（A3）。
- 随机发言概率、自评发言频率（MaiBot）：不可审计，违反原则 5「确定性优先，LLM 兜底」。
- 未经校验的 LLM 发言者选择（Letta `dynamic`、AutoGen 后备）：只从候选里选（A11）。
- agent 中断 agent（GBR `agent-messaging.ts:92-93`）：中断是人类专属（A4）。
- 邮件以 `system` 或 `user` 注入（Letta；DSH ACP 的 `{kind:'user'}`，§8.5）：权限提升。
- 阻塞式请求 / 回复（Letta `wait_for_reply`）：「结束你的回合」仍是默认。
- 无上限或由 LLM token 结束的循环（ADK `LoopAgent`、MAF、Letta 的「DONE!」）：只认硬上限。
- 全文转录的交接（OpenAI Agents SDK 默认、MAF）：改用交接笔记 + refs。
- 合成的人类回合、自动批准计划（MAF `_handoff.py:237-238`；CC teams）：伪造权威。
- 默认可见性 `all`（OpenClaw `session-tool.md:529-533`）：改为项目范围。
- 只靠 cwd 的隔离、skill 自动安装（OpenClaw / ClawHub，二手来源）：与 D4 的隔离要求不符（推断）。
- 客户端自选权限模式（grok-build `leader/protocol.rs:176-190`）：违反 D5。
- 专用的心跳调度器（OpenClaw 已下线）：D10 已定由 Orchestra 自己的调度器负责。
- LLM 合并出的记忆当决策（MaiBot `MemoryChest`）：与 R12 冲突。
- 为节省运行次数而放宽上限（DSB-D#501）：正是 A9 停滞的成因。
- 寄宿在 OpenClaw 上：没有 DSH 目标、每周变动、一份 1,722 行的 `restart-recovery.md`（Q-C）。
- 复制 GBR、MaiBot（GPL-3.0）、Koishi webui 或 grok-prompts（AGPL-3.0）的代码：许可证（§12.2）。
- 云端中继（Grok Bot）：Orchestra 只做本机。

**来自浏览器与桌面 computer use 调研 [cu]**

- Orchestra 自己的 CUA 循环与像素优先的 agent（Skyvern 为 AGPL）：查询多数要结构化读取，像素排最后（A24）；许可证。
- 在自有乐手里用 Claude / Codex 的厂商 CU：它们只在桌面应用或你的真实浏览器里提供，不在 SDK / app-server / ACP 会话里（D18）。
- 把 DSH 的 provider 注册表当租约或多乐手设计：每个 Cordis 服务实例只有一个名字（`browser-use.md:17-23`、`computer-use/src/index.ts:35-45`）；DSH 自己否决了 Session 所有权经纪（`2026-09-12-computer-use-provider-registration.md:29`）；browser-use 不排队的持有会拒绝其他 Session（DSH-D#7007、#7169、#9688），所以 Lease 要排队。
- 进程内的原生 Cua Driver provider：它崩溃会带倒宿主（[dcu] 引 README:43）。
- 把 Codex 的确认文档当闸门：只借用它的分级（E3）。
- storage-state 文件交接：同用户的 DPAPI 挡不住乐手的 shell（推断），Grant 不落文件。
- 默认配置的 WSL2 当边界：默认读写挂载驱动器、能启动 Windows 进程。
- 「有用就上」的浏览与粘性自动批准名单：与两阶段审批和 D8 相悖（推断）。
- 无人值守的登录态浏览：Grant 的在场规则，无人值守只给公共 origin 的 look。
- 托管浏览器、Lightpanda：不在本机，隔离与出口不在 Orchestra 手里（推断）。
- 虚拟桌面切换、基于 SendInput 或 pen 的「后台」、RDP 到自己、Job UI 限制：注入的输入无法与你的物理输入区分（§10.14 撤销开关）；带 UI 限制 `0x41` 的 Job 让 Chrome 起不来，且设了 UI 限制的 Job 不能嵌套（§10.13）；窗口寻址的 UIA / PostMessage 加精确拒绝是允许的。

**来自 DSH computer use 调研 [dcu]**

- 注册表当租约：没有持有者、队列或到期。
- 原生 provider：进程内，崩溃杀宿主。
- `allowedApps`：「Always allow」写入 profile 全局、比租约活得久（E13）。
- DSH 的审批（含 Auto review）当绑定闸门：D8；请求不带工具参数，ACP 侧也无人应答 consent。
- `bounded` 模式：比 `standard` 更松，会把已有浏览器 profile 与 Computer History 适配器放开。
- 裸 `mcp`：会代理到或拉起 `\\.\pipe\cua-driver` 上的分离 `serve` 守护进程，后者接受任何同用户进程。
- `install.ps1`、`serve`、Computer History：`install.ps1` 默认 AutoStart 加 RunLevel=Highest 的计划任务，且在 zh-CN 下出错（cua#2106，本机就是这个 locale）。
- `run_script`、`run_steps`、`launch_app`：脚本执行违反 R57；`launch_app` 注入 `VK_NONAME`（`launch_uwp.rs:141-173`）。
- v1 里的 pen 点击（x/y 与元素后备）：Raw Input 对 pen 的视角未知，撤销开关无法归因。
- 一次性 `call`（cua#5910）：0.38.0 把元素 token 限定到单进程，对一次性 `call` 是致命的。
- `cua-macos` 与社区 bundle：没有 Lease 闸门或代理，工具对每个 PTC Agent 常开，consent 比租约活得久，「Always allow」是 profile 全局，PTC 与 E6 冲突；社区的 `dsh-computer-use-win` 借用前台。

---

## 附录 F 零 token 验收用例：工作流与乐器

本附录把两层工作流（§8.7、§8.8）与乐器模型（§10.13–10.16）的验收用例集中列出；正文的 §13 验收只给缩写，全文以本附录为准。全部用例零 token：WF 系列跑在假 harness 上（WF-11 的假 Claude、mock DSH、假 Codex）；CU-1…CU-17 用带录制 fixture 的假浏览器 MCP；CU-18…CU-30 用假的 `cua-driver` MCP。它们是 D12「零 token 契约 CI」的一部分，与 §14 第 9、10 行对应。

- **编号对照**：WF-n = dynamic-workflow-merge.md 的用例 n；CU-1…CU-17 = computer-use.md 的用例 1–17；CU-18…CU-30 = dsh-computer-use.md 的用例 18–30。
- **分组**按首次落地的里程碑，依据四份调研的 §13 修订与 §13 各里程碑的验收条目。Tier 2 已定（Q-C1 = B），其用例以 S-CU 通过为前提，宿主由 Q-DC0 决定；没有落地信息的写「里程碑随 Q-DC 决定」。
- 「关联」列是本文归并的（推断），指向用例所验证的规则、模式或需求。
- 标 v1 的 WF 用例依赖 v1 原语（`pipeline`、`race`、`ask()`、`to:`），随 Arrangement v1 交付；WF-5 由调研原文标为 v1，其余三条按 §8.8 的 API 分层归并（推断）。
- S-CU 的测量（`look`、写投递率、Raw Input 对 pen 的视角、DSH 图片往返）不是零 token 用例，见 §13.4 与 §14。

### F.1 M1

| 编号 | 用例 | 关联 |
|---|---|---|
| WF-17 | 钳制生效时，12 核机器上的 `parallel(12)` 产生 0 次 `ACTIVATION_LIMIT_REACHED`；`run_in_background` 被拒绝 | §8.7 M1 钳制、§7.4、R06 验收项 |
| CU-2 | 任何配置里都不出现 `--extension`、`--autoConnect`、`--no-sandbox`、`--caps storage\|config\|network`、默认 profile 或 Job UI 限制；自有 Claude 的启动带 `--no-chrome` | E1、D18 |
| CU-5（只 look 部分） | navigate 不生成任何条目；输入类工具被 `canUseTool` 拒绝；`browser_evaluate` 不存在 | E3；M1 的 Tier 0 只 look。「密码框 → `handoff`」子句见 F.2 |

### F.2 M2

| 编号 | 用例 | 关联 |
|---|---|---|
| WF-16 | 原生轨迹 fixture 产出成员数一致的分身组；重启绝不重新启动原生运行 | §8.7 M2 观察；「绝不重启」属 M3 治理（R33） |
| CU-1 | 两个乐手拿到两个 profile 目录；被占用的 profile 排队 | A21、A38、§10.14 Lease |
| CU-3 | 出口过滤器拒绝 `orchestra.localhost`、`user@orchestra.localhost`、重定向进入它、loopback、LAN 与未列出的 origin | E4 |
| CU-4 | 一次 snapshot 污染乐章；污染跨压缩、闲置释放和模型写的轮换笔记存活 | E6、§8.5 |
| CU-5（M2 部分） | 向密码框输入生成 `handoff` 条目，只有你能结束 | E3、A26、R48 |
| CU-6 | snapshot → click → `approval-pending`；未批准什么都不执行；批准后只执行一次；digest 变化即作废 | §10.15 两阶段审批、R45 |
| CU-7 | 一张 4K PNG 变成 ≤1,600 px 的引用；Exchange、journal 和重放里没有 `data:image` | E7、E11、A28 |
| CU-8 | `sk-ant-…` 字串在模型看到之前被脱敏；截图到 TTL 即清除 | E8、E9 |
| CU-9 | 第 9 步暂停回合；五次相同的 URL + snapshot 哈希出 P0；一个乐章小时内的第 21 张图被拒 | E11、§10.3 |
| CU-10 | agent 只能创建 `lease-request`；经 MCP 授予租约被拒绝；到期 → `draining`、`lease-expired`，输入停止 | `orchestra_request_lease`、§10.14 Lease 状态表、D8 |
| CU-11 | 刹车杀掉租约的 Job；UI 浏览器存活 | E14 |
| CU-12 | 丢失的写响应变为 `unknown-outcome`，0 次重放 | E12、A25 |
| CU-13 | 退出码 21 且持有者是我们的进程 → kill 或排队一次；外来持有者 → `foreign-held`；3 次失败 → P0 | §10.4 回收器、R49 |

### F.3 M3

不以 Tier 2 为前提：

| 编号 | 用例 | 关联 |
|---|---|---|
| CU-14 | 观察到 `mcp__computer-use__*`、`mcp__remote-devices__*`，或桌面 host 之外的 `mcp__cua-driver-mcp__*`、`cua_driver_native__*`、`cua`，出横幅与伪租约；自有租约期间出现原生 CU 则该租约 `suspended` | §10.14「原生 CU 只观察、不中介」、R58、Q-DC5（后半句对任何自有租约生效，Tier 0 的 fixture 从 M2 起即可跑） |

以 S-CU 通过为前提（Tier 2 已定；M3 Tier 2 `look`，+1.5–2 周；需 S2 go 与 Q-C8，或 Claude 宿主）：

| 编号 | 用例 | 关联 |
|---|---|---|
| CU-17 | 拖拽中 kill 刷出 button-up（前台驾驭器）；Invoke 中 kill 让目标保持 enabled 且可激活（cua-driver）；锁屏 → `suspended`；重启 → `lost` + P1；并行的 Task 子代理被串行化；DSH 子代理拿不到桌面工具；cua-driver 租约期间物理输入不撤销租约，热键与离席会 | §10.14 Lease 状态表与撤销开关、E15、A29、A33 |
| CU-16 | 租约期间 UI 浏览器来到前台并发出 approve → 409，租约撤销 | E5、R44、A29；若 Q-DC1 允许只 look 的租约不冻结 UI，则需改写 |
| CU-19 | 没有 `active` 租约时每个桌面工具都返回 `no-lease`；没有驾驭器进程在跑 | §10.16 配方、R52 |
| CU-21 | 只在 `structuredContent` 里的 `effect: unverifiable` 与拒绝 `code` 到达模型的文本，`isError` 时亦然；Exchange 记 `unknown-outcome` | A31、A39、R54 |
| CU-23 | 调用中的假锁屏 → 0 个驾驭器、0 次后续调用、不重放 | A33、R55 |
| CU-24 | Invoke 中 `kill-tree` → 0 个驾驭器且目标保持 enabled；host 存活；在途写入 → `unknown-outcome`；杀掉代理或 host → 0 个驾驭器、`lost` | A37、R60、§10.14 租约动作表 |
| CU-25 | 两个桌面侦察乐手：独立 host，一个 `active` 一个 `queued`；一次 `session/new`，没有 `session/resume`；没有 `subagent`、`subagent_fork` 或 `workflow` 工具；host 之外或 nonce 错误的 `orchestra-desktop` 得到 `no-lease` | A38、E15、R59 |
| CU-26 | 复制的 exe、复用的 pid、Windows Terminal（按 AUMID）、或允许 Calculator 时的 Settings 都被拒；manifest 在 0.37.0 下解析通过且没有 `display` | A35、Q-DC2、R52 |
| CU-27 | 驾驭器的 argv、env 与 manifest 与 §10.16 的配方完全一致 | R52、R57 |
| CU-28 | 存在 `serve` 任务或管道即阻止授予，P1；管道上放一个假守护进程时，驾驭器仍直连运行，守护进程收到 0 次调用 | R52（`--direct`）、R58 |

### F.4 M4

以 S-CU 显示足够的写投递为前提（Tier 2 已定；桌面 `act`，+1 周，路线由 Q-DC7 决定）：

| 编号 | 用例 | 关联 |
|---|---|---|
| CU-20 | 代理拒绝的一切（前台投递、x/y、非单次左键或 WPF / Tk / GTK 窗口上的点击、含 `urls` 的 `launch_app`、其余列出的工具）都在派发前被拒；`windows_targeted_injection` 结果 → `suspended`、P1 | A34、§10.16 配方 |
| CU-22 | 批准元素 E 之后：label 或 frame 变化 → `stale-approval`；同 label 的兄弟移进 E 的 frame → `ambiguous-target`，0 次执行；参数变化或步骤乱序 → 拒绝；无关的重绘无害 | A32、R45 桌面绑定 |
| CU-29 | 桌面计划只能从配对 UI 批准，绝不在租约 `active` 时；计划外的步骤重复 10 次 → 0 次执行、1 条 P2 `flood` | E5、Q-DC7、§8.6 粘性拒绝 |
| CU-30 | 一次超过代理截止的写入，然后重试：1 次执行、1 个 `unknown-outcome` | E12、R54 |

随 Codex 乐手落地（Q1，最早 M4；推断）：

| 编号 | 用例 | 关联 |
|---|---|---|
| CU-15 | 自有 Codex 的 elicitation 永不选「always」 | E13 |

### F.5 M6 Arrangement（M4 后 go/no-go）

| 编号 | 用例 | 关联 |
|---|---|---|
| WF-1 | 5 次调用中 3 次已回复时杀掉守护进程：重跑对这 3 次 0 次新投递，在途调用绝不重发 | §8.8 (b) 重放、§8.3 重启规则 |
| WF-2 | 循环里的同一调用两次得到两个不同的 `requestId` | (b) `requestId = arr:<lineageId>:<path>#<occurrence>` |
| WF-3 | 脚本触碰 `Date.now`、`require('fs')`、`fetch` 或 `process` 即失败关闭（`ARRANGEMENT_NONDETERMINISTIC` 或沙箱错误） | (a) WASM 沙箱 |
| WF-4 | 重放在某个 seq / path 发出变了的调用 → `ARRANGEMENT_DIVERGENCE` 停止，0 次投递 | (b) 分歧检查 |
| WF-5（v1） | 乱序完成的 `pipeline` 与基于 `budget.remaining()` 的分支，在 kill 之后重放结果一致 | (b) 重放 v1 |
| WF-6 | `parallel` 中有一次超时 → `[a, null, c]`，结果 `timedOut`；卡在接纳里的调用从接纳请求起计超时 | (c) 连接与截止 |
| WF-7（v1） | 一个被拒、一个成功的 `race` 返回成功者；全部失败 → `allFailed` | (c) `race` |
| WF-8 | `cny(1)` 触发暂停并出 P1 条目，不再投递；同一阈值三次越线 → 一个事件 | (e) 预算、A14 |
| WF-9 | 30 个并行调用、`perHarness=4` → 在途 ≤4，0 次失败 | (e) governor 接纳 |
| WF-10 | 永远打回的评审者：3 轮后升级；连续三轮无进展触发 `stall(3)` | (d) 终止、A9、§10.7 |
| WF-11 | 同一 schema 在假 Claude、mock DSH、假 Codex 上都校验通过；畸形 JSON 得到一次修复回合 | (g) 跨 harness |
| WF-12 | 污染的输入或 agent 编写的脚本 → 污染的 Exchange | (f) `authoredBy`、§8.5 taint |
| WF-13 | 没有任何 worker 提示词把触发的人类文本当指令携带；每个信封都带 `trust:runtime`（CC#96640 fixture） | (f)、R34、D15 |
| WF-14 | DSH 模板 worker 的 `request_permission` 被自动拒绝；脚本看到 `denied`；每次运行恰好 1 条 InboxItem | (f) 模板审批、§10.9、Q-W2 |
| WF-15（`ask()` 部分为 v1） | `ask()` 跨重启存活；经 MCP 解决它被拒绝。被清除的钉住结果让运行 `unresumable` | (f) `ask()`、(b) 结果存储 |
| WF-18（v1） | 投递给 DSH 的 Arrangement 不产生 `goal/change`；没有 relay-source bundle 的 DSH `to:` 目标被拒绝 | (a) `to:`、§8.5 |

### F.6 里程碑随 Q-DC 决定

| 编号 | 用例 | 关联 |
|---|---|---|
| CU-18 | 侦察乐手配置精确钉 0.2.1-rc.2、关闭委派行、没有原生 provider 或 `allowedApps`、模型声明图片输入 | §7.4 DSH 侦察预设、R56、A36（M3，随 Tier 2 look）；只在 Q-DC0 选 DSH 宿主时适用（Tier 2 已定） |
