# Orchestra 应用：从 alpha 到整体可用（2026-11-02）

用户目标（原话）：「不受限制，不要问，参考架构，自由创作到应用整体可用阶段，API允许自由使用magpie的Zcode和OpenCodego，codex也一等公民，使用codex API」。

分支 `claude/orchestra-app`，从 `claude/alpha-0.2-interactive` 的 76807ec 切出。alpha-0.2 会话的未提交工作（Claude host、POST 底座）交回后合并进来。

## 依据

- 现行规格 r4：`docs/specs/2026-10-27-dsh-orchestra-design-r4.md`（主检出目录版本，含用户未提交的第七批，只读）。
- 面板调研和决定：塔表方案。报告在`docs/research/2026-11-02-tower-panel.md`，要点抄在下面「界面」一节。
- 0.2 设计稿：`docs/plans/2026-11-02-alpha-0.2-slice-design.md`。

## 已实测（2026-11-02，本机）

| 通路 | 结果 |
|---|---|
| magpie `http://127.0.0.1:3425` | 不要密钥。`/v1/models` 列出 `zcode/*`、`opencode-go/*`、`codex/*` 等 44 个模型；`/v1/responses`、`/v1/messages`、`/v1/chat/completions` 都通 |
| Codex CLI 0.165.0 经 magpie | 私有 `CODEX_HOME` 里写 `model_provider = magpie`（`base_url = http://127.0.0.1:3425/v1`，`wire_api = responses`），`codex exec` 用 `codex/gpt-6.1-sol` 跑通；会话落在 `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Codex app-server 协议 | `codex app-server generate-json-schema` 可本地生成 JSON Schema（v2），有命令审批、文件改动审批的服务端请求 |
| Codex skills 隔离（联调后） | 私有 `CODEX_HOME` 下仍列出 `~/.agents/skills`；`[skills] include_instructions = false` 后 rollout 里不再有用户目录下的 `.agents` 路径，也没有 `skills_instructions`（`codex exec` 和 app-server 两条路都测了） |
| Codex app-server 版本 | initialize 回复的 userAgent 形如 `orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)`（客户端名在前，版本在斜杠后）；`skills/list` 在私有 CODEX_HOME 下仍列出用户目录的 skills |
| Codex 在 Windows 上的沙箱 | `workspace-write` 被降为 `readOnly`；`[windows] sandbox = "unelevated"` 时命令挂住；`elevated` 需要管理员装 setup 程序。保持只读，每次写和跑都问人 |
| Claude CLI 经 magpie | 私有 `CLAUDE_CONFIG_DIR` + `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` + 占位 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL=zcode/GLM-5.3`，`claude -p` 跑通（CLI 报 unrecognized_model 警告，不影响） |
| 真实数据 | Claude 60 个会话进快照（13 个活着）；subagent 111/111 挂得到上级，109/111 状态未知，最深 1 层；DSH 磁盘上 92 个会话被 60 个名额挤掉却显示 empty（bug）；Codex 会话是 `~/.codex/sessions/**/rollout-*.jsonl.zst`（zstd，Node 24 有 `zlib.zstdDecompressSync`）和 `archived_sessions/` |

## 架构

一个守护进程 orchestrad（r4 D3：只有一个守护进程，UI 只在 `orchestra.localhost`）。零 npm 依赖照旧；前端仍是原生 ES 模块，不引入 React（报告里的 React 建议不采纳：要下载、要构建步骤，现有 DOM 补丁和 CSP 测试够用）。

### 1. 观察（只读，三家同等）
- Claude：沿用 `src/sources/peek.ts`、`stage.ts`。
- DSH：沿用；修来源计数（按截取前总数计，名额按 harness 分配）。
- **Codex（新）**：读 `CODEX_HOME`（默认 `~/.codex`）下 `sessions/**/rollout-*.jsonl[.zst]` 和 `archived_sessions/`。从 `session_meta` 取 id、cwd、时间；从事件取最近活动、在等审批、子代理（如有）。只读、有上限、经读闸。
- 输出新契约 **TowerSnapshot**（`shared/tower-contract.js`）：三层（你/路由 → agent → subagent），每个节点带 `harness`、`ownership`（owned/observed/foreign）、`state` + `basis`（registry/推测/未知）、`waiting`（来源：orchestra 队列 / 原生 / 推测）、子树计数 `{children, errors, waiting}`、聚合组（已回报 ×N、同类 ×N）、裁剪计数。校验器 + 金样本，计数等于列表长度（T3）。

### 2. 自有会话（驱动）
- **Codex（app-server）**：orchestrad 经 spawn 闸起 `codex app-server`（stdio JSON-RPC），私有 `CODEX_HOME = ORCHESTRA_HOME\codex-home`，配置写 magpie provider；`approval_policy = on-request`，`sandbox_mode = workspace-write`。命令/文件审批的服务端请求进 Orchestra 审批队列，人决定后回复；超时即拒（D8）。
- **Codex app-server 实测（2026-11-02，codex-cli 0.165.0，经 magpie）**：stdio 上一行一个 JSON-RPC 对象。
  - 顺序：`initialize {clientInfo}` → 通知 `initialized` → `thread/start {cwd, model, approvalPolicy, sandbox}`（结果里 `thread.id`）→ `turn/start {threadId, input:[{type:'text', text}]}`。
  - 服务端请求 `item/commandExecution/requestApproval`，参数有 threadId、turnId、itemId、command、cwd、commandActions、availableDecisions 等。回 `{decision:'decline'}`，这一项以 declined 结束；回 `{decision:'accept'}`，命令执行并拿到输出。
  - 只回 accept / decline，**不发** acceptForSession、acceptWithExecpolicyAmendment：不留持久规则，合 D8（审批只能由人做，超时即拒）的本意。
  - 其他服务端请求：`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`（向人提问）、`mcpServer/elicitation/request`。
  - 通知：turn/started、turn/completed、item/started、item/completed、item/agentMessage/delta、item/commandExecution/outputDelta、serverRequest/resolved、thread/tokenUsage/updated。客户端还可用 turn/steer、turn/interrupt、thread/resume、thread/fork。
  - npm 装的 `codex` 只是个壳。spawn 闸要钉真实 exe：`%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`，argv 固定为 `app-server`。
  - `CODEX_HOME` 放在 %TEMP% 下时，Codex 会警告不建辅助程序，不影响运行。
- **cwd（自有会话）**：测试 profile 用测试目录下的 `work\`。真实 profile 用 orchestrad 自己建的 `ORCHESTRA_HOME\work\<会话>`，只对这一个根放开 AppData 拒绝表。登记项目根留到路由阶段做。
- **POST 底座**：0.2 会话已经写好检查链、解锁码、操控令牌和 actionId 去重（`src/server/owned.ts`），但还没提交。第 3 阶段先把这份快照搬进本分支，日后合并 0.2 分支时以那时的版本为准。
- **Claude**：用 0.2 会话的 host 子进程（SDK，路线 B）；SDK 从 sdk-probe 已装的 node_modules 复制，不下载。环境：私有 `CLAUDE_CONFIG_DIR`，`ANTHROPIC_BASE_URL` 指 magpie，模型默认 `zcode/GLM-5.3`。0.2 的 host 交回前，先做 Codex。
- 模型白名单：只许 magpie 上的 `zcode/*`、`opencode-go/*`、`codex/*`。
- cwd：测试 profile 下只在测试目录 `work\`；真实 profile 下允许用户在设置里登记的项目根（过 cwd 拒绝表），派活时在确认框里写明。

### 3. 路由（superagent 层）
- 「派活台」：人输入一句话 → 先跑确定性规则（D9：确定性规则先、LLM 后），再请 magpie 上的路由模型（默认 `zcode/GLM-5.3`，chat completions，只要 JSON）给出建议：harness、模型、cwd、标题、理由。
- 建议只是「Route to?」卡片：人点「派出」才起会话；从不自动派（r4 Route to?：拿不准时出卡请你选，绝不默认派活）。2026-11-05 起例外：worker 有你开的「直接派出」权限时不经人点，见「派活权限」一节。每次派活写一条 RouteDecision（候选、理由、模式=manual）：带建议派出的记候选和人选了哪个；没要建议、建议过期或改过句子再派出的，也记一条（没有候选，router 记 not-asked），对应 r4 §9.5「M1 起每次派活都记一条 mode=manual 的 RouteDecision」。
- 路由模型拿不到时退回纯规则，卡片照出。

### 4. 审批（D8）
- 一个队列，超时 30 分钟即拒；批准只收配对页面的 POST（cookie + 操控令牌 + Origin）。
- 小审批栏可直接「允许」：参数完整可见才给；shell、网络、cwd 外写入要按住，或点一下后输入确认词「放行」（r4 §10.9 的「键入确认」，给读屏浏览模式和手机用）；列表变化 750 ms 内无效；绑定参数摘要；不批量。通知和 DSH 镜像不放「允许」。
- 受保护路径直接拒，不弹卡（2026-11-02 阶段 2 复核后改）：审批里出现的文件路径、写入根目录、命令 cwd，先按工作目录解析成绝对路径，再按最近的已存在上级做 realpath（会跟随目录联接），用 spawn 闸同一张 cwd 拒绝表判断（数据目录、各 harness 根、~/.claude、~/.dsh、AppData、仓库……）。命中就自动回 decline，feed 记 auto-denied / protected。只在工作目录外、没命中拒绝表的，仍是高风险卡片要按住或键入。

### 分歧和残余风险（2026-11-02 阶段 2 复核后记）
- **0.2 设计第 134 行 vs 本计划 §4（旧版）**：0.2 设计要求受保护路径直接拒；本计划旧版只写「要按住」，代码曾按较松的一边做。现已改成直接拒，以 0.2 设计为准。
- **0.2 设计第 528 行「真实 profile 下 owned-disabled」**：被本计划 §2（真实 profile 用 `ORCHESTRA_HOME\work\<会话>`）取代。现在两种 profile 下都是「带 --owned 启动并找到 codex.exe 才开」。若要恢复 0.2 的限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')，由用户定。
- **r4 Q5a vs seat 装进日常 DSH profile（2026-11-03 记）**：Q5a（r4 第 2904 行，第 167、2254 行同义）说日常 profile 默认不放 Orchestra 代码，用户可以 opt-in，「在 Tuning 开启，是人类动词、记 Decision；开启前同一版本的 bundle 必须先在隔离 `DSH_HOME` 验过」，并且 opt-in 时只加载 bundle 的只读部分。现在有三处对不上：① Orchestra 没有 Tuning 页，也不为这次开启记 Decision，开启就是用户自己跑 `dsh plugin … add` 并改 profile 的 `cordis.patch.yml`（步骤写在 `integrations/dsh-seat/README.md`「装进你日常用的 DSH profile」）；② seat 不是只读部分：它给日常 profile 的每个会话加两个能提请求的工具，虽然每条请求都要用户在配对页点「派出」、10 分钟没人点就自动拒；③ D11、Q5a 写的是 live `web` profile，r4 第 3879 行记着 DS-Bot 已换成桌面版、要重核，和 DS-Bot `approvals.js` 共存的检查没做。处理：AI 助手不替用户装，README 把三处写明，由用户决定接不接受。要真正对上 Q5a，需要以后做 Tuning 页的开关和 Decision 记录，或者用户改 Q5a。
- **进程树的 Job 回收（D4，2026-11-02 接上；原为残余风险）**：D4 要求每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起。现在的做法：
  - procguard 进了产品代码：`native/procguard/ProcGuard.cs`（从 S4 spike 精简而来，只留一次性 run-in-job 和常驻的 job-info、kill-job、alive）。源码的 sha256 钉在 `src/os/procguard-pins.ts`（`scripts/pin-procguard.ts` 生成）；对不上就不编译。编译只用系统自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，经 spawn 闸的 csc 规则和它固定的参数。产物放 `ORCHESTRA_HOME\runtime\procguard\<源码 sha256>\procguard.exe`（数据目录里，不进仓库）。旧 csc 没有 /deterministic，所以产物没法钉在仓库里。第 4 阶段复核后改：**每次带 --owned 启动都重新编译**（S4 实测 1–2 秒），上次留下的 exe 不用；产物的 sha256 只放在这次运行的内存里，不再写旁边的 `procguard.exe.sha256`（它和 exe 在同一目录，能换 exe 的人就能一起换它，等于自己给自己作证；以前的版本只能发现「只换了 exe」）。旧版留下的 `.sha256` 启动时删掉。每次经闸启动 procguard.exe 之前仍按内存里的 sha256 比对，对不上算被改过（procguard-tampered），这次启动被拒。旧 exe 换不掉（还有旧 procguard 在跑）时 procguard 算没开，写明原因。
  - 自有会话的子进程改经 procguard 启动：spawn 闸新规则 procguard-codex、procguard-claude（测试用 procguard-codex-fake），argv 固定为 `run-in-job --name <Job 名> --env-allowlist <文件> -- <内层规则的 exe 和 argv>`。内层的 exe、argv、cwd、环境都按原来的 codex-app-server、claude-host 规则判。procguard 先以挂起状态建子进程，放进 Job 后再恢复；Job 设 KILL_ON_JOB_CLOSE，不设 BREAKAWAY_OK；子进程只继承三个 std 句柄（HANDLE_LIST）；环境从零建，只按名单从 procguard 自己的环境里复制（名单 = 闸给内层规则的变量名 + libuv 自动补的 LIBUV_ADDED_ENV），所以子进程看到的环境和原来一样，文件里只有变量名、没有值。同名 Job 已存在就拒绝，不会加入别人的 Job；Job 的 DACL 只允许按名字打开来查询和结束。
  - 已覆盖：自己结束、orchestrad 停机、出错、子进程自己退出，四种结束都先走原来的停止顺序；包装进程一退出，Job 的最后一个句柄就关了，Job 里剩下的进程（codex 跑的命令、host 下的 claude.exe、Start-Process 起的进程）全部结束。子进程关闭后，常驻 procguard 再按名字查一次这个 Job，feed 记 tree-ended / tree-stopped / tree-left，查不到结果记 tree-unsure（未知）；每次查的结果也写进日志（owned-tree）。orchestrad 停机时（第 4 阶段复核后改）：先等所有经 procguard 起的子进程关闭、等它们关闭时发出的核对回来（最多 5 s，超时记 owned-trees-unsettled），再关常驻 procguard 的 stdin；常驻的读到 EOF 后先把已收到的命令答完（最多 15 s）再退出。停机时的核对结果只在日志里：feed 只在内存里，进程一退就没了。以前的版本在核对发出前就关了常驻的，核对实际做不成（记 tree-unsure，也没人看得到）。实测见本节末「第 3 阶段复核后补记」后面的「procguard 实测」。
  - 刹车：`POST /api/owned/:id/brake`（人手动作，和其他自有会话动作一样要解锁、操控令牌、actionId 去重），常驻 procguard 立即结束整个 Job，拒掉这个会话所有待审批，会话以 braked 结束。塔表那一行只写「你踩了刹车，Orchestra 结束了它 Job 里的进程（是否全停见对话记录）」，停没停由 feed 的 tree-* 记录和刹车回复说（第 4 阶段复核后改：以前塔表固定写「整棵进程树已停」，刹车回 left>0 或未知时也这么写，违反 T1）。会话已在结束中、子进程还没关时也能刹车（第 4 阶段复核后补：Claude 的停止顺序最长 5 s，以前这段时间刹车键消失）：剩下的停止步骤取消，结束原因保持原样，feed 记 braked。页面停止键第三档，和「结束会话」一样要在 3 秒内点两次。kill-job 先读一次计数就立即 TerminateJobObject，列成员放在最后、尽力而为（以前先逐个列成员再结束，Job 里超过 1024 个进程时列成员失败，结束根本没执行）。
  - procguard 编不出来、源码对不上钉子、常驻的起不来或准备失败时（第 4 阶段复核后改）：**自有会话整个关闭**，两家的 why 都记 procguard 的原因，控制台和页面写明。以前是「自有会话照旧、不经 Job、没有刹车」，和 r4 D4「每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起」冲突（D4 没有降级的口子），而且只有一行提示。现在没有显式的降级开关；若要「没有 Job 也照开」，需要用户拍板加一个开关（例如 `--owned-without-jobs`），并在 r4 里给 D4 开口子。进程内测试（不带 procguard 参数）仍是不经 Job 的旧路，只用于测试。
  - 常驻 procguard 中途退出时（第 4 阶段复核后补）：日志记 procguard-resident-gone、控制台写一行；GET /api/owned 的 brakeWhy 变成 procguard-resident-gone，页面在刹车键旁写「刹车说不出结果：…」。这时刹车仍会结束包装进程、让 Job 关闭，但回复的 killed/left 是未知。没有自动重启它。
  - 仍未覆盖（残余）：① 同一用户的进程可以从包装进程里复制出 Job 的完整句柄，改掉它的限制，Job 挡不住同用户的恶意进程，只防正常的进程树泄漏。② orchestrad 被强杀时，按 S4 用例 a 的机制，包装进程在 orchestrad 的 libuv Job 里，会跟着死，它的 Job 也跟着关；但这次没有在会话还在跑时强杀 orchestrad 来实测产品代码（live-smoke 杀 orchestrad 时会话已结束），未知。③ Job 里如果有进程是用别的用户令牌启动的（例如 DSH 沙箱），打开和核对创建时间可能失败；这次只测了 codex、Claude host、cmd、ping。④ env-allowlist 文件被改只会少给变量，不会多给（procguard 只能复制它自己有的），但改了不会被发现。⑤ node.exe 本身仍只查存在、不是链接，没有哈希。⑥（第 4 阶段复核后补）Job 只管直接派生的子孙进程：agent 的命令经任务计划（schtasks）、WMI 的 Win32_Process.Create、COM 进程外服务器，或交给已经在运行的程序（资源管理器、浏览器）去打开的东西，是 Job 外的进程起的，刹车和结束都管不到，是否还在未知；页面上凡是说「Job 里的进程都停了」的地方都带这句。⑦（第 4 阶段复核后补）spawn 闸先按路径读 procguard.exe 算哈希，再按路径启动它，中间换文件看不出来（检查和使用不在同一时刻）；联调脚本自己的 procguard 也一样（先比对 orchestrad 日志里记的 sha256 再启动）。⑧ 包装进程建子进程改用 PROC_THREAD_ATTRIBUTE_JOB_LIST，子进程一创建就在 Job 里，再用 IsProcessInJob 核对一次才恢复运行（第 4 阶段复核后改：以前先建、再放进 Job，包装进程恰好死在两步之间时，挂起的子进程会留在 Job 外）；Windows 10 以前的系统不支持这个属性，没测。
  - 残余 ② 实测（2026-11-02，本机，测试 profile）：`scripts/live-smoke.ts` 加了 `--daemon-kill` 模式（和 --brake 等互斥）：让模型跑 `ping -n 60 127.0.0.1` 并等它跑完；审批放行后、PING.EXE 已在会话的 Job 里、这一轮还在跑时，对 orchestrad 调 `child.kill()`（Windows 上是 TerminateProcess，不先关 stdin，orchestrad 自己的停止顺序不跑），再用脚本自己的 procguard 按 pid + 创建时间查 Job 里的进程，最多查 20 s（ping 自己要跑约一分钟，不会是它自然结束）。`--harness codex --daemon-kill` 跑了两次、`--harness claude --daemon-kill` 跑了一次，退出码都是 0：
    - 杀之前 Job 里：codex 是 codex.exe、codex-code-mode-host.exe、powershell.exe、PING.EXE、conhost.exe ×2，共 6 个；claude 是 node.exe（host）、claude.exe、cmd.exe、powershell.exe、PING.EXE、conhost.exe ×2，共 7 个。杀之前先用同一个核查查一遍，6 个、7 个都活着（codex 第一次跑还没有这项核查，所以第二次重跑）。会话磁盘记录是 running。
    - 杀之后：orchestrad 12–19 ms 内退出；第一次核查（杀后 12–21 ms）就是 0 个还活着；按名字已经打不开这个 Job（found false，说明包装进程也不在了，没有谁还持有它的句柄）；脚本最后的 leftovers 是 0（Job 1 个、留下 0 个、unchecked 0，常驻 procguard 等不在 Job 里的记录按 pid 查也不在）。跑完后另查本机：没有 codex.exe、procguard.exe、PING.EXE，也没有新的 claude.exe 和 orchestrad 的 node；测试目录都已删除。没有幸存，所以没改产品代码。机制和 S4 用例 a 一致：包装进程是 orchestrad 用非 detached 方式起的，在 orchestrad 的 Node（libuv）Job 里，orchestrad 一死它跟着死，会话 Job 的最后一个句柄随之关闭，KILL_ON_JOB_CLOSE 结束里面的全部进程。
    - 重启后：同一测试目录再起 orchestrad（重新配对、解锁），GET /api/owned 里那个会话是 state unknown、endReason daemon-restart、brake false（不显示刹车键），磁盘记录也改成了 unknown / daemon-restart；没有出现假的「运行中」。第二个 orchestrad 经 stdin 停机，退出码 0。被杀时磁盘记录停在 running（没机会写结束原因），由重启时改成 unknown。
    - 仍不知道的：每家只跑了 1–2 次；只测了被 Node 脚本用管道启动的 orchestrad，按上面的机制推断和 orchestrad 怎么被启动无关，但别的启动方式没实测（未知）；包装进程跟着死依赖 Node 给非 detached 子进程加 Job 的行为，Node 升级后要复跑这个模式。
    - 复核后改（2026-11-03，提交 "orchestra app: review fixes for untrusted policy, project-root Claude, daemon-kill"）：① 判据原来读的 `report.survivors` 在 daemon-kill 分支之后被重新赋值，用的是「第二个 orchestrad 重启、配对、停掉之后」新开探针重数的幸存数，不是杀后 20 s 内的时间线结果；「杀后 20 s 内 0 幸存」实际上没当判据用（同一判据里还有 `jobAfterKill.found === false`，所以前三次的结论本身不受影响）。现在 daemon-kill 的 `survivors` 只取时间线最后一个值，重启后的复查另存为 `survivorsAfterRestart`，不进判据。② 探针 `info()` 原来不看 `ok`：procguard 回错误（打开 Job 被拒、异常）时也返回 `found:false`，判据会当成「Job 已关」。现在 `scripts/live-common.ts` 里 `info()` 只认 `ok:true` 且带布尔 `found` 的回复，否则抛错；`alive()` 也一样，不再把错误回复当成「没有活着的」。daemon-kill 的 `jobAfterKill` 出错时记 `{found: null, error}`，判据不过。procguard 的 `alive` 命令里 OpenProcess 失败按已退出算（`native/procguard/ProcGuard.cs`）没改，靠杀前的 `aliveBeforeKill === held.length` 证明探针那时正常。
    - 改后重跑（2026-11-03，本机，测试 profile，各一次）：`--harness codex --daemon-kill` 退出码 0：杀前 Job 里 6 个（codex.exe、codex-code-mode-host.exe、powershell.exe、PING.EXE、conhost.exe ×2），`aliveBeforeKill` 6；orchestrad 12 ms 内退出；杀后第一次核查（12 ms）0 个活着，`survivors` 0；`jobAfterKill` found false（ok:true 的回复）；重启后 unknown / daemon-restart；`survivorsAfterRestart` 0；leftover 0；测试目录已删。探针改动也影响 `--brake`，所以 `--harness codex --brake` 也跑了一次，退出码 0：刹车回 200、killed 5、left 0，`survivors` 0，leftover 0。Claude 这次没有重跑 daemon-kill。
- **页面体积上限放宽（2026-11-02，真实 codex 联调后）**：用户先前定的上限是 `ui/` 目录 120 KiB、页面加载总量 168 KiB；联调前（f390437 的上一个提交）`ui/` 是 122859 字节，离上限 122880 字节只剩 21 字节，对话区的读屏播报和新消息自动滚动因此一直没做。放宽后已在 f390437 加上：对话区旁有一个 aria-live 播报区，只播新到的、不是你自己说的话；停在底部时才跟着新消息滚动。用户现在的目标是做到整体可用，后面还要加派活台等界面，所以放宽到 `ui/` 200 KiB、页面总量 240 KiB（`test/ui/tower-page.test.ts` 里的断言同步改了）。仍是零依赖、无构建，页面本身没有引入新库。
- **自有 Codex 会话读用户全局 skills（已修，有残余）**：私有 `CODEX_HOME` 挡不住 skills。codex-cli 0.165.0 按 USERPROFILE 找 `~/.agents/skills`，把清单和路径写进模型的指令；联调时模型请求运行 `Get-Content <用户目录>/.agents/skills/.../SKILL.md`。现在 `config.toml` 写 `[skills] include_instructions = false`（清单和根目录都不进提示词；实测在消息里点名 `$技能名` 也不注入）和 `[skills.bundled] enabled = false`（不往私有目录解包自带 skills）。实测 `[[skills.config]]` 按根目录禁用、`skip_host_skill_discovery` 特性都去不掉那个根。残余：codex 进程自己是否仍扫描该目录（读 SKILL.md 的开头元数据）**未知**，模型看不到。没有改子进程的 USERPROFILE（会影响 codex 跑的每条命令的 `~`、PowerShell 配置等，副作用面太大）。另外命令审批卡上，codex 报告的读取/列目录/搜索路径在工作目录外时，会单独列一行「outside the work dir: …」。
- **Windows 沙箱只能只读（保持现状）**：`sandbox_mode = "workspace-write"` 在 Windows 上不生效，`thread/start` 回 `readOnly`，codex 说「The filesystem sandbox is read-only」，于是每次写文件、跑命令都来申请审批。要写入型沙箱，需要 `[windows] sandbox = "elevated"`（要 `codex-windows-sandbox-setup.exe` 以管理员身份建沙箱用户）或 `"unelevated"`。npm 装的 codex 只带 `codex.exe` 和 `codex-code-mode-host.exe`，没有 setup 和 `codex-command-runner.exe`；实测 `"unelevated"` 下 codex 声称 workspace-write，但第一条命令挂住不返回（150 秒超时）。需要提权或额外安装，所以不开，每次都问人（更安全）。派活对话框写明「Codex 在 Windows 上的沙箱只能只读：它每次写文件、跑命令，都会先来问你」。
- **对话流顺序（已修）**：codex 先发 `item/started`（命令开始），再发审批请求，所以「命令 · … · 被拒绝」曾排在它的「等你审批」卡片前面。现在审批打开期间先把那条命令从 feed 里撤下，回答后（或自动拒绝、codex 自己撤回审批后）再以新的 seq 重发；页面收到同一条命令的第二次通告，就把那一行挪到后面。feed 读起来是：等你审批 → 你的回答 → 命令和结果。
- **Claude 自有会话（阶段 4，2026-11-02 接上）**：0.2 的 host 经 spawn 闸新规则 `claude-host` 起（node.exe 用仓库 `.tools\node24\node.exe`，worktree 里没有就用主检出目录的；argv 只有 host.mjs 的绝对路径）。和 0.2 设计不同或补上的几处：
  - 模型：0.2 设计（r4 §7.2 的 haiku-only）只许 `opencode-go/claude-haiku-5-5`；按用户目标放宽到 `zcode/*`、`opencode-go/*`，默认 `zcode/GLM-5.3`。`codex/*` 走 Responses API，Claude 不收。host 从 start 帧起仍是精确守卫：init、每条回复、`modelUsage` 只认这个模型和 `ANTHROPIC_SMALL_FAST_MODEL`（`zcode/GLM-5-Turbo`）。
  - 网关：不加 0.2 设计的 `--claude-gateway`；和 Codex 一样，带 `--owned` 就用 magpie（`ANTHROPIC_BASE_URL=http://127.0.0.1:3425`，闸只认回环地址；`ANTHROPIC_AUTH_TOKEN` 是固定占位串）。
  - 配置目录：host 进程自己的 `CLAUDE_CONFIG_DIR` 是 `ORCHESTRA_HOME\claude-home`（兜底）；每个会话实际用 `ORCHESTRA_HOME\claude\<ownedId>`（0.2 设计 §3.1），由 start 帧给。
  - claude.exe：用 SDK 自带的 `@anthropic-ai/claude-agent-sdk-win32-x64\claude.exe`（2.1.287，跟 SDK 版本走），不用用户自己会自动更新的 claude.exe。它约 240 MB，不算哈希：启动时查存在、没有链接，并记下大小、mtime 和文件 id；每次 spawn 前闸和三个钉子一起复查，变了就拒（host-tampered）。host 另查 init 帧的 `claude_code_version` 必须是 2.1.287（host-core.mjs 的 CLI_VERSION），不是就 safety-stop（cli-version）。host.mjs、host-core.mjs、sdk.mjs 三个文件的 sha256 钉在 `src/owned/claude-pins.ts`（`scripts/pin-claude-host.ts` 生成），启动时查一次，spawn 前闸再查一次。
  - 和 0.2 设计第 82 行的差别：设计写「claude.exe 变了就在页面告警」，这里更严，直接拒绝启动。node.exe（`.tools\node24\node.exe`）仍只查存在、没有链接，没有哈希，也没有大小和 mtime 的复查（残余风险）。
  - 花费：对话流里的「花费」是 SDK result 的 `total_cost_usd`，是 Claude CLI 按它自己的价目表用 token 数估的，不是 magpie 报的。走 magpie 的 zcode / opencode-go 模型不在它的价目表里，这个数不代表真实花费（真实花费未知），页面这样写明。0.2 设计「只显示 total_cost_usd，超 $1 提示」的前提（这个数是真钱）在这里不成立，「超 $1 提示」没做。
  - 受保护根：host 原来把 `~/.orchestra` 整个拒掉，真实 profile 下工作目录就在里面。改成和 cwd 拒绝表一样的「工作根豁免」：会话自己的 `<受保护根>\work\<id>` 放开，根的其他部分（别的会话、登记、库）仍拒。
  - 对话流里没有工具结果：host 协议只报工具名，不报输出（0.2 设计如此）。
  - 结束顺序：close 帧 → 3 s 后关 stdin → 2 s 后才杀 host。经 procguard 启动时杀的是包装进程，Job 一关 claude.exe 也一起结束；procguard 没开时杀了的话 feed 写「claude.exe 可能还在」（见上面「进程树的 Job 回收」）。
- **派活台（阶段 5，2026-11-02 接上）**：和 r4 不同或简化的几处：
  - r4 D9 和 §9.2 要分叉 adaptive-router 的 `router-core`（硬过滤、Wilson 证据门、滞回），这里没做：只有五条确定性规则（点名模型、点名 harness/「不要用 X」、改代码跑命令、短问答、默认），之后问一次 magpie 上的路由模型（`zcode/GLM-5.3`，chat completions，JSON 模式，20 秒）。只有规则把 harness 和模型都定了时才不问模型（D9「只有模糊时才用 LLM」的最小版）。证据门、影子模式留到 M4。
  - 候选只列能用的 harness（关着的、并发已满的都不列，卡片写明哪个不可用、是否已满），没有 r4 §9.2 第 5 步的类型化拒绝码。路由模型只能从规则留下的 harness 里选（r4 §9.2 第 9 步）：句子里说了「不要用 X」，模型还选 X，就拒掉它的答案（why 记 harness-excluded），卡片只剩规则的建议。同时在问路由模型的建议最多 2 个，再多的不问模型（busy）。
  - 路由模型起的标题在卡片上标明「路由模型起的」；只有人派给模型选的那一项时，才用它作会话名，否则会话名是那句话的第一行。
  - RouteDecision（journal 的 `route` 记录）没有 `input`（那句话）、`confidence`、`overriddenBy`：journal 不收自由文本（records.ts 的规则），那句话已作为会话第一条消息进了会话自己的对话流；置信度这一版不知道（T1：不写成 0）。有 `pick`（人选了第几个候选，手动改了就是 null）、`reason`（理由 chip：规则 id、router-model、manual）、`routerModel`（问了哪个路由模型，没问是 null）和 `routerWhy`（它的答案为什么没用上：没回、回了被拒、没问，见 router-model.ts 的 ROUTER_WHY）。只有 mode=manual。2026-11-02 第 3 阶段复核时加了 routerModel、routerWhy，routeId 改成可空：当时本机真实 profile 的数据目录里还没有任何 route 记录（最后写入是 11-01），所以没做旧记录迁移。
  - 派出时只认「同一句话」的建议：建议后改过句子，派出不带 routeId，记成一条手动的 RouteDecision（router not-asked）。建议只在内存里存 30 分钟、最多 64 条；重启后作废。塔表顶上「你」那一行显示最近一次派活（任何一次，不只带建议的）；不带 --owned 启动时派活台不开，也不读以前的记录，那一行写「没有读到派活记录」，不说「没派过」。
  - 联网：守护进程唯一的出站调用在 `src/net/magpie.ts`，只许 POST 到 http://127.0.0.1（组合根常量 `MAGPIE_CHAT_URL`）；builtin 表只给它 `node:http` 的 `request`，扫描规则 `net:magpie-post-loopback-only` 钉住 host 和方法。
- **自有会话跨重启**：每个会话一份 `ORCHESTRA_HOME\owned\<ownedId>.json`（0.2 设计 §2.4）。重启后没结束的会话显示「状态未知」、endReason daemon-restart，不续跑、不重发；对话内容只在旧进程内存里，重启后看不到。某个 harness 这次没开（SDK 不在、host 被改、找不到 codex.exe、准备失败）时，它以前的会话仍按同样规则只读列出（`src/owned/restored.ts`），不会从页面上消失。
- **第 3 阶段复核后补记（2026-11-02）**：
  - 并发上限：两家合计同时最多 3 个（0.2 设计 §2.4 的「同时最多 3 个活动的自有会话」，§4 的「同时最多 3 个，先结束一个」），之前误做成每家各 3 个。派活台把满了的 harness 当作不可用。
  - 结束原因新增三个：interrupt-unsure（你按了中断，但 Claude 还有没处理的消息，为免停不住，Orchestra 结束了它）、protocol-error（host 发来读不懂的内容，Orchestra 停了它）、daemon-stop（orchestrad 停机时结束的）。以前这三种分别记成 you-ended、exited、you-ended，和实际不符。
  - 停机：orchestrad 停机时先结束所有自有会话，再最多等 6 s 让每个 Claude host 走完停止顺序（close 帧 → 3 s 后关 stdin → 2 s 后杀），然后才关库退出；日志记下还没关掉的个数。Codex 的停止是关 stdin 后立即杀，不等。
  - Claude 的消息状态：写进 host 的 stdin 时是「已写给它的 host，还没确认收到」；host 回了这条的 lifecycle 帧或这一轮的 result 才算「已交给它」；host 在确认前就没了，记「发出了但不知道它收到没有」。
  - 会话结束后 host 还发来的审批请求：直接回拒，不建卡；host 关闭时不论会话怎么结束都清掉它名下的卡。
  - Codex 版本：codex.exe 是用户全局 npm 装的，会随 `npm i -g` 升级。现在每个会话从 initialize 回复的 userAgent 里读版本（实测格式 `orchestra/0.165.0 (Windows …) …`），不在钉死的列表（目前只有 0.165.0）里就以 policy-mismatch 结束，写明实际版本。没做「thread/start 后查 skills 列表必须为空」：实测 app-server 的 `skills/list` 在私有 CODEX_HOME 下照样列出用户目录的 skills（隔离靠的是不写进提示词，不是不列），这个断言会永远失败。
  - Codex 没来问就跑的命令：命令或文件改动跑完（completed/failed）却没有对应的审批请求时，对话流写一条「这一条它没来问你就跑了」。工作目录外的只读命令 codex 是否一定来申请审批：只实测过一次（`node scripts/live-smoke.ts --harness codex --outside`，2026-11-02，codex-cli 0.165.0，经 magpie）：让它读测试目录里、工作目录外的一个合成文件，它来申请了审批（命令卡，shell 风险），没有没问就跑的。同样的探测对 Claude 也是先来问（命令卡）。一次不代表总是如此，仍算未知。
  - 联调脚本：`scripts/live-smoke.ts`、`scripts/live-route.ts` 的每个请求有 30 s 期限；不论成败，派出过的会话都先经 orchestrad 结束并等完停止顺序，再关 orchestrad 的 stdin 让它自己停机（15 s 内没退出才杀，见下一条）；之后查残留（第 4 阶段复核后改）：经 procguard 起的会话按 Job 名字用脚本自己的 procguard 结束整组并计数（Job 名是 orchestrad 起的 128 位随机串，不靠 pid）；不在 Job 里的记录（常驻 procguard 等）只按 pid 和映像名查，对得上也只记作 unverified，不结束（pid 会被 Windows 很快回收，只凭 pid 和映像名可能杀到用户自己的进程；r4 D4 要求按 pid + 创建时间认进程，并拒绝用 `taskkill /T` 做回收器）。脚本自己的 procguard 只在 exe 的 sha256 和 orchestrad 日志里记的一致时才启动。
- **stdin 读到 EOF 就停机（2026-11-02 接上）**：orchestrad 的 stdin 是管道时（被启动器或脚本用管道启动），管道读到 EOF、关闭或读出错，就走和 Ctrl+C 同一个停止顺序：先结束所有自有会话（daemon-stop），等 Claude host 的停止顺序，关 Job，关库，退出码 0。日志记 stop-asked（why 为 stdin-eof 或 stdin-error），控制台写一行原因。stdin 是控制台（TTY）、空设备 NUL（stdio ignore、脱离父进程的启动）或文件时不监视：这些要么由人按 Ctrl+C，要么一开始就是 EOF，说明不了父进程走没走。判断在 `src/runtime/stdin-end.ts`：Node 给管道的 process.stdin 是 net.Socket（有 setNoDelay），给文件和 NUL 的是 fs.ReadStream。读到的内容一律丢弃。另外 main.ts 给 stdout、stderr 加了空的 error 监听：父进程没了以后往断掉的管道写状态行，若报 EPIPE 不会让 orchestrad 在停机中途崩掉（预防性的，唯一一次实测里没有报错）。
  - 实测（本机，Node 24）：① 测试里用管道启动、关 stdin，退出码 0，日志有 stop-asked 和 stopped；② stdin 为 ignore 时 1.5 s 后仍在运行；③ 一个 Node 父进程以 detached 方式起 orchestrad 后被杀，orchestrad 读到 EOF 自己停机（日志有 stopped）。④ 同样的父进程**不** detached 时，父进程被杀后 orchestrad 也没了，但日志里没有 stop-asked 和 stopped：它是被父进程的 libuv Job 一起强行结束的（S4 用例 a 的机制），自己的停止顺序没跑。所以「父进程死了也能收尾」只对不把子进程放进 Job 的父进程成立（cmd、PowerShell、bash 等，以及 detached 的 Node 子进程）；Node 写的启动器直接起它时，靠的是 Job 一起结束，不是这条。
  - 联调：`live-smoke.ts --harness codex --daemon-stop` 和 `--harness claude --daemon-stop` 各一次，会话停在空闲时关 orchestrad 的 stdin：都是 stdin-eof、退出码 0，会话记录的结束原因 daemon-stop，Job 里的进程（codex 那次 3 个，claude 那次 3 个）按 pid + 创建时间查 0 个还活着，leftovers 0。另跑一次普通的 `--harness codex`：结束后 orchestrad 同样经 stdin 停机，退出码 0，0 残留。每种只跑了一次。
- **真实 profile 的启动检查（2026-11-02，没做，留给用户）**：这一轮的编排要求让实现会话用 `orchestra.cmd --owned` 在真实 profile 下启动、经 API 配对、开一个自有 Codex 会话。没做，因为和两条现行约定冲突：① M0 计划 §2「agent 只能起测试 profile」和代-2（真实 profile 只由你在可见控制台里启动、由你配对，agent 只许起测试 profile；依据 r4 D8 和 §10.11 #4），② 代码本身的守卫：真实 profile 下 stdin 和 stdout 不都是控制台就不打印配对码（`decidePairingOutput`），脚本用管道启动时拿不到配对码，就配不上对、也解不了锁。要绕过只能给它造一个控制台再去读屏幕上的码，那正是这条守卫要挡的事。只核实了不启动也能查的：本会话的 shell 是 Medium 完整性级别（不是管理员，不会被提权检查拒绝）；本会话的环境里没设 `ORCHESTRA_HOME`，按 `src/runtime/env.ts` 真实数据目录就是用户目录下的 `.orchestra`（你自己的控制台若设了它，以它为准）。用户自己走一遍的清单写在 `docs/quickstart.md` 第 6 节。
- **procguard 实测（2026-11-02，本机，测试 profile）**：
  - 单元测试里的真机用例（`test/os/procguard-real.test.ts`）：用系统 csc 编出 procguard，常驻的说 ready；假 app-server（node）经 procguard-codex-fake 规则在 Job 里跑，它用 cmd 起 `ping -t`（S4 的基线：不经 Job 时这个 ping 在 node 被杀后还活着）。Job 里有 node、cmd、PING.EXE，包装进程本身不在 Job 里；刹车回 left 0，之后按 pid + 创建时间查，0 个还活着。另一条用例走普通结束（关 stdin 再杀包装进程），同样 0 个。没有 csc 时这两条会跳过并写明原因。
  - `node scripts/live-smoke.ts --harness codex`：退出码 0。Job 里有 codex.exe、codex-code-mode-host.exe、conhost.exe 各 1 个；结束后 feed 记 tree-ended，按 pid + 创建时间查 0 个还活着。
  - `node scripts/live-smoke.ts --harness claude`：退出码 0。Job 里有 node.exe（host）、claude.exe、conhost.exe 各 1 个；结束后 tree-ended，0 个还活着。
  - `node scripts/live-smoke.ts --harness codex --brake`：让 codex 用 `Start-Process` 起一个 `ping -t`（会脱离它的命令继续跑）。刹车前 Job 里有 codex.exe、codex-code-mode-host.exe、PING.EXE、conhost.exe ×2；刹车回 200，killed 5、left 0，会话结束为 braked，0 个还活着。
  - `node scripts/live-smoke.ts --harness claude --brake`：同样的任务，Job 里有 node.exe、claude.exe、PING.EXE、conhost.exe ×2；刹车回 killed 5、left 0，braked，0 个还活着。
  - 四次联调的测试目录都已删除，run/pids.jsonl 里记下的子进程（包装进程、常驻 procguard）事后都已不在。每种只跑了一次，不代表每次都如此。
- **seat 第 1 步：agent 侧请求口和请求卡（orchestrad 侧，2026-11-02）**。依据是本轮 seat 方案 final.md §5.1（seat 是一个 DSH bundle，把 Orchestra 注册成 DSH 的「受治理 Codex / Claude 子代理后端」；第 1 步只做 orchestrad 这一侧，DSH 那一侧的 bundle 是第 2 步，见下一条）。r4 A17（agent 只能请求新建乐手，只生成一条由你批准的条目）和 D8（只有一个审批队列，超时即拒；派出、批准、刹车只能由人在配对页面上做，agent 侧物理上没有这些路由）是这一步的边界。做法和与 final.md 不同的地方：
  - **开关**：新加 `--agent-port`，只能和 `--owned` 一起用（单独给就拒绝启动，`agent-port-without-owned`）。另外还要 `--peek-port`（配对页面在，人才能派出或拒绝）和至少一家自有会话开着；缺哪个就不开，控制台、日志和启动结果里写原因（`no-page` / `owned-off`），不会悄悄开一个没人能批的请求口。final.md 只说「接进组合根」，没说要不要单独开关；选了显式开关，因为它是一个新的进程间入口。
  - **pipe 名**：真实 profile 是 `\\.\pipe\orchestra-agent-real`；测试 profile 是 `\\.\pipe\orchestra-agent-test-<测试目录名去掉 orchestra-test- 的部分>`（不合 `[a-z0-9._-]` 或超过 64 字符时用它 sha256 的前 16 位）。final.md 写的是 `orchestra-agent-<profile>`，测试 profile 加了后缀，因为测试会多个并行跑，同名 pipe 第二个会 EADDRINUSE。DSH 一侧的 `cordis.patch.yml` 里 `pipe` 要按这个名字写。pipe 被占时请求口不开（`pipe-busy`），orchestrad 照常工作。
  - **令牌文件**：`ORCHESTRA_HOME\agent-port.token`，内容是 32 字节随机数的 base64url 加换行，经写围栏写入，关闭时经写围栏删除；每次启动都换。令牌不进日志、不上控制台、不进任何回复（控制台只印 pipe 名和文件路径）。
  - **cwd**：DSH 请求里的 cwd 先过 spawn 闸同一张 cwd 拒绝表（数据目录、各 harness 根、`~/.ssh`、AppData、仓库……），命中就 422 `cwd-forbidden`。过了也只在卡片上显示「它想在 X 干活」；派出后会话仍在 `ORCHESTRA_HOME\work\<ownedId>` 里跑，和自己派的会话一样。final.md 没写要不要在请求的 cwd 里跑；在 agent 指定的目录里跑需要先有「登记项目根」（本计划 §2 留到以后），所以这一步选更保守的一边。
  - **RouteDecision 记来源**：`route` 记录的结构没动（records.ts 规定每个字段都必填，旧 journal 要能重放，加字段会让旧行失败）。改成在同一批里多写一条新 kind `agent-request`：`{requestId, actionId, verdict: dispatched|rejected, harness, requesterKind: dsh, requesterDigest, ownedId, decisionId}`，派出时 `decisionId` 指向那条 `route` 的 decisionId，表示这次派活的来源是 agent 请求。拒绝时同样写一条（ownedId、decisionId 为 null）。请求方的 DSH 会话 id 不进 journal，只存 sha256（journal 不收来源自由文本）；卡片和日志里写原文。到期和撤回不是人的决定，不写 journal，只进日志。
  - **新的人手动作**：`POST /api/agent-requests/:id/reject`（人类动词 `request-reject`，要解锁和操控令牌，actionId 去重，和别的自有会话动作同一条检查链）；派出就是 `POST /api/owned/new` 带 `requestId`，文字和 harness 必须和卡片上的完全一样，否则 409 `request-mismatch`；请求已经不在等（派过、拒过、到期、撤回、重启丢了）是 409 `request-gone`。卡片上的模型建议来自同一个派活台：先规则、再问路由模型，但只在请求点名的 harness 里选（`desk.suggest(text, harness)`）。派出键和审批的允许键一样，「等你」栏变化后 750 ms 内无效（r4 §10.9）。
  - **请求状态**：`pending → dispatched → running → done`，或 `rejected / expired / withdrawn / failed`。内存里最多 16 条（满了先挤掉已结束的，全在等就 429 `full`），每分钟最多 6 条新请求（429 `rate`）。默认 10 分钟没人处理就 `expired`（D8 的「超时即拒」），组合根常量 `AGENT_REQUEST_TTL_MS` 可改。`done` 的意思是「派出的会话第一回合结束了（feed 里 turn-ended），最后一条 agent 消息可供请求方取回」（请求口的长轮询真把 done 回复交给管道后记 `fetched`，页面才写「已从请求口发给请求方」，对方是否读到仍写未知；复核修正，原先写「已交回」没核实过），不是对工作的判定：会话不会因此被结束，页面也从不写「完成」（T2、D19）。交回的内容按 A16（薄完成：只回状态、有界摘要和引用，截断要标明）：最后一条 agent 消息（feed 里已脱敏的文字），最多 8 KiB，被截、会话自己已截（final-cut）或 feed 丢过早期事件时 `truncated: true`。回合被中断、出错或会话先结束，记 `failed` 并写原因（`turn-interrupted`、`session-braked` 等）。orchestrad 每秒看一次在跑请求的 feed。
  - **请求文字先脱敏**：请求一到就过自有会话同一个脱敏器，并把不可见字符写成 `\uXXXX`；卡片显示的、问路由模型的、派出时作为会话第一条消息发出的，都是这一份。
  - **撤回 = owned-end 的正常停止顺序**（final.md §6.3 A 的建议，本轮已定）：pending 的直接变 `withdrawn`；dispatched / running 的会话走 `session.end()`，和你按「结束会话」是同一条停止顺序，不走刹车，请求库根本没拿到刹车。已结束的请求再撤回是空操作（DSH 在正常结束后也会调 dispose，seat 第 0 步核对过）。**和 final.md「不改 src/owned/*」不同**：给 `codex-session.ts`、`claude-session.ts` 的 `end()` 加了一个结束原因 `requester-withdrew`（停止顺序完全不变，只是标签），owned-contract 和页面文字同步加上。不加的话塔表和会话页会写「你结束的」，和实际不符。
  - **页面**（复核后改）：请求卡和「等你」栏里别的条目一起按剩余时间排（原先一律排在最前，会把快到期的审批压下去）：「以 DSH 名义请求派 Codex：<标签或第一行>」、剩余时间、全文、「自称来自 DSH 会话 <id>（未核实）」（没给 id 写「未知」）、想在哪干活、派出会用的模型和来源（没有建议时分清「还在问」「没有路由台」「路由台没给」「没拿到」），按钮「拒绝」「派出」；建议晚到、派出键要用的模型变了，也算栏目变化，派出键重新失效 750 ms。**没解锁时**页面拿不到请求列表（`GET /api/owned` 要解锁），原先这时一张卡都不显示；现在塔表快照的 `router.asks` 给每个配对页列出在等的请求（只有 harness 和截止时间，不带原文和请求方），页面画成占位卡「以 DSH 名义请求派 Codex：任务内容和请求方解锁后可见 · 剩 X 自动拒」，按钮是「先解锁」。页面在后台时新请求也发浏览器通知（不放派出操作）。栏头的件数包含请求卡（T3：计数等于列表长度）。顶栏的「等你」计数来自塔表 tally，**不含**请求卡（残余，见下）。会话页的状态行写「你应 DSH 请求派出的会话（请求方自称 …，未核实）· 请求现在…」；请求被挤出内存或 orchestrad 重启后，按 journal 里的 agent-request 记录写「你应 agent 请求派出的会话（请求详情已不在 Orchestra 内存里）」。
  - **builtin 表**：`src/server/agent-port.ts` 只能用 `node:net` 和 `node:http` 的 `createServer`；静态扫描规则 `net:agent-port-pipe-only` 钉住：pipe 前缀只声明一次、`pipeOptions` 拒绝别的路径、整个模块只有一处 `listen(pipeOptions(...))`。node:http 只解析，从不自己监听，所以这一行不是 TCP 监听，也不是客户端。
  - **残余**：① 没有 pipe-client-pid 校验（final.md §6.3 B，本轮已定第一刀接受）：同一用户的任何进程读到令牌文件就能提请求，但只能提请求，每条都要你点；卡片上的请求方是它自报的。② pipe 抢注：令牌不再过管道（复核后改成双向 HMAC，见下面「seat 复核修正」），只抢到管道的进程拿不到令牌、伪造不了回复；但读到令牌文件的进程再抢到管道就能冒充 orchestrad 回话。pipe 的 DACL 用的是 Node 默认值，没有收紧。③ 顶栏「等你」计数不含请求卡：它是树节点的筛选，计数等于点开后的行数（T3），请求卡不是树里的行，所以按设计不计入。页面标题自 4d7387e 起计入请求卡（标题数字 = 等你的节点 + 还在等的请求），2026-11-03 已在浏览器里实看，见下面「2026-11-03 已验证」。④ 请求只在内存里，orchestrad 重启后全部丢失，DSH 再查会得到 404 `request-unknown`。⑤ `live-smoke` / `live-route` 没为请求口加模式（联调用的是不进仓库的实验室脚本）。（原先的 ⑥「页面没在真实浏览器里点过」已不成立，见「2026-11-03 已验证」。）
- **seat 第 2 步：DSH 一侧的 bundle（`integrations/dsh-seat`，提交 1a70a91、e959aa1）**。DSH 0.2.1-rc.2 的插件，把 orchestrad 注册成两个受治理子代理后端（`subagent_codex_governed`、`subagent_claude_governed`），只经请求口提请求、查状态、撤回。联调在隔离的 DSH_HOME 和 orchestrad 测试 profile 里做，由一个实验室脚本（不进仓库）充当配对页上的测试操作者，跑三种：complete（人派出 → Codex 第一回合结束 → DSH 收到结果）、expiry（seat 的 60 秒时限到 → 撤回 → 拒绝）、withdraw（DSH 中断子级 → 撤回 → orchestrad 以 `requester-withdrew` 走正常结束顺序收尾）。上一个会话在 1a70a91 / e959aa1 上跑过一轮（结果只在实验室目录里，这里不复述）；复核修正之后在本机重跑了一轮，结果见下一条末尾。`~/.dsh` 在联调前后拍快照比对（只记文件名、大小、修改时间，没比内容哈希）。当时写的「没做的」三条（Claude 后端没联调；DSH web profile 下人在浏览器里点「派出」的完整路径没跑完；页面没在真实浏览器里点过）2026-11-03 都跑过了，见下面「2026-11-03 已验证」。
- **seat 复核修正（2026-11-02）**：一轮复核提出 28 条，核对代码后改了这些：
  - 请求口：node:http 不 listen 时自带的请求头、请求超时不生效，空闲连接能占满名额；现在每个 socket 自己在 Clock 上计时（5 秒内要送来完整请求头，一次请求最长 40 秒），过期就断；名额从 8 改成「保留请求数 16 + 4」；401 日志限速合并计数。停机时先让被唤醒的长轮询把「failed / daemon-stop」交给管道，再断 socket（原先长轮询拿到的是连接重置）。
  - 认证：令牌不再明文过管道，请求带随机数、时间和 HMAC，回复带 HMAC 证明（见上面残余 ②）；时间差超过 60 秒或随机数重放都拒。
  - 撤回：提交时发撤回钥匙，只有提交方能撤回；seat 断线时在 5 秒内重试，诊断按撤回实际结果写。
  - 截断：任务文字或 cwd 脱敏、写出不可见字符后超长就拒（422），不悄悄截；label 截断末尾加「…」；交回的消息写明截断原因（cap、final-cut、feed-clipped），记录丢过早期事件又没文字时是「未知」。
  - 每个请求方同时最多 4 条在等。
  - 塔表快照加 `router.asks`（契约同步改），owned 列表加 `requestedGone`、请求项加 `fetched`、`suggesting`。
  - 没照做的：令牌文件挪出 `ORCHESTRA_HOME`（Codex 沙箱在 Windows 上不限读，挪到哪个同用户可读的位置都一样，记成残余）；日志里的 requestId 改成摘要（有了撤回钥匙，requestId 单独已撤不回）；seat 共用一条长轮询（名额放宽后不需要）。
  - 修正后重跑（本机，测试 profile，隔离 DSH_HOME，各一次）：complete：卡片 9 秒出现，派出 200，请求 dispatched → running → done，会话 starting → running → idle，命令审批 1 次，hello.txt 内容为 hi，DSH 退出码 0，DSH 最后的回答里有 hi 和 hello.txt（新的三段式结果 DSH 收得下）；expiry：78 秒后请求 withdrawn / requester-withdrew、没有 ownedId，DSH 的回答说没人派出；withdraw：派出后 DSH 中断子级，请求 withdrawn，会话 ended / requester-withdrew，Job 已不在、0 个进程。orchestrad 经 stdin-eof 停机、退出码 0，令牌文件已删，残留进程 0。`~/.dsh` 前后快照（文件名、大小、修改时间）一致。只跑了一次，测试目录 `%TEMP%\orchestra-test-seat` 留在本机没删。
- **2026-11-03 已验证（全部在测试 profile 里，各一次）**。来源：浏览器走查的派出、拒绝两条路径和标题问题的发现，记在交接文件 99deb75 的 Done 一节；其余各条是主会话 2026-11-03 的转述，这里只记结论，命令输出和退出码没写进仓库，本条所在的提交也没有重跑。
  - seat 的 Claude 后端（`subagent_claude_governed`）和 orchestrad 联调过一次。
  - orchestrad 自己的 10 分钟到期实跑过：请求没人处理，到点变成 expired（超时即拒，D8）。
  - 标签页标题的计数（4d7387e，73bad96 让它在页面后台时也会动）在浏览器里实看过；顶栏「等你」仍只数树节点（T3，见上面残余 ③）。
  - `scripts/live-smoke.ts` 用 opencode-go 模型，codex、claude 两家各跑过一次。
  - 内置浏览器走查：派活台的建议、派出、拒绝、按住 1 秒允许、中断、刹车、结束会话、亮暗两套主题、375px 窄屏；seat 的占位卡、完整卡、派出、拒绝。修了两处布局问题：8bc1bd9（宽屏上「等你」栏为空时，发送框和三档停止键被挤到 0 高度的行里，看不见）、e483824（375px 下把树行「归属」列折叠的规则也藏掉了节点页的自有会话整块：状态、按钮、审批卡、对话）。浏览器后台时的请求通知没在真实浏览器里看过。
  - `scripts/live-route.ts --dispatch` 一次通过（脚本会派出一个带建议的会话，并检查它的 RouteDecision 记录；每项检查的具体结果没写进仓库）。
  - 73bad96 复核修正：标签页在后台时标题计数会动；seat 在请求方没给会话 id 时不合并请求（原先会把不同会话当成同一个）；第一次提交还在路上时的重复请求单独给诊断，不承诺有结果。
  - 仍只能由用户本人做的：真实 profile 下的启动、配对和页面走查（代-2）。
- **2026-11-03 日常使用的说明和启动方式**：
  - 新增仓库根目录的 `start-orchestra.cmd`：在双击打开的可见控制台里运行 `orchestra.cmd --owned --agent-port --peek-port 7470 %*`，另开一个最小化窗口等约 5 秒后用默认浏览器打开 `http://orchestra.localhost:7470/`。在 worktree 里没设 `ORCHESTRA_NODE` 时，用往上三级的主检出目录的 `.tools\node24\node.exe`。不做开机自启、计划任务（代-2：真实 profile 只由用户在可见控制台里启动，不开机自启）。只用 `/dry-run` 查过它找到的 node 和拼出的命令，**没有实跑**（实跑就是起真实 profile，按代-2 只能由用户做）。注释是英文的：cmd 按控制台代码页读批处理文件，UTF-8 中文可能读坏相邻行。
  - `docs/quickstart.md` 启动命令改成带 `--agent-port`，写了 DSH 请求卡、标题计数和顶栏计数的区别、代码只在本 worktree 里。
  - `integrations/dsh-seat/README.md` 加了「装进你日常用的 DSH profile」一节，由用户本人决定和动手（D11、Q5a）。
  - `package.json` 删掉 `build:procguard`：它指向的 `scripts/build-procguard.ts` 从来不存在（M0 计划第 1218 行列过，没写）。procguard 没有单独的编译步骤，由 orchestrad 每次带 `--owned` 启动时自己编（`src/os/procguard.ts` 的 `ensureProcguard`，系统 csc，产物进数据目录），所以没有作用一致的东西可以指向。改了 `native/procguard/ProcGuard.cs` 之后要跑的是 `node scripts/pin-procguard.ts`（重写 `src/os/procguard-pins.ts` 里钉住的源码 sha256），它是钉校验值，不是编译，所以没把它改名顶替进去。

### 子代理（Codex，2026-11-04 接上）

做了什么：

- **成员表**（`src/owned/codex-session.ts`）：不是根线程的线程都算这个会话的子代理（成员）。记线程 id、名字、型号、状态、开始和结束时间、失败的步骤数、没来问就跑的步数。别的线程说的话不进这个会话的对话流，连它的 `error` 通知的文字也不进，只取状态；例外是它发来的请求的标题，只带着它的名字出现（ask 行、auto-denied 行）。
- **名字**：v2 模型用 `agentPath`；v1 模型的通知里没有名字，轮到它开 turn 时发一次 `thread/read`（不带 `includeTurns`）取 `agentNickname`。名字过 redact。
- **状态**：在跑、空闲、已回报（`returned`）、已结束（`ended`，带原因：回合失败、被打断、被关掉）、未知。后到的事件不把已回报或已结束改回在跑，只有新 turn 能。
- **失败**：`meta.detects.error` 仍是 false（这版没有规则读失败，出错数不显示），所以没有节点是 `error`。回合失败写 `ended` 加说明。回合完成但步骤失败（实测第 3 次）写已回报，说明里写「其中 N 步失败」。
- **上限**：一个会话列 32 个，超过的只计数。对话流有一条提示，会话那行的活动写「另有 N 个……没列出」，`meta.clipped.nodes` 也加上。
- **结束和重启**：会话没了，还活着的成员写未知，不写在跑。成员跟着 `ORCHESTRA_HOME\owned\<ownedId>.json` 落盘（只有状态和时间，文件上限从 4 KiB 放到 32 KiB），重启后还列得出来；没有成员的文件和以前一样。
- **审批卡**：子代理发来的请求，预览第一行写 `from subagent: <名字> (thread …末 8 位)`，放在预览里，所以摘要盖得到。对话流的 ask 一行和受保护路径的 auto-denied 一行都带上这个来路，所以这条记录不会算到主线程头上。五种请求都这样，实测过的只有命令审批。文件改动的内容只来自子线程的 `item/started`，单独记着（根 turn 结束不清），只用于卡片，不进对话流。
- **塔表**：成员是自有会话的子节点，深度 1，字段和只读 subagent 一样，折叠规则也一样；节点 id 是哈希，线程 id 不上页面。节点多了 `durationMs`：从开始到结束，在跑时到现在，算不出写 null，页面写「未知」。只读节点全是 null。
- **等你**：成员节点不进等你。这条审批的等待留在会话节点上，成员的活动写「在等你审批：……」。原因是等你栏的卡挂在会话节点上，一个会话只出最早的一条，两边都挂就是一条审批算两次（T3：计数等于它链接的列表长度）。契约里加了这条。
- **配置**：`codex-home.ts` 没加开关。实测不需要，也没找到能在默认模型上关掉它的开关。子代理不算进 3 个并发上限，已写进 `codex-home.ts` 和 `codex-owned.ts`。
- **页面**：没改布局。`ownedIdOf` 不再把成员当会话（否则页面会拿哈希当会话 id 去发消息）。详情多一行「耗时」，用量那行写明只算主线程。
- **停止（2026-11-04 补）**：你点停止时，根 turn 照旧打断，每个还活着的成员再各发两步：先 `turn/interrupt`（它的线程 id 加它的 turn id），再 `thread/backgroundTerminals/clean`（它的线程 id）。根 turn 已经结束也一样发，所以 `GET /api/owned` 的条目多了 `stoppable`（有成员还活着，或者成员已结束但回合或命令还开着、上次停止没确认），页面的停止按钮看它，不再只看根线程。已回报或已结束的成员只要命令的 `item/started` 之后没等到 `item/completed`，或者上次 `clean` 或 `list` 没确认，也算在内：只发 `clean` 再读 `list`，所以被别的原因打断的成员和这次没停完的成员都还能再按。停止途中新冒出来的成员不会漏：读完结果重新看一遍成员，有新的再跑一轮，最后的计数把它们算进去。发出去不算停：成员状态只跟回来的事件走。对话流先写「已发出，还没确认」，2 秒后读 `thread/backgroundTerminals/list`，再写「N 个停下了」和「N 个没确认停下」。这三条对话流提示共用 ref `members-stop`：页面手里的实时提示只有等到同 ref 的事件才替换，`feed.since` 不告诉读者有事件被删。会话在停止途中结束时写一条同 ref 的 `members-stop-unanswered`（发出了，结束前没等到确认）。没确认的包括没回应、回合还开着、还有后台命令、状态未知和超出列表的，后面这几种本来就停不到。被清掉的命令要在回合结束后才回来（`failed`，退出码 -1）：这不算它失败的步骤，问过的也不算没来问就跑，所以被打断的回合不清「问过」的记录。`initialize` 多带 `capabilities.experimentalApi`，没有它 `backgroundTerminals` 三个方法直接被拒。

  实测（codex-cli 0.165.0，2026-11-04，真实运行 3 次、不调模型的干跑 2 次，只录方法名和状态）。第 2 次的命令 260 ms 就退出码 1，没测到东西；上一轮 real3 也是这样，所以才「没测成」。原因像是提示词里命令后面的「 .」被抄进了命令，这是推断，探测只录了输出长度。第 3 次把命令放进反引号后没再出现：

  | 动作 | 回来的事件 | 进程 |
  |---|---|---|
  | 根 `turn/interrupt`（子代理在跑 ping，根在 `wait`） | 回 `{}`，根 idle，根 `turn/completed interrupted`。子线程什么也没来 | 12 s 后 ping 还在 Job 里，子 turn 还开着 |
  | 子线程 `turn/interrupt` | 回 `{}`，子 idle，子 `turn/completed interrupted`。没有 `subAgentActivity`，命令的 `item/completed` 也没来 | 10 s 后 ping 和 powershell 还在 Job 里 |
  | 子线程 `thread/backgroundTerminals/list` | 1 条（`osPid` 是 null）。根线程的列表是空的：终端按线程算 | 还在 |
  | 子线程 `thread/backgroundTerminals/clean` | 回 `{}`，5 ms 后 `item/completed failed`，退出码 -1 | powershell 马上没了，ping 250 ms 内没了 |

  `turn/interrupt` 的 schema 只要 `threadId` 和 `turnId`，没写只能发给根线程，实测子线程也接受。接完后 `node scripts/live-smoke.ts --harness codex --subagent-stop` 跑了一次，测试 profile，走 magpie，退出码 0：根在等子代理和根已 idle 两种情况各停了一次，都是约 280 ms 后 ping 按 pid 加创建时间查不到、Job 里没有 PING.EXE，节点在跑 → 已结束，对话流写 `members-stopped=1`，会话本身还是 idle，收尾后 Job 里什么也不剩。

实测依据：codex-cli 0.165.0，3 次真实运行和 11 次干跑（2026-11-04）。事件序列抄进了 `test/fixtures/codex-subagent-frames.ts`，只有字段和状态。接完后 `node scripts/live-smoke.ts --harness codex --subagent` 两个模型各跑了两次，测试 profile，走 magpie，退出码都是 0。下表是最后一次：

| 模型 | 节点状态 | 有名字 | 耗时 | 卡上写了来路 | 对话流里子代理的工具行 | Job 里剩下的进程 |
|---|---|---|---|---|---|---|
| `codex/gpt-6.1-sol`（v2） | 在跑 → 已回报 | 是 | 11.7 s | 1 张 | 0 | 0 |
| `zcode/GLM-5.3`（v1） | 在跑 → 已回报 | 是（`thread/read`） | 17.6 s | 1 张 | 0 | 0 |

残余风险：

- **关不掉**：默认模型上子代理没有开关，自有会话随时能派。现在靠 Codex 自己的系统指令（用户或 AGENTS.md 没要求就不派）。
- **模型白名单**：`spawn_agent` 的 `model` 参数不经过 `isOwnedModel`。实测都继承父模型，没测过模型自己换型号。不拦，但 `subAgentActivity` 里报的型号记在成员上：详情写型号（没报写未知），名单外的型号写进节点活动和对话流。
- **停止管不到的**：① 根线程自己的长命令有同样的毛病（实测：打断后 5 s 还在 Job 里，`clean` 根线程才退）。2026-11-04 已接上，见「派发和拉线」一节。② 已回报或已结束的成员，只有命令 item 还开着或上次停止没确认才清；item 已结束但进程还留在后台的看不到，也不清。③ 超出 32 个列表的成员没记 turn id，发不了，只计数。④ 成员状态是 `running` 但 turn 还没听到时（`turn/started` 之前的几十毫秒）发不了打断，写没确认停下，再按一次或用刹车。⑤ `backgroundTerminals` 是实验接口，只在 0.165.0 上测过；Codex 版本一变，`CODEX_VERSIONS` 会先让会话结束。⑥ ~~`zcode/GLM-5.3`（v1 模型）的停止没跑过。~~ 2026-11-04 跑过了，两轮都过，见「派发和拉线」一节。⑦ 命令自己用 `Start-Process` 放出去的进程，`clean` 管不管得到没测过，推断是管不到，那种要刹车。
- **没测到的状态**：回合失败、`errored`、`interrupted`、`shutdown`、`notFound`、`interacted` 只在类型里见过，映射是读类型定的。嵌套子代理也没测过，现在平铺在会话下面。
- **没来问就跑的命令**：根线程的 `ran-unasked` 提示带命令文字，子线程的文字不进对话流，所以子代理走单独的计数：成员上记 `ranUnasked`，节点活动写「其中 N 步没来问就跑了」，对话流写总数，都不带命令文字。
- **受污染会话的子代理**（seat 请求开的会话，r4 §8.5）：`thread/start` 传 `untrusted`，`config.toml` 写 `on-request`，子代理跟哪个还是未知。2026-11-04 在测试 profile 补测 8 次（scratch 副本里把会话强制成 untrusted，根线程和子代理、两种策略都跑；`Get-ChildItem` 和 apply_patch）：全部出卡，没有一次没来问就跑。这里 on-request 下也没找到不问的命令（`echo`、`dir`、`git --version`、`Get-Date` 都问），所以分不开两种策略，不算证明。发现成员时对话流写一句，没来问就跑的步数照常记。
- **子代理的数量**：Orchestra 这边没有上限，32 只是列表上限，超过的继续跑，只计数。Codex 有没有自己的上限配置还是未知：除 features 开关外只试过 `[agents] max_threads = 1` 一次，三个子代理照样都跑了，但任务很短，可能没有重叠，也没核对这个键是否生效，说明不了什么。
- **子代理的文件改动**：2026-11-04 实跑过一次 on-request 和一次 untrusted：子代理用 apply_patch 写文件，卡片带改动内容、可批，批后文件内容对。
- **token**：会话用量只含根线程。子代理的用量没有显示。
- **Claude 自有会话**：~~还没接子代理，子节点数是 0，这个 0 的意思是没看，不是没有。~~ 2026-11-05 已接上，见「子代理（Claude，2026-11-05 接上）」一节。
- **沙箱**：`CodexSandboxService` 真启用沙箱时，进程会不会跑到 Job 外，查不到。

### 子代理（Claude，2026-11-05 接上）

**为什么之前禁。** 理由都在 alpha 0.2 切片设计里，r4 没有写禁它。r4 只说乐手内部照常可以用原生 subagent，M1 钳制、M2 看见、M3 管住（r4 第 57 行）。切片设计的理由有三条：

- 没有 procguard 的 Job 回收时少留孙进程（§2.1 防孤儿、§8 第 3 条）。
- 不经审批的工具要收口（§5 安全表，依据 D8：批准、拒绝、拍板、刹车只有人在配对页上能做，超时即拒）。
- 模型白名单和花费：Task 会换型号（S8），会并行放大（S20）。

后来 Job 接上了，第一条只对没有 Job 的会话还成立。另外两条要实测。

**实测**（CLI 2.1.287，SDK 0.3.287，2026-11-05，走 magpie。14 次探针直接跑 host 逻辑，私有配置目录和假 home 都在临时目录。Job 的结论来自下面的冒烟。）

| 问题 | 结果 |
|---|---|
| subagent 的工具调用走不走闸 | 全走。每次都先到 PreToolUse，要问的再到 `canUseTool`，两边都带 agent id，它和 `task_id` 是同一个值 |
| 根线程回合结束后还走吗 | 走。默认就是后台（`is_backgrounded: true`），根线程先结束，之后的调用照样到闸 |
| 能到 Orchestra 的审批队列吗 | 能。拒绝生效：两个写操作都拒了，两个文件都不存在 |
| 受污染会话（r4 §8.5，seat 请求开的会话）每次都问吗 | 问。前台和后台各一次，Read、Glob、Grep 在 cwd 内也问，孙代理也问 |
| 别的 agent 类型 | `Explore`、`Plan`、`claude` 都有 PowerShell，都到闸。`statusline-setup` 没有 shell。不写 `subagent_type` 时是 `general-purpose` |
| 嵌套 | 这版能嵌套（`spawn_depth` 2）。孙代理的调用也走闸，派孙代理本身也要问 |
| 后台命令、受保护路径 | subagent 发的 `run_in_background` 和 `~/.claude` 下的读都被拒，没出卡。WebFetch、TodoWrite、Skill 它手里没有 |
| 换型号 | 模型自己传过 `model: sonnet`，实际跑的是会话的型号（环境变量钉住了）。`fable` 没有对应的变量，所以拒 |
| 逃出 Job | 没有。它在 `claude.exe` 进程里跑，它的 ping、powershell、cmd 都在 Job 里。它用 `Start-Process` 放出去的 `ping -t` 也在 Job 里，刹车杀掉 8 个进程，按 pid 加创建时间一个不剩 |
| `interrupt` 管到它吗 | 管到。根线程在等它、根线程 idle 都一样。探针里任务当场停，ping 500 ms 内没了，之后没有再唤醒模型（看了 17 秒）。外层的 cmd 和 powershell 慢一些，冒烟里 3.4 到 3.7 秒后 Job 才清空（Codex 约 260 ms）。`stopTask` 也行，但之后会唤醒模型（实测 26 秒后说了一句），所以用 `interrupt` |

结论：没有绕过审批，也没有逃出 Job，放开。`mode`、`name`、`isolation` 这三个字段模型一直没传，没实测，host 直接拒。

**做了什么**

- **只给有 Job 的会话**：`claude-session.ts` 在 start 帧写 `subagents: job !== null`。没有 Job 时 `Task`、`Agent` 还在禁用清单里，提供它们照样 safety-stop，和以前一样。这版 init 里叫 `Task`，调用时叫 `Agent`，两个名字一起放。
- **派一个要批**（`hosts/claude/host-core.mjs`）：别的工具都是不问就不跑，`Agent` 也一样，卡上是完整 prompt，受污染会话也一样。这比 Codex 严，Codex 派子代理不问。输入只认 `description`、`prompt`、`subagent_type`、`model`、`run_in_background`。`isolation`（`remote` 跑到 Job 外）、`mode`、`name`、别的类型、`fable` 都直接拒，不出卡（`agent-input`）。
- **文字不进对话流**：带 `parent_tool_use_id` 的 assistant 消息只过型号守卫，不写 `text` 和 `tool` 帧。根线程的 `Agent` 调用也不写工具行，派发行代替它。`task_started` 的 prompt、`task_progress` 和 `task_notification` 的 summary 留在 host 里。
- **绊线**：subagent 的成功结果，如果闸没见过这个调用，会话 safety-stop（`unjudged-tool`）。没跑成的调用（参数错）本来到不了 hook，结果是错误，不算。实测没触发过。
- **成员**：表抽到 `src/owned/members.ts`，Codex 和 Claude 共用（状态怎么走、名字、派发和批次、上限 32、丢失写未知、落盘）。Codex 只留协议相关的部分。名字是模型给的 `description`，类型是 `subagent_type`（`MemberRecord` 新增 `agentType`，老文件读成 null，文件上限 32 KiB 放到 40 KiB），起止时间是 Orchestra 听到的时间。`completed` 写已回报，`failed` 写已结束（失败），`stopped` 和 `killed` 写已结束（被打断）。失败步数是真跑了但报错的调用，人或闸拒的不算，停止切断的不算。`ranUnasked` 恒为 0：绊线在前。
- **批次**：协议有字段。一次模型回复里的 `Agent` 调用共用 `message.id`，这就是一批，不用像 Codex 那样猜。`--pair` 实测两个一批。孙代理（深度 2）不写派发行，批次是 null，平铺在会话下面。
- **审批卡**：预览第一行 `from subagent: <名字> (task …末 8 位)`，在摘要覆盖的范围内。对话流的 ask 行和 auto-denied 行带同样的来路。塔上成员的活动写「在等你审批」，等待留在会话节点上（T3：计数等于它链接的列表长度）。
- **停止**：有成员还活着时，就算根线程没回合也发 `interrupt`。超出列表上限（32 个）的成员，没听到结束的也算，停止键亮着，发帧，停不下就写 `members-not-stopped`；听到结束的不算，停止键不会一直亮。`stoppable` 从成员算。对话流先写 `members-stopping`，2 秒后读结果，分两层：成员停没停看 CLI 的帧，命令清没清看 Job（`job.procs()`，常驻进程以外还有没有东西）。Job 里还有东西就每 2 秒再读，最长 6 秒。空了才写 `members-stopped`（文字说「后台命令清掉了」，所以按 T1，不知道写未知，只有这时能写）。到 6 秒还有写 `members-job-left`，Job 读不到写 `members-job-unsure`。等结果期间和这两种结果下，停止键都留着。成员 ended 但命令（`local_bash` 任务）没收到结束，算没确认，停止键留着。
- **唤醒回合**：后台成员结束后 CLI 会把模型叫起来说一轮，这轮没有用户消息。根线程在没有回合时出声，会话写 `running`，消息排队，停止管得到，它的 `result` 之后回 idle。出声算文字、工具行，也算根线程自己的 ask 和 auto-denied：`Agent` 调用不写工具行，「A 完了再派 B」这种只回一个 `Agent` 的回复，到会话这边只有 ask 这一帧。
- **seat 请求**（DSH 会话向 orchestrad 请求派一个自有会话的通道）：根线程派完当轮就结束，第一个 `turn-ended` 那句只是「已派出」。所以 `session.run` 告诉请求这一趟的情况：`out`（成员在跑，或 CLI 还欠一个唤醒回合）时请求留在 running，撤回照样结束会话；成员回报、唤醒回合说完才 done，结果取最新一个回合结束前的话；`cut`（成员被停止，或会话没等到就结束了）写 failed，不把半截话当结果。成员在回合中结束时，下一个 `result` 后再等 45 秒看有没有单独的唤醒回合。Codex 走同一段判定：成员的回合还开着就留在 running。
- **重启**：成员跟着 `ORCHESTRA_HOME\owned\<ownedId>.json` 落盘，重启后还活着的写未知。
- **页面**：没改布局。折叠卡、线、详情的类型和耗时都是现成的。右半边那句改成「还没看到它派出 subagent。派一个要你批，这个会话的进程不在 Job 里时不能派」。
- `scripts/live-smoke.ts`：`--subagent`、`--subagent --pair`、`--subagent-stop` 支持 `--harness claude`，判定和 Codex 一样。Claude 多等唤醒回合。新增 `--brake --via-subagent`。

**冒烟**（测试 profile，走 magpie，`zcode/GLM-5.3`，退出码都是 0，`leftovers` 全 0）

| 跑法 | 结果 |
|---|---|
| `--subagent` | 在跑 → 已回报，19.7 s，有名字和类型，型号 `zcode/GLM-5.3`。派发行 1 条，节点批次一致。卡 2 张（派它 1 张，它的 ping 1 张，后者写了来路）。对话流没有工具行 |
| `--subagent --pair` | 2 条派发行，1 批，都已回报。第 2 个回合是唤醒回合 |
| `--subagent-stop` | 根线程在等（前台）和根线程 idle（后台）两轮都过：`members-stopped=1`，节点在跑 → 已结束，会话 idle，停止键收起，失败 0 步，收尾后 Job 里什么也不剩 |
| `--brake --via-subagent` | 刹车杀 8 个进程，`left` 0，幸存 0 |
| `--subagent-stop --loose`（新加，2026-11-05 复核后） | 命令先放出一个外壳已退出的 `ping -t`，再跑前台 ping，这时按停止：成员已结束，前台 ping 和外壳没了，放出去的 ping 还在 Job 里，对话流写 `members-job-left=1`，停止键留着，收尾时 Job 带走它，幸存 0。放出去时外壳还活着的（`Start-Process` 直接跟 ping），1 次里跟外壳一起被 interrupt 带走了 |

这几种各跑了 2 次，只有 `--brake --via-subagent` 跑了 3 次。那 1 次和 `--pair` 同时跑，6 分钟里 Job 里一直没出现 ping，脚本到时间退出 1，原因没查到（那次没留记录）。事后本机没有 PING.EXE，所以不是逃出 Job。回归：Claude 的默认任务、`--brake`，Codex 的 `--subagent`、`--subagent-stop` 各跑一次，退出码都是 0（`members.ts` 动了 Codex 的代码）。

没用到的：`SubagentStart`、`SubagentStop` 钩子。`task_*` 事件已经够，少一条路。

**残余**

- **`max_turns`**：`MAX_TURNS` 50 只管根线程的一条消息。subagent 自己的轮数上限没查到。cwd 内的读不问，所以它可以只读不停地烧 token，要靠停止或刹车。
- **数量**：Orchestra 没有并发上限，但每派一个都要批，孙代理也是。子代理不算进 3 个并发上限。
- **花费**：`total_cost_usd` 含不含 subagent 没核实。实测里唤醒回合的累计数比第一回合大，像是含的。
- **唤醒回合的竞态**：唤醒回合第一帧（文字、工具行、根线程的 ask）到之前，会话还是 idle。这段时间写出去的消息和唤醒回合分不清，第一个 `result` 同时结束两边。下一条消息可能排进 CLI，这时按停止会读到 `stillQueued` 不为 0，会话被关掉。结果是偏安全的。窗口是模型第一次回话之前，卡开着的那段已经不在里面。
- **seat 等唤醒回合**：成员在回合中结束，CLI 是在这轮里告诉模型，还是回合后单独再叫一轮，没测，所以 `result` 后等 45 秒（`wakeWaitMs`）。单独那轮开口比 45 秒还慢，结果会是前一轮的话。成员在根线程 idle 时结束，就一直等到有 `result`。CLI 不叫，请求就留在 running，直到 seat 自己的时限撤回。这条路径只有假管道测试（真模块、假 host 帧），没有经 DSH 实跑；Codex 的成员结束后根线程会不会再说一轮也没测，它的请求拿到的是根线程最后说的话。
- **`interrupt` 停后台成员**：探针 1 次，冒烟 2 次，SDK 文档没写这个保证。CLI 版本一变，`cli-version` 检查会先停会话。
- **放出去的进程**：外壳已退出的进程，CLI 没有任务记录，`interrupt` 够不着，只有收尾或刹车能带走。Job 读得到它，所以页面不说清掉了，但停止键再按也停不了它，按了只是重读一次 Job。成员已回报、停止键没亮时放出去的进程，没有人提示，和 Codex 文件头写的残余一样。Job 里判断是不是命令靠映像名（`CLAUDE_JOB_RESIDENTS`）：node.exe 多于一个才算命令，`conhost.exe`、`claude.exe` 不分是不是命令起的。
- **没测到的状态**：`failed`（任务本身失败）没跑出来过，映射是读类型定的。步骤失败实测过（`exit 3`，读不存在的文件）。
- **`mode`、`name`、`isolation`、`fork`**：拒了，没测过。
- **`model: opus`、`haiku`**：放行，靠环境变量钉住，实测只跑过 `sonnet`。运行时型号守卫也读 subagent 的消息，换了型号会话 safety-stop。
- **根线程的长命令**：Claude 的 `--root-stop` 这次没做，只在 Codex 上跑过。
- **`msg-withdrawn`**：根线程回合被打断时，CLI 对这条消息发 `cancelled`，对话流会在 `msg-sent` 之后多一条「撤回」。这不是这次引入的。
- **页面**：这次没有在浏览器里走一遍 Claude 成员的折叠卡和线，靠塔接口的契约校验（冒烟里每次都是 200）和页面已有的测试。

### 总台（2026-11-05 接上）

用户的话：「superrouter 应当尽一切可能避免自己做任何非问答式的工作」「规划交给 worker」。规则见 `docs/design/mocks/2026-11-03-ensemble/round2/BRIEF.md` 第 1、1.2 节，`round3/BRIEF.md` 第 1.1 节。r4 里最接近的是 Maestro（§9.1：负责路由、委派、总结，从不改代码）。代码里叫 front desk，首页叫总台。

**实测**（2026-11-05，走 magpie；Claude 探针用私有 config 和假 home，Codex 只经测试 profile）

| 问题 | Claude（CLI 2.1.287，SDK 0.3.287） | Codex（codex-cli 0.165.0） |
|---|---|---|
| 能不能把工具收到两个 | 能。`tools: []` 加进程内 MCP，`system/init` 只列 `mcp__orchestra__dispatch`、`mcp__orchestra__status`，`Task`、`Agent` 也没有 | 不能。默认给 `exec_command`、`write_stdin`、`request_user_input`、`view_image`、`multi_agent_v1`、三个 goal 工具、`web_search`。把试到的开关全关后（`shell_tool`、`unified_exec`、`apply_patch_freeform`、`multi_agent`、`multi_agent_v2`、`goals`、`view_image_tool`、`[tools] view_image`、`web_search = "disabled"`），`zcode/GLM-5.3-Flash` 上还有 `request_user_input`、`view_image` 和三个 goal 工具。`view_image` 读本机文件 |
| 能不能在启动时核对 | 能，`system/init` 列全部工具 | 不能，没有列工具的帧。上面的清单是把测试目录的 `config.toml` 指到本地抓包端口看到的请求 |
| 模型会不会调这两个工具 | 三个问题（列工具、读状态、派活）各跑一次：`zcode/GLM-5.3-Flash`、`zcode/GLM-5-Turbo`、`opencode-go/glm-5.3-flash` 都调对了 | 没测（`codex/gpt-6.1-sol` 第一个请求 `tools` 是空的，抓包端口回 400 后没有下文，它的清单未知） |

结论：用 Claude host。模型默认 `zcode/GLM-5.3-Flash`：同样调对工具，5 到 9 秒一轮，第三问累计 1262 进 561 出（Turbo 是 1666 进 990 出、18 秒；`opencode-go/glm-5.3-flash` 是 3770 进 612 出、5 秒），派活台的规则本来就把它当便宜模型（`CHEAP_MODEL`）。这是一次的数，不是基准。磁贴上的选择框可以换 Claude 名单里任一个。

**做了什么**

- **开启**：磁贴上的「开启」走 `POST /api/owned/new` 加 `frontDesk: true`，和派活同一条检查链和同一个 `owned-new` 人类动词。批次里多一条新 kind `front-desk`，不写 `route`（没有派活）。已有一个在跑回 409 `desk-open`。页面发一句固定的话当第一条消息（「开启总台。……」），所以启动检查在你点的时候就跑，代价是一次便宜模型调用，开启按钮旁和资料面板都写了。这句话不算你说的：对话里写成系统动作（「你点了开启：……」），不是「你」的气泡。
- **名额**：不占 3 个并发名额，页面写了。理由：名额管的是在干活的东西，它没有能碰东西的工具，全局最多一个进程，除了开启那一次，你开口才调模型；占了的话它要派满 3 个就派不满。`active()`、`full()`、`limits.active` 都不算它。
- **工具**：`hosts/claude/host-core.mjs` 的 `start.frontDesk`（系统提示全文）开这条路：`tools: []`、`systemPrompt` 只用这段、`maxTurns` 8、不给 subagent。`initProblem` 要求 `tools` 正好是 `FRONT_DESK_TOOLS`，多一个少一个都 safety-stop，新版本多出的内置工具名也算。钩子拒绝其它一切。工作目录是它自己的 `work\<id>`。
- **读状态**（`src/route/front-desk.ts`）：`overview`、`waiting`、`session`、`orders` 四种读。自有会话的字段：id、标题、harness、状态、等什么、距上次活动的秒数、子代理数、上次做的事的种类（`command` 这样的词，不是内容）。不给 `activity`（那是会话最新一句话或命令）、审批的 title 和 preview、对话、命令输出。别人写的文字（标题、任务、回报）过 redact、只取一行、截到 120 字节。回报只给总台自己派出的会话。
- **默认收窄**（读到的东西经 magpie 发给模型提供方，所以默认少给）：只读观察的会话只给 id、harness、状态、项目目录名，不给标题和第一句话，也不给等什么、时间和子代理数；自有会话的标题照给。`waiting` 里来源不可信的请求不给文字，只写「一个 DSH 会话」（来自受污染的自有会话时写「来源不可信的会话」）和 harness，加剩余秒数（只是数字）；总台自己的派单照给，那是它自己写的。开启按钮旁和资料面板写明：总台的模型走 magpie，你自有会话的标题、等你的摘要会发给模型提供方。
- **派单结果**：`orders` 列总台自己发出的派单：id、状态、会话 id、回报一句话，拒绝、超时、撤回的也在，它们没有会话可读。`Proposed` 回复带派单 id。更老的写未知（`requests` 只留最新的，重启清空）。
- **派活**：同一个 `orchestra_dispatch`、同一个 `dispatch.ts`，默认派前问你。工具多了可选的 `why`、`returns`，worker 也能用，请求卡上也显示。和 worker 只差一点：派前问你时调用立刻回 `Proposed`，卡自己留着，这样你在派单等着的时候还能问别的。要是照 worker 那样等，它一个回合最长挂 10 分钟，这期间问什么都排队。结果照样进对话流（`worker-sent`、`worker-refused`，后者现在带请求 id），只是不回给模型，你问了它读 `orders` 才知道。回合被停不撤派单，派单到期算拒绝。
- **总台派出的 worker 受污染**：派活不限制，被派的会话收紧。总台读过不可信的标题、任务和回报，所以它派出的 worker 两档都按受污染启动（Claude 每个工具调用都问，读工作目录也问；Codex 用 untrusted，回显不对就停）。请求 `tainted`、`fromDesk`，审批来路 `desk-dispatch`，权限视图 `byDesk`。总台自己不算受污染会话，所以 `gateOf` 照常，「直接派出」仍然不问你就派。这个 worker 再派的，按受污染 worker 的规矩走卡片。卡片和权限面板写实话：这个 worker 是总台派的，它读过不可信文字，所以按不可信来源跑，工具都要你批。
- **首页**：左栏顶部是总台磁贴（未开启时有开启和模型选择，今天的说明保留，后面多一句它是什么）。点它进总台对话，输入框写「问总台」。`ui/front.js`（只有首页加载）画四种东西：你的话、回答、派单、回报。出处由 orchestrad 看到的读取算（`desk-read` 记录读了什么，不记内容），不是模型自报，回合结束才清空，所以回合中途排队的话不会把这一回合的出处抹掉；没读写「这句没读状态」。派单六件事（多了「在哪干」，和卡片同一句）写不全写未知，按钮就是「等你」里那张卡的 `req-go`、`req-no`。派单被挤出列表后还是一行，拒绝、超时写原因，不知道的写未知。回报写在派单的「现在怎样」里（`AgentRequest.output` 的第一行，标 worker 自述），不用调模型。回合出错写在对话上方。右半边显示它派出的 worker。
- **计数**：它不进塔（`towerSeats`），所以左边自有数、等你数、塔的 tally 都没有它。`GET /api/owned` 的 `owned` 里有它（`frontDesk: true`，派单要靠它显示来路），`frontDesk` 一节说能不能开、哪个在跑、实际工具。`grantsLine` 不数它。
- **受污染**：资料面板写了风险，两档措辞不同。开「直接派出」时写明标题、任务和回报是不可信文本、提示词注入可能让它不经你点就派活。

**冒烟**（`scripts/live-smoke.ts --harness claude --router`，测试 profile，走 magpie）：跑了 2 次，都是 21 项判定全过，退出码 0，`leftovers` 全 0。回归各 1 次，退出码都是 0：`--harness claude --dispatch-tool`（23 项）、`--harness codex --model zcode/GLM-5.3 --dispatch-tool`（23 项）、`--harness claude`（每个会话的派活工具都多了 `why`、`returns`）。工具实际清单：`mcp__orchestra__dispatch`、`mcp__orchestra__status`。读取：问状态读了 `overview`、`waiting`，问回报读了 `overview`、`session`。journal：`front-desk` 1 条，`auto` 1 条（总台），`route` manual 2、auto 1。页面在测试 profile 里走过一遍：开启、派单、点派出、回报、资料面板、1024 宽无横向滚动。

**残余**

- **回报不主动来**：worker 回合结束不唤醒总台，不自动续跑，没有循环（r4 D20 的精神）。派单上的回报行是页面读请求算的。回报要模型转述的话，你得问它。
- **派单记录在内存里**：`requests` 不落盘，最多 16 条，重启或被挤出后派单写未知。总台重启后也不恢复，要再点开启。
- **标题发给了模型**：总台读到的自有会话标题经 magpie 发给模型提供方。标题是那个会话的第一句话，过了 redact 也可能有私事。只读观察的会话已经不发。页面写了，开之前该知道。来自 DSH 请求的自有会话，标题是不可信请求的第一句，这里照给：决定是自有会话的标题照给，靠「总台派出的一律受污染」兜底。
- **提示词注入**：系统提示说别人写的文字是数据，标题也截短了，但这靠模型听话，不是硬隔离。「派前问你」时靠你看派单；开「直接派出」后派出这一步没人看。派出的 worker 按受污染跑，工具都要批，所以它能做的是起一个会话。`requests` 每分钟 6 条的速率也管它。
- **`Proposed` 之后模型不知道结果**：它可能说「等你确认」，之后状态变了要读才知道。提示词写了别保证回头告诉你，实际说法看模型。
- **第一条消息是固定的话**：开启花一次便宜调用，页面写了；对话里靠文字相等认出这一句（第一条 `you` 且等于 `front.opening`）。
- **磁贴锁着时写未知**：塔没有总台的信息，解锁才读得到。
- **没有路由**：页面刷新后回到第一个 worker，要再点磁贴。
- **没测的**：Codex 的 `codex/gpt-6.1-sol` 工具清单；模型改用 `opencode-go` 家的整条冒烟（只跑过探针）；窄屏手机宽度下的磁贴（只看了 1280、1024）。

**分歧**（由用户的话取代，r4 没改，等用户改）

| 文件 | 写的是 | 现在 |
|---|---|---|
| r4 §9.1（M1–M3 没有 Maestro，M4 才有；跑在 DSH 私有 home，模型 `deepseek-v4-flash`，由 §17 Q3 定） | M1–M3 期间你指定一个自有乐手当主代理 | 现在就有总台，跑在 Claude host 上，模型 `zcode/GLM-5.3-Flash`。理由见实测：DSH 没测过，Claude 能把工具收到两个并在启动时核对 |
| r4 §8.9 (c) 和 §9.1（M1–M3 主代理规划，M4 起 Maestro 提议计划，Q-P8） | 规划者是主代理，M4 起可为 Maestro | 总台不规划，规划派给 worker（round2 简报第 1.2 节），系统提示写了。规划 worker 这个角色还没做 |
| r4 §9.2 十步流水线（Maestro 走规则再走分类器，拿不准出 Route to?） | 路由是确定性规则优先 | 总台的派活由它自己的模型决定派给谁，不走这十步，靠「派前问你」兜底。派活台的规则和路由模型还在，只是派单卡片上的建议（`desk.suggest`）会跟着跑 |
| r4 §9.1 baton bar、`@mention` | 你通过顶部的 baton bar（`/`）和它说话，`@mention` 绕过 | 磁贴加对话，没有 `/` 和 `@` |

### 派活权限（2026-11-05 接上）

用户的话：「这里不应该限制派出，至少允许打开相关权限让bot自由派出」。规则见 `docs/design/mocks/2026-11-03-ensemble/round3/BRIEF.md` 第 1.1 节。

**实测**（走 magpie，私有 CODEX_HOME 和假 home，都在临时目录；Codex 探针 8 次，Claude 探针 6 次，2026-11-05）

| 问题 | Codex（codex-cli 0.165.0） | Claude（CLI 2.1.287，SDK 0.3.287） |
|---|---|---|
| 怎么给工具 | `thread/start` 的 `dynamicTools: [{type:'function', name, description, inputSchema}]`，要 `experimentalApi`（本来就开着）。`zcode/GLM-5.3` 和 `codex/gpt-6.1-sol` 都能用 | 进程内 MCP：`mcpServers: {orchestra: {type:'sdk', name, instance}}`。SDK 只调 `instance.connect(transport)`，所以手写一个 instance，不用 `createSdkMcpServer`（它的 `tool()` 只收 zod，host 不引 zod）。init 里多一个 `mcp__orchestra__dispatch` 和一个 connected 的 server |
| 调用怎么来 | 服务端请求 `item/tool/call`：`threadId`、`turnId`、`callId`、`tool`、`arguments`，前后各一条 `dynamicToolCall` 的 item。on-request 和 untrusted 下都不先问 | PreToolUse 钩子先到（`allow` 就不走 `canUseTool`），然后 `tools/call`，`_meta` 里有 tool_use id |
| 回什么 | `{contentItems:[{type:'inputText',text}], success}`。`success:false` 模型照样读得到文字 | `{content:[{type:'text',text}]}`，失败加 `isError:true` |
| 能等多久 | 330 秒后回，照常走 | 310 秒后回，照常走（文档说默认基本不限时） |
| 打断时 | `turn/interrupt` 后 item 写 failed，回合 interrupted，没有 `serverRequest/resolved`。之后再回这条请求没有副作用，下一回合照常（1 次） | 收到 `notifications/cancelled`，回合 `error_during_execution` |
| 子代理有没有这个工具 | 没有，1 次：子线程说手里没这个工具 | **有**，1 次：钩子带 agent id，所以 host 拒掉 |

结论：两边都能做，请求方都是 orchestrad 自己知道的（Codex 是这条管道的会话，Claude 是这个 host 的会话），不靠模型自报。r4 §8.5 本来就写 Claude 乐章用进程内 MCP。

**做了什么**

- **工具**：`orchestra_dispatch`（Claude 里叫 `mcp__orchestra__dispatch`），参数是任务文字、harness、型号（可选）、工作目录（可选）。每个自有会话都有，但没有配对页（不带 `--peek-port`）就不给。结果不回给 worker：回复写明「它的结果不回给你，人看得到」。
- **`src/route/dispatch.ts`**：判定都在这里。`gateOf` 决定走哪一档，`dispatchArgs` 查参数。驱动只拿到 `DispatchPort`（`call`、`sentOf`），上面没有改权限的方法，有测试钉住。
- **权限**：每个会话一档，`ask` 派前问你（默认）或 `free` 直接派出。`POST /api/owned/:id/dispatch-grant`，人类动词 `dispatch-grant`，和别的自有动作同一条检查链（Host、配对 cookie、Origin、Sec-Fetch-Site、操控令牌、actionId 去重），`human`、`human.result`、新 kind `dispatch-grant` 同一批写进 journal，写完才生效。`level` 只收这两个值，`away` 是 400。
- **派前问你**：工具调用走 `requests.create`，就是现有的请求卡，`requester` 是 `owned:<ownedId>`。工具一直等到人点。点派出走原来的 `POST /api/owned/new`，写 `route`（manual）和 `agent-request`（`requesterKind` 新增 owned）。拒绝、超时（10 分钟）、回合被停，worker 都读到一句固定的话。卡上来路写「Orchestra 自己的会话 X（orchestrad 看到的，不是它自报的）」，不写「自称」。
- **直接派出**：不出卡，走 `requests.create`（`auto`，不问路由模型）取得同一份脱敏和速率限制，再查型号（`isOwnedModel`，Claude 还要 `isClaudeModel`）、项目根（`judgeCwd`、`placeRunIn`，点名的目录不在根里就拒，没有卡可以说它改到哪去跑）、上限，然后 `manager.create`，也就过了 spawn 闸。journal 写 `auto`（`by`、`ownedId`、`grantActionId` 指向人开权限那一步、`depth`、任务的 digest）和 `route`（`mode: auto`，`reason: worker`），没有 `human`。写不进去就把刚起的会话结束，告诉 worker。
- **不放开的**：
  - 受污染的会话（seat 请求开的）一律退回派前问你，新会话照受污染处理，卡上写退回的原因。
  - 被派出的会话从派前问你开始，不继承（A17）。
  - 派出的深度上限 2：你开的会话算第 0 层，第 2 层再派就拒，两档都拒。
  - 你不在时退回派前问你，见下面的「在场」。
  - seat 请求口不读权限：它的 body 里 `kind` 是常量 dsh，也没有 `auto`，有反向断言。
  - 命令和改文件的批准一点没变。派出的会话要批什么，和同一个 harness 你自己开的会话一样。
  - 子代理不能派：Codex 没给它工具，Claude 由 host 拒（`dispatch-subagent`）。
- **在场**（`src/route/presence.ts`）：今天没有现成的判定，只有 `POST /api/client-state` 的路由，页面也没在发，所以做了 r4 Q-P3 那一条（在场 = UI 心跳 + 30 分钟内一次 UI 操作）的最小版。心跳是解锁页面读 `GET /api/owned`（前台 2 秒，后台 10 秒，30 秒没读算不在），操作是任何一条人手记录。一次都没听到页面写未知，也退回派前问你。任务书说没有判定就写未知并退回，但那样直接派出永远走不到，所以补了这个，依据是 r4 Q-P3。
- **超过上限**：拒绝并告诉 worker，不排队。任务书两种都允许。排队的话调用要占着 worker 的回合，而 worker 自己就占一个名额，三个 worker 一起等只能等到超时。所以 `R3.keeps` 第 4 条在页面上改成「超过的不派，告诉 worker，不丢」。
- **来路**：审批卡的 `origin` 新增 `worker-dispatch`，写「来路：worker「X」派出的 → 这个会话」。干净 worker 派出的会话不算受污染（r4 §8.5：同一项目里来源链干净的自有乐手之间是 clean，仍是 `trust: agent`），卡上没有红条。
  - 2026-11-05 复核后补的：`codex-session.ts`、`claude-session.ts`、`approvals.ts` 里「有来路就算受污染」收窄到 `kind === 'agent-request'`，原来这三处让干净 worker 派出的会话全部受污染。受污染 worker 派出的还是受污染，由调用方传 `tainted`。
  - 2026-11-05 复核后补的：来路的 label 不再直接用标题。标题上限 240 字节，契约里 label 上限 120 字节，超长时 `GET /api/owned` 整页 500。现在走 `requests.label`，和 seat 请求的 label 同一条路，截断处标 …。
- **记录上分开**（2026-11-05 复核后补的）：塔的 `router.dispatch` 多一个 `auto`，旧页面「你」那一行写「worker 按你开的权限派的，不是你点的」，重启后从 `route` 行的 `mode` 读回。`GET /api/owned` 多一个 `sentGone`：按权限派出、请求详情已不在内存的会话，`requestedGone` 只留你点过的；重启后从 journal 的 `auto` 记录读回。
- **首页**：
  - 权限面板在 worker 的「资料」里：三档（第三档不能按，写 D20 不允许）、谁什么时候改的、现在在不在、不放开的五条。
  - 对话流里派出的回执是一行 `tpl-disp`，写「权限派的：「直接派出」是你 HH:MM:SS 开的」或「你点的派出」，被派出的会话或它的 subagent 还在跑时有「停」（根线程 idle 而后台 subagent 在跑也算），走它的 `interrupt`。subagent 批次的行没有「停」：那不是一个会话，没有东西可发。
  - 被派出的会话在右半边是一张类型 worker 的折叠卡，线从回执拉过去，卡里有「打开」。它在左边还是一个 worker。塔节点多一个 `sent`。
  - 右栏底下那句改成真实计数，解锁前写未知。标题改成「X 派出的 worker 和 subagent」。
  - 锁着的占位卡原来写「以 DSH 名义」，现在可能是 worker 的请求，改成「有请求要派 X」。
- **`requests` 不再只跟 `--agent-port`**：只要自有会话开着就有，端口还是要 `--agent-port`。

**冒烟**（`scripts/live-smoke.ts --dispatch-tool`，测试 profile，走 magpie）一次跑完：派前问你、直接派出、到上限、你不在（32 秒不读列表）、seat 请求和受污染退回，22 项判定，然后读 journal 核对，`leftovers` 全 0。

| 跑法 | 结果 |
|---|---|
| `--harness claude --dispatch-tool`（`zcode/GLM-5.3`） | 22 项全过，退出码 0。journal：`auto` 1 条，`route` manual 4 条、auto 1 条，`dispatch-grant` 2 条，`agent-request` 是 owned 派出 2、owned 拒绝 1、dsh 派出 1 |
| `--harness codex --dispatch-tool`（`codex/gpt-6.1-sol`） | 同上 |
| `--harness codex --model zcode/GLM-5.3 --dispatch-tool` | 同上 |

Claude 完整跑通 2 次，Codex 两个型号各 1 次（`zcode/GLM-5.3` 之前还有 2 次跑到 seat 那步，因为脚本把目录写错退出 1，前面的判定都过）。回归：`--harness claude`、`--harness codex`、两边的 `--subagent` 各跑 1 次，退出码都是 0（每个会话现在都多了这个工具）。

**分歧**（这些由用户的话取代，r4 没改，等用户改）

| 文件 | 写的是 | 现在 |
|---|---|---|
| r4 A17（第 794、2417、2447 行，R40） | agent 只能请求新建乐手，只生成一条条目，由你批准；agent 不能自我复制 | 「直接派出」时 worker 不经你批准就起一个新会话。留下的部分：权限只有你能开，派出的会话不继承，深度有上限 |
| r4 §9.5 和 Q11（第 1515 行，第 2911 行） | 自动派活要经 shadow，最近 50 条一致率 ≥80%、blocked→noticed 中位 <2 分钟才进 active | 没有门槛，只要你开了权限。那条说的是路由模型替你选，这里是 worker 自己要派，机制不同，但结果都是不经你点就派出，算分歧。`route` 的 `mode` 新增 `auto`，和 r4 的 shadow、active 不是一回事 |
| 本计划（任务书写第 169 行） | 派出只有人点 | 第 169 行现在不是这句话。写这个意思的是「### 3. 路由」的「人点「派出」才起会话；从不自动派」、seat 第 1 步的「派出、批准、刹车只能由人在配对页面上做」、「项目根」的「派出仍只有人在配对页上点」。这三处留着当历史，这一节取代它们 |

没有分歧的：r4 D20（默认有人值守：你不在时不派新的执行 Task）照旧，「你不在也派」没有做，页面写明不允许。D8（批准、拒绝、拍板、刹车只有人在配对页上能做，超时即拒）照旧：开权限是人在页面上做的，agent 侧没有这条路由。

**残余**

- **受污染只认来源**：Orchestra 今天只知道会话是不是 seat 请求开的。r4 §8.5 说读过项目根外的文件、抓过网页也算污染，这些没有跟踪，这样的会话在直接派出里算干净。
- **派出的结果不回 worker**：worker 只知道派出去了。要回传得另做。
- **重启**：权限、深度和派出关系都在内存里。重启后会话本来就不恢复，但页面上看不到谁派的谁，journal 里有。
- **速率限制是共用的**：`perWindow` 6 条每分钟，worker 和 seat 一起算，worker 派满了 seat 会吃到 429。
- **在场只看这一页**：r4 说在终端或 IDE 里忙也算不在，这里也算不在，偏安全。多个页面没有分开算。页面隐藏也算心跳，r4 就是这么写的。
- **模型自己决定用不用**：工具说明写了「人要求或确实需要才用」，这只是提示。派前问你时它能一直发卡，每个 worker 最多 4 张等着，每分钟 6 条。
- **子代理 1 次**：两边「子代理有没有这个工具」都只测了 1 次。Codex 那边万一有，`dispatchCall` 按线程拒掉。
- **`route` 的 `taskClass`**：auto 也按规则算，和人手的一样，这份标签以后给路由模型用时要分开。
- **页面**：配对后的真实页面这次没走：浏览器里看的是真的 `ui/` 文件加合成数据（桩服务，CSP 只限了 self），1280 宽：回执、线、折叠卡、「打开」、「停」、权限切换、请求卡都点过，这一步抓到页面的 POST 路径表漏了新路由（`bad-id`），已修，有测试。派出和拒绝在真页面上走的是原来的按钮。375 宽、浅色主题没看。

### 项目根（--project-root）

2026-11-03 加。以前自有会话（orchestrad 自己拉起并驱动的 Codex / Claude 会话）只能在 orchestrad 自建的 `ORCHESTRA_HOME\work\<id>` 里跑，碰不到主人真正的项目；DSH 经 seat（DSH 会话向 orchestrad 请求派一个自有会话的通道）传来的 `cwd` 只显示在卡片上。现在主人可以在启动时点名项目根，全部是 opt-in：不带这个参数，行为和以前一样（有反向断言的测试）。

**依据的条文**（以 r4 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 为准）：
- r4 §5.3「数据目录」：私有 DSH home 和私有 `CODEX_HOME` 都在 `~/.orchestra` 下，并且必须在所有项目根目录之外；乐手的 cwd 如果位于任何 `DSH_HOME`、`CLAUDE_CONFIG_DIR` 或 `~/.orchestra` 之内，一律拒绝。→ 项目根先过 cwd 拒绝表（数据目录、每个 harness 根都是表里的「受保护」行；落在里面或把它们包在里面的根都拒）。
- r4 §5.3「零写入是持续的不变量」和 §5.2 组件表「写围栏 / 读白名单」一行：所有写只经一个 fs 模块，默认只允许 `~/.orchestra`。→ orchestrad 自己不在项目根里建目录、不写文件；它只用一个只能 stat 的读闸（`project-root` 根类型：只回答「这个路径是不是目录」，不读、不列目录）。写项目文件的是会话子进程，每次写都要人批准。
- r4 D4（每个自有子进程宿主在自己的嵌套 kill-on-close Job 里，由 procguard 拉起）：不变。项目根里的会话照样经 procguard 起在自己的 Job 里；live-smoke 实测会话结束后 Job 里 0 个进程存活。
- r4 D8（审批、拍板、刹车只有人能做，超时即拒；人类动作只挂在需要配对 cookie 的 UI 上）：派出仍只有人在配对页上点。页面只能从启动时放行的根里选，不收任意路径；seat 请求的 `cwd` 只决定「人点派出后在哪里跑」，agent 不能自己派出，也不能指定根。
- r4 §10.9：高风险工具类（shell、网络、受保护路径、cwd 之外的写入）要键入确认或长按确认。→ 会话的 cwd 换成项目根后，「cwd 之外」就是项目根之外；审批卡的高风险判断沿用现有代码（cwd 外的路径是 `protected` 风险，要按住或键入）。
- r4 §5.3 渲染规则 2：cwd 路径一律用 `textContent` 渲染。→ 页面上的根、会话工作目录都走现有的 textContent 描述器。
- r4 §11.7 新建乐手向导「项目 → harness → 权限预设 → 人设模板 → 目录或 worktree」：派活台多出的「工作目录」选择对应其中「目录」一步（只是类比：向导是 M1 的乐手模型，这里是派一个自有会话）。
- r4 §6.1 Project 实体有 `roots[]`（cwd 前缀、worktree）。这次没做 Project 实体，只是启动参数。
- spawn 闸（只经 `src/os/spawn.ts` 起子进程、cwd 由闸自己的 `CwdPolicy` 判）：r4 里没找到这条，出处是 `docs/plans/2026-11-02-alpha-0.2-slice-design.md` §2.1 和 `src/os/cwd.ts`、`src/os/spawn.ts` 的注释。项目根只是加进闸的允许根列表，闸在每次起子进程时照旧再判一次。

**做了什么**：
- 启动参数 `--project-root <绝对路径>`，可以给多次（最多 16 个），只能和 `--owned` 一起用（`src/runtime/test-profile.ts`）。每个根在拿锁之前检查（`src/os/project-roots.ts` `checkProjectRoots`，`src/runtime/working.ts`）：普通绝对路径、不是盘符根、过 cwd 拒绝表（用户目录本身、`AppData`、`.ssh` 等、系统目录、Program Files、orchestra 仓库及主检出和它们的上级、数据目录、harness 根）、存在、realpath 等于自己（路径上没有连接点、链接、8.3 短名）、是目录、换个写法也不重复。第一个不合格的根让 orchestrad 拒绝启动（退出码 24，和参数错误相同），控制台写明哪个根、为什么；什么都不建、不拿锁。合格的根打印一行「project roots for owned sessions: …」，并记进日志。
- 测试 profile：拒绝表本来就把 `%TEMP%`（在 `%LOCALAPPDATA%` 下）当作 AppData 拒绝。做法照搬工作根的例外：测试 profile 下项目根必须严格位于测试目录里（测试目录本身装着数据目录，所以它本身也会被拒），并且只在项目根里面不按 AppData 那一行拒，其他行照旧。真实 profile 没有这个例外，`%TEMP%` 下的根会被拒。例外由 `CwdPolicy` 自己持有（`spec.testDir` + `spec.projectRoots`），构造时每个根再过一次表，不合格就不构造。
- 派活台：多一个「工作目录」选择，默认「Orchestra 自建的工作目录」，其余选项是放行的根，没有自由输入。选了根时说明按 harness 写：Codex「经你批准它能改这个目录里的文件；Codex 在 Windows 上的沙箱只读（`codex-session.ts` 请求 `workspace-write`，Windows 上回成 `readOnly`，见上文「已实测」），所以它每次写文件、跑命令仍会先来问你」；Claude「读、查找这个目录里的文件不问你（host 对 cwd 内的 Read/Glob/Grep 走 CLI 默认），写文件、跑命令每次先来问你」。没放行任何根时选择框不显示，说明里告诉怎么用 `--project-root`。`POST /api/owned/new` 多一个可选的 `root`，必须正好是列表里的一个根（不分大小写），否则 `cwd-forbidden`；和 `requestId` 一起给也是 `cwd-forbidden`。
- seat 请求：请求进来时（`src/server/agent-port.ts` `placeCwd`），`cwd` 落在某个根里（根本身或子目录，规范化后比较、不分大小写）、DSH 写的路径里没有 `..`、realpath 等于自己（防链接逃逸）、过拒绝表、是目录，就记下 `runIn`；卡片写「这在你放行的项目根里，派出后在 <cwd> 里跑」，派出时会话就在那里跑。否则 `runIn` 为空、`runInWhy` 写原因（没放行根、不在根里、有 `..`、有链接、不存在、不是目录、受保护、路径被脱敏器改过），会话照旧在自建目录里跑，卡片照实写原因。
- 会话页写「工作目录 <路径>（你放行的项目根 / Orchestra 自建）」，重启前开的会话写「工作目录未知」。塔表里自有会话那一行在解锁后多一段「在 <文件夹名>」（数据来自解锁后的 owned 列表；塔表快照本身不带路径，解锁前看不到）。
- 契约：`GET /api/owned` 加 `roots`，每个会话加 `cwd {path, kind}`（或 null），每个请求加 `runIn`、`runInWhy`；`shared/owned-contract.js` 的校验器管这些字段（`runIn` 和 `runInWhy` 恰好一个为空，根不重复、是绝对路径）。契约冻结测试同步更新。
- journal：RouteDecision（`route`）结构没动。从派活台选的根在请求 body 里，`human` 记录的 `requestDigest` 已经覆盖；seat 请求的落点原先只在日志 `owned-started`（`projectRoot: true, cwd`）里，复核后加了 `owned-cwd` kind（见下「复核后改」）。

**实测**（2026-11-03，本机，测试 profile，一次）：`scripts/live-smoke.ts --harness codex --project-root`（脚本新加的参数：在测试目录下建 `proj` 当项目根，用 `--project-root` 启动，按列表里的根派出）。列表列出 `<testDir>\proj`；会话 starting → running → idle，命令审批 2 次（shell，都由脚本代人允许）；`smoke.txt` 写在项目根里、内容正确；会话自建工作目录没有建；列表里会话的 `cwd.kind` 是 `project-root`；结束后 Job 里 0 个进程存活，orchestrad 经 stdin-eof 停机、退出码 0，残留进程 0；测试目录已删。

**没做、未验证的**：
- 真实 profile 下带 `--project-root` 启动、配对和走查：未验证（代-2：真实 profile 只由用户在可见控制台里启动）。
- Claude 会话在项目根里跑：未实测（只跑了 Codex）；Claude host 对 cwd 内读不问人，这在真实项目里意味着它能不经批准读整个项目，页面已写明。
- r4 §7.4 列的项目内受保护路径：复核后已加（见下「复核后改」），但只到「高风险卡」（risk `protected`，和 cwd 外的写入同一档：按住或键入）；`package.json` 整个文件算受保护，不解析是不是改了 scripts。`.git/config`（能设 `core.hooksPath`）不在 r4 的清单里，这次也没加。

**复核后改（2026-11-03，提交 "orchestra app: project-root review fixes"）**：
- seat 请求落在项目根里、派给 Claude 时，会话按 r4 §8.5 记为 tainted（来源链里有 unbound 发送者）：host 对每次工具调用都询问，cwd 内的 Read/Glob/Grep 也问（卡片是普通风险）。派活台自己选根的 Claude 会话不变（读不问人，页面照写）。Codex 的 r4 §8.5 untrusted 审批策略没做（没实测过 app-server 对 `approvalPolicy: untrusted` 的回复），卡片写明「它读那里的文件会不会先问你，未知」和「最后的回复会交给发请求的 DSH 会话」。（已由 d212b86 改，见本节末「seat 会话按来源不可信启动」：Codex 现在用 untrusted 启动，卡片改成实测口径。）
- 项目内受保护路径（r4 §7.4）：`src/owned/guarded.ts`，按会话 cwd 相对路径、任意深度、不分大小写，按原路径和 realpath（8.3 短名会解析）各查一次；Codex 的改文件请求、Claude 的非读工具命中时审批卡 risk 为 `protected`，预览第一行写明命中哪条。
- 项目根里的 Codex 会话只接受 `thread/start` 回 `readOnly` 沙箱，回 `workspaceWrite` 就以 policy-mismatch 结束（自建工作目录照旧两种都收）。派活台的 Codex 说明改成实测口径。
- 「在根内」的比较：允许类判断（cwd 在允许根内、工作根和项目根的豁免）改用只折叠 ASCII 的比较，并且拿 realpath 和根的 realpath 比；`toLowerCase` 会把 KELVIN SIGN（U+212A）等折成 ASCII，NTFS 不会。项目根按磁盘上的写法（realpath）保存。拒绝类判断仍用原来的宽折叠。
- seat 请求的目录读闸不让 stat（例如名字含 credentials）或 realpath 因 ENOENT 以外的原因失败时，`runInWhy` 记 `stat-refused`（是不是目录未知），不再记成「不存在」。
- 启动检查拒掉页面契约或 owned-new 路由不收的根：含控制符或 bidi 字符（`bad-chars`）、超过 260 码点或 780 UTF-8 字节（`too-long`）。
- journal 新 kind `owned-cwd`：会话在项目根里时，和 owned-new 的 human 记录同批写入 cwd 与根的 sha256、requestId（seat）或 null（派活台）。按契约冻结流程更新了金标准；`agent-request` 的字段没动，旧 journal 照样能重放。
- 会话页写「工作目录 <路径>（在你放行的项目根里）」。
- r4 §10.8 双写者告警：两个会话放在同一个根里可以同时改文件，没有告警。
- 计划第 2 节原写「真实 profile 下允许用户在设置里登记的项目根」：这次是启动参数，没有设置页；改根要重启 orchestrad。
- `orchestra.cmd` 没有参数说明，没改；`docs/quickstart.md` 留给另一个 agent 补。

**seat 会话按来源不可信启动（r4 §8.5，2026-11-03，提交 "orchestra app: seat sessions start untrusted"）**：
- 依据：r4 §8.5「来源追踪」写，一个回合的来源链里有 `external` 或 `unbound` 发送者就是 tainted，条件里没有 cwd；同节「未绑定的发送者标为 unbound」写，装进非自有 harness 的 opt-in shim 以 unbound 身份发送，seat 正是装进 DSH 的 opt-in bundle。tainted 回合期间：Claude 乐章 `canUseTool` 一律询问；Codex 用 untrusted 审批策略。所以 seat 派出的会话不论在项目根还是自建工作目录里都按 tainted 启动（原先只覆盖「项目根里的 Claude」）。派活台由人直接开的会话不变。
- 和 r4 字面的差别：r4 写 Codex「在 `turn/start` 时」用 untrusted。这里在 `thread/start` 时请求，并校验应答回显；`turn/start` 不带 `approvalPolicy`（codex 0.165.0 生成的 schema 里，`turn/start` 的这个字段只在给出时覆盖「本回合及之后」），线程保持 untrusted。实测那一回合的命令确实每条都先问。
- 代码：`src/server/owned-handlers.ts`（`tainted = asked !== null`，日志 `owned-started` 总带 `tainted`）；`src/owned/codex-owned.ts` 把 `tainted` 传下去；`src/owned/codex-session.ts` `codexApprovalPolicy`：tainted 请求 `untrusted`，否则 `on-request`，应答回显不一致就以 policy-mismatch 结束（沿用原来的校验；项目根只收 `readOnly` 沙箱的规则照旧叠加）。Claude 侧沿用 e850a20 的 host tainted。
- schema（`codex app-server generate-json-schema`，codex-cli 0.165.0，本地生成）：`AskForApproval` = `"untrusted" | "on-request" | "never"` 或 `{granular:{…}}`；`thread/start` 的应答必有 `approvalPolicy`。
- 探针实测（2026-11-03，本机，一次，直连 codex.exe app-server，私有 CODEX_HOME 在会话临时目录，经 magpie；不经 orchestrad）：`thread/start {approvalPolicy:'untrusted'}` 回显 `"untrusted"`，沙箱请求 `read-only` 或 `workspace-write` 都回 `readOnly`；提示让它读 `notes.txt`、列目录、写 `out.txt`，`Get-Content`、`Get-ChildItem -Force`、`Set-Content` 三条命令都先发了审批请求（3/3），没有没问就跑的。对照：`on-request` + `read-only` 同样提示，三条也都先问（一次）。
- 卡片文案（`shared/strings.js`、`ui/owned.js`）：seat→Codex 项目根卡片把「读那里的文件会不会先问你，未知」改成实测口径（untrusted 启动、一次实测里 Get-Content 读、列目录、写都先问、别的读法没测）；自建工作目录的 seat 卡片多一句「按来源不可信处理」（Codex / Claude 各一句）；派活台的 Codex 项目根说明按 on-request 那次对照实测改。
- 实验室 seat 冒烟（`seat-smoke.ts complete`，测试 profile orchestrad + 隔离 `DSH_HOME` 的 DSH headless，一次）：卡片 codex、`runIn` 为空（`no-roots`，自建工作目录），派出 200；请求 dispatched → running → done；会话 starting → running → idle；审批卡 1 张（command / shell，脚本代人允许）；对话流里 ran-unasked 0 条；`hello.txt` 内容 hi；日志 `owned-started` 带 `tainted: true`，没有 policy-mismatch；结束后 orchestrad stdin-eof 退出码 0，令牌文件已删，残留 0。冒烟前后 `~/.dsh` 快照对 `dsh-before.csv` 0 差异。
- 没做、未验证的：seat→Claude（项目根或自建目录）这次没有 live 跑，只有单元测试；seat→Codex 在项目根里没有 live 跑；其他读法（`rg`、`type`、`cmd /c` 等）会不会先问未测，实测都只一次；会话页和契约里没有「这个会话按不可信处理」的字段，只有请求卡片写了；真实 profile 未验证（代-2）。

**复核后改（2026-11-03，提交 "orchestra app: review fixes for untrusted policy, project-root Claude, daemon-kill"）**：
- r4 §8.5 对 tainted 回合还有一半没落实：「审批卡片顶部显示来源链、tainted 回合用红条，shell、网络访问、cwd 之外的写入都要键入确认」。原来 tainted 会话的审批卡和普通会话一样，高风险卡按 r4 §10.9 可以只「按住」放行，比 r4 §8.5 要求的「必须键入」弱，上一段「没做」里也没写这一条。现在：`src/owned/approvals.ts` 的 `ApprovalView` 加 `tainted`（Codex、Claude 两家会话按自己的 `tainted` 填），`GET /api/owned` 每张审批卡带 `tainted`，`shared/owned-contract.js` 校验它（必填布尔）；页面（`ui/owned.js` `allowHow`、`ui/app.js` `allow`）上 tainted 会话的高风险卡去掉「按住」，按钮写「输入确认词允许」，点一下弹出输入框，只认键入的「放行」，按住不放行（`allow` 本身也拒掉 tainted 高风险卡的按住和单击）；卡头第一项写「来源不可信：DSH 会话发来的请求」，卡左边是红条（新颜色变量 `--taint`，没借用表示出错的朱红 `--err`，「一色一义」测试照旧过），备注写明「卡上只写得出『来自 DSH 会话』，更长的来源链没有」。低风险卡（普通写文件、cwd 内的读）照旧单击。
  - 仍没做：r4 §8.5 说的完整来源链（exchangeId → 发送者 → 发送者自己的污染源）卡上没有，只有「来自 DSH 会话」；请求方 id 也没有写到审批卡上（请求卡上有）。服务器不区分「按住」和「键入」（原来的高风险卡也一样），「必须键入」只在页面这一半；同一用户的脚本绕过页面直接 POST allow 仍能放行（D8 的配对、解锁、操控令牌照旧挡）。会话页没有「按不可信处理」的字段。tainted 会话的卡在真实页面上没有 live 看过（seat 冒烟这次没重跑），只有单元测试：审批带 `tainted`（`test/owned/seat-untrusted.test.ts`）、按钮和卡片描述（`test/ui/owned-app.test.ts`）；页面上「按住不放行」只有读代码（`holdBtn` 只认 `data-high="1"`，tainted 高风险卡是 `"2"`），没有页面级测试。
- 文案的「实测」写清条件（T1）：三条卡片文案原来写「实测」，但实测是探针在 Orchestra 外直接起的 app-server（私有 CODEX_HOME，不经 orchestrad），和产品走的路径不同。改成：派活台 `new.cwdRootCodex` 写「在 Orchestra 外直接起同版本 app-server 实测一次（on-request，请求的是只读沙箱）……Orchestra 请求的是 workspace-write 沙箱（再要回显只读），这个组合在 Orchestra 里没测」；seat 项目根卡 `req.cwdRoot` 写「在 Orchestra 外……实测一次（untrusted，沙箱回的是只读）……经 Orchestra 在项目根里也没测」；seat 自建目录卡 `req.untrustedCodex` 另写「这里沙箱回 workspace-write 也照样启动，那种情况没测」。没有把自建目录的 tainted 会话也改成只收 readOnly（产品行为不变，只改文案）。
- 交接文件的 Unverified 第 37、41 行和 Next 第 4、5 条按 d212b86、18d5a03 改写，保留仍没验证的部分。

**seat 经 orchestrad live 跑项目根和 Claude（2026-11-03，本机，e9dac45 上，测试 profile，每种一次）**：实验室 `seat-smoke.ts` 新加三种模式，每种单独起一次测试 profile orchestrad（`--owned --agent-port`，root-* 另加 `--project-root <测试目录>\proj`）和隔离 `DSH_HOME` 的 DSH headless，脚本充当配对页上的测试操作者（派出、允许都经页面的 HTTP 接口，D8：派出、批准、刹车只由人在配对页上做；这里是测试操作者代人点）。root-codex、root-claude：`proj` 里放 `notes.txt`（一个固定词），DSH 从 `proj` 起，任务要子代理读 `notes.txt`、把词写进 `hello.txt`，分别经 `subagent_codex_governed`、`subagent_claude_governed`；work-claude：同原来的 complete（写 `hello.txt` 内容 hi），经 `subagent_claude_governed`，会话在自建工作目录。结果：
- 三种都是：卡片派出 200；请求 dispatched → running → done；会话 starting → running → idle；日志 `owned-started` 带 `tainted: true`，没有 policy-mismatch；审批卡全部 `tainted: true`；对话流 ran-unasked 0 条（只有 Codex 会话会发这个标记，Claude 两种模式的 0 不算证据；复核者改看对话流计数，Claude 问过的次数等于跑过的次数，2=2、1=1）；DSH 退出码 0；结束后 orchestrad stdin-eof 退出码 0，令牌文件已删，残留 0。
- root-codex：卡片 `runIn` 是项目根，会话 `cwd.kind` 是 `project-root`；审批卡 2 张，都是 command / shell、高风险，一张读 `notes.txt`（读也先问了，untrusted 下的预期），一张写 `hello.txt`；`hello.txt` 在项目根里、内容对，自建目录和 DSH 目录里没有。
- root-claude：卡片 `runIn` 是项目根，会话 `cwd.kind` 是 `project-root`；审批卡 2 张：读 `notes.txt` 一张（tool / other，不是高风险，r4 §8.5 tainted 会话 cwd 内的读也问，卡是普通风险），写 `hello.txt` 一张（file-change / write，不是高风险）；`hello.txt` 在项目根里、内容对。
- work-claude：卡片 `runIn` 为空（`no-roots`），会话 `cwd.kind` 是 `work`；审批卡 1 张（file-change / write）；`hello.txt` 在会话自建目录里、内容 hi。
- 冒烟前后 `~/.dsh` 快照对 `dsh-before.csv` 0 行差异。这一轮没有发现产品 bug，没改代码。
- 仍未验证：每种只跑一次；高风险卡「只认键入」是页面那一半，这次脚本直接 POST allow，没走页面；seat 项目根卡片文案 `req.cwdRoot` 还写着「经 Orchestra 在项目根里也没测」，现在有了上面这一次（读用的是哪条命令脚本没记，只记了卡片提到 `notes.txt`），文案没改；真实 profile 未验证（代-2：真实 profile 只由用户在可见控制台里启动）。

**审批卡和等你栏写出来源链（r4 §8.5，2026-11-03，提交 "orchestra app: approval cards show the source chain"）**：
- 依据：r4 §8.5「来源追踪」写「任何由 agent 消息触发的回合，审批卡片顶部都显示触发它的来源链」，来源链记在 `provenance` 里，形状是「exchangeId → 发送者 → 发送者自己的污染源」。原来卡头只写「来源不可信：DSH 会话发来的请求」，备注写「更长的来源链没有」。
- 数据：`src/owned/approvals.ts` 新类型 `ApprovalOrigin` = `{kind:'agent-request', requestId, requester, label}`，`ApprovalView.origin` 是它或 `null`。`requester` 是请求自报的 DSH 会话 id 原样（不核实，没报就是 `null`），`label` 是请求卡上显示的标签（已遮密钥、写出不可见字符，超长以 … 结尾）或 `null`。`src/server/owned-handlers.ts` 派出时用认领到的请求造 origin，经 `codex-owned.ts` / `claude-owned.ts` 传进会话（`codex-session.ts` / `claude-session.ts`），会话每次 `approvals.add` 带上；`GET /api/owned` 每张审批卡带 `origin`。只用于显示：摘要 digest 仍只算 approvalId、kind、title、preview，allow / deny / 超时拒绝都不看它；origin 不进 journal（`agent-request` 记录照旧只存请求方 id 的摘要）。
- 契约（`shared/owned-contract.js`）：`origin` 必填，`null` 或对象；`kind` 只有 `agent-request`；`requestId` 用 `REQUEST_ID_RE`；`requester` 为 `null` 或匹配新的 `REQUESTER_SESSION_RE`（和 `src/route/requests.ts` 的 `REQUESTER_ID_RE` 同一条：字母数字开头，只含字母数字和 `_.:-`，最多 128 字符）；`label` 为 `null` 或按显示文本查（最多 120 字节，不许控制字符和双向控制字符），另外不许换行；带 origin 的卡必须 `tainted: true`。
- 页面（`ui/owned.js` `originLine`，`describeCard` 卡头第一项、`pinExtra` 等你栏提示，都是 textContent）：「来源不可信：DSH 会话 <id>（自称，未核实）→ 请求「<标签>」→ 这个会话」。没报 id 写「DSH 会话 未知（请求没报自己的 id）」（T1）；没有标签写「请求 <requestId>（没写标签）」。卡片上 id 和标签写全；等你栏各截到 16 个字符，截断处用 …，末尾加「（太长，截断处标了 …，全文在卡片上）」。万一有控制字符或双向控制字符漏过契约，页面写成 `\u{..}`，不按原样画。没有 origin 的 tainted 卡（旧列表）照旧只写「来源不可信：DSH 会话发来的请求」；普通会话的卡不出现来源链。备注改成「来源链只写到发请求的 DSH 会话，它自己读过什么、话从哪来，Orchestra 不知道」。红条 CSS 补了换行：卡头 kind 段和 tainted 等你栏提示可以折行。
- 和 r4 字面的差别：r4 的链有三段。这里第一段是 requestId（请求在 Orchestra 里的编号，相当于 exchangeId），第二段的发送者是请求方自报的 id，没核实；第三段（发送者自己的污染源）Orchestra 拿不到，卡上写「不知道」，没有编造。来源链挂在会话上，不是逐回合：seat 会话之后由你在会话页发的回合，卡上仍写这条请求的来源链（整个会话照旧按 tainted 处理）。
- 测试：新增 `test/owned/approval-origin.test.ts`（视图带 origin 并冻结、digest 和 allow / deny 不变；CodexOwned 经会话到 `GET /api/owned` 带 origin 且过契约，普通会话为 null；ClaudeOwned 经假 SDK 的宿主同样带到卡上；契约拒非 tainted、错 kind、错 requestId、带空格或 `-` 开头或超长的 id、label 里的控制字符和双向控制字符、换行、超长，缺键；卡片和等你栏文本、null 写未知、截断标注、控制字符写出）；`test/server/agent-requests-http.test.ts` 的派出用例改为期望 origin。全量 1534 通过、0 失败。分别去掉 `describeCard` 的 originLine、handler 传 origin、Claude 会话传 origin 那一处，各有测试失败（2 条、1 条、1 条），恢复后通过。没动 journal 和 contract-freeze 的金标准（这两处都没变）。
- live（本机，测试 profile，各一次）：`scripts/live-smoke.ts --harness codex`（脚本新增报告项 `approvalOrigins`）：审批 2 张 command / shell 都允许，`approvalOrigins` 为 `{null: 2}`，文件内容对，残留 0，测试目录已删。实验室 `seat-smoke.ts complete`（先删 `%TEMP%\orchestra-test-seat`）：派出 200，请求 dispatched → running → done，审批 1 张（command / shell，tainted），它的 origin：kind `agent-request`、requestId 等于请求卡的、requester 和请求卡的 `dsh:<id>` 一致（非 null）、label「hello file」等于请求卡的；orchestrad stdin-eof 退出码 0，令牌文件已删，残留 0；跑完删了测试目录，除用户自己的 7470 orchestrad 外没有 orchestrad、codex、dsh 进程。
- 仍没做、未验证：卡片和等你栏的来源链没在真实页面上看过（只有描述符的单元测试和 DOM 测试里现成的等你栏插槽测试），长链在窄屏上的折行没看；requester 为 null 的路径只有单元测试（seat 每次都报了 id）；seat→Claude 的来源链没有 live 跑；真实 profile 未验证（代-2）。
- 复核修正（2026-11-03，提交 "orchestra app: source chain review fixes"）：
  - 标签是对方写的：链改成「请求「<标签>」（标签是对方写的，未核实）→ 这个会话」；标签里的 「」『』→ 写成 `\u{..}`，带 」→ 的标签拼不出第二条链（新测试数了：一对「」、两个 →）。
  - 上面「不许控制字符和双向控制字符」原先不全：LRM、RLM、ALM（U+200E、U+200F、U+061C）和别的格式字符（Unicode Cf）没拦，「只许一行」没查 U+2028、U+2029。现在契约对 origin 的 label 拒所有 Cf 和这两个分隔符；页面对来源链里所有 Cc、Cf、Zl、Zp 都写成 `\u{..}`。服务端 escapeInvisible 本来就先写出这些字符，这是第二道。契约的全局 CONTROLS 没扩，别的字段照旧。
  - 等你栏按用户看到的字符（Intl.Segmenter 字形）截断，不会把字母和它的组合附加符号、国旗拆开；没有 Intl.Segmenter 时退回按码点。
  - 备注按有没有 origin 选：有 origin 写「来源链只写到发请求的 DSH 会话……」；没有 origin 的 tainted 卡写「这张卡没带来源链……」（新键 appr.taintedNoteBare / appr.taintedHighBare）。
  - 生产端：Approvals.add 有 origin 就算 tainted；startCodexSession / startClaudeSession 有 origin 而没说 tainted 时也按 tainted 起（Codex 用 untrusted 策略）。不再靠出口契约兜底把整份 GET /api/owned 变成 500。

### 5. 界面：塔表
- 首页 `/`：顶栏（计数即筛选、刹车）、「等你」钉栏（按剩余时间）、跨项目树表（你 → agent → subagent，同一行格式，缩进表层级，子树小框 `子·错·等`）、右栏详情、底部「发给 → X」输入框和停止键。
- agent 页 `/agent/<id>`：左这一枝、中对话、右选中的 subagent。
- 「关于数据」页：诚实声明、未测规则、源健康。
- 配色「航图」：一色一义（黄=等你，朱=出错，青=在跑），亮暗两套；系统黑体 + 等宽数字；行高 30px（手机 44px）。
- 375px 可用：钉栏 + 树，点行进全屏节点页。
- 右栏「最近事件：读取失败：network」（2026-11-03，用户第一次用真实 profile 时看到，节点是一个 33 天前的 Codex 分身）：
  - 文案来源：`ui/api.js` 的 `read()` 把 fetch 抛出的一切都记成 `network`，包括页面 4 s 期限到了（`AbortSignal.timeout` 抛的 TimeoutError）；`ui/view.js` 原样拼进「读取失败：{code}」。服务端 `/api/peek/session` 出错是 4xx/5xx，不会变成 network。
  - 找到的耗时：`readSession`（`src/sources/peek.ts`）对文件里每一条记录都脱敏，最后只留 200 条。合成的 Codex 分身 rollout（解码 15.8 MB、7647 行，测试目录）一次读 1068 ms，其中脱敏约 1000 ms；14 MB / 约 2800 行的合成文件 637 ms。这段是同步的，读的时候 orchestrad 别的请求都在排队。本机真实 `~/.codex` 下 263 个 rollout（全是 .zst）：大于 32 MB 4 个、4–32 MB 14 个、1–4 MB 31 个；按压缩后大小排前 25 个里，在 16 MB 解码上限内、会被整个读的有 10 个，解码后 8.3–16.4 MB、689–8786 行（只统计了大小和行数，没读内容；其余 15 个超限，只读开头一行）。
  - 改了：只给最后 200 条脱敏（同一合成文件 1068 ms → 70 ms）；`read()` 分开 `timeout`（「Orchestra 后台 4 秒内没有回复」）和 `network`（「连不上 Orchestra 后台（连接被拒绝或中断）」），`not-found` 也写成话；超时或连不上的事件读取自动再读（以前要等塔表 rev 变了才再读）。
  - 复核后改了（2026-11-03）：原先的「2 s 后再读一次」与代码不符——计时从发请求算，超时 4 s 才回，回来时已超过 2 s，于是立刻重发，而且只要还超时就一直重发。现在从失败的回复到达时计时，2 s、4 s、8 s 后各再读一次，共 3 次；之后不再定时重读，只在塔表 rev 变了时再读，提示也改成「已连续 n 次没读到，不再定时重读，塔表有更新时再读」。每次读取带序号，晚到的旧回复丢弃，同一会话同一时间只有一个读取在外。
  - 未知：合成数据最慢 1.07 s，没有复现出超过 4 s；用户那次具体是超时还是连接断了、卡在哪个文件或和哪个请求排队，未知（没有请求真实 orchestrad，也没读真实会话内容）。真实 profile 下再看到时，新文案会说是哪一种。

### 6. 装进 DSH（后做）
独立只读 DSH 插件：左栏图标 + 主区只读塔表，数据经插件宿主用只读 token 取；所有人类动作深链回 orchestrad。

## 阶段

1. 观察：Codex 来源、DSH 计数修复、TowerSnapshot 契约、`/api/tower`。
2. 塔表 UI（只读）替换首页和 `/stage`。
3. 合并 0.2；Codex 自有会话（app-server）+ 审批队列 + POST 端点；agent 页对话、审批、停止。
4. Claude 自有会话（0.2 host）接上同一套。
5. 路由派活台（规则 + magpie 模型 + Route to? 卡）。
6. 端到端：真实数据 + magpie 实跑一遍；交接。
7. DSH 只读插件（有余力再做）。

## 新首页：第三轮方案 22「左 worker，右 team」（2026-11-04）

用户选定第三轮方案 22，做成应用真实的首页。`/` 现在是新页面（`ui/home.html`），旧的塔留在 `/tower`，新页面右上角有一个「旧页面」链接。两个地址走同样的配对和 CSP 检查，未配对时都是配对表单。

**做了什么**

- 左半边：worker 列表，Orchestra 自有会话在前，只读会话折叠成一组并写总数；行的第二行写在做什么或等谁；头像是名字首字色块带角标。选中自有 worker 显示 `/api/owned/:id/feed` 的真实对话和输入框；只读会话只有事件和「打开完整记录」，没有批准、发消息、中断。
- 右半边：当前 worker 的 subagent 用折叠卡（`ui/fold.js`，从 `round2/foldcard.js` 和 `kit.css` 移植；CSP 不许 `innerHTML` 和 style 属性，所以改成描述符，分段条是每个成员一格）。默认折叠，运行中不自动展开。点开是成员列表和状态、耗时、型号。卡按 agentType 分：一个类型一张，成员派的 subagent 算进同一张。
- 等你和出错：输入框上方两个胶囊，数字直接取展开后的列表长度（T3，计数等于它链接的列表长度）。
- 没有总台、没有 team、没有 bot 能派活，三处都写清楚，没有假开关。派活台、解锁、批准、停止、结束、刹车全走现有路由。键盘 `n` 开派活台。
- `ui/drive.js`：把 `ui/app.js` 里解锁、批准、派活、发消息、停止这些动作原样抽出来，两个页面共用一份。这样新页面放宽不了按住、键入确认的规则（D8：批准、拒绝、拍板、刹车只有人在配对页上能做，超时即拒；r4 §8.5：受污染会话的高风险只能键入）。

**残余**

1. ~~线没有画。~~ 2026-11-04 已接上，见下一节「派发和拉线」。
2. ~~折叠卡按 agentType 分，不是真实的一次派发。~~ 同上：自有 Codex 会话现在一次派发一张卡。只读会话的数据里没有派发批次，还是按 agentType 分。
3. ~~Claude 自有会话的 subagent 还没接进塔，右半边写了「这里空着，不等于它没派」。~~ 2026-11-05 已接上，见「子代理（Claude，2026-11-05 接上）」一节。
4. 派发的五件事（派给谁、做什么、为什么、要交回什么、现在怎样）没有做：真实数据里写不全。
5. 「关于数据」只在旧页面有；新页面的上限提示指向那里。`/session` 页的返回链接文字还写「回到塔」，实际回 `/`。
6. 新页面用合成数据和页面真实 CSP 在浏览器里看过（1024 宽无横向滚动，浅深色）；没有在测试 profile 的 orchestrad 上走过一遍真实配对、解锁和批准，这几步只有假 DOM 测试和 HTTP 测试。屏幕阅读器没测过。

## 派发和拉线（2026-11-04）

方案 22 的核心是「派发时从对话那一行拉线到右半边，折叠卡长在线的末端」。上一节留下的两件事接上了：Codex 的派发进对话流，折叠卡按真实的一次派发分。

**做了什么**

- **派发事件**（`src/owned/codex-session.ts`）：根线程派出一个子代理，写一条对话流事件，`kind` 是 `note`，`state` 是 `dispatch`，`text` 是名字，`ref` 是成员节点 id（哈希，和塔节点一样，契约写死了 `n:` 加 20 位十六进制，线程 id 上不了页面），`batch` 是批次号。v2 模型来自 `subAgentActivity` 的 `started`，v1 模型来自写了线程 id 的 `spawnAgent`。`item/started` 和 `item/completed` 只算一次。v1 派出时名字未知，`text` 是 null，`thread/read` 拿到名字后再写一条带名字的，同一个 `ref`，第一条留在原处。页面按 `ref` 并到第一条的那一行上，所以一直开着的页面和之后才打开的页面，行的位置和顺序都一样。子代理说的话照旧不进对话流。
- **批次怎么判定**：协议里没有「这几个是一次决定」的字段，所以只看根线程自己的事件。同一个回合（item 的 `turnId` 相同），而且两次派出之间根线程没有开始别的 item（`reasoning`、消息、`wait`、命令都算），就是同一批。子线程的状态事件不算。item 没写 `turnId` 的自成一批，也不让后面的并进来。分不开的情况：模型一次回复里并排调两次，和一次回复调一次、中间什么 item 都没有的连续两步，看起来一样，都算一批。子代理自己再派的（嵌套，没实测）、没人宣告过的线程，不写派发行，批次是 null。
- **塔节点和契约**：节点多 `batch`，只有自有 subagent 能有（`shared/tower-contract.js`）。对话流多 `batch`，有值当且仅当是 dispatch 事件（`shared/owned-contract.js`）。注册表落盘，老文件的成员没有这个键，读成 null，不会让整条记录失效。金样本每个节点加了 `"batch": null`。
- **首页**：一批一张卡，按派出顺序排，和对话里的行同序，所以线不交叉。标题是第一个成员的名字加「等 N 个」，第二行类型 subagent，数量和耗时是这批的。没有批次的成员（只读会话全是）维持按 agentType 分，右半边写着这份快照没带哪句话派的谁，不拉线；自有会话里没有行的卡写明原因（对话流里没有那一行，或者还没解锁读不到）。
- **派发行**：一批一行，是个按钮，字和卡一样，所以写的数量就是它打开的列表长度（T3：计数等于它链接的列表长度）。点了展开右边的卡，卡不在视野里时右半边滚到它，这是唯一会动右半边的情况，而且只发生在点击时。卡不在这份快照里时按钮不可点，悬停写原因。旧页面 `/tower` 上是一行普通文字。
- **线**（`ui/wings.js` `describeWires`，`ui/home.js` `paintWires`）：`<svg id="wires">` 钉在视口上，不接鼠标。几何写在 `d`、`cx`、`cy` 属性里，走 `ui/dom.js` 的白名单和模板，没有 `innerHTML` 也没有 style 属性。平时淡；新派发时亮 2.2 秒并从行画到卡，卡随后从线的末端长出来；悬停或键盘焦点在行或卡上、卡展开时亮。行或卡任何一端滚出视野，这条线就收起。滚动、窗口变化、两个列表尺寸变化都重算，另外每秒的渲染也算一次。减少动效时没有画线和长出来，只变颜色。动效不拿焦点，不滚对话。第一次看一个 worker 不算新派发，回到它时才补放一次，和卡的规则一样。窄屏（899 像素以下，单列）不画线，点行仍然展开卡。
- **停止管根线程的长命令**：`turn/interrupt` 之后先读一次 `thread/backgroundTerminals/list`，再发 `clean`，2 秒后再读 `list`。清之前读这一次，是为了把早先回合留下的后台进程也算进来，不然它被清掉了对话流一个字没有。条数按 id 算（看到开着的命令加列表的 `itemId`，同一条只算一次），再按几次也不涨。对话流先写「已发出，还没确认」，再写「N 条命令停下了」或「N 条命令没确认停下」，`stoppable` 留着可以再按。没确认的命令后来自己回来了，就从没确认的数里减掉，减到 0 时停止键收起，对话流写「N 条命令已经结束」。没看到开着的命令、列表也是空的或没回答时什么都不写。回合结束时还开着的命令算「还在外面」：`stoppable` 亮着，下次停止算它，「问过」的记录留到它回来，所以迟到的结果不会误报没来问就跑，也不怕中间隔了一个正常结束的回合；真没来问就跑的照样写。停止碰到的命令回来是 `failed` 时写成「被停止了」，退出码原样带着。卡片还开着的命令没跑过，不算在内。根线程的打断语义没变：审批先拒、排队消息撤回、会话停在 idle，下一条消息开新回合。
- `scripts/live-smoke.ts`：`--subagent` 加判定，每个成员有一条派发行、`ref` 是节点 id、批次和节点一致、最后有名字；`--pair` 让模型一次派两个，报告批次数；新增 `--root-stop`。

**实测**（codex-cli 0.165.0，测试 profile，走 magpie，退出码都是 0，收尾后 Job 里什么也不剩）

| 跑法 | `codex/gpt-6.1-sol`（v2） | `zcode/GLM-5.3`（v1） |
|---|---|---|
| `--subagent` | 派发行 1 条，节点批次一致，有名字，在跑 → 已回报，16.1 s | 派发行 1 条，节点批次一致，名字来自 `thread/read`，在跑 → 已回报，17.8 s |
| `--subagent --pair`（一次派两个） | 2 条派发行，1 批 | 2 条派发行，1 批 |
| `--root-stop` | 274 ms 后 ping 和外层 shell 按 pid 加创建时间查不到，Job 里只剩常驻进程；`commands-stopped=1`，命令结果 `stopped`，没有 `ran-unasked`，会话 idle，下一条消息有回复 | 同左，269 ms |
| `--subagent-stop`（回归） | 两轮都过，261 ms | 两轮都过，271 ms（上面残余里「v1 的停止没跑过」这条现在跑过了） |

复核修过停止的条数之后（清之前先读 `list`，条数按 id 算）重跑了 `--root-stop` 两个模型和 v1 的 `--subagent`，退出码都是 0，`commands-stopped=1`，没有多算。`list` 的 `itemId` 和命令的 item id 是不是同一个，没有单独看过：这次只知道根线程的这一个场景没有算成 2。

页面用合成数据、页面真实 CSP 和接口的假回答在内置浏览器里看过：线从行端到卡边，8 批时不交叉，新派发动画跑了，点行展开，右半边滚动后滚出去的线收起，375 宽无线无横向滚动，控制台没有 CSP 报错。

**残余**

1. **批次是推断**：见上面判定一节。模型逐步派、中间没有任何 item 时会并成一批。
2. **派发行会丢**：对话流上限 500 条或 256 KiB，页面只显示最近 200 条，orchestrad 重启后对话流也没了。这时卡还按批次分，但没有行也没有线，右半边写明。
3. **v1 的名字**：`thread/read` 没回答时那一行一直写「名字未知」。
4. **根线程命令**：`item` 已结束但进程还留在后台的，分两种情况。回合进行中按停止：`list` 报出来就算进条数，`clean` 清掉，对话流写。根线程 idle：看不到，`stoppable` 是 false，按停止什么都不发，清不到，要刹车。`item` 还开着就过了回合结束的，`stoppable` 亮着，按停止只发 `clean` 和 `list`。这种情况（根线程的命令活过正常结束的回合）没实测过；回合失败时命令若不再回来，停止键会亮到按一次为止，按了写「停下了」，那条命令可能早就没了。命令自己用 `Start-Process` 放出去的进程，`clean` 管不管得到没测过，那种要刹车。
5. **嵌套子代理**：没有派发行，没有批次，落到「没有批次」那张卡里。没实测过。
6. **页面预算**：首页自有文件的上限从 72 KiB 放到 80 KiB，首页加载总量从 240 KiB 放到 248 KiB，动画关键帧白名单加了 `stroke-dashoffset`（线画出来只能靠它）。
7. 没有在测试 profile 的 orchestrad 上用浏览器走过真实配对后的拉线；页面只用合成数据看过，真实事件走的是 `GET /api/owned/:id/feed` 和 `GET /api/tower` 的冒烟判定。屏幕阅读器没测过。
