# Handoff: claude/orchestra-app

## Facts
- Owner: AdamPlatin123
- When: 2026-11-02 23:06（本机 shell 报的时区是 GMT）
- Machine: 550W备份1号机
- Branch: claude/orchestra-app（从 `claude/alpha-0.2-interactive` 的 76807ec 切出）
- Commit: 4465924
- Pushed: no（这一轮的编排要求不 push；远端还没有这条分支。本分支 76807ec 之后的 18 个提交只在这台机器上）
- Uncommitted on that machine: `.claude/launch.json`（未跟踪，指向某次会话临时目录里的预览脚本，别的机器上没用，不要提交）。主检出目录里 r4 规格有用户本人的未提交改动，见 Do not touch。

## Goal
用户 2026-11-02 的目标：把 Orchestra 做到「应用整体可用」。一个守护进程 orchestrad，首页是塔表（你 → agent → subagent 的跨项目树），能只读观察 Claude、DSH、Codex 三家的会话；能经本机模型网关 magpie（`http://127.0.0.1:3425`，不要密钥）开 Orchestra 自己拥有的 Codex 和 Claude 会话（下称「自有会话」），在页面上对话、审批、停下；有一个派活台，先跑规则、再问路由模型，给出「派给谁」的建议卡片，由人点「派出」。总计划见 `docs/plans/2026-11-02-orchestra-app-plan.md`。

## Done（已完成且已验证）
下面的验证都在 4465924 上、在本 worktree 根目录跑，node 用主检出目录的 `.tools/node24/node.exe`。

- 全量单元测试 — 验证：`node --test "test/**/*.test.ts"`：1378 条，1375 过，0 失败，1 跳过，2 todo，约 39 秒。跳过的一条是「不能经目录链接写进 harness 根」，原因是本机建目录链接报 EPERM（要开发者模式或管理员）。两条 todo 是 M0 留下的（非 TTY 真实 profile 的配对路由、`--test-root-pid` 经 procguard 解析）。单元测试只用假子进程和合成数据。
- 自有 Codex 会话端到端 — 验证：`node scripts/live-smoke.ts --harness codex`，退出码 0。测试 profile，真实 codex.exe（app-server）经 magpie，默认模型 `codex/gpt-6.1-sol`。会话状态 starting → running → idle，结束为 ended/you-ended。审批 2 次，都是命令（shell 风险），脚本代人点了允许，没有被拒。对话流事件：you 1、msg-queued 1、msg-sent 1、started 1、turn-started 1、text partial 1、text final 2、ask:command 2、answer:accept 2、tool:command 2、tool-result:ran 2、tokens 3、turn-ended 1。要求写的文件在工作目录里，内容对；回复里提到了约定的词。残留进程 0（登记 1 个，结束后查无）。测试目录已删。
- 自有 Claude 会话端到端 — 验证：`node scripts/live-smoke.ts --harness claude`，退出码 0。经 0.2 的 host 子进程和 `hosts/claude/node_modules` 里的 Claude Agent SDK 0.3.287，默认模型 `zcode/GLM-5.3`。状态 starting → running → idle，结束为 ended/you-ended。审批 1 次（写文件），允许，没有被拒。对话流事件：you 1、msg-written 1、msg-sent 1、started 1、ask:file-change 1、answer:accept 1、tool:file-change 1、tool:tool 1、text final 1、turn-ended 1、cost 1。文件内容对，回复提到约定的词。残留进程 0。测试目录已删。
- 派活台的路由建议 — 验证：`node scripts/live-route.ts`（不带 `--dispatch`），退出码 0。三句合成的话，路由模型（magpie 上的 `zcode/GLM-5.3`）三次都回答了，耗时约 6.6 s、2.5 s、2.8 s：
  - 「把 README 翻成英文」：规则 code-or-command、fallback，候选 2 个（路由模型选的 claude，规则给的 codex）。这句被当成改文件，是 `src/route/rules.ts` 的 FILE_RE / EDIT_RE 有意为之。
  - 「用 codex 修一个测试」：规则 named-harness 等，候选 2 个，路由模型同意规则的 codex。
  - 「解释一下这段代码」：规则 short-question、fallback，候选 3 个。
  - 只要建议不派出：之后自有会话数是 0（建议不起会话）。没有不可用的 harness。残留进程 0。

## Unverified（做了但没验证，或验证没过）
- 页面没在真实浏览器里走过（本会话没做）：塔表、解锁、派活台对话框、审批卡（按住 / 键入「放行」）、对话区、亮暗主题、375px 窄屏，都只有假 DOM 测试。live-smoke 和 live-route 是按页面的请求方式直接打 HTTP，不经页面。
- 派出（带建议的 routeId）后的 RouteDecision 记录、塔表顶上「你」那一行显示最近一次派活：本会话没跑 `live-route.ts --dispatch`，只有单元测试。
- 工作目录外的只读命令会不会先来问：只在 2026-11-02 早些时候用 `live-smoke.ts --outside` 各测过一次（计划里记的），本会话没重跑。一次不代表总是如此，算未知。
- 真实 profile 下带 `--owned` 启动：代码允许（计划「分歧和残余风险」第 2 条），从没实跑过；本阶段只许在测试 profile 里联调。
- 进程树回收：结束会话时只杀 codex.exe 或 host 本身，它们跑的命令起的子进程可能残留（没有 Job，procguard 的 run-in-job 还没有）。live 脚本只查登记过的直接子进程。
- orchestrad 读到 stdin EOF 自己停机：没做。父进程被强杀时，自有会话的停止顺序不会走。
- 刹车：自有会话没有接刹车路由（df96369 的提交说明写「no brake route in the daemon yet, the page says so」）；本会话没有单独核实页面上的说法。
- 花费：对话流里的 cost 是 Claude CLI 按自己的价目表估的，走 magpie 的模型不在表里，真实花费未知。
- 自有会话跨重启：重启后没结束的会话显示状态未知，对话内容看不到（只在旧进程内存里）。这是设计如此，不是缺陷，但没有在真实重启下跑过。
- node.exe（`.tools/node24/node.exe`）只查存在和不是链接，没有哈希，也不复查大小和 mtime。
- 和 `claude/alpha-0.2-interactive` 的合并：bc212a1 搬来的是 0.2 会话当时未提交的快照。那个 worktree 现在有没有更新的未提交改动，本会话没去看（按要求不碰其他 worktree），未知。
- 计划里的阶段 7（DSH 只读插件）没做；0.2 设计里的导入（第 11、12 步：导入 Claude 会话、DSH 快照）没做，`ImportStager` 仍没有调用方。
- r4 §9.2 要的 router-core（硬过滤、Wilson 证据门、滞回）没做，只有五条确定性规则加一次路由模型；没有影子模式和类型化拒绝码。

## Next（按优先级，每条可独立执行）
1. 真实浏览器走一遍 — 在本 worktree 根目录建一个 `%TEMP%\orchestra-test-ui-<随机>` 目录和它下面的 `roots\`，运行 `node src/boot.ts --test-profile --test-dir <该目录> --peek-port <空闲端口> --owned`，用浏览器开 `http://orchestra.localhost:<端口>`，用控制台打印的配对码配对、解锁码解锁；派一个 Codex、一个 Claude 会话，各处理一次审批（一次允许、一次拒绝），中断、结束。分别在亮色、暗色和 375px 宽度下看。验收：每一步页面状态和 `GET /api/owned` 一致，没有控制台报错；发现的问题记进本文件 Unverified 或修掉。
2. `scripts/live-route.ts --dispatch` — 跑一次。验收：`dispatch.status` 为 200，`dispatchEnded.settled` 为 ended，`routerRow` 不为 null 且 `linked` 为 true，`leftovers.leftover` 为 0。
3. `scripts/live-smoke.ts --harness codex --outside` 和 `--harness claude --outside` — 各重跑一次。验收：`approvalsAllowed` 里有命令卡，`ranUnasked` 为 0。结果追加到计划「第 3 阶段复核后补记」那条，仍写「未知」直到有更多次。
4. `src/boot.ts` / `src/main.ts` — 加「stdin 读到 EOF 就按正常停机走」（先结束所有自有会话、等 host 停止顺序，再关库退出），配一条用假子进程的测试。验收：全量测试 0 失败；live-smoke 里把 `child.kill()` 前改成先关 stdin 时，leftovers 仍为 0。
5. `src/os/spawn.ts` 的 codex-app-server、claude-host 两条规则 — 等 procguard 有 run-in-job 后改为经 Job 启动（计划「进程树没有 Job 回收」一条）。验收：会话结束后它跑的命令起的子进程也被结束，有测试。
6. 自有会话的刹车 — 在 `src/server/routes.ts` 已声明的 `POST /api/brake/plan`、brake 动作上接处理函数，或明确在页面上只给「结束」。先读 r4 的刹车章节和 0.2 设计再定。验收：全量测试 0 失败，页面说法和实际一致。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动（写交接时 `git status` 显示 M）：用户本人的第七批改动。本分支只读引用它，不改、不提交、不覆盖。
- `.claude/launch.json`（未跟踪）：本机某次会话的预览配置，不提交。

## Open questions
- 真实 profile 下开不开自有会话：0.2 设计第 528 行原本要求真实 profile 下 owned-disabled，被本计划 §2 取代成两种 profile 都开（带 `--owned` 且找到 codex.exe 才开）。要恢复限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')。由用户定。
- 什么时候 push、推到哪：本分支没 push，远端没有它。
- 本机 `%TEMP%` 下有 26 个 `orchestra-test-*` 目录（不是本会话留的，本会话的三个测试目录都已删）。要不要清，由用户决定。
- 0.2 交接文件（`docs/handoff/claude--alpha-0.2-interactive.md`）里列的设计 §8 待定项（SDK 许可证、配置目录、单条消息上限、M0 动作是否接操控令牌等）仍没有逐条问过用户。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-02 AdamPlatin123：本分支第一次写交接。和 r4、0.2 设计的出入都记在 `docs/plans/2026-11-02-orchestra-app-plan.md` 的「分歧和残余风险」一节（受保护路径直接拒、真实 profile 也开、页面上限放宽到 `ui/` 200 KiB / 页面 240 KiB、Claude 模型放宽到 `zcode/*` 和 `opencode-go/*`、并发两家合计 3 个、router-core 简化等），这里不重复。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D4 | 三类所有权（observed / owned / foreign）；每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起（本分支还没有 Job，是残余风险） | r4 §4 |
| D8 | 只有一个审批队列，超时即拒；批准、拒绝、拍板、刹车只挂在要配对 cookie 的页面上，不经 agent、不自动放行 | r4 §4 |
| D9 | AutoRoute：先确定性规则，再分叉的 router-core（硬过滤、Wilson 门、滞回），只有模糊时才用 LLM；先 shadow 后 active | r4 §4 |
| r4 §9.2 | 路由的十步流水线；第 10 步：置信度低或路由器失败时出「Route to?」卡，绝不默认派给谁 | r4 §9.2 |
| r4 §9.5 | M1 起你每次派活都记一条 mode=manual 的 RouteDecision，M4 再进 shadow | r4 §9.5 |
| r4 §10.9 | 审批：超时即拒（默认 30 min）、批准绑定请求摘要、列表变化后 750 ms 内无效、高风险要键入或长按确认、toast 里不放「允许」 | r4 §10.9 |
| Route to? | 拿不准派给谁时出一键选择的卡片让人选，绝不默认派活 | r4 §9.2 第 10 步 |
| RouteDecision | 每次派活写进 journal 的一条 `route` 记录：候选、人选了哪个、理由、路由模型和它为什么没用上 | 计划 §3、`src/route/` |
| T1 / T2 / T3 | 诚实规则：不知道写「未知」不写「没有」 / 不写「完成」 / 计数等于它链接的列表长度 | `shared/tower-contract.js` 注释、计划 §1 |
| M0 / M1 | r4 的里程碑：只读注意力层 / 自有会话互发消息 | r4 §4 D1 |
| 0.2 设计 | alpha 0.2 交互薄切片的设计稿（Claude host、审批、POST 检查链） | `docs/plans/2026-11-02-alpha-0.2-slice-design.md` |
| 测试 profile | `--test-profile --test-dir <dir>`：数据全在那个测试目录里，不碰真实数据 | `src/boot.ts` |
| magpie | 本机模型网关，`http://127.0.0.1:3425`，不要密钥，提供 `zcode/*`、`opencode-go/*`、`codex/*` 等模型 | 计划「已实测」 |
| procguard | 本仓库的 C# 进程看守辅助程序，计划中的 run-in-job 会把子进程放进随父进程结束的 Job | 0.2 设计 §8 第 3 条 |
