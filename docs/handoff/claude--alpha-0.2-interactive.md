# Handoff: claude/alpha-0.2-interactive

## Facts
- Owner: AdamPlatin123
- When: 2026-11-02 12:27 +00:00
- Machine: 550W备份1号机
- Branch: claude/alpha-0.2-interactive（从 `claude/alpha-0.1` 的 eead531 切出）
- Commit: 97ef0b7
- Pushed: no（push 要等用户点头）
- Uncommitted on that machine: none（本分支 worktree 在 `.claude/worktrees/alpha-0-2`）
- 设计稿 `slice-design.md`（alpha 0.2 交互薄切片和导入的设计方案，中文，约 86 KB）**不在仓库里**，只在那台机器上编排会话的临时目录里。下文的「第 N 步」「§N」都指它。别的机器上拿不到，接手前先请用户把它提交进来或另行提供。

## Goal
在 Stage 页上做出可交互的薄切片和导入：在测试 profile 下新开 Orchestra 自己拥有的 Claude 会话（下称「自有会话」），发消息、审批工具调用、停下；把已观察到的 Claude 会话导入或复制一份接着做；把 DSH 会话复制一份快照。2026-11-02 用户决定把这些提前做，早于 r4 的计划（见 Divergence）。

## Done（已完成且已验证）
测试命令都是在 worktree 根目录跑全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`）。起点 eead531：1079 条，1076 过，0 失败，1 跳过，2 todo。

- e949a73 spawn 闸的环境变量白名单和 cwd 检查（设计第 1 步）：每条 spawn 规则只拿固定的几个环境变量，值在建闸时拷一次；`NODE_OPTIONS`、`NODE_PATH` 永不传给子进程；`node-proc.ts` 不再把整个 `process.env` 交给子进程；新增 `src/os/cwd.ts`，按拒绝表和允许根检查调用方给的 cwd。允许根（`allowedRoots`）是参数，空表什么都不允许。— 验证：全量 1090 条，1087 过，0 失败。真实 whoami 用缩减后的环境跑通；真实 csc 用 csc 的变量在临时目录编译过一个小 C# 文件。
- b04626d 自有会话协议冻结（设计第 4 步）：`shared/protocol.js` 新增 9 个人类动作、19 个错误码；`src/server/routes.ts` 新增 14 条自有会话路由的形状和两种访问级别（`cookie`、`unlocked`），没有处理函数；冻结样例 `OWNED_ROUTES`。— 验证：全量 1098 条，1095 过，0 失败。
- b0ffefd 导入用的暂存复制（设计第 10 步）：写围栏新增 `renameDir`；读闸新增 `entries`；新模块 `src/import/staged-copy.ts`（`ImportStager`、`Stage`：begin → addFile/addTree → copy → writeReceipt → commit | discard）。— 验证：全量 1110 条，1107 过，0 失败；`test/import/staged-copy.test.ts` 全用合成数据，含真实 junction 的用例（没有跳过）。
- 1a15923 在跑的条上飘小音符（设计稿以外的 UI 小改动）：只给登记表确认在跑的条加音符，每页最多 6 条；减少动效时显示一个静止音符。— 验证：全量 1113 条，1110 过，0 失败；只在假 DOM 测试里验证。
- 97ef0b7 复核修正：复核 13 条发现，逐条对照代码核实，13 条都修了。要点：
  - 代理变量检查不再依赖 URL 解析，无 scheme 的 `user:pass@host` 也会被拒；名字含 proxy 的变量都查；同名不同大小写的附加变量被拒。
  - 暂存复制每个文件只开一次读句柄（读闸新增 `openRead`），所有分块都从这一个句柄读，并核对计划时的真实路径和 dev/ino；同名换了文件，即使允许变化也作废。
  - `ImportStager` 必须给 `stagingParent`（设计 §3.0 指定 ORCHESTRA_HOME 下的 tmp，每次启动清空）；放在目标旁边要调用方明确要求。
  - 改名已发生但事后检查失败时，状态记为 `unverified`，抛 `commit-unverified`，不再去删一个已经不存在的暂存目录。
  - `renameDir` 的注释写明 Windows 上的缺口：检查之后、改名之前出现在目标处的**文件**会被静默替换；有测试钉住这一行为。
  - cwd 拒绝表加上重定向的 `APPDATA` / `LOCALAPPDATA`，以及 worktree 所属的主检出目录（另可经 `spec.repoRoots` 指定）。
  - `text-too-long` 的提示改成中性的「文字太长」；图例改为「小音符：确认在跑（只标前 6 条）」，图例图标改用单个音符；音符的路径拆成单段子路径，不再被填成三角形。
  — 验证：全量 1118 条，1115 过，0 失败，1 跳过，2 todo。页面体积：`ui/` 98616 / 102400 字节；`/stage` 加载总量 143336 / 143360 字节，余量 24 字节。

## Unverified（做了但没验证，或验证没过）
- 没有驱动过任何会话：没有 SDK host（第 2、3 步没做），自有会话一次也没起过。
- 端点不做任何事：14 条自有会话路由只有形状，没有处理函数（第 5、6c 步没做）。没有检查现在对这些路由发请求会得到什么。
- `ImportStager` 没有任何调用方；导入流程（第 11、12 步）没做。磁盘剩余空间检查只在调用方传 `freeBytes` 时生效（写围栏的 io 没有 statfs）。
- 小音符没在真实浏览器、真实数据上看过：亮暗主题、减少动效、`var()` 写在 keyframes 里的跨浏览器表现、拆路径后的形状，都只在假 DOM 里测过。
- powershell-toast 的环境变量名单是暂定的，要等第 17 步（早先计划里引入 toast 脚本的那一步）才能真跑。
- 本分支所有提交都没有 push。

## Next（按设计 §7 的顺序；每条标出依赖和要等的决定）
1. 第 0 步：探针补测（在 sdk-probe 分支做，不进本分支），12 项清单见设计 §7。第 11、12 步以它的结论为前提。
2. 第 2 步：`hosts/claude/`（host 子进程、假 SDK、规范化 JSON 测试向量、扫描规则）。**等「SDK 路线」决定**：选 C 时这一步要重写。
3. 第 3 步：`claude-host` spawn 规则、node.exe 位置、哈希钉死、`owned-proc.ts`、停止顺序。依赖第 1、2 步，**等「SDK 路线」决定**。claude-host 的环境变量名单和固定附加项放进 `src/os/spawn.ts` 的 `envExtra`；把它加进接受调用方 cwd 的规则名单（现在为空）。
4. 第 5 步：POST 底座（sid→csrf 映射、操控码 `unlock-code` / `unlock`、检查链、写 Store 的 `human` 记录）。依赖第 4 步（已做），不等决定。要顺带定：正文超过 64 KiB（`OWNED_BODY_MAX_BYTES`）返回什么状态码，设计没给。`owned-disabled` 由哪个 profile 触发，**等「0.2 只开测试 profile」决定**。
5. 第 6a 步：驱动和登记（起停、队列、停止顺序、重启改 `unknown`、重试检查）。依赖第 3 步。cwd 的允许根要在这里接线，**等「0.2 只开测试 profile」决定**，并且先解决下面 Open questions 里 AppData 和 `%TEMP%` 的冲突，否则测试目录下的 `work\` 一律被拒。
6. 第 6b 步：审批队列（digest、rev、作废、超时）。依赖 6a。超时时长等设计 §8 第 7 条。
7. 第 6c 步：端点 new / message / interrupt / end / retry / approvals / owned / feed，`working.ts` → `http.ts` 接线，`--claude-gateway` 参数。依赖第 5 步和 6b。
8. 第 7 步：`shared/owned-contract.js`（`validateOwnedList` / `validateOwnedFeed`）和金样例。依赖 6c。`OwnedList`、`OwnedFeed` 路由现在只挂着契约名，等这一步。
9. 第 8 步：只改页面体积上限。**等「体积上限」决定**；必须排在第 9 步前。现在只剩 24 字节余量，任何前端改动都会撞线。
10. 第 9 步：UI（解锁、自有会话区、会话卡、输入框、审批卡、停下、结束、重试，`api.js` 的 POST），之后跑 `scripts/embed-ui.ts`。依赖第 7、8 步。
11. 第 11 步：Claude 导入（check 端点、活着还是结束、切点、回执、交接说明）。依赖第 0、6c、10 步。**等「导入默认算不算污染」和「0.2 只开测试 profile」决定**。`ImportStager` 的 `stagingParent` 传 ORCHESTRA_HOME 下的 tmp；用 Clock 重试 `busy`（约 2 秒内 5 次）、把错误映射成 HTTP 413/503 都在这一步做。
12. 第 12 步：DSH 快照（可单独拿掉）。依赖第 0、10 步。**等设计 §8 第 9 条（带不带进 0.2）**。
13. 第 13 步：`NOTICE` 写明 DS-Bot（Apache-2.0）和 `dsh-session-format` 正则（MIT）的出处。依赖第 12 步。
14. 第 14 步：测试 profile 下用 magpie 网关实测一遍，更新本交接文件。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的。

## Open questions
四个未定的决定（实现时都只做了各选项共有的部分，取决于决定的值做成了参数）：
- **SDK 路线**（设计 §8 第 1 条）：B 独立 host 子进程（用真 SDK，围栏不动，host 靠专属扫描规则和哈希钉死来管），还是 C 直接说 stream-json（零依赖，但要复刻没有文档的协议）。设计推荐 B。
- **0.2 只开测试 profile**（设计 §8 第 12 条）：0.2 只在测试 profile 下、只在测试目录里干活，还是允许在测试 profile 下选真实项目当 cwd（项目内容会发给 magpie）。设计推荐前者。
- **页面体积上限**（设计 §4.2、§8 第 5 条）：放宽到页面 168 KiB、`ui/` 120 KiB，还是把对话区做成单独的乐手页（Stage 只加约 5 KB，仍要小幅放宽）。
- **导入的会话默认算不算污染**（设计 §8 第 6 条，对应 r4 §8.5 的 taint 规则）：算则每次用工具都问，连 Read 也问；不算则和新开会话一样。设计推荐默认算。

设计 §8 的其他待定项：
- 第 2 条 SDK 许可证：仓库只放 `package.json` 加 lockfile、本机 `npm ci`，明着偏离 D5 写的 vendored；r4 §12.2 要用户补一行。
- 第 3 条 没有 procguard 的 Job 回收：接受现状的残余风险，还是先补 `run-in-job`。
- 第 4 条 配置目录和登录：每个会话一个私有配置目录，还是沿用你的 `~/.claude`（Q8 = A）。真实 profile 开放前再定。
- 第 7 条 审批超时：沿用 Q4 的 30 分钟，还是 5 分钟。
- 第 8 条 Desktop 托管、已结束的会话能否 resume，还是只给 fork。
- 第 9 条 DSH 快照带不带进 0.2。
- 第 10 条 对话正文进 JSON（偏离 M0「帧不带源文本」的约定），建议和 alpha 0.1 的同类偏离一起决定。
- 第 11 条 单条消息 2 KB 上限照守，还是放宽到 16 KB。
- 第 13 条 CLI 内置技能和插件关不掉时，是否改为一张由你确认的钉死名单。
- 第 14 条 M0 的 `GET /api/session` 仍只凭 cookie 发 csrf，`seen`、`snooze`、`brake` 等动作是否也接到操控令牌上（要改冻结契约）。

本分支实现中冒出来、要人确认的：
- **AppData 和 `%TEMP%` 冲突**：设计要求 cwd 只能在测试目录的 `work\` 下，测试 profile 又要求测试目录直接放在 `%TEMP%`（默认就在 `%USERPROFILE%\AppData\Local\Temp`）；而拒绝表不许 cwd 落在 AppData 里。现在默认 TEMP 下的 `work\` 一律被拒，有测试钉住。可选：AppData 规则对 `%TEMP%` 开口子，或把 work 目录挪到别处。
- 路由路径参数写成 `:id`，不是设计里的 `:ownedId` / `:approvalId` / `:stageId`（已有测试要求路由只含小写字母）。
- `text-too-long` 现在同时用于提醒（120 字）和自有会话消息（2048 字节），提示文字已改成不带数字的「文字太长」；要不要拆成两个错误码，在处理函数落地前定。
- 设计稿要不要提交进仓库（见 Facts）。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-02 AdamPlatin123：本分支早于 r4 的计划。r4 的 D1（工作顺序）是：M0 只做只读注意力层，M1 才有自有会话互发消息，M2 安全强制。按 D1，M0 阶段不该出现对话和导入。处理：用户 2026-11-02 决定提前做；M0 的各条不变量照守，在此记录。
- 2026-11-02 AdamPlatin123：实现与设计稿的出入。
  - 暂存复制放在 `src/import/staged-copy.ts`，不在 `src/fs/`：仓库扫描规则禁止 `src/fs/` 下除读闸、写围栏、node-io 以外的文件做读写调用。
  - 没有 `fence.mkdtemp`：扫描规则禁止在写围栏以外出现这个词。改为用 `mkdirp` 建随机名目录，只认 mkdirp 报告由它新建的。
  - 读闸新增 `openRead`，供导入复制用（复核修正，97ef0b7）。
  - 设计第 1、4、10 步之外多做了一件 UI 小事（1a15923 飘小音符）。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D1 | 工作顺序：M0 只读注意力层 → M1 自有会话互发消息 → M2 安全强制 → M3 声部 → M4 Maestro / AutoRoute | r4 §4 |
| D5 | 自有驱动：Claude 用 vendored 的 dsh-TUI SDK 后端，强制关 bypass，不继承你的设置、hooks、`.mcp.json`（设计 §8 第 2 条说明这里不 vendored） | r4 §4 |
| M0 / M1 / M2 | r4 的里程碑：只读观察 / 自有会话互发消息 / 安全强制 | r4 §4 D1 |
| r4 §5.3 | orchestrad 只写自己的数据目录；agent 的 cwd 不得落在 Orchestra 数据目录、任何 DSH_HOME、任何 CLAUDE_CONFIG_DIR 里 | r4 §5.3 |
| r4 §8.5 | taint（污染）：来源链里有外部或未知来源的会话，权限收紧 | r4 §8.5 |
| Q4 | 审批超时代定 30 分钟后算拒绝，可按项目覆盖 | 设计 §8 第 7 条转引 r4 |
| Q8 = A | 自有 Claude 沿用你的 CLAUDE_CONFIG_DIR，复用登录（2026-10-29 已定） | r4 §17 Q8 |
| 第 N 步 | 设计 §7 工作拆分表的行号 | slice-design.md §7 |
| 第 17 步 | 更早的计划里引入 toast 脚本的那一步；之前 powershell-toast 规则不能启用 | `src/os/spawn.ts` 注释 |
| magpie | 本机的模型网关，0.2 的自有会话经它调用模型 | 设计 §0 |
| procguard | 本仓库的 C# 辅助进程（进程看守），计划中的 `run-in-job` 会把子进程放进随父进程结束的 Job | 设计 §8 第 3 条 |
