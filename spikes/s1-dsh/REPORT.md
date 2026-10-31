# S1-DSH 按帧 tail：报告

- 日期：2026-10-29（美东时间）。文中所有时刻都是 **UTC**（本机时区 UTC−4）。
- 三轮工作：
  - 执行者：前任 22:41–23:38 UTC 做了大部分测量，接任者 00:26–00:49 UTC 补测并起草报告；
  - 复核者：00:55–01:14 UTC，提出 S1-DSH-01…07；
  - 修复者：01:25–01:45 UTC，改代码、补测、写定本报告。
- DSH 版本：全局 `@deepseek-ai/dsh` 0.2.1-rc.2（`dsh-session-persistence-jsonl` 也是 0.2.1-rc.2）。
- 读日志用便携 Node 24（`G:\_Projects\DSH-plugins\.tools\node24\node.exe`，v24.22.0）。需要写草稿区的脚本用 dsh 自带的 npm 目录 Node 24.11（`C:\Users\Calx\AppData\Roaming\npm\node.exe`），因为便携 Node 在本沙箱里写草稿区会报 EPERM。
- 证据目录：`C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\spikes\s1-dsh\`。执行者的测量在 `evidence\`，修复者的结果在 `evidence\fixer\`，复核者的复跑在 `review\`。下文写 `fixer/xxx.json`、`review/xxx.json`，都是相对这个目录。

## 1. 问题

照抄 r4 §13.2 第 2343 行：

- **要回答的问题**：DSH v4 日志由许多独立的 zstd 帧组成（每帧 83 B–62 KB，带校验，windowLog 21）[核验]。用约 40 行的帧遍历器，每个完整帧调一次 `zstdDecompressSync`，游标就是下一帧的字节偏移；测 DSH 的 flush 节奏。
- **go 判据**：延迟 ≤2 s
- **no-go 时的后备**：`storages/session_projcache`、只读 web attach；验收改为「有文档记录的后备延迟」

顺带验证第 2348 行：活跃文件对已打开的句柄每 ≤1 s 做一次 `fstat` 轮询，不依赖 `fs.watch`（Windows 上被占用文件的目录项更新可能滞后）。

## 2. 结论

**go，附一条例外。**

**按帧 tail 走得通。** 在一次真实的 DSH 会话里，21 个事件从 DSH 记下（事件里的 `time`）到我们解出那一帧，最多用了 0.79 s（100 ms 轮询）或 1.71 s（1 s 轮询），全部在 2 s 以内。读取方自己只增加「一个轮询间隔 + 约 0.1 s」。

**例外出在 DSH 那一侧，读取方改不了。** DSH 不是来一条写一条，而是把 200 ms 内的事件攒成一批，压成一帧再 fsync。遇到下面三种情况，事件会在 DSH 的内存里压得更久：

- 写链忙；
- 会话刚启动，写句柄还没接管，或首次物化还没完成；
- 上一次后台写失败，进入 drainPaused。

在现有 166 个日志里，99,634 条事件中有 10 条（约万分之一，来自 2 个会话）光在 DSH 里就压了 2 s 以上，最长 5.1 s，其中 8 条在会话启动的第 1 帧。这部分无论怎么读都会超过 2 s，所以 r4 的验收要写明这条例外（§6）。

后备方案帮不上这条例外：projcache 只会比日志更晚（§3.8）。web attach 理论上能直接拿到总线上的事件，但这次没测。

**本轮修好的读取器缺陷。** 旧版 FrameTail 遇到「两次轮询之间先截短、再追加」会永久卡死（复核者 S1-DSH-03 复现）。DSH 修残缺尾部和回滚失败的追加时，正好会出现这种情况。现在每次轮询都从游标重新读，9 个落盘用例全部通过（§3.2）。

**规格要改两处：**

- 帧大小区间「83 B–62 KB」不对，实测是 77 B–1.4 MB；
- 轮询间隔建议 250 ms。这是为了留余量，并不能保证 ≤2 s（§3.5）。

## 3. 数字

所有计时都在本机 CPU 占用约 98–100% 时测得（有别的工作负载在跑），数字偏保守。帧序号从 0 起，第 0 帧是头帧。

### 3.1 帧结构（全部 166 个 v4 日志，只读）

| 量 | 值 | 怎么测的 |
|---|---|---|
| zstd 文件 | 207 个：v4 166、旧版 `session.jsonl.zstd` 38、v3 3；另有 5 个 `*.bak*`（只数了个数，没打开） | `evidence/corpus-stats.json` 的 filesByName |
| 会话目录 | 206 个，分属 13 个项目目录：`<uuid>` 114、`session-<uuid>` 92；其中 40 个没有 v4 文件 | find 按目录名计数；`fixer/discovery-walk.json` |
| 总量 | 压缩 108,164,706 B → 明文 389,328,203 B；55,980 帧；107,604 行 = 166 个头 + 107,438 条事件（其中 5,025 条在 3 个整文件迁移帧里；其余 102,413 条，平均每帧约 1.8 条） | corpus-stats.json；`fixer/poll-real-readonly.json` |
| 帧大小 | 最小 **77 B**、中位 495 B、p90 4,658 B、p99 20,699 B、最大 **1,473,976 B** | corpus-stats.json frameBytes |
| >64 KiB 的帧 | 23 个，分三类：<br>· 17 个 2–9 行的实时批，最大 143,345 B，多数是带大 `assistant/message` 的 2 行批<br>· 1 个 28 行的实时压缩批（`compaction/prune`，跨度 223 ms）<br>· 5 个迁移重写帧：3 个是整份文件只有 1 帧，另 2 个是第 1 帧（分别 2,215 行、503 行）<br>（更正：原来写的是「6 个迁移帧」，见 S1-DSH-05） | `evidence/outliers.json` |
| 带校验 | v4 55,980/55,980；旧版 24,113/24,113；v3 315/315 | 帧头描述符 bit 2 |
| windowLog | 21 的有 55,977 帧；23 的 1 帧（整文件迁移帧）；另有 2 个单段帧（也是整文件迁移帧，没有 window 描述符） | corpus-stats.json；outliers.json |
| 每帧行数 | 1 行 42.0%（含 163 个只有头的第 0 帧）；2 行 44.3%；3 行 10.6%；4 行及以上 3.1%。58.0% 的帧有 2 行以上 | linesPerFrameHist、multiEventFrames |
| 同帧时间跨度 | 统计范围：第 0 帧以外、至少有 2 条带 `time` 事件的 32,461 帧。中位 3 ms、p90 18 ms、p99 168 ms。<br>>250 ms 的 80 帧里，75 帧是 ≤10 行的普通实时帧，3 帧是 11–50 行，只有 2 帧是迁移重写。<br>（更正：原来写的是「这 80 个都是迁移帧」，不对，见 S1-DSH-01） | corpus-stats.json；`fixer/dsh-hold.json` spreadByLines |
| 帧间隔 | 中位 894 ms、p90 16.1 s | interFrameGapMs |
| 事件外层键 | 每条都有 type / seq / time / data；32,205 条带 surfaceOp；15,690 条带 sourceEventSeqs；共 52 种 type | eventKeys、types |
| 头的键 | type、version、id、createdAt、cwd、isSeeded、delegationDepth；有时还有 agentPreset、parentSession、origin | corpus-stats.json；`evidence/live-tail.json` |
| 复跑一致性 | corpus-stats 前任、接任、复核共跑了 3 次，除计时外逐字段相同；复核重跑 outliers、projcache-lag，结果完全相同 | `evidence/corpus-stats-rerun.json`、`review/*.json` |

### 3.2 正确性

| 量 | 值 | 怎么测的 |
|---|---|---|
| 遍历器大小 | parseFrame + walkFrames 共 33 行（`frame-tail.mjs` 第 13–46 行，不计空行）；FrameTail 47 行 | 数行 |
| 随机分块喂入 | 按大小均匀挑 20 个真实日志（6,333 帧、11,501 行），随机切成 831 块（1 B–64 KiB），逐块喂给 `ingest()`。帧边界、行数、type 序列都与整文件解码一致，0 个不符 | `fixer/selftest.json` |
| 截断探针（本轮新增，替代旧的 earlyEmits） | 对这 20 个日志的每一帧都截断测试，截断点包括：帧头内、每个块头内和块头之后、每个块的末字节前后、4 字节校验内、2 个随机位置，共 94,452 次。<br>结果：截断时 parseFrame 都返回 null，完整时都返回正确的帧尾；提前吐帧 0 次，帧尾算错 0 次 | `fixer/selftest.json` |
| 探针确实能抓到 bug | 故意删掉 parseFrame 里校验位之后的越界检查，再在校验位的 4 个字节处截断：4,864 次探针全部报出「提前吐帧」。<br>旧的 earlyEmits 在同一变异下仍是 0：ingest 之前游标已经加上了块长，`fr.end > off` 永远不成立（S1-DSH-06） | `fixer/selftest-mutation.json` |
| 合成用例 | 全部通过：<br>· skippable 帧、RLE 块、raw 块、单段帧、无校验帧都能正确遍历<br>· 残缺尾帧：留在 pending，游标停在帧边界，补齐后再吐出<br>· 坏校验：停在坏帧，坏帧之前的帧照常返回，游标停在坏帧起点<br>· 坏 magic：抛错 | `fixer/selftest.json` synthetic |
| poll() 落盘用例（本轮新增，只用合成数据，S1-DSH-03） | 8 个行为用例全部通过：<br>· 截短后追加更长的帧<br>· 截短后追加等长字节（文件大小不变）<br>· 截短后文件比原来短，且仍是半帧<br>· 半截追加 → rollback → 重试<br>· 删除后在原路径重建另一个文件（长度不小于旧游标）→ 从 0 重读并标 reset<br>· 文件变得比游标短 → reset<br>· 原地重写后游标落在帧中间 → 连续 3 次轮询报错，然后 reset<br>· 301 帧拆成 727 次随机写入（共 1.57 MB），每写一次轮询一次<br>第 9 个用例只记录一个事实：读取方开着句柄时，用 rename 覆盖该路径会报 EPERM | `fixer/polltest.json` |
| 复核者的复现脚本 | 用新版 FrameTail 跑 `review/truncregrow.mjs`：<br>· case1：第 2 次轮询解出 1 帧，游标 1,492；第 3 次游标 2,932<br>· case2：游标 1,484<br>三处都与期望值相同。修复前，case1 第 2 次轮询就抛 bad zstd magic，之后一直卡住 | `fixer/truncregrow-after-fix.json` |
| 真实日志上跑新版 poll() | 只读打开全部 166 个 v4 日志，每个 poll 两次：共 55,980 帧、107,604 行；与 walkFrames 0 处不符，0 个错误，0 次 reset；第二次 poll 没有新帧；共用 13.9 s | `fixer/poll-real-readonly.json` |

### 3.3 flush 节奏，以及 DSH 自己会把事件压多久

**正常路径**（读 `dsh-session-persistence-jsonl/lib/index.js`）：

1. 第一条事件到来、且当前没有定时器时，`enqueueLive` 启动 `setTimeout(200)`（第 187–194 行）。
2. 定时器到点后，`drainBuffered` 把缓冲区里的事件整批取出（第 205–221 行）。
3. 一批事件压成一个带校验的 zstd 帧（第 1296、1374–1376、3279–3282 行）。
4. `appendLines` 写入：`open('a')` → `stat` → `writeFile` → `sync` → `close`。写失败时，`rollbackAppend` 把文件截回原长度（第 3299–3335 行）。

另外，残缺尾部会在下一次追加前截掉，截完紧接着就追加（第 222–235 行）。所以两次轮询之间，文件可能先变短、再变长。

**会压得更久的三条路径**（复核者 S1-DSH-01 指出，修复者核对过代码）：

1. **写链忙。** 批次要等 `enqueueChain` 轮到时才从缓冲区取出（第 211–213 行）。等待期间新来的事件继续进缓冲，最后一起写进同一帧。
2. **会话刚启动。** `registerCreated` 把 `writers` 里该会话设为 null（第 302 行），写句柄 `adopt` 之前，`writers.get(id)?.enqueueLive` 什么也不做（第 422 行）。首次写入还要先物化：逐级建目录（mkdtemp + MoveFileExW），写临时文件，再用 MoveFileExW 发布到一个还不存在的路径（第 539–549、2907–2920、3240–3250 行）。物化完成之前，日志文件根本不存在。
3. **drainPaused。** 后台写失败后 `drainPaused` 置真（第 213–217 行），此后 `enqueueLive` 不再启动定时器（第 189 行）。事件会一直压到下一次 `session/flush`，也就是模型请求前的检查点、空闲检查点或退出时（`dsh-session/lib/index.js` 第 1938–1951 行的注释）。如果观察器用挡写的方式打开日志，DSH 的追加就会失败，正好进入这条路径。

| 量 | 值 | 怎么测的 |
|---|---|---|
| DSH 侧压住时长的下限 | 下限的算法：同帧里最晚一条事件的 `time` 减去本事件的 `time`。统计 99,634 条事件（只看 ≤50 行的帧）：中位 0、p90 7 ms、p99 132 ms、p99.9 408 ms、p99.99 2,316 ms、最大 5,105 ms。>500 ms 的 70 条，>1 s 的 21 条，>2 s 的 10 条。这些还不含任何轮询时间 | `dsh-hold.mjs` → `fixer/dsh-hold.json`；复核者 `review/holdlb.json` 得到同样的 99,634 / 21 / 10 |
| >1 s 的 21 条 | 15 条在第 1–2 帧（会话启动）：permission/preset 5、sandbox/mode 5、approval/policy 3、session/title 1、model/selection 1。<br>6 条在会话中途：approval/decided 2、subagent/catalog 4 | 同上 |
| >2 s 的 10 条 | 8 条在 file 105 的第 1 帧：11 行，跨度 5,105 ms，最大的空档（4,280 ms）在 approval/policy 与 agent/inbox/spliced 之间，会话 2026-10-20 创建。<br>2 条在 file 154 的第 335 帧：一阵 subagent/catalog 突发，12 行，跨度 2,915 ms，会话也是 2026-10-20 创建。<br>≤10 行的帧里，没有一帧跨度超过 2 s | 同上；`review/spread2.json` |
| 这两帧分别是哪条路径造成的 | file 105 是路径 2（会话启动），file 154 是路径 1（写链忙）。这是推断：两个会话由哪个 DSH 版本写的不知道，DSH 内部也没有打点 | — |
| 追加 + fsync 的代价 | open + stat + write 中位 3 ms；fsync 中位 1.2 ms；合计中位 4.7 ms、p99 664 ms | `fsync-bench.mjs` 在草稿区 C 盘跑 60 次 → `evidence/fsync-bench-C.json` |

### 3.4 实跑（只跑过一次，隔离的 DSH_HOME）

延迟 = 我们解出那一帧的时刻 − 事件里 DSH 记的 `time`。这包含 200 ms 攒批、压缩、fsync，再加上我们的轮询间隔。

| 量 | 值 | 怎么测的 |
|---|---|---|
| 会话 | 命令：`dsh --profile headless --json "Reply with one word: ok"`，退出码 0。<br>时间线（UTC）：23:25:12.8 启动 dsh，23:27:20.8 会话创建（createdAt），23:27:34.4 退出。<br>产出：日志 11,319 B、7 帧、21 个事件 | `run-live.sh` + `live-tail.mjs` → `evidence/live-tail.json`、`live-run-times.json` |
| fstat 轮询 100 / 250 / 500 / 1000 ms | 最大延迟依次为 787 / 926 / 1,190 / 1,708 ms，>2 s 的都是 0 个；100 ms 时中位 221 ms | live-tail.json |
| 只靠 fs.watch | 最大 5,577 ms，有 6 个事件 >2 s，原因在测试脚本：<br>· 这 6 个是 seq 0–5（第 1、2 帧），在 +93…+184 ms 就已写下；<br>· watcher 到 +680 ms 才挂上，而当时的脚本挂上后没有先读一次，只能等第 3 帧（+5.7 s）触发回调；<br>· 挂上之后 4 帧触发了 4 次回调，没有漏。<br>本轮已在 `live-tail.mjs` 里补上「挂上后先读一次」；现有证据是旧版脚本产生的 | `evidence/live-frames.json` |
| 各帧首事件 → 解出（100 ms 轮询） | 第 1、2 帧：787、768 ms。这里包含物化落盘（会话创建后约 0.66 s 文件才出现），以及我们到 +680 ms 才发现文件。<br>实时的第 3–6 帧：221、387、356、170 ms | live-frames.json |
| 帧属性 | 7 帧都是 windowLog 21、带校验；第 0 帧是头（250 B），其余 6 帧每帧 2–7 个事件 | live-frames.json |
| 其它时序 | 最后一帧比 stdout 的 final 早 103 ms 落盘；projcache 比最后一帧晚 241 ms | `evidence/live-stream-ts.jsonl`、projcache mtime |
| 只读句柄不挡 DSH | 5 个读取方用 Node `'r'` 打开日志、一直不关，DSH 照常追加了 4 帧，退出码 0，stderr 为 0 字节 | live-tail.json、live-run-times.json |

### 3.5 复刻写入方（照搬 DSH 写法：200 ms 窗口，一批一帧，fsync）

| 运行 | 写入方首事件 → fsync 完成 最大 | 100 ms 轮询 最大 | 250 ms | 500 ms | 1000 ms | 1000 ms 时 >2 s | 1000 ms 时 fsync 完成 → 解出 最大 |
|---|---|---|---|---|---|---|---|
| run1（前任，旧版脚本，没有分阶段计时） | 2,180 | 1,756 | 1,925 | 1,986 | 2,470 | 3 / 134 | 1,004 |
| run2（前任） | 1,577 | 1,227 | 1,250 | 1,497 | 2,192 | 2 / 107 | 1,051 |
| run3（复核者，CPU 100%） | 449 | 542 | 559 | 835 | 1,209 | 0 / 122 | 983 |

单位 ms。来源：`evidence/latency-replica-run1.json`、`run2.json`，`review/latency-replica-run3.json`。只靠 fs.watch 时，三次的最大延迟是 1,876 / 1,515 / 407 ms，回调次数 74/74、65/65、68/68 批，没有漏。

**怎么读这张表（更正 S1-DSH-02）：**

- 读取方那一段（fsync 完成 → 解出）最多约等于一个轮询间隔：1 s 轮询时是 983–1,051 ms。
- 1 s 轮询下超过 2 s 的 5 个事件，主要原因是写入方自己卡了 1.5–2.2 s，读取方又等了一个间隔。
- 500 ms 轮询在这三次里没有超过 2 s，但 run1 只差 14 ms。
- 真实 DSH 实跑在 1 s 轮询下最大 1.71 s，没有超过。

所以结论不是「≤1 s 不够、≤500 ms 就够」，而是「延迟 = DSH 侧 + 轮询间隔」。DSH 侧卡顿时，任何轮询间隔都保证不了 ≤2 s。建议 250 ms，只是为了留余量。

### 3.6 fs.watch 对比 fstat（核对规格「目录项更新可能滞后」那句）

| 写入方式 | fstat / stat(path)（50 ms 轮询） | fs.watch | 目录项里的大小 | 来源 |
|---|---|---|---|---|
| 句柄一直开着，不 fsync | 最大约 0.2–0.6 s | 30 s 里只回调 1 次（关句柄时） | Node 写入方：中位 14.2–14.5 s、最大 30.4–30.9 s<br>PowerShell 写入方：中位 16.3 s、最大 30.2 s<br>复核者重跑（PowerShell）：中位 14.2 s、最大 30.4 s | `evidence/watch-held.json`、`watch-ps-held.json`、`review/watch-ps-held.json` |
| 每次写后 fsync | 最大 ≤0.57 s | 每次写入都回调（最大 345 / 40 ms） | Node：p90 12.6 s<br>PowerShell：p90 102 ms | `watch-held-fsync.json`、`watch-ps-held-fsync.json` |
| 每次打开-写入-关闭（DSH 的写法） | 最大 ≤0.57 s | 每次都回调（最大 640 / 38 ms） | Node：p90 7.7 s<br>PowerShell：p90 109 ms | `watch-reopen.json`、`watch-ps-reopen.json` |

7 次实验里，fstat 和 stat(path) 都没漏过增长。DSH 每批都 fsync 并关句柄，所以 fs.watch 对 DSH 有效，但不能作唯一依据。

### 3.7 全量遍历与冷启动

| 量 | 值 | 怎么测的 |
|---|---|---|
| corpus-stats（读 + 遍历 + 逐帧解压 + 解析） | 3 次运行：墙钟 17.9–28.7 s，峰值 RSS 188.5–194 MiB。其中遍历 25–153 ms、解压 9.5–16.9 s、解析 7.5–11.1 s | corpus-stats.json、corpus-stats-rerun.json、`review/corpus-stats.json` |
| 冷启动解压（文件已在内存，每项测 3 次取中位） | 2 次运行：<br>· 读盘 330–458 ms，只遍历 9–11 ms<br>· 逐帧解压 8.3–13.3 s（每帧 148–237 µs）<br>· 整段一次解压 2.2–3.7 s，逐帧比整段慢 3.6–3.8 倍<br>· RSS 148 MiB | `evidence/bench-decode.json`、`review/bench-decode.json` |
| 最大的文件（6.5 MB / 5,013 帧） | 逐帧 644–843 ms，整段 110–217 ms | 同上 top5 |
| 新版 FrameTail.poll() 读完全部日志 | 13.9 s | `fixer/poll-real-readonly.json` |

### 3.8 projcache（只比 mtime）

206 行，其中 163 行能对上 v4 日志。滞后中位 177 ms、p90 4,794 ms，没有一行比日志更新得早。方法：`projcache-lag.mjs`，只 stat、不打开文件 → `evidence/projcache-lag.json`。

### 3.9 其它

| 量 | 值 | 怎么测的 |
|---|---|---|
| 会话发现 | 走一遍「readdir 项目目录 → readdir 会话目录 → stat v4 文件」：13 个项目、206 个目录、166 个 v4 文件，用时 20–30 ms（跑了 5 次） | `fixer/discovery-walk.json` |
| 读取方开着句柄时用 rename 覆盖 | 报 EPERM。先删除再重建可以：删除后名字立刻释放，新文件的文件标识也不同 | `fixer/polltest.json`，以及修复者的一次性探针 |
| DSH 冷启动（空 DSH_HOME） | `--help` 用 121 s；实跑从启动到会话创建 128.0 s；会话本身（从创建到退出）13.6 s | live-run-times.json；前任转录中 `--help` 的计时 |
| 机器负载 | CPU 约 98–100%：前任采样 99.97%，接任 98.4%，复核者 100% | Get-Counter `Processor(_Total)` |

## 4. 方法与复跑命令

代码都在 `G:\_Projects\dsh-orchestra\spikes\s1-dsh\`：

| 文件 | 做什么 |
|---|---|
| `frame-tail.mjs` | 帧遍历器（parseFrame / walkFrames）和 FrameTail。本轮改过：<br>· 每次轮询都从游标重读<br>· 比较 stat(path) 与 fstat(fd) 的文件标识<br>· 坏帧之前的帧照常返回；连续 3 次轮询都坏就 reset<br>命令行：`scan <file>`、`follow <file> [--interval ms]`，默认 250 ms |
| `selftest.mjs` | 真实日志随机分块、截断探针（本轮新增）、合成用例；只在内存里跑，只读 |
| `polltest.mjs` | 本轮新增：poll() 落盘用例，只用合成数据，跑完删掉自己的文件；需要能写草稿区的 Node |
| `dsh-hold.mjs` | 本轮新增：同帧跨度分桶、DSH 侧压住时长的下限（合并并扩展了复核者的 spread2 / holdlb） |
| `corpus-stats.mjs`、`outliers.mjs` | 帧结构统计、异常帧清单 |
| `bench-decode.mjs`、`bench-cold.mjs` | 冷启动时逐帧解压与整段解压的对比 |
| `projcache-lag.mjs` | projcache 与日志的 mtime 差 |
| `latency-replica.mjs` | 复刻 DSH 写法的写入方，加上 5 个读取方（4 档 fstat 轮询 + fs.watch） |
| `fsync-bench.mjs` | DSH 追加 + fsync 的代价 |
| `watch-vs-fstat.mjs`、`watch-writer.ps1` | fs.watch、fstat、目录项三者对比（Node / PowerShell 写入方） |
| `run-live.sh`、`live-tail.mjs`、`stream-ts.mjs`、`live-frames.mjs` | 唯一一次实跑，以及它的按帧时间线（会调模型） |

复跑命令在 Git Bash 里执行。输出写进带 UTC 时间戳的新目录，不覆盖原有证据。不调模型的部分大约 4 分钟。

```bash
N24=G:/_Projects/DSH-plugins/.tools/node24/node.exe     # 读日志（只读），有 zstd
NW=C:/Users/Calx/AppData/Roaming/npm/node.exe            # 需要写草稿区的脚本用它（Node 24.11）
S=C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/spikes/s1-dsh
R="$S/evidence/rerun-$(date -u +%Y%m%dT%H%MZ)"; mkdir -p "$R" "$S/tmp"
cd G:/_Projects/dsh-orchestra/spikes/s1-dsh

# A. 只读用户日志，不写任何文件（stdout 重定向到 $R）
"$N24" selftest.mjs C:/Users/Calx/.dsh/sessions 20 > "$R/selftest.json"   # 约 9 s，看 allPass
"$N24" corpus-stats.mjs > "$R/corpus-stats.json"                           # 20–30 s
"$N24" outliers.mjs > "$R/outliers.json"                                   # 约 20 s
"$N24" dsh-hold.mjs > "$R/dsh-hold.json"                                   # 约 20 s
"$N24" projcache-lag.mjs > "$R/projcache-lag.json"                         # <1 s
"$N24" bench-decode.mjs > "$R/bench-decode.json"                           # 约 60 s

# B. 只写草稿区 tmp，只用合成数据
"$NW" polltest.mjs "$(cygpath -w "$S/tmp/poll")" > "$R/polltest.json"      # 约 2 s，看 allPass
"$NW" latency-replica.mjs --writer "$S/tmp/replica/run.v4.jsonl.zstd" 60 & \
  "$N24" latency-replica.mjs --reader "$S/tmp/replica/run.v4.jsonl.zstd" 60 > "$R/latency-replica.json"; wait   # 60 s
F="$S/tmp/watch/held.log"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$PWD/watch-writer.ps1")" "$(cygpath -w "$F")" held 30 3000 2> "$R/watch-held-writer.txt" & \
  "$N24" watch-vs-fstat.mjs --reader "$F" 30 > "$R/watch-held.json"; wait  # 30 s；held 可换成 held-fsync / reopen（每次换一个新文件名）
rm -rf "$S/tmp/poll" "$S/tmp/replica" "$S/tmp/watch"                       # 清理

# C. 只读跟踪一个日志
"$N24" frame-tail.mjs follow "<某个 session.v4.jsonl.zstd>" --interval 250

# D. 会调模型，没有用户同意不要跑
# bash run-live.sh "$S/tmp/live" "$R"; "$N24" live-frames.mjs "<新日志>" "$R/live-tail.json"; rm -rf "$S/tmp/live"
```

说明：

- 便携 Node 24 在本沙箱写草稿区会报 EPERM，所以 B 组的写入方用 `$NW`。
- `run-live.sh` 把 DSH_HOME、DSH_AGENTS_HOME、USERPROFILE、HOME、TEMP、TMP 全部指向草稿区，设 `DSH_TELEMETRY_DISABLED=1`，用 `node lib/bin.js` 直接启动。密钥来自已有环境变量 `DEEPSEEK_API_KEY`（只看过长度）。
- 所有脚本对用户日志只读，输出里只有偏移、大小、计数、时间、键名、type 和模型名。

## 5. 没验到的

1. **实跑样本小。** 只有 1 个会话、21 个事件、4 个实时帧，没有工具调用、长回合、子代理和审批。复刻写入方跑了 3 次、共 363 个事件，但复刻不是 DSH 本身。怎样验：M0 观察器写好后，在真实长会话上挂 24 小时，分别统计第 1–2 帧、approval/* 事件和其余事件的 p99 / p99.9。
2. **没在空闲机器上测。** 全程 CPU 约 98–100%。怎样验：空闲时重跑 §4 的 A、B 两组。
3. **DSH 内部「事件 → fsync 完成」没有直接打点。** 200 ms 窗口和三条久压路径来自读代码，语料里的同帧跨度只给出下限；file 105、154 分别归到哪条路径是推断。语料还混有不同版本 DSH 写的日志：>2 s 的两个会话都是 2026-10-20 创建的，版本不明。怎样验：S2 在隔离安装里给 `enqueueLive` / `appendLines` 打补丁计时，并故意让一次追加失败，看 drainPaused 压多久。
4. **DSH 在活文件上截掉残缺尾部、rollbackAppend、迁移重写，都没实际观察到。** 只在合成文件上复现了同样的字节变化（polltest 的 8 个行为用例）。怎样验：在 S2 里对 DSH 注入写失败。
5. **没观察多会话并发，也没观察 `dsh web` 常驻宿主或 dsh-tui 宿主写日志**（本机没有活的 DSH 会话）。怎样验：M0 观察器 24 小时挂机时一起看。
6. **会话「出现」的延迟只有 1 个样本。** 实跑里日志在 createdAt 后约 0.66 s 落盘，+0.68 s 被发现。语料里第 1 帧最长压了 5.1 s，说明有的会话物化更晚。r4:2365「活跃会话 ≤2 s 内出现」对 DSH 来说取决于物化时机。怎样验：观察器记录「日志首次出现 − createdAt」。
7. **projcache 只比了 mtime。** 没看内容，也不知道是否每个事件都更新。只读 web attach 没测。S1 是 go，这两条后备暂时用不上；如果要靠 web attach 绕开 DSH 侧的久压，需要单独起一个 spike。
8. **实跑的零写入只靠 mtime 核对，没用 Procmon。** 核对范围：`~/.dsh` 顶层、sessions / storages 下的新文件、`~/.agents`。`~/.dsh-tui` 被改过两次：23:02–23:03 UTC（我们起任何 dsh 之前）和 23:28:36–40 UTC（dsh 退出后 62 s）。复核者 grep 了整个 `@deepseek-ai/dsh` 包，没有任何对 `.dsh-tui` 的引用，判断是用户的 dsh-tui 宿主写的。
9. **目录项滞后的数字在两种写入方之间对不上，原因没查。** 「每次 fsync」和「每次打开-写入-关闭」两种写法下，Node 写入方 p90 7.7–12.6 s，PowerShell 写入方 p90 约 0.1 s。观察器不看目录项，所以不影响结论。
10. **r4:589「.cmd shim 不能直接拉起」没测。** 只验证了 `node lib/bin.js` 可以直接启动。
11. **「挡写打开会让 DSH 进入 drainPaused」没实测。** .NET 的 `FileStream(path, FileMode.Open, FileAccess.Read)` 默认 `FileShare.Read`，不允许别人以写方式打开，这是文档写明的行为，DSH 的追加会因此失败。实测只证明了 Node `'r'` 不挡 DSH（§3.4）。
12. **冷启动整段一次解压会失去逐帧隔离错误的能力。** 历史里只要坏一帧，整段就解不出来，应该在出错时退回逐帧解压、找出坏帧。这是设计提醒（复核者补充），没测。

## 6. 对规格的影响

行号对应 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md`。

| r4 行 | 现在写的 | 改成 |
|---|---|---|
| 2343（S1-DSH 行，「要回答的问题」列） | 「每帧 83 B–62 KB，带校验，windowLog 21）[核验]」 | 「每帧 77 B–1.4 MB（中位 495 B、p99 20.7 KB；23/55,980 帧 >64 KiB，其中 5 个是迁移重写的大帧），全部带校验，windowLog 基本是 21（55,977/55,980；迁移帧里有 1 个 23、2 个单段帧），遍历器不假设窗口大小）[核验 S1]」 |
| 2343（同一格） | 「游标就是下一帧的字节偏移；测 DSH 的 flush 节奏」 | 「游标就是下一帧的字节偏移，每次轮询都从游标重读到文件尾；DSH 0.2.1-rc.2 把 200 ms 内的事件攒成一批，一批一帧，open('a') → write → fsync → close（dsh-session-persistence-jsonl/lib/index.js:187-221, 3299-3335）；写链忙、会话启动、后台写失败（drainPaused）时会压得更久 [核验 S1]」 |
| 2343（「go 判据」列） | 「延迟 ≤2 s」 | 判据不改，补上结果：「S1 = go：实跑最大 0.79 s @100 ms、1.71 s @1 s 轮询；DSH 侧的例外见 2348、2365」 |
| 2348 | 「活跃文件对已打开的句柄每 ≤1 s 做一次 `fstat` 轮询，不依赖 `fs.watch`（Windows 上被占用文件的目录项更新可能滞后，调研之外，S1 顺带验证）。」 | 「活跃 DSH 文件对已打开的句柄每 250 ms 做一次 `fstat` 轮询（上限 1 s），fs.watch 只当提前唤醒的提示，挂上后先读一次。<br>延迟预算 = DSH 侧（200 ms 攒批 + 写链等待 + 会话启动物化）+ 轮询间隔 + 解压（≤0.15 s）；DSH 侧卡顿时，任何轮询间隔都保证不了 ≤2 s。<br>目录项滞后已核验：写入方句柄一直开着且不 fsync 时，fs.watch 和目录项大小要到关句柄才更新（14–30 s）；DSH 每批都 fsync 并关句柄，fs.watch 对它有效，但不作唯一依据。<br>观察器只能用不挡写的只读打开（Node `'r'`），不能用 .NET 默认 FileShare.Read 这类挡写方式，否则 DSH 追加失败会进入 drainPaused。观察器开着句柄期间，别人不能用 rename 覆盖该路径（EPERM）；DSH 只用 MoveFileExW 发布到还不存在的路径，不受影响 [核验 S1]。」 |
| 2365（M0 验收） | 「活跃会话在 ≤2 s（Claude、DSH）内出现，或者在有文档记录的后备延迟内出现」 | 后面补一句：「DSH 按 250 ms 轮询，稳态 ≤2 s（实跑最大 0.93 s）。会话启动的第 1 帧和 DSH 后台写失败（drainPaused）期间，事件由 DSH 自己压住：语料里约万分之一的事件 >2 s（最长 5.1 s）。这记为有文档记录的例外，不算验收失败；M0 的 24 小时观测要单独报告第 1–2 帧和 approval/* 事件的 p99 [核验 S1]。」 |
| 2719（风险表） | 「DSH 按帧 tail，基本确定 [核验]」 | 「DSH 按帧 tail：S1 go（实跑最大 0.79 s @100 ms、1.71 s @1 s；DSH 侧在会话启动或写失败时可能压住 >2 s，语料中约占万分之一）[核验 S1]」 |
| 815（§7.1 DSH「只读传输」格） | 「按帧 tail …（两种目录名并存，观察器两种都要匹配 [核验]）；后备是 `storages/session_projcache`」 | 在「按帧 tail」后补：「游标 = 最后一个完整帧之后的偏移，每次轮询都从游标重读（DSH 会截掉残缺尾部、回滚失败的追加，两次轮询之间可能先截短再追加）。文件短于游标，或同一路径已换成另一个文件（比较 stat(path) 与 fstat(fd) 的文件标识）时，从 0 重读并按 seq 去重。旧版 `session.jsonl.zstd`（38 个）和 v3（3 个）帧结构相同，40 个会话目录只有旧版文件，M0 只跟 v4。冷启动先遍历到游标，再对 [0, 游标) 一次解压（比逐帧快 3.6–3.8 倍），出错时退回逐帧；之后逐帧增量 [核验 S1]」 |
| 3004（附录 A） | 「两种目录名并存，约 114 个 / 92 个 [核验]」 | 保持，补「207 个 zstd：v4 166、旧版 38、v3 3；另有 5 个 bak」 |
| 3236（C.5 不确定性） | 「…以及 Windows 上 `fstat` 轮询能否及时看到追加」 | DSH 这部分已解决：「Windows 上 fstat 轮询能及时看到追加（7 组写入实验 + 实跑，最大 ≤0.6 s 就看到增长）[核验 S1]；Codex 的写法仍由 S1-Codex 看」 |
| 589 | 「`dsh` 解析成 `node <package bin script>`」 | 补「`node lib/bin.js` 直接启动可行 [核验 S1]」；「.cmd 不能直接拉起」仍是假设 |

**[核验] 事实成立与否**

| 规格里的说法 | 结果 | 说明 |
|---|---|---|
| DSH v4 日志由许多独立的 zstd 帧组成 | 成立 | 55,980 帧，每帧都能单独解压 |
| 每帧 83 B–62 KB | 不成立 | 实测 77 B–1,473,976 B，23 帧 >64 KiB |
| 帧带校验 | 成立 | v4、旧版、v3 的所有帧都带 content checksum |
| windowLog 21 | 基本成立 | 55,977/55,980；例外是 1 个 23 的帧和 2 个单段帧，都来自迁移 |
| 约 40 行的帧遍历器；游标就是下一帧的字节偏移 | 成立 | 遍历器 33 行；残缺尾帧等下次再读，游标停在帧边界 |
| 按帧 tail 延迟 ≤2 s（go 判据） | 成立，附例外 | 实跑最大 0.79 s @100 ms / 1.71 s @1 s；DSH 侧在会话启动或写失败时压住 >2 s 的事件约占万分之一 |
| Windows 上被占用文件的目录项更新可能滞后（r4:2348） | 成立 | 写入方句柄一直开着且不 fsync 时，fs.watch 和目录项大小 14–30 s 才更新；fstat 始终正常 |
| 活跃文件每 ≤1 s fstat 轮询即可（r4:2348 + 2365） | 在真实 DSH 上成立，但余量小 | 实跑 1 s 轮询最大 1.71 s。复刻写入方在 CPU 打满时，DSH 侧卡顿 1.5–2.2 s，再加 1 s 轮询就超过 2 s（5/241），500 ms 也只差 14 ms。（更正：原来判为「不成立，改 ≤500 ms 即可」，依据不足，见 S1-DSH-02） |
| 两种目录名并存，约 114 个 / 92 个（r4:815、3004） | 成立 | 206 个目录：`<uuid>` 114、`session-<uuid>` 92 |
| `dsh` 解析成 `node <package bin script>`（r4:589） | 部分验证 | `node lib/bin.js` 直接启动可行；「.cmd 不能直接拉起」没测 |
| （隐含）DSH 每条事件 flush 一次 | 不成立 | DSH 用 200 ms 窗口攒批，58% 的帧有 2 行以上 |

**交给其它章节的新事实**

- **交 S2 / §10.11：会话日志默认上传。** DSH 默认把会话日志增量随官方 DeepSeek API 请求一起上传（`dsh-session-log-deepseek` 的 `enabled` 默认 true；现有日志里有 7,890 条 delivery-accepted）。Orchestra 拉起的 DSH 乐手也会上传，除非关掉。每个新会话还会多发一次自动生成标题的模型请求。
- **交 S2 / M1：冷启动慢。** 在空 DSH_HOME 里，DSH 冷启动约 2 分钟（CPU 打满时 `--help` 用 121 s，到会话创建用 128 s）。
- **交归一化器：v4 事件结构。** 外层是 type / seq / time / data，可选 surfaceOp、sourceEventSeqs；头的键见 §3.1；现有日志里见过 52 种 type。

## 7. 费用与副作用

**模型调用**

整个 spike 共 2 个模型请求，都来自前任 23:25–23:27 UTC 的那一次 dsh 实跑：

- 主回答：deepseek-flash（官方 API），输入 6,351 token、输出 2 token；
- DSH 自动生成标题的请求：用量没有记录。

两个请求都附带了会话日志上传（2 条 delivery-accepted），上传内容只有合成提示词和 DSH 的系统上下文。

另外，前任跑过 2 次 `dsh --profile headless --help`，不调模型：第一次被 `timeout 60` 杀掉（退出码 124），第二次 121 s 后正常退出。

接任者、复核者、修复者都没有调过模型，也没有起过任何 claude / codex / dsh 会话。

**进程**

只按 PID 处理进程，从没按映像名杀过。

| 谁 | 进程 | 结局 |
|---|---|---|
| 前任·实跑 | bash 63124 / 31564 / 36872；timeout 53024 / 30504；dsh 的 node 58128；live-tail 53896；stream-ts 60384 | 都已退出。53024、30504 后来被无关的 conhost.exe 复用（23:52:44、01:00:51 UTC 启动），没有动它们 |
| 前任·复刻与测量 | 复刻读取方 36912 / 18756，写入方 60924 / 13352；卡住的读取方 28896 按 PID 杀掉；fsync 43276；watch 读取方 11620 / 56516 / 59388，写入方 59488 / 43940 / 39764，采样器 47212 / 16928 / 59452；live-tail 自测 61736；bench 44580 | 都已退出 |
| 接任者 | 便携 Node 跑 selftest、corpus-stats、bench-decode（52900）、live-frames；watch 重跑：PowerShell 写入方 64148 / 61336 / 61968，Node 读取方 48336 / 38628 / 33884，采样器 31672 / 26448 / 62640 | 全部自行退出，按 PID 核查 0 个存活 |
| 复核者 | bench-decode 62940；复刻读取方 5304、写入方 64392；watch 重跑 57992 / 62792 / 41552；另有几个前台 node（selftest、corpus-stats、outliers、projcache-lag、spread、holdlb、truncregrow） | 全部自行退出，没杀任何进程 |
| 修复者（本轮） | npm Node 24.11：40520（查版本）、59192 / 53444 / 56080（polltest 三次）、59772（rename / unlink 探针），以及 truncregrow 复现和一次写入探针（PID 未记录）。<br>便携 Node 24：selftest、两次变异探针、dsh-hold、60832（真实日志 poll）、56936（发现遍历）。<br>powershell.exe：查时区、按 PID 核查 | 全部前台运行，命令返回即退出。按 PID 核查 59192、53444、59772、60832、56936、40520 都已不在。没杀任何进程 |

**写入**

- 仓库：只写了 `spikes/s1-dsh/`。本轮改了 `frame-tail.mjs`、`selftest.mjs`、`live-tail.mjs`（补「挂上后先读一次」），新增 `polltest.mjs`、`dsh-hold.mjs`。本报告由编排器落盘，因为 harness 拒绝子代理用 Write 写 .md。仓库里没有 .jsonl、.zst 或解压出来的副本。没有 git add / commit。
- 草稿区：执行者的测量在 `evidence\`，修复者的在 `evidence\fixer\`，复核者的在 `review\`。里面只有计数、大小、type 取值、键名、模型 id 和用量数字。
- `~/.dsh` 顶层的 mtime 与实跑前的快照相同；v4 仍是 166 个；sessions / storages 下没有新文件。`~/.codex`、`~/.claude`、`%CLAUDE_CONFIG_DIR%` 都没写过。
- 没读过凭据、key、bak、watchdog、settings、config 文件。复核者 grep 了全部脚本和前任转录里的 144 次工具调用，没有命中禁读路径。修复者本轮读过的 DSH 源码只有 `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 和 `dsh-session/lib/index.js`。

**临时文件**

`tmp\` 已清空。清掉的东西包括：

- 隔离 DSH_HOME 里的日志副本、projcache 行和 profile；
- DSH 解出的 os-tmp 技能文件；
- 合成日志、fakehome；
- 前任的 probe\ 草稿脚本；
- 本轮的 `tmp\poll\`。

只保留 `evidence\`（含 `evidence\fixer\`）和复核者 `review\` 里的小型测量记录。

**复核发现的处理**

| 编号 | 处理 |
|---|---|
| S1-DSH-01 | 接受。改了 §2、§3.1、§3.3、§6；新增 `dsh-hold.mjs`，重跑结果与复核者一致 |
| S1-DSH-02 | 接受。§3.5 和 §6 里的「≤1 s 轮询」改为延迟预算的写法 |
| S1-DSH-03 | 接受并修复：FrameTail 每次轮询都从游标重读，并加上文件标识比较和坏帧重试；polltest 新增 9 个用例，复核者的复现脚本也通过了 |
| S1-DSH-04 | 接受。§4–§6 已展开，所有时刻标 UTC；本文交编排器落盘（harness 拒绝子代理写 .md，修复者没有绕过） |
| S1-DSH-05 | 接受。改为 17 + 1 + 5 |
| S1-DSH-06 | 接受。删掉 earlyEmits，换成截断探针，并用一次变异测试证明它能抓到 bug |
| S1-DSH-07 | 接受。复跑命令改为写进 `evidence/rerun-<UTC>/`，末尾加了清理 |
