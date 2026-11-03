# Handoff: claude/orchestra-app

## Facts
- Owner: AdamPlatin123
- When: 2026-11-03 00:24（本机 shell 报的时区是 GMT）
- Machine: 550W备份1号机
- Branch: claude/orchestra-app（从 `claude/alpha-0.2-interactive` 的 76807ec 切出）
- Commit: 1691129
- Pushed: no（这一轮的编排要求不 push；远端还没有这条分支。本分支 76807ec 之后的提交只在这台机器上）
- Uncommitted on that machine: `.claude/launch.json`（未跟踪，指向某次会话临时目录里的预览脚本，别的机器上没用，不要提交）。主检出目录里 r4 规格有用户本人的未提交改动，见 Do not touch。

## Goal
用户 2026-11-02 的目标：把 Orchestra 做到「应用整体可用」。一个守护进程 orchestrad，首页是塔表（你 → agent → subagent 的跨项目树），能只读观察 Claude、DSH、Codex 三家的会话；能经本机模型网关 magpie（`http://127.0.0.1:3425`，不要密钥）开 Orchestra 自己拥有的 Codex 和 Claude 会话（下称「自有会话」），在页面上对话、审批、停下；有一个派活台，先跑规则、再问路由模型，给出「派给谁」的建议卡片，由人点「派出」。总计划见 `docs/plans/2026-11-02-orchestra-app-plan.md`，给主人看的上手指南见 `docs/quickstart.md`。

## Done（已完成且已验证）
下面的验证都在本 worktree 根目录跑，node 用主检出目录的 `.tools/node24/node.exe`。前四条是 4465924 上跑的（上一轮交接原样保留），后面的是 6b6af32、1691129 上跑的。

- 全量单元测试（1691129）— 验证：`node --test "test/**/*.test.ts"`：1415 条，1412 过，0 失败，1 跳过，2 todo，约 38 秒。跳过的一条是「不能经目录链接写进 harness 根」，原因是本机建目录链接报 EPERM（要开发者模式或管理员）。两条 todo 是 M0 留下的（非 TTY 真实 profile 的配对路由、`--test-root-pid` 经 procguard 解析）。其中 `test/os/procguard-real.test.ts` 的两条真机用例（csc 实编 procguard，假 agent 起的 `ping -t` 在刹车和普通结束后都 0 个幸存）这次跑了，没有跳过。
- 自有 Codex 会话端到端（4465924）— 验证：`node scripts/live-smoke.ts --harness codex`，退出码 0。状态 starting → running → idle，结束为 ended/you-ended，审批 2 次（命令，shell 风险）都允许，文件内容对，残留进程 0。
- 自有 Claude 会话端到端（4465924）— 验证：`node scripts/live-smoke.ts --harness claude`，退出码 0。经 0.2 的 host 和 Claude Agent SDK 0.3.287，默认模型 `zcode/GLM-5.3`。审批 1 次（写文件）允许，文件内容对，残留进程 0。
- 派活台的路由建议（4465924）— 验证：`node scripts/live-route.ts`（不带 `--dispatch`），退出码 0。三句合成的话路由模型都回答了；只要建议不派出时自有会话数是 0；残留进程 0。
- 自有会话进 procguard 的 Job、刹车（6b6af32，上一个实现会话跑的，记在计划「procguard 实测」）— 验证：`live-smoke.ts --harness codex`、`--harness claude`、`--harness codex --brake`、`--harness claude --brake` 各一次，退出码都是 0；刹车两次都回 killed 5、left 0，会话以 braked 结束；按 pid + 创建时间查，0 个幸存。本会话没有重跑这四次，只重跑了下面三次。
- stdin 读到 EOF 就停机（1691129）— 验证：
  - `test/runtime/stdin-end.test.ts` 6 条全过：判断 stdin 类型；监视函数只触发一次、读出错也触发、撤销后不触发；进程内调用时日志记 stop-asked、控制台写原因、只跑一次停止；子进程用管道启动后关 stdin，退出码 0，日志有 stopped；stdin 为 ignore 时 1.5 s 后仍在跑；detached 的子进程在父进程被杀后自己停机。
  - `node scripts/live-smoke.ts --harness codex --daemon-stop`，退出码 0：会话空闲时关 orchestrad 的 stdin，orchestrad 以退出码 0 自己停机，会话记录的结束原因是 daemon-stop；Job 里的 codex.exe、codex-code-mode-host.exe、conhost.exe 按 pid + 创建时间查 0 个幸存，leftovers 0。
  - `node scripts/live-smoke.ts --harness claude --daemon-stop`，退出码 0：同上，Job 里是 node.exe（host）、claude.exe、conhost.exe，0 个幸存，leftovers 0。
  - `node scripts/live-smoke.ts --harness codex`（普通结束），退出码 0：ended/you-ended，tree-ended，之后 orchestrad 经关 stdin 停机（退出码 0），0 个幸存，leftovers 0。
  - 三次的测试目录都已删除。

## Unverified（做了但没验证，或验证没过）
- **真实 profile 下的启动检查没做**：编排要求让实现会话在真实 profile 下用 `orchestra.cmd --owned` 启动、经 API 配对、开一个自有 Codex 会话。没做，原因有两条：M0 计划 §2 的「agent 只能起测试 profile」和代-2（真实 profile 只由用户在可见控制台里启动、由用户配对）；代码的守卫 `decidePairingOutput` 在 stdin 和 stdout 不都是控制台时不打印配对码，脚本启动拿不到码。没有绕过。只查了：本会话 shell 是 Medium 完整性级别（不是管理员）；本会话环境里没设 `ORCHESTRA_HOME`，按 `src/runtime/env.ts` 真实数据目录是用户目录下的 `.orchestra`。真实 profile 能不能启动、塔表有多少项目和节点、自有会话在真实 profile 下能不能起停，全部未知。
- 被 Node 写的启动器直接启动、没有 detached 时：父进程被杀后 orchestrad 也没了，但日志里没有 stop-asked 和 stopped，说明是被父进程的 libuv Job 一起强行结束的（实测一次），自己的停止顺序没跑。这时自有会话的 Job 按 S4 用例 a 的机制应该也跟着关，但没有在会话还在跑时实测过。
- 会话还在跑时强杀 orchestrad：没有实测（上一轮就记着，本轮没变）。
- main.ts 给 stdout、stderr 加的空 error 监听是预防性的：唯一一次实测里，父进程死后写状态行没有报错，所以没有证据说明它是必须的。
- 页面没在真实浏览器里走过：塔表、解锁、派活台、审批卡（按住 / 键入「放行」）、三档停止键、亮暗主题、375px 窄屏，都只有假 DOM 测试。
- 派出（带建议的 routeId）后的 RouteDecision 记录、塔表顶上「你」那一行：没跑过 `live-route.ts --dispatch`，只有单元测试。
- 工作目录外的只读命令会不会先来问：只在 2026-11-02 早些时候用 `live-smoke.ts --outside` 各测过一次，算未知。
- 花费：Claude 对话流里的 cost 是 Claude CLI 按自己的价目表估的，走 magpie 的模型不在表里，真实花费未知。
- 自有会话跨重启：重启后没结束的会话显示状态未知，对话内容看不到。这是设计如此，但没有在真实重启下跑过。
- node.exe 只查存在和不是链接，没有哈希，也不复查大小和 mtime。
- Job 挡不住同一用户的进程（能复制出 Job 句柄改掉限制）；env-allowlist 文件被改不会被发现（只会少给变量）。
- 和 `claude/alpha-0.2-interactive` 的合并：那个 worktree 现在有没有更新的未提交改动，没去看，未知。
- 没做的：计划阶段 7（DSH 只读插件）；0.2 设计的导入（导入 Claude 会话、DSH 快照，`ImportStager` 没有调用方）；r4 §9.2 的 router-core（硬过滤、Wilson 证据门、滞回、影子模式）；M0 的全局刹车 `/api/brake/plan`、`/api/brake/execute` 仍没有处理函数；`package.json` 的 `build:procguard` 指向的 `scripts/build-procguard.ts` 不存在。

## Next（按优先级，每条可独立执行）
1. 真实 profile 启动检查（只能由用户本人做）— 按 `docs/quickstart.md` 第 6 节：在普通（非管理员）cmd / PowerShell / Windows Terminal 里，在仓库根目录运行 `orchestra.cmd --owned --peek-port 7470`（worktree 里先设 `ORCHESTRA_NODE` 指向主检出目录的 `.tools\node24\node.exe`）。验收：控制台打印配对码、`procguard on`、两家 `owned … sessions on`，最后一行 `working (real profile …)`；页面配对后塔表有数据，顶栏数字等于点开后的行数；派一个 Codex 会话（「只回复 ok，不用工具」）到空闲，结束会话后对话里有 tree-ended 一类说明；Ctrl+C 后任务管理器里没有 codex.exe、procguard.exe。结果记进本文件 Done 或 Unverified。
2. 真实浏览器走一遍（测试 profile）— 在 `%TEMP%` 下建 `orchestra-test-ui-<随机>` 和它下面的 `roots\`，运行 `node src/boot.ts --test-profile --test-dir <该目录> --peek-port <空闲端口> --owned`，浏览器开 `http://orchestra.localhost:<端口>`，配对、解锁，派一个 Codex、一个 Claude 会话，各处理一次审批（一次允许、一次拒绝），中断、结束、刹车各试一次；亮色、暗色、375px 宽各看一遍。验收：每一步页面状态和 `GET /api/owned` 一致，没有控制台报错。
3. `scripts/live-route.ts --dispatch` — 跑一次。验收：`dispatch.status` 为 200，`dispatchEnded.settled` 为 ended，`routerRow` 不为 null 且 `linked` 为 true，`leftovers.leftover` 为 0，`orchestradStopped.how` 为 stdin-eof。
4. `scripts/live-smoke.ts --harness codex --outside` 和 `--harness claude --outside` — 各重跑一次。验收：`approvalsAllowed` 里有命令卡，`ranUnasked` 为 0；结果追加到计划「第 3 阶段复核后补记」，仍写「未知」直到有更多次。
5. 会话在跑时强杀 orchestrad — 给 `scripts/live-smoke.ts` 加一个模式：会话空闲时用 `child.kill()`（不先关 stdin），之后用脚本自己的 procguard 探针按 pid + 创建时间查 Job 里的进程。验收：0 个幸存；把结果写进计划「进程树的 Job 回收」一条的残余 ②。
6. `package.json` 的 `build:procguard` — 要么删掉这条脚本，要么加 `scripts/build-procguard.ts`（经 `src/os/procguard.ts` 的 ensureProcguard 编到测试目录）。验收：全量测试 0 失败，`npm run` 列出的脚本都指向存在的文件。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的第七批改动。本分支只读引用它，不改、不提交、不覆盖。
- `.claude/launch.json`（未跟踪）：本机某次会话的预览配置，不提交。

## Open questions
- 真实 profile 下开不开自有会话：0.2 设计第 528 行原本要求真实 profile 下 owned-disabled，被本计划 §2 取代成两种 profile 都开（带 `--owned` 且找到 codex.exe 才开）。要恢复限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')。由用户定。
- 实现会话能不能在真实 profile 下联调：现行约定（M0 计划代-2）是不能。这一轮的编排要求过，被拒了。要放开，需要用户本人改约定，并决定配对码怎么交给 agent（现在只打印在交互式控制台）。
- 什么时候 push、推到哪：本分支没 push，远端没有它。
- 本机 `%TEMP%` 下有不是本会话留的 `orchestra-test-*` 目录（上一轮数过 26 个），要不要清由用户决定。本会话的测试目录都已删。
- 0.2 交接文件（`docs/handoff/claude--alpha-0.2-interactive.md`）里列的设计 §8 待定项（SDK 许可证、配置目录、单条消息上限、M0 动作是否接操控令牌等）仍没有逐条问过用户。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-02 AdamPlatin123：本分支第一次写交接。和 r4、0.2 设计的出入都记在 `docs/plans/2026-11-02-orchestra-app-plan.md` 的「分歧和残余风险」一节，这里不重复。
- 2026-11-03 AdamPlatin123：上一份交接写在 4465924，之后的 6b6af32（procguard 的 Job 和刹车）没有更新交接，那份的「进程树回收」「刹车」两条 Unverified 和 Next 第 5、6 条已过时。本次改写：那两条移进 Done，Next 重排。编排要求的真实 profile 检查和 M0 计划的「agent 只能起测试 profile」冲突，没做，记在 Unverified 和 Open questions。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D4 | 三类所有权（observed 只看 / owned 自有 / foreign 别人的）；每个自有子进程各在一个随关闭即杀的 Job 里，由 procguard 拉起 | r4 §4 |
| D8 | 只有一个审批队列，超时即拒；批准、拒绝、拍板、刹车只挂在要配对 cookie 的页面上，不经 agent、不自动放行 | r4 §4 |
| D9 | AutoRoute：先确定性规则，再 router-core，只有模糊时才用 LLM；先影子后上线 | r4 §4 |
| 代-2 | 真实 profile 只由用户在可见控制台里启动和配对；配对码只在 stdin、stdout 都是 TTY 时打印；agent 只许起测试 profile | `docs/plans/2026-10-31-m0-implementation-plan.md` |
| r4 §9.2 | 路由的十步流水线；拿不准时出「Route to?」卡，绝不默认派给谁 | r4 §9.2 |
| r4 §9.5 | M1 起每次派活都记一条 mode=manual 的 RouteDecision | r4 §9.5 |
| r4 §10.9 | 审批：超时即拒（默认 30 min）、批准绑定请求摘要、列表变化后 750 ms 内无效、高风险要键入或长按确认 | r4 §10.9 |
| RouteDecision | 每次派活写进 journal 的一条 `route` 记录：候选、人选了哪个、理由、路由模型和它为什么没用上 | 计划 §3、`src/route/` |
| T1 / T2 / T3 | 诚实规则：不知道写「未知」不写「没有」 / 不写「完成」 / 计数等于它链接的列表长度 | `shared/tower-contract.js` 注释、计划 §1 |
| M0 / M1 | r4 的里程碑：只读注意力层 / 自有会话互发消息 | r4 §4 D1 |
| S4 用例 a | procguard 实验里的一例：Node 父进程把子进程放进自己的 libuv Job，父进程一死子进程跟着死 | `spikes/s4-procguard/REPORT.md` |
| 0.2 设计 | alpha 0.2 交互薄切片的设计稿（Claude host、审批、POST 检查链） | `docs/plans/2026-11-02-alpha-0.2-slice-design.md` |
| 测试 profile | `--test-profile --test-dir <dir>`：数据全在那个测试目录里，不碰真实数据 | `src/boot.ts` |
| magpie | 本机模型网关，`http://127.0.0.1:3425`，不要密钥 | 计划「已实测」 |
| procguard / Job | 本仓库的 C# 进程看守程序；Job 是 Windows 的进程组，可整组结束 | `native/procguard/ProcGuard.cs` |
| daemon-stop | 自有会话的结束原因：orchestrad 停机时结束了它 | `shared/strings.js` life.daemon-stop |
