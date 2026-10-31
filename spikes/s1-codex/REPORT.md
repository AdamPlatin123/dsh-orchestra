# S1-Codex 单帧 rollout：spike 报告

M0 第 1–3 天。分四段做完：
- 第一位执行者（2026-10-29 22:41–23:39）做了全部测量，并跑了唯一一次 `codex exec`。
- 接续执行者（10-30 00:26 起）不调模型，重跑了离线部分。
- 复核者独立重跑，提了 9 条意见（S1-CODEX-01…09）。
- 修复者（10-30 01:10–01:35）逐条处理，补了 5 个小脚本。

时间一律用 UTC。测量记录放在 `C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/spikes/s1-codex/evidence/`，下称 evidence/。`rerun-` 开头的是接续执行者的重跑；`fix-` 开头的，以及 `live-timeline.json`、`types-by-version.json`，是修复者加的。

## 1. 问题

规格 r4 §13.2 第 2344 行原文：
- 要回答的问题：Codex rollout 每个文件只有一个 zstd 帧（最大的 142 MB）[核验]，需要常驻的流式解码器，重启后要从字节 0 重新解码。在一个正在运行的 Codex 会话上测：每写一条事件，完整 block 能否被解出来？
- go 判据：能逐事件解码，延迟 ≤3 s
- no-go 后备：M0 本来就只轮询 `state_5`；结果只决定 M2 的实时 tail 做不做

## 2. 结论：go（有条件）

一句话：本机 codex-cli 0.165.0 的 `codex exec` 在会话运行时写的是明文 `rollout-*.jsonl`，每次追加完整的行，用不着解码器。`fstat` 看长度、按字节游标续读，就能一条条读到。所以 M2 的 Codex 实时 tail 可以做，而且比规格设想的简单。

延迟要分两种看（复核 S1-CODEX-01）：
- **写盘到可读**：18/18 条在 20–720 ms 内读到（中位 347 ms）。记录顶层的 `timestamp` 是 Codex 写这一行时打的，所以这个数只说明写下去以后多快能读到，看不到 Codex 压着没写的时间。
- **事件到可读**：有 5 条记录自带事件时间。回合内的 4 条（task_started、2 条 item_completed、task_complete）都在 1.4 s 以内读到。item_completed 的 `completed_at_ms` 和写盘时刻只差 0–1 ms，说明回合内的事件是当场写的。
  - 超标的只有会话开头：rollout 文件在线程创建 39.8 s 后、第一个 turn 开始时才建出来，session_meta 在线程创建 40.4 s 后才读到。这段时间 tail 什么都看不到。
  - 另外，turn 的输入（additional_tools 和 5 条 message）在 turn 开始约 10.6 s 后才写盘。它们不带事件时间，分不清是 Codex 在做准备（当时 CPU 100%），还是压着没写。

判据的字面要求（每写一条事件，3 s 内能解出）达到了。拿它当 M2 实时 tail 的依据时，要带着三个条件（复核 S1-CODEX-02）：
1. 只有 1 次实跑、1 个版本（0.165.0）、1 种来源（codex_exec）。会话 13 s，18 条记录，没有工具调用。0.165.0 按 Q1 规则本身没有契约包，会判 harness-unsupported。规格钉的私有 0.160.x 没看到；占历史 171/257 的 Desktop 和 VS Code 来源也没看到。要在 M1/M2 的受控实跑里确认后缀和写入方。
2. 发现新会话不能靠 rollout 出现，它晚约 40 s；要靠 state_5，M0 本来就轮询它。state_5 是不是线程一创建就有这一行，本 spike 不读 sqlite 内容，没验。
3. 判断活跃不能看 mtime：写入期间 mtime 一直停在出生时刻，exec 退出 1 h 50 min 后仍然如此，只有 size 在变。判断会话结束也不能靠句柄关闭，因为写入方可能是常驻的 app-server 守护进程。

历史的 `.jsonl.zst` 单帧文件，推断是事后整文件压缩出来的归档，不是按事件 flush 的。证据见 3A、3B、3G：
- 16,525 个非末 block 只有 9 个结束在换行上，纯随机也该有约 4 个。
- 257 个文件一共只有 16,782 个 block，却有 363,026 行，每条事件一个 block 在算术上不可能。
- 257/257 的帧头都写了解压后的总长度，只有压缩前就知道全文多长才写得出来。

所以单帧文件只在冷读历史时需要流式解码。0.165.0 里有个特性开关 `local_thread_store_compression`（under development，默认关）。如果将来 Codex 打开它、改成边写边压，逐事件读大概率做不到，到时要重跑本 spike。

解码器本身没问题。Node 24 的 `zlib.createZstdDecompress` 每收到一个完整 block 就吐出这个 block 的内容，16,782 个 block 全是这样，不用等帧尾。

## 3. 数字

### A. 历史 rollout 的结构（257 个 .jsonl.zst）
| 量 | 值 | 怎么测的 |
|---|---|---|
| 文件数 | 257 个 .jsonl.zst，另有 1 个 .jsonl（本 spike 那次 exec 写的） | scan-rollouts.mjs，见 evidence/rerun-scan-rollouts.summary.txt |
| 按年月 | 2025/09 10、2025/10 56、2025/11 13、2026/01 2、2026/02 42、2026/03 31、2026/06 55、2026/07 18、2026/09 21、2026/10 9 | 只数路径 |
| 每文件帧数 | 257/257 正好 1 个 zstd 帧；没有 skippable 帧，没有尾随字节，没有不完整帧 | zstd-frames.mjs 按 RFC 8878 读帧头和 block 头，不解压 |
| 大小 | 共 629,573,667 B；最小 460，中位 281,329，p90 1,976,497，最大 142,099,445 B | 同上 |
| 最大文件 | 2026/02/21/rollout-…019c8157…：解出 249,164,082 B、2,378 个 block、18,662 行，cli 0.98.0-cometix | 同上，加 cold-start.mjs |
| checksum / dictId | checksum 0/257；dictId 全为 0 | 帧头描述符 |
| windowLog | 100 个是 21；157 个是 single-segment（窗口等于内容大小） | 帧头 |
| 帧头 FCS（解压后总长度） | 257/257 都有 | 帧头 |
| block | 共 16,782 个；每文件最小 1、中位 15、p90 99、最大 2,387；单 block 压缩后最大 98,964 B，解出最大 128 KiB；没有 raw block | block 头 |
| 首条记录与版本 | 都是 session_meta；cli_version 27 种（0.34.0–0.160.0，含 0.98.0-cometix ×42）；originator：Desktop 91、vscode 80、exec 69、tui 9、work_desktop 7、cli_rs 1 | 只解到第一个换行 |
| 扫一遍的耗时 | 8.7–10.6 s（CPU 满载），第一次 3.9 s；峰值 RSS 61 MiB | 三次扫描 |

### B. 能不能边写边解（离线）
| 量 | 值 | 怎么测的 |
|---|---|---|
| 逐 block 喂解码器 | 16,782 个 block 每喂一个就有输出；257/257 解出字节数等于 FCS；0 错误；共解出 1,574,636,104 B、363,026 行 | prefix-test.mjs blocks 加 summarize-blocks.mjs；复核者复算，逐字节一致 |
| 非末 block 结束在换行上 | 9 / 16,525（随机期望约 4） | 同上 |
| 非末 block 解出的大小 | 全部是 8 KiB 的整数倍，其中 7,249 个正好 128 KiB。这和 zstd 1.5.6 起按 8 KiB 粒度预切 block 一致；但 block 头里没有 raw 块，无法单靠 block 头独立验证 | 同上 |
| 前缀 10/50/90/100% 解出的完整行数 | 25,547 B（1 个 block）0/0/0/17；77,419 B 0/0/65/95；316,738 B 0/71/227/298；748,444 B 232/935/1915/2312；7,161,820 B 343/4093/8359/9246；142 MB 8126/10863/16677/18662 | prefix-test.mjs prefix，直接只读原文件的前缀，不复制。6 个文件中复核者重跑了 3 个，修复者重跑了另 3 个，结果全部一致。规律：前缀里只要有一个完整 block 就有输出 |
| 合成写入方，逐事件 flush | 30/30 条在写入过程中解出。三次的延迟：执行者 min 12 / 中位 405 / p90 789 / max 3754 ms（max 是第一条，含 tail 启动）；复核者 19/280/484/517；修复者 10 条小样 159/421/573/592 | synth-writer.mjs 加 stream-tail.mjs --poll 500 |
| 合成写入方，不 flush | 写入过程中文件始终是 0 字节，写完才一次长到 359–364 B；延迟中位 5.5–6.2 s，max 12.3–13.2 s | 同上，两次 |

### C. 活会话（唯一一次 codex exec，2026-10-29）
| 量 | 值 | 怎么测的 |
|---|---|---|
| 版本 | codex-cli 0.165.0（npm 全局；package.json 的 mtime 是 2026-10-28 22:41:18，前一天刚升级） | codex --version；package.json |
| 格式 | 明文 rollout-2026-10-29T19-25-28-01a189fb-….jsonl；session_meta 里是 0.165.0 / codex_exec；第一行 19,000 B | stream-tail --dir；rerun-scan 的 plainRollouts |
| 时间线 | exec 启动 23:25:17.15 → codex.exe 进程 23:25:20.22 → 写 models_cache.json 23:25:28.33 → 线程创建 23:25:28.915（session_meta 的 payload.timestamp）→ turn 开始（task_started 的 started_at = 23:26:08，只到整秒）与文件出生（23:26:08.705）在同一秒 → 目录扫描发现文件 23:26:09.250（出生后 544 ms）→ task_complete 写盘 23:26:22.029 → 进程树退出 23:26:34.80（全程 77.65 s） | live-timeline.mjs，见 evidence/live-timeline.json；Start-Process 计时 |
| 增长 | 5 次：0 → 19,497 → 156,209 → 157,397 → 159,462 → 160,658 B，共 18 行；每次都正好停在行尾 | live-tail-events.jsonl.txt；复核者按行偏移逐一核对过 |
| 写盘到可读 | 18/18 条；min 20 / 中位 347 / p90 546 / max 720 ms（轮询 500 ms） | 读出时刻减记录顶层 timestamp，即 summarize-tail.mjs 的 writeToReadMs（旧输出里叫 lagMs） |
| 事件到可读（有事件时间的 5 条） | task_started 0.55–1.39 s（started_at 只到整秒）；两条 item_completed 712 ms 和 90 ms（completed_at_ms，与写盘差 0–1 ms）；task_complete 0.32–1.32 s（completed_at 只到整秒）；session_meta 40.4 s（相对线程创建） | live-timeline.mjs；stream-tail.mjs 现在会直接输出 eventToReadMs |
| 会话开头的空窗 | 线程创建到文件出生 39.8 s；turn 开始到 turn 输入 6 行写盘约 10.6 s（这 6 行不带事件时间） | live-timeline.json 的 gaps |
| 记录类型 | session_meta 1、event_msg/task_started 1、response_item/additional_tools 1、response_item/message 7、world_state 1、turn_context 1、event_msg/thread_settings_applied 1、event_msg/item_completed 2、token_usage_record 1、event_msg/token_count 1、event_msg/task_complete 1 | 只记 type 与 payload.type |
| mtime | 写入期间一直停在出生时刻 23:26:08.706，长度却在涨；10-30 01:16 再看，仍是 23:26:08.706、160,658 B | stat / fstat / ls |
| 文件名里的时间 | 是写入进程的本地时间（本机 UTC−4），比文件出生早 39.8 s，和线程创建在同一秒；历史文件按 UTC+8 解释时，mtime 减名字时间没有一个是负数 | meta-times.mjs --name-offset 8 |
| stdout --json | thread.started、turn.started、item.completed（agent_message）、turn.completed；stderr 39 B（codex 自己的读 stdin 提示） | live-codex-stdout-types.json |
| tail 进程的内存 | dir 模式 RSS 58 MiB；合成测试 38–45 MiB | process.resourceUsage().maxRSS |

### D. 冷启动：最大的文件（142 MB）从字节 0 解到尾
| 方式 | 墙钟 | CPU | RSS |
|---|---|---|---|
| 一次性 sync（只作对照） | 1.56–1.9 s | 1.37–1.5 s | 658 MiB |
| 流式，输出块 1 MiB | 2.25–3.0 s | 1.9–2.3 s | 114–116 MiB |
| 流式，默认输出块 16 KiB | 4.0–11.4 s | 2.9–3.6 s | 83–86 MiB |
| 输出块 1 MiB，加切行和 JSON.parse | 2.9–4.5 s | 2.4–2.7 s | 178–181 MiB |
| 输出块 16 KiB，加切行和 JSON.parse | 7.1–8.9 s | 4.0–4.9 s | 153–165 MiB |

上表是接续执行者两轮、复核者一轮的结果，当时 CPU 负载 85–100%。墙钟时间随负载变化，CPU 时间才稳定。第一位执行者测的时候机器被其它 spike 压满，测到 16 KiB 16.8–208 s、1 MiB 28.9–32.8 s、sync 2.9–3.5 s。全部 257 个文件逐 block 解一遍要 70–124 s，峰值 RSS 79–105 MiB。

### E. 发现新文件的成本
| 量 | 值 | 怎么测的 |
|---|---|---|
| 递归扫整棵 sessions 树（97 个日目录、258 个文件） | 两次各 20 轮：55–90 ms（中位 67）；67–179 ms（中位 111，CPU 100%） | evidence/rerun-dirscan-cost.json（当时用的是内联脚本）；dirscan-cost.mjs，见 evidence/fix-dirscan-cost.json |
| 只扫今天和昨天的本地日期目录 | 中位 0.9 ms，max 37 ms | dirscan-cost.mjs |

### F. 各版本里出现过的记录类型（复核 S1-CODEX-04）
| 量 | 值 | 怎么测的 |
|---|---|---|
| 0.165.0 有、旧版本都没有的类型 | 只有 response_item/additional_tools | types-by-version.mjs 解了 0.130.0–0.165.0 的 104 个文件（26.5 s，120 MiB），见 evidence/types-by-version.json |
| world_state、token_usage_record、event_msg/thread_settings_applied | 从 0.153.4、0.159.0-alpha.12.1、0.159.2、0.160.0 起就有 | 同上 |
| event_msg/item_completed | 从 0.130.0 起就有 | 同上 |

### G. state_5 与 ~/.codex 的元数据（只看名字、大小、mtime）
- `C:/Users/Calx/.codex/state_5.sqlite` 3,563,520 B，mtime 2026-10-29 20:36:56。
  - 22:42 和 23:22 两次看，都没有 -wal/-shm。
  - exec 后出现了 -shm（23:25:21.8，exec 的 codex.exe 起来 1.6 s 后）和 -wal 317,272 B（23:26:22.1），之后一直留着。exec 早已退出，-shm 在 10-30 00:51:13 还被改过。
  - 主库 mtime 没变，所以新数据只在 -wal 里，而且还有别的进程连着它。
- logs_2.sqlite 的 -wal/-shm 来来去去：22:42 在，23:22 不在，23:26:52 又出现（exec 进程树退出 17.5 s 之后），01:16 在，01:25 不在。所以它们不是 exec 造成的，是别的进程（很可能是守护进程）在周期性写日志。
- thread_history_1.sqlite（116,805,632 B，大小不变）的 mtime 从 10-28 23:04 变成 10-29 23:26:22.848，正好在 task_complete 之后；thread-writer-locks/ 目录的 mtime 是 23:26:22.492。说明 0.165.0 运行时除了 rollout，还会写分页的 thread history。
- 批量压缩的痕迹：
  - 97 个日目录里有 91 个 mtime 落在 2026-10-20 20:37。里面有 241 个 .zst，文件 mtime 从 2025-09-16 到 2026-09-13，说明保留了原来的 mtime。另有 5 个日目录落在 2026-10-26 19:47（16 个 .zst）。
  - 10-20 那次之前 4 分钟有一个 .codex-provisioning-….guard（20:33:29），tmp/ 和 archived_sessions/ 目录的 mtime 是 20:36:50 和 20:37:02。10-26 那次附近没有 guard 文件。
  - 今天的明文 .jsonl 在 exec 退出 1 h 50 min 后还是明文。
- 和迁移有关的东西（复核 S1-CODEX-06，来自第一位执行者看到的帮助输出）：
  - 子命令 `codex migrate-rollouts`，帮助文本的意思是检查旧的本地会话，或把它们迁到分页 thread history；不加 --apply 就只报告。
  - 特性开关 background_paginated_rollout_migration 和 local_thread_store_compression 都是 under development、默认关；local_thread_store_shared_compression 是 removed。
  - ~/.codex/rollout-migrations/ 目录存在，但是空的（mtime 2026-09-29）。
- 活着的 Codex 进程（只按 PID 查 Win32_Process，没碰）：Desktop 53044 一族（20:16 起）；app-server 58228；app-server 守护进程 36748 和 54648（20:56:51/53 起，父进程 56008 已经不在）。10-30 01:2x 时它们都还在。

## 4. 方法与复跑命令

脚本都在 `G:/_Projects/dsh-orchestra/spikes/s1-codex/`。对 harness 文件一律只读打开，14 个脚本里没有任何写调用：
- zstd-frames.mjs：帧遍历器，按 RFC 8878 读帧头和 block 头，不解压
- scan-rollouts.mjs：扫全部 rollout 的帧结构，和第一行里的版本
- prefix-test.mjs：prefix 模式按 10/50/90/100% 喂前缀；blocks 模式逐 block 喂
- summarize-blocks.mjs：汇总 blocks 模式的输出
- stream-tail.mjs：常驻解码，加每 ≤1 s 一次的 fstat 轮询；也能 tail 明文文件和整个目录。输出 writeToReadMs（写盘到可读），记录自带事件时间时再输出 eventToReadMs（事件到可读）
- summarize-tail.mjs：汇总 tail 的输出，新旧字段名都认
- synth-writer.mjs：合成写入方，用假数据，可以逐事件 flush 或不 flush
- cold-start.mjs：冷启动代价
- meta-times.mjs：日目录 mtime 的聚簇，以及文件名时间与 mtime 之差
- 新增 live-timeline.mjs：明文 rollout 的时间线，只取时间戳、偏移和 type
- 新增 types-by-version.mjs：每个 cli_version 里出现过的记录类型
- 新增 dirscan-cost.mjs：发现新文件要扫多久
- 新增 codex-home-meta.mjs：~/.codex 顶层的元数据快照和 diff，跳过敏感名字
- 新增 stamp-lines.mjs：下次实跑时给 exec 的 stdout 每行打上到达时间，只留事件类型

必须用 Node 24，系统的 node 22 没有 zstd。本沙箱里 node 自己不能新建文件，所以输出一律用 shell 重定向。在 Git Bash 里照抄即可。①–⑧ 不调模型，CPU 满载时合计约 4 分钟，大头是 ②。

```bash
N=G:/_Projects/DSH-plugins/.tools/node24/node.exe
S=C:/Users/Calx/.codex/sessions
EV=C:/Users/Calx/AppData/Local/Temp/claude/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/scratchpad/spikes/s1-codex/evidence
O=$(mktemp -d)
cd G:/_Projects/dsh-orchestra/spikes/s1-codex
# ① 帧结构（约 10 s）
$N scan-rollouts.mjs $S - > $O/scan.json 2> $O/scan.summary.txt
# ② 逐 block 喂解码器（70–124 s）
find $S -name '*.zst' -print0 | sort -z | xargs -0 $N prefix-test.mjs blocks > $O/blocks.jsonl && $N summarize-blocks.mjs $O/blocks.jsonl
# ③ 前缀测试，6 个文件（约 30 s）
$N prefix-test.mjs prefix $S/2025/10/12/rollout-2025-10-12T02-24-16-*.zst $S/2026/06/20/rollout-2026-06-20T04-17-40-*.zst $S/2026/06/20/rollout-2026-06-20T06-12-22-*.zst $S/2026/10/09/rollout-2026-10-09T01-13-51-*.zst $S/2026/10/02/rollout-2026-10-02T21-19-32-*.zst $S/2026/02/21/rollout-2026-02-21T09-55-44-*.zst > $O/prefix.jsonl
# ④ 冷启动（每种 2–12 s）
F=$S/2026/02/21/rollout-2026-02-21T09-55-44-019c8157-d96c-7662-8d36-b9d9cba684ed.jsonl.zst
for m in sync 'decode 1048576' decode 'parse 1048576' parse; do $N cold-start.mjs $F $m; done > $O/cold.jsonl
# ⑤ 合成写入方，逐事件 flush / 不 flush（约 30 s）
for mode in event none; do F2=$O/synth-$mode.jsonl.zst; : > $F2; $N stream-tail.mjs --file $F2 --poll 500 --max-ms 15000 --from-start > $O/tail-$mode.out & $N synth-writer.mjs --events 30 --interval 300 --flush $mode --pad 200 >> $F2; wait; $N summarize-tail.mjs $O/tail-$mode.out; done
# ⑥ 元数据（几秒）
$N meta-times.mjs $S --name-offset 8; $N dirscan-cost.mjs $S --runs 20; $N codex-home-meta.mjs > $O/home-now.json
# ⑦ 活会话时间线（用前任留下的 tail 输出）
$N live-timeline.mjs $S/2026/10/29/rollout-2026-10-29T19-25-28-01a189fb-8761-7f73-9e89-4d7db56e8a1f.jsonl $EV/live-tail-events.jsonl.txt > $O/live-timeline.json
# ⑧ 各版本的记录类型（约 30 s）
$N types-by-version.mjs $S --versions '^0[.]1[3-6][0-9]' > $O/types.json
```

⑨ 会调一次模型，本轮没有跑。下次 M1/M2 受控实跑照下面做：先拍快照，再跑任何 codex 子命令；stdin 接 /dev/null；stdout 每行打到达时间。

```bash
$N codex-home-meta.mjs > $O/home-before.json
mkdir -p $O/cwd
$N stream-tail.mjs --dir $S --poll 500 --max-ms 240000 > $O/tail-live.out &
codex exec --json --skip-git-repo-check --ignore-user-config -C $O/cwd -s read-only -m gpt-6-luna -c model_reasoning_effort=low 'reply with one word' < /dev/null | $N stamp-lines.mjs > $O/stdout-timed.jsonl
wait
$N summarize-tail.mjs $O/tail-live.out
$N codex-home-meta.mjs > $O/home-after.json; $N codex-home-meta.mjs --diff $O/home-before.json $O/home-after.json
```

跑完后再执行 `$N live-timeline.mjs <新 rollout> $O/tail-live.out`。然后拿 stdout-timed.jsonl 里 thread.started、turn.started、item.completed 的到达时刻，和对应 rollout 行的可读时刻比。

## 5. 没验到的

1. **Desktop、VS Code 插件、TUI 运行时写什么格式。** 为什么没验：简报只许实跑一次，跑的是 exec；Desktop 一直开着，但 2026-10-08 之后没写过 rollout。怎么验：你下次正常用 Desktop 时，用 `stream-tail.mjs --dir` 只读跟一下，不调模型。
2. **规格钉的私有 0.160.x 写什么格式。** 为什么没验：本机没装，而且只许实跑一次。怎么验：M1/M2 受控实跑时，按 ⑨ 的做法看后缀和时间线。
3. **.zst 由事后整文件压缩产生，这是推断。**
   - 依据：FCS 257/257；block 数远少于行数；block 边界和换行无关；日目录 mtime 两次扎堆，其中一次紧跟着一次 provisioning；0.165.0 写的是明文，1 h 50 min 后仍是明文。
   - 不知道的：没看到 .jsonl 变成 .zst 的那一刻，不知道是谁、什么时候压的。2026/10/29 目录在 23:32:20.934 又变过一次 mtime，原因不明。
   - 怎么验：定期只读看目录元数据；或者查 Codex 源码；或者用只读模式（不加 --apply）跑一次 `codex migrate-rollouts --json`，看它报告什么。最后这个要再跑一次 codex 子命令，先问你（复核 S1-CODEX-06）。
4. **rollout 由谁写、句柄什么时候关。**
   - 为什么没验：要看别人进程的句柄，超出了边界。
   - 线索：exec 进程树 23:26:34 全部退出，可 rollout 的 mtime 到 01:16 还停在出生时刻，而 NTFS 一般要等写句柄关了才更新 last-write。state_5-shm 在 00:51:13 还被改过。app-server 守护进程 36748、54648 在 spike 之前（20:56）就在跑，现在还在。很可能是 exec 把线程交给守护进程去写，守护进程一直开着句柄。
   - 影响：不能用『文件关了 = 会话结束』来判断，要用 task_complete 和 state_5。
   - 怎么验：查 Codex 源码；或者你同意后，自己用 Sysinternals handle 之类的工具看一次。
5. **会话开头 40 s 的空窗、turn 输入晚 10.6 s 才写，原因不明。** 为什么没验：只有一次实跑，机器 CPU 100%，光看记录分不出是在准备还是压着没写。怎么验：在空闲机器上按 ⑨ 的做法跑，用 stdout 的到达时间做独立时钟。
6. **新会话能不能靠 state_5 及时发现。** 为什么没验：本 spike 不读 sqlite 内容。怎么验：M0 的 state_5 快照轮询做出来后，在一次实跑里比较线程行出现的时刻和 thread.started 的到达时刻。
7. **长会话没测。** 实跑只有 18 条记录、没有工具调用，没看到超大记录（历史上最大一行 6 MB）分几次写入时是什么样。怎么验：M1/M2 受控实跑里让它读一个大文件。
8. **.jsonl → .jsonl.zst 切换那一刻没在真实场景里跑过。** stream-tail 的 vanished/replaced 处理没有经过实测；dir 模式会把新出现的 .zst 当成新文件从字节 0 重读，导致行重复。M2 要按 uuid 对上，用已读行数跳过。
9. **fs.watch 与 fstat 的对比没测。** 简报把它放在 S1-DSH。
10. **冷启动数字是在 CPU 85–100% 时测的。** 空闲机器上应该更快，看 CPU 时间更可靠。
11. **第一位执行者那 11 次非模型 codex 调用（见第 7 节）有没有写 ~/.codex，只能部分排除。** 拿第一次调用前 22:42:12 的 ls 和 23:22:51 的快照比：
    - models_cache.json、state_5*、thread_history_1 都没变。
    - .codex-global-state.json 在 23:22:03.9 改过，大小不变，离最后一次调用 15 分钟，像是 Desktop 写的。
    - logs_2 的 -wal/-shm 不见了，是连着它的进程做了 checkpoint。
    - 这些调用往 logs_2.sqlite 写日志的可能排除不了；目录的 mtime 没有比。
12. **『非末 block 解出都是 8 KiB 整数倍』这一条无法从 block 头独立验证。** block 头里没有 raw 块，只能靠解码结果。

## 6. 对规格的影响

行号对应 r4，即 docs/specs/2026-10-27-dsh-orchestra-design-r4.md。

先看 [核验] 事实成不成立：
| r4 行 | 原说法 | 结论 | 说明 |
|---|---|---|---|
| 2344 | 每个文件只有一个 zstd 帧（最大的 142 MB）[核验] | 成立 | 指归档的 .zst：257/257 单帧，最大 142,099,445 B，无 checksum，帧头带 FCS |
| 2344 | 需要常驻的流式解码器来实时 tail | 不成立 | 0.165.0 运行时写明文 .jsonl，按整行追加 |
| 2344 | 重启后要从字节 0 重新解码 | 只对 .zst 成立 | 明文活跃文件用字节游标续读 |
| 2344 | 能逐事件解码，延迟 ≤3 s | 有条件成立 | 写盘到可读 ≤720 ms；回合内事件到可读 ≤1.4 s；会话开头有 40 s 空窗；只测了 0.165.0 exec |
| 2344（隐含） | 写入方按事件 flush 出完整 block | 对历史 .zst 不成立 | 只有 9/16,525 落在换行上；16,782 个 block 对 363,026 行 |
| 832 等 | 全局 codex 0.139.0 → harness-unsupported [核验] | 已过时 | 核验当时成立；2026-10-28 22:41 升到了 0.165.0 |
| 843 | state_5 约 3.5 MB | 成立 | 3,563,520 B |
| 842 | state_5 处于 WAL 模式，有 -shm 和 -wal [核验] | WAL 成立，但要补一句 | -wal/-shm 只在有连接时存在：22:42、23:22 都没有，exec 后才出现并留了下来 |
| 834、495 | 257 个 rollout 有 27 种 cli_version [核验] | 成立 | 现在多了 1 个 0.165.0 的明文 rollout |
| 2348 | 活跃文件用 fstat 轮询，不依赖 fs.watch | 成立 | size 在 1 个轮询周期内可见；mtime 不动 |
| 2348 | Windows 上 fs.watch 的目录项更新可能滞后 | 没验 | 属于 S1-DSH |
| 815 | 只跟踪最近 10 分钟内修改过的文件 | 按 mtime 做就不成立 | 活跃文件的 mtime 不动 |

该改的句子：
- **第 2344 行**（S1-Codex 一行）：『要回答的问题』一格改为：『Codex 的活跃 rollout 是明文 `rollout-*.jsonl`，按整行追加（0.165.0 `codex exec` 实测）；归档是单帧 `.jsonl.zst`（每文件 1 帧，最大 142 MB，帧头带总长度，推断为事后整文件压缩）。实时 tail 读明文，按字节游标续读；单帧文件只在冷读历史时流式解码，重启后从字节 0 开始。钉住的 0.160.x 与 Desktop 的写入格式在 M1/M2 受控实跑里确认。』go 判据一格保留，后面加『（S1-Codex：go，有条件，见 spikes/s1-codex/REPORT.md）』。
- **第 815 行**（§7.1 只读传输，Codex 一格）：把『`rollout-*.jsonl.zst`（`task_started/complete`、`token_count`），按 `cli_version` 嗅探版本。M0 只轮询快照；rollout 实时 tail 在 M2，只跟踪最近 10 分钟内修改过的文件、最多 8 个』改为：『活跃的 `rollout-*.jsonl`（明文，按整行追加：`fstat` 看 size，字节游标续读）与归档的 `rollout-*.jsonl.zst`（单帧，冷读时流式解码）；读 `task_started/complete`、`token_count`，按 `cli_version` 嗅探版本，未知类型降级为 `unknown`（0.165.0 新出现了 `response_item/additional_tools`）。M0 只轮询快照；rollout 实时 tail 在 M2，只跟踪最近 10 分钟内 size 变过的文件（写入期间 mtime 不更新），最多 8 个。文件名里的时间是写入进程的本地时间，不能当 UTC，要用 `session_meta.payload.timestamp`；rollout 在第一个 turn 开始时才建（比线程创建晚约 40 s），新会话靠 `state_5` 发现（待验证）；`--ephemeral` 会话不写 rollout（据帮助文本，未测）。』
- **第 151、2373 行**：『`codex 0.139 < 0.144 → harness-unsupported`』改为『`codex 0.165.0：没有契约包 → harness-unsupported`』。
- **第 832 行**：『全局 0.139.0 → `harness-unsupported` [tui][核验]』改为『全局 CLI 已于 2026-10-28 升到 0.165.0（原 0.139.0 的核验已过时）；按 Q1 规则仍为 `harness-unsupported`，理由是没有 0.165.0 的契约包』。
- **第 1482 行**：『codex 0.139 < 0.144』改为『codex 低于 0.144，或没有对应版本的契约包（本机全局 0.165.0 属于后者）』。
- **第 859 行**：『选 A 时全局的 0.139 与 Codex Desktop 都不动』中的『全局的 0.139』改为『全局的 codex（现为 0.165.0）』。
- **第 1801 行**表头：『Codex（CLI 0.139；app 26.1021）』中的『CLI 0.139』改为『CLI 0.165.0』（app 版本本 spike 没核）。
- **docs/research/cc-codex-protocols.md 第 5 行**：『local Codex CLI is 0.139.0』改为『0.165.0（npm 全局，2026-10-28 升级）』。
- **第 495 行（D12）、第 834、2480、3141 行**：黄金 fixture 加一份 0.165.0 的明文活跃 rollout。world_state、token_usage_record、thread_settings_applied 从 0.153.4 起就有，现有的 0.153.4/0.159.2/0.160.0 fixture 已经覆盖，不必另列。
- **第 842 行**：『处于 WAL 模式（有 `-shm` 和 `-wal`）[核验]』改为『处于 WAL 模式 [核验]；`-shm`/`-wal` 只在有连接时存在（S1-Codex：spike 前两次查看都没有，`codex exec` 后出现并一直留着，因为还有别的进程连着），最新数据可能只在 `-wal` 里』。
- **第 843 行**：『把 db 和 `-wal` 复制』改为『把 db 和 `-wal` 一起复制（有就复制，没有也能用；只复制主库会漏掉最新的线程）』。
- **第 845 行与第 3003 行**（thread_history_1 永不打开）：规则先不改，加一句『0.165.0 运行时会写 `thread_history_1.sqlite`；如果 Codex 把会话迁到分页 thread history，要重新评估』。
- **第 1676 行**（读取白名单）与**第 3003 行**：『`sessions/**/rollout-*.jsonl.zst`』改为『`sessions/**/rollout-*.jsonl` 与 `sessions/**/rollout-*.jsonl.zst`』，否则 M2 的实时 tail 会被自己的白名单拒掉。`archived_sessions/` 要不要读，另定。
- **第 2348 行**末尾加：『看 size，不看 mtime：Codex 活跃 rollout 的 mtime 停在出生时刻（S1-Codex 实测 1 h 50 min 不变），size 实时变化。』
- **第 2480 行**：『Codex rollout 实时 tail（按 S1-Codex 的结果）』改为『Codex rollout 实时 tail：对明文 `.jsonl` 按字节游标 tail（S1-Codex：go，有条件）；处理 `.jsonl` → `.jsonl.zst` 的切换（按 uuid 对上，用已读行数跳过重复）；新文件只扫今天和昨天的本地日期目录（<1 ms；扫整棵树要 55–179 ms），或者用 state_5 给出的 rollout 路径；在钉住的 0.160.x 与 Desktop 上确认后缀和写入方』。
- **第 2530 行**（M2 削减顺序）：顺序不用改；实时 tail 的工作量比原设想小，不用常驻解码器。
- **第 2719 行**（风险表）：把『实时 zstd tail 延迟高或失败 | … Codex 是单帧文件，M0 只轮询 `state_5`，M2 再按 S1-Codex 的结果决定实时 tail …』改为：『Codex 活跃 rollout 是明文，S1-Codex：go（有条件）。风险：Codex 在往分页 thread history 迁（`codex migrate-rollouts`、特性 `background_paginated_rollout_migration`，0.165.0 里 under development、默认关；0.165.0 运行时已经会写 `thread_history_1.sqlite`），rollout 可能停写；或者打开 `local_thread_store_compression`（under development、默认关）变成边写边压——历史 .zst 不按事件 flush，那时逐事件读大概率不行。版本升级时重跑 S1-Codex，并重新评估 thread_history_1 的只读规则；后备不变（projcache、web attach、自有会话的驱动事件流）。』
- **第 3135 行**：『S1-Codex（单帧，难）』改为『S1-Codex（实测：活跃文件是明文，易；归档是单帧）』。
- **第 3236 行**（待验证清单）：『Codex 单帧 rollout 的实时解码（S1-Codex）』改为『S1-Codex 已答（go，有条件）：活跃文件是明文，fstat 在 1 个轮询周期内就能看到追加。剩下待验：钉住的 0.160.x 和 Desktop 写什么格式、写入方是谁、句柄何时关闭、.jsonl → .zst 的切换、靠 state_5 发现新会话的时效』。
- **第 551、2353、2364 行**（M0）不受影响：Codex 仍只轮询 state_5。

## 7. 费用与副作用

**模型调用：共 1 次。** 是第一位执行者 2026-10-29 23:24:30 起跑的 `codex exec`：gpt-6-luna，reasoning low，read-only 沙箱，加 --ignore-user-config，提示词是 reply with one word。输入 20,398 tokens（其中缓存 11,776），输出 5。接续执行者、复核者、修复者都是 0 次，也都没有运行 codex。

**非模型的 codex CLI 调用。** 这一项报告原先漏写了（复核 S1-CODEX-07）。第一位执行者共调了 11 次，都在 23:22:51 拍 before 快照之前：
- codex --version（22:43:53）
- codex exec --help 两次（22:44:13、22:44:24）
- codex --help（22:45:12）
- codex migrate-rollouts --help（22:45:26）
- codex features --help 和 codex debug --help（22:45:43，同一条命令）
- codex features list 三次（22:46:04 两次，22:46:27 一次）
- codex debug models（23:06:35，输出存到 tmp 后已删除）

简报第 3 节第 5 项只许 exec --help 和最多一次 exec，这几次超出了许可。转录里没看到它们调模型。它们对 ~/.codex 的影响见第 5 节第 11 条。以后先用 codex-home-meta.mjs 拍快照，再跑任何 codex 子命令。

**进程。** 都只按 PID 查，没有人杀过进程；第一位执行者唯一的 taskkill 写在超时分支里，没有触发。
- 第一位执行者：exec 进程树是 cmd 64048 → node 54656 → codex 56404，23:26:34.8 正常退出，按 PID 树核对没有幸存。stream-tail 58288、62664、60920、38640、54320、10108 和 synth-writer 62632、62488、59812、57528，都在 --max-ms 到点后自行退出。
- 接续执行者：只跑了前台 node（扫描、前缀、冷启动 9 次、meta-times、summarize-blocks、目录计时）和读 CPU 负载的 PowerShell，都已退出。
- 复核者：stream-tail 43860、55544，synth-writer 63112、50484，以及后台的逐 block 任务，都自行退出。PID 57528 后来是复核者自己那次 PowerShell（PID 被复用），不是残留。
- 修复者：前台 node（live-timeline、types-by-version、dirscan-cost、codex-home-meta、1.2 s 的 stream-tail 冒烟、3 个文件的 prefix-test、stamp-lines 冒烟）；合成小样的后台一对进程 stream-tail 28816 和 synth-writer 40292，`wait` 返回时已退出，01:2x 按 PID 查 Win32_Process 已不存在；另有两次 PowerShell（按 PID 查进程、读 CPU 负载）。按命令行里的 s1-codex 查过，没有残留的 node 进程。
- 不是我们起的：Codex Desktop 53044 一族、app-server 58228、守护进程 36748/54648，都没碰。

**~/.codex 里由 codex exec 自己写入的东西：**
- 新目录 sessions/2026/10/29/，和 rollout …01a189fb….jsonl（160,658 B）
- models_cache.json 从 234,796 B 变成 464,991 B（23:25:28.3）
- thread_history_1.sqlite 的 mtime（23:26:22.848，大小不变）
- state_5 的 -shm（23:25:21.8）和 -wal（23:26:22.1）
- thread-writer-locks/ 的 mtime（23:26:22.492）

logs_2 的 -wal/-shm 不算在 exec 头上（见 3G）。Orchestra 的代码零写入。测试会话可以用 `codex delete 01a189fb-8761-7f73-9e89-4d7db56e8a1f` 删掉，没有替你执行。

**读的范围。** 没读 auth.json、config.toml、history.jsonl、memories，也没读任何 sqlite 的内容，sqlite 只看了文件名、大小、mtime。会话内容只取了 type、payload.type、时间戳、cli_version、originator、字节数和偏移。修复者按编排器的授权读了第一位执行者的转录，只取了工具命令、codex 帮助文本、ls 元数据和时间戳。

**临时文件。** 草稿区 tmp/ 已清空：修复者用过的转录摘取脚本、冒烟输出、合成 .zst、前缀输出都已删除。evidence/ 保留，新增了 live-timeline.json、types-by-version.json、fix-dirscan-cost.json、fix-codex-home-meta-now.json。另外，Claude Code 自动把复核者一次 40 KB 的工具输出存成了 `C:/Users/Calx/.rec/claude/accounts/53087/config/projects/G---Projects-dsh-orchestra/9a172ed9-e9ae-47dd-b3c0-dc5700f0828c/tool-results/b5ww491o2.txt`，不是代理主动写的。按规则我们不能改动 %CLAUDE_CONFIG_DIR% 下的文件，所以留给编排器决定。

**仓库。** spikes/s1-codex/ 下只有 14 个 .mjs，没有 .jsonl 或 .zst；没有 git add，也没有 git commit。这份 REPORT.md 由编排器存入，因为子代理写报告类 .md 被 harness 规则禁止。
