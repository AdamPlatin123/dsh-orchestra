# M0 实施计划（orchestrad，"The Program"）

- 日期：2026-10-30 初稿；2026-10-31 按 `docs/research/2026-10-31-eye-diagram-zen.md` 修订（开眼第一轮的第一、二档并入，第三档是可选的步骤 19；第二轮的分档见 §0 和 D-19、D-20）。状态：草案，已按复核意见（23 条）、开眼修订的复核（14 条）和 UI 交互设计的三轮复核修订（含第三轮的复核，见附录末尾）。步骤 0–2、第 2b 步、第 2c 步和步骤 3 已提交（44dda01、04afe1d、250cc60、a83826d、6a5471c、e451d4c）；步骤 3 之后照代码改了几处契约写法，并记下步骤 4 的两个决定（见附录末尾）；之后又按两份复核（28 条，有重叠）照代码补了一轮，也记在附录末尾。
- 依据：r4 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`，以 §13.2（r4:2354–2395）为准。顺着交叉引用读了 §5.2–5.4、§6、§7.1–7.3、§8.1、§10.3/10.5/10.9/10.11/10.12、§11.2/11.9、§14、§15、G.7。spike 报告见 `spikes/<id>/REPORT.md` 和 `docs/spikes/2026-10-29-m0-spikes.md`。procguard 的行为以 `spikes/s4-procguard/ProcGuard.cs` 为准。
- 标记约定：
  - 「r4:行号」指 r4 文件的行号。
  - 「暂定」表示 r4 没写，是本计划的取舍，可以改。
  - 「核验」表示 2026-10-30 用 `.tools/node24/node.exe` 实测过。
  - 「代定」表示编排器代定（建议值，可改），要记进 r4 G.7（见 §2.3）。

---

## 0. 先看这几条

- **工期**：共 20 步（步骤 0–17，加上 18A/18B），0–2 已完成；第 2b 步（0.5 天）已提交（a83826d）；另有要你定的第 2c 步（安全档其余五条里的三条，加一条仓库测试，约 0.85 天，D-19），按推荐默认做完、已提交（6a5471c）；步骤 3 也已提交（e451d4c）；安全档另两条不在 2c 里：环境时钟并进步骤 3 的 Clock 扫描规则（算在步骤 3 的 2.4 天里，推断 ≤0.05 天；已随步骤 3 提交）；脚本也走 boot 没估、没排（推断 ≤0.05 天，见 D-19）。每步 0.5–2.9 天，每步结束时测试全绿；另有可选的步骤 19（开眼第一轮的第三档，不算进下面的数）。按复核意见修订后，估时比上一版多约 2.75 天；并入开眼第一轮的第一、二档后再多 2.5 天（第一档 +2.0，第二档 +0.5，算式见 §4.1）；UI 交互设计（`docs/plans/2026-10-31-ui-interaction-design.md`）两轮再多约 1.45 天（第一轮 +1.0，第二轮净 +0.45）；步骤 3 之后又给步骤 4 定了两件事，再多约 0.15 天（推断，见步骤 4）。
  - 几个词：第 2b 步 = 补开眼笔记 §7.2 实测出的几个洞（调试口、关锁、undici 后门、SpawnGate 白名单（已在第 2 步的提交里补上，2b 没再改它）、修复见证、缺钩子放行、测试误跑真实 profile）。第 2c 步 = 已提交的四件（6a5471c）：安全档其余五条里的三条（fs 能力在 boot 里造好、process 能力清单、删陪跑规则），加一条钉住进程内 start() 的 home 的仓库测试（开眼 §7.7；词义见 §2.1 的「几个词」）。门脚本 = 给我们自己开发用的检查脚本：修复见证、安静信道计时、跳过台账。
  - 两套分档别混：开眼笔记 §6（第一轮）的第一、二、三档，前两档已并进本计划，第三档是步骤 19。§7.5（第二轮）的三档本计划改叫安全档、人这一端档、门脚本档：人这一端档由 UI 交互设计取代，不另加；安全档 = 第 2b 步加「第 3 步开工前」那五条，2b 已计入；五条里的三条（加一条仓库测试）是第 2c 步，按 D-19 的推荐默认计入；另两条里，环境时钟排进步骤 3 的 Clock 扫描规则（算在 2.4 天里），脚本也走 boot 还没排、没估（推断 ≤0.05 天）；门脚本档见 D-20，不算进下面的数。
  - 一个实现会话串行做：约 29.7 个工作日（27.75 + 2b 0.5 + 2c 0.85 + UI 第二轮 0.45 + 步骤 4 的两个决定 0.15 = 29.7），四项全削后约 26.2 天。
  - r4 给 M0 的预算是 15–18 个工作日（r4:2344），减去已用的 3 天 spike，还剩 12–15 天。
  - 两个实现会话并行：线 A→B 一个会话，线 C 另一个会话（2c 做完、第 5.6 天起；D-19 只做 2b 时第 4.75 天起；在独立 worktree 里做）。关键路径约 18.45 天（不做 2c、只做 2b 时约 17.6 天；17.6 是当时的估算，2c 已提交，现在选「只做 2b」省不回这 0.85 天）：线 B 在第 17.7 天做完，线 C 早 0–0.45 天（D-10；步骤 6 的落库部分从这里扣，见 §4.1），比剩下的 15 天上沿多约 3.45 天。**18.45 天假定线 C 在第 5.6 天开工**：步骤 3 已提交，线 C 还没开工（仓库里没有 lane-c worktree，也没有 `m0-lane-c` 分支）；从现在（按本计划的钟是第 8.0 天）开工，约 20.0 天（推断，算式见 §4.1 时间线），8.0 前那段空档和 D-20 修复见证的位置都没了；这时先削线 C 的②才缩短总工期。这两个关键路径数都按 D-17 的默认抵掉了 0.25 天；抵扣是推断（步骤 4 原来的 1.5 天里没写 ui-only 怎么起 HTTP，可能本来就没算），抵不掉时各加 0.25，约 18.7、17.85 天。
  - 只有一个实现会话的话，M0 现在就要按约 29.7 天（含 spike 约 32.7 天）排。这件事由你定，而且现在就要定（D-9）。
- **顺序**：不可削减的部分排在数据源之前，包括写围栏与读白名单、UI 鉴权、收件箱、刹车、fixture（r4:2395）。可削减的四项排在各自线的末尾，削一项就是不开工那一步。
- **依赖**：运行时零 npm 依赖。daemon 是 `.ts`，靠 Node 类型剥离直接跑。浏览器端用纯 JS 模块，不需要构建步骤。
- **agent 只能起测试 profile**：实现会话（agent）只能用 `orchestra.cmd --test-profile` 启动 orchestrad。测试 profile 用临时数据目录，只读合成根，只能刹测试工具自己起的假进程树。真实 profile 只由你启动、由你配对；配对码只在交互式控制台里打印。这样 agent 拿不到真实进程上的人类动词（D8 r4:492、§10.11 #4 r4:1701）。
- **要你在场或动手的事**有 10 件（§5 末尾）。最重的两件是：30 分钟 Procmon 实跑（要管理员权限），以及终端 TUI 等待实测（最多 1 次模型调用，实测时 orchestrad 要开着）。
- **新核验**（2026-10-30）：
  - 在模块函数体里调 `module.registerHooks`，拦不住本模块图的静态 import（实测：静态 import 拿到了 `child_process`，动态 import 被拦）。
  - `process.getBuiltinModule` 是可写属性，能绕过钩子。`vm.runInThisContext` 也能拿到它。
  - 所以导入围栏改成：入口 `src/boot.ts` 先装围栏，再动态 import 主模块；同时运行时替换 `getBuiltinModule`（§6 第 2 条）。

## 0.5 开眼准则

出自 `docs/research/2026-10-31-eye-diagram-zen.md` 第 2 节。它们只规定怎么测、怎么报，不改 r4 的任何已定规则。

| 准则 | 一句话 | M0 怎么测 |
|---|---|---|
| P1 一符一义 | 要你做不同动作的结局就是不同的符号；看不清就判「不明」，不硬判、不重发 | `turn.close` 只分「原生结束标记」和 `unknown`（步骤 8）；没见过的 `waitingFor` 标低置信（§2.2 第 5 条）；观察会话收件箱行的结束类渲染用例（原 I20）已并进步骤 5 的 `static-render.test`：每个 kind × state × conf × 结束类的 `data-*` 和文字两两不同 |
| P2 每个非终态都有钟、有主或有闸 | 任何等待恰好有一个放行人：一条打开着的条目、一个活句柄、一只钟或一个名额；到点只写一条边，不碰 agent | M1（驻留表 I07）。M0 只保证提醒、snooze、20 s、60 s 四只钟都经 Clock 端口并写进 journal（步骤 3、10、11、13） |
| P3 时间分两份报 | 每个时延数字写成「确定性上界 + 随机尾部@目标率（假设）」 | §5 的 AC2–AC5 每条两行：假时钟相位扫描证明上界，24 h 观测按来源报尾部的 Wilson 95% 上界（步骤 18A） |
| P4 时间是输入，次序只认流 | 次序只认 srcSeq 和 jseq；引起转换的定时器触发写进 journal，每次转换带 cause | 0.1×/1×/10× 回放逐字节相同、删一条 clock 记录必然分歧、打乱 srcTime 转换不变（步骤 8）；同 tick 全序（步骤 3）；注入睡眠在步骤 19（I08），没做就 M1 |
| P5 标记后于效果 | 已读、游标、已触发只能晚于效果，或与效果同批提交；通知按至少一次投递 | 三个崩溃点的重建测试（步骤 3）、游标提交（步骤 9）、提醒崩溃（步骤 13）、通知补发（步骤 5）：丢失 0、重复 0 |
| P6 细迹线、无串扰 | 核心只吃一张小符号表，只认邮局这一条总线 | 符号表，加核心目录里 harness 名的 lint 告警，不卡出口（步骤 8）；邮局和封闭乐章在 M1 |
| P7 眼图本身是测量 | 每条已定规则写成只读 journal 的纯函数，先用坏样本证明能命中；N = 0 显示「未测」，不写「通过」 | M0 的各份报告都照「N = 0 显示未测」（步骤 18A）；收件箱为空时写出分母（正在观察几个会话、各源状态、截至何时），从不单写「全部清空」，有源出错或停摆时另有源健康条，页面不新鲜时不说「没事」（步骤 5 的 `static-render.test`）；规则模板在 M1（I15） |

---

## 1. 目标与范围

**一句话目标**：M0 做一个只看不动的注意力收件箱。
- orchestrad 读 Claude、DSH、Codex 留在本机的文件（Codex 只读 `state_5` 快照）。
- 把「在等你」「出错了」「到点了」的事，在 2 s 内推到 `http://orchestra.localhost:<port>` 的 Program 页，并提交通知。DSH 有文档化的延迟例外。
- 你可以设一次性提醒。核对身份并经你确认后，可以人工刹车、杀掉进程树。
- 除了你亲手点的 kill-tree，它对所有 harness 目录零写入（r4:2344、§13.2）。

**M0 要交付的**（r4:2370–2379）：
- 守护进程地基：单写者锁、`node:sqlite` 存储、只链摘要的 journal、可清除片段表、写围栏、读白名单。
- UI 鉴权：配对码、host-only cookie、CSRF、Origin 校验、CSP、渲染规则（§5.3、§10.11）。
- 三个只读数据源：
  - Claude：多根目录、注册表、transcript（§7.1）。
  - DSH：v4 按帧 tail，两种目录名都认。
  - Codex：只做 `state_5` 快照轮询。
- 归一化器和状态机：统一归一化为 dsh-TUI 的 `AgentEvent` 词汇。词汇从 `src/agent` vendor，钉在 71f5ac93（r4:552）。观察到的边记成 `Event(kind: edge)`（D1 r4:485、§8.1 r4:917）。
- Program 收件箱：`j/k/o/p/s/r` 键加 `K` 刹车键（见 §2.2）；一次性提醒；浏览器通知，PowerShell toast 作后备。
- runaway v0（Claude、DSH）、RSS 采样与告警、procguard 进程树刹车（§10.5）。
- policy v0：Claude transcript 里出现 bypass `permissionMode` 时只告警。
- 脱敏 fixture 与回放。静态版 Tuning。
- LICENSE/NOTICE 已在 cc51093 提交。代码落地后要改 NOTICE 的说明句，并在 vendor 时加上 dsh-TUI 的 MIT 条目。

**明确不做**：

| 不做 | 放到哪里 | 依据 |
|---|---|---|
| 自有驱动：拉起会话，以及 send / steer / interrupt / 回收 | M1（Codex 在 M4） | §5.2 `drivers/`、§13.3 |
| procguard 的 Job 类命令：`run-in-job`、`kill-job`、`job-*`、`in-job*`、`pipe-*`、`file-busy`、一次性模式。M0 的 helper 用 `#if M1` 关掉这些命令；S4 的 b/c/f/i 用例一并移到 M1 | M1 | M0 没有自有宿主（§5.2 `drivers/`）；M0 不能有通用启动器（r4:816、r4:2389） |
| A2A、Post Office、Exchange 表、审批队列，以及 `a`/`x`/`d`/`m` 键 | M1 | D1 r4:485、§11.9 |
| DS-Bot 源（包括桌面版数据目录）、dsh-tui、herdr | M2 | §5.2 `sources/` |
| Codex rollout 实时 tail、Codex runaway | M2 | R07、§7.1 r4:816 |
| 专注模式 `f`、30 分钟摘要、周期提醒 rrule、foreign-held 徽标、观察者协议 | M2/M3 | §11.2、§5.4 |
| hooks 接收端与 opt-in 片段 | Q6 在 M0 验收后再定 | §17 Q6 |
| markdown 渲染、DOMPurify | M1 乐手页 | §5.3 规则 2 |
| 启动任何 harness CLI（包括 `--version`），以及 `claude agents --json` | M0 永不 | §7.1 r4:816 |
| 每晚自动 canary（要建计划任务，属于持久配置） | 你同意后再加（D-8），M0 先做手动 canary | §14 #2 r4:2718 |
| 愿望层、预算档 | M1 起 | §13.3 |
| S2（私有 DSH） | M1 第 1 周；M0 提前完成时放到 M0 末尾跑 | r4:2356 |
| 给 DS-Bot 提 PR | 你做，不算在 Orchestra 工期里 | r4:2380 |

---

## 2. 技术选择

| 项 | 选择 | 理由 | r4 |
|---|---|---|---|
| 运行时 | Node 24.22.0 的 Medium 完整性副本 `.tools/node24/node.exe`。代码里不写死路径：启动器读 `ORCHESTRA_NODE`，没设就用仓库下的 `.tools`。不用系统 Node 22.14，也不用 `G:\_Projects\DSH-plugins` 下那份 Low 副本 | 只有这份同时具备 zstd、`registerHooks`、`node:sqlite`，又能写盘、能看全进程（核验） | §5.3 r4:586–589、D3 r4:487 |
| 入口 | `src/boot.ts` 依次做这几件事：检测运行时特性 → 造好 ports（装围栏前先拿走 fetch，第 2b 步；fs、child_process 的闸门工厂，第 2c 步；SQLite 打开器工厂、唯一的真钟 hub、`endProcess`，步骤 3）→ 装导入围栏（没有 resolve 钩子就以 21 退出，不 import 主模块）→ `await import('./main.ts')`，再调 `start(features, fence, ports)`。进程只经 boot 的 `makeEndProcess` 结束：每一种类型化退出、崩溃和停止，都先有界地冲完控制台（至多 2 s），再交给 boot 在围栏前拿走的原始 `reallyExit`；`process.exit` 锁死（步骤 3，e451d4c）。worker 只能经 `runtime/workers.ts` 起：先跑 `workers/bootstrap.ts` 装围栏，再动态 import 真正的 worker 模块 | 钩子只管注册之后才解析的模块，所以要在主模块图解析之前装好（核验） | r4:605 |
| 依赖 | 运行时零 npm 依赖 | 装任何依赖都要你同意；仓库将来要公开 | 任务约束 |
| 语言 | daemon 用 `.ts`，Node 剥类型后直接跑，只用可擦除语法：<br>· 不用 `enum`，改用 `as const` 对象加联合类型<br>· 不用 namespace、参数属性、装饰器、`import x = require()`<br>· 类型导入一律写 `import type`<br>· 相对导入带 `.ts` 后缀<br>· vendor 的代码放 `vendor/`，只经 `import type` 引用 | Node 24 只剥类型、不转译；`node_modules` 里的 `.ts` 不剥（核验） | §5.3 |
| 测试 | `node:test`，命令 `node --test "test/**/*.test.ts"`。计时用注入时钟或 `mock.timers`。Windows 集成测试（procguard、真杀进程）在条件不满足时自己 skip | 零依赖，`.ts` 测试能直接跑（核验） | §14 #1/#2/#8 |
| 存储 | `DatabaseSync` 加以下设置：<br>· `journal_mode=WAL`<br>· 显式设 `synchronous=NORMAL`（编译默认是 FULL，核验）<br>· `temp_store=MEMORY`<br>· `enableDefensive(true)`<br>· authorizer 禁 `ATTACH`<br>只有主线程写；worker 各开只读连接<br>**journal 是权威，db 是可重建的投影**（补1）：<br>· 提交顺序：每批记录先追加进 `journal.jsonl` 并 fsync → 再在一个 db 事务里应用这批记录，同时写下 `applied_jseq` → 最后才做外部效果（SSE、浏览器通知、toast）（代码里事务先开、先套用，COMMIT 在 fsync 之后，见步骤 3）<br>· 崩溃后：启动对账时把 journal 里 `applied_jseq` 之后的记录补进 db；db 丢了或坏了，就从 journal 全量重建<br>· journal 记录不含自由文本：正文、Peek、提醒文字和其他从源里来的任意字符串都进可清除的片段表，journal 只存 digest 和 snippetRef（body 允许的字段见步骤 3）；哈希链只盖摘要<br>· 还没触发、也没取消的提醒，它的片段行钉住，不受 TTL 和「清除秘密」影响（照 r4 §6.1 第 4 条钉住 `resultRef` 的做法），触发或取消后才解钉<br>· 片段表（可清除）、`install_key`（片段摘要用的安装级密钥）和 metric 表（测量样本）是旁表，从不重建，也不参与重建比对；`applied_jseq` 是投影表 | 不引入原生模块，重查询放进 worker。journal 只追加、带哈希链，本来就是一个确定的提交点；db 用 `synchronous=NORMAL`，断电丢掉最后几个事务也能从 journal 补回。反过来让 db 当权威，journal 缺的那几行补不出可信的哈希链 | §5.3 r4:591、§5.2 Store r4:560、§6.1 r4:667 |
| UI | 浏览器端用原生 ES module `.js`，加 `// @ts-check` 和 JSDoc，不用库、不构建。页面是 journal 的投影：一条 SSE 流推某个 jseq 时的整份收件箱快照，页面只存界面状态（选中、路由、弹窗、待定 chip、连接状态），不存权威状态。组件手写：`<template>` 克隆 + `textContent` 的键控补丁、纯函数描述符，测试用 `test/helpers/fake-dom.ts`。人类动词带 actionId，结果只认流里的 `recentActions`，不乐观显示。一张命令表生成快捷键、行提示和 `?` 帮助（M1 再生成 Ctrl+K 面板）。daemon 启动时经读闸门的 `app-assets` 根类（步骤 4）把 `ui/**`、`shared/**` 里白名单上的文件读进内存，发到 `/assets/ui/*`、`/assets/shared/*`。ui-only 不发页面（D-17 的推荐默认）。两端共用的协议、中文文字、常量和净化函数放在 `shared/*.js`。细节见 `docs/plans/2026-10-31-ui-interaction-design.md` | 浏览器跑不了 `.ts`；CSP 只放行 `'self'` 脚本，并开了 Trusted Types；零依赖下只有手写 DOM 不用改扫描和 CSP | §5.3 规则 1–2、§11 |
| 渲染 | M0 全部用 `textContent`，不做 markdown | Peek 本来就是纯文本 | §11.2 |
| procguard | 把 `ProcGuard.cs` 移到 `native/procguard/`，删掉测试旋钮，Job 类命令包进 `#if M1`。构建由 Node `execFile` 直接调 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，参数向量固定：`/nologo /target:exe /platform:x64 /optimize+ /debug- /r:System.Core.dll /r:System.Web.Extensions.dll /out:<经写围栏核对的路径> <源文件>`，M0 不带 `/define:M1`。<br>开发构建放 `build/`，运行时构建放 `~/.orchestra/runtime/procguard/<源码哈希>/`，每次启动前核对 sha256。二进制不入库 | Node 不经 shell 启动 `.cmd` 会同步抛 EINVAL（核验）；旧版 csc 不支持 `/deterministic`，所以按源码哈希钉 | §13.2 S4 行 r4:2364 |
| 单写者锁 | 锁看身份，不看心跳（I12）：<br>· 进程整个生命周期都独占持有命名管道 `\\.\pipe\orchestra-<hash>-lock` 的服务端。第二个实例 listen 会得到 EADDRINUSE（核验），它在控制台打印一条「已有 orchestrad 在跑」（附持有者的 pid 和启动时刻、怎么处理）就以锁被占退出码（23）退出，不开存储<br>· 持有者一死，内核立刻释放管道，下一个实例直接拿到<br>· `~/.orchestra/run/daemon.json` 拿锁时写一次：`{v, pid, profile, bootId, startedAt}`。createTime 到步骤 6 有了 procguard 再补写一次，每次启动至多两次。没有心跳。它只给第二个实例的提示和诊断用，永远不是接管的理由<br>· 停下就结束进程：停下时从不手动放锁，进程一退出内核就放掉管道，所以不会有进程丢了锁还在跑（第 2b 步）<br>· 旧实例卡住不会被自动替换，要你自己关掉或杀掉（故意失败即关） | 不用处理陈旧 PID。睡眠和满载都会让心跳变旧，按心跳抢锁正好在最需要锁的时候放出第二个写者 | D3 r4:487、原则 8 r4:435 |
| 测试 profile | `--test-profile --test-dir <dir>`：<br>· dir 必须在 `os.tmpdir()` 下，且名字以 `orchestra-test-` 开头<br>· `ORCHESTRA_HOME=<dir>\orchestra`，只读 `<dir>\roots\{claude,dsh,codex}`<br>· 只能刹 `--test-root-pid` 登记过的假进程树<br>· 控制台和 UI 顶部都显示 `TEST PROFILE` | agent 能做 UI 检查，又拿不到真实进程上的人类动词 | D8 r4:492、r4:1701 |
| fixture | 默认合成；`.gitignore` 对 `fixtures/` 默认拒绝，只放行 `fixtures/synthetic/` 和 `fixtures/golden/`。真实抓取先过清洗器、再经人工复核，才能进 synthetic。另有零依赖的扫描测试（是否换掉 gitleaks 见 D-2） | 默认 gitignore 是 r4 原文 | r4:2377、§6.1 #3 r4:668 |
| 零写入证据 | ① 写围栏 + 静态扫描 + 导入围栏<br>② Procmon 30 分钟由你跑，`scripts/procmon-check.ts` 判定<br>③ 冻结树哈希 diff：合成版自动化；真实版的冻结副本放在仓库外 | ② 要管理员权限 | r4:2389 |
| CI | 没有 git remote，「CI」就是本地跑 `node --run test`。pre-commit hook 要你同意（D-8） | — | §14 #8 |
| toast | 常驻一个 PowerShell 5.1 toast worker：<br>· 启动参数固定为 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -NoLogo -WindowStyle Hidden -EncodedCommand <源码里的常量脚本>`，`shell:false`、`windowsHide`<br>· WinRT 类型只加载一次<br>· 从 stdin 读 base64 UTF-8 JSON 行，每弹一条往 stdout 回一行 `shown` | 冷启动 PowerShell 要 1.3–3.4 s（S4），放不进 2 s；`-NoProfile` 让你的 profile 不跑在 orchestrad 名下 | §5.3 规则 3 r4:597、§11.2 r4:2098 |
| 外连网络 | 只有 `src/net/dsh-connect.ts` 能调 `fetch`，目标只能是 `http://127.0.0.1:<port>/` 或 `http://localhost:<port>/` | 防止 token 发到别处 | §10.11 r4:1695 |

### 2.1 要你定的事（都给了推荐默认）

本计划的 D-n（带短横）和 r4 的决定 Dn（不带短横）是两套编号；本计划凡指 r4 的，都写成「r4 Dn」或带 r4 行号。

几个词：
- AC3 = 等你的事 2 s 内生成条目并提交通知；AC10 = Tuning 显示 codex 那行文案和 Claude 版本漂移（AC 全表见 §5）。18A、18B = 步骤 18 的两半：验收脚本、收尾与端到端。
- P1–P7 = 开眼准则（§0.5），例如 P5 = 标记后于效果。metric 表 = 只放测量样本的旁表，不参与重建比对。human 记录 = journal 里记人类动作的那种记录。
- hash 落地 = 经 `#/item/<id>` 这类地址打开页面时的那次选中。CSP = 浏览器的内容安全策略，限定页面能跑哪些脚本。TT = 浏览器的 Trusted Types 白名单，开了以后往 innerHTML 这类写入点写字符串会被拒掉。
- 一份新快照 = daemon 经 SSE 推来的一整份收件箱视图。rAF、srev、drain 见 UI 设计第七节。
- D-19 和第 2c 步用到的词：WriteFence = 写围栏（`fs/write-fence.ts`），唯一能写盘的入口。哑 io = 随手造的一个假读写接口。第 2c 步之前，WriteFence 的 rm（删文件、删目录）和 mkdtemp 直接调 fs，不经注入的 io（rename 第 2b 步起已经经 io），所以就算只配一个哑 io，rm 照样删真文件；那时挡住别的模块自己造写围栏的只有按名字的静态扫描（只许 main.ts、working.ts 造，另禁 `.constructor`），运行时没有挡，绕过扫描的模块配上自选的根就能删真文件。第 2c 步（6a5471c）起 rm、mkdtemp 也经注入的 io，io 是必填的；真的 io 只由 boot 在围栏前造好（`fs/node-io.ts`），只经它的工厂递给写围栏，别处造的写围栏碰不到真文件。D-19 代价栏里「只做 2b」的风险，说的就是 2c 之前的样子。「fs 能力在 boot 里造好」= 只让一个文件碰 `node:fs`，boot 在装导入围栏之前用它造好读闸门和写围栏的工厂，递给 main；围栏装好后别的模块 import 不到它，也就造不出能动真文件的闸门。process 能力清单 = 一张表，把 process 对象上的每个属性归成「留着、锁成桩、boot 先拿走」三类。删陪跑规则 = 删掉几条和别的防线重复、自己从没单独拦下过东西的静态扫描规则（例如 5 条网络禁令），把 fs 名字禁令合成一张表，再加一个覆盖测试。环境时钟 = 读时间的其它写法（如 `Date()`、`performance.timeOrigin`、`process.uptime`），开眼 §7.3 要它们也只许出现在 clock.ts。脚本也走 boot = 碰真实根的开发脚本也先过导入围栏再跑（`boot --script <名字>`）。

| # | 事项 | 推荐默认 | 代价 | 你不定时怎么办 |
|---|---|---|---|---|
| D-1 | 类型检查依赖 | 允许装 `typescript` 和 `@types/node` 两个 devDependency，钉精确版本，只给 `node --run typecheck` 用 | 多两个钉死版本的开发依赖；运行时仍是零依赖 | 不装也能做完 M0，靠测试和 VS Code 自带检查 |
| D-2 | gitleaks | M0 用零依赖扫描器代替（要改 r4:2377 的措辞，属于放宽，所以问你）。仓库公开前（Q9，M3 前）你装 gitleaks 全量跑一次 | 零依赖扫描器的规则比 gitleaks 少；r4 措辞要改 | 先用零依赖扫描器，步骤 7 的 gitleaks 一项标「待你」 |
| D-7 | 你在场的实跑排期 | 第 3 周末：TUI 等待实测。第 4 周：Procmon、冻结树 diff、24 小时观测。（提示：按新时间线，步骤 10 在实现第 14.0 天（约 M0 第 17 天）做完，TUI 实测最早在第 4 周；线 C 从第 8.0 天才开工时，步骤 10 在第 16.0 天（约 M0 第 19 天）做完（推断，§4.1）；默认值没改，由你定） | 排得早了，实测时步骤 10 可能还没做完，要再约一次 | 对应验收项先标「待你」 |
| D-8 | 持久配置两项：pre-commit hook、每晚 canary 的计划任务 | 都先不装；canary 先手动跑 | 没有自动 canary，也没有提交前的闸 | 不装 |
| D-9 | 实现线数（现在就要定：步骤 2、2b、2c、3 都已提交，线 C 的步骤 6 现在就能开工） | 开第二个实现会话，在独立 worktree 里做线 C（§4.1），关键路径约 18.45 天（不做 2c、只做 2b 时约 17.6 天）；18.45 假定线 C 在第 5.6 天开工，从现在（第 8.0 天）开工约 20.0 天（推断，§4.1） | 要用你的额度（附录第 10 条）；关键路径仍比 r4 剩下的 12–15 天多约 2.6–6.45 天（按 20.0 天算多约 5.0–8.0 天） | 只有一个会话在做，线 C 不开工；从第 8.0 天起每拖一天，关键路径（约 20.0 天）再晚一天，D-10 的默认也不成立。只开一个会话时 M0 按约 29.7 天排（四项全削约 26.2 天），超出 r4 预算约 11.2–17.7 天（26.2 − 15 到 29.7 − 12） |
| D-10 | UI 工期（UI 设计第七节）：两轮合计约 +1.45 天工作量，步骤 17 从线 B 挪到线 C 末尾；接受它也就选了人这一端档「只做核心四条」 | 接受 | 线 B 是关键线，线 C 早 0–0.45 天做完（步骤 6 的落库部分从这里扣，§4.1）；步骤 17 依赖步骤 3 冻结的通知接口（含 ToastPort）一次定对。人这一端档全做约再 +1.3 天，全压线 B。不挪步骤 17，关键路径再 +0.75 天。往回压：线 B 削③（约 −0.45 天，AC10 推到 M2），再削线 C 的②（约再 −0.05 天；两项合计仍约 −0.5 天）；线 C 从第 8.0 天才开工时反过来：线 C 是关键线，削线 B 的③省不了，先削线 C 的②省约 0.5 天（推断，§4.1）；周自评移到 M1 省约 0.05 天，不推荐（r4:2719 写明从 M0 起采集） | 按推荐默认排 |
| D-11 | r4:595 的 CSP 末尾加 `trusted-types 'none'` | 加 | 约 0 天；以后建不了任何 TT 策略（DOMPurify 的策略、Lit 都用不了） | 照 r4:595 原样发 |
| D-12 | 快捷键（r4 §11.9）：① 加 `n`、`e`、`?`、`g t` 和别名；② 单键只在列表焦点里生效、Tuning 可关；③ 750 ms 防误触读作「一份新快照改了选中行的 id、位置或可用动词」，M0 用在 `e`、`K`；④ 照 r4 §10.9 r4:1663 保留「焦点在列表上时冻结排序」，按 `j`/`k` 或焦点离开时才重排；⑤ 选中的条目结束、页面自动改选到别的行之后，`e`、`s`、`r`、`K` 先不响应，等你用 `j`/`k`、方向键或点击自己选一行（hash 深链和 toast 落地照旧可以直接动作），这改了 r4 §11.9 里 `s`、`r`、`K` 何时响应 | 五条都接受 | ④约 0 天（含在步骤 5 里，推断）；⑤约 0 天（已含在步骤 5），不接受⑤就只剩 750 ms 一道闸，你走开再回来按 `e` 或 `K`，可能落在一行不是你挑的条目上，而 M0 的这些动作都撤不回。另一种：只上 r4 原有的键；750 ms 按字面「列表一变就无效」，正常 SSE 流量下键会频繁失灵；不要④就得改 r4 §10.9 的措辞，行会在光标底下换位 | 按推荐默认排 |
| D-13 | P0 的「播放声音」（r4 §11.2）由系统通知自带的声音满足，不用页内 WebAudio | 接受 | 声音受勿扰和系统音量管。另一种：加回 WebAudio 和「声音未启用」提示，+0.1 天 | 按推荐默认排 |
| D-14 | M1 前定：r4 §5.3 规则 2 的 markdown 不用 DOMPurify，改手写子集、全用 createElement；链接照 r4:596 只许 http(s)，经 `ui/route.js` 的中转确认页打开 | 接受 | M1 约 0.5 天；M0 约 0 天，不受影响 | M1 开工前再问 |
| D-15 | 浏览器通知何时回执（UI 设计第七节；开眼 §7.5 人这一端档也在等你定这一条） | 交给系统就回执（`phase:'dispatched'`），这次尝试 1.5 s 内没报 error 才写 `notifiedAt`，`show` 只进 metric；勿扰实测之前「交给系统 → 显示」标「口径未核实」；页头不放「已交给系统 n 条」，放 Tuning | `notifiedAt` 记的是「交给系统、1.5 s 内没报错」，不是「显示了」；Windows 里关掉浏览器通知时网页权限仍是 granted，回执照样到、不转 toast（推断，未核实）。另一种（开眼 §7.3）：`show` 来了才回执，`error` 直接转 toast；更贴 P5，AC3 时延变大，勿扰下 show 若不来，每条都会 1.5 s 后再转 toast；静默替换若不触发 show，每次补发多弹一条 toast | 按推荐默认排 |
| D-16 | seen 从哪来（M4 的 Q11 要用 noticed 指标来定） | 你主动选中（`j`/`k`、方向键、点击）后停留 ≥500 ms，或 peek、打开、点通知，写成 human 记录；载入默认选中、hash 落地、自动改选都不算；seen 不算干预 | 500 ms 是假设；每个条目多写至多一条 human 记录。另一种（开眼 §7.3）：只认显式输入，noticed 由 18A 重算，noticed 会偏晚，约 +0.1 天 | 按推荐默认排 |
| D-17 | ui-only 还发不发网页（开眼 §7.5 问的同一件事，只定一次；第 4 步开工前要定） | M0 不发：照第 2 步的现状打印每条原因、以 ui-only 退出码（22）退出，不起 HTTP；浏览器那边显示「连不上 orchestrad（原因见启动它的控制台）」；ui-only 的 Tuning 页移到 M1 | 省约 0.25 天（抵掉第二轮步骤 4 的增量；推断，步骤 4 原估时没写这部分，可能本来就没算，抵不掉时关键路径约 18.7 天）；r4:589「ui-only 提供 Tuning」要改措辞，要你点头；Low、完整性不明、数据目录失败、journal 断链时原因只在控制台。另一种（照 r4 发）：步骤 4 再 +0.25–0.5 天，要写清 main.ts 怎么在不拿锁、不开存储时起 HTTP、端口从哪来、配对码和 bootId 挪进 main.ts、`startup-modes` 两个测试重写（UI 设计第七节）；完整性不明时进程可能其实是提权的，所以选「发」时推荐完整性不明仍退出 | 第 4 步按代码现状（不发）开工；你后来选「发」，在线 B 的步骤 15 补上（+0.25–0.5 天）；r4:589 到你点头才改 |
| D-18 | 页面可见且有焦点时，级别 P1 只在页内提示（挑战稿的提议，UI 设计第七节） | M0 不做（r4 D10 原样），M2 随专注模式再议 | 要做 +0.1 天；有焦点 ≠ 在看，页内提示不进操作中心，`notifiedAt` 会有两种意思 | 不做 |
| D-19 | 开眼 §7.5 的安全档（原文第一档） | 做 2b 和 2c 的四件；开眼 §7.3 另两条见代价栏。即第 2b 步（已提交 a83826d，0.5 天）加第 2c 步（约 0.85 天，压在线 A 的步骤 3 之前，§4.1 的 2c 行；按推荐默认做完、已提交 6a5471c）。2c 只做四件：fs 能力在 boot 里造好、process 能力清单、删陪跑规则（这三条出自 §7.3「第 3 步开工前」），加一条钉住进程内 start() 的 home 的仓库测试（开眼 §7.7）。另有一问，两种选项下都要答：同意 r4 措辞两处，r4 D3「心跳锁」改「身份锁」，r4:589 缺 registerHooks 改为退出（2b 的代码已经这样做，选哪种都留着）；推荐同意 | 关键路径约 17.6 → 18.45 天（2c 已提交（6a5471c），现在选「只做 2b」省不回这 0.85 天，17.6 是当时的估算；D-19 仍开着，实际还能改变结果的主要是上面 r4 那两处措辞，推断）。开眼 §7.3 另两条不在 2c 里：环境时钟照开眼原文并进步骤 3 的 Clock 扫描规则，不管 D-19 选哪种都做，算在步骤 3 的 2.4 天里（推断 ≤0.05 天；已随步骤 3 提交）；脚本也走 boot 没估、还没排进哪一步（推断 ≤0.05 天；开眼原文放在第 6 步之前，最晚在第一个碰真实根的脚本落地之前）。另一种：只做 2b，其余到 M1，约 17.6 天；代价是到 M1 之前，挡住别的模块自己造写围栏的只有静态扫描，运行时没有挡：绕过扫描的模块配上自选的根，就算只配一个哑 io，也能删真文件（词义见上）。不同意那两处措辞：代码照现状，r4 和代码不一致，留到你点头 | 按推荐默认（开眼笔记把整个安全档标了必做；脚本也走 boot 还没排）；r4 措辞到你点头才改 |
| D-20 | 开眼 §7.4、§7.5 的门脚本档（原文第三档）和两个 agent 定义 | 门脚本先只做「修复见证」（约 0.5 天），排在线 C 等步骤 3 的那段空档里（第 8.0 天前约 0.4 天多），做不完的接在线 C 末尾（两段合计约 0.85 天，§4.1），不算进关键路径（线 C 要是从第 8.0 天才开工，这两段空档都没了，修复见证要另找位置，例如线 B 在第 17.7 天做完后空出的那段；推断，§4.1；默认不变）；其余到 M1。agent 定义先不加，照 D-8 由编排器从转录里统计工具调用 | 做之前，修复没被见证的风险照旧；门脚本全做约 1.5 天；agent 定义是持久配置，要你同意 | 按推荐默认：修复见证照上面排；agent 定义不加 |

### 2.2 本计划按以下理解实现（r4 没写清的地方；你不同意再改）

1. **`K`（Shift+K）kill-tree 在 M0 上线。** §10.3、§11.2 草图、§11.9 都用到它，只是 §13.2 的键表漏了。
2. **刹车的语义**（§10.3 r4:1580–1582、§10.5 r4:1601、r4:1612）：
   - 弹窗列出 harness 下面的进程树，你勾一棵或几棵子树（默认勾 RSS 最大的那棵，例如 `rg.exe`）。每棵子树以它自己为根、连根一起杀。
   - orchestrad 自动替你给子树根的令牌，所以普通子树不用键入确认。
   - 只有两种情况要你键入确认：选中的是 harness 本身（只对单会话的 Claude CLI 开放）；或者子树里有受保护节点。
   - 多会话宿主（`dsh web`、Codex Desktop 等）本身永远不出现在可选项里，界面显示「无法安全刹车」和替代做法。
3. **M0 建哪些表**（r4 D1）：投影表 `applied_jseq`、`project`、`part`（R01 花名册）、`event`（包括 `kind: edge`，以及步骤 3 定的 `clock`、`transition`、`judgment`、`human`、`human.result`，不另建表）、`inbox_item`、`reminder`、`command`、`protect_entry`（pid + createTime + 原因）；旁表 `snippet`、`install_key`（片段摘要的密钥）、`metric`，从不重建。
4. **Project 怎么来**：按会话的 cwd 自动归组（规范化、不分大小写），名字取路径最后一段，颜色由哈希决定。你可以在 Tuning 里合并或改名，结果写进 `~/.orchestra/config.json`；改的名字要过 `shared/protocol.js` 的 `PROJECT_NAME_RE`（1–64 个码点，不含 Cc/Cf/Cs/Zl/Zp 类字符，可以有路径分隔符），自动取的路径末段仍限 32 个码点（见步骤 4 的 `server/view.ts`）。不读 `.git`。
5. **`waitingFor` 映射到条目种类**：
   - `permission prompt` / `sandbox request` / `worker request` → approval。
   - `input needed` / `dialog open` / `goal proposal` → question。
   - 没见过的值 → question，标低置信。
   - 以上都是 P1，只给深链（r4:816、r4 D8）。
6. **failure 和 ready-for-review 的判据**：
   - Claude 从 busy 变成 idle → P3 ready-for-review；再变回 busy 就自动清除。
   - API 错误记录、DSH 的错误类事件 → P2 failure。
   - 具体的 type 名在步骤 9/11 从样本里定。
7. **DSH `approval/*`**：有「请求」类事件才出 approval 条目，看到 `approval/decided` 就自动清除；否则只记延迟。§15 把 DSH 审批等待列为盲区，M0 不承诺。
8. **M0 不做 hook 接收端**，AC3 的 2 s 门槛照测（r4:2385）。
9. **`o` 键**：
   - 已退出的 Claude 会话：给一条可复制的 `claude --resume <uuid>`，id 先过 UUID 正则。
   - 活着的观察会话：显示 pid、宿主、窗口标题，提示「到原生窗口处理」。
   - DSH 会话：你在 Tuning 里粘贴过 `/connect` URL，才给 DSH 会话页链接（R24）。链接里不带 token，你的浏览器用它自己的 DSH 登录状态打开。
10. **读白名单补两类**：
    - `state_5.sqlite-wal`：§7.3 #1 r4:860 要求它和主库一起读。
    - Codex 和 DSH 全局安装的 `package.json`：各一个文件，只取 `version` 字段。
    - 另外，`readdir`/`stat` 只在已知根内允许，外加根目录发现用的 glob 字面前缀（例如 `~/.rec/claude/accounts`）。
11. **版本从哪来**，三家都不启动二进制：
    - Claude：注册表里每个会话的 `version`。
    - Codex：`state_5` 的版本列，没有就读 `package.json`。
    - DSH：日志头的 `version`，加 `package.json`。
12. **runaway 的 RSS 与输出洪泛阈值**（§10.3 r4:1566–1567，代定）。只告警、不自动杀，不改任何验收：
    - 宿主工作集 ≥ max(4 GB, 物理内存的 25%) 时出 P0。本机 27.8 GB（核验），阈值约 7 GB。
    - 宿主工作集 60 s 内涨 ≥1 GB 时也出 P0。
    - 单会话工具输出 ≥N KB/分钟时出 P2 flood。N 在步骤 9 按样本定，在那之前暂定 256。
13. **注意力指标**：
    - blocked = 条目创建时刻（`committedAt`）。
    - noticed = 你第一次 seen 这个条目：主动选中（j/k、方向键、点击）后停留 ≥500 ms（页面可见且有焦点）、peek、打开或点开通知。用 j/k 扫过去不算；载入时的默认选中、hash 深链和 toast 落地的选中、条目结束后的自动改选也不算，要你再动一次手才开始计（UI 设计第三节，D-16）。blocked→noticed 照 r4 报中位数，另加报 p95、p99（I06）。
    - 干预 = 改变条目或进程的人类动作：snooze、remind、acted、刹车执行、roots、protect、dsh-connect。seen、peek、打开不算（暂定）。
    - 项目切换 = 选中条目的项目变了。
    - 「提交通知」的时刻（`notifiedAt`）：浏览器路径取页面回执（ack，`phase:'dispatched'`，即「已交给系统」）到达的时间，但要等这次尝试的 1.5 s 窗口过完、没来 `phase:'error'` 才写进 journal；来了 error 就不设，改由 toast 的 `shown` 设。toast 路径取 worker 回报 `shown` 的时间。浏览器路径另记系统 `show` 事件的时刻（`phase:'shown'`），只进 metric 旁表，用来报「交给系统 → 显示」。这是 D-15 的推荐默认；「勿扰下 show 可能不来」未核实，§5 清单第 5 条实测之前，这两个数标「口径未核实」。
    - 三个率（I06，替代「漏掉的提醒 = 0」这种写法；目标仍是 0，但报 k/n 和 Wilson 95% 上界，n = 0 显示「未测」）。按信号类别分开报：approval、question、低置信「可能在等你」、DSH approval/*、提醒、runaway P0。
      - 漏报：源里出现过，门槛内却没有条目。和源事件同批提交的路径按构造为 0，由 CI 守住；注册表类另以 `missedTransitions` 作上界；低置信类用有注册表信号的会话离线重算 20 s 规则来比对。
      - 迟报：有条目，但提交通知晚于该类门槛（2 s，提醒 ±5 s，runaway 10 s）。`notifiedAt` 一直为空的记「未送达」，也算迟报。
      - 误报：有条目，事后证据说不是（低置信类按上面的离线比对；提醒类是提前触发）。没有判据的类显示「未测」，不写 0。
    - 周自评：在 Tuning 里点 1–5。
14. `snoozeUntil` 写进数据库，重启不丢。
15. **保护名单**（§10.5 #3 r4:1610）：
    - Tuning 花名册每行有「保护」按钮（POST + CSRF），结果落在 `protect_entry` 表。
    - orchestrad 启动 procguard 时用 `--protect` 带上名单，procguard 每次发出 `ready` 后再补发一次 `protect`。
    - 收到 procguard 的确认之前，刹车接口返回 503 `brake-unavailable`。
    - createTime 已经对不上的条目（进程早没了，或 pid 被别的进程复用）不再带给 procguard（`--protect` 和补发的 `protect` 里都没有它），表里照旧留着，Tuning 标「已失效」；你点「移除」才经 journal 记一条 `protect{op:'remove', reason:'tuning'}` 删掉（推断）。不直接删投影表的行：db 是从 journal 重建的投影，直接删掉的行重建时会回来；冻结的 `protect` body 里也没有「失效」这种原因（`reason` 只有 `tuning`、`config`）。另一种：加一个原因（例如 `stale`），让 daemon 自己经 journal 删，这要在 main 上提契约小提交、同改 contract-freeze 的金样。

### 2.3 编排器代定（建议值，可改；记进 r4 G.7）

| # | 代定内容 | 影响 r4 哪里 |
|---|---|---|
| 代-1（原 D-3） | 现在就 vendor dsh-TUI 的类型文件，钉在 HEAD 71f5ac93，放进 `vendor/dsh-tui/`，只经 `import type` 引用。这是照 r4 做，不改时点 | §5.2 r4:552 不改；NOTICE 加 MIT 条目 |
| 代-2（原 D-4） | 启动与配对：<br>· 真实 profile 只由你在可见控制台里用 `orchestra.cmd` 启动，不开机自启<br>· 配对码只在 stdin 和 stdout 都是 TTY 时打印，否则关掉配对并记日志<br>· 配对会话只放内存<br>· agent 只许起测试 profile | §10.11 #1/#4、r4 D8（收紧） |
| 代-3（原 D-5） | UI 浏览器：Edge 和 Chrome 都在受保护名单里，行为在你常用的那个浏览器上核验 | §10.5 #3 |
| 代-4（原 D-6） | toast 发送者用 Windows PowerShell 自带的 AUMID，不写注册表、不建快捷方式 | §11.2 r4:2098 |
| 代-5 | 读白名单加 `state_5.sqlite-wal`、两个 `package.json`、glob 字面前缀的 readdir | §10.11 r4:1693 |
| 代-6 | GET 和 SSE 校验 `Sec-Fetch-Site`；`/api/pair` 的专门规则（步骤 4） | §10.11（收紧） |
| 代-7 | `state_5` 按变化键复制，不再每次轮询都复制（步骤 14） | §7.3 #1 r4:860 |
| 代-8 | 数据目录双向检查，写围栏先拒后放（步骤 1–2） | §5.3 r4:600（收紧） |
| 代-9 | RSS 与输出洪泛阈值（§2.2 第 12 条） | §10.3（收紧） |
| 代-10 | 脱敏时，自身环境变量里的固定系统变量和路径型值不做精确替换（步骤 3） | §6.1 #1 r4:664 |
| 代-11 | M0 的 procguard 只编译七个命令；Job 类命令移到 M1 | §13.2 S4 行、§5.2 procguard 行 |
| 代-12 | 记下 2026-10-30 核验的事实：<br>· Node 不经 shell 启动 `.cmd` 会抛 EINVAL<br>· `node:sqlite` 不受 permission model 约束<br>· `registerHooks` 按线程生效，挡不住本模块图里的静态 import<br>· `getBuiltinModule` 可写，能绕过钩子；`vm` 也能拿到它<br>· `Worker{eval:true}` 不继承钩子（复核实测）<br>· Windows 把 `orchestra.localhost` 解析到 127.0.0.1<br>· whoami 在 Low 下 S4 跑通过，S5 见过一次 0xC0000142 | §5.3、§10.11、附录 A |
| 代-13 | UI 默认值（UI 设计第四节）：tick 5 s、20 s 没帧判过期；每个配对会话最多 2 条活流，新的顶掉老的（seen 的 500 ms 停留归 D-16 问你，不在这里）；分组头中文在前（需要你 / 出错了 / 待审 / 提醒），乐谱名作副标；snooze 数字预设 15 分钟 / 1 小时 / 今晚 20:00 / 明早 9:00 | §11.2、§11.9 |

---

## 3. 仓库结构

```
package.json / tsconfig.json          type:module、engines、脚本
orchestra.cmd                         你手动启动用；把 ORCHESTRA_NODE 所在目录加到 PATH 前面
src/
  boot.ts                             入口：特性检测 → 造好 ports（fetch、fs/child_process 闸门工厂、SQLite 打开器工厂、真钟 hub、endProcess）
                                      → 装导入围栏 → await import('./main.ts')；进程只经它的 makeEndProcess 结束：有界冲完控制台（≤2 s）
                                      再交给围栏前拿走的原始 reallyExit（步骤 3）
  main.ts                             start(features, fence, ports)：参数 → 完整性 → 启动模式 →（working）import runtime/working.ts：
                                      数据目录复查 → 写围栏和读闸门 → 锁 → 数据目录 → daemon.json → 存储（步骤 3：开库、验链、
                                      截尾、补应用 applied_jseq 之后的批、记 recovered、给孤儿 human 补 unknown、扫过期片段）
                                      →（以后各步）procguard → 数据源 → HTTP
  config.ts                           ~/.orchestra/config.json：端口、额外根、extraHarnessRoots、UI 浏览器名单、阈值
  runtime/env.ts                      注入式路径：{home, env, launcherGlobs, extraHarnessRoots} → 全部候选根与已知 harness 根
  runtime/features.ts                 检测 zstd、registerHooks、node:sqlite、类型剥离
  runtime/integrity.ts                只按 whoami 输出里的强制标签 SID 判定
  runtime/startup.ts                  planStartup()：退出（提权、缺特性）/ ui-only / working；退出码见 runtime/exit.ts
  runtime/exit.ts                     类型化退出码（20–29 段）
  runtime/working.ts                  working 的装配处：数据目录复查、写围栏和读闸门、锁、daemon.json、开库与对账（步骤 3）、测试根登记、配对码、stop()；
                                      只由 main.ts 在判定 working 后 import
  runtime/data-dir.ts                 ORCHESTRA_HOME 与 harness 根的双向检查
  runtime/test-profile.ts             测试 profile 的参数、目录规则、测试根登记
  runtime/lock.ts                     命名管道独占锁 + daemon.json（持有者身份；拿锁时写一次，步骤 6 起 procguard 给出 createTime 后补写一次，至多两次；只给提示和诊断用；没有心跳）
  runtime/builtin-policy.ts           唯一的「哪个模块能用哪个 builtin」表，静态扫描和导入钩子共用
  runtime/import-fence.ts             registerHooks 钩子；按 process-powers.ts 的表处理 process 和全局上的每个属性：
                                      getBuiltinModule 换成只给默认 builtin 的桩，binding、dlopen、loadEnvFile、report、kill/_kill、
                                      调试口等锁成桩，锁住网络全局和 undici 的 dispatcher、origin 槽；exit 锁死（步骤 3）
  runtime/process-powers.ts           process 和全局上每个自有属性的分类表（留着 / 锁成桩 / boot 先拿走），第 2c 步建；
                                      步骤 3 起 exit 锁死，reallyExit 由 boot 拿走独占；键集金样测试管 Node 升级
  fs/node-io.ts, os/node-proc.ts      唯一碰 node:fs、node:child_process 的模块，只导出闸门工厂；boot 在围栏前造好（第 2c 步）
  runtime/workers.ts                  唯一的 Worker 启动入口（经 workers/bootstrap.ts）
  runtime/clock.ts                    唯一的 Clock 端口：单调钟、墙钟、定时器表、同 tick 固定次序；挂在 ClockHub 上，hub.port(onFire | null)
                                      造 Clock；真 hub 只由 boot 造；测试和回放用虚拟钟
  runtime/log.ts
  fs/paths.ts                         规范化；拒绝 ADS / UNC / \\?\ / 设备名
  fs/harness-roots.ts                 已知 harness 根清单（写围栏的拒绝表 + 数据目录检查）
  fs/write-fence.ts                   唯一的写入口：先拒后放；安全的 rm
  fs/read-gate.ts                     唯一的读入口：白名单 + 黑名单 + 测试模式
  os/spawn.ts                         唯一的 child_process 入口：只认（绝对 exe，精确 argv）对
  os/procguard-build.ts, os/procguard-client.ts
  os/toast-script.ts                  toast worker 的 PowerShell 脚本常量
  os/toast.ts                         常驻 toast worker [可削减①]
  net/dsh-connect.ts                  唯一能调 fetch 的模块：/connect 换 cookie
  store/db.ts, store/migrations/0001-m0.ts, store/journal.ts, store/snippets.ts, store/redact.ts, store/canonical-json.ts, store/rebuild.ts
  store/store.ts, store/records.ts    唯一的提交路径（Store.commit）与启动对账；每种 kind 的 body schema、planExpired
  store/node-sqlite.ts                唯一碰 node:sqlite 的模块，boot 在围栏前造好（步骤 3）
  model/part-state.ts, model/inbox.ts, model/edges.ts, model/source-report.ts, model/symbols.ts
  sources/claude/{roots,registry,transcript}.ts
  sources/dsh/{discovery,frame-tail,normalize-v4}.ts
  sources/codex/{state5-snapshot,wal-key}.ts   [可削减④]
  lib/zstd/frames.ts
  workers/bootstrap.ts, workers/cold-decode.ts, workers/state5.ts
  detectors/{needs-input,runaway,rss,flood,policy}.ts   [policy 可削减②]
  reminders/scheduler.ts
  notify/channel.ts                   回执、客户端状态、浏览器与 toast 之间的路由
  brakes/kill-tree.ts                 按子树出计划、执行、测试根检查、Command 记录
  tuning/capabilities.ts
  metrics/latency.ts, metrics/attention.ts, metrics/latency-bounds.ts, metrics/wilson.ts, metrics/silence.ts
  server/http.ts, server/auth.ts, server/routes.ts, server/sse.ts, server/assets.ts
  server/view.ts                      唯一的 ItemView / 快照编码器
  server/idempotency.ts               人类动词按 (actionId, requestDigest) 去重，表从 journal 重建；另有内存 in-flight 表（步骤 4）
shared/constants.js, shared/sanitize.js
shared/protocol.js                    SSE 帧与载荷形状、verbs、错误码、行比较函数、id 正则；帧与载荷形状（SHAPES、FRAMES、ITEM_FIELDS、
                                      ENDED_FIELDS 和造形状的 S）步骤 3 起就在这里，contract-freeze 只钉名字，树在步骤 4 结束时冻结
shared/strings.js                     全部中文文字和 {key,args} 拼字，页面和 toast 共用
ui/                                   index.html、app.js、store.js、conn.js、clock.js、prefs.js、api.js、view.js、dom.js、
                                      commands.js、hotkeys.js、route.js、notify.js、peek.js、dialogs.js、kill-dialog.js、
                                      tuning.js、pair.js、style.css、jsconfig.json（各文件的职责见 UI 设计第二节）
native/procguard/ProcGuard.cs         M0 helper（Job 类命令在 #if M1 里）
vendor/dsh-tui/                       src/agent/*、src/adapter/ports/channel-{view,session}.ts、LICENSE、VENDORED.md（提交号、文件清单、sha256）
scripts/                              build-procguard、sanitize-fixture、freeze-tree、procmon-check、latency-report、toast-latency、rss-20、home-meta、
                                      coverage-report、check-real-{claude,dsh,codex}、dsh-sampler、host-signatures、test-stage、
                                      signal-rates、cost-bench
fixtures/synthetic/  fixtures/golden/ 只有这两个子目录会提交；fixtures/ 其余一律 gitignore
test/                                 按 src 分目录；test/helpers/（含 fake-dom.ts）；test/fixtures/writers/、scenarios/、fake-agent
spikes/                               冻结的参考代码，生产代码不许 import
```

---

## 4. 实施顺序

### 4.1 总览

| 步骤 | 内容 | 估时 | 线 | 依赖 | 能否削减 | 推进的验收 |
|---|---|---|---|---|---|---|
| 0 | 脚手架与仓库卫生 | 0.5 d | A | — | 不可（fixture 卫生） | 前提 |
| 1 | 写围栏、读闸门、导入围栏 | 2 d | A | 0 | 不可 | AC7①、AC9 |
| 2 | 自检、锁、数据目录、spawn 闸门、测试 profile | 1.75 d | A | 1 | 不可 | AC8（拒绝提权） |
| 2b | 补开眼 §7.2 实测出的洞（安全档的一部分，已提交 a83826d） | 0.5 d | A | 2 | 不可 | AC7①、AC8 |
| 2c | 安全档其余五条里的三件，加一条仓库测试（D-19；已提交 6a5471c）：fs 能力在 boot 里造好、process 能力清单、删陪跑规则、一条钉住进程内 start() 的 home 的仓库测试；另两条不在这里：环境时钟进步骤 3，脚本也走 boot 没排，见 D-19 | 0.85 d | A | 2b | 视 D-19 | AC7① |
| 3 | 存储、收件箱模型、共享契约（冻结点；已提交 e451d4c） | 2.4 d | A | 2c | 不可（收件箱） | AC1/AC3/AC4 的地基 |
| 4 | HTTP、UI 鉴权、SSE | 1.95 d | B | 3 | 不可 | AC8 |
| 5 | 收件箱页、渲染规则、刹车弹窗、通知路由、Tuning 骨架 | 2.9 d | B | 4 | 不可 | AC8、AC3 |
| 6 | procguard 与刹车 | 2 d | C（假定第 5.6 天起；还没开工，见 §4.1「线 C 还没开工」） | 2、2b、2c（2b 改了 WriteIo（writeAtomic 的 close、rename 走注入的 io）和停法（停下就结束进程，PidLog 多了 detach），2c 改了 WriteFence 能力和进程能力）；落库部分等 3，在第 8.0 天后做 | 不可 | AC6 |
| 7 | fixture 工具链、冻结树 diff | 1 d | C | 3 | 不可 | AC7③、AC1 的前提 |
| 8 | vendor 词汇、归一化核心、状态机、边、回放 | 1.5 d | C | 7 | 不可 | AC1 |
| 9 | DSH 源 | 1.75 d | C | 8 | — | AC1、AC2 |
| 10 | Claude 根目录、注册表、需要输入 | 1.75 d | C | 6、8；手动项等 5 | — | AC2、AC3 |
| 11 | Claude transcript、低置信条目、边 | 1 d | C | 10 | — | AC1、AC3 |
| 12 | runaway v0、RSS 与洪泛 | 1 d | C | 6、9、11 | — | AC5、AC11 |
| 13 | 一次性提醒 | 0.75 d | B | 5 | — | AC4 |
| 14 | Codex `state_5` 快照轮询 | 1.75 d | B | 7、8 | **可削减④** | AC1、AC2 |
| 15 | 静态 Tuning 补全、版本漂移、`/connect` | 1 d | B | 3（接真实源在 18B） | 漂移显示**可削减③** | AC10 |
| 16 | policy v0 | 0.5 d | C | 11 | **可削减②** | — |
| 17 | toast 后备（常驻 worker） | 0.75 d | C（16 之后，D-10） | 5；通知接口和 ToastPort 在步骤 3 冻结 | **可削减①** | AC3/AC4/AC5（后台时） |
| 18A | 验收脚本（两行时延报告、三个率、相位扫描、静默表、UI 一块） | 1.35 d | B | 7、8、9、13、14；10–12 等线 C 步骤 12 并回 main（第 16.0–16.3 天，假定线 C 第 5.6 天开工；从第 8.0 天开工约第 18.0 天，见下面的时间线） | — | AC2–AC5 的报告、AC7② |
| 18B | 收尾与端到端 | 0.75 d | A+C | 全部 | — | AC2、AC3、AC11 |
| 19 | 开眼第一轮的第三档（可选） | 逐项估，合计约 1.75 d | 哪条线有空档就哪条 | 见步骤 19 | 不做就移到 M1，不算进工期 | — |

- **谁做哪条线**：
  - 实现会话 1 做线 A（第 0–8.0 天，含 2b、2c），接着做线 B。
  - 实现会话 2 第 5.6 天（2c 做完；D-19 只做 2b 时第 4.75 天）起做线 C，在独立 worktree `G:\_Projects\dsh-orchestra-lane-c`（分支 `m0-lane-c`）里做。线 C 在步骤 6、9、12、16、17 结束时并回 main，每次提交都等你点头。到 2026-10-31 线 C 还没开工（仓库里没有这个 worktree 和分支），影响见下面时间线的「线 C 还没开工」一条。
  - 两个会话都是 agent，都只用测试 profile。
- **冻结点**：步骤 3 结束时冻结这些共享文件：migration `0001`、`server/routes.ts` 的路由表与 JSON 形状、`shared/constants.js`、`shared/protocol.js` 的枚举和正则部分（verbs、错误码、结束类、ActionOutcome 枚举、id 和标题 args 的正则）、`model/inbox.ts`、`model/source-report.ts`、`notify/channel.ts` 的整个接口（含 StreamsPort、ToastPort）、`store/journal.ts` 的记录种类与字段（含步骤 3 的 body 字段名单和 schema、`human` 和 `human.result`）、`runtime/clock.ts` 的接口（含 timerId 格式、`ClockHub.port`、Fired 的键、定时器类名）。这些都已随 e451d4c 提交。`test/repo/contract-freeze.test.ts` 的金样只钉住其中一部分：`shared/protocol.js` 的导出（枚举、正则、函数名；步骤 4 的几个形状只钉名字，见下）；`notify/channel.ts` 的接口清单和声明文本的摘要；Clock 端口（四个方法、hub、Fired 的键、定时器类名、同 tick 次序、写 clock 记录的类、clock 记录的字段）；journal 行的键、记录种类、每种 body 的字段树和 0001 的摘要；回放时校验用的策略表（实体、状态、条目和提醒的边、kind 表，`model/inbox.ts` 里只有 `ITEM_EDGES` 和 `KIND_RULES` 在这里面）。`server/routes.ts` 的路由表与形状、`shared/constants.js`、`model/source-report.ts`，以及 `model/inbox.ts` 的其余部分，现在只是约定冻结，还没有金样；步骤 4 放宽冻结时可以一起钉进去（推断）。之后要改，就在 main 上单独提一个小提交，改到有金样的部分就在同一个提交里改 contract-freeze 的金样，两条线各自 rebase。步骤 6 用到的 `command` 和 `protect_entry` 两张表，表形状按 §2.2 第 3 条定，由步骤 3 写进 0001。UI 契约的其余部分：`shared/protocol.js` 的帧与载荷形状（`SHAPES`、`FRAMES`、`ITEM_FIELDS`、`ENDED_FIELDS` 和造形状的 `S`）步骤 3 起就在这个文件里，contract-freeze 只钉它们的名字，形状树和行比较函数、`shared/strings.js` 的文字 key 在步骤 4 结束时另行冻结，只有线 B 和线 C 的步骤 17 用到。
- **时间线**（工作日）：
  - 线 A：0（0–0.5）、1（0.5–2.5）、2（2.5–4.25）、2b（4.25–4.75）、2c（4.75–5.6，D-19）、3（5.6–8.0）。
  - 线 C：6（5.6 起，2c 做完才开工：步骤 6 的构建和 spawn 要用 2c 改过的 WriteFence 能力和进程能力；比 4.75 晚开工不影响关键路径，因为步骤 7 本来就要等到 8.0）。步骤 6 的落库部分（Command 记录、`protect_entry`，要等步骤 3 的 0001；设为 x 天，推断 x ≤ 0.3）放不进 8.0 之前，挪到第 8.0 天紧接着做，其余部分在 7.6 − x 做完。Clock 端口原来也要等：现在 `runtime/clock.ts` 已随步骤 3 提交（e451d4c，接口见步骤 3），四个方法 `nowMono`、`nowWall`、`schedule`、`cancel` 照原样，挂在 ClockHub 上、用 `hub.port(onFire | null)` 造；步骤 6 直接照它写 procguard 请求超时（`deadline` 类）和计划过期（`planExpired`），不用再「先照接口写、第 8.0 天后接上」。x 原来为这部分留的量可能用不上，天数照估时不改（推断）。之后 7（1 天）、8（1.5）、9（1.75）、10（1.75）、11（1）、12（1）、16（0.5）、17（0.75，D-10），各步都比 x = 0 时晚 x 天：7 在 8.0 + x 开工，12 在 16.0 + x 做完并回，17 在 17.25 + x 做完。x 超过 0.45，线 C 就晚于线 B，关键路径跟着推后。
  - 线 B：4（8.0–9.95）、5（9.95–12.85）、13（12.85–13.6）、15（13.6–14.6）、14（14.6–16.35）、18A（16.35–17.7）。x > 0.35 时线 C 的步骤 12 晚于 18A 开工，18A 照它自己写的「线 C 落后」办法先做不依赖 10–12 的部分。
  - 18B：17.7–18.45。合计约 18.45 天。线 B 是关键线。线 C 有两段空：第 8.0 天前约 0.4 + x 天，末尾约 0.45 − x 天，合计约 0.85 天。8.0 前那段先给 D-20 的修复见证（约 0.5 天）开工，做不完的接在末尾；末尾剩下的可以接 18B 里不等 18A 的部分（Tuning 接真实源、`rss-20.ts`）或步骤 19 里的一项。
  - **线 C 还没开工**（推断）：上面三条都假定线 C 在第 5.6 天开工。步骤 3 已提交（第 8.0 天），线 C 还没开工；从现在开工，步骤 6 不用再等 0001（x 并进步骤 6 的 2 天里）：6（8.0–10.0）、7（10.0–11.0）、8（11.0–12.5）、9（12.5–14.25）、10（14.25–16.0）、11（16.0–17.0）、12（17.0–18.0）、16（18.0–18.5）、17（18.5–19.25）。线 C 成了关键线，18B 在 19.25–20.0，关键路径约 20.0 天。8.0 前那段空档、末尾的 0.45 − x 和 D-20 修复见证的位置都没了；步骤 12 在 18.0 并回，晚于 18A 开工（16.35），18A 走「线 C 落后」那条路；步骤 10 在第 16.0 天做完（D-7）。往回压也反过来：削线 B 的③省不了，先削线 C 的②省约 0.5 天（D-10）。反过来线 B 在 17.7 做完后空出约 1.55 天（不是一整段：18A 里等 10–12 的那部分要到第 18.0 天步骤 12 并回后才能做，推断），可以接手线 C 还没开工的一步（§7 的办法 1）或放修复见证。保住 17.7 的最晚开工日是第 6.45 天，已经过了；从第 8.0 天起每拖一天，关键路径再晚一天（D-9）。
  - **e451d4c 留下的三件**：提交说明写了三件没做完的事。① `makeEndProcess` 的准备阶段没兜住（那里抛错，进程的结束就没落定）；② 同一个 hub 上两个 gate 的 spawn deadline id 可能相撞（撞了按 duplicate-timer 拒绝）。这两件已由第 3b 步修好（fd35af0，只改 src 和 test，939 个测试 936 过）：结束先定下退出码，准备阶段每一步都兜住；run 的时限按计时表编号（`tableSeq`）。3b 没估时，第 8.0 天的钟也没算它。③ 内建对象的原型仍可写，记为已知残留，不排；3b 另记了两条残留：`Timeout.prototype` 和监听器被恶意模块改动（不在威胁模型内，见开眼笔记 7.1、7.8）。
  - D-19 选「只做 2b」时：去掉 2c，步骤 3 在 4.75–7.15，线 C 在 4.75 开工、到 16.4 + x，线 B 到 16.85，合计约 17.6 天（当时的估算；2c 已提交，现在选它省不回这 0.85 天，推断）。
- **估时变化的算式**：
  - 开眼第一轮的第一档 +2.0 d：步骤 2 +0.25（1.5→1.75）、3 +0.75（1.5→2.25）、8 +0.5（1→1.5）、10 +0.25（1.5→1.75）、13 +0.25（0.5→0.75）。
  - 开眼第一轮的第二档 +0.5 d：步骤 18A 0.75→1.25（含从第一轮第三档提前的 I14(a) tick 相位扫描，理由见步骤 18A）。
  - UI 交互设计第一轮 +1.0 d（`docs/plans/2026-10-31-ui-interaction-design.md`）：步骤 4 +0.3（1.5→1.8）、5 +0.6（2→2.6）、18A +0.1（1.25→1.35）。步骤 17 从线 B 移到线 C 末尾（D-10）。
  - UI 交互设计第二轮净 +0.45 d（推断，明细见 UI 设计第八节末）：步骤 3 +0.15（2.25→2.4，第一轮就地改的契约补价 0.1，加挪进步骤 3 的契约 0.05）；步骤 4 ±0（约 +0.25 的修正与嫁接，由 D-17 的默认「不发 ui-only 页」抵掉约 −0.25；这个抵扣是推断：步骤 4 原来的 1.5 d 没写 ui-only 怎么起 HTTP，可能本来就没算，抵不掉时关键路径 18.3 → 18.55；算上下面步骤 4 的两个决定是 18.45 → 18.7）；步骤 5 +0.3（2.6→2.9）。
  - 步骤 3 之后给步骤 4 定的两件事 +0.15 d（推断）：错误码 `bad-request`、`superseded-tab` 约 0.05，Store 的写口收起来、server 只拿只读视图约 0.1；步骤 4 1.8 → 1.95。步骤 4 在线 B（关键线）上，所以关键路径同加 0.15。
  - 安全档：2b 0.5 d（已提交 a83826d，计入）；2c 0.85 d（D-19 的推荐默认，计入；已提交 6a5471c）：fs 能力在 boot 里造好约 0.75、能省回约 0.25，净 0.5；process 能力清单 0.25；删陪跑规则 0.1；钉住 home 的仓库测试很小，算在这 0.85 里（推断）。另两条不在 2c 里：环境时钟并进步骤 3 的 Clock 规则，算在步骤 3 的 2.4 d 里（推断 ≤0.05 d）；脚本也走 boot 没估（推断 ≤0.05 d）。
  - 串行：24.25 + 2.0 + 0.5 + 1.0 + 0.45 + 0.5 + 0.85 + 0.15 = 29.7，约 29.7 天；四项全削（0.75 + 0.5 + 0.5 + 1.75 = 3.5）后 26.2，约 26.2 天。
  - 并行：线 A 0.5 + 2 + 1.75 + 0.5 + 0.85 + 2.4 = 8.0；线 C 等步骤 3，8.0 + x（步骤 6 的落库部分，≤0.3）+ 8.5 + 0.75（步骤 17）= 17.25 + x，不超过 17.55，早于线 B；线 B 8.0 + 9.7（1.95 + 2.9 + 0.75 + 1 + 1.75 + 1.35）= 17.7；再加 18B 的 0.75，得 18.45（步骤 4 的两个决定之前 18.3，第一轮 UI 后 16.5，开眼修订后 16.25，最初 14.5）。
  - 开眼第一轮的第三档（步骤 19）合计约 1.75 d（I14 只剩挂上偏移和 (b)，0.5→0.25；另加 UI 时延探针 0.25；I20 的 0.25 已并进步骤 5 的 `static-render.test`，从这里删掉），不算进上面的数。
  - 开眼笔记 §7.5 的分档：人这一端档由上面 UI 两轮的 +1.45 d 取代，不另加；安全档里 2b 和 2c 已计入，开眼 §7.3「第 3 步开工前」的另两条：环境时钟进步骤 3（算在 2.4 d 里），脚本也走 boot 没估、没排（推断 ≤0.05 d）；门脚本档（0.5–1.5 d）见 D-20，不算进上面的数。
- **一个会话串行做**：约 29.7 天，四项全削约 26.2 天（D-9）。
- **每步的完成标志**：`orchestra.cmd run test` 全绿，这一步的手动检查做完，然后提交一次（由你点头）。

### 4.2 每步细节

**步骤 0　脚手架与仓库卫生**（0.5 d，线 A）
- **建什么**：见 §8，包括 `src/boot.ts` 入口桩。核实 `node --run` 走 PATH 时用的是哪个 Node。
- **测试**：
  - `test/runtime/features.test.ts`
  - `test/runtime/env.test.ts`
  - `test/runtime/boot.test.ts`
  - `test/repo/hygiene.test.ts`
  - `test/repo/load-all.test.ts`：逐个 import `src/**/*.ts`，不 import `vendor/`。所有模块 import 时不能有副作用；只有 `boot.ts` 在 `import.meta.main` 为真时执行。
- **推进验收**：所有验收的前提。

**步骤 1　写围栏、读闸门、导入围栏**（2 d，线 A）
- **建什么**：
  - `fs/paths.ts`。
  - `fs/harness-roots.ts`：从 `env.ts` 和 config 算出已知 harness 根，并去重：
    - Claude 的全部候选根，包括展开后的启动器 glob、glob 的字面前缀、Tuning 里手填的额外根。
    - `~/.claude`、`~/.dsh`（含 `bot/`）、`~/.codex`、`~/.dsh-tui`、`~/.ds-bot`。
    - config 里的 `extraHarnessRoots`。本机要登记 DS-Bot 桌面版的数据目录 `G:\_dsbotplayground\bot`，由你在 Tuning 里登记一次；源码默认值为空，不把个人路径写进公开仓库。没登记时 Tuning 顶部常驻提示。
    - 比较时不分大小写。路径存在就取 realpath；不存在就取最近一个存在的祖先的 realpath，再拼上剩下的部分。
  - `fs/write-fence.ts`：
    - 先拒后放：目标落在任何已知 harness 根之下，一律拒绝，即使它也在 `ORCHESTRA_HOME` 之下。之后才看是否在 `realpath(ORCHESTRA_HOME)` 之下。
    - 提供 writeAtomic（同目录临时文件 + rename）、append、mkdirp、rm。
    - rm 逐项 lstat。遇到重解析点（junction、symlink）只删链接本身（unlink，失败再非递归 rmdir），不往里走。每一项删除前都单独过一次围栏。
  - `fs/read-gate.ts`：
    - 按根目录类型配置策略，先查拒绝规则再查允许规则；只用 `'r'` 打开，读完即关，句柄计数。
    - 测试模式下，拒绝 `--test-dir` 和冻结目录以外的一切。
  - `runtime/builtin-policy.ts`（初值；以后要加一行，提交说明里写理由）：

    | 模块 | 额外允许 |
    |---|---|
    | 全部模块（默认） | `node:path`、`node:url`、`node:events`、`node:util`、`node:crypto`、`node:zlib`、`node:timers`（步骤 3 起移出默认行，只给 `clock.ts`） |
    | `src/fs/*` | `node:fs`、`node:fs/promises`；`write-fence.ts` 另加 `node:os`（只用 `tmpdir`）（第 2c 步起只有 `fs/node-io.ts` 有 `node:fs`，boot 在围栏前造好（minted）；`node:fs/promises` 和 write-fence 的 `node:os` 都删了） |
    | `src/os/spawn.ts` | `node:child_process`（第 2c 步起改给 `os/node-proc.ts`（minted），spawn.ts 不碰任何 builtin） |
    | `src/store/db.ts` | `node:sqlite`（步骤 3 起改给 `store/node-sqlite.ts`（minted），db.ts 不碰 `node:sqlite`，是它前面的闸） |
    | `src/runtime/lock.ts` | `node:net`（只用 `createServer`） |
    | `src/server/http.ts` | `node:http`、`node:net`（只用来建服务端） |
    | `src/runtime/workers.ts`、`src/workers/bootstrap.ts` | `node:worker_threads` |
    | `src/runtime/import-fence.ts`、`src/runtime/features.ts` | `node:module` |
    | `src/main.ts` | `node:os`（只用 `homedir`、`totalmem`） |
    | 任何模块都禁止 | `node:vm`、`node:wasi`、`node:inspector`、`node:repl`、`node:cluster` |

    带 `node:` 前缀和不带前缀的写法都算。上表是步骤 1 的初值；第 2c 步、步骤 3 起以 `runtime/builtin-policy.ts` 为准：`node:fs`、`node:child_process`、`node:sqlite` 只给 boot 在围栏前造好的 `fs/node-io.ts`、`os/node-proc.ts`、`store/node-sqlite.ts`；`node:timers` 只给 `clock.ts`；`shared/` 下的模块连默认行也不给（页面也加载它们）。
  - `runtime/import-fence.ts`：
    - `registerHooks` 的 resolve 钩子按 `context.parentURL` 查上表；`src/` 以外的模块只有默认允许项。
    - 把 `process.getBuiltinModule` 换成包装函数：只放行默认允许项，其余抛错。没有哪个模块正当需要它，所以不做按调用方的区分。
    - 把 `process.binding`、`process._linkedBinding`、`process.dlopen` 换成抛错的桩。
    - 由 `boot.ts` 在 `await import('./main.ts')` 之前安装。worker 一律经 `runtime/workers.ts` 起：先跑 `workers/bootstrap.ts` 装围栏，再动态 import 真正的 worker 模块。
  - 静态扫描规则：
    - 按上表检查每个模块的 builtin import。
    - 全局禁用以下写法：`getBuiltinModule`、`process.binding`、`_linkedBinding`、`dlopen`、`createRequire`、`eval(`、`new Function`、`eval: true`、`copyFile`、`cp(`、`createWriteStream`、`truncate`、`utimes`、`symlink`、`link(`、`shell: true`、`cc-msg`。
    - 参数不是字面量的 `import()` 只许出现在 `boot.ts` 和 `workers/bootstrap.ts`。
    - `mkdtemp` 只许出现在写围栏模块。
    - `fetch(` 只许出现在 `src/net/dsh-connect.ts`。
    - 禁用 `net.connect`、`createConnection`、`http.request`、`http.get`、`node:https`。
    - 禁用 `agents --json` 这个字符串，也禁用相邻的数组元素 `'agents', '--json'`。
    - 禁止 import `spikes/`。从 `vendor/` 只许 `import type`。
    - `ui/` 里禁用 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`；`ui/` 里的 `fetch` 只许用 `/api/` 开头的相对地址。
    - `vendor/` 里禁止出现 `dangerously`。
  - 豁免只给 `test/`，以及只碰 tmp 或 fixture 的脚本：`sanitize-fixture`、`latency-report`、`procmon-check`（只读你给的 CSV）、`rss-20`、`test-stage`。碰真实根的脚本照样要扫，并且必须经 `read-gate.ts` 的生产策略读：`dsh-sampler`、`check-real-*`、`freeze-tree`、`home-meta`、`host-signatures`。
- **r4**：§5.2 r4:561、§5.3 r4:600/605、§7.2 r4:855、§10.11 r4:1693、§14 #8 r4:2724。
- **测试**：
  - `test/fs/write-fence.test.ts`、`test/fs/paths.test.ts`：
    - 各种逃逸：`..`、junction、symlink、8.3 短名（本机没开就 skip）、大小写、ADS、`CON`/`NUL`/`COM1`、`\\?\`、`\\.\`、UNC、结尾带点或空格。
    - 先拒后放：`ORCHESTRA_HOME=<假 home>` 时，往 `<假 home>\.claude\x` 写被拒。
    - 安全 rm：tmp 里放一个指向假 harness 根的 junction，清理之后假根原样不动。
  - `test/fs/read-gate.test.ts`：
    - 必须拒绝：`*.key`、`*credentials*`、`auth.json`、`.claude.json`、`*.bak*`、`watchdog*.log`、`.env*`、`thread_history_1.sqlite`、`logs_2.sqlite`、`.credentials.yaml*`、`cookies.json`、`*storageState*.json`、`sessions/abc.json`。
    - 必须放行：`sessions/123.json`、`projects/x/y.jsonl`、两种目录名下的 `session.v4.jsonl.zstd`、`state_5.sqlite(-wal)`、`rollout-*.jsonl(.zst)`。
    - 测试文件在 tmp 里现场生成。
  - `test/fs/handles.test.ts`：读完后句柄数回到基线；持有 tail 句柄期间，另一方的 append 不受阻。
  - `test/repo/static-scan.test.ts`：每条规则各配一个正例和一个反例，包括 `['agents','--json']` 和 `{eval: true}`。
  - `test/runtime/import-fence.test.ts`，以下都用子进程跑：
    - 用 `boot()` 加载 tmp 里一个**静态** import `node:child_process` 的入口模块，加载时就失败。
    - 经 `runtime/workers.ts` 起一个静态 import `node:fs` 的 tmp worker 模块，失败。
    - boot 之后，`process.getBuiltinModule('node:child_process')` 和 `process['getBuilt'+'inModule']('node:fs')` 都抛错。
    - `import('node:vm')` 被拒。
- **推进验收**：AC7①、AC9。

**步骤 2　自检、锁、数据目录、spawn 闸门、测试 profile**（1.75 d，线 A）
- **建什么**：
  - `runtime/integrity.ts`：经 `spawn.ts` 跑 `whoami.exe /groups /fo csv /nh`，按 CSV 解析，找出匹配 `^S-1-16-(\d+)$` 的字段（SID 不随系统语言变化）：
    - ≥12288 → `high-or-above`。
    - 8192–12287 → `medium`。
    - <8192 → `low`。
    - whoami 跑失败、没有这个字段、或解析出错 → `unknown`。
    - 永远不靠写探针判定进入工作状态。S4 里 whoami 在 Low 下跑通了，S5 见过一次 0xC0000142，所以失败时必须按不安全处理。
  - `runtime/startup.ts` 的 `planStartup(features, integrity, dataDir)`，按顺序判定（退出码以 `src/runtime/exit.ts` 为准；第 2b 步把它们挪到 20–29 段，免得和 Node 自己的退出码撞：正常停 0、提权 20、缺特性 21、ui-only 22、锁被占 23、参数被拒 24、启动失败 25、崩溃 26）：
    1. `high-or-above` → 打印原因，以「提权」退出码退出。
    2. 缺 `node:sqlite`、类型剥离或 `registerHooks`（装不了围栏）→ 以「缺特性」退出码（21）退出。缺 `registerHooks` 时 `boot.ts` 根本不 import `main.ts`，直接以 21 退出，不走 ui-only（开眼 §7.2，第 2b 步恢复的拒绝）。
    3. `low`、`unknown`、或数据目录检查失败 → `ui-only`。
    4. 其余 → `working`。缺 zstd 时 DSH 源关闭，并在 Tuning 报错；Node 版本低于 24.22.0 只在 Tuning 警告。
    - `ui-only` 怎么做视 D-17。推荐默认（也是代码现状，`exit.ts` 的 uiOnly）：打印每条原因，以 ui-only 退出码（22）退出，不起 HTTP。你选「发」时：只起 HTTP 和 Tuning，不开存储（错误只放内存），不起任何源，不起 procguard，除 whoami 外不 spawn 任何东西，也不起 toast；步骤 4 要多做的事见 D-17 的代价栏。
  - `runtime/data-dir.ts`：启动时检查一次；Tuning 每次添加或确认根时再查一次。以下任一成立，就不进入工作状态；运行中新加的根直接拒绝添加：
    - 任何已知 harness 根落在 `realpath(ORCHESTRA_HOME)` 之内，或者 `ORCHESTRA_HOME` 落在任何根之内。
    - `ORCHESTRA_HOME` 等于或包含用户 home。
    - `ORCHESTRA_HOME` 是盘符根。
    - 检查通过后创建 `~/.orchestra/{run,tmp,runtime}`，并用安全 rm 清空 `tmp/`。
  - `runtime/lock.ts`（I12，§2 单写者锁那行）：
    - 先独占 listen 命名管道，拿到才往下走；拿不到就打印一条提示（写出持有者的 pid 和启动时刻）后以锁被占（23）退出，存储、源、procguard 都不碰。
    - daemon.json 拿锁时写一次 `{v, pid, profile, bootId, startedAt}`，只给第二个实例的提示和诊断用；createTime 等步骤 6 的 procguard 补上，每次启动最多写两次。没有心跳，代码里也没有任何接管分支。
    - 停下就结束进程（第 2b 步）：停下时从不手动放锁，进程一退出内核就放掉管道，所以不会有进程丢了锁还在跑。只有进程内调 start() 的测试换一个会放锁的停法。（启动半路失败时，例如拿到锁后数据目录准备失败，代码先放锁再以 25 退出，放锁之后不再写 ORCHESTRA_HOME。）
    - 结束怎么落定（第 3b 步，fd35af0）：先把退出码定下来，再刷控制台；刷的时限是 `clock.ts` 只交给 `boot.ts` 一次的原生单次计时器，不在任何 hub 上，哪个端口都不能提前挂或取消它。崩溃走 boot 在围栏之前造好的 uncaught-exception capture 回调（加上 boot 自己的监视）；退出码一旦定下，之后的崩溃就照这个码立刻结束。`boot.ts` 以外不许删或遮住崩溃和退出的监听器（静态扫描管）。`clock.ts` 在模块加载时就抓好 `performance.now`、`Date.now` 和原生计时器，之后替换全局对象不影响它。
    - 关 db 步骤 3 起已经在 `working.ts` 的 `stop()` 里：先摘下日志和 pid 记录（`log.detach()`、`pidLog.detach()`），再 `store.close()`，最后 `stopping.end`。以后各步要在停下时做的事（SSE 发 `bye{shutdown}`、关 procguard 的 stdin）也放进 `stop()`，排在 `log.detach()` 之前，并等写完（经 Clock 限时，推断）。`end` 是 boot 的 `makeEndProcess`（步骤 3 起）：只等 stdout、stderr 冲完，至多 2 s（boot hub 上的一只 `deadline` 钟），然后把退出码交给 boot 在围栏前拿走的原始 `reallyExit`，不发 `exit` 事件；第一次调用说了算，之后的调用（包括出口上的崩溃）改不了已提交的退出码。排在它后面的事不会跑，套接字上没写出去的字节也可能发不出去（推断）。第 2c 步时类型化退出还经 `process.exit` 提交；步骤 3 起 `process.exit` 锁死，开眼笔记 §7.6 的「不锁 exit」随之翻案（dd3d9d0 已记进开眼笔记）。
  - `os/spawn.ts`：只认下面这些（绝对 exe，精确 argv）组合。每次 spawn 都把 pid 记进 `run/pids.jsonl`。

    | exe | argv |
    |---|---|
    | `%SystemRoot%\System32\whoami.exe` | `/groups /fo csv /nh` |
    | csc.exe | §2 的固定构建向量；`/out:` 要过写围栏 |
    | PowerShell 5.1 | `-NoProfile -NonInteractive -NoLogo -WindowStyle Hidden -EncodedCommand <os/toast-script.ts 的常量>`（步骤 17 之前这一行开不了：spawn.ts 里的编码常量 `TOAST_ENCODED` 今天是 null，开这条规则会直接抛错） |
    | procguard.exe（运行时目录或 `build/`） | 不带参数，或只带 `--protect <pid:createTime,...>` |

    拒绝 `.cmd`/`.bat`、`shell:true`、相对路径，以及任何其他 argv。
  - `runtime/test-profile.ts`：
    - 参数为 `--test-profile --test-dir <dir> [--test-root-pid <pid>]...`，外加只许指向 `%LOCALAPPDATA%\orchestra-frozen\` 之下的 `--roots-dir`。
    - `--test-dir` 不在 `os.tmpdir()` 下、或名字不以 `orchestra-test-` 开头，就拒绝启动。
    - `ORCHESTRA_HOME=<dir>\orchestra`，根目录只有 `<dir>\roots\*`。两者是兄弟目录，所以数据目录检查能过。
    - 本步有登记表和匹配规则（`TestRoots`）：只认命令行带 fake-agent 标记的 node.exe，createTime 也要对上。经 procguard 把每个 `--test-root-pid` 解析成 pid:createTime 要等步骤 6；在那之前每个测试根都停在 `unresolved`，刹车一律不能用它（working.ts 记一条 `test-roots-unresolved`）。
    - 配对码直接打印到 stdout，因为测试工具要读它。
  - 真实 profile：只有 `process.stdin.isTTY` 和 `process.stdout.isTTY` 都为真时才打印配对码；否则关掉配对，在日志里写明原因。在 node:test 下拒绝启动（参数被拒，24）：注入的环境和进程自己的环境里只要有一处带 `NODE_TEST_CONTEXT` 就算（第 2b 步）。唯一例外：进程内调 start() 的测试显式传带类型的 opt-in（`inTestRealProfile`），钉住临时目录里 orchestra-test-* 目录下的假 home，不带根变量、ORCHESTRA_HOME 也在那个目录里，过了检查才放行（第 2b 步；2c 的仓库测试就建在它上面）。
  - `boot.ts` 的 `ports.fetch`（第 2b 步）：每次调用新造一个 init，RequestInit 的每个字段都是自有值，dispatcher 绑死；调用方的 init 从不往下传。只用无原型的 init 挡不住 `Object.prototype.dispatcher`（第 2b 步在 Node 24.22 上实测）。到步骤 15 之前只服务 `data:` URL。
  - `scripts/test-stage.ts`（测试侧）：
    - 用 mkdtemp 建测试目录，用合成写入方造出各个根，起 fake-agent 进程树。
    - 然后以测试 profile 拉起 orchestrad，并打印 URL 和配对码。
    - 实现会话做手动 UI 检查只用它。
  - `runtime/log.ts`。
- **r4**：§5.3 r4:586–600、§10.5 #5、§10.11 #4/#5 r4:1701–1702、D8 r4:492、r4:2370。
- **测试**：
  - `test/runtime/integrity.test.ts`：合成的 whoami 输出（组名用中文和英文各一份）：Medium、High、System、Low、缺标签、空输出。
  - `test/runtime/startup-modes.test.ts`：
    - Low 和 unknown → ui-only，除 whoami 外 spawn 的 spy 为 0，存储没打开。
    - 以 High 运行同时让 whoami 失败 → 得到 ui-only 或退出，不能进入 working。
    - 缺 `registerHooks` → boot 不 import `main.ts`，以缺特性退出码（21）退出；缺 zstd → working，DSH 关闭，Tuning 报错；缺 sqlite → 以缺特性退出码（21）退出。
  - `test/runtime/data-dir.test.ts`，以下都必须拒绝：
    - `ORCHESTRA_HOME=<假 home>`。
    - `ORCHESTRA_HOME=<假 home>\.rec`，其下有假的 `accounts/1/config` 根。
    - Tuning 往 `ORCHESTRA_HOME` 里加一个额外根。
    - `ORCHESTRA_HOME` 是盘符根。
  - `test/runtime/lock.test.ts`，多数用子进程跑（「只写一次 daemon.json」和第二次 listen 得 held 两例在进程内跑）：
    - 持有者卡住（默认就跑）：持有者是照 orchestrad 拿锁的替身子进程（`test/helpers/lock-holder.ts`，journal 也是替身），拿到锁后用 `Atomics.wait` 冻住自己的事件循环，趁它还冻着起第二个实例 → 第二个实例以锁被占（23）退出，控制台提示恰好 1 条、写出持有者的 pid 和启动时刻；接管 0 次，ORCHESTRA_HOME 和 journal 字节不变（分叉 0 次），持有者还在跑。没有时间阈值，所以也不靠时间余量：持有者冻多久结论都一样，测完由测试经句柄停掉它。原来的 120 s 版和「把心跳改旧」的快速版都删了。
    - 两个实例同时启动 → 恰好活下 1 个，另一个以锁被占（23）退出，提示恰好 1 条。
    - 杀掉持有者后立刻启动 → 1 s 内拿到锁。
    - 一个模块发 SIGINT 又留着定时器 → 持有者连锁一起结束，没有进程丢了锁还活着；一次启动只写一次 daemon.json，不挂定时器。
  - `test/os/spawn.test.ts`：步骤 17 之前 toast 规则开不了，PowerShell 的任何 argv 都被拒（步骤 17 接上常量后改成：带任何别的 argv 都被拒）；procguard 带 `--protect` 以外的参数被拒；`.cmd` 被拒。
  - `test/runtime/test-profile.test.ts`：
    - `--test-dir` 在 tmp 之外 → 拒绝启动。
    - 测试模式下读真实根 → 拒绝。
    - 对没登记的根做 kill-tree → `not-test-root`。
    - 非 TTY 的真实 profile（假 home）不打印配对码，日志写明配对为什么关；配对路由的 403 在步骤 4 测（本步还没有配对路由）。
    - node:test 下不带参数启动、或进程内调 start() 时换掉注入的环境 → 真实 profile 都拒绝（24），whoami 都不跑。
  - `test/runtime/log.test.ts`。
- **推进验收**：AC8（拒绝提权）；也是 AC6、AC7② 的前提。

**步骤 3　存储、收件箱模型、共享契约**（2.4 d，线 A；原 2.25 d，UI 第二轮 +0.15 d；结束时冻结共享文件）
- **建什么**：
  - `store/db.ts`：
    - 拒绝 `file:` URI；路径必须过围栏；设好各项 PRAGMA。
    - `openReadOnly()` 给 worker 用。
    - `openSnapshot()` 的 authorizer 只放行 SELECT / READ / FUNCTION，外加四个 PRAGMA：`quick_check`、`table_info`、`table_xinfo`、`query_only`，其余一律拒绝。
    - 禁止 `backup`、`VACUUM INTO`、`loadExtension`。
  - migration `0001-m0`：建 §2.2 第 3 条列出的表。时间字段（I04）：
    - `event`：`srcSeq`（DSH 的 seq、Claude 的行号、Codex 的行号或字节偏移）；`srcTime`（可空，另记精度：Codex 只到整秒，DSH 的 time 打在攒批之前）；`obsMono`、`obsWall`（我们读到的时刻）；`jseq`。
    - `inbox_item`：加 `committedAt` 和 `notifiedAt`。
      - `committedAt` 取条目所在那批记录追加进 journal 之前打下的 `obsMono`/`obsWall`。这个值写在这批记录里，所以能从 journal 重建（journal 那一行写在 fsync 之前，装不下自己的 fsync 完成时刻）。名字不改：条目只在这批提交之后才出现在 db 里。
      - 这批的 journal fsync 和 db 事务真正做完的时刻 `commitDoneMono`，按 jseq 记进 metric 旁表（metric 名就叫 `commitDoneMono`），只给延迟报告的「我方提交」一段用（步骤 18A），不参与判定和重建。尽力而为：这一行写不进只计数（`Store.metricFailures`），不让提交失败。
      - `notifiedAt` 是浏览器回执或 toast `shown` 的时刻（按 §2.2 第 13 条；回执到了写一条 journal 记录；还没通知到时为空）。
    - 次序只认各源自己的 `srcSeq` 和 `jseq`。时长和期限只用 `obsMono`，日历类的值（提醒的到期时刻）才用墙钟。`srcTime` 只当数据，唯一用处是延迟报告里标明来源的「源侧」那一段（CI 断言见步骤 8）。
  - `journal.ts`（补1：journal 是权威，§2 存储那行）：
    - 每行 `{jseq, bootId, obsMono, obsWall, kind, body, digest, prevHash, hash}`，其中 `digest = sha256(canonical(body))`、`hash = sha256(prevHash || digest)`：链只盖摘要，和 r4 D3、原则 8、§6.1 第 2 条一致。`obsMono` 只在同一次启动内可比，所以带 `bootId`。
    - 每批末尾是一条 `commit` 记录，body 是 `{count, bootId, obsMono, obsWall}`：这批的三个戳（追加前读一次，这批每一行都带）写进 commit 的 body，所以只盖摘要的链也盖住了它们。验链时这批每一行的戳都要和它的 commit 一样，改了某一行的 `obsWall` 或 `bootId`（apply 会拿它们算 `committedAt` 等）就是断链，不会悄悄重建出另一份投影。链的算式不变。
    - `body` 的字段只许这几类：id、枚举、数字、digest、snippetRef。重建确实要用的少数源字符串（cwd、版本号、工具名、错误码）另列一张名单，每个先过 `redact.ts`，再过格式检查（路径、semver、标识符，≤128 字符）；不列进来，db 重建后项目名就没了。工具名和版本的正则与 `shared/protocol.js` 里给标题 args 用的是同一份；cwd 在 journal 里存全路径，显示时另按 UI 设计第一节 2 查末段。其余从源里来的任意字符串（包括没见过的 `waitingFor` 原值）一律脱敏后进片段表，journal 只存 digest 和 snippetRef。每种 kind 的 body 有一份 JSON schema，追加前校验。
    - 每批 fsync 一次。提交顺序：journal 追加并 fsync → 一个 db 事务应用这批记录并写 `applied_jseq` → 外部效果。代码（`Store.commit`）里这个事务在追加之前就开了，先在事务里套用这批，apply 会拒的记录因此到不了 journal；COMMIT 仍在 fsync 之后，先后不变。
    - 启动时对账：逐行验链。最后一条 commit 行之后的都算没提交（没写完的半行，或没等到 commit 行的整行）：经写围栏把文件截断到最后一个 commit 行，再追加一条 `recovered` 记录（记下截掉的字节数）。截断和 `recovered` 做不成一步，所以截之前先经写围栏原子地写一个 `ORCHESTRA_HOME\journal.cut`（截后的长度即已提交部分 `committedBytes`、要截掉的字节数、最后一条已提交行的 jseq 和 hash），`recovered` 那批提交后再删掉：截到一半或截完就崩，下次启动看到它，就用原来的字节数补上 `recovered`（或只删掉它），这次截断不会无声无息；对不上的 `journal.cut` 也算断链（`cut-marker`）。这样文件里不留坏行，验链器不需要跳过规则。例外只有一种（`tornFinal`，断电的样子）：最后一批里有一行是乱码（不是 UTF-8，或不是 canonical JSON），这批的 commit 行正好是文件最后的字节，而 db 没应用过这批（`applied_jseq` 不超过这批之前那条已提交行），就把整批当没写完的尾巴截掉、记 `recovered`，不算断链：这是后面的扇区先落了盘、前面的没落。残留风险：已经确认过的最后一批里出了位翻转，又碰上断电把 db 回滚到这批之前（`synchronous=NORMAL`），会被截掉、记 recovered，而不是停下。那一行能解析、只是过不了别的检查，或 db 已经应用过这批，照旧是断链。其余中间断链就不进入工作状态：对账返回类型化结果 `journal-chain`，main 打印原因、以 ui-only 退出码（22）退出；进程内不放锁，管道随进程退出由内核回收（第 2b 步：停下就结束进程）。D-17 两种选项都这样：断链是拿锁、开存储之后才发现的，要在进程内转成 ui-only 就得先手动放锁、进程还活着，正是第 2b 步堵掉的那条路；所以选「发」时这一种原因也不起页面，浏览器那边显示连不上，原因在控制台。截完先把 `applied_jseq` 之后的批补进 db，再提交 `recovered` 那批（和 §3 的次序一样）。
  - `store/rebuild.ts`：从 journal 全量重建投影表（`project`、`part`、`event`、`inbox_item`、`reminder`、`command`、`protect_entry`）。对账补记和全量重建走同一个 apply 函数：只套用记录，不重跑判定。
  - 转换带原因（I01）：状态机的每次转换写一条 `transition` 记录 `{entity, id, from, to, cause}`。`cause` 只能是 `source(partRef, srcSeq)`、`human(actionId)`、`clock(timerId)` 之一，没有 cause 的记录 apply 时直接拒。每个变更类 POST 带一个 `actionId`，记一条 `human` 和一条 `human.result`（何时写、字段见下面 `server/routes.ts` 那一条）。procguard 快照也算源，srcSeq 取快照序号。
  - 标记后于效果（I02）：源游标（`part.sourceCursor`）和这次解析出的 Event 行在同一批 journal 记录、同一个 db 事务里提交，绝不先推游标。崩溃后从已提交的游标重读，按 (partRef, srcSeq) 去重。提醒的「已触发」同理，见步骤 13。外部通知做不到进事务，按至少一次投递处理，见步骤 5、17（补3）。
  - `runtime/clock.ts`（I01）：唯一的 Clock 端口，接口就是四个方法 `nowMono()`、`nowWall()`、`schedule({timerId, class, clock, due})`、`cancel(timerId)`，e451d4c 照这个签名出，contract-freeze 钉住。Clock 挂在 ClockHub 上：只有组装处拿得到 hub（boot.ts 造唯一的真 hub，经 `BootPorts.clock` 递给 main.ts、working.ts），用 `hub.port(onFire | null)` 造 Clock；同一个 hub 的 Clock 共用一张定时器表和一个全序；传 null 造的 Clock 只能读，`schedule` 会被拒。到点交给 onFire 的是 `Fired {timerId, class, clock, due, durationMs, firedMono, firedWall}`。轮询也走它（`poll` 类）；另有虚拟钟 `VirtualClock`，给测试和回放用。要改，先在 main 上提小提交（同一提交改 contract-freeze 的金样）并告诉线 C。
    - timerId 是确定的，格式 `${class}:${entityId}:${seq}`（例如 `reminder:<提醒 id>:0`），不用随机数或 UUID。seq = journal 里已有的这一类、这个实体的 clock 记录条数（`Store.nextTimerSeq`），从 journal 算，所以重启后照样接得上；挂了又在触发前取消的钟没写记录，下次照用这个 seq。timerId 在一个 hub 里唯一：同一个 id 还挂着时再挂，哪个 port 上都会被拒。实体 id 和 actionId 在生产里一生成就写进 journal，从 journal 回放只用记下的；从 fixture 回放时由场景给定。
    - 另有 `deadline` 类给请求超时（procguard 的 10 s，步骤 6；boot 的退出刷新也用它），timerId `deadline:<requestId>:<seq>`。它和 `poll` 一样不写 clock 记录、不引起转换。
    - 静态扫描加一条：`Date.now`、`new Date()`、`performance.now`、`process.hrtime`、`setTimeout`、`setInterval` 只许出现在 `clock.ts`（`ui/` 和 `test/` 除外）。环境时钟也并进这一条（开眼 §7.3；不管 D-19 选哪种都做，算在本步 2.4 d 里，推断 ≤0.05 d）：`Date()`、无参 `new Date`、无参的 `Intl.DateTimeFormat().format()`、`performance.timeOrigin`、`process.uptime`、`AbortSignal.timeout` 同样只许出现在 `clock.ts`；`node:timers` 移出 builtin-policy 的默认行（`node:timers/promises` 本来就不在），两者只在新加的一行里给 `clock.ts`。现有代码里 `os/spawn.ts` 的超时和 `scripts/test-stage.ts` 用了 `setTimeout`，`main.ts`、`os/spawn.ts`、`runtime/log.ts` 默认取 `Date.now`：前几处改走 Clock 端口，`test-stage` 改走 Clock 或在规则里写明豁免（scripts 的豁免名单照 §3）。
    - 轮询的 tick 不进 journal。只有引起转换的触发写一条 `clock` 记录 `{timerId, clock: mono|wall, durationMs, firedMono, firedWall}`，和它引起的转换同批提交。M0 里会引起转换的定时器：提醒到期、snooze 到期、20 s 静默的低置信条目、60 s「未注册」标注。代码里能写 clock 记录的类（`TRANSITION_CLASSES`）现在只有 `silence`、`reminder`、`snooze`：60 s「未注册」（`unregistered` 类）要到步骤 10 有了它的实体才加进去，那时两张冻结表一起改。
    - 同一 tick 到期的，按（类别，timerId）固定全序处理。类别依次是：① 往安全方向收的（M0 没有，给 M1 的审批到期即拒、暂扣到期留位）；② 请你中断的 P1（20 s 低置信条目）；③ 回访与提醒（提醒、snooze 到期）；④ 摘要（M0 没有）。不出条目的标注（60 s「未注册」）排在这几类最后；请求超时（`deadline`）和轮询（`poll`）再往后。
    - clock 记录只改状态、出条目，不新增唤醒源，也不碰任何 agent（r4 D16、Q-P10 不变）。
  - 派生判定的格式（补2，M0 定格式，M1 落地）：`judgment{name, inputDigest, ver, value}`。`value` 是小的结构化结论，不含正文；`ver` 是判定规则的版本。回放和重建只读 `value`、不重算；正文还在时，CI 可以重算一遍和 `value` 比对。M0 先用在片段的脱敏结论上（命中哪几层、几处），给格式一个真实用户。M1 的只致谢长度、处置 schema 解析、origin 都按这个格式写。
  - journal 记录格式和 0001 一起在本步结束时冻结。
  - `snippets.ts`：单条 ≤2 KB，TTL 14 天；「清除秘密」写 tombstone。还没触发、也没取消的提醒文字钉住，不受 TTL 和「清除秘密」影响，触发或取消后解钉（照 r4 §6.1 第 4 条钉住 `resultRef` 的做法）。db 整个丢了、从 journal 重建时片段回不来：提醒照样按时触发，文字显示「已丢失」。
    - TTL 在读时就生效：`get()` 读到过了期、没钉住的文字，当场写 tombstone、回「已过期」，不管扫过没有；`expire()` 每次启动扫一遍（启动对账的最后一步）。定期清扫不在本步：一个常驻定时器会是启动后的 orchestrad 里第一个定时器，所以挪到起 status 帧和 5 s tick 的步骤 4（推断）。
    - 内容摘要是安装级密钥下的 HMAC-SHA256：密钥在 0001 的旁表 `install_key`（和片段表、metric 一样不参与重建），第一次要用时生成 32 个随机字节，从不进 journal。db 丢了密钥也丢了，旧摘要（片段行和 `judgment.inputDigest`）就再也对不上新的；代码里没有任何地方重算旧摘要，所以不丢东西：去重的 `dedupKey` 是 `{kind, partRef, sender, segment}` 的普通 sha256，不受影响；提醒文字本来就随 db 一起丢（照样触发，显示「已丢失」）。
  - `redact.ts`，分三层：
    - 已知值精确替换：粘贴进来的 token；daemon 自身环境变量中长度 ≥8 的值。以下两类不做精确替换（代-10）：路径型的值（盘符或 UNC 开头），以及一份固定的系统变量名单（`PATH`、`PATHEXT`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`USERNAME`、`USERDOMAIN`、`COMPUTERNAME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`SystemRoot`、`windir`、`ProgramFiles*`、`OS`、`PROCESSOR_*`、`NUMBER_OF_PROCESSORS`、`PSModulePath`、`ComSpec`）。不认识的变量照 r4 默认替换。
    - 格式规则加高熵检测。
    - 整段丢弃：`env`、`printenv`、`Get-ChildItem env:` 的输出。
  - `model/inbox.ts`（从原步骤 5 挪过来）：
    - 种类与默认级别照 §11.2。分组：Fermatas / Wrong notes / Ready for review / Reminders。
    - `dedupKey = kind + partRef + 发送者`。Claude 的「在等你」另带段键 (根, pid, procStart, statusUpdatedAt)，见步骤 10。
    - 状态机照 §6.5；每次状态变化都走上面的 `transition` 记录。
  - `model/source-report.ts`：每个源向 Tuning 报告根目录、版本、计数和错误的接口，另加 `lastPollMono`（最近一次轮询时 Clock 端口的单调钟读数，步骤 4 只用它判「停摆」）和 `lastPollWall`、`lastEventWall`（最近一次轮询、最近一次事件的墙钟时刻，只用来写「自 hh:mm」和步骤 15 的 Tuning 显示，不拿来算时长，不变量 20）。
  - `notify/channel.ts` 的整个接口在这里定、在这里冻结，实现在步骤 5（接假的 ToastPort），步骤 17 实现真的 ToastPort：
    - channel 对外：`notify(item)`、`ack({itemId, attempt, tabId, phase: dispatched|shown|error})`、`clientState({tabId, visibility, frozen, permission})`、`streamOpened(tabId)`、`streamClosed(tabId)`、`onlineClients()`（toast 用它判断 10 分钟空闲后关 worker）。
    - 它依赖的 `StreamsPort`：列出活流（tabId、打开时刻、可见、冻结、脏），`sendNotify(tabId, frame)`。
    - 它依赖的 `ToastPort`：`show({itemId, attempt, title, body})`、`onShown(cb(itemId, attempt, shownMono))`。
  - `server/routes.ts`：路由表加 JSON 形状，包括 `/api/brake/plan` 的计划形状；`shared/constants.js`。按 UI 设计第一节改（第一轮约 0.1 d，第二轮约 0.05 d，都算进本步的 2.4 d）：
    - `shared/protocol.js` 在本步建，是 verbs、错误码、结束类、ActionOutcome 枚举（`applied`、`noop:<原因>`、`unknown`）、id 正则、标题 args 正则（工具名、版本、cwd 末段，UI 设计第一节 2）、项目名正则 `PROJECT_NAME_RE` 的唯一出处；`model/inbox.ts` 和 `routes.ts` 引用它，本步冻结这一部分。帧与载荷形状（`SHAPES`、`FRAMES`、`ITEM_FIELDS`、`ENDED_FIELDS` 和造形状的 `S`）也在本步从 `routes.ts` 挪进这个文件，contract-freeze 只钉它们的名字，形状树在步骤 4 结束时冻结。`model/inbox.ts` 加每种条目可用的 verbs 表。
    - `GET /api/items/:id/detail` 替换 `GET /api/items`。`GET /api/session?tab=` 回 `{csrf, bootId, mode, profile, liveStreams, superseded}`；`GET /api/events` 的参数 `tab`（uuid）、`perm`、`why`（含 `backpressure`、`gap`）；`POST /api/client-state {tabId, visibility, frozen, permission, perf?}`；错误码全表照 UI 设计第一节 5 的表（步骤 4 再加 `bad-request`、`superseded-tab` 两个码，见步骤 4 的检查顺序）。检查顺序里的 503 `ui-only` 一格视 D-17，推荐默认下没有这一格，错误码留作保留值。
    - 写 human 记录的 POST 都要 `actionId`；`notify-ack` 带 `phase`。
    - 人类动作分两条 journal 记录：`human {actionId, verb, targetId, requestDigest}` 和 `human.result {actionId, verb, targetId, outcome, commandId, subtrees}`。`human.result` 的 verb 和 targetId 照抄 `human` 那条，apply 校验两边相等，所以 `recentActions` 只读 `human.result` 就够。原来写成 `targetId?`、`commandId?`、`subtrees?` 的，代码里是「值可以是 null，键总要写」：漏一个键就是坏记录（`missing`）；`commandId` 和 `subtrees` 要么都有，要么都是 null。刹车的 Command 和指向它的 `human.result` 必须在同一批（同 actionId、同 subtrees，apply 校验），崩溃拆不开它们。刹车的 `human` 在检查顺序（步骤 4）那一串都过之后、执行第 1 步（重新取快照核对谱系）之前写（不是一过去重那一格就写：后面的检查拒掉的请求不留 `human`；执行一开始就不再回 4xx，核对没过的子树记 `refused`，照常写 `human.result`，见步骤 6），`human.result` 等 Command 结果回来再写；其余动词（标记类、提醒、roots、protect、dsh-connect、自评）两条都在效果之后同批写（标记类的转换也在这一批），按构造不留孤儿 `human`。`recentActions` 只读 `human.result`。`requestDigest` 故意不叫 digest，和 journal 行自己的 `digest` 分开，去重表只从它重建；`dsh-connect` 的 requestDigest 只盖路由。启动对账时，任何有 `human` 没有 `human.result` 的动作都补一条 `outcome:'unknown'`（按构造只有刹车会这样），in-flight 随之结束，同 actionId 的重试拿到它，不会永远 409。非刹车动词在效果中途崩溃时 journal 里没有记录，重试会再做一次；这几种动作重做无害（推断，UI 设计第一节 5）。
    - 0001 里 `human` 是一种 event kind，actionId 上建部分唯一索引（kind = human 一个，kind = human.result 另一个），apply 用 `INSERT OR IGNORE`，撞上就跳过并记 metric `journal.dupAction`，所以 apply 和全量重建都不会因重复而失败（查重本身在追加 journal 之前，见步骤 4）。`Store.commit` 在追加之前也会拒掉一批里库中已有同 actionId 的 `human` 或 `human.result`（`StoreError` 的 `duplicate-action`），是步骤 4 查重之后的兜底；所以 `INSERT OR IGNORE` 只会碰上旧的 journal。`inbox_item` 加 `rev`、`committedJseq` 两列，由 apply 写，能从 journal 重建。
    - 刹车计划是一条 journal 记录 `brake.plan {planId, harness, roots（1–64 个）, nodes（1–4096 个）, protected（0–512 个）, createdMono, createdWall, ttlMs: 60000, expiresAt}`，进程一律写成 `{pid, createTime}`；roots 是弹窗里可选的子树根，必须在 nodes 里；`expiresAt = createdWall + 60 s`，schema 校验；`createdMono` 不能晚于这一行的 `obsMono`。过没过期由 `store/records.ts` 的纯函数 `planExpired(plan, planBootId, now)` 判：`planBootId` 是写下这条计划的那次启动的 bootId，`createdMono` 只在那次启动内可比，所以别的启动的计划一律算过期；同一次启动内 409 `plan-expired` 两只钟都算，哪个先到点就算过期：墙钟往回拨拖不长计划，往前拨只会让它提早过期（P4）。`expiresAt` 是墙钟那一侧的到期时刻，也随 `/api/brake/plan` 的回复发给页面做倒计时。执行结果带每棵子树的 `{root, requestId, killed, residual, status}` 和 `commandId`（UI 设计第一节 2）。
- **r4**：§5.2 Store r4:560、§5.3 r4:591、§6.1 r4:648、r4:662–668、§6.5、§10.12、§11.2、§13.2 r4:2383/2386、r4 D16、Q-P10。
- **测试**：
  - `test/store/db.test.ts`：PRAGMA 生效；ATTACH 被拒；`file:` 被拒；快照连接里 `PRAGMA quick_check` 放行、`PRAGMA writable_schema` 被拒。
  - `test/store/migrations.test.ts`、`journal.test.ts`、`snippets.test.ts`。`journal.test.ts` 另测：末尾半行被截掉、文件以完整行结尾并留下一条 `recovered`，再启动验链通过；截断前先写 `journal.cut`，截完就崩或在 `recovered` 那批里崩，下次启动照样补上原来的字节数、只补一次；改了某一行的 `obsWall` 或 `bootId` 就是断链（`stamp`）；`tornFinal`：最后一批里一行是乱码（不是 UTF-8 或不是 canonical JSON）、commit 行是文件最后的字节、db 没应用过这批 → 整批截掉并记 `recovered`，同样的乱码但 db 已经应用过这批，或那一行能解析、只是过不了别的检查 → `journal-chain`；每批的 `commitDoneMono` 按 jseq 进 metric，写不进不让提交失败；中间断链 → 类型化结果 `journal-chain`；子进程跑时 main 以 22 退出、进程内没有放锁的调用（管道随进程退出放掉，下一个实例拿得到锁），进程内的测试用 `IN_PROCESS_STOP` 那种会放锁的停法收尾；每种 kind 的 body 过 schema 校验，名单外的源字符串进 body 被拒。`snippets.test.ts` 另测：钉住的提醒片段过了 TTL、执行「清除秘密」后都还在，触发后解钉；没扫过时，过了 14 天的文字 `get()` 照样读成「已过期」并当场写 tombstone；摘要带安装密钥，重开后不变，密钥不在 journal 里。
  - `test/store/rebuild.test.ts`（补1、I02）：跑一段合成场景，分别在三个点注入崩溃：journal 只写了半行、fsync 了还没提交 db、db 提交了还没通知。每次重启后事件丢失 0、重复 0（重复按 InboxItem 行计）、提醒丢失 0；再删掉 db、只用 journal 重建，投影表与原 db 逐行一致，`committedAt`、`notifiedAt` 也一致（两者都从 journal 来；片段和 metric 两张旁表不比）。另加一例：db 整个删掉重建后，还没触发的提醒照样按时触发，文字显示「已丢失」。
  - `test/store/transition-cause.test.ts`：没有 cause 的 `transition` 记录 apply 时被拒。
  - `test/store/judgment.test.ts`（补2）：格式校验；清掉全部片段后从 journal 重建，投影不变。
  - `test/runtime/clock.test.ts`：同一 tick 排 5 个定时器，打乱插入顺序跑 100 次，处理顺序和结果都一致；同一场景跑两次，timerId 序列相同；虚拟钟能跳到任意时刻；同一个 hub 的几个 Clock 里一个 timerId 只能挂一次；只读的 Clock 拒绝 `schedule`；Clock 是没有原型的冻结对象，只有四个方法。
  - `test/repo/static-scan.test.ts` 增加 Clock 规则的正例和反例。
  - `test/store/redact.test.ts`：每条格式规则；自定义变量 `FOO=<随机 20 字符>` 的值被替换；`C:\Users\<名字>\proj` 这样的 cwd 原样保留；env 类输出整段丢弃。
  - `test/model/inbox-state.test.ts`、`inbox-dedup.test.ts`、`severity.test.ts`。
- **推进验收**：AC1、AC3、AC4 的地基。

**步骤 4　HTTP、UI 鉴权、SSE**（1.95 d，线 B；原 1.5 d，UI 第一轮 +0.3 d；第二轮约 +0.25 d，由 D-17 的默认「不发 ui-only 页」抵掉；步骤 3 之后的两个决定 +0.15 d：错误码约 0.05、Store 只读视图约 0.1，推断）
- **建什么**：
  - 只听 `127.0.0.1` 和 `::1`；端口来自 config，被占用就报错退出。只在 working 下起 HTTP（D-17 推荐默认）。
  - 页面资源怎么读：读闸门加一种根类 `app-assets`，锚在安装目录（仓库根）下的 `ui/` 和 `shared/`，只放行一份常量白名单里的文件，测试模式也放行（测试 profile 下仓库不在 tmp 里，不放行就读不到）；`server/assets.ts` 启动时经它读一次进内存，自己不 import `node:fs`。读闸门仍只在 `main.ts`、`working.ts` 里建，再递给 server。
  - Host 必须完全等于 `orchestra.localhost:<port>`。请求体上限 64 KiB，只收 JSON；超了、Content-Type 不是 JSON 或解析不了，都回 400 `bad-request`（见下面的检查顺序）。
  - Store 的写口收起来（步骤 3 之后的决定，约 0.1 d，推断）：e451d4c 里 `Store.db` 是公开字段（`store/store.ts`），谁拿到 Store，谁就能不经 journal 直接写投影表。本步把它改成私有的 `#db`，给 server 代码一个只读视图：一组写死 SELECT 文本的读方法（经 `#db` 的 get/all），不收 SQL 文本，没有 run、exec、transaction、checkpoint。不走「另开一条连接、靠 authorizer 挡写」的路：authorizer 是每条连接打开时定的（`store/db.ts` 的 `authorizerFor`），写者连接上没法只对 server 收窄；snapshot 那套是给 tmp 里的 `state_5` 副本用的；另开连接就是 orchestra.db 上的第二次打开，还要再过一遍按名字的判定；`db.ts` 现成的只读连接（`openReadOnly()`，给 worker 用）也掂量过：它挡得住写，可 server 手里就有了能跑任意 SQL 文本的句柄，也还是第二次打开；读方法写死 SQL，server 代码里也就不出现 SQL（推断）。之后只有 journal 追加 + apply 写投影表（`Store.commit` 和启动对账）。片段这张旁表照旧经 `Snippets` 写，不在这一条里。server 要写的计数（`sse.coalesced`、`sse.drop`、`shown`、perf 样本这类 metric）经 Store 上一个只收（名字, 数值）的追加方法写 metric 旁表，这个方法不在只读视图里（推断）。
  - 每个响应都带 r4:595 原样的 CSP，外加 `nosniff`、`Referrer-Policy: no-referrer`、CORP/COOP `same-origin`；`/api` 另加 `no-store`。
  - 配对码：用 `crypto.randomInt` 生成 8 位数字，只打印到控制台、不进日志；一次性，10 分钟过期；用 `timingSafeEqual` 比较。
  - `POST /api/pair` 的规则（代-6）：
    - 只收 POST，Host 和 Origin 都要完全相等，不要求 cookie；Content-Type 不是 `application/json` 不算鉴权失败，和别的路由一样在读请求体那一格回 400 `bad-request`。
    - 连错 5 次，当前码作废并冷却 60 s。
    - 累计错 20 次，配对关闭，直到重启。
    - 新码只从控制台发：在真实 profile 的 TTY 里按 `n`，或者重启。HTTP 永远拿不到新码。
  - cookie：`orchestra_sid`，`HttpOnly; SameSite=Strict; Path=/`，不设 Domain，会话只放内存。CSRF 令牌由 `GET /api/session` 下发。
  - 变更请求在鉴权这一格必须同时满足：POST、带 cookie、Origin 完全相等、带 `X-Orchestra-CSRF`，缺一条就 403。Content-Type 不是 JSON 不算鉴权失败，在读请求体那一格回 400 `bad-request`（照样到不了去重，见下面的检查顺序）；这不丢 CSRF 防护：跨站的 POST 不经预检带不上 `X-Orchestra-CSRF`，在鉴权那一格就 403 了。GET `/api` 和 SSE 要带 cookie；如果请求带了 `Sec-Fetch-Site`，值只能是 `same-origin` 或 `none`。不发任何 CORS 头。鉴权在路由之前，没登录一律 403。
  - 路由：
    - `/`、`/assets/*`
    - `POST /api/pair`、`GET /api/session`、`GET /api/events`、`GET /api/items/:id/detail`（替换原来的 `GET /api/items`）
    - `POST /api/items/:id/{seen,snooze,acted}`、`POST /api/reminders`
    - `POST /api/brake/{plan,execute}`、`POST /api/roots/{add,confirm}`、`POST /api/protect/{add,remove}`
    - `POST /api/notify-ack`、`POST /api/client-state`、`POST /api/dsh-connect`、`POST /api/self-rating`
    - `GET /api/tuning`
    - 预留 `POST /api/approvals/:id/{allow,deny}`：没登录返回 403，登录后返回 501。
  - SSE（UI 设计第一节）：`GET /api/events?tab=<uuid>&perm=<…>&why=<…>`，参数按正则和枚举校验（`why` 多一个 `backpressure`）。不发 `retry:`，重连全由页面的 `ui/conn.js` 管。
    - 五种帧：`snapshot`（id = `<bootId>.<jseq>`，整份收件箱视图）、`status`（自带 `srev`，不进 journal）、`tick`（每 5 s，带 jseq 和 serverWall，替换心跳注释；jseq 取这条流上最后交给 `res.write()` 的快照）、`notify`、`bye{shutdown|superseded|replaced|backpressure}`；后四种不带 id。`delta` 只在 `shared/protocol.js` 里留形状，M0 不发。
    - 每条连接的第一帧都是快照；不认 `Last-Event-ID`，删掉从数据库补发（−0.2 d）。之后每批提交改了视图或记下人类动作，就编码一份快照（所有流共用，没有流不编码），在提交之后写。
    - `server/view.ts` 是唯一的 ItemView 编码器：verbs、`title{key,args}`、notify 状态；源里来的任意文字不进帧（你自己写的提醒文字除外，≤120 个码点，带 `textState`，放在 `ItemView.reminder`）。标题 args 套 `shared/protocol.js` 的正则（工具名、版本、cwd 末段；含 Cf 或双向控制字符、超长的不用，换成「未知」或项目短 id），`project.name` 默认是 cwd 末段，在快照、notify 帧和 toast 里都过同一个检查，过不了换成项目短 id；你在 Tuning 里改过的名字不过 cwd 末段那道检查，改过 `PROJECT_NAME_RE`（1–64 个码点，不含 Cc/Cf/Cs/Zl/Zp 类字符，可以有路径分隔符）；cwd 末段仍限 32 个码点（`CWD_TAIL_RE`，超了不截短，换成项目短 id）。帧里每个 `project.name` 都要过 `PROJECT_NAME_RE`，cwd 末段本来就过得了（UI 设计第一节 2）。条目超过 500 条时多出的条数记在 `clipped`（不叫 truncated：扫描规则 `ban:truncate` 在 src、shared、ui 里禁这个子串）。D-17 选「发」时，ui-only 也发快照：`jseq: 0`，数组全空，计数为 0，带 `mode` 和 `modeReasons`。
    - status 帧里的源状态多一个「停摆」：nowMono − 这个源的 `lastPollMono` 超过 max(3 × 它的轮询间隔, 15 s)（推断：15 s 是 3 个 tick，免得 250 ms 轮询的源被一次 1 s 的事件循环卡顿误报；只用单调钟，不变量 20；墙钟跳变不影响，`lastPollWall` 只用来显示「自 hh:mm」）。每个 5 s tick 经 Clock 判一次，不进 journal。status 另带 `snippetRev`（片段被清除或过期删掉时加 1）和 `dshOrigin`（你粘贴的 `/connect` URL 的 origin，不带 token）。
    - 片段的定期清扫（`snippets.expire()`）跟着 tick 跑，间隔在本步定，清掉了就让 `snippetRev` 加 1；步骤 3 只做了读时生效和启动时扫一遍（约 0 d，推断）。
    - 5 s tick 和定期清扫是启动后的 orchestrad 里头一批常驻定时器，都用 `poll` 类：不写 clock 记录、不引起转换；poll 不写记录，seq 用内存里的计数，timerId 例如 `poll:sse-tick:<n>`（推断）。`TIMER_CLASSES` 由 contract-freeze 钉住，要新的定时器类就是 main 上的契约小提交。
    - 慢流只留最新一份快照，drain 时补发；流脏时 tick 和 notify 也不写，drain 时先写最新快照、再写排着的 notify、再恢复 tick。未发字节 >1 MiB 发 `bye{backpressure}` 并断开。`notify` 帧排在它依赖的快照之后，只发给一条流（最近可见的，没有就最新的；先跳过脏流）。
    - 每个配对会话最多 2 条活流，新的顶掉最老的（`bye{superseded}`）；被顶掉的 tab id 进墓碑（每会话 ≤64 个），再连得 409 `superseded-tab`（EventSource 读不到它，这个码给日志、测试和探测路径用；页面仍经 `GET /api/session` 的 `superseded` 知道自己被顶掉）。同一 tab id 再连只替换自己：旧连接得 `bye{replaced}`，不进墓碑。页面只在导航类型是 `reload` 时沿用 tab id，其余（新开、复制标签页、前进后退）换新 id。
    - 计数进 metric：快照字节与每分钟份数、`sse.coalesced`、`sse.drop`、`sse.superseded`、重连原因 `why`。快照字节 p99 >64 KB 或每流每分钟 >120 份，就是开 delta 的信号（推断：最晚 M2；r4:2099 的 A15 观察者协议是给主代理与 Maestro 的，M2/M3，附加项可削，r4:2549，不是给浏览器定的期限）。
  - 人类动词去重（`server/idempotency.ts`）：写 human 记录的 POST 必须带 `actionId`；按 (actionId, requestDigest) 去重，去重表启动时从 journal 的 `human` 记录重建（不能拿 journal 行的 `digest`：它盖了 actionId，重启后的正当重试会变成 422）；查重在追加 journal 之前做，0001 的部分唯一索引加 `INSERT OR IGNORE` 只是兜底（步骤 3）。`dsh-connect` 的 requestDigest 只盖路由、不盖 body，免得 token 的哈希落进 journal 和去重表（r4 §10.11 r4:1695）。刹车的 `human` 在检查顺序那一串都过之后、执行第 1 步之前写，`human.result` 等 Command 结果回来；其余动词两条在效果之后同批写（步骤 3）；刹车的 in-flight 由 procguard 每个请求的超时兜住（步骤 6），重启后由启动对账补的 `unknown` 结束。
    - in-flight 表：请求一过了去重那一格（还没做后面的检查），就把 (actionId, requestDigest) 登记进内存里的 in-flight 表，每个动词都登记；后面任何一格拒掉都算请求失败，当场删掉。`human.result` 那批提交时，在同一个同步回合里先把这个 actionId 记进去重表、再删 in-flight，中间不留两张表都查不到的空当。理由：`protect/*` 要 await procguard，`dsh-connect` 要 await fetch，非刹车动词的 `human` 要等效果做完才写，await 期间去重表里查不到这个 actionId；同 actionId 的重试会再做一次效果，409 `in-flight` 也永远不出现。去重那一格先查 in-flight 表、再查从 journal 重建的表。`dsh-connect` 的 fetch 经 Clock 有 10 s 超时（推断），超时也写 `human.result`（`outcome:'unknown'`：请求已经发给 DSH，不知道它收没收下，照 P1 判不明），in-flight 随之结束（步骤 15）。约 0 d；步骤 3 的两种记录何时写不变。
    - 错误码加两个（步骤 3 之后的决定，约 0.05 d，推断）：e451d4c 的人类动词路由把 body 形状的检查并在 actionId 那一格的 400 里，没有 actionId 的路由遇到坏形状回 400 不带码，SSE 墓碑的 409、64 KiB 和只收 JSON 的拒绝也都没有码（`server/routes.ts` 的 `CHECKS` 注释记着这个待定）。本步在 main 上单独提一个小的契约提交，加 400 `bad-request` 和 409 `superseded-tab`，同一提交改 `contract-freeze.test` 的金样（步骤 3 契约的冻结规矩，§4.1）。400 `bad-request` = orchestrad 收不下的任何请求：请求体不是 JSON 或 Content-Type 不对、超过 64 KiB，或请求体、查询参数过不了这条路由的形状检查，每条路由都一样；确切原因只进日志，页面只显示一句（例如「请求格式不对：页面和 orchestrad 版本可能不一致，重载页面」，推断），因为这几种页面的反应都一样。日志里的原因只是一个固定的枚举：`not-json`、`content-type`、`too-large`、`shape:<路径>`（路径只由路由形状里的字段名拼成，e451d4c 的 `shapeError` 本来就这样拼），从不记解析器的报错原文，也不记请求体的字节：V8 的 `JSON.parse` 报错会引用一段输入，dsh-connect 的请求体里有 `/connect` URL 和 token，而 `log.ts` 只认密钥类的键名和 `token=` 形式的值，认不出路径里的 token（不变量 14）。400 `actionId-missing` 只剩它自己的意思：没带 actionId，或格式不对。409 `superseded-tab` 见上面的 SSE 墓碑。
    - 检查顺序固定：鉴权 403 →（只在 D-17 选「发」时）503 `ui-only` → 读请求体（大小、只收 JSON、能解析）400 `bad-request` → 400 `actionId-missing` → 请求体形状 400 `bad-request` → 去重（原样回复 `replayed:true` / 409 `in-flight` / 422 `actionId-reused`）→ 404 `item-unknown` → 条目已结束记 `noop:already-ended` → 422 `verb-not-allowed` → 动词自己的检查（422 `text-too-long`；刹车的 503 `brake-unavailable`、422 `not-test-root`、409 `plan-expired`）→ 执行。已结束的条目没有动词，所以「已结束」排在动词检查前面。坏请求体到不了去重那一格，所以不占 in-flight 名额，也不留去重行。没有 actionId 的路由（pair、session、events、detail、brake/plan、notify-ack、client-state、tuning）跳过 actionId 那一格；请求体或查询参数过不了这条路由的形状检查（GET 路由查的是查询参数，例如 session 的 `tab`，events 的 `tab`、`perm`、`why`），同样回 400 `bad-request`。
    - 4xx 和 503 不写 journal。快照带最近 64 条结果 `recentActions`（只读 journal 尾部的 `human.result`，跨重启）。
  - `GET /api/items/:id/detail` 回 `{asOfJseq, item（含结束类）, peek{events, text, textState: present|expired|purged|lost}, open{…}}`；`GET /api/session?tab=` 回 `{csrf, bootId, mode, profile, liveStreams, superseded}`；`POST /api/notify-ack` 带 `phase: dispatched|shown|error`，交给 channel 的 `ack()`（步骤 5 实现：第一次 dispatched 只记到达时刻，这次尝试的 1.5 s 窗口过完、没来 error 才写 journal 设 `notifiedAt`）；shown 只进 metric。这几个形状在步骤 3 已定。
  - 本步结束时冻结 UI 契约的其余部分：`shared/protocol.js` 的帧与载荷形状（`SHAPES`、`FRAMES`、`ITEM_FIELDS`、`ENDED_FIELDS` 和造形状的 `S`，五个名字现在都标着 `step-4`，步骤 3 起就在这个文件里，contract-freeze 现在只钉它们的名字，本步结束时把形状树也钉进去）、行比较函数（枚举和正则在步骤 3 已冻结），以及 `shared/strings.js` 的 key。步骤 3 只是约定冻结、还没有金样的 `server/routes.ts` 路由表与形状、`shared/constants.js`、`model/source-report.ts`，也可以这时一起钉进金样（推断，§4.1 冻结点）。
- **r4**：§10.11 r4:1697–1702、§5.3 r4:593–595。
- **测试**：
  - `test/server/host-origin.test.ts`、`csrf.test.ts`。
  - `test/server/pairing.test.ts`：抓日志确认配对码不在里面；一次性；过期；5 次和 20 次的限制；不带 cookie 也能配对；HTTP 上没有发新码的路由。
  - `test/server/headers-csp.test.ts`（r4:595 原样；D-11 同意后多 `trusted-types 'none'`）、`no-cookie-403.test.ts`、`assets.test.ts`（只发经 `app-assets` 读进来的白名单路径，白名单外的路径被读闸门拒；index.html 没有内联脚本、`style=`、`on*=`、`<form`；polite、assertive 两个播报区节点在；ui/ + shared/ ≤80 KB）。
  - `test/server/sse.test.ts`：带不带 `Last-Event-ID` 第一帧都是快照；`snapshot.jseq == applied_jseq`，提交前没有任何帧；虚拟钟下每 5 s 一个 tick，`tick.jseq` 等于最后交给 `res.write()` 的快照；status、tick、notify、bye 没有 id；套接字堵住时连提交 10 批，drain 后只补发 1 份最新的，堵住期间不写 tick 和 notify，drain 后 notify 排在那份快照之后；金丝雀串（后面加一个 U+202E）埋在源文本、cwd 末段和工具名里，在快照、notify 帧和 toast 的 XML 里都出现 0 次；虚拟钟下停掉一个轮询器，max(3 倍间隔, 15 s) + 5 s 内 status 里这个源变「停摆」，同时把墙钟往回拨 1 h 也一样；事件循环卡 1 s（虚拟钟一次跳 1 s）不出「停摆」；>1 MiB 出 `bye{backpressure}`；没有流时不编码；`stop()` 发 `bye{shutdown}`；D-17 选「发」时另加：ui-only 下第一帧是 `jseq: 0`、数组全空的快照。
  - `test/server/sse-cap.test.ts`：第 3 条流顶掉最老的（`bye{superseded}`，进墓碑）；同一 tab id 再连只替换自己（旧连接得 `bye{replaced}`，不进墓碑，再连不得 409）；墓碑里的 tab 再连得 409 `superseded-tab`。
  - `test/server/view-parity.test.ts`：合成 journal 的每个前缀 k，用 db 编码的快照和删库、只从 journal 重建后编码的快照逐字节相同（canonical JSON）。不比：`status`、`serverWall`、`srev`、顶层 `bootId`，以及提醒的文字和 `textState`（片段表是旁表，删库后提醒文字变「已丢失」，由 `rebuild.test` 另测）。500 条时 ≤256 KB。
  - `test/server/idempotency.test.ts`：两种 400（`actionId-missing`、`bad-request`）、404、两种 422、409 各一例（503 视 D-17）；解析不了的 JSON → 400 `bad-request`；JSON 合法、actionId 合法、形状不对 → 400 `bad-request`，不是 `actionId-missing`（e451d4c 的 `routes.ts` 在这里回 actionId 那一格的 400），两例都是去重表里没有这一行、in-flight 也没登记；dsh-connect 的坏请求体里带一个金丝雀 token → 400 `bad-request`，日志里这个金丝雀出现 0 次；同内容重复回同一个结果、只有 1 条 human 记录；重启重建后去重照样生效，同 actionId、同内容的重试得 `replayed:true`、不得 422（坏样本：拿 journal 行的 `digest` 重建去重表，这一例必须变红）；刹车只有 `human` 没有 `human.result` 时重启，补出 `outcome:'unknown'`；journal 里塞一条没有结果的 `protect/add` 的 `human` 再重启，也补出 `unknown`，同 actionId 重试得原样回复的 `unknown`，不得 409；非刹车动词正常走一次，`human` 和 `human.result` 在同一批；标记类的 `human.result` 和它的转换在同一批；两个并发的 `protect/add` 带同一个 actionId（第一个还在等假 procguard）→ 效果只做 1 次，第二个得 409 `in-flight`（坏样本：去掉 in-flight 表，这一例必须变红）；已结束的条目得 noop；竞态一例：页面画出条目后、POST 到达前自动清除先提交，结果是 `noop:already-ended`，不是 422；journal 里人为塞一条重复 actionId，apply 和全量重建都不失败、记一次 `journal.dupAction`；`dsh-connect` 的 human 记录里查不到 token，也查不到含 token 的 body 的哈希。
  - `test/store/store-access.test.ts`：server 拿到的东西里没有能写的句柄（组装处 `working.ts` 手里有 DbOpener、能开写者连接，那是组装处本来的权力，不归这条测试管）：Store 上没有 `db`（`'db' in store` 为假）；只读视图是冻结的，自有键正好是那几个读方法（金样），没有 run、exec、transaction、checkpoint，方法不收 SQL 文本，回的行是冻结的普通对象，不是 Db 或语句。坏样本：把 `db` 改回公开字段，或让视图把 Db 递出去，这一例必须变红。
  - `test/server/detail.test.ts`、`test/server/notify-ack.test.ts`（参数校验；三种 phase 原样转给 channel 的 `ack()`，用假 channel；shown 只进 metric）。回执窗口和 `notifiedAt` 的两种先后、「error → 转 toast、标回执失败」都在步骤 5 的 `channel.test`。
  - 每条新测试先用故意做坏的样本证明能命中（P7）。
- **手动**（在测试 profile 下，实现会话可以做）：
  - 用 curl 不带 cookie 调 `brake/execute`，应得 403。
  - 从 `127.0.0.1:5173` 的页面发 fetch，应被拒。
  - 在浏览器面板里确认 `isSecureContext` 为真，请求带了 `Sec-Fetch-Site`。
  - 你自己的浏览器（代-3）在你第一次启动真实 profile 时再看一次。
- **推进验收**：AC8。

**步骤 5　收件箱页、渲染规则、刹车弹窗、通知路由、Tuning 骨架**（2.9 d，线 B；原 2 d，UI 第一轮 +0.6 d，第二轮 +0.3 d）
- **建什么**：
  - 页面：
    - 配对页（浮层），带「允许通知」按钮；配对成功后 `location.reload()`。
    - Program 页：项目 chip、harness 颜色、「observed」徽标、存在时长；Peek 只显示纯文本（取自 detail，过期、清除、丢失各有字样）。一行 28 px，分组头中文在前；空态和降级态各有自己的 `data-state` 和一句话；稍后的条目和待触发的提醒在底部折成一行计数（UI 设计第四节）。Peek 开着时跟随选中：选中变化 150 ms 后才取 detail，用 AbortController 取消上一个，同时至多 1 个 detail 请求在途；status 的 `snippetRev` 变了也重取。
    - 「现在没有要你处理的事」只在页面 live、新鲜（最后一帧 ≤20 s）、各源都正常时显示；有源出错或停摆时空态换成「没看到要你处理的事，但 <源> 出错，可能看漏」，并且不管列表空不空，页头下一行都有琥珀色的源健康条「收件箱可能不完整：<源> 出错 · 自 hh:mm · g t 去 Tuning」（挑战稿的提议，约 0.05 d）。
    - 测试 profile 时页面顶部常驻 `TEST PROFILE`；页面标题、浏览器通知和 toast 的标题都加「[测试]」前缀（`shared/strings.js` 按 profile 拼）。ui-only 的琥珀色横幅视 D-17，推荐默认下不做；down 态写「连不上 orchestrad（原因见启动它的控制台）」。
  - 状态与连接（UI 设计第一节）：`ui/store.js` 纯 reducer，只认快照、status、tick，页面不存权威状态；`ui/conn.js` 七态机（connecting、live、stale、down、refused、unpaired、superseded），每次开流之前先经 `ui/api.js` 的 `getSession` 取 `GET /api/session?tab=`（CSRF 令牌、bootId、superseded），拿到 200 才建 EventSource，重载和重新配对后也一样；重连只由它发起：任何 `error` 事件、任何 `bye` 都先 `es.close()`（网络出错时 EventSource 停在 CONNECTING 自己重试，会绕开退避），然后 `error` 立刻探测一次、`bye{shutdown}` 1 s 后探测一次，探测 5 s 没回复算 down，200、403 以外的状态码或「200 后流在快照前又失败」进 refused（5–30 s 退避），`bye{backpressure}` 1 s 后重开，`bye{superseded}`、`bye{replaced}` 不重连；新鲜度（最后一帧距今）和连接状态分开算，超过 20 s 时任何状态下都显示「[未更新]」；`ui/clock.js` 是 ui/ 里唯一能读时间、碰 `performance` 的文件，displayNow = serverWall + 单调钟差，也由它读导航类型；`ui/prefs.js` 是唯一碰浏览器存储的文件（tab id，只在导航类型是 `reload` 时沿用；单键开关；待定动作表）；`ui/api.js` 是唯一的 fetch（第一个参数以 `/api/` 字面量开头），只导出具体的帮手（`getSession`、各动词、`ackDispatched`、`ackShown`、`ackError`、`sendClientState`、配对和 dsh-connect 的提交），不导出通用的 `post(url)`，CSRF 令牌只放模块内存。
  - 渲染（UI 设计第二节）：`ui/view.js` 纯函数描述符；`ui/dom.js` 是唯一写 DOM 的文件：`<template>` 克隆，只写 `textContent`、`dataset`、`classList`，按 itemId 的 Map 复用节点，`moveBefore`（没有就 `insertBefore`），焦点在列表上时不重排（新条目排到分组末尾，按 `j`/`k` 或焦点离开时才重排，D-12 ④），roving tabindex；可见时一帧一次 rAF 渲染，隐藏时不渲染。另写 `test/helpers/fake-dom.ts`（约 120 行，碰 innerHTML 类写入点就抛错）。
  - 动词与 chip：写 human 记录的 POST 带 actionId（动作发生时生成：按键、点击、点通知，或 seen 停留计满的那一刻，同时记下 itemId）；chip 只在流里的 `recentActions` 出现它时才变「已生效」；409 `in-flight` 显示「仍在处理」，chip 留着、钟重新计；标记类 5 s、刹车执行 15 s 没结果显示「还没收到结果 · 查看」（同 actionId 重试是安全的）；bootId 变了还没结果显示「还没收到结果 · orchestrad 重启过」；「刹车结果不明」只留给刹车的 `outcome:'unknown'` 或子树 `status:'unknown'`，和「还没收到结果」文字不同（P1）；非刹车动词的 `unknown`（dsh-connect 超时，步骤 15；或启动对账补的，按构造不出现）写「结果不明」；从不自动重试，手动重试沿用同一个 actionId。
    - 待定表经 `ui/prefs.js` 存进 sessionStorage（`{actionId, verb, itemId, bootId, sentWall}`），因为 daemon 重启后页面要走 403 → 配对 → `location.reload()`，模块内存会清空。重载后第一份快照到了再对 `recentActions`；超过 10 分钟的丢掉；存储不可用时这些 chip 随重载消失。
    - 刹车结果分五种，按这个先后看：`outcome:'unknown'` 或有子树 unknown →「刹车结果不明」；有子树 refused →「没刹 n 棵」（daemon 没动手）；有残留 →「部分残留」；每棵都是 ok 且残留 0 →「已刹车 n 个进程 · 0 残留」；「计划过期」是 409 `plan-expired` 的回复。五种文字两两不同（UI 设计第一节 2、第三节 3）。
  - `ui/commands.js` 命令表生成快捷键映射、选中行的提示（只列 `item.verbs` 里有的）、底部图例和 `?` 帮助层。
  - `ui/hotkeys.js`：写成纯函数。`isComposing`、`keyCode` 229、key `Process`、`e.repeat` 一律忽略；焦点在输入框里、或不在列表和 body 上时单键不认；按着 Ctrl/Alt/Meta 时忽略；`K` 判断 `shiftKey`。新键 `n`、`e`、`?`、`g t` 和别名（D-12）；动词绑定按键那一刻的 itemId；一份新快照改了选中行的 id、位置或 verbs 后 750 ms 内 `e`、`K` 不响应；条目结束后自动改选的行上，`e`、`s`、`r`、`K` 都不响应（提示「先按 j/k 选一条」），直到你用 `j`/`k`、方向键或点击自己选一行（M0 的动作都撤不回；D-12 ⑤）；Tuning 有单键开关。
  - seen（D-16 推荐默认）：你主动选中（j/k、方向键、Home/End、点击）后停留 ≥500 ms，或 peek、打开、点通知（§2.2 第 13 条）。载入默认选中、hash 落地、自动改选都不开始计时。停留计满时由 `ui/api.js` 生成 actionId；点通知时在点击处理函数里生成。
  - 输入法：列表上 2 s 内 3 次 229 显示一次提示；输入框在 `compositionend` 后 50 ms 内的 Enter 不提交，Ctrl+Enter 总能提交（刹车弹窗除外）。snooze 用数字预设加 datetime-local，不做键入时长解析。
  - 路由只用 hash（`ui/route.js`，唯一能开窗口或导航的文件）；DSH 会话页的 origin 必须和 status 的 `dshOrigin` 完全相同，路径按会话页前缀加会话 id 正则校验（前缀在步骤 15 照 DSH 实际 URL 定），随便一个回环端口不行（r4:1699、r4:2257）；`#/item/<id>` 不在收件箱时取 detail 显示结束类。
  - P0：有未结的 P0 条目（open 或 seen）时，标题恒以「【P0】」开头、图标恒为告警图标，从状态推、不靠定时器；有 open 且没 seen 的 P0、窗口又没焦点时，再在此之上闪烁，直到 seen 或条目结束（闪烁只是装饰，约 0.01 d）。重载后、另一个标签页里也从状态推出这些标记；只有系统通知和读屏播报这种一次性效果才只由 notify 帧触发。图标由 `ui/dom.js` 在三个预先写在 `index.html` 里的 `<link rel=icon>` 节点（普通、告警、告警高亮）之间切换，闪烁只在后两个之间换，标题闪烁也只换「【P0】」后面的字；不写 `.href`（扫描只许 `ui/route.js` 写 `.href =`）；声音用系统通知自带的（D-13），不用 WebAudio。页头只显示通知权限，「本次启动已交给系统 n 条 / 未测」放 Tuning（D-15）。
  - `ui/kill-dialog.js`：按冻结的计划形状显示进程树：
    - 每个节点显示 pid、映像名、RSS、分类原因。
    - 默认勾 RSS 最大的子树，可以勾多棵。
    - 受保护节点和 harness 根旁边是确认输入框：键入该节点 PID，`inputmode=numeric`，先做 NFKC。
    - 弹窗头写 harness、项目、pid 和创建时刻。初始焦点在树上。
    - 弹窗里没有 `<form>`，不会隐式提交。「执行」是 `type=button`，只认点击和 Space；焦点在它上面按 Enter 被 `preventDefault` 拦下；PID 输入框里 Enter 和 Ctrl+Enter 什么也不发；`K` 不执行；弹窗出现后 750 ms 内点击和 Space 也不执行。
    - 倒计时 = min(`expiresAt` − displayNow, 60 s − 回复到达后页面单调钟走过的时长)，两项都经 `ui/clock.js` 读；`expiresAt` 是墙钟那一侧的到期时刻（计划生成时 +60 s）。取小的那个，所以 daemon 墙钟往回拨时倒计时也拖不过 60 s，和 daemon 判过期的两只钟一致；过期显示「重新生成」。daemon 判 409 `plan-expired` 时单调钟和墙钟哪个先到点就算过期（步骤 3）。
    - 多会话宿主显示「无法安全刹车」和替代做法。
  - `ui/notify.js`：
    - 收到 SSE 的 notify 帧，同步调 `new Notification(title, {tag: itemId, requireInteraction: P0, renotify: P0 且 attempt>1})`，紧接着调 `ui/api.js` 的同步帮手 `ackDispatched(itemId, attempt, tabId)`（它用 `keepalive` 发 `POST /api/notify-ack`，报 `phase:'dispatched'`，不返回 promise），中间不 await、不等 rAF；系统 `show` 事件经 `ackShown()` 报 `phase:'shown'`，`error` 事件经 `ackError()` 报 `phase:'error'`。`notify.js` 自己不调 `fetch`（扫描只许 `ui/api.js` 出现它）。回执点是 D-15 的推荐默认。tag 取 itemId，同一条目补发多次也只叠成一条（补3）。条目结束或稍后才 `close()`，seen 不收回；点击跳到 `#/item/<id>` 并发 seen。标题和正文由 `shared/strings.js` 按 `{key,args}` 拼，和 toast 同一份；低置信类的标题带「推测」，测试 profile 下带「[测试]」。系统通知和读屏播报只由 notify 帧触发，不从快照差异推。polite、assertive 两个播报区空着写在 `index.html` 里，载入时就在。
    - `POST /api/client-state {tabId, visibility, frozen, permission}` 只在变化时发：流打开、visibilitychange、权限变化、`freeze`、`resume`、`pagehide`（经 `ui/api.js` 的 `sendClientState(state, {keepalive})` 发，`freeze` 和 `pagehide` 时带 `keepalive`）。不用 setInterval：隐藏 5 分钟以上的标签页里定时器会被压到每分钟一次。可选的 `perf` 字段（步骤 19）只随变成隐藏和 `pagehide` 那两次发。
  - `notify/channel.ts` 的实现：
    - 「可通知的在线客户端」= SSE 流开着、没冻结、通知权限是 granted、没标「回执失败」。notify 只发给一条流：最近可见的那条，没有就最新的那条。
    - 有这样的客户端：发 notify 帧；1.5 s 内没收到回执，或收到 `phase:'error'`，就转给 toast（经 ToastPort，步骤 17），并把这个客户端标成「回执失败」。标记的出口：同一个 tab 发来 `visible` 且没冻结的 client-state（包括 resume），或这条流重连，就清掉；带标记时 Tuning 的通知面板写「此标签页暂不接收通知」。（原来写「直到它下一次回执成功」，可带标记的流不再收 notify，永远等不到那次回执。）
    - 没有这样的客户端：直接交给 toast。
    - 提交时刻按 §2.2 第 13 条记：dispatched 回执到了先记下到达时刻，这次尝试的 1.5 s 窗口过完、没来 error，才写一条 journal 记录、设 `notifiedAt`；toast 路径在 `shown` 到了时写。P0 用 `requireInteraction`。
    - 至少一次投递（补3）：通知只在条目那批记录提交之后才发。启动时，`committedAt` 有值、`notifiedAt` 为空的条目（状态还开着）重新走一遍路由，tag 不变。宁可多弹一次（会叠成一条），不会漏。
  - `shared/sanitize.js`：在出口（API、SSE、控制台、toast）剥掉 C0/C1/ESC（Peek 保留换行和制表符）；单字段 2 KB；UUID 正则。它拦不住零宽和双向控制字符，所以进标题的 args 另按 `shared/protocol.js` 的正则查（步骤 4 的 `server/view.ts`）。
  - `ui/` 扫描规则扩展（加进 `test/helpers/scan-rules.ts`，UI 设计第五节）：禁 `DOMParser`、`createContextualFragment`、`setHTMLUnsafe`、`parseHTMLUnsafe`、`srcdoc`、`execCommand`、`Worker`、`SharedWorker`、`importScripts`、`setAttribute('on…')`、`setAttribute('style')`、`cssText`、`WebSocket`、`XMLHttpRequest`、`sendBeacon`；`EventSource` 只许在 `ui/conn.js` 且带 `/api/events` 字面量；`fetch` 只许在 `ui/api.js`；时间 API 只许在 `ui/clock.js`；浏览器存储只许在 `ui/prefs.js`；`window.open`、`location.assign`、`location.replace(`、`location =`、`window.location =`、`document.location =`、`location.href`、`.href =`、`setAttribute('href'` 只许在 `ui/route.js`（`location.hash =`、`location.reload()` 不算；P0 图标换节点，不写 `.href`）；ui/ 里不许 `<form`（`*.html`）和 `createElement('form')`；输入框不带 `name`（规则 `ui:input-name`：`ui/*.html` 里带 `name=` 的 `<input`、`<textarea`、`<select` 和 ui/*.js 里的 `setAttribute('name'` 都算，`<meta name=…>` 不算，反例就用它；约 0 d）；配对和 dsh-connect 只经 `ui/api.js` 的帮手提交（模块没载入时原生表单会用 GET 把配对码或 token 放进 URL）；`ui/*.html` 不许内联脚本、`style=`、`on*=`；`shared/strings.js` 里不许出现「完成」。现有的 `ban:truncate` 对 ui/ 和 shared/ 也生效，字段、函数名一律不用这个子串（用 `clipped`、`clip()`）。现有的 `fetch`、`EventSource`/`WebSocket`、`.constructor` 禁令管的是 `src/`、`shared/`、`scripts/` 全部（不只 `shared/`），连注释也算：新写的 `server/sse.ts`、`notify/channel.ts` 等注释里写「SSE 客户端」「浏览器的推送连接」「保活请求」。
  - Tuning 骨架：启动模式与原因、自检结果、CapabilityRegistry 静态表、保护名单、通知面板（「本次启动已交给系统 n 条 / 未测」，带「回执失败」标记的标签页写「此标签页暂不接收通知」）；`ui/tuning.js` 在 `status.tuningRev` 变了时重取 `GET /api/tuning`。
- **r4**：§11.1–11.2、§11.9、§5.3 规则 1–5、r4 D8、r4 D10 r4:494、r4:2098、§10.5 #1。
- **测试**：
  - `test/ui/hotkeys.test.ts`（加：229、Process、repeat、焦点不在列表、itemId 按键时绑定、750 ms 由新快照触发而不由你的 j/k 触发、自动改选后 `e`/`s`/`r`/`K` 都不响应直到你按 j/k 或点击、seen 停留只在主动选中后开始计（载入默认选中、hash 落地、自动改选停多久都不发 seen）、每个作用域一键一义、Enter 不绑破坏性动词）、`test/ui/static-render.test.ts`（描述符，也就是原步骤 19 的 I20 结束类用例：每个 kind × state × conf × 结束类（自动结案、late、未送达等）的 `data-*` 和文字都不同，相同对数 0；各空态、降级态两两不同，空列表 × 每个非 live 或不新鲜的状态都不含「现在没有要你处理的事」；源出错、源停摆的空态和源健康条各一例；「还没收到结果」「刹车结果不明」「结果不明」两两不同；刹车的五种结果（已刹车 · 0 残留 / 部分残留 / 没刹 n 棵 / 计划过期 / 刹车结果不明）文字两两不同；「完成」0 次；行提示 = 命令表 ∩ `item.verbs`）、`test/shared/sanitize.test.ts`、`test/server/xss-osc-fixture.test.ts`。
  - `test/ui/store.test.ts`（输入深冻结不被改；旧 jseq 丢弃；bootId 变了出重启横幅、未决 chip 变「还没收到结果 · orchestrad 重启过」；409 `in-flight` 显示「仍在处理」、chip 留着；待定表从 sessionStorage 读回后，重载前发出的动作照样能对上 `recentActions`；`tick.jseq` 对不上算缺口；chip 只由 `recentActions` 清，不由 HTTP 200 清；刹车的五种结果各拼对一次，几种子树状态同时出现时按 unknown > refused > 残留 > ok 取）、`test/ui/conn.test.ts`（驻留表：每个状态都有钟或闸；session 回复到之前不建 EventSource（打开、重开、重载后都是）；20 s 没帧 → stale；任何 `error` 和任何 `bye` 都先关流，之后没有浏览器自己的重连；`error` → 一次探测，`bye{shutdown}` → 1 s 后一次探测；403 → unpaired（拿没拿到过 bootId，文字不同），网络错误或 5 s 没回复 → down 并按 5–30 s 退避，200 → 重开，200 后流在快照前又失败或其他状态码 → refused 并退避；`bye{backpressure}` → 1 s 后带 `why=backpressure` 重开；`bye{superseded}`、`bye{replaced}` 不自动重连；同时只有一个探测；最后一帧超过 20 s 时 connecting、down、refused、unpaired 下都带「[未更新]」）、`test/ui/prefs.test.ts`（导航类型是 `reload` 时沿用 tab id，其余换新 id，模拟「复制标签页」时两个标签页 id 不同；存储抛错时不崩）。
  - `test/ui/dom.test.ts`（fake-dom：重排保留节点和焦点；焦点在列表上时来一份改了次序的快照，行序不变、新条目排在分组末尾，按 `j` 或焦点离开后才重排；rev 没变写 0 次；改 1 行时 100 行和 1,000 行的 DOM 操作都 ≤10 次；碰 innerHTML 类写入点抛错）、`test/ui/notify.test.ts`（返回前已发回执，rAF 永远不触发也一样；renotify 只给 P0 重发；结束或稍后才 close，seen 不 close；点击设 hash 并发 seen；show 事件经 `ackShown` 报 shown；P0 未结时任何闪烁相位下标题都带「【P0】」，重载后也带；测试 profile 下通知标题带「[测试]」；Peek 纯函数部分：连按 10 次 `j` 只发 1 个 detail 请求）、`test/ui/ime.test.ts`、`test/ui/route.test.ts`、`test/ui/load-pure.test.ts`（除 `app.js` 外每个 ui/*.js 在 Node 里 import 不碰 document）、`test/shared/strings.test.ts`。
  - `test/repo/static-scan.test.ts`：每条新 ui 规则一个正例一个反例。每条新测试和规则先用坏样本证明能命中（P7）。
  - `test/notify/channel.test.ts`（接假的 ToastPort）：
    - 1.5 s 内回执 → 不出 toast。
    - 没回执 → 出 toast。
    - 冻结的客户端算离线。
    - SSE 流断了立刻算离线；权限被拒算离线；没冻结、流开着的隐藏标签页过 10 分钟虚拟时间仍算在线；notify 只发给一条流。
    - 「回执失败」：error 回执 → 立刻转 toast 并标上（从步骤 4 的 `notify-ack.test` 挪来）；这个 tab 发来 `visible` 且没冻结的 client-state、或重连 → 清掉；带标记时 Tuning 写「此标签页暂不接收通知」。
    - 回执时间记进 metric。dispatched 之后安静过完 1.5 s → 写 1 条 journal，`notifiedAt` = 回执到达时刻；dispatched 之后 1.5 s 内来 error → 不写、不设，`notifiedAt` 由 toast 的 shown 设；之后的 dispatched 写 0 条。
    - 在条目提交之后、通知发出之前杀掉 daemon，重启后：通知恰好补发 1 次、tag 等于 itemId，InboxItem 仍是 1 行；`notifiedAt` 已有值的条目不补发。
  - `test/ui/kill-dialog.test.ts`：纯函数部分，包括默认勾选、什么时候要确认、多会话宿主不可选、焦点在「执行」上按 Enter 什么也不发而按 Space 执行、PID 输入框里 Enter 和 Ctrl+Enter 什么也不发、`K` 到不了「执行」、弹窗出现后 750 ms 内点击无效、PID 先做 NFKC、倒计时取 min(`expiresAt` − displayNow, 60 s − 回复后的单调钟时长) 且过期后显示「重新生成」（一例：回复之后 serverWall 往回跳 1 h，倒计时仍在页面单调钟 60 s 时走到 0）。
- **手动**（测试 profile，实现会话的浏览器面板或你）：用 XSS/OSC fixture 打开页面，确认显示的是字面文本、没有 alert、控制台没有 CSP 违规、剪贴板没变。另外：停掉 daemon（进程退出）5 s 内显示「连不上 orchestrad」（error → 关流 → 一次探测 → 网络错误），记下实际用了几秒（推断约 2–4 s、未测：Windows 连一个关着的回环端口约 2 s 才被拒，::1 和 127.0.0.1 各试一次；门槛是 5 s 加一次渲染，探测按 5 s 超时判成 down 也算过），之后探测按 5–30 s 退避；重启后显示配对页，不转圈；DevTools 断网 20 s 出现「数据截至 … · jseq N」；开 3 个标签页，最老的显示「在此使用」；刹车弹窗里按 Enter 什么都不发生；点通知落到 `#/item/<id>` 并记 seen；标签页隐藏 6 分钟后仍收得到通知。
- **推进验收**：AC8（渲染部分）、AC3（条目与浏览器路径）。

**步骤 6　procguard 与刹车**（2 d，线 C，假定第 5.6 天起（还没开工，见 §4.1「线 C 还没开工」）：第 2b 步改了 WriteIo（writeAtomic 的 close、rename 走注入的 io）和停法（停下就结束进程），2c 改了 WriteFence 能力和进程能力，要等它们做完；落库部分要等步骤 3 的 0001，排期上在第 8.0 天后做；Clock 端口已随步骤 3 提交（e451d4c），本步直接用它写请求超时（`deadline` 类）和计划过期（`planExpired`），不用再先照接口写、再接上；天数照估时不改，见 §4.1）
- **建什么**：
  - `native/procguard/ProcGuard.cs`：
    - M0 编译进去的命令只有 `ping`、`self`、`snapshot`、`alive`、`kill-tree`、`protect`，以及步骤 15 加的 `notif-state`。
    - `snapshot` 支持 `under`/`pids` 过滤，`cmdline` 默认 false，加 `image` 字段（完整路径）。
    - Job 类命令和一次性模式包进 `#if M1`；删掉 `legacyInherit`、`holdMs` 这类测试旋钮。
  - 相对 spike 版的三处改动：
    - `dryRun` 不再在遇到受保护节点时直接返回 `Err('protected')`，而是返回 `{plan, protected, pruned, wouldRefuse}`。非 dryRun 照旧拒绝。
    - `protect` 和 `--protect` 改为接收 `pid:createTime`，两者都对上才算。
    - 受保护宿主补上父链规则。
  - `scripts/host-signatures.ts`：做一次只读快照，核对 DS-Bot 桌面版和 Claude Desktop 的签名。输出只有映像完整路径、父进程映像链、命令行里的开关名，值一律换成 `<v>`。结果作为 config 默认值写进代码。
  - `os/procguard-build.ts`。
  - `os/procguard-client.ts`：
    - 只发这七个命令：`ping`、`self`、`snapshot`、`alive`、`kill-tree`、`protect`、`notif-state`，其他一律拒绝。
    - 请求按 id 配对；刹车调用串行执行；orchestrad 一直开着 procguard 的 stdin。每个请求 10 s 超时（暂定，经 Clock 端口的 `deadline` 类，timerId `deadline:<requestId>:<seq>`；和 SpawnGate 在同一个 hub 上，deadline id 不能和它的撞：用第 3b 步（fd35af0）的同一个分配器：`clock.ts` 的 `tableSeq(clock, name)` 按计时表编号，不按 hub（clock.ts 造出的任何 Clock 背后都有一张表，套一层包装或 Proxy 的 hub 也只算一次）；SpawnGate 用的名字是 `spawn-run`，timerId 形如 `deadline:spawn-<n>:0`；procguard 在组装处造给它的那个 Clock 上调 `tableSeq`，用自己的名字（例如 `procguard-request`，名字推断），不另加前缀；时限在发请求之前先挂上，挂不上（schedule 被拒）就不发请求；不写 clock 记录、不引起转换；Clock 由组装处从 hub 造好递进来）：kill-tree 请求超时的那棵子树记 `status:'unknown'`（执行第 1 步核对用的快照超时记 `refused`：那时 daemon 还没动手），整次动作照常写 `human.result`，人类动词的 in-flight 因此有钟（UI 设计第一节 5）。`protect/*` 遇到 procguard 超时算请求失败（没有子树可记 unknown；推断）：回 503 `procguard-timeout`（推断；页面显示「保护名单没改成，可重试」，错误码进步骤 3 冻结的全表），不写 journal，删 in-flight，同 actionId 重试会再做一次（按自然键写，无害）。
    - procguard 崩了就退避重启。启动时用 `--protect` 带上 `protect_entry` 里的名单，每次收到 `ready` 后再补发 `protect`。收到确认之前，刹车接口返回 503 `brake-unavailable`，UI 显示「刹车不可用」。
    - 按快照把 createTime 已对不上的条目挑出来：之后不再带给 procguard，表里不删，Tuning 标「已失效」，你点「移除」才经 journal 删（§2.2 第 15 条，推断）。这里不直接删行：步骤 4 起只有 journal 追加 + apply 写投影表。
  - `brakes/kill-tree.ts`：
    - **出计划**：
      1. 调 `snapshot{under: harnessPid}`，按「子进程创建时间 ≥ 父进程」重算安全树。harness 自己 createTime 读不到时，整个弹窗拒绝。
      2. 对每棵候选子树的根，调 `kill-tree{pid, createTime, includeRoot:true, dryRun:true, confirm:[根令牌]}` 拿分类结果。
      3. 只对你选中的子树再要一次命令行（`snapshot{pids, cmdline:true}`），先脱敏、截到 2 KB，才落库和发给页面。
      4. 计划记成一条 `brake.plan` journal 记录（形状在步骤 3 冻结）：`{planId, harness, roots, nodes（1–4096 个）, protected, createdMono, createdWall, ttlMs: 60000, expiresAt}`，进程都是 `{pid, createTime}`，roots 是弹窗里可选的子树根，`expiresAt = createdWall + 60 s`，60 s 有效。过没过期调步骤 3 的纯函数 `planExpired(plan, planBootId, now)`：planBootId 是写计划那次启动的 bootId，换了启动就算过期；同一次启动内两只钟都算，`createdMono + ttlMs`（单调钟）和 `expiresAt`（daemon 墙钟）哪个先到就算过期；墙钟往回拨拖不长计划，往前拨只会让它提早过期（P4）。`expiresAt` 也随计划回复发给页面做倒计时。
    - **执行**：
      1. 重新取快照，确认选中的根仍是同一个 harness pid:createTime 的后代，且它本身不是宿主。核对没过的子树（harness 被替换、根不再是它的后代、根成了宿主，或这次快照超时）记 `status:'refused'`、killed 0，不调 kill-tree。这时 `human` 已经写了，所以不回 4xx，照常写 Command 和 `human.result`（步骤 3）；`refused` 的意思只有一个：daemon 没动手。
      2. 调 `kill-tree{pid: 选中根, createTime, includeRoot:true, confirm:[选中根的令牌（orchestrad 给）] + [你键入确认换来的受保护节点令牌]}`。
      3. 键入确认只在两种情况下出现：选中的是 harness 本身（只对单会话的 Claude CLI 开放）；或者子树里有受保护节点。
      4. 勾了多棵子树就逐棵执行。
      5. 每次执行写一条 Command，记下每棵子树的 requestId 和回执；执行结果按子树报 `killed`、`residual`、`status`（ok / partial / refused / unknown），带 `commandId`，进那次动作的 `ActionOutcome.brake`（步骤 3、UI 设计第一节 2）。Command 和指向它的 `human.result` 写在同一批（同 actionId、同 subtrees，步骤 3 的 apply 会校验），崩溃拆不开它们。
    - 测试 profile 下，harness 根必须是登记过的测试根，否则返回 422 `not-test-root`。`TestRoots.check` 的 `unresolved`、`rejected`、`create-time-mismatch` 在 HTTP 上也都回 422 `not-test-root`，具体原因只进日志（推断）。这一格在检查顺序里，所以被拒的请求不写 `human`。
  - 测试根解析（第 2 步只建了登记表和匹配规则）：启动后经 procguard 的 snapshot 把每个 `--test-root-pid` 解析一次（`TestRoots.resolve`），解析之前测试 profile 下的刹车一律拒绝（`unresolved`，HTTP 上回 422 `not-test-root`）。解析时只在测试 profile 下、只对 `--test-root-pid` 那几个 pid 取 `snapshot{pids, cmdline:true}`；命令行只拿来比 fake-agent 标记，不落库、不进日志（不变量 14 的例外）。
  - daemon.json 补 createTime：procguard 给出 orchestrad 自己的 createTime 后，daemon.json 补写一次（每次启动最多两次）；`lock.test` 的「只写一次」改成「至多两次、停下时不写」。
  - 测试卫生：所有测试拉起的进程都打标记，teardown 时按 pid + createTime 清扫。
- **r4**：§10.5 r4:1599–1613、§10.3 r4:1580–1582、§13.2 S4 行、§5.2 procguard。
- **测试**（Windows Medium IL 下才跑）：
  - `test/procguard/build.test.ts`。
  - `test/procguard/protocol.test.ts`：stdin EOF 后自行退出（attached 和 detached 两种）；M0 二进制里没有 `run-in-job`；客户端拒发清单外的命令。
  - `test/procguard/kill-tree.test.ts`：
    - fake-agent 起 `cmd → ping -t` 再加一个 dev server，刹车后 0 幸存。
    - 假 claude 下面一棵类似 `rg.exe` 的子树，不键入令牌就能杀掉，兄弟进程都活着。
    - 选 harness 根时，不键入令牌就拒绝。
    - 测试 profile 下，解析过的测试根能刹；还没解析的根被拒，原因 `unresolved`。
  - `test/procguard/protected.test.ts`：只用合成进程表加 dryRun。覆盖 dsh web、Codex Desktop（还能列出它子进程的计划）、conhost 的两种情形；orchestrad 和 procguard 自己永不可杀。
  - `test/procguard/pid-reuse.test.ts`。
  - `test/procguard/protect-restart.test.ts`：登记一个保护 pid，杀掉 procguard，等它重启，对那个 pid 做 kill-tree 仍被拒；确认回来之前刹车接口返回 503。
  - `test/brakes/brake-api.test.ts`：包括计划过期（虚拟钟下墙钟往回拨 1 h，计划照样在单调钟 60 s 时过期；墙钟往前拨 1 h，计划当场过期、得 409 `plan-expired`）、harness 被替换（每棵子树 `refused`，照常有 `human.result`，页面显示「没刹」）、`not-test-root`（含 `unresolved`）、执行第 1 步的快照超时记 `refused`、kill-tree 请求超时记 `unknown`。
  - S4 的 run-in-job 用例（b/c/f/i）移到 M1，不在 M0 移植。
- **推进验收**：AC6；也是 AC11 和步骤 10、12 的前提。

**步骤 7　fixture 工具链、冻结树 diff**（1 d，线 C）
- **建什么**：
  - 合成写入方：
    - `dsh-writer`：每 200 ms 攒一批，一批一帧，带校验，按 `open('a') → write → fsync → close` 写。
    - `claude-writer`：写注册表 json 和 transcript 行。
    - `state5-builder`：用 `node:sqlite` 真建一个 WAL 库并保持连接。它还能做到两件事：触发 checkpoint 后在原地复用 WAL；连写多次而 WAL 大小不变。
  - `test/fixtures/scenarios/*.scenario.ts`：每个场景逐步列出「写什么」和「期望的状态变化」。期望由人手写，不从实现的输出录制。
  - `fixtures/golden/*.transitions.json`：给清洗过的真实抓取用，由人手写，带 `fixtureSha256` 和 `derivedBy: "hand"`。不提供任何自动更新命令。
  - `scripts/sanitize-fixture.ts`：保留结构和枚举类值；其余字符串换成确定性占位符；UUID 和路径重映射；时间整体平移；DSH 帧逐帧重新压缩。
  - 扫描测试：关键格式、熵检测、本地 denylist（`fixtures/local-denylist.txt`，已被 gitignore）。
  - `scripts/freeze-tree.ts`：
    - 经读闸门的生产策略，把真实根下的白名单文件复制到仓库外的 `%LOCALAPPDATA%\orchestra-frozen\<run>\`。这是这个脚本唯一允许写的地方。
    - 记录 sha256、大小、mtime 和目录清单；跑完对比零差异，并且不许新出现 `-wal`/`-shm`/`-journal`；diff 之后删掉副本。
- **r4**：r4:2377、§6.1 #3 r4:668、§14 #2、r4:2389③。
- **测试**：
  - `test/fixtures/scan.test.ts`：埋的秘密在运行时拼出来，不以字面值提交。
  - `test/fixtures/sanitize.test.ts`、`writers.test.ts`。
  - `test/zero-write/frozen-tree.test.ts`：先对一个空读取器跑。
  - `test/repo/hygiene.test.ts` 增加：`.gitignore` 对 `fixtures/` 默认拒绝；测试代码从不写 `fixtures/golden/`。
- **推进验收**：AC7③（合成版）；也是 AC1 的前提。

**步骤 8　vendor 词汇、归一化核心、状态机、边、回放**（1.5 d，线 C）
- **建什么**：
  - vendor（代-1）：
    - 先读 `docs/research/dsh-tui.md` 里记的本地克隆 `G:\_Projects\dsh-TUI`。
    - 用 `git -C G:\_Projects\dsh-TUI show 71f5ac93:<路径>` 取 `src/agent/*` 和 `src/adapter/ports/channel-{view,session}.ts`，放进 `vendor/dsh-tui/`。这样不受那边工作区改动影响。
    - `VENDORED.md` 记下提交号、文件清单和 sha256，附上 LICENSE；NOTICE 加 MIT 条目。
    - `src/` 只经 `import type` 引用。这些引用运行时会被擦掉，所以 vendor 文件里的 `.js` 后缀或 enum 永远不会执行。
    - 跑一遍 `dangerously` 扫描。
    - 只有当 `src/` 需要 `src/agent` 导出的运行时值时，才退回自己写 `model/vocab.ts`。
  - `model/part-state.ts`：状态集合 `starting/idle/running/requires-action/disposed`，带 `stateConfidence`。
  - `model/edges.ts`：形状取信封 v1，加 `observed: true`。
  - `model/symbols.ts`（I09）：判决点只认的一张小符号表。它是 AgentEvent 的投影，不分叉 AgentEvent。约 10 族：`part.seen/gone`、`turn.open{origin}`、`turn.close{结局}`、`ask.open/close`、`delivery.read`、`tool.call/result`、`child.open/close`、`usage`、`context.pressure`、`guard.native`、`anomaly`。
    - 每行写清谁消费、每家怎么映射、置信度。M0 没有产出方的行（`delivery.read`）照样列出，标「M0 无」。`turn.open` 的 origin 在 M0 一律填 `unattributed`；`turn.close` 的结局在 M0 只分「见到了原生结束标记」和 `unknown`，统一词表留到 M1。
    - 收件箱、状态机、检测器只吃符号（RSS 检测器除外，它读的是 procguard 快照）；完整 AgentEvent 只留给 Peek 和回放。
    - lint 告警：核心目录（`model/`、`detectors/`、`notify/`、`reminders/`、`brakes/`）里出现 harness 名（claude、codex、dsh、ds-bot）时，用 `t.diagnostic` 报出命中处，不判失败，不卡 M0 出口。已知会命中的有 DSH 原生守卫（步骤 12）；把它挪进适配器不在 M0 做。
  - 回放运行器：用虚拟时钟喂场景或 fixture，输出状态转换列表（每条带 cause），然后和场景里手写的期望或 golden 做 `deepStrictEqual`；fixture 的哈希对不上就失败。
    - 从 fixture 回放时，定时器由虚拟钟触发。从 journal 回放时，重跑状态机，喂 journal 里记下的源事件、`clock` 和 `human` 记录，不起真定时器，再和记下的 `transition` 逐条比。
    - 回放速度只改虚拟钟相对真实时间的快慢；所有计时判断都只看虚拟钟（I01）。
  - 延迟样本字段照步骤 3 的 Event 和 InboxItem：`srcSeq`、`srcTime`（只进「源侧」一段）、`obsMono`/`obsWall`、`committedAt`、`notifiedAt`；DSH 另记帧序号。另加 `prevPollMono`：上一次没读到这条数据的那次轮询，由各源的轮询器顺手填，供步骤 18A 把「源侧压住」和「我方采样」拆开（I06）。只是测量字段，不参与任何判定。
- **r4**：§3.1 原则 1 r4:428、§5.2 r4:552、§6.1、§6.2、§8.1 r4:917、§13.2 r4:2383、R02 r4:2808、r4 D12。
- **测试**：
  - `test/model/part-state.test.ts`、`edges.test.ts`、`test/replay/harness.test.ts`（同一输入回放两次，结果逐字节相同）、`test/repo/vendor.test.ts`（`src/` 对 vendor 只有 `import type`，文件的 sha256 与 `VENDORED.md` 一致）。
  - `test/replay/speed.test.ts`（I01）：同一 fixture 以 0.1×、1×、10× 回放，转换逐字节相同。
  - `test/replay/clock-mutation.test.ts`（I01）：从 journal 删掉一条引起转换的 `clock` 记录，回放必然分歧；每条 `transition` 都有 cause。
  - `test/replay/srctime.test.ts`（I04）：把 srcTime 整体平移、倒序、本地时与 UTC 混用，转换不变。
  - `test/repo/srctime-scan.test.ts`（I04，CI 断言）：`srcTime` 只许出现在 `sources/`（写入）、`store/`（落库）、`metrics/latency.ts`（标明来源的延迟）、`server/routes.ts`（展示）；核心目录（`model/`、`detectors/`、`reminders/`、`notify/`、`brakes/`）里一次都不许出现，所以它没法参与排序或计时。
  - `test/model/symbols.test.ts`（I09）：每个符号在每家 golden 回放里的覆盖率，由回放运行器顺带算出，只报告、不卡出口。`test/repo/core-harness-names.test.ts` 报 lint 告警。
- **推进验收**：AC1 的框架。

**步骤 9　DSH 源**（1.75 d，线 C）
- **建什么**：
  - `lib/zstd/frames.ts`：从 frame-tail.mjs 移植帧遍历器，不假设窗口大小。
  - `sources/dsh/frame-tail.ts`：
    - 游标停在最后一个完整帧之后，每次轮询都从游标读到文件尾。
    - 游标只和这几帧解析出的 Event 行一起提交（I02，步骤 3）：先解析、再整批提交，绝不在 ingest 之前先把块长加到游标上（spike 的 S1-DSH-06 正是这个错）。崩溃后从已提交的游标重读，按 (partRef, srcSeq) 去重。
    - 用 bigint 的 ino+dev 判断文件是否被替换；文件变短或被换，就从 0 重读并按 seq 去重。
    - 连续 3 次出错就重置；补上 spike 里缺的 ENOENT 等处理。
  - `sources/dsh/discovery.ts`，分两层：
    - 热集合：最近 24 h 内增长过的 v4 文件，最多 16 个路径。即使句柄已经关了，也每 250 ms `stat(path)` 一次，size 变了就开句柄、按 250 ms fstat。
    - 冷遍历：每 1 s 遍历一次 `sessions/--<cwd>--/{<uuid>|session-<uuid>}/`，只用来发现新文件，只匹配确切的 `session.v4.jsonl.zstd`。
    - 句柄 30 分钟没增长才关（暂定），同时最多开 16 个。
    - 只有旧版日志的目录计数后交给 Tuning 显示。
  - `workers/cold-decode.ts`：先遍历到游标，再对 `[0, cursor)` 一次性解压，出错就退回逐帧解压。只回填最近 24 h 内增长过的文件。
  - `scripts/dsh-sampler.ts`：经读闸门、在静态扫描范围内，只输出「type + 键名 + 值的格式」，不输出值。用它的输出手写合成 fixture。实现会话跑之前先问你一次。
  - `normalize-v4.ts`：
    - 把 `repeat-tool-reminder` 解析成证据；未知 type → `unknown`。
    - `subagent/catalog`、`subagent/descriptor` 和 `team/*` 事件生成边（r4:820）。
    - 工具输出的字节数供洪泛检测用。
  - 延迟埋点。
- **r4**：§7.1 r4:816/841、r4:2362、r4:2367、r4:2384、R02。
- **测试**：
  - `test/dsh/cursor-commit.test.ts`（I02）：解析后、提交前注入崩溃，重启后事件丢失 0、重复 0；游标永远不超过已提交的最后一帧。崩溃注入写成共用的 `test/helpers/cursor-commit.ts`，步骤 10、11、14 各加一例。
  - `test/zstd/frames.test.ts`、`test/dsh/frame-tail.poll.test.ts`、`test/dsh/discovery.test.ts`、`test/dsh/cold-start.test.ts`、`test/dsh/normalize-v4.test.ts`（包括边）、`test/dsh/handles.test.ts`。
  - `test/latency/dsh-live-append.test.ts`：除第 1–2 帧外全部 ≤2 s。
  - `test/latency/dsh-idle-resume.test.ts`：闲置超过关句柄时限后再追加，≤2 s。
  - `test/replay/golden-dsh.test.ts`。
- **推进验收**：AC1（DSH）、AC2（DSH）。

**步骤 10　Claude 根目录、注册表、需要输入**（1.75 d，线 C）
- **建什么**：
  - 第一件事：经读闸门读一个真实注册表文件，只看 `procStart` 的格式（不看其他值），和 procguard 的 createTime 比对。实现会话做之前先问你一次。
  - `roots.ts`：
    - 按 §7.1 第 1–5 步实现。
    - 每 60 s 用 procguard 快照（cmdline:false，靠 `image` 字段排除带 `app.asar` 的进程）检查一次完整性。
    - 进程起来不到 60 s 不算缺失；超过的标「未注册」（这个 60 s 经 Clock 端口计，标注时 cause 是 clock）。本步给这种标注加上它的实体，并把 `unregistered` 加进 `TRANSITION_CLASSES`（步骤 3 故意留在外面），两张冻结表在 main 上同一个小提交里改，contract-freeze 的金样同改。
    - 候选根要你确认后才加入，加入时再做一次数据目录检查。
  - `registry.ts`：
    - 每 1 s 读一次 `sessions/^\d+\.json$`，读完即关，绝不打开 `.key`。
    - 遇到写了一半的文件，保留上一份好的值。
    - 只保留这些字段：status、waitingFor、statusUpdatedAt、version、entrypoint、procStart、cwd、sessionId、name。
    - 判活用 pid + procStart；没有 procguard 时标低置信。
    - 每个会话上一次读到的 `statusUpdatedAt` 就是这个源的游标，和由它产生的 Event、条目同批提交（I02，步骤 3）。
  - `detectors/needs-input.ts`（I11：别人的时间戳只比相等）：
    - `statusUpdatedAt` 当不透明的版本号用，只和这个会话自己上一次的值比是否相等，从不和我们的钟比大小。它变了就是新的一段等待，即使 status 仍是 `waiting`。
    - 段键 (根, pid, procStart, statusUpdatedAt) 由 `registry.ts` 拼好，放进 `ask.open` 符号；检测器只看到一个不透明的键。新的一段开新条目，旧的一段自动结案；同一段不重复出条目。
    - status 变成 `waiting` 时生成 P1 条目并调用 `channel.notify()`。启动时已经在等的会话也要补条目。变回 busy/idle 就自动清除。
    - `missedTransitions` 计数：版本变了、却没看到中间状态的次数（例如两次读到的都是 waiting，版本却不同），在 Tuning 显示。
    - AC3 的「以 `statusUpdatedAt` 为准」只用在延迟报告的「源侧」一段，是标明来源的测量，不参与任何判定。
    - 上线前先用 S5 的被动轮询数据核一遍：如果 Claude 在同一次等待里也会刷新 statusUpdatedAt，就改用 waitingFor 加它的值来判断新的一段。
  - Tuning 的根目录控件：额外根、候选根确认、`extraHarnessRoots` 登记。
- **r4**：§7.1 r4:816、r4:827–839、r4:2385、r4 D10。
- **测试**：
  - `test/claude/roots.test.ts`。
  - `test/claude/registry.test.ts`：用 spy 证明 `.key` 从未被打开；`cursor-commit` 一例（I02，游标是 `statusUpdatedAt`）。
  - `test/claude/completeness.test.ts`。
  - `test/claude/needs-input.test.ts`：
    - 从 `statusUpdatedAt` 到 `notify()` 被调用 ≤1 s。
    - 读到 waiting(t1) 之后，200 ms 内这段被批准、又来一次审批 waiting(t2)，下一次轮询只看到 waiting(t2) → 2 条条目（第一条自动结案），`missedTransitions` = 1。
    - statusUpdatedAt 不变时反复读 → 不出新条目；把它改成比上次更早的值 → 照样算新的一段（只比相等）。
  - `test/latency/claude-registry-appear.test.ts`。
- **手动**（测试 profile）：用合成根造一个「等待中」的会话，在浏览器里真实弹出一次通知，并确认回执到了。
- **推进验收**：AC2（Claude）、AC3。

**步骤 11　Claude transcript、低置信条目、边**（1 d，线 C）
- **建什么**：
  - `transcript.ts`：每 1 s `stat` 一次，只读新增的 `[cursor, size)`，读完即关；半行留到下次拼接；文件标识变了就重置。游标与 Event 同批提交（I02，步骤 3）。
  - 取出 `tool_use` / `tool_result` 的配对、`permissionMode`，以及工具输出的字节数。
  - `subagents/*.meta.json` 按 `spawnDepth` 生成边。
  - 低置信条目：只给没有注册表等待信号的会话。条件是注册表 busy、最后一条是没配对的 `tool_use`、并且已静默 20 s。这 20 s 经 Clock 端口计，到点出条目时写一条 `clock` 记录，转换的 cause 是 clock(timerId)（I01）。这条规则写成纯函数导出（输入是符号序列和虚拟时刻），步骤 18A 的 `signal-rates` 用它在有注册表信号的会话上离线重算，得出低置信类的漏报和误报（I06）。
- **r4**：§7.1 r4:816、§10.12 r4:1753、r4:2385。
- **测试**：`test/claude/transcript.test.ts`（含 `cursor-commit` 一例）、`low-confidence.test.ts`、`edges.test.ts`、`test/replay/golden-claude.test.ts`。
- **推进验收**：AC1（Claude）、AC3（降级部分）。

**步骤 12　runaway v0、RSS 与洪泛**（1 d，线 C）
- **建什么**：
  - `detectors/runaway.ts`：
    - 键是（会话，工具名，归一化参数哈希），哈希前剥掉 PID、时长、cwd。
    - 120 s 内 ≥5 次就出 P0，附刹车按钮。
    - 事件到达时立即判定；同一阵重复只出一条。
  - DSH 原生守卫：第 3/5/8 次提醒出 P2；第 8 次之后精确重复仍在继续，才升 P0。
  - `detectors/rss.ts`：从 procguard 快照（cmdline:false）取工作集，按宿主归因。阈值按 §2.2 第 12 条出 P0，列出该宿主上的会话。物理内存由 `main.ts` 用 `os.totalmem()` 读出后传进来。
  - `detectors/flood.ts`：按 §2.2 第 12 条出 P2。
- **r4**：§10.3 r4:1564–1574、§10.12、R07、r4:2375、r4:2387。
- **测试**：`test/detectors/runaway.test.ts`、`dsh-native-guard.test.ts`、`test/runaway/live-append-{claude,dsh}.test.ts`（≤10 s 出 P0）、`test/detectors/rss.test.ts`（超过上限、60 s 内涨 1 GB、不到阈值不报）、`test/detectors/flood.test.ts`。
- **推进验收**：AC5；AC11 的采样部分。

**步骤 13　一次性提醒**（0.75 d，线 B）
- **建什么**：`reminders/scheduler.ts`：
  - 到期时间按 UTC 毫秒存进数据库（日历类的值，用墙钟）。
  - 定时器一律经 Clock 端口（I01）：只对最近的一条 `schedule()`，超过 2^31-1 ms 由 Clock 分段重挂；每 1 s 用 `nowWall()` 比对一次，捕捉睡眠唤醒和时钟跳变。这里不直接用 `setTimeout` 和 `Date.now`。
  - 到点时（I01、I02）：同一批 journal 记录里写 `clock{timerId, …}`（timerId 照步骤 3 的格式由提醒 id 拼出）、提醒的 `transition`（pending → fired，cause = clock(timerId)）和新条目。journal fsync 之后才算「已触发」，然后才进 Reminders 分组、按 P1 走 `channel.notify()`（至少一次投递，见步骤 5）。
  - 同一 tick 到期的多条提醒和 snooze，按步骤 3 的固定全序处理。
  - 启动时立刻补发已过期的提醒，标 late；这次触发的 cause 同样是 clock(timerId)。
  - 快照带 `reminders:{pending, nextWall}`（待触发的条数和最近到期时刻），页面在底部折成一行；`reminder-api.test.ts` 核对这个字段（UI 设计第一节，0 d）。
  - `POST /api/reminders` 的文字上限 120 个码点（片段表单条 2 KB 是存储上限，这里更严）：超了回 422 `text-too-long`，不悄悄截短，也不写 journal；页面输入框显示剩余字数。
- **r4**：§11.2 r4:2105、§5.2 Reminders、§13.2 r4:2386、R10、r4 D16。
- **测试**：
  - `test/reminders/scheduler.test.ts`、`restart.test.ts`、`test/server/reminder-api.test.ts`（另测：120 个码点收下，121 个回 422 `text-too-long`，journal 里 0 条新记录；按码点计，一个汉字、一个代理对各算 1）。
  - `scheduler.test.ts` 另测：虚拟钟下 3 条提醒和 2 个 snooze 在同一 tick 到期，打乱插入顺序跑 100 次，出条目的次序一致。
  - `test/reminders/crash.test.ts`（I02）：journal fsync 之前崩溃 → 重启后提醒补发、标 late；fsync 之后、通知之前崩溃 → 不再触发一次，只补发通知（tag 不变）。两种情况提醒丢失 0、InboxItem 行重复 0。
- **推进验收**：AC4。

**步骤 14　Codex `state_5` 快照轮询**（1.75 d，线 B，可削减④）
- **建什么**：`sources/codex/state5-snapshot.ts`、`sources/codex/wal-key.ts`、`workers/state5.ts`（经 bootstrap 装围栏）。
  - 每次轮询（≥2 s）经读闸门读两样东西：整个 `-wal`（有的话），以及 db 的前 100 字节。
  - 算变化键（代-7）：
    - WAL 头里的 salt1 和 salt2。
    - 与当前 salt 和校验链都吻合的最后一个提交帧的序号（按 WAL 头的 magic 决定校验字节序）。
    - db 头的变更计数（偏移 24）。
    - db 文件大小。
    - 键变了才复制，也就是才写盘。
    - 变化键就是这个源的游标，和由它产生的 Event、边同批提交（I02，步骤 3）。
    - `-wal` 超过 64 MiB 时只读头部，用「头部 + 大小」作键，并标低置信（暂定）。
  - 复制：
    - 已读到的 `-wal` 字节和重新读出的 db，经写围栏写进 `~/.orchestra/tmp/state5-<n>/`。
    - 写完再读一次 WAL 头和 db 头，变了就丢弃重试，最多 3 次，之后跳过这一轮。
    - 不用 `copyFile`。
  - 副本以读写方式打开（`-shm` 只会建在 tmp 里），加 `PRAGMA query_only=1`，authorizer 用 `openSnapshot()` 的那套，然后跑 `PRAGMA quick_check`。
  - 用 `PRAGMA table_info` 探表结构，再查 `threads`、`thread_spawn_edges`、`tokens_used`，只取最近 N 天（N 暂定 7）。
  - `thread_spawn_edges` 每多一行就生成一条边。
  - busy 的判法：连续两次轮询之间 `updated_at` 或 tokens 有变化，标低置信。
  - M0 不对历史 rollout 做 readdir/stat，历史只用 `state_5` 里的元数据（r4:851）。
- **r4**：§7.3 r4:859–864、§7.2 r4:851、r4:2372、r4:2384。
- **测试**：
  - `test/codex/wal-key.test.ts`：checkpoint 后 WAL 原地复用、大小不变也能发现变化；校验链断了就停在断点之前。
  - `test/codex/snapshot.test.ts`：最新的行只在 `-wal` 里时也能读到；原库目录不多出任何文件；复制期间发生 checkpoint 会触发重试；键不变时没有任何写；`cursor-commit` 一例（I02）。
  - `test/codex/schema.test.ts`。
  - `test/latency/codex-poll.test.ts`。
  - `test/replay/golden-codex.test.ts`：包括边。
- **推进验收**：AC1（Codex）、AC2（Codex）。

**步骤 15　静态 Tuning 补全、版本漂移、`/connect`**（1 d，线 B，漂移显示可削减③）
- **建什么**：
  - CapabilityRegistry.detect()：照 `model/source-report.ts` 的接口，先用假数据开发，18B 再接上真实的源。每家 harness 一行，「是否已认证」一栏显示「M0 不检测（不读凭据）」。
  - 文案逐字为 `codex 0.165.0：没有契约包 → harness-unsupported`。
  - Claude 按每个会话的 `version` 和 2.1.287 比较，有漂移只提示、不阻断。
  - 其他面板：
    - 根目录与「未注册」进程。
    - `extraHarnessRoots`。
    - 只有旧版日志的 DSH 目录数。
    - 花名册加「保护」按钮。
    - 勿扰状态：procguard 加 `notif-state`（SHQueryUserNotificationState，未核验），失败就显示「未知」。
    - 每个源最近一次轮询、最近一次事件的时刻（`lastPollWall`、`lastEventWall` 显示成 hh:mm:ss，步骤 3 的接口；不用墙钟相减算「距今多久」，不变量 20），「停摆」照 status 标出来（由 `lastPollMono` 判，见步骤 4）。
    - DSH 会话页链接的路径前缀：照 DSH 实际 URL 定，写进 `ui/route.js` 的校验（UI 设计第四节）；`dshOrigin` 取你粘贴的 `/connect` URL 的 origin，不带 token。
    - 周自评 1–5。
  - `src/net/dsh-connect.ts` 与 `/connect` 输入框：
    - 只收 `http://127.0.0.1:<port>/` 或 `http://localhost:<port>/` 开头、并且 `interactions=none` 的 URL，其他直接拒。
    - 用 boot 递下来的 `ports.fetch` 换一次 cookie。它今天只服务 `data:` URL：本步要让 boot 在装围栏前先 `await fetch('data:,')`（undici 实例化，不走网络），取出 dispatcher，绑进 `ports.fetch`，换掉现在那个只会抛错的桩（开眼 §7.2、`import-fence.ts` 的注释）。cookie 只放内存，token 当场丢掉；日志和片段里的 `token=` 换成 `***`。这个 POST 的 requestDigest 只盖路由、不盖 body（步骤 4），所以 journal 和去重表里也没有 token 的哈希。
    - 这次 fetch 经 Clock 有 10 s 超时（推断）：超时就放弃，写 `human.result`（`outcome:'unknown'`），步骤 4 的 in-flight 随之结束；Orchestra 这边没拿到 cookie，status 的 `dshOrigin` 照旧是空，要你看 Tuning、需要就重新粘贴。
    - 给浏览器的深链永远不带 token。
    - 换 cookie 时 DSH 宿主自己写的东西不算 orchestrad 的写。
- **r4**：r4:2378、r4:2392、§5.2、§11.2、§10.11 r4:1695、R24。
- **测试**：
  - `test/tuning/capabilities.test.ts`（逐字核对）、`roots-api.test.ts`、`startup-errors.test.ts`。
  - `test/net/dsh-connect.test.ts`：别的主机或端口被拒；`interactions` 不是 none 被拒；token 不出现在日志、数据库、journal、去重表和深链里，含 token 的 body 的 sha256 也不出现；用本地假服务器测换 cookie；假服务器一直不回、虚拟钟走 10 s → 写一条 `human.result`（`unknown`），同 actionId 的重试得原样回复，不得 409。
- **推进验收**：AC10。

**步骤 16　policy v0**（0.5 d，线 C，可削减②）
- **建什么**：
  - transcript 里出现 bypass `permissionMode`，每个会话出一条 P2（去重）。
  - Tuning 顶部常驻显示「N 个等同于你的会话」：能确定的（注册表带 `--chrome`）先做，其余显示「未探测」。
  - 读 `sessions/*.key` 或连 `cc-msg-*` 管道的工具调用出 P2。
- **r4**：§10.9 r4:1676–1679、§10.11 #6、R21、§7.1 r4:822。
- **测试**：`test/detectors/policy.test.ts`。
- **推进验收**：没有对应的验收项（交付物 r4:2376）。

**步骤 17　toast 后备（常驻 worker）**（0.75 d，线 C，排在步骤 16 之后，D-10；可削减①）
- **建什么**：
  - `os/toast-script.ts`：常量脚本，内容是：加载 WinRT 类型一次 → 循环读 stdin 行 → 解 base64 JSON → 用 daemon 已转义的字段拼 XML → 设好 Tag 和 Group → `Show()` → 往 stdout 写 `{"id":…,"shown":<ms>}`。
  - 把编码后的常量接进 `os/spawn.ts`（`TOAST_ENCODED`，第 2 步起是 null，所以 PowerShell 那条规则今天开不了）；`spawn.test` 的「PowerShell 的任何 argv 都被拒」随之改成「带任何别的 argv 都被拒」。
  - `os/toast.ts`：实现步骤 3 冻结的 `ToastPort`（`show`、`onShown`），在线客户端经 channel 的 `onlineClients()` 取。
    - 没有「可通知的在线客户端」时，起一个常驻 worker（启动参数见 §2）。daemon 启动时如果也没有客户端，就立刻起。
    - 有客户端连续 10 分钟正常回执，就关掉 worker。
    - worker 挂了就退避重起。
  - XML 由 daemon 转义；剥控制字符；字段截断。标题和正文用 `shared/strings.js` 按 `{key,args}` 拼，和浏览器通知同一份（UI 设计第一节）；args 已在 `server/view.ts` 过格式检查；测试 profile 下标题带「[测试]」前缀（`toast-latency` 一次弹 10 条，不加就和真的一样）。`activationType="protocol"`，`launch="http://orchestra.localhost:<port>/#/item/<id>"`，不带 token。AUMID 见代-4。
  - 至少一次投递（补3）：`ToastNotification.Tag` 取 itemId（itemId 不超过 64 个字符），`Group` 固定为 `orchestra`。崩溃后补发同一条目时替换掉旧的那条，不会叠出第二条。
- **r4**：§5.3 规则 3、§11.2 r4:2098、r4:2385、r4:2105。
- **测试**：`test/os/toast.test.ts`：转义；argv 和 spawn 白名单里的常量逐字相同；stdin 是 base64 JSON 行；按 `shown` 回报记录提交时刻并设好 `notifiedAt`；worker 生命周期的切换；发给 worker 的每一行都带 tag，值等于 itemId。测试里不真弹 toast。
- **手动**：
  - 真弹一次 toast，点击后打开对应条目。
  - 同一个 itemId 连弹两次，操作中心里只剩 1 条。
  - `scripts/toast-latency.ts`（测试 profile）弹 10 条测试 toast，测「请求 → Show()」的 p50/p99，空闲和满载各一轮。实现会话可以跑。
- **推进验收**：AC3/AC4/AC5 在页面不在、被冻结或没回执时的通知路径。

**步骤 18A　验收脚本**（1.35 d，线 B；原 0.75 d，开眼第一轮第二档 +0.5 d，UI 交互设计 +0.1 d）
- `scripts/latency-report.ts`（I06：每个时延门槛报两行，见 §5 AC2–AC5）：
  - 第一行，确定性上界：列出 `metrics/latency-bounds.ts` 里该门槛的组成（轮询间隔、调度 tick、等回执的 1.5 s、按最大帧算的解码），注明由 `phase-sweep` 测试守住、0 例外；解码和快照两项填 `cost-bench` 的实测值。
  - 第二行，随机尾部：超阈的 k/n 和 Wilson 95% 上界，按来源（Claude、DSH、Codex）分开。目标率从 config 读，标「假设」，不卡出口；样本不够证明目标率时写「样本不足」。
  - 每个样本拆成三段，再加通知一段：源侧压住（`srcTime` → `prevPollMono`）、我方采样（`prevPollMono` → `obsMono`，不超过一个轮询间隔）、我方提交（`obsMono` → metric 里这批的 `commitDoneMono`，含 journal fsync 和 db 事务，见步骤 3）、通知（`commitDoneMono` → `notifiedAt`）。metric 缺这一行时（例如 db 从 journal 重建过）退回用 `committedAt` 分界，并在报告里标出。各段报 p50/p99/p99.9。拆段在 `metrics/latency.ts` 里算（`srcTime` 只许出现在那里，见步骤 8）。
  - 分组照旧：DSH 第 1–2 帧、approval/*、其余。「提交通知」按浏览器路径、直接 toast、等回执超时后转 toast 三组分开。
  - blocked→noticed 报中位数、p95、p99（§2.2 第 13 条）。
  - UI 一块（UI 设计第五节）：
    - 通知「交给系统 → 显示」p50/p99 和「没显示」的 k/n 与 Wilson 上界（metric 里的 shown 回执；§5 清单第 5 条的勿扰实测做完之前标「口径未核实」，因为 Chrome 可能在交给 Windows 时就触发 show）。「没显示」只算 attempt = 1 和 P0 的重发；非 P0 的同 tag 补发是静默替换，Chrome 会不会对它触发 show 没核实，单独计数。
    - 人类动词：标记类从 HTTP 收到请求（单调钟，记进 metric 表）到这批提交做完；刹车从 `human` 记录到 Command 的结果；各报 p50/p99/最大值。不用「human 记录到结果提交」：标记类的结果和 human 同批写，按构造就是 0，会读成通过。
    - 看见→动作：seen 到同一条目的下一条人类动作记录（从 journal 算）。
    - `sse.coalesced`、`sse.drop`、`sse.superseded`、重连原因和缺口次数；快照字节 p99 和每分钟份数，对照开 delta（64 KB）和开 100 ms 合并（120 份）的门槛。
    - 帧到绘制、按键到绘制、「还没收到结果」和「刹车结果不明」的次数（分开报）要等步骤 19 的 UI 时延探针，没做就写「未测」。上屏时刻、打断计量 M0 不采证据，写「未测」。N = 0 一律「未测」。
- `metrics/latency-bounds.ts`：每个门槛一行，写明确定性上界由哪几项组成。各项直接引用各源实际用的同一个常量，不另抄一份。
- 相位扫描（I06，P3）：`test/helpers/phase-sweep.ts` 加 `test/latency/phase-sweep.test.ts`。
  - 这是把 I14(a) 的 tick 相位扫描从第三档提前到第二档，偏离了开眼笔记 §6 的分档：I06 第一行的确定性上界写明「由 I14 的相位扫描证明」，不扫就只是算出来的数。I14 剩下的「挂上偏移」和 (b) 仍在步骤 19。
  - 覆盖的门槛：AC2 的 DSH 热文件、闲置后再追加、冷遍历发现新文件、Claude 注册表、Codex 轮询；AC3 的注册表 waiting 和 20 s 低置信；AC4 提醒；AC5 grep×5。
  - 在虚拟钟下，把触发写入放在相关轮询 tick 的 0、1/8 … 7/8 处；AC4 另加墙钟 +1 h、−1 h 跳变。
  - 复用步骤 7 的合成写入方和各步已有的延迟场景，不起真定时器。
  - 每个门槛 8 个相位都不许超界，0 例外；每个门槛的最大值用 `t.diagnostic` 报出。
- `scripts/cost-bench.ts`：量确定性上界里两项真实耗时：解码最大帧（合成 1.4 MB）、一次 `state_5` 快照复制加查询。空闲和满载各一轮，报 p50/p99/最大值。实现会话可以跑。
- `scripts/signal-rates.ts`（I06）：照 §2.2 第 13 条，从 journal 和 metric 表按信号类别算漏报、迟报、误报的 k/n 和 Wilson 上界，n = 0 写「未测」。低置信类调用步骤 11 导出的 20 s 规则纯函数，在有注册表信号的会话上离线重算，再和注册表的 waiting 段比对。只出报告，不改任何状态。
- `metrics/wilson.ts`：Wilson 95% 上界，`latency-report` 和 `signal-rates` 共用。
- 静默表（I17）：`metrics/silence.ts` 列出 §5 末尾那张表的阈值、用处和出处；录下的最坏值放在 `fixtures/synthetic/silence-worst.json`，每个值带出处。
- `scripts/procmon-check.ts`：读 Procmon 导出的 CSV 和 `pids.jsonl`，统计 orchestrad 及其子孙在根目录清单下的写类操作。根目录清单就是 `fs/harness-roots.ts` 那一份，包括 Tuning 手填的额外根。
- `scripts/coverage-report.ts`：每个源的样本里见过的 type 和键名，对比归一化器映射到的、落到 `unknown` 的，给出覆盖率（r4:2718）。
- `scripts/check-real-{claude,dsh,codex}.ts`（手动 canary）：
  - 经读闸门的生产策略，对真实根各跑一次只读解析，只输出版本、各 type 的计数和 unknown 的 type 名。
  - 实现会话跑之前先问你一次。
  - 每晚定时跑要建计划任务，等 D-8。
- `scripts/home-meta.ts`：只做 stat 的前后快照，只输出变化条目的计数。
- **测试**：
  - `test/scripts/procmon-check.test.ts`、`coverage-report.test.ts`。
  - `test/scripts/latency-report.test.ts`：每个门槛两行都在；四段加起来等于总时延；按来源拆开；样本不够时出「样本不足」；UI 一块 N = 0 时出「未测」。
  - `test/scripts/signal-rates.test.ts`：合成 journal 里埋好已知数目的漏报、迟报、误报和「未送达」，k/n 逐个对上；n = 0 出「未测」，不出 0。
  - `test/metrics/wilson.test.ts`：k = 0、n = 20 → 约 0.161；k = 0、n = 3,000 → 约 0.0013；0 例外时要证明 ≤1e-3，至少要约 3,840 个样本。
  - `test/latency/phase-sweep.test.ts`：见上。
  - `test/latency/silence-table.test.ts`：有实测值的行，阈值大于录下的最坏值；没有实测值的行只报「未测」，不判失败。
- **估时变化**：0.75 d → 1.25 d → 1.35 d（UI 一块 +0.1 d）。相位扫描约 0.25 d（场景和写入方都是现成的），两行报告、三个率和 Wilson 约 0.25 d，静默表和 `cost-bench` 并在里面。依赖从「7、8」扩到「7、8、9、13、14」；步骤 10–12 的代码要等线 C 步骤 12 并回 main。按现在的时间线，线 C 在第 16.0 + x 天并回（x 是挪到第 8.0 天后的步骤 6 落库部分，≤0.3，见 §4.1），x ≤ 0.35 时早于 18A 开工（第 16.35 天）；D-19 选「只做 2b」时是第 15.15 + x 天和第 15.5 天，同样以 x ≤ 0.35 为界。x 在界内时 18A 内部不需要先后。线 C 从第 8.0 天才开工时，步骤 12 在第 18.0 天并回，晚于 18A 开工，就走下面这条路（推断，§4.1）。万一线 C 落后，就照原来的办法：先做 `wilson`、`latency-bounds`、`cost-bench` 和 AC2 里 DSH、Codex 的扫描，AC2 的 Claude 注册表、AC3、AC5 的扫描和 `signal-rates` 的低置信部分排到合并之后。
- **推进验收**：AC2–AC5 的两行报告和三个率、AC7②。

**步骤 18B　收尾与端到端**（0.75 d，线 A+C）
- 把 Tuning 接上真实源的报告。
- 端到端测试（测试 profile，用 `test-stage`）：合成注册表进入 waiting → SSE notify → 模拟页面回执 ≤2 s；没有客户端 → toast worker 回报 `shown`。
- `scripts/rss-20.ts`：起 20 个合成会话，记录 RSS。
- 注意力指标落库；写 M0 验收记录。
- **推进验收**：AC2 报告、AC3、AC7②、AC11。

**步骤 19（可选，开眼第一轮的第三档）**（逐项估，合计约 1.75 d；不在关键路径上）
- **规则**：并行关键路径已经比 r4 剩下的预算多约 3.45 天（线 C 从第 8.0 天开工时约 5.0 天，推断），所以这一步默认移到 M1。只在某条线出现空档时做（线 C 的两段空档见 §4.1：第 8.0 天前约 0.4 + x 天、末尾约 0.45 − x 天，合计约 0.85 天；D-20 的「修复见证」在 8.0 前那段开工，做不完的接在末尾；线 C 从第 8.0 天才开工时这两段都没了，线 B 末尾反而空出约 1.55 天，推断，§4.1；其余要等某步提前做完），一次挑一项能在空档里做完的；不挪动任何必做步骤，不推迟 18B。每项做完单独提交（由你点头）。
- **I08 睡眠与时钟跳变，只做 clock-gap**（0.5 d）：
  - procguard 加一个 `clock` 命令，一次返回墙钟、含睡眠的中断时间、不含睡眠的中断时间。做了的话，§6 第 6 条和代-11 的命令数从七个改成八个，`protocol` 测试同步。
  - 醒来时比较两种中断时间的差，只写一条 `clock-gap` 记录（例如「机器睡了 7 h 12 min」）。跨睡眠到期的一次性提醒照步骤 13 补发一次、标 late，并引用这条 gap。跨 gap 的延迟样本单独标出，不进 p99。
  - libuv 定时器在睡眠期间走不走，本机没实测，做这一项时先测。
  - 测试：虚拟钟注入 8 h 睡眠，只出 1 条 clock-gap，提醒恰好补发 1 次；你在场时真机睡眠一次（加到 §5 末尾的清单里）。
  - 没做就 M1（审批与租约「取最先到点的钟」、信封 deadline 新格式本来就在 M1）。
- **I10 锚点缺席时只看边沿，不判电平**（0.5 d）：
  - 版本在契约包外时（M0 的实际情形是 Claude CLI 漂移和 DSH 新版本），靠锚点才判得出的状态一律低置信，显示「活动中 / 不明」。边沿类信号（有活动、`tool.call` 计数、RSS）保持全置信，runaway 刹车照常。
  - 处于 working、超过 T 没有任何锚点，就转为 `unknown`。T 取 §5 静默表里该源的值；该源未测时这条只记录、不转换。
  - 测试：结束事件改了名的 fixture，在 T 内变为 `unknown`；同一 fixture 上 runaway 仍按时出 P0。
  - 没做就 M1。
- **I14 压力眼 (a)(b)**（0.25 d；(a) 的 tick 相位扫描已提前到 18A，见那一步）：
  - 要等 18A 做完（第 17.7 天）才能做。
  - (a) 在 18A 的相位扫描上再扫「挂上时刻相对写入的偏移」：S1-DSH 那次 5.6 s，是挂上之前已经写下了两帧。
  - (b) 源抖动：同一串写入按 100 ms、250 ms、1 s 轮询，并随机切块重放；变体包括先截短再追加、rollback、同路径换文件。
  - 测试：漏检 0，各变体之间派生的转换序列差异 0，CI 时长设上限。扫描会产出不少 `unknown`，这正是「不明不重发」，不能为了好看改成自动重发。
  - (c) 崩溃点扫描照原计划在 M1；步骤 3 已有三个崩溃点。没做就 M1。
- **补5 探头负载**（0.25 d）：
  - 24 h 观测里每分钟记一条 orchestrad 自己的 CPU 和 IO（`process.resourceUsage()`），进 metric 表。
  - 测试 profile 下做一次观察器开、关对照：合成写入方自己记写盘耗时，跑两轮比较 p99 之差。实现会话可以跑。
  - 测试：metric 记录格式的单元测试；对照结果写进验收记录。没做就 M1。
- **I20 观察会话收件箱行的结束类渲染**：已并进步骤 5 的 `test/ui/static-render.test.ts`（每个 kind × state × conf × 结束类的 `data-*` 和文字两两不同，「完成」0 次），不再单列，步骤 19 合计因此从 2.0 d 降到 1.75 d。
- **UI 时延探针**（0.25 d，UI 设计第四、五节）：
  - 新文件 `ui/perf.js` 只在可见标签页里采样：帧到绘制（rAF + MessageChannel）、Event Timing（`durationThreshold` 16）量按键、长动画帧计数、notify 处理耗时、「还没收到结果」和「刹车结果不明」的次数。时间和 PerformanceObserver 都在 `ui/clock.js` 里，`perf.js` 只消费它，扫描规则不放宽。样本放进 client-state 的可选 `perf` 字段（形状在步骤 3 留好），只随变成隐藏和 `pagehide` 那两次发，从不单独定时发；进 metric 表，18A 按两行写法报。
  - 测试：metric 记录格式；隐藏标签页 0 个样本。
  - 没做就 M1，18A 那几行写「未测」。

---

## 5. 验收对照表（r4 §13.2 r4:2383–2393）

| # | 验收要点 | 自动化测试 | 手动或实跑 | 要你在场 |
|---|---|---|---|---|
| AC1 | 黄金回放：Claude、DSH、Codex 的状态转换（含边）完全一致；期望由人手写 | `test/replay/golden-{claude,dsh,codex}.test.ts` | — | 否 |
| AC2 | Claude/DSH ≤2 s，Codex ≤ 一个轮询周期 + 2 s（Claude 从注册表文件出现算起）；DSH 有例外。<br>**① 确定性上界**（假时钟相位扫描：触发写入落在轮询 tick 的 0、1/8 … 7/8 处，8 个相位都不许超界，0 例外）：DSH 热文件 ≤ 250 ms + 最大帧解码；闲置后再追加（挂上后先读一次）≤ 250 ms + 解码；冷遍历发现新文件 ≤ 1 s + 解码；Claude ≤ 1 s；Codex ≤ 一个轮询周期 + 一次快照复制与查询。解码和快照两项填 `cost-bench` 的实测值。<br>**② 随机尾部**：目标 P(>2 s) ≤ 1e-3，Codex 为 P(> 周期 + 2 s) ≤ 1e-3（假设，由你定，不卡 M0 出口）。24 h 观测按来源（Claude、DSH、Codex）报超阈的 k/n 和 Wilson 95% 上界，再拆成源侧压住、我方采样、我方提交三段；DSH 第 1–2 帧和 approval/* 单列。0 例外时要证明 ≤1e-3 至少要约 3,840 个样本，不够就写「样本不足」。DSH 自己压住的 >2 s（约万分之一，最长 5.1 s）落在源侧那段，照 r4 记为有文档的例外 | `test/latency/*`，加 18A 的 `phase-sweep` | 24 h 真实观测（真实 profile），用 `latency-report` 出两行 | 你启动真实 profile，24 h 里照常开着会话 |
| AC3 | `waiting` 出现后 ≤2 s 生成条目并提交通知；TUI 路径你在场实测一次；没信号的会话 20 s 降级。<br>**① 确定性上界**（相位扫描同 AC2）：注册表写出 waiting → 条目提交并调 `notify()` ≤ 1 s；低置信条目 ≤ 20 s 静默 + 1 s stat。「等回执超时后转 toast」这一组的确定性部分是 1 s + 1.5 s 等回执 + `Show()`，本身就超过 2 s；照现计划单列报告，不混进另外两组，在验收记录里写明，由你判断。<br>**② 随机尾部**：目标同 AC2（假设）；按浏览器路径、直接 toast、超时转 toast 三组报 k/n 和 Wilson 95% 上界。<br>**③ 三个率**（定义见 §2.2 第 13 条），按 approval、question、低置信、DSH approval/* 四类分开：注册表类的漏报以 `missedTransitions` 作上界；低置信类的漏报和误报靠离线重算 20 s 规则；DSH approval/* 多半 n = 0，显示「未测」 | `needs-input`、`low-confidence`、`notify/channel`、`phase-sweep`、`signal-rates`，加 18B 端到端 | ① TUI 实测：你启动并配对真实 profile 的 orchestrad，同时开着 `spikes/s5-claude/passive-poll.mjs`，在同一次模型调用里，同一个事件同时记下 S5 的 go/no-go 和「waiting → 条目 + 提交通知」的时间；② Desktop 权限提示被动观察；③ 浏览器真实弹窗。浏览器路径和 toast 路径分开报告；toast 路径用 `toast-latency` | ①②③ 都要 |
| AC4 | 一次性提醒 ±5 s 内提交通知，重启不丢。<br>**① 确定性上界**：虚拟钟下到期即触发，误差 0；墙钟跳变后靠每 1 s 一次的 `nowWall()` 比对，最多偏 1 s。相位扫描（到期时刻落在 1 s 比对周期的 0–7/8 处，另加墙钟 ±1 h 跳变）全部在 ±5 s 内，0 例外。重启不丢靠步骤 13 的两个崩溃点。<br>**② 随机尾部**：目标 P(偏离 >5 s) ≤ 1e-3（假设，不卡出口）；24 h 观测报 k/n 和 Wilson 上界。<br>**③ 三个率**（提醒类）：漏报 = 到期却没有 fired 转换，按构造为 0，由 `reminders/crash` 守住；迟报 = 提交通知晚于到期 5 s（含「未送达」）；误报 = 提前触发，假时钟下 0 次 | `reminders/*`、`phase-sweep`、`signal-rates` | 可选：真实重启一次 | 否 |
| AC5 | 实时追加的 grep×5 ≤10 s 出 P0。<br>**① 确定性上界**：第 5 次调用落盘 → P0 提交 ≤ 源的采样上界（DSH 250 ms + 解码；Claude transcript 1 s）+ 到达即判（0），相位扫描证明，0 例外。<br>**② 随机尾部**：DSH 自己压住最长 5.1 s，加上采样上界仍在 10 s 内（静默表由 CI 断言）；目标 P(>10 s) ≤ 1e-3（假设）。真实 runaway 很少，24 h 里多半写「样本不足」。<br>**③ 三个率**（runaway P0）：漏报 = fixture 里第 5 次到达后没出 P0，CI 为 0；迟报 = 超过 10 s；误报 M0 没有判据，显示「未测」 | `test/runaway/live-append-*`、`phase-sweep` | — | 否 |
| AC6 | 能杀假进程树；受保护宿主没有键入确认就拒绝；剪掉 PID 复用边 | `procguard/*`、`brake-api` | 测试 profile 下在 UI 上对假进程树按一次 `K` 并键入确认（实现会话可以做）。真实 profile 下按 `K` 只由你做 | 否 |
| AC7 | 零写入 ①②③ | ① `static-scan`、`write-fence`、`import-fence`；③ `frozen-tree`（合成） | ② Procmon 30 分钟（管理员）+ `procmon-check`；③b 停掉所有 harness → `freeze-tree` 复制到 `%LOCALAPPDATA%\orchestra-frozen\<run>` → 测试 profile 带 `--roots-dir` 读它 10 分钟 → 哈希零差异 → 删掉副本 | ② 要；③b 要 |
| AC8 | 不带 cookie 调 approve/kill → 403；5173 发 fetch → 403；`<img onerror>` 与 OSC 52 不执行 | `test/server/*`、`sanitize`、`static-render`、`startup-modes` | 测试 profile 下做 curl、5173 页面、XSS/OSC fixture（实现会话的浏览器面板可以做） | 否；真实 profile 的配对只由你做 |
| AC9 | 读白名单拒绝凭据类文件 | `test/fs/read-gate.test.ts` | — | 否 |
| AC10 | Tuning 显示 codex 那行文案和 Claude 版本漂移 | `test/tuning/capabilities.test.ts` | 看一眼真实的 Tuning 页 | 你看 |
| AC11 | 20 个会话时只测量、记录 RSS | — | `scripts/rss-20.ts` | 否 |

两行写法不是放宽 ≤2 s：确定性部分收紧到能证明的上界，尾部从「例外」变成测量。目标率都是假设，由你定，不卡 M0 出口（I06）。

**静默阈值与实测最坏静默**（I17）：每个「静默就当有事」的阈值旁边，写上该源实测到的最长合法静默。这些数都是 spike 在 CPU 83–100% 下测的，偏悲观、也不稳定，不当基线；24 h 观测再测一遍。`test/latency/silence-table.test.ts` 断言：有实测值的行，阈值大于录下的最坏值。

| 阈值 | 用在哪 | 实测最坏静默 | 出处 | CI |
|---|---|---|---|---|
| 60 s「未注册」 | 步骤 10 | 注册表在 spawn 后 28–46 s 才出现，之后再过 3–11 s 才有 `status` 键 | S5 | 断言 60 s > 46 s；余量只有 14 s |
| 20 s「可能在等你」 | 步骤 11 | 正常的长工具调用会静默多久：未测（r4 也写明 20 s 未核验）。合法的 `input needed` 等待长达 678 s，那是真在等你，不算误报 | S5、r4 §10.12 | 不断言：这是低置信信号，改报误报率（§2.2 第 13 条） |
| AC2 的 2 s、AC5 的 10 s 里 DSH 源侧那段 | 步骤 9、12 | DSH 写盘前最长压 5.1 s，约万分之一 >2 s，多在第 1 帧 | S1-DSH | 断言 10 s > 5.1 s + 250 ms；2 s 那条照 r4 记为例外 |
| 1.5 s 等回执 | 步骤 5 | 未测 | — | 不断言；24 h 观测记回执的 p99 和最大值。超时只会多弹一条 toast |
| 20 s UI 判过期（5 s 一个 tick × 4；原「30 s 客户端离线」已删，在线改看 SSE 流是否开着） | 步骤 4、5 | 未测 | — | 不断言；记 tick 的最大间隔。判过期只会让页面变灰并重连 |

**要你在场或动手的事**（汇总）：
1. 启动真实 profile 并配对，每次 daemon 重启后一次。只有你能做。
2. 在 Tuning 里登记 DS-Bot 桌面版的数据目录（一次）。
3. 终端 TUI 等待实测，最多 1 次模型调用，orchestrad 和 `passive-poll.mjs` 同时开着。
4. Desktop 权限提示的被动观察，随日常使用。
5. 授予浏览器通知权限，看到一次真实弹窗；顺便在微软拼音中文模式下对收件箱按几次 j/k，记下是生效还是出提示（2 分钟，UI 设计第三节）；再开着勿扰（专注助手）弹一条测试通知，记下 `show` 事件是没来、交给系统时就来，还是真显示时才来（2 分钟）。18A 的「交给系统 → 显示」在这一项做完之前标「口径未核实」（D-15）。
6. Procmon 30 分钟。要管理员权限，Procmon 要下载；也可以用 wpr + tracerpt。
7. 停掉全部 harness，做一次冻结树 diff。
8. 24 h 真实观测。
9. 顺便做：46470、52373 两个根有活会话时的完整性检查。
10. 可选：提权启动被拒一次（退出码 20）；用 DSH-plugins 那份 Low 副本启动一次，确认打印原因、不进工作状态、以 ui-only 退出码（22）退出、不起 HTTP（D-17 选「发」时确认只起 UI）。

---

## 6. 从第一天起由代码保证的安全不变量

| # | 不变量 | 怎么保证 | 测试 | r4 |
|---|---|---|---|---|
| 1 | **写围栏，先拒后放**：目标落在任何已知 harness 根下一律拒绝；之后才看是否在 `realpath(ORCHESTRA_HOME)` 下 | `write-fence.ts` + `harness-roots.ts`；`rm` 逐项检查，不跟随链接 | `write-fence`、`paths` | §5.2、r4:605 |
| 2 | **导入围栏**：别的模块碰不到 fs / child_process / sqlite / 网络 | 按模块的 builtin 白名单做静态扫描；`boot.ts` 先装钩子、再动态 import 主模块；worker 走 bootstrap；运行时替换 `getBuiltinModule`、`binding`、`_linkedBinding`、`dlopen`，另把 `loadEnvFile`、`report`、`kill`/`_kill`、调试口、网络全局和 undici 的槽锁成桩（全表见 `runtime/process-powers.ts`，第 2c 步）；`node:fs`、`node:child_process`、`node:sqlite` 只由 boot 在围栏前造好的模块碰（第 2c 步、步骤 3）；`process.exit` 锁死，`reallyExit` 由 boot 独占，每一种类型化退出、崩溃和停止都经 boot 的 `makeEndProcess` 有界刷新后结束（步骤 3）；禁用 vm、wasi、inspector、repl、cluster 和 `eval:true` | `static-scan`、`import-fence`、`process-powers`、`minting` | r4:605、r4:855 |
| 3 | **读白名单，默认拒绝** | `read-gate.ts` | `read-gate` | §10.11 r4:1693 |
| 4 | **打开方式**：只用 `'r'`，读完即关；只对热集合里的 DSH 文件持句柄；不对会被 rename 替换的文件持句柄；不用 `copyFile` | 读闸门句柄计数、静态扫描 | `handles` | r4:605、r4:2367 |
| 5 | **数据目录与 harness 根互不包含**：`ORCHESTRA_HOME` 不在任何根内，也不包含任何根、用户 home 或盘符根；启动时和添加根时都检查 | `data-dir.ts` + 不变量 1 | `data-dir`、`startup-modes` | §5.3 r4:600 |
| 6 | **不启动 harness、没有通用启动器** | `spawn.ts` 只认（exe，精确 argv）对；PowerShell 只跑常量脚本，带 `-NoProfile`；M0 的 procguard 里没有 run-in-job；客户端只发七个命令 | `spawn`、`protocol`、`static-scan` | r4:816、r4:2389 |
| 7 | **不核身份不杀**：按 pid + createTime 杀；PID 复用边剪掉；每次以选中的子树为根；受保护节点和 harness 根要键入确认；执行前重新核对谱系；计划 60 s 内有效；只能由 UI 上的人点 | procguard + `brakes/kill-tree.ts` | `kill-tree`、`protected`、`pid-reuse`、`brake-api` | §10.5 |
| 8 | **保护名单不随 procguard 重启丢失** | `protect_entry` 表、`--protect`、每次 `ready` 后补发；确认前返回 503 | `protect-restart` | r4:1610 |
| 9 | **拒绝以提权运行**：强制标签 ≥ High 就退出 | `integrity.ts`，只看 SID | `integrity`、`startup-modes` | r4:593、r4:1702 |
| 10 | **不确定就不进入工作状态**：缺 `registerHooks` → boot 不 import `main.ts`，以缺特性退出码（21）退出；Low、unknown（含 whoami 失败）、数据目录检查失败 → ui-only；journal 断链（拿锁之后才发现）→ 打印原因、以 ui-only 退出码（22）退出，进程内不放锁；ui-only 不开存储、不开源、不起 procguard，只 spawn whoami；D-17 推荐默认下 ui-only 打印原因后退出，不起 HTTP | `boot.ts`、`startup.ts` | `startup-modes` | r4:589 |
| 11 | **agent 拿不到真实进程上的人类动词**：agent 只起测试 profile；测试 profile 只读合成根，只能刹登记过的测试根；真实 profile 只在 TTY 下打印配对码，在 node:test 下拒绝启动（也看进程自己的环境；唯一例外：进程内调 start() 的测试显式传带类型的 opt-in，假 home 必须在临时目录的 orchestra-test-* 里，第 2b 步）；HTTP 拿不到新配对码 | `test-profile.ts`、`auth.ts` | `test-profile`、`pairing` | D8 r4:492、r4:1701 |
| 12 | **UI 鉴权**：Host 白名单、只听回环、cookie HttpOnly + Strict、变更请求要 POST + Origin + CSRF、GET/SSE 校验 `Sec-Fetch-Site`、不发 CORS 头、`/api/pair` 有专门规则 | `server/*` | `host-origin`、`csrf`、`pairing`、`no-cookie-403` | §10.11 |
| 13 | **渲染与外发**：完整 CSP；只用 `textContent`；出口剥控制字符；单字段 2 KB；UUID 正则；toast 数据走 stdin；URL 和 hash 不带 token；源里来的任意文字不进 SSE 帧，标题 args 只用过了格式检查的字段（含 Cf 或双向控制字符的不用）；浏览器存储只在 `ui/prefs.js`；只有 `ui/route.js` 能开窗口或导航，DSH 链接要和粘贴的 `/connect` 同 origin；ui/ 扫描规则（步骤 5） | `sanitize.js`、`http.ts`、`toast.ts`、`server/view.ts`、`scan-rules.ts` | `headers-csp`、`static-render`、`sanitize`、`xss-osc-fixture`、`toast`、`static-scan`、`view-parity` | §5.3 规则 1–5 |
| 14 | **秘密不外泄**：配对码和 token 不进日志、磁盘、URL（ui/ 里没有 `<form>`，输入框不带 `name`，扫描管）；三层脱敏；命令行只在选中子树内取，先脱敏再落库（例外：测试 profile 下解析 `--test-root-pid` 时取那几个 pid 的命令行，只比 fake-agent 标记，不落库、不进日志）；碰真实根的开发脚本只输出键名和格式 | `log.ts`、`redact.ts`、`kill-tree.ts`、脚本上的扫描 | `pairing`、`redact`、`log`、`static-scan` | §6.1、§10.11 |
| 15 | **外连只有一处**：只有 `dsh-connect.ts` 能 fetch，目标只能是本机回环端口；它用的是 boot 在装围栏前拿走的 `ports.fetch`（每次调用新造 init、dispatcher 绑死，步骤 15 之前只服务 `data:` URL） | 静态扫描 + 模块白名单 | `dsh-connect`、`static-scan` | r4:1695 |
| 16 | **不用 peerToken、不连 `cc-msg-*`；注册表只保留白名单字段** | `registry.ts` + 静态扫描 | `registry` | §7.1 r4:822 |
| 17 | **SQLite 收口**：`node:sqlite` 只由 boot 在围栏前造好的 `store/node-sqlite.ts` 碰，`db.ts` 是它前面唯一的闸（步骤 3）；拒绝 `file:`；authorizer 禁 ATTACH；快照连接只放行读和四个指定的 PRAGMA | `node-sqlite.ts`、`db.ts`、`builtin-policy.ts` | `db`、`minting` | r4:591、r4:861 |
| 18 | **测试和 fixture 不碰真实数据**：路径都注入；读闸门有测试模式；`fixtures/` 在 gitignore 里默认拒绝；冻结副本放在仓库外，用完删掉 | `env.ts`、`read-gate`、`.gitignore` | `env`、`read-gate`、`hygiene` | r4:668 |
| 19 | **标记后于效果**（I02、补1、补3）：源游标与它的 Event 行同批提交；提醒的「已触发」晚于 journal fsync；journal 先于 db，db 能从 journal 重建；外部通知至少一次、以 itemId 当 tag | `journal.ts`、`rebuild.ts`、各源的提交路径、`scheduler.ts`、`notify/channel.ts`；只有 journal 追加 + apply 写投影表，步骤 4 起 Store 的 db 私有、server 只拿只读视图 | `rebuild`、`cursor-commit`、`reminders/crash`、`notify/channel`、`store-access` | §5.2 r4:560、§6.1 r4:638、r4:2386 |
| 20 | **srcTime 永不定次序、不计时**（I04）：次序只认 srcSeq 和 jseq，时长只用我们的单调钟；别人的时间戳只当数据，或只比相等（I11） | Event 时间字段拆开；`srcTime` 不许出现在核心目录 | `srctime-scan`、`replay/srctime`、`needs-input` | §6.1 r4:648、r4:2383 |
| 21 | **每次转换都有原因**（I01）：cause 只能是 source、human、clock 之一；引起转换的定时器触发写进 journal；同一 tick 按固定全序处理；时间只经一个 Clock 端口 | `transition` 记录 apply 时校验；`runtime/clock.ts`；静态扫描 | `transition-cause`、`clock`、`replay/speed`、`replay/clock-mutation`、`static-scan` | r4:2383、r4 D16、Q-P10 |
| 22 | **页面是投影**（UI 设计第一节）：页面不存权威状态，只有快照带 jseq；人类动词按 actionId 幂等（重启后也是；查重在追加 journal 之前，过了去重那一格的请求在写出结果或被拒之前登记在内存的 in-flight 表里，await 期间的重试得 409；apply 遇到重复 actionId 跳过并记 metric，重建不会失败），结果写 `human.result`、只在效果之后写，只认流，不乐观显示、不自动重试；一次性报警只由 notify 帧触发，持续的标记从状态推；页面不新鲜时不说「没事」；重连只由 `ui/conn.js` 发起 | `ui/store.js`、`server/sse.ts`、`server/idempotency.ts` | `store`、`sse`、`idempotency`、`view-parity`、`notify` | r4 D8、原则 8、§11.2 |

---

## 7. 风险与削减顺序

**削减顺序**（r4:2395 原样）：① PowerShell toast 后备 → ② policy v0 → ③ Tuning 的漂移显示 → ④ Codex 快照轮询（推到 M2）。
**不能削减的**：写围栏与读白名单、UI 鉴权（含渲染规则）、收件箱、刹车、fixture。

| 削掉 | 省下 | 对验收的影响 |
|---|---|---|
| ① toast（步骤 17） | 0.75 d | 页面不在、被冻结或没回执时就没有通知，AC3/AC4/AC5 只在页面前台或未冻结时成立。**前提是步骤 5/10 已确认浏览器通知能用**，否则 ① 不能削，要先告诉你 |
| ② policy v0（步骤 16） | 0.5 d | 不影响任何验收 |
| ③ 漂移显示 | 约 0.5 d | AC10 推到 M2 |
| ④ Codex（步骤 14） | 1.75 d | AC1、AC2 去掉 Codex；AC10 的 codex 那行改从 `package.json` 取版本 |

两条线并行时，步骤 17 移到线 C 后（D-10），线 B 在第 17.7 天做完，线 C 在第 17.25 + x 天，只早 0.45 − x 天（x ≤ 0.3 时线 C 在第 17.25–17.55 天，早 0.15–0.45 天；步骤 6 的落库部分从这里扣，§4.1）。① ② 在线 C，③ ④ 在线 B：先削线 B 的一项才缩短总工期（例如③，约 −0.45 天，之后线 C 成了关键线），再削线 C 的一项才能继续往回压。以上假定线 C 在第 5.6 天开工；线 C 到现在（第 8.0 天）还没开工，从现在开工时线 C 在第 19.25 天做完、是关键线，关键路径约 20.0 天，这时先削线 C 的一项（例如②，约 −0.5 天）才缩短总工期，削线 B 的省不了（推断，§4.1）。任一条线落后超过它的空档，都直接推迟 18B：
1. 另一条线要是有一步提前做完，就接手落后那条线还没开工的一步（例如步骤 16，或步骤 12 的 RSS 与洪泛部分）。
2. 还不够，再按削减顺序削。

**某一步超时怎么办**：
1. 每一步的时间盒是估时的 1.5 倍。超了就停下来，写明原因。
2. 先在这一步内部收窄。
3. 还不够，就按削减顺序停掉还没开工的可削减步骤。
4. 不可削减的步骤只能延期，不能砍。延期后 M1 第 1 周的 S2/S3 跟着后移，并告诉你新的日期。
5. 被外部挡住的步骤（例如等你在场）不挡后面的步骤：对应验收项先标「待你」。

**主要风险**：

| 风险 | 对策 |
|---|---|
| 工期：串行约 29.7 天，r4 剩 12–15 天 | 两个实现会话并行（D-9，现在就要定），关键路径约 18.45 天（不做 2c、只做 2b 时约 17.6 天；2c 已提交，17.6 是当时的估算，现在省不回），比上沿仍多约 3.45 天（D-10、D-19）；18.45 假定线 C 在第 5.6 天开工，线 C 到现在（第 8.0 天）还没开工，从现在开工约 20.0 天，比上沿多约 5.0 天（推断，§4.1）；第二轮新加的活都标了价（UI 设计第八节末）；步骤 19 默认移到 M1；只有一个会话就现在改排期 |
| 24 h 观测的样本太少，证明不了尾部目标率（0 例外时证明 ≤1e-3 要约 3,840 个样本；spike 的数字又是在 CPU 83–100% 下测的） | 照报 k/n 和 Wilson 上界，不够就写「样本不足」；目标率是假设，不拿它卡 M0 出口 |
| 两条线的共享文件冲突 | 步骤 3 结束时冻结；之后要改就在 main 上单独提小提交，两边 rebase |
| 导入围栏被绕过（静态 import 早于钩子、vm、`Worker{eval}`、可写的 `getBuiltinModule`，已实测） | 先装围栏再动态 import；运行时替换几个入口；静态扫描按模块白名单查 |
| agent 拿到真实进程上的人类动词 | 测试 profile；真实 profile 只在 TTY 下打印配对码；HTTP 拿不到新码。残余风险照 §10.11 #6：同一用户下的无审批 shell 本来就等同于你 |
| `node --run` 可能调到 PATH 上的 Node 22 | `orchestra.cmd` 先把 `.tools/node24` 加到 PATH 前面；第一个测试就检查版本 |
| 浏览器后台标签页被冻结，通知没弹出来 | 页面同步回执、报冻结；在线看 SSE 流是否开着；1.5 s 没回执就转 toast |
| 中文输入法可能吞掉列表上的单键（未核实） | 229 计数后出提示；方向键和 Enter 别名；你在场时实测 2 分钟（§5 清单第 5 条） |
| 明文 HTTP/1.1 每个主机只有 6 个连接，toast 点开的标签越积越多，刹车 POST 会排队 | 每个配对会话最多 2 条活流，新的顶掉老的（步骤 4） |
| 线 C 只比线 B 早 0–0.45 天（D-10；步骤 6 的落库部分 x 从这里扣，x 超过 0.45 线 C 就成关键线，§4.1；Clock 已随步骤 3 提交，x 不再因「第 8.0 天后接 Clock」变大）；这假定线 C 在第 5.6 天开工，线 C 到现在（第 8.0 天）还没开工，从现在开工它比线 B 晚约 1.55 天、是关键线（推断，§4.1）；步骤 17 在线 C 依赖通知接口和 ToastPort | 整个通知接口（含 ToastPort、StreamsPort）和 Clock 端口（`ClockHub.port`、Fired 的键、定时器类名）已随步骤 3 冻结，contract-freeze 钉住；要改就在 main 上单独提小提交，同改金样 |
| toast 冷启动 1.3–3.4 s | 常驻 worker；两条路径的延迟分开报告 |
| 「等回执超时后转 toast」这一路按构造就超过 2 s：确定性部分是 1 s + 1.5 s 等回执 + `Show()`（AC3） | 照现计划单列报告，不混进另外两组，在验收记录里写明，由你判断 |
| `state_5` 的 WAL 原地复用、mtime 不动 | 用 WAL salt、校验链和 db 头算变化键；`-wal` 过大时降级并标低置信 |
| `state_5` 表结构没核实 | 先探表结构；副本不一致就丢弃重试；不行就走削减④ |
| dsh-TUI 的 `src/agent` 不全是纯类型 | 只 `import type`；`src/` 确实需要运行时值才退回自写 `vocab.ts` |
| 签名核对、取样、canary 读真实数据 | 经读闸门读，只输出键名、格式、计数；实现会话跑之前先问你 |
| DSH 事件形状没记录 | 步骤 9 先取样；形状确定之前，未知的一律降级为 `unknown` |
| DSH 自己压事件最长 5.1 s | runaway 在事件到达时立即判定 |
| `procStart` 和 createTime 的格式对不上 | 步骤 10 第一件事核对；对不上就把判活降为低置信 |
| 终端 TUI 没有注册表信号 | 20 s 低置信回退；Q6 继续当可行性题 |
| journal fsync 加 db 事务吃掉 2 s 预算（补1、I02） | 每批只 fsync 一次；「我方提交」一段（obsMono → 这批的 `commitDoneMono`，见步骤 3）单独计入延迟；24 h 观测里看它的 p99 |
| Claude 在同一次等待里也刷新 `statusUpdatedAt`（I11） | 上线前用 S5 的被动轮询数据核一遍；是的话改用 waitingFor 加它的值判断新的一段 |
| 杀毒软件拦 csc，或 procguard 起不来 | 按 r4:2364 的后备走；刹车不可削减，只能延期 |
| 本机约 36% 的进程打不开 | 刹车拒绝或剪边，弹窗里写明原因 |
| DSH 约 2 天发一个版本 | 按版本嗅探，降级为 `unknown`；手动 canary |

---

## 8. 第一步（脚手架）：具体内容

**目标**：半天内让仓库能跑 `.ts`、能跑测试、不会误提交大文件、二进制和 fixture。

**1. `.gitignore`**：原有内容保留，末尾追加：
```
# local runtime (Medium-IL node copy, ~94 MB)
.tools/
# binaries are built, never committed
*.exe
# fixtures: default deny; only reviewed synthetic fixtures and hand-written goldens are committed (r4 §6.1 #3)
fixtures/*
!fixtures/synthetic/
!fixtures/golden/
```

**2. `.gitattributes` 末尾追加**：
```
fixtures/** -text
*.zst binary
*.zstd binary
*.sqlite binary
*.exe binary
```

**3. `package.json`**：
```json
{
  "name": "dsh-orchestra",
  "version": "0.0.0",
  "private": true,
  "description": "DSH Orchestra daemon (orchestrad), M0 observe-first",
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=24.22.0" },
  "scripts": {
    "start": "node src/boot.ts",
    "test": "node --test \"test/**/*.test.ts\"",
    "check": "node --test \"test/repo/**/*.test.ts\" \"test/fs/**/*.test.ts\"",
    "build:procguard": "node scripts/build-procguard.ts",
    "scan:fixtures": "node --test \"test/fixtures/**/*.test.ts\""
  }
}
```
D-1 同意后再加 `"typecheck": "tsc --noEmit -p ."` 和两个 devDependency。

**4. `tsconfig.json`**：只给编辑器和将来的 tsc 用。
```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "strict": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowJs": true,
    "checkJs": true,
    "skipLibCheck": true
  },
  "include": ["src", "shared", "scripts", "test"]
}
```
vendor 文件经 `import type` 也会被类型检查。如果其中有不可擦除语法，就另建 `tsconfig.vendor.json`，对 vendor 关掉 `erasableSyntaxOnly`。运行时不受影响。

**5. `orchestra.cmd`**：`.gitattributes` 里已有 `*.cmd text eol=crlf`。
```bat
@echo off
setlocal
if not defined ORCHESTRA_NODE set "ORCHESTRA_NODE=%~dp0.tools\node24\node.exe"
if not exist "%ORCHESTRA_NODE%" (
  echo orchestra: node not found at %ORCHESTRA_NODE% ^(set ORCHESTRA_NODE^)
  exit /b 2
)
for %%I in ("%ORCHESTRA_NODE%") do set "PATH=%%~dpI;%PATH%"
pushd "%~dp0"
if /i "%~1"=="run" goto run
"%ORCHESTRA_NODE%" src\boot.ts %*
set "RC=%errorlevel%" & popd & exit /b %RC%
:run
"%ORCHESTRA_NODE%" --run %2
set "RC=%errorlevel%" & popd & exit /b %RC%
```

**6. `src/runtime/features.ts`**：
```ts
import * as zlib from 'node:zlib';
import * as nodeModule from 'node:module';

export type FeatureDeps = {
  nodeVersion: string;
  typescript: unknown;
  zlib: { createZstdDecompress?: unknown; zstdDecompressSync?: unknown };
  module: { registerHooks?: unknown; isBuiltin(name: string): boolean };
};

export type Features = {
  node: string;
  nodeAtLeastMin: boolean;
  zstd: boolean;
  registerHooks: boolean;
  sqlite: boolean;
  typeStripping: boolean;
};

export const MIN_NODE = [24, 22, 0] as const;

export function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function detectFeatures(deps: FeatureDeps = {
  nodeVersion: process.versions.node,
  typescript: process.features.typescript,
  zlib,
  module: nodeModule,
}): Features {
  return {
    node: deps.nodeVersion,
    nodeAtLeastMin: versionAtLeast(deps.nodeVersion, MIN_NODE),
    zstd: typeof deps.zlib.createZstdDecompress === 'function'
      && typeof deps.zlib.zstdDecompressSync === 'function',
    registerHooks: typeof deps.module.registerHooks === 'function',
    sqlite: deps.module.isBuiltin('node:sqlite'),
    typeStripping: deps.typescript === 'strip' || deps.typescript === 'transform',
  };
}

/** 按固定顺序列出缺失项，供控制台和 Tuning 显示。 */
export function missingFeatures(f: Features): string[] {
  const out: string[] = [];
  if (!f.nodeAtLeastMin) out.push(`node>=${MIN_NODE.join('.')}`);
  if (!f.zstd) out.push('zlib zstd');
  if (!f.registerHooks) out.push('module.registerHooks');
  if (!f.sqlite) out.push('node:sqlite');
  if (!f.typeStripping) out.push('typescript type stripping');
  return out;
}
```
- 用 `module.isBuiltin('node:sqlite')` 判断，不真去 import，因为步骤 1 之后 `node:sqlite` 只许 `db.ts` 引用（步骤 3 起是 boot 造好的 `store/node-sqlite.ts`；已核验 `isBuiltin` 返回 true）。
- 这里只检测、不做决定。缺什么之后怎么办，由步骤 2 的 `planStartup()` 决定，见不变量 9–10。

**7. `src/boot.ts`**：
```ts
import type { Features } from './runtime/features.ts';
import { detectFeatures, missingFeatures } from './runtime/features.ts';

type MainModule = { start(f: Features): Promise<void> };

export async function boot(entry: URL): Promise<void> {
  const f = detectFeatures();
  if (!f.sqlite || !f.typeStripping) {
    console.error(`orchestrad: cannot start, missing: ${missingFeatures(f).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  // 步骤 1 起：先在这里 installImportFence()；registerHooks 缺失时以缺特性退出码退出（第 2b 步恢复的拒绝）。
  // 这里的 2 是步骤 0 的旧值；第 2b 步起退出码都在 src/runtime/exit.ts 的 20–29 段，缺特性是 21。
  const main = (await import(entry.href)) as MainModule;
  await main.start(f);
}

if (import.meta.main) {
  await boot(new URL('./main.ts', import.meta.url));
}
```

**8. `src/main.ts`**：import 时没有副作用。
```ts
import type { Features } from './runtime/features.ts';
import { missingFeatures } from './runtime/features.ts';

export async function start(f: Features): Promise<void> {
  const missing = missingFeatures(f);
  const note = missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '';
  console.log(`orchestrad M0 scaffold on node ${f.node}${note}`);
}
```

**9. `src/runtime/env.ts`**：`resolveEnv({ home, env, launcherGlobs, extraHarnessRoots })` 返回一组纯计算出来的路径，不碰磁盘，也不调 `os.homedir()`：
- `orchestraHome`：`env.ORCHESTRA_HOME`，没设就是 `<home>\.orchestra`。
- `claudeRootCandidates`：`env.CLAUDE_CONFIG_DIR`、`<home>\.claude`、`$XDG_CONFIG_HOME\claude` 或 `<home>\.config\claude`，加上 `launcherGlobs`（默认 `~/.rec/claude/accounts/*/config`）。
- `launcherGlobPrefixes`：每个 glob 第一个 `*` 之前的字面前缀，例如 `<home>\.rec\claude\accounts`。
- `dshHome`、`codexHome`、`dshTuiHome`、`dsBotHome`（`<home>\.ds-bot`）。
- `knownHarnessRoots`：以上全部，加 `extraHarnessRoots`，不分大小写去重。写围栏的拒绝表和数据目录检查都用它。

只有 `main.ts` 用真实的 `os.homedir()` 和 `process.env` 调它。

**10. 第一批测试**：
- `test/runtime/features.test.ts`：
  - 当前运行时各项都为 true。
  - 注入假依赖（版本 22.14.0、`typescript:false`、空 zlib、`isBuiltin` 恒为 false）时，`missingFeatures` 按固定顺序报出 5 项，并且不抛异常。
  - `versionAtLeast` 的边界值。
- `test/runtime/env.test.ts`：
  - 注入假 home，候选根的顺序和去重都对。
  - `knownHarnessRoots` 包含 `.claude`、`.dsh`、`.codex`、`.dsh-tui`、`.ds-bot`、glob 前缀和额外根。
  - 不访问真实 home。
- `test/runtime/boot.test.ts`：用子进程跑 `src/boot.ts`，输出 scaffold 那一行，退出码 0。（步骤 0 的旧测试；开眼 §7.2 记下这种不带参数的启动跑过真实 profile。第 2b 步起 boot.ts 在 node:test 下不带参数以 24 拒绝，测试辅助也不许零参数启动，现在 boot.test 用测试 profile 跑。）
- `test/repo/hygiene.test.ts`：
  - `.gitignore` 里有 `.tools/`、`fixtures/*`、`!fixtures/synthetic/`、`!fixtures/golden/`。
  - `.gitattributes` 里有 `fixtures/** -text`。
  - `src/**`、`shared/**`、`ui/**` 里没有任何 import 指向 `spikes/`。
- `test/repo/load-all.test.ts`：动态 import 每个 `src/**/*.ts`（不含 `vendor/`），用了不可擦除语法、或 import 时有副作用，都当场失败。

**11. NOTICE**：把「This repository currently contains design documents and spike code only.」改为「This repository contains design documents, spike code and the orchestrad source.」。dsh-TUI 的 MIT 条目在步骤 8 vendor 时加。

**完成标志**：
- `orchestra.cmd run test` 5 个测试文件全绿。
- `orchestra.cmd` 打印出 scaffold 那一行。
- `git status` 里不再出现 `?? .tools/`。
- 在一个系统 Node 22 排在 PATH 前面的 shell 里，分别跑 `orchestra.cmd run test` 和直接 `.tools\node24\node.exe --run test`，把两者的差别记下来。
- 以上做完提交一次（由你点头），然后开始步骤 1。

---

## 附录　复核意见的处理

23 条全部应用，没有跳过。下面每条一行，写明应用的位置和做的调整。

1. （高）数据目录只检查了一个方向：已应用，见步骤 1–2 与不变量 1、5。另外补上了「`ORCHESTRA_HOME` 不得是盘符根」和「glob 字面前缀也算根」；DS-Bot 桌面版的数据目录由你在 Tuning 登记，不把个人路径写进公开源码。
2. （高）agent 能按人类动词：已应用，见测试 profile、代-2、AC6/AC8 两行和不变量 11。测试根改为登记 pid 后由 orchestrad 自己解析 createTime，并且命令行要带 fake-agent 标记。
3. （中）导入围栏挡不住静态 import：已应用，这次又复测了一遍。`getBuiltinModule` 的包装函数用全局默认白名单，不按调用方区分，因为没有模块正当需要它；禁用名单另加了 repl 和 cluster。
4. （中）完整性检查失败时放行：已应用。原计划的前提并非全错：S5 报告第 157 行确实见过 whoami 以 0xC0000142 退出。所以失败一律按 unknown 处理，走 ui-only。
5. （中）刹车弹窗的语义和 procguard 对不上：已应用，改成按子树出计划和执行。另外把生产版 helper 的 dryRun 改成遇到受保护节点也返回计划，不再在出计划之前就报错。
6. （中）保护名单只存在内存里：已应用，procguard 的 `protect` 同时改为按 pid:createTime 匹配。
7. （中）spawn 闸门放行整个可执行文件：已应用，见代-11；S4 的 b/c/f/i 用例移到 M1。
8. （中）SSE 在线不等于通知弹出、toast 冷启动太慢：已应用，通知路由并进步骤 5（线 B），另加 `toast-latency` 脚本。
9. （中）Codex 按 stat 判断变化会漏：已应用，见代-7。另外规定副本以读写方式打开（只在 tmp 里建 `-shm`），`-wal` 过大时降级并标低置信。
10. （中）排期自相依赖：已应用并重排，在线 B 增加了步骤 14 和 18A，步骤 15 按接口先做。按修订后的工作量重估：两条线约 14.5 天，一条线约 24 天（并入开眼第一、二档后分别是约 16.25 天和约 27 天；UI 设计第一轮后 16.5、28；第二轮计入 2b 和安全档后约 18.3、29.5；步骤 3 之后给步骤 4 加了两个决定，约 18.45、29.7，见 §4.1）。是否开第二个会话会花你的额度，所以列为 D-9 由你定。
11. （中）D-3 推迟 vendor 的理由不成立：已应用，改为照 r4 现在就 vendor（代-1）。用 `git show 71f5ac93:<路径>` 取文件，不受那边工作区改动影响。
12. （中）读真实根的脚本被豁免了扫描：已应用。冻结副本照建议放到 `%LOCALAPPDATA%`，这样它既在仓库外，也在写围栏的放行范围外。
13. （低）RSS 与洪泛阈值默认关闭：已应用，见 §2.2 第 12 条和代-9；按本机 27.8 GB 内存，阈值约 7 GB。
14. （低）DSH 文件闲置后重新发现太慢：已应用，分热集合和冷遍历两层，另加闲置后恢复写入的延迟测试。
15. （低）golden 的期望从哪来没说：已应用。没用「golden 比场景新就失败」这种 mtime 判定，因为 git 检出后 mtime 不可靠；改为期望写在场景里、golden 绑定 fixture 的哈希、不提供更新命令。
16. （低）DSH 和 Codex 的边：已应用，见步骤 9 和 14。
17. （低）`/connect` 的用法没说清：已应用，见步骤 15 与不变量 15。另外只收 `interactions=none` 的 URL。
18. （低）脱敏替换 env 值的范围太宽：已应用。没用「按变量名匹配秘密」的放行名单，改为排除固定的系统变量和路径型值，这样不认识的变量仍按 r4 默认替换，更保守（代-10）。
19. （低）rm 会跟随 junction：已应用，见步骤 1。
20. （低）`/api/pair` 的规则没定：已应用，见步骤 4，保留了「连错 5 次换码并冷却」。
21. （低）TUI 实测时 orchestrad 要同时开着：已应用，见 AC3 和在场清单第 3 条。
22. （低）缺可观测性得分和 canary：已应用，见步骤 18A；每晚定时跑列为 D-8，等你同意。
23. （低）要你定的事太多：已应用，D-3 到 D-6 和 r4 的措辞改动都改成代定（§2.3），只留 D-1、D-2、D-7、D-8。另外新增 D-9（实现线数），理由见第 10 条。

### 开眼修订的复核（2026-10-31）

14 条全部应用，没有跳过。每条一行。

- E1（高）`committedAt` 从 journal 重建不出来：已应用，用办法二。`committedAt` 取这批追加前的 `obsMono`/`obsWall`（在 journal 里）；fsync 加 db 事务做完的时刻 `commitDoneMono` 进 metric 旁表，只给「我方提交」一段用。见步骤 3 migration、`rebuild.test`、18A 拆段、§7 风险表。
- E2（中）18A 的依赖与线 C 合并对不上：已应用。依赖列改为「7、8、9、13、14；10–12 等线 C 第 14.5 天的合并」；18A 写明开头 0.25 d 先做不依赖 10–12 的部分；删掉「正好满足」。总工期不变。
- E3（中）提醒文字放进可清除的片段表：已应用。没触发、没取消的提醒片段钉住（照 r4 §6.1 第 4 条），触发或取消后解钉；db 整个丢失重建时提醒照样触发，文字显示「已丢失」。见 §2 存储行、`snippets.ts`、`rebuild.test`、`snippets.test`。
- E4（中）相位扫描悄悄提到第二档：已应用，用办法一。18A 写明这是偏离笔记分档及理由；步骤 19 的 I14 改为 0.25 d，第三档合计改为约 1.75 d（§4.1 表、算式、步骤 19 标题同步）。关键路径不变。
- E5（中）哈希链盖住整个 body：已应用，两种办法都用。链改为只盖 `digest`（和 r4 D3、原则 8、§6.1 第 2 条一致）；body 字段限 id、枚举、数字、digest、snippetRef，外加一张脱敏并过格式检查的源字符串名单（cwd、版本号、工具名、错误码，否则重建后项目名会丢）；schema 校验进 `journal.test`。
- E6（中）timerId 要确定：已应用。格式 `${class}:${entityId}:${seq}`，不用随机数；fixture 回放时实体 id 和 actionId 由场景给定；`clock.test` 加一例；步骤 13 改为照这个格式拼。
- E7（低）冻结清单漏了 journal 记录格式和 Clock 接口：已应用，见 §4.1 冻结点。
- E8（低）P2 行的步骤号不全：已应用，改为「步骤 3、10、11、13」。
- E9（低）游标同批提交只有 DSH 有测试：已应用。步骤 11、14 各加一句；`cursor-commit` 写成共用 helper，步骤 10、11、14 各加一例。
- E10（低）半行「丢掉」和「补换行」说法不一致：已应用，用办法二：截断到最后一个完整行再追加 `recovered`；`journal.test` 照此改。
- E11（低）I14 放不进线 C 的空档：已应用，在步骤 19 的 I14 下注明要等 18A 做完。
- E12（低）D-7 默认和新时间线可能对不上：已应用，只在 D-7 加提示，默认值没改。
- E13（低）步数算错：已应用，§0 改为 20 步。
- E14（低）超时转 toast 一路按构造超 2 s 只埋在验收表里：已应用，§7 风险表加一行，原样写出事实和「单列报告，由你判断」，没有新编 D 号。

- 2026-10-31 UI 交互设计：结论和取舍见 `docs/plans/2026-10-31-ui-interaction-design.md`；本计划据此改了 §0、§2 UI 行、§2.1（D-9 数字，新增 D-10 到 D-14；复核后加 D-15、D-16）、§2.2 第 13 条、§2.3 代-13、§3、§4.1、步骤 3/4/5/13/17/18A/19、§5 静默表与在场清单第 5 条、§6 第 13 条与新增第 22 条、§7，关键路径 16.25 → 16.5 天。第二轮（补听第一轮被截掉的挑战稿和第三份稿尾部、复核 40 条）见 UI 设计第八节末：新增 D-17 到 D-20，§2.1 加代价栏和名词解释，第 2b 步计入、安全档其余几条按 D-19 计入（§4.1 的 2b、2c 行），步骤 3 → 2.4 d、步骤 5 → 2.9 d，契约挪进步骤 3（`shared/protocol.js` 枚举、整个通知接口、`human` 两种记录），关键路径 16.5 → 约 18.3 天（只算 2b 约 17.45 天）。第二轮的复核（11 条，C1–C11）也都改了，估时不变：「停摆」改用单调钟判；除刹车外 `human` 与 `human.result` 同批写、孤儿一律补 `unknown`；刹车计划两只钟的写法统一；线 C 改在 2c 后开工、空档写明；D-12 加⑤；D-19 措辞两种选项都要答；关键路径注明最坏约 18.55 天（D-17 的抵扣是推断）。第三轮（同日）：照 HEAD 的代码并入第 2b 步（a83826d，已提交）的事实（锁没有心跳、daemon.json 每次启动写一次；退出码 20–26；缺 registerHooks 时 boot 以 21 退出、不 import main.ts；冻住持有者的测试默认就跑、不靠时间余量；停下就结束进程；`ports.fetch` 每次新造 init；node:test 下真实 profile 拒绝；ui-only 以 22 退出、不起 HTTP），见 §2 锁那行、§3、步骤 2、15、§5 在场清单第 10 条、§6 第 10、11、15、22 条；2c 只列另一个会话正在做的四件（§0、D-19、§4.1）；步骤 4 加 in-flight 表、dsh-connect 10 s 超时（M2）；「停摆」门槛改 max(3 × 间隔, 15 s)（L3）；刹车倒计时取两只钟的小者（L4）；步骤 6 先照接口写 Clock、第 8.0 天后接上（L5）；§2.1 名词解释加 D-19 的词（L6）。关键路径和串行天数不变。第三轮的复核（同日，20 条，照 HEAD 的代码核对）也都改了：测试根经 procguard 解析要到步骤 6 才做（第 2 步只有登记表），daemon.json 补 createTime 和 `lock.test` 的改法写进步骤 6；2b 没改 SpawnGate（白名单在第 2 步的提交里），步骤 6 等 2b 的理由改成 WriteIo 和停法；哑 io 的说法照代码改（rename 已经经 io，今天挡住自造写围栏的只有静态扫描）；安全档另两条（环境时钟、脚本也走 boot）不在 2c 里、没排，§0、D-19 的推荐默认、§4.1 照实写（默认没变）；刹车的 `human` 改在所有检查都过、调 procguard 之前写，in-flight 一过去重就登记、被拒当场删、和去重表在同一个同步回合交接，protect/* 的 procguard 超时算请求失败（推断）；§3 补 exit.ts、working.ts 和 start 的真实次序；node:test 下拒绝真实 profile 写上唯一例外；停下时要做的事放进 `stop()`；步骤 17 接上 toast 常量；步骤 3 的 Clock 接口照写的签名出。关键路径和串行天数不变。定稿前又收了 6 条小问题和一处代码事实（同日）：journal 断链改为打印原因、以 22 退出、进程内不放锁（两种 D-17 选项都这样；原写「先放掉锁」，和第 2b 步「停下就结束进程」相反）；刹车的 `human` 在检查顺序都过之后、执行第 1 步之前写，执行时核对没过的子树记 `refused`、照常写 `human.result`，页面多一种结果「没刹」；`TestRoots` 的几种拒绝在 HTTP 上都回 422 `not-test-root`；`protect/*` 的 procguard 超时回 503 `procguard-timeout`（推断）；测试根解析取命令行写成不变量 14 的例外；daemon.json「拿锁时写一次、步骤 6 补一次」；环境时钟并进步骤 3 的 Clock 扫描规则（算在 2.4 d 里），脚本也走 boot 仍没排。关键路径和串行天数不变。步骤 3 之后（同日，照 6a5471c 和 e451d4c 的代码，UI 设计第八节末）：2c 和步骤 3 标为已提交；并入八处偏差：① Clock 挂在 ClockHub 上（`hub.port(onFire | null)`、Fired 的键、`deadline` 类、seq 从 journal 算、`unregistered` 到步骤 10 才进 `TRANSITION_CLASSES`）；② `brake.plan` 的完整形状和 `planExpired(plan, planBootId, now)`，Command 和它的 `human.result` 同批；③ `human.result` 也带 verb、targetId，带问号的字段改成「可为 null、键总在」；④ journal 的批戳写进 commit 的 body、`commitDoneMono` 尽力而为、`journal.cut` 先宣告再截断；⑤ 帧与载荷形状步骤 3 起就在 `shared/protocol.js`，contract-freeze 只钉名字，树在步骤 4 末冻结；⑥ 改过的项目名过 `PROJECT_NAME_RE`，cwd 末段仍限 32；⑦ 片段 TTL 读时生效、每次启动扫一遍，定期清扫挪到步骤 4，摘要是安装密钥下的 HMAC；⑧ exit 锁死、`reallyExit` 由 boot 独占，有界刷新后结束（开眼笔记 §7.6 的翻案见 dd3d9d0），见 §2 入口行、§3、步骤 2、3、6、10、§6 第 2、19 条、§7。记下步骤 4 的两个决定：(a) 错误码 `bad-request`、`superseded-tab` 和新的检查顺序，(b) Store 的 db 私有、server 只拿写死 SELECT 的只读视图；步骤 4 1.8 → 1.95 d（+0.15，推断），关键路径 18.3 → 18.45 天（只做 2b 17.45 → 17.6，最坏 18.55 → 18.7、17.7 → 17.85），串行 29.55 → 29.7 天（四项全削约 26.2），线 C 末尾空档 0.3 − x → 0.45 − x。D-n 都没定，推荐默认都没改。之后又收两份复核（同日，28 条，有重叠，照 e451d4c 和 6a5471c 的代码核对），都改了：冻结点只说 contract-freeze 真钉住的部分（routes.ts、constants.js、source-report.ts 只是约定冻结），帧形状的名单补上 `S`；步骤 1 的 builtin 表和不变量 17 照 minted 的 node-io、node-proc、node-sqlite 改；D-19 的名词解释改成「2c 之前」；start 的次序和 `stop()` 写上步骤 3 已开库、关库；journal 补 `tornFinal` 例外和测试，`journal.cut` 记的是截后长度；`human.result` 也有部分唯一索引，`Store.commit` 拒 `duplicate-action`；§2 和第 3 条补 `install_key`、`applied_jseq`；Content-Type 不对回 400 `bad-request`、不算鉴权失败；查询参数形状不对也回 `bad-request`，日志只记固定的原因枚举，加金丝雀测试和「形状不对不是 actionId-missing」一例；tick 和定期清扫用 `poll` 类；`store-access.test` 只管 server 拿到的东西，metric 经只收（名字, 数值）的追加方法写；失效的保护条目不直接删行（推断）。线 C 还没开工：18.45 假定它第 5.6 天开工，从第 8.0 天开工约 20.0 天（推断，§4.1），D-10 的往回压反过来，D-20 的空档没了；只做 2b 的 17.6 现在省不回。估时不变，D-n 都没定，推荐默认都没改。第 3b 步（fd35af0）之后又照代码补了几句：run 和 procguard 的时限都按计时表编号（`tableSeq`，不是按 hub），步骤 6 照写；结束先定退出码、刷控制台的时限在任何 hub 之外、崩溃走 capture 回调，写进步骤 2；e451d4c 留下的三件里两件已修。另外，Node 要从里面加载代码的 fixture 各带自己的 package.json（`withModuleTmp`），包作用域的查找停在 fixture 里；整套测试从约 26 s 变成约 46 s，多出来的主要是 `boot.test` 里刷新时限的对照。
- 2026-10-31 UI 交互设计的复核（23 条，F1–F23）：23 条都改了；只有 F1 里「同步改开眼笔记 §7.5」一项没做（这次只许改本计划和 UI 设计），改为在 UI 设计第八节写明那一句要怎么改。改动：UI 设计加第九节，逐条对照开眼笔记 §7.3；新增 D-15（通知回执点、页头计数）、D-16（seen 从哪来），D-12 加④（冻结排序，照 r4 §10.9）；§0、§4.1 注明 UI 的 1.0 天取代开眼 §7.5 第二档，第一档、第三档还没算进总数；I20 并进步骤 5，步骤 19 合计 2.0 → 1.75 d；其余是步骤 3/4/5/6/13/15/18A 的写法和测试（连接状态、检查顺序、刹车结果字段、待定表、`bye{replaced}`、`clipped`、view-parity 排除字段、dsh-connect 的 digest、提醒字数上限）。关键路径不变。
