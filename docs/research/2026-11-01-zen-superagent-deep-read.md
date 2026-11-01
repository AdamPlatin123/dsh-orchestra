# Super-agent 原型深读与对照（2026-11-01）

上一轮（`docs/research/2026-10-31-deepseek-superagent.md`）只读了原型的文档和约 12 个源文件。这一轮把原型分成 7 个切片，逐个文件读完。读的时候拿开眼准则逐条对照，看它在哪些地方「闭眼」，也就是把状态显示成健康或完成，实际却说不清。同时核对了 DSH 上游的说法。

## 0 方法

- **原型。** 只读浅克隆 `deepseek-ai/dsh-superagent-prototype` main@6337fc8，没有安装，也没有运行。下文的原型证据写成 `path:line`，全部指 @6337fc8。
- **7 个切片。**
  1. 核心状态机（`src/core/` 全部文件，加 docs/001、003、007 的相关段落）；
  2. 执行与副作用（effects、outbox、delivery、executor）；
  3. 授权与策略（policy、admission、settings、sources）；
  4. 面板、HTTP 与管理 API；
  5. 运维、部署、存储；
  6. 提示词、上下文与工具面；
  7. 文章原文与 DSH 上游。
- **DSH 上游。** 2026-11-01 用 `gh api` 只读拉取了 `deepseek-ai/deepseek-harness` master 上的接口契约、各包 README、两篇归档设计笔记、webhook 类型定义，以及 v0.2.1-alpha.1 升级指南。`config-catalog.md` 没拉，凡是引用它行号的地方都没核。
- **文章原文。** 这次仍没读到。WebFetch 打开微信原文和三个转载都报 Socket is closed；用 curl 带手机 UA 去抓，被权限分类器判为绕过验证页，已经停手。
- **复核。** 每个切片先由一个读者写发现，再由一个唱反调的复核者逐条打开源码，对照四份材料：r4（现行规格 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`）、M0 计划、UI 设计（`docs/plans/2026-10-31-ui-interaction-design.md`），以及开眼笔记和上一轮笔记。
  - 共 84 条：53 条成立，31 条打了折扣，0 条整条被推翻。
  - 打折扣的条目按复核修正后的说法写，置信一律降为「中」。被推翻的只是个别条目里的子论断，列在文末。
  - 读者有 6 个文件的引用行号超出了文件实际长度，本文一律换成复核给出的位置。
- **开眼准则 P1–P9。** 指开眼笔记 §2、§7 用眼图概念写下的 9 条状态设计准则，其中 P9 还是候选。每条的内容见文末速查表。

## 1 结论先行

1. **原型的代码比它的文档更「闭眼」。r4 在这些点上都已设防，不需要改规格。** 例子：
   - 没开 PR 的工单，执行器一报 `ready` 就算完成；
   - 已结束的工单被人回一句话就复活，上一次的结局从库里删掉；
   - 执行器替 worker 代填 `waiting`；
   - 超时的「评估不可用」1 h 后健康条转绿；
   - 断线时页面照样显示「没有待处理的工单」。

   r4 对应的防护有：D19（完成是判定，任何 agent 都不能宣布完成）、M0 的 I01（每次状态转换写一条带原因的记录）、I05（一套结局词表）、UI 设计的空态规则。这些反例应当写成附录 F 的坏样本（SA-41）。
2. **最大的安全差距不在 `danger-full-access`，而在「评估者握着改评估标准的笔」。**
   - 主会话（Router）通过工具就能改允许名单、准入表、接单模式（含 `auto`）和全部提示词（`src/app/tools/main.ts:248-299`），代码只给执行环境和账号两块加了闸（`src/app/settings.ts:32-53`）。
   - 管理 API 的守卫在请求不带 Origin 时直接放行（`src/app/http.ts:75-79`）：任何能跑 shell 的进程用 curl 就拿到面板权限，审计里也记成 `panel`。
   - 上一轮把「在线改提示词和规则」归给文章里的 LLM Watchdog，并说仓库里没有，这是错的：这个能力就在 Router 身上。
   - r4 已经防住：§8.6 的 agent 工具清单里没有任何改配置的工具；D8 规定审批、拍板、刹车只能由人在配对 UI 上做；D3 的理由栏点名否决「只靠 token + Origin 的 loopback 守卫」，原型这个洞和 D3 理由里点名的 tonghuashun 漏洞同形。
3. **对 S2（M1 第 1 周给私有 DSH 两个候选打分的验证清单）最有用的是「已读」证据。**
   - 原型给 worker 输入记已读的条件是「这个 MessageId 的 user/message 已提交进会话历史」。它明确不认 `agent/inbox/claimed`，理由是领取消息的那一步可能被取消或失败（`src/executor/dsh.ts:493-503`）。
   - 上一轮 SA-1 说 DSH 的 `inject`「写进历史」，这是错的。`inject` 只是放进下一步的待处理队列，cancel 或销毁时会被清掉。
   - 候选 B（私有 `dsh web` 加 bundle）的 `delivered` 要等 DSH flush 返回之后才能记；DSH 也不提供逐条 prompt 的结算信号，settle 得由我们自己定义。
4. **上一轮的 SA-2、SA-3、SA-4 都不能当小事并入。**
   - SA-2（前台命令 5 s 转后台）和 SA-3（后台 job 结束就唤醒执行器）与 r4 §7.4 已定的 `completionDelivery: quiet`（后台任务完成只注入通知、不开新回合）冲突，要你拍板（Q-SA4）。
   - SA-4 实际只是「人的消息唤醒执行器时可以超额用 1 格槽」。代码里没有「唤醒先于新启动」的优先，同一轮里平局时新启动赢；主会话的「报一下状态」请求也占这一格。
5. **能借的正面经验，集中在「用确定性层围住 LLM」。** 包括：LLM 要对每条规则逐条表态；判定落地那一刻再比一次策略版本；人的原话由宿主独立附上；对外的动词必须递交别处铸出的句柄；授权到期后工具立即失效；防线旁边写明「不防什么」（这正是 P9 的现成格式）。这些都属于设计，落点在 M1–M4，不动 M0 主线。
6. **规划不变。** 新增 7 个要你定的问题（Q-SA4 至 Q-SA10），上一轮笔记要更正 26 处（§5）。

---

## 2 按开眼准则逐条

| 准则 | Super-agent 怎么做 | r4 怎么做 | 差距与借鉴 |
|---|---|---|---|
| **P1 一符一义**（结局只要需要你采取不同的动作，就是不同的符号；看不清就判「不明」） | 一个标签底下藏着几种意思：<br>• 自动退避重试也挂「需要人」（`src/core/stage.ts:11`，对照 `docs/003-execution.md:11`）；<br>• Decision 的 `unavailable` 至少覆盖五种情况：超时、Policy 变了、被路由走、之前接过、评估者自己判不了（`src/core/evals.ts:62、219、215、141、291`）；<br>• 执行器代填 `waiting`，面板显示「等待新触发」（`src/executor/dsh.ts:657-669`，`src/core/stage.ts:19`）；<br>• 没送到的评估永不过期，面板却标 `eval-overdue`（`evals.ts:43`，`src/app/views/overview.ts:59`）；<br>• 对已结束的工单点停止也回 `stopped:true`（`src/app/http.ts:194`）；<br>• 系统发起的取消一律记成 `user`（`src/app/runtime.ts:236` 等）。 | • §6.3（Exchange 状态表）把 `queued` 和 `unknown` 分开；<br>• §8.3 规则 1（自动回信）规定回信的状态由守护进程填写；<br>• UI 设计的动作结果分 `applied`、`noop`、`unknown`；<br>• I05（一套结局词表）。 | r4 已防。可借两点：<br>• 把这些反例写成坏样本（SA-41）；<br>• DSH 一侧的 `aborted{user}` 映射成「发起方不明」，消息来源按 trust 分形态（SA-16、SA-17）。 |
| **P2 每个非终态都有钟、有主或有闸**（任何等待恰好有一个放行者） | • 「后台最多 30 min」的钟每次空闲都重新起算，只在内存里；到点后 subagent 照跑，却报 `waiting`；交给人之后留下的 job 根本没有钟（`dsh.ts:32、634-671`，`docs/003-execution.md:39`）。<br>• 外发回复无限重试，面板这一行没有任何可点的动作（`src/app/effects.ts:141-143`，`src/client/overview.tsx:55-57`）。<br>• 部件状态 `starting` 没有截止（`src/app/views/sources.ts:18`）。<br>• 正面例子：每条人的消息恰好有一个决定者（`src/core/model.ts:68-88`）。 | • 规则 8（每 Work 截止时间）：默认 30 min，超时出 `timedOut`；<br>• 规则 11（回访）；<br>• §6.5 InboxItem 的 `expired` 是一条显式的边；<br>• I07（驻留表：每个非终态都要填上钟、主或闸）。 | 钟都在，缺两样：<br>• 驻留表里缺「外发／投递重试中」这一行（SA-42）；<br>• 缺「quiet 通知挂在 DSH 收件箱里」的诊断信号（SA-38）。 |
| **P3 时间分两份报**（确定性上界 + 随机尾部@目标率） | • 只发一次 2 s 探测，超时就判「不应答」并触发重启（`scripts/dsh-superagent:81-95、112-115`）；<br>• 启动等 60 s、停止等 300 s，都没写依据；<br>• 评估的截止从「送到决策者手里」才起算，暂停时顺延（`evals.ts:39-55`）。 | • 普通 Work 的 30 min 从哪一刻起算，r4 没写；<br>• §8.1 信封里的 deadline 是绝对时间；<br>• §8.8 规定 Arrangement 从接纳请求起算；<br>• I06（时延门槛写成上界加尾部目标率）。 | • 截止的起算点见 Q-SA5；<br>• relay 来源 steer 的时延上界见 SA-15；<br>• 外部探针要求连续 K 次失败才判死，见 SA-26。 |
| **P4 时间是输入，次序只认流** | • 转换不记原因：领域事件只有 `{type, at, data}`（`src/core/ports.ts:103`），存储是整行覆盖（`src/app/store.ts:235`）。<br>• 拿 GitHub 的合并时间和本机时钟生成的时间比先后（`src/core/tickets.ts:375`）。<br>• 通知游标取本机时刻减 5 s，再发给 GitHub 当 `since`（`src/sources/github.ts:152、304、341`）。<br>• 同一个线程有两种平局规则（`src/app/store-read.ts:37、40`）。<br>• 在同强度的触发里，按来源时间选 primary（`evals.ts:98`）。<br>• id 里掺了时间或内容（`evals.ts:107`，`tickets.ts:153、399`，`src/app/sessions.ts:185`）。<br>• 退避存的是墙钟到期时刻（`effects.ts:62-64`）。<br>• 正面例子：RetryHealth 按事件 seq 维护水位做投影（`src/app/retry-health.ts:53-90`）。 | • §6.1 的 Event 带 seq；<br>• M0 的 I01：每次转换都带 cause（source、human 或 clock 三选一）；<br>• M0 只设一个 Clock 端口，并用静态扫描禁止别处读时钟；<br>• 次序只认 srcSeq 和 jseq。 | M0 已经比原型严。可借：<br>• 把这些写成坏样本（SA-41 第 9 条）；<br>• 退避次数从 journal 计数（SA-21）；<br>• 幂等键取事件身份（SA-22）；<br>• 「在等模型重试」的投影（SA-19）。 |
| **P5 标记后于效果**（已读、已触发这类标记只能晚于它所证明的效果） | • 写「已开始」的 accepted 回调先于 flush 执行（`src/app/delivery.ts:83-84`，`dsh.ts:466-468`）。<br>• `inject` 调用的同一刻就记已送达，notice 处理一结束就对外报 `injected`（`delivery.ts:79`，`sessions.ts:172-178`）。<br>• 返回的 `context_delivery: injected` 只表示「已经不在队列里」（`sessions.ts:175-182`）。<br>• 正面例子：已读只认 user/message 进入历史（`dsh.ts:493-503`）；effect 按代号结算（`effects.ts:130-146`）；`afterCommit` 等最外层提交后才跑（`store.ts:136-162`）。 | • §8.2：投递在 accepted 写入 journal 之后才发出；<br>• §6.3 的 read 定义为「目标的某个回合已经带着这条消息开始」，候选 B 的证据写的是「S2 确定」；<br>• §8.3 重启三阶段。 | • 候选 B 的 `delivered` 要等 flush 返回（SA-12）；<br>• 已读证据（SA-11）；<br>• inject 和 notice 的处理规则（SA-13）；<br>• 人类动作「注入乐章」那一腿的回执（SA-40）。 |
| **P6 细迹线、无串扰**（一条线不能把邻线的信号接进来） | • 任何非 bot 的 GitHub 用户在工单线程上留言，都能复活工单并让 worker 照做（`src/sources/github-trigger.ts:62-63`，`src/core/intake.ts:41-44`，`tickets.ts:252-270`）。<br>• 评论被编辑后，作者仍记原作者；正文任意位置的 @ 都算（`github-trigger.ts:60-71`）。<br>• worker 能自行把任意线程订阅为只读上下文（`src/app/tools/executor.ts:50-64`）；代码兜住了这一点，这类消息不算它的活（`intake.ts:42-45`）。 | • §8.5：消息不携带任何权限；外部消息只经默认关闭的网关进来；<br>• I24（封闭复核乐章只收发给它的信）；<br>• §9.2 第 4 步：只认开头的 @。 | r4 已防。这几条作为 Q-SA2（上一轮的问题：要不要接 GitHub、CI、飞书这些外部事件源）的前提条件记下。 |
| **P7 眼图本身是测量**（规则写成纯函数，三处跑同一份代码） | • 计数等于列表长度，只有一半靠构造保证（`src/app/views/records.ts:14`，`sources.ts:60-62`）。<br>• 1 h 和 24 h 两个窗口调用的是同一个函数，只是窗口参数不同（`overview.ts:26-33` 对 `:61`）。<br>• 授权等级、评审轮数、自动合并阈值只写在提示词里（`dsh.ts:91-95`，`src/app/migration.ts:202`，`prompts/team/communication.md:92-93`）。<br>• 正面例子：IM 100 词的上限由代码强制（`src/infra/text.ts:2-15`，`src/app/outbox.ts:29`）；命中集由宿主根据逐条表态推出（`src/policy.ts:40-61`）。 | • P7 要求零 token CI、回放、线上跑同一份代码；<br>• UI 设计第一节 7（什么在哪算）；<br>• I23（每个 Task 一本尝试账本）；<br>• §10.7 打回上限由守护进程计数。 | 可借：<br>• 窗口参数只在一处定（SA-25）；<br>• 长度上限在出口做确定性检查（SA-28）；<br>• 逐候选表态（SA-29）。 |
| **P8 每条线只有一个驱动者**（权力靠递交，不靠够得着） | • Router 握着改设置和改提示词的工具，policy、eval 两块没有闸（`main.ts:248-299`，`settings.ts:32-53`）。<br>• HTTP 守卫缺 Origin 就放行，写入一律记 `panel`（`http.ts:75-79、195-210`）。<br>• Router 有 bash（`sessions.ts:263`）。<br>• 单写者锁是 30 s 心跳锁，被抢后不停写（`runtime.ts:92-93`）。<br>• harness 自己开的回合不经槽位（`dsh.ts:641-656、489-492`）。<br>• Web UI 在第一回合前可以换掉会话的预设（`sessions.ts:122-131`）。<br>• 正面例子：动词要递交句柄（`main.ts:110-113`，`src/core/replies.ts:64-90`）；工具随授权到期（`sessions.ts:289-296`）；健康条目一名一主（`src/infra/health.ts:18-19`）。 | • §8.6 没有改配置的工具；<br>• D8；<br>• D3 否决 token + Origin 守卫；<br>• §10.11 规定 Origin 缺失一律拒绝；<br>• M0 用身份锁（I12）；<br>• §10.2 Governor（速度控制）只管 Orchestra 自己发起的投递。 | 大部分 r4 已防。新问题：<br>• Governor 管不管 harness 自己开的回合（Q-SA10）；<br>• Maestro 的工具面（Q-SA7）；<br>• 预设会不会被 UI 改掉（SA-37a）。 |
| **P9（候选）每道防线写明防什么、不防什么** | • 多处写明「不是安全边界」：`settings.ts:143`，`src/infra/environment.ts:1-4`，`docs/006-deployment.md:19`，`docs/003-execution.md:80、84、90`，`src/client/locales.ts:374、379`，`src/app/prompts.ts:200`。<br>• 反面例子：004 的强度表漏写了「Router 经工具能改 policy 和 eval」（`docs/004-prompts.md:65-71`）；版本号号称覆盖「影响授权的设置」，和 gate 实际读的输入不一致（`policy.ts:116-118` 对 `src/sources/registry.ts:124-132`）。 | 只有零星几处：DPAPI「只防别的 Windows 用户」（r4:1713）、taint「尽力而为」（§8.5）、§10.11 第 6 条（残余风险明示）。M0 计划和 UI 设计里一处都没有。 | SA-23：把格式和测法定下来。 |

---

## 3 Super-agent 的「闭眼」反例

| # | 反例 | 会怎样出错 | 证据 | r4 是否已防 | 置信 |
|---|---|---|---|---|---|
| 1 | 无 PR 的 ready 即完成；`dropped` 由执行器自行收工；ready 时就对外发结果 | 没有第二方复核的活被标成完成，人也已经收到了结果。「人审 PR」兜底只覆盖开了 PR 的活 | `src/core/assignments.ts:128-132`，`replies.ts:69-73`，`tickets.ts:77-89` | 已防：D19；§6.4 规定 `in-review → done` 只来自 Verdict 或你 | 高 |
| 2 | 已结束的工单可以复活，且不留结构化记录 | 面板上「已完成」的工单变回「工作中」。Ticket 行上的 `ended{at,by,outcome}` 被删，没有一张表能直接查到它曾以什么结局结束，只剩旧派工的 `endedAt` 和通知回执这类零散痕迹 | `tickets.ts:252-270`，`intake.ts:40-45、59`，`store.ts:235`，`docs/007-architecture.md:109` | 已防：§6.4 的 `done ⇄ reopen` 是一条显式的边；M0 的 I01 | 中 |
| 3 | 执行器代填 `waiting` | 「回合没报告就停了」和「worker 自己说在等」显示成同一个阶段标签，记录结构也一样。被杀 job 的说明会写进 summary | `dsh.ts:657-669`，`assignments.ts:10-20` | 已防：规则 1 的状态由守护进程单独填写；I05 | 高 |
| 4 | 自动重试挂在「需要人」下面 | 人去点多余的重试；看惯了之后，又会忽略真正要处理的项 | `stage.ts:11`，`docs/003-execution.md:11` | 已防。§6.3 的 queued 和 unknown 只是类比，准确依据是 P2 和 §11.2 的 Fermatas 分组（需要你：审批、提问、决策） | 高 |
| 5 | 超时类的 `unavailable` 没人处理时，1 h 后健康条转绿，24 h 后离开总览的「要我管」区 | 评估器挂了一下午，第二天面板一片绿。触发记录页仍能看到并重新评估；离开注意力区时不写任何边 | `overview.ts:26-33、61`，`records.ts:96-98` | 已防：§6.5 的 `expired` 是一条要写下来的边 | 中 |
| 6 | 拿两只钟比先后来判断该不该结束 | GitHub 和本机钟差几秒，「关闭后有没有恢复过工作」就会判反 | `tickets.ts:375`，`src/sources/github-pull.ts:82` | 已防：M0 的 P4 落地 | 高 |
| 7 | 通知游标混用两只钟 | 默认配置下仓库级的流是关的；这时本机钟比 GitHub 快超过 5 s，未订阅线程上的新 @ 会永久漏掉 | `github.ts:27、152、304、341` | 已防：P4「别人的时间戳只当数据」。I11 只是类比 | 中 |
| 8 | 用内容哈希当幂等键 | 第二次的暂停或恢复 notice 被当成重复吞掉，对外却报 `injected` | `sessions.ts:184-185`，`src/app/notices.ts:22-24`，`src/app/settings.ts:209` | 已防：规则 5（requestId 幂等）加上 M0 的 timerId 从 journal 计数 | 高 |
| 9 | 按 `updatedAt` 去重，实际不起作用 | 主会话反复叫执行器「报一下状态」，每次白跑一回合，还要抢给人留的那格余量 | `tickets.ts:150-155、236`，`dsh.ts:38、307`，`docs/003-execution.md:59` | 已防：§10.6 轮询检测；D16（沉默有效，notice 默认不唤醒） | 高 |
| 10 | 重启后无上限地重新开工 | 会把宿主搞崩的活会无限循环、一直烧 token。重投的只是从没领进历史的输入，旧副本会先撤回 | `assignments.ts:83-92`，`tickets.ts:329-337` | 已防：§8.3 重启表 (b) 只恢复一次，再被打断就转 unknown | 高 |
| 11 | 后台 30 min 不是真正的上限 | 钟每次空闲重新起算；到点后 subagent 照跑、槽被释放，却报 `waiting`；交给人的 job 没有钟 | `dsh.ts:634-671`，`docs/003-execution.md:39` | 已防：规则 8；`timedOut` 是另一个符号 | 高 |
| 12 | harness 自己开的回合不经槽位 | 时限过后 subagent 结束唤醒的回合、人在 worker 会话里直接打字开的回合，都可以让占用超过 `maxWorkers` | `dsh.ts:641-656、489-492` | 部分：§10.2 Governor 只管 Orchestra 自己发起的投递，见 Q-SA10 | 中 |
| 13 | 错误分类靠对自由文本跑正则 | 报错文本里含「500」就当瞬时故障；429 一律算瞬时；重试计数在内存里，一重启就清零 | `dsh.ts:44-55、548-553` | 已防：A13（轮换熔断）、R72（夜间失败分类）、I27（错误类别在边缘判） | 高 |
| 14 | 心跳锁 | 两个 profile 配了同一个状态目录，或者睡眠、卡顿超过 30 s 时正好有第二个实例启动，会出现两个写者；锁被抢后原持有者照写 | `runtime.ts:92-93`，`effects.ts:104` | M0 已防（I12）；r4 D3 的「心跳锁」措辞还没改 | 中 |
| 15 | 评估者自己握着改评估标准的笔 | 注入的消息让 Router 把发送者加进名单、把模式改成 `auto`、改写评估指令；版本历史记 `source=tool`，没有面向人的通知（面板改动也没有） | `main.ts:248-299`，`settings.ts:32-53`，`src/policy.ts:84` | 已防：§8.6、D8；A6 只是类比 | 中 |
| 16 | 管理 API 缺 Origin 就放行 | 任何能跑 shell 的 worker 用 curl 就拿到 `panel` 权限，能改每张工单都要跑的 prepare 命令；审计里记成 `panel`，停止记成 `human` | `http.ts:75-79、195-210`，`tickets.ts:161`，`tests/http.spec.ts:20、70-79` | 已防：§10.11 第 3、4 条，D3 理由栏，§14 第 8 行 | 高 |
| 17 | 任意 GitHub 人类都能驱动 worker | 不在名单上的人在工单线程留言，worker 在原授权范围内照做；复活前会按当前 Policy 重新校验授权 | `github-trigger.ts:62-63`，`intake.ts:41-44` | 已防：§8.5 | 高 |
| 18 | 评论被编辑后，作者仍记原作者 | 有写权限的人把名单内某人的旧评论改成「@agent 做 X」，宿主按 explicit 送进路由。GitHub 的编辑权限没有实测 | `github-trigger.ts:63-68`，`github.ts:237` | 已防：§9.2 第 4 步只认开头的 @；external 门控 | 高 |
| 19 | 名单 = 飞书同步群的成员 | 能往群里拉人，就能授予 explicit 请求权；手工加进名单但不在群里的人，下次同步时被删掉 | `src/sources/feishu.ts:102-114` | 已防：原则 2（人是唯一的权威）、D15（类型化权威） | 中 |
| 20 | 授权等级只写在提示词里 | 主动接的单在执行期的工具和权限与显式请求的单完全一样；差别只在准入和存续，由代码管 | `dsh.ts:91-95`，`policy.ts:212、237-238` | 已防：§8.5 taint、D20（自治分级） | 中 |
| 21 | 「小时检查」是一个 LLM 排程 | 「说过就不再说」靠它自己记得；修复没有边界；和被监视对象共用同一份安装、同一台机器；检查器自己停了，看起来也是「沉默」 | `docs/006-deployment.md:133-141`，`SETUP.md:56` | r4 没有对应物，见 SA-26 | 高 |
| 22 | 单次 2 s 探测就触发重启 | 同步 SQLite 卡了 2 s 的健康服务被重启，所有在跑的工作随之结束 | `scripts/dsh-superagent:81-95`，`docs/006-deployment.md:240` | M0 的停摆判定已防（M0 计划:602） | 高 |
| 23 | 断线和「未测」看起来都像健康 | 出错时照样说「没有待处理的工单」；从没上报过的部件当成 `starting`，status 退出 0 | `src/client/api.ts:81-83`，`overview.tsx:64-75`，`sources.ts:18` | 已防：UI 设计第四、五节 | 高 |
| 24 | 停止落空也报成功 | 工单在两次轮询之间自己结束了，你再点停止，看到的是「成功」 | `http.ts:194`，`tickets.ts:346-347` | 已防：`noop:already-ended` | 高 |
| 25 | 外发无限重试 | 5 s 起、上限 5 min，永远重试，面板没有动作；同一工单的次序保证在前一条失败 3 次后放掉 | `outbox.ts:24、44-45`，`effects.ts:141-143` | 部分：原则 8；I07 要补一行，见 SA-42 | 中 |
| 26 | 系统发起的取消都记成 `user` | DSH 日志里，守护进程关机、停工单都显示成「人取消的」 | `runtime.ts:236`，`dsh.ts:365`，`src/executor/background.ts:150` | r4 没写 DSH 取消原因的映射，见 SA-17 | 高 |
| 27 | 规则从代码降级成提示词 | 「每个评审者最多 3 轮」和自动合并阈值由 LLM 自己记；换 worker 时可能丢（推断） | `migration.ts:202`，`communication.md:92-93` | 已防：§10.7、I23 | 高 |
| 28 | 打开库时就有副作用 | 检查版本之前先设 WAL、chmod；每次打开都比对生成列，不一致就 DROP 再 ADD | `store.ts:63-64、105-111` | r4 没写升级的规矩，见 Q-SA8 | 高 |

---

## 4 新的借鉴候选（接上一轮，从 SA-11 起）

| # | 内容 | 落点 | 性质 | 置信 |
|---|---|---|---|---|
| SA-11 | **候选 B 的已读证据分三段。**<br>• delivered：flush 返回之后；<br>• read：这个 MessageId 的 user/message 进入持久历史，`inbox/claimed` 只能当前置信号；<br>• 结束时：read 之后还要有一次回合结束，才算「读过」。<br>不抄原型 `readBefore` 里兼容旧记录的回退（`tickets.ts:19-20`）。判别用例：领取之后立刻 cancel，状态必须仍是 delivered。原型只对 trigger 类输入记已读（`dsh.ts:500`）。 | M1 S2 ①⑥ 的测试脚本；§8.2 候选 B 行 | 证据 | 高 |
| SA-12 | **候选 B 的投递回执分两格。** inbox 接受只算 accepted；`sessionPersistence.flush()` 返回之后才写 delivered。状态机要能接住「回合事件先于 delivered 到达」。 | §6.3 delivered 行（限定候选 B）；§8.3 重启表 (a) | 设计 | 高 |
| SA-13 | **inject 和 notice 的规则。**<br>• `wake:none` 才用 inject；<br>• 监听自己 id 的 `agent/inbox/discarded`，收到就记 dropped，再重投或出条目；<br>• Orchestra 发起的 cancel 一律带 `keepInbox:true`，只有你点「清空」才用 false；<br>• `wake:turn` 一律用 steer 或 followup，不写「在跑就 inject、否则 followup」；<br>• 先投递，再释放或销毁。<br>每条次序各配一个「反过来就失败」的测试。 | §8.3 规则 9（沉默与唤醒）；§12.1 bundle 行；S2 | 设计 | 中 |
| SA-14 | **候选 B 的 settle 由 Orchestra 定义。** 三项正证据缺一不可：SA-11 的 read 证据、第 N 回合的 `turn/end`、这个乐章名下没有未结算的子代理。同一回合领走了多条消息时，回信标「多源回合」，正文只当摘要。拿不到证据就记 unknown。 | §8.3 规则 1；改写 S2 ⑲（候选 B 的 settle 是否等后代收尾） | 设计 | 高 |
| SA-15 | **relay 来源 steer 的时延上界。** DSH 只有 user 写的 steer 能结束 `job_output` 等待，所以上界 = max(前台命令超时, `maxWaitTimeoutMs`) + 一步。私有 home 的预设要显式设这两个值（值另立 Decision，原型用 5 s）。S2 加一项测量：分别投 relay steer 和 user steer，量到被领走的时延。 | §7.4 私有 home 表；§8.2 | 设计 | 高 |
| SA-16 | **消息来源按 trust 分形态。**<br>• agent → `form:'relay'`；<br>• runtime 生成的文本（回信状态行、timedOut、回访、Arrangement 提示）→ `form:'notice'`，带不超过 120 字的 summary；<br>• 已定决策的注入属于「当前状态」，可能更适合 `snapshot`；<br>• external → `notice`。<br>只改文字，不改已定值。 | §8.5 第 1020 行 | 设计 | 高 |
| SA-17 | **DSH 的取消原因。**<br>• 运行时发起的中断用 `{kind:'hook', reason:'orchestra:<原因>'}`，`user` 只留给人类动词；<br>• 观察器把 `aborted{user}` 判成「被中断（发起方不明）」，不显示成「你」；<br>• `parent`、`hook`、`disposed` 可以当正证据。 | M0 `model/symbols.ts` 的映射；M3 bundle | 设计 | 高 |
| SA-18 | **DSH 恢复时补写的收尾。**<br>• `turn/end{interrupted}` 单独成一个结束类「宿主中断（恢复补记）」；<br>• 结束时间取被中断回合最后一条真实事件（推断，README 没写时间戳取值）；<br>• `TOOL_OUTCOME_UNKNOWN` 当作和规则 5 同构的证据，续跑提示里不要求模型重做外部动作。 | M0 symbols；§8.3 (b) | 设计 | 高 |
| SA-19 | **派生状态「在等模型重试」。** 按 seq 维护水位，`retry-started` 不算恢复，同一回合、同一步的模型消息才算恢复；只显示，不催促。原型只追 `budget_exceeded`，我们的类别和坏样本要另定。事件名在 S1/S2 的日志里核实。 | M0/M1 的 DSH 解析器 | 设计 | 中 |
| SA-20 | **投递任务按水平触发、按代号结算。** 投递任务只记「这个乐章有待投」，执行时按当前未投列表收齐，合并自然成立；在途尝试只结算自己那一代。合并只更新载荷，退避计数不清零。 | §8.3 规则 4（合并，M1） | 设计 | 高 |
| SA-21 | **退避要活过重启，但不存墙钟。** 次数从 journal 里的失败记录算，时长走 Clock 端口；临时延后（Later）也计数，并设一个上限条目；A13 的熔断计数也从 journal 来。 | M0 计划 L705、L963；§10.4 A13 | 设计 | 高 |
| SA-22 | **幂等键取事件身份，不取内容。** 用 jseq、actionId、实体 id 加序号，或请求方给的稳定 requestId；去重只在同一次投递的重试之间做，不拿整段历史去比。 | §8.3 规则 5 的说明；M1 Post Office | 设计 | 高 |
| SA-23 | **P9 的格式。**<br>• 每道防线一行三栏：防什么 / 不防什么 / 残留由谁兜；<br>• 写在模块头注释里，被拒时给命名错误码；<br>• Tuning 页的提示文字带「不防什么」，CI 检查这一栏非空；<br>• 规格里的强度表和头注释比对，不能另写一份更乐观的。 | 开眼 P9（候选）；r4 §10 各小节；M0 Tuning | 设计 | 高 |
| SA-24 | **分类表的最后一行必须是「不明」**（带原因码），不能是忙碌态或正常态。static-render.test 加一例，用「兜底改回 working」的坏样本校准。原型今天没有误判的实例，这是防御性规则。 | UI 设计；static-render.test | 设计 | 中 |
| SA-25 | **计数和判定只算一次。**<br>• 分组计数 = 同一份快照里渲染出的行数 + 它在 clipped 里的份额；<br>• 时间窗的边界在一份快照里只经 Clock 读一次，写进快照字段；<br>• 「停摆」「超时」「需要你」只由一个函数算，窗口参数只在一处定；CLI 退出码和 UI 读同一个字段。 | store.test；UI 设计第一节 7 | 设计 | 高 |
| SA-26 | **SA-10（守护进程自检）的细化。**<br>• 确定性程序，不用 LLM；<br>• 由 Windows 计划任务连一次锁管道，不探 HTTP，不受事件循环卡顿影响；<br>• 连续 K 次失败才判死，「慢」和「死」用不同的符号；<br>• 默认不自动重启；<br>• 退出码用 20–29 段，0 只给「每个部件都报过 ready 且新鲜」；<br>• 写明不防机器睡眠、不防计划任务被删。 | §5.3；并入 Q-SA1 | 新增行为 | 中 |
| SA-27 | **健康条目一名一主。** 同名第二次登记就抛错；「要你处理」档要连续 N 次或持续 T 才进入，N、T 标「假设」。 | M0 `source-report.ts`（M0 计划:550） | 设计 | 高 |
| SA-28 | **对你说话只有一个出口。**<br>• 出口处按分词计数限长，超了退回一次修复回合，不截断、不拆条；<br>• 按枚举的目的放行；<br>• 「三种情况才开口」写成只读 journal 的纯函数，套用开眼 §7.3 的打断分类；<br>• 只有措辞要求留在提示词里。<br>原型只对飞书的 reply 和 ack 强制，GitHub 一侧经 `gh` 直接发出，绕过了出口。 | M1 主代理和 QA 乐手；开眼 §7.3 | 设计 | 高 |
| SA-29 | **路由分类器逐候选表态。** 对第 5 步的每个幸存者给 `{fit, reason}`；宿主校验条数等于幸存者数、选中的 fit 为真、恰好一个 fit。三条都满足才自动派，否则出「Route to?」卡。 | §9.2 第 9 步（M4） | 设计 | 高 |
| SA-30 | **规则版本与提交点复核。**<br>• `rulesVersion` = 路由纯函数全部输入的规范化摘要，键和集合都排序；<br>• 作废记录的 cause = 那次配置变更的 journal seq，A→B→A 不会撞；<br>• 放行 hold、shadow 转 active 时，用当前版本重跑确定性闸门；<br>• 被 hold 的消息按反事实归因分卡。<br>原型的版本刻意不含 Source 配置，评估提示词不改版也没写明。 | §6.1 RouteDecision；§9.2（M4）；A6（M2）。§8.3 规则 10 只是类比 | 设计 | 中 |
| SA-31 | **转派时原话由守护进程独立附上。** 信封 refs 必带你那条消息的 exchangeId，原话作为引用数据内联（trust 不升级，A5）；协调者的附言单独一个字段，按分词限长（数值待定，假设）。 | §9（M4）；M1 主代理转派 | 设计 | 高 |
| SA-32 | **LLM 代办的动作锚到来源消息。** 「先有 A 才能做 B」的动词，B 的参数里必须带 A 的 id，由代码核对、一次用完；中转只引用 id，展示内容由守护进程从源记录渲染。原型的 answer 许可有缺口：没有工单关联的人类消息，Router 可以直接回复（`replies.ts:81`）。 | M1 主代理的 request-only 条目；M4 Maestro | 设计 | 中 |
| SA-33 | **mcp 层工具随授权到期。** Task 被你取消或愿望暂停后，再对它调 `orchestra_update_task`，返回 `task-closed`；在途回合照常跑完，不碰 Q-P10 = B（守护进程不打断越界回合）。M1 只能覆盖 `orchestra_report` 自身。 | §8.6（`orchestra_update_task` 在 M3） | 设计 | 中 |
| SA-34 | **注入块摘要写进 journal。** 乐章启动时，把人设、已定决策注入、契约摘要的 sha256 写进 part 记录；A18 和 WP-24 的验收在回放和线上都比对这个摘要。不照搬原型「每次请求读最新版」。 | M1 | 设计 | 高 |
| SA-35 | **迁移照借三点：** 新库拒开、单事务、失败时库不动。打开库时的副作用（WAL、列比对）也要算进「不动」里。 | Q-SA8 | 设计 | 高 |
| SA-36 | **用 DSH 自带的函数校验配置。** 零 token CI 调用钉死版本 DSH 自带的 entry schema 和 patch 函数来合成、校验 `cordis.yml`，DSH 升级时 schema 变了能直接变红。 | §7.4 快照 CI | 设计 | 中 |
| SA-37 | **S2 补项。**<br>(a) Web UI 在第一回合前打开自有会话，预设或权限会不会变？A、B 两个候选都测，并挂到 §11.8 私有 DSH 控制台；还有乐章在用的预设行不许删。<br>(b) 候选 B 的 settle 和 `turn/end` 等不等 shell job？DSH 的 job wait 会不会吃掉完成通知？<br>(c) S2 ⑥ 拆成两例：web API 的 `session.prompt` 同 requestId 重发；进程内 `agent.followup` 同一 MessageId 在领走之后再发。另加崩溃点「工具调用之后、flush 之前杀进程」，看 user/message 有没有落盘。<br>(d) job 的 settled 事件和唤醒回合 running 的先后。<br>(e) SDK 当候选 C 顺带打分。<br>(f) 子代理改成异步 activation 之后，§8.7「运行中不能输入」要重核；`tool-workflow` 的 `enableRunInBackground` 键还在不在。 | M1 S2 | 证据 | 中 |
| SA-38 | **观察器的两个诊断信号。**<br>• DSH 回合结束时，这个会话名下还有活 job，就显示「回合结束（后台仍有 N 个）」；<br>• stranded-notice：乐章空闲，且 inbox 投影里 next-step 不为空，持续超过 T。它是给规则 8、规则 11 的诊断输入，不是补一只钟；阈值未校准前显示「未测」。 | M0 观察器；M1 | 设计 | 中 |
| SA-40 | **人类动作的下游注入腿。** ActionOutcome 在 `applied` 之外另带一个注入状态；「已注入」按 §6.3 的 read 口径取证，不能用「出了队列」代替。 | M1 Decision board、乐手页 | 设计 | 高 |
| SA-41 | **附录 F 零 token 用例，打包加入。**<br>(1) agent 侧通道调改配置、改提示词、改入站策略，一律类型化拒绝，journal 里 0 条配置变更。<br>(2) M0 鉴权：默认 fixture 带完全相等的 Origin；单列「整个不带 Origin → 403」和「GET /api 不带 cookie → 403」；用「缺失放行」的坏样本校准。<br>(3) 执行者发 `impossible` 只能进 blocker Decision；原型的「无事可做」先定好映射到哪个处置。<br>(4) 守护进程代填的结局与乐手自报的结局，记录和渲染都不同。<br>(5) 已结束条目上的动词 → `noop:already-ended`。<br>(6) 乐章请求扩大自己的入站范围，或读未投递给它的 exchange → 拒绝。<br>(7) 外部非名单人在已结束任务的线程留言 → 复活 0 次、投递 0 封（挂 Q-SA2）。<br>(8) I27 坏样本：文本含「500」的非 HTTP 错误判 unknown；429 分成 quota 和 capacity。<br>(9) Clock 坏样本：本机时刻塞进对方的过滤器、字典序时间戳、同一线程两种平局规则、外部时间戳和本机时间戳混比。<br>(10) D20 影子级乐章和正常乐章的工具面差异由 CI 断言。<br>(11) 一条人类消息最多开一个 Work（待 Q-SA9）。 | 附录 F；M0 步骤 4、8；M1 | 证据 | 高 |
| SA-42 | **驻留表和规则 8 的补充。**<br>• I07 驻留表加「外发／投递重试中」一行：写明最大次数或时长，到点出一条带「重试 / 放弃」的条目；超时类外发转「投递不明」，不自动重发。<br>• 规则 8 的说明：截止不因唤醒重置；`timedOut` 和「回合结束」是两个符号；交给人之后留下的后台进程，要么挂在 procguard 的活句柄上，要么出一条你名下的条目。 | I07（M1）；§8.3 规则 8 | 设计 | 高 |

（SA-39 并入 Q-SA10，不单列。）

---

## 5 对上一轮笔记的更正

| 上一轮位置 | 原写法 | 应改为 | 证据 |
|---|---|---|---|
| 结论 3（L22）、§三「完成」行（L177） | 执行器报 ready → 人审 PR | 只有跟踪 PR 线程的工单才等合并或关闭；没有 PR 的一报 ready 就结束为 completed。`dropped` 由执行器自行收工。最近一次报告为 ready 时，结果就能发给人 | `assignments.ts:128-132`，`replies.ts:69-73` |
| §二「重启后小心」（L160） | 与 r4 并列为相同之处 | 移到「不同之处」：原型每次重启都 restart，没有次数上限；r4 §8.3 (b) 只恢复一次。原型重投的只是从没领进历史的输入 | `assignments.ts:83-92`，`tickets.ts:329-337` |
| §1.2 L112、SA-4（L195） | 给人的消息预留槽，唤醒优先于新启动 | 人的唤醒可以超额 1 格，没有优先：同一轮里新启动先注册、先预留，平局时新启动赢。人的新请求被接受后走普通启动，享受不到这格余量。主会话的状态请求也占这一格 | `dsh.ts:192-196、232-235、274、292`，`docs/003-execution.md:59` |
| §1.2 L98 | Decision 有四种 | 代码里还有 `reopen`（旧版遗留）；`unavailable` 覆盖五种来源，不是 glossary 说的「未完成」 | `model.ts:190`，`docs/001-domain.md:109` |
| §三「存储」L183；§1.2 L127-131 | 只增不删；007 Open questions 有四条 | 行不删除，但每次原地整行覆盖，没有状态历史，也没有完整性校验。007 的 Open questions 只有两条：可信字段、部署隔离。「无限增长」出自存储一节，「不是安全边界」出自 003 和 locales | `store.ts:204、212、235、245`，`docs/007-architecture.md:484、614-617` |
| SA-1 ②（L192） | inject = 写进历史但不唤醒，对应 D16 的 notice | inject 只是放进下一步的待处理队列，空闲时一直挂着，cancel 或销毁时会被丢掉。DSH 原话是 Injection is not a durable mailbox。原型注释写错了，上一轮照抄了 | 上游 `packages/core/agent/src/runtime-types.ts:263-267`；`delivery.ts:65` |
| SA-1 ③④（L192） | 跨重启至多一次；flush 之后才回执 | 实际是「按确定性 id 去重的至少一次」。notice 在 inject 时就记成已送达，被丢弃后不会重投。返回给生产者的 promise 确实在 flush 之后 resolve，但写「已开始」的 accepted 回调在 flush 之前执行 | `delivery.ts:74-84`，`dsh.ts:466-468` |
| SA-2、SA-3（L193-194） | 可以分开借的设计 | 与 §7.4 的 quiet 冲突，要你拍板（Q-SA4）。SA-3 写浅了：30 min 每次空闲重新起算、只在内存；到点后 subagent 照跑却报 waiting；交给人的 job 不受限 | `dsh.ts:634-671`；r4 L897 |
| §1.2 L113 | 失败按 2 s 起、最长 1 min 重试 | 2 s / 1 min 只是默认值；启动和外发回复是 5 s 起、最长 5 min | `effects.ts:70`，`dsh.ts:232-233`，`outbox.ts:24` |
| 结论 2（L17）、§二 L159 | 「先存后做」对原则 8 | 同构说过头了：effect 行成功后删除，不能重放；到期时刻用墙钟；DSH 和 GitHub 查不到就重发；锁是心跳锁。候选 B 的「同 requestId 重发、由宿主去重」r4 本来就允许 | `effects.ts:62-64、135`，`src/sources/github-channel.ts:34-37`，`runtime.ts:92-93` |
| §二「消息不带权限」（L157） | 与 §8.5、D15 相同 | 读这些消息的 Router 自己就能改名单、准入表、模式和评估指令，「外部文本改不了策略」只是提示词约束。L205 已指出与 D8 冲突，只改 L157 的措辞 | `main.ts:248-299`，`settings.ts:44-52` |
| §1.2 L104、§二 L158 | 默认 observe，只记「本来会接」 | observe 只管推断候选。名单内的人 @ 或私聊就是 explicit，在任何模式下都直接开单；r4 的 shadow 是「执行的仍是你的选择」 | `docs/002-authorization.md:98-101`，`policy.ts:55-60、197、204` |
| §1.2 L105 | 版本变了，Eval 作废重排 | 版本只哈希 rules、eval.mode、policy.sources。Source 配置被刻意排除，但 gate 和恢复前的重新校验都读它；评估提示词改了不改版。版本不变时不算影响，Source 收窄后，依赖它的授权会在恢复时被静默撤销 | `policy.ts:116-118`，`settings.ts:180`，`prompts.ts:239-246`，`docs/002-authorization.md:119` |
| §三「路由判断」L178 | 之后路由全由 LLM 会话完成 | LLM 前后各有一层确定性：逐规则校验、`admitsInferred`、提交点比对版本、直接路由时重跑 gate、stop 要求 explicit | `policy.ts:40-61`，`evals.ts:152、269-299` |
| §1.2 L126、§三 L176 | 管理 API agent 也能调用，权限与面板相同 | 字面不错，要补充两点：走工具路径记 `tool`，权限比面板小；用 curl 不带 Origin、只带请求头，就是完整的 `panel` 权限，和 tonghuashun 同一个洞 | `http.ts:75-79、201、210`，`settings.ts:45、51` |
| §1.2 L92、§五 L207 | 在线改提示词和规则只属于文章的 Watchdog | 仓库里确实没有 watchdog，但这个能力在 Router 的工具上。冲突的是原则 2、§3.2、D8，A6 只是类比 | `main.ts:248-299` |
| §1.1 L50、§二 L151 | Router 可以不配 Bash | 原型给 Router 保留了 bash、read 和 job_*，并设 `danger-full-access`。router 预设的文件系统不可写，shell 带 sandbox，5 s 等待上限；sandbox 在 full-access 下是否还起作用没核。win32 上可能根本没有 shell（推断） | `sessions.ts:152、263`，`cordis.patch.yml:121-167` |
| §1.2 L116 | 自动合并的条件 | 只是提示词约束，host 没有合并决策逻辑，文档建议用分支保护强制；默认没有 merge CLI，由人合并 | `docs/003-execution.md:84-90`，`migration.ts:202` |
| §1.1 L61 | IM 100 词（单源） | 代码已证实：按 Segmenter 中文分词计数，只对飞书的 reply 和 ack 强制 | `text.ts:2-15`，`outbox.ts:29` |
| §二 L152、§1.1 L51 | Worker 不直接对人，只向 Router 汇报 | 只对 IM 成立。worker 直接用 `gh` 回复评审、写 PR 描述、关 PR、强推，不经 Router 和出口 | `skills/dsh-superagent-github/SKILL.md:12`，`prompts/team/delivery.md:17-28` |
| SA-6（L197） | 阶段表互斥且覆盖所有情况 | 覆盖是靠最后一行「其余一律 working」兜底；「计数等于列表长度」代码没有全守住。借的时候要改形（SA-24、SA-25） | `stage.ts:20`，`sources.ts:46` |
| SA-8（L199） | 与 detail 端点、`{key,args}` 同一思路 | 类比太宽，那两者都面向人。更贴切的对照是 A16（薄完成），而 r4 在 M1 缺 ref 的续读路径（Q-SA6） | `src/app/assessment.ts:186-256` |
| SA-10（L201）、§1.2 L125 | 按退出码分流的外部检查 | 执行者是 LLM 排程，只能借「按退出码分流」这个形状。退出码另有缺口：参数错误退出 2；控制锁被占退出 1；卡在优雅停止的服务很可能读到 ready（推断） | `docs/006-deployment.md:133-141`，`scripts/dsh-superagent:222-231`，`runtime.ts:213、231` |
| §1.2 L96、§七 | Windows 原生未核实，tmux 多半要 WSL | 可以静态坐实：宿主插件不支持原生 Windows。服务脚本 import `fcntl`，用 `ps` 和 tmux，shim 是 `/bin/sh` 脚本；`stateDir` 那条论据偏弱。只有 DSH 预设带 win32 分支 | `scripts/dsh-superagent:10、59、166-181`，`environment.ts:89`，`cordis.patch.yml:47-62` |
| §1.3 L135 | peer 依赖 ^0.2.1-alpha.2 | peer 写法没错，但安装文档钉的是 rc.3，测试 devDependencies 钉的是 alpha.2：测过的版本不等于装上的版本 | `docs/006-deployment.md:76`，`package.json:53-123` |
| §1.1 L60、§六第 2 条（L221） | 异步 `start()/stop()` 已实现、默认关闭（多源） | 上游 master 找不到对应的 API 或开关，SDK 的 `start()` 只是握手。自 v0.2.1-alpha.1 起，子代理委托只有「异步 activation + 收尾通知」一种，没有开关 | 上游 `docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md`，`packages/subagent/tool-subagent/README.md:12、60` |
| §1.2 L107 | 结束时没读、没回的消息退回 Eval | 这一点已有。补一句：「读过」以消息提交进历史为证据，`inbox/claimed` 不算 | `dsh.ts:493-503`，`tickets.ts:350-353` |

---

## 6 文章原文与 DSH 上游的核实结果

### 6.1 文章

- 原文仍然没读到（原因见 §0）。上一轮标「单源」的说法这一轮既没确认也没推翻，包括：Router 是全局序点、Worker 不直接通信、Inline & Spill 引用图、Watchdog 能改主系统、批处理 1.0→2.8 和 6.4→1.6 s、凭据开放问题。
- 例外有两项，靠原型代码坐实了：IM 不超过 100 词（`text.ts:2-15`）；Inline & Spill「截断有记号、续读只能用 host 发过的句柄」（`assessment.ts:37、191、254`，`src/app/resources.ts:104-110`）。

### 6.2 DSH 上游（master，2026-11-01）

| 机制 | 上游事实 | 对 r4 的含义 |
|---|---|---|
| `inject` | 放进下一个 pre-step 的待处理队列，不唤醒；空闲时一直挂着；cancel 或销毁时可能被丢（`runtime-types.ts:263-267`）。cancel 不带 `keepInbox` 会清空排队（`:44-50`） | SA-13；已读不能只认 claimed（SA-11） |
| 持久化 | append 是尽力而为，flush 返回才是持久屏障（session-persistence README:12、88） | SA-12 |
| job 等待 | 只有 user 写的消息能结束 `job_output(wait)`；插件 notice 和非 user 来源都不能（tool-jobs README:32） | SA-15；relay 来源不会回满唤醒预算，r4 §8.5 已写 |
| settle | `whenIdle` 不标识任何一条消息的结算（`runtime-types.ts:214-219`）；`messageId` 不标识回合结束（sdk/protocol README:80）；SDK 的 `finalResponse` 不做因果归属（sdk/client README:145） | SA-14 |
| 取消原因 | 枚举有 `user`、`parent`、`hook{reason}`、`disposed`，写进持久的 `turn/end{aborted}`（core.md 约 359-368） | SA-17 |
| 来源形态 | ContextForm 有 instructions、catalog、snapshot、notice、relay、recall 六种；relay 指 agent 写给 agent 的信；notice 必带不超过 120 字的 summary（`packages/llm/llm/src/message.ts:39-122`） | SA-16 |
| 去重 | inbox 只拒绝重复的「待处理」id（core.md 约 343）。r4 §8.3 (a)「宿主按已提交的 user/message 去重」引的 [core]，其实只说了 web API 层的 requestId 去重 | SA-37c |
| 恢复补写 | 恢复时追加 `turn/end{interrupted}` 和 `TOOL_OUTCOME_UNKNOWN`（session-persistence README:61、133） | SA-18 |
| 投递竞态 | 子代理收尾通知走 steer，不走 inject；必须先投递再释放所有权，两条次序都有测试钉住（settlement 归档笔记:34、38、46、50） | SA-13 |
| quiet 通知 | 唤醒预算用完不会随时间恢复，只有 user 输入能回满；客户端里看不出有通知在等（tool-jobs README:42、56、178） | SA-38 |
| SDK（stdio JSON-RPC） | 审批回调失败即关：取消、关机、断开都按拒绝处理；`session/prompt` 返回持久入队回执；`session/wait` 等后代；没有 cancel 和 session-close（sdk/protocol README:30、43、141） | 候选 C 顺带打分（SA-37e）。没有 cancel，S2 ④（中断单个分身）只能杀进程 |
| webhook（实验性） | 规则是一段受信代码；来源是 `{kind:'webhook', form:'notice'}`；必须显式写权限预设；`deliveryId` 不作为内建的去重状态（`packages/experimental/webhook/src/types.ts:19`） | 只作为 Q-SA2 的证据。webhook 要公网入站，和 r4 §3.1 原则 9（只走 loopback）冲突，原型的轮询更贴合 r4 |
| 子代理委托 | v0.2.1-alpha.1（2026-10-06）删除了 `backgroundMode` 和 `run_in_background`，每次委托都立即返回 activation id，结果靠收尾通知交付 | 一条 prompt 跨多个回合会成为常态；§8.7「运行中不能输入」要按钉死的版本重核（SA-37f） |

发布版：dsh-v0.2.1-rc.5 在 10-30 02:12Z 发布，v0.2.2-alpha.2 在 10-28 02:50Z 发布。`approvalRequests`、webhook 进了哪个发布版，没有核。

---

## 7 要你定的新问题

**Q-SA4：要不要放开 §7.4 的 `completionDelivery: quiet`，换取 SA-2 和 SA-3？**
- 一边是保持 quiet（r4 L897 已定：后台任务完成只注入通知、不开新回合）。好处是 Governor 名额和 `calls(n)` 都管得住。代价是：长命令转后台后回合会提前结束，规则 1 可能切出一句「我在跑测试」这样的过早回信；§10.4 的 Reaper 也可能把看似闲置、其实带着活 job 的乐章关掉（§7.4 L891 原文已有这条风险）。
- 另一边是照原型放开：job 结束就唤醒执行器、在同一个槽里续跑。好处是结果能自动接上。代价是 harness 自己开的回合不经 Governor 名额（原型就是这样超出 `maxWorkers` 的），等于要推翻已定值。
- **推荐默认：保持 quiet，不单独借 SA-2。** 先做 SA-37b 的测量和 SA-38 的「回合结束（后台仍有 N 个）」显示，S2 有数据再议。

**Q-SA5：普通 Work 的 30 min 截止（规则 8）从哪一刻起算？**
- 一边是从 Exchange 进入 `delivered` 起算，queued 阶段只换标签、不计时。好处是 Governor 排队久了不会产生假的 timedOut，这也是原型的做法（`evals.ts:47-55`）。
- 另一边是从 accepted 起算，包含排队时间。好处是和 §8.1 信封 deadline（发送方给的绝对时间，第 925 行）一致，也和 §8.8 / WF-6 规定 Arrangement「从接纳请求起计」（第 1168、3624 行）一致。
- 两边冲突在于：选前者，Work 和 Arrangement 就做了相反的选择。
- **推荐默认：从 accepted 起算，保持一致；timedOut 卡上把排队时长和运行时长分两行报（P3）。** M2 若出现 Governor 排队导致的假超时，再改。

**Q-SA6：A16（薄完成：状态 + 有界摘要 + refs，截断有标记）截断后的 ref，在 M1–M4 用什么读？标记叫什么？**
- 现状：§8.6 唯一的读工具 `orchestra_read_part` 在 M5，而且只能读自己的乐章，请求方读不到别人回信的全文。
- 一个方案是 M1 给 orchestra-mcp 加一个按 exchangeId 读回信全文的工具：只接受投递给调用者本人的 exchange，分页基于首读快照，每读一次记 journal（照原型的续读句柄做）。另一个方案是等到 M5。
- 命名也有冲突：r4 A16 和规则 1 写「标 truncated」，UI 设计 L33 规定快照字段叫 `clipped`，因为有扫描规则禁 `truncated` 子串。
- **推荐默认：M1 加读回信工具；标记统一成 `{clipped, totalChars, read}`，改 A16 的措辞。**

**Q-SA7：Maestro / 主代理乐手的「不写代码」要不要落成工具面？**
- 一边是只写职责描述（§9.1 L1470「从不改代码」）。原型就是这样：Router 有 bash，「不看代码」只写在提示词里。
- 另一边是落成预设：§9.1 写明 Maestro 的私有 home 预设（只读、无 shell，或 shell 只读白名单），并照 §8.6 L1079 模板乐手的写法加一条 CI 断言。
- r4 已经意识到 M1 主代理有写权限（向导要选权限预设，L2199；§8.9 (d) L1298 也写了 DSH 主代理只能靠预设本身）。
- **推荐默认：M4 前落成预设加 CI 断言；M1 的主代理乐手在 UI 上标出「有写权限」。**

**Q-SA8：journal 和 db 的格式怎么演进，升级和回退的规矩是什么？**
- 现状：r4 和 M0 都没写旧版 orchestrad 遇到新版记录时怎么办；M0 计划:522 的 journal 行格式里没有版本字段。原型的做法是就地破坏性迁移、新库拒开、单事务，回退靠手工备份。
- 建议定三条：
  1. journal 每种记录带格式版本，遇到不认识的 kind 或更高的版本，就拒绝进入工作状态，以类型化退出码退出，绝不跳过；
  2. db 不做就地迁移，从 journal 全量重建（db 只是投影）；
  3. 升级前的备份就是复制 journal 文件，并记下 jseq 和 hash。
- **推荐默认：按这三条定，并照借 SA-35。**

**Q-SA9：「一条人类消息最多开一个 Work」要不要写成约束？**
- r4 的单驱动是按 Work 算的：A8 规定每个 Work 只有一个执行乐章。§9.2 第 1 步的 `@section` 会不会把一条消息派给声部里的多名乐手，r4 没写。原型允许一条消息有多个工单同时归属，同一句话可能被两个执行器各自处理。
- 一边是写成约束，配契约测试；另一边是允许扇出，由路由器标明各自的范围。
- **推荐默认：M3 定 `@section` 语义时写成约束，并加 SA-41 第 11 条。**

**Q-SA10：吸收 SA-4 时，「人的通道」是什么语义？Governor 管到哪些开回合的源？**
- SA-4 有两种做法：
  - 预留槽：给人的消息单独留 1 格，严格优先，用完排队时也排在 agent 工作前面，由 Governor 发放；
  - +1 余量：原型的做法，共用 1 格超额、没有优先，主会话的状态请求也能占。
- 覆盖面也要定：只管你对已有乐手说的话，还是也包括你新发起的请求？harness 自己开的回合（子代理收尾唤醒、你直接在乐章里打字）要不要经同一张名额表？
- **推荐默认：**
  - 预留槽、严格优先，覆盖你对已有乐手的话和你新发起的请求，agent 发起的状态询问不算；
  - §10.2 补一句「任何开回合的源都经同一张名额表，拿不到就延后通知」；
  - 你在乐章里直接打字的回合不拦，但计入占用。
- 这仍属 Q-SA1（上一轮的问题：r4 要不要吸收 SA-1 到 SA-10）里要你点头的新增行为。

另外两件不另开问题：
- SA-26 是 SA-10 的细化，并入 Q-SA1；
- D3 的「心跳锁」改成「身份锁」仍在开眼笔记 §7.5 待你点头，这一轮附上原型的实证（第 3 节第 14 条）。

---

## 8 未核实与局限

- 文章原文没读到。
- 原型没读或只读了一部分的：
  - `docs/007-architecture.md` 第 136–449、489–617 行；
  - `src/app/views/settings.ts`、`text.ts`；
  - `src/app/outbox.ts` 里 reply 的 handler，所以「外发超时后会不会重复发帖」未核；
  - `tests/migration.spec.ts`、`tests/store.spec.ts`；
  - `docs/008-cookbook.md` 第 81–412 行；
  - `src/core/engine.ts` 的 `decide()` 对 follow_up 触发的 accept/attach 有没有代码级拒绝。
- DSH 本体源码没读。以下几点只来自原型代码注释：inbox 认领和 user/message 落盘的先后、`jobs.wait` 会吞掉完成通知、DSH 自带的 `send_message` 等工具的作用范围、DSH 有没有 profile 级写锁。
- 没有实测的：GitHub 上有写权限的人能不能编辑别人的评论；router 预设的 bash-sandbox 能不能挡住回环 HTTP；win32 上 Router 是否没有 shell（推断）；卡在优雅停止的服务是否读到 ready（推断）。
- 上游的 `config-catalog.md` 行号没核；`approvalRequests`、webhook 进了哪个发布版没核。
- 「全仓库没有打断计数」没有复核。

## 被推翻的

没有整条被推翻的条目。被推翻的子论断如下：
- 「SA-4 实际靠 delivery 2 s 比 launch 5 s 短」：没有槽时 launch 根本不运行；
- 「r4 已经是单驱动，一条消息至多开一个 Work」：r4 没写；
- 「status 在 paused 时也算正常」：paused 只在 setup 待完成时出现，那时先退出 3；
- 「停止超时后每小时再发一次 SIGINT」：更可能被判成正常；
- 「Router 自改不通知人」：跳过的是注给 Router 自己的 notice；
- 「job 结束唤醒的回合会超占槽位」：settling 期间槽一直算着；
- 「改 stateDir 后插件重挂会出现两个写者」：换的是另一个库；
- 「r4 没写 read 之后被中断的回合」：规则 1 的回信状态含「被中断」；
- 「规则 11 是唯一的钟」：还有规则 8 和 waiting 的句柄核实；
- 「004 强度表写反了」：是漏写，不是写反。

## 代号速查

| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| P1 | 一符一义：结局只要需要你采取不同的动作，就是不同的符号；看不清就判「不明」 | 开眼笔记 §2 |
| P2 | 每个非终态都有钟、有主或有闸：任何等待恰好有一个放行者 | 开眼笔记 §2 |
| P3 | 时间分两份报：确定性上界 + 随机尾部@目标率 | 开眼笔记 §2 |
| P4 | 时间是输入，次序只认流：次序只来自 seq，转换写明 cause | 开眼笔记 §2 |
| P5 | 标记后于效果：已读、已触发只能晚于效果，或与效果同一提交点 | 开眼笔记 §2 |
| P6 | 细迹线、无串扰：封闭乐章只收发给它的信 | 开眼笔记 §2 |
| P7 | 眼图本身是测量：规则写成纯函数，用坏样本校准，N=0 显示「未测」 | 开眼笔记 §2 |
| P8 | 每条线只有一个驱动者：权力靠递交，不靠够得着 | 开眼笔记 §7.1 |
| P9（候选） | 每道防线写明它防什么、不防什么 | 开眼笔记 §7.8 |
| I01 | 定时器触发写进 journal；每次转换写 transition 并带 cause（source/human/clock） | 开眼笔记 L71；M0 计划:528 |
| I05 | 一套结局词表，结束只来自原生结束标记 | 开眼笔记 L113 |
| I06 | 时延门槛写成确定性上界加随机尾部目标率，阈值大于录到的最坏值 | 开眼笔记 L90 |
| I07 | 驻留表：每个非终态填上钟、主或闸 | 开眼笔记 L116 |
| I11 | 别人的时间戳只比相等 | 开眼笔记 L84 |
| I12 | 单写者锁看身份，不看心跳 | 开眼笔记 L87；M0 计划:102 |
| I23 | 每个 Task 一本只追加的尝试账本，上限计数都是它的视图 | 开眼笔记 L129 |
| I24 | 封闭复核乐章只收守护进程发的复核 Exchange 和你亲手发的消息 | 开眼笔记 L131 |
| I27 | 错误类别在边缘判，unknown 不自动重试 | 开眼笔记 L133 |
| D3 | 一个守护进程 orchestrad；原文写「单写者心跳锁」；否决只靠 token + Origin 的 loopback 守卫 | r4 §4 L487 |
| D4 | 三类所有权；Orchestra 只驱动自己创建的会话 | r4 §4 L488 |
| D5 | DSH 自有驱动在 S2 之后定：候选 A 是 ACP 客户端，候选 B 是私有 dsh web 加 bundle | r4 §4 L489 |
| D8 | 只有一个审批队列，超时即拒；人类动词只挂在要配对 cookie 的 UI 监听器上 | r4 §4 L492 |
| D9 | AutoRoute：先确定性规则，再 router-core，只有模糊时才用 LLM，先 shadow | r4 §4 L493 |
| D15 | 类型化权威只用 trust 一个字段：human 只等于配对过的 UI | r4 §4 L499 |
| D16 | 沉默有效：reply、notice、progress 不开 Work，notice 默认不唤醒 | r4 §4 L500 |
| D19 | 愿望层：完成是判定，任何 agent 都不能置 done | r4 §4 L503 |
| D20 | 自治分级：默认有人值守，你不在时不派新的执行 Task | r4 §4 L504 |
| 原则 2 | 人是唯一的权威；消息永远不携带权限 | r4 §3.1 L431 |
| 原则 4 | 排队，不失败 | r4 §3.1 |
| 原则 7 | 钉死版本；解析失败降级为 unknown | r4 §3.1 L434 |
| 原则 8 | 单写者、可重放；结果不明就不重发 | r4 §3.1 L435 |
| 原则 9 | 本地、只走 loopback、Windows 优先 | r4 §3.1 L436 |
| §3.2 | 非目标：不做云端或多租户；agent 不能自己建乐手或例程 | r4 §3.2 |
| §6.3 read / delivered | delivered：投递调用成功返回或在目标日志里核对到；read：目标的某个回合已经带着这条消息开始 | r4 §6.3 L727-728 |
| §7.4 quiet | 私有 home 里 `tool-jobs.completionDelivery: quiet`：后台任务完成只注入通知、不开新回合 | r4 §7.4 L897 |
| §8.2 | 按 harness 投递表；DSH 候选 B 的 read 证据写「S2 确定」 | r4 §8.2 |
| 规则 1 | 自动回信：消费请求的回合结束时最终文本成为 reply；状态由守护进程填 | r4 §8.3 |
| 规则 4 | 合并：同一发送者的未读消息合并成一条投递 | r4 §8.3 |
| 规则 5 | requestId 幂等：结果为 unknown 的绝不自动重发 | r4 §8.3 |
| 规则 8 | 每 Work 截止时间：默认 30 min，超时出 timedOut，守护进程不打断 | r4 §8.3 L972 |
| 规则 9 | 沉默与唤醒：notice 为 wake:none | r4 §8.3 |
| 规则 10 | 重启后按目标当前的入站策略重新接纳（A7） | r4 §8.3 |
| 规则 11 | 回访：委托停滞时只唤醒提问者一次，绝不自动重新规划 | r4 §8.3 |
| 重启表 (a)(b)(c) | (a) 投递未返回：核对日志，找不到记 unknown；(b) 已投递、回合被杀：只恢复一次；(c) 已结束：按日志结算 | r4 §8.3 |
| §8.5 | 信任规则：消息不携带权限；external 只经默认关闭的 A2A 网关 | r4 §8.5 |
| §8.6 | orchestra-mcp 工具清单：没有批准、拍板、改权限或改配置的工具 | r4 §8.6 L1039 |
| §8.8 / WF-6 | Arrangement 的超时从接纳请求起计，包含排队时间 | r4 L1168、L3624 |
| §10.2 | Governor（速度控制）：只管得住 Orchestra 自己发起的投递和乐章启动 | r4 §10.2 |
| §10.4 | Reaper（回收器）、轮换熔断、夜间失败分类 | r4 §10.4 |
| §10.11 | 凭据与 UI 安全：变更只收 POST，要 CSRF 头，Origin 缺失或不完全相等一律拒绝 | r4 §10.11 |
| §11.8 | 其它屏幕，含可选的私有 DSH 控制台（dsh web --port 3199，M2） | r4 §11.8 L2227 |
| A2 | 邮件寄给乐手；accepted 先于 delivered | r4 附录 L3406 |
| A5 | 权威链卫生：转发或计算出的文本永不携带人类权威 | r4 附录 L3409 |
| A6 | 每乐手入站策略 accept/hold/refuse，只有人能改 | r4 附录 L3410 |
| A7 | 按当前策略重新接纳 | r4 附录 L3411 |
| A8 | 每个 Work 一个执行者（executionPartId） | r4 附录 L3412 |
| A13 | 轮换熔断：区分确定性和瞬时失败，每小时有上限 | r4 附录 L3417 |
| A16 | 薄完成：状态、有界摘要、refs，截断有标记 | r4 附录 L3420 |
| A18 | 每乐章冻结注入上下文，同一乐章内逐字节一致 | r4 附录 L3422 |
| R72 | 夜间失败分类：认证不重试，容量退避 3 次，配额等重置 | r4 L2878 |
| WP-23 | 契约改版时，旧版本的处置拒收，在新乐章重派 | r4 L2466 |
| WP-24 | 执行者改契约 → 拒绝，契约摘要与注入块逐字节不变 | r4 L2467 |
| Q-P10 = B | 守护进程不打断越界的在途回合，只出 P1 请你中断 | r4 L165、L1273 |
| S2 | M1 第 1 周给私有 DSH 候选 A/B 打分的验证清单（①–⑲） | r4 §13.3 L2403 |
| S2 ①④⑥⑲ | ① 以非 user 来源投递；④ 中断单个分身；⑥ 崩溃后 requestId 去重或日志核对；⑲ 候选 B 的 settle 是否等后代收尾 | r4 L2403 |
| D-16 | 人这一端的 seen 从哪来，待你定 | UI 设计 L18 |
| M0–M4 | 里程碑：M0 只读注意力层，M1 自有会话互发消息，M2 安全强制，M3 声部，M4 Maestro / AutoRoute | r4 §4 D1 |
| SA-1 … SA-10 | 上一轮的借鉴项（DSH 投递参考实现、短超时、后台工作、人的槽、Mandate、状态表、沟通规范、批处理、实验方法、守护进程自检） | 上一轮笔记 §四 |
| Q-SA1 | r4 要不要吸收 SA-1 到 SA-10（其中 SA-4、SA-10 是新增行为） | 上一轮笔记 §六 |
| Q-SA2 | 要不要把外部事件源（GitHub、CI、飞书）纳入规划，建议 v1 不做 | 上一轮笔记 §六 |
