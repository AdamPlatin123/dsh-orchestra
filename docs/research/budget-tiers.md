# 愿望预算的档位架构

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-28 |
| 状态 | 综合稿，已按一轮红队修订（见 Review log）；不修改 r4，对 r4 的修订见本文 §5 |
| 依据 | 三份原始报告 [B1]–[B3]；r4 规格 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`（下称 [spec]，只读） |
| 起因 | 讨论 Q-P6（愿望预算默认值）时你的要求：不按具体 Quota 设计，改为 3–5 档的高层控制，类似 Claude 的 effort 档位，先调研再定 |

**证据键**
- [B1] = [budget-harness.md](budget-harness.md)：Claude Code 与 Agent SDK（CC-MC、CC-SET、CC-WF、CC-GW、CC-BIN、SDK-TS、SDK-LOOP、SDK-COST）、Claude API（API-TS、API-SKILL）、Codex（CX@ce2d47b、CX-BIND）、DSH 0.2.1-rc.2（`DSH:` 前缀）、DeepSeek 价表（DS-PRICE）。
- [B2] = [budget-frameworks.md](budget-frameworks.md)：Claude Code 工作流（CCW）、Cursor（CUR-*）、Devin（DV-*）、Manus（MN-*）、Grok Build（GB）、Roo Code（RC）、Cline（CL）、OpenHands（OH）、Paperclip（PC）、hermes-agent（HA）、DS-Bot（DSB）、K8S、AWS-*。
- [B3] = [budget-evidence.md](budget-evidence.md)：决策研究（HICK、COWAN、IL、IHJ、SGT、CBG、NBS、JDWJ、MERT、MAIER、MACKAY）、厂商指引（CC-MC、CAPI、OAI-PY、CX、GENAI）与 r4 预算旋钮表。
- 报告内部的证据键只作括注；一手出处见各报告的证据表。[B1] 与 [B3] 各有一个 CC-BLOG：[B1] 的是 2026-09-25 的 effort 实测文，[B3] 的是 2026-07-07 的模型与 effort 选择文，引用时带报告号。
- 标注：（推断）是本文的推理，含对已引数字的算术；（假设）是没有证据的默认值，M2 校准；（未核实）是原始报告也没能确认的内容；（本文建议）是本文自己的设计，原始报告与 [spec] 里都没有。

---

## 1. 立场

1. **档位是一个愿望的预算包络的名字。你只选档，不填数。** 推荐三档：省（`lean`）、标准（`standard`，默认）、全力（`full`）。每档是一组确定性的旋钮值（全表见本文 §4.2）：调用上限、墙钟、每 Task 墙钟、Claude 每次派发的回合上限、DeepSeek 的元与每日切片、每个订阅 harness 的输出 token 包络、账户额度水位线、复核预留，省档另加执行乐章的 effort 上限；Claude 的 `maxBudgetUsd` 由它们派生。计划卡与暂停卡上另有「自定」：逐项填上限，同 r4 从 `paused(cap:<项>)` 继续时填新上限（[spec] §8.9 (b)(g)）。
2. **档位不是 effort。** 厂商的 effort 是软的推理深度，按模型校准，同一个名字在不同模型上代表不同的量（[B1] §1 第 1 条；[B3] §3）。档位是硬预约加通知阈值。所以档名不用 low / medium / high / xhigh / max。档位从不抬高乐手的 `effort`，只有省档给执行乐章加一个 effort 上限（本文 §4.2）。
3. **档位对你隐藏 harness 的单位，守护进程负责映射。** 你看到一根表和每个 harness 一行人话；这些数字只作说明，不是要你填的输入。守护进程按版本化的档位表把档映射成：DeepSeek 的 CNY 预约；Claude 与 Codex 各自的输出 token 包络加窗口水位线；Claude 的回合上限与各家的墙钟上限。订阅额度不计入 `cny`（[B2] §5 第 3 条，Paperclip 的拆分）。
4. **只有你选档、改档（D8、A14）。** 规划者只能提议档位，提议不预选；agent 没有改档的工具；升档与降档都是你在 UI 上的一次点击，记为一条 Decision。项目默认档只能是省或标准，全力只能逐愿望选（[B1] §7 第 4 条）。
5. **档位不新增暂停、中断或条目种类。** 预约、80% / 100% `budget-incident`、`paused(budget)`、`paused(cap:*)`、闸门暂扣、`waitingOn: time` 都沿用 [spec] §8.9 (d)(g) 与 §10.2。新增的只有四样，各自复用 r4 已有的机制：每个订阅 harness 的 token 包络（复用 `budget-incident`）；账户窗口水位线（复用 `waitingOn: time`，但要一路新的实时输入：`rate_limit_event` 与 `account/rateLimits/read` 报的窗口用量）；省档的 effort 上限（扩展 [spec] §10.10 的期望值与实际值）；Decision `kind: tier` 与冻结在愿望上的 `tierTableRev`。本文 §5 逐条列出。Q-P10 = B 不动（已定 2026-10-28，[spec] 附录 G.7）：越过上限只通知，守护进程不打断在途回合。档位只决定新派发能不能出门，以及 harness 自己的上限给在途回合留多少余地。
6. **原则 5 不动。** 档位表是数据；映射是查表，再「取不高于目标的最高可用档」（[B1] §7 第 1 条）。LLM 不判定档位够不够，也不判定上限到没到（[spec] §8.9 (g)「上限判定」）。

## 2. 别人怎么分档

| 系统 | 档数与名字 | 默认 | 每档捆绑什么 | 到顶时 |
|---|---|---|---|---|
| Claude Code effort | 5：`low` `medium` `high` `xhigh` `max`；Opus / Sonnet 4.6 没有 `xhigh` | 5.5 模型 `medium`，多数其他模型 `high`；`max` 只在当前会话（经 `CLAUDE_CODE_EFFORT_LEVEL` 设定除外） | 自适应思考深度与工具调用深度，按模型校准；`maxEffortLevel` 只能往下压，多个作用域都设上限时取最低的上限 | 不是上限；不支持的档退到其下最高的可用档；在组织或 `maxEffortLevel` 上限之上的请求按上限跑；组织上限的警告在交互、json / stream-json 与后台 agent 下只进 debug 日志（纯文本 `--print` 写 stderr）（[B1] §1 第 3 条；[B3] §3 第 5 条；CC-MC，修订时复核） |
| Claude Code 工作流规模 | 4：`unrestricted`、`small`（<5 agent）、`medium`（<10）、`large`（<50） | `medium`；Pro 为 `small` | 给规划的建议目标，不是上限 | 硬上限每次运行 1,000 agent；默认并发至多 16（CPU 少时更少，可调）；>25 agent 或预计总 token >1.5M 只提示（[B2] §2；CCW:355） |
| Claude Code `+500k` | 无档，一个数 | 未设即无限 | 主循环与全部工作流共享的输出 token | 硬上限：停止新的 `agent()`，在途的跑完（[B1] §3.2） |
| Claude API | 同上 5 档（`output_config.effort`）；Opus 5.5 / 5 / 4.8 / 4.7、Fable 与 Sonnet 5.x 对 `budget_tokens` 返回 400 | `high`；Opus 5.5、Haiku 5.5 为 `medium` | 思考、正文与工具调用 token | 不强制；`task_budget` 只是提示；Managed Agents 的美元预算到顶时，越线的那次请求跑完（[B1] §2；[B3] §3） |
| Codex | 每个模型自报一个子集：`none` … `max`，另有 `ultra`（多 agent）与 `persistent` | 每模型的 `defaultReasoningEffort`；枚举默认 `medium` | `reasoning.effort`；Max / Ultra 藏在「More reasoning…」后，并提示更快耗尽额度 | effort 不是上限；goal 的 `tokenBudget` 到顶只引导收尾，不打断（[B1] §4；[B3] §3） |
| DSH | 4：`off` `low` `high` `max` | `high` | `low` / `high` / `max` → `output_config.effort`；`off` 关思考 | 没有回合或成本上限（`dsh-agent-loop/README.md:220`）；单请求 `maxTokens` 256,000；goal 轮数上限 256（自有乐手关闭 goal，[spec] §8.9 (i)）（[B1] §2、§5） |
| Devin | 套餐 4 档；企业的档名与档数由管理员定 | 每账户一个默认档 | `cycle_acu_limit` + 提额策略（unconditional / conditional / manual）+ `max_limit` | 配额用完转按需额度；档或组织上限挡新工作（[B2] §2） |
| Manus | 3：Lite、Standard、Max | 免费只能 Lite | 能力加积分消耗 | 任务前没有预估；最后一步可透支；余额 ≤0 不开新任务（[B2] §2） |
| Cursor Auto | 3：Cost、Balance、Intelligence；套餐另有 5 档：Free，及 Plus / Premium / Super / Ultra（1× / 4× / 15× / 50×） | Cost | 路由策略加计费规则 | 通知后转预付额度；官方说「不降级」，论坛报告静默换模型与静默溢出计费（[B2] §2、§4） |
| Roo Code / Cline | Roo：`allowedMaxRequests`、`allowedMaxCost` 两个数；Cline 已移除请求上限 | 未设即无限 | 连续自动批准的请求数与估算美元 | 暂停，「重置并继续」后计数清零（[B2] §2） |
| OpenHands | `MAX_ITERATIONS` 100、`MAX_BUDGET_PER_TASK` 0（不限）；云端组织月上限 | 新成员默认预算 | 美元 | 80 / 90 / 100% 告警，新会话可能被挡（[B2] §2） |
| Paperclip | 3 个控制级：可见、软告警、硬上限 | 软 80%、硬 100% | 只算计费的分；订阅内用量只作可见 | 暂停该范围，开一条三选一的审批，请求在途运行优雅取消（[B2] §2、§3） |
| Grok Build | effort 内置后备菜单 4 档（另接受 3 个；服务端可下发自己的列表）；工作流 agent 调用预算 | 工作流 128 次 | effort 可能换模型 id；预算数 agent 调用 | `BudgetLimited`，可续到 1,024（[B2] §2） |
| Kubernetes QoS | 3：Guaranteed、Burstable、BestEffort | 由 request 与 limit 推出，不由人选 | 预约形状 | 资源紧张时按档驱逐（[B2] §2） |
| AWS EC2 | 规格每级 ×2；T 系列 2 种额度模式 | T3 / T4g / T3a / T8i 默认 `unlimited` | vCPU 与内存 | standard 降到基线；unlimited 继续跑并另计费（[B2] §2） |

读法（推断）：
- **所见的有名花钱与路由档多为 3 档加一个逃生口**（Cursor Auto、Manus、K8s、Claude Code 工作流规模）。Devin 企业档的档数由管理员定，Roo Code 与 OpenHands 只有数字。4–7 级的长梯子出现在单次调用的 effort 和购买套餐上（[B2] §1 第 1 条、§2）。
- **好设计把后端单位藏在一根表后面**：Cursor 的 Cost 模式、Devin Adaptive、Paperclip 不把订阅算进钱（[B2] §1 第 2 条）。
- **档是目标，另有硬上限兜底；默认在中间或偏低；上限只往下压；到顶只停新工作，在途的跑完或被要求收尾**（[B1] §6；[B2] §1）。最后一条与 Q-P10 = B 一致。

## 3. 证据

### 3.1 选项数量与默认

- **研究分不出 3 档与 5 档。** 选择过载研究比较的是 6 个对 24 个以上；两项元分析的平均效应接近 0（SGT：63 个条件，N = 5,036），只在特定调节条件下显著（CBG：99 个观测，N = 7,202）。没有研究直接比较 3 档与 5 档的有序档位（[B3] §2.1、§6）。
- **调节条件正好落在愿望预算上。** CBG 的四个调节条件里有三个成立：偏好不确定（你事先不知道一个愿望花多少）、任务难、目标是省心（许愿就是为了不管）（[B3] §2.1，推断）。这在推断上支持少而显眼的档位加一个强默认；所研究的选项集都不少于 6 个，用到 3 对 5 是外推（[B3] §2.1）。
- **Hick 律与工作记忆是弱论据。** 3 档 2.0 bit，5 档 2.58 bit，多 29%（[B3] §2.1）；但一个愿望只选一次，不赶时间。Cowan 的中心容量约 4 块（3–5）：3 档放得下，5 档要在卡上逐档列出捆绑内容（[B3] §2.1，推断）。
- **默认才是最大的杠杆。** 58 项研究的默认效应 d = 0.68（95% CI 0.53–0.83）（JDWJ）；51 名 Unix 用户四个月里很少改定制（MACKAY）。偏差校正后，结构类干预的效应「未定」（MAIER），所以大小不确定（[B3] §2.2）。
- **中间项的拉力在价格—质量取舍里偏弱**（NBS），预算档恰是这种取舍（[B3] §2.2，推断）。所以默认档要显式预选，不能指望人自然选中间。
- **被认可的默认拉得更狠**（JDWJ）。规划者提议的档会被当成背书，所以它只并排显示，不预选（[B3] §5 第 2 条）。

### 3.2 厂商的做法

- 厂商从数字思考预算转向命名档位，但档位是软的，另有硬上限（[B3] §1 第 4 条）。
- 顶档都被圈起来：Claude Code 的 `max` 只在当前会话（经 `CLAUDE_CODE_EFFORT_LEVEL` 设定除外）；Codex 把 Max / Ultra 放在「More reasoning…」后（TUI 测试快照，发布版可能不同，[B3] §6）（[B3] §3）。
- 省额度的建议各家顺序不同。API-SKILL §2.6 建议先扫 effort 再换模型；另一条：先全部低档跑，只把失败的高档重跑，通过率保持，花费略多于一半（[B1] §3.1，API-SKILL）。Claude Code 的提示只在 Pro 套餐的 7 d 窗口出现，且先换模型：Fable 上提示 `try /model opus · more runway`，Opus 上提示 `try /model sonnet · ~2× runway`；其他模型在 `high` 及以上才提示 `try /effort medium`（CC-BIN，修订时 `grep -a` 复核；[B1] §6 的「先降 effort 再换模型」与此不符）。
- effort 的代价随工作量变化，且集中在顶端。Anthropic 的 Terminal-Bench 3.0 运行里，Fable 5.1 在 `low` 下每次尝试中位 73k token，`max` 222k，约 3 倍，通过数 140 → 214（共 370）；一个需求不明确的构建任务，Opus 5.5 在 `low` / `medium` / `high` / `max` 下分别用 1.5 / 4 / 11 / 67 min（[B1] §3.1，CC-BLOG；`medium` 一项为修订时补抓）。只有 Terminal-Bench 的数字是基准结果；构建任务是作者自称的玩具示例。两者都不是 Orchestra 的工作量。

### 3.3 各家踩过的坑

| 坑 | 案例（[B2] §4） | 本文的对策 |
|---|---|---|
| 意外耗尽 | Cursor 2025-06 改价「出乎意料」，事后退款 | 计划卡给出每 harness 的预估与最坏情况；80% 先出 P2 |
| 到顶静默换模型、溢出计费 | Cursor「自动换到另一个模型而不是停下」；Auto 溢出到 API 额度 | 到顶只 `paused(budget)` 或等待，绝不换 harness、模型或档 |
| effort 被静默忽略 | DS-Bot 运行时丢掉不支持的档；Grok 只写日志；Claude Code 在组织或 `maxEffortLevel` 上限之上的请求按上限跑，组织上限的警告在交互模式下只进 debug 日志（[B3] §3 第 5 条） | 映射结果回读，不一致就在卡上标「未应用」 |
| 同一个词不同档 | hermes 的 `xhigh` 变成 Claude 的 `max` | 档名不用 effort 词；映射走版本化的表 |
| 旋钮没接上 | OpenHands 的成本开关从不触发；Cline 的 Yolo 开关没人读 | 零 token 用例逐档断言参数到达假 harness（BT-1、BT-2、BT-16） |
| 成本知道得太晚 | 结束时才公布；最后一步透支 | 派发前预约；卡上写明一个在途回合可以越线 |
| 额度等待被当成卡死 | Claude 周额度被停成 `blocked`，没人盯（PC#10344） | 到水位线即 `waitingOn: time(until 重置)`，不是事件，也不是卡死；等待超过 N = 6 h（假设）出一条 P3（本文 §4.2） |

「档太粗」（愿望落在两档之间）在三份报告里都没有找到案例；本文把它当作设计风险，对策见 §7.1（推断）。

## 4. 设计：愿望预算档位

### 4.1 两个候选方案

**方案甲：3 档（推荐）**

| 档 | 标识符 | 一句话 |
|---|---|---|
| 省 | `lean` | 调用够约三分之一的 Task 重做一次；适合小改动与回归微愿望 |
| 标准 | `standard` | 默认；调用够每个 Task 完整重做一次 |
| 全力 | `full` | 调用够每个 Task 完整重做两次；只能逐愿望选 |

一句话说的是 `calls`。钱与 token 是每愿望的定额，不随 Task 数放大，所以 Task 多的愿望可能先撞钱或 token，这时要全力或「自定」（推断；按 T 缩放是 Q-B7 的备选）。

**方案乙：5 档**，与 Claude effort 的 5 级对齐：省 `lean`、轻 `light`、标准 `standard`、加强 `plus`、全力 `full`（默认标准）。旋钮按方案甲同样的规则插值（全部为假设）：

| 旋钮 | 省 | 轻 | 标准 | 加强 | 全力 |
|---|---|---|---|---|---|
| `calls(n)` 系数（× T + M） | 4 | 5 | 6 | 9 | 12 |
| `wallCapMin` | 30 | 45 | 60 | 90 | 120 |
| Claude `maxTurns` | 50 | 75 | 100 | 150 | 200 |
| `cny`（× Q3） | 0.25 | 0.5 | 1 | 2 | 3 |
| `cnyDay`（Q3 的份额） | 25% | 35% | 50% | 75% | 100% |
| 每个订阅 harness 的输出 token 包络 | 0.5M | 1M | 1.5M | 3M | 5M |
| 窗口水位线 | 40% | 50% | 75% | 85% | 90% |
| 执行乐章的 effort 上限 | 模型默认档 | 模型默认档 | 不设 | 不设 | 不设 |

`wallMin`、复核预留与 `maxBudgetUsd` 按 §4.2 的规则派生，`callsPerHour` 固定为 6。落到旋钮上，相邻档挤在一起（推断）：
- `calls(n)` 的系数实际上有顶。M1–M2 每次派发连带复核与「下一步」共 3 次调用；`verifySubmissions` ≤3 让带复核的尝试每 Task 至多 3 次，约 9 次调用；只有不经复核的 `null` 处置能在 `roundCap` 3 之内再多派一两次（[spec] §8.9 (e)(g)）。所以执行者导致的重做，系数的实际上限约 9–11。全力的 9 已在顶上，5 档的 12 基本到不了；下面两步只差 ×1.25 与 ×1.2。
- 水位线被 100% 封顶，5 档只能取 40 / 50 / 75 / 85 / 90 一类。四对相邻档里只有轻→标准差 25 个点，其余三对只差 5–10 个点，改变不了结局。
- effort 对齐只是名义上的：DSH 只有 4 级、没有 `medium`；Opus / Sonnet 4.6 没有 `xhigh`。顶档不能意味着 ultracode（[spec] §8.9 (i)），本文也不让它意味着 `max`（[B3] §5 第 4 条，推断）。[B1] §7 第 3 条的建议正相反：3 档映射到 `low`、各后端默认档与 `max`。本文（方案甲）不把档名映射成 effort 档位，也从不抬高 effort；方案甲只有省档、方案乙省与轻两档把执行乐章的 effort 压到不高于该模型的默认档（§1 第 2 条、§4.2），所以不采用这个映射。

**推荐方案甲。理由：**
1. 所见的有名花钱 / 路由档多为 3 档加逃生口（Cursor Auto、Manus、K8s、Claude Code 工作流规模）；Devin 企业档的档数由管理员定，Roo / OpenHands 只有数字；5 级以上的梯子出现在单次 effort 和套餐上（[B2] §2、§5 第 1 条，推断）。
2. 旋钮挤在一起（上面方案乙的计算）：`calls` 系数的实际上限约 9–11，水位线封顶 100%，5 档的相邻档多数只差 5–10 个点（轻→标准例外），差别小到改变不了结局。这是不靠类比的主要理由（推断）。若档位要对齐 effort 名字，5 档还会在 DSH 与 4.6 模型上并档（[B1] §7 第 3 条，推断）；本文不把档名映射成 effort 档位（只有省档压低执行乐章的 effort 上限），所以这一点只否定方案乙「与 effort 对齐」的卖点，不是 3 档本身的理由。
3. 研究分不出 3 与 5。默认效应有元分析支持（JDWJ），方向明确、大小不确定（MAIER）；「少而显眼」是由 CBG 的调节条件、从不少于 6 个选项的研究外推的（[B3] §2.1、§2.3，推断）。
4. 校准按（档，harness）分层（本文 §4.6）。M2 时只有 Claude 与 DSH 两个 harness（Codex 随 M4）：3 档是 6 格，5 档是 10 格；同样的愿望数均匀分布时，5 档每格的样本少 40%；默认效应还会把样本压在默认档上，非默认格更稀（推断）。
5. 两端的需求由「自定」接住，不需要更多档：低端在计划卡或暂停卡上逐项填；高端在预估超过全力时同样走「自定」（本文 §4.3）。[B3] §2.3 建议的「显示 3 档、内部 5 档」也不采用：内部档同样要校准，却没有人选（推断）。

### 4.2 每档的旋钮与默认值（方案甲；全部为假设，M2 校准）

T = Task 数，M = 里程碑数，Q3 = 项目日上限（[spec] §17.1，现为 20 CNY，假设）。

| 旋钮 | 省 `lean` | 标准 `standard` | 全力 `full` | 依据 |
|---|---|---|---|---|
| `calls(n)` | 4 × T + M | 6 × T + M | 9 × T + M | M1–M2 每个 Task 至少 3 次调用：带标记的派发、复核、「下一步」唤醒（[spec] §8.9 (d)(g)，推断）。三档都仍受项目策略封顶（[spec] §8.9 (g)）。省 = r4 现值；标准 = 每 Task 重做一次，比 r4 的默认宽 50%，因为 r4 的值只够约三分之一的 Task 重做一次，作默认偏紧（推断）；全力 = 两次，已在系数的实际上限上（本文 §4.1） |
| `callsPerHour` | 6 | 6 | 6 | 是速率不是上限，不随档（[B3] §4.1 第 6 行） |
| `wallMin`（活跃墙钟） | （`calls` 上限 ÷ 3）× `wallCapMin` | 同左 | 同左 | 假设：每次派发连带 3 次调用，每次派发可用满一个 `wallCapMin`。回合都守住 `wallCapMin` 时它不会先于 `calls` 触发，只在回合屡次越线时兜底。按上式，T = 1、M = 1 时约为 50 / 140 / 400 min。它不依赖 `callsPerHour`，后者 M2 才有 |
| `wallCapMin`（每 Task） | 30 | 60 | 120 | 规则 8 的 Work 截止 30 min；r4 现值 60；Opus 5.5 在 `max` 下一个构建任务用 67 min（作者的玩具示例，[B1] §3.1）。Q-P10 = B 下越过它只出 P1，不停回合（[spec] §8.9 (d)）；DSH 与 Codex 在全力档也取 60（见下文说明） |
| Claude `maxTurns`（每次派发） | 50 | 100 | 200 | hermes 子代理 50、OpenHands 100（[B2] §2）；全力的 200 取标准的 ×2，无外部锚点（假设） |
| 执行乐章的 effort 上限 | 不高于该模型自报的默认档 | 不设 | 不设 | 上限只往下压（[B1] §6）；effort 是厂商推荐的单次成本杠杆（[B1] §7 第 2 条；API-SKILL §2.6）；复核乐章不受影响 |
| DeepSeek `cny`（每愿望） | 0.25 × Q3 | 1 × Q3 | 3 × Q3 | Q3 = 20 时为 5 / 20 / 60 CNY；回归微愿望 ≤5 CNY（[spec] §8.9 (j)）；每级 ×4、×3，在 [B2] §5 第 10 条的 ×2–×4 之内。`cny` 与 `cnyDay` 都以 Q3 为单位，Q3 改了比例不漂移（推断） |
| `cnyDay`（每日切片） | Q3 的 25% | 50% | 100% | Q3 = 20 时为 5 / 10 / 20 CNY。全力档可以用掉项目当天全部 DeepSeek 额度，项目的其他自有工作随之排队（[spec] §10.2），计划卡写明（推断） |
| 订阅 harness 的输出 token 包络（每愿望、每 harness，含推理） | 0.5M | 1.5M | 5M | Claude 与 Codex 各一个包络（`outTokens{claude, codex}`），各出各的 80% / 100% 事件，因为两家是不同账户、不同窗口（[B1] §1 第 6 条）。Claude Code `+500k` 计的是输出 token（CC-BIN）。Claude Code 工作流预计总 token 超 1.5M 时出「Large workflow」提示；那是总 token 口径，不是输出 token，只作量级参照（[B1] §3.2；[B2] §2）。标准的 1.5M 取这个量级；省 0.5M 与全力 5M 约为它的 ÷3 与 ×3，无外部锚点（假设） |
| Claude / Codex 窗口水位线（5 h 与 7 d） | 50% | 75% | 90% | 网关 75% / 95% 预警。Claude Code 的预警看节奏：5 h 窗口已用 90% 而时间只过了不到 72%；7 d 窗口已用 75% / 50% / 25% 而时间只过了 60% / 35% / 15%（[B1] §3.4；CC-BIN）。标准的 75% 与网关的第一道预警同值；省 50% 与全力 90% 无外部锚点（假设）。形式待 Q-B4 |
| 水位线等待的 P3 阈值 N | 6 h | 6 h | 6 h | 不随档。比 5 h 窗口的任何一次等待都长，所以主要是 7 d 窗口的等待会出 P3；无外部锚点（假设）。只提醒，不改变等待（见下文说明） |
| Claude `maxBudgetUsd`（每乐章） | 派生 | 派生 | 派生 | 剩余输出 token 包络 × 该模型的输出列表价 × k。k 是一次调用的总花费（含输入与缓存）对输出花费的比，默认取 10（假设；取宽松值，让正常运行不先撞它，推断），M2 用账本校准。它只是失控兜底，包络由守护进程的账本执行。价表带版本号，派生时记下所用版本（本文建议）；各模型的列表价（未核实）。M2 起（[spec] §8.9 (d)） |
| 复核预留 | 先预约 ⌈4T/3⌉ + M 次复核的预估 | 2T + M | 3T + M | 随 `calls` 系数：每次允许的尝试都要复核，共（系数 ÷ 3）× T 次，加里程碑重跑（推断）。省档不省每次尝试的复核（原则 14）。复核先行预约，复核者由适配层按当前登录状态选（[spec] §8.9 (e)）；按预计的复核者所在 harness 的单位预约，适配层换了 harness 就重新预约（本文建议）；比例按 Q-P5 实测 |

说明：
- **单位。** DeepSeek 按真钱 CNY。Claude 与 Codex 的包络按输出 token 计，这是本文的选择，也避开了缓存读把总 token 撑大的问题（推断）。它与 Claude Code `+500k` 同口径：`budget.spent()` 计主循环与全部工作流的输出 token（CC-BIN，修订时 `grep -a` 复核）。Codex goal 的 `tokensUsed` 计未命中缓存的输入加输出（CX@ce2d47b `ext/goal/src/accounting.rs:570-575`，修订时读），口径不同。API `task_budget` 是否只计输出 token（未核实）。Claude 的输出 token 取 `modelUsage`；Codex 的取 `thread/tokenUsage/updated` 里 `TokenUsageBreakdown` 的 `outputTokens` 与 `reasoningOutputTokens`（CX-BIND，0.160.1）；前者是否已含后者（未核实）。取不到时按总 token × 规划时的输出占比估算，带估算标记（估算标记见 [B1] §7 第 6、7 条；按输出占比折算是推断）。Claude 或 Codex 走 API key、Bedrock 或 Vertex 时花的是真钱，但只计入该 harness 的 token 包络；卡上另显示按列表价折算的 CNY 估算，不加进按 DeepSeek 价定的 `cny`，免得重复计数（推断）。
- **一根表。** 愿望卡上的「用了 x%」取 `cny`、各 harness 的 token、`calls`、`wall` 这些占比里的最大值，旁边写出是哪一项（推断；借 Cursor 的单表，[B2] §5 第 3 条）。
- **水位线是等待，不是事件。** 账户窗口用量达到该档水位线时，新派发记 `waitingOn: time(until 重置)`，不出 `budget-incident`，在途回合不受影响。这是 r4「配额是 `waitingOn: time(until 重置)`」那一行（[spec] §8.9 (g) 夜间失败）的提前触发。窗口由整个账户共用，你自己的会话也在用（[B1] §1 第 6 条），所以水位线的效果是「愿望让着你」（推断）。
  - 三份报告都提议按每愿望的窗口份额计（[B1] §7 第 2 条；[B2] §5 第 3 条；[B3] §5 第 7 条）。本文改用账户绝对水位线，理由是窗口用量直接可读，而每愿望的份额只能估算（[B1] §1 第 6 条，推断）。形式留给 Q-B4。
  - 代价：省档水位最低，等得最多；7 d 窗口的等待可能长达数天。所以等待超过 N h（默认 6 h，见上表，假设）出一条 P3，写明重置时间，并给一个人类动词「本次越过水位线」（D8，推断）。
  - 解除水位线等待要两个条件：最近一次读到的用量低于该档水位线；Codex 另要 `ordinaryUsageAllowed` 为真。因服务端限额而等待（`usageLimited`、`rateLimitReachedType`）时，Codex 只认 `ordinaryUsageAllowed`，不按百分比或重置时间推断（[B1] §4.2）。
- **effort 上限只省顶端。** 各模型的默认档在 Claude 5.5 上是 `medium`，在 DSH 上是 `high`，在 Codex 上由 `model/list` 给出（[B1] §2）。省档只去掉默认档以上的级别，而代价的大头正在那里：默认 `medium` 4 min → `max` 67 min（作者的玩具示例，不是基准；CC-BLOG）。
  - 映射在乐章启动时设定并回读。DSH 经 `set_config_option` 回读 `reasoning_effort`（[spec] §10.10）。Claude 乐章实际生效的 effort 能否回读（未核实，S3 核实）；r4 的 `desired/applied` 也只有模型与权限，所以本文 §5 把 `effort` 加进去。
  - 愿望档案乐章本来就为愿望另起（[spec] §8.9 (d)），所以不在会话中途改 effort、不打断缓存（推断）。
  - 这偏离 [B3] §5 第 4 条：它主张 effort 不进档位，理由是缓存与按模型的校准。缓存由「只在启动时设」接住。按模型的校准只接住一部分：LedgerEntry 记下 `effortApplied`（本文 §4.6），事后可以拆开看，但 §4.6 的调表规则只按（档，harness）分层，省档压低 effort 的效果混在省档的格里（推断）。依据是 [B1] §7 第 2 条。计划卡的每 harness 一行写明被压低的乐手，例如「执行乐手 X：effort high → medium」。
- **两处没有自动兜底。** DSH 没有单回合上限（[B1] §5）。Codex 的 `tokenBudget` 只挂在 goal 上，而自有乐手关闭 goal（[spec] §8.9 (i)），所以 Codex 的在途回合同样没有自动兜底（[B1] §7 第 9 条）。这两家越线的回合跑到你中断或它自行结束。`wallCapMin` 不改变这一点：Q-P10 = B 下越过它只出 `timedOut` P1（[spec] §8.9 (d)）。所以 DSH 与 Codex 执行的 Task 在全力档也取 60 min 的 `wallCapMin`，只为让请你中断的 P1 更早到，不是上限。M3 bundle 给 DSH 加上回合上限之前、Codex 的预算在关闭续跑时被证实可用之前，都这样处理，计划卡写明（推断；Q-B8）。

### 4.3 谁选档，怎么改

- **规划者**在计划 schema 里给出每个 harness 的预估与一个提议档。预估只用来提示，不再让计划因预算退回规划者：预估超过全力时计划卡照常出，三档置灰，只有「自定」可用，由你逐项填上限（D8、A14；推断）。其他计划检查不过仍走 r4 的 2 轮修复（[spec] §8.9 (c)，r4 假设）。
- **计划卡**预选项目默认档；规划者的提议以「规划者建议：全力（预估 calls 超出标准档上限）」并排显示，不预选（[B3] §5 第 2 条）。预估超过某档上限的档仍可选，标「规划者预估超出此档（写明哪一项），可能撞 100%」；默认档被标时不预选任何档，由你选（推断）。规划者的预估在 M2 校准之前没有量过误差，Q-P10 = B 下越线也只通知，所以这里只提示，不硬挡；M2 量出预估误差后再议（Q-B5）。计划卡还显示接受前已花的规划费用，已超出某档包络的档同样标出（推断）。
- **每 harness 一行人话**，例如「DeepSeek ≤20 元，每天 ≤10 元」「Claude 输出 ≤1.5M token；5 小时或一周额度用到 75% 就等重置」；省档另写被压低的乐手，例如「执行乐手 X：effort high → medium」。全力档另写「这个愿望可以用掉项目当天全部 DeepSeek 额度，其他工作排队」。再加一行最坏情况：「到顶后在途回合会继续跑，直到你中断或它自行结束（会收到一条请你中断的 P1）：Claude 至多 100 回合；DSH 与 Codex（M4 起）没有回合上限」（[B3] §5 第 8 条）。
- **项目默认档**是 `Project.wishTierDefault`，只能取省或标准（[B1] §7 第 4 条）。额度小的账户可设省，同 Claude Code 在 Pro 上默认 `small`（[B2] §5 第 7 条，推断）。
- **改档是 Decision（新增 `kind: tier`）。** 你在 UI 上点改档，这一下就是人类动词，记为一条当场由你结案的 `kind: tier` Decision（`resolvedBy` 是人），不再另行确认；只有新档会让用量立刻到 100% 以上时才弹第二次确认（推断）。agent 没有改档的工具，只能在处置或阻塞里说明理由。降档可能让愿望立刻越过 100%，所以降档同样由你决定（[B3] §4.3）。计数不清零（[spec] §8.9 (a)）。
- **100% 的 `budget-incident` 卡的动作**（借 Paperclip 的三选一，[B2] §5 第 5 条；保留 r4 的「中断此回合」，[spec] §8.9 (d)）：
  - 有在途回合时，第一个动作是「中断此回合」。Q-P10 = B 下只有它能停下那个越线的回合。
  - 其后是：只把这一项加到 x（自定，主按钮）；升一档并继续；保持暂停。
  - 「升一档」会同时放宽所有旋钮，例如标准→全力：`maxTurns` 100→200、`wallCapMin` 60→120、水位线 75%→90%、token 1.5M→5M、CNY 20→60。所以点之前卡上列出每个旋钮的变化和新的最坏情况一行（推断）。全力档没有「升一档」。
  - `paused(cap:calls)` 与 `paused(cap:wall)` 的 `wish-paused` 卡给同样的动作。
- **档位表版本化**（`tierTableRev`）。计划被接受时冻结在愿望上，像 `contractRev` 一样；改表只影响新愿望（推断）。

### 4.4 档位与事件、Q-P10 = B

- 档位在守护进程一侧只在三处起作用：计划卡的提示；派发准入（预约、水位线与「再试一次」下限）；通知（80% P2，100% P1）（[B3] §4.3）。另外它决定乐章启动与每次派发的参数（`maxTurns`、`wallCapMin`、省档的 effort 上限、`maxBudgetUsd` 份额），它们是在途回合仅有的自动兜底或提醒。[B3] 的三处清单早于这些旋钮。
- 在途回合越过预约时，守护进程不打断，只出 P1 请你中断（Q-P10 = B）。所以省档的最坏情况并不比标准档好多少，除非同时压低每次派发的上限。`maxTurns` 与 effort 直接压低 Claude 回合的最坏情况；`wallCapMin` 只让请你中断的 P1 更早到（[spec] §8.9 (d)）。省档的 30 min 因此会多出 `timedOut` P1，这是省档的代价，M2 统计每档的 `timedOut` 率（[B3] §4.3，推断）。
- 每个（策略，阈值，窗口）只开一个事件（A14）。`cny` 与每个订阅 harness 的 token 包络各是一条策略，各出各的事件；`calls` 与 `wall` 照旧出 `wish-paused`。四者都按止损类暂停处理，闸门暂扣未标记请求（[spec] §8.9 (d)：`paused(budget)` 已定 2026-10-28，`cap:calls` 与 `cap:wall` 在 r4 里是推断）。

### 4.5 项目、Maestro、Arrangement

- **项目日上限不分档。** Q3 的每项目 20 CNY 仍是 Governor 的外层包络，档位只取它的份额（`cnyDay`）；到了照旧 `waitingOn: time(次日)`（[spec] §10.2）。
- **Maestro** 自己的每日 2 CNY 不分档。M4 起它当规划者时，规划花费记 `purpose: plan`，上卷到愿望根（[spec] §6.1），计入你随后选定的档；同一笔花费也受 Maestro 自己的每日 2 CNY 约束。两层是不同的包络：Maestro 的日上限管它能不能跑，愿望的档管愿望的账；同一笔钱只记一条 LedgerEntry，不是重复计费（推断）。接受前已花的规划费用显示在计划卡上（本文 §4.3）。接受前的规划受 r4 固定的规划上限约束（≤7 问、2 轮修复），不随档（[B3] §4.1 第 13 行）。
- **Arrangement** 的上限不变：64 次调用、60 min、CNY ≤ 项目日上限、预估 >25 次先报价（[spec] §10.12）。M6 里由你点 Start 的面板复核，花费上卷到愿望根、计入该档；报价超出剩余包络时，Start 卡写明（推断）。Arrangement 是否也用这三个档名，留到 M6（Q-B3）。

### 4.6 里程碑与校准

- **M1 没有账本。** 档位只控 `calls(n)`、`wallMin`、`wallCapMin` 与 `maxTurns`。前两项正是 r4 要求 M1 愿望必须显式给出的 `calls(n)` 与 `wall(min)`；后两项在 M1 本来就有（[spec] §8.9 (d)），也随档（[B3] §5 第 9 条）。计划卡上其余行显示「M2 起」。[spec] §14 第 12 行从 M1 起采集，含每个已验证 Task 的 token；本文把它细到每次派发的输出 token（Claude 取 `modelUsage`，DSH 取会话日志），供 M2 定 token 值（本文建议）。
- **M2** 加上 `cny`、`cnyDay`、token 包络、水位线、复核预留、`maxBudgetUsd` 与省档的 effort 上限（推断）。Codex 的各项随 Codex 驱动（M4，或按 Q1 提前到 M2 末，[spec] §13.6）。从 M3 起推进器不再唤醒主代理，每 Task 的最少调用从 3 降到 2，同样的系数留出更多重做余量；M3 前按数据重定系数（推断）。
- **校准。** 每次派发的 LedgerEntry 记下档、实际生效的 effort、harness（由 `partRef` 推出）、输出 token、CNY、价段（峰或谷）与窗口百分比的变化（[B1] §7 第 12 条）。窗口共用，所以窗口百分比的变化只在该愿望乐章是唯一活跃会话的区间里归因，并标估算（推断）。[spec] §14 第 12 行的「预算与调用的预估对实际」按（档，harness）分层，另记每档撞 100% 的比例、你升档的比例与 `timedOut` 率。回归微愿望集在省档跑，作为省档的参照（[B3] §5 第 11 条）。
- **新表的规则（全部为假设）。** M2 末按固定规则提出新一版档位表，守护进程算，不由 LLM 判断（原则 5）：每个（档，harness）格至少 10 个愿望才调；新值取实际用量的 P80 × 1.25；目标是默认档撞 100% 的比例 ≤15%、升档比例 ≤10%。改表是你确认的 Decision（推断）。

### 4.7 额度信号读不到时

| 情况 | 降级 |
|---|---|
| Claude 走 API key、Bedrock 或 Vertex，`rateLimitType` 与窗口字段缺失；或凭据不够读 `/usage`（例如 `setup-token`） | 不按水位线挡派发；卡上写「额度水位读不到，按 token 估算」；token 包络照常；撞到额度限制时照旧 `waitingOn: time(until 重置)`（[spec] §8.9 (g)；[B1] §3.4） |
| Codex 的 `account/rateLimits/read` 失败 | 同上；撞到服务端限额后，重置后只在 `ordinaryUsageAllowed` 为真时恢复派发（[B1] §4.2） |
| 某次调用的 token 缺失 | 按规划者的每次调用预估记账，带估算标记，绝不按 0（[spec] §10.2） |
| DSH 的 ACP 上没有成本数据 | 从会话日志取 token × DS-PRICE；价段不明就按峰时价预约，结算时记实际价段（[B1] §5、§7 第 11 条） |
| 2026-11-01 北京时间 00:00 起 DeepSeek 服务端 Search / Fetch 计费（每千次成功请求 5 CNY） | 按成功请求数计入 `cny`（[B1] §5；DS-PRICE，修订时复核） |

另外，Claude 自有乐章显式设 `autoContinueAtUsageLimit: false`，到额度不自己续跑（[B1] §7 第 10 条）；它在 SDK 下是否生效（未核实）。

## 5. 对 r4 的修订清单

| § | 修订 |
|---|---|
| §0.7 | Q-P6 的摘要改为「由档位方案取代（budget-tiers.md §7.2），待你拍板 Q-B1」 |
| §6.1 Wish | `budget{cny, cnyDay, wallMin, verifyReserveCny}` → `budget{tier, tierTableRev, overrides{}, derived{calls, wallMin, wallCapMin, maxTurns, effortCeiling, cny, cnyDay, outTokens{claude, codex}, windowCeiling, verifyReserve}}`；「CNY 与墙钟只在这里定义」不变 |
| §6.1 其他实体 | Project 加 `wishTierDefault`（`lean` 或 `standard`）；Decision 的 `kind` 加 `tier`；Musician 的 `desired/applied` 加 `effort`；LedgerEntry 加 `tier`、`effortApplied`、`priceBand`、`quotaDelta{window, pct, estimated}`，harness 由 `partRef` 推出 |
| §8.6 | 明写 `orchestra-mcp` 没有改档工具 |
| §8.9 (a) | `Wish.budget{cny, cnyDay, wallMin, verifyReserveCny}` 改为档位加派生值；「CNY 与墙钟的唯一定义处」不变 |
| §8.9 (b) | `budget` 与 `cap` 暂停的继续：填新的上限，或升一档 |
| §8.9 (c) | 第 3 步：计划 schema 加每 harness 预估与提议档；「预算」检查不再因预估让计划退回规划者，预估超过全力时计划卡只开放「自定」。第 4 步：计划卡加档位选择、每 harness 一行、最坏情况一行、提示与置灰规则、已花的规划费用。第 6 步：`wallCapMin` 的默认改为「按档」 |
| §8.9 (d) | `maxTurns` 取档位值；`maxBudgetUsd` 按本文 §4.2 的公式派生（k 默认 10，假设）；省档的 effort 上限在乐章启动时设定并回读；DSH 与 Codex 在全力档的 `wallCapMin` 取 60（只让 P1 更早到） |
| §8.9 (g) | 「预算」行改为按档；上限一览里 `calls(n)`、`cny(x)`、`wall(min)`、`wallCapMin` 的默认改为「按档，见 §10.12」，`calls(n)` 仍受项目策略封顶；新增一行「窗口水位线 → `waitingOn: time(until 重置)`，不是事件；等待超过 N h（默认 6 h，假设）出 P3」 |
| §8.9 (h) | 100% 事件卡的动作：有在途回合时「中断此回合」在首位，其后「只把这一项加到 x」「升一档并继续」（附旋钮变化）「保持暂停」；界面用语加「档位」「自定」 |
| §8.9 (j) | 证据门的「预算超支 = 0」按档统计；回归微愿望在省档跑 |
| §10.2 | 「愿望预算」改为由档位派生；新增每个订阅 harness 的 token 包络策略；新增窗口水位线的准入等待，要读账户窗口用量；复核预留随档；外层包络不变 |
| §10.10 | 回读范围加执行乐章的 `effort`：DSH 已由 `set_config_option` 覆盖；Claude 能否回读（未核实），S3 核实 |
| §10.12 | 愿望 `calls`、`wallCapMin`、「愿望预算」三行改为档位表；新增 `maxTurns`、token 包络、水位线、水位线等待的 P3 阈值 N、省档 effort 上限、`cnyDay` 份额、复核预留七行 |
| §11.1 | 愿望卡显示档名与一根表 |
| §13 | M1：档位选择与四个 M1 旋钮，开始采集输出 token；M2：其余旋钮与校准；Codex 各项随 Codex 驱动（M4，或按 Q1 提前到 M2 末） |
| §14 第 12 行 | 按（档，harness）分层；加每档撞 100% 的比例、升档比例与 `timedOut` 率；新表按本文 §4.6 的固定规则 |
| §15 | 新增本文 §7.1 的风险行 |
| §16 R68 | 改写为「愿望预算档位」：档位表、映射、改档 Decision、BT 用例 |
| §17.6 Q-P6 | 改为「由 Q-B1 与档位表默认值（Q-B6、Q-B7、Q-B8）取代（budget-tiers.md §7.2），待你拍板」；你决定之后才写「采用」（[spec] 附录 G.7 的做法） |
| §17.1 Q3 | 日上限不分档，保持数字；档位的 `cny` 与 `cnyDay` 都以它为单位 |
| 附录 F | 新增 BT-1…BT-16（本文 §6） |

## 6. 零 token 验收用例 BT-1…BT-16

全部跑在假 harness 上（`claude-fake-sdk`、`codex-fake-app-server`、mock ACP agent），属于 D12 的零 token 契约 CI。Codex 的断言都在 BT-16，随 Codex 驱动落地。

| 编号 | 用例 | 里程碑 |
|---|---|---|
| BT-1 | 执行者为 Claude，三档各起一个愿望 → 假 Claude（`claude-fake-sdk`）收到的启动参数里 `maxTurns` 为 50 / 100 / 200；愿望派生的 `wallCapMin` 为 30 / 60 / 120，`calls` 上限为 4 / 6 / 9 × T + M（仍受项目策略封顶）；任何档都不出现 ultracode 或强制的 `max`。DSH 与 Codex 的值见 BT-15、BT-16 | M1 |
| BT-2 | M2 参数到达：假 Claude 收到的 `maxBudgetUsd` 等于 §4.2 公式用测试价表 fixture 与 k = 10 算出的值；省档下，乐手 `effort: high`、模型默认 `medium` 的 Claude 执行乐章以 `medium` 启动，`max` 的 DSH 乐章以 `high` 启动；标准、全力与复核乐章的 effort 不变；期望值与实际值都记下 | M2 |
| BT-3 | 假 DSH 的 `set_config_option` 回读仍是旧值 → 卡上标「未应用」，记录期望值与实际值；不静默丢弃（DSB、GB 的反例） | M2 |
| BT-4 | 预估超过标准档的 `calls` 上限 → 标准档仍可选，带「规划者预估超出此档」提示与哪一项；默认档被标时不预选；不选档无法接受计划；规划者提议的全力不预选；预估超过全力 → 不退回规划者，三档置灰，只有「自定」可用；接受前已花的规划费用显示在卡上 | M1 |
| BT-5 | 执行者在处置里写「升到全力」→ 档位不变；`orchestra-mcp` 没有改档的工具；只有 UI 的人类动词能改档，那一下即留下一条当场结案的 `kind: tier` Decision，`resolvedBy` 是人；计数不清零 | M1 |
| BT-6 | 把项目默认档设为全力 → 拒绝 | M1 |
| BT-7 | 标准档，假 `rate_limit_event` 报 5 h 用量 76% → 下一次派发记 `waitingOn: time(resetsAt)`，`budget-incident` 0 条，`wish-paused` 0 条，在途回合中断 0 次；重置后用量 10% → 恢复派发；另一例 7 d 用量 76%，假时钟让等待到 5 h 59 min → P3 0 条，到 6 h 01 min → 1 条 P3，带重置时间与「本次越过水位线」 | M2 |
| BT-8 | API key 会话（没有 `rateLimitType`）→ 卡上写「额度水位读不到」；派发不按水位线挡；token 包络到 80% 出 1 条 P2；`cny` 不变，卡上的 CNY 只是估算；LedgerEntry 带估算标记 | M2 |
| BT-9 | token 包络到 100% 时有在途回合 → 守护进程中断 0 次，1 条 P1 `budget-incident`，回合结束后才记 `paused(budget)`，未标记请求暂扣；卡上第一个动作是「中断此回合」，点了即发出 r4 的单个乐章中断（假 Claude 收到 `interrupt()`）；其后是「只把这一项加到 x」「升一档并继续」「保持暂停」；点「升一档」之前卡上列出每个旋钮的变化；升档后派生值变为全力的值；全力档的卡上没有「升一档」 | M2 |
| BT-10 | 愿望中途降档、没有在途回合 → 那一下记一条当场结案的 `kind: tier` Decision；新档让用量已超上限 → 先弹第二次确认；确认后立即 1 条 P1 与对应的暂停：`cny` 或 token 超 → `paused(budget)`，`calls` 或 `wall` 超 → `paused(cap:*)` 加 `wish-paused`；不自动取消。有在途回合时 → 1 条 P1，中断 0 次，回合结束后才记暂停 | M2 |
| BT-11 | 假时钟落在谷时的 DSH 派发 → 按峰时价预约，按谷时价结算，`priceBand` 记 `off-peak`；假时钟 2026-11-01 之后 1,000 次成功的 Search → `cny` 加 5；失败的请求不计 | M2 |
| BT-12 | 愿望运行中档位表改版 → 该愿望的 `tierTableRev` 不变，新愿望用新版 | M2 |
| BT-13 | M1 没有账本 → 计划卡上 `cny`、`cnyDay`、token、水位线、复核预留、`maxBudgetUsd`、省档 effort 上限各行显示「M2 起」；只执行 `calls`、`wall`、`wallCapMin`、`maxTurns`；每次派发的输出 token 照样记下 | M1 |
| BT-14 | 每条 LedgerEntry 带 `tier`、`effortApplied`，harness 可由 `partRef` 推出；§14 第 12 行的报表按（档，harness）出格；token 缺失的调用记估算，不记 0 | M2 |
| BT-15 | 全力档、DSH 执行者、M3 bundle 之前 → 启动参数里 `wallCapMin` 为 60，计划卡写明这只让 P1 更早到（M1）；省档计划先预约 ⌈4T/3⌉ + M 次复核，执行预估加复核预留超过省档 → 省档带「可能撞 100%」提示，仍可选（M2） | M1 / M2 |
| BT-16 | Codex 各项：任何档都不出现 Codex `ultra`；省档下 Codex 执行乐章取 `defaultReasoningEffort`，标准与全力不变；全力档 Codex 执行者的 `wallCapMin` 为 60；token 包络读 `thread/tokenUsage/updated` 的 `outputTokens`；假 `usedPercent` 80 越过标准档水位线 → 等待；回到 10 且 `ordinaryUsageAllowed` 为真 → 恢复；`usedPercent` 10 但 `ordinaryUsageAllowed` 为假 → 仍等待；`usageLimited` 之后只认 `ordinaryUsageAllowed` | 随 Codex 驱动（M4，或按 Q1 提前到 M2 末） |

## 7. 风险与开放问题

### 7.1 风险与对策

| 风险 | 对策 |
|---|---|
| 档太粗，愿望落在两档之间 | 「自定」逐项加；M2 按撞 100% 的比例与升档比例调表 |
| 共享窗口：你自己的会话吃掉额度，愿望长时间等待 | 卡上显示水位线与重置时间；等待不算卡死（PC#10344）；等待超过 N h（默认 6 h）出 P3，给「本次越过水位线」；形式由 Q-B4 定 |
| effort 被静默压低 | 只在省档、只往下压、只压执行乐章；计划卡写明被压低的乐手；启动后回读，不一致标「未应用」 |
| 输出 token 包络与真实额度的换算未知 | 标估算；M2 用窗口百分比的变化校准，只取愿望乐章是唯一活跃会话的区间 |
| 到顶后在途回合越线（DSH、Codex 没有自动兜底） | 计划卡写明最坏情况是「直到你中断」；请你中断的 P1 即时通知，卡上第一个动作是「中断此回合」（Q-P10 = B）；DSH、Codex 全力档 `wallCapMin` 取 60 只让这条 P1 更早到，限不住回合 |
| 省档的 30 min `wallCapMin` 多出 `timedOut` P1，与少打扰的目标相悖 | M2 统计每档的 `timedOut` 率，过高就放宽 |
| 规划者的提议被当成背书 | 不预选，显示为「规划者建议」 |
| 档位数值全是假设 | 全部标（假设）；M2 校准；改表是你的 Decision |

### 7.2 开放问题与默认值 Q-B1…Q-B8

要你拍板的（档名与项目默认档已并入 Q-B1；第二次修订把编号改为连续，新旧编号对照见 Review log）：

| # | 问题 | 选项 | 建议 | 最晚何时决定 |
|---|---|---|---|---|
| Q-B1 | 三档还是五档；档名；项目默认档 | 方案甲 3 档 / 方案乙 5 档；省 / 标准 / 全力（`lean` / `standard` / `full`）或其他；项目默认标准或省 | 甲；省 / 标准 / 全力，不用 effort 词；项目默认标准，额度小的账户设省；「自定」作逃生口；不设隐藏档 | M1 开始前（M1 的计划卡要用档名与四个 M1 旋钮） |
| Q-B2 | 省档是否压 effort | 压到各模型的默认档 / 不压 | 压，只压执行乐章，M2 起。反方：[B3] §5 第 4 条主张 effort 不进档位（缓存与按模型的校准）；压低 effort 也可能多出重做，而省档的 `calls` 只够约三分之一的 Task 重做一次（推断） | M2 开始前 |
| Q-B3 | Arrangement 是否复用档名 | 复用 / 保持数字 | M6 再定 | M6 go/no-go 时 |
| Q-B4 | 水位线的形式 | 每档一个账户绝对水位线（本文）/ 项目级一个水位线，不随档 / 每愿望的窗口份额（三份报告的提议） | 先用每档绝对水位线；M2 看等待时长与你自己的会话被挤的情况再议 | M2 开始前 |
| Q-B5 | 预估超出某档时，计划卡是提示还是置灰 | 提示，仍可选（本文）/ 置灰 | 提示；只有预估超过全力时只开放「自定」；M2 量出预估误差后再议 | M1 开始前 |

默认值（全部为假设，不必现在定）：按 §4.6 的规则在 M2 末重定，改表是你确认的 Decision，你也可以随时改。它们与 Q-B1 一起取代 r4 的 Q-P6。

| # | 默认值 | 生效 |
|---|---|---|
| Q-B6 | 水位线 50 / 75 / 90%，固定值；Claude Code 式的节奏表（5 h：已用 90% 而时间过了不到 72%）留作 M2 的备选；水位线等待超过 N = 6 h 出一条 P3，不随档 | M2 |
| Q-B7 | `calls` 系数 4 / 6 / 9，`wallCapMin` 30 / 60 / 120，`maxTurns` 50 / 100 / 200；`cny` 0.25 / 1 / 3 × Q3，`cnyDay` 为 Q3 的 25 / 50 / 100%，token 每 harness 0.5M / 1.5M / 5M，复核预留随 `calls` 系数，`maxBudgetUsd` 的 k = 10；备选：`cny` 与 token 按 T 缩放（本文 §4.1） | 前三项 M1，其余 M2 |
| Q-B8 | DSH 与 Codex 在全力档的 `wallCapMin` 取 60 min（只让请你中断的 P1 更早到，限不住回合），直到 M3 bundle 给 DSH 加上回合上限、Codex 的预算在关闭续跑时被证实可用 | M1（Codex 随其驱动） |

### 7.3 核实缺口

- `maxEffortLevel` 能否作用于 `settingSources: []` 的 SDK 会话；整数 `effort` 的含义（[B1] §8）。本文的省档改用乐章启动时的 effort 设定加回读，不依赖它。
- Claude 乐章实际生效的 effort 能否回读（S3 核实）。本文 §5 把 `effort` 加进 `desired/applied`。
- `autoContinueAtUsageLimit` 在 SDK 会话里是否生效（[B1] §8）。
- `rate_limit_event` 是否每次都带 `utilization`；自有乐手是否与你共用订阅窗口（[B3] §6）。若 Q8 选 A（复用登录），推断为共用。
- Codex `goal` 的 `tokenBudget` 在关闭续跑时是否可用（[B1] §8）。Codex 的 `TokenUsageBreakdown` 分列 `outputTokens` 与 `reasoningOutputTokens`（CX-BIND，0.160.1）；前者是否已含后者（未核实）。
- API `task_budget` 的计量口径：SDK 只写「Total token budget across all contexts in the session」（API-TS beta `messages.ts:7470-7476`，修订时读），没说是否只计输出（未核实）。
- 派生 `maxBudgetUsd` 所需的各模型列表价不在三份报告里（未核实）；系数 k 的默认值 10 没有出处（假设），M2 用账本校准。
- `rateLimitType` 与 `unifiedWindows` 标为 `@internal`；Codex 的窗口长度由服务端决定（[B1] §8）。
- effort 的代价曲线来自厂商的基准（Terminal-Bench）与作者的玩具示例（构建任务），都不是 Orchestra 的工作量（[B1] §8）；platform.claude.com 与 OpenAI 的推理指南未能抓取（[B1] §8；[B3] §6）。

## 8. 来源

**三份原始报告**（2026-10-28，各自的证据表是一手出处的完整清单）
- [B1] [budget-harness.md](budget-harness.md)：code.claude.com/docs/en/{model-config, settings-reference, costs, statusline, interactive-mode, cli-reference, workflows, claude-apps-gateway-spend-limits, agent-sdk/typescript, agent-sdk/agent-loop, agent-sdk/cost-tracking}；本机 `claude.exe` 2.1.310（`grep -a`）；claude.dev/blog/spending-your-effort（2026-09-25）；anthropics/anthropic-sdk-typescript@cb5fba4；Claude Code 2.1.308 附带的 `claude-api` skill；openai/codex@ce2d47b 与 `rust-v0.160.1`；dsh-TUI 里的 Codex 0.160.1 绑定；DSH 0.2.1-rc.2 本机包；api-docs.deepseek.com 价表。platform.claude.com 与 developers.openai.com 未触达。
- [B2] [budget-frameworks.md](budget-frameworks.md)：code.claude.com/docs/en/workflows；cursor.com 文档、2025-07-04 博客与两个论坛帖；docs.devin.ai 与 knowledge.cognition.ai；help.manus.im 与 manus.im 博客；xai-org/grok-build@2bdd1d6；RooCodeInc/Roo-Code@b867ec9；cline/cline@f817e59 与 PR #7180；docs.openhands.dev 与 OpenHands issue；paperclipai/paperclip@25f1070（只读 `doc/`）；本机 hermes-agent@954f398、DS-Bot@aff6777；kubernetes/website@e55841d；docs.aws.amazon.com 的 EC2 文档。
- [B3] [budget-evidence.md](budget-evidence.md)：Hick 1952；Hyman 1953；Miller 1956；Cowan 2001；Iyengar & Lepper 2000；Iyengar, Huberman & Jiang 2004；Scheibehenne, Greifeneder & Todd 2010；Chernev, Böckenholt & Goodman 2015；Simonson 1989；Simonson & Tversky 1992；Huber, Payne & Puto 1982；Neumann, Böckenholt & Sinha 2016；Johnson & Goldstein 2003；Madrian & Shea 2001；Jachimowicz et al. 2019；Mertens et al. 2022；Maier et al. 2022；Mackay 1991；claude.com/blog/claude-model-and-effort-level-in-claude-code（2026-07-07）；openai/openai-python@77fd116；openai/codex@ce2d47b；googleapis/python-genai@6e80d42。

**规格**：[spec] = `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`，只读；本文引用 §0.7、§3.1（原则 5、14）、§4（D8、D12）、§6.1、§8.6、§8.9、§10.2、§10.10、§10.12、§11.1、§13、§14、§15、§16、§17、附录 E（A14）、附录 F 与附录 G.7（Q-P10 = B 的决策记录）。

综合者没有重新抓取一手来源；数字均取自三份原始报告与 [spec]。修订时复核了少数一手来源，在正文里标「修订时」，清单见 Review log。

---

## Review log

**一轮红队，2026-10-28。** 三个视角共 76 条：facts 23 条（严重 5、重要 5、次要 13）、coherence 27 条（严重 4、重要 11、次要 12）、design 26 条（严重 4、重要 12、次要 10）。修订者逐条对照原始报告、r4 与一手来源复核。76 条都成立，全部采用；其中 7 条只采用了一部分，或在建议的几种改法里选了一种，见下文。没有驳回的条目。不少条目重复，按问题合并处理：F1 / M11 / D-15、F3 / C1 / D-04、F4 / C3、F5 / M1、F9 / m12、F15 / m1、D-08 / m9、D-12 / m4、M2 / D-19、M5 / D-26、M8 / D-24。

**修订时复核的一手来源**（只读）：本机 `claude.exe` 2.1.310（`grep -a`：`U$s` 的额度提示、5 h / 7 d 节奏阈值、`budget.spent()` 的说明）；openai/codex@ce2d47b `codex-rs/ext/goal/src/accounting.rs:570-575`；anthropics/anthropic-sdk-typescript@cb5fba4 `src/resources/beta/messages/messages.ts:7470-7476`；code.claude.com 的 `workflows.md:355,439`、`model-config.md:442-446,606,625` 与 `settings-reference.md:501`；claude.dev/blog/spending-your-effort；api-docs.deepseek.com 价表；xai-org/grok-build@2bdd1d6 `effort_levels.rs:7-14`；dsh-TUI 的 Codex 0.160.1 绑定 `TokenUsageBreakdown.ts`、`ThreadTokenUsage.ts`；DSH 本机包 `dsh-goal/README.md:46`；r4 §0.7、§6.1、§8.9 (a)–(i)、§10.2、§10.10、§10.12、§13.6、§16 R80、§17.6、附录 G.7。

**已采用，按主题分组**
- **事实与出处（F1–F23）。**
  - token 口径：包络按输出 token 计，写明是本文的选择。只与 `+500k` 同口径。Codex goal 计未命中缓存的输入加输出。`task_budget` 的口径标（未核实）。
  - 额度提示：Claude Code 的提示只在 Pro 的 7 d 窗口出现，Fable / Opus 上先换模型；「先降 effort」只出自 API-SKILL。
  - 补回丢掉的限定词：`max` 可经环境变量持久；`maxEffortLevel` 取最低的上限；debug 日志只在交互等模式；7 d 有三组节奏阈值；并发 16 是默认值；Search / Fetch 按成功请求计；Grok 的 4 档是后备菜单；Codex 弹窗是测试快照；r4 的 2 轮修复是假设。
  - 改正：Cursor 套餐列出 Free；DSH 补 goal 轮数上限 256；1.5M 是预计总 token；构建任务的耗时补 `medium` 4 min，并标为玩具示例；×1.25 与 ×1.2；Codex 分列输出与推理 token。
  - 推荐理由 1 改为「多为」，并列出 Devin、Roo 与 OpenHands 的反例。§8 的规格章节清单补全。
- **推荐理由（F3、F4、C1–C3、D-04、D-20、m1）。**
  - 理由 2 改为旋钮拥挤的计算：系数被 `verifySubmissions` 限在约 9–11，水位线封顶 100%。effort 并档一条只用来否定方案乙「对齐」的卖点，并标推断。
  - 理由 3 补回推断与外推的说明。理由 4 改为 M2 时 6 对 10 格。
  - 方案乙的 `max` 只引 [B3]，并说明 [B1] §7 第 3 条的建议正相反、本文为什么不采用。
- **立场与 r4 修订清单（C4、M5、M6、M7、m2、m3、m8、D-26）。**
  - 立场 5 改为「不新增暂停、中断或条目种类」，并列出新增的四样。
  - §5 补 §0.7、§8.6、§8.9 (a)(b)、§8.9 (c) 第 6 步与 §10.10 各行；`desired/applied` 加 `effort`；§10.12 改为新增六行。
  - §17.6 不再写「采用」，改为「待你拍板」。
- **事件、中断与最坏情况（D-01、D-07、D-08、D-25、M9、m9、m10）。**
  - 100% 卡在有在途回合时把「中断此回合」放在首位；「只把这一项加到 x」是主按钮；「升一档」前列出每个旋钮的变化。
  - 写明 `wallCapMin` 只让 P1 更早到，最坏情况是「直到你中断」，并补上 Codex。
  - 省档多出的 `timedOut` P1 记为省档的代价。
  - BT-9、BT-10 按 Q-P10 = B 改写；越线的是 `calls` 或 `wall` 时记 `paused(cap:*)`。
- **计划卡与改档（D-02、D-06、D-17、D-23、D-21、D-24、F22）。**
  - 预估超过某档时只提示，不置灰。预估超过全力时不退回规划者，只开放「自定」。
  - 改档一次点击即结案。卡上显示接受前已花的规划费用、全力档会占满项目当日额度，以及被压低的 effort。
- **单位与包络（D-11、D-12、D-13、M4、M2、D-19）。**
  - `maxBudgetUsd` 给出带系数 k 的公式，只作失控兜底。
  - token 包络按 harness 分开（`outTokens{claude, codex}`）。API key 的花费不再加进 `cny`。
  - Codex 各项移到 BT-16，随 Codex 驱动落地。
  - `wallMin` 改为（`calls` ÷ 3）× `wallCapMin`，标假设，不依赖 M2 才有的 `callsPerHour`。
- **水位线（D-03、D-05）。** 解除等待要求用量回到水位线以下，Codex 另要 `ordinaryUsageAllowed`。写明为何不用每愿望份额。等待超过 N h 出一条 P3，并给人类动词「本次越过水位线」。
- **复核预留与校准（D-10、D-14、m5、m6、m7、m11、D-18）。**
  - 复核预留随系数缩放，并按预计的复核者 harness 预约，换了就重新预约。
  - 校准给出固定规则：每格 n ≥10，取 P80 × 1.25，目标比例都标假设。M1 起采集输出 token；窗口变化只在单独活跃的区间归因。
  - 其余补充：`calls` 仍受项目策略封顶；M2 清单补复核预留；harness 由 `partRef` 推出；写明 Maestro 的两层包络；默认档比 r4 宽 50% 并给出理由。
- **开放问题（D-16、M3、M10、D-09、D-22）。**
  - 旧 B2（档名）、旧 B6（项目默认档）并入 Q-B1。新增 Q-B4（水位线形式）与 Q-B5（提示还是置灰）。Q-B6、Q-B7、Q-B8 改为默认值，不再要你现在定。（本段起用第二次修订后的新编号。）
  - Q-B8 自 M1 生效，并覆盖 Codex。Q-B7 补 `cnyDay` 份额。
  - 方案乙补上每个旋钮的数值表。一句话说明改为按 `calls` 说。`cny` 改以 Q3 为单位。

**只采用一部分或择一的条目**
- D-05：没有把水位线移出档位、改成项目级设定，这一点留给新的 Q-B4；其余采用。
- D-06：采用「提示，不置灰」；但预估超过全力时仍只开放「自定」，这样与 D-02 一致。D-06 说置灰违背 §1 第 6 条，这个论据偏弱：r4 本来就用规划者的预估挡计划。改动的依据是预估未校准与 Q-P10 = B。
- D-09：没有让 CNY 与 token 按 T 缩放，改写了一句话说明；缩放列为 Q-B7 的备选。
- D-11：取了「公式加系数 k」，并把 `maxBudgetUsd` 定位为失控兜底，两种改法合在一起。
- D-16：三项默认值（今 Q-B6、Q-B7、Q-B8）当时保留原编号，放进默认值表，免得旧引用断开；第二次修订改为连续编号，见下文。
- D-21：取了「计划卡写明」，没有把全力档的 `cnyDay` 压到 75%。
- D-22：两项都以 Q3 为单位，没有都改为绝对值。

**仍有的疑问**
- `wallMin` 的新公式让全力档在 T = 1 时约 400 min，墙钟几乎不会先于 `calls` 触发，M1 主要靠 `calls` 控制。
- `cny` 以 Q3 为单位后，Q3 一改，回归微愿望 5 CNY 的锚点就和省档脱节。
- 方案乙的插值数值只作对比，不是校准过的值。系数上限 9–11 本身由 r4 的假设上限算出。
- Codex 的 `outputTokens` 是否已含推理 token、Claude 乐章的 effort 能否回读、`maxBudgetUsd` 的列表价标（未核实），系数 k 的默认值 10 标（假设）。
- 二进制里 `try /effort medium` 的前置条件 `Rw(n)` 含义不明，「其他模型」是近似说法。
- 提示（软）与「超过全力只开放自定」（硬）混在一起，留给 Q-B5 与 M2 的误差数据。

**第二次修订（格式），2026-10-28。** 格式检查共 17 条（FC-01…FC-17），逐条对照本文、三份原始报告与 r4 复核。采用 16 条，其中 FC-06 只采用一部分；FC-17 不在本轮处理。
- FC-01：§4.1 方案乙与推荐理由 2 改为「档名不映射成 effort 档位，也从不抬高 effort；只有省档压低执行乐章的 effort 上限」，与 §1 第 2 条、§4.2 一致。
- FC-02：方案乙的水位线改为「四对相邻档里只有轻→标准差 25 个点，其余三对差 5–10 个点」；推荐理由 2 随之改为「多数」，结论不变。
- FC-03、FC-04：N 默认 6 h，k 默认 10，都标（假设）。§4.2 加 N 一行；Q-B6、Q-B7 列出两者；§5 的 §8.9 (d)(g) 与 §10.12 行同步。BT-7 断言 5 h 59 min 不出 P3、6 h 01 min 出 1 条；BT-2 断言 `maxBudgetUsd` 等于用测试价表 fixture 与 k = 10 算出的值。
- FC-05：删去「校准按 `effortApplied` 分层」，改为只记下、不分层，按模型的校准只接住一部分（推断）。
- FC-06（部分）：r4 §8.9 (g) 的「上限判定」行本来就写了从 `paused(cap:<项>)` 继续要先填新上限（r4:1296），原引用不算错；补上 (b) 的状态机（r4:1207），改为 (b)(g)。
- FC-07、FC-08：「换了 harness 就重新预约」与「M1 细到每次派发的输出 token」标（本文建议），r4 只引它确实写了的部分。
- FC-09：估算标记改引 [B1] §7 第 6、7 条。FC-10：`callsPerHour` 改为「固定为 6」，不再说派生。
- FC-11、FC-12：标注统一为（推断）（假设）（未核实）（本文建议）；（计算）并入（推断）或改写进正文；裸写的「未核实」改为标注。
- FC-13：`maxTurns`、水位线与 token 包络中没有出处的值写明无外部锚点（假设）。FC-14：BT-1 限定为假 Claude，DSH 与 Codex 的值交给 BT-15、BT-16。
- FC-15：Q-B 改为连续的 Q-B1…Q-B8，§4、§5、§7 与本 log 的引用一并改。新旧对照：Q-B1 不变；旧 B3→B2、B8→B3、B9→B4、B10→B5、B4→B6、B5→B7、B7→B8；旧 B2、B6 已并入 Q-B1，不再使用。
- FC-16：§3.3 补一句：三份报告里没有「档太粗」的案例，按设计风险处理。
- FC-17（篇幅超出任务书）：按编排者的指示不删减，由编排者定。

**篇幅。** 第二次修订后，Review log 之前的正文约 9,760 个汉字加约 2,490 个拉丁词元（全文约 11,100 加 2,850）。红队修订并入后已超出任务书 3,500 词的上限，无论按哪种计法都超出约 3 倍。
