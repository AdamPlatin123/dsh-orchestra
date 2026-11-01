# DeepSeek Super-agent 调研与对照（2026-10-31）

> 2026-11-01 更新：深读原型后，本文有 26 处说法被更正（如 `inject` 并不写进历史、SA-4 并无「唤醒优先」、在线改规则的能力在 Router 身上而非 Watchdog），见 `2026-11-01-zen-superagent-deep-read.md` §5；三方总览见 `2026-11-01-zen-superagent-spawn-overview.md`。本文正文未改。

DeepSeek Harness 团队 2026-10-31 晚发布了技术文章《Super-agent 设计探索：迈向更自主的 Agent 系统》，同时开源了原型 `deepseek-ai/dsh-superagent-prototype`。本文说清三件事：它是什么，和 Orchestra r4 哪里一样、哪里不一样，我们的规划要不要因此调整。

**方法。**
- 原型：用 `gh api` 只读了 main@6337fc8（只有一次提交）的 README、SETUP、`docs/` 下 9 篇设计文档、全部提示词，以及约 12 个关键源码文件。没有克隆、安装或运行。
- 文章：原文在微信公众号，抓取时被验证页挡住。内容由一个 Opus 代理从 9 篇媒体报道里重建，其中 8 篇读到了，主要依据智东西逐节的转述。只有一个来源支持的说法标「单源」。
- DSH：核对了 `deepseek-ai/deepseek-harness` 的 v0.2.2-alpha.2 发布说明。

结论先行：

1. **它和我们在解同一道题，各解一半。**
   - 共同的判断：多任务的上限不在模型，在人的注意力。这和 r4 §2.2「瓶颈在会话之间的依赖」是同一个判断。
   - Super-agent 是**一个团队在 DSH 上的主动式同事**：外部事件进来，它自己接活，回到 GitHub 或飞书里交付。
   - Orchestra 是**一个人在三家 harness 上的指挥台**：你开会话、许愿，收件箱只在需要你时找你。
   - 所以它不是竞品，更像互补。
2. **骨架高度同构。** 对应关系：Router 对主代理 / Maestro，Worker 对乐手，Thread 订阅直通对邮局的自动回信，Mandate 对愿望契约，「先存后做」对 journal 单写者，面板的三个问题对 Program 收件箱。约束相同，推出的结构也相同，文章自己也这么说。这说明我们的方向没有跑偏。
3. **关键差别在安全和自治，这四点不照搬：**
   - 执行器在 `danger-full-access` 下运行，没有审批，和你是同一个 OS 用户；
   - 主动接活有 `auto` 档；
   - 文章里的 Watchdog 是一个能在线改主系统提示词和触发规则的 LLM 会话；
   - 「完成」由执行器自报 `ready`，再由人审 PR。

   它们依次冲突的是：
   - D8：审批、拍板、刹车只有你能做，只有一个审批队列，超时即拒；
   - D20：默认有人值守，你不在时不派新活，无人值守要等 v1 之后由你逐项目开启；
   - 原则 2：人是唯一的权威；§3.2：agent 不能自己建乐手或例程，规则 11 又规定绝不自动重新规划；
   - D19：任何 agent 都不能宣布完成，完成只来自非作者复核者的判定或你的验收。
4. **对我们最直接有用的是原型的 `src/app/delivery.ts`。** 这约 90 行由 DSH 团队自己写，在专用 DSH profile 的 bundle 里运行，做三件事：
   - 以自定义的非 user 来源投递；
   - 支持 queue、steer、inject 三种模式；
   - 跨重启幂等。

   这正是 r4 §8.5 写的 DSH 侧目标形态，也是 S2 清单 ①②⑥ 要验证的内容。它还是 D5 候选 B（私有 `dsh web` + bundle）可行的强证据。
5. **规划上主线不动，M0 照常推进。** 建议做三件不需要你拍板的小事，另有三个新问题等你定（§六）。

---

## 一、Super-agent 是什么

### 1.1 文章（据媒体转述重建）

- **动机。**
  - 单任务的上限取决于模型，多任务的上限取决于人的注意力。团队观察到，一个人通常只能同时跟进 3–5 个活跃 Session。
  - 单 Session 的毛病是同步阻塞、上下文混乱、设备一离线就停。
  - 把所有事件塞进一个会话会被串行拖慢；每个事件开一个会话，结果又会割裂、多头回复。
  - 他们要的四个特征：连续、高效、主动、持久。
- **五个模块。**
  1. **双层架构。**
     - **Router**：常驻，接住所有人类交互，统一对外回复。它不执行任务，可以不配 Bash，用较轻的模型。单源说法：它是全局的序点、协调点和记忆。
     - **Worker**：上下文彼此隔离，挂完整工具，用最强的模型。它只向 Router 汇报，内部可以再起 subagent。同层 Worker 一般不直接通信（单源）。
     - 「Session 应成为系统实现细节」。
  2. **事件驱动。**
     - 信道：群聊、邮件、日程提醒、代码审查和 GitHub 评论、CI 结果。
     - 每个事件过四步：过滤 → 路由 → 上下文组织 → 投机执行。
     - 过滤分两级：程序层先按白名单和来源规则准入，语义层再由 LLM 按提示词里的策略判断。
     - Worker 订阅 Thread（同一个 PR、IM 话题或邮件串），后续事件由程序直接发给它，不经过 Router。
     - 上下文当缓存管理，用 Inline & Spill：先只给 ID 和摘要，再按局部性内联相邻内容，超长部分截断并留续读入口；ID 构成一张可逐跳展开的引用图（单源）。
  3. **异步多信道交互。**
     - 同步的 `run()` 改成异步的 `start()/stop()`，结果作为一条新事件投递回会话。这一机制**已在 DSH 里实现，但默认关闭**（多源）。
     - IM 低打扰，单次回复不超过 100 词（单源）；GitHub、邮件走结构化的高密度交付。
  4. **存算分离。** Loop 放云端，会话状态放数据库，执行环境留在用户机器上（BYOM），本地只跑一个轻量 daemon。设备离线时，等它回来再继续。文章称这与 Anthropic「脑手分离」的思路一致。
  5. **外部 Watchdog。** 一个独立的 Watchdog Session，由定时消息驱动，检查 Worker 有没有实质进展、是否陷入循环，也处理基础设施故障。维护者可以用自然语言问它，或让它在线修改主系统，例如增删提示词、调整触发规则（单源）。
- **主动性。**
  - 投机执行，即「静默复现并修复」：有人在群里反馈问题时先在后台复现，确认问题存在、并找到简单修复后才出声，否则全程沉默。
  - 个人助手的例子：收到会议邀约，先核对日程、起草回复，等用户确认。
- **实验。**
  - 设置：用群聊加 GitHub CI 消息流驱动，每轮约 300 条消息，其中约 20 条是真请求；编码换成只消耗时间的模拟工具；每种方案跑 5 次。

  | 方案 | 结果 |
  |---|---|
  | Super-agent | p50 12.4 min，p95 15.7 min |
  | 单 Session，中性提示 | 5 次里一次都没委派，p95 29.5 min |
  | 单 Session，优先委派提示 | 5 次里委派 4 次，仍慢于 Super-agent（剩下一次模型判断活「很小」自己做了，形成长尾） |
  | 去掉订阅直通 | 完成时间基本不变；Router 决策约多 30%，读缓存 token 从 2,323 万增到 3,177 万（约 +37%） |
  | Router 批处理压测（Worker 用 mock） | 到达速率从约 1 条/分升到 40 条/分：单次耗时 2.5 → 3.9 s；平均 batch 1.0 → 2.8，每个决定分摊的推理时间 6.4 → 1.6 s（后两项单源） |

  - 代价：维护多个会话，token 比单 Session 多，等于拿 token 换时间和稳定性。
  - 他们承认的局限：负载是合成的，环境是简化的，没有评估真实编码质量。
- **开放问题。**
  1. 单个 Router 不够时怎么切分，跨月的长期记忆怎么做；
  2. 脱离 Session 之后人怎么介入、接管；
  3. 组织扩大后的上下文边界，以及多个隔离实例之间的 A2A；
  4. 云端 Agent 接触端侧凭据带来的入侵和注入风险，要做到「不接触凭据本身也能使用凭据」（单源）。
- **内部使用。** 文章自述，基于 DSH 的内部实例已在持续运行，日常参与问题复现与修复、代码审查，以及 DSH 自身的迭代。

### 1.2 开源原型 `dsh-superagent-prototype`

- **元数据。**
  - MIT，TypeScript。仓库建于 2026-10-31T09:32Z，12:05Z 推送了唯一一次提交，当晚约 2,100 星。
  - README 自述：研究原型，不是官方产品；大量代码由 coding agent 写；与内部版本和文章不完全一致，部分设计属于未来方向。
  - 文章里的 LLM Watchdog、投机执行、存算分离在仓库里都找不到，全仓库没有出现 `watchdog` 一词。
- **形态。**
  - 一个 DSH bundle（`cordis.patch.yml`）跑在专用 profile `superagent` 里，用 tmux 启动，面板挂在 DSH Web 的侧边栏。
  - 一个部署对应一个 GitHub 仓库，飞书可选。
  - 依赖 Node 22.19+、pnpm、git、Python 3.8+、tmux、`gh`。在 Windows 原生能否运行未核实，tmux 一项多半要 WSL（推断）。
- **领域模型（001）。**
  - 流程：Source → Trigger → Thread → Eval（确定性 gate + 模型 assessment）→ Decision（accept / stop / ignore / unavailable）→ 带 Mandate 的 Ticket → Assignment → Executor；结果经 Channel 回写到 Source。
  - Subscription 把 Thread 上的后续消息扇出给已订阅的 Ticket，只当上下文，不带授权。
  - 「人」不是领域概念，只是 Trigger 上的元数据；跨 Source 的身份映射写在提示词里。
  - 他们还列了一张「被否决的概念」表，很值得读，例如：不推断「在等人」，必须走结构化字段；执行器不能声称「人叫我停」；Ticket 的状态不跟随 DSH 会话。
- **授权（002）。**
  - 输入：允许名单、准入表（接收范围 × 发送者是否在名单上 × 是否在叫 agent）、bot 名单。
  - 强度分 explicit 和 inferred。接单模式有 `off`、`observe`、`auto` 三档，**默认 `observe`**：只记一条「本来会接」，不真接。
  - Policy 有版本号。版本变了，在跑的 Eval 作废重排；受影响的 Ticket 只收到通知，不会被取消；恢复前按当前 Policy 重新校验。
  - Mandate 不可变，范围变大就开新 Ticket。改变 Mandate 的只有三种操作：accept 创建它，人的 stop 撤回它，重新校验失败吊销它。
  - Ticket 结束时，执行器没读、没回、没交还的人的后续消息退回 Eval。
- **执行（003）。**
  - 每个 Ticket 一个 DSH 会话 `worker-<id>`，加一个目录。目录由 prepare 命令准备，通常是 `git worktree`。
  - worker 预设里，前台命令超过 5 s 就转成后台 job，这样新消息在下一步就能接收。
  - 一回合结束时，如果还有 job 或 subagent 在跑，就不报 waiting，Ticket 继续占着槽；它们完成后在同一个槽里唤醒执行器。每回合之后，后台工作最多再跑 30 min。
  - 并发槽之外，**给人的消息额外留一个槽**，唤醒优先于新启动。
  - 所有动作先存后做（effect 表），失败按 2 s 起翻倍退避、最长 1 min 重试。
  - 瞬时故障重试 3 次。重启后带「恢复说明」重跑：先查目录、git 历史和 GitHub，再决定要不要重复外部动作。
  - 可以暂停处理。外发消息按 Ticket 保持顺序，丢弃时记下原因。
  - 自动合并默认不开；开了也要求：PR 是为这个 Ticket 开的、审批覆盖最新 commit、增删合计少于 200 行。
- **面板（005）。**
  - 三个问题，按顺序：现在有没有要我管的？系统健康吗？某件工作的来龙去脉是什么？
  - 七条原则，包括：计数必须等于它链接到的列表长度；健康状态不占空间；一个概念只在一个地方出现；标签写「在等谁、要什么」，不写内部状态码。
- **沟通规范（`prompts/team/communication.md`）。**
  - IM 默认一句话，确认不超过 100 词。只在三种情况下说话：结果可用、需要人做什么、确定做不到。
  - 发送前逐句自问：删掉这句会不会妨碍对方理解或行动？不会就删。
  - GitHub 上每条消息的第一行都声明「这是自动代理，不是人」。
- **运维（006）。**
  - 外部的「小时检查」放在**另一个** DSH profile 里，按 `status` 的退出码处理：0 不说话；1 重启；2 和 3 报告给人。`--respect-stop` 保留人为的停止。
  - 管理 API 只靠 `x-orchestrator-request` 头加 Origin 校验，**agent 也能调用，而且权限与面板相同**。
- **他们自己写下的缺口（007 Open questions）。**
  - 哪些 Trigger 字段可信，没定；
  - 部署隔离（钉死 DSH 安装）没定；
  - 记录只增不删；
  - 工作目录和命令黑名单不是安全边界。

### 1.3 和 DSH 本体的关系

- **版本。** peer 依赖是 `@deepseek-ai/*` ^0.2.1-alpha.2 和 `@deepseek-ai/cordis` 4.0.5-alpha.1。DSH 的最新发布是 v0.2.1-rc.5（10-30）和 v0.2.2-alpha.2（10-28）。
- **用到的进程内接口。**
  - `sessionController.create` / `resolveAgent` / `rename`、`workspaceRegistry.create`；
  - `agent.followup` / `steer` / `inject` / `cancel({kind:'user'}, {keepInbox})`；
  - 事件：`agent/created`、`agent/status`、`agent/error`、`agent/inbox/claimed`、`agent/disposed`、`session/event`、`agent-preset/selected`；
  - `sessionPersistence.open/read/flush`；
  - 通过 `MessageSourceMap` 模块扩展注册自己的消息来源 `{kind:'dsh-superagent', form:'relay'|'notice'}`。
- **`subagent_oar` 和它无关。** 媒体把 DSH 0.2.2-alpha.2 里「实验性 `subagent_oar` 工具插件，可把独立任务交给本机 Codex 或 Claude CLI」和 Super-agent 混在一起报道。这个插件就是 OAR，r4 §7.4 已经把它排除在私有 home 之外（见 `oar-assessment.md`），与 Super-agent 无关。

---

## 二、相同之处

| 维度 | Super-agent | Orchestra r4 |
|---|---|---|
| 问题判断 | 多任务上限是人的注意力；人一次只能跟 3–5 个会话 | §1.1、§2.2：切换会话耗尽注意力；A2A 是多任务的前提 |
| 协调者不干活 | Router 只路由和回复，可以不配 Bash | 主代理乐手（M1–M3）；Maestro =「不写代码的乐手」（M4） |
| 干活的彼此隔离 | Worker 各自一个会话和目录，不直接对人 | 乐手各自的乐章；分身不可寻址（D2、D14） |
| 身份比会话长寿 | Ticket 自定状态，不跟随 DSH 会话；会话是实现细节 | 乐手 ≠ 乐章（D2）；地址重解析到当前乐章 |
| 后续消息直通 | Worker 订阅 Thread，后续事件不经 Router | 回复自动送回提问者（§8.3 规则 1）；邮件寄给乐手，乐章释放后仍送达（A2） |
| 低打扰 | 只在结果可用、要人决定、做不到时说话；健康状态不占空间 | D16 沉默有效；收件箱只放 fermata 和 wrong note |
| 一次一个结构化问题 | Attention 走结构化字段，不从报告的自由文本里推断 | fermata 卡、澄清卡（每问附推荐答案） |
| 消息不带权限 | 消息、评论、引用的文档改不了名单和规则 | §8.5「消息不携带任何权限」，D15 |
| 先观察后执行 | `observe` 默认，只记「本来会接」 | Maestro 影子模式（D9）；愿望的影子级（D20） |
| 先存后做、幂等 | effect 表；确定性 MessageId；重启不重复投递 | 原则 8 单写者、可重放、结果不明不重发；`requestId` 幂等 |
| 重启后小心 | 带恢复说明重跑，先查再做外部动作 | 重启后愿望停着等你点继续；在途回合按投递阶段处理（§8.3） |
| 规则变了不砍活 | 只通知受影响的 Ticket，恢复前重新校验 | 规则 11 不自动重新规划；Decision 注入新乐章 |
| 看门狗 | 外部 Watchdog（文章）；小时检查（原型） | governor、runaway、reaper、场务刹车（§10） |
| 面板只给人看要紧的 | 三个问题；计数等于列表长度；标签写「在等谁、要什么」 | Program 注意力收件箱；眼图准则（状态无歧义、余量可测） |
| 工作树 | prepare 命令建 `git worktree` | M3 worktree（Q7 = 按需，代定） |

## 三、不同之处

| 维度 | Super-agent | Orchestra r4 | 对我们的含义 |
|---|---|---|---|
| 服务对象 | 一个团队、一个仓库，以 bot 账号对外 | 一个人、多个项目 | 场景不同，不冲突 |
| 入口 | 外部事件流（GitHub、飞书；文章还有邮件、日历、CI） | 你开的会话，以及你在 Orchestra 里新建的乐手；外部消息只能经默认关闭的 A2A 1.0 网关进来 | 见 Q-SA2 |
| harness | 只有 DSH（加 DSH subagent） | Claude、DSH、Codex 三家，跨家 A2A 是核心 | 他们不碰跨家问题 |
| Worker 之间 | 一般不直接通信，冲突靠共同订阅 Thread 发现，由 Router 中转 | A2A 是第一支柱，邮局有跳数、转发、截止时间上限 | 我们多出来的正是他们的开放问题 3 |
| 主动性 | 没人 @ 也接活（投机执行）；`auto` 档 | v1 不做无人值守；agent 不能建乐手或愿望；你不在时不派新活 | 不照搬 |
| 审批与隔离 | 执行器无审批、`danger-full-access`、同一 OS 用户；他们自己承认「不是安全边界」 | D8 唯一审批队列、超时即拒；Job Object；写围栏；隔离 profile | 不照搬 |
| 本机 API | 管理 API 靠请求头加 Origin，agent 能调，权限与面板相同 | D3 / D8 明确否决「只靠 token + Origin 的 loopback 守卫」；人类动词只挂在配对 cookie 的监听器上 | 正好是 D8 理由里的反例 |
| 完成 | 执行器报 `ready` → 人审 PR；人把住合并 | D19：非作者复核的 Verdict 加你验收；agent 自报不算 | 他们靠「人审 PR」兜底，我们靠判定 |
| 路由判断 | 确定性 gate 在前，之后路由全由 LLM 会话完成 | D9：规则 → router-core → LLM 兜底，先影子 | 差距比看上去小 |
| 看门狗 | LLM 会话，可以在线改主系统的提示词和触发规则 | 确定性检测器加人点刹车；人是唯一的权威（原则 2），agent 不能自建乐手或例程（§3.2） | 不照搬 |
| 部署 | 文章方向：云端 Loop + 数据库 + 本地无状态 daemon；原型仍是单机单进程 | 本地、loopback、单用户；不做云端（§3.2） | 不照搬；「离线就等它回来」的精神相同 |
| 预算 | 明说拿 token 换时间，没有预算机制 | 5 档预算、token 包络；不设钱的上限，但账本计量 | — |
| computer use | 没有 | 第三支柱（乐器模型） | — |
| 存储 | 一个 SQLite（JSON 加生成列），只增不删，没有哈希链 | `node:sqlite` 加 journal 哈希链摘要，片段可清除 | — |
| 成熟度 | 研究原型，一次提交；内部实例真实在跑（自述） | M0 编码中（step 3 已提交），还没有运行实例 | 他们有运行数据，我们没有 |

---

## 四、可以借什么（按里程碑）

| # | 内容 | 落点 | 性质 |
|---|---|---|---|
| SA-1 | **DSH 投递的参考实现**（`src/app/delivery.ts`）：①用 `MessageSourceMap` 扩展出自己的来源 `{kind, form:'relay'\|'notice'}`，DSH 就不会把它当成人写的；②三种模式：`followup` = queue（下一回合）、`steer`（下一步）、`inject` = 写进历史但不唤醒，正好对应 D16 里 `wake:none` 的 notice；③确定性 `MessageId` 加扫描持久化历史和 inbox，做到跨重启至多一次；④`sessionPersistence.flush()` 之后才回执。 | M1 S2 ①②⑥；§8.2 DSH 候选 B 行；§8.5 对策 | 证据 + 代码参考 |
| SA-2 | **乐手预设里前台命令短超时**：worker 预设前台命令 5 s 转后台 job，steer 消息在下一步就能接收；主会话禁止 `sleep` 和长等待（`noWait` 守卫）。他们指出，standard 预设的前台 60 s 和 job 等待 30 s 会把一步卡住。 | §7.4 私有 home 的 DSH 乐手与主代理预设；§8.2 steer 时延 | 设计 |
| SA-3 | **后台工作与回合结束**：回合结束时还有 job 或 subagent 就不算等待；它们完成后在同一个槽里唤醒；每回合后最多 30 min；交给人之后释放槽。 | §8.3 规则 1（自动回信只在没有后台工作的回合结束时生成）；S2 ⑲、S3「回合结束时的后台任务数」 | 设计 |
| SA-4 | **给人的消息预留执行槽**：并发上限外再留 1 个槽给人的消息，唤醒优先于新启动，新活永远挤不掉你对已有乐手说的话。r4 §10.2 里没找到这一条。 | §10.2 Governor（M2） | 新增行为 |
| SA-5 | **Mandate 规则**：不可变；范围变大开新单；规则变了只通知、恢复前重新校验；执行器不能声称「人叫我停」；结束时没读、没回的后续消息退回分派。最后一条可以对照 r4：乐章或 Task 结束时，没被处理的 request 去哪里（r4 只写了「乐章释放后仍送达」，没写「读了但没回」的情况，推断）。 | §6.3 Exchange、§8.9 WishContract 版本 | 设计 |
| SA-6 | **状态表与面板原则**：阶段表「从上往下第一条命中」，互斥且覆盖所有情况；计数等于列表长度；健康状态不占空间；一个概念一个地方。 | M0 step 4/5 的 UI 验收清单；`ui-interaction-design.md` | 设计 |
| SA-7 | **对人说话的规范**：一句话、确认不超过 100 词、只在三种情况下开口、逐句「删掉会妨碍吗？」 | 主代理乐手和 QA 乐手的系统提示（M1）；满足你「说人话」的要求 | 设计 |
| SA-8 | **Router 批处理与上下文**：一个常驻 Router 会话对一个团队够用；批量注入候选时，每个决定的摊销时间随 batch 下降。Inline & Spill 与我们 step 3 的 detail 端点、`{key,args}` 标题是同一思路。 | §9 Maestro（M4） | 证据 |
| SA-9 | **零编码成本的实验方法**：合成消息流（约 300 条里约 20 条真请求）、只耗时间的 mock 工具、每方案 5 次，看 p50/p95 完成时间和读缓存 token。 | §14 评估：M4 Maestro 影子评估、Post Office 压测 | 方法 |
| SA-10 | **守护进程自身的外部存活检查**：放在被监视进程之外，按 `status` 退出码 0/1/2/3 决定沉默、重启或报告，保留人为停止。r4 有「守护进程崩了不留孤儿」（Job），但没写「谁发现它崩了、谁拉起来」（我在 r4 里没找到）。 | §5.3 运行时；可以用 Windows 计划任务调用 `orchestra status`（推断） | 新增行为 |

## 五、不照搬什么（与已定规则冲突）

- **无审批、`danger-full-access`、agent 可调的管理 API**：与 D8 冲突。
- **主动接活的 `auto` 档、投机执行**：与 §3.2「v1 不做无人值守」和 D20 冲突。`observe` 的思路我们已经有了（影子）。
- **能在线改提示词和规则的 LLM Watchdog**：与两处冲突。一是原则 2（人是唯一的权威）和 §3.2（agent 不能自己建乐手或例程，只能提类型化请求由你批准）。二是邮局规则 11：委托停滞时只唤醒提问者一次，绝不自动重新规划。A6（每个乐手的入站策略只有人能改）是同一精神，但它只管入站消息，严格说只是类比。检测器保持确定性。
- **执行器自报 `ready` 就算完成**：与 D19 冲突。
- **存算分离到云**：与 §3.2「不做云端或多租户」冲突。
- **准入主要靠 LLM**：D9 规则优先。不过他们也是确定性 gate 在前，差距没有标题看起来那么大。

---

## 六、对规划的建议

**不变的部分。** M0 主线、r4 架构和全部已定决策都不动。Super-agent 不改变「先看见、再对话」的顺序。它最大的价值是给我们的几处推断提供了 DSH 官方的实证，而不是给出新方向。

**现在就能做（研究和测试项，不改规格、不需要你拍板）：**

1. **S2 准备。** 把 SA-1、SA-2、SA-3 写进 S2 测试脚本草案（M1 第 1 周）。候选 B 照 `delivery.ts` 的方式做一个最小 bundle 来打分；建议给 S2 清单补一项 ⑳：`inject`（写进历史、不唤醒）能不能用，它在 settle 和回执上怎么表现。如果 B 在这几项上占优，「relay 来源」可以从 M3 提前到 M1（推断，以 S2 结果为准）。默认只借设计、不抄代码；真要引用 MIT 代码，需在 NOTICE 的第三方段落写明 MIT 声明。
2. **上游台账。** 跟踪 DSH 的异步 `start()/stop()`（已实现、默认关闭）。它一旦默认打开，DSH 乐章的 settle 语义和自动回信的时机就会变（§8.3 规则 1），到时要加契约测试。
3. **观察面。** 如果你在本机跑 dsh-superagent，它是一个专用的 DSH profile，worker 会话叫 `worker-<ticket id>`。M0 观察器会把它们当成只读的 DSH 会话显示，应当像 DS-Bot 一样标成 foreign-held（推断，取决于它的 `DSH_HOME`）。

**要你定的新问题（还没写进 r4）：**

- **Q-SA1：r4 要不要吸收 SA-1 到 SA-10？**
  - 建议：按既有的决策传播流程作为「第七批」并入，只加文字和证据，不改任何已定值。
  - 其中 SA-4（给人的消息预留槽）和 SA-10（守护进程自检）是新增行为，要你点头。
- **Q-SA2：要不要把外部事件源（GitHub PR 评论、CI 结果、飞书）纳入规划？**
  - 建议 v1 不做。M3 之后作为可选 Source，先只接 CI 结果，作为愿望的类型化事件，标 `external` 加 taint，只进收件箱；M4 再评估。
  - 理由：外部事件是 Super-agent 的核心，但不在你的四个支柱里，而且会带来新的提示注入面。
- **Q-SA3：dsh-superagent 要不要成为一个「声部」，像 DS-Bot 那样经 API 对接？**
  - 建议先不。它的管理 API 安全模型很弱（agent 可调，权限与面板相同），而且还是原型；等它变成产品再看。

## 七、未核实与局限

- 文章原文没有直接读到。数字和细节来自媒体转述，以智东西为主，只有一个来源的已标「单源」。媒体标题里的「效率翻倍」是媒体自己的说法。
- 原型只读了文档和约 12 个源文件，没有运行。「内部持续运行」是文章的自述。
- 原型在 Windows 原生能否运行（tmux、Python）未核实。
- 原型与内部版本、与文章都不完全一致（README 自述），所以「文章有、原型没有」不代表他们内部没有。

## 来源

- 原型仓库：https://github.com/deepseek-ai/dsh-superagent-prototype（main@6337fc8；README、SETUP、docs/000–008、prompts/、src/app/delivery.ts、src/app/sessions.ts、src/executor/dsh.ts、cordis.patch.yml）
- DSH 发布说明：https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2
- 文章原文（微信，抓取被验证页拦截）：https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg
- 媒体报道：
  - 澎湃 / 第一财经：https://www.thepaper.cn/newsDetail_forward_34379035
  - 智东西（网易）：https://www.163.com/dy/article/LAK152S2051180F7.html
  - APPSO（53AI）：https://www.53ai.com/news/LargeLanguageModel/2026103145736.html
  - InfoQ（新浪）：https://finance.sina.com.cn/roll/2026-10-31/doc-inixcwwm7186478.shtml
  - 什么值得买：https://post.smzdm.com/p/a3m4exwr/ 、https://post.smzdm.com/p/a264w4en/
  - BigGo：https://finance.biggo.com/news/ccf3ef75-c371-43e4-a87d-dfbcf203c450
  - AlphaSignal：https://alphasignal.ai/news/deepseek-releases-a-silent-coding-agent-that-works-without-bothering-you
