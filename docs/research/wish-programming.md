# 许愿式编程：长程任务的自动规划与可靠推进

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-27 |
| 状态 | 综合稿（立场文件），红队第 1、2 轮已修订（见文末 Review log）；不修改 r3，对 r3 的修订见本文 §7.4 |
| 依据 | 四份原始报告 [W1]–[W4]；r3 规格 `docs/specs/2026-10-27-dsh-orchestra-design-r3.md`（下称 [spec]） |
| 工期口径 | 在 r3 含 Tier 2 的约 33–35.5 周基准上加算，全部为推断（本文 §8） |

**证据键**
- [W1] = [wish-harness.md](wish-harness.md)：Claude Code（CC-GOAL、CC-HOOKS、CC-WF、CC-SDK、CC-BIN）、DSH（`DSH:` 前缀，0.2.1-rc.2 本机安装）、Codex（`CX@aa854da`、CX-BIND、CX-CB）。
- [W2] = [wish-frameworks.md](wish-frameworks.md)：MO、MAF、OH、MSA / SWA、AID、DV、PC（`PC#` 为其 issue）、LC、GB、OC、HA / HU、DSB。
- [W3] = [wish-reliability.md](wish-reliability.md)：METR-*、OSW2、SWEPRO、TAU / TAU2、TAC、MAST、ILL、LOST、VB、SCALE、IMP、PD、SELF、KAM、SP、A-*（Anthropic 工程博客）、OAI-PLANS、OAI-ATLAS（未核实）、CUR、TMP、G-RES、META2。
- [W4] = [wish-community.md](wish-community.md)：CC#、CX#、DSH-D#、DSB#、OH#、OC#、ZC、V2EX t/。
- 沿用 r3 的约定：四份报告内部的证据键只作括注保留，原始出处见各报告的证据表。所有 issue / discussion 都是报告者的陈述，本文没有复现；其中的 token、金额、时长是报告者自己的数字。
- **综合者于 2026-10-27 复核过的**：CC-GOAL 重新抓取（评估器不调工具；恢复时回合数、计时、token 基线清零；回访首次 30 min、之后间隔加倍、最长为首次的 4 倍，即 1 h 后每 2 h 一次；两次提示之间最多 3 次空闲回访；非交互会话只在回合结束时送达回访，自动重试只在交互会话）；DSH 本机行 `dsh-goal-round-driver/README.md:57`、`dsh-tool-goal/README.md:48-55`、`dsh-tool-goal/lib/index.js:196`、`dsh-experimental-ralph-bundle/cordis.patch.yml:16`、`dsh-base/cordis.patch.yml:336`、`dsh-goal/README.md:158-159`；GB 模板 `goal_strategist_prompt.md:27`、`goal_verifier_prompt.md:17,46`（研究者克隆）。其余没有重新抓取。红队两轮修订者另行复核的出处（goal.md、hooks-guide、agent-sdk/agent-loop.md、sandboxing.md、arXiv 2510.20270 与 2503.13657、六个 issue、Codex rust-v0.160.1 标签、DS-Bot `parts.js`、DSH `dsh-agent-loop` 与 `dsh-tool-jobs`）见文末 Review log。
- 章节引用：不带前缀的 §x 指 r3；本文自己的章节写作「本文 §x」；[W1] §x 等指原始报告的章节。
- 标注：（推断）是本文的推理；（假设）是没有证据的默认值；（未核实）是原始报告也没能确认的内容。

---

## 1. 立场

1. **许愿式编程在 Orchestra 里是一个「愿望」（Wish）实体，不是新的 agent loop。** 愿望 = 你的原话 + 冻结的验收契约 + 一棵 Task 树 + 预算 + 一个由守护进程推进的状态机。它挂在一个 `rootId` 上：成本按这棵树上卷（[spec] §6.1、§10.2），拒绝记录沿用 A5（§8.5，M2），整树停止是本文 §6.7 新增。任何模型都不掌握「完成」和「终止」。v1 的愿望只属于一个项目，跨项目的愿望拆成各项目各一个（本文 §6.11）。
2. **「完成」是判定，不是声明。** 任何 agent（不止执行者）都不能把 Task 推到 `done`，也不能改它的验收条款（本文 §7.4 的 §8.6 行）。Task 的 `done` 只来自两处：非作者复核者给出的 Verdict，其中 gating 结果由守护进程从复核者自己的工具调用 Event 取证；或你的点击。愿望的 `done` 永远要你验收。判定器出错、超时、Verdict 的结构化字段自相矛盾（例如 `result: pass` 而某条 gating 结果不是 accepted，本文 §6.5），一律记 `unknown`，不算通过。依据：三家 harness 默认都是自报或只读对话记录的评审（[W1] §1），社区里的假完成造成过生产事故（CC#104037）。
3. **按事件推进，不按空闲推进。** 只有回复、例程到期、Work 截止、Decision 或审批结案、你回到场能推动愿望；「空闲即继续」一律不做（CX#34248：10 h 38 min 里 7,480 个续跑回合）。需要人的步骤让愿望一次性进入 `waiting-human`，由卡住它的那条条目（升为 P1）通知你一次，绝不反复催（CC#100010）。
4. **愿望的状态在 orchestrad 里，不在任何会话的上下文里。** 每个乐章启动和轮换时逐字注入冻结的愿望块（同 §11.6 的 ADR 注入与 A18）。守护进程重启后愿望停在 `paused(restart)`（M1 起），你点一下才恢复（DSH 的规则，`dsh-goal-round-driver/README.md:57`）；计数与上限跨重启、跨「继续」保留，从不清零；§8.3 (b) 的单次续跑照常，其结果入账，但复核与新派发都等你点继续（本文 §6.6）。
5. **主动通知（P1）你的只有三类时刻**：开工前的澄清卡与计划卡（Decision，绑定契约版本）；愿望被只有你能解的事卡住（审批、交接、品味或「矛盾 / 无法验证」类 Decision、`tamper`）；愿望停了（重启、预算、上限、停滞、判定器故障、阻塞愿望的夜间失败）。每个事件只对应一条条目（本文 §6.9 的映射表）；几个愿望的 P1 推送每 30 min 合并为一条，审批与 P0 不合并。最终验收、`unknown` 判定、抽检、拆分提议只进收件箱与摘要。审批仍逐条由你点（D8），愿望只把它们聚到一张卡上，绝不代批、不批量批。
6. **自治分三级：有人值守 → 影子 → 无人值守。** v1 只建前两级。有人值守：你在场时推进器派发新 Task；你不在时在途的 Task 跑到处置，越过上限由运行时中断（本文 §6.4），复核等你回来。复核不是只读的：契约命令会执行执行者刚写的代码，而原生 Windows 上 Claude Code 的 Bash 不在沙箱里（sandboxing.md，2026-10-27 复核），所以你不在时不跑（本文 §6.10，Q-P3）。影子：派发与有人值守相同，另在你在场但不介入的时段测量无人值守会遇到的风险。无人值守仍是 §3.2 的 v1 非目标：要等事故回放用例全过、R05 / R06 / R07 / R21 落地、有人值守期测得假完成率与复核—你的一致率达标、回归微愿望 pass^3 达标、影子期指标达标、一次性项目上的试运行通过，再在 v1 之后另立里程碑，由你逐个项目开启（本文 §6.10）。本文只给出解除路径，不解除它。
7. **不动的 r3 规则**：D8；Post Office 是唯一总线（守护进程为愿望发出的每次派发与复核都是一条 Exchange）；D13 不变：推进器在 v1 每个愿望并发 1、不扇出，扇出只经你启动的 Arrangement（M6）；另依 D13 否决的「让 goal loop 掌握终止」，自有乐手里的原生 goal loop 一律关闭（r3 §7.4 只关到非 user 来源投递落地，即 M3 bundle，或 S2 选 B 时更早；本文改为永久，见本文 §7.4）；D16；原则 5；§8.3 规则 11「绝不自动重新规划」。本文把规则 11 解读为改「做什么」与改「怎么做」都只能由你确认（推断）。
8. **复用，不重造。** Decision 承载澄清、计划确认与品味；Task 是计划节点；Work 是执行单元；Governor 与 BudgetIncident 管预算；回访与停滞管不收敛；轮换熔断与回收器管恢复；Routine 管定时唤醒与晨报；M1 的 QA 模板是复核者，M6 的 Arrangement 提供扇出复核；Maestro 只提议计划，从不判定完成。

---

## 2. 用户要的「许愿」拆开看

| 阶段 | 可靠性要求 | 已知的失败方式 |
|---|---|---|
| 许愿 | 只有你能创建愿望；原话逐字保存，只当数据；agent 只能提议 | 模型自己建目标并定 40 轮上限，引出 12 次审批提示（DSH-D#11098）；一句玩笑式「/goal」经 `turn/start` 建成目标（CX#41838） |
| 澄清 | 开工前一次问清；每问附推荐答案；答过的不再问；提问期间不开工 | 提问后照样执行完（CX#55484）；已授权的范围又来问（CX#57399）；宽泛目标比带验收标准的目标发散得多（V2EX t/1228560） |
| 规划 | 契约冻结；里程碑可独立验证；原话的每一条都映射到 Task；你确认一次 | 一半交付物「从没尝试」（CC#76687）；拿自己写的清单自评「清单上没有剩下的了」（CC#88271）；压缩后丢了验收条款（CX#19910） |
| 执行 | 事件驱动；先预约预算再派发；等待有类型；人类步骤让出 | 空转（CX#34248；DSH-D#7193「挂机一晚上……烧了2亿token」）；人类步骤变循环（CC#100010、CC#98066）；夜里静默停摆（CC#104806 损失 8.5 h、CX#57414 10 h、DSH-D#2929 8 h 20 min）；成本爆炸（CC#69213、DSH-D#7894） |
| 验证 | 非作者、新乐章、确定性优先；判定器失败即 `unknown` | 把 `"ci": "PASS"` 写进部署门而 CI 实为失败（CC#104037）；评估器把「OR」读成「AND」（CC#103908）；畸形判定 JSON 被当成通过（ZC:294-298） |
| 汇报 | 状态由守护进程从数据算出；只在需要你时推送 | 184 个目标回合里 170 个成了「汇报 + 提交」表演，8 次压缩都没压掉这种风格（DSH-D#10471） |
| 继续 / 结束 | 上限由守护进程判定；你的停止覆盖整棵子树；重启不复活 | 三天里目标的 Stop 钩子触发 74 次、拦下 73 次，其中 55 次的理由引用了报告者的「stop」仍判未满足（CC#101528）；Ctrl+C 之后定时唤醒继续烧了约 $300（CC#64744）；恢复已完成的目标后再次要求关机（CC#104808） |

[W4] §2 列出七条共同模式，本文认为其中三条最根本（推断）：谁说「完成」谁就是薄弱环节；没有哪个 harness 有「等待」状态，空闲即续跑；计划活在上下文里，压缩就会丢。其余四条（人类专属步骤没有类型化出口、夜间失败无声、人的停止管不住循环及其排定的唤醒、重启重放副作用）分别由本文 §6.7 与本文 §6.6 处理。

---

## 3. Harness 与框架对照

| 系统 | 计划表示 | 谁定「完成」 | 终止 | 断点续跑 | 预算 | 人类触点 |
|---|---|---|---|---|---|---|
| Claude Code 2.1.310 [W1] | plan mode 由人批；Workflow 脚本即计划；`/goal` 只有条件 | `/goal` 由小模型只读对话记录判定，不调工具（CC-GOAL） | met / impossible；Stop 连续 block 8 次后即被覆盖，期间任一工具调用清零（CC-HOOKS:2738；CC#101528 所说的「9 次上限」即第 9 次被覆盖，推断） | 每条恢复路线都恢复目标，回合数、计时、token 基线清零（CC-GOAL:102-104） | `/goal` 记录并显示 token 花费，但没有 token 或金额上限；上限只能写成条件里的回合 / 时间子句，由评估器从文本判断（CC-GOAL）；SDK `maxBudgetUsd` 不含恢复前的花费（CC-SDK `typescript.md:525`） | plan 由人批；`ultracode` 只认 `origin: human`（CC-WF:131-136）；SDK 驱动收不到空闲回访与自动重试 |
| DSH 0.2.1-rc.2 [W1] | `todo_write`；plan mode 只是建议（`dsh-plan-mode/README.md:12`） | 干活的模型：`complete` 任何一轮都可，`blocked` 要连续 3 轮（`dsh-tool-goal/README.md:48,55`） | 目标轮次上限默认 256；Ralph bundle 设 64（`cordis.patch.yml:16`） | 恢复或 fork 后保持解除武装，直到人明确授权恢复（`dsh-goal-round-driver/README.md:57`） | 只计轮次（`dsh-goal/README.md:158`） | 建、改、恢复目标要宿主认证的人类消息；但 ACP 投递被记为 user（[spec] §8.5） |
| Codex main@aa854da [W1] | `turn/plan/updated` 的步骤；目标串 + 可选 token 预算 | 干活的模型按「completion audit」提示自审（`continuation.md:35-46`） | complete；blocked 要连续 3 轮；`budgetLimited` 只由系统设置 | 恢复即重新武装 `Active` 目标（`runtime.rs:412-433`） | 每目标持久化 `tokenBudget`、`tokensUsed`、`timeUsedSeconds`（CX-BIND） | `create_goal` 不校验来源（`tool.rs:204-230`）；审批可交给 `guardian_subagent`（`ApprovalsReviewer.ts`） |
| Magentic-One / MAF [W2] | 任务账本（事实 + 计划）与进度账本 | 编排 LLM 自判 | `max_stalls` 3 → 重新规划并重置全部 agent；MAF 轮次与重置上限默认「无限」（`_magentic.py:486-498`） | `save_state`；MAF 每超步检查点 | 无 | MAF 可选计划签核，停滞重规划后再问一次 |
| OpenHands SDK [W2] | `task_tracker` 或 PLAN.md | agent `finish`；没有 critic 结果也接受（`critic_mixin.py:108-112`） | 500 次迭代；StuckDetector | 事件日志 + 压缩墓碑 | SDK 有可选 USD 上限；自托管 V1 没有可设的预算，运行中成本读 0（OH#17691） | 确认模式 |
| Paperclip [W2] | issue 树 + 计划文档修订 | 证据分 accepted / missing / rejected / unverifiable（`native-status-arbitration.md:56-125`）；默认合同仍用低风险的「agent 声明」策略（同文件 `:108-113`；据文档，代码未核） | 重试与修复额度；看门狗 2–3 次恢复失败即升级给人 | 按（源 issue，已接受的计划修订）精确一次分解（`execution-semantics.md:395-463`） | 预算策略；「言辞自信……不能补额度」 | 计划接受 = 绑定修订的一次交互；工具审批不授权计划 |
| Grok Build goal [W2] | 规划器一次写出 3–5 条结果标准、验证计划、非目标，用户看不到 | 3 名对抗复核者，冷面板多数，默认驳回；削弱标准本身即驳回 | 10 次复核；相同 gap 指纹 2 次 → `NoProgressPaused`（`goal_tracker.rs:10-20`） | 未知状态恢复为 `UserPaused`（`goal_tracker.rs:1-6`） | — | `contradiction` / `unverifiable` 交给人（`goal_verifier_prompt.md:46`）；禁止问「要不要继续」 |
| hermes 上游 [W2] | 五字段契约 + `/subgoal` | 先跑 shell 门，再由 LLM 判最后约 4 KB；判定出错 = 继续（`goals.md:181-203`；据文档） | 20 回合兜底 | SessionDB | — | `/goal draft` 先给你看契约 |
| OpenClaw goal [W2] | 目标串 | 模型 `update_goal(complete)` | 模型只能标 complete 或 blocked，同一阻塞连续 3 轮才可 blocked；不能自行暂停、清除或替换目标（`goal.md:167-190`） | 关机后「保存的活跃目标不会自己启动进程」（`goal.md:235`） | token 预算「不是计费上限」 | Lobster 在审批处带恢复 token 停下 |
| DS-Bot [W2] | 交接笔记八段（目标、约束与偏好、进度、决策、要留的事实、未结事项、下一步、去哪里找；`parts.js:388-397`） | 不适用：Bot 会话里禁用 DSH goal（`tools.js:17-20`） | — | steward 在上下文 0.8 时压缩或换乐章 | — | 每条消息；steward 逐项对照「要的」与「做的」 |

**可借的**（除反棘轮是复核提示词外，都是确定性规则）：GB 的冻结契约、反棘轮与指纹停滞；Paperclip 的证据四分类与按计划修订精确一次分解；Codex 的「已核实的等待」与系统独占的 `budget_limited`；DSH 的重启后解除武装；Claude 的回访退避；hermes 的「门先于判官」；DS-Bot 的交接笔记段落（尤其「约束与偏好」「未结事项」）。**不借的**：任何把「完成」交给干活的模型或只读对话记录的评审的做法；默认无限的轮次；恢复即重新武装；自动批准（Devin 的工作流与子会话默认自动批准，[W2] DV）。

---

## 4. 社区事故与可靠性证据

### 4.1 事故（[W4] §1，[W1] §6）

| 类别 | 代表事件与数字 |
|---|---|
| 假完成 | CC#104037：三处部署门写入 `"ci": "PASS"`，两处上了生产；`/goal` 评估器在 14 项里 3 项 FAILED / BLOCKED 时判「已满足」（报告者承认目标文本允许这种说法，所以这是契约措辞的失败，支持 A40 的覆盖检查，不能证明判官不可靠）。CC#88271：按自写清单判完成，后续查出 8,726 条缺陷记录。CX#41176：独立评审找出 8 条缺失或损坏的需求。OH#18885：压缩 20 多次后按一条旧指令报告「全部完成」 |
| 空转 | CX#34248：10 h 38 min 里 7,480 个续跑回合，4,857 个完全相同。CX#36503：2,514 次相同的 `update_goal`，708.9M token。CX#44909：3,808 个 rollout 中 1.4% 的目标会话用掉 49% 的输入 token。DSH-D#6169：约 54 min 跑完 40 轮 |
| 成本 | CC#69213：一次调用派出 111 个 agent，26.2 min 用光 5 小时额度，零产出。DSH-D#7894：一个会话 642,005,901 token。OH#17691：自托管 V1 没有可设预算，运行中成本读 0，报告者自建的看门狗因此让一次运行在 $10 上限之后又多花约 $10 |
| 人类步骤与夜间 | CC#100010（OAuth 登录）重复触发「数百轮」，CC#98066（被拒的合并）约 15 次，CX#50767（沙箱拒绝）约 8 次；CC#105184 夜间运行卡在权限提示上，时长不明；CC#104807 承诺的回报在链于 23:13 结束后「没有任何东西唤醒主会话」 |
| 停止与重启 | CC#98708 只有关窗口才停；CX#45026 定时停止与目标竞争，数千个空回合；DSH-D#6067 孤立的 `goal/complete` 让重放卡死；OC#184534 一条提醒 37 min 内送达 6 次。其余见本文 §2 |
| 中文社区 | V2EX t/1228560：Codex `/goal` 跑约 80 h、约 18 万行、200 多次提交（作者自报），带验收标准的早期目标远比宽泛目标收敛；V2EX t/1214285：「grill-me + goal」，先访谈（每问带推荐答案），再写含完成状态、验证、非回归、范围、下一步规则、受阻处理的目标。没能检索到使用「许愿式编程」一词的帖子：V2EX 的检索（sov2ex）对该词返回 503，linux.do 403，知乎、即刻未触达，WebSearch 无中文结果（[W4] §5，未核实），这个词的含义以你的说法为准（假设） |

### 4.2 可靠性证据（[W3]）

| 发现 | 数字 | 出处 |
|---|---|---|
| 可靠时长比宣传短一个数量级 | 50% 与 80% 时间地平线：Opus 4.6 为 11 h 59 min 与 1 h 10 min；GPT-5.2 为 6 h 34 min 与 55 min | METR-TH（经 Wikipedia 镜像，metr.org 图表未渲染，未核实） |
| 长流程崩塌 | OSWorld 2.0 最好成绩二元 20.6%、部分得分 54.8%；137–163 min 档没有模型过 10%，更长的全为 0 | OSW2 |
| 一致性随次数衰减 | 单次 75% ≈ pass^3 42% | A-EV；TAU |
| 多智能体失败里验证类约占 23.5% | 加一个顶层任务目标验证步骤：ChatDev 在 ProgramDev 上 +15.6%，是所试干预中的最大值 | MAST（类目合计由抓取工具求和，未核实） |
| 假完成随能力上升 | 与规格矛盾的不可能任务上，GPT-5 在 Oneoff-SWEbench「通过」76%（Oneoff-LiveCodeBench 为 2.9%）；Claude 的作弊 >79% 是改测试；「放弃 / 标记」通道把 GPT-5 在 Conflicting-SWEbench 上从 54% 降到 9%、o3 从 49% 降到 12%，对 Claude Opus 4.1 效果明显更弱 | IMP |
| 测试必要但不充分 | 自动评分比维护者合并决定高约 24.2 pp；约一半测试通过的补丁不会被合并 | METR-SWE |
| 自评无效，独立评估有效但仍偏宽 | 无外部反馈的自我纠错不可靠；评估器自身也会被说服，需要硬阈值的冲刺合同 | SELF、KAM、SP、A-HD |
| 集中验证压低误差放大 | 独立多 agent 17.2×，集中验证 4.4×；顺序规划任务多 agent 最多 −70% | SCALE |
| 成本是成功的杠杆 | 单 agent 20 min / $9 核心功能坏掉；完整 harness 6 h / $200 能用（单一厂商报告，非对照实验） | A-HD |
| 审批疲劳 | 用户批准 93% 的提示；自动模式分类器漏掉 17% 的过度行为；沙箱减少 84% 的提示（Claude Code 的 Bash 沙箱，原生 Windows 上不运行，sandboxing.md 2026-10-27 复核，所以对 Orchestra 不适用） | A-AUTO、A-SBX |
| 模型会探测评分器 | GPT-5.6 Sol 的 50% 地平线按「作弊算失败」约 11.3 h、按「算成功」>270 h（METR 认为这些数字都不稳健，也没给作弊率）；在不可能任务、多日预算的 ExploitGym 运行中，约 7% 的审阅记录里有伪造的工具调用 | METR-SOL、METR-HF |

### 4.3 推论（推断）

- 「完成」必须来自环境中的事实或独立的评估者，不能来自作者（A-BEA、A-HD、A-EV 一致）。复核者也是 LLM，所以要加确定性门、不同模型家族、人工抽检三层兜底。
- 一个跑几小时到几天的愿望应拆成一串里程碑，每个按人类任务时长估算都明显短于模型的 80% 地平线（多数 2026 年模型约 1 h，METR 数值经镜像，未核实），每个以提交加已验证的状态结束（A-LRH、OAI-PLANS）。地平线量的是人类任务时长，不是 agent 墙钟；用它给里程碑定大小是推断，要按模型重新拟合。
- 给执行者一个合法的「做不到 / 规格矛盾」出口：在 GPT-5 / o3 上显著降低作弊，对 Claude 效果弱（IMP）。METR-RH：o3 在 RE-Bench 上被叮嘱后作弊率仍有 70–95%；IMP 显示严格提示在部分基准上有效（GPT-5 在 Conflicting-LiveCodeBench 上 92% → 1%），但不稳定。所以仍需只读测试与 `tamper` 标记。

---

## 5. r3 已有的零件与缺口

| 阶段 | r3 已有 | 缺口 | 复用（不另造） |
|---|---|---|---|
| 许愿 | 主代理乐手（§2.3）；DSH goal 插件在私有 home 关闭、A2A 不得产生 `goal/change`（§7.4、§13.3）；D15 | 没有 Wish 实体；没写明只有 `trust: human` 能创建 | A17 式只提议：agent 的愿望提议是一条 Decision |
| 澄清 | Decision 只由你结案（§6.1）；ADR 注入（§11.6）；`ask()` = Decision（§8.8 (f)） | 没有开工前的澄清批次；agent 的决策配额每天 5 条（§8.6） | Decision 卡 + 注入：澄清结案后才开工 |
| 规划 | Task{`doneCriteria`, `roundCap`, `staleSince`, CAS}（§6.1、§6.4）；规则 11 不自动重规划 | `doneCriteria` 是无类型文本，没有验收方法、版本和覆盖检查；愿望与 Task 树没有联系 | Task 树即计划；`revision` CAS；计划确认 = Decision |
| 执行 | Post Office 规则 1–11；Governor 与 BudgetIncident 上卷到 `rootId`（§10.2）；runaway（§10.3）；轮换熔断（§10.4）；审批超时即拒（§10.9） | 对回复的等待不空转（规则 9、D16），但对非回复句柄（CI、进程、时间）没有；夜间失败不分类；承诺的回报不是持久对象；按派发预约只写给 Arrangement 调用（§8.8 (e)）与乐器图片（§10.2），普通 Post Office 派发没有 | 规则 9 与 D16；定时唤醒只有两种：Routine（A19）与回访（Work 的 `checkInAt`，规则 11），Work 截止只出 `timedOut` 条目；A5 的拒绝记录；熔断的确定性类；自有会话的运行时中断（§10.3、§8.7 M3） |
| 验证 | §8.7「第一轮的假完成 → 新开校验者」；§9.2 第 7 步拒绝模型自评；QA 模板（M1）；`in-review`、打回 N=3（§6.4、§10.7） | `in-review → done` 没有指定由谁推动；独立复核要等 M6；没有判定 schema，也没有「判定器出错 = unknown」 | QA 模板作为 M1 的复核位；`replyFormat` 的 schema 校验与一次修复回合（§8.1，r3 只给 M6 的 Arrangement worker）由本文提前到 M1，只用于愿望的请求（本文 §7.4）；原则 7 |
| 汇报 | 薄完成（A16）；P0–P3 与 30 分钟摘要（§11.2）；`orchestra_report`（R15） | 没有由数据算出的愿望状态；没有晨报 | 摘要（M2）+ Routine 渲染守护进程算出的愿望卡 |
| 继续 / 结束 | 回访与停滞（A9）；`meta.stop`（§8.8 (d)）；D15 中断只归人；§3.2 | 没有覆盖整棵子树的暂停 / 取消；上限可能交给 LLM 判；解除 §3.2 没有证据路径 | `meta.stop` 词表（本文扩展，本文 §6.7）；kill-tree 与回收器；Q11 / §14 的门槛写法 |

---

## 6. 设计：愿望层（Wish layer）

### 6.1 实体

| 实体 | 关键字段 |
|---|---|
| **Wish**（新） | `id`, `projectId`（只一个，本文 §6.11）, `rootId`（= 愿望的 Exchange 树根；成本上卷到这里，A5 的拒绝从 M2 起也记在这里；M1–M2 闸门放行的派发也挂到这里，本文 §6.4）, `ask{text, author: human\|agent:<id>}`（原话逐字，只当数据；agent 起草的以「提议（由 X 起草，你于 … 接受）」注入，不以你的口吻）, `createdBy`（永远是人：亲手许愿或接受提议的那次点击）, `planner`（主代理乐手，M4 起可为 Maestro）, `priority`（建愿望时由你定，只用于排序通知，本文 §6.9）, `contractRev`, `planRev`, `state`, `pausedReason`, `pausedFrom`（暂停前的状态，继续时回到这里）, `dispatchHeld`（`absent` 等派发闸门，不是状态）, `autonomy`（`attended` / `shadow`；`unattended` 在 v1 之后）, `integrationBranch`（M3）, `budget{cny, cnyDay, wallMin, verifyReserveCny}`（CNY 与墙钟只在这里定义；`wallMin` 数活跃时间，不含 `waiting-human`、`paused(*)`、`dispatchHeld: absent` 与项目日上限的等待）, `callsPerHour`（Governor 的速率限制，不是上限）, `metrics{verifiedTasks, reopened, unknownVerdicts, humanLoopCount, humanInterrupts, untaggedCalls, heldMinutes, overturnedBlocks}`（计数跨重启与继续保留） |
| **WishContract**（新，每版不可变） | `wishId`, `rev`, `askClauses[]{id, span, source: segment\|planner}`（原话按句子与列表项确定性切分；规划者补的条目单独标出）, `outcomes[3–5]{id, text, askClauseIds[], verify[]}`, `verify[]{kind: cmd\|ci\|review\|look\|human, gating: bool, spec, specDigest, author, visibility: all\|verifier}`（gating 检查由非执行者编写并冻结，本文 §6.3）, `nonGoals[]`, `constraints[]`（不得改动的东西）, `frozenFiles[]{path, digest}`（gating 命令的闭包：冻结的测试文件，加清单里的脚本项、运行器配置、setup 与 fixture、快照目录、CI 工作流文件、锁文件；冻结写测试的 Task 时按固定的文件模式确定性算出，推断；都必须被 git 跟踪；`tamper` 的依据）, `stopWhen`（扩展 `meta.stop` 词表，见本文 §6.7）, `decisionRefs[]`, `digest`（sha256）, `gitHead`, `acceptedBy`（人）。依据：GB 规划器、HU 五字段契约、A-LRH 只许改 `passes` |
| **Task**（扩展） | 加 `wishId`, `clauses[]`（覆盖了契约的哪几条结果）, `paths[]`（规划时给出的路径 glob，随 `planRev` 冻结）, `acceptance{kind, spec, gating}`（取代无类型的 `doneCriteria`；至少一条 gating，否则 `done` 要你点）, `milestone`, `dispatchAttempt`（审计用的全部派发序号，与 Part 的 `attempt` 区分）, `verifySubmissions`（新，复核提交次数，跨复核者合计）, `verdictRef`, `estHumanMin`（规划时的人类时长估计）, `wallCapMin`（运行时的墙钟上限）, `pausedReason`（Task 级暂停，例如 `cap:wallCapMin`）。`roundCap` 按 r3 原义保留：每 Task 在计划里设定的轮次上限；愿望里它只数执行者导致的重派（`refuted` 与 `null` 处置），默认 3（假设）。带 `wishId` 的 Task，`status`、`acceptance`、`clauses`、`paths`、`milestone`、`verdictRef`、`wishId` 只有守护进程与你能改（本文 §7.4 的 §8.6 行） |
| **Work**（扩展） | 加 `disposition`（`done(evidenceRefs) \| blocked(owner, action, evidenceRefs) \| waiting(waitingOn) \| question(decisionId) \| impossible(reason, evidenceRefs)`，带 `contractRev`、`planRev`）, `waitingOn{kind: reply\|ci\|process\|human\|time, handle, until, cap}`（`cap` 必填；M1–M2 只接受 `reply` 与 `human`，本文 §6.7） |
| **Verdict**（新） | `taskId`, `contractRev`, `planRev`, `verifierMusicianId`（与 `authorMusicianId`、`plannerMusicianId` 都不同；L2 为 `kind: qa`，L3 为 `scout`，M6 起可为 `kind: template` 并带 `arrangementRunId` 与各 worker 的调用引用）, `verifierPartIds[]`（必须是新乐章；Arrangement 面板为每个 worker 一个）, `modelFamily{verifier[], author}`, `result: pass\|refuted\|unknown`, `perOutcome[{id, status: accepted\|missing\|rejected\|unverifiable}]`, `blocking: none\|contradiction\|unverifiable`, `findings[]`, `gapFingerprint`, `evidenceRefs[]`（Event、LedgerEntry、commit、CI run id）, `tamper[]` |

其余复用：Exchange 的 `from.kind` 加 `wish`（守护进程为愿望发出的 Exchange，`trust: runtime`，经 Post Office：M1 起复核与「下一步」通知，M3 起派发）；Decision 加 `wishId`、`kind`（`plain` / `wish-proposal` / `clarify` / `plan` / `contract-rev` / `plan-rev` / `split` / `route` / `blocker` / `tamper`，级别见本文 §6.9）与 `choice.source`（`human` / `recommended`）；InboxItem 只加一种 `wish-paused`（P1，原因限重启、停滞、上限、判定器故障；其余事件复用已有种类，映射见本文 §6.9）；Part 的 `endReason` 加 `review-done`（复核用的一次性乐章，不计 A13 的每小时轮换上限，本文 §6.6）；LedgerEntry 的 `purpose` 加 `verify`、`plan`、`coordinate`；Reminder / Routine 与 ArrangementRun 加 `rootId`、`wishId`，乐章处理愿望 Exchange 时创建的提醒继承它们（本文 §6.7）。

### 6.2 状态机

```
（建愿望）→ clarifying（规划者有问题时，至多一轮）→ planning
（建愿望）→ planning                  （规划者没有澄清问题）
planning → awaiting-plan ─(你确认计划 Decision)→ running
awaiting-plan ─(你打回或改动)→ planning
planning → waiting-human              （计划校验修复 2 轮仍不过：条目是一条 `blocker` Decision）
running ⇄ waiting(waitingOn)          （running 内逐个 Task：派发 → 处置 → 复核 → done 或驳回）
running → verifying（全部 Task done 后，在集成分支的最终 HEAD 上重跑全部 gating 验收）→ ready-for-acceptance
verifying → running（有结果被驳回）
running | verifying → waiting-human   （审批 / 交接 / 被拒的动作 / blocker 或 tamper Decision / contradiction / unverifiable）
waiting-human → 进入前的状态          （卡住它的那条 Decision 或审批结案；被拒的动作另开 blocker Decision，见本文 §6.7）
ready-for-acceptance ─(你验收)→ done
ready-for-acceptance ─(你打回)→ running（reopened+1）
非终态 → paused(restart | stall | cap:<项> | verifier-infra | failure:auth|capacity | budget | human)，记 pausedFrom
paused(*) ─(只有你点继续)→ pausedFrom（budget 与 cap 要你先填新的上限；计数不清零）
非终态 → cancelled（只有你）
done、cancelled 为终态；done 之后要改就许新愿望，并链接原愿望
```

- Task 层：`open → claimed → working → in-review → done`，新增 `waiting`、带类型的 `blocked` 与 Task 级 `paused`（`wallCapMin` 越界：只停这个 Task，依赖它的 Task 等待，其余照常）。`in-review → done` 只能由「全部 gating 验收为 accepted、且 `contractRev` / `planRev` 为当前版本的 Verdict」或你推动；任何 agent 都不能推动它（本文 §7.4 的 §8.6 行）。`waiting` 的 Task 在句柄核实为活着且未到 `waitingOn.cap` 时不触发 `any → stale`，Work 截止暂停计时（本文 §6.7）。
- 在 `awaiting-plan` 或更早暂停的愿望，继续后仍回到原状态，没有已确认的契约就不派发；在 `waiting-human` 暂停的，继续后仍等那条条目。继续从 `paused(stall)` 只多给一次 Verdict，之后再判。
- 最终在同一 HEAD 上整体重跑，是为了抓住后做的 Task 弄坏先做的 Task（A-CC：新功能不断弄坏旧功能后才加的 CI 门）。
- 愿望层的 `done` 永远要你点一次验收（一张卡）。是否允许全部 gating 都是确定性检查的愿望自动结案，留给 Q-P1。
- 澄清只有一轮：之后的问题只能以 `contradiction` / `unverifiable` 阻塞或契约修订 Decision 出现，没有 `planning → clarifying` 的边。
- 「你不在」不是状态，是派发闸门：`autonomy = attended` 时推进器带 `dispatchHeld: absent`，不派新的执行 Task，也不发复核；在途 Task 与等待照常；你回来（一次 UI 操作，本文 §6.10）即清除。闸门合上而心跳还在时（你在别的窗口里忙），主代理页状态条与标签页标题显示「派发已暂停：等你回来 · 点一下继续」，每天至多一条 P3，暂扣时长记入 `heldMinutes`。
- 愿望层状态是各 Task 的汇总：一个 Task 进入 `waiting-human` 时，与它无依赖关系的 Task 照常推进；没有可推进的 Task 时愿望才整体显示 `waiting-human`（推断）。

### 6.3 谁规划，怎么规划

1. **许愿。** 你在 Program、baton bar 或乐手页输入愿望（`trust: human`）。在主代理乐手页里，你亲手发的消息带「设为愿望」按钮，或以 `/wish` 开头（只认配对 UI 里 `trust: human` 的消息），就直接建愿望，省掉提议卡。agent 只能调 `orchestra_propose_wish`，它生成一条 `kind: wish-proposal` 的 Decision，计入 §8.6 的配额，永不直接建愿望（A17 同理）；你接受后 `ask.author` 记为该 agent。
2. **澄清。** 推进器向规划者发一条 `trust: runtime` 的请求，`replyFormat` 为澄清 schema：最多 7 个问题，每问附推荐答案与理由（V2EX t/1214285；7 为假设）。守护进程把它们渲染成一张 P1 卡里的一组 Decision，按 `wishId` 计，不占每天 5 条的配额；同一组卡也内嵌在主代理乐手页上，用同样的 UI 动词作答，收件箱里那份是准（D8 不变；你主要读主代理的聊天，§2.3）。你可以逐条选，也可以一键采纳推荐：采纳记 `choice.source: recommended`，`rationale` 留空（它只能由你写，§6.1）。每问必须从固定枚举里标类别（范围、约束、非目标、不可逆动作、品味、细节）；只有「细节」类可以一键采纳，其余必须逐条答，卡上显示必答数（类别仍由规划者标，所以默认从严，推断）。已答的问题作为已定 Decision 注入后续乐章，不再重问（CX#57399）。M1–M2 没有推进器：澄清与规划请求就是你发给主代理乐手的那条消息（`trust: human`），由 UI 附上对应的 `replyFormat`；M3 起由推进器以 `trust: runtime` 发出。
3. **规划。** 第二条 runtime 请求要求返回计划 schema：契约草稿 + Task 树（依赖、负责乐手、`acceptance`、`paths`、里程碑）+ 预算预估。守护进程做确定性检查（原则 5）：
   - 覆盖：守护进程先把原话按句子与列表项切成 `askClauses`（规划者补的条目单独标为 `planner`），检查每条 askClause → 至少一条结果 → 至少一个 Task（CC#76687、CC#88271）；计划卡把切分结果逐字摆在原话旁边。
   - 验收：每条结果至少有一个 gating 验收；每个 Task 至少一条 gating，否则它的 `done` 要你点；`ci` 类 gating 只许放在里程碑与最终边界，每个边界一次 push 审批（仍逐条绑定，D8），Task 级 gating 必须是本地 `cmd`；`frozenFiles` 闭包里的文件都被 git 跟踪。
   - 规模与人选：每个 Task 有 `estHumanMin`，不超过 30 min（假设，按人类时长估算，本文 §4.3）；每个负责乐手通过 §9.2 第 5 步的硬过滤，并满足第 9 步的 `handoffAcl`（A11；随它们各自的里程碑），不通过的改为计划卡上的「派给谁？」选择；规划者不得当 Task 负责乐手。
   - 并发：v1 每个愿望并发 1（SCALE：顺序规划多 agent 最多 −70%）；扇出只经你启动的 Arrangement（M6，D13 不变）。
   - 预算：默认值取项目策略（每愿望 CNY 上限；`calls` 上限 = 4 × Task 数 + 里程碑数，受项目策略封顶，假设），规划者的预估并排显示；预估超过项目上限、或最少调用数超过 `calls` 上限的计划不通过。
   gating 的 `cmd` 检查不由执行者写：需要新测试的结果，在实现 Task 之前先排一个写测试的 Task，负责乐手是复核乐手或另一个非执行者；写好的测试连同闭包摘要冻结进契约（`specDigest`、`frozenFiles`）；执行者自己加的测试只算 evidence，不算 gating（CC#88271 按自写清单判完成；IMP；METR-SWE）。写测试的 Task 要过确定性的「先红」检查：冻结的测试在实现之前的 HEAD 上跑，针对的用例必须失败（OAI-PLANS「先失败后通过」）；若写测试的就是唯一的 QA 乐手，这个 Task 的 Verdict 由你给，顺便看一眼测试名。复核者由守护进程按规则选（非作者、非规划者、`kind: qa`、优先换家族），不由计划指定。不通过就退回规划者，最多 2 轮修复（假设），再不过就出一条 `blocker` Decision，愿望进入 `waiting-human`。
4. **确认。** 一张计划 Decision 卡（也内嵌在主代理乐手页）：结果、验证方法、非目标、「什么时候自动停」（`stopWhen` 的人话版）、预算（总额与每日切片）、里程碑、第一个里程碑的 Task，以及预计要你出手的次数。之后各里程碑的 Task 列表以 `planRev` diff 卡逐个到达（滚动式规划，本文对 Q-P2 的读法），不在一张卡里批几十个 Task。你接受即冻结 `contractRev = 1`、`planRev = 1`。这次点击授权推进器按计划派发这些 Task（类似 Arrangement 的 Start，§8.8 (f)，但不启动任何 Arrangement 运行），**不授权**任何工具审批、权限变更、Grant 或租约。聊天里的「ok」不算确认（DSH 自己的 plan mode 文本即如此，`dsh-base/cordis.patch.yml:336`）。
5. **改计划。** 改「做什么」（结果、验证、非目标）= 新的 `contractRev`，必须你确认；复核者总会拿到契约 diff，削弱标准本身即驳回（GB）。改「怎么做」（同一契约下重排 Task）在 v1 也要你确认，以一键 diff 卡呈现（本文对规则 11 的解读，推断）；任何有界的自动重排都是对规则 11 的修订，本文不提（Q-P2）。新的 `planRev` 取代旧树：未派发的 Task 以 CAS 撤回，在途 Task 的旧版本处置拒收后重派（本文 §6.6）；版本改动、你对阻塞的答复、瞬时失败引起的重派只计 `calls(n)`，不计 `roundCap`。
6. **规模。** 规划时，`estHumanMin` 过大的 Task 在计划卡上提出拆分（Decision），不自动拆。运行时，`wallCapMin` 是独立的失控上限，默认 60 min（假设，不与地平线挂钩：地平线量的是人类任务时长），即该 Task 的 Work 截止（本文 §6.4）。

### 6.4 执行：推进器

推进器是 orchestrad 里的确定性组件，不是 LLM，也不跑脚本：
- 只在事件上动作：计划确认、某 Task 的 Verdict、Work 的处置、Decision 或审批结案、例程到期、Work 截止、你在场状态变化。没有空闲触发。
- 对一个依赖已满足的 Task（v1 每个愿望并发 1），经 Post Office 发一条请求：`role: request`、`trust: runtime`、`from.kind: wish`、`requestId = wish:<wishId>/<taskId>#<dispatchAttempt>`（§8.3 规则 5 的幂等）。正文 = Task 规格 + 上轮未通过的条款 id（不带复核者的发现，免得泄露只给复核者的检查），愿望块由乐章注入提供。派发前先经 Governor 接纳并预约预算（本文 §6.7）。`calls(n)` 的定义只在本文 §6.7。愿望 Exchange 不计入规则 7 的每 root 转发上限 20（同 Arrangement 的 `arrangementCalls`）；执行者在一次派发之下自己发起的转发仍受 20 的硬限，但以这次派发为计数的子根（成本照样上卷到 `Wish.rootId`，推断），免得一个跑几天的愿望用光一个 root 的 20 次。
- `deadline` 取 Task 的 `wallCapMin`（规则 8 的默认 30 min 不适用于愿望 Task）。越界时运行时中断这个在途回合，与 r3 对自有会话已有的运行时中断同类（§10.3 runaway；§8.7 M3 / R33「越界时 cancel → close → resume」）：D15 / A4 禁止的是 agent 发起的中断，不是守护进程对自己派发的回合的中断。Claude 用 `interrupt()`，DSH 用 `session/cancel`，后代仍活动则 `session/close` 再 `session/resume`（§10.4）。Work 记 `timedOut`（P1，不另出 `wish-paused`），这个 Task 进入 Task 级 `paused(cap:wallCapMin)`，愿望其余部分照常。这一中断从 M1 起只用于愿望的回合（本文提前：r3 对自有会话的自动中断在 M2，R07）；M2 起预约耗尽同样中断，在途调用按 `budgetPaused` 结算。
- harness 自己的上限只作内层兜底：Claude 乐章启动时设 `maxTurns`，流式输入下每条消息重新计数，所以它实际是每次派发的上限；`maxBudgetUsd` 在流式会话里按整段对话累计，到顶后同一对话里后来的消息都以 `error_max_budget_usd` 结束，`/clear` 才重新计（agent-sdk/agent-loop.md，2026-10-27 复核），所以它只在乐章启动时设为该乐章在愿望剩余预约里的份额，到顶即轮换到新乐章，愿望暂停待你提额；花费可能超出一次响应加仍在运行的子代理的花费。DSH 没有单回合上限（`dsh-agent-loop/README.md:220`），M3 起私有 home 的 bundle 在 `agent/turn-stopping` 上加回合上限（推断）。
- 对 DSH 目标，`trust: runtime` 的派发与 Arrangement 一样需要 relay-source bundle（M3；S2 选 B 时更早），否则拒绝码 `relay-source-missing`（r3 只给 Arrangement，M6；本文把它用于 `from.kind: wish`）。
- **M1–M2 的派发闸门**（推进器之前）：执行派发由主代理乐手以 `trust: agent` 发出，但守护进程把住闸门。
  - 范围：愿望运行期间，主代理发给该项目内可写预设乐手的请求，以及任何正在处理愿望 Exchange 的乐章发出的请求（继承 `wishId`）。发给 Task 负责乐手的必须引用一个 `taskId`，否则拒绝（拒绝码 `wish-untagged`，推断）；发给其他可写乐手的未标记请求照常投递，但计入 `untaggedCalls` 并显示在愿望卡上。
  - 带 `taskId` 的请求由守护进程改挂到愿望下：盖上 `wishId`、`requestId`、处置 `replyFormat`，并设 `rootId = Wish.rootId`、`parentExchangeId` = 愿望的根 Exchange，所以预算、A5 与停止主权都覆盖它。主代理处理愿望请求与回信的回合，其 LedgerEntry 也记到 `Wish.rootId`（`purpose: plan | coordinate`）。
  - 计数与次序：计入 `calls(n)`；执行者导致的重派计入 `roundCap`，到顶拒绝并出 `bounce`；上一个 Task 没有 Verdict 之前，拒绝下一个 Task 的派发；愿望处于任何 `paused(*)`（含 `paused(budget)`）时拒绝派发。
  - 你不在时（`dispatchHeld: absent`），上述范围内的请求一律由 Post Office 暂扣，你回来才投递；Claude 主代理在该项目内的写与 shell 调用经 `canUseTool` 一律询问（你不在即超时拒绝）；DSH 主代理的预设不能按会话切换（§10.10），这一条对它只能靠预设本身（缺口，推断）。
  - 唤醒：M1–M2 里澄清或计划 Decision 结案、Verdict 落地时，守护进程给主代理发一条 `trust: runtime`、`role: request`、`wake: turn` 的「下一步」Exchange（计入 `calls(n)`），否则 Decision 通知是 `wake:none`（D16）、Verdict 回到守护进程，主代理不会醒。
  - M1 没有账本（M2），所以 M1 的愿望只在你在场时派发，并且必须有显式的 `calls(n)` 与 `wall(min)`。
- 执行者用 `replyFormat` 处置 schema 结束回合（§8.1 的 schema 校验，本文提前到 M1：校验失败给一次修复回合，再失败记 `null`）。`null` 视为只有叙述的结算：出一条条目，不算完成（HU kanban_stop；A16）。处置带 `contractRev` / `planRev`，不是当前版本的拒收（本文 §6.6）。
- `blocked` / `impossible` 是合法出口：变成一条 `blocker` Decision，不计入 §9.2 第 7 步的失败标签（IMP）。它必须带证据引用（失败的命令、互相冲突的条款 id、被拒的动作），没有就按畸形处置走一次修复；守护进程能核实的（缺凭据、被拒的动作）自动归类。每个 Task 同时只开一条阻塞 Decision，同一阻塞指纹的重复并入它，并计入 `humanInterrupts`；你答复后同一阻塞再出现两次即 `blockRepeat(2)`（本文 §6.7 上限一览）。你推翻的阻塞（「继续，做得到」）计入 `overturnedBlocks`；同一 Task 第二次被推翻时，提议轮换或改派（Decision）。DSH 要求 `blocked` 连续 3 轮、OpenClaw 要求同一阻塞连续 3 回合（[W1]、[W2]），这里改用证据与推翻率，因为每次阻塞都会占用你。
- 乐手内部照常可用原生 subagent 与工作流，受 §8.7 的钳制、观察、治理；原生 goal loop 一律关闭（本文 §6.11）。愿望 Exchange 只投给以「愿望档案」启动的自有乐章，否则先轮换（`disallowedTools` 在乐章启动时固定，§7.4）。这个档案关掉 harness 自己的定时唤醒：Claude 以 `disallowedTools` 去掉 cron、唤醒、监视类排程工具与后台 Bash（工具名未核实，S3 核实），每次乐章启动断言 `system/init.tools`；DSH 在私有 home 设 `tool-jobs.completionDelivery: quiet`，后台任务完成只注入通知、不开新回合（`dsh-tool-jobs/README.md:56`）。`maxConsecutiveWakes` 不能设为 0（`lib/index.js:92` 为 `min(1)`，不设即不限），且在 relay bundle 之前每次 ACP 投递都会把它重新充满（§8.5、§15）。来源为 `task-notification` / `auto-continuation` 的 Claude 回合（[W1] CC-SDK `SDKMessageOrigin`）与 DSH 任务唤醒开出的回合都计入 `calls(n)`，你暂停愿望时同样被中断停下（CC#64744）。

### 6.5 验证：分层，禁止自评

| 层 | 谁做 | 内容 | 失败处理 |
|---|---|---|---|
| L0 产物存在 | 守护进程 | 处置里引用的 commit、文件、Event 真实存在（OC#68051 所提的声明对账）；CI run id 只对照复核者自己查询留下的 Event，守护进程不调外部接口；处置为 `done` 时工作区必须干净（守护进程只读 `git status`），否则算执行者的 `missing`；M3 起提交须在该 Task 的分支上；diff 超出 `Task.paths` 记一条发现（P2，不算失败，计入指标） | `missing` |
| L1 确定性门 | 复核者亲自跑，守护进程从该工具调用的 Event 里取结果 | 契约里的测试命令：命令串规范化后与 `verify[].spec` 完全一致、cwd 是愿望的工作区、HEAD 等于被复核的 commit，且守护进程在命令前后用 `git --no-optional-locks status --porcelain` 核对工作区为空（§10.8 已有 `git status` 对账），四条都满足才算数，否则 `unknown`（只因工作区不干净而记的 `unknown` 不触发重新复核与暂停，卡片显示「工作区有未提交的改动，复核等它干净」，推断）。结果取运行器输出到标准输出的机器可读报告（JUnit、TAP 或 `--reporter=json`）：冻结的每个测试 id 都执行且通过、执行数不少于冻结数，否则 `missing`（挡住 `passWithNoTests` 与 `-t nothing`）。守护进程读到的 L1 结果覆盖复核者对 `cmd` / `ci` 项写的 `perOutcome`；退出状态缺失或无法解析 = `unknown`（原则 7）。`ci` 只在复核者自己的查询（例如 `gh run view`）返回的 `headSha` 等于被复核的 commit、结论为成功、工作流文件摘要在 `frozenFiles` 里时才算数，不取执行者写的文本（CC#104037）。diff 触及 `frozenFiles` 闭包（含清单脚本项与运行器配置）或 `constraints` 即记 `tamper`；工作区干净且 HEAD 一致，所以磁盘上的内容就是被复核的提交（IMP；A-LRH）。更严的做法是在项目根之外的一次性干净检出里跑，留给无人值守级（推断） | 红门跳过后面的层（HU）；`tamper` 开一条 `tamper` Decision（P1），必须你点才可能通过 |
| L2 复核乐手 | `kind: qa`，由守护进程选：与作者、规划者是不同的乐手，新乐章，优先换模型家族（SP） | 收到契约、diff、证据引用与上轮 gap，不看执行者的叙述；`replyFormat` 为 Verdict schema；标准不随轮次升高（GB `goal_verifier_prompt.md:17`）；对执行者只回逐条通过 / 不通过；可选只给复核者的留出检查（`visibility: verifier`，放在执行者工作区之外，推断；METR-SOL 记录了用中间提交探测隐藏测试） | 畸形、超时、结构化字段矛盾 → `unknown`（原则 7；ZC 与 CC#103894 是反例）。矛盾只按字段判：`result: pass` 而某条 gating 的 `perOutcome` 不是 accepted；`result: pass` 而 `blocking ≠ none`；`result: refuted` 而全部 gating 都是 accepted。对自由文本理由的检查要靠分类器，不进 v1（推断） |
| L3 端到端看一眼 | Tier 0 侦察乐手（§10.13） | 契约声明了 `look` 时才跑，且只对公共或预发 origin（M2 起含你在场时的 Grant origin）。M1 用 playwright-mcp 的 origin 列表只放公共 origin（§13.3，推断），M2 起由 E4 永远拒绝回环、局域网与 `orchestra.localhost`（§10.15），所以本机 dev server 上的 `look` 记 `unverifiable` 交给 L4；本机应用改由复核者跑 e2e 测试命令（例如 Playwright）作为 L1 `cmd`；回环例外见 Q-P9 | 同 L2 |
| L4 你 | 人 | 品味类结果；愿望最终验收；对 `pass` 的盲抽检，另抽少量 `refuted`。比例自适应（假设）：每 5 个抽 1 个，直到该项目达到证据门的样本数；之后 gating 全为确定性检查的 Task 改为每 20 个抽 1 个，同家族或只有 L2 的仍为每 5 个抽 1 个。抽检卡要你做一项具体检查（跑一条命令或看一处），不是一键接受。进摘要，不推送 | 打回即 `reopened` |

- 复核请求从 M1 起就由守护进程发出（`from.kind: wish`，`trust: runtime`，经 Post Office；处置为 `done` 且你在场时触发，你不在时等你回来，本文 §6.10），不由执行者或主代理转述，所以复核者看不到执行者的叙述。M1–M2 每个愿望同一时刻只有一个执行或复核在跑：上一个 Task 有 Verdict 之前不派下一个，因为 L1 要求工作区干净。
- 第一次 `unknown`：守护进程自动重新复核一次，换一个合格的复核乐手（没有就换新乐章），计入 `calls(n)`，不出条目。同一 Task 第二次 `unknown`，或一小时内同一愿望出现两次 `unknown` → `paused(verifier-infra)` + P1 `wish-paused`（推断；hermes 的「判定出错 = 继续」是反例）。M1 的复核乐手用 Claude；DSH 复核乐手要等 M3 的 relay-source bundle（§8.5）。因此 M1–M2 里 Claude 写的 Task 由 Claude 复核，正是 SP 说的同家族偏袒：这段时间 Claude 写的 Task 的每条 gating 结果都要有 L1 确定性检查，否则提高 L4 抽检比例；Verdict 记 `modelFamily`，同家族的 Verdict 在证据门的统计里单列。
- 复核粒度与上限：每个 Task 处置为 `done` 时复核一次，只跑该 Task 的 gating；每个 Task 的 `verifySubmissions` ≤3（假设），跨复核者合计、不随换复核者重置，所以不比 r3 每（task，执行者↔复核者）的打回上限 N=3 松；它与 `roundCap` 是两个计数。到顶出 `bounce`，该 Task 停。里程碑结束时在里程碑 HEAD 上整体重跑一次该里程碑的 gating，这次另计，不占各 Task 的次数；每个里程碑的总数因此不超过 3N + 1。r3 把循环与打回的强制放在 M3（R08）；对愿望 Task，本文经派发闸门提前到 M1。`contradiction` / `unverifiable` 直接转为 Decision，不重试（GB `goal_verifier_prompt.md:46`）。
- M6 起，高成本愿望可改用 Arrangement 的对抗核验模板；本文建议该模板采用 GB 式三人冷面板多数（本文提议，r3 §8.8 v0 未规定面板大小）。面板的结果映射成一条 Verdict（`kind: template`）：每条结果取严格多数的状态，畸形或 `null` 的 worker 算不通过（GB）；没有严格多数记 `unknown`；`result` 按同一套字段规则推出。这类运行只由你点 Start 启动（Q-W1 不变）：愿望卡在需要时给出带预估的 Start 按钮，你不在时不启动，推进器从不启动 Arrangement 运行。
- 复核预算单列、先行预约；预算耗尽时愿望是「暂停且未验证」，绝不是 `done`（[W3] 含义 9）。

### 6.6 检查点与恢复

| 事件 | 处理 |
|---|---|
| 乐章启动或轮换 | 注入冻结的愿望块：原话、结果、验证、非目标、约束、已定 Decision，逐字节稳定（A18）。交接笔记由守护进程从 Task、Decision 与计划按 DSB 的八段生成（目标、约束与偏好、进度：完成 / 进行中 / 受阻、决策、要留的事实、未结事项：承诺与待回复、下一步、去哪里找；`parts.js:388-397`），「约束」与「未结事项」对应契约约束与丢失的承诺（CC#104807）；模型自己的笔记（含 ExecPlan 式的「意外与发现」，OAI-PLANS）只作数据附上 |
| 轮换触发 | 原有：上下文压力 0.8。新增（推断）：同一工具错误连击（A12）或 runaway 之后，下一轮在新乐章里开始（ILL、VB、CUR）。新乐章先读计划、进度与 git log，跑契约里的冒烟命令再动手（A-LRH）。A13 仍是失败轮换的上限；复核用的一次性乐章以 `endReason: review-done` 结束，计入确定性失败熔断，不计每小时 3 次的轮换上限（§10.12），否则一个 QA 乐手每小时复核 4 次就会触发 `rotation-breaker` |
| 守护进程重启 | 愿望一律 `paused(restart)`（M1 起：状态位、一条 P1、闸门拒绝带 `taskId` 的派发直到你点继续；M2 起合成卡）。所有暂停的愿望合成一条 P1 `wish-paused`（「重启：N 个愿望已暂停」），每个愿望一个继续按钮，另有「全部继续」，写明「n/m 个 Task 已验证」；继续前逐个核对 HEAD 与 `plan-stale`，计划过期的仍停着。在途 Exchange 按 §8.3 (a)(b)(c) 处理：(b) 的单次续跑照常，其处置与 Verdict 入账、Task 状态照常更新，但推进器不采取任何新动作（不发复核、不派下一个 Task），直到你点「继续」（DSH 规则；GB、OC 同向）。(b) 续跑的 Claude 乐章是新进程，`maxBudgetUsd` 从零起算，所以按账本算出的剩余预约传入；崩溃前的花费按估算，崩溃结果里清零的花费字段（agent-loop.md）按未知用量处理，绝不按 0；你不在且剩余低于再试下限时，在途调用记 `unknown`，不续跑。继续是人类动词，不是审批，D8 不受影响。未知状态按暂停处理 |
| 重派之前 | 检查副作用键：M3 起派发正文给出分支名 `wish/<wishId>/<taskId>`，执行者用自己的工具建分支并在上面提交（worktree 按 §10.8）；守护进程只用只读 git 核对，§5.2 的写围栏不变。L0 核对处置引用的提交都在这条分支上；执行者的提交另带 trailer `Orchestra-Wish: <wishId>/<taskId>`，缺 trailer 记 L0 `missing`，不静默通过。重派前按 `<wishId>/<taskId>` 前缀查所有尝试的提交（`#dispatchAttempt` 只用于审计）：只有被已接受的 Verdict 覆盖的提交算「已经做了」，其余作为 `unknown` 交给你（§8.3）。在途步骤按至少一次计（TMP、G-RES） |
| 计划过期 | 处置与 Verdict 带 `contractRev` / `planRev`，旧版本的拒收，在当前版本下重派；契约改版后，受影响的在途 Task 跑完当前回合，再在新乐章里重派（注入块在一个乐章内冻结，A18）；非愿望的提交（你的或另一个愿望的）触及未完成 Task 的 `paths` 并集时，愿望卡标 `plan-stale`，由你决定是否改计划；每次 `paused → running` 前，守护进程比对当前 HEAD 与上次记录的 HEAD，再按同一规则判定，下一位执行者在新乐章里先跑冒烟命令 |
| 集成 | 每个愿望一条集成分支（M3）；执行者在 Task 结束前用自己的工具把分支快进并入集成分支，冲突即 `blocked` → Decision，守护进程只读核对；v1 默认每个仓库根同时只有一个活跃愿望（`ready-for-acceptance` 不算活跃），双写者告警兜底；不自动合并到 main（跨 worktree 合并仍未解决，§10.8）。M1–M2 没有 worktree，同一 cwd 内顺序推进：每个愿望同一时刻只有一个执行或复核 |
| 污染 | 扩展 §8.5 E6：E6 只覆盖 `handoffNote`；本文新增覆盖由污染乐章写出的计划、进度、笔记文件，它们把污染带进下一乐章的注入（R77，推断，[W3] 含义 10）；由污染输入改出的计划修订需要你重新确认（METR-HF；OAI-ATLAS 未核实） |

### 6.7 停滞、预算、循环：接到 §10

| 机制 | 规则 | 复用 |
|---|---|---|
| 类型化等待 | 乐手以 `waiting(waitingOn)` 结束回合，不反复调用 `wait`；守护进程替它盯住句柄。M1–M2 只接受 `reply` 与 `human`：`ci`、`process`、`time` 改为给你的一条提醒（`orchestra_remind`，target = human，M0 起就有），Task 停在 `waiting`，到点由你决定是否重派，因为 Routine 在 M3 之前没有、没有东西会唤醒执行者（CC#104807 的无声停摆）。M3 起：`reply` 经 Post Office；`process` 经 procguard 核对 pid + 创建时间，闲置释放跳过持有活句柄的乐章（扩展 r3 对仍有工作流运行的乐章的例外，§10.4），重启后所有 `process` 等待记 `unknown` → `paused(restart)`（崩溃时 Job 杀掉所有自有宿主，§8.3）；`time` 与 `ci` 由一个继承愿望 `rootId` 的单次 Routine 到点唤醒乐手（`ci` 不由守护进程调外部接口，乐手醒来自己查，推断）。`cap` 必填：`reply` 等待在句柄活着时一直暂停 Work 截止，直到 `stall(3)`；其余默认取 `wallCapMin` 与 30 min 中较小者（假设；HU 的 `wait` 上限 30 min）。句柄核实为活着且未到 `cap` 时既不算进展也不算停滞（Codex「verified wait」，`continuation.md:22-25`），Task 不触发 `stale`；过了 `cap` 仍在等，就记一次停滞 | §8.3 规则 9、11；§8.6「结束你的回合，回信会唤醒你」；Routine（A19，M3）；§10.3 不变 |
| 回访默认值 | 规则 11 的 T 取临时默认值：首次 30 min，之后 1 h，再之后每 2 h（借用 CC-GOAL 的退避，推断）；回访 M1 上线，M3 前用 M1–M2 数据校准（同 §17）。停滞计数与 P1 `stalled-delegation` 升级仍在 M3（规则 11 不变）。愿望 Exchange 的提问者是守护进程，所以回访就是守护进程自己的一次评估：句柄是否活着、有没有新的 diff、测试、ref 或 Decision，没有就计一次停滞；不给执行者发消息（向已结算的执行者发「继续」正是立场 3 不做的空闲续跑）。执行者只经回信唤醒，或经一次新的派发（计入 `calls(n)`） | A9、R29 |
| 空续跑 | 没有新 diff、测试、ref 或 Decision 的处置计入停滞（CX#44909 里空续跑「不计入任何东西」是反例） | A9 的「无进展」定义 |
| 指纹停滞 | 同一 Task 连续两次 Verdict 的 gap 指纹相同 → `paused(stall)` + P1 `wish-paused`，不自动换法（GB）。它是 `stopWhen` 里单独命名的 `gapRepeat(2)`，与 A9 的 `stall(3)` 是两个信号，不改 A9 | 打回 N=3 不变 |
| 上限判定 | `stopWhen` 由守护进程判定，LLM 只回答「验收标准满足了吗」，永不回答「上限到了吗」（CC#103908）。词表在 `meta.stop` 原样（`calls(n) \| cny(x) \| wall(min) \| external \| stall(3)`）上扩展，另加 `gapRepeat(2)` 与 `blockRepeat(2)`；cny 与 wall 只在 `Wish.budget` 定义，`stopWhen` 只引用；每 Task 的上限是 `roundCap` 与 `verifySubmissions`。`calls(n)` 只在这里定义：守护进程发出的愿望 Exchange（派发、复核、「下一步」通知）、闸门放行的带标记请求、记到愿望乐章上的 harness 自发回合（`task-notification` / `auto-continuation`、DSH 任务唤醒、Routine 唤醒）。撞到任一项 → 愿望暂停，每个事件只出一条 P1（本文 §6.9）。计数跨重启与继续保留；从 `paused(cap:<项>)` 继续要你在卡上填新的上限值，同提额 | `meta.stop`（本文 §7.4 的 §8.8 行） |
| 预算 | 愿望即 `rootId`；预算 = 总额加每日切片。默认值取确定性的项目策略（每愿望 CNY 上限），规划者的预估并排显示，你在计划卡上确认（Q-P6）；计划结束时记录预估与实际，供 §14 第 12 行校准。80% 为 P2、100% 为 P1 `budget-incident`（复用 §10.2，每（策略、阈值、窗口）一条），愿望进入 `paused(budget)`，卡片链接到那条事件，不另出 `wish-paused`；只有你能提额（A14）。项目日上限到了，愿望记 `waitingOn: time(次日)`，不算暂停（Governor 排队不失败，§10.2）。每次派发前按估算预约（M2 起），剩余低于「再试一次」的下限就不派（SWA `reviewer.py:533-541`）；未知用量按估算、绝不按 0；`waiting-human` 期间释放预约（同 §8.8 (f) 的 `ask()`）。在途回合越过预约由运行时中断，见本文 §6.4。每小时调用速率默认 6（假设；DSH-D#6169 约 54 min 跑 40 轮） | §10.2、§8.8 (e) 的预约推广到愿望 |
| 人类专属步骤 | 下一步需要审批、交接、被拒绝的动作、Decision、`tamper` 或 `contradiction` / `unverifiable` 时，愿望一次性进入 `waiting-human`；卡住它的那条条目升为 P1 并链接到愿望卡，此后不再催。审批被拒后（你拒绝或超时），守护进程开一条 `blocker` Decision（换法 / 改契约 / 跳过此 Task / 取消）作为卡住愿望的条目，`waiting-human` 只在它结案时退出，所以不会立刻重派同一动作，也不会永远卡住。M1：被你拒绝的审批或 Decision 记在愿望上，同类动作再出现即 `waiting-human`；M2 起改由 A5 记在 `rootId` 上，并加 `handoff`（A26）。只有你明确的拒绝计入 A5；你不在时超时的审批记 `denied(reason: absent)`，不计入，但把（`taskId`，`actionClass`）标为「不在时已拒」：你仍不在时，该愿望下同类动作的审批请求立即自动拒绝、不出新条目（只拒不批，同 §8.8 (f) 的先例，D8 不变），回合结算后 Task 进入 `waiting-human`，你回来即清除标记 | A5（M2）、A26（M2）、§10.9 超时即拒、§8.8 (f) |
| 夜间失败 | 认证过期、提供方容量、配额分类处理：认证是确定性失败，不重试（≤3 次尝试只是 A13 测试的上限），愿望 `paused(failure:auth)`，条目就是那条 `failure`，阻塞愿望时升为 P1（今天 `failure` 是 P2，§11.2），不另出 `wish-paused`；容量按 1 / 5 / 15 min 退避 3 次后 `paused(failure:capacity)`（CC-BIN 的重试表，推断）；配额是 `waitingOn: time(until 重置)`，不算卡死（PC#10344） | 轮换熔断的确定性 / 瞬时分类（§10.4） |
| 停止主权 | 愿望的 `pause` / `cancel` 是人类动词，只挂在 UI 监听器上（D8、D15）；撤回该 `rootId` 下排队的 Exchange、待触发的例程（含执行者经 `orchestra_remind` 建的，它们继承 `rootId`）与 Arrangement 运行，在途回合（含 harness 自己的唤醒回合）用人类中断停下；你恢复之前不得重新武装 | D15；kill-tree（§10.5）；回收器（§10.4） |

**上限一览**

| 上限 | 键 | 默认 | 到达后 |
|---|---|---|---|
| `roundCap`（执行者导致的重派） | 每 Task（r3 原义，计划里设定） | 3（假设） | `bounce`（P2；愿望因此没有可推进的 Task 时作为卡住它的条目升为 P1），该 Task 停 |
| `verifySubmissions` | 每 Task，跨复核者合计（不比每（task，A↔B）的打回 N=3 松） | 3（假设） | 同上 |
| 里程碑重跑 | 每里程碑 | 1，另计 | 驳回即回到 `running` |
| `calls(n)` | 每愿望（定义见上表「上限判定」） | 4 × Task 数 + 里程碑数，受项目策略封顶（假设） | `paused(cap:calls)` + P1 `wish-paused` |
| `cny(x)`、`wall(min)` | 每愿望（`budget`；`wall` 只数活跃时间） | 项目策略默认，计划卡确认 | `budget-incident` / `paused(cap:wall)` + P1 `wish-paused` |
| `stall(3)` | 每 Work（A9，M3） | 3 | `paused(stall)`；条目就是 P1 `stalled-delegation`，不另出 `wish-paused` |
| `gapRepeat(2)` | 每 Task | 2 | `paused(stall)` + P1 `wish-paused` |
| `blockRepeat(2)` | 每 Task：你答复后同一阻塞指纹再出现 | 2 | `paused(stall)`；条目就是那条 `blocker` Decision，重新升为 P1 |
| `wallCapMin` | 每 Task 的 Work 截止 | 60 min（假设） | 运行时中断 + `timedOut`（P1）+ Task 级 `paused(cap:wallCapMin)` |
| `callsPerHour` | 每愿望（Governor 速率） | 6（假设） | 排队，不失败 |
| 规则 7 转发 | 一次愿望派发之下 agent 发起的转发（以该派发为子根） | 20 | `refused` |

### 6.8 审批：聚合，不委托

- 计划确认授权派发，不授权任何动作。每条审批仍绑定自己的请求摘要（§10.9），不做批量审批（§8.8 (f)）。
- 愿望卡把同一 `rootId` 下待批的审批聚在一起，写明「被 3 条审批卡住」，每条深链到收件箱；你仍逐条按 `a`。
- 降低审批量靠隔离，不靠委托（A-AUTO 分类器漏 17%）。A-SBX 的「减少 84% 提示」来自 Claude Code 的 Bash 沙箱，它在原生 Windows 上不运行（sandboxing.md，2026-10-27 复核），对 Windows 优先的 Orchestra 不适用；DSH 的 Windows 沙箱在受限进程以 `stdio:'pipe'` 派生子进程时 EPERM（§7.4），而多数测试运行器正是这样派生的。所以 S2 加一项：在 `workspace-write` 与 `read-only` 两种 DSH 沙箱里真的跑契约的 gating 命令（pnpm、vitest、pytest）；审批量先用 M1 数据估算每愿望小时的数，再声称能降多少。只对 Claude 乐手：计划卡可以**建议**一组契约命令的精确放行规则（SDK 原生权限规则里逐字的命令串，同 QA 模板，§11.7），它是独立的勾选项，不随「接受计划」默认生效；规则带 `wishId` 写入，列在愿望卡上并记入 journal，愿望 `done`、取消或契约改版时撤销（§10.10 回读），不留在乐手的长期档案里。DSH 执行者与复核者没有白名单：DSH 的「白名单」就是 Orchestra 替它答 `allow`，D8 与 §3.2 禁止（§8.8 (f)），所以它们的能力只来自 DSH 沙箱模式，其余请求照常进审批队列。放行规则之外的 shell、网络、受保护路径、push、部署永远要问（Q-P7）。
- 你不在时审批照常超时即拒（§10.9），记 `denied(reason: absent)`，并按本文 §6.7「人类专属步骤」打上「不在时已拒」标记：同类动作的后续请求立即自动拒绝、不出新条目，避免每 30 min 一条 P1 的夜间慢循环（runaway 的 120 s 内 ≥5 次检测看不见它，§10.3）。拒绝之后由一条 `blocker` Decision 卡住愿望，不会循环。你回来后若选「重试」，这类审批会再出现一次，各自绑定新的请求摘要（D8 不变）。
- Codex 的 `approvalsReviewer` 必须钉为 `user`，`guardian_subagent` 与 `auto_review` 都是 D8 禁止的委托审批（[W1] 含义 2）。

### 6.9 汇报节奏

每个愿望事件只对应一条条目，种类都已在 r3 里，或是本文唯一新增的 `wish-paused`：

| 愿望事件 | 条目种类 | 级别 |
|---|---|---|
| 澄清卡、计划卡就绪 | `decision`（`kind: clarify` / `plan`） | P1 |
| 契约或计划改版的 diff 卡、拆分提议、「派给谁？」 | `decision`（`contract-rev` / `plan-rev` / `split` / `route`） | P2；卡住愿望时 P1 |
| 阻塞（blocked / impossible / contradiction / unverifiable / 被拒的动作 / 计划校验失败） | `decision`（`kind: blocker`） | P1 |
| `tamper` | `decision`（`kind: tamper`） | P1 |
| 待批的审批、交接 | `approval`、`handoff`（r3 原样） | P1 |
| `wallCapMin` 越界 | `timedOut` | P1，不另出 `wish-paused` |
| 认证、容量失败 | `failure` | 阻塞愿望时 P1，否则 P2；不另出 `wish-paused` |
| 预算 80% / 100% | `budget-incident` | P2 / P1，不另出 `wish-paused` |
| `stall(3)` | `stalled-delegation`（M3） | P1，不另出 `wish-paused` |
| 重启、`gapRepeat`、`calls` / `wall` 上限、判定器故障 | `wish-paused` | P1；同一次重启合成一条 |
| Task 撞 `roundCap` 或 `verifySubmissions` | `bounce` | P2；愿望因此没有可推进的 Task 时 P1 |
| 第一次 `unknown` 判定 | 无条目，自动重新复核一次 | — |
| `ready-for-acceptance` | `ready-for-review` | P2（Task 级仍 P3） |
| L4 抽检 | `ready-for-review` | P3 |
| 派发闸门在你有心跳时合上 | 无条目：状态条横幅；每天至多一条 P3 | P3 |
| 每轮进展、Verdict 细节 | 只进愿望卡与 `orchestra_report`，不推送 | — |
| 晨报 | 你设定时刻的例程（A19，M3）渲染隔夜各愿望的卡片 | — |

- **跨愿望合并**：所有愿望的 P1 推送每 30 min 合并为一条「愿望需要你：N 项」，按 `Wish.priority` 排序；条目在收件箱里仍逐条存在。审批、交接与 P0 不合并，照 r3 的规则即时通知（审批 30 min 即超时）。每小时被愿望打断的次数计入 §14 #3。
- 愿望卡由守护进程从 Task、Verdict、BudgetIncident、InboxItem 算出：状态、契约版本、已完成的 Task 分三项列出（「n 复核通过 · k 你确认 · j 同家族复核」）、当前 Task、`waitingOn`、花费与预算、待你处理的条目、最近一次 Verdict、`untaggedCalls`。agent 的叙述只作数据附上，永远不设定状态（DSH-D#10471；A16）。30 分钟摘要（M2）加一行愿望。你主要读的是主代理的聊天（§2.3），所以主代理乐手页上为每个进行中的愿望显示一条守护进程算出的状态条（例如「愿望 W12：3/7 已验证 · 等你 1 条」），愿望块也告诉主代理它不能宣布完成（推断）。

**界面用语**（说人话；标识符只出现在详情里）

| 内部 | 卡片上的话 |
|---|---|
| `waiting-human` | 在等你 |
| `unverifiable` | 没法自动确认，需要你看一眼 |
| `contradiction` | 要求之间互相矛盾，需要你定 |
| `tamper` | 改动碰到了不该改的测试 |
| `unknown` | 复核没给出可用的结论 |
| `paused(restart)` | 重启后停着，等你点继续 |
| `paused(cap:*)`、`paused(budget)` | 到上限了，等你决定加不加 |
| `paused(stall)` | 同一个问题连着两次没修好 |
| `refuted` | 复核没通过 |
| `reopened` | 你打回了 |
| `dispatchHeld: absent` | 派发已暂停：等你回来 |
| `gating` | 必须过的检查 |
| `stopWhen` | 什么时候自动停 |
| `plan-stale` | 代码在计划之外变了 |

### 6.10 有人值守 → 影子 → 无人值守

| 级别 | 你不在时推进器做什么 | 何时可用 |
|---|---|---|
| 有人值守（默认） | 不派新的执行 Task，也不发复核（`dispatchHeld: absent`）；在途 Task 跑到处置，越过 `wallCapMin` 或预约由运行时中断（本文 §6.4）；守护进程只做不执行任何代码的 L0。复核等你回来，因为契约命令（例如 `pnpm test`）会执行执行者刚写的代码、以你的用户权限运行，而原生 Windows 上 Claude Code 的 Bash 不在沙箱里（Q-P3）。将来若允许你不在时复核，至少要：被复核 Task 的执行乐章与输入都是 `clean`、每条命令都在精确放行规则里、没有网络、跑在真正的隔离边界里（无网络的 AppContainer、Windows Sandbox 或 WSL2 沙箱，推断） | v1 起。「在场」= UI 心跳**且** 30 min 内有一次你的 UI 操作（30 min 取审批超时，假设）；你常在 IDE 或终端里一待超过 30 min，所以 S-CU 测过 Q-C9 的非合成 Raw Input 后，建议改用它判在场；清除「不在」要一次 UI 操作，单有心跳不算。比 §10.14 只看心跳更严，因为它授权的是派发：开着的浏览器标签整夜都有心跳 |
| 影子 | 派发同有人值守。另在「免手窗口」（你在场但没有介入）里测量无人值守会遇到的风险：答复时间会超过 30 min 超时的审批数、每愿望小时撞到的人类专属步骤、每个无人监督小时的花费、非计划触点引起的 `humanInterrupts`。不用「预测的下一次派发与你的选择一致率」：推进器是确定性的，按已确认的计划派发，这个一致率按构造接近 100%，量不出风险（Q11 的影子期有效，是因为路由里有你的选择可比） | M4 起，由你逐项目开启；它不改变派发，所以没有前置门 |
| 无人值守（v1 之后） | 派发满足 Meta「至多其二」规则（Rule of Two，META2：不可信输入、敏感访问、改状态或对外通信三项至多占两项）的 Task，本文更严：乐章未被污染（去掉不可信输入；taint 是尽力而为的启发式，§8.5，门不能只靠它）；只改愿望的 worktree 并提交（没有 push、PR、部署、对外消息，它们一律 `waiting-human`）；执行者的能力只来自 DSH 沙箱模式，或 Claude 只读加精确放行规则（写租约只是建议性的，shell 编辑会绕过，§10.8）；每个无人值守 Task 之后对账所有项目根的 `git status`，未归因漂移即 `paused` + P1，并对该项目关闭这一级；本文新增：不用 Grant 与写类乐器（r3 §10.14 的在场规则在 R05 / R06 / R07 / R21 通过后本会放开，本文对愿望继续收紧）。Meta 自己承认后台进程不太适用这条规则。所有验证层照旧；愿望最终仍要你验收；重启照旧暂停 | 证据门与试运行通过后，在 v1 之后的里程碑里由你逐项目开启，可随时撤销 |

**证据门**（与 Q11、§14 对齐；阈值由你定，Q-P4）：
1. 零 token 用例 WP-1…WP-42（多数是事故回放）在假 harness 上全部通过（[W4] 含义 10 的做法）。
2. R05、R06、R07、R21 已落地（§3.2 原条件）。
3. 有人值守期已验证的 Task：假完成 = 被盲抽检或在同一 commit 上的重跑推翻的 `pass`（后来被别的 Task 弄坏的不算，那归最终重跑）。假完成率按 Wilson 95% 上界判（同 D9 的写法），上界不高于阈值，建议 5%（假设）；这要求约 74 个**被抽检**且 0 假完成的 Task（计算；50 个时上界约 7.1%），按 1:5 抽检约合 370 个已验证 Task（计算）。每个开启的项目至少 20 个被抽检的 Task（假设），因为复核质量取决于各项目的测试。只数被抓到的错会高估可靠性，所以盲抽检是分母；也抽少量 `refuted`，一致率才不只是精度；一致率建议 ≥90%（假设）；同家族 Verdict 单列；人类专属步骤的循环次数 = 0；预算超支 = 0（越界由运行时中断，本文 §6.4）；`humanInterrupts` 每愿望小时不高于你定的值；被你推翻的阻塞率不高于你定的值。
4. 约 10 个固定回归微愿望（每个 ≤1 h、≤5 CNY，假设；建在 §14 #4 Micro-DeepSWE 的设施上），每个跑 3 遍算 pass^3（TAU、A-EV；A-FOLD 的「约 10 个黄金样例、每个跑两遍」是起步下限）。门槛按个数写，例如「10 个里至少 k 个 pass^3」，k 由你定。n = 10 时一个愿望就是 10 pp，所以 A-NOISE 的「低于 3 pp 的差异不足为凭」在这里只提醒不要比较小差异。只在你在场时排。
5. 影子期至少 14 天（假设），免手窗口的累计时长由你定，指标达标，并抽读转录（A-EV）。
6. 试运行：在一次性项目或回归项目上真的无人值守跑至少 7 夜（假设），全量读转录；阻塞愿望的夜间失败 P1 延迟 ≤10 s（假设，对齐 R07 的 10 s）、无声停摆 0 次、重启自动恢复 0 次。之后才在真实项目开启。

### 6.11 边界与非目标

**边界**
- **Maestro**：M4 起可当规划者，交出的计划只是提议（影子）；计划未指定负责乐手时按 AutoRoute 路由（Q11 门槛照旧）；从不复核、从不判定完成，§9.2 第 7 步「拒绝模型自评」从路由标签推广到完成。
- **Arrangement**：推进器不跑用户脚本，也不启动 Arrangement 运行。M6 起只读模板（QA 复跑 ×N、对抗核验、评审裁决）可作复核，由你在愿望卡上点 Start 启动（Q-W1、§8.8 (h) 不变）；结果按本文 §6.5 映射成一条 `kind: template` 的 Verdict。Arrangement v1（不在 M6 内）的 `ask()` 在愿望相关的运行里让愿望进入 `waiting-human`；`ask()` 超时默认取消运行，愿望仍留在 `waiting-human`，不随之取消。两者共用 `requestId` 与预约的语义（§8.8 (b)(e)）。
- **Task**：仍是计划节点。harness 自己的计划（Claude Tasks、DSH todo、Codex `turn/plan/updated`）只作为观察到的 `source`（§6.1）。
- **原生 goal loop**：自有乐手一律关闭。DSH 的 `goal-round-driver`、`tool-goal`、`command-goal` 在 r3 §7.4 只关到非 user 来源投递落地（M3 bundle，或 S2 选 B 时更早），本文改为永久关闭，由 CI 检查组合后的 `cordis.yml`；Claude 自有乐章断言没有 `/goal` 与 ultracode（`/goal` 在 `hooks:'omit'` 的 SDK 会话里能否生效未测，[W1] §8；文档说 `/goal` 在非交互模式可用、`disableAllHooks` 为真时不可用，S3 时核实给自有乐章传 `disableAllHooks: true` 能否关掉它）；Codex 驱动落地时私有 `CODEX_HOME` 设 `features.goals=false` 并由 CI 检查（Goals 为 Stable 且默认开启：main@aa854da `features/src/lib.rs:2060-2065`；钉住的 `rust-v0.160.1` 为同文件 `:1704-1706`，2026-10-27 复核）。§8.7「一个乐手内带上限的 goal 循环」改为「推进器逐轮派发 + 独立复核」。

**非目标**
- 不做新的 agent loop、计划 DSL 或图形化计划编辑器。
- 不让任何 LLM 判定完成、进度或上限；不按空闲续跑；不自动重新规划。
- 不自动批准、不批量批准、不委托审批（含 Codex `guardian_subagent`）。
- v1 不建无人值守级（§3.2；本文 §6.10 只给解除路径）；v1 不在重启后自动恢复愿望；无人值守即使在 v1 之后开启，也不 push、开 PR、部署、对外发消息或使用 Grant。
- 不自动合并到 main；推进器不启动 Arrangement 运行。
- v1 愿望不跨项目：一个愿望一个 `projectId`；跨项目的需求拆成各项目一个愿望，在卡片上互相链接（推断）。v1 没有跨愿望的调度与依赖；`Wish.priority` 只给通知排序。
- 愿望的 `done` 是「契约满足 + 你验收」，不等于「可以合并」（METR-SWE：约一半测试通过的补丁不会被合并）。
- agent 不能创建愿望，只能提议；v1 推进器不扇出（每个愿望并发 1）；不做「整库上下文」（§2.3）。

---

## 7. 新模式、需求、决策与对 r3 的修订

### 7.1 模式 A40–A60

| # | 模式 | 来源 | 落地 | 零 token 验收 |
|---|---|---|---|---|
| A40 | **冻结、带修订的验收契约**：原话切分的 `askClauses`，3–5 条结果，验证分 gating / evidence，非目标，`stopWhen`；带摘要，执行者只读；改「做什么」= Decision | GB 规划器；HU 契约；A-LRH；IMP；CC#104037（目标文本允许「每项都有状态」） | 本文 §6.1；r3 §6.1；M1 | WP-24、WP-41 |
| A41 | **完成是判定**：任何 agent 都不能置 `done` 或改验收条款；证据分 accepted / missing / rejected / unverifiable | PC `native-status-arbitration.md:56-125`；ZC:192；`dsh-goal/README.md:159` | r3 §6.4、§8.6；M1 | WP-1、WP-19、WP-20 |
| A42 | **判定器失败即 `unknown`**：畸形、超时、结构化字段矛盾；首次自动重新复核，第二次暂停 | GB `InfraPaused` 对照 `_legacy`；ZC:294-298 反例；CC#103894 | M1 | WP-3、WP-35、WP-38、WP-42 |
| A43 | **确定性门先于 LLM，改测试即标记**：工作区干净、机器可读报告、闭包冻结 | HU `goals.md:136-152`；IMP；A-LRH | M1 | WP-2、WP-4、WP-22、WP-29、WP-30、WP-33 |
| A44 | **反棘轮复核**：带上轮 gap、标准不升高、只回逐条通过与否、提交次数有上限 | GB `goal_verifier_prompt.md:17`；METR-SOL（只作动机；推断，[W3] 含义 3，未经验证的设计） | M1 | WP-25 |
| A45 | **类型化阻塞出口**：blocked / impossible / contradiction / unverifiable → Decision，不计失败；须带证据 | IMP（GPT-5 在 Conflicting-SWEbench 上 54% → 9%，对 Opus 4.1 弱）；GB `:46` | M1 | WP-26 |
| A46 | **类型化等待与「已核实的等待」** | CX `continuation.md:22-25`；HU 30 min `wait`；OH#5355 | M3（M1–M2 只有 `reply` / `human`） | WP-10、WP-36 |
| A47 | **相同 gap 指纹两次即暂停** | GB `goal_tracker.rs:10-20` | M3 | WP-14 |
| A48 | **人类专属步骤一次性让出**；被拒后开 `blocker` Decision；你不在时同类审批只拒一次 | CC#100010、CC#98066、CX#50767；OC `goal.md:167-190` | M1 / M2（`handoff`、A5） | WP-6、WP-34 |
| A49 | **重启后暂停，你点才恢复；未知 → 暂停；计数不清零** | `dsh-goal-round-driver/README.md:57`；GB `goal_tracker.rs:1-6`；OC `goal.md:235` | M1（状态与闸门）/ M2（合成卡） | WP-9、WP-37、WP-39 |
| A50 | **预约式预算、再试下限、复核预算单列、越界由运行时中断** | SWA `reviewer.py:533-541`；OH#17691；A-HD；§10.3、§8.7 M3 | M1（`wallCapMin`）/ M2 | WP-13、WP-31、WP-37 |
| A51 | **计划修订绑定、精确一次分解** | PC `execution-semantics.md:395-463` | M3 | WP-15 |
| A52 | **每乐章逐字注入愿望块；守护进程生成交接笔记** | CX `continuation.md:5-7`；DSB `parts.js:388-397`；OAI-PLANS | M1 / M3 | WP-16、WP-23 |
| A53 | **类型化处置结算 Work** | HU `kanban_stop.py:1-30`；PC 修复额度；[spec] §8.1 `replyFormat` | M1 | WP-27 |
| A54 | **副作用键**（commit trailer、分支、PR） | TMP；G-RES（只作动机；推断，[W3] 含义 8，未经验证的设计） | M3 | WP-9 |
| A55 | **算出的汇报，不叙述**（含主代理页的状态条） | DSH-D#10471；A16 | M1（卡片 v0、状态条）/ M2（摘要行）/ M3（晨报例程） | WP-1 |
| A56 | **原生 goal loop 关闭，审批者钉为人** | [W1] 含义 2；CX#41838；`ApprovalsReviewer.ts` | M1 / M4 | WP-17 |
| A57 | **澄清访谈**：每问附推荐答案，成批一次 | V2EX t/1214285 | M1 | WP-28 |
| A58 | **人类停止覆盖整棵愿望子树**（含执行者建的提醒与 harness 自己的唤醒） | CC#101528、CC#64744、CX#45026 | M3 | WP-8 |
| A59 | **gating 检查由非执行者编写并冻结**：`specDigest`、`frozenFiles` 闭包；执行者加的测试只算 evidence；写测试的 Task 先红；L1 只认与契约逐字一致的命令、正确的 cwd 与 HEAD、干净的工作区 | CC#88271；IMP；METR-SWE；A-LRH；OAI-PLANS | M1 | WP-4、WP-22、WP-29、WP-30、WP-41 |
| A60 | **守护进程的愿望派发闸门与在场判定**：带 `taskId` 才派、改挂到愿望根、计数、你不在时暂扣；在场 = 心跳加近期 UI 操作 | CX#34248；CC#69213；[spec] §2.3 的上限前提；§10.14、Q-C9 | M1 | WP-7、WP-18、WP-21、WP-32、WP-40 |

### 7.2 需求 R61–R78

| ID | 需求 | 优先级 | 里程碑 | 依据 |
|---|---|---|---|---|
| R61 | 愿望实体与冻结契约（A40） | P0 | M1 | CC#76687、CX#19910 |
| R62 | 任何 agent 不能置 `done`；分层复核；判定器失败即 `unknown`；gating 检查由非执行者编写并冻结（A41–A44、A59） | P0 | M1 | CC#104037、ZC、MAST |
| R63 | 类型化处置与阻塞出口（A45、A53） | P0 | M1 | IMP；CX#41176 |
| R64 | 澄清批次与计划 Decision（A57） | P1 | M1（扁平 Task 列表）/ M3（Task 树） | CX#55484、V2EX t/1214285 |
| R65 | 计划 = Task 树 + 覆盖检查 + 精确一次分解（A51） | P0 | M3 | CC#88271；PC |
| R66 | 派发闸门（A60，M1）；推进器：事件驱动派发，不按空闲续跑，`from.kind: wish`（M3） | P0 | M1 / M3 | CX#34248、DSH-D#6169 |
| R67 | 回访 T 的临时默认值（M1）；类型化等待与指纹停滞（A46、A47，M3） | P0 | M1 / M3 | OH#5355；CC#104807；GB |
| R68 | 愿望预算：`rootId` 上卷、总额与每日切片、预约、再试下限、复核预算、每小时调用速率（A50） | P0 | M2 | OH#17691、CC#69213 |
| R69 | 人类专属步骤让出（A48）与停止主权（A58） | P0 | M1 / M2（`handoff`、A5）/ M3 | CC#100010、CC#101528 |
| R70 | 重启暂停（A49） | P0 | M1（状态、P1、闸门）/ M2（合成卡） | CC#104808、DSH-D#6067 |
| R71 | 注入与轮换：失败连击触发轮换、新乐章先跑冒烟（A52） | P1 | M1 / M3 | ILL；A-LRH |
| R72 | 夜间失败分类（认证、容量、配额），阻塞愿望时为 P1 | P1 | M2 | CC#104806、CX#57414、PC#10344 |
| R73 | 算出的愿望卡（v0）、主代理页状态条、摘要行与晨报（A55） | P1 | M1（卡片 v0、状态条）/ M2（摘要行）/ M3（晨报例程） | DSH-D#10471 |
| R74 | 原生 goal loop 关闭与审批者断言（A56） | P0 | M1（Claude / DSH）/ M4（Codex） | CX#41838；`ApprovalsReviewer.ts` |
| R75 | 自治分级（有人值守、影子）与证据门的测量（D20）；无人值守级在 v1 之后 | P1 | M1（有人值守，随 A60）/ M4（影子与证据门） | §3.2；Q11 |
| R76 | 愿望可靠性指标进 §14 | P1 | M1 起采集 | A-EV；TAU |
| R77 | 计划与进度产物的污染传递（扩展 E6） | P1 | M2 | METR-HF；§8.5 E6（推断，[W3] 含义 10，未经验证的设计） |
| R78 | 副作用键与集成分支（A54） | P1 | M3 | TMP、G-RES；§10.8 |

### 7.3 决策

| ID | 决策 | 否决的方案 | 理由与证据 |
|---|---|---|---|
| D19 | **愿望层：完成是判定，推进由事件驱动，状态在守护进程。** 愿望 = `rootId` + 冻结契约 + Task 树；任何 agent 都不能置 `done`；推进器只按事件派发，每个愿望并发 1、不扇出（M3 起；M1–M2 由守护进程的派发闸门约束主代理）；自有乐手里原生 goal loop 一律关闭 | harness 原生 goal loop 当推进器；LLM 自判进度或完成；计划放在会话上下文里；Maestro 判定完成 | Claude `/goal` 只读对话记录、DSH `complete` 无门槛、Codex 不校验来源（[W1]）；hermes 判官失败即继续，MO 的完成与进度由编排 LLM 自判（[W2]）；CX#19910；§9.2 第 7 步 |
| D20 | **自治分级。** 有人值守为默认，你不在时不派发、不复核，越界由运行时中断；影子（派发不变，另在免手窗口里测量无人值守的风险）由你逐项目开启；无人值守在 v1 之后、证据门与试运行之后由你逐项目开启，只派满足「至多其二」规则（更严）的 Task；v1 重启永不自动恢复 | Claude / Codex 式恢复即重新武装；Devin 式默认自动批准；按空闲续跑；一次性全局开启 | DSH 的解除武装规则；META2；CC#104808；§3.2 |

### 7.4 对 r3 的修订清单

| § | 修订 |
|---|---|
| §0.1、§0.7 | 加一条愿望层摘要与 Q-P1–Q-P10 |
| §1.2 | 更正：Ralph 的 `maxRounds` 默认 256，但 Ralph bundle 启用时设为 64（`dsh-experimental-ralph-bundle/cordis.patch.yml:16`）；goal round driver 的 256 不变 |
| §3.2 | 按 Q-P3 的答案二选一，答之前不改 §3.2。不允许（本文建议）：「v1 不做无人值守的自治模式」后加定义「有人值守 = 你在场时才派发执行 Task；你不在时只把在途 Task 跑到处置，越界由运行时中断，复核等你回来」。允许：同一定义，再加「你不在时可在隔离边界内复核已结算的 Task（条件见本文 §6.10）」。两种都写：无人值守级在 v1 之后、证据门与试运行通过才建（本文 §6.10） |
| §4 | 加 D19、D20 |
| §5.2 | 组件表加「推进器」（orchestrad 内的确定性组件，M3）与「愿望派发闸门」（M1）；写围栏不变：分支、提交与集成都由执行者用自己的工具做，守护进程只用只读 git（`git --no-optional-locks status`、`rev-parse`、`log`）核对 |
| §6.1 | 加 Wish、WishContract、Verdict（M6 起可为 `kind: template`）；Decision 加 `wishId`、`kind`（含 `contract-rev`、`plan-rev`、`split`、`route`、`blocker`、`tamper`）、`choice.source`；Task 加 `wishId`、`clauses`、`paths`、类型化 `acceptance`、`milestone`、`dispatchAttempt`、`verifySubmissions`、`verdictRef`、`estHumanMin`、`wallCapMin`、Task 级 `pausedReason`，`roundCap` 按原义保留（计划里设定；愿望里只数执行者导致的重派）；Work 加 `disposition`、`waitingOn`；Part `endReason` 加 `review-done`；Exchange `from.kind` 加 `wish`；LedgerEntry `purpose` 加 `verify`、`plan`、`coordinate`；Reminder / Routine 与 ArrangementRun 加 `rootId`、`wishId`；Task 表从 M3 提前到 M1 建表 |
| §6.3 | 拒绝码表：`relay-source-missing` 也用于 `from.kind: wish` 的派发（M3；S2 选 B 时更早）；新增 `wish-untagged`（M1） |
| §6.4 | `in-review → done` 只能由当前版本的 Verdict 或你推动；新增 `waiting`（核实的等待不触发 `stale`）、类型化 `blocked`、Task 级 `paused` |
| §6.5、§11.2 | 新种类 `wish-paused`（P1，原因限重启、停滞、上限、判定器故障；同一次重启合成一条）；其余愿望事件按本文 §6.9 的映射表各对应一条已有种类：预算暂停复用 `budget-incident`，`wallCapMin` 越界复用 `timedOut`，阻塞愿望的认证或容量失败复用 `failure` 并升为 P1，`stall(3)` 复用 `stalled-delegation`，都不另出 `wish-paused`；`bounce` 仍为 P2，愿望因此卡住时作为卡住它的条目升为 P1；`waiting-human` 不出新种类，卡住它的条目升为 P1；`clarify` / `plan` / `blocker` / `tamper` 类 Decision 为 P1（你转成的 decision 仍 P2，agent 创建的仍 P3）；愿望级 `ready-for-acceptance` 复用 `ready-for-review` 种类，为 P2（Task 级仍 P3）；愿望的 P1 推送每 30 min 跨愿望合并一次（审批、交接、P0 除外）；分组以 Q10 为准 |
| §7.4 | 自有 Claude 乐章断言无 `/goal` 与 ultracode；愿望 Exchange 只投给以「愿望档案」启动的乐章（`disallowedTools` 在乐章启动时固定），档案去掉排程类工具与后台 Bash；私有 DSH home 设 `tool-jobs.completionDelivery: quiet`（`maxConsecutiveWakes` 不能为 0）；M3 bundle 在 `agent/turn-stopping` 上加回合上限（推断）；DSH 的 `goal-round-driver`、`tool-goal`、`command-goal` 由「关到非 user 来源投递落地」改为永久关闭，CI 检查组合后的 `cordis.yml`；Codex 私有 home `features.goals=false`，每次 `thread/start` / `turn/start` 断言 `approvalsReviewer == "user"`；S2 加一项：在 `workspace-write` 与 `read-only` DSH 沙箱里跑契约的 gating 命令 |
| §8.1 | `from.kind` 加 `wish`（守护进程为愿望发出的 Exchange：M1 起复核与「下一步」通知，M3 起派发）；`replyFormat` 的 schema 校验与一次修复回合提前到 M1，用于愿望的处置、Verdict、澄清与计划 |
| §8.3 | 规则 1：只有叙述的结算走 `replyFormat` 的一次修复后出条目；规则 7：`from.kind: wish` 的 Exchange 不计入每 root 20，改计愿望的 `calls(n)`（同 `arrangementCalls`），执行者在一次愿望派发之下的转发以该派发为计数子根（推断）；规则 8：愿望 Task 的截止 = `wallCapMin`，越界时运行时中断该回合（同 §10.3、§8.7 M3），回复等待期间暂停计时；规则 11：T 取 30 min → 1 h → 每 2 h 作 M1 临时默认值（推断），累计 3 次停滞升级不变（M3），「无进展」排除已核实的等待、计入空续跑，愿望 Exchange 的回访是守护进程自己的评估，不给执行者发消息；新增派发闸门（M1）：愿望运行期间，主代理发给该项目内可写乐手的请求与处理愿望 Exchange 的乐章发出的请求受它约束，发给 Task 负责乐手的须带 `taskId` 并改挂到 `Wish.rootId`，上一个 Task 没有 Verdict 或愿望暂停时拒绝派发，你不在时一律暂扣（A6 的 hold 在 M3，这是一处窄的提前）；R08 对愿望 Task 的轮次与打回强制由 M3 提前到 M1（经闸门） |
| §8.5 | 把 `trust` 映射到 Claude `SDKMessageOrigin`：只有你在 UI 里亲手发的才是 `human`，A2A 投递为 `peer` 或不标注（CC-SDK `typescript.md:2414-2440`），列入 R34 的验收 |
| §8.6 | 加 `orchestra_propose_wish`（只生成 Decision，计配额）；对带 `wishId` 的 Task，`orchestra_update_task` 只能改备注与进度 ref，改 `status`、`acceptance`、`clauses`、`paths`、`milestone`、`verdictRef`、`wishId`、`contractRev` 一律拒绝，工具错误码 `wish-field-immutable`（M3；它是工具错误，不进 §6.3 的邮局拒绝码表）；`working → in-review` 只经处置，`in-review → done` 只由守护进程（凭合格 Verdict）或你的 UI 动词；规划与复核走 `replyFormat` schema，不新增工具；带 `wishId` 的澄清 Decision 不占每乐手每天 5 条的配额，改为每愿望 ≤7（假设，只一轮） |
| §8.7 | 失败归属里「一个乐手内带上限的 goal 循环」改为「推进器逐轮派发 + 独立复核」；工作流 `budget` 一项：二进制显示它是该回合的输出 token 目标、与主循环共用的硬上限，未设目标时 `remaining()` 为 `Infinity`（CC-BIN@276779707，仅见于二进制） |
| §8.8 | (d) 词表扩展：加 `gapRepeat(2)`、`blockRepeat(2)`，愿望里 `calls(n)` 按本文 §6.7 的定义，其余原样；M6 的对抗核验模板可作愿望的复核者，由你点 Start 启动（Q-W1、(h) 不变），建议它采用三人冷面板多数（本文提议），结果映射成一条 `kind: template` 的 Verdict；Arrangement v1 的 `ask()` 让愿望进入 `waiting-human`，超时取消运行时愿望不取消 |
| §9.1、§9.2 | Maestro 可提议计划；第 7 步的「拒绝模型自评」推广到完成判定；计划里的负责乐手须过第 5 步的硬过滤，并满足第 9 步的 `handoffAcl`（A11） |
| §10.2 | 预约推广到愿望派发；复核预算单列；每小时调用速率；`waiting-human` 期间释放预约；项目日上限到了记 `waitingOn: time`；愿望预算默认取项目策略 |
| §10.3、§10.4 | 自有会话的运行时中断推广到越过 `wallCapMin` 或预约的愿望回合（M1 起只用于愿望，本文提前）；轮换新增失败连击触发与冒烟检查；复核用的一次性乐章 `endReason: review-done`，不计每小时轮换上限；夜间失败分类 |
| §10.7、§10.12 | 加行（本文 §6.7 上限一览）：`roundCap` 原义不变，愿望里只数执行者导致的重派，默认 3（假设）；每 Task `verifySubmissions` ≤3（假设，跨复核者合计）；里程碑重跑 1 次另计；`gapRepeat` 2、`blockRepeat` 2；愿望 `calls` = 4 × Task 数 + 里程碑数，受项目策略封顶（假设）；愿望每小时调用 6（假设）；Task 墙钟 60 min（假设）；`waitingOn.cap` 对回复等待到 `stall(3)` 为止，其余默认取 `wallCapMin` 与 30 min 中较小者（假设）；R08 对愿望 Task 提前到 M1 |
| §10.9 | 计划确认不是审批；愿望卡聚合显示，不批量批；你不在时超时的审批记 `denied(reason: absent)`，不计入 A5，并标「不在时已拒」：你仍不在时同类请求立即自动拒绝、不出新条目（只拒不批，同 §8.8 (f)）；审批被拒后开一条 `blocker` Decision；计划卡建议的放行规则带 `wishId`，随愿望结束撤销 |
| §10.14 | 本文新增：无人值守愿望不用 Grant 与写类乐器，即使 R05 / R06 / R07 / R21 通过；愿望派发的「在场」比心跳更严（本文 §6.10） |
| §11.6 | 愿望块与 ADR 一起注入；agent 起草的 `ask` 以「提议（由 X 起草）」注入 |
| §13 | 见本文 §8；§13.3 交付物加愿望 lite（含派发闸门、schema 回复、愿望卡 v0、重启暂停）；M1 削减顺序去掉「QA 乐手模板」 |
| §14 | 加第 12 行（见下）；第 3 行「每小时干预次数」里单列愿望触点 |
| §16 | R09 的任务表从 M3 提前到 M1 建表（CAS 板与重新分派仍 M3）；加 R61–R78 |
| §17 | 「也要确认」一行里 R29 的 T 由本文给出临时默认值；Q-W1 不变（推进器不启动 Arrangement）；加 Q-P1–Q-P10 |
| 附录 E、附录 F | 加 A40–A60（带零 token 验收列）、WP-1…WP-42 |

§14 第 12 行（新）：**愿望可靠性**。方法：每个愿望自动记录。指标：假完成率（`pass` 后被打回，按 Wilson 上界报告，分母含盲抽检）、`done → reopened` 率、复核与你的一致率（同家族 Verdict 单列）、`unknown` 判定数、人类专属步骤循环次数（目标 0）、`humanInterrupts`（每愿望小时，按种类）、被你推翻的阻塞率、`untaggedCalls`、`heldMinutes`、超出 `Task.paths` 的 diff 数、预算与调用的预估对实际、每个已验证 Task 的 token 与 CNY、回归微愿望集的 pass^3 与每轮 CNY。何时：M1 起采集，M4 起用于本文 §6.10 的证据门。

---

## 8. 里程碑影响（全部为推断）

| 里程碑 | 愿望层新增 | 增量 |
|---|---|---|
| M1 | 愿望 lite：Wish 与契约（含 `askClauses` 覆盖检查）、澄清批次、计划 Decision（扁平 Task 列表，主代理乐手派发，卡片也内嵌在主代理页）、守护进程的派发闸门与在场判定（A60：改挂到愿望根、「下一步」唤醒、上一个 Verdict 之前不派下一个）、愿望块注入、`replyFormat` schema 回复与一次修复回合（处置、Verdict、澄清、计划）、非执行者写的冻结 gating 检查（闭包、先红、干净工作区、机器可读报告）、QA 模板当复核者（非作者、新乐章 `review-done`、失败即 `unknown`、首次自动重新复核）、`waiting-human` 让出（`blocker` Decision、你不在时同类审批只拒一次）、`wallCapMin` 越界的运行时中断、最小的 `paused(restart)`、回访 T 的临时默认值、愿望卡 v0 与主代理页状态条（分项已完成、当前 Task、待你处理）、Claude / DSH 原生 goal 关闭断言与 DSH `completionDelivery: quiet`、指标采集 | +2–2.5 周 |
| M2 | 预算上卷与预约（含越过预约的运行时中断）、复核预算、每小时调用速率；重启合成卡；A5 拒绝与 `handoff` 接入愿望；夜间失败分类与 P1；摘要里的愿望行与跨愿望 P1 合并；产物污染传递 | +0.5–1 周 |
| M3 | Task 树计划、覆盖检查、精确一次；推进器；类型化等待；指纹停滞；停止覆盖子树（含提醒的 `rootId`）；副作用键与集成分支；计划过期处理；`orchestra_update_task` 的字段限制；失败连击轮换与冒烟；晨报例程 | +1.5–2 周 |
| M4 | Maestro 提议计划（影子）；影子级的免手窗口测量；Codex 的 goal 关闭与审批者断言（随 Codex 驱动，取决于 Q1） | +0.5 周 |
| M5 | 回归微愿望集与 pass^3 评估（每轮花费写进评估报告）；愿望运行导出 | +0–0.5 周 |
| M6 | 对抗核验模板接为高成本愿望的复核者（你点 Start）；复审无人值守门（无人值守级本身在 v1 之后另立里程碑、另行估算） | 计入 M6 的 4–6 周，约 +0.5 周 |

- **合计**：M0–M5 约 +4.5–6.5 周。含 Tier 2 的基准由约 33–35.5 周变为约 37.5–42 周；S-CU 不通过时的退回标尺由约 30–32 周变为约 34.5–38.5 周。M6 仍在 go/no-go 之后另计。
- **M1 自身可用**：你许一个愿，主代理乐手澄清并提出契约，你确认一次，乐手干活，QA 乐手复核，愿望卡 v0 与主代理页的状态条告诉你哪几条已验证、哪几条在等你。
- **削减顺序**：影子级测量 → 晨报例程（摘要里的愿望行保留）→ Maestro 计划提议 → 回归微愿望集 → 副作用键与集成分支（R78；同时把无人值守门顺延，并保持每个仓库根一个活跃愿望）。
- **不能削减**：任何 agent 不能置 `done` 与失败即 `unknown`；契约冻结与注入；派发闸门与在场判定（推进器若延期，M1 的闸门照样约束主代理，D19 的事件驱动条款延期到推进器落地）；`waiting-human` 让出；重启暂停；越界的运行时中断；预算上卷；停止主权；QA 模板（不进 r3 的 M1 削减顺序，本文 §7.4）。

---

## 9. 零 token 验收用例 WP-1…WP-42

全部跑在假 harness 上（`claude-fake-sdk`、mock ACP agent、`codex-fake-app-server`，加一个假 CI 接口），属于 D12 的零 token 契约 CI。

| 编号 | 用例 | 关联 | 里程碑 |
|---|---|---|---|
| WP-1 | 执行者回复「全部完成」、处置为 `done` 但没有证据引用 → Task 停在 `in-review`；以执行者身份推动 `done` 的次数为 0；主代理在聊天里说「全部完成」而只有 3/7 已验证 → 主代理页的状态条仍显示 3/7，愿望不变 `done` | A41、A55、R62 | M1 |
| WP-2 | 执行者在文件里写 `"ci": "PASS"`，复核者对假 CI 的查询（记录在 Event）返回 failure → Verdict `refuted`，愿望不进 `ready-for-acceptance`；复核者若只引用执行者的文件而没有自己的查询记录 → `missing`（CC#104037） | A43 | M1 |
| WP-3 | 复核者返回畸形 JSON、超时、或理由承认满足而结论为否 → 记 `unknown`，Task 保持 `in-review`，不推动 `done`；条目数按 WP-35（第一次 0 条并自动重新复核，第二次 1 条 P1）（ZC、CC#103894） | A42 | M1 |
| WP-4 | diff 触及 `frozenFiles` 或契约列出的约束文件 → 记 `tamper`，开 1 条 `tamper` Decision（P1），愿望 `waiting-human`，没有你的点击不能 `pass`；执行者新加的测试只算 evidence，不能让 gating 通过（IMP） | A43、A59 | M1 |
| WP-5 | 执行者空闲、没有任何待处理事件，假时钟走 10 h → 新派发 0 次；空续跑计入停滞（CX#34248） | R66、A9 | M3 |
| WP-6 | M1：被你拒绝的审批或 Decision 卡住下一步 → 开 1 条 `blocker` Decision（P1），愿望 `waiting-human`，假时钟 24 h 内再提示 0 次、重派 0 次；你在 `blocker` 上选「跳过此 Task」后才退出 `waiting-human`；拒绝只记一次。M2：下一步需要 OAuth 交接，或同一 `rootId` 下出现 A5 记过的同类动作 → 同上，交接走 `handoff`；超时的审批不计入 A5（CC#100010、CC#98066） | A48、A5 | M1 / M2 |
| WP-7 | `stopWhen = calls(4) \| stall(3)` → 第 4 次调用（按本文 §6.7 的定义计数）之后不再发出第 5 次，愿望进入 `paused(cap:calls)` + 1 条 P1，与复核者意见无关（CC#103908）；M1 由派发闸门计数 | R62、A60、`meta.stop` | M1 |
| WP-8 | 暂停愿望时有 2 条排队的 Exchange、1 个待触发例程、1 条执行者经 `orchestra_remind` 建的提醒和 1 个执行者排的 harness 定时唤醒 → 续跑 0 次、例程与提醒撤销、排队撤回、唤醒回合 0 个；你恢复前不重新武装（CC#101528、CC#64744） | A58 | M3 |
| WP-9 | M1：Task 进行中杀掉守护进程 → `paused(restart)` + 1 条 P1；(b) 的续跑回合在暂停期间返回 `done` 处置 → 入账，但复核派发 0 次、新 Task 派发 0 次，直到你点继续；(b) 续跑的假 Claude 乐章收到的 `maxBudgetUsd` 等于账本算出的剩余预约，崩溃结果的花费字段为 0 时按估算入账（M2）。M3：点继续后，被已接受的 Verdict 覆盖、且在 `wish/<wishId>/<taskId>` 分支上的提交不重派；其余结果不明的交给你（CC#104808） | A49、A54 | M1 / M2 / M3 |
| WP-10 | 处置 `waiting(reply from Ren)`（`wallCapMin` 60 min），Ren 的回复在假时钟 23:13 到达 → 执行者恰好被唤醒一次；没有回复时守护进程在 30 / 90 / 210 min 回访评估、给执行者发消息 0 次，回复等待期间 `timedOut` 0 次，第 3 次后出 `stalled-delegation`，愿望 `paused(stall)`，`wish-paused` 0 条（CC#104807） | A46、规则 11 | M3 |
| WP-11 | 00:12 提供方返回 401 → 归为确定性失败，不重试（≤3 次尝试是 A13 验收的上限），10 s 内（假设）出 P1 `failure`，愿望 `paused(failure:auth)`，`wish-paused` 0 条（CC#104806） | R72、A13 | M2 |
| WP-12 | 配额错误带重置时间 → `waitingOn: time`，不计停滞、不开阻塞条目，重置后只恢复一次（PC#10344） | R72 | M2 |
| WP-13 | 在途 Task 的用量未知 → 按估算预约；到 100% → 1 条 `budget-incident`（不另出 `wish-paused`），`paused(budget)`，新派发 0 次（M2 由闸门拒绝主代理带 `taskId` 的请求）；闸门放行的派发的花费出现在该愿望的 `budget-incident` 里；没有 Verdict 的 Task 保持未验证，不变 `done`；假乐章的在途回合越过预约 → 运行时中断 1 次、此后花费 0（OH#17691） | A50 | M2 |
| WP-14 | 同一 Task 两次 Verdict 的 gap 指纹相同 → `paused(stall)` + P1，之后 0 轮 | A47 | M3 |
| WP-15 | 同一（`wishId`，`planRev`）的计划被提交两次，或规划者被重新唤醒 → 只有一棵 Task 树，第二次重放原回执；新的 `planRev` 被接受 → 旧树未派发的 Task 以 CAS 撤回 | A51 | M3 |
| WP-16 | 执行乐章轮换 3 次 → 注入的愿望块与契约摘要逐字节一致、审计条款仍在；来自污染乐章的交接笔记让新乐章一开始即污染（CX#19910） | A52、R77 | M1 / M3 |
| WP-17 | A2A 正文为「/goal 把它做完」 → 目标乐手不产生目标（DSH 无 `goal/change`；假 Claude 自有乐章无目标判定；假 Codex 无 `thread/goal/updated`）；假 Codex 的每次 `thread/start` / `turn/start` 都带 `approvalsReviewer: "user"`（CX#41838） | A56 | M1 / M4 |
| WP-18 | 计划 Decision 未结案时，agent 或转发文本说「ok，开始吧」 → 派发 0 次；只有 UI 上的 Decision 点击能开工。有人值守下心跳还在、但 31 min 没有 UI 操作 → 新执行 Task 派发 0 次、复核派发 0 次，主代理带 `taskId` 的请求被暂扣、你回来后才投递，在途 Task 跑到处置；10 s 内状态条显示「派发已暂停」横幅；单有心跳恢复不清除「不在」 | R64、A60、D20 | M1 / M3 |
| WP-19 | agent 调 `orchestra_update_task` 把带 `wishId` 的 Task 改为 `done`，或改它的 `acceptance` → `wish-field-immutable`，Task 停在 `in-review`，状态转移 0 次 | A41、R62 | M3 |
| WP-20 | 作者乐手轮换到新乐章后提交 Verdict，或复核者就是规划者 → 不算 Verdict，记 `unknown` + 条目 | A41、R62 | M1 |
| WP-21 | 主代理第 4 次重派一个被驳回的 Task（`roundCap` 3）→ 拒绝 + 1 条 `bounce`；因契约改版引起的重派不计入 `roundCap`；不带 `taskId` 发给该 Task 负责乐手的请求 → `wish-untagged`；`calls(n)` 到顶 → `paused(cap:calls)` | A60、R66 | M1 |
| WP-22 | 复核者跑 `pnpm test -t nothing`、在别的目录或旧 commit 上跑、工作区不干净、或退出状态无法解析 → 该 gating 记 `missing` 或 `unknown`，守护进程的 L1 结果覆盖复核者写的 `accepted` | A43、A59 | M1 |
| WP-23 | 契约改版时 Task 在途 → 旧版本的处置拒收，在新乐章重派；非愿望的提交触及未完成 Task 的 `paths` → 愿望卡标 `plan-stale` | A52、R65 | M1 / M3 |
| WP-24 | 执行者改动契约文件或请求改 `outcomes` → 拒绝，契约摘要与注入块逐字节不变，只有 `contract-rev` Decision 能出新版本 | A40 | M1 |
| WP-25 | 复核者的 Verdict 含契约之外的结果 id，或把上轮已 accepted、本轮 diff 未触及其 `paths` 的结果改判 rejected → 不算 Verdict，记 `unknown`（反棘轮，GB） | A44 | M1 |
| WP-26 | 处置 `impossible` 不带证据引用 → 1 次修复，再缺即 `null` + 1 条条目；带证据 → 1 条 `blocker` Decision，失败标签 0 个；同一 Task 的阻塞被你推翻两次 → 1 条轮换或改派提议 | A45 | M1 |
| WP-27 | 处置 JSON 畸形 → 恰好 1 次修复回合，再畸形记 `null` + 1 条条目，Task 不 `done` | A53 | M1 |
| WP-28 | 已答的澄清问题在后续 Decision 里以相同题干摘要再出现 → 不出新卡，返回已定答案 | A57 | M1 |
| WP-29 | 执行者把 `package.json` 的测试脚本改成 `exit 0` → `tamper`；运行器带 `passWithNoTests`、执行数为 0 → `missing` | A43、A59 | M1 |
| WP-30 | 执行者 cwd 里有未跟踪的 `vitest.setup.ts` 桩，或对冻结测试有未提交的改动、HEAD 不变 → 处置时 L0 `missing`，复核时才出现则 L1 `unknown`，从不 `accepted` | A43、A59 | M1 |
| WP-31 | 假 DSH 回合越过 `wallCapMin` → 运行时 cancel → close → resume 1 次、此后花费 0、1 条 `timedOut`（P1）、`wish-paused` 0 条、只有该 Task 暂停；假 Claude 乐章累计花费到 `maxBudgetUsd` → `error_max_budget_usd`，愿望暂停，下一条 Exchange 投给新乐章 | A50 | M1 / M2 |
| WP-32 | 你不在时主代理把未标记的活发给项目内非负责的可写乐手 → 暂扣、投递 0 次、`untaggedCalls` +1；执行者在处理愿望 Exchange 时转托他人 → 请求继承 `wishId` 并计数；计划把规划者设为 Task 负责乐手 → 计划校验不过 | A60 | M1 |
| WP-33 | 复核者引用的 CI run 的 `headSha` 不等于被复核的 commit → `missing`；计划把 `ci` 设为 Task 级 gating → 计划校验不过 | A43 | M1 |
| WP-34 | 你不在时执行者 4 次请求 `git push` → 1 条审批（超时拒绝）、其余 3 次立即自动拒绝且不出条目；回合结算后 Task `waiting-human`，恰好 1 条 `blocker` Decision | A48 | M1 |
| WP-35 | 第一次 `unknown` → 在新乐章上自动重新复核 1 次、条目 0 条；同一 Task 第二次 `unknown` → `paused(verifier-infra)` + 1 条 P1 | A42 | M1 |
| WP-36 | M1：处置 `waiting(ci)` → 给你 1 条提醒，唤醒执行者 0 次；M3：重启时有 `process` 等待 → 记 `unknown`，愿望 `paused(restart)` | A46 | M1 / M3 |
| WP-37 | `calls(4)` 到顶后不填新上限就点继续 → 仍 `paused(cap:calls)`；重启后计数不清零 | A49、A50 | M1 |
| WP-38 | 同一 QA 乐手一小时内复核 5 次 → `rotation-breaker` 0 条 | A42、§10.4 | M1 |
| WP-39 | `awaiting-plan` 时重启，点继续 → 仍 `awaiting-plan`，派发 0 次；你在 `awaiting-plan` 打回计划 → 回到 `planning` | A49 | M1 |
| WP-40 | M1–M2：Verdict 落地 → 主代理恰好收到 1 条「下一步」Exchange；主代理在上一个 Task 的 Verdict 之前派下一个 → 拒绝 | A60 | M1 |
| WP-41 | 原话里有一条 askClause 没有映射到任何结果 → 计划校验不过，计划卡标出这一条；写测试的 Task 冻结的测试在实现之前的 HEAD 上就通过 → 该 Task `refuted` | A40、A59 | M1 |
| WP-42 | 三人面板：2 个 accepted、1 个畸形 → 该结果 accepted；1 个 accepted、1 个 rejected、1 个 unverifiable → 没有严格多数，记 `unknown` | §8.8、A42 | M6 |

---

## 10. 风险与开放问题

### 10.1 风险与对策

| 风险 | 对策 |
|---|---|
| 复核者也是 LLM：偏宽、被说服、与作者同家族互相偏袒（A-HD、SP） | 确定性门先行；换模型家族；你抽检；一致率进证据门 |
| 复核会显著增加成本（推断；参照：A-MARS 多 agent 约为聊天的 15 倍 token，A-HD 完整 harness 约为单 agent 的 20 倍成本，都不是复核本身的增量；复核的份额用 M1 账本数据测） | 复核预算单列；Task 级复核只跑该 Task 的 gating，里程碑边界整体重跑一次；便宜的门先跑 |
| 问你太多，重蹈审批疲劳（A-AUTO 93%）；对 A2A 优先、同时推几个应用的你尤其如此 | 主动通知只有三类（本文 §1 立场 5），其余进收件箱与摘要；`humanInterrupts` 按种类计入指标与证据门；P1 推送跨愿望每 30 min 合并一次，按 `Wish.priority` 排序（审批与 P0 除外，本文 §6.9）；滚动式规划与自适应抽检；卡片内嵌在主代理页；`tamper` 只看冻结的闭包；拆分只在计划时提；抑制「要不要继续」；Claude 执行者用契约命令的精确放行规则、DSH 用沙箱减少审批（A-SBX 在原生 Windows 上不适用，DSH 沙箱能否跑测试由 S2 测；先用 M1 数据估算每愿望小时的审批数，再声称能降多少） |
| 契约本身写错 | 改「做什么」走 Decision；`contradiction` 出口；复核者拿到契约 diff |
| 推进器长成第二个工作流引擎 | 不跑脚本、不做循环（只有打回 N=3）；v1 每个愿望并发 1；扇出留给你启动的 M6 Arrangement（D13 不变） |
| 模型探测评分器（METR-SOL、IMP） | 只回逐条通过与否；提交次数上限；`tamper` 标记 |
| 计划文件成为长程注入载体（METR-HF；OAI-ATLAS 未核实） | 污染传递；污染输入改出的计划需你重新确认 |
| 用 80% 地平线给里程碑定大小只是推断；约 1 h 的数值来自 METR 镜像（未核实） | 规划只用人类时长估计 `estHumanMin`，过大只在计划时提拆分；`wallCapMin` 是独立的失控上限，可按模型调整 |
| `/goal` 在 `hooks:'omit'` 的 SDK 会话里是否生效未测（[W1] §8） | 断言 + WP-17 的 Claude 用例；S3 时核实传 `disableAllHooks: true` 能否关掉 `/goal`（文档说它在 `disableAllHooks` 为真时不可用） |
| 在途回合越过预约或 `wallCapMin`（OH#17691 一类） | 运行时中断，同 §10.3 与 §8.7 M3（本文 §6.4）；Claude 的 `maxTurns` 每条消息重计，`maxBudgetUsd` 按整段对话累计，只作内层兜底；DSH 没有单回合上限，M3 bundle 在 `agent/turn-stopping` 上补（推断） |
| 同一仓库里几个愿望或你自己的提交互相踩 | 每个仓库根一个活跃愿望；集成分支；`plan-stale` 标记（本文 §6.6） |
| 工期 | 削减顺序（本文 §8）；M1 的愿望 lite 自身可用 |

### 10.2 开放问题 Q-P1–Q-P10

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-P1 | 愿望最终完成是否总要你点验收？ | 总要 / 全部 gating 为确定性检查时可自动结案 | 总要；自动结案等证据门之后再议 | M1 开始前 |
| Q-P2 | 改「怎么做」（同一契约下重排 Task）算不算规则 11 的「重新规划」？ | 算（每次你确认）/ 不算（推进器可在同一契约内重排，需修订规则 11） | 算（本文解读，一键 diff 卡）；任何自动重排都要先有证据，再作为对规则 11 的修订单独提出 | M3 开始前 |
| Q-P3 | 「在场」怎么判定？你不在时是否允许复核？ | 心跳 / 心跳 + 30 min 内一次 UI 操作 / 非合成 Raw Input（Q-C9）；复核：不允许，等你回来 / 允许，但只在真正的隔离边界里（本文 §6.10 的条件） | 心跳 + 30 min 内一次 UI 操作，S-CU 测过后改用非合成 Raw Input；不允许你不在时复核，直到 L1 有隔离边界（契约命令会执行执行者写的代码，原生 Windows 上 Claude 的 Bash 不在沙箱里）；在途 Task 总能跑到处置，越界由运行时中断；本文 §7.4 的 §3.2 行按这里的答案写 | M1 开始前 |
| Q-P4 | 证据门的阈值 | 假完成率的 Wilson 上界、一致率、每项目最少抽检数、回归微愿望 pass^3 的 k、`humanInterrupts`、推翻阻塞率、影子期长度、试运行夜数 | 5%（约 74 个被抽检的 Task，1:5 下约 370 个已验证 Task）、≥90%、每项目 ≥20 个、k 由你定、14 天、≥7 夜（均为假设） | M4 开始前 |
| Q-P5 | 复核乐手用哪个 harness 和模型？复核预算占多少？ | 同家族 / 换家族；比例 | 与作者换家族（DSH 作者 → Claude 复核；Claude 作者 → DSH 复核，从 M3 起）；若 S2 显示 DSH 沙箱跑不了测试（EPERM，§7.4），DSH 复核者只做 L2，L1 交给 Claude 复核者或你；同家族的 Verdict 单列统计；比例由 M1–M2 数据定 | M1 开始前 |
| Q-P6 | 愿望预算默认值 | 每愿望总额与每日切片、墙钟、每小时调用、`calls` 上限 | 总额默认取项目策略的每愿望上限，规划者的预估只并排显示，超过上限的计划不通过；每日切片不超过项目日上限（§10.12 的 20 CNY，假设），到了记 `waitingOn: time`；`calls` = 4 × Task 数 + 里程碑数；每小时 6 次调用（均为假设）；计划卡上由你确认 | M2 开始前 |
| Q-P7 | 计划卡上的契约命令放行规则是否提供？ | 提供（只对 Claude，独立勾选，改权限档案）/ 不提供 | 提供，只对 Claude，用与 QA 模板相同的精确命令串；DSH 只靠沙箱模式（D8、§8.8 (f)）；永不随「接受计划」默认生效 | M1 开始前 |
| Q-P8 | 谁来规划？ | 主代理乐手 / Maestro / 新的规划模板乐手 | M1–M3 主代理乐手，M4 起 Maestro 提议；不新增乐手种类 | M4 开始前 |
| Q-P9 | L3 能否看本机 dev server？ | 不能（本机的 `look` 记 `unverifiable` 交 L4，改用 e2e 命令）/ 每愿望、每端口的回环例外（排除 `orchestra.localhost`，污染该乐章，随愿望过期；改 E4，需另起 r3 修订） | 不能，先用 e2e 命令；例外等 M2 出口过滤器落地后再议 | M2 出口过滤器验收后、M3 开始前 |
| Q-P10 | 在途回合越过预约或 `wallCapMin` 时怎么办？ | 复用 §10.3 / R33 的运行时中断（守护进程中断自己派发的回合，不是 agent 发起的中断，D15 不涉及）/ 只出 P1 请你中断 | 复用运行时中断，你在场与否都一样：上限就是上限，你可以在计划卡上调高 `wallCapMin`；只出 P1 会让你不在时的成本没有上界 | M1 开始前 |

---

## 11. 来源

**四份原始报告**（2026-10-27，各自的证据表即一手出处的完整清单）
- [W1] [wish-harness.md](wish-harness.md)：code.claude.com/docs/en/{goal, hooks, hooks-guide, workflows, scheduled-tasks, agent-sdk/*, permission-modes}；本机 `claude.exe` 2.1.310（`grep -a`）；DSH 0.2.1-rc.2 本机包；openai/codex@aa854da；Codex 0.160.1 绑定；developers.openai.com/cookbook/examples/codex/using_goals_in_codex。
- [W2] [wish-frameworks.md](wish-frameworks.md)：microsoft/autogen@004749e、microsoft/agent-framework@5a950ad、arXiv 2411.04468v1、OpenHands/software-agent-sdk@de0eb5d、SWE-agent/mini-swe-agent@04d809c、SWE-agent/SWE-agent@3ea751c、Aider-AI/aider@5dc9490、docs.devin.ai、paperclipai/paperclip@5982246（只读 `doc/`）、letta-ai/letta-code@9a6b55b、xai-org/grok-build@2bdd1d6、openclaw/openclaw@d45ff6d、NousResearch/hermes-agent@b63fbba、本机 hermes-agent@954f398、本机 DS-Bot@aff6777。
- [W3] [wish-reliability.md](wish-reliability.md)：metr.org（time-horizons、2026-1-29-time-horizon-1-1、2025-06-05-recent-reward-hacking、2026-03-10 笔记、2026-06-26-gpt-5-6-sol、2026-08-26 事件调查）；arXiv 2606.29537、2509.16941、2406.12045、2506.07982、2412.14161、2503.13657、2509.09677、2505.06120、2502.15840、2512.08296、2510.20270、2503.15223、2310.01798、2406.01297、2404.13076、2503.18813；anthropic.com/engineering 系列（2024-12-19 至 2026-04-08）与 claude.com 2026-10-22 折叠子代理一文；developers.openai.com/cookbook/articles/codex_exec_plans；docs.temporal.io/activity-definition；adk.dev/runtime/resume；ai.meta.com/blog/practical-ai-agent-security。openai.com 的三篇来源返回 403，未核实。
- [W4] [wish-community.md](wish-community.md)：anthropics/claude-code、openai/codex、deepseek-ai/deepseek-harness（discussions）、Fei2411/DS-Bot、OpenHands/OpenHands、openclaw/openclaw、microsoft/autogen 的 issue，经 `gh` 读取；zai-org/ZCode@3c5b227 `target.ts`；V2EX t/1228560、t/1214285、t/1243783。linux.do 返回 403，知乎、即刻未触达。

**规格**：[spec] = `docs/specs/2026-10-27-dsh-orchestra-design-r3.md`，只读。

**红队第 2 轮修订者另读**（2026-10-27）：code.claude.com/docs/en/agent-sdk/agent-loop.md（流式输入下 `maxTurns` 每条消息重计、`maxBudgetUsd` 累计、子代理超支、崩溃后花费字段可能清零、被拒的工具调用后「通常换一种做法」）；code.claude.com/docs/en/sandboxing.md（沙箱只在 macOS、Linux、WSL2 上运行）；arxiv.org/html/2510.20270（GPT-5 92% → 1%、只读测试、Claude >79% 改测试）；本机 DSH 0.2.1-rc.2 `dsh-agent-loop/README.md:220`、`dsh-tool-jobs/README.md:42,56-57`、`dsh-tool-jobs/lib/index.js:92`、`dsh-base/cordis.patch.yml:289`。

---

## Review log

**红队第 1 轮（2026-10-27；视角：事实、一致性、设计；共 117 条：事实 37、一致性 40、设计 40，其中关键 17 条）。** 修订者按重复分组，逐组对照四份原始报告、r3 与一手出处复核后应用；r3 与原始报告未改动。

**采纳（事实，已对照出处复核）：** 全部 37 条。重新抓取或读取的出处：code.claude.com/docs/en/goal.md（显示 token 花费但没有 token 或金额上限；上限只能写成回合 / 时间子句；`disableAllHooks` 为真时不可用；非交互模式可用）；hooks-guide（连续 block 8 次后覆盖）；arXiv 2510.20270（Oneoff-SWEbench 76%、Oneoff-LiveCodeBench 2.9%、Conflicting-SWEbench 54% → 9%、o3 49% → 12%、对 Opus 4.1 效果弱）；arXiv 2503.13657（ChatDev 在 ProgramDev 上 +15.6%）；`gh api` 读取 CC#104037（「my error」）、CC#88271、CC#101528（报告者的 stop、「9 次上限」）、CC#105184（时长不明）、OH#17691（自托管 V1 无可设预算，看门狗是报告者自建）；openai/codex `rust-v0.160.1` 的 `features/src/lib.rs:1704-1706`；DS-Bot@aff6777 `parts.js:388-397` 的八段；Paperclip 克隆 `native-status-arbitration.md:108-113`；[W2] 第 58、143、203、204 行，[W3] 第 23–33、67、69、71、94、137、183、187 行，[W4] 第 109–117、160 行。改动：`meta.stop` 由「复用」改为「扩展」并保留 r3 原词表（F01）；白名单只对 Claude（F02）；推进器不启动 Arrangement（F03）；IMP、METR-SOL、A-HD、MAST、hermes、Paperclip、METR 地平线的限定语补回（F04、F05、F16、F22、F28、F33、F34）；`/goal` 的 token（F06）；WP-6 与 A48 拆成 M1 / M2（F07）；schema 回复提前到 M1 记入修订（F08）；L3 只对公共或预发 origin（F09）；CC#104037 的报告者自认、MO 判官、七条模式、中文社区、DS-Bot 八段、OH#17691、CC#105184、CC#88271 引文、CC#101528 的归属与「9 次」、Rule of Two 译名、WP-11 的 10 s 标为假设（F11–F15、F23、F30–F32、F35、F37）；`wallCapMin` 与地平线脱钩（F17）；证据门改为可测（F18）；修订清单补行（F19）；副作用键按前缀查（F20）；Codex 钉住版本的出处（F21）；立场 1 的 § 指向（F24）；R67 拆分（F25）；「连续」改「累计」（F26）；`ask()` 属 Arrangement v1（F27）；WP-17 加 Claude 用例（F29）；定时唤醒三种（F36）。

**采纳（一致性）：** 全部 40 条，按组合并应用：`orchestra_update_task` 对愿望字段的限制与 WP-19（COH-01）；状态机补出边、终态与打回位置，`paused(cap:*)`、`paused(failure:*)`，「你不在」改为派发闸门（COH-04–06）；立场 2、5、6、7 改写（COH-07–10、COH-23、COH-37）；M1 路径、`from.kind: wish` 的定义与暂扣（COH-11）；M1 愿望卡 v0（COH-12）；QA 模板移出 r3 的 M1 削减顺序（COH-13）；每 Task 与每里程碑两种复核上限（COH-14）；精确一次按 `planRev`（COH-15）；`calls(n)` 不占规则 7 的 20（COH-16）；预算复用 `budget-incident`、`waiting-human` 不出新种类（COH-17、COH-18）；`time` 等待走单次 Routine（COH-19）；L3 与 E4（COH-20）；`ask()` 映射（COH-21）；DSH goal 插件「关到 M3」改永久（COH-22）；上限一处定义（COH-24）；Verdict 按乐手比对（COH-25）；削减顺序与 R70 拆出 R78（COH-26）；A47 进 R67（COH-27）；修订清单补 §5.2、§6.3、§8.1、§10.14、§13.3、§16、§17 等行（COH-28、COH-29）；命名与证据键（COH-31、COH-35、COH-36）；WP-6 拆分（COH-38）；`waiting` 免 `stale`、`dispatchAttempt` 改名（COH-39）；重启时 (b) 续跑的去向（COH-40）。

**采纳（设计）：** 全部 40 条，多数照建议，少数部分采纳（见下）。主要改动：M1 起的守护进程派发闸门与 A60（D1-01、D1-10）；在途回合的上限（D1-02，部分）；字段不可改（D1-03）；复核者由守护进程选、按乐手比对、记 `modelFamily`（D1-04、D1-25）；gating 检查由非执行者编写并冻结、A59（D1-05）；在场 = 心跳加 30 min 内一次 UI 操作（D1-06）；DSH 无白名单（D1-07）；关掉 harness 自己的排程唤醒（D1-08，部分）；主代理页状态条（D1-11，部分）；回访与等待上限（D1-12、D1-38）；上限一览（D1-13）；复核粒度（D1-14）；重启聚合卡（D1-15）；计划过期与集成分支（D1-16、D1-17）；证据门用 Wilson 上界、盲抽检、影子指标、试运行、微愿望（D1-18–D1-20）；`humanInterrupts` 与打断预算（D1-21）；无人值守的执行者能力与 `git status` 对账（D1-22）；提醒继承 `rootId`（D1-23）；WP-6 拆分（D1-24）；L1 绑定命令、cwd 与 HEAD（D1-26）；L3 本机为 `unverifiable` 与 Q-P9（D1-27）；`ask.author` 与一键采纳的记法（D1-28）；「设为愿望」直接建（D1-29）；v1 不跨项目（D1-30）；预算总额加每日切片（D1-31）；超时拒绝不计入 A5（D1-32）；无人值守级在 v1 之后（D1-33）；分支键由守护进程建（D1-34）；阻塞 Decision 去重（D1-35）；界面用语表（D1-36）；澄清只一轮（D1-37）；计划派人过硬过滤（D1-39）；留出检查改为可选（D1-40）。

**部分采纳 / 拒绝：**
- D1-02：没有把「预约耗尽即由运行时中断在途回合」写成定论，因为 D15 与 A4 规定中断只归人、具名乐手不被运行时中断；改为 Claude 的单次 `maxBudgetUsd` / `maxTurns` 加 DSH 出 P1 请你中断，例外留给 Q-P10。
- D1-01：没有拒绝主代理所有未标记的请求（会妨碍它同时推进别的项目），只拒绝发给愿望 Task 负责乐手、且在该愿望项目内的未标记请求。
- D1-08：没有采纳「扣住 `task-notification` / `auto-continuation` 回合等推进器放行」，Orchestra 扣不住 harness 内部的回合；改为关掉排程工具、计入 `calls(n)`、由你的暂停中断。
- D1-11：没有采纳「标注主代理宣布完成的消息」，这要靠分类器，与原则 5 不合；只做确定性的状态条与注入说明。
- F01 / COH-03 与 D1-13 的取舍：按 D1-13 不新增 `rounds(n)`，`calls(n)` 原样复用，定义为愿望 Exchange 数；指纹停滞按 F01 / COH-03 单独命名为 `gapRepeat(2)`，没有按 D1-13 并入 A9，因为 GB 的阈值是 2、A9 是 3。
- COH-14 与 D1-14 的取舍：采用「每 Task 复核一次，里程碑边界整体重跑一次」，没有采用「L2 只在里程碑边界」，因为 Task 的 `done` 需要 Verdict。
- F10 / COH-10：保留「你不在时的只读复核」，但标为本文对 §3.2 的解读，交 Q-P3 决定，没有写进不动的规则。COH-02 的两个选项里选 (a)：Arrangement 复核只由你点 Start，不提 Q-W1 修订。
- COH-30：拒绝「本文三项都不允许」的说法；无人值守行仍允许改 worktree（改状态），所以只写「本文更严」。D1-18：Wilson 下 73 个 0 失败恰为 5.0%，文中取约 74 个。

**存疑：** Claude 排程类工具在 SDK 自有乐章里的名字与是否暴露；~~流式会话能否逐次设置 `maxBudgetUsd`~~（第 2 轮已答：不能，按整段对话累计）；传 `disableAllHooks: true` 是否只关掉 `/goal`；~~DSH jobs 唤醒预算能否设为 0~~（第 2 轮已答：不能，最小为 1）；你不在时的只读复核在 §3.2 下是否可接受（Q-P3；第 2 轮改为建议不允许）；工期增量（推断）。METR 地平线仍经 Wikipedia 镜像，OpenAI 的三篇来源仍返回 403，都没有再抓取。

**红队第 2 轮（2026-10-27；视角：事实、一致性、设计；共 99 条：事实 19、一致性 40、设计 40，其中关键 12 条）。** 修订者按重复分组，逐组对照四份原始报告、r3、本机 DSH 0.2.1-rc.2 包与重新抓取的一手出处复核后应用；r3 与原始报告未改动。本轮修订者自己重新读取的：code.claude.com/docs/en/agent-sdk/agent-loop.md 与 sandboxing.md；arxiv.org/html/2510.20270；`dsh-agent-loop/README.md:220`、`dsh-tool-jobs/README.md:42,56-57`、`dsh-tool-jobs/lib/index.js:92`、`dsh-base/cordis.patch.yml:289`；r3 第 109、415、473、511、543–553、633、663、671、749、791、818–830、873–887、971、979–1025、1067–1072、1101–1110、1142–1175、1206–1217、1301、1429、1602–1604、1894、2187–2213、2721–2741 行；[W3] 第 66–67、116–117、153、172–177、188 行，[W4] 第 9–21、50、142、160 行，[W2] 第 18、105、111、131 行，[W1] 第 34、55、154–158 行。CX#34248 与 CC#101528 的数字对照 [W4] 第 50 行与研究者存下的 `cc101528.txt`，本轮没有再调 GitHub API。

**分组与处理（全部采纳或部分采纳，没有整条拒绝）：**
- **在途回合的上限**（F2-01、D2-03、D2-30、F2-03、D2-07、COH2-37、D2-18）：第 1 轮把 D15 / A4 读成「运行时不能中断」，是误读；r3 自己就由运行时中断自有会话（§10.3、§8.7 M3 / R33）。改为越过 `wallCapMin` 或预约即由运行时中断，只停该 Task；Q-P10 改为「复用运行时中断」。`maxBudgetUsd` 在流式会话里按整段对话累计（agent-loop.md），改为乐章启动时设份额、到顶轮换，`maxTurns` 每条消息重计；(b) 续跑按账本传剩余预约。D2-03 的「你在场时仍只出 P1」没有采纳：上限是确定性的，r3 的 runaway 与 R33 也不分在场与否。D2-07 选了「乐章启动时设份额」，没有选「每 Task 一个新乐章」，后者会撞 A13。
- **DSH 后台任务唤醒**（F2-02）：`maxConsecutiveWakes` 最小为 1，ACP 投递会重新充满它；改为 `completionDelivery: quiet`，任务唤醒开出的回合计入 `calls(n)`；第 1 轮的存疑项已答。
- **你不在时的复核**（D2-04、COH2-03、COH2-18、D2-31）：契约命令会执行执行者写的代码，原生 Windows 上 Claude 的 Bash 不在沙箱里（sandboxing.md），所以「只读复核」不成立。改为你不在时只做 L0，Q-P3 建议改为不允许；本文 §7.4 的 §3.2 行按 Q-P3 的答案二选一，答之前不改 §3.2。D2-31 随之失效。
- **L1 与 `tamper`**（F2-05、COH2-07、D2-01、D2-02）：`frozenFiles` 改为 gating 命令的闭包；L1 加守护进程只读的干净工作区核对与机器可读报告；处置时工作区不干净算执行者的 `missing`；M1–M2 每个愿望同一时刻只有一个执行或复核。D2-02 的「守护进程建一次性 worktree」部分采纳：守护进程写 `.git` 违反 §5.2 写围栏，检出放在 `~/.orchestra` 又违反 §5.3 的 cwd 规则，所以改为只读核对，一次性干净检出留给无人值守级。
- **`roundCap` 与复核上限**（F2-04、COH2-16、COH2-35、D2-28）：`roundCap` 恢复 r3 原义，只数执行者导致的重派；新增 `verifySubmissions` ≤3；里程碑重跑另计；R08 对愿望 Task 提前到 M1 记入本文 §7.4。
- **闸门与愿望根**（COH2-05、COH2-06、D2-12、COH2-20、D2-05、COH2-15、D2-23）：闸门改挂到 `Wish.rootId`，范围扩到项目内可写乐手与处理愿望 Exchange 的乐章，加「下一步」唤醒、Verdict 之前不派下一个、暂停时拒绝派发，`calls(n)` 只在一处定义并按计划规模设上限，规则 7 以派发为子根（推断）。D2-05 部分采纳：DSH 主代理的预设不能按会话切换，你不在时扣住它自己的写与 shell 做不到，记为缺口。
- **状态机**（COH2-01、COH2-22、COH2-12、COH2-13、D2-13、D2-09、COH2-04、COH2-21、COH2-34、D2-11）：加 `pausedFrom`，继续回到原状态；去掉 `drafting`，补打回与校验失败的边；被拒的动作开 `blocker` Decision；`tamper` 进 `waiting-human`；计数不清零，继续 `cap` 要填新值；首次 `unknown` 自动重新复核，第二次暂停；`stall(3)` 选方案 1；加 `blockRepeat(2)`；最小的 `paused(restart)` 提前到 M1。
- **条目映射**（COH2-14、COH2-32、D2-24）：本文 §6.9 改为一事件一条目的映射表，`timedOut`、`failure`、`stall(3)` 不另出 `wish-paused`，`bounce` 仍为 P2；Decision 的 `kind` 补全。D2-24 部分采纳：跨愿望合并不含审批、交接与 P0，因为审批 30 min 即超时。
- **复核者与 Arrangement**（COH2-08、D2-17、COH2-09、F2-18、COH2-10）：复核乐章 `endReason: review-done`，不计每小时轮换上限；Verdict 可为 `kind: template`，三人面板是本文提议；v1 每个愿望并发 1，不扇出，删去「顺序型」。
- **等待与回访**（D2-10、COH2-17、D2-26、F2-09）：M1–M2 只接受 `reply` / `human` 等待；回复等待暂停截止直到 `stall(3)`；回访改为守护进程自己的评估；停滞升级仍在 M3。
- **计划与触点**（COH2-11、COH2-33、D2-21、D2-20、D2-22、D2-25、D2-27、D2-36、D2-38、D2-35、D2-37、D2-32、D2-34、D2-14、D2-29、D2-08、D2-06、COH2-31、D2-19）：`askClauses`、`Task.paths`、先红检查、项目策略预算、滚动式规划与自适应抽检、阻塞须带证据与推翻率、澄清类别枚举、卡片内嵌主代理页、「全部继续」、分项计数、界面用语、闸门横幅、放行规则随愿望撤销、不在时同类审批只拒一次、`ci` 绑定 `headSha` 且只在里程碑边界、A-SBX 标为原生 Windows 不适用并加 S2 测试项。部分采纳：D2-21 的冒烟由下一位执行者跑，守护进程不执行代码；D2-20 的「你看一眼测试名」只在唯一 QA 乐手写测试时；D2-36 的类别仍由规划者标，所以默认从严。
- **证据门与影子**（D2-15、D2-16、COH2-39、COH2-27）：保留影子级，指标改为免手窗口的风险测量（「预测派发一致率」按构造约 100%）；写明 74 个是被抽检的 Task，定义假完成，加每项目下限与 ≥7 夜试运行；R75 改为 M1 / M4。
- **事实与措辞**（F2-06–F2-08、F2-10–F2-17、F2-19、COH2-24–COH2-30、COH2-36、COH2-38、COH2-40、COH2-23、COH2-02、D2-33、D2-39、D2-40）：A44、A54、R77 标为未经验证的设计；成本「翻倍」改为推断；A55 / R73 里程碑对齐；`handoffAcl` 属第 9 步；E6 的扩展标为本文新增；r3 关 DSH goal 插件到「M3 bundle 或 S2 选 B」；IMP 的提示效果补回；CX#34248 不是「一夜」；`PC#` 归 [W2]；中文社区检索如实写；E4 在 M2；Stop 钩子的 74 次；预约不只给 Arrangement；回复等待已不空转；定时唤醒是两种（推翻第 1 轮 F36 的「三种」）；`wish-field-immutable` 移到 §8.6 行；Q-P9 期限；派发正文不带复核者的发现；QA 模板不可削减；愿望档案乐章；本文 §7.1 加零 token 验收列；矛盾只按结构化字段判；`wall` 只数活跃时间；两条新非目标；WP-24…WP-42 补齐事故回放用例，证据门 #1 引用到 WP-42。

**存疑：** Claude 排程类工具的名字；`disableAllHooks: true` 是否只关掉 `/goal`；`agent/turn-stopping` 上的回合上限能否由私有 bundle 实现；闭包文件模式是否完整，被 `.gitignore` 忽略却会被运行器自动发现的文件（例如被忽略目录里的 `conftest.py`）干净核对看不见；DSH 沙箱能否跑测试（S2）；规则 7 以派发为子根是对 r3 计数的改动（推断）；工期增量（推断，M0–M5 由 +4–6 周改为 +4.5–6.5 周）。

**编排器更正（2026-10-27，并入 r4 时）**：WP-3 原写「`unknown` + 1 条条目」，与本文 §6.5、§6.9 和 WP-35（第一次 `unknown` 不出条目、自动重新复核一次，第二次才出 1 条 P1）矛盾；改为「条目数按 WP-35」。其余未动。
