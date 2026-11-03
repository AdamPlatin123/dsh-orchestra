# Handoff: claude/orchestra-app

## Facts
- Owner: AdamPlatin123
- When: 2026-11-03（项目根、日常使用文档之后；本机 shell 报的时区是 GMT）
- Machine: 550W备份1号机
- Branch: claude/orchestra-app（从 `claude/alpha-0.2-interactive` 的 76807ec 切出）
- Commit: a3cf458（代码和文档的最后一个提交；本交接文件随后单独提交）。上一份交接写在 99deb75（Commit 记为 4d7387e），之后依次是：461ac11 seat 去重、8bc1bd9 宽屏底栏、e483824 窄屏自有框、73bad96 后台标题和 seat 去重复核、7f71981 日常使用文档和启动脚本、75e2942 项目根、e850a20 项目根复核修正、a3cf458 quickstart 补项目根
- Pushed: no（远端还没有这条分支。76807ec 之后的提交只在这台机器上）
- Uncommitted on that machine: `.claude/launch.json`（未跟踪，本机某次会话的预览配置，不要提交）。主检出目录里 r4 规格有用户本人的未提交改动，见 Do not touch。

## Goal
用户 2026-11-02 的目标：把 Orchestra 做到「应用整体可用」。一个守护进程 orchestrad，首页是塔表（你 → agent → subagent 的跨项目树），能只读观察 Claude、DSH、Codex 三家的会话；能经本机模型网关 magpie（`http://127.0.0.1:3425`，不要密钥）开 Orchestra 自己拥有的 Codex 和 Claude 会话（下称「自有会话」），在页面上对话、审批、停下；有一个派活台，先跑规则、再问路由模型，给出「派给谁」的建议卡片，由人点「派出」；DSH 会话可以经 seat 请求派自有会话，由人在配对页派出或拒绝。总计划见 `docs/plans/2026-11-02-orchestra-app-plan.md`，给主人看的上手指南见 `docs/quickstart.md`，启动脚本 `start-orchestra.cmd`。

## Done（已完成且已验证）
全部在本 worktree 根目录跑，node 用主检出目录的 `.tools/node24/node.exe`，只用测试 profile（代-2）。

- 全量单元测试（a3cf458）— `node --test "test/**/*.test.ts"`：1519 条，1516 过，0 失败，1 跳过（建目录链接报 EPERM，要开发者模式或管理员），2 todo（M0 留下的两条），约 33 秒。
- 项目根 `--project-root`（75e2942、e850a20）— `node scripts/live-smoke.ts --harness codex --project-root` 在 a3cf458 上跑，退出码 0：页面列出 `<testDir>\proj`；会话 cwd.kind 为 project-root；文件写进项目根、内容对；没有建自建工作目录；2 次 shell 审批都允许；ended/you-ended、tree-ended；Job 0 幸存；orchestrad 经 stdin EOF 停机，退出码 0；leftover 0；测试目录已删。复核的 11 条修正（Unicode 大小写折叠逃逸、项目根里 Codex 只收 readOnly 沙箱、落在项目根的 seat→Claude 会话按 tainted 处理、r4 §7.4 受保护路径算高风险卡、journal 新 kind `owned-cwd`、`stat-refused` 等）都有单元测试，见计划「项目根（--project-root）」一节的「复核后改」。
- seat 在 e850a20 上复验（实验室 seat-smoke.ts，不进仓库，模式 complete、expiry、withdraw）— 退出码 0：complete 请求 done、会话 idle 后结束；不带 `--project-root` 时卡片写「派出后仍在 Orchestra 自建的工作目录里跑」；`~/.dsh` 快照与基线 109387 行，0 差异。
- seat 去重（461ac11、73bad96）— 同一 DSH 会话、同一 cwd、同一任务原文在上一次还没结果时被拒，诊断 `[duplicate]` / `[duplicate-submitting]`；请求方 sessionId 为空时不去重。起因：headless DSH 模型在 list_agents 里看不到外部子级，会重复调用。seat 单元测试全过。
- 2026-11-03 测试 profile 联调（之前的会话在 4d7387e–73bad96 之间跑的，细节在计划「2026-11-03 已验证」一条）：
  - seat Claude 后端（`subagent_claude_governed`）派出到 done；
  - orchestrad 自己的 10 分钟到期（expired）实跑；
  - 标签页标题「(1) Orchestra · 塔」在 DSH 请求等人时出现；
  - opencode-go 模型：Codex、Claude 两家 live-smoke 用 glm-5.3 各过一次；页面上用 kimi-k3 开过 Claude 会话；
  - `scripts/live-route.ts --dispatch` 过（RouteDecision 记录、塔表顶上「你」那一行）；
  - 内置浏览器走查：派活台建议、审批拒绝和允许、中断、刹车、结束、亮暗主题、375px 窄屏。发现并修了两处：宽屏「等你」栏为空时底栏被挤成 0 px（8bc1bd9）；窄屏把详情里的自有会话框也藏了（e483824）。两条新断言不带修复时失败。
  - 后台标签页的标题刷新（73bad96）：在页面里模拟 `document.hidden` 为真，审批出现约 12 秒后标题变成「(1) …」。
  - 观察到：中断（interrupt）不会杀掉 Codex 已经起的命令，刹车会；页面对这条命令显示「在跑」，和实际一致。
- 日常使用文档（7f71981、a3cf458）— `docs/quickstart.md` 写了 `--agent-port`、DSH 请求卡、`--project-root`（1.3 节）；`start-orchestra.cmd` 只用 `/dry-run` 跑过（找到主检出目录的 node.exe，退出码 0）；`integrations/dsh-seat/README.md` 新增「装进你日常用的 DSH profile」一节；`package.json` 删掉了指向不存在文件的 `build:procguard`。

更早的验证（自有会话端到端、procguard Job 和刹车、stdin EOF 停机、第 4 阶段复核、seat 复核修正 93f282d）见 git 历史里 99deb75 版本的本文件，这次没有重跑的项不再列。

## Unverified（做了但没验证，或验证没过）
- **真实 profile 一次都没跑过**（代-2：只能由用户在可见控制台里启动）。塔表在真实数据上有多少项目和节点、真实 profile 下自有会话能不能起停、`start-orchestra.cmd` 实际启动（等 5 秒开浏览器、Ctrl+C 只停 orchestrad、退出后停在「按任意键」）、带 `--project-root` 的真实启动，全部未知。
- 项目根：Claude 会话在项目根里没有实测（只跑了 Codex）；r4 §8.5 要求 seat 派给 Codex 时用 untrusted 审批策略，没做（app-server 对这个参数的回复没实测），Codex 读项目文件会不会先问人，未知；受保护路径的卡是「按住或键入」确认，不是 §7.4 说的「必须键入」；`package.json` 整个文件算受保护；`.git/config` 不在清单里；r4 §10.8 双写者告警没做；根只能用启动参数给，改根要重启（原计划写「在设置里登记」，已记分歧）。
- seat 装进日常 DSH profile 的步骤（README 新一节）没在真 DSH 上走过；卸载命令写的是「未知」。
- seat：抢管道的冒名实例只有单元测试，没有用真的第二个管道实例复现；读到令牌文件又抢到管道的进程仍能冒充 orchestrad（已记残余）。Codex 沙箱里的进程能不能连上请求口管道，没验证。
- 真正的系统级「标签页隐藏」在内置浏览器里模拟不出来（后台标签页 `document.hidden` 仍为 false，只是 requestAnimationFrame 停了），后台标题只在模拟 hidden 时看过。
- 会话还在跑时强杀 orchestrad：没有实测。被 Node 启动器直接启动、父进程被杀时 orchestrad 的停止顺序不跑（实测一次），这时自有会话的 Job 跟着关没有在会话跑着时实测。
- 花费：走 magpie 的模型不在 Claude CLI 的价目表里，真实花费未知。
- 自有会话跨重启：重启后没结束的会话显示状态未知、对话内容看不到，还在等的 seat 请求丢失。设计如此，没在真实重启下跑过。
- Job 挡不住同一用户的进程；node.exe 只查存在和不是链接，没有哈希。
- 没做的：计划阶段 7（DSH 只读插件）；0.2 设计的导入（`ImportStager` 没有调用方）；r4 §9.2 的 router-core；M0 的全局刹车 `/api/brake/plan`、`/api/brake/execute` 仍没有处理函数；没有设置页（Q5a 要求的 Tuning 页也没有）。

## Next（按优先级，每条可独立执行）
1. 真实 profile 启动检查（只能由用户本人做）— 在普通（非管理员）cmd 里双击或运行仓库根的 `start-orchestra.cmd`（worktree 里先设 `ORCHESTRA_NODE` 指向主检出目录的 `.tools\node24\node.exe`）。验收：控制台打印配对码、`procguard on`、两家 `owned … sessions on`、`working (real profile …)`；浏览器自动打开 `http://orchestra.localhost:7470/`；配对后塔表有数据、顶栏数字等于点开后的行数；派一个 Codex 会话「只回复 ok，不用工具」到空闲后结束；Ctrl+C 后任务管理器里没有 codex.exe、procguard.exe。结果记进本文件。
2. 决定 push / 合并（只能由用户本人做）— 本分支只在这台机器上；`hosts/claude/node_modules` 也只在这个 worktree。要推远端或合进主线，由用户定目标分支。
3. 项目根里跑 Claude — `node scripts/live-smoke.ts --harness claude --project-root`。验收：退出码 0、`listedCwd.kind` 为 project-root、文件在根里、leftover 0。结果写进计划「项目根」一节。
4. seat→Codex 的 untrusted 审批策略（r4 §8.5）— 在 `src/owned/codex-session.ts` 里，seat 请求派出的会话 `thread/start` 改用 untrusted 审批策略；先用一个测试 profile 会话实测 app-server 的回复。验收：live-smoke 过、读项目文件时出审批卡。
5. 会话在跑时强杀 orchestrad — 给 `scripts/live-smoke.ts` 加一个模式：会话空闲时 `child.kill()`（不先关 stdin），再用脚本自己的 procguard 探针按 pid + 创建时间查 Job。验收：0 个幸存；写进计划「进程树的 Job 回收」的残余 ②。
6. `scripts/live-smoke.ts --harness codex --outside` 和 `--harness claude --outside` 各重跑一次。验收：`approvalsAllowed` 里有命令卡，`ranUnasked` 为 0。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的第七批改动。本分支只读引用它，不改、不提交、不覆盖。
- `.claude/launch.json`（未跟踪）：本机某次会话的预览配置，不提交。
- 真实 `~/.dsh`、`%APPDATA%\npm`、真实 `~/.orchestra`：agent 不动。

## Open questions
- 哪个 DSH profile 是日常用的、要不要把 seat 装进去：由用户定（D11 / Q5a：先在隔离 DSH_HOME 验过同一版本，再由主人自己装）。Q5a 和 seat 对不上的三处（没有 Tuning 页；seat 加的是能提请求的工具，不是只读；DS-Bot 已换桌面版要重核）记在计划分歧一节。
- 真实 profile 下开不开自有会话：0.2 设计第 528 行原本要求 owned-disabled，被本计划 §2 取代成两种 profile 都开。要恢复限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')。
- 实现会话能不能在真实 profile 下联调：现行约定（代-2）是不能。
- 本机 `%TEMP%` 下有 40 多个不是本会话留的 `orchestra-test-*` 目录（最早的 2026-11-02），要不要清由用户决定。本会话的测试目录都已删。
- 0.2 交接文件（`docs/handoff/claude--alpha-0.2-interactive.md`）里列的设计 §8 待定项仍没有逐条问过用户。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-03 AdamPlatin123（项目根之后）：上一份交接写在 99deb75（Commit 4d7387e），之后 461ac11、8bc1bd9、e483824、73bad96、7f71981、75e2942、e850a20、a3cf458 没有更新交接；本次一并补上，旧的 Unverified（Claude 后端、10 分钟到期、标题计数、浏览器走查、`--dispatch`、`build:procguard`）移进 Done 或删除，Next 重排。项目根是启动参数而不是原计划的「在设置里登记」，记在计划里。
- 2026-11-03 AdamPlatin123（seat 复核修正）：复核 28 条里没照做的三条和理由记在计划「seat 复核修正」一条。
- 2026-11-03 AdamPlatin123（第 4 阶段复核）：procguard 没开时自有会话整个关闭（以前不经 Job 照开，和 r4 D4 冲突）。细节见计划「进程树的 Job 回收」。
- 2026-11-02 AdamPlatin123：本分支第一次写交接。和 r4、0.2 设计的出入都记在计划的「分歧和残余风险」一节。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D4 | 每个自有子进程各在一个随关闭即杀的 Job 里，由 procguard 拉起 | r4 §4 |
| D8 | 只有一个审批队列，超时即拒；派出、批准、刹车只由人在配对页上做 | r4 §4 |
| D11 | 只对接不魔改上游；日常 DSH profile 默认不放 Orchestra 代码，主人可自己选择装 | r4 §4 |
| Q5a | 以后可以 opt-in，但同一版本要先在隔离 DSH_HOME 里验过 | r4 |
| 代-2 | 真实 profile 只由用户在可见控制台里启动和配对；agent 只许起测试 profile | `docs/plans/2026-10-31-m0-implementation-plan.md` |
| r4 §7.4 | 自有会话工作目录里的受保护路径（`.claude/**`、`.git/hooks/**`、`package.json` 等），写入要键入确认 | r4 §7.4 |
| r4 §8.5 | 来源链里有不可信发送者时按 tainted 处理：Claude 一律询问，Codex 用 untrusted 审批策略 | r4 §8.5 |
| r4 §10.8 | 同一根目录两个会话改同一路径时告警 | r4 §10.8 |
| r4 §9.2 | 路由十步流水线（router-core） | r4 §9.2 |
| RouteDecision | 每次派活写进 journal 的 `route` 记录 | 计划 §3、`src/route/` |
| T1 / T2 / T3 | 不知道写「未知」/ 不写「完成」/ 计数等于它链接的列表长度 | `shared/tower-contract.js` 注释 |
| seat | 把 Orchestra 注册成 DSH 受治理子代理后端：DSH 只能经请求口提请求，人在配对页派出 | `integrations/dsh-seat/README.md` |
| `--project-root` | 启动时放行的项目目录；自有会话和落在根里的 seat 请求可以在里面干活 | `src/os/project-roots.ts`、quickstart 1.3 |
| tainted | 会话来源不可信，每次调用工具都问人 | r4 §8.5、`src/owned/claude-session.ts` |
| 测试 profile | `--test-profile --test-dir <dir>`：数据全在那个测试目录里 | `src/boot.ts` |
| magpie | 本机模型网关 `http://127.0.0.1:3425` | 计划「已实测」 |
| procguard / Job | 本仓库的 C# 进程看守程序；Job 是 Windows 进程组，可整组结束 | `native/procguard/ProcGuard.cs` |
