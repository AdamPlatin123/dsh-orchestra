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
- 建议只是「Route to?」卡片：人点「派出」才起会话；从不自动派（r4 Route to?：拿不准时出卡请你选，绝不默认派活）。每次派活写一条 RouteDecision（候选、理由、模式=manual）：带建议派出的记候选和人选了哪个；没要建议、建议过期或改过句子再派出的，也记一条（没有候选，router 记 not-asked），对应 r4 §9.5「M1 起每次派活都记一条 mode=manual 的 RouteDecision」。
- 路由模型拿不到时退回纯规则，卡片照出。

### 4. 审批（D8）
- 一个队列，超时 30 分钟即拒；批准只收配对页面的 POST（cookie + 操控令牌 + Origin）。
- 小审批栏可直接「允许」：参数完整可见才给；shell、网络、cwd 外写入要按住，或点一下后输入确认词「放行」（r4 §10.9 的「键入确认」，给读屏浏览模式和手机用）；列表变化 750 ms 内无效；绑定参数摘要；不批量。通知和 DSH 镜像不放「允许」。
- 受保护路径直接拒，不弹卡（2026-11-02 阶段 2 复核后改）：审批里出现的文件路径、写入根目录、命令 cwd，先按工作目录解析成绝对路径，再按最近的已存在上级做 realpath（会跟随目录联接），用 spawn 闸同一张 cwd 拒绝表判断（数据目录、各 harness 根、~/.claude、~/.dsh、AppData、仓库……）。命中就自动回 decline，feed 记 auto-denied / protected。只在工作目录外、没命中拒绝表的，仍是高风险卡片要按住或键入。

### 分歧和残余风险（2026-11-02 阶段 2 复核后记）
- **0.2 设计第 134 行 vs 本计划 §4（旧版）**：0.2 设计要求受保护路径直接拒；本计划旧版只写「要按住」，代码曾按较松的一边做。现已改成直接拒，以 0.2 设计为准。
- **0.2 设计第 528 行「真实 profile 下 owned-disabled」**：被本计划 §2（真实 profile 用 `ORCHESTRA_HOME\work\<会话>`）取代。现在两种 profile 下都是「带 --owned 启动并找到 codex.exe 才开」。若要恢复 0.2 的限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')，由用户定。
- **进程树的 Job 回收（D4，2026-11-02 接上；原为残余风险）**：D4 要求每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起。现在的做法：
  - procguard 进了产品代码：`native/procguard/ProcGuard.cs`（从 S4 spike 精简而来，只留一次性 run-in-job 和常驻的 job-info、kill-job、alive）。源码的 sha256 钉在 `src/os/procguard-pins.ts`（`scripts/pin-procguard.ts` 生成）；对不上就不编译。编译只用系统自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，经 spawn 闸的 csc 规则和它固定的参数。产物放 `ORCHESTRA_HOME\runtime\procguard\<源码 sha256>\procguard.exe`（数据目录里，不进仓库）。旧 csc 没有 /deterministic，所以产物没法钉在仓库里。第 4 阶段复核后改：**每次带 --owned 启动都重新编译**（S4 实测 1–2 秒），上次留下的 exe 不用；产物的 sha256 只放在这次运行的内存里，不再写旁边的 `procguard.exe.sha256`（它和 exe 在同一目录，能换 exe 的人就能一起换它，等于自己给自己作证；以前的版本只能发现「只换了 exe」）。旧版留下的 `.sha256` 启动时删掉。每次经闸启动 procguard.exe 之前仍按内存里的 sha256 比对，对不上算被改过（procguard-tampered），这次启动被拒。旧 exe 换不掉（还有旧 procguard 在跑）时 procguard 算没开，写明原因。
  - 自有会话的子进程改经 procguard 启动：spawn 闸新规则 procguard-codex、procguard-claude（测试用 procguard-codex-fake），argv 固定为 `run-in-job --name <Job 名> --env-allowlist <文件> -- <内层规则的 exe 和 argv>`。内层的 exe、argv、cwd、环境都按原来的 codex-app-server、claude-host 规则判。procguard 先以挂起状态建子进程，放进 Job 后再恢复；Job 设 KILL_ON_JOB_CLOSE，不设 BREAKAWAY_OK；子进程只继承三个 std 句柄（HANDLE_LIST）；环境从零建，只按名单从 procguard 自己的环境里复制（名单 = 闸给内层规则的变量名 + libuv 自动补的 LIBUV_ADDED_ENV），所以子进程看到的环境和原来一样，文件里只有变量名、没有值。同名 Job 已存在就拒绝，不会加入别人的 Job；Job 的 DACL 只允许按名字打开来查询和结束。
  - 已覆盖：自己结束、orchestrad 停机、出错、子进程自己退出，四种结束都先走原来的停止顺序；包装进程一退出，Job 的最后一个句柄就关了，Job 里剩下的进程（codex 跑的命令、host 下的 claude.exe、Start-Process 起的进程）全部结束。子进程关闭后，常驻 procguard 再按名字查一次这个 Job，feed 记 tree-ended / tree-stopped / tree-left，查不到结果记 tree-unsure（未知）；每次查的结果也写进日志（owned-tree）。orchestrad 停机时（第 4 阶段复核后改）：先等所有经 procguard 起的子进程关闭、等它们关闭时发出的核对回来（最多 5 s，超时记 owned-trees-unsettled），再关常驻 procguard 的 stdin；常驻的读到 EOF 后先把已收到的命令答完（最多 15 s）再退出。停机时的核对结果只在日志里：feed 只在内存里，进程一退就没了。以前的版本在核对发出前就关了常驻的，核对实际做不成（记 tree-unsure，也没人看得到）。实测见本节末「第 3 阶段复核后补记」后面的「procguard 实测」。
  - 刹车：`POST /api/owned/:id/brake`（人手动作，和其他自有会话动作一样要解锁、操控令牌、actionId 去重），常驻 procguard 立即结束整个 Job，拒掉这个会话所有待审批，会话以 braked 结束。塔表那一行只写「你踩了刹车，Orchestra 结束了它 Job 里的进程（是否全停见对话记录）」，停没停由 feed 的 tree-* 记录和刹车回复说（第 4 阶段复核后改：以前塔表固定写「整棵进程树已停」，刹车回 left>0 或未知时也这么写，违反 T1）。会话已在结束中、子进程还没关时也能刹车（第 4 阶段复核后补：Claude 的停止顺序最长 5 s，以前这段时间刹车键消失）：剩下的停止步骤取消，结束原因保持原样，feed 记 braked。页面停止键第三档，和「结束会话」一样要在 3 秒内点两次。kill-job 先读一次计数就立即 TerminateJobObject，列成员放在最后、尽力而为（以前先逐个列成员再结束，Job 里超过 1024 个进程时列成员失败，结束根本没执行）。
  - procguard 编不出来、源码对不上钉子、常驻的起不来或准备失败时（第 4 阶段复核后改）：**自有会话整个关闭**，两家的 why 都记 procguard 的原因，控制台和页面写明。以前是「自有会话照旧、不经 Job、没有刹车」，和 r4 D4「每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起」冲突（D4 没有降级的口子），而且只有一行提示。现在没有显式的降级开关；若要「没有 Job 也照开」，需要用户拍板加一个开关（例如 `--owned-without-jobs`），并在 r4 里给 D4 开口子。进程内测试（不带 procguard 参数）仍是不经 Job 的旧路，只用于测试。
  - 常驻 procguard 中途退出时（第 4 阶段复核后补）：日志记 procguard-resident-gone、控制台写一行；GET /api/owned 的 brakeWhy 变成 procguard-resident-gone，页面在刹车键旁写「刹车说不出结果：…」。这时刹车仍会结束包装进程、让 Job 关闭，但回复的 killed/left 是未知。没有自动重启它。
  - 仍未覆盖（残余）：① 同一用户的进程可以从包装进程里复制出 Job 的完整句柄，改掉它的限制，Job 挡不住同用户的恶意进程，只防正常的进程树泄漏。② orchestrad 被强杀时，按 S4 用例 a 的机制，包装进程在 orchestrad 的 libuv Job 里，会跟着死，它的 Job 也跟着关；但这次没有在会话还在跑时强杀 orchestrad 来实测产品代码（live-smoke 杀 orchestrad 时会话已结束），未知。③ Job 里如果有进程是用别的用户令牌启动的（例如 DSH 沙箱），打开和核对创建时间可能失败；这次只测了 codex、Claude host、cmd、ping。④ env-allowlist 文件被改只会少给变量，不会多给（procguard 只能复制它自己有的），但改了不会被发现。⑤ node.exe 本身仍只查存在、不是链接，没有哈希。⑥（第 4 阶段复核后补）Job 只管直接派生的子孙进程：agent 的命令经任务计划（schtasks）、WMI 的 Win32_Process.Create、COM 进程外服务器，或交给已经在运行的程序（资源管理器、浏览器）去打开的东西，是 Job 外的进程起的，刹车和结束都管不到，是否还在未知；页面上凡是说「Job 里的进程都停了」的地方都带这句。⑦（第 4 阶段复核后补）spawn 闸先按路径读 procguard.exe 算哈希，再按路径启动它，中间换文件看不出来（检查和使用不在同一时刻）；联调脚本自己的 procguard 也一样（先比对 orchestrad 日志里记的 sha256 再启动）。⑧ 包装进程建子进程改用 PROC_THREAD_ATTRIBUTE_JOB_LIST，子进程一创建就在 Job 里，再用 IsProcessInJob 核对一次才恢复运行（第 4 阶段复核后改：以前先建、再放进 Job，包装进程恰好死在两步之间时，挂起的子进程会留在 Job 外）；Windows 10 以前的系统不支持这个属性，没测。
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
- **seat 第 1 步：agent 侧请求口和请求卡（orchestrad 侧，2026-11-02）**。依据是本轮 seat 方案 final.md §5.1（seat 是一个 DSH bundle，把 Orchestra 注册成 DSH 的「受治理 Codex / Claude 子代理后端」；第 1 步只做 orchestrad 这一侧，DSH 那一侧的 bundle 是第 2 步，还没写）。r4 A17（agent 只能请求新建乐手，只生成一条由你批准的条目）和 D8（只有一个审批队列，超时即拒；派出、批准、刹车只能由人在配对页面上做，agent 侧物理上没有这些路由）是这一步的边界。做法和与 final.md 不同的地方：
  - **开关**：新加 `--agent-port`，只能和 `--owned` 一起用（单独给就拒绝启动，`agent-port-without-owned`）。另外还要 `--peek-port`（配对页面在，人才能派出或拒绝）和至少一家自有会话开着；缺哪个就不开，控制台、日志和启动结果里写原因（`no-page` / `owned-off`），不会悄悄开一个没人能批的请求口。final.md 只说「接进组合根」，没说要不要单独开关；选了显式开关，因为它是一个新的进程间入口。
  - **pipe 名**：真实 profile 是 `\\.\pipe\orchestra-agent-real`；测试 profile 是 `\\.\pipe\orchestra-agent-test-<测试目录名去掉 orchestra-test- 的部分>`（不合 `[a-z0-9._-]` 或超过 64 字符时用它 sha256 的前 16 位）。final.md 写的是 `orchestra-agent-<profile>`，测试 profile 加了后缀，因为测试会多个并行跑，同名 pipe 第二个会 EADDRINUSE。DSH 一侧的 `cordis.patch.yml` 里 `pipe` 要按这个名字写。pipe 被占时请求口不开（`pipe-busy`），orchestrad 照常工作。
  - **令牌文件**：`ORCHESTRA_HOME\agent-port.token`，内容是 32 字节随机数的 base64url 加换行，经写围栏写入，关闭时经写围栏删除；每次启动都换。令牌不进日志、不上控制台、不进任何回复（控制台只印 pipe 名和文件路径）。
  - **cwd**：DSH 请求里的 cwd 先过 spawn 闸同一张 cwd 拒绝表（数据目录、各 harness 根、`~/.ssh`、AppData、仓库……），命中就 422 `cwd-forbidden`。过了也只在卡片上显示「它想在 X 干活」；派出后会话仍在 `ORCHESTRA_HOME\work\<ownedId>` 里跑，和自己派的会话一样。final.md 没写要不要在请求的 cwd 里跑；在 agent 指定的目录里跑需要先有「登记项目根」（本计划 §2 留到以后），所以这一步选更保守的一边。
  - **RouteDecision 记来源**：`route` 记录的结构没动（records.ts 规定每个字段都必填，旧 journal 要能重放，加字段会让旧行失败）。改成在同一批里多写一条新 kind `agent-request`：`{requestId, actionId, verdict: dispatched|rejected, harness, requesterKind: dsh, requesterDigest, ownedId, decisionId}`，派出时 `decisionId` 指向那条 `route` 的 decisionId，表示这次派活的来源是 agent 请求。拒绝时同样写一条（ownedId、decisionId 为 null）。请求方的 DSH 会话 id 不进 journal，只存 sha256（journal 不收来源自由文本）；卡片和日志里写原文。到期和撤回不是人的决定，不写 journal，只进日志。
  - **新的人手动作**：`POST /api/agent-requests/:id/reject`（人类动词 `request-reject`，要解锁和操控令牌，actionId 去重，和别的自有会话动作同一条检查链）；派出就是 `POST /api/owned/new` 带 `requestId`，文字和 harness 必须和卡片上的完全一样，否则 409 `request-mismatch`；请求已经不在等（派过、拒过、到期、撤回、重启丢了）是 409 `request-gone`。卡片上的模型建议来自同一个派活台：先规则、再问路由模型，但只在请求点名的 harness 里选（`desk.suggest(text, harness)`）。派出键和审批的允许键一样，「等你」栏变化后 750 ms 内无效（r4 §10.9）。
  - **请求状态**：`pending → dispatched → running → done`，或 `rejected / expired / withdrawn / failed`。内存里最多 16 条（满了先挤掉已结束的，全在等就 429 `full`），每分钟最多 6 条新请求（429 `rate`）。默认 10 分钟没人处理就 `expired`（D8 的「超时即拒」），组合根常量 `AGENT_REQUEST_TTL_MS` 可改。`done` 的意思是「派出的会话第一回合结束了（feed 里 turn-ended），最后一条 agent 消息已交回请求方」，不是对工作的判定：会话不会因此被结束，页面也从不写「完成」（T2、D19）。交回的内容按 A16（薄完成：只回状态、有界摘要和引用，截断要标明）：最后一条 agent 消息（feed 里已脱敏的文字），最多 8 KiB，被截、会话自己已截（final-cut）或 feed 丢过早期事件时 `truncated: true`。回合被中断、出错或会话先结束，记 `failed` 并写原因（`turn-interrupted`、`session-braked` 等）。orchestrad 每秒看一次在跑请求的 feed。
  - **请求文字先脱敏**：请求一到就过自有会话同一个脱敏器，并把不可见字符写成 `\uXXXX`；卡片显示的、问路由模型的、派出时作为会话第一条消息发出的，都是这一份。
  - **撤回 = owned-end 的正常停止顺序**（final.md §6.3 A 的建议，本轮已定）：pending 的直接变 `withdrawn`；dispatched / running 的会话走 `session.end()`，和你按「结束会话」是同一条停止顺序，不走刹车，请求库根本没拿到刹车。已结束的请求再撤回是空操作（DSH 在正常结束后也会调 dispose，seat 第 0 步核对过）。**和 final.md「不改 src/owned/*」不同**：给 `codex-session.ts`、`claude-session.ts` 的 `end()` 加了一个结束原因 `requester-withdrew`（停止顺序完全不变，只是标签），owned-contract 和页面文字同步加上。不加的话塔表和会话页会写「你结束的」，和实际不符。
  - **页面**：「等你」栏最上面是 DSH 请求卡（先到期的在前）：「DSH 请求派 Codex：<标签或第一行>」、剩余时间、全文、请求方 `dsh:<会话 id>`、想在哪干活、派出会用的模型和来源，按钮「拒绝」「派出」；没解锁时只有「先解锁」。栏头的件数包含请求卡（T3：计数等于列表长度）。顶栏的「等你」计数来自塔表快照，**不含**请求卡（残余，见下）。会话页的状态行写「这个会话由 DSH 请求派出：dsh:… · 请求现在…」。
  - **builtin 表**：`src/server/agent-port.ts` 只能用 `node:net` 和 `node:http` 的 `createServer`；静态扫描规则 `net:agent-port-pipe-only` 钉住：pipe 前缀只声明一次、`pipeOptions` 拒绝别的路径、整个模块只有一处 `listen(pipeOptions(...))`。node:http 只解析，从不自己监听，所以这一行不是 TCP 监听，也不是客户端。
  - **残余和没做的**：① 没有 pipe-client-pid 校验（final.md §6.3 B，本轮已定第一刀接受）：同一用户的任何进程读到令牌文件就能提请求，但只能提请求，每条都要你点。② pipe 抢注：别的进程若在 orchestrad 之前建了同名 pipe，orchestrad 报 `pipe-busy` 不开；但 DSH 一侧会把令牌发给那个进程（它因此也只能提请求）。pipe 的 DACL 用的是 Node 默认值，没有收紧。③ 顶栏「等你」计数和页面标题不含请求卡。④ 请求只在内存里，orchestrad 重启后全部丢失，DSH 再查会得到 404 `request-unknown`。⑤ 没有和真 DSH、真 Codex 联调过（seat 第 2 步的 bundle 还没写）；`live-smoke` / `live-route` 也没为请求口加模式。⑥ 页面只有假 DOM 测试，没在真实浏览器里点过。

### 5. 界面：塔表
- 首页 `/`：顶栏（计数即筛选、刹车）、「等你」钉栏（按剩余时间）、跨项目树表（你 → agent → subagent，同一行格式，缩进表层级，子树小框 `子·错·等`）、右栏详情、底部「发给 → X」输入框和停止键。
- agent 页 `/agent/<id>`：左这一枝、中对话、右选中的 subagent。
- 「关于数据」页：诚实声明、未测规则、源健康。
- 配色「航图」：一色一义（黄=等你，朱=出错，青=在跑），亮暗两套；系统黑体 + 等宽数字；行高 30px（手机 44px）。
- 375px 可用：钉栏 + 树，点行进全屏节点页。

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
