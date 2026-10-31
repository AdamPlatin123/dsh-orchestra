# S4 procguard：spike 报告（2026-10-30，复核后修订版）

本轮是复核后的修复。执行者在 00:56 UTC 跑完全部用例（results-mvu9hm2l.json）。复核者在 01:15 UTC 独立重跑（review-rerun-node22-mvua5jir.json），提了 10 条意见，结论成立。修复者在 01:36–01:52 UTC 改代码、重新编译并重跑：全量一轮 results-mvub86t3.json；d/e/i 一轮 mvub6z3q；g 一轮 mvubckop；f/i 三轮 mvubfwa6、mvubgt64、mvubh03n。下面的数字给三轮全量运行（执行者、复核者、修复者）的范围。d2a、d3c、d7、d8、e3、i 是复核后新增的用例，只有修复者的数据。所有时间都是 UTC。

## 1. 问题

规格 r4 §13.2 第 2345 行，原文照抄：

**要回答的问题**：用系统自带的 `csc.exe`（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` [核验]）编译约 300 行的 C# helper，作为常驻 JSON-lines 进程，提供 5 个命令：`run-in-job`（建 Job、KILL_ON_JOB_CLOSE、不设 `BREAKAWAY_OK`；以 CREATE_SUSPENDED 启动 → 加入 Job → 恢复；继承 stdio）、`snapshot`（Toolhelp32：pid、ppid、映像名、创建时间、工作集、命令行）、`kill-job`、`kill-tree{pid, createTime}`、`pipe-client-pid`；`run-in-job` 另提供一次性 stdio 模式与 `--env-allowlist <file>`（从零构造子进程环境，Tier 2 驾驭器用，§10.16）[dcu]

**go 判据**：杀掉 orchestrad 后，孙进程 `ping -t` 和 agent 启动的 dev server 都退出；DSH 沙箱内部的嵌套 Job 也随外层结束；Job 记账显示活动进程为 0。**r3 追加（+0.5 d）**：经 procguard 用 `run-in-job` 启动钉死的 playwright-mcp，对每个 chrome.exe 跑 `IsProcessInJob`，关闭 Job 后统计幸存者为 0，读 `chrome://sandbox` 确认渲染器沙箱仍在；Chromium 的渲染器自己也用 Job，Job 只在双方都不设 UI 限制时才能嵌套，所以我们的 Job 不设 UI 限制（成员关系、回收与渲染器沙箱此前都未核实）[cu]

简报 §4 允许两处替换：「DSH 沙箱」换成「第二个 helper 实例」，playwright-mcp 换成直接启动本机已装的 Chrome / Edge。本轮照此执行。

## 2. 结论

**go。** 判据按简报 §4 判：DSH 沙箱换成了第二个 procguard 实例，playwright-mcp 换成了直接启动浏览器；真实 DSH 在 S2 测。

理由：5 个命令都用系统 csc 编出来并跑通了。杀掉假 orchestrad 后，`ping -t` 孙进程和两个 dev server 在 0.93–1.42 s 内全部退出，从 orchestrad 真正退出算起只用 7–52 ms，HTTP 也随之不再应答。嵌套 Job 随外层一起结束。`kill-job` 后 ActiveProcesses 从 10 变成 0。Chrome 和 Edge 在快照时刻的进程全在我们的 Job 里，关掉 Job 后 0 幸存，渲染器仍是 Lockdown / Untrusted。

复核查出 procguard 自己的两个漏洞，都已修好并重测：
- kill-tree 对打不开的进程（createTime 为 0）不做身份核对，会把同 PPID 的孤儿收进计划。现在这种情况一律拒绝（identity-unknown）。
- 常驻模式下，并发的 run-in-job 会把一次调用的可继承句柄漏给另一次调用的子进程。现在改用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST。旧路径 4/4 次复现泄漏，新路径 0/4。

另有两处设计必须改，但不影响 procguard 本身成立：
- 便携 Node 24 的 `node.exe` 在本机带 **Low 完整性标签**。orchestrad 跑在它上面会写入失败（EPERM），它启动的 procguard 也只看得到约 13% 的进程（见 §6 第 1 条）。
- orchestrad（Node）**拿不到自己 named pipe 的句柄**，核实管道对端必须由 procguard 来做。有两条路：A 是 helper 持有管道服务端并转发；B 是 helper 扫描 orchestrad 的句柄表。B 已测通单连接（见 §6 第 2 条）。

## 3. 数字

测试条件：12 个逻辑核，跑测时其他进程把 CPU 占到 83–100%，系统里约 509–576 个进程，所以所有耗时都偏悲观。测试驱动用系统 Node 22.14（Medium 完整性），原因见 §6 第 1 条。

| 量 | 值 | 怎么测的 |
|---|---|---|
| 编译 | build.cmd 用时 1.1–1.6 s；修复后 out\procguard.exe 39,936 B（修复前 35,840 B）；ProcGuard.cs 678 行 | csc 4.8.9221.0（C# 5），`/platform:x64 /optimize`，只引用 System.Core 和 System.Web.Extensions |
| 基线：不用 procguard | 杀掉 Node 假 agent 4 s 后，PING.EXE 和它的 conhost 仍活着，且不在任何 Job 里。Node 22 和 Node 24 都是这样 | baseline 用例；按 pid + 创建时间核对 |
| 挂起创建 | 每轮全量运行都是 8/8 次在 ResumeThread 前已入 Job；spawn 18–134 ms。注意：Assign 成功后这一项必然为真，它说明顺序对，不是在测竞态 | ResumeThread 之前调 IsProcessInJob |
| a. 杀 orchestrad（helper 是普通子进程） | 共 13 个进程：helper，加 Job 里的 12 个（2 个 PING.EXE、2 个能应答 HTTP 的 dev server，其中一组是 Node 假 agent 的孙进程）。从 taskkill 开始到全部消失 937–1424 ms，其中 taskkill.exe 本身就占了 0.9–1.4 s；从 orchestrad 退出到全部消失 27–35 ms；三轮都是 0 幸存，HTTP 不再应答；之后按名字打开 Job 得 win32=2 | fake-orchestrad.mjs；`taskkill /F /PID`；observer 每 25 ms 用 alive 核对 |
| a. helper 设为 detached | 933–1188 ms / 7–52 ms / 0 幸存 | 只剩一条路：stdin EOF → helper 退出 → Job 句柄关闭 → KILL_ON_JOB_CLOSE |
| b. kill-job | ActiveProcesses 10→0 用 0.63–3.1 ms；10 个进程在 11 ms 内全部消失 | QueryInformationJobObject(BasicAccounting) |
| c. 嵌套 Job | 外层 Job 里起第二个 helper（一次性模式），它再建内层 Job 跑 ping。cmd、PING、conhost 这 3 个进程同时在内外两个 Job 里。外层 kill-job 后 6–7 ms 全部消失；外层 helper 收到 EOF 后 27–35 ms 全部消失。之后内层 Job 名字：4 轮里 3 轮已不存在（win32=2），1 轮（mvub86t3）还能打开，但活动进程为 0 | in-job + in-job-named |
| d. kill-tree 防护 | d1：createTime 加 1 → 拒绝，3/3 仍活。d2a：includeRoot 但没带根的令牌 → 拒绝（harness-root）。d2：默认只杀子孙，杀了 PING + conhost，用 154–169 ms，根 cmd 随后自行退出。d3：假 `dsh web` 不在我们 Job 里，只杀子孙也拒绝，连根杀不带令牌拒绝，带令牌杀掉 node + conhost。d4：explorer 判为 host:explorer.exe；winlogon 现在在名字规则之前就被 identity-unknown 拒绝。d5：PID 复用剪掉 1 条边，计划与预期一致。d6：杀自己、杀 orchestrad → 拒绝。**d7**：createTime 为 0 → identity-unknown。合成快照的计划为空；3 个打不开但有可打开子进程的真实根（services.exe、svchost.exe ×2）计划为 0、under 快照为 0；Secure System 也拒绝。**d8**：在我们 Job 里的假 `dsh web` → 不带令牌拒绝（owned-host:dsh-web-host），带令牌杀掉 | 系统进程和合成快照只做 dryRun |
| e. 管道对端 | e1：helper 当服务端时，client pid 等于 Node 的 pid，创建时间一致；换子进程来连，返回子进程 pid。e2：Node 当服务端时 `_handle.fd` = -1（Windows 上 Node 所有 stream 都这样，是设计如此）。**e3 路径 B**：helper 扫描 Node 的 File 句柄（35–36 个，其中 22 个是管道），2 轮共 6/6 次找到子进程是对端；每次 190–482 ms（句柄表扫描 60–83 ms）；0 超时，0 次复制失败 | GetNamedPipeClientProcessId；pipe-peers 不读对象名，每个句柄单独起线程、250 ms 超时 |
| f. --env-allowlist | Node 子进程只看到清单里的 3 个变量；`cmd /c set` 输出 6 个名字，多出的是 cmd 自己补的 COMSPEC / PATHEXT / PROMPT；父进程有 146 个变量；退出码 7 原样透传。常驻模式写文件：5 行。mvub86t3 那一轮读到 0 行，原因是测试只固定等 1 s，而 CPU 100% 时 cmd 还没写完；改成等子进程退出后 3/3 都是 5 行 | 一次性模式与常驻模式，只数变量名 |
| **i. 句柄继承（复核新增）** | 调用 A 建好 stdout 文件句柄后暂停 1 s，期间调用 B 启动 ping -t。旧路径：B 的子进程继承了 A 的文件句柄，A 的子进程退出后文件仍被占用（win32 32），4/4 次。新路径（HANDLE_LIST）：0/4 次。两条路径在 kill-job 后文件都被释放 | file-busy 用共享模式 0 打开文件；holdMs 和 legacyInherit 是测试专用开关 |
| g. Chrome 156.0.8078.47 | 快照时刻进程树 11–14 个，全部在我们 Job 里。同一时刻 Job 记账 Active 13–16，Job 自己的 pid 列表 15–16 个（包含树里全部进程，多出的是短命 utility），kill 时 TotalProcesses 25。系统范围内启动后新建的 chrome.exe：mvubckop 13/13 在 Job 内；mvub86t3 13/14，有 1 个不在，没查明是谁的（见 §5）。我们的 Job 0x2000、UI 0；Chromium 的渲染器 Job 0x2508、UI 0xFF（gpu / 部分 utility 的 Job 是 0x2108 / 0x2000、UI 0）；kill-job 2.0–7.5 ms 归零，2 s 后 0 幸存；chrome://sandbox 显示 7 个渲染器都是 Lockdown / Untrusted | job-info 的 pid 列表与快照背靠背取；job-handles 扫系统句柄表（约 26.5–27.4 万条，100–177 ms）；经 CDP 读 chrome://sandbox |
| g. Edge 156.0.4314.42 | 进程树 15–16 个全在 Job 内；Active 16–19；Total 25–27；启动后新建的 msedge.exe 15/15、16/16 在 Job 内；kill-job 2.0–3.2 ms 归零；0 幸存；9 个渲染器 Lockdown / Untrusted（最新证据文件；执行者那轮是 10 个） | 同上 |
| g. 临时 profile 目录 | 删除需要重试 1–9 次，用时 0.5–5.1 s；mvu8zfth 那一轮 Edge 的目录过了 10.5 s 仍报 EBUSY | rmSync 每 500 ms 重试一次 |
| h. helper 常驻 | 启动 351–683 ms（CPU 100% 时 649–965 ms）；工作集 26 MB、私有内存 20.5 MB；做完 20 次快照后工作集 34–36 MB、私有 28–30 MB | ready 事件、self 命令 |
| h. snapshot | 513–537 个进程：带命令行时 helper 内中位 50–62 ms（满载时最长 384 ms），往返中位 61–80 ms，结果 245–344 KB；约 187 个进程（36%）打不开 | 每轮 10 次；命令行用 NtQueryInformationProcess(60) 取 |
| Add-Type 对照 | Add-Type 编译一步：小类在负载最轻的一轮中位 0.98 s（0.90–1.20 s），各轮合计 0.86–5.4 s；本 helper 源码 1.0–6.3 s。只起 PowerShell 1.3–3.4 s。冷启动合计 2.2–9.3 s，随负载差一倍以上。工作集 67 / 74–76 / 75–78 MB。对比 procguard.exe：0.35–0.97 s、26 MB | powershell -NoProfile 每种 3 次；第一个数是 PowerShell 内 Stopwatch 量的，第二个是墙钟 |
| 便携 Node 24 | Low IL：写入报 EPERM；它启动的 helper 只看到 66–71 个进程，同一时刻 Medium 级别看到 505–537 个 | lowil-probe.cjs；icacls 显示 `G:\_Projects\DSH-plugins` 上有显式 Low 标签（OI CI NW），node.exe 继承了它 |
| 清理 | 每轮 finalSweep 都是 0 存活（全量一轮跟踪了 96 个进程）；按标记复查无遗留 | finalSweep + leftovers.mjs + 按 PID 的 Get-Process |

## 4. 方法与复跑命令

文件都在 spikes\s4-procguard\：
- ProcGuard.cs、build.cmd（编译到 out\，out\ 在 gitignore 里）
- test.mjs（扮演 orchestrad）
- fake-orchestrad.mjs
- fake-agent.mjs（用 child_process 起 ping -t 和 dev server）
- lowil-probe.cjs
- summarize.mjs（打印 §3 的数字）
- leftovers.mjs（按标记查遗留进程）

复核后新增的命令和参数：
- `pipe-peers {ownerPid}`：路径 B。
- `file-busy {path}`：查文件是否被占用。
- run-in-job 的测试专用参数 `legacyInherit`、`holdMs`。
- kill-tree 的 `includeRoot` 默认改为 false，连根杀要带根的令牌。

做法：先起一个只负责观察的 observer helper，每个用例再起自己的 helper。每个用例都等进程树就绪后再动手（PING 已出现、dev server 能应答 HTTP）。存活一律按 pid + 创建时间判断，从不按名字。每个用例结束和整轮结束时，把还活着的进程按 pid + 创建时间 kill-tree 掉（带 includeRoot 和全树令牌）。

```bat
cd /d G:\_Projects\dsh-orchestra\spikes\s4-procguard
build.cmd
set S4_SCRATCH=C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\spikes\s4-procguard
I:\npm\node.exe test.mjs
rem 只跑部分用例：I:\npm\node.exe test.mjs d e i g-chrome
I:\npm\node.exe summarize.mjs %S4_SCRATCH%\evidence\results-<run>.json
I:\npm\node.exe leftovers.mjs out\procguard.exe
```

全部用例约 2–2.5 分钟。必须用 Medium IL 的 Node。本 spike 不涉及 zstd，所以用系统 Node 22。用例名：baseline、a-attached、a-detached、b、c-kill-job、c-eof、d、e、f、i、g-chrome、g-edge、lowil、h、addtype，也可以只写前缀。g 用例会弹出一个最小化的浏览器窗口，用一次性 profile，跑完自己关掉。

证据在 scratchpad\spikes\s4-procguard\evidence\（共 18 个文件，约 306 KB）：
- results-mvu9hm2l.json：执行者的全量
- review-rerun-node22-mvua5jir.json、review-rerun-node24-mvualq7j.json：复核者
- results-mvub86t3.json：修复者的全量
- results-mvub6z3q.json：d / e / i
- results-mvubckop.json：g，带不在 Job 内进程的明细
- results-mvubfwa6.json、results-mvubgt64.json、results-mvubh03n.json：f / i
- results-mvu8pcl7.json：满载对照
- results-mvu8zfth.json：EBUSY 那一轮
- results-mvu9gj8t.json、results-mvu8okto.json：执行者的部分运行
- results-mvu6d3ls.json：前任的旧版，已作废
- g-sandbox-*.txt：最近一次 g 运行的 chrome://sandbox，每跑一次 g 就覆盖
- run-log-*.txt

## 5. 没验到的

- **真实 DSH 沙箱里的嵌套 Job**：本轮不允许起 dsh，所以用第二个 helper 代替（用例 c）。静态旁证：dsh-win32-process 0.2.1-rc.2（MIT）的 lib/index.js:5,538-545 只设了 KILL_ON_JOB_CLOSE，没有 UI 限制，全文件也没有 BREAKAWAY；:659、:693 用 CREATE_SUSPENDED 创建进程再入 Job，与用例 c 同构；spawnPipedProcess 那条路（:458）不建 Job，它起的进程也会留在我们的外层 Job 里。DSH 的子进程用 CreateProcessAsUserW 加受限令牌创建（:425-426、:693），orchestrad 能否打开它们（createTime ≠ 0）没查。打不开的话，kill-tree 会拒绝或剪掉，只能靠 kill-job。S2 时要把 DSH host 放进 run-in-job，再跑 job-handles、in-job、统计幸存者，并检查这些子进程能否打开。
- **playwright-mcp**：本机没装，也不允许下载，所以直接启动了浏览器。playwright 默认带 --no-sandbox（cu-windows-isolation.md:29），钉版本时要加 --sandbox，再重跑 g 用例。
- **mvub86t3 里那个不在我们 Job 的 chrome.exe**（14 个里有 1 个）：那一轮没记明细。启动前用户自己已有 29 个 chrome.exe 在跑；kill-job 2 s 后，用我们一次性 profile 的进程为 0；加了明细记录后重跑（mvubckop）为 0，复核者自己的检查也是 0。很可能是用户自己的 Chrome，但那一轮无法证实。
- **路径 B 的管道核实**：只测了单连接，没做负载，也没测 helper 崩溃时的影响。路径 A 的转发没实现。
- **§10.5 的父链识别**和**可配置的 UI 浏览器名单**：没实现。宿主只按映像名 + 命令行认，浏览器只认 Job 外的 chrome.exe / msedge.exe。
- 第 1877 行的 Raw Input、第 821 行按 pid 找窗口、R60 窗口状态修复：不在简报 §4 的范围内。
- ≤500 ms 轮询循环：只量了单次快照，没有实现循环。
- Job 关闭后是谁在占用 profile 目录（0.5–10.5 s 的 EBUSY）：没查出来，不允许下载 handle 工具。推测是杀毒软件或索引服务，未核实。
- 空闲机器上的耗时：跑测时 CPU 一直 83–100%，没在空闲时重测。Add-Type 的合计时间受影响最大。
- 36% 的进程打不开。kill-tree 现在对这类进程一律拒绝或剪边，但父链识别时看不见它们。提权场景没测（orchestrad 拒绝以管理员运行）。
- `G:\_Projects\DSH-plugins` 上的 Low 标签是显式设置的，同盘还能看到 CodexSandboxUsers 的 ACE。推测与 Codex 沙箱有关，未核实。
- c-eof 有 1/4 轮，所有进程消失后内层 Job 名字还能打开（活动进程 0）。应是对象还没释放，无害，没深究。

## 6. 对规格的影响

1. **第 585 行**（以及 517、588 行）：「orchestrad 跑在 G:\_Projects\DSH-plugins\.tools\node24\node.exe」改为「orchestrad 跑在一份不带 Low 完整性标签的便携 Node 24 副本上（例如首次运行时复制到 ~/.orchestra/runtime/node24/，或由用户本人去掉 G:\_Projects\DSH-plugins 上的显式 Low 标签）」。第 517 行的图不用改。第 588 行补一句：「启动时检查自身完整性级别，是 Low 就拒绝启动并在 Tuning 报错」。依据：Low 下写入 EPERM，快照只看到 66–71/505–537 个进程。
2. **第 1001、1995、2392 行**：「守护进程用 procguard 的 pipe-client-pid 核实对端」改为：「Node 在 Windows 上拿不到管道句柄（所有 stream 的 _handle.fd 都是 -1），由 procguard 核实对端的 pid + createTime。路径 B：procguard 扫描 orchestrad 自己的 File 句柄，复制后调 GetNamedPipeClientProcessId（S4 已测通单连接，每次 0.2–0.5 s，只适合在接入时查一次）。路径 A：procguard 持有管道服务端并转发（转发未实现）。S2 按每连接延迟和 helper 崩溃的影响二选一。」
3. **第 2345、1815 行**：「Job 只在双方都不设 UI 限制时才能嵌套」改为观察句：「实测（S4，直接启动 Chrome / Edge 156）：Chromium 的渲染器和部分 utility Job（LimitFlags 0x2508、UI 0xFF）嵌在我们不设 UI 限制的 Job（0x2000、UI 0）下面；按 cu 调研（cu-windows-isolation.md:43），外层设 UI 0x41 时 Chrome 起不来；所以我们的 Job 不设 UI 限制。」第 1815 行的「成员、回收、渲染器沙箱（未核实）」改为「已核实（S4 直接启动：进程全在 Job 内，kill-job 后 0 幸存，渲染器 Lockdown / Untrusted）；经 playwright-mcp 且带 --sandbox 待重测」。
4. **第 625 行**：只把「都（未核实）」改为「已核实（S4 直接启动 Chrome / Edge；经 playwright-mcp 且带 --sandbox 待重测）」。这一行没有 UI 嵌套那句话。
5. **第 487 行**：「libuv 的全局 Job 允许孙进程脱离，调研之外，S4 验证」改为「已证实：Node 22 与 Node 24 上，不经 procguard 时 ping 孙进程在杀掉 agent 4 s 后仍活着；放进 procguard 的 Job 后随 Job 一起被杀」。**第 3238 行**同步修改：嵌套 Job 已用第二个 procguard 验证（DSH 在 S2 测）；Koffi 备选没测（不需要）；约 20 次运行中没有遇到杀软拦截。
6. **第 2345 行后备栏**：「PowerShell Add-Type 常驻进程（启动约 1 s、约 60 MB，且先 spawn 再入 Job 之间有竞态）」改为「Add-Type 编译一步约 1 s，与实测相符；但冷启动合计 2.2–9.3 s（机器满载时测，空闲未测）、工作集 67–78 MB；先 spawn 再入 Job 有竞态」。不要写成「2–4 s」。
7. **第 2345 行「约 300 行」**改为「约 400–450 行」。spike 版 678 行，其中约 250 行是诊断和测试辅助，不影响工期。同一格的 run-in-job 描述补一句：「只让子进程继承它自己的 3 个 std 句柄（PROC_THREAD_ATTRIBUTE_HANDLE_LIST）」。依据：复核发现并发调用会互相泄漏句柄，用例 i 旧路径 4/4 次复现。
8. **第 1585 行**（§10.5 第 2 条）补一句：「根进程创建时间读不到（打不开，本机约 36% 的进程）时拒绝 kill，也不按 PPID 收它的子进程；连到打不开进程的边一律剪掉。」依据是复核发现：否则 createTime "0" 能通过身份核对，并把同 PPID 的孤儿收进计划。再补一个实例：同一轮测试里 PID 62372 先被一个 Node 子进程用过，十几秒后又分给了一个新 helper。
9. **第 1586 行**（第 3 条）补「本 spike 只按映像名 + 命令行实现，父链规则待实现」。**第 1589 行**补「procguard 把我们 Job 里的宿主记为 owned-host，同样要令牌；orchestrad 对自己的 DSH host 走 kill-job / 回收器」。**第 1592 行**补两点：conhost 只在它的控制台客户端不在被杀子树里时才受保护，否则任何控制台树都杀不掉；「承载 UI 的浏览器」名单要可配置。**第 1593 行**补「由 orchestrad 用 procguard 的 protect 命令按 pid 告知，procguard 自己按名字认不出来」。
10. **第 1595 行**（第 4 条）补：「procguard 的 kill-tree 默认只杀子孙（includeRoot=false）；连同根一起杀要带根的 pid:createTime 令牌；根是多会话宿主（如 dsh web）时，只杀子孙也拒绝（S4 d3）。」
11. **第 814、1873、1996 行**：常驻模式下子进程的 stdio 只能是 NUL 或文件。需要管道的 host 走一次性模式，由 Node spawn `procguard.exe run-in-job -- <host>`，stdio 和退出码透传已测（用例 f）。orchestrad 一死，包装器跟着死，它的 Job 随之关闭（与用例 a 同一条链）。在 host 的 Job 里启动的一次性包装器，其 Job 会自动嵌在 host Job 下面（用例 c）。第 1873、1996 行的 `--job` 在本实现里叫 `--name`（OS 层的 Job 名）。
12. **第 1755 行**：「procguard 轮询 ≤500 ms」改为「≤500 ms 一档只查 Job 的 pid 列表和 alive；全量快照（约 520 个进程，45–110 ms，满载最长 384 ms，245–344 KB）放到秒级」（推断）。
13. **第 1873、2006 行**：补「kill-job 几毫秒就完成，但临时 profile 目录可能还要 0.5–5 s（一次超过 10 s）才能删除，删除要延后并重试」。
14. **第 1996 行**：--env-allowlist 成立。cmd.exe 会自己补上 COMSPEC、PATHEXT、PROMPT；建议清单里保留 SystemRoot（推断；简单的 node -e 没有它也能跑）。
15. **第 2753、3353 行**：Chrome 的 Job 成员关系、回收与渲染器沙箱改为已核实（直接启动）。Raw Input 的 hDevice（第 1877 行）和按 pid 找窗口（第 821 行）仍未验证：S4 简报没覆盖，需要另排。
16. **S2 清单新增**：把 DSH host 放进 run-in-job，跑 job-handles、in-job、统计幸存者，并检查 DSH 受限令牌的子孙进程能否被快照打开（createTime ≠ 0）。钉 playwright-mcp 版本时，带 --sandbox 重跑 g 用例。

[核验] 事实核对：
- csc 路径成立（4.8.9221.0）。
- dsh-win32-process 0.2.1-rc.2 为 MIT，成立。
- 「libuv 允许孙进程脱离」成立。
- 「双方都不设 UI 限制才能嵌套」不成立，按上面第 3 条改成观察句。
- 「Add-Type 约 1 s」就编译一步而言成立；「约 60 MB」偏低 12–30%。
- 「orchestrad 跑在便携 Node 24」在本机按现路径不可行。

## 7. 费用与副作用

**模型调用**：0 次。执行者、复核者、修复者都没有起 claude、codex 或 dsh 会话。

**执行者**（00:28–00:59）：
- test.mjs 跑了 5 次（mvu8okto、mvu8pcl7、mvu8zfth、mvu9gj8t、mvu9hm2l）；另外 build.cmd 2 次、leftovers.mjs 3 次、csc -help 1 次。每次直接起的 PID 都记在结果文件的 spawnedDirect 里，每轮 finalSweep 都是 0 存活。
- 留下结果文件的浏览器启动：Chrome 4 轮（mvu8pcl7、mvu8zfth、mvu9gj8t、mvu9hm2l），Edge 3 轮（mvu8pcl7、mvu8zfth、mvu9hm2l）。执行者回忆各 5 次，多出的几次证据里查不到。
- 有两次 profile 目录 EBUSY，事后手动删掉。

**复核者**（01:13–01:30）：
- 重编译 1 次；Node 22 全量 1 次（mvua5jir）；Node 24 跑 baseline / a / b 子集 3 次（一次误重复，一次因为输出被 grep 滤掉重跑）。
- rv-check.mjs 2 次（Chrome、Edge 各 1 次，临时 profile 已删）；rv-ct0.mjs 1 次（只做 dryRun）；il-probe 2 次；leftovers.mjs 3 次。
- 自己起的 PID 都用 Get-Process 核对已消失。

**修复者**（01:36–01:53）：
- 重编译 1 次。
- test.mjs 跑了 6 次：d e i（mvub6z3q）、全量（mvub86t3）、g-chrome g-edge（mvubckop）、f（mvubfwa6）、f i 两次（mvubgt64、mvubh03n）。Chrome、Edge 各启动 2 次，都是最小化、一次性 profile、由 kill-job 结束，profile 目录由脚本自己删掉。
- leftovers.mjs 4 次。
- 直接起的 PID：
  - mvub6z3q：observer 35824、helper d 53780、假 dsh web 56436、helper e 63192、管道子进程 22844 和 54336、helper i 19468。
  - mvub86t3：observer 6572、基线 agent 60740、假 orchestrad 59512 和 64116、helper b 6316、c-kill-job 60588、c-eof 27116、d 16044、假 dsh web 59544、helper e 36112、管道子进程 32052 和 48092、helper f 28236、i 59944、g-chrome 56960、g-edge 39160、Node24 探针 19792 及其 helper 62644、h0–h4 57768 / 57668 / 59076 / 54564 / 35092、h-snap 49668。
  - mvubckop：57220、47132、61060。
  - mvubfwa6：12260、30868。
  - mvubgt64：56680、62628、36768。
  - mvubh03n：63280、50276、53908。
- 这 42 个 PID 结束时用 Get-Process 逐个查过，0 个在跑；系统里没有 procguard.exe，也没有 PING.EXE。

**结束进程的方式**：只用三种：kill-job；按 pid + 创建时间的 kill-tree；对我们自己起的进程按 PID 执行 taskkill /F /PID。从不按映像名杀。

**修复者的一次误写**：01:49:46 UTC，一条只读统计的命令里误留了 writeFileSync，在 `C:\Users\Calx\AppData\Local\pids-not-used.txt` 生成了一个 0 字节空文件。发现后立即删除，已核对不存在。内容为空，不涉及任何用户数据。

**临时文件**：tmp\ 已清空（0 个文件），evidence\ 保留 18 个文件，约 306 KB。

**仓库**：只写了 spikes\s4-procguard\ 下的文件：ProcGuard.cs、test.mjs、summarize.mjs、leftovers.mjs 有改动，另有 out\procguard.exe（在 gitignore 里）。没有 git add，也没有 git commit；spikes\ 下没有 .jsonl、.zst、.json 文件。

**零写入**：spike 代码没有在 ~/.dsh、~/.codex、~/.claude、%CLAUDE_CONFIG_DIR% 下创建或修改文件。唯一例外是 Claude Code 自己写的：执行者摘取前任转录时，有一次工具输出过长，被存成 %CLAUDE_CONFIG_DIR%\projects\G---Projects-dsh-orchestra\9a172ed9-...\tool-results\b5qnrp16h.txt（47,578 B）。这是 harness 对超长输出的常规落盘，该目录里同类文件共 109 个。修复者没有读它，也没有删它，理由见结构化结果的 notes。
