# Handoff: claude/orchestra-app

## Facts
- Owner: AdamPlatin123
- When: 2026-11-05（总台复核修复合入之后）
- Machine: 550W备份1号机
- Branch: claude/orchestra-app（从 `claude/alpha-0.2-interactive` 的 76807ec 切出）
- Commit: 随本文件一起提交，上一提交 c2b2a23（running 界面，从 `claude/running-panel` 快进合入），再往前 8eb2215 交接、6ef515a（总台复核修复）。再往前 73237b5 总台、bcb7bd3 Claude 子代理和派活权限、 05ad22c 派发行和拉线、 8b2e8fb 新首页和停止、 580143a Codex 子代理、 2a67fbf 第三轮方案、 88194f3 第二轮方案、 ad4c923 页面评审修正、eb8d621 来源链复核修正，之前依次是 d5b40e1 审批卡来源链、02c5492 交接、a21aebd 等你栏来源不可信卡、ad961bd seat 项目根卡片文案、371509b seat 项目根实跑记录、e9dac45 交接、0e32a82 复核修正、d212b86 seat 会话按来源不可信启动、18d5a03 live-smoke `--daemon-kill`、0d8b701 交接。更早一份交接写在 99deb75（Commit 记为 4d7387e），之后依次是：461ac11 seat 去重、8bc1bd9 宽屏底栏、e483824 窄屏自有框、73bad96 后台标题和 seat 去重复核、7f71981 日常使用文档和启动脚本、75e2942 项目根、e850a20 项目根复核修正、a3cf458 quickstart 补项目根
- Pushed: 到 8eb2215 为止在 origin（2026-11-05 推的）；c2b2a23 和本交接提交还没推
- Uncommitted on that machine: `.claude/launch.json`（未跟踪，本机某次会话的预览配置，不要提交）。主检出目录里 r4 规格有用户本人的未提交改动，见 Do not touch。

## Goal
用户 2026-11-02 的目标：把 Orchestra 做到「应用整体可用」。一个守护进程 orchestrad，首页是塔表（你 → agent → subagent 的跨项目树），能只读观察 Claude、DSH、Codex 三家的会话；能经本机模型网关 magpie（`http://127.0.0.1:3425`，不要密钥）开 Orchestra 自己拥有的 Codex 和 Claude 会话（下称「自有会话」），在页面上对话、审批、停下；有一个派活台，先跑规则、再问路由模型，给出「派给谁」的建议卡片，由人点「派出」；DSH 会话可以经 seat 请求派自有会话，由人在配对页派出或拒绝。总计划见 `docs/plans/2026-11-02-orchestra-app-plan.md`，给主人看的上手指南见 `docs/quickstart.md`，启动脚本 `start-orchestra.cmd`。

## Done（已完成且已验证）
- running 界面（2026-11-06，c2b2a23，从 `claude/running-panel` 快进合入；那条分支的交接移到了 `docs/handoff/archive/claude--running-panel.md`，细节和未验证项都在那里）：首页底部「正在做」胶囊，点开右栏（宽屏默认收起，窄屏是抽屉），一个正在做的 worker 一张卡，再点进细节页（只看不动）。全量 1799 条，1796 过，0 失败；测试 profile 实走过一次。改派分支 `claude/serene-merkle-3ac513` 还没合，它和这次都改了 `ui/home.html`、`shared/strings.js`，合时要解冲突并重跑 `scripts/embed-ui.ts`。
- 真实 profile 第一次由用户启动（2026-11-03 07:41 UTC，start-orchestra.cmd，用户本人在可见控制台）。只读查了真实数据目录的 run/orchestrad.log（码已遮）：procguard on、owned-claude on、owned-codex on、页面 7470、agent-port（orchestra-agent-real）、working profile real；peek-pair ok；owned-unlock 先 wrong 后 ok。派会话、塔表内容、Ctrl+C 停机还没有用户的结果。
- 真实 profile 上发现的解锁码问题（本次修正）：日志里一次解锁在 60 ms 内发了 7 个解锁码（每个都替换上一个），用户填了不是最后一个的码，第一次判 wrong。页面改为：解锁对话框开着或请求还在路上时，不再要新码。新断言不带修复时失败；测试 profile 页面上连点 7 次只发 1 个码。全量 1542 条，1539 过，0 失败。用户正在跑的实例是修正前启动的，重启后才生效。
- 审批卡来源链（d5b40e1、eb8d621，r4 §8.5）— seat 派出的会话，审批卡和等你栏都写「来源不可信：DSH 会话 <id>（自称，未核实）→ 请求「<标签>」（标签是对方写的，未核实）→ 这个会话」；没报 id 写「未知」；等你栏里截断并标明；r4 原文的第三段（发送者自己的污染源）Orchestra 拿不到，卡上照实写。只加显示，审批行为不变，不进 journal。复核 5 条都修了（标签能伪造链结构、LRM/RLM/ALM 和行分隔符漏网、截断拆字形、备注文案、origin 不带 tainted 时整张列表 500）。全量 1542 条，1539 过，0 失败。
- 来源链和键入放行的页面实测（2026-11-03，测试 profile，内置浏览器）：用实验室 ask-once.ts 提一个 seat 请求，配对、解锁、派出；等你栏这张卡是红条，提示位是上面那行来源链，按钮只有「拒绝」「输入确认词允许」。点「输入确认词允许」后页面弹出的确认框写「来源不可信（DSH 会话的请求）的高风险请求：…」；因为内置浏览器的原生确认框点不进去，由测试代人把确认词「放行」交给页面（覆盖 window.prompt），之后卡片消失、命令跑了、hello.txt 内容 hi。测试实例停掉后没有残留进程，测试目录已删。
全部在本 worktree 根目录跑，node 用主检出目录的 `.tools/node24/node.exe`，只用测试 profile（代-2）。

- seat 落在项目根里 live 跑（371509b 记录，实验室 seat-smoke.ts 新模式 root-codex、root-claude、work-claude，各跑两次：实现者一次、独立复核者一次）：派出 200，请求 done，会话 cwd.kind 为 project-root（root-*），hello.txt 在项目根里、内容对；日志 owned-started tainted true；审批卡全部 tainted；读 notes.txt 也出了审批卡（Codex 是命令卡，Claude 是工具卡）；Codex ran-unasked 0、没有 policy-mismatch；Claude 问过的次数等于跑过的次数（ran-unasked 标记只有 Codex 会发）；DSH 退出码 0；残余 0；`~/.dsh` 0 差异。
- 等你栏的来源不可信卡（本次修正，2026-11-03 内置浏览器实看）：原来会话详情里的审批卡有红条和来源一行，但「等你」栏里的同一张卡是黄条、没有来源一行（只有按钮是「输入确认词允许」）。修正后测试 profile 页面上：等你栏这张卡左边是 `--taint` 色条，提示位写「来源不可信：DSH 会话发来的请求」，按钮只有「拒绝」「输入确认词允许」；点拒绝后卡消失、标题计数归零。两条新测试不带修复时失败。全量 1528 条，1525 过，0 失败。
- 最终核查（0e32a82，主会话自己跑，依次一次）：
  - 全量 `node --test "test/**/*.test.ts"`：1527 条，1524 过，0 失败，1 跳过（目录链接 EPERM），2 todo。
  - 实验室 seat 冒烟 `seat-smoke.ts complete expiry withdraw`：complete 派出 200、请求 dispatched → running → done、1 张命令审批、hello.txt 内容 hi、DSH 退出码 0；expiry：60 秒没人派出，seat 撤回（withdrawn / requester-withdrew）；withdraw：会话 ended / requester-withdrew，Job 已关；leftover 0。之后 `~/.dsh` 重拍快照与基线 109386 行，0 差异（注意：PowerShell 5.1 的 Export-Csv 要加 `-Encoding UTF8`，否则中文文件名变成「??」，会报出假的差异）。
  - `live-smoke.ts --harness claude --daemon-kill`（复核修正后的判据）：退出码 0，survivors 0，jobAfterKill.found false，重启后 unknown / daemon-restart，leftover 0。
  - `--harness codex --outside`、`--harness claude --outside`：退出码都是 0，各 1 张命令审批，ranUnasked 0，leftover 0。
- 项目根里跑 Claude（0d8b701 上）— `live-smoke.ts --harness claude --project-root` 退出码 0：listedCwd.kind 为 project-root，文件在根里、内容对，workDirMade false，1 次写文件审批（cwd 内读不问人，和计划一致），survivors 0，leftover 0。同时 codex 同一模式复跑也过。
- seat 会话按来源不可信启动（d212b86、0e32a82）— 单元测试覆盖策略回显校验；seat 冒烟（自建目录、Codex）日志 owned-started 里 tainted 为 true，没有 policy-mismatch。审批卡的红条、来源一行、高风险只认键入只有单元测试。
- 会话在跑时强杀 orchestrad（18d5a03）— Codex 两次、Claude 两次（其中各一次在复核修正后的判据上），都 0 幸存；重启后不会显示假的「运行中」。

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

- 真实 profile 页面评审修正（d185e79、c0fc760、0a9cc8a、ad4c923）：派活入口改名、「你」行写法、路径名不再被熵规则遮掉（只限 `name: true` 的调用）、会话事件只遮显示的 200 条。用户正在跑的真实实例是这些提交之前的代码，要用户重启才生效。
- 前端方向探索（bc50ea6 和本次提交）：`docs/design/mocks/2026-11-03-ensemble/` 第一轮 14 个隐喻方案，`round2/` 第二轮 6 个方案。第二轮按用户判断定了三条：总台（superrouter）只问答、派发一眼看清、subagent 默认折叠，折叠卡照用户截图做成共用的 `foldcard.js`。6 个方案各由一位没参与设计的检查员走完 10 个必看画面；1024 宽无横向滚动、两种数据都能切换，已在内置浏览器复核。这些都是假交互，没有接真实数据。
- 规划交给 worker（2026-11-03 用户拍板）：总台不写验收、不拆 Task，只提议「派给谁」。`round2/scenario2.js` 加了规划 worker Sora 和派单 d0，Task 5 的拆分提议改由 Sora 发出，`round2/BRIEF.md` 第 1.2 节写了边界。6 个方案在 1024 宽下都能拍板这条提议，等你计数 4 减到 3，控制台无报错。

更早的验证（自有会话端到端、procguard Job 和刹车、stdin EOF 停机、第 4 阶段复核、seat 复核修正 93f282d）见 git 历史里 99deb75 版本的本文件，这次没有重跑的项不再列。

- 第三轮方案（`docs/design/mocks/2026-11-03-ensemble/round3/`）：用户要 bot 式界面（左 worker、右 team，派发时延伸）和派活权限（可以开权限让 bot 直接派出）。21 通讯录加右栏、22 左 worker 右 team、23 延伸行，共用 `round3/scenario3.js`。每个方案由独立检查员走完第二轮 10 个画面和第三轮 4 个画面（含回放里 subagent 等你、出错冒到顶层），1024、1280 无横向滚动。都是假交互，权限只在 mock 里，代码没动。

- Codex 子代理接进自有会话和塔表（细节见计划「子代理（Codex，2026-11-04 接上）」）：成员表、塔表子节点、耗时、型号、审批卡写明是哪个子代理、没来问就跑的步数。验证：全量 1577 项，通过 1574，失败 0，跳过 1，待办 2；`scripts/live-smoke.ts --harness codex --subagent` 在测试 profile 上默认模型和 `zcode/GLM-5.3` 各跑一次，退出码 0，Job 没有残留。

- 新首页（用户 2026-11-05 选定第三轮方案 22）：`/` 现在是左 worker、右 subagent 折叠卡的页面（`ui/home.*`、`ui/wings.js`、`ui/fold.js`），旧页面在 `/tower`，动作收进两页共用的 `ui/drive.js`。三路复核 19 条都已修，其中高风险的是双击等你胶囊会落到批准按钮上。测试 profile 里配对、解锁、派 Codex、subagent、批准、发消息、结束都用内置浏览器走过，1024 和 1280，深浅色。
- 停止管到 Codex subagent：点停止时对子线程发打断，再清后台命令（只打断不结束命令），结果按回来的事件写。`live-smoke --subagent-stop` 两个模型各一次，退出码 0。全量 1609 项，通过 1606，失败 0，跳过 1，待办 2。

- 派发行和拉线：Codex 派发写进对话流，同一回合连续派出的算一批，一批一张折叠卡，从派发行拉线到卡。停止也管根线程自己的长命令。同一会话排队的审批现在都进等你（以前一个会话只算一条）。验证：全量 1628 项，通过 1625，失败 0，跳过 1，待办 2；`live-smoke` 的 `--subagent --pair`、`--root-stop`、`--subagent-stop` 在最终代码上都退出码 0；测试 profile 里用内置浏览器走过两批派发、线、批准、停止。

- Claude 自有会话的 subagent：只给有 Job 的会话放开 Task、Agent，实测全部走审批闸、没有逃出 Job；成员表抽成 `src/owned/members.ts`，Codex 和 Claude 共用；派一个 subagent 要批。seat 请求等 subagent 说完才算 done。
- 派活权限：自有 worker 有 `orchestra_dispatch` 工具（`src/route/dispatch.ts`），每个会话一档，默认派前问你，只有人能在配对且解锁的页面上改（`POST /api/owned/:id/dispatch-grant`）。直接派出走全部其余检查，记录写 `auto`。受污染、你不在、被派出的会话都退回派前问你，派出深度上限 2，seat 不走权限。在场判定新做在 `src/route/presence.ts`。验证：全量 1733 项，通过 1730，失败 0，跳过 1，待办 2；`live-smoke --dispatch-tool` 和 `--subagent` 两家各一次，退出码 0。

- 总台（`src/route/front-desk.ts`、`ui/front.js`）：全局最多一个的特殊 Claude 会话，人点开启，工具只有 `mcp__orchestra__status` 和 `mcp__orchestra__dispatch`，多一个就 safety-stop。全量 1767 项，通过 1764，失败 0，跳过 1，待办 2；`live-smoke --router` 跑了 2 次，退出码 0。

## Unverified（做了但没验证，或验证没过）
- 总台：复核 9 条真问题和走查 7 处都修了（9fa20c7..6ef515a），测试 profile 上真模型走过开启、问进展、派单、拒绝、结束。总台派出的 worker 一律按受污染跑；只读观察的会话不发标题；自有会话的标题和等你摘要会经 magpie 发给模型提供方，页面写明。残余：派出后 DSH 请求的第一句仍以标题回到总台；Codex worker 批准之后的路径没走；回报不主动来，只取第一个非空行；派单只在内存里；规划 worker 这个角色还没做。
- `live-smoke --dispatch-tool` 在最终代码上 Codex 默认模型第一次报 no reply within 120 s，重跑通过，另外两种跑法也通过，原因没查实。
- 派活权限：污染只认 seat 来源，抓过网页、读过项目根外文件的 worker 派出的会话算干净（r4 §8.5 这部分没跟踪），这是这次放宽的缺口；权限和派出关系只在内存，重启后要看 journal；派出结果不回给 worker；空闲会话也占 3 个名额；你不在时退回、来源不可信的页面路径没在浏览器走过；Claude 的派活工具没在页面上走过。
- 走查里第一轮第一次点「刹车」落到了「中断这一回合」，原因没查实，之后修了版面跳动，复走没再出现。
- 派发批次是推断：模型逐步派、中间没有别的 item 时分不开。派发行超出对话流上限或重启后会丢，这时没有线。刹车、拒绝、亮色主题、手机宽度这次没走。
- 新首页：真实 profile 没看过（要用户重启才生效）；只读会话那组和红色出错胶囊只有单元测试；批准的按住手势是脚本发的；手机宽度只看过合成数据。
- 停止：`Start-Process` 放出去的进程没测过，那种要刹车；「停下了」靠 Codex 的终端列表，产品里没有用 Job 核对；`backgroundTerminals` 是实验接口，只在 0.165.0 测过。
- Codex 子代理：关不掉（默认模型上找不到开关，只靠 Codex 系统指令约束）；不算进 3 个并发上限，数量上限未知；`spawn_agent` 的 `model` 参数不经过 `isOwnedModel`，名单外型号只显示不拦截；根 turn 被打断时子代理怎样、受污染会话（untrusted）的子代理跟哪个策略、嵌套子代理、`errored` 等状态都没实测，后几种只从类型映射；页面上的「耗时」「型号」行只在假 DOM 里验证过；tsc 不可用，类型没检查。
- **真实 profile 只由用户启动过一次**（代-2：只能由用户在可见控制台里启动；配对和解锁走通，见 Done），还没派过会话。真实 profile 下自有会话能不能起停、`start-orchestra.cmd` 实际启动（等 5 秒开浏览器、Ctrl+C 只停 orchestrad、退出后停在「按任意键」）、带 `--project-root` 的真实启动，全部未知。
- 项目根：seat 派出的会话按 r4 §8.5 记为 tainted（d212b86：Codex 用 untrusted 审批策略启动并校验回显，Claude 每次工具调用都问），这些都已 live 跑过（见 Done）；untrusted 下读文件先问人只在 Orchestra 外的探针里测过一次（Get-Content、列目录、写，3/3 先问），别的读法未测；tainted 会话的审批卡、来源链和键入放行都在页面上实测过（见 Done），但人在真实浏览器的原生确认框里亲手键入没有测（测试是覆盖 window.prompt 交的确认词）；服务器不区分按住和键入，「必须键入」只在页面这一侧生效；来源链挂在会话上，不是逐回合；受保护路径的卡是「按住或键入」确认，不是 §7.4 说的「必须键入」；`package.json` 整个文件算受保护；`.git/config` 不在清单里；r4 §10.8 双写者告警没做；根只能用启动参数给，改根要重启（原计划写「在设置里登记」，已记分歧）。
- seat 装进日常 DSH profile 的步骤（README 新一节）没在真 DSH 上走过；卸载命令写的是「未知」。
- seat：抢管道的冒名实例只有单元测试，没有用真的第二个管道实例复现；读到令牌文件又抢到管道的进程仍能冒充 orchestrad（已记残余）。Codex 沙箱里的进程能不能连上请求口管道，没验证。
- 真正的系统级「标签页隐藏」在内置浏览器里模拟不出来（后台标签页 `document.hidden` 仍为 false，只是 requestAnimationFrame 停了），后台标题只在模拟 hidden 时看过。
- 会话还在跑时强杀 orchestrad：18d5a03 加了 `scripts/live-smoke.ts --daemon-kill`，codex 跑两次、claude 跑一次，退出码都是 0（杀后 Job 0 幸存、Job 打不开、重启后 unknown / daemon-restart）；复核后修了判据（幸存数改用杀后 20 s 内的时间线，探针出错不再算「Job 已关」），改后 codex、claude 各重跑一次（退出码 0）。仍未知：只测了被 Node 脚本用管道启动的 orchestrad，别的启动方式没测；Node 升级后要复跑。
- 花费：走 magpie 的模型不在 Claude CLI 的价目表里，真实花费未知。
- 自有会话跨重启：重启后没结束的会话显示状态未知、对话内容看不到，还在等的 seat 请求丢失。设计如此，没在真实重启下跑过。
- Job 挡不住同一用户的进程；node.exe 只查存在和不是链接，没有哈希。
- 没做的：计划阶段 7（DSH 只读插件）；0.2 设计的导入（`ImportStager` 没有调用方）；r4 §9.2 的 router-core；M0 的全局刹车 `/api/brake/plan`、`/api/brake/execute` 仍没有处理函数；没有设置页（Q5a 要求的 Tuning 页也没有）。

## Next（按优先级，每条可独立执行）
1. 真实 profile 启动检查（只能由用户本人做）— 先关掉 2026-11-01 从 `.claude\worktrees\m0-thin-slice-e9066d\orchestra.cmd --peek-port 7470` 起的旧 orchestrad（M0 旧代码，真实 profile，2026-11-03 还在跑并占着 7470 端口；不关的话新实例起不来，浏览器打开的也是旧页面）。然后在普通（非管理员）cmd 里双击或运行仓库根的 `start-orchestra.cmd`（worktree 里先设 `ORCHESTRA_NODE` 指向主检出目录的 `.tools\node24\node.exe`）。验收：控制台打印配对码、`procguard on`、两家 `owned … sessions on`、`working (real profile …)`；浏览器自动打开 `http://orchestra.localhost:7470/`；配对后塔表有数据、顶栏数字等于点开后的行数；派一个 Codex 会话「只回复 ok，不用工具」到空闲后结束；Ctrl+C 后任务管理器里没有 codex.exe、procguard.exe。结果记进本文件。
2. 用户决定 r4 要不要跟着改：A17（agent 只能请求新建，由你批准）、§9.5 和 Q11（自动派活要过门槛）已被用户的话取代，见计划「派活权限」一节。总台还没做，今天没有总台；规划归 worker 已定，见 `round2/BRIEF.md` 第 1.2 节。
3. 决定 push / 合并（只能由用户本人做）— 本分支只在这台机器上；`hosts/claude/node_modules` 也只在这个 worktree。要推远端或合进主线，由用户定目标分支。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的第七批改动。本分支只读引用它，不改、不提交、不覆盖。
- `.claude/launch.json`（未跟踪）：本机某次会话的预览配置，不提交。2026-11-05 被一个修复代理误删，已按它指向的脚本重建，配置名是重取的。
- 真实 `~/.dsh`、`%APPDATA%\npm`、真实 `~/.orchestra`：agent 不动。

## Open questions
- 派活权限落到代码要先定两件事：一是改 r4（A17 agent 只能请求新建、由你批准，§9.5 / Q11 自动派活要过门槛，D20 你不在时不派新的执行 Task，计划第 169 行派出只有人点）；二是 seat 请求口不走权限。请求口的请求方是自报的，没有校验管道对端进程，之所以接受就是因为每条都要人点（计划第 135 行）。今天自有 worker 没有派活工具，所以要先给自有 worker 加派活工具，权限才有东西可管。
- 折叠卡接真实数据：只读会话约五成（没有耗时、没有红点，名字退回类型）；Codex 自有 worker 已接上（2026-11-04）；Claude 自有 worker 2026-11-05 也接上了。
- `docs/research/ds-bot.md` 第 87 行「没有任务对象」和 `2026-10-30-ds-bot-noticed.md` 第 88、119 行（转发上限、Continue 按钮）对 0.2.7 已过时，这次只读代码发现，没改文档。
- r4 要不要跟着改：用户定了总台不规划，但 r4 §8.9 (c) 写规划者是主代理（M1–M3）、M4 起可为 Maestro，§9.1 同样写 Maestro 可当规划者。r4 由用户本人改，本分支没动。
- 哪个 DSH profile 是日常用的、要不要把 seat 装进去：由用户定（D11 / Q5a：先在隔离 DSH_HOME 验过同一版本，再由主人自己装）。Q5a 和 seat 对不上的三处（没有 Tuning 页；seat 加的是能提请求的工具，不是只读；DS-Bot 已换桌面版要重核）记在计划分歧一节。
- 真实 profile 下开不开自有会话：0.2 设计第 528 行原本要求 owned-disabled，被本计划 §2 取代成两种 profile 都开。要恢复限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')。
- 实现会话能不能在真实 profile 下联调：现行约定（代-2）是不能。
- 本机 `%TEMP%` 下有 40 多个不是本会话留的 `orchestra-test-*` 目录（最早的 2026-11-02），要不要清由用户决定。本会话的测试目录都已删。
- 0.2 交接文件（`docs/handoff/claude--alpha-0.2-interactive.md`）里列的设计 §8 待定项仍没有逐条问过用户。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-04 AdamPlatin123：用户的真实 orchestrad（2026-11-03 记的 pid 57456、7470 端口）这时已不在运行，agent 没有动过它，什么时候停的不知道。Next 1 里「先关旧 orchestrad」可能已不需要，先查 7470 端口。
- 2026-11-03 AdamPlatin123（规划交给 worker）：第二轮 88194f3 的数据里，总台其实还在写验收 7 条、提议拆 Task 5，和当时对用户说的「mock 里总台只转述计划」不符。发现后已改数据。
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
